import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateSecretCommand, DescribeSecretCommand, GetResourcePolicyCommand, GetSecretValueCommand, SecretsManagerClient, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssmCdk from "aws-cdk-lib/aws-ssm";
import { TestClock } from "../src/core/clock.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { SSM_PARAMETER_SCHEMA } from "../src/cloudformation/providers/ssm-parameter.js";
import { SECRETS_MANAGER_SECRET_SCHEMA } from "../src/cloudformation/providers/secrets-manager-secret.js";
import { SECRETS_MANAGER_RESOURCE_POLICY_SCHEMA } from "../src/cloudformation/providers/secrets-manager-resource-policy.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string, terminal: string): Promise<any> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    clock.advance(1_000);
    await new Promise(resolve => setTimeout(resolve, 20));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      if (stack?.StackStatus === terminal) return stack;
      if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus?.includes("ROLLBACK_COMPLETE")) assert.fail(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
    } catch (error: any) {
      if (terminal === "DELETE_COMPLETE" && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  assert.fail(`stack ${name} did not reach ${terminal}`);
}

function template(description: string): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Parameters: { SourceName: { Type: "AWS::SSM::Parameter::Value<String>", Default: "/pss04/source/plain" } },
    Resources: {
      TypedParameter: {
        Type: "AWS::SSM::Parameter",
        Properties: { Name: "/pss04/typed", Type: "String", Value: { Ref: "SourceName" }, Description: description, Tags: { phase: "PSS-04" } },
      },
      DynamicParameter: {
        Type: "AWS::SSM::Parameter",
        Properties: { Name: "/pss04/dynamic", Type: "StringList", Value: "{{resolve:ssm:/pss04/source/list:1}}" },
      },
      GeneratedSecret: {
        Type: "AWS::SecretsManager::Secret",
        Properties: {
          Name: "pss04/generated",
          Description: description,
          GenerateSecretString: { SecretStringTemplate: "{\"username\":\"local\"}", GenerateStringKey: "password", PasswordLength: 24, ExcludePunctuation: true },
          Tags: [{ Key: "phase", Value: "PSS-04" }],
        },
      },
      CopiedSecret: {
        Type: "AWS::SecretsManager::Secret",
        Properties: { Name: "pss04/copied", SecretString: "{{resolve:ssm-secure:/pss04/source/secure:1}}" },
      },
      JsonCopiedSecret: {
        Type: "AWS::SecretsManager::Secret",
        Properties: { Name: "pss04/copied-json", SecretString: "{{resolve:secretsmanager:pss04/source-json:SecretString:password}}" },
      },
      SecretPolicy: {
        Type: "AWS::SecretsManager::ResourcePolicy",
        Properties: {
          SecretId: { Ref: "GeneratedSecret" },
          BlockPublicPolicy: true,
          ResourcePolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "secretsmanager:GetSecretValue", Resource: "*" }] },
        },
      },
    },
    Outputs: {
      ParameterName: { Value: { Ref: "TypedParameter" } },
      ParameterArn: { Value: { "Fn::GetAtt": ["TypedParameter", "Arn"] } },
      ParameterType: { Value: { "Fn::GetAtt": ["TypedParameter", "Type"] } },
      ParameterValue: { Value: { "Fn::GetAtt": ["TypedParameter", "Value"] } },
      SecretRef: { Value: { Ref: "GeneratedSecret" } },
      SecretId: { Value: { "Fn::GetAtt": ["GeneratedSecret", "Id"] } },
      PolicyRef: { Value: { Ref: "SecretPolicy" } },
    },
  });
}

test("PSS-04 provider schemas are closed and expose only the three owned resource contracts", () => {
  for (const schema of [SSM_PARAMETER_SCHEMA, SECRETS_MANAGER_SECRET_SCHEMA, SECRETS_MANAGER_RESOURCE_POLICY_SCHEMA]) {
    assert.equal(schema.unknownProperties, "REJECT");
  }
  assert.deepEqual(Object.keys(SECRETS_MANAGER_RESOURCE_POLICY_SCHEMA.properties).sort(), ["BlockPublicPolicy", "ResourcePolicy", "SecretId"]);
});

test("PSS-04 schema migration preserves existing resources without CloudFormation adoption", () => {
  const legacy = emptyState();
  legacy.schemaVersion = 81;
  const regional = legacy.accounts["000000000000"].regions[region] as any;
  regional.parameterStore.parameters["/existing"] = { name: "/existing", cloudFormationOwner: undefined };
  regional.secretsManager.secrets.existing = { name: "existing", cloudFormationOwner: undefined };
  const migrated = migrateState(legacy, "000000000000", region).state as any;
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.accounts["000000000000"].regions[region].parameterStore.parameters["/existing"].cloudFormationOwner, undefined);
  assert.equal(migrated.accounts["000000000000"].regions[region].secretsManager.secrets.existing.cloudFormationOwner, undefined);
});

test("PSS-04 deploys and destroys the unmodified pinned CDK constructs for all three provider types", { timeout: 60_000 }, async () => {
  const app = new App();
  const stack = new Stack(app, "Pss04Cdk", { env: { account: "000000000000", region } });
  new ssmCdk.StringParameter(stack, "Parameter", { parameterName: "/pss04/cdk", stringValue: "from-cdk", description: "pinned construct" });
  const secret = new secretsmanager.Secret(stack, "Secret", {
    secretName: "pss04/cdk-secret",
    generateSecretString: { secretStringTemplate: JSON.stringify({ username: "cdk" }), generateStringKey: "password", passwordLength: 20, excludePunctuation: true },
  });
  secret.applyRemovalPolicy(RemovalPolicy.DESTROY);
  secret.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.AccountRootPrincipal()], actions: ["secretsmanager:GetSecretValue"], resources: ["*"] }));
  const synthesized = app.synth().getStackArtifact(stack.artifactId).template;
  assert.deepEqual([...new Set(Object.values(synthesized.Resources).map((resource: any) => resource.Type).filter((type: string) => type !== "AWS::CDK::Metadata"))].sort(), ["AWS::SSM::Parameter", "AWS::SecretsManager::ResourcePolicy", "AWS::SecretsManager::Secret"]);

  const root = await mkdtemp(join(tmpdir(), "stacksim-pss04-cdk-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let client!: CloudFormationClient;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() });
    await client.send(new CreateStackCommand({ StackName: "pss04-cdk", TemplateBody: JSON.stringify(synthesized) }));
    await waitForStack(client, clock, "pss04-cdk", "CREATE_COMPLETE");
    await assert.rejects(client.send(new UpdateStackCommand({ StackName: "pss04-cdk", TemplateBody: JSON.stringify(synthesized) })), /No updates/i);
    await client.send(new DeleteStackCommand({ StackName: "pss04-cdk" }));
    await waitForStack(client, clock, "pss04-cdk", "DELETE_COMPLETE");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-04 deploys, updates, restarts, protects, and deletes SSM and Secrets Manager resources", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss04-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let cloudformation!: CloudFormationClient;
  let ssm!: SSMClient;
  let secrets!: SecretsManagerClient;
  const destroyClients = (): void => { cloudformation?.destroy(); ssm?.destroy(); secrets?.destroy(); };
  try {
    await simulator.start();
    const clients = (): void => {
      const configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
      cloudformation = new CloudFormationClient(configuration);
      ssm = new SSMClient(configuration);
      secrets = new SecretsManagerClient(configuration);
    };
    clients();
    await ssm.send(new PutParameterCommand({ Name: "/pss04/source/plain", Type: "String", Value: "typed-value" }));
    await ssm.send(new PutParameterCommand({ Name: "/pss04/source/list", Type: "String", Value: "alpha, beta" }));
    await ssm.send(new PutParameterCommand({ Name: "/pss04/source/secure", Type: "SecureString", Value: "never-persist-this-plaintext" }));
    await secrets.send(new CreateSecretCommand({ Name: "pss04/source-json", SecretString: JSON.stringify({ password: "json-secret-marker" }), ClientRequestToken: "9".repeat(32) }));

    await cloudformation.send(new CreateStackCommand({ StackName: "pss04-stack", TemplateBody: template("created") }));
    const created = await waitForStack(cloudformation, clock, "pss04-stack", "CREATE_COMPLETE");
    const outputs = Object.fromEntries(created.Outputs.map((output: any) => [output.OutputKey, output.OutputValue]));
    assert.equal(outputs.ParameterName, "/pss04/typed");
    assert.match(outputs.ParameterArn, /:parameter\/pss04\/typed$/);
    assert.equal(outputs.ParameterType, "String");
    assert.equal(outputs.ParameterValue, "typed-value");
    assert.equal(outputs.SecretRef, outputs.SecretId);
    assert.equal(outputs.PolicyRef, outputs.SecretRef);
    assert.equal((await ssm.send(new GetParameterCommand({ Name: "/pss04/dynamic" }))).Parameter?.Value, "alpha,beta");
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: "pss04/copied" }))).SecretString, "never-persist-this-plaintext");
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: "pss04/copied-json" }))).SecretString, "json-secret-marker");
    const generated = JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: "pss04/generated" }))).SecretString!);
    assert.equal(generated.username, "local");
    assert.equal(generated.password.length, 24);
    assert.match((await secrets.send(new GetResourcePolicyCommand({ SecretId: "pss04/generated" }))).ResourcePolicy!, /GetSecretValue/);
    await assert.rejects(ssm.send(new PutParameterCommand({ Name: "/pss04/typed", Type: "String", Value: "outside", Overwrite: true })), /CloudFormation/);
    await assert.rejects(secrets.send(new UpdateSecretCommand({ SecretId: "pss04/generated", Description: "outside" })), /CloudFormation/);

    await cloudformation.send(new UpdateStackCommand({ StackName: "pss04-stack", TemplateBody: template("updated") }));
    await waitForStack(cloudformation, clock, "pss04-stack", "UPDATE_COMPLETE");
    assert.equal((await secrets.send(new DescribeSecretCommand({ SecretId: "pss04/generated" }))).Description, "updated");

    destroyClients();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    clients();
    await assert.rejects(secrets.send(new UpdateSecretCommand({ SecretId: "pss04/generated", Description: "after restart" })), /CloudFormation/);
    const state = await readFile(join(root, "state.json"), "utf8");
    assert.match(state, /\{\{resolve:ssm-secure:\/pss04\/source\/secure:1\}\}/);
    assert.doesNotMatch(state, /never-persist-this-plaintext/);
    assert.doesNotMatch(state, /json-secret-marker/);

    await cloudformation.send(new DeleteStackCommand({ StackName: "pss04-stack" }));
    await waitForStack(cloudformation, clock, "pss04-stack", "DELETE_COMPLETE");
    await assert.rejects(ssm.send(new GetParameterCommand({ Name: "/pss04/typed" })), /not found/i);
    await assert.rejects(secrets.send(new DescribeSecretCommand({ SecretId: "pss04/generated" })), /find|exist/i);
  } finally {
    destroyClients();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-04 rejects secure dynamic references in unsafe destinations before mutation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss04-negative-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  const client = new CloudFormationClient({ endpoint: "http://127.0.0.1:1", region, credentials });
  try {
    await simulator.start();
    const configured = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() });
    try {
      await assert.rejects(configured.send(new CreateStackCommand({ StackName: "unsafe", TemplateBody: JSON.stringify({ Resources: { Function: { Type: "AWS::Lambda::Function", Properties: { Code: { ZipFile: "exports.handler = async () => ({})" }, Handler: "index.handler", Role: "arn:aws:iam::000000000000:role/example", Runtime: "nodejs20.x", Environment: { Variables: { PASSWORD: "{{resolve:ssm-secure:/unsafe:1}}" } } } } } }) })), /secure dynamic reference|not supported/i);
      await assert.rejects(configured.send(new DescribeStacksCommand({ StackName: "unsafe" })), /exist/i);
    } finally { configured.destroy(); }
  } finally {
    client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-04 reduced bootstrap execution role authorizes exact provider and resolver actions", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss04-auth-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true });
  let cloudformation!: CloudFormationClient;
  let ssm!: SSMClient;
  try {
    await simulator.start();
    const configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(configuration);
    ssm = new SSMClient(configuration);
    await ssm.send(new PutParameterCommand({ Name: "/pss04/auth/source", Type: "String", Value: "authorized" }));
    const roleArn = `arn:aws:iam::000000000000:role/cdk-hnb659fds-cfn-exec-role-000000000000-${region}`;
    const body = JSON.stringify({ Resources: {
      Parameter: { Type: "AWS::SSM::Parameter", Properties: { Name: "/pss04/auth/target", Type: "String", Value: "{{resolve:ssm:/pss04/auth/source:1}}" } },
      Secret: { Type: "AWS::SecretsManager::Secret", Properties: { Name: "pss04/auth", GenerateSecretString: { PasswordLength: 20 } } },
      Policy: { Type: "AWS::SecretsManager::ResourcePolicy", Properties: { SecretId: { Ref: "Secret" }, BlockPublicPolicy: true, ResourcePolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "secretsmanager:GetSecretValue", Resource: "*" }] } } },
    } });
    await cloudformation.send(new CreateStackCommand({ StackName: "pss04-auth", RoleARN: roleArn, TemplateBody: body }));
    await waitForStack(cloudformation, clock, "pss04-auth", "CREATE_COMPLETE");
    assert.equal((await ssm.send(new GetParameterCommand({ Name: "/pss04/auth/target" }))).Parameter?.Value, "authorized");
    await cloudformation.send(new DeleteStackCommand({ StackName: "pss04-auth", RoleARN: roleArn }));
    await waitForStack(cloudformation, clock, "pss04-auth", "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy();
    ssm?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
