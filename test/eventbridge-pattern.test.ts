import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EventPatternValidationError,
  matchesEventPattern,
  parseEventPattern,
  testEventPattern,
  validateEventPattern,
} from "../src/eventbridge/pattern.js";

test("event patterns match nested exact values and ignore unspecified event fields", () => {
  const pattern = {
    source: ["acme.orders"],
    detail: {
      active: [true],
      attempts: [3],
      empty: [""],
      response: [null],
      state: { status: ["ready"] },
    },
  };
  const matching = { source: "acme.orders", extra: "ignored", detail: { active: true, attempts: 3, empty: "", response: null, state: { status: "ready", ignored: 1 } } };
  assert.equal(matchesEventPattern(pattern, matching), true);
  assert.equal(matchesEventPattern(pattern, { ...matching, detail: { ...matching.detail, active: false } }), false);
  assert.equal(matchesEventPattern(pattern, { ...matching, detail: { ...matching.detail, empty: null } }), false);
  assert.equal(matchesEventPattern(pattern, { ...matching, detail: { ...matching.detail, attempts: "3" } }), false);
  assert.equal(matchesEventPattern({}, matching), true);
});

test("pattern and event arrays match on any intersection, including nested object arrays", () => {
  assert.equal(matchesEventPattern({ resources: ["second", "third"] }, { resources: ["first", "second"] }), true);
  assert.equal(matchesEventPattern({ resources: ["third"] }, { resources: [] }), false);
  const pattern = { detail: { items: { kind: ["book"], price: [{ numeric: [">", 10] }] } } };
  assert.equal(matchesEventPattern(pattern, { detail: { items: [{ kind: "music", price: 5 }, { kind: "book", price: 12 }] } }), true);
  assert.equal(matchesEventPattern(pattern, { detail: { items: [{ kind: "book", price: 5 }, { kind: "music", price: 12 }] } }), false);
});

test("prefix, suffix, and equals-ignore-case operators retain exact matching by default", () => {
  const fixtures: Array<[unknown, unknown, boolean]> = [
    [{ value: [{ prefix: "prod-" }] }, { value: "prod-api" }, true],
    [{ value: [{ prefix: "prod-" }] }, { value: "PROD-api" }, false],
    [{ value: [{ prefix: { "equals-ignore-case": "prod-" } }] }, { value: "PROD-api" }, true],
    [{ value: [{ suffix: ".json" }] }, { value: "event.json" }, true],
    [{ value: [{ suffix: { "equals-ignore-case": ".JSON" } }] }, { value: "event.json" }, true],
    [{ value: [{ "equals-ignore-case": "Ready" }] }, { value: "READY" }, true],
    [{ value: ["Ready"] }, { value: "READY" }, false],
  ];
  for (const [pattern, event, expected] of fixtures) assert.equal(matchesEventPattern(pattern, event), expected);
});

test("anything-but supports scalar, list, and string comparison forms", () => {
  const fixtures: Array<[unknown, unknown, boolean]> = [
    [{ state: [{ "anything-but": "stopped" }] }, { state: "running" }, true],
    [{ state: [{ "anything-but": "stopped" }] }, { state: "stopped" }, false],
    [{ code: [{ "anything-but": [400, 404] }] }, { code: 200 }, true],
    [{ code: [{ "anything-but": [400, 404] }] }, { code: 404 }, false],
    [{ region: [{ "anything-but": { prefix: "us-" } }] }, { region: "eu-west-1" }, true],
    [{ region: [{ "anything-but": { prefix: "us-" } }] }, { region: "us-east-1" }, false],
    [{ file: [{ "anything-but": { suffix: ".png" } }] }, { file: "photo.jpg" }, true],
    [{ state: [{ "anything-but": { "equals-ignore-case": "initializing" } }] }, { state: "INITIALIZING" }, false],
    [{ path: [{ "anything-but": { wildcard: "*/lib/*" } }] }, { path: "/app/src/main.ts" }, true],
    [{ path: [{ "anything-but": { wildcard: "*/lib/*" } }] }, { path: "/app/lib/main.ts" }, false],
  ];
  for (const [pattern, event, expected] of fixtures) assert.equal(matchesEventPattern(pattern, event), expected);
});

test("numeric operators support equality, comparisons, and bounded ranges", () => {
  const pattern = { detail: { price: [{ numeric: [">", 10, "<=", 20] }], quantity: [{ numeric: ["=", 2] }] } };
  assert.equal(matchesEventPattern(pattern, { detail: { price: 20, quantity: 2 } }), true);
  assert.equal(matchesEventPattern(pattern, { detail: { price: 10, quantity: 2 } }), false);
  assert.equal(matchesEventPattern(pattern, { detail: { price: 15, quantity: "2" } }), false);
});

test("CIDR matches IPv4 and IPv6 without crossing address families", () => {
  assert.equal(matchesEventPattern({ ip: [{ cidr: "10.0.0.0/24" }] }, { ip: "10.0.0.255" }), true);
  assert.equal(matchesEventPattern({ ip: [{ cidr: "10.0.0.0/24" }] }, { ip: "10.0.1.1" }), false);
  assert.equal(matchesEventPattern({ ip: [{ cidr: "2001:db8::/32" }] }, { ip: "2001:db8:abcd::1" }), true);
  assert.equal(matchesEventPattern({ ip: [{ cidr: "2001:db8::/32" }] }, { ip: "2001:db9::1" }), false);
  assert.equal(matchesEventPattern({ ip: [{ cidr: "0.0.0.0/0" }] }, { ip: "2001:db8::1" }), false);
});

test("exists distinguishes a missing field from null, false, and empty values", () => {
  const present = { detail: { value: [{ exists: true }] } };
  const absent = { detail: { value: [{ exists: false }] } };
  for (const value of [null, false, "", [], 0]) assert.equal(matchesEventPattern(present, { detail: { value } }), true);
  assert.equal(matchesEventPattern(present, { detail: {} }), false);
  assert.equal(matchesEventPattern(present, { detail: { value: { nested: true } } }), false, "exists applies only to leaves");
  assert.equal(matchesEventPattern(absent, { detail: {} }), true);
  assert.equal(matchesEventPattern(absent, { detail: { value: null } }), false);
});

test("wildcards are anchored and support only documented star and backslash escaping", () => {
  assert.equal(matchesEventPattern({ file: [{ wildcard: "dir/*.png" }] }, { file: "dir/icons/logo.png" }), true);
  assert.equal(matchesEventPattern({ file: [{ wildcard: "dir/*.png" }] }, { file: "other/dir/logo.png" }), false);
  assert.equal(matchesEventPattern({ file: [{ wildcard: "report\\*final" }] }, { file: "report*final" }), true);
  assert.equal(matchesEventPattern({ file: [{ wildcard: "C:\\\\temp\\*" }] }, { file: "C:\\temp*" }), true);
});

test("$or works at the root and in nested objects while siblings remain conjunctive", () => {
  const pattern = {
    source: ["acme.orders"],
    detail: {
      "$or": [
        { total: [{ numeric: [">", 100] }] },
        { priority: [{ "equals-ignore-case": "urgent" }] },
      ],
      accepted: [true],
    },
  };
  assert.equal(matchesEventPattern(pattern, { source: "acme.orders", detail: { total: 101, priority: "normal", accepted: true } }), true);
  assert.equal(matchesEventPattern(pattern, { source: "acme.orders", detail: { total: 1, priority: "URGENT", accepted: true } }), true);
  assert.equal(matchesEventPattern(pattern, { source: "acme.orders", detail: { total: 101, priority: "normal", accepted: false } }), false);
  assert.equal(matchesEventPattern(pattern, { source: "other", detail: { total: 101, accepted: true } }), false);
});

test("dotted and nested field names use EventBridge's compiled path behavior", () => {
  assert.equal(matchesEventPattern({ detail: { "state.status": ["running"] } }, { detail: { state: { status: "running" } } }), true);
  assert.equal(matchesEventPattern({ detail: { state: { status: ["running"] } } }, { detail: { "state.status": "running" } }), true);
});

test("ARN exact matching does not normalize colons and slashes", () => {
  const pattern = { resources: ["arn:aws:events:eu-west-1:111122223333:rule/orders"] };
  assert.equal(matchesEventPattern(pattern, { resources: ["arn:aws:events:eu-west-1:111122223333:rule/orders"] }), true);
  assert.equal(matchesEventPattern(pattern, { resources: ["arn:aws:events:eu-west-1:111122223333:rule:orders"] }), false);
});

test("JSON helpers validate patterns and test JSON events", () => {
  const parsed = parseEventPattern('{"source":["acme.orders"]}');
  assert.deepEqual(parsed, { source: ["acme.orders"] });
  assert.equal(testEventPattern('{"source":["acme.orders"]}', '{"source":"acme.orders","detail":{}}'), true);
  assert.throws(() => parseEventPattern("{"), EventPatternValidationError);
  assert.throws(() => testEventPattern("{}", "[]"), /Event must be a JSON object/);
});

test("lossless JSON matching keeps exact number lexemes distinct while numeric operators compare values", () => {
  assert.equal(testEventPattern('{"detail":{"amount":[300]}}', '{"detail":{"amount":300}}'), true);
  assert.equal(testEventPattern('{"detail":{"amount":[300]}}', '{"detail":{"amount":300.0}}'), false);
  assert.equal(testEventPattern('{"detail":{"amount":[300]}}', '{"detail":{"amount":3e2}}'), false);
  assert.equal(testEventPattern('{"detail":{"amount":[{"numeric":["=",300]}]}}', '{"detail":{"amount":300.0}}'), true);
  assert.throws(() => parseEventPattern('{"detail":{"amount":[{"numeric":["=",0.0000001]}]}}'), /six fractional digits/);
});

test("validation rejects malformed grammar and excessive $or combinations", () => {
  const invalid: unknown[] = [
    null,
    [],
    { source: "acme.orders" },
    { source: [] },
    { source: [["acme.orders"]] },
    { source: [{ unknown: "value" }] },
    { source: [{ prefix: 1 }] },
    { source: [{ suffix: { "equals-ignore-case": 1 } }] },
    { source: [{ exists: "true" }] },
    { source: [{ numeric: [">", 0, "<"] }] },
    { source: [{ numeric: ["!=", 0] }] },
    { source: [{ numeric: [">", 5_000_000_001] }] },
    { source: [{ cidr: "10.0.0.0/33" }] },
    { source: [{ wildcard: "a**b" }] },
    { source: [{ wildcard: "a\\qb" }] },
    { source: [{ "anything-but": [] }] },
    { source: [{ "anything-but": [1, "two"] }] },
    { source: [{ "anything-but": { numeric: [">", 1] } }] },
    { "$or": [] },
    { "$or": ["not-an-object"] },
  ];
  for (const pattern of invalid) assert.throws(() => validateEventPattern(pattern), EventPatternValidationError);
  assert.throws(
    () => validateEventPattern({ "$or": Array.from({ length: 1_001 }, (_, value) => ({ value: [value] })) }),
    /more than 1000 combinations/,
  );
});
