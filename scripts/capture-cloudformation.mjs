import { chromium } from "@playwright/test";
import {
  CloudFormationClient,
  ContinueUpdateRollbackCommand,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  RollbackStackCommand,
  UpdateStackCommand,
  UpdateTerminationProtectionCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StackSim } from "../dist/src/server.js";
import {
  cloudFormationConsoleStackTemplate,
  cloudFormationFailedStackTemplate,
} from "../dist/test/support/cloudformation-console-fixture.js";

const artifactRoot = resolve("docs/ui-reference/2026-07-21/cloudformation/cfn01-08");
const viewports = [
  { file: "desktop-1440x900.jpg", width: 1440, height: 900 },
  { file: "desktop-1280x800.jpg", width: 1280, height: 800 },
  { file: "mobile-390x844.jpg", width: 390, height: 844 },
];
const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cloudformation-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", cdkBootstrap: true });
const diagnostics = [];
let cloudformation;
let dynamodb;
let browser;

function replacementTemplate(analytics) {
  const template = JSON.parse(cloudFormationConsoleStackTemplate(analytics));
  template.Resources.FunctionLogs.Properties.LogGroupName = "/aws/lambda/console-stack-handler-replacement";
  return JSON.stringify(template);
}

function importerTemplate() {
  return JSON.stringify({
    Resources: {
      CdkMetadata: {
        Type: "AWS::CDK::Metadata",
        Properties: { Analytics: { "Fn::ImportValue": "console-api-url" } },
      },
    },
  });
}

function protectedDeleteTemplate() {
  return JSON.stringify({
    Resources: {
      ProtectedTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: "capture-delete-protected",
          BillingMode: "PAY_PER_REQUEST",
          DeletionProtectionEnabled: true,
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        },
      },
    },
  });
}

function continueRollbackBaseTemplate() {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "continue-base" } } },
  });
}

function continueRollbackFailureTemplate() {
  return JSON.stringify({
    Resources: {
      Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "continue-update" } },
      ProtectedTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: "capture-continue-protected",
          BillingMode: "PAY_PER_REQUEST",
          DeletionProtectionEnabled: true,
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        },
      },
      FailureResource: {
        Type: "AWS::ApiGateway::Resource",
        DependsOn: "ProtectedTable",
        Properties: { RestApiId: "missing-api", ParentId: "missing-parent", PathPart: "must-fail" },
      },
    },
  });
}

function observeDiagnostics(page, state, viewport) {
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") diagnostics.push(`${state}/${viewport}: ${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", error => diagnostics.push(`${state}/${viewport}: pageerror: ${error.message}`));
  page.on("requestfailed", request => diagnostics.push(`${state}/${viewport}: requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => {
    if (response.status() >= 400) diagnostics.push(`${state}/${viewport}: http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
}

async function waitForStackStatus(stackName, expected, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

async function waitForStackDeletion(stackName, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
      if (!stack || stack.StackStatus === "DELETE_COMPLETE") return;
    } catch (error) {
      if (error?.name === "ValidationError") return;
      throw error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${stackName} deletion`);
}

async function waitForChangeSet(changeSetName, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const changeSet = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: changeSetName }));
    if (changeSet.Status === "CREATE_COMPLETE") return;
    if (changeSet.Status === "FAILED") throw new Error(changeSet.StatusReason ?? `${changeSetName} failed`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${changeSetName}`);
}

async function captureState(baseUrl, spec) {
  const target = join(artifactRoot, spec.folder, "final");
  await mkdir(target, { recursive: true });
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    observeDiagnostics(page, spec.folder, viewport.file);
    const url = `${baseUrl}?capture=${encodeURIComponent(`${spec.folder}-${viewport.file}`)}${spec.hash}`;
    await page.goto(url);
    await page.locator("main h1").first().waitFor();
    if (spec.prepare) await spec.prepare(page);
    if (spec.expected) await page.getByText(spec.expected, { exact: false }).first().waitFor();
    await page.evaluate(async preserveScroll => {
      const main = document.querySelector("main");
      if (main && !preserveScroll) {
        main.scrollTop = main.scrollHeight;
        await new Promise(resolvePaint => requestAnimationFrame(resolvePaint));
        main.scrollTop = 0;
      }
      await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
    }, Boolean(spec.preserveScroll));
    const dimensions = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        mainWidth: main?.clientWidth ?? 0,
        mainScrollWidth: main?.scrollWidth ?? 0,
      };
    });
    if (dimensions.width !== viewport.width || dimensions.height !== viewport.height || dimensions.documentWidth > viewport.width || dimensions.mainScrollWidth > dimensions.mainWidth) {
      throw new Error(`${spec.folder} overflowed ${viewport.file}: ${JSON.stringify(dimensions)}`);
    }
    await page.mouse.move(Math.max(1, viewport.width - 2), Math.max(45, viewport.height - 2));
    await page.screenshot({ path: join(target, viewport.file), type: "jpeg", quality: 88, fullPage: true });
    await page.close();
  }
}

export async function captureCloudFormationConsole(browserInstance) {
  browser = browserInstance;
  try {
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const baseUrl = `${endpoint}/_stacksim/console`;
  cloudformation = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
  dynamodb = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
  await cloudformation.send(new CreateStackCommand({
    StackName: "console-stack",
    TemplateBody: cloudFormationConsoleStackTemplate("browser-v1"),
    Parameters: [{ ParameterKey: "Environment", ParameterValue: "browser" }],
    Capabilities: ["CAPABILITY_NAMED_IAM"],
    Tags: [{ Key: "environment", Value: "browser" }, { Key: "owner", Value: "console-capture" }],
  }));
  await waitForStackStatus("console-stack", "CREATE_COMPLETE");
  await cloudformation.send(new UpdateStackCommand({
    StackName: "console-stack",
    TemplateBody: cloudFormationConsoleStackTemplate("browser-v2"),
    Parameters: [{ ParameterKey: "Environment", UsePreviousValue: true }],
    Capabilities: ["CAPABILITY_NAMED_IAM"],
  }));
  await waitForStackStatus("console-stack", "UPDATE_COMPLETE");
  await cloudformation.send(new CreateChangeSetCommand({
    StackName: "console-stack",
    ChangeSetName: "pending-update",
    ChangeSetType: "UPDATE",
    Description: "Update the CDK metadata release marker",
    TemplateBody: cloudFormationConsoleStackTemplate("browser-v3"),
    Parameters: [{ ParameterKey: "Environment", UsePreviousValue: true }],
    Capabilities: ["CAPABILITY_NAMED_IAM"],
    Tags: [{ Key: "environment", Value: "browser" }, { Key: "owner", Value: "console-capture" }],
  }));
  await waitForChangeSet("pending-update");
  await cloudformation.send(new CreateChangeSetCommand({
    StackName: "console-stack",
    ChangeSetName: "replacement-review",
    ChangeSetType: "UPDATE",
    Description: "Review a physical log-group replacement",
    TemplateBody: replacementTemplate("browser-v3"),
    Parameters: [{ ParameterKey: "Environment", UsePreviousValue: true }],
    Capabilities: ["CAPABILITY_NAMED_IAM"],
    Tags: [{ Key: "environment", Value: "browser" }, { Key: "owner", Value: "console-capture" }],
  }));
  await waitForChangeSet("replacement-review");
  await cloudformation.send(new CreateStackCommand({ StackName: "console-importer", TemplateBody: importerTemplate() }));
  await waitForStackStatus("console-importer", "CREATE_COMPLETE");

  const stackRoot = "#/cloudformation/stacks/console-stack";
  const states = [
    { folder: "stacks", hash: "#/cloudformation/stacks", expected: "console-stack" },
    {
      folder: "create-change-set-dialog",
      hash: "#/cloudformation/stacks",
      expected: "CREATE targets a new stack",
      prepare: async page => {
        await page.getByRole("button", { name: "Create change set", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Stack name").fill("planned-console-stack");
        await dialog.getByLabel("Change set type").selectOption("CREATE");
        await dialog.getByLabel("Change set name").fill("initial-create");
        await dialog.getByLabel("Description").fill("Review a new stack before execution");
      },
    },
    { folder: "overview", hash: `${stackRoot}/overview`, expected: "Real browser Lambda, REST API, and DynamoDB stack" },
    {
      folder: "update-dialog",
      hash: `${stackRoot}/overview`,
      expected: "Direct stack update",
      prepare: async page => {
        await page.getByRole("button", { name: "Update", exact: true }).click();
        await page.getByRole("dialog").getByLabel("Parameter overrides (JSON object)").fill('{"Environment":"capture"}');
      },
    },
    { folder: "events", hash: `${stackRoot}/events`, expected: "Stack events" },
    {
      folder: "events-operation-filter",
      hash: `${stackRoot}/events`,
      expected: "Operation ID",
      prepare: async page => {
        const selector = page.getByLabel("Operation ID filter");
        const operationId = await selector.locator("option").nth(1).getAttribute("value");
        if (!operationId) throw new Error("Expected at least one durable operation ID to filter");
        await selector.selectOption(operationId);
        await page.waitForFunction(expectedOperationId => {
          const cells = [...document.querySelectorAll(".cloudformation-event-operation")];
          return cells.length > 0 && cells.every(cell => cell.textContent?.trim() === expectedOperationId);
        }, operationId);
      },
    },
    { folder: "resources", hash: `${stackRoot}/resources`, expected: "Local API invoke links" },
    { folder: "outputs", hash: `${stackRoot}/outputs`, expected: "AWS-shaped CDK output" },
    { folder: "parameters", hash: `${stackRoot}/parameters`, expected: "Environment" },
    { folder: "template", hash: `${stackRoot}/template`, expected: "AWS::ApiGateway::Stage" },
    { folder: "change-sets", hash: `${stackRoot}/change-sets`, expected: "pending-update" },
    { folder: "change-set-detail", hash: `${stackRoot}/change-sets/pending-update`, expected: "Properties.Analytics" },
    { folder: "replacement-change-set-detail", hash: `${stackRoot}/change-sets/replacement-review`, expected: "1 resource replacement may occur" },
    {
      folder: "replacement-change-set-detail-right-edge",
      hash: `${stackRoot}/change-sets/replacement-review`,
      expected: "ReplaceAndDelete",
      preserveScroll: true,
      prepare: page => page.locator(".cloudformation-change-table").evaluate(table => {
        const wrapper = table.closest(".table-wrap");
        if (wrapper) wrapper.scrollLeft = wrapper.scrollWidth;
      }),
    },
    { folder: "tags", hash: `${stackRoot}/tags`, expected: "console-capture" },
    { folder: "exports", hash: "#/cloudformation/exports", expected: "console-importer" },
    { folder: "export-detail", hash: "#/cloudformation/exports/console-api-url", expected: "Importing stacks (1)" },
    { folder: "setup", hash: "#/cloudformation/setup", expected: "AWS_ENDPOINT_URL" },
    {
      folder: "setup-code",
      hash: "#/cloudformation/setup",
      expected: "npx cdk deploy",
      preserveScroll: true,
      prepare: page => page.locator(".cloudformation-setup-code").first().scrollIntoViewIfNeeded(),
    },
  ];
  for (const state of states) await captureState(baseUrl, state);

  await cloudformation.send(new UpdateTerminationProtectionCommand({ StackName: "console-stack", EnableTerminationProtection: true }));
  await captureState(baseUrl, { folder: "termination-protection", hash: `${stackRoot}/overview`, expected: "Termination protection is enabled" });
  await cloudformation.send(new UpdateTerminationProtectionCommand({ StackName: "console-stack", EnableTerminationProtection: false }));
  await captureState(baseUrl, {
    folder: "delete-dialog",
    hash: `${stackRoot}/overview`,
    expected: "To confirm deletion",
    prepare: async page => {
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog").getByLabel(/To confirm deletion/).fill("console-stack");
    },
  });

  await cloudformation.send(new CreateStackCommand({ StackName: "failed-console-stack", TemplateBody: cloudFormationFailedStackTemplate(), DisableRollback: true }));
  await waitForStackStatus("failed-console-stack", "CREATE_FAILED");
  const failedRoot = "#/cloudformation/stacks/failed-console-stack/overview";
  await captureState(baseUrl, { folder: "create-failed", hash: failedRoot, expected: "Output Invalid must resolve" });
  await captureState(baseUrl, {
    folder: "rollback-dialog",
    hash: failedRoot,
    expected: "This is a destructive recovery operation",
    prepare: async page => {
      await page.getByRole("button", { name: "Roll back", exact: true }).click();
      await page.getByRole("dialog").getByLabel(/To confirm rollback/).fill("failed-console-stack");
    },
  });

  await cloudformation.send(new RollbackStackCommand({ StackName: "failed-console-stack" }));
  await waitForStackStatus("failed-console-stack", "ROLLBACK_COMPLETE");
  await cloudformation.send(new DeleteStackCommand({ StackName: "failed-console-stack" }));
  await waitForStackDeletion("failed-console-stack");

  await cloudformation.send(new CreateStackCommand({ StackName: "continue-capture-stack", TemplateBody: continueRollbackBaseTemplate() }));
  await waitForStackStatus("continue-capture-stack", "CREATE_COMPLETE");
  await cloudformation.send(new UpdateStackCommand({ StackName: "continue-capture-stack", TemplateBody: continueRollbackFailureTemplate() }));
  await waitForStackStatus("continue-capture-stack", "UPDATE_ROLLBACK_FAILED");
  await captureState(baseUrl, {
    folder: "continue-update-rollback-dialog",
    hash: "#/cloudformation/stacks/continue-capture-stack/overview",
    expected: "Skipped resources may no longer match the template",
    prepare: async page => {
      await page.getByRole("button", { name: "Continue update rollback", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/Resources to skip/).fill("ProtectedTable");
      await dialog.getByLabel(/To confirm continuing rollback/).fill("continue-capture-stack");
    },
  });
  await cloudformation.send(new ContinueUpdateRollbackCommand({ StackName: "continue-capture-stack", ResourcesToSkip: ["ProtectedTable"] }));
  await waitForStackStatus("continue-capture-stack", "UPDATE_ROLLBACK_COMPLETE");
  await dynamodb.send(new UpdateTableCommand({ TableName: "capture-continue-protected", DeletionProtectionEnabled: false }));
  await cloudformation.send(new DeleteStackCommand({ StackName: "continue-capture-stack" }));
  await waitForStackDeletion("continue-capture-stack");

  await cloudformation.send(new CreateStackCommand({ StackName: "delete-retry-capture-stack", TemplateBody: protectedDeleteTemplate() }));
  await waitForStackStatus("delete-retry-capture-stack", "CREATE_COMPLETE");
  await cloudformation.send(new DeleteStackCommand({ StackName: "delete-retry-capture-stack" }));
  await waitForStackStatus("delete-retry-capture-stack", "DELETE_FAILED");
  const prepareDeleteRetry = mode => async page => {
    await page.getByRole("button", { name: "Retry delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Deletion mode").selectOption(mode);
    await dialog.getByRole("checkbox", { name: /ProtectedTable/ }).check();
    await dialog.getByLabel(/To confirm retrying deletion/).fill("delete-retry-capture-stack");
  };
  await captureState(baseUrl, {
    folder: "delete-retry-standard-dialog",
    hash: "#/cloudformation/stacks/delete-retry-capture-stack/overview",
    expected: "Retry a failed stack deletion",
    prepare: prepareDeleteRetry("STANDARD"),
  });
  await captureState(baseUrl, {
    folder: "delete-retry-force-dialog",
    hash: "#/cloudformation/stacks/delete-retry-capture-stack/overview",
    expected: "Retry a failed stack deletion",
    prepare: prepareDeleteRetry("FORCE_DELETE_STACK"),
  });
  await cloudformation.send(new DeleteStackCommand({ StackName: "delete-retry-capture-stack", DeletionMode: "FORCE_DELETE_STACK" }));
  await waitForStackDeletion("delete-retry-capture-stack");

  await cloudformation.send(new DeleteStackCommand({ StackName: "console-importer" }));
  await waitForStackDeletion("console-importer");
  await cloudformation.send(new DeleteStackCommand({ StackName: "console-stack" }));
  await waitForStackDeletion("console-stack");
  await captureState(baseUrl, { folder: "empty", hash: "#/cloudformation/stacks", expected: "No stacks" });

  if (diagnostics.length) throw new Error(`Browser diagnostics were emitted:\n${diagnostics.join("\n")}`);
  console.log(`Captured CloudFormation CFN-01 through CFN-08 states under ${artifactRoot}`);
  } finally {
    dynamodb?.destroy();
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const launchedBrowser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  try {
    await captureCloudFormationConsole(launchedBrowser);
  } finally {
    await launchedBrowser.close();
  }
}
