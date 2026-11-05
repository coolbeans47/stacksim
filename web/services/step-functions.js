import { awsQuery, states } from "../api-client.js";
import { enhanceArnComboboxes } from "../arn-combobox.js";
import { associateFormLabels, emptyState, escapeHtml, formatDate, pageHeader, tabs } from "../components.js";
import { setDirty } from "../state.js";
import { bindFlowControls, flowGraphHtml, flowToolbarHtml } from "./step-functions-graph.js";
import { decorateStepFunctionsPanelHelp } from "./step-functions-help.js";
import {
  BLANK_DEFINITION, HELLO_WORLD_DEFINITION, HELLO_WORLD_INPUT,
  cloudFormationOrigin, displayLabel, epochMilliseconds, executionPresentation, executionRoleLink, executionRoleStatements, executionRoleTrustPolicy,
  formatDuration, formatElapsed, formatTimestamp, generatedRoleName, integrationReferences, lambdaReferences, parseStateMachineDefinition, payloadField,
  redactSensitiveValue, resourceNameProblem, rowsToTags, stateResults, stateTransitionCount, statusVariant, tagChanges, tagsToRows,
} from "./step-functions-model.js";
import { bindWorkflowStudio, showStudioMode, syncStudioBeforeSubmit, workflowStudioMarkup } from "./step-functions-studio.js";

export const metadata = {
  key: "step-functions",
  name: "Step Functions",
  icon: "S",
  cls: "step-functions",
  links: [["State machines", "#/step-functions/state-machines"], ["Executions", "#/step-functions/executions"], ["Activities", "#/step-functions/activities"], ["Create state machine", "#/step-functions/state-machines/create"]],
  search: ["step functions", "workflow", "state machine", "execution", "asl", "orchestration"],
};

let context;
let activeViewCleanup = () => undefined;
const encoded = encodeURIComponent;
const LIST_HREF = "#/step-functions/state-machines";
const machineHref = arn => `${LIST_HREF}/${encoded(arn)}`;
const machineArnOf = executionArn => String(executionArn).replace(/^(arn:[^:]+:states:[^:]*:[^:]*):execution:([^:]+):.*$/, "$1:stateMachine:$2");
const executionHref = arn => `${machineHref(machineArnOf(arn))}/executions/${encoded(arn)}`;
const activityHref = arn => `#/step-functions/activities/${encoded(arn)}`;
const lambdaHref = name => `#/lambda/functions/${encoded(name)}`;
const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]);
const UNAVAILABLE = "Not available in StackSim";
const START_AFTER_CREATE = "sfn-start-after-create";

// Dialogs opened from these pages keep AWS sentence-case button labels.
function markDialog() {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return;
  dialog.classList.add("sfn-dialog");
  dialog.addEventListener("close", () => dialog.classList.remove("sfn-dialog"), { once: true });
}
function openModal(...parameters) { context.showModal(...parameters); markDialog(); }
function confirmDeletion(...parameters) { context.confirmDeletion(...parameters); markDialog(); }

async function all(operation, key, input = {}, pageSize = 100) {
  const output = [];
  let nextToken;
  do {
    const page = await states(operation, { ...input, maxResults: pageSize, ...(nextToken ? { nextToken } : {}) });
    output.push(...(page[key] ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return output;
}

async function machines() { return all("ListStateMachines", "stateMachines"); }
async function executions(stateMachineArn) { return all("ListExecutions", "executions", { stateMachineArn }); }
async function completeHistory(executionArn, includeExecutionData = true) { return all("GetExecutionHistory", "events", { executionArn, includeExecutionData }, 1000); }

function status(value, label = displayLabel(value)) {
  return `<span class="status ${statusVariant(value)}" role="status">${escapeHtml(label)}</span>`;
}

function pretty(value) {
  if (value === undefined) return "";
  try { return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2); }
  catch { return String(value); }
}

const unavailable = (label, classes = "button") => `<button class="${classes}" type="button" disabled title="${escapeHtml(label)} — ${UNAVAILABLE}">${escapeHtml(label)}</button>`;
const copyable = value => `<span class="mono sfn-wrap">${escapeHtml(value)}</span> <button class="button link sfn-copy" type="button" data-copy="${escapeHtml(value)}" aria-label="Copy ${escapeHtml(value)}">Copy</button>`;

function actionsMenu(items, label = "Actions") {
  return `<details class="actions-menu"><summary class="button" aria-haspopup="menu">${escapeHtml(label)} ▾</summary><div class="menu" role="menu">${items.filter(Boolean).map(([attribute, text, options = {}]) => `<button type="button" role="menuitem" ${attribute} ${options.danger ? 'class="danger"' : ""} ${options.disabled ? `disabled title="${escapeHtml(text)} — ${UNAVAILABLE}"` : ""}>${escapeHtml(text)}</button>`).join("")}</div></details>`;
}

function bindMenus(root) {
  root.querySelectorAll(".actions-menu [role=menuitem]").forEach(item => item.addEventListener("click", () => item.closest("details")?.removeAttribute("open")));
}

function download(filename, text, type = "application/json") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function validationHtml(result) {
  if (result.result === "OK") return '<div class="alert success"><strong>Definition is valid.</strong><br>No validation diagnostics were returned.</div>';
  const diagnostics = result.diagnostics ?? [];
  return `<div class="alert error" role="alert"><strong>Definition has ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}${result.truncated ? " (results truncated)" : ""}.</strong><ul>${diagnostics.map(item => `<li><span class="mono">${escapeHtml(item.location ?? "$")}</span> · ${escapeHtml(item.severity ?? "ERROR")} · ${escapeHtml(item.message)}</li>`).join("")}</ul></div>`;
}

function lambdaLinks(definition) {
  const references = lambdaReferences(definition);
  if (!references.length) return "";
  return `<section class="card"><div class="card-header"><h2>Related Lambda functions <span class="muted">(${references.length})</span></h2></div><div class="card-body sfn-related">${references.map(item => `<a class="button" href="${lambdaHref(item.name)}">${escapeHtml(item.name)} <span class="muted">· ${escapeHtml(item.stateName)}</span></a><a class="button" href="${lambdaHref(item.name)}/monitor">${escapeHtml(item.name)} logs and metrics</a>`).join("")}</div></section>`;
}

function roleMarkup(arn) {
  const href = executionRoleLink(arn);
  return href ? `<a href="${href}">${escapeHtml(arn)}</a>` : escapeHtml(arn);
}

function originMarkup(tags) {
  const origin = cloudFormationOrigin(tags);
  if (!origin) return "";
  return `<section class="card"><div class="card-header"><h2>CloudFormation deployment</h2></div><div class="card-body"><dl class="key-value"><dt>Stack</dt><dd><a href="${origin.href}">${escapeHtml(origin.stackName)}</a></dd><dt>Logical resource</dt><dd class="mono">${escapeHtml(origin.logicalId)}</dd></dl><p class="muted">Deploy definition, role, and resource changes through this stack to keep its template in sync. Retained resources keep their deployment origin; retention does not transfer ownership or enable resource import.</p></div></section>`;
}

function integrationLinks(definition) {
  const references = integrationReferences(definition);
  if (!references.length) return "";
  return `<section class="card"><div class="card-header"><h2>Related service integrations <span class="muted">(${references.length})</span></h2></div><div class="card-body sfn-related">${references.map(item => { const label = `${escapeHtml(item.service)} <span class="muted">· ${escapeHtml(item.stateName)}${item.callback ? " · callback wait" : item.sync ? " · run a job" : ""}</span>`; return item.href ? `<a class="button" href="${item.href}">${label}</a>` : `<span class="button">${label} · dynamic resource</span>`; }).join("")}</div></section>`;
}

function unsupportedBoundary(scope = "workflows") {
  const text = scope === "activities"
    ? "Activities use AWS-owned local encryption. Customer-managed KMS keys for Activities remain unavailable."
    : "This console supports Standard JSONPath workflows, Workflow Studio Design, Code and Config modes with JSON round-trip, common optimized integrations, callbacks, nested workflows, and Activities. Workflow Studio patterns and drag and drop, code generation, Test state, active logging, X-Ray tracing, customer-managed encryption, publishing, versions, aliases, Express workflows, JSONata, Distributed Map, redrive, AWS SDK integrations, HTTP tasks, and unlisted integration patterns remain unavailable.";
  return `<section class="card"><div class="card-header"><h2>Unavailable settings</h2></div><div class="card-body"><p class="muted">${text}</p></div></section>`;
}

// ---------------------------------------------------------------------------
// Tags

function tagRowMarkup(row = { key: "", value: "" }) {
  return `<div class="sfn-tag-row" data-tag-row><div class="field"><label>Key</label><input data-tag-key maxlength="128" value="${escapeHtml(row.key)}"></div><div class="field"><label>Value - optional</label><input data-tag-value maxlength="256" value="${escapeHtml(row.value)}"></div><button class="button" type="button" data-tag-remove>Remove</button></div>`;
}

function tagEditorMarkup(rows = []) {
  return `<div class="sfn-tags" data-tag-editor><div data-tag-rows>${rows.map(tagRowMarkup).join("")}</div><p class="muted" data-tag-empty ${rows.length ? "hidden" : ""}>No tags associated with the resource.</p><button class="button" type="button" data-tag-add>Add new tag</button><span class="hint">You can add up to 50 tags. Keys beginning with aws: are reserved.</span><details class="sfn-details" data-tag-json><summary>Edit as JSON</summary><div class="field"><label>Tags (JSON object)</label><textarea class="code-editor" data-tag-json-text spellcheck="false">{}</textarea><span class="hint">Applying the JSON replaces the rows above.</span></div></details></div>`;
}

function tagEditorRows(editor) {
  return [...editor.querySelectorAll("[data-tag-row]")].map(row => ({ key: row.querySelector("[data-tag-key]").value, value: row.querySelector("[data-tag-value]").value }));
}

function bindTagEditor(root) {
  const editor = root.querySelector("[data-tag-editor]");
  if (!editor) return;
  const rows = editor.querySelector("[data-tag-rows]");
  const json = editor.querySelector("[data-tag-json-text]");
  const refresh = () => {
    editor.querySelector("[data-tag-empty]").hidden = Boolean(rows.children.length);
    associateFormLabels(editor);
  };
  const bindRow = row => row.querySelector("[data-tag-remove]").addEventListener("click", () => { row.remove(); refresh(); setDirty(true, root.closest("dialog") ? "modal" : "page"); });
  rows.querySelectorAll("[data-tag-row]").forEach(bindRow);
  editor.querySelector("[data-tag-add]").addEventListener("click", () => {
    rows.insertAdjacentHTML("beforeend", tagRowMarkup());
    bindRow(rows.lastElementChild);
    refresh();
    rows.lastElementChild.querySelector("[data-tag-key]").focus();
  });
  editor.querySelector("[data-tag-json]").addEventListener("toggle", event => {
    if (event.target.open) json.value = JSON.stringify(Object.fromEntries(tagEditorRows(editor).filter(row => row.key).map(row => [row.key, row.value])), null, 2);
  });
  json.addEventListener("change", () => {
    try {
      const value = JSON.parse(json.value || "{}");
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Tags must be a JSON object.");
      rows.innerHTML = Object.entries(value).map(([key, item]) => tagRowMarkup({ key, value: String(item) })).join("");
      rows.querySelectorAll("[data-tag-row]").forEach(bindRow);
      json.setCustomValidity("");
      refresh();
    } catch (error) {
      json.setCustomValidity(error instanceof Error ? error.message : "Tags must be a JSON object.");
      json.reportValidity();
    }
  });
  refresh();
}

/** Reads the editor and returns API tags, or throws the first validation problem. */
function readTagEditor(root) {
  const editor = root.querySelector("[data-tag-editor]");
  if (!editor) return [];
  const json = editor.querySelector("[data-tag-json-text]");
  if (editor.querySelector("[data-tag-json]").open && json.validationMessage) throw new Error(json.validationMessage);
  const result = rowsToTags(tagEditorRows(editor));
  if (result.problem) throw new Error(result.problem);
  return result.tags;
}

function tagsBody(tags, noun = "state machine") {
  const rows = tags.map(tag => `<tr><td>${escapeHtml(tag.key)}</td><td class="sfn-wrap">${escapeHtml(tag.value)}</td></tr>`).join("");
  return `<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${tags.length})</span></h2><button class="button" type="button" data-edit-tags>Manage tags</button></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("#", "No tags", `Add tags to organize this ${noun}.`, '<button class="button" type="button" data-edit-tags>Add tags</button>')}</section>`;
}

function bindTagManagement(root, resourceArn, tags) {
  const open = () => {
    openModal("Manage tags", `${tagEditorMarkup(tagsToRows(tags))}<p class="muted">Saving adds or updates keys with TagResource and removes deleted keys with UntagResource.</p>`, "Save tags", async () => {
      const dialog = document.querySelector("dialog[open]");
      const { changed, removed } = tagChanges(tags, readTagEditor(dialog));
      if (changed.length) await states("TagResource", { resourceArn, tags: changed });
      if (removed.length) await states("UntagResource", { resourceArn, tagKeys: removed });
      context.toast("Tags updated");
    }, true);
    bindTagEditor(document.querySelector("dialog[open]"));
  };
  root.querySelectorAll("[data-edit-tags]").forEach(button => button.addEventListener("click", open));
}

// ---------------------------------------------------------------------------
// Start and stop execution

function openStartExecution(machine, { input } = {}) {
  const initial = input ?? JSON.stringify({ Comment: "Insert your JSON here" }, null, 2);
  openModal("Start execution", `<div class="field"><label>Name - optional</label><input name="name" maxlength="80" value="${escapeHtml(crypto.randomUUID())}"><span class="hint">Enter a custom execution name to override the generated default.</span></div><div class="field"><label>Input - optional</label><textarea name="input" class="code-editor" spellcheck="false">${escapeHtml(initial)}</textarea><span class="sfn-field-error" data-input-error role="alert" hidden></span><span class="hint">Enter input values for this execution in JSON format. Input is captured immutably with the current definition revision.</span></div>`, "Start execution", async data => {
    const name = String(data.get("name") || "").trim();
    const problem = name ? resourceNameProblem(name, "Execution name") : null;
    if (problem) throw new Error(problem);
    const text = String(data.get("input") || "").trim() || "{}";
    const result = await states("StartExecution", { stateMachineArn: machine.stateMachineArn, name: name || undefined, input: text });
    context.toast("Execution started");
    location.hash = executionHref(result.executionArn);
  }, true);
  const dialog = document.querySelector("dialog[open]");
  const textarea = dialog?.querySelector('[name="input"]');
  const region = dialog?.querySelector("[data-input-error]");
  const check = () => {
    let message = "";
    if (textarea.value.trim()) { try { JSON.parse(textarea.value); } catch (error) { message = `Input must be valid JSON. ${error instanceof Error ? error.message : ""}`.trim(); } }
    textarea.setCustomValidity(message);
    region.textContent = message;
    region.hidden = !message;
  };
  textarea?.addEventListener("input", check);
  if (textarea) check();
}

function openStopExecution(execution, after) {
  openModal("Stop execution", `<p>Stop execution <strong>${escapeHtml(execution.name)}</strong>? Stopping an execution cannot be undone; its status becomes Aborted.</p><div class="field"><label>Error - optional</label><input name="error" maxlength="256"><span class="hint">An error code recorded on the aborted execution.</span></div><div class="field"><label>Cause - optional</label><textarea name="cause" maxlength="32768"></textarea><span class="hint">A description of why the execution was stopped.</span></div>`, "Stop execution", async data => {
    const error = String(data.get("error") || "").trim();
    const cause = String(data.get("cause") || "").trim();
    await states("StopExecution", { executionArn: execution.executionArn, ...(error ? { error } : {}), ...(cause ? { cause } : {}) });
    context.toast("Execution stopped");
    await after?.();
  }, false, { danger: true, refreshAfterSubmit: !after });
}

function confirmDeleteMachine(machine, after) {
  confirmDeletion(machine.name, `Delete state machine ${machine.name}? Existing executions retain their immutable definition snapshots and histories and remain accessible by execution ARN.`, async () => {
    await states("DeleteStateMachine", { stateMachineArn: machine.stateMachineArn });
    context.toast("State machine deleted; retained executions were not removed");
    await after?.();
  });
}

// ---------------------------------------------------------------------------
// Activities

function activityNameField() {
  return '<div class="field"><label>Name</label><input name="name" required maxlength="80"><span class="hint">Up to 80 characters; no white space, brackets, wildcards or the characters " # % \\ ^ | ~ ` $ &amp; , ; : /.</span></div>';
}

async function activitiesPage() {
  const values = await all("ListActivities", "activities"); context.setChrome("step-functions", ["Step Functions", "Activities"]);
  const rows = values.map(activity => `<tr><td><a href="${activityHref(activity.activityArn)}">${escapeHtml(activity.name)}</a></td><td class="mono sfn-wrap">${escapeHtml(activity.activityArn)}</td><td>${formatDate(activity.creationDate)}</td><td><button class="button danger" type="button" data-delete-activity="${escapeHtml(activity.activityArn)}" data-name="${escapeHtml(activity.name)}">Delete</button></td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("Activities", "Durable worker tasks with opaque task tokens and restart-safe completion.", '<button class="button refresh" type="button" data-refresh aria-label="Refresh activities">↻</button><button class="button primary" type="button" data-create-activity>Create activity</button>')}<div class="alert info"><strong>Lease-safe view</strong><br>Worker names and raw task tokens are never displayed. Waiting, heartbeat, timeout, and completion transitions remain visible on their execution histories.</div><section class="card"><div class="card-header"><h2>Activity catalog <span class="muted">(${values.length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>ARN</th><th>Creation date</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("A", "No activities", "Create an Activity for a long-polling worker.")}</section>${unsupportedBoundary("activities")}</div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
  context.main.querySelector("[data-create-activity]")?.addEventListener("click", () => {
    openModal("Create activity", `${activityNameField()}<h3>Tags - optional</h3>${tagEditorMarkup()}<p class="muted">AWS-owned local encryption is used. Customer-managed KMS keys remain unavailable.</p>`, "Create activity", async data => {
      const name = String(data.get("name") || "").trim();
      const problem = resourceNameProblem(name, "Activity name");
      if (problem) throw new Error(problem);
      await states("CreateActivity", { name, tags: readTagEditor(document.querySelector("dialog[open]")) });
      context.toast("Activity created");
      await context.route();
    }, true);
    bindTagEditor(document.querySelector("dialog[open]"));
  });
  context.main.querySelectorAll("[data-delete-activity]").forEach(button => button.addEventListener("click", () => confirmDeletion(button.dataset.name, `Delete activity ${button.dataset.name}? Already issued task tokens remain bound to their executions.`, async () => { await states("DeleteActivity", { activityArn: button.dataset.deleteActivity }); context.toast("Activity deleted"); await context.route(); })));
}

async function activityPage(arn) {
  const [activity, tagResult] = await Promise.all([states("DescribeActivity", { activityArn: arn }), states("ListTagsForResource", { resourceArn: arn })]);
  const tags = tagResult.tags ?? [];
  context.setChrome("step-functions", ["Step Functions", "Activities", activity.name]);
  context.main.innerHTML = `<div class="page-width sfn-detail">${pageHeader(activity.name, escapeHtml(activity.activityArn), '<a class="button" href="#/step-functions/activities">All activities</a><button class="button danger" type="button" data-delete-activity>Delete</button>')}<section class="card"><div class="card-header"><h2>Activity details</h2></div><div class="card-body"><dl class="key-value"><dt>Name</dt><dd>${escapeHtml(activity.name)}</dd><dt>ARN</dt><dd>${copyable(activity.activityArn)}</dd><dt>Creation date</dt><dd>${formatDate(activity.creationDate)}</dd><dt>Encryption</dt><dd>AWS-owned local encryption; no KMS calls</dd></dl></div></section>${originMarkup(tags)}${tagsBody(tags, "activity")}<div class="alert info"><strong>Worker and execution history</strong><br>Use this ARN with GetActivityTask and return task responses through the SDK. <a href="#/step-functions/executions">Inspect execution histories</a> for waiting, heartbeat, timeout, and completion transitions. Worker names and raw task tokens are never displayed. Already issued task tokens remain bound to their executions after deletion.</div></div>`;
  bindTagManagement(context.main, arn, tags);
  context.main.querySelector("[data-delete-activity]")?.addEventListener("click", () => confirmDeletion(activity.name, `Delete activity ${activity.name}? Already issued task tokens remain bound to their executions.`, async () => { await states("DeleteActivity", { activityArn: arn }); context.toast("Activity deleted"); location.hash = "#/step-functions/activities"; }));
}

// ---------------------------------------------------------------------------
// State machines list

async function listPage() {
  const values = await machines();
  context.setChrome("step-functions", ["Step Functions", "State machines"]);
  const rows = values.map(machine => `<tr data-machine-row data-type="${escapeHtml(machine.type)}" data-search="${escapeHtml(`${machine.name} ${machine.stateMachineArn}`.toLowerCase())}"><td><input type="radio" name="machine" value="${escapeHtml(machine.stateMachineArn)}" aria-label="Select ${escapeHtml(machine.name)}"></td><td><a href="${machineHref(machine.stateMachineArn)}">${escapeHtml(machine.name)}</a></td><td>${escapeHtml(displayLabel(machine.type))}</td><td>${formatDate(machine.creationDate)}</td><td>${status("ACTIVE")}</td><td class="mono sfn-wrap">${escapeHtml(machine.stateMachineArn)}</td></tr>`).join("");
  const toolbar = `<button class="button refresh" type="button" data-refresh aria-label="Refresh state machines">↻</button><button class="button" type="button" data-machine-action="view" disabled>View details</button><button class="button" type="button" data-machine-action="edit" disabled>Edit</button><button class="button" type="button" data-machine-action="copy" disabled>Copy to new</button><button class="button" type="button" data-machine-action="delete" disabled>Delete</button><a class="button primary" href="${LIST_HREF}/create">Create state machine</a>`;
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("State machines", "Durable Standard Workflows in the selected account and Region.")}<section class="card"><div class="card-header"><h2>State machines <span class="muted">(${values.length})</span></h2><div class="actions">${toolbar}</div></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-sfn-filter placeholder="Search state machines"></label><select data-type-filter aria-label="Filter by type"><option value="">Any type</option><option value="STANDARD">Standard</option><option value="EXPRESS">Express</option></select></div>${rows ? `<div class="table-wrap"><table class="sfn-table"><thead><tr><th><span class="sr-only">Select</span></th><th>Name</th><th>Type</th><th>Creation date</th><th>Status</th><th>ARN</th></tr></thead><tbody>${rows}<tr data-no-match hidden><td colspan="6" class="muted">No state machines match the search and type filter.</td></tr></tbody></table></div>` : emptyState("S", "No state machines", "Create a JSONPath Standard Workflow.", `<a class="button primary" href="${LIST_HREF}/create">Create state machine</a>`)}</section></div>`;
  const root = context.main;
  const filter = root.querySelector("[data-sfn-filter]");
  const type = root.querySelector("[data-type-filter]");
  const selected = () => values.find(machine => machine.stateMachineArn === root.querySelector('input[name="machine"]:checked')?.value);
  const syncButtons = () => root.querySelectorAll("[data-machine-action]").forEach(button => { button.disabled = !selected(); });
  const applyFilter = () => {
    const query = filter.value.trim().toLowerCase();
    let shown = 0;
    root.querySelectorAll("[data-machine-row]").forEach(row => {
      const visible = (!query || row.dataset.search.includes(query)) && (!type.value || row.dataset.type === type.value);
      row.hidden = !visible;
      if (visible) shown++;
      else { const radio = row.querySelector("input"); if (radio.checked) radio.checked = false; }
    });
    const none = root.querySelector("[data-no-match]");
    if (none) none.hidden = shown > 0 || !values.length;
    const count = root.querySelector(".card h2 .muted");
    if (count) count.textContent = shown === values.length ? `(${values.length})` : `(${shown} of ${values.length})`;
    syncButtons();
  };
  filter?.addEventListener("input", applyFilter);
  type?.addEventListener("change", applyFilter);
  root.querySelectorAll('input[name="machine"]').forEach(radio => radio.addEventListener("change", syncButtons));
  root.querySelectorAll("[data-machine-action]").forEach(button => button.addEventListener("click", () => {
    const machine = selected();
    if (!machine) return;
    if (button.dataset.machineAction === "view") location.hash = machineHref(machine.stateMachineArn);
    else if (button.dataset.machineAction === "edit") location.hash = `${machineHref(machine.stateMachineArn)}/edit`;
    else if (button.dataset.machineAction === "copy") location.hash = `${LIST_HREF}/create/${encoded(machine.stateMachineArn)}`;
    else confirmDeleteMachine(machine, () => context.route());
  }));
  root.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
}

// ---------------------------------------------------------------------------
// Create and edit (Workflow Studio)

function configMarkup({ mode, name, roleArn, roleMode, tags = [] }) {
  const details = mode === "create"
    ? `<div class="field"><label>State machine name</label><input name="name" data-dirty-track required maxlength="80" value="${escapeHtml(name)}"><span class="hint">Up to 80 characters; no white space, brackets, wildcards or the characters " # % \\ ^ | ~ \` $ &amp; , ; : /.</span></div>`
    : `<dl class="key-value"><dt>State machine name</dt><dd>${escapeHtml(name)}</dd></dl><p class="muted">A state machine cannot be renamed. Use Copy to new to create one with another name.</p>`;
  const choice = (group, value, label, { checked = false, disabled = false, note = "" } = {}) => `<label class="sfn-choice ${disabled ? "disabled" : ""}"><input type="radio" name="${group}" value="${value}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}> <span><strong>${label}</strong>${note ? `<small>${note}</small>` : ""}</span></label>`;
  return `<div class="sfn-config">
<section class="card"><div class="card-header"><h2>Details</h2></div><div class="card-body">${details}
<fieldset class="sfn-fieldset"><legend>Type</legend>${choice("machineType", "STANDARD", "Standard", { checked: true, note: "Durable, checkpointed workflows that can run for up to a year with a retained execution history." })}${choice("machineType", "EXPRESS", "Express", { disabled: true, note: `Express workflows — ${UNAVAILABLE}.` })}</fieldset>
<fieldset class="sfn-fieldset"><legend>State machine query language</legend>${choice("queryLanguage", "JSONPath", "JSONPath", { checked: true, note: "Paths, Parameters, ResultSelector and ResultPath." })}${choice("queryLanguage", "JSONata", "JSONata", { disabled: true, note: `JSONata and variables — ${UNAVAILABLE}.` })}</fieldset></div></section>
<section class="card"><div class="card-header"><h2>Permissions</h2></div><div class="card-body"><fieldset class="sfn-fieldset"><legend>Execution role</legend>${choice("roleMode", "new", "Create new role", { checked: roleMode === "new", note: "Recommended. Creates an IAM role that trusts states.amazonaws.com with permissions for the resources in your definition. You confirm the role before it is created." })}${choice("roleMode", "existing", "Choose an existing role", { checked: roleMode !== "new", note: "Pick a local role or enter a role ARN." })}</fieldset><div class="field" data-role-existing ${roleMode === "new" ? "hidden" : ""}><label>Execution role ARN</label><input name="roleArn" data-dirty-track placeholder="arn:aws:iam::000000000000:role/workflow-role" value="${escapeHtml(roleArn ?? "")}"><span class="hint">The role must trust states.amazonaws.com. IAM enforcement also requires iam:PassRole.</span></div></div></section>
<section class="card"><div class="card-header"><h2>Logging</h2></div><div class="card-body"><div class="field"><label>Log level</label><select disabled><option>OFF</option><option>ALL</option><option>ERROR</option><option>FATAL</option></select><span class="hint">Execution logging to CloudWatch Logs — ${UNAVAILABLE}. Standard execution history is always retained and shown on each execution.</span></div></div></section>
<section class="card"><div class="card-header"><h2>Additional configuration</h2></div><div class="card-body"><label class="sfn-choice disabled"><input type="checkbox" disabled> <span><strong>Enable X-Ray tracing</strong><small>${UNAVAILABLE}.</small></span></label><label class="sfn-choice disabled"><input type="checkbox" disabled> <span><strong>Publish version on creation</strong><small>Versions and aliases — ${UNAVAILABLE}.</small></span></label><fieldset class="sfn-fieldset"><legend>Encryption</legend>${choice("encryption", "AWS_OWNED_KEY", "Encrypt with AWS owned key", { checked: true, note: "Local persistence protections are used; no KMS call is made." })}${choice("encryption", "CUSTOMER_MANAGED_KMS_KEY", "Encrypt with customer managed key", { disabled: true, note: `${UNAVAILABLE}.` })}</fieldset></div></section>
${mode === "create" ? `<section class="card"><div class="card-header"><h2>Tags - optional</h2></div><div class="card-body">${tagEditorMarkup(tags)}</div></section>` : '<p class="muted">Manage tags on the Tags tab of the state machine.</p>'}
</div>`;
}

function confirmRoleCreation(roleName, statements) {
  return new Promise(resolve => {
    let confirmed = false;
    const policy = statements.length
      ? `<pre class="code-box">${escapeHtml(JSON.stringify({ Version: "2012-10-17", Statement: statements }, null, 2))}</pre>`
      : '<p class="muted">The definition calls no service that needs a permission, so the role is created without a policy.</p>';
    openModal("Confirm role creation", `<p>Step Functions will create this IAM role and use it as the execution role.</p><dl class="key-value"><dt>Role name</dt><dd class="mono sfn-wrap">${escapeHtml(roleName)}</dd><dt>Trusted service</dt><dd class="mono">states.amazonaws.com</dd></dl><details class="sfn-details" open><summary>View role settings</summary>${policy}</details>`, "Confirm", async () => { confirmed = true; }, true, { refreshAfterSubmit: false });
    document.querySelector("dialog[open]")?.addEventListener("close", () => resolve(confirmed), { once: true });
  });
}

/** Returns the execution role ARN to use, creating a role when "Create new role" is selected; null when the user cancels. */
async function resolveExecutionRole(data, machineName, definition) {
  if (data.get("roleMode") !== "new") {
    const roleArn = String(data.get("roleArn") || "").trim();
    if (!roleArn) throw new Error("Choose an existing execution role in Config, or select Create new role.");
    return roleArn;
  }
  const roleName = generatedRoleName(machineName);
  const statements = executionRoleStatements(definition);
  if (!await confirmRoleCreation(roleName, statements)) return null;
  const created = await awsQuery("iam", "CreateRole", { RoleName: roleName, Description: `Execution role for the ${machineName} state machine`, AssumeRolePolicyDocument: JSON.stringify(executionRoleTrustPolicy()) });
  if (statements.length) await awsQuery("iam", "PutRolePolicy", { RoleName: roleName, PolicyName: "StepFunctionsExecutionPolicy", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: statements }) });
  context.toast(`IAM role ${roleName} created`);
  return created.value("Arn");
}

function bindDefinitionForm(form, submit) {
  const region = form.querySelector(".sfn-validation");
  const fail = (message, mode) => {
    region.innerHTML = `<div class="alert error" role="alert"><strong>${escapeHtml(message)}</strong></div>`;
    if (mode) showStudioMode(form, mode);
    return false;
  };
  const validate = async () => {
    try { syncStudioBeforeSubmit(form); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    const definition = String(form.elements.definition.value || "").trim();
    if (!definition) return fail("Definition is required. Add states in Design mode or paste States Language JSON in Code mode.");
    region.innerHTML = '<span class="loading-inline">Validating definition…</span>';
    const result = await states("ValidateStateMachineDefinition", { definition, type: "STANDARD" });
    region.innerHTML = validationHtml(result);
    return result.result === "OK";
  };
  form.querySelector("[data-validate]").addEventListener("click", async () => { try { await validate(); } catch (error) { context.showError(error); } });
  form.querySelectorAll('input[name="roleMode"]').forEach(radio => radio.addEventListener("change", () => {
    form.querySelector("[data-role-existing]").hidden = form.querySelector('input[name="roleMode"]:checked')?.value === "new";
  }));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      if (!await validate()) return;
      const outcome = await submit(new FormData(form), fail);
      if (outcome !== false) setDirty(false, "all");
    } catch (error) { context.showError(error); }
    finally { button.disabled = false; }
  });
}

function studioPage({ title, description, cardTitle, formId, definitionJson, config, submitLabel, validateLabel, cancelHref, notice = "" }) {
  const actions = `<button class="button" type="button" data-validate>${validateLabel}</button><a class="button" href="${cancelHref}">Cancel</a><button class="button primary" type="submit">${submitLabel}</button>`;
  context.main.innerHTML = `<div class="page-width sfn-page sfn-studio-page">${pageHeader(title, description)}${notice}<section class="card"><div class="card-header"><h2>${cardTitle}</h2></div><div class="card-body"><form id="${formId}" novalidate>${workflowStudioMarkup({ definitionJson, configHtml: config, actionsHtml: actions })}<div class="sfn-validation" role="status" aria-live="polite"></div></form></div></section>${unsupportedBoundary()}</div>`;
  const form = context.main.querySelector(`#${formId}`);
  associateFormLabels(context.main);
  enhanceArnComboboxes(context.main);
  bindWorkflowStudio(form, { exportName: () => form.elements.name?.value || title.replace(/^Edit /, "") });
  bindTagEditor(form);
  decorateStepFunctionsPanelHelp(context.main);
  return form;
}

async function createPage(copyArn) {
  context.setChrome("step-functions", ["Step Functions", { label: "State machines", href: LIST_HREF }, "Create state machine"]);
  const source = copyArn ? await states("DescribeStateMachine", { stateMachineArn: copyArn }) : null;
  const sourceTags = copyArn ? (await states("ListTagsForResource", { resourceArn: copyArn })).tags ?? [] : [];
  const defaultName = source ? `${source.name}-copy`.slice(0, 80) : `MyStateMachine-${Math.random().toString(36).slice(2, 11)}`;

  const openStudio = (name, definition, template) => {
    const form = studioPage({
      title: "Create state machine", description: "Build a JSONPath Standard Workflow in Workflow Studio: Design, Code, or Config.", cardTitle: "Workflow configuration", formId: "sfn-create",
      definitionJson: pretty(definition), submitLabel: "Create", validateLabel: "Validate", cancelHref: LIST_HREF,
      config: configMarkup({ mode: "create", name, roleArn: source?.roleArn, roleMode: source ? "existing" : "new", tags: tagsToRows(sourceTags) }),
    });
    bindDefinitionForm(form, async (data, fail) => {
      const machineName = String(data.get("name") || "").trim();
      const problem = resourceNameProblem(machineName, "State machine name");
      if (problem) return fail(problem, "config");
      let tags;
      try { tags = readTagEditor(form); } catch (error) { return fail(error instanceof Error ? error.message : String(error), "config"); }
      const definitionText = String(data.get("definition"));
      let roleArn;
      try { roleArn = await resolveExecutionRole(data, machineName, definitionText); } catch (error) { return fail(error instanceof Error ? error.message : String(error), "config"); }
      if (!roleArn) return false;
      const created = await states("CreateStateMachine", { name: machineName, definition: definitionText, roleArn, type: "STANDARD", tags });
      context.toast("State machine created");
      sessionStorage.setItem(START_AFTER_CREATE, JSON.stringify({ arn: created.stateMachineArn, input: template === "hello" ? JSON.stringify(HELLO_WORLD_INPUT, null, 2) : undefined }));
      setDirty(false, "all");
      location.hash = machineHref(created.stateMachineArn);
      return true;
    });
  };

  if (source) { openStudio(defaultName, parseStateMachineDefinition(source.definition) ?? BLANK_DEFINITION, "copy"); return; }
  const tile = (value, title, text, checked) => `<label class="sfn-choice sfn-template"><input type="radio" name="template" value="${value}" ${checked ? "checked" : ""}> <span><strong>${title}</strong><small>${text}</small></span></label>`;
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("Create state machine", "Choose how to start, name the state machine, then continue to Workflow Studio.")}<section class="card"><div class="card-header"><h2>Choose a template</h2></div><div class="card-body"><form id="sfn-create-start"><fieldset class="sfn-fieldset sfn-template-grid"><legend class="sr-only">Template</legend>${tile("blank", "Create from blank", "Start with a single Pass state and build the workflow yourself.", true)}${tile("hello", "Create from template: Hello World", "A starter workflow with Pass, Choice, Wait, Parallel, Success and Fail states that runs without any other resource.", false)}</fieldset><div class="field"><label>State machine name</label><input name="name" required maxlength="80" value="${escapeHtml(defaultName)}"></div><fieldset class="sfn-fieldset"><legend>State machine type</legend><label class="sfn-choice"><input type="radio" name="machineType" value="STANDARD" checked> <span><strong>Standard</strong><small>Durable, checkpointed workflows with a retained execution history.</small></span></label><label class="sfn-choice disabled"><input type="radio" name="machineType" value="EXPRESS" disabled> <span><strong>Express</strong><small>Express workflows — ${UNAVAILABLE}.</small></span></label></fieldset><div class="sfn-validation" role="status" aria-live="polite"></div><div class="actions"><a class="button" href="${LIST_HREF}">Cancel</a><button class="button primary" type="submit">Continue</button></div></form></div></section>${unsupportedBoundary()}</div>`;
  const start = context.main.querySelector("#sfn-create-start");
  start.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(start);
    const name = String(data.get("name") || "").trim();
    const problem = resourceNameProblem(name, "State machine name");
    if (problem) { start.querySelector(".sfn-validation").innerHTML = `<div class="alert error" role="alert"><strong>${escapeHtml(problem)}</strong></div>`; return; }
    openStudio(name, data.get("template") === "hello" ? HELLO_WORLD_DEFINITION : BLANK_DEFINITION, String(data.get("template")));
    context.main.focus?.({ preventScroll: true });
  });
}

async function editPage(arn) {
  const machine = await states("DescribeStateMachine", { stateMachineArn: arn });
  context.setChrome("step-functions", ["Step Functions", { label: "State machines", href: LIST_HREF }, { label: machine.name, href: machineHref(arn) }, "Edit"]);
  const form = studioPage({
    title: `Edit ${machine.name}`, description: "Update the definition in Design or Code mode, or the execution role in Config mode.", cardTitle: "Definition and role", formId: "sfn-edit",
    definitionJson: pretty(machine.definition), submitLabel: "Save", validateLabel: "Validate", cancelHref: machineHref(arn),
    config: configMarkup({ mode: "edit", name: machine.name, roleArn: machine.roleArn, roleMode: "existing" }),
    notice: '<div class="alert info" role="status"><strong>Executions keep immutable snapshots.</strong><br>Existing executions continue with the definition, role, and revision captured when they started. This update applies only to new executions.</div>',
  });
  bindDefinitionForm(form, async (data, fail) => {
    const definitionText = String(data.get("definition"));
    let roleArn;
    try { roleArn = await resolveExecutionRole(data, machine.name, definitionText); } catch (error) { return fail(error instanceof Error ? error.message : String(error), "config"); }
    if (!roleArn) return false;
    const result = await states("UpdateStateMachine", { stateMachineArn: arn, definition: definitionText, roleArn });
    sessionStorage.setItem(`sfn-update:${arn}`, JSON.stringify({ updateDate: result.updateDate, revisionId: result.revisionId }));
    context.toast("State machine updated; existing execution snapshots are unchanged");
    setDirty(false, "all");
    location.hash = machineHref(arn);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Executions table (state machine Executions tab and account-wide page)

const EXECUTION_PAGE_SIZE = 20;

function executionsCard(values, { showMachine = false, startButton = false } = {}) {
  const toolbar = `<button class="button refresh" type="button" data-refresh aria-label="Refresh executions">↻</button><button class="button" type="button" data-execution-action="view" disabled>View details</button><button class="button" type="button" data-execution-action="stop" disabled>Stop execution</button>${unavailable("Redrive")}${startButton ? '<button class="button primary" type="button" data-start>Start execution</button>' : ""}`;
  const head = `<th><span class="sr-only">Select</span></th><th>Name</th>${showMachine ? "<th>State machine</th>" : ""}<th>Status</th><th>Started</th><th>End time</th><th>Duration</th>`;
  return `<section class="card" data-executions-card><div class="card-header"><h2>Executions <span class="muted">(${values.length})</span></h2><div class="actions">${toolbar}</div></div>${values.length ? `<div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-execution-search placeholder="Search executions by name"></label><select data-execution-status aria-label="Filter by status"><option value="">Filter by status</option>${["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"].map(value => `<option value="${value}">${displayLabel(value)}</option>`).join("")}</select></div><div class="table-wrap"><table class="sfn-executions"><thead><tr>${head}</tr></thead><tbody data-execution-rows></tbody></table></div><nav class="pagination sfn-event-pagination" aria-label="Execution pages" data-execution-pages></nav>` : emptyState("▷", "No executions", "Start an execution to inspect state transitions and history.")}</section>`;
}

function bindExecutionsCard(root, values, { showMachine = false } = {}) {
  const card = root.querySelector("[data-executions-card]");
  if (!card) return;
  card.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
  const body = card.querySelector("[data-execution-rows]");
  if (!body) return;
  const search = card.querySelector("[data-execution-search]");
  const filter = card.querySelector("[data-execution-status]");
  let page = 0;
  let selectedArn = null;
  const selected = () => values.find(item => item.executionArn === selectedArn);
  const syncButtons = () => {
    const item = selected();
    card.querySelector('[data-execution-action="view"]').disabled = !item;
    card.querySelector('[data-execution-action="stop"]').disabled = item?.status !== "RUNNING";
  };
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const matches = values.filter(item => (!query || item.name.toLowerCase().includes(query)) && (!filter.value || item.status === filter.value));
    const pages = Math.max(1, Math.ceil(matches.length / EXECUTION_PAGE_SIZE));
    page = Math.min(page, pages - 1);
    if (!matches.some(item => item.executionArn === selectedArn)) selectedArn = null;
    const columns = showMachine ? 7 : 6;
    body.innerHTML = matches.slice(page * EXECUTION_PAGE_SIZE, page * EXECUTION_PAGE_SIZE + EXECUTION_PAGE_SIZE).map(item => {
      const machineName = item.stateMachineArn?.split(":").at(-1) ?? "";
      return `<tr><td><input type="radio" name="execution" value="${escapeHtml(item.executionArn)}" ${item.executionArn === selectedArn ? "checked" : ""} aria-label="Select ${escapeHtml(item.name)}"></td><td><a href="${executionHref(item.executionArn)}">${escapeHtml(item.name)}</a></td>${showMachine ? `<td><a href="${machineHref(item.stateMachineArn)}">${escapeHtml(machineName)}</a></td>` : ""}<td>${status(item.status)}</td><td>${formatTimestamp(item.startDate)}</td><td>${item.stopDate ? formatTimestamp(item.stopDate) : "–"}</td><td>${formatDuration(item.startDate, item.stopDate)}</td></tr>`;
    }).join("") || `<tr><td colspan="${columns}" class="muted">No executions match the search and status filter.</td></tr>`;
    const count = card.querySelector("h2 .muted");
    if (count) count.textContent = matches.length === values.length ? `(${values.length})` : `(${matches.length} of ${values.length})`;
    card.querySelector("[data-execution-pages]").innerHTML = pages > 1 ? `<button class="button" type="button" data-execution-page="previous" ${page === 0 ? "disabled" : ""}>Previous</button><span>Page ${page + 1} of ${pages}</span><button class="button" type="button" data-execution-page="next" ${page + 1 >= pages ? "disabled" : ""}>Next</button>` : "";
    body.querySelectorAll('input[name="execution"]').forEach(radio => radio.addEventListener("change", () => { selectedArn = radio.value; syncButtons(); }));
    card.querySelector('[data-execution-page="previous"]')?.addEventListener("click", () => { page--; render(); });
    card.querySelector('[data-execution-page="next"]')?.addEventListener("click", () => { page++; render(); });
    syncButtons();
  };
  search.addEventListener("input", () => { page = 0; render(); });
  filter.addEventListener("change", () => { page = 0; render(); });
  card.querySelector('[data-execution-action="view"]').addEventListener("click", () => { const item = selected(); if (item) location.hash = executionHref(item.executionArn); });
  card.querySelector('[data-execution-action="stop"]').addEventListener("click", () => { const item = selected(); if (item) openStopExecution(item); });
  render();
}

// ---------------------------------------------------------------------------
// State machine detail

const MACHINE_SECTIONS = ["executions", "monitoring", "logging", "definition", "aliases", "versions", "tags", "overview"];

function machineTabs(arn, active) {
  const labels = { executions: "Executions", monitoring: "Monitoring", logging: "Logging", definition: "Definition", aliases: "Aliases", versions: "Versions", tags: "Tags", overview: "Overview" };
  return tabs(MACHINE_SECTIONS.map(section => ({ label: labels[section], href: `${machineHref(arn)}/${section}`, active: active === section })));
}

function definitionPanel(definition, { label = "Workflow graph" } = {}) {
  return `<div class="sfn-flow-host">${flowToolbarHtml()}${flowGraphHtml(definition, { mode: "definition", label })}</div>`;
}

function monitoringBody(executionList) {
  const count = value => executionList.filter(item => item.status === value).length;
  const finished = executionList.filter(item => item.stopDate).map(item => epochMilliseconds(item.stopDate) - epochMilliseconds(item.startDate));
  const average = finished.length ? finished.reduce((sum, value) => sum + value, 0) / finished.length : undefined;
  const tile = (label, value) => `<div class="sfn-metric"><span>${label}</span><strong>${value}</strong></div>`;
  return `<section class="card"><div class="card-header"><h2>Execution metrics</h2><a class="button" href="#/cloudwatch/metrics">View in CloudWatch</a></div><div class="card-body"><div class="sfn-metric-grid">${tile("Executions started", executionList.length)}${tile("Executions succeeded", count("SUCCEEDED"))}${tile("Executions failed", count("FAILED"))}${tile("Executions timed out", count("TIMED_OUT"))}${tile("Executions aborted", count("ABORTED"))}${tile("Running", count("RUNNING"))}${tile("Average execution time", formatElapsed(average))}${tile("Longest execution time", formatElapsed(finished.length ? Math.max(...finished) : undefined))}</div><p class="muted">Totals are computed from the retained executions of this state machine. The same executions publish ExecutionsStarted, ExecutionsSucceeded, ExecutionsFailed, ExecutionsTimedOut, ExecutionsAborted and ExecutionTime to the AWS/States namespace in CloudWatch with the StateMachineArn dimension.</p></div></section>`;
}

function unavailableTab(title, description, action) {
  return `<section class="card"><div class="card-header"><h2>${title}</h2>${unavailable(action)}</div>${emptyState("◇", `${title} are not available in StackSim`, description)}</section>`;
}

async function machinePage(arn, section = "executions") {
  if (!MACHINE_SECTIONS.includes(section)) return context.notFound(["step-functions", "state-machines", arn, section]);
  const [machine, executionList, tagResult] = await Promise.all([states("DescribeStateMachine", { stateMachineArn: arn }), executions(arn), states("ListTagsForResource", { resourceArn: arn })]);
  const tags = tagResult.tags ?? [];
  context.setChrome("step-functions", ["Step Functions", { label: "State machines", href: LIST_HREF }, machine.name]);
  const actions = `<button class="button refresh" type="button" data-refresh aria-label="Refresh state machine">↻</button><a class="button" href="${machineHref(arn)}/edit">Edit</a><button class="button primary" type="button" data-start>Start execution</button>${actionsMenu([["data-copy-machine", "Copy to new"], ["data-export-definition", "Export definition"], ["", "Publish version", { disabled: true }], ["", "Create alias", { disabled: true }], ["data-delete-menu", "Delete", { danger: true }]])}<button class="button danger" type="button" data-delete>Delete</button>`;
  let latestUpdate;
  try { latestUpdate = JSON.parse(sessionStorage.getItem(`sfn-update:${arn}`) || "null"); } catch { latestUpdate = null; }
  const details = `<section class="card"><div class="card-header"><h2>Details</h2></div><div class="card-body"><dl class="key-value sfn-key-grid"><dt>ARN</dt><dd>${copyable(machine.stateMachineArn)}</dd><dt>IAM role ARN</dt><dd class="mono sfn-wrap">${roleMarkup(machine.roleArn)}</dd><dt>Type</dt><dd>${escapeHtml(displayLabel(machine.type))}</dd><dt>Status</dt><dd>${status(machine.status)}</dd><dt>Creation date</dt><dd>${formatDate(machine.creationDate)}</dd>${latestUpdate?.revisionId === machine.revisionId ? `<dt>Latest update</dt><dd>${formatDate(latestUpdate.updateDate)}</dd>` : ""}<dt>Revision</dt><dd class="mono sfn-wrap">${escapeHtml(machine.revisionId)}</dd><dt>Query language</dt><dd>JSONPath</dd><dt>Logging</dt><dd>OFF</dd><dt>X-Ray tracing</dt><dd>Disabled</dd></dl></div></section>`;
  let body;
  if (section === "definition") body = `<section class="card"><div class="card-header"><h2>Definition</h2><div class="actions"><button class="button" type="button" data-export-definition>Export</button><a class="button" href="${machineHref(arn)}/edit">Edit definition</a></div></div><div class="card-body"><div class="alert info"><strong>Read-only graph</strong><br>This view inspects the saved definition. Use Edit definition for Workflow Studio.</div><div class="sfn-definition-split"><div><h3>Code</h3><pre class="code-box sfn-definition">${escapeHtml(pretty(machine.definition))}</pre></div><div><h3>Graph</h3>${definitionPanel(machine.definition)}</div></div></div></section>${lambdaLinks(machine.definition)}${integrationLinks(machine.definition)}`;
  else if (section === "executions") body = `${executionsCard(executionList, { startButton: true })}${lambdaLinks(machine.definition)}${integrationLinks(machine.definition)}`;
  else if (section === "tags") body = tagsBody(tags);
  else if (section === "monitoring") body = monitoringBody(executionList);
  else if (section === "logging") body = `<section class="card"><div class="card-header"><h2>Logging</h2></div><div class="card-body"><dl class="key-value"><dt>Log level</dt><dd>OFF</dd><dt>Include execution data</dt><dd>No</dd><dt>CloudWatch log group</dt><dd>–</dd></dl><p class="muted">Execution logging to CloudWatch Logs — ${UNAVAILABLE}. Standard executions keep their full event history; open an execution and choose Event view. Lambda functions called by this workflow write to their own log groups, linked below.</p></div></section>${lambdaLinks(machine.definition)}`;
  else if (section === "aliases") body = unavailableTab("Aliases", "An alias routes executions to one or two versions of a state machine. Executions here always use the latest saved definition.", "Create new alias");
  else if (section === "versions") body = unavailableTab("Versions", "A version is a numbered, immutable snapshot of a state machine. Each execution here still records the definition revision it started with.", "Publish new version");
  else body = `<div class="sfn-summary"><section class="card"><div class="card-header"><h2>Execution count</h2></div><div class="card-body"><div class="metric">${executionList.length}</div><p class="muted">${executionList.filter(item => item.status === "RUNNING").length} running · ${executionList.filter(item => terminalStatuses.has(item.status)).length} terminal</p><a href="${machineHref(arn)}/executions">View executions</a></div></section><section class="card"><div class="card-header"><h2>Workflow graph</h2></div><div class="card-body">${definitionPanel(machine.definition)}</div></section></div>${lambdaLinks(machine.definition)}${integrationLinks(machine.definition)}${unsupportedBoundary()}`;
  context.main.innerHTML = `<div class="page-width sfn-detail">${pageHeader(machine.name, "State machine", actions)}${details}${originMarkup(tags)}${machineTabs(arn, section)}${body}</div>`;
  const root = context.main;
  bindMenus(root);
  bindFlowControls(root);
  bindExecutionsCard(root, executionList);
  bindTagManagement(root, arn, tags);
  root.querySelector(".page-header [data-refresh]")?.addEventListener("click", () => context.route());
  root.querySelectorAll("[data-start]").forEach(button => button.addEventListener("click", () => openStartExecution(machine)));
  root.querySelectorAll("[data-export-definition]").forEach(button => button.addEventListener("click", () => download(`${machine.name}.asl.json`, pretty(machine.definition))));
  root.querySelector("[data-copy-machine]")?.addEventListener("click", () => { location.hash = `${LIST_HREF}/create/${encoded(arn)}`; });
  const remove = () => confirmDeleteMachine(machine, () => { location.hash = LIST_HREF; });
  root.querySelector("[data-delete]")?.addEventListener("click", remove);
  root.querySelector("[data-delete-menu]")?.addEventListener("click", remove);
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(START_AFTER_CREATE) || "null"); } catch { pending = null; }
  if (pending?.arn === arn) {
    sessionStorage.removeItem(START_AFTER_CREATE);
    openStartExecution(machine, { input: pending.input });
  }
}

async function executionsPage() {
  const machineList = await machines();
  const values = (await Promise.all(machineList.map(machine => executions(machine.stateMachineArn)))).flat().sort((a, b) => epochMilliseconds(b.startDate) - epochMilliseconds(a.startDate));
  context.setChrome("step-functions", ["Step Functions", "Executions"]);
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("Executions", "Standard Workflow executions across current state machines.")}${executionsCard(values, { showMachine: true })}</div>`;
  bindExecutionsCard(context.main, values, { showMachine: true });
}

// ---------------------------------------------------------------------------
// Execution details

function renderPayload(value, details, absentLabel) {
  if (value !== undefined) return `<pre class="code-box">${escapeHtml(pretty(value))}</pre>`;
  if (details?.included === false) return '<div class="sfn-data-state omitted">Execution data was omitted by the API request.</div>';
  return `<div class="sfn-data-state absent">${escapeHtml(absentLabel)}</div>`;
}

function payloadBlock(fieldValue, absentLabel) {
  if (fieldValue.state === "present") return `<pre class="code-box">${escapeHtml(pretty(redactSensitiveValue(fieldValue.value)))}</pre>`;
  if (fieldValue.state === "omitted") return '<div class="sfn-data-state omitted">Execution data was omitted by the history request.</div>';
  return `<div class="sfn-data-state absent">${escapeHtml(absentLabel)}</div>`;
}

function eventInspector(item) {
  if (!item) return '<div class="empty compact"><h3>Select an event</h3><p>Choose an event to inspect its typed details and linkage.</p></div>';
  const details = redactSensitiveValue(item.details);
  const fields = [["Event ID", item.event.id], ["Type", item.event.type], ["Timestamp", formatTimestamp(item.event.timestamp)], ["Previous event", item.event.previousEventId || "None"], ["State", item.stateName ?? details.name ?? "Not linked"], ["Resource", details.resource ?? "Absent"], ["Error", details.error ?? "Absent"], ["Cause", details.cause ?? "Absent"], ["Index", details.index ?? "Absent"]];
  const payloads = ["input", "output", "parameters"].map(name => {
    const value = payloadField(details, name);
    if (value.state === "absent") return `<div><h4>${escapeHtml(name)}</h4><div class="sfn-data-state absent">No ${escapeHtml(name)} field exists on this event.</div></div>`;
    if (value.state === "omitted") return `<div><h4>${escapeHtml(name)}</h4><div class="sfn-data-state omitted">${escapeHtml(name)} was omitted by the history request.</div></div>`;
    return `<div><h4>${escapeHtml(name)}</h4><pre class="code-box">${escapeHtml(pretty(value.value))}</pre></div>`;
  }).join("");
  return `<h3>Event ${item.event.id}</h3><dl class="key-value">${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd class="sfn-wrap">${escapeHtml(value)}</dd>`).join("")}</dl>${payloads}<details class="sfn-details"><summary>All typed details</summary><pre class="code-box">${escapeHtml(JSON.stringify(details, null, 2))}</pre></details>`;
}

function policySummary(state) {
  const retry = state.Retry?.length ? `<div><strong>Retry</strong>${state.Retry.map((item, index) => `<div class="sfn-policy"><span>Policy ${index + 1}: ${escapeHtml((item.ErrorEquals ?? []).join(", "))}</span><small>${escapeHtml(`${item.IntervalSeconds ?? 1}s · ×${item.BackoffRate ?? 2} · ${item.MaxAttempts ?? 3} attempts${item.MaxDelaySeconds ? ` · max ${item.MaxDelaySeconds}s` : ""}${item.JitterStrategy ? ` · ${item.JitterStrategy} jitter` : ""}`)}</small></div>`).join("")}</div>` : "";
  const catcher = state.Catch?.length ? `<div><strong>Catch</strong>${state.Catch.map(item => `<div class="sfn-policy"><span>${escapeHtml((item.ErrorEquals ?? []).join(", "))}</span><small>Next: ${escapeHtml(item.Next)}</small></div>`).join("")}</div>` : "";
  return { retry, catcher };
}

const STEP_TABS = [["input", "Input"], ["output", "Output"], ["details", "Details"], ["definition", "Definition"], ["retry", "Retry"], ["events", "Events"]];

function stepDetails(view, options) {
  const result = view.results.get(options.selectedState);
  if (!result) return '<div class="empty compact"><h3>Select a step</h3><p>Choose a state in the graph, table or state list to see its input, output and details.</p></div>';
  const visitIndex = Math.min(options.visit ?? result.visits.length - 1, result.visits.length - 1);
  const visit = result.visits[visitIndex];
  const visits = result.visits.length > 1 ? `<div class="field sfn-visit"><label>Visit</label><select data-step-visit>${result.visits.map((_, index) => `<option value="${index}" ${index === visitIndex ? "selected" : ""}>Visit ${index + 1} of ${result.visits.length}</option>`).join("")}</select></div>` : "";
  const notRun = '<div class="sfn-data-state absent">This state has not run in this execution.</div>';
  const policies = policySummary(result.state);
  const attempts = view.model.retries.filter(item => item.stateName === result.name);
  const statusLabel = result.waitingForCallback ? "In progress · waiting for callback" : displayLabel(result.status);
  const panels = {
    input: visit ? `${visits}${payloadBlock(visit.input, "No input was recorded for this state.")}` : notRun,
    output: visit ? `${visits}${visit.exitedAt === undefined ? '<div class="sfn-data-state absent">This state has not produced output.</div>' : payloadBlock(visit.output, "No output was recorded for this state.")}` : notRun,
    details: `<dl class="key-value"><dt>Name</dt><dd class="sfn-wrap">${escapeHtml(result.name)}</dd><dt>Type</dt><dd>${escapeHtml(result.type === "Succeed" ? "Success" : result.type)}</dd><dt>Status</dt><dd>${status(result.status, statusLabel)}</dd><dt>Scope</dt><dd>${escapeHtml(result.scopeLabel)}</dd>${result.state.Resource ? `<dt>Resource</dt><dd class="mono sfn-wrap">${escapeHtml(result.state.Resource)}</dd>` : ""}<dt>Started after</dt><dd>${formatElapsed(result.startedAfter)}</dd><dt>Duration</dt><dd>${formatElapsed(result.duration)}</dd>${result.error ? `<dt>Error</dt><dd class="sfn-wrap">${escapeHtml(result.error)}</dd>` : ""}${result.cause ? `<dt>Cause</dt><dd class="sfn-wrap">${escapeHtml(redactSensitiveValue(result.cause))}</dd>` : ""}</dl>${policies.retry}${policies.catcher}`,
    definition: `<pre class="code-box">${escapeHtml(JSON.stringify(result.state, null, 2))}</pre>`,
    retry: `${policies.retry || '<p class="muted">This state has no Retry field.</p>'}<h4>Attempts that failed <span class="muted">(${attempts.length})</span></h4>${attempts.length ? `<ul class="sfn-attempts">${attempts.map(item => `<li><button class="button link" type="button" data-event-id="${item.event.id}">#${item.event.id}</button> ${escapeHtml(formatTimestamp(item.event.timestamp))} · <strong>${escapeHtml(item.error ?? "Task failure")}</strong>${item.cause ? ` — ${escapeHtml(item.cause)}` : ""}</li>`).join("")}</ul>` : '<p class="muted">No failed attempt was recorded for this state.</p>'}`,
    events: `<h4>Related events (${result.events.length})</h4>${result.events.length ? `<div class="sfn-event-links">${result.events.map(item => `<button class="button link" type="button" data-event-id="${item.event.id}">#${item.event.id} ${escapeHtml(item.event.type)}</button>`).join("")}</div>` : '<p class="muted">No authoritative history event is linked to this state.</p>'}`,
  };
  const active = STEP_TABS.some(([key]) => key === options.stepTab) ? options.stepTab : "input";
  return `<h3>${escapeHtml(result.name)}</h3><p class="muted">${status(result.status, statusLabel)}</p><div class="tabs sfn-step-tabs" role="tablist" aria-label="Step details">${STEP_TABS.map(([key, label]) => `<button type="button" class="tab ${key === active ? "active" : ""}" role="tab" aria-selected="${key === active}" data-step-tab="${key}">${label}</button>`).join("")}</div>${STEP_TABS.map(([key]) => `<div role="tabpanel" data-step-panel="${key}" ${key === active ? "" : "hidden"}>${panels[key]}</div>`).join("")}`;
}

function nestedExecutionSummary(model) {
  const parallelStates = model.scopes[0]?.states.filter(item => item.state.Type === "Parallel") ?? [];
  const parallel = parallelStates.map(({ name, state }) => {
    const overall = model.history.events.filter(item => item.event.type.startsWith("ParallelState") && (item.stateName === name || !item.stateName));
    const outcome = overall.some(item => item.event.type === "ParallelStateFailed") ? "FAILED" : overall.some(item => item.event.type === "ParallelStateSucceeded") ? "SUCCEEDED" : model.history.active?.stateName === name ? "RUNNING" : "NOT_STARTED";
    return `<div class="sfn-nested-summary"><h4>${escapeHtml(name)} · Parallel</h4><div class="sfn-branch-grid">${(state.Branches ?? []).map((branch, index) => {
      const branchNames = new Set(Object.keys(branch.States ?? {}));
      const branchEvents = model.history.events.filter(item => branchNames.has(item.stateName));
      const branchFailed = branchEvents.some(item => item.details.error || item.event.type.endsWith("Failed"));
      const branchEnded = branchEvents.some(item => /StateExited$/.test(item.event.type) && branch.States?.[item.stateName]?.End);
      const branchStatus = outcome === "SUCCEEDED" || branchEnded ? "SUCCEEDED" : branchFailed ? "FAILED" : outcome === "FAILED" ? "CANCELLED" : outcome === "RUNNING" ? "RUNNING" : "NOT_STARTED";
      const current = branchEvents.filter(item => /StateEntered$/.test(item.event.type)).at(-1)?.stateName;
      return `<div class="sfn-branch"><strong>Branch ${index + 1}</strong>${status(branchStatus)}<small>${current ? `Last position: ${escapeHtml(current)}` : branchStatus === "RUNNING" ? "Current child position publishes when the nested state settles." : "No branch events published."}</small></div>`;
    }).join("")}</div></div>`;
  }).join("");
  const maps = (model.scopes[0]?.states.filter(item => item.state.Type === "Map") ?? []).map(({ name }) => {
    const items = model.iterations.filter(item => item.name === name);
    const active = model.history.active?.stateName === name;
    return `<div class="sfn-nested-summary"><h4>${escapeHtml(name)} · Inline Map</h4>${items.length ? `<div class="sfn-iteration-grid">${items.map(item => `<button type="button" class="sfn-iteration" data-event-id="${item.eventIds.at(-1)}"><strong>Iteration ${item.index}</strong>${status(item.status)}</button>`).join("")}</div>` : `<p class="muted">${active ? "Iterations are running; typed iteration events publish when the Inline Map state settles." : "No iteration events were emitted."}</p>`}</div>`;
  }).join("");
  return parallel || maps ? `<section class="card"><div class="card-header"><h2>Branches and iterations</h2></div><div class="card-body">${parallel}${maps}</div></section>` : "";
}

function retryAndFailures(model) {
  const retryRows = model.retries.map(item => `<tr><td><button class="button link" type="button" data-event-id="${item.event.id}">#${item.event.id}</button></td><td>${formatTimestamp(item.event.timestamp)}</td><td><button class="button link" type="button" data-state-jump="${escapeHtml(item.stateName ?? "")}">${escapeHtml(item.stateName ?? "Unlinked")}</button></td><td>${escapeHtml(item.error ?? "Task failure")}</td><td class="sfn-wrap">${escapeHtml(item.cause ?? "–")}</td></tr>`).join("");
  const failureRows = model.failures.map(item => `<li><button class="button link" type="button" data-event-id="${item.event.id}">Event #${item.event.id}</button> · ${item.stateName ? `<button class="button link" type="button" data-state-jump="${escapeHtml(item.stateName)}">${escapeHtml(item.stateName)}</button> · ` : ""}<strong>${escapeHtml(item.error ?? item.event.type)}</strong>${item.cause ? ` — ${escapeHtml(item.cause)}` : ""}</li>`).join("");
  return `${failureRows ? `<section class="card sfn-failures"><div class="card-header"><h2>Failure summary</h2></div><div class="card-body"><ul>${failureRows}</ul></div></section>` : ""}<section class="card"><div class="card-header"><h2>Retry-attempt timeline <span class="muted">(${model.retries.length})</span></h2></div>${retryRows ? `<div class="table-wrap"><table class="sfn-history"><thead><tr><th>Event</th><th>Time</th><th>State</th><th>Error</th><th>Cause</th></tr></thead><tbody>${retryRows}</tbody></table></div>` : emptyState("↻", "No retry attempts", "No typed TaskFailed retry events were recorded for this execution.")}</section>`;
}

function stateTable(view, selectedName) {
  const rows = [...view.results.values()].map(result => `<tr class="${result.name === selectedName ? "selected" : ""}"><td><button class="button link" type="button" data-state-name="${escapeHtml(result.name)}" data-state-scope="${escapeHtml(result.scopePath)}">${escapeHtml(result.name)}</button><small class="muted sfn-block">${escapeHtml(result.scopeLabel)}</small></td><td>${escapeHtml(result.type === "Succeed" ? "Success" : result.type)}</td><td>${status(result.status, result.waitingForCallback ? "In progress · waiting for callback" : displayLabel(result.status))}</td><td class="mono sfn-wrap">${escapeHtml(result.resource || "–")}</td><td>${formatElapsed(result.startedAfter)}</td><td>${formatElapsed(result.duration)}</td><td>${result.events.length}</td></tr>`).join("");
  return `<div class="table-wrap"><table class="sfn-state-table"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Resource</th><th>Started after</th><th>Duration</th><th>Events</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function stateList(view, selectedName) {
  const ran = [...view.results.values()].filter(result => result.visits.length).sort((left, right) => left.visits[0].enteredId - right.visits[0].enteredId);
  if (!ran.length) return emptyState("◇", "No states have run", "States appear here in the order they are entered.");
  return `<ol class="sfn-state-list">${ran.map(result => `<li><button type="button" class="sfn-state-item ${result.name === selectedName ? "selected" : ""}" data-state-name="${escapeHtml(result.name)}" data-state-scope="${escapeHtml(result.scopePath)}"><strong>${escapeHtml(result.name)}</strong><span>${escapeHtml(result.type === "Succeed" ? "Success" : result.type)}${result.visits.length > 1 ? ` · ${result.visits.length} visits` : ""}</span>${status(result.status)}</button></li>`).join("")}</ol>`;
}

const EXECUTION_VIEWS = [["graph", "Graph view"], ["table", "Table view"], ["events", "Event view"], ["states", "State view"]];
const SUMMARY_TABS = [["details", "Details"], ["io", "Execution input and output"], ["definition", "Definition"]];
const EVENT_PAGE_SIZE = 25;

function executionView(data) {
  const model = executionPresentation(data.snapshot.definition, data.history, data.execution.status);
  return { model, results: stateResults(model, data.execution) };
}

function executionHtml(data, view, options) {
  const { execution, snapshot } = data;
  const { model, results } = view;
  const machineArn = execution.stateMachineArn;
  const machineName = machineArn.split(":").at(-1);
  const running = execution.status === "RUNNING";
  const actions = `<span class="sfn-poll-state" role="status" aria-live="polite">${running ? "Auto-refresh active" : "Terminal execution"}</span><button class="button refresh" type="button" data-refresh aria-label="Refresh execution">↻</button><a class="button" href="${machineHref(machineArn)}/edit">Edit state machine</a><button class="button" type="button" data-start-new>Start new execution</button>${running ? '<button class="button danger" type="button" data-stop>Stop execution</button>' : ""}${actionsMenu([["", "Redrive", { disabled: true }], ["data-export-execution", "Export"]])}`;
  const failing = [...results.values()].filter(result => result.status === "FAILED").at(-1);
  const banner = execution.error || (["FAILED", "TIMED_OUT"].includes(execution.status))
    ? `<div class="alert error sfn-execution-error" role="alert"><strong>${escapeHtml(execution.error ?? displayLabel(execution.status))}</strong>${execution.cause ? `<br><span class="sfn-wrap"><b>Cause:</b> ${escapeHtml(redactSensitiveValue(execution.cause))}</span>` : ""}<div class="actions">${failing ? `<button class="button" type="button" data-state-jump="${escapeHtml(failing.name)}">View step details</button>` : ""}${unavailable("Recover")}</div></div>` : "";
  const childExecutions = model.childExecutions.length ? `<section class="card"><div class="card-header"><h2>Child executions <span class="muted">(${model.childExecutions.length})</span></h2></div><div class="card-body sfn-related">${model.childExecutions.map(item => `<a class="button" href="${executionHref(item.executionArn)}">${escapeHtml(item.executionArn.split(":").at(-1))} <span class="muted">· ${escapeHtml(item.stateName ?? `event #${item.eventId}`)}</span></a>`).join("")}</div></section>` : "";
  const summaryPanels = {
    details: `<dl class="key-value sfn-key-grid"><dt>Execution status</dt><dd>${status(execution.status)}</dd><dt>Execution type</dt><dd>Standard</dd><dt>Execution ARN</dt><dd>${copyable(execution.executionArn)}</dd><dt>State machine</dt><dd><a href="${machineHref(machineArn)}">${escapeHtml(machineName)}</a></dd><dt>IAM role ARN</dt><dd class="mono sfn-wrap">${roleMarkup(snapshot.roleArn)}</dd><dt>Start time</dt><dd>${formatTimestamp(execution.startDate)}</dd><dt>End time</dt><dd>${execution.stopDate ? formatTimestamp(execution.stopDate) : "–"}</dd><dt>Duration</dt><dd>${formatDuration(execution.startDate, execution.stopDate)}</dd><dt>State transitions</dt><dd>${stateTransitionCount(model)}</dd><dt>Definition revision</dt><dd class="mono sfn-wrap">${escapeHtml(snapshot.revisionId ?? "Not returned")}</dd>${execution.error ? `<dt>Error</dt><dd class="sfn-wrap">${escapeHtml(execution.error)}</dd>` : ""}${execution.cause ? `<dt>Cause</dt><dd class="sfn-wrap">${escapeHtml(redactSensitiveValue(execution.cause))}</dd>` : ""}</dl>`,
    io: `<div class="sfn-io"><div><h3>Input</h3>${renderPayload(execution.input, execution.inputDetails, "No input was recorded.")}</div><div><h3>Output</h3>${renderPayload(execution.output, execution.outputDetails, running ? "Output is not produced while the execution is running." : "This terminal execution produced no output.")}</div></div>`,
    definition: `<h3>Immutable definition snapshot</h3><div class="alert info"><strong>Captured revision ${escapeHtml(snapshot.revisionId ?? "unknown")}</strong><br>This definition and execution role were frozen when the execution started; later state-machine updates do not change them.</div><dl class="key-value"><dt>Snapshot time</dt><dd>${formatDate(snapshot.updateDate)}</dd></dl><pre class="code-box sfn-definition">${escapeHtml(pretty(snapshot.definition))}</pre>`,
  };
  const summaryTab = SUMMARY_TABS.some(([key]) => key === options.summaryTab) ? options.summaryTab : "details";
  const summary = `<section class="card"><div class="card-header"><h2>Execution summary</h2></div><div class="card-body"><div class="tabs" role="tablist" aria-label="Execution summary">${SUMMARY_TABS.map(([key, label]) => `<button type="button" class="tab ${key === summaryTab ? "active" : ""}" role="tab" aria-selected="${key === summaryTab}" data-summary-tab="${key}">${label}</button>`).join("")}</div>${SUMMARY_TABS.map(([key]) => `<div role="tabpanel" data-summary-panel="${key}" ${key === summaryTab ? "" : "hidden"}>${summaryPanels[key]}</div>`).join("")}</div></section>`;
  const viewSwitch = `<div class="sfn-view-switch" role="tablist" aria-label="Execution views">${EXECUTION_VIEWS.map(([key, label]) => `<button class="button ${options.view === key ? "primary" : ""}" type="button" role="tab" aria-selected="${options.view === key}" data-execution-view="${key}">${label}</button>`).join("")}</div>`;
  const eventControls = `<div class="sfn-history-controls"><div class="field"><label for="sfn-event-filter">Event filter</label><select id="sfn-event-filter">${[["all", "All events"], ["state", "State transitions"], ["task", "Task and Lambda"], ["nested", "Parallel and Map"], ["execution", "Execution lifecycle"], ["failure", "Failures"]].map(([value, label]) => `<option value="${value}" ${options.eventFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label for="sfn-event-search">Find events</label><input id="sfn-event-search" placeholder="Type, state, error, or ID" value="${escapeHtml(options.eventSearch)}"></div><div class="field"><label for="sfn-event-order">Order</label><select id="sfn-event-order"><option value="forward" ${options.eventOrder === "forward" ? "selected" : ""}>Forward</option><option value="reverse" ${options.eventOrder === "reverse" ? "selected" : ""}>Reverse</option></select></div></div>`;
  const panel = (key, content) => `<div data-view-panel="${key}" ${options.view === key ? "" : "hidden"}>${content}</div>`;
  const inspection = `<section class="card sfn-inspection"><div class="card-header"><h2>Execution inspection</h2>${viewSwitch}</div><div class="card-body" data-current-view="${options.view}">${panel("graph", `<div class="sfn-flow-host">${flowToolbarHtml({ legend: true })}${flowGraphHtml(snapshot.definition, { mode: "execution", selectedName: options.selectedState, results, zoom: options.zoom, label: "Execution graph" })}</div>`)}${panel("table", stateTable(view, options.selectedState))}${panel("events", `${eventControls}<div data-event-table></div>`)}${panel("states", stateList(view, options.selectedState))}<aside class="sfn-inspector" data-state-inspector aria-live="polite" aria-label="Step details">${stepDetails(view, options)}</aside></div></section>`;
  return `<div class="page-width sfn-detail">${pageHeader(execution.name, "Execution", actions)}${banner}${summary}${inspection}${retryAndFailures(model)}${childExecutions}${nestedExecutionSummary(model)}${lambdaLinks(snapshot.definition)}${integrationLinks(snapshot.definition)}</div>`;
}

function bindExecutionInteractions(root, data, view, options, refresh) {
  const { model, results } = view;
  bindMenus(root);
  bindFlowControls(root, { onZoom: zoom => { options.zoom = zoom; } });

  const setView = name => {
    options.view = name;
    root.querySelectorAll("[data-execution-view]").forEach(button => { button.classList.toggle("primary", button.dataset.executionView === name); button.setAttribute("aria-selected", String(button.dataset.executionView === name)); });
    root.querySelectorAll("[data-view-panel]").forEach(panel => { panel.hidden = panel.dataset.viewPanel !== name; });
    root.querySelector("[data-current-view]")?.setAttribute("data-current-view", name);
  };
  root.querySelectorAll("[data-execution-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.executionView)));
  root.querySelectorAll("[data-summary-tab]").forEach(tab => tab.addEventListener("click", () => {
    options.summaryTab = tab.dataset.summaryTab;
    root.querySelectorAll("[data-summary-tab]").forEach(item => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
    root.querySelectorAll("[data-summary-panel]").forEach(panel => { panel.hidden = panel.dataset.summaryPanel !== options.summaryTab; });
  }));

  const inspector = root.querySelector("[data-state-inspector]");
  const renderStep = () => {
    inspector.innerHTML = stepDetails(view, options);
    associateFormLabels(inspector);
    inspector.querySelectorAll("[data-step-tab]").forEach(tab => tab.addEventListener("click", () => { options.stepTab = tab.dataset.stepTab; renderStep(); }));
    inspector.querySelector("[data-step-visit]")?.addEventListener("change", event => { options.visit = Number(event.target.value); renderStep(); });
    inspector.querySelectorAll("[data-event-id]").forEach(button => button.addEventListener("click", () => selectEvent(button.dataset.eventId)));
  };
  const selectState = (name, scope) => {
    if (!results.has(name)) return;
    options.selectedState = name;
    options.selectedScope = scope;
    options.visit = undefined;
    root.querySelectorAll(".sfn-flow-node[data-state-name], .sfn-state-item").forEach(node => node.classList.toggle("selected", node.dataset.stateName === name));
    root.querySelectorAll(".sfn-state-table tr").forEach(row => row.classList.toggle("selected", row.querySelector("[data-state-name]")?.dataset.stateName === name));
    renderStep();
  };
  root.querySelectorAll("[data-view-panel] [data-state-name]").forEach(button => button.addEventListener("click", () => selectState(button.dataset.stateName, button.dataset.stateScope)));
  root.querySelectorAll("[data-state-jump]").forEach(button => button.addEventListener("click", () => {
    if (!button.dataset.stateJump) return;
    setView("graph");
    options.stepTab = "details";
    selectState(button.dataset.stateJump);
    root.querySelector(".sfn-inspection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  const tableHost = root.querySelector("[data-event-table]");
  const filter = root.querySelector("#sfn-event-filter");
  const search = root.querySelector("#sfn-event-search");
  const order = root.querySelector("#sfn-event-order");
  const startedAt = epochMilliseconds(data.execution.startDate);
  const matchesFilter = item => {
    const value = options.eventFilter;
    if (value === "state") return /State(?:Entered|Exited)$/.test(item.event.type);
    if (value === "task") return /Task|LambdaFunction|Activity/.test(item.event.type);
    if (value === "nested") return /Parallel|Map/.test(item.event.type);
    if (value === "execution") return /^Execution/.test(item.event.type);
    if (value === "failure") return Boolean(item.details.error) || /Failed|TimedOut|Aborted/.test(item.event.type);
    return true;
  };
  const filteredEvents = () => {
    const query = options.eventSearch.trim().toLowerCase();
    const items = model.history.events.filter(matchesFilter).filter(item => !query || `${item.event.id} ${item.event.type} ${item.stateName ?? ""} ${item.details.error ?? ""} ${item.details.cause ?? ""}`.toLowerCase().includes(query));
    return options.eventOrder === "reverse" ? [...items].reverse() : items;
  };
  const renderEvents = () => {
    const items = filteredEvents();
    const pages = Math.max(1, Math.ceil(items.length / EVENT_PAGE_SIZE));
    options.eventPage = Math.min(options.eventPage, pages - 1);
    const visible = items.slice(options.eventPage * EVENT_PAGE_SIZE, options.eventPage * EVENT_PAGE_SIZE + EVENT_PAGE_SIZE);
    const arrow = options.eventOrder === "reverse" ? "▼" : "▲";
    tableHost.innerHTML = `${visible.length ? `<div class="table-wrap"><table class="sfn-history sfn-events"><thead><tr><th>ID</th><th>Type</th><th>Step</th><th>Resource</th><th>Started after</th><th><button class="button link" type="button" data-event-sort aria-label="Sort by timestamp">Timestamp ${arrow}</button></th><th>Previous</th></tr></thead><tbody>${visible.map(item => {
      const open = options.expandedEvents.has(item.event.id);
      const after = startedAt === undefined ? "–" : formatElapsed(epochMilliseconds(item.event.timestamp) - startedAt);
      return `<tr id="sfn-event-${item.event.id}" class="${open ? "expanded" : ""}"><td>${item.event.id}</td><td><button class="button link" type="button" data-select-event="${item.event.id}" aria-expanded="${open}">${escapeHtml(item.event.type)}</button></td><td>${escapeHtml(item.stateName ?? item.details.error ?? "–")}</td><td class="mono sfn-wrap">${escapeHtml(item.details.resource ?? "–")}</td><td>${after}</td><td>${formatTimestamp(item.event.timestamp)}</td><td>${item.event.previousEventId || "–"}</td></tr>${open ? `<tr class="sfn-event-detail"><td colspan="7"><div class="sfn-event-inspector">${eventInspector(item)}</div></td></tr>` : ""}`;
    }).join("")}</tbody></table></div>` : emptyState("◇", "No matching events", "Change the event filter or search text.")}<nav class="pagination sfn-event-pagination" aria-label="Event pages"><button class="button" type="button" data-event-page="previous" ${options.eventPage === 0 ? "disabled" : ""}>Previous</button><span>Page ${options.eventPage + 1} of ${pages} · ${items.length} events</span><button class="button" type="button" data-event-page="next" ${options.eventPage + 1 >= pages ? "disabled" : ""}>Next</button></nav>`;
    tableHost.querySelectorAll("[data-select-event]").forEach(button => button.addEventListener("click", () => {
      const id = Number(button.dataset.selectEvent);
      if (options.expandedEvents.has(id)) options.expandedEvents.delete(id); else options.expandedEvents.add(id);
      renderEvents();
    }));
    tableHost.querySelector("[data-event-sort]")?.addEventListener("click", () => { options.eventOrder = options.eventOrder === "reverse" ? "forward" : "reverse"; order.value = options.eventOrder; options.eventPage = 0; renderEvents(); });
    tableHost.querySelector('[data-event-page="previous"]')?.addEventListener("click", () => { options.eventPage--; renderEvents(); });
    tableHost.querySelector('[data-event-page="next"]')?.addEventListener("click", () => { options.eventPage++; renderEvents(); });
  };
  function selectEvent(id) {
    const eventId = Number(id);
    if (!model.history.events.some(item => item.event.id === eventId)) return;
    setView("events");
    options.expandedEvents.add(eventId);
    let index = filteredEvents().findIndex(item => item.event.id === eventId);
    if (index < 0) { options.eventFilter = "all"; options.eventSearch = ""; filter.value = "all"; search.value = ""; index = filteredEvents().findIndex(item => item.event.id === eventId); }
    options.eventPage = Math.max(0, Math.floor(index / EVENT_PAGE_SIZE));
    renderEvents();
    root.querySelector(`#sfn-event-${eventId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  filter.addEventListener("change", () => { options.eventFilter = filter.value; options.eventPage = 0; renderEvents(); });
  search.addEventListener("input", () => { options.eventSearch = search.value; options.eventPage = 0; renderEvents(); });
  order.addEventListener("change", () => { options.eventOrder = order.value; options.eventPage = 0; renderEvents(); });
  renderEvents();
  renderStep();
  root.querySelectorAll(".card [data-event-id]").forEach(button => { if (!inspector.contains(button)) button.addEventListener("click", () => selectEvent(button.dataset.eventId)); });

  root.querySelector("[data-refresh]")?.addEventListener("click", () => refresh(true).catch(context.showError));
  root.querySelector("[data-stop]")?.addEventListener("click", () => openStopExecution(data.execution, () => refresh(true)));
  root.querySelector("[data-start-new]")?.addEventListener("click", () => openStartExecution({ stateMachineArn: data.execution.stateMachineArn }, { input: typeof data.execution.input === "string" ? pretty(data.execution.input) : undefined }));
  root.querySelector("[data-export-execution]")?.addEventListener("click", () => download(`${data.execution.name}.execution.json`, JSON.stringify({ execution: data.execution, stateMachine: { definition: parseStateMachineDefinition(data.snapshot.definition), roleArn: data.snapshot.roleArn, revisionId: data.snapshot.revisionId }, events: data.history.map(event => redactSensitiveValue(event)) }, null, 2)));
}

async function executionPage(arn) {
  let disposed = false;
  let timer;
  let polls = 0;
  let signature;
  const options = { view: "graph", selectedState: null, selectedScope: null, stepTab: "input", summaryTab: "details", visit: undefined, zoom: 1, eventFilter: "all", eventSearch: "", eventOrder: "forward", eventPage: 0, expandedEvents: new Set() };
  const cleanup = () => { disposed = true; if (timer) clearTimeout(timer); };
  activeViewCleanup = cleanup;
  window.addEventListener("hashchange", cleanup, { once: true });
  const load = async () => {
    const [execution, history, snapshot] = await Promise.all([states("DescribeExecution", { executionArn: arn }), completeHistory(arn, true), states("DescribeStateMachineForExecution", { executionArn: arn })]);
    return { execution, history, snapshot };
  };
  // Polls quickly at first, then backs off; it keeps going for as long as the execution runs.
  const delay = () => polls < 40 ? 1500 : polls < 100 ? 5000 : 15000;
  const schedule = () => {
    timer = setTimeout(async () => {
      if (disposed) return;
      polls++;
      try { render(await load()); }
      catch (error) { if (!disposed) { context.showError(error); schedule(); } }
    }, delay());
  };
  const render = (data, force = false) => {
    if (disposed) return;
    const next = `${data.execution.status}:${data.execution.stopDate ?? ""}:${data.history.length}`;
    if (force || next !== signature) {
      signature = next;
      const machineArn = data.execution.stateMachineArn;
      context.setChrome("step-functions", ["Step Functions", { label: "State machines", href: LIST_HREF }, { label: machineArn.split(":").at(-1), href: machineHref(machineArn) }, data.execution.name]);
      const view = executionView(data);
      if (!options.selectedState || !view.results.has(options.selectedState)) {
        options.selectedState = view.model.history.active?.stateName ?? [...view.results.values()].filter(result => result.status === "FAILED").at(-1)?.name ?? view.model.scopes[0]?.startAt ?? null;
      }
      context.main.innerHTML = executionHtml(data, view, options);
      decorateStepFunctionsPanelHelp(context.main);
      bindExecutionInteractions(context.main, data, view, options, refresh);
    }
    if (data.execution.status === "RUNNING") schedule();
  };
  const refresh = async manual => {
    if (timer) clearTimeout(timer);
    if (manual) polls = 0;
    render(await load(), true);
  };
  render(await load(), true);
}

export async function routeStepFunctions(parts, suppliedContext) {
  activeViewCleanup();
  activeViewCleanup = () => undefined;
  context = suppliedContext;
  const render = async pending => {
    const result = await pending;
    decorateStepFunctionsPanelHelp(context.main);
    return result;
  };
  if (!parts[1] || (parts[1] === "state-machines" && !parts[2])) return render(listPage());
  if (parts[1] === "state-machines" && parts[2] === "create") return render(createPage(parts[3]));
  if (parts[1] === "state-machines" && parts[3] === "edit") return render(editPage(parts[2]));
  if (parts[1] === "state-machines" && parts[3] === "executions" && parts[4]) return render(executionPage(parts[4]));
  if (parts[1] === "state-machines") return render(machinePage(parts[2], parts[3] ?? "executions"));
  if (parts[1] === "executions" && parts[2]) return render(executionPage(parts[2]));
  if (parts[1] === "executions") return render(executionsPage());
  if (parts[1] === "activities" && parts[2]) return render(activityPage(parts[2]));
  if (parts[1] === "activities") return render(activitiesPage());
  return context.notFound(parts);
}
