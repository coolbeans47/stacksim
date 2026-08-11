import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AddPermissionCommand, CreateFunctionCommand, GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CancelRotateSecretCommand, CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, RotateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateDBInstanceCommand, DeleteDBInstanceCommand, DescribeDBInstancesCommand, ModifyDBInstanceCommand, RDSClient } from "@aws-sdk/client-rds";
import { DeleteSecretCommand, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { App, Duration, Stack } from "aws-cdk-lib";
import * as lambdaCdk from "aws-cdk-lib/aws-lambda";
import * as iamCdk from "aws-cdk-lib/aws-iam";
import * as secretsmanagerCdk from "aws-cdk-lib/aws-secretsmanager";
import { createZip } from "../src/core/zip-create.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { createSecretsManagerRotationScheduleProvider, createSecretsManagerSecretTargetAttachmentProvider } from "../src/cloudformation/providers/secrets-manager-rotation.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const role = "arn:aws:iam::000000000000:role/test";

const rotationSource = `
const {
  SecretsManagerClient, DescribeSecretCommand, GetSecretValueCommand,
  PutSecretValueCommand, UpdateSecretVersionStageCommand,
} = require('@aws-sdk/client-secrets-manager');
const client = new SecretsManagerClient({ endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION });
exports.handler = async event => {
  const { Step, SecretId, ClientRequestToken: token } = event;
  console.log(JSON.stringify({ kind: 'rotation-step', step: Step, token }));
  const description = await client.send(new DescribeSecretCommand({ SecretId }));
  const stages = description.VersionIdsToStages || {};
  if (Step === 'createSecret') {
    if (!stages[token]) {
      const current = await client.send(new GetSecretValueCommand({ SecretId, VersionStage: 'AWSCURRENT' }));
      const value = JSON.parse(current.SecretString);
      value.password = 'RotatedMaterial-' + token.slice(0, 8);
      await client.send(new PutSecretValueCommand({ SecretId, ClientRequestToken: token, SecretString: JSON.stringify(value), VersionStages: ['AWSPENDING'] }));
    }
    return;
  }
  await client.send(new GetSecretValueCommand({ SecretId, VersionId: token, VersionStage: 'AWSPENDING' }));
  if (Step === 'testSecret') {
    if (!(stages[token] || []).includes('TEST_ATTEMPTED')) {
      await client.send(new UpdateSecretVersionStageCommand({ SecretId, VersionStage: 'TEST_ATTEMPTED', MoveToVersionId: token }));
      throw new Error('fixture retry boundary');
    }
    return;
  }
  if (Step === 'setSecret') return;
  if (Step === 'finishSecret') {
    if ((stages[token] || []).includes('AWSCURRENT')) return;
    const current = Object.entries(stages).find(([, labels]) => labels.includes('AWSCURRENT'));
    if (!current) throw new Error('missing current version');
    await client.send(new UpdateSecretVersionStageCommand({ SecretId, VersionStage: 'AWSCURRENT', MoveToVersionId: token, RemoveFromVersionId: current[0] }));
  }
};
`;

async function active(client: LambdaClient, name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await client.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).State === "Active") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Lambda ${name} didn't become active`);
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for PSS-06 fixture checkpoint");
}

async function stackStatus(client: CloudFormationClient, name: string, expected: string): Promise<void> {
  await until(async () => {
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      if (stack?.StackStatus === expected) return true;
      if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
      return false;
    }
    catch (error: any) { if (expected === "DELETE_COMPLETE" && error.name === "ValidationError") return true; throw error; }
  }, 20_000);
}

test("PSS-06 real Lambda uses one durable token across four steps and restart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss06-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: true });
  let secrets: SecretsManagerClient | undefined; let lambda: LambdaClient | undefined; let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    lambda = new LambdaClient({ endpoint, region, credentials }); secrets = new SecretsManagerClient({ endpoint, region, credentials }); logs = new CloudWatchLogsClient({ endpoint, region, credentials });
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "pss06-rotation", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Timeout: 5, Code: { ZipFile: createZip([{ name: "index.js", content: rotationSource }]) } }));
    await active(lambda, "pss06-rotation");
    const created = await secrets.send(new CreateSecretCommand({ Name: "pss06/app", ClientRequestToken: "initial-version-token-0000000000000001", SecretString: JSON.stringify({ username: "app", password: "PlaintextFixtureOne" }) }));
    await assert.rejects(secrets.send(new RotateSecretCommand({ SecretId: created.ARN, RotationLambdaARN: fn.FunctionArn })), (error: any) => error.name === "AccessDeniedException");
    assert.equal((await secrets.send(new DescribeSecretCommand({ SecretId: created.ARN }))).RotationEnabled, undefined);
    const context = { accountId: "000000000000", region, partition: "aws", stackId: "stack", logicalId: "Rotation", operationId: "op", resourceOperationId: "resource-op", idempotencyKey: "a".repeat(32), deadlineAt: Date.now() + 10_000, principal: { identity: {} as any } };
    assert.ok(createSecretsManagerRotationScheduleProvider(simulator.secretsmanager).validate({ SecretId: created.ARN, RotationLambdaARN: fn.FunctionArn, HostedRotationLambda: { RotationType: "MySQLSingleUser" } }, context).some(issue => issue.path === "Properties.HostedRotationLambda"));
    assert.ok(createSecretsManagerSecretTargetAttachmentProvider(simulator.secretsmanager).validate({ SecretId: created.ARN, TargetId: "target", TargetType: "AWS::Lambda::Function" }, context).some(issue => issue.path === "Properties.TargetType"));
    await lambda.send(new AddPermissionCommand({ FunctionName: "pss06-rotation", StatementId: "secrets-manager", Action: "lambda:InvokeFunction", Principal: "secretsmanager.amazonaws.com", SourceArn: created.ARN, SourceAccount: "000000000000" }));
    const token = "rotation-client-token-000000000000001";
    await secrets.send(new RotateSecretCommand({ SecretId: created.ARN, RotationLambdaARN: fn.FunctionArn, ClientRequestToken: token, RotationRules: { ScheduleExpression: "rate(4 hours)", Duration: "1h" } }));
    await until(() => {
      const operation = simulator.store.regionState(region).secretsManager.secrets["pss06/app"].rotation?.operation;
      return operation?.step === "testSecret" && operation.attempts.testSecret === 1 && operation.errorSummary !== undefined;
    });
    const persistedBeforeRestart = JSON.stringify(simulator.store.state);
    assert.doesNotMatch(persistedBeforeRestart, /PlaintextFixtureOne|RotatedMaterial-/);
    await simulator.stop(); lambda.destroy(); secrets.destroy(); logs.destroy();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: true });
    await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`;
    lambda = new LambdaClient({ endpoint, region, credentials }); secrets = new SecretsManagerClient({ endpoint, region, credentials }); logs = new CloudWatchLogsClient({ endpoint, region, credentials });
    await until(() => simulator.store.regionState(region).secretsManager.secrets["pss06/app"].rotation?.lastStatus === "SUCCEEDED", 15_000);
    const description = await secrets.send(new DescribeSecretCommand({ SecretId: created.ARN }));
    const current = Object.entries(description.VersionIdsToStages ?? {}).filter(([, stages]) => stages.includes("AWSCURRENT"));
    assert.deepEqual(current.map(([version]) => version), [token]);
    const rotated = await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN }));
    assert.equal(JSON.parse(rotated.SecretString!).password, `RotatedMaterial-${token.slice(0, 8)}`);

    const streams = await logs.send(new DescribeLogStreamsCommand({ logGroupName: "/aws/lambda/pss06-rotation" }));
    const messages: string[] = [];
    for (const stream of streams.logStreams ?? []) messages.push(...((await logs.send(new GetLogEventsCommand({ logGroupName: "/aws/lambda/pss06-rotation", logStreamName: stream.logStreamName, startFromHead: true }))).events ?? []).map(event => event.message ?? ""));
    const safe = messages.filter(message => message.includes("rotation-step")).join("\n");
    for (const step of ["createSecret", "setSecret", "testSecret", "finishSecret"]) assert.match(safe, new RegExp(step));
    assert.ok(safe.split(token).length - 1 >= 5, "every step and the retry must use the same client token");
    assert.doesNotMatch(safe, /PlaintextFixtureOne|RotatedMaterial-/);
    const control = await readFile(join(root, "state.json"), "utf8");
    assert.doesNotMatch(control, /PlaintextFixtureOne|RotatedMaterial-/);

    const cancelled = await secrets.send(new CreateSecretCommand({ Name: "pss06/cancel", ClientRequestToken: "cancel-initial-token-00000000000001", SecretString: JSON.stringify({ username: "app", password: "CancelOriginalMaterial" }) }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "pss06-rotation", StatementId: "secrets-manager-cancel", Action: "lambda:InvokeFunction", Principal: "secretsmanager.amazonaws.com", SourceArn: cancelled.ARN, SourceAccount: "000000000000" }));
    const cancelToken = "cancel-rotation-token-00000000000001";
    await secrets.send(new RotateSecretCommand({ SecretId: cancelled.ARN, RotationLambdaARN: fn.FunctionArn, ClientRequestToken: cancelToken, RotationRules: { ScheduleExpression: "rate(4 hours)", Duration: "1h" } }));
    await until(() => simulator.store.regionState(region).secretsManager.secrets["pss06/cancel"].rotation?.operation?.step === "testSecret");
    await assert.rejects(secrets.send(new RotateSecretCommand({ SecretId: cancelled.ARN, RotationLambdaARN: fn.FunctionArn, ClientRequestToken: "different-concurrent-token-000000001" })), (error: any) => error.name === "InvalidRequestException");
    await assert.rejects(secrets.send(new DeleteSecretCommand({ SecretId: cancelled.ARN, ForceDeleteWithoutRecovery: true })), (error: any) => error.name === "InvalidRequestException");
    await secrets.send(new CancelRotateSecretCommand({ SecretId: cancelled.ARN }));
    await until(() => !simulator.store.regionState(region).secretsManager.secrets["pss06/cancel"].rotation?.operation);
    assert.equal(JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: cancelled.ARN }))).SecretString!).password, "CancelOriginalMaterial");
    assert.ok((await secrets.send(new DescribeSecretCommand({ SecretId: cancelled.ARN }))).VersionIdsToStages?.[cancelToken]?.includes("AWSPENDING"));

    const cfnSecret = await secrets.send(new CreateSecretCommand({ Name: "pss06/cfn-rotation", ClientRequestToken: "cfn-initial-version-token-0000000001", SecretString: JSON.stringify({ username: "app", password: "CfnOriginalMaterial" }) }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "pss06-rotation", StatementId: "secrets-manager-cfn", Action: "lambda:InvokeFunction", Principal: "secretsmanager.amazonaws.com", SourceArn: cfnSecret.ARN, SourceAccount: "000000000000" }));
    const rotationProvider = createSecretsManagerRotationScheduleProvider(simulator.secretsmanager);
    const rotationContext = { ...context, stackId: "stack/pss06", logicalId: "RotationSchedule", operationId: "rotation-create", resourceOperationId: "rotation-resource", idempotencyKey: "b".repeat(32) };
    const rotationModel = rotationProvider.canonicalize({ SecretId: cfnSecret.ARN, RotationLambdaARN: fn.FunctionArn, RotationRules: { ScheduleExpression: "rate(4 hours)", Duration: "1h" }, RotateImmediatelyOnUpdate: true }, rotationContext);
    const rotationCreated = await rotationProvider.create(rotationModel, rotationContext);
    assert.equal(rotationCreated.status, "SUCCESS");
    await until(() => simulator.store.regionState(region).secretsManager.secrets["pss06/cfn-rotation"].rotation?.lastStatus === "SUCCEEDED", 15_000);
    const rotationRead = await rotationProvider.read(cfnSecret.ARN!, rotationContext); assert.equal(rotationRead.status, "SUCCESS");
    const updatedRotationModel = rotationProvider.canonicalize({ SecretId: cfnSecret.ARN, RotationLambdaARN: fn.FunctionArn, RotationRules: { ScheduleExpression: "rate(8 hours)", Duration: "1h" }, RotateImmediatelyOnUpdate: false }, rotationContext);
    const rotationUpdated = await rotationProvider.update(cfnSecret.ARN!, rotationModel, updatedRotationModel, { ...rotationContext, operationId: "rotation-update", idempotencyKey: "c".repeat(32) });
    assert.equal(rotationUpdated.status, "SUCCESS");
    assert.equal((await rotationProvider.read(cfnSecret.ARN!, rotationContext)).status, "SUCCESS");
    assert.equal((await rotationProvider.delete(cfnSecret.ARN!, updatedRotationModel, { ...rotationContext, operationId: "rotation-delete" })).status, "SUCCESS");
    assert.equal((await rotationProvider.read(cfnSecret.ARN!, rotationContext)).status, "NOT_FOUND");

    const cdkSecret = await secrets.send(new CreateSecretCommand({ Name: "pss06/cdk-existing-function", ClientRequestToken: "cdk-initial-version-token-0000000001", SecretString: JSON.stringify({ username: "app", password: "CdkOriginalMaterial" }) }));
    const app = new App(); const stack = new Stack(app, "Pss06ExistingFunction", { env: { account: "000000000000", region } });
    const importedSecret = secretsmanagerCdk.Secret.fromSecretCompleteArn(stack, "ImportedSecret", cdkSecret.ARN!);
    const importedFunction = lambdaCdk.Function.fromFunctionArn(stack, "ImportedRotationFunction", fn.FunctionArn!);
    importedFunction.addPermission("SecretsManagerInvoke", { principal: new iamCdk.ServicePrincipal("secretsmanager.amazonaws.com"), sourceArn: cdkSecret.ARN });
    importedSecret.addRotationSchedule("Rotation", { rotationLambda: importedFunction, automaticallyAfter: Duration.days(1), rotateImmediatelyOnUpdate: false });
    const cdkTemplate = app.synth().getStackArtifact(stack.artifactId).template;
    assert.ok(Object.values(cdkTemplate.Resources).some((resource: any) => resource.Type === "AWS::SecretsManager::RotationSchedule"));
    assert.ok(Object.values(cdkTemplate.Resources).every((resource: any) => resource.Properties?.HostedRotationLambda === undefined));
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials });
    try {
      await cloudformation.send(new CreateStackCommand({ StackName: "pss06-existing-function", TemplateBody: JSON.stringify(cdkTemplate) }));
      await stackStatus(cloudformation, "pss06-existing-function", "CREATE_COMPLETE");
      assert.equal((await secrets.send(new DescribeSecretCommand({ SecretId: cdkSecret.ARN }))).RotationEnabled, true);
      await cloudformation.send(new DeleteStackCommand({ StackName: "pss06-existing-function" }));
      await stackStatus(cloudformation, "pss06-existing-function", "DELETE_COMPLETE");
      assert.equal((await secrets.send(new DescribeSecretCommand({ SecretId: cdkSecret.ARN }))).RotationEnabled, false);
    } finally { cloudformation.destroy(); }

    const vpc = await lambda.send(new CreateFunctionCommand({ FunctionName: "pss06-vpc-rejected", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler=async()=>{}" }]) }, VpcConfig: { SubnetIds: ["subnet-12345678"], SecurityGroupIds: ["sg-12345678"] } }));
    await active(lambda, "pss06-vpc-rejected");
    const vpcSecret = await secrets.send(new CreateSecretCommand({ Name: "pss06/vpc", ClientRequestToken: "vpc-initial-version-token-000000001", SecretString: "vpc-original" }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "pss06-vpc-rejected", StatementId: "secrets-manager-vpc", Action: "lambda:InvokeFunction", Principal: "secretsmanager.amazonaws.com", SourceArn: vpcSecret.ARN, SourceAccount: "000000000000" }));
    await assert.rejects(secrets.send(new RotateSecretCommand({ SecretId: vpcSecret.ARN, RotationLambdaARN: vpc.FunctionArn })), (error: any) => error.name === "InvalidParameterValueException" && /VPC-hosted/.test(error.message));
    assert.equal((await secrets.send(new DescribeSecretCommand({ SecretId: vpcSecret.ARN }))).RotationEnabled, undefined);
    await assert.rejects(secrets.send(new RotateSecretCommand({ SecretId: vpcSecret.ARN, RotationLambdaARN: `arn:aws:lambda:${region}:000000000000:function:missing-rotation` })), (error: any) => error.name === "ResourceNotFoundException");
    assert.equal((await secrets.send(new DescribeSecretCommand({ SecretId: vpcSecret.ARN }))).RotationEnabled, undefined);
  } finally {
    lambda?.destroy(); secrets?.destroy(); logs?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("PSS-06 injected-clock schedule admits a later real Lambda rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss06-schedule-")); const clock = new TestClock(1_800_000_000_000);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let secrets: SecretsManagerClient | undefined; let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    secrets = new SecretsManagerClient({ endpoint, region, credentials }); lambda = new LambdaClient({ endpoint, region, credentials });
    const scheduledSource = rotationSource.replace(/  if \(Step === 'testSecret'\) \{[\s\S]*?\n  \}\n  if \(Step === 'setSecret'\)/, "  if (Step === 'testSecret') return;\n  if (Step === 'setSecret')");
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "pss06-scheduled-rotation", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Timeout: 5, Code: { ZipFile: createZip([{ name: "index.js", content: scheduledSource }]) } }));
    await active(lambda, "pss06-scheduled-rotation");
    const created = await secrets.send(new CreateSecretCommand({ Name: "pss06/scheduled", ClientRequestToken: "scheduled-initial-token-000000000001", SecretString: JSON.stringify({ username: "app", password: "ScheduledOriginalMaterial" }) }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "pss06-scheduled-rotation", StatementId: "secrets-manager-scheduled", Action: "lambda:InvokeFunction", Principal: "secretsmanager.amazonaws.com", SourceArn: created.ARN, SourceAccount: "000000000000" }));
    await secrets.send(new RotateSecretCommand({ SecretId: created.ARN, RotationLambdaARN: fn.FunctionArn, ClientRequestToken: "scheduled-manual-token-0000000000001", RotationRules: { ScheduleExpression: "rate(4 hours)", Duration: "1h" } }));
    await until(() => { clock.advance(0); return simulator.store.regionState(region).secretsManager.secrets["pss06/scheduled"].rotation?.lastStatus === "SUCCEEDED"; }, 15_000);
    const before = simulator.store.regionState(region).secretsManager.secrets["pss06/scheduled"];
    const firstRotationAt = before.rotation!.lastRotatedAt!; const firstVersions = Object.keys(before.versions).length;
    clock.advance(4 * 3_600_000);
    await until(() => {
      clock.advance(0);
      const current = simulator.store.regionState(region).secretsManager.secrets["pss06/scheduled"];
      if (current.rotation?.lastStatus === "FAILED") throw new Error(`scheduled rotation failed at ${current.rotation.operation?.step ?? "terminal"}: ${current.rotation.lastErrorSummary ?? current.rotation.operation?.errorSummary ?? "unknown"}`);
      return current.rotation?.lastStatus === "SUCCEEDED" && current.rotation.lastRotatedAt! > firstRotationAt && Object.keys(current.versions).length > firstVersions;
    }, 15_000);
    const final = await secrets.send(new DescribeSecretCommand({ SecretId: created.ARN }));
    assert.equal(Object.values(final.VersionIdsToStages ?? {}).filter(stages => stages.includes("AWSCURRENT")).length, 1);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), /ScheduledOriginalMaterial|RotatedMaterial-/);
  } finally { secrets?.destroy(); lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("PSS-06 bounded RDS managed master secret rotates and follows modify/delete lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss06-rds-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, rdsStartupTimeoutMs: 1_000 });
  let rds: RDSClient | undefined; let secrets: SecretsManagerClient | undefined; let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); let endpoint = `http://127.0.0.1:${simulator.port}`;
    rds = new RDSClient({ endpoint, region, credentials }); secrets = new SecretsManagerClient({ endpoint, region, credentials }); lambda = new LambdaClient({ endpoint, region, credentials });
    await assert.rejects(rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "kms-rejected", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "admin", ManageMasterUserPassword: true, MasterUserSecretKmsKeyId: "alias/customer", Port: 13307 })), (error: any) => error.name === "InvalidParameterCombination");
    await assert.rejects(rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "mutex-rejected", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "admin", ManageMasterUserPassword: true, MasterUserPassword: "CallerPassword123!", Port: 13307 })), (error: any) => error.name === "InvalidParameterCombination");
    await rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "managed-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "admin", ManageMasterUserPassword: true, Port: 13307, PubliclyAccessible: false, BackupRetentionPeriod: 0 }));
    await until(async () => (await rds!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "managed-db" }))).DBInstances?.[0].DBInstanceStatus === "available", 15_000);
    let described = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "managed-db" }))).DBInstances![0];
    const firstArn = described.MasterUserSecret?.SecretArn;
    assert.ok(firstArn); assert.equal(described.MasterUserSecret?.SecretStatus, "active");
    const managed = await secrets.send(new GetSecretValueCommand({ SecretId: firstArn }));
    const managedJson = JSON.parse(managed.SecretString!); assert.equal(managedJson.engine, "mysql"); assert.equal(managedJson.host, "127.0.0.1"); assert.equal(managedJson.port, 13307); assert.equal(managedJson.username, "admin"); assert.equal(typeof managedJson.password, "string");

    rds.destroy(); secrets.destroy(); lambda.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, rdsStartupTimeoutMs: 1_000 });
    await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`;
    rds = new RDSClient({ endpoint, region, credentials }); secrets = new SecretsManagerClient({ endpoint, region, credentials }); lambda = new LambdaClient({ endpoint, region, credentials });
    described = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "managed-db" }))).DBInstances![0];
    assert.equal(described.MasterUserSecret?.SecretArn, firstArn); assert.equal(described.MasterUserSecret?.SecretStatus, "active");
    assert.equal(JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: firstArn }))).SecretString!).password, managedJson.password);
    await assert.rejects(secrets.send(new UpdateSecretCommand({ SecretId: firstArn, SecretString: "customer-change", ClientRequestToken: "customer-mutation-token-00000000001" })), (error: any) => error.name === "InvalidRequestException");
    await assert.rejects(secrets.send(new DeleteSecretCommand({ SecretId: firstArn, ForceDeleteWithoutRecovery: true })), (error: any) => error.name === "InvalidRequestException");

    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "pss06-rds-rotation", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Timeout: 5, Code: { ZipFile: createZip([{ name: "index.js", content: rotationSource }]) } }));
    await active(lambda, "pss06-rds-rotation"); await lambda.send(new AddPermissionCommand({ FunctionName: "pss06-rds-rotation", StatementId: "rds-managed-secret", Action: "lambda:InvokeFunction", Principal: "secretsmanager.amazonaws.com", SourceArn: firstArn, SourceAccount: "000000000000" }));
    const token = "rds-rotation-client-token-00000000001";
    await secrets.send(new RotateSecretCommand({ SecretId: firstArn, RotationLambdaARN: fn.FunctionArn, ClientRequestToken: token, RotationRules: { ScheduleExpression: "rate(4 hours)", Duration: "1h" } }));
    await until(() => simulator.store.regionState(region).secretsManager.secrets[Object.keys(simulator.store.regionState(region).secretsManager.secrets).find(name => simulator.store.regionState(region).secretsManager.secrets[name].arn === firstArn)!].rotation?.lastStatus === "SUCCEEDED", 15_000);
    const state = simulator.store.regionState(region).rdsDbInstances["managed-db"];
    assert.equal(state.managedCredentialSaga, undefined); assert.equal(state.dbInstanceStatus, "available");
    assert.ok((await secrets.send(new DescribeSecretCommand({ SecretId: firstArn }))).VersionIdsToStages?.[token]?.includes("AWSCURRENT"));

    await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: "managed-db", ManageMasterUserPassword: false, MasterUserPassword: "CustomerPassword123!", ApplyImmediately: true }));
    await until(async () => (await rds!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "managed-db" }))).DBInstances?.[0].DBInstanceStatus === "available", 15_000);
    described = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "managed-db" }))).DBInstances![0]; assert.equal(described.MasterUserSecret, undefined);
    await assert.rejects(secrets.send(new DescribeSecretCommand({ SecretId: firstArn })), (error: any) => error.name === "ResourceNotFoundException");

    const attached = await secrets.send(new CreateSecretCommand({ Name: "pss06/attachment", ClientRequestToken: "attachment-initial-token-000000001", SecretString: JSON.stringify({ username: "admin", password: "CustomerPassword123!" }) }));
    const attachmentProvider = createSecretsManagerSecretTargetAttachmentProvider(simulator.secretsmanager);
    const attachmentContext = { accountId: "000000000000", region, partition: "aws", stackId: "stack/pss06", logicalId: "TargetAttachment", operationId: "attachment-create", resourceOperationId: "attachment-resource", idempotencyKey: "d".repeat(32), deadlineAt: Date.now() + 10_000, principal: { identity: {} as any } };
    const attachmentModel = attachmentProvider.canonicalize({ SecretId: attached.ARN, TargetId: "managed-db", TargetType: "AWS::RDS::DBInstance" }, attachmentContext);
    const missingAttachmentModel = attachmentProvider.canonicalize({ SecretId: attached.ARN, TargetId: "missing-db", TargetType: "AWS::RDS::DBInstance" }, attachmentContext);
    assert.equal((await attachmentProvider.create(missingAttachmentModel, { ...attachmentContext, logicalId: "MissingTarget" })).status, "FAILED");
    assert.equal((await attachmentProvider.read(attached.ARN!, attachmentContext)).status, "NOT_FOUND");
    assert.equal((await attachmentProvider.create(attachmentModel, attachmentContext)).status, "SUCCESS");
    assert.equal((await attachmentProvider.read(attached.ARN!, attachmentContext)).status, "SUCCESS");
    const attachedValue = JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: attached.ARN }))).SecretString!);
    assert.deepEqual({ engine: attachedValue.engine, host: attachedValue.host, port: attachedValue.port, dbInstanceIdentifier: attachedValue.dbInstanceIdentifier }, { engine: "mysql", host: "127.0.0.1", port: 13307, dbInstanceIdentifier: "managed-db" });
    assert.equal((await attachmentProvider.delete(attached.ARN!, attachmentModel, { ...attachmentContext, operationId: "attachment-delete" })).status, "SUCCESS");
    assert.equal((await attachmentProvider.read(attached.ARN!, attachmentContext)).status, "NOT_FOUND");
    const detachedValue = JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: attached.ARN }))).SecretString!);
    assert.equal(detachedValue.host, undefined); assert.equal(detachedValue.password, "CustomerPassword123!");

    await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: "managed-db", ManageMasterUserPassword: true }));
    described = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "managed-db" }))).DBInstances![0]; const secondArn = described.MasterUserSecret?.SecretArn; assert.ok(secondArn); assert.notEqual(secondArn, firstArn);
    await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "managed-db", SkipFinalSnapshot: true, DeleteAutomatedBackups: true }));
    await until(async () => {
      const local = simulator.store.regionState(region).rdsDbInstances["managed-db"];
      if (local?.dbInstanceStatus === "failed") throw new Error(local.statusMessage);
      if (local !== undefined) return false;
      try { await secrets!.send(new DescribeSecretCommand({ SecretId: secondArn })); return false; }
      catch (error: any) { if (error.name === "ResourceNotFoundException") return true; throw error; }
    }, 15_000);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), /CallerPassword123|CustomerPassword123|RotatedMaterial-/);
  } finally { rds?.destroy(); secrets?.destroy(); lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
