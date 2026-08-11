import { expect, test, type Page, type Route } from "@playwright/test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type StackStatus,
} from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let cloudformation: CloudFormationClient;
let dynamodb: DynamoDBClient;
let dataDir: string;
let consoleUrl: string;

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function consoleStackTemplate(analytics: string): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Real browser Lambda, REST API, and DynamoDB stack",
    Parameters: {
      Environment: { Type: "String", Default: "browser" },
    },
    Conditions: {
      IncludeExcludedFixture: { "Fn::Equals": ["included", "excluded"] },
    },
    Resources: {
      ExcludedQueue: {
        Type: "AWS::SQS::Queue",
        Condition: "IncludeExcludedFixture",
      },
      ItemsTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: "console-stack-items",
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          Tags: [{ Key: "environment", Value: { Ref: "Environment" } }],
        },
      },
      FunctionLogs: {
        Type: "AWS::Logs::LogGroup",
        Properties: { LogGroupName: "/aws/lambda/console-stack-handler", RetentionInDays: 7 },
      },
      FunctionRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: "console-stack-function-role",
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
          },
          Tags: [{ Key: "environment", Value: { Ref: "Environment" } }],
        },
      },
      Function: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["FunctionLogs", "FunctionRole"],
        Properties: {
          FunctionName: "console-stack-handler",
          Description: "CloudFormation console browser fixture",
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          Role: { "Fn::GetAtt": ["FunctionRole", "Arn"] },
          Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200, body: 'ok' });" },
          Environment: { Variables: { TABLE_NAME: { Ref: "ItemsTable" } } },
          LoggingConfig: { LogGroup: { Ref: "FunctionLogs" } },
          Tags: [{ Key: "environment", Value: { Ref: "Environment" } }],
        },
      },
      RestApi: {
        Type: "AWS::ApiGateway::RestApi",
        Properties: { Name: "console-stack-api", Description: "Real CloudFormation console REST API" },
      },
      HelloResource: {
        Type: "AWS::ApiGateway::Resource",
        Properties: {
          RestApiId: { Ref: "RestApi" },
          ParentId: { "Fn::GetAtt": ["RestApi", "RootResourceId"] },
          PathPart: "hello",
        },
      },
      InvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          Action: "lambda:InvokeFunction",
          FunctionName: { "Fn::GetAtt": ["Function", "Arn"] },
          Principal: "apigateway.amazonaws.com",
          SourceArn: { "Fn::Sub": "arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/*/GET/hello" },
        },
      },
      HelloMethod: {
        Type: "AWS::ApiGateway::Method",
        DependsOn: "InvokePermission",
        Properties: {
          RestApiId: { Ref: "RestApi" },
          ResourceId: { Ref: "HelloResource" },
          HttpMethod: "GET",
          AuthorizationType: "NONE",
          Integration: {
            Type: "AWS_PROXY",
            IntegrationHttpMethod: "POST",
            Uri: { "Fn::Sub": "arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Function.Arn}/invocations" },
          },
        },
      },
      ApiDeployment: {
        Type: "AWS::ApiGateway::Deployment",
        DependsOn: "HelloMethod",
        Properties: { RestApiId: { Ref: "RestApi" }, Description: "Browser fixture deployment" },
      },
      ProdStage: {
        Type: "AWS::ApiGateway::Stage",
        Properties: { RestApiId: { Ref: "RestApi" }, DeploymentId: { Ref: "ApiDeployment" }, StageName: "prod" },
      },
      CdkMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: analytics } },
    },
    Outputs: {
      ApiId: { Value: { Ref: "RestApi" } },
      ApiUrl: {
        Description: "AWS-shaped CDK output",
        Value: { "Fn::Sub": "https://${RestApi}.execute-api.${AWS::Region}.amazonaws.com/prod/" },
        Export: { Name: "console-api-url" },
      },
      FunctionName: { Value: { Ref: "Function" } },
      TableName: { Value: { Ref: "ItemsTable" } },
      Release: { Value: analytics },
    },
  });
}

function failedStackTemplate(): string {
  return JSON.stringify({
    Description: "Rollback-disabled browser error fixture",
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "failed-browser-stack" } } },
    Outputs: { Invalid: { Value: ["not", "a", "scalar"] } },
  });
}

function updateRollbackFailureTemplate(): string {
  const template = JSON.parse(consoleStackTemplate("browser-v1"));
  template.Resources.ProtectedTable = {
    Type: "AWS::DynamoDB::Table",
    Properties: {
      TableName: "console-stack-protected",
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    },
  };
  template.Resources.FailureResource = {
    Type: "AWS::ApiGateway::Resource",
    DependsOn: "ProtectedTable",
    Properties: { RestApiId: "missing-api", ParentId: "missing-parent", PathPart: "must-fail" },
  };
  return JSON.stringify(template);
}

function replacementReviewTemplate(groupName: string, analytics: string): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Console lifecycle review fixture",
    Resources: {
      Group: {
        Type: "AWS::Logs::LogGroup",
        Properties: { LogGroupName: groupName, RetentionInDays: 7 },
      },
      Metadata: {
        Type: "AWS::CDK::Metadata",
        Properties: { Analytics: analytics },
      },
    },
    Outputs: { Release: { Value: analytics } },
  });
}

function exportTemplate(value: string, exportName: string): string {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: value } } },
    Outputs: { Shared: { Value: value, Export: { Name: exportName } } },
  });
}

function importTemplate(exportName: string): string {
  return JSON.stringify({
    Resources: {
      Metadata: {
        Type: "AWS::CDK::Metadata",
        Properties: { Analytics: { "Fn::ImportValue": exportName } },
      },
    },
  });
}

function protectedTableTemplate(tableName: string): string {
  return JSON.stringify({
    Resources: {
      ProtectedTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          DeletionProtectionEnabled: true,
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        },
      },
    },
  });
}

async function waitForStackStatus(stackName: string, expected: StackStatus, attempts = 240): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

async function waitForStackDeletion(stackName: string, attempts = 240): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
      if (!stack || stack.StackStatus === "DELETE_COMPLETE") return;
    } catch (error) {
      if ((error as { name?: string }).name === "ValidationError") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${stackName} to be deleted`);
}

async function waitForChangeSet(changeSetName: string, expected = "CREATE_COMPLETE", attempts = 120, stackName?: string): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = (await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: changeSetName, StackName: stackName }))).Status;
      if (status === expected) return;
      if (status === "FAILED") throw new Error(`Change set ${changeSetName} failed`);
    } catch (error) {
      if ((error as { name?: string }).name !== "ChangeSetNotFoundException") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for change set ${changeSetName}`);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}

async function expectPanelHelp(page: Page, title: string, text: string): Promise<void> {
  const button = page.getByRole("button", { name: `About ${title}` }).first();
  await expect(button).toBeVisible();
  await button.hover();
  const tooltip = button.locator("..").getByRole("tooltip");
  await expect(tooltip).toContainText(text);
  await expect(tooltip).toContainText("StackSim support");
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

test.describe("CFN-01 through CFN-08 console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-cloudformation-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", cdkBootstrap: true, authMode: "off"});
    await simulator.start();
    cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    dynamodb.destroy();
    cloudformation.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("explains CloudFormation input panels and their StackSim support", async ({ page }) => {
    const errors = browserErrors(page);
    const stackName = "panel-help-cloudformation";
    const created = await cloudformation.send(new CreateStackCommand({
      StackName: stackName,
      TemplateBody: replacementReviewTemplate("/stacksim/panel-help", "panel-v1"),
      Tags: [{ Key: "purpose", Value: "panel-help" }],
    }));
    await waitForStackStatus(created.StackId!, "CREATE_COMPLETE");
    await cloudformation.send(new CreateChangeSetCommand({
      StackName: stackName,
      ChangeSetName: "panel-help-update",
      ChangeSetType: "UPDATE",
      TemplateBody: replacementReviewTemplate("/stacksim/panel-help", "panel-v2"),
      Tags: [{ Key: "purpose", Value: "panel-help" }],
    }));
    await waitForChangeSet("panel-help-update", "CREATE_COMPLETE", 120, stackName);

    await page.goto(`${consoleUrl}#/cloudformation/stacks`);
    await expectPanelHelp(page, "Stacks", "StackSets, drift detection");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/overview`);
    await expectPanelHelp(page, "Stack details", "termination protection");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/events`);
    await expectPanelHelp(page, "Stack events", "operation ID");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/parameters`);
    await expectPanelHelp(page, "Parameters", "previous-value reuse");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/template`);
    await expectPanelHelp(page, "Template", "YAML editing");
    await page.getByLabel("Template stage").selectOption("Processed");
    await expectPanelHelp(page, "Template", "condition-resolved document");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/change-sets`);
    await expectPanelHelp(page, "Change sets", "reviewable plan");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/change-sets/panel-help-update`);
    await expectPanelHelp(page, "Changes", "drift detection");
    await expectPanelHelp(page, "Parameters", "JSON object");
    await expectPanelHelp(page, "Tags", "Organizations tag policies");
    await page.goto(`${consoleUrl}#/cloudformation/stacks/${stackName}/tags`);
    await expectPanelHelp(page, "Tags", "supported resource tag propagation");

    await page.setViewportSize({ width: 390, height: 844 });
    const tagsHelp = page.getByRole("button", { name: "About Tags" });
    await tagsHelp.hover();
    const box = await tagsHelp.locator("..").getByRole("tooltip").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });

  test("uses real CloudFormation state for stack views, change sets, links, lifecycle controls, and setup", async ({ page }) => {
    const errors = browserErrors(page);
    const created = await cloudformation.send(new CreateStackCommand({
      StackName: "console-stack",
      TemplateBody: consoleStackTemplate("browser-v1"),
      Parameters: [{ ParameterKey: "Environment", ParameterValue: "browser" }],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      EnableTerminationProtection: false,
      Tags: [{ Key: "environment", Value: "browser" }, { Key: "owner", Value: "console-test" }],
    }));
    await waitForStackStatus(created.StackId!, "CREATE_COMPLETE");
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
    const outputs = Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
    const localInvokeUrl = `http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/prod`;

    await cloudformation.send(new CreateChangeSetCommand({
      StackName: created.StackId,
      ChangeSetName: "pending-update",
      ChangeSetType: "UPDATE",
      Description: "Update the CDK metadata release marker",
      TemplateBody: consoleStackTemplate("browser-v2"),
      Parameters: [{ ParameterKey: "Environment", UsePreviousValue: true }],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Tags: [{ Key: "environment", Value: "browser" }, { Key: "owner", Value: "console-test" }],
    }));
    await waitForChangeSet("pending-update");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks`);
    await expect(page.getByRole("heading", { name: "Stacks", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "console-stack", exact: true })).toBeVisible();
    await page.getByPlaceholder("Find stacks").fill("not-present");
    await expect(page.getByRole("link", { name: "console-stack", exact: true })).toBeHidden();
    await page.getByPlaceholder("Find stacks").fill("console");
    await expect(page.getByRole("link", { name: "console-stack", exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.getByRole("link", { name: "console-stack", exact: true }).click();
    await expect(page.getByRole("heading", { name: "console-stack", exact: true })).toBeVisible();
    await expect(page.getByText("Real browser Lambda, REST API, and DynamoDB stack", { exact: true })).toBeVisible();
    await expect(page.getByText("CAPABILITY_NAMED_IAM", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("heading", { name: /Stack events/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /console-stack CREATE_COMPLETE AWS::CloudFormation::Stack/ })).toBeVisible();
    await expect(page.locator(".cloudformation-event-table")).toContainText("AWS::Lambda::Function");

    await page.getByRole("tab", { name: "Resources" }).click();
    await expect(page.getByRole("link", { name: "console-stack-handler", exact: true })).toHaveAttribute("href", "#/lambda/functions/console-stack-handler");
    await expect(page.getByRole("link", { name: "console-stack-items", exact: true })).toHaveAttribute("href", "#/dynamodb/tables/console-stack-items/overview");
    await expect(page.getByRole("link", { name: "console-stack-function-role", exact: true })).toHaveAttribute("href", "#/iam/roles/console-stack-function-role");
    await expect(page.getByRole("link", { name: "/aws/lambda/console-stack-handler", exact: true })).toHaveAttribute("href", "#/cloudwatch/log-groups/%2Faws%2Flambda%2Fconsole-stack-handler");
    await expect(page.getByRole("link", { name: outputs.ApiId, exact: true })).toHaveAttribute("href", `#/apigateway/apis/${outputs.ApiId}`);
    await expect(page.getByRole("row").filter({ hasText: "AWS::ApiGateway::Stage" }).getByRole("link")).toHaveAttribute("href", `#/apigateway/apis/${outputs.ApiId}/stages`);
    await expect(page.getByRole("row").filter({ hasText: "AWS::Lambda::Permission" }).getByRole("link").first()).toHaveAttribute("href", "#/lambda/functions/console-stack-handler");
    const realTableRow = page.getByRole("row").filter({ hasText: "AWS::DynamoDB::Table" });
    for (const [label, section] of [["Indexes", "indexes"], ["Streams", "streams"], ["Backups", "backups"], ["Permissions", "permissions"], ["Monitoring", "monitor"]]) {
      await expect(realTableRow.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", `#/dynamodb/tables/console-stack-items/${section}`);
    }
    await expect(page.getByRole("link", { name: localInvokeUrl, exact: true })).toHaveAttribute("href", localInvokeUrl);
    await expect(page.locator(".cloudformation-local-invoke")).toContainText(`${outputs.ApiId} / prod`);

    await page.getByRole("tab", { name: "Outputs" }).click();
    await expect(page.getByRole("cell", { name: "ApiUrl", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: outputs.ApiUrl, exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "console-api-url", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "console-stack-items", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Parameters" }).click();
    await expect(page.getByRole("cell", { name: "Environment", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "browser", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Template" }).click();
    await expect(page.getByLabel("Template stage")).toHaveValue("Original");
    await expect(page.locator(".cloudformation-template")).toContainText("ExcludedQueue");
    await expect(page.locator(".cloudformation-template")).toContainText("AWS::ApiGateway::Stage");
    await expect(page.locator(".cloudformation-template")).toContainText("AWS::DynamoDB::Table");
    await page.getByLabel("Template stage").selectOption("Processed");
    await expect(page.getByLabel("Template stage")).toHaveValue("Processed");
    await expect(page.locator(".cloudformation-template")).not.toContainText("ExcludedQueue");
    await expect(page.locator(".cloudformation-template")).toContainText("AWS::DynamoDB::Table");
    await page.getByLabel("Template stage").selectOption("Original");
    await expect(page.getByLabel("Template stage")).toHaveValue("Original");
    await expect(page.locator(".cloudformation-template")).toContainText("ExcludedQueue");

    await page.getByRole("tab", { name: "Change sets" }).click();
    await page.getByRole("link", { name: "pending-update", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Changes (1)", exact: true })).toBeVisible();
    await expect(page.getByText("Properties.Analytics", { exact: true })).toBeVisible();
    await expect(page.locator(".cloudformation-change-details")).toContainText("browser-v1");
    await expect(page.locator(".cloudformation-change-details")).toContainText("browser-v2");
    await page.locator(".cloudformation-change-set-detail").getByRole("button", { name: "Execute", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Execute", exact: true }).click();
    await waitForStackStatus("console-stack", "UPDATE_COMPLETE");
    await page.reload();
    await expect(page.locator(".cloudformation-change-set-detail").getByText("EXECUTE_COMPLETE", { exact: true })).toBeVisible();
    await page.locator(".cloudformation-change-set-detail").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/To confirm deletion/).fill("pending-update");
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No change sets", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Tags" }).click();
    await expect(page.getByRole("cell", { name: "environment", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "console-test", exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("tab", { name: "Stack info" })).toBeVisible();
    await expectNoDocumentOverflow(page);
    await page.getByRole("tab", { name: "Resources" }).click();
    await expect(page.getByRole("heading", { name: "Local API invoke links", exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("tab", { name: "Stack info" }).click();
    await page.getByRole("button", { name: "Enable termination protection" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("Termination protection is enabled", { exact: true })).toBeVisible();
    expect((await cloudformation.send(new DescribeStacksCommand({ StackName: "console-stack" }))).Stacks?.[0]?.EnableTerminationProtection).toBe(true);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Disable termination protection" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disable", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/To confirm deletion/).fill("console-stack");
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/cloudformation\/stacks$/);
    await waitForStackDeletion("console-stack");
    await page.reload();
    await expect(page.getByRole("heading", { name: "No stacks", exact: true })).toBeVisible();

    await page.getByRole("navigation", { name: "CloudFormation navigation" }).getByRole("link", { name: "Local CDK setup" }).click();
    await expect(page.getByRole("heading", { name: "Local CDK setup", exact: true })).toBeVisible();
    await expect(page.locator(".cloudformation-setup-code").first()).toContainText("AWS_ENDPOINT_URL");
    await expect(page.locator("main")).toContainText("npx cdk deploy");
    await expect(page.locator("main")).toContainText("Ready (version");
    const bootstrapDetails = page.locator(".cloudformation-identifiers");
    const detailValue = (label: string) => bootstrapDetails.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
    await expect(detailValue("Owner")).toHaveText("stacksim");
    await expect(detailValue("Compatibility version")).toHaveText("23");
    await expect(detailValue("Qualifier")).toHaveText("hnb659fds");
    await expect(detailValue("SSM version parameter")).toHaveText("/cdk-bootstrap/hnb659fds/version");
    await expect(detailValue("SSM parameter value")).toHaveText("23");
    await expect(detailValue("Bootstrap status")).toHaveText("Ready");
    await expect(detailValue("File asset count")).toHaveText("0");
    await expect(detailValue("Stored asset size")).toHaveText("0 B");
    await expect(detailValue("File asset bucket").getByRole("link")).toHaveAttribute("href", "#/s3/buckets/cdk-hnb659fds-assets-000000000000-eu-west-1/objects");
    const expectedBootstrapRoles = [
      "cdk-hnb659fds-deploy-role-000000000000-eu-west-1",
      "cdk-hnb659fds-file-publishing-role-000000000000-eu-west-1",
      "cdk-hnb659fds-image-publishing-role-000000000000-eu-west-1",
      "cdk-hnb659fds-lookup-role-000000000000-eu-west-1",
      "cdk-hnb659fds-cfn-exec-role-000000000000-eu-west-1",
    ];
    for (const roleName of expectedBootstrapRoles) {
      const roleLink = page.locator(".cloudformation-bootstrap-role-table").getByRole("link", { name: roleName, exact: true });
      await expect(roleLink).toHaveAttribute("href", `#/iam/roles/${roleName}`);
      await expect(roleLink.locator("xpath=ancestor::tr")).toContainText("Available");
    }
    await expect(page.locator(".cloudformation-bootstrap-role-table tbody tr")).toHaveCount(5);
    await expect(page.locator("main")).toContainText("Image assets are unavailable");
    await expect(page.locator("main")).toContainText("Do not run the full cdk bootstrap template");
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });

  test("rolls back a real rollback-disabled create failure through the console", async ({ page }) => {
    const errors = browserErrors(page);
    await cloudformation.send(new CreateStackCommand({ StackName: "failed-console-stack", TemplateBody: failedStackTemplate(), DisableRollback: true }));
    await waitForStackStatus("failed-console-stack", "CREATE_FAILED");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks/failed-console-stack/overview`);
    await expect(page.getByText("CREATE_FAILED", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Output Invalid must resolve to a string, number, or boolean", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Roll back", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/To confirm rollback/).fill("failed-console-stack");
    await page.getByRole("dialog").getByRole("button", { name: "Roll back", exact: true }).click();
    await waitForStackStatus("failed-console-stack", "ROLLBACK_COMPLETE");
    await page.reload();
    await expect(page.getByText("ROLLBACK_COMPLETE", { exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });

  test("continues a real failed update rollback through the console", async ({ page }) => {
    const errors = browserErrors(page);
    await cloudformation.send(new CreateStackCommand({
      StackName: "continue-console-stack",
      TemplateBody: consoleStackTemplate("browser-v1"),
      Parameters: [{ ParameterKey: "Environment", ParameterValue: "browser" }],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
    }));
    await waitForStackStatus("continue-console-stack", "CREATE_COMPLETE");

    await cloudformation.send(new UpdateStackCommand({
      StackName: "continue-console-stack",
      TemplateBody: updateRollbackFailureTemplate(),
      Parameters: [{ ParameterKey: "Environment", UsePreviousValue: true }],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
    }));
    await waitForStackStatus("continue-console-stack", "UPDATE_ROLLBACK_FAILED");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks/continue-console-stack/overview`);
    await expect(page.getByText("UPDATE_ROLLBACK_FAILED", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Continue update rollback", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/Resources to skip/).fill("ProtectedTable");
    await page.getByRole("dialog").getByLabel(/To confirm continuing rollback/).fill("continue-console-stack");
    await page.getByRole("dialog").getByRole("button", { name: "Continue rollback", exact: true }).click();
    await waitForStackStatus("continue-console-stack", "UPDATE_ROLLBACK_COMPLETE");
    await page.reload();
    await expect(page.getByText("UPDATE_ROLLBACK_COMPLETE", { exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);

    await dynamodb.send(new UpdateTableCommand({ TableName: "console-stack-protected", DeletionProtectionEnabled: false }));
    expect(errors).toEqual([]);
  });

  test("updates a stack and reviews CREATE and replacement UPDATE change sets through the console", async ({ page }) => {
    const errors = browserErrors(page);
    const created = await cloudformation.send(new CreateStackCommand({
      StackName: "lifecycle-console-stack",
      TemplateBody: replacementReviewTemplate("/stacksim/browser-old", "browser-v1"),
    }));
    await waitForStackStatus(created.StackId!, "CREATE_COMPLETE");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks/lifecycle-console-stack/overview`);
    await page.getByRole("button", { name: "Update", exact: true }).click();
    const updateDialog = page.getByRole("dialog");
    await expect(updateDialog.getByText("Direct stack update", { exact: true })).toBeVisible();
    const updateEditor = updateDialog.getByLabel("Template (JSON)");
    const updateTemplate = JSON.parse(await updateEditor.inputValue());
    updateTemplate.Resources.Metadata.Properties.Analytics = "browser-v2";
    updateTemplate.Outputs.Release.Value = "browser-v2";
    await updateEditor.fill(JSON.stringify(updateTemplate, null, 2));
    await updateDialog.getByRole("button", { name: "Update stack", exact: true }).click();
    await expect(updateDialog).toBeHidden();
    await waitForStackStatus(created.StackId!, "UPDATE_COMPLETE");
    await page.reload();

    await page.getByRole("tab", { name: "Outputs" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Release" })).toContainText("browser-v2");
    await page.getByRole("tab", { name: "Events" }).click();
    const operationFilter = page.getByLabel("Operation ID filter");
    await expect(operationFilter).toBeVisible();
    await expect(operationFilter.locator("option")).toHaveCount(3);
    const operationId = await operationFilter.locator("option").nth(1).getAttribute("value");
    expect(operationId).toBeTruthy();
    await operationFilter.selectOption(operationId!);
    await expect(operationFilter).toHaveValue(operationId!);
    await expect(page.locator(".cloudformation-event-operation").first()).toHaveText(operationId!);
    expect(await page.locator(".cloudformation-event-operation").allTextContents()).toEqual(
      Array(await page.locator(".cloudformation-event-operation").count()).fill(operationId),
    );

    await page.getByRole("tab", { name: "Change sets" }).click();
    await page.getByRole("button", { name: "Create change set", exact: true }).click();
    const updateChangeSetDialog = page.getByRole("dialog");
    await expect(updateChangeSetDialog.getByLabel("Change set type")).toHaveValue("UPDATE");
    await updateChangeSetDialog.getByLabel("Change set name").fill("replacement-review");
    await updateChangeSetDialog.getByLabel("Description").fill("Review a physical log-group replacement");
    const changeSetEditor = updateChangeSetDialog.getByLabel("Template (JSON)");
    const replacementTemplate = JSON.parse(await changeSetEditor.inputValue());
    replacementTemplate.Resources.Group.Properties.LogGroupName = "/stacksim/browser-new";
    replacementTemplate.Resources.Metadata.Properties.Analytics = "browser-v3";
    replacementTemplate.Outputs.Release.Value = "browser-v3";
    await changeSetEditor.fill(JSON.stringify(replacementTemplate, null, 2));
    await updateChangeSetDialog.getByRole("button", { name: "Create change set", exact: true }).click();
    await expect(page).toHaveURL(/#\/cloudformation\/stacks\/lifecycle-console-stack\/change-sets\/replacement-review$/);
    await waitForChangeSet("replacement-review", "CREATE_COMPLETE", 120, "lifecycle-console-stack");
    const replacementRow = page.locator(".cloudformation-replacement-row");
    await expect(page.locator(".cloudformation-replacement-warning")).toContainText("1 resource replacement may occur");
    await expect(replacementRow).toContainText("Group");
    await expect(replacementRow).toContainText("Required");
    await expect(replacementRow).toContainText("ReplaceAndDelete");
    await expect(replacementRow).toContainText("Always recreation");
    await page.locator(".cloudformation-change-set-detail").getByRole("button", { name: "Execute", exact: true }).click();
    const executeDialog = page.getByRole("dialog");
    await expect(executeDialog).toContainText("1 replacement will be evaluated during execution");
    await expect(executeDialog).toContainText("Group");
    await executeDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".cloudformation-replacement-warning")).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks`);
    await page.getByRole("button", { name: "Create change set", exact: true }).click();
    const createChangeSetDialog = page.getByRole("dialog");
    await createChangeSetDialog.getByLabel("Stack name").fill("planned-console-stack");
    await createChangeSetDialog.getByLabel("Change set type").selectOption("CREATE");
    await createChangeSetDialog.getByLabel("Change set name").fill("initial-create");
    await createChangeSetDialog.getByLabel("Description").fill("Review a new stack before execution");
    await createChangeSetDialog.getByLabel("Template (JSON)").fill(replacementReviewTemplate("/stacksim/planned", "planned-v1"));
    await createChangeSetDialog.getByLabel("On create failure").selectOption("ROLLBACK");
    await createChangeSetDialog.getByRole("button", { name: "Create change set", exact: true }).click();
    await expect(page).toHaveURL(/#\/cloudformation\/stacks\/planned-console-stack\/change-sets\/initial-create$/);
    await waitForChangeSet("initial-create", "CREATE_COMPLETE", 120, "planned-console-stack");
    const createDetail = page.locator(".cloudformation-change-set-detail");
    await expect(createDetail.getByText("CREATE", { exact: true })).toBeVisible();
    await expect(createDetail.getByText("AVAILABLE", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });

  test("shows export and import relationships with navigable stack links", async ({ page }) => {
    const errors = browserErrors(page);
    const exportName = "BrowserSharedValue";
    const exporter = await cloudformation.send(new CreateStackCommand({
      StackName: "browser-exporter",
      TemplateBody: exportTemplate("shared-browser-v1", exportName),
    }));
    await waitForStackStatus(exporter.StackId!, "CREATE_COMPLETE");
    const importer = await cloudformation.send(new CreateStackCommand({
      StackName: "browser-importer",
      TemplateBody: importTemplate(exportName),
    }));
    await waitForStackStatus(importer.StackId!, "CREATE_COMPLETE");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks`);
    await page.getByRole("navigation", { name: "CloudFormation navigation" }).getByRole("link", { name: "Exports", exact: true }).click();
    const relationshipRow = page.locator(".cloudformation-export-table tbody tr");
    await expect(relationshipRow).toContainText("shared-browser-v1");
    await expect(relationshipRow.getByRole("link", { name: "browser-exporter", exact: true })).toHaveAttribute("href", "#/cloudformation/stacks/browser-exporter/outputs");
    await expect(relationshipRow.getByRole("link", { name: "browser-importer", exact: true })).toHaveAttribute("href", "#/cloudformation/stacks/browser-importer/overview");
    await page.getByPlaceholder("Find exports").fill("browser-importer");
    await expect(relationshipRow).toBeVisible();
    await relationshipRow.getByRole("link", { name: exportName, exact: true }).click();
    await expect(page.getByRole("heading", { name: exportName, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Importing stacks (1)", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "browser-importer", exact: true })).toHaveAttribute("href", "#/cloudformation/stacks/browser-importer/overview");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);
    await page.getByRole("link", { name: "browser-importer", exact: true }).click();
    await expect(page.getByRole("heading", { name: "browser-importer", exact: true })).toBeVisible();
    await page.goto(`${consoleUrl}#/cloudformation/exports/${exportName}`);
    await page.getByRole("link", { name: "browser-exporter", exact: true }).click();
    await expect(page).toHaveURL(/#\/cloudformation\/stacks\/browser-exporter\/outputs$/);
    await expect(page.getByRole("cell", { name: "BrowserSharedValue", exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });

  test("retries failed deletes with retained resources and standard or force mode", async ({ page }) => {
    const errors = browserErrors(page);
    const retained = await cloudformation.send(new CreateStackCommand({
      StackName: "browser-delete-retain",
      TemplateBody: protectedTableTemplate("browser-delete-retain-table"),
    }));
    const forced = await cloudformation.send(new CreateStackCommand({
      StackName: "browser-delete-force",
      TemplateBody: protectedTableTemplate("browser-delete-force-table"),
    }));
    await waitForStackStatus(retained.StackId!, "CREATE_COMPLETE");
    await waitForStackStatus(forced.StackId!, "CREATE_COMPLETE");
    await cloudformation.send(new DeleteStackCommand({ StackName: retained.StackId }));
    await cloudformation.send(new DeleteStackCommand({ StackName: forced.StackId }));
    await waitForStackStatus(retained.StackId!, "DELETE_FAILED");
    await waitForStackStatus(forced.StackId!, "DELETE_FAILED");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks/browser-delete-retain/overview`);
    await expect(page.getByText("DELETE_FAILED", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Retry delete", exact: true }).click();
    const retainDialog = page.getByRole("dialog");
    const retainMode = retainDialog.getByLabel("Deletion mode");
    await expect(retainMode.locator("option")).toHaveText(["Standard retry", "Force delete stack"]);
    await retainMode.selectOption("STANDARD");
    await retainDialog.getByRole("checkbox", { name: /ProtectedTable/ }).check();
    await retainDialog.getByLabel(/To confirm retrying deletion/).fill("browser-delete-retain");
    await expect(retainDialog.getByRole("button", { name: "Retry delete", exact: true })).toHaveClass(/danger/);
    await retainDialog.getByRole("button", { name: "Retry delete", exact: true }).click();
    await waitForStackStatus(retained.StackId!, "DELETE_COMPLETE");
    expect((await dynamodb.send(new DescribeTableCommand({ TableName: "browser-delete-retain-table" }))).Table?.DeletionProtectionEnabled).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${consoleUrl}#/cloudformation/stacks/browser-delete-force/overview`);
    await page.getByRole("button", { name: "Retry delete", exact: true }).click();
    const forceDialog = page.getByRole("dialog");
    await forceDialog.getByLabel("Deletion mode").selectOption("FORCE_DELETE_STACK");
    await forceDialog.getByLabel(/To confirm retrying deletion/).fill("browser-delete-force");
    await expectNoDocumentOverflow(page);
    await forceDialog.getByRole("button", { name: "Retry delete", exact: true }).click();
    await waitForStackStatus(forced.StackId!, "DELETE_COMPLETE");
    expect((await dynamodb.send(new DescribeTableCommand({ TableName: "browser-delete-force-table" }))).Table?.DeletionProtectionEnabled).toBe(true);
    expect(errors).toEqual([]);
  });

  test("keeps a synthetic UI-contract replay separate from real-server acceptance", async ({ page }) => {
    const errors = browserErrors(page);
    let protectedStack = false;
    let deleted = false;
    let stackStatus = "CREATE_COMPLETE";
    let statusReason = "";
    let changeSetDeleted = false;
    let changeSetExecutionStatus = "AVAILABLE";
    let rolledBack = false;
    let continuedResources: string[] = [];
    const localInvokeUrl = `http://127.0.0.1:${simulator.invokePort}/api123/prod`;
    const stack = () => ({
      stackName: "console-stack",
      stackId: "arn:aws:cloudformation:eu-west-1:000000000000:stack/console-stack/fixture",
      description: "Browser contract fixture",
      stackStatus: deleted ? "DELETE_COMPLETE" : stackStatus,
      stackStatusReason: statusReason || undefined,
      creationTime: Date.UTC(2026, 6, 20, 12),
      lastUpdatedTime: Date.UTC(2026, 6, 20, 12, 1),
      enableTerminationProtection: protectedStack,
      disableRollback: false,
      capabilities: ["CAPABILITY_IAM"],
      notificationArns: [],
      parameters: [{ parameterKey: "Environment", parameterValue: "browser" }],
      outputs: [{ outputKey: "ApiUrl", outputValue: "https://api123.execute-api.eu-west-1.amazonaws.com/prod/", description: "AWS-shaped CDK output", exportName: "console-api-url" }],
      tags: { environment: "browser" },
    });
    const changeSet = () => ({
      ChangeSetName: "pending-update",
      ChangeSetId: "arn:aws:cloudformation:eu-west-1:000000000000:changeSet/pending-update/fixture",
      StackId: stack().stackId,
      StackName: "console-stack",
      Description: "Update the Lambda asset",
      ChangeSetType: "UPDATE",
      Status: "CREATE_COMPLETE",
      ExecutionStatus: changeSetExecutionStatus,
      CreationTime: new Date(Date.UTC(2026, 6, 20, 12, 2)).toISOString(),
      Parameters: [{ ParameterKey: "Environment", ParameterValue: "browser" }],
      Tags: [{ Key: "environment", Value: "browser" }],
      Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "Function", PhysicalResourceId: "console-function", ResourceType: "AWS::Lambda::Function", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "Code", RequiresRecreation: "Never", BeforeValue: "asset-old", AfterValue: "asset-new" }, Evaluation: "Static", ChangeSource: "DirectModification" }] } }],
    });
    const lambdaArn = "arn:aws:lambda:eu-west-1:000000000000:function:console-function";
    const managedPolicyArn = "arn:aws:iam::000000000000:policy/console-managed";
    const resourceTimestamp = Date.UTC(2026, 6, 20, 12, 1);
    const syntheticResources = [
      { logicalResourceId: "CdkMetadata", physicalResourceId: "fixture", resourceType: "AWS::CDK::Metadata" },
      { logicalResourceId: "Role", physicalResourceId: "console-role", resourceType: "AWS::IAM::Role" },
      { logicalResourceId: "InlinePolicy", physicalResourceId: "inline-policy", resourceType: "AWS::IAM::Policy", properties: { Roles: ["console-role"] } },
      { logicalResourceId: "ManagedPolicy", physicalResourceId: managedPolicyArn, resourceType: "AWS::IAM::ManagedPolicy" },
      { logicalResourceId: "Function", physicalResourceId: "console-function", resourceType: "AWS::Lambda::Function" },
      { logicalResourceId: "Permission", physicalResourceId: `${lambdaArn}/permission-statement`, resourceType: "AWS::Lambda::Permission", properties: { FunctionName: lambdaArn } },
      { logicalResourceId: "Version", physicalResourceId: `${lambdaArn}:1`, resourceType: "AWS::Lambda::Version", properties: { FunctionName: "console-function" } },
      { logicalResourceId: "Alias", physicalResourceId: `${lambdaArn}:live`, resourceType: "AWS::Lambda::Alias", properties: { FunctionName: lambdaArn } },
      { logicalResourceId: "LogGroup", physicalResourceId: "/aws/lambda/console-function", resourceType: "AWS::Logs::LogGroup" },
      { logicalResourceId: "RestApi", physicalResourceId: "api123", resourceType: "AWS::ApiGateway::RestApi", properties: {} },
      { logicalResourceId: "ApiResource", physicalResourceId: "resource-fixture", resourceType: "AWS::ApiGateway::Resource", properties: { RestApiId: "api123" } },
      { logicalResourceId: "Method", physicalResourceId: "method-fixture", resourceType: "AWS::ApiGateway::Method", properties: { RestApiId: "api123" } },
      { logicalResourceId: "Deployment", physicalResourceId: "deployment-fixture", resourceType: "AWS::ApiGateway::Deployment", properties: { RestApiId: "api123" } },
      { logicalResourceId: "ProdStage", physicalResourceId: "stage-fixture", resourceType: "AWS::ApiGateway::Stage", properties: { RestApiId: "api123", StageName: "prod" } },
      { logicalResourceId: "Account", physicalResourceId: "000000000000:eu-west-1", resourceType: "AWS::ApiGateway::Account" },
      { logicalResourceId: "Authorizer", physicalResourceId: "authorizer-fixture", resourceType: "AWS::ApiGateway::Authorizer", properties: { RestApiId: "api123" } },
      { logicalResourceId: "Model", physicalResourceId: "model-fixture", resourceType: "AWS::ApiGateway::Model", properties: { RestApiId: "api123" } },
      { logicalResourceId: "Validator", physicalResourceId: "validator-fixture", resourceType: "AWS::ApiGateway::RequestValidator", properties: { RestApiId: "api123" } },
      { logicalResourceId: "GatewayResponse", physicalResourceId: "response-fixture", resourceType: "AWS::ApiGateway::GatewayResponse", properties: { RestApiId: "api123" } },
      { logicalResourceId: "ApiKey", physicalResourceId: "key123", resourceType: "AWS::ApiGateway::ApiKey" },
      { logicalResourceId: "UsagePlan", physicalResourceId: "plan123", resourceType: "AWS::ApiGateway::UsagePlan" },
      { logicalResourceId: "UsagePlanKey", physicalResourceId: "association-fixture", resourceType: "AWS::ApiGateway::UsagePlanKey", properties: { KeyId: "key123", UsagePlanId: "plan123" } },
      { logicalResourceId: "Table", physicalResourceId: "console-table", resourceType: "AWS::DynamoDB::Table" },
    ].map(resource => ({ ...resource, resourceStatus: "CREATE_COMPLETE", lastUpdatedTimestamp: resourceTimestamp }));

    await page.route("**/_stacksim/api/cloudformation/stacks**", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (request.method() === "GET" && path.endsWith("/cloudformation/stacks")) return json({ stacks: deleted ? [] : [stack()] });
      if (request.method() === "GET" && path.endsWith("/console-stack/events")) return json({ events: [{ eventId: "event-1", timestamp: Date.UTC(2026, 6, 20, 12, 1), logicalResourceId: "console-stack", resourceType: "AWS::CloudFormation::Stack", resourceStatus: "CREATE_COMPLETE", resourceStatusReason: "Stack creation complete" }] });
      if (request.method() === "GET" && path.endsWith("/console-stack/resources")) return json({ resources: syntheticResources, localApiInvokeLinks: [{ logicalResourceId: "ProdStage", restApiId: "api123", stageName: "prod", url: localInvokeUrl }] });
      if (request.method() === "GET" && path.endsWith("/console-stack/template")) return json({ templateBody: { AWSTemplateFormatVersion: "2010-09-09", Resources: { CdkMetadata: { Type: "AWS::CDK::Metadata" } } } });
      if (request.method() === "GET" && path.endsWith("/console-stack/change-sets")) return json({ changeSets: changeSetDeleted ? [] : [changeSet()] });
      if (request.method() === "GET" && path.endsWith("/console-stack/change-sets/pending-update")) return json({ changeSet: changeSet() });
      if (request.method() === "POST" && path.endsWith("/console-stack/change-sets/pending-update/execute")) { changeSetExecutionStatus = "EXECUTE_COMPLETE"; return json({}); }
      if (request.method() === "DELETE" && path.endsWith("/console-stack/change-sets/pending-update")) { changeSetDeleted = true; return json({}); }
      if (request.method() === "GET" && path.endsWith("/console-stack")) return json({ stack: stack() });
      if (request.method() === "PUT" && path.endsWith("/console-stack/termination-protection")) {
        protectedStack = Boolean(request.postDataJSON()?.enabled);
        return json({ enabled: protectedStack });
      }
      if (request.method() === "POST" && path.endsWith("/console-stack/rollback")) { rolledBack = true; stackStatus = "ROLLBACK_IN_PROGRESS"; statusReason = "RollbackStack requested"; return json({}); }
      if (request.method() === "POST" && path.endsWith("/console-stack/continue-update-rollback")) { continuedResources = request.postDataJSON()?.resourcesToSkip ?? []; stackStatus = "UPDATE_ROLLBACK_IN_PROGRESS"; statusReason = "ContinueUpdateRollback requested"; return json({}); }
      if (request.method() === "DELETE" && path.endsWith("/console-stack")) {
        deleted = true;
        return json({ status: "DELETE_IN_PROGRESS" });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: `Unhandled browser contract route: ${request.method()} ${path}` }) });
    });

    await page.goto(`${consoleUrl}#/cloudformation/stacks`);
    await expect(page.getByRole("heading", { name: "Stacks", exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "console-stack", exact: true }).click();
    await expect(page.getByRole("heading", { name: "console-stack", exact: true })).toBeVisible();
    await expect(page.getByText("Browser contract fixture", { exact: true })).toBeVisible();
    await expect(page.getByText("CAPABILITY_IAM", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("heading", { name: /Stack events/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Stack creation complete" })).toBeVisible();
    await page.getByRole("tab", { name: "Resources" }).click();
    await expect(page.getByRole("cell", { name: "AWS::CDK::Metadata" })).toBeVisible();
    const resourceRow = (resourceType: string) => page.getByRole("row").filter({ hasText: resourceType });
    const expectedResourceLinks: Array<[string, string]> = [
      ["AWS::IAM::Role", "#/iam/roles/console-role"],
      ["AWS::IAM::Policy", "#/iam/roles/console-role/permissions"],
      ["AWS::IAM::ManagedPolicy", `#/iam/policies/${encodeURIComponent(managedPolicyArn)}`],
      ["AWS::Lambda::Function", "#/lambda/functions/console-function"],
      ["AWS::Lambda::Permission", "#/lambda/functions/console-function"],
      ["AWS::Lambda::Version", "#/lambda/functions/console-function/versions"],
      ["AWS::Lambda::Alias", "#/lambda/functions/console-function/aliases"],
      ["AWS::Logs::LogGroup", "#/cloudwatch/log-groups/%2Faws%2Flambda%2Fconsole-function"],
      ["AWS::ApiGateway::RestApi", "#/apigateway/apis/api123"],
      ["AWS::ApiGateway::Resource", "#/apigateway/apis/api123/resources"],
      ["AWS::ApiGateway::Method", "#/apigateway/apis/api123/resources"],
      ["AWS::ApiGateway::Deployment", "#/apigateway/apis/api123/stages"],
      ["AWS::ApiGateway::Stage", "#/apigateway/apis/api123/stages"],
      ["AWS::ApiGateway::Account", "#/apigateway/account-settings"],
      ["AWS::ApiGateway::Authorizer", "#/apigateway/apis/api123/authorizers"],
      ["AWS::ApiGateway::Model", "#/apigateway/apis/api123/models"],
      ["AWS::ApiGateway::RequestValidator", "#/apigateway/apis/api123/request-validators"],
      ["AWS::ApiGateway::GatewayResponse", "#/apigateway/apis/api123/gateway-responses"],
      ["AWS::ApiGateway::ApiKey", "#/apigateway/api-keys/key123"],
      ["AWS::ApiGateway::UsagePlan", "#/apigateway/usage-plans/plan123/overview"],
      ["AWS::ApiGateway::UsagePlanKey", "#/apigateway/usage-plans/plan123/keys"],
      ["AWS::DynamoDB::Table", "#/dynamodb/tables/console-table/overview"],
    ];
    for (const [resourceType, href] of expectedResourceLinks) {
      await expect(resourceRow(resourceType).getByRole("link").first()).toHaveAttribute("href", href);
    }
    const tableRow = resourceRow("AWS::DynamoDB::Table");
    for (const [label, section] of [["Indexes", "indexes"], ["Streams", "streams"], ["Backups", "backups"], ["Permissions", "permissions"], ["Monitoring", "monitor"]]) {
      await expect(tableRow.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", `#/dynamodb/tables/console-table/${section}`);
    }
    await expect(page.getByRole("link", { name: localInvokeUrl })).toHaveAttribute("href", localInvokeUrl);
    await page.getByRole("tab", { name: "Outputs" }).click();
    await expect(page.getByRole("cell", { name: "ApiUrl", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "https://api123.execute-api.eu-west-1.amazonaws.com/prod/", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "console-api-url", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Parameters" }).click();
    await expect(page.getByRole("cell", { name: "Environment", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "browser", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Template" }).click();
    await expect(page.locator(".cloudformation-template")).toContainText("AWSTemplateFormatVersion");
    await page.getByRole("tab", { name: "Change sets" }).click();
    await expect(page.getByRole("heading", { name: /Change sets/ })).toBeVisible();
    await page.getByRole("link", { name: "pending-update", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Changes (1)", exact: true })).toBeVisible();
    await expect(page.getByText("Properties.Code", { exact: true })).toBeVisible();
    await expect(page.getByText("asset-old → asset-new", { exact: true })).toBeVisible();
    const changeSetCard = page.locator(".cloudformation-change-set-detail");
    await changeSetCard.getByRole("button", { name: "Execute", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Execute", exact: true }).click();
    await expect(changeSetCard.getByText("EXECUTE_COMPLETE", { exact: true })).toBeVisible();
    await changeSetCard.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/To confirm deletion/).fill("pending-update");
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No change sets", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Tags" }).click();
    await expect(page.getByRole("cell", { name: "environment", exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("tab", { name: "Stack info" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });

    stackStatus = "CREATE_FAILED";
    statusReason = "Create failed with rollback disabled";
    await page.reload();
    await page.getByRole("button", { name: "Roll back", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/To confirm rollback/).fill("console-stack");
    await page.getByRole("dialog").getByRole("button", { name: "Roll back", exact: true }).click();
    expect(rolledBack).toBe(true);
    await expect(page.getByText("ROLLBACK_IN_PROGRESS", { exact: true }).first()).toBeVisible();

    stackStatus = "UPDATE_ROLLBACK_FAILED";
    statusReason = "Function could not be restored";
    await page.reload();
    await page.getByRole("button", { name: "Continue update rollback", exact: true }).click();
    await page.getByRole("dialog").getByLabel(/Resources to skip/).fill("Function");
    await page.getByRole("dialog").getByLabel(/To confirm continuing rollback/).fill("console-stack");
    await page.getByRole("dialog").getByRole("button", { name: "Continue rollback", exact: true }).click();
    expect(continuedResources).toEqual(["Function"]);
    await expect(page.getByText("UPDATE_ROLLBACK_IN_PROGRESS", { exact: true }).first()).toBeVisible();

    stackStatus = "CREATE_COMPLETE";
    statusReason = "";
    await page.reload();

    await page.getByRole("button", { name: "Enable termination protection" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByText("Termination protection is enabled", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Disable termination protection" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disable", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion/).fill("console-stack");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/cloudformation\/stacks$/);
    await expect(page.getByRole("heading", { name: "No stacks", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "CloudFormation navigation" }).getByRole("link", { name: "Local CDK setup" }).click();
    await expect(page.getByRole("heading", { name: "Local CDK setup", exact: true })).toBeVisible();
    await expect(page.locator(".cloudformation-setup-code").first()).toContainText("AWS_ENDPOINT_URL");
    await expect(page.locator("main")).toContainText("npx cdk deploy");
    await expect(page.locator("main")).toContainText("cdk bootstrap");
    expect(errors).toEqual([]);
  });
});
