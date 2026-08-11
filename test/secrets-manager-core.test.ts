import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  ListSecretVersionIdsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const token = (digit: string) => digit.repeat(32);

test("PSS-02 official client covers the everyday secret lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss02-core-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SecretsManagerClient | undefined;
  try {
    await simulator.start();
    client = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });

    const created = await client.send(new CreateSecretCommand({
      Name: "apps/catalog/database",
      Description: "Catalog credentials",
      SecretString: '{"password":"first"}',
      ClientRequestToken: token("1"),
      Tags: [{ Key: "environment", Value: "dev" }],
    }));
    assert.match(created.ARN!, /^arn:aws:secretsmanager:eu-west-1:000000000000:secret:apps\/catalog\/database-[A-Za-z0-9]{6}$/);
    assert.equal(created.VersionId, token("1"));
    assert.equal((await client.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, '{"password":"first"}');

    const put = await client.send(new PutSecretValueCommand({
      SecretId: "apps/catalog/database",
      SecretString: '{"password":"second"}',
      ClientRequestToken: token("2"),
    }));
    assert.deepEqual(put.VersionStages, ["AWSCURRENT"]);
    assert.equal((await client.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "AWSPREVIOUS" }))).SecretString, '{"password":"first"}');
    assert.equal((await client.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionId: token("2") }))).SecretString, '{"password":"second"}');
    assert.equal((await client.send(new PutSecretValueCommand({ SecretId: created.ARN, SecretString: '{"password":"second"}', ClientRequestToken: token("2") }))).VersionId, token("2"));
    await assert.rejects(
      client.send(new PutSecretValueCommand({ SecretId: created.ARN, SecretString: "different", ClientRequestToken: token("2") })),
      (error: any) => error.name === "InvalidRequestException",
    );

    await client.send(new UpdateSecretCommand({ SecretId: created.ARN, Description: "Updated catalog credentials" }));
    await client.send(new UpdateSecretCommand({ SecretId: created.ARN, SecretString: '{"password":"third"}', ClientRequestToken: token("3") }));
    await assert.rejects(
      client.send(new UpdateSecretCommand({ SecretId: created.ARN, SecretString: '{"password":"third"}', ClientRequestToken: token("3") })),
      (error: any) => error.name === "InvalidRequestException",
    );

    await client.send(new TagResourceCommand({ SecretId: created.ARN, Tags: [{ Key: "owner", Value: "platform" }] }));
    await client.send(new UntagResourceCommand({ SecretId: created.ARN, TagKeys: ["environment"] }));
    const described = await client.send(new DescribeSecretCommand({ SecretId: created.ARN }));
    assert.equal(described.Description, "Updated catalog credentials");
    assert.deepEqual(described.Tags, [{ Key: "owner", Value: "platform" }]);
    assert.equal(described.VersionIdsToStages?.[token("3")]?.[0], "AWSCURRENT");

    const listed = await client.send(new ListSecretsCommand({ Filters: [{ Key: "tag-key", Values: ["own"] }], MaxResults: 1 }));
    assert.equal(listed.SecretList?.[0]?.Name, "apps/catalog/database");
    const versions = await client.send(new ListSecretVersionIdsCommand({ SecretId: created.ARN, IncludeDeprecated: true, MaxResults: 10 }));
    assert.deepEqual(new Set(versions.Versions?.map(version => version.VersionId)), new Set([token("1"), token("2"), token("3")]));

    const password = (await client.send(new GetRandomPasswordCommand({
      PasswordLength: 40,
      ExcludePunctuation: true,
      RequireEachIncludedType: true,
    }))).RandomPassword!;
    assert.equal(password.length, 40);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /\d/);

    const binary = await client.send(new CreateSecretCommand({
      Name: "apps/catalog/binary",
      SecretBinary: Uint8Array.from([0, 1, 2, 253, 254, 255]),
      ClientRequestToken: token("4"),
    }));
    assert.deepEqual(
      [...(await client.send(new GetSecretValueCommand({ SecretId: binary.ARN }))).SecretBinary!],
      [0, 1, 2, 253, 254, 255],
    );

    const deletion = await client.send(new DeleteSecretCommand({ SecretId: created.ARN, RecoveryWindowInDays: 7 }));
    assert.ok(deletion.DeletionDate);
    await assert.rejects(client.send(new GetSecretValueCommand({ SecretId: created.ARN })), (error: any) => error.name === "InvalidRequestException");
    assert.equal((await client.send(new ListSecretsCommand({ IncludePlannedDeletion: true }))).SecretList?.some(secret => secret.ARN === created.ARN), true);
    await client.send(new RestoreSecretCommand({ SecretId: created.ARN }));
    assert.equal((await client.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, '{"password":"third"}');

    await client.send(new DeleteSecretCommand({ SecretId: created.ARN, ForceDeleteWithoutRecovery: true }));
    const recreated = await client.send(new CreateSecretCommand({ Name: "apps/catalog/database" }));
    assert.notEqual(recreated.ARN, created.ARN);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
test("PSS-02 secret material remains outside ordinary state and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss02-secure-"));
  const marker = `secret-${crypto.randomUUID()}`;
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SecretsManagerClient | undefined;
  try {
    await simulator.start();
    client = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const created = await client.send(new CreateSecretCommand({ Name: "restart-secret", SecretString: marker, ClientRequestToken: token("5") }));
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));
    for (const file of await readdir(join(root, "secrets", "secretsmanager-materials"))) {
      assert.doesNotMatch(await readFile(join(root, "secrets", "secretsmanager-materials", file), "utf8"), new RegExp(marker));
    }
    client.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
    await simulator.start();
    client = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    assert.equal((await client.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, marker);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
