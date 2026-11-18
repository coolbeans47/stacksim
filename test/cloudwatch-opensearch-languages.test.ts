import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import * as Iam from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";
import { executeLogLanguage, parseLogLanguage } from "../src/cloudwatch-logs-query-languages.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, group = "/SQL/orders-API";
const rows = (result: Logs.GetQueryResultsCommandOutput) => result.results?.map(row => Object.fromEntries(row.map(field => [field.field!, field.value])));
async function complete(client: Logs.CloudWatchLogsClient, clock: TestClock, queryId: string, expected = "Complete") {
  for (let i = 0; i < 1000; i++) {
    clock.advance(25); await new Promise<void>(resolve => setImmediate(resolve));
    const result = await client.send(new Logs.GetQueryResultsCommand({ queryId }));
    if (!["Scheduled", "Running"].includes(result.status!)) { assert.equal(result.status, expected); return result; }
  }
  assert.fail("Query did not finish");
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-logs-sql-")), clock = new TestClock(Date.now());
  const options = { port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce" as const, cdkBootstrap: false };
  const sim = new StackSim(options); await sim.start();
  const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }, client = new Logs.CloudWatchLogsClient(config);
  await client.send(new Logs.CreateLogGroupCommand({ logGroupName: group, tags: { team: "orders" } }));
  await client.send(new Logs.CreateLogStreamCommand({ logGroupName: group, logStreamName: "events" }));
  const timestamp = clock.now();
  const input = { startTime: Math.floor(timestamp / 1000), endTime: Math.floor(timestamp / 1000) };
  const put = (messages: string[]) => client.send(new Logs.PutLogEventsCommand({ logGroupName: group, logStreamName: "events", logEvents: messages.map(message => ({ timestamp, message })) }));
  return { root, clock, options, sim, config, client, input, put };
}

test("SQL/PPL query actual log events, flat JSON fields, aggregation, pagination, pointers and restart", { timeout: 60_000 }, async () => {
  const h = await setup(); let sim = h.sim, client = h.client;
  try {
    await h.put(['{"level":"error","duration":10,"request":{"id":"one"}}', '{"level":"info","duration":4,"request":{"id":"two"}}', '{"level":"error","duration":20,"request":{"id":"three"}}']);
    const run = async (queryLanguage: "SQL" | "PPL", queryString: string, rest = {}) => complete(client, h.clock, (await client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage, queryString, ...rest }))).queryId!);
    const selected = await run("SQL", `SELECT \`request.id\` AS request, duration, \`@ptr\` FROM \`${group}\` WHERE level = 'error' ORDER BY duration DESC`);
    assert.deepEqual(rows(selected)?.map(row => [row.request, row.duration]), [["three", "20"], ["one", "10"]]);
    assert.equal(selected.statistics?.recordsScanned, 3); assert.equal(selected.statistics?.recordsMatched, 2); assert.equal(selected.queryLanguage, "SQL");
    assert.match((await client.send(new Logs.GetLogRecordCommand({ logRecordPointer: rows(selected)![0]["@ptr"]! }))).logRecord!["@message"], /three/);
    const stats = await run("SQL", `SELECT level, COUNT(*) AS events, AVG(duration) AS average FROM \`${group}\` GROUP BY level ORDER BY events DESC`);
    assert.deepEqual(rows(stats), [{ level: "error", events: "2", average: "15" }, { level: "info", events: "1", average: "4" }]); assert.equal(stats.statistics?.recordsMatched, 3);
    assert.deepEqual(rows(await run("PPL", `source = [lg:\`${group}\`] | where duration >= 10 | stats sum(duration) as total by level`)), [{ level: "error", total: "30" }]);
    assert.deepEqual(rows(await run("PPL", "where duration < 10 | fields request.id, duration", { logGroupIdentifiers: [`arn:aws:logs:${region}:000000000000:log-group:${group}`] })), [{ "request.id": "two", duration: "4" }]);
    const pending = await client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString: `SELECT duration FROM \`${group}\` ORDER BY duration` }));
    client.destroy(); await sim.stop(); sim = new StackSim(h.options); await sim.start(); client = new Logs.CloudWatchLogsClient({ ...h.config, endpoint: `http://127.0.0.1:${sim.port}` });
    assert.deepEqual(rows(await complete(client, h.clock, pending.queryId!)), [{ duration: "4" }, { duration: "10" }, { duration: "20" }]);
    const page = await client.send(new Logs.GetQueryResultsCommand({ queryId: pending.queryId!, maxItems: 1 })); assert.equal(rows(page)![0].duration, "4"); assert.ok(page.nextToken);
    assert.equal(rows(await client.send(new Logs.GetQueryResultsCommand({ queryId: pending.queryId!, maxItems: 1, nextToken: page.nextToken })))![0].duration, "10");
    assert.ok((await client.send(new Logs.DescribeQueriesCommand({ queryLanguage: "SQL" }))).queries!.every(query => query.queryLanguage === "SQL"));
    const cancel = await client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "PPL", logGroupName: group, queryString: "fields @message" }));
    await client.send(new Logs.StopQueryCommand({ queryId: cancel.queryId })); assert.equal((await client.send(new Logs.GetQueryResultsCommand({ queryId: cancel.queryId }))).status, "Cancelled");
    h.clock.advance(7 * 86400000 + 1); client.destroy(); client = new Logs.CloudWatchLogsClient({ ...h.config, endpoint: `http://127.0.0.1:${sim.port}`, systemClockOffset: h.clock.now() - Date.now() });
    await assert.rejects(client.send(new Logs.GetQueryResultsCommand({ queryId: pending.queryId })), /not found/);
  } finally { client.destroy(); await sim.stop(); await rm(h.root, { recursive: true, force: true }); }
});

test("Logs SQL/PPL rejects unsupported syntax, selector ambiguity, other log classes, incompatible fields and oversized results", { timeout: 60_000 }, async () => {
  const h = await setup();
  try {
    for (const queryString of [`SELECT * FROM \`${group}\` JOIN other ON x = y`, `SELECT * FROM \`${group}\`; DELETE FROM x`, "SELECT * FROM `*`", "SELECT * FROM `logGroups(logGroupIdentifier:['a','b'])`", `SELECT upper(level) FROM \`${group}\``]) await assert.rejects(h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString })), (error: any) => error.name === "MalformedQueryException" && !!error.queryCompileError);
    await assert.rejects(h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", logGroupName: group, queryString: `SELECT * FROM \`${group}\`` })), /SQL selects/);
    await assert.rejects(h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "PPL", logGroupName: group, queryString: "source = different | head 1" })), /must match/);
    await assert.rejects(h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "PPL", logGroupNames: [group, "second"], queryString: "fields @message" })), /exactly one/);
    assert.throws(() => parseLogLanguage({ queryLanguage: "PPL", logGroupNames: group, queryString: "fields @message" }, region, "000000000000"), /selector type/);
    assert.throws(() => parseLogLanguage({ queryLanguage: "PPL", logGroupIdentifiers: [`arn:aws:logs:us-east-1:000000000000:log-group:${group}`], queryString: "fields @message" }, region, "000000000000"), /account and Region/);
    await h.client.send(new Logs.CreateLogGroupCommand({ logGroupName: "infrequent", logGroupClass: "INFREQUENT_ACCESS" }));
    await assert.rejects(h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString: "SELECT * FROM infrequent" })), /Standard/);
    await assert.rejects(h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString: `SELECT * FROM \`${group}\``, limit: 10001 })), /10000/);
    await h.put(['{"mixed":1,"nullable":null}', '{"mixed":"text","nullable":null}']);
    const failed = await h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString: `SELECT mixed FROM \`${group}\`` }));
    await complete(h.client, h.clock, failed.queryId!, "Failed");
    const safe = await h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString: `SELECT COUNT(*) AS total FROM \`${group}\` WHERE nullable IS NULL` }));
    assert.deepEqual(rows(await complete(h.client, h.clock, safe.queryId!)), [{ total: "2" }]);
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}_${'x'.repeat(230)}`, 'a']));
    assert.throws(() => executeLogLanguage(parseLogLanguage({ queryLanguage: 'SQL', queryString: `SELECT * FROM \`${group}\`` }, region, '000000000000'), Array(1400).fill(wide), 10000, performance.now() + 30000), /Logs response exceeds 32 MiB/, 'The wire budget includes repeated field names, not just scalar values');
  } finally { h.client.destroy(); await h.sim.stop(); await rm(h.root, { recursive: true, force: true }); }
});

test("SQL/PPL source parsing enforces scoped IAM and resource tags before admitting a query", { timeout: 60_000 }, async () => {
  const h = await setup(), iam = new Iam.IAMClient(h.config); let reader: Logs.CloudWatchLogsClient | undefined;
  try {
    await h.client.send(new Logs.CreateLogGroupCommand({ logGroupName: "/private/secret" })); await h.put(['{"value":7}']);
    await iam.send(new Iam.CreateUserCommand({ UserName: "LogSqlReader" })); const key = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: "LogSqlReader" }))).AccessKey!;
    reader = new Logs.CloudWatchLogsClient({ ...h.config, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } });
    const grant = (tag: string) => iam.send(new Iam.PutUserPolicyCommand({ UserName: "LogSqlReader", PolicyName: "query", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "logs:StartQuery", Resource: `arn:aws:logs:${region}:000000000000:log-group:${group}:*`, Condition: { StringEquals: { "aws:ResourceTag/team": tag } } }, { Effect: "Allow", Action: "logs:GetQueryResults", Resource: "*" }] }) }));
    await grant("orders");
    const request = { ...h.input, queryLanguage: "SQL" as const, queryString: `SELECT value FROM \`${group}\`` };
    const accepted = await reader.send(new Logs.StartQueryCommand(request)); assert.deepEqual(rows(await complete(reader, h.clock, accepted.queryId!)), [{ value: "7" }]);
    await assert.rejects(reader.send(new Logs.StartQueryCommand({ ...request, queryString: "SELECT * FROM `/private/secret`" })), (error: any) => error.name === "AccessDeniedException");
    await assert.rejects(reader.send(new Logs.StartQueryCommand({ ...request, queryLanguage: "PPL", queryString: "source = `/private/secret` | head 1" })), (error: any) => error.name === "AccessDeniedException");
    await grant("other"); await assert.rejects(reader.send(new Logs.StartQueryCommand(request)), (error: any) => error.name === "AccessDeniedException");
    await grant("orders"); await iam.send(new Iam.DeleteAccessKeyCommand({ UserName: "LogSqlReader", AccessKeyId: key.AccessKeyId })); await assert.rejects(reader.send(new Logs.StartQueryCommand(request)), /access key|token/i);
  } finally { reader?.destroy(); iam.destroy(); h.client.destroy(); await h.sim.stop(); await rm(h.root, { recursive: true, force: true }); }
});

test("SQL/PPL scan bounds fail instead of returning an incomplete aggregate", { timeout: 60_000 }, async () => {
  const h = await setup();
  try {
    // Seed the real stream in one write so the test measures the query scan.
    const timestamp = h.clock.now();
    await h.sim.logs["events"](group, "events").compact(Array.from({ length: 50_001 }, (_, order) => ({
      timestamp, ingestionTime: timestamp, message: '{"value":1}', order, eventId: String(order),
    })));
    const query = await h.client.send(new Logs.StartQueryCommand({ ...h.input, queryLanguage: "SQL", queryString: `SELECT COUNT(*) AS total FROM \`${group}\`` }));
    const result = await complete(h.client, h.clock, query.queryId!, "Failed"); assert.equal(result.statistics?.recordsScanned, 50_001); assert.deepEqual(result.results, []);
  } finally { h.client.destroy(); await h.sim.stop(); await rm(h.root, { recursive: true, force: true }); }
});
