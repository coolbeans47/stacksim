import { createHash } from "node:crypto";
import { ApiGatewayManagementApiClient, DeleteConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { SESClient, SendTemplatedEmailCommand } from "@aws-sdk/client-ses";
import {
  activeMembership,
  APPLICATION_TABLE,
  APP_CLIENT_ID,
  AppError,
  assert,
  db,
  DeleteCommand,
  escapeHtml,
  eventRecords,
  getItem,
  idempotencyWrite,
  idempotentReplay,
  integer,
  log,
  memberCondition,
  normalizeEmail,
  nowIso,
  nowSeconds,
  objectBody,
  publicTicket,
  QueryCommand,
  randomToken,
  randomUUID,
  rankKey,
  requireAdmin,
  response,
  safeEqualHex,
  sha256,
  text,
  ticketProjection,
  tokenClaims,
  transact,
  UpdateCommand,
  WORKSPACE_ID,
  WS_PK,
  CONNECTION_TABLE,
} from "../shared/runtime.js";

const ses = new SESClient({});
const management = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_MANAGEMENT_ENDPOINT });
const storyPoints = new Set([1, 2, 3, 5, 8, 13]);
const priorities = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const statuses = new Set(["TODO", "IN_PROGRESS", "REVIEW", "DONE"]);
const fromAddress = process.env.FROM_ADDRESS!;
const websiteUrl = process.env.WEBSITE_URL!;
const invitationTemplate = process.env.INVITATION_TEMPLATE!;

function pathValue(event: any, name: string) {
  const value = event.pathParameters?.[name];
  assert(typeof value === "string" && value.length > 0, 400, "INVALID_PATH", `${name} is required.`);
  return decodeURIComponent(value);
}

async function query(params: any) {
  return (await db.send(new QueryCommand({ TableName: APPLICATION_TABLE, ...params }))).Items ?? [];
}

async function context(event: any, expected: "access" | "id" = "access") {
  const claims = tokenClaims(event, expected);
  return {
    claims,
    member: expected === "access" ? await activeMembership(claims.sub) : undefined,
  };
}

async function mutation(event: any, allowed: string[], handler: (input: {
  body: Record<string, any>;
  claims: Record<string, string>;
  member: Record<string, any>;
  digest: string;
}) => Promise<{ status?: number; result: any }>) {
  const { claims, member } = await context(event);
  const body = objectBody(event, [...allowed, "clientMutationId"]);
  const replay = await idempotentReplay(claims.sub, body.clientMutationId, {
    method: event.requestContext.http.method,
    path: event.rawPath,
    body,
  });
  if (replay.result) return response(replay.status ?? 200, replay.result);
  const output = await handler({ body, claims, member: member!, digest: replay.digest });
  return response(output.status ?? 200, output.result);
}

async function board(scopeValue: string) {
  let scope = "BACKLOG";
  if (scopeValue === "active") {
    const active = await getItem(WS_PK, "SINGLETON#ACTIVE_SPRINT");
    assert(active, 404, "NO_ACTIVE_SPRINT", "There is no active sprint.");
    scope = `SPRINT#${active.sprintId}`;
  } else if (scopeValue.startsWith("sprint:")) {
    scope = `SPRINT#${scopeValue.slice(7)}`;
  } else assert(scopeValue === "backlog", 400, "INVALID_SCOPE", "Board scope is invalid.");
  const tickets = await query({
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": `BOARD#${WORKSPACE_ID}#${scope}` },
    ScanIndexForward: true,
  });
  const laneStatuses = scope === "BACKLOG" ? ["BACKLOG"] : ["TODO", "IN_PROGRESS", "REVIEW", "DONE"];
  const lanes = [];
  for (const status of laneStatuses) {
    const revision = await getItem(WS_PK, `LANE#${scope}#${status}`);
    lanes.push({
      status,
      version: revision?.version ?? 0,
      tickets: tickets.filter(ticket => ticket.status === status).map(publicTicket),
    });
  }
  return { workspaceId: WORKSPACE_ID, scope, lanes };
}

async function bootstrapClaim(event: any) {
  const claims = tokenClaims(event, "id");
  assert(claims.email_verified === "true" && typeof claims.email === "string", 403, "VERIFIED_EMAIL_REQUIRED", "A verified email is required.");
  const expected = normalizeEmail(process.env.BOOTSTRAP_EMAIL!);
  assert(normalizeEmail(claims.email) === expected, 403, "BOOTSTRAP_EMAIL_MISMATCH", "This account is not the configured bootstrap administrator.");
  const marker = await getItem(WS_PK, "BOOTSTRAP#ADMIN");
  const member = marker ? await getItem(WS_PK, `MEMBER#${marker.memberId}`) : undefined;
  if (member?.status === "ACTIVE" && member.cognitoSub === claims.sub) return response(200, { membership: member, claimed: false });
  assert(marker?.state === "PENDING" && member?.status === "PENDING", 409, "BOOTSTRAP_UNAVAILABLE", "The bootstrap administrator has already been claimed.");
  const bindingKey = `IDENTITY#SUB#${claims.sub}`;
  const at = nowIso();
  await transact([
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `IDENTITY#EMAIL#${sha256(expected)}` },
        UpdateExpression: "SET #status = :active",
        ConditionExpression: "memberId = :memberId AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":memberId": member.memberId, ":pending": "PENDING", ":active": "ACTIVE" },
      },
    },
    {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: { PK: WS_PK, SK: bindingKey, entityType: "SUBJECT_BINDING", memberId: member.memberId, status: "ACTIVE", createdAt: at },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `MEMBER#${member.memberId}` },
        UpdateExpression: "SET #status = :active, cognitoSub = :sub, updatedAt = :at",
        ConditionExpression: "#status = :pending AND attribute_not_exists(cognitoSub)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "ACTIVE", ":pending": "PENDING", ":sub": claims.sub, ":at": at },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "BOOTSTRAP#ADMIN" },
        UpdateExpression: "SET #state = :consumed, consumedSubject = :sub, consumedAt = :at",
        ConditionExpression: "#state = :pending",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":consumed": "CONSUMED", ":pending": "PENDING", ":sub": claims.sub, ":at": at },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "META" },
        UpdateExpression: "SET activeMemberCount = activeMemberCount + :one, updatedAt = :at",
        ConditionExpression: "activeMemberCount < :limit",
        ExpressionAttributeValues: { ":one": 1, ":limit": 25, ":at": at },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_MEMBERS" },
        UpdateExpression: "SET memberIds = list_append(memberIds, :member), #count = #count + :one, version = version + :one, updatedAt = :at",
        ConditionExpression: "#count < :limit",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":member": [member.memberId], ":one": 1, ":limit": 25, ":at": at },
      },
    },
  ]);
  return response(200, { membership: { ...member, status: "ACTIVE", cognitoSub: claims.sub }, claimed: true });
}

async function inspectInvitation(event: any) {
  const body = objectBody(event, ["invitationId", "token"]);
  assert(typeof body.invitationId === "string" && typeof body.token === "string", 400, "INVALID_INVITATION", "This invitation is unavailable.");
  const invite = await getItem(WS_PK, `INVITE#${body.invitationId}`);
  const digest = sha256(body.token);
  assert(
    invite?.state === "PENDING_ACCEPTANCE"
      && invite.tokenExpiresAt > nowSeconds()
      && safeEqualHex(invite.tokenDigest, digest),
    404,
    "INVALID_INVITATION",
    "This invitation is unavailable.",
  );
  return response(200, {
    workspaceName: "Northstar Product",
    invitationId: invite.invitationId,
    email: invite.email,
    displayName: invite.displayName,
    state: invite.state,
    tokenExpiresAt: invite.tokenExpiresAt,
  });
}

async function acceptInvitation(event: any) {
  const claims = tokenClaims(event, "id");
  assert(claims.email_verified === "true" && typeof claims.email === "string", 403, "VERIFIED_EMAIL_REQUIRED", "A verified email is required.");
  const body = objectBody(event, ["invitationId", "token", "clientMutationId"]);
  const replay = await idempotentReplay(claims.sub, body.clientMutationId, { path: event.rawPath, body });
  if (replay.result) return response(replay.status ?? 200, replay.result);
  const invite = await getItem(WS_PK, `INVITE#${body.invitationId}`);
  const member = invite ? await getItem(WS_PK, `MEMBER#${invite.memberId}`) : undefined;
  if (invite?.state === "ACCEPTED" && invite.acceptedSubject === claims.sub && member?.status === "ACTIVE") {
    return response(200, { membership: member, accepted: false });
  }
  assert(invite?.state === "PENDING_ACCEPTANCE" && invite.tokenExpiresAt > nowSeconds(), 404, "INVALID_INVITATION", "This invitation is unavailable.");
  assert(typeof body.token === "string" && safeEqualHex(invite.tokenDigest, sha256(body.token)), 404, "INVALID_INVITATION", "This invitation is unavailable.");
  assert(normalizeEmail(claims.email) === invite.email, 403, "INVITATION_EMAIL_MISMATCH", "Sign in with the email address that received this invitation.");
  assert(member?.status === "PENDING", 409, "INVITATION_STATE_CHANGED", "This invitation can no longer be accepted.");
  const at = nowIso();
  const result = { membership: { ...member, status: "ACTIVE", cognitoSub: claims.sub }, accepted: true };
  await transact([
    {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: { PK: WS_PK, SK: `IDENTITY#SUB#${claims.sub}`, entityType: "SUBJECT_BINDING", memberId: member.memberId, status: "ACTIVE", createdAt: at },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `IDENTITY#EMAIL#${sha256(invite.email)}` },
        UpdateExpression: "SET #status = :active",
        ConditionExpression: "memberId = :memberId AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "ACTIVE", ":pending": "PENDING", ":memberId": member.memberId },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `MEMBER#${member.memberId}` },
        UpdateExpression: "SET #status = :active, cognitoSub = :sub, updatedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "ACTIVE", ":pending": "PENDING", ":sub": claims.sub, ":at": at },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `INVITE#${invite.invitationId}` },
        UpdateExpression: "SET #state = :accepted, acceptedSubject = :sub, acceptedAt = :at, expiresAt = :expires REMOVE tokenDigest",
        ConditionExpression: "#state = :pending AND tokenDigest = :digest",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":pending": "PENDING_ACCEPTANCE", ":sub": claims.sub, ":at": at, ":expires": nowSeconds() + 604_800, ":digest": invite.tokenDigest },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "META" },
        UpdateExpression: "SET activeMemberCount = activeMemberCount + :one, pendingInvitationCount = pendingInvitationCount - :one, updatedAt = :at",
        ConditionExpression: "activeMemberCount < :limit AND pendingInvitationCount > :zero",
        ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":limit": 25, ":at": at },
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_MEMBERS" },
        UpdateExpression: "SET memberIds = list_append(memberIds, :member), #count = #count + :one, version = version + :one, updatedAt = :at",
        ConditionExpression: "#count < :limit",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":member": [member.memberId], ":one": 1, ":limit": 25, ":at": at },
      },
    },
    idempotencyWrite(claims.sub, body.clientMutationId, replay.digest, 200, result),
  ]);
  return response(200, result);
}

async function createInvitation(input: { body: Record<string, any>; claims: Record<string, string>; member: Record<string, any>; digest: string }) {
  requireAdmin(input.member);
  const email = normalizeEmail(text(input.body.email, "email", 3, 254));
  const displayName = input.body.displayName ? text(input.body.displayName, "displayName", 1, 80) : email.split("@")[0];
  const emailHash = sha256(email);
  const existingBinding = await getItem(WS_PK, `IDENTITY#EMAIL#${emailHash}`);
  assert(!existingBinding, 409, "ALREADY_MEMBER", "This email already belongs to a member or pending invitation.");
  const invitationId = randomUUID();
  const memberId = `member-${randomUUID()}`;
  const token = randomToken();
  const tokenDigest = sha256(token);
  const at = nowIso();
  const tokenExpiresAt = nowSeconds() + 172_800;
  const parameters = new URLSearchParams({ id: invitationId, token });
  const href = `${websiteUrl.replace(/\/?$/, "/")}#/accept-invite?${parameters.toString()}`;
  const result = { invitationId, email, displayName, state: "PENDING_ACCEPTANCE", tokenExpiresAt };
  await transact([
    memberCondition(input.claims.sub, input.member),
    {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: { PK: WS_PK, SK: `IDENTITY#EMAIL#${emailHash}`, entityType: "EMAIL_BINDING", emailHash, memberId, status: "PENDING", createdAt: at },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: { PK: WS_PK, SK: `MEMBER#${memberId}`, entityType: "MEMBER", memberId, email, displayName, role: "MEMBER", status: "PENDING", provenance: "INVITATION", createdAt: at, updatedAt: at },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Put: {
        TableName: APPLICATION_TABLE,
        Item: {
          PK: WS_PK, SK: `INVITE#${invitationId}`, entityType: "INVITATION", invitationId,
          memberId, email, displayName, tokenDigest, tokenExpiresAt, state: "PENDING_DELIVERY",
          inviterMemberId: input.member.memberId, createdAt: at, updatedAt: at,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "META" },
        UpdateExpression: "SET pendingInvitationCount = pendingInvitationCount + :one, updatedAt = :at",
        ConditionExpression: "pendingInvitationCount < :limit",
        ExpressionAttributeValues: { ":one": 1, ":limit": 25, ":at": at },
      },
    },
    idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 201, result),
  ]);
  try {
    await ses.send(new SendTemplatedEmailCommand({
      Source: fromAddress,
      Destination: { ToAddresses: [email] },
      Template: invitationTemplate,
      TemplateData: JSON.stringify({
        displayName,
        displayNameHtml: escapeHtml(displayName),
        inviteUrl: href,
        inviteUrlHtml: escapeHtml(href),
      }),
    }));
    await db.send(new UpdateCommand({
      TableName: APPLICATION_TABLE,
      Key: { PK: WS_PK, SK: `INVITE#${invitationId}` },
      UpdateExpression: "SET #state = :pending, updatedAt = :at",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":pending": "PENDING_ACCEPTANCE", ":at": nowIso() },
    }));
  } catch (error) {
    await db.send(new UpdateCommand({
      TableName: APPLICATION_TABLE,
      Key: { PK: WS_PK, SK: `INVITE#${invitationId}` },
      UpdateExpression: "SET #state = :failed, updatedAt = :at",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":failed": "DELIVERY_FAILED", ":at": nowIso() },
    }));
    throw new AppError(502, "INVITATION_DELIVERY_FAILED", "The invitation was saved, but email delivery failed.");
  }
  return { status: 201, result };
}

async function resendInvitation(event: any) {
  return mutation(event, [], async input => {
    requireAdmin(input.member);
    const invitationId = pathValue(event, "invitationId");
    const invite = await getItem(WS_PK, `INVITE#${invitationId}`);
    assert(invite && ["PENDING_ACCEPTANCE", "DELIVERY_FAILED", "PENDING_DELIVERY"].includes(invite.state), 404, "INVITATION_NOT_FOUND", "Pending invitation not found.");
    const token = randomToken();
    const tokenDigest = sha256(token);
    const tokenExpiresAt = nowSeconds() + 172_800;
    const parameters = new URLSearchParams({ id: invitationId, token });
    const href = `${websiteUrl.replace(/\/?$/, "/")}#/accept-invite?${parameters.toString()}`;
    const result = { invitationId, email: invite.email, displayName: invite.displayName, state: "PENDING_ACCEPTANCE", tokenExpiresAt };
    await transact([
      memberCondition(input.claims.sub, input.member),
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `INVITE#${invitationId}` },
          UpdateExpression: "SET tokenDigest = :digest, tokenExpiresAt = :expires, #state = :delivery, updatedAt = :at",
          ConditionExpression: "#state = :pending OR #state = :failed OR #state = :delivery",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":digest": tokenDigest, ":expires": tokenExpiresAt, ":delivery": "PENDING_DELIVERY",
            ":pending": "PENDING_ACCEPTANCE", ":failed": "DELIVERY_FAILED", ":at": nowIso(),
          },
        },
      },
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    try {
      await ses.send(new SendTemplatedEmailCommand({
        Source: fromAddress,
        Destination: { ToAddresses: [invite.email] },
        Template: invitationTemplate,
        TemplateData: JSON.stringify({
          displayName: invite.displayName,
          displayNameHtml: escapeHtml(invite.displayName),
          inviteUrl: href,
          inviteUrlHtml: escapeHtml(href),
        }),
      }));
      await db.send(new UpdateCommand({
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `INVITE#${invitationId}` },
        UpdateExpression: "SET #state = :pending, updatedAt = :at",
        ConditionExpression: "tokenDigest = :digest",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":pending": "PENDING_ACCEPTANCE", ":digest": tokenDigest, ":at": nowIso() },
      }));
    } catch {
      await db.send(new UpdateCommand({
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `INVITE#${invitationId}` },
        UpdateExpression: "SET #state = :failed, updatedAt = :at",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":failed": "DELIVERY_FAILED", ":at": nowIso() },
      }));
      throw new AppError(502, "INVITATION_DELIVERY_FAILED", "The invitation token was rotated, but email delivery failed.");
    }
    return { result };
  });
}

async function revokeInvitation(event: any) {
  return mutation(event, [], async input => {
    requireAdmin(input.member);
    const invitationId = pathValue(event, "invitationId");
    const invite = await getItem(WS_PK, `INVITE#${invitationId}`);
    assert(invite && !["ACCEPTED", "REVOKED"].includes(invite.state), 404, "INVITATION_NOT_FOUND", "Pending invitation not found.");
    const result = { invitationId, state: "REVOKED" };
    await transact([
      memberCondition(input.claims.sub, input.member),
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `INVITE#${invitationId}` },
          UpdateExpression: "SET #state = :revoked, revokedAt = :at, expiresAt = :expires REMOVE tokenDigest",
          ConditionExpression: "#state <> :accepted AND #state <> :revoked",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":revoked": "REVOKED", ":at": nowIso(), ":expires": nowSeconds() + 604_800 },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `MEMBER#${invite.memberId}` },
          UpdateExpression: "SET #status = :revoked, updatedAt = :at",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "REVOKED", ":pending": "PENDING", ":at": nowIso() },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: "META" },
          UpdateExpression: "SET pendingInvitationCount = pendingInvitationCount - :one, updatedAt = :at",
          ConditionExpression: "pendingInvitationCount > :zero",
          ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":at": nowIso() },
        },
      },
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    return { result };
  });
}

async function createSprint(event: any) {
  return mutation(event, ["name", "goal", "startDate", "endDate"], async input => {
    requireAdmin(input.member);
    const sprintId = `sprint-${randomUUID()}`;
    const at = nowIso();
    const sprint = {
      PK: WS_PK, SK: `SPRINT#${sprintId}`, entityType: "SPRINT", schemaVersion: 1,
      sprintId, name: text(input.body.name, "name", 1, 120),
      goal: input.body.goal ? text(input.body.goal, "goal", 0, 500) : "",
      state: "PLANNING", startDate: input.body.startDate ?? null, endDate: input.body.endDate ?? null,
      openTicketCount: 0, version: 1, createdAt: at, updatedAt: at,
    };
    const result = { sprint };
    const records = eventRecords("SprintCreated", sprintId, 1, input.member, input.body.clientMutationId, { sprint });
    const lanes = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"].map(status => ({
      Put: {
        TableName: APPLICATION_TABLE,
        Item: { PK: WS_PK, SK: `LANE#SPRINT#${sprintId}#${status}`, entityType: "LANE", scope: `SPRINT#${sprintId}`, status, version: 1, updatedAt: at },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    }));
    await transact([
      memberCondition(input.claims.sub, input.member),
      { Put: { TableName: APPLICATION_TABLE, Item: sprint, ConditionExpression: "attribute_not_exists(PK)" } },
      ...lanes,
      records.activity, records.outbox,
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 201, result),
    ]);
    return { status: 201, result };
  });
}

async function editSprint(event: any) {
  return mutation(event, ["name", "goal", "startDate", "endDate", "expectedVersion"], async input => {
    requireAdmin(input.member);
    const sprintId = pathValue(event, "sprintId");
    const current = await getItem(WS_PK, `SPRINT#${sprintId}`);
    assert(current?.state === "PLANNING", 422, "PLANNING_SPRINT_REQUIRED", "Only planning sprint metadata can be edited.");
    assert(current.version === integer(input.body.expectedVersion, "expectedVersion"), 409, "SPRINT_CONFLICT", "The sprint changed.");
    const sprint = {
      ...current,
      ...(input.body.name !== undefined ? { name: text(input.body.name, "name", 1, 120) } : {}),
      ...(input.body.goal !== undefined ? { goal: text(input.body.goal, "goal", 0, 500) } : {}),
      ...(input.body.startDate !== undefined ? { startDate: input.body.startDate } : {}),
      ...(input.body.endDate !== undefined ? { endDate: input.body.endDate } : {}),
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    const result = { sprint };
    const records = eventRecords("SprintUpdated", sprintId, sprint.version, input.member, input.body.clientMutationId, { sprint });
    await transact([
      memberCondition(input.claims.sub, input.member),
      { Put: { TableName: APPLICATION_TABLE, Item: sprint, ConditionExpression: "version = :expected", ExpressionAttributeValues: { ":expected": current.version } } },
      records.activity, records.outbox,
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    return { result };
  });
}

async function startSprint(event: any) {
  return mutation(event, ["expectedVersion"], async input => {
    requireAdmin(input.member);
    const sprintId = pathValue(event, "sprintId");
    const current = await getItem(WS_PK, `SPRINT#${sprintId}`);
    assert(current?.state === "PLANNING", 422, "PLANNING_SPRINT_REQUIRED", "Only a planning sprint can start.");
    assert(current.version === integer(input.body.expectedVersion, "expectedVersion"), 409, "SPRINT_CONFLICT", "The sprint changed.");
    const at = nowIso();
    const sprint = { ...current, state: "ACTIVE", version: current.version + 1, startDate: current.startDate ?? at.slice(0, 10), updatedAt: at };
    const result = { sprint };
    const records = eventRecords("SprintStarted", sprintId, sprint.version, input.member, input.body.clientMutationId, { sprint });
    await transact([
      memberCondition(input.claims.sub, input.member),
      {
        Put: {
          TableName: APPLICATION_TABLE,
          Item: { PK: WS_PK, SK: "SINGLETON#ACTIVE_SPRINT", entityType: "ACTIVE_SPRINT", sprintId, version: 1, updatedAt: at },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      { Put: { TableName: APPLICATION_TABLE, Item: sprint, ConditionExpression: "version = :expected AND #state = :planning", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":expected": current.version, ":planning": "PLANNING" } } },
      records.activity, records.outbox,
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    return { result };
  });
}

async function completeSprint(event: any) {
  return mutation(event, ["expectedVersion"], async input => {
    requireAdmin(input.member);
    const sprintId = pathValue(event, "sprintId");
    const current = await getItem(WS_PK, `SPRINT#${sprintId}`);
    assert(current?.state === "ACTIVE", 422, "ACTIVE_SPRINT_REQUIRED", "Only the active sprint can complete.");
    assert(current.version === integer(input.body.expectedVersion, "expectedVersion"), 409, "SPRINT_CONFLICT", "The sprint changed.");
    assert(current.openTicketCount === 0, 422, "SPRINT_HAS_OPEN_TICKETS", "Move every incomplete ticket before completing this sprint.");
    const active = await getItem(WS_PK, "SINGLETON#ACTIVE_SPRINT");
    assert(active?.sprintId === sprintId, 409, "SPRINT_CONFLICT", "The active sprint changed.");
    const at = nowIso();
    const sprint = { ...current, state: "COMPLETED", version: current.version + 1, endDate: current.endDate ?? at.slice(0, 10), updatedAt: at };
    const result = { sprint };
    const records = eventRecords("SprintCompleted", sprintId, sprint.version, input.member, input.body.clientMutationId, { sprint });
    await transact([
      memberCondition(input.claims.sub, input.member),
      { Put: { TableName: APPLICATION_TABLE, Item: sprint, ConditionExpression: "version = :expected AND #state = :active AND openTicketCount = :zero", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":expected": current.version, ":active": "ACTIVE", ":zero": 0 } } },
      { Delete: { TableName: APPLICATION_TABLE, Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_SPRINT" }, ConditionExpression: "sprintId = :sprintId", ExpressionAttributeValues: { ":sprintId": sprintId } } },
      records.activity, records.outbox,
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    return { result };
  });
}

async function ticketMutation(event: any, action: "edit" | "assign" | "archive" | "comment") {
  const allowed = action === "edit"
    ? ["title", "description", "acceptanceCriteria", "priority", "storyPoints", "expectedVersion"]
    : action === "assign" ? ["assigneeMemberId", "expectedVersion"]
      : action === "archive" ? ["expectedVersion"]
        : ["body", "expectedVersion"];
  return mutation(event, allowed, async input => {
    if (action !== "comment" && action !== "assign") requireAdmin(input.member);
    const ticketKey = pathValue(event, "ticketKey");
    const current = await getItem(WS_PK, `TICKET#${ticketKey}`);
    assert(current && !current.archived, 404, "TICKET_NOT_FOUND", "Ticket not found.");
    if (action === "assign") {
      assert(
        input.member.role === "ADMIN" || current.assigneeMemberId === input.member.memberId,
        403,
        "TICKET_ASSIGNMENT_FORBIDDEN",
        "Only administrators or the current assignee may reassign this ticket.",
      );
    }
    assert(current.version === integer(input.body.expectedVersion, "expectedVersion"), 409, "BOARD_CONFLICT", "The ticket changed.");
    let owningSprint: Record<string, any> | undefined;
    if (current.sprintId) {
      owningSprint = await getItem(WS_PK, `SPRINT#${current.sprintId}`);
      assert(owningSprint?.state !== "COMPLETED", 422, "COMPLETED_SPRINT", "Completed sprint tickets are immutable.");
    }
    const constraints: any[] = [memberCondition(input.claims.sub, input.member)];
    if (owningSprint) {
      constraints.push({
        ConditionCheck: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `SPRINT#${current.sprintId}` },
          ConditionExpression: "version = :version AND #state <> :completed",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":version": owningSprint.version, ":completed": "COMPLETED" },
        },
      });
      if (owningSprint.state === "ACTIVE") constraints.push({
        ConditionCheck: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_SPRINT" },
          ConditionExpression: "sprintId = :sprintId",
          ExpressionAttributeValues: { ":sprintId": current.sprintId },
        },
      });
    }
    const at = nowIso();
    let next: Record<string, any> = { ...current, version: current.version + 1, updatedAt: at };
    let eventType = "TicketUpdated";
    if (action === "edit") {
      next = ticketProjection({
        ...next,
        ...(input.body.title !== undefined ? { title: text(input.body.title, "title", 1, 160) } : {}),
        ...(input.body.description !== undefined ? { description: text(input.body.description, "description", 0, 10_000) } : {}),
        ...(input.body.acceptanceCriteria !== undefined ? { acceptanceCriteria: text(input.body.acceptanceCriteria, "acceptanceCriteria", 0, 10_000) } : {}),
        ...(input.body.priority !== undefined ? (assert(priorities.has(input.body.priority), 400, "INVALID_PRIORITY", "Priority is invalid."), { priority: input.body.priority }) : {}),
        ...(input.body.storyPoints !== undefined ? (assert(storyPoints.has(input.body.storyPoints), 400, "INVALID_STORY_POINTS", "Story points are invalid."), { storyPoints: input.body.storyPoints }) : {}),
      });
    } else if (action === "assign") {
      const assignee = input.body.assigneeMemberId;
      if (assignee !== null) {
        const target = await getItem(WS_PK, `MEMBER#${assignee}`);
        assert(target?.status === "ACTIVE", 422, "INVALID_ASSIGNEE", "Assign only active members.");
        if (target.memberId !== input.member.memberId) constraints.push({
          ConditionCheck: {
            TableName: APPLICATION_TABLE,
            Key: { PK: WS_PK, SK: `MEMBER#${target.memberId}` },
            ConditionExpression: "#status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":active": "ACTIVE" },
          },
        });
      }
      next = ticketProjection({ ...next, assigneeMemberId: assignee ?? null });
      eventType = "TicketAssigned";
    } else if (action === "archive") {
      const sprint = current.sprintId ? await getItem(WS_PK, `SPRINT#${current.sprintId}`) : undefined;
      assert(!sprint || sprint.state === "PLANNING", 422, "ACTIVE_TICKET_ARCHIVE", "Move active work out of the sprint before archiving.");
      next = ticketProjection({ ...next, archived: true });
      eventType = "TicketArchived";
    } else {
      const commentBody = text(input.body.body, "body", 1, 4000);
      const commentId = randomUUID();
      const records = eventRecords("TicketCommented", ticketKey, next.version, input.member, input.body.clientMutationId, { ticketKey });
      const result = { ticket: publicTicket(next), comment: { commentId, body: commentBody, authorMemberId: input.member.memberId, authorDisplayName: input.member.displayName, createdAt: at } };
      await transact([
        ...constraints,
        {
          Update: {
            TableName: APPLICATION_TABLE,
            Key: { PK: WS_PK, SK: `TICKET#${ticketKey}` },
            UpdateExpression: "SET version = :next, updatedAt = :at",
            ConditionExpression: "version = :expected AND archived = :false",
            ExpressionAttributeValues: { ":next": next.version, ":expected": current.version, ":at": at, ":false": false },
          },
        },
        {
          Put: {
            TableName: APPLICATION_TABLE,
            Item: { PK: `${WS_PK}#TICKET#${ticketKey}`, SK: `COMMENT#${at}#${commentId}`, entityType: "COMMENT", commentId, ticketKey, authorMemberId: input.member.memberId, authorDisplayName: input.member.displayName, body: commentBody, createdAt: at },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        records.activity,
        records.outbox,
        idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 201, result),
      ]);
      return { status: 201, result };
    }
    const records = eventRecords(eventType, ticketKey, next.version, input.member, input.body.clientMutationId, {
      ticket: publicTicket(next),
      recipientMemberId: action === "assign" ? next.assigneeMemberId : undefined,
    });
    const result = { ticket: publicTicket(next) };
    await transact([
      ...constraints,
      {
        Put: {
          TableName: APPLICATION_TABLE,
          Item: next,
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":expected": current.version },
        },
      },
      records.activity,
      records.outbox,
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    return { result };
  });
}

async function moveTicket(event: any) {
  return mutation(event, [
    "fromScope", "fromStatus", "toScope", "toStatus", "previousTicketKey", "nextTicketKey",
    "expectedTicketVersion", "expectedSourceLaneVersion", "expectedTargetLaneVersion",
  ], async input => {
    const ticketKey = pathValue(event, "ticketKey");
    const ticket = await getItem(WS_PK, `TICKET#${ticketKey}`);
    assert(ticket && !ticket.archived, 404, "TICKET_NOT_FOUND", "Ticket not found.");
    assert(ticket.version === integer(input.body.expectedTicketVersion, "expectedTicketVersion"), 409, "BOARD_CONFLICT", "The ticket changed.");
    const fromScope = String(input.body.fromScope);
    const toScope = String(input.body.toScope);
    const toStatus = String(input.body.toStatus);
    const currentScope = ticket.sprintId ? `SPRINT#${ticket.sprintId}` : "BACKLOG";
    assert(currentScope === fromScope && ticket.status === input.body.fromStatus, 409, "BOARD_CONFLICT", "The ticket changed lanes.");
    assert(toScope === "BACKLOG" ? toStatus === "BACKLOG" : statuses.has(toStatus), 422, "INVALID_LANE", "The destination lane is invalid.");
    if (input.member.role !== "ADMIN") {
      assert(ticket.assigneeMemberId === input.member.memberId && fromScope === toScope, 403, "TICKET_NOT_ASSIGNED", "Members may move only their own active-sprint tickets.");
      const active = await getItem(WS_PK, "SINGLETON#ACTIVE_SPRINT");
      assert(toScope === `SPRINT#${active?.sprintId}`, 403, "ACTIVE_SPRINT_ONLY", "Members may move only active sprint work.");
    }
    const sourceLane = await getItem(WS_PK, `LANE#${fromScope}#${ticket.status}`);
    const targetLane = await getItem(WS_PK, `LANE#${toScope}#${toStatus}`);
    assert(sourceLane?.version === integer(input.body.expectedSourceLaneVersion, "expectedSourceLaneVersion"), 409, "BOARD_CONFLICT", "The source lane changed.");
    assert(targetLane?.version === integer(input.body.expectedTargetLaneVersion, "expectedTargetLaneVersion"), 409, "BOARD_CONFLICT", "The destination lane changed.");
    const targetTickets = (await query({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :status)",
      ExpressionAttributeValues: { ":pk": `BOARD#${WORKSPACE_ID}#${toScope}`, ":status": `${toStatus}#` },
      ScanIndexForward: true,
    })).filter(value => value.ticketKey !== ticketKey);
    const previous = input.body.previousTicketKey ? targetTickets.find(value => value.ticketKey === input.body.previousTicketKey) : undefined;
    const nextNeighbor = input.body.nextTicketKey ? targetTickets.find(value => value.ticketKey === input.body.nextTicketKey) : undefined;
    assert(!input.body.previousTicketKey || previous, 409, "BOARD_CONFLICT", "The previous neighbor changed.");
    assert(!input.body.nextTicketKey || nextNeighbor, 409, "BOARD_CONFLICT", "The next neighbor changed.");
    let rank = previous && nextNeighbor
      ? Math.floor((previous.rank + nextNeighbor.rank) / 2)
      : previous ? previous.rank + 1024
        : nextNeighbor ? Math.floor(nextNeighbor.rank / 2)
          : targetTickets.length ? targetTickets[targetTickets.length - 1]!.rank + 1024 : 1024;
    let laneRebalanced = false;
    if (!Number.isSafeInteger(rank) || rank <= 0 || rank > 999_999_999_999 || previous && rank === previous.rank || nextNeighbor && rank === nextNeighbor.rank) {
      laneRebalanced = true;
      rank = (targetTickets.length + 1) * 1024;
    }
    const sprintId = toScope === "BACKLOG" ? null : toScope.slice("SPRINT#".length);
    const sourceSprint = ticket.sprintId ? await getItem(WS_PK, `SPRINT#${ticket.sprintId}`) : undefined;
    const targetSprint = sprintId
      ? sprintId === ticket.sprintId ? sourceSprint : await getItem(WS_PK, `SPRINT#${sprintId}`)
      : undefined;
    assert(!sourceSprint || sourceSprint.state !== "COMPLETED", 422, "COMPLETED_SPRINT", "Completed sprint tickets are immutable.");
    assert(!targetSprint || ["PLANNING", "ACTIVE"].includes(targetSprint.state), 422, "INVALID_SPRINT", "Tickets cannot enter this sprint.");
    if (sprintId) assert(targetSprint, 404, "SPRINT_NOT_FOUND", "Destination sprint not found.");
    const nextTicket = ticketProjection({ ...ticket, sprintId, status: toStatus, rank, rankKey: rankKey(rank), version: ticket.version + 1, updatedAt: nowIso() });
    const sameLane = fromScope === toScope && ticket.status === toStatus;
    const result = { ticket: publicTicket(nextTicket), laneRebalanced, sourceLaneVersion: sourceLane.version + 1, targetLaneVersion: sameLane ? sourceLane.version + 1 : targetLane.version + 1 };
    const records = eventRecords("TicketMoved", ticketKey, nextTicket.version, input.member, input.body.clientMutationId, {
      ticket: publicTicket(nextTicket), fromScope, fromStatus: ticket.status, toScope, toStatus,
      sourceLaneVersion: result.sourceLaneVersion, targetLaneVersion: result.targetLaneVersion, laneRebalanced,
    });
    const tx: any[] = [
      memberCondition(input.claims.sub, input.member),
      {
        Put: {
          TableName: APPLICATION_TABLE,
          Item: nextTicket,
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":expected": ticket.version },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `LANE#${fromScope}#${ticket.status}` },
          UpdateExpression: "SET version = version + :one, updatedAt = :at",
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":one": 1, ":expected": sourceLane.version, ":at": nowIso() },
        },
      },
    ];
    if (!sameLane) tx.push({
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `LANE#${toScope}#${toStatus}` },
        UpdateExpression: "SET version = version + :one, updatedAt = :at",
        ConditionExpression: "version = :expected",
        ExpressionAttributeValues: { ":one": 1, ":expected": targetLane.version, ":at": nowIso() },
      },
    });
    const sprintDelta = new Map<string, { sprint: Record<string, any>; delta: number }>();
    if (sourceSprint) {
      const delta = ticket.sprintId === sprintId
        ? (ticket.status === "DONE" ? 1 : 0) - (toStatus === "DONE" ? 1 : 0)
        : ticket.status === "DONE" ? 0 : -1;
      sprintDelta.set(ticket.sprintId, { sprint: sourceSprint, delta });
    }
    if (targetSprint && sprintId !== ticket.sprintId) {
      sprintDelta.set(sprintId!, { sprint: targetSprint, delta: toStatus === "DONE" ? 0 : 1 });
    }
    for (const [affectedSprintId, value] of sprintDelta) {
      if (value.delta === 0) {
        tx.push({
          ConditionCheck: {
            TableName: APPLICATION_TABLE,
            Key: { PK: WS_PK, SK: `SPRINT#${affectedSprintId}` },
            ConditionExpression: "version = :version AND #state <> :completed",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":version": value.sprint.version, ":completed": "COMPLETED" },
          },
        });
      } else {
        tx.push({
          Update: {
            TableName: APPLICATION_TABLE,
            Key: { PK: WS_PK, SK: `SPRINT#${affectedSprintId}` },
            UpdateExpression: "SET openTicketCount = openTicketCount + :delta, updatedAt = :at",
            ConditionExpression: `version = :version AND #state <> :completed${value.delta < 0 ? " AND openTicketCount >= :one" : ""}`,
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":version": value.sprint.version, ":completed": "COMPLETED", ":delta": value.delta, ...(value.delta < 0 ? { ":one": 1 } : {}), ":at": nowIso() },
          },
        });
      }
    }
    const activeSprintId = sourceSprint?.state === "ACTIVE" ? ticket.sprintId : targetSprint?.state === "ACTIVE" ? sprintId : undefined;
    if (activeSprintId) tx.push({
      ConditionCheck: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_SPRINT" },
        ConditionExpression: "sprintId = :sprintId",
        ExpressionAttributeValues: { ":sprintId": activeSprintId },
      },
    });
    tx.push(records.activity, records.outbox, idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result));
    await transact(tx);
    return { result };
  });
}

async function createTicket(event: any) {
  return mutation(event, ["title", "description", "acceptanceCriteria", "priority", "storyPoints", "sprintId", "status", "assigneeMemberId"], async input => {
    requireAdmin(input.member);
    const workspace = await getItem(WS_PK, "META");
    assert(workspace, 500, "WORKSPACE_MISSING", "Workspace is unavailable.");
    const nextNumber = workspace.ticketCounter + 1;
    const ticketKey = `SP-${nextNumber}`;
    const sprintId = input.body.sprintId ?? null;
    let targetSprint: Record<string, any> | undefined;
    let status = sprintId ? input.body.status ?? "TODO" : "BACKLOG";
    if (sprintId) {
      targetSprint = await getItem(WS_PK, `SPRINT#${sprintId}`);
      assert(targetSprint?.state === "PLANNING", 422, "PLANNING_SPRINT_REQUIRED", "New tickets can enter only a planning sprint.");
      assert(statuses.has(status), 422, "INVALID_LANE", "Status is invalid.");
    } else status = "BACKLOG";
    const scope = sprintId ? `SPRINT#${sprintId}` : "BACKLOG";
    const lane = await getItem(WS_PK, `LANE#${scope}#${status}`);
    assert(lane, 500, "LANE_MISSING", "The target lane is unavailable.");
    const cards = await query({ IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `BOARD#${WORKSPACE_ID}#${scope}` } });
    const rank = (cards.length + 1) * 1024;
    const at = nowIso();
    const ticket = ticketProjection({
      PK: WS_PK, SK: `TICKET#${ticketKey}`, entityType: "TICKET", schemaVersion: 1,
      ticketKey, title: text(input.body.title, "title", 1, 160),
      description: input.body.description ? text(input.body.description, "description", 0, 10_000) : "",
      acceptanceCriteria: input.body.acceptanceCriteria ? text(input.body.acceptanceCriteria, "acceptanceCriteria", 0, 10_000) : "",
      priority: priorities.has(input.body.priority) ? input.body.priority : "MEDIUM",
      storyPoints: storyPoints.has(input.body.storyPoints) ? input.body.storyPoints : 3,
      sprintId, status, assigneeMemberId: input.body.assigneeMemberId ?? null,
      rank, rankKey: rankKey(rank), archived: false, version: 1, createdAt: at, updatedAt: at,
    });
    const result = { ticket: publicTicket(ticket) };
    const records = eventRecords("TicketCreated", ticketKey, 1, input.member, input.body.clientMutationId, { ticket: result.ticket });
    const tx: any[] = [
      memberCondition(input.claims.sub, input.member),
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: "META" },
          UpdateExpression: "SET ticketCounter = :next, updatedAt = :at",
          ConditionExpression: "ticketCounter = :current",
          ExpressionAttributeValues: { ":next": nextNumber, ":current": workspace.ticketCounter, ":at": at },
        },
      },
      { Put: { TableName: APPLICATION_TABLE, Item: ticket, ConditionExpression: "attribute_not_exists(PK)" } },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `LANE#${scope}#${status}` },
          UpdateExpression: "SET version = version + :one, updatedAt = :at",
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":one": 1, ":expected": lane.version, ":at": at },
        },
      },
    ];
    if (targetSprint && status !== "DONE") tx.push({
      Update: {
        TableName: APPLICATION_TABLE,
        Key: { PK: WS_PK, SK: `SPRINT#${sprintId}` },
        UpdateExpression: "SET openTicketCount = openTicketCount + :one, updatedAt = :at",
        ConditionExpression: "version = :version AND #state = :planning",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":one": 1, ":version": targetSprint.version, ":planning": "PLANNING", ":at": at },
      },
    });
    tx.push(records.activity, records.outbox,
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 201, result),
    );
    await transact(tx);
    return { status: 201, result };
  });
}

async function session(event: any) {
  const { member } = await context(event);
  const workspace = await getItem(WS_PK, "META");
  const active = await getItem(WS_PK, "SINGLETON#ACTIVE_SPRINT");
  const sprint = active ? await getItem(WS_PK, `SPRINT#${active.sprintId}`) : undefined;
  return response(200, {
    membership: member,
    permissions: {
      administer: member!.role === "ADMIN",
      createTickets: member!.role === "ADMIN",
      manageTeam: member!.role === "ADMIN",
    },
    workspace: { workspaceId: WORKSPACE_ID, name: workspace?.name },
    activeSprint: sprint,
  });
}

async function team(event: any) {
  const { member } = await context(event);
  const members = await query({
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": WS_PK, ":prefix": "MEMBER#" },
    ConsistentRead: true,
  });
  const active = members.filter(value => value.status === "ACTIVE").map(value => ({
    memberId: value.memberId, displayName: value.displayName, role: value.role, status: value.status,
    ...(value.memberId === member!.memberId ? { email: value.email } : {}),
  }));
  if (member!.role !== "ADMIN") return response(200, { members: active });
  const invitations = await query({
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": WS_PK, ":prefix": "INVITE#" },
    ConsistentRead: true,
  });
  return response(200, {
    members: active,
    invitations: invitations.filter(value => !["ACCEPTED", "REVOKED"].includes(value.state)).map(value => ({
      invitationId: value.invitationId, email: value.email, displayName: value.displayName,
      state: value.state, tokenExpiresAt: value.tokenExpiresAt, createdAt: value.createdAt,
    })),
  });
}

async function ticketDetail(event: any) {
  await context(event);
  const ticketKey = pathValue(event, "ticketKey");
  const ticket = await getItem(WS_PK, `TICKET#${ticketKey}`);
  assert(ticket, 404, "TICKET_NOT_FOUND", "Ticket not found.");
  const [comments, activity] = await Promise.all([
    query({ KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":pk": `${WS_PK}#TICKET#${ticketKey}`, ":prefix": "COMMENT#" } }),
    query({ IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :pk", ExpressionAttributeValues: { ":pk": `ACTIVITY#WS#${WORKSPACE_ID}#TICKET#${ticketKey}` }, ScanIndexForward: false }),
  ]);
  return response(200, { ticket: publicTicket(ticket), comments, activity });
}

async function listSprints(event: any) {
  await context(event);
  const sprints = await query({ KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":pk": WS_PK, ":prefix": "SPRINT#" } });
  return response(200, { sprints: sprints.sort((a, b) => b.sprintId.localeCompare(a.sprintId)) });
}

async function myTickets(event: any) {
  const { member } = await context(event);
  const tickets = await query({
    IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :pk",
    ExpressionAttributeValues: { ":pk": `ASSIGNEE#${member!.memberId}` },
  });
  return response(200, { tickets: tickets.map(publicTicket) });
}

async function activity(event: any) {
  await context(event);
  const items = await query({
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": WS_PK, ":prefix": "ACTIVITY#" },
    ScanIndexForward: false,
    Limit: 50,
  });
  return response(200, { activity: items });
}

async function realtimeTicket(event: any) {
  return mutation(event, [], async input => {
    const rawToken = randomToken();
    const expiresAt = nowSeconds() + 45;
    const result = { ticket: rawToken, expiresAt, websocketUrl: process.env.WEBSOCKET_URL };
    await transact([
      memberCondition(input.claims.sub, input.member),
      {
        Put: {
          TableName: process.env.CONNECTION_TABLE!,
          Item: {
            PK: `TICKET#${sha256(rawToken)}`, entityType: "REALTIME_TICKET",
            subject: input.claims.sub, memberId: input.member.memberId, workspaceId: WORKSPACE_ID,
            issuedAt: nowSeconds(), expiresAt, consumed: false,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 201, result),
    ]);
    return { status: 201, result };
  });
}

async function revokeMember(event: any) {
  return mutation(event, ["expectedVersion"], async input => {
    requireAdmin(input.member);
    const memberId = pathValue(event, "memberId");
    assert(memberId !== input.member.memberId, 422, "LAST_ADMIN", "The active administrator cannot revoke themselves.");
    const target = await getItem(WS_PK, `MEMBER#${memberId}`);
    assert(target?.status === "ACTIVE", 404, "MEMBER_NOT_FOUND", "Active member not found.");
    const roster = await getItem(WS_PK, "SINGLETON#ACTIVE_MEMBERS");
    assert(roster && Array.isArray(roster.memberIds), 500, "ROSTER_MISSING", "The active member roster is unavailable.");
    const rosterIndex = roster.memberIds.indexOf(memberId);
    assert(rosterIndex >= 0, 409, "MEMBERSHIP_CONFLICT", "The active member roster changed.");
    const result = { memberId, status: "REVOKED" };
    await transact([
      memberCondition(input.claims.sub, input.member),
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `MEMBER#${memberId}` },
          UpdateExpression: "SET #status = :revoked, updatedAt = :at",
          ConditionExpression: "#status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "REVOKED", ":active": "ACTIVE", ":at": nowIso() },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `IDENTITY#SUB#${target.cognitoSub}` },
          UpdateExpression: "SET #status = :revoked",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "REVOKED" },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: `IDENTITY#EMAIL#${sha256(target.email)}` },
          UpdateExpression: "SET #status = :revoked",
          ConditionExpression: "memberId = :memberId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "REVOKED", ":memberId": memberId },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: "META" },
          UpdateExpression: "SET activeMemberCount = activeMemberCount - :one, updatedAt = :at",
          ConditionExpression: "activeMemberCount > :one",
          ExpressionAttributeValues: { ":one": 1, ":at": nowIso() },
        },
      },
      {
        Update: {
          TableName: APPLICATION_TABLE,
          Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_MEMBERS" },
          UpdateExpression: `REMOVE memberIds[${rosterIndex}] SET #count = #count - :one, version = version + :one, updatedAt = :at`,
          ConditionExpression: "version = :version AND #count > :one",
          ExpressionAttributeNames: { "#count": "count" },
          ExpressionAttributeValues: { ":version": roster.version, ":one": 1, ":at": nowIso() },
        },
      },
      idempotencyWrite(input.claims.sub, input.body.clientMutationId, input.digest, 200, result),
    ]);
    const connections = (await db.send(new QueryCommand({
      TableName: CONNECTION_TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `WS#${WORKSPACE_ID}` },
    }))).Items ?? [];
    for (const connection of connections.filter(value => value.memberId === memberId)) {
      await db.send(new DeleteCommand({ TableName: CONNECTION_TABLE, Key: { PK: connection.PK } }));
      try { await management.send(new DeleteConnectionCommand({ ConnectionId: connection.connectionId })); } catch {}
    }
    return { result };
  });
}

export async function handler(event: any) {
  const requestId = event?.requestContext?.requestId ?? randomUUID();
  try {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath;
    if (method === "POST" && path === "/invitations/inspect") return await inspectInvitation(event);
    if (method === "POST" && path === "/bootstrap/claim") return await bootstrapClaim(event);
    if (method === "POST" && path === "/invitations/accept") return await acceptInvitation(event);
    if (method === "GET" && path === "/session") return await session(event);
    if (method === "GET" && path === "/board") {
      await context(event);
      return response(200, await board(event.queryStringParameters?.scope ?? "active"), { "cache-control": "no-cache" });
    }
    if (method === "GET" && path === "/me/tickets") return await myTickets(event);
    if (method === "GET" && /^\/tickets\/[^/]+$/.test(path)) return await ticketDetail(event);
    if (method === "POST" && path === "/tickets") return await createTicket(event);
    if (method === "PATCH" && /^\/tickets\/[^/]+$/.test(path)) return await ticketMutation(event, "edit");
    if (method === "POST" && /\/move$/.test(path)) return await moveTicket(event);
    if (method === "POST" && /\/assign$/.test(path)) return await ticketMutation(event, "assign");
    if (method === "POST" && /\/archive$/.test(path)) return await ticketMutation(event, "archive");
    if (method === "POST" && /\/comments$/.test(path)) return await ticketMutation(event, "comment");
    if (method === "GET" && path === "/sprints") return await listSprints(event);
    if (method === "POST" && path === "/sprints") return await createSprint(event);
    if (method === "PATCH" && /^\/sprints\/[^/]+$/.test(path)) return await editSprint(event);
    if (method === "POST" && /^\/sprints\/[^/]+\/start$/.test(path)) return await startSprint(event);
    if (method === "POST" && /^\/sprints\/[^/]+\/complete$/.test(path)) return await completeSprint(event);
    if (method === "GET" && path === "/team") return await team(event);
    if (method === "POST" && path === "/invitations") return await mutation(event, ["email", "displayName"], createInvitation);
    if (method === "POST" && /^\/invitations\/[^/]+\/resend$/.test(path)) return await resendInvitation(event);
    if (method === "POST" && /^\/invitations\/[^/]+\/revoke$/.test(path)) return await revokeInvitation(event);
    if (method === "POST" && path === "/realtime/tickets") return await realtimeTicket(event);
    if (method === "POST" && /^\/members\/[^/]+\/revoke$/.test(path)) return await revokeMember(event);
    if (method === "GET" && path === "/activity") return await activity(event);
    throw new AppError(404, "ROUTE_NOT_FOUND", "Route not found.");
  } catch (error: any) {
    const appError = error instanceof AppError
      ? error
      : new AppError(500, "INTERNAL_ERROR", "The request could not be completed.");
    log(appError.status >= 500 ? "error" : "warn", {
      requestId,
      route: event?.routeKey,
      result: "error",
      code: appError.code,
      message: appError.status >= 500 ? error?.message : appError.message,
    });
    return response(appError.status, {
      code: appError.code,
      message: appError.message,
      requestId,
      ...appError.details,
    });
  }
}
