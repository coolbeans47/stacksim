import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import {
  COGNITO_CLOUDFORMATION_RESOURCE_TYPES,
  createCognitoCloudFormationProviders,
} from "../src/cloudformation/providers/cognito.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cognito-provider-test/stack-id`,
    logicalId,
    operationId: `operation-${logicalId}`,
    resourceOperationId: `resource-${logicalId}`,
    idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

test("COG-06 providers register the exact user-pool set and share authoritative Cognito state", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-cognito-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: join(root, "data"),
    region,
    accountId,
    authMode: "off",
    cognitoPublicUrl: "http://127.0.0.1:4566",
  });
  let oidcServer: Server | undefined;
  try {
    await simulator.start();
    let oidcIssuer = "";
    oidcServer = createServer((request, response) => {
      if (request.url !== "/.well-known/openid-configuration") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        issuer: oidcIssuer,
        authorization_endpoint: `${oidcIssuer}/authorize`,
        token_endpoint: `${oidcIssuer}/token`,
        jwks_uri: `${oidcIssuer}/jwks`,
        userinfo_endpoint: `${oidcIssuer}/userinfo`,
      }));
    });
    await new Promise<void>(resolve => oidcServer!.listen(0, "127.0.0.1", resolve));
    const oidcAddress = oidcServer.address();
    assert(oidcAddress && typeof oidcAddress === "object");
    oidcIssuer = `http://127.0.0.1:${oidcAddress.port}`;

    const providers = createCognitoCloudFormationProviders(simulator.cognito);
    assert.deepEqual(providers.map(provider => provider.typeName).sort(), COGNITO_CLOUDFORMATION_RESOURCE_TYPES);
    const byType = new Map(providers.map(provider => [provider.typeName, provider]));

    const poolProvider = byType.get("AWS::Cognito::UserPool")!;
    assert.throws(() => poolProvider.canonicalize({
      SmsVerificationMessage: "Legacy code {####}",
      VerificationMessageTemplate: { SmsMessage: "Different code {####}" },
    }, context("ConflictingSmsPool")), /must match/);
    const poolDesired = poolProvider.canonicalize({
      UserPoolName: "cfn-cognito-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      UsernameConfiguration: { CaseSensitive: false },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      UserPoolTags: { application: "provider-test" },
    }, context("Pool"));
    const poolCreated = await poolProvider.create(poolDesired, context("Pool"));
    assert.equal(poolCreated.status, "SUCCESS", JSON.stringify(poolCreated));
    if (poolCreated.status !== "SUCCESS") return;
    const poolId = String(poolProvider.ref(poolCreated.model));
    assert.match(poolId, /^eu-west-1_[A-Za-z0-9]{9}$/);
    assert.equal(poolProvider.getAtt(poolCreated.model, "Arn"), `arn:aws:cognito-idp:${region}:${accountId}:userpool/${poolId}`);
    assert.equal((await simulator.cognito.executeCloudFormationControl("DescribeUserPool", { UserPoolId: poolId }) as any).UserPool.Name, "cfn-cognito-pool");

    const clientProvider = byType.get("AWS::Cognito::UserPoolClient")!;
    const clientDesired = clientProvider.canonicalize({
      UserPoolId: poolId,
      ClientName: "browser",
      GenerateSecret: false,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
    }, context("Client"));
    const clientCreated = await clientProvider.create(clientDesired, context("Client"));
    assert.equal(clientCreated.status, "SUCCESS", JSON.stringify(clientCreated));
    if (clientCreated.status !== "SUCCESS") return;
    const clientId = String(clientProvider.ref(clientCreated.model));
    assert.match(clientId, /^[a-z0-9]{26}$/);

    const groupProvider = byType.get("AWS::Cognito::UserPoolGroup")!;
    const groupDesired = groupProvider.canonicalize({ UserPoolId: poolId, GroupName: "developers", Description: "Developers" }, context("Group"));
    const groupCreated = await groupProvider.create(groupDesired, context("Group"));
    assert.equal(groupCreated.status, "SUCCESS", JSON.stringify(groupCreated));

    const userProvider = byType.get("AWS::Cognito::UserPoolUser")!;
    const userDesired = userProvider.canonicalize({
      UserPoolId: poolId,
      Username: "developer@example.test",
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: "developer@example.test" }],
    }, context("User"));
    const userCreated = await userProvider.create(userDesired, context("User"));
    assert.equal(userCreated.status, "SUCCESS", JSON.stringify(userCreated));

    const membershipProvider = byType.get("AWS::Cognito::UserPoolUserToGroupAttachment")!;
    const membershipDesired = membershipProvider.canonicalize({
      UserPoolId: poolId,
      Username: "developer@example.test",
      GroupName: "developers",
    }, context("Membership"));
    const membershipCreated = await membershipProvider.create(membershipDesired, context("Membership"));
    assert.equal(membershipCreated.status, "SUCCESS", JSON.stringify(membershipCreated));
    if (membershipCreated.status === "SUCCESS") assert.equal((await membershipProvider.read(membershipCreated.physicalId, context("Membership"))).status, "SUCCESS");

    const resourceProvider = byType.get("AWS::Cognito::UserPoolResourceServer")!;
    const resourceDesired = resourceProvider.canonicalize({
      UserPoolId: poolId,
      Identifier: "sprint-planner",
      Name: "Sprint Planner",
      Scopes: [{ ScopeName: "board.read", ScopeDescription: "Read the board" }],
    }, context("ResourceServer"));
    const resourceCreated = await resourceProvider.create(resourceDesired, context("ResourceServer"));
    assert.equal(resourceCreated.status, "SUCCESS", JSON.stringify(resourceCreated));

    const domainProvider = byType.get("AWS::Cognito::UserPoolDomain")!;
    const domainDesired = domainProvider.canonicalize({ UserPoolId: poolId, Domain: "cfn-cognito-provider", ManagedLoginVersion: 2 }, context("Domain"));
    const domainCreated = await domainProvider.create(domainDesired, context("Domain"));
    assert.equal(domainCreated.status, "SUCCESS", JSON.stringify(domainCreated));
    if (domainCreated.status === "SUCCESS") assert.equal((await domainProvider.read(domainCreated.physicalId, context("Domain"))).status, "SUCCESS");

    const identityProvider = byType.get("AWS::Cognito::UserPoolIdentityProvider")!;
    const identityDesired = identityProvider.canonicalize({
      UserPoolId: poolId,
      ProviderName: "DeveloperOIDC",
      ProviderType: "OIDC",
      ProviderDetails: {
        oidc_issuer: oidcIssuer,
        client_id: "developer-client",
        client_secret: "local-provider-secret",
        authorize_scopes: "openid email",
      },
      AttributeMapping: { email: "email" },
      IdpIdentifiers: ["developer"],
    }, context("IdentityProvider"));
    const identityCreated = await identityProvider.create(identityDesired, context("IdentityProvider"));
    assert.equal(identityCreated.status, "SUCCESS", JSON.stringify(identityCreated));
    if (identityCreated.status === "SUCCESS") assert.equal((await identityProvider.read(identityCreated.physicalId, context("IdentityProvider"))).status, "SUCCESS");

    if (identityCreated.status === "SUCCESS") assert.equal((await identityProvider.delete(identityCreated.physicalId, identityDesired, context("IdentityProvider"))).status, "SUCCESS");
    if (domainCreated.status === "SUCCESS") assert.equal((await domainProvider.delete(domainCreated.physicalId, domainDesired, context("Domain"))).status, "SUCCESS");
    if (resourceCreated.status === "SUCCESS") assert.equal((await resourceProvider.delete(resourceCreated.physicalId, resourceDesired, context("ResourceServer"))).status, "SUCCESS");
    if (membershipCreated.status === "SUCCESS") assert.equal((await membershipProvider.delete(membershipCreated.physicalId, membershipDesired, context("Membership"))).status, "SUCCESS");
    if (userCreated.status === "SUCCESS") assert.equal((await userProvider.delete(userCreated.physicalId, userDesired, context("User"))).status, "SUCCESS");
    if (groupCreated.status === "SUCCESS") assert.equal((await groupProvider.delete(groupCreated.physicalId, groupDesired, context("Group"))).status, "SUCCESS");
    assert.equal((await clientProvider.delete(clientCreated.physicalId, clientDesired, context("Client"))).status, "SUCCESS");
    assert.equal((await poolProvider.delete(poolId, poolDesired, context("Pool"))).status, "SUCCESS");
    assert.equal((await poolProvider.read(poolId, context("Pool"))).status, "NOT_FOUND");
  } finally {
    await new Promise<void>(resolve => oidcServer?.close(() => resolve()) ?? resolve());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-24 updates pool names and append-only schema without replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-cognito-gap24-"));
  let simulator: StackSim | undefined;
  try {
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: join(root, "data"),
      region,
      accountId,
      authMode: "off",
    });
    await simulator.start();
    let poolProvider = createCognitoCloudFormationProviders(simulator.cognito)
      .find(provider => provider.typeName === "AWS::Cognito::UserPool")!;
    assert.equal(poolProvider.schema.properties.UserPoolName.updateBehavior, "MUTABLE");
    assert.equal(poolProvider.schema.properties.Schema.updateBehavior, "MUTABLE");
    const initial = poolProvider.canonicalize({
      UserPoolName: "gap24-before",
      Schema: [{
        Name: "tenant",
        AttributeDataType: "String",
        DeveloperOnlyAttribute: false,
        Mutable: true,
        Required: false,
      }],
    }, context("Gap24Pool"));
    const created = await poolProvider.create(initial, context("Gap24Pool"));
    assert.equal(created.status, "SUCCESS", JSON.stringify(created));
    if (created.status !== "SUCCESS") return;
    const poolId = created.physicalId;
    await simulator.cognito.executeCloudFormationControl("CreateUserPoolClient", {
      UserPoolId: poolId,
      ClientName: "preserved-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    });
    const desired = poolProvider.canonicalize({
      UserPoolName: "gap24-after",
      Schema: [
        {
          Name: "tenant",
          AttributeDataType: "String",
          DeveloperOnlyAttribute: false,
          Mutable: true,
          Required: false,
        },
        {
          Name: "department",
          AttributeDataType: "String",
          DeveloperOnlyAttribute: false,
          Mutable: true,
          Required: false,
        },
      ],
    }, context("Gap24Pool"));
    const updated = await poolProvider.update(poolId, initial, desired, context("Gap24Pool"));
    assert.equal(updated.status, "SUCCESS", JSON.stringify(updated));
    assert.equal(updated.physicalId, poolId);
    const described = await simulator.cognito.executeCloudFormationControl("DescribeUserPool", { UserPoolId: poolId }) as any;
    assert.equal(described.UserPool.Name, "gap24-after");
    assert(described.UserPool.SchemaAttributes.some((attribute: any) => attribute.Name === "department"));
    assert.equal((await simulator.cognito.executeCloudFormationControl("ListUserPoolClients", {
      UserPoolId: poolId,
      MaxResults: 10,
    }) as any).UserPoolClients.length, 1);

    const removal = poolProvider.canonicalize({
      UserPoolName: "gap24-after",
      Schema: [{
        Name: "department",
        AttributeDataType: "String",
        DeveloperOnlyAttribute: false,
        Mutable: true,
        Required: false,
      }],
    }, context("Gap24Pool"));
    const rejected = await poolProvider.update(poolId, desired, removal, context("Gap24Pool"));
    assert.equal(rejected.status, "FAILED");
    assert.equal((await simulator.cognito.executeCloudFormationControl("DescribeUserPool", {
      UserPoolId: poolId,
    }) as any).UserPool.Name, "gap24-after");

    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: join(root, "data"),
      region,
      accountId,
      authMode: "off",
    });
    await simulator.start();
    poolProvider = createCognitoCloudFormationProviders(simulator.cognito)
      .find(provider => provider.typeName === "AWS::Cognito::UserPool")!;
    const restarted = await poolProvider.read(poolId, context("Gap24Pool"));
    assert.equal(restarted.status, "SUCCESS");
    if (restarted.status === "SUCCESS") {
      assert.equal(restarted.model.properties.UserPoolName, "gap24-after");
      assert(restarted.model.properties.Schema.some((attribute: any) => attribute.Name === "department"));
    }
  } finally {
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-25 reads confidential clients as GenerateSecret true without modeling the secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-cognito-gap25-"));
  let simulator: StackSim | undefined;
  try {
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: join(root, "data"),
      region,
      accountId,
      authMode: "off",
    });
    await simulator.start();
    let providers = createCognitoCloudFormationProviders(simulator.cognito);
    const poolProvider = providers.find(provider => provider.typeName === "AWS::Cognito::UserPool")!;
    let clientProvider = providers.find(provider => provider.typeName === "AWS::Cognito::UserPoolClient")!;
    const poolDesired = poolProvider.canonicalize({ UserPoolName: "gap25-pool" }, context("Gap25Pool"));
    const poolCreated = await poolProvider.create(poolDesired, context("Gap25Pool"));
    assert.equal(poolCreated.status, "SUCCESS", JSON.stringify(poolCreated));
    if (poolCreated.status !== "SUCCESS") return;
    const desired = clientProvider.canonicalize({
      UserPoolId: poolCreated.physicalId,
      ClientName: "confidential-client",
      GenerateSecret: true,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    }, context("Gap25Client"));
    const created = await clientProvider.create(desired, context("Gap25Client"));
    assert.equal(created.status, "SUCCESS", JSON.stringify(created));
    if (created.status !== "SUCCESS") return;
    const firstRead = await clientProvider.read(created.physicalId, context("Gap25Client"));
    assert.equal(firstRead.status, "SUCCESS");
    if (firstRead.status === "SUCCESS") {
      assert.equal(firstRead.model.properties.GenerateSecret, true);
      assert.equal("ClientSecret" in firstRead.model.properties, false);
    }
    const noOp = await clientProvider.update(created.physicalId, desired, desired, context("Gap25Client"));
    assert.equal(noOp.status, "SUCCESS", JSON.stringify(noOp));

    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: join(root, "data"),
      region,
      accountId,
      authMode: "off",
    });
    await simulator.start();
    providers = createCognitoCloudFormationProviders(simulator.cognito);
    clientProvider = providers.find(provider => provider.typeName === "AWS::Cognito::UserPoolClient")!;
    const restarted = await clientProvider.read(created.physicalId, context("Gap25Client"));
    assert.equal(restarted.status, "SUCCESS");
    if (restarted.status === "SUCCESS") {
      assert.equal(restarted.model.properties.GenerateSecret, true);
      assert.equal("ClientSecret" in restarted.model.properties, false);
    }
  } finally {
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
