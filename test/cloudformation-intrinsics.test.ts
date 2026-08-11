import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AWS_NO_VALUE,
  IntrinsicEvaluationError,
  collectIntrinsicReferences,
  evaluateIntrinsicValue,
  type IntrinsicEvaluationContext,
} from "../src/cloudformation/intrinsics.js";

const context: IntrinsicEvaluationContext = {
  parameters: { Environment: "dev", Csv: "one,two,three", Index: "1", Enabled: "yes" },
  pseudoParameters: {
    "AWS::AccountId": "000000000000",
    "AWS::Region": "eu-west-1",
    "AWS::Partition": "aws",
    "AWS::StackName": "Example",
    "AWS::StackId": "arn:aws:cloudformation:eu-west-1:000000000000:stack/Example/id",
    "AWS::URLSuffix": "amazonaws.com",
  },
  resourceRefs: { Api: "abc123", Function: "example-function" },
  resourceAttributes: {
    Api: { RootResourceId: "root123", Arn: "arn:aws:execute-api:eu-west-1:000000000000:abc123" },
    Function: { Arn: "arn:aws:lambda:eu-west-1:000000000000:function:example-function" },
  },
  mappings: {
    Regions: {
      "eu-west-1": { Tier: "local", Number: 7 },
      "us-east-1": { Tier: "remote", Number: 8 },
    },
  },
  conditions: { IsEnabled: true, IsDisabled: false },
  imports: { OtherStack: "shared-value" },
  resourceLogicalIds: ["Api", "Function", "ConditionalResource", "Other"],
};

test("intrinsic evaluator resolves refs, attributes, strings, lists, mappings, and nested values", () => {
  const result = evaluateIntrinsicValue({
    environment: { Ref: "Environment" },
    region: { Ref: "AWS::Region" },
    api: { Ref: "Api" },
    root: { "Fn::GetAtt": "Api.RootResourceId" },
    functionArn: { "Fn::GetAtt": ["Function", "Arn"] },
    joined: { "Fn::Join": ["/", [{ Ref: "Environment" }, { "Fn::Select": [{ Ref: "Index" }, { "Fn::Split": [",", { Ref: "Csv" }] }] }]] },
    mapped: { "Fn::FindInMap": ["Regions", { Ref: "AWS::Region" }, "Tier"] },
    encoded: { "Fn::Base64": { "Fn::Join": [":", [{ Ref: "Environment" }, { Ref: "Api" }]] } },
    subbed: { "Fn::Sub": ["${Environment}-${Api}-${Api.Arn}-${Alias}-${!literal}", { Alias: { "Fn::FindInMap": ["Regions", "eu-west-1", "Tier"] } }] },
    nonRecursiveSub: { "Fn::Sub": ["${Alias}-${Alias}", { Alias: "${Alias}-literal" }] },
    imported: { "Fn::ImportValue": "OtherStack" },
  }, context);

  assert.deepEqual(result, {
    environment: "dev",
    region: "eu-west-1",
    api: "abc123",
    root: "root123",
    functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:example-function",
    joined: "dev/two",
    mapped: "local",
    encoded: Buffer.from("dev:abc123").toString("base64"),
    subbed: "dev-abc123-arn:aws:execute-api:eu-west-1:000000000000:abc123-local-${literal}",
    nonRecursiveSub: "${Alias}-literal-${Alias}-literal",
    imported: "shared-value",
  });
});

test("conditions are boolean, lazy, and remove AWS::NoValue recursively", () => {
  assert.equal(evaluateIntrinsicValue({ Condition: "IsEnabled" }, context), true);
  assert.equal(evaluateIntrinsicValue({ "Fn::Equals": [{ Ref: "Environment" }, "dev"] }, context), true);
  assert.equal(evaluateIntrinsicValue({ "Fn::Contains": [["6", "7", "8"], "8"] }, context), true);
  assert.equal(evaluateIntrinsicValue({ "Fn::Contains": [["1", "2", "3"], { Ref: "Index" }] }, context), true);
  assert.equal(evaluateIntrinsicValue({ "Fn::Not": [{ Condition: "IsDisabled" }] }, context), true);
  assert.equal(evaluateIntrinsicValue({ "Fn::And": [{ Condition: "IsEnabled" }, { "Fn::Equals": [1, 1] }] }, context), true);
  assert.equal(evaluateIntrinsicValue({ "Fn::Or": [{ Condition: "IsDisabled" }, { "Fn::Equals": ["a", "a"] }] }, context), true);

  const result = evaluateIntrinsicValue({
    retained: "yes",
    discarded: { "Fn::If": ["IsDisabled", "value", { Ref: "AWS::NoValue" }] },
    list: ["before", { "Fn::If": ["IsEnabled", { Ref: "AWS::NoValue" }, "value"] }, "after"],
    lazy: { "Fn::If": ["IsEnabled", "selected", { "Fn::Contains": ["not-a-list", "unused"] }] },
  }, context);
  assert.deepEqual(result, { retained: "yes", list: ["before", "after"], lazy: "selected" });
  assert.equal(evaluateIntrinsicValue({ Ref: "AWS::NoValue" }, context), AWS_NO_VALUE);
});

test("reference collection finds dependencies in every branch and honors Fn::Sub overrides", () => {
  const references = collectIntrinsicReferences({
    parameter: { Ref: "Environment" },
    resource: { Ref: "Api" },
    pseudo: { Ref: "AWS::Region" },
    absent: { Ref: "AWS::NoValue" },
    attribute: { "Fn::GetAtt": ["Function", "Arn"] },
    substitution: {
      "Fn::Sub": [
        "${Api}-${Function.Arn}-${Environment}-${AWS::AccountId}-${Alias}-${!ignored}",
        { Alias: { Ref: "Other" } },
      ],
    },
    conditional: { "Fn::If": ["IsEnabled", { Ref: "ConditionalResource" }, { Ref: "Mystery" }] },
  }, context);

  assert.deepEqual(references, {
    refs: ["AWS::AccountId", "AWS::Region", "Api", "ConditionalResource", "Environment", "Mystery", "Other"],
    getAtts: [{ logicalId: "Function", attribute: "Arn" }],
    resourceDependencies: ["Api", "ConditionalResource", "Function", "Other"],
    parameterReferences: ["Environment"],
    pseudoParameterReferences: ["AWS::AccountId", "AWS::Region"],
    conditionReferences: ["IsEnabled"],
    unknownReferences: ["Mystery"],
  });
});

test("malformed and unsupported intrinsics report the failing path", () => {
  const failures: Array<[unknown, RegExp]> = [
    [{ "Fn::ImportValue": "MissingExport", }, /No export named MissingExport found at \$/],
    [{ "Fn::Join": [","] }, /Fn::Join requires an array containing exactly 2 values at \$/],
    [{ "Fn::GetAtt": "Api" }, /LogicalId\.Attribute at \$/],
    [{ "Fn::And": [true] }, /between 2 and 10 condition operands at \$/],
    [{ Ref: "Environment", extra: true }, /cannot have sibling keys at \$/],
    [{ nested: { "Fn::Sub": "broken-${value" } }, /unterminated variable expression at \$\.nested/],
    [{ "Fn::Sub": "${!}" }, /empty escaped variable expression at \$/],
    [{ Ref: "Missing" }, /Ref refers to unknown .* Missing at \$/],
    [{ "Fn::If": ["MissingCondition", true, false] }, /Unknown condition MissingCondition at \$/],
    [{ "Fn::Select": [9, ["only"]] }, /outside a list of length 1 at \$/],
  ];

  for (const [value, expected] of failures) {
    assert.throws(() => evaluateIntrinsicValue(value, context), (error: unknown) => error instanceof IntrinsicEvaluationError && expected.test(error.message));
  }
  assert.deepEqual(
    collectIntrinsicReferences({ branch: { "Fn::Contains": [["dev", "prod"], { Ref: "Environment" }] } }, context).parameterReferences,
    ["Environment"],
  );
  assert.throws(() => evaluateIntrinsicValue({ "Fn::Contains": ["not-a-list", "a"] }, context), /first value must resolve to a list/);
});

test("every supported intrinsic remains correct under deterministically generated recursive nesting", () => {
  const cases: Array<{ name: string; expression: unknown; expected: unknown }> = [
    { name: "Ref parameter", expression: { Ref: "Environment" }, expected: "dev" },
    { name: "Ref pseudo parameter", expression: { Ref: "AWS::Region" }, expected: "eu-west-1" },
    { name: "Ref resource", expression: { Ref: "Api" }, expected: "abc123" },
    { name: "Condition", expression: { Condition: "IsEnabled" }, expected: true },
    { name: "Fn::GetAtt", expression: { "Fn::GetAtt": ["Function", "Arn"] }, expected: "arn:aws:lambda:eu-west-1:000000000000:function:example-function" },
    { name: "Fn::Sub", expression: { "Fn::Sub": "${Environment}-${Api.RootResourceId}" }, expected: "dev-root123" },
    { name: "Fn::Join", expression: { "Fn::Join": [":", [{ Ref: "Environment" }, { Ref: "Api" }]] }, expected: "dev:abc123" },
    { name: "Fn::Select", expression: { "Fn::Select": [{ Ref: "Index" }, ["zero", "one", "two"]] }, expected: "one" },
    { name: "Fn::Split", expression: { "Fn::Split": [",", { Ref: "Csv" }] }, expected: ["one", "two", "three"] },
    { name: "Fn::FindInMap", expression: { "Fn::FindInMap": ["Regions", { Ref: "AWS::Region" }, "Number"] }, expected: 7 },
    { name: "Fn::If", expression: { "Fn::If": ["IsEnabled", { Ref: "Environment" }, { Ref: "Missing" }] }, expected: "dev" },
    { name: "Fn::Equals", expression: { "Fn::Equals": [{ Ref: "Environment" }, "dev"] }, expected: true },
    { name: "Fn::Contains", expression: { "Fn::Contains": [["prod", { Ref: "Environment" }], "dev"] }, expected: true },
    { name: "Fn::Not", expression: { "Fn::Not": [{ Condition: "IsDisabled" }] }, expected: true },
    { name: "Fn::And", expression: { "Fn::And": [{ Condition: "IsEnabled" }, { "Fn::Equals": [1, 1] }] }, expected: true },
    { name: "Fn::Or", expression: { "Fn::Or": [{ Condition: "IsDisabled" }, { "Fn::Equals": [1, 1] }] }, expected: true },
    { name: "Fn::Base64", expression: { "Fn::Base64": { "Fn::Join": [":", [{ Ref: "Environment" }, "payload"]] } }, expected: Buffer.from("dev:payload").toString("base64") },
    { name: "Fn::ImportValue", expression: { "Fn::ImportValue": { "Fn::Join": ["", ["Other", "Stack"]] } }, expected: "shared-value" },
  ];

  let state = 0x6d2b79f5;
  const next = (): number => { state = Math.imul(state ^ (state >>> 15), 1 | state); state ^= state + Math.imul(state ^ (state >>> 7), 61 | state); return (state ^ (state >>> 14)) >>> 0; };
  for (const fixture of cases) {
    for (let sample = 0; sample < 32; sample++) {
      let expression = fixture.expression; let expected = fixture.expected;
      const depth = 1 + (next() % 8);
      for (let level = 0; level < depth; level++) {
        switch (next() % 6) {
          case 0: expression = { [`level${level}`]: expression }; expected = { [`level${level}`]: expected }; break;
          case 1: expression = ["before", expression, level]; expected = ["before", expected, level]; break;
          case 2: expression = { "Fn::If": ["IsEnabled", expression, { Ref: "NeverEvaluated" }] }; break;
          case 3: expression = { "Fn::If": ["IsDisabled", { Ref: "NeverEvaluated" }, expression] }; break;
          case 4: expression = { value: expression, removed: { "Fn::If": ["IsEnabled", { Ref: "AWS::NoValue" }, "unused"] } }; expected = { value: expected }; break;
          default: expression = [expression, { "Fn::If": ["IsDisabled", "unused", { Ref: "AWS::NoValue" }] }]; expected = [expected]; break;
        }
      }
      assert.deepEqual(evaluateIntrinsicValue(expression, context), expected, `${fixture.name}, generated sample ${sample}, depth ${depth}`);
    }
  }
});
