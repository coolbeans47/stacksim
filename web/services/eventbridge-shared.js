import { events, rest } from "../api-client.js";
import { emptyState, escapeHtml, formatDate } from "../components.js";
import { session as ui } from "../state.js";

export function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object`);
  return parsed;
}

export function parseJson(value, label) {
  try { return JSON.parse(String(value)); }
  catch { throw new Error(`${label} must be valid JSON`); }
}

export function stringMap(value, label) {
  const parsed = parseObject(value, label);
  if (Object.values(parsed).some(item => typeof item !== "string")) throw new Error(`${label} values must be strings`);
  return parsed;
}

export function stringList(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "[]")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new Error(`${label} must be a JSON array of strings`);
  return parsed;
}

export function tagsToMap(tags = []) { return Object.fromEntries(tags.map(tag => [tag.Key, tag.Value])); }

export function tagsFromMap(tags = {}) { return Object.entries(tags).map(([Key, Value]) => ({ Key, Value })); }

export function nameFromArn(arn = "") {
  const value = String(arn);
  for (const marker of [":event-bus/", ":archive/", ":replay/", ":rule/"]) if (value.includes(marker)) return value.split(marker)[1].split("/").at(-1) || value;
  return value.split(":").at(-1) || value;
}

export function functionNameFromArn(arn = "") { return String(arn).split(":function:")[1]?.split(":")[0] ?? nameFromArn(arn); }

export function roleNameFromArn(arn = "") { return String(arn).split("/").at(-1) || String(arn); }

export function schedulerTargetMarkup(arn = "") {
  const value = String(arn);
  if (/^arn:aws:lambda:[^:]+:\d{12}:function:[^:]+(?::[^:]+)?$/.test(value)) return `<a class="mono" href="#/lambda/functions/${encoded(functionNameFromArn(value))}">${escapeHtml(value)}</a>`;
  return `<span class="mono">${escapeHtml(value)}</span>`;
}

export function targetType(target = {}) {
  const arn = String(target.Arn || "");
  if (arn.includes(":sqs:")) return "sqs";
  if (arn.includes(":sns:")) return "sns";
  if (arn.includes(":logs:") && arn.includes(":log-group:")) return "logs";
  if (arn.includes(":execute-api:")) return "apigateway";
  if (arn.includes(":states:") && arn.includes(":stateMachine:")) return "states";
  return "lambda";
}

export function targetTypeLabel(type) { return ({ lambda: "Lambda", sqs: "SQS", sns: "SNS", logs: "CloudWatch Logs", apigateway: "API Gateway", states: "Step Functions" })[type] ?? "Target"; }
export function topicNameFromArn(arn = "") { return String(arn).split(":").at(-1) || String(arn); }

export function queueNameFromArn(arn = "") { return String(arn).split(":").at(-1) || String(arn); }

export function logGroupNameFromArn(arn = "") { return String(arn).split(":log-group:")[1]?.replace(/:\*$/, "") ?? String(arn); }

export function apiIdFromArn(arn = "") { return String(arn).split(":")[5]?.split("/")[0] ?? String(arn); }

export function targetDisplayName(target = {}) {
  const type = targetType(target);
  if (type === "lambda") return functionNameFromArn(target.Arn);
  if (type === "sqs") return queueNameFromArn(target.Arn);
  if (type === "sns") return topicNameFromArn(target.Arn);
  if (type === "logs") return logGroupNameFromArn(target.Arn);
  if (type === "states") return nameFromArn(target.Arn);
  return apiIdFromArn(target.Arn);
}

export function targetHref(target = {}) {
  const type = targetType(target);
  if (type === "lambda") return `#/lambda/functions/${encoded(functionNameFromArn(target.Arn))}`;
  if (type === "sqs") return `#/sqs/queues/${encoded(queueNameFromArn(target.Arn))}/access-policy`;
  if (type === "sns") return `#/sns/topics/${encoded(topicNameFromArn(target.Arn))}`;
  if (type === "logs") return `#/cloudwatch/log-groups/${encoded(logGroupNameFromArn(target.Arn))}/resource-policy`;
  if (type === "states") return `#/step-functions/state-machines/${encoded(target.Arn)}`;
  return `#/apigateway/apis/${encoded(apiIdFromArn(target.Arn))}/policy`;
}

export function stateMarkup(state) { return `<span class="status ${state === "DISABLED" ? "inactive" : ""}">${escapeHtml(state === "DISABLED" ? "Disabled" : "Enabled")}</span>`; }

export function encoded(value) { return encodeURIComponent(value); }

export function busRoot(name) { return `#/eventbridge/event-buses/${encoded(name)}`; }

export function ruleRoot(bus, rule) { return `#/eventbridge/rules/${encoded(bus)}/${encoded(rule)}`; }

export async function listAll(operation, input, resultKey) {
  const collected = [];
  let NextToken;
  do {
    const page = await events(operation, { ...input, Limit: 100, ...(NextToken ? { NextToken } : {}) });
    collected.push(...(page[resultKey] ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return collected;
}

export async function listBuses() { return listAll("ListEventBuses", {}, "EventBuses"); }

export async function listRules(bus) { return listAll("ListRules", { EventBusName: bus }, "Rules"); }

export async function listTargets(bus, rule) { return listAll("ListTargetsByRule", { EventBusName: bus, Rule: rule }, "Targets"); }

export async function listArchives() { return listAll("ListArchives", {}, "Archives"); }

export async function listReplays() { return listAll("ListReplays", {}, "Replays"); }

export async function listTags(arn) {
  if (!arn) return [];
  return (await events("ListTagsForResource", { ResourceARN: arn })).Tags ?? [];
}

export async function deliveryDiagnostics() {
  return rest("/_stacksim/api/eventbridge/deliveries");
}

export function boundedText(value, maximum = 240) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

export function diagnosticTable(deliveries, diagnostics) {
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

export async function lambdaFunctions() {
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

export const defaultPattern = JSON.stringify({ source: ["example.orders"] }, null, 2);

export const defaultSample = JSON.stringify({
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

export function targetInputFields(target = {}) {
  const mode = target.Input !== undefined ? "input" : target.InputPath !== undefined ? "path" : target.InputTransformer ? "transformer" : "matched";
  return `<div class="field"><label>Configure target input</label><select name="inputMode"><option value="matched" ${mode === "matched" ? "selected" : ""}>Matched events</option><option value="path" ${mode === "path" ? "selected" : ""}>Part of the matched event</option><option value="input" ${mode === "input" ? "selected" : ""}>Constant (JSON text)</option><option value="transformer" ${mode === "transformer" ? "selected" : ""}>Input transformer</option></select></div><div class="eventbridge-input-fields" data-input-fields="input" ${mode === "input" ? "" : "hidden"}><div class="field"><label>Specify the constant in JSON</label><textarea name="input">${escapeHtml(target.Input || "{}")}</textarea></div></div><div class="eventbridge-input-fields" data-input-fields="path" ${mode === "path" ? "" : "hidden"}><div class="field"><label>Specify the part of the matched event</label><input name="inputPath" value="${escapeHtml(target.InputPath || "$.detail")}" placeholder="$.detail"></div></div><div class="eventbridge-input-fields" data-input-fields="transformer" ${mode === "transformer" ? "" : "hidden"}><div class="field"><label>Input paths map (JSON object)</label><textarea name="inputPathsMap">${escapeHtml(JSON.stringify(target.InputTransformer?.InputPathsMap ?? { detail: "$.detail" }, null, 2))}</textarea></div><div class="field"><label>Input template</label><textarea name="inputTemplate">${escapeHtml(target.InputTransformer?.InputTemplate || '{"detail":<detail>}')}</textarea><span class="hint">Use &lt;name&gt; placeholders. Transformed Logs targets require exactly a numeric timestamp and string message.</span></div></div><div class="eventbridge-modal-section"><h3>Transformation preview</h3><div class="field"><label>Preview sample event</label><textarea name="targetSampleEvent" class="code-editor">${escapeHtml(defaultSample)}</textarea></div><div class="eventbridge-inline-actions"><button class="button" type="button" data-preview-target-input>Preview target input</button></div><div class="eventbridge-test-result" data-target-input-preview aria-live="polite"></div></div>`;
}

export function bindInputMode(root = document) {
  root.querySelectorAll('select[name="inputMode"]').forEach(select => {
    const update = () => root.querySelectorAll("[data-input-fields]").forEach(section => { section.hidden = section.dataset.inputFields !== select.value; });
    select.addEventListener("change", update);
    update();
  });
}

export function targetArnFromForm(data) {
  return String(data.get("targetType") === "lambda" ? data.get("functionArn") : data.get("targetArn") || "").trim();
}

export function targetFromForm(data, arn = targetArnFromForm(data)) {
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

export function targetPolicyStatement(type, sourceArn, targetArn) {
  const source = sourceArn || "RULE_ARN";
  const resource = targetArn || ({ lambda: "FUNCTION_ARN", sqs: "QUEUE_ARN", sns: "TOPIC_ARN", logs: "LOG_GROUP_ARN:*", apigateway: "EXECUTE_API_ARN", states: "STATE_MACHINE_ARN" })[type];
  const actions = type === "sqs" ? "sqs:SendMessage" : type === "sns" ? "sns:Publish" : type === "logs" ? ["logs:CreateLogStream", "logs:PutLogEvents"] : type === "apigateway" ? "execute-api:Invoke" : type === "states" ? "states:StartExecution" : "lambda:InvokeFunction";
  return { Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: actions, Resource: type === "logs" && targetArn ? `${targetArn}:*` : resource, Condition: { ArnEquals: { "aws:SourceArn": source }, StringEquals: { "aws:SourceAccount": "ACCOUNT_ID" } } };
}

export function targetPolicyGuidance(type, sourceArn, targetArn) {
  const source = `<span class="mono">${escapeHtml(sourceArn || "this rule ARN")}</span>`;
  const template = `<details><summary>Resource-policy statement template</summary><pre class="code-box eventbridge-target-preview">${escapeHtml(JSON.stringify(targetPolicyStatement(type, sourceArn, targetArn), null, 2))}</pre></details>`;
  if (type === "sqs") return `<div class="alert warning" data-policy-guidance="sqs"><strong>Queue permission required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to call <span class="mono">sqs:SendMessage</span> with ${source} and this account as source conditions, or supply a trusted execution role. Cross-account queues require both role and queue policy. <a href="#/sqs/queues">Open queues</a>.${template}</div>`;
  if (type === "sns") return `<div class="alert warning" data-policy-guidance="sns"><strong>Topic permission required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to call <span class="mono">sns:Publish</span> on the topic with ${source} as the source condition, or supply a trusted execution role. <a href="#/sns/topics">Open topics</a>.${template}</div>`;
  if (type === "logs") return `<div class="alert warning" data-policy-guidance="logs"><strong>Logs resource policy required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to call <span class="mono">logs:CreateLogStream</span> and <span class="mono">logs:PutLogEvents</span> for the group, constrained to ${source}. Logs targets do not use a target role. <a href="#/cloudwatch/log-groups">Open log groups</a>.${template}</div>`;
  if (type === "apigateway") return `<div class="alert warning" data-policy-guidance="apigateway"><strong>API authorization required</strong><br>Allow <span class="mono">events.amazonaws.com</span> in the deployed API resource policy for ${source}, or supply an EventBridge execution role with <span class="mono">execute-api:Invoke</span>. <a href="#/apigateway/apis">Open APIs</a>.${template}</div>`;
  if (type === "states") return `<div class="alert warning" data-policy-guidance="states"><strong>Execution role required</strong><br>Supply a role trusted by <span class="mono">events.amazonaws.com</span> with <span class="mono">states:StartExecution</span> on the target state machine. Success is checkpointed only after durable workflow admission. <a href="#/step-functions/state-machines">Open state machines</a>.${template}</div>`;
  return `<div class="alert warning" data-policy-guidance="lambda"><strong>Lambda permission required</strong><br>Allow <span class="mono">events.amazonaws.com</span> to invoke the function with ${source} as <span class="mono">AWS:SourceArn</span>, or supply a trusted execution role with <span class="mono">lambda:InvokeFunction</span>. <a href="#/lambda/functions">Open functions</a>.${template}</div>`;
}

export function targetFields(functions, target = {}, required = false, sourceArn) {
  const type = targetType(target);
  const includesTarget = type !== "lambda" || !target.Arn || functions.some(fn => fn.FunctionArn === target.Arn);
  const targetArn = type === "lambda" ? "" : target.Arn || "";
  const typeOptions = [["lambda", "Lambda function"], ["sqs", "SQS queue"], ["sns", "SNS topic"], ["logs", "CloudWatch log group"], ["apigateway", "API Gateway"], ["states", "Step Functions state machine"]];
  return `<div class="field-row"><div class="field"><label>Target type</label><select name="targetType">${typeOptions.map(([value, label]) => `<option value="${value}" ${type === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label>Target ID</label><input name="targetId" value="${escapeHtml(target.Id || `${type}-target`)}" maxlength="64" pattern="[A-Za-z0-9_.-]+" ${target.Id ? "readonly" : ""} required><span class="hint">Remove and re-add a target to change its ID.</span></div></div>
    <div data-target-type-fields="lambda"><div class="field"><label>Lambda function${required ? "" : " (optional)"}</label><select name="functionArn" data-target-required="${required}"><option value="">${required ? "Select a function" : "No target"}</option>${includesTarget ? "" : `<option value="${escapeHtml(target.Arn)}" selected>${escapeHtml(functionNameFromArn(target.Arn))} · version or alias</option>`}${functions.map(fn => `<option value="${escapeHtml(fn.FunctionArn)}" ${fn.FunctionArn === target.Arn ? "selected" : ""}>${escapeHtml(fn.FunctionName)}</option>`).join("")}</select><span class="hint">Functions, published versions, and aliases can also be configured through the SDK.</span></div></div>
    <div data-target-type-fields="sqs" ${type === "sqs" ? "" : "hidden"}><div class="field"><label>Queue ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "sqs" ? targetArn : "")}" placeholder="arn:aws:sqs:${escapeHtml(ui.region)}:000000000000:orders"></div><div class="field"><label>Message group ID</label><input name="messageGroupId" maxlength="100" value="${escapeHtml(target.SqsParameters?.MessageGroupId || "")}" placeholder="tenant-a"><span class="hint">Required for FIFO targets; on Standard queues this enables fair-queue scheduling.</span></div></div>
    <div data-target-type-fields="sns" ${type === "sns" ? "" : "hidden"}><div class="field"><label>Topic ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "sns" ? targetArn : "")}" placeholder="arn:aws:sns:${escapeHtml(ui.region)}:000000000000:order-alerts"></div><span class="hint">The topic policy must allow events.amazonaws.com to publish, or supply an execution role with sns:Publish.</span></div>
    <div data-target-type-fields="logs" ${type === "logs" ? "" : "hidden"}><div class="field"><label>Log group ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "logs" ? targetArn : "")}" placeholder="arn:aws:logs:${escapeHtml(ui.region)}:000000000000:log-group:/aws/events/orders"></div><span class="hint">EventBridge creates a stable stream inside an existing log group; it never creates the group.</span></div>
    <div data-target-type-fields="apigateway" ${type === "apigateway" ? "" : "hidden"}><div class="field"><label>Deployed API target ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "apigateway" ? targetArn : "")}" placeholder="arn:aws:execute-api:${escapeHtml(ui.region)}:000000000000:api-id/dev/POST/orders/*"></div><div class="field"><label>Path parameter values (JSON array)</label><textarea name="pathParameterValues">${escapeHtml(JSON.stringify(target.HttpParameters?.PathParameterValues ?? [], null, 2))}</textarea></div><div class="field"><label>Query string parameters (JSON object)</label><textarea name="queryStringParameters">${escapeHtml(JSON.stringify(target.HttpParameters?.QueryStringParameters ?? {}, null, 2))}</textarea></div><div class="field"><label>Header parameters (JSON object)</label><textarea name="headerParameters">${escapeHtml(JSON.stringify(target.HttpParameters?.HeaderParameters ?? {}, null, 2))}</textarea><span class="hint">Values may be static text or supported JSON paths. EventBridge-managed headers such as Host and Authorization are prohibited.</span></div></div>
    <div data-target-type-fields="states" ${type === "states" ? "" : "hidden"}><div class="field"><label>State machine ARN</label><input class="mono" name="targetArn" data-target-required="${required}" value="${escapeHtml(type === "states" ? targetArn : "")}" placeholder="arn:aws:states:${escapeHtml(ui.region)}:000000000000:stateMachine:orders"></div><span class="hint">Standard workflows start through normal durable StartExecution admission.</span></div>
    ${targetInputFields(target)}
    <div class="eventbridge-modal-section"><h3>Execution role</h3><p class="muted small">Create a new role for this specific resource is not available locally; use an existing role trusted by events.amazonaws.com, or rely on the target resource policy.</p><div data-role-fields><div class="field"><label>Execution role ARN (optional)</label><input class="mono" name="roleArn" value="${escapeHtml(target.RoleArn || "")}" placeholder="arn:aws:iam::000000000000:role/eventbridge-target"><span class="hint">Saving requires iam:PassRole and trust for events.amazonaws.com.</span></div></div><h3>Retry policy and dead-letter queue</h3><div class="field"><label>Dead-letter queue ARN (optional)</label><input class="mono" name="deadLetterArn" value="${escapeHtml(target.DeadLetterConfig?.Arn || "")}" placeholder="arn:aws:sqs:${escapeHtml(ui.region)}:000000000000:eventbridge-dlq"><span class="hint">Must be a Standard SQS queue in this Region with an EventBridge queue policy.</span></div><div class="field-row"><div class="field"><label>Maximum age of event (seconds)</label><input name="maximumAge" type="number" min="60" max="86400" value="${escapeHtml(target.RetryPolicy?.MaximumEventAgeInSeconds ?? 86400)}" required></div><div class="field"><label>Retry attempts</label><input name="maximumRetries" type="number" min="0" max="185" value="${escapeHtml(target.RetryPolicy?.MaximumRetryAttempts ?? 185)}" required></div></div></div>
    <div data-policy-guidance-container>${targetPolicyGuidance("lambda", sourceArn, type === "lambda" ? target.Arn : undefined)}${targetPolicyGuidance("sqs", sourceArn, type === "sqs" ? target.Arn : undefined)}${targetPolicyGuidance("sns", sourceArn, type === "sns" ? target.Arn : undefined)}${targetPolicyGuidance("logs", sourceArn, type === "logs" ? target.Arn : undefined)}${targetPolicyGuidance("apigateway", sourceArn, type === "apigateway" ? target.Arn : undefined)}${targetPolicyGuidance("states", sourceArn, type === "states" ? target.Arn : undefined)}<div class="alert info"><strong>Dead-letter queue policy</strong><br>If configured, the Standard queue must separately allow <span class="mono">events.amazonaws.com</span> to send messages for this rule. DLQ messages contain the original event and delivery error attributes.<details><summary>DLQ policy statement template</summary><pre class="code-box eventbridge-target-preview">${escapeHtml(JSON.stringify(targetPolicyStatement("sqs", sourceArn, target.DeadLetterConfig?.Arn), null, 2))}</pre></details></div></div>`;
}

export function bindTargetType(root = document) {
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
      if (id && /^(?:lambda|sqs|sns|logs|apigateway|states)-target$/.test(id.value)) id.value = `${select.value}-target`;
    }
  };
  select.addEventListener("change", update);
  update();
}

export function previewJsonPath(value, path) {
  if (path === "$") return value;
  if (!String(path).startsWith("$.")) return undefined;
  const parts = String(path).slice(2).replace(/\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g, (_match, single, double, index) => `.${single ?? double ?? index}`).split(".").filter(Boolean);
  return parts.reduce((current, part) => current === undefined || current === null ? undefined : current[part], value);
}

export function placeholderInsideString(template, index) {
  let quoted = false; let escaped = false;
  for (let position = 0; position < index; position++) {
    const character = template[position];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
  }
  return quoted;
}

export function previewTargetInput(data) {
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

export function bindTargetPreview(root = document) {
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

export function bindTargetModal(root = document) {
  bindInputMode(root);
  bindTargetType(root);
  bindTargetPreview(root);
}

// ---- Shared form helpers added for the 2026-10-29 console parity work ----

let tagRowId = 0;
/** AWS-style key/value tag rows with "Add new tag" and per-row "Remove". */
export function tagRowsMarkup(tags = {}, { limit = 50 } = {}) {
  const rows = Object.entries(tags).map(([key, value]) => tagRowMarkup(key, value)).join("");
  return `<div class="eventbridge-tag-rows" data-tag-rows>${rows || '<p class="muted small" data-no-tags>No tags associated with the resource.</p>'}</div><div class="eventbridge-inline-actions start"><button class="button" type="button" data-add-tag ${Object.keys(tags).length >= limit ? "disabled" : ""}>Add new tag</button><span class="hint">You can add up to ${limit} more tags.</span></div>`;
}
function tagRowMarkup(key = "", value = "") {
  const id = `eventbridge-tag-${++tagRowId}`;
  return `<div class="eventbridge-tag-row field-row" data-tag-row><div class="field"><label for="${id}-key">Key</label><input id="${id}-key" data-tag-key maxlength="128" required value="${escapeHtml(key)}" placeholder="environment"></div><div class="field"><label for="${id}-value">Value <span class="muted small">– optional</span></label><input id="${id}-value" data-tag-value maxlength="256" value="${escapeHtml(value)}" placeholder="development"></div><div class="field eventbridge-tag-remove"><button class="button" type="button" data-remove-tag aria-label="Remove tag">Remove</button></div></div>`;
}
export function bindTagRows(root, onChange = () => {}) {
  const container = root.querySelector("[data-tag-rows]"); const add = root.querySelector("[data-add-tag]");
  if (!container || !add) return;
  add.addEventListener("click", () => { container.querySelector("[data-no-tags]")?.remove(); container.insertAdjacentHTML("beforeend", tagRowMarkup()); container.lastElementChild.querySelector("input").focus(); onChange(); });
  container.addEventListener("click", event => { const button = event.target.closest("[data-remove-tag]"); if (!button) return; button.closest("[data-tag-row]").remove(); if (!container.querySelector("[data-tag-row]")) container.innerHTML = '<p class="muted small" data-no-tags>No tags associated with the resource.</p>'; onChange(); });
}
export function readTagRows(root) {
  const tags = {};
  for (const row of root.querySelectorAll("[data-tag-row]")) { const key = row.querySelector("[data-tag-key]").value.trim(); if (!key) throw new Error("Tag keys cannot be blank"); if (key in tags) throw new Error(`Duplicate tag key ${key}`); tags[key] = row.querySelector("[data-tag-value]").value; }
  return tags;
}

/** FormData-like reader scoped to one element so several target blocks can share field names. */
export function scopedFormData(root) {
  const enabled = control => !control.disabled && !control.closest("fieldset:disabled");
  const controls = name => [...root.querySelectorAll(`[name="${name}"]`)].filter(enabled);
  return {
    get(name) { const list = controls(name); if (!list.length) return null; const radio = list.find(control => control.type === "radio"); if (radio) return list.find(control => control.checked)?.value ?? null; const control = list[0]; if (control.type === "checkbox") return control.checked ? control.value || "on" : null; return control.value; },
    getAll(name) { return controls(name).filter(control => control.type !== "checkbox" && control.type !== "radio" || control.checked).map(control => control.value); },
  };
}

/** Sample events published by the locally implemented AWS services, used by the pattern builder and Sandbox. */
export const sampleEventLibrary = [
  { service: "Amazon S3", source: "aws.s3", types: [
    { type: "Object Created", event: { "detail-type": "Object Created", source: "aws.s3", resources: ["arn:aws:s3:::example-bucket"], detail: { version: "0", bucket: { name: "example-bucket" }, object: { key: "uploads/report.csv", size: 5, etag: "b1946ac92492d2347c6235b4d2611184", sequencer: "00617F08299329D189" }, "request-id": "N4N7GDK58NMKJ12R", requester: "123456789012", "source-ip-address": "1.2.3.4", reason: "PutObject" } } },
    { type: "Object Deleted", event: { "detail-type": "Object Deleted", source: "aws.s3", resources: ["arn:aws:s3:::example-bucket"], detail: { version: "0", bucket: { name: "example-bucket" }, object: { key: "uploads/report.csv", sequencer: "0C1A4E4F52F3B5D7" }, "request-id": "0BH729840619AG5K", requester: "123456789012", "source-ip-address": "1.2.3.4", reason: "DeleteObject", "deletion-type": "Permanently Deleted" } } },
  ] },
  { service: "Amazon CloudWatch", source: "aws.cloudwatch", types: [
    { type: "CloudWatch Alarm State Change", event: { "detail-type": "CloudWatch Alarm State Change", source: "aws.cloudwatch", resources: ["arn:aws:cloudwatch:eu-west-1:123456789012:alarm:ServerCpuTooHigh"], detail: { alarmName: "ServerCpuTooHigh", state: { value: "ALARM", reason: "Threshold Crossed", timestamp: "2026-10-29T10:00:00.000+0000" }, previousState: { value: "OK", reason: "Threshold Crossed", timestamp: "2026-10-29T09:00:00.000+0000" }, configuration: { description: "Goes into alarm when server CPU utilization is too high" } } } },
  ] },
  { service: "AWS Lambda", source: "aws.lambda", types: [
    { type: "Lambda Function Invocation Result - Success", event: { "detail-type": "Lambda Function Invocation Result - Success", source: "aws.lambda", resources: ["arn:aws:lambda:eu-west-1:123456789012:function:order-processor:$LATEST"], detail: { version: "1.0", timestamp: "2026-10-29T10:00:00.000Z", requestContext: { requestId: "c2a6f2ae-7dbb-4d22-8782-d0485c9877e2", functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:order-processor:$LATEST", condition: "Success", approximateInvokeCount: 1 }, requestPayload: { orderId: "o-1" }, responseContext: { statusCode: 200, executedVersion: "$LATEST" }, responsePayload: { ok: true } } } },
    { type: "Lambda Function Invocation Result - Failure", event: { "detail-type": "Lambda Function Invocation Result - Failure", source: "aws.lambda", resources: ["arn:aws:lambda:eu-west-1:123456789012:function:order-processor:$LATEST"], detail: { version: "1.0", timestamp: "2026-10-29T10:00:00.000Z", requestContext: { requestId: "c2a6f2ae-7dbb-4d22-8782-d0485c9877e2", functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:order-processor:$LATEST", condition: "RetriesExhausted", approximateInvokeCount: 3 }, requestPayload: { orderId: "o-1" }, responseContext: { statusCode: 200, executedVersion: "$LATEST", functionError: "Unhandled" }, responsePayload: { errorMessage: "boom", errorType: "Error" } } } },
  ] },
  { service: "AWS Step Functions", source: "aws.states", types: [
    { type: "Step Functions Execution Status Change", event: { "detail-type": "Step Functions Execution Status Change", source: "aws.states", resources: ["arn:aws:states:eu-west-1:123456789012:execution:order-workflow:7f0c2a3e"], detail: { executionArn: "arn:aws:states:eu-west-1:123456789012:execution:order-workflow:7f0c2a3e", stateMachineArn: "arn:aws:states:eu-west-1:123456789012:stateMachine:order-workflow", name: "7f0c2a3e", status: "SUCCEEDED", startDate: 1761732000000, stopDate: 1761732005000, input: "{}", output: "{}" } } },
  ] },
  { service: "AWS Systems Manager", source: "aws.ssm", types: [
    { type: "Parameter Store Change", event: { "detail-type": "Parameter Store Change", source: "aws.ssm", resources: ["arn:aws:ssm:eu-west-1:123456789012:parameter/app/config"], detail: { name: "/app/config", type: "String", operation: "Update" } } },
  ] },
  { service: "Amazon EventBridge (schedule)", source: "aws.events", types: [
    { type: "Scheduled Event", event: { "detail-type": "Scheduled Event", source: "aws.events", resources: ["arn:aws:events:eu-west-1:123456789012:rule/nightly"], detail: {} } },
  ] },
];

export function sampleEventJson(entry) {
  return JSON.stringify({ version: "0", id: "7bf73129-1428-4cd3-a780-95db273d1602", "detail-type": entry.event["detail-type"], source: entry.event.source, account: ui.summary?.accountId ?? "123456789012", time: "2026-10-29T10:00:00Z", region: ui.region, resources: entry.event.resources, detail: entry.event.detail }, null, 2);
}

/** AWS "Build event pattern" section: event source, sample events, creation method (pattern form or JSON editor), test. */
export function patternBuilderMarkup(state = {}) {
  const sourceMode = state.sourceMode ?? "aws"; const method = state.method ?? (state.pattern ? "custom" : "form");
  const serviceOptions = sampleEventLibrary.map((service, index) => `<option value="${index}" ${Number(state.service) === index ? "selected" : ""}>${escapeHtml(service.service)}</option>`).join("");
  const sampleOptions = sampleEventLibrary.flatMap((service, serviceIndex) => service.types.map((entry, typeIndex) => `<option value="${serviceIndex}:${typeIndex}">${escapeHtml(`${service.service} — ${entry.type}`)}</option>`)).join("");
  return `<section class="card" data-pattern-builder><div class="card-header"><h2>Event source</h2></div><div class="card-body"><fieldset class="setting-options eventbridge-choice-grid"><legend class="sr-only">Event source</legend>
<label class="setting-option"><input type="radio" name="patternSource" value="aws" ${sourceMode === "aws" ? "checked" : ""}><span><strong>AWS events or EventBridge partner events</strong><small>Events published by the AWS services simulated locally. Partner events are not available.</small></span></label>
<label class="setting-option"><input type="radio" name="patternSource" value="other" ${sourceMode === "other" ? "checked" : ""}><span><strong>Other</strong><small>Custom events from your own applications.</small></span></label>
<label class="setting-option"><input type="radio" name="patternSource" value="all" ${sourceMode === "all" ? "checked" : ""}><span><strong>All events</strong><small>Every event delivered to this event bus, matched on the account field.</small></span></label></fieldset></div></section>
<section class="card"><div class="card-header"><h2>Sample event <span class="muted small">– optional</span></h2></div><div class="card-body"><div class="field"><label>Sample event type</label><select name="sampleType"><option value="aws">AWS events</option><option value="own" ${state.sampleEvent ? "selected" : ""}>Enter my own</option></select></div><div class="field" data-sample-library><label>Sample events</label><select name="sampleEntry">${sampleOptions}</select></div><div class="field"><label>Sample event</label><textarea class="code-editor" name="sampleEvent">${escapeHtml(state.sampleEvent ?? sampleEventJson(sampleEventLibrary[0].types[0]))}</textarea><span class="hint">Edit the JSON or pick another sample, then test it against the pattern.</span></div></div></section>
<section class="card" data-creation-method><div class="card-header"><h2>Creation method</h2></div><div class="card-body"><fieldset class="setting-options eventbridge-choice-grid"><legend class="sr-only">Method</legend>
<label class="setting-option" data-method-option="form"><input type="radio" name="patternMethod" value="form" ${method === "form" ? "checked" : ""}><span><strong>Use pattern form</strong><small>Pick an AWS service and event type; EventBridge writes the pattern.</small></span></label>
<label class="setting-option"><input type="radio" name="patternMethod" value="custom" ${method === "custom" ? "checked" : ""}><span><strong>Custom pattern (JSON editor)</strong><small>Write the event pattern as JSON.</small></span></label></fieldset>
<div data-pattern-form><div class="field-row"><div class="field"><label>AWS service</label><select name="patternService">${serviceOptions}</select></div><div class="field"><label>Event type</label><select name="patternEventType"></select></div></div></div>
<div class="field"><label>Event pattern</label><textarea class="code-editor" name="pattern">${escapeHtml(state.pattern ?? "")}</textarea><span class="hint">Values must be arrays; omitted fields match anything.</span></div>
<div class="eventbridge-inline-actions"><button class="button" type="button" data-prettify-pattern>Prettify</button><button class="button" type="button" data-copy-pattern>Copy</button><button class="button" type="button" data-test-pattern>Test pattern</button></div><div class="eventbridge-test-result" data-pattern-test-result aria-live="polite"></div></div></section>`;
}

export function bindPatternBuilder(root, { onChange: notify = () => {}, testPattern } = {}) {
  const builder = root; if (!builder) return;
  let ready = false; const onChange = () => { if (ready) notify(); };
  const control = name => builder.querySelector(`[name="${name}"]`);
  const patternField = control("pattern"); const serviceSelect = control("patternService"); const typeSelect = control("patternEventType"); const sampleEntry = control("sampleEntry"); const sampleField = control("sampleEvent");
  const generated = () => {
    const mode = scopedFormData(builder).get("patternSource");
    if (mode === "all") return JSON.stringify({ account: [ui.summary?.accountId ?? "000000000000"] }, null, 2);
    if (mode === "other") return JSON.stringify({ source: ["com.example.app"] }, null, 2);
    const service = sampleEventLibrary[Number(serviceSelect.value)] ?? sampleEventLibrary[0]; const type = typeSelect.value;
    return JSON.stringify({ source: [service.source], ...(type && type !== "*" ? { "detail-type": [type] } : {}) }, null, 2);
  };
  const syncTypes = () => { const service = sampleEventLibrary[Number(serviceSelect.value)] ?? sampleEventLibrary[0]; typeSelect.innerHTML = `<option value="*">All Events</option>${service.types.map(entry => `<option value="${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</option>`).join("")}`; };
  const sync = () => {
    const mode = scopedFormData(builder).get("patternSource"); const method = scopedFormData(builder).get("patternMethod");
    const formOption = builder.querySelector("[data-method-option=form]"); const formInput = formOption.querySelector("input");
    formInput.disabled = mode !== "aws"; formOption.classList.toggle("disabled", mode !== "aws");
    if (mode !== "aws" && method === "form") { builder.querySelector('[name="patternMethod"][value="custom"]').checked = true; }
    const effectiveMethod = scopedFormData(builder).get("patternMethod");
    builder.querySelector("[data-pattern-form]").hidden = effectiveMethod !== "form";
    patternField.readOnly = effectiveMethod === "form";
    if (effectiveMethod === "form" || (mode !== "aws" && !patternField.value.trim())) patternField.value = generated();
    builder.querySelector("[data-sample-library]").hidden = control("sampleType").value !== "aws";
    onChange();
  };
  syncTypes();
  serviceSelect.addEventListener("change", () => { syncTypes(); sync(); }); typeSelect.addEventListener("change", sync);
  builder.querySelectorAll('[name="patternSource"], [name="patternMethod"]').forEach(input => input.addEventListener("change", sync));
  control("sampleType").addEventListener("change", sync);
  sampleEntry.addEventListener("change", () => { const [serviceIndex, typeIndex] = sampleEntry.value.split(":").map(Number); const entry = sampleEventLibrary[serviceIndex]?.types[typeIndex]; if (entry) { sampleField.value = sampleEventJson(entry); onChange(); } });
  patternField.addEventListener("input", onChange); sampleField.addEventListener("input", onChange);
  builder.querySelector("[data-prettify-pattern]").addEventListener("click", () => { try { patternField.value = JSON.stringify(JSON.parse(patternField.value), null, 2); } catch { /* leave invalid text in place */ } });
  builder.querySelector("[data-copy-pattern]").addEventListener("click", () => { navigator.clipboard?.writeText(patternField.value).catch(() => undefined); });
  builder.querySelector("[data-test-pattern]").addEventListener("click", async () => {
    const output = builder.querySelector("[data-pattern-test-result]");
    try {
      const pattern = parseObject(patternField.value, "Event pattern"); const sample = parseObject(sampleField.value, "Sample event");
      const result = await (testPattern ?? (async (EventPattern, Event) => events("TestEventPattern", { EventPattern, Event })))(JSON.stringify(pattern), JSON.stringify(sample));
      output.innerHTML = `<div class="alert ${result.Result ? "success" : "warning"}" role="status"><strong>${result.Result ? "Pattern matches" : "Pattern does not match"}</strong><br>${result.Result ? "The sample event matched the event pattern." : "The sample event did not match; adjust the pattern or the sample."}</div>`;
    } catch (error) { output.innerHTML = `<div class="alert error" role="alert"><strong>Pattern test failed</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`; }
  });
  if (!patternField.value.trim() || scopedFormData(builder).get("patternMethod") === "form") sync(); else { builder.querySelector("[data-pattern-form]").hidden = true; builder.querySelector("[data-sample-library]").hidden = control("sampleType").value !== "aws"; }
  ready = true;
}

export function readPatternBuilder(root) {
  const text = root.querySelector('[name="pattern"]').value.trim();
  return text ? JSON.stringify(parseObject(text, "Event pattern")) : undefined;
}

// ---- Legacy cron preview (minute, hour, day-of-month, month, day-of-week, year) ----
const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const WEEKDAY_NAMES = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };
function cronField(raw, minimum, maximum, names = {}) {
  const text = String(raw).trim().toUpperCase(); if (!text) throw new Error("Cron fields cannot be blank");
  if (text === "*" || text === "?") return { any: true, values: new Set() };
  if (/[LW#]/.test(text)) return { any: false, values: new Set(), unsupported: true };
  const values = new Set(); const number = value => { const parsed = names[value] ?? Number(value); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Cron value ${value} is outside ${minimum}-${maximum}`); return parsed; };
  for (const item of text.split(",")) {
    const [range, stepText] = item.split("/"); const step = stepText === undefined ? 1 : Number(stepText); if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step ${stepText}`);
    let start = minimum; let end = maximum;
    if (range !== "*") { if (range.includes("-")) { const [left, right] = range.split("-"); start = number(left); end = number(right); } else { start = number(range); end = stepText === undefined ? start : maximum; } }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { any: false, values };
}
/** Returns the next `count` UTC trigger dates for a legacy six-field cron expression, or null when the expression uses L, W, or #. */
export function nextCronDates(expression, count = 10, from = Date.now()) {
  const match = String(expression).trim().match(/^cron\((.+)\)$/i); const parts = (match ? match[1] : String(expression)).trim().split(/\s+/);
  if (parts.length !== 6) throw new Error("A cron expression needs six fields: minutes hours day-of-month month day-of-week year");
  if ((parts[2] === "?") === (parts[4] === "?")) throw new Error("Use ? in exactly one of day-of-month or day-of-week");
  const fields = [cronField(parts[0], 0, 59), cronField(parts[1], 0, 23), cronField(parts[2], 1, 31), cronField(parts[3], 1, 12, MONTH_NAMES), cronField(parts[4], 1, 7, WEEKDAY_NAMES), cronField(parts[5], 1970, 2199)];
  if (fields.some(field => field.unsupported)) return null;
  const matches = (field, value) => field.any || field.values.has(value);
  const results = []; let cursor = Math.ceil(from / 60_000) * 60_000; const limit = cursor + 6 * 366 * 86_400_000;
  while (results.length < count && cursor <= limit) {
    const date = new Date(cursor);
    if (matches(fields[0], date.getUTCMinutes()) && matches(fields[1], date.getUTCHours()) && matches(fields[2], date.getUTCDate()) && matches(fields[3], date.getUTCMonth() + 1) && matches(fields[4], date.getUTCDay() + 1) && matches(fields[5], date.getUTCFullYear())) results.push(cursor);
    cursor += 60_000;
  }
  return results;
}
