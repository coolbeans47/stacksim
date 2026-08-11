import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GetRestApisCommand, GetStageCommand, APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeChangeSetCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { CloudFormationCheckpointObservation } from "../src/cloudformation.js";
import { StackSim } from "../src/server.js";
import { semanticCdkAssemblyDigests } from "./support/artifact-snapshots.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "rest-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const cfn0108ResourceTypes = new Set([
  "AWS::ApiGateway::Account",
  "AWS::ApiGateway::ApiKey",
  "AWS::ApiGateway::Authorizer",
  "AWS::ApiGateway::Deployment",
  "AWS::ApiGateway::GatewayResponse",
  "AWS::ApiGateway::Method",
  "AWS::ApiGateway::Model",
  "AWS::ApiGateway::RequestValidator",
  "AWS::ApiGateway::Resource",
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGateway::Stage",
  "AWS::ApiGateway::UsagePlan",
  "AWS::ApiGateway::UsagePlanKey",
  "AWS::CDK::Metadata",
  "AWS::DynamoDB::Table",
  "AWS::IAM::ManagedPolicy",
  "AWS::IAM::Policy",
  "AWS::IAM::Role",
  "AWS::Lambda::Alias",
  "AWS::Lambda::Function",
  "AWS::Lambda::Permission",
  "AWS::Lambda::Version",
  "AWS::Logs::LogGroup",
]);
const registeredResourceTypes = new Set([
  ...cfn0108ResourceTypes,
  "AWS::ApiGateway::BasePathMapping",
  "AWS::ApiGateway::BasePathMappingV2",
  "AWS::ApiGateway::ClientCertificate",
  "AWS::ApiGateway::DocumentationPart",
  "AWS::ApiGateway::DocumentationVersion",
  "AWS::ApiGateway::DomainName",
  "AWS::ApiGateway::DomainNameAccessAssociation",
  "AWS::ApiGateway::DomainNameV2",
  "AWS::ApiGateway::VpcLink",
  "AWS::ApiGatewayV2::Api",
  "AWS::ApiGatewayV2::ApiMapping",
  "AWS::ApiGatewayV2::Authorizer",
  "AWS::ApiGatewayV2::Deployment",
  "AWS::ApiGatewayV2::DomainName",
  "AWS::ApiGatewayV2::Integration",
  "AWS::ApiGatewayV2::IntegrationResponse",
  "AWS::ApiGatewayV2::Model",
  "AWS::ApiGatewayV2::Route",
  "AWS::ApiGatewayV2::RouteResponse",
  "AWS::ApiGatewayV2::Stage",
  "AWS::AppSync::ApiKey",
  "AWS::AppSync::DataSource",
  "AWS::AppSync::FunctionConfiguration",
  "AWS::AppSync::GraphQLApi",
  "AWS::AppSync::GraphQLSchema",
  "AWS::AppSync::Resolver",
  "AWS::CloudFormation::CustomResource",
  "AWS::CloudFormation::Stack",
  "AWS::CloudWatch::Alarm",
  "AWS::CloudWatch::AnomalyDetector",
  "AWS::CloudWatch::CompositeAlarm",
  "AWS::CloudWatch::Dashboard",
  "AWS::CloudWatch::InsightRule",
  "AWS::CloudWatch::MetricStream",
  "AWS::Cognito::UserPool",
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolDomain",
  "AWS::Cognito::UserPoolGroup",
  "AWS::Cognito::UserPoolIdentityProvider",
  "AWS::Cognito::UserPoolResourceServer",
  "AWS::Cognito::UserPoolUser",
  "AWS::Cognito::UserPoolUserToGroupAttachment",
  "AWS::DynamoDB::GlobalTable",
  "AWS::Events::EventBus",
  "AWS::Events::Rule",
  "AWS::Lambda::CodeSigningConfig",
  "AWS::Lambda::EventInvokeConfig",
  "AWS::Lambda::EventSourceMapping",
  "AWS::Lambda::LayerVersion",
  "AWS::Lambda::LayerVersionPermission",
  "AWS::Lambda::Url",
  "AWS::Logs::Destination",
  "AWS::Logs::LogStream",
  "AWS::Logs::MetricFilter",
  "AWS::Logs::QueryDefinition",
  "AWS::Logs::ResourcePolicy",
  "AWS::Logs::SubscriptionFilter",
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBParameterGroup",
  "AWS::S3::Bucket",
  "AWS::S3::BucketPolicy",
  "AWS::SES::ConfigurationSet",
  "AWS::SES::ConfigurationSetEventDestination",
  "AWS::SES::ContactList",
  "AWS::SES::CustomVerificationEmailTemplate",
  "AWS::SES::EmailIdentity",
  "AWS::SES::Template",
  "AWS::SNS::Subscription",
  "AWS::SNS::Topic",
  "AWS::SNS::TopicInlinePolicy",
  "AWS::SNS::TopicPolicy",
  "AWS::SQS::Queue",
  "AWS::SQS::QueuePolicy",
  "AWS::SecretsManager::ResourcePolicy",
  "AWS::SecretsManager::RotationSchedule",
  "AWS::SecretsManager::Secret",
  "AWS::SecretsManager::SecretTargetAttachment",
  "AWS::SSM::Parameter",
  "AWS::StepFunctions::StateMachine",
  "Custom::AmplifyDynamoDBTable",
  "Custom::CDKBucketDeployment",
  "Custom::S3AutoDeleteObjects",
]);

interface CdkResult { code: number | null; stdout: string; stderr: string }

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return port;
}

function cdkEnvironment(endpoint: string, tempRoot: string, release: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
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
    CDK_RECOVERY_MATRIX: "1",
    CDK_REST_TEST_VERSION: release,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 240_000): Promise<CdkResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd: fixture,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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

function deadline<T>(promise: Promise<T>, label: string, timeoutMs = 90_000): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for CloudFormation checkpoint ${label}`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function checkpointBeforeCdkExit(
  checkpoint: Promise<CloudFormationCheckpointObservation>,
  command: Promise<CdkResult>,
  label: string,
  timeoutMs = 90_000,
): Promise<CloudFormationCheckpointObservation> {
  return Promise.race([
    deadline(checkpoint, label, timeoutMs),
    command.then(result => {
      throw new Error(`CDK exited before CloudFormation checkpoint ${label}: code=${result.code}\n${result.stdout}\n${result.stderr}`);
    }),
  ]);
}

test("standard CDK waiters survive the CFN-01 through CFN-08 interruption matrix", { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-recovery-"));
  const dataDir = join(root, "data");
  const port = await freePort();
  let invokePort = await freePort();
  while (invokePort === port) invokePort = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let simulator: StackSim | undefined;
  const clients: Array<{ destroy(): void }> = [];
  let armed: {
    readonly label: string;
    readonly matches: (observation: CloudFormationCheckpointObservation) => boolean;
    readonly resolve: (observation: CloudFormationCheckpointObservation) => void;
  } | undefined;
  const observed: CloudFormationCheckpointObservation[] = [];

  const interceptor = (observation: CloudFormationCheckpointObservation): boolean => {
    if (!armed || !armed.matches(observation)) return false;
    const current = armed;
    armed = undefined;
    observed.push(observation);
    current.resolve(observation);
    return true;
  };

  const arm = (label: string, matches: (observation: CloudFormationCheckpointObservation) => boolean): Promise<CloudFormationCheckpointObservation> => {
    assert.equal(armed, undefined, "only one recovery checkpoint may be armed at a time");
    return new Promise(resolvePromise => { armed = { label, matches, resolve: resolvePromise }; });
  };

  const start = async (): Promise<StackSim> => {
    const next = new StackSim({ port, invokePort, cloudFormationCustomResourceCallbackPort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    next.cloudformation.setCheckpointInterceptorForTest(interceptor);
    await next.start();
    simulator = next;
    return next;
  };

  const restart = async (): Promise<StackSim> => {
    await simulator?.stop();
    simulator = undefined;
    return start();
  };

  try {
    await start();
    const clientOptions = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(clientOptions); clients.push(cloudformation);
    const lambda = new LambdaClient(clientOptions); clients.push(lambda);
    const dynamodb = new DynamoDBClient(clientOptions); clients.push(dynamodb);
    const apiGateway = new APIGatewayClient(clientOptions); clients.push(apiGateway);
    const s3 = new S3Client({ ...clientOptions, forcePathStyle: true }); clients.push(s3);
    const env = cdkEnvironment(endpoint, root, "v3");
    const assembly = join(root, "prepared.out");
    const registeredTypes = ((simulator!.cloudformation as any).providers.list() as Array<{ typeName: string }>).map(provider => provider.typeName).sort();
    assert.equal(cfn0108ResourceTypes.size, 23);
    assert.equal(registeredResourceTypes.size, 105);
    assert.deepEqual([...registeredResourceTypes].sort(), registeredTypes, "the exact registry inventory must track every registered production provider; this recovery scenario still synthesizes only the historical CFN-01 through CFN-08 fixture");

    const prepared = await runCdk(["--output", assembly, "deploy", "RestStack", "--method", "prepare-change-set", "--change-set-name", "recovery-create", "--require-approval", "never"], env);
    assert.equal(prepared.code, 0, `${prepared.stdout}\n${prepared.stderr}`);
    const templateBytes = await readFile(join(assembly, "RestStack.template.json"));
    const synthesized = JSON.parse(templateBytes.toString("utf8")) as { Resources: Record<string, { Type: string }> };
    const synthesizedTypes = [...new Set(Object.values(synthesized.Resources).map(resource => resource.Type))].sort();
    assert.deepEqual(synthesizedTypes, [...cfn0108ResourceTypes].sort(), "the standard-CDK Scenario C fixture must retain the complete CFN-01 through CFN-08 provider set; the four public S3 website types are frozen in the React fixture");
    const digests = await semanticCdkAssemblyDigests(assembly, ["RestStack.template.json"], ["RestStack.assets.json", "manifest.json"]);
    assert.deepEqual({ template: digests["RestStack.template.json"], assets: digests["RestStack.assets.json"], manifest: digests["manifest.json"] }, {
      template: "2f59fdd530e15246ebc21c98974d3b9962435f4be82759733dd179b37130341e",
      assets: "8805a6afb716b503e1d99cd5b00d93f6473be36a4327bfa326d99d6d141e2cfc",
      manifest: "c6a56813c3568a5b7fdf0d43246acd6124e2e678b9d4235473b54492eb16ca4c",
    }, "the pinned CDK 2.1132.0/aws-cdk-lib 2.261.0 Scenario C semantic assembly drifted");
    const changeSet = await cloudformation.send(new DescribeChangeSetCommand({ StackName: "RestStack", ChangeSetName: "recovery-create" }));
    assert.equal(changeSet.Status, "CREATE_COMPLETE");
    assert.equal(changeSet.ExecutionStatus, "AVAILABLE");
    const bootstrap = simulator!.store.regionState(region).cloudformation.bootstrap;
    assert.ok(bootstrap?.bucketName);
    const published = await s3.send(new ListObjectsV2Command({ Bucket: bootstrap.bucketName }));
    assert.ok((published.Contents?.length ?? 0) >= 2, "prepared standard-CDK deployment must durably publish the template and Lambda file asset");

    // Restart after asset publication and durable change-set creation.
    await restart();
    assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ StackName: "RestStack", ChangeSetName: "recovery-create" }))).ExecutionStatus, "AVAILABLE");

    const acceptedPause = arm("stack acceptance/change-set execution", observation => observation.operationKind === "CREATE" && observation.checkpoint === "accepted");
    const executing = runCdk(["deploy", "RestStack", "--method", "execute-change-set", "--change-set-name", "recovery-create", "--require-approval", "never"], env);
    await checkpointBeforeCdkExit(acceptedPause, executing, "stack acceptance/change-set execution");

    const remainingTypes = new Set(cfn0108ResourceTypes);
    let needsProviderStabilization = true;
    while (needsProviderStabilization || remainingTypes.size > 0) {
      const nextPause = arm("next provider/create boundary", observation => {
        if (observation.operationKind !== "CREATE") return false;
        if (needsProviderStabilization && observation.checkpoint.startsWith("provider:")) {
          needsProviderStabilization = false;
          return true;
        }
        if (!observation.checkpoint.endsWith(":create-complete") || !observation.resourceType || !remainingTypes.has(observation.resourceType)) return false;
        remainingTypes.delete(observation.resourceType);
        return true;
      });
      await restart();
      await checkpointBeforeCdkExit(nextPause, executing, `provider/create boundary; remaining=${[...remainingTypes].join(",")}`);
    }

    const outputsPause = arm("output evaluation", observation => observation.operationKind === "CREATE" && observation.checkpoint === "outputs-evaluated");
    await restart();
    await checkpointBeforeCdkExit(outputsPause, executing, "output evaluation");
    await restart();
    const executed = await executing;
    assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}\ncheckpoints=${JSON.stringify(observed, null, 2)}`);
    const pausedCreateTypes = [...new Set(observed.flatMap(value => value.checkpoint.endsWith(":create-complete") && value.resourceType ? [value.resourceType] : []))].sort();
    assert.deepEqual(pausedCreateTypes, [...cfn0108ResourceTypes].sort(), "Scenario C must pause and restart after create for every CFN-01 through CFN-08 production provider type");

    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    const outputs = Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!])) as Record<string, string>;
    assert.equal(Object.keys(simulator!.store.regionState(region).cloudformation.stacks[stack!.StackId!].resources).length, Object.keys(synthesized.Resources).length, "every synthesized logical resource must be owned exactly once after recovery");
    assert.equal(Object.keys(simulator!.store.regionState(region).functions).length, 1, "recovery must not duplicate Lambda functions");
    assert.equal(Object.keys(simulator!.store.regionState(region).tables).length, 1, "recovery must not duplicate DynamoDB tables");
    assert.equal(Object.keys(simulator!.store.regionState(region).apis).length, 1, "recovery must not duplicate REST APIs");
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }))).Configuration?.MemorySize, 256);
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table?.TableStatus, "ACTIVE");
    const deploymentId = (await apiGateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).deploymentId;
    assert.ok(deploymentId);
    const invokeBase = `http://127.0.0.1:${invokePort}/${outputs.ApiId}/${outputs.Stage}`;
    assert.deepEqual(await (await fetch(`${invokeBase}/health`)).json(), { ok: true, tableName: outputs.TableName, release: "v2", path: "/health" });

    const rollbackPause = arm("rollback mutation", observation => observation.operationKind === "UPDATE" && /^resource:.+:rollback-complete:\d+$/.test(observation.checkpoint));
    const invalid = runCdk(["--output", join(root, "invalid.out"), "deploy", "RestStack", "--require-approval", "never"], cdkEnvironment(endpoint, root, "api-invalid"));
    await checkpointBeforeCdkExit(rollbackPause, invalid, "rollback mutation", 180_000);
    await restart();
    const rejected = await invalid;
    assert.notEqual(rejected.code, 0, "the deliberately duplicate API method must fail after the interrupted rollback resumes");
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /already exists|duplicate|conflict/i);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0]?.StackStatus, "UPDATE_ROLLBACK_COMPLETE");
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }))).Configuration?.MemorySize, 256, "rollback recovery must restore the working Lambda configuration");
    assert.deepEqual(await (await fetch(`${invokeBase}/health`)).json(), { ok: true, tableName: outputs.TableName, release: "v2", path: "/health" });

    const deletePause = arm("delete mutation", observation => observation.operationKind === "DELETE" && observation.checkpoint.endsWith(":delete-complete"));
    const destroying = runCdk(["destroy", "RestStack", "--force"], env);
    await checkpointBeforeCdkExit(deletePause, destroying, "delete mutation", 180_000);
    await restart();
    const destroyed = await destroying;
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}`);
    const tombstone = Object.values(simulator!.store.regionState(region).cloudformation.stacks).find(value => value.stackName === "RestStack");
    assert.equal(tombstone?.stackStatus, "DELETE_COMPLETE");
    assert.equal(Object.keys(simulator!.store.regionState(region).functions).length, 0);
    assert.equal(Object.keys(simulator!.store.regionState(region).tables).length, 0);
    assert.equal(Object.keys(simulator!.store.regionState(region).apis).length, 0);
    assert.ok(simulator!.store.regionState(region).s3Buckets[bootstrap.bucketName], "application deletion must not remove the managed CDK asset bucket");
    assert.ok(observed.some(value => value.checkpoint === "accepted"));
    assert.ok(observed.some(value => value.checkpoint === "outputs-evaluated"));
    assert.ok(observed.some(value => value.checkpoint.includes(":rollback-complete:")));
    assert.ok(observed.some(value => value.checkpoint.endsWith(":delete-complete")));
  } finally {
    armed = undefined;
    clients.forEach(client => client.destroy());
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
