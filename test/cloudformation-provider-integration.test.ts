import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand, GetTemplateSummaryCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient, ListTagsForResourceCommand } from "@aws-sdk/client-cognito-identity-provider";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

const anonymousRoleTemplate = JSON.stringify({
  Resources: {
    WorkerRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
        ManagedPolicyArns: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]] }],
        Tags: [{ Key: "environment", Value: "resource" }, { Key: "component", Value: "worker" }],
      },
    },
    UserPool: {
      Type: "AWS::Cognito::UserPool",
      Properties: { UserPoolName: "provider-integration-pool" },
    },
  },
  Outputs: {
    RoleName: { Value: { Ref: "WorkerRole" } },
    UserPoolArn: { Value: { "Fn::GetAtt": ["UserPool", "Arn"] } },
  },
});

const namedPolicyTemplate = JSON.stringify({
  Resources: {
    WorkerRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] } } },
    WorkerPolicy: { Type: "AWS::IAM::Policy", Properties: { PolicyName: "worker-access", Roles: [{ Ref: "WorkerRole" }], PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:GetItem", Resource: "*" }] } } },
  },
});

test("CloudFormation enforces exact IAM capabilities, resolves nested intrinsics, and propagates stack tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-provider-integration-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined; let cognito: CognitoIdentityProviderClient | undefined; let iam: IAMClient | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options); cognito = new CognitoIdentityProviderClient(options); iam = new IAMClient(options);

    assert.deepEqual((await cloudformation.send(new GetTemplateSummaryCommand({ TemplateBody: anonymousRoleTemplate }))).Capabilities, ["CAPABILITY_IAM"]);
    assert.deepEqual((await cloudformation.send(new GetTemplateSummaryCommand({ TemplateBody: namedPolicyTemplate }))).Capabilities, ["CAPABILITY_NAMED_IAM"]);
    await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "role-stack", TemplateBody: anonymousRoleTemplate })), error => (error as { name?: string }).name === "InsufficientCapabilitiesException");
    await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "named-policy-stack", TemplateBody: namedPolicyTemplate, Capabilities: ["CAPABILITY_IAM"] })), error => (error as { name?: string }).name === "InsufficientCapabilitiesException");

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "role-stack", TemplateBody: anonymousRoleTemplate, Capabilities: ["CAPABILITY_IAM"], Tags: [{ Key: "environment", Value: "stack" }, { Key: "owner", Value: "local" }] }));
    await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
    const roleName = stack?.Outputs?.find(output => output.OutputKey === "RoleName")?.OutputValue;
    assert.ok(roleName);
    let roleTags = Object.fromEntries(((await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role?.Tags ?? []).map(tag => [tag.Key!, tag.Value!]));
    assert.equal(roleTags.environment, "resource", "resource tags must override same-key stack tags");
    assert.equal(roleTags.owner, "local");
    assert.equal(roleTags.component, "worker");
    const userPoolArn = stack?.Outputs?.find(output => output.OutputKey === "UserPoolArn")?.OutputValue;
    assert.ok(userPoolArn);
    let userPoolTags = (await cognito.send(new ListTagsForResourceCommand({ ResourceArn: userPoolArn }))).Tags ?? {};
    assert.equal(userPoolTags.environment, "stack", "stack tags must retain Cognito's object-shaped UserPoolTags property when the template omits it");
    assert.equal(userPoolTags.owner, "local");

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, UsePreviousTemplate: true, Capabilities: ["CAPABILITY_IAM"], Tags: [{ Key: "environment", Value: "updated-stack" }, { Key: "owner", Value: "updated" }] }));
    await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    roleTags = Object.fromEntries(((await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role?.Tags ?? []).map(tag => [tag.Key!, tag.Value!]));
    assert.equal(roleTags.environment, "resource");
    assert.equal(roleTags.owner, "updated");
    userPoolTags = (await cognito.send(new ListTagsForResourceCommand({ ResourceArn: userPoolArn }))).Tags ?? {};
    assert.equal(userPoolTags.environment, "updated-stack");
    assert.equal(userPoolTags.owner, "updated");

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy(); cognito?.destroy(); iam?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
