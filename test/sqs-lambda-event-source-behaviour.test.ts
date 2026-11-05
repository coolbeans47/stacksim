import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { waitUntil } from "./support/polling.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

// The function reports every batch it receives to a collector in the test process.
const code = createZip([{ name: "index.mjs", content: `
export async function handler(event) {
  await fetch(process.env.COLLECTOR, { method: "POST", body: JSON.stringify({ name: process.env.NAME, bodies: event.Records.map(record => record.body) }) });
  return process.env.RESPONSE === "null-failures" ? { batchItemFailures: null } : {};
}
` }]);

interface Batch { name: string; bodies: string[]; at: number }

test("SQS event source mappings behave like the Lambda poller", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-esm-behaviour-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  const batches: Batch[] = [];
  const collector: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { batches.push({ ...JSON.parse(Buffer.concat(chunks).toString("utf8")), at: Date.now() }); response.end("ok"); });
  });
  await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
  const collectorUrl = `http://127.0.0.1:${(collector.address() as { port: number }).port}/`;
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const sqs = new SQSClient(options); const lambda = new LambdaClient(options); const iam = new IAMClient(options);
    clients.push(sqs, lambda, iam);
    // A role with no permissions at all: with authorization off, the poller must still deliver.
    const bareRole = (await iam.send(new CreateRoleCommand({ RoleName: "esm-behaviour-bare-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;

    const queue = async (name: string, attributes: Record<string, string> = {}) => {
      const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: "30", ...attributes } }))).QueueUrl!;
      const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
      return { QueueUrl, arn };
    };
    const fn = async (name: string, environment: Record<string, string> = {}, timeout = 5) => (await lambda.send(new CreateFunctionCommand({
      FunctionName: name, Runtime: "nodejs22.x", Role: bareRole, Handler: "index.handler", Timeout: timeout, Code: { ZipFile: code },
      Environment: { Variables: { COLLECTOR: collectorUrl, NAME: name, ...environment } },
    }))).FunctionArn!;
    const received = (name: string) => batches.filter(batch => batch.name === name);
    const bodies = (name: string) => received(name).flatMap(batch => batch.bodies);
    const drained = async (QueueUrl: string) => {
      const attributes = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }))).Attributes!;
      return attributes.ApproximateNumberOfMessages === "0" && attributes.ApproximateNumberOfMessagesNotVisible === "0";
    };

    await t.test("with authorization off, a function whose role has no SQS permissions still receives messages", async () => {
      const source = await queue("esm-unenforced-role");
      const functionArn = await fn("esm-unenforced-role");
      const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, BatchSize: 1 }));
      await sqs.send(new SendMessageCommand({ QueueUrl: source.QueueUrl, MessageBody: "delivered" }));
      await waitUntil(() => bodies("esm-unenforced-role"), value => value.length === 1, { timeoutMs: 15_000 });
      await waitUntil(() => drained(source.QueueUrl), Boolean, { timeoutMs: 15_000 });
      assert.equal((await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID }))).LastProcessingResult, "OK");
    });

    await t.test("a FIFO queue delivers every message of one group, in order, within seconds", async () => {
      const source = await queue("esm-fifo-group.fifo", { FifoQueue: "true", ContentBasedDeduplication: "true" });
      const functionArn = await fn("esm-fifo-group");
      await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, BatchSize: 1 }));
      const started = Date.now();
      const sent = ["m1", "m2", "m3", "m4", "m5"];
      for (const body of sent) await sqs.send(new SendMessageCommand({ QueueUrl: source.QueueUrl, MessageBody: body, MessageGroupId: "one-group" }));
      // Each batch frees the group for the next one; a poller that only noticed after its long poll expired would need 20 seconds per batch.
      await waitUntil(() => bodies("esm-fifo-group"), value => value.length >= sent.length, { timeoutMs: 15_000, timeoutMessage: value => `only ${JSON.stringify(value)} arrived within 15 seconds` });
      assert.deepEqual(bodies("esm-fifo-group"), sent);
      assert.ok(Date.now() - started < 15_000);
    });

    await t.test("a partial batch is invoked when the batching window ends, not when the long poll does", async () => {
      const source = await queue("esm-batching-window");
      const functionArn = await fn("esm-batching-window");
      const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, BatchSize: 5, MaximumBatchingWindowInSeconds: 2 }));
      assert.equal(mapping.MaximumBatchingWindowInSeconds, 2);
      await waitUntil(async () => (await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID }))).State, state => state === "Enabled", { timeoutMs: 15_000 });
      const started = Date.now();
      for (const body of ["w1", "w2", "w3"]) await sqs.send(new SendMessageCommand({ QueueUrl: source.QueueUrl, MessageBody: body }));
      await waitUntil(() => bodies("esm-batching-window"), value => value.length === 3, { timeoutMs: 15_000, timeoutMessage: value => `only ${JSON.stringify(value)} arrived within 15 seconds` });
      const elapsed = received("esm-batching-window").at(-1)!.at - started;
      assert.ok(elapsed < 12_000, `the window is 2 seconds but the batch arrived after ${elapsed}ms`);
      assert.deepEqual(bodies("esm-batching-window").sort(), ["w1", "w2", "w3"]);
    });

    await t.test("event filters follow event-pattern rules and drop only real non-matches", async () => {
      const cases: Array<{ name: string; pattern: unknown; send: unknown[]; expect: unknown[] }> = [
        { name: "array", pattern: { body: { tags: ["a"] } }, send: [{ tags: ["a", "b"] }, { tags: ["c"] }], expect: [{ tags: ["a", "b"] }] },
        { name: "or", pattern: { body: { $or: [{ kind: ["x"] }, { size: [{ numeric: [">", 10] }] }] } }, send: [{ kind: "x" }, { size: 11 }, { kind: "y", size: 1 }], expect: [{ kind: "x" }, { size: 11 }] },
        { name: "numeric", pattern: { body: { price: [{ numeric: [">", 10] }] } }, send: [{ price: "15" }, { price: 15 }, { price: 5 }], expect: [{ price: 15 }] },
        { name: "typed", pattern: { body: { n: ["5"] } }, send: [{ n: "5" }, { n: 5 }], expect: [{ n: "5" }] },
      ];
      for (const item of cases) {
        const name = `esm-filter-${item.name}`;
        const source = await queue(name);
        const functionArn = await fn(name);
        await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, BatchSize: 1, FilterCriteria: { Filters: [{ Pattern: JSON.stringify(item.pattern) }] } }));
        for (const body of item.send) await sqs.send(new SendMessageCommand({ QueueUrl: source.QueueUrl, MessageBody: JSON.stringify(body) }));
        await waitUntil(() => drained(source.QueueUrl), Boolean, { timeoutMs: 20_000, timeoutMessage: `${name} did not drain` });
        await waitUntil(() => bodies(name), value => value.length >= item.expect.length, { timeoutMs: 10_000 });
        assert.deepEqual(bodies(name).map(body => JSON.parse(body)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))), [...item.expect].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))), item.name);
      }
      // An operator the matcher cannot evaluate is refused instead of silently dropping every message.
      const source = await queue("esm-filter-unsupported");
      const functionArn = await fn("esm-filter-unsupported");
      for (const pattern of [{ body: { kind: [{ "not-an-operator": "x" }] } }, { body: { kind: "bare-string" } }]) {
        await assert.rejects(
          lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, FilterCriteria: { Filters: [{ Pattern: JSON.stringify(pattern) }] } })),
          (error: any) => error.name === "InvalidParameterValueException" && /Invalid filter pattern definition/.test(error.message),
        );
      }
      await assert.rejects(
        lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ messageId: ["x"] }) }] } })),
        (error: any) => error.name === "InvalidParameterValueException" && /may only use the body event key/.test(error.message),
      );
    });

    await t.test("a null batchItemFailures list is a complete success", async () => {
      const source = await queue("esm-null-failures", { VisibilityTimeout: "5" });
      const functionArn = await fn("esm-null-failures", { RESPONSE: "null-failures" });
      const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"] }));
      await sqs.send(new SendMessageCommand({ QueueUrl: source.QueueUrl, MessageBody: "once" }));
      await waitUntil(() => drained(source.QueueUrl), Boolean, { timeoutMs: 15_000 });
      assert.deepEqual(bodies("esm-null-failures"), ["once"]);
      // A later empty poll may already have replaced "OK"; what matters is that the batch was not reported as a problem.
      assert.doesNotMatch(String((await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID }))).LastProcessingResult), /^PROBLEM/);
    });

    await t.test("a function timeout above the queue visibility timeout is refused in the Lambda wording", async () => {
      const source = await queue("esm-short-visibility", { VisibilityTimeout: "30" });
      const functionArn = await fn("esm-short-visibility", {}, 60);
      await assert.rejects(
        lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn })),
        (error: any) => error.name === "InvalidParameterValueException" && error.message === "Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds",
      );
    });

    await t.test("MetricsConfig is stored and returned, and ProvisionedPollerConfig is refused", async () => {
      const source = await queue("esm-metrics-config");
      const functionArn = await fn("esm-metrics-config");
      const created = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: source.arn, Enabled: false, MetricsConfig: { Metrics: ["EventCount"] } }));
      assert.deepEqual(created.MetricsConfig, { Metrics: ["EventCount"] });
      assert.deepEqual((await lambda.send(new GetEventSourceMappingCommand({ UUID: created.UUID }))).MetricsConfig, { Metrics: ["EventCount"] });
      const listed = (await lambda.send(new ListEventSourceMappingsCommand({ EventSourceArn: source.arn }))).EventSourceMappings ?? [];
      assert.deepEqual(listed.find(item => item.UUID === created.UUID)?.MetricsConfig, { Metrics: ["EventCount"] });
      // An update that does not mention the property keeps it; an empty list clears it.
      assert.deepEqual((await lambda.send(new UpdateEventSourceMappingCommand({ UUID: created.UUID, BatchSize: 5 }))).MetricsConfig, { Metrics: ["EventCount"] });
      assert.equal((await lambda.send(new UpdateEventSourceMappingCommand({ UUID: created.UUID, MetricsConfig: { Metrics: [] } }))).MetricsConfig, undefined);
      assert.equal((await lambda.send(new GetEventSourceMappingCommand({ UUID: created.UUID }))).MetricsConfig, undefined);
      await assert.rejects(
        lambda.send(new UpdateEventSourceMappingCommand({ UUID: created.UUID, MetricsConfig: { Metrics: ["Unknown" as never] } })),
        (error: any) => error.name === "InvalidParameterValueException" && /only supports EventCount/.test(error.message),
      );
      const other = await queue("esm-provisioned-poller");
      await assert.rejects(
        lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionArn, EventSourceArn: other.arn, ProvisionedPollerConfig: { MinimumPollers: 1, MaximumPollers: 2 } })),
        (error: any) => error.name === "InvalidParameterValueException" && /ProvisionedPollerConfig is not supported for SQS event source mappings/.test(error.message),
      );
    });
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await new Promise(resolve => collector.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
