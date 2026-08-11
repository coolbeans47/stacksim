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
