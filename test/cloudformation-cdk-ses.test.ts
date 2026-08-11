import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  DescribeConfigurationSetCommand,
  GetIdentityVerificationAttributesCommand,
  GetTemplateCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import {
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  GetEmailTemplateCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "ses-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const accountId = "000000000000";
const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identityName = "sender@ses03.example.test";
const configurationSetName = "ses03-configuration-set";
const templateName = "ses03-welcome";

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface InboxSummary {
  readonly messageId: string;
  readonly operation: string;
}

interface InboxDetail {
  readonly subject?: string;
  readonly textBody?: string;
  readonly templateName?: string;
  readonly configurationSetName?: string;
}

function environment(
  endpoint: string,
  tempRoot: string,
  release: "v1" | "v2",
  credentials = adminCredentials as { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): NodeJS.ProcessEnv {
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
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}),
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
    CDK_SES_TEST_RELEASE: release,
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function run(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 300_000);
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

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return run(
    process.execPath,
    [cdkCli, ...args, "--no-notices", "--no-color"],
    { cwd: fixture, env, timeoutMs: 360_000 },
  );
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

async function jsonResponse<T>(url: string): Promise<T> {
  const response = await signedFetch(url, { service: "ses", region, credentials: adminCredentials, headers: { "x-stacksim-region": region } });
  if (response.status !== 200) assert.fail(`GET ${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function consumeVerification(endpoint: string): Promise<string> {
  const inbox = await jsonResponse<{ messages: InboxSummary[] }>(
    `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identityName)}`,
  );
  const verification = inbox.messages.find(message => message.operation === "VerifyEmailIdentity");
  assert(verification, "CloudFormation identity creation did not capture a verification message");
  const detail = await jsonResponse<{ message: InboxDetail }>(
    `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(verification.messageId)}`,
  );
  const link = detail.message.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
  assert(link, "the captured verification message did not contain its simulator callback");
  const callback = await fetch(link, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const resultLocation = callback.headers.get("location");
  assert(resultLocation);
  assert.equal((await fetch(new URL(resultLocation, endpoint))).status, 200);
  return verification.messageId;
}

async function sendAsFixtureRole(
  endpoint: string,
  tempRoot: string,
  release: "v1" | "v2",
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<{ messageId: string; denied: string }> {
  const script = `
    import assert from "node:assert/strict";
    import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
    const client = new SESv2Client({ region: process.env.AWS_REGION, maxAttempts: 1 });
    try {
      const sent = await client.send(new SendEmailCommand({
        FromEmailAddress: ${JSON.stringify(identityName)},
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Content: { Template: {
          TemplateName: ${JSON.stringify(templateName)},
          TemplateData: JSON.stringify({ name: ${JSON.stringify(release === "v1" ? "Ada" : "Grace")} }),
        } },
      }));
      assert.ok(sent.MessageId);
      let denied;
      try {
        await client.send(new SendEmailCommand({
          FromEmailAddress: "not-granted@ses03.example.test",
          Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
          Content: { Simple: {
            Subject: { Data: "must be denied" },
            Body: { Text: { Data: "must not be captured" } },
          } },
        }));
      } catch (error) {
        denied = error?.name;
      }
      assert.equal(denied, "AccessDeniedException");
      process.stdout.write(JSON.stringify({ messageId: sent.MessageId, denied }));
    } finally {
      client.destroy();
    }
  `;
  const result = await run(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: sourceRoot,
      env: environment(endpoint, tempRoot, release, credentials),
      timeoutMs: 60_000,
    },
  );
  succeeded(result, `role-scoped SES v2 ${release} send`);
  return JSON.parse(result.stdout) as { messageId: string; denied: string };
}

test("the pinned SES CDK stack deploys direct and by change set, enforces grantSendEmail, and preserves captured mail", { timeout: 900_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "stacksim-cdk-ses-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: join(tempRoot, "data"),
    region,
    authMode: "enforce",
    cdkBootstrap: true,
    sesMaxSendRate: 100,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials: adminCredentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const classic = new SESClient(options);
    const v2 = new SESv2Client(options);
    clients.push(cloudformation, classic, v2);

    const direct = await runCdk(
      ["--output", join(tempRoot, "direct.out"), "deploy", "SesStack", "--method", "direct", "--require-approval", "never"],
      environment(endpoint, tempRoot, "v1"),
    );
    succeeded(direct, "direct CDK create");

    let stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "SesStack" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    const stackId = stack!.StackId!;
    assert.deepEqual(
      Object.fromEntries((stack!.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue])),
      {
        ConfigurationSetName: configurationSetName,
        IdentityName: identityName,
        TemplateName: templateName,
      },
    );

    const identity = await v2.send(new GetEmailIdentityCommand({ EmailIdentity: identityName }));
    assert.equal(identity.ConfigurationSetName, configurationSetName);
    assert.equal(identity.VerifiedForSendingStatus, false);
    assert.equal(
      (await classic.send(new GetIdentityVerificationAttributesCommand({ Identities: [identityName] })))
        .VerificationAttributes?.[identityName]?.VerificationStatus,
      "Pending",
    );
    assert.equal(
      (await classic.send(new DescribeConfigurationSetCommand({ ConfigurationSetName: configurationSetName })))
        .ConfigurationSet?.Name,
      configurationSetName,
    );
    assert.equal(
      (await v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: configurationSetName })))
        .SendingOptions?.SendingEnabled,
      true,
    );
    assert.equal(
      (await classic.send(new GetTemplateCommand({ TemplateName: templateName }))).Template?.SubjectPart,
      "Welcome, {{name}}",
    );
    assert.equal(
      (await v2.send(new GetEmailTemplateCommand({ TemplateName: templateName }))).TemplateContent?.Text,
      "Hello {{name}}.",
    );

    const verificationMessageId = await consumeVerification(endpoint);
    assert.equal(
      (await v2.send(new GetEmailIdentityCommand({ EmailIdentity: identityName }))).VerifiedForSendingStatus,
      true,
    );

    const resources = (await cloudformation.send(new DescribeStackResourcesCommand({ StackName: stackId }))).StackResources ?? [];
    const roleName = resources.find(resource => resource.ResourceType === "AWS::IAM::Role")?.PhysicalResourceId;
    assert(roleName, "the CDK grant fixture did not deploy its sender role");
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    const rolePrincipal = await simulator.sts.assumeServiceRole(roleArn, "ses03-lambda", "lambda.amazonaws.com");
    const roleSession = simulator.store.ensureAccount().iam.sessions[rolePrincipal.accessKeyId!];
    assert(roleSession, "the Lambda-equivalent fixture role session was not persisted");
    const roleMaterial = simulator.store.credentialStore!.get(roleSession.credentialId!, {
      type: "sts-session",
      accountId,
      ownerId: roleSession.principalId,
      accessKeyId: roleSession.accessKeyId,
    });
    assert(roleMaterial?.sessionToken, "the Lambda-equivalent fixture role credential was not stored in the private vault");
    const roleCredentials = {
      accessKeyId: roleSession.accessKeyId,
      secretAccessKey: roleMaterial.secretAccessKey,
      sessionToken: roleMaterial.sessionToken,
    };

    let messageCount = simulator.ses.summary().messageCount;
    const sentV1 = await sendAsFixtureRole(endpoint, tempRoot, "v1", roleCredentials);
    assert.equal(simulator.ses.summary().messageCount, messageCount + 1, "the denied send must not add an Inbox row");
    let sentDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(sentV1.messageId)}`,
    );
    assert.equal(sentDetail.message.subject, "Welcome, Ada");
    assert.equal(sentDetail.message.templateName, templateName);
    assert.equal(sentDetail.message.configurationSetName, configurationSetName);

    const changeSetsBefore = new Set(
      Object.keys(simulator.store.regionState(region).cloudformation.changeSets),
    );
    const updated = await runCdk(
      ["--output", join(tempRoot, "change-set.out"), "deploy", "SesStack", "--require-approval", "never"],
      environment(endpoint, tempRoot, "v2"),
    );
    succeeded(updated, "default change-set CDK update");
    const executedUpdate = Object.entries(simulator.store.regionState(region).cloudformation.changeSets)
      .filter(([id]) => !changeSetsBefore.has(id))
      .map(([, changeSet]) => changeSet)
      .find(changeSet => changeSet.stackId === stackId && changeSet.changeSetType === "UPDATE");
    assert.equal(executedUpdate?.executionStatus, "EXECUTE_COMPLETE", "the default CDK update did not execute a change set");

    stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "UPDATE_COMPLETE");
    assert.equal(
      (await classic.send(new GetTemplateCommand({ TemplateName: templateName }))).Template?.SubjectPart,
      "Welcome back, {{name}}",
    );
    assert.equal(
      (await v2.send(new GetEmailTemplateCommand({ TemplateName: templateName }))).TemplateContent?.Text,
      "Hello {{name}} from the updated stack.",
    );

    messageCount = simulator.ses.summary().messageCount;
    const sentV2 = await sendAsFixtureRole(endpoint, tempRoot, "v2", roleCredentials);
    assert.equal(simulator.ses.summary().messageCount, messageCount + 1, "the second denied send must not add an Inbox row");
    sentDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(sentV2.messageId)}`,
    );
    assert.equal(sentDetail.message.subject, "Welcome back, Grace");

    const revisionBeforeNoOp = simulator.store.regionState(region).ses.controlRevision;
    const repeated = await runCdk(
      ["--output", join(tempRoot, "no-op.out"), "deploy", "SesStack", "--require-approval", "never"],
      environment(endpoint, tempRoot, "v2"),
    );
    succeeded(repeated, "default CDK no-op");
    assert.equal(
      simulator.store.regionState(region).ses.controlRevision,
      revisionBeforeNoOp,
      "a no-op CDK deployment must not mutate the authoritative SES catalog",
    );

    const messagesBeforeDestroy = simulator.ses.summary().messageCount;
    const destroyed = await runCdk(
      ["destroy", "SesStack", "--force"],
      environment(endpoint, tempRoot, "v2"),
    );
    succeeded(destroyed, "CDK destroy");
    stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "DELETE_COMPLETE");
    await assert.rejects(
      v2.send(new GetEmailIdentityCommand({ EmailIdentity: identityName })),
      (error: any) => error.name === "NotFoundException",
    );
    await assert.rejects(
      v2.send(new GetConfigurationSetCommand({ ConfigurationSetName: configurationSetName })),
      (error: any) => error.name === "NotFoundException",
    );
    await assert.rejects(
      v2.send(new GetEmailTemplateCommand({ TemplateName: templateName })),
      (error: any) => error.name === "NotFoundException",
    );
    assert.equal(simulator.ses.summary().messageCount, messagesBeforeDestroy);
    for (const messageId of [verificationMessageId, sentV1.messageId, sentV2.messageId]) {
      assert.equal(
        (await signedFetch(`${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(messageId)}`, { service: "ses", region, credentials: adminCredentials })).status,
        200,
        `stack destruction erased historical message ${messageId}`,
      );
    }
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
