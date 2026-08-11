import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateEventBusCommand, DeleteEventBusCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, DeleteFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateTopicCommand, DeleteTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { CreateStateMachineCommand, DeleteStateMachineCommand, DescribeExecutionCommand, GetExecutionHistoryCommand, SendTaskSuccessCommand, SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface MatrixCase {
  name: string;
  resource: string;
  parameters: Record<string, unknown>;
  action: string;
  targetArn: string;
  throttleError: string;
  patch: (simulator: StackSim, wrap: (original: (...args: any[]) => Promise<any>, args: any[]) => Promise<any>) => () => void;
  callbackToken?: (simulator: StackSim, args: any[]) => string;
}

function patchMethod(object: any, key: string, wrap: (original: (...args: any[]) => Promise<any>, args: any[]) => Promise<any>, predicate: (args: any[]) => boolean = () => true): () => void {
  const original = object[key].bind(object); object[key] = (...args: any[]) => predicate(args) ? wrap(original, args) : original(...args); return () => { object[key] = original; };
}

async function role(iam: IAMClient, name: string, statements: unknown[]) {
  const created = await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  if (statements.length) await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: "matrix", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: statements }) })); return created.Role!.Arn!;
}

function definition(item: MatrixCase, extra: Record<string, unknown> = {}) { const caught = Object.hasOwn(extra, "Catch"); return JSON.stringify({ StartAt: "Invoke", States: { Invoke: { Type: "Task", Resource: item.resource, Parameters: item.parameters, End: true, ...extra }, ...(caught ? { Caught: { Type: "Pass", End: true } } : {}) } }); }

test("SFN-03 integration matrix covers authorization, retry/catch, stop, timeout, deletion, callbacks, errors, and lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sfn03-matrix-")); const clock = new TestClock(Date.now()); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true });
  const clients: any[] = [];
  try {
    await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 }; const sfn = new SFNClient(options); const iam = new IAMClient(options); const dynamodb = new DynamoDBClient(options); const sqs = new SQSClient(options); const sns = new SNSClient(options); const events = new EventBridgeClient(options); const lambda = new LambdaClient(options); clients.push(sfn, iam, dynamodb, sqs, sns, events, lambda);
    const createTable = async () => { await dynamodb.send(new CreateTableCommand({ TableName: "MatrixItems", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "MatrixItems", clock); for (const id of ["get", "update", "delete"]) await dynamodb.send(new PutItemCommand({ TableName: "MatrixItems", Item: { id: { S: id }, value: { N: "1" } } })); }; await createTable();
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "matrix-queue" }))).QueueUrl!; const queueArn = `arn:aws:sqs:${region}:${account}:matrix-queue`;
    const topicArn = (await sns.send(new CreateTopicCommand({ Name: "matrix-topic" }))).TopicArn!;
    const lambdaRoleResult = await iam.send(new CreateRoleCommand({ RoleName: "matrix-lambda-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) })); const lambdaRole = lambdaRoleResult.Role!.Arn!; const functionCode = createZip([{ name: "index.js", content: "exports.handler = async event => ({ ok: true, input: event });" }]); const createFunction = () => lambda.send(new CreateFunctionCommand({ FunctionName: "matrix-function", Runtime: "nodejs22.x", Handler: "index.handler", Role: lambdaRole, Code: { ZipFile: functionCode } })); const fn = await createFunction();
    const childRole = await role(iam, "matrix-child-role", []); const child = await sfn.send(new CreateStateMachineCommand({ name: "matrix-child", roleArn: childRole, definition: JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } }) }));
    const tableArn = `arn:aws:dynamodb:${region}:${account}:table/MatrixItems`; const busName = "matrix-bus"; const busArn = (await events.send(new CreateEventBusCommand({ Name: busName }))).EventBusArn!;
    const cases: MatrixCase[] = [
      { name: "dynamodb-getItem", resource: "arn:aws:states:::dynamodb:getItem", parameters: { TableName: "MatrixItems", Key: { id: { S: "get" } } }, action: "dynamodb:GetItem", targetArn: tableArn, throttleError: "DynamoDB.ProvisionedThroughputExceededException", patch: (s, w) => patchMethod(s.dynamodb, "GetItem", w) },
      { name: "dynamodb-putItem", resource: "arn:aws:states:::dynamodb:putItem", parameters: { TableName: "MatrixItems", Item: { id: { S: "put" }, value: { N: "2" } } }, action: "dynamodb:PutItem", targetArn: tableArn, throttleError: "DynamoDB.ProvisionedThroughputExceededException", patch: (s, w) => patchMethod(s.dynamodb, "PutItem", w) },
      { name: "dynamodb-updateItem", resource: "arn:aws:states:::dynamodb:updateItem", parameters: { TableName: "MatrixItems", Key: { id: { S: "update" } }, UpdateExpression: "SET #v = :v", ExpressionAttributeNames: { "#v": "value" }, ExpressionAttributeValues: { ":v": { N: "2" } }, ReturnValues: "ALL_NEW" }, action: "dynamodb:UpdateItem", targetArn: tableArn, throttleError: "DynamoDB.ProvisionedThroughputExceededException", patch: (s, w) => patchMethod(s.dynamodb, "UpdateItem", w) },
      { name: "dynamodb-deleteItem", resource: "arn:aws:states:::dynamodb:deleteItem", parameters: { TableName: "MatrixItems", Key: { id: { S: "delete" } }, ReturnValues: "ALL_OLD" }, action: "dynamodb:DeleteItem", targetArn: tableArn, throttleError: "DynamoDB.ProvisionedThroughputExceededException", patch: (s, w) => patchMethod(s.dynamodb, "DeleteItem", w) },
      { name: "sqs-sendMessage", resource: "arn:aws:states:::sqs:sendMessage", parameters: { QueueUrl: queueUrl, MessageBody: "matrix" }, action: "sqs:SendMessage", targetArn: queueArn, throttleError: "SQS.RequestThrottled", patch: (s, w) => patchMethod(s.sqs, "sendAuthorizedMessageToArn", w) },
      { name: "sns-publish", resource: "arn:aws:states:::sns:publish", parameters: { TopicArn: topicArn, Message: "matrix" }, action: "sns:Publish", targetArn: topicArn, throttleError: "SNS.Throttled", patch: (s, w) => patchMethod(s.sns, "publishAuthorized", w) },
      { name: "events-putEvents", resource: "arn:aws:states:::events:putEvents", parameters: { Entries: [{ EventBusName: busName, Source: "matrix.test", DetailType: "Matrix", Detail: "{}" }] }, action: "events:PutEvents", targetArn: busArn, throttleError: "EventBridge.ThrottlingException", patch: (s, w) => patchMethod(s.eventbridge, "PutEvents", w, args => Boolean(args[2]?.integrationAttempt)) },
      { name: "lambda-request", resource: "arn:aws:states:::lambda:invoke", parameters: { FunctionName: fn.FunctionArn, Payload: { matrix: true } }, action: "lambda:InvokeFunction", targetArn: fn.FunctionArn!, throttleError: "Lambda.TooManyRequestsException", patch: (s, w) => patchMethod(s.lambda, "invoke", w) },
      { name: "lambda-callback", resource: "arn:aws:states:::lambda:invoke.waitForTaskToken", parameters: { FunctionName: fn.FunctionArn, Payload: { "token.$": "$$.Task.Token" } }, action: "lambda:InvokeFunction", targetArn: fn.FunctionArn!, throttleError: "Lambda.TooManyRequestsException", patch: (s, w) => patchMethod(s.lambda, "invoke", w), callbackToken: (_s, args) => JSON.parse(Buffer.from(args[1]).toString("utf8")).token },
      { name: "sqs-callback", resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken", parameters: { QueueUrl: queueUrl, "MessageBody.$": "$$.Task.Token" }, action: "sqs:SendMessage", targetArn: queueArn, throttleError: "SQS.RequestThrottled", patch: (s, w) => patchMethod(s.sqs, "sendAuthorizedMessageToArn", w), callbackToken: (_s, args) => String(args[1].MessageBody) },
      { name: "sns-callback", resource: "arn:aws:states:::sns:publish.waitForTaskToken", parameters: { TopicArn: topicArn, "Message.$": "$$.Task.Token" }, action: "sns:Publish", targetArn: topicArn, throttleError: "SNS.Throttled", patch: (s, w) => patchMethod(s.sns, "publishAuthorized", w), callbackToken: (_s, args) => String(args[0].Message) },
      { name: "nested-request", resource: "arn:aws:states:::states:startExecution", parameters: { StateMachineArn: child.stateMachineArn, Input: { matrix: true } }, action: "states:StartExecution", targetArn: child.stateMachineArn!, throttleError: "StepFunctions.ThrottlingException", patch: (s, w) => patchMethod(s.stepfunctions, "StartExecution", w, args => Array.isArray(args[0]?.__lineage)) },
      { name: "nested-sync", resource: "arn:aws:states:::states:startExecution.sync", parameters: { StateMachineArn: child.stateMachineArn, Input: { matrix: true } }, action: "states:StartExecution", targetArn: child.stateMachineArn!, throttleError: "StepFunctions.ThrottlingException", patch: (s, w) => patchMethod(s.stepfunctions, "StartExecution", w, args => Array.isArray(args[0]?.__lineage)) },
      { name: "nested-callback", resource: "arn:aws:states:::states:startExecution.waitForTaskToken", parameters: { StateMachineArn: child.stateMachineArn, Input: { "token.$": "$$.Task.Token" } }, action: "states:StartExecution", targetArn: child.stateMachineArn!, throttleError: "StepFunctions.ThrottlingException", patch: (s, w) => patchMethod(s.stepfunctions, "StartExecution", w, args => Array.isArray(args[0]?.__lineage)), callbackToken: (s, args) => { const input = typeof args[0].input === "string" ? JSON.parse(args[0].input) : args[0].input; const tokenId = String(input.token).match(/__stacksim_task_token_ref_([0-9a-f-]{36})__/)?.[1]; for (const execution of Object.values(s.store.regionState(region).stepFunctions.executions) as any[]) for (const task of Object.values(execution.callbackTasks ?? {}) as any[]) if (task.tokenId === tokenId) return (s.stepfunctions as any).tokenFor(task); throw new Error("nested callback token was not materialized"); } },
    ];
    const allowStatements = cases.flatMap(item => [{ Effect: "Allow", Action: item.action, Resource: item.targetArn }, ...(item.name === "nested-sync" ? [{ Effect: "Allow", Action: ["states:DescribeExecution", "states:StopExecution"], Resource: `arn:aws:states:${region}:${account}:execution:matrix-child:*` }] : [])]); const allowRole = await role(iam, "matrix-allow-role", allowStatements);
    const terminal = async (arn: string) => { for (let index = 0; index < 400; index++) { const value = await sfn.send(new DescribeExecutionCommand({ executionArn: arn })); if (value.status !== "RUNNING") return value; clock.advance(1_000); await new Promise(resolve => setImmediate(resolve)); } throw new Error("matrix execution did not finish"); };

    for (const [index, item] of cases.entries()) {
      let lineage: string[] | undefined; const restore = item.patch(simulator, async (original, args) => { const attempt = args[1]?.attemptId ? args[1] : args[2]?.attemptId ? args[2] : args[3]?.attemptId ? args[3] : args[2]?.integrationAttempt; const candidate = attempt?.lineage ?? args[3]?.lineage ?? args[0]?.__lineage; if (candidate) lineage = candidate; const output = await original(...args); if (item.callbackToken) void sfn.send(new SendTaskSuccessCommand({ taskToken: item.callbackToken(simulator, args), output: JSON.stringify({ callback: item.name }) })).catch(() => undefined); return output; });
      const machine = await sfn.send(new CreateStateMachineCommand({ name: `matrix-allow-${index}`, roleArn: allowRole, definition: definition(item) })); const result = await terminal((await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! }))).executionArn!); restore(); assert.equal(result.status, "SUCCEEDED", `${item.name}: ${result.error ?? ""} ${result.cause ?? ""}`); assert(lineage?.length && lineage.length <= 32, `${item.name} carries bounded lineage`); assert.equal(new Set(lineage).size, lineage.length, `${item.name} lineage has no cycle`);

      const mutableRoleName = `matrix-deny-${index}`;
      const mutableRole = await role(iam, mutableRoleName, [{ Effect: "Allow", Action: item.action, Resource: item.targetArn }, ...(item.name === "nested-sync" ? [{ Effect: "Allow", Action: "states:DescribeExecution", Resource: "*" }] : [])]);
      const deniedMachine = await sfn.send(new CreateStateMachineCommand({ name: `matrix-denied-${index}`, roleArn: mutableRole, definition: definition(item, { Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.caught", Next: "Caught" }] }) }));
      await iam.send(new PutRolePolicyCommand({ RoleName: mutableRoleName, PolicyName: "matrix", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: item.action, Resource: item.targetArn }, { Effect: "Deny", Action: item.action, Resource: item.targetArn }] }) }));
      const denied = await terminal((await sfn.send(new StartExecutionCommand({ stateMachineArn: deniedMachine.stateMachineArn! }))).executionArn!); assert.equal(denied.status, "SUCCEEDED", `${item.name} explicit deny is catchable`); assert.match(String(JSON.parse(denied.output!).caught?.Error), /AccessDenied|Authorization|AWSLambdaException/i, item.name);

      let calls = 0; const restoreThrottle = item.patch(simulator, async (original, args) => { calls++; if (calls === 1) throw new AwsError(item.throttleError.split(".").at(-1)!, "injected owning-service throttle", 429); const output = await original(...args); if (item.callbackToken) void sfn.send(new SendTaskSuccessCommand({ taskToken: item.callbackToken(simulator, args), output: JSON.stringify({ callback: item.name }) })).catch(() => undefined); return output; });
      const retryMachine = await sfn.send(new CreateStateMachineCommand({ name: `matrix-retry-${index}`, roleArn: allowRole, definition: definition(item, { Retry: [{ ErrorEquals: [item.throttleError], IntervalSeconds: 1, MaxAttempts: 1 }] }) }));
      const retried = await terminal((await sfn.send(new StartExecutionCommand({ stateMachineArn: retryMachine.stateMachineArn! }))).executionArn!); restoreThrottle(); assert.equal(retried.status, "SUCCEEDED", `${item.name}: ${retried.error} ${retried.cause}`); assert.equal(calls, 2, `${item.name} retries one safe pre-acceptance throttle`); const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn: retried.executionArn!, maxResults: 1000 })); assert(JSON.stringify(history).includes(item.throttleError), `${item.name} preserves the exact throttling error`);
    }

    const event = cases.find(item => item.name === "events-putEvents")!;
    const partialDefinition = definition({ ...event, parameters: { Entries: [{ EventBusName: busName, Source: "matrix.test", DetailType: "Valid", Detail: "{}" }, { EventBusName: busName, Source: "matrix.test", DetailType: "Invalid", Detail: "not-json" }] } }, { Catch: [{ ErrorEquals: ["EventBridge.FailedEntry"], ResultPath: "$.caught", Next: "Caught" }] });
    const partialMachine = await sfn.send(new CreateStateMachineCommand({ name: "matrix-event-partial", roleArn: allowRole, definition: partialDefinition })); const partial = await terminal((await sfn.send(new StartExecutionCommand({ stateMachineArn: partialMachine.stateMachineArn! }))).executionArn!); assert.equal(partial.status, "SUCCEEDED"); assert.equal(JSON.parse(partial.output!).caught.Error, "EventBridge.FailedEntry");

    // Every request integration is held at dispatch, stopped, and then allowed to finish once. No success transition may overwrite ABORTED.
    for (const [index, item] of cases.entries()) {
      let entered!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const restore = item.patch(simulator, async (original, args) => { entered(); await gate; return original(...args); }); const machine = await sfn.send(new CreateStateMachineCommand({ name: `matrix-stop-${index}`, roleArn: allowRole, definition: definition(item) })); const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! })); await seen; await sfn.send(new StopExecutionCommand({ executionArn: started.executionArn!, error: "StoppedByMatrix" })); release(); await new Promise(resolve => setImmediate(resolve)); const stopped = await terminal(started.executionArn!); restore(); assert.equal(stopped.status, "ABORTED", item.name); const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn!, maxResults: 1000 })); assert(!history.events?.some(event => event.type === "TaskSucceeded" || event.type === "LambdaFunctionSucceeded"), `${item.name} cannot record success after stop`);
    }

    for (const [index, item] of cases.entries()) {
      let entered!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
      const restore = item.patch(simulator, async (original, args) => { calls++; entered(); await gate; return original(...args); });
      const machine = await sfn.send(new CreateStateMachineCommand({ name: `matrix-timeout-${index}`, roleArn: allowRole, definition: definition(item, { TimeoutSeconds: 1, Retry: [{ ErrorEquals: ["States.Timeout"], IntervalSeconds: 1, MaxAttempts: 2 }] }) }));
      const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! })); await seen; clock.advance(1_000); release(); const timed = await terminal(started.executionArn!); restore(); assert.equal(timed.status, "FAILED", item.name); assert.equal(timed.error, "States.Timeout", item.name); assert.equal(calls, 1, `${item.name} timeout ambiguity is not blindly retried`);
    }

    for (const [index, item] of cases.entries()) {
      const machine = await sfn.send(new CreateStateMachineCommand({ name: `matrix-deleted-${index}`, roleArn: allowRole, definition: definition(item, { Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.caught", Next: "Caught" }] }) }));
      if (item.name.startsWith("dynamodb-")) await dynamodb.send(new DeleteTableCommand({ TableName: "MatrixItems" }));
      else if (item.name.startsWith("sqs-")) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      else if (item.name.startsWith("sns-")) await sns.send(new DeleteTopicCommand({ TopicArn: topicArn }));
      else if (item.name === "events-putEvents") await events.send(new DeleteEventBusCommand({ Name: busName }));
      else if (item.name.startsWith("lambda-")) await lambda.send(new DeleteFunctionCommand({ FunctionName: fn.FunctionArn! }));
      else await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: child.stateMachineArn! }));
      const deleted = await terminal((await sfn.send(new StartExecutionCommand({ stateMachineArn: machine.stateMachineArn! }))).executionArn!); assert.equal(deleted.status, "SUCCEEDED", item.name); const deletedOutput = JSON.parse(deleted.output!); if (item.name === "events-putEvents") { assert.equal(deletedOutput.FailedEntryCount, 0, "EventBridge preserves PutEvents missing-bus success semantics after target deletion"); assert.equal(deletedOutput.caught, undefined); } else assert(deletedOutput.caught?.Error, `${item.name} exposes a deletion error`);
      if (item.name.startsWith("dynamodb-")) await createTable();
      else if (item.name.startsWith("sqs-")) { clock.advance(61_000); await sqs.send(new CreateQueueCommand({ QueueName: "matrix-queue" })); }
      else if (item.name.startsWith("sns-")) await sns.send(new CreateTopicCommand({ Name: "matrix-topic" }));
      else if (item.name === "events-putEvents") await events.send(new CreateEventBusCommand({ Name: busName }));
      else if (item.name.startsWith("lambda-")) await createFunction();
      else await sfn.send(new CreateStateMachineCommand({ name: "matrix-child", roleArn: childRole, definition: JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } }) }));
    }
  } finally { for (const client of clients) client.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
