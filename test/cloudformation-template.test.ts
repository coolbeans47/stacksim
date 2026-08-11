import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CloudFormationTemplateValidationError,
  parseCloudFormationTemplate,
  type CloudFormationTemplateErrorKind,
} from "../src/cloudformation/template.js";
import {
  CloudFormationDependencyGraphError,
  buildResourceDependencyGraph,
  topologicallySortResources,
} from "../src/cloudformation/dependencies.js";

function resource(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return { Type: "Test::Resource", Properties: properties };
}

function template(resources: Record<string, unknown> = {}): Record<string, unknown> {
  return { AWSTemplateFormatVersion: "2010-09-09", Resources: resources };
}

function captureTemplateError(action: () => unknown): CloudFormationTemplateValidationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CloudFormationTemplateValidationError);
    return error;
  }
  assert.fail("expected template validation to fail");
}

function captureGraphError(action: () => unknown): CloudFormationDependencyGraphError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CloudFormationDependencyGraphError);
    return error;
  }
  assert.fail("expected dependency graph validation to fail");
}

test("JSON templates parse every CFN-02-owned section without rewriting values", () => {
  const source = {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "metadata fixture",
    Metadata: { owner: "test" },
    Parameters: {
      Environment: {
        Type: "String",
        Default: "dev",
        NoEcho: false,
        AllowedValues: ["dev", "prod"],
        Description: "deployment environment",
      },
    },
    Rules: {
      EnvironmentRule: {
        RuleCondition: { "Fn::Equals": [{ Ref: "Environment" }, "prod"] },
        Assertions: [{ Assert: { "Fn::Equals": [{ Ref: "Environment" }, "prod"] }, AssertDescription: "production only" }],
      },
    },
    Mappings: {
      Regions: {
        "eu-west-1": { Arch: "arm64", Sizes: [128, 256] },
      },
    },
    Conditions: {
      IsProduction: { "Fn::Equals": [{ Ref: "Environment" }, "prod"] },
    },
    Resources: {
      Metadata: {
        Type: "AWS::CDK::Metadata",
        Properties: { Analytics: "v2:deflate64:test" },
        Metadata: { tool: "cdk" },
        Condition: "IsProduction",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "RetainExceptOnCreate",
      },
    },
    Outputs: {
      EnvironmentName: {
        Description: "selected environment",
        Value: { Ref: "Environment" },
        Export: { Name: { "Fn::Sub": "${AWS::StackName}-environment" } },
        Condition: "IsProduction",
      },
    },
  };

  const parsed = parseCloudFormationTemplate(JSON.stringify(source));
  assert.deepEqual(parsed, source);
});

test("object templates are validated as JSON and cloned from caller mutation", () => {
  const source = template({ Example: resource({ Name: "before" }) });
  const parsed = parseCloudFormationTemplate(source);
  (source.Resources as Record<string, any>).Example.Properties.Name = "after";
  assert.equal(parsed.Resources.Example.Properties?.Name, "before");

  const cyclic: Record<string, unknown> = template();
  cyclic.Metadata = cyclic;
  const error = captureTemplateError(() => parseCloudFormationTemplate(cyclic));
  assert.equal(error.kind, "InvalidTemplate");
  assert.match(error.message, /must not contain cycles/);
});

test("parser is JSON-first and validates required top-level structure", () => {
  let error = captureTemplateError(() => parseCloudFormationTemplate("Resources:\n  Example: {}"));
  assert.equal(error.kind, "InvalidJson");
  assert.match(error.message, /YAML is not supported/);

  error = captureTemplateError(() => parseCloudFormationTemplate({ Description: "missing resources" }));
  assert.equal(error.kind, "InvalidTemplate");
  assert.equal(error.path, "$.Resources");

  error = captureTemplateError(() => parseCloudFormationTemplate({ Resources: [], Hooks: {} }));
  assert.equal(error.kind, "UnsupportedTemplateSection");
  assert.equal(error.path, "$.Hooks");

  error = captureTemplateError(() => parseCloudFormationTemplate({ Resources: [] }));
  assert.equal(error.kind, "InvalidTemplate");
  assert.equal(error.path, "$.Resources");
});

test("section declarations receive structural validation with precise paths", () => {
  assert.ok(parseCloudFormationTemplate({ Resources: { "123": resource() } }).Resources["123"], "AWS permits alphanumeric logical IDs, including a leading digit");

  const fixtures: Array<[Record<string, unknown>, string]> = [
    [{ Resources: { "Not-Logical": resource() } }, "$.Resources[\"Not-Logical\"]"],
    [{ Resources: {}, Parameters: { Value: { Default: "missing type" } } }, "$.Parameters.Value.Type"],
    [{ Resources: {}, Mappings: { Map: { Key: "not an object" } } }, "$.Mappings.Map.Key"],
    [{ Resources: {}, Rules: { Guard: { Assertions: [] } } }, "$.Rules.Guard.Assertions"],
    [{ Resources: {}, Outputs: { Result: { Description: "missing value" } } }, "$.Outputs.Result.Value"],
    [{ Resources: { Thing: { ...resource(), DependsOn: ["Good", 42] } } }, "$.Resources.Thing.DependsOn[1]"],
    [{ Resources: { Thing: { ...resource(), Unexpected: true } } }, "$.Resources.Thing.Unexpected"],
    [{ Resources: { Thing: { ...resource(), Condition: "Missing" } } }, "$.Resources.Thing.Condition"],
  ];

  for (const [input, expectedPath] of fixtures) {
    const error = captureTemplateError(() => parseCloudFormationTemplate(input));
    assert.equal(error.kind, "InvalidTemplate");
    assert.equal(error.path, expectedPath);
  }
});

test("CFN-14 custom resource types pass structural parsing for provider selection", () => {
  for (const type of ["Custom::Provisioner", "AWS::CloudFormation::CustomResource"]) {
    const parsed = parseCloudFormationTemplate(template({
      Custom: { Type: type, Properties: { ServiceToken: "arn:aws:lambda:eu-west-1:000000000000:function:provider" } },
    }));
    assert.equal(parsed.Resources.Custom.Type, type);
  }
});

test("CFN-16 nested stacks pass structural parsing for provider validation", () => {
  const parsed = parseCloudFormationTemplate(template({
    Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "https://templates.s3.eu-west-1.amazonaws.com/child.json" } },
  }));
  assert.equal(parsed.Resources.Child.Type, "AWS::CloudFormation::Stack");
});

test("deferred template families fail with named boundaries before provider selection", () => {
  const fixtures: Array<[CloudFormationTemplateErrorKind, Record<string, unknown>]> = [
    ["UnsupportedTransform", { Transform: "AWS::Serverless-2016-10-31", Resources: {} }],
    ["UnsupportedMacro", { Macros: {}, Resources: {} }],
    ["UnsupportedMacro", template({ Macro: { Type: "AWS::CloudFormation::Macro" } })],
    ["UnsupportedMacro", template({ Example: resource({ Value: { "Fn::Transform": { Name: "Macro" } } }) })],
    ["UnsupportedWaitCondition", template({ Wait: { Type: "AWS::CloudFormation::WaitCondition" } })],
    ["UnsupportedWaitCondition", template({ Handle: { Type: "AWS::CloudFormation::WaitConditionHandle" } })],
    ["UnsupportedCreationPolicy", template({ Example: { ...resource(), CreationPolicy: { ResourceSignal: { Timeout: "PT5M" } } } })],
    ["UnsupportedUpdatePolicy", template({ Example: { ...resource(), UpdatePolicy: { AutoScalingRollingUpdate: {} } } })],
  ];

  for (const [kind, input] of fixtures) {
    const error = captureTemplateError(() => parseCloudFormationTemplate(input));
    assert.equal(error.kind, kind);
    assert.equal(error.code, "ValidationError");
    assert.match(error.path, /^\$/);
  }
});

test("graph discovers explicit and recursively nested Ref, GetAtt, and Sub dependencies", () => {
  const parsed = parseCloudFormationTemplate({
    Parameters: { Stage: { Type: "String", Default: "dev" } },
    Resources: {
      Table: resource(),
      Api: resource({
        Endpoint: {
          "Fn::Sub": [
            "${Function.Arn}/${Stage}/${AWS::Region}/${MappedRole}",
            { MappedRole: { Ref: "Role" } },
          ],
        },
      }),
      Independent: resource(),
      Function: {
        ...resource({
          Nested: [{ "Fn::Join": [":", [{ Ref: "Table" }, { "Fn::GetAtt": "Role.Arn" }]] }],
        }),
        DependsOn: "Role",
      },
      Role: resource(),
    },
    Outputs: {
      FunctionName: { Value: { Ref: "Function" } },
    },
  });

  const graph = buildResourceDependencyGraph(parsed);
  assert.deepEqual(graph.dependencies, {
    Api: ["Function", "Role"],
    Function: ["Role", "Table"],
    Independent: [],
    Role: [],
    Table: [],
  });
  assert.deepEqual(graph.dependents, {
    Api: [],
    Function: ["Api"],
    Independent: [],
    Role: ["Api", "Function"],
    Table: ["Function"],
  });
  assert.deepEqual(graph.order, ["Independent", "Role", "Table", "Function", "Api"]);
  assert.ok(graph.references.some(reference => reference.kind === "DependsOn" && reference.sourceLogicalId === "Function" && reference.targetLogicalId === "Role"));
  assert.ok(graph.references.some(reference => reference.kind === "Fn::Sub" && reference.sourceLogicalId === "Api" && reference.targetLogicalId === "Function"));
  assert.ok(graph.references.some(reference => reference.kind === "Fn::GetAtt" && reference.sourceLogicalId === "Function" && reference.targetLogicalId === "Role"));
  assert.ok(graph.references.some(reference => reference.sourceLogicalId === undefined && reference.targetLogicalId === "Function"), "output references are validated but do not create a resource node");
});

test("Fn::Sub variable maps override placeholders while recursively contributing their own dependencies", () => {
  const parsed = parseCloudFormationTemplate(template({
    Consumer: resource({
      Value: {
        "Fn::Sub": ["${Table}-${Mapped}", { Table: "literal", Mapped: { Ref: "Role" } }],
      },
    }),
    Role: resource(),
    Table: resource(),
  }));
  const graph = buildResourceDependencyGraph(parsed);
  assert.deepEqual(graph.dependencies.Consumer, ["Role"]);
});

test("parameter and pseudo-parameter references do not become resource edges", () => {
  const parsed = parseCloudFormationTemplate({
    Parameters: { Name: { Type: "String" } },
    Resources: {
      Consumer: resource({
        Direct: { Ref: "Name" },
        Message: { "Fn::Sub": "${Name}-${AWS::AccountId}-${AWS::URLSuffix}" },
      }),
    },
  });
  assert.deepEqual(buildResourceDependencyGraph(parsed).dependencies, { Consumer: [] });
});

test("missing explicit, intrinsic, substitution, output, and condition references are actionable", () => {
  const fixtures: Array<[Record<string, unknown>, string, string]> = [
    [template({ Consumer: { ...resource(), DependsOn: "Missing" } }), "MissingReference", "$.Resources.Consumer.DependsOn"],
    [template({ Consumer: resource({ Value: { Ref: "Missing" } }) }), "MissingReference", "$.Resources.Consumer.Properties.Value.Ref"],
    [template({ Consumer: resource({ Value: { "Fn::GetAtt": ["Missing", "Arn"] } }) }), "MissingReference", "$.Resources.Consumer.Properties.Value.Fn::GetAtt"],
    [template({ Consumer: resource({ Value: { "Fn::Sub": "${Missing.Arn}" } }) }), "MissingReference", "$.Resources.Consumer.Properties.Value.Fn::Sub"],
    [{ Resources: {}, Outputs: { Result: { Value: { Ref: "Missing" } } } }, "MissingReference", "$.Outputs.Result.Value.Ref"],
    [{ Conditions: {}, Resources: { Consumer: resource({ Value: { "Fn::If": ["Missing", "yes", "no"] } }) } }, "MissingCondition", "$.Resources.Consumer.Properties.Value.Fn::If[0]"],
  ];

  for (const [input, kind, path] of fixtures) {
    const error = captureGraphError(() => buildResourceDependencyGraph(parseCloudFormationTemplate(input)));
    assert.equal(error.kind, kind);
    assert.equal(error.path, path);
    assert.match(error.message, /Missing/);
  }
});

test("cycles report a deterministic closed logical-ID path", () => {
  const parsed = parseCloudFormationTemplate(template({
    C: resource({ Value: { "Fn::Sub": "${A}" } }),
    A: resource({ Value: { Ref: "B" } }),
    B: { ...resource(), DependsOn: "C" },
  }));
  const error = captureGraphError(() => buildResourceDependencyGraph(parsed));
  assert.equal(error.kind, "CircularDependency");
  assert.deepEqual(error.details.cycle, ["A", "B", "C", "A"]);
  assert.match(error.message, /A -> B -> C -> A/);
  assert.equal(error.path, "$.Resources");
});

test("topological output and serialized graph records are deterministic across input order", () => {
  const first = parseCloudFormationTemplate(template({
    Zed: resource({ b: { Ref: "Base" }, a: { "Fn::GetAtt": ["Middle", "Id"] } }),
    Base: resource(),
    Middle: resource({ Value: { Ref: "Base" } }),
  }));
  const second = parseCloudFormationTemplate(template({
    Middle: resource({ Value: { Ref: "Base" } }),
    Base: resource(),
    Zed: resource({ a: { "Fn::GetAtt": ["Middle", "Id"] }, b: { Ref: "Base" } }),
  }));
  assert.deepEqual(buildResourceDependencyGraph(first), buildResourceDependencyGraph(second));
  assert.deepEqual(buildResourceDependencyGraph(first).order, ["Base", "Middle", "Zed"]);
});

test("standalone deterministic topological sorting validates missing nodes and cycles", () => {
  assert.deepEqual(topologicallySortResources({ C: ["A", "B"], B: ["A"], A: [], D: [] }), ["A", "B", "C", "D"]);

  let error = captureGraphError(() => topologicallySortResources({ A: ["Missing"] }));
  assert.equal(error.kind, "MissingReference");
  assert.equal(error.details.targetLogicalId, "Missing");

  error = captureGraphError(() => topologicallySortResources({ A: ["B"], B: ["A"] }));
  assert.equal(error.kind, "CircularDependency");
  assert.deepEqual(error.details.cycle, ["A", "B", "A"]);
});
