import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CreateAliasCommand,
  CreateCapacityProviderCommand,
  CreateFunctionCommand,
  DeleteCapacityProviderCommand,
  DeleteFunctionCommand,
  GetCapacityProviderCommand,
  GetFunctionConfigurationCommand,
  GetFunctionScalingConfigCommand,
  InvokeCommand,
  LambdaClient,
  ListCapacityProvidersCommand,
  ListFunctionVersionsByCapacityProviderCommand,
  ListTagsCommand,
  PublishVersionCommand,
  PutFunctionScalingConfigCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateCapacityProviderCommand,
  UpdateFunctionCodeCommand,
} from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function active(lambda: LambdaClient, name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if ((await lambda.send(new GetCapacityProviderCommand({ CapacityProviderName: name }))).CapacityProvider?.State === "Active") return; await delay(5); }
  throw new Error(`Capacity provider ${name} did not become Active`);
}

function provider(name: string) {
  return {
    CapacityProviderName: name,
    VpcConfig: { SubnetIds: ["subnet-0123abcd"], SecurityGroupIds: ["sg-0123abcd"] },
    PermissionsConfig: { CapacityProviderOperatorRoleArn: role },
    InstanceRequirements: { Architectures: ["x86_64" as const], AllowedInstanceTypes: ["m7i.large"] },
    CapacityProviderScalingConfig: { ScalingMode: "Auto" as const, MaxVCpuCount: 20, ScalingPolicies: [{ PredefinedMetricType: "LambdaCapacityProviderAverageCPUUtilization" as const, TargetValue: 60 }] },
    PropagateTags: { Mode: "Explicit" as const, ExplicitTags: { workload: "training" } },
    TelemetryConfig: { LoggingConfig: { SystemLogLevel: "INFO" as const, LogGroup: "/aws/lambda/capacity-provider/training" } },
    Tags: { owner: "platform" },
  };
}

test("Lambda Managed Instances capacity providers support lifecycle, assignment, publishing, scaling, tags, pagination, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-capacity-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined;
  const connect = () => { lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); };
  const disconnect = () => { lambda?.destroy(); lambda = undefined; };
  try {
    await simulator.start(); connect(); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await assert.rejects(lambda!.send(new CreateCapacityProviderCommand({ ...provider("invalid"), VpcConfig: { SubnetIds: [], SecurityGroupIds: [] } })), (error: any) => error.name === "InvalidParameterValueException" && /1-16/.test(error.message));
    const created = await lambda!.send(new CreateCapacityProviderCommand(provider("managed-a"))); assert.equal(created.CapacityProvider?.State, "Pending"); const arn = created.CapacityProvider!.CapacityProviderArn!; assert.match(arn, /:capacity-provider:managed-a$/); assert.deepEqual(created.CapacityProvider?.InstanceRequirements?.AllowedInstanceTypes, ["m7i.large"]); assert.equal(created.CapacityProvider?.TelemetryConfig?.LoggingConfig?.SystemLogLevel, "INFO");
    await assert.rejects(lambda!.send(new CreateCapacityProviderCommand(provider("managed-a"))), (error: any) => error.name === "ResourceConflictException");
    await lambda!.send(new CreateCapacityProviderCommand(provider("managed-b"))); await Promise.all([active(lambda!, "managed-a"), active(lambda!, "managed-b")]);
    const first = await lambda!.send(new ListCapacityProvidersCommand({ MaxItems: 1 })); assert.equal(first.CapacityProviders?.length, 1); assert.ok(first.NextMarker); const second = await lambda!.send(new ListCapacityProvidersCommand({ MaxItems: 1, Marker: first.NextMarker })); assert.equal(second.CapacityProviders?.length, 1); assert.notEqual(first.CapacityProviders?.[0].CapacityProviderArn, second.CapacityProviders?.[0].CapacityProviderArn);
    await assert.rejects(lambda!.send(new ListCapacityProvidersCommand({ MaxItems: 1, Marker: first.NextMarker, State: "Active" })), (error: any) => error.name === "InvalidParameterValueException" && /Marker/.test(error.message));

    await lambda!.send(new TagResourceCommand({ Resource: arn, Tags: { course: "lambda" } })); assert.deepEqual((await lambda!.send(new ListTagsCommand({ Resource: arn }))).Tags, { owner: "platform", course: "lambda" }); await lambda!.send(new UntagResourceCommand({ Resource: arn, TagKeys: ["owner"] })); assert.deepEqual((await lambda!.send(new ListTagsCommand({ Resource: arn }))).Tags, { course: "lambda" });

    const managedConfig = { LambdaManagedInstancesCapacityProviderConfig: { CapacityProviderArn: arn, ExecutionEnvironmentMemoryGiBPerVCpu: 4, PerExecutionEnvironmentMaxConcurrency: 80 } };
    const functionCreated = await lambda!.send(new CreateFunctionCommand({ FunctionName: "managed-handler", Runtime: "nodejs22.x", Role: role, Handler: "handler.echoHandler", Code: { ZipFile: zip }, CapacityProviderConfig: managedConfig, PublishTo: "LATEST_PUBLISHED" })); const functionArn = functionCreated.FunctionArn!.replace(/:\$LATEST\.PUBLISHED$/, "");
    assert.equal(functionCreated.Version, "$LATEST.PUBLISHED"); assert.deepEqual(functionCreated.CapacityProviderConfig, managedConfig); await delay(10);
    const invoked = await lambda!.send(new InvokeCommand({ FunctionName: "managed-handler", Payload: Buffer.from('{"managed":true}') })); assert.equal(invoked.ExecutedVersion, "$LATEST.PUBLISHED"); assert.deepEqual(JSON.parse(Buffer.from(invoked.Payload ?? []).toString("utf8")), { managed: true });
    const attached = await lambda!.send(new ListFunctionVersionsByCapacityProviderCommand({ CapacityProviderName: "managed-a", MaxItems: 50 })); assert.equal(attached.CapacityProviderArn, arn); assert.deepEqual(attached.FunctionVersions?.map(item => item.FunctionArn).sort(), [`${functionArn}:$LATEST`, `${functionArn}:$LATEST.PUBLISHED`].sort());
    await assert.rejects(lambda!.send(new DeleteCapacityProviderCommand({ CapacityProviderName: "managed-a" })), (error: any) => error.name === "ResourceConflictException" && /attached/.test(error.message));

    assert.equal((await lambda!.send(new PutFunctionScalingConfigCommand({ FunctionName: "managed-handler", Qualifier: "$LATEST.PUBLISHED", FunctionScalingConfig: { MinExecutionEnvironments: 2, MaxExecutionEnvironments: 8 } }))).FunctionState, "Active");
    const scaling = await lambda!.send(new GetFunctionScalingConfigCommand({ FunctionName: "managed-handler", Qualifier: "$LATEST.PUBLISHED" })); assert.deepEqual(scaling.RequestedFunctionScalingConfig, { MinExecutionEnvironments: 2, MaxExecutionEnvironments: 8 }); assert.deepEqual(scaling.AppliedFunctionScalingConfig, scaling.RequestedFunctionScalingConfig);
    await assert.rejects(lambda!.send(new PutFunctionScalingConfigCommand({ FunctionName: "managed-handler", Qualifier: "$LATEST.PUBLISHED", FunctionScalingConfig: { MinExecutionEnvironments: 9, MaxExecutionEnvironments: 8 } })), (error: any) => error.name === "InvalidParameterValueException" && /cannot exceed/.test(error.message));

    const numbered = await lambda!.send(new PublishVersionCommand({ FunctionName: "managed-handler" })); assert.equal(numbered.Version, "1"); assert.deepEqual(numbered.CapacityProviderConfig, managedConfig); await lambda!.send(new CreateAliasCommand({ FunctionName: "managed-handler", Name: "live", FunctionVersion: numbered.Version! })); await lambda!.send(new PutFunctionScalingConfigCommand({ FunctionName: "managed-handler", Qualifier: "live", FunctionScalingConfig: { MaxExecutionEnvironments: 3 } })); assert.equal((await lambda!.send(new GetFunctionScalingConfigCommand({ FunctionName: "managed-handler", Qualifier: "live" }))).FunctionArn, `${functionArn}:live`);
    const republished = await lambda!.send(new UpdateFunctionCodeCommand({ FunctionName: "managed-handler", ZipFile: zip, PublishTo: "LATEST_PUBLISHED" })); assert.equal(republished.Version, "$LATEST.PUBLISHED"); assert.equal((await lambda!.send(new GetFunctionConfigurationCommand({ FunctionName: "managed-handler", Qualifier: "$LATEST.PUBLISHED" }))).CapacityProviderConfig?.LambdaManagedInstancesCapacityProviderConfig?.CapacityProviderArn, arn);

    const updated = await lambda!.send(new UpdateCapacityProviderCommand({ CapacityProviderName: "managed-a", CapacityProviderScalingConfig: { ScalingMode: "Manual", MaxVCpuCount: 30 }, PropagateTags: { Mode: "None" }, TelemetryConfig: { LoggingConfig: { SystemLogLevel: "WARN" } } })); assert.equal(updated.CapacityProvider?.State, "Pending");
    disconnect(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); connect(); const recovered = await lambda!.send(new GetCapacityProviderCommand({ CapacityProviderName: "managed-a" })); assert.equal(recovered.CapacityProvider?.State, "Active"); assert.equal(recovered.CapacityProvider?.CapacityProviderScalingConfig?.ScalingMode, "Manual"); assert.equal(recovered.CapacityProvider?.TelemetryConfig?.LoggingConfig?.SystemLogLevel, "WARN"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);

    await lambda!.send(new DeleteFunctionCommand({ FunctionName: "managed-handler" })); const deleting = await lambda!.send(new DeleteCapacityProviderCommand({ CapacityProviderName: "managed-a" })); assert.equal(deleting.CapacityProvider?.State, "Deleting"); await delay(70); await assert.rejects(lambda!.send(new GetCapacityProviderCommand({ CapacityProviderName: "managed-a" })), (error: any) => error.name === "ResourceNotFoundException"); await lambda!.send(new DeleteCapacityProviderCommand({ CapacityProviderName: "managed-b" }));
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("capacity-provider assignment enforces lambda:PassCapacityProvider independently of the function action and iam:PassRole", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-capacity-auth-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const lambda = new LambdaClient({ endpoint, region, credentials }); const iam = new IAMClient({ endpoint, region, credentials }); const sts = new STSClient({ endpoint, region, credentials }); clients.push(lambda, iam, sts);
    const created = await lambda.send(new CreateCapacityProviderCommand(provider("auth-provider"))); await active(lambda, "auth-provider"); const arn = created.CapacityProvider!.CapacityProviderArn!;
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }); const caller = await iam.send(new CreateRoleCommand({ RoleName: "capacity-deployer", AssumeRolePolicyDocument: trust }));
    const policy = (passProvider: boolean) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "lambda:CreateFunction", Resource: "*" }, { Effect: "Allow", Action: "iam:PassRole", Resource: role, Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } } }, ...(passProvider ? [{ Effect: "Allow", Action: "lambda:PassCapacityProvider", Resource: arn }] : [])] });
    await iam.send(new PutRolePolicyCommand({ RoleName: "capacity-deployer", PolicyName: "deploy", PolicyDocument: policy(false) })); const session = await sts.send(new AssumeRoleCommand({ RoleArn: caller.Role!.Arn!, RoleSessionName: "capacity-deployer" })); const deployer = new LambdaClient({ endpoint, region, credentials: { accessKeyId: session.Credentials!.AccessKeyId!, secretAccessKey: session.Credentials!.SecretAccessKey!, sessionToken: session.Credentials!.SessionToken! } }); clients.push(deployer); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); const input = { FunctionName: "capacity-auth-handler", Runtime: "nodejs22.x" as const, Role: role, Handler: "handler.echoHandler", Code: { ZipFile: zip }, CapacityProviderConfig: { LambdaManagedInstancesCapacityProviderConfig: { CapacityProviderArn: arn } }, PublishTo: "LATEST_PUBLISHED" as const };
    await assert.rejects(deployer.send(new CreateFunctionCommand(input)), (error: any) => error.name === "AccessDeniedException" && /lambda:PassCapacityProvider/.test(error.message)); await iam.send(new PutRolePolicyCommand({ RoleName: "capacity-deployer", PolicyName: "deploy", PolicyDocument: policy(true) })); assert.equal((await deployer.send(new CreateFunctionCommand(input))).Version, "$LATEST.PUBLISHED");
  } finally { for (const client of clients) client.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("capacity-provider catalog and attachment quotas reject the first over-limit mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-capacity-quotas-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); const created = await lambda.send(new CreateCapacityProviderCommand(provider("quota-provider"))); await active(lambda, "quota-provider"); const arn = created.CapacityProvider!.CapacityProviderArn!; const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); await lambda.send(new CreateFunctionCommand({ FunctionName: "quota-handler", Runtime: "nodejs22.x", Role: role, Handler: "handler.echoHandler", Code: { ZipFile: zip }, CapacityProviderConfig: { LambdaManagedInstancesCapacityProviderConfig: { CapacityProviderArn: arn } }, PublishTo: "LATEST_PUBLISHED" }));
    const fn = simulator.store.regionState(region).functions["quota-handler"]; const snapshot = fn.versions!["$LATEST.PUBLISHED"]; for (let version = 1; version <= 98; version++) fn.versions![String(version)] = { ...structuredClone(snapshot), version: String(version), functionArn: `${fn.functionArn}:${version}` }; fn.version = 98; await simulator.store.save(); await assert.rejects(lambda.send(new PublishVersionCommand({ FunctionName: "quota-handler" })), (error: any) => error.name === "ServiceException" && /100 attached/.test(error.message)); assert.equal(Object.keys(fn.versions!).length + 1, 100);
    const catalog = simulator.store.regionState(region).lambdaCapacityProviders; const template = catalog["quota-provider"]; for (let index = 1; index < 1000; index++) { const name = `seed-${index}`; catalog[name] = { ...structuredClone(template), capacityProviderName: name, capacityProviderArn: `arn:aws:lambda:${region}:000000000000:capacity-provider:${name}` }; } await assert.rejects(lambda.send(new CreateCapacityProviderCommand(provider("over-catalog-limit"))), (error: any) => error.name === "ServiceException" && /1000 capacity/.test(error.message)); assert.equal(Object.keys(catalog).length, 1000);
  } finally { lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
