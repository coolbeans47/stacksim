import { metrics, rest, s3Request, sns, sqs } from "../api-client.js";
import { arnComboboxField, enhanceArnComboboxes } from "../arn-combobox.js";
import { associateFormLabels, confirmationDialog, emptyState, escapeHtml, formatDate, metricChart, pageHeader, tabs } from "../components.js";
import { session as ui, setDirty } from "../state.js";
import { decorateSqsPanelHelp } from "./sqs-help.js";

export const metadata = {
  key: "sqs",
  name: "SQS",
  icon: "Q",
  cls: "sqs",
  links: [["Overview", "#/sqs"], ["Queues", "#/sqs/queues"]],
  search: ["sqs", "queue", "message", "visibility", "dead letter", "dlq", "worker", "fifo", "fair", "deduplication", "message group", "redrive", "sns subscription"],
};

const LIST_HREF = "#/sqs/queues";
const CREATE_HREF = `${LIST_HREF}/create`;
const UNAVAILABLE = "Not available in StackSim";
const NOT_A_DLQ = "Available on a queue that another queue uses as its dead-letter queue";
const inspectLimit = 64 * 1024;
// Seconds a polled message stays hidden after polling ends when no explicit visibility timeout is set.
const CONSOLE_HOLD_SECONDS = 30;
const UNIT_SECONDS = { Seconds: 1, Minutes: 60, Hours: 3_600, Days: 86_400 };
const OWNER_SID = "__owner_statement";
const SENDER_SID = "__sender_statement";
const RECEIVER_SID = "__receiver_statement";
const RECEIVE_ACTIONS = ["SQS:ChangeMessageVisibility", "SQS:DeleteMessage", "SQS:ReceiveMessage"];
const SECTION_ALIASES = { "access-policy": "queue-policies", tags: "tagging", "dead-letter-queue-redrive-tasks": "redrive-tasks" };

let activePoll;
let moveHistoryTimer;
let pollProgressTimer;
let receivedMessages = [];
const pollSettingsByQueue = new Map();

function stopPolling() {
  clearTimeout(moveHistoryTimer); moveHistoryTimer = undefined;
  clearInterval(pollProgressTimer); pollProgressTimer = undefined;
  if (activePoll) activePoll.abort();
  activePoll = undefined;
}

/** Makes messages the console is holding visible again; a message the user deleted or re-timed is skipped. */
function releaseHeldMessages() {
  const held = receivedMessages.filter(entry => entry.autoRelease && entry.heldUntil - Date.now() > 1_500);
  receivedMessages = [];
  return Promise.allSettled(held.map(entry => sqs("ChangeMessageVisibility", { QueueUrl: entry.queueUrl, ReceiptHandle: entry.message.ReceiptHandle, VisibilityTimeout: 0 })));
}

function leavePage() {
  stopPolling();
  void releaseHeldMessages();
}

if (typeof window !== "undefined") window.addEventListener("hashchange", leavePage);

// ---------------------------------------------------------------------------
// Values

function queueNameFromUrl(queueUrl = "") {
  try { return decodeURIComponent(new URL(queueUrl, location.origin).pathname.split("/").filter(Boolean).at(-1) ?? ""); }
  catch { return decodeURIComponent(String(queueUrl).replace(/\/+$/, "").split("/").at(-1) ?? ""); }
}

function queueNameFromArn(arn = "") { return String(arn).split(":").at(-1) ?? ""; }
function functionNameFromArn(arn = "") { return String(arn).split(":function:")[1]?.split(":")[0] ?? String(arn); }
function integer(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function compactText(value, maximum = inspectLimit) { const text = String(value ?? ""); return text.length > maximum ? `${text.slice(0, maximum)}\n… truncated locally after ${maximum.toLocaleString()} characters` : text; }
function queueHref(name, section = "details") { return `${LIST_HREF}/${encodeURIComponent(name)}/${section}`; }
function accountId() { return String(ui.summary?.accountId ?? "000000000000"); }
function splitList(value) { return String(value ?? "").split(/[\s,]+/).map(item => item.trim()).filter(Boolean); }
function plural(count, noun) { return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`; }

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function parsePolicy(value, fallback = {}) {
  if (!value) return fallback;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback; }
  catch { return fallback; }
}

function values(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedJson(value[key])]));
}

function sameJson(left, right) {
  const canonical = text => { try { return text ? JSON.stringify(sortedJson(JSON.parse(text))) : ""; } catch { return String(text ?? ""); } };
  return canonical(left) === canonical(right);
}

/** Whether two RedrivePolicy values name the same dead-letter queue and maximum receives. */
function sameRedrivePolicy(left, right) {
  const key = text => { const policy = parsePolicy(text, null); return policy ? `${policy.deadLetterTargetArn}|${Number(policy.maxReceiveCount)}` : ""; };
  return key(left) === key(right);
}

/** Whether two RedriveAllowPolicy values grant the same permission to the same source queues. */
function sameRedriveAllowPolicy(left, right) {
  const key = text => { const policy = parsePolicy(text, null); return policy ? `${policy.redrivePermission}|${[...(policy.sourceQueueArns ?? [])].sort().join(",")}` : ""; };
  return key(left) === key(right);
}

function base64Utf8(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(String(text))) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Durations and sizes

/** "4 Days", "1 Minute 30 Seconds": the wording the queue pages use for every duration. */
function humanDuration(seconds) {
  let remaining = Math.max(0, Math.round(integer(seconds)));
  if (!remaining) return "0 Seconds";
  const parts = [];
  for (const unit of ["Days", "Hours", "Minutes", "Seconds"]) {
    const count = Math.floor(remaining / UNIT_SECONDS[unit]);
    if (!count) continue;
    parts.push(`${count} ${count === 1 ? unit.slice(0, -1) : unit}`);
    remaining -= count * UNIT_SECONDS[unit];
  }
  return parts.join(" ");
}

function durationText(seconds) {
  const total = Math.max(0, Math.round(integer(seconds)));
  const exact = `${total.toLocaleString()} second${total === 1 ? "" : "s"}`;
  return `<span title="${exact}">${humanDuration(total)}</span>${total >= 60 ? ` <span class="muted small">(${exact})</span>` : ""}`;
}

function humanSize(bytes) {
  const kib = integer(bytes) / 1024;
  return `${Number.isInteger(kib) ? kib : kib.toFixed(2)} KiB`;
}

function sizeText(bytes) {
  const exact = `${integer(bytes).toLocaleString()} bytes`;
  return `<span title="${exact}">${humanSize(bytes)}</span> <span class="muted small">(${exact})</span>`;
}

function byteLength(text) { return new TextEncoder().encode(String(text ?? "")).length; }
function messageSize(bytes) { return bytes < 1024 ? `${bytes} byte${bytes === 1 ? "" : "s"}` : `${(bytes / 1024).toFixed(1)} KiB`; }

/** Splits a stored number of seconds into the largest whole unit the field offers. */
function durationParts(seconds, units) {
  const total = Math.max(0, Math.round(integer(seconds)));
  const unit = total ? [...units].sort((left, right) => UNIT_SECONDS[right] - UNIT_SECONDS[left]).find(candidate => total % UNIT_SECONDS[candidate] === 0) ?? units[0] : units[0];
  return { value: total / UNIT_SECONDS[unit], unit };
}

function durationField({ label, name, seconds, units, hint }) {
  const { value, unit } = durationParts(seconds, units);
  return `<div class="field"><label>${escapeHtml(label)}</label><div class="sqs-duration"><input name="${name}Value" type="number" min="0" step="1" value="${value}" required><select name="${name}Unit" aria-label="${escapeHtml(label)} units">${units.map(option => `<option value="${option}" ${option === unit ? "selected" : ""}>${option}</option>`).join("")}</select></div><span class="hint">${escapeHtml(hint)}</span></div>`;
}

function readDuration(data, name, label, minimum, maximum) {
  const value = Number(data.get(`${name}Value`));
  const size = UNIT_SECONDS[String(data.get(`${name}Unit`))] ?? 1;
  const seconds = Math.round(value * size);
  if (!Number.isFinite(value) || seconds < minimum || seconds > maximum) throw new Error(`${label} should be between ${humanDuration(minimum).toLowerCase()} and ${humanDuration(maximum).toLowerCase()}.`);
  return seconds;
}

// ---------------------------------------------------------------------------
// Queue policies

function policyStatements(document) { return values(document?.Statement).filter(statement => statement && typeof statement === "object" && !Array.isArray(statement)); }

function principalEntries(principal) {
  if (typeof principal === "string") return [{ type: principal === "*" ? "Public" : "AWS", value: principal }];
  if (!principal || Array.isArray(principal) || typeof principal !== "object") return [];
  return Object.entries(principal).flatMap(([type, entries]) => values(entries).map(value => ({ type, value: String(value) })));
}

function principalAccount(value) {
  const text = String(value); if (/^\d{12}$/.test(text)) return text;
  return text.match(/^arn:[a-z0-9-]+:(?:iam|sts)::(\d{12}):/i)?.[1];
}

function policyDiagnostics(document, account) {
  const statements = policyStatements(document);
  const allows = statements.filter(statement => statement.Effect === "Allow");
  const denies = statements.filter(statement => statement.Effect === "Deny");
  const publicAllows = allows.filter(statement => principalEntries(statement.Principal).some(principal => principal.value === "*"));
  const crossAccounts = [...new Set(allows.flatMap(statement => principalEntries(statement.Principal)).map(principal => principal.type === "AWS" ? principalAccount(principal.value) : undefined).filter(value => value && value !== account))];
  return { statements, allows, denies, publicAllows, crossAccounts };
}

function sourceConditionValues(statement, key) {
  const found = [];
  for (const conditions of Object.values(statement?.Condition ?? {})) for (const [candidate, value] of Object.entries(conditions ?? {})) if (candidate.toLowerCase() === key.toLowerCase()) found.push(...values(value).map(String));
  return found;
}

function sourceCondition(statement, key) { return sourceConditionValues(statement, key).join(", ") || "—"; }

/** The statements a queue created with the Basic method carries, followed by any other statement already present. */
function basicPolicyDocument({ queueArn, account, senders, receivers, base }) {
  const principal = entries => entries.length === 1 ? entries[0] : entries;
  return {
    Version: base?.Version ?? "2012-10-17",
    Id: base?.Id ?? "__default_policy_ID",
    Statement: [
      { Sid: OWNER_SID, Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "SQS:*", Resource: queueArn },
      ...(senders.length ? [{ Sid: SENDER_SID, Effect: "Allow", Principal: { AWS: principal(senders) }, Action: "SQS:SendMessage", Resource: queueArn }] : []),
      ...(receivers.length ? [{ Sid: RECEIVER_SID, Effect: "Allow", Principal: { AWS: principal(receivers) }, Action: RECEIVE_ACTIONS, Resource: queueArn }] : []),
      ...basicPolicyModel(base).others,
    ],
  };
}

function basicPolicyModel(document) {
  const statements = policyStatements(document);
  const principals = sid => principalEntries(statements.find(statement => statement.Sid === sid)?.Principal).filter(entry => entry.type === "AWS").map(entry => entry.value);
  return {
    representable: !statements.length || statements.some(statement => statement.Sid === OWNER_SID),
    senders: principals(SENDER_SID),
    receivers: principals(RECEIVER_SID),
    others: statements.filter(statement => ![OWNER_SID, SENDER_SID, RECEIVER_SID].includes(statement.Sid)),
  };
}

function topicSubscriptionSid(topicArn) { return `topic-subscription-${topicArn}`; }

function topicSubscriptionStatement(queueArn, topicArn) {
  return { Sid: topicSubscriptionSid(topicArn), Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } };
}

/** Whether the queue policy lets the topic deliver: an Allow for SendMessage whose source condition, if any, names the topic. */
function policyAllowsTopic(document, topicArn) {
  const pattern = value => new RegExp(`^${String(value).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return policyStatements(document).some(statement => {
    if (statement.Effect !== "Allow" || !statement.Principal) return false;
    const actions = values(statement.Action).map(action => String(action).toLowerCase());
    if (!actions.some(action => action === "*" || action === "sqs:*" || action === "sqs:sendmessage")) return false;
    if (!principalEntries(statement.Principal).some(principal => principal.value === "*" || principal.value === "sns.amazonaws.com")) return false;
    const sources = sourceConditionValues(statement, "aws:SourceArn");
    return !sources.length || sources.some(source => pattern(source).test(topicArn));
  });
}

// ---------------------------------------------------------------------------
// Service calls

async function listQueueUrls(prefix) {
  const urls = [];
  let NextToken;
  do {
    const page = await sqs("ListQueues", { MaxResults: 1_000, ...(prefix ? { QueueNamePrefix: prefix } : {}), ...(NextToken ? { NextToken } : {}) });
    urls.push(...(page.QueueUrls ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return urls;
}

async function queueDescriptor(queueUrl, withTags = false) {
  const [details, tagResult] = await Promise.all([
    sqs("GetQueueAttributes", { QueueUrl: queueUrl, AttributeNames: ["All"] }),
    withTags ? sqs("ListQueueTags", { QueueUrl: queueUrl }) : Promise.resolve({ Tags: {} }),
  ]);
  return { name: queueNameFromUrl(queueUrl), url: queueUrl, attributes: details.Attributes ?? {}, tags: tagResult.Tags ?? {} };
}

async function queueCatalog(withTags = false) {
  const urls = await listQueueUrls();
  return Promise.all(urls.map(url => queueDescriptor(url, withTags)));
}

async function describeQueue(name, withTags = false) {
  const located = await sqs("GetQueueUrl", { QueueName: name });
  return queueDescriptor(located.QueueUrl, withTags);
}

async function deadLetterSourceUrls(queue) {
  const result = await sqs("ListDeadLetterSourceQueues", { QueueUrl: queue.url, MaxResults: 1_000 });
  return result.queueUrls ?? result.QueueUrls ?? [];
}

/** A queue with the queues that name it as their dead-letter queue. */
async function loadQueue(name, withTags = false) {
  const queue = await describeQueue(name, withTags);
  const sourceUrls = await deadLetterSourceUrls(queue);
  return { queue, sourceUrls, isDlq: sourceUrls.length > 0 };
}

function xmlChildren(node, name) { return [...(node?.children ?? [])].filter(item => !name || item.localName === name); }
function snsResult(result) { const root = result.xml?.documentElement; return xmlChildren(root).find(node => /Result$/.test(node.localName)) ?? root; }
function snsMembers(result, container) { return xmlChildren(xmlChildren(snsResult(result), container)[0], "member"); }
function snsText(node, name) { return xmlChildren(node, name)[0]?.textContent ?? ""; }

async function listTopicArns() {
  const arns = [];
  let NextToken;
  do {
    const result = await sns("ListTopics", NextToken ? { NextToken } : {});
    arns.push(...snsMembers(result, "Topics").map(node => snsText(node, "TopicArn")).filter(Boolean));
    NextToken = snsText(snsResult(result), "NextToken") || undefined;
  } while (NextToken);
  return arns.sort();
}

async function listQueueSubscriptions(queueArn) {
  const subscriptions = [];
  let NextToken;
  do {
    const result = await sns("ListSubscriptions", NextToken ? { NextToken } : {});
    subscriptions.push(...snsMembers(result, "Subscriptions").map(node => ({ SubscriptionArn: snsText(node, "SubscriptionArn"), TopicArn: snsText(node, "TopicArn"), Protocol: snsText(node, "Protocol"), Endpoint: snsText(node, "Endpoint") })));
    NextToken = snsText(snsResult(result), "NextToken") || undefined;
  } while (NextToken);
  return subscriptions.filter(subscription => subscription.Protocol === "sqs" && subscription.Endpoint === queueArn);
}

// ---------------------------------------------------------------------------
// Shared markup

/** Dialogs opened from these pages keep sentence-case button labels. */
function openModal(context, ...parameters) {
  context.showModal(...parameters);
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return undefined;
  dialog.classList.add("sqs-dialog");
  dialog.addEventListener("close", () => dialog.classList.remove("sqs-dialog"), { once: true });
  return dialog;
}

function actionsMenu(items, label = "Actions") {
  return `<details class="actions-menu"><summary class="button" aria-haspopup="menu">${escapeHtml(label)} ▾</summary><div class="menu" role="menu">${items.map(([attribute, text]) => `<button type="button" role="menuitem" ${attribute}>${escapeHtml(text)}</button>`).join("")}</div></details>`;
}

function bindMenus(root) {
  root.querySelectorAll(".actions-menu [role=menuitem]").forEach(item => item.addEventListener("click", () => item.closest("details")?.removeAttribute("open")));
}

function radioList(legend, name, options, selected, attributes = "") {
  return `<fieldset class="radio-list" ${attributes}><legend>${escapeHtml(legend)}</legend>${options.map(option => `<label class="radio-label${option.unavailable ? " sqs-unavailable" : ""}"><input type="radio" name="${name}" value="${escapeHtml(option.value)}" ${option.value === selected ? "checked" : ""} ${option.unavailable ? "disabled data-unavailable" : ""}> <span>${escapeHtml(option.label)}${option.description ? `<br><small class="muted">${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}</fieldset>`;
}

function checkedValue(root, name) { return root.querySelector(`input[name="${name}"]:checked`)?.value; }

/** Hides a block and takes its controls out of validation and submission while it is hidden. */
function setSectionEnabled(section, enabled) {
  if (!section) return;
  section.hidden = !enabled;
  section.querySelectorAll("input, select, textarea").forEach(control => { control.disabled = !enabled || control.dataset.unavailable !== undefined; });
}

function queueTabs(queue, active) {
  const tab = (label, section) => ({ label, href: queueHref(queue, section), active: active === section });
  return tabs([
    tab("Details", "details"),
    tab("Send and receive messages", "messages"),
    tab("SNS subscriptions", "sns-subscriptions"),
    tab("Lambda triggers", "lambda-triggers"),
    tab("EventBridge Pipes", "eventbridge-pipes"),
    tab("Dead-letter queue", "dead-letter"),
    tab("Monitoring", "monitoring"),
    tab("Tagging", "tagging"),
    tab("Queue policies", "queue-policies"),
    tab("Encryption", "encryption"),
    tab("Dead-letter queue redrive tasks", "redrive-tasks"),
  ]);
}

function setQueueChrome(context, name, extra) {
  context.setChrome("sqs", ["SQS", "Queues", name, ...(extra ? [extra] : [])]);
}

function startRedriveButton(isDlq, classes = "button") {
  return `<button class="${classes}" type="button" data-start-move ${isDlq ? "" : `disabled title="${NOT_A_DLQ}"`}>Start DLQ redrive</button>`;
}

/** The header every queue tab shares: the queue name with the queue-level actions. */
function queueHeader(queue, isDlq) {
  const actions = `<a class="button" href="${queueHref(queue.name, "edit")}">Edit</a><button class="button" type="button" data-delete-sqs-queue>Delete</button><button class="button" type="button" data-purge-sqs-queue>Purge</button><a class="button" href="${queueHref(queue.name, "messages")}">Send and receive messages</a>${startRedriveButton(isDlq)}`;
  return pageHeader(queue.name, escapeHtml(queue.attributes.QueueArn || queue.url), actions);
}

function bindQueueHeader(context, queue) {
  context.main.querySelectorAll("[data-delete-sqs-queue]").forEach(button => button.addEventListener("click", () => openDeleteDialog(context, queue)));
  context.main.querySelectorAll("[data-purge-sqs-queue]").forEach(button => button.addEventListener("click", () => openPurgeDialog(context, queue)));
  context.main.querySelectorAll("[data-start-move]").forEach(button => button.addEventListener("click", () => openRedriveDialog(context, queue)));
}

function encryptionLabel(attributes) { return attributes.SqsManagedSseEnabled === "true" ? "Amazon SQS key (SSE-SQS)" : attributes.KmsMasterKeyId ? "AWS Key Management Service key (SSE-KMS)" : "Disabled"; }

function redrivePermissionLabel(permission) { return { allowAll: "Allow all", byQueue: "By queue", denyAll: "Deny all" }[permission] ?? permission; }

function redriveAllowSummary(attributes) {
  const allow = parsePolicy(attributes.RedriveAllowPolicy, null);
  if (!allow) return { status: "Disabled", permission: "Allow all", note: "No redrive allow policy is set, so every queue in this account and Region can use this queue as its dead-letter queue.", sources: [] };
  return { status: "Enabled", permission: redrivePermissionLabel(allow.redrivePermission), raw: allow.redrivePermission, note: "", sources: allow.sourceQueueArns ?? [] };
}

function redriveAllowCard(attributes, buttonLabel) {
  const summary = redriveAllowSummary(attributes);
  const sources = summary.sources.length ? summary.sources.map(arn => `<span class="mono">${escapeHtml(arn)}</span>`).join("<br>") : summary.raw === "denyAll" ? "None" : "All queues in this account and Region";
  return `<section class="card"><div class="card-header"><h2>Redrive allow policy</h2><div class="actions"><span class="status ${summary.status === "Enabled" ? "" : "inactive"}">${summary.status}</span><button class="button" type="button" data-configure-redrive-allow>${buttonLabel}</button></div></div><div class="card-body"><dl class="key-value"><dt>Redrive permission</dt><dd><span ${summary.raw ? `title="${escapeHtml(summary.raw)}"` : ""}>${escapeHtml(summary.permission)}</span></dd><dt>Allowed source queues</dt><dd>${sources}</dd></dl>${summary.note ? `<p class="muted">${summary.note}</p>` : ""}</div></section>`;
}

// ---------------------------------------------------------------------------
// Tags

function tagRowMarkup(row = { key: "", value: "" }) {
  return `<div class="sqs-tag-row" data-tag-row><div class="field"><label>Key</label><input data-tag-key maxlength="128" value="${escapeHtml(row.key)}"></div><div class="field"><label>Value</label><input data-tag-value maxlength="256" value="${escapeHtml(row.value)}"></div><button class="button" type="button" data-tag-remove>Remove</button></div>`;
}

function tagEditorMarkup(tags = {}) {
  const rows = Object.entries(tags).map(([key, value]) => ({ key, value }));
  return `<div class="sqs-tags" data-tag-editor><div data-tag-rows>${rows.map(tagRowMarkup).join("")}</div><p class="muted" data-tag-empty ${rows.length ? "hidden" : ""}>No tags associated with the resource.</p><button class="button" type="button" data-tag-add>Add new tag</button><span class="hint">You can add up to 50 tags.</span><details class="sqs-details" data-tag-json><summary>Edit as JSON</summary><div class="field"><label>Tags (JSON object)</label><textarea class="code-editor" data-tag-json-text spellcheck="false">{}</textarea><span class="hint">Applying the JSON replaces the rows above. All values must be strings.</span></div></details></div>`;
}

function tagEditorRows(editor) {
  return [...editor.querySelectorAll("[data-tag-row]")].map(row => ({ key: row.querySelector("[data-tag-key]").value.trim(), value: row.querySelector("[data-tag-value]").value }));
}

function bindTagEditor(root) {
  const editor = root.querySelector("[data-tag-editor]");
  if (!editor) return;
  const rows = editor.querySelector("[data-tag-rows]");
  const json = editor.querySelector("[data-tag-json-text]");
  const scope = root.closest("dialog") || root.matches?.("dialog") ? "modal" : "page";
  const refresh = () => {
    editor.querySelector("[data-tag-empty]").hidden = Boolean(rows.children.length);
    associateFormLabels(editor);
  };
  const bindRow = row => row.querySelector("[data-tag-remove]").addEventListener("click", () => { row.remove(); refresh(); setDirty(true, scope); });
  rows.querySelectorAll("[data-tag-row]").forEach(bindRow);
  editor.querySelector("[data-tag-add]").addEventListener("click", () => {
    rows.insertAdjacentHTML("beforeend", tagRowMarkup());
    bindRow(rows.lastElementChild);
    refresh();
    setDirty(true, scope);
    rows.lastElementChild.querySelector("[data-tag-key]").focus();
  });
  editor.querySelector("[data-tag-json]").addEventListener("toggle", event => {
    if (event.target.open) json.value = JSON.stringify(Object.fromEntries(tagEditorRows(editor).filter(row => row.key).map(row => [row.key, row.value])), null, 2);
  });
  json.addEventListener("change", () => {
    try {
      const value = parseObject(json.value, "Tags");
      rows.innerHTML = Object.entries(value).map(([key, item]) => tagRowMarkup({ key, value: String(item) })).join("");
      rows.querySelectorAll("[data-tag-row]").forEach(bindRow);
      json.setCustomValidity("");
      refresh();
    } catch (error) {
      json.setCustomValidity(error instanceof Error ? error.message : "Tags must be a JSON object");
      json.reportValidity();
    }
  });
  refresh();
}

/** Reads the rows into a tag map, or throws the first problem found. */
function readTagEditor(root) {
  const editor = root.querySelector("[data-tag-editor]");
  if (!editor) return {};
  const json = editor.querySelector("[data-tag-json-text]");
  if (editor.querySelector("[data-tag-json]").open && json.validationMessage) throw new Error(json.validationMessage);
  const tags = {};
  for (const row of tagEditorRows(editor)) {
    if (!row.key && !row.value) continue;
    if (!row.key) throw new Error("Enter a key for every tag.");
    if (row.key in tags) throw new Error(`Tag key ${row.key} is used more than once.`);
    tags[row.key] = row.value;
  }
  return tags;
}

async function saveTags(queue, next) {
  const removed = Object.keys(queue.tags).filter(key => !(key in next));
  const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => queue.tags[key] !== value));
  if (removed.length) await sqs("UntagQueue", { QueueUrl: queue.url, TagKeys: removed });
  if (Object.keys(changed).length) await sqs("TagQueue", { QueueUrl: queue.url, Tags: changed });
}

// ---------------------------------------------------------------------------
// Form sections shared by the create and edit pages and by the tab dialogs

function accessPolicyEditorMarkup() {
  const who = (verb, name) => `${radioList(`Define who can ${verb}`, name, [
    { value: "owner", label: "Only the queue owner", description: `Only the owner of the queue can ${verb}.` },
    { value: "specified", label: "Only the specified AWS accounts, IAM users and roles", description: `Only the specified AWS account IDs, IAM users and roles can ${verb}.` },
  ], "owner")}<div class="field" data-policy-list="${name}" hidden><label>Accounts, users and roles that can ${verb.split(" ")[0]}</label><textarea name="${name}Principals" spellcheck="false" placeholder="111122223333"></textarea><span class="hint">12-digit account IDs or IAM user and role identifiers, separated by commas or new lines.</span></div>`;
  return `<div class="sqs-policy-editor" data-policy-editor>${radioList("Choose method", "policyMode", [
    { value: "basic", label: "Basic", description: "Use simple criteria to define a basic access policy." },
    { value: "advanced", label: "Advanced", description: "Use a JSON object to define an advanced access policy." },
  ], "basic")}<div class="sqs-policy-grid" data-policy-basic><div>${who("send messages to the queue", "policySend")}${who("receive messages from the queue", "policyReceive")}<p class="muted small" data-policy-others hidden></p></div><div class="field"><span class="field-label">JSON (read-only)</span><pre class="code-box" data-policy-preview></pre></div></div><div data-policy-advanced hidden><div class="field"><label>Policy JSON</label><textarea name="policy" class="code-editor" spellcheck="false" style="min-height:320px"></textarea><span class="hint" data-policy-advanced-hint></span></div></div></div>`;
}

/**
 * Wires the Basic and Advanced access policy methods.
 * Basic regenerates the owner, sender and receiver statements and keeps every other statement of the policy.
 */
function bindAccessPolicyEditor(root, { queueArn, policy, mode, emptyHint, blankWhenMissing = false }) {
  const editor = root.querySelector("[data-policy-editor]");
  const advanced = editor.querySelector('[name="policy"]');
  const lists = { policySend: editor.querySelector('[name="policySendPrincipals"]'), policyReceive: editor.querySelector('[name="policyReceivePrincipals"]') };
  const setRadio = (name, value) => editor.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = input.value === value; });
  const chosen = name => checkedValue(editor, name) === "specified" ? splitList(lists[name].value) : [];
  let base = parsePolicy(policy, null);
  let generated = "";
  let touched = false;
  const basicDocument = () => basicPolicyDocument({ queueArn: queueArn(), account: accountId(), senders: chosen("policySend"), receivers: chosen("policyReceive"), base });
  const loadBasic = () => {
    const model = basicPolicyModel(base);
    setRadio("policySend", model.senders.length ? "specified" : "owner"); lists.policySend.value = model.senders.join("\n");
    setRadio("policyReceive", model.receivers.length ? "specified" : "owner"); lists.policyReceive.value = model.receivers.join("\n");
  };
  const sync = () => {
    const basic = checkedValue(editor, "policyMode") === "basic";
    setSectionEnabled(editor.querySelector("[data-policy-basic]"), basic);
    setSectionEnabled(editor.querySelector("[data-policy-advanced]"), !basic);
    for (const name of Object.keys(lists)) setSectionEnabled(editor.querySelector(`[data-policy-list="${name}"]`), basic && checkedValue(editor, name) === "specified");
    const others = basicPolicyModel(base).others.length;
    const note = editor.querySelector("[data-policy-others]");
    note.hidden = !others; note.textContent = others ? `${plural(others, "other statement")} in this policy ${others === 1 ? "is" : "are"} kept. Use Advanced to change ${others === 1 ? "it" : "them"}.` : "";
    editor.querySelector("[data-policy-preview]").textContent = JSON.stringify(basicDocument(), null, 2);
  };
  loadBasic();
  setRadio("policyMode", mode ?? (basicPolicyModel(base).representable && !(blankWhenMissing && !base) ? "basic" : "advanced"));
  advanced.value = base ? JSON.stringify(base, null, 2) : blankWhenMissing ? "" : (generated = JSON.stringify(basicDocument(), null, 2));
  editor.querySelector("[data-policy-advanced-hint]").textContent = emptyHint ?? "";
  editor.querySelectorAll('input[name="policyMode"]').forEach(input => input.addEventListener("change", () => {
    if (input.value === "advanced") advanced.value = generated = JSON.stringify(basicDocument(), null, 2);
    else { const parsed = parsePolicy(advanced.value.trim(), null); if (parsed) { base = parsed; loadBasic(); } }
    sync();
  }));
  editor.addEventListener("input", () => { touched = true; sync(); });
  editor.addEventListener("change", () => { touched = true; sync(); });
  sync();
  return {
    get touched() { return touched; },
    /** Called when the queue ARN changes, so the generated statements follow the new name. */
    refresh() {
      if (advanced.value === generated) advanced.value = generated = JSON.stringify(basicDocument(), null, 2);
      sync();
    },
    /** The policy document as a JSON string; empty when Advanced is left blank. */
    read() {
      if (checkedValue(editor, "policyMode") === "basic") {
        for (const name of Object.keys(lists)) {
          if (checkedValue(editor, name) !== "specified") continue;
          const entries = splitList(lists[name].value);
          if (!entries.length) throw new Error("Enter at least one AWS account ID, IAM user or IAM role.");
          const invalid = entries.find(entry => !/^\d{12}$/.test(entry) && !/^arn:[a-z0-9-]+:iam::\d{12}:(?:root|user\/.+|role\/.+)$/i.test(entry));
          if (invalid) throw new Error(`${invalid} is not a 12-digit account ID or an IAM user or role identifier.`);
        }
        return JSON.stringify(basicDocument());
      }
      const raw = advanced.value.trim();
      return raw ? JSON.stringify(parseObject(raw, "Access policy")) : "";
    },
  };
}

function redriveAllowFieldsMarkup(attributes = {}) {
  const allow = parsePolicy(attributes.RedriveAllowPolicy, null);
  const permission = allow?.redrivePermission ?? "allowAll";
  const option = (value, label) => `<option value="${value}" ${permission === value ? "selected" : ""}>${label}</option>`;
  return `<div data-allow-fields>${radioList("Redrive allow policy", "allowEnabled", [{ value: "false", label: "Disabled" }, { value: "true", label: "Enabled" }], allow ? "true" : "false")}<div class="field"><label>Redrive permission</label><select name="permission">${option("allowAll", "Allow all")}${option("byQueue", "By queue")}${option("denyAll", "Deny all")}</select><span class="hint">Allow all lets every queue in this account and Region use this queue as its dead-letter queue. By queue names up to 10 source queues. Deny all lets no queue use it.</span></div><div class="field" data-allow-sources><label>Allowed source queue ARNs</label><textarea name="sources" placeholder="One queue ARN per line">${escapeHtml((allow?.sourceQueueArns ?? []).join("\n"))}</textarea><span class="hint">Used by By queue only. Specify up to 10 source queues.</span></div></div>`;
}

function bindRedriveAllowFields(root) {
  const fields = root.querySelector("[data-allow-fields]");
  const permission = fields.querySelector('[name="permission"]');
  const sync = () => { fields.querySelector("[data-allow-sources]").hidden = permission.value !== "byQueue"; };
  const enable = () => fields.querySelectorAll('input[name="allowEnabled"]').forEach(input => { input.checked = input.value === "true"; });
  permission.addEventListener("change", () => { enable(); sync(); });
  fields.querySelector("[data-allow-sources]").addEventListener("input", enable);
  sync();
}

/** The RedriveAllowPolicy attribute value; empty when the policy is disabled. */
function readRedriveAllowFields(data) {
  if (data.get("allowEnabled") !== "true") return "";
  const permission = String(data.get("permission"));
  const sourceQueueArns = String(data.get("sources") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (permission === "byQueue" && !sourceQueueArns.length) throw new Error("Enter at least one source queue ARN");
  if (sourceQueueArns.length > 10) throw new Error("Redrive allow policy supports at most ten source queue ARNs");
  return JSON.stringify({ redrivePermission: permission, ...(permission === "byQueue" ? { sourceQueueArns } : {}) });
}

function encryptionFieldsMarkup(attributes = { SqsManagedSseEnabled: "true" }) {
  return `<div data-encryption-fields>${radioList("Server-side encryption", "sse", [{ value: "false", label: "Disabled" }, { value: "true", label: "Enabled" }], attributes.SqsManagedSseEnabled === "false" ? "false" : "true")}${radioList("Encryption key type", "sseKeyType", [
    { value: "sqs", label: "Amazon SQS key (SSE-SQS)", description: "An encryption key that Amazon SQS creates, manages, and uses for you." },
    { value: "kms", label: "AWS Key Management Service key (SSE-KMS)", description: `${UNAVAILABLE}: KMS is not emulated, so a KMS key and its data key reuse period cannot be chosen.`, unavailable: true },
  ], "sqs", "data-sse-key-type")}</div>`;
}

function bindEncryptionFields(root) {
  const fields = root.querySelector("[data-encryption-fields]");
  const sync = () => setSectionEnabled(fields.querySelector("[data-sse-key-type]"), checkedValue(fields, "sse") === "true");
  fields.querySelectorAll('input[name="sse"]').forEach(input => input.addEventListener("change", sync));
  sync();
}

function deadLetterQueueField(fifo, value = "") {
  return arnComboboxField("Choose queue", {
    name: "dlqArn", value, kinds: ["sqs-queue"], subtype: fifo ? "fifo" : "standard", accountScope: "same", regionScope: "same", placeholder: "arn:aws:sqs:…",
    emptyHelp: `No other ${fifo ? "FIFO" : "Standard"} queue exists yet. Create one, or enter a queue ARN.`,
  }, `The Amazon Resource Name (ARN) of an existing ${fifo ? "FIFO" : "Standard"} queue. A dead-letter queue must be the same type as its source queue.`);
}

function deadLetterFieldsMarkup(attributes = {}, fifo = false) {
  const redrive = parsePolicy(attributes.RedrivePolicy);
  return `<div data-dlq-fields>${radioList("Set this queue to receive undeliverable messages", "dlqEnabled", [{ value: "false", label: "Disabled" }, { value: "true", label: "Enabled" }], redrive.deadLetterTargetArn ? "true" : "false")}<div data-dlq-settings><h3>Dead-letter queue settings</h3><div data-dlq-queue>${deadLetterQueueField(fifo, redrive.deadLetterTargetArn ?? "")}</div><div class="field"><label>Maximum receives</label><input name="dlqMaximum" type="number" min="1" max="1000" step="1" value="${escapeHtml(redrive.maxReceiveCount || "10")}" required><span class="hint">Should be between 1 and 1000. A message moves to the dead-letter queue after it has been received more than this many times.</span></div></div></div>`;
}

function bindDeadLetterFields(root) {
  const fields = root.querySelector("[data-dlq-fields]");
  const sync = () => setSectionEnabled(fields.querySelector("[data-dlq-settings]"), checkedValue(fields, "dlqEnabled") === "true");
  fields.querySelectorAll('input[name="dlqEnabled"]').forEach(input => input.addEventListener("change", sync));
  sync();
  return {
    sync,
    /** Rebuilds the queue picker when the queue type changes, because the dead-letter queue must match it. */
    setType(fifo) {
      const holder = fields.querySelector("[data-dlq-queue]");
      holder.innerHTML = deadLetterQueueField(fifo);
      enhanceArnComboboxes(holder);
      sync();
    },
  };
}

/** The RedrivePolicy attribute value; empty when the dead-letter queue is disabled. */
function readDeadLetterFields(data) {
  if (data.get("dlqEnabled") !== "true") return "";
  const target = String(data.get("dlqArn") || "").trim();
  if (!target) throw new Error("Choose a dead-letter queue.");
  const maximum = Number(data.get("dlqMaximum"));
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000) throw new Error("Maximum receives should be between 1 and 1000.");
  return JSON.stringify({ deadLetterTargetArn: target, maxReceiveCount: String(maximum) });
}

// ---------------------------------------------------------------------------
// Queue dialogs

function openDeleteDialog(context, queue) {
  openModal(context, "Delete queue", `${confirmationDialog("delete", `Are you sure you want to delete ${queue.name} permanently? You can't undo this action.`)}<p class="muted">The queue's messages are deleted with it. Lambda triggers that poll this queue are not removed, and queues that use it as their dead-letter queue keep their redrive policy.</p>`, "Delete", async data => {
    if (data.get("confirmation") !== "delete") throw new Error("Enter delete to confirm");
    await sqs("DeleteQueue", { QueueUrl: queue.url });
    pollSettingsByQueue.delete(queue.url);
    context.toast(`Queue ${queue.name} deleted`);
    if (location.hash !== LIST_HREF) location.hash = LIST_HREF;
  }, false, { danger: true });
}

function openPurgeDialog(context, queue) {
  openModal(context, "Purge queue", `${confirmationDialog("purge", `Are you sure you want to purge ${queue.name}? Every visible, delayed, and in-flight message is deleted. You can't undo this action.`, { prompt: "To confirm the purge, enter" })}<div class="alert warning"><strong>Purge cooldown</strong><br>A queue cannot be purged again until 60 seconds have passed.</div>`, "Purge", async data => {
    if (data.get("confirmation") !== "purge") throw new Error("Enter purge to confirm");
    await sqs("PurgeQueue", { QueueUrl: queue.url });
    context.toast(`Queue ${queue.name} purged`);
  }, false, { danger: true });
}

async function openSubscribeDialog(context, queue) {
  const queueArn = queue.attributes.QueueArn;
  const topics = await listTopicArns();
  const dialog = openModal(context, "Subscribe to Amazon SNS topic", `<p>Messages published to the topic are delivered to <span class="mono">${escapeHtml(queue.name)}</span>. Saving creates the subscription and adds a statement to the queue's access policy that lets the topic send messages.</p><div class="field"><label>Specify an Amazon SNS topic available for this queue</label><select name="topic" data-arn-exclude>${topics.map(arn => `<option value="${escapeHtml(arn)}">${escapeHtml(arn)}</option>`).join("")}<option value="">Enter Amazon SNS topic ARN</option></select>${topics.length ? "" : '<span class="hint">No topic exists in this Region yet. <a href="#/sns/topics">Open SNS topics</a> to create one, or enter a topic ARN.</span>'}</div><div class="field" data-topic-arn><label>Amazon SNS topic ARN</label><input name="topicArn" class="mono" placeholder="arn:aws:sns:${escapeHtml(ui.region)}:${escapeHtml(accountId())}:orders"></div><p class="muted small">A queue access policy can hold up to 20 statements. Each subscription adds one.</p>`, "Save", async data => {
    const topicArn = String(data.get("topic") || data.get("topicArn") || "").trim();
    if (!/^arn:[a-z0-9-]+:sns:[^:]+:\d{12}:.+$/i.test(topicArn)) throw new Error("Choose a topic or enter an Amazon SNS topic ARN.");
    await sns("Subscribe", { TopicArn: topicArn, Protocol: "sqs", Endpoint: queueArn, ReturnSubscriptionArn: true });
    const current = parsePolicy((await sqs("GetQueueAttributes", { QueueUrl: queue.url, AttributeNames: ["All"] })).Attributes?.Policy, null);
    const sid = topicSubscriptionSid(topicArn);
    const document = { Version: current?.Version ?? "2012-10-17", ...(current?.Id ? { Id: current.Id } : {}), Statement: [...policyStatements(current).filter(statement => statement.Sid !== sid), topicSubscriptionStatement(queueArn, topicArn)] };
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { Policy: JSON.stringify(document) } });
    context.toast(`Subscribed to ${queueNameFromArn(topicArn)}`);
    const destination = queueHref(queue.name, "sns-subscriptions");
    if (location.hash !== destination) location.hash = destination;
  });
  const select = dialog.querySelector('[name="topic"]');
  const sync = () => setSectionEnabled(dialog.querySelector("[data-topic-arn]"), !select.value);
  select.addEventListener("change", sync);
  sync();
}

async function openTriggerDialog(context, queue) {
  const queueArn = queue.attributes.QueueArn; const fifo = queue.attributes.FifoQueue === "true";
  const functions = (await rest("/2015-03-31/functions")).Functions ?? [];
  if (!functions.length) return openModal(context, "Configure Lambda function trigger", '<div class="alert warning"><strong>No Lambda functions</strong><br>Create a function and execution role before attaching this queue.</div><p><a href="#/lambda/functions">Open Lambda functions</a></p>', "Close", async () => undefined, false, { refreshAfterSubmit: false });
  return openModal(context, "Configure Lambda function trigger", `<div class="field"><label>Lambda function</label><select name="function" required>${functions.map(fn => `<option value="${escapeHtml(fn.FunctionArn)}">${escapeHtml(fn.FunctionName)} · ${escapeHtml(fn.Role || "execution role")}</option>`).join("")}</select><span class="hint">Choose an existing function or enter the Amazon Resource Name (ARN) of a function.</span></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" checked> Enable trigger</label></div><div class="field-row"><div class="field"><label>Batch size</label><input name="batchSize" type="number" min="1" max="${fifo ? 10 : 10000}" value="10" required></div><div class="field"><label>Batching window (seconds)</label><input name="batchWindow" type="number" min="0" max="${fifo ? 0 : 300}" value="0" ${fifo ? "readonly" : ""} required></div></div><div class="field-row"><div class="field"><label>Maximum concurrency (optional)</label><input name="maximumConcurrency" type="number" min="2" max="1000" placeholder="Unbounded"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="partial" value="yes"> Report partial batch item failures</label></div></div><div class="field"><label>Filter pattern (optional JSON)</label><textarea name="filter" placeholder='{"body":{"job":["ready"]}}'></textarea></div><div class="alert warning"><strong>Execution-role permissions</strong><br>The function role needs <span class="mono">sqs:ReceiveMessage</span>, <span class="mono">sqs:DeleteMessage</span>, and <span class="mono">sqs:GetQueueAttributes</span> on <span class="mono">${escapeHtml(queueArn)}</span>.</div>`, "Save", async data => {
    const batchSize = Number(data.get("batchSize")); const batchWindow = Number(data.get("batchWindow")); if (!fifo && batchSize > 10 && batchWindow < 1) throw new Error("Set batching window to at least 1 second when batch size is greater than 10");
    const filter = String(data.get("filter") || "").trim(); if (filter) parseObject(filter, "Filter pattern"); const maximum = String(data.get("maximumConcurrency") || "").trim();
    await rest("/2015-03-31/event-source-mappings", "POST", { FunctionName: data.get("function"), EventSourceArn: queueArn, Enabled: data.get("enabled") === "yes", BatchSize: batchSize, MaximumBatchingWindowInSeconds: batchWindow, FunctionResponseTypes: data.get("partial") === "yes" ? ["ReportBatchItemFailures"] : [], FilterCriteria: { Filters: filter ? [{ Pattern: filter }] : [] }, ...(maximum ? { ScalingConfig: { MaximumConcurrency: Number(maximum) } } : {}) });
    context.toast("Lambda function trigger configured");
    const destination = queueHref(queue.name, "lambda-triggers");
    if (location.hash !== destination) location.hash = destination;
  }, true);
}

function openRedriveDialog(context, queue) {
  const fifo = queue.attributes.FifoQueue === "true";
  const destinationField = arnComboboxField("Destination queue ARN", { name: "destination", kinds: ["sqs-queue"], subtype: fifo ? "fifo" : "standard", accountScope: "same", regionScope: "same", placeholder: "arn:aws:sqs:…" }, `An existing ${fifo ? "FIFO" : "Standard"} queue that receives the messages. Use it for messages that were sent straight to this queue and have no source queue.`);
  const dialog = openModal(context, "Dead-letter queue redrive", `<p>Move the messages in <span class="mono">${escapeHtml(queue.name)}</span> back to where they can be processed again.</p><h3>Redrive configuration</h3>${radioList("Message destination", "moveMode", [
    { value: "source", label: "Redrive to source queue(s)", description: "Each message returns to the queue it was dead-lettered from." },
    { value: "custom", label: "Redrive to custom destination", description: "Every message moves to one queue that you choose." },
  ], "source")}<div data-move-destination>${destinationField}</div>${radioList("Velocity control settings", "velocityMode", [
    { value: "system", label: "System optimized", description: "Redrive dead-letter queue messages at the maximum number of messages per second." },
    { value: "custom", label: "Custom max velocity", description: "Redrive dead-letter queue messages with a custom maximum rate of messages per second." },
  ], "system")}<div class="field" data-move-velocity><label>Maximum messages per second</label><input name="velocity" type="number" min="1" max="500" step="1" value="10"><span class="hint">The maximum allowed rate is 500 messages per second. Start small while watching consumer logs.</span></div><p class="muted">Messages get new transport IDs and enqueue times. Use a stable application key for idempotency. Messages cannot be filtered or changed while they are redriven.</p>`, "Redrive messages", async data => {
    const custom = data.get("moveMode") === "custom";
    const destination = custom ? String(data.get("destination") ?? "").trim() : "";
    if (custom && !destination) throw new Error("Choose a custom destination queue.");
    const velocity = data.get("velocityMode") === "custom" ? Number(data.get("velocity")) : undefined;
    if (velocity !== undefined && (!Number.isInteger(velocity) || velocity < 1 || velocity > 500)) throw new Error("Velocity must be an integer from 1 to 500.");
    await sqs("StartMessageMoveTask", { SourceArn: queue.attributes.QueueArn, ...(destination ? { DestinationArn: destination } : {}), ...(velocity === undefined ? {} : { MaxNumberOfMessagesPerSecond: velocity }) });
    context.toast("DLQ redrive started");
    const tasks = queueHref(queue.name, "redrive-tasks");
    if (location.hash !== tasks) location.hash = tasks;
  });
  const sync = () => {
    setSectionEnabled(dialog.querySelector("[data-move-destination]"), checkedValue(dialog, "moveMode") === "custom");
    setSectionEnabled(dialog.querySelector("[data-move-velocity]"), checkedValue(dialog, "velocityMode") === "custom");
  };
  dialog.querySelectorAll('input[name="moveMode"], input[name="velocityMode"]').forEach(input => input.addEventListener("change", sync));
  sync();
}

function openDeadLetterDialog(context, queue) {
  const dialog = openModal(context, "Edit dead-letter queue", deadLetterFieldsMarkup(queue.attributes, queue.attributes.FifoQueue === "true"), "Save", async data => {
    const RedrivePolicy = readDeadLetterFields(data);
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { RedrivePolicy } });
    context.toast(RedrivePolicy ? "Dead-letter queue configured" : "Dead-letter queue disabled");
  });
  bindDeadLetterFields(dialog);
}

function openRedriveAllowDialog(context, queue) {
  const dialog = openModal(context, "Edit redrive allow policy", `<p>Identify which source queues can use this queue as the dead-letter queue.</p>${redriveAllowFieldsMarkup(queue.attributes)}`, "Save", async data => {
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { RedriveAllowPolicy: readRedriveAllowFields(data) } });
    context.toast("Redrive allow policy updated");
  });
  bindRedriveAllowFields(dialog);
}

function openEncryptionDialog(context, queue) {
  const dialog = openModal(context, "Edit encryption", `<p>Amazon SQS provides in-transit encryption by default. To add at-rest encryption to your queue, enable server-side encryption.</p>${encryptionFieldsMarkup(queue.attributes)}<p class="muted">The new value applies to messages written after this change.</p>`, "Save", async data => {
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { SqsManagedSseEnabled: data.get("sse") === "true" ? "true" : "false" } });
    context.toast("Queue encryption setting updated");
  });
  bindEncryptionFields(dialog);
}

function openAccessPolicyDialog(context, queue, { mode, submitLabel = "Save" } = {}) {
  let editor;
  const dialog = openModal(context, "Edit access policy", `<p>Define who can access your queue. Use a service principal with a source ARN condition for EventBridge rules, S3 notifications and SNS topics.</p>${accessPolicyEditorMarkup()}`, submitLabel, async () => {
    const Policy = editor.read();
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { Policy } });
    context.toast(Policy ? "Queue policy saved" : "Queue policy removed");
  }, true);
  editor = bindAccessPolicyEditor(dialog, { queueArn: () => queue.attributes.QueueArn, policy: queue.attributes.Policy, mode, emptyHint: "Leave the editor empty to remove the policy." });
}

function openTagsDialog(context, queue) {
  const dialog = openModal(context, "Manage tags", `${tagEditorMarkup(queue.tags)}<p class="muted">Saving adds or updates keys and untags the keys you removed.</p>`, "Save", async () => {
    await saveTags(queue, readTagEditor(dialog));
    context.toast("Queue tags updated");
  }, true);
  bindTagEditor(dialog);
}

// ---------------------------------------------------------------------------
// Overview and queue list

async function overview(context) {
  const queues = await queueCatalog();
  const visible = queues.reduce((sum, queue) => sum + integer(queue.attributes.ApproximateNumberOfMessages), 0);
  const inFlight = queues.reduce((sum, queue) => sum + integer(queue.attributes.ApproximateNumberOfMessagesNotVisible), 0);
  context.setChrome("sqs", ["SQS", "Overview"]);
  context.main.innerHTML = `<div class="page-width sqs-console">${pageHeader("SQS", "Durable local queues for decoupled producers, ordered workers, retries, and dead-letter workflows.", `<a class="button primary" href="${CREATE_HREF}">Create queue</a>`)}<div class="dashboard-grid"><section class="card"><div class="card-header"><h2>Queues</h2></div><div class="card-body"><div class="metric">${queues.length}</div><p class="muted">Standard and FIFO queues in ${escapeHtml(ui.region)}</p><a href="${LIST_HREF}">View queues</a></div></section><section class="card"><div class="card-header"><h2>Available messages</h2></div><div class="card-body"><div class="metric">${visible}</div><p class="muted">Currently eligible for receive</p></div></section><section class="card"><div class="card-header"><h2>In flight</h2></div><div class="card-body"><div class="metric">${inFlight}</div><p class="muted">Received and inside their visibility timeout</p></div></section></div><section class="card"><div class="card-header"><h2>Development behavior</h2></div><div class="card-body"><p>Messages, delays, visibility leases, receive counts, FIFO deduplication, and redrive state survive simulator restart. Standard delivery remains at least once, so workers should be idempotent.</p><p class="muted">Fair scheduling is deterministic and bounded locally; it does not reproduce distributed throughput.</p></div></section></div>`;
}

async function queuesPage(context) {
  const queues = await queueCatalog();
  const deadLetterArns = new Set(queues.map(queue => parsePolicy(queue.attributes.RedrivePolicy).deadLetterTargetArn).filter(Boolean));
  context.setChrome("sqs", ["SQS", "Queues"]);
  const rows = queues.map(queue => { const fifo = queue.attributes.FifoQueue === "true"; return `<tr data-search-row="${escapeHtml(`${queue.name} ${queue.url}`.toLowerCase())}"><td><input type="radio" name="queue" value="${escapeHtml(queue.name)}" aria-label="Select ${escapeHtml(queue.name)}"></td><td><a href="${queueHref(queue.name)}">${escapeHtml(queue.name)}</a></td><td>${fifo ? "FIFO" : "Standard"}</td><td>${formatDate(integer(queue.attributes.CreatedTimestamp))}</td><td>${integer(queue.attributes.ApproximateNumberOfMessages).toLocaleString()}</td><td>${integer(queue.attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</td><td>${escapeHtml(encryptionLabel(queue.attributes))}</td><td>${fifo ? queue.attributes.ContentBasedDeduplication === "true" ? "Enabled" : "Disabled" : "-"}</td><td><span class="mono sqs-queue-url">${escapeHtml(queue.url)}</span></td></tr>`; }).join("");
  const toolbar = `<button class="button refresh" type="button" data-action="refresh" title="Refresh" aria-label="Refresh queues">↻</button><button class="button" type="button" data-queue-action="edit" disabled>Edit</button><button class="button" type="button" data-queue-action="delete" disabled>Delete</button><button class="button" type="button" data-queue-action="messages" disabled>Send and receive messages</button>${actionsMenu([
    ['data-queue-action="messages" disabled', "Send and receive messages"],
    ['data-queue-action="purge" disabled', "Purge"],
    ['data-queue-action="subscribe" disabled', "Subscribe to Amazon SNS topic"],
    ['data-queue-action="trigger" disabled', "Configure Lambda function trigger"],
    [`data-queue-action="redrive" disabled title="${NOT_A_DLQ}"`, "Start DLQ redrive"],
  ])}<a class="button primary" href="${CREATE_HREF}">Create queue</a>`;
  context.main.innerHTML = `<div class="page-width sqs-console sqs-queues-page">${pageHeader("Queues", "Create and inspect regional Standard and FIFO queues.")}<section class="card"><div class="card-header"><h2>Queues <span class="muted">(${queues.length})</span></h2><div class="actions">${toolbar}</div></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Search queues by name"></label></div><div class="table-wrap">${queues.length ? `<table class="sqs-queue-table"><thead><tr><th><span class="sr-only">Select</span></th><th>Name</th><th>Type</th><th>Created</th><th>Messages available</th><th>Messages in flight</th><th>Encryption</th><th>Content-based deduplication</th><th>Queue URL</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("Q", "No queues", "Create a Standard or FIFO queue to send and receive local messages.", `<a class="button primary" href="${CREATE_HREF}">Create queue</a>`)}</div></section></div>`;
  const root = context.main;
  const selected = () => queues.find(queue => queue.name === root.querySelector('input[name="queue"]:checked')?.value);
  const syncButtons = () => {
    const queue = selected();
    root.querySelectorAll("[data-queue-action]").forEach(button => {
      const redrive = button.dataset.queueAction === "redrive"; const usable = Boolean(queue) && (!redrive || deadLetterArns.has(queue.attributes.QueueArn));
      button.disabled = !usable;
      if (redrive) button.title = usable ? "" : NOT_A_DLQ;
    });
  };
  root.querySelectorAll('input[name="queue"]').forEach(radio => radio.addEventListener("change", syncButtons));
  root.querySelectorAll("[data-queue-action]").forEach(button => button.addEventListener("click", async () => {
    const queue = selected();
    if (!queue) return;
    try {
      const action = button.dataset.queueAction;
      if (action === "edit") location.hash = queueHref(queue.name, "edit");
      else if (action === "messages") location.hash = queueHref(queue.name, "messages");
      else if (action === "delete") openDeleteDialog(context, queue);
      else if (action === "purge") openPurgeDialog(context, queue);
      else if (action === "subscribe") await openSubscribeDialog(context, queue);
      else if (action === "trigger") await openTriggerDialog(context, queue);
      else if (action === "redrive") openRedriveDialog(context, queue);
    } catch (error) { context.showError(error); }
  }));
  bindMenus(root);
  context.bindTableFilter();
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

// ---------------------------------------------------------------------------
// Create and edit queue

function configurationFields(attributes, fifo, editing) {
  const fifoFields = `<div data-fifo-fields ${fifo ? "" : "hidden"}><hr class="form-divider"><div class="field"><label class="checkbox-label"><input type="checkbox" name="contentDeduplication" value="yes" ${attributes.ContentBasedDeduplication === "true" ? "checked" : ""}> Content-based deduplication</label><span class="hint">Amazon SQS uses a hash of the message body as the deduplication ID when a sender does not supply one.</span></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="highThroughput" value="yes" ${attributes.DeduplicationScope === "messageGroup" && attributes.FifoThroughputLimit === "perMessageGroupId" ? "checked" : ""}> Enable high throughput FIFO</label><span class="hint">Sets Deduplication scope to Message group and FIFO throughput limit to Per message group ID.</span></div><div class="sqs-form-grid"><div class="field"><label>Deduplication scope</label><select name="deduplicationScope"><option value="queue" ${attributes.DeduplicationScope === "messageGroup" ? "" : "selected"}>Queue</option><option value="messageGroup" ${attributes.DeduplicationScope === "messageGroup" ? "selected" : ""}>Message group</option></select></div><div class="field"><label>FIFO throughput limit</label><select name="fifoThroughput"><option value="perQueue" ${attributes.FifoThroughputLimit === "perMessageGroupId" ? "" : "selected"}>Per queue</option><option value="perMessageGroupId" ${attributes.FifoThroughputLimit === "perMessageGroupId" ? "selected" : ""}>Per message group ID</option></select><span class="hint">Per message group ID requires the Message group deduplication scope.</span></div></div></div>`;
  return `<div class="sqs-form-grid">${durationField({ label: "Visibility timeout", name: "visibility", seconds: attributes.VisibilityTimeout ?? 30, units: ["Seconds", "Minutes", "Hours"], hint: "Should be between 0 seconds and 12 hours." })}${durationField({ label: "Message retention period", name: "retention", seconds: attributes.MessageRetentionPeriod ?? 345_600, units: ["Seconds", "Minutes", "Hours", "Days"], hint: "Should be between 1 minute and 14 days." })}${durationField({ label: "Delivery delay", name: "delay", seconds: attributes.DelaySeconds ?? 0, units: ["Seconds", "Minutes"], hint: "Should be between 0 seconds and 15 minutes." })}<div class="field"><label>Maximum message size</label><div class="sqs-duration"><input name="maximumSize" type="number" min="1" max="1024" step="any" value="${integer(attributes.MaximumMessageSize ?? 1_048_576) / 1024}" required><span class="sqs-unit">KiB</span></div><span class="hint">Should be between 1 KiB and 1024 KiB.</span></div><div class="field"><label>Receive message wait time</label><div class="sqs-duration"><input name="wait" type="number" min="0" max="20" step="1" value="${integer(attributes.ReceiveMessageWaitTimeSeconds ?? 0)}" required><span class="sqs-unit">Seconds</span></div><span class="hint">Should be between 0 and 20 seconds. 0 sets short polling; any other value sets long polling.</span></div></div>${editing && !fifo ? "" : fifoFields}`;
}

async function queueFormPage(context, name) {
  const editing = name !== undefined;
  const queue = editing ? await describeQueue(name, true) : undefined;
  const attributes = queue?.attributes ?? { SqsManagedSseEnabled: "true" };
  const editingFifo = attributes.FifoQueue === "true";
  const cancelHref = editing ? queueHref(name) : LIST_HREF;
  if (editing) setQueueChrome(context, name, "Edit"); else context.setChrome("sqs", ["SQS", "Queues", "Create queue"]);
  const card = (title, description, body, optional = false) => `<section class="card"><div class="card-header"><div><h2>${title}${optional ? ' <span class="muted">- Optional</span>' : ""}</h2><p class="muted small">${description}</p></div></div><div class="card-body">${body}</div></section>`;
  const details = editing
    ? `<dl class="key-value"><dt>Type</dt><dd>${editingFifo ? "FIFO" : "Standard"}</dd><dt>Name</dt><dd class="mono">${escapeHtml(name)}</dd></dl><p class="muted">You can't change the queue type or name after you create a queue.</p>`
    : `<div class="field-label">Type</div><p class="muted small">Choose the queue type for your application or cloud infrastructure.</p><fieldset class="setting-options"><legend class="sr-only">Type</legend><label class="setting-option"><input type="radio" name="type" value="standard" checked><span><strong>Standard</strong><small>At-least-once delivery, message ordering isn't preserved</small><small>At-least-once delivery · Best-effort ordering</small></span></label><label class="setting-option"><input type="radio" name="type" value="fifo"><span><strong>FIFO</strong><small>First-in-first-out delivery, message ordering is preserved</small><small>First-in-first-out delivery · Exactly-once processing</small></span></label></fieldset><p class="muted small">You can't change the queue type after you create a queue.</p><div class="field"><label>Name</label><input name="name" required maxlength="80" autocomplete="off" placeholder="MyQueue"><span class="hint" data-name-hint>A queue name is case-sensitive and can have up to 80 characters. You can use alphanumeric characters, hyphens (-), and underscores (_).</span></div>`;
  context.main.innerHTML = `<div class="page-width sqs-console sqs-queue-form"><form id="sqs-queue-form">${pageHeader(editing ? `Edit ${name}` : "Create queue", editing ? "Change the queue's configuration, policies, encryption, dead-letter queue and tags." : "Create a Standard or FIFO queue. Every setting except the name has a default value.")}<div id="sqs-queue-form-error" class="alert error" role="alert" tabindex="-1" hidden></div>${card("Details", "The queue type and name identify the queue.", details)}${card("Configuration", "Set the maximum message size, visibility to other consumers, and message retention.", configurationFields(attributes, editingFifo, editing))}${card("Access policy", "Define who can access your queue.", accessPolicyEditorMarkup())}${card("Redrive allow policy", "Identify which source queues can use this queue as the dead-letter queue.", redriveAllowFieldsMarkup(attributes), true)}${card("Encryption", "Amazon SQS provides in-transit encryption by default. To add at-rest encryption to your queue, enable server-side encryption.", encryptionFieldsMarkup(attributes))}${card("Dead-letter queue", "Send undeliverable messages to a dead-letter queue.", deadLetterFieldsMarkup(attributes, editingFifo), true)}${card("Tags", "A tag is a label assigned to an AWS resource. Use tags to search and filter your resources or track your AWS costs.", tagEditorMarkup(queue?.tags ?? {}), true)}<div class="actions page-actions"><a class="button" href="${cancelHref}">Cancel</a><button class="button primary" type="submit" id="sqs-queue-form-submit">${editing ? "Save" : "Create queue"}</button></div></form></div>`;

  const form = context.main.querySelector("#sqs-queue-form");
  const errorRoot = context.main.querySelector("#sqs-queue-form-error");
  const isFifo = () => editing ? editingFifo : checkedValue(form, "type") === "fifo";
  const queueName = () => editing ? name : String(form.elements.name.value).trim();
  const queueArn = () => editing ? attributes.QueueArn : `arn:aws:sqs:${ui.region}:${accountId()}:${queueName() || "QUEUE_NAME"}`;
  const markDirty = () => setDirty(true, "page");
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);

  const policyEditor = bindAccessPolicyEditor(form, { queueArn, policy: attributes.Policy, blankWhenMissing: editing, emptyHint: editing ? (attributes.Policy ? "Leave the editor empty to remove the policy." : "This queue has no access policy. Leave the editor empty to keep it that way, or choose Basic to start from the owner-only policy.") : "Leave the editor empty to create the queue without a policy." });
  bindRedriveAllowFields(form);
  bindEncryptionFields(form);
  const deadLetter = bindDeadLetterFields(form);
  bindTagEditor(form);

  const scope = form.elements.deduplicationScope; const limit = form.elements.fifoThroughput; const highThroughput = form.elements.highThroughput;
  if (highThroughput) {
    highThroughput.addEventListener("change", () => { scope.value = highThroughput.checked ? "messageGroup" : "queue"; limit.value = highThroughput.checked ? "perMessageGroupId" : "perQueue"; });
    for (const select of [scope, limit]) select.addEventListener("change", () => { highThroughput.checked = scope.value === "messageGroup" && limit.value === "perMessageGroupId"; });
  }
  if (!editing) {
    const syncType = () => {
      const fifo = isFifo();
      setSectionEnabled(form.querySelector("[data-fifo-fields]"), fifo);
      form.elements.name.placeholder = fifo ? "MyQueue.fifo" : "MyQueue";
      form.querySelector("[data-name-hint]").textContent = `A queue name is case-sensitive and can have up to 80 characters. You can use alphanumeric characters, hyphens (-), and underscores (_).${fifo ? " A FIFO queue name must end with the .fifo suffix." : ""}`;
    };
    form.querySelectorAll('input[name="type"]').forEach(input => input.addEventListener("change", () => { syncType(); deadLetter.setType(isFifo()); associateFormLabels(form); policyEditor.refresh(); }));
    form.elements.name.addEventListener("input", () => policyEditor.refresh());
    syncType();
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = form.querySelector("#sqs-queue-form-submit");
    submit.disabled = true; errorRoot.hidden = true;
    try {
      const data = new FormData(form); const fifo = isFifo(); const target = queueName();
      if (!editing) {
        if (fifo && !target.endsWith(".fifo")) throw new Error("A FIFO queue name must end with the .fifo suffix.");
        if (!(fifo ? /^[A-Za-z0-9_-]{1,75}\.fifo$/ : /^[A-Za-z0-9_-]{1,80}$/).test(target)) throw new Error(fifo ? "A FIFO queue name can have up to 80 characters including the .fifo suffix: alphanumeric characters, hyphens (-), and underscores (_)." : "A queue name can have up to 80 characters: alphanumeric characters, hyphens (-), and underscores (_). Choose FIFO to use the .fifo suffix.");
      }
      const size = Number(data.get("maximumSize")); const wait = Number(data.get("wait"));
      if (!Number.isFinite(size) || size < 1 || size > 1024) throw new Error("Maximum message size should be between 1 KiB and 1024 KiB.");
      if (!Number.isInteger(wait) || wait < 0 || wait > 20) throw new Error("Receive message wait time should be between 0 and 20 seconds.");
      const next = {
        VisibilityTimeout: String(readDuration(data, "visibility", "Visibility timeout", 0, 43_200)),
        MessageRetentionPeriod: String(readDuration(data, "retention", "Message retention period", 60, 1_209_600)),
        DelaySeconds: String(readDuration(data, "delay", "Delivery delay", 0, 900)),
        MaximumMessageSize: String(Math.round(size * 1024)),
        ReceiveMessageWaitTimeSeconds: String(wait),
        SqsManagedSseEnabled: data.get("sse") === "true" ? "true" : "false",
        ...(fifo ? { ContentBasedDeduplication: data.get("contentDeduplication") === "yes" ? "true" : "false", DeduplicationScope: String(data.get("deduplicationScope")), FifoThroughputLimit: String(data.get("fifoThroughput")) } : {}),
      };
      const Policy = policyEditor.read(); const RedrivePolicy = readDeadLetterFields(data); const RedriveAllowPolicy = readRedriveAllowFields(data); const tags = readTagEditor(form);
      if (editing) {
        const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => String(attributes[key] ?? "") !== value));
        if (fifo && ("DeduplicationScope" in changed || "FifoThroughputLimit" in changed)) { changed.DeduplicationScope = next.DeduplicationScope; changed.FifoThroughputLimit = next.FifoThroughputLimit; }
        if (policyEditor.touched && !sameJson(Policy, attributes.Policy)) changed.Policy = Policy;
        if (!sameRedrivePolicy(RedrivePolicy, attributes.RedrivePolicy)) changed.RedrivePolicy = RedrivePolicy;
        if (!sameRedriveAllowPolicy(RedriveAllowPolicy, attributes.RedriveAllowPolicy)) changed.RedriveAllowPolicy = RedriveAllowPolicy;
        if (Object.keys(changed).length) await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: changed });
        await saveTags(queue, tags);
        setDirty(false, "page");
        context.toast(`Queue ${name} saved`);
        location.hash = queueHref(name);
      } else {
        const result = await sqs("CreateQueue", {
          QueueName: target,
          Attributes: { ...(fifo ? { FifoQueue: "true" } : {}), ...next, ...(Policy ? { Policy } : {}), ...(RedrivePolicy ? { RedrivePolicy } : {}), ...(RedriveAllowPolicy ? { RedriveAllowPolicy } : {}) },
          ...(Object.keys(tags).length ? { tags } : {}),
        });
        setDirty(false, "page");
        context.toast(`Queue ${target} created`);
        location.hash = queueHref(queueNameFromUrl(result.QueueUrl) || target);
      }
    } catch (error) {
      markDirty(); submit.disabled = false;
      errorRoot.innerHTML = `<strong>${editing ? "Queue couldn't be saved" : "Queue couldn't be created"}</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}`;
      errorRoot.hidden = false; errorRoot.focus({ preventScroll: false });
      context.showError(error);
    }
  });
}

// ---------------------------------------------------------------------------
// Details

async function detailsPage(context, name) {
  const { queue, isDlq } = await loadQueue(name, true); const attributes = queue.attributes; const fifo = attributes.FifoQueue === "true";
  const redrive = parsePolicy(attributes.RedrivePolicy); const deadLetterName = queueNameFromArn(redrive.deadLetterTargetArn);
  const allow = redriveAllowSummary(attributes);
  setQueueChrome(context, name, "Details");
  const fifoDetails = fifo ? `<section class="card"><div class="card-header"><h2>FIFO configuration</h2></div><div class="card-body"><dl class="key-value"><dt>Content-based deduplication</dt><dd>${attributes.ContentBasedDeduplication === "true" ? "Enabled" : "Disabled"}</dd><dt>High throughput FIFO</dt><dd>${attributes.DeduplicationScope === "messageGroup" && attributes.FifoThroughputLimit === "perMessageGroupId" ? "Enabled" : "Disabled"}</dd><dt>Deduplication scope</dt><dd><span title="${escapeHtml(attributes.DeduplicationScope)}">${attributes.DeduplicationScope === "messageGroup" ? "Message group" : "Queue"}</span></dd><dt>FIFO throughput limit</dt><dd><span title="${escapeHtml(attributes.FifoThroughputLimit)}">${attributes.FifoThroughputLimit === "perMessageGroupId" ? "Per message group ID" : "Per queue"}</span></dd></dl><p class="muted">Queue type and the <span class="mono">.fifo</span> suffix are immutable.</p></div></section>` : `<section class="card"><div class="card-header"><h2>Fair queue behavior</h2></div><div class="card-body"><p>Supplying <span class="mono">MessageGroupId</span> enables deterministic bounded-fair local scheduling for Standard messages.</p><p class="muted">AWS's internal distributed fairness algorithm and production throughput are not reproduced.</p></div></section>`;
  const more = `<details class="sqs-more"><summary>More</summary><dl class="key-value"><dt>Created</dt><dd>${formatDate(integer(attributes.CreatedTimestamp))}</dd><dt>Last updated</dt><dd>${formatDate(integer(attributes.LastModifiedTimestamp))}</dd><dt>Maximum message size</dt><dd>${sizeText(attributes.MaximumMessageSize)}</dd><dt>Message retention period</dt><dd>${durationText(attributes.MessageRetentionPeriod)}</dd><dt>Default visibility timeout</dt><dd>${durationText(attributes.VisibilityTimeout)}</dd><dt>Delivery delay</dt><dd>${durationText(attributes.DelaySeconds)}</dd><dt>Receive message wait time</dt><dd>${durationText(attributes.ReceiveMessageWaitTimeSeconds)}</dd><dt>Messages available</dt><dd>${integer(attributes.ApproximateNumberOfMessages).toLocaleString()}</dd><dt>Messages in flight (not available to other consumers)</dt><dd>${integer(attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</dd><dt>Messages delayed</dt><dd>${integer(attributes.ApproximateNumberOfMessagesDelayed).toLocaleString()}</dd><dt>Content-based deduplication</dt><dd>${fifo ? attributes.ContentBasedDeduplication === "true" ? "Enabled" : "Disabled" : "-"}</dd><dt>Redrive allow policy</dt><dd>${allow.status === "Enabled" ? escapeHtml(allow.permission) : "Disabled"}</dd></dl></details>`;
  const tagCount = Object.keys(queue.tags).length;
  context.main.innerHTML = `<div class="page-width sqs-console sqs-detail">${queueHeader(queue, isDlq)}${queueTabs(name, "details")}<div class="sqs-summary-grid"><section class="card"><div class="card-header"><h2>Details</h2></div><div class="card-body"><dl class="key-value"><dt>Name</dt><dd>${escapeHtml(name)}</dd><dt>Type</dt><dd>${fifo ? "FIFO" : "Standard"}</dd><dt>ARN</dt><dd class="mono">${escapeHtml(attributes.QueueArn)}</dd><dt>Encryption</dt><dd>${escapeHtml(encryptionLabel(attributes))}</dd><dt>URL</dt><dd class="mono">${escapeHtml(queue.url)}</dd><dt>Dead-letter queue</dt><dd>${redrive.deadLetterTargetArn ? `Enabled · <a href="${queueHref(deadLetterName)}">${escapeHtml(deadLetterName)}</a>` : "Disabled"}</dd></dl>${more}</div></section><section class="card"><div class="card-header"><h2>Message state</h2></div><div class="card-body"><dl class="key-value"><dt>Available</dt><dd class="metric">${integer(attributes.ApproximateNumberOfMessages).toLocaleString()}</dd><dt>In flight</dt><dd>${integer(attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</dd><dt>Delayed</dt><dd>${integer(attributes.ApproximateNumberOfMessagesDelayed).toLocaleString()}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Configuration</h2></div><div class="card-body"><dl class="key-value"><dt>Visibility timeout</dt><dd>${durationText(attributes.VisibilityTimeout)}</dd><dt>Delivery delay</dt><dd>${durationText(attributes.DelaySeconds)}</dd><dt>Receive message wait time</dt><dd>${durationText(attributes.ReceiveMessageWaitTimeSeconds)}</dd><dt>Message retention period</dt><dd>${durationText(attributes.MessageRetentionPeriod)}</dd><dt>Maximum message size</dt><dd>${sizeText(attributes.MaximumMessageSize)}</dd></dl></div></section>${fifoDetails}</div><section class="card"><div class="card-header"><h2>Tags <span class="muted">(${tagCount})</span></h2><a href="${queueHref(name, "tagging")}">Manage tags</a></div><div class="table-wrap">${tagCount ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${Object.entries(queue.tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : '<div class="card-body muted">No tags configured.</div>'}</div></section></div>`;
  bindQueueHeader(context, queue);
}

// ---------------------------------------------------------------------------
// Send and receive messages

function pollSettings(queue) {
  if (!pollSettingsByQueue.has(queue.url)) pollSettingsByQueue.set(queue.url, { duration: 30, maximum: 10, wait: 20, visibility: "", attempts: "" });
  return pollSettingsByQueue.get(queue.url);
}

function attributeRowMarkup() {
  return `<div class="sqs-attribute-row" data-attribute-row><div class="field"><label>Name</label><input data-attribute-name maxlength="256" placeholder="Enter name"></div><div class="field"><label>Type</label><select data-attribute-type><option>String</option><option>Number</option><option>Binary</option></select></div><div class="field"><label>Custom type - optional</label><input data-attribute-custom maxlength="200" placeholder="byte, int, float"></div><div class="field"><label>Value</label><input data-attribute-value placeholder="Enter value"></div><button class="button" type="button" data-attribute-remove>Remove</button></div>`;
}

/** Reads the attribute rows into the SendMessage shape. A Binary value is sent as the UTF-8 bytes of the text. */
function readAttributeRows(root) {
  const result = {};
  for (const row of root.querySelectorAll("[data-attribute-row]")) {
    const name = row.querySelector("[data-attribute-name]").value.trim(); const value = row.querySelector("[data-attribute-value]").value;
    const type = row.querySelector("[data-attribute-type]").value; const custom = row.querySelector("[data-attribute-custom]").value.trim();
    if (!name && !value && !custom) continue;
    if (!name) throw new Error("Enter a name for every message attribute.");
    if (name in result) throw new Error(`Message attribute ${name} is used more than once.`);
    if (!value) throw new Error(`Enter a value for message attribute ${name}.`);
    const DataType = custom ? `${type}.${custom}` : type;
    result[name] = type === "Binary" ? { DataType, BinaryValue: base64Utf8(value) } : { DataType, StringValue: value };
  }
  return result;
}

function messageDetailRows(message) {
  const attributes = message.Attributes ?? {};
  const row = (label, value, mono = false) => `<dt>${label}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHtml(value)}</dd>`;
  return `${row("Message ID", message.MessageId, true)}${row("Size", messageSize(byteLength(message.Body)))}${row("MD5 of message body", message.MD5OfBody, true)}${row("MD5 of message attributes", message.MD5OfMessageAttributes || "–", true)}${row("Sender account ID", attributes.SenderId || "–", true)}${row("Sent", attributes.SentTimestamp ? formatDate(Number(attributes.SentTimestamp)) : "–")}${row("First received", attributes.ApproximateFirstReceiveTimestamp ? formatDate(Number(attributes.ApproximateFirstReceiveTimestamp)) : "–")}${row("Receive count", attributes.ApproximateReceiveCount || "1")}${row("Message attributes count", String(Object.keys(message.MessageAttributes ?? {}).length))}${row("Message group ID", attributes.MessageGroupId || "–", true)}${row("Message deduplication ID", attributes.MessageDeduplicationId || "–", true)}${row("Sequence number", attributes.SequenceNumber || "–", true)}${row("Trace header", attributes.AWSTraceHeader || "–", true)}`;
}

function openMessageDialog(context, queue, entry, onChanged) {
  const message = entry.message; const messageAttributes = Object.entries(message.MessageAttributes ?? {});
  const attributeRows = messageAttributes.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value.DataType)}</td><td class="mono">${escapeHtml(compactText(value.StringValue ?? value.BinaryValue ?? "", 4_096))}</td></tr>`).join("");
  const tab = (key, label, active = false) => `<button type="button" class="tab ${active ? "active" : ""}" role="tab" aria-selected="${active}" tabindex="${active ? "0" : "-1"}" data-message-tab="${key}">${label}</button>`;
  const dialog = openModal(context, `Message: ${message.MessageId}`, `<div class="tabs" role="tablist">${tab("body", "Body", true)}${tab("attributes", "Attributes")}${tab("details", "Details")}</div><div data-message-panel="body"><pre class="code-box sqs-message-body">${escapeHtml(compactText(message.Body))}</pre></div><div data-message-panel="attributes" hidden>${attributeRows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead><tbody>${attributeRows}</tbody></table></div>` : '<p class="muted">No message attributes.</p>'}<div class="field-label">Message attributes (JSON)</div><pre class="code-box">${escapeHtml(compactText(JSON.stringify(message.MessageAttributes ?? {}, null, 2), 32 * 1024))}</pre></div><div data-message-panel="details" hidden><dl class="key-value">${messageDetailRows(message)}</dl><div class="field-label">System attributes</div><pre class="code-box">${escapeHtml(compactText(JSON.stringify(message.Attributes ?? {}, null, 2), 32 * 1024))}</pre><div class="field"><label>Visibility timeout (seconds)</label><input name="visibility" type="number" min="0" max="43200" value="30"><span class="hint">Set 0 to make the message immediately eligible for another receive.</span></div><button class="button" type="button" data-change-message-visibility>Change visibility</button></div>`, "Done", async () => undefined, true, { refreshAfterSubmit: false });
  dialog.querySelectorAll("[data-message-tab]").forEach(button => button.addEventListener("click", () => {
    dialog.querySelectorAll("[data-message-tab]").forEach(other => { const active = other === button; other.classList.toggle("active", active); other.setAttribute("aria-selected", String(active)); other.tabIndex = active ? 0 : -1; });
    dialog.querySelectorAll("[data-message-panel]").forEach(panel => { panel.hidden = panel.dataset.messagePanel !== button.dataset.messageTab; });
  }));
  const change = dialog.querySelector("[data-change-message-visibility]");
  change.addEventListener("click", async () => {
    const visibility = Number(dialog.querySelector('[name="visibility"]').value);
    if (!Number.isInteger(visibility) || visibility < 0 || visibility > 43_200) return context.showError(new Error("Visibility timeout should be between 0 and 43200 seconds."));
    change.disabled = true;
    try {
      await sqs("ChangeMessageVisibility", { QueueUrl: queue.url, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: visibility });
      // The user chose this timeout, so the console no longer releases the message on its own.
      entry.autoRelease = false; entry.heldUntil = Date.now() + visibility * 1_000;
      context.toast("Message visibility changed");
      onChanged?.();
    } catch (error) { context.showError(error); }
    finally { change.disabled = false; }
  });
}

async function messagesPage(context, name) {
  const queue = await describeQueue(name); const attributes = queue.attributes; const fifo = attributes.FifoQueue === "true";
  const contentDeduplication = attributes.ContentBasedDeduplication === "true";
  const settings = pollSettings(queue);
  setQueueChrome(context, name, "Send and receive messages");
  const sendFields = `<div class="field"><label>Message body</label><textarea name="body" required maxlength="1048576" placeholder='{"job":"resize-image"}'></textarea><span class="hint">The queue accepts messages of up to ${humanSize(integer(attributes.MaximumMessageSize, 1_048_576))} (${integer(attributes.MaximumMessageSize, 1_048_576).toLocaleString()} bytes).</span></div><div class="sqs-form-grid"><div class="field"><label>Message group ID${fifo ? "" : " - optional"}</label><input name="messageGroup" ${fifo ? "required" : ""} maxlength="128" placeholder="tenant-a"><span class="hint">${fifo ? "Messages in one group are delivered in order." : "On a Standard queue the group ID enables fair-queue scheduling between groups."}</span></div>${fifo ? `<div class="field"><label>Message deduplication ID${contentDeduplication ? " - optional" : ""}</label><input name="deduplication" ${contentDeduplication ? "" : "required"} maxlength="128" placeholder="job-123"><span class="hint">${contentDeduplication ? "Not required: the queue uses content-based deduplication." : "A message with the same ID sent within five minutes is accepted but not delivered again."}</span></div>` : durationField({ label: "Delivery delay", name: "delay", seconds: attributes.DelaySeconds ?? 0, units: ["Seconds", "Minutes"], hint: "Should be between 0 seconds and 15 minutes. Starts at the queue's delivery delay." })}</div>${fifo ? '<p class="muted small">FIFO queues do not support a delivery delay on individual messages.</p>' : ""}<h3>Message attributes <span class="muted">- Optional</span></h3><div class="sqs-attributes" data-attribute-editor><div data-attribute-rows></div><button class="button" type="button" data-attribute-add>Add new attribute</button><span class="hint">A message can have up to 10 attributes. A Binary value is sent as the UTF-8 bytes of the text you enter.</span></div><details class="sqs-details"><summary>Additional local settings</summary><div class="field"><label>Message attributes as JSON</label><textarea name="attributesJson" class="code-editor" spellcheck="false" placeholder='{"priority":{"DataType":"Number","StringValue":"10"}}'></textarea><span class="hint">Attributes in the SendMessage shape, added to the rows above. BinaryValue is base64 here.</span></div><div class="field"><label>Trace header - optional</label><input name="trace" placeholder="Root=1-...;Parent=...;Sampled=1"><span class="hint">Sent as the AWSTraceHeader message system attribute.</span></div></details>`;
  const pollSummary = `<dl class="sqs-poll-summary"><div><dt>Messages available</dt><dd data-messages-available>${integer(attributes.ApproximateNumberOfMessages).toLocaleString()}</dd></div><div><dt>Polling duration</dt><dd data-poll-duration></dd></div><div><dt>Maximum message count</dt><dd data-poll-maximum></dd></div><div><dt>Polling progress</dt><dd><progress id="sqs-poll-progress" max="100" value="0" aria-label="Polling progress"></progress><span id="sqs-poll-status" class="muted" aria-live="polite">Ready</span></dd></div></dl><p class="muted small" data-poll-extra></p>`;
  context.main.innerHTML = `<div class="page-width sqs-console sqs-messages-page">${pageHeader("Send and receive messages", `Send messages to and receive messages from <span class="mono">${escapeHtml(name)}</span>.`)}${queueTabs(name, "messages")}<div class="alert warning"><strong>Polling changes queue state</strong><br>Receiving a message increments its receive count and hides it from other consumers while it is listed here. Stop polling cancels the active long-poll request.</div><div data-send-result></div><section class="card sqs-send-card"><div class="card-header"><h2>Send message</h2><div class="actions"><button class="button" type="button" data-clear-send>Clear content</button><button class="button primary" type="submit" form="sqs-send-form">Send message</button></div></div><form id="sqs-send-form" class="card-body">${sendFields}</form></section><section class="card sqs-receive-card"><div class="card-header"><h2>Receive messages</h2><div class="actions"><button class="button" type="button" data-edit-poll>Edit poll settings</button><button class="button" type="button" data-stop-poll disabled>Stop polling</button><button class="button primary" type="button" data-start-poll>Poll for messages</button></div></div><div class="card-body">${pollSummary}</div></section><section class="card sqs-messages-card"><div class="card-header"><h2>Messages <span class="muted" data-message-count>(0)</span></h2><div class="actions"><button class="button" type="button" data-view-selected disabled>View details</button><button class="button" type="button" data-delete-selected disabled>Delete</button></div></div><div id="sqs-receive-results"></div></section></div>`;

  const root = context.main;
  const refreshCounts = async () => {
    try {
      const latest = await sqs("GetQueueAttributes", { QueueUrl: queue.url, AttributeNames: ["All"] });
      const target = root.querySelector("[data-messages-available]");
      if (target) target.textContent = integer(latest.Attributes?.ApproximateNumberOfMessages).toLocaleString();
    } catch { /* the count is informational */ }
  };

  // Send message
  const sendForm = root.querySelector("#sqs-send-form"); const sendResult = root.querySelector("[data-send-result]");
  const attributeRows = sendForm.querySelector("[data-attribute-rows]");
  const defaults = Object.fromEntries([...sendForm.querySelectorAll("[name]")].map(control => [control.name, control.value]));
  // A draft message is not page state: leaving this page never asks to discard it.
  sendForm.addEventListener("input", event => event.stopPropagation());
  sendForm.querySelector("[data-attribute-add]").addEventListener("click", () => {
    attributeRows.insertAdjacentHTML("beforeend", attributeRowMarkup());
    const row = attributeRows.lastElementChild;
    row.querySelector("[data-attribute-remove]").addEventListener("click", () => row.remove());
    associateFormLabels(row);
    row.querySelector("[data-attribute-name]").focus();
  });
  root.querySelector("[data-clear-send]").addEventListener("click", () => {
    for (const control of sendForm.querySelectorAll("[name]")) control.value = defaults[control.name] ?? "";
    attributeRows.innerHTML = ""; sendResult.innerHTML = "";
  });
  sendForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = root.querySelector('button[form="sqs-send-form"]');
    submit.disabled = true;
    try {
      const data = new FormData(sendForm);
      const rows = readAttributeRows(sendForm);
      const rawJson = String(data.get("attributesJson") || "").trim(); const extra = rawJson ? parseObject(rawJson, "Message attributes as JSON") : {};
      const repeated = Object.keys(extra).find(key => key in rows); if (repeated) throw new Error(`Message attribute ${repeated} is defined in both the rows and the JSON.`);
      const MessageAttributes = { ...rows, ...extra };
      const trace = String(data.get("trace") || "").trim(); const group = String(data.get("messageGroup") || "").trim(); const deduplication = String(data.get("deduplication") || "").trim();
      const sent = await sqs("SendMessage", { QueueUrl: queue.url, MessageBody: String(data.get("body")), ...(!fifo ? { DelaySeconds: readDuration(data, "delay", "Delivery delay", 0, 900) } : {}), ...(group ? { MessageGroupId: group } : {}), ...(deduplication ? { MessageDeduplicationId: deduplication } : {}), ...(Object.keys(MessageAttributes).length ? { MessageAttributes } : {}), ...(trace ? { MessageSystemAttributes: { AWSTraceHeader: { DataType: "String", StringValue: trace } } } : {}) });
      sendResult.innerHTML = '<div class="alert success" role="status"><strong>Message sent</strong><br>Your message has been sent and is ready to be received. <button class="button link" type="button" data-view-sent>View details</button></div>';
      sendResult.querySelector("[data-view-sent]").addEventListener("click", () => openModal(context, "Message details", `<dl class="key-value"><dt>Message ID</dt><dd class="mono">${escapeHtml(sent.MessageId)}</dd><dt>MD5 of message body</dt><dd class="mono">${escapeHtml(sent.MD5OfMessageBody)}</dd><dt>MD5 of message attributes</dt><dd class="mono">${escapeHtml(sent.MD5OfMessageAttributes || "–")}</dd>${sent.MD5OfMessageSystemAttributes ? `<dt>MD5 of message system attributes</dt><dd class="mono">${escapeHtml(sent.MD5OfMessageSystemAttributes)}</dd>` : ""}<dt>Sequence number</dt><dd class="mono">${escapeHtml(sent.SequenceNumber || "–")}</dd></dl>`, "Done", async () => undefined, false, { refreshAfterSubmit: false }));
      context.toast(`Message sent · ${sent.MessageId}`);
      void refreshCounts();
    } catch (error) { context.showError(error); }
    finally { submit.disabled = false; }
  });

  // Receive messages
  const start = root.querySelector("[data-start-poll]"); const stop = root.querySelector("[data-stop-poll]");
  const status = root.querySelector("#sqs-poll-status"); const progress = root.querySelector("#sqs-poll-progress");
  const results = root.querySelector("#sqs-receive-results");
  const viewSelected = root.querySelector("[data-view-selected]"); const deleteSelected = root.querySelector("[data-delete-selected]");
  const selectedEntries = () => [...results.querySelectorAll("[data-select-message]:checked")].map(input => receivedMessages[Number(input.dataset.selectMessage)]).filter(Boolean);
  const syncSelection = () => { const count = selectedEntries().length; viewSelected.disabled = count !== 1; deleteSelected.disabled = !count; };
  const renderMessages = () => {
    if (!results.isConnected) return;
    root.querySelector("[data-message-count]").textContent = `(${receivedMessages.length})`;
    results.innerHTML = receivedMessages.length ? `<div class="table-wrap"><table class="sqs-message-table"><thead><tr><th><input type="checkbox" data-select-all aria-label="Select all messages"></th><th>ID</th><th>Sent</th><th>Size</th><th>Receive count</th></tr></thead><tbody>${receivedMessages.map((entry, index) => { const message = entry.message; const system = message.Attributes ?? {}; return `<tr data-received-message="${index}"><td><input type="checkbox" data-select-message="${index}" aria-label="Select message ${escapeHtml(message.MessageId)}"></td><td><button class="button link mono" type="button" data-view-message="${index}">${escapeHtml(message.MessageId)}</button></td><td>${system.SentTimestamp ? formatDate(Number(system.SentTimestamp)) : "–"}</td><td>${messageSize(byteLength(message.Body))}</td><td data-receive-count>${escapeHtml(system.ApproximateReceiveCount || "1")}</td></tr>`; }).join("")}</tbody></table></div>` : emptyState("✉", "No messages", "To view messages in the queue, poll for messages.");
    results.querySelectorAll("[data-view-message]").forEach(button => button.addEventListener("click", () => { const entry = receivedMessages[Number(button.dataset.viewMessage)]; if (entry) openMessageDialog(context, queue, entry, refreshCounts); }));
    results.querySelectorAll("[data-select-message]").forEach(input => input.addEventListener("change", syncSelection));
    results.querySelector("[data-select-all]")?.addEventListener("change", event => { results.querySelectorAll("[data-select-message]").forEach(input => { input.checked = event.target.checked; }); syncSelection(); });
    syncSelection();
  };
  const describeSettings = () => {
    root.querySelector("[data-poll-duration]").textContent = `${settings.duration} second${settings.duration === 1 ? "" : "s"}`;
    root.querySelector("[data-poll-maximum]").textContent = String(settings.maximum);
    root.querySelector("[data-poll-extra]").textContent = `Additional local settings: wait time ${settings.wait} second${settings.wait === 1 ? "" : "s"} per receive call · visibility timeout ${settings.visibility === "" ? `console default (messages become visible again when you poll again, leave this page, or ${CONSOLE_HOLD_SECONDS} seconds after polling ends)` : `${settings.visibility} second${Number(settings.visibility) === 1 ? "" : "s"}`} · poll attempts ${settings.attempts === "" ? "until the polling duration ends" : settings.attempts}.`;
  };
  const pause = (milliseconds, signal) => new Promise(resolve => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

  viewSelected.addEventListener("click", () => { const [entry] = selectedEntries(); if (entry) openMessageDialog(context, queue, entry, refreshCounts); });
  deleteSelected.addEventListener("click", () => {
    const entries = selectedEntries(); if (!entries.length) return;
    openModal(context, "Delete Messages", `<p>Are you sure you want to delete the following ${entries.length === 1 ? "message" : `${entries.length} messages`}? You can't undo this action.</p><ul class="sqs-message-ids">${entries.map(entry => `<li class="mono">${escapeHtml(entry.message.MessageId)}</li>`).join("")}</ul>`, "Delete", async () => {
      const failures = [];
      for (const entry of entries) {
        try { await sqs("DeleteMessage", { QueueUrl: queue.url, ReceiptHandle: entry.message.ReceiptHandle }); receivedMessages = receivedMessages.filter(candidate => candidate !== entry); }
        catch (error) { failures.push(error); }
      }
      renderMessages(); void refreshCounts();
      if (failures.length) throw failures[0];
      context.toast(entries.length === 1 ? "Message deleted" : `${entries.length} messages deleted`);
    }, false, { danger: true, refreshAfterSubmit: false });
  });
  root.querySelector("[data-edit-poll]").addEventListener("click", () => openModal(context, "Edit poll settings", `<div class="field"><label>Polling duration</label><input name="duration" type="number" min="1" max="3600" step="1" value="${settings.duration}" required><span class="hint">Seconds the console keeps polling for messages. Should be between 1 and 3600.</span></div><div class="field"><label>Maximum message count</label><input name="maximum" type="number" min="1" max="100" step="1" value="${settings.maximum}" required><span class="hint">Polling stops when this many messages are listed. Should be between 1 and 100.</span></div><details class="sqs-details" open><summary>Additional local settings</summary><div class="field"><label>Wait time (seconds)</label><input name="wait" type="number" min="0" max="20" step="1" value="${settings.wait}" required><span class="hint">Long-poll duration of each ReceiveMessage call.</span></div><div class="field"><label>Visibility timeout (seconds)</label><input name="visibility" type="number" min="0" max="43200" step="1" value="${settings.visibility}" placeholder="Console default"><span class="hint">Leave blank to hide received messages only while they are listed: they become visible again when you poll again, leave this page, or ${CONSOLE_HOLD_SECONDS} seconds after polling ends. Enter a value to hide them for exactly that long.</span></div><div class="field"><label>Poll attempts</label><input name="attempts" type="number" min="1" max="100" step="1" value="${settings.attempts}" placeholder="Until the polling duration ends"><span class="hint">Maximum number of ReceiveMessage calls in one poll.</span></div></details>`, "Save", async data => {
    Object.assign(settings, { duration: Number(data.get("duration")), maximum: Number(data.get("maximum")), wait: Number(data.get("wait")), visibility: String(data.get("visibility") ?? "").trim(), attempts: String(data.get("attempts") ?? "").trim() });
    describeSettings();
  }, false, { refreshAfterSubmit: false }));
  stop.addEventListener("click", () => { stopPolling(); status.textContent = "Stopping…"; });
  start.addEventListener("click", async () => {
    stopPolling();
    const controller = new AbortController(); activePoll = controller;
    start.disabled = true; stop.disabled = false; status.textContent = "Polling…"; progress.value = 0;
    try {
      // Messages from the previous poll become visible again first, so this poll can retrieve them.
      await releaseHeldMessages();
      renderMessages();
      const began = Date.now(); const deadline = began + settings.duration * 1_000;
      const limit = settings.attempts === "" ? Infinity : Number(settings.attempts);
      pollProgressTimer = setInterval(() => { progress.value = Math.min(100, ((Date.now() - began) / (settings.duration * 1_000)) * 100); }, 200);
      for (let attempt = 1; attempt <= limit && !controller.signal.aborted && receivedMessages.length < settings.maximum && Date.now() < deadline; attempt++) {
        const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
        const explicit = settings.visibility !== "";
        const visibility = explicit ? Number(settings.visibility) : Math.min(43_200, remaining + CONSOLE_HOLD_SECONDS);
        status.textContent = limit === Infinity ? "Polling…" : `Polling attempt ${attempt} of ${limit}…`;
        const requested = Date.now();
        const result = await sqs("ReceiveMessage", { QueueUrl: queue.url, MaxNumberOfMessages: Math.min(10, settings.maximum - receivedMessages.length), WaitTimeSeconds: Math.min(settings.wait, remaining), VisibilityTimeout: visibility, MessageAttributeNames: ["All"], MessageSystemAttributeNames: ["All"] }, { signal: controller.signal });
        let added = 0;
        for (const message of result.Messages ?? []) {
          const entry = { message, queueUrl: queue.url, autoRelease: !explicit, heldUntil: Date.now() + visibility * 1_000 };
          const known = receivedMessages.findIndex(candidate => candidate.message.MessageId === message.MessageId);
          if (known >= 0) receivedMessages[known] = entry; else { receivedMessages.push(entry); added++; }
        }
        if (result.Messages?.length) renderMessages();
        // A call that returned at once without anything new must not turn into a tight loop.
        if (!added && Date.now() - requested < 1_000) await pause(1_000 - (Date.now() - requested), controller.signal);
      }
      if (controller.signal.aborted) status.textContent = "Polling stopped";
      else { progress.value = 100; status.textContent = receivedMessages.length ? `${plural(receivedMessages.length, "message")} received` : "Poll completed with no messages"; }
    } catch (error) {
      if (error?.name === "AbortError") status.textContent = "Polling stopped";
      else { status.textContent = "Polling failed"; context.showError(error); }
    } finally {
      clearInterval(pollProgressTimer); pollProgressTimer = undefined;
      if (activePoll === controller) activePoll = undefined;
      if (start.isConnected) { start.disabled = false; stop.disabled = true; renderMessages(); void refreshCounts(); }
    }
  });
  describeSettings();
  renderMessages();
}

// ---------------------------------------------------------------------------
// Monitoring

const METRIC_RANGES = [
  { seconds: 3_600, label: "Last Hour", period: 60 },
  { seconds: 10_800, label: "Last 3 Hours", period: 60 },
  { seconds: 43_200, label: "Last 12 Hours", period: 300 },
  { seconds: 86_400, label: "Last Day", period: 300 },
  { seconds: 259_200, label: "Last 3 Days", period: 3_600 },
  { seconds: 604_800, label: "Last Week", period: 3_600 },
];

function metricDefinitions(fifo) {
  return [
    ["oldest", "Approximate Age Of Oldest Message", "ApproximateAgeOfOldestMessage", "Maximum", "Seconds"],
    ["delayed", "Approximate Number Of Messages Delayed", "ApproximateNumberOfMessagesDelayed", "Maximum", "Count"],
    ["inflight", "Approximate Number Of Messages Not Visible", "ApproximateNumberOfMessagesNotVisible", "Maximum", "Count"],
    ["visible", "Approximate Number Of Messages Visible", "ApproximateNumberOfMessagesVisible", "Maximum", "Count"],
    ["empty", "Number Of Empty Receives", "NumberOfEmptyReceives", "Sum", "Count"],
    ["deleted", "Number Of Messages Deleted", "NumberOfMessagesDeleted", "Sum", "Count"],
    ["received", "Number Of Messages Received", "NumberOfMessagesReceived", "Sum", "Count"],
    ["sent", "Number Of Messages Sent", "NumberOfMessagesSent", "Sum", "Count"],
    ["size", "Sent Message Size", "SentMessageSize", "Average", "Bytes"],
    ...(fifo
      ? [["groups", "Approximate Number Of Groups With Inflight Messages", "ApproximateNumberOfGroupsWithInflightMessages", "Maximum", "Count"], ["deduplicated", "Number Of Deduplicated Sent Messages", "NumberOfDeduplicatedSentMessages", "Sum", "Count"]]
      : [["noisy", "Approximate Number Of Noisy Groups", "ApproximateNumberOfNoisyGroups", "Maximum", "Count"], ["quiet", "Approximate Number Of Messages Visible In Quiet Groups", "ApproximateNumberOfMessagesVisibleInQuietGroups", "Maximum", "Count"]]),
  ];
}

async function monitoringPage(context, name) {
  const { queue, isDlq } = await loadQueue(name); const attributes = queue.attributes;
  const definitions = metricDefinitions(attributes.FifoQueue === "true");
  const graphs = async range => {
    const end = new Date(); const begin = new Date(end.getTime() - range.seconds * 1_000);
    const result = await metrics("GetMetricData", { StartTime: begin.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampAscending", MetricDataQueries: definitions.map(([Id, Label, MetricName, Stat]) => ({ Id, Label, MetricStat: { Metric: { Namespace: "AWS/SQS", MetricName, Dimensions: [{ Name: "QueueName", Value: name }] }, Period: range.period, Stat } })) });
    const byId = new Map((result.MetricDataResults ?? []).map(item => [item.Id, item]));
    return definitions.map(([id, title, , statistic, unit]) => { const item = byId.get(id); const latest = item?.Values?.at(-1); return `<figure class="sqs-metric-graph"><h3>${title}</h3>${metricChart([{ label: title, timestamps: item?.Timestamps ?? [], values: item?.Values ?? [] }], `${title} for ${name}`, { legend: false })}<figcaption class="muted small">${statistic} · ${unit}${latest === undefined ? "" : ` · latest ${Number(Number(latest).toFixed(2)).toLocaleString()}`}</figcaption></figure>`; }).join("");
  };
  const firstGraphs = await graphs(METRIC_RANGES[0]);
  setQueueChrome(context, name, "Monitoring");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-monitoring">${queueHeader(queue, isDlq)}${queueTabs(name, "monitoring")}<div class="sqs-metric-summary"><section class="card"><div class="card-body"><span class="metric">${integer(attributes.ApproximateNumberOfMessages).toLocaleString()}</span><span>Available</span></div></section><section class="card"><div class="card-body"><span class="metric">${integer(attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</span><span>In flight</span></div></section><section class="card"><div class="card-body"><span class="metric">${integer(attributes.ApproximateNumberOfMessagesDelayed).toLocaleString()}</span><span>Delayed</span></div></section></div><section class="card"><div class="card-header"><h2>SQS metrics</h2><div class="actions"><label class="sqs-time-range">Time Range <select data-time-range>${METRIC_RANGES.map((range, index) => `<option value="${index}">${range.label}</option>`).join("")}</select></label><button class="button refresh" type="button" data-action="refresh" title="Refresh" aria-label="Refresh monitoring">↻</button><a class="button" href="#/cloudwatch/metrics">View all CloudWatch metrics</a></div></div><div class="card-body"><div class="sqs-metric-grid" data-metric-graphs>${firstGraphs}</div></div></section><div class="alert info"><strong>Approximate labels retained</strong><br>The simulator can calculate exact local snapshots, but fields and metrics keep AWS's approximate names for SDK compatibility.</div></div>`;
  bindQueueHeader(context, queue);
  const select = context.main.querySelector("[data-time-range]"); const holder = context.main.querySelector("[data-metric-graphs]");
  const redraw = async () => {
    try { const markup = await graphs(METRIC_RANGES[Number(select.value)]); if (holder.isConnected) holder.innerHTML = markup; }
    catch (error) { context.showError(error); }
  };
  select.addEventListener("change", redraw);
  context.main.querySelector('[data-action="refresh"]').addEventListener("click", redraw);
}

// ---------------------------------------------------------------------------
// SNS subscriptions and EventBridge Pipes

async function snsSubscriptionsPage(context, name) {
  const { queue, isDlq } = await loadQueue(name);
  const subscriptions = await listQueueSubscriptions(queue.attributes.QueueArn);
  const policy = parsePolicy(queue.attributes.Policy);
  setQueueChrome(context, name, "SNS subscriptions");
  const rows = subscriptions.map(subscription => { const topic = queueNameFromArn(subscription.TopicArn); const allowed = policyAllowsTopic(policy, subscription.TopicArn); return `<tr><td class="mono">${escapeHtml(subscription.SubscriptionArn)}</td><td><a href="#/sns/topics/${encodeURIComponent(topic)}" class="mono">${escapeHtml(subscription.TopicArn)}</a></td><td><span class="status ${allowed ? "" : "inactive"}">${allowed ? "Allows this topic" : "No matching statement"}</span></td></tr>`; }).join("");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-sns-subscriptions">${queueHeader(queue, isDlq)}${queueTabs(name, "sns-subscriptions")}<section class="card"><div class="card-header"><h2>SNS subscriptions <span class="muted">(${subscriptions.length})</span></h2><div class="actions"><button class="button primary" type="button" data-subscribe-sns>Subscribe to Amazon SNS topic</button></div></div><div class="table-wrap">${subscriptions.length ? `<table><thead><tr><th>Subscription ARN</th><th>Topic ARN</th><th>Queue access policy</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("◇", "No SNS subscriptions", "This queue is not subscribed to an Amazon SNS topic. Subscribe it to receive the messages published to a topic.", '<button class="button" type="button" data-subscribe-sns>Subscribe to Amazon SNS topic</button>')}</div></section><div class="alert info"><strong>Delivery needs a queue policy statement</strong><br>A topic can deliver only when the queue's access policy allows <span class="mono">sns.amazonaws.com</span> to call <span class="mono">sqs:SendMessage</span> for that topic. Subscribing from this page adds the statement; the <a href="${queueHref(name, "queue-policies")}">Queue policies</a> tab shows it. Filter policies, raw message delivery and unsubscribing are managed from the <a href="#/sns/subscriptions">SNS subscriptions</a> page.</div></div>`;
  bindQueueHeader(context, queue);
  context.main.querySelectorAll("[data-subscribe-sns]").forEach(button => button.addEventListener("click", () => openSubscribeDialog(context, queue).catch(context.showError)));
}

async function pipesPage(context, name) {
  const { queue, isDlq } = await loadQueue(name);
  setQueueChrome(context, name, "EventBridge Pipes");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-pipes">${queueHeader(queue, isDlq)}${queueTabs(name, "eventbridge-pipes")}<section class="card"><div class="card-header"><h2>EventBridge Pipes <span class="muted">(0)</span></h2><div class="actions"><button class="button" type="button" disabled title="Connect Amazon SQS queue to pipe — ${UNAVAILABLE}">Connect Amazon SQS queue to pipe</button></div></div>${emptyState("◇", "EventBridge Pipes are not available in StackSim", "StackSim does not emulate EventBridge Pipes, so no pipe can use this queue as its source. To process the queue's messages, configure a Lambda function trigger.")}<div class="card-body"><p class="muted">In AWS this tab lists each pipe's name, status, target and last modified time. <a href="${queueHref(name, "lambda-triggers")}">Open Lambda triggers</a></p></div></section></div>`;
  bindQueueHeader(context, queue);
}

// ---------------------------------------------------------------------------
// Tagging, queue policies and encryption

async function taggingPage(context, name) {
  const { queue, isDlq } = await loadQueue(name, true); const entries = Object.entries(queue.tags);
  setQueueChrome(context, name, "Tagging");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-tagging">${queueHeader(queue, isDlq)}${queueTabs(name, "tagging")}<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${entries.length})</span></h2><div class="actions"><button class="button" type="button" data-manage-sqs-tags>Manage tags</button></div></div><div class="table-wrap">${entries.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${entries.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No tags", "Add tags to organize and authorize this queue.")}</div></section></div>`;
  bindQueueHeader(context, queue);
  context.main.querySelector("[data-manage-sqs-tags]").addEventListener("click", () => openTagsDialog(context, queue));
}

async function queuePoliciesPage(context, name) {
  const { queue, isDlq } = await loadQueue(name);
  const queueArn = queue.attributes.QueueArn;
  const s3Sources = [];
  const listedBuckets = await s3Request("/?max-buckets=100");
  for (const bucketNode of listedBuckets.xml.getElementsByTagName("Bucket")) {
    const bucket = bucketNode.getElementsByTagName("Name")[0]?.textContent;
    if (!bucket) continue;
    const notification = await s3Request(`/${encodeURIComponent(bucket)}?notification`);
    for (const config of notification.xml.getElementsByTagName("QueueConfiguration")) {
      const value = key => config.getElementsByTagName(key)[0]?.textContent ?? "";
      if (value("Queue") !== queueArn) continue;
      const rules = [...config.getElementsByTagName("FilterRule")];
      const ruleValue = (node, key) => node?.getElementsByTagName(key)[0]?.textContent ?? "";
      s3Sources.push({
        bucket,
        id: value("Id"),
        events: [...config.getElementsByTagName("Event")].map(node => node.textContent),
        prefix: ruleValue(rules.find(node => ruleValue(node, "Name") === "prefix"), "Value"),
        suffix: ruleValue(rules.find(node => ruleValue(node, "Name") === "suffix"), "Value"),
      });
    }
  }
  const account = ui.summary?.accountId ?? String(queueArn).split(":")[4] ?? "ACCOUNT_ID";
  const configured = Boolean(String(queue.attributes.Policy ?? "").trim());
  const policyDocument = parsePolicy(queue.attributes.Policy, { Version: "2012-10-17", Statement: [] });
  const diagnostics = policyDiagnostics(policyDocument, account);
  const eventBridgeTemplate = {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowEventBridgeRule",
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: queueArn,
      Condition: { ArnEquals: { "aws:SourceArn": "RULE_ARN" }, StringEquals: { "aws:SourceAccount": account } },
    }],
  };
  const s3Template = {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowS3BucketNotifications",
      Effect: "Allow",
      Principal: { Service: "s3.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: queueArn,
      Condition: { ArnEquals: { "aws:SourceArn": "arn:aws:s3:::BUCKET_NAME" }, StringEquals: { "aws:SourceAccount": account } },
    }],
  };
  const statementRows = diagnostics.statements.map((statement, index) => {
    const principals = principalEntries(statement.Principal ?? statement.NotPrincipal).map(principal => `${principal.type}: ${principal.value}`).join("; ") || "—";
    const actions = values(statement.Action ?? statement.NotAction).join(", ") || "—";
    return `<tr><td>${escapeHtml(statement.Sid || `Statement ${index + 1}`)}</td><td><span class="status ${statement.Effect === "Deny" ? "inactive" : ""}">${escapeHtml(statement.Effect)}</span></td><td>${escapeHtml(statement.NotPrincipal ? `NOT ${principals}` : principals)}</td><td class="mono">${escapeHtml(statement.NotAction ? `NOT ${actions}` : actions)}</td><td class="mono">${escapeHtml(sourceCondition(statement, "aws:SourceArn"))}</td><td>${escapeHtml(sourceCondition(statement, "aws:SourceAccount"))}</td></tr>`;
  }).join("");
  const warnings = `${diagnostics.publicAllows.length ? `<div class="alert warning"><strong>Public principal detected</strong><br>${diagnostics.publicAllows.length} Allow statement${diagnostics.publicAllows.length === 1 ? " uses" : "s use"} <span class="mono">Principal: "*"</span>. Verify its conditions carefully; an unscoped statement can authorize anonymous or broadly shared access.</div>` : ""}${diagnostics.crossAccounts.length ? `<div class="alert warning"><strong>Cross-account trust detected</strong><br>This policy trusts ${diagnostics.crossAccounts.map(value => `<span class="mono">${escapeHtml(value)}</span>`).join(", ")}. Cross-account callers still need an identity-policy Allow, and owner-only queue administration cannot be delegated.</div>` : ""}`;
  setQueueChrome(context, name, "Queue policies");
  const s3SourceRows = s3Sources.map(source => `<tr><td><a href="#/s3/buckets/${encodeURIComponent(source.bucket)}/properties">${escapeHtml(source.bucket)}</a></td><td>${escapeHtml(source.id)}</td><td>${escapeHtml(source.events.join(", "))}</td><td class="mono">${escapeHtml(`${source.prefix || "*"} … ${source.suffix || "*"}`)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-access-policy">${queueHeader(queue, isDlq)}${queueTabs(name, "queue-policies")}<div class="alert success"><strong>IAM and resource-policy authorization are active</strong><br>Queue API calls are evaluated against caller identity policies and the resource-based policy for <span class="mono">${escapeHtml(queueArn)}</span>. An explicit deny wins.</div>${warnings}<section class="card"><div class="card-header"><h2>Access policy</h2><div class="actions"><span class="status ${configured ? "" : "inactive"}">${configured ? "Configured" : "Not configured"}</span><button class="button" type="button" data-basic-sqs-policy>Edit</button><button class="button" type="button" data-add-sqs-policy>Add statement</button><button class="button" type="button" data-edit-sqs-policy>Edit JSON</button></div></div><div class="card-body"><p class="muted">Define who can access your queue. ${configured ? "" : "This queue has no resource-based policy, so only identity policies in its own account grant access."}</p><pre class="code-box">${escapeHtml(JSON.stringify(policyDocument, null, 2))}</pre></div></section>${redriveAllowCard(queue.attributes, "Edit")}<section class="card"><div class="card-header"><h2>Effective-access diagnostics</h2><span class="muted">${diagnostics.allows.length} allow · ${diagnostics.denies.length} deny</span></div><div class="card-body"><div class="sqs-summary-grid"><div><strong>Same account</strong><p class="muted">An identity-policy or queue-policy Allow can grant access.</p></div><div><strong>Cross account</strong><p class="muted">Both identity and queue policies must allow the action.</p></div><div><strong>Service publisher</strong><p class="muted">The queue policy must trust the exact service and source context.</p></div></div></div><div class="table-wrap">${diagnostics.statements.length ? `<table><thead><tr><th>Statement</th><th>Effect</th><th>Principal</th><th>Actions</th><th>Source ARN</th><th>Source account</th></tr></thead><tbody>${statementRows}</tbody></table>` : emptyState("◇", "No resource grants", "Identity policies can still authorize same-account callers. Add a statement for cross-account or service publishing.")}</div></section><section class="card eventbridge-queue-policy"><div class="card-header"><h2>EventBridge target authorization</h2><a href="#/eventbridge/rules">Open EventBridge rules</a></div><div class="card-body"><p>Grant <span class="mono">events.amazonaws.com</span> permission to call <span class="mono">sqs:SendMessage</span>, constrained to the exact rule ARN and source account.</p><dl class="key-value"><dt>Queue ARN</dt><dd class="mono">${escapeHtml(queueArn)}</dd><dt>Principal</dt><dd class="mono">events.amazonaws.com</dd><dt>Action</dt><dd class="mono">sqs:SendMessage</dd></dl><pre class="code-box">${escapeHtml(JSON.stringify(eventBridgeTemplate, null, 2))}</pre><p class="muted">A target execution role can provide identity permission instead. Cross-account delivery requires the role permission and a queue policy that trusts the source.</p></div></section><section class="card s3-queue-source-inventory"><div class="card-header"><h2>S3 notification authorization <span class="muted">(${s3Sources.length})</span></h2><span class="status">Available</span></div><div class="card-body"><p>S3 notifications use <span class="mono">s3.amazonaws.com</span> with the bucket ARN and bucket-owner account as exact source context. Object mutation is never rolled back when delivery is denied.</p><pre class="code-box">${escapeHtml(JSON.stringify(s3Template, null, 2))}</pre></div><div class="table-wrap">${s3Sources.length ? `<table><thead><tr><th>Bucket</th><th>Configuration</th><th>Events</th><th>Key filter</th></tr></thead><tbody>${s3SourceRows}</tbody></table>` : '<div class="card-body"><p class="muted">No bucket notification configuration currently targets this queue.</p></div>'}</div></section></div>`;
  bindQueueHeader(context, queue);
  context.main.querySelector("[data-basic-sqs-policy]").addEventListener("click", () => openAccessPolicyDialog(context, queue));
  context.main.querySelector("[data-edit-sqs-policy]").addEventListener("click", () => openAccessPolicyDialog(context, queue, { mode: "advanced", submitLabel: "Save policy" }));
  context.main.querySelector("[data-configure-redrive-allow]").addEventListener("click", () => openRedriveAllowDialog(context, queue));
  context.main.querySelector("[data-add-sqs-policy]").addEventListener("click", () => openModal(context, "Add queue-policy statement", `<div class="alert info"><strong>Basic statement generator</strong><br>The simulator validates the generated statement again against the full queue-policy grammar and quotas.</div><div class="field-row"><div class="field"><label>Statement ID</label><input name="sid" value="AllowEventBridgeRule" required></div><div class="field"><label>Effect</label><select name="effect"><option value="Allow">Allow</option><option value="Deny">Deny</option></select></div></div><div class="field-row"><div class="field"><label>Principal type</label><select name="principalType"><option value="Service">service</option><option value="AWS">account or IAM ARN</option><option value="Public">Public (*)</option></select></div><div class="field"><label>Principal</label><input name="principal" value="events.amazonaws.com" placeholder="events.amazonaws.com or 111122223333"></div></div><div class="field"><label>Actions</label><textarea name="actions">sqs:SendMessage</textarea><span class="hint">Separate actions with commas or new lines. Batch APIs use their documented parent actions.</span></div><div class="field-row"><div class="field"><label>Source ARN condition (optional)</label><input name="sourceArn" placeholder="arn:aws:events:${escapeHtml(ui.region)}:${escapeHtml(account)}:rule/orders"></div><div class="field"><label>Source account condition (optional)</label><input name="sourceAccount" value="${escapeHtml(account)}" pattern="[0-9]{12}"></div></div>`, "Add statement", async data => {
    const Sid = String(data.get("sid") ?? "").trim(); if (!Sid || /[^\x20-\x7e]/.test(Sid)) throw new Error("Statement ID must be a non-empty printable string");
    const principalType = String(data.get("principalType")); const principalValue = String(data.get("principal") ?? "").trim();
    if (principalType !== "Public" && !principalValue) throw new Error("Enter an account, IAM ARN, or service principal");
    const actions = String(data.get("actions") ?? "").split(/[\s,]+/).map(value => value.trim()).filter(Boolean).map(value => value.includes(":") ? value : `sqs:${value}`);
    if (!actions.length) throw new Error("Enter at least one SQS action");
    const sourceArn = String(data.get("sourceArn") ?? "").trim(); const sourceAccount = String(data.get("sourceAccount") ?? "").trim();
    if (sourceAccount && !/^\d{12}$/.test(sourceAccount)) throw new Error("Source account must contain 12 digits");
    const Condition = { ...(sourceArn ? { ArnEquals: { "aws:SourceArn": sourceArn } } : {}), ...(sourceAccount ? { StringEquals: { "aws:SourceAccount": sourceAccount } } : {}) };
    const statement = { Sid, Effect: String(data.get("effect")), Principal: principalType === "Public" ? "*" : { [principalType]: principalValue }, Action: actions.length === 1 ? actions[0] : actions, Resource: queueArn, ...(Object.keys(Condition).length ? { Condition } : {}) };
    const Statement = [...policyStatements(policyDocument).filter(existing => existing.Sid !== Sid), statement];
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { Policy: JSON.stringify({ Version: policyDocument.Version ?? "2012-10-17", ...(policyDocument.Id ? { Id: policyDocument.Id } : {}), Statement }) } });
    context.toast("Queue-policy statement added");
  }));
}

async function encryptionPage(context, name) {
  const { queue, isDlq } = await loadQueue(name);
  const managed = queue.attributes.SqsManagedSseEnabled === "true";
  setQueueChrome(context, name, "Encryption");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-encryption">${queueHeader(queue, isDlq)}${queueTabs(name, "encryption")}<div class="sqs-summary-grid"><section class="card"><div class="card-header"><h2>Encryption</h2><div class="actions"><button class="button" type="button" data-edit-sqs-encryption>Edit</button></div></div><div class="card-body"><dl class="key-value"><dt>Server-side encryption</dt><dd><span class="status ${managed ? "" : "inactive"}">${managed ? "Enabled" : "Disabled"}</span></dd><dt>Encryption key type</dt><dd>${managed ? "Amazon SQS key (SSE-SQS)" : "–"}</dd></dl><p>${managed ? "New messages are marked as using the queue's SQS-managed encryption mode." : "New messages are marked with SQS-managed encryption disabled."}</p><p class="muted">Changing this setting affects later writes. Existing encrypted messages remain readable across the change and restart.</p></div></section><section class="card"><div class="card-header"><h2>Private local payload storage</h2><span class="status">Always protected</span></div><div class="card-body"><p>Message bodies are authenticated-encrypted before the simulator writes them to its private durable payload store, independently of the SSE-SQS descriptor.</p><p class="muted">This local file protection is neither an Amazon SQS key nor a customer managed KMS key.</p></div></section></div><div class="alert warning"><strong>SSE-KMS is an explicit dependency</strong><br><span class="mono">KmsMasterKeyId</span> and <span class="mono">KmsDataKeyReusePeriodSeconds</span> are syntax-validated, but valid settings fail atomically with <span class="mono">UnsupportedOperation</span> because StackSim does not emulate KMS. The simulator never claims that a KMS ARN encrypted local queue data.</div><section class="card"><div class="card-header"><h2>Queue encryption attributes</h2></div><div class="card-body"><dl class="key-value"><dt>Queue ARN</dt><dd class="mono">${escapeHtml(queue.attributes.QueueArn)}</dd><dt>SqsManagedSseEnabled</dt><dd class="mono">${managed ? "true" : "false"}</dd><dt>KmsMasterKeyId</dt><dd>${escapeHtml(queue.attributes.KmsMasterKeyId || "Not configured")}</dd><dt>KmsDataKeyReusePeriodSeconds</dt><dd>${escapeHtml(queue.attributes.KmsDataKeyReusePeriodSeconds || "Not configured")}</dd><dt>Local storage protection</dt><dd>Installation-local authenticated encryption</dd></dl></div></section></div>`;
  bindQueueHeader(context, queue);
  context.main.querySelector("[data-edit-sqs-encryption]").addEventListener("click", () => openEncryptionDialog(context, queue));
}

// ---------------------------------------------------------------------------
// Dead-letter queue and redrive tasks

function taskDestination(task) {
  return task.DestinationArn ? `<a href="${queueHref(queueNameFromArn(task.DestinationArn), "messages")}">${escapeHtml(queueNameFromArn(task.DestinationArn))}</a>` : "Source queue(s)";
}

async function deadLetterPage(context, name) {
  const { queue, sourceUrls, isDlq } = await loadQueue(name); const attributes = queue.attributes; const redrive = parsePolicy(attributes.RedrivePolicy);
  const targetName = queueNameFromArn(redrive.deadLetterTargetArn);
  let latest; let taskError = "";
  try { latest = ((await sqs("ListMessageMoveTasks", { SourceArn: attributes.QueueArn, MaxResults: 1 })).Results ?? [])[0]; }
  catch (error) { taskError = error instanceof Error ? error.message : String(error); }
  setQueueChrome(context, name, "Dead-letter queue");
  const taskSummary = taskError ? `<p class="muted">Unable to list redrive tasks: ${escapeHtml(taskError)}</p>` : latest ? `<dl class="key-value"><dt>Latest task</dt><dd>${escapeHtml(latest.Status)}</dd><dt>Started</dt><dd>${escapeHtml(new Date(latest.StartedTimestamp).toLocaleString())}</dd><dt>Destination</dt><dd>${taskDestination(latest)}</dd><dt>Approx. moved / initial</dt><dd>${integer(latest.ApproximateNumberOfMessagesMoved)} / ${integer(latest.ApproximateNumberOfMessagesToMove)}</dd></dl>` : `<p class="muted">${isDlq ? "No redrive task has run for this queue." : "This queue is not used as a dead-letter queue, so it has no messages to redrive."}</p>`;
  context.main.innerHTML = `<div class="page-width sqs-console sqs-dead-letter">${queueHeader(queue, isDlq)}${queueTabs(name, "dead-letter")}<div class="sqs-dlq-grid"><section class="card"><div class="card-header"><h2>Dead-letter queue</h2><div class="actions"><span class="status ${redrive.deadLetterTargetArn ? "" : "inactive"}">${redrive.deadLetterTargetArn ? "Enabled" : "Disabled"}</span><button class="button" type="button" data-configure-redrive>Configure</button></div></div><div class="card-body">${redrive.deadLetterTargetArn ? `<dl class="key-value"><dt>Queue</dt><dd><a href="${queueHref(targetName, "dead-letter")}">${escapeHtml(targetName)}</a></dd><dt>Queue ARN</dt><dd class="mono">${escapeHtml(redrive.deadLetterTargetArn)}</dd><dt>Maximum receives</dt><dd>${escapeHtml(redrive.maxReceiveCount)}</dd></dl>` : emptyState("↳", "No dead-letter queue", "Configure a queue to receive messages after repeated unsuccessful deliveries.")}</div></section>${redriveAllowCard(attributes, "Configure")}</div><section class="card"><div class="card-header"><h2>Source queues <span class="muted">(${sourceUrls.length})</span></h2></div><div class="table-wrap">${sourceUrls.length ? `<table><thead><tr><th>Queue</th><th>Queue URL</th></tr></thead><tbody>${sourceUrls.map(url => `<tr><td><a href="${queueHref(queueNameFromUrl(url), "dead-letter")}">${escapeHtml(queueNameFromUrl(url))}</a></td><td class="mono">${escapeHtml(url)}</td></tr>`).join("")}</tbody></table>` : emptyState("↳", "No source queues", "No queue currently uses this queue as its dead-letter queue.")}</div></section><section class="card"><div class="card-header"><h2>DLQ redrive</h2><div class="actions">${startRedriveButton(isDlq)}<a class="button" href="${queueHref(name, "redrive-tasks")}">View redrive tasks</a></div></div><div class="card-body">${taskSummary}</div></section><div class="alert info"><strong>Receive-count diagnostics</strong><br>Poll messages on the Send and receive messages tab to inspect ApproximateReceiveCount. Messages move only after they exceed the configured maximum receive count.</div></div>`;
  bindQueueHeader(context, queue);
  context.main.querySelector("[data-configure-redrive]").addEventListener("click", () => openDeadLetterDialog(context, queue));
  context.main.querySelector("[data-configure-redrive-allow]").addEventListener("click", () => openRedriveAllowDialog(context, queue));
}

async function redriveTasksPage(context, name) {
  const { queue, isDlq } = await loadQueue(name); const attributes = queue.attributes;
  setQueueChrome(context, name, "Dead-letter queue redrive tasks");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-redrive-tasks">${queueHeader(queue, isDlq)}${queueTabs(name, "redrive-tasks")}<section class="card" data-move-panel><div class="card-header"><h2>Dead-letter queue redrive tasks</h2><div class="actions"><button class="button" type="button" data-refresh-moves>Refresh tasks</button>${startRedriveButton(isDlq, "button primary")}</div></div><div class="card-body"><p>Completion means messages reached their destination queue. Check the consumer's logs to verify successful application processing.</p><p class="muted">Up to 10 recent tasks. Counts are approximate. Cancellation leaves committed messages at the destination. Requires task permissions and receive/delete/get-attributes on this DLQ, plus send on destinations. KMS and VPC endpoint dependencies are unavailable.</p>${isDlq ? "" : `<p class="muted">Start DLQ redrive is available once another queue names this queue as its dead-letter queue. <a href="${queueHref(name, "dead-letter")}">Open Dead-letter queue</a></p>`}<div data-move-history aria-live="polite">Loading tasks…</div></div></section></div>`;
  bindQueueHeader(context, queue);
  const panel = context.main.querySelector("[data-move-panel]");
  const refreshMoves = async () => {
    clearTimeout(moveHistoryTimer);
    if (!panel.isConnected) return;
    const history = panel.querySelector("[data-move-history]");
    try {
      const { Results = [] } = await sqs("ListMessageMoveTasks", { SourceArn: attributes.QueueArn, MaxResults: 10 });
      if (!panel.isConnected) return;
      const active = Results.some(task => ["RUNNING", "CANCELLING"].includes(task.Status));
      context.main.querySelectorAll("[data-start-move]").forEach(button => { button.disabled = !isDlq || active; });
      history.innerHTML = Results.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Status</th><th>Destination</th><th>Approx. moved / initial</th><th>Max. messages/sec</th><th>Failure reason</th><th>Action</th></tr></thead><tbody>${Results.map(task => `<tr><td>${escapeHtml(new Date(task.StartedTimestamp).toLocaleString())}</td><td>${escapeHtml(task.Status)}</td><td>${taskDestination(task)}</td><td>${integer(task.ApproximateNumberOfMessagesMoved)} / ${integer(task.ApproximateNumberOfMessagesToMove)}</td><td>${task.MaxNumberOfMessagesPerSecond ?? "System optimized"}</td><td>${escapeHtml(task.FailureReason ?? "—")}</td><td>${task.TaskHandle ? `<button class="button" type="button" data-cancel-move="${escapeHtml(task.TaskHandle)}">Cancel DLQ redrive</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : "No redrive tasks yet.";
      history.querySelectorAll("[data-cancel-move]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        try { await sqs("CancelMessageMoveTask", { TaskHandle: button.dataset.cancelMove }); context.toast("Redrive cancellation requested"); await refreshMoves(); }
        catch (error) { button.disabled = false; context.toast(error.message); }
      }));
      if (active) moveHistoryTimer = setTimeout(refreshMoves, 1000);
    } catch (error) { history.textContent = `Unable to list redrive tasks: ${error.message}. Listing requires sqs:ListMessageMoveTasks and sqs:GetQueueAttributes.`; }
  };
  panel.querySelector("[data-refresh-moves]").addEventListener("click", refreshMoves);
  await refreshMoves();
}

// ---------------------------------------------------------------------------
// Lambda triggers

async function lambdaTriggersPage(context, name) {
  const { queue, isDlq } = await loadQueue(name); const queueArn = queue.attributes.QueueArn; const fifo = queue.attributes.FifoQueue === "true";
  const listed = await rest(`/2015-03-31/event-source-mappings?EventSourceArn=${encodeURIComponent(queueArn)}&MaxItems=100`);
  const mappings = listed.EventSourceMappings ?? [];
  setQueueChrome(context, name, "Lambda triggers");
  context.main.innerHTML = `<div class="page-width sqs-console sqs-lambda-triggers">${queueHeader(queue, isDlq)}${queueTabs(name, "lambda-triggers")}<div class="alert info"><strong>${fifo ? "FIFO group ordering" : "At-least-once worker delivery"}</strong><br>${fifo ? "Lambda processes each message group in order while independent groups can run concurrently. FIFO batch size is limited to 10 and batching windows are disabled." : "Lambda deletes messages only after successful handling. Function errors and throttles leave messages in flight until their visibility timeout expires."}</div><section class="card"><div class="card-header"><h2>Lambda triggers <span class="muted">(${mappings.length})</span></h2><div class="actions"><button class="button primary" type="button" data-add-sqs-trigger>Configure Lambda function trigger</button></div></div><div class="table-wrap">${mappings.length ? `<table><thead><tr><th>Function</th><th>State</th><th>Batch</th><th>Maximum concurrency</th><th>Partial failures</th><th>Last processing result</th><th>Actions</th></tr></thead><tbody>${mappings.map(mapping => { const functionName = functionNameFromArn(mapping.FunctionArn); return `<tr><td><a href="#/lambda/functions/${encodeURIComponent(functionName)}">${escapeHtml(functionName)}</a><div class="muted small mono">${escapeHtml(mapping.UUID)}</div></td><td><span class="status ${mapping.State === "Disabled" ? "inactive" : ""}">${escapeHtml(mapping.State)}</span></td><td>${integer(mapping.BatchSize, 10)} · ${integer(mapping.MaximumBatchingWindowInSeconds)}s</td><td>${escapeHtml(mapping.ScalingConfig?.MaximumConcurrency ?? "Unbounded")}</td><td>${mapping.FunctionResponseTypes?.includes("ReportBatchItemFailures") ? "Enabled" : "Full batch"}</td><td>${escapeHtml(mapping.LastProcessingResult || "No messages processed")}</td><td class="no-wrap"><button class="button link" type="button" data-toggle-sqs-trigger="${escapeHtml(mapping.UUID)}" data-enabled="${mapping.State !== "Disabled"}">${mapping.State === "Disabled" ? "Enable" : "Disable"}</button><button class="button link danger" type="button" data-delete-sqs-trigger="${escapeHtml(mapping.UUID)}">Delete</button></td></tr>`; }).join("")}</tbody></table>` : emptyState("↯", "No Lambda triggers", "Configure a Lambda function to consume messages from this queue.", '<button class="button" type="button" data-add-sqs-trigger>Configure Lambda function trigger</button>')}</div></section></div>`;
  bindQueueHeader(context, queue);
  context.main.querySelectorAll("[data-add-sqs-trigger]").forEach(button => button.addEventListener("click", () => openTriggerDialog(context, queue).catch(context.showError)));
  context.main.querySelectorAll("[data-toggle-sqs-trigger]").forEach(button => button.addEventListener("click", async () => {
    try { await rest(`/2015-03-31/event-source-mappings/${encodeURIComponent(button.dataset.toggleSqsTrigger)}`, "PUT", { Enabled: button.dataset.enabled !== "true" }); context.toast(`Trigger ${button.dataset.enabled === "true" ? "disabled" : "enabled"}`); await context.route(); }
    catch (error) { context.showError(error); }
  }));
  context.main.querySelectorAll("[data-delete-sqs-trigger]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deleteSqsTrigger, "Delete this SQS trigger? Unprocessed messages remain in the queue.", async () => { await rest(`/2015-03-31/event-source-mappings/${encodeURIComponent(button.dataset.deleteSqsTrigger)}`, "DELETE"); context.toast("SQS trigger deleted"); })));
}

// ---------------------------------------------------------------------------
// Routing

const sectionPages = {
  details: detailsPage,
  messages: messagesPage,
  monitoring: monitoringPage,
  "sns-subscriptions": snsSubscriptionsPage,
  "lambda-triggers": lambdaTriggersPage,
  "eventbridge-pipes": pipesPage,
  "dead-letter": deadLetterPage,
  tagging: taggingPage,
  "queue-policies": queuePoliciesPage,
  encryption: encryptionPage,
  "redrive-tasks": redriveTasksPage,
  edit: queueFormPage,
};

export async function routeSqs(parts, context) {
  leavePage();
  if (parts[0] !== metadata.key) return false;
  const render = async pending => {
    const result = await pending;
    decorateSqsPanelHelp(context.main);
    return result;
  };
  if (parts.length === 1) return render(overview(context));
  if (parts[1] !== "queues") return context.notFound(parts);
  if (parts.length === 2) return render(queuesPage(context));
  if (!parts[2] || parts.length > 4) return context.notFound(parts);
  // "create" alone opens the create page; a queue with that name is still reachable through its tab routes.
  if (parts.length === 3 && parts[2] === "create") return render(queueFormPage(context));
  const name = parts[2]; const requested = parts[3] ?? "details";
  const page = sectionPages[SECTION_ALIASES[requested] ?? requested];
  if (!page) return context.notFound(parts);
  return render(page(context, name));
}
