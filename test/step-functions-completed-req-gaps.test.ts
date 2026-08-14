import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EventBridgeClient, PutEventsCommand, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CreateAccessKeyCommand, CreateRoleCommand, CreateUserCommand, IAMClient, PutRolePolicyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateActivityCommand,
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  GetActivityTaskCommand,
  ListTagsForResourceCommand,
  SFNClient,
  SendTaskSuccessCommand,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { CreateQueueCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const active: Array<{ simulator: StackSim; root: string; clients: Array<{ destroy(): void }> }> = [];
const region = "eu-west-1";

async function harness(clock = new TestClock(Date.parse("2026-08-12T12:00:00Z")), authMode: "off" | "enforce" = "off", random: () => number = () => 0.5) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sfn-gaps-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode, cdkBootstrap: authMode === "enforce", random });
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
  const sfn = new SFNClient(options); const iam = new IAMClient(options); const lambda = new LambdaClient(options);
  const record: { simulator: StackSim; root: string; clients: Array<{ destroy(): void }> } = { simulator, root, clients: [sfn, iam, lambda] }; active.push(record);
  const workflow = await iam.send(new CreateRoleCommand({ RoleName: "gap-workflow", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const target = await iam.send(new CreateRoleCommand({ RoleName: "gap-target", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  return { simulator, record, root, options, clock, sfn, iam, lambda, workflowRoleArn: workflow.Role!.Arn!, targetRoleArn: target.Role!.Arn! };
}

afterEach(async () => {
  while (active.length) {
    const item = active.pop()!; item.clients.forEach(client => client.destroy());
    await item.simulator.stop().catch(() => undefined); await rm(item.root, { recursive: true, force: true });
  }
});

async function terminal(sfn: SFNClient, arn: string): Promise<any> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
    if (execution.status !== "RUNNING") return execution;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Execution did not finish");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Condition was not observed");
}

test("CreateStateMachine replay ignores role and tags without mutating the original", async () => {
  const h = await harness();
  const alternate = await h.iam.send(new CreateRoleCommand({ RoleName: "gap-alternate", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const definition = JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } });
  const created = await h.sfn.send(new CreateStateMachineCommand({ name: "idempotent-fields", definition, roleArn: h.workflowRoleArn, tags: [{ key: "owner", value: "original" }] }));
  const replayed = await h.sfn.send(new CreateStateMachineCommand({ name: "idempotent-fields", definition, roleArn: alternate.Role!.Arn!, tags: [{ key: "owner", value: "replay" }] }));
  assert.equal(replayed.stateMachineArn, created.stateMachineArn); assert.equal(replayed.creationDate?.getTime(), created.creationDate?.getTime());
  assert.equal((await h.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: created.stateMachineArn! }))).roleArn, h.workflowRoleArn);
  assert.deepEqual((await h.sfn.send(new ListTagsForResourceCommand({ resourceArn: created.stateMachineArn! }))).tags, [{ key: "owner", value: "original" }]);
  await assert.rejects(h.sfn.send(new CreateStateMachineCommand({ name: "idempotent-fields", definition: JSON.stringify({ StartAt: "Other", States: { Other: { Type: "Succeed" } } }), roleArn: h.workflowRoleArn })), (error: any) => error.name === "StateMachineAlreadyExists");
});

test("Lambda retries remain one state visit and use Lambda attempt history", async () => {
  const h = await harness();
  const fn = await h.lambda.send(new CreateFunctionCommand({ FunctionName: "retry-history", Runtime: "nodejs22.x", Handler: "index.handler", Role: h.targetRoleArn, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async event => event;" }]) } }));
  const original = h.simulator.lambda.invoke.bind(h.simulator.lambda); let calls = 0;
  (h.simulator.lambda as any).invoke = async (...args: any[]) => { calls++; if (calls === 1) throw new Error("retry once"); return (original as any)(...args); };
  const definition = JSON.stringify({ StartAt: "Invoke", States: { Invoke: { Type: "Task", Resource: fn.FunctionArn, HeartbeatSeconds: 1, TimeoutSeconds: 100, Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 1 }], End: true } } });
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "retry-history", definition, roleArn: h.workflowRoleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, input: JSON.stringify({ ok: true }) }));
  await waitFor(() => h.simulator.store.regionState(region).stepFunctions.executions[started.executionArn!]?.waitingKind === "RETRY"); h.clock.advance(2_000);
  const completed = await terminal(h.sfn, started.executionArn!); assert.equal(completed.status, "SUCCEEDED", JSON.stringify(completed)); assert.equal(calls, 2);
  const history = (await h.sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn!, maxResults: 1000 }))).events ?? [];
  const count = (type: string) => history.filter(event => event.type === type).length;
  assert.equal(count("TaskStateEntered"), 1); assert.equal(count("TaskStateExited"), 1);
  assert.equal(count("LambdaFunctionScheduled"), 2); assert.equal(count("LambdaFunctionStarted"), 2);
  assert.equal(count("LambdaFunctionFailed"), 1); assert.equal(count("TaskFailed"), 0); assert.equal(count("LambdaFunctionSucceeded"), 1);
});

test("HeartbeatSeconds does not time out an in-flight synchronous Lambda invocation", async () => {
  const h = await harness();
  const fn = await h.lambda.send(new CreateFunctionCommand({ FunctionName: "heartbeat-sync", Runtime: "nodejs22.x", Handler: "index.handler", Role: h.targetRoleArn, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async event => event;" }]) } }));
  const original = h.simulator.lambda.invoke.bind(h.simulator.lambda); let entered!: () => void; const invoked = new Promise<void>(resolve => { entered = resolve; }); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  (h.simulator.lambda as any).invoke = async (...args: any[]) => { entered(); await gate; return (original as any)(...args); };
  const definition = JSON.stringify({ StartAt: "Invoke", States: { Invoke: { Type: "Task", Resource: fn.FunctionArn, HeartbeatSeconds: 1, TimeoutSeconds: 100, End: true } } });
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "heartbeat-sync", definition, roleArn: h.workflowRoleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! })); await invoked;
  h.clock.advance(5_000); await new Promise(resolve => setImmediate(resolve)); assert.equal((await h.sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn! }))).status, "RUNNING");
  release(); assert.equal((await terminal(h.sfn, started.executionArn!)).status, "SUCCEEDED");
});

test("retry backoff, max delay, full jitter, and restart deadline are deterministic", async () => {
  const h = await harness();
  const fn = await h.lambda.send(new CreateFunctionCommand({ FunctionName: "retry-timing", Runtime: "nodejs22.x", Handler: "index.handler", Role: h.targetRoleArn, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async event => event;" }]) } }));
  const invokedAt: number[] = [];
  const installFailures = (simulator: StackSim) => {
    const original = simulator.lambda.invoke.bind(simulator.lambda);
    (simulator.lambda as any).invoke = async (...args: any[]) => { invokedAt.push(h.clock.now()); if (invokedAt.length <= 3) throw new Error(`retry ${invokedAt.length}`); return (original as any)(...args); };
  };
  installFailures(h.simulator);
  const definition = JSON.stringify({ StartAt: "Invoke", States: { Invoke: { Type: "Task", Resource: fn.FunctionArn, TimeoutSeconds: 100, Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 4, BackoffRate: 3, MaxDelaySeconds: 5, JitterStrategy: "FULL", MaxAttempts: 3 }], End: true } } });
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "retry-timing", definition, roleArn: h.workflowRoleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! })); await waitFor(() => invokedAt.length === 1);
  const start = invokedAt[0]; h.sfn.destroy(); h.iam.destroy(); h.lambda.destroy(); await h.simulator.stop();
  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock: h.clock, authMode: "off", cdkBootstrap: false, random: () => 0.5 }); installFailures(restarted); await restarted.start(); h.record.simulator = restarted;
  const sfn = new SFNClient({ endpoint: `http://127.0.0.1:${restarted.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); h.record.clients.push(sfn);
  h.clock.advance(1_999); await new Promise(resolve => setImmediate(resolve)); assert.equal(invokedAt.length, 1);
  h.clock.advance(1); await waitFor(() => invokedAt.length === 2); assert.equal(invokedAt[1] - start, 2_000, "first full-jitter delay is 4s × 0.5");
  h.clock.advance(2_499); await new Promise(resolve => setImmediate(resolve)); assert.equal(invokedAt.length, 2);
  h.clock.advance(1); await waitFor(() => invokedAt.length === 3); assert.equal(invokedAt[2] - invokedAt[1], 2_500, "backoff is capped at 5s before full jitter");
  h.clock.advance(2_500); const completed = await terminal(sfn, started.executionArn!); assert.equal(completed.status, "SUCCEEDED", JSON.stringify(completed)); assert.equal(invokedAt[3] - invokedAt[2], 2_500);
  const history = (await sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn!, maxResults: 1000 }))).events ?? [];
  assert.equal(history.filter(event => event.type === "TaskStateEntered").length, 1); assert.equal(history.filter(event => event.type === "LambdaFunctionFailed").length, 3);
});

test("bare Fail omits invented terminal fields and terminal executions publish ExecutionTime", async () => {
  const h = await harness();
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "bare-fail", definition: JSON.stringify({ StartAt: "Stop", States: { Stop: { Type: "Fail" } } }), roleArn: h.workflowRoleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! }));
  const completed = await terminal(h.sfn, started.executionArn!); assert.equal(completed.status, "FAILED"); assert.equal(completed.error, undefined); assert.equal(completed.cause, undefined);
  const history = (await h.sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn! }))).events ?? [];
  const details = history.find(event => event.type === "ExecutionFailed")?.executionFailedEventDetails;
  assert.equal(details?.error, undefined); assert.equal(details?.cause, undefined);
  await new Promise(resolve => setImmediate(resolve));
  const metrics = await h.simulator.metrics.ListMetrics({ Namespace: "AWS/States", Dimensions: [{ Name: "StateMachineArn", Value: machine.stateMachineArn }] });
  assert(metrics.Metrics.some((metric: any) => metric.MetricName === "ExecutionTime"));
});

test("enforce mode requires the caller action and iam:PassRole for state-machine creation", async () => {
  const h = await harness(new TestClock(Date.now()), "enforce");
  await h.iam.send(new CreateUserCommand({ UserName: "workflow-author" }));
  const key = (await h.iam.send(new CreateAccessKeyCommand({ UserName: "workflow-author" }))).AccessKey!;
  const delegated = new SFNClient({ endpoint: `http://127.0.0.1:${h.simulator.port}`, region, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } }); active.at(-1)!.clients.push(delegated);
  const definition = JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } });
  const input = { name: "caller-boundary", definition, roleArn: h.workflowRoleArn };
  await assert.rejects(delegated.send(new CreateStateMachineCommand(input)), (error: any) => error.name === "AccessDeniedException" && /states:CreateStateMachine/i.test(error.message));
  await h.iam.send(new PutUserPolicyCommand({ UserName: "workflow-author", PolicyName: "CreateOnly", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "states:CreateStateMachine", Resource: "*" }] }) }));
  await assert.rejects(delegated.send(new CreateStateMachineCommand(input)), (error: any) => error.name === "AccessDeniedException" && /iam:PassRole/i.test(error.message));
  await h.iam.send(new PutUserPolicyCommand({ UserName: "workflow-author", PolicyName: "CreateOnly", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "states:CreateStateMachine", Resource: "*" }, { Effect: "Allow", Action: "iam:PassRole", Resource: h.workflowRoleArn, Condition: { StringEquals: { "iam:PassedToService": "states.amazonaws.com" } } }] }) }));
  assert.equal((await delegated.send(new CreateStateMachineCommand(input))).stateMachineArn, `arn:aws:states:${region}:000000000000:stateMachine:caller-boundary`);
  const untrusted = await h.iam.send(new CreateRoleCommand({ RoleName: "untrusted-workflow-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  await h.iam.send(new PutUserPolicyCommand({ UserName: "workflow-author", PolicyName: "CreateOnly", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "states:CreateStateMachine", Resource: "*" }, { Effect: "Allow", Action: "iam:PassRole", Resource: [h.workflowRoleArn, untrusted.Role!.Arn!], Condition: { StringEquals: { "iam:PassedToService": "states.amazonaws.com" } } }] }) }));
  await assert.rejects(delegated.send(new CreateStateMachineCommand({ ...input, name: "untrusted-role", roleArn: untrusted.Role!.Arn! })), (error: any) => error.name === "AccessDeniedException" && /cannot be assumed/i.test(error.message));
});

test("an expired Activity lease is reclaimed after restart", async () => {
  const h = await harness();
  const activity = await h.sfn.send(new CreateActivityCommand({ name: "lease-reclaim" }));
  const definition = JSON.stringify({ StartAt: "Work", States: { Work: { Type: "Task", Resource: activity.activityArn, TimeoutSeconds: 300, End: true } } });
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "lease-reclaim", definition, roleArn: h.workflowRoleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, input: JSON.stringify({ job: 1 }) }));
  await waitFor(() => Object.values(h.simulator.store.regionState(region).stepFunctions.executions).some(execution => Object.values(execution.callbackTasks ?? {}).some(task => task.kind === "ACTIVITY" && task.status === "PENDING")));
  const first = await h.sfn.send(new GetActivityTaskCommand({ activityArn: activity.activityArn!, workerName: "worker-one" })); assert(first.taskToken);
  h.sfn.destroy(); h.iam.destroy(); h.lambda.destroy(); await h.simulator.stop(); h.clock.advance(61_000);
  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock: h.clock, authMode: "off", cdkBootstrap: false }); await restarted.start(); h.record.simulator = restarted;
  const sfn = new SFNClient({ endpoint: `http://127.0.0.1:${restarted.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); h.record.clients.push(sfn);
  const reclaimed = await sfn.send(new GetActivityTaskCommand({ activityArn: activity.activityArn!, workerName: "worker-two" })); assert.equal(reclaimed.taskToken, first.taskToken);
  await sfn.send(new SendTaskSuccessCommand({ taskToken: reclaimed.taskToken!, output: JSON.stringify({ completed: true }) }));
  assert.equal((await terminal(sfn, started.executionArn!)).status, "SUCCEEDED");
});

test("an admitted nested sync task observes a later execution-role deny", async () => {
  const h = await harness(new TestClock(Date.now()), "enforce");
  const child = await h.sfn.send(new CreateStateMachineCommand({ name: "midflight-child", roleArn: h.workflowRoleArn, definition: JSON.stringify({ StartAt: "Pause", States: { Pause: { Type: "Wait", Seconds: 30, Next: "Done" }, Done: { Type: "Succeed" } } }) }));
  const role = await h.iam.send(new CreateRoleCommand({ RoleName: "midflight-parent-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const childExecutionArn = `arn:aws:states:${region}:000000000000:execution:midflight-child:*`;
  const policy = (denyDescribe = false) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "states:StartExecution", Resource: child.stateMachineArn }, { Effect: "Allow", Action: ["states:DescribeExecution", "states:StopExecution"], Resource: childExecutionArn }, ...(denyDescribe ? [{ Effect: "Deny", Action: "states:DescribeExecution", Resource: childExecutionArn }] : [])] });
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "midflight-parent-role", PolicyName: "nested", PolicyDocument: policy() }));
  const definition = JSON.stringify({ StartAt: "Child", States: { Child: { Type: "Task", Resource: "arn:aws:states:::states:startExecution.sync", Parameters: { StateMachineArn: child.stateMachineArn }, Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.caught", Next: "Handled" }], End: true }, Handled: { Type: "Pass", End: true } } });
  const parent = await h.sfn.send(new CreateStateMachineCommand({ name: "midflight-parent", roleArn: role.Role!.Arn!, definition }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: parent.stateMachineArn!, input: "{}" }));
  await waitFor(() => Boolean(h.simulator.store.regionState(region).stepFunctions.executions[started.executionArn!]?.nestedExecutions && Object.keys(h.simulator.store.regionState(region).stepFunctions.executions[started.executionArn!].nestedExecutions!).length));
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "midflight-parent-role", PolicyName: "nested", PolicyDocument: policy(true) })); h.clock.advance(1_000);
  const completed = await terminal(h.sfn, started.executionArn!); assert.equal(completed.status, "SUCCEEDED", JSON.stringify(completed)); assert.match(JSON.parse(completed.output).caught.Error, /AccessDenied/i);
});

test("an EventBridge Step Functions producer records retry exhaustion and sends its DLQ event", async () => {
  const h = await harness(); const events = new EventBridgeClient(h.options); const sqs = new SQSClient(h.options); h.record.clients.push(events, sqs);
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "producer-exhaustion", roleArn: h.workflowRoleArn, definition: JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } }) }));
  const producerRole = await h.iam.send(new CreateRoleCommand({ RoleName: "producer-exhaustion-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "producer-exhaustion-dlq" }))).QueueUrl!; const dlqArn = `arn:aws:sqs:${region}:000000000000:producer-exhaustion-dlq`;
  await events.send(new PutRuleCommand({ Name: "producer-exhaustion", EventPattern: JSON.stringify({ source: ["gap.producer"] }) }));
  const ruleArn = `arn:aws:events:${region}:000000000000:rule/producer-exhaustion`; await sqs.send(new SetQueueAttributesCommand({ QueueUrl: dlqUrl, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: dlqArn, Condition: { ArnEquals: { "aws:SourceArn": ruleArn } } }] }) } }));
  await events.send(new PutTargetsCommand({ Rule: "producer-exhaustion", Targets: [{ Id: "workflow", Arn: machine.stateMachineArn!, RoleArn: producerRole.Role!.Arn!, DeadLetterConfig: { Arn: dlqArn }, RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 } }] }));
  await h.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: machine.stateMachineArn! }));
  await events.send(new PutEventsCommand({ Entries: [{ Source: "gap.producer", DetailType: "Exhaust", Detail: JSON.stringify({ id: 7 }) }] }));
  let deadLetter: any;
  for (let attempt = 0; attempt < 100 && !deadLetter; attempt++) { h.clock.advance(1_000); await new Promise(resolve => setImmediate(resolve)); deadLetter = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 0, MessageAttributeNames: ["All"] }))).Messages?.[0]; }
  assert(deadLetter, "producer terminal failure reaches the configured DLQ"); assert.equal(deadLetter.MessageAttributes?.TARGET_ARN.StringValue, machine.stateMachineArn); assert.equal(deadLetter.MessageAttributes?.EXHAUSTED_RETRY_CONDITION.StringValue, "MaximumRetryAttempts");
  const journal = await readFile(join(h.root, "data", "eventbridge", "000000000000", region, "deliveries.jsonl"), "utf8"); assert(journal.split(/\r?\n/).some(line => line.includes(machine.stateMachineArn!) && line.includes('"status":"FAILED"') && line.includes('"deadLetterStatus":"SENT"')));
});
