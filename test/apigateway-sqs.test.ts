import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TestInvokeMethodCommand,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateQueueCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function queueArn(name: string): string { return `arn:aws:sqs:${region}:${account}:${name}`; }

async function integrationRole(iam: IAMClient, resources: string[]): Promise<string> {
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const role = await iam.send(new CreateRoleCommand({ RoleName: `apig-sqs-${Math.random().toString(36).slice(2)}`, AssumeRolePolicyDocument: trust }));
  await iam.send(new PutRolePolicyCommand({ RoleName: role.Role!.RoleName!, PolicyName: "send", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: resources }] }) }));
  return role.Role!.Arn!;
}

async function restResource(apig: APIGatewayClient, apiId: string, parentId: string, pathPart: string): Promise<string> {
  return (await apig.send(new CreateResourceCommand({ restApiId: apiId, parentId, pathPart }))).id!;
}

async function restMethod(apig: APIGatewayClient, apiId: string, resourceId: string): Promise<void> {
  await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId, httpMethod: "POST", authorizationType: "NONE" }));
  await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId, httpMethod: "POST", statusCode: "200" }));
}

async function restResponse(apig: APIGatewayClient, apiId: string, resourceId: string): Promise<void> {
  await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId, httpMethod: "POST", statusCode: "200" }));
}

async function bodies(sqs: SQSClient, queueUrl: string, count: number): Promise<string[]> {
  const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: count, WaitTimeSeconds: 0 }));
  return (response.Messages ?? []).map(message => message.Body ?? "").sort();
}

test("REST API SQS integrations support JSON actions, batches, documented path forms, and exact queue IAM", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-sqs-rest-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials };
    const apig = new APIGatewayClient(options); const iam = new IAMClient(options); const sqs = new SQSClient(options);
    clients.push(apig, iam, sqs);
    const queueNames = { action: "apig-action", path: "apig-path", batch: "apig-batch", denied: "apig-denied" };
    const queueUrls = Object.fromEntries(await Promise.all(Object.entries(queueNames).map(async ([key, name]) => [key, (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl!]))) as Record<keyof typeof queueNames, string>;
    const roleArn = await integrationRole(iam, [queueArn(queueNames.action), queueArn(queueNames.path), queueArn(queueNames.batch)]);
    const api = await apig.send(new CreateRestApiCommand({ name: "sqs-producers" }));
    const rootResource = (await apig.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;

    const action = await restResource(apig, api.id!, rootResource.id!, "action"); await restMethod(apig, api.id!, action);
    await apig.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: action, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sqs:action/SendMessage`, credentials: roleArn, requestTemplates: { "application/json": `{"QueueUrl":${JSON.stringify(queueUrls.action)},"MessageBody":"$util.escapeJavaScript($input.path('$.message'))"}` } }));
    await restResponse(apig, api.id!, action);
    const actionResult = await apig.send(new TestInvokeMethodCommand({ restApiId: api.id!, resourceId: action, httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "action mapped" }) }));
    assert.equal(actionResult.status, 200); assert.ok(JSON.parse(actionResult.body!).MessageId); assert.deepEqual(await bodies(sqs, queueUrls.action, 1), ["action mapped"]);

    const batch = await restResource(apig, api.id!, rootResource.id!, "batch"); await restMethod(apig, api.id!, batch);
    await apig.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: batch, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sqs:action/SendMessageBatch`, credentials: roleArn, requestTemplates: { "application/json": "$input.body" } }));
    await restResponse(apig, api.id!, batch);
    const batchResult = await apig.send(new TestInvokeMethodCommand({ restApiId: api.id!, resourceId: batch, httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ QueueUrl: queueUrls.batch, Entries: [{ Id: "one", MessageBody: "batch one" }, { Id: "two", MessageBody: "batch two" }] }) }));
    assert.equal(batchResult.status, 200); assert.equal(JSON.parse(batchResult.body!).Successful.length, 2); assert.deepEqual(await bodies(sqs, queueUrls.batch, 2), ["batch one", "batch two"]);
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrls.batch, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: roleArn }, Action: "sqs:SendMessage", Resource: queueArn(queueNames.batch) }] }) } }));
    await assert.rejects(apig.send(new TestInvokeMethodCommand({ restApiId: api.id!, resourceId: batch, httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ QueueUrl: queueUrls.batch, Entries: [{ Id: "denied", MessageBody: "must not arrive" }] }) })), (error: any) => error.name === "AccessDeniedException");

    const path = await restResource(apig, api.id!, rootResource.id!, "path"); await restMethod(apig, api.id!, path);
    await apig.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: path, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sqs:path/${account}/${queueNames.path}`, credentials: roleArn, requestParameters: { "integration.request.header.Content-Type": "'application/x-www-form-urlencoded'" }, requestTemplates: { "application/json": "Action=SendMessage&MessageBody=$util.urlEncode($input.path('$.message'))" } }));
    await restResponse(apig, api.id!, path);
    assert.equal((await apig.send(new TestInvokeMethodCommand({ restApiId: api.id!, resourceId: path, httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "path & form" }) }))).status, 200);
    assert.deepEqual(await bodies(sqs, queueUrls.path, 1), ["path & form"]);

    const denied = await restResource(apig, api.id!, rootResource.id!, "denied"); await restMethod(apig, api.id!, denied);
    await apig.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: denied, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sqs:action/SendMessage`, credentials: roleArn, requestTemplates: { "application/json": `{"QueueUrl":${JSON.stringify(queueUrls.denied)},"MessageBody":"denied"}` } }));
    await restResponse(apig, api.id!, denied);
    await assert.rejects(apig.send(new TestInvokeMethodCommand({ restApiId: api.id!, resourceId: denied, httpMethod: "POST", headers: { "content-type": "application/json" }, body: "{}" })), (error: any) => error.name === "AccessDeniedException");
    assert.deepEqual(await bodies(sqs, queueUrls.denied, 1), []);
  } finally {
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("HTTP API SQS-SendMessage evaluates request expressions, permits an omitted IntegrationUri, and scopes IAM to the queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-sqs-http-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials };
    const apig = new ApiGatewayV2Client(options); const iam = new IAMClient(options); const sqs = new SQSClient(options);
    clients.push(apig, iam, sqs);
    const allowedUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "http-api-allowed" }))).QueueUrl!;
    const deniedUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "http-api-denied" }))).QueueUrl!;
    const roleArn = await integrationRole(iam, [queueArn("http-api-allowed")]);
    const api = await apig.send(new CreateApiCommand({ Name: "sqs-http-producer", ProtocolType: "HTTP" }));
    await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationSubtype: "SQS-SendMessage", PayloadFormatVersion: "1.0", CredentialsArn: roleArn, RequestParameters: { QueueUrl: "$request.header.queueurl" } })), (error: any) => error.name === "BadRequestException" && /MessageBody/.test(error.message));
    await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationSubtype: "SQS-SendMessage", PayloadFormatVersion: "2.0", CredentialsArn: roleArn, RequestParameters: { QueueUrl: "$request.header.queueurl", MessageBody: "$request.body.message" } })), (error: any) => error.name === "BadRequestException");
    const integration = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationSubtype: "SQS-SendMessage", PayloadFormatVersion: "1.0", CredentialsArn: roleArn, RequestParameters: { QueueUrl: "$request.header.queueurl", MessageBody: "$request.body.message", DelaySeconds: "$request.querystring.delay", Region: region } }));
    assert.equal(integration.IntegrationUri, undefined); assert.equal(integration.IntegrationSubtype, "SQS-SendMessage");
    await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "POST /publish", Target: `integrations/${integration.IntegrationId}` }));
    await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "$default", AutoDeploy: true }));
    const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.ApiId}/publish?delay=0`;
    let response = await fetch(invoke, { method: "POST", headers: { "content-type": "application/json", queueurl: allowedUrl }, body: JSON.stringify({ message: "http expression" }) });
    assert.equal(response.status, 200); assert.ok((await response.json() as any).MessageId); assert.deepEqual(await bodies(sqs, allowedUrl, 1), ["http expression"]);
    response = await fetch(invoke, { method: "POST", headers: { "content-type": "application/json", queueurl: deniedUrl }, body: JSON.stringify({ message: "denied" }) });
    assert.equal(response.status, 500); assert.deepEqual(await bodies(sqs, deniedUrl, 1), []);
    response = await fetch(invoke, { method: "POST", headers: { "content-type": "application/json", queueurl: `${endpoint}/${account}/missing` }, body: JSON.stringify({ message: "missing" }) });
    assert.equal(response.status, 500);
  } finally {
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
