const {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} = require("@aws-sdk/client-dynamodb");
const { GetQueueAttributesCommand, SQSClient } = require("@aws-sdk/client-sqs");

const dynamodb = new DynamoDBClient({});
const sqs = new SQSClient({});
const tableName = process.env.TABLE_NAME;
const activityTableName = process.env.ACTIVITY_TABLE;
const journeyQueueUrl = process.env.JOURNEY_QUEUE_URL;
const journeyDeadLetterQueueUrl = process.env.JOURNEY_DLQ_URL;
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type,Authorization,X-Api-Key",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "content-type": "application/json; charset=utf-8",
};

const demoSignals = [
  { id: "aurora-reef", title: "Reef light recovery", summary: "A shallow-water nursery is showing a steady return of bioluminescent coral after six quiet weeks.", category: "Oceans", intensity: 88, status: "rising", x: 18, y: 34, contributors: 24, observedAt: "2026-07-22T04:45:00.000Z", accent: "cyan" },
  { id: "lunar-glass", title: "Lunar glass harvest", summary: "A materials collective mapped a low-energy path for turning simulated regolith into translucent habitat panels.", category: "Space", intensity: 76, status: "stable", x: 70, y: 20, contributors: 17, observedAt: "2026-07-22T03:32:00.000Z", accent: "violet" },
  { id: "quiet-grid", title: "The quiet grid", summary: "Neighbourhood batteries coordinated a dusk demand spike without waking the backup turbine.", category: "Energy", intensity: 93, status: "rising", x: 52, y: 54, contributors: 39, observedAt: "2026-07-22T02:18:00.000Z", accent: "lime" },
  { id: "moss-memory", title: "Moss remembers rain", summary: "A low-cost sensor mesh found that roof moss predicts local flash runoff nearly twenty minutes early.", category: "Climate", intensity: 69, status: "watching", x: 32, y: 72, contributors: 12, observedAt: "2026-07-21T23:55:00.000Z", accent: "emerald" },
  { id: "soft-robot", title: "Soft robot pollinators", summary: "Palm-sized fabric robots completed their first gentle night pollination pass in a closed orchard.", category: "Robotics", intensity: 81, status: "rising", x: 82, y: 67, contributors: 28, observedAt: "2026-07-21T21:14:00.000Z", accent: "coral" },
  { id: "civic-tide", title: "Civic tide tables", summary: "Residents are translating street-level flood reports into an open, block-by-block preparedness map.", category: "Civic", intensity: 61, status: "stable", x: 43, y: 28, contributors: 46, observedAt: "2026-07-21T19:42:00.000Z", accent: "amber" },
  { id: "forest-whisper", title: "Forest whisper network", summary: "Acoustic relays detected an invasive beetle signature before visible canopy stress appeared.", category: "Climate", intensity: 73, status: "watching", x: 24, y: 52, contributors: 19, observedAt: "2026-07-21T16:08:00.000Z", accent: "emerald" },
  { id: "micro-factory", title: "One-room micro-factory", summary: "A repair studio produced its hundredth open-source appliance part from recycled neighbourhood plastic.", category: "Robotics", intensity: 57, status: "stable", x: 66, y: 78, contributors: 31, observedAt: "2026-07-21T12:25:00.000Z", accent: "coral" },
  { id: "sun-thread", title: "Solar thread", summary: "Woven photovoltaic shade cloth powered a full community market through the afternoon heat.", category: "Energy", intensity: 84, status: "rising", x: 58, y: 35, contributors: 22, observedAt: "2026-07-21T09:12:00.000Z", accent: "lime" },
  { id: "open-orbit", title: "Open orbit classroom", summary: "Students used shared telescope time to independently recover the path of a near-earth object.", category: "Space", intensity: 64, status: "watching", x: 76, y: 43, contributors: 54, observedAt: "2026-07-21T06:40:00.000Z", accent: "violet" },
  { id: "queue-lantern", title: "Queue lantern relay", summary: "A chain of low-power civic beacons is buffering neighbourhood observations until the night relay is ready.", category: "Civic", intensity: 72, status: "stable", x: 37, y: 43, contributors: 18, observedAt: "2026-07-23T05:20:00.000Z", accent: "amber" },
  { id: "event-horizon-garden", title: "Event horizon garden", summary: "Autonomous orbital planters are routing high-intensity growth signals through a shared research channel.", category: "Space", intensity: 91, status: "rising", x: 87, y: 29, contributors: 33, observedAt: "2026-07-23T04:05:00.000Z", accent: "violet" },
].map((signal) => ({
  ...signal,
  journeyCorrelationId: `seed-${signal.id}`,
  journeyState: "stored",
  journeyVersion: 1,
}));

function attribute(value) {
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  return { S: String(value) };
}

function encodeSignal(signal) {
  return Object.fromEntries(Object.entries({ ...signal, expiresAt: 1893456000 }).map(([key, value]) => [key, attribute(value)]));
}

function decodeAttribute(value) {
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.S !== undefined) return value.S;
  if (value.NULL) return null;
  if (value.M) return decodeSignal(value.M);
  if (value.L) return value.L.map(decodeAttribute);
  return null;
}

function decodeSignal(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, decodeAttribute(value)]));
}

function response(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); }
  catch { throw Object.assign(new Error("The request body must be valid JSON."), { statusCode: 400 }); }
}

function positionFor(text, salt) {
  let hash = salt;
  for (const character of text) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return 14 + (hash % 72);
}

async function listSignals() {
  const result = await dynamodb.send(new ScanCommand({ TableName: tableName }));
  return (result.Items ?? []).map(decodeSignal).sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)));
}

async function seed(reset) {
  const current = await listSignals();
  if (reset) {
    for (const signal of current) {
      await dynamodb.send(new DeleteItemCommand({ TableName: tableName, Key: { id: { S: signal.id } } }));
    }
  }
  const existing = new Map(reset ? [] : current.map(signal => [signal.id, signal]));
  let written = 0;
  for (const signal of demoSignals) {
    const present = existing.get(signal.id);
    if (present?.journeyVersion === 1) continue;
    const migrated = {
      ...signal,
      ...present,
      journeyCorrelationId: signal.journeyCorrelationId,
      journeyState: "stored",
      journeyVersion: 1,
    };
    delete migrated.simulateJourneyFailure;
    await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: encodeSignal(migrated) }));
    written += 1;
  }
  return { written, total: (await listSignals()).length, reset };
}

async function createSignal(input, correlationId) {
  const now = new Date().toISOString();
  const id = `signal-${Date.now().toString(36)}-${positionFor(input.title, 7).toString(36)}`;
  const accents = { Oceans: "cyan", Space: "violet", Energy: "lime", Climate: "emerald", Robotics: "coral", Civic: "amber" };
  const signal = {
    id,
    title: String(input.title).trim(),
    summary: String(input.summary).trim(),
    category: String(input.category),
    intensity: Math.max(1, Math.min(100, Number(input.intensity))),
    status: "new",
    x: positionFor(input.title, 11),
    y: positionFor(input.summary, 23),
    contributors: 1,
    observedAt: now,
    accent: accents[input.category] ?? "cyan",
    journeyCorrelationId: correlationId,
    journeyState: "stored",
    journeyVersion: 1,
  };
  await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: encodeSignal(signal) }));
  return signal;
}

async function getSignal(id) {
  const result = await dynamodb.send(new GetItemCommand({ TableName: tableName, Key: { id: { S: id } } }));
  return result.Item ? decodeSignal(result.Item) : undefined;
}

async function queueAttributes(queueUrl) {
  if (!queueUrl) return { visible: 0, inFlight: 0, delayed: 0 };
  const result = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: [
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesNotVisible",
      "ApproximateNumberOfMessagesDelayed",
    ],
  }));
  return {
    visible: Number(result.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(result.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

function normaliseJourney(item) {
  let payload = {};
  try {
    payload = typeof item.payload === "string" ? JSON.parse(item.payload) : {};
  } catch {
    payload = {};
  }
  const signal = item.signal && typeof item.signal === "object"
    ? item.signal
    : payload.signal && typeof payload.signal === "object" ? payload.signal : {};
  return {
    eventId: item.eventId ?? payload.eventId ?? item.journeyId,
    journeyId: item.journeyId ?? payload.journeyId ?? item.eventId,
    activityId: item.activityId,
    signalId: item.signalId ?? payload.signalId ?? signal.id,
    correlationId: item.correlationId ?? payload.correlationId ?? signal.journeyCorrelationId,
    action: item.action ?? payload.action ?? "updated",
    stage: item.stage ?? "worker",
    title: item.title ?? signal.title ?? item.signalId ?? "Untitled signal",
    category: item.category ?? signal.category ?? "Unknown",
    intensity: Number(item.intensity ?? signal.intensity ?? 0),
    status: item.status ?? "processed",
    attempt: Number(item.attempt ?? item.receiveCount ?? 1),
    occurredAt: item.occurredAt ?? signal.observedAt ?? item.processedAt,
    processedAt: item.processedAt,
    error: item.error,
  };
}

async function listJourneys() {
  const [activityResult, queue, deadLetters] = await Promise.all([
    dynamodb.send(new ScanCommand({ TableName: activityTableName })),
    queueAttributes(journeyQueueUrl),
    queueAttributes(journeyDeadLetterQueueUrl),
  ]);
  const activities = (activityResult.Items ?? [])
    .map(decodeSignal)
    .map(normaliseJourney)
    .sort((left, right) => String(right.processedAt ?? right.occurredAt).localeCompare(String(left.processedAt ?? left.occurredAt)));
  const seenJourneys = new Set();
  const journeys = activities.filter((journey) => {
    const identity = journey.journeyId ?? journey.eventId;
    if (seenJourneys.has(identity)) return false;
    seenJourneys.add(identity);
    return true;
  });
  return {
    journeys,
    meta: {
      count: journeys.length,
      processed: journeys.filter((journey) => journey.status === "processed").length,
      retrying: journeys.filter((journey) => journey.status === "retrying").length,
      quarantined: journeys.filter((journey) => journey.status === "quarantined").length,
      queue: { ...queue, deadLetters: deadLetters.visible + deadLetters.inFlight + deadLetters.delayed },
    },
  };
}

async function injectJourneyFault(requestId) {
  const now = new Date().toISOString();
  const signal = {
    id: `relay-fault-${Date.now().toString(36)}`,
    title: "Controlled relay fault",
    summary: "A deliberate processing fault demonstrates retries and redrive into the journey dead-letter queue.",
    category: "Civic",
    intensity: 42,
    status: "watching",
    x: 46,
    y: 61,
    contributors: 1,
    observedAt: now,
    accent: "amber",
    journeyCorrelationId: `fault-${requestId}`,
    journeyState: "stored",
    journeyVersion: 1,
    simulateJourneyFailure: true,
  };
  await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: encodeSignal(signal) }));
  return signal;
}

exports.handler = async function handler(event) {
  const method = String(event.httpMethod ?? "GET").toUpperCase();
  const path = String(event.path ?? "/").replace(/\/$/, "") || "/";
  const requestId = event.requestContext?.requestId ?? `local-${Date.now().toString(36)}`;
  console.log(JSON.stringify({ level: "info", event: "request", method, path, requestId, release: process.env.RELEASE }));

  try {
    if (method === "GET" && path === "/signals") {
      const signals = await listSignals();
      const averageIntensity = signals.length ? Math.round(signals.reduce((sum, signal) => sum + signal.intensity, 0) / signals.length) : 0;
      return response(200, { signals, meta: { count: signals.length, averageIntensity, requestId, release: process.env.RELEASE } });
    }

    if (method === "POST" && path === "/signals") {
      const signal = await createSignal(parseBody(event), requestId);
      return response(201, { signal, requestId });
    }

    if (method === "GET" && path === "/journeys") {
      return response(200, { ...(await listJourneys()), requestId, release: process.env.RELEASE });
    }

    if (method === "POST" && path === "/journeys/fault") {
      const signal = await injectJourneyFault(requestId);
      return response(202, {
        accepted: true,
        signal,
        requestId,
        message: "The controlled fault is travelling through EventBridge and SQS. Watch it retry, then enter quarantine.",
      });
    }

    const signalMatch = path.match(/^\/signals\/([^/]+)$/);
    if (signalMatch) {
      const id = decodeURIComponent(signalMatch[1]);
      if (method === "GET") {
        const signal = await getSignal(id);
        return signal ? response(200, { signal, requestId }) : response(404, { error: "Signal not found", requestId });
      }
      if (method === "PUT") {
        const current = await getSignal(id);
        if (!current) return response(404, { error: "Signal not found", requestId });
        const input = parseBody(event);
        const updated = input.action === "boost"
          ? {
              ...current,
              intensity: Math.min(100, current.intensity + 4),
              contributors: current.contributors + 1,
              status: "rising",
              journeyCorrelationId: requestId,
              journeyState: "stored",
              journeyVersion: 1,
            }
          : {
              ...current,
              ...input,
              id: current.id,
              journeyCorrelationId: requestId,
              journeyState: "stored",
              journeyVersion: 1,
            };
        await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: encodeSignal(updated) }));
        return response(200, { signal: updated, requestId });
      }
      if (method === "DELETE") {
        const deleted = await dynamodb.send(new DeleteItemCommand({
          TableName: tableName,
          Key: { id: { S: id } },
          ReturnValues: "ALL_OLD",
        }));
        return deleted.Attributes
          ? response(200, { archived: decodeSignal(deleted.Attributes), requestId })
          : response(404, { error: "Signal not found", requestId });
      }
    }

    if (method === "POST" && path === "/demo/seed") {
      const result = await seed(Boolean(parseBody(event).reset));
      return response(200, { ...result, requestId });
    }

    if (method === "GET" && path === "/system/proof") {
      const [signals, journeyResult] = await Promise.all([listSignals(), listJourneys()]);
      return response(200, {
        ok: true,
        requestId,
        authenticatedPrincipal: event.requestContext?.authorizer?.principalId ?? "local-observer",
        release: process.env.RELEASE,
        data: {
          tableName,
          activityTableName,
          signalCount: signals.length,
          journeyCount: journeyResult.meta.count,
          queueDepth: journeyResult.meta.queue.visible + journeyResult.meta.queue.inFlight + journeyResult.meta.queue.delayed,
          deadLetterCount: journeyResult.meta.queue.deadLetters,
          streamMode: "NEW_AND_OLD_IMAGES",
          index: "byCategory",
        },
        fabric: [
          { service: "S3", role: "React website", state: "online" },
          { service: "API Gateway", role: "REST, validation, keys & authorizer", state: "online" },
          { service: "Lambda", role: "Versioned application alias", state: "online" },
          { service: "DynamoDB", role: "Signals, GSI, TTL & stream", state: "online" },
          { service: "EventBridge", role: "Signal event routing", state: "online" },
          { service: "SQS", role: "Buffered delivery, retry & redrive", state: "online" },
          { service: "IAM", role: "Least-privilege execution", state: "online" },
          { service: "CloudWatch Logs", role: "Structured request trail", state: "online" },
        ],
        cloudFormation: { providerTypes: 72, showcasedTypes: 31, stacks: 3, mode: "bounded-local" },
      });
    }

    return response(404, { error: "No observatory route matched this request.", requestId });
  } catch (error) {
    const statusCode = Number(error.statusCode ?? 500);
    console.error(JSON.stringify({ level: "error", event: "request_failed", method, path, requestId, message: error.message }));
    return response(statusCode, { error: statusCode === 500 ? "The observatory lost this signal." : error.message, requestId });
  }
};
