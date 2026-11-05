const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

export function cloudFormationOrigin(tags = []) {
  const values = Object.fromEntries(tags.map(tag => [tag.key, tag.value]));
  const stackId = values["aws:cloudformation:stack-id"];
  const match = typeof stackId === "string" && stackId.match(/^arn:[^:]+:cloudformation:[^:]+:\d{12}:stack\/([^/]+)\/[^/]+$/);
  const logicalId = values["aws:cloudformation:logical-id"];
  if (!match || typeof logicalId !== "string" || !logicalId) return null;
  return { stackId, stackName: match[1], logicalId, href: `#/cloudformation/stacks/${encodeURIComponent(stackId)}/resources` };
}

export function executionRoleLink(roleArn) {
  const match = typeof roleArn === "string" && roleArn.match(/^arn:[^:]+:iam::\d{12}:role\/(?:[^/]+\/)*([^/]+)$/);
  return match ? `#/iam/roles/${encodeURIComponent(match[1])}` : null;
}

export function parseStateMachineDefinition(definition) {
  try {
    const parsed = typeof definition === "string" ? JSON.parse(definition) : definition;
    return parsed && typeof parsed === "object" && parsed.States && typeof parsed.States === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function processor(state) {
  if (state.Type !== "Map") return null;
  const value = state.ItemProcessor ?? state.Iterator;
  if (!value || typeof value !== "object") return null;
  const copy = { ...value };
  delete copy.ProcessorConfig;
  return copy;
}

export function definitionScopes(definition) {
  const root = parseStateMachineDefinition(definition);
  if (!root) return [];
  const scopes = [];
  const visit = (value, path, label, kind = "ROOT", slot) => {
    const states = Object.entries(value.States ?? {}).map(([name, state]) => ({ name, state, path: `${path}.States.${name}` }));
    scopes.push({ path, label, kind, slot, startAt: value.StartAt, states });
    for (const { name, state } of states) {
      if (state.Type === "Parallel") (state.Branches ?? []).forEach((branch, index) => visit(branch, `${path}.States.${name}.Branches[${index}]`, `${name} · branch ${index + 1}`, "PARALLEL", index));
      const itemProcessor = processor(state);
      if (itemProcessor) visit(itemProcessor, `${path}.States.${name}.ItemProcessor`, `${name} · item processor`, "MAP", undefined);
    }
  };
  visit(root, "$", "Main workflow");
  return scopes;
}

function lambdaFunctionName(resource) {
  if (typeof resource !== "string") return null;
  const match = resource.match(/^arn:[^:]+:lambda:[^:]+:[^:]+:function:([^:]+)(?::.*)?$/);
  return match?.[1] ?? null;
}

export function lambdaReferences(definition) {
  const references = [];
  for (const scope of definitionScopes(definition)) for (const item of scope.states) {
    if (item.state.Type !== "Task") continue;
    const optimized = /^arn:aws:states:::lambda:invoke(?:\.waitForTaskToken)?$/.test(item.state.Resource);
    const target = optimized ? item.state.Parameters?.FunctionName : item.state.Resource;
    const name = lambdaFunctionName(target) ?? (optimized && typeof target === "string" && !target.startsWith("$") ? target.split(":")[0] : null);
    if (name) references.push({ name, resource: target, stateName: item.name, scope: scope.label });
  }
  return references.filter((item, index) => references.findIndex(candidate => candidate.name === item.name && candidate.stateName === item.stateName && candidate.scope === item.scope) === index);
}

export function integrationReferences(definition) {
  const references = [];
  for (const scope of definitionScopes(definition)) for (const item of scope.states) {
    if (item.state.Type !== "Task" || typeof item.state.Resource !== "string") continue;
    const resource = item.state.Resource;
    let service = null; let target = null; let href = null;
    if (resource.startsWith("arn:aws:states:::dynamodb:")) { service = "DynamoDB"; target = item.state.Parameters?.TableName; if (typeof target === "string") href = `#/dynamodb/tables/${encodeURIComponent(target)}`; }
    else if (resource.startsWith("arn:aws:states:::sqs:")) { service = "SQS"; target = item.state.Parameters?.QueueUrl; const name = typeof target === "string" && target.match(/^https?:\/\/[^/]+\/(?:[^/]+\/)*([^/?#]+)$/)?.[1]; href = name ? `#/sqs/queues/${encodeURIComponent(name)}/details` : "#/sqs/queues"; }
    else if (resource.startsWith("arn:aws:states:::sns:")) { service = "SNS"; target = item.state.Parameters?.TopicArn; const name = typeof target === "string" && target.match(/^arn:[^:]+:sns:[^:]+:\d{12}:([^:]+)$/)?.[1]; href = name ? `#/sns/topics/${encodeURIComponent(name)}` : "#/sns/topics"; }
    else if (resource === "arn:aws:states:::events:putEvents") { service = "EventBridge"; const entries = item.state.Parameters?.Entries; const names = Array.isArray(entries) ? [...new Set(entries.map(entry => entry.EventBusName ?? (entry["EventBusName.$"] ? null : "default")))] : []; target = names.length === 1 ? names[0] : "Event buses"; const name = typeof target === "string" && names.length === 1 ? target.replace(/^arn:[^:]+:events:[^:]+:\d{12}:event-bus\//, "") : null; href = name ? `#/eventbridge/event-buses/${encodeURIComponent(name)}` : "#/eventbridge/event-buses"; }
    else if (resource.startsWith("arn:aws:states:::states:startExecution")) { service = "Step Functions"; target = item.state.Parameters?.StateMachineArn; if (typeof target === "string") href = `#/step-functions/state-machines/${encodeURIComponent(target)}`; }
    else if (/^arn:aws:states:[^:]+:[^:]+:activity:/.test(resource)) { service = "Activity"; target = resource; href = `#/step-functions/activities/${encodeURIComponent(resource)}`; }
    if (service) references.push({ service, target, href, resource, stateName: item.name, scope: scope.label, callback: resource.endsWith(".waitForTaskToken"), sync: resource.endsWith(".sync") });
  }
  return references;
}

export function eventDetails(event) {
  const entry = Object.entries(event ?? {}).find(([key, value]) => key.endsWith("EventDetails") && value && typeof value === "object" && !Array.isArray(value));
  return entry ? { key: entry[0], value: entry[1] } : { key: null, value: {} };
}

const sensitiveKey = /(?:authorization|credential|password|private.?key|response.?url|secret|session.?key|token|access.?key)/i;
const executionArn = /^arn:[^:]+:states:[^:]+:\d{12}:execution:[^:]+:.+$/;

function redactSensitiveText(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer <redacted>")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted access key>")
    .replace(/__stacksim_task_token_ref_[A-Za-z0-9_-]+__/g, "<redacted task token>");
}

export function redactSensitiveValue(value, key = "") {
  if (sensitiveKey.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSensitiveValue(item, name)]));
  if (typeof value !== "string") return value;
  const text = redactSensitiveText(value);
  if (!/^[\[{]/.test(text.trim())) return text;
  try { return JSON.stringify(redactSensitiveValue(JSON.parse(text))); } catch { return text; }
}

function childExecutionReferences(history) {
  const references = [];
  const inspect = (value, item, key = "") => {
    if (typeof value === "string") {
      if ((key === "ExecutionArn" || key === "executionArn") && executionArn.test(value)) references.push({ executionArn: value, eventId: item.event.id, stateName: item.stateName });
      else if (/^[\[{]/.test(value.trim())) { try { inspect(JSON.parse(value), item); } catch { /* Non-JSON output is valid. */ } }
      return;
    }
    if (Array.isArray(value)) { for (const child of value) inspect(child, item); return; }
    if (value && typeof value === "object") for (const [name, child] of Object.entries(value)) inspect(child, item, name);
  };
  for (const item of history.events) inspect(item.details.output, item, "output");
  return references.filter((item, index) => references.findIndex(candidate => candidate.executionArn === item.executionArn) === index);
}

function linkedStateName(event, byId) {
  let candidate = event;
  const visited = new Set();
  while (candidate && !visited.has(candidate.id)) {
    visited.add(candidate.id);
    const details = eventDetails(candidate).value;
    if (typeof details.name === "string") return details.name;
    candidate = byId.get(candidate.previousEventId);
  }
  return null;
}

export function historyPresentation(events, status) {
  const ordered = [...(events ?? [])].sort((left, right) => Number(left.id) - Number(right.id));
  const byId = new Map(ordered.map(event => [event.id, event]));
  const activeEntries = [];
  const attempts = new Map();
  const decorated = ordered.map(event => {
    const details = eventDetails(event);
    const stateName = typeof details.value.name === "string" ? details.value.name : linkedStateName(event, byId);
    if (/StateEntered$/.test(event.type) && stateName) activeEntries.push({ stateName, eventId: event.id, type: event.type });
    if (/StateExited$/.test(event.type) && stateName) {
      const index = activeEntries.map(item => item.stateName).lastIndexOf(stateName);
      if (index >= 0) activeEntries.splice(index, 1);
    }
    let attempt;
    if (/StateEntered$/.test(event.type) && stateName) {
      attempt = (attempts.get(stateName) ?? 0) + 1;
      attempts.set(stateName, attempt);
    }
    return { event, detailsKey: details.key, details: details.value, stateName, attempt };
  });
  return { events: decorated, active: status === "RUNNING" ? activeEntries.at(-1) ?? null : null };
}

export function executionPresentation(definition, events, status) {
  const scopes = definitionScopes(definition);
  const history = historyPresentation(events, status);
  if (history.active) {
    const activeState = scopes.flatMap(scope => scope.states).find(item => item.name === history.active.stateName)?.state;
    const callbackScheduled = history.events.some(item => item.stateName === history.active.stateName && /^(?:Task|LambdaFunction)Scheduled$/.test(item.event.type) && typeof item.details.resource === "string" && item.details.resource.endsWith(".waitForTaskToken"));
    history.active.waitingForCallback = activeState?.Type === "Task" && typeof activeState.Resource === "string" && activeState.Resource.endsWith(".waitForTaskToken") && callbackScheduled;
  }
  const retries = history.events.filter(item => /^(?:Task|LambdaFunction|Activity)Failed$/.test(item.event.type)).map((item, index) => ({ ...item, retryNumber: index + 1, error: item.details.error, cause: redactSensitiveValue(item.details.cause) }));
  const failures = history.events.filter(item => item.details.error || /(?:Failed|TimedOut|Aborted)$/.test(item.event.type)).map(item => ({ ...item, error: item.details.error, cause: redactSensitiveValue(item.details.cause) }));
  const iterations = new Map();
  for (const item of history.events) {
    const match = item.event.type.match(/^MapIteration(Started|Succeeded|Failed|Aborted)$/);
    const index = item.details.index;
    if (!match || !Number.isInteger(index)) continue;
    const prior = iterations.get(index) ?? { index, name: item.details.name, status: "RUNNING", eventIds: [] };
    prior.status = match[1] === "Started" ? prior.status : match[1].toUpperCase();
    prior.eventIds.push(item.event.id);
    iterations.set(index, prior);
  }
  return { scopes, history, retries, failures, childExecutions: childExecutionReferences(history), iterations: [...iterations.values()].sort((left, right) => left.index - right.index) };
}

export function payloadField(details, name) {
  if (own(details, name)) return { state: "present", value: details[name] };
  if (own(details, `${name}Details`)) return { state: "omitted", value: undefined };
  return { state: "absent", value: undefined };
}

export const STUDIO_STATE_TYPES = [
  { type: "Pass", label: "Pass", hint: "Transform or inject fixed data", glyph: "→" },
  { type: "Task", label: "Task", hint: "Call Lambda or a supported integration", glyph: "λ" },
  { type: "Choice", label: "Choice", hint: "Branch on input values", glyph: "?" },
  { type: "Wait", label: "Wait", hint: "Delay for a fixed duration", glyph: "◷" },
  { type: "Parallel", label: "Parallel", hint: "Run branches concurrently", glyph: "∥" },
  { type: "Map", label: "Map", hint: "Iterate an array inline", glyph: "▦" },
  { type: "Succeed", label: "Success", hint: "End the workflow successfully", glyph: "✓" },
  { type: "Fail", label: "Fail", hint: "Fail with an error and cause", glyph: "✕" },
];

export function defaultStateForType(type) {
  switch (type) {
    case "Pass": return { Type: "Pass", Result: {}, End: true };
    case "Task": return { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: "", "Payload.$": "$" }, End: true };
    case "Choice": return { Type: "Choice", Choices: [{ Variable: "$.status", StringEquals: "ok", Next: "Done" }], Default: "Done" };
    case "Wait": return { Type: "Wait", Seconds: 5, End: true };
    case "Parallel": return { Type: "Parallel", Branches: [{ StartAt: "BranchPass", States: { BranchPass: { Type: "Pass", End: true } } }], End: true };
    case "Map": return { Type: "Map", ItemsPath: "$", ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "MapPass", States: { MapPass: { Type: "Pass", End: true } } }, End: true };
    case "Succeed": return { Type: "Succeed" };
    case "Fail": return { Type: "Fail", Error: "States.TaskFailed", Cause: "Workflow failed" };
    default: throw new Error(`Unsupported studio state type '${type}'`);
  }
}

export function uniqueStateName(states, preferred = "State") {
  const base = String(preferred || "State").trim().slice(0, 76) || "State";
  if (!own(states, base)) return base;
  let index = 2;
  while (own(states, `${base}${index}`)) index++;
  return `${base}${index}`;
}

function rewriteTransition(value, from, to) {
  if (value === from) return to;
  return value;
}

function rewriteStateReferences(definition, from, to) {
  if (definition.StartAt === from) definition.StartAt = to;
  for (const state of Object.values(definition.States ?? {})) {
    if (state.Next !== undefined) state.Next = rewriteTransition(state.Next, from, to);
    if (state.Default !== undefined) state.Default = rewriteTransition(state.Default, from, to);
    if (Array.isArray(state.Choices)) for (const rule of state.Choices) if (rule.Next !== undefined) rule.Next = rewriteTransition(rule.Next, from, to);
    if (Array.isArray(state.Catch)) for (const rule of state.Catch) if (rule.Next !== undefined) rule.Next = rewriteTransition(rule.Next, from, to);
  }
}

function clearTerminal(state) {
  delete state.End;
}

function makeTerminal(state) {
  if (["Succeed", "Fail", "Choice"].includes(state.Type)) {
    delete state.Next;
    delete state.End;
    return;
  }
  delete state.Next;
  state.End = true;
}

function choiceTargets(states, choiceName, forward) {
  // A new Choice must not loop back to the state that leads into it. Use the
  // state that already followed, or add a terminal Success state to branch to.
  if (forward && forward !== choiceName && states[forward]) return forward;
  const terminal = uniqueStateName(states, "Success");
  states[terminal] = defaultStateForType("Succeed");
  return terminal;
}

export function addStudioState(definition, type, { afterName, preferredName, state: suppliedState } = {}) {
  const root = parseStateMachineDefinition(definition);
  if (!root) throw new Error("The definition could not be parsed.");
  const next = structuredClone(root);
  next.States ??= {};
  const meta = STUDIO_STATE_TYPES.find(item => item.type === type);
  if (!meta) throw new Error(`Unsupported studio state type '${type}'`);
  const name = uniqueStateName(next.States, preferredName ?? meta.type);
  const state = suppliedState ? structuredClone(suppliedState) : defaultStateForType(type);
  next.States[name] = state;
  if (!next.StartAt) next.StartAt = name;
  const after = afterName && next.States[afterName] ? afterName : null;
  let forward;
  if (after) {
    const prior = next.States[after];
    if (prior.Type === "Choice") {
      // Adding after a Choice makes the new state a branch target so it is reachable.
      if (!prior.Default) prior.Default = name;
      else prior.Choices = [...(prior.Choices ?? []), { Variable: "$.choice", StringEquals: name, Next: name }];
    } else if (!["Succeed", "Fail"].includes(prior.Type)) {
      forward = prior.Next;
      clearTerminal(prior);
      prior.Next = name;
      if (forward && !["Succeed", "Fail", "Choice"].includes(state.Type)) {
        clearTerminal(state);
        state.Next = forward;
        delete state.End;
      }
    }
  }
  if (type === "Choice" && !suppliedState) {
    const target = choiceTargets(next.States, name, forward);
    state.Choices = [{ Variable: "$.status", StringEquals: "ok", Next: target }];
    state.Default = target;
  }
  return { definition: next, name };
}

export function removeStudioState(definition, name) {
  const root = parseStateMachineDefinition(definition);
  if (!root?.States?.[name]) throw new Error(`State '${name}' was not found.`);
  const next = structuredClone(root);
  const removed = next.States[name];
  const fallback = removed.Next && removed.Next !== name ? removed.Next : Object.keys(next.States).find(item => item !== name);
  delete next.States[name];
  if (next.StartAt === name) next.StartAt = fallback;
  rewriteStateReferences(next, name, fallback);
  for (const state of Object.values(next.States)) {
    if (state.Next === undefined && !["Succeed", "Fail", "Choice"].includes(state.Type)) makeTerminal(state);
    if (Array.isArray(state.Choices)) state.Choices = state.Choices.filter(rule => rule.Next && next.States[rule.Next]);
    if (state.Default && !next.States[state.Default]) delete state.Default;
    if (Array.isArray(state.Catch)) state.Catch = state.Catch.filter(rule => rule.Next && next.States[rule.Next]);
  }
  if (!Object.keys(next.States).length) {
    next.StartAt = "Hello";
    next.States = { Hello: defaultStateForType("Pass") };
  } else if (!next.StartAt || !next.States[next.StartAt]) next.StartAt = Object.keys(next.States)[0];
  return next;
}

export function renameStudioState(definition, from, to) {
  const root = parseStateMachineDefinition(definition);
  if (!root?.States?.[from]) throw new Error(`State '${from}' was not found.`);
  const target = String(to || "").trim();
  const problem = stateNameProblem(target);
  if (problem) throw new Error(problem);
  if (from === target) return structuredClone(root);
  if (own(root.States, target)) throw new Error(`State '${target}' already exists.`);
  const next = structuredClone(root);
  next.States[target] = next.States[from];
  delete next.States[from];
  rewriteStateReferences(next, from, target);
  return next;
}

export function updateStudioState(definition, name, patch = {}) {
  const root = parseStateMachineDefinition(definition);
  if (!root?.States?.[name]) throw new Error(`State '${name}' was not found.`);
  const next = structuredClone(root);
  const state = next.States[name];
  Object.assign(state, patch);
  if (patch.End === true) {
    delete state.Next;
    state.End = true;
  }
  if (typeof patch.Next === "string" && patch.Next) {
    delete state.End;
    state.Next = patch.Next;
  }
  if (["Succeed", "Fail"].includes(state.Type)) {
    delete state.Next;
    delete state.End;
  }
  if (state.Type === "Choice") {
    delete state.Next;
    delete state.End;
  }
  return next;
}

export function setStudioStartAt(definition, name) {
  const root = parseStateMachineDefinition(definition);
  if (!root?.States?.[name]) throw new Error(`State '${name}' was not found.`);
  const next = structuredClone(root);
  next.StartAt = name;
  return next;
}

export function studioFlow(definition) {
  const root = parseStateMachineDefinition(definition);
  if (!root) return { startAt: null, nodes: [], edges: [], orphans: [] };
  const names = Object.keys(root.States ?? {});
  const edges = [];
  const seen = new Set();
  const queue = root.StartAt && root.States?.[root.StartAt] ? [root.StartAt] : [];
  while (queue.length) {
    const name = queue.shift();
    if (!name || seen.has(name) || !root.States[name]) continue;
    seen.add(name);
    const state = root.States[name];
    const push = (to, label) => {
      if (!to) return;
      edges.push({ from: name, to, label });
      if (!seen.has(to)) queue.push(to);
    };
    if (state.Type === "Choice") {
      (state.Choices ?? []).forEach((rule, index) => {
        const condition = rule.StringEquals ?? rule.NumericEquals ?? rule.BooleanEquals ?? rule.IsPresent ?? rule.IsNull ?? rule.IsString ?? rule.IsNumeric ?? rule.IsBoolean ?? rule.IsTimestamp;
        const label = condition !== undefined && condition !== null ? String(condition) : `Rule ${index + 1}`;
        push(rule.Next, label);
      });
      push(state.Default, "Default");
    } else if (state.Type === "Parallel") {
      push(state.Next, state.End ? undefined : "Next");
      for (const rule of state.Catch ?? []) push(rule.Next, "Catch");
      (state.Branches ?? []).forEach((branch, index) => {
        if (branch?.StartAt) edges.push({ from: name, to: branch.StartAt, label: `Branch ${index + 1}`, kind: "parallel-branch" });
      });
    } else {
      push(state.Next, state.End ? undefined : "Next");
      for (const rule of state.Catch ?? []) push(rule.Next, "Catch");
    }
  }
  const orphans = names.filter(name => !seen.has(name));
  const nodes = [...seen, ...orphans].map(name => {
    const state = root.States[name];
    return {
      name,
      type: state.Type,
      start: name === root.StartAt,
      end: Boolean(state.End) || ["Succeed", "Fail"].includes(state.Type),
      summary: state.Resource ?? (state.Seconds !== undefined ? `${state.Seconds}s` : state.Error ?? state.Comment ?? (state.Type === "Parallel" ? `${(state.Branches ?? []).length} branches` : state.Type === "Map" ? "Inline Map" : state.Type === "Choice" ? `${(state.Choices ?? []).length} rules` : "")),
      state,
    };
  });
  return { startAt: root.StartAt ?? null, nodes, edges, orphans };
}

// ---------------------------------------------------------------------------
// Names

const FORBIDDEN_NAME_CHARACTERS = /[\s<>{}\[\]?*"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f]/;

/** Returns a message when a state machine, execution or activity name breaks the AWS naming rules. */
export function resourceNameProblem(name, label = "Name") {
  const value = String(name ?? "");
  if (!value) return `${label} is required.`;
  if ([...value].length > 80) return `${label} must not exceed 80 characters.`;
  if (FORBIDDEN_NAME_CHARACTERS.test(value)) return `${label} must not contain white space, brackets < > { } [ ], wildcards ? *, or the special characters " # % \\ ^ | ~ \` $ & , ; : /.`;
  return null;
}

/** State names may be any string up to 80 characters, unique within the state machine. */
export function stateNameProblem(name) {
  const value = String(name ?? "");
  if (!value.trim()) return "State name is required.";
  if ([...value].length > 80) return "State names must not exceed 80 characters.";
  return null;
}

// ---------------------------------------------------------------------------
// Time

/** The Step Functions API returns epoch seconds; the browser clock uses milliseconds. */
export function epochMilliseconds(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function formatElapsed(milliseconds) {
  if (milliseconds === undefined || milliseconds === null || Number.isNaN(milliseconds)) return "–";
  const total = Math.max(0, Math.round(milliseconds));
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total % 3_600_000 / 60_000))}:${pad(Math.floor(total % 60_000 / 1000))}.${pad(total % 1000, 3)}`;
}

export function formatDuration(start, stop, now = Date.now()) {
  const from = epochMilliseconds(start);
  if (from === undefined) return "–";
  const to = epochMilliseconds(stop) ?? now;
  return formatElapsed(to - from);
}

export function formatTimestamp(value) {
  const milliseconds = epochMilliseconds(value);
  if (milliseconds === undefined) return "–";
  const date = new Date(milliseconds);
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  return `${day}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// ---------------------------------------------------------------------------
// Display labels

const STATUS_LABELS = {
  RUNNING: "Running", SUCCEEDED: "Succeeded", FAILED: "Failed", TIMED_OUT: "Timed out", ABORTED: "Aborted", PENDING_REDRIVE: "Pending redrive",
  ACTIVE: "Active", DELETING: "Deleting", STANDARD: "Standard", EXPRESS: "Express",
  NOT_STARTED: "Not started", IN_PROGRESS: "In progress", CAUGHT_ERROR: "Caught error", CANCELLED: "Cancelled",
};

export function displayLabel(value) {
  if (value === undefined || value === null || value === "") return "Unknown";
  return STATUS_LABELS[value] ?? String(value);
}

export function statusVariant(value) {
  if (["FAILED", "TIMED_OUT", "ABORTED"].includes(value)) return "error";
  if (["RUNNING", "IN_PROGRESS", "PENDING_REDRIVE", "DELETING", "CAUGHT_ERROR"].includes(value)) return "pending";
  if (["SUCCEEDED", "ACTIVE"].includes(value)) return "success";
  return "inactive";
}

// ---------------------------------------------------------------------------
// Per-state execution results

const TASK_FAILURE_EVENT = /^(?:Task|LambdaFunction|Activity)(?:Failed|TimedOut|ScheduleFailed|StartFailed|SubmitFailed)$|^(?:Parallel|Map)StateFailed$|^MapIterationFailed$/;
const TASK_SUCCESS_EVENT = /^(?:Task|LambdaFunction|Activity)(?:Succeeded|SubmitSucceeded)$|^(?:Parallel|Map)StateSucceeded$/;

export function stateResourceLabel(state) {
  if (!state || state.Type !== "Task" || typeof state.Resource !== "string") return "";
  const optimized = state.Resource.match(/^arn:aws:states:::([a-z0-9-]+):([A-Za-z0-9]+)(\.[A-Za-z0-9:]+)?$/);
  if (optimized) return `${optimized[1]}:${optimized[2]}${optimized[3] ?? ""}`;
  const lambda = lambdaFunctionName(state.Resource);
  if (lambda) return `lambda:${lambda}`;
  const activity = state.Resource.match(/:activity:(.+)$/);
  if (activity) return `activity:${activity[1]}`;
  return state.Resource;
}

/**
 * Summarizes what the history says about every state: its status, each visit's
 * input and output, timing, and the events that belong to it.
 */
export function stateResults(model, execution = {}) {
  const startedAt = epochMilliseconds(execution.startDate);
  const stoppedAt = epochMilliseconds(execution.stopDate);
  const executionStatus = execution.status;
  const results = new Map();
  for (const scope of model.scopes) for (const item of scope.states) {
    results.set(item.name, { name: item.name, type: item.state.Type, state: item.state, scopePath: scope.path, scopeLabel: scope.label, resource: stateResourceLabel(item.state), events: [], visits: [], status: "NOT_STARTED", waitingForCallback: false });
  }
  for (const item of model.history.events) {
    const result = results.get(item.stateName);
    if (!result) continue;
    result.events.push(item);
    const type = item.event.type;
    const at = epochMilliseconds(item.event.timestamp);
    if (/StateEntered$/.test(type)) result.visits.push({ enteredId: item.event.id, enteredAt: at, input: payloadField(item.details, "input"), output: { state: "absent", value: undefined }, exitedAt: undefined, lastOutcome: null });
    const visit = result.visits.at(-1);
    if (!visit) continue;
    if (/StateExited$/.test(type)) { visit.exitedAt = at; visit.exitedId = item.event.id; visit.output = payloadField(item.details, "output"); }
    if (TASK_FAILURE_EVENT.test(type)) { visit.lastOutcome = "failure"; visit.error = item.details.error; visit.cause = item.details.cause; }
    else if (TASK_SUCCESS_EVENT.test(type)) visit.lastOutcome = "success";
  }
  for (const result of results.values()) {
    const visit = result.visits.at(-1);
    if (!visit) continue;
    // A Fail state always fails the execution, whatever exit event the history carries.
    if (result.type === "Fail") result.status = "FAILED";
    else if (visit.exitedAt !== undefined) result.status = visit.lastOutcome === "failure" ? "CAUGHT_ERROR" : "SUCCEEDED";
    else if (executionStatus === "RUNNING") result.status = "IN_PROGRESS";
    else if (executionStatus === "ABORTED") result.status = "CANCELLED";
    else if (executionStatus === "SUCCEEDED") result.status = "SUCCEEDED";
    else result.status = "FAILED";
    result.startedAfter = startedAt !== undefined && visit.enteredAt !== undefined ? visit.enteredAt - startedAt : undefined;
    const finished = visit.exitedAt ?? (executionStatus === "RUNNING" ? undefined : stoppedAt);
    result.duration = visit.enteredAt !== undefined && finished !== undefined ? finished - visit.enteredAt : undefined;
    result.error = visit.error; result.cause = visit.cause;
  }
  if (model.history.active?.waitingForCallback) {
    const active = results.get(model.history.active.stateName);
    if (active) active.waitingForCallback = true;
  }
  return results;
}

export function stateTransitionCount(model) {
  return model.history.events.filter(item => /StateEntered$/.test(item.event.type)).length;
}

// ---------------------------------------------------------------------------
// Workflow Studio catalog

const lambdaInvoke = () => ({ Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: "", "Payload.$": "$" }, OutputPath: "$.Payload", End: true });

/** Task actions the simulator can run, shown on the Actions tab of the states browser. */
export const STUDIO_ACTIONS = [
  { id: "task", group: "General", label: "Task", name: "Task", hint: "Any supported Task resource", glyph: "λ", state: () => defaultStateForType("Task") },
  { id: "lambda-invoke", group: "AWS Lambda", label: "AWS Lambda Invoke", name: "Lambda Invoke", hint: "Invoke a Lambda function", glyph: "λ", state: lambdaInvoke },
  { id: "dynamodb-get", group: "Amazon DynamoDB", label: "DynamoDB GetItem", name: "DynamoDB GetItem", hint: "Read one item", glyph: "D", state: () => ({ Type: "Task", Resource: "arn:aws:states:::dynamodb:getItem", Parameters: { TableName: "", Key: { id: { "S.$": "$.id" } } }, End: true }) },
  { id: "dynamodb-put", group: "Amazon DynamoDB", label: "DynamoDB PutItem", name: "DynamoDB PutItem", hint: "Write one item", glyph: "D", state: () => ({ Type: "Task", Resource: "arn:aws:states:::dynamodb:putItem", Parameters: { TableName: "", Item: { id: { "S.$": "$.id" } } }, End: true }) },
  { id: "dynamodb-update", group: "Amazon DynamoDB", label: "DynamoDB UpdateItem", name: "DynamoDB UpdateItem", hint: "Update attributes of one item", glyph: "D", state: () => ({ Type: "Task", Resource: "arn:aws:states:::dynamodb:updateItem", Parameters: { TableName: "", Key: { id: { "S.$": "$.id" } }, UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": { S: "done" } } }, End: true }) },
  { id: "dynamodb-delete", group: "Amazon DynamoDB", label: "DynamoDB DeleteItem", name: "DynamoDB DeleteItem", hint: "Delete one item", glyph: "D", state: () => ({ Type: "Task", Resource: "arn:aws:states:::dynamodb:deleteItem", Parameters: { TableName: "", Key: { id: { "S.$": "$.id" } } }, End: true }) },
  { id: "sqs-send", group: "Amazon SQS", label: "SQS SendMessage", name: "SQS SendMessage", hint: "Send a message to a queue", glyph: "Q", state: () => ({ Type: "Task", Resource: "arn:aws:states:::sqs:sendMessage", Parameters: { QueueUrl: "", "MessageBody.$": "States.JsonToString($)" }, End: true }) },
  { id: "sns-publish", group: "Amazon SNS", label: "SNS Publish", name: "SNS Publish", hint: "Publish a message to a topic", glyph: "N", state: () => ({ Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: "", "Message.$": "States.JsonToString($)" }, End: true }) },
  { id: "events-put", group: "Amazon EventBridge", label: "EventBridge PutEvents", name: "EventBridge PutEvents", hint: "Send custom events to a bus", glyph: "E", state: () => ({ Type: "Task", Resource: "arn:aws:states:::events:putEvents", Parameters: { Entries: [{ Source: "my.application", DetailType: "MyDetailType", EventBusName: "default", "Detail.$": "States.JsonToString($)" }] }, End: true }) },
  { id: "states-start", group: "AWS Step Functions", label: "Step Functions StartExecution", name: "Step Functions StartExecution", hint: "Start another state machine", glyph: "S", state: () => ({ Type: "Task", Resource: "arn:aws:states:::states:startExecution", Parameters: { StateMachineArn: "", "Input.$": "$" }, End: true }) },
  { id: "activity", group: "AWS Step Functions", label: "Step Functions Run Activity", name: "Run Activity", hint: "Wait for an Activity worker", glyph: "A", state: () => ({ Type: "Task", Resource: "", TimeoutSeconds: 300, End: true }) },
];

export const STUDIO_FLOW_TYPES = ["Choice", "Parallel", "Map", "Pass", "Wait", "Succeed", "Fail"].map(type => STUDIO_STATE_TYPES.find(item => item.type === type));

export const BLANK_DEFINITION = { Comment: "A description of my state machine", StartAt: "Hello", States: { Hello: { Type: "Pass", Result: { message: "hello" }, End: true } } };

export const HELLO_WORLD_DEFINITION = {
  Comment: "A Hello World example that demonstrates Pass, Choice, Wait, Parallel, Success and Fail states",
  StartAt: "Pass",
  States: {
    Pass: { Type: "Pass", Next: "Hello World example?", Comment: "A Pass state passes its input to its output, without performing work." },
    "Hello World example?": { Comment: "A Choice state adds branching logic to a state machine.", Type: "Choice", Choices: [{ Variable: "$.IsHelloWorldExample", BooleanEquals: true, Next: "Yes" }, { Variable: "$.IsHelloWorldExample", BooleanEquals: false, Next: "No" }], Default: "Yes" },
    Yes: { Type: "Pass", Next: "Wait 3 sec" },
    No: { Type: "Fail", Cause: "Not Hello World" },
    "Wait 3 sec": { Comment: "A Wait state delays the state machine from continuing for a specified time.", Type: "Wait", Seconds: 3, Next: "Parallel State" },
    "Parallel State": { Comment: "A Parallel state can be used to create parallel branches of execution in your state machine.", Type: "Parallel", Next: "Hello World", Branches: [{ StartAt: "Hello", States: { Hello: { Type: "Pass", End: true } } }, { StartAt: "World", States: { World: { Type: "Pass", End: true } } }] },
    "Hello World": { Type: "Pass", End: true },
  },
};

export const HELLO_WORLD_INPUT = { IsHelloWorldExample: true };

// ---------------------------------------------------------------------------
// Execution role generated by "Create new role"

/** Least-privilege statements for the Task resources a definition names. */
export function executionRoleStatements(definition) {
  const grants = new Map();
  const grant = (actions, resource) => {
    const key = actions.join(",");
    const resources = grants.get(key) ?? new Set();
    resources.add(resource);
    grants.set(key, resources);
  };
  const literal = value => typeof value === "string" && value !== "" && !value.startsWith("$");
  const functionArn = value => value.replace(/^(arn:[^:]+:lambda:[^:]*:[^:]*:function:[^:]+).*$/, "$1");
  for (const scope of definitionScopes(definition)) for (const { state } of scope.states) {
    if (state.Type !== "Task" || typeof state.Resource !== "string") continue;
    const resource = state.Resource;
    const parameters = state.Parameters ?? {};
    if (resource.startsWith("arn:aws:states:::lambda:invoke")) {
      const target = parameters.FunctionName;
      if (!literal(target)) grant(["lambda:InvokeFunction"], "*");
      else {
        const arn = target.startsWith("arn:") ? functionArn(target) : `arn:aws:lambda:*:*:function:${target.split(":")[0]}`;
        grant(["lambda:InvokeFunction"], arn);
        grant(["lambda:InvokeFunction"], `${arn}:*`);
      }
    } else if (/^arn:[^:]+:lambda:/.test(resource)) {
      const arn = functionArn(resource);
      grant(["lambda:InvokeFunction"], arn);
      grant(["lambda:InvokeFunction"], `${arn}:*`);
    } else if (resource.startsWith("arn:aws:states:::dynamodb:")) {
      const action = resource.split(":").at(-1);
      grant([`dynamodb:${action[0].toUpperCase()}${action.slice(1)}`], literal(parameters.TableName) ? `arn:aws:dynamodb:*:*:table/${parameters.TableName}` : "*");
    } else if (resource.startsWith("arn:aws:states:::sqs:sendMessage")) {
      const name = literal(parameters.QueueUrl) ? parameters.QueueUrl.match(/\/([^/?#]+)$/)?.[1] : null;
      grant(["sqs:SendMessage"], name ? `arn:aws:sqs:*:*:${name}` : "*");
    } else if (resource.startsWith("arn:aws:states:::sns:publish")) {
      grant(["sns:Publish"], literal(parameters.TopicArn) ? parameters.TopicArn : "*");
    } else if (resource.startsWith("arn:aws:states:::events:putEvents")) {
      grant(["events:PutEvents"], "*");
    } else if (resource.startsWith("arn:aws:states:::states:startExecution")) {
      grant(["states:StartExecution"], literal(parameters.StateMachineArn) ? parameters.StateMachineArn : "*");
      if (/\.sync(?::2)?$/.test(resource)) grant(["states:DescribeExecution", "states:StopExecution"], "*");
    }
  }
  return [...grants].map(([actions, resources]) => ({ Effect: "Allow", Action: actions.split(","), Resource: [...resources] }));
}

export function executionRoleTrustPolicy() {
  return { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] };
}

export function generatedRoleName(machineName, suffix = Math.random().toString(36).slice(2, 11)) {
  const safe = String(machineName ?? "").replace(/[^A-Za-z0-9+=,.@_-]/g, "").slice(0, 36) || "StateMachine";
  return `StepFunctions-${safe}-role-${suffix}`;
}

// ---------------------------------------------------------------------------
// Tags

export function tagsToRows(tags = []) {
  return tags.filter(tag => !String(tag.key).startsWith("aws:")).map(tag => ({ key: tag.key, value: tag.value ?? "" }));
}

/** Validates tag rows and returns { tags } or { problem }. */
export function rowsToTags(rows = []) {
  const tags = [];
  const seen = new Set();
  for (const row of rows) {
    const key = String(row.key ?? "").trim();
    const value = String(row.value ?? "");
    if (!key && !value) continue;
    if (!key) return { problem: "Every tag needs a key." };
    if (key.toLowerCase().startsWith("aws:")) return { problem: "Tag keys must not start with aws:." };
    if ([...key].length > 128) return { problem: "Tag keys must not exceed 128 characters." };
    if ([...value].length > 256) return { problem: "Tag values must not exceed 256 characters." };
    if (seen.has(key)) return { problem: `Tag key '${key}' is used more than once.` };
    seen.add(key);
    tags.push({ key, value });
  }
  if (tags.length > 50) return { problem: "A resource can have at most 50 tags." };
  return { tags };
}

/** The TagResource and UntagResource calls that turn one tag set into another. */
export function tagChanges(current = [], next = []) {
  const before = new Map(tagsToRows(current).map(tag => [tag.key, tag.value]));
  const after = new Map(next.map(tag => [tag.key, tag.value]));
  return {
    changed: next.filter(tag => before.get(tag.key) !== tag.value),
    removed: [...before.keys()].filter(key => !after.has(key)),
  };
}
