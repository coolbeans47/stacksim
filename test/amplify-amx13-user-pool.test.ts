import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient, CreateUserPoolClientCommand, CreateUserPoolCommand,
  GetUserCommand, InitiateAuthCommand, UpdateUserAttributesCommand, VerifyUserAttributeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createCognitoCloudFormationProviders } from "../src/cloudformation/providers/cognito.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function context(logicalId: string): ProviderContext {
  return { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/amx13/direct`,
    logicalId, operationId: "amx13", resourceOperationId: `amx13-${logicalId}`, idempotencyKey: `amx13-${logicalId}`,
    deadlineAt: Date.now() + 120_000, principal: { identity: { ...credentials, principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId } } };
}
test("AMX-13A unchanged generated User Pool/client properties create, update, recover, restart and delete directly", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx13-providers-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, region, dataDir: root, authMode: "off" });
  try {
    await simulator.start();
    const frozen = JSON.parse(await readFile(resolve("test/fixtures/amplify-gen2-auth-email/evidence/templates/auth.json"), "utf8"));
    const resources = Object.values(frozen.Resources) as any[];
    const poolProperties = resources.find(item => item.Type === "AWS::Cognito::UserPool").Properties;
    const clientProperties = resources.find(item => item.Type === "AWS::Cognito::UserPoolClient").Properties;
    let providers = createCognitoCloudFormationProviders(simulator.cognito);
    let pool = providers.find(provider => provider.typeName === "AWS::Cognito::UserPool")!;
    let client = providers.find(provider => provider.typeName === "AWS::Cognito::UserPoolClient")!;
    const desired = pool.canonicalize(poolProperties, context("Pool"));
    const created = await pool.create(desired, context("Pool"));
    assert.equal(created.status, "SUCCESS", JSON.stringify(created));
    if (created.status !== "SUCCESS") return;
    const poolId = String(pool.ref(created.model));
    const readCreated = await pool.read(poolId, context("Pool"));
    if (readCreated.status === "SUCCESS") assert.deepEqual(readCreated.model.properties, desired);
    assert.equal((await pool.create(desired, context("Pool"))).status, "SUCCESS", "lost-response create converges");
    const wantedClient = client.canonicalize({ ...clientProperties, UserPoolId: poolId }, context("Client"));
    const clientCreated = await client.create(wantedClient, context("Client"));
    assert.equal(clientCreated.status, "SUCCESS", JSON.stringify(clientCreated));
    if (clientCreated.status !== "SUCCESS") return;
    const clientId = String(client.ref(clientCreated.model));
    assert.equal((await simulator.cognito.executeCloudFormationControl("DescribeUserPoolClient", { UserPoolId: poolId, ClientId: clientId }) as any).UserPoolClient.ExplicitAuthFlows.includes("ALLOW_CUSTOM_AUTH"), true);
    const sdk = new CognitoIdentityProviderClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await assert.rejects(sdk.send(new InitiateAuthCommand({ ClientId: clientId, AuthFlow: "CUSTOM_AUTH", AuthParameters: { USERNAME: "nobody" } })), /USER_PASSWORD_AUTH is required/);
    sdk.destroy();
    const changed = pool.canonicalize({ ...poolProperties, UserPoolName: "amx13-updated" }, context("Pool"));
    assert.equal((await pool.update(poolId, { ...desired, Schema: poolProperties.Schema }, changed, context("Pool"))).status, "SUCCESS", "previous provider models with omitted schema defaults remain updateable");
    assert.equal((await pool.update(poolId, changed, desired, context("Pool"))).status, "SUCCESS", "rollback restores the generated configuration");
    const bad = { ...poolProperties, UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ["phone_number"] } };
    assert.throws(() => pool.canonicalize(bad, context("BadPool")), /Only the email/);
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, region, dataDir: root, authMode: "off" });
    await simulator.start();
    providers = createCognitoCloudFormationProviders(simulator.cognito);
    pool = providers.find(provider => provider.typeName === "AWS::Cognito::UserPool")!;
    client = providers.find(provider => provider.typeName === "AWS::Cognito::UserPoolClient")!;
    const afterRestart = await pool.read(poolId, context("Pool"));
    assert.equal(afterRestart.status, "SUCCESS");
    if (afterRestart.status === "SUCCESS") assert.deepEqual(afterRestart.model.properties.UserAttributeUpdateSettings, { AttributesRequireVerificationBeforeUpdate: ["email"] });
    assert.equal((await client.read(clientCreated.physicalId, context("Client"))).status, "SUCCESS");
    assert.equal((await client.delete(clientCreated.physicalId, wantedClient, context("Client"))).status, "SUCCESS");
    assert.equal((await pool.delete(poolId, desired, context("Pool"))).status, "SUCCESS");
    assert.equal((await pool.read(poolId, context("Pool"))).status, "NOT_FOUND");
  } finally { await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});

test("AMX-13A email changes retain the verified value until the exact delivered update is verified, including restart/admin override", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx13-email-update-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, region, dataDir: root, authMode: "off" });
  let sdk: CognitoIdentityProviderClient | undefined;
  const connect = () => new CognitoIdentityProviderClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
  const codeFor = async (email: string) => {
    const origin = `http://127.0.0.1:${simulator.port}/_stacksim/api/ses/inbox`;
    const list = await fetch(`${origin}?recipient=${encodeURIComponent(email)}&status=all&pageSize=100`).then(response => response.json()) as any;
    const message = await fetch(`${origin}/${encodeURIComponent(list.messages.at(-1).messageId)}`).then(response => response.json()) as any;
    return /\b(\d{6})\b/.exec(message.message.textBody)![1];
  };
  try {
    await simulator.start(); sdk = connect();
    const poolId = (await sdk.send(new CreateUserPoolCommand({ PoolName: "amx13-verified-updates", AutoVerifiedAttributes: ["email"], Schema: [{ Name: "email", Required: true, Mutable: true }], UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ["email"] } }))).UserPool!.Id!;
    const clientId = (await sdk.send(new CreateUserPoolClientCommand({ UserPoolId: poolId, ClientName: "email-updates", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"], ReadAttributes: ["email"], WriteAttributes: ["email"] }))).UserPoolClient!.ClientId!;
    await sdk.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: "alice", MessageAction: "SUPPRESS", TemporaryPassword: "Temp-password-123!", UserAttributes: [{ Name: "email", Value: "alice@example.test" }, { Name: "email_verified", Value: "true" }] }));
    await sdk.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: "alice", Password: "Alice-password-123!", Permanent: true }));
    const accessToken = (await sdk.send(new InitiateAuthCommand({ ClientId: clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "alice", PASSWORD: "Alice-password-123!" } }))).AuthenticationResult!.AccessToken!;
    await sdk.send(new UpdateUserAttributesCommand({ AccessToken: accessToken, UserAttributes: [{ Name: "email", Value: "first@example.test" }] }));
    const firstCode = await codeFor("first@example.test");
    let attributes = (await sdk.send(new GetUserCommand({ AccessToken: accessToken }))).UserAttributes!;
    assert.equal(attributes.find(attribute => attribute.Name === "email")?.Value, "alice@example.test");
    assert.equal(attributes.find(attribute => attribute.Name === "email_verified")?.Value, "true");
    await sdk.send(new UpdateUserAttributesCommand({ AccessToken: accessToken, UserAttributes: [{ Name: "email", Value: "second@example.test" }] }));
    const secondCode = await codeFor("second@example.test");
    await assert.rejects(sdk.send(new VerifyUserAttributeCommand({ AccessToken: accessToken, AttributeName: "email", Code: firstCode })), /Invalid verification code/);
    sdk.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, region, dataDir: root, authMode: "off" });
    await simulator.start(); sdk = connect();
    await sdk.send(new VerifyUserAttributeCommand({ AccessToken: accessToken, AttributeName: "email", Code: secondCode }));
    attributes = (await sdk.send(new GetUserCommand({ AccessToken: accessToken }))).UserAttributes!;
    assert.equal(attributes.find(attribute => attribute.Name === "email")?.Value, "second@example.test");
    await sdk.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId, Username: "alice", UserAttributes: [{ Name: "email", Value: "admin-pending@example.test" }] }));
    const adminCode = await codeFor("admin-pending@example.test");
    assert.equal((await sdk.send(new GetUserCommand({ AccessToken: accessToken }))).UserAttributes!.find(attribute => attribute.Name === "email")?.Value, "second@example.test");
    await sdk.send(new VerifyUserAttributeCommand({ AccessToken: accessToken, AttributeName: "email", Code: adminCode }));
    await sdk.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId, Username: "alice", UserAttributes: [{ Name: "email", Value: "admin-verified@example.test" }, { Name: "email_verified", Value: "true" }] }));
    assert.equal((await sdk.send(new GetUserCommand({ AccessToken: accessToken }))).UserAttributes!.find(attribute => attribute.Name === "email")?.Value, "admin-verified@example.test");
  } finally { sdk?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});

test("AMX-13A a negative clone of the complete frozen Auth graph rejects a late child property before any Auth mutation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx13-atomic-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, region, dataDir: root, authMode: "off", cdkBootstrap: true });
  let cloudformation: CloudFormationClient | undefined; let s3: S3Client | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options); s3 = new S3Client({ ...options, forcePathStyle: true });
    const evidence = resolve("test/fixtures/amplify-gen2-auth-email/evidence");
    const rootBody = await readFile(join(evidence, "templates", "root.json"), "utf8");
    const child = JSON.parse(await readFile(join(evidence, "templates", "auth.json"), "utf8"));
    const assetManifest = JSON.parse(await readFile(join(evidence, "asset-manifest.json"), "utf8"));
    const asset = (Object.values(assetManifest.files) as any[]).find(item => item.displayName === "auth Nested Stack Template");
    const destination = Object.values(asset.destinations)[0] as any;
    // Only this explicit negative clone changes generated properties. The frozen
    // source, CLI deployment fixtures and evidence remain byte-for-byte intact.
    (Object.values(child.Resources) as any[]).find(item => item.Type === "AWS::Cognito::IdentityPoolRoleAttachment").Properties.UnsupportedAuthProperty = true;
    await s3.send(new PutObjectCommand({ Bucket: `cdk-hnb659fds-assets-${accountId}-${region}`, Key: destination.objectKey, Body: JSON.stringify(child) }));
    const rolesBefore = Object.keys(simulator.store.ensureAccount().iam.roles).sort();
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "amx13-negative-complete-auth", TemplateBody: rootBody, Capabilities: ["CAPABILITY_NAMED_IAM"] }));
    let stack;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
      if (stack?.StackStatus === "ROLLBACK_COMPLETE") break;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    assert.equal(stack?.StackStatus, "ROLLBACK_COMPLETE");
    assert.match(stack?.StackStatusReason ?? "", /UnsupportedAuthProperty/);
    const state = simulator.store.regionState(region);
    assert.deepEqual(state.cognito.pools, {});
    assert.deepEqual(state.cognitoIdentity.pools, {});
    assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.roles).sort(), rolesBefore);
    assert.deepEqual(state.cloudformation.stacks[created.StackId!].resources, {});
    assert.equal(Object.keys(state.cloudformation.stacks).length, 1, "recursive admission created no child catalog");
  } finally { cloudformation?.destroy(); s3?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});
