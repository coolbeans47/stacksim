import { events, rest, scheduler } from "../api-client.js";
import { associateFormLabels, emptyState, escapeHtml, formatDate, pageHeader, tabs } from "../components.js";
import { arnComboboxField } from "../arn-combobox.js";
import { timezoneSelectOptions } from "../timezones.js";
import { session as ui, setDirty } from "../state.js";
import { decorateEventBridgePanelHelp } from "./eventbridge-help.js";

export const metadata = {
  key: "eventbridge",
  name: "EventBridge",
  icon: "E",
  cls: "eventbridge",
  links: [["Event buses", "#/eventbridge/event-buses"], ["Rules", "#/eventbridge/rules"], ["Archives", "#/eventbridge/archives"], ["Replays", "#/eventbridge/replays"], ["Schedules", "#/eventbridge/schedules"], ["Schedule groups", "#/eventbridge/schedule-groups"], ["Sandbox", "#/eventbridge/sandbox"]],
  search: ["eventbridge", "event bus", "events", "rules", "routing", "archive", "retention", "replay", "pattern", "schedule", "cron", "sandbox"],
};

const defaultPattern = JSON.stringify({ source: ["example.orders"] }, null, 2);
const defaultSample = JSON.stringify({
  version: "0",
  id: "example-event-id",
  "detail-type": "Order state changed",
  source: "example.orders",
  account: "000000000000",
  time: "2026-07-20T12:00:00Z",
  region: "eu-west-1",
  resources: [],
  detail: { state: "created" },
}, null, 2);

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function parseJson(value, label) {
  try { return JSON.parse(String(value)); }
  catch { throw new Error(`${label} must be valid JSON`); }
}

function stringMap(value, label) {
  const parsed = parseObject(value, label);
  if (Object.values(parsed).some(item => typeof item !== "string")) throw new Error(`${label} values must be strings`);
  return parsed;
}

function stringList(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "[]")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new Error(`${label} must be a JSON array of strings`);
  return parsed;
}

function tagsToMap(tags = []) { return Object.fromEntries(tags.map(tag => [tag.Key, tag.Value])); }
function tagsFromMap(tags = {}) { return Object.entries(tags).map(([Key, Value]) => ({ Key, Value })); }
function nameFromArn(arn = "") {
  const value = String(arn);
  for (const marker of [":event-bus/", ":archive/", ":replay/", ":rule/"]) if (value.includes(marker)) return value.split(marker)[1].split("/").at(-1) || value;
  return value.split(":").at(-1) || value;
}
function functionNameFromArn(arn = "") { return String(arn).split(":function:")[1]?.split(":")[0] ?? nameFromArn(arn); }
function roleNameFromArn(arn = "") { return String(arn).split("/").at(-1) || String(arn); }
function schedulerTargetMarkup(arn = "") {
  const value = String(arn);
  if (/^arn:aws:lambda:[^:]+:\d{12}:function:[^:]+(?::[^:]+)?$/.test(value)) return `<a class="mono" href="#/lambda/functions/${encoded(functionNameFromArn(value))}">${escapeHtml(value)}</a>`;
  return `<span class="mono">${escapeHtml(value)}</span>`;
}
function targetType(target = {}) {
  const arn = String(target.Arn || "");
  if (arn.includes(":sqs:")) return "sqs";
  if (arn.includes(":logs:") && arn.includes(":log-group:")) return "logs";
  if (arn.includes(":execute-api:")) return "apigateway";
  if (arn.includes(":states:") && arn.includes(":stateMachine:")) return "states";
  return "lambda";
}
function targetTypeLabel(type) { return ({ lambda: "Lambda", sqs: "SQS", logs: "CloudWatch Logs", apigateway: "API Gateway", states: "Step Functions" })[type] ?? "Target"; }
function queueNameFromArn(arn = "") { return String(arn).split(":").at(-1) || String(arn); }
function logGroupNameFromArn(arn = "") { return String(arn).split(":log-group:")[1]?.replace(/:\*$/, "") ?? String(arn); }
function apiIdFromArn(arn = "") { return String(arn).split(":")[5]?.split("/")[0] ?? String(arn); }
function targetDisplayName(target = {}) {
  const type = targetType(target);
  if (type === "lambda") return functionNameFromArn(target.Arn);
  if (type === "sqs") return queueNameFromArn(target.Arn);
  if (type === "logs") return logGroupNameFromArn(target.Arn);
  if (type === "states") return nameFromArn(target.Arn);
  return apiIdFromArn(target.Arn);
}
function targetHref(target = {}) {
  const type = targetType(target);
  if (type === "lambda") return `#/lambda/functions/${encoded(functionNameFromArn(target.Arn))}`;
  if (type === "sqs") return `#/sqs/queues/${encoded(queueNameFromArn(target.Arn))}/access-policy`;
  if (type === "logs") return `#/cloudwatch/log-groups/${encoded(logGroupNameFromArn(target.Arn))}/resource-policy`;
  if (type === "states") return `#/step-functions/state-machines/${encoded(target.Arn)}`;
  return `#/apigateway/apis/${encoded(apiIdFromArn(target.Arn))}/policy`;
}
function stateMarkup(state) { return `<span class="status ${state === "DISABLED" ? "inactive" : ""}">${escapeHtml(state === "DISABLED" ? "Disabled" : "Enabled")}</span>`; }
function encoded(value) { return encodeURIComponent(value); }
function busRoot(name) { return `#/eventbridge/event-buses/${encoded(name)}`; }
function ruleRoot(bus, rule) { return `#/eventbridge/rules/${encoded(bus)}/${encoded(rule)}`; }

async function listAll(operation, input, resultKey) {
  const collected = [];
  let NextToken;
  do {
    const page = await events(operation, { ...input, Limit: 100, ...(NextToken ? { NextToken } : {}) });
    collected.push(...(page[resultKey] ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return collected;
}

async function listBuses() { return listAll("ListEventBuses", {}, "EventBuses"); }
async function listRules(bus) { return listAll("ListRules", { EventBusName: bus }, "Rules"); }
async function listTargets(bus, rule) { return listAll("ListTargetsByRule", { EventBusName: bus, Rule: rule }, "Targets"); }
async function listArchives() { return listAll("ListArchives", {}, "Archives"); }
async function listReplays() { return listAll("ListReplays", {}, "Replays"); }

async function listTags(arn) {
  if (!arn) return [];
  return (await events("ListTagsForResource", { ResourceARN: arn })).Tags ?? [];
}

async function deliveryDiagnostics() {
  return rest("/_stacksim/api/eventbridge/deliveries");
}

function boundedText(value, maximum = 240) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function diagnosticTable(deliveries, diagnostics) {
  const pending = deliveries.map(item => ({ ...item, updatedAt: item.enqueuedAt, displayStatus: item.status, errorMessage: item.lastError }));
  const completed = diagnostics.map(item => ({ ...item, displayStatus: item.status }));
  const rows = [...pending, ...completed].sort((left, right) => Number(right.updatedAt ?? right.enqueuedAt ?? 0) - Number(left.updatedAt ?? left.enqueuedAt ?? 0)).slice(0, 100);
  if (!rows.length) return emptyState("◇", "No delivery attempts", "Matching events will appear here as bounded, payload-redacted diagnostics.");
  return `<table class="eventbridge-diagnostic-table"><thead><tr><th>Updated</th><th>Event ID</th><th>Rule</th><th>Target</th><th>Status</th><th>Attempts</th><th>DLQ</th><th>Next attempt / error</th></tr></thead><tbody>${rows.map(item => {
    const type = targetType({ Arn: item.targetArn });
    const statusClass = ["FAILED", "DLQ_FAILED"].includes(item.displayStatus) ? "error" : ["RETRYING", "QUEUED", "LEASED"].includes(item.displayStatus) ? "pending" : "";
    return `<tr><td class="no-wrap">${formatDate(item.updatedAt ?? item.enqueuedAt)}</td><td class="mono">${escapeHtml(item.eventId)}</td><td>${escapeHtml(item.ruleName)}</td><td>${escapeHtml(item.targetId)}${item.targetArn ? `<div class="muted small">${escapeHtml(targetTypeLabel(type))} · ${escapeHtml(targetDisplayName({ Arn: item.targetArn }))}</div>` : ""}</td><td><span class="status ${statusClass}">${escapeHtml(item.displayStatus)}</span></td><td>${Number(item.attempts ?? 0)}</td><td>${item.deadLetterArn ? `<a href="#/sqs/queues/${encoded(queueNameFromArn(item.deadLetterArn))}/messages">${escapeHtml(queueNameFromArn(item.deadLetterArn))}</a>` : "–"}</td><td>${item.nextAttemptAt ? formatDate(item.nextAttemptAt) : escapeHtml(boundedText(item.errorMessage || item.errorCode || "–"))}</td></tr>`;
  }).join("")}</tbody></table>`;
}

async function lambdaFunctions() {
  const functions = [];
  let Marker;
  do {
    const query = new URLSearchParams({ MaxItems: "50", ...(Marker ? { Marker } : {}) });
    const response = await rest(`/2015-03-31/functions?${query}`);
    functions.push(...(response.Functions ?? []));
    Marker = response.NextMarker;
  } while (Marker);
  return functions;
}

function busTabs(name, active) {
  const root = busRoot(name);
  return tabs([
    { label: "Details", href: `${root}/details`, active: active === "details" },
    { label: "Rules", href: `${root}/rules`, active: active === "rules" },
    { label: "Monitoring", href: `${root}/monitoring`, active: active === "monitoring" },
    { label: "Tags", href: `${root}/tags`, active: active === "tags" },
  ]);
}

function ruleTabs(bus, rule, active) {
  const root = ruleRoot(bus, rule);
  return tabs([
    { label: "Details", href: `${root}/details`, active: active === "details" },
    { label: "Targets", href: `${root}/targets`, active: active === "targets" },
    { label: "Monitoring", href: `${root}/monitoring`, active: active === "monitoring" },
    { label: "Tags", href: `${root}/tags`, active: active === "tags" },
  ]);
}

function setBusChrome(context, name, section) {
  context.setChrome("eventbridge", ["EventBridge", { label: "Event buses", href: "#/eventbridge/event-buses" }, name, ...(section ? [section] : [])]);
}

function setRuleChrome(context, bus, rule, section) {
  context.setChrome("eventbridge", ["EventBridge", { label: "Rules", href: "#/eventbridge/rules" }, rule, ...(section ? [section] : [])]);
}

function dependencyCards() {
  return `<div class="eventbridge-dependency-grid"><section class="card"><div class="card-header"><h2>Permissions</h2><span class="status inactive">Unavailable</span></div><div class="card-body"><p>Event-bus resource policies and cross-account bus routing are not currently available. Target resource policies and supported execution roles are active.</p></div></section><section class="card"><div class="card-header"><h2>Encryption</h2><span class="status inactive">Unavailable</span></div><div class="card-body"><p>Customer-managed KMS keys and encrypted-bus dead-letter configuration are dependency-blocked.</p></div></section><section class="card"><div class="card-header"><h2>Logging</h2><span class="status inactive">Unavailable</span></div><div class="card-body"><p>Event-bus execution logging is not available. Rule metrics and payload-redacted local diagnostics remain separate.</p></div></section></div>`;
}

function bindCreateBus(context) {
  document.querySelectorAll("[data-create-event-bus]").forEach(button => button.addEventListener("click", () => context.showModal("Create event bus", `<div class="field"><label>Name</label><input name="name" required maxlength="256" pattern="[A-Za-z0-9_.\/-]+" placeholder="local-app-events"></div><div class="field"><label>Description</label><textarea name="description" maxlength="512" placeholder="Events emitted by the local application"></textarea></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea><span class="hint">Keys and values must be strings.</span></div><div class="alert info"><strong>Custom event bus</strong><br>The regional default bus already exists and cannot be deleted. Partner sources, KMS encryption, dead-letter configuration, and logging are not currently available.</div>`, "Create event bus", async data => {
    const name = String(data.get("name"));
    const description = String(data.get("description") || "");
    await events("CreateEventBus", { Name: name, ...(description ? { Description: description } : {}), Tags: tagsFromMap(stringMap(data.get("tags"), "Tags")) });
    context.toast("Event bus created");
    location.hash = `${busRoot(name)}/details`;
  })));
}

async function busCatalog() {
  const buses = await listBuses();
  return Promise.all(buses.map(async bus => {
    const rules = await listRules(bus.Name);
    return { ...bus, rules };
  }));
}

async function eventBusesPage(context) {
  const buses = await busCatalog();
  context.setChrome("eventbridge", ["EventBridge", "Event buses"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Event buses", `Regional event routers in ${escapeHtml(ui.region)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh event buses">↻</button><button class="button primary" data-create-event-bus>Create event bus</button>')}<div class="alert info"><strong>Routing, not event storage</strong><br>EventBridge evaluates accepted events against enabled rules and then discards ordinary events. Use the Sandbox to publish and test patterns.</div><section class="card"><div class="card-header"><h2>Event buses <span class="muted">(${buses.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find event buses"></label></div><div class="table-wrap">${buses.length ? `<table class="eventbridge-resource-table"><thead><tr><th>Name</th><th>Type</th><th>Rules</th><th>Description</th><th>ARN</th></tr></thead><tbody>${buses.map(bus => `<tr data-search-row="${escapeHtml(`${bus.Name} ${bus.Description || ""} ${bus.Arn || ""}`.toLowerCase())}"><td><a href="${busRoot(bus.Name)}/details">${escapeHtml(bus.Name)}</a></td><td>${bus.Name === "default" ? "Default" : "Custom"}</td><td>${bus.rules.length}</td><td>${escapeHtml(bus.Description || "–")}</td><td><span class="mono eventbridge-arn">${escapeHtml(bus.Arn)}</span></td></tr>`).join("")}</tbody></table>` : emptyState("E", "No event buses", "The default event bus could not be found in this Region.")}</div></section>${dependencyCards()}</div>`;
  const routingBanner = context.main.querySelector(".alert.info"); if (routingBanner) routingBanner.innerHTML = '<strong>Routing with optional archives</strong><br>Ordinary bus routing is transient. Configure an Archive explicitly when accepted events must be retained independently of rules and targets.';
  context.bindTableFilter();
  bindCreateBus(context);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function eventBridgeOverview(context) {
  const [buses, schedules, groups] = await Promise.all([busCatalog(), allSchedules(), allScheduleGroups()]);
  const rules = buses.flatMap(bus => bus.rules);
  context.setChrome("eventbridge", ["EventBridge"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("EventBridge", "Route custom and scheduled development events to local targets.", '<a class="button" href="#/eventbridge/sandbox">Open Sandbox</a><button class="button primary" data-create-schedule>Create schedule</button>')}<div class="eventbridge-summary"><section class="card"><div class="card-header"><h2>Event buses</h2></div><div class="card-body"><div class="metric">${buses.length}</div><p class="muted">One default bus plus custom buses</p><a href="#/eventbridge/event-buses">View event buses</a></div></section><section class="card"><div class="card-header"><h2>Rules</h2></div><div class="card-body"><div class="metric">${rules.length}</div><p class="muted">${rules.filter(rule => rule.State !== "DISABLED").length} enabled</p><a href="#/eventbridge/rules">View rules</a></div></section><section class="card"><div class="card-header"><h2>Schedules</h2></div><div class="card-body"><div class="metric">${schedules.length}</div><p class="muted">${schedules.filter(schedule => schedule.State !== "DISABLED").length} enabled</p><a href="#/eventbridge/schedules">View schedules</a></div></section></div><section class="card"><div class="card-header"><h2>Development profile</h2></div><div class="card-body"><p>Custom events and legacy scheduled rules fan out to Lambda, SQS, Logs, API Gateway, and Standard Step Functions workflows. The separate Scheduler surface adds one-time, rate, and cron schedules with IANA time zones, durable retries, execution roles, flexible windows, and Standard SQS DLQs.</p><p class="muted">Pipes, API destinations, cross-account event-bus routing, partner sources, and global endpoints are not currently available. Archives and replay are active with installation-owned encryption; customer-managed KMS remains dependency-blocked.</p></div></section></div>`;
  bindCreateSchedule(context, groups, () => "#/eventbridge/schedules");
}

async function describeBus(name) { return events("DescribeEventBus", { Name: name }); }

function bindDeleteBus(context, bus, ruleCount) {
  document.querySelectorAll("[data-delete-event-bus]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(bus.Name, `Delete event bus ${bus.Name}? It must have no rules. This cannot be undone.`, async () => {
    if (bus.Name === "default") throw new Error("The default event bus cannot be deleted");
    if (ruleCount) throw new Error("Remove every rule from this event bus before deleting it");
    await events("DeleteEventBus", { Name: bus.Name });
    context.toast("Event bus deleted");
    location.hash = "#/eventbridge/event-buses";
  })));
}

async function busDetailsPage(context, name) {
  const [bus, rules] = await Promise.all([describeBus(name), listRules(name)]);
  setBusChrome(context, name, "Details");
  const actions = `<button class="button" data-action="refresh">Refresh</button>${name === "default" ? '<button class="button danger" disabled title="The default event bus cannot be deleted">Delete</button>' : '<button class="button danger" data-delete-event-bus>Delete</button>'}`;
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader(name, bus.Arn, actions)}${busTabs(name, "details")}<div class="eventbridge-summary"><section class="card"><div class="card-header"><h2>Bus details</h2></div><div class="card-body"><dl class="key-value"><dt>Type</dt><dd>${name === "default" ? "Default event bus" : "Custom event bus"}</dd><dt>Name</dt><dd>${escapeHtml(bus.Name)}</dd><dt>ARN</dt><dd class="mono">${escapeHtml(bus.Arn)}</dd><dt>Description</dt><dd>${escapeHtml(bus.Description || "–")}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Related rules</h2><a href="${busRoot(name)}/rules">View rules</a></div><div class="card-body"><div class="metric">${rules.length}</div><p class="muted">${rules.filter(rule => rule.State !== "DISABLED").length} enabled · ${rules.filter(rule => rule.State === "DISABLED").length} disabled</p><button class="button primary" data-create-rule>Create rule</button></div></section><section class="card"><div class="card-header"><h2>Event ingestion</h2><a href="#/eventbridge/sandbox">Send events</a></div><div class="card-body"><p><strong>Accepted entries are not retained.</strong></p><p class="muted">Matching fan-out is durable; unmatched events are discarded after evaluation.</p></div></section></div>${dependencyCards()}</div>`;
  const ingestionCard = [...context.main.querySelectorAll("section.card")].find(card => card.querySelector("h2")?.textContent.trim() === "Event ingestion"); if (ingestionCard) ingestionCard.querySelector(".card-body").innerHTML = '<p><strong>Ordinary routing is not retained.</strong></p><p class="muted">Create an explicit archive to retain unmatched or failed-target events for replay.</p><a href="#/eventbridge/archives">View archives</a>';
  bindDeleteBus(context, bus, rules.length);
  bindCreateRule(context, name);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function busRulesPage(context, name) {
  const rules = await listRules(name);
  setBusChrome(context, name, "Rules");
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Rules", `Event-pattern rules on ${escapeHtml(name)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh rules">↻</button><button class="button primary" data-create-rule>Create rule</button>')}${busTabs(name, "rules")}${rulesTable(rules, name)}</div>`;
  context.bindTableFilter();
  bindCreateRule(context, name);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function manageTags(context, resource, kind) {
  const current = tagsToMap(await listTags(resource.Arn));
  context.showModal(`Manage ${kind} tags`, `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(current, null, 2))}</textarea><span class="hint">Removing a key here untags it. Keys and values must be strings.</span></div>`, "Save tags", async data => {
    const next = stringMap(data.get("tags"), "Tags");
    const removed = Object.keys(current).filter(key => !(key in next));
    if (removed.length) await events("UntagResource", { ResourceARN: resource.Arn, TagKeys: removed });
    if (Object.keys(next).length) await events("TagResource", { ResourceARN: resource.Arn, Tags: tagsFromMap(next) });
    context.toast(`${kind} tags updated`);
  });
}

async function busTagsPage(context, name) {
  const bus = await describeBus(name);
  const tags = await listTags(bus.Arn);
  setBusChrome(context, name, "Tags");
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader("Tags", `Key-value metadata for ${escapeHtml(name)}.`, '<button class="button primary" data-manage-tags>Manage tags</button>')}${busTabs(name, "tags")}${tagsCard(tags)}</div>`;
  document.querySelector("[data-manage-tags]")?.addEventListener("click", () => manageTags(context, bus, "event bus").catch(context.showError));
}

async function busMonitoringPage(context, name) {
  const [rules, deliveryState] = await Promise.all([listRules(name), deliveryDiagnostics()]);
  const summaries = await Promise.all(rules.map(async rule => ({ rule, targets: await listTargets(name, rule.Name) })));
  const deliveries = (deliveryState.deliveries ?? []).filter(item => item.eventBusName === name);
  const diagnostics = (deliveryState.diagnostics ?? []).filter(item => item.eventBusName === name);
  setBusChrome(context, name, "Monitoring");
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader("Monitoring", `Rule and delivery visibility for ${escapeHtml(name)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh monitoring">↻</button><a class="button" href="#/cloudwatch/metrics">View EventBridge metrics</a>')}${busTabs(name, "monitoring")}<div class="alert info"><strong>Payload-redacted local diagnostics</strong><br>At most 100 recent terminal/retry summaries are retained. Event payloads are never returned here, and ordinary events cannot be browsed.</div><section class="card"><div class="card-header"><h2>Delivery configuration <span class="muted">(${summaries.length} rules)</span></h2></div><div class="table-wrap">${summaries.length ? `<table class="eventbridge-diagnostic-table"><thead><tr><th>Rule</th><th>State</th><th>Targets</th><th>Delivery contract</th></tr></thead><tbody>${summaries.map(({ rule, targets }) => `<tr><td><a href="${ruleRoot(name, rule.Name)}/monitoring">${escapeHtml(rule.Name)}</a></td><td>${stateMarkup(rule.State)}</td><td>${targets.length}</td><td>At least once · independent retries/DLQ</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No delivery configuration", "Create a rule and target to populate this view.")}</div></section><section class="card"><div class="card-header"><h2>Recent delivery attempts <span class="muted">(${deliveries.length + diagnostics.length})</span></h2></div><div class="table-wrap">${diagnosticTable(deliveries, diagnostics)}</div></section><section class="card"><div class="card-header"><h2>EventBridge metrics</h2><a href="#/cloudwatch/metrics">Open metric explorer</a></div><div class="card-body"><p class="mono">MatchedEvents · TriggeredRules · Invocations · InvocationAttempts · SuccessfulInvocationAttempts · RetryInvocationAttempts · FailedInvocations · InvocationsSentToDlq · InvocationsFailedToBeSentToDlq</p><p class="muted">Service metrics use only documented EventBusName and RuleName dimensions. Target IDs and target counters appear only in bounded simulator diagnostics.</p></div></section></div>`;
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

function tagsCard(tags) {
  return `<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${tags.length})</span></h2></div><div class="table-wrap">${tags.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(tag => `<tr><td>${escapeHtml(tag.Key)}</td><td>${escapeHtml(tag.Value)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No tags", "Add tags to organize and authorize this resource.")}</div></section>`;
}

function rulesTable(rules, fixedBus) {
  return `<section class="card"><div class="card-header"><h2>Rules <span class="muted">(${rules.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find rules"></label></div><div class="table-wrap">${rules.length ? `<table class="eventbridge-rule-table"><thead><tr><th>Name</th>${fixedBus ? "" : "<th>Event bus</th>"}<th>State</th><th>Description</th><th>Pattern</th><th>ARN</th></tr></thead><tbody>${rules.map(rule => { const bus = fixedBus || rule.EventBusName || "default"; return `<tr data-search-row="${escapeHtml(`${rule.Name} ${bus} ${rule.Description || ""}`.toLowerCase())}"><td><a href="${ruleRoot(bus, rule.Name)}/details">${escapeHtml(rule.Name)}</a></td>${fixedBus ? "" : `<td><a href="${busRoot(bus)}/rules">${escapeHtml(bus)}</a></td>`}<td>${stateMarkup(rule.State)}</td><td>${escapeHtml(rule.Description || "–")}</td><td><span class="mono">${rule.EventPattern ? "JSON event pattern" : "–"}</span></td><td><span class="mono eventbridge-arn">${escapeHtml(rule.Arn)}</span></td></tr>`; }).join("")}</tbody></table>` : emptyState("◇", "No rules", "Create an event-pattern rule to route matching events to local targets.", '<button class="button primary" data-create-rule>Create rule</button>')}</div></section>`;
}

async function rulesPage(context) {
  const buses = await listBuses();
  const groups = await Promise.all(buses.map(async bus => (await listRules(bus.Name)).map(rule => ({ ...rule, EventBusName: bus.Name }))));
  const rules = groups.flat();
  context.setChrome("eventbridge", ["EventBridge", "Rules"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Rules", `Event-pattern rules across ${escapeHtml(ui.region)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh rules">↻</button><button class="button primary" data-create-rule>Create rule</button>')}<div class="alert info"><strong>Event-pattern rules</strong><br>Each rule can target up to five Lambda, SQS, Logs, API Gateway, or Standard Step Functions resources independently. Scheduled rules are not currently available on this rules surface; use EventBridge Scheduler for supported schedules.</div>${rulesTable(rules)}</div>`;
  context.bindTableFilter();
  bindCreateRule(context);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

function targetInputFields(target = {}) {
  const mode = target.Input !== undefined ? "input" : target.InputPath !== undefined ? "path" : target.InputTransformer ? "transformer" : "matched";
  return `<div class="field"><label>Target input</label><select name="inputMode"><option value="matched" ${mode === "matched" ? "selected" : ""}>Matched event</option><option value="input" ${mode === "input" ? "selected" : ""}>Constant JSON</option><option value="path" ${mode === "path" ? "selected" : ""}>JSON path</option><option value="transformer" ${mode === "transformer" ? "selected" : ""}>Input transformer</option></select></div><div class="eventbridge-input-fields" data-input-fields="input" ${mode === "input" ? "" : "hidden"}><div class="field"><label>Constant JSON</label><textarea name="input">${escapeHtml(target.Input || "{}")}</textarea></div></div><div class="eventbridge-input-fields" data-input-fields="path" ${mode === "path" ? "" : "hidden"}><div class="field"><label>Input path</label><input name="inputPath" value="${escapeHtml(target.InputPath || "$.detail")}" placeholder="$.detail"></div></div><div class="eventbridge-input-fields" data-input-fields="transformer" ${mode === "transformer" ? "" : "hidden"}><div class="field"><label>Input paths map (JSON object)</label><textarea name="inputPathsMap">${escapeHtml(JSON.stringify(target.InputTransformer?.InputPathsMap ?? { detail: "$.detail" }, null, 2))}</textarea></div><div class="field"><label>Input template</label><textarea name="inputTemplate">${escapeHtml(target.InputTransformer?.InputTemplate || '{"detail":<detail>}')}</textarea><span class="hint">Use &lt;name&gt; placeholders. Transformed Logs targets require exactly a numeric timestamp and string message.</span></div></div><div class="eventbridge-modal-section"><h3>Transformation preview</h3><div class="field"><label>Preview sample event</label><textarea name="targetSampleEvent" class="code-editor">${escapeHtml(defaultSample)}</textarea></div><div class="eventbridge-inline-actions"><button class="button" type="button" data-preview-target-input>Preview target input</button></div><div class="eventbridge-test-result" data-target-input-preview aria-live="polite"></div></div>`;
}

function bindInputMode(root = document) {
  root.querySelectorAll('select[name="inputMode"]').forEach(select => {
    const update = () => root.querySelectorAll("[data-input-fields]").forEach(section => { section.hidden = section.dataset.inputFields !== select.value; });
    select.addEventListener("change", update);
    update();
  });
}

function targetArnFromForm(data) {
  return String(data.get("targetType") === "lambda" ? data.get("functionArn") : data.get("targetArn") || "").trim();
}

function targetFromForm(data, arn = targetArnFromForm(data)) {
  const type = String(data.get("targetType") || "lambda");
  const target = { Id: String(data.get("targetId") || `${type}-target`), Arn: arn, RetryPolicy: { MaximumEventAgeInSeconds: Number(data.get("maximumAge")), MaximumRetryAttempts: Number(data.get("maximumRetries")) } };
  const mode = String(data.get("inputMode"));
  if (mode === "input") target.Input = JSON.stringify(parseJson(data.get("input"), "Constant input"));
  else if (mode === "path") target.InputPath = String(data.get("inputPath"));
  else if (mode === "transformer") target.InputTransformer = { InputPathsMap: stringMap(data.get("inputPathsMap"), "Input paths map"), InputTemplate: String(data.get("inputTemplate")) };
  const roleArn = String(data.get("roleArn") || "").trim();
  if (roleArn) {
    if (type === "logs") throw new Error("CloudWatch Logs targets do not accept Target.RoleArn");
    target.RoleArn = roleArn;
  }
  const deadLetterArn = String(data.get("deadLetterArn") || "").trim();
  if (deadLetterArn) target.DeadLetterConfig = { Arn: deadLetterArn };
  if (type === "sqs") {
    const messageGroupId = String(data.get("messageGroupId") || "").trim();
    if (messageGroupId) target.SqsParameters = { MessageGroupId: messageGroupId };
  }
  if (type === "apigateway") {
    const PathParameterValues = stringList(data.get("pathParameterValues"), "Path parameter values");
    const QueryStringParameters = stringMap(data.get("queryStringParameters"), "Query string parameters");
    const HeaderParameters = stringMap(data.get("headerParameters"), "Header parameters");
    const prohibited = new Set(["authorization", "connection", "content-length", "expect", "host", "range", "transfer-encoding", "user-agent"]);
    const invalid = Object.keys(HeaderParameters).find(name => {
      const lower = name.toLowerCase();
      return prohibited.has(lower) || lower.startsWith("x-amz") || lower.startsWith("x-amzn");
    });
    if (invalid) throw new Error(`Header ${invalid} is managed by EventBridge and cannot be configured`);
    if (PathParameterValues.length || Object.keys(QueryStringParameters).length || Object.keys(HeaderParameters).length) target.HttpParameters = { ...(PathParameterValues.length ? { PathParameterValues } : {}), ...(Object.keys(QueryStringParameters).length ? { QueryStringParameters } : {}), ...(Object.keys(HeaderParameters).length ? { HeaderParameters } : {}) };
  }
  return target;
}

function targetPolicyStatement(type, sourceArn, targetArn) {
  const source = sourceArn || "RULE_ARN";
  const resource = targetArn || ({ lambda: "FUNCTION_ARN", sqs: "QUEUE_ARN", logs: "LOG_GROUP_ARN:*", apigateway: "EXECUTE_API_ARN", states: "STATE_MACHINE_ARN" })[type];
  const actions = type === "sqs" ? "sqs:SendMessage" : type === "logs" ? ["logs:CreateLogStream", "logs:PutLogEvents"] : type === "apigateway" ? "execute-api:Invoke" : type === "states" ? "states:StartExecution" : "lambda:InvokeFunction";
  return { Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: actions, Resource: type === "logs" && targetArn ? `${targetArn}:*` : resource, Condition: { ArnEquals: { "aws:SourceArn": source }, StringEquals: { "aws:SourceAccount": "ACCOUNT_ID" } } };
}

function targetPolicyGuidance(type, sourceArn, targetArn) {
  const source = `<span class="mono">${escapeHtml(sourceArn || "this rule ARN")}</span>`;
  const template = `<details><summary>Resource-policy statement template</summary><pre class="code-box eventbridge-target-preview">${escapeHtml(JSON.stringify(targetPolicyStatement(type, sourceArn, targetArn), null, 2))}</pre></details>`;
  if (type === "sqs") return `<div class="alert warning" data-policy-guidance="sqs"><strong>Queue permission required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to call <span class="mono">sqs:SendMessage</span> with ${source} and this account as source conditions, or supply a trusted execution role. Cross-account queues require both role and queue policy. <a href="#/sqs/queues">Open queues</a>.${template}</div>`;
  if (type === "logs") return `<div class="alert warning" data-policy-guidance="logs"><strong>Logs resource policy required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to call <span class="mono">logs:CreateLogStream</span> and <span class="mono">logs:PutLogEvents</span> for the group, constrained to ${source}. Logs targets do not use a target role. <a href="#/cloudwatch/log-groups">Open log groups</a>.${template}</div>`;
  if (type === "apigateway") return `<div class="alert warning" data-policy-guidance="apigateway"><strong>API authorization required</strong><br>Allow <span class="mono">events.amazonaws.com</span> in the deployed API resource policy for ${source}, or supply an EventBridge execution role with <span class="mono">execute-api:Invoke</span>. <a href="#/apigateway/apis">Open APIs</a>.${template}</div>`;
  if (type === "states") return `<div class="alert warning" data-policy-guidance="states"><strong>Execution role required</strong><br>Supply a role trusted by <span class="mono">events.amazonaws.com</span> with <span class="mono">states:StartExecution</span> on the target state machine. Success is checkpointed only after durable workflow admission. <a href="#/step-functions/state-machines">Open state machines</a>.${template}</div>`;
  return `<div class="alert warning" data-policy-guidance="lambda"><strong>Lambda permission required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to invoke the function with ${source} as <span class="mono">AWS:SourceArn</span>, or supply a trusted execution role with <span class="mono">lambda:InvokeFunction</span>. <a href="#/lambda/functions">Open functions</a>.${template}</div>`;
}

function targetFields(functions, target = {}, required = false, sourceArn) {
  const type = targetType(target);
  const includesTarget = type !== "lambda" || !target.Arn || functions.some(fn => fn.FunctionArn === target.Arn);
  const targetArn = type === "lambda" ? "" : target.Arn || "";
  const typeOptions = [["lambda", "Lambda"], ["sqs", "SQS"], ["logs", "CloudWatch Logs"], ["apigateway", "API Gateway"], ["states", "Step Functions"]];
  return `<div class="field-row"><div class="field"><label>Target type</label><select name="targetType">${typeOptions.map(([value, label]) => `<option value="${value}" ${type === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label>Target ID</label><input name="targetId" value="${escapeHtml(target.Id || `${type}-target`)}" maxlength="64" pattern="[A-Za-z0-9_.-]+" ${target.Id ? "readonly" : ""} required><span class="hint">Remove and re-add a target to change its ID.</span></div></div>
    <div data-target-type-fields="lambda"><div class="field"><label>Lambda function${required ? "" : " (optional)"}</label><select name="functionArn" data-target-required="${required}"><option value="">${required ? "Select a function" : "No target"}</option>${includesTarget ? "" : `<option value="${escapeHtml(target.Arn)}" selected>${escapeHtml(functionNameFromArn(target.Arn))} · version or alias</option>`}${functions.map(fn => `<option value="${escapeHtml(fn.FunctionArn)}" ${fn.FunctionArn === target.Arn ? "selected" : ""}>${escapeHtml(fn.FunctionName)}</option>`).join("")}</select><span class="hint">Functions, published versions, and aliases can also be configured through the SDK.</span></div></div>
    <div data-target-type-fields="sqs" ${type === "sqs" ? "" : "hidden"}><div class="field"><label>Queue ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "sqs" ? targetArn : "")}" placeholder="arn:aws:sqs:${escapeHtml(ui.region)}:000000000000:orders"></div><div class="field"><label>Message group ID</label><input name="messageGroupId" maxlength="100" value="${escapeHtml(target.SqsParameters?.MessageGroupId || "")}" placeholder="tenant-a"><span class="hint">Required for FIFO targets; on Standard queues this enables fair-queue scheduling.</span></div></div>
    <div data-target-type-fields="logs" ${type === "logs" ? "" : "hidden"}><div class="field"><label>Log group ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "logs" ? targetArn : "")}" placeholder="arn:aws:logs:${escapeHtml(ui.region)}:000000000000:log-group:/aws/events/orders"></div><span class="hint">EventBridge creates a stable stream inside an existing log group; it never creates the group.</span></div>
    <div data-target-type-fields="apigateway" ${type === "apigateway" ? "" : "hidden"}><div class="field"><label>Deployed API target ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "apigateway" ? targetArn : "")}" placeholder="arn:aws:execute-api:${escapeHtml(ui.region)}:000000000000:api-id/dev/POST/orders/*"></div><div class="field"><label>Path parameter values (JSON array)</label><textarea name="pathParameterValues">${escapeHtml(JSON.stringify(target.HttpParameters?.PathParameterValues ?? [], null, 2))}</textarea></div><div class="field"><label>Query string parameters (JSON object)</label><textarea name="queryStringParameters">${escapeHtml(JSON.stringify(target.HttpParameters?.QueryStringParameters ?? {}, null, 2))}</textarea></div><div class="field"><label>Header parameters (JSON object)</label><textarea name="headerParameters">${escapeHtml(JSON.stringify(target.HttpParameters?.HeaderParameters ?? {}, null, 2))}</textarea><span class="hint">Values may be static text or supported JSON paths. EventBridge-managed headers such as Host and Authorization are prohibited.</span></div></div>
    <div data-target-type-fields="states" ${type === "states" ? "" : "hidden"}><div class="field"><label>State machine ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "states" ? targetArn : "")}" placeholder="arn:aws:states:${escapeHtml(ui.region)}:000000000000:stateMachine:orders"></div><span class="hint">Standard workflows start through normal durable StartExecution admission.</span></div>
    ${targetInputFields(target)}
    <div class="eventbridge-modal-section"><h3>Authorization and failure handling</h3><div data-role-fields><div class="field"><label>Execution role ARN (optional)</label><input class="mono" name="roleArn" value="${escapeHtml(target.RoleArn || "")}" placeholder="arn:aws:iam::000000000000:role/eventbridge-target"><span class="hint">Saving requires iam:PassRole and trust for events.amazonaws.com.</span></div></div><div class="field"><label>Dead-letter queue ARN (optional)</label><input class="mono" name="deadLetterArn" value="${escapeHtml(target.DeadLetterConfig?.Arn || "")}" placeholder="arn:aws:sqs:${escapeHtml(ui.region)}:000000000000:eventbridge-dlq"><span class="hint">Must be a Standard SQS queue in this Region with an EventBridge queue policy.</span></div><div class="field-row"><div class="field"><label>Maximum event age (seconds)</label><input name="maximumAge" type="number" min="60" max="86400" value="${escapeHtml(target.RetryPolicy?.MaximumEventAgeInSeconds ?? 86400)}" required></div><div class="field"><label>Maximum retry attempts</label><input name="maximumRetries" type="number" min="0" max="185" value="${escapeHtml(target.RetryPolicy?.MaximumRetryAttempts ?? 185)}" required></div></div></div>
    <div data-policy-guidance-container>${targetPolicyGuidance("lambda", sourceArn, type === "lambda" ? target.Arn : undefined)}${targetPolicyGuidance("sqs", sourceArn, type === "sqs" ? target.Arn : undefined)}${targetPolicyGuidance("logs", sourceArn, type === "logs" ? target.Arn : undefined)}${targetPolicyGuidance("apigateway", sourceArn, type === "apigateway" ? target.Arn : undefined)}${targetPolicyGuidance("states", sourceArn, type === "states" ? target.Arn : undefined)}<div class="alert info"><strong>Dead-letter queue policy</strong><br>If configured, the Standard queue must separately allow <span class="mono">events.amazonaws.com</span> to send messages for this rule. DLQ messages contain the original event and delivery error attributes.<details><summary>DLQ policy statement template</summary><pre class="code-box eventbridge-target-preview">${escapeHtml(JSON.stringify(targetPolicyStatement("sqs", sourceArn, target.DeadLetterConfig?.Arn), null, 2))}</pre></details></div></div>`;
}

function bindTargetType(root = document) {
  const select = root.querySelector('select[name="targetType"]');
  if (!select) return;
  const update = () => {
    root.querySelectorAll("[data-target-type-fields]").forEach(section => {
      const active = section.dataset.targetTypeFields === select.value;
      section.hidden = !active;
      section.querySelectorAll("input, textarea, select").forEach(control => {
        control.disabled = !active;
        control.required = active && control.dataset.targetRequired === "true";
      });
    });
    const roleFields = root.querySelector("[data-role-fields]");
    const roleInput = roleFields?.querySelector('input[name="roleArn"]');
    if (roleFields) roleFields.hidden = select.value === "logs";
    if (roleInput) roleInput.disabled = select.value === "logs";
    root.querySelectorAll("[data-policy-guidance]").forEach(guidance => { guidance.hidden = guidance.dataset.policyGuidance !== select.value; });
    if (!root.querySelector('input[name="targetId"]')?.readOnly) {
      const id = root.querySelector('input[name="targetId"]');
      if (id && /^(?:lambda|sqs|logs|apigateway|states)-target$/.test(id.value)) id.value = `${select.value}-target`;
    }
  };
  select.addEventListener("change", update);
  update();
}

function previewJsonPath(value, path) {
  if (path === "$") return value;
  if (!String(path).startsWith("$.")) return undefined;
  const parts = String(path).slice(2).replace(/\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g, (_match, single, double, index) => `.${single ?? double ?? index}`).split(".").filter(Boolean);
  return parts.reduce((current, part) => current === undefined || current === null ? undefined : current[part], value);
}

function placeholderInsideString(template, index) {
  let quoted = false; let escaped = false;
  for (let position = 0; position < index; position++) {
    const character = template[position];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
  }
  return quoted;
}

function previewTargetInput(data) {
  const sample = parseObject(data.get("targetSampleEvent"), "Preview sample event");
  const mode = String(data.get("inputMode"));
  if (mode === "matched") return sample;
  if (mode === "input") return parseJson(data.get("input"), "Constant input");
  if (mode === "path") return previewJsonPath(sample, String(data.get("inputPath")));
  const paths = stringMap(data.get("inputPathsMap"), "Input paths map");
  const values = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, previewJsonPath(sample, path)]));
  values["aws.events.rule-name"] = "preview-rule";
  values["aws.events.rule-arn"] = `arn:aws:events:${ui.region}:000000000000:rule/preview-rule`;
  values["aws.events.event.ingestion-time"] = new Date().toISOString();
  values["aws.events.event"] = Object.fromEntries(Object.entries(sample).filter(([name]) => name !== "detail"));
  values["aws.events.event.json"] = sample;
  const template = String(data.get("inputTemplate"));
  const rendered = template.replace(/<([^>]+)>/g, (placeholder, name, offset) => {
    if (!(name in values) || values[name] === undefined) return "";
    const value = values[name];
    if (!placeholderInsideString(template, offset)) return JSON.stringify(value);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return JSON.stringify(text).slice(1, -1);
  });
  let result;
  try { result = JSON.parse(rendered); } catch { result = rendered; }
  if (data.get("targetType") === "logs" && mode === "transformer") {
    const keys = result && typeof result === "object" && !Array.isArray(result) ? Object.keys(result) : [];
    if (keys.length !== 2 || !keys.includes("timestamp") || !keys.includes("message") || typeof result.timestamp !== "number" || typeof result.message !== "string") throw new Error("A transformed Logs target must produce exactly a numeric timestamp and string message");
  }
  return result;
}

function bindTargetPreview(root = document) {
  const button = root.querySelector("[data-preview-target-input]");
  const output = root.querySelector("[data-target-input-preview]");
  if (!button || !output) return;
  button.addEventListener("click", () => {
    try {
      const form = root.matches?.("form") ? root : root.querySelector("form") ?? root.closest("form");
      if (!form) throw new Error("Target form is unavailable");
      const value = previewTargetInput(new FormData(form));
      output.innerHTML = `<div class="alert success" role="status"><strong>Preview ready</strong><pre class="code-box eventbridge-target-preview">${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre></div>`;
    } catch (error) { output.innerHTML = `<div class="alert error" role="alert"><strong>Preview failed</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`; }
  });
}

function bindTargetModal(root = document) {
  bindInputMode(root);
  bindTargetType(root);
  bindTargetPreview(root);
}

function bindModalPatternTest(context) {
  const dialog = document.querySelector("#modal");
  const button = dialog.querySelector("[data-test-rule-pattern]");
  if (!button) return;
  button.addEventListener("click", async () => {
    const output = dialog.querySelector("[data-rule-test-result]");
    button.disabled = true;
    try {
      const pattern = parseObject(dialog.querySelector('[name="pattern"]').value, "Event pattern");
      const sample = parseObject(dialog.querySelector('[name="sampleEvent"]').value, "Sample event");
      const result = await events("TestEventPattern", { EventPattern: JSON.stringify(pattern), Event: JSON.stringify(sample) });
      output.innerHTML = `<div class="alert ${result.Result ? "success" : "warning"}" role="status"><strong>${result.Result ? "Pattern matches" : "Pattern does not match"}</strong><br>${result.Result ? "This sample would trigger the rule." : "Adjust the pattern or sample and test again."}</div>`;
    } catch (error) { output.innerHTML = `<div class="alert error" role="alert"><strong>Pattern test failed</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`; }
    finally { button.disabled = false; }
  });
}

function bindCreateRule(context, selectedBus) {
  document.querySelectorAll("[data-create-rule]").forEach(button => button.addEventListener("click", async () => {
    try {
      const [buses, functions] = await Promise.all([listBuses(), lambdaFunctions()]);
      context.showModal("Create rule", `<div class="field-row"><div class="field"><label>Event bus</label><select name="bus" required>${buses.map(bus => `<option value="${escapeHtml(bus.Name)}" ${bus.Name === (selectedBus || "default") ? "selected" : ""}>${escapeHtml(bus.Name)}</option>`).join("")}</select></div><div class="field"><label>Rule name</label><input name="name" maxlength="64" pattern="[A-Za-z0-9_.-]+" required placeholder="route-order-events"></div></div><div class="field"><label>Description</label><input name="description" maxlength="512"></div><div class="field"><label>State</label><select name="state"><option value="ENABLED">Enabled</option><option value="DISABLED">Disabled</option></select></div><div class="field"><label>Event pattern (JSON)</label><textarea class="code-editor" name="pattern" required>${escapeHtml(defaultPattern)}</textarea></div><div class="field"><label>Sample event (JSON)</label><textarea name="sampleEvent">${escapeHtml(defaultSample)}</textarea></div><div class="eventbridge-inline-actions"><button class="button" type="button" data-test-rule-pattern>Test pattern</button></div><div class="eventbridge-test-result" data-rule-test-result aria-live="polite"></div><div class="eventbridge-modal-section"><h3>Target (optional)</h3>${targetFields(functions)}</div><div class="eventbridge-modal-section"><h3>Tags</h3><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div></div>`, "Create rule", async data => {
        const bus = String(data.get("bus")); const name = String(data.get("name"));
        const pattern = parseObject(data.get("pattern"), "Event pattern"); const scheduleExpression = String(data.get("scheduleExpression") || "").trim();
        if (scheduleExpression && bus !== "default") throw new Error("Legacy scheduled rules are available only on the default event bus");
        const result = await events("PutRule", { Name: name, EventBusName: bus, Description: String(data.get("description") || ""), State: String(data.get("state")), EventPattern: JSON.stringify(pattern), ...(scheduleExpression ? { ScheduleExpression: scheduleExpression } : {}), Tags: tagsFromMap(stringMap(data.get("tags"), "Tags")) });
        const targetArn = targetArnFromForm(data);
        if (targetArn) {
          try {
            const targetResult = await events("PutTargets", { Rule: name, EventBusName: bus, Targets: [targetFromForm(data, targetArn)] });
            if (targetResult.FailedEntryCount) throw new Error(targetResult.FailedEntries?.[0]?.ErrorMessage || "Target could not be added");
          } catch (error) {
            context.toast(`Rule created without its target: ${error instanceof Error ? error.message : String(error)}`, "error");
            location.hash = `${ruleRoot(bus, name)}/targets`;
            return result;
          }
        }
        context.toast("Rule created");
        location.hash = `${ruleRoot(bus, name)}/details`;
        return result;
      }, true);
      document.querySelector("#modal [name=state]")?.closest(".field")?.insertAdjacentHTML("afterend", '<div class="field"><label>Legacy schedule expression (optional)</label><input class="mono" name="scheduleExpression" placeholder="rate(5 minutes) or cron(0 9 ? * MON-FRI *)"><span class="hint">Default bus only, UTC, one-minute precision. Event patterns and schedules may coexist. Use EventBridge Scheduler for new time-driven work.</span></div>');
      bindTargetModal(document.querySelector("#modal"));
      bindModalPatternTest(context);
    } catch (error) { context.showError(error); }
  }));
}

async function describeRule(bus, name) { return events("DescribeRule", { EventBusName: bus, Name: name }); }

async function testRulePatternModal(context, rule) {
  context.showModal("Test event pattern", `<div class="field"><label>Event pattern (JSON)</label><textarea class="code-editor" name="pattern" required>${escapeHtml(context.prettyJson(rule.EventPattern || "{}"))}</textarea></div><div class="field"><label>Sample event (JSON)</label><textarea class="code-editor" name="event" required>${escapeHtml(defaultSample)}</textarea></div><div class="eventbridge-test-result" data-rule-test-result aria-live="polite"></div>`, "Test pattern", async data => {
    const output = document.querySelector("#modal [data-rule-test-result]");
    try {
      const pattern = parseObject(data.get("pattern"), "Event pattern"); const sample = parseObject(data.get("event"), "Sample event");
      const result = await events("TestEventPattern", { EventPattern: JSON.stringify(pattern), Event: JSON.stringify(sample) });
      output.innerHTML = `<div class="alert ${result.Result ? "success" : "warning"}" role="status"><strong>${result.Result ? "Pattern matches" : "Pattern does not match"}</strong><br>${result.Result ? "This sample would trigger the rule." : "Adjust the pattern or sample and test again."}</div>`;
    } catch (error) {
      output.innerHTML = `<div class="alert error" role="alert"><strong>Pattern test failed</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
    }
  }, true, { closeAfterSubmit: false, refreshAfterSubmit: false });
}

async function editRuleModal(context, bus, rule) {
  context.showModal("Edit rule", `<div class="alert info"><strong>Replacement update</strong><br>Saving replaces the mutable rule configuration. Omitted values are cleared.</div><div class="field"><label>Event bus</label><input value="${escapeHtml(bus)}" disabled></div><div class="field"><label>Rule name</label><input value="${escapeHtml(rule.Name)}" disabled></div><div class="field"><label>Description</label><input name="description" maxlength="512" value="${escapeHtml(rule.Description || "")}"></div><div class="field"><label>State</label><select name="state"><option value="ENABLED" ${rule.State !== "DISABLED" ? "selected" : ""}>Enabled</option><option value="DISABLED" ${rule.State === "DISABLED" ? "selected" : ""}>Disabled</option></select></div><div class="field"><label>Event pattern (JSON)</label><textarea class="code-editor" name="pattern" required>${escapeHtml(context.prettyJson(rule.EventPattern || "{}"))}</textarea></div><div class="field"><label>Sample event (JSON)</label><textarea name="sampleEvent">${escapeHtml(defaultSample)}</textarea></div><div class="eventbridge-inline-actions"><button class="button" type="button" data-test-rule-pattern>Test pattern</button></div><div class="eventbridge-test-result" data-rule-test-result aria-live="polite"></div><p class="muted">Manage tags separately; the API ignores create-time tags when an existing rule is updated.</p>`, "Save rule", async data => {
    const scheduleExpression = String(data.get("scheduleExpression") || "").trim();
    await events("PutRule", { Name: rule.Name, EventBusName: bus, Description: String(data.get("description") || ""), State: String(data.get("state")), EventPattern: JSON.stringify(parseObject(data.get("pattern"), "Event pattern")), ...(scheduleExpression ? { ScheduleExpression: scheduleExpression } : {}) });
    context.toast("Rule updated");
  }, true);
  document.querySelector("#modal [name=state]")?.closest(".field")?.insertAdjacentHTML("afterend", `<div class="field"><label>Legacy schedule expression (optional)</label><input class="mono" name="scheduleExpression" value="${escapeHtml(rule.ScheduleExpression || "")}" placeholder="rate(5 minutes) or cron(0 9 ? * MON-FRI *)"><span class="hint">UTC and default bus only. EventBridge Scheduler is recommended for new schedules.</span></div>`);
  bindModalPatternTest(context);
}

function bindRuleActions(context, bus, rule, targets = []) {
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  document.querySelector("[data-edit-rule]")?.addEventListener("click", () => editRuleModal(context, bus, rule));
  document.querySelectorAll("[data-test-rule]").forEach(button => button.addEventListener("click", () => testRulePatternModal(context, rule)));
  document.querySelector("[data-toggle-rule]")?.addEventListener("click", async () => {
    try { await events(rule.State === "DISABLED" ? "EnableRule" : "DisableRule", { EventBusName: bus, Name: rule.Name }); context.toast(`Rule ${rule.State === "DISABLED" ? "enabled" : "disabled"}`); await context.route(); }
    catch (error) { context.showError(error); }
  });
  document.querySelector("[data-delete-rule]")?.addEventListener("click", () => context.confirmDeletion(rule.Name, `Delete rule ${rule.Name}? Its ${targets.length} target${targets.length === 1 ? "" : "s"} will also be removed.`, async () => {
    if (targets.length) {
      const removed = await events("RemoveTargets", { EventBusName: bus, Rule: rule.Name, Ids: targets.map(target => target.Id) });
      if (removed.FailedEntryCount) throw new Error(removed.FailedEntries?.[0]?.ErrorMessage || "One or more targets could not be removed");
    }
    await events("DeleteRule", { EventBusName: bus, Name: rule.Name });
    context.toast("Rule deleted");
    location.hash = "#/eventbridge/rules";
  }));
}

async function ruleDetailsPage(context, bus, name) {
  const [rule, targets, tags] = await Promise.all([describeRule(bus, name), listTargets(bus, name), describeRule(bus, name).then(item => listTags(item.Arn))]);
  setRuleChrome(context, bus, name, "Details");
  const targetTypes = [...new Set(targets.map(target => targetTypeLabel(targetType(target))))];
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader(name, rule.Arn, '<button class="button" data-action="refresh">Refresh</button><button class="button" data-test-rule>Test pattern</button><button class="button" data-toggle-rule>' + (rule.State === "DISABLED" ? "Enable" : "Disable") + '</button><button class="button" data-edit-rule>Edit</button><button class="button danger" data-delete-rule>Delete</button>')}${ruleTabs(bus, name, "details")}<div class="eventbridge-summary"><section class="card"><div class="card-header"><h2>Rule details</h2></div><div class="card-body"><dl class="key-value"><dt>State</dt><dd>${stateMarkup(rule.State)}</dd><dt>Event bus</dt><dd><a href="${busRoot(bus)}/details">${escapeHtml(bus)}</a></dd><dt>Description</dt><dd>${escapeHtml(rule.Description || "–")}</dd><dt>ARN</dt><dd class="mono">${escapeHtml(rule.Arn)}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Targets</h2><a href="${ruleRoot(bus, name)}/targets">Manage</a></div><div class="card-body"><div class="metric">${targets.length}</div><p class="muted">${targetTypes.length ? escapeHtml(targetTypes.join(" · ")) : "Lambda, SQS, Logs, and API Gateway supported"}</p></div></section><section class="card"><div class="card-header"><h2>Tags</h2><a href="${ruleRoot(bus, name)}/tags">Manage</a></div><div class="card-body"><div class="metric">${tags.length}</div><p class="muted">Resource metadata and authorization conditions</p></div></section></div><section class="card"><div class="card-header"><h2>Event pattern</h2><button class="button" data-test-rule>Test pattern</button></div><div class="card-body"><pre class="code-box eventbridge-json-preview">${escapeHtml(context.prettyJson(rule.EventPattern || "{}"))}</pre></div></section><div class="alert warning"><strong>Target permissions</strong><br>Each target needs either its documented resource-policy grant for <span class="mono">events.amazonaws.com</span> or a supported trusted execution role. Open Targets to see resource-specific guidance, retry settings, and DLQ configuration.</div></div>`;
  if (rule.ScheduleExpression) context.main.querySelector(".eventbridge-summary")?.insertAdjacentHTML("afterend", `<section class="card"><div class="card-header"><h2>Legacy schedule</h2><a href="#/eventbridge/schedules">Use Scheduler for new schedules</a></div><div class="card-body"><p class="mono">${escapeHtml(rule.ScheduleExpression)}</p><p class="muted">Default event bus · UTC · one-minute minimum precision. This rule may also be triggered by its event pattern.</p></div></section>`);
  bindRuleActions(context, bus, rule, targets);
}

async function addTargetModal(context, bus, rule, target) {
  const functions = await lambdaFunctions();
  context.showModal(target ? "Edit target" : "Add target", targetFields(functions, target, true, rule.Arn), target ? "Save target" : "Add target", async data => {
    const arn = targetArnFromForm(data);
    if (!arn) throw new Error("Select or enter a target resource");
    const next = targetFromForm(data, arn);
    const result = await events("PutTargets", { EventBusName: bus, Rule: rule.Name, Targets: [next] });
    if (result.FailedEntryCount) throw new Error(result.FailedEntries?.[0]?.ErrorMessage || "Target could not be saved");
    context.toast(target ? "Target updated" : "Target added");
  }, true);
  bindTargetModal(document.querySelector("#modal"));
}

function targetInputSummary(target) {
  if (target.Input !== undefined) return "Constant JSON";
  if (target.InputPath !== undefined) return `Path ${target.InputPath}`;
  if (target.InputTransformer) return "Input transformer";
  return "Matched event";
}

function targetParameterSummary(target) {
  const details = [targetInputSummary(target)];
  if (target.SqsParameters?.MessageGroupId) details.push(`Group ${target.SqsParameters.MessageGroupId}`);
  if (target.HttpParameters) {
    const paths = target.HttpParameters.PathParameterValues?.length ?? 0;
    const query = Object.keys(target.HttpParameters.QueryStringParameters ?? {}).length;
    const headers = Object.keys(target.HttpParameters.HeaderParameters ?? {}).length;
    details.push(`HTTP: ${paths} path · ${query} query · ${headers} header`);
  }
  return details.map(detail => `<div>${escapeHtml(detail)}</div>`).join("");
}

function targetAuthorizationMarkup(target) {
  if (target.RoleArn) return `<a href="#/iam/roles/${encoded(roleNameFromArn(target.RoleArn))}">${escapeHtml(roleNameFromArn(target.RoleArn))}</a><div class="muted small">Execution role</div>`;
  const type = targetType(target);
  const label = type === "logs" ? "Logs resource policy" : `${targetTypeLabel(type)} resource policy`;
  return `<a href="${targetHref(target)}">${escapeHtml(label)}</a>`;
}

function targetDeadLetterMarkup(target) {
  const arn = target.DeadLetterConfig?.Arn;
  if (!arn) return "–";
  return `<a href="#/sqs/queues/${encoded(queueNameFromArn(arn))}/messages">${escapeHtml(queueNameFromArn(arn))}</a><div class="mono small">${escapeHtml(arn)}</div>`;
}

function targetDiagnosticMarkup(target, bus, rule, deliveryState) {
  const summary = (deliveryState.targets ?? []).find(item => item.eventBusName === bus && item.ruleName === rule && item.targetId === target.Id);
  const records = [...(deliveryState.deliveries ?? []), ...(deliveryState.diagnostics ?? [])]
    .filter(item => item.eventBusName === bus && item.ruleName === rule && item.targetId === target.Id)
    .sort((left, right) => Number(right.updatedAt ?? right.enqueuedAt ?? 0) - Number(left.updatedAt ?? left.enqueuedAt ?? 0));
  const latest = records[0];
  const status = summary?.lastStatus ?? latest?.status;
  if (!status) return '<span class="muted">No attempts</span><div class="muted small">Retries 0 · DLQ 0 sent / 0 failed</div>';
  const statusClass = status === "FAILED" ? "error" : ["RETRYING", "QUEUED", "LEASED"].includes(status) ? "pending" : "";
  const retries = Number(summary?.retries ?? records.filter(item => item.status === "RETRYING").length);
  const dlqSent = Number(summary?.dlqSent ?? records.filter(item => item.deadLetterStatus === "SENT").length);
  const dlqFailed = Number(summary?.dlqFailed ?? records.filter(item => item.deadLetterStatus === "FAILED").length);
  const failure = latest?.errorMessage || latest?.lastError || latest?.errorCode;
  return `<span class="status ${statusClass}">${escapeHtml(status)}</span><div class="muted small">Retries ${retries} · DLQ ${dlqSent} sent / ${dlqFailed} failed</div>${failure ? `<div class="muted small">${escapeHtml(boundedText(failure, 120))}</div>` : ""}`;
}

async function ruleTargetsPage(context, bus, name) {
  const [rule, targets, deliveryState] = await Promise.all([describeRule(bus, name), listTargets(bus, name), deliveryDiagnostics()]);
  setRuleChrome(context, bus, name, "Targets");
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader("Targets", `Independent Lambda, SQS, Logs, and API Gateway deliveries for ${escapeHtml(name)}.`, `<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh targets">↻</button><button class="button primary" data-add-target ${targets.length >= 5 ? "disabled title=\"A rule supports at most five targets\"" : ""}>Add target</button>`)}${ruleTabs(bus, name, "targets")}<div class="alert info"><strong>Independent at-least-once delivery</strong><br>Each target checkpoints, retries, and dead-letters independently. API Gateway 429 and 5xx responses retry; other 4xx responses are terminal. Lambda success means the asynchronous invocation was accepted.</div><section class="card"><div class="card-header"><h2>Targets <span class="muted">(${targets.length} of 5)</span></h2></div><div class="table-wrap">${targets.length ? `<table class="eventbridge-target-table"><thead><tr><th>ID</th><th>Type</th><th>Resource</th><th>Input / parameters</th><th>Authorization</th><th>DLQ</th><th>Last delivery</th><th>Maximum age</th><th>Retries</th><th>Actions</th></tr></thead><tbody>${targets.map((target, index) => `<tr><td>${escapeHtml(target.Id)}</td><td>${escapeHtml(targetTypeLabel(targetType(target)))}</td><td><a href="${targetHref(target)}">${escapeHtml(targetDisplayName(target))}</a><div class="mono small">${escapeHtml(target.Arn)}</div></td><td>${targetParameterSummary(target)}</td><td>${targetAuthorizationMarkup(target)}</td><td>${targetDeadLetterMarkup(target)}</td><td>${targetDiagnosticMarkup(target, bus, name, deliveryState)}</td><td>${target.RetryPolicy?.MaximumEventAgeInSeconds ?? 86400} sec</td><td>${target.RetryPolicy?.MaximumRetryAttempts ?? 185}</td><td class="no-wrap"><button class="button link" data-edit-target="${index}" aria-label="Edit target ${escapeHtml(target.Id)}">Edit</button><button class="button link danger" data-remove-target="${index}" aria-label="Remove target ${escapeHtml(target.Id)}">Remove</button></td></tr>`).join("")}</tbody></table>` : emptyState("↯", "No targets", "Add a local resource to receive matching events.", '<button class="button primary" data-add-target>Add target</button>')}</div></section><div class="alert warning"><strong>Target permission diagnostics</strong><br>Use Edit for the exact rule ARN and target-specific policy guidance. Resource policies and execution roles remain independently enforced; saving a target does not grant delivery access. Standard SQS DLQs need their own EventBridge queue-policy grant.</div></div>`;
  document.querySelectorAll("[data-add-target]").forEach(button => button.addEventListener("click", () => addTargetModal(context, bus, rule).catch(context.showError)));
  document.querySelectorAll("[data-edit-target]").forEach(button => button.addEventListener("click", () => addTargetModal(context, bus, rule, targets[Number(button.dataset.editTarget)]).catch(context.showError)));
  document.querySelectorAll("[data-remove-target]").forEach(button => button.addEventListener("click", () => {
    const target = targets[Number(button.dataset.removeTarget)];
    context.confirmDeletion(target.Id, `Remove target ${target.Id} from ${name}? Pending delivery behavior follows EventBridge retry classification.`, async () => {
      const result = await events("RemoveTargets", { EventBusName: bus, Rule: name, Ids: [target.Id] });
      if (result.FailedEntryCount) throw new Error(result.FailedEntries?.[0]?.ErrorMessage || "Target could not be removed");
      context.toast("Target removed");
    });
  }));
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function ruleTagsPage(context, bus, name) {
  const rule = await describeRule(bus, name); const resourceTags = await listTags(rule.Arn);
  setRuleChrome(context, bus, name, "Tags");
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader("Tags", `Key-value metadata for ${escapeHtml(name)}.`, '<button class="button primary" data-manage-tags>Manage tags</button>')}${ruleTabs(bus, name, "tags")}${tagsCard(resourceTags)}<div class="alert info"><strong>Update behavior</strong><br>Create-time tags apply only when the rule is first created. Use this page for later tag changes.</div></div>`;
  document.querySelector("[data-manage-tags]")?.addEventListener("click", () => manageTags(context, rule, "rule").catch(context.showError));
}

async function ruleMonitoringPage(context, bus, name) {
  const [rule, targets, deliveryState] = await Promise.all([describeRule(bus, name), listTargets(bus, name), deliveryDiagnostics()]);
  const deliveries = (deliveryState.deliveries ?? []).filter(item => item.eventBusName === bus && item.ruleName === name);
  const diagnostics = (deliveryState.diagnostics ?? []).filter(item => item.eventBusName === bus && item.ruleName === name);
  setRuleChrome(context, bus, name, "Monitoring");
  context.main.innerHTML = `<div class="page-width eventbridge-detail">${pageHeader("Monitoring", `Delivery visibility for ${escapeHtml(name)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh monitoring">↻</button><a class="button" href="#/cloudwatch/metrics">View EventBridge metrics</a>')}${ruleTabs(bus, name, "monitoring")}<div class="eventbridge-summary"><section class="card"><div class="card-header"><h2>Rule state</h2></div><div class="card-body">${stateMarkup(rule.State)}<p class="muted">Disabled rules do not match new events.</p></div></section><section class="card"><div class="card-header"><h2>Configured targets</h2></div><div class="card-body"><div class="metric">${targets.length}</div><p class="muted">Up to five independent local targets</p></div></section><section class="card"><div class="card-header"><h2>Delivery state</h2></div><div class="card-body"><div class="metric">${deliveries.length}</div><p class="muted">Queued or leased · ${diagnostics.length} recent terminal/retry summaries</p></div></section></div><section class="card"><div class="card-header"><h2>Bounded local diagnostics <span class="muted">(${deliveries.length + diagnostics.length})</span></h2></div><div class="card-body"><p>At most 100 recent terminal/retry summaries are retained. Event IDs, target IDs, retries, and DLQ outcomes are visible without payloads; failures are never presented as successful invocations.</p></div><div class="table-wrap">${diagnosticTable(deliveries, diagnostics)}</div></section><section class="card"><div class="card-header"><h2>EventBridge metrics</h2><a href="#/cloudwatch/metrics">Open metric explorer</a></div><div class="card-body"><p class="mono">MatchedEvents · TriggeredRules · Invocations · InvocationAttempts · SuccessfulInvocationAttempts · RetryInvocationAttempts · FailedInvocations · InvocationsSentToDlq · InvocationsFailedToBeSentToDlq</p><p class="muted">Select the documented EventBusName and RuleName dimensions in CloudWatch. Target IDs and target counters exist only in bounded simulator diagnostics, never as invented service metric dimensions.</p></div></section></div>`;
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

function sendEntryMarkup(index, buses) {
  return `<article class="eventbridge-entry" data-event-entry><div class="eventbridge-entry-header"><h3>Entry <span data-entry-number>${index + 1}</span></h3><button class="button link danger" type="button" data-remove-event-entry aria-label="Remove entry ${index + 1}" ${index === 0 ? "disabled" : ""}>Remove</button></div><div class="field-row"><div class="field"><label>Event bus</label><select name="eventBus">${buses.map(bus => `<option value="${escapeHtml(bus.Name)}">${escapeHtml(bus.Name)}</option>`).join("")}</select></div><div class="field"><label>Source</label><input name="source" value="example.orders" required maxlength="256"></div></div><div class="field"><label>Detail type</label><input name="detailType" value="Order state changed" required maxlength="128"></div><div class="field"><label>Detail (JSON object)</label><textarea name="detail" required>{
  "state": "created"
}</textarea></div><div class="field"><label>Resources (one ARN per line)</label><textarea name="resources" placeholder="arn:aws:..." rows="2"></textarea></div><div class="field-row"><div class="field"><label>Time (optional)</label><input name="time" type="datetime-local"></div><div class="field"><label>Trace header (optional)</label><input name="traceHeader" maxlength="500" placeholder="Root=1-..."></div></div></article>`;
}

function renumberEntries(root) {
  const entries = [...root.querySelectorAll("[data-event-entry]")];
  entries.forEach((entry, index) => { entry.querySelector("[data-entry-number]").textContent = String(index + 1); const remove = entry.querySelector("[data-remove-event-entry]"); remove.disabled = entries.length === 1; remove.setAttribute("aria-label", `Remove entry ${index + 1}`); });
  root.querySelector("[data-add-event-entry]").disabled = entries.length >= 10;
}

function eventEntryInput(element) {
  const value = name => element.querySelector(`[name="${name}"]`).value;
  const detail = parseObject(value("detail"), "Event detail");
  const time = value("time");
  return { Source: value("source"), DetailType: value("detailType"), Detail: JSON.stringify(detail), EventBusName: value("eventBus"), Resources: value("resources").split(/\r?\n/).map(item => item.trim()).filter(Boolean), ...(time ? { Time: new Date(time).getTime() / 1000 } : {}), ...(value("traceHeader").trim() ? { TraceHeader: value("traceHeader").trim() } : {}) };
}

function sendResults(result) {
  const entries = result.Entries ?? [];
  return `<div class="alert ${result.FailedEntryCount ? "warning" : "success"}" role="status"><strong>${entries.length - (result.FailedEntryCount ?? 0)} accepted · ${result.FailedEntryCount ?? 0} failed</strong><br>Results retain request order. Accepted events are routed and cannot be browsed later.</div><div class="table-wrap"><table><thead><tr><th>Entry</th><th>Status</th><th>Event ID</th><th>Error</th></tr></thead><tbody>${entries.map((entry, index) => `<tr><td>${index + 1}</td><td>${entry.ErrorCode ? '<span class="status error">Failed</span>' : '<span class="status">Accepted</span>'}</td><td class="mono">${escapeHtml(entry.EventId || "–")}</td><td>${escapeHtml(entry.ErrorMessage || entry.ErrorCode || "–")}</td></tr>`).join("")}</tbody></table></div>`;
}

async function sandboxPage(context) {
  const buses = await listBuses();
  context.setChrome("eventbridge", ["EventBridge", "Sandbox"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Sandbox", "Test a JSON event pattern or publish up to ten custom event entries.", '<a class="button" href="#/eventbridge/rules">View rules</a>')}<div class="alert info"><strong>EventBridge is not an event-history browser</strong><br>Only ordered per-entry publish results and generated event IDs are shown. Accepted payloads are evaluated, durably handed off where needed, and not retained for browsing.</div><div class="eventbridge-sandbox-grid"><section class="card"><div class="card-header"><h2>Test event pattern</h2><button class="button primary" type="button" data-test-sandbox-pattern>Test pattern</button></div><div class="card-body"><div class="field"><label>Event pattern (JSON)</label><textarea class="code-editor" name="sandboxPattern">${escapeHtml(defaultPattern)}</textarea></div><div class="field"><label>Sample event (JSON)</label><textarea class="code-editor" name="sandboxEvent">${escapeHtml(defaultSample)}</textarea></div><div class="eventbridge-test-result" data-sandbox-pattern-result aria-live="polite"></div></div></section><section class="card"><div class="card-header"><h2>Send events</h2><div class="actions"><button class="button" type="button" data-add-event-entry>Add entry</button><button class="button primary" type="button" data-send-events>Send events</button></div></div><div class="card-body" data-event-entries>${sendEntryMarkup(0, buses)}</div><div data-send-event-results aria-live="polite"></div></section></div><section class="card"><div class="card-header"><h2>Delivery visibility</h2><a href="#/cloudwatch/metrics">View EventBridge metrics</a></div><div class="card-body"><p>Use rule Monitoring pages for a bounded, payload-redacted target snapshot. CloudWatch contains documented bus/rule metrics; target IDs are never exposed as invented service metric dimensions.</p></div></section></div>`;
  const entryRoot = document.querySelector("[data-event-entries]");
  document.querySelector("[data-add-event-entry]").addEventListener("click", () => {
    const count = entryRoot.querySelectorAll("[data-event-entry]").length;
    if (count >= 10) return;
    entryRoot.insertAdjacentHTML("beforeend", sendEntryMarkup(count, buses));
    associateFormLabels(entryRoot);
    renumberEntries(context.main);
  });
  entryRoot.addEventListener("click", event => {
    const button = event.target.closest?.("[data-remove-event-entry]"); if (!button || button.disabled) return;
    button.closest("[data-event-entry]").remove(); renumberEntries(context.main);
  });
  document.querySelector("[data-test-sandbox-pattern]").addEventListener("click", async event => {
    const button = event.currentTarget; const output = document.querySelector("[data-sandbox-pattern-result]"); button.disabled = true;
    try { const pattern = parseObject(document.querySelector('[name="sandboxPattern"]').value, "Event pattern"); const sample = parseObject(document.querySelector('[name="sandboxEvent"]').value, "Sample event"); const result = await events("TestEventPattern", { EventPattern: JSON.stringify(pattern), Event: JSON.stringify(sample) }); output.innerHTML = `<div class="alert ${result.Result ? "success" : "warning"}" role="status"><strong>${result.Result ? "Pattern matches" : "Pattern does not match"}</strong><br>${result.Result ? "This sample would trigger a rule using this pattern." : "No match; adjust the pattern or sample event."}</div>`; setDirty(false, "page"); }
    catch (error) { output.innerHTML = `<div class="alert error" role="alert"><strong>Pattern test failed</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`; }
    finally { button.disabled = false; }
  });
  document.querySelector("[data-send-events]").addEventListener("click", async event => {
    const button = event.currentTarget; const output = document.querySelector("[data-send-event-results]"); button.disabled = true;
    try { const Entries = [...entryRoot.querySelectorAll("[data-event-entry]")].map(eventEntryInput); const result = await events("PutEvents", { Entries }); output.innerHTML = sendResults(result); setDirty(false, "page"); }
    catch (error) { output.innerHTML = `<div class="card-body"><div class="alert error" role="alert"><strong>Events were not sent</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div></div>`; }
    finally { button.disabled = false; }
  });
}

async function allSchedules(groupName) {
  const items = []; let nextToken;
  do {
    const page = await scheduler("/schedules", { query: { scheduleGroup: groupName, maxResults: 100, nextToken } });
    items.push(...(page.Schedules ?? [])); nextToken = page.NextToken;
  } while (nextToken);
  return items;
}

async function allScheduleGroups() {
  const items = []; let nextToken;
  do {
    const page = await scheduler("/schedule-groups", { query: { maxResults: 100, nextToken } });
    items.push(...(page.ScheduleGroups ?? [])); nextToken = page.NextToken;
  } while (nextToken);
  return items;
}

function scheduleRoot(groupName, name) {
  return `#/eventbridge/schedules/${encoded(groupName)}/${encoded(name)}`;
}

function scheduleDateValue(value) {
  if (value === undefined || value === null || value === "") return "";
  const milliseconds = typeof value === "number" && Math.abs(value) < 100_000_000_000 ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return "";
  const date = new Date(milliseconds); const part = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function scheduleDateLabel(value) {
  if (!value) return "";
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}

function scheduleDateField(name, label, value) {
  const normalized = scheduleDateValue(value); const id = `eventbridge-schedule-${name}`;
  return `<div class="field eventbridge-date-time-field" data-date-time-field><label for="${id}">${escapeHtml(label)}</label><div class="eventbridge-date-input"><input id="${id}" type="text" readonly data-date-display value="${escapeHtml(scheduleDateLabel(normalized))}" placeholder="Choose date and time"><input type="hidden" name="${name}" value="${escapeHtml(normalized)}"><button class="eventbridge-calendar-button" type="button" data-open-date-picker aria-label="Open ${escapeHtml(label.toLowerCase())} calendar" aria-expanded="false">▦</button></div><div class="eventbridge-date-picker" data-date-picker role="group" aria-label="Choose ${escapeHtml(label.toLowerCase())} and time" popover="auto" hidden><div class="eventbridge-date-picker-header"><button type="button" class="button" data-date-previous aria-label="Previous month"><span class="eventbridge-month-arrow previous" aria-hidden="true"></span></button><strong data-date-month></strong><button type="button" class="button" data-date-next aria-label="Next month"><span class="eventbridge-month-arrow next" aria-hidden="true"></span></button></div><div class="eventbridge-date-weekdays" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="eventbridge-date-days" data-date-days></div><div class="eventbridge-date-picker-footer"><label for="${id}-time">Time</label><input id="${id}-time" type="time" data-date-time step="60"><div class="actions"><button type="button" class="button" data-date-clear>Clear</button><button type="button" class="button primary" data-date-apply>Apply</button></div></div></div></div>`;
}

function bindScheduleDatePickers(root = document) {
  const close = field => { const picker = field.querySelector("[data-date-picker]"); if (typeof picker.hidePopover === "function" && picker.matches(":popover-open")) picker.hidePopover(); else picker.hidden = true; field.querySelector("[data-open-date-picker]").setAttribute("aria-expanded", "false"); };
  root.querySelectorAll("[data-date-time-field]").forEach(field => {
    const hidden = field.querySelector('input[type="hidden"]'); const display = field.querySelector("[data-date-display]"); const picker = field.querySelector("[data-date-picker]"); const time = field.querySelector("[data-date-time]");
    hidden.removeAttribute("aria-labelledby"); time.removeAttribute("aria-labelledby"); time.setAttribute("aria-label", "Time");
    const supplied = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/.exec(hidden.value); const now = new Date();
    let year = supplied ? Number(supplied[1]) : now.getFullYear(); let month = supplied ? Number(supplied[2]) - 1 : now.getMonth(); let selected = supplied ? supplied.slice(1, 4).join("-") : "";
    time.value = supplied ? `${supplied[4]}:${supplied[5]}` : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const render = () => {
      field.querySelector("[data-date-month]").textContent = new Date(year, month, 1).toLocaleString([], { month: "long", year: "numeric" });
      const firstOffset = (new Date(year, month, 1).getDay() + 6) % 7; const days = new Date(year, month + 1, 0).getDate(); const cells = Array(firstOffset).fill('<span aria-hidden="true"></span>');
      for (let day = 1; day <= days; day++) { const value = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; cells.push(`<button type="button" data-date-day="${value}" aria-label="${escapeHtml(new Date(year, month, day).toLocaleDateString([], { dateStyle: "long" }))}" ${selected === value ? 'class="selected" aria-pressed="true"' : 'aria-pressed="false"'}>${day}</button>`); }
      field.querySelector("[data-date-days]").innerHTML = cells.join("");
    };
    const isOpen = () => typeof picker.showPopover === "function" ? picker.matches(":popover-open") : !picker.hidden;
    const position = () => { const anchor = field.querySelector(".eventbridge-date-input").getBoundingClientRect(); const width = picker.offsetWidth; const height = picker.offsetHeight; const left = Math.min(Math.max(16, anchor.left), window.innerWidth - width - 16); const below = anchor.bottom + 6; const top = below + height <= window.innerHeight - 16 ? below : Math.max(16, anchor.top - height - 6); picker.style.left = `${left}px`; picker.style.top = `${top}px`; };
    const open = () => { root.querySelectorAll("[data-date-time-field]").forEach(other => { if (other !== field) close(other); }); picker.hidden = false; render(); if (typeof picker.showPopover === "function") picker.showPopover(); position(); field.querySelector("[data-open-date-picker]").setAttribute("aria-expanded", "true"); };
    field.querySelector("[data-open-date-picker]").addEventListener("click", () => isOpen() ? close(field) : open()); display.addEventListener("click", open);
    picker.addEventListener("toggle", event => { if (event.newState === "closed") field.querySelector("[data-open-date-picker]").setAttribute("aria-expanded", "false"); });
    picker.addEventListener("click", event => {
      const button = event.target.closest("button"); if (!button) return;
      if (button.matches("[data-date-previous]")) { month--; if (month < 0) { month = 11; year--; } render(); return; }
      if (button.matches("[data-date-next]")) { month++; if (month > 11) { month = 0; year++; } render(); return; }
      if (button.matches("[data-date-day]")) { selected = button.dataset.dateDay; render(); return; }
      if (button.matches("[data-date-clear]")) { hidden.value = ""; display.value = ""; hidden.dispatchEvent(new Event("change", { bubbles: true })); close(field); return; }
      if (button.matches("[data-date-apply]")) { if (!selected) return; hidden.value = `${selected}T${time.value || "00:00"}`; display.value = scheduleDateLabel(hidden.value); hidden.dispatchEvent(new Event("change", { bubbles: true })); close(field); }
    });
  });
}

function bindScheduleExpressionPicker(root = document) {
  const combobox = root?.querySelector("[data-expression-combobox]");
  if (!combobox) return;
  const input = combobox.querySelector('[name="expression"]'); const toggle = combobox.querySelector("[data-expression-toggle]"); const listbox = combobox.querySelector("[data-expression-options]");
  const close = () => { listbox.hidden = true; toggle.setAttribute("aria-expanded", "false"); input.setAttribute("aria-expanded", "false"); };
  const open = () => {
    listbox.querySelectorAll("[data-expression-value]").forEach(option => option.setAttribute("aria-selected", String(option.dataset.expressionValue === input.value)));
    listbox.hidden = false; toggle.setAttribute("aria-expanded", "true"); input.setAttribute("aria-expanded", "true");
  };
  toggle.addEventListener("click", event => { event.stopPropagation(); listbox.hidden ? open() : close(); });
  listbox.addEventListener("click", event => {
    const option = event.target.closest("[data-expression-value]");
    if (!option) return;
    input.value = option.dataset.expressionValue; input.dispatchEvent(new Event("input", { bubbles: true })); close(); input.focus();
  });
  input.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  root.addEventListener("click", event => { if (!combobox.contains(event.target)) close(); });
}

function scheduleBody(data) {
  const mode = String(data.get("windowMode") || "OFF");
  const input = String(data.get("input") || "");
  const deadLetterArn = String(data.get("deadLetterArn") || "");
  const startDate = String(data.get("startDate") || "");
  const endDate = String(data.get("endDate") || "");
  return {
    GroupName: String(data.get("group")),
    ScheduleExpression: String(data.get("expression")),
    ScheduleExpressionTimezone: String(data.get("timezone") || "UTC"),
    State: String(data.get("state") || "ENABLED"),
    Description: String(data.get("description") || ""),
    ActionAfterCompletion: String(data.get("actionAfterCompletion") || "NONE"),
    FlexibleTimeWindow: mode === "FLEXIBLE" ? { Mode: mode, MaximumWindowInMinutes: Number(data.get("windowMinutes")) } : { Mode: "OFF" },
    ...(startDate ? { StartDate: new Date(startDate).toISOString() } : {}),
    ...(endDate ? { EndDate: new Date(endDate).toISOString() } : {}),
    Target: {
      Arn: String(data.get("targetArn")).trim(),
      RoleArn: String(data.get("roleArn")).trim(),
      ...(input ? { Input: input } : {}),
      RetryPolicy: { MaximumEventAgeInSeconds: Number(data.get("maximumAge") || 86400), MaximumRetryAttempts: Number(data.get("maximumRetries") || 185) },
      ...(deadLetterArn ? { DeadLetterConfig: { Arn: deadLetterArn } } : {}),
    },
  };
}

function scheduleFormMarkup(groups, scheduleItem = {}) {
  const target = scheduleItem.Target ?? {}; const retry = target.RetryPolicy ?? {}; const window = scheduleItem.FlexibleTimeWindow ?? { Mode: "OFF" };
  const rateExamples = [["rate(1 minute)", "Every minute"], ["rate(5 minutes)", "Every 5 minutes"], ["rate(15 minutes)", "Every 15 minutes"], ["rate(30 minutes)", "Every 30 minutes"], ["rate(1 hour)", "Every hour"], ["rate(6 hours)", "Every 6 hours"], ["rate(12 hours)", "Every 12 hours"], ["rate(1 day)", "Every day"]];
  const rateExampleOptions = rateExamples.map(([value, label]) => `<button type="button" role="option" aria-selected="false" data-expression-value="${value}"><span class="mono">${value}</span><span>${label}</span></button>`).join("");
  const targetField = arnComboboxField("Target ARN", {
    name: "targetArn", value: target.Arn || "", required: true,
    placeholder: `arn:aws:lambda:${ui.region}:${ui.summary?.accountId}:function:worker`,
    kinds: ["lambda-function", "sqs-queue", "states-machine", "eventbridge-bus"],
    localExistence: "preferred",
  }, "Create the target resource first, then select it here or enter its ARN.");
  const roleField = arnComboboxField("Scheduler execution role ARN", {
    name: "roleArn", value: target.RoleArn || "", required: true,
    placeholder: `arn:aws:iam::${ui.summary?.accountId}:role/scheduler-runtime`, kinds: ["iam-role"], accountScope: "same",
    servicePrincipal: "scheduler.amazonaws.com", passedToService: "scheduler.amazonaws.com", targetName: "targetArn",
    emptyHelp: "No compatible Scheduler roles found. Create one from IAM Roles using the service role wizard, then return and reopen this list. You can also type or paste a role ARN.",
  });
  const dlqField = arnComboboxField("Standard SQS DLQ ARN (optional)", {
    name: "deadLetterArn", value: target.DeadLetterConfig?.Arn || "", kinds: ["sqs-queue"], subtype: "standard", regionScope: "same",
  }, "The Standard queue must already exist and have the required Scheduler delivery policy.");
  return `<div class="alert info"><strong>EventBridge Scheduler</strong><br>Use <span class="mono">at(...)</span>, <span class="mono">rate(...)</span>, or six-field <span class="mono">cron(...)</span>. IANA time zones follow daylight-saving gaps and overlaps; the next committed run is shown after save.</div><div class="field-row"><div class="field"><label>Schedule group</label><select name="group">${groups.map(group => `<option value="${escapeHtml(group.Name)}" ${group.Name === (scheduleItem.GroupName || "default") ? "selected" : ""}>${escapeHtml(group.Name)}</option>`).join("")}</select></div><div class="field"><label>Name</label><input name="name" required pattern="[A-Za-z0-9_.-]+" maxlength="64" value="${escapeHtml(scheduleItem.Name || "")}" ${scheduleItem.Name ? "disabled" : ""}></div></div><div class="field"><label>Description</label><input name="description" maxlength="512" value="${escapeHtml(scheduleItem.Description || "")}"></div><div class="field"><label for="eventbridge-schedule-expression">Schedule expression</label><div class="eventbridge-expression-combobox" data-expression-combobox><input id="eventbridge-schedule-expression" class="mono" name="expression" required autocomplete="off" role="combobox" aria-autocomplete="none" aria-controls="eventbridge-rate-examples" aria-expanded="false" value="${escapeHtml(scheduleItem.ScheduleExpression || "rate(5 minutes)")}" placeholder="Enter a schedule expression"><button class="eventbridge-expression-toggle" type="button" data-expression-toggle aria-label="Choose a common rate" aria-controls="eventbridge-rate-examples" aria-expanded="false"><span aria-hidden="true"></span></button><div id="eventbridge-rate-examples" class="eventbridge-expression-options" data-expression-options role="listbox" aria-label="Schedule rate examples" hidden>${rateExampleOptions}</div></div><span class="hint">Type a custom expression or use the chevron to choose a common rate.</span></div><div class="field-row"><div class="field"><label>Time zone</label><select name="timezone">${timezoneSelectOptions(scheduleItem.ScheduleExpressionTimezone || "UTC")}</select></div><div class="field"><label>State</label><select name="state"><option value="ENABLED" ${scheduleItem.State !== "DISABLED" ? "selected" : ""}>Enabled</option><option value="DISABLED" ${scheduleItem.State === "DISABLED" ? "selected" : ""}>Disabled</option></select></div></div><div class="field-row eventbridge-schedule-date-range"><div class="field"><label>Start date (optional)</label><input type="datetime-local" name="startDate"></div><div class="field"><label>End date (optional)</label><input type="datetime-local" name="endDate"></div></div><div class="field-row"><div class="field"><label>Flexible time window</label><select name="windowMode"><option value="OFF" ${window.Mode !== "FLEXIBLE" ? "selected" : ""}>Off</option><option value="FLEXIBLE" ${window.Mode === "FLEXIBLE" ? "selected" : ""}>Flexible</option></select></div><div class="field"><label>Maximum window (minutes)</label><input type="number" min="1" max="1440" name="windowMinutes" value="${escapeHtml(window.MaximumWindowInMinutes || 15)}"></div></div>${targetField}${roleField}<div class="field"><label>Target input (JSON or text, optional)</label><textarea class="code-editor" name="input">${escapeHtml(target.Input || "")}</textarea></div><div class="field-row"><div class="field"><label>Maximum event age (seconds)</label><input type="number" min="60" max="86400" name="maximumAge" value="${retry.MaximumEventAgeInSeconds ?? 86400}"></div><div class="field"><label>Maximum retry attempts</label><input type="number" min="0" max="185" name="maximumRetries" value="${retry.MaximumRetryAttempts ?? 185}"></div></div>${dlqField}<div class="field"><label>After one-time completion</label><select name="actionAfterCompletion"><option value="NONE" ${scheduleItem.ActionAfterCompletion !== "DELETE" ? "selected" : ""}>Keep schedule</option><option value="DELETE" ${scheduleItem.ActionAfterCompletion === "DELETE" ? "selected" : ""}>Delete schedule</option></select></div>`;
}

function scheduleForm(groups, scheduleItem = {}) {
  const nativeDateRange = '<div class="field-row eventbridge-schedule-date-range"><div class="field"><label>Start date (optional)</label><input type="datetime-local" name="startDate"></div><div class="field"><label>End date (optional)</label><input type="datetime-local" name="endDate"></div></div>';
  const dateRange = `<div class="field-row eventbridge-schedule-date-range">${scheduleDateField("startDate", "Start date (optional)", scheduleItem.StartDate)}${scheduleDateField("endDate", "End date (optional)", scheduleItem.EndDate)}</div>`;
  queueMicrotask(() => { const modal = document.querySelector("#modal"); bindScheduleDatePickers(modal); bindScheduleExpressionPicker(modal); });
  return scheduleFormMarkup(groups, scheduleItem).replace(nativeDateRange, dateRange);
}

function bindCreateSchedule(context, groups, destination = (body, name) => scheduleRoot(body.GroupName, name)) {
  document.querySelectorAll("[data-create-schedule]").forEach(button => button.addEventListener("click", () => context.showModal("Create schedule", scheduleForm(groups), "Create schedule", async data => {
    const name = String(data.get("name")); const body = scheduleBody(data);
    await scheduler(`/schedules/${encoded(name)}`, { method: "POST", body: { ...body, ClientToken: crypto.randomUUID() } });
    context.toast("Schedule created"); location.hash = destination(body, name);
  }, true, { width: "min(775px, calc(100vw - 40px))" })));
}

async function schedulesPage(context) {
  const [schedules, groups, diagnostics] = await Promise.all([allSchedules(), allScheduleGroups(), rest("/_stacksim/api/eventbridge/schedules")]);
  const diagnosticByArn = new Map((diagnostics.schedules ?? []).map(item => [item.arn, item]));
  context.setChrome("eventbridge", ["EventBridge", "Schedules"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Schedules", `Time-driven invocations in ${escapeHtml(ui.region)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh schedules">↻</button><button class="button primary" data-create-schedule>Create schedule</button>')}<div class="alert info"><strong>Recommended scheduling surface</strong><br>Scheduler supports one-time, rate, and cron expressions, IANA time zones, retries, DLQs, and durable next-run checkpoints.</div><section class="card"><div class="card-header"><h2>Schedules <span class="muted">(${schedules.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find schedules"></label></div><div class="table-wrap">${schedules.length ? `<table><thead><tr><th>Name</th><th>Group</th><th>State</th><th>Target</th><th>Next run</th><th>Last delivery</th></tr></thead><tbody>${schedules.map(item => { const diagnostic = diagnosticByArn.get(item.Arn) ?? {}; return `<tr data-search-row="${escapeHtml(`${item.Name} ${item.GroupName} ${item.Target?.Arn || ""}`.toLowerCase())}"><td><a href="${scheduleRoot(item.GroupName, item.Name)}">${escapeHtml(item.Name)}</a></td><td><a href="#/eventbridge/schedule-groups/${encoded(item.GroupName)}">${escapeHtml(item.GroupName)}</a></td><td>${stateMarkup(item.State)}</td><td class="mono">${escapeHtml(item.Target?.Arn || "")}</td><td>${diagnostic.nextInvocationAt ? formatDate(diagnostic.nextInvocationAt) : "–"}</td><td>${escapeHtml(diagnostic.lastDeliveryStatus || "–")}</td></tr>`; }).join("")}</tbody></table>` : emptyState("◷", "No schedules", "Create a one-time, rate, or cron schedule.", '<button class="button primary" data-create-schedule>Create schedule</button>')}</div></section></div>`;
  context.bindTableFilter(); document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
  bindCreateSchedule(context, groups);
}

async function scheduleDetailPage(context, groupName, name) {
  const [item, groups, diagnostics] = await Promise.all([
    scheduler(`/schedules/${encoded(name)}`, { query: { groupName } }),
    allScheduleGroups(),
    rest("/_stacksim/api/eventbridge/schedules"),
  ]);
  const diagnostic = (diagnostics.schedules ?? []).find(entry => entry.arn === item.Arn) ?? {};
  context.setChrome("eventbridge", ["EventBridge", { label: "Schedules", href: "#/eventbridge/schedules" }, name]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader(name, item.Arn, '<button class="button" data-edit-schedule>Edit</button><button class="button danger" data-delete-schedule>Delete</button>')}<section class="card"><div class="card-header"><h2>Schedule details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Group</dt><dd><a href="#/eventbridge/schedule-groups/${encoded(groupName)}">${escapeHtml(groupName)}</a></dd><dt>State</dt><dd>${stateMarkup(item.State)}</dd><dt>Expression</dt><dd class="mono">${escapeHtml(item.ScheduleExpression)}</dd><dt>Time zone</dt><dd>${escapeHtml(item.ScheduleExpressionTimezone)}</dd></dl><dl class="key-value"><dt>Next invocation</dt><dd>${diagnostic.nextInvocationAt ? formatDate(diagnostic.nextInvocationAt) : "No future run"}</dd><dt>Pending delivery</dt><dd>${escapeHtml(diagnostic.pendingDelivery?.status || "None")}</dd><dt>Last delivery</dt><dd>${escapeHtml(diagnostic.lastDeliveryStatus || "–")}</dd><dt>Last error</dt><dd>${escapeHtml(diagnostic.lastDeliveryError || "–")}</dd></dl><dl class="key-value"><dt>Target</dt><dd>${schedulerTargetMarkup(item.Target?.Arn)}</dd><dt>Execution role</dt><dd><a class="mono" href="#/iam/roles/${encoded(roleNameFromArn(item.Target?.RoleArn))}">${escapeHtml(item.Target?.RoleArn)}</a></dd><dt>Flexible window</dt><dd>${escapeHtml(item.FlexibleTimeWindow?.Mode)}</dd><dt>After completion</dt><dd>${escapeHtml(item.ActionAfterCompletion)}</dd></dl></div></section></div>`;
  document.querySelector("[data-edit-schedule]")?.addEventListener("click", () => context.showModal("Edit schedule", scheduleForm(groups, item), "Save schedule", async data => {
    const body = scheduleBody(data); await scheduler(`/schedules/${encoded(name)}`, { method: "PUT", body: { ...body, GroupName: groupName, ClientToken: crypto.randomUUID() } }); context.toast("Schedule updated");
  }, true, { width: "min(775px, calc(100vw - 40px))" }));
  document.querySelector("[data-delete-schedule]")?.addEventListener("click", () => context.confirmDeletion(name, `Delete schedule ${groupName}/${name}? Future invocations will be cancelled.`, async () => {
    await scheduler(`/schedules/${encoded(name)}`, { method: "DELETE", query: { groupName } }); context.toast("Schedule deleted"); location.hash = "#/eventbridge/schedules";
  }));
}

async function scheduleGroupsPage(context) {
  const groups = await allScheduleGroups(); const schedules = await allSchedules();
  context.setChrome("eventbridge", ["EventBridge", "Schedule groups"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Schedule groups", "Organize Scheduler resources and group-level tags.", '<button class="button primary" data-create-group>Create schedule group</button>')}<section class="card"><div class="card-header"><h2>Schedule groups <span class="muted">(${groups.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>State</th><th>Schedules</th><th>Created</th></tr></thead><tbody>${groups.map(group => `<tr><td><a href="#/eventbridge/schedule-groups/${encoded(group.Name)}">${escapeHtml(group.Name)}</a></td><td><span class="status ${group.State === "DELETING" ? "pending" : ""}">${escapeHtml(group.State)}</span></td><td>${schedules.filter(item => item.GroupName === group.Name).length}</td><td>${formatDate(Number(group.CreationDate) * 1000)}</td></tr>`).join("")}</tbody></table></div></section></div>`;
  document.querySelector("[data-create-group]")?.addEventListener("click", () => context.showModal("Create schedule group", '<div class="field"><label>Name</label><input name="name" required pattern="[A-Za-z0-9_.-]+" maxlength="64"></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>', "Create group", async data => {
    const name = String(data.get("name")); await scheduler(`/schedule-groups/${encoded(name)}`, { method: "POST", body: { ClientToken: crypto.randomUUID(), Tags: tagsFromMap(stringMap(data.get("tags"), "Tags")) } }); context.toast("Schedule group created"); location.hash = `#/eventbridge/schedule-groups/${encoded(name)}`;
  }, true));
}

async function scheduleGroupDetailPage(context, name) {
  const group = await scheduler(`/schedule-groups/${encoded(name)}`);
  const [schedules, tagResult] = await Promise.all([allSchedules(name), scheduler(`/tags/${encoded(group.Arn)}`)]);
  const tagMap = tagsToMap(tagResult.Tags ?? []);
  context.setChrome("eventbridge", ["EventBridge", { label: "Schedule groups", href: "#/eventbridge/schedule-groups" }, name]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader(name, group.Arn, `${name === "default" ? "" : '<button class="button danger" data-delete-group>Delete</button>'}<button class="button" data-edit-group-tags>Manage tags</button>`)}<section class="card"><div class="card-header"><h2>Group details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>State</dt><dd>${escapeHtml(group.State)}</dd><dt>Schedules</dt><dd>${schedules.length}</dd><dt>Created</dt><dd>${formatDate(Number(group.CreationDate) * 1000)}</dd></dl><dl class="key-value"><dt>Tags</dt><dd class="mono">${escapeHtml(JSON.stringify(tagMap))}</dd><dt>Tag scope</dt><dd>Schedule group only</dd></dl></div></section><section class="card"><div class="card-header"><h2>Schedules</h2></div><div class="table-wrap">${schedules.length ? `<table><thead><tr><th>Name</th><th>State</th><th>Target</th></tr></thead><tbody>${schedules.map(item => `<tr><td><a href="${scheduleRoot(name, item.Name)}">${escapeHtml(item.Name)}</a></td><td>${stateMarkup(item.State)}</td><td class="mono">${escapeHtml(item.Target?.Arn)}</td></tr>`).join("")}</tbody></table>` : emptyState("◷", "No schedules", "This group has no schedules.")}</div></section></div>`;
  document.querySelector("[data-edit-group-tags]")?.addEventListener("click", () => context.showModal("Manage schedule-group tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(tagMap, null, 2))}</textarea></div>`, "Save tags", async data => {
    const desired = stringMap(data.get("tags"), "Tags"); const removed = Object.keys(tagMap).filter(key => !(key in desired));
    if (removed.length) await scheduler(`/tags/${encoded(group.Arn)}`, { method: "DELETE", query: { TagKeys: removed } });
    if (Object.keys(desired).length) await scheduler(`/tags/${encoded(group.Arn)}`, { method: "POST", body: { Tags: tagsFromMap(desired) } });
    context.toast("Schedule-group tags updated");
  }, true));
  document.querySelector("[data-delete-group]")?.addEventListener("click", () => context.confirmDeletion(name, `Delete schedule group ${name} and its ${schedules.length} schedules? Future firings will be cancelled.`, async () => {
    await scheduler(`/schedule-groups/${encoded(name)}`, { method: "DELETE" }); context.toast("Schedule group deletion started"); location.hash = "#/eventbridge/schedule-groups";
  }));
}

function archiveRoot(name) { return `#/eventbridge/archives/${encoded(name)}`; }
function replayRoot(name) { return name ? `#/eventbridge/replays/${encoded(name)}` : "#/eventbridge/replays"; }
function localDateTime(value = Date.now()) { const rounded = Math.ceil(value / 60_000) * 60_000; const date = new Date(rounded - new Date(rounded).getTimezoneOffset() * 60_000); return date.toISOString().slice(0, 16); }

async function showCreateArchive(context, selectedBus) {
  const buses = await listBuses(); const source = selectedBus ?? buses[0]?.Name ?? "default";
  context.showModal("Create archive", `<div class="alert info"><strong>Retained local events</strong><br>Capture commits before PutEvents acknowledgement and remains independent of rule matching or target success. Replayed events are excluded.</div><div class="field-row"><div class="field"><label>Name</label><input name="name" required maxlength="48" pattern="[A-Za-z0-9_.-]+"></div><div class="field"><label>Source event bus</label><select name="bus">${buses.map(bus => `<option value="${escapeHtml(bus.Name)}" ${bus.Name === source ? "selected" : ""}>${escapeHtml(bus.Name)}</option>`).join("")}</select></div></div><div class="field"><label>Description</label><textarea name="description" maxlength="512"></textarea></div><div class="field"><label>Event pattern (JSON, optional)</label><textarea name="pattern" class="code-editor" placeholder='${escapeHtml(defaultPattern)}'></textarea><span class="hint">Leave blank to archive every ordinary event on the bus. Use the catalog pattern tester before creating.</span></div><div class="field"><label>Retention days</label><input name="retention" type="number" min="0" step="1" value="0"><span class="hint">0 retains events indefinitely.</span></div><div class="alert info"><strong>Encryption boundary</strong><br>Local segments use installation-owned AES-256 encryption. Customer-managed KMS identifiers remain dependency-blocked and are not presented as active.</div>`, "Create archive", async data => {
    const bus = buses.find(item => item.Name === String(data.get("bus"))); if (!bus) throw new Error("Select an existing source event bus"); const pattern = String(data.get("pattern") || "").trim(); const description = String(data.get("description") || "");
    await events("CreateArchive", { ArchiveName: String(data.get("name")), EventSourceArn: bus.Arn, ...(description ? { Description: description } : {}), ...(pattern ? { EventPattern: JSON.stringify(parseObject(pattern, "Event pattern")) } : {}), RetentionDays: Number(data.get("retention") || 0) }); context.toast("Archive created"); location.hash = archiveRoot(String(data.get("name")));
  });
}

function bindArchivePatternTester(context) {
  const card = context.main.querySelector("[data-archive-pattern-tester]"); if (!card) return;
  card.querySelector("button")?.addEventListener("click", async () => {
    const status = card.querySelector('[role="status"]');
    try { const EventPattern = JSON.stringify(parseObject(card.querySelector('[name="pattern"]')?.value, "Event pattern")); const Event = JSON.stringify(parseObject(card.querySelector('[name="sample"]')?.value, "Sample event")); const result = await events("TestEventPattern", { EventPattern, Event }); status.textContent = result.Result ? "Pattern matches sample" : "Pattern does not match sample"; status.className = `form-status ${result.Result ? "success" : "error"}`; setDirty(false, "page"); }
    catch (error) { status.textContent = error.message; status.className = "form-status error"; }
  });
}

async function archivesPage(context) {
  const archives = await listArchives(); context.setChrome("eventbridge", ["EventBridge", "Archives"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Archives", "Retained event segments for recovery, debugging, and backfill.", '<button class="button refresh" data-action="refresh">↻</button><button class="button primary" data-create-archive>Create archive</button>')}<div class="alert info"><strong>Development-grade local archive behavior</strong><br>Capture is durable and encrypted locally. Counts reconcile on local clock ticks; replay uses deterministic event-time/minute order and does not claim original ingestion order or AWS timing.</div><section class="card"><div class="card-header"><h2>Archives <span class="muted">(${archives.length})</span></h2></div><div class="table-wrap">${archives.length ? `<table><thead><tr><th>Name</th><th>Source bus</th><th>State</th><th>Events</th><th>Size</th><th>Retention</th></tr></thead><tbody>${archives.map(item => `<tr><td><a href="${archiveRoot(item.ArchiveName)}">${escapeHtml(item.ArchiveName)}</a></td><td><a href="${busRoot(nameFromArn(item.EventSourceArn))}/details">${escapeHtml(nameFromArn(item.EventSourceArn))}</a></td><td><span class="status ${item.State === "ENABLED" ? "" : "error"}">${escapeHtml(item.State)}</span></td><td>${Number(item.EventCount ?? 0)}</td><td>${Number(item.SizeBytes ?? 0)} bytes</td><td>${item.RetentionDays ? `${Number(item.RetentionDays)} days` : "Indefinite"}</td></tr>`).join("")}</tbody></table>` : emptyState("◫", "No archives", "Create an archive to retain ordinary events independently of rule success.")}</div></section><section class="card" data-archive-pattern-tester><div class="card-header"><h2>Archive pattern builder and test</h2></div><div class="card-body"><div class="field"><label>Event pattern (JSON)</label><textarea name="pattern" class="code-editor">${escapeHtml(defaultPattern)}</textarea></div><div class="field"><label>Sample event (JSON)</label><textarea name="sample" class="code-editor">${escapeHtml(defaultSample)}</textarea></div><div class="actions"><button class="button">Test pattern</button><span role="status" class="form-status"></span></div></div></section></div>`;
  document.querySelector("[data-create-archive]")?.addEventListener("click", () => showCreateArchive(context)); document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route); bindArchivePatternTester(context);
}

async function archiveDetailPage(context, name) {
  const [archive, replays] = await Promise.all([events("DescribeArchive", { ArchiveName: name }), listReplays()]); const bus = nameFromArn(archive.EventSourceArn); context.setChrome("eventbridge", ["EventBridge", { label: "Archives", href: "#/eventbridge/archives" }, name]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader(name, archive.ArchiveArn, '<button class="button" data-edit-archive>Edit</button><button class="button primary" data-start-replay>Replay</button><button class="button danger" data-delete-archive>Delete</button>')}<div class="alert info"><strong>Local reconciliation</strong><br>Counts include committed, unexpired segments only. Ordering and replay timing are development-grade; no production EventBridge metrics are invented.</div><div class="eventbridge-summary"><section class="card"><div class="card-header"><h2>Archive details</h2></div><div class="card-body"><dl class="key-value"><dt>State</dt><dd><span class="status ${archive.State === "ENABLED" ? "" : "error"}">${escapeHtml(archive.State)}</span></dd><dt>Source bus</dt><dd><a href="${busRoot(bus)}/details">${escapeHtml(bus)}</a></dd><dt>Description</dt><dd>${escapeHtml(archive.Description || "–")}</dd><dt>Retention</dt><dd>${archive.RetentionDays ? `${Number(archive.RetentionDays)} days` : "Indefinite"}</dd><dt>Created</dt><dd>${formatDate(Number(archive.CreationTime) * 1000)}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Truthful local counts</h2></div><div class="card-body"><div class="metric">${Number(archive.EventCount ?? 0)}</div><p class="muted">committed events · ${Number(archive.SizeBytes ?? 0)} logical bytes</p><a href="${replayRoot("")}">View replays</a></div></section></div><section class="card"><div class="card-header"><h2>Event pattern</h2></div><div class="card-body"><pre class="code-box">${escapeHtml(archive.EventPattern || "All ordinary events (replayed events excluded)")}</pre></div></section>${archive.StateReason ? `<div class="alert error"><strong>Archive diagnostic</strong><br>${escapeHtml(archive.StateReason)}</div>` : ""}<section class="card"><div class="card-header"><h2>Related replays <span class="muted">(${replays.filter(item => item.EventSourceArn === archive.ArchiveArn).length})</span></h2></div><div class="table-wrap">${replays.filter(item => item.EventSourceArn === archive.ArchiveArn).length ? `<table><tbody>${replays.filter(item => item.EventSourceArn === archive.ArchiveArn).map(item => `<tr><td><a href="${replayRoot(item.ReplayName)}">${escapeHtml(item.ReplayName)}</a></td><td>${escapeHtml(item.State)}</td></tr>`).join("")}</tbody></table>` : emptyState("↻", "No replays", "Replay a time range after fixing a consumer.")}</div></section></div>`;
  document.querySelector("[data-edit-archive]")?.addEventListener("click", () => context.showModal("Edit archive", `<div class="field"><label>Description</label><textarea name="description" maxlength="512">${escapeHtml(archive.Description || "")}</textarea></div><div class="field"><label>Event pattern (JSON)</label><textarea name="pattern" class="code-editor">${escapeHtml(archive.EventPattern || "{}")}</textarea></div><div class="field"><label>Retention days</label><input name="retention" type="number" min="0" step="1" value="${Number(archive.RetentionDays || 0)}"></div>`, "Save changes", async data => { await events("UpdateArchive", { ArchiveName: name, Description: String(data.get("description") || ""), EventPattern: JSON.stringify(parseObject(data.get("pattern"), "Event pattern")), RetentionDays: Number(data.get("retention") || 0) }); context.toast("Archive updated"); context.route(); }));
  document.querySelector("[data-delete-archive]")?.addEventListener("click", () => context.confirmDeletion(name, `Delete archive ${name} and its ${Number(archive.EventCount ?? 0)} retained events? Active replay references must finish first.`, async () => { await events("DeleteArchive", { ArchiveName: name }); context.toast("Archive deleted"); location.hash = "#/eventbridge/archives"; }));
  document.querySelector("[data-start-replay]")?.addEventListener("click", () => showStartReplay(context, name));
}

async function showStartReplay(context, selectedArchive) {
  const archives = await listArchives(); const chosen = archives.find(item => item.ArchiveName === selectedArchive) ?? archives[0]; if (!chosen) throw new Error("Create an archive before starting a replay"); const archiveBuses = [...new Set(archives.map(item => nameFromArn(item.EventSourceArn)))]; const rules = (await Promise.all(archiveBuses.map(async EventBusName => (await listRules(EventBusName)).map(rule => ({ ...rule, EventBusName }))))).flat(); const now = Date.now();
  context.showModal("Start replay", `<div class="alert info"><strong>Selected-rule replay</strong><br>Events are resent only through the source bus. Replayed envelopes include <span class="mono">replay-name</span> and are never re-archived.</div><div class="field-row"><div class="field"><label>Name</label><input name="name" required maxlength="64" pattern="[A-Za-z0-9_.-]+"></div><div class="field"><label>Archive</label><select name="archive">${archives.map(item => `<option value="${escapeHtml(item.ArchiveName)}" ${item.ArchiveName === chosen.ArchiveName ? "selected" : ""}>${escapeHtml(item.ArchiveName)}</option>`).join("")}</select></div></div><div class="field"><label>Description</label><textarea name="description" maxlength="512"></textarea></div><div class="field-row"><div class="field"><label>Start time</label><input name="start" type="datetime-local" required value="${localDateTime(now - 60 * 60_000)}"></div><div class="field"><label>End time</label><input name="end" type="datetime-local" required value="${localDateTime(now)}"></div></div><fieldset><legend>Destination rules</legend><p class="hint">Leave every rule unchecked to evaluate all enabled rules on the source bus.</p>${rules.map(rule => `<label class="setting-option"><input type="checkbox" name="rules" value="${escapeHtml(rule.Arn)}" ${rule.State === "DISABLED" ? "disabled" : ""}><span><strong>${escapeHtml(rule.Name)}</strong><small>${escapeHtml(rule.State)}</small></span></label>`).join("") || '<p class="muted">No rules currently exist on this source bus.</p>'}</fieldset>`, "Start replay", async data => {
    const archive = archives.find(item => item.ArchiveName === String(data.get("archive"))); if (!archive) throw new Error("Select an existing archive"); const archiveDetail = await events("DescribeArchive", { ArchiveName: archive.ArchiveName }); const selected = data.getAll("rules").map(String); const description = String(data.get("description") || ""); await events("StartReplay", { ReplayName: String(data.get("name")), ...(description ? { Description: description } : {}), EventSourceArn: archiveDetail.ArchiveArn, EventStartTime: new Date(String(data.get("start"))).getTime() / 1000, EventEndTime: new Date(String(data.get("end"))).getTime() / 1000, Destination: { Arn: archive.EventSourceArn, ...(selected.length ? { FilterArns: selected } : {}) } }); context.toast("Replay started"); location.hash = replayRoot(String(data.get("name")));
  });
  const dialog = document.querySelector('[role="dialog"]'); const archiveSelect = dialog?.querySelector('select[name="archive"]');
  const syncRules = () => { const selected = archives.find(item => item.ArchiveName === archiveSelect?.value); const selectedBus = nameFromArn(selected?.EventSourceArn); for (const input of dialog?.querySelectorAll('input[name="rules"]') ?? []) { const rule = rules.find(item => item.Arn === input.value); input.disabled = rule?.State === "DISABLED" || rule?.EventBusName !== selectedBus; const state = input.closest("label")?.querySelector("small"); if (state && rule) state.textContent = `${rule.EventBusName} · ${rule.State}`; } };
  archiveSelect?.addEventListener("change", syncRules); syncRules();
}

async function replaysPage(context) {
  const replays = await listReplays(); context.setChrome("eventbridge", ["EventBridge", "Replays"]);
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader("Replays", "Time-bounded recovery runs from retained archives.", '<button class="button refresh" data-action="refresh">↻</button><button class="button primary" data-start-replay>Start replay</button>')}<div class="alert info"><strong>Development-grade replay progress</strong><br>Progress is the last committed event time, not an invented AWS metric. Events run in deterministic event-time/minute order with at-least-once restart recovery.</div><section class="card"><div class="card-header"><h2>Replays <span class="muted">(${replays.length})</span></h2></div><div class="table-wrap">${replays.length ? `<table><thead><tr><th>Name</th><th>Archive</th><th>State</th><th>Range</th><th>Last replayed</th></tr></thead><tbody>${replays.map(item => `<tr><td><a href="${replayRoot(item.ReplayName)}">${escapeHtml(item.ReplayName)}</a></td><td>${escapeHtml(nameFromArn(item.EventSourceArn))}</td><td><span class="status ${["FAILED", "CANCELLED"].includes(item.State) ? "error" : ["STARTING", "RUNNING", "CANCELLING"].includes(item.State) ? "pending" : ""}">${escapeHtml(item.State)}</span></td><td>${formatDate(Number(item.EventStartTime) * 1000)} – ${formatDate(Number(item.EventEndTime) * 1000)}</td><td>${item.EventLastReplayedTime ? formatDate(Number(item.EventLastReplayedTime) * 1000) : "–"}</td></tr>`).join("")}</tbody></table>` : emptyState("↻", "No replays", "Start a replay after fixing a failed consumer.")}</div></section></div>`;
  document.querySelector("[data-start-replay]")?.addEventListener("click", () => showStartReplay(context)); document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function replayDetailPage(context, name) {
  const replay = await events("DescribeReplay", { ReplayName: name }); const archive = nameFromArn(replay.EventSourceArn); const active = ["STARTING", "RUNNING", "CANCELLING"].includes(replay.State); context.setChrome("eventbridge", ["EventBridge", { label: "Replays", href: "#/eventbridge/replays" }, name]);
  const elapsed = replay.EventLastReplayedTime ? Math.max(0, Number(replay.EventLastReplayedTime) - Number(replay.EventStartTime)) : 0; const range = Math.max(1, Number(replay.EventEndTime) - Number(replay.EventStartTime)); const progress = replay.State === "COMPLETED" ? 100 : Math.min(99, Math.round(elapsed / range * 100));
  context.main.innerHTML = `<div class="page-width eventbridge-page">${pageHeader(name, replay.ReplayArn, `${active ? '<button class="button danger" data-cancel-replay>Cancel replay</button>' : ""}<button class="button" data-action="refresh">Refresh</button>`)}<div class="alert info"><strong>Simulator progress · ${progress}% of event-time range</strong><br>This percentage is a local range indicator derived from the last committed replay time. It is not an AWS replay metric or a delivery-order guarantee.</div><section class="card"><div class="card-header"><h2>Replay details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>State</dt><dd><span class="status ${replay.State === "FAILED" ? "error" : active ? "pending" : ""}">${escapeHtml(replay.State)}</span></dd><dt>Description</dt><dd>${escapeHtml(replay.Description || "–")}</dd><dt>Archive</dt><dd><a href="${archiveRoot(archive)}">${escapeHtml(archive)}</a></dd><dt>Source bus</dt><dd><a href="${busRoot(nameFromArn(replay.Destination?.Arn))}/details">${escapeHtml(nameFromArn(replay.Destination?.Arn))}</a></dd></dl><dl class="key-value"><dt>Start</dt><dd>${formatDate(Number(replay.EventStartTime) * 1000)}</dd><dt>End</dt><dd>${formatDate(Number(replay.EventEndTime) * 1000)}</dd><dt>Last committed event time</dt><dd>${replay.EventLastReplayedTime ? formatDate(Number(replay.EventLastReplayedTime) * 1000) : "–"}</dd><dt>Rules</dt><dd>${replay.Destination?.FilterArns?.length ? replay.Destination.FilterArns.map(arn => `<a class="mono" href="${ruleRoot(nameFromArn(replay.Destination.Arn), nameFromArn(arn))}">${escapeHtml(nameFromArn(arn))}</a>`).join("<br>") : "All enabled matching rules"}</dd></dl></div></section>${replay.StateReason ? `<div class="alert ${replay.State === "FAILED" ? "error" : "info"}"><strong>Replay diagnostic</strong><br>${escapeHtml(replay.StateReason)}</div>` : ""}</div>`;
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route); document.querySelector("[data-cancel-replay]")?.addEventListener("click", async () => { await events("CancelReplay", { ReplayName: name }); context.toast("Replay cancellation requested"); context.route(); });
}

export async function routeEventBridge(parts, context) {
  if (parts[0] !== metadata.key) return false;
  const render = async pending => { const result = await pending; decorateEventBridgePanelHelp(context.main); return result; };
  if (parts.length === 1) return render(eventBridgeOverview(context));
  if (parts[1] === "sandbox" && parts.length === 2) return render(sandboxPage(context));
  if (parts[1] === "archives") {
    if (parts.length === 2) return render(archivesPage(context));
    if (parts.length === 3) return render(archiveDetailPage(context, parts[2]));
    return context.notFound(parts);
  }
  if (parts[1] === "replays") {
    if (parts.length === 2) return render(replaysPage(context));
    if (parts.length === 3) return render(replayDetailPage(context, parts[2]));
    return context.notFound(parts);
  }
  if (parts[1] === "schedules") {
    if (parts.length === 2) return render(schedulesPage(context));
    if (parts.length === 4) return render(scheduleDetailPage(context, parts[2], parts[3]));
    return context.notFound(parts);
  }
  if (parts[1] === "schedule-groups") {
    if (parts.length === 2) return render(scheduleGroupsPage(context));
    if (parts.length === 3) return render(scheduleGroupDetailPage(context, parts[2]));
    return context.notFound(parts);
  }
  if (parts[1] === "event-buses") {
    if (parts.length === 2) return render(eventBusesPage(context));
    if (!parts[2] || parts.length > 4) return context.notFound(parts);
    const name = parts[2]; const section = parts[3] ?? "details";
    if (section === "details") return render(busDetailsPage(context, name));
    if (section === "rules") return render(busRulesPage(context, name));
    if (section === "monitoring") return render(busMonitoringPage(context, name));
    if (section === "tags") return render(busTagsPage(context, name));
    return context.notFound(parts);
  }
  if (parts[1] === "rules") {
    if (parts.length === 2) return render(rulesPage(context));
    if (!parts[2] || !parts[3] || parts.length > 5) return context.notFound(parts);
    const bus = parts[2]; const name = parts[3]; const section = parts[4] ?? "details";
    if (section === "details") return render(ruleDetailsPage(context, bus, name));
    if (section === "targets") return render(ruleTargetsPage(context, bus, name));
    if (section === "monitoring") return render(ruleMonitoringPage(context, bus, name));
    if (section === "tags") return render(ruleTagsPage(context, bus, name));
    return context.notFound(parts);
  }
  return context.notFound(parts);
}
