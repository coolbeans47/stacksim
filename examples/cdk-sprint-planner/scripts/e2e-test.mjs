import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { StackSim } from "../../../dist/src/server.js";
import { projectRoot } from "./config.mjs";

const root = await mkdtemp(join(tmpdir(), "stacksim-sprint-planner-e2e-"));
const dataDir = join(root, "data");
const configFile = join(root, "local.json");
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true });
let cognito;
let ownedPoolId;
let ownedClientId;

async function run(label, script, args = [], allowed = [0], overrides = {}) {
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: "eu-west-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_ENDPOINT_URL: `http://127.0.0.1:${simulator.port}`,
    AWS_EC2_METADATA_DISABLED: "true",
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: "eu-west-1",
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    SPRINT_PLANNER_CONFIG: configFile,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    ...overrides,
  };
  console.log(`[e2e] ${label}`);
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: projectRoot, env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
  if (!allowed.includes(code)) throw new Error(`${label} failed with exit code ${code}`);
  return code;
}

async function verifySender(email) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const messages = simulator.ses.mailbox.list({ recipient: email, status: "all", pageSize: 100 }).messages ?? [];
    for (const item of messages.reverse()) {
      const message = simulator.ses.mailbox.detail(item.messageId);
      const url = `${message?.textBody ?? ""} ${message?.htmlBody ?? ""}`.match(/https?:\/\/[^\s"'<>]+\/_stacksim\/ses\/verify-email\/[^\s"'<>]+/)?.[0]?.replace(/&amp;/g, "&");
      if (url) {
        const result = await fetch(url);
        if (!result.ok) throw new Error(`SES verification returned HTTP ${result.status}`);
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Application sender verification email is missing");
}

try {
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  cognito = new CognitoIdentityProviderClient({
    region: "eu-west-1",
    endpoint,
    credentials: { accessKeyId: "admin", secretAccessKey: "password" },
  });
  await writeFile(configFile, `${JSON.stringify({
    schemaVersion: 1,
    accountId: "000000000000",
    region: "eu-west-1",
    controlPlaneEndpoint: endpoint,
    invokeEndpoint: `http://127.0.0.1:${simulator.invokePort}`,
    bootstrapAdmin: { email: "admin@sprint-planner.test", displayName: "Alex Morgan" },
    email: { fromAddress: "planner@sprint-planner.test" },
  }, null, 2)}\n`, { mode: 0o600 });
  const deployScript = join(projectRoot, "scripts", "deploy.mjs");
  const first = await run("first resumable deployment", deployScript, [], [2]);
  if (first !== 2) throw new Error("First deployment should pause for SES verification");
  await verifySender("planner@sprint-planner.test");
  await run("resumed full deployment", deployScript);
  const deployment = JSON.parse(await readFile(join(projectRoot, ".runtime", "deployment.json"), "utf8"));
  ownedPoolId = deployment.cognito.userPoolId;
  ownedClientId = deployment.cognito.appClientId;
  await cognito.send(new DescribeUserPoolCommand({ UserPoolId: ownedPoolId }));
  await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: ownedPoolId, ClientId: ownedClientId }));
  await run("two-user collaboration", join(projectRoot, "scripts", "collaboration-test.mjs"), [], [0], {
    SPRINT_PLANNER_ADMIN_PASSWORD: "Local-Admin-2026!",
    SPRINT_PLANNER_MEMBER_PASSWORD: "Local-Member-2026!",
  });
  if (process.env.SPRINT_PLANNER_E2E_SKIP_CAPTURE !== "1") {
    await run("authenticated responsive capture", join(projectRoot, "scripts", "capture.mjs"), [], [0], {
      SPRINT_PLANNER_ADMIN_PASSWORD: "Local-Admin-2026!",
    });
  }
  const cdkCli = resolve(projectRoot, "node_modules", "aws-cdk", "bin", "cdk");
  await run("destroy owned stacks", cdkCli, ["destroy", "--all", "--force", "--no-notices", "--no-color"]);
  try {
    await cognito.send(new DescribeUserPoolCommand({ UserPoolId: ownedPoolId }));
    throw new Error("The stack-owned Cognito user pool survived stack destruction");
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
  }
  console.log(`[e2e] deploy, seed, smoke, collaboration${process.env.SPRINT_PLANNER_E2E_SKIP_CAPTURE === "1" ? "" : ", capture"}, destroy, and Cognito ownership passed`);
} finally {
  cognito?.destroy();
  await simulator.stop().catch(() => undefined);
  if (!root.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("Refusing to remove a non-temporary E2E directory");
  if (process.env.SPRINT_PLANNER_E2E_KEEP === "1") {
    console.error(`[e2e] retained diagnostic state: ${root}`);
  } else {
    await rm(root, { recursive: true, force: true });
  }
}
