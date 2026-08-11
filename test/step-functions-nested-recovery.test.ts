import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateStateMachineCommand, DescribeExecutionCommand, GetExecutionHistoryCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function clients(simulator: StackSim) {
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
  return { sfn: new SFNClient(options), iam: new IAMClient(options), lambda: new LambdaClient(options) };
}

async function rolesAndFunction(simulator: StackSim, output: string, delayMs: number) {
  const api = clients(simulator);
  const workflow = await api.iam.send(new CreateRoleCommand({ RoleName: "dug04-workflow", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const lambdaRole = await api.iam.send(new CreateRoleCommand({ RoleName: "dug04-lambda", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const code = createZip([{ name: "index.js", content: `const { appendFileSync } = require("node:fs"); exports.handler = async event => { appendFileSync(process.env.OUT, String(event.id) + "\\n"); await new Promise(resolve => setTimeout(resolve, ${delayMs})); return { id: event.id }; };` }]);
  const fn = await api.lambda.send(new CreateFunctionCommand({ FunctionName: "dug04-worker", Runtime: "nodejs22.x", Handler: "index.handler", Role: lambdaRole.Role!.Arn!, Environment: { Variables: { OUT: output } }, Code: { ZipFile: code } }));
  return { ...api, workflowRoleArn: workflow.Role!.Arn!, functionArn: fn.FunctionArn! };
}

async function terminal(sfn: SFNClient, executionArn: string, tick?: () => void) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (execution.status !== "RUNNING") return execution;
    tick?.();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("execution did not become terminal");
}

async function waitFor(description: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`timed out waiting for ${description}`);
}

async function lines(path: string): Promise<string[]> { try { return (await readFile(path, "utf8")).trim().split(/\r?\n/).filter(Boolean); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; } }

test("DUG-04 Inline Map resumes only unfinished items and never repeats a completed Lambda task", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug04-map-")); const output = join(root, "side-effects.txt"); const clock = new TestClock(Date.parse("2026-08-03T12:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: false, stepFunctionsMaximumMapConcurrency: 2 }); let api: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); const created = await rolesAndFunction(simulator, output, 0); api = created;
    const definition = JSON.stringify({ StartAt: "Items", States: { Items: { Type: "Map", ItemsPath: "$", MaxConcurrency: 2, ItemSelector: { "id.$": "$$.Map.Item.Value" }, ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Invoke", States: { Invoke: { Type: "Task", Resource: created.functionArn, Next: "Cooldown" }, Cooldown: { Type: "Wait", Seconds: 1, End: true } } }, End: true } } });
    const machine = await created.sfn.send(new CreateStateMachineCommand({ name: "dug04-map-recovery", definition, roleArn: created.workflowRoleArn }));
    const started = await created.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, name: "restart", input: JSON.stringify([0, 1, 2, 3, 4, 5]) }));
    await waitFor("the admitted Map window to reach its durable waits", async () => simulator.store.regionState(region).stepFunctions.executions[started.executionArn!]?.nested?.children.filter(child => child.status === "WAITING").length === 2 && (await lines(output)).length === 2);
    assert.equal((await lines(output)).length, 2, "only the admitted MaxConcurrency window starts before shutdown");
    created.sfn.destroy(); created.iam.destroy(); created.lambda.destroy(); api = undefined; await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: false, stepFunctionsMaximumMapConcurrency: 2 }); await simulator.start(); api = clients(simulator);
    const completed = await terminal(api.sfn, started.executionArn!, () => clock.advance(1_000)); assert.equal(completed.status, "SUCCEEDED", JSON.stringify(completed));
    const ordered = JSON.parse(completed.output!); assert.deepEqual(ordered.map((item: any) => item.id), [0, 1, 2, 3, 4, 5], "Map output retains input order across recovery");
    assert.deepEqual((await lines(output)).sort(), ["0", "1", "2", "3", "4", "5"], "accepted side effects are not invoked twice and pending items resume");
    const history = (await api.sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn!, maxResults: 1000 }))).events ?? [];
    assert.deepEqual(history.filter(event => event.type === "MapIterationStarted").map(event => event.mapIterationStartedEventDetails?.index), [0, 1, 2, 3, 4, 5]);
    const journals = Object.values(simulator.store.regionState(region).stepFunctions.executions[started.executionArn!].taskJournal ?? {}); assert.equal(journals.length, 6); assert.equal(new Set(journals.map(item => item.taskId)).size, 6, "every admitted task has one stable handoff ID");
  } finally {
    api?.sfn.destroy(); api?.iam.destroy(); api?.lambda.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-04 StopExecution cancels nested waits and prevents new Map admissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug04-stop-")); const output = join(root, "side-effects.txt"); const clock = new TestClock(Date.parse("2026-08-03T12:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: false, stepFunctionsMaximumMapConcurrency: 2 }); let api: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); const created = await rolesAndFunction(simulator, output, 0); api = created;
    const definition = JSON.stringify({ StartAt: "Items", States: { Items: { Type: "Map", ItemsPath: "$", MaxConcurrency: 2, ItemSelector: { "id.$": "$$.Map.Item.Value" }, ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Wait", States: { Wait: { Type: "Wait", Seconds: 60, Next: "Invoke" }, Invoke: { Type: "Task", Resource: created.functionArn, End: true } } }, End: true } } });
    const machine = await created.sfn.send(new CreateStateMachineCommand({ name: "dug04-map-stop", definition, roleArn: created.workflowRoleArn })); const started = await created.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, input: JSON.stringify([0, 1, 2, 3]) }));
    for (let attempt = 0; attempt < 100 && simulator.store.regionState(region).stepFunctions.executions[started.executionArn!]?.nested?.children.filter(child => child.status === "WAITING").length !== 2; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    await created.sfn.send(new StopExecutionCommand({ executionArn: started.executionArn!, error: "Stopped", cause: "test cancellation" })); clock.advance(120_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await created.sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn! }))).status, "ABORTED"); assert.deepEqual(await lines(output), []);
    assert(simulator.store.regionState(region).stepFunctions.executions[started.executionArn!].nested?.children.every(child => child.status === "CANCELLED"));
  } finally {
    api?.sfn.destroy(); api?.iam.destroy(); api?.lambda.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-04 nested failure reduction remains catchable and high-cardinality Map input fails explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug04-failure-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false }); let api: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); api = clients(simulator); const workflow = await api.iam.send(new CreateRoleCommand({ RoleName: "dug04-workflow", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    const caughtDefinition = JSON.stringify({ StartAt: "Branches", States: { Branches: { Type: "Parallel", Branches: [{ StartAt: "Okay", States: { Okay: { Type: "Pass", End: true } } }, { StartAt: "Broken", States: { Broken: { Type: "Fail", Error: "ExpectedFailure", Cause: "branch failed" } } }], Catch: [{ ErrorEquals: ["ExpectedFailure"], ResultPath: "$.failure", Next: "Handled" }], End: true }, Handled: { Type: "Pass", Parameters: { "error.$": "$.failure.Error" }, End: true } } });
    const caughtMachine = await api.sfn.send(new CreateStateMachineCommand({ name: "dug04-parallel-catch", definition: caughtDefinition, roleArn: workflow.Role!.Arn! })); const caught = await terminal(api.sfn, (await api.sfn.send(new StartExecutionCommand({ stateMachineArn: caughtMachine.stateMachineArn!, input: "{}" }))).executionArn!);
    assert.equal(caught.status, "SUCCEEDED"); assert.deepEqual(JSON.parse(caught.output!), { error: "ExpectedFailure" });
    const caughtHistory = (await api.sfn.send(new GetExecutionHistoryCommand({ executionArn: caught.executionArn!, maxResults: 1000 }))).events ?? []; assert(caughtHistory.some(event => event.type === "ParallelStateFailed"));

    const boundedDefinition = JSON.stringify({ StartAt: "Items", States: { Items: { Type: "Map", ItemsPath: "$", ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Copy", States: { Copy: { Type: "Pass", End: true } } }, End: true } } });
    const boundedMachine = await api.sfn.send(new CreateStateMachineCommand({ name: "dug04-map-bound", definition: boundedDefinition, roleArn: workflow.Role!.Arn! })); const bounded = await terminal(api.sfn, (await api.sfn.send(new StartExecutionCommand({ stateMachineArn: boundedMachine.stateMachineArn!, input: JSON.stringify(Array.from({ length: 1001 }, () => 0)) }))).executionArn!);
    assert.equal(bounded.status, "FAILED"); assert.equal(bounded.error, "States.DataLimitExceeded");
  } finally {
    api?.sfn.destroy(); api?.iam.destroy(); api?.lambda.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
