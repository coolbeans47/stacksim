import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, DescribeLogGroupsCommand, ListTagsForResourceCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { createLogGroupProvider } from "../src/cloudformation/providers/logs-log-group.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1"; const accountId = "000000000000"; const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
function context(): ProviderContext { return { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/logs/stack-id`, logicalId: "ApplicationLogs", operationId: "operation", resourceOperationId: "resource-operation", idempotencyKey: "key", deadlineAt: Date.now() + 60_000, principal: { identity } }; }

test("Log group provider creates, updates, reads, and deletes the real Logs resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-log-provider-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"}); let client: CloudWatchLogsClient | undefined;
  try {
    await simulator.start(); client = new CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); const provider = createLogGroupProvider(simulator.logs);
    const initial = provider.canonicalize({ LogGroupName: "/application/orders", RetentionInDays: 7, Tags: [{ Key: "service", Value: "orders" }] }, context()); const created = await provider.create(initial, context()); assert.equal(created.status, "SUCCESS"); assert.equal(provider.ref((created as any).model), "/application/orders"); assert.match(String(provider.getAtt((created as any).model, "Arn")), /:log-group:\/application\/orders:\*$/);
    const direct = (await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/application/orders" }))).logGroups![0]; assert.equal(direct.retentionInDays, 7); const directTags = await client.send(new ListTagsForResourceCommand({ resourceArn: direct.arn })); assert.equal(directTags.tags?.service, "orders"); assert.equal(directTags.tags?.["aws:cloudformation:logical-id"], "ApplicationLogs");
    const desired = provider.canonicalize({ LogGroupName: "/application/orders", RetentionInDays: 30, Tags: [{ Key: "service", Value: "checkout" }] }, context()); assert.equal(provider.plan(initial, desired, context()).action, "UPDATE"); assert.equal((await provider.update(initial.LogGroupName, initial, desired, context())).status, "SUCCESS"); assert.equal(((await provider.read(initial.LogGroupName, context())) as any).model.properties.RetentionInDays, 30);
    await client.send(new DeleteLogGroupCommand({ logGroupName: initial.LogGroupName })); await client.send(new CreateLogGroupCommand({ logGroupName: initial.LogGroupName, tags: { owner: "foreign" } }));
    const foreignRead = await provider.read(initial.LogGroupName, context()); assert.equal(foreignRead.status, "FAILED"); assert.equal((foreignRead as any).errorCode, "OwnershipConflict");
    const foreignUpdate = await provider.update(initial.LogGroupName, desired, initial, context()); assert.equal(foreignUpdate.status, "FAILED"); assert.equal((foreignUpdate as any).errorCode, "OwnershipConflict");
    const foreignDelete = await provider.delete(initial.LogGroupName, desired, context()); assert.equal(foreignDelete.status, "FAILED"); assert.equal((foreignDelete as any).errorCode, "OwnershipConflict");
    assert.ok((await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: initial.LogGroupName }))).logGroups?.some(group => group.logGroupName === initial.LogGroupName));
    await client.send(new DeleteLogGroupCommand({ logGroupName: initial.LogGroupName })); assert.equal((await provider.delete(initial.LogGroupName, desired, context())).status, "NOT_FOUND");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Log group provider rejects KMS and log-class dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-log-boundary-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  try { await simulator.start(); const issues = createLogGroupProvider(simulator.logs).validate({ LogGroupName: "/application/orders", KmsKeyId: "arn:aws:kms:eu-west-1:000000000000:key/example", LogGroupClass: "INFREQUENT_ACCESS" }, context()); assert.ok(issues.some(issue => issue.path === "Properties.KmsKeyId")); assert.ok(issues.some(issue => issue.path === "Properties.LogGroupClass")); }
  finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
