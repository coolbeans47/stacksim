import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheckpointDurableExecutionCommand,
  CreateFunctionCommand,
  GetDurableExecutionCommand,
  GetDurableExecutionHistoryCommand,
  GetDurableExecutionStateCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  ListDurableExecutionsByFunctionCommand,
  PutFunctionEventInvokeConfigCommand,
  SendDurableExecutionCallbackFailureCommand,
  SendDurableExecutionCallbackHeartbeatCommand,
  SendDurableExecutionCallbackSuccessCommand,
  StopDurableExecutionCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CreateTableCommand, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";
import { LambdaDurableExecutions } from "../src/lambda-durable-executions.js";
import { StateStore } from "../src/state.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function active(lambda: LambdaClient, functionName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }))).State === "Active") return;
    await delay(5);
  }
  throw new Error(`Function ${functionName} did not become active`);
}

async function invoke(endpoint: string, functionName: string, qualifier: string | undefined, payload: unknown, options: { name?: string; type?: "RequestResponse" | "Event"; closeConnection?: boolean } = {}): Promise<Response> {
  const query = qualifier === undefined ? "" : `?Qualifier=${encodeURIComponent(qualifier)}`;
  return fetch(`${endpoint}/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-amz-invocation-type": options.type ?? "RequestResponse", ...(options.name ? { "x-amz-durable-execution-name": options.name } : {}), ...(options.closeConnection ? { connection: "close" } : {}) },
    body: JSON.stringify(payload),
  });
}

async function eventually<T>(read: () => T, predicate: (value: T) => boolean, progress?: () => void): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) { progress?.(); const value = read(); if (predicate(value)) return value; await delay(10); }
  throw new Error(`Condition did not become true: ${JSON.stringify(read()).slice(0, 4000)}`);
}

test("durable Lambda configuration and named invocation execute the official SDK checkpoint protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-durable-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined; let sqs: SQSClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region, credentials }); sqs = new SQSClient({ endpoint, region, credentials }); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "ordinary-handler", Runtime: "nodejs22.x", Role: role, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
    await assert.rejects(lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "ordinary-handler", DurableConfig: { ExecutionTimeout: 60 } })), (error: any) => error.name === "InvalidParameterValueException" && /only when the function is created/.test(error.message));
    await assert.rejects(lambda.send(new CreateFunctionCommand({ FunctionName: "invalid-durable", Runtime: "nodejs22.x", Role: role, Handler: "handler.durableStepHandler", Code: { ZipFile: zip }, DurableConfig: { RetentionPeriodInDays: 0 } })), (error: any) => error.name === "InvalidParameterValueException" && /RetentionPeriodInDays/.test(error.message));

    await sqs.send(new CreateQueueCommand({ QueueName: "durable-dead-letter" })); const deadLetterArn = "arn:aws:sqs:eu-west-1:000000000000:durable-dead-letter"; const created = await lambda.send(new CreateFunctionCommand({ FunctionName: "durable-handler", Runtime: "nodejs22.x", Role: role, Handler: "handler.durableStepHandler", Code: { ZipFile: zip }, Publish: true, Timeout: 5, DurableConfig: { ExecutionTimeout: 3600, RetentionPeriodInDays: 7 }, DeadLetterConfig: { TargetArn: deadLetterArn } }));
    assert.equal(created.Version, "1"); assert.deepEqual(created.DurableConfig, { ExecutionTimeout: 3600, RetentionPeriodInDays: 7 }); await active(lambda, "durable-handler");
    assert.equal((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "durable-handler" }))).DeadLetterConfig?.TargetArn, deadLetterArn); await assert.rejects(lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "durable-handler", DestinationConfig: { OnFailure: { Destination: "arn:aws:lambda:eu-west-1:000000000000:function:ordinary-handler" } } })), (error: any) => error.name === "InvalidParameterValueException" && /do not support Lambda invocation destinations/.test(error.message));
    const unqualified = await invoke(endpoint, "durable-handler", undefined, { value: 7 }); assert.equal(unqualified.status, 400); assert.match((await unqualified.json() as any).message, /qualified version/);

    const first = await invoke(endpoint, "durable-handler", "1", { value: 7 }, { name: "named-step" }); assert.equal(first.status, 200); assert.equal(first.headers.get("x-amz-executed-version"), "1"); const executionArn = first.headers.get("x-amz-durable-execution-arn")!; assert.match(executionArn, /:function:durable-handler:1\/durable-execution\/named-step\//); const result = await first.json() as any; assert.equal(result.value, 14, JSON.stringify(result)); assert.equal(result.executionArn, executionArn);
    const replay = await invoke(endpoint, "durable-handler", "1", { value: 7 }, { name: "named-step" }); assert.equal(replay.headers.get("x-amz-durable-execution-arn"), executionArn); assert.deepEqual(await replay.json(), result);
    const conflict = await invoke(endpoint, "durable-handler", "1", { value: 8 }, { name: "named-step" }); assert.equal(conflict.status, 409); assert.match((await conflict.json() as any).__type, /DurableExecutionAlreadyStartedException/);

    const execution = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: executionArn })); assert.equal(execution.Status, "SUCCEEDED"); assert.equal(execution.DurableExecutionName, "named-step"); assert.equal(execution.Version, "1"); assert.equal(execution.InputPayload, '{"value":7}'); assert.deepEqual(JSON.parse(execution.Result!), result); assert.deepEqual(execution.DurableConfig, { ExecutionTimeout: 3600, RetentionPeriodInDays: 7 }); assert.ok(execution.StartTimestamp instanceof Date); assert.ok(execution.EndTimestamp instanceof Date);
    const metadata = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: executionArn, IncludeExecutionData: false })); assert.equal(metadata.ExecutionDataIncluded, false); assert.equal(metadata.InputPayload, undefined); assert.equal(metadata.Result, undefined);
    const listed = await lambda.send(new ListDurableExecutionsByFunctionCommand({ FunctionName: "durable-handler", Qualifier: "1", DurableExecutionName: "named-step", Statuses: ["SUCCEEDED"] })); assert.equal(listed.DurableExecutions?.length, 1); assert.equal(listed.DurableExecutions?.[0].DurableExecutionArn, executionArn);
    const history = await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: executionArn })); assert.deepEqual(history.Events?.map(event => event.EventType), ["ExecutionStarted", "StepStarted", "StepSucceeded", "InvocationCompleted", "ExecutionSucceeded"]); assert.equal(history.Events?.find(event => event.EventType === "StepSucceeded")?.StepSucceededDetails?.Result?.Payload, "14");
    const historyWithoutData = await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: executionArn, IncludeExecutionData: false })); assert.equal(historyWithoutData.Events?.find(event => event.EventType === "StepSucceeded")?.StepSucceededDetails?.Result?.Payload, undefined);
  } finally { lambda?.destroy(); sqs?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("durable waits, callbacks, chained invokes, stop, pagination, restart, and retention use persisted replay state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-durable-replay-")); const clock = new TestClock(Date.parse("2026-07-16T09:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); let lambda: LambdaClient | undefined; let dynamodb: DynamoDBClient | undefined; let endpoint = "";
  const connect = () => { endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region, credentials }); dynamodb = new DynamoDBClient({ endpoint, region, credentials }); };
  const disconnect = () => { lambda?.destroy(); dynamodb?.destroy(); lambda = undefined; dynamodb = undefined; };
  const state = (arn: string) => simulator.store.regionState(region).lambdaDurableExecutions[arn];
  try {
    await simulator.start(); connect(); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await dynamodb!.send(new CreateTableCommand({ TableName: "LearningNotes", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST" }));
    const create = async (name: string, handler: string, executionTimeout = 86_400) => { await lambda!.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: role, Handler: handler, Code: { ZipFile: zip }, Publish: true, Timeout: 5, DurableConfig: { ExecutionTimeout: executionTimeout, RetentionPeriodInDays: 1 } })); await active(lambda!, name); };
    await lambda!.send(new CreateFunctionCommand({ FunctionName: "durable-child", Runtime: "nodejs22.x", Role: role, Handler: "handler.echoHandler", Code: { ZipFile: zip } })); await active(lambda!, "durable-child");
    await create("durable-wait", "handler.durableStepHandler"); await create("durable-retry", "handler.durableRetryHandler"); await create("durable-callback", "handler.durableCallbackHandler"); await create("durable-chain", "handler.durableChainedHandler"); await create("durable-failure", "handler.durableFailureHandler"); await create("durable-timeout", "handler.durableCallbackHandler", 2);

    const waitingStart = await invoke(endpoint, "durable-wait", "1", { value: 3, waitSeconds: 10 }, { name: "restart-wait", type: "Event" }); assert.equal(waitingStart.status, 202); const waitingArn = waitingStart.headers.get("x-amz-durable-execution-arn")!; clock.advance(0);
    await eventually(() => state(waitingArn), execution => execution?.operations.some(operation => operation.type === "WAIT" && operation.status === "PENDING"));
    const firstHistory = await lambda!.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: waitingArn, MaxItems: 1 })); assert.equal(firstHistory.Events?.length, 1); assert.ok(firstHistory.NextMarker); const secondHistory = await lambda!.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: waitingArn, MaxItems: 1, Marker: firstHistory.NextMarker })); assert.equal(secondHistory.Events?.length, 1);
    disconnect(); await simulator.stop(); assert.equal(state(waitingArn).status, "RUNNING", "shutdown interruption leaves the replay resumable"); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); await simulator.start(); connect(); assert.equal(state(waitingArn).status, "RUNNING"); clock.advance(10_000);
    await eventually(() => state(waitingArn), execution => execution?.status === "SUCCEEDED", () => clock.advance(0)); const waiting = await lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: waitingArn })); assert.deepEqual(JSON.parse(waiting.Result!), { value: 6, executionArn: waitingArn });

    const retryStart = await invoke(endpoint, "durable-retry", "1", { counterId: "one-retry", failAttempts: 1 }, { name: "scheduled-retry", type: "Event" }); const retryArn = retryStart.headers.get("x-amz-durable-execution-arn")!; clock.advance(0); await eventually(() => state(retryArn), execution => execution?.operations.some(operation => operation.type === "STEP" && operation.status === "PENDING")); assert.equal((await dynamodb!.send(new GetItemCommand({ TableName: "LearningNotes", Key: { id: { S: "durable-attempt#one-retry" } } }))).Item?.attempts?.N, "1"); clock.advance(1000); await eventually(() => state(retryArn), execution => execution?.status === "SUCCEEDED", () => clock.advance(0)); assert.deepEqual(JSON.parse((await lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: retryArn }))).Result!), { attempt: 2 });

    const callbackStart = await invoke(endpoint, "durable-callback", "1", { timeoutSeconds: 300, heartbeatSeconds: 30 }, { name: "callback-success", type: "Event" }); const callbackArn = callbackStart.headers.get("x-amz-durable-execution-arn")!; clock.advance(0); await eventually(() => state(callbackArn), execution => execution?.operations.some(operation => operation.type === "CALLBACK" && operation.status === "PENDING"));
    const callbackHistory = await lambda!.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: callbackArn })); const callbackId = callbackHistory.Events?.find(event => event.EventType === "CallbackStarted")?.CallbackStartedDetails?.CallbackId!; assert.ok(callbackId);
    const checkpointToken = state(callbackArn).checkpointToken; const statePage = await lambda!.send(new GetDurableExecutionStateCommand({ DurableExecutionArn: callbackArn, CheckpointToken: checkpointToken, MaxItems: 1 })); assert.equal(statePage.Operations?.length, 1); assert.ok(statePage.NextMarker); assert.equal((await lambda!.send(new GetDurableExecutionStateCommand({ DurableExecutionArn: callbackArn, CheckpointToken: checkpointToken, MaxItems: 1, Marker: statePage.NextMarker }))).Operations?.length, 1);
    const checkpoint = new CheckpointDurableExecutionCommand({ DurableExecutionArn: callbackArn, CheckpointToken: checkpointToken, ClientToken: "same-checkpoint" }); const firstCheckpoint = await lambda!.send(checkpoint); const duplicateCheckpoint = await lambda!.send(checkpoint); assert.equal(duplicateCheckpoint.CheckpointToken, firstCheckpoint.CheckpointToken); await assert.rejects(lambda!.send(new CheckpointDurableExecutionCommand({ DurableExecutionArn: callbackArn, CheckpointToken: checkpointToken, ClientToken: "same-checkpoint", Updates: [{ Id: "conflict", Type: "WAIT", Action: "START", WaitOptions: { WaitSeconds: 1 } }] })), (error: any) => error.name === "ResourceConflictException" && /ClientToken/.test(error.message));
    await lambda!.send(new SendDurableExecutionCallbackHeartbeatCommand({ CallbackId: callbackId })); await lambda!.send(new SendDurableExecutionCallbackSuccessCommand({ CallbackId: callbackId, Result: Buffer.from("approved") }));
    await eventually(() => state(callbackArn), execution => execution?.status === "SUCCEEDED", () => clock.advance(0)); assert.deepEqual(JSON.parse((await lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: callbackArn }))).Result!), { callbackId, result: "approved" }); await assert.rejects(lambda!.send(new SendDurableExecutionCallbackHeartbeatCommand({ CallbackId: callbackId })), (error: any) => error.name === "CallbackTimeoutException");

    const callbackFailureStart = await invoke(endpoint, "durable-callback", "1", { timeoutSeconds: 300 }, { name: "callback-failure", type: "Event" }); const callbackFailureArn = callbackFailureStart.headers.get("x-amz-durable-execution-arn")!; clock.advance(0); await eventually(() => state(callbackFailureArn), execution => execution?.operations.some(operation => operation.type === "CALLBACK" && operation.status === "PENDING")); const callbackFailureHistory = await lambda!.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: callbackFailureArn })); const failureCallbackId = callbackFailureHistory.Events?.find(event => event.EventType === "CallbackStarted")?.CallbackStartedDetails?.CallbackId!; await lambda!.send(new SendDurableExecutionCallbackFailureCommand({ CallbackId: failureCallbackId, Error: { ErrorType: "ExternalRejected", ErrorMessage: "approval denied" } })); await eventually(() => state(callbackFailureArn), execution => execution?.status === "FAILED", () => clock.advance(0)); assert.match((await lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: callbackFailureArn }))).Error?.ErrorMessage ?? "", /approval denied/);

    const timeoutStart = await invoke(endpoint, "durable-timeout", "1", { timeoutSeconds: 300 }, { name: "execution-timeout", type: "Event" }); const timeoutArn = timeoutStart.headers.get("x-amz-durable-execution-arn")!; clock.advance(0); await eventually(() => state(timeoutArn), execution => execution?.operations.some(operation => operation.type === "CALLBACK" && operation.status === "PENDING")); const timeoutCallbackId = (await lambda!.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: timeoutArn }))).Events?.find(event => event.EventType === "CallbackStarted")?.CallbackStartedDetails?.CallbackId!; clock.advance(2000); assert.equal(state(timeoutArn).status, "TIMED_OUT"); await assert.rejects(lambda!.send(new SendDurableExecutionCallbackHeartbeatCommand({ CallbackId: timeoutCallbackId })), (error: any) => error.name === "CallbackTimeoutException");

    const chained = await invoke(endpoint, "durable-chain", "1", { functionName: "durable-child", payload: { nested: true } }, { name: "chain-once" }); const chainedArn = chained.headers.get("x-amz-durable-execution-arn")!; assert.deepEqual(await chained.json(), { result: { nested: true } }); assert.equal((await lambda!.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: chainedArn }))).Events?.filter(event => event.EventType === "ChainedInvokeStarted").length, 1);
    const failed = await invoke(endpoint, "durable-failure", "1", { message: "durable boom" }, { name: "expected-failure" }); assert.equal(failed.headers.get("x-amz-function-error"), "Unhandled"); const failedArn = failed.headers.get("x-amz-durable-execution-arn")!; const failure = await lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: failedArn })); assert.equal(failure.Status, "FAILED"); assert.match(failure.Error?.ErrorMessage ?? "", /durable boom/);

    const stopStart = await invoke(endpoint, "durable-callback", "1", { timeoutSeconds: 300 }, { name: "stop-running", type: "Event" }); const stopArn = stopStart.headers.get("x-amz-durable-execution-arn")!; clock.advance(0); await eventually(() => state(stopArn), execution => execution?.operations.some(operation => operation.type === "CALLBACK" && operation.status === "PENDING")); const stopped = await lambda!.send(new StopDurableExecutionCommand({ DurableExecutionArn: stopArn, Error: { ErrorType: "CancelledByTest", ErrorMessage: "test stop" } })); assert.ok(stopped.StopTimestamp instanceof Date); assert.equal((await lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: stopArn }))).Status, "STOPPED"); await assert.rejects(lambda!.send(new StopDurableExecutionCommand({ DurableExecutionArn: stopArn })), (error: any) => error.name === "ResourceConflictException");

    clock.advance(86_400_000); await assert.rejects(lambda!.send(new GetDurableExecutionCommand({ DurableExecutionArn: waitingArn })), (error: any) => error.name === "ResourceNotFoundException", "terminal execution data expires after configured retention");
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test("durable shutdown drains an already-running direct replay before state handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-durable-drain-"));
  const store = new StateStore(root, "000000000000", region);
  const clock = new TestClock(Date.parse("2026-07-16T09:00:00Z"));
  let releaseReplay: () => void = () => undefined;
  const replayGate = new Promise<void>(resolve => { releaseReplay = resolve; });
  let replayStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => { replayStarted = resolve; });
  const durable = new LambdaDurableExecutions(store, region, clock, undefined, {
    invokeExecution: async () => {
      replayStarted();
      await replayGate;
      return { payload: Buffer.from('{"Status":"PENDING"}'), requestId: "drain-replay", durationMs: 1, billedDurationMs: 1, executedVersion: "1" };
    },
    invokeChained: async () => { throw new Error("not used"); },
    deliverDeadLetter: async () => undefined,
    terminateExecution: () => undefined,
  });
  try {
    await store.load();
    durable.start();
    const { execution } = await durable.create({
      functionName: "durable-drain",
      functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:durable-drain:1",
      requestedQualifier: "1",
      executedVersion: "1",
      executable: { durableConfig: { executionTimeout: 3_600, retentionPeriodInDays: 1 } } as any,
      invocationType: "Event",
      payload: Buffer.from("{}"),
    });
    const running = durable.run(execution.durableExecutionArn);
    await started;

    durable.shutdown();
    let drained = false;
    const draining = durable.flush().then(() => { drained = true; });
    await delay(0);
    assert.equal(drained, false, "flush waits for an active replay callback");

    releaseReplay();
    await Promise.all([draining, running]);
    assert.equal(drained, true);
    await store.flush();
  } finally {
    durable.shutdown();
    releaseReplay();
    await durable.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("synchronous durable shutdown returns an interrupted replay without waiting for the function timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-durable-sync-stop-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let lambda: LambdaClient | undefined;
  let stopped = false;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    lambda = new LambdaClient({ endpoint, region, credentials });
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    for (const [name, handler] of [["durable-pending", "handler.durableCallbackHandler"], ["durable-blocking", "handler.timeoutHandler"]]) {
      await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: role, Handler: handler, Code: { ZipFile: zip }, Publish: true, Timeout: 5, DurableConfig: { ExecutionTimeout: 3_600, RetentionPeriodInDays: 1 } }));
      await active(lambda, name);
    }

    const pendingCallback = invoke(endpoint, "durable-pending", "1", { timeoutSeconds: 300 }, { name: "shutdown-pending-callback", closeConnection: true });
    await eventually(() => Object.values(simulator.store.regionState(region).lambdaDurableExecutions).find(item => item.durableExecutionName === "shutdown-pending-callback"), execution => Boolean(execution?.operations.some(operation => operation.type === "CALLBACK" && operation.status === "PENDING")));
    await eventually(() => (simulator.lambda as any).activeDurableChildren.size as number, size => size === 0);
    const invocation = invoke(endpoint, "durable-blocking", "1", {}, { name: "shutdown-interruption", closeConnection: true });
    await eventually(() => (simulator.lambda as any).activeDurableChildren.size as number, size => size > 0);
    const stopping = simulator.stop().then(() => { stopped = true; });
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopping,
        new Promise<never>((_resolve, reject) => { stopTimer = setTimeout(() => reject(new Error("synchronous durable shutdown waited for the function timeout")), 2_000); }),
      ]);
    } finally { if (stopTimer) clearTimeout(stopTimer); }

    for (const response of await Promise.all([pendingCallback, invocation])) { assert.equal(response.status, 200); assert.equal(await response.json(), null); }
    const executions = Object.values(simulator.store.regionState(region).lambdaDurableExecutions);
    assert.equal(executions.find(item => item.durableExecutionName === "shutdown-interruption")?.status, "RUNNING", "the interrupted synchronous replay remains restartable");
    assert.equal(executions.find(item => item.durableExecutionName === "shutdown-pending-callback")?.status, "RUNNING", "a request waiting on persisted durable state is released without terminating the execution");
  } finally {
    lambda?.destroy();
    if (!stopped) await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("durable runtime checkpoints require the execution-role managed policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-durable-iam-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const lambda = new LambdaClient({ endpoint, region, credentials }); const iam = new IAMClient({ endpoint, region, credentials }); clients.push(lambda, iam); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); const createdRole = await iam.send(new CreateRoleCommand({ RoleName: "durable-runtime", AssumeRolePolicyDocument: trust })); const roleArn = createdRole.Role!.Arn!; await iam.send(new AttachRolePolicyCommand({ RoleName: "durable-runtime", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "durable-iam", Runtime: "nodejs22.x", Role: roleArn, Handler: "handler.durableStepHandler", Code: { ZipFile: zip }, Publish: true, Timeout: 5, DurableConfig: { ExecutionTimeout: 3600 } })); await active(lambda, "durable-iam");
    const denied = await lambda.send(new InvokeCommand({ FunctionName: "durable-iam", Qualifier: "1", DurableExecutionName: "missing-checkpoint-policy", Payload: Buffer.from('{"value":2}') })); assert.equal(denied.FunctionError, "Unhandled"); assert.ok(denied.DurableExecutionArn); const deniedExecution = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: denied.DurableExecutionArn! })); assert.equal(deniedExecution.Status, "FAILED"); assert.match(deniedExecution.Error?.ErrorMessage ?? "", /Checkpoint|not authorized/i);
    await iam.send(new AttachRolePolicyCommand({ RoleName: "durable-runtime", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy" })); const allowed = await lambda.send(new InvokeCommand({ FunctionName: "durable-iam", Qualifier: "1", DurableExecutionName: "with-checkpoint-policy", Payload: Buffer.from('{"value":2}') })); assert.equal(allowed.FunctionError, undefined); assert.equal(JSON.parse(Buffer.from(allowed.Payload ?? []).toString("utf8")).value, 4); assert.equal((await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: allowed.DurableExecutionArn! }))).Status, "SUCCEEDED");
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "lambda:CheckpointDurableExecution" && decision.decision !== "allowed")); assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "lambda:CheckpointDurableExecution" && decision.decision === "allowed"));
  } finally { for (const client of clients) client.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
