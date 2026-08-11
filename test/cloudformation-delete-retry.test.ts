import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

async function waitForStack(client: CloudFormationClient, stackId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = (await client.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackId} to reach ${expected}`);
}

async function waitForTable(client: DynamoDBClient, tableName: string, expected: "ACTIVE" | "MISSING"): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const table = (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table;
      if (expected === "ACTIVE" && table?.TableStatus === "ACTIVE") return;
    } catch (error) {
      if (expected === "MISSING" && (error as { name?: string }).name === "ResourceNotFoundException") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for DynamoDB table ${tableName} to become ${expected}`);
}

function protectedTableTemplate(tableName: string): string {
  return JSON.stringify({
    Resources: {
      ProtectedTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: tableName,
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          BillingMode: "PAY_PER_REQUEST",
          DeletionProtectionEnabled: true,
        },
      },
    },
  });
}

test("production-provider DELETE_FAILED survives restart and retries by retention or after fixing the service conflict", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn03-delete-retry-"));
  const options = { port: 0, invokePort: 0, dataDir: root, region, authMode: "off" as const };
  let simulator = new StackSim(options);
  let cloudformation: CloudFormationClient | undefined; let dynamodb: DynamoDBClient | undefined;
  const connect = () => {
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    dynamodb = new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 });
  };
  try {
    await simulator.start(); connect();
    const retained = await cloudformation!.send(new CreateStackCommand({ StackName: "delete-retry-retained", TemplateBody: protectedTableTemplate("cfn-delete-retry-retained") }));
    const repaired = await cloudformation!.send(new CreateStackCommand({ StackName: "delete-retry-repaired", TemplateBody: protectedTableTemplate("cfn-delete-retry-repaired") }));
    await waitForStack(cloudformation!, retained.StackId!, "CREATE_COMPLETE"); await waitForStack(cloudformation!, repaired.StackId!, "CREATE_COMPLETE");

    await cloudformation!.send(new DeleteStackCommand({ StackName: retained.StackId, ClientRequestToken: "delete-retained-first" }));
    await cloudformation!.send(new DeleteStackCommand({ StackName: repaired.StackId, ClientRequestToken: "delete-repaired-first" }));
    await waitForStack(cloudformation!, retained.StackId!, "DELETE_FAILED"); await waitForStack(cloudformation!, repaired.StackId!, "DELETE_FAILED");
    const retainedBeforeRestart = await cloudformation!.send(new DescribeStackEventsCommand({ StackName: retained.StackId }));
    const retainedFailureIds = retainedBeforeRestart.StackEvents?.filter(event => event.ResourceStatus === "DELETE_FAILED").map(event => event.EventId) ?? [];
    assert.equal(retainedFailureIds.length, 2, "both the table and stack need durable DELETE_FAILED events");
    assert.ok(retainedBeforeRestart.StackEvents?.some(event => event.LogicalResourceId === "ProtectedTable" && /deletion protection/i.test(event.ResourceStatusReason ?? "")));
    assert.equal((await dynamodb!.send(new DescribeTableCommand({ TableName: "cfn-delete-retry-retained" }))).Table?.DeletionProtectionEnabled, true);

    cloudformation!.destroy(); dynamodb!.destroy(); cloudformation = undefined; dynamodb = undefined; await simulator.stop();
    simulator = new StackSim(options); await simulator.start(); connect();

    const afterRestart = (await cloudformation!.send(new DescribeStacksCommand({ StackName: retained.StackId }))).Stacks?.[0];
    assert.equal(afterRestart?.StackStatus, "DELETE_FAILED"); assert.match(afterRestart?.StackStatusReason ?? "", /deletion protection/i);
    const restartedEvents = await cloudformation!.send(new DescribeStackEventsCommand({ StackName: retained.StackId }));
    const restartedIds = new Set(restartedEvents.StackEvents?.map(event => event.EventId));
    assert.ok(retainedFailureIds.every(eventId => eventId !== undefined && restartedIds.has(eventId)), "restart must retain the original failure events");

    await cloudformation!.send(new DeleteStackCommand({ StackName: retained.StackId, RetainResources: ["ProtectedTable"], ClientRequestToken: "delete-retained-retry" }));
    await waitForStack(cloudformation!, retained.StackId!, "DELETE_COMPLETE");
    const retainedResources = await cloudformation!.send(new DescribeStackResourcesCommand({ StackName: retained.StackId }));
    assert.equal(retainedResources.StackResources?.find(resource => resource.LogicalResourceId === "ProtectedTable")?.ResourceStatus, "DELETE_SKIPPED");
    const retainedEvents = await cloudformation!.send(new DescribeStackEventsCommand({ StackName: retained.StackId }));
    assert.ok(retainedEvents.StackEvents?.some(event => event.LogicalResourceId === "ProtectedTable" && event.ResourceStatus === "DELETE_SKIPPED"));
    assert.ok(retainedEvents.StackEvents?.some(event => event.LogicalResourceId === "delete-retry-retained" && event.ResourceStatus === "DELETE_COMPLETE"));
    assert.equal((await dynamodb!.send(new DescribeTableCommand({ TableName: "cfn-delete-retry-retained" }))).Table?.DeletionProtectionEnabled, true, "RetainResources must leave the authoritative table untouched");

    await dynamodb!.send(new UpdateTableCommand({ TableName: "cfn-delete-retry-repaired", DeletionProtectionEnabled: false }));
    await waitForTable(dynamodb!, "cfn-delete-retry-repaired", "ACTIVE");
    await cloudformation!.send(new DeleteStackCommand({ StackName: repaired.StackId, ClientRequestToken: "delete-repaired-retry" }));
    await waitForStack(cloudformation!, repaired.StackId!, "DELETE_COMPLETE"); await waitForTable(dynamodb!, "cfn-delete-retry-repaired", "MISSING");
    const repairedEvents = await cloudformation!.send(new DescribeStackEventsCommand({ StackName: repaired.StackId }));
    assert.ok(repairedEvents.StackEvents?.some(event => event.LogicalResourceId === "ProtectedTable" && event.ResourceStatus === "DELETE_FAILED" && /deletion protection/i.test(event.ResourceStatusReason ?? "")));
    assert.ok(repairedEvents.StackEvents?.some(event => event.LogicalResourceId === "ProtectedTable" && event.ResourceStatus === "DELETE_COMPLETE"));
    assert.ok(repairedEvents.StackEvents?.some(event => event.LogicalResourceId === "delete-retry-repaired" && event.ResourceStatus === "DELETE_COMPLETE"));
  } finally {
    cloudformation?.destroy(); dynamodb?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
