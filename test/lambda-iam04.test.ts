import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, DeleteRoleCommand, IAMClient, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("IAM-04 preserves referenced roles, revalidates trust, and records denied Lambda log delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-iam04-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials };
    const iam = new IAMClient(options);
    const lambda = new LambdaClient(options);
    clients.push(iam, lambda);
    const roleName = "iam04-runtime";
    const role = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    }));
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "iam04-function",
      Runtime: "nodejs22.x",
      Role: role.Role!.Arn!,
      Handler: "index.handler",
      Code: { ZipFile: createZip([{ name: "index.js", content: "const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts'); exports.handler = async () => { console.log('iam04'); return new STSClient({ endpoint: process.env.SIM_ENDPOINT, region: process.env.AWS_REGION }).send(new GetCallerIdentityCommand({})); };" }]) },
      Environment: { Variables: { SIM_ENDPOINT: options.endpoint } },
    }));

    const invocation = await lambda.send(new InvokeCommand({ FunctionName: "iam04-function", Payload: Buffer.from("{}") }));
    const identity = JSON.parse(Buffer.from(invocation.Payload ?? []).toString("utf8"));
    assert.match(identity.Arn, /^arn:aws:sts::000000000000:assumed-role\/iam04-runtime\/lambda-[a-z0-9]+$/);
    const diagnostic = simulator.store.regionState().functions["iam04-function"].lastLogDeliveryError;
    assert.equal(diagnostic?.code, "AccessDeniedException");
    assert.match(diagnostic?.message ?? "", /not authorized to deliver function logs/);
    await assert.rejects(iam.send(new DeleteRoleCommand({ RoleName: roleName })), (error: any) => /^DeleteConflict/.test(error.name) && /referenced by Lambda function/.test(error.message));

    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: roleName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::000000000000:root` }, Action: "sts:AssumeRole" }],
      }),
    }));
    await assert.rejects(lambda.send(new InvokeCommand({ FunctionName: "iam04-function", Payload: Buffer.from("{}") })), (error: any) => error.name === "InvalidParameterValueException" && /no longer trusts/.test(error.message));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("IAMGAP-05 ZIP workers do not inherit host secrets and rotate invocation credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap05-"));
  const hostEnvironment = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    STACKSIM_HOST_SECRET: process.env.STACKSIM_HOST_SECRET,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  };
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "bootstrap-access-key",
    AWS_SECRET_ACCESS_KEY: "bootstrap-secret-key",
    AWS_SESSION_TOKEN: "bootstrap-session-token",
    STACKSIM_HOST_SECRET: "host-only-secret",
    HTTPS_PROXY: "http://host-proxy.invalid:8443",
    NODE_OPTIONS: "--no-warnings",
  });
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials };
    const iam = new IAMClient(options);
    const lambda = new LambdaClient(options);
    clients.push(iam, lambda);
    const role = await iam.send(new CreateRoleCommand({
      RoleName: "iamgap05-runtime",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    }));
    const snapshot = `({
      hostSecret: process.env.STACKSIM_HOST_SECRET,
      proxy: process.env.HTTPS_PROXY,
      nodeOptions: process.env.NODE_OPTIONS,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      safeValue: process.env.SAFE_VALUE,
    })`;
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "iamgap05-function",
      Runtime: "nodejs22.x",
      Role: role.Role!.Arn!,
      Handler: "index.handler",
      Code: { ZipFile: createZip([{ name: "index.js", content: `const initialized = ${snapshot}; exports.handler = async () => ({ initialized, invoked: ${snapshot} });` }]) },
      Environment: { Variables: { SAFE_VALUE: "configured-value", NODE_OPTIONS: "--trace-warnings", AWS_ACCESS_KEY_ID: "configured-access-key" } },
    }));

    const invoke = async () => {
      const response = await lambda.send(new InvokeCommand({ FunctionName: "iamgap05-function", Payload: Buffer.from("{}") }));
      assert.equal(response.FunctionError, undefined);
      return JSON.parse(Buffer.from(response.Payload ?? []).toString("utf8"));
    };
    const first = await invoke();
    const second = await invoke();
    for (const view of [first.initialized, first.invoked, second.invoked]) {
      assert.equal("hostSecret" in view, false);
      assert.equal("proxy" in view, false);
      assert.equal("nodeOptions" in view, false);
      assert.equal(view.safeValue, "configured-value");
      assert.match(view.accessKeyId, /^ASIA[A-Z0-9]+$/);
      assert.notEqual(view.secretAccessKey, "bootstrap-secret-key");
      assert.notEqual(view.sessionToken, "bootstrap-session-token");
    }
    assert.equal(first.initialized.accessKeyId, first.invoked.accessKeyId);
    assert.equal(second.initialized.accessKeyId, first.initialized.accessKeyId);
    assert.notEqual(second.invoked.accessKeyId, first.invoked.accessKeyId);
  } finally {
    for (const [name, value] of Object.entries(hostEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
