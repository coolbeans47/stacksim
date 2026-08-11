import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("PSS-01 schema migration adds the catalog and preserves unknown legacy SSM state", () => {
  const legacy = emptyState();
  legacy.schemaVersion = 62;
  const regional = legacy.accounts["000000000000"].regions[region] as any;
  delete regional.parameterStore;
  regional.ssmParameters = { "/legacy": { value: "preserve-me" } };
  const result = migrateState(legacy, "000000000000", region);
  assert.equal(result.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(result.state.accounts["000000000000"].regions[region].parameterStore, { revision: 0, parameters: {}, tombstones: {}, eventOutbox: [], completedPolicyOccurrences: {} });
  assert.equal((result.state.accounts["000000000000"].regions[region] as any).ssmParameters["/legacy"].value, "preserve-me");
});

test("PSS-01 rejects unsupported fields before mutation and redacts malformed raw requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss01-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "validate", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new SSMClient({ endpoint, region, credentials, maxAttempts: 1 });
    for (const input of [
      { Name: "/bad/key", Type: "SecureString", Value: "never-written", KeyId: "alias/aws/ssm" },
      { Name: "/bad/data", Type: "String", Value: "never-written", DataType: "aws:ec2:image" },
      { Name: "/bad/tier", Type: "String", Value: "never-written", Tier: "Intelligent-Tiering" },
      { Name: "/bad/policy", Type: "String", Value: "never-written", Policies: JSON.stringify([{ Type: "Expiration", Version: "1.0", Attributes: { Timestamp: "2099-01-01T00:00:00Z" } }]) },
    ]) {
      await assert.rejects(client.send(new PutParameterCommand(input as any)), (error: any) => error.name === "ValidationException");
      await assert.rejects(client.send(new GetParameterCommand({ Name: input.Name })), (error: any) => error.name === "ParameterNotFound");
    }
    const marker = `raw-${crypto.randomUUID()}`;
    const response = await signedFetch(endpoint, {
      service: "ssm",
      region,
      credentials,
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.PutParameter" },
      body: `{"Name":"/bad/raw","Value":"${marker}"`,
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), new RegExp(marker));
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));

    const unsupported = await signedFetch(endpoint, {
      service: "ssm",
      region,
      credentials,
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.SendCommand" },
      body: "{}",
    });
    assert.equal(unsupported.status, 400);
    assert.match(await unsupported.text(), /UnknownOperationException/);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-01 tombstones use the injected clock and key loss fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss01-recovery-"));
  const clock = new TestClock(1_750_000_000_000);
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new PutParameterCommand({ Name: "/recreate/plain", Type: "String", Value: "first" }));
    await client.send(new DeleteParameterCommand({ Name: "/recreate/plain" }));
    await assert.rejects(client.send(new PutParameterCommand({ Name: "/recreate/plain", Type: "String", Value: "second" })), (error: any) => error.name === "ParameterAlreadyExists");
    clock.advance(30_000);
    assert.equal((await client.send(new PutParameterCommand({ Name: "/recreate/plain", Type: "String", Value: "second" }))).Version, 1);
    await client.send(new PutParameterCommand({ Name: "/protected/value", Type: "SecureString", Value: "protected-marker" }));
    client.destroy();
    await simulator.stop();
    await rm(join(root, "secrets", "ssm.key"), { force: true });

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
    await assert.rejects(simulator.start(), /encryption key is missing.*restore/i);
    assert.match(await readFile(join(root, "state.json"), "utf8"), /"materialId"/);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-01 IAM expands named batches and evaluates persisted parameter tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss01-iam-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials };
    const admin = new SSMClient(options);
    const iam = new IAMClient(options);
    const sts = new STSClient(options);
    clients.push(admin, iam, sts);
    await admin.send(new PutParameterCommand({ Name: "/iam/allowed", Value: "yes", Type: "String", Tags: [{ Key: "environment", Value: "dev" }] }));
    await admin.send(new PutParameterCommand({ Name: "/iam/denied", Value: "no", Type: "String", Tags: [{ Key: "environment", Value: "prod" }] }));
    const roleArn = "arn:aws:iam::000000000000:role/parameter-reader";
    await iam.send(new CreateRoleCommand({
      RoleName: "parameter-reader",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "parameter-reader",
      PolicyName: "tagged-read",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["ssm:GetParameter", "ssm:GetParameters"],
          Resource: "arn:aws:ssm:eu-west-1:000000000000:parameter/iam/*",
          Condition: { StringEquals: { "aws:ResourceTag/environment": "dev" } },
        }],
      }),
    }));
    const session = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "parameter-test" }));
    const reader = new SSMClient({
      endpoint,
      region,
      credentials: {
        accessKeyId: session.Credentials!.AccessKeyId!,
        secretAccessKey: session.Credentials!.SecretAccessKey!,
        sessionToken: session.Credentials!.SessionToken!,
      },
      maxAttempts: 1,
    });
    clients.push(reader);
    assert.equal((await reader.send(new GetParameterCommand({ Name: "/iam/allowed" }))).Parameter?.Value, "yes");
    await assert.rejects(reader.send(new GetParameterCommand({ Name: "/iam/allowed:production" })), (error: any) => error.name === "ParameterNotFound");
    await assert.rejects(reader.send(new GetParameterCommand({ Name: "/iam/denied" })), (error: any) => error.name === "AccessDeniedException");
    await assert.rejects(reader.send(new GetParameterCommand({ Name: "/iam/denied:production" })), (error: any) => error.name === "AccessDeniedException");
    const { GetParametersCommand } = await import("@aws-sdk/client-ssm");
    await assert.rejects(reader.send(new GetParametersCommand({ Names: ["/iam/allowed", "/iam/denied"] })), (error: any) => error.name === "AccessDeniedException");
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-01 blocks bootstrap adoption when an application owns the deterministic name", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss01-bootstrap-collision-"));
  const name = "/cdk-bootstrap/hnb659fds/version";
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await client.send(new PutParameterCommand({ Name: name, Type: "String", Value: "application-owned" }));
    client.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: true });
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    assert.equal((await client.send(new GetParameterCommand({ Name: name }))).Parameter?.Value, "application-owned");
    const environment = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/environment`)).json() as any;
    assert.equal(environment.cdkBootstrap.status, "blocked");
    assert.deepEqual(environment.cdkBootstrap.collisions, [{
      type: "AWS::SSM::Parameter",
      name,
      arn: `arn:aws:ssm:${region}:000000000000:parameter/cdk-bootstrap/hnb659fds/version`,
    }]);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
