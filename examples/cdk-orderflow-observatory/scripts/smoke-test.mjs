import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = resolve(projectRoot, process.env.ORDERFLOW_DEPLOYMENT_FILE || ".runtime/deployment.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRequest(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${options.method || "GET"} ${url} returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} returned HTTP ${response.status}: ${body.message || body.error || raw}`);
  return body;
}

async function start(apiBaseUrl, input) {
  return jsonRequest(`${apiBaseUrl}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function waitForTerminal(apiBaseUrl, executionArn) {
  const deadline = Date.now() + 45_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await jsonRequest(`${apiBaseUrl}/executions/${encodeURIComponent(executionArn)}`);
    if (["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"].includes(latest.status)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Execution ${executionArn} did not finish within 45 seconds (last status ${latest?.status || "unknown"}).`);
}

function order(overrides = {}) {
  return {
    orderId: "SMOKE-ORDER",
    customer: "Smoke Test",
    processingDelaySeconds: 0,
    fraudScore: 10,
    transientFailures: 0,
    failInventory: false,
    failItem: "",
    items: [
      { sku: "SKU-ONE", quantity: 1 },
      { sku: "SKU-TWO", quantity: 2 },
    ],
    ...overrides,
  };
}

async function main() {
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${deploymentPath}. Run npm run deploy first. ${error.message}`);
  }

  const website = await fetchWithTimeout(deployment.websiteUrl);
  assert(website.status === 200, `Website returned HTTP ${website.status}.`);
  const html = await website.text();
  assert(html.includes("OrderFlow Observatory"), "Website HTML is missing the OrderFlow Observatory marker.");
  assert(html.includes("./assets/app.js"), "Website HTML is missing its relative JavaScript asset.");
  const javascript = await fetchWithTimeout(new URL("assets/app.js", deployment.websiteUrl));
  assert(javascript.status === 200, `Website JavaScript returned HTTP ${javascript.status}.`);

  const system = await jsonRequest(`${deployment.apiBaseUrl}/system`);
  assert(system.mode === "STANDARD", "System endpoint did not report a Standard Workflow.");
  assert(system.stateMachine?.arn === deployment.stateMachineArn, "System state-machine ARN does not match the CDK output.");
  const definition = system.stateMachine?.definition;
  assert(definition?.States?.["Run checks in parallel"]?.Type === "Parallel", "Parallel state is missing.");
  assert(definition?.States?.["Package items"]?.Type === "Map", "Inline Map state is missing.");
  assert(definition?.States?.["Processing window"]?.Type === "Wait", "Wait state is missing.");

  const retryStart = await start(deployment.apiBaseUrl, order({
    orderId: `SMOKE-RETRY-${Date.now()}`,
    transientFailures: 1,
  }));
  const retryExecution = await waitForTerminal(deployment.apiBaseUrl, retryStart.executionArn);
  assert(retryExecution.status === "SUCCEEDED", `Retry execution finished as ${retryExecution.status}: ${retryExecution.cause || ""}`);
  assert(retryExecution.output?.dispatch?.packageCount === 2, "Successful execution did not dispatch two packages.");
  assert(retryExecution.output?.checks?.[0]?.attempt === 2, "Inventory retry count was not visible in the workflow output.");
  const retryHistory = await jsonRequest(`${deployment.apiBaseUrl}/executions/${encodeURIComponent(retryStart.executionArn)}/history`);
  const inventoryAttempts = retryHistory.events.filter((event) => {
    if (event.type !== "LambdaFunctionScheduled") return false;
    try {
      return JSON.parse(event.lambdaFunctionScheduledEventDetails?.input || "{}").operation === "inventory";
    } catch {
      return false;
    }
  });
  assert(inventoryAttempts.length === 2, `Retry history scheduled ${inventoryAttempts.length} inventory attempts instead of two.`);
  assert(retryHistory.events.some((event) => event.type === "ExecutionSucceeded"), "Retry history did not include ExecutionSucceeded.");

  const rejectedStart = await start(deployment.apiBaseUrl, order({
    orderId: `SMOKE-RISK-${Date.now()}`,
    fraudScore: 91,
  }));
  const rejectedExecution = await waitForTerminal(deployment.apiBaseUrl, rejectedStart.executionArn);
  assert(rejectedExecution.status === "FAILED", `Risk execution finished as ${rejectedExecution.status}.`);
  assert(rejectedExecution.error === "OrderRejected", `Risk execution failed with ${rejectedExecution.error || "no error"} instead of OrderRejected.`);

  const listed = await jsonRequest(`${deployment.apiBaseUrl}/executions`);
  assert(listed.executions.some((execution) => execution.executionArn === retryStart.executionArn), "ListExecutions did not return the retry execution.");
  assert(listed.executions.some((execution) => execution.executionArn === rejectedStart.executionArn), "ListExecutions did not return the rejected execution.");

  const preflight = await fetchWithTimeout(`${deployment.apiBaseUrl}/executions`, {
    method: "OPTIONS",
    headers: {
      origin: new URL(deployment.websiteUrl).origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert(preflight.ok, `CORS preflight returned HTTP ${preflight.status}.`);
  assert(preflight.headers.get("access-control-allow-origin") === "*", "CORS preflight did not allow the observatory website.");

  console.log("[orderflow] deployed smoke test passed");
  console.log(`  website       ${deployment.websiteUrl}`);
  console.log(`  state machine ${deployment.stateMachineArn}`);
  console.log(`  retry run     ${retryExecution.status}, ${inventoryAttempts.length} inventory schedules, attempt ${retryExecution.output.checks[0].attempt}`);
  console.log(`  risk run      ${rejectedExecution.status}, ${rejectedExecution.error}`);
  console.log("  history       typed execution events returned through the observation API");
}

main().catch((error) => {
  console.error(`[orderflow] smoke test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
