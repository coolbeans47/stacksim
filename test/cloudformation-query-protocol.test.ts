import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as cloudFormationSdk from "@aws-sdk/client-cloudformation";
import {
  CancelUpdateStackCommand,
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DescribeStacksCommand,
  ListStacksCommand,
  UpdateStackCommand,
  paginateDescribeStackEvents,
  paginateDescribeStacks,
  paginateListChangeSets,
  paginateListExports,
  paginateListImports,
  paginateListStackResources,
  paginateListStacks,
} from "@aws-sdk/client-cloudformation";
import { CLOUDFORMATION_SUPPORTED_ACTIONS } from "../src/cloudformation.js";
import { CLOUDFORMATION_ACTION_INVENTORY, CLOUDFORMATION_ACTION_INVENTORY_SOURCE } from "../src/cloudformation/action-inventory.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const emptyTemplate = JSON.stringify({ Resources: {} });

interface RawQueryResponse {
  status: number;
  text: string;
  requestId: string | null;
  alternateRequestId: string | null;
}

async function query(endpoint: string, input: Record<string, string>, explicitService = true): Promise<RawQueryResponse> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (explicitService) headers["x-stacksim-service"] = "cloudformation";
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams({ Version: "2010-05-15", ...input }),
  });
  return {
    status: response.status,
    text: await response.text(),
    requestId: response.headers.get("x-amzn-requestid"),
    alternateRequestId: response.headers.get("x-amz-request-id"),
  };
}

function xmlValue(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]
    ?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function xmlSection(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
}

function members(xml: string, section: string): number {
  return [...xmlSection(xml, section).matchAll(/<member>/g)].length;
}

function assertRequestId(response: RawQueryResponse): void {
  assert.match(response.requestId ?? "", /^[0-9a-f-]{16,}$/i);
  assert.equal(response.alternateRequestId, response.requestId);
  assert.equal(xmlValue(response.text, "RequestId"), response.requestId);
}

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string, attempts = 3_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

test("CloudFormation action inventory exactly matches the pinned SDK and routed Query surface", () => {
  const sdkActions = Object.keys(cloudFormationSdk).filter(name => /^[A-Z][A-Za-z0-9]+Command$/.test(name)).map(name => name.slice(0, -"Command".length)).sort();
  const inventoryActions = CLOUDFORMATION_ACTION_INVENTORY.map(entry => entry.action).sort();
  const routedActions = [...CLOUDFORMATION_SUPPORTED_ACTIONS].sort();
  const implementedActions = CLOUDFORMATION_ACTION_INVENTORY.filter(entry => entry.classification === "implemented").map(entry => entry.action).sort();

  assert.equal(CLOUDFORMATION_ACTION_INVENTORY_SOURCE.sdkVersion, "3.1079.0");
  assert.equal(CLOUDFORMATION_ACTION_INVENTORY_SOURCE.apiVersion, "2010-05-15");
  assert.equal(CLOUDFORMATION_ACTION_INVENTORY.length, 90, "the compatibility inventory must assign every pinned SDK command exactly once");
  assert.equal(new Set(inventoryActions).size, inventoryActions.length, "the compatibility inventory contains a duplicate action");
  assert.deepEqual(inventoryActions, sdkActions);
  assert.deepEqual(routedActions, implementedActions, "the runtime Query action catalog and executable classifications diverged");
});

test("every supported action auto-routes as CloudFormation Query and returns a request-scoped modeled envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-query-actions-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    for (const action of CLOUDFORMATION_SUPPORTED_ACTIONS) {
      const response = await query(endpoint, { Action: action }, false);
      assertRequestId(response);
      if (response.status === 200) {
        assert.match(response.text, new RegExp(`<${action}Response xmlns="http://cloudformation\\.amazonaws\\.com/doc/2010-05-15/">`), `${action} returned the wrong success envelope`);
      } else {
        assert.ok(response.status >= 400 && response.status < 500, `${action} returned an unexpected HTTP status ${response.status}`);
        assert.match(response.text, /^<\?xml version="1\.0" encoding="UTF-8"\?><ErrorResponse>/, `${action} returned the wrong error envelope`);
        assert.notEqual(xmlValue(response.text, "Code"), "InvalidAction", `${action} is cataloged but was rejected by dispatch`);
        assert.equal(xmlValue(response.text, "Type"), "Sender");
      }
    }
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("raw CloudFormation Query uses AWS list encoding, escaping, request IDs, and modeled error envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-query-wire-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const template = JSON.stringify({
      Parameters: { Message: { Type: "String" }, Defaulted: { Type: "String", Default: "fallback" } },
      Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: { Ref: "Message" } } } },
      Outputs: { Echo: { Value: { Ref: "Message" } } },
    });
    const created = await query(endpoint, {
      Action: "CreateStack",
      StackName: "wire-stack",
      TemplateBody: template,
      "Parameters.member.1.ParameterKey": "Message",
      "Parameters.member.1.ParameterValue": "a&<b>",
      "Tags.member.1.Key": "team",
      "Tags.member.1.Value": "api & web",
      "Capabilities.member.1": "CAPABILITY_IAM",
      "Capabilities.member.2": "CAPABILITY_AUTO_EXPAND",
      "NotificationARNs.member.1": "arn:aws:sns:eu-west-1:000000000000:first",
      "NotificationARNs.member.2": "arn:aws:sns:eu-west-1:000000000000:second",
      ClientRequestToken: "wire-create-token",
    });
    assert.equal(created.status, 200, created.text); assertRequestId(created);
    assert.match(created.text, /^<\?xml version="1\.0" encoding="UTF-8"\?><CreateStackResponse xmlns="http:\/\/cloudformation\.amazonaws\.com\/doc\/2010-05-15\/">/);
    await waitForStatus(client, "wire-stack", "CREATE_COMPLETE");

    const described = await query(endpoint, { Action: "DescribeStacks", StackName: "wire-stack" });
    assert.equal(described.status, 200); assertRequestId(described);
    assert.match(described.text, /<Parameters><member><ParameterKey>Defaulted<\/ParameterKey><ParameterValue>fallback<\/ParameterValue><\/member><member><ParameterKey>Message<\/ParameterKey><ParameterValue>a&amp;&lt;b&gt;<\/ParameterValue><\/member><\/Parameters>/);
    assert.match(described.text, /<Capabilities><member>CAPABILITY_IAM<\/member><member>CAPABILITY_AUTO_EXPAND<\/member><\/Capabilities>/);
    assert.match(described.text, /<NotificationARNs><member>arn:aws:sns:eu-west-1:000000000000:first<\/member><member>arn:aws:sns:eu-west-1:000000000000:second<\/member><\/NotificationARNs>/);
    assert.match(described.text, /<Tags><member><Key>team<\/Key><Value>api &amp; web<\/Value><\/member><\/Tags>/);
    assert.match(described.text, /<Outputs><member><OutputKey>Echo<\/OutputKey><OutputValue>a&amp;&lt;b&gt;<\/OutputValue><\/member><\/Outputs>/);

    const filtered = await query(endpoint, { Action: "ListStacks", "StackStatusFilter.member.1": "CREATE_COMPLETE", "StackStatusFilter.member.2": "UPDATE_COMPLETE" });
    assert.equal(filtered.status, 200); assertRequestId(filtered); assert.match(filtered.text, /<StackName>wire-stack<\/StackName>/);

    const duplicate = await query(endpoint, { Action: "CreateStack", StackName: "wire-stack", TemplateBody: emptyTemplate });
    assert.equal(duplicate.status, 400); assertRequestId(duplicate);
    assert.match(duplicate.text, /^<\?xml version="1\.0" encoding="UTF-8"\?><ErrorResponse>/);
    assert.match(duplicate.text, /<Error><Type>Sender<\/Type><Code>AlreadyExistsException<\/Code><Message>Stack \[wire-stack\] already exists<\/Message><\/Error>/);

    const invalid = await query(endpoint, { Action: "NotACloudFormationAction" });
    assert.equal(invalid.status, 400); assertRequestId(invalid);
    assert.match(invalid.text, /<Code>InvalidAction<\/Code>/); assert.match(invalid.text, /<Message>Action NotACloudFormationAction is not valid for this web service<\/Message>/);
    assert.notEqual(invalid.requestId, duplicate.requestId, "each Query response needs its own request ID");

    const dependencyBound = await query(endpoint, { Action: "DescribeAccountLimits" });
    assert.equal(dependencyBound.status, 400); assertRequestId(dependencyBound);
    assert.match(dependencyBound.text, /<Code>InvalidAction<\/Code>/);
    assert.match(dependencyBound.text, /<Message>Action DescribeAccountLimits is not valid for this web service<\/Message>/);

    const wrongVersion = await query(endpoint, { Action: "DescribeStacks", Version: "2009-01-01" });
    assert.equal(wrongVersion.status, 400); assertRequestId(wrongVersion);
    assert.match(wrongVersion.text, /<Code>InvalidAction<\/Code><Message>Unsupported CloudFormation API version 2009-01-01<\/Message>/);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("raw Query covers missing stacks, template input failures, and durable client-token replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn01-query-boundaries-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  let endpoint = "";
  const reconnect = async (): Promise<void> => {
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
  };
  const restart = async (): Promise<void> => {
    client?.destroy(); client = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
    await reconnect();
  };
  const expectRawError = async (input: Record<string, string>, code: string, message: RegExp): Promise<RawQueryResponse> => {
    const response = await query(endpoint, input);
    assert.equal(response.status, 400, response.text); assertRequestId(response);
    assert.equal(xmlValue(response.text, "Code"), code);
    assert.match(xmlValue(response.text, "Message") ?? "", message);
    return response;
  };
  try {
    await reconnect();
    await expectRawError({ Action: "DescribeStacks", StackName: "missing-stack" }, "ValidationError", /does not exist/);
    await expectRawError({ Action: "DescribeStackResource", StackName: "missing-stack", LogicalResourceId: "Missing" }, "ValidationError", /does not exist/);
    await expectRawError({ Action: "CreateStack", StackName: "missing-template" }, "ValidationError", /TemplateBody or TemplateURL is required/);
    await expectRawError({ Action: "CreateStack", StackName: "conflicting-template", TemplateBody: emptyTemplate, TemplateURL: "https://example.com/template.json" }, "ValidationError", /exactly one/);
    await expectRawError({ Action: "CreateStack", StackName: "malformed-template", TemplateBody: "{" }, "ValidationError", /valid JSON/);
    await expectRawError({ Action: "CreateStack", StackName: "wrong-template-shape", TemplateBody: "[]" }, "ValidationError", /JSON object/);
    await expectRawError({ Action: "CreateStack", StackName: "external-template", TemplateURL: "http://169.254.169.254/latest/meta-data/template" }, "ValidationError", /local S3|HTTPS S3|TemplateURL/i);
    await expectRawError({ Action: "CreateStack", StackName: "oversized-template", TemplateBody: " ".repeat(51_201) }, "ValidationError", /1-51200 bytes/);

    const createInput = { Action: "CreateStack", StackName: "token-stack", TemplateBody: emptyTemplate, ClientRequestToken: "raw-create-replay" };
    const created = await query(endpoint, createInput);
    assert.equal(created.status, 200, created.text); assertRequestId(created);
    const stackId = xmlValue(created.text, "StackId"); assert.ok(stackId);
    const immediateReplay = await query(endpoint, createInput);
    assert.equal(immediateReplay.status, 200, immediateReplay.text); assert.equal(xmlValue(immediateReplay.text, "StackId"), stackId);
    await expectRawError({ ...createInput, StackName: "other-stack" }, "TokenAlreadyExistsException", /different request already uses client token/);
    await waitForStatus(client!, stackId!, "CREATE_COMPLETE");

    await restart();
    const restartedReplay = await query(endpoint, createInput);
    assert.equal(restartedReplay.status, 200, restartedReplay.text); assert.equal(xmlValue(restartedReplay.text, "StackId"), stackId, "CreateStack token replay must survive restart");
    await expectRawError({ Action: "CreateStack", StackName: "token-stack", TemplateBody: emptyTemplate, ClientRequestToken: "different-token" }, "AlreadyExistsException", /already exists/);

    const deleted = await query(endpoint, { Action: "DeleteStack", StackName: stackId!, ClientRequestToken: "raw-delete-replay" });
    assert.equal(deleted.status, 200, deleted.text); assertRequestId(deleted);
    await waitForStatus(client!, stackId!, "DELETE_COMPLETE");
    await restart();
    const deleteReplay = await query(endpoint, { Action: "DeleteStack", StackName: stackId!, ClientRequestToken: "raw-delete-replay" });
    assert.equal(deleteReplay.status, 200, deleteReplay.text); assertRequestId(deleteReplay);
    const tombstone = await query(endpoint, { Action: "DescribeStacks", StackName: stackId! });
    assert.equal(tombstone.status, 200, tombstone.text); assert.match(tombstone.text, /<StackStatus>DELETE_COMPLETE<\/StackStatus>/);
    await expectRawError({ Action: "DescribeStacks", StackName: "token-stack" }, "ValidationError", /does not exist/);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CancelUpdateStack succeeds through Query/XML and is client-token idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-query-cancel-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    await client.send(new CreateStackCommand({ StackName: "cancel-stack", TemplateBody: emptyTemplate }));
    await waitForStatus(client, "cancel-stack", "CREATE_COMPLETE");
    const resources = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`Metadata${String(index).padStart(3, "0")}`, { Type: "AWS::CDK::Metadata", Properties: { Analytics: `cancel-${index}` } }]));
    await client.send(new UpdateStackCommand({ StackName: "cancel-stack", TemplateBody: JSON.stringify({ Resources: resources }) }));

    const cancelled = await query(endpoint, { Action: "CancelUpdateStack", StackName: "cancel-stack", ClientRequestToken: "cancel-wire-token" });
    assert.equal(cancelled.status, 200, cancelled.text); assertRequestId(cancelled);
    assert.match(cancelled.text, /<CancelUpdateStackResponse xmlns="http:\/\/cloudformation\.amazonaws\.com\/doc\/2010-05-15\/"><CancelUpdateStackResult><\/CancelUpdateStackResult><ResponseMetadata><RequestId>/);
    const duplicate = await client.send(new CancelUpdateStackCommand({ StackName: "cancel-stack", ClientRequestToken: "cancel-wire-token" }));
    assert.match(duplicate.$metadata.requestId ?? "", /^[0-9a-f-]{16,}$/i);
    await waitForStatus(client, "cancel-stack", "UPDATE_ROLLBACK_COMPLETE");
    const events = await client.send(new cloudFormationSdk.DescribeStackEventsCommand({ StackName: "cancel-stack" }));
    assert.ok(events.StackEvents?.some(event => /CancelUpdateStack|cancelled/i.test(event.ResourceStatusReason ?? "")));
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("all implemented official SDK v3 paginators traverse opaque Query NextTokens and reject cross-action or tampered tokens", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-query-pages-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const resources = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`Metadata${String(index).padStart(3, "0")}`, { Type: "AWS::CDK::Metadata", Properties: { Analytics: `page-${index}` } }]));
    const outputs = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`Export${String(index).padStart(3, "0")}`, { Value: `value-${index}`, Export: { Name: `QueryExport${String(index).padStart(3, "0")}` } }]));
    await client.send(new CreateStackCommand({ StackName: "bulk-stack", TemplateBody: JSON.stringify({ Resources: resources, Outputs: outputs }) }));
    await waitForStatus(client, "bulk-stack", "CREATE_COMPLETE");
    const importerTemplate = JSON.stringify({ Resources: {}, Outputs: { Imported: { Value: { "Fn::ImportValue": "QueryExport000" } } } });
    for (let index = 0; index < 101; index += 1) await client.send(new CreateStackCommand({ StackName: `page-stack-${String(index).padStart(3, "0")}`, TemplateBody: importerTemplate }));
    await waitForStatus(client, "page-stack-100", "CREATE_COMPLETE");

    const listPages: cloudFormationSdk.ListStacksOutput[] = [];
    for await (const page of paginateListStacks({ client }, {})) listPages.push(page);
    assert.deepEqual(listPages.map(page => page.StackSummaries?.length), [100, 2]);
    assert.equal(new Set(listPages.flatMap(page => page.StackSummaries?.map(stack => stack.StackId) ?? [])).size, 102);

    const describePages: cloudFormationSdk.DescribeStacksOutput[] = [];
    for await (const page of paginateDescribeStacks({ client }, {})) describePages.push(page);
    assert.deepEqual(describePages.map(page => page.Stacks?.length), [100, 2]);

    const resourcePages: cloudFormationSdk.ListStackResourcesOutput[] = [];
    for await (const page of paginateListStackResources({ client }, { StackName: "bulk-stack" })) resourcePages.push(page);
    assert.deepEqual(resourcePages.map(page => page.StackResourceSummaries?.length), [100, 1]);

    const eventPages: cloudFormationSdk.DescribeStackEventsOutput[] = [];
    for await (const page of paginateDescribeStackEvents({ client }, { StackName: "bulk-stack" })) eventPages.push(page);
    assert.ok(eventPages.length >= 3); assert.equal(eventPages.slice(0, -1).every(page => page.StackEvents?.length === 100), true);
    assert.equal(eventPages.flatMap(page => page.StackEvents ?? []).length, 204);

    const exportPages: cloudFormationSdk.ListExportsOutput[] = [];
    for await (const page of paginateListExports({ client }, {})) exportPages.push(page);
    assert.deepEqual(exportPages.map(page => page.Exports?.length), [100, 1]);

    const importPages: cloudFormationSdk.ListImportsOutput[] = [];
    for await (const page of paginateListImports({ client }, { ExportName: "QueryExport000" })) importPages.push(page);
    assert.deepEqual(importPages.map(page => page.Imports?.length), [100, 1]);

    for (let index = 0; index < 101; index += 1) await client.send(new CreateChangeSetCommand({ StackName: "page-stack-000", ChangeSetName: `query-change-${String(index).padStart(3, "0")}`, ChangeSetType: "UPDATE", UsePreviousTemplate: true }));
    const changeSetPages: cloudFormationSdk.ListChangeSetsOutput[] = [];
    for await (const page of paginateListChangeSets({ client }, { StackName: "page-stack-000" })) changeSetPages.push(page);
    assert.deepEqual(changeSetPages.map(page => page.Summaries?.length), [100, 1]);

    const firstRaw = await query(endpoint, { Action: "ListStacks" }); assert.equal(firstRaw.status, 200); assertRequestId(firstRaw); assert.equal(members(firstRaw.text, "StackSummaries"), 100);
    const token = xmlValue(firstRaw.text, "NextToken"); assert.ok(token);
    const secondRaw = await query(endpoint, { Action: "ListStacks", NextToken: token! }); assert.equal(secondRaw.status, 200); assertRequestId(secondRaw); assert.equal(members(secondRaw.text, "StackSummaries"), 2); assert.equal(xmlValue(secondRaw.text, "NextToken"), undefined);

    await assert.rejects(client.send(new DescribeStacksCommand({ NextToken: token })), (error: any) => error.name === "ValidationError" && /NextToken is invalid/.test(error.message));
    const tampered = `${token![0] === "A" ? "B" : "A"}${token!.slice(1)}`;
    await assert.rejects(client.send(new ListStacksCommand({ NextToken: tampered })), (error: any) => error.name === "ValidationError" && /NextToken is invalid/.test(error.message));
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
