import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, DeleteQueryDefinitionCommand, DescribeQueriesCommand, DescribeQueryDefinitionsCommand, GetLogFieldsCommand, GetLogGroupFieldsCommand, GetLogObjectCommand, GetLogRecordCommand, GetQueryResultsCommand, PutLogEventsCommand, PutQueryDefinitionCommand, StartQueryCommand, StopQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function connect(simulator: StackSim) { return new CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, disableHostPrefix: true }); }
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

async function waitForStatus(client: CloudWatchLogsClient, queryId: string, status: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await client.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === status && (status !== "Running" || Number(result.statistics?.recordsScanned) > 0)) return result;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Query ${queryId} did not reach ${status}`);
}

async function waitForStatusWithClock(client: CloudWatchLogsClient, clock: TestClock, queryId: string, status: string, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await client.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === status) return result;
    clock.advance(1);
    await settle();
  }
  throw new Error(`Query ${queryId} did not reach ${status}`);
}

test("CloudWatch Logs Insights schedules CWLI queries, searches multiple groups, paginates results, resolves pointers, and persists saved queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-insights-")); const clock = new TestClock(Date.parse("2026-07-16T12:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: CloudWatchLogsClient | undefined;
  try {
    await simulator.start(); client = connect(simulator); const now = clock.now();
    for (const group of ["/learning/orders", "/learning/billing"]) { await client.send(new CreateLogGroupCommand({ logGroupName: group })); await client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); }
    await client.send(new PutLogEventsCommand({ logGroupName: "/learning/orders", logStreamName: "application", logEvents: [
      { timestamp: now, message: '{"level":"error","duration":10,"service":"orders","request":{"id":"json-one","items":[{"sku":"one"},{"sku":"two"}]}}' },
      { timestamp: now + 1, message: "status=error duration=30 service=orders" },
    ] }));
    await client.send(new PutLogEventsCommand({ logGroupName: "/learning/billing", logStreamName: "application", logEvents: [
      { timestamp: now + 2, message: '{"level":"info","duration":5,"service":"billing"}' },
      { timestamp: now + 3, message: "status=error duration=20 service=billing" },
    ] }));

    const discovered = await client.send(new GetLogGroupFieldsCommand({ logGroupName: "/learning/orders", time: Math.floor(now / 1000) })); assert.equal(discovered.logGroupFields?.find(field => field.name === "request.id")?.percent, 50); assert.equal(discovered.logGroupFields?.find(field => field.name === "request.items.0.sku")?.percent, 50); assert.equal(discovered.logGroupFields?.find(field => field.name === "@ingestionTime")?.percent, 100);
    const typedFields = await client.send(new GetLogFieldsCommand({ dataSourceName: "local", dataSourceType: "CloudWatchLogs" })); assert.equal(typedFields.logFields?.find(field => field.logFieldName === "duration")?.logFieldType?.type, "NUMBER");

    const started = await client.send(new StartQueryCommand({ logGroupNames: ["/learning/orders", "/learning/billing"], startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 60, queryString: "parse @message 'status=* duration=* service=*' as level, duration, service | filter ispresent(level) and level = 'error' | fields @timestamp, level, duration, service | sort duration desc" }));
    assert.equal((await client.send(new GetQueryResultsCommand({ queryId: started.queryId! }))).status, "Scheduled"); clock.advance(1); const running = await waitForStatus(client, started.queryId!, "Running"); assert.ok(running.results?.length, "running queries return partial results"); assert.equal(running.statistics?.recordsScanned, 4);
    clock.advance(25); const complete = await waitForStatus(client, started.queryId!, "Complete"); assert.equal(complete.results?.length, 3); assert.equal(complete.results?.[0].find(field => field.field === "duration")?.value, "30"); const pointer = complete.results?.[0].find(field => field.field === "@ptr")?.value; assert.ok(pointer);
    const record = await client.send(new GetLogRecordCommand({ logRecordPointer: pointer! })); assert.equal(record.logRecord?.["@message"], "status=error duration=30 service=orders"); assert.equal(record.logRecord?.["@logStream"], "application");
    const object = await client.send(new GetLogObjectCommand({ logObjectPointer: pointer! })); const streamed = [] as Buffer[]; for await (const event of object.fieldStream ?? []) if (event.fields?.data) streamed.push(Buffer.from(event.fields.data)); assert.equal(Buffer.concat(streamed).toString(), "status=error duration=30 service=orders");

    const aggregate = await client.send(new StartQueryCommand({ logGroupNames: ["/learning/orders", "/learning/billing"], startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 60, queryString: "parse @message 'status=* duration=* service=*' as level, duration, service | filter level = 'error' | stats count(*) as errors, sum(duration) as total, avg(duration) as average, min(duration) as minimum, max(duration) as maximum by service | sort total desc" }));
    clock.advance(1); await waitForStatus(client, aggregate.queryId!, "Running"); clock.advance(25); const aggregateResult = await waitForStatus(client, aggregate.queryId!, "Complete"); assert.deepEqual(aggregateResult.results?.map(row => Object.fromEntries(row.map(field => [field.field!, field.value]))), [
      { service: "orders", errors: "2", total: "40", average: "20", minimum: "10", maximum: "30" },
      { service: "billing", errors: "1", total: "20", average: "20", minimum: "20", maximum: "20" },
    ]);

    const deduplicated = await client.send(new StartQueryCommand({ logGroupNames: ["/learning/orders", "/learning/billing"], startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 60, queryString: "parse @message 'status=* duration=* service=*' as level, duration, service | filter duration >= 10 and (level = 'error' or level = 'info') | sort duration desc | display service, duration | dedup service | limit 2" })); clock.advance(1); await waitForStatus(client, deduplicated.queryId!, "Running"); clock.advance(25); const deduplicatedResult = await waitForStatus(client, deduplicated.queryId!, "Complete"); assert.deepEqual(deduplicatedResult.results?.map(row => Object.fromEntries(row.map(field => [field.field!, field.value]))).map(row => ({ service: row.service, duration: row.duration })), [{ service: "orders", duration: "30" }, { service: "billing", duration: "20" }]);

    const paged = await client.send(new StartQueryCommand({ logGroupName: "/learning/orders", startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 60, queryString: "fields @message | sort @timestamp asc" })); clock.advance(1); await waitForStatus(client, paged.queryId!, "Running"); clock.advance(25); await waitForStatus(client, paged.queryId!, "Complete");
    const first = await client.send(new GetQueryResultsCommand({ queryId: paged.queryId!, maxItems: 1 })); assert.equal(first.results?.length, 1); assert.ok(first.nextToken); const second = await client.send(new GetQueryResultsCommand({ queryId: paged.queryId!, maxItems: 1, nextToken: first.nextToken })); assert.equal(second.results?.length, 1); assert.notEqual(first.results?.[0].find(field => field.field === "@ptr")?.value, second.results?.[0].find(field => field.field === "@ptr")?.value);

    const sampled = await client.send(new StartQueryCommand({ logGroupNames: ["/learning/orders", "/learning/billing"], startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 60, queryString: "filter @message like /billing/ | limit any 1" })); clock.advance(1); await waitForStatus(client, sampled.queryId!, "Running"); clock.advance(25); const sampledResult = await waitForStatus(client, sampled.queryId!, "Complete"); assert.equal(sampledResult.results?.length, 1); assert.equal(sampledResult.statistics?.recordsScanned, 3, "limit any stops scanning after its first match");

    const cancelled = await client.send(new StartQueryCommand({ logGroupName: "/learning/orders", startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 60, queryString: "filter @message like /error/ | display @message" })); assert.equal((await client.send(new StopQueryCommand({ queryId: cancelled.queryId! }))).success, true); clock.advance(100); assert.equal((await client.send(new GetQueryResultsCommand({ queryId: cancelled.queryId! }))).status, "Cancelled");
    assert.ok((await client.send(new DescribeQueriesCommand({ status: "Complete", maxResults: 1 }))).queries?.length); await assert.rejects(client.send(new StartQueryCommand({ logGroupName: "/learning/orders", startTime: 0, endTime: 1, queryString: "filter level =" })), (error: any) => error.name === "MalformedQueryException" && Number.isInteger(error.queryCompileError?.location?.startCharOffset));
    for (const queryLanguage of ["PPL", "SQL"] as const) await assert.rejects(client.send(new StartQueryCommand({ queryLanguage, logGroupName: "/learning/orders", startTime: 0, endTime: 1, queryString: "source = logs" })), (error: any) => error.name === "MalformedQueryException" && /recognized but are not implemented/.test(error.message));

    const saved = await client.send(new PutQueryDefinitionCommand({ name: "Learning/Errors", queryString: "filter level = {{level}} | fields @message", logGroupNames: ["/learning/orders"], parameters: [{ name: "level", defaultValue: "error", description: "Level to find" }], clientToken: "11111111-1111-4111-8111-111111111111" })); assert.ok(saved.queryDefinitionId);
    const duplicate = await client.send(new PutQueryDefinitionCommand({ name: "Learning/Errors", queryString: "filter level = {{level}} | fields @message", logGroupNames: ["/learning/orders"], parameters: [{ name: "level", defaultValue: "error", description: "Level to find" }], clientToken: "11111111-1111-4111-8111-111111111111" })); assert.equal(duplicate.queryDefinitionId, saved.queryDefinitionId); await assert.rejects(client.send(new PutQueryDefinitionCommand({ name: "Different replay", queryString: "fields @message", clientToken: "11111111-1111-4111-8111-111111111111" })), (error: any) => error.name === "InvalidParameterException");
    await client.send(new PutQueryDefinitionCommand({ queryDefinitionId: saved.queryDefinitionId, name: "Learning/ErrorsByLevel", queryString: "filter level = 'error' | fields @message", logGroupNames: ["/learning/orders", "/learning/billing"] })); const definitions = await client.send(new DescribeQueryDefinitionsCommand({ queryDefinitionNamePrefix: "Learning/" })); assert.equal(definitions.queryDefinitions?.[0].name, "Learning/ErrorsByLevel"); assert.equal(definitions.queryDefinitions?.[0].logGroupNames?.length, 2);

    client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = connect(simulator);
    assert.ok((await client.send(new DescribeQueriesCommand({}))).queries?.length, "query history persists through restart"); assert.equal((await client.send(new GetQueryResultsCommand({ queryId: paged.queryId! }))).status, "Complete", "query results persist through restart"); assert.equal((await client.send(new DescribeQueryDefinitionsCommand({}))).queryDefinitions?.[0].name, "Learning/ErrorsByLevel", "saved query definitions persist");
    clock.advance(7 * 24 * 60 * 60 * 1000 + 1); await assert.rejects(client.send(new GetQueryResultsCommand({ queryId: paged.queryId! })), (error: any) => error.name === "ResourceNotFoundException"); assert.equal((await client.send(new DescribeQueriesCommand({}))).queries?.length, 0, "expired query history is pruned deterministically");
    await client.send(new DeleteQueryDefinitionCommand({ queryDefinitionId: saved.queryDefinitionId! })); assert.equal((await client.send(new DescribeQueryDefinitionsCommand({}))).queryDefinitions?.length, 0); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudWatch Logs Insights enforces P0 request contracts, log classes, and concurrency", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-insights-contracts-")); const clock = new TestClock(Date.parse("2026-08-01T12:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off" }); let client: CloudWatchLogsClient | undefined;
  try {
    await simulator.start(); client = connect(simulator); const now = Math.floor(clock.now() / 1000);
    await client.send(new CreateLogGroupCommand({ logGroupName: "/contracts/standard" }));
    await client.send(new CreateLogGroupCommand({ logGroupName: "/contracts/ia", logGroupClass: "INFREQUENT_ACCESS" }));
    await client.send(new CreateLogStreamCommand({ logGroupName: "/contracts/ia", logStreamName: "events" })); await client.send(new PutLogEventsCommand({ logGroupName: "/contracts/ia", logStreamName: "events", logEvents: [{ timestamp: clock.now(), message: '{"value":1}' }] }));
    await assert.rejects(client.send(new StartQueryCommand({ logGroupName: "/contracts/standard", logGroupNames: ["/contracts/standard"], startTime: now, endTime: now, queryString: "fields @message" })), (error: any) => error.name === "InvalidParameterException");
    await assert.rejects(client.send(new StartQueryCommand({ logGroupIdentifiers: [`arn:aws:logs:eu-west-1:000000000000:log-group:/contracts/standard:*`], startTime: now, endTime: now, queryString: "fields @message" })), (error: any) => error.name === "InvalidParameterException");
    await assert.rejects(client.send(new StartQueryCommand({ logGroupName: "/contracts/standard", startTime: now + 1, endTime: now, queryString: "fields @message" })), (error: any) => error.name === "InvalidParameterException");
    await assert.rejects(client.send(new StartQueryCommand({ logGroupName: "/contracts/standard", startTime: now, endTime: now, queryString: "x".repeat(10_001) })), (error: any) => error.name === "InvalidParameterException");
    await assert.rejects(client.send(new GetLogGroupFieldsCommand({ logGroupName: "/contracts/ia" })), (error: any) => error.name === "InvalidParameterException");
    const twoStats = await client.send(new StartQueryCommand({ logGroupName: "/contracts/ia", startTime: now, endTime: now, queryString: "stats count(*) as total | stats max(total) as maximum" })); assert.ok(twoStats.queryId);
    await assert.rejects(client.send(new StartQueryCommand({ logGroupName: "/contracts/ia", startTime: now, endTime: now, queryString: "stats count(*) as total | stats max(total) as maximum | stats min(maximum) as minimum" })), (error: any) => error.name === "MalformedQueryException");
    clock.advance(1); await waitForStatus(client, twoStats.queryId!, "Running"); clock.advance(25); await waitForStatus(client, twoStats.queryId!, "Complete");
    const emptyPage = await client.send(new GetQueryResultsCommand({ queryId: twoStats.queryId!, maxItems: 0 })); assert.equal(emptyPage.results?.length, 0); assert.ok(emptyPage.nextToken);
    await assert.rejects(client.send(new StopQueryCommand({ queryId: twoStats.queryId! })), (error: any) => error.name === "InvalidParameterException");
    const ppl = await client.send(new PutQueryDefinitionCommand({ name: "Contracts/PPL", queryLanguage: "PPL", queryString: "source = logs | head 10", logGroupNames: ["/contracts/standard"] })); const sql = await client.send(new PutQueryDefinitionCommand({ name: "Contracts/SQL", queryLanguage: "SQL", queryString: 'SELECT * FROM `/contracts/standard` LIMIT 10' })); assert.ok(ppl.queryDefinitionId && sql.queryDefinitionId);
    const definitionPage = await client.send(new DescribeQueryDefinitionsCommand({ queryDefinitionNamePrefix: "Contracts/", maxResults: 1 })); assert.equal(definitionPage.queryDefinitions?.length, 1); assert.ok(definitionPage.nextToken); await assert.rejects(client.send(new DescribeQueryDefinitionsCommand({ queryDefinitionNamePrefix: "Different/", maxResults: 1, nextToken: definitionPage.nextToken })), (error: any) => error.name === "InvalidParameterException");
    assert.equal((await client.send(new DescribeQueryDefinitionsCommand({ queryLanguage: "SQL" }))).queryDefinitions?.[0].queryDefinitionId, sql.queryDefinitionId);
    await assert.rejects(client.send(new PutQueryDefinitionCommand({ name: "Contracts/PPL parameters", queryLanguage: "PPL", queryString: "source = logs", parameters: [{ name: "value" }] })), (error: any) => error.name === "InvalidParameterException");

    const scheduled: string[] = []; for (let index = 0; index < 100; index++) scheduled.push((await client.send(new StartQueryCommand({ logGroupName: "/contracts/standard", startTime: now, endTime: now, queryString: "fields @message" }))).queryId!);
    await assert.rejects(client.send(new StartQueryCommand({ logGroupName: "/contracts/standard", startTime: now, endTime: now, queryString: "fields @message" })), (error: any) => error.name === "LimitExceededException");
    for (const queryId of scheduled) await client.send(new StopQueryCommand({ queryId }));
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

async function ingestEvents(client: CloudWatchLogsClient, group: string, stream: string, count: number, baseTimestamp: number, message = "match") {
  const batchSize = 10_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    await client.send(new PutLogEventsCommand({
      logGroupName: group,
      logStreamName: stream,
      logEvents: Array.from({ length: size }, (_, index) => ({ timestamp: baseTimestamp + offset + index, message })),
    }));
  }
}

test("CloudWatch Logs Insights DUG-07 streams stats count(*) beyond 100000 matches and fails materializing sorts explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-insights-dug07-"));
  const clock = new TestClock(Date.parse("2026-08-07T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off" });
  let client: CloudWatchLogsClient | undefined;
  try {
    await simulator.start(); client = connect(simulator);
    const now = clock.now();
    const group = "/dug07/volume";
    await client.send(new CreateLogGroupCommand({ logGroupName: group }));
    await client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "events" }));
    await ingestEvents(client, group, "events", 100_001, now);

    const countQuery = await client.send(new StartQueryCommand({ logGroupName: group, startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 3600, queryString: "stats count(*) as total" }));
    clock.advance(1);
    const countResult = await waitForStatusWithClock(client, clock, countQuery.queryId!, "Complete", 3000);
    assert.equal(countResult.results?.[0]?.find(field => field.field === "total")?.value, "100001");
    assert.equal(countResult.statistics?.recordsMatched, 100_001);
    assert.ok(Number(countResult.statistics?.recordsScanned) >= 100_001);

    const sortQuery = await client.send(new StartQueryCommand({ logGroupName: group, startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 3600, queryString: "fields @message | sort @timestamp asc" }));
    clock.advance(1);
    const sortResult = await waitForStatusWithClock(client, clock, sortQuery.queryId!, "Failed", 3000);
    assert.equal(sortResult.status, "Failed");
    assert.equal(sortResult.statistics?.recordsScanned, 100_001);

    const cancelQuery = await client.send(new StartQueryCommand({ logGroupName: group, startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 3600, queryString: "fields @message | sort @timestamp desc" }));
    clock.advance(1);
    await settle();
    assert.equal((await client.send(new StopQueryCommand({ queryId: cancelQuery.queryId! }))).success, true);
    const cancelResult = await waitForStatusWithClock(client, clock, cancelQuery.queryId!, "Cancelled");
    assert.equal(cancelResult.status, "Cancelled");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
