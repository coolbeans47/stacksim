import { metrics, rest, s3Request, sqs } from "../api-client.js";
import { confirmationDialog, emptyState, escapeHtml, formatDate, metricChart, pageHeader, tabs } from "../components.js";
import { session as ui } from "../state.js";
import { decorateSqsPanelHelp } from "./sqs-help.js";

export const metadata = {
  key: "sqs",
  name: "SQS",
  icon: "Q",
  cls: "sqs",
  links: [["Overview", "#/sqs"], ["Queues", "#/sqs/queues"]],
  search: ["sqs", "queue", "message", "visibility", "dead letter", "dlq", "worker", "fifo", "fair", "deduplication", "message group"],
};

const inspectLimit = 64 * 1024;
let activePoll;
let receivedMessages = [];

function stopPolling() {
  if (activePoll) activePoll.abort();
  activePoll = undefined;
}

if (typeof window !== "undefined") window.addEventListener("hashchange", stopPolling);

function queueNameFromUrl(queueUrl = "") {
  try { return decodeURIComponent(new URL(queueUrl, location.origin).pathname.split("/").filter(Boolean).at(-1) ?? ""); }
  catch { return decodeURIComponent(String(queueUrl).replace(/\/+$/, "").split("/").at(-1) ?? ""); }
}

function queueNameFromArn(arn = "") { return String(arn).split(":").at(-1) ?? ""; }
function functionNameFromArn(arn = "") { return String(arn).split(":function:")[1]?.split(":")[0] ?? String(arn); }
function integer(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function compactText(value, maximum = inspectLimit) { const text = String(value ?? ""); return text.length > maximum ? `${text.slice(0, maximum)}\n… truncated locally after ${maximum.toLocaleString()} characters` : text; }

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function stringMap(value, label) {
  const parsed = parseObject(value, label);
  if (Object.values(parsed).some(item => typeof item !== "string")) throw new Error(`${label} values must be strings`);
  return parsed;
}

function parsePolicy(value, fallback = {}) {
  if (!value) return fallback;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback; }
  catch { return fallback; }
}

function values(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

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

function policyDiagnostics(document, accountId) {
  const statements = policyStatements(document);
  const allows = statements.filter(statement => statement.Effect === "Allow");
  const denies = statements.filter(statement => statement.Effect === "Deny");
  const publicAllows = allows.filter(statement => principalEntries(statement.Principal).some(principal => principal.value === "*"));
  const crossAccounts = [...new Set(allows.flatMap(statement => principalEntries(statement.Principal)).map(principal => principal.type === "AWS" ? principalAccount(principal.value) : undefined).filter(value => value && value !== accountId))];
  return { statements, allows, denies, publicAllows, crossAccounts };
}

function sourceCondition(statement, key) {
  for (const conditions of Object.values(statement?.Condition ?? {})) for (const [candidate, value] of Object.entries(conditions ?? {})) if (candidate.toLowerCase() === key.toLowerCase()) return values(value).map(String).join(", ");
  return "—";
}

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

function queueTabs(queue, active) {
  const root = `#/sqs/queues/${encodeURIComponent(queue)}`;
  return tabs([
    { label: "Details", href: `${root}/details`, active: active === "details" },
    { label: "Send and receive messages", href: `${root}/messages`, active: active === "messages" },
    { label: "Monitoring", href: `${root}/monitoring`, active: active === "monitoring" },
    { label: "Dead-letter queue", href: `${root}/dead-letter`, active: active === "dead-letter" },
    { label: "Access policy", href: `${root}/access-policy`, active: active === "access-policy" },
    { label: "Encryption", href: `${root}/encryption`, active: active === "encryption" },
    { label: "Tags", href: `${root}/tags`, active: active === "tags" },
    { label: "Lambda triggers", href: `${root}/lambda-triggers`, active: active === "lambda-triggers" },
  ]);
}

function setQueueChrome(context, name, extra) {
  context.setChrome("sqs", ["SQS", "Queues", name, ...(extra ? [extra] : [])]);
}

function bindCreateQueue(context) {
  document.querySelectorAll('[data-action="create-sqs-queue"]').forEach(button => button.addEventListener("click", () => {
    context.showModal("Create queue", `<div class="alert info"><strong>Standard and FIFO queues</strong><br>Standard queues support optional fair-queue message groups. FIFO queues preserve strict order within each message group and require the immutable <span class="mono">.fifo</span> suffix.</div>
      <div class="field-row"><div class="field"><label>Queue type</label><select name="type"><option value="standard">Standard</option><option value="fifo">FIFO</option></select></div><div class="field"><label>Queue name</label><input name="name" required maxlength="80" pattern="[A-Za-z0-9_.-]{1,80}" placeholder="local-jobs"></div></div>
      <div class="field-row"><div class="field"><label>Visibility timeout (seconds)</label><input name="visibility" type="number" min="0" max="43200" value="30" required></div><div class="field"><label>Delivery delay (seconds)</label><input name="delay" type="number" min="0" max="900" value="0" required></div></div>
      <div class="field-row"><div class="field"><label>Message retention (seconds)</label><input name="retention" type="number" min="60" max="1209600" value="345600" required></div><div class="field"><label>Maximum message size (bytes)</label><input name="maximumSize" type="number" min="1024" max="1048576" value="1048576" required></div></div>
      <div class="field"><label>Receive wait time (seconds)</label><input name="wait" type="number" min="0" max="20" value="0" required><span class="hint">This is the default long-poll duration for consumers.</span></div>
      <div class="field"><label class="checkbox-label"><input type="checkbox" name="sqsManagedSse" value="yes" checked> Enable SQS-managed server-side encryption</label><span class="hint">New queues default to SSE-SQS. This setting is separate from the simulator's always-private local payload store.</span></div>
      <div class="field-row"><div class="field"><label class="checkbox-label"><input type="checkbox" name="contentDeduplication" value="yes"> Content-based deduplication (FIFO)</label><span class="hint">Uses a SHA-256 body hash when an explicit deduplication ID is omitted.</span></div><div class="field"><label>Deduplication scope (FIFO)</label><select name="deduplicationScope"><option value="queue">Queue</option><option value="messageGroup">Message group</option></select></div></div>
      <div class="field"><label>FIFO throughput limit</label><select name="fifoThroughput"><option value="perQueue">Per queue</option><option value="perMessageGroupId">Per message group ID</option></select><span class="hint">Per-message-group throughput requires message-group deduplication scope.</span></div>
      <div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>`, "Create queue", async data => {
      const fifo = data.get("type") === "fifo"; const name = String(data.get("name"));
      const result = await sqs("CreateQueue", {
        QueueName: name,
        Attributes: {
          VisibilityTimeout: String(Number(data.get("visibility"))),
          DelaySeconds: String(Number(data.get("delay"))),
          MessageRetentionPeriod: String(Number(data.get("retention"))),
          MaximumMessageSize: String(Number(data.get("maximumSize"))),
          ReceiveMessageWaitTimeSeconds: String(Number(data.get("wait"))),
          SqsManagedSseEnabled: data.get("sqsManagedSse") === "yes" ? "true" : "false",
          ...(fifo ? { FifoQueue: "true", ContentBasedDeduplication: data.get("contentDeduplication") === "yes" ? "true" : "false", DeduplicationScope: String(data.get("deduplicationScope")), FifoThroughputLimit: String(data.get("fifoThroughput")) } : {}),
        },
        tags: stringMap(data.get("tags"), "Tags"),
      });
      context.toast("Queue created");
      location.hash = `#/sqs/queues/${encodeURIComponent(queueNameFromUrl(result.QueueUrl) || name)}/details`;
    });
  }));
}

async function overview(context) {
  const queues = await queueCatalog();
  const visible = queues.reduce((sum, queue) => sum + integer(queue.attributes.ApproximateNumberOfMessages), 0);
  const inFlight = queues.reduce((sum, queue) => sum + integer(queue.attributes.ApproximateNumberOfMessagesNotVisible), 0);
  context.setChrome("sqs", ["SQS", "Overview"]);
  context.main.innerHTML = `<div class="page-width">${pageHeader("SQS", "Durable local queues for decoupled producers, ordered workers, retries, and dead-letter workflows.", '<button class="button primary" data-action="create-sqs-queue">Create queue</button>')}<div class="dashboard-grid"><section class="card"><div class="card-header"><h2>Queues</h2></div><div class="card-body"><div class="metric">${queues.length}</div><p class="muted">Standard and FIFO queues in ${escapeHtml(ui.region)}</p><a href="#/sqs/queues">View queues</a></div></section><section class="card"><div class="card-header"><h2>Available messages</h2></div><div class="card-body"><div class="metric">${visible}</div><p class="muted">Currently eligible for receive</p></div></section><section class="card"><div class="card-header"><h2>In flight</h2></div><div class="card-body"><div class="metric">${inFlight}</div><p class="muted">Received and inside their visibility timeout</p></div></section></div><section class="card"><div class="card-header"><h2>Development behavior</h2></div><div class="card-body"><p>Messages, delays, visibility leases, receive counts, FIFO deduplication, and redrive state survive simulator restart. Standard delivery remains at least once, so workers should be idempotent.</p><p class="muted">Fair scheduling is deterministic and bounded locally; it does not reproduce distributed throughput.</p></div></section></div>`;
  bindCreateQueue(context);
}

async function queuesPage(context) {
  const queues = await queueCatalog();
  context.setChrome("sqs", ["SQS", "Queues"]);
  context.main.innerHTML = `<div class="page-width sqs-queues-page">${pageHeader("Queues", "Create and inspect regional Standard and FIFO queues.", '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh queues">↻</button><button class="button primary" data-action="create-sqs-queue">Create queue</button>')}<section class="card"><div class="card-header"><h2>Queues <span class="muted">(${queues.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find queues"></label></div><div class="table-wrap">${queues.length ? `<table class="sqs-queue-table"><thead><tr><th>Name</th><th>Type</th><th>Messages available</th><th>Messages in flight</th><th>Created</th><th>Queue URL</th></tr></thead><tbody>${queues.map(queue => `<tr data-search-row="${escapeHtml(`${queue.name} ${queue.url}`.toLowerCase())}"><td><a href="#/sqs/queues/${encodeURIComponent(queue.name)}/details">${escapeHtml(queue.name)}</a></td><td>${queue.attributes.FifoQueue === "true" ? "FIFO" : "Standard"}</td><td>${integer(queue.attributes.ApproximateNumberOfMessages).toLocaleString()}</td><td>${integer(queue.attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</td><td>${formatDate(integer(queue.attributes.CreatedTimestamp))}</td><td><span class="mono sqs-queue-url">${escapeHtml(queue.url)}</span></td></tr>`).join("")}</tbody></table>` : emptyState("Q", "No queues", "Create a Standard or FIFO queue to send and receive local messages.", '<button class="button primary" data-action="create-sqs-queue">Create queue</button>')}</div></section></div>`;
  context.bindTableFilter();
  bindCreateQueue(context);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

function bindQueueDeletion(context, queue) {
  document.querySelectorAll("[data-delete-sqs-queue]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(queue.name, `Delete queue ${queue.name}? Messages, receipts, and trigger references must no longer be needed.`, async () => {
    await sqs("DeleteQueue", { QueueUrl: queue.url });
    context.toast("Queue deleted");
    location.hash = "#/sqs/queues";
  })));
}

function bindQueuePurge(context, queue) {
  document.querySelectorAll("[data-purge-sqs-queue]").forEach(button => button.addEventListener("click", () => context.showModal("Purge queue", `${confirmationDialog(queue.name, `Purge every visible, delayed, and in-flight message from ${queue.name}? This cannot be undone.`)}<div class="alert warning"><strong>Purge cooldown</strong><br>A queue cannot be purged again until the service cooldown has elapsed.</div>`, "Purge", async data => {
    if (data.get("confirmation") !== queue.name) throw new Error(`Enter ${queue.name} to confirm`);
    await sqs("PurgeQueue", { QueueUrl: queue.url });
    context.toast("Queue purged");
  }, false, { danger: true })));
}

async function detailsPage(context, name) {
  const queue = await describeQueue(name, true); const attributes = queue.attributes; const fifo = attributes.FifoQueue === "true";
  setQueueChrome(context, name, "Details");
  const fifoDetails = fifo ? `<section class="card"><div class="card-header"><h2>FIFO configuration</h2></div><div class="card-body"><dl class="key-value"><dt>Content-based deduplication</dt><dd>${attributes.ContentBasedDeduplication === "true" ? "Enabled" : "Disabled"}</dd><dt>Deduplication scope</dt><dd>${escapeHtml(attributes.DeduplicationScope)}</dd><dt>Throughput limit</dt><dd>${escapeHtml(attributes.FifoThroughputLimit)}</dd></dl><p class="muted">Queue type and the <span class="mono">.fifo</span> suffix are immutable.</p></div></section>` : `<section class="card"><div class="card-header"><h2>Fair queue behavior</h2></div><div class="card-body"><p>Supplying <span class="mono">MessageGroupId</span> enables deterministic bounded-fair local scheduling for Standard messages.</p><p class="muted">the provider's internal distributed fairness algorithm and production throughput are not reproduced.</p></div></section>`;
  context.main.innerHTML = `<div class="page-width sqs-detail">${pageHeader(name, attributes.QueueArn || queue.url, '<button class="button" data-purge-sqs-queue>Purge</button><button class="button" data-edit-sqs-attributes>Edit</button><button class="button danger" data-delete-sqs-queue>Delete</button>')}${queueTabs(name, "details")}<div class="sqs-summary-grid"><section class="card"><div class="card-header"><h2>Queue details</h2></div><div class="card-body"><dl class="key-value"><dt>Type</dt><dd>${fifo ? "FIFO" : "Standard"}</dd><dt>Queue ARN</dt><dd class="mono">${escapeHtml(attributes.QueueArn)}</dd><dt>Queue URL</dt><dd class="mono">${escapeHtml(queue.url)}</dd><dt>Created</dt><dd>${formatDate(integer(attributes.CreatedTimestamp))}</dd><dt>Last updated</dt><dd>${formatDate(integer(attributes.LastModifiedTimestamp))}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Message state</h2></div><div class="card-body"><dl class="key-value"><dt>Available</dt><dd class="metric">${integer(attributes.ApproximateNumberOfMessages).toLocaleString()}</dd><dt>In flight</dt><dd>${integer(attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</dd><dt>Delayed</dt><dd>${integer(attributes.ApproximateNumberOfMessagesDelayed).toLocaleString()}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Configuration</h2></div><div class="card-body"><dl class="key-value"><dt>Visibility timeout</dt><dd>${integer(attributes.VisibilityTimeout)} sec</dd><dt>Delivery delay</dt><dd>${integer(attributes.DelaySeconds)} sec</dd><dt>Receive wait time</dt><dd>${integer(attributes.ReceiveMessageWaitTimeSeconds)} sec</dd><dt>Retention</dt><dd>${integer(attributes.MessageRetentionPeriod).toLocaleString()} sec</dd><dt>Maximum message size</dt><dd>${integer(attributes.MaximumMessageSize).toLocaleString()} bytes</dd></dl></div></section>${fifoDetails}</div><section class="card"><div class="card-header"><h2>Tags <span class="muted">(${Object.keys(queue.tags).length})</span></h2><a href="#/sqs/queues/${encodeURIComponent(name)}/tags">Manage tags</a></div><div class="table-wrap">${Object.keys(queue.tags).length ? `<table><tbody>${Object.entries(queue.tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : '<div class="card-body muted">No tags configured.</div>'}</div></section></div>`;
  document.querySelector("[data-edit-sqs-attributes]")?.addEventListener("click", () => context.showModal("Edit queue configuration", `<div class="alert info"><strong>${fifo ? "FIFO" : "Standard"} queue</strong><br>The queue type cannot be changed after creation.</div><div class="field-row"><div class="field"><label>Visibility timeout (seconds)</label><input name="visibility" type="number" min="0" max="43200" value="${escapeHtml(attributes.VisibilityTimeout)}" required></div><div class="field"><label>Delivery delay (seconds)</label><input name="delay" type="number" min="0" max="900" value="${escapeHtml(attributes.DelaySeconds)}" required></div></div><div class="field-row"><div class="field"><label>Message retention (seconds)</label><input name="retention" type="number" min="60" max="1209600" value="${escapeHtml(attributes.MessageRetentionPeriod)}" required></div><div class="field"><label>Maximum message size (bytes)</label><input name="maximumSize" type="number" min="1024" max="1048576" value="${escapeHtml(attributes.MaximumMessageSize)}" required></div></div><div class="field"><label>Receive wait time (seconds)</label><input name="wait" type="number" min="0" max="20" value="${escapeHtml(attributes.ReceiveMessageWaitTimeSeconds)}" required></div>${fifo ? `<div class="field-row"><div class="field"><label class="checkbox-label"><input type="checkbox" name="contentDeduplication" value="yes" ${attributes.ContentBasedDeduplication === "true" ? "checked" : ""}> Content-based deduplication</label></div><div class="field"><label>Deduplication scope</label><select name="deduplicationScope"><option value="queue" ${attributes.DeduplicationScope === "queue" ? "selected" : ""}>Queue</option><option value="messageGroup" ${attributes.DeduplicationScope === "messageGroup" ? "selected" : ""}>Message group</option></select></div></div><div class="field"><label>FIFO throughput limit</label><select name="fifoThroughput"><option value="perQueue" ${attributes.FifoThroughputLimit === "perQueue" ? "selected" : ""}>Per queue</option><option value="perMessageGroupId" ${attributes.FifoThroughputLimit === "perMessageGroupId" ? "selected" : ""}>Per message group ID</option></select></div>` : ""}`, "Save", async data => {
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { VisibilityTimeout: String(Number(data.get("visibility"))), DelaySeconds: String(Number(data.get("delay"))), MessageRetentionPeriod: String(Number(data.get("retention"))), MaximumMessageSize: String(Number(data.get("maximumSize"))), ReceiveMessageWaitTimeSeconds: String(Number(data.get("wait"))), ...(fifo ? { ContentBasedDeduplication: data.get("contentDeduplication") === "yes" ? "true" : "false", DeduplicationScope: String(data.get("deduplicationScope")), FifoThroughputLimit: String(data.get("fifoThroughput")) } : {}) } });
    context.toast("Queue configuration updated");
  }));
  bindQueuePurge(context, queue);
  bindQueueDeletion(context, queue);
}

function messageCard(message, index) {
  const attributes = message.Attributes ?? {};
  return `<article class="card sqs-message-card" data-received-message="${index}"><div class="card-header"><div><h2>Message ${index + 1}</h2><p class="muted small mono">${escapeHtml(message.MessageId)}</p></div><div class="actions"><button class="button" data-change-message-visibility="${index}">Change visibility</button><button class="button danger" data-delete-message="${index}">Delete</button></div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Receive count</dt><dd>${escapeHtml(attributes.ApproximateReceiveCount || "1")}</dd><dt>Sent</dt><dd>${attributes.SentTimestamp ? formatDate(Number(attributes.SentTimestamp)) : "–"}</dd><dt>First received</dt><dd>${attributes.ApproximateFirstReceiveTimestamp ? formatDate(Number(attributes.ApproximateFirstReceiveTimestamp)) : "–"}</dd><dt>Message group</dt><dd class="mono">${escapeHtml(attributes.MessageGroupId || "–")}</dd></dl><dl class="key-value"><dt>Sequence number</dt><dd class="mono">${escapeHtml(attributes.SequenceNumber || "–")}</dd><dt>Deduplication ID</dt><dd class="mono">${escapeHtml(attributes.MessageDeduplicationId || "–")}</dd><dt>Body MD5</dt><dd class="mono">${escapeHtml(message.MD5OfBody)}</dd><dt>Sender</dt><dd class="mono">${escapeHtml(attributes.SenderId || "–")}</dd></dl></div><div class="field-label">Body</div><pre class="code-box sqs-message-body">${escapeHtml(compactText(message.Body))}</pre><div class="field-label">Message attributes</div><pre class="code-box">${escapeHtml(compactText(JSON.stringify(message.MessageAttributes ?? {}, null, 2), 32 * 1024))}</pre><div class="field-label">System attributes</div><pre class="code-box">${escapeHtml(compactText(JSON.stringify(attributes, null, 2), 32 * 1024))}</pre></div></article>`;
}

function renderReceivedMessages(context, queue, messages) {
  receivedMessages = messages;
  const target = document.querySelector("#sqs-receive-results");
  if (!target) return;
  target.innerHTML = messages.length ? messages.map(messageCard).join("") : emptyState("⌕", "No messages received", "No eligible messages were returned during the bounded poll.");
  target.querySelectorAll("[data-delete-message]").forEach(button => button.addEventListener("click", async () => {
    const index = Number(button.dataset.deleteMessage); const message = receivedMessages[index]; if (!message) return;
    button.disabled = true;
    try { await sqs("DeleteMessage", { QueueUrl: queue.url, ReceiptHandle: message.ReceiptHandle }); target.querySelector(`[data-received-message="${index}"]`)?.remove(); context.toast("Message deleted"); if (!target.querySelector("[data-received-message]")) target.innerHTML = emptyState("✓", "No inspected messages", "The received messages were deleted."); }
    catch (error) { button.disabled = false; context.showError(error); }
  }));
  target.querySelectorAll("[data-change-message-visibility]").forEach(button => button.addEventListener("click", () => {
    const index = Number(button.dataset.changeMessageVisibility); const message = receivedMessages[index]; if (!message) return;
    context.showModal("Change message visibility", `<div class="field"><label>Visibility timeout (seconds)</label><input name="visibility" type="number" min="0" max="43200" value="30" required><span class="hint">Set 0 to make the message immediately eligible for another receive.</span></div><p class="muted mono">${escapeHtml(message.MessageId)}</p>`, "Change visibility", async data => { await sqs("ChangeMessageVisibility", { QueueUrl: queue.url, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: Number(data.get("visibility")) }); context.toast("Message visibility changed"); }, false, { refreshAfterSubmit: false });
  }));
}

async function messagesPage(context, name) {
  const queue = await describeQueue(name); const attributes = queue.attributes; const fifo = attributes.FifoQueue === "true";
  setQueueChrome(context, name, "Send and receive messages");
  context.main.innerHTML = `<div class="page-width sqs-messages-page">${pageHeader("Send and receive messages", queue.attributes.QueueArn, '<button class="button primary" data-send-sqs-message>Send message</button>')}${queueTabs(name, "messages")}<div class="alert warning"><strong>Polling changes queue state</strong><br>Receiving a message increments its receive count and hides it for the selected visibility timeout. Stop cancels the active long-poll request.</div><section class="card"><div class="card-header"><h2>Receive messages</h2><span id="sqs-poll-status" class="muted">Ready</span></div><form id="sqs-receive-form" class="card-body"><div class="sqs-receive-controls"><div class="field"><label>Maximum messages</label><input name="maximum" type="number" min="1" max="10" value="10" required></div><div class="field"><label>Wait time (seconds)</label><input name="wait" type="number" min="0" max="20" value="${escapeHtml(attributes.ReceiveMessageWaitTimeSeconds || "10")}" required></div><div class="field"><label>Visibility timeout (seconds)</label><input name="visibility" type="number" min="0" max="43200" value="${escapeHtml(attributes.VisibilityTimeout || "30")}" required></div><div class="field"><label>Poll attempts</label><input name="attempts" type="number" min="1" max="20" value="1" required></div></div><div class="actions"><button class="button primary" type="submit" data-start-poll>Poll for messages</button><button class="button danger" type="button" data-stop-poll hidden>Stop</button></div></form></section><section id="sqs-receive-results" aria-live="polite">${emptyState("✉", "No inspected messages", "Poll the queue to inspect available message bodies and attributes.")}</section></div>`;
  document.querySelector("[data-send-sqs-message]")?.addEventListener("click", () => context.showModal("Send message", `<div class="field"><label>Message body</label><textarea name="body" required maxlength="1048576" placeholder='{"job":"resize-image"}'></textarea><span class="hint">The queue maximum is ${integer(attributes.MaximumMessageSize, 1_048_576).toLocaleString()} bytes.</span></div><div class="field-row"><div class="field"><label>Message group ID${fifo ? "" : " (optional fair queue)"}</label><input name="messageGroup" ${fifo ? "required" : ""} maxlength="128" placeholder="tenant-a"></div>${fifo ? `<div class="field"><label>Message deduplication ID${attributes.ContentBasedDeduplication === "true" ? " (optional)" : ""}</label><input name="deduplication" ${attributes.ContentBasedDeduplication === "true" ? "" : "required"} maxlength="128" placeholder="job-123"></div>` : `<div class="field"><label>Delivery delay (seconds)</label><input name="delay" type="number" min="0" max="900" value="0" required></div>`}</div><div class="field"><label>Message attributes (JSON object)</label><textarea name="attributes">{}</textarea><span class="hint">Use SQS attribute objects such as {"priority":{"DataType":"Number","StringValue":"10"}}. BinaryValue is base64 in this raw JSON workflow.</span></div><div class="field"><label>Trace header (optional)</label><input name="trace" placeholder="Root=1-...;Parent=...;Sampled=1"></div>`, "Send message", async data => {
    const trace = String(data.get("trace") || "").trim();
    const group = String(data.get("messageGroup") || "").trim(); const deduplication = String(data.get("deduplication") || "").trim();
    const result = await sqs("SendMessage", { QueueUrl: queue.url, MessageBody: String(data.get("body")), ...(!fifo ? { DelaySeconds: Number(data.get("delay")) } : {}), ...(group ? { MessageGroupId: group } : {}), ...(deduplication ? { MessageDeduplicationId: deduplication } : {}), MessageAttributes: parseObject(data.get("attributes"), "Message attributes"), ...(trace ? { MessageSystemAttributes: { AWSTraceHeader: { DataType: "String", StringValue: trace } } } : {}) });
    context.toast(`Message sent · ${result.MessageId}`);
  }, true));
  const form = document.querySelector("#sqs-receive-form"); const start = form.querySelector("[data-start-poll]"); const stop = form.querySelector("[data-stop-poll]"); const status = document.querySelector("#sqs-poll-status");
  stop.addEventListener("click", () => { stopPolling(); status.textContent = "Stopping…"; });
  form.addEventListener("submit", async event => {
    event.preventDefault(); stopPolling(); const data = new FormData(form); const controller = new AbortController(); activePoll = controller; start.disabled = true; stop.hidden = false; status.textContent = "Polling…";
    try {
      let messages = []; const attempts = Number(data.get("attempts"));
      for (let attempt = 1; attempt <= attempts && !messages.length; attempt++) {
        status.textContent = `Polling attempt ${attempt} of ${attempts}…`;
        const result = await sqs("ReceiveMessage", { QueueUrl: queue.url, MaxNumberOfMessages: Number(data.get("maximum")), WaitTimeSeconds: Number(data.get("wait")), VisibilityTimeout: Number(data.get("visibility")), MessageAttributeNames: ["All"], MessageSystemAttributeNames: ["All"] }, { signal: controller.signal });
        messages = result.Messages ?? [];
      }
      renderReceivedMessages(context, queue, messages); status.textContent = messages.length ? `${messages.length} message${messages.length === 1 ? "" : "s"} received` : "Poll completed with no messages";
    } catch (error) {
      if (error?.name === "AbortError") status.textContent = "Polling stopped";
      else { status.textContent = "Polling failed"; context.showError(error); }
    } finally {
      if (activePoll === controller) activePoll = undefined;
      start.disabled = false; stop.hidden = true;
    }
  });
}

async function monitoringPage(context, name) {
  const queue = await describeQueue(name); const end = new Date(); const start = new Date(end.getTime() - 3_600_000);
  const definitions = [
    ["visible", "Available", "ApproximateNumberOfMessagesVisible", "Maximum"],
    ["inflight", "In flight", "ApproximateNumberOfMessagesNotVisible", "Maximum"],
    ["delayed", "Delayed", "ApproximateNumberOfMessagesDelayed", "Maximum"],
    ["oldest", "Oldest message age", "ApproximateAgeOfOldestMessage", "Maximum"],
    ["sent", "Messages sent", "NumberOfMessagesSent", "Sum"],
    ["received", "Messages received", "NumberOfMessagesReceived", "Sum"],
    ["deleted", "Messages deleted", "NumberOfMessagesDeleted", "Sum"],
    ["empty", "Empty receives", "NumberOfEmptyReceives", "Sum"],
    ["size", "Average sent size", "SentMessageSize", "Average"],
  ];
  if (queue.attributes.FifoQueue === "true") definitions.push(["groups", "Groups in flight", "ApproximateNumberOfGroupsWithInflightMessages", "Maximum"], ["deduplicated", "Deduplicated sends", "NumberOfDeduplicatedSentMessages", "Sum"]);
  else definitions.push(["noisy", "Noisy groups", "ApproximateNumberOfNoisyGroups", "Maximum"], ["quiet", "Quiet-group messages", "ApproximateNumberOfMessagesVisibleInQuietGroups", "Maximum"]);
  const result = await metrics("GetMetricData", { StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampAscending", MetricDataQueries: definitions.map(([Id, Label, MetricName, Stat]) => ({ Id, Label, MetricStat: { Metric: { Namespace: "AWS/SQS", MetricName, Dimensions: [{ Name: "QueueName", Value: name }] }, Period: 60, Stat } })) });
  const series = (result.MetricDataResults ?? []).map(item => ({ ...item, timestamps: item.Timestamps, values: item.Values, label: item.Label })); const attributes = queue.attributes;
  setQueueChrome(context, name, "Monitoring");
  context.main.innerHTML = `<div class="page-width sqs-monitoring">${pageHeader("Monitoring", `Locally measured SQS metrics for ${escapeHtml(name)}.`, '<button class="button refresh" data-action="refresh" title="Refresh" aria-label="Refresh monitoring">↻</button><a class="button" href="#/cloudwatch/metrics">View all metrics</a>')}${queueTabs(name, "monitoring")}<div class="sqs-metric-summary"><section class="card"><div class="card-body"><span class="metric">${integer(attributes.ApproximateNumberOfMessages).toLocaleString()}</span><span>Available</span></div></section><section class="card"><div class="card-body"><span class="metric">${integer(attributes.ApproximateNumberOfMessagesNotVisible).toLocaleString()}</span><span>In flight</span></div></section><section class="card"><div class="card-body"><span class="metric">${integer(attributes.ApproximateNumberOfMessagesDelayed).toLocaleString()}</span><span>Delayed</span></div></section></div><section class="card"><div class="card-header"><h2>Queue activity</h2><span class="muted">Last hour · 1 minute</span></div><div class="card-body">${metricChart(series, `SQS activity for ${name}`)}</div></section><div class="alert info"><strong>Approximate labels retained</strong><br>The simulator can calculate exact local snapshots, but fields and metrics retain the provider's approximate names for SDK compatibility.</div></div>`;
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function tagsPage(context, name) {
  const queue = await describeQueue(name, true); const entries = Object.entries(queue.tags);
  setQueueChrome(context, name, "Tags");
  context.main.innerHTML = `<div class="page-width">${pageHeader("Tags", `Key-value metadata for ${escapeHtml(name)}.`, '<button class="button primary" data-manage-sqs-tags>Manage tags</button>')}${queueTabs(name, "tags")}<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${entries.length})</span></h2></div><div class="table-wrap">${entries.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${entries.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No tags", "Add tags to organize and authorize this queue.")}</div></section></div>`;
  document.querySelector("[data-manage-sqs-tags]")?.addEventListener("click", () => context.showModal("Manage tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(queue.tags, null, 2))}</textarea><span class="hint">All values must be strings. Removing a key here untags it.</span></div>`, "Save", async data => {
    const next = stringMap(data.get("tags"), "Tags"); const removed = Object.keys(queue.tags).filter(key => !(key in next));
    if (removed.length) await sqs("UntagQueue", { QueueUrl: queue.url, TagKeys: removed });
    if (Object.keys(next).length) await sqs("TagQueue", { QueueUrl: queue.url, Tags: next });
    context.toast("Queue tags updated");
  }));
}

async function accessPolicyPage(context, name) {
  const queue = await describeQueue(name);
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
  const accountId = ui.summary?.accountId ?? String(queueArn).split(":")[4] ?? "ACCOUNT_ID";
  const configured = Boolean(String(queue.attributes.Policy ?? "").trim());
  const policyDocument = parsePolicy(queue.attributes.Policy, { Version: "2012-10-17", Statement: [] });
  const diagnostics = policyDiagnostics(policyDocument, accountId);
  const eventBridgeTemplate = {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowEventBridgeRule",
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: queueArn,
      Condition: { ArnEquals: { "aws:SourceArn": "RULE_ARN" }, StringEquals: { "aws:SourceAccount": accountId } },
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
      Condition: { ArnEquals: { "aws:SourceArn": "arn:aws:s3:::BUCKET_NAME" }, StringEquals: { "aws:SourceAccount": accountId } },
    }],
  };
  const statementRows = diagnostics.statements.map((statement, index) => {
    const principals = principalEntries(statement.Principal ?? statement.NotPrincipal).map(principal => `${principal.type}: ${principal.value}`).join("; ") || "—";
    const actions = values(statement.Action ?? statement.NotAction).join(", ") || "—";
    return `<tr><td>${escapeHtml(statement.Sid || `Statement ${index + 1}`)}</td><td><span class="status ${statement.Effect === "Deny" ? "inactive" : ""}">${escapeHtml(statement.Effect)}</span></td><td>${escapeHtml(statement.NotPrincipal ? `NOT ${principals}` : principals)}</td><td class="mono">${escapeHtml(statement.NotAction ? `NOT ${actions}` : actions)}</td><td class="mono">${escapeHtml(sourceCondition(statement, "aws:SourceArn"))}</td><td>${escapeHtml(sourceCondition(statement, "aws:SourceAccount"))}</td></tr>`;
  }).join("");
  const warnings = `${diagnostics.publicAllows.length ? `<div class="alert warning"><strong>Public principal detected</strong><br>${diagnostics.publicAllows.length} Allow statement${diagnostics.publicAllows.length === 1 ? " uses" : "s use"} <span class="mono">Principal: "*"</span>. Verify its conditions carefully; an unscoped statement can authorize anonymous or broadly shared access.</div>` : ""}${diagnostics.crossAccounts.length ? `<div class="alert warning"><strong>Cross-account trust detected</strong><br>This policy trusts ${diagnostics.crossAccounts.map(value => `<span class="mono">${escapeHtml(value)}</span>`).join(", ")}. Cross-account callers still need an identity-policy Allow, and owner-only queue administration cannot be delegated.</div>` : ""}`;
  setQueueChrome(context, name, "Access policy");
  const s3SourceRows = s3Sources.map(source => `<tr><td><a href="#/s3/buckets/${encodeURIComponent(source.bucket)}/properties">${escapeHtml(source.bucket)}</a></td><td>${escapeHtml(source.id)}</td><td>${escapeHtml(source.events.join(", "))}</td><td class="mono">${escapeHtml(`${source.prefix || "*"} … ${source.suffix || "*"}`)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width sqs-access-policy">${pageHeader("Access policy", `Authorization boundaries for ${escapeHtml(name)}.`, '<button class="button" data-add-sqs-policy>Add statement</button><button class="button primary" data-edit-sqs-policy>Edit JSON</button>')}${queueTabs(name, "access-policy")}<div class="alert success"><strong>IAM and resource-policy authorization are active</strong><br>Queue API calls are evaluated against caller identity policies and the resource-based policy for <span class="mono">${escapeHtml(queueArn)}</span>. An explicit deny wins.</div>${warnings}<section class="card"><div class="card-header"><h2>Resource-based queue policy</h2><span class="status ${configured ? "" : "inactive"}">${configured ? "Configured" : "Not configured"}</span></div><div class="card-body"><pre class="code-box">${escapeHtml(JSON.stringify(policyDocument, null, 2))}</pre></div></section><section class="card"><div class="card-header"><h2>Effective-access diagnostics</h2><span class="muted">${diagnostics.allows.length} allow · ${diagnostics.denies.length} deny</span></div><div class="card-body"><div class="sqs-summary-grid"><div><strong>Same account</strong><p class="muted">An identity-policy or queue-policy Allow can grant access.</p></div><div><strong>Cross account</strong><p class="muted">Both identity and queue policies must allow the action.</p></div><div><strong>Service publisher</strong><p class="muted">The queue policy must trust the exact service and source context.</p></div></div></div><div class="table-wrap">${diagnostics.statements.length ? `<table><thead><tr><th>Statement</th><th>Effect</th><th>Principal</th><th>Actions</th><th>Source ARN</th><th>Source account</th></tr></thead><tbody>${statementRows}</tbody></table>` : emptyState("◇", "No resource grants", "Identity policies can still authorize same-account callers. Add a statement for cross-account or service publishing.")}</div></section><section class="card eventbridge-queue-policy"><div class="card-header"><h2>EventBridge target authorization</h2><a href="#/eventbridge/rules">Open EventBridge rules</a></div><div class="card-body"><p>Grant <span class="mono">events.amazonaws.com</span> permission to call <span class="mono">sqs:SendMessage</span>, constrained to the exact rule ARN and source account.</p><dl class="key-value"><dt>Queue ARN</dt><dd class="mono">${escapeHtml(queueArn)}</dd><dt>Principal</dt><dd class="mono">events.amazonaws.com</dd><dt>Action</dt><dd class="mono">sqs:SendMessage</dd></dl><pre class="code-box">${escapeHtml(JSON.stringify(eventBridgeTemplate, null, 2))}</pre><p class="muted">A target execution role can provide identity permission instead. Cross-account delivery requires the role permission and a queue policy that trusts the source.</p></div></section><section class="card s3-queue-source-inventory"><div class="card-header"><h2>S3 notification authorization <span class="muted">(${s3Sources.length})</span></h2><span class="status">Available</span></div><div class="card-body"><p>S3 notifications use <span class="mono">s3.amazonaws.com</span> with the bucket ARN and bucket-owner account as exact source context. Object mutation is never rolled back when delivery is denied.</p><pre class="code-box">${escapeHtml(JSON.stringify(s3Template, null, 2))}</pre></div><div class="table-wrap">${s3Sources.length ? `<table><thead><tr><th>Bucket</th><th>Configuration</th><th>Events</th><th>Key filter</th></tr></thead><tbody>${s3SourceRows}</tbody></table>` : '<div class="card-body"><p class="muted">No bucket notification configuration currently targets this queue.</p></div>'}</div></section></div>`;
  document.querySelector("[data-add-sqs-policy]")?.addEventListener("click", () => context.showModal("Add queue-policy statement", `<div class="alert info"><strong>Basic statement generator</strong><br>The simulator validates the generated statement again against the full queue-policy grammar and quotas.</div><div class="field-row"><div class="field"><label>Statement ID</label><input name="sid" value="AllowEventBridgeRule" required></div><div class="field"><label>Effect</label><select name="effect"><option value="Allow">Allow</option><option value="Deny">Deny</option></select></div></div><div class="field-row"><div class="field"><label>Principal type</label><select name="principalType"><option value="Service">service</option><option value="AWS">account or IAM ARN</option><option value="Public">Public (*)</option></select></div><div class="field"><label>Principal</label><input name="principal" value="events.amazonaws.com" placeholder="events.amazonaws.com or 111122223333"></div></div><div class="field"><label>Actions</label><textarea name="actions">sqs:SendMessage</textarea><span class="hint">Separate actions with commas or new lines. Batch APIs use their documented parent actions.</span></div><div class="field-row"><div class="field"><label>Source ARN condition (optional)</label><input name="sourceArn" placeholder="arn:aws:events:${escapeHtml(ui.region)}:${escapeHtml(accountId)}:rule/orders"></div><div class="field"><label>Source account condition (optional)</label><input name="sourceAccount" value="${escapeHtml(accountId)}" pattern="[0-9]{12}"></div></div>`, "Add statement", async data => {
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
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement }) } });
    context.toast("Queue-policy statement added");
  }));
  document.querySelector("[data-edit-sqs-policy]")?.addEventListener("click", () => context.showModal("Edit queue policy", `<div class="alert info"><strong>Resource-based authorization</strong><br>Use a service principal and condition-scoped source ARN for EventBridge targets. Leave the editor empty to remove the policy.</div><div class="field"><label>Policy JSON</label><textarea name="policy" class="code-editor" style="min-height:360px">${escapeHtml(JSON.stringify(configured ? policyDocument : eventBridgeTemplate, null, 2))}</textarea></div>`, "Save policy", async data => {
    const raw = String(data.get("policy") ?? "").trim();
    const Policy = raw ? JSON.stringify(parseObject(raw, "Queue policy")) : "";
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { Policy } });
    context.toast(Policy ? "Queue policy saved" : "Queue policy removed");
  }));
}

async function encryptionPage(context, name) {
  const queue = await describeQueue(name);
  const managed = queue.attributes.SqsManagedSseEnabled === "true";
  setQueueChrome(context, name, "Encryption");
  context.main.innerHTML = `<div class="page-width sqs-encryption">${pageHeader("Encryption", `Server-side encryption settings for ${escapeHtml(name)}.`, '<button class="button primary" data-edit-sqs-encryption>Edit encryption</button>')}${queueTabs(name, "encryption")}<div class="sqs-summary-grid"><section class="card"><div class="card-header"><h2>SQS-managed SSE</h2><span class="status ${managed ? "" : "inactive"}">${managed ? "Enabled" : "Disabled"}</span></div><div class="card-body"><p>${managed ? "New messages are marked as using the queue's SQS-managed encryption mode." : "New messages are marked with SQS-managed encryption disabled."}</p><p class="muted">Changing this setting affects later writes. Existing encrypted messages remain readable across the change and restart.</p></div></section><section class="card"><div class="card-header"><h2>Private local payload storage</h2><span class="status">Always protected</span></div><div class="card-body"><p>Message bodies are authenticated-encrypted before the simulator writes them to its private durable payload store, independently of the SSE-SQS descriptor.</p><p class="muted">This local file protection is not an service-managed key or customer-managed KMS key.</p></div></section></div><div class="alert warning"><strong>SSE-KMS is an explicit dependency</strong><br><span class="mono">KmsMasterKeyId</span> and <span class="mono">KmsDataKeyReusePeriodSeconds</span> are syntax-validated, but valid settings fail atomically with <span class="mono">UnsupportedOperation</span> until a real KMS service exists. The simulator never claims that a KMS ARN encrypted local queue data.</div><section class="card"><div class="card-header"><h2>Queue encryption attributes</h2></div><div class="card-body"><dl class="key-value"><dt>Queue ARN</dt><dd class="mono">${escapeHtml(queue.attributes.QueueArn)}</dd><dt>SqsManagedSseEnabled</dt><dd class="mono">${managed ? "true" : "false"}</dd><dt>KmsMasterKeyId</dt><dd>${escapeHtml(queue.attributes.KmsMasterKeyId || "Not configured")}</dd><dt>KmsDataKeyReusePeriodSeconds</dt><dd>${escapeHtml(queue.attributes.KmsDataKeyReusePeriodSeconds || "Not configured")}</dd><dt>Local storage protection</dt><dd>Installation-local authenticated encryption</dd></dl></div></section></div>`;
  document.querySelector("[data-edit-sqs-encryption]")?.addEventListener("click", () => context.showModal("Edit queue encryption", `<div class="field"><label>SQS-managed server-side encryption</label><select name="managed"><option value="true" ${managed ? "selected" : ""}>Enabled</option><option value="false" ${managed ? "" : "selected"}>Disabled</option></select><span class="hint">The new value applies to messages written after this change.</span></div><div class="alert warning"><strong>Customer-managed KMS keys are unavailable</strong><br>Use the SDK to exercise validation and the explicit dependency error. This console does not offer an inert KMS selector.</div>`, "Save", async data => {
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { SqsManagedSseEnabled: String(data.get("managed")) } });
    context.toast("Queue encryption setting updated");
  }));
}

async function deadLetterPage(context, name) {
  const [queue, catalog] = await Promise.all([describeQueue(name), queueCatalog()]); const attributes = queue.attributes; const redrive = parsePolicy(attributes.RedrivePolicy); const allow = parsePolicy(attributes.RedriveAllowPolicy, { redrivePermission: "allowAll" });
  const sourceResult = await sqs("ListDeadLetterSourceQueues", { QueueUrl: queue.url, MaxResults: 1_000 }); const sourceUrls = sourceResult.queueUrls ?? sourceResult.QueueUrls ?? [];
  const fifo = attributes.FifoQueue === "true"; const candidates = catalog.filter(candidate => candidate.name !== name && (candidate.attributes.FifoQueue === "true") === fifo); const targetName = queueNameFromArn(redrive.deadLetterTargetArn);
  setQueueChrome(context, name, "Dead-letter queue");
  context.main.innerHTML = `<div class="page-width sqs-dead-letter">${pageHeader("Dead-letter queue", `Retry and poison-message routing for ${escapeHtml(name)}.`)}${queueTabs(name, "dead-letter")}<div class="sqs-dlq-grid"><section class="card"><div class="card-header"><h2>Redrive policy</h2><button class="button" data-configure-redrive>Configure</button></div><div class="card-body">${redrive.deadLetterTargetArn ? `<dl class="key-value"><dt>Dead-letter queue</dt><dd><a href="#/sqs/queues/${encodeURIComponent(targetName)}/dead-letter">${escapeHtml(targetName)}</a></dd><dt>Queue ARN</dt><dd class="mono">${escapeHtml(redrive.deadLetterTargetArn)}</dd><dt>Maximum receives</dt><dd>${escapeHtml(redrive.maxReceiveCount)}</dd></dl>` : emptyState("↳", "No dead-letter queue", "Configure a queue to receive messages after repeated unsuccessful deliveries.")}</div></section><section class="card"><div class="card-header"><h2>Redrive allow policy</h2><button class="button" data-configure-redrive-allow>Configure</button></div><div class="card-body"><dl class="key-value"><dt>Permission</dt><dd>${escapeHtml(allow.redrivePermission || "allowAll")}</dd><dt>Allowed source queues</dt><dd>${(allow.sourceQueueArns ?? []).length ? (allow.sourceQueueArns ?? []).map(arn => `<span class="mono">${escapeHtml(arn)}</span>`).join("<br>") : "All same-account queues in this Region"}</dd></dl></div></section></div><section class="card"><div class="card-header"><h2>Source queues <span class="muted">(${sourceUrls.length})</span></h2></div><div class="table-wrap">${sourceUrls.length ? `<table><thead><tr><th>Queue</th><th>Queue URL</th></tr></thead><tbody>${sourceUrls.map(url => `<tr><td><a href="#/sqs/queues/${encodeURIComponent(queueNameFromUrl(url))}/dead-letter">${escapeHtml(queueNameFromUrl(url))}</a></td><td class="mono">${escapeHtml(url)}</td></tr>`).join("")}</tbody></table>` : emptyState("↳", "No source queues", "No queue currently uses this queue as its dead-letter queue.")}</div></section><div class="alert info"><strong>Receive-count diagnostics</strong><br>Poll messages on the Send and receive messages tab to inspect ApproximateReceiveCount. Messages move only after they exceed the configured maximum receive count.</div></div>`;
  document.querySelector("[data-configure-redrive]")?.addEventListener("click", () => context.showModal("Configure dead-letter queue", `<div class="field"><label>Dead-letter queue</label><select name="target"><option value="">Not configured</option>${candidates.map(candidate => `<option value="${escapeHtml(candidate.attributes.QueueArn)}" ${candidate.attributes.QueueArn === redrive.deadLetterTargetArn ? "selected" : ""}>${escapeHtml(candidate.name)}</option>`).join("")}</select>${candidates.length ? "" : `<span class="hint">Create another ${fifo ? "FIFO" : "Standard"} queue before configuring redrive.</span>`}</div><div class="field"><label>Maximum receives</label><input name="maximum" type="number" min="1" max="1000" value="${escapeHtml(redrive.maxReceiveCount || "10")}" required><span class="hint">A message moves after its receive count exceeds this value.</span></div>`, "Save", async data => {
    const target = String(data.get("target") || ""); const RedrivePolicy = target ? JSON.stringify({ deadLetterTargetArn: target, maxReceiveCount: String(Number(data.get("maximum"))) }) : "";
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { RedrivePolicy } }); context.toast(target ? "Dead-letter queue configured" : "Dead-letter queue removed");
  }));
  document.querySelector("[data-configure-redrive-allow]")?.addEventListener("click", () => context.showModal("Configure redrive allow policy", `<div class="field"><label>Redrive permission</label><select name="permission"><option value="allowAll" ${allow.redrivePermission === "allowAll" || !allow.redrivePermission ? "selected" : ""}>Allow all same-account queues</option><option value="denyAll" ${allow.redrivePermission === "denyAll" ? "selected" : ""}>Deny all queues</option><option value="byQueue" ${allow.redrivePermission === "byQueue" ? "selected" : ""}>Allow selected queues</option></select></div><div class="field"><label>Allowed source queue ARNs</label><textarea name="sources" placeholder="One queue ARN per line">${escapeHtml((allow.sourceQueueArns ?? []).join("\n"))}</textarea><span class="hint">Used only for Allow selected queues; at most ten ARNs.</span></div>`, "Save", async data => {
    const permission = String(data.get("permission")); const sourceQueueArns = String(data.get("sources") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (permission === "byQueue" && !sourceQueueArns.length) throw new Error("Enter at least one source queue ARN");
    if (sourceQueueArns.length > 10) throw new Error("Redrive allow policy supports at most ten source queue ARNs");
    await sqs("SetQueueAttributes", { QueueUrl: queue.url, Attributes: { RedriveAllowPolicy: JSON.stringify({ redrivePermission: permission, ...(permission === "byQueue" ? { sourceQueueArns } : {}) }) } }); context.toast("Redrive allow policy updated");
  }));
}

async function lambdaTriggersPage(context, name) {
  const queue = await describeQueue(name); const queueArn = queue.attributes.QueueArn; const fifo = queue.attributes.FifoQueue === "true";
  const [listed, functionResult] = await Promise.all([rest(`/2015-03-31/event-source-mappings?EventSourceArn=${encodeURIComponent(queueArn)}&MaxItems=100`), rest("/2015-03-31/functions")]);
  const mappings = listed.EventSourceMappings ?? []; const functions = functionResult.Functions ?? [];
  setQueueChrome(context, name, "Lambda triggers");
  context.main.innerHTML = `<div class="page-width sqs-lambda-triggers">${pageHeader("Lambda triggers", `Functions polling ${escapeHtml(name)}.`, '<button class="button primary" data-add-sqs-trigger>Add trigger</button>')}${queueTabs(name, "lambda-triggers")}<div class="alert info"><strong>${fifo ? "FIFO group ordering" : "At-least-once worker delivery"}</strong><br>${fifo ? "Lambda processes each message group in order while independent groups can run concurrently. FIFO batch size is limited to 10 and batching windows are disabled." : "Lambda deletes messages only after successful handling. Function errors and throttles leave messages in flight until their visibility timeout expires."}</div><section class="card"><div class="card-header"><h2>Event source mappings <span class="muted">(${mappings.length})</span></h2></div><div class="table-wrap">${mappings.length ? `<table><thead><tr><th>Function</th><th>State</th><th>Batch</th><th>Maximum concurrency</th><th>Partial failures</th><th>Last processing result</th><th>Actions</th></tr></thead><tbody>${mappings.map(mapping => { const functionName = functionNameFromArn(mapping.FunctionArn); return `<tr><td><a href="#/lambda/functions/${encodeURIComponent(functionName)}">${escapeHtml(functionName)}</a><div class="muted small mono">${escapeHtml(mapping.UUID)}</div></td><td><span class="status ${mapping.State === "Disabled" ? "inactive" : ""}">${escapeHtml(mapping.State)}</span></td><td>${integer(mapping.BatchSize, 10)} · ${integer(mapping.MaximumBatchingWindowInSeconds)}s</td><td>${escapeHtml(mapping.ScalingConfig?.MaximumConcurrency ?? "Unbounded")}</td><td>${mapping.FunctionResponseTypes?.includes("ReportBatchItemFailures") ? "Enabled" : "Full batch"}</td><td>${escapeHtml(mapping.LastProcessingResult || "No messages processed")}</td><td class="no-wrap"><button class="button link" data-toggle-sqs-trigger="${escapeHtml(mapping.UUID)}" data-enabled="${mapping.State !== "Disabled"}">${mapping.State === "Disabled" ? "Enable" : "Disable"}</button><button class="button link danger" data-delete-sqs-trigger="${escapeHtml(mapping.UUID)}">Delete</button></td></tr>`; }).join("")}</tbody></table>` : emptyState("↯", "No Lambda triggers", "Add a function to consume messages from this queue.", '<button class="button primary" data-add-sqs-trigger>Add trigger</button>')}</div></section></div>`;
  document.querySelectorAll("[data-add-sqs-trigger]").forEach(button => button.addEventListener("click", () => {
    if (!functions.length) return context.showModal("Add Lambda trigger", '<div class="alert warning"><strong>No Lambda functions</strong><br>Create a function and execution role before attaching this queue.</div><p><a href="#/lambda/functions">Open Lambda functions</a></p>', "Close", async () => undefined, false, { refreshAfterSubmit: false });
    context.showModal("Add Lambda trigger", `<div class="field"><label>Lambda function</label><select name="function" required>${functions.map(fn => `<option value="${escapeHtml(fn.FunctionArn)}">${escapeHtml(fn.FunctionName)} · ${escapeHtml(fn.Role || "execution role")}</option>`).join("")}</select></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" checked> Enable trigger</label></div><div class="field-row"><div class="field"><label>Batch size</label><input name="batchSize" type="number" min="1" max="${fifo ? 10 : 10000}" value="10" required></div><div class="field"><label>Batching window (seconds)</label><input name="batchWindow" type="number" min="0" max="${fifo ? 0 : 300}" value="0" ${fifo ? "readonly" : ""} required></div></div><div class="field-row"><div class="field"><label>Maximum concurrency (optional)</label><input name="maximumConcurrency" type="number" min="2" max="1000" placeholder="Unbounded"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="partial" value="yes"> Report partial batch item failures</label></div></div><div class="field"><label>Filter pattern (optional JSON)</label><textarea name="filter" placeholder='{"body":{"job":["ready"]}}'></textarea></div><div class="alert warning"><strong>Execution-role permissions</strong><br>The function role needs <span class="mono">sqs:ReceiveMessage</span>, <span class="mono">sqs:DeleteMessage</span>, <span class="mono">sqs:ChangeMessageVisibility</span>, and <span class="mono">sqs:GetQueueAttributes</span> on <span class="mono">${escapeHtml(queueArn)}</span>.</div>`, "Add trigger", async data => {
      const batchSize = Number(data.get("batchSize")); const batchWindow = Number(data.get("batchWindow")); if (!fifo && batchSize > 10 && batchWindow < 1) throw new Error("Set batching window to at least 1 second when batch size is greater than 10");
      const filter = String(data.get("filter") || "").trim(); if (filter) parseObject(filter, "Filter pattern"); const maximum = String(data.get("maximumConcurrency") || "").trim();
      await rest("/2015-03-31/event-source-mappings", "POST", { FunctionName: data.get("function"), EventSourceArn: queueArn, Enabled: data.get("enabled") === "yes", BatchSize: batchSize, MaximumBatchingWindowInSeconds: batchWindow, FunctionResponseTypes: data.get("partial") === "yes" ? ["ReportBatchItemFailures"] : [], FilterCriteria: { Filters: filter ? [{ Pattern: filter }] : [] }, ...(maximum ? { ScalingConfig: { MaximumConcurrency: Number(maximum) } } : {}) }); context.toast("SQS trigger created");
    }, true);
  }));
  document.querySelectorAll("[data-toggle-sqs-trigger]").forEach(button => button.addEventListener("click", async () => { await rest(`/2015-03-31/event-source-mappings/${encodeURIComponent(button.dataset.toggleSqsTrigger)}`, "PUT", { Enabled: button.dataset.enabled !== "true" }); context.toast(`Trigger ${button.dataset.enabled === "true" ? "disabled" : "enabled"}`); await context.route(); }));
  document.querySelectorAll("[data-delete-sqs-trigger]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deleteSqsTrigger, "Delete this SQS trigger? Unprocessed messages remain in the queue.", async () => { await rest(`/2015-03-31/event-source-mappings/${encodeURIComponent(button.dataset.deleteSqsTrigger)}`, "DELETE"); context.toast("SQS trigger deleted"); })));
}

export async function routeSqs(parts, context) {
  stopPolling();
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
  const name = parts[2]; const section = parts[3] ?? "details";
  if (section === "details") return render(detailsPage(context, name));
  if (section === "messages") return render(messagesPage(context, name));
  if (section === "monitoring") return render(monitoringPage(context, name));
  if (section === "dead-letter") return render(deadLetterPage(context, name));
  if (section === "access-policy") return render(accessPolicyPage(context, name));
  if (section === "encryption") return render(encryptionPage(context, name));
  if (section === "tags") return render(tagsPage(context, name));
  if (section === "lambda-triggers") return render(lambdaTriggersPage(context, name));
  return context.notFound(parts);
}
