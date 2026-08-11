import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = resolve(projectRoot, process.env.SNS_ROUTING_DEPLOYMENT_FILE || ".runtime/deployment.json");
const seedIds = new Set([
  "seed-checkout-critical",
  "seed-payment-latency",
  "seed-search-index",
  "seed-identity-staging",
  "seed-storefront-dev",
  "seed-payments-dev",
]);

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
    throw new Error(`${options.method || "GET"} ${url} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} returned HTTP ${response.status}: ${body.error || raw}`);
  return body;
}

async function waitForDeliveries(apiBaseUrl) {
  const deadline = Date.now() + 45_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await jsonRequest(`${apiBaseUrl}/incidents`, { headers: { accept: "application/json" } });
    const seeded = latest.incidents.filter((incident) => seedIds.has(incident.id));
    const pending = seeded.flatMap((incident) => incident.routes).filter((route) => route.status === "pending");
    if (seeded.length === seedIds.size && pending.length === 0) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  const pending = latest?.incidents?.flatMap((incident) => incident.routes).filter((route) => route.status === "pending") ?? [];
  throw new Error(`Seeded SNS deliveries did not settle within 45 seconds (${pending.length} still pending)`);
}

function status(incident, routeId) {
  return incident.routes.find((route) => route.id === routeId)?.status;
}

async function main() {
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${deploymentPath}. Run npm run deploy first. ${error.message}`);
  }

  const website = await fetchWithTimeout(deployment.websiteUrl);
  assert(website.status === 200, `website returned HTTP ${website.status}`);
  const html = await website.text();
  assert(html.includes("Signal Relay"), "website HTML is missing the Signal Relay marker");
  assert(html.includes("./assets/app.js"), "website HTML is missing its relative JavaScript asset");
  const javascript = await fetchWithTimeout(new URL("assets/app.js", deployment.websiteUrl));
  assert(javascript.status === 200, `website JavaScript returned HTTP ${javascript.status}`);

  const system = await jsonRequest(`${deployment.apiBaseUrl}/system`, { headers: { accept: "application/json" } });
  assert(system.topic?.type === "Standard", "system endpoint did not report a Standard SNS topic");
  assert(system.topic?.arn === deployment.topicArn, "system topic ARN does not match the CDK output");
  assert(Array.isArray(system.routes) && system.routes.length === 4, "system endpoint did not report four subscriptions");
  assert(system.routes.some((route) => route.filterScope === "MessageBody"), "message-body filter route is missing");
  assert(system.routes.some((route) => route.protocol === "sqs"), "raw SQS audit subscription is missing");

  const result = await waitForDeliveries(deployment.apiBaseUrl);
  const seeded = new Map(result.incidents.filter((incident) => seedIds.has(incident.id)).map((incident) => [incident.id, incident]));
  assert(seeded.size === seedIds.size, `expected ${seedIds.size} seeded incidents but found ${seeded.size}`);

  const checkout = seeded.get("seed-checkout-critical");
  assert(checkout.routes.every((route) => route.status === "delivered"), "critical production payments incident should match all four routes");
  const storefront = seeded.get("seed-storefront-dev");
  assert(status(storefront, "critical-response") === "filtered", "low development incident should be filtered by critical response");
  assert(status(storefront, "payments-triage") === "filtered", "storefront incident should be filtered by payments triage");
  assert(status(storefront, "production-watch") === "filtered", "development incident should be filtered by production watch");
  assert(status(storefront, "audit-archive") === "delivered", "audit subscription should receive every message");
  const identity = seeded.get("seed-identity-staging");
  assert(status(identity, "critical-response") === "delivered", "critical staging incident should reach critical response");
  assert(status(identity, "payments-triage") === "filtered", "identity incident should not reach payments triage");

  const preflight = await fetchWithTimeout(`${deployment.apiBaseUrl}/incidents`, {
    method: "OPTIONS",
    headers: {
      origin: new URL(deployment.websiteUrl).origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert(preflight.ok, `CORS preflight returned HTTP ${preflight.status}`);
  assert(preflight.headers.get("access-control-allow-origin") === "*", "CORS preflight did not allow the tutorial website");

  console.log("[signal-relay] deployed smoke test passed");
  console.log(`  website       ${deployment.websiteUrl}`);
  console.log(`  SNS topic     ${deployment.topicArn}`);
  console.log(`  incidents     ${result.meta.count} (${seedIds.size} deterministic seed incidents present)`);
  console.log(`  delivered     ${result.meta.delivered}`);
  console.log(`  filtered      ${result.meta.filtered}`);
  console.log(`  pending       ${result.meta.pending}`);
  console.log("  routing       attribute filters + nested body filter + raw SQS delivery verified");
}

main().catch((error) => {
  console.error(`[signal-relay] smoke test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
