import assert from "node:assert/strict";
import { test } from "node:test";
import { renderVtl, validateVtl } from "../src/apigateway-vtl.js";

const context = { body: '{"items":["a","b"],"enabled":true}', headers: { authorization: "allow", "x-name": "Ada" }, query: { page: "2" }, path: { id: "42" }, context: { requestId: "request-1" }, stageVariables: { environment: "dev" } };

test("API Gateway VTL supports directives, expressions, references, accessors, and utility functions", () => {
  const template = `#set($parsed = $util.parseJson($input.body))#if($parsed.enabled && $input.params('page') == '2')#foreach($item in $parsed.items)$foreach.index:$item;#end#else disabled#end|$input.path('$.items[1]')|$input.params().header.get('x-name')|$stageVariables.environment|$context.requestId|$util.base64Encode('ok')|$util.urlEncode('a b')|$missing|$!missing|\${missing}|$!{missing}`;
  assert.equal(renderVtl(template, context), "0:a;1:b;|b|Ada|dev|request-1|b2s=|a%20b|$missing||${missing}|");
  assert.throws(() => validateVtl("#macro(example)bad#end"), /unsupported VTL directive/i);
});
