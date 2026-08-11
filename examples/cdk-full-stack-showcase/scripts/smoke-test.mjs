import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const deploymentPath = resolve(projectRoot, process.env.AURORA_DEPLOYMENT_FILE || ".runtime/deployment.json");
const DEMO_API_KEY = "AuroraAtlasLocalKey2026";
const DEMO_TOKEN = "aurora-demo";
const JOURNEY_POLL_TIMEOUT_MS = 45_000;
const JOURNEY_POLL_INTERVAL_MS = 300;
const demoSignalIds = new Set([
  "aurora-reef",
  "lunar-glass",
  "quiet-grid",
  "moss-memory",
  "soft-robot",
  "civic-tide",
  "forest-whisper",
  "micro-factory",
  "sun-thread",
  "open-orbit",
  "queue-lantern",
  "event-horizon-garden",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRequest(url, options = {}, timeoutMs = 30_000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${options.method || "GET"} ${url} returned non-JSON HTTP ${response.status}: ${raw.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} returned HTTP ${response.status}: ${body.error || body.message || raw}`);
  }
  return { response, body };
}

function protectedHeaders() {
  return {
    accept: "application/json",
    authorization: `Bearer ${DEMO_TOKEN}`,
    "x-api-key": DEMO_API_KEY,
  };
}

function headerValues(value) {
  return String(value || "").toLowerCase().split(",").map(item => item.trim()).filter(Boolean);
}

function assertCount(value, label) {
  assert(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`);
}

function journeySnapshot(body) {
  const journeys = body?.journeys;
  const meta = body?.meta;
  assert(Array.isArray(journeys), "GET /journeys did not return a journeys array");
  assert(meta && typeof meta === "object" && !Array.isArray(meta), "GET /journeys did not return meta");
  assert(meta.queue && typeof meta.queue === "object" && !Array.isArray(meta.queue), "GET /journeys did not return meta.queue");

  for (const [key, value] of Object.entries({
    "GET /journeys meta.count": meta.count,
    "GET /journeys meta.processed": meta.processed,
    "GET /journeys meta.retrying": meta.retrying,
    "GET /journeys meta.quarantined": meta.quarantined,
    "GET /journeys meta.queue.visible": meta.queue.visible,
    "GET /journeys meta.queue.inFlight": meta.queue.inFlight,
    "GET /journeys meta.queue.delayed": meta.queue.delayed,
    "GET /journeys meta.queue.deadLetters": meta.queue.deadLetters,
  })) {
    assertCount(value, key);
  }

  assert(meta.count === journeys.length, "GET /journeys meta.count does not match the payload");
  const statusCounts = journeys.reduce((counts, journey) => {
    const status = String(journey?.status || "");
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  assert(meta.processed === (statusCounts.processed || 0), "GET /journeys meta.processed does not match the payload");
  assert(meta.retrying === (statusCounts.retrying || 0), "GET /journeys meta.retrying does not match the payload");
  assert(meta.quarantined === (statusCounts.quarantined || 0), "GET /journeys meta.quarantined does not match the payload");

  const processedJourneys = journeys.filter(journey => journey?.status === "processed");
  const processedSignalIds = new Set(processedJourneys.map(journey => journey?.signalId).filter(Boolean));
  const missingSignalIds = [...demoSignalIds].filter(id => !processedSignalIds.has(id));
  const queueDrained = meta.queue.visible === 0 && meta.queue.inFlight === 0 && meta.queue.delayed === 0;
  return { journeys, meta, processedJourneys, missingSignalIds, queueDrained };
}

async function waitForSeedJourneys(apiBaseUrl) {
  const deadline = Date.now() + JOURNEY_POLL_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const result = await jsonRequest(`${apiBaseUrl}/journeys`, {
      headers: { accept: "application/json" },
    }, Math.min(5_000, remainingMs));
    latest = journeySnapshot(result.body);
    if (latest.missingSignalIds.length === 0 && latest.queueDrained) return latest;
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(JOURNEY_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
  }

  const queue = latest?.meta?.queue;
  const queueState = queue
    ? `visible=${queue.visible}, inFlight=${queue.inFlight}, delayed=${queue.delayed}, deadLetters=${queue.deadLetters}`
    : "no queue metadata";
  throw new Error(
    `GET /journeys did not process all deterministic seed activity within ${JOURNEY_POLL_TIMEOUT_MS} ms`
    + `; missing=${latest?.missingSignalIds?.join(", ") || "unknown"}; ${queueState}`,
  );
}

async function main() {
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${deploymentPath}. Run npm run deploy first. ${error.message}`);
  }
  assert(typeof deployment.websiteUrl === "string", "deployment manifest has no websiteUrl");
  assert(typeof deployment.apiBaseUrl === "string", "deployment manifest has no apiBaseUrl");
  for (const field of ["journeyTableName", "journeyBusName", "journeyQueueUrl", "journeyDeadLetterQueueUrl"]) {
    assert(typeof deployment[field] === "string" && deployment[field].trim(), `deployment manifest has no ${field}`);
  }

  const website = await fetchWithTimeout(deployment.websiteUrl);
  assert(website.status === 200, `website returned HTTP ${website.status}`);
  assert((website.headers.get("content-type") || "").startsWith("text/html"), "website did not return HTML");
  const html = await website.text();
  assert(html.includes("Aurora Atlas"), "website HTML is missing the Aurora Atlas marker");
  assert(html.includes("./assets/app.js"), "website HTML is missing the relative JavaScript asset");
  const javascript = await fetchWithTimeout(new URL("assets/app.js", deployment.websiteUrl));
  assert(javascript.status === 200, `website JavaScript returned HTTP ${javascript.status}`);
  assert((javascript.headers.get("content-type") || "").includes("javascript"), "website JavaScript has the wrong content type");

  const signalsResult = await jsonRequest(`${deployment.apiBaseUrl}/signals`, {
    headers: { accept: "application/json" },
  });
  const signals = signalsResult.body.signals;
  assert(Array.isArray(signals), "GET /signals did not return a signals array");
  const expectedSeedCount = Number(deployment.expectedSeedCount || demoSignalIds.size);
  assert(signals.length >= expectedSeedCount, `GET /signals returned ${signals.length}; expected at least ${expectedSeedCount}`);
  assert(signalsResult.body.meta?.count === signals.length, "GET /signals meta.count does not match the payload");
  const actualIds = new Set(signals.map(signal => signal.id));
  const missingDemoSignals = [...demoSignalIds].filter(id => !actualIds.has(id));
  assert(missingDemoSignals.length === 0, `seeded signals are missing: ${missingDemoSignals.join(", ")}`);

  const journey = await waitForSeedJourneys(deployment.apiBaseUrl);
  for (const item of journey.processedJourneys.filter(candidate => demoSignalIds.has(candidate.signalId))) {
    assert(typeof item.eventId === "string" && item.eventId, `processed journey for ${item.signalId} has no eventId`);
    assert(typeof item.correlationId === "string" && item.correlationId, `processed journey for ${item.signalId} has no correlationId`);
    assert(typeof item.processedAt === "string" && item.processedAt, `processed journey for ${item.signalId} has no processedAt`);
  }

  const proofResult = await jsonRequest(`${deployment.apiBaseUrl}/system/proof`, {
    headers: protectedHeaders(),
  });
  assert(proofResult.body.ok === true, "GET /system/proof did not report ok=true");
  assert(proofResult.body.data?.signalCount === signals.length, "protected proof signal count does not match GET /signals");
  assert(proofResult.body.cloudFormation?.providerTypes === 72, "protected proof did not report all 72 exact provider types");
  assert(proofResult.body.cloudFormation?.showcasedTypes === 31, "protected proof did not report the 31-type Atlas assembly");
  assert(Array.isArray(proofResult.body.fabric) && proofResult.body.fabric.length === 8, "protected proof did not report the eight-service fabric");

  const origin = new URL(deployment.websiteUrl).origin;
  const preflight = await fetchWithTimeout(`${deployment.apiBaseUrl}/system/proof`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,x-api-key",
    },
  });
  assert(preflight.ok, `CORS preflight returned HTTP ${preflight.status}`);
  assert(preflight.headers.get("access-control-allow-origin") === "*", "CORS preflight did not allow the public website origin");
  assert(headerValues(preflight.headers.get("access-control-allow-methods")).includes("get"), "CORS preflight did not allow GET");
  const allowedHeaders = headerValues(preflight.headers.get("access-control-allow-headers"));
  assert(allowedHeaders.includes("authorization") && allowedHeaders.includes("x-api-key"), "CORS preflight did not allow protected demo headers");

  console.log("[aurora-atlas] deployed smoke test passed");
  console.log(`  website     ${deployment.websiteUrl}`);
  console.log(`  API         ${deployment.apiBaseUrl}`);
  console.log(`  signals     ${signals.length} (${demoSignalIds.size} deterministic demo records present)`);
  console.log(`  journeys    ${journey.meta.processed} processed (${demoSignalIds.size} deterministic signals observed)`);
  console.log(`  queue       visible=${journey.meta.queue.visible}, inFlight=${journey.meta.queue.inFlight}, delayed=${journey.meta.queue.delayed}, deadLetters=${journey.meta.queue.deadLetters}`);
  console.log("  protected   token authorizer + API key accepted");
  console.log("  CORS        browser preflight accepted");
}

main().catch(error => {
  console.error(`[aurora-atlas] smoke test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
