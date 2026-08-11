import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { projectRoot } from "./config.mjs";
import { createSeedItems } from "../seed/demo-data.mjs";

const dist = join(projectRoot, "frontend", "dist");
const screenshots = join(projectRoot, "screenshots");
await mkdir(screenshots, { recursive: true });
const runtime = JSON.parse(await readFile(join(dist, "runtime-config.json"), "utf8"));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = normalize(join(dist, relative));
  if (!path.startsWith(dist)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("content-type", types[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const items = createSeedItems({ bootstrapAdmin: { email: "admin@sprint-planner.test", displayName: "Alex Morgan" } });
const tickets = items.filter(item => item.entityType === "TICKET" && item.sprintId === "sprint-08").map(item => {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, seedOwner, seedVersion, schemaVersion, ...ticket } = item;
  return ticket;
});
const members = [
  { memberId: "member-bootstrap-admin", displayName: "Alex Morgan", email: "admin@sprint-planner.test", role: "ADMIN", status: "ACTIVE" },
  { memberId: "member-taylor", displayName: "Taylor Reed", role: "MEMBER", status: "ACTIVE" },
  { memberId: "member-sam", displayName: "Sam Rivera", role: "MEMBER", status: "ACTIVE" },
];
const session = {
  membership: members[0],
  permissions: { administer: true, createTickets: true, manageTeam: true },
  workspace: { workspaceId: "northstar-product", name: "Northstar Product" },
  activeSprint: {
    sprintId: "sprint-08", name: "Sprint 08 — Invitation flow",
    goal: "Ship invited onboarding and a responsive team board",
    startDate: "2026-07-14", endDate: "2026-07-25", openTicketCount: 6, version: 1,
  },
};
const lanes = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"].map((status, index) => ({
  status, version: index + 3, tickets: tickets.filter(ticket => ticket.status === status),
}));
const assignmentRequests = [];
const browser = await chromium.launch({ headless: true });

async function context(viewport, { authenticated = true, currentSession = session } = {}) {
  const browserContext = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await browserContext.addInitScript(authenticatedSession => {
    if (authenticatedSession) sessionStorage.setItem("sprintPlannerRefresh", JSON.stringify({ value: "visual-refresh", expiresAt: Date.now() + 86_400_000 }));
    class VisualWebSocket {
      static OPEN = 1;
      readyState = 1;
      _onopen;
      onmessage;
      onclose;
      onerror;
      set onopen(handler) {
        this._onopen = handler;
        if (handler) queueMicrotask(() => handler(new Event("open")));
      }
      get onopen() { return this._onopen; }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close")); }
      send() {}
      addEventListener(type, listener) { this[`on${type}`] = listener; }
      removeEventListener() {}
    }
    window.WebSocket = VisualWebSocket;
  }, authenticated);
  await browserContext.route(`${new URL(runtime.cognitoEndpoint).origin}/**`, route => route.fulfill({
    status: 200,
    contentType: "application/x-amz-json-1.1",
    body: JSON.stringify({ AuthenticationResult: { IdToken: "visual.id.token", AccessToken: "visual.access.token", ExpiresIn: 3600 } }),
  }));
  await browserContext.route(`${runtime.apiBaseUrl}/**`, async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith("/session")) body = currentSession;
    else if (url.pathname.endsWith("/board")) body = { workspaceId: "northstar-product", scope: "SPRINT#sprint-08", lanes };
    else if (url.pathname.endsWith("/invitations/inspect")) body = { email: "invited@sprint-planner.test" };
    else if (url.pathname.endsWith("/team")) body = {
      members,
      invitations: [{ invitationId: "invite-visual", displayName: "Jordan Lee", email: "jordan@sprint-planner.test", state: "PENDING_ACCEPTANCE", tokenExpiresAt: 1_800_000_000 }],
    };
    else if (/\/tickets\/SP-\d+\/assign$/.test(url.pathname)) {
      const ticketKey = url.pathname.split("/").at(-2);
      const ticket = tickets.find(value => value.ticketKey === ticketKey);
      const request = route.request().postDataJSON();
      assignmentRequests.push(request);
      Object.assign(ticket, { assigneeMemberId: request.assigneeMemberId, version: ticket.version + 1 });
      body = { ticket };
    }
    else if (/\/tickets\/SP-\d+$/.test(url.pathname)) {
      const ticket = tickets.find(value => url.pathname.endsWith(value.ticketKey));
      body = {
        ticket,
        comments: [
          { commentId: "one", authorDisplayName: "Alex Morgan", body: "The verified email comparison now covers normalized addresses." },
          { commentId: "two", authorDisplayName: "Taylor Reed", body: "Keyboard and touch paths are ready for review." },
        ],
        activity: [{ eventId: "event-one", summary: `${ticket.ticketKey} moved to review` }],
      };
    } else if (url.pathname.endsWith("/realtime/tickets")) body = { ticket: "visual-ticket", websocketUrl: "ws://127.0.0.1:9/pending/live" };
    else body = {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return browserContext;
}

const desktop = await context({ width: 1440, height: 900 });
const desktopPage = await desktop.newPage();
await desktopPage.goto(`http://127.0.0.1:${port}/#/board`);
await desktopPage.getByRole("heading", { name: /Sprint 08/ }).waitFor();
await desktopPage.waitForTimeout(250);
if (await desktopPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) throw new Error("Desktop document has horizontal overflow");
await desktopPage.screenshot({ path: join(screenshots, "board-desktop-1440x900.png"), fullPage: true });
await desktopPage.getByText("SP-103", { exact: true }).click();
await desktopPage.getByRole("dialog").waitFor();
const assignee = desktopPage.getByLabel("Assignee");
await assignee.selectOption("member-taylor");
await desktopPage.waitForFunction(() => document.querySelector("select[aria-label='Assignee']")?.value === "member-taylor");
if (assignmentRequests.at(-1)?.assigneeMemberId !== "member-taylor") throw new Error("Ticket assignment did not send the selected member");
await desktopPage.screenshot({ path: join(screenshots, "ticket-drawer-desktop-1440x900.png"), fullPage: true });
await desktop.close();

const ownerSession = {
  ...session,
  membership: members[1],
  permissions: { administer: false, createTickets: false, manageTeam: false },
};
const owner = await context({ width: 1000, height: 800 }, { currentSession: ownerSession });
const ownerPage = await owner.newPage();
await ownerPage.goto(`http://127.0.0.1:${port}/#/board`);
await ownerPage.getByText("SP-103", { exact: true }).click();
await ownerPage.getByLabel("Assignee").waitFor();
await owner.close();

const viewerSession = {
  ...session,
  membership: members[2],
  permissions: { administer: false, createTickets: false, manageTeam: false },
};
const viewer = await context({ width: 1000, height: 800 }, { currentSession: viewerSession });
const viewerPage = await viewer.newPage();
await viewerPage.goto(`http://127.0.0.1:${port}/#/board`);
await viewerPage.getByText("SP-103", { exact: true }).click();
await viewerPage.getByRole("dialog").waitFor();
if (await viewerPage.getByLabel("Assignee").count()) throw new Error("A member who does not own the ticket received assignment controls");
await viewer.close();

const mobile = await context({ width: 390, height: 844 });
const mobilePage = await mobile.newPage();
await mobilePage.goto(`http://127.0.0.1:${port}/#/board`);
await mobilePage.getByRole("heading", { name: /Sprint 08/ }).waitFor();
await mobilePage.waitForTimeout(250);
if (await mobilePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) throw new Error("Mobile document has horizontal overflow");
await mobilePage.screenshot({ path: join(screenshots, "board-mobile-390x844.png"), fullPage: true });
await mobilePage.getByRole("button", { name: "Team" }).click();
await mobilePage.getByRole("heading", { name: "Team" }).waitFor();
await mobilePage.screenshot({ path: join(screenshots, "team-mobile-390x844.png"), fullPage: true });
await mobile.close();

const invited = await context({ width: 1000, height: 900 }, { authenticated: false });
const invitedPage = await invited.newPage();
await invitedPage.goto(`http://127.0.0.1:${port}/#/accept-invite?id=invite-visual&token=visual-token`);
const invitedEmail = invitedPage.getByLabel("Email address");
await invitedPage.waitForFunction(() => document.querySelector('input[type="email"]')?.value === "invited@sprint-planner.test");
if (await invitedEmail.inputValue() !== "invited@sprint-planner.test") throw new Error("Invitation sign-up did not display the inspected email");
if (await invitedEmail.getAttribute("readonly") === null) throw new Error("Invitation email must remain read-only");
await invited.close();

await browser.close();
await new Promise(resolve => server.close(resolve));
console.log("Visual QA passed at 1440×900 and 390×844 with no document-level overflow.");
