import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateStateMachineCommand, DeleteStateMachineCommand, DescribeExecutionCommand, DescribeStateMachineCommand, DescribeStateMachineForExecutionCommand, ListTagsForResourceCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createStepFunctionsStateMachineProvider } from "../src/cloudformation/providers/step-functions-state-machine.js";
import { StackSim } from "../src/server.js";
import type { CloudFormationCheckpointObservation } from "../src/cloudformation.js";

const accountId = "000000000000", region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/sfn-lifecycle/generation`;
const identity = { ...credentials, principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
const definition = (value: string) => JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Pass", Result: value, End: true } } });
function context(callbackContext?: Readonly<Record<string, any>>, resourceGeneration?: string): ProviderContext {
  return { accountId, region, partition: "aws", stackId, logicalId: "Workflow", operationId: "op", resourceOperationId: "resource-op", idempotencyKey: "stable-op", deadlineAt: Date.now() + 60_000, principal: { identity }, ...(callbackContext ? { callbackContext } : {}), ...(resourceGeneration ? { resourceGeneration } : {}) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sfn04-lifecycle-"));
  let sim = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: false });
  await sim.start();
  const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
  const cfn = new CloudFormationClient(options), iam = new IAMClient(options), sfn = new SFNClient(options);
  const role = async (RoleName: string) => (await iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
  return { get sim() { return sim; }, cfn, iam, sfn, role,
    async restart(interceptor?: (observation: CloudFormationCheckpointObservation) => boolean) { const port = sim.port; await sim.stop(); sim = new StackSim({ port, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: false }); sim.cloudformation.setCheckpointInterceptorForTest(interceptor); await sim.start(); },
    async close() { [cfn, iam, sfn].forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function status(f: Fixture, StackName: string, expected: string) {
  for (let i = 0; i < 300; i++) {
    const stack = (await f.cfn.send(new DescribeStacksCommand({ StackName }))).Stacks![0];
    if (stack.StackStatus === expected) return stack;
    if (!stack.StackStatus?.endsWith("IN_PROGRESS")) throw new Error(`${stack.StackStatus}: ${JSON.stringify((await f.cfn.send(new DescribeStackEventsCommand({ StackName }))).StackEvents)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
function template(name: string, selectedRole: string, body: string, retainReplacement = false) {
  const role = { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] } } };
  return JSON.stringify({ Resources: { FirstRole: role, SecondRole: role, Workflow: { Type: "AWS::StepFunctions::StateMachine", ...(retainReplacement ? { UpdateReplacePolicy: "Retain" } : {}), Properties: { StateMachineName: name, RoleArn: { "Fn::GetAtt": [selectedRole, "Arn"] }, DefinitionString: body, Tags: [{ Key: "release", Value: "test" }] } } }, Outputs: { Arn: { Value: { Ref: "Workflow" } }, FirstRole: { Value: { "Fn::GetAtt": ["FirstRole", "Arn"] } }, SecondRole: { Value: { "Fn::GetAtt": ["SecondRole", "Arn"] } } } });
}

test("SFN-04 provider admission matches disabled service shapes and rejects invalid nested properties", async () => {
  const f = await fixture();
  try {
    const roleArn = await f.role("validation-role");
    const provider = createStepFunctionsStateMachineProvider(f.sim.stepfunctions);
    const base = { DefinitionString: definition("valid"), RoleArn: roleArn };
    const defaults = { LoggingConfiguration: {}, TracingConfiguration: {}, EncryptionConfiguration: { Type: "AWS_OWNED_KEY" } };
    assert.deepEqual(provider.validate({ ...base, ...defaults }, context()), []);
    assert.equal(provider.plan(provider.canonicalize(base, context()), provider.canonicalize({ ...base, ...defaults }, context()), context()).action, "NO_OP");
    for (const [property, value] of [
      ["LoggingConfiguration", { Level: null }], ["LoggingConfiguration", { Destinations: null }], ["LoggingConfiguration", { IncludeExecutionData: true }], ["LoggingConfiguration", { Unknown: false }],
      ["TracingConfiguration", { Enabled: null }], ["TracingConfiguration", { Enabled: true }],
      ["EncryptionConfiguration", {}], ["EncryptionConfiguration", { Type: "AWS_OWNED_KEY", KmsKeyId: "ignored" }],
      ["Tags", [{ Key: "a", Value: "b", Unknown: true }]], ["Tags", [{ Key: "a".repeat(129), Value: "b" }]], ["Tags", [{ Key: "a", Value: "b".repeat(257) }]],
      ["DefinitionSubstitutions", { count: 1.5 }], ["DefinitionSubstitutions", {}],
    ] as const) assert(provider.validate({ ...base, [property]: value }, context()).some(issue => issue.path === `Properties.${property}`), `${property}: ${JSON.stringify(value)}`);
    await assert.rejects(f.sim.stepfunctions.CreateStateMachine({ name: "bad-null", definition: base.DefinitionString, roleArn, loggingConfiguration: { level: null } }), /logging/);
    assert.equal((await f.sim.stepfunctions.ListStateMachines({})).stateMachines.length, 0);
    const scalar = provider.canonicalize({ RoleArn: roleArn, DefinitionString: '{"StartAt":"Done","States":{"Done":{"Type":"Pass","Result":{"number":${n},"flag":${b},"text":"${prefix,suffix}"},"End":true}}}', DefinitionSubstitutions: { n: 2, b: false, prefix: "hello ", suffix: "world" } }, context());
    assert.deepEqual(JSON.parse(scalar.DefinitionString).States.Done.Result, { number: 2, flag: false, text: "hello world" });
  } finally { await f.close(); }
});

test("SFN-04 role snapshots, replacement conflict rollback, retained replacement and running deletion use real stack lifecycle", async () => {
  const f = await fixture();
  try {
    const waiting = JSON.stringify({ StartAt: "Wait", States: { Wait: { Type: "Wait", Seconds: 60, Next: "Done" }, Done: { Type: "Pass", Result: "original", End: true } } });
    const created = await f.cfn.send(new CreateStackCommand({ StackName: "Lifecycle", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template("original", "FirstRole", waiting, true) }));
    const original = await status(f, created.StackId!, "CREATE_COMPLETE"); const firstArn = original.Outputs!.find(output => output.OutputKey === "Arn")!.OutputValue!;
    const firstRole = original.Outputs!.find(output => output.OutputKey === "FirstRole")!.OutputValue!, secondRole = original.Outputs!.find(output => output.OutputKey === "SecondRole")!.OutputValue!;
    const started = await f.sfn.send(new StartExecutionCommand({ stateMachineArn: firstArn, name: "immutable" }));
    const changed = template("original", "SecondRole", definition("updated"), true);
    await f.cfn.send(new UpdateStackCommand({ StackName: created.StackId, Capabilities: ["CAPABILITY_IAM"], TemplateBody: changed }));
    await status(f, created.StackId!, "UPDATE_COMPLETE");
    assert.equal((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: firstArn }))).roleArn, secondRole);
    const snapshot = await f.sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: started.executionArn }));
    assert.equal(snapshot.roleArn, firstRole); assert.equal(snapshot.definition, waiting);
    const revision = (await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: firstArn }))).revisionId;
    await assert.rejects(f.cfn.send(new UpdateStackCommand({ StackName: created.StackId, Capabilities: ["CAPABILITY_IAM"], TemplateBody: changed })), /No updates/);
    assert.equal((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: firstArn }))).revisionId, revision);
    const independent = await f.sfn.send(new CreateStateMachineCommand({ name: "occupied", roleArn: firstRole, definition: definition("independent") }));
    await f.cfn.send(new UpdateStackCommand({ StackName: created.StackId, Capabilities: ["CAPABILITY_IAM"], TemplateBody: template("occupied", "SecondRole", definition("replacement"), true) }));
    await status(f, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    assert.equal((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: independent.stateMachineArn }))).definition, definition("independent"));
    assert.equal((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: firstArn }))).definition, definition("updated"));
    const phases: string[] = [];
    f.sim.cloudformation.setCheckpointInterceptorForTest(value => { if (value.checkpoint === "provider:Workflow:replace-create:attempt-1") { phases.push(value.checkpoint); return true; } return false; });
    await f.cfn.send(new UpdateStackCommand({ StackName: created.StackId, Capabilities: ["CAPABILITY_IAM"], TemplateBody: template("replacement", "SecondRole", definition("replacement"), true) }));
    for (let i = 0; phases.length < 1 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(phases, ["provider:Workflow:replace-create:attempt-1"]); await f.restart();
    const replaced = await status(f, created.StackId!, "UPDATE_COMPLETE"); const newArn = replaced.Outputs!.find(output => output.OutputKey === "Arn")!.OutputValue!; assert.notEqual(newArn, firstArn);
    await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: firstArn }));
    f.sim.cloudformation.setCheckpointInterceptorForTest(value => { if (value.checkpoint === "provider:Workflow:delete:attempt-1") { phases.push(value.checkpoint); return true; } return false; });
    await f.cfn.send(new DeleteStackCommand({ StackName: created.StackId }));
    for (let i = 0; phases.length < 2 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(phases[1], "provider:Workflow:delete:attempt-1"); await f.restart();
    await status(f, created.StackId!, "DELETE_COMPLETE");
    await assert.rejects(f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: newArn })), { name: "StateMachineDoesNotExist" });
    await f.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: firstArn }));
    await f.restart();
    assert.equal((await f.sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn }))).status, "RUNNING");
    assert.equal((await f.sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: started.executionArn }))).roleArn, firstRole);
    await f.sfn.send(new StopExecutionCommand({ executionArn: started.executionArn }));
  } finally { await f.close(); }
});

test("SFN-04 StateMachine checkpoint and persisted generation refuse recreated same-name resources", async () => {
  const f = await fixture();
  try {
    const roleArn = await f.role("generation-role");
    let provider = createStepFunctionsStateMachineProvider(f.sim.stepfunctions);
    const model = provider.canonicalize({ StateMachineName: "recreated", RoleArn: roleArn, DefinitionString: definition("owned") }, context());
    const pending = await provider.create(model, context()); assert.equal(pending.status, "IN_PROGRESS");
    if (pending.status !== "IN_PROGRESS") throw new Error("Missing create checkpoint");
    const arn = pending.checkpoint.physicalId!, callback = pending.checkpoint.callbackContext;
    assert.deepEqual(Object.keys(callback).sort(), ["generation", "phase"]);
    const ownedTags = (await f.sfn.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags!;
    await f.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: arn }));
    await f.sfn.send(new CreateStateMachineCommand({ name: "recreated", roleArn, definition: definition("independent"), tags: ownedTags }));
    await f.restart(); provider = createStepFunctionsStateMachineProvider(f.sim.stepfunctions);
    for (const result of [
      await provider.create(model, context(callback)),
      await provider.read(arn, context(undefined, String(callback.generation))),
      await provider.update(arn, model, { ...model, DefinitionString: definition("wrong") }, context(undefined, String(callback.generation))),
      await provider.delete(arn, model, context(undefined, String(callback.generation))),
    ]) { assert.equal(result.status, "FAILED"); if (result.status === "FAILED") assert.equal(result.errorCode, "OwnershipConflict"); }
    assert.equal((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }))).definition, definition("independent"));

    const deployed = await f.cfn.send(new CreateStackCommand({ StackName: "Generation", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template("catalog-generation", "FirstRole", definition("stack")) }));
    const stack = await status(f, deployed.StackId!, "CREATE_COMPLETE"); const deployedArn = stack.Outputs!.find(output => output.OutputKey === "Arn")!.OutputValue!; const deployedRole = stack.Outputs!.find(output => output.OutputKey === "FirstRole")!.OutputValue!;
    const stackTags = (await f.sfn.send(new ListTagsForResourceCommand({ resourceArn: deployedArn }))).tags!;
    await f.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: deployedArn }));
    await f.sfn.send(new CreateStateMachineCommand({ name: "catalog-generation", roleArn: deployedRole, definition: definition("new-generation"), tags: stackTags }));
    await f.restart();
    await f.cfn.send(new DeleteStackCommand({ StackName: deployed.StackId })); await status(f, deployed.StackId!, "DELETE_FAILED");
    assert.equal((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: deployedArn }))).definition, definition("new-generation"));
  } finally { await f.close(); }
});

test("SFN-04 stack roles require TagResource to create CloudFormation-owned workflows and Activities", async () => {
  const f = await fixture();
  try {
    const RoleName = "tag-denied-deployer";
    const RoleARN = (await f.iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
    await f.iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: "deny-tags", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }, { Effect: "Deny", Action: "states:TagResource", Resource: "*" }] }) }));
    for (const [name, body] of [
      ["TagDeniedMachine", template("tag-denied-machine", "FirstRole", definition("denied"))],
      ["TagDeniedActivity", JSON.stringify({ Resources: { Worker: { Type: "AWS::StepFunctions::Activity", Properties: { Name: "tag-denied-activity" } } } })],
    ]) {
      const created = await f.cfn.send(new CreateStackCommand({ StackName: name, RoleARN, TemplateBody: body, Capabilities: ["CAPABILITY_IAM"] }));
      await status(f, created.StackId!, "ROLLBACK_COMPLETE");
      assert.match(JSON.stringify((await f.cfn.send(new DescribeStackEventsCommand({ StackName: created.StackId }))).StackEvents), /states:TagResource/);
    }
    assert.equal((await f.sim.stepfunctions.ListStateMachines({})).stateMachines.length, 0);
    assert.equal((await f.sim.stepfunctions.ListActivities({})).activities.length, 0);
  } finally { await f.close(); }
});

test("SFN-04 replacement authorization targets the new physical ARN before either provider mutates service state", async () => {
  const f = await fixture();
  try {
    const RoleName = "replacement-deployer";
    const RoleARN = (await f.iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
    await f.iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: "deny-new-resources", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }, { Effect: "Deny", Action: ["states:CreateStateMachine", "states:CreateActivity"], Resource: [`arn:aws:states:${region}:${accountId}:stateMachine:denied-replacement`, `arn:aws:states:${region}:${accountId}:activity:denied-replacement`] }] }) }));
    const activity = (Name: string) => JSON.stringify({ Resources: { Worker: { Type: "AWS::StepFunctions::Activity", Properties: { Name } } } });
    for (const [name, original, replacement] of [
      ["AuthorizedMachine", template("permitted-original", "FirstRole", definition("original")), template("denied-replacement", "FirstRole", definition("replacement"))],
      ["AuthorizedActivity", activity("permitted-original"), activity("denied-replacement")],
    ]) {
      const created = await f.cfn.send(new CreateStackCommand({ StackName: name, RoleARN, TemplateBody: original, Capabilities: ["CAPABILITY_IAM"] }));
      await status(f, created.StackId!, "CREATE_COMPLETE");
      const revision = f.sim.store.regionState(region).stepFunctions.revision;
      await f.cfn.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: replacement, Capabilities: ["CAPABILITY_IAM"] }));
      await status(f, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
      assert.equal(f.sim.store.regionState(region).stepFunctions.revision, revision, "denied replacement must never create and then delete a resource");
      assert.match(JSON.stringify((await f.cfn.send(new DescribeStackEventsCommand({ StackName: created.StackId }))).StackEvents), /denied-replacement/);
    }
  } finally { await f.close(); }
});
