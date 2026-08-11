import { createHash } from "node:crypto";

export const WORKSPACE_ID = "northstar-product";
export const SEED_VERSION = 1;
export const BOOTSTRAP_MEMBER_ID = "member-bootstrap-admin";
export const DEMO_SPRINT_IDS = ["sprint-07", "sprint-08", "sprint-09"];
export const DEMO_TICKET_KEYS = [
  "SP-091", "SP-092", "SP-093",
  "SP-101", "SP-102", "SP-103", "SP-104", "SP-105", "SP-106", "SP-107", "SP-108",
  "SP-109", "SP-110", "SP-111", "SP-112",
];

const baseTime = "2026-07-23T12:00:00.000Z";
const owner = { schemaVersion: 1, seedOwner: "sprint-planner", seedVersion: SEED_VERSION };
const wsPk = `WS#${WORKSPACE_ID}`;
const rankKey = rank => String(rank).padStart(12, "0");

const ticketDefinitions = [
  ["SP-091", "Configure the S3 application shell", "sprint-07", "DONE", 2, "MEDIUM", BOOTSTRAP_MEMBER_ID],
  ["SP-092", "Create the board persistence model", "sprint-07", "DONE", 5, "HIGH", BOOTSTRAP_MEMBER_ID],
  ["SP-093", "Define the application role matrix", "sprint-07", "DONE", 3, "HIGH", BOOTSTRAP_MEMBER_ID],
  ["SP-101", "Design invitation email", "sprint-08", "DONE", 2, "MEDIUM", BOOTSTRAP_MEMBER_ID],
  ["SP-102", "Build Cognito signup screen", "sprint-08", "DONE", 5, "HIGH", BOOTSTRAP_MEMBER_ID],
  ["SP-103", "Validate email-match acceptance", "sprint-08", "REVIEW", 3, "URGENT", BOOTSTRAP_MEMBER_ID],
  ["SP-104", "Add Kanban drag overlay", "sprint-08", "IN_PROGRESS", 5, "HIGH", BOOTSTRAP_MEMBER_ID],
  ["SP-105", "Broadcast ticket moves", "sprint-08", "IN_PROGRESS", 3, "HIGH", null],
  ["SP-106", "Handle expired invitations", "sprint-08", "TODO", 3, "MEDIUM", BOOTSTRAP_MEMBER_ID],
  ["SP-107", "Verify member authorization", "sprint-08", "TODO", 5, "URGENT", BOOTSTRAP_MEMBER_ID],
  ["SP-108", "Build mobile lane switcher", "sprint-08", "TODO", 3, "MEDIUM", null],
  ["SP-109", "Sprint completion summary", null, "BACKLOG", 3, "MEDIUM", null],
  ["SP-110", "Keyboard drag controls", null, "BACKLOG", 5, "HIGH", BOOTSTRAP_MEMBER_ID],
  ["SP-111", "Assignment notifications", null, "BACKLOG", 3, "MEDIUM", null],
  ["SP-112", "Priority filter", null, "BACKLOG", 2, "LOW", null],
];

function ticketItem(definition, position) {
  const [ticketKey, title, sprintId, status, storyPoints, priority, assigneeMemberId] = definition;
  const rank = (position + 1) * 1024;
  const scope = sprintId ? `SPRINT#${sprintId}` : "BACKLOG";
  return {
    PK: wsPk,
    SK: `TICKET#${ticketKey}`,
    entityType: "TICKET",
    ticketKey,
    title,
    description: `${title} for the Northstar Product team. This deterministic showcase item is safe to edit.`,
    acceptanceCriteria: `The ${title.toLowerCase()} flow is usable, accessible, and covered by the showcase.`,
    sprintId,
    status,
    storyPoints,
    priority,
    assigneeMemberId,
    rank,
    rankKey: rankKey(rank),
    archived: false,
    version: 1,
    createdAt: baseTime,
    updatedAt: baseTime,
    GSI1PK: `BOARD#${WORKSPACE_ID}#${scope}`,
    GSI1SK: `${status}#${rankKey(rank)}#${ticketKey}`,
    ...(assigneeMemberId ? {
      GSI2PK: `ASSIGNEE#${assigneeMemberId}`,
      GSI2SK: `WS#${WORKSPACE_ID}#${scope}#${status}#${rankKey(rank)}#${ticketKey}`,
    } : {}),
    ...owner,
  };
}

export function createSeedItems(config) {
  const email = config.bootstrapAdmin.email.normalize("NFC").trim().toLowerCase();
  const emailHash = createHash("sha256").update(email).digest("hex");
  const items = [
    {
      PK: wsPk, SK: "META", entityType: "WORKSPACE", workspaceId: WORKSPACE_ID,
      name: "Northstar Product", ticketCounter: 112, version: 1,
      activeMemberCount: 0, pendingInvitationCount: 0, createdAt: baseTime, updatedAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: "SINGLETON#ACTIVE_MEMBERS", entityType: "ACTIVE_MEMBER_ROSTER",
      memberIds: [], count: 0, version: 1, updatedAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: "BOOTSTRAP#ADMIN", entityType: "BOOTSTRAP",
      email, memberId: BOOTSTRAP_MEMBER_ID, state: "PENDING", createdAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: `MEMBER#${BOOTSTRAP_MEMBER_ID}`, entityType: "MEMBER",
      memberId: BOOTSTRAP_MEMBER_ID, email, displayName: config.bootstrapAdmin.displayName,
      role: "ADMIN", status: "PENDING", provenance: "BOOTSTRAP", createdAt: baseTime, updatedAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: `IDENTITY#EMAIL#${emailHash}`, entityType: "EMAIL_BINDING",
      emailHash, memberId: BOOTSTRAP_MEMBER_ID, status: "PENDING", createdAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: "SPRINT#sprint-07", entityType: "SPRINT", sprintId: "sprint-07",
      name: "Sprint 07 — Board foundations", goal: "Establish the shared planning foundation",
      state: "COMPLETED", startDate: "2026-06-30", endDate: "2026-07-11",
      openTicketCount: 0, version: 1, createdAt: baseTime, updatedAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: "SPRINT#sprint-08", entityType: "SPRINT", sprintId: "sprint-08",
      name: "Sprint 08 — Invitation flow", goal: "Ship invited onboarding and a responsive team board",
      state: "ACTIVE", startDate: "2026-07-14", endDate: "2026-07-25",
      openTicketCount: 6, version: 1, createdAt: baseTime, updatedAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: "SPRINT#sprint-09", entityType: "SPRINT", sprintId: "sprint-09",
      name: "Sprint 09 — Flow and accessibility", goal: "Make every planning workflow work for every teammate",
      state: "PLANNING", startDate: null, endDate: null,
      openTicketCount: 0, version: 1, createdAt: baseTime, updatedAt: baseTime, ...owner,
    },
    {
      PK: wsPk, SK: "SINGLETON#ACTIVE_SPRINT", entityType: "ACTIVE_SPRINT",
      sprintId: "sprint-08", version: 1, updatedAt: baseTime, ...owner,
    },
    {
      PK: "SEED#sprint-planner", SK: "VERSION#1", entityType: "SEED",
      completedAt: baseTime, workspaceId: WORKSPACE_ID, ...owner,
    },
  ];

  for (const scope of ["BACKLOG", "SPRINT#sprint-07", "SPRINT#sprint-08", "SPRINT#sprint-09"]) {
    for (const status of scope === "BACKLOG" ? ["BACKLOG"] : ["TODO", "IN_PROGRESS", "REVIEW", "DONE"]) {
      items.push({
        PK: wsPk, SK: `LANE#${scope}#${status}`, entityType: "LANE",
        scope, status, version: 1, updatedAt: baseTime, ...owner,
      });
    }
  }
  ticketDefinitions.forEach((ticket, index) => items.push(ticketItem(ticket, index)));

  const comments = [
    ["SP-103", "comment-01", "The acceptance check must use the verified normalized email.", "2026-07-21T10:15:00.000Z"],
    ["SP-104", "comment-02", "Keyboard pickup and cancellation are included in the interaction pass.", "2026-07-22T09:20:00.000Z"],
    ["SP-105", "comment-03", "The live event carries authoritative lane and entity versions.", "2026-07-22T15:45:00.000Z"],
  ];
  for (const [ticketKey, commentId, body, timestamp] of comments) {
    items.push({
      PK: `${wsPk}#TICKET#${ticketKey}`, SK: `COMMENT#${timestamp}#${commentId}`,
      entityType: "COMMENT", commentId, ticketKey, authorMemberId: BOOTSTRAP_MEMBER_ID,
      authorDisplayName: config.bootstrapAdmin.displayName, body, createdAt: timestamp, ...owner,
    });
  }
  DEMO_TICKET_KEYS.forEach((ticketKey, index) => {
    const timestamp = new Date(Date.parse(baseTime) + index * 60_000).toISOString();
    const eventId = `seed-activity-${String(index + 1).padStart(2, "0")}`;
    items.push({
      PK: wsPk, SK: `ACTIVITY#${timestamp}#${eventId}`, entityType: "ACTIVITY",
      eventId, action: index < 3 ? "SPRINT_COMPLETED_TICKET" : "TICKET_SEEDED",
      ticketKey, actorMemberId: BOOTSTRAP_MEMBER_ID, actorDisplayName: config.bootstrapAdmin.displayName,
      summary: `${ticketKey} added to the deterministic workspace`, createdAt: timestamp,
      GSI2PK: `ACTIVITY#WS#${WORKSPACE_ID}#TICKET#${ticketKey}`,
      GSI2SK: `${timestamp}#${eventId}`, ...owner,
    });
  });
  return items;
}

export const expectedSeedCounts = Object.freeze({
  sprints: 3,
  tickets: 15,
  completedTickets: 3,
  activeTickets: 8,
  backlogTickets: 4,
  comments: 3,
  activity: 15,
});
