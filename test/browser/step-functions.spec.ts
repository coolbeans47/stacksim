import { expect, test, type Page } from "@playwright/test";
import { EventBridgeClient, PutEventsCommand, PutRuleCommand } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateActivityCommand, CreateStateMachineCommand, DescribeExecutionCommand, DescribeStateMachineCommand, DescribeStateMachineForExecutionCommand, GetExecutionHistoryCommand, ListExecutionsCommand, ListTagsForResourceCommand, SFNClient } from "@aws-sdk/client-sfn";
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
  await page.getByRole("tab", { name: "JSON" }).click();
  await expect(page.getByLabel("Definition (States Language JSON)")).toBeVisible();
}

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

test.describe("Step Functions SFN-01 through SFN-03 console", () => {
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
      const catalogTooltip = await expectPanelHelp(page, "State machine catalog", "durable workflow definition");
      await expect(catalogTooltip).toContainText("Express workflows");
      const bounds = await catalogTooltip.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);

      await page.goto(`${consoleUrl}#/step-functions/state-machines/create`);
      await expectPanelHelp(page, "Workflow configuration", "execution role");
      await page.goto(`${consoleUrl}${machineRoute}/edit`);
      await expectPanelHelp(page, "Definition and role", "affects only executions started afterward");
      await page.goto(`${consoleUrl}${machineRoute}/definition`);
      await expectPanelHelp(page, "Definition", "read-only view");
      await page.goto(`${consoleUrl}${machineRoute}/tags`);
      await expectPanelHelp(page, "Tags", "key-value labels");
      await page.goto(`${consoleUrl}${machineRoute}`);
      await expectPanelHelp(page, "Executions", "one run of a state machine");

      await page.getByRole("button", { name: "Start execution" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name (optional)").fill("tooltip-run");
      await dialog.getByLabel("Input JSON").fill('{"source":"tooltip-test"}');
      await dialog.getByRole("button", { name: "Start execution" }).click();
      await expect(page).toHaveURL(/#\/step-functions\/executions\//);
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
      await page.getByLabel("Name", { exact: true }).fill("browser-workflow");
      await page.getByLabel("Execution role ARN").fill(fixture.workflowRoleArn);
      await openDefinitionJson(page);
      await page.getByLabel("Definition (States Language JSON)").fill('{"StartAt":"Missing","States":{}}');
      await page.getByRole("button", { name: "Validate" }).click();
      await expect(page.getByRole("alert")).toContainText("diagnostic");
      const waitingDefinition = JSON.stringify({ StartAt: "Hold", States: { Hold: { Type: "Wait", Seconds: 60, End: true } } }, null, 2);
      await page.getByLabel("Definition (States Language JSON)").fill(waitingDefinition);
      await page.getByLabel("Tags (JSON object)").fill('{"team":"console"}');
      await page.getByRole("button", { name: "Create state machine" }).click();
      await expect(page.getByRole("heading", { name: "browser-workflow" })).toBeVisible();
      const machineArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);

      await page.getByRole("tab", { name: "Tags" }).click();
      await page.getByRole("button", { name: "Edit tags" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Tags (JSON object)").fill('{"owner":"browser","stage":"test"}');
      await dialog.getByRole("button", { name: "Save tags" }).click();
      await expect(page.getByRole("cell", { name: "owner" })).toBeVisible();
      expect((await sfn.send(new ListTagsForResourceCommand({ resourceArn: machineArn }))).tags).toEqual([{ key: "owner", value: "browser" }, { key: "stage", value: "test" }]);

      await page.getByRole("button", { name: "Start execution" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name (optional)").fill("running-inspection");
      await dialog.getByLabel("Input JSON").fill('{"request":"running"}');
      await dialog.getByRole("button", { name: "Start execution" }).click();
      await expect(page).toHaveURL(/#\/step-functions\/executions\//);
      await expect(page.getByRole("heading", { name: "running-inspection" })).toBeVisible();
      const runningArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await expect(page.getByText("RUNNING", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Inspect Hold state" })).toHaveClass(/active/);
      const beforePoll = describeRequests;
      await expect.poll(() => describeRequests, { timeout: 5000 }).toBeGreaterThan(beforePoll);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await page.getByRole("tab", { name: "Event history" }).click();
      await expect(page.locator("[data-event-table]").getByRole("button", { name: "WaitStateEntered", exact: true })).toBeVisible();
      await page.locator("[data-event-table]").getByRole("button", { name: "WaitStateEntered", exact: true }).click();
      await expect(page.getByRole("heading", { name: /^Event \d+$/ })).toBeVisible();
      await expect(page.getByText("Previous event", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stop execution" }).click();
      await expect(page.getByText("ABORTED", { exact: true }).first()).toBeVisible();
      await page.getByRole("tab", { name: "Graph" }).click();
      await expect(page.getByRole("button", { name: "Inspect Hold state" })).not.toHaveClass(/active/);

      await page.goto(`${consoleUrl}${new URL(page.url()).hash.replace(/executions\/.+$/, `state-machines/${encodeURIComponent(machineArn)}/edit`)}`);
      await page.getByLabel("Execution role ARN").fill(`${fixture.workflowRoleArn}-dirty`);
      await page.getByRole("link", { name: "Cancel" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByLabel("Execution role ARN").fill(fixture.workflowRoleArn);
      await openDefinitionJson(page);
      await page.getByLabel("Definition (States Language JSON)").fill('{"StartAt":"Nope","States":{}}');
      await page.getByRole("button", { name: "Validate without saving" }).click();
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
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/existing execution snapshots are unchanged/i)).toBeVisible();
      await expect(page.getByText("Latest update", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Definition" }).click();
      await expect(page.getByRole("link", { name: /browser-sfn-worker/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Branches · branch 1" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Items · item processor" })).toBeVisible();

      await page.getByRole("button", { name: "Start execution" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name (optional)").fill("nested-success");
      await dialog.getByLabel("Input JSON").fill('{"items":["x","y"]}');
      await dialog.getByRole("button", { name: "Start execution" }).click();
      await expect(page).toHaveURL(/#\/step-functions\/executions\//);
      const successArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await waitTerminal(sfn, successArn);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Retry-attempt timeline (1)" })).toBeVisible();
      await expect(page.getByText("Iteration 0", { exact: true })).toBeVisible();
      await expect(page.getByText("Iteration 1", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Event history" }).click();
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
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByRole("button", { name: "Start execution" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name (optional)").fill("expected-failure");
      await dialog.getByLabel("Input JSON").fill('{"safe":"visible"}');
      await dialog.getByRole("button", { name: "Start execution" }).click();
      await expect(page).toHaveURL(/#\/step-functions\/executions\//);
      const failedArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await waitTerminal(sfn, failedArn);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await expect(page.getByText("FAILED", { exact: true }).first()).toBeVisible();
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
        await expect(page.getByRole("heading", { name: hash.endsWith("/edit") ? "Edit mobile-workflow" : hash.endsWith("state-machines") ? "State machines" : "mobile-workflow" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      }
      await page.goto(`${consoleUrl}#/step-functions/state-machines/${encodeURIComponent(machine.stateMachineArn!)}`);
      await page.getByRole("button", { name: "Start execution" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name (optional)").fill("mobile-run");
      await dialog.getByRole("button", { name: "Start execution" }).click();
      await expect(page).toHaveURL(/#\/step-functions\/executions\//);
      const executionArn = decodeURIComponent(new URL(page.url()).hash.split("/").at(-1)!);
      await waitTerminal(sfn, executionArn);
      await page.getByRole("button", { name: "Refresh execution" }).click();
      await page.getByRole("tab", { name: "Event history" }).click();
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
      await expect(page.getByRole("tab", { name: "Visual" })).toHaveAttribute("aria-selected", "true");
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
      await page.getByRole("tab", { name: "Visual" }).click();
      await expect(page.getByRole("button", { name: "Edit InvokeWorker state" })).toBeVisible();
      await page.getByLabel("Name", { exact: true }).fill("visual-workflow");
      await page.getByLabel("Execution role ARN").fill(fixture.workflowRoleArn);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Create state machine" }).click();
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
