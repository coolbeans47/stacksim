import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  DeleteParametersCommand,
  DescribeParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
  RemoveTagsFromResourceCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("PSS-01 official client covers ordinary parameter lifecycle, hierarchy, tags, and versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss01-core-"));
  const clock = new TestClock(1_750_000_000_000);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const created = await client.send(new PutParameterCommand({
      Name: "/app/dev/host", Type: "String", Value: "localhost", Description: "Application host",
      AllowedPattern: "^[a-z]+$", Tags: [{ Key: "env", Value: "dev" }],
    }));
    assert.equal(created.Version, 1);
    assert.equal(created.Tier, "Standard");
    const first = await client.send(new GetParameterCommand({ Name: "/app/dev/host" }));
    assert.equal(first.Parameter?.Value, "localhost");
    assert.equal(first.Parameter?.Version, 1);

    await client.send(new PutParameterCommand({ Name: "/app/dev/host", Type: "String", Value: "server", Overwrite: true }));
    assert.equal((await client.send(new GetParameterCommand({ Name: "/app/dev/host:1" }))).Parameter?.Value, "localhost");
    assert.equal((await client.send(new GetParameterCommand({ Name: "/app/dev/host:2" }))).Parameter?.Value, "server");

    await client.send(new PutParameterCommand({ Name: "/app/dev/ports", Type: "StringList", Value: "80, 443,8080" }));
    assert.equal((await client.send(new GetParameterCommand({ Name: "/app/dev/ports" }))).Parameter?.Value, "80,443,8080");
    await client.send(new PutParameterCommand({ Name: "/app/prod/host", Type: "String", Value: "prod" }));

    const path = await client.send(new GetParametersByPathCommand({ Path: "/app/dev", Recursive: true, MaxResults: 1 }));
    assert.equal(path.Parameters?.length, 1);
    assert.ok(path.NextToken);
    const rest = await client.send(new GetParametersByPathCommand({ Path: "/app/dev", Recursive: true, MaxResults: 10, NextToken: path.NextToken }));
    assert.equal(rest.Parameters?.length, 1);

    const batch = await client.send(new GetParametersCommand({ Names: ["/app/dev/ports", "/missing"] }));
    assert.deepEqual(batch.InvalidParameters, ["/missing"]);
    assert.equal(batch.Parameters?.[0].Name, "/app/dev/ports");

    await client.send(new AddTagsToResourceCommand({ ResourceType: "Parameter", ResourceId: "/app/dev/host", Tags: [{ Key: "owner", Value: "platform" }] }));
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: "/app/dev/host" }))).TagList, [
      { Key: "env", Value: "dev" },
      { Key: "owner", Value: "platform" },
    ]);
    await client.send(new RemoveTagsFromResourceCommand({ ResourceType: "Parameter", ResourceId: "/app/dev/host", TagKeys: ["env"] }));

    const described = await client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Option: "BeginsWith", Values: ["/app/dev"] }] }));
    assert.deepEqual(described.Parameters?.map(parameter => parameter.Name), ["/app/dev/host", "/app/dev/ports"]);

    await client.send(new DeleteParametersCommand({ Names: ["/app/dev/ports", "/does-not-exist"] }));
    await client.send(new DeleteParameterCommand({ Name: "/app/prod/host" }));
    await assert.rejects(client.send(new GetParameterCommand({ Name: "/app/prod/host" })), (error: any) => error.name === "ParameterNotFound");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-01 SecureString material is encrypted outside state and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss01-secure-"));
  const marker = `secure-${crypto.randomUUID()}`;
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await client.send(new PutParameterCommand({ Name: "/secure/token", Type: "SecureString", Value: marker }));
    const opaque = (await client.send(new GetParameterCommand({ Name: "/secure/token" }))).Parameter?.Value;
    assert.notEqual(opaque, marker);
    assert.match(opaque ?? "", /^AQICAH/);
    assert.equal((await client.send(new GetParameterCommand({ Name: "/secure/token", WithDecryption: true }))).Parameter?.Value, marker);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));
    const materialFiles = await readdir(join(root, "secrets", "ssm-materials"));
    assert.equal(materialFiles.length, 1);
    assert.doesNotMatch(await readFile(join(root, "secrets", "ssm-materials", materialFiles[0]), "utf8"), new RegExp(marker));
    client.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    assert.equal((await client.send(new GetParameterCommand({ Name: "/secure/token", WithDecryption: true }))).Parameter?.Value, marker);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
