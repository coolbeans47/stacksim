import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  TagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";
import { TestClock } from "../src/core/clock.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const token = (digit: string) => digit.repeat(32);

test("PSS-02 schema migration adds an empty Secrets Manager catalog", () => {
  const legacy = emptyState();
  legacy.schemaVersion = 63;
  delete (legacy.accounts["000000000000"].regions[region] as any).secretsManager;
  const result = migrateState(legacy, "000000000000", region);
  assert.equal(result.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(result.state.accounts["000000000000"].regions[region].secretsManager, {
    revision: 0,
    secrets: {},
    retiredSuffixes: {},
  });
});

test("PSS-06 keeps KMS/replication deferred and malformed secret-bearing requests redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss02-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "validate", cdkBootstrap: false });
  let client: SecretsManagerClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new SecretsManagerClient({ endpoint, region, credentials, maxAttempts: 1 });
    for (const input of [
      { Name: "bad-kms", SecretString: "never-written", ClientRequestToken: token("1"), KmsKeyId: "alias/aws/secretsmanager" },
      { Name: "bad-replica", SecretString: "never-written", ClientRequestToken: token("2"), AddReplicaRegions: [{ Region: "us-east-1" }] },
    ]) {
      await assert.rejects(client.send(new CreateSecretCommand(input as any)), (error: any) => error.name === "InvalidParameterException");
    }
    const good = await client.send(new CreateSecretCommand({ Name: "stage-boundary", SecretString: "first", ClientRequestToken: token("3") }));
    await client.send(new PutSecretValueCommand({ SecretId: good.ARN, SecretString: "second", ClientRequestToken: token("4"), VersionStages: ["CUSTOM"] }));
    assert.equal((await client.send(new GetSecretValueCommand({ SecretId: good.ARN, VersionStage: "CUSTOM" }))).SecretString, "second");

    const marker = `raw-secret-${crypto.randomUUID()}`;
    const response = await signedFetch(endpoint, {
      service: "secretsmanager",
      region,
      credentials,
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.CreateSecret" },
      body: `{"Name":"bad-raw","SecretString":"${marker}"`,
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), new RegExp(marker));
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));

    const unsupported = await signedFetch(endpoint, {
      service: "secretsmanager",
      region,
      credentials,
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.ReplicateSecretToRegions" },
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

test("PSS-02 key loss and envelope tampering fail only Secrets Manager admission", async () => {
  for (const mode of ["key-loss", "tamper"] as const) {
    const root = await mkdtemp(join(tmpdir(), `stacksim-pss02-${mode}-`));
    let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
    let secrets: SecretsManagerClient | undefined;
    let ssm: SSMClient | undefined;
    try {
      await simulator.start();
      secrets = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
      await secrets.send(new CreateSecretCommand({ Name: `${mode}-secret`, SecretString: "protected-value", ClientRequestToken: token("5") }));
      secrets.destroy();
      await simulator.stop();
      if (mode === "key-loss") {
        await rm(join(root, "secrets", "secretsmanager.key"), { force: true });
      } else {
        const file = (await readdir(join(root, "secrets", "secretsmanager-materials")))[0];
        const path = join(root, "secrets", "secretsmanager-materials", file);
        const envelope = JSON.parse(await readFile(path, "utf8"));
        const ciphertext = Buffer.from(envelope.ciphertext, "base64");
        ciphertext[0] ^= 0x01;
        envelope.ciphertext = ciphertext.toString("base64");
        await writeFile(path, JSON.stringify(envelope));
      }

      simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
      await simulator.start();
      const endpoint = `http://127.0.0.1:${simulator.port}`;
      secrets = new SecretsManagerClient({ endpoint, region, credentials, maxAttempts: 1 });
      ssm = new SSMClient({ endpoint, region, credentials });
      await ssm.send(new PutParameterCommand({ Name: `/unaffected/${mode}`, Type: "String", Value: "ok" }));
      assert.equal((await ssm.send(new GetParameterCommand({ Name: `/unaffected/${mode}` }))).Parameter?.Value, "ok");
      await assert.rejects(secrets.send(new GetSecretValueCommand({ SecretId: `${mode}-secret` })), (error: any) => error.name === "InternalServiceError");
      const environment = await (await fetch(`${endpoint}/_stacksim/api/environment`)).json() as any;
      assert.equal(environment.services.secretsmanager, "unavailable");
      assert.equal(environment.services.ssm, "available");
    } finally {
      secrets?.destroy();
      ssm?.destroy();
      await simulator.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("PSS-02 IAM resolves exact secret ARNs and blocks tag self-lockout", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss02-iam-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials };
    const admin = new SecretsManagerClient(options);
    const iam = new IAMClient(options);
    const sts = new STSClient(options);
    clients.push(admin, iam, sts);
    const created = await admin.send(new CreateSecretCommand({
      Name: "iam/exact-secret",
      SecretString: "allowed-value",
      ClientRequestToken: token("6"),
      Tags: [{ Key: "environment", Value: "dev" }],
    }));
    const role = await iam.send(new CreateRoleCommand({
      RoleName: "secret-reader",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "secret-reader",
      PolicyName: "exact-secret",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: created.ARN },
          { Effect: "Allow", Action: "secretsmanager:TagResource", Resource: created.ARN, Condition: { StringEquals: { "aws:ResourceTag/environment": "dev" } } },
        ],
      }),
    }));
    const session = await sts.send(new AssumeRoleCommand({ RoleArn: role.Role!.Arn!, RoleSessionName: "secret-reader" }));
    const reader = new SecretsManagerClient({
      endpoint,
      region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: session.Credentials!.AccessKeyId!,
        secretAccessKey: session.Credentials!.SecretAccessKey!,
        sessionToken: session.Credentials!.SessionToken!,
      },
    });
    clients.push(reader);
    assert.equal((await reader.send(new GetSecretValueCommand({ SecretId: "iam/exact-secret" }))).SecretString, "allowed-value");
    await assert.rejects(
      reader.send(new TagResourceCommand({ SecretId: "iam/exact-secret", Tags: [{ Key: "environment", Value: "prod" }] })),
      (error: any) => error.name === "AccessDeniedException",
    );
    assert.equal((await admin.send(new GetSecretValueCommand({ SecretId: "iam/exact-secret" }))).SecretString, "allowed-value");
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-02 scheduled deletion is deterministic across restart and retires the old ARN suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss02-deletion-"));
  const clock = new TestClock(1_750_000_000_000);
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let client: SecretsManagerClient | undefined;
  try {
    await simulator.start();
    client = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await client.send(new CreateSecretCommand({ Name: "scheduled/recreate", SecretString: "old", ClientRequestToken: token("7") }));
    await client.send(new DeleteSecretCommand({ SecretId: created.ARN, RecoveryWindowInDays: 7 }));
    client.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
    await simulator.start();
    client = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    clock.advance(7 * 86_400_000);
    await assert.rejects(client.send(new GetSecretValueCommand({ SecretId: created.ARN })), (error: any) => error.name === "ResourceNotFoundException");
    const recreated = await client.send(new CreateSecretCommand({ Name: "scheduled/recreate", SecretString: "new", ClientRequestToken: token("8") }));
    assert.notEqual(recreated.ARN, created.ARN);
    const suffix = created.ARN!.slice(-6);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(state.accounts["000000000000"].regions[region].secretsManager.retiredSuffixes["scheduled/recreate"].includes(suffix), true);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
