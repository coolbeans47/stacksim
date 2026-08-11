import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DescribeParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { TestClock } from "../src/core/clock.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function settle(clock: TestClock, predicate: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) { clock.advance(0); if (Date.now() > end) throw new Error("Timed out waiting for PSS-05 work"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("PSS-05 schema migration adds policy and value-free EventBridge state", () => {
  const state = emptyState(); state.schemaVersion = 82;
  const regional = state.accounts["000000000000"].regions[region] as any;
  regional.parameterStore.parameters.legacy = { policies: undefined };
  delete regional.parameterStore.eventOutbox; delete regional.parameterStore.completedPolicyOccurrences;
  const migrated = migrateState(state, "000000000000", region).state as any;
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrated.accounts["000000000000"].regions[region].parameterStore.parameters.legacy.policies, []);
  assert.deepEqual(migrated.accounts["000000000000"].regions[region].parameterStore.eventOutbox, []);
});

test("PSS-05 Advanced policies emit safe durable events, recover after restart, and expire exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss05-"));
  const start = Date.parse("2026-08-10T00:00:00Z"); const clock = new TestClock(start);
  const marker = `pss05-secret-${crypto.randomUUID()}`;
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  const events: any[] = [];
  try {
    await simulator.start();
    (simulator.eventbridge as any).publishServiceEvent = async (input: any) => { events.push(structuredClone(input)); return { EventId: crypto.randomUUID() }; };
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const policies = JSON.stringify([
      { Type: "Expiration", Version: "1.0", Attributes: { Timestamp: "2026-08-10T02:00:00.000Z" } },
      { Type: "ExpirationNotification", Version: "1.0", Attributes: { Before: "1", Unit: "Hours" } },
      { Type: "NoChangeNotification", Version: "1.0", Attributes: { After: "1", Unit: "Hours" } },
    ]);
    const created = await client.send(new PutParameterCommand({ Name: "/pss05/credential", Type: "SecureString", Tier: "Advanced", Value: marker, Policies: policies }));
    assert.equal(created.Tier, "Advanced");
    await settle(clock, () => events.some(event => event.detail?.operation === "Create"));
    assert.equal(JSON.stringify(events).includes(marker), false);
    const described = await client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Values: ["/pss05/credential"] }] }));
    assert.equal(described.Parameters?.[0]?.Tier, "Advanced"); assert.equal(described.Parameters?.[0]?.Policies?.length, 3);
    await assert.rejects(client.send(new PutParameterCommand({ Name: "/pss05/credential", Type: "SecureString", Tier: "Standard", Value: "downgrade", Overwrite: true })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new PutParameterCommand({ Name: "/pss05/standard", Type: "String", Tier: "Standard", Value: "x", Policies: policies })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new PutParameterCommand({ Name: "/pss05/oversize", Type: "String", Tier: "Advanced", Value: "x".repeat(8193) })), (error: any) => error.name === "ValidationException");

    client.destroy(); await simulator.stop();
    clock.advance(3_600_000);
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: false });
    await simulator.start();
    (simulator.eventbridge as any).publishServiceEvent = async (input: any) => { events.push(structuredClone(input)); return { EventId: crypto.randomUUID() }; };
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await settle(clock, () => events.filter(event => event.detailType === "Parameter Store Policy Action").length === 2);
    assert.deepEqual(events.filter(event => event.detailType === "Parameter Store Policy Action").map(event => event.detail["policy-type"]).sort(), ["ExpirationNotification", "NoChangeNotification"]);
    clock.advance(3_600_000);
    await settle(clock, () => events.some(event => event.detail?.["policy-type"] === "Expiration"));
    await assert.rejects(client.send(new GetParameterCommand({ Name: "/pss05/credential", WithDecryption: true })), (error: any) => error.name === "ParameterNotFound");
    assert.equal(JSON.stringify(simulator.store.regionState(region).parameterStore).includes(marker), false);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
