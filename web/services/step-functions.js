import { states } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader, tabs } from "../components.js";
import { setDirty } from "../state.js";
import { decorateStepFunctionsPanelHelp } from "./step-functions-help.js";
import { definitionScopes, eventDetails, executionPresentation, integrationReferences, lambdaReferences, parseStateMachineDefinition, payloadField, redactSensitiveValue } from "./step-functions-model.js";
import { bindStudioEditor, studioEditorMarkup, syncStudioBeforeSubmit } from "./step-functions-studio.js";

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
const machineHref = arn => `#/step-functions/state-machines/${encoded(arn)}`;
const executionHref = arn => `#/step-functions/executions/${encoded(arn)}`;
const lambdaHref = name => `#/lambda/functions/${encoded(name)}`;
const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]);

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

function status(value) {
  const variant = ["FAILED", "TIMED_OUT", "ABORTED", "CANCELLED"].includes(value) ? "error" : ["RUNNING", "PLANNED"].includes(value) ? "pending" : value === "SUCCEEDED" || value === "ACTIVE" ? "success" : "";
  return `<span class="status ${variant}" role="status">${escapeHtml(value ?? "UNKNOWN")}</span>`;
}

function machineTabs(arn, active) {
  return tabs([
    { label: "Overview", href: machineHref(arn), active: active === "overview" },
    { label: "Definition", href: `${machineHref(arn)}/definition`, active: active === "definition" },
    { label: "Executions", href: `${machineHref(arn)}/executions`, active: active === "executions" },
    { label: "Tags", href: `${machineHref(arn)}/tags`, active: active === "tags" },
  ]);
}

function pretty(value) {
  if (value === undefined) return "";
  try { return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2); }
  catch { return String(value); }
}

function formatDuration(start, stop = Date.now()) {
  if (!start) return "–";
  const milliseconds = Math.max(0, new Date(stop).getTime() - new Date(start).getTime());
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} sec`;
  return `${Math.floor(milliseconds / 60_000)} min ${Math.floor(milliseconds % 60_000 / 1000)} sec`;
}

function validationHtml(result) {
  if (result.result === "OK") return '<div class="alert success"><strong>Definition is valid.</strong><br>No validation diagnostics were returned.</div>';
  const diagnostics = result.diagnostics ?? [];
  return `<div class="alert error" role="alert"><strong>Definition has ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}${result.truncated ? " (results truncated)" : ""}.</strong><ul>${diagnostics.map(item => `<li><span class="mono">${escapeHtml(item.location ?? "$")}</span> · ${escapeHtml(item.severity ?? "ERROR")} · ${escapeHtml(item.message)}</li>`).join("")}</ul></div>`;
}

function stateConfiguration(state) {
  const retry = state.Retry?.length ? `<div><strong>Retry</strong>${state.Retry.map((item, index) => `<div class="sfn-policy"><span>Policy ${index + 1}: ${escapeHtml((item.ErrorEquals ?? []).join(", "))}</span><small>${escapeHtml(`${item.IntervalSeconds ?? 1}s · ×${item.BackoffRate ?? 2} · ${item.MaxAttempts ?? 3} attempts${item.MaxDelaySeconds ? ` · max ${item.MaxDelaySeconds}s` : ""}${item.JitterStrategy ? ` · ${item.JitterStrategy} jitter` : ""}`)}</small></div>`).join("")}</div>` : "";
  const catcher = state.Catch?.length ? `<div><strong>Catch</strong>${state.Catch.map(item => `<div class="sfn-policy"><span>${escapeHtml((item.ErrorEquals ?? []).join(", "))}</span><small>Next: ${escapeHtml(item.Next)}</small></div>`).join("")}</div>` : "";
  return `${retry}${catcher}`;
}

function definitionGraph(definition, { activeName, activeLabel, selectedName, selectable = false } = {}) {
  const scopes = definitionScopes(definition);
  if (!scopes.length) return '<div class="alert error" role="alert">The definition could not be parsed for graph display.</div>';
  return `<div class="sfn-nested-graphs">${scopes.map(scope => `<section class="sfn-graph-scope" aria-label="${escapeHtml(scope.label)}"><div class="sfn-scope-header"><h3>${escapeHtml(scope.label)}</h3><span class="muted">Starts at ${escapeHtml(scope.startAt ?? "–")}</span></div><div class="sfn-graph">${scope.states.map(({ name, state }) => {
    const content = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(state.Type)}</span>${name === activeName && activeLabel ? `<small>${escapeHtml(activeLabel)}</small>` : ""}<small>${escapeHtml(state.Next ?? (state.End || ["Succeed", "Fail"].includes(state.Type) ? "End" : state.Default ?? ""))}</small>${state.Resource ? `<small class="mono sfn-wrap">${escapeHtml(state.Resource)}</small>` : ""}${state.Retry?.length ? `<small>${state.Retry.length} retry polic${state.Retry.length === 1 ? "y" : "ies"}</small>` : ""}${state.Catch?.length ? `<small>${state.Catch.length} catcher${state.Catch.length === 1 ? "" : "s"}</small>` : ""}`;
    const classes = `sfn-node ${name === activeName ? "active" : ""} ${name === selectedName ? "selected" : ""}`;
    return selectable ? `<button type="button" class="${classes}" data-state-name="${escapeHtml(name)}" data-state-scope="${escapeHtml(scope.path)}" aria-label="Inspect ${escapeHtml(name)} state">${content}</button>` : `<div class="${classes}">${content}</div>`;
  }).join("")}</div></section>`).join("")}</div>`;
}

function lambdaLinks(definition) {
  const references = lambdaReferences(definition);
  if (!references.length) return "";
  return `<section class="card"><div class="card-header"><h2>Related Lambda functions <span class="muted">(${references.length})</span></h2></div><div class="card-body sfn-related">${references.map(item => `<a class="button" href="${lambdaHref(item.name)}">${escapeHtml(item.name)} <span class="muted">· ${escapeHtml(item.stateName)}</span></a>`).join("")}</div></section>`;
}

function integrationLinks(definition) {
  const references = integrationReferences(definition);
  if (!references.length) return "";
  return `<section class="card"><div class="card-header"><h2>Related service integrations <span class="muted">(${references.length})</span></h2></div><div class="card-body sfn-related">${references.map(item => `<a class="button" href="${item.href}">${escapeHtml(item.service)} <span class="muted">· ${escapeHtml(item.stateName)}${item.callback ? " · callback wait" : item.sync ? " · run a job" : ""}</span></a>`).join("")}</div></section>`;
}

function unsupportedBoundary() {
  return '<section class="card"><div class="card-header"><h2>Unavailable settings</h2></div><div class="card-body"><p class="muted">This console supports Standard JSONPath workflows, local visual definition authoring with JSON round-trip, common optimized integrations, callbacks, nested workflows, and Activities. Full AWS Workflow Studio parity, code generation, active logging, X-Ray tracing, customer-managed encryption, publishing, versions, aliases, Express workflows, Distributed Map, redrive, AWS SDK integrations, HTTP tasks, and unlisted integration patterns remain unavailable.</p></div></section>';
}

async function activitiesPage() {
  const values = await all("ListActivities", "activities"); context.setChrome("step-functions", ["Step Functions", "Activities"]);
  const rows = values.map(activity => `<tr><td>${escapeHtml(activity.name)}</td><td class="mono sfn-wrap">${escapeHtml(activity.activityArn)}</td><td>${formatDate(activity.creationDate)}</td><td><button class="button danger" type="button" data-delete-activity="${escapeHtml(activity.activityArn)}" data-name="${escapeHtml(activity.name)}">Delete</button></td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("Activities", "Durable worker tasks with opaque task tokens and restart-safe completion.", '<button class="button refresh" type="button" data-refresh>↻</button><button class="button primary" type="button" data-create-activity>Create activity</button>')}<div class="alert info"><strong>Lease-safe view</strong><br>Worker names and raw task tokens are never displayed. Waiting, heartbeat, timeout, and completion transitions remain visible on their execution histories.</div><section class="card"><div class="card-header"><h2>Activity catalog <span class="muted">(${values.length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>ARN</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("A", "No activities", "Create an Activity for a long-polling worker.")}</section>${unsupportedBoundary()}</div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
  context.main.querySelector("[data-create-activity]")?.addEventListener("click", () => context.showModal("Create activity", '<div class="field"><label>Name</label><input name="name" required maxlength="80"></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><p class="muted">AWS-owned local encryption is used. Customer-managed KMS keys remain unavailable.</p>', "Create activity", async data => { const tagMap = JSON.parse(String(data.get("tags") || "{}")); await states("CreateActivity", { name: String(data.get("name")), tags: Object.entries(tagMap).map(([key, value]) => ({ key, value: String(value) })) }); context.toast("Activity created"); await context.route(); }));
  context.main.querySelectorAll("[data-delete-activity]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.name, `Delete activity ${button.dataset.name}? Already issued task tokens remain bound to their executions.`, async () => { await states("DeleteActivity", { activityArn: button.dataset.deleteActivity }); context.toast("Activity deleted"); await context.route(); })));
}

async function listPage() {
  const values = await machines();
  context.setChrome("step-functions", ["Step Functions", "State machines"]);
  const rows = values.map(machine => `<tr data-search-row="${escapeHtml(`${machine.name} ${machine.stateMachineArn}`.toLowerCase())}"><td><a href="${machineHref(machine.stateMachineArn)}">${escapeHtml(machine.name)}</a></td><td>${escapeHtml(machine.type)}</td><td class="mono sfn-wrap">${escapeHtml(machine.stateMachineArn)}</td><td>${formatDate(machine.creationDate)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("State machines", "Durable Standard Workflows in the selected account and Region.", '<button class="button refresh" type="button" data-refresh aria-label="Refresh state machines">↻</button><a class="button primary" href="#/step-functions/state-machines/create">Create state machine</a>')}<section class="card"><div class="card-header"><h2>State machine catalog <span class="muted">(${values.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find state machines"></label></div>${rows ? `<div class="table-wrap"><table class="sfn-table"><thead><tr><th>Name</th><th>Type</th><th>ARN</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("S", "No state machines", "Create a JSONPath Standard Workflow.", '<a class="button primary" href="#/step-functions/state-machines/create">Create state machine</a>')}</section></div>`;
  context.bindTableFilter(context.main);
  context.main.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
}

function bindDefinitionForm(form, submit) {
  const validate = async () => {
    syncStudioBeforeSubmit(form);
    const region = form.querySelector(".sfn-validation");
    const definition = String(form.elements.definition.value || "").trim();
    if (!definition) {
      region.innerHTML = '<div class="alert error" role="alert"><strong>Definition is required.</strong><br>Add states in the visual editor or paste States Language JSON.</div>';
      return false;
    }
    region.innerHTML = '<span class="loading-inline">Validating definition…</span>';
    const result = await states("ValidateStateMachineDefinition", { definition, type: "STANDARD" });
    region.innerHTML = validationHtml(result);
    return result.result === "OK";
  };
  form.querySelector("[data-validate]").addEventListener("click", async () => { try { await validate(); } catch (error) { context.showError(error); } });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      syncStudioBeforeSubmit(form);
      if (!await validate()) return;
      await submit(new FormData(form));
      setDirty(false, "all");
    } catch (error) { context.showError(error); }
    finally { button.disabled = false; }
  });
}

async function createPage() {
  context.setChrome("step-functions", ["Step Functions", "State machines", "Create"]);
  const sample = JSON.stringify({ Comment: "A local Standard Workflow", StartAt: "Hello", States: { Hello: { Type: "Pass", Result: { message: "hello" }, End: true } } }, null, 2);
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("Create state machine", "Author a JSONPath Standard Workflow visually or as States Language JSON.")}<section class="card"><div class="card-header"><h2>Workflow configuration</h2></div><div class="card-body"><form id="sfn-create"><div class="field-row"><div class="field"><label>Name</label><input name="name" data-dirty-track required pattern="[A-Za-z0-9_-]+" maxlength="80"></div><div class="field"><label>Type</label><input value="STANDARD" disabled></div></div><div class="field"><label>Execution role ARN</label><input name="roleArn" data-dirty-track required placeholder="arn:aws:iam::000000000000:role/workflow-role"><span class="hint">The role must trust states.amazonaws.com. IAM enforcement also requires iam:PassRole.</span></div><div class="field"><span class="label-text">Definition</span>${studioEditorMarkup(sample)}</div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><div class="sfn-validation" role="status" aria-live="polite"></div><div class="actions"><a class="button" href="#/step-functions/state-machines">Cancel</a><button class="button" type="button" data-validate>Validate</button><button class="button primary" type="submit">Create state machine</button></div></form></div></section>${unsupportedBoundary()}</div>`;
  const form = context.main.querySelector("#sfn-create");
  bindStudioEditor(form);
  bindDefinitionForm(form, async data => {
    const tagMap = JSON.parse(String(data.get("tags") || "{}"));
    const created = await states("CreateStateMachine", { name: String(data.get("name")), definition: String(data.get("definition")), roleArn: String(data.get("roleArn")), type: "STANDARD", tags: Object.entries(tagMap).map(([key, value]) => ({ key, value: String(value) })) });
    context.toast("State machine created");
    location.hash = machineHref(created.stateMachineArn);
  });
}

async function editPage(arn) {
  const machine = await states("DescribeStateMachine", { stateMachineArn: arn });
  context.setChrome("step-functions", ["Step Functions", "State machines", machine.name, "Edit"]);
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader(`Edit ${machine.name}`, "Update the visual definition, JSON, or execution role through UpdateStateMachine.")}<div class="alert info" role="status"><strong>Executions keep immutable snapshots.</strong><br>Existing executions continue with the definition, role, and revision captured when they started. This update applies only to new executions.</div><section class="card"><div class="card-header"><h2>Definition and role</h2></div><div class="card-body"><form id="sfn-edit"><div class="field"><label>Execution role ARN</label><input name="roleArn" data-dirty-track required value="${escapeHtml(machine.roleArn)}"><span class="hint">The role must trust states.amazonaws.com.</span></div><div class="field"><span class="label-text">Definition</span>${studioEditorMarkup(pretty(machine.definition))}</div><div class="sfn-validation" role="status" aria-live="polite"></div><div class="actions"><a class="button" href="${machineHref(arn)}">Cancel</a><button class="button" type="button" data-validate>Validate without saving</button><button class="button primary" type="submit">Save changes</button></div></form></div></section>${unsupportedBoundary()}</div>`;
  const form = context.main.querySelector("#sfn-edit");
  bindStudioEditor(form);
  bindDefinitionForm(form, async data => {
    const result = await states("UpdateStateMachine", { stateMachineArn: arn, definition: String(data.get("definition")), roleArn: String(data.get("roleArn")) });
    sessionStorage.setItem(`sfn-update:${arn}`, JSON.stringify({ updateDate: result.updateDate, revisionId: result.revisionId }));
    context.toast("State machine updated; existing execution snapshots are unchanged");
    location.hash = machineHref(arn);
  });
}

function executionTable(values, refresh = false) {
  const rows = values.map(item => `<tr><td><a href="${executionHref(item.executionArn)}">${escapeHtml(item.name)}</a></td><td>${status(item.status)}</td><td>${formatDate(item.startDate)}</td><td>${item.stopDate ? formatDate(item.stopDate) : "–"}</td><td>${formatDuration(item.startDate, item.stopDate)}</td></tr>`).join("");
  return `<section class="card"><div class="card-header"><h2>Executions <span class="muted">(${values.length})</span></h2>${refresh ? '<button class="button refresh" type="button" data-refresh aria-label="Refresh executions">↻</button>' : ""}</div>${rows ? `<div class="table-wrap"><table class="sfn-executions"><thead><tr><th>Name</th><th>Status</th><th>Started</th><th>Stopped</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("▷", "No executions", "Start an execution to inspect state transitions and history.")}</section>`;
}

function tagsBody(tags) {
  const rows = tags.map(tag => `<tr><td>${escapeHtml(tag.key)}</td><td class="sfn-wrap">${escapeHtml(tag.value)}</td></tr>`).join("");
  return `<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${tags.length})</span></h2><button class="button" type="button" data-edit-tags>Edit tags</button></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("#", "No tags", "Add tags to organize this state machine.", '<button class="button" type="button" data-edit-tags>Add tags</button>')}</section>`;
}

async function machinePage(arn, section = "overview") {
  const [machine, executionList, tagResult] = await Promise.all([states("DescribeStateMachine", { stateMachineArn: arn }), executions(arn), states("ListTagsForResource", { resourceArn: arn })]);
  const tags = tagResult.tags ?? [];
  context.setChrome("step-functions", ["Step Functions", "State machines", machine.name]);
  const actions = `<button class="button refresh" type="button" data-refresh aria-label="Refresh state machine">↻</button><a class="button" href="${machineHref(arn)}/edit">Edit</a><button class="button primary" type="button" data-start>Start execution</button><button class="button danger" type="button" data-delete>Delete</button>`;
  let body;
  if (section === "definition") body = `<section class="card"><div class="card-header"><h2>Definition</h2><a class="button" href="${machineHref(arn)}/edit">Edit definition</a></div><div class="card-body"><div class="alert info"><strong>Read-only graph</strong><br>This view inspects the saved definition. Use Edit definition for the local visual editor or JSON authoring.</div>${definitionGraph(machine.definition)}<details class="sfn-details"><summary>States Language JSON</summary><pre class="code-box sfn-definition">${escapeHtml(pretty(machine.definition))}</pre></details></div></section>${lambdaLinks(machine.definition)}${integrationLinks(machine.definition)}`;
  else if (section === "executions") body = executionTable(executionList, true);
  else if (section === "tags") body = tagsBody(tags);
  else {
    let latestUpdate;
    try { latestUpdate = JSON.parse(sessionStorage.getItem(`sfn-update:${arn}`) || "null"); } catch { latestUpdate = null; }
    body = `<div class="sfn-summary"><section class="card"><div class="card-header"><h2>Details</h2></div><div class="card-body"><dl class="key-value"><dt>Status</dt><dd>${status(machine.status)}</dd><dt>Type</dt><dd>${escapeHtml(machine.type)}</dd><dt>Created</dt><dd>${formatDate(machine.creationDate)}</dd><dt>Latest update</dt><dd>${latestUpdate?.revisionId === machine.revisionId ? formatDate(latestUpdate.updateDate) : "Not exposed by DescribeStateMachine"}</dd><dt>Revision</dt><dd class="mono sfn-wrap">${escapeHtml(machine.revisionId)}</dd><dt>Execution role</dt><dd class="mono sfn-wrap">${escapeHtml(machine.roleArn)}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Executions</h2></div><div class="card-body"><div class="metric">${executionList.length}</div><p class="muted">${executionList.filter(item => item.status === "RUNNING").length} running · ${executionList.filter(item => terminalStatuses.has(item.status)).length} terminal</p><a href="${machineHref(arn)}/executions">View executions</a></div></section></div><section class="card"><div class="card-header"><h2>Workflow graph</h2></div><div class="card-body">${definitionGraph(machine.definition)}</div></section>${lambdaLinks(machine.definition)}${integrationLinks(machine.definition)}${unsupportedBoundary()}`;
  }
  context.main.innerHTML = `<div class="page-width sfn-detail">${pageHeader(machine.name, escapeHtml(machine.stateMachineArn), actions)}${machineTabs(arn, section)}${body}</div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
  context.main.querySelector("[data-start]")?.addEventListener("click", () => context.showModal("Start execution", '<div class="field"><label>Name (optional)</label><input name="name" maxlength="80"></div><div class="field"><label>Input JSON</label><textarea name="input" class="code-editor">{}</textarea><span class="hint">Input is captured immutably with the current definition revision.</span></div>', "Start execution", async data => {
    const input = String(data.get("input") || "{}");
    JSON.parse(input);
    const result = await states("StartExecution", { stateMachineArn: arn, name: String(data.get("name") || "") || undefined, input });
    context.toast("Execution started");
    location.hash = executionHref(result.executionArn);
  }));
  context.main.querySelector("[data-delete]")?.addEventListener("click", () => context.confirmDeletion(machine.name, `Delete state machine ${machine.name}? Existing executions retain their immutable definition snapshots and histories and remain accessible by execution ARN.`, async () => {
    await states("DeleteStateMachine", { stateMachineArn: arn });
    context.toast("State machine deleted; retained executions were not removed");
    location.hash = "#/step-functions/state-machines";
  }));
  const editTags = () => {
    const current = Object.fromEntries(tags.map(tag => [tag.key, tag.value]));
    context.showModal("Edit tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags" class="code-editor">${escapeHtml(JSON.stringify(current, null, 2))}</textarea><span class="hint">Saving adds or updates keys with TagResource and removes deleted keys with UntagResource.</span></div>`, "Save tags", async data => {
      const next = JSON.parse(String(data.get("tags") || "{}"));
      if (!next || Array.isArray(next) || typeof next !== "object") throw new Error("Tags must be a JSON object.");
      const removed = Object.keys(current).filter(key => !Object.hasOwn(next, key));
      const changed = Object.entries(next).filter(([key, value]) => current[key] !== String(value)).map(([key, value]) => ({ key, value: String(value) }));
      if (changed.length) await states("TagResource", { resourceArn: arn, tags: changed });
      if (removed.length) await states("UntagResource", { resourceArn: arn, tagKeys: removed });
      context.toast("Tags updated");
    });
  };
  context.main.querySelectorAll("[data-edit-tags]").forEach(button => button.addEventListener("click", editTags));
}

async function executionsPage() {
  const machineList = await machines();
  const values = (await Promise.all(machineList.map(machine => executions(machine.stateMachineArn)))).flat().sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
  context.setChrome("step-functions", ["Step Functions", "Executions"]);
  context.main.innerHTML = `<div class="page-width sfn-page">${pageHeader("Executions", "Standard Workflow executions across current state machines.", '<button class="button refresh" type="button" data-refresh aria-label="Refresh executions">↻</button>')}${executionTable(values)}</div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", () => context.route());
}

function renderPayload(value, details, absentLabel) {
  if (value !== undefined) return `<pre class="code-box">${escapeHtml(pretty(value))}</pre>`;
  if (details?.included === false) return '<div class="sfn-data-state omitted">Execution data was omitted by the API request.</div>';
  return `<div class="sfn-data-state absent">${escapeHtml(absentLabel)}</div>`;
}

function eventInspector(item) {
  if (!item) return '<div class="empty compact"><h3>Select an event</h3><p>Choose an event to inspect its typed details and linkage.</p></div>';
  const details = redactSensitiveValue(item.details);
  const fields = [["Event ID", item.event.id], ["Type", item.event.type], ["Timestamp", formatDate(item.event.timestamp)], ["Previous event", item.event.previousEventId || "None"], ["State", item.stateName ?? details.name ?? "Not linked"], ["Resource", details.resource ?? "Absent"], ["Error", details.error ?? "Absent"], ["Cause", details.cause ?? "Absent"], ["Index", details.index ?? "Absent"]];
  const payloads = ["input", "output", "parameters"].map(name => {
    const field = payloadField(details, name);
    if (field.state === "absent") return `<div><h4>${escapeHtml(name)}</h4><div class="sfn-data-state absent">No ${escapeHtml(name)} field exists on this event.</div></div>`;
    if (field.state === "omitted") return `<div><h4>${escapeHtml(name)}</h4><div class="sfn-data-state omitted">${escapeHtml(name)} was omitted by the history request.</div></div>`;
    return `<div><h4>${escapeHtml(name)}</h4><pre class="code-box">${escapeHtml(pretty(field.value))}</pre></div>`;
  }).join("");
  return `<h3>Event ${item.event.id}</h3><dl class="key-value">${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd class="sfn-wrap">${escapeHtml(value)}</dd>`).join("")}</dl>${payloads}<details class="sfn-details"><summary>All typed details</summary><pre class="code-box">${escapeHtml(JSON.stringify(details, null, 2))}</pre></details>`;
}

function stateInspector(definition, model, stateName, scopePath) {
  const scope = model.scopes.find(item => item.path === scopePath && item.states.some(state => state.name === stateName)) ?? model.scopes.find(item => item.states.some(state => state.name === stateName));
  const selected = scope?.states.find(item => item.name === stateName);
  if (!selected) return '<div class="empty compact"><h3>Select a state</h3><p>Choose a graph node or state row to inspect configuration and history.</p></div>';
  const related = model.history.events.filter(item => item.stateName === stateName);
  return `<h3>${escapeHtml(stateName)}</h3><p class="muted">${escapeHtml(scope.label)} · ${escapeHtml(selected.state.Type)}</p>${stateConfiguration(selected.state)}<h4>Configuration</h4><pre class="code-box">${escapeHtml(JSON.stringify(selected.state, null, 2))}</pre><h4>Related events (${related.length})</h4>${related.length ? `<div class="sfn-event-links">${related.map(item => `<button class="button link" type="button" data-event-id="${item.event.id}">#${item.event.id} ${escapeHtml(item.event.type)}</button>`).join("")}</div>` : '<p class="muted">No authoritative history event is linked to this state.</p>'}`;
}

function nestedExecutionSummary(definition, model) {
  const parallelStates = model.scopes[0]?.states.filter(item => item.state.Type === "Parallel") ?? [];
  const parallel = parallelStates.map(({ name, state }) => {
    const overall = model.history.events.filter(item => item.event.type.startsWith("ParallelState") && (item.stateName === name || !item.stateName));
    const outcome = overall.some(item => item.event.type === "ParallelStateFailed") ? "FAILED" : overall.some(item => item.event.type === "ParallelStateSucceeded") ? "SUCCEEDED" : model.history.active?.stateName === name ? "RUNNING" : "NOT STARTED";
    return `<div class="sfn-nested-summary"><h4>${escapeHtml(name)} · Parallel</h4><div class="sfn-branch-grid">${(state.Branches ?? []).map((branch, index) => {
      const branchNames = new Set(Object.keys(branch.States ?? {}));
      const branchEvents = model.history.events.filter(item => branchNames.has(item.stateName));
      const branchFailed = branchEvents.some(item => item.details.error || item.event.type.endsWith("Failed"));
      const branchEnded = branchEvents.some(item => /StateExited$/.test(item.event.type) && branch.States?.[item.stateName]?.End);
      const branchStatus = outcome === "SUCCEEDED" || branchEnded ? "SUCCEEDED" : branchFailed ? "FAILED" : outcome === "FAILED" ? "CANCELLED" : outcome === "RUNNING" ? "RUNNING" : "NOT STARTED";
      const current = branchEvents.filter(item => /StateEntered$/.test(item.event.type)).at(-1)?.stateName;
      return `<div class="sfn-branch"><strong>Branch ${index + 1}</strong>${status(branchStatus)}<small>${current ? `Last position: ${escapeHtml(current)}` : branchStatus === "RUNNING" ? "Current child position publishes when the nested state settles." : "No branch events published."}</small></div>`;
    }).join("")}</div></div>`;
  }).join("");
  const maps = (model.scopes[0]?.states.filter(item => item.state.Type === "Map") ?? []).map(({ name }) => {
    const items = model.iterations.filter(item => item.name === name);
    const active = model.history.active?.stateName === name;
    return `<div class="sfn-nested-summary"><h4>${escapeHtml(name)} · Inline Map</h4>${items.length ? `<div class="sfn-iteration-grid">${items.map(item => `<a class="sfn-iteration" href="#sfn-event-${item.eventIds.at(-1)}"><strong>Iteration ${item.index}</strong>${status(item.status)}</a>`).join("")}</div>` : `<p class="muted">${active ? "Iterations are running; typed iteration events publish when the Inline Map state settles." : "No iteration events were emitted."}</p>`}</div>`;
  }).join("");
  return parallel || maps ? `<section class="card"><div class="card-header"><h2>Branches and iterations</h2></div><div class="card-body">${parallel}${maps}</div></section>` : "";
}

function retryAndFailures(model) {
  const retryRows = model.retries.map(item => `<tr><td><a href="#sfn-event-${item.event.id}">#${item.event.id}</a></td><td>${formatDate(item.event.timestamp)}</td><td><button class="button link" type="button" data-state-jump="${escapeHtml(item.stateName ?? "")}">${escapeHtml(item.stateName ?? "Unlinked")}</button></td><td>${escapeHtml(item.error ?? "Task failure")}</td><td class="sfn-wrap">${escapeHtml(item.cause ?? "–")}</td></tr>`).join("");
  const failureRows = model.failures.map(item => `<li><a href="#sfn-event-${item.event.id}">Event #${item.event.id}</a> · ${item.stateName ? `<button class="button link" type="button" data-state-jump="${escapeHtml(item.stateName)}">${escapeHtml(item.stateName)}</button> · ` : ""}<strong>${escapeHtml(item.error ?? item.event.type)}</strong>${item.cause ? ` — ${escapeHtml(item.cause)}` : ""}</li>`).join("");
  return `${failureRows ? `<section class="card sfn-failures"><div class="card-header"><h2>Failure summary</h2></div><div class="card-body"><ul>${failureRows}</ul></div></section>` : ""}<section class="card"><div class="card-header"><h2>Retry-attempt timeline <span class="muted">(${model.retries.length})</span></h2></div>${retryRows ? `<div class="table-wrap"><table class="sfn-history"><thead><tr><th>Event</th><th>Time</th><th>State</th><th>Error</th><th>Cause</th></tr></thead><tbody>${retryRows}</tbody></table></div>` : emptyState("↻", "No retry attempts", "No typed TaskFailed retry events were recorded for this execution.")}</section>`;
}

function stateTable(model) {
  const rows = model.scopes.flatMap(scope => scope.states.map(item => {
    const related = model.history.events.filter(event => event.stateName === item.name);
    const failed = related.some(event => event.details.error || event.event.type.endsWith("Failed"));
    const exited = related.some(event => /StateExited$/.test(event.event.type));
    const value = model.history.active?.stateName === item.name ? model.history.active.waitingForCallback ? "WAITING FOR CALLBACK" : "RUNNING" : failed ? "FAILED" : exited ? "SUCCEEDED" : related.length ? "ENTERED" : "NOT STARTED";
    return `<tr><td><button class="button link" type="button" data-state-name="${escapeHtml(item.name)}" data-state-scope="${escapeHtml(scope.path)}">${escapeHtml(item.name)}</button><small class="muted sfn-block">${escapeHtml(scope.label)}</small></td><td>${escapeHtml(item.state.Type)}</td><td>${status(value)}</td><td>${related.length}</td></tr>`;
  })).join("");
  return `<div class="table-wrap"><table><thead><tr><th>State</th><th>Type</th><th>Observed status</th><th>Events</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function executionHtml(execution, history, snapshot, options) {
  const model = executionPresentation(snapshot.definition, history, execution.status);
  const selectedName = options.selectedState ?? model.history.active?.stateName ?? model.scopes[0]?.startAt;
  const selectedScope = options.selectedScope ?? model.scopes.find(scope => scope.states.some(item => item.name === selectedName))?.path;
  const selectedEvent = model.history.events.find(item => item.event.id === options.selectedEvent) ?? model.history.events.at(-1);
  const actions = `<span class="sfn-poll-state" role="status" aria-live="polite">${execution.status === "RUNNING" ? `Auto-refresh ${options.polling ? "active" : "ended"}` : "Terminal execution"}</span><button class="button refresh" type="button" data-refresh aria-label="Refresh execution">↻</button>${execution.status === "RUNNING" ? '<button class="button danger" type="button" data-stop>Stop execution</button>' : ""}`;
  const childExecutions = model.childExecutions.length ? `<section class="card"><div class="card-header"><h2>Child executions <span class="muted">(${model.childExecutions.length})</span></h2></div><div class="card-body sfn-related">${model.childExecutions.map(item => `<a class="button" href="${executionHref(item.executionArn)}">${escapeHtml(item.executionArn.split(":").at(-1))} <span class="muted">· ${escapeHtml(item.stateName ?? `event #${item.eventId}`)}</span></a>`).join("")}</div></section>` : "";
  const activeLabel = model.history.active?.waitingForCallback ? "WAITING FOR CALLBACK" : undefined;
  return `<div class="page-width sfn-detail">${pageHeader(execution.name, escapeHtml(execution.executionArn), actions)}<div class="sfn-summary"><section class="card"><div class="card-header"><h2>Execution summary</h2></div><div class="card-body"><dl class="key-value"><dt>Status</dt><dd>${status(execution.status)}</dd><dt>Execution ARN</dt><dd class="mono sfn-wrap">${escapeHtml(execution.executionArn)}</dd><dt>State machine ARN</dt><dd class="mono sfn-wrap"><a href="${machineHref(execution.stateMachineArn)}">${escapeHtml(execution.stateMachineArn)}</a></dd><dt>Definition revision</dt><dd class="mono sfn-wrap">${escapeHtml(snapshot.revisionId ?? "Not returned")}</dd><dt>Started</dt><dd>${formatDate(execution.startDate)}</dd><dt>Stopped</dt><dd>${execution.stopDate ? formatDate(execution.stopDate) : "Still running"}</dd><dt>Duration</dt><dd>${formatDuration(execution.startDate, execution.stopDate)}</dd><dt>Error</dt><dd>${escapeHtml(execution.error ?? "Absent")}</dd><dt>Cause</dt><dd class="sfn-wrap">${escapeHtml(redactSensitiveValue(execution.cause ?? "Absent"))}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Input and output</h2></div><div class="card-body"><h3>Input</h3>${renderPayload(execution.input, execution.inputDetails, "No input was recorded.")}<h3>Output</h3>${renderPayload(execution.output, execution.outputDetails, execution.status === "RUNNING" ? "Output is not produced while the execution is running." : "This terminal execution produced no output.")}</div></section></div>${retryAndFailures(model)}${childExecutions}<section class="card sfn-inspection"><div class="card-header"><h2>Execution inspection</h2><div class="sfn-view-switch" role="tablist" aria-label="Execution views"><button class="button ${options.view === "graph" ? "primary" : ""}" type="button" role="tab" aria-selected="${options.view === "graph"}" data-execution-view="graph">Graph</button><button class="button ${options.view === "states" ? "primary" : ""}" type="button" role="tab" aria-selected="${options.view === "states"}" data-execution-view="states">State table</button><button class="button ${options.view === "events" ? "primary" : ""}" type="button" role="tab" aria-selected="${options.view === "events"}" data-execution-view="events">Event history</button></div></div><div class="card-body"><div data-view-panel="graph" ${options.view === "graph" ? "" : "hidden"}>${definitionGraph(snapshot.definition, { activeName: model.history.active?.stateName, activeLabel, selectedName, selectable: true })}</div><div data-view-panel="states" ${options.view === "states" ? "" : "hidden"}>${stateTable(model)}</div><div data-view-panel="events" ${options.view === "events" ? "" : "hidden"}><div class="sfn-history-controls"><div class="field"><label for="sfn-event-filter">Event filter</label><select id="sfn-event-filter"><option value="all">All events</option><option value="state">State transitions</option><option value="task">Task and Lambda</option><option value="nested">Parallel and Map</option><option value="execution">Execution lifecycle</option><option value="failure">Failures</option></select></div><div class="field"><label for="sfn-event-search">Find events</label><input id="sfn-event-search" placeholder="Type, state, error, or ID"></div><div class="field"><label for="sfn-event-order">Order</label><select id="sfn-event-order"><option value="forward">Forward</option><option value="reverse">Reverse</option></select></div></div><div data-event-table></div></div><aside class="sfn-inspector" data-state-inspector aria-live="polite">${stateInspector(snapshot.definition, model, selectedName, selectedScope)}</aside></div></section>${nestedExecutionSummary(snapshot.definition, model)}<section class="card"><div class="card-header"><h2>Event details</h2></div><div class="card-body sfn-event-inspector" data-event-inspector aria-live="polite">${eventInspector(selectedEvent)}</div></section><section class="card"><div class="card-header"><h2>Immutable definition snapshot</h2></div><div class="card-body"><div class="alert info"><strong>Captured revision ${escapeHtml(snapshot.revisionId ?? "unknown")}</strong><br>This definition and execution role were frozen when the execution started; later state-machine updates do not change them.</div><dl class="key-value"><dt>Execution role</dt><dd class="mono sfn-wrap">${escapeHtml(snapshot.roleArn)}</dd><dt>Snapshot time</dt><dd>${formatDate(snapshot.updateDate)}</dd></dl><details class="sfn-details"><summary>Show States Language JSON</summary><pre class="code-box sfn-definition">${escapeHtml(pretty(snapshot.definition))}</pre></details></div></section></div>`;
}

function bindExecutionInteractions(root, data, options, rerender, refresh) {
  const model = executionPresentation(data.snapshot.definition, data.history, data.execution.status);
  const setView = view => {
    options.view = view;
    root.querySelectorAll("[data-execution-view]").forEach(button => { button.classList.toggle("primary", button.dataset.executionView === view); button.setAttribute("aria-selected", String(button.dataset.executionView === view)); });
    root.querySelectorAll("[data-view-panel]").forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  };
  root.querySelectorAll("[data-execution-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.executionView)));
  const selectState = (name, scope) => {
    options.selectedState = name;
    options.selectedScope = scope;
    root.querySelectorAll(".sfn-node").forEach(node => node.classList.toggle("selected", node.dataset.stateName === name && (!scope || node.dataset.stateScope === scope)));
    root.querySelector("[data-state-inspector]").innerHTML = stateInspector(data.snapshot.definition, model, name, scope);
    bindInspectorLinks();
  };
  root.querySelectorAll("[data-state-name]").forEach(button => button.addEventListener("click", () => selectState(button.dataset.stateName, button.dataset.stateScope)));
  root.querySelectorAll("[data-state-jump]").forEach(button => button.addEventListener("click", () => { setView("graph"); selectState(button.dataset.stateJump); root.querySelector(".sfn-inspection")?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
  const selectEvent = id => {
    const item = model.history.events.find(candidate => candidate.event.id === Number(id));
    if (!item) return;
    options.selectedEvent = item.event.id;
    root.querySelector("[data-event-inspector]").innerHTML = eventInspector(item);
    root.querySelector("[data-event-inspector]").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const bindInspectorLinks = () => root.querySelectorAll("[data-event-id]").forEach(button => button.addEventListener("click", () => selectEvent(button.dataset.eventId)));
  bindInspectorLinks();

  const tableHost = root.querySelector("[data-event-table]");
  const filter = root.querySelector("#sfn-event-filter");
  const search = root.querySelector("#sfn-event-search");
  const order = root.querySelector("#sfn-event-order");
  let eventPage = 0;
  const matchesFilter = item => {
    const value = filter?.value ?? "all";
    if (value === "state") return /State(?:Entered|Exited)$/.test(item.event.type);
    if (value === "task") return /Task|LambdaFunction/.test(item.event.type);
    if (value === "nested") return /Parallel|Map/.test(item.event.type);
    if (value === "execution") return /^Execution/.test(item.event.type);
    if (value === "failure") return Boolean(item.details.error) || /Failed|TimedOut|Aborted/.test(item.event.type);
    return true;
  };
  const renderEvents = () => {
    if (!tableHost) return;
    const query = (search?.value ?? "").trim().toLowerCase();
    let items = model.history.events.filter(matchesFilter).filter(item => !query || `${item.event.id} ${item.event.type} ${item.stateName ?? ""} ${item.details.error ?? ""} ${item.details.cause ?? ""}`.toLowerCase().includes(query));
    if (order?.value === "reverse") items = [...items].reverse();
    const pages = Math.max(1, Math.ceil(items.length / 100));
    eventPage = Math.min(eventPage, pages - 1);
    const visible = items.slice(eventPage * 100, eventPage * 100 + 100);
    tableHost.innerHTML = `${visible.length ? `<div class="table-wrap"><table class="sfn-history"><thead><tr><th>ID</th><th>Timestamp</th><th>Type</th><th>State / error</th><th>Previous</th></tr></thead><tbody>${visible.map(item => `<tr id="sfn-event-${item.event.id}"><td>${item.event.id}</td><td>${formatDate(item.event.timestamp)}</td><td><button class="button link" type="button" data-select-event="${item.event.id}">${escapeHtml(item.event.type)}</button></td><td>${escapeHtml(item.stateName ?? item.details.error ?? "–")}</td><td>${item.event.previousEventId || "–"}</td></tr>`).join("")}</tbody></table></div>` : emptyState("◇", "No matching events", "Change the event filter or search text.")}<nav class="pagination sfn-event-pagination" aria-label="Event pages"><button class="button" type="button" data-event-page="previous" ${eventPage === 0 ? "disabled" : ""}>Previous</button><span>Page ${eventPage + 1} of ${pages} · ${items.length} events</span><button class="button" type="button" data-event-page="next" ${eventPage + 1 >= pages ? "disabled" : ""}>Next</button></nav>`;
    tableHost.querySelectorAll("[data-select-event]").forEach(button => button.addEventListener("click", () => selectEvent(button.dataset.selectEvent)));
    tableHost.querySelector('[data-event-page="previous"]')?.addEventListener("click", () => { eventPage--; renderEvents(); });
    tableHost.querySelector('[data-event-page="next"]')?.addEventListener("click", () => { eventPage++; renderEvents(); });
  };
  [filter, search, order].filter(Boolean).forEach(control => control.addEventListener(control === search ? "input" : "change", () => { eventPage = 0; renderEvents(); }));
  renderEvents();
  root.querySelector("[data-refresh]")?.addEventListener("click", () => refresh(true));
  root.querySelector("[data-stop]")?.addEventListener("click", async () => {
    try {
      await states("StopExecution", { executionArn: data.execution.executionArn, error: "States.TaskFailed", cause: "Stopped from the local console" });
      context.toast("Execution stopped");
      await refresh(true);
    } catch (error) { context.showError(error); }
  });
}

async function executionPage(arn) {
  let disposed = false;
  let timer;
  let polls = 0;
  const maximumPolls = 40;
  const options = { view: "graph", selectedState: null, selectedScope: null, selectedEvent: null, polling: true };
  const cleanup = () => { disposed = true; if (timer) clearTimeout(timer); };
  activeViewCleanup = cleanup;
  window.addEventListener("hashchange", cleanup, { once: true });
  const load = async () => {
    const [execution, history, snapshot] = await Promise.all([states("DescribeExecution", { executionArn: arn }), completeHistory(arn, true), states("DescribeStateMachineForExecution", { executionArn: arn })]);
    return { execution, history, snapshot };
  };
  const render = data => {
    if (disposed) return;
    context.setChrome("step-functions", ["Step Functions", "Executions", data.execution.name]);
    options.polling = data.execution.status === "RUNNING" && polls < maximumPolls;
    context.main.innerHTML = executionHtml(data.execution, data.history, data.snapshot, options);
    decorateStepFunctionsPanelHelp(context.main);
    bindExecutionInteractions(context.main, data, options, render, refresh);
    if (data.execution.status === "RUNNING" && polls < maximumPolls) {
      timer = setTimeout(async () => {
        if (disposed) return;
        polls++;
        try { render(await load()); }
        catch (error) { if (!disposed) context.showError(error); }
      }, 1500);
    }
  };
  const refresh = async manual => {
    if (timer) clearTimeout(timer);
    if (manual) polls = 0;
    render(await load());
  };
  render(await load());
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
  if (parts[1] === "state-machines" && parts[2] === "create") return render(createPage());
  if (parts[1] === "state-machines" && parts[2] && parts[3] === "edit") return render(editPage(parts[2]));
  if (parts[1] === "state-machines" && parts[2]) return render(machinePage(parts[2], parts[3] ?? "overview"));
  if (parts[1] === "executions" && parts[2]) return render(executionPage(parts[2]));
  if (parts[1] === "executions") return render(executionsPage());
  if (parts[1] === "activities") return render(activitiesPage());
  return render(listPage());
}
