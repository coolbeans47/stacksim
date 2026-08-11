import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeExecutionCommand,
  DescribeStateMachineForExecutionCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  ListStateMachinesCommand,
  ListTagsForResourceCommand,
  SFNClient,
  StartExecutionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateStateMachineCommand,
  ValidateStateMachineDefinitionCommand,
} from "@aws-sdk/client-sfn";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const active: Array<{ simulator: StackSim; root: string; clients: Array<{ destroy(): void }> }> = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sfn-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off", cdkBootstrap: false });
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
  const sfn = new SFNClient(options); const iam = new IAMClient(options); const clients = [sfn, iam]; active.push({ simulator, root, clients });
  const role = await iam.send(new CreateRoleCommand({ RoleName: "workflow-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  return { root, simulator, sfn, iam, options, roleArn: role.Role!.Arn! };
}

afterEach(async () => {
  while (active.length) {
    const item = active.pop()!; item.clients.forEach(client => client.destroy());
    await item.simulator.stop().catch(() => undefined); await rm(item.root, { recursive: true, force: true });
  }
});

async function terminal(client: SFNClient, executionArn: string): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await client.send(new DescribeExecutionCommand({ executionArn }));
    if (value.status !== "RUNNING") return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Execution did not finish");
}

test("official Step Functions client manages and executes the P0 JSONPath control-flow surface", async () => {
  const h = await harness();
  const definition = JSON.stringify({
    StartAt: "Prepare",
    States: {
      Prepare: { Type: "Pass", Parameters: { "items.$": "$.items", ready: true }, Next: "Ready?" },
      "Ready?": { Type: "Choice", Choices: [{ Variable: "$.ready", BooleanEquals: true, Next: "Parallel" }], Default: "Rejected" },
      Parallel: {
        Type: "Parallel",
        Branches: [
          { StartAt: "A", States: { A: { Type: "Pass", Result: "first", End: true } } },
          { StartAt: "B", States: { B: { Type: "Pass", Result: "second", End: true } } },
        ],
        ResultPath: "$.branches",
        Next: "Each",
      },
      Each: {
        Type: "Map", ItemsPath: "$.items", ItemSelector: { "index.$": "$$.Map.Item.Index", "value.$": "$$.Map.Item.Value" },
        ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Copy", States: { Copy: { Type: "Pass", End: true } } },
        End: true,
      },
      Rejected: { Type: "Fail", Error: "Rejected" },
    },
  });
  const validation = await h.sfn.send(new ValidateStateMachineDefinitionCommand({ definition }));
  assert.equal(validation.result, "OK"); assert.deepEqual(validation.diagnostics, []);
  const created = await h.sfn.send(new CreateStateMachineCommand({ name: "p0-workflow", definition, roleArn: h.roleArn, tags: [{ key: "stage", value: "test" }] }));
  assert(created.creationDate instanceof Date);
  await h.sfn.send(new TagResourceCommand({ resourceArn: created.stateMachineArn!, tags: [{ key: "owner", value: "sdk" }] }));
  await h.sfn.send(new UntagResourceCommand({ resourceArn: created.stateMachineArn!, tagKeys: ["stage"] }));
  assert.deepEqual((await h.sfn.send(new ListTagsForResourceCommand({ resourceArn: created.stateMachineArn! }))).tags, [{ key: "owner", value: "sdk" }]);
  assert.equal((await h.sfn.send(new ListStateMachinesCommand({ maxResults: 1 }))).stateMachines?.[0].name, "p0-workflow");

  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: created.stateMachineArn!, name: "ordered", input: JSON.stringify({ items: ["x", "y", "z"] }) }));
  const completed = await terminal(h.sfn, started.executionArn!);
  assert.equal(completed.status, "SUCCEEDED");
  assert.deepEqual(JSON.parse(completed.output), [{ index: 0, value: "x" }, { index: 1, value: "y" }, { index: 2, value: "z" }]);
  assert.equal((await h.sfn.send(new ListExecutionsCommand({ stateMachineArn: created.stateMachineArn! }))).executions?.[0].status, "SUCCEEDED");
  const history = await h.sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn!, reverseOrder: true }));
  assert.equal(history.events?.[0].type, "ExecutionSucceeded");
  assert.equal((await h.sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: started.executionArn! }))).definition, definition);

  const replacement = JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } });
  const updated = await h.sfn.send(new UpdateStateMachineCommand({ stateMachineArn: created.stateMachineArn!, definition: replacement }));
  assert(updated.updateDate instanceof Date); assert(updated.revisionId);
  assert.equal((await h.sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: started.executionArn! }))).definition, definition, "execution retains its immutable definition snapshot");
  await h.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: created.stateMachineArn! }));
  assert.equal((await h.sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn! }))).status, "SUCCEEDED", "deletion retains execution history");
});

test("validation rejects unsupported and malformed definitions without mutation", async () => {
  const h = await harness();
  const unsupported = JSON.stringify({ StartAt: "Http", States: { Http: { Type: "Task", Resource: "arn:aws:states:::http:invoke", End: true } } });
  const result = await h.sfn.send(new ValidateStateMachineDefinitionCommand({ definition: unsupported }));
  assert.equal(result.result, "FAIL"); assert(result.diagnostics?.some(item => item.code === "UNSUPPORTED_FEATURE"));
  await assert.rejects(h.sfn.send(new CreateStateMachineCommand({ name: "invalid", definition: unsupported, roleArn: h.roleArn })), (error: any) => error.name === "InvalidDefinition");
  assert.deepEqual((await h.sfn.send(new ListStateMachinesCommand({}))).stateMachines, []);
});

test("direct and optimized Lambda tasks use the real local Lambda service", async () => {
  const h = await harness(); const lambda = new LambdaClient(h.options); active.at(-1)!.clients.push(lambda);
  const lambdaRole = await h.iam.send(new CreateRoleCommand({ RoleName: "lambda-workflow-target", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  const created = await lambda.send(new CreateFunctionCommand({ FunctionName: "workflow-echo", Runtime: "nodejs22.x", Handler: "index.handler", Role: lambdaRole.Role!.Arn!, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async event => event;" }]) } }));
  const definition = JSON.stringify({
    StartAt: "Direct",
    States: {
      Direct: { Type: "Task", Resource: created.FunctionArn, Parameters: { "value.$": "$.number" }, ResultPath: "$.direct", Next: "Optimized" },
      Optimized: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: created.FunctionArn, "Payload.$": "$" }, ResultSelector: { "echo.$": "$.Payload.direct.value" }, ResultPath: "$.optimized", End: true },
    },
  });
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "lambda-tasks", definition, roleArn: h.roleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, input: JSON.stringify({ number: 7 }) }));
  const completed = await terminal(h.sfn, started.executionArn!);
  assert.equal(completed.status, "SUCCEEDED");
  assert.deepEqual(JSON.parse(completed.output), { number: 7, direct: { value: 7 }, optimized: { echo: 7 } });
  const history = (await h.sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn! }))).events ?? [];
  assert(history.some(event => event.type === "LambdaFunctionSucceeded"));
  assert.equal(history.find(event => event.type === "TaskStateEntered")?.stateEnteredEventDetails?.name, "Direct");
  assert.equal(history.find(event => event.type === "TaskStateExited")?.stateExitedEventDetails?.name, "Direct");
});

test("running waits and execution history recover from the private execution store after restart", async () => {
  const h = await harness();
  const definition = JSON.stringify({ StartAt: "Pause", States: { Pause: { Type: "Wait", Seconds: 1, Next: "Done" }, Done: { Type: "Succeed" } } });
  const machine = await h.sfn.send(new CreateStateMachineCommand({ name: "restartable", definition, roleArn: h.roleArn }));
  const started = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, name: "restart", input: JSON.stringify({ marker: "private-execution-payload-741" }) }));
  const duplicate = await h.sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn!, name: "restart", input: JSON.stringify({ marker: "private-execution-payload-741" }) }));
  assert.equal(duplicate.executionArn, started.executionArn);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn! }))).status, "RUNNING");
  assert(!String(await readFile(join(h.root, "state.json"))).includes("private-execution-payload-741"), "execution payload is not stored in regional control state");
  h.sfn.destroy(); await h.simulator.stop();

  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region: "eu-west-1", authMode: "off", cdkBootstrap: false });
  await simulator.start();
  const sfn = new SFNClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  active.push({ simulator, root: h.root, clients: [sfn] });
  const completed = await terminal(sfn, started.executionArn!);
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal(JSON.parse(completed.output).marker, "private-execution-payload-741");
});
