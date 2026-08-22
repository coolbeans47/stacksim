import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  ListChangeSetsCommand,
  ListExportsCommand,
  ListImportsCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

function metadataTemplate(analytics: unknown, output: unknown = analytics): string {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: analytics } } },
    Outputs: { Value: { Value: output } },
  });
}

function exportedTemplate(value: string): string {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: value } } },
    Outputs: { Shared: { Value: value, Export: { Name: "SharedValue" } } },
  });
}

function importedTemplate(): string {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: { "Fn::ImportValue": "SharedValue" } } } },
    Outputs: { Imported: { Value: { "Fn::ImportValue": "SharedValue" } } },
  });
}

function agreementTemplate(next: boolean): string {
  return JSON.stringify({
    Parameters: { Release: { Type: "String" } },
    Resources: {
      Group: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: next ? "/cfn05/plan-new" : "/cfn05/plan-old", RetentionInDays: 7 } },
      ParameterMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: { Ref: "Release" } } },
      ResourceMetadata: { Type: "AWS::CDK::Metadata", DependsOn: "Group", Properties: { Analytics: { Ref: "Group" } } },
      DirectMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: next ? "direct-v2" : "direct-v1" } },
      ...(next
        ? { AddedMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "added" } } }
        : { RemovedMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "removed" } } }),
    },
    Outputs: { Release: { Value: { Ref: "Release" } }, GroupName: { Value: { Ref: "Group" } } },
  });
}

function client(simulator: StackSim): CloudFormationClient {
  return new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
}

async function waitForStackStatus(cloudformation: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

test("official SDK change sets plan durably, execute exactly once, and expose stable property details", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-change-sets-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); cloudformation = client(simulator);
    const rejected = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "change-set-stack",
      ChangeSetName: "invalid",
      ChangeSetType: "CREATE",
      TemplateBody: JSON.stringify({ Resources: { Unsupported: { Type: "AWS::Missing::Resource" } } }),
    }));
    const failed = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: rejected.Id }));
    assert.equal(failed.Status, "FAILED"); assert.equal(failed.ExecutionStatus, "UNAVAILABLE");
    assert.match(failed.StatusReason ?? "", /Unrecognized resource type/);
    await cloudformation.send(new DeleteChangeSetCommand({ ChangeSetName: rejected.Id }));
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: rejected.StackId }))).Stacks?.[0]?.StackStatus, "REVIEW_IN_PROGRESS");

    const created = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "change-set-stack",
      ChangeSetName: "initial",
      ChangeSetType: "CREATE",
      ClientToken: "create-plan-token",
      TemplateBody: metadataTemplate("v1"),
    }));
    assert.ok(created.Id); assert.ok(created.StackId);

    const planned = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: created.Id, IncludePropertyValues: true }));
    assert.equal(planned.Status, "CREATE_COMPLETE");
    assert.equal(planned.ExecutionStatus, "AVAILABLE");
    assert.equal(planned.Changes?.[0]?.ResourceChange?.Action, "Add");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.StackStatus, "REVIEW_IN_PROGRESS");
    assert.deepEqual((await cloudformation.send(new ListStackResourcesCommand({ StackName: created.StackId }))).StackResourceSummaries, []);
    assert.match(String((await cloudformation.send(new GetTemplateCommand({ ChangeSetName: created.Id }))).TemplateBody), /\"v1\"/);
    assert.equal((await cloudformation.send(new ListChangeSetsCommand({ StackName: created.StackId }))).Summaries?.[0]?.ChangeSetId, created.Id);

    // A planned change set and its immutable artifacts survive a process restart.
    cloudformation.destroy(); cloudformation = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); cloudformation = client(simulator);

    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: created.Id, ClientRequestToken: "execute-initial" }));
    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: created.Id, ClientRequestToken: "execute-initial" }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: created.Id }))).ExecutionStatus, "EXECUTE_COMPLETE");
    assert.equal((await cloudformation.send(new ListStackResourcesCommand({ StackName: created.StackId }))).StackResourceSummaries?.length, 1);

    const updated = await cloudformation.send(new CreateChangeSetCommand({ StackName: created.StackId, ChangeSetName: "update", ChangeSetType: "UPDATE", TemplateBody: metadataTemplate("v2") }));
    const updatePlan = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: updated.Id, IncludePropertyValues: true }));
    const resourceChange = updatePlan.Changes?.[0]?.ResourceChange;
    assert.equal(resourceChange?.Action, "Modify");
    assert.equal(resourceChange?.LogicalResourceId, "Metadata");
    assert.deepEqual(resourceChange?.Scope, ["Properties"]);
    assert.equal(resourceChange?.Details?.[0]?.Target?.Name, "Analytics");
    assert.equal(resourceChange?.Details?.[0]?.Target?.RequiresRecreation, "Never");
    assert.equal(resourceChange?.Details?.[0]?.Target?.BeforeValue, JSON.stringify("v1"));
    assert.equal(resourceChange?.Details?.[0]?.Target?.AfterValue, JSON.stringify("v2"));
    assert.equal(resourceChange?.Details?.[0]?.Evaluation, "Static");
    assert.equal(resourceChange?.Details?.[0]?.ChangeSource, "DirectModification");
    assert.equal(resourceChange?.Details?.[0]?.CausingEntity, undefined);

    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: updated.Id, ClientRequestToken: "execute-update" }));
    assert.equal((await waitUntilStackUpdateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.Outputs?.[0]?.OutputValue, "v2");

    const noOp = await cloudformation.send(new CreateChangeSetCommand({ StackName: created.StackId, ChangeSetName: "no-op", ChangeSetType: "UPDATE", UsePreviousTemplate: true }));
    const unavailable = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: noOp.Id }));
    assert.equal(unavailable.Status, "FAILED"); assert.equal(unavailable.ExecutionStatus, "UNAVAILABLE"); assert.match(unavailable.StatusReason ?? "", /didn't contain changes/i);
    await cloudformation.send(new DeleteChangeSetCommand({ ChangeSetName: noOp.Id }));
    assert.ok(!(await cloudformation.send(new ListChangeSetsCommand({ StackName: created.StackId }))).Summaries?.some(summary => summary.ChangeSetId === noOp.Id));
  } finally {
    cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("failed change-set provider validation exposes stable structured DescribeEvents diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn17-events-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); cloudformation = client(simulator);
    const planned = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "validation-events-stack",
      ChangeSetName: "invalid-table",
      ChangeSetType: "CREATE",
      TemplateBody: JSON.stringify({
        Parameters: { Secret: { Type: "String", NoEcho: true } },
        Resources: {
          InvalidTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
              KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
              BillingMode: "PAY_PER_REQUEST",
              StackSimInvalidAlpha: { Ref: "Secret" },
              StackSimInvalidBeta: true,
            },
          },
        },
      }),
      Parameters: [{ ParameterKey: "Secret", ParameterValue: "secret-shaped-value" }],
    }));
    const failed = await cloudformation.send(new DescribeChangeSetCommand({ StackName: planned.StackId, ChangeSetName: planned.Id }));
    assert.equal(failed.Status, "FAILED");
    assert.doesNotMatch(failed.StatusReason ?? "", /secret-shaped-value/);
    const first = await cloudformation.send(new DescribeEventsCommand({ StackName: planned.StackId, ChangeSetName: planned.Id, Filters: { FailedEvents: true } }));
    assert.deepEqual(first.OperationEvents?.map(event => event.ValidationPath), [
      "/Resources/InvalidTable/Properties/StackSimInvalidAlpha",
      "/Resources/InvalidTable/Properties/StackSimInvalidBeta",
    ]);
    assert.deepEqual(first.OperationEvents?.map(event => event.ValidationStatusReason), [
      "AWS::DynamoDB::Table does not support property StackSimInvalidAlpha",
      "AWS::DynamoDB::Table does not support property StackSimInvalidBeta",
    ]);
    assert.ok(first.OperationEvents?.every(event => event.EventType === "VALIDATION_ERROR" && event.OperationType === "CREATE_CHANGESET" && event.ValidationFailureMode === "FAIL" && event.ValidationName === "PROPERTY_VALIDATION" && event.ValidationStatus === "FAILED"));
    const stable = first.OperationEvents?.map(event => ({ id: event.EventId, time: event.Timestamp?.getTime(), operation: event.OperationId }));

    cloudformation.destroy(); cloudformation = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" }); await simulator.start(); cloudformation = client(simulator);
    const recovered = await cloudformation.send(new DescribeEventsCommand({ StackName: planned.StackId, ChangeSetName: planned.Id, Filters: { FailedEvents: true } }));
    assert.deepEqual(recovered.OperationEvents?.map(event => ({ id: event.EventId, time: event.Timestamp?.getTime(), operation: event.OperationId })), stable);
    await assert.rejects(cloudformation.send(new DescribeEventsCommand({ StackName: planned.StackId, ChangeSetName: planned.Id, Filters: { FailedEvents: false } })), (error: any) => error.name === "ValidationError");

    const invalidProperties = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`StackSimInvalid${String(index).padStart(3, "0")}`, true]));
    const paged = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "validation-events-stack", ChangeSetName: "invalid-table-paged", ChangeSetType: "CREATE",
      TemplateBody: JSON.stringify({ Resources: { InvalidTable: { Type: "AWS::DynamoDB::Table", Properties: { AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST", ...invalidProperties } } } }),
    }));
    const pageOne = await cloudformation.send(new DescribeEventsCommand({ StackName: planned.StackId, ChangeSetName: paged.Id, Filters: { FailedEvents: true } }));
    assert.equal(pageOne.OperationEvents?.length, 100); assert.ok(pageOne.NextToken);
    const pageTwo = await cloudformation.send(new DescribeEventsCommand({ StackName: planned.StackId, ChangeSetName: paged.Id, Filters: { FailedEvents: true }, NextToken: pageOne.NextToken }));
    assert.equal(pageTwo.OperationEvents?.length, 1); assert.equal(pageTwo.NextToken, undefined);
    assert.equal(pageOne.OperationEvents?.[0].ValidationPath, "/Resources/InvalidTable/Properties/StackSimInvalid000");
    assert.equal(pageTwo.OperationEvents?.[0].ValidationPath, "/Resources/InvalidTable/Properties/StackSimInvalid100");
    const tamperedToken = `${pageOne.NextToken!.slice(0, -1)}${pageOne.NextToken!.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(cloudformation.send(new DescribeEventsCommand({ StackName: planned.StackId, ChangeSetName: paged.Id, Filters: { FailedEvents: true }, NextToken: tamperedToken })), (error: any) => error.name === "ValidationError");
  } finally {
    cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("a failed and deleted root CREATE change set leaves an explicit-review placeholder until DeleteStack", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-review-delete-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); cloudformation = client(simulator);
    const failed = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "review-placeholder-delete",
      ChangeSetName: "invalid-root-create",
      ChangeSetType: "CREATE",
      ClientToken: "invalid-root-create-token",
      TemplateBody: JSON.stringify({ Resources: { Unsupported: { Type: "AWS::Missing::Resource" } } }),
    }));
    const failure = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: failed.Id }));
    assert.equal(failure.Status, "FAILED"); assert.equal(failure.ExecutionStatus, "UNAVAILABLE");
    await cloudformation.send(new DeleteChangeSetCommand({ ChangeSetName: failed.Id }));
    await assert.rejects(cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: failed.Id })), (error: any) => error.name === "ChangeSetNotFoundException");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: failed.StackId }))).Stacks?.[0]?.StackStatus, "REVIEW_IN_PROGRESS", "DeleteChangeSet must not silently delete a root review stack");

    await cloudformation.send(new DeleteStackCommand({ StackName: failed.StackId, ClientRequestToken: "delete-root-review-token" }));
    assert.equal((await waitUntilStackDeleteComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: failed.StackId })).state, "SUCCESS");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: failed.StackId }))).Stacks?.[0]?.StackStatus, "DELETE_COMPLETE");
    await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "review-placeholder-delete" })), (error: any) => error.name === "ValidationError");

    const replacement = await cloudformation.send(new CreateChangeSetCommand({ StackName: "review-placeholder-delete", ChangeSetName: "valid-after-delete", ChangeSetType: "CREATE", TemplateBody: metadataTemplate("replacement") }));
    assert.notEqual(replacement.StackId, failed.StackId, "reusing a deleted review-stack name must allocate a new stack identity");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: replacement.StackId }))).Stacks?.[0]?.StackStatus, "REVIEW_IN_PROGRESS");
    await cloudformation.send(new DeleteChangeSetCommand({ ChangeSetName: replacement.Id })); await cloudformation.send(new DeleteStackCommand({ StackName: replacement.StackId }));
    assert.equal((await waitUntilStackDeleteComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: replacement.StackId })).state, "SUCCESS");
  } finally { cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("change-set causality and add/modify/replace/remove plans agree with execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-plan-agreement-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = client(simulator);
    logs = new CloudWatchLogsClient({ endpoint, region, credentials, maxAttempts: 1 });
    const created = await cloudformation.send(new CreateStackCommand({
      StackName: "plan-agreement",
      TemplateBody: agreementTemplate(false),
      Parameters: [{ ParameterKey: "Release", ParameterValue: "v1" }],
    }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");

    const planned = await cloudformation.send(new CreateChangeSetCommand({
      StackName: created.StackId,
      ChangeSetName: "all-actions",
      ChangeSetType: "UPDATE",
      TemplateBody: agreementTemplate(true),
      Parameters: [{ ParameterKey: "Release", ParameterValue: "v2" }],
    }));
    const described = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id, IncludePropertyValues: true }));
    assert.equal(described.Status, "CREATE_COMPLETE");
    const changes = new Map((described.Changes ?? []).map(change => [change.ResourceChange?.LogicalResourceId, change.ResourceChange]));
    assert.equal(changes.get("AddedMetadata")?.Action, "Add");
    assert.equal(changes.get("RemovedMetadata")?.Action, "Remove");
    assert.equal(changes.get("DirectMetadata")?.Action, "Modify");
    assert.equal(changes.get("Group")?.Action, "Modify");
    assert.equal(changes.get("Group")?.Replacement, "True");
    assert.equal(changes.get("Group")?.Details?.find(detail => detail.Target?.Name === "LogGroupName")?.Target?.RequiresRecreation, "Always");

    const parameterDetail = changes.get("ParameterMetadata")?.Details?.find(detail => detail.Target?.Name === "Analytics");
    assert.equal(parameterDetail?.Evaluation, "Static");
    assert.equal(parameterDetail?.ChangeSource, "ParameterReference");
    assert.equal(parameterDetail?.CausingEntity, "Release");
    assert.equal(parameterDetail?.Target?.BeforeValue, JSON.stringify("v1"));
    assert.equal(parameterDetail?.Target?.AfterValue, JSON.stringify("v2"));

    const resourceDetail = changes.get("ResourceMetadata")?.Details?.find(detail => detail.Target?.Name === "Analytics");
    assert.equal(resourceDetail?.Evaluation, "Dynamic");
    assert.equal(resourceDetail?.ChangeSource, "ResourceReference");
    assert.equal(resourceDetail?.CausingEntity, "Group");
    assert.equal(resourceDetail?.Target?.BeforeValue, JSON.stringify("/cfn05/plan-old"));
    assert.equal(resourceDetail?.Target?.AfterValue, undefined, "dynamic replacement references omit an after value until execution resolves the new physical ID");

    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id, ClientRequestToken: "execute-all-actions" }));
    assert.equal((await waitUntilStackUpdateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    const resources = (await cloudformation.send(new ListStackResourcesCommand({ StackName: created.StackId }))).StackResourceSummaries ?? [];
    assert.ok(resources.some(resource => resource.LogicalResourceId === "AddedMetadata"));
    assert.ok(!resources.some(resource => resource.LogicalResourceId === "RemovedMetadata"));
    assert.equal(resources.find(resource => resource.LogicalResourceId === "Group")?.PhysicalResourceId, "/cfn05/plan-new");
    const groups = (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/cfn05/plan" }))).logGroups?.map(group => group.logGroupName);
    assert.deepEqual(groups, ["/cfn05/plan-new"], "executed replacement must remove the old physical resource exactly as planned");
    const outputs = Object.fromEntries(((await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
    assert.deepEqual(outputs, { GroupName: "/cfn05/plan-new", Release: "v2" });
  } finally {
    logs?.destroy(); cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("ExecuteChangeSet defaults to rollback for failed CREATE and UPDATE operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-change-set-rollback-default-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); cloudformation = client(simulator);

    const failedCreate = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "failed-create-change-set",
      ChangeSetName: "create",
      ChangeSetType: "CREATE",
      TemplateBody: metadataTemplate("bad-create", ["not", "scalar"]),
    }));
    assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: failedCreate.Id }))).Status, "CREATE_COMPLETE");
    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: failedCreate.Id }));
    await waitForStackStatus(cloudformation, failedCreate.StackId!, "ROLLBACK_COMPLETE");

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "failed-update-change-set", TemplateBody: metadataTemplate("v1") }));
    await waitForStackStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const failedUpdate = await cloudformation.send(new CreateChangeSetCommand({
      StackName: created.StackId,
      ChangeSetName: "update",
      ChangeSetType: "UPDATE",
      TemplateBody: metadataTemplate("v2", ["not", "scalar"]),
    }));
    assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: failedUpdate.Id }))).Status, "CREATE_COMPLETE");
    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: failedUpdate.Id }));
    await waitForStackStatus(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.Outputs?.[0]?.OutputValue, "v1");
  } finally {
    cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("change-set planning rejects provider-invalid models before any backing service mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-provider-preflight-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = client(simulator);
    lambda = new LambdaClient({ endpoint, region, credentials, maxAttempts: 1 });
    const planned = await cloudformation.send(new CreateChangeSetCommand({
      StackName: "provider-preflight",
      ChangeSetName: "invalid-runtime",
      ChangeSetType: "CREATE",
      TemplateBody: JSON.stringify({ Resources: {
        Function: { Type: "AWS::Lambda::Function", Properties: {
          Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200 });" },
          Handler: "index.handler",
          Role: "arn:aws:iam::000000000000:role/example",
          Runtime: "python3.13",
        } },
      } }),
    }));
    const result = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(result.Status, "FAILED");
    assert.equal(result.ExecutionStatus, "UNAVAILABLE");
    assert.match(result.StatusReason ?? "", /Runtime|nodejs18\.x/i);
    assert.deepEqual((await lambda.send(new ListFunctionsCommand({}))).Functions, []);
  } finally {
    lambda?.destroy(); cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("ExecuteChangeSet rejects an immutable plan when an imported export changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-import-plan-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); cloudformation = client(simulator);
    await cloudformation.send(new CreateStackCommand({ StackName: "plan-exporter", TemplateBody: exportedTemplate("v1") }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "plan-exporter" })).state, "SUCCESS");
    const planned = await cloudformation.send(new CreateChangeSetCommand({ StackName: "planned-importer", ChangeSetName: "initial", ChangeSetType: "CREATE", TemplateBody: importedTemplate() }));
    assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }))).ExecutionStatus, "AVAILABLE");

    await cloudformation.send(new UpdateStackCommand({ StackName: "plan-exporter", TemplateBody: exportedTemplate("v2") }));
    assert.equal((await waitUntilStackUpdateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "plan-exporter" })).state, "SUCCESS");
    await assert.rejects(
      cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id })),
      (error: any) => /^InvalidChangeSetStatus/.test(error.name) && /Imported value SharedValue changed/.test(error.message),
    );
    const obsolete = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(obsolete.ExecutionStatus, "OBSOLETE");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: planned.StackId }))).Stacks?.[0]?.StackStatus, "REVIEW_IN_PROGRESS");
    assert.deepEqual((await cloudformation.send(new ListStackResourcesCommand({ StackName: planned.StackId }))).StackResourceSummaries, []);
  } finally {
    cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("exports and Fn::ImportValue are durable and protect active cross-stack dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn05-exports-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); cloudformation = client(simulator);
    await cloudformation.send(new CreateStackCommand({ StackName: "exporter", TemplateBody: exportedTemplate("v1") }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "exporter" })).state, "SUCCESS");
    assert.deepEqual((await cloudformation.send(new ListExportsCommand({}))).Exports?.map(value => [value.Name, value.Value]), [["SharedValue", "v1"]]);

    await cloudformation.send(new CreateStackCommand({ StackName: "importer", TemplateBody: importedTemplate() }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "importer" })).state, "SUCCESS");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "importer" }))).Stacks?.[0]?.Outputs?.[0]?.OutputValue, "v1");

    cloudformation.destroy(); cloudformation = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); cloudformation = client(simulator);
    assert.deepEqual((await cloudformation.send(new ListImportsCommand({ ExportName: "SharedValue" }))).Imports, ["importer"]);

    await assert.rejects(cloudformation.send(new DeleteStackCommand({ StackName: "exporter" })), (error: any) => error.name === "ValidationError" && /in use by importer/.test(error.message));
    await cloudformation.send(new UpdateStackCommand({ StackName: "exporter", TemplateBody: exportedTemplate("v2") }));
    await assert.rejects(waitUntilStackUpdateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "exporter" }), /"state":"FAILURE"/);
    assert.equal((await cloudformation.send(new ListExportsCommand({}))).Exports?.[0]?.Value, "v1");

    await cloudformation.send(new DeleteStackCommand({ StackName: "importer" }));
    assert.equal((await waitUntilStackDeleteComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "importer" })).state, "SUCCESS");
    assert.deepEqual((await cloudformation.send(new ListImportsCommand({ ExportName: "SharedValue" }))).Imports, []);
    await cloudformation.send(new UpdateStackCommand({ StackName: "exporter", TemplateBody: exportedTemplate("v2") }));
    assert.equal((await waitUntilStackUpdateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: "exporter" })).state, "SUCCESS");
    assert.equal((await cloudformation.send(new ListExportsCommand({}))).Exports?.[0]?.Value, "v2");
  } finally {
    cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
