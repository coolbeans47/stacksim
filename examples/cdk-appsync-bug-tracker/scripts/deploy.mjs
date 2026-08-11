import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  account, awsEnvironment, endpoint, outputsFile, projectRoot, region,
  runtimeRoot, sdkConfig,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const cdkCli = require.resolve("aws-cdk/bin/cdk");

async function run(label, command, args, env = awsEnvironment()) {
  console.log(`\n[bug-tracker] ${label}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolvePromise() : reject(new Error(`${label} failed with exit code ${code}`)));
  });
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this workflow with npm run deploy.");
const npm = (label, args) => run(label, process.execPath, [npmCli, ...args]);
const cdk = (label, args) => run(label, process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"]);

async function main() {
  await mkdir(runtimeRoot, { recursive: true });
  let health;
  try { health = await fetch(`${endpoint}/_stacksim/health`).then(response => response.json()); }
  catch (error) { throw new Error(`StackSim is not reachable at ${endpoint}: ${error.message}`); }
  if (health.status !== "ok" || !health.services?.includes("appsync") || !health.services?.includes("cloudformation")) throw new Error(`${endpoint} is not a healthy AppSync/CloudFormation StackSim endpoint.`);

  await npm("build React frontend", ["run", "build:frontend"]);
  await cdk("synthesize unmodified CDK application", ["synth"]);
  await run("verify synthesized assembly", process.execPath, ["scripts/verify-assembly.mjs"]);
  await cdk("deploy AppSync bug tracker stack", [
    "deploy", "AppSyncBugTrackerStack", "--exclusively", "--require-approval", "never",
    "--outputs-file", outputsFile,
  ]);

  const outputs = JSON.parse(await readFile(outputsFile, "utf8")).AppSyncBugTrackerStack;
  const required = key => {
    const value = outputs?.[key];
    if (typeof value !== "string" || !value) throw new Error(`CloudFormation output ${key} is missing.`);
    return value;
  };
  const manifest = {
    schemaVersion: 1,
    deployedAt: new Date().toISOString(),
    account,
    region,
    controlPlaneEndpoint: endpoint,
    apiId: required("ApiId"),
    apiKey: required("ApiKey"),
    graphqlEndpoint: required("GraphQLEndpoint"),
    websiteUrl: required("WebsiteUrl"),
    websiteBucketName: required("WebsiteBucketName"),
    usersTableName: required("UsersTableName"),
    ticketsTableName: required("TicketsTableName"),
    dataRoleArn: required("DataRoleArn"),
    stackName: "AppSyncBugTrackerStack",
  };
  await writeFile(`${runtimeRoot}/deployment.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const browserConfig = {
    configured: true,
    localDemo: true,
    graphqlEndpoint: manifest.graphqlEndpoint,
    apiId: manifest.apiId,
    apiKey: manifest.apiKey,
    region,
    warning: "This API key is intentionally exposed to this local demonstration and is held only in page memory.",
  };
  const s3 = new S3Client({ ...sdkConfig(), forcePathStyle: true });
  await s3.send(new PutObjectCommand({
    Bucket: manifest.websiteBucketName,
    Key: "config.json",
    Body: `${JSON.stringify(browserConfig, null, 2)}\n`,
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
  console.log(`[bug-tracker] runtime manifest: ${runtimeRoot}/deployment.json`);
  console.log("[bug-tracker] uploaded no-store frontend config.json after deployment");

  await run("seed users and bugs through GraphQL", process.execPath, ["scripts/seed.mjs"]);
  await run("run deployed smoke checks", process.execPath, ["scripts/smoke.mjs"]);
  console.log(`\n[bug-tracker] ready: ${manifest.websiteUrl}`);
}

main().catch(error => {
  console.error(`\n[bug-tracker] deployment failed: ${error.stack || error.message}`);
  console.error("[bug-tracker] Successfully created resources are left in place for inspection.");
  process.exitCode = 1;
});
