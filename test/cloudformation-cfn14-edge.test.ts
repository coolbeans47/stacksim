import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStackResourceCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFormationService } from "../src/cloudformation.js";
import { CustomResourceCallbackBroker } from "../src/cloudformation/custom-resource-callbacks.js";
import {
  CloudFormationTestProviderRegistry,
  createDefaultCloudFormationProviderRegistry,
  type ProviderContext,
  type ProviderPlan,
  type ProviderReadModel,
  type TestOnlyResourceProvider,
  validateDeclaredProperties,
} from "../src/cloudformation/providers/index.js";
import { TestClock } from "../src/core/clock.js";
import { createLoopbackServerCertificate } from "../src/core/x509.js";
import { S3Service } from "../src/s3.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const principal: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<any> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (stack?.StackStatus === expected) return stack;
    if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus === "ROLLBACK_COMPLETE") throw new Error(`${stackName} reached ${stack.StackStatus}: ${stack.StackStatusReason}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

function outputMap(stack: any): Record<string, string> {
  return Object.fromEntries((stack.Outputs ?? []).map((output: { OutputKey?: string; OutputValue?: string }) => [output.OutputKey!, output.OutputValue!]));
}

const lifecycleHandler = `
const https = require("node:https");
exports.handler = async event => {
  console.log("CFN14_EDGE_EVENT " + JSON.stringify({
    RequestType: event.RequestType,
    RequestId: event.RequestId,
    PhysicalResourceId: event.PhysicalResourceId,
    ResourceProperties: event.ResourceProperties,
    OldResourceProperties: event.OldResourceProperties
  }));
  const physicalId = event.RequestType === "Create"
    ? "edge-old-" + event.ResourceProperties.Value
    : event.RequestType === "Update"
      ? "edge-new-" + event.ResourceProperties.Value
      : event.PhysicalResourceId;
  const body = JSON.stringify({
    Status: "SUCCESS",
    PhysicalResourceId: physicalId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: { RequestType: event.RequestType }
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
};`;

function lifecycleTemplate(value: string, activeProvider: "OldProviderFunction" | "NewProviderFunction", updateReplacePolicy?: "Retain" | "RetainExceptOnCreate"): string {
  const assumeRolePolicy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  const lambdaProperties = { Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["ProviderRole", "Arn"] }, Code: { ZipFile: lifecycleHandler }, Timeout: 5 };
  return JSON.stringify({
    Resources: {
      ProviderRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: assumeRolePolicy } },
      OldProviderFunction: { Type: "AWS::Lambda::Function", Properties: lambdaProperties },
      NewProviderFunction: { Type: "AWS::Lambda::Function", Properties: lambdaProperties },
      Probe: {
        Type: "Custom::Cfn14PhysicalIdEdge",
        ...(updateReplacePolicy ? { UpdateReplacePolicy: updateReplacePolicy } : {}),
        Properties: { ServiceToken: { "Fn::GetAtt": [activeProvider, "Arn"] }, Value: value, ServiceTimeout: 30 },
      },
    },
    Outputs: {
      PhysicalId: { Value: { Ref: "Probe" } },
      OldFunctionName: { Value: { Ref: "OldProviderFunction" } },
      NewFunctionName: { Value: { Ref: "NewProviderFunction" } },
    },
  });
}

interface LifecycleTrace {
  RequestType: "Create" | "Update" | "Delete";
  RequestId: string;
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

async function lifecycleTraces(logs: CloudWatchLogsClient, functionName: string, expected: number): Promise<LifecycleTrace[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}` }));
      const traces = (response.events ?? []).flatMap(event => {
        const marker = "CFN14_EDGE_EVENT ";
        const index = String(event.message ?? "").indexOf(marker);
        if (index < 0) return [];
        try { return [JSON.parse(String(event.message).slice(index + marker.length)) as LifecycleTrace]; }
        catch { return []; }
      });
      if (traces.length >= expected) return traces;
    } catch (error: any) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return [];
}

test("CFN-14 deletes the old physical resource with its old provider after an update cutover", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-old-id-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    logs = new CloudWatchLogsClient({ endpoint, region, credentials, maxAttempts: 1 });

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "cfn14-old-id-edge", TemplateBody: lifecycleTemplate("v1", "OldProviderFunction"), Capabilities: ["CAPABILITY_IAM"] }));
    let stack = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    let outputs = outputMap(stack);
    assert.equal(outputs.PhysicalId, "edge-old-v1");

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: lifecycleTemplate("v2", "NewProviderFunction"), Capabilities: ["CAPABILITY_IAM"] }));
    stack = await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    outputs = outputMap(stack);
    assert.equal(outputs.PhysicalId, "edge-new-v2");
    const detail = await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Probe" }));
    assert.equal(detail.StackResourceDetail?.PhysicalResourceId, "edge-new-v2", "the new physical ID must remain authoritative after old-resource cleanup");

    const oldArn = `arn:aws:lambda:${region}:${accountId}:function:${outputs.OldFunctionName}`;
    const newArn = `arn:aws:lambda:${region}:${accountId}:function:${outputs.NewFunctionName}`;
    const oldEvents = await lifecycleTraces(logs, outputs.OldFunctionName, 2);
    const newEvents = await lifecycleTraces(logs, outputs.NewFunctionName, 1);
    const createdEvent = oldEvents.find(event => event.RequestType === "Create");
    const oldDelete = oldEvents.find(event => event.RequestType === "Delete");
    const update = newEvents.find(event => event.RequestType === "Update");
    assert.ok(createdEvent, `missing Create trace: ${JSON.stringify(oldEvents)}`);
    assert.ok(update, `missing Update trace: ${JSON.stringify(newEvents)}`);
    assert.ok(oldDelete, `missing old-resource Delete trace: ${JSON.stringify(oldEvents)}`);
    assert.equal(update.PhysicalResourceId, "edge-old-v1");
    assert.equal(update.ResourceProperties.Value, "v2");
    assert.equal(update.ResourceProperties.ServiceToken, newArn);
    assert.equal(update.OldResourceProperties?.Value, "v1");
    assert.equal(update.OldResourceProperties?.ServiceToken, oldArn);
    assert.equal(oldDelete.PhysicalResourceId, "edge-old-v1");
    assert.equal(oldDelete.ResourceProperties.Value, "v1");
    assert.equal(oldDelete.ResourceProperties.ServiceToken, oldArn, "the old physical ID must be deleted through the previous service token");
    assert.notEqual(oldDelete.RequestId, update.RequestId, "old-resource deletion must be a distinct durable callback operation");

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    logs?.destroy();
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 retains the old physical resource when a changed update ID uses a retaining UpdateReplacePolicy", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-old-id-retain-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    logs = new CloudWatchLogsClient({ endpoint, region, credentials, maxAttempts: 1 });
    for (const policy of ["Retain", "RetainExceptOnCreate"] as const) {
      const suffix = policy.toLowerCase();
      const created = await cloudformation.send(new CreateStackCommand({ StackName: `cfn14-old-id-${suffix}`, TemplateBody: lifecycleTemplate("v1", "OldProviderFunction", policy), Capabilities: ["CAPABILITY_IAM"] }));
      let stack = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
      let outputs = outputMap(stack);
      await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: lifecycleTemplate("v2", "NewProviderFunction", policy), Capabilities: ["CAPABILITY_IAM"] }));
      stack = await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
      outputs = outputMap(stack);
      assert.equal(outputs.PhysicalId, "edge-new-v2");
      await new Promise(resolve => setTimeout(resolve, 50));
      const oldEvents = await lifecycleTraces(logs, outputs.OldFunctionName, 1);
      assert.equal(oldEvents.filter(event => event.RequestType === "Delete").length, 0, `${policy} must suppress old-physical-ID cleanup`);
      await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
      await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
    }
  } finally {
    logs?.destroy();
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 preauthorizes both service tokens before a retaining update can mutate", async () => {
  interface Model { ServiceToken: string; ServiceTimeout: number; Value: string }
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-old-token-auth-"));
  const clock = new TestClock(100_000);
  const store = new StateStore(root, accountId, region);
  await store.load();
  const s3 = new S3Service(store, region, clock);
  await s3.start();
  const oldToken = `arn:aws:lambda:${region}:${accountId}:function:cfn14-old-token`;
  const newToken = `arn:aws:lambda:${region}:${accountId}:function:cfn14-new-token`;
  const authorizationTargets: Array<{ action: string; resource: string }> = [];
  let denyOldToken = false;
  let denyNewToken = false;
  let updateCalls = 0;
  const typeName = "Custom::Cfn14OldTokenAuthorization";
  const schema = {
    typeName,
    unknownProperties: "REJECT" as const,
    properties: {
      ServiceToken: { valueType: "string" as const, required: true, updateBehavior: "MUTABLE" as const },
      ServiceTimeout: { valueType: "number" as const, updateBehavior: "MUTABLE" as const },
      Value: { valueType: "string" as const, required: true, updateBehavior: "MUTABLE" as const },
    },
    ref: { supported: true, valueType: "string" as const },
    attributes: {},
    replacement: { defaultOrder: "CREATE_BEFORE_DELETE" as const },
    retention: { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, updateReplacePolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, snapshotSupported: false },
    tags: { behavior: "NONE" as const, propagatesCloudFormationTags: false },
  };
  const readModel = (physicalId: string, properties: Model): ProviderReadModel<Model> => ({ physicalId, properties: { ...properties }, attributes: {} });
  let authoritative: Model | undefined;
  const provider: TestOnlyResourceProvider<Model> = {
    typeName, providerVersion: 1, visibility: "test-only", schema,
    validate(properties) { return validateDeclaredProperties(properties, schema); },
    canonicalize(properties) { return { ...(properties as Model), ServiceTimeout: Number((properties as Model).ServiceTimeout ?? 30) }; },
    plan(previous, desired): ProviderPlan<Model> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changedProperties = Object.keys(desired).filter(key => previous[key as keyof Model] !== desired[key as keyof Model]).sort();
      return changedProperties.length ? { action: "UPDATE", desired, changedProperties, replacementProperties: [] } : { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired) { authoritative = { ...desired }; return { status: "SUCCESS", physicalId: "cfn14-auth-physical", model: readModel("cfn14-auth-physical", desired) }; },
    async read(physicalId) { return authoritative ? { status: "SUCCESS", physicalId, model: readModel(physicalId, authoritative) } : { status: "NOT_FOUND", physicalId }; },
    async update(physicalId, _previous, desired) { updateCalls += 1; authoritative = { ...desired }; return { status: "SUCCESS", physicalId, model: readModel(physicalId, desired) }; },
    async delete(physicalId) { authoritative = undefined; return { status: "SUCCESS", physicalId }; },
    ref(model) { return model.physicalId; },
    getAtt(_model, attribute) { throw new Error(attribute); },
  };
  const cloudformation = new CloudFormationService(
    store,
    region,
    clock,
    s3,
    undefined,
    [],
    async (_identity, targets) => {
      authorizationTargets.push(...targets);
      if (denyOldToken && targets.some(target => target.action === "lambda:InvokeFunction" && target.resource === oldToken)) throw new Error("old service token invocation denied");
      if (denyNewToken && targets.some(target => target.action === "lambda:InvokeFunction" && target.resource === newToken)) throw new Error("new service token invocation denied");
    },
  );
  const overlay = new CloudFormationTestProviderRegistry(createDefaultCloudFormationProviderRegistry(), [provider]);
  (cloudformation as any).providers = { get: (resourceType: string) => overlay.resolveForTest(resourceType), require: (resourceType: string) => overlay.requireForTest(resourceType) };
  const template = (serviceToken: string, value: string) => JSON.stringify({ Resources: {
    Probe: { Type: typeName, UpdateReplacePolicy: "Retain", Properties: { ServiceToken: serviceToken, ServiceTimeout: 30, Value: value } },
  } });
  try {
    await cloudformation.start();
    const created = await cloudformation.CreateStack({ StackName: "cfn14-old-token-auth", TemplateBody: template(oldToken, "v1") }, principal);
    await waitForCondition(() => store.regionState(region).cloudformation.stacks[created.StackId].stackStatus === "CREATE_COMPLETE", "custom-resource auth stack did not create");
    authorizationTargets.length = 0;
    denyOldToken = true;
    await cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template(newToken, "v2") }, principal);
    await waitForCondition(() => store.regionState(region).cloudformation.stacks[created.StackId].stackStatus === "UPDATE_ROLLBACK_COMPLETE", "denied previous token did not roll back cleanly");
    assert.equal(updateCalls, 0, "the desired provider must not run before the previous token is authorized for rollback");
    assert.ok(authorizationTargets.some(target => target.action === "lambda:InvokeFunction" && target.resource === oldToken));
    assert.equal(authoritative?.ServiceToken, oldToken);
    assert.equal(authoritative?.Value, "v1");

    const previousOperationId = store.regionState(region).cloudformation.stacks[created.StackId].activeOperation?.operationId;
    authorizationTargets.length = 0;
    denyOldToken = false;
    denyNewToken = true;
    await cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template(newToken, "v2") }, principal);
    await waitForCondition(() => {
      const stack = store.regionState(region).cloudformation.stacks[created.StackId];
      return stack.activeOperation?.operationId !== previousOperationId && stack.stackStatus === "UPDATE_ROLLBACK_COMPLETE";
    }, "denied desired token did not roll back cleanly");
    assert.equal(updateCalls, 0, "the desired provider must not run before its service token is authorized");
    assert.ok(authorizationTargets.some(target => target.action === "lambda:InvokeFunction" && target.resource === newToken));
    assert.equal(authoritative?.ServiceToken, oldToken);
    assert.equal(authoritative?.Value, "v1");
  } finally {
    await cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const noEchoHandler = `
const https = require("node:https");
exports.handler = async event => {
  const body = JSON.stringify({
    Status: "SUCCESS",
    PhysicalResourceId: event.PhysicalResourceId || "cfn14-no-echo-edge",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: true,
    Data: {
      Secret: ["edge", "super", "secret", "value"].join("-"),
      Ordinary: ["edge", "also", "masked", "value"].join("-")
    }
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
};`;

function noEchoTemplate(attribute = "Secret"): string {
  return JSON.stringify({
    Resources: {
      ProviderRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] } } },
      ProviderFunction: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["ProviderRole", "Arn"] }, Code: { ZipFile: noEchoHandler }, Timeout: 5 } },
      Probe: { Type: "Custom::Cfn14NoEchoEdge", Properties: { ServiceToken: { "Fn::GetAtt": ["ProviderFunction", "Arn"] }, ServiceTimeout: 30 } },
    },
    Outputs: {
      Secret: { Value: { "Fn::GetAtt": ["Probe", attribute] } },
      Ordinary: { Value: { "Fn::GetAtt": ["Probe", "Ordinary"] } },
    },
  });
}

test("CFN-14 NoEcho masks callback Data in outputs and ordinary resource views", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-noecho-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "cfn14-noecho-edge", TemplateBody: noEchoTemplate(), Capabilities: ["CAPABILITY_IAM"] }));
    const stack = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    assert.deepEqual(outputMap(stack), { Ordinary: "****", Secret: "****" });

    const [detail, resources, events] = await Promise.all([
      cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Probe" })),
      cloudformation.send(new DescribeStackResourcesCommand({ StackName: created.StackId, LogicalResourceId: "Probe" })),
      cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId })),
    ]);
    for (const view of [stack, detail, resources, events]) {
      assert.doesNotMatch(JSON.stringify(view), /edge-super-secret-value|edge-also-masked-value/, "ordinary CloudFormation views must not reveal NoEcho callback Data");
      assert.doesNotMatch(JSON.stringify(view), /__stackSimCustomResourceNoEcho/, "the private NoEcho marker must never appear in public views");
    }

    const local = simulator.cloudformation.localStack(created.StackId!);
    assert.deepEqual(local.resources.Probe.attributes, { Ordinary: "****", Secret: "****" });
    assert.doesNotMatch(JSON.stringify(local), /edge-super-secret-value|edge-also-masked-value|__stackSimCustomResourceNoEcho/, "the ordinary local stack view must apply the same redaction boundary");

    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "cfn14-reserved-attribute", TemplateBody: noEchoTemplate("__stackSimCustomResourceNoEcho"), Capabilities: ["CAPABILITY_IAM"] })),
      (error: any) => error?.name === "ValidationError" && /reserved attribute Probe\.__stackSimCustomResourceNoEcho/.test(error.message),
      "templates must not be able to retrieve the internal NoEcho marker",
    );

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface LongPollModel {
  Mode: "lead" | "poll";
  ServiceTimeout: number;
}

function longPollingProvider() {
  const typeName = "Test::Cfn14::LongPolling";
  const calls = new Map<string, number>();
  const deadlines = new Map<string, number[]>();
  const resources = new Map<string, LongPollModel>();
  const schema = {
    typeName,
    unknownProperties: "REJECT" as const,
    properties: {
      Mode: { valueType: "string" as const, required: true, updateBehavior: "REPLACEMENT" as const },
      ServiceTimeout: { valueType: "number" as const, required: true, updateBehavior: "MUTABLE" as const },
    },
    ref: { supported: true, valueType: "string" as const },
    attributes: {},
    replacement: { defaultOrder: "CREATE_BEFORE_DELETE" as const },
    retention: { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, updateReplacePolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, snapshotSupported: false },
    tags: { behavior: "NONE" as const, propagatesCloudFormationTags: false },
  };
  const model = (physicalId: string, properties: LongPollModel): ProviderReadModel<LongPollModel> => ({ physicalId, properties: { ...properties }, attributes: {} });
  const provider: TestOnlyResourceProvider<LongPollModel> = {
    typeName, providerVersion: 1, visibility: "test-only", schema,
    validate(properties) { return validateDeclaredProperties(properties, schema); },
    canonicalize(properties) { return { ...(properties as LongPollModel) }; },
    plan(previous, desired): ProviderPlan<LongPollModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: ["Mode", "ServiceTimeout"], replacementProperties: [] };
      return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired, context) {
      calls.set(context.logicalId, (calls.get(context.logicalId) ?? 0) + 1);
      deadlines.set(context.logicalId, [...(deadlines.get(context.logicalId) ?? []), context.deadlineAt]);
      const attempt = Number(context.callbackContext?.attempt ?? 0);
      const targetAttempts = desired.Mode === "lead" ? 1 : 120;
      if (attempt < targetAttempts) {
        return {
          status: "IN_PROGRESS",
          callbackAfterMs: desired.Mode === "lead" ? 14 * 60_000 + 45_000 : 250,
          checkpoint: { schemaVersion: 1, physicalId: `${desired.Mode}-physical`, callbackContext: { attempt: attempt + 1 } },
        };
      }
      const physicalId = `${desired.Mode}-physical`;
      resources.set(physicalId, { ...desired });
      return { status: "SUCCESS", physicalId, model: model(physicalId, desired) };
    },
    async read(physicalId) { const found = resources.get(physicalId); return found ? { status: "SUCCESS", physicalId, model: model(physicalId, found) } : { status: "NOT_FOUND", physicalId }; },
    async update(physicalId, _previous, desired) { resources.set(physicalId, { ...desired }); return { status: "SUCCESS", physicalId, model: model(physicalId, desired) }; },
    async delete(physicalId) { resources.delete(physicalId); return { status: "SUCCESS", physicalId }; },
    ref(value) { return value.physicalId; },
    getAtt(_value, attribute) { throw new Error(attribute); },
  };
  return { provider, calls, deadlines };
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

test("CFN-14-sized polling can exceed 100 callbacks and each provider step receives its own deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-long-poll-"));
  const clock = new TestClock(100_000);
  const fake = longPollingProvider();
  const store = new StateStore(root, accountId, region);
  await store.load();
  const s3 = new S3Service(store, region, clock);
  await s3.start();
  const cloudformation = new CloudFormationService(store, region, clock, s3);
  const overlay = new CloudFormationTestProviderRegistry(createDefaultCloudFormationProviderRegistry(), [fake.provider]);
  (cloudformation as any).providers = { get: (typeName: string) => overlay.resolveForTest(typeName), require: (typeName: string) => overlay.requireForTest(typeName) };
  try {
    await cloudformation.start();
    const acceptedAt = clock.now();
    const template = JSON.stringify({ Resources: {
      Lead: { Type: fake.provider.typeName, Properties: { Mode: "lead", ServiceTimeout: 900 } },
      Probe: { Type: fake.provider.typeName, DependsOn: "Lead", Properties: { Mode: "poll", ServiceTimeout: 30 } },
    } });
    const created = await cloudformation.CreateStack({ StackName: "cfn14-long-poll", TemplateBody: template }, principal);

    await waitForCondition(() => fake.calls.get("Lead") === 1 && (cloudformation as any).resumeTimers.size === 1, "Lead did not enter its deferred provider step");
    clock.advance(14 * 60_000 + 45_000);
    await waitForCondition(() => fake.calls.get("Lead") === 2 && fake.calls.get("Probe") === 1 && (cloudformation as any).resumeTimers.size === 1, "Probe did not begin after the long lead step");

    for (let expectedCalls = 2; expectedCalls <= 120; expectedCalls += 1) {
      clock.advance(250);
      await waitForCondition(() => fake.calls.get("Probe") === expectedCalls && (cloudformation as any).resumeTimers.size === 1, `Probe did not persist callback ${expectedCalls}`);
    }
    clock.advance(250);
    await waitForCondition(() => fake.calls.get("Probe") === 121, "Probe did not execute its terminal callback");
    await waitForCondition(() => store.regionState(region).cloudformation.stacks[created.StackId].stackStatus === "CREATE_COMPLETE", "long-poll stack did not complete");

    assert.equal(fake.calls.get("Probe"), 121, "120 IN_PROGRESS callbacks must not hit the former 100-attempt cap");
    assert.ok(clock.now() - acceptedAt > 15 * 60_000, "the two resource steps must cross the operation-wide 15-minute mark");
    const leadDeadlines = fake.deadlines.get("Lead") ?? [];
    const probeDeadlines = fake.deadlines.get("Probe") ?? [];
    assert.equal(new Set(leadDeadlines).size, 1, "a provider step must keep one durable deadline across callbacks");
    assert.equal(new Set(probeDeadlines).size, 1, "a provider step must keep one durable deadline across callbacks");
    assert.ok(probeDeadlines[0] > leadDeadlines[0], "the dependent provider step must receive a fresh stabilization deadline");
  } finally {
    await cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface CallbackReply { status: number; body: string }

async function callbackPut(url: string, ca: Buffer, body: Buffer | string, hostHeader?: string): Promise<CallbackReply> {
  const parsed = new URL(url);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise<CallbackReply>((resolve, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port: Number(parsed.port),
      path: parsed.pathname,
      method: "PUT",
      servername: "localhost",
      ca,
      headers: { host: hostHeader ?? `localhost:${parsed.port}`, "content-length": payload.length },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("CFN-14 callback PKI restart repairs an interrupted mismatched bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-callback-pki-"));
  let simulator: StackSim | undefined = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  try {
    await simulator.start();
    const originalBroker = (simulator as any).customResourceCallbacks as CustomResourceCallbackBroker;
    const originalKey = await readFile(originalBroker.serverPrivateKeyPath, "utf8");
    const paths = {
      ca: originalBroker.caCertificatePath,
      certificate: originalBroker.serverCertificatePath,
      privateKey: originalBroker.serverPrivateKeyPath,
    };
    await simulator.stop();
    simulator = undefined;

    // Model a crash after the new CA and leaf certificate were committed but
    // before their private key.  The mixed generation used to pass startup's
    // chain checks and fail only when createSecureServer consumed the key.
    const interrupted = createLoopbackServerCertificate(Date.now());
    await writeFile(paths.ca, interrupted.caCertificate, { mode: 0o600 });
    await writeFile(paths.certificate, interrupted.certificate, { mode: 0o600 });
    assert.equal(new X509Certificate(interrupted.certificate).checkPrivateKey(createPrivateKey(originalKey)), false);

    simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
    await simulator.start(); // Repaired PKI must be returned before createSecureServer.

    const repairedCa = await readFile(paths.ca, "utf8");
    const repairedCertificate = await readFile(paths.certificate, "utf8");
    const repairedKey = await readFile(paths.privateKey, "utf8");
    const leaf = new X509Certificate(repairedCertificate);
    const ca = new X509Certificate(repairedCa);
    assert.equal(leaf.verify(ca.publicKey), true);
    assert.equal(leaf.checkPrivateKey(createPrivateKey(repairedKey)), true);
    assert.ok(leaf.checkHost("localhost"));
    assert.ok(leaf.checkIP("127.0.0.1"));
    assert.notEqual(repairedCertificate, interrupted.certificate, "restart must replace the interrupted generation");
  } finally {
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 callback PKI restart replaces a matching bundle that is not yet valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-callback-pki-future-"));
  let simulator: StackSim | undefined = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  try {
    await simulator.start();
    const broker = (simulator as any).customResourceCallbacks as CustomResourceCallbackBroker;
    const paths = { ca: broker.caCertificatePath, certificate: broker.serverCertificatePath, privateKey: broker.serverPrivateKeyPath };
    await simulator.stop();
    simulator = undefined;

    const future = createLoopbackServerCertificate(Date.now() + 60 * 60_000);
    await writeFile(paths.ca, future.caCertificate, { mode: 0o600 });
    await writeFile(paths.certificate, future.certificate, { mode: 0o600 });
    await writeFile(paths.privateKey, future.privateKey, { mode: 0o600 });
    const futureLeaf = new X509Certificate(future.certificate);
    assert.equal(futureLeaf.checkPrivateKey(createPrivateKey(future.privateKey)), true);
    assert.ok(Date.parse(futureLeaf.validFrom) > Date.now(), "the persisted matching fixture must be rejected only because it is future-dated");

    simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
    await simulator.start();
    const repaired = new X509Certificate(await readFile(paths.certificate, "utf8"));
    assert.ok(Date.parse(repaired.validFrom) <= Date.now(), "restart must replace a future-dated bundle before the callback listener accepts TLS");
    assert.notEqual(repaired.raw.toString("base64"), futureLeaf.raw.toString("base64"));
  } finally {
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 callback retention reclaims aged terminal bodies while preserving recoverable, live, and legacy records", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-callback-retention-"));
  const clock = new TestClock(1_000);
  const store = new StateStore(root, accountId, region);
  await store.load();
  const broker = new CustomResourceCallbackBroker(store, clock);
  const callbackIntent = (resourceOperationId: string, operationId: string, expiresAt = 900) => ({
    region,
    resourceType: "Custom::Cfn14CallbackRetention",
    requestType: "Create" as const,
    operationId,
    resourceOperationId,
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cfn14-callback-retention/stack-id`,
    logicalId: "Probe",
    serviceToken: `arn:aws:lambda:${region}:${accountId}:function:cfn14-callback-retention`,
    expiresAt,
  });
  const agedId = "1".repeat(64);
  const protectedId = "2".repeat(64);
  const liveId = "3".repeat(64);
  const legacyId = "4".repeat(64);
  try {
    await broker.markInvocationFailed(await broker.prepare(callbackIntent(agedId, "aged-operation")), "terminal");
    await broker.markInvocationFailed(await broker.prepare(callbackIntent(protectedId, "recoverable-operation")), "terminal");
    await broker.prepare(callbackIntent(liveId, "live-url-operation", 5_000));
    const legacy = await broker.prepare(callbackIntent(legacyId, "legacy-operation"));
    const { operationId: _operationId, ...legacyWithoutParent } = legacy;
    const journal = (broker as any).journal(region);
    await journal.replaceJsonArtifact("custom-resource-callbacks", `${legacyId}.json`, legacyWithoutParent);

    clock.advance(1_000);
    assert.equal(await broker.sweep(region, { cutoff: 1_500, preserveOperationIds: ["recoverable-operation"] }), 1);
    assert.equal(await broker.read(region, agedId), undefined, "aged terminal callback bodies must be reclaimed");
    assert.equal((await broker.read(region, protectedId))?.operationId, "recoverable-operation", "recoverable parent operations must pin their callbacks");
    assert.equal((await broker.read(region, liveId))?.invocationStatus, "INTENT", "unexpired one-use callback URLs must remain valid");
    assert.equal((await broker.read(region, legacyId))?.operationId, undefined, "unmapped pre-upgrade records must survive startup retention");

    const migrated = await broker.prepare(callbackIntent(legacyId, "legacy-operation"));
    assert.equal(migrated.operationId, "legacy-operation", "a replaying legacy operation must acquire its parent operation before later sweeps");
  } finally {
    await broker.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 callback URLs enforce host, binding, size, and one-use boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-callback-edge-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  try {
    await simulator.start();
    const broker = (simulator as any).customResourceCallbacks as CustomResourceCallbackBroker;
    const ca = await readFile(broker.caCertificatePath);
    const expiresAt = broker.now() + 60_000;
    const intent = (resourceOperationId: string) => ({
      region,
      resourceType: "Custom::Cfn14CallbackEdge",
      requestType: "Create" as const,
      resourceOperationId,
      stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cfn14-callback-edge/stack-id`,
      logicalId: "Probe",
      serviceToken: `arn:aws:lambda:${region}:${accountId}:function:cfn14-callback-edge`,
      expiresAt,
    });
    const response = (resourceOperationId: string) => JSON.stringify({
      Status: "SUCCESS",
      PhysicalResourceId: "callback-edge",
      StackId: intent(resourceOperationId).stackId,
      RequestId: resourceOperationId,
      LogicalResourceId: "Probe",
      Data: { ok: true },
    });

    const operationId = "a".repeat(64);
    await broker.prepare(intent(operationId));
    const url = broker.responseUrl(region, operationId, expiresAt);
    const externalHost = await callbackPut(url, ca, response(operationId), "callbacks.example.invalid");
    assert.equal(externalHost.status, 400);
    assert.match(externalHost.body, /Invalid callback host/);

    const wrongBinding = JSON.parse(response(operationId));
    wrongBinding.RequestId = "b".repeat(64);
    const rejected = await callbackPut(url, ca, JSON.stringify(wrongBinding));
    assert.equal(rejected.status, 400);
    assert.match(rejected.body, /operation binding/);
    assert.equal((await broker.read(region, operationId))?.invocationStatus, "INTENT", "invalid callbacks must not consume the URL");

    assert.equal((await callbackPut(url, ca, response(operationId))).status, 200);
    const replay = await callbackPut(url, ca, response(operationId));
    assert.equal(replay.status, 409);
    assert.match(replay.body, /already been used/);

    const oversizedOperation = "c".repeat(64);
    await broker.prepare(intent(oversizedOperation));
    const oversizedUrl = broker.responseUrl(region, oversizedOperation, expiresAt);
    const oversized = await callbackPut(oversizedUrl, ca, Buffer.alloc(64 * 1024 + 1, 0x20));
    assert.equal(oversized.status, 413);
    assert.match(oversized.body, /exceeds 64 KiB/);
    assert.equal((await broker.read(region, oversizedOperation))?.invocationStatus, "INTENT", "oversized callbacks must not consume the URL");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 serializes invocation-state writes with an immediate callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-callback-race-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  try {
    await simulator.start();
    const broker = (simulator as any).customResourceCallbacks as CustomResourceCallbackBroker;
    const ca = await readFile(broker.caCertificatePath);
    const operationId = "d".repeat(64);
    const expiresAt = broker.now() + 60_000;
    const intent = {
      region,
      resourceType: "Custom::Cfn14CallbackRace",
      requestType: "Create" as const,
      resourceOperationId: operationId,
      stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cfn14-callback-race/stack-id`,
      logicalId: "Probe",
      serviceToken: `arn:aws:lambda:${region}:${accountId}:function:cfn14-callback-race`,
      expiresAt,
    };
    const prepared = await broker.prepare(intent);
    const url = broker.responseUrl(region, operationId, expiresAt);
    const response = JSON.stringify({
      Status: "SUCCESS",
      PhysicalResourceId: "callback-race",
      StackId: intent.stackId,
      RequestId: operationId,
      LogicalResourceId: intent.logicalId,
      Data: { ok: true },
    });

    // Hold markInvoked after it has observed the durable INTENT.  Without a
    // shared callback-write queue an immediate callback can commit COMPLETED
    // and then be stale-overwritten back to INVOKED.
    const journal = (broker as any).journal(region);
    const readJsonArtifact = journal.readJsonArtifact.bind(journal);
    let releaseRead!: () => void;
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
    let observedRead!: () => void;
    const readObserved = new Promise<void>(resolve => { observedRead = resolve; });
    let intercept = true;
    journal.readJsonArtifact = async (...args: any[]) => {
      const value = await readJsonArtifact(...args);
      if (intercept && args[1] === `${operationId}.json`) {
        intercept = false;
        observedRead();
        await readReleased;
      }
      return value;
    };

    const marked = broker.markInvoked(prepared);
    await readObserved;
    const callback = callbackPut(url, ca, response);
    const completedBeforeRelease = await Promise.race([
      callback.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(completedBeforeRelease, false, "the callback write must wait behind the active invocation-state write");
    releaseRead();
    await marked;
    assert.equal((await callback).status, 200);
    journal.readJsonArtifact = readJsonArtifact;
    assert.equal((await broker.read(region, operationId))?.invocationStatus, "COMPLETED", "an immediate callback must remain terminal");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
