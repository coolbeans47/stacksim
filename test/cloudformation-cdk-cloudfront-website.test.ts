import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { semanticCdkAssemblyDigests, sha256 } from "./support/artifact-snapshots.js";
import { cdkCli } from "./support/project-cli.js";

interface ProcessResult { code: number | null; stdout: string; stderr: string }

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cloudfront-website");
const frontend = join(fixture, "frontend");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");

function environment(tempRoot: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: "eu-west-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: "eu-west-1",
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    CLOUDFRONT_FIXTURE_VARIANT: "v1",
    JSII_AGENT: "stacksim-tests/1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    STACKSIM_NETWORK_ALLOW_PORT: "",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 240_000): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function imports(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) imports(item, output); return output; }
  if (!value || typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  if (typeof record["Fn::ImportValue"] === "string") output.push(record["Fn::ImportValue"]);
  for (const child of Object.values(record)) imports(child, output);
  return output;
}

test("CFR-01 ordinary CDK fixture synthesizes the frozen 17-resource CloudFront website graph", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cloudfront-synth-"));
  try {
    const env = environment(root);
    const built = await run(process.execPath, ["build.mjs"], frontend, env);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    const output = join(root, "cdk.out");
    const synthesized = await run(process.execPath, [cdkCli, "--output", output, "synth", "--no-notices", "--no-color"], fixture, env);
    assert.equal(synthesized.code, 0, `${synthesized.stdout}\n${synthesized.stderr}`);

    const lock = JSON.parse(await readFile(join(fixture, "expected-assembly.json"), "utf8"));
    const names = Object.keys(lock.files) as string[];
    const templateNames = names.filter(name => name.endsWith(".template.json"));
    const digests = await semanticCdkAssemblyDigests(output, templateNames, names.filter(name => !name.endsWith(".template.json")));
    assert.deepEqual(digests, lock.files, "the pinned CFR-01 semantic assembly drifted");
    assert.equal(sha256(names.map(name => digests[name]).join("\n")), lock.assemblySha256);

    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.version, lock.baseline.cloudAssemblySchema);
    assert.equal(manifest.minimumCliVersion, lock.baseline.minimumCliVersion);
    assert.deepEqual(manifest.artifacts.CloudFrontWebsiteStack.dependencies, lock.webDependencies);

    const identity = JSON.parse(await readFile(join(output, "FixtureIdentityExports.template.json"), "utf8"));
    const api = JSON.parse(await readFile(join(output, "FixtureApiExports.template.json"), "utf8"));
    const exportNames = [...Object.values<any>(identity.Outputs), ...Object.values<any>(api.Outputs)].map(outputValue => outputValue.Export?.Name).filter(Boolean);
    assert.deepEqual(exportNames, lock.producerExports);

    const template = JSON.parse(await readFile(join(output, "CloudFrontWebsiteStack.template.json"), "utf8"));
    assert.deepEqual(Object.entries<any>(template.Resources).map(([logicalId, resource]) => [logicalId, resource.Type]), lock.resources);
    assert.deepEqual(Object.keys(template.Outputs), lock.outputs);
    const importCounts = Object.fromEntries([...new Set(imports(template).sort())].map(name => [name, imports(template).filter(value => value === name).length]));
    assert.deepEqual(importCounts, lock.webImports);

    const bucket = template.Resources.WebBucket12880F5B;
    assert.deepEqual(bucket.Properties.OwnershipControls, { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] });
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, "AES256");
    assert.equal(bucket.DeletionPolicy, "Delete");

    const policyStatements = template.Resources.WebBucketPolicy95D08FAA.Properties.PolicyDocument.Statement;
    assert.equal(policyStatements.length, 3);
    assert.deepEqual(policyStatements.map((statement: any) => statement.Effect), ["Deny", "Allow", "Allow"]);
    assert.deepEqual(policyStatements[1].Action, ["s3:DeleteObject*", "s3:GetBucket*", "s3:List*", "s3:PutBucketPolicy"]);
    assert.equal(policyStatements[2].Principal.Service, "cloudfront.amazonaws.com");
    assert.equal(policyStatements[2].Action, "s3:GetObject");
    assert.ok(policyStatements[2].Condition.StringEquals["AWS:SourceArn"]);

    const responsePolicy = template.Resources.SecurityHeadersE66B69D3.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    assert.equal(responsePolicy.ContentSecurityPolicy.Override, true);
    assert.equal(responsePolicy.ContentTypeOptions.Override, true);
    assert.deepEqual(responsePolicy.FrameOptions, { FrameOption: "DENY", Override: true });
    assert.equal(responsePolicy.ReferrerPolicy.ReferrerPolicy, "strict-origin-when-cross-origin");
    assert.equal(responsePolicy.StrictTransportSecurity.AccessControlMaxAgeSec, 31_536_000);

    const fn = template.Resources.SpaRewrite1C145184.Properties;
    assert.equal(fn.AutoPublish, true);
    assert.equal(fn.FunctionConfig.Runtime, "cloudfront-js-1.0");
    assert.equal(createHash("sha256").update(fn.FunctionCode, "utf8").digest("hex"), lock.assets.functionCodeUtf8);
    assert.deepEqual(template.Resources.DistributionOrigin1S3OriginAccessControlEB606076.Properties.OriginAccessControlConfig, {
      Name: template.Resources.DistributionOrigin1S3OriginAccessControlEB606076.Properties.OriginAccessControlConfig.Name,
      OriginAccessControlOriginType: "s3",
      SigningBehavior: "always",
      SigningProtocol: "sigv4",
    });

    const config = template.Resources.Distribution830FAC52.Properties.DistributionConfig;
    assert.equal(config.DefaultRootObject, "index.html");
    assert.equal(config.HttpVersion, "http2and3");
    assert.equal(config.IPV6Enabled, true);
    assert.deepEqual(config.CacheBehaviors.map((behavior: any) => [behavior.PathPattern, behavior.CachePolicyId]), [
      ["assets/*", "658327ea-f89d-4fab-a63d-7e88639e58f6"],
      ["runtime-config.json", "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"],
    ]);
    assert.equal(config.DefaultCacheBehavior.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    assert.equal(config.DefaultCacheBehavior.FunctionAssociations[0].EventType, "viewer-request");
    assert.deepEqual(config.Origins[0].S3OriginConfig, { OriginAccessIdentity: "" });
    assert.deepEqual(config.Origins[0].DomainName, { "Fn::GetAtt": ["WebBucket12880F5B", "RegionalDomainName"] });

    const application = template.Resources.DeployApplicationCustomResource1B8B7410.Properties;
    assert.deepEqual(application.SourceObjectKeys, [lock.assets.applicationV1 + ".zip", lock.assets.runtimeConfigV1 + ".zip"]);
    assert.deepEqual(application.SourceMarkersConfig, [{}, {}]);
    assert.deepEqual(Object.keys(application.SourceMarkers[1]), ["<<marker:0xbaba:0>>", "<<marker:0xbaba:1>>", "<<marker:0xbaba:2>>"]);
    assert.equal(application.Prune, true);
    assert.deepEqual(application.SystemMetadata, { "cache-control": "no-cache" });
    assert.deepEqual(application.DistributionPaths, ["/*"]);
    assert.equal(application.WaitForDistributionInvalidation, true);
    assert.equal(application.OutputObjectKeys, true);

    const assets = template.Resources.DeployAssetsCustomResource49681559;
    assert.deepEqual(assets.Properties.SourceObjectKeys, [lock.assets.immutableAssetsV1 + ".zip"]);
    assert.equal(assets.Properties.Prune, false);
    assert.deepEqual(assets.Properties.SystemMetadata, { "cache-control": "public,max-age=31536000,immutable" });
    assert.equal(assets.Properties.DistributionId, undefined);
    assert.deepEqual(assets.DependsOn, ["DeployApplicationAwsCliLayerEBB97621", "DeployApplicationCustomResource1B8B7410"]);

    const assetManifest = JSON.parse(await readFile(join(output, "CloudFrontWebsiteStack.assets.json"), "utf8"));
    for (const assetId of Object.values<string>(lock.assets).filter(value => value !== lock.assets.functionCodeUtf8)) assert.ok(assetManifest.files[assetId], `missing file asset ${assetId}`);
    const helperPolicy = template.Resources.CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756CServiceRoleDefaultPolicy88902FDF.Properties.PolicyDocument.Statement;
    assert.deepEqual(helperPolicy[2], { Action: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], Effect: "Allow", Resource: "*" });
    assert.equal(template.Resources.CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F.Properties.Runtime, "nodejs24.x");
    assert.equal(template.Resources.CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C81C01536.Properties.Runtime, "python3.13");
    assert.deepEqual(template.Outputs.WebUrl.Value, { "Fn::Join": ["", ["https://", { "Fn::GetAtt": ["Distribution830FAC52", "DomainName"] }]] });

    const v2Environment = { ...env, CLOUDFRONT_FIXTURE_VARIANT: "v2" };
    const builtV2 = await run(process.execPath, ["build.mjs"], frontend, v2Environment);
    assert.equal(builtV2.code, 0, `${builtV2.stdout}\n${builtV2.stderr}`);
    const v2Output = join(root, "cdk-v2.out");
    const synthesizedV2 = await run(process.execPath, [cdkCli, "--output", v2Output, "synth", "--no-notices", "--no-color"], fixture, v2Environment);
    assert.equal(synthesizedV2.code, 0, `${synthesizedV2.stdout}\n${synthesizedV2.stderr}`);
    const v2Template = JSON.parse(await readFile(join(v2Output, "CloudFrontWebsiteStack.template.json"), "utf8"));
    assert.deepEqual(Object.entries<any>(v2Template.Resources).map(([logicalId, resource]) => [logicalId, resource.Type]), lock.resources);
    const v2Application = v2Template.Resources.DeployApplicationCustomResource1B8B7410.Properties;
    const v2Assets = v2Template.Resources.DeployAssetsCustomResource49681559.Properties;
    assert.notEqual(v2Application.SourceObjectKeys[0], application.SourceObjectKeys[0], "v2 must update the application deployment");
    assert.equal(v2Application.SourceObjectKeys[1], application.SourceObjectKeys[1], "resolved marker source identity must remain stable");
    assert.notEqual(v2Assets.SourceObjectKeys[0], assets.Properties.SourceObjectKeys[0], "v2 must update the immutable asset deployment so ordering restores the final graph");
  } finally {
    await run(process.execPath, ["build.mjs"], frontend, { ...environment(root), CLOUDFRONT_FIXTURE_VARIANT: "v1" }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFR-01 inventory classifies every pinned CloudFront command, paginator, and waiter", async () => {
  const sdk = join(sourceRoot, "node_modules", "@aws-sdk", "client-cloudfront", "dist-types");
  const commands = (await readdir(join(sdk, "commands"))).filter(name => name.endsWith("Command.d.ts") && name !== "index.d.ts").map(name => name.slice(0, -"Command.d.ts".length)).sort();
  const paginators = (await readdir(join(sdk, "pagination"))).filter(name => name.endsWith("Paginator.d.ts")).map(name => name.slice(0, -"Paginator.d.ts".length)).sort();
  const waiters = (await readdir(join(sdk, "waiters"))).filter(name => name.startsWith("waitFor") && name.endsWith(".d.ts")).map(name => name.slice("waitFor".length, -".d.ts".length)).sort();
  assert.equal(commands.length, 167);
  assert.equal(paginators.length, 17);
  assert.equal(waiters.length, 4);
  const inventory = await readFile(join(sourceRoot, "docs", "cloudfront-action-inventory.md"), "utf8");
  for (const command of commands) assert.ok(inventory.includes(`\`${command}\``), `CloudFront command ${command} is not classified`);
  for (const paginator of paginators) assert.ok(inventory.includes(`\`${paginator}\``), `CloudFront paginator ${paginator} is not classified`);
  for (const waiter of waiters) assert.ok(inventory.includes(`\`${waiter}\``), `CloudFront waiter ${waiter} is not classified`);
});
