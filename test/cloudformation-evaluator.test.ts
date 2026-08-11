import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, GetTemplateCommand, GetTemplateSummaryCommand, ListStackResourcesCommand, waitUntilStackCreateComplete } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("official SDK processes parameters, conditions, dependencies, outputs, and NoEcho metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn02-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: CloudFormationClient | undefined;
  const template = JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "CFN-02 evaluator fixture",
    Metadata: { "AWS::Example": { version: 1 } },
    Parameters: { Environment: { Type: "String", Default: "dev", AllowedValues: ["dev", "prod"] }, Secret: { Type: "String", NoEcho: true } },
    Conditions: { IsDev: { "Fn::Equals": [{ Ref: "Environment" }, "dev"] }, IsProd: { "Fn::Not": [{ Condition: "IsDev" }] } },
    Resources: {
      First: { Type: "AWS::CDK::Metadata", Condition: "IsDev", Properties: { Analytics: { "Fn::Sub": "${AWS::StackName}-${Environment}" } } },
      Second: { Type: "AWS::CDK::Metadata", DependsOn: "First", Properties: { Analytics: "second" } },
      InactiveQueue: { Type: "AWS::SQS::Queue", Condition: "IsProd" },
    },
    Outputs: { Greeting: { Condition: "IsDev", Value: { "Fn::Join": [":", [{ Ref: "AWS::Region" }, { Ref: "Environment" }]] } } },
  });
  try {
    await simulator.start(); client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const summary = await client.send(new GetTemplateSummaryCommand({ TemplateBody: template })); assert.equal(summary.Description, "CFN-02 evaluator fixture"); assert.deepEqual(summary.ResourceTypes, ["AWS::CDK::Metadata", "AWS::SQS::Queue"]); assert.equal(summary.Parameters?.find(parameter => parameter.ParameterKey === "Secret")?.NoEcho, true); assert.deepEqual(JSON.parse(summary.Metadata!), { "AWS::Example": { version: 1 } });
    const created = await client.send(new CreateStackCommand({ StackName: "evaluator-stack", TemplateBody: template, Parameters: [{ ParameterKey: "Secret", ParameterValue: "private-value" }] })); assert.equal((await waitUntilStackCreateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    const stack = (await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]; assert.equal(stack?.Outputs?.[0]?.OutputValue, "eu-west-1:dev"); assert.equal(stack?.Parameters?.find(parameter => parameter.ParameterKey === "Secret")?.ParameterValue, "****");
    assert.deepEqual(JSON.parse((await client.send(new GetTemplateSummaryCommand({ StackName: created.StackId }))).Metadata!), { "AWS::Example": { version: 1 } });
    assert.deepEqual((await client.send(new ListStackResourcesCommand({ StackName: created.StackId }))).StackResourceSummaries?.map(resource => resource.LogicalResourceId), ["First", "Second"]);
    const processed = JSON.parse(String((await client.send(new GetTemplateCommand({ StackName: created.StackId, TemplateStage: "Processed" }))).TemplateBody)); assert.deepEqual(Object.keys(processed.Resources), ["First", "Second"]); assert.equal(processed.Resources.InactiveQueue, undefined);

    client.destroy(); client = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); await simulator.start(); client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const restarted = (await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
    assert.equal(restarted?.StackStatus, "CREATE_COMPLETE"); assert.equal(restarted?.Outputs?.[0]?.OutputValue, "eu-west-1:dev"); assert.equal(restarted?.Parameters?.find(parameter => parameter.ParameterKey === "Secret")?.ParameterValue, "****");
    assert.deepEqual((await client.send(new ListStackResourcesCommand({ StackName: created.StackId }))).StackResourceSummaries?.map(resource => resource.LogicalResourceId), ["First", "Second"]);
    const restartedOriginal = JSON.parse(String((await client.send(new GetTemplateCommand({ StackName: created.StackId, TemplateStage: "Original" }))).TemplateBody));
    const restartedProcessed = JSON.parse(String((await client.send(new GetTemplateCommand({ StackName: created.StackId, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(restartedOriginal.Resources.InactiveQueue.Type, "AWS::SQS::Queue"); assert.deepEqual(restartedProcessed, processed); assert.equal(JSON.stringify(restartedProcessed).includes("private-value"), false);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("public admission rejects an unsupported provider attribute before any dependent mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn02-getatt-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let cloudformation: CloudFormationClient | undefined; let dynamodb: DynamoDBClient | undefined;
  const tableName = "cfn02-invalid-attribute-table";
  const template = JSON.stringify({
    Resources: {
      Table: {
        Type: "AWS::DynamoDB::Table",
        Properties: { TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] },
      },
      Consumer: { Type: "AWS::CDK::Metadata", Properties: { Analytics: { "Fn::GetAtt": ["Table", "DefinitelyNotAnAttribute"] } } },
    },
  });
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials }); dynamodb = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials });
    await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "cfn02-invalid-getatt", TemplateBody: template })), (error: any) => {
      assert.equal(error.name, "ValidationError"); assert.match(error.message, /unsupported attribute Table\.DefinitelyNotAnAttribute/); return true;
    });
    await assert.rejects(dynamodb.send(new DescribeTableCommand({ TableName: tableName })), (error: any) => error.name === "ResourceNotFoundException");
  } finally { cloudformation?.destroy(); dynamodb?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
