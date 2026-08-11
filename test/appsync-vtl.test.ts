import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppSyncVtlError,
  evaluateAppSyncVtl,
  fromDynamoDB,
  toDynamoDB,
} from "../src/appsync/vtl.js";

function context(argumentsValue: Record<string, unknown> = {}) {
  return {
    arguments: argumentsValue,
    source: null,
    result: null,
    error: null,
    identity: null,
    stash: {},
    prev: { result: null },
    request: { headers: { "x-visible": "yes" } },
    info: { fieldName: "field", parentTypeName: "Query", variables: {} },
  };
}

test("APS-P0-007 executes the frozen safe AppSync VTL directive and utility subset", () => {
  const evaluated = evaluateAppSyncVtl(`
    #set($values = [])
    #set($meta = {})
    $util.qr($meta.put("seen", 0))
    #foreach($item in $ctx.args.items)
      #if($item.enabled)
        $util.qr($values.add($item.name.toUpperCase()))
        #set($meta.seen = $foreach.count)
      #elseif($item.name == "fallback")
        $util.qr($values.add("FALLBACK"))
      #else
        $util.qr($values.add("SKIPPED"))
      #end
    #end
    $util.qr($ctx.stash.put("complete", true))
    {
      "values": $util.toJson($values),
      "meta": $util.toJson($meta),
      "stash": $util.toJson($ctx.stash),
      "encoded": "$util.base64Encode('ok')",
      "epoch": $util.time.nowEpochSeconds()
    }
  `, context({
    items: [
      { name: "one", enabled: true },
      { name: "fallback", enabled: false },
      { name: "three", enabled: false },
    ],
  }), 2_000);

  assert.deepEqual(evaluated.value, {
    values: ["ONE", "FALLBACK", "SKIPPED"],
    meta: { seen: 1 },
    stash: { complete: true },
    encoded: "b2s=",
    epoch: 2,
  });
  assert.deepEqual(evaluated.stash, { complete: true });

  const returned = evaluateAppSyncVtl("#return($ctx.args.value)", context({ value: { id: "returned" } }));
  assert.equal(returned.returned, true);
  assert.deepEqual(returned.value, { id: "returned" });

  const appended = evaluateAppSyncVtl(
    '$util.appendError("warning", "Validation", {"safe":true}){"ok":true}',
    context(),
  );
  assert.deepEqual(appended.value, { ok: true });
  assert.deepEqual(appended.appendedErrors, [{
    message: "warning",
    errorType: "Validation",
    data: { safe: true },
  }]);
});

test("APS-P0-007 rejects host access, unsupported syntax, invalid JSON, and explicit errors", () => {
  assert.throws(
    () => evaluateAppSyncVtl("$ctx.args.constructor", context()),
    (error: unknown) => error instanceof AppSyncVtlError && /prototype access/.test(error.message),
  );
  assert.throws(
    () => evaluateAppSyncVtl("#macro(nope){}#end", context()),
    (error: unknown) => error instanceof AppSyncVtlError && /unsupported VTL directive/.test(error.message),
  );
  assert.throws(
    () => evaluateAppSyncVtl('{"duplicate":1,"duplicate":2}', context()),
    (error: unknown) => error instanceof AppSyncVtlError && /duplicate JSON key/.test(error.message),
  );
  assert.throws(
    () => evaluateAppSyncVtl('$util.error("failed", "Expected")', context()),
    (error: unknown) => error instanceof AppSyncVtlError
      && error.errorType === "Expected" && error.message === "failed",
  );
  assert.throws(
    () => evaluateAppSyncVtl("#return($ctx.args.value)", context({ value: "x".repeat(300 * 1024) })),
    (error: unknown) => error instanceof AppSyncVtlError && /256 KiB/.test(error.message),
  );
});

test("APS-P0-007 and APS-P0-010 convert the frozen DynamoDB value families", () => {
  const value = {
    string: "value",
    number: 42,
    decimal: 1.5,
    boolean: true,
    nil: null,
    list: ["a", 2],
    map: { nested: "yes" },
  };
  const typed = toDynamoDB(value);
  assert.deepEqual(fromDynamoDB(typed), value);

  const evaluated = evaluateAppSyncVtl(`{
    "item": $util.dynamodb.toDynamoDBJson($ctx.args.input),
    "values": $util.dynamodb.toMapValuesJson($ctx.args.input),
    "strings": $util.toJson($util.dynamodb.toStringSet(["a", "b"])),
    "numbers": $util.toJson($util.dynamodb.toNumberSet([1, 2]))
  }`, context({ input: value }));
  assert.deepEqual((evaluated.value as any).item, typed);
  assert.deepEqual((evaluated.value as any).values.string, { S: "value" });
  assert.deepEqual((evaluated.value as any).strings, { SS: ["a", "b"] });
  assert.deepEqual((evaluated.value as any).numbers, { NS: ["1", "2"] });
  assert.deepEqual(fromDynamoDB({
    M: {
      nullValue: { NULL: true },
      strings: { SS: ["a", "b"] },
      numbers: { NS: ["1", "9007199254740993"] },
      binary: { B: "Ynl0ZXM=" },
      binaries: { BS: ["YQ==", "Yg=="] },
    },
  }), {
    nullValue: null,
    strings: ["a", "b"],
    numbers: [1, "9007199254740993"],
    binary: "Ynl0ZXM=",
    binaries: ["YQ==", "Yg=="],
  });
  assert.deepEqual(fromDynamoDB({ M: { present: { NULL: true } } }), { present: null });

  assert.throws(
    () => toDynamoDB(Number.MAX_SAFE_INTEGER + 1),
    /safe DynamoDB boundary/,
  );
});
