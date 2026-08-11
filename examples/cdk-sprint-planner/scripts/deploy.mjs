import { spawn } from "node:child_process";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  GetIdentityVerificationAttributesCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadConfig, projectRoot, publicRuntime } from "./config.mjs";

const config = await loadConfig();
const runtimeRoot = join(projectRoot, ".runtime");
const foundationOutputsFile = join(runtimeRoot, "foundation-outputs.json");
const appOutputsFile = join(runtimeRoot, "app-outputs.json");
const webOutputsFile = join(runtimeRoot, "web-outputs.json");
const deploymentFile = join(runtimeRoot, "deployment.json");
const frontendRuntimeFile = join(runtimeRoot, "frontend-runtime.json");
const require = createRequire(import.meta.url);
const cdkCli = require.resolve("aws-cdk/bin/cdk");
await mkdir(runtimeRoot, { recursive: true });

function environment(overrides = {}) {
  const value = { ...process.env };
  for (const key of Object.keys(value)) {
    if (key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete value[key];
  }
  const noProxy = ["127.0.0.1", "localhost", "::1", value.NO_PROXY, value.no_proxy].filter(Boolean).join(",");
  return {
    ...value,
    AWS_ACCESS_KEY_ID: value.AWS_ACCESS_KEY_ID || "admin",
    AWS_SECRET_ACCESS_KEY: value.AWS_SECRET_ACCESS_KEY || "password",
    AWS_REGION: config.region,
    AWS_DEFAULT_REGION: config.region,
    AWS_ENDPOINT_URL: config.controlPlaneEndpoint,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    CDK_DEFAULT_ACCOUNT: config.accountId,
    CDK_DEFAULT_REGION: config.region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    SPRINT_PLANNER_CONFIG: config.configPath,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...overrides,
  };
}

async function run(label, args, env = environment()) {
  console.log(`\n[sprint-planner] ${label}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolvePromise() : reject(new Error(`${label} failed with exit code ${code}`)));
  });
}

const cdk = (label, args) => run(label, [cdkCli, ...args, "--no-notices", "--no-color"]);
const sdkConfig = {
  region: config.region,
  endpoint: config.controlPlaneEndpoint,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "password" },
};

async function simulatorPreflight() {
  const response = await fetch(`${config.controlPlaneEndpoint}/_stacksim/api/console-config`);
  if (!response.ok) throw new Error(`stacksim console configuration returned HTTP ${response.status}`);
  const value = await response.json();
  if (value.region !== config.region) throw new Error("stacksim Region does not match local configuration");
  if (value.authMode !== "enforce") throw new Error("Sprint Planner requires the default enforce mode; remove any STACKSIM_AUTH_MODE override");
  const sts = new STSClient(sdkConfig);
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (identity.Account !== config.accountId) throw new Error("stacksim account does not match local configuration");
  } finally {
    sts.destroy();
  }
}

async function stackExists(name) {
  const client = new CloudFormationClient(sdkConfig);
  try {
    const result = await client.send(new DescribeStacksCommand({ StackName: name }));
    return Boolean(result.Stacks?.some(stack => !stack.StackStatus?.endsWith("DELETE_COMPLETE")));
  } catch (error) {
    if (error.name === "ValidationError") return false;
    throw error;
  } finally { client.destroy(); }
}

async function stackOutputs(name) {
  const client = new CloudFormationClient(sdkConfig);
  try {
    const result = await client.send(new DescribeStacksCommand({ StackName: name }));
    const stack = result.Stacks?.[0];
    if (!stack) throw new Error(`Stack ${name} is unavailable`);
    return Object.fromEntries((stack.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));
  } finally { client.destroy(); }
}

function output(outputs, stack, key) {
  const value = outputs?.[stack]?.[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing stack output ${stack}.${key}`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  await simulatorPreflight();
  const firstRun = !(await stackExists("SprintPlannerWebStack"));
  const placeholder = publicRuntime(config);
  await run("build placeholder frontend", [join(projectRoot, "frontend", "build.mjs")], environment({ SPRINT_PLANNER_RUNTIME: JSON.stringify(placeholder) }));
  await run("build Lambda bundles", [join(projectRoot, "scripts", "build-lambdas.mjs")]);
  await cdk("synthesize all stacks", ["synth"]);
  await run("verify CloudFormation assembly", [join(projectRoot, "scripts", "verify-assembly.mjs")]);
  if (firstRun) {
    await cdk("deploy data and placeholder website", [
      "deploy", "SprintPlannerDataStack", "SprintPlannerWebStack", "--exclusively",
      "--require-approval", "never", "--outputs-file", foundationOutputsFile,
    ]);
  }
  await cdk("deploy data and application stacks", [
    "deploy", "SprintPlannerDataStack", "SprintPlannerAppStack", "--exclusively",
    "--require-approval", "never", "--outputs-file", appOutputsFile,
  ]);
  const appOutputs = await readJson(appOutputsFile);
  const outputs = {
    ...appOutputs,
    SprintPlannerWebStack: await stackOutputs("SprintPlannerWebStack"),
  };
  const websiteUrl = output(outputs, "SprintPlannerWebStack", "WebsiteUrl");
  const apiBaseUrl = output(outputs, "SprintPlannerAppStack", "ApiBaseUrl");
  const websocketUrl = output(outputs, "SprintPlannerAppStack", "WebSocketUrl");
  const userPoolId = output(outputs, "SprintPlannerAppStack", "CognitoUserPoolId");
  const appClientId = output(outputs, "SprintPlannerAppStack", "CognitoAppClientId");
  const issuer = output(outputs, "SprintPlannerAppStack", "CognitoIssuer");
  if (new URL(websiteUrl).origin !== new URL(config.controlPlaneEndpoint).origin) throw new Error("Website and configured CORS/Cognito origins do not match");
  const deployment = {
    schemaVersion: 1,
    deployedAt: new Date().toISOString(),
    accountId: config.accountId,
    region: config.region,
    controlPlaneEndpoint: config.controlPlaneEndpoint,
    invokeEndpoint: config.invokeEndpoint,
    websiteUrl,
    websiteBucketName: output(outputs, "SprintPlannerWebStack", "WebsiteBucketName"),
    apiBaseUrl,
    httpApiId: output(outputs, "SprintPlannerAppStack", "HttpApiId"),
    websocketUrl,
    websocketApiId: output(outputs, "SprintPlannerAppStack", "WebSocketApiId"),
    websocketStage: "live",
    applicationTableName: output(outputs, "SprintPlannerDataStack", "ApplicationTableName"),
    connectionTableName: output(outputs, "SprintPlannerDataStack", "ConnectionTableName"),
    publisherFunctionName: output(outputs, "SprintPlannerAppStack", "PublisherFunctionName"),
    domainEventBusName: output(outputs, "SprintPlannerAppStack", "DomainEventBusName"),
    notificationQueueUrl: output(outputs, "SprintPlannerAppStack", "NotificationQueueUrl"),
    notificationDeadLetterQueueUrl: output(outputs, "SprintPlannerAppStack", "NotificationDeadLetterQueueUrl"),
    streamFailureQueueUrl: output(outputs, "SprintPlannerAppStack", "StreamFailureQueueUrl"),
    eventConsumerFailureQueueUrl: output(outputs, "SprintPlannerAppStack", "EventConsumerFailureQueueUrl"),
    dashboardName: output(outputs, "SprintPlannerAppStack", "DashboardName"),
    cognito: {
      userPoolId,
      appClientId,
      issuer,
    },
    stacks: outputs,
  };
  await writeFile(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`);
  const ses = new SESClient(sdkConfig);
  const verification = await ses.send(new GetIdentityVerificationAttributesCommand({ Identities: [config.email.fromAddress] }));
  ses.destroy();
  if (verification.VerificationAttributes?.[config.email.fromAddress]?.VerificationStatus !== "Success") {
    console.error("\n[sprint-planner] SES_IDENTITY_PENDING");
    console.error(`[sprint-planner] Verify the application sender in the local SES Inbox, then rerun npm run deploy.`);
    console.error(`[sprint-planner] Inbox: ${config.controlPlaneEndpoint}/_stacksim/console/#/ses/inbox`);
    process.exitCode = 2;
    return;
  }
  await run("seed deterministic workspace", [join(projectRoot, "scripts", "seed.mjs")]);
  const frontendRuntime = publicRuntime(config, {
    websiteUrl,
    apiBaseUrl,
    websocketUrl,
    userPoolId,
    appClientId,
    issuer,
  });
  await writeFile(frontendRuntimeFile, `${JSON.stringify(frontendRuntime, null, 2)}\n`);
  await run("build final frontend", [join(projectRoot, "frontend", "build.mjs")], environment({ SPRINT_PLANNER_RUNTIME: JSON.stringify(frontendRuntime) }));
  await cdk("publish final frontend", [
    "deploy", "SprintPlannerWebStack", "--exclusively",
    "--require-approval", "never", "--outputs-file", webOutputsFile,
  ]);
  await run("run credential-free smoke test", [join(projectRoot, "scripts", "smoke-test.mjs")]);
  console.log(`\n[sprint-planner] ready: ${websiteUrl}`);
  console.log("[sprint-planner] The Cognito user pool and app client are owned by SprintPlannerAppStack.");
}

main().catch(error => {
  console.error(`\n[sprint-planner] deployment failed: ${error.stack || error.message}`);
  console.error("[sprint-planner] Created stacks were left in place for inspection and a safe rerun.");
  process.exitCode = 1;
});
