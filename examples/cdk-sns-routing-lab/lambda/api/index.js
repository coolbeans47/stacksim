const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} = require("@aws-sdk/client-dynamodb");
const { PublishCommand, SNSClient } = require("@aws-sdk/client-sns");
const { GetQueueAttributesCommand, SQSClient } = require("@aws-sdk/client-sqs");

const dynamodb = new DynamoDBClient({});
const sns = new SNSClient({});
const sqs = new SQSClient({});
const incidentsTable = process.env.INCIDENTS_TABLE;
const deliveriesTable = process.env.DELIVERIES_TABLE;
const topicArn = process.env.TOPIC_ARN;
const topicName = process.env.TOPIC_NAME;
const subscriptionDlqUrl = process.env.SUBSCRIPTION_DLQ_URL;

const routes = Object.freeze([
  {
    id: "critical-response",
    name: "Critical response",
    protocol: "lambda",
    filterScope: "MessageAttributes",
    filter: "severity = critical",
    description: "Pages the response function only for the highest-severity incidents.",
  },
  {
    id: "payments-triage",
    name: "Payments triage",
    protocol: "lambda",
    filterScope: "MessageBody",
    filter: "detail.service = payments",
    description: "Demonstrates nested JSON body filtering independently of message attributes.",
  },
  {
    id: "production-watch",
    name: "Production watch",
    protocol: "lambda",
    filterScope: "MessageAttributes",
    filter: "environment = production",
    description: "Observes every production incident regardless of team or severity.",
  },
  {
    id: "audit-archive",
    name: "Audit archive",
    protocol: "sqs",
    filterScope: "None",
    filter: "all messages",
    description: "Receives raw message bodies through SQS for durable asynchronous processing.",
  },
]);

const seedIncidents = Object.freeze([
  {
    id: "seed-checkout-critical",
    title: "Checkout authorization failures",
    summary: "Card authorization errors crossed the critical threshold during the morning traffic peak.",
    severity: "critical",
    service: "payments",
    environment: "production",
    occurredAt: "2026-07-28T08:12:00.000Z",
  },
  {
    id: "seed-payment-latency",
    title: "Payment latency elevated",
    summary: "The payment gateway remains healthy but its p95 response time is above the service objective.",
    severity: "high",
    service: "payments",
    environment: "production",
    occurredAt: "2026-07-28T07:44:00.000Z",
  },
  {
    id: "seed-search-index",
    title: "Search index lag",
    summary: "New catalogue entries are taking several minutes to appear in production search results.",
    severity: "medium",
    service: "search",
    environment: "production",
    occurredAt: "2026-07-28T07:05:00.000Z",
  },
  {
    id: "seed-identity-staging",
    title: "Staging token validation errors",
    summary: "The identity canary detected invalid token signatures after a staging key rotation.",
    severity: "critical",
    service: "identity",
    environment: "staging",
    occurredAt: "2026-07-28T06:26:00.000Z",
  },
  {
    id: "seed-storefront-dev",
    title: "Development preview unavailable",
    summary: "The storefront preview environment is rebuilding after an expected dependency update.",
    severity: "low",
    service: "storefront",
    environment: "development",
    occurredAt: "2026-07-28T05:58:00.000Z",
  },
  {
    id: "seed-payments-dev",
    title: "Payment sandbox regression",
    summary: "A development sandbox scenario reproduced the decline-handling regression under investigation.",
    severity: "critical",
    service: "payments",
    environment: "development",
    occurredAt: "2026-07-28T05:19:00.000Z",
  },
]);

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "content-type": "application/json; charset=utf-8",
};

function response(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

function text(value) {
  return { S: String(value) };
}

function number(value) {
  return { N: String(value) };
}

function decode(value) {
  if (!value) return undefined;
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  return undefined;
}

function decodeItem(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, decode(value)]));
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw Object.assign(new Error("The request body must be valid JSON."), { statusCode: 400 });
  }
}

function expectedRouteIds(incident) {
  return routes
    .filter((route) => (
      route.id === "audit-archive"
      || (route.id === "critical-response" && incident.severity === "critical")
      || (route.id === "payments-triage" && incident.service === "payments")
      || (route.id === "production-watch" && incident.environment === "production")
    ))
    .map((route) => route.id);
}

function validateIncident(input) {
  const allowed = {
    severity: ["critical", "high", "medium", "low"],
    service: ["payments", "identity", "search", "storefront"],
    environment: ["production", "staging", "development"],
  };
  const title = String(input.title ?? "").trim();
  const summary = String(input.summary ?? "").trim();
  if (title.length < 3 || title.length > 80) throw Object.assign(new Error("Title must contain 3–80 characters."), { statusCode: 400 });
  if (summary.length < 8 || summary.length > 280) throw Object.assign(new Error("Summary must contain 8–280 characters."), { statusCode: 400 });
  for (const [field, values] of Object.entries(allowed)) {
    if (!values.includes(input[field])) throw Object.assign(new Error(`${field} must be one of: ${values.join(", ")}.`), { statusCode: 400 });
  }
  return { title, summary, severity: input.severity, service: input.service, environment: input.environment };
}

async function getIncident(id) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: incidentsTable,
    Key: { id: text(id) },
    ConsistentRead: true,
  }));
  return result.Item ? decodeItem(result.Item) : undefined;
}

async function publishIncident(input, options = {}) {
  const checked = validateIncident(input);
  const id = options.id ?? `incident-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  if (options.id) {
    const existing = await getIncident(id);
    if (existing) return { incident: existing, written: false };
  }
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const message = {
    schemaVersion: 1,
    incidentId: id,
    title: checked.title,
    summary: checked.summary,
    detail: {
      severity: checked.severity,
      service: checked.service,
      environment: checked.environment,
      occurredAt,
    },
  };
  const published = await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: `[${checked.severity.toUpperCase()}] ${checked.title}`.slice(0, 99),
    Message: JSON.stringify(message),
    MessageAttributes: {
      severity: { DataType: "String", StringValue: checked.severity },
      service: { DataType: "String", StringValue: checked.service },
      environment: { DataType: "String", StringValue: checked.environment },
      tutorial: { DataType: "String", StringValue: "sns-routing-lab" },
    },
  }));
  const expected = expectedRouteIds(checked);
  const incident = {
    id,
    ...checked,
    occurredAt,
    publishedAt: new Date().toISOString(),
    snsMessageId: published.MessageId,
    expectedRoutes: JSON.stringify(expected),
    source: options.source ?? "interactive",
  };
  await dynamodb.send(new PutItemCommand({
    TableName: incidentsTable,
    Item: {
      id: text(incident.id),
      title: text(incident.title),
      summary: text(incident.summary),
      severity: text(incident.severity),
      service: text(incident.service),
      environment: text(incident.environment),
      occurredAt: text(incident.occurredAt),
      publishedAt: text(incident.publishedAt),
      snsMessageId: text(incident.snsMessageId),
      expectedRoutes: text(incident.expectedRoutes),
      source: text(incident.source),
    },
  }));
  return { incident, written: true };
}

async function listIncidents() {
  const [incidentResult, deliveryResult] = await Promise.all([
    dynamodb.send(new ScanCommand({ TableName: incidentsTable })),
    dynamodb.send(new ScanCommand({ TableName: deliveriesTable })),
  ]);
  const deliveries = (deliveryResult.Items ?? []).map(decodeItem);
  const byIncident = new Map();
  for (const delivery of deliveries) {
    if (!byIncident.has(delivery.incidentId)) byIncident.set(delivery.incidentId, new Map());
    byIncident.get(delivery.incidentId).set(delivery.routeId, delivery);
  }
  const incidents = (incidentResult.Items ?? []).map(decodeItem).map((incident) => {
    const expected = new Set(JSON.parse(incident.expectedRoutes || "[]"));
    const observed = byIncident.get(incident.id) ?? new Map();
    return {
      ...incident,
      expectedRoutes: [...expected],
      routes: routes.map((route) => ({
        ...route,
        matched: expected.has(route.id),
        status: !expected.has(route.id) ? "filtered" : observed.has(route.id) ? "delivered" : "pending",
        delivery: observed.get(route.id) ?? null,
      })),
    };
  }).sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)));
  return incidents;
}

async function seedDemo() {
  let written = 0;
  for (const incident of seedIncidents) {
    const result = await publishIncident(incident, {
      id: incident.id,
      occurredAt: incident.occurredAt,
      source: "seed",
    });
    if (result.written) written += 1;
  }
  return { written, total: (await listIncidents()).length, expected: seedIncidents.length };
}

async function deadLetterDepth() {
  const result = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: subscriptionDlqUrl,
    AttributeNames: [
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesNotVisible",
      "ApproximateNumberOfMessagesDelayed",
    ],
  }));
  return ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]
    .reduce((total, key) => total + Number(result.Attributes?.[key] ?? 0), 0);
}

exports.handler = async function handler(event) {
  const method = String(event.httpMethod ?? "GET").toUpperCase();
  const path = String(event.path ?? "/").replace(/\/$/, "") || "/";
  const requestId = event.requestContext?.requestId ?? `local-${Date.now().toString(36)}`;
  try {
    if (method === "GET" && path === "/incidents") {
      const incidents = await listIncidents();
      const delivered = incidents.flatMap((incident) => incident.routes).filter((route) => route.status === "delivered").length;
      const filtered = incidents.flatMap((incident) => incident.routes).filter((route) => route.status === "filtered").length;
      const pending = incidents.flatMap((incident) => incident.routes).filter((route) => route.status === "pending").length;
      return response(200, { incidents, meta: { count: incidents.length, delivered, filtered, pending, requestId } });
    }
    if (method === "POST" && path === "/incidents") {
      const result = await publishIncident(parseBody(event));
      return response(202, {
        accepted: true,
        incident: { ...result.incident, expectedRoutes: JSON.parse(result.incident.expectedRoutes) },
        requestId,
        lesson: "The API published once. SNS now evaluates every subscription independently.",
      });
    }
    if (method === "POST" && path === "/demo/seed") {
      return response(200, { ...(await seedDemo()), requestId });
    }
    if (method === "GET" && path === "/system") {
      return response(200, {
        release: process.env.RELEASE,
        topic: { arn: topicArn, name: topicName, type: "Standard" },
        routes,
        deadLetterDepth: await deadLetterDepth(),
        concepts: [
          "Publish once",
          "Evaluate each subscription filter",
          "Fan out independent deliveries",
          "Retry and redrive per subscription",
        ],
        requestId,
      });
    }
    return response(404, { error: "No SNS Routing Lab route matched this request.", requestId });
  } catch (error) {
    const statusCode = Number(error.statusCode ?? 500);
    console.error(JSON.stringify({ level: "error", event: "request_failed", method, path, requestId, message: error.message }));
    return response(statusCode, { error: statusCode >= 500 ? "The routing lab could not complete this request." : error.message, requestId });
  }
};
