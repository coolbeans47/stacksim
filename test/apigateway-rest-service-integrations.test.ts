import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APIGatewayClient, CreateDeploymentCommand, CreateResourceCommand, CreateRestApiCommand, GetResourcesCommand, PutIntegrationCommand, PutIntegrationResponseCommand, PutMethodCommand, PutMethodResponseCommand, TestInvokeMethodCommand } from "@aws-sdk/client-api-gateway";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateTopicCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { CreateStateMachineCommand, DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function role(iam: IAMClient, name: string, service: string, actions: string[]): Promise<string> {
  const created = await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] }) }));
  if (actions.length) await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: "integration", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: "*" }] }) }));
  return created.Role!.Arn!;
}

test("DPG-10 REST AWS integrations reach SNS, EventBridge, Step Functions, and S3 with service-shaped responses and role authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-service-integrations-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", accountId: account, region });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    // Until server.ts wires these at construction, connect the regional services the same way it would.
    simulator.apigateway.setIntegrationServices({ sns: simulator.sns, eventbridge: simulator.eventbridge, stepfunctions: simulator.stepfunctions, s3: simulator.s3 });
    const config = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials };
    const apig = new APIGatewayClient(config); const iam = new IAMClient(config); const sns = new SNSClient(config); const sqs = new SQSClient(config); const sfn = new SFNClient(config); const s3 = new S3Client({ ...config, forcePathStyle: true });
    clients.push(apig, iam, sns, sqs, sfn, s3);
    const integrationRole = await role(iam, "apig-services", "apigateway.amazonaws.com", ["sns:Publish", "events:PutEvents", "states:StartExecution", "states:DescribeExecution", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
    const powerless = await role(iam, "apig-powerless", "apigateway.amazonaws.com", []);

    const topic = (await sns.send(new CreateTopicCommand({ Name: "orders" }))).TopicArn!;
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "orders-copy" }))).QueueUrl!;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topic } } }] }) } }));
    await sns.send(new SubscribeCommand({ TopicArn: topic, Protocol: "sqs", Endpoint: queueArn, Attributes: { RawMessageDelivery: "true" } }));
    const machineRole = await role(iam, "sfn-pass", "states.amazonaws.com", []);
    const machine = (await sfn.send(new CreateStateMachineCommand({ name: "pass", roleArn: machineRole, definition: JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Pass", End: true } } }) }))).stateMachineArn!;
    await s3.send(new CreateBucketCommand({ Bucket: "apig-objects", CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3.send(new PutObjectCommand({ Bucket: "apig-objects", Key: "seed.txt", Body: "seeded", ContentType: "text/plain" }));

    const api = await apig.send(new CreateRestApiCommand({ name: "service-integrations" })); const apiId = api.id!;
    const rootId = (await apig.send(new GetResourcesCommand({ restApiId: apiId }))).items!.find(item => item.path === "/")!.id!;
    const resource = async (parentId: string, pathPart: string) => (await apig.send(new CreateResourceCommand({ restApiId: apiId, parentId, pathPart }))).id!;
    const method = async (resourceId: string, httpMethod: string, integration: Record<string, unknown>, requestParameters: Record<string, boolean> = {}) => {
      await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId, httpMethod, authorizationType: "NONE", requestParameters }));
      await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId, httpMethod, statusCode: "200" }));
      await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId, httpMethod, type: "AWS", credentials: integrationRole, ...integration } as any));
      await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId, httpMethod, statusCode: "200" }));
    };
    const snsParameters = { "integration.request.querystring.TopicArn": `'${topic}'`, "integration.request.querystring.Message": "method.request.querystring.message" };
    const publishXml = await resource(rootId, "publish"); await method(publishXml, "POST", { integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sns:action/Publish`, requestParameters: snsParameters }, { "method.request.querystring.message": true });
    const publishJson = await resource(rootId, "publish-json"); await method(publishJson, "POST", { integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sns:action/Publish`, requestParameters: { ...snsParameters, "integration.request.header.Accept": "'application/json'" } }, { "method.request.querystring.message": true });
    const publishDenied = await resource(rootId, "publish-denied"); await method(publishDenied, "POST", { integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sns:action/Publish`, credentials: powerless, requestParameters: snsParameters }, { "method.request.querystring.message": true });
    const events = await resource(rootId, "events"); await method(events, "POST", { integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:events:action/PutEvents` });
    const start = await resource(rootId, "start"); await method(start, "POST", { integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:states:action/StartExecution` });
    const describe = await resource(rootId, "describe"); await method(describe, "POST", { integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:states:action/DescribeExecution` });
    const files = await resource(rootId, "files"); const file = await resource(files, "{key}");
    for (const httpMethod of ["GET", "PUT"]) await method(file, httpMethod, { integrationHttpMethod: httpMethod, uri: `arn:aws:apigateway:${region}:s3:path/apig-objects/{object}`, requestParameters: { "integration.request.path.object": "method.request.path.key" } }, { "method.request.path.key": true });
    const noRole = await resource(rootId, "no-role");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: noRole, httpMethod: "POST", authorizationType: "NONE" }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: noRole, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:events:action/PutEvents` }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    const base = `http://127.0.0.1:${simulator.invokePort}/${apiId}/dev`;

    const xml = await fetch(`${base}/publish?message=hello%20xml`, { method: "POST" }); const xmlBody = await xml.text();
    assert.equal(xml.status, 200, xmlBody); assert.match(xmlBody, /^<\?xml[\s\S]*<PublishResponse xmlns="http:\/\/sns\.amazonaws\.com\/doc\/2010-03-31\/"><PublishResult><MessageId>[^<]+<\/MessageId><\/PublishResult><ResponseMetadata><RequestId>/, "SNS answers XML by default");
    const json = await fetch(`${base}/publish-json?message=hello%20json`, { method: "POST" }); const jsonBody = await json.json();
    assert.equal(json.status, 200); assert.ok(jsonBody.PublishResponse.PublishResult.MessageId, "Accept: application/json selects the JSON form");
    const delivered: string[] = []; for (let attempt = 0; attempt < 10 && delivered.length < 2; attempt++) delivered.push(...((await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }))).Messages ?? []).map(message => message.Body!));
    assert.deepEqual(delivered.sort(), ["hello json", "hello xml"]);
    const denied = await fetch(`${base}/publish-denied?message=nope`, { method: "POST" }); const deniedBody = await denied.text();
    assert.equal(denied.status, 200, "without a selection pattern the service error flows through the default integration response, as on AWS"); assert.match(deniedBody, /<Code>AuthorizationError<\/Code>/);

    const put = await fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Entries: [{ Source: "learning.orders", DetailType: "OrderPlaced", Detail: JSON.stringify({ id: 1 }) }] }) });
    const putBody = await put.json(); assert.equal(put.status, 200); assert.equal(putBody.FailedEntryCount, 0); assert.ok(putBody.Entries[0].EventId);

    const started = await fetch(`${base}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stateMachineArn: machine, input: JSON.stringify({ order: 1 }) }) });
    const startedBody = await started.json(); assert.equal(started.status, 200, JSON.stringify(startedBody)); assert.match(startedBody.executionArn, /^arn:aws:states:/); assert.equal(typeof startedBody.startDate, "number");
    const described = await fetch(`${base}/describe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ executionArn: startedBody.executionArn }) });
    const describedBody = await described.json(); assert.equal(described.status, 200); assert.equal(describedBody.executionArn, startedBody.executionArn); assert.equal(describedBody.input, JSON.stringify({ order: 1 }));
    assert.equal((await sfn.send(new DescribeExecutionCommand({ executionArn: startedBody.executionArn }))).stateMachineArn, machine);

    const seed = await fetch(`${base}/files/seed.txt`); assert.equal(seed.status, 200); assert.equal(await seed.text(), "seeded");
    const upload = await fetch(`${base}/files/uploaded.txt`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "from api gateway" }); assert.equal(upload.status, 200);
    assert.equal(await (await s3.send(new GetObjectCommand({ Bucket: "apig-objects", Key: "uploaded.txt" }))).Body!.transformToString(), "from api gateway");
    const missing = await apig.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: file, httpMethod: "GET", pathWithQueryString: "/files/absent.txt" }));
    assert.equal(missing.status, 200); assert.match(missing.body ?? "", /<Code>NoSuchKey<\/Code>/); assert.match(missing.log ?? "", /Endpoint response body before transformations/);

    const unsigned = await fetch(`${base}/no-role`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unsigned.status, 500, "a non-Lambda AWS integration without an execution role fails as a configuration error"); assert.deepEqual(await unsigned.json(), { message: "Internal server error" });
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
