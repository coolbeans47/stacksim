import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { flowGraphHtml, flowLayout } = await import(pathToFileURL(join(process.cwd(), "web/services/step-functions-graph.js")).href);
const { displayLabel, epochMilliseconds, executionRoleStatements, executionRoleTrustPolicy, formatDuration, formatElapsed, formatTimestamp, generatedRoleName, resourceNameProblem, rowsToTags, stateNameProblem, stateResults, stateTransitionCount, statusVariant, tagChanges, tagsToRows, addStudioState, cloudFormationOrigin, definitionScopes, executionPresentation, executionRoleLink, historyPresentation, integrationReferences, lambdaReferences, payloadField, redactSensitiveValue, removeStudioState, renameStudioState, setStudioStartAt, studioFlow, updateStudioState } = await import(pathToFileURL(join(process.cwd(), "web/services/step-functions-model.js")).href);

test("deployment links preserve stack identity, IAM role paths, and exact integration resources", () => {
  const stackId = "arn:aws:cloudformation:eu-west-1:000000000000:stack/Orders/first-generation";
  const tags = [{ key: "aws:cloudformation:stack-id", value: stackId }, { key: "aws:cloudformation:logical-id", value: "Workflow" }];
  assert.deepEqual(cloudFormationOrigin(tags), { stackId, stackName: "Orders", logicalId: "Workflow", href: `#/cloudformation/stacks/${encodeURIComponent(stackId)}/resources` });
  assert.equal(cloudFormationOrigin([]), null);
  assert.equal(cloudFormationOrigin([{ key: "aws:cloudformation:stack-id", value: "javascript:alert(1)" }]), null);
  assert.equal(executionRoleLink("arn:aws:iam::000000000000:role/service-role/workflow-role"), "#/iam/roles/workflow-role");
  assert.equal(executionRoleLink("arn:aws:iam::000000000000:user/worker"), null);
  const activityArn = "arn:aws:states:eu-west-1:000000000000:activity:review";
  const references = integrationReferences({ StartAt: "Queue", States: {
    Queue: { Type: "Task", Resource: "arn:aws:states:::sqs:sendMessage", Parameters: { QueueUrl: "http://127.0.0.1:4566/000000000000/orders" }, Next: "Topic" },
    Topic: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: "arn:aws:sns:eu-west-1:000000000000:order-events" }, Next: "Event" },
    Event: { Type: "Task", Resource: "arn:aws:states:::events:putEvents", Parameters: { Entries: [{ EventBusName: "arn:aws:events:eu-west-1:000000000000:event-bus/orders" }] }, Next: "Review" },
    Review: { Type: "Task", Resource: activityArn, End: true },
  } });
  assert.deepEqual(references.map((item: any) => item.href), ["#/sqs/queues/orders/details", "#/sns/topics/order-events", "#/eventbridge/event-buses/orders", `#/step-functions/activities/${encodeURIComponent(activityArn)}`]);
  const callback = lambdaReferences({ StartAt: "Task", States: { Task: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke.waitForTaskToken", Parameters: { FunctionName: "arn:aws:lambda:eu-west-1:000000000000:function:callback" }, End: true } } });
  assert.equal(callback[0].name, "callback");
});

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

test("console definition model exposes related resources without task tokens", () => {
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
  const forward = choice.definition.States[choice.name].Default;
  assert.notEqual(forward, "DoWork", "a new Choice must not loop back to the state that leads into it");
  assert.deepEqual(choice.definition.States[forward], { Type: "Succeed" });
});

test("a new Choice branches forward, and a state added after a Choice is reachable", () => {
  const start = { StartAt: "First", States: { First: { Type: "Pass", Next: "Last" }, Last: { Type: "Pass", End: true } } };
  const middle = addStudioState(start, "Choice", { afterName: "First" });
  assert.equal(middle.definition.States.First.Next, middle.name);
  assert.equal(middle.definition.States[middle.name].Default, "Last");
  assert.equal(middle.definition.States[middle.name].Choices[0].Next, "Last");

  const tail = addStudioState(start, "Choice", { afterName: "Last" });
  const target = tail.definition.States[tail.name].Default;
  assert.notEqual(target, "Last");
  assert.deepEqual(tail.definition.States[target], { Type: "Succeed" });

  const branch = addStudioState(tail.definition, "Pass", { afterName: tail.name, preferredName: "Extra work" });
  assert.equal(branch.name, "Extra work");
  assert.equal(branch.definition.States[tail.name].Choices.length, tail.definition.States[tail.name].Choices.length + 1);
  assert.deepEqual(studioFlow(branch.definition).orphans, []);
  assert.throws(() => renameStudioState(branch.definition, "Extra work", " "), /State name is required/);
  assert.ok(renameStudioState(branch.definition, "Extra work", "Is it done?").States["Is it done?"]);
});

test("durations, timestamps and names follow the API and the AWS naming rules", () => {
  assert.equal(epochMilliseconds(1793861175.115), 1793861175115);
  assert.equal(epochMilliseconds(1793861175115), 1793861175115);
  assert.equal(formatDuration(1793861175.115, 1793861176.2), "00:00:01.085");
  assert.equal(formatDuration(1793861175.115, undefined, 1793861175115 + 3_723_004), "01:02:03.004");
  assert.equal(formatElapsed(undefined), "–");
  assert.match(formatTimestamp(1793861175.115), /:\d\d\.115$/);
  assert.equal(resourceNameProblem("orders.workflow_v2-A"), null);
  assert.match(resourceNameProblem("orders workflow"), /white space/);
  assert.match(resourceNameProblem("orders/workflow"), /special characters/);
  assert.match(resourceNameProblem("x".repeat(81)), /80 characters/);
  assert.equal(stateNameProblem("Wait for X Seconds"), null);
  assert.equal(displayLabel("TIMED_OUT"), "Timed out");
  assert.equal(statusVariant("NOT_STARTED"), "inactive");
});

test("state results report status, input and output per state", () => {
  const definition = { StartAt: "Charge", States: {
    Charge: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: "pay" }, Catch: [{ ErrorEquals: ["States.ALL"], Next: "Refund" }], Next: "Ship" },
    Refund: { Type: "Pass", Next: "Declined" }, Ship: { Type: "Pass", End: true }, Declined: { Type: "Fail", Error: "Declined" },
  } };
  const at = (seconds: number) => 1_800_000_000 + seconds;
  const events = [
    { id: 1, previousEventId: 0, type: "ExecutionStarted", timestamp: at(0), executionStartedEventDetails: { input: "{}" } },
    { id: 2, previousEventId: 1, type: "TaskStateEntered", timestamp: at(0.01), stateEnteredEventDetails: { name: "Charge", input: "{\"order\":1}" } },
    { id: 3, previousEventId: 2, type: "TaskFailed", timestamp: at(1), taskFailedEventDetails: { error: "PaymentError", cause: "declined" } },
    { id: 4, previousEventId: 3, type: "TaskStateExited", timestamp: at(1.5), stateExitedEventDetails: { name: "Charge", output: "{\"error\":\"PaymentError\"}" } },
    { id: 5, previousEventId: 4, type: "PassStateEntered", timestamp: at(1.6), stateEnteredEventDetails: { name: "Refund", input: "{}" } },
    { id: 6, previousEventId: 5, type: "PassStateExited", timestamp: at(1.7), stateExitedEventDetails: { name: "Refund", output: "{}" } },
    { id: 7, previousEventId: 6, type: "FailStateEntered", timestamp: at(1.8), stateEnteredEventDetails: { name: "Declined", input: "{}" } },
    { id: 8, previousEventId: 7, type: "ExecutionFailed", timestamp: at(2), executionFailedEventDetails: { error: "Declined" } },
  ];
  const execution = { status: "FAILED", startDate: at(0), stopDate: at(2) };
  const model = executionPresentation(definition, events, "FAILED");
  const results = stateResults(model, execution);
  assert.deepEqual([...results.values()].map((item: any) => [item.name, item.status]), [["Charge", "CAUGHT_ERROR"], ["Refund", "SUCCEEDED"], ["Ship", "NOT_STARTED"], ["Declined", "FAILED"]]);
  const charge: any = results.get("Charge");
  assert.equal(charge.resource, "lambda:invoke");
  assert.deepEqual(charge.visits[0].input, { state: "present", value: "{\"order\":1}" });
  assert.deepEqual(charge.visits[0].output, { state: "present", value: "{\"error\":\"PaymentError\"}" });
  assert.equal(Math.round(charge.startedAfter), 10);
  assert.equal(Math.round(charge.duration), 1490);
  assert.equal(charge.error, "PaymentError");
  assert.equal(stateTransitionCount(model), 3);

  const running = stateResults(executionPresentation(definition, events.slice(0, 2), "RUNNING"), { status: "RUNNING", startDate: at(0) });
  assert.equal((running.get("Charge") as any).status, "IN_PROGRESS");
  const aborted = stateResults(executionPresentation(definition, events.slice(0, 2), "ABORTED"), { status: "ABORTED", startDate: at(0), stopDate: at(3) });
  assert.equal((aborted.get("Charge") as any).status, "CANCELLED");
  assert.equal(Math.round((aborted.get("Charge") as any).duration), 2990);
});

test("a generated execution role grants only what the definition calls", () => {
  const definition = { StartAt: "A", States: {
    A: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: "worker:live" }, Next: "B" },
    B: { Type: "Task", Resource: "arn:aws:states:::dynamodb:putItem", Parameters: { TableName: "orders", Item: {} }, Next: "C" },
    C: { Type: "Task", Resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken", Parameters: { QueueUrl: "http://127.0.0.1:4566/000000000000/jobs", MessageBody: "x" }, Next: "D" },
    D: { Type: "Task", Resource: "arn:aws:states:::states:startExecution.sync", Parameters: { "StateMachineArn.$": "$.child" }, Next: "E" },
    E: { Type: "Pass", End: true },
  } };
  assert.deepEqual(executionRoleStatements(definition), [
    { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: ["arn:aws:lambda:*:*:function:worker", "arn:aws:lambda:*:*:function:worker:*"] },
    { Effect: "Allow", Action: ["dynamodb:PutItem"], Resource: ["arn:aws:dynamodb:*:*:table/orders"] },
    { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:*:*:jobs"] },
    { Effect: "Allow", Action: ["states:StartExecution"], Resource: ["*"] },
    { Effect: "Allow", Action: ["states:DescribeExecution", "states:StopExecution"], Resource: ["*"] },
  ]);
  assert.deepEqual(executionRoleStatements({ StartAt: "P", States: { P: { Type: "Pass", End: true } } }), []);
  assert.equal(executionRoleTrustPolicy().Statement[0].Principal.Service, "states.amazonaws.com");
  assert.equal(generatedRoleName("order flow!", "abc"), "StepFunctions-orderflow-role-abc");
});

test("tag rows validate and become TagResource and UntagResource changes", () => {
  const current = [{ key: "team", value: "orders" }, { key: "stage", value: "dev" }, { key: "aws:cloudformation:stack-name", value: "Orders" }];
  assert.deepEqual(tagsToRows(current), [{ key: "team", value: "orders" }, { key: "stage", value: "dev" }]);
  const next = rowsToTags([{ key: "team", value: "billing" }, { key: " owner ", value: "ada" }, { key: "", value: "" }]);
  assert.deepEqual(next, { tags: [{ key: "team", value: "billing" }, { key: "owner", value: "ada" }] });
  assert.deepEqual(tagChanges(current, next.tags), { changed: [{ key: "team", value: "billing" }, { key: "owner", value: "ada" }], removed: ["stage"] });
  assert.match(rowsToTags([{ key: "aws:reserved", value: "x" }]).problem, /aws:/);
  assert.match(rowsToTags([{ key: "a", value: "1" }, { key: "a", value: "2" }]).problem, /more than once/);
  assert.match(rowsToTags([{ key: "", value: "orphan" }]).problem, /needs a key/);
});

test("the workflow graph draws every state once, nests branches, and labels choices and catches", () => {
  const definition = { StartAt: "Check", States: {
    Check: { Type: "Choice", Choices: [{ Variable: "$.ready", BooleanEquals: true, Next: "Fan" }], Default: "Wait" },
    Wait: { Type: "Wait", Seconds: 1, Next: "Check" },
    Fan: { Type: "Parallel", Branches: [{ StartAt: "Left", States: { Left: { Type: "Pass", End: true } } }, { StartAt: "Right", States: { Right: { Type: "Pass", End: true } } }], Catch: [{ ErrorEquals: ["States.ALL"], Next: "Failed" }], Next: "Each" },
    Each: { Type: "Map", ItemsPath: "$.items", ItemProcessor: { StartAt: "One", States: { One: { Type: "Pass", End: true } } }, End: true },
    Failed: { Type: "Fail" }, Lost: { Type: "Pass", End: true },
  } };
  const layout = flowLayout(definition);
  const names = layout.items.filter((item: any) => item.kind === "state").map((item: any) => item.name);
  assert.deepEqual([...names].sort(), ["Check", "Each", "Failed", "Fan", "Left", "Lost", "One", "Right", "Wait"]);
  assert.deepEqual(layout.items.filter((item: any) => item.kind === "scope").map((item: any) => item.text), ["Fan · branch 1", "Fan · branch 2", "Each · item processor"]);
  assert.deepEqual(layout.items.filter((item: any) => item.kind === "heading").map((item: any) => item.text), ["Unreachable states"]);
  assert.ok(layout.labels.some((label: any) => label.text === "$.ready == true"));
  assert.ok(layout.labels.some((label: any) => label.text === "Default"));
  assert.ok(layout.labels.some((label: any) => label.text === "Catch States.ALL" && label.kind === "catch"));
  assert.ok(layout.paths.some((path: any) => path.back), "the Wait to Check loop is drawn as a back edge");
  const boxes = layout.items.filter((item: any) => item.kind === "state" && !item.container);
  for (const left of boxes) for (const right of boxes) {
    if (left === right) continue;
    const apart = left.x + left.w <= right.x || right.x + right.w <= left.x || left.y + left.h <= right.y || right.y + right.h <= left.y;
    assert.ok(apart, `${left.name} overlaps ${right.name}`);
  }
  const fan = layout.items.find((item: any) => item.name === "Fan");
  const inner = layout.items.find((item: any) => item.name === "Left");
  assert.ok(inner.x >= fan.x && inner.x + inner.w <= fan.x + fan.w && inner.y >= fan.y && inner.y + inner.h <= fan.y + fan.h, "branch states sit inside the Parallel group");

  const results = new Map([["Check", { status: "SUCCEEDED" }], ["Fan", { status: "IN_PROGRESS", waitingForCallback: true }]]);
  const html = flowGraphHtml(definition, { mode: "execution", results, selectedName: "Fan" });
  assert.match(html, /aria-label="Inspect Fan state"/);
  assert.match(html, /status-in-progress active selected/);
  assert.match(html, /Waiting for callback/);
  assert.match(flowGraphHtml(definition, { mode: "design" }), /data-studio-select="Check"[^>]*aria-label="Edit Check state"/);
  assert.doesNotMatch(flowGraphHtml(definition, { mode: "design" }), /data-studio-select="Left"/);
  assert.match(flowGraphHtml("{not json"), /could not be parsed/);
});
