import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<any> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (stack?.StackStatus === expected) return stack;
    if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus === "ROLLBACK_COMPLETE") throw new Error(`${stackName} reached ${stack.StackStatus}: ${stack.StackStatusReason}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

const handler = `
const https = require("node:https");
exports.handler = async event => {
  const physicalId = event.PhysicalResourceId || "cfn14-handwritten-provider";
  const body = JSON.stringify({
    Status: "SUCCESS",
    PhysicalResourceId: physicalId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: {
      Message: event.RequestType + ":" + event.ResourceProperties.Value,
      Endpoint: process.env.AWS_ENDPOINT_URL,
      LambdaEndpoint: process.env.AWS_ENDPOINT_URL_LAMBDA,
      TrustedCallbackCA: Boolean(process.env.NODE_EXTRA_CA_CERTS)
    }
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-type": "", "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
};`;

function template(value: string): string {
  return JSON.stringify({
    Resources: {
      ProviderRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] } } },
      ProviderFunction: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["ProviderRole", "Arn"] }, Code: { ZipFile: handler }, Timeout: 5 } },
      Probe: { Type: "Custom::StackSimCfn14Probe", Properties: { ServiceToken: { "Fn::GetAtt": ["ProviderFunction", "Arn"] }, Value: value, ServiceTimeout: 30 } },
    },
    Outputs: {
      PhysicalId: { Value: { Ref: "Probe" } },
      Message: { Value: { "Fn::GetAtt": ["Probe", "Message"] } },
      Endpoint: { Value: { "Fn::GetAtt": ["Probe", "Endpoint"] } },
      LambdaEndpoint: { Value: { "Fn::GetAtt": ["Probe", "LambdaEndpoint"] } },
      TrustedCallbackCA: { Value: { "Fn::GetAtt": ["Probe", "TrustedCallbackCA"] } },
    },
  });
}

test("CFN-14 invokes a local ZIP Lambda through a one-use trusted HTTPS custom-resource callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-custom-resource-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "cfn14-handwritten", TemplateBody: template("v1"), Capabilities: ["CAPABILITY_IAM"] }));
    let stack = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    let outputs = Object.fromEntries((stack.Outputs ?? []).map((output: { OutputKey?: string; OutputValue?: string }) => [output.OutputKey!, output.OutputValue!]));
    assert.equal(outputs.PhysicalId, "cfn14-handwritten-provider");
    assert.equal(outputs.Message, "Create:v1");
    assert.match(outputs.Endpoint, /^https:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(outputs.LambdaEndpoint, outputs.Endpoint);
    assert.equal(outputs.TrustedCallbackCA, "true");

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("v2"), Capabilities: ["CAPABILITY_IAM"] }));
    stack = await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    outputs = Object.fromEntries((stack.Outputs ?? []).map((output: { OutputKey?: string; OutputValue?: string }) => [output.OutputKey!, output.OutputValue!]));
    assert.equal(outputs.PhysicalId, "cfn14-handwritten-provider");
    assert.equal(outputs.Message, "Update:v2");

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const failedCreateHandler = `
const https = require("node:https");
exports.handler = async event => {
  console.log("CFN14_FAILED_CREATE_EVENT " + JSON.stringify({ RequestType: event.RequestType, PhysicalResourceId: event.PhysicalResourceId }));
  const physicalId = event.PhysicalResourceId || "cfn14-failed-create-physical";
  const body = JSON.stringify({
    Status: event.RequestType === "Create" ? "FAILED" : "SUCCESS",
    Reason: event.RequestType === "Create" ? "intentional failed create after allocating state" : undefined,
    PhysicalResourceId: physicalId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {}
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

test("CFN-14 compensates a failed Create callback using its returned physical ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-failed-create-cleanup-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  const functionName = "cfn14-failed-create-cleanup-provider";
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const logs = new CloudWatchLogsClient(options);
    clients.push(cloudformation, logs);
    const templateBody = JSON.stringify({ Resources: {
      ProviderRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] } } },
      ProviderFunction: { Type: "AWS::Lambda::Function", Properties: { FunctionName: functionName, Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["ProviderRole", "Arn"] }, Code: { ZipFile: failedCreateHandler }, Timeout: 5 } },
      Probe: { Type: "Custom::StackSimCfn14FailedCreate", Properties: { ServiceToken: { "Fn::GetAtt": ["ProviderFunction", "Arn"] }, ServiceTimeout: 30 } },
    } });

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "cfn14-failed-create-cleanup", TemplateBody: templateBody, Capabilities: ["CAPABILITY_IAM"] }));
    let terminal: any;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      terminal = (await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
      if (terminal?.StackStatus === "ROLLBACK_COMPLETE") break;
      if (terminal?.StackStatus === "ROLLBACK_FAILED") assert.fail(terminal.StackStatusReason);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(terminal?.StackStatus, "ROLLBACK_COMPLETE");

    let messages = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { messages = (await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}` }))).events?.map(event => event.message ?? "").join("\n") ?? ""; }
      catch (error: any) { if (error?.name !== "ResourceNotFoundException") throw error; }
      if ((messages.match(/CFN14_FAILED_CREATE_EVENT/g) ?? []).length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(messages, /CFN14_FAILED_CREATE_EVENT \{"RequestType":"Create"\}/);
    assert.match(messages, /CFN14_FAILED_CREATE_EVENT \{"RequestType":"Delete","PhysicalResourceId":"cfn14-failed-create-physical"\}/, "rollback must pass the failed callback's physical ID to Delete");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
