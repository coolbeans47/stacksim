import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackResourceCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, GetAliasCommand, GetFunctionCommand, GetPolicyCommand, LambdaClient, ListVersionsByFunctionCommand } from "@aws-sdk/client-lambda";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { createLambdaFunctionProvider } from "../src/cloudformation/providers/lambda-function.js";
import { createLambdaAliasProvider, createLambdaPermissionProvider, createLambdaVersionProvider } from "../src/cloudformation/providers/lambda-companions.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1"; const accountId = "000000000000"; const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
function context(logicalId: string, callbackContext?: Readonly<Record<string, any>>): ProviderContext { return { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/companions/stack-id`, logicalId, operationId: "operation", resourceOperationId: `${logicalId}-operation`, idempotencyKey: `${logicalId}-key`, deadlineAt: Date.now() + 60_000, ...(callbackContext ? { callbackContext } : {}), principal: { identity } }; }
async function finish(provider: any, desired: any, logicalId: string): Promise<any> { let result = await provider.create(desired, context(logicalId)); for (let i = 0; result.status === "IN_PROGRESS" && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, Math.max(1, result.callbackAfterMs))); result = await provider.create(desired, context(logicalId, result.checkpoint.callbackContext)); } return result; }

function permissionContext(logicalId: string, operationId: string, step: string): ProviderContext {
  return { ...context(logicalId), operationId, resourceOperationId: `${operationId}:${logicalId}:${step}`, idempotencyKey: `${operationId}:${logicalId}:${step}` };
}

async function createTestFunction(simulator: StackSim, functionName: string, roleName: string): Promise<{ iam: IAMClient; lambda: LambdaClient }> {
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const iam = new IAMClient({ endpoint, region, credentials }); const lambda = new LambdaClient({ endpoint, region, credentials });
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const role = (await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: trust }))).Role!.Arn!;
  await lambda.send(new CreateFunctionCommand({ FunctionName: functionName, Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => ({ ok: true });" }]) } }));
  return { iam, lambda };
}

async function permissionStatements(lambda: LambdaClient, functionName: string): Promise<any[]> {
  try { return JSON.parse((await lambda.send(new GetPolicyCommand({ FunctionName: functionName }))).Policy!).Statement ?? []; }
  catch (error) { if ((error as { name?: string }).name === "ResourceNotFoundException") return []; throw error; }
}

async function waitForStackStatus(cloudformation: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

function permissionTemplate(functionName: string, sourceArn: string, failAfterReplacement = false): string {
  return JSON.stringify({ Resources: {
    InvokePermission: { Type: "AWS::Lambda::Permission", Properties: { Action: "lambda:InvokeFunction", FunctionName: functionName, Principal: "apigateway.amazonaws.com", SourceAccount: accountId, SourceArn: sourceArn } },
    ...(failAfterReplacement ? { FailurePermission: { Type: "AWS::Lambda::Permission", DependsOn: "InvokePermission", Properties: { Action: "lambda:InvokeFunction", FunctionName: "missing-permission-target", Principal: "events.amazonaws.com" } } } : {}),
  } });
}

test("Lambda permission, immutable version, and alias providers use real Lambda policies and versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-companions-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"}); let iam: IAMClient | undefined; let lambdaClient: LambdaClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; iam = new IAMClient({ endpoint, region, credentials }); lambdaClient = new LambdaClient({ endpoint, region, credentials });
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    const role = (await iam.send(new CreateRoleCommand({ RoleName: "companion-role", AssumeRolePolicyDocument: trust }))).Role!.Arn!;
    const functionProvider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const fn = functionProvider.canonicalize({ FunctionName: "companion-handler", Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: "exports.handler = async () => ({ ok: true });" } }, context("Function"));
    assert.equal((await finish(functionProvider, fn, "Function")).status, "SUCCESS");

    const versionProvider = createLambdaVersionProvider(simulator.lambda); const version = versionProvider.canonicalize({ FunctionName: fn.FunctionName, Description: "first immutable snapshot" }, context("Version")); const versionResult = await finish(versionProvider, version, "Version");
    assert.equal(versionResult.status, "SUCCESS"); assert.equal(versionProvider.getAtt(versionResult.model, "Version"), "1"); assert.match(String(versionProvider.ref(versionResult.model)), /:function:companion-handler:1$/);

    const aliasProvider = createLambdaAliasProvider(simulator.lambda); const alias = aliasProvider.canonicalize({ FunctionName: fn.FunctionName, FunctionVersion: "1", Name: "live", Description: "production" }, context("Alias")); const aliasResult = await aliasProvider.create(alias, context("Alias"));
    assert.equal(aliasResult.status, "SUCCESS"); assert.equal((await lambdaClient.send(new GetAliasCommand({ FunctionName: fn.FunctionName, Name: "live" }))).FunctionVersion, "1");

    const permissionProvider = createLambdaPermissionProvider(simulator.lambda); const permission = permissionProvider.canonicalize({ Action: "lambda:InvokeFunction", FunctionName: fn.FunctionName, Principal: "apigateway.amazonaws.com", SourceAccount: accountId, SourceArn: `arn:aws:execute-api:${region}:${accountId}:api-id/*/*/*` }, context("ApiPermission")); const permissionResult = await permissionProvider.create(permission, context("ApiPermission"));
    assert.equal(permissionResult.status, "SUCCESS"); const policy = JSON.parse((await lambdaClient.send(new GetPolicyCommand({ FunctionName: fn.FunctionName }))).Policy!); assert.ok(policy.Statement.some((statement: any) => statement.Sid === permissionResult.physicalId.split("/").at(-1) && statement.Principal === "apigateway.amazonaws.com")); assert.equal((await permissionProvider.read(permissionResult.physicalId, context("ApiPermission"))).status, "SUCCESS");

    assert.equal((await permissionProvider.delete(permissionResult.physicalId, permission, context("ApiPermission"))).status, "SUCCESS");
    assert.equal((await aliasProvider.delete(aliasResult.physicalId, alias, context("Alias"))).status, "SUCCESS");
    assert.equal((await versionProvider.delete(versionResult.physicalId, version, context("Version"))).status, "SUCCESS");
    assert.equal((await functionProvider.delete(fn.FunctionName, fn, context("Function"))).status, "SUCCESS");
  } finally { iam?.destroy(); lambdaClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda Version read retains CodeSha256 and provisioned concurrency after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-version-read-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  let iam: IAMClient | undefined; let lambdaClient: LambdaClient | undefined;
  try {
    await simulator.start(); ({ iam, lambda: lambdaClient } = await createTestFunction(simulator, "version-read-handler", "version-read-role"));
    const codeSha256 = (await lambdaClient.send(new GetFunctionCommand({ FunctionName: "version-read-handler" }))).Configuration!.CodeSha256!;
    let provider = createLambdaVersionProvider(simulator.lambda); const versionContext = context("ReadVersion");
    const desired = provider.canonicalize({ FunctionName: "version-read-handler", CodeSha256: codeSha256, Description: "read after restart", ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 } }, versionContext);
    const created = await finish(provider, desired, "ReadVersion"); assert.equal(created.status, "SUCCESS");

    const mismatch = provider.canonicalize({ FunctionName: "version-read-handler", CodeSha256: "not-the-current-code-hash" }, context("MismatchedVersion"));
    const rejected = await finish(provider, mismatch, "MismatchedVersion"); assert.equal(rejected.status, "FAILED"); assert.equal(rejected.errorCode, "PreconditionFailedException");

    iam.destroy(); lambdaClient.destroy(); iam = undefined; lambdaClient = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" }); await simulator.start(); provider = createLambdaVersionProvider(simulator.lambda);
    const read = await provider.read(created.physicalId, versionContext); assert.equal(read.status, "SUCCESS");
    assert.equal(read.model.properties.CodeSha256, codeSha256);
    assert.deepEqual(read.model.properties.ProvisionedConcurrencyConfig, { ProvisionedConcurrentExecutions: 1 });
    assert.equal(provider.plan(read.model.properties, desired, versionContext).action, "NO_OP");
    assert.equal((await provider.delete(created.physicalId, desired, versionContext)).status, "SUCCESS");
  } finally { iam?.destroy(); lambdaClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda permission replacements isolate every immutable property and reject false adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-permission-replacements-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined; let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); ({ iam, lambda } = await createTestFunction(simulator, "permission-replacement-handler", "permission-replacement-role"));
    const provider = createLambdaPermissionProvider(simulator.lambda);
    const baseInput = { Action: "lambda:InvokeFunction", FunctionName: "permission-replacement-handler", Principal: "apigateway.amazonaws.com", SourceAccount: accountId, SourceArn: `arn:aws:execute-api:${region}:${accountId}:old-api/*/*/*` };
    const replacements: Array<{ property: string; input: Record<string, string> }> = [
      { property: "SourceArn", input: { ...baseInput, SourceArn: `arn:aws:execute-api:${region}:${accountId}:new-api/*/*/*` } },
      { property: "SourceAccount", input: { ...baseInput, SourceAccount: "111111111111" } },
      { property: "Action", input: { ...baseInput, Action: "lambda:InvokeAsync" } },
      { property: "Principal", input: { ...baseInput, Principal: "events.amazonaws.com" } },
    ];
    for (const [index, replacement] of replacements.entries()) {
      const logicalId = `Permission${replacement.property}`; const originalContext = permissionContext(logicalId, `create-${index}`, "create"); const replacementContext = permissionContext(logicalId, `update-${index}`, "replace-create");
      const original = provider.canonicalize(baseInput, originalContext); const desired = provider.canonicalize(replacement.input, replacementContext);
      const plan = provider.plan(original, desired, replacementContext); assert.equal(plan.action, "REPLACE"); assert.deepEqual(plan.changedProperties, [replacement.property]); assert.deepEqual(plan.replacementProperties, [replacement.property]); assert.equal(plan.replacementOrder, "CREATE_BEFORE_DELETE");
      const originalResult = await provider.create(original, originalContext); assert.equal(originalResult.status, "SUCCESS");
      const replacementResult = await provider.create(desired, replacementContext); assert.equal(replacementResult.status, "SUCCESS");
      assert.notEqual(replacementResult.physicalId, originalResult.physicalId, `${replacement.property} replacement reused the old physical permission`);
      assert.ok(originalResult.physicalId.split("/").at(-1)!.length <= 100); assert.ok(replacementResult.physicalId.split("/").at(-1)!.length <= 100);
      let statements = await permissionStatements(lambda, baseInput.FunctionName); const oldSid = originalResult.physicalId.split("/").at(-1); const replacementSid = replacementResult.physicalId.split("/").at(-1);
      assert.ok(statements.some(statement => statement.Sid === oldSid)); assert.ok(statements.some(statement => statement.Sid === replacementSid), `${replacement.property} replacement statement was not created alongside the old statement`);
      const replayedReplacement = await provider.create(desired, replacementContext); assert.equal(replayedReplacement.status, "SUCCESS"); assert.equal(replayedReplacement.physicalId, replacementResult.physicalId); assert.equal((await permissionStatements(lambda, baseInput.FunctionName)).filter(statement => statement.Sid === replacementSid).length, 1, "replacement replay duplicated its SID");

      const guardedDelete = await provider.delete(replacementResult.physicalId, original, permissionContext(logicalId, `update-${index}`, "replace-delete-guard"));
      assert.equal(guardedDelete.status, "FAILED"); assert.equal(guardedDelete.errorCode, "OwnershipConflict");
      assert.equal((await provider.read(replacementResult.physicalId, replacementContext)).status, "SUCCESS", "ownership guard removed the replacement statement");

      assert.equal((await provider.delete(originalResult.physicalId, original, permissionContext(logicalId, `update-${index}`, "replace-delete"))).status, "SUCCESS");
      statements = await permissionStatements(lambda, baseInput.FunctionName); assert.equal(statements.some(statement => statement.Sid === oldSid), false); assert.ok(statements.some(statement => statement.Sid === replacementSid), "deleting the old permission removed its replacement");
      assert.equal((await provider.delete(replacementResult.physicalId, desired, permissionContext(logicalId, `cleanup-${index}`, "delete"))).status, "SUCCESS");
    }

    const adoptionContext = permissionContext("FalseAdoption", "adoption-operation", "create"); const original = provider.canonicalize(baseInput, adoptionContext); const created = await provider.create(original, adoptionContext); assert.equal(created.status, "SUCCESS");
    for (const conditionOnlyChange of [
      provider.canonicalize({ ...baseInput, SourceArn: `arn:aws:execute-api:${region}:${accountId}:must-not-adopt/*/*/*` }, adoptionContext),
      provider.canonicalize({ ...baseInput, SourceAccount: "111111111111" }, adoptionContext),
    ]) {
      const falseAdoption = await provider.create(conditionOnlyChange, adoptionContext); assert.equal(falseAdoption.status, "FAILED"); assert.equal(falseAdoption.errorCode, "ResourceConflictException");
    }
    const retained = await provider.read(created.physicalId, adoptionContext); assert.equal(retained.status, "SUCCESS"); assert.equal(retained.model.properties.SourceArn, baseInput.SourceArn);
    assert.equal((await provider.delete(created.physicalId, original, adoptionContext)).status, "SUCCESS");
  } finally { iam?.destroy(); lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation permission replacement rollback preserves the old statement until deferred cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-permission-rollback-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined; let lambda: LambdaClient | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); ({ iam, lambda } = await createTestFunction(simulator, "permission-rollback-handler", "permission-rollback-role"));
    const endpoint = `http://127.0.0.1:${simulator.port}`; cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const oldSourceArn = `arn:aws:execute-api:${region}:${accountId}:rollback-old/*/*/*`; const newSourceArn = `arn:aws:execute-api:${region}:${accountId}:rollback-new/*/*/*`;
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "permission-rollback-stack", TemplateBody: permissionTemplate("permission-rollback-handler", oldSourceArn) }));
    await waitForStackStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const initialPhysicalId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "InvokePermission" }))).StackResourceDetail!.PhysicalResourceId!;

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: permissionTemplate("permission-rollback-handler", newSourceArn, true) }));
    await waitForStackStatus(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    const restored = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "InvokePermission" }))).StackResourceDetail!.PhysicalResourceId!;
    assert.equal(restored, initialPhysicalId, "rollback replaced the original SID even though deferred replacement cleanup had not run");
    const statements = await permissionStatements(lambda, "permission-rollback-handler"); assert.equal(statements.length, 1); assert.equal(statements[0].Sid, initialPhysicalId.split("/").at(-1)); assert.equal(statements[0].Condition?.ArnLike?.["AWS:SourceArn"], oldSourceArn); assert.notEqual(statements[0].Condition?.ArnLike?.["AWS:SourceArn"], newSourceArn);

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId })); await waitForStackStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
    assert.deepEqual(await permissionStatements(lambda, "permission-rollback-handler"), []);
  } finally { cloudformation?.destroy(); iam?.destroy(); lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation permission replacement resumes after restart between replacement create and old delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-permission-restart-")); const clock = new TestClock(10_000); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, clock, authMode: "off"});
  let iam: IAMClient | undefined; let lambda: LambdaClient | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); ({ iam, lambda } = await createTestFunction(simulator, "permission-restart-handler", "permission-restart-role"));
    let endpoint = `http://127.0.0.1:${simulator.port}`; cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const oldSourceArn = `arn:aws:execute-api:${region}:${accountId}:restart-old/*/*/*`; const newSourceArn = `arn:aws:execute-api:${region}:${accountId}:restart-new/*/*/*`;
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "permission-restart-stack", TemplateBody: permissionTemplate("permission-restart-handler", oldSourceArn) })); await waitForStackStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const oldPhysicalId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "InvokePermission" }))).StackResourceDetail!.PhysicalResourceId!; const oldSid = oldPhysicalId.split("/").at(-1)!;

    const originalHandle = simulator.lambda.handle.bind(simulator.lambda); let injected = false;
    (simulator.lambda as any).handle = async (req: any, res: any, pathname: string, url: URL, principal: PrincipalContext) => {
      if (!injected && req.method === "DELETE" && pathname.endsWith(`/policy/${oldSid}`)) { injected = true; throw new AwsError("InternalFailure", "injected old-permission delete retry", 500); }
      return await originalHandle(req, res, pathname, url, principal);
    };
    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: permissionTemplate("permission-restart-handler", newSourceArn) }));
    for (let attempt = 0; attempt < 200 && !injected; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(injected, true); let statements = await permissionStatements(lambda, "permission-restart-handler"); assert.equal(statements.length, 2, "replacement and old permission must coexist at the durable retry boundary");

    cloudformation.destroy(); iam.destroy(); lambda.destroy(); cloudformation = undefined; iam = undefined; lambda = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, clock, authMode: "off"}); await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 }); lambda = new LambdaClient({ endpoint, region, credentials });
    for (let attempt = 0; attempt < 10; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    statements = await permissionStatements(lambda, "permission-restart-handler"); assert.equal(statements.length, 2, "restart repeated replacement creation before the persisted old-delete retry");
    clock.advance(250); await waitForStackStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    statements = await permissionStatements(lambda, "permission-restart-handler"); assert.equal(statements.length, 1); assert.equal(statements[0].Condition?.ArnLike?.["AWS:SourceArn"], newSourceArn); assert.notEqual(statements[0].Sid, oldSid);
    const replacementPhysicalId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "InvokePermission" }))).StackResourceDetail!.PhysicalResourceId!; assert.notEqual(replacementPhysicalId, oldPhysicalId);
    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId })); await waitForStackStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally { cloudformation?.destroy(); iam?.destroy(); lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda Version provider adopts the authoritative version after PublishVersion commits but its response is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-version-crash-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let iam: IAMClient | undefined; let lambdaClient: LambdaClient | undefined; let publishMutations = 0;
  const providerFor = (active: StackSim, injectLostResponse: boolean): any => {
    let injected = false;
    const service = {
      handle: async (req: any, res: any, pathname: string, url: URL, principal: PrincipalContext) => {
        await active.lambda.handle(req, res, pathname, url, principal);
        if (req.method === "POST" && pathname.endsWith("/versions")) {
          publishMutations++;
          if (injectLostResponse && !injected) { injected = true; throw new AwsError("InternalFailure", "injected lost PublishVersion response", 500); }
        }
      },
    } as any;
    return createLambdaVersionProvider(service);
  };
  try {
    await simulator.start(); ({ iam, lambda: lambdaClient } = await createTestFunction(simulator, "version-crash-handler", "version-crash-role"));
    let provider = providerFor(simulator, true); const operationContext = context("CrashVersion");
    const desired = provider.canonicalize({ FunctionName: "version-crash-handler", Description: "published exactly once" }, operationContext);
    const lost = await provider.create(desired, operationContext); assert.equal(lost.status, "FAILED"); assert.equal(lost.errorCode, "InternalFailure"); assert.equal(lost.retryable, true); assert.equal(publishMutations, 1);
    assert.deepEqual((await lambdaClient.send(new ListVersionsByFunctionCommand({ FunctionName: "version-crash-handler" }))).Versions?.map(version => version.Version), ["$LATEST", "1"]);

    iam.destroy(); lambdaClient.destroy(); iam = undefined; lambdaClient = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"}); await simulator.start(); provider = providerFor(simulator, false);
    let result = await provider.create(desired, context("CrashVersion", {})); assert.equal(result.status, "IN_PROGRESS"); assert.equal(result.callbackAfterMs, 0); assert.equal(result.checkpoint.callbackContext.stateMachine, "lambda-version-v1"); assert.match(result.checkpoint.callbackContext.token, /^[a-f0-9]{64}$/); assert.equal(publishMutations, 1, "retry after restart must list/adopt instead of publishing version 2");
    const changed = provider.canonicalize({ FunctionName: "version-crash-handler", Description: "different desired version" }, operationContext); const conflict = await provider.create(changed, operationContext); assert.equal(conflict.status, "FAILED"); assert.equal(conflict.errorCode, "ResourceConflictException"); assert.equal(publishMutations, 1);
    result = await provider.create(desired, context("CrashVersion", result.checkpoint.callbackContext)); assert.equal(result.status, "SUCCESS"); assert.equal(result.model.attributes.Version, "1"); assert.equal(publishMutations, 1);
    lambdaClient = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const listed = await lambdaClient.send(new ListVersionsByFunctionCommand({ FunctionName: "version-crash-handler" })); assert.deepEqual(listed.Versions?.map(version => version.Version), ["$LATEST", "1"]); assert.equal(JSON.stringify(listed).includes("cloudFormationOperationToken"), false); assert.equal(listed.Versions?.find(version => version.Version === "1")?.Description, "published exactly once");
    assert.equal((await provider.delete(result.physicalId, desired, operationContext)).status, "SUCCESS");
  } finally { iam?.destroy(); lambdaClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda companion schemas accept the CFN-15 closure plus SNS and Secrets Manager invocation principals", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-lambda-composite-boundary-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  try {
    await simulator.start();
    assert.deepEqual(createLambdaVersionProvider(simulator.lambda).validate({
      FunctionName: "example",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 },
    }, context("Version")), []);
    assert.deepEqual(createLambdaAliasProvider(simulator.lambda).validate({
      FunctionName: "example",
      FunctionVersion: "1",
      Name: "live",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 },
    }, context("Alias")), []);
    const permission = createLambdaPermissionProvider(simulator.lambda);
    assert.deepEqual(permission.validate({
      FunctionName: "example",
      Action: "lambda:InvokeFunctionUrl",
      Principal: "*",
      FunctionUrlAuthType: "NONE",
    }, context("Permission")), []);
    assert.deepEqual(permission.validate({
      FunctionName: "example",
      Action: "lambda:InvokeFunction",
      Principal: "sns.amazonaws.com",
      SourceArn: `arn:aws:sns:${region}:${accountId}:example`,
      SourceAccount: accountId,
    }, context("SnsPermission")), []);
    assert.deepEqual(permission.validate({
      FunctionName: "example",
      Action: "lambda:InvokeFunction",
      Principal: "secretsmanager.amazonaws.com",
      SourceArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:example-abcdef`,
      SourceAccount: accountId,
    }, context("SecretsManagerPermission")), []);
  }
  finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
