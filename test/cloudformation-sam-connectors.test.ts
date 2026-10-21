import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Capability,
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";

// sam-transform-design.md SAM-06 acceptance: a connector-based tutorial shape
// deployed under IAM enforcement. The source can do exactly the connector's
// Read/Write actions; a restart keeps the generated policies enforced; and
// removing the connectors on redeploy removes what they generated and denies
// the access again.

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const capabilities: Capability[] = ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"];
const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const block = (source: string, indent: string) => source.trim().split("\n").map(line => `${indent}${line}`).join("\n");

/** Each op is one call the worker's connectors allow (or, for receive and describe, do not). */
const WORKER = `
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { ReceiveMessageCommand, SendMessageCommand, SQSClient } = require("@aws-sdk/client-sqs");
const { PublishCommand, SNSClient } = require("@aws-sdk/client-sns");
const { DescribeStateMachineCommand, SFNClient, StartExecutionCommand } = require("@aws-sdk/client-sfn");
const ops = {
  put: () => new DynamoDBClient({}).send(new PutItemCommand({ TableName: process.env.TABLE, Item: { id: { S: "note" } } })),
  get: () => new DynamoDBClient({}).send(new GetItemCommand({ TableName: process.env.TABLE, Key: { id: { S: "note" } } })),
  send: () => new SQSClient({}).send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: "from the worker" })),
  receive: () => new SQSClient({}).send(new ReceiveMessageCommand({ QueueUrl: process.env.QUEUE_URL })),
  publish: () => new SNSClient({}).send(new PublishCommand({ TopicArn: process.env.TOPIC, Message: "from the worker" })),
  start: () => new SFNClient({}).send(new StartExecutionCommand({ stateMachineArn: process.env.WORKFLOW })),
  describe: () => new SFNClient({}).send(new DescribeStateMachineCommand({ stateMachineArn: process.env.WORKFLOW })),
};
exports.handler = async (event) => {
  if (event.requestContext) return { statusCode: 200, body: "hello through the connector" };
  try { await ops[event.op](); return "allowed"; } catch (error) { return \`\${error.name}: \${error.message}\`; }
};`;

function template(withConnectors: boolean): string {
  const connectors = (text: string) => withConnectors ? text : "";
  return `Transform: AWS::Serverless-2016-10-31
Resources:
  Notes:
    Type: AWS::Serverless::SimpleTable
  Jobs:
    Type: AWS::SQS::Queue
  Alerts:
    Type: AWS::SNS::Topic
  AlertInbox:
    Type: AWS::SQS::Queue
  AlertSubscription:
    Type: AWS::SNS::Subscription
    Properties:
      TopicArn: !Ref Alerts
      Protocol: sqs
      Endpoint: !GetAtt AlertInbox.Arn
      RawMessageDelivery: true
  RuleInbox:
    Type: AWS::SQS::Queue
  Workflow:
    Type: AWS::Serverless::StateMachine
    Properties:
      Definition:
        StartAt: Done
        States:
          Done:
            Type: Succeed
  Worker:
    Type: AWS::Serverless::Function
${connectors(`    Connectors:
      NotesAccess:
        Properties:
          Destination:
            Id: Notes
          Permissions: [Read, Write]
      JobsSend:
        Properties:
          Destination:
            Id: Jobs
          Permissions: [Write]
      AlertsPublish:
        Properties:
          Destination:
            Id: Alerts
          Permissions: [Write]
      WorkflowStart:
        Properties:
          Destination:
            Id: Workflow
          Permissions: [Write]
`)}    Properties:
      Runtime: nodejs22.x
      Handler: index.handler
      Timeout: 10
      InlineCode: |
${block(WORKER, "        ")}
      Environment:
        Variables:
          TABLE: !Ref Notes
          QUEUE_URL: !Ref Jobs
          TOPIC: !Ref Alerts
          WORKFLOW: !Ref Workflow
  Api:
    Type: AWS::Serverless::HttpApi
    Properties:
      DefinitionBody:
        openapi: '3.0.1'
        info:
          title: connectors
          version: '1.0'
        paths:
          /hello:
            get:
              x-amazon-apigateway-integration:
                type: aws_proxy
                httpMethod: POST
                payloadFormatVersion: '2.0'
                uri: !Sub arn:\${AWS::Partition}:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${Worker.Arn}/invocations
  Rule:
    Type: AWS::Events::Rule
    Properties:
      EventPattern:
        source: [connector.test]
      Targets:
      - Id: inbox
        Arn: !GetAtt RuleInbox.Arn
      - Id: alerts
        Arn: !Ref Alerts
${connectors(`  ApiToWorker:
    Type: AWS::Serverless::Connector
    Properties:
      Source:
        Id: Api
      Destination:
        Id: Worker
      Permissions: [Write]
  RuleToTargets:
    Type: AWS::Serverless::Connector
    Properties:
      Source:
        Id: Rule
      Destination:
      - Id: RuleInbox
      - Id: Alerts
      Permissions: [Write]
  AlertsToInbox:
    Type: AWS::Serverless::Connector
    Properties:
      Source:
        Id: Alerts
      Destination:
        Id: AlertInbox
      Permissions: [Write]
`)}`;
}

/** What the connectors generate, by logical ID. */
const GENERATED = {
  WorkerNotesAccessPolicy: "AWS::IAM::ManagedPolicy",
  WorkerJobsSendPolicy: "AWS::IAM::ManagedPolicy",
  WorkerAlertsPublishPolicy: "AWS::IAM::ManagedPolicy",
  WorkerWorkflowStartPolicy: "AWS::IAM::ManagedPolicy",
  ApiToWorkerWriteLambdaPermission: "AWS::Lambda::Permission",
  RuleToTargetsQueuePolicyDestination0: "AWS::SQS::QueuePolicy",
  RuleToTargetsTopicPolicyDestination1: "AWS::SNS::TopicPolicy",
  AlertsToInboxQueuePolicy: "AWS::SQS::QueuePolicy",
};

interface Clients {
  cloudformation: CloudFormationClient;
  lambda: LambdaClient;
  events: EventBridgeClient;
  sqs: SQSClient;
}

function clientsFor(simulator: StackSim): Clients {
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
  return { cloudformation: new CloudFormationClient(options), lambda: new LambdaClient(options), events: new EventBridgeClient(options), sqs: new SQSClient(options) };
}

const destroy = (clients: Clients | undefined) => { for (const client of Object.values(clients ?? {})) client.destroy(); };

async function physical(clients: Clients, logicalId: string): Promise<string> {
  return (await clients.cloudformation.send(new DescribeStackResourceCommand({ StackName: "connectors", LogicalResourceId: logicalId }))).StackResourceDetail!.PhysicalResourceId!;
}

/** An SQS queue's physical ID is its name. */
async function queueUrl(clients: Clients, logicalId: string): Promise<string> {
  return (await clients.sqs.send(new GetQueueUrlCommand({ QueueName: await physical(clients, logicalId) }))).QueueUrl!;
}

async function attempt(clients: Clients, worker: string, op: string): Promise<string> {
  const response = await clients.lambda.send(new InvokeCommand({ FunctionName: worker, Payload: Buffer.from(JSON.stringify({ op })) }));
  assert.equal(response.FunctionError, undefined, Buffer.from(response.Payload ?? []).toString());
  return JSON.parse(Buffer.from(response.Payload!).toString());
}

/** GET /hello on the HTTP API's local host-based endpoint. */
function callApi(simulator: StackSim, apiId: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const port = simulator.invokePort;
    const outgoing = request({ host: "127.0.0.1", port, method: "GET", path: "/hello", headers: { host: `${apiId}.execute-api.localhost:${port}` } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** The first message whose body is the given text, or an event carrying the given marker; received messages stay hidden. */
async function receive(clients: Clients, queueUrl: string, expected: string, attempts = 100): Promise<string | undefined> {
  const matches = (body: string) => {
    if (body === expected) return true;
    try { return JSON.parse(body).detail?.marker === expected; } catch { return false; }
  };
  for (let index = 0; index < attempts; index++) {
    const messages = (await clients.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }))).Messages ?? [];
    const found = messages.find(message => matches(message.Body ?? ""));
    if (found) return found.Body;
    await sleep(50);
  }
  return undefined;
}

async function putEvent(clients: Clients, marker: string): Promise<void> {
  const result = await clients.events.send(new PutEventsCommand({ Entries: [{ Source: "connector.test", DetailType: "Test", Detail: JSON.stringify({ marker }) }] }));
  assert.equal(result.FailedEntryCount, 0);
}

/** Every connector's access is allowed, and nothing beyond the categories it names. */
async function assertConnectedAccess(simulator: StackSim, clients: Clients, marker: string): Promise<void> {
  const worker = await physical(clients, "Worker");
  assert.equal(await attempt(clients, worker, "put"), "allowed");
  assert.equal(await attempt(clients, worker, "get"), "allowed");
  assert.equal(await attempt(clients, worker, "send"), "allowed");
  assert.equal(await attempt(clients, worker, "publish"), "allowed");
  assert.equal(await attempt(clients, worker, "start"), "allowed");
  // Write to the queue and the state machine does not grant Read.
  assert.match(await attempt(clients, worker, "receive"), /AccessDenied/);
  assert.match(await attempt(clients, worker, "describe"), /AccessDenied/);

  const api = await callApi(simulator, await physical(clients, "Api"));
  assert.deepEqual(api, { status: 200, body: "hello through the connector" });

  // The worker's publish reached the topic's subscribed queue, which admits the topic.
  const alertInbox = await queueUrl(clients, "AlertInbox");
  assert.ok(await receive(clients, alertInbox, "from the worker"), "SNS delivers to the queue its policy admits");

  await putEvent(clients, marker);
  assert.ok(await receive(clients, await queueUrl(clients, "RuleInbox"), marker), "EventBridge delivers to the queue its policy admits");
  // The topic policy admits the rule, and the queue policy admits the topic.
  assert.ok(await receive(clients, alertInbox, marker), "EventBridge publishes to the topic, which delivers to its subscribed queue");
}

test("SAM connectors deploy under IAM enforcement, grant exactly their access, survive a restart, and are removed on redeploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam06-connectors-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let clients: Clients | undefined;
  try {
    await simulator.start();
    clients = clientsFor(simulator);
    await clients.cloudformation.send(new CreateStackCommand({ StackName: "connectors", TemplateBody: template(true), Capabilities: capabilities }));
    const created = await waitUntilStackCreateComplete({ client: clients.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 120 }, { StackName: "connectors" });
    assert.equal(created.state, "SUCCESS", JSON.stringify(created.reason));

    // The processed template carries what the connectors generated, with their metadata.
    const processed = JSON.parse(String((await clients.cloudformation.send(new GetTemplateCommand({ StackName: "connectors", TemplateStage: "Processed" }))).TemplateBody));
    for (const [logicalId, type] of Object.entries(GENERATED)) assert.equal(processed.Resources[logicalId]?.Type, type, logicalId);
    assert.deepEqual(processed.Resources.WorkerNotesAccessPolicy.Metadata, { "aws:sam:connectors": { WorkerNotesAccess: { Source: { Type: "AWS::Serverless::Function" }, Destination: { Type: "AWS::Serverless::SimpleTable" } } } });
    assert.deepEqual(processed.Resources.WorkerJobsSendPolicy.Properties.Roles, [{ Ref: "WorkerRole" }]);

    await assertConnectedAccess(simulator, clients, "first");

    // A restart keeps the generated policies, and they stay enforced. It reuses the
    // ports, as a real restart does: the worker's QUEUE_URL (a queue Ref) names the port.
    destroy(clients);
    clients = undefined;
    const ports = { port: simulator.port, invokePort: simulator.invokePort };
    await simulator.stop();
    simulator = new StackSim({ ...ports, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    clients = clientsFor(simulator);
    await assertConnectedAccess(simulator, clients, "after-restart");

    // Removing the connectors removes what they generated, and the access is denied again.
    await clients.cloudformation.send(new UpdateStackCommand({ StackName: "connectors", TemplateBody: template(false), Capabilities: capabilities }));
    const updated = await waitUntilStackUpdateComplete({ client: clients.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 120 }, { StackName: "connectors" });
    assert.equal(updated.state, "SUCCESS", JSON.stringify(updated.reason));
    const remaining = new Set(((await clients.cloudformation.send(new ListStackResourcesCommand({ StackName: "connectors" }))).StackResourceSummaries ?? []).map(resource => resource.LogicalResourceId));
    for (const logicalId of Object.keys(GENERATED)) assert.ok(!remaining.has(logicalId), `${logicalId} is deleted`);

    const worker = await physical(clients, "Worker");
    // StackSim reports the SNS identity denial as AccessDenied; AWS SNS names it AuthorizationError.
    for (const op of ["put", "get", "send", "publish", "start"]) assert.match(await attempt(clients, worker, op), /AccessDenied|AuthorizationError/, op);
    const api = await callApi(simulator, await physical(clients, "Api"));
    assert.notEqual(api.status, 200, "API Gateway may no longer invoke the function");
    await putEvent(clients, "after-removal");
    assert.equal(await receive(clients, await queueUrl(clients, "RuleInbox"), "after-removal", 40), undefined, "the queue no longer admits EventBridge");
    assert.equal(await receive(clients, await queueUrl(clients, "AlertInbox"), "after-removal", 20), undefined, "the topic no longer admits EventBridge");
  } finally {
    destroy(clients);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a connector pair StackSim cannot back fails the change set and CreateStack, naming the pair, with no mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam06-unsupported-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let clients: Clients | undefined;
  try {
    await simulator.start();
    clients = clientsFor(simulator);
    const unsupported = `Transform: AWS::Serverless-2016-10-31
Resources:
  Bus:
    Type: AWS::Events::EventBus
    Properties:
      Name: orders
  Rule:
    Type: AWS::Events::Rule
    Connectors:
      ToBus:
        Properties:
          Destination:
            Id: Bus
          Permissions: [Write]
    Properties:
      EventPattern:
        source: [orders]
      Targets:
      - Id: bus
        Arn: !GetAtt Bus.Arn
        RoleArn: !GetAtt RuleRole.Arn
  RuleRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
        - Effect: Allow
          Principal:
            Service: events.amazonaws.com
          Action: sts:AssumeRole
`;
    const expected = "Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document. Number of errors found: 1. "
      + "Resource with id [RuleToBus] is invalid. Connector from AWS::Events::Rule to AWS::Events::EventBus is not supported by StackSim: EventBridge in StackSim cannot deliver to an event bus target.";
    const planned = await clients.cloudformation.send(new CreateChangeSetCommand({ StackName: "unsupported", ChangeSetName: "initial", ChangeSetType: "CREATE", TemplateBody: unsupported, Capabilities: capabilities }));
    const described = await clients.cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(described.Status, "FAILED");
    assert.equal(described.StatusReason, expected);
    await assert.rejects(clients.cloudformation.send(new CreateStackCommand({ StackName: "unsupported-direct", TemplateBody: unsupported, Capabilities: capabilities })), (error: any) => error.name === "ValidationError" && error.message === expected);
    await assert.rejects(clients.cloudformation.send(new DescribeStacksCommand({ StackName: "unsupported-direct" })), (error: any) => error.message === "Stack with id unsupported-direct does not exist");
    assert.deepEqual(Object.values(simulator.store.regionState(region).cloudformation.stacks).flatMap(stack => Object.keys(stack.resources)), []);
  } finally {
    destroy(clients);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
