import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { InsightsSyntaxError, parseInsightsQuery, runInsightsQuery, type InsightsRecord } from "../src/cloudwatch-insights.js";
import { AGGREGATE_FUNCTION_SIGNATURES, SCALAR_FUNCTION_SIGNATURES } from "../src/cloudwatch-insights-expression.js";
import { discoverLogFields } from "../src/cloudwatch-log-discovery.js";

function records(...fields: Array<Record<string, any>>): InsightsRecord[] { return fields.map((value, index) => ({ fields: value, pointer: `pointer-${index}`, bytes: 1 })); }
function objects(query: string, input: InsightsRecord[]) { return runInsightsQuery(query, input, 100, { queryStartTime: 0, queryEndTime: 10_000, now: 5_000 }).rows.map(row => Object.fromEntries(row.map(field => [field.field, field.value]))); }

test("CWLI parser handles comments, backticks, computed aliases, access, precedence, lists, and source locations", () => {
  const result = objects("# heading\nfields `status-code` as status, request.id as id, duration / 2 as half | filter status in [200, 201] and (half >= 5 or id = 'fallback') | display status, id, half", records(
    { "status-code": 200, "request.id": "one", duration: 20 },
    { "status-code": 500, "request.id": "fallback", duration: 4 },
  ));
  assert.deepEqual(result.map(({ "@ptr": _pointer, ...row }) => row), [{ status: "200", id: "one", half: "10" }]);
  assert.throws(() => parseInsightsQuery("fields @message | | limit 1"), (error: any) => error instanceof InsightsSyntaxError && Number.isInteger(error.start) && error.end >= error.start);
  assert.throws(() => parseInsightsQuery("filter message like /(a+)\\1/"), (error: any) => error instanceof InsightsSyntaxError && /RE2-compatible/.test(error.message));
  assert.throws(() => parseInsightsQuery("filterIndex requestId = 'one'"), /Unsupported Logs Insights QL command 'filterIndex'/);
});

test("CWLI parse supports glob and named-regex forms and computed fields overwrite deterministically", () => {
  const result = objects("parse 'status=* duration=*' as status, duration | parse @message /duration=(?<parsed>[0-9]+)/ | fields status, toNumber(duration) + 1 as duration, parsed", records({ "@message": "status=ok duration=41" }));
  assert.deepEqual(result.map(({ "@ptr": _pointer, ...row }) => row), [{ status: "ok", duration: "42", parsed: "41" }]);
});

test("CWLI sort is stable and supports multiple directions while dedup retains null records", () => {
  const result = objects("sort service asc, version desc | fields service, version | dedup service | limit 10", records(
    { service: "api", version: "v2" }, { service: "api", version: "v10" }, { service: "web", version: null }, { service: null, version: "v2" }, { service: null, version: "v1" },
  ));
  assert.deepEqual(result.map(({ "@ptr": _pointer, ...row }) => row), [{ service: "api", version: "v10" }, { service: "web", version: "null" }, { service: "null", version: "v2" }, { service: "null", version: "v1" }]);
  assert.throws(() => parseInsightsQuery("dedup service | sort version"), /Only limit can follow dedup/);
  assert.deepEqual(objects("fields service | fields version", records({ service: "api", version: "v1" }))[0], { service: "api", version: "v1", "@ptr": "pointer-0" });
  assert.deepEqual(objects("fields service | fields version | display version", records({ service: "api", version: "v1" }))[0], { version: "v1", "@ptr": "pointer-0" });
  assert.equal(objects("dedup service", records({ service: "api", "@timestamp": 1 }, { service: "api", "@timestamp": 2 }))[0]["@ptr"], "pointer-1", "unsorted dedup retains the most recent event");
  assert.equal(objects("filter service = 'api' | limit any 1", records({ service: "web" }, { service: "api" }, { service: "api" })).length, 1);
  const corpus = ["!:", "#", "*%04", "0#", "5A", "111A", "2345_", "@", "@_", "A", "A9876fghj", "a12345hfh", "0", "01", "1", "2", "3"];
  assert.deepEqual(objects("sort value asc | fields value", records(...[...corpus].reverse().map(value => ({ value })))).map(row => row.value), corpus);
});

test("CWLI scalar, structured, aggregation, and repeated stats stages share one typed evaluator", () => {
  const input = records(
    { service: "orders", duration: 10, payload: '{"items":[1,2]}' },
    { service: "orders", duration: 30, payload: '{"items":[3]}' },
    { service: "billing", duration: 20, payload: "invalid" },
  );
  const scalar = objects("fields service, jsonArraySize(jsonParse(payload).items) as itemCount, round(sqrt(duration), 2) as root | sort service asc, root asc", input);
  assert.deepEqual(scalar.map(({ "@ptr": _pointer, ...row }) => row), [
    { service: "billing", root: "4.47" }, { service: "orders", itemCount: "2", root: "3.16" }, { service: "orders", itemCount: "1", root: "5.48" },
  ]);
  assert.deepEqual(objects("stats count(*) as requests, sum(duration) as total, pct(duration, 50) as p50 by service | stats sum(requests) as requests, sum(total) as total", input), [{ requests: "3", total: "60" }]);
  assert.deepEqual(objects("stats count_over_time(service) as requests by bin(5 m) offset 1h", records({ "@timestamp": 1_000, service: "a" }, { "@timestamp": 2_000, service: "b" })), [{ "bin(5m)": "1970-01-01T01:00:00.000Z", requests: "2" }]);
  assert.deepEqual(objects("stats topk(1, service) as common", input), [{ common: '["orders"]' }]);
  assert.throws(() => parseInsightsQuery("stats topk(0, service)"), /integer from 1 to 10000/);
  assert.throws(() => parseInsightsQuery("stats count(*) as events | fields @message"), /not available after stats/);
  for (const command of ["sort body", "dedup body", "stats values(body)"]) assert.throws(() => objects(`fields jsonParse(payload) as body | ${command}`, records({ payload: '{"a":1}' }, { payload: '{"a":2}' })), /does not support map or list values/);
});

test("CWLI expression truth tables, boundaries, and scalar signatures are deterministic", () => {
  const rows = objects("fields missing = 1 as missingEq, null = 1 as nullEq, missing != 1 as missingNe, true or (1 / 0 > 0) as shortOr, false and (1 / 0 > 0) as shortAnd, 1 / 0 as divided, '10' > 2 as coerced", records({}));
  assert.deepEqual(rows, [{ missingEq: "false", nullEq: "false", missingNe: "false", shortOr: "true", shortAnd: "false", coerced: "true", "@ptr": "pointer-0" }]);
  const functions = objects("fields strcontains('StackSim', 'stack', true) as contains, startsWith('abc','a') as starts, endsWith('abc','c') as ends, hexToDec('0xff') as decimal, decToHex(-255.9) as hexadecimal, jsonArraySize('[1,2]') as size, jsonArrayContains('[1,2]', 2) as includes, formatDate(parseDate('2026-03-29 01:30', 'yyyy-MM-dd HH:mm', 'UTC'), '%Y-%m-%d %H:%M', 'Europe/London') as london", records({}))[0];
  assert.deepEqual({ ...functions, "@ptr": undefined }, { contains: "1", starts: "1", ends: "1", decimal: "255", hexadecimal: "-0xff", size: "2", includes: "true", london: "2026-03-29 02:30", "@ptr": undefined });
  assert.equal(objects("fields isIpInSubnet('2001:db8::1','2001:db8::/32') as v6, ipv4ToNumber('255.255.255.255') as v4", records({}))[0].v4, "4294967295");
  for (const [name, signature] of Object.entries(SCALAR_FUNCTION_SIGNATURES)) {
    const args = Array.from({ length: signature.min }, () => "1").join(", "); assert.doesNotThrow(() => parseInsightsQuery(`fields ${name}(${args}) as value`), `${name} minimum arity`);
    if (signature.min > 0) assert.throws(() => parseInsightsQuery(`fields ${name}(${Array.from({ length: signature.min - 1 }, () => "1").join(", ")})`), InsightsSyntaxError, `${name} rejects too few arguments`);
    assert.throws(() => parseInsightsQuery(`fields ${name}(${Array.from({ length: signature.max + 1 }, () => "1").join(", ")})`), InsightsSyntaxError, `${name} rejects too many arguments`);
  }
  for (const [name, signature] of Object.entries(AGGREGATE_FUNCTION_SIGNATURES)) {
    const validArgs = Array.from({ length: signature.min }, () => "1"); if (name === "topk") validArgs[0] = "1"; assert.doesNotThrow(() => parseInsightsQuery(`stats ${name}(${validArgs.join(", ")}) as value`), `${name} minimum arity`);
    if (signature.min > 0) assert.throws(() => parseInsightsQuery(`stats ${name}(${Array.from({ length: signature.min - 1 }, () => "1").join(", ")})`), InsightsSyntaxError, `${name} rejects too few arguments`);
    assert.throws(() => parseInsightsQuery(`stats ${name}(${Array.from({ length: signature.max + 1 }, () => "1").join(", ")})`), InsightsSyntaxError, `${name} rejects too many arguments`);
  }
});

test("generated capability manifest classifies parser productions and remains in sync", async () => {
  const manifest = JSON.parse(await readFile("docs/generated/cloudwatch-logs-insights-capabilities.json", "utf8"));
  const supported = manifest.grammar.commands.filter((command: any) => command.state === "supported").map((command: any) => command.name);
  assert.deepEqual(supported, ["comments", "fields", "display", "filter", "parse", "sort", "limit", "dedup", "stats"]);
  assert.ok(manifest.grammar.commands.every((command: any) => command.production && command.requirement));
  assert.ok(manifest.functions.length >= 80);
  const samples: Record<string, string> = { comments: "# comment\nfields @message", fields: "fields @message", display: "display @message", filter: "filter ispresent(@message)", parse: "parse 'x=*' as x", sort: "sort @timestamp desc", limit: "limit 1", dedup: "dedup @message", stats: "stats count(*)" };
  for (const command of manifest.grammar.commands) {
    if (command.state === "supported" || command.state === "partial") assert.doesNotThrow(() => parseInsightsQuery(samples[command.name]));
    else assert.throws(() => parseInsightsQuery(`${command.name} placeholder`), InsightsSyntaxError, `${command.name} must not parse while the manifest marks it unsupported`);
  }
});

test("CWLI automatic discovery covers JSON, entity, Lambda, VPC, Route 53, and the 200-field boundary", () => {
  assert.deepEqual(discoverLogFields('{"user":{"roles":["admin"]},"@source":"app"}'), { "user.roles.0": "admin", "@@source": "app" });
  assert.deepEqual(discoverLogFields('{"Entity":{"KeyAttributes":{"Type":"Service"}},"eventName":"StartInstances"}', "/aws/cloudtrail/events"), { "@entity.KeyAttributes.Type": "Service", eventName: "StartInstances" });
  const lambda = discoverLogFields('2026-08-01T00:00:00Z request INFO prefix {"level":"error","items":[1,2]} suffix {"ignored":true}', "/aws/lambda/orders"); assert.equal(lambda.level, "error"); assert.equal(lambda["items.1"], 2); assert.equal(lambda.ignored, undefined);
  const report = discoverLogFields("REPORT RequestId: req-1 Duration: 12.50 ms Billed Duration: 13 ms Memory Size: 256 MB Max Memory Used: 64 MB Init Duration: 1.25 ms XRAY TraceId: 1-abc SegmentId: def", "/aws/lambda/orders"); assert.deepEqual({ request: report["@requestId"], duration: report["@duration"], memory: report["@memorySize"], trace: report["@xrayTraceId"], segment: report["@xraySegmentId"] }, { request: "req-1", duration: 12.5, memory: 268435456, trace: "1-abc", segment: "def" });
  const vpc = discoverLogFields("2 123456789012 eni-123 10.0.0.1 10.0.0.2 1234 443 6 10 500 100 200 ACCEPT OK", "/aws/vpc/flow"); assert.deepEqual({ accountId: vpc.accountId, srcAddr: vpc.srcAddr, bytes: vpc.bytes, action: vpc.action }, { accountId: 123456789012, srcAddr: "10.0.0.1", bytes: 500, action: "ACCEPT" });
  const route53 = discoverLogFields("1.0 2017-12-13T08:16:02.130Z Z1234 example.com A NOERROR UDP DFW3 192.168.1.1 -", "/aws/route53/example"); assert.deepEqual({ queryName: route53.queryName, queryType: route53.queryType, edgeLocation: route53.edgeLocation }, { queryName: "example.com", queryType: "A", edgeLocation: "DFW3" });
  const crowded = discoverLogFields(JSON.stringify(Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`field${index}`, index])))); assert.equal(Object.keys(crowded).length, 200); assert.equal(crowded.field199, 199); assert.equal(crowded.field200, undefined);
});
