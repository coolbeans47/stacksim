import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createSeedItems,
  expectedSeedCounts,
  WORKSPACE_ID,
} from "../seed/demo-data.mjs";

const config = {
  bootstrapAdmin: {
    email: "Admin@Sprint-Planner.Test ",
    displayName: "Alex Morgan",
  },
};

test("deterministic seed has the exact workspace, sprint, ticket, comment, and activity contract", () => {
  const items = createSeedItems(config);
  const byType = type => items.filter(item => item.entityType === type);
  assert.equal(byType("WORKSPACE").length, 1);
  assert.equal(byType("SPRINT").length, expectedSeedCounts.sprints);
  assert.equal(byType("TICKET").length, expectedSeedCounts.tickets);
  assert.equal(byType("COMMENT").length, expectedSeedCounts.comments);
  assert.equal(byType("ACTIVITY").length, expectedSeedCounts.activity);
  assert.equal(byType("TICKET").filter(item => item.sprintId === "sprint-08").length, expectedSeedCounts.activeTickets);
  assert.equal(byType("TICKET").filter(item => item.sprintId === null).length, expectedSeedCounts.backlogTickets);
  assert.equal(new Set(byType("TICKET").map(item => item.ticketKey)).size, expectedSeedCounts.tickets);
  assert.equal(new Set(items.map(item => `${item.PK}|${item.SK}`)).size, items.length);
  assert.equal(byType("SPRINT").find(item => item.sprintId === "sprint-08").openTicketCount, 6);
  assert.equal(byType("SPRINT").find(item => item.sprintId === "sprint-07").openTicketCount, 0);
  assert(byType("TICKET").every(item => /^\d{12}$/.test(item.rankKey)));
  assert(items.every(item => item.seedOwner === "sprint-planner"));
});

test("seed creates a pending bootstrap identity without a Cognito subject or credential", () => {
  const items = createSeedItems(config);
  const member = items.find(item => item.entityType === "MEMBER");
  const marker = items.find(item => item.entityType === "BOOTSTRAP");
  const binding = items.find(item => item.entityType === "EMAIL_BINDING");
  assert.equal(member.email, "admin@sprint-planner.test");
  assert.equal(member.role, "ADMIN");
  assert.equal(member.status, "PENDING");
  assert.equal(member.cognitoSub, undefined);
  assert.equal(marker.state, "PENDING");
  assert.equal(binding.emailHash, createHash("sha256").update(member.email).digest("hex"));
  const serialized = JSON.stringify(items).toLowerCase();
  for (const term of ["password", "refreshtoken", "confirmationcode", "clientsecret"]) assert.equal(serialized.includes(term), false);
  assert(items.some(item => item.PK === `WS#${WORKSPACE_ID}` && item.SK === "SINGLETON#ACTIVE_SPRINT"));
});
