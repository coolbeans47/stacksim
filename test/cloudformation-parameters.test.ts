import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResourceDependencyGraph } from "../src/cloudformation/dependencies.js";
import { parseCloudFormationTemplate } from "../src/cloudformation/template.js";
import { cloudFormationPseudoParameters, conditionallyProcessedTemplate, evaluateTemplateConditions, publicParameterEntries, resolveTemplateParameters, validateTemplateRules } from "../src/cloudformation/parameters.js";

test("parameters resolve defaults, supplied values, lists, previous values, constraints, and NoEcho masking", () => {
  const declarations = parseCloudFormationTemplate({ Resources: {}, Parameters: {
    Secret: { Type: "String", NoEcho: true, MinLength: 3 },
    Count: { Type: "Number", Default: 2, MinValue: 1, MaxValue: 3 },
    Names: { Type: "CommaDelimitedList", Default: "a, b" },
    Prior: { Type: "String" },
  } }).Parameters;
  const result = resolveTemplateParameters(declarations, [{ parameterKey: "Secret", parameterValue: "shh" }, { parameterKey: "Prior", usePreviousValue: true }], { previous: { Prior: "old" } });
  assert.deepEqual(result.values, { Count: "2", Names: ["a", "b"], Prior: "old", Secret: "shh" });
  assert.deepEqual(publicParameterEntries(result).find(value => value.parameterKey === "Secret"), { parameterKey: "Secret", parameterValue: "****" });
  assert.throws(() => resolveTemplateParameters(declarations, [{ parameterKey: "Secret", parameterValue: "x" }, { parameterKey: "Prior", parameterValue: "ok" }]), /shorter than MinLength/);
  assert.throws(() => resolveTemplateParameters(declarations, [{ parameterKey: "Unknown", parameterValue: "x" }]), /unknown key/);
});

test("conditions, rules, pseudo-parameters, and conditional removal are deterministic", () => {
  const template = parseCloudFormationTemplate({
    Parameters: { Environment: { Type: "String", AllowedValues: ["dev", "prod"] } },
    Conditions: { IsProd: { "Fn::Equals": [{ Ref: "Environment" }, "prod"] }, IsDev: { "Fn::Not": [{ Condition: "IsProd" }] } },
    Rules: { RegionRule: { Assertions: [{ Assert: { "Fn::Equals": [{ Ref: "AWS::Region" }, "eu-west-1"] }, AssertDescription: "wrong region" }] } },
    Resources: { Active: { Type: "AWS::CDK::Metadata", Condition: "IsDev" }, Inactive: { Type: "Later::Unsupported", Condition: "IsProd" } },
    Outputs: { ActiveOutput: { Condition: "IsDev", Value: { "Fn::Sub": "${AWS::StackName}-${Environment}" } }, Hidden: { Condition: "IsProd", Value: "no" } },
  });
  const parameters = resolveTemplateParameters(template.Parameters, [{ parameterKey: "Environment", parameterValue: "dev" }]); const pseudos = cloudFormationPseudoParameters("000000000000", "eu-west-1", "stack-id", "stack-name"); const conditions = evaluateTemplateConditions(template, parameters.values, pseudos); validateTemplateRules(template, parameters.values, pseudos, conditions);
  assert.deepEqual(conditions, { IsProd: false, IsDev: true }); const processed = conditionallyProcessedTemplate(template, conditions); assert.deepEqual(Object.keys(processed.Resources), ["Active"]); assert.deepEqual(Object.keys(processed.Outputs ?? {}), ["ActiveOutput"]);
});

test("conditional processing prunes unselected Fn::If dependencies and AWS::NoValue entries", () => {
  const template = parseCloudFormationTemplate({
    Conditions: {
      IsEnabled: { "Fn::Equals": ["yes", "yes"] },
      IsDisabled: { "Fn::Equals": ["yes", "no"] },
    },
    Resources: {
      Present: { Type: "Test::Resource", Condition: "IsEnabled" },
      Absent: { Type: "Test::Resource", Condition: "IsDisabled" },
      Consumer: {
        Type: "Test::Resource",
        Properties: {
          TrueSelection: { "Fn::If": ["IsEnabled", { Ref: "Present" }, { Ref: "Absent" }] },
          FalseSelection: { "Fn::If": ["IsDisabled", { Ref: "Absent" }, { Ref: "Present" }] },
          RemovedByTrue: { "Fn::If": ["IsEnabled", { Ref: "AWS::NoValue" }, "unused"] },
          RemovedByFalse: { "Fn::If": ["IsDisabled", "unused", { Ref: "AWS::NoValue" }] },
          Values: [
            "first",
            { "Fn::If": ["IsDisabled", "unused", { Ref: "AWS::NoValue" }] },
            { "Fn::If": ["IsEnabled", "last", { Ref: "AWS::NoValue" }] },
          ],
          Nested: { Keep: true, Drop: { "Fn::If": ["IsEnabled", { Ref: "AWS::NoValue" }, false] } },
        },
      },
    },
    Outputs: {
      TrueBranch: { Value: { "Fn::If": ["IsEnabled", { Ref: "Present" }, { Ref: "Absent" }] } },
      FalseBranch: { Value: { "Fn::If": ["IsDisabled", { Ref: "Absent" }, { Ref: "Present" }] } },
    },
  });

  const processed = conditionallyProcessedTemplate(template, { IsEnabled: true, IsDisabled: false });
  assert.deepEqual(Object.keys(processed.Resources), ["Present", "Consumer"]);
  assert.deepEqual(processed.Resources.Consumer.Properties, {
    TrueSelection: { Ref: "Present" },
    FalseSelection: { Ref: "Present" },
    Values: ["first", "last"],
    Nested: { Keep: true },
  });
  assert.deepEqual(processed.Outputs, {
    TrueBranch: { Value: { Ref: "Present" } },
    FalseBranch: { Value: { Ref: "Present" } },
  });
  assert.deepEqual(buildResourceDependencyGraph(processed).dependencies, { Consumer: ["Present"], Present: [] });
});

test("AWS-specific parameter types stop at their assigned resolver dependency", () => {
  const declarations = parseCloudFormationTemplate({ Resources: {}, Parameters: { BootstrapVersion: { Type: "AWS::SSM::Parameter::Value<String>" } } }).Parameters;
  assert.throws(() => resolveTemplateParameters(declarations, [{ parameterKey: "BootstrapVersion", parameterValue: "/cdk-bootstrap/hnb659fds/version" }]), /CFN-04 bootstrap SSM/);
  assert.equal(resolveTemplateParameters(declarations, [{ parameterKey: "BootstrapVersion", parameterValue: "/cdk-bootstrap/hnb659fds/version" }], { resolveSsmParameter: () => "8" }).values.BootstrapVersion, "8");
});
