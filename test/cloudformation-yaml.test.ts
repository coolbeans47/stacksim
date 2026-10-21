import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudFormationYamlError, parseCloudFormationYaml } from "../src/cloudformation/yaml.js";
import { CloudFormationTemplateValidationError, parseCloudFormationTemplate } from "../src/cloudformation/template.js";

function yamlError(source: string): CloudFormationYamlError {
  try {
    parseCloudFormationYaml(source);
  } catch (error) {
    assert.ok(error instanceof CloudFormationYamlError, String(error));
    return error;
  }
  assert.fail(`expected a YAML error for ${JSON.stringify(source)}`);
}

test("every CloudFormation short-form tag maps to its long form", () => {
  const parsed = parseCloudFormationYaml(`
Ref: !Ref Bucket
Condition: !Condition IsProd
GetAtt: !GetAtt Queue.Arn
GetAttDeep: !GetAtt Stack.Outputs.ApiUrl
GetAttList: !GetAtt [Queue, Arn]
Sub: !Sub "\${AWS::StackName}-queue"
SubList: !Sub
  - "\${Name}-\${Suffix}"
  - Name: !Ref Prefix
    Suffix: !Select [0, !Split ["-", !Ref Suffix]]
Join: !Join [",", [a, !Ref B]]
If: !If [IsProd, !Ref Big, !Ref "AWS::NoValue"]
Equals: !Equals [!Ref Env, prod]
And: !And [!Condition A, !Not [!Condition B]]
Or: !Or [!Condition A, !Condition B]
FindInMap: !FindInMap [RegionMap, !Ref "AWS::Region", Ami]
ImportValue: !ImportValue SharedVpc
GetAZs: !GetAZs ""
Base64: !Base64 "echo hello"
Cidr: !Cidr ["10.0.0.0/16", 4, 8]
Transform: !Transform { Name: AWS::Include, Parameters: { Location: s3://bucket/key } }
Contains: !Contains [[a, b], !Ref Value]
EachMemberEquals: !EachMemberEquals [!RefAll "AWS::EC2::VPC::Id", vpc-1]
ValueOf: !ValueOf [Subnet, VpcId]
ValueOfAll: !ValueOfAll ["AWS::EC2::Subnet::Id", VpcId]
EachMemberIn: !EachMemberIn [[a], [a, b]]
`);
  assert.deepEqual(parsed, {
    Ref: { Ref: "Bucket" },
    Condition: { Condition: "IsProd" },
    GetAtt: { "Fn::GetAtt": ["Queue", "Arn"] },
    GetAttDeep: { "Fn::GetAtt": ["Stack", "Outputs.ApiUrl"] },
    GetAttList: { "Fn::GetAtt": ["Queue", "Arn"] },
    Sub: { "Fn::Sub": "${AWS::StackName}-queue" },
    SubList: { "Fn::Sub": ["${Name}-${Suffix}", { Name: { Ref: "Prefix" }, Suffix: { "Fn::Select": [0, { "Fn::Split": ["-", { Ref: "Suffix" }] }] } }] },
    Join: { "Fn::Join": [",", ["a", { Ref: "B" }]] },
    If: { "Fn::If": ["IsProd", { Ref: "Big" }, { Ref: "AWS::NoValue" }] },
    Equals: { "Fn::Equals": [{ Ref: "Env" }, "prod"] },
    And: { "Fn::And": [{ Condition: "A" }, { "Fn::Not": [{ Condition: "B" }] }] },
    Or: { "Fn::Or": [{ Condition: "A" }, { Condition: "B" }] },
    FindInMap: { "Fn::FindInMap": ["RegionMap", { Ref: "AWS::Region" }, "Ami"] },
    ImportValue: { "Fn::ImportValue": "SharedVpc" },
    GetAZs: { "Fn::GetAZs": "" },
    Base64: { "Fn::Base64": "echo hello" },
    Cidr: { "Fn::Cidr": ["10.0.0.0/16", 4, 8] },
    Transform: { "Fn::Transform": { Name: "AWS::Include", Parameters: { Location: "s3://bucket/key" } } },
    Contains: { "Fn::Contains": [["a", "b"], { Ref: "Value" }] },
    EachMemberEquals: { "Fn::EachMemberEquals": [{ "Fn::RefAll": "AWS::EC2::VPC::Id" }, "vpc-1"] },
    ValueOf: { "Fn::ValueOf": ["Subnet", "VpcId"] },
    ValueOfAll: { "Fn::ValueOfAll": ["AWS::EC2::Subnet::Id", "VpcId"] },
    EachMemberIn: { "Fn::EachMemberIn": [["a"], ["a", "b"]] },
  });
});

test("tagged scalars keep their text and tags may introduce block nodes", () => {
  assert.deepEqual(parseCloudFormationYaml("A: !Base64 123\nB: !Ref\nC: !Join\n  - ''\n  - - x\n    - !Ref Y\n"), {
    A: { "Fn::Base64": "123" },
    B: { Ref: "" },
    C: { "Fn::Join": ["", ["x", { Ref: "Y" }]] },
  });
  assert.equal(yamlError("A: !Ref [x]").detail, "!Ref requires a scalar value");
});

test("a tagged mapping value may continue as a block sequence at the key's indentation", () => {
  // As in SAM's error_function_with_no_alias_provisioned_concurrency fixture.
  assert.deepEqual(parseCloudFormationYaml("Properties:\n  Config: !If\n  - Enabled\n  - Executions: !Ref Count\n  - !Ref 'AWS::NoValue'\n  Other: 1\n"), {
    Properties: { Config: { "Fn::If": ["Enabled", { Executions: { Ref: "Count" } }, { Ref: "AWS::NoValue" }] }, Other: 1 },
  });
  assert.deepEqual(parseCloudFormationYaml("A: !If\n- C\n- 1\n- 2\nB: 3\n"), { A: { "Fn::If": ["C", 1, 2] }, B: 3 });
  // A sequence entry still may not appear among the keys of a mapping.
  assert.equal(yamlError("A:\n  B: 1\n  - 2\n").detail, "a sequence entry cannot appear inside a mapping");
});

test("plain scalars resolve with CloudFormation's YAML 1.1 rules", () => {
  const parsed = parseCloudFormationYaml(`
version: 2010-09-09
policyVersion: 2012-10-17
yes: yes
no: No
on: ON
off: off
true: true
false: FALSE
y: y
n: n
nulls: [~, null, Null, ]
empty:
int: 128
negative: -5
float: 0.5
keepsText: 1.0
octal: 0755
underscored: 1_000
hex: 0x1F
exponent: 1e3
huge: 123456789012345678901
account: 123456789012
`) as Record<string, unknown>;
  assert.equal(parsed.version, "2010-09-09");
  assert.equal(parsed.policyVersion, "2012-10-17");
  assert.equal(parsed.yes, true);
  assert.equal(parsed.no, false);
  assert.equal(parsed.on, true);
  assert.equal(parsed.off, false);
  assert.equal(parsed.true, true);
  assert.equal(parsed.false, false);
  assert.equal(parsed.y, "y");
  assert.equal(parsed.n, "n");
  assert.deepEqual(parsed.nulls, [null, null, null]);
  assert.equal(parsed.empty, null);
  assert.equal(parsed.int, 128);
  assert.equal(parsed.negative, -5);
  assert.equal(parsed.float, 0.5);
  for (const key of ["keepsText", "octal", "underscored", "hex", "exponent", "huge"]) assert.equal(typeof parsed[key], "string", key);
  assert.equal(parsed.account, 123456789012);
});

test("quoted, literal, and folded scalars follow YAML folding and chomping", () => {
  const parsed = parseCloudFormationYaml([
    "single: 'it''s # not a comment'",
    'double: "tab\\tnew\\nline \\u00e9 \\x41 \\" \\\\ \\/"',
    'foldedQuote: "first',
    '  second',
    '',
    '  third"',
    'escapedBreak: "joined\\',
    '  together"',
    "literal: |",
    "  line one",
    "    indented",
    "",
    "  line three",
    "",
    "strip: |-",
    "  no newline",
    "",
    "keep: |+",
    "  kept",
    "",
    "",
    "folded: >",
    "  folded",
    "  text",
    "",
    "  paragraph",
    "    more indented",
    "  back",
    "indicated: |2",
    "    two extra",
    "plain: first line",
    "  continues here",
    "",
    "  after blank # comment",
    "commented: value # trailing comment",
    "hash: a#b",
  ].join("\n")) as Record<string, string>;
  assert.equal(parsed.single, "it's # not a comment");
  assert.equal(parsed.double, "tab\tnew\nline é A \" \\ /");
  assert.equal(parsed.foldedQuote, "first second\nthird");
  assert.equal(parsed.escapedBreak, "joinedtogether");
  assert.equal(parsed.literal, "line one\n  indented\n\nline three\n");
  assert.equal(parsed.strip, "no newline");
  assert.equal(parsed.keep, "kept\n\n\n");
  assert.equal(parsed.folded, "folded text\nparagraph\n  more indented\nback\n");
  assert.equal(parsed.indicated, "  two extra\n");
  assert.equal(parsed.plain, "first line continues here\nafter blank");
  assert.equal(parsed.commented, "value");
  assert.equal(parsed.hash, "a#b");
});

test("block and flow collections, compact forms, comments, and document markers", () => {
  const source = [
    "%YAML 1.1",
    "--- # template",
    "Resources:",
    "  Queue:",
    "    Type: AWS::SQS::Queue",
    "    Properties:",
    "      Tags:",
    "      - Key: a",
    "        Value: '1'",
    "      -   Key: b",
    "          Value: \"2\"",
    "    DependsOn:",
    "      - First",
    "      - Second",
    "  Nested:",
    "    - - inner",
    "      - !Ref X",
    "    -",
    "      key: value",
    "  Flow: {a: 1, \"b c\": [x, {y: z}], d, url: http://example.com/a:b}",
    "  MultiLineFlow: [",
    "    one,   # comment inside flow",
    "    two",
    "  ]",
    "  Pair: [k: v]",
    "\"Quoted Key\": quoted",
    "...",
    "",
  ].join("\r\n");
  assert.deepEqual(parseCloudFormationYaml(source), {
    Resources: {
      Queue: {
        Type: "AWS::SQS::Queue",
        Properties: { Tags: [{ Key: "a", Value: "1" }, { Key: "b", Value: "2" }] },
        DependsOn: ["First", "Second"],
      },
      Nested: [["inner", { Ref: "X" }], { key: "value" }],
      Flow: { a: 1, "b c": ["x", { y: "z" }], d: null, url: "http://example.com/a:b" },
      MultiLineFlow: ["one", "two"],
      Pair: [{ k: "v" }],
    },
    "Quoted Key": "quoted",
  });
  assert.equal(parseCloudFormationYaml(""), null);
  assert.equal(parseCloudFormationYaml("# only a comment\n"), null);
});

test("core tags resolve and unsupported YAML 1.1 tags are rejected", () => {
  assert.deepEqual(parseCloudFormationYaml("a: !!str 1.0\nb: !!int 42\nc: !!bool yes\nd: !!null ~\ne: !!float 1.5\nf: !!seq [1]\ng: !!map {x: 1}"), { a: "1.0", b: 42, c: true, d: null, e: 1.5, f: [1], g: { x: 1 } });
  for (const tag of ["!!binary", "!!timestamp", "!!set", "!!omap", "!!pairs"]) assert.match(yamlError(`a: ${tag} x`).detail, /CloudFormation does not support/);
  assert.equal(yamlError("a: !!int nope").detail, '"nope" is not a valid !!int value');
});

test("malformed YAML fails with a line and column", () => {
  const cases: Array<[string, RegExp, number, number]> = [
    ["Resources:\n  A: 1\n  A: 2\n", /duplicate mapping key "A"/, 3, 3],
    ["a: {x: 1, x: 2}", /duplicate mapping key "x"/, 1, 11],
    ["Resources:\n\tQueue: {}\n", /tab characters must not be used for indentation/, 2, 1],
    ["a: &anchor 1\n", /anchors are not supported/, 1, 4],
    ["a: 1\nb: *anchor\n", /aliases are not supported/, 2, 4],
    ["base: {}\nchild:\n  <<: {a: 1}\n", /merge keys/, 3, 3],
    ["a: !NotATag value", /unknown tag !NotATag/, 1, 4],
    ["a: 1\n---\nb: 2\n", /multiple YAML documents/, 2, 1],
    ["a: 'unterminated", /unterminated single-quoted scalar/, 1, 4],
    ["a: [1, 2", /unterminated flow sequence/, 1, 4],
    ["a: b: c", /mapping values are not allowed/, 1, 5],
    ["a:\n  b: 1\n c: 2\n", /bad indentation|could not find expected/, 3, 2],
    ["- a\nb: 1\n", /unexpected content/, 2, 1],
    ["a: \"bad \\q escape\"", /unknown escape sequence/, 1, 9],
    ["%TAG ! tag:example.com,2000:\n--- a\n", /directives other than %YAML/, 1, 1],
    ["a: @value", /reserved character @/, 1, 4],
  ];
  for (const [source, pattern, line, column] of cases) {
    const error = yamlError(source);
    assert.match(error.message, pattern, source);
    assert.match(error.message, /^Template format error: YAML not well-formed\. \(line \d+, column \d+\)/);
    assert.deepEqual([error.line, error.column], [line, column], source);
  }
});

test("prototype-named keys stay ordinary data", () => {
  const parsed = parseCloudFormationYaml("__proto__: {polluted: true}\nconstructor: x\n") as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(parsed), ["__proto__", "constructor"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value, { polluted: true });
});

test("deep nesting is bounded", () => {
  assert.match(yamlError(`a: ${"[".repeat(300)}${"]".repeat(300)}`).detail, /nested more than 256 levels/);
});

test("the template parser accepts JSON first and YAML otherwise", () => {
  const yaml = parseCloudFormationTemplate("AWSTemplateFormatVersion: 2010-09-09\nResources:\n  Queue:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: !Sub \"${AWS::StackName}-q\"\n");
  assert.deepEqual(yaml.Resources.Queue, { Type: "AWS::SQS::Queue", Properties: { QueueName: { "Fn::Sub": "${AWS::StackName}-q" } } });
  assert.equal(parseCloudFormationTemplate('{"Resources":{"Queue":{"Type":"AWS::SQS::Queue"}}}').Resources.Queue.Type, "AWS::SQS::Queue");
  try {
    parseCloudFormationTemplate("Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n  Queue: {}\n");
    assert.fail("expected a duplicate-key error");
  } catch (error) {
    assert.ok(error instanceof CloudFormationTemplateValidationError);
    assert.equal(error.kind, "InvalidYaml");
    assert.deepEqual(error.position, { line: 4, column: 3 });
    assert.equal(error.message, 'Template format error: YAML not well-formed. (line 4, column 3): duplicate mapping key "Queue"');
  }
});
