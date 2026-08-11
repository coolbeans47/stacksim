import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";

const config = await loadConfig();
const deployment = JSON.parse(await readFile(join(projectRoot, ".runtime", "deployment.json"), "utf8"));
const adminPassword = process.env.SPRINT_PLANNER_ADMIN_PASSWORD;
const memberPassword = process.env.SPRINT_PLANNER_MEMBER_PASSWORD;
if (!adminPassword || !memberPassword) throw new Error("Set ephemeral SPRINT_PLANNER_ADMIN_PASSWORD and SPRINT_PLANNER_MEMBER_PASSWORD values");
const cognito = new CognitoIdentityProviderClient({
  region: config.region,
  endpoint: config.controlPlaneEndpoint,
  credentials: undefined,
});
const memberEmail = `member-${Date.now()}@sprint-planner.test`;

function encodeAws(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function signedInboxFetch(urlValue) {
  const url = new URL(urlValue);
  const payloadHash = createHash("sha256").update("").digest("hex");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const headers = new Headers({
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-stacksim-region": config.region,
  });
  const canonical = new Map([["host", url.host]]);
  headers.forEach((value, name) => canonical.set(name.toLowerCase(), value.trim().replace(/\s+/g, " ")));
  const names = [...canonical.keys()].sort();
  const canonicalHeaders = names.map(name => `${name}:${canonical.get(name)}\n`).join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => [encodeAws(name), encodeAws(value)])
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalPath = encodeAws(url.pathname).replace(/%2F/g, "/");
  const canonicalRequest = `GET\n${canonicalPath}\n${canonicalQuery}\n${canonicalHeaders}\n${names.join(";")}\n${payloadHash}`;
  const scope = `${shortDate}/${config.region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${process.env.AWS_SECRET_ACCESS_KEY || "password"}`, shortDate), config.region), "ses"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID || "admin"}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`);
  return fetch(url, { headers });
}

async function inboxText(email, predicate = () => true) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const list = await signedInboxFetch(`${config.controlPlaneEndpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(email)}&status=all&pageSize=100`);
    const messages = (await list.json()).messages ?? [];
    for (const item of messages.reverse()) {
      const detail = await signedInboxFetch(`${config.controlPlaneEndpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(item.messageId)}`);
      const text = (await detail.json()).message?.textBody ?? "";
      if (predicate(text)) return text;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`No expected email arrived for ${email}`);
}

async function authenticate(email, password, create) {
  const appClientId = deployment.cognito.appClientId;
  if (create) {
    try {
      await cognito.send(new SignUpCommand({ ClientId: appClientId, Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }] }));
      const text = await inboxText(email, value => /\b\d{6}\b/.test(value));
      await cognito.send(new ConfirmSignUpCommand({ ClientId: appClientId, Username: email, ConfirmationCode: text.match(/\b\d{6}\b/)[0] }));
    } catch (error) {
      if (!["UsernameExistsException", "AliasExistsException"].includes(error.name)) throw error;
    }
  }
  const result = await cognito.send(new InitiateAuthCommand({
    ClientId: appClientId,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  return result.AuthenticationResult;
}

async function call(token, method, path, body, expected = 200) {
  const response = await fetch(`${deployment.apiBaseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}

const admin = await authenticate(config.bootstrapAdmin.email, adminPassword, true);
await call(admin.IdToken, "POST", "/bootstrap/claim", {}, 200);
const adminSession = await call(admin.AccessToken, "GET", "/session");
assert.equal(adminSession.membership.role, "ADMIN");
const invitation = await call(admin.AccessToken, "POST", "/invitations", {
  email: memberEmail,
  displayName: "Taylor Reed",
  clientMutationId: crypto.randomUUID(),
}, 201);
const invitationText = await inboxText(memberEmail, value => value.includes("#/accept-invite"));
const link = invitationText.match(/https?:\/\/\S+#\/accept-invite\?\S+/)?.[0];
assert(link, "invitation email contains the hash link");
const parameters = new URLSearchParams(link.split("?")[1].replaceAll("&amp;", "&"));
const rawInviteToken = parameters.get("token");
assert(rawInviteToken);
const member = await authenticate(memberEmail, memberPassword, true);
const accepted = await call(member.IdToken, "POST", "/invitations/accept", {
  invitationId: invitation.invitationId,
  token: rawInviteToken,
  clientMutationId: crypto.randomUUID(),
});
assert.equal(accepted.membership.status, "ACTIVE");

const adminRealtime = await call(admin.AccessToken, "POST", "/realtime/tickets", { clientMutationId: crypto.randomUUID() }, 201);
const memberRealtime = await call(member.AccessToken, "POST", "/realtime/tickets", { clientMutationId: crypto.randomUUID() }, 201);
const sockets = [adminRealtime, memberRealtime].map(value => new WebSocket(`${value.websocketUrl}?ticket=${encodeURIComponent(value.ticket)}`));
await Promise.all(sockets.map(socket => new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; })));
const messages = [[], []];
sockets.forEach((socket, index) => socket.onmessage = event => messages[index].push(JSON.parse(event.data)));
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
};

try {
let board = await call(admin.AccessToken, "GET", "/board?scope=active");
let ticket = board.lanes.flatMap(lane => lane.tickets).find(value => value.ticketKey === "SP-105");
const assignment = await call(admin.AccessToken, "POST", "/tickets/SP-105/assign", {
  assigneeMemberId: accepted.membership.memberId,
  expectedVersion: ticket.version,
  clientMutationId: crypto.randomUUID(),
});
ticket = assignment.ticket;
await waitFor(() => messages[1].some(value => value.eventType === "TicketAssigned"), "member receives assignment live");
const memberReassignment = await call(member.AccessToken, "POST", "/tickets/SP-105/assign", {
  assigneeMemberId: adminSession.membership.memberId,
  expectedVersion: ticket.version,
  clientMutationId: crypto.randomUUID(),
});
ticket = memberReassignment.ticket;
assert.equal(ticket.assigneeMemberId, adminSession.membership.memberId, "current assignee can reassign a ticket");
await call(member.AccessToken, "POST", "/tickets/SP-105/assign", {
  assigneeMemberId: accepted.membership.memberId,
  expectedVersion: ticket.version,
  clientMutationId: crypto.randomUUID(),
}, 403);
const adminReassignment = await call(admin.AccessToken, "POST", "/tickets/SP-105/assign", {
  assigneeMemberId: accepted.membership.memberId,
  expectedVersion: ticket.version,
  clientMutationId: crypto.randomUUID(),
});
ticket = adminReassignment.ticket;

board = await call(member.AccessToken, "GET", "/board?scope=active");
const source = board.lanes.find(lane => lane.status === ticket.status);
const target = board.lanes.find(lane => lane.status === "REVIEW");
const moved = await call(member.AccessToken, "POST", "/tickets/SP-105/move", {
  fromScope: "SPRINT#sprint-08", fromStatus: ticket.status,
  toScope: "SPRINT#sprint-08", toStatus: "REVIEW",
  previousTicketKey: target.tickets.at(-1)?.ticketKey ?? null, nextTicketKey: null,
  expectedTicketVersion: ticket.version,
  expectedSourceLaneVersion: source.version, expectedTargetLaneVersion: target.version,
  clientMutationId: crypto.randomUUID(),
});
await waitFor(() => messages[0].some(value => value.eventType === "TicketMoved"), "administrator receives member move live");
await call(member.AccessToken, "POST", "/tickets", { title: "Forbidden", clientMutationId: crypto.randomUUID() }, 403);

board = await call(admin.AccessToken, "GET", "/board?scope=active");
ticket = board.lanes.flatMap(lane => lane.tickets).find(value => value.ticketKey === "SP-105");
const review = board.lanes.find(lane => lane.status === "REVIEW");
const done = board.lanes.find(lane => lane.status === "DONE");
const mutation = {
  fromScope: "SPRINT#sprint-08", fromStatus: "REVIEW", toScope: "SPRINT#sprint-08", toStatus: "DONE",
  previousTicketKey: done.tickets.at(-1)?.ticketKey ?? null, nextTicketKey: null,
  expectedTicketVersion: ticket.version,
  expectedSourceLaneVersion: review.version, expectedTargetLaneVersion: done.version,
};
const races = await Promise.all([
  fetch(`${deployment.apiBaseUrl}/tickets/SP-105/move`, { method: "POST", headers: { authorization: `Bearer ${admin.AccessToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...mutation, clientMutationId: crypto.randomUUID() }) }),
  fetch(`${deployment.apiBaseUrl}/tickets/SP-105/move`, { method: "POST", headers: { authorization: `Bearer ${member.AccessToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...mutation, clientMutationId: crypto.randomUUID() }) }),
]);
assert.deepEqual(races.map(value => value.status).sort(), [200, 409], "one concurrent move wins and one conflicts");
await call(admin.AccessToken, "POST", `/members/${accepted.membership.memberId}/revoke`, { expectedVersion: 1, clientMutationId: crypto.randomUUID() });
} finally {
  sockets.forEach(socket => socket.close());
}
cognito.destroy();
console.log(`Two-user collaboration passed with stack-owned Cognito user ${memberEmail}.`);
