import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../src/server.js";
import { waitUntil } from "./support/polling.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function jsonRequest<T>(url: string, method = "GET", body?: unknown): Promise<{ response: Response; value: T }> {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, value: await response.json() as T };
}

async function waitForStack(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  await waitUntil(
    async () => (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0],
    stack => stack?.StackStatus === expected,
    { timeoutMessage: stack => `Timed out waiting for ${stackName} to reach ${expected}; current=${stack?.StackStatus} reason=${stack?.StackStatusReason}` },
  );
}

function metadataTemplate(value: string, exportName?: string): string {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: value } } },
    ...(exportName ? { Outputs: { Shared: { Value: value, Export: { Name: exportName } } } } : {}),
  });
}

function replacementTemplate(groupName: string, analytics: string): string {
  return JSON.stringify({
    Resources: {
      Group: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: groupName, RetentionInDays: 7 } },
      Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: analytics } },
    },
  });
}

function protectedTableTemplate(tableName: string): string {
  return JSON.stringify({
    Resources: {
      ProtectedTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          DeletionProtectionEnabled: true,
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        },
      },
    },
  });
}

test("local lifecycle console APIs drive updates, operation filters, change sets, relationships, and failed-delete retries", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-console-lifecycle-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  let dynamodb: DynamoDBClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    dynamodb = new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 });

    const exporter = await cloudformation.send(new CreateStackCommand({ StackName: "console-exporter", TemplateBody: metadataTemplate("shared-v1", "ConsoleSharedValue") }));
    await waitForStack(cloudformation, exporter.StackId!, "CREATE_COMPLETE");
    const importer = await cloudformation.send(new CreateStackCommand({
      StackName: "console-importer",
      TemplateBody: JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: { "Fn::ImportValue": "ConsoleSharedValue" } } } } }),
    }));
    await waitForStack(cloudformation, importer.StackId!, "CREATE_COMPLETE");

    const exports = await jsonRequest<{ exports: Array<{ name: string; value: string; exportingStackName: string; imports: string[] }> }>(`${endpoint}/_stacksim/api/cloudformation/exports`);
    assert.equal(exports.response.status, 200);
    assert.deepEqual(exports.value.exports, [{ name: "ConsoleSharedValue", value: "shared-v1", exportingStackId: exporter.StackId, exportingStackName: "console-exporter", imports: ["console-importer"] }]);
    const exportDetail = await jsonRequest<{ export: { name: string; imports: string[] } }>(`${endpoint}/_stacksim/api/cloudformation/exports/ConsoleSharedValue`);
    assert.equal(exportDetail.value.export.name, "ConsoleSharedValue");
    assert.deepEqual(exportDetail.value.export.imports, ["console-importer"]);

    const lifecycle = await cloudformation.send(new CreateStackCommand({ StackName: "console-lifecycle", TemplateBody: replacementTemplate("/stacksim/console-old", "v1") }));
    await waitForStack(cloudformation, lifecycle.StackId!, "CREATE_COMPLETE");
    const updated = await jsonRequest<{ stackId: string; operationId: string }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-lifecycle`, "PUT", { templateBody: replacementTemplate("/stacksim/console-old", "v2") });
    assert.equal(updated.response.status, 200);
    assert.match(updated.value.operationId, /^[0-9a-f-]{36}$/);
    await waitForStack(cloudformation, lifecycle.StackId!, "UPDATE_COMPLETE");

    const events = await jsonRequest<{ events: Array<{ operationId?: string }>; operationIds: string[] }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-lifecycle/events`);
    assert.ok(events.value.operationIds.includes(updated.value.operationId));
    assert.ok(events.value.operationIds.length >= 2);
    const filtered = await jsonRequest<{ events: Array<{ operationId?: string }>; operationId: string; operationIds: string[] }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-lifecycle/events?operationId=${encodeURIComponent(updated.value.operationId)}`);
    assert.equal(filtered.value.operationId, updated.value.operationId);
    assert.ok(filtered.value.events.length > 0);
    assert.ok(filtered.value.events.every(event => event.operationId === updated.value.operationId));
    assert.deepEqual(filtered.value.operationIds, events.value.operationIds);

    const planned = await jsonRequest<{ changeSetName: string; changeSetId: string }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-lifecycle/change-sets`, "POST", {
      changeSetName: "replace-group",
      changeSetType: "UPDATE",
      description: "Review a physical log-group replacement",
      templateBody: replacementTemplate("/stacksim/console-new", "v3"),
    });
    assert.equal(planned.response.status, 201);
    assert.equal(planned.value.changeSetName, "replace-group");
    const described = await jsonRequest<{ changeSet: { ChangeSetType: string; Changes: Array<{ ResourceChange: { LogicalResourceId: string; Replacement: string; PolicyAction?: string; Details: Array<{ Target: { RequiresRecreation: string } }> } }> } }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-lifecycle/change-sets/replace-group`);
    assert.equal(described.value.changeSet.ChangeSetType, "UPDATE");
    const replacement = described.value.changeSet.Changes.map(change => change.ResourceChange).find(change => change.LogicalResourceId === "Group");
    assert.equal(replacement?.Replacement, "True");
    assert.equal(replacement?.PolicyAction, "ReplaceAndDelete");
    assert.ok(replacement?.Details.some(detail => detail.Target.RequiresRecreation === "Always"));

    const createPlan = await jsonRequest<{ changeSetName: string }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-created-by-plan/change-sets`, "POST", {
      changeSetName: "initial-create",
      changeSetType: "CREATE",
      templateBody: metadataTemplate("create-plan"),
      onStackFailure: "ROLLBACK",
    });
    assert.equal(createPlan.response.status, 201);
    const createDescription = await jsonRequest<{ changeSet: { ChangeSetType: string; Status: string } }>(`${endpoint}/_stacksim/api/cloudformation/stacks/console-created-by-plan/change-sets/initial-create`);
    assert.equal(createDescription.value.changeSet.ChangeSetType, "CREATE");
    assert.equal(createDescription.value.changeSet.Status, "CREATE_COMPLETE");

    const retained = await cloudformation.send(new CreateStackCommand({ StackName: "console-delete-retain", TemplateBody: protectedTableTemplate("console-delete-retain-table") }));
    const forced = await cloudformation.send(new CreateStackCommand({ StackName: "console-delete-force", TemplateBody: protectedTableTemplate("console-delete-force-table") }));
    await waitForStack(cloudformation, retained.StackId!, "CREATE_COMPLETE");
    await waitForStack(cloudformation, forced.StackId!, "CREATE_COMPLETE");
    assert.equal((await jsonRequest(`${endpoint}/_stacksim/api/cloudformation/stacks/console-delete-retain`, "DELETE", {})).response.status, 200);
    assert.equal((await jsonRequest(`${endpoint}/_stacksim/api/cloudformation/stacks/console-delete-force`, "DELETE", {})).response.status, 200);
    await waitForStack(cloudformation, retained.StackId!, "DELETE_FAILED");
    await waitForStack(cloudformation, forced.StackId!, "DELETE_FAILED");

    const retainedRetry = await jsonRequest(`${endpoint}/_stacksim/api/cloudformation/stacks/console-delete-retain`, "DELETE", { deletionMode: "STANDARD", retainResources: ["ProtectedTable"] });
    assert.equal(retainedRetry.response.status, 200);
    const forcedRetry = await jsonRequest(`${endpoint}/_stacksim/api/cloudformation/stacks/console-delete-force`, "DELETE", { deletionMode: "FORCE_DELETE_STACK", retainResources: [] });
    assert.equal(forcedRetry.response.status, 200);
    await waitForStack(cloudformation, retained.StackId!, "DELETE_COMPLETE");
    await waitForStack(cloudformation, forced.StackId!, "DELETE_COMPLETE");
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: "console-delete-retain-table" }))).Table?.DeletionProtectionEnabled, true);
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: "console-delete-force-table" }))).Table?.DeletionProtectionEnabled, true);
  } finally {
    dynamodb?.destroy();
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
