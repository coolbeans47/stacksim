import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateActivityCommand, CreateStateMachineCommand, DeleteActivityCommand, DescribeActivityCommand, DescribeExecutionCommand, GetActivityTaskCommand, ListActivitiesCommand, ListTagsForResourceCommand, SendTaskSuccessCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { createStepFunctionsActivityProvider, STEP_FUNCTIONS_ACTIVITY_TYPE } from "../src/cloudformation/providers/step-functions-activity.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";
import { StepFunctionsExecutionStore } from "../src/step-functions/execution-store.js";
import type { StepFunctionsExecutionState, StepFunctionsRegionState } from "../src/types.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const arn = (name: string) => `arn:aws:states:${region}:${accountId}:activity:${name}`;
const identity = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
function context(callbackContext?: Record<string, any>, resourceGeneration?: string): ProviderContext {
  return { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/activity-provider/stack-id`, logicalId: "Worker", operationId: "operation-1", resourceOperationId: "resource-operation-1", idempotencyKey: "activity-operation", deadlineAt: Date.now() + 60_000, principal: { identity }, callbackContext, resourceGeneration };
}
async function settle(invoke: (context: ProviderContext) => Promise<any>, initial = context()): Promise<any> {
  let result = await invoke(initial);
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 10; attempt++) result = await invoke({ ...initial, callbackContext: result.checkpoint.callbackContext });
  return result;
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let result: T;
  for (let attempt = 0; attempt < 500; attempt++) { result = await read(); if (accept(result)) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Condition did not settle: ${JSON.stringify(result!)}`);
}
async function stackStatus(client: CloudFormationClient, stack: string, expected: string) {
  return until(() => client.send(new DescribeStacksCommand({ StackName: stack })), result => result.Stacks?.[0].StackStatus === expected);
}

test("Activity provider freezes official Name/tags/default encryption/Ref/GetAtt and ownership contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-activity-contract-"));
  const sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "off" });
  try {
    await sim.start();
    const provider = createStepFunctionsActivityProvider(sim.stepfunctions);
    assert(provider.validate({}, context()).some(issue => issue.code === "MissingRequiredProperty" && issue.path === "Properties.Name"));
    for (const Name of ["", "bad name", "bad/name", "a".repeat(81), "\ud800", "\uffff", "\u{10ffff}"]) assert(provider.validate({ Name }, context()).length);
    for (const encryption of [{ Type: "CUSTOMER_MANAGED_KMS_KEY" }, { Type: "AWS_OWNED_KEY", KmsKeyId: "key" }, {}]) {
      assert(provider.validate({ Name: "activity", EncryptionConfiguration: encryption }, context()).some(issue => issue.code === "UnsupportedProperty"));
    }
    assert(provider.validate({ Name: "activity", Tags: [{ Key: "aws:override", Value: "no" }] }, context()).length);
    assert(provider.validate({ Name: "activity", Unknown: true }, context()).some(issue => issue.code === "UnsupportedProperty"));
    const model = provider.canonicalize({ Name: "activity", Tags: [{ Key: "owner", Value: "learning" }] }, context());
    const explicitDefault = provider.canonicalize({ Name: "activity", EncryptionConfiguration: { Type: "AWS_OWNED_KEY" }, Tags: model.Tags }, context());
    assert.equal(provider.plan(model, explicitDefault, context()).action, "NO_OP");
    const created = await settle(ctx => provider.create(model, ctx));
    assert.equal(created.status, "SUCCESS");
    assert.equal(provider.ref(created.model), arn("activity"));
    assert.equal(provider.getAtt(created.model, "Arn"), arn("activity"));
    assert.equal(provider.getAtt(created.model, "Name"), "activity");
    assert.throws(() => provider.getAtt(created.model, "StackSimResourceGeneration"));
    assert.equal((await sim.stepfunctions.ListActivities({})).activities.length, 1);
    assert.equal((await provider.read(arn("activity"), context())).status, "SUCCESS");
    assert.equal(provider.plan(model, { ...model, Name: "replacement" }, context()).action, "REPLACE");
    assert.equal((await provider.update(arn("activity"), model, { ...model, Name: "replacement" }, context())).status, "FAILED");
    await sim.stepfunctions.CreateActivity({ name: "independent" });
    const existing = await provider.create({ ...model, Name: "independent" }, context());
    assert.equal(existing.status, "FAILED");
    if (existing.status === "FAILED") assert.equal(existing.errorCode, "AlreadyExists");
    assert.deepEqual((await sim.stepfunctions.ListTagsForResource({ resourceArn: arn("independent") })).tags, []);
    const deleted = await settle(ctx => provider.delete(arn("activity"), model, ctx));
    assert.equal(deleted.status, "SUCCESS");
    assert.equal((await provider.read(arn("activity"), context())).status, "NOT_FOUND");
  } finally { await sim.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Activity provider resumes every checkpoint and refuses stale generations after deletion/recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-activity-restart-"));
  let sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "off" });
  try {
    await sim.start();
    let provider = createStepFunctionsActivityProvider(sim.stepfunctions);
    const initial = provider.canonicalize({ Name: "restart", Tags: [{ Key: "remove", Value: "old" }] }, context());
    const phases: string[] = [];
    const resume = async (result: any, invoke: (ctx: ProviderContext) => Promise<any>) => {
      while (result.status === "IN_PROGRESS") {
        phases.push(String(result.checkpoint.callbackContext.phase));
        assert.deepEqual(Object.keys(result.checkpoint.callbackContext).sort(), ["generation", "phase"]);
        const checkpoint = structuredClone(result.checkpoint.callbackContext);
        await sim.stop();
        sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "off" });
        await sim.start(); provider = createStepFunctionsActivityProvider(sim.stepfunctions);
        result = await invoke(context(checkpoint));
      }
      assert.equal(result.status, "SUCCESS"); return result;
    };
    const created = await resume(await provider.create(initial, context()), ctx => provider.create(initial, ctx));
    const desired = { ...initial, Tags: [{ Key: "new", Value: "new" }] };
    const updated = await resume(await provider.update(arn("restart"), initial, desired, context()), ctx => provider.update(arn("restart"), initial, desired, ctx));
    assert.deepEqual(updated.model.properties.Tags, desired.Tags);
    await resume(await provider.delete(arn("restart"), desired, context()), ctx => provider.delete(arn("restart"), desired, ctx));
    assert.deepEqual(phases, ["after-create", "after-untag", "after-tag", "before-delete"]);
    // Recreating the same physical ARN, even with the old owner's tags, cannot
    // make an old checkpoint or persisted resource identity valid again.
    await sim.stepfunctions.CreateActivity({ name: "restart", tags: [
      { key: "aws:cloudformation:stack-id", value: context().stackId },
      { key: "aws:cloudformation:logical-id", value: context().logicalId },
    ] });
    const oldGeneration = created.model.attributes.StackSimResourceGeneration;
    for (const result of [
      await provider.create(initial, context({ phase: "after-create", generation: oldGeneration })),
      await provider.update(arn("restart"), initial, desired, context(undefined, oldGeneration)),
      await provider.delete(arn("restart"), desired, context({ phase: "before-delete", generation: oldGeneration })),
    ]) { assert.equal(result.status, "FAILED"); if (result.status === "FAILED") assert.equal(result.errorCode, "OwnershipConflict"); }
    assert.notEqual(sim.stepfunctions.cloudFormationResourceGeneration(arn("restart")), oldGeneration);
    await sim.stepfunctions.DescribeActivity({ activityArn: arn("restart") });
  } finally { await sim.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation Activity lifecycle uses its execution role for tags/replacement/retention and rejects independent resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-activity-stack-"));
  const sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "enforce" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await sim.start();
    const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials };
    const cfn = new CloudFormationClient(options); const iam = new IAMClient(options); const sfn = new SFNClient(options); clients.push(cfn, iam, sfn);
    const RoleARN = (await iam.send(new CreateRoleCommand({ RoleName: "activity-deploy", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
    const grant = async (denied?: string) => iam.send(new PutRolePolicyCommand({ RoleName: "activity-deploy", PolicyName: "deployment", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["states:CreateActivity", "states:DeleteActivity", "states:DescribeActivity", "states:ListTagsForResource", "states:TagResource", "states:UntagResource"], Resource: arn("*") },
      ...(denied ? [{ Effect: "Deny", Action: denied, Resource: arn("*") }] : []),
    ] }) }));
    await grant();
    const template = (name: string, value: string, retain = false) => JSON.stringify({ Resources: { Worker: { Type: STEP_FUNCTIONS_ACTIVITY_TYPE, ...(retain ? { DeletionPolicy: "Retain" } : {}), Properties: { Name: name, Tags: [{ Key: "release", Value: value }] } } }, Outputs: { Activity: { Value: { Ref: "Worker" } }, Name: { Value: { "Fn::GetAtt": ["Worker", "Name"] } } } });
    const created = await cfn.send(new CreateStackCommand({ StackName: "activity-lifecycle", RoleARN, TemplateBody: template("stack-worker", "v1") }));
    await stackStatus(cfn, created.StackId!, "CREATE_COMPLETE");
    assert.equal((await sfn.send(new ListActivitiesCommand({}))).activities?.[0].activityArn, arn("stack-worker"));
    await assert.rejects(cfn.send(new UpdateStackCommand({ StackName: created.StackId, RoleARN, TemplateBody: template("stack-worker", "v1") })), /No updates/);
    await cfn.send(new UpdateStackCommand({ StackName: created.StackId, RoleARN, TemplateBody: template("stack-worker", "v2") }));
    await stackStatus(cfn, created.StackId!, "UPDATE_COMPLETE");
    assert.equal((await sfn.send(new ListTagsForResourceCommand({ resourceArn: arn("stack-worker") }))).tags?.find(tag => tag.key === "release")?.value, "v2");
    // UntagResource authorizes the removed keys, rather than the remaining tags.
    await iam.send(new PutRolePolicyCommand({ RoleName: "activity-deploy", PolicyName: "tag-removal-boundary", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "states:UntagResource", Resource: arn("stack-worker"), Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": "release" } } }] }) }));
    const removal = JSON.parse(template("stack-worker", "v2")); removal.Resources.Worker.Properties.Tags = [];
    await cfn.send(new UpdateStackCommand({ StackName: created.StackId, RoleARN, TemplateBody: JSON.stringify(removal) }));
    await stackStatus(cfn, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    assert.equal((await sfn.send(new ListTagsForResourceCommand({ resourceArn: arn("stack-worker") }))).tags?.find(tag => tag.key === "release")?.value, "v2");
    await sfn.send(new CreateActivityCommand({ name: "independent-worker" }));
    await cfn.send(new UpdateStackCommand({ StackName: created.StackId, RoleARN, TemplateBody: template("independent-worker", "v3") }));
    await stackStatus(cfn, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    await sfn.send(new DescribeActivityCommand({ activityArn: arn("stack-worker") }));
    assert.deepEqual((await sfn.send(new ListTagsForResourceCommand({ resourceArn: arn("independent-worker") }))).tags, []);
    await cfn.send(new UpdateStackCommand({ StackName: created.StackId, RoleARN, TemplateBody: template("replacement-worker", "v4", true) }));
    await stackStatus(cfn, created.StackId!, "UPDATE_COMPLETE");
    await assert.rejects(sfn.send(new DescribeActivityCommand({ activityArn: arn("stack-worker") })), { name: "ActivityDoesNotExist" });
    await cfn.send(new DeleteStackCommand({ StackName: created.StackId, RoleARN }));
    await stackStatus(cfn, created.StackId!, "DELETE_COMPLETE");
    await sfn.send(new DescribeActivityCommand({ activityArn: arn("replacement-worker") }));
    await grant("states:CreateActivity");
    const denied = await cfn.send(new CreateStackCommand({ StackName: "activity-denied", RoleARN, TemplateBody: template("denied-worker", "v1") }));
    await stackStatus(cfn, denied.StackId!, "ROLLBACK_COMPLETE");
    assert((await cfn.send(new DescribeStackEventsCommand({ StackName: denied.StackId }))).StackEvents?.some(event => /states:CreateActivity/.test(event.ResourceStatusReason ?? "")));
    await assert.rejects(sfn.send(new DescribeActivityCommand({ activityArn: arn("denied-worker") })), { name: "ActivityDoesNotExist" });
    assert(sim.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.principalArn.includes("assumed-role/activity-deploy/") && decision.action === "states:CreateActivity" && decision.resource === arn("stack-worker") && decision.decision === "allowed"));
    await sfn.send(new DeleteActivityCommand({ activityArn: arn("replacement-worker") }));
    await sfn.send(new DeleteActivityCommand({ activityArn: arn("independent-worker") }));
  } finally { clients.forEach(client => client.destroy()); await sim.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Activity v4 callback migration preserves known generations and refuses ambiguous legacy rebinding", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-activity-migration-"));
  const makeRegional = (): StepFunctionsRegionState => ({ stateMachines: {}, stateMachineNames: {}, executions: {}, executionNames: {}, activities: { [arn("legacy")]: { activityArn: arn("legacy"), name: "legacy", generation: "original-generation", creationDate: 100, tags: {}, encryptionConfiguration: { type: "AWS_OWNED_KEY" } } }, activityNames: { legacy: arn("legacy") }, revision: 0 });
  const store = new StepFunctionsExecutionStore(root, accountId, region);
  let resumed: StepFunctionsExecutionStore | undefined;
  try {
    await store.start(makeRegional());
    const callbacks = Object.fromEntries([101, 100, 99].map(createdAt => [String(createdAt), { tokenId: `opaque-${createdAt}`, tokenDigest: `digest-${createdAt}`, kind: "ACTIVITY", status: "PENDING", stateName: "Work", taskAttemptId: `attempt-${createdAt}`, activityArn: arn("legacy"), createdAt }]));
    const execution = { executionArn: "legacy-execution", callbackTasks: callbacks } as unknown as StepFunctionsExecutionState;
    await store.put(execution); await store.stop();
    const database = new DatabaseSync(store.file);
    database.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run("4"); database.close();
    let regional = makeRegional(); resumed = new StepFunctionsExecutionStore(root, accountId, region); await resumed.start(regional);
    const tasks = regional.executions["legacy-execution"].callbackTasks!;
    assert.equal(tasks["101"].activityGeneration, "original-generation");
    assert.equal(tasks["100"].activityGeneration, "legacy-unresolved");
    assert.equal(tasks["99"].activityGeneration, "legacy-unresolved");
    assert.equal(tasks["100"].tokenId, "opaque-100");
    await resumed.stop();
    regional = makeRegional(); regional.activities[arn("legacy")].generation = "replacement-generation";
    resumed = new StepFunctionsExecutionStore(root, accountId, region); await resumed.start(regional);
    assert.equal(regional.executions["legacy-execution"].callbackTasks!["101"].activityGeneration, "original-generation");
    assert.equal(regional.executions["legacy-execution"].callbackTasks!["100"].activityGeneration, "legacy-unresolved");
  } finally { await store.stop(); await resumed?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation refuses to delete a same-name recreated Activity using the persisted generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-activity-stack-generation-"));
  const sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await sim.start();
    const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials };
    const cfn = new CloudFormationClient(options); const sfn = new SFNClient(options); clients.push(cfn, sfn);
    const stack = await cfn.send(new CreateStackCommand({ StackName: "activity-generation", TemplateBody: JSON.stringify({ Resources: { Worker: { Type: STEP_FUNCTIONS_ACTIVITY_TYPE, Properties: { Name: "protected-generation" } } } }) }));
    await stackStatus(cfn, stack.StackId!, "CREATE_COMPLETE");
    const tags = (await sfn.send(new ListTagsForResourceCommand({ resourceArn: arn("protected-generation") }))).tags;
    await sfn.send(new DeleteActivityCommand({ activityArn: arn("protected-generation") }));
    await sfn.send(new CreateActivityCommand({ name: "protected-generation", tags }));
    await cfn.send(new DeleteStackCommand({ StackName: stack.StackId }));
    await stackStatus(cfn, stack.StackId!, "DELETE_FAILED");
    await sfn.send(new DescribeActivityCommand({ activityArn: arn("protected-generation") }));
    assert((await cfn.send(new DescribeStackEventsCommand({ StackName: stack.StackId }))).StackEvents?.some(event => /different generation/.test(event.ResourceStatusReason ?? "")));
    await sfn.send(new DeleteActivityCommand({ activityArn: arn("protected-generation") }));
    await cfn.send(new DeleteStackCommand({ StackName: stack.StackId }));
    await stackStatus(cfn, stack.StackId!, "DELETE_COMPLETE");
  } finally { clients.forEach(client => client.destroy()); await sim.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Activity deletion preserves leased tokens but recreated workers cannot claim old queued tasks, including after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-activity-workers-"));
  let sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await sim.start();
    const options = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials });
    let sfn = new SFNClient(options()); const iam = new IAMClient(options()); clients.push(sfn, iam);
    const roleArn = (await iam.send(new CreateRoleCommand({ RoleName: "activity-execution", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
    const provider = createStepFunctionsActivityProvider(sim.stepfunctions);
    const model = provider.canonicalize({ Name: "worker" }, context());
    await settle(ctx => provider.create(model, ctx));
    const machine = await sfn.send(new CreateStateMachineCommand({ name: "workers", roleArn, definition: JSON.stringify({ StartAt: "Work", States: { Work: { Type: "Task", Resource: arn("worker"), TimeoutSeconds: 120, End: true } } }) }));
    const leased = await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn, name: "leased" }));
    const claimed = await sfn.send(new GetActivityTaskCommand({ activityArn: arn("worker"), workerName: "sdk-worker" }));
    assert(claimed.taskToken);
    const queued = await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn, name: "queued" }));
    await until(async () => Object.values(sim.store.regionState(region).stepFunctions.executions[queued.executionArn!].callbackTasks ?? {}).length, count => count === 1);
    await settle(ctx => provider.delete(arn("worker"), model, ctx));
    await sfn.send(new SendTaskSuccessCommand({ taskToken: claimed.taskToken, output: '{"completed":true}' }));
    await until(() => sfn.send(new DescribeExecutionCommand({ executionArn: leased.executionArn })), result => result.status === "SUCCEEDED");
    await sfn.send(new CreateActivityCommand({ name: "worker" }));
    await sim.stop();
    sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "off" }); await sim.start();
    sfn = new SFNClient(options()); clients.push(sfn);
    const empty = await sfn.send(new GetActivityTaskCommand({ activityArn: arn("worker") }));
    assert.equal(empty.taskToken, "");
    const fresh = await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn, name: "fresh" }));
    const current = await sfn.send(new GetActivityTaskCommand({ activityArn: arn("worker") }));
    assert(current.taskToken);
    await sfn.send(new SendTaskSuccessCommand({ taskToken: current.taskToken, output: '{"generation":"new"}' }));
    await until(() => sfn.send(new DescribeExecutionCommand({ executionArn: fresh.executionArn })), result => result.status === "SUCCEEDED");
    assert.equal((await sfn.send(new DescribeExecutionCommand({ executionArn: queued.executionArn }))).status, "RUNNING");
    await sfn.send(new StopExecutionCommand({ executionArn: queued.executionArn }));
  } finally { clients.forEach(client => client.destroy()); await sim.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
