import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cdkCli } from "./support/project-cli.js";

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "ses-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");

function onlyResource(resources: Record<string, CfnResource>, type: string): [string, CfnResource] {
  const matches = Object.entries(resources).filter(([, resource]) => resource.Type === type);
  assert.equal(matches.length, 1, `expected one ${type} resource`);
  return matches[0];
}

function cdkEnvironment(tempRoot: string): NodeJS.ProcessEnv {
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
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: "eu-west-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: "eu-west-1",
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    STACKSIM_NETWORK_ALLOW_PORT: "",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(output: string, env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cdkCli, "--output", output, "synth", "--quiet", "--no-notices", "--no-color"],
      { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

test("the pinned SES-03 CDK fixture synthesizes the frozen SES and grant boundary", { timeout: 180_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "stacksim-cdk-ses-synth-"));
  try {
    const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    assert.equal(packageJson.devDependencies["aws-cdk-lib"], "2.265.0");
    assert.equal(packageJson.devDependencies.cdk, "2.1132.0");

    const result = await runCdk(output, cdkEnvironment(output));
    assert.equal(result.code, 0, `cdk synth failed\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /STACKSIM_NETWORK_TRIPWIRE/,
      "the pinned synth attempted an external network connection",
    );

    const template = JSON.parse(await readFile(join(output, "SesStack.template.json"), "utf8"));
    const resources = template.Resources as Record<string, CfnResource>;
    const resourceTypes = Object.values(resources)
      .map(resource => resource.Type)
      .sort();
    assert.deepEqual(resourceTypes, [
      "AWS::CDK::Metadata",
      "AWS::IAM::Policy",
      "AWS::IAM::Role",
      "AWS::SES::ConfigurationSet",
      "AWS::SES::EmailIdentity",
      "AWS::SES::Template",
    ]);

    const [configurationSetId, configurationSet] = onlyResource(resources, "AWS::SES::ConfigurationSet");
    assert.deepEqual(configurationSet.Properties, {
      Name: "ses03-configuration-set",
      SendingOptions: { SendingEnabled: true },
    });

    const [identityId, identity] = onlyResource(resources, "AWS::SES::EmailIdentity");
    assert.deepEqual(identity.Properties, {
      ConfigurationSetAttributes: {
        ConfigurationSetName: { Ref: configurationSetId },
      },
      EmailIdentity: "sender@ses03.example.test",
    });

    const [templateId, emailTemplate] = onlyResource(resources, "AWS::SES::Template");
    assert.deepEqual(emailTemplate.Properties, {
      Template: {
        HtmlPart: "<p>Hello <strong>{{name}}</strong>.</p>",
        SubjectPart: "Welcome, {{name}}",
        TemplateName: "ses03-welcome",
        TextPart: "Hello {{name}}.",
      },
    });

    const [roleId, role] = onlyResource(resources, "AWS::IAM::Role");
    assert.deepEqual(role.Properties, {
      AssumeRolePolicyDocument: {
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
        }],
        Version: "2012-10-17",
      },
    });

    const [policyId, policy] = onlyResource(resources, "AWS::IAM::Policy");
    assert.deepEqual(policy.Properties, {
      PolicyDocument: {
        Statement: [{
          Action: ["ses:SendEmail", "ses:SendRawEmail"],
          Effect: "Allow",
          Resource: {
            "Fn::Join": [
              "",
              [
                "arn:",
                { Ref: "AWS::Partition" },
                ":ses:eu-west-1:000000000000:identity/",
                { Ref: identityId },
              ],
            ],
          },
        }],
        Version: "2012-10-17",
      },
      PolicyName: policyId,
      Roles: [{ Ref: roleId }],
    });

    assert.deepEqual(template.Outputs, {
      IdentityName: { Value: { Ref: identityId } },
      ConfigurationSetName: { Value: { Ref: configurationSetId } },
      TemplateName: { Value: { Ref: templateId } },
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
