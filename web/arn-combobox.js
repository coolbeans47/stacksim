import { dynamo, events, logs, rest, s3Request, sns, sqs, states } from "./api-client.js";
import { escapeHtml } from "./components.js";
import { session as ui } from "./state.js";

let generatedId = 0;
const pageSize = 50;

const kindLabels = {
  "iam-role": "IAM role",
  "lambda-function": "Lambda function",
  "sqs-queue": "SQS queue",
  "states-machine": "Step Functions state machine",
  "eventbridge-bus": "EventBridge event bus",
  "logs-log-group": "CloudWatch log group",
  "dynamodb-table": "DynamoDB table",
  "s3-bucket": "S3 bucket",
  "sns-topic": "SNS topic",
};

function nextId(prefix = "arn-combobox") { return `${prefix}-${++generatedId}`; }
function csv(value) { return String(value ?? "").split(",").map(item => item.trim()).filter(Boolean); }
function arnParts(value) {
  const match = String(value).match(/^arn:([a-z0-9-]+):([a-z0-9-]*):([^:]*):([^:]*):(.+)$/i);
  return match ? { partition: match[1], service: match[2], region: match[3], accountId: match[4], resource: match[5] } : undefined;
}

function kindForArn(arn) {
  const parts = arnParts(arn);
  if (!parts) return undefined;
  if (parts.service === "iam" && parts.resource.startsWith("role/")) return "iam-role";
  if (parts.service === "lambda" && parts.resource.startsWith("function:")) return "lambda-function";
  if (parts.service === "sqs") return "sqs-queue";
  if (parts.service === "states" && parts.resource.startsWith("stateMachine:")) return "states-machine";
  if (parts.service === "events" && parts.resource.startsWith("event-bus/")) return "eventbridge-bus";
  if (parts.service === "logs" && parts.resource.startsWith("log-group:")) return "logs-log-group";
  if (parts.service === "dynamodb" && parts.resource.startsWith("table/")) return "dynamodb-table";
  if (parts.service === "s3") return "s3-bucket";
  if (parts.service === "sns") return "sns-topic";
  return `${parts.service}:${parts.resource.split(/[/:]/)[0]}`;
}

function suggestion(arn, name, kind, extra = {}) {
  const parts = arnParts(arn) ?? {};
  return { arn, name, kind, accountId: parts.accountId || undefined, region: parts.region || undefined, ...extra };
}

async function collectPages(load, key, tokenKey = "nextToken") {
  const values = [];
  let token;
  do {
    const page = await load(token);
    values.push(...(page[key] ?? []));
    token = page[tokenKey] ?? page.NextToken;
  } while (token);
  return values;
}

async function lambdaSuggestions() {
  const functions = await collectPages(token => rest(`/2015-03-31/functions?MaxItems=50${token ? `&Marker=${encodeURIComponent(token)}` : ""}`), "Functions", "NextMarker");
  return functions.map(item => suggestion(item.FunctionArn, item.FunctionName, "lambda-function", { description: item.Description }));
}

async function queueSuggestions() {
  const urls = await collectPages(token => sqs("ListQueues", { MaxResults: 1_000, ...(token ? { NextToken: token } : {}) }), "QueueUrls", "NextToken");
  const rows = await Promise.all(urls.map(async url => {
    const result = await sqs("GetQueueAttributes", { QueueUrl: url, AttributeNames: ["All"] });
    const arn = result.Attributes?.QueueArn;
    if (!arn) return undefined;
    return suggestion(arn, decodeURIComponent(new URL(url, location.origin).pathname.split("/").at(-1)), "sqs-queue", { subtype: result.Attributes?.FifoQueue === "true" ? "fifo" : "standard" });
  }));
  return rows.filter(Boolean);
}

async function stateMachineSuggestions() {
  const machines = await collectPages(token => states("ListStateMachines", { maxResults: 100, ...(token ? { nextToken: token } : {}) }), "stateMachines", "nextToken");
  return machines.map(item => suggestion(item.stateMachineArn, item.name, "states-machine", { description: item.type }));
}

async function busSuggestions() {
  const buses = await collectPages(token => events("ListEventBuses", { Limit: 100, ...(token ? { NextToken: token } : {}) }), "EventBuses", "NextToken");
  return buses.map(item => suggestion(item.Arn, item.Name, "eventbridge-bus", { description: item.Description }));
}

async function logGroupSuggestions() {
  const groups = await collectPages(token => logs("DescribeLogGroups", { limit: 50, ...(token ? { nextToken: token } : {}) }), "logGroups", "nextToken");
  return groups.map(item => suggestion(item.arn?.replace(/:\*$/, "") ?? `arn:aws:logs:${ui.region}:${ui.summary?.accountId}:log-group:${item.logGroupName}`, item.logGroupName, "logs-log-group"));
}

async function tableSuggestions() {
  const names = await collectPages(token => dynamo("ListTables", { Limit: 100, ...(token ? { ExclusiveStartTableName: token } : {}) }), "TableNames", "LastEvaluatedTableName");
  return names.map(name => suggestion(`arn:aws:dynamodb:${ui.region}:${ui.summary?.accountId}:table/${name}`, name, "dynamodb-table"));
}

async function bucketSuggestions() {
  const result = await s3Request("/");
  return [...result.xml.getElementsByTagName("Bucket")].map(node => {
    const value = name => node.getElementsByTagName(name)[0]?.textContent ?? "";
    const name = value("Name");
    return suggestion(value("BucketArn") || `arn:aws:s3:::${name}`, name, "s3-bucket", { region: value("BucketRegion") || ui.region });
  });
}

function snsChildren(node, name) { return [...(node?.childNodes ?? [])].filter(item => item.nodeType === 1 && (!name || item.localName === name || item.nodeName === name)); }
async function topicSuggestions() {
  const arns = []; let NextToken;
  do {
    const result = await sns("ListTopics", NextToken ? { NextToken } : {});
    const root = result.xml?.documentElement; const resultNode = snsChildren(root).find(node => /Result$/.test(node.localName || node.nodeName)) ?? root;
    const topics = snsChildren(snsChildren(resultNode, "Topics")[0], "member");
    arns.push(...topics.map(node => snsChildren(node, "TopicArn")[0]?.textContent).filter(Boolean));
    NextToken = snsChildren(resultNode, "NextToken")[0]?.textContent || undefined;
  } while (NextToken);
  return arns.map(arn => suggestion(arn, arn.split(":").at(-1), "sns-topic"));
}

async function roleSuggestions(constraint, targetArn) {
  const roles = (await rest("/_stacksim/api/iam/roles")).roles ?? [];
  const inferredAction = targetArn?.includes(":lambda:") ? "lambda:InvokeFunction"
    : targetArn?.includes(":sqs:") ? "sqs:SendMessage"
      : targetArn?.includes(":states:") ? "states:StartExecution"
        : targetArn?.includes(":events:") ? "events:PutEvents" : undefined;
  const requiredActions = constraint.requiredActions.length ? constraint.requiredActions : constraint.targetName && inferredAction ? [{ action: inferredAction, resource: "selection" }] : [];
  if (!constraint.servicePrincipal && !requiredActions.length) {
    return roles.map(role => suggestion(role.arn, role.roleName, "iam-role", { description: role.description }));
  }
  const body = {
    ServicePrincipal: constraint.servicePrincipal,
    PassedToService: constraint.passedToService,
    RequiredActions: requiredActions.map(action => ({ Action: action.action, Resource: action.resource === "selection" ? targetArn : action.resource })),
  };
  const result = await rest("/_stacksim/api/iam/role-preflight", "POST", body);
  return (result.roles ?? []).filter(role => role.compatibility !== "invalid").map(role => suggestion(role.arn, role.roleName, "iam-role", {
    compatibility: role.compatibility,
    compatibilityText: role.compatibilityText,
    description: role.description,
  }));
}

const loaders = {
  "lambda-function": () => lambdaSuggestions(),
  "sqs-queue": () => queueSuggestions(),
  "states-machine": () => stateMachineSuggestions(),
  "eventbridge-bus": () => busSuggestions(),
  "logs-log-group": () => logGroupSuggestions(),
  "dynamodb-table": () => tableSuggestions(),
  "s3-bucket": () => bucketSuggestions(),
  "sns-topic": () => topicSuggestions(),
};

function requiredActionsFromDataset(dataset) {
  if (!dataset.arnRequiredActions) return [];
  try {
    const value = JSON.parse(dataset.arnRequiredActions);
    return Array.isArray(value) ? value.map(item => typeof item === "string" ? { action: item, resource: "selection" } : { action: item.action, resource: item.resourceFrom ?? item.resource ?? "selection" }) : [];
  } catch { return []; }
}

function constraintFor(root) {
  return {
    allowedKinds: csv(root.dataset.arnKinds),
    enforceKinds: root.dataset.arnEnforceKinds !== "false",
    acceptedManualFormats: csv(root.dataset.arnFormats || "arn"),
    localExistence: root.dataset.arnExistence || "preferred",
    accountScope: root.dataset.arnAccount || "any",
    regionScope: root.dataset.arnRegion || "any",
    subtype: root.dataset.arnSubtype,
    servicePrincipal: root.dataset.arnServicePrincipal,
    passedToService: root.dataset.arnPassedToService,
    requiredActions: requiredActionsFromDataset(root.dataset),
    emptyHelp: root.dataset.arnEmptyHelp,
    targetName: root.dataset.arnTargetName,
  };
}

function staticSuggestions(root) {
  try {
    const parsed = JSON.parse(root.dataset.arnStatic || "[]");
    return parsed.filter(item => item?.arn).map(item => suggestion(item.arn, item.name || item.arn, item.kind || kindForArn(item.arn) || "resource", item));
  } catch { return []; }
}

async function loadSuggestions(root, constraint) {
  const target = constraint.targetName ? root.closest("form")?.querySelector(`[name="${CSS.escape(constraint.targetName)}"]`)?.value.trim() : undefined;
  const settled = await Promise.allSettled(constraint.allowedKinds.map(kind => kind === "iam-role" ? roleSuggestions(constraint, target) : loaders[kind]?.() ?? []));
  const rejected = settled.filter(result => result.status === "rejected");
  if (rejected.length === settled.length && settled.length) throw rejected[0].reason;
  const batches = settled.filter(result => result.status === "fulfilled").map(result => result.value);
  const localStatic = staticSuggestions(root).filter(item => !(item.kind === "iam-role" && constraint.servicePrincipal));
  const merged = [...localStatic, ...batches.flat()];
  const seen = new Set();
  return merged.filter(item => item.arn && !seen.has(item.arn) && seen.add(item.arn))
    .filter(item => !constraint.subtype || item.subtype === constraint.subtype)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function optionMarkup(item, id, selected) {
  const meta = [kindLabels[item.kind] ?? item.kind, item.region].filter(Boolean).join(" | ");
  return `<li id="${escapeHtml(id)}" role="option" aria-selected="${selected}" data-arn-value="${escapeHtml(item.arn)}"><strong>${escapeHtml(item.name)}</strong>${item.compatibilityText ? `<span class="arn-combobox-compatibility">${escapeHtml(item.compatibilityText)}</span>` : ""}<span>${escapeHtml(meta)}</span><span class="mono">${escapeHtml(item.arn)}</span></li>`;
}

function clippingBounds(element) {
  let top = 0; let bottom = window.innerHeight;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const { overflowY } = getComputedStyle(ancestor);
    if (!/(auto|scroll|hidden|clip)/.test(overflowY)) continue;
    const bounds = ancestor.getBoundingClientRect();
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
  }
  return { top, bottom };
}

function positionListbox(instance) {
  if (instance.root.dataset.open !== "true") return;
  const { root, listbox } = instance;
  listbox.style.maxHeight = "";
  if (getComputedStyle(listbox).position === "static") {
    delete root.dataset.placement;
    return;
  }
  const anchor = root.getBoundingClientRect();
  const bounds = clippingBounds(root);
  const gap = 4;
  const spaceAbove = Math.max(0, anchor.top - bounds.top - gap);
  const spaceBelow = Math.max(0, bounds.bottom - anchor.bottom - gap);
  const configuredMaximum = Number.parseFloat(getComputedStyle(listbox).maxHeight) || listbox.scrollHeight;
  const desiredHeight = Math.min(listbox.scrollHeight, configuredMaximum);
  const placeAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
  const availableHeight = placeAbove ? spaceAbove : spaceBelow;
  root.dataset.placement = placeAbove ? "above" : "below";
  listbox.style.maxHeight = `${Math.min(configuredMaximum, availableHeight)}px`;
}

function trackListboxPosition(instance) {
  instance.positionController?.abort();
  instance.positionObserver?.disconnect();
  const controller = new AbortController();
  const reposition = () => positionListbox(instance);
  instance.positionController = controller;
  document.addEventListener("scroll", reposition, { capture: true, passive: true, signal: controller.signal });
  window.addEventListener("resize", reposition, { passive: true, signal: controller.signal });
  instance.positionObserver = new ResizeObserver(reposition);
  instance.positionObserver.observe(instance.input);
  instance.positionObserver.observe(instance.listbox);
  reposition();
}

function render(instance) {
  const { root, input, listbox, status } = instance;
  const query = input.value.trim().toLowerCase();
  instance.filtered = instance.suggestions.filter(item => !query || `${item.name} ${item.arn} ${kindLabels[item.kind] ?? item.kind} ${item.description ?? ""}`.toLowerCase().includes(query));
  if (instance.active >= instance.filtered.length) instance.active = instance.filtered.length ? 0 : -1;
  const shown = instance.filtered.slice(0, instance.limit);
  if (!shown.length) {
    listbox.style.pointerEvents = "none";
    listbox.innerHTML = `<li class="arn-combobox-message" role="option" aria-disabled="true">${escapeHtml(instance.constraint.emptyHelp || "No matching local resources. You can still enter an ARN.")}</li>`;
  } else {
    listbox.style.pointerEvents = "";
    listbox.innerHTML = shown.map((item, index) => optionMarkup(item, `${listbox.id}-${item.optionId ||= nextId("option")}`, index === instance.active)).join("") + (shown.length < instance.filtered.length ? `<li class="arn-combobox-more"><button type="button" data-arn-more>Show more (${instance.filtered.length - shown.length} remaining)</button></li>` : "");
  }
  const active = instance.active >= 0 && instance.active < shown.length ? `${listbox.id}-${shown[instance.active].optionId}` : "";
  if (active) input.setAttribute("aria-activedescendant", active); else input.removeAttribute("aria-activedescendant");
  status.textContent = instance.loading ? "Loading suggestions" : `${instance.filtered.length} local suggestion${instance.filtered.length === 1 ? "" : "s"}`;
  root.querySelector("[data-arn-more]")?.addEventListener("click", () => { instance.limit += pageSize; render(instance); });
  positionListbox(instance);
}

function close(instance) {
  instance.positionController?.abort();
  instance.positionObserver?.disconnect();
  instance.positionController = undefined;
  instance.positionObserver = undefined;
  instance.root.dataset.open = "false";
  delete instance.root.dataset.placement;
  instance.input.setAttribute("aria-expanded", "false");
  instance.button.setAttribute("aria-expanded", "false");
  instance.listbox.hidden = true;
  instance.listbox.style.maxHeight = "";
  instance.input.removeAttribute("aria-activedescendant");
}

async function open(instance) {
  if (instance.root.dataset.open === "true") return;
  for (const other of document.querySelectorAll('.arn-combobox[data-open="true"]')) other._arnCombobox && close(other._arnCombobox);
  instance.root.dataset.open = "true";
  instance.input.setAttribute("aria-expanded", "true");
  instance.button.setAttribute("aria-expanded", "true");
  instance.listbox.hidden = false;
  trackListboxPosition(instance);
  const generation = ++instance.generation;
  if (!instance.loaded || instance.constraint.targetName) {
    instance.loading = true;
    instance.listbox.style.pointerEvents = "none";
    instance.listbox.innerHTML = '<li class="arn-combobox-message" role="option" aria-disabled="true">Loading suggestions…</li>';
    instance.status.textContent = "Loading suggestions";
    try {
      const suggestions = await loadSuggestions(instance.root, instance.constraint);
      if (generation !== instance.generation || instance.root.dataset.open !== "true") return;
      instance.suggestions = suggestions;
      instance.loaded = true;
      instance.loadingError = undefined;
    } catch (error) {
      if (generation !== instance.generation) return;
      instance.loadingError = error;
      instance.suggestions = staticSuggestions(instance.root);
    } finally {
      if (generation === instance.generation) instance.loading = false;
    }
  }
  if (instance.loadingError && !instance.suggestions.length) {
    instance.listbox.style.pointerEvents = "";
    instance.listbox.innerHTML = '<li class="arn-combobox-message" role="option" aria-disabled="true">Suggestions unavailable; type or paste an ARN. <button type="button" data-arn-retry>Retry</button></li>';
    instance.status.textContent = "Suggestions unavailable; manual entry remains available";
    instance.root.querySelector("[data-arn-retry]")?.addEventListener("click", () => { instance.loaded = false; instance.loadingError = undefined; close(instance); open(instance); });
    positionListbox(instance);
    return;
  }
  render(instance);
}

function choose(instance, index) {
  const item = instance.filtered[index];
  if (!item) return;
  instance.input.value = item.arn;
  instance.input.dispatchEvent(new Event("input", { bubbles: true }));
  instance.input.dispatchEvent(new Event("change", { bubbles: true }));
  close(instance);
  validate(instance, true);
}

function validationMessage(instance) {
  const value = instance.input.value.trim();
  const constraint = instance.constraint;
  if (!value) return "";
  const parts = arnParts(value);
  if (!parts) return constraint.acceptedManualFormats.includes("arn") && constraint.acceptedManualFormats.length === 1 ? "Enter a complete ARN." : "";
  const kind = kindForArn(value);
  if (constraint.enforceKinds && constraint.allowedKinds.length && !constraint.allowedKinds.includes(kind)) return `Choose or enter ${constraint.allowedKinds.map(item => kindLabels[item] ?? item).join(" or ")}.`;
  if (constraint.accountScope === "same" && parts.accountId && parts.accountId !== String(ui.summary?.accountId)) return `The ARN must belong to account ${ui.summary?.accountId}.`;
  if (constraint.regionScope === "same" && parts.region && parts.region !== ui.region) return `The ARN must be in ${ui.region}.`;
  if (constraint.subtype && kind === "sqs-queue" && value.endsWith(".fifo") !== (constraint.subtype === "fifo")) return constraint.subtype === "standard" ? "Choose a Standard SQS queue; FIFO queues are not supported here." : "Choose a FIFO SQS queue.";
  if (constraint.localExistence === "required" && instance.loaded && !instance.suggestions.some(item => item.arn === value)) return "Choose an existing local resource.";
  return "";
}

function validate(instance, announce = false) {
  const message = validationMessage(instance);
  instance.input.setCustomValidity(message);
  instance.error.textContent = message;
  instance.error.hidden = !message;
  instance.input.setAttribute("aria-invalid", String(Boolean(message)));
  if (announce && message) instance.status.textContent = message;
  return !message;
}

async function validateRoleCompatibility(instance) {
  if (!instance.constraint.allowedKinds.includes("iam-role") || !instance.constraint.servicePrincipal || !arnParts(instance.input.value.trim())) return;
  const targetArn = instance.constraint.targetName ? instance.root.closest("form")?.querySelector(`[name="${CSS.escape(instance.constraint.targetName)}"]`)?.value.trim() : undefined;
  try {
    const roles = await roleSuggestions(instance.constraint, targetArn);
    const local = roles.find(role => role.arn === instance.input.value.trim());
    if (!local) {
      const all = (await rest("/_stacksim/api/iam/roles")).roles ?? [];
      if (all.some(role => role.arn === instance.input.value.trim())) {
        const message = `The selected role is not compatible with ${instance.constraint.servicePrincipal}.`;
        instance.input.setCustomValidity(message); instance.input.setAttribute("aria-invalid", "true"); instance.error.textContent = message; instance.error.hidden = false; instance.status.textContent = message;
      }
      return;
    }
    if (local.compatibility === "review") instance.status.textContent = local.compatibilityText || "Review this role's policy conditions.";
  } catch {
    instance.status.textContent = "Role compatibility could not be checked; the service validates it on submit.";
  }
}

function bindOne(root) {
  if (root._arnCombobox) return root._arnCombobox;
  const input = root.querySelector("input");
  const button = root.querySelector("[data-arn-toggle]");
  const listbox = root.querySelector('[role="listbox"]');
  const status = root.querySelector("[data-arn-status]");
  const error = root.querySelector("[data-arn-error]");
  if (!input || !button || !listbox || !status || !error) return undefined;
  const instance = { root, input, button, listbox, status, error, constraint: constraintFor(root), suggestions: [], filtered: [], active: -1, limit: pageSize, generation: 0, loading: false, loaded: false };
  root._arnCombobox = instance;
  input.addEventListener("focus", () => open(instance));
  input.addEventListener("input", () => { instance.active = 0; if (root.dataset.open === "true") render(instance); input.setCustomValidity(""); error.hidden = true; });
  input.addEventListener("blur", () => setTimeout(() => { if (validate(instance)) void validateRoleCompatibility(instance); if (!root.contains(document.activeElement)) close(instance); }, 0));
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (root.dataset.open !== "true") { open(instance); return; }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      instance.active = Math.max(0, Math.min(instance.filtered.length - 1, instance.active + direction));
      if (instance.active >= instance.limit) instance.limit += pageSize;
      render(instance);
      listbox.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && root.dataset.open === "true" && instance.active >= 0) {
      event.preventDefault(); choose(instance, instance.active);
    } else if (event.key === "Escape" && root.dataset.open === "true") {
      event.preventDefault(); event.stopPropagation(); close(instance);
    } else if (event.key === "Tab") close(instance);
  });
  button.addEventListener("click", () => root.dataset.open === "true" ? close(instance) : open(instance));
  listbox.addEventListener("mousedown", event => event.preventDefault());
  listbox.addEventListener("click", event => {
    const option = event.target.closest("[data-arn-value]");
    if (!option) return;
    choose(instance, [...listbox.querySelectorAll("[data-arn-value]")].indexOf(option));
    input.focus();
  });
  const target = instance.constraint.targetName ? root.closest("form")?.querySelector(`[name="${CSS.escape(instance.constraint.targetName)}"]`) : undefined;
  target?.addEventListener("change", () => { instance.loaded = false; if (root.dataset.open === "true") { close(instance); open(instance); } if (validate(instance, true)) void validateRoleCompatibility(instance); });
  target?.addEventListener("blur", () => { instance.loaded = false; if (validate(instance, true)) void validateRoleCompatibility(instance); });
  root.closest("form")?.addEventListener("formdata", event => {
    if (input.name && input.isConnected && !input.disabled && root.closest("form") === event.target) event.formData.set(input.name, input.value.trim());
  });
  return instance;
}

export function arnComboboxControl({ name, value = "", required = false, placeholder = "arn:aws:…", kinds = [], enforceKinds = true, formats = ["arn"], localExistence = "preferred", accountScope = "any", regionScope = "any", subtype, servicePrincipal, passedToService, requiredActions = [], targetName, emptyHelp, staticSuggestions: supplied = [], className = "mono", suggestionLabel = name }) {
  const id = nextId(); const listId = `${id}-listbox`; const statusId = `${id}-status`; const errorId = `${id}-error`;
  const data = [
    `data-arn-kinds="${escapeHtml(kinds.join(","))}"`, `data-arn-enforce-kinds="${enforceKinds}"`, `data-arn-formats="${escapeHtml(formats.join(","))}"`, `data-arn-existence="${escapeHtml(localExistence)}"`,
    `data-arn-account="${escapeHtml(accountScope)}"`, `data-arn-region="${escapeHtml(regionScope)}"`, `data-arn-static="${escapeHtml(JSON.stringify(supplied))}"`,
    subtype ? `data-arn-subtype="${escapeHtml(subtype)}"` : "", servicePrincipal ? `data-arn-service-principal="${escapeHtml(servicePrincipal)}"` : "",
    passedToService ? `data-arn-passed-to-service="${escapeHtml(passedToService)}"` : "", targetName ? `data-arn-target-name="${escapeHtml(targetName)}"` : "",
    emptyHelp ? `data-arn-empty-help="${escapeHtml(emptyHelp)}"` : "", requiredActions.length ? `data-arn-required-actions="${escapeHtml(JSON.stringify(requiredActions))}"` : "",
  ].filter(Boolean).join(" ");
  return `<div class="arn-combobox" data-open="false" ${data}><div class="arn-combobox-input"><input id="${id}" class="${escapeHtml(className)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""} role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" aria-describedby="${statusId} ${errorId}"><button type="button" data-arn-toggle aria-label="Show resource suggestions for this field" title="Show ${escapeHtml(suggestionLabel)} suggestions" aria-haspopup="listbox" aria-controls="${listId}" aria-expanded="false"></button></div><ul id="${listId}" class="arn-combobox-list" role="listbox" hidden></ul><span id="${statusId}" class="visually-hidden" data-arn-status aria-live="polite"></span><span id="${errorId}" class="field-error" data-arn-error hidden></span></div>`;
}

export function arnComboboxField(label, options, hint = "") {
  const control = arnComboboxControl({ ...options, suggestionLabel: label });
  const id = control.match(/<input id="([^"]+)"/)?.[1];
  return `<div class="field arn-reference-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</div>`;
}

function inferredKinds(field, control) {
  const label = field.querySelector(":scope > label")?.textContent ?? "";
  const key = `${label} ${control.name ?? ""}`.toLowerCase();
  if (key.includes("role")) return ["iam-role"];
  if (key.includes("dlq") || key.includes("dead letter") || key.includes("queue")) return ["sqs-queue"];
  if (key.includes("log group") || key.includes("access log")) return ["logs-log-group"];
  if (key.includes("table")) return ["dynamodb-table"];
  if (key.includes("bucket")) return ["s3-bucket"];
  if (key.includes("topic")) return ["sns-topic"];
  if (key.includes("state machine")) return ["states-machine"];
  if (key.includes("event bus")) return ["eventbridge-bus"];
  if (key.includes("function") || key.includes("lambda")) return ["lambda-function"];
  if (key.includes("target") || key.includes("destination") || key.includes("action")) return ["lambda-function", "sqs-queue", "states-machine", "eventbridge-bus", "logs-log-group"];
  return [];
}

function principalForField(field, control) {
  const key = `${field.querySelector(":scope > label")?.textContent ?? ""} ${control.name ?? ""}`.toLowerCase();
  if (!key.includes("role")) return undefined;
  const route = location.hash;
  if (route.startsWith("#/lambda")) return "lambda.amazonaws.com";
  if (route.startsWith("#/step-functions")) return "states.amazonaws.com";
  if (route.startsWith("#/appsync")) return "appsync.amazonaws.com";
  if (route.startsWith("#/eventbridge/schedules")) return "scheduler.amazonaws.com";
  if (route.startsWith("#/eventbridge")) return "events.amazonaws.com";
  if (route.startsWith("#/apigateway")) return "apigateway.amazonaws.com";
  if (route.startsWith("#/sns")) return "sns.amazonaws.com";
  return undefined;
}

function shouldEnhance(field, control) {
  if (control.dataset.arnExclude !== undefined || control.readOnly || control.disabled || control.type === "hidden") return false;
  const label = field.querySelector(":scope > label")?.textContent ?? "";
  if (control instanceof HTMLInputElement) return /\bARNs?\b/i.test(label) || /(?:arn|rolearn)$/i.test(control.name ?? "");
  if (control instanceof HTMLSelectElement) return !control.multiple && [...control.options].some(option => option.value.startsWith("arn:"));
  return false;
}

function upgradeField(field, control) {
  const kinds = inferredKinds(field, control);
  const labelText = field.querySelector(":scope > label")?.textContent?.trim() || control.name;
  const formatHint = `${labelText} ${control.placeholder ?? ""} ${control.value ?? ""}`;
  const manualFormats = /kms/i.test(labelText) ? ["arn", "id", "alias"] : /(?:url|uri|file:\/\/|s3:\/\/)/i.test(formatHint) ? ["arn", "url"] : ["arn"];
  const emptyHelp = kinds.length ? undefined : `StackSim does not provide a local ${labelText.replace(/\s*\([^)]*\)\s*/g, " ").trim()} catalog. Type or paste the accepted value.`;
  const staticValues = control instanceof HTMLSelectElement ? [...control.options].filter(option => option.value.startsWith("arn:")).map(option => ({ arn: option.value, name: option.textContent.trim(), kind: kindForArn(option.value) })) : [];
  const current = control.value;
  const sameRegionalResource = location.hash.startsWith("#/appsync") && kinds.includes("dynamodb-table");
  const input = document.createElement("div");
  input.innerHTML = arnComboboxControl({ name: control.name, value: current, required: control.required, placeholder: control.placeholder || "arn:aws:…", kinds, enforceKinds: false, formats: manualFormats, staticSuggestions: staticValues, accountScope: kinds.includes("iam-role") || sameRegionalResource ? "same" : "any", regionScope: sameRegionalResource ? "same" : "any", servicePrincipal: principalForField(field, control), passedToService: principalForField(field, control), emptyHelp, suggestionLabel: labelText });
  const replacement = input.firstElementChild;
  const generatedInput = replacement.querySelector("input");
  if (control instanceof HTMLInputElement) {
    for (const attribute of ["id", "role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-describedby"]) control.setAttribute(attribute, generatedInput.getAttribute(attribute));
    control.classList.add(...[...generatedInput.classList].filter(name => !control.classList.contains(name)));
    control.replaceWith(replacement);
    generatedInput.replaceWith(control);
  } else {
    for (const attribute of ["data-dirty-track"]) if (control.hasAttribute(attribute)) generatedInput.setAttribute(attribute, control.getAttribute(attribute) ?? "");
    control.replaceWith(replacement);
  }
  const label = field.querySelector(":scope > label");
  if (label) label.htmlFor = replacement.querySelector("input").id;
}

export function enhanceArnComboboxes(root = document) {
  root.querySelectorAll(".field").forEach(field => {
    if (field.querySelector(":scope > .arn-combobox")) return;
    const multipleSelect = field.querySelector(":scope > select[multiple]");
    if (multipleSelect && [...multipleSelect.options].some(option => option.value.startsWith("arn:"))) { upgradeMultiSelect(field, multipleSelect); return; }
    const controls = [...field.querySelectorAll(":scope > input, :scope > select")];
    if (controls.length === 1 && shouldEnhance(field, controls[0])) upgradeField(field, controls[0]);
    const textarea = field.querySelector(":scope > textarea");
    const label = field.querySelector(":scope > label")?.textContent ?? "";
    if (textarea && /\bARNs?\b/i.test(label) && /one per line|allowed source queue/i.test(label) && textarea.name !== "resources") upgradeMultiField(field, textarea);
  });
  root.querySelectorAll(".arn-combobox").forEach(bindOne);
}

function arnMultiComboboxControl({ name, values = [], formMode = "newline", ...options }) {
  const picker = arnComboboxControl({ name: `${name}Draft`, ...options });
  const storage = formMode === "multiple" ? `<span hidden data-arn-multi-value data-arn-multi-mode="multiple" data-arn-name="${escapeHtml(name)}"></span>` : `<textarea name="${escapeHtml(name)}" hidden data-arn-multi-value>${escapeHtml(values.join("\n"))}</textarea>`;
  return `<div class="arn-multi-control" data-arn-multi><div class="arn-token-list" data-arn-tokens>${values.map(value => `<span class="arn-token">${escapeHtml(value)}<button type="button" aria-label="Remove ${escapeHtml(value)}">×</button></span>`).join("")}</div>${picker}${storage}<span class="field-error" data-arn-multi-error hidden></span></div>`;
}

export function arnMultiComboboxField(label, { name, values = [], ...options }, hint = "") {
  const control = arnMultiComboboxControl({ name, values, ...options, suggestionLabel: label });
  const id = control.match(/<input id="([^"]+)"/)?.[1];
  return `<div class="field arn-multi"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</div>`;
}

function upgradeMultiField(field, textarea) {
  const values = textarea.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const label = field.querySelector(":scope > label")?.textContent?.trim() || textarea.name;
  const holder = document.createElement("div");
  holder.innerHTML = arnMultiComboboxControl({ name: textarea.name, values, kinds: inferredKinds(field, textarea), suggestionLabel: label });
  const control = holder.firstElementChild;
  textarea.replaceWith(control);
  const fieldLabel = field.querySelector(":scope > label");
  if (fieldLabel) fieldLabel.htmlFor = control.querySelector(".arn-combobox input").id;
}

function upgradeMultiSelect(field, select) {
  const values = [...select.selectedOptions].map(option => option.value).filter(value => value.startsWith("arn:"));
  const suggestions = [...select.options].filter(option => option.value.startsWith("arn:")).map(option => ({ arn: option.value, name: option.textContent.trim(), kind: kindForArn(option.value) }));
  const label = field.querySelector(":scope > label")?.textContent?.trim() || select.name;
  const holder = document.createElement("div");
  holder.innerHTML = arnMultiComboboxControl({ name: select.name, values, formMode: "multiple", kinds: inferredKinds(field, select), staticSuggestions: suggestions, suggestionLabel: label });
  const control = holder.firstElementChild; select.replaceWith(control); const fieldLabel = field.querySelector(":scope > label"); if (fieldLabel) fieldLabel.htmlFor = control.querySelector(".arn-combobox input").id;
}

export function bindArnMultiComboboxes(root = document) {
  root.querySelectorAll("[data-arn-multi]").forEach(container => {
    if (container.dataset.arnMultiBound) return;
    container.dataset.arnMultiBound = "true";
    const picker = container.querySelector(".arn-combobox"); const input = picker.querySelector("input"); const tokens = container.querySelector("[data-arn-tokens]"); const error = container.querySelector("[data-arn-multi-error]"); const value = container.querySelector("[data-arn-multi-value]");
    const sync = () => {
      const entries = [...tokens.querySelectorAll(".arn-token")].map(token => token.firstChild?.textContent ?? "");
      if (value.dataset.arnMultiMode === "multiple") value.innerHTML = entries.map(entry => `<input type="hidden" name="${escapeHtml(value.dataset.arnName)}" value="${escapeHtml(entry)}">`).join("");
      else value.value = entries.join("\n");
    };
    const add = () => {
      const value = input.value.trim(); if (!value) return;
      const pickerValidation = picker._arnCombobox ? validationMessage(picker._arnCombobox) : "";
      if (pickerValidation) { error.textContent = pickerValidation; error.hidden = false; input.setCustomValidity(pickerValidation); return; }
      input.setCustomValidity("");
      const existing = [...tokens.querySelectorAll(".arn-token")].map(token => token.firstChild?.textContent ?? "");
      if (existing.includes(value)) { error.textContent = "That ARN has already been added."; error.hidden = false; return; }
      const token = document.createElement("span"); token.className = "arn-token"; token.append(document.createTextNode(value));
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${value}`); remove.addEventListener("click", () => { token.remove(); sync(); });
      token.append(remove); tokens.append(token); input.value = ""; error.hidden = true; sync();
    };
    input.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === ",") && picker.dataset.open !== "true") { event.preventDefault(); add(); } });
    input.addEventListener("change", add);
    input.addEventListener("blur", () => setTimeout(add, 0));
    input.addEventListener("paste", event => { const rows = event.clipboardData?.getData("text").split(/\r?\n/).map(item => item.trim()).filter(Boolean) ?? []; if (rows.length > 1) { event.preventDefault(); for (const row of rows) { input.value = row; add(); } } });
    tokens.querySelectorAll("button").forEach(button => button.addEventListener("click", () => { button.closest(".arn-token").remove(); sync(); }));
    sync();
  });
}
