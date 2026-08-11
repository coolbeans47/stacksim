import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function rawListTables(endpoint: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.ListTables",
    },
    body: "{}",
  });
}

test("authentication defaults to enforce while off and validate remain explicit modes", async () => {
  const previous = process.env.STACKSIM_AUTH_MODE;
  delete process.env.STACKSIM_AUTH_MODE;
  const root = await mkdtemp(join(tmpdir(), "stacksim-auth-default-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "enforce"), region: "eu-west-1", cdkBootstrap: true });
  try {
    assert.equal(simulator.authMode, "enforce");
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    const unsigned = await rawListTables(endpoint);
    assert.equal(unsigned.status, 403);
    assert.doesNotMatch(await unsigned.text(), /test/);
    const authorized = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials });
    assert.deepEqual((await authorized.send(new ListTablesCommand({}))).TableNames, []);
    authorized.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "off"), region: "eu-west-1", authMode: "off" });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    assert.equal((await rawListTables(endpoint)).status, 200);
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "validate"), region: "eu-west-1", authMode: "validate" });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    const validate = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials });
    assert.deepEqual((await validate.send(new ListTablesCommand({}))).TableNames, [], "validate checks SigV4 but skips IAM policy evaluation");
    const incorrect = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "incorrect" } });
    await assert.rejects(incorrect.send(new ListTablesCommand({})), (error: any) => error.name === "SignatureDoesNotMatch");
    validate.destroy();
    incorrect.destroy();
    process.env.STACKSIM_AUTH_MODE = "invalid";
    assert.throws(
      () => new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "invalid"), region: "eu-west-1" }),
      /Invalid auth mode: invalid\. Expected off, validate, or enforce\./,
    );
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.STACKSIM_AUTH_MODE;
    else process.env.STACKSIM_AUTH_MODE = previous;
  }
});

test("an unsigned private console mutation cannot bypass default enforce mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-console-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", cdkBootstrap: true });
  try {
    await simulator.start();
    const response = await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/iam/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-stacksim-console-request": "1" },
      body: JSON.stringify({
        RoleName: "bypass",
        AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(simulator.store.ensureAccount().iam.roles.bypass, undefined);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
