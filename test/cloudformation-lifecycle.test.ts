import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, GetTemplateCommand, RollbackStackCommand, UpdateStackCommand, waitUntilStackCreateComplete, waitUntilStackUpdateComplete } from "@aws-sdk/client-cloudformation";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const template = (analytics: string, output: unknown = analytics) => JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: analytics } } }, Outputs: { Value: { Value: output } } });

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<void> { for (let attempt = 0; attempt < 50; attempt += 1) { if ((await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus === expected) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for ${expected}`); }

test("direct UpdateStack updates metadata, rejects no-ops, and restores the prior template on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn03-update-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: CloudFormationClient | undefined;
  try {
    await simulator.start(); client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); const created = await client.send(new CreateStackCommand({ StackName: "update-stack", TemplateBody: template("v1") })); assert.equal((await waitUntilStackCreateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    await client.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("v2") })); assert.equal((await waitUntilStackUpdateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS"); assert.equal((await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.Outputs?.[0]?.OutputValue, "v2");
    await assert.rejects(client.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("v2") })), (error: any) => error.name === "ValidationError" && /No updates/.test(error.message));
    await client.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("v3", ["not", "scalar"]) })); await assert.rejects(waitUntilStackUpdateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId }), /"state":"FAILURE"/); const rolledBack = (await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]; assert.equal(rolledBack?.StackStatus, "UPDATE_ROLLBACK_COMPLETE"); assert.equal(rolledBack?.Outputs?.[0]?.OutputValue, "v2"); assert.match(String((await client.send(new GetTemplateCommand({ StackName: created.StackId }))).TemplateBody), /"v2"/);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("create failures roll back completed providers, while DisableRollback can be resumed explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn03-rollback-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: CloudFormationClient | undefined;
  try {
    await simulator.start(); client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); const automatic = await client.send(new CreateStackCommand({ StackName: "auto-rollback", TemplateBody: template("bad", ["not", "scalar"]) })); await assert.rejects(waitUntilStackCreateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: automatic.StackId }), /"state":"FAILURE"/); assert.equal((await client.send(new DescribeStacksCommand({ StackName: automatic.StackId }))).Stacks?.[0]?.StackStatus, "ROLLBACK_COMPLETE");
    const manual = await client.send(new CreateStackCommand({ StackName: "manual-rollback", TemplateBody: template("bad", ["not", "scalar"]), DisableRollback: true })); await assert.rejects(waitUntilStackCreateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: manual.StackId }), /"state":"FAILURE"/); assert.equal((await client.send(new DescribeStacksCommand({ StackName: manual.StackId }))).Stacks?.[0]?.StackStatus, "CREATE_FAILED"); await client.send(new RollbackStackCommand({ StackName: manual.StackId })); await waitForStatus(client, manual.StackId!, "ROLLBACK_COMPLETE");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
