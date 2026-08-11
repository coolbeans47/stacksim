import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  CreateCodeSigningConfigCommand,
  CreateFunctionCommand,
  LambdaClient,
  PutFunctionRecursionConfigCommand,
  PutRuntimeManagementConfigCommand,
} from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam09-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda;

try {
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const zip = await readFile(resolve("examples/lambda/function.zip"));
  const signingProfile = "arn:aws:signer:eu-west-1:000000000000:/signing-profiles/platform_release/abc123";
  const signing = await lambda.send(new CreateCodeSigningConfigCommand({
    AllowedPublishers: { SigningProfileVersionArns: [signingProfile] },
    CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Warn" },
    Description: "Platform release publishers",
    Tags: { owner: "platform", environment: "production" },
  }));
  const signingArn = signing.CodeSigningConfig.CodeSigningConfigArn;
  await lambda.send(new CreateFunctionCommand({
    FunctionName: "checkout-configured",
    Runtime: "nodejs22.x",
    Role: "arn:aws:iam::000000000000:role/test",
    Handler: "handler.echoHandler",
    Description: "Checkout API with explicit runtime, observability, and infrastructure references",
    Code: { ZipFile: zip },
    CodeSigningConfigArn: signingArn,
    Architectures: ["arm64"],
    EphemeralStorage: { Size: 2048 },
    Environment: { Variables: { APP_ENV: "production", LOG_CONTEXT: "checkout" } },
    LoggingConfig: { LogFormat: "JSON", ApplicationLogLevel: "ERROR", SystemLogLevel: "WARN", LogGroup: "/stacksim/lambda/checkout-configured" },
    TracingConfig: { Mode: "Active" },
    DeadLetterConfig: { TargetArn: "arn:aws:sqs:eu-west-1:000000000000:checkout-dead-letter" },
    FileSystemConfigs: [{ Arn: "arn:aws:elasticfilesystem:eu-west-1:000000000000:access-point/fsap-0123456789abcdef0", LocalMountPath: "/mnt/checkout" }],
    VpcConfig: { SubnetIds: ["subnet-0123abcd", "subnet-4567efab"], SecurityGroupIds: ["sg-0123abcd"], Ipv6AllowedForDualStack: true },
    KMSKeyArn: "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab",
    Tags: { service: "checkout", owner: "platform" },
  }));
  await lambda.send(new PutRuntimeManagementConfigCommand({ FunctionName: "checkout-configured", Qualifier: "$LATEST", UpdateRuntimeOn: "Manual", RuntimeVersionArn: "arn:aws:lambda:eu-west-1::runtime:nodejs22-platform-2026-07" }));
  await lambda.send(new PutFunctionRecursionConfigCommand({ FunctionName: "checkout-configured", RecursiveLoop: "Allow" }));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-16/lambda/advanced-configuration", state, "final");
    await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(`${endpoint}/_stacksim/console#/lambda/functions/checkout-configured/configuration`);
      await page.locator(".runtime-settings-card").waitFor();
      if (prepare) await prepare(page);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true });
      await context.close();
    }
  };

  await capture("configuration");
  await capture("runtime", async page => { await page.locator(".runtime-settings-card").getByRole("button", { name: "Edit" }).click(); await page.getByRole("dialog").waitFor(); });
  await capture("code-signing", async page => { await page.locator(".code-signing-card").getByRole("button", { name: "Manage association" }).click(); await page.getByRole("dialog").waitFor(); });
} finally {
  lambda?.destroy();
  await browser?.close();
  await simulator.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
