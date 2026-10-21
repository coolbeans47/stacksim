import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseCloudFormationYaml } from "../src/cloudformation/yaml.js";
import { ServerlessTransformError, expandServerlessTransform } from "../src/cloudformation/sam/index.js";

// Golden inputs and outputs are aws/serverless-application-model v1.115.0
// tests/translator fixtures (Apache-2.0; see test/fixtures/sam/LICENSE and NOTICE).
const fixtures = resolve("test", "fixtures", "sam");
const context = { region: "us-east-1", partition: "aws", accountId: "123456789012" };

function input(name: string): Record<string, unknown> {
  return parseCloudFormationYaml(readFileSync(join(fixtures, "input", `${name}.yaml`), "utf8")) as Record<string, unknown>;
}

function output(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtures, "output", `${name}.json`), "utf8"));
}

/**
 * Normalize only what sam-transform-design.md §3.4 allows to differ: REST
 * deployment hash suffixes (AWS hashes a Python repr) and their descriptions.
 */
function normalize(value: unknown): unknown {
  const text = JSON.stringify(value)
    .replace(/([A-Za-z0-9]+Deployment)[0-9a-f]{10}\b/g, "$1HASH")
    .replace(/RestApi deployment id: [0-9a-f]{40}/g, "RestApi deployment id: HASH");
  return sortKeys(JSON.parse(text));
}

/** Like SAM's deep_sort_lists, its translator tests treat lists as unordered. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortKeys(item)]));
  return value;
}

/** Fixtures whose every feature is implemented in SAM-02: processed output equals SAM's. */
const EQUAL = [
  "implicit_api",
  "implicit_http_api",
  "explicit_api",
  "simpletable",
  "simpletable_with_sse",
  "simple_table_with_table_name",
  "simple_table_with_extra_tags",
  "globals_for_simpletable",
  "function_with_policy_templates",
  "function_managed_inline_policy",
  "function_with_tracing",
  "function_with_permissions_boundary",
  "function_with_role_path",
  "function_with_role_and_role_path",
  "api_with_method_settings",
  "api_with_xray_tracing",
  "api_with_stage_tags",
  "api_with_binary_media_types",
  "http_api_explicit_stage",
];

for (const name of EQUAL) {
  test(`SAM golden fixture ${name} expands exactly as the SAM translator does`, () => {
    assert.deepEqual(normalize(expandServerlessTransform(input(name), context)), normalize(output(name)));
  });
}

/** Fixtures that use features owned by a later phase or a non-goal fail explicitly. */
const BOUNDARY: Array<[string, RegExp]> = [
  ["explicit_http_api", /Resource with id \[MyApi\] is invalid\. Property 'Auth' is not supported by StackSim \(owning phase: SAM-04\)\./],
  ["globals_for_api", /'Globals' section is invalid\. 'Auth' in 'Api' is not supported by StackSim \(owning phase: SAM-04\)\./],
  ["globals_for_function", /'Globals' section is invalid\. 'VpcConfig' in 'Function' is not supported by StackSim\./],
  ["api_with_open_api_version", /'Globals' section is invalid\. 'Cors' in 'Api' is not supported by StackSim \(owning phase: SAM-04\)\./],
  ["basic_function", /Resource with id \[CompleteFunction\] is invalid\. Property 'VpcConfig' is not supported by StackSim\./],
  ["function_with_events_and_propagate_tags", /Property 'AutoPublishAlias' is not supported by StackSim \(owning phase: SAM-04\)\./],
  ["all_policy_templates", /Policy template '[A-Za-z0-9]+' is not supported by StackSim because it targets a service StackSim does not implement\./],
];

for (const [name, pattern] of BOUNDARY) {
  test(`SAM golden fixture ${name} fails with its owning-phase boundary`, () => {
    assert.throws(() => expandServerlessTransform(input(name), context), (error: unknown) => {
      assert.ok(error instanceof ServerlessTransformError);
      assert.match(error.message, /^Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document\. Number of errors found: \d+\. /);
      assert.match(error.message, pattern);
      return true;
    });
  });
}

/** SAM's own error fixtures: the message matches the translator's errorMessage. */
for (const name of ["error_function_with_unknown_policy_template", "error_function_policy_template_with_missing_parameter"]) {
  test(`SAM error fixture ${name} reports the translator's message`, () => {
    const expected = (output(name) as { errorMessage: string }).errorMessage;
    assert.throws(() => expandServerlessTransform(input(name), context), (error: unknown) => {
      assert.ok(error instanceof ServerlessTransformError);
      assert.equal(error.message, `Transform AWS::Serverless-2016-10-31 failed with: ${expected}`);
      return true;
    });
  });
}
