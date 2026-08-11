import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cfn15-closure");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");

const expected = Object.freeze({
  "AWS::ApiGateway::BasePathMapping": ["BasePath", "DomainName", "RestApiId", "Stage"],
  "AWS::ApiGateway::BasePathMappingV2": ["BasePath", "DomainNameArn", "RestApiId", "Stage"],
  "AWS::ApiGateway::ClientCertificate": ["Description", "Tags"],
  "AWS::ApiGateway::DocumentationPart": ["Location", "Properties", "RestApiId"],
  "AWS::ApiGateway::DocumentationVersion": ["Description", "DocumentationVersion", "RestApiId"],
  "AWS::ApiGateway::DomainName": ["DomainName", "EndpointConfiguration", "RegionalCertificateArn", "SecurityPolicy", "Tags"],
  "AWS::ApiGateway::DomainNameAccessAssociation": ["AccessAssociationSource", "AccessAssociationSourceType", "DomainNameArn", "Tags"],
  "AWS::ApiGateway::DomainNameV2": ["CertificateArn", "DomainName", "EndpointConfiguration", "Policy", "RoutingMode", "SecurityPolicy", "Tags"],
  "AWS::ApiGateway::VpcLink": ["Description", "Name", "Tags", "TargetArns"],
  "AWS::CloudWatch::MetricStream": ["FirehoseArn", "IncludeFilters", "Name", "OutputFormat", "RoleArn", "Tags"],
  "AWS::DynamoDB::GlobalTable": ["AttributeDefinitions", "BillingMode", "KeySchema", "Replicas", "StreamSpecification", "TableName"],
  "AWS::Lambda::CodeSigningConfig": ["AllowedPublishers", "CodeSigningPolicies", "Description", "Tags"],
  "AWS::Lambda::LayerVersionPermission": ["Action", "LayerVersionArn", "Principal"],
  "AWS::Lambda::Url": ["AuthType", "Cors", "InvokeMode", "TargetFunctionArn"],
  "AWS::SQS::QueuePolicy": ["PolicyDocument", "Queues"],
} as const);

test("the pinned CFN-15 CDK corpus synthesizes exactly the 15 frozen closure types and properties", { timeout: 180_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "stacksim-cdk-cfn15-synth-"));
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete inherited[key];
  }
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: "eu-west-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: "eu-west-1",
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [cdkCli, "--output", output, "synth", "--quiet"], {
        cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      child.once("error", reject);
      child.once("close", code => resolveResult({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    assert.equal(result.code, 0, `cdk synth failed\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /STACKSIM_NETWORK_TRIPWIRE/, "the pinned synth attempted an external network connection");

    const template = JSON.parse(await readFile(join(output, "Cfn15Closure.template.json"), "utf8"));
    const corpus: Record<string, string[][]> = {};
    for (const resource of Object.values(template.Resources) as any[]) {
      if (resource.Type === "AWS::CDK::Metadata") continue;
      (corpus[resource.Type] ??= []).push(Object.keys(resource.Properties ?? {}).sort());
    }
    assert.deepEqual(Object.keys(corpus).sort(), Object.keys(expected).sort());
    assert.equal(Object.values(corpus).reduce((total, entries) => total + entries.length, 0), 15);
    for (const [typeName, propertyNames] of Object.entries(expected)) {
      assert.deepEqual(corpus[typeName], [[...propertyNames].sort()], `${typeName} changed its pinned synthesized property boundary`);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
