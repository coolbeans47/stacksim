const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

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
    const optimized = item.state.Resource === "arn:aws:states:::lambda:invoke";
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
    else if (resource.startsWith("arn:aws:states:::sqs:")) { service = "SQS"; target = item.state.Parameters?.QueueUrl; href = "#/sqs/queues"; }
    else if (resource.startsWith("arn:aws:states:::sns:")) { service = "SNS"; target = item.state.Parameters?.TopicArn; href = "#/sns/topics"; }
    else if (resource === "arn:aws:states:::events:putEvents") { service = "EventBridge"; target = "Event bus"; href = "#/eventbridge/buses"; }
    else if (resource.startsWith("arn:aws:states:::states:startExecution")) { service = "Step Functions"; target = item.state.Parameters?.StateMachineArn; if (typeof target === "string") href = `#/step-functions/state-machines/${encodeURIComponent(target)}`; }
    else if (/^arn:aws:states:[^:]+:[^:]+:activity:/.test(resource)) { service = "Activity"; target = resource; href = "#/step-functions/activities"; }
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
  { type: "Succeed", label: "Succeed", hint: "End the workflow successfully", glyph: "✓" },
  { type: "Fail", label: "Fail", hint: "Fail with an error and cause", glyph: "✕" },
];

export function defaultStateForType(type) {
  switch (type) {
    case "Pass": return { Type: "Pass", Result: {}, End: true };
    case "Task": return { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: "my-function", Payload: { "input.$": "$" } }, End: true };
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
  const base = String(preferred || "State").replace(/[^A-Za-z0-9_]/g, "") || "State";
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

export function addStudioState(definition, type, { afterName, preferredName } = {}) {
  const root = parseStateMachineDefinition(definition);
  if (!root) throw new Error("The definition could not be parsed.");
  const next = structuredClone(root);
  next.States ??= {};
  const meta = STUDIO_STATE_TYPES.find(item => item.type === type);
  if (!meta) throw new Error(`Unsupported studio state type '${type}'`);
  const name = uniqueStateName(next.States, preferredName ?? meta.type);
  const state = defaultStateForType(type);
  next.States[name] = state;
  if (!next.StartAt) next.StartAt = name;
  const after = afterName && next.States[afterName] ? afterName : null;
  if (after) {
    const prior = next.States[after];
    if (!["Succeed", "Fail", "Choice"].includes(prior.Type)) {
      const previousNext = prior.Next;
      clearTerminal(prior);
      prior.Next = name;
      if (previousNext && !["Succeed", "Fail", "Choice"].includes(state.Type)) {
        clearTerminal(state);
        state.Next = previousNext;
        delete state.End;
      }
      if (type === "Choice") {
        const fallback = previousNext && previousNext !== name ? previousNext : Object.keys(next.States).find(item => item !== name) ?? name;
        state.Choices = [{ Variable: "$.status", StringEquals: "ok", Next: fallback }];
        state.Default = fallback;
      }
    } else if (type === "Choice") {
      const fallback = Object.keys(next.States).find(item => item !== name) ?? name;
      state.Choices = [{ Variable: "$.status", StringEquals: "ok", Next: fallback }];
      state.Default = fallback;
    }
  } else if (type === "Choice") {
    const fallback = Object.keys(next.States).find(item => item !== name) ?? name;
    state.Choices = [{ Variable: "$.status", StringEquals: "ok", Next: fallback }];
    state.Default = fallback;
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
  if (!/^[A-Za-z0-9_]+$/.test(target)) throw new Error("State names may contain only letters, numbers, and underscores.");
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
