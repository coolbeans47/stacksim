import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, DescribeStackEventsCommand, DescribeStacksCommand, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  GetPolicyCommand as GetIamPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
} from "@aws-sdk/client-iam";
import {
  GetAliasCommand,
  GetFunctionCommand,
  GetPolicyCommand as GetLambdaPolicyCommand,
  InvokeCommand,
  LambdaClient,
  ListVersionsByFunctionCommand,
} from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { StackSim } from "../src/server.js";
import { semanticCdkAssemblyDigests, sha256 } from "./support/artifact-snapshots.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cfn06-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

interface AssemblySnapshot {
  templateSha256: string;
  assetManifestSha256: string;
  logicalTypes: Record<string, string>;
  typeCounts: Record<string, number>;
  explicitDependencies: Record<string, string[]>;
  fileAssetIds: string[];
}

const EXPECTED_ASSEMBLIES: Record<"v1" | "v2" | "fail", AssemblySnapshot> = {
  v1: {
    templateSha256: "ab2d9060dbfbe5bf283e5d398fa7c873b9325f9da005649e700909014db44a36",
    assetManifestSha256: "83049fc7133aa6dadafba58f0e9e03c78f8383af7510ed9f75f6a8ba69078e05",
    logicalTypes: {
      BundledAlias861CB90F: "AWS::Lambda::Alias",
      BundledFunction779AF8D0: "AWS::Lambda::Function",
      BundledFunctionEventsInvoke6A044305: "AWS::Lambda::Permission",
      BundledLogs8D534D85: "AWS::Logs::LogGroup",
      BundledVersionB6E637E6: "AWS::Lambda::Version",
      CDKMetadata: "AWS::CDK::Metadata",
      EventPolicyCF688C56: "AWS::IAM::Policy",
      InlineFunction18B48CA2: "AWS::Lambda::Function",
      InlineLogs3C9EA4A8: "AWS::Logs::LogGroup",
      StreamPolicyBC48CF2E: "AWS::IAM::ManagedPolicy",
      WorkloadRoleA63FFF66: "AWS::IAM::Role",
    },
    typeCounts: {
      "AWS::CDK::Metadata": 1,
      "AWS::IAM::ManagedPolicy": 1,
      "AWS::IAM::Policy": 1,
      "AWS::IAM::Role": 1,
      "AWS::Lambda::Alias": 1,
      "AWS::Lambda::Function": 2,
      "AWS::Lambda::Permission": 1,
      "AWS::Lambda::Version": 1,
      "AWS::Logs::LogGroup": 2,
    },
    explicitDependencies: {
      BundledFunction779AF8D0: ["WorkloadRoleA63FFF66"],
      InlineFunction18B48CA2: ["WorkloadRoleA63FFF66"],
    },
    fileAssetIds: [
      "9b10c0f44fc69e3f7e81d8b9d9c9c096eb210e6aa44673c33133b301f6539f30",
      "ab2d9060dbfbe5bf283e5d398fa7c873b9325f9da005649e700909014db44a36",
    ],
  },
  v2: {
    templateSha256: "cce220de637edfda4ba376a9fc642e6085558b6d1830aec7dd369275d8c942e1",
    assetManifestSha256: "6debdf3905ebf9226da306b238fd39a47c14a2001cb53550230c27a18cddd065",
    logicalTypes: {
      BundledAlias861CB90F: "AWS::Lambda::Alias",
      BundledFunction779AF8D0: "AWS::Lambda::Function",
      BundledFunctionEventsInvoke6A044305: "AWS::Lambda::Permission",
      BundledLogs8D534D85: "AWS::Logs::LogGroup",
      BundledVersionB6E637E6: "AWS::Lambda::Version",
      CDKMetadata: "AWS::CDK::Metadata",
      EventPolicyCF688C56: "AWS::IAM::Policy",
      InlineFunction18B48CA2: "AWS::Lambda::Function",
      InlineLogs3C9EA4A8: "AWS::Logs::LogGroup",
      StreamPolicyBC48CF2E: "AWS::IAM::ManagedPolicy",
      WorkloadRoleA63FFF66: "AWS::IAM::Role",
    },
    typeCounts: {
      "AWS::CDK::Metadata": 1,
      "AWS::IAM::ManagedPolicy": 1,
      "AWS::IAM::Policy": 1,
      "AWS::IAM::Role": 1,
      "AWS::Lambda::Alias": 1,
      "AWS::Lambda::Function": 2,
      "AWS::Lambda::Permission": 1,
      "AWS::Lambda::Version": 1,
      "AWS::Logs::LogGroup": 2,
    },
    explicitDependencies: {
      BundledFunction779AF8D0: ["WorkloadRoleA63FFF66"],
      InlineFunction18B48CA2: ["WorkloadRoleA63FFF66"],
    },
    fileAssetIds: [
      "1ac5e9b5a25e405916726af422ab74525ea39dee08f535d710911699a8d13f9e",
      "cce220de637edfda4ba376a9fc642e6085558b6d1830aec7dd369275d8c942e1",
    ],
  },
  fail: {
    templateSha256: "14738ba9f03a9e52fa2e320236b9b49d1906ec1233fe2724687f975c1e67d245",
    assetManifestSha256: "da564e654334bec257f807baaf9475d71193fdfc5d02785870291519ba7ebedd",
    logicalTypes: {
      BundledAlias861CB90F: "AWS::Lambda::Alias",
      BundledFunction779AF8D0: "AWS::Lambda::Function",
      BundledFunctionEventsInvoke6A044305: "AWS::Lambda::Permission",
      BundledLogs8D534D85: "AWS::Logs::LogGroup",
      BundledVersionB6E637E6: "AWS::Lambda::Version",
      CDKMetadata: "AWS::CDK::Metadata",
      EventPolicyCF688C56: "AWS::IAM::Policy",
      InlineFunction18B48CA2: "AWS::Lambda::Function",
      InlineLogs3C9EA4A8: "AWS::Logs::LogGroup",
      RollbackFailure: "AWS::Lambda::Permission",
      StreamPolicyBC48CF2E: "AWS::IAM::ManagedPolicy",
      WorkloadRoleA63FFF66: "AWS::IAM::Role",
    },
    typeCounts: {
      "AWS::CDK::Metadata": 1,
      "AWS::IAM::ManagedPolicy": 1,
      "AWS::IAM::Policy": 1,
      "AWS::IAM::Role": 1,
      "AWS::Lambda::Alias": 1,
      "AWS::Lambda::Function": 2,
      "AWS::Lambda::Permission": 2,
      "AWS::Lambda::Version": 1,
      "AWS::Logs::LogGroup": 2,
    },
    explicitDependencies: {
      BundledFunction779AF8D0: ["WorkloadRoleA63FFF66"],
      InlineFunction18B48CA2: ["WorkloadRoleA63FFF66"],
      RollbackFailure: [
        "BundledAlias861CB90F",
        "BundledFunctionEventsInvoke6A044305",
        "BundledFunction779AF8D0",
        "BundledLogs8D534D85",
        "BundledVersionB6E637E6",
        "EventPolicyCF688C56",
        "InlineFunction18B48CA2",
        "InlineLogs3C9EA4A8",
        "StreamPolicyBC48CF2E",
        "WorkloadRoleA63FFF66",
      ],
    },
    fileAssetIds: [
      "14738ba9f03a9e52fa2e320236b9b49d1906ec1233fe2724687f975c1e67d245",
      "2461b7c6e32e0d8e9be9bec5d7908bc8081a9e9cbce48c98ae81c235f0ffce13",
    ],
  },
};

function cdkEnvironment(endpoint: string, tempRoot: string, release: "v1" | "v2" | "fail"): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_AGENT: "stacksim-tests/1", // Keep CDK metadata hashes independent of the host Node.js version.
    CDK_CFN06_TEST_RELEASE: release,
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runNpx(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const cli = args[0] === "cdk" ? cdkCli : undefined;
    assert.ok(cli, `unsupported project CLI ${args[0]}`);
    const child = spawn(process.execPath, [cli, ...args.slice(1)], {
      cwd: fixture,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function commandSucceeded(result: CommandResult, label: string): void {
  assert.equal(result.code, 0, `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /STACKSIM_NETWORK_TRIPWIRE/, `${label} attempted an outbound network connection`);
}

async function assemblySnapshot(outputDirectory: string): Promise<AssemblySnapshot> {
  const templateText = await readFile(join(outputDirectory, "Cfn06Stack.template.json"), "utf8");
  const assetManifestText = await readFile(join(outputDirectory, "Cfn06Stack.assets.json"), "utf8");
  const template = JSON.parse(templateText) as { Resources: Record<string, { Type: string; DependsOn?: string | string[] }> };
  const assetManifest = JSON.parse(assetManifestText) as { files?: Record<string, unknown>; dockerImages?: Record<string, unknown> };
  const entries = Object.entries(template.Resources).sort(([left], [right]) => left.localeCompare(right));
  const logicalTypes = Object.fromEntries(entries.map(([logicalId, resource]) => [logicalId, resource.Type]));
  const typeCounts = Object.fromEntries([...entries.reduce((counts, [, resource]) => counts.set(resource.Type, (counts.get(resource.Type) ?? 0) + 1), new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)));
  const explicitDependencies = Object.fromEntries(entries.flatMap(([logicalId, resource]) => resource.DependsOn === undefined ? [] : [[logicalId, (Array.isArray(resource.DependsOn) ? resource.DependsOn : [resource.DependsOn]).map(String)]]));
  assert.equal(Object.keys(assetManifest.dockerImages ?? {}).length, 0, "the ZIP-only CFN-06 fixture must not synthesize an image asset");
  const semanticDigests = await semanticCdkAssemblyDigests(outputDirectory, ["Cfn06Stack.template.json"], ["Cfn06Stack.assets.json"]);
  const rawTemplateHash = sha256(templateText);
  const semanticTemplateHash = semanticDigests["Cfn06Stack.template.json"];
  return {
    templateSha256: semanticTemplateHash,
    assetManifestSha256: semanticDigests["Cfn06Stack.assets.json"],
    logicalTypes,
    typeCounts,
    explicitDependencies,
    fileAssetIds: Object.keys(assetManifest.files ?? {}).map(id => id === rawTemplateHash ? semanticTemplateHash : id).sort(),
  };
}

function assertAssembly(actual: AssemblySnapshot, release: "v1" | "v2" | "fail"): void {
  assert.deepEqual(actual, EXPECTED_ASSEMBLIES[release], `${release} synthesized assembly changed; actual=${JSON.stringify(actual, null, 2)}`);
}

function payload(response: { Payload?: Uint8Array }): any {
  return JSON.parse(Buffer.from(response.Payload ?? []).toString("utf8"));
}

async function invoke(lambda: LambdaClient, functionName: string, expectedRelease: string, kind: string, qualifier?: string): Promise<{ executedVersion?: string }> {
  const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, ...(qualifier ? { Qualifier: qualifier } : {}), Payload: Buffer.from(JSON.stringify({ probe: `${kind}-${expectedRelease}` })) }));
  const decoded = payload(response);
  assert.equal(response.StatusCode, 200);
  assert.equal(response.FunctionError, undefined, `Lambda ${functionName}${qualifier ? `:${qualifier}` : ""} failed: ${JSON.stringify(decoded)}`);
  assert.deepEqual(decoded, { kind, release: expectedRelease, event: { probe: `${kind}-${expectedRelease}` } });
  return { executedVersion: response.ExecutedVersion };
}

async function logMessages(logs: CloudWatchLogsClient, logGroupName: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await logs.send(new FilterLogEventsCommand({ logGroupName }));
    const messages = (response.events ?? []).map(event => event.message ?? "").join("\n");
    if (messages) return messages;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return "";
}

test("pinned standard CDK exercises the complete CFN-06 provider set through deploy, update, compound rollback, restart, and destroy", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-cfn06-"));
  const dataDir = join(root, "data");
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let env = cdkEnvironment(endpoint, root, "v1");

    const cdkVersion = await runNpx(["cdk", "--version"], env, 30_000); commandSucceeded(cdkVersion, "cdk --version"); assert.match(cdkVersion.stdout, /^2\.1132\.0\b/);
    for (const [packageName, expected] of [["aws-cdk-lib", "2.265.0"], ["constructs", "10.7.1"], ["esbuild", "0.28.1"], ["tsx", "4.23.1"]] as const) {
      const packageJson = JSON.parse(await readFile(join(sourceRoot, "node_modules", packageName, "package.json"), "utf8"));
      assert.equal(packageJson.version, expected, `${packageName} version changed`);
    }

    const synthDirectory = join(root, "synth-v1.out");
    const synthesized = await runNpx(["cdk", "--output", synthDirectory, "synth", "Cfn06Stack", "--no-notices", "--no-color"], env);
    commandSucceeded(synthesized, "cdk synth Cfn06Stack");
    assertAssembly(await assemblySnapshot(synthDirectory), "v1");

    const options = { endpoint, region, credentials, maxAttempts: 1 };
    let cloudformation = new CloudFormationClient(options); let lambda = new LambdaClient(options); let iam = new IAMClient(options); let logs = new CloudWatchLogsClient(options);
    clients.push(cloudformation, lambda, iam, logs);

    const createDirectory = join(root, "create.out"); const createOutputs = join(root, "outputs-v1.json");
    const created = await runNpx(["cdk", "--output", createDirectory, "deploy", "Cfn06Stack", "--require-approval", "never", "--outputs-file", createOutputs, "--no-notices", "--no-color"], env, 180_000);
    commandSucceeded(created, "cdk deploy Cfn06Stack (v1)");
    assertAssembly(await assemblySnapshot(createDirectory), "v1");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn06Stack" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
    const v1 = JSON.parse(await readFile(createOutputs, "utf8")).Cfn06Stack as Record<string, string>;
    assert.deepEqual(Object.keys(v1).sort(), ["BundledAliasArn", "BundledFunctionName", "BundledLogGroup", "BundledVersionNumber", "EventPolicyName", "InlineFunctionName", "InlineLogGroup", "StreamPolicyArn", "WorkloadRoleName"]);
    assert.equal(v1.BundledVersionNumber, "1");
    assert.equal((await invoke(lambda, v1.InlineFunctionName, "v1", "inline")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v1.BundledFunctionName, "v1", "bundled")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v1.BundledFunctionName, "v1", "bundled", "live")).executedVersion, "1");
    assert.equal((await lambda.send(new GetAliasCommand({ FunctionName: v1.BundledFunctionName, Name: "live" }))).FunctionVersion, "1");
    const lambdaPolicy = JSON.parse((await lambda.send(new GetLambdaPolicyCommand({ FunctionName: v1.BundledFunctionName }))).Policy!);
    assert.ok(lambdaPolicy.Statement.some((statement: any) => statement.Principal === "events.amazonaws.com" && statement.Action === "lambda:InvokeFunction" && statement.Condition?.ArnLike?.["AWS:SourceArn"] === `arn:aws:events:${region}:000000000000:rule/cfn06-local`));
    const roleV1 = (await iam.send(new GetRoleCommand({ RoleName: v1.WorkloadRoleName }))).Role!; assert.equal(roleV1.MaxSessionDuration, 3600);
    const managedV1 = (await iam.send(new GetIamPolicyCommand({ PolicyArn: v1.StreamPolicyArn }))).Policy!;
    const managedDocumentV1 = (await iam.send(new GetPolicyVersionCommand({ PolicyArn: v1.StreamPolicyArn, VersionId: managedV1.DefaultVersionId! }))).PolicyVersion?.Document ?? "";
    assert.match(managedDocumentV1, /CreateStreamsV1/);
    assert.match((await iam.send(new GetRolePolicyCommand({ RoleName: v1.WorkloadRoleName, PolicyName: v1.EventPolicyName }))).PolicyDocument ?? "", /WriteEventsV1/);
    for (const group of [v1.InlineLogGroup, v1.BundledLogGroup]) {
      const found = (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }))).logGroups?.find(candidate => candidate.logGroupName === group);
      assert.equal(found?.retentionInDays, 7);
    }
    assert.match(await logMessages(logs, v1.InlineLogGroup), /cfn06 inline v1/);
    assert.match(await logMessages(logs, v1.BundledLogGroup), /cfn06 bundled v1/);
    const inlineFunctionV1 = await lambda.send(new GetFunctionCommand({ FunctionName: v1.InlineFunctionName }));
    const bundledFunctionV1 = await lambda.send(new GetFunctionCommand({ FunctionName: v1.BundledFunctionName }));

    env = cdkEnvironment(endpoint, root, "v2");
    const updateDirectory = join(root, "update.out"); const updateOutputs = join(root, "outputs-v2.json");
    const updated = await runNpx(["cdk", "--output", updateDirectory, "deploy", "Cfn06Stack", "--require-approval", "never", "--outputs-file", updateOutputs, "--no-notices", "--no-color"], env, 180_000);
    commandSucceeded(updated, "cdk deploy Cfn06Stack (v2)");
    assertAssembly(await assemblySnapshot(updateDirectory), "v2");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn06Stack" }))).Stacks?.[0]?.StackStatus, "UPDATE_COMPLETE");
    const v2 = JSON.parse(await readFile(updateOutputs, "utf8")).Cfn06Stack as Record<string, string>;
    assert.equal(v2.BundledVersionNumber, "2");
    for (const key of ["InlineFunctionName", "BundledFunctionName", "BundledAliasArn", "WorkloadRoleName", "StreamPolicyArn", "EventPolicyName", "InlineLogGroup", "BundledLogGroup"]) assert.equal(v2[key], v1[key], `${key} was unexpectedly replaced`);
    assert.equal((await invoke(lambda, v2.InlineFunctionName, "v2", "inline")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v2.BundledFunctionName, "v2", "bundled")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v2.BundledFunctionName, "v2", "bundled", "live")).executedVersion, "2");
    assert.equal((await lambda.send(new GetAliasCommand({ FunctionName: v2.BundledFunctionName, Name: "live" }))).FunctionVersion, "2");
    const inlineFunctionV2 = await lambda.send(new GetFunctionCommand({ FunctionName: v2.InlineFunctionName }));
    const bundledFunctionV2 = await lambda.send(new GetFunctionCommand({ FunctionName: v2.BundledFunctionName }));
    assert.equal(inlineFunctionV2.Configuration?.FunctionArn, inlineFunctionV1.Configuration?.FunctionArn); assert.notEqual(inlineFunctionV2.Configuration?.CodeSha256, inlineFunctionV1.Configuration?.CodeSha256);
    assert.equal(bundledFunctionV2.Configuration?.FunctionArn, bundledFunctionV1.Configuration?.FunctionArn); assert.notEqual(bundledFunctionV2.Configuration?.CodeSha256, bundledFunctionV1.Configuration?.CodeSha256);
    const roleV2 = (await iam.send(new GetRoleCommand({ RoleName: v2.WorkloadRoleName }))).Role!; assert.equal(roleV2.RoleId, roleV1.RoleId); assert.equal(roleV2.MaxSessionDuration, 7200);
    const managedV2 = (await iam.send(new GetIamPolicyCommand({ PolicyArn: v2.StreamPolicyArn }))).Policy!; assert.notEqual(managedV2.DefaultVersionId, managedV1.DefaultVersionId);
    assert.match((await iam.send(new GetPolicyVersionCommand({ PolicyArn: v2.StreamPolicyArn, VersionId: managedV2.DefaultVersionId! }))).PolicyVersion?.Document ?? "", /CreateStreamsV2/);
    assert.match((await iam.send(new GetRolePolicyCommand({ RoleName: v2.WorkloadRoleName, PolicyName: v2.EventPolicyName }))).PolicyDocument ?? "", /WriteEventsV2/);
    for (const group of [v2.InlineLogGroup, v2.BundledLogGroup]) {
      const found = (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }))).logGroups?.find(candidate => candidate.logGroupName === group);
      assert.equal(found?.retentionInDays, 30);
    }

    // The failure release deliberately mutates every CFN-06 provider family,
    // then creates one invalid permission that depends on all of those changes.
    // Standard CDK must observe a failed deployment while CloudFormation rolls
    // every already-completed mutation back to the exact v2 state.
    env = cdkEnvironment(endpoint, root, "fail");
    const failedSynthDirectory = join(root, "synth-fail.out");
    const failedSynth = await runNpx(["cdk", "--output", failedSynthDirectory, "synth", "Cfn06Stack", "--no-notices", "--no-color"], env);
    commandSucceeded(failedSynth, "cdk synth Cfn06Stack (fail)");
    assertAssembly(await assemblySnapshot(failedSynthDirectory), "fail");
    const failedDirectory = join(root, "compound-failure.out");
    const failed = await runNpx(["cdk", "--output", failedDirectory, "deploy", "Cfn06Stack", "--require-approval", "never", "--no-notices", "--no-color"], env, 240_000);
    assert.notEqual(failed.code, 0, `the compound failure fixture unexpectedly deployed\n${failed.stdout}\n${failed.stderr}`);
    assert.match(`${failed.stdout}\n${failed.stderr}`, /RollbackFailure|missing.function|UPDATE_ROLLBACK_COMPLETE|failed/i);
    const rolledBack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn06Stack" }))).Stacks?.[0];
    assert.equal(rolledBack?.StackStatus, "UPDATE_ROLLBACK_COMPLETE");
    assert.deepEqual(Object.fromEntries((rolledBack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!])), v2, "rollback changed the last successful outputs");

    assert.equal((await invoke(lambda, v2.InlineFunctionName, "v2", "inline")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v2.BundledFunctionName, "v2", "bundled")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v2.BundledFunctionName, "v2", "bundled", "live")).executedVersion, "2");
    assert.equal((await lambda.send(new GetAliasCommand({ FunctionName: v2.BundledFunctionName, Name: "live" }))).FunctionVersion, "2");
    const inlineAfterRollback = await lambda.send(new GetFunctionCommand({ FunctionName: v2.InlineFunctionName }));
    const bundledAfterRollback = await lambda.send(new GetFunctionCommand({ FunctionName: v2.BundledFunctionName }));
    assert.equal(inlineAfterRollback.Configuration?.CodeSha256, inlineFunctionV2.Configuration?.CodeSha256); assert.equal(inlineAfterRollback.Configuration?.Environment?.Variables?.RELEASE, "v2");
    assert.equal(bundledAfterRollback.Configuration?.CodeSha256, bundledFunctionV2.Configuration?.CodeSha256); assert.equal(bundledAfterRollback.Configuration?.Environment?.Variables?.RELEASE, "v2");
    assert.deepEqual((await lambda.send(new ListVersionsByFunctionCommand({ FunctionName: v2.BundledFunctionName }))).Versions?.map(item => item.Version), ["$LATEST", "2"], "rollback must remove the failed release version while preserving the current version");
    const policyAfterRollback = JSON.parse((await lambda.send(new GetLambdaPolicyCommand({ FunctionName: v2.BundledFunctionName }))).Policy!);
    assert.ok(policyAfterRollback.Statement.some((statement: any) => statement.Condition?.ArnLike?.["AWS:SourceArn"] === `arn:aws:events:${region}:000000000000:rule/cfn06-local`));
    assert.ok(!policyAfterRollback.Statement.some((statement: any) => String(statement.Condition?.ArnLike?.["AWS:SourceArn"] ?? "").includes("cfn06-local-fail")));
    assert.equal((await iam.send(new GetRoleCommand({ RoleName: v2.WorkloadRoleName }))).Role?.MaxSessionDuration, 7200);
    const managedAfterRollback = (await iam.send(new GetIamPolicyCommand({ PolicyArn: v2.StreamPolicyArn }))).Policy!;
    assert.match((await iam.send(new GetPolicyVersionCommand({ PolicyArn: v2.StreamPolicyArn, VersionId: managedAfterRollback.DefaultVersionId! }))).PolicyVersion?.Document ?? "", /CreateStreamsV2/);
    assert.doesNotMatch((await iam.send(new GetPolicyVersionCommand({ PolicyArn: v2.StreamPolicyArn, VersionId: managedAfterRollback.DefaultVersionId! }))).PolicyVersion?.Document ?? "", /CreateStreamsFail/);
    assert.match((await iam.send(new GetRolePolicyCommand({ RoleName: v2.WorkloadRoleName, PolicyName: v2.EventPolicyName }))).PolicyDocument ?? "", /WriteEventsV2/);
    for (const group of [v2.InlineLogGroup, v2.BundledLogGroup]) {
      const found = (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }))).logGroups?.find(candidate => candidate.logGroupName === group);
      assert.equal(found?.retentionInDays, 30);
    }
    const rollbackEvents = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: "Cfn06Stack" }))).StackEvents ?? [];
    assert.ok(rollbackEvents.some(event => event.LogicalResourceId === "RollbackFailure" && event.ResourceStatus === "CREATE_FAILED"));
    assert.ok(rollbackEvents.some(event => event.LogicalResourceId === "Cfn06Stack" && event.ResourceStatus === "UPDATE_ROLLBACK_COMPLETE"));
    assert.ok(rollbackEvents.some(event => event.ResourceStatus === "UPDATE_ROLLBACK_COMPLETE" && event.LogicalResourceId !== "Cfn06Stack"), "the compound rollback did not publish restored resource events");

    for (const client of clients) client.destroy(); clients.length = 0;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`; env = cdkEnvironment(endpoint, root, "v2");
    const restartedOptions = { endpoint, region, credentials, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(restartedOptions); lambda = new LambdaClient(restartedOptions); iam = new IAMClient(restartedOptions); logs = new CloudWatchLogsClient(restartedOptions); clients.push(cloudformation, lambda, iam, logs);
    assert.equal((await invoke(lambda, v2.InlineFunctionName, "v2", "inline")).executedVersion, "$LATEST");
    assert.equal((await invoke(lambda, v2.BundledFunctionName, "v2", "bundled", "live")).executedVersion, "2");
    assert.match(await logMessages(logs, v2.InlineLogGroup), /cfn06 inline v2/);
    assert.match(await logMessages(logs, v2.BundledLogGroup), /cfn06 bundled v2/);

    const destroyed = await runNpx(["cdk", "--output", join(root, "destroy.out"), "destroy", "Cfn06Stack", "--force", "--no-notices", "--no-color"], env, 180_000);
    commandSucceeded(destroyed, "cdk destroy Cfn06Stack");
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE", "DELETE_IN_PROGRESS", "DELETE_FAILED"] }))).StackSummaries?.some(stack => stack.StackName === "Cfn06Stack"), false);
    await assert.rejects(lambda.send(new GetFunctionCommand({ FunctionName: v2.InlineFunctionName })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    await assert.rejects(lambda.send(new GetFunctionCommand({ FunctionName: v2.BundledFunctionName })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    await assert.rejects(iam.send(new GetRoleCommand({ RoleName: v2.WorkloadRoleName })), error => /^NoSuchEntity/.test((error as { name?: string }).name ?? ""));
    await assert.rejects(iam.send(new GetIamPolicyCommand({ PolicyArn: v2.StreamPolicyArn })), error => /^NoSuchEntity/.test((error as { name?: string }).name ?? ""));
    for (const group of [v2.InlineLogGroup, v2.BundledLogGroup]) assert.equal((await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }))).logGroups?.some(candidate => candidate.logGroupName === group), false);
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
