import { expect, test, type Page } from "@playwright/test";
import { CloudFormationClient, CreateStackCommand, DescribeStackResourcesCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { EventBridgeClient, PutEventsCommand, PutRuleCommand } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateActivityCommand, CreateStateMachineCommand, DescribeExecutionCommand, DescribeStateMachineCommand, DescribeStateMachineForExecutionCommand, GetExecutionHistoryCommand, ListExecutionsCommand, ListTagsForResourceCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip } from "../../src/core/zip-create.js";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function sdkOptions() {
  return { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

async function openDefinitionJson(page: Page) {
  await page.keyboard.press("Escape");
  await page.locator(".arn-combobox[data-open='true']").evaluateAll(nodes => nodes.forEach(node => node.setAttribute("data-open", "false")));
  await page.locator(".arn-combobox-list").evaluateAll(nodes => nodes.forEach(node => { (node as HTMLElement).hidden = true; }));
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await expect(page.getByLabel("Definition (States Language JSON)")).toBeVisible();
}

// The create flow starts with a template and a name, then opens Workflow Studio in Design mode.
async function continueToStudio(page: Page, name: string) {
  await page.getByLabel("State machine name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("tab", { name: "Design", exact: true })).toHaveAttribute("aria-selected", "true");
}

async function chooseExistingRole(page: Page, roleArn: string) {
  await page.getByRole("tab", { name: "Config", exact: true }).click();
  await page.getByRole("radio", { name: /Choose an existing role/ }).check();
  await page.getByLabel("Execution role ARN").fill(roleArn);
  await page.keyboard.press("Escape");
}

// A new state machine offers to start an execution straight away.
async function dismissStartOffer(page: Page) {
  const offer = page.getByRole("dialog");
  await expect(offer.getByRole("heading", { name: "Start execution" })).toBeVisible();
  await offer.getByRole("button", { name: "Cancel" }).click();
  await expect(offer).not.toBeVisible();
}

async function startExecution(page: Page, name: string, input?: string) {
  await page.getByRole("button", { name: "Start execution" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name - optional").fill(name);
  if (input !== undefined) await dialog.getByLabel("Input - optional").fill(input);
  await dialog.getByRole("button", { name: "Start execution" }).click();
  await expect(page).toHaveURL(executionUrl);
}

const executionUrl = /#\/step-functions\/state-machines\/[^/]+\/executions\//;

async function expectPanelHelp(page: Page, name: string, copy: string) {
  const button = page.getByRole("button", { name: `About ${name}` });
  await expect(button).toBeVisible();
  await button.hover();
  const tooltipId = await button.getAttribute("aria-describedby");
  const tooltip = page.locator(`#${tooltipId}`);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(copy);
  await expect(tooltip).toContainText("StackSim support");
  return tooltip;
}

async function rolesAndFunction() {
  const iam = new IAMClient(sdkOptions());
  const lambda = new LambdaClient(sdkOptions());
  try {
    const workflow = await iam.send(new CreateRoleCommand({ RoleName: "browser-sfn-workflow", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    const worker = await iam.send(new CreateRoleCommand({ RoleName: "browser-sfn-lambda", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    const code = createZip([{ name: "index.js", content: `let attempts = 0; exports.handler = async event => { attempts++; if (attempts === 1) { const error = new Error("retry me"); error.name = "RetryOnce"; throw error; } return { echoed: event, attempt: attempts }; };` }]);
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "browser-sfn-worker", Runtime: "nodejs22.x", Handler: "index.handler", Role: worker.Role!.Arn!, Code: { ZipFile: code } }));
    return { workflowRoleArn: workflow.Role!.Arn!, functionArn: fn.FunctionArn! };
  } finally { iam.destroy(); lambda.destroy(); }
}

async function waitTerminal(client: SFNClient, executionArn: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const execution = await client.send(new DescribeExecutionCommand({ executionArn }));
    if (execution.status !== "RUNNING") return execution;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("execution did not become terminal");
}

test.describe("Step Functions console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-sfn-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off", cdkBootstrap: false });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("navigates deployed workflows, Activities, stack ownership, roles and execution destinations", async ({ page }) => {
    const errors = browserErrors(page);
    const fixture = await rolesAndFunction();
    const cfn = new CloudFormationClient(sdkOptions());
    const sfn = new SFNClient(sdkOptions());
    try {
      const stack = await cfn.send(new CreateStackCommand({ StackName: "BrowserWorkflow", TemplateBody: JSON.stringify({ Resources: {
        Review: { Type: "AWS::StepFunctions::Activity", Properties: { Name: "browser-stack-review", Tags: [{ Key: "team", Value: "orders" }] } },
        Workflow: { Type: "AWS::StepFunctions::StateMachine", Properties: { StateMachineName: "browser-stack-workflow", RoleArn: fixture.workflowRoleArn, Definition: { StartAt: "Invoke", States: { Invoke: { Type: "Task", Resource: fixture.functionArn, Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 1 }], End: true } } } } },
      } }) }));
      await expect.poll(async () => (await cfn.send(new DescribeStacksCommand({ StackName: stack.StackId }))).Stacks?.[0]?.StackStatus).toBe("CREATE_COMPLETE");
      const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack.StackId }))).StackResources!;
      const machineArn = resources.find(item => item.LogicalResourceId === "Workflow")!.PhysicalResourceId!;
      const activityArn = resources.find(item => item.LogicalResourceId === "Review")!.PhysicalResourceId!;
      const stackRoute = `#/cloudformation/stacks/${encodeURIComponent(stack.StackId!)}/resources`;
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${consoleUrl}${stackRoute}`);
        await page.getByRole("link", { name: machineArn, exact: true }).click();
        await expect(page.getByRole("heading", { name: "CloudFormation deployment" })).toBeVisible();
        await expect(page.getByRole("link", { name: "BrowserWorkflow", exact: true })).toHaveAttribute("href", stackRoute);
        await expect(page.getByRole("link", { name: fixture.workflowRoleArn, exact: true })).toHaveAttribute("href", "#/iam/roles/browser-sfn-workflow");
        await expect(page.getByRole("link", { name: "browser-sfn-worker logs and metrics" })).toHaveAttribute("href", "#/lambda/functions/browser-sfn-worker/monitor");
        await page.getByRole("link", { name: "BrowserWorkflow", exact: true }).click();
        await page.getByRole("link", { name: activityArn, exact: true }).click();
        await expect(page.getByRole("heading", { name: "Activity details" })).toBeVisible();
        await expect(page.getByRole("cell", { name: "orders", exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "BrowserWorkflow", exact: true })).toHaveAttribute("href", stackRoute);
        await expect(page.getByRole("link", { name: "Inspect execution histories" })).toHaveAttribute("href", "#/step-functions/executions");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machineArn)}/tags`);
      await page.getByRole("button", { name: "Manage tags", exact: true }).click();
      await page.getByRole("dialog").getByText("Edit as JSON").click();
      const tagEditor = page.getByRole("dialog").getByLabel("Tags (JSON object)");
      await expect(tagEditor).not.toHaveValue(/aws:cloudformation/);
      await tagEditor.fill('{"team":"updated-orders"}');
      await tagEditor.blur();
      await page.getByRole("button", { name: "Save tags", exact: true }).click();
      await expect.poll(async () => (await sfn.send(new ListTagsForResourceCommand({ resourceArn: machineArn }))).tags?.find(tag => tag.key === "team")?.value).toBe("updated-orders");
      expect((await sfn.send(new ListTagsForResourceCommand({ resourceArn: machineArn }))).tags?.find(tag => tag.key === "aws:cloudformation:stack-id")?.value).toBe(stack.StackId);
      const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: machineArn }));
      await waitTerminal(sfn, started.executionArn!);
      await page.goto(`${consoleUrl}#/step-functions/executions/${encodeURIComponent(started.executionArn!)}`);
      await expect(page.getByRole("link", { name: fixture.workflowRoleArn, exact: true })).toHaveAttribute("href", "#/iam/roles/browser-sfn-workflow");
      await expect(page.getByRole("link", { name: "browser-sfn-worker logs and metrics" })).toHaveAttribute("href", "#/lambda/functions/browser-sfn-worker/monitor");
      await expect(page.getByRole("tab", { name: "Event view" })).toBeVisible();
      await page.getByRole("link", { name: fixture.workflowRoleArn, exact: true }).click();
      await expect(page.getByRole("heading", { name: "browser-sfn-workflow", exact: true })).toBeVisible();
      await page.goto(`${consoleUrl}#/step-functions/executions/${encodeURIComponent(started.executionArn!)}`);
      await page.getByRole("link", { name: "browser-sfn-worker logs and metrics" }).click();
      await expect(page.getByRole("heading", { name: "Recent invocation logs", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { cfn.destroy(); sfn.destroy(); }
  });

  test("explains Step Functions input panels and support boundaries", async ({ page }) => {
    const errors = browserErrors(page);
    const fixture = await rolesAndFunction();
    const sfn = new SFNClient(sdkOptions());
    try {
      const definition = JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } });
      const machine = await sfn.send(new CreateStateMachineCommand({ name: "tooltip-workflow", roleArn: fixture.workflowRoleArn, definition, tags: [{ key: "team", value: "browser" }] }));
      const machineRoute = `#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}`;
      await page.setViewportSize({ width: 390, height: 844 });

      await page.goto(`${consoleUrl}#/step-functions/state-machines`);
      const catalogTooltip = await expectPanelHelp(page, "State machines", "durable workflow definition");
      await expect(catalogTooltip).toContainText("Express workflows");
      const bounds = await catalogTooltip.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);

      await page.goto(`${consoleUrl}#/step-functions/state-machines/create`);
      await continueToStudio(page, "tooltip-create");
      await expectPanelHelp(page, "Workflow configuration", "execution role");
      await page.goto(`${consoleUrl}${machineRoute}/edit`);
      await expectPanelHelp(page, "Definition and role", "affects only executions started afterward");
      await page.goto(`${consoleUrl}${machineRoute}/definition`);
      await expectPanelHelp(page, "Definition", "read-only view");
      await page.goto(`${consoleUrl}${machineRoute}/tags`);
      await expectPanelHelp(page, "Tags", "key-value labels");
      await page.goto(`${consoleUrl}${machineRoute}`);
      await expectPanelHelp(page, "Executions", "one run of a state machine");

      await startExecution(page, "tooltip-run", '{"source":"tooltip-test"}');
      await expectPanelHelp(page, "Execution inspection", "filter and search typed history");
      expect(errors).toEqual([]);
    } finally { sfn.destroy(); }
  });

  test("creates, validates, edits, tags, polls, stops, and inspects successful and failed executions", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = browserErrors(page);
    const fixture = await rolesAndFunction();
    const sfn = new SFNClient(sdkOptions());
    let describeRequests = 0;
    page.on("request", request => { if (request.headers()["x-amz-target"] === "AWSStepFunctions.DescribeExecution") describeRequests++; });
    try {
      await page.goto(`${consoleUrl}#/step-functions/state-machines/create`);
      await continueToStudio(page, "browser-workflow");
      await chooseExistingRole(page, fixture.workflowRoleArn);
      await page.getByRole("button", { name: "Add new tag" }).click();
      await page.getByLabel("Key", { exact: true }).fill("team");
      await page.getByLabel("Value - optional").fill("console");
      await openDefinitionJson(page);
      await page.getByLabel("Definition (States Language JSON)").fill('{"StartAt":"Missing","States":{}}');
      await page.getByRole("button", { name: "Validate", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("diagnostic");
      const waitingDefinition = JSON.stringify({ StartAt: "Hold", States: { Hold: { Type: "Wait", Seconds: 60, End: true } } }, null, 2);
      await page.getByLabel("Definition (States Language JSON)").fill(waitingDefinition);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await dismissStartOffer(page);
      await expect(page.getByRole("heading", { name: "browser-workflow" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Executions" })).toHaveAttribute("aria-selected", "true");
      const machineArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);

      await page.getByRole("tab", { name: "Tags" }).click();
      await expect(page.getByRole("cell", { name: "team" })).toBeVisible();
      await page.getByRole("button", { name: "Manage tags" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Remove" }).click();
      await dialog.getByRole("button", { name: "Add new tag" }).click();
      await dialog.getByLabel("Key", { exact: true }).fill("owner");
      await dialog.getByLabel("Value - optional").fill("browser");
      await dialog.getByRole("button", { name: "Add new tag" }).click();
      await dialog.getByLabel("Key", { exact: true }).nth(1).fill("stage");
      await dialog.getByLabel("Value - optional").nth(1).fill("test");
      await dialog.getByRole("button", { name: "Save tags" }).click();
      await expect(page.getByRole("cell", { name: "owner" })).toBeVisible();
      await expect(page.getByRole("cell", { name: "team" })).toHaveCount(0);
      expect((await sfn.send(new ListTagsForResourceCommand({ resourceArn: machineArn }))).tags).toEqual([{ key: "owner", value: "browser" }, { key: "stage", value: "test" }]);

      await startExecution(page, "running-inspection", '{"request":"running"}');
      await expect(page.getByRole("heading", { name: "running-inspection" })).toBeVisible();
      const runningArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("00:00:", { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Inspect Hold state" })).toHaveClass(/active/);
      const beforePoll = describeRequests;
      await expect.poll(() => describeRequests, { timeout: 5000 }).toBeGreaterThan(beforePoll);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await page.getByRole("tab", { name: "Event view" }).click();
      await expect(page.locator("[data-event-table]").getByRole("button", { name: "WaitStateEntered", exact: true })).toBeVisible();
      await page.locator("[data-event-table]").getByRole("button", { name: "WaitStateEntered", exact: true }).click();
      await expect(page.getByRole("heading", { name: /^Event \d+$/ })).toBeVisible();
      await expect(page.getByText("Previous event", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stop execution" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Error - optional")).toHaveValue("");
      await dialog.getByLabel("Cause - optional").fill("Stopped by the browser test");
      await dialog.getByRole("button", { name: "Stop execution" }).click();
      await expect(page.getByText("Aborted", { exact: true }).first()).toBeVisible();
      const stopped = await sfn.send(new DescribeExecutionCommand({ executionArn: runningArn }));
      expect(stopped.error).toBeUndefined();
      expect(stopped.cause).toBe("Stopped by the browser test");
      await page.getByRole("tab", { name: "Graph view" }).click();
      await expect(page.getByRole("button", { name: "Inspect Hold state" })).not.toHaveClass(/active/);

      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machineArn)}/edit`);
      await page.getByRole("tab", { name: "Config", exact: true }).click();
      await page.getByLabel("Execution role ARN").fill(`${fixture.workflowRoleArn}-dirty`);
      await page.keyboard.press("Escape");
      await page.getByRole("link", { name: "Cancel" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByLabel("Execution role ARN").fill(fixture.workflowRoleArn);
      await openDefinitionJson(page);
      await page.getByLabel("Definition (States Language JSON)").fill('{"StartAt":"Nope","States":{}}');
      await page.getByRole("button", { name: "Validate", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("diagnostic");
      const nestedDefinition = JSON.stringify({
        StartAt: "Invoke",
        States: {
          Invoke: { Type: "Task", Resource: fixture.functionArn, ResultPath: "$.invoke", Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 1, MaxAttempts: 2 }], Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.failure", Next: "Branches" }], Next: "Branches" },
          Branches: {
            Type: "Parallel",
            Branches: [
              { StartAt: "A", States: { A: { Type: "Pass", Result: "a", End: true } } },
              { StartAt: "B", States: { B: { Type: "Pass", Result: "b", End: true } } },
            ],
            ResultPath: "$.branches",
            Next: "Items",
          },
          Items: { Type: "Map", ItemsPath: "$.items", ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Copy", States: { Copy: { Type: "Pass", End: true } } }, End: true },
        },
      }, null, 2);
      await page.getByLabel("Definition (States Language JSON)").fill(nestedDefinition);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText(/existing execution snapshots are unchanged/i)).toBeVisible();
      await expect(page.getByText("Latest update", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Definition" }).click();
      await expect(page.locator('a[href="#/lambda/functions/browser-sfn-worker"]')).toBeVisible();
      await expect(page.getByRole("heading", { name: "Branches · branch 1" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Items · item processor" })).toBeVisible();

      await startExecution(page, "nested-success", '{"items":["x","y"]}');
      const successArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await waitTerminal(sfn, successArn);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await expect(page.getByText("Succeeded", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Retry-attempt timeline (1)" })).toBeVisible();
      await expect(page.getByText("Iteration 0", { exact: true })).toBeVisible();
      await expect(page.getByText("Iteration 1", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Event view" }).click();
      await page.getByLabel("Event filter").selectOption("nested");
      await expect(page.locator("[data-event-table]").getByRole("button", { name: "ParallelStateStarted", exact: true })).toBeVisible();
      await page.getByLabel("Order").selectOption("reverse");
      await expect(page.locator("[data-event-table] .sfn-history tbody tr").first()).toContainText("MapStateExited");
      const snapshot = await sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: successArn }));
      expect(snapshot.definition).toBe(nestedDefinition);
      expect((await sfn.send(new GetExecutionHistoryCommand({ executionArn: successArn }))).events?.length).toBeGreaterThan(1);

      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machineArn)}/edit`);
      const failedDefinition = JSON.stringify({ StartAt: "Broken", States: { Broken: { Type: "Fail", Error: "ExpectedFailure", Cause: "browser failure" } } }, null, 2);
      await openDefinitionJson(page);
      await page.getByLabel("Definition (States Language JSON)").fill(failedDefinition);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await startExecution(page, "expected-failure", '{"safe":"visible"}');
      const failedArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await waitTerminal(sfn, failedArn);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "View step details" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Inspect Broken state" })).toHaveClass(/status-failed/);
      await expect(page.getByRole("heading", { name: "Failure summary" })).toBeVisible();
      await expect(page.getByText("ExpectedFailure", { exact: true }).first()).toBeVisible();
      await expect(page.locator("main")).toContainText('"safe": "visible"');

      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machineArn)}`);
      await page.getByRole("button", { name: "Delete" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("immutable definition snapshots");
      await dialog.getByLabel(/To confirm deletion/).fill("browser-workflow");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No state machines" })).toBeVisible();
      await page.goto(`${consoleUrl}#/step-functions/executions/${encodeURIComponent(runningArn)}`);
      await expect(page.getByRole("heading", { name: "running-inspection" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { sfn.destroy(); }
  });

  test("contains list, detail, edit, nested graph, and execution history at 390 pixels", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = browserErrors(page);
    const fixture = await rolesAndFunction();
    const sfn = new SFNClient(sdkOptions());
    try {
      const definition = JSON.stringify({ StartAt: "Nested", States: { Nested: { Type: "Parallel", Branches: [{ StartAt: "Done", States: { Done: { Type: "Succeed" } } }], End: true } } });
      const machine = await sfn.send(new CreateStateMachineCommand({ name: "mobile-workflow", roleArn: fixture.workflowRoleArn, definition }));
      await page.setViewportSize({ width: 390, height: 844 });
      for (const hash of ["#/step-functions/state-machines", `#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}`, `#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}/definition`, `#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}/edit`]) {
        await page.goto(`${consoleUrl}${hash}`);
        await expect(page.getByRole("heading", { name: hash.endsWith("/edit") ? "Edit mobile-workflow" : hash.endsWith("state-machines") ? "State machines" : "mobile-workflow", exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      }
      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}`);
      await startExecution(page, "mobile-run");
      const executionArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await waitTerminal(sfn, executionArn);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await page.getByRole("tab", { name: "Event view" }).click();
      await expect(page.getByLabel("Event filter")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect(errors).toEqual([]);
    } finally { sfn.destroy(); }
  });

  test("authors a workflow in the visual editor and round-trips to JSON", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = browserErrors(page);
    const fixture = await rolesAndFunction();
    const sfn = new SFNClient(sdkOptions());
    try {
      await page.goto(`${consoleUrl}#/step-functions/state-machines/create`);
      await continueToStudio(page, "visual-workflow");
      await expect(page.getByRole("button", { name: "Edit Hello state" })).toBeVisible();
      await page.getByRole("button", { name: "Add Task state" }).click();
      await expect(page.getByRole("button", { name: "Edit Task state" })).toBeVisible();
      await page.getByLabel("State name", { exact: true }).fill("InvokeWorker");
      await page.getByLabel("State name", { exact: true }).blur();
      await expect(page.getByRole("button", { name: "Edit InvokeWorker state" })).toBeVisible();
      await page.locator("[data-studio-resource]").fill(fixture.functionArn);
      await page.locator("[data-studio-parameters]").fill("{}");
      await page.getByLabel("Next state").selectOption({ label: "End" });
      await page.getByRole("button", { name: "Edit Hello state" }).click();
      await page.getByLabel("Next state").selectOption("InvokeWorker");
      await openDefinitionJson(page);
      const definition = await page.getByLabel("Definition (States Language JSON)").inputValue();
      expect(JSON.parse(definition)).toMatchObject({
        StartAt: "Hello",
        States: {
          Hello: { Type: "Pass", Next: "InvokeWorker" },
          InvokeWorker: { Type: "Task", Resource: fixture.functionArn, End: true },
        },
      });
      await page.getByRole("tab", { name: "Design", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit InvokeWorker state" })).toBeVisible();
      await chooseExistingRole(page, fixture.workflowRoleArn);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await dismissStartOffer(page);
      await expect(page.getByRole("heading", { name: "visual-workflow" })).toBeVisible();
      const machineArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      const described = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: machineArn }));
      expect(JSON.parse(described.definition!)).toMatchObject({
        StartAt: "Hello",
        States: {
          Hello: { Type: "Pass", Next: "InvokeWorker" },
          InvokeWorker: { Type: "Task", Resource: fixture.functionArn, End: true },
        },
      });
      expect(errors).toEqual([]);
    } finally { sfn.destroy(); }
  });

  test("reconstructs an existing JSON workflow for lossless visual editing", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = browserErrors(page);
    const fixture = await rolesAndFunction();
    const sfn = new SFNClient(sdkOptions());
    try {
      const original = {
        Comment: "Created through the SDK",
        TimeoutSeconds: 300,
        StartAt: "Prepare",
        States: {
          Prepare: { Type: "Pass", Result: { source: "sdk" }, ResultPath: "$.prepared", Next: "Delay" },
          Delay: { Type: "Wait", SecondsPath: "$.delaySeconds", Next: "Finish" },
          Finish: { Type: "Succeed", Comment: "Keep this state" },
        },
      };
      const machine = await sfn.send(new CreateStateMachineCommand({ name: "imported-workflow", roleArn: fixture.workflowRoleArn, definition: JSON.stringify(original) }));

      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}/edit`);
      await expect(page.getByRole("tab", { name: "Design", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("button", { name: "Edit Prepare state" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit Delay state" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit Finish state" })).toBeVisible();

      await page.getByRole("button", { name: "Edit Prepare state" }).click();
      await page.getByLabel("State name", { exact: true }).fill("PrepareInput");
      await page.getByLabel("State name", { exact: true }).blur();
      await page.getByRole("button", { name: "Edit Delay state" }).click();
      await expect(page.getByLabel("Wait timing")).toHaveValue("SecondsPath · $.delaySeconds");
      await page.getByLabel("Comment", { exact: true }).fill("Delay supplied by input");
      await page.getByLabel("Comment", { exact: true }).blur();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText(/existing execution snapshots are unchanged/i)).toBeVisible();

      const described = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: machine.stateMachineArn! }));
      expect(JSON.parse(described.definition!)).toEqual({
        ...original,
        StartAt: "PrepareInput",
        States: {
          PrepareInput: original.States.Prepare,
          Delay: { ...original.States.Delay, Comment: "Delay supplied by input" },
          Finish: original.States.Finish,
        },
      });
      expect(errors).toEqual([]);
    } finally { sfn.destroy(); }
  });

  test("lists and creates Activities without exposing task tokens at 390 pixels", async ({ page }) => {
    const errors = browserErrors(page); const sfn = new SFNClient(sdkOptions());
    try {
      await sfn.send(new CreateActivityCommand({ name: "browser-review" })); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${consoleUrl}#/step-functions/activities`);
      await expect(page.getByRole("heading", { name: "Activities" })).toBeVisible(); await expect(page.getByRole("cell", { name: "browser-review", exact: true })).toBeVisible(); await expect(page.getByText("Worker names and raw task tokens are never displayed.")).toBeVisible();
      await page.getByRole("button", { name: "Create activity" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("mobile-review"); await dialog.getByRole("button", { name: "Create activity" }).click(); await expect(page.getByRole("cell", { name: "mobile-review", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390); expect(await page.locator("body").textContent()).not.toContain("Task.Token"); expect(errors).toEqual([]);
    } finally { sfn.destroy(); }
  });

  test("configures an EventBridge state-machine target with explicit execution-role guidance", async ({ page }) => {
    const errors = browserErrors(page); const fixture = await rolesAndFunction(); const sfn = new SFNClient(sdkOptions()); const events = new EventBridgeClient(sdkOptions()); const iam = new IAMClient(sdkOptions());
    try {
      const machine = await sfn.send(new CreateStateMachineCommand({ name: "browser-event-target", roleArn: fixture.workflowRoleArn, definition: JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Succeed" } } }) }));
      const targetRole = await iam.send(new CreateRoleCommand({ RoleName: "browser-events-start-sfn", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
      await iam.send(new PutRolePolicyCommand({ RoleName: "browser-events-start-sfn", PolicyName: "start-exact-workflow", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "states:StartExecution", Resource: machine.stateMachineArn }] }) }));
      await events.send(new PutRuleCommand({ Name: "browser-start-workflow", EventPattern: JSON.stringify({ source: ["browser.workflow"] }) }));
      await page.goto(`${consoleUrl}#/eventbridge/rules/default/browser-start-workflow/targets`); await page.getByRole("button", { name: "Add target" }).first().click(); const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Target type").selectOption("states"); await dialog.getByLabel("Target ID").fill("workflow-target"); await dialog.getByLabel("State machine ARN").fill(machine.stateMachineArn!); await dialog.getByLabel("Execution role ARN (optional)").fill(targetRole.Role!.Arn!);
      await expect(dialog.getByText("Execution role required")).toBeVisible(); await expect(dialog).toContainText("states:StartExecution"); await dialog.getByRole("button", { name: "Add target" }).click(); await expect(dialog).not.toBeVisible();
      await expect(page.getByRole("link", { name: "browser-event-target", exact: true })).toHaveAttribute("href", `#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}`);
      await events.send(new PutEventsCommand({ Entries: [{ Source: "browser.workflow", DetailType: "Start", Detail: "{}" }] })); await expect.poll(async () => (await sfn.send(new ListExecutionsCommand({ stateMachineArn: machine.stateMachineArn! }))).executions?.length ?? 0).toBe(1);
      expect(errors).toEqual([]);
    } finally { sfn.destroy(); events.destroy(); iam.destroy(); }
  });
});
