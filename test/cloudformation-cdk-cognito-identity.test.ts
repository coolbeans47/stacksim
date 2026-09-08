import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityClient,
  DescribeIdentityPoolCommand,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
  GetIdentityPoolRolesCommand,
} from "@aws-sdk/client-cognito-identity";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";
import { cdkCli, cdkCommandTimeoutMs } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cognito-identity-api-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const accountId = "000000000000";
const region = "eu-west-1";
const admin = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function environment(endpoint: string, tempRoot: string): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (
      key === "AWS_ENDPOINT_URL"
      || key.startsWith("AWS_ENDPOINT_URL_")
      || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)
    ) {
      delete inherited[key];
    }
  }
  return {
    ...inherited,
    AWS_ACCESS_KEY_ID: admin.accessKeyId,
    AWS_SECRET_ACCESS_KEY: admin.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: accountId,
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), cdkCommandTimeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function succeeded(result: ProcessResult, label: string): void {
  assert.equal(
    result.code,
    0,
    `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`,
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /STACKSIM_NETWORK_TRIPWIRE|STACKSIM_CLOUDFORMATION_NETWORK_BLOCKED/,
    `${label} attempted an unapproved network connection`,
  );
}

async function synthesizedTemplate(output: string): Promise<Record<string, any>> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      if ((await stat(path)).isDirectory()) await visit(path);
      else if (entry.endsWith(".template.json")) files.push(path);
    }
  };
  await visit(output);
  const templateFile = files.find(path => path.endsWith("CognitoIdentityApiStack.template.json")) ?? files[0];
  assert.ok(templateFile, `CDK synth did not write a template in ${output}`);
  return JSON.parse(await readFile(templateFile, "utf8"));
}

test("CID-01 pinned CDK Identity L1 fixture synthesizes without PrincipalTag/RoleMappings and deploys the enhanced hop", { timeout: 600_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "stacksim-cdk-cognito-identity-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: join(tempRoot, "data"),
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const env = environment(endpoint, tempRoot);
    const synth = await runCdk(["--output", join(tempRoot, "synth.out"), "synth", "--quiet"], env, fixture);
    succeeded(synth, "cdk synth");
    const template = await synthesizedTemplate(join(tempRoot, "synth.out"));
    const resources = Object.values(template.Resources ?? {}) as Array<{ Type: string; Properties?: Record<string, unknown> }>;
    const types = resources.map(resource => resource.Type).sort();
    assert.ok(types.includes("AWS::Cognito::IdentityPool"));
    assert.ok(types.includes("AWS::Cognito::IdentityPoolRoleAttachment"));
    assert.ok(!types.includes("AWS::Cognito::IdentityPoolPrincipalTag"));
    const attachment = resources.find(resource => resource.Type === "AWS::Cognito::IdentityPoolRoleAttachment");
    assert.ok(attachment);
    assert.equal(attachment.Properties?.RoleMappings, undefined);
    const pool = resources.find(resource => resource.Type === "AWS::Cognito::IdentityPool");
    assert.ok(pool?.Properties?.AllowClassicFlow === undefined || pool?.Properties?.AllowClassicFlow === false);
    assert.equal(pool?.Properties?.DeveloperProviderName, undefined);
    assert.equal(pool?.Properties?.SupportedLoginProviders, undefined);

    const deploy = await runCdk(
      ["--output", join(tempRoot, "deploy.out"), "deploy", "CognitoIdentityApiStack", "--require-approval", "never"],
      env,
      fixture,
    );
    succeeded(deploy, "cdk deploy");

    const cloudformation = new CloudFormationClient({ endpoint, region, credentials: admin, maxAttempts: 1 });
    const identity = new CognitoIdentityClient({ endpoint, region, credentials: admin, maxAttempts: 1 });
    const idp = new CognitoIdentityProviderClient({ endpoint, region, credentials: admin, maxAttempts: 1 });
    clients.push(cloudformation, identity, idp);
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "CognitoIdentityApiStack" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    const outputs = Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
    const poolId = outputs.IdentityPoolId!;
    const userPoolId = outputs.UserPoolId!;
    const clientId = outputs.UserPoolClientId!;
    const apiId = outputs.ApiId!;
    assert.match(poolId, /^eu-west-1:[0-9a-f-]+$/);

    const described = await identity.send(new DescribeIdentityPoolCommand({ IdentityPoolId: poolId }));
    assert.equal(described.IdentityPoolName, "cid01_identities");
    assert.equal(described.AllowUnauthenticatedIdentities, false);
    const roles = await identity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: poolId }));
    assert.ok(roles.Roles?.authenticated);
    assert.equal(roles.RoleMappings, undefined);

    const email = "cid01@example.test";
    await idp.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    }));
    await idp.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));
    const auth = await idp.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    const idToken = auth.AuthenticationResult!.IdToken!;
    const loginKey = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    const getId = await identity.send(new GetIdCommand({
      IdentityPoolId: poolId,
      AccountId: accountId,
      Logins: { [loginKey]: idToken },
    }));
    const credentials = await identity.send(new GetCredentialsForIdentityCommand({
      IdentityId: getId.IdentityId,
      Logins: { [loginKey]: idToken },
    }));
    assert.equal(credentials.IdentityId, getId.IdentityId);
    assert.ok(credentials.Credentials?.SecretKey);
    assert.equal((credentials.Credentials as { SecretAccessKey?: string }).SecretAccessKey, undefined);

    const invokeUrl = `http://127.0.0.1:${simulator.invokePort}/${apiId}/prod/`;
    const response = await signedFetch(invokeUrl, {
      method: "GET",
      service: "execute-api",
      region,
      credentials: {
        accessKeyId: credentials.Credentials!.AccessKeyId!,
        secretAccessKey: credentials.Credentials!.SecretKey!,
        sessionToken: credentials.Credentials!.SessionToken,
      },
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal((JSON.parse(body) as { ok?: boolean }).ok, true);
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
