import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { addStudioState, definitionScopes, executionPresentation, historyPresentation, integrationReferences, lambdaReferences, payloadField, redactSensitiveValue, removeStudioState, renameStudioState, setStudioStartAt, studioFlow, updateStudioState } = await import(pathToFileURL(join(process.cwd(), "web/services/step-functions-model.js")).href);

const definition = JSON.stringify({
  StartAt: "Invoke",
  States: {
    Invoke: { Type: "Task", Resource: "arn:aws:lambda:eu-west-1:000000000000:function:worker:live", Retry: [{ ErrorEquals: ["States.ALL"], MaxAttempts: 2 }], Next: "Parallel" },
    Parallel: { Type: "Parallel", Branches: [{ StartAt: "A", States: { A: { Type: "Pass", End: true } } }, { StartAt: "B", States: { B: { Type: "Pass", End: true } } }], Next: "Items" },
    Items: { Type: "Map", ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Copy", States: { Copy: { Type: "Pass", End: true } } }, End: true },
  },
});

test("console definition model retains nested scopes and supported Lambda links", () => {
  assert.deepEqual(definitionScopes(definition).map((scope: { label: string }) => scope.label), ["Main workflow", "Parallel · branch 1", "Parallel · branch 2", "Items · item processor"]);
  assert.deepEqual(lambdaReferences(definition), [{ name: "worker", resource: "arn:aws:lambda:eu-west-1:000000000000:function:worker:live", stateName: "Invoke", scope: "Main workflow" }]);
});

test("console definition model exposes SFN-03 related resources without task tokens", () => {
  const integrations = JSON.stringify({ StartAt: "Write", States: { Write: { Type: "Task", Resource: "arn:aws:states:::dynamodb:putItem", Parameters: { TableName: "Orders", Item: { id: { S: "1" } } }, Next: "Callback" }, Callback: { Type: "Task", Resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken", Parameters: { QueueUrl: "http://localhost/000000000000/work", "MessageBody.$": "$$.Task.Token" }, End: true } } });
  assert.deepEqual(integrationReferences(integrations).map((item: any) => [item.service, item.stateName, item.callback]), [["DynamoDB", "Write", false], ["SQS", "Callback", true]]);
  assert(!JSON.stringify(integrationReferences(integrations)).includes("Task.Token"));
});

test("active-state presentation requires a running execution and an unmatched entered event", () => {
  const events = [
    { id: 1, previousEventId: 0, type: "TaskStateEntered", stateEnteredEventDetails: { name: "Invoke", input: "{}", inputDetails: { truncated: false } } },
    { id: 2, previousEventId: 1, type: "LambdaFunctionSucceeded", lambdaFunctionSucceededEventDetails: { output: "{}", outputDetails: { truncated: false } } },
    { id: 3, previousEventId: 2, type: "TaskStateExited", stateExitedEventDetails: { name: "Invoke", output: "{}", outputDetails: { truncated: false } } },
    { id: 4, previousEventId: 3, type: "ParallelStateEntered", stateEnteredEventDetails: { name: "Parallel", input: "{}", inputDetails: { truncated: false } } },
  ];
  assert.equal(historyPresentation(events, "RUNNING").active?.stateName, "Parallel");
  assert.equal(historyPresentation(events, "SUCCEEDED").active, null);
  assert.equal(historyPresentation([...events, { id: 5, previousEventId: 4, type: "ParallelStateExited", stateExitedEventDetails: { name: "Parallel" } }], "RUNNING").active, null);
});

test("typed history links unnamed failures and models iteration outcomes and omitted data", () => {
  const events = [
    { id: 1, previousEventId: 0, type: "TaskStateEntered", stateEnteredEventDetails: { name: "Invoke", inputDetails: { truncated: false } } },
    { id: 2, previousEventId: 1, type: "TaskFailed", taskFailedEventDetails: { error: "Boom", cause: "failed" } },
    { id: 3, previousEventId: 2, type: "MapIterationStarted", mapIterationStartedEventDetails: { name: "Items", index: 0 } },
    { id: 4, previousEventId: 3, type: "MapIterationSucceeded", mapIterationSucceededEventDetails: { name: "Items", index: 0 } },
  ];
  const model = executionPresentation(definition, events, "FAILED");
  assert.equal(model.retries[0].stateName, "Invoke");
  assert.deepEqual(model.iterations, [{ index: 0, name: "Items", status: "SUCCEEDED", eventIds: [3, 4] }]);
  assert.deepEqual(payloadField(events[0].stateEnteredEventDetails!, "input"), { state: "omitted", value: undefined });
  assert.deepEqual(payloadField({}, "output"), { state: "absent", value: undefined });
});

test("execution presentation labels callback waits, links child executions, and redacts sensitive causes", () => {
  const childArn = "arn:aws:states:eu-west-1:000000000000:execution:child:run-1";
  const definition = JSON.stringify({ StartAt: "Child", States: { Child: { Type: "Task", Resource: "arn:aws:states:::states:startExecution.waitForTaskToken", Parameters: { StateMachineArn: "arn:aws:states:eu-west-1:000000000000:stateMachine:child" }, End: true } } });
  const events = [
    { id: 1, previousEventId: 0, type: "TaskStateEntered", taskStateEnteredEventDetails: { name: "Child", input: "{}" } },
    { id: 2, previousEventId: 1, type: "TaskScheduled", taskScheduledEventDetails: { resource: "arn:aws:states:::states:startExecution.waitForTaskToken" } },
    { id: 3, previousEventId: 2, type: "TaskSucceeded", taskSucceededEventDetails: { output: JSON.stringify({ ExecutionArn: childArn }) } },
    { id: 4, previousEventId: 3, type: "TaskFailed", taskFailedEventDetails: { error: "Downstream", cause: JSON.stringify({ message: "safe", Authorization: "Bearer private", password: "secret" }) } },
  ];
  const model = executionPresentation(definition, events, "RUNNING");
  assert.equal(model.history.active.waitingForCallback, true);
  assert.deepEqual(model.childExecutions, [{ executionArn: childArn, eventId: 3, stateName: "Child" }]);
  assert.equal(model.failures.at(-1).cause, JSON.stringify({ message: "safe", Authorization: "<redacted>", password: "<redacted>" }));
  assert.deepEqual(redactSensitiveValue({ token: "private", nested: { ResponseURL: "https://secret", message: "Bearer abc" } }), { token: "<redacted>", nested: { ResponseURL: "<redacted>", message: "Bearer <redacted>" } });
});

test("studio model adds, rewires, renames, and removes states with JSON-round-tripable ASL", () => {
  let workflow: Record<string, any> = { Comment: "studio", StartAt: "Hello", States: { Hello: { Type: "Pass", Result: { ok: true }, End: true } } };
  const added = addStudioState(workflow, "Task", { afterName: "Hello", preferredName: "Work" });
  workflow = added.definition;
  assert.equal(added.name, "Work");
  assert.equal(workflow.States.Hello.Next, "Work");
  assert.equal(workflow.States.Work.End, true);
  workflow = updateStudioState(workflow, "Work", { Resource: "arn:aws:lambda:eu-west-1:000000000000:function:worker", Parameters: { Payload: { "input.$": "$" } } });
  workflow = renameStudioState(workflow, "Work", "DoWork");
  assert.equal(workflow.States.Hello.Next, "DoWork");
  assert.ok(workflow.States.DoWork);
  workflow = setStudioStartAt(workflow, "DoWork");
  assert.equal(workflow.StartAt, "DoWork");
  const flow = studioFlow(workflow);
  assert.deepEqual(flow.nodes.map((node: { name: string }) => node.name), ["DoWork", "Hello"]);
  assert.ok(flow.orphans.includes("Hello"));
  workflow = removeStudioState(workflow, "Hello");
  assert.equal(workflow.StartAt, "DoWork");
  assert.equal(Object.keys(workflow.States).join(","), "DoWork");
  const choice = addStudioState(workflow, "Choice", { afterName: "DoWork" });
  assert.equal(choice.definition.States.DoWork.Next, choice.name);
  assert.equal(choice.definition.States[choice.name].Default, "DoWork");
});
