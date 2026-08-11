import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GetParameterCommand, GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { authorizationTarget } from "../src/auth/target.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const versionName = "/cdk-bootstrap/hnb659fds/version";

test("the official SSM client reads only the regional CDK bootstrap version parameter", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-ssm-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });

    await assert.rejects(client.send(new GetParameterCommand({ Name: versionName })), (error: any) => {
      assert.equal(error.name, "ParameterNotFound");
      assert.equal(error.$metadata?.httpStatusCode, 400);
      return true;
    });

    const updatedAt = 1_720_000_000_000;
    simulator.store.regionState(region).cloudformation.bootstrap = {
      owner: "stacksim",
      qualifier: "hnb659fds",
      compatibilityVersion: 23,
      policyRevision: 5,
      bucketName: `cdk-hnb659fds-assets-${accountId}-${region}`,
      roleArns: {
        deploy: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-deploy-role-${accountId}-${region}`,
        filePublishing: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-file-publishing-role-${accountId}-${region}`,
        imagePublishing: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-image-publishing-role-${accountId}-${region}`,
        lookup: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-lookup-role-${accountId}-${region}`,
        cloudFormationExecution: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-cfn-exec-role-${accountId}-${region}`,
      },
      versionParameterName: versionName,
      updatedAt,
    };
    await simulator.store.save();

    const found = (await client.send(new GetParameterCommand({ Name: versionName, WithDecryption: true }))).Parameter;
    assert.equal(found?.Name, versionName);
    assert.equal(found?.Type, "String");
    assert.equal(found?.Value, "23");
    assert.equal(found?.Version, 1);
    assert.equal(found?.LastModifiedDate?.getTime(), updatedAt);
    assert.equal(found?.ARN, `arn:aws:ssm:${region}:${accountId}:parameter${versionName}`);
    assert.equal(found?.DataType, "text");

    const batch = await client.send(new GetParametersCommand({ Names: [versionName, "/application/not-exposed"] }));
    assert.deepEqual(batch.Parameters?.map(parameter => parameter.Name), [versionName]);
    assert.deepEqual(batch.InvalidParameters, ["/application/not-exposed"]);
    await assert.rejects(client.send(new GetParameterCommand({ Name: "/application/not-exposed" })), (error: any) => error.name === "ParameterNotFound");
    await assert.rejects(client.send(new PutParameterCommand({ Name: versionName, Value: "999", Type: "String" })), (error: any) => error.name === "AccessDeniedException");

    const health = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/health`)).json() as any;
    const environment = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/environment`)).json() as any;
    assert.ok(health.services.includes("ssm"));
    assert.equal(environment.services.ssm, "available");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SSM authorization targets every requested parameter ARN", async () => {
  const names = [versionName, "/application/other"];
  const body = Buffer.from(JSON.stringify({ Names: names }));
  const url = new URL("http://127.0.0.1/");
  const request = {
    method: "POST",
    url: "/",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameters" },
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
    [Symbol.for("stacksim.request-body")]: body,
  } as any;
  const principal = { principalArn: `arn:aws:iam::${accountId}:role/deployer`, accountId, accessKeyId: "admin" } as any;
  const target = await authorizationTarget(request, url, "ssm", region, accountId, principal, Date.now());
  assert.equal(target.action, "ssm:GetParameters");
  assert.equal(target.resource, `arn:aws:ssm:${region}:${accountId}:parameter${versionName}`);
  assert.deepEqual(target.additionalTargets?.map(item => ({ action: item.action, resource: item.resource })), [
    { action: "ssm:GetParameters", resource: `arn:aws:ssm:${region}:${accountId}:parameter/application/other` },
  ]);
});
