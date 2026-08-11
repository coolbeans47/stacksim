import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

export const APPLICATION_TABLE = process.env.APPLICATION_TABLE!;
export const CONNECTION_TABLE = process.env.CONNECTION_TABLE!;
export const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "northstar-product";
export const WS_PK = `WS#${WORKSPACE_ID}`;
export const APP_CLIENT_ID = process.env.APP_CLIENT_ID!;
export const nowIso = () => new Date().toISOString();
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeEmail = (value: string) => value.normalize("NFC").trim().toLowerCase();
export const randomToken = () => randomBytes(32).toString("base64url");
export { randomUUID };

const raw = new DynamoDBClient({});
export const db = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});
export { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, DeleteCommand };
export type { TransactWriteCommandInput };

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function log(level: "info" | "warn" | "error", event: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, at: nowIso(), ...event }));
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function assert(
  condition: unknown,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new AppError(status, code, message, details);
}

export function response(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function text(value: unknown, name: string, min: number, max: number): string {
  assert(typeof value === "string", 400, "INVALID_INPUT", `${name} must be text.`);
  const normalized = value.normalize("NFC").trim();
  assert(normalized.length >= min && normalized.length <= max, 400, "INVALID_INPUT", `${name} must be ${min}–${max} characters.`);
  return normalized;
}

export function integer(value: unknown, name: string): number {
  assert(Number.isSafeInteger(value), 400, "INVALID_INPUT", `${name} must be an integer.`);
  return value as number;
}

export function objectBody(event: any, allowed: string[]): Record<string, any> {
  let body: unknown;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch { throw new AppError(400, "INVALID_JSON", "The request body is not valid JSON."); }
  assert(body && typeof body === "object" && !Array.isArray(body), 400, "INVALID_INPUT", "The request body must be an object.");
  const unknown = Object.keys(body as object).find(key => !allowed.includes(key));
  assert(!unknown, 400, "UNKNOWN_FIELD", `Unknown field: ${unknown}.`);
  return body as Record<string, any>;
}

export function tokenClaims(event: any, expected: "access" | "id"): Record<string, string> {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  assert(claims && typeof claims === "object", 401, "UNAUTHENTICATED", "Authentication is required.");
  assert(claims.token_use === expected, 401, "WRONG_TOKEN_USE", `A Cognito ${expected} token is required.`);
  assert(typeof claims.sub === "string" && claims.sub.length > 0, 401, "UNAUTHENTICATED", "The token subject is missing.");
  if (expected === "access") assert(claims.client_id === APP_CLIENT_ID, 401, "WRONG_CLIENT", "The token client does not match.");
  else assert(claims.aud === APP_CLIENT_ID, 401, "WRONG_CLIENT", "The token audience does not match.");
  return claims;
}

export async function getItem(PK: string, SK: string, consistent = true) {
  return (await db.send(new GetCommand({
    TableName: APPLICATION_TABLE,
    Key: { PK, SK },
    ConsistentRead: consistent,
  }))).Item as Record<string, any> | undefined;
}

export async function activeMembership(sub: string) {
  const binding = await getItem(WS_PK, `IDENTITY#SUB#${sub}`);
  assert(binding?.status === "ACTIVE", 403, "NO_ACTIVE_MEMBERSHIP", "You do not have an active workspace membership.");
  const member = await getItem(WS_PK, `MEMBER#${binding.memberId}`);
  assert(member?.status === "ACTIVE" && member.cognitoSub === sub, 403, "NO_ACTIVE_MEMBERSHIP", "You do not have an active workspace membership.");
  return member;
}

export function requireAdmin(member: Record<string, any>) {
  assert(member.role === "ADMIN", 403, "ADMIN_REQUIRED", "Administrator permission is required.");
}

export function rankKey(rank: number): string {
  assert(Number.isSafeInteger(rank) && rank > 0 && rank <= 999_999_999_999, 422, "RANK_EXHAUSTED", "This lane needs to be rebalanced.");
  return String(rank).padStart(12, "0");
}

export function ticketProjection(ticket: Record<string, any>) {
  if (ticket.archived) {
    const copy = { ...ticket };
    delete copy.GSI1PK; delete copy.GSI1SK; delete copy.GSI2PK; delete copy.GSI2SK;
    return copy;
  }
  const scope = ticket.sprintId ? `SPRINT#${ticket.sprintId}` : "BACKLOG";
  return {
    ...ticket,
    GSI1PK: `BOARD#${WORKSPACE_ID}#${scope}`,
    GSI1SK: `${ticket.status}#${rankKey(ticket.rank)}#${ticket.ticketKey}`,
    ...(ticket.assigneeMemberId ? {
      GSI2PK: `ASSIGNEE#${ticket.assigneeMemberId}`,
      GSI2SK: `WS#${WORKSPACE_ID}#${scope}#${ticket.status}#${rankKey(ticket.rank)}#${ticket.ticketKey}`,
    } : {
      GSI2PK: undefined,
      GSI2SK: undefined,
    }),
  };
}

export function publicTicket(ticket: Record<string, any>) {
  const {
    PK: _pk, SK: _sk, GSI1PK: _g1pk, GSI1SK: _g1sk, GSI2PK: _g2pk, GSI2SK: _g2sk,
    seedOwner: _seedOwner, seedVersion: _seedVersion, schemaVersion: _schemaVersion,
    ...value
  } = ticket;
  return value;
}

export function eventRecords(
  eventType: string,
  entityId: string,
  entityVersion: number,
  actor: Record<string, any>,
  clientMutationId: string,
  detail: Record<string, unknown>,
) {
  const eventId = randomUUID();
  const occurredAt = nowIso();
  const envelope = {
    schemaVersion: 1,
    eventId,
    eventType,
    workspaceId: WORKSPACE_ID,
    entityId,
    entityVersion,
    actorMemberId: actor.memberId,
    clientMutationId,
    occurredAt,
    detail,
  };
  return {
    envelope,
    outbox: {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: {
          PK: WS_PK,
          SK: `OUTBOX#${eventId}`,
          entityType: "OUTBOX",
          schemaVersion: 1,
          eventId,
          envelope,
          deliveryState: "PENDING",
          attemptCount: 0,
          occurredAt,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    activity: {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: {
          PK: WS_PK,
          SK: `ACTIVITY#${occurredAt}#${eventId}`,
          entityType: "ACTIVITY",
          schemaVersion: 1,
          eventId,
          action: eventType,
          ticketKey: entityId.startsWith("SP-") ? entityId : undefined,
          actorMemberId: actor.memberId,
          actorDisplayName: actor.displayName,
          summary: `${eventType.replace(/([A-Z])/g, " $1").trim()} ${entityId}`,
          createdAt: occurredAt,
          ...(entityId.startsWith("SP-") ? {
            GSI2PK: `ACTIVITY#WS#${WORKSPACE_ID}#TICKET#${entityId}`,
            GSI2SK: `${occurredAt}#${eventId}`,
          } : {}),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
  };
}

export async function idempotentReplay(sub: string, clientMutationId: string, request: unknown) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMutationId), 400, "INVALID_MUTATION_ID", "clientMutationId must be a UUID.");
  const digest = sha256(JSON.stringify(request));
  const existing = await getItem(`MUTATION#${sub}`, clientMutationId);
  if (existing) {
    assert(existing.requestDigest === digest, 409, "IDEMPOTENCY_CONFLICT", "This mutation ID was already used for a different request.");
    return { digest, result: existing.result, status: existing.status as number };
  }
  return { digest };
}

export function idempotencyWrite(
  sub: string,
  clientMutationId: string,
  digest: string,
  status: number,
  result: unknown,
) {
  return {
    Put: {
      TableName: APPLICATION_TABLE,
      Item: {
        PK: `MUTATION#${sub}`,
        SK: clientMutationId,
        entityType: "IDEMPOTENCY",
        schemaVersion: 1,
        requestDigest: digest,
        status,
        result,
        createdAt: nowIso(),
        expiresAt: nowSeconds() + 86_400,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

export const memberCondition = (sub: string, member: Record<string, any>) => ({
  ConditionCheck: {
    TableName: APPLICATION_TABLE,
    Key: { PK: WS_PK, SK: `MEMBER#${member.memberId}` },
    ConditionExpression: "#status = :active AND cognitoSub = :sub",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":active": "ACTIVE", ":sub": sub },
  },
});

export async function transact(items: NonNullable<TransactWriteCommandInput["TransactItems"]>) {
  try {
    await db.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error: any) {
    if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") {
      throw new AppError(409, "BOARD_CONFLICT", "The board changed while this request was being saved.");
    }
    throw error;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
