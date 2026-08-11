import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GetParameterCommand,
  GetParameterHistoryCommand,
  GetParametersByPathCommand,
  LabelParameterVersionCommand,
  PutParameterCommand,
  SSMClient,
  UnlabelParameterVersionCommand,
} from "@aws-sdk/client-ssm";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("PSS-03 schema migration adds authoritative label maps and policy lineage", () => {
  const legacy = emptyState();
  legacy.schemaVersion = 80;
  const regional = legacy.accounts["000000000000"].regions[region] as any;
  regional.parameterStore.parameters["/legacy"] = { name: "/legacy", labels: undefined };
  regional.secretsManager.secrets.legacy = { policyRevision: undefined, resourcePolicy: { revision: 7 } };
  const migrated = migrateState(legacy, "000000000000", region).state as any;
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrated.accounts["000000000000"].regions[region].parameterStore.parameters["/legacy"].labels, {});
  assert.equal(migrated.accounts["000000000000"].regions[region].secretsManager.secrets.legacy.policyRevision, 7);
});

test("PSS-03 labels select, move, unlabel, paginate history, and survive restart without value leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss03-parameter-"));
  const marker = `pss03-parameter-${crypto.randomUUID()}`;
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new PutParameterCommand({ Name: "/learning/config", Type: "SecureString", Value: marker, Description: "first" }));
    await client.send(new PutParameterCommand({ Name: "/learning/config", Type: "SecureString", Value: "second", Description: "second", Overwrite: true }));

    const labeled = await client.send(new LabelParameterVersionCommand({ Name: "/learning/config", ParameterVersion: 1, Labels: ["stable", "1invalid", "awsReserved"] }));
    assert.equal(labeled.ParameterVersion, 1);
    assert.deepEqual(labeled.InvalidLabels, ["1invalid", "awsReserved"]);
    assert.equal((await client.send(new GetParameterCommand({ Name: "/learning/config:stable", WithDecryption: true }))).Parameter?.Value, marker);
    const filtered = await client.send(new GetParametersByPathCommand({ Path: "/learning", Recursive: true, WithDecryption: true, ParameterFilters: [{ Key: "Label", Option: "Equals", Values: ["stable"] }] }));
    assert.deepEqual(filtered.Parameters?.map(parameter => [parameter.Version, parameter.Value]), [[1, marker]]);

    const firstPage = await client.send(new GetParameterHistoryCommand({ Name: "/learning/config", WithDecryption: false, MaxResults: 1 }));
    assert.equal(firstPage.Parameters?.[0]?.Version, 2);
    assert.notEqual(firstPage.Parameters?.[0]?.Value, "second");
    assert.ok(firstPage.NextToken);
    const secondPage = await client.send(new GetParameterHistoryCommand({ Name: "/learning/config", WithDecryption: true, MaxResults: 1, NextToken: firstPage.NextToken }));
    assert.deepEqual(secondPage.Parameters?.map(parameter => [parameter.Version, parameter.Value, parameter.Labels]), [[1, marker, ["stable"]]]);

    await client.send(new LabelParameterVersionCommand({ Name: "/learning/config", ParameterVersion: 2, Labels: ["stable"] }));
    assert.equal((await client.send(new GetParameterCommand({ Name: "/learning/config:stable", WithDecryption: true }))).Parameter?.Value, "second");
    const unlabeled = await client.send(new UnlabelParameterVersionCommand({ Name: "/learning/config", ParameterVersion: 2, Labels: ["stable", "missing"] }));
    assert.deepEqual(unlabeled.RemovedLabels, ["stable"]);
    assert.deepEqual(unlabeled.InvalidLabels, ["missing"]);
    await assert.rejects(client.send(new GetParameterCommand({ Name: "/learning/config:stable", WithDecryption: true })), (error: any) => error.name === "ParameterNotFound");

    const ten = Array.from({ length: 10 }, (_, index) => `label-${index}`);
    await client.send(new LabelParameterVersionCommand({ Name: "/learning/config", ParameterVersion: 2, Labels: ten }));
    await assert.rejects(client.send(new LabelParameterVersionCommand({ Name: "/learning/config", ParameterVersion: 2, Labels: ["eleventh"] })), (error: any) => error.name === "ParameterVersionLabelLimitExceeded");
    const save = simulator.store.save.bind(simulator.store);
    let failSave = true;
    (simulator.store as any).save = async () => {
      if (failSave) { failSave = false; throw new Error("injected PSS-03 label commit failure"); }
      await save();
    };
    await assert.rejects(client.send(new LabelParameterVersionCommand({ Name: "/learning/config", ParameterVersion: 1, Labels: ["label-0"] })));
    (simulator.store as any).save = save;
    assert.equal((await client.send(new GetParameterCommand({ Name: "/learning/config:label-0", WithDecryption: true }))).Parameter?.Version, 2);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));

    client.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    assert.equal((await client.send(new GetParameterCommand({ Name: "/learning/config:label-0", WithDecryption: true }))).Parameter?.Value, "second");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-03 version 101 fails while the oldest parameter version is labeled", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss03-retention-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new PutParameterCommand({ Name: "/retention/labeled", Type: "String", Value: "v1" }));
    await client.send(new LabelParameterVersionCommand({ Name: "/retention/labeled", ParameterVersion: 1, Labels: ["keep"] }));
    for (let version = 2; version <= 100; version++) await client.send(new PutParameterCommand({ Name: "/retention/labeled", Type: "String", Value: `v${version}`, Overwrite: true }));
    await assert.rejects(client.send(new PutParameterCommand({ Name: "/retention/labeled", Type: "String", Value: "v101", Overwrite: true })), (error: any) => error.name === "ParameterMaxVersionLimitExceeded");
    assert.equal((await client.send(new GetParameterCommand({ Name: "/retention/labeled" }))).Parameter?.Version, 100);
    await client.send(new LabelParameterVersionCommand({ Name: "/retention/labeled", ParameterVersion: 2, Labels: ["keep"] }));
    assert.equal((await client.send(new PutParameterCommand({ Name: "/retention/labeled", Type: "String", Value: "v101", Overwrite: true }))).Version, 101);
    await assert.rejects(client.send(new GetParameterCommand({ Name: "/retention/labeled:1" })), (error: any) => error.name === "ParameterVersionNotFound");
    assert.equal((await client.send(new GetParameterCommand({ Name: "/retention/labeled:keep" }))).Parameter?.Version, 2);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
