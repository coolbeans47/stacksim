import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeEventsCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { APIGatewayClient, GetRestApisCommand } from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  GetApisCommand,
  GetDeploymentsCommand,
  GetIntegrationsCommand,
  GetStagesCommand,
} from "@aws-sdk/client-apigatewayv2";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CreateAccessKeyCommand,
  CreateRoleCommand,
  CreateUserCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DescribeDBParameterGroupsCommand, RDSClient } from "@aws-sdk/client-rds";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  CDK_BOOTSTRAP_POLICY_NAME,
  cdkBootstrapNames,
} from "../src/cloudformation/bootstrap.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStack(client: CloudFormationClient, stack: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = (await client.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stack} to reach ${expected}`);
}

async function waitForChangeSet(client: CloudFormationClient, id: string): Promise<any> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await client.send(new DescribeChangeSetCommand({ ChangeSetName: id, IncludePropertyValues: true }));
    if (result.Status === "CREATE_COMPLETE" || result.Status === "FAILED") return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for change set ${id}`);
}

function policyDocument(input: string | undefined): any {
  if (!input) throw new Error("Expected an IAM policy document");
  const decoded = decodeURIComponent(input);
  return JSON.parse(decoded);
}

test("CloudFormation execution-role permissions and same-stack PassRole ownership are enforced before provider mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-provider-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const dynamodb = new DynamoDBClient(options);
    const iam = new IAMClient(options);
    const lambda = new LambdaClient(options);
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    clients.push(cloudformation, dynamodb, iam, lambda, s3);

    const names = cdkBootstrapNames("000000000000", region);
    const executionRoleName = names.roleNames.cloudFormationExecution;
    await s3.send(new PutObjectCommand({ Bucket: names.bucketName, Key: "assets/denied.zip", Body: Buffer.from("authorization must fail before ZIP parsing") }));
    const current = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    for (const statement of current.Statement ?? []) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      statement.Action = actions.filter((action: unknown) => action !== "dynamodb:CreateTable" && action !== "s3:GetObject" && action !== "s3:GetObjectVersion");
    }
    current.Statement = (current.Statement ?? []).filter((statement: any) => Array.isArray(statement.Action) ? statement.Action.length > 0 : Boolean(statement.Action));
    await iam.send(new PutRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(current) }));

    const deniedAssetTemplate = JSON.stringify({
      Resources: {
        DeniedAssetFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: "cfn-denied-asset",
            Runtime: "nodejs22.x",
            Handler: "index.handler",
            Role: "arn:aws:iam::000000000000:role/not-used-before-asset-authorization",
            Code: { S3Bucket: names.bucketName, S3Key: "assets/denied.zip" },
          },
        },
      },
    });
    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "denied-asset", TemplateBody: deniedAssetTemplate, RoleARN: names.roleArns.cloudFormationExecution })),
      error => /s3:GetObject|AccessDenied/i.test((error as Error).message),
    );
    await assert.rejects(lambda.send(new GetFunctionCommand({ FunctionName: "cfn-denied-asset" })), error => (error as { name?: string }).name === "ResourceNotFoundException");

    const deniedTableTemplate = JSON.stringify({
      Resources: {
        DeniedTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: {
            TableName: "CfnDeniedTable",
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
            KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          },
        },
      },
    });
    const deniedTable = await cloudformation.send(new CreateStackCommand({ StackName: "denied-table", TemplateBody: deniedTableTemplate, RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, deniedTable.StackId!, "ROLLBACK_COMPLETE");
    const tableEvents = await cloudformation.send(new DescribeStackEventsCommand({ StackName: deniedTable.StackId }));
    assert.ok(tableEvents.StackEvents?.some(event => event.LogicalResourceId === "DeniedTable" && event.ResourceStatus === "CREATE_FAILED" && /dynamodb:CreateTable|AccessDenied/i.test(event.ResourceStatusReason ?? "")));
    await assert.rejects(dynamodb.send(new DescribeTableCommand({ TableName: "CfnDeniedTable" })), error => (error as { name?: string }).name === "ResourceNotFoundException");

    const external = await iam.send(new CreateRoleCommand({
      RoleName: "external-lambda-role",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    }));
    const deniedPassRoleTemplate = JSON.stringify({
      Resources: {
        DeniedFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: "cfn-denied-pass-role",
            Runtime: "nodejs22.x",
            Handler: "index.handler",
            Role: external.Role!.Arn,
            Code: { ZipFile: "exports.handler = async () => ({ ok: true });" },
          },
        },
      },
    });
    const deniedFunction = await cloudformation.send(new CreateStackCommand({ StackName: "denied-pass-role", TemplateBody: deniedPassRoleTemplate, RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, deniedFunction.StackId!, "ROLLBACK_COMPLETE");
    const functionEvents = await cloudformation.send(new DescribeStackEventsCommand({ StackName: deniedFunction.StackId }));
    assert.ok(functionEvents.StackEvents?.some(event => event.LogicalResourceId === "DeniedFunction" && event.ResourceStatus === "CREATE_FAILED" && /owned by this stack|iam:PassRole/i.test(event.ResourceStatusReason ?? "")));
    await assert.rejects(lambda.send(new GetFunctionCommand({ FunctionName: "cfn-denied-pass-role" })), error => (error as { name?: string }).name === "ResourceNotFoundException");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-18 rich GlobalTable create preauthorizes every recovery and settings action before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn18-global-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const dynamodb = new DynamoDBClient(options); const iam = new IAMClient(options); clients.push(cloudformation, dynamodb, iam);
    const names = cdkBootstrapNames("000000000000", region); const roleName = names.roleNames.cloudFormationExecution;
    const original = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    const required = ["dynamodb:DescribeTable", "dynamodb:ListTagsOfResource", "dynamodb:DescribeContinuousBackups", "dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:UpdateContinuousBackups", "dynamodb:TagResource", "dynamodb:DeleteTable"];
    for (const [position, missing] of required.entries()) {
      const restricted = structuredClone(original);
      for (const statement of restricted.Statement ?? []) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        statement.Action = actions.filter((action: unknown) => action !== missing);
      }
      await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(restricted) }));
      const tableName = `cfn18-denied-${position}`;
      const template = JSON.stringify({ Resources: { RichTable: { Type: "AWS::DynamoDB::GlobalTable", Properties: { TableName: tableName, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], Replicas: [{ Region: region, DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 }, TableClass: "STANDARD", Tags: [{ Key: "scope", Value: "cfn18" }] }], SSESpecification: { SSEEnabled: false } } } } });
      const created = await cloudformation.send(new CreateStackCommand({ StackName: `cfn18-denied-${position}`, TemplateBody: template, RoleARN: names.roleArns.cloudFormationExecution }));
      await waitForStack(cloudformation, created.StackId!, "ROLLBACK_COMPLETE");
      const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
      assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "RichTable" && event.ResourceStatus === "CREATE_FAILED" && (event.ResourceStatusReason ?? "").includes(missing)), `missing ${missing} was not reported`);
      await assert.rejects(dynamodb.send(new DescribeTableCommand({ TableName: tableName })), error => (error as any).name === "ResourceNotFoundException");
      await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(original) }));
    }
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("DBParameterGroup CREATE preauthorizes rollback deletion before provider mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-rds-create-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const iam = new IAMClient(options);
    const rds = new RDSClient(options);
    clients.push(cloudformation, iam, rds);

    const names = cdkBootstrapNames("000000000000", region);
    const executionRoleName = names.roleNames.cloudFormationExecution;
    const document = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    for (const statement of document.Statement ?? []) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      statement.Action = actions.filter((action: unknown) => action !== "rds:DeleteDBParameterGroup");
    }
    await iam.send(new PutRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(document) }));

    const template = JSON.stringify({ Resources: {
      ParameterGroup: {
        Type: "AWS::RDS::DBParameterGroup",
        Properties: {
          Family: "mysql8.0",
          Description: "Must not be created without rollback cleanup authorization",
          Parameters: { max_connections: "120" },
        },
      },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "rds-delete-preauthorization", TemplateBody: template, RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, created.StackId!, "ROLLBACK_COMPLETE");

    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "ParameterGroup" && event.ResourceStatus === "CREATE_FAILED" && /rds:DeleteDBParameterGroup|AccessDenied/i.test(event.ResourceStatusReason ?? "")));
    assert.deepEqual(simulator.store.regionState(region).rdsDbParameterGroups, {}, "provider mutation must not happen before all CREATE and cleanup actions are authorized");
    const groups = await rds.send(new DescribeDBParameterGroupsCommand({}));
    assert.deepEqual(groups.DBParameterGroups?.map(group => group.DBParameterGroupName), ["default.mysql8.0"]);
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "rds:DeleteDBParameterGroup" && decision.decision !== "allowed"));
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("DBParameterGroup replacement CREATE authorizes the generated new ARN instead of the old ARN", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-rds-replacement-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const iam = new IAMClient(options);
    const rds = new RDSClient(options);
    clients.push(cloudformation, iam, rds);

    const names = cdkBootstrapNames("000000000000", region);
    const template = (description: string) => JSON.stringify({ Resources: {
      ParameterGroup: {
        Type: "AWS::RDS::DBParameterGroup",
        Properties: { Family: "mysql8.0", Description: description, Parameters: { max_connections: "120" } },
      },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "rds-replacement-auth", TemplateBody: template("before replacement"), RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");

    const oldGroups = (await rds.send(new DescribeDBParameterGroupsCommand({}))).DBParameterGroups?.filter(group => group.DBParameterGroupName !== "default.mysql8.0") ?? [];
    assert.equal(oldGroups.length, 1);
    const oldName = oldGroups[0]!.DBParameterGroupName!;
    const oldArn = oldGroups[0]!.DBParameterGroupArn!;

    const executionRoleName = names.roleNames.cloudFormationExecution;
    const document = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    const generatedArnScope = `arn:aws:rds:${region}:000000000000:pg:rds-replacement-auth-parametergroup-*`;
    for (const statement of document.Statement ?? []) if (statement.Sid === "ManageRdsResources") statement.Resource = generatedArnScope;
    document.Statement = (document.Statement ?? []).filter((statement: any) => statement.Sid === "ManageRdsResources");
    document.Statement.push({
      Sid: "DenyParameterGroupCreateAgainstOldPhysicalId",
      Effect: "Deny",
      Action: "rds:CreateDBParameterGroup",
      Resource: oldArn,
    });
    await iam.send(new PutRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(document) }));
    const decisionStart = simulator.store.ensureAccount().iam.authorizationDecisions.length;

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("after replacement") }));
    await waitForStack(cloudformation, created.StackId!, "UPDATE_COMPLETE");

    const newGroups = (await rds.send(new DescribeDBParameterGroupsCommand({}))).DBParameterGroups?.filter(group => group.DBParameterGroupName !== "default.mysql8.0") ?? [];
    assert.equal(newGroups.length, 1);
    const newName = newGroups[0]!.DBParameterGroupName!;
    const newArn = newGroups[0]!.DBParameterGroupArn!;
    assert.notEqual(newName, oldName);
    assert.match(newArn, /^arn:aws:rds:eu-west-1:000000000000:pg:rds-replacement-auth-parametergroup-/);

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions.slice(decisionStart);
    assert.ok(decisions.some(decision => decision.action === "rds:CreateDBParameterGroup" && decision.resource === newArn && decision.decision === "allowed"));
    assert.ok(!decisions.some(decision => decision.action === "rds:CreateDBParameterGroup" && decision.resource === oldArn), "replacement CREATE authorization must never reuse the old physical ARN");
    assert.ok(decisions.some(decision => decision.action === "rds:DeleteDBParameterGroup" && decision.resource === oldArn && decision.decision === "allowed"));

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("API Gateway v2 CREATE preauthorizes rollback deletion before provider mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-apigv2-create-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const iam = new IAMClient(options);
    const apigatewayv2 = new ApiGatewayV2Client(options);
    clients.push(cloudformation, iam, apigatewayv2);

    const names = cdkBootstrapNames("000000000000", region);
    const executionRoleName = names.roleNames.cloudFormationExecution;
    const document = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    for (const statement of document.Statement ?? []) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      statement.Action = actions.filter((action: unknown) => action !== "apigateway:DELETE");
    }
    await iam.send(new PutRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(document) }));

    const template = JSON.stringify({ Resources: {
      Api: { Type: "AWS::ApiGatewayV2::Api", Properties: { Name: "cfn12-delete-preauthorization", ProtocolType: "HTTP" } },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "apigv2-delete-preauthorization", TemplateBody: template, RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, created.StackId!, "ROLLBACK_COMPLETE");

    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "Api" && event.ResourceStatus === "CREATE_FAILED" && /apigateway:DELETE|AccessDenied/i.test(event.ResourceStatusReason ?? "")));
    assert.equal((await apigatewayv2.send(new GetApisCommand({ MaxResults: "500" }))).Items?.length ?? 0, 0, "API mutation must not happen before CREATE cleanup is authorized");
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "apigateway:DELETE" && decision.decision !== "allowed"));
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("API Gateway v2 Integration UPDATE preauthorizes a new CredentialsArn before mutation or AutoDeploy cutover", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-apigv2-update-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const iam = new IAMClient(options);
    const apigatewayv2 = new ApiGatewayV2Client(options);
    clients.push(cloudformation, iam, apigatewayv2);

    const accountId = "000000000000";
    const names = cdkBootstrapNames(accountId, region);
    const oldRoleName = "cfn12-integration-role-old";
    const newRoleName = "cfn12-integration-role-new";
    const oldRoleArn = `arn:aws:iam::${accountId}:role/${oldRoleName}`;
    const newRoleArn = `arn:aws:iam::${accountId}:role/${newRoleName}`;
    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] };
    const template = (replacement: boolean) => JSON.stringify({ Resources: {
      OldIntegrationRole: { Type: "AWS::IAM::Role", Properties: { RoleName: oldRoleName, AssumeRolePolicyDocument: trust } },
      NewIntegrationRole: { Type: "AWS::IAM::Role", Properties: { RoleName: newRoleName, AssumeRolePolicyDocument: trust } },
      Api: { Type: "AWS::ApiGatewayV2::Api", Properties: { Name: "cfn12-update-preauthorization", ProtocolType: "HTTP" } },
      Stage: { Type: "AWS::ApiGatewayV2::Stage", Properties: { ApiId: { Ref: "Api" }, StageName: "live", AutoDeploy: true } },
      Integration: {
        Type: "AWS::ApiGatewayV2::Integration",
        DependsOn: "Stage",
        Properties: {
          ApiId: { Ref: "Api" },
          CredentialsArn: { "Fn::GetAtt": [replacement ? "NewIntegrationRole" : "OldIntegrationRole", "Arn"] },
          Description: replacement ? "must not apply" : "before denied update",
          IntegrationMethod: "GET",
          IntegrationType: "HTTP_PROXY",
          IntegrationUri: replacement ? "https://denied.example.test/v2" : "https://allowed.example.test/v1",
          PayloadFormatVersion: "1.0",
        },
      },
    } });

    const created = await cloudformation.send(new CreateStackCommand({
      StackName: "apigv2-integration-update-preauthorization",
      TemplateBody: template(false),
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      RoleARN: names.roleArns.cloudFormationExecution,
    }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");

    const apiId = (await apigatewayv2.send(new GetApisCommand({ MaxResults: "500" }))).Items?.find(api => api.Name === "cfn12-update-preauthorization")?.ApiId;
    assert.ok(apiId);
    const integrationBefore = (await apigatewayv2.send(new GetIntegrationsCommand({ ApiId: apiId, MaxResults: "500" }))).Items?.[0];
    const stageBefore = (await apigatewayv2.send(new GetStagesCommand({ ApiId: apiId, MaxResults: "500" }))).Items?.find(stage => stage.StageName === "live");
    const deploymentsBefore = (await apigatewayv2.send(new GetDeploymentsCommand({ ApiId: apiId, MaxResults: "500" }))).Items ?? [];
    assert.equal(integrationBefore?.CredentialsArn, oldRoleArn);
    assert.ok(stageBefore?.DeploymentId);

    const executionRoleName = names.roleNames.cloudFormationExecution;
    const document = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    document.Statement.push({
      Sid: "DenyNewApiGatewayIntegrationRole",
      Effect: "Deny",
      Action: "iam:PassRole",
      Resource: newRoleArn,
      Condition: { StringEquals: { "iam:PassedToService": "apigateway.amazonaws.com" } },
    });
    await iam.send(new PutRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(document) }));
    const decisionStart = simulator.store.ensureAccount().iam.authorizationDecisions.length;

    await cloudformation.send(new UpdateStackCommand({
      StackName: created.StackId,
      TemplateBody: template(true),
      Capabilities: ["CAPABILITY_NAMED_IAM"],
    }));
    await waitForStack(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");

    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "Integration" && event.ResourceStatus === "UPDATE_FAILED" && /iam:PassRole|AccessDenied/i.test(event.ResourceStatusReason ?? "")));
    const integrationAfter = (await apigatewayv2.send(new GetIntegrationsCommand({ ApiId: apiId, MaxResults: "500" }))).Items?.[0];
    assert.equal(integrationAfter?.IntegrationId, integrationBefore?.IntegrationId);
    assert.equal(integrationAfter?.CredentialsArn, oldRoleArn);
    assert.equal(integrationAfter?.Description, "before denied update");
    assert.equal(integrationAfter?.IntegrationUri, "https://allowed.example.test/v1");

    const stageAfter = (await apigatewayv2.send(new GetStagesCommand({ ApiId: apiId, MaxResults: "500" }))).Items?.find(stage => stage.StageName === "live");
    const deploymentsAfter = (await apigatewayv2.send(new GetDeploymentsCommand({ ApiId: apiId, MaxResults: "500" }))).Items ?? [];
    assert.equal(stageAfter?.DeploymentId, stageBefore?.DeploymentId, "a denied update must not cut the AutoDeploy stage over");
    assert.deepEqual(deploymentsAfter.map(deployment => deployment.DeploymentId).sort(), deploymentsBefore.map(deployment => deployment.DeploymentId).sort(), "a denied update must not create an automatic deployment");
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.slice(decisionStart).some(decision => decision.action === "iam:PassRole" && decision.resource === newRoleArn && decision.decision !== "allowed"));

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resource-scoped execution-role policies authorize only the exact CFN-06 through CFN-08 resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-provider-resource-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const apigateway = new APIGatewayClient(options); const dynamodb = new DynamoDBClient(options); const iam = new IAMClient(options); const lambda = new LambdaClient(options); const logs = new CloudWatchLogsClient(options);
    clients.push(cloudformation, apigateway, dynamodb, iam, lambda, logs);

    const accountId = "000000000000"; const names = cdkBootstrapNames(accountId, region); const executionRoleName = names.roleNames.cloudFormationExecution;
    const workloadRoleName = "cfn-scoped-workload-role"; const functionName = "cfn-scoped-function"; const logGroupName = "/stacksim/cfn-scoped"; const tableName = "CfnScopedTable";
    const workloadRoleArn = `arn:aws:iam::${accountId}:role/${workloadRoleName}`; const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`; const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}:*`; const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
    const document = policyDocument((await iam.send(new GetRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME }))).PolicyDocument);
    const resourcesBySid: Record<string, string> = {
      ManageIamResources: workloadRoleArn,
      PassSupportedServiceRoles: workloadRoleArn,
      ManageLambdaResources: functionArn,
      ManageLogGroups: logGroupArn,
      ManageRestApis: `arn:aws:apigateway:${region}::/restapis*`,
      ManageDynamoDbTables: tableArn,
    };
    for (const statement of document.Statement ?? []) if (statement.Sid && resourcesBySid[statement.Sid]) statement.Resource = resourcesBySid[statement.Sid];
    document.Statement = (document.Statement ?? []).filter((statement: any) => statement.Sid && resourcesBySid[statement.Sid]);
    await iam.send(new PutRolePolicyCommand({ RoleName: executionRoleName, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: JSON.stringify(document) }));

    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
    const template = JSON.stringify({ Resources: {
      WorkloadRole: { Type: "AWS::IAM::Role", Properties: { RoleName: workloadRoleName, AssumeRolePolicyDocument: trust } },
      FunctionLog: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: logGroupName } },
      Table: { Type: "AWS::DynamoDB::Table", Properties: { TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] } },
      RestApi: { Type: "AWS::ApiGateway::RestApi", Properties: { Name: "cfn-scoped-api" } },
      Function: { Type: "AWS::Lambda::Function", Properties: { FunctionName: functionName, Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["WorkloadRole", "Arn"] }, Code: { ZipFile: "exports.handler = async () => ({ ok: true });" } } },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "resource-scoped-stack", TemplateBody: template, Capabilities: ["CAPABILITY_NAMED_IAM"], RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");
    assert.equal((await iam.send(new GetRoleCommand({ RoleName: workloadRoleName }))).Role?.Arn, workloadRoleArn);
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: functionName }))).Configuration?.FunctionArn, functionArn);
    assert.ok((await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }))).logGroups?.some(group => group.logGroupName === logGroupName));
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: tableName }))).Table?.TableArn, tableArn);
    assert.ok((await apigateway.send(new GetRestApisCommand({ limit: 500 }))).items?.some(api => api.name === "cfn-scoped-api"));

    const deniedName = "CfnOutsideScopedTable";
    const deniedTemplate = JSON.stringify({ Resources: { Table: { Type: "AWS::DynamoDB::Table", Properties: { TableName: deniedName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] } } } });
    const denied = await cloudformation.send(new CreateStackCommand({ StackName: "outside-resource-scope", TemplateBody: deniedTemplate, RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, denied.StackId!, "ROLLBACK_COMPLETE");
    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: denied.StackId }));
    assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "Table" && event.ResourceStatus === "CREATE_FAILED" && /dynamodb:CreateTable|AccessDenied/i.test(event.ResourceStatusReason ?? "")));
    await assert.rejects(dynamodb.send(new DescribeTableCommand({ TableName: deniedName })), error => (error as { name?: string }).name === "ResourceNotFoundException");

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId })); await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("PassRole ownership excludes IAM roles removed from the active processed update template", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-pass-role-desired-template-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const iam = new IAMClient(options); const lambda = new LambdaClient(options); clients.push(cloudformation, iam, lambda);
    const names = cdkBootstrapNames("000000000000", region); const roleName = "cfn-removed-workload-role"; const roleArn = `arn:aws:iam::000000000000:role/${roleName}`; const functionName = "cfn-removed-role-function";
    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
    const initialTemplate = JSON.stringify({ Resources: {
      WorkloadRole: { Type: "AWS::IAM::Role", Properties: { RoleName: roleName, AssumeRolePolicyDocument: trust } },
      Function: { Type: "AWS::Lambda::Function", Properties: { FunctionName: functionName, Description: "before", Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["WorkloadRole", "Arn"] }, Code: { ZipFile: "exports.handler = async () => ({ ok: true });" } } },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "removed-role-ownership", TemplateBody: initialTemplate, Capabilities: ["CAPABILITY_NAMED_IAM"], RoleARN: names.roleArns.cloudFormationExecution }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");

    const removedRoleTemplate = JSON.stringify({ Resources: {
      Function: { Type: "AWS::Lambda::Function", Properties: { FunctionName: functionName, Description: "must-not-apply", Runtime: "nodejs22.x", Handler: "index.handler", Role: roleArn, Code: { ZipFile: "exports.handler = async () => ({ ok: true });" } } },
    } });
    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: removedRoleTemplate }));
    await waitForStack(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    assert.ok(events.StackEvents?.some(event => event.LogicalResourceId === "Function" && event.ResourceStatus === "UPDATE_FAILED" && /active processed template|owned by this stack/i.test(event.ResourceStatusReason ?? "")));
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: functionName }))).Configuration?.Description, "before");
    assert.equal((await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role?.Arn, roleArn);

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId })); await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("NoEcho parameters and provider-sensitive values stay redacted in stack, event, local-console, and change-set views", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-redaction-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const firstSecret = "FirstSecretValue1234567890";
    const secondSecret = "SecondSecretValue123456789";
    const template = JSON.stringify({
      Parameters: { ApiKeyValue: { Type: "String", NoEcho: true } },
      Resources: {
        SecretKey: {
          Type: "AWS::ApiGateway::ApiKey",
          Properties: { Name: "cfn-redacted-key", Enabled: true, Value: { Ref: "ApiKeyValue" } },
        },
      },
    });

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "redaction-stack", TemplateBody: template, Parameters: [{ ParameterKey: "ApiKeyValue", ParameterValue: firstSecret }] }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");

    const described = await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }));
    assert.equal(described.Stacks?.[0]?.Parameters?.[0]?.ParameterValue, "****");
    assert.doesNotMatch(JSON.stringify(described), new RegExp(`${firstSecret}|${secondSecret}`));
    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`${firstSecret}|${secondSecret}`));
    const keyEventProperties = events.StackEvents?.find(event => event.LogicalResourceId === "SecretKey" && event.ResourceProperties)?.ResourceProperties ?? "";
    assert.equal(JSON.parse(keyEventProperties).Value, "****");

    for (const path of [
      `/_stacksim/api/cloudformation/stacks/${encodeURIComponent(created.StackId!)}`,
      `/_stacksim/api/cloudformation/stacks/${encodeURIComponent(created.StackId!)}/events`,
      `/_stacksim/api/cloudformation/stacks/${encodeURIComponent(created.StackId!)}/resources`,
    ]) {
      const response = await fetch(`${endpoint}${path}`);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), new RegExp(`${firstSecret}|${secondSecret}`));
    }

    const changeSet = await cloudformation.send(new CreateChangeSetCommand({
      StackName: created.StackId,
      ChangeSetName: "secret-update",
      ChangeSetType: "UPDATE",
      TemplateBody: template,
      Parameters: [{ ParameterKey: "ApiKeyValue", ParameterValue: secondSecret }],
    }));
    const detail = await waitForChangeSet(cloudformation, changeSet.Id!);
    assert.equal(detail.Status, "CREATE_COMPLETE");
    const serialized = JSON.stringify(detail);
    assert.doesNotMatch(serialized, new RegExp(`${firstSecret}|${secondSecret}`));
    const valueTargets = detail.Changes?.flatMap((change: any) => change.ResourceChange?.Details ?? []).filter((item: any) => item.Target?.Name === "Value") ?? [];
    assert.ok(valueTargets.length > 0);
    assert.ok(valueTargets.every((item: any) => item.Target.BeforeValue === "\"****\"" && item.Target.AfterValue === "\"****\""));

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("DescribeEvents requires its exact action and remains scoped to the requested stack", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-describe-events-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const iam = new IAMClient(options);
    clients.push(cloudformation, iam);

    const invalidTemplate = JSON.stringify({ Resources: {
      InvalidTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "unused", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "missing", KeyType: "RANGE" },
          ],
        },
      },
    } });
    const createFailedChangeSet = async (stackName: string, changeSetName: string): Promise<string> => {
      const created = await cloudformation.send(new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: "CREATE",
        TemplateBody: invalidTemplate,
      }));
      assert.equal((await waitForChangeSet(cloudformation, created.Id!)).Status, "FAILED");
      return created.Id!;
    };
    const allowedChangeSet = await createFailedChangeSet("events-visible", "invalid-visible");
    const hiddenChangeSet = await createFailedChangeSet("events-hidden", "invalid-hidden");

    await iam.send(new CreateUserCommand({ UserName: "events-reader" }));
    const accessKey = (await iam.send(new CreateAccessKeyCommand({ UserName: "events-reader" }))).AccessKey!;
    const reader = new CloudFormationClient({
      endpoint,
      region,
      maxAttempts: 1,
      credentials: { accessKeyId: accessKey.AccessKeyId!, secretAccessKey: accessKey.SecretAccessKey! },
    });
    clients.push(reader);
    const request = (stackName: string, changeSetName: string) => reader.send(new DescribeEventsCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
      Filters: { FailedEvents: true },
    }));

    await assert.rejects(request("events-visible", allowedChangeSet), error => {
      assert.equal((error as { name?: string }).name, "AccessDenied");
      assert.match((error as Error).message, /cloudformation:DescribeEvents/);
      return true;
    });

    await iam.send(new PutUserPolicyCommand({
      UserName: "events-reader",
      PolicyName: "ReadVisibleValidationEvents",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: "cloudformation:DescribeEvents",
          Resource: `arn:aws:cloudformation:${region}:000000000000:stack/events-visible/*`,
        }],
      }),
    }));

    const visible = await request("events-visible", allowedChangeSet);
    assert.ok((visible.OperationEvents?.length ?? 0) > 0);
    assert.ok(visible.OperationEvents?.every(event => event.ValidationStatus === "FAILED"));

    await assert.rejects(request("events-hidden", hiddenChangeSet), error => {
      assert.equal((error as { name?: string }).name, "AccessDenied");
      assert.match((error as Error).message, /cloudformation:DescribeEvents/);
      assert.doesNotMatch((error as Error).message, /invalid-hidden/);
      return true;
    });
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision =>
      decision.principalArn.endsWith(":user/events-reader")
      && decision.action === "cloudformation:DescribeEvents"
      && decision.resource === `arn:aws:cloudformation:${region}:000000000000:stack/events-hidden/*`
      && decision.decision !== "allowed",
    ));
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
