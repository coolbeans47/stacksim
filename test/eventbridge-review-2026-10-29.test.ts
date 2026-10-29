// Focused tests for the EventBridge review repairs of 2026-10-29 (stacksim-designs/eventbridge-review-2026-10-29.md, EVB-09).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CreateArchiveCommand, CreateEventBusCommand, DeleteArchiveCommand, DeleteEventBusCommand, DeleteRuleCommand, DescribeArchiveCommand, DescribeRuleCommand, DisableRuleCommand,
  EventBridgeClient, ListRulesCommand, PutEventsCommand, PutRuleCommand, PutTargetsCommand, TagResourceCommand,
} from "@aws-sdk/client-eventbridge";
import { CreateScheduleCommand, CreateScheduleGroupCommand, ListSchedulesCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { AwsError } from "../src/errors.js";
import { parseEventPattern, testEventPattern } from "../src/eventbridge/pattern.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const active: Array<{ simulator: StackSim; root: string; clients: Array<{ destroy(): void }> }> = [];

async function harness(start = "2026-10-29T10:00:00.000Z") {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-review-"));
  const clock = new TestClock(Date.parse(start));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: false });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const options = { endpoint, region, credentials };
  const events = new EventBridgeClient(options); const scheduler = new SchedulerClient(options); const iam = new IAMClient(options); const sqs = new SQSClient(options);
  const clients = [events, scheduler, iam, sqs];
  active.push({ simulator, root, clients });
  return { simulator, clock, endpoint, events, scheduler, iam, sqs };
}

afterEach(async () => {
  while (active.length) {
    const entry = active.pop()!;
    for (const client of entry.clients) client.destroy();
    await entry.simulator.stop();
    await rm(entry.root, { recursive: true, force: true });
  }
});

async function drive(clock: TestClock, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    clock.advance(0);
    if (Date.now() >= deadline) throw new Error("Timed out driving the Scheduler worker");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function schedulerRole(iam: IAMClient, name: string, resources: string[]): Promise<string> {
  const role = await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: "targets", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sqs:SendMessage"], Resource: resources }] }) }));
  return role.Role!.Arn!;
}

async function rejects(promise: Promise<unknown>, name: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: any) => { assert.equal(error.name, name); if (pattern) assert.match(String(error.message), pattern); return true; });
}

test("API-01: ListSchedules honors the SDK's ScheduleGroup query parameter", async () => {
  const h = await harness();
  const roleArn = await schedulerRole(h.iam, "review-list-role", ["*"]);
  await h.sqs.send(new CreateQueueCommand({ QueueName: "review-list-queue" }));
  const target = { Arn: `arn:aws:sqs:${region}:${account}:review-list-queue`, RoleArn: roleArn };
  await h.scheduler.send(new CreateScheduleGroupCommand({ Name: "g1" }));
  await h.scheduler.send(new CreateScheduleCommand({ Name: "s1", GroupName: "g1", ScheduleExpression: "rate(1 hour)", FlexibleTimeWindow: { Mode: "OFF" }, Target: target }));
  await h.scheduler.send(new CreateScheduleCommand({ Name: "s2", ScheduleExpression: "rate(1 hour)", FlexibleTimeWindow: { Mode: "OFF" }, Target: target }));
  assert.deepEqual((await h.scheduler.send(new ListSchedulesCommand({ GroupName: "g1" }))).Schedules?.map(item => `${item.GroupName}/${item.Name}`), ["g1/s1"]);
  assert.deepEqual((await h.scheduler.send(new ListSchedulesCommand({ GroupName: "default" }))).Schedules?.map(item => item.Name), ["s2"]);
  assert.deepEqual((await h.scheduler.send(new ListSchedulesCommand({}))).Schedules?.map(item => item.Name), ["s1", "s2"]);
  const raw = await fetch(`${h.endpoint}/schedules?ScheduleGroup=g1`, { headers: { "x-stacksim-service": "scheduler" } }).then(response => response.json());
  assert.deepEqual(raw.Schedules.map((item: any) => item.Name), ["s1"]);
});

test("API-02: numeric pattern operands follow the IEEE-754 double rule with exact integers to 2^53", () => {
  assert.doesNotThrow(() => parseEventPattern('{"detail":{"n":[{"numeric":[">",6000000000]}]}}'));
  assert.doesNotThrow(() => parseEventPattern('{"detail":{"n":[{"numeric":["=",1.1234567]}]}}'));
  assert.equal(testEventPattern('{"detail":{"ts":[{"numeric":[">",1700000000000,"<",1800000000000]}]}}', '{"detail":{"ts":1761735600000}}'), true);
  assert.equal(testEventPattern('{"detail":{"n":[{"numeric":["=",9007199254740992]}]}}', '{"detail":{"n":9007199254740992}}'), true);
  assert.throws(() => parseEventPattern('{"detail":{"n":[{"numeric":["=",9007199254740993]}]}}'), /9007199254740992/);
  assert.throws(() => parseEventPattern('{"detail":{"n":[{"numeric":["=",-9007199254740993]}]}}'), /9007199254740992/);
});

test("API-03: an archive creates the AWS managed rule on its source bus and removes it with the archive", async () => {
  const h = await harness();
  const busArn = `arn:aws:events:${region}:${account}:event-bus/review-bus`;
  await h.events.send(new CreateEventBusCommand({ Name: "review-bus" }));
  await h.events.send(new CreateArchiveCommand({ ArchiveName: "orders", EventSourceArn: busArn }));
  const rules = (await h.events.send(new ListRulesCommand({ EventBusName: "review-bus" }))).Rules ?? [];
  assert.deepEqual(rules.map(rule => [rule.Name, rule.ManagedBy, rule.EventPattern, rule.State]), [["Events-Archive-orders", "prs.events.amazonaws.com", '{"replay-name":[{"exists":false}]}', "ENABLED"]]);
  const described = await h.events.send(new DescribeRuleCommand({ Name: "Events-Archive-orders", EventBusName: "review-bus" }));
  assert.equal(described.ManagedBy, "prs.events.amazonaws.com"); assert.equal(described.CreatedBy, account, "API-07: DescribeRule returns CreatedBy");
  assert.equal(described.Arn, `arn:aws:events:${region}:${account}:rule/review-bus/Events-Archive-orders`);
  await rejects(h.events.send(new PutRuleCommand({ Name: "Events-Archive-orders", EventBusName: "review-bus", EventPattern: "{\"source\":[\"x\"]}" })), "ManagedRuleException");
  await rejects(h.events.send(new DisableRuleCommand({ Name: "Events-Archive-orders", EventBusName: "review-bus" })), "ManagedRuleException");
  await rejects(h.events.send(new PutTargetsCommand({ Rule: "Events-Archive-orders", EventBusName: "review-bus", Targets: [{ Id: "t", Arn: `arn:aws:lambda:${region}:${account}:function:f` }] })), "ManagedRuleException");
  await rejects(h.events.send(new TagResourceCommand({ ResourceARN: described.Arn!, Tags: [{ Key: "a", Value: "b" }] })), "ManagedRuleException");
  await rejects(h.events.send(new DeleteRuleCommand({ Name: "Events-Archive-orders", EventBusName: "review-bus" })), "ManagedRuleException");
  await rejects(h.events.send(new CreateArchiveCommand({ ArchiveName: "orders", EventSourceArn: busArn })), "ResourceAlreadyExistsException");
  await h.events.send(new PutEventsCommand({ Entries: [{ EventBusName: "review-bus", Source: "review", DetailType: "t", Detail: "{}" }] }));
  assert.equal((await h.events.send(new DescribeArchiveCommand({ ArchiveName: "orders" }))).EventCount, 1, "capture is unchanged by the managed rule");
  await rejects(h.events.send(new DeleteEventBusCommand({ Name: "review-bus" })), "ValidationException", /archives/);
  await h.events.send(new DeleteArchiveCommand({ ArchiveName: "orders" }));
  assert.deepEqual((await h.events.send(new ListRulesCommand({ EventBusName: "review-bus" }))).Rules, [], "the managed rule is deleted with its archive");
  await h.events.send(new DeleteEventBusCommand({ Name: "review-bus" }));
  // A customer rule that already uses the managed name blocks the archive instead of being hijacked.
  await h.events.send(new PutRuleCommand({ Name: "Events-Archive-taken", EventPattern: "{\"source\":[\"x\"]}" }));
  await rejects(h.events.send(new CreateArchiveCommand({ ArchiveName: "taken", EventSourceArn: `arn:aws:events:${region}:${account}:event-bus/default` })), "ResourceAlreadyExistsException");
  // Force delete still removes a managed rule, as on AWS.
  await h.events.send(new CreateArchiveCommand({ ArchiveName: "forced", EventSourceArn: `arn:aws:events:${region}:${account}:event-bus/default` }));
  await h.events.send(new DeleteRuleCommand({ Name: "Events-Archive-forced", Force: true }));
  assert.equal((await h.events.send(new ListRulesCommand({}))).Rules?.some(rule => rule.Name === "Events-Archive-forced"), false);
});

test("API-06: inventory actions that are not implemented name their phase; unknown operations are 404 UnknownOperationException", async () => {
  const h = await harness();
  const call = async (target: string) => { const response = await fetch(h.endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": target }, body: "{}" }); return { status: response.status, body: await response.json() }; };
  const permission = await call("AWSEvents.PutPermission");
  assert.equal(permission.status, 400); assert.match(permission.body.__type, /ValidationException$/); assert.match(permission.body.message, /PutPermission requires EVB-06/);
  const endpoint = await call("AWSEvents.CreateEndpoint");
  assert.match(endpoint.body.message, /CreateEndpoint requires EVB-08/);
  const unknown = await call("AWSEvents.FooBar");
  assert.equal(unknown.status, 404); assert.match(unknown.body.__type, /UnknownOperationException$/);
});

test("API-04/API-05: Scheduler substitutes context attributes and dead-letters the documented request and attributes", async () => {
  const h = await harness();
  const allowedArn = `arn:aws:sqs:${region}:${account}:review-allowed`; const deniedArn = `arn:aws:sqs:${region}:${account}:review-denied`; const dlqArn = `arn:aws:sqs:${region}:${account}:review-dlq`;
  const allowedUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "review-allowed" }))).QueueUrl!;
  await h.sqs.send(new CreateQueueCommand({ QueueName: "review-denied" }));
  const dlqUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "review-dlq" }))).QueueUrl!;
  const roleArn = await schedulerRole(h.iam, "review-dlq-role", [allowedArn, dlqArn]);
  const input = JSON.stringify({ arn: "<aws.scheduler.schedule-arn>", when: "<aws.scheduler.scheduled-time>", exec: "<aws.scheduler.execution-id>", attempt: "<aws.scheduler.attempt-number>" });

  await h.scheduler.send(new CreateScheduleCommand({ Name: "context", ScheduleExpression: "at(2026-10-29T10:01:00)", FlexibleTimeWindow: { Mode: "OFF" }, Target: { Arn: allowedArn, RoleArn: roleArn, Input: input } }));
  await h.scheduler.send(new CreateScheduleCommand({ Name: "denied", ScheduleExpression: "at(2026-10-29T10:01:00)", FlexibleTimeWindow: { Mode: "OFF" }, Target: { Arn: deniedArn, RoleArn: roleArn, Input: input, DeadLetterConfig: { Arn: dlqArn } } }));
  h.clock.advance(60_000);
  const occurrences = () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences);
  await drive(h.clock, () => occurrences().filter(item => ["SUCCEEDED", "DLQ_SENT"].includes(item.status)).length === 2);

  const delivered = (await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: allowedUrl, WaitTimeSeconds: 0 }))).Messages![0];
  const context = JSON.parse(delivered.Body!);
  assert.equal(context.arn, `arn:aws:scheduler:${region}:${account}:schedule/default/context`);
  assert.equal(context.when, "2026-10-29T10:01:00Z");
  assert.match(context.exec, /^[0-9a-f]{16}$/);
  assert.equal(context.attempt, "1");

  const deadLetter = (await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 0, MessageAttributeNames: ["All"] }))).Messages![0];
  const attributes = Object.fromEntries(Object.entries(deadLetter.MessageAttributes ?? {}).map(([key, value]) => [key, value.StringValue]));
  assert.equal(deadLetter.MessageAttributes?.RETRY_ATTEMPTS?.DataType, "String");
  assert.equal(attributes.ERROR_CODE, "AccessDeniedException");
  assert.match(attributes.ERROR_MESSAGE!, /cannot perform sqs:SendMessage/);
  assert.match(attributes.EXECUTION_ID!, /^[0-9a-f]{16}$/);
  assert.equal(attributes.IS_PAYLOAD_TRUNCATED, "false");
  assert.equal(attributes.RETRY_ATTEMPTS, "0");
  assert.equal(attributes.SCHEDULED_TIME, "2026-10-29T10:01:00Z");
  assert.equal(attributes.SCHEDULE_ARN, `arn:aws:scheduler:${region}:${account}:schedule/default/denied`);
  assert.equal(attributes.TARGET_ARN, "arn:aws:scheduler:::aws-sdk:sqs:sendMessage");
  assert.equal(attributes.EXHAUSTED_RETRY_CONDITION, undefined, "a permanent error carries no exhausted-retry condition");
  const body = JSON.parse(deadLetter.Body!);
  assert.equal(body.QueueUrl, `https://sqs.${region}.amazonaws.com/${account}/review-denied`);
  assert.equal(JSON.parse(body.MessageBody).exec, attributes.EXECUTION_ID);

  // A retryable failure that exhausts MaximumRetryAttempts carries the condition.
  const originalSend = (h.simulator.sqs as any).sendAuthorizedMessageToArn.bind(h.simulator.sqs);
  (h.simulator.sqs as any).sendAuthorizedMessageToArn = async (arn: string, message: any, caller: any) => { if (arn === allowedArn) throw new AwsError("ServiceUnavailable", "injected", 503); return originalSend(arn, message, caller); };
  await h.scheduler.send(new CreateScheduleCommand({ Name: "exhausted", ScheduleExpression: "at(2026-10-29T10:02:00)", FlexibleTimeWindow: { Mode: "OFF" }, Target: { Arn: allowedArn, RoleArn: roleArn, Input: "{}", DeadLetterConfig: { Arn: dlqArn }, RetryPolicy: { MaximumRetryAttempts: 0 } } }));
  h.clock.advance(60_000);
  await drive(h.clock, () => occurrences().some(item => item.scheduleName === "exhausted" && item.status === "DLQ_SENT"));
  const exhausted = (await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 0, MessageAttributeNames: ["All"] }))).Messages![0];
  assert.equal(exhausted.MessageAttributes?.EXHAUSTED_RETRY_CONDITION?.StringValue, "MaximumRetryAttempts");
  assert.equal(exhausted.MessageAttributes?.ERROR_CODE?.StringValue, "ServiceUnavailable");
});

test("API-08: Scheduler rejects at() without seconds, non-conforming client tokens, and aws. event sources", async () => {
  const h = await harness();
  const roleArn = await schedulerRole(h.iam, "review-validation-role", ["*"]);
  await h.sqs.send(new CreateQueueCommand({ QueueName: "review-validation" }));
  const target = { Arn: `arn:aws:sqs:${region}:${account}:review-validation`, RoleArn: roleArn };
  await rejects(h.scheduler.send(new CreateScheduleCommand({ Name: "no-seconds", ScheduleExpression: "at(2030-01-01T10:00)", FlexibleTimeWindow: { Mode: "OFF" }, Target: target })), "ValidationException", /at\(yyyy-mm-ddThh:mm:ss\)/);
  await rejects(h.scheduler.send(new CreateScheduleCommand({ Name: "bad-token", ClientToken: "not valid!", ScheduleExpression: "rate(1 hour)", FlexibleTimeWindow: { Mode: "OFF" }, Target: target })), "ValidationException", /ClientToken/);
  await rejects(h.scheduler.send(new CreateScheduleCommand({ Name: "aws-source", ScheduleExpression: "rate(1 hour)", FlexibleTimeWindow: { Mode: "OFF" }, Target: { Arn: `arn:aws:events:${region}:${account}:event-bus/default`, RoleArn: roleArn, EventBridgeParameters: { Source: "aws.review", DetailType: "t" } } })), "ValidationException", /cannot begin with aws\./);
  await h.scheduler.send(new CreateScheduleCommand({ Name: "ok", ScheduleExpression: "at(2030-01-01T10:00:00)", FlexibleTimeWindow: { Mode: "OFF" }, Target: target }));
});
