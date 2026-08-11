import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  DeleteScheduleCommand,
  DeleteScheduleGroupCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ListScheduleGroupsCommand,
  ListSchedulesCommand,
  ListTagsForResourceCommand,
  SchedulerClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { AwsError } from "../src/errors.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const active: Array<{ simulator: StackSim; root: string; clients: Array<{ destroy(): void }> }> = [];

async function harness(start = "2026-07-27T09:00:00.000Z", authMode: "off" | "enforce" = "off") {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-scheduler-"));
  const clock = new TestClock(Date.parse(start));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode, cdkBootstrap: true });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const options = { endpoint, region, credentials };
  const scheduler = new SchedulerClient(options);
  const events = new EventBridgeClient(options);
  const iam = new IAMClient(options);
  const lambda = new LambdaClient(options);
  const sqs = new SQSClient(options);
  const sts = new STSClient(options);
  const clients = [scheduler, events, iam, lambda, sqs, sts];
  active.push({ simulator, root, clients });
  return { root, clock, simulator, endpoint, scheduler, events, iam, lambda, sqs, sts, clients };
}

async function restartHarness(h: Awaited<ReturnType<typeof harness>>) {
  for (const client of h.clients) client.destroy();
  await h.simulator.stop();
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock: h.clock, authMode: "off", cdkBootstrap: true });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const options = { endpoint, region, credentials };
  const scheduler = new SchedulerClient(options);
  const events = new EventBridgeClient(options);
  const iam = new IAMClient(options);
  const lambda = new LambdaClient(options);
  const sqs = new SQSClient(options);
  const sts = new STSClient(options);
  const clients = [scheduler, events, iam, lambda, sqs, sts];
  const registration = active.find(item => item.simulator === h.simulator)!;
  registration.simulator = simulator;
  registration.clients = clients;
  return { root: h.root, clock: h.clock, simulator, endpoint, scheduler, events, iam, lambda, sqs, sts, clients };
}

afterEach(async () => {
  while (active.length) {
    const item = active.pop()!;
    for (const client of item.clients) client.destroy();
    await item.simulator.stop().catch(() => undefined);
    await rm(item.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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

async function schedulerRole(iam: IAMClient, name = "scheduler-runtime"): Promise<string> {
  const role = await iam.send(new CreateRoleCommand({
    RoleName: name,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
  }));
  await iam.send(new PutRolePolicyCommand({
    RoleName: name,
    PolicyName: "targets",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["sqs:SendMessage", "lambda:InvokeFunction", "events:PutEvents", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }],
    }),
  }));
  return role.Role!.Arn!;
}

test("official Scheduler client covers all 12 operations and a one-time SQS delivery", async () => {
  const h = await harness();
  const roleArn = await schedulerRole(h.iam);
  const queueName = "scheduler-delivery";
  const queueUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: queueName }))).QueueUrl!;
  const queueArn = `arn:aws:sqs:${region}:${account}:${queueName}`;

  const group = await h.scheduler.send(new CreateScheduleGroupCommand({
    Name: "learning",
    ClientToken: "group-token",
    Tags: [{ Key: "course", Value: "events" }],
  }));
  assert.equal(group.ScheduleGroupArn, `arn:aws:scheduler:${region}:${account}:schedule-group/learning`);
  assert.equal((await h.scheduler.send(new GetScheduleGroupCommand({ Name: "learning" }))).State, "ACTIVE");
  assert.deepEqual((await h.scheduler.send(new ListScheduleGroupsCommand({ NamePrefix: "learn" }))).ScheduleGroups?.map(item => item.Name), ["learning"]);
  await h.scheduler.send(new TagResourceCommand({ ResourceArn: group.ScheduleGroupArn!, Tags: [{ Key: "owner", Value: "local" }] }));
  await h.scheduler.send(new UntagResourceCommand({ ResourceArn: group.ScheduleGroupArn!, TagKeys: ["course"] }));
  assert.deepEqual((await h.scheduler.send(new ListTagsForResourceCommand({ ResourceArn: group.ScheduleGroupArn! }))).Tags, [{ Key: "owner", Value: "local" }]);

  const createInput = {
    Name: "once",
    GroupName: "learning",
    ClientToken: "schedule-token",
    ScheduleExpression: "at(2026-07-27T09:01:00)",
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" as const },
    Target: { Arn: queueArn, RoleArn: roleArn, Input: JSON.stringify({ delivered: 1 }) },
  };
  const created = await h.scheduler.send(new CreateScheduleCommand(createInput));
  assert.equal(created.ScheduleArn, `arn:aws:scheduler:${region}:${account}:schedule/learning/once`);
  assert.equal((await h.scheduler.send(new CreateScheduleCommand(createInput))).ScheduleArn, created.ScheduleArn, "matching client tokens are idempotent");
  const described = await h.scheduler.send(new GetScheduleCommand({ Name: "once", GroupName: "learning" }));
  assert.equal(described.ScheduleExpressionTimezone, "UTC");
  assert(described.CreationDate instanceof Date);
  assert.deepEqual((await h.scheduler.send(new ListSchedulesCommand({ GroupName: "learning" }))).Schedules?.map(item => item.Name), ["once"]);

  await assert.rejects(h.scheduler.send(new UpdateScheduleCommand({
    ...createInput,
    ClientToken: "kms-rejected",
    KmsKeyArn: `arn:aws:kms:${region}:${account}:key/11111111-1111-1111-1111-111111111111`,
  })), (error: any) => error.name === "ValidationException" && /later KMS phase/.test(error.message));
  assert.equal((await h.scheduler.send(new GetScheduleCommand({ Name: "once", GroupName: "learning" }))).ScheduleExpression, createInput.ScheduleExpression, "dependency rejection must not mutate the schedule");

  await h.scheduler.send(new UpdateScheduleCommand({
    Name: "once",
    GroupName: "learning",
    ClientToken: "schedule-update",
    ScheduleExpression: "at(2026-07-27T09:02:00)",
    ScheduleExpressionTimezone: "UTC",
    ActionAfterCompletion: "DELETE",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: queueArn, RoleArn: roleArn, Input: JSON.stringify({ delivered: 2 }) },
  }));
  h.clock.advance(120_000);
  await drive(h.clock, () => !Object.values(h.simulator.store.regionState().eventSchedules).some(item => item.groupName === "learning" && item.name === "once"));
  const message = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0 }));
  assert.deepEqual(JSON.parse(message.Messages![0].Body!), { delivered: 2 });
  await assert.rejects(h.scheduler.send(new GetScheduleCommand({ Name: "once", GroupName: "learning" })), (error: any) => error.name === "ResourceNotFoundException");

  await h.scheduler.send(new CreateScheduleCommand({ ...createInput, Name: "discard", ClientToken: "discard-token", ScheduleExpression: "at(2026-07-27T10:00:00)" }));
  await h.scheduler.send(new DeleteScheduleCommand({ Name: "discard", GroupName: "learning" }));
  await h.scheduler.send(new DeleteScheduleGroupCommand({ Name: "learning" }));
  h.clock.advance(1);
  await assert.rejects(h.scheduler.send(new GetScheduleGroupCommand({ Name: "learning" })), (error: any) => error.name === "ResourceNotFoundException");
});

test("legacy EventBridge rate rules emit the AWS scheduled-event envelope on the default bus", async () => {
  const h = await harness();
  const functionName = "legacy-schedule-target";
  const functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}`;
  await h.lambda.send(new CreateFunctionCommand({
    FunctionName: functionName,
    Runtime: "nodejs22.x",
    Role: `arn:aws:iam::${account}:role/test`,
    Handler: "index.handler",
    Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => ({ ok: true });" }]) },
  }));
  const deliveries: Array<{ arn: string; payload: any }> = [];
  (h.simulator.lambda as any).enqueueServiceInvocation = async (arn: string, payload: Buffer) => {
    deliveries.push({ arn, payload: JSON.parse(payload.toString("utf8")) });
    return "accepted";
  };
  const rule = await h.events.send(new PutRuleCommand({ Name: "every-minute", ScheduleExpression: "rate(1 minute)", State: "ENABLED" }));
  await h.events.send(new PutTargetsCommand({ Rule: "every-minute", Targets: [{ Id: "lambda", Arn: functionArn }] }));
  h.clock.advance(60_000);
  await drive(h.clock, () => deliveries.length === 1);
  assert.equal(deliveries[0].arn, functionArn);
  assert.equal(deliveries[0].payload.source, "aws.events");
  assert.equal(deliveries[0].payload["detail-type"], "Scheduled Event");
  assert.deepEqual(deliveries[0].payload.resources, [rule.RuleArn]);
  assert.deepEqual(deliveries[0].payload.detail, {});
});

test("Scheduler create requires exact iam:PassRole with scheduler.amazonaws.com context", async () => {
  const h = await harness(new Date().toISOString(), "enforce");
  const targetRoleArn = await schedulerRole(h.iam, "scheduler-pass-target");
  await h.sqs.send(new CreateQueueCommand({ QueueName: "scheduler-passrole" }));
  const caller = await h.iam.send(new CreateRoleCommand({
    RoleName: "scheduler-configurer",
    AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }] }),
  }));
  const callerPolicy = (passRole: boolean) => JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "scheduler:CreateSchedule", Resource: "*" },
      ...(passRole ? [{ Effect: "Allow", Action: "iam:PassRole", Resource: targetRoleArn, Condition: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } } }] : []),
    ],
  });
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "scheduler-configurer", PolicyName: "configure", PolicyDocument: callerPolicy(false) }));
  const assumed = await h.sts.send(new AssumeRoleCommand({ RoleArn: caller.Role!.Arn!, RoleSessionName: "scheduler-configurer" }));
  const callerClient = new SchedulerClient({
    endpoint: h.endpoint,
    region,
    credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! },
  });
  h.clients.push(callerClient);
  const input = {
    Name: "passrole-check",
    ScheduleExpression: "at(2030-07-27T10:00:00)",
    FlexibleTimeWindow: { Mode: "OFF" as const },
    Target: { Arn: `arn:aws:sqs:${region}:${account}:scheduler-passrole`, RoleArn: targetRoleArn },
  };
  await assert.rejects(callerClient.send(new CreateScheduleCommand(input)), (error: any) => error.name === "AccessDeniedException" && /iam:PassRole/.test(error.message));
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "scheduler-configurer", PolicyName: "configure", PolicyDocument: callerPolicy(true) }));
  assert.match((await callerClient.send(new CreateScheduleCommand(input))).ScheduleArn!, /schedule\/default\/passrole-check$/);
});

test("DUG-05 keeps a backoff occurrence immutable across update and restart", async () => {
  let h = await harness("2026-08-03T09:00:00.000Z");
  const roleArn = await schedulerRole(h.iam);
  const oldQueueUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-old" }))).QueueUrl!;
  const newQueueUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-new" }))).QueueUrl!;
  const oldQueueArn = `arn:aws:sqs:${region}:${account}:dug05-old`;
  const newQueueArn = `arn:aws:sqs:${region}:${account}:dug05-new`;
  const originalSend = (h.simulator.sqs as any).sendAuthorizedMessageToArn.bind(h.simulator.sqs);
  let failedBody: string | undefined;
  (h.simulator.sqs as any).sendAuthorizedMessageToArn = async (arn: string, input: any, principal: any) => {
    if (arn === oldQueueArn && failedBody === undefined) {
      failedBody = input.MessageBody;
      throw new AwsError("InternalServerError", "injected retryable target failure", 500);
    }
    return originalSend(arn, input, principal);
  };

  await h.scheduler.send(new CreateScheduleCommand({
    Name: "immutable-backoff",
    ScheduleExpression: "rate(1 minute)",
    StartDate: new Date("2026-08-03T09:01:00.000Z"),
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: oldQueueArn, RoleArn: roleArn, RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 60 } },
  }));
  h.clock.advance(60_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "immutable-backoff" && item.status === "QUEUED" && item.attempts === 1));
  const admitted = Object.values(h.simulator.store.regionState().eventScheduleOccurrences).find(item => item.scheduleName === "immutable-backoff")!;
  assert.equal(JSON.parse(failedBody!).id, admitted.eventId);

  await h.scheduler.send(new UpdateScheduleCommand({
    Name: "immutable-backoff",
    ScheduleExpression: "rate(2 minutes)",
    StartDate: new Date("2026-08-03T09:02:00.000Z"),
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: newQueueArn, RoleArn: roleArn, Input: JSON.stringify({ configuration: "new" }) },
  }));
  h = await restartHarness(h);
  h.clock.advance(1_000);
  await drive(h.clock, () => h.simulator.store.regionState().eventScheduleOccurrences[admitted.occurrenceId]?.status === "SUCCEEDED");
  const oldDelivery = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: oldQueueUrl, WaitTimeSeconds: 0 }));
  assert.equal(oldDelivery.Messages?.[0]?.Body, failedBody, "the retry must use the admitted target, payload, and event ID");
  assert.equal((await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: newQueueUrl, WaitTimeSeconds: 0 }))).Messages, undefined);

  h.clock.advance(59_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "immutable-backoff" && item.occurrenceId !== admitted.occurrenceId && item.status === "SUCCEEDED"));
  const nextDelivery = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: newQueueUrl, WaitTimeSeconds: 0 }));
  assert.deepEqual(JSON.parse(nextDelivery.Messages![0].Body!), { configuration: "new" });
});

test("DUG-05 sends a leased occurrence to its admitted DLQ after update", async () => {
  const h = await harness("2026-08-03T10:00:00.000Z");
  const roleArn = await schedulerRole(h.iam);
  const oldTargetArn = `arn:aws:sqs:${region}:${account}:dug05-leased-old`;
  const newTargetArn = `arn:aws:sqs:${region}:${account}:dug05-leased-new`;
  const oldDlqArn = `arn:aws:sqs:${region}:${account}:dug05-dlq-old`;
  const newDlqArn = `arn:aws:sqs:${region}:${account}:dug05-dlq-new`;
  await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-leased-old" }));
  const newTargetUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-leased-new" }))).QueueUrl!;
  const oldDlqUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-dlq-old" }))).QueueUrl!;
  const newDlqUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-dlq-new" }))).QueueUrl!;
  const originalSend = (h.simulator.sqs as any).sendAuthorizedMessageToArn.bind(h.simulator.sqs);
  let releaseTarget!: () => void;
  let releaseDlq!: () => void;
  const targetGate = new Promise<void>(resolve => { releaseTarget = resolve; });
  const dlqGate = new Promise<void>(resolve => { releaseDlq = resolve; });
  (h.simulator.sqs as any).sendAuthorizedMessageToArn = async (arn: string, input: any, principal: any) => {
    if (arn === oldTargetArn) { await targetGate; throw new AwsError("AccessDeniedException", "injected terminal target failure", 403); }
    if (arn === oldDlqArn) await dlqGate;
    return originalSend(arn, input, principal);
  };

  await h.scheduler.send(new CreateScheduleCommand({
    Name: "immutable-lease",
    ScheduleExpression: "at(2026-08-03T10:01:00)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: oldTargetArn, RoleArn: roleArn, Input: JSON.stringify({ configuration: "old" }), DeadLetterConfig: { Arn: oldDlqArn }, RetryPolicy: { MaximumRetryAttempts: 0 } },
  }));
  h.clock.advance(60_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "immutable-lease" && item.status === "LEASED"));
  const admitted = Object.values(h.simulator.store.regionState().eventScheduleOccurrences).find(item => item.scheduleName === "immutable-lease")!;

  await h.scheduler.send(new UpdateScheduleCommand({
    Name: "immutable-lease",
    ScheduleExpression: "at(2026-08-03T10:02:00)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: newTargetArn, RoleArn: roleArn, Input: JSON.stringify({ configuration: "new" }), DeadLetterConfig: { Arn: newDlqArn } },
  }));
  releaseTarget();
  await drive(h.clock, () => h.simulator.store.regionState().eventScheduleOccurrences[admitted.occurrenceId]?.status === "DLQ_LEASED");
  await h.scheduler.send(new UpdateScheduleCommand({
    Name: "immutable-lease",
    ScheduleExpression: "at(2026-08-03T10:02:00)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: newTargetArn, RoleArn: roleArn, Input: JSON.stringify({ configuration: "newest" }), DeadLetterConfig: { Arn: newDlqArn } },
  }));
  releaseDlq();
  await drive(h.clock, () => h.simulator.store.regionState().eventScheduleOccurrences[admitted.occurrenceId]?.status === "DLQ_SENT");
  const oldDlqDelivery = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: oldDlqUrl, WaitTimeSeconds: 0, MessageAttributeNames: ["All"] }));
  assert.deepEqual(JSON.parse(oldDlqDelivery.Messages![0].Body!), { configuration: "old" });
  assert.equal(oldDlqDelivery.Messages![0].MessageAttributes?.TARGET_ARN.StringValue, oldTargetArn);
  assert.equal((await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: newDlqUrl, WaitTimeSeconds: 0 }))).Messages, undefined);

  h.clock.advance(60_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "immutable-lease" && item.occurrenceId !== admitted.occurrenceId && item.status === "SUCCEEDED"));
  const newDelivery = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: newTargetUrl, WaitTimeSeconds: 0 }));
  assert.deepEqual(JSON.parse(newDelivery.Messages![0].Body!), { configuration: "newest" });
});

test("DUG-05 delete and group deletion preserve an already admitted occurrence", async () => {
  const h = await harness("2026-08-03T11:00:00.000Z");
  const roleArn = await schedulerRole(h.iam);
  const queueArn = `arn:aws:sqs:${region}:${account}:dug05-delete-target`;
  const queueUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-delete-target" }))).QueueUrl!;
  await h.scheduler.send(new CreateScheduleGroupCommand({ Name: "dug05-delete-group" }));
  const originalSend = (h.simulator.sqs as any).sendAuthorizedMessageToArn.bind(h.simulator.sqs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  (h.simulator.sqs as any).sendAuthorizedMessageToArn = async (arn: string, input: any, principal: any) => {
    if (arn === queueArn) await gate;
    return originalSend(arn, input, principal);
  };
  await h.scheduler.send(new CreateScheduleCommand({
    Name: "admitted-delete",
    GroupName: "dug05-delete-group",
    ScheduleExpression: "at(2026-08-03T11:01:00)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: queueArn, RoleArn: roleArn, Input: JSON.stringify({ committed: true }) },
  }));
  h.clock.advance(60_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "admitted-delete" && item.status === "LEASED"));
  const admitted = Object.values(h.simulator.store.regionState().eventScheduleOccurrences).find(item => item.scheduleName === "admitted-delete")!;
  await h.scheduler.send(new DeleteScheduleCommand({ Name: "admitted-delete", GroupName: "dug05-delete-group" }));
  await h.scheduler.send(new DeleteScheduleGroupCommand({ Name: "dug05-delete-group" }));
  h.clock.advance(1);
  assert.equal((await h.scheduler.send(new GetScheduleGroupCommand({ Name: "dug05-delete-group" }))).State, "DELETING");
  release();
  await drive(h.clock, () => h.simulator.store.regionState().eventScheduleOccurrences[admitted.occurrenceId]?.status === "SUCCEEDED");
  await drive(h.clock, () => {
    h.clock.advance(1);
    return h.simulator.store.regionState().eventScheduleGroups["dug05-delete-group"] === undefined;
  });
  const delivery = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0 }));
  assert.deepEqual(JSON.parse(delivery.Messages![0].Body!), { committed: true });
});

test("DUG-05 freezes the execution role and records a deterministic DLQ failure", async () => {
  const h = await harness("2026-08-03T12:00:00.000Z");
  const oldRoleArn = await schedulerRole(h.iam, "dug05-old-role");
  const newRoleArn = await schedulerRole(h.iam, "dug05-new-role");
  const oldTargetArn = `arn:aws:sqs:${region}:${account}:dug05-role-old`;
  const newTargetArn = `arn:aws:sqs:${region}:${account}:dug05-role-new`;
  const oldDlqArn = `arn:aws:sqs:${region}:${account}:dug05-role-dlq`;
  await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-role-old" }));
  const newTargetUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-role-new" }))).QueueUrl!;
  const oldDlqUrl = (await h.sqs.send(new CreateQueueCommand({ QueueName: "dug05-role-dlq" }))).QueueUrl!;
  const originalSend = (h.simulator.sqs as any).sendAuthorizedMessageToArn.bind(h.simulator.sqs);
  let firstFailure = true;
  (h.simulator.sqs as any).sendAuthorizedMessageToArn = async (arn: string, input: any, principal: any) => {
    if (arn === oldTargetArn && firstFailure) { firstFailure = false; throw new AwsError("InternalServerError", "injected retry", 500); }
    return originalSend(arn, input, principal);
  };
  await h.scheduler.send(new CreateScheduleCommand({
    Name: "immutable-role",
    ScheduleExpression: "at(2026-08-03T12:01:00)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: oldTargetArn, RoleArn: oldRoleArn, Input: JSON.stringify({ configuration: "old-role" }), DeadLetterConfig: { Arn: oldDlqArn }, RetryPolicy: { MaximumRetryAttempts: 1 } },
  }));
  h.clock.advance(60_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "immutable-role" && item.status === "QUEUED" && item.attempts === 1));
  const admitted = Object.values(h.simulator.store.regionState().eventScheduleOccurrences).find(item => item.scheduleName === "immutable-role")!;
  await h.scheduler.send(new UpdateScheduleCommand({
    Name: "immutable-role",
    ScheduleExpression: "at(2026-08-03T12:02:00)",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: { Arn: newTargetArn, RoleArn: newRoleArn, Input: JSON.stringify({ configuration: "new-role" }) },
  }));
  await h.iam.send(new DeleteRolePolicyCommand({ RoleName: "dug05-old-role", PolicyName: "targets" }));
  await h.iam.send(new DeleteRoleCommand({ RoleName: "dug05-old-role" }));
  h.clock.advance(1_000);
  await drive(h.clock, () => h.simulator.store.regionState().eventScheduleOccurrences[admitted.occurrenceId]?.status === "DLQ_FAILED");
  const failed = h.simulator.store.regionState().eventScheduleOccurrences[admitted.occurrenceId];
  assert.match(failed.lastError!, /^ValidationException:/);
  assert.match(failed.deadLetterError!, /^AccessDeniedException:/);
  assert.equal((await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: oldDlqUrl, WaitTimeSeconds: 0 }))).Messages, undefined);
  h.clock.advance(59_000);
  await drive(h.clock, () => Object.values(h.simulator.store.regionState().eventScheduleOccurrences).some(item => item.scheduleName === "immutable-role" && item.occurrenceId !== admitted.occurrenceId && item.status === "SUCCEEDED"));
  const next = await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: newTargetUrl, WaitTimeSeconds: 0 }));
  assert.deepEqual(JSON.parse(next.Messages![0].Body!), { configuration: "new-role" });
});

test("DUG-05 schema migration freezes a legacy pending delivery as an occurrence", () => {
  const state = emptyState(account, region) as any;
  state.schemaVersion = 73;
  const regional = state.accounts[account].regions[region];
  delete regional.eventScheduleOccurrences;
  regional.eventSchedules["default\0legacy"] = {
    name: "legacy",
    groupName: "default",
    arn: `arn:aws:scheduler:${region}:${account}:schedule/default/legacy`,
    scheduleExpression: "rate(1 minute)",
    scheduleExpressionTimezone: "UTC",
    state: "ENABLED",
    flexibleTimeWindow: { mode: "OFF" },
    target: { arn: `arn:aws:sqs:${region}:${account}:legacy`, roleArn: `arn:aws:iam::${account}:role/legacy`, maximumEventAgeInSeconds: 60, maximumRetryAttempts: 2 },
    actionAfterCompletion: "NONE",
    creationDate: Date.parse("2026-08-03T12:00:00.000Z"),
    lastModificationDate: Date.parse("2026-08-03T12:00:00.000Z"),
    pendingDelivery: { scheduledAt: Date.parse("2026-08-03T12:01:00.000Z"), invocationAt: Date.parse("2026-08-03T12:01:00.000Z"), attempts: 1, nextAttemptAt: Date.parse("2026-08-03T12:01:01.000Z"), status: "QUEUED", lastError: "InternalServerError: retry" },
  };
  const migrated = migrateState(state, account, region).state as any;
  const schedule = migrated.accounts[account].regions[region].eventSchedules["default\0legacy"];
  const occurrence = Object.values(migrated.accounts[account].regions[region].eventScheduleOccurrences)[0] as any;
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(schedule.pendingDelivery, undefined);
  assert.equal(occurrence.scheduleGeneration, schedule.generation);
  assert.equal(occurrence.status, "QUEUED");
  assert.equal(occurrence.attempts, 1);
  assert.equal(JSON.parse(occurrence.payload).id, occurrence.eventId);
  assert.equal(occurrence.target.arn, `arn:aws:sqs:${region}:${account}:legacy`);
});
