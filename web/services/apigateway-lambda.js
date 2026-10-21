import { rest } from "../api-client.js";
import { escapeHtml } from "../components.js";
import { session as ui } from "../state.js";

// Shared helpers for wiring Lambda functions into API Gateway from the console.
// The AWS console adds a lambda:InvokeFunction resource-policy statement after
// asking the user; these helpers render that confirmation and call AddPermission.

export const consoleRegion = () => ui.summary?.region ?? ui.region ?? "eu-west-1";
export const consoleAccountId = () => ui.summary?.accountId ?? "000000000000";

export function lambdaInvocationUri(functionArn, region = consoleRegion()) {
  return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`;
}

/** Function ARN from either an invocation URI or a bare Lambda ARN. */
export function lambdaArnFromUri(uri) {
  const value = String(uri ?? "");
  if (/^arn:aws[a-z-]*:lambda:/.test(value)) return value;
  return value.match(/\/functions\/(arn:aws[a-z-]*:lambda:[^/]+)\/invocations/)?.[1];
}

export function isLambdaUri(uri) { return Boolean(lambdaArnFromUri(uri)); }

/** Accept a function ARN (optionally qualified) or a bare function name typed into the picker. */
export function normalizeFunctionArn(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("arn:")) return text;
  return `arn:aws:lambda:${consoleRegion()}:${consoleAccountId()}:function:${text}`;
}

export const functionRegion = functionArn => String(functionArn ?? "").split(":")[3] || consoleRegion();

export function lambdaFunctionName(arnOrName) {
  const value = String(arnOrName ?? "");
  return value.includes(":function:") ? value.split(":function:")[1].split(":")[0] : value.split(":")[0];
}

export function executeApiArn(apiId, suffix) {
  return `arn:aws:execute-api:${consoleRegion()}:${consoleAccountId()}:${apiId}/${String(suffix).replace(/^\//, "")}`;
}

/** REST method scope used by the AWS console: /*\/METHOD/path, with path parameters as wildcards. */
export function restMethodSourceArn(apiId, method, resourcePath = "/") {
  const path = String(resourcePath || "/").replace(/\{[^}]+\}/g, "*");
  return executeApiArn(apiId, `*/${method === "ANY" ? "*" : method}${path.startsWith("/") ? path : `/${path}`}`);
}

export const authorizerSourceArn = (apiId, authorizerId) => executeApiArn(apiId, `authorizers/${authorizerId}`);
export const apiWideSourceArn = apiId => executeApiArn(apiId, "*/*");

export async function listLambdaFunctions() {
  return (await rest("/2015-03-31/functions")).Functions ?? [];
}

export function lambdaFunctionOptions(functions, selectedArn = "") {
  const selected = String(selectedArn ?? "");
  const known = functions.some(fn => fn.FunctionArn === selected);
  return `${selected && !known ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(lambdaFunctionName(selected))}</option>` : ""}${functions.map(fn => `<option value="${escapeHtml(fn.FunctionArn)}" ${fn.FunctionArn === selected ? "selected" : ""}>${escapeHtml(fn.FunctionName)}</option>`).join("")}`;
}

function permissionStatement(functionArn, sourceArn) {
  return { Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "lambda:InvokeFunction", Resource: functionArn || "<choose a Lambda function>", Condition: { ArnLike: { "AWS:SourceArn": sourceArn } } };
}

/** In-form confirmation that names the statement the console will add. */
export function lambdaPermissionNotice({ functionArn = "", sourceArn = "", checked = true, note = "" } = {}) {
  return `<div class="alert info lambda-permission-notice" data-lambda-permission><strong>Lambda invoke permission</strong><label class="checkbox-label lambda-permission-toggle"><input type="checkbox" name="grantLambdaPermission" value="true" ${checked ? "checked" : ""}> Grant API Gateway permission to invoke the function</label><p class="small">The console calls <span class="mono">lambda:AddPermission</span> and adds this statement to the function's resource-based policy, unless an equivalent statement already exists. ${escapeHtml(note)}</p><pre class="code-box small" data-permission-preview>${escapeHtml(JSON.stringify(permissionStatement(functionArn, sourceArn), null, 2))}</pre></div>`;
}

export function updateLambdaPermissionNotice(root, { functionArn = "", sourceArn = "" } = {}) {
  const preview = root?.querySelector?.("[data-permission-preview]");
  if (preview) preview.textContent = JSON.stringify(permissionStatement(functionArn, sourceArn), null, 2);
}

function arnPatternMatches(pattern, value) {
  const expression = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function statementCovers(statement, sourceArn) {
  if (statement.Effect && statement.Effect !== "Allow") return false;
  const actions = [].concat(statement.Action ?? []);
  if (!actions.some(action => action === "lambda:InvokeFunction" || action === "lambda:*")) return false;
  const principal = typeof statement.Principal === "string" ? statement.Principal : statement.Principal?.Service ?? statement.Principal?.AWS;
  if (![].concat(principal ?? []).some(value => value === "*" || value === "apigateway.amazonaws.com")) return false;
  const condition = statement.Condition ?? {};
  const pattern = condition.ArnLike?.["AWS:SourceArn"] ?? condition.ArnLike?.["aws:SourceArn"] ?? condition.ArnEquals?.["AWS:SourceArn"] ?? condition.ArnEquals?.["aws:SourceArn"] ?? condition.StringEquals?.["AWS:SourceArn"];
  if (!pattern) return true;
  return [].concat(pattern).some(value => arnPatternMatches(value, sourceArn));
}

function statementId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `apigateway-${random}`.slice(0, 100);
}

/** Add lambda:InvokeFunction for apigateway.amazonaws.com unless an equivalent statement exists. */
export async function ensureLambdaInvokePermission(functionArn, sourceArn) {
  const name = lambdaFunctionName(functionArn);
  const qualifier = String(functionArn).includes(":function:") ? String(functionArn).split(":function:")[1].split(":")[1] : undefined;
  const path = `/2015-03-31/functions/${encodeURIComponent(name)}/policy`;
  const query = qualifier ? `?Qualifier=${encodeURIComponent(qualifier)}` : "";
  let statements = [];
  try { statements = JSON.parse((await rest(`${path}${query}`)).Policy ?? "{}").Statement ?? []; }
  catch (error) { if (error.status !== 404) throw error; }
  if (statements.some(statement => statementCovers(statement, sourceArn))) return { added: false };
  const id = statementId();
  await rest(`${path}${query}`, "POST", { StatementId: id, Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: sourceArn });
  return { added: true, statementId: id };
}

/** Run ensureLambdaInvokePermission and report the outcome without failing the surrounding save. */
export async function grantLambdaPermission({ functionArn, sourceArn, toast, quietIfPresent = false }) {
  if (!functionArn) return;
  try {
    const result = await ensureLambdaInvokePermission(functionArn, sourceArn);
    if (result.added) toast?.(`Added lambda:InvokeFunction permission to ${lambdaFunctionName(functionArn)} for ${sourceArn}`);
    else if (!quietIfPresent) toast?.(`${lambdaFunctionName(functionArn)} already allows API Gateway to invoke it`);
  } catch (error) {
    toast?.(`Could not add the Lambda invoke permission to ${lambdaFunctionName(functionArn)}: ${error.message}. Run aws lambda add-permission with principal apigateway.amazonaws.com and source ARN ${sourceArn}.`, "error");
  }
}

export function outboundHttpNotice() {
  return `<div class="alert warning outbound-http-notice" data-outbound-http-notice><strong>Outbound HTTP is opt-in in StackSim</strong><br>HTTP and HTTP proxy integrations fail with a 5xx response unless the simulator was started with <span class="mono">STACKSIM_ALLOW_OUTBOUND_HTTP=true</span>. Targets on localhost, private addresses, or the metadata address also need <span class="mono">STACKSIM_ALLOW_PRIVATE_HTTP=true</span>.</div>`;
}

export function invokeEndpoint() {
  return ui.summary?.invokeEndpoint ?? `${location.protocol}//127.0.0.1:4567`;
}

/** Host-based execute-api URL that works alongside the path-based form. */
export function hostInvokeUrl(apiId, stage, protocol) {
  let base;
  try { base = new URL(invokeEndpoint()); } catch { return ""; }
  const scheme = protocol ?? base.protocol.replace(/:$/, "");
  return `${scheme}://${apiId}.execute-api.localhost${base.port ? `:${base.port}` : ""}${stage ? `/${stage}` : ""}`;
}

export function copyUrlButton(value, label = "Copy URL") {
  return `<button class="button" type="button" data-copy="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">Copy</button>`;
}

/** Toggle a set of panels by key, disabling hidden controls so they are not validated or submitted. */
export function syncPanels(root, attribute, activeKeys, { disable = true } = {}) {
  const keys = new Set([].concat(activeKeys));
  root.querySelectorAll(`[${attribute}]`).forEach(panel => {
    const active = panel.getAttribute(attribute).split(/\s+/).some(key => keys.has(key));
    panel.hidden = !active;
    if (disable) panel.querySelectorAll("input, select, textarea, button").forEach(control => { if (control.closest(`[${attribute}]`) === panel) control.disabled = !active; });
  });
}
