import { DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import mysql, { type Connection } from "mysql2/promise";

const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "eu-west-1",
  endpoint: process.env.STACKSIM_ENDPOINT ?? "http://127.0.0.1:4566",
});
const tableName = process.env.TABLE_NAME ?? "LearningNotes";

export async function handler(event: any) {
  const id = event.pathParameters?.id;
  if (event.httpMethod === "GET" && id) {
    const result = await dynamodb.send(new GetItemCommand({ TableName: tableName, Key: { id: { S: id } } }));
    return response(result.Item ? 200 : 404, result.Item ?? { message: "Not found" });
  }
  if (event.httpMethod === "GET") {
    const result = await dynamodb.send(new ScanCommand({ TableName: tableName }));
    return response(200, result.Items ?? []);
  }
  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body ?? "{}");
    const noteId = body.id ?? crypto.randomUUID();
    const item = { id: { S: noteId }, title: { S: String(body.title ?? "Untitled") }, body: { S: String(body.body ?? "") } };
    await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: item }));
    return response(201, item);
  }
  if (event.httpMethod === "PUT" && id) {
    const body = JSON.parse(event.body ?? "{}");
    const supported = ["title", "body", "category", "completed", "priority"] as const;
    const fields = supported.filter(field => body[field] !== undefined);
    if (!fields.length) return response(400, { message: "Provide at least one field to update", supportedFields: supported });
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};
    const assignments = fields.map((field, index) => {
      names[`#f${index}`] = field;
      values[`:v${index}`] = field === "completed" ? { BOOL: Boolean(body[field]) }
        : field === "priority" ? { N: String(body[field]) }
        : { S: String(body[field]) };
      return `#f${index} = :v${index}`;
    });
    const result = await dynamodb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { id: { S: id } },
      UpdateExpression: `SET ${assignments.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    return response(200, result.Attributes);
  }
  return response(405, { message: "Method not allowed" });
}

export async function loggingHandler(event: any, context: any) {
  console.log(`stdout:${event.message ?? "hello"}`);
  console.error(`stderr:${event.message ?? "hello"}`);
  if (event.logBytes) console.log(`large:${"x".repeat(Number(event.logBytes))}`);
  const result = { requestId: context.awsRequestId, remaining: context.getRemainingTimeInMillis(), clientContext: context.clientContext, logGroup: context.logGroupName, logStream: context.logStreamName };
  return event.requestContext?.apiId ? response(200, result) : result;
}

export async function throwingHandler() { throw new TypeError("intentional failure"); }

export function callbackErrorHandler(_event: any, _context: any, callback: (error: Error) => void) { callback(new Error("callback failure")); }

export async function timeoutHandler(event: any = {}) { if (event.releaseProbe) return { released: true }; await new Promise(() => undefined); }

export async function concurrencyHandler(event: any = {}, context: any = {}) {
  if (event.crash) process.exit(Number(event.exitCode ?? 17));
  const waitMs = Math.max(0, Number(event.waitMs ?? 0));
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  return { initializationType: process.env.AWS_LAMBDA_INITIALIZATION_TYPE, version: context.functionVersion, arn: context.invokedFunctionArn };
}

export async function versionHandler(_event: any, context: any) { return { marker: process.env.VERSION_MARKER, version: context.functionVersion, arn: context.invokedFunctionArn }; }
export async function echoHandler(event: any) { return event; }
export const durableStepHandler = withDurableExecution(async (event: any, context) => {
  const value = await context.step("double", async () => Number(event.value ?? 0) * 2);
  if (Number(event.waitSeconds ?? 0) > 0) await context.wait("requested-wait", { seconds: Number(event.waitSeconds) });
  return { value, executionArn: context.executionContext.durableExecutionArn };
});
export const durableRetryHandler = withDurableExecution(async (event: any, context) => {
  const counterId = String(event.counterId ?? "durable-retry");
  const attempt = await context.step("retryable-step", async () => {
    const result = await dynamodb.send(new UpdateItemCommand({ TableName: tableName, Key: { id: { S: `durable-attempt#${counterId}` } }, UpdateExpression: "ADD attempts :one", ExpressionAttributeValues: { ":one": { N: "1" } }, ReturnValues: "ALL_NEW" }));
    const current = Number(result.Attributes?.attempts?.N ?? "0");
    if (current <= Number(event.failAttempts ?? 0)) throw new Error(`intentional durable retry ${current}`);
    return current;
  }, { retryStrategy: (_error, attemptCount) => ({ shouldRetry: attemptCount <= Number(event.failAttempts ?? 0) + 1, delay: { seconds: 1 } }) });
  return { attempt };
});
export const durableCallbackHandler = withDurableExecution(async (event: any, context) => {
  const [callbackPromise, callbackId] = await context.createCallback<string>("external-result", { timeout: { seconds: Number(event.timeoutSeconds ?? 300) }, ...(event.heartbeatSeconds ? { heartbeatTimeout: { seconds: Number(event.heartbeatSeconds) } } : {}) });
  const result = await callbackPromise;
  return { callbackId, result };
});
export const durableChainedHandler = withDurableExecution(async (event: any, context) => {
  const result = await context.invoke<any, any>("child-invoke", String(event.functionName), event.payload ?? {});
  return { result };
});
export const durableFailureHandler = withDurableExecution(async (event: any) => { throw new Error(String(event.message ?? "intentional durable failure")); });
export async function alarmActionHandler(event: any) { console.log(`cloudwatch-alarm:${JSON.stringify(event)}`); return event; }
export async function proxyEchoHandler(event: any) { return response(200, { principalId: event.requestContext?.authorizer?.principalId, authorizer: event.requestContext?.authorizer, path: event.path }); }

export async function asyncRetryHandler(event: any) {
  const counterId = String(event.counterId ?? crypto.randomUUID());
  const result = await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { id: { S: `attempt#${counterId}` } },
    UpdateExpression: "ADD attempts :one",
    ExpressionAttributeValues: { ":one": { N: "1" } },
    ReturnValues: "ALL_NEW",
  }));
  const attempt = Number(result.Attributes?.attempts?.N ?? "0");
  if (attempt <= Number(event.failAttempts ?? 0)) throw new Error(`intentional async failure on attempt ${attempt}`);
  return { counterId, attempt };
}

export async function asyncDestinationHandler(event: any) {
  const requestId = String(event.requestContext?.requestId ?? crypto.randomUUID());
  await dynamodb.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      id: { S: `destination#${requestId}` },
      condition: { S: String(event.requestContext?.condition ?? "Unknown") },
      record: { S: JSON.stringify(event) },
    },
  }));
  return { delivered: true, requestId };
}

export async function dynamoStreamHandler(event: any) {
  const failures: Array<{ itemIdentifier: string }> = [];
  const batchId = crypto.randomUUID();
  const records = Array.isArray(event.Records) ? event.Records : [];
  await dynamodb.send(new PutItemCommand({
    TableName: tableName,
    Item: { id: { S: `batch#${batchId}` }, size: { N: String(records.length) }, sequences: { S: records.map((record: any) => record.dynamodb?.SequenceNumber).join(",") } },
  }));
  for (const record of records) {
    const sequence = String(record.dynamodb?.SequenceNumber ?? "missing");
    const attempt = await dynamodb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { id: { S: `stream-attempt#${sequence}` } },
      UpdateExpression: "ADD attempts :one",
      ExpressionAttributeValues: { ":one": { N: "1" } },
      ReturnValues: "ALL_NEW",
    }));
    const attemptNumber = Number(attempt.Attributes?.attempts?.N ?? "0");
    await dynamodb.send(new PutItemCommand({
      TableName: tableName,
      Item: { id: { S: `stream-record#${record.eventID}` }, sequence: { S: sequence }, eventName: { S: String(record.eventName) }, attempts: { N: String(attemptNumber) }, record: { S: JSON.stringify(record) } },
    }));
    const image = record.dynamodb?.NewImage ?? {};
    if (image.partialOnce?.BOOL === true && attemptNumber === 1) failures.push({ itemIdentifier: sequence });
    if (image.fail?.BOOL === true) throw new Error(`intentional stream failure for ${sequence}`);
  }
  const response: any = { batchItemFailures: failures };
  if (event.window) {
    const count = Number(event.state?.count ?? 0) + records.length; response.state = { ...(event.state ?? {}), count };
    if (event.isFinalInvokeForWindow) await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: { id: { S: `window#${event.window.start}` }, count: { N: String(count) }, final: { BOOL: true }, state: { S: JSON.stringify(response.state) } } }));
  }
  return response;
}

type DynamoString = { S?: unknown };
type DynamoNumber = { N?: unknown };

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be configured`);
  return value;
}

function streamTableName(): string {
  const tableName = process.env.RDS_TABLE ?? "stream_inventory";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tableName)) throw new Error("RDS_TABLE must be a valid unqualified SQL identifier");
  return tableName;
}

function streamString(image: Record<string, DynamoString> | undefined, field: string, maximumLength: number): string {
  const value = image?.[field]?.S;
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) throw new Error(`DynamoDB stream ${field} must be a non-empty string no longer than ${maximumLength} characters`);
  return value;
}

function streamQuantity(image: Record<string, DynamoNumber> | undefined): number {
  const raw = image?.quantity?.N;
  if (typeof raw !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error("DynamoDB stream quantity must be an integer number attribute");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) throw new Error("DynamoDB stream quantity must fit in a SQL INT");
  return value;
}

/** Mirrors DynamoDB inventory stream records into the local RDS table in one transaction per batch. */
export async function rdsStreamHandler(event: any) {
  const records = event?.Records;
  if (!Array.isArray(records)) throw new Error("DynamoDB stream event Records must be an array");
  const tableName = streamTableName();
  const port = Number(requiredEnvironment("RDS_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("RDS_PORT must be an integer between 1 and 65535");

  let connection: Connection | undefined;
  let transactionStarted = false;
  try {
    connection = await mysql.createConnection({
      host: requiredEnvironment("RDS_HOST"),
      port,
      user: requiredEnvironment("RDS_USER"),
      password: requiredEnvironment("RDS_PASSWORD"),
      database: requiredEnvironment("RDS_DATABASE"),
    });
    await connection.beginTransaction();
    transactionStarted = true;
    for (const record of records) {
      const eventName = record?.eventName;
      if (eventName === "REMOVE") {
        const itemId = streamString(record?.dynamodb?.Keys, "id", 128);
        await connection.execute(`DELETE FROM \`${tableName}\` WHERE item_id = ?`, [itemId]);
        continue;
      }
      if (eventName !== "INSERT" && eventName !== "MODIFY") throw new Error(`Unsupported DynamoDB stream event: ${String(eventName)}`);
      const image = record?.dynamodb?.NewImage;
      const itemId = streamString(image, "id", 128);
      const itemName = streamString(image, "name", 255);
      const quantity = streamQuantity(image);
      await connection.execute(
        `INSERT INTO \`${tableName}\` (item_id, item_name, quantity, source_event) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE item_name = VALUES(item_name), quantity = VALUES(quantity), source_event = VALUES(source_event)`,
        [itemId, itemName, quantity, eventName],
      );
    }
    await connection.commit();
    transactionStarted = false;
    return { batchItemFailures: [] };
  } catch (error) {
    if (connection && transactionStarted) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    if (connection) await connection.end().catch(() => undefined);
  }
}

export async function binaryProxyHandler(event: any) {
  const bytes = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : Buffer.from(event.body ?? "", "utf8");
  return { statusCode: 200, headers: { "content-type": "application/octet-stream", "x-request-was-base64": String(Boolean(event.isBase64Encoded)) }, body: bytes.toString("base64"), isBase64Encoded: true };
}

export async function invalidBinaryProxyHandler() {
  return { statusCode: 200, headers: { "content-type": "application/octet-stream" }, body: "not valid base64!", isBase64Encoded: true };
}

export async function authorizerHandler(event: any) {
  const token = event.authorizationToken ?? event.headers?.authorization ?? event.headers?.Authorization;
  if (token === "malformed") return { unexpected: true };
  return {
    principalId: token === "allow" ? "allowed-user" : "denied-user",
    policyDocument: { Version: "2012-10-17", Statement: [{ Effect: token === "allow" ? "Allow" : "Deny", Action: "execute-api:Invoke", Resource: event.methodArn }] },
    context: { token, cached: "value" },
    ...(process.env.USAGE_IDENTIFIER_KEY ? { usageIdentifierKey: process.env.USAGE_IDENTIFIER_KEY } : {}),
  };
}

function response(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
