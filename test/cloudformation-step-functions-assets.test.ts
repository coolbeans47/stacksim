import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateChangeSetCommand, CreateStackCommand, DeleteStackCommand, DescribeChangeSetCommand, DescribeStackEventsCommand, DescribeStacksCommand, ExecuteChangeSetCommand, GetTemplateCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateBucketCommand, DeleteObjectCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateAccessKeyCommand, CreateUserCommand, PutUserPolicyCommand, CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateActivityCommand, CreateStateMachineCommand, DescribeExecutionCommand, DescribeStateMachineCommand, DescribeStateMachineForExecutionCommand, SFNClient, StartExecutionCommand, UpdateStateMachineCommand } from "@aws-sdk/client-sfn";
import { StackSim } from "../src/server.js";
import type { CloudFormationCheckpointObservation } from "../src/cloudformation.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const definition = (result: unknown) => JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Pass", Result: result, End: true } } });
const trust = (service: string) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] });
function template(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ Resources: {
    Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: JSON.parse(trust("states.amazonaws.com")) } },
    Workflow: { Type: "AWS::StepFunctions::StateMachine", Properties: { RoleArn: { "Fn::GetAtt": ["Role", "Arn"] }, ...properties } },
    ...extra,
  }, Outputs: { WorkflowArn: { Value: { Ref: "Workflow" } } } });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sfn04-assets-"));
  let sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, region, authMode: "enforce" });
  await sim.start();
  const options = { region, endpoint: `http://127.0.0.1:${sim.port}`, credentials, maxAttempts: 1 };
  const cfn = new CloudFormationClient(options), sfn = new SFNClient(options), iam = new IAMClient(options), s3 = new S3Client({ ...options, forcePathStyle: true });
  return { root, cfn, sfn, iam, s3, get sim() { return sim; },
    async restart(interceptor?: (observation: CloudFormationCheckpointObservation) => boolean) {
      const port = sim.port; await sim.stop();
      sim = new StackSim({ dataDir: root, port, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, region, authMode: "enforce" });
      sim.cloudformation.setCheckpointInterceptorForTest(interceptor); await sim.start();
    },
    async close() { [cfn, sfn, iam, s3].forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function stackStatus(f: Fixture, name: string, status: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = (await f.cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks![0];
    if (value.StackStatus === status) return value;
    if (!value.StackStatus?.endsWith("IN_PROGRESS")) throw new Error(`Expected ${status}, got ${value.StackStatus}: ${JSON.stringify((await f.cfn.send(new DescribeStackEventsCommand({ StackName: name }))).StackEvents)}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${name}/${status}`);
}
async function run(f: Fixture, arn: string) {
  const started = await f.sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
  for (let i = 0; i < 150; i++) {
    const execution = await f.sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn }));
    if (execution.status !== "RUNNING") { assert.equal(execution.status, "SUCCEEDED", JSON.stringify(execution)); return JSON.parse(execution.output!); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not finish");
}
async function create(f: Fixture, name: string, body: string, roleArn?: string) {
  return f.cfn.send(new CreateStackCommand({ StackName: name, TemplateBody: body, Capabilities: ["CAPABILITY_IAM"], ...(roleArn ? { RoleARN: roleArn } : {}) }));
}

test("SFN-04 versioned definitions, substitutions, effective reads, no-op, updates and immutable execution snapshots", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-versioned";
    await f.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await f.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    const raw = '{"StartAt":"Done","States":{"Done":{"Type":"Pass","Result":{"message":"${first,second}","count":${count},"enabled":${enabled}},"End":true}}}';
    const first = await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: raw }));
    const props = { DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" }, DefinitionSubstitutions: { first: "hello", second: " world", count: 3, enabled: true } };
    const planned = await f.cfn.send(new CreateChangeSetCommand({ StackName: "versioned", ChangeSetName: "reviewed", ChangeSetType: "CREATE", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template(props) }));
    assert.equal((await f.cfn.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }))).Status, "CREATE_COMPLETE");
    const processed = JSON.parse(String((await f.cfn.send(new GetTemplateCommand({ ChangeSetName: planned.Id, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(processed.Resources.Workflow.Properties.DefinitionS3Location.Version, first.VersionId);
    await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("unreviewed") }));
    await f.restart();
    await f.cfn.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id }));
    const stack = await stackStatus(f, "versioned", "CREATE_COMPLETE");
    const arn = stack.Outputs![0].OutputValue!;
    assert.deepEqual(await run(f, arn), { message: "hello world", count: 3, enabled: true });
    assert.match((await f.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }))).definition!, /hello world/);
    const pinnedProps = { ...props, DefinitionS3Location: { ...props.DefinitionS3Location, Version: first.VersionId } };
    await assert.rejects(f.cfn.send(new UpdateStackCommand({ StackName: "versioned", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template(pinnedProps) })), /No updates/);
    const waiting = JSON.stringify({ StartAt: "Wait", States: { Wait: { Type: "Wait", Seconds: 2, Next: "Done" }, Done: { Type: "Pass", Result: "snapshot", End: true } } });
    await f.cfn.send(new UpdateStackCommand({ StackName: "versioned", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template({ DefinitionString: waiting }) }));
    await stackStatus(f, "versioned", "UPDATE_COMPLETE");
    const active = await f.sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
    await f.cfn.send(new UpdateStackCommand({ StackName: "versioned", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template({ Definition: JSON.parse(definition("updated")) }) }));
    await stackStatus(f, "versioned", "UPDATE_COMPLETE");
    assert.equal((await f.sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: active.executionArn }))).definition, waiting);
    assert.equal(await run(f, arn), "updated");
    // Delete preserves an admitted execution even when its owning role is removed.
    await f.cfn.send(new DeleteStackCommand({ StackName: "versioned" })); await stackStatus(f, stack.StackId!, "DELETE_COMPLETE");
    await f.restart();
    for (let i = 0; i < 250; i++) {
      const execution = await f.sfn.send(new DescribeExecutionCommand({ executionArn: active.executionArn }));
      if (execution.status !== "RUNNING") { assert.equal(execution.status, "SUCCEEDED"); assert.equal(JSON.parse(execution.output!), "snapshot"); break; }
      assert(i < 249); await new Promise(resolve => setTimeout(resolve, 15));
    }
  } finally { await f.close(); }
});

test("SFN-04 unversioned changes fail review execution; missing/version/encoding/size/syntax boundaries never create workflows", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-boundaries"; await f.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("reviewed") }));
    const body = template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" } });
    const plan = await f.cfn.send(new CreateChangeSetCommand({ StackName: "changed", ChangeSetName: "reviewed", ChangeSetType: "CREATE", Capabilities: ["CAPABILITY_IAM"], TemplateBody: body }));
    await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("changed") }));
    await assert.rejects(f.cfn.send(new ExecuteChangeSetCommand({ ChangeSetName: plan.Id })), /asset changed/);
    assert.equal((await f.cfn.send(new DescribeChangeSetCommand({ ChangeSetName: plan.Id }))).ExecutionStatus, "AVAILABLE", "asset validation rejects execution before it starts");
    for (const [key, content, encoding] of [
      ["bad.json", "{bad", undefined], ["bad-utf8.json", Buffer.from([0xff, 0xfe]), undefined],
      ["bom.json", "\ufeff" + definition("bom"), undefined], ["large.json", " ".repeat(1024 * 1024 + 1), undefined],
      ["encoded.json", definition("compressed"), "gzip"], ["yaml.json", "StartAt: Done\nStates: {}", undefined],
      ["missing-substitution.json", definition("${missing}"), undefined],
    ] as const) {
      await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ...(encoding ? { ContentEncoding: encoding } : {}) }));
      const created = await create(f, key.replaceAll(".", "-"), template({ DefinitionS3Location: { Bucket: bucket, Key: key }, ...(key.startsWith("missing-substitution") ? { DefinitionSubstitutions: { other: "x" } } : {}) })).catch(error => error);
      if (created.StackId) await stackStatus(f, created.StackId, "ROLLBACK_COMPLETE");
      else assert.equal(created.name, "ValidationError");
    }
    await assert.rejects(create(f, "missing", template({ DefinitionS3Location: { Bucket: bucket, Key: "absent" } })), /specified key does not exist|NoSuchKey/);
    await assert.rejects(create(f, "missing-version", template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json", Version: "missing" } })), /version|Version/);
    await assert.rejects(create(f, "conflicting", template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" }, Definition: JSON.parse(definition("conflict")) })), /exactly one/);
    const remote = new S3Client({ region: "us-west-2", endpoint: `http://127.0.0.1:${f.sim.port}`, credentials, maxAttempts: 1, forcePathStyle: true });
    try {
      await remote.send(new CreateBucketCommand({ Bucket: "sfn04-other-region", CreateBucketConfiguration: { LocationConstraint: "us-west-2" } }));
      await remote.send(new PutObjectCommand({ Bucket: "sfn04-other-region", Key: "workflow.json", Body: definition("remote") }));
      await assert.rejects(create(f, "other-region", template({ DefinitionS3Location: { Bucket: "sfn04-other-region", Key: "workflow.json" } })), /specified endpoint|Region/);
    } finally { remote.destroy(); }
    assert.equal(Object.keys(f.sim.store.regionState(region).stepFunctions.stateMachines).length, 0);
  } finally { await f.close(); }
});

test("SFN-04 asset access and PassRole use the stack execution role; failed service update is atomic", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-authorized"; await f.s3.send(new CreateBucketCommand({ Bucket: bucket })); await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("allowed") }));
    const deploymentRole = (await f.iam.send(new CreateRoleCommand({ RoleName: "sfn04-deployer", AssumeRolePolicyDocument: trust("cloudformation.amazonaws.com") }))).Role!.Arn!;
    const policy = async (denyAction: string) => f.iam.send(new PutRolePolicyCommand({ RoleName: "sfn04-deployer", PolicyName: "deploy", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }, { Effect: "Deny", Action: denyAction, Resource: "*" }] }) }));
    await policy("s3:GetObject");
    await assert.rejects(create(f, "s3-denied", template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" } }), deploymentRole), /not authorized.*s3:GetObject/);
    await policy("s3:DeleteObject");
    await f.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: deploymentRole }, Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: `arn:aws:s3:::${bucket}/*` }] }) }));
    await assert.rejects(create(f, "s3-resource-denied", template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" } }), deploymentRole), /not authorized.*s3:GetObject/);
    await f.s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    await policy("iam:PassRole");
    await create(f, "pass-denied", template({ DefinitionString: definition("denied") }), deploymentRole);
    await stackStatus(f, "pass-denied", "ROLLBACK_COMPLETE");
    assert.match(JSON.stringify((await f.cfn.send(new DescribeStackEventsCommand({ StackName: "pass-denied" }))).StackEvents), /iam:PassRole/);
    await policy("states:CreateStateMachine");
    await create(f, "create-denied", template({ DefinitionString: definition("denied") }), deploymentRole);
    await stackStatus(f, "create-denied", "ROLLBACK_COMPLETE");
    assert.match(JSON.stringify((await f.cfn.send(new DescribeStackEventsCommand({ StackName: "create-denied" }))).StackEvents), /states:CreateStateMachine/);
    assert.equal(Object.keys(f.sim.store.regionState(region).stepFunctions.stateMachines).length, 0);
    await create(f, "atomic", template({ DefinitionString: definition("original") }));
    const stack = await stackStatus(f, "atomic", "CREATE_COMPLETE"); const arn = stack.Outputs![0].OutputValue!;
    await assert.rejects(f.sfn.send(new UpdateStateMachineCommand({ stateMachineArn: arn, definition: definition("must-not-commit"), roleArn: "arn:aws:iam::000000000000:role/missing" })), /does not exist/);
    assert.equal(await run(f, arn), "original");
    await assert.rejects(f.sfn.send(new UpdateStateMachineCommand({ stateMachineArn: arn, definition: definition("must-not-commit"), loggingConfiguration: { level: "ALL" } })), /SFN-05/);
    assert.equal(await run(f, arn), "original");
  } finally { await f.close(); }
});

test("SFN-04 restart at create/update/untag/tag checkpoints reuses accepted assets and rolls back without S3", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-recovery"; await f.s3.send(new CreateBucketCommand({ Bucket: bucket })); await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("accepted") }));
    let observed: CloudFormationCheckpointObservation | undefined;
    f.sim.cloudformation.setCheckpointInterceptorForTest(value => { if (value.checkpoint === "provider:Workflow:create:attempt-1") { observed = value; return true; } return false; });
    await create(f, "recovery", template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" }, Tags: [{ Key: "remove", Value: "old" }] }));
    for (let i = 0; !observed && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert(observed);
    await f.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "workflow.json" }));
    await f.restart(); const stack = await stackStatus(f, "recovery", "CREATE_COMPLETE"); const arn = stack.Outputs![0].OutputValue!;
    assert.equal(await run(f, arn), "accepted");
    const seen: string[] = []; const phases = ["provider:Workflow:update:attempt-1", "provider:Workflow:update:attempt-2", "provider:Workflow:update:attempt-3"];
    const interceptor = (value: CloudFormationCheckpointObservation) => { if (value.checkpoint === phases[seen.length]) { seen.push(value.checkpoint); return true; } return false; };
    f.sim.cloudformation.setCheckpointInterceptorForTest(interceptor);
    await f.cfn.send(new UpdateStackCommand({ StackName: "recovery", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template({ DefinitionString: definition("updated"), Tags: [{ Key: "add", Value: "new" }] }) }));
    for (let phase = 0; phase < phases.length; phase++) {
      for (let i = 0; seen.length <= phase && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(seen.length, phase + 1); await f.restart(interceptor);
    }
    await stackStatus(f, "recovery", "UPDATE_COMPLETE"); assert.equal(await run(f, arn), "updated");
    const failed = template({ DefinitionString: definition("rollback-me") }, { Failure: { Type: "AWS::IAM::Role", DependsOn: "Workflow", Properties: { RoleName: "sfn04-conflict", AssumeRolePolicyDocument: JSON.parse(trust("states.amazonaws.com")) } } });
    await f.iam.send(new CreateRoleCommand({ RoleName: "sfn04-conflict", AssumeRolePolicyDocument: trust("states.amazonaws.com") }));
    let rollbackPaused = false;
    f.sim.cloudformation.setCheckpointInterceptorForTest(value => {
      if (!rollbackPaused && value.checkpoint.startsWith("provider:Workflow:rollback-") && value.checkpoint.endsWith(":attempt-1")) { rollbackPaused = true; return true; }
      return false;
    });
    await f.cfn.send(new UpdateStackCommand({ StackName: "recovery", Capabilities: ["CAPABILITY_NAMED_IAM"], TemplateBody: failed }));
    for (let i = 0; !rollbackPaused && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(rollbackPaused, "rollback must reach its provider checkpoint"); await f.restart();
    await stackStatus(f, "recovery", "UPDATE_ROLLBACK_COMPLETE"); assert.equal(await run(f, arn), "updated");
  } finally { await f.close(); }
});

test("SFN-04 explicit same-key unversioned redeployment plans and applies the newly accepted digest", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-republish"; await f.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const publish = (result: string) => f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition(result) }));
    await publish("v1");
    const body = template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" } });
    await create(f, "republish", body); const stack = await stackStatus(f, "republish", "CREATE_COMPLETE"); const arn = stack.Outputs![0].OutputValue!;
    await publish("v2");
    assert.equal(await run(f, arn), "v1", "changing S3 cannot mutate an accepted deployment");
    const plan = await f.cfn.send(new CreateChangeSetCommand({ StackName: "republish", ChangeSetName: "v2", ChangeSetType: "UPDATE", Capabilities: ["CAPABILITY_IAM"], TemplateBody: body }));
    const planned = await f.cfn.send(new DescribeChangeSetCommand({ ChangeSetName: plan.Id }));
    assert.equal(planned.Status, "CREATE_COMPLETE"); assert.ok(planned.Changes?.some(change => change.ResourceChange?.LogicalResourceId === "Workflow"));
    await f.cfn.send(new ExecuteChangeSetCommand({ ChangeSetName: plan.Id })); await stackStatus(f, "republish", "UPDATE_COMPLETE");
    assert.equal(await run(f, arn), "v2");
    await assert.rejects(f.cfn.send(new UpdateStackCommand({ StackName: "republish", TemplateBody: body, Capabilities: ["CAPABILITY_IAM"] })), /No updates/);
    await publish("v3");
    await f.cfn.send(new UpdateStackCommand({ StackName: "republish", TemplateBody: body, Capabilities: ["CAPABILITY_IAM"] })); await stackStatus(f, "republish", "UPDATE_COMPLETE");
    assert.equal(await run(f, arn), "v3");
  } finally { await f.close(); }
});

test("SFN-04 S3 authorization evaluates the selected version and its object tags", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-version-policy"; await f.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await f.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    const approved = await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("approved"), Tagging: "stage=approved" }));
    const denied = await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("unreviewed"), Tagging: "stage=unreviewed" }));
    const role = (await f.iam.send(new CreateRoleCommand({ RoleName: "sfn04-version-deployer", AssumeRolePolicyDocument: trust("cloudformation.amazonaws.com") }))).Role!.Arn!;
    await f.iam.send(new PutRolePolicyCommand({ RoleName: "sfn04-version-deployer", PolicyName: "deploy", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["iam:*", "states:*"], Resource: "*" },
      { Effect: "Allow", Action: "s3:GetObjectVersion", Resource: `arn:aws:s3:::${bucket}/workflow.json`, Condition: { StringEquals: { "s3:VersionId": approved.VersionId, "s3:ExistingObjectTag/stage": "approved" } } },
    ] }) }));
    const body = (Version: string) => template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json", Version } });
    await create(f, "version-allowed", body(approved.VersionId!), role);
    const created = await stackStatus(f, "version-allowed", "CREATE_COMPLETE"); assert.equal(await run(f, created.Outputs![0].OutputValue!), "approved");
    await assert.rejects(create(f, "version-denied", body(denied.VersionId!), role), /not authorized.*GetObjectVersion/);
    await f.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: role }, Action: "s3:GetObjectVersion", Resource: `arn:aws:s3:::${bucket}/*`, Condition: { StringEquals: { "s3:VersionId": approved.VersionId, "s3:ExistingObjectTag/stage": "approved" } } }] }) }));
    await assert.rejects(create(f, "tag-resource-denied", body(approved.VersionId!), role), /not authorized.*GetObjectVersion/);
  } finally { await f.close(); }
});

test("SFN-04 rejects an unversioned write between change-set validation and operation asset admission", async () => {
  const f = await fixture();
  try {
    const bucket = "sfn04-admission-race"; await f.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("reviewed") }));
    const plan = await f.cfn.send(new CreateChangeSetCommand({ StackName: "asset-race", ChangeSetName: "reviewed", ChangeSetType: "CREATE", Capabilities: ["CAPABILITY_IAM"], TemplateBody: template({ DefinitionS3Location: { Bucket: bucket, Key: "workflow.json" } }) }));
    const service = f.sim.s3; const read = service.readObjectBytes.bind(service); let overwritten = false;
    service.readObjectBytes = async (...args) => {
      const result = await read(...args);
      if (!overwritten && args[0] === bucket && args[1] === "workflow.json") {
        overwritten = true;
        await f.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "workflow.json", Body: definition("racing-write") }));
      }
      return result;
    };
    try { await assert.rejects(f.cfn.send(new ExecuteChangeSetCommand({ ChangeSetName: plan.Id })), /asset changed/); }
    finally { service.readObjectBytes = read; }
    assert(overwritten); assert.equal(Object.keys(f.sim.store.regionState(region).stepFunctions.stateMachines).length, 0);
  } finally { await f.close(); }
});

test("SFN-04 ordinary SDK tagged creates require the same TagResource authority as providers", async () => {
  const f = await fixture(); let caller: SFNClient | undefined;
  try {
    const roleArn = (await f.iam.send(new CreateRoleCommand({ RoleName: "sfn04-sdk-workflow", AssumeRolePolicyDocument: trust("states.amazonaws.com") }))).Role!.Arn!;
    await f.iam.send(new CreateUserCommand({ UserName: "sfn04-author" }));
    const key = (await f.iam.send(new CreateAccessKeyCommand({ UserName: "sfn04-author" }))).AccessKey!;
    await f.iam.send(new PutUserPolicyCommand({ UserName: "sfn04-author", PolicyName: "create", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["states:CreateStateMachine", "states:CreateActivity", "iam:PassRole"], Resource: "*" },
    ] }) }));
    caller = new SFNClient({ region, endpoint: `http://127.0.0.1:${f.sim.port}`, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! }, maxAttempts: 1 });
    const tags = [{ key: "team", value: "learning" }];
    await assert.rejects(caller.send(new CreateActivityCommand({ name: "sdk-tagged-activity", tags })), /states:TagResource/);
    await assert.rejects(caller.send(new CreateStateMachineCommand({ name: "sdk-tagged-machine", definition: definition("denied"), roleArn, tags })), /states:TagResource/);
    assert.equal(Object.keys(f.sim.store.regionState(region).stepFunctions.stateMachines).length, 0);
    assert.equal(Object.keys(f.sim.store.regionState(region).stepFunctions.activities).length, 0);
    await f.iam.send(new PutUserPolicyCommand({ UserName: "sfn04-author", PolicyName: "tag", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "states:TagResource", Resource: "*", Condition: { StringEquals: { "aws:RequestTag/team": "learning" } } }] }) }));
    await caller.send(new CreateActivityCommand({ name: "sdk-tagged-activity", tags }));
    await caller.send(new CreateStateMachineCommand({ name: "sdk-tagged-machine", definition: definition("allowed"), roleArn, tags }));
  } finally { caller?.destroy(); await f.close(); }
});
