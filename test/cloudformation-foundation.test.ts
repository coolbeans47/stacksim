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
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  UpdateStackCommand,
  UpdateTerminationProtectionCommand,
  ValidateTemplateCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const template = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "CFN-01 metadata fixture",
  Resources: {
    CDKMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v2:deflate64:test" } },
  },
  Outputs: { Greeting: { Description: "literal output", Value: "hello" } },
});
const updatedTemplate = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "CFN-01 metadata fixture updated",
  Resources: { CDKMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v2:deflate64:updated" } } },
  Outputs: { Greeting: { Description: "literal output", Value: "updated" } },
});

test("CloudFormation official client manages a metadata stack, events, resources, protection, deletion, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn01-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: CloudFormationClient | undefined;
  try {
    await simulator.start(); let endpoint = `http://127.0.0.1:${simulator.port}`; client = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials });
    const validated = await client.send(new ValidateTemplateCommand({ TemplateBody: template })); assert.equal(validated.Description, "CFN-01 metadata fixture");
    const created = await client.send(new CreateStackCommand({ StackName: "metadata-stack", TemplateBody: template, ClientRequestToken: "create-token", EnableTerminationProtection: true, Tags: [{ Key: "environment", Value: "test" }] })); assert.match(created.StackId ?? "", /^arn:aws:cloudformation:eu-west-1:000000000000:stack\/metadata-stack\//);
    assert.equal((await waitUntilStackCreateComplete({ client, maxWaitTime: 5, minDelay: 1, maxDelay: 1 }, { StackName: created.StackId })).state, "SUCCESS");
    const described = (await client.send(new DescribeStacksCommand({ StackName: "metadata-stack" }))).Stacks?.[0]; assert.equal(described?.StackStatus, "CREATE_COMPLETE"); assert.equal(described?.Outputs?.[0]?.OutputValue, "hello"); assert.deepEqual(described?.Tags, [{ Key: "environment", Value: "test" }]);
    const detail = await client.send(new DescribeStackResourceCommand({ StackName: created.StackId!, LogicalResourceId: "CDKMetadata" })); assert.equal(detail.StackResourceDetail?.ResourceType, "AWS::CDK::Metadata"); assert.equal(detail.StackResourceDetail?.ResourceStatus, "CREATE_COMPLETE");
    const resources = await client.send(new ListStackResourcesCommand({ StackName: "metadata-stack" })); assert.deepEqual(resources.StackResourceSummaries?.map(item => item.LogicalResourceId), ["CDKMetadata"]);
    const events = await client.send(new DescribeStackEventsCommand({ StackName: created.StackId })); assert.equal(events.StackEvents?.[0]?.ResourceStatus, "CREATE_COMPLETE"); assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "CDKMetadata" && event.ResourceStatus === "CREATE_COMPLETE"));
    const createEvents = events.StackEvents?.filter(event => event.ClientRequestToken === "create-token") ?? [];
    assert.deepEqual(createEvents.map(event => [event.LogicalResourceId, event.ResourceStatus]), [["metadata-stack", "CREATE_COMPLETE"], ["CDKMetadata", "CREATE_COMPLETE"], ["CDKMetadata", "CREATE_IN_PROGRESS"], ["metadata-stack", "CREATE_IN_PROGRESS"]]);
    assert.equal(new Set(createEvents.map(event => event.OperationId)).size, 1); assert.ok(createEvents.every(event => event.OperationId === created.OperationId));
    assert.equal(JSON.parse(String((await client.send(new GetTemplateCommand({ StackName: created.StackId, TemplateStage: "Processed" }))).TemplateBody)).Description, "CFN-01 metadata fixture");
    assert.ok((await client.send(new ListStacksCommand({}))).StackSummaries?.some(stack => stack.StackName === "metadata-stack"));
    await assert.rejects(client.send(new DeleteStackCommand({ StackName: "metadata-stack" })), (error: any) => error.name === "ValidationError" && /termination protection/i.test(error.message));

    client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`; client = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials });
    assert.equal((await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
    const updated = await client.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: updatedTemplate, ClientRequestToken: "update-token" }));
    assert.equal((await waitUntilStackUpdateComplete({ client, maxWaitTime: 5, minDelay: 1, maxDelay: 1 }, { StackName: created.StackId })).state, "SUCCESS");
    const updateEvents = (await client.send(new DescribeStackEventsCommand({ StackName: created.StackId }))).StackEvents?.filter(event => event.ClientRequestToken === "update-token") ?? [];
    assert.deepEqual(updateEvents.map(event => [event.LogicalResourceId, event.ResourceStatus]), [["metadata-stack", "UPDATE_COMPLETE"], ["CDKMetadata", "UPDATE_COMPLETE"], ["CDKMetadata", "UPDATE_IN_PROGRESS"], ["metadata-stack", "UPDATE_IN_PROGRESS"]]);
    assert.equal(new Set(updateEvents.map(event => event.OperationId)).size, 1); assert.ok(updateEvents.every(event => event.OperationId === updated.OperationId));
    await client.send(new UpdateTerminationProtectionCommand({ StackName: "metadata-stack", EnableTerminationProtection: false })); await client.send(new DeleteStackCommand({ StackName: "metadata-stack", ClientRequestToken: "delete-token" }));
    assert.equal((await waitUntilStackDeleteComplete({ client, maxWaitTime: 5, minDelay: 1, maxDelay: 1 }, { StackName: created.StackId })).state, "SUCCESS");
    const deleteEvents = (await client.send(new DescribeStackEventsCommand({ StackName: created.StackId }))).StackEvents?.filter(event => event.ClientRequestToken === "delete-token") ?? [];
    assert.deepEqual(deleteEvents.map(event => [event.LogicalResourceId, event.ResourceStatus]), [["metadata-stack", "DELETE_COMPLETE"], ["CDKMetadata", "DELETE_COMPLETE"], ["CDKMetadata", "DELETE_IN_PROGRESS"], ["metadata-stack", "DELETE_IN_PROGRESS"]]);
    assert.equal(new Set(deleteEvents.map(event => event.OperationId)).size, 1);
    await assert.rejects(client.send(new DescribeStacksCommand({ StackName: "metadata-stack" })), (error: any) => error.name === "ValidationError");
    assert.equal((await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.StackStatus, "DELETE_COMPLETE");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation Query routing rejects unsupported resources before accepting a stack and honors client tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn01-query-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: CloudFormationClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; client = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials });
    const unsupported = JSON.stringify({ Resources: { Platform: { Type: "AWS::SNS::PlatformApplication" } } }); await assert.rejects(client.send(new CreateStackCommand({ StackName: "unsupported", TemplateBody: unsupported })), (error: any) => error.name === "ValidationError" && /AWS::SNS::PlatformApplication/.test(error.message)); assert.equal((await client.send(new ListStacksCommand({}))).StackSummaries?.length, 0);
    const first = await client.send(new CreateStackCommand({ StackName: "token-stack", TemplateBody: JSON.stringify({ Resources: {} }), ClientRequestToken: "same-token" })); const repeated = await client.send(new CreateStackCommand({ StackName: "token-stack", TemplateBody: JSON.stringify({ Resources: {} }), ClientRequestToken: "same-token" })).catch((error: any) => error);
    assert.ok(repeated.name === "AlreadyExistsException" || repeated.StackId === first.StackId);
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "cloudformation" }, body: new URLSearchParams({ Action: "DescribeStacks", Version: "2010-05-15", StackName: "token-stack" }) }); assert.equal(response.status, 200); assert.match(await response.text(), /<StackName>token-stack<\/StackName>/);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
