import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createLogQueryDefinitionProvider } from "../src/cloudformation/providers/logs-cfn10.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1", accountId = "000000000000";
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
const providerContext: ProviderContext = { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/query-definition/id`, logicalId: "ParameterizedQuery", operationId: "operation-query", resourceOperationId: "resource-query", idempotencyKey: "query-definition-idempotency-key", deadlineAt: Date.now() + 60_000, principal: { identity } };

test("AWS::Logs::QueryDefinition persists language and parameters through provider lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-query-definition-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  try {
    await simulator.start(); const provider = createLogQueryDefinitionProvider(simulator.logs); const desired = provider.canonicalize({ Name: "CloudFormation/Parameterized", QueryLanguage: "CWLI", QueryString: "filter service = {{service}} | fields @message", LogGroupNames: ["/application/orders"], Parameters: [{ Name: "service", DefaultValue: "orders", Description: "Service name" }] }, providerContext);
    const created = await provider.create(desired, providerContext); assert.equal(created.status, "SUCCESS"); if (created.status !== "SUCCESS") return; assert.equal(created.model.properties.QueryLanguage, "CWLI"); assert.deepEqual(created.model.properties.Parameters, desired.Parameters);
    const updated = provider.canonicalize({ Name: "CloudFormation/SQL", QueryLanguage: "SQL", QueryString: 'SELECT * FROM `/application/orders` LIMIT 10' }, providerContext); const update = await provider.update(created.physicalId, desired, updated, providerContext); assert.equal(update.status, "SUCCESS");
    const read = await provider.read(created.physicalId, providerContext); assert.equal(read.status, "SUCCESS"); if (read.status === "SUCCESS") { assert.equal(read.model.properties.QueryLanguage, "SQL"); assert.equal(Object.hasOwn(read.model.properties, "Parameters"), false); }
    assert.equal((await provider.delete(created.physicalId, updated, providerContext)).status, "SUCCESS"); assert.equal((await provider.read(created.physicalId, providerContext)).status, "NOT_FOUND");
  } finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
