import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  CreateCapacityProviderCommand,
  CreateFunctionCommand,
  GetCapacityProviderCommand,
  GetDurableExecutionHistoryCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionScalingConfigCommand,
} from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam10-capture-"));
const previousOciRoot = process.env.STACKSIM_LAMBDA_OCI_ROOT;
process.env.STACKSIM_LAMBDA_OCI_ROOT = join(root, "oci");
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda;

async function writeImage(imageUri) {
  const blobs = join(process.env.STACKSIM_LAMBDA_OCI_ROOT, "blobs", "sha256"); await mkdir(blobs, { recursive: true }); const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/lambda-entrypoint.sh"], Cmd: ["handler.echoHandler"], WorkingDir: "/var/task" } })); const configDigest = digest(config); await writeFile(join(blobs, configDigest.slice(7)), config);
  const mediaType = "application/vnd.oci.image.manifest.v1+json"; const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length }, layers: [] })); const manifestDigest = digest(manifest); await writeFile(join(blobs, manifestDigest.slice(7)), manifest);
  await writeFile(join(process.env.STACKSIM_LAMBDA_OCI_ROOT, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" })); await writeFile(join(process.env.STACKSIM_LAMBDA_OCI_ROOT, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType, digest: manifestDigest, size: manifest.length, annotations: { "org.opencontainers.image.ref.name": imageUri } }] }));
}

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const zip = await readFile(resolve("examples/lambda/function.zip")); const role = "arn:aws:iam::000000000000:role/test";
  const imageUri = "000000000000.dkr.ecr.eu-west-1.amazonaws.com/checkout/runtime:stable"; await writeImage(imageUri); await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-image", PackageType: "Image", Role: role, Code: { ImageUri: imageUri }, Description: "Digest-pinned local checkout image", ImageConfig: { EntryPoint: ["/lambda-entrypoint.sh"], Command: ["handler.echoHandler"], WorkingDirectory: "/var/task" } }));
  const provider = await lambda.send(new CreateCapacityProviderCommand({ CapacityProviderName: "checkout-managed", VpcConfig: { SubnetIds: ["subnet-0123abcd", "subnet-4567efab"], SecurityGroupIds: ["sg-0123abcd"] }, PermissionsConfig: { CapacityProviderOperatorRoleArn: role }, InstanceRequirements: { Architectures: ["x86_64"], AllowedInstanceTypes: ["m7i.large", "m7i.xlarge"] }, CapacityProviderScalingConfig: { ScalingMode: "Auto", MaxVCpuCount: 80, ScalingPolicies: [{ PredefinedMetricType: "LambdaCapacityProviderAverageCPUUtilization", TargetValue: 60 }] }, PropagateTags: { Mode: "Explicit", ExplicitTags: { workload: "checkout" } }, TelemetryConfig: { LoggingConfig: { SystemLogLevel: "INFO", LogGroup: "/aws/lambda/capacity-provider/checkout-managed" } }, Tags: { owner: "platform", environment: "production" } }));
  for (let attempt = 0; attempt < 100; attempt++) { if ((await lambda.send(new GetCapacityProviderCommand({ CapacityProviderName: "checkout-managed" }))).CapacityProvider?.State === "Active") break; await new Promise(resolveWait => setTimeout(resolveWait, 5)); }
  await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-managed-handler", Runtime: "nodejs22.x", Role: role, Handler: "handler.echoHandler", Description: "Managed-instance checkout control plane", Code: { ZipFile: zip }, CapacityProviderConfig: { LambdaManagedInstancesCapacityProviderConfig: { CapacityProviderArn: provider.CapacityProvider.CapacityProviderArn, ExecutionEnvironmentMemoryGiBPerVCpu: 6, PerExecutionEnvironmentMaxConcurrency: 120 } }, PublishTo: "LATEST_PUBLISHED" })); await lambda.send(new PutFunctionScalingConfigCommand({ FunctionName: "checkout-managed-handler", Qualifier: "$LATEST.PUBLISHED", FunctionScalingConfig: { MinExecutionEnvironments: 2, MaxExecutionEnvironments: 12 } }));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-durable", Runtime: "nodejs22.x", Role: role, Handler: "handler.durableCallbackHandler", Description: "Approval workflow with persisted callbacks and replay", Code: { ZipFile: zip }, DurableConfig: { ExecutionTimeout: 86_400, RetentionPeriodInDays: 14, KMSKeyArn: "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab" } })); await new Promise(resolveWait => setTimeout(resolveWait, 20));
  const started = await lambda.send(new InvokeCommand({ FunctionName: "checkout-durable", Qualifier: "$LATEST", InvocationType: "Event", DurableExecutionName: "approval-order-1042", Payload: Buffer.from('{"timeoutSeconds":3600,"heartbeatSeconds":120,"orderId":"1042"}') })); const executionArn = started.DurableExecutionArn;
  for (let attempt = 0; attempt < 100; attempt++) { const history = await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: executionArn })); if (history.Events?.some(event => event.EventType === "CallbackStarted")) break; await new Promise(resolveWait => setTimeout(resolveWait, 10)); }

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, hash, ready, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-16/lambda/lam10", state, "final"); await mkdir(output, { recursive: true });
    for (const [filename, width, height] of viewports) { const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`${endpoint}/_stacksim/console${hash}`); await page.locator(ready).waitFor(); if (prepare) await prepare(page); await page.waitForTimeout(200); await page.screenshot({ path: join(output, filename), type: "jpeg", quality: 88, fullPage: true }); await context.close(); }
  };

  await capture("image-overview", "#/lambda/functions/checkout-image", ".image-code-card");
  await capture("image-configuration", "#/lambda/functions/checkout-image/configuration", ".image-config-card");
  await capture("provider-detail", "#/lambda/capacity-providers/checkout-managed", ".capacity-provider-overview-card");
  await capture("provider-attachment", "#/lambda/functions/checkout-managed-handler/configuration", ".function-capacity-provider-card");
  await capture("durable-list", "#/lambda/functions/checkout-durable/durable-executions", ".durable-executions-card");
  const detailHash = `#/lambda/functions/checkout-durable/durable-executions/${encodeURIComponent(executionArn)}`;
  await capture("durable-detail", detailHash, ".durable-history-card");
  await capture("durable-stop", detailHash, ".durable-history-card", async page => { await page.getByRole("button", { name: "Stop execution" }).click(); await page.getByRole("dialog").waitFor(); });
} finally {
  lambda?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); if (previousOciRoot === undefined) delete process.env.STACKSIM_LAMBDA_OCI_ROOT; else process.env.STACKSIM_LAMBDA_OCI_ROOT = previousOciRoot; await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
