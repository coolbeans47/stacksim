import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProductionResourceProvider } from "../src/cloudformation/providers/index.js";
import { CLOUDFORMATION_RESOURCE_INVENTORY } from "../src/cloudformation/resource-inventory.js";
import { StackSim } from "../src/server.js";

test("the public server registry contains exactly the 105 production providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-provider-inventory-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  try {
    await simulator.start();
    const providers = ((simulator.cloudformation as any).providers.list() as ProductionResourceProvider<any>[]).sort((left, right) => left.typeName.localeCompare(right.typeName));
    assert.equal(CLOUDFORMATION_RESOURCE_INVENTORY.length, 105);
    assert.equal(new Set(CLOUDFORMATION_RESOURCE_INVENTORY).size, CLOUDFORMATION_RESOURCE_INVENTORY.length, "the executable resource inventory contains a duplicate type");
    assert.deepEqual(providers.map(provider => provider.typeName), [...CLOUDFORMATION_RESOURCE_INVENTORY].sort((left, right) => left.localeCompare(right)));
    assert.equal(new Set(providers.map(provider => provider.typeName)).size, 105);
    assert.ok(providers.every(provider => provider.visibility === "production"));
    assert.ok(providers.every(provider => provider.schema.typeName === provider.typeName));

  } finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
