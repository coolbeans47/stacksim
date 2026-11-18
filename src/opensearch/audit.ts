import { fail, keys, record, wildcard, type Json } from "./query.js";

export const AUDIT_CATEGORIES = ["FAILED_LOGIN", "MISSING_PRIVILEGES", "GRANTED_PRIVILEGES", "AUTHENTICATED"] as const;
export type AuditCategory = typeof AUDIT_CATEGORIES[number];
export function defaultAudit(): Json { return { enabled: false, audit: { enable_rest: true, disabled_rest_categories: ["GRANTED_PRIVILEGES", "AUTHENTICATED"], enable_transport: false, disabled_transport_categories: [], resolve_bulk_requests: false, log_request_body: false, resolve_indices: false, exclude_sensitive_headers: true, ignore_users: [], ignore_requests: [] }, compliance: { enabled: false } }; }
export function validateAudit(input: unknown): Json {
  const config = record(input, "audit configuration"); keys(config, ["enabled", "audit", "compliance"], "audit configuration");
  const defaults = defaultAudit(), audit = record(config.audit === undefined ? {} : config.audit, "audit"), compliance = record(config.compliance === undefined ? {} : config.compliance, "audit compliance");
  keys(audit, Object.keys(defaults.audit), "audit"); keys(compliance, ["enabled"], "audit compliance");
  const result = { enabled: config.enabled === undefined ? defaults.enabled : config.enabled, audit: { ...defaults.audit, ...audit }, compliance: { enabled: compliance.enabled === undefined ? false : compliance.enabled } };
  if (typeof result.enabled !== "boolean") fail("Audit enabled must be boolean");
  for (const field of ["enable_rest", "enable_transport", "resolve_bulk_requests", "log_request_body", "resolve_indices", "exclude_sensitive_headers"]) if (typeof result.audit[field] !== "boolean") fail(`audit.${field} must be boolean`);
  if (typeof result.compliance.enabled !== "boolean" || result.compliance.enabled) fail("Compliance audit logging is not implemented");
  for (const field of ["enable_transport", "resolve_bulk_requests", "log_request_body"]) if (result.audit[field]) fail(`audit.${field}=true is not implemented`);
  if (!result.audit.exclude_sensitive_headers) fail("Sensitive header logging is unavailable");
  for (const field of ["disabled_rest_categories", "disabled_transport_categories", "ignore_users", "ignore_requests"]) {
    const value = result.audit[field];
    if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== "string" || !item || item.length > 1024)) fail(`audit.${field} requires at most 100 strings of 1–1024 characters`);
    if (field.startsWith("disabled_") && value.some(item => !(AUDIT_CATEGORIES as readonly string[]).includes(item))) fail("Unsupported audit category");
  }
  if (result.audit.disabled_transport_categories.length) fail("Transport audit categories are unavailable");
  if (result.audit.ignore_requests.some((pattern: string) => !pattern.startsWith("/") && pattern !== "*")) fail("Audit ignore_requests supports REST path glob patterns only");
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) fail("Audit configuration exceeds 32 KiB");
  return structuredClone(result);
}
export function patchAudit(current: Json, input: unknown): Json {
  if (!Array.isArray(input) || !input.length || input.length > 100) fail("Audit PATCH requires 1–100 operations");
  const result = structuredClone(current);
  for (const entry of input) {
    const operation = record(entry, "audit patch operation"); keys(operation, ["op", "path", "value"], "audit patch operation");
    if (!["add", "replace"].includes(operation.op) || typeof operation.path !== "string" || !operation.path.startsWith("/") || !Object.hasOwn(operation, "value")) fail("Audit PATCH supports add/replace with a value");
    const parts = operation.path.split("/").slice(1); if (parts[0] === "config") parts.shift();
    if (parts.length === 1 && ["enabled", "audit", "compliance"].includes(parts[0])) result[parts[0]] = operation.value;
    else if (parts.length === 2 && ["audit", "compliance"].includes(parts[0]) && Object.hasOwn(defaultAudit()[parts[0]], parts[1])) result[parts[0]][parts[1]] = operation.value;
    else fail("Unsupported audit PATCH path");
  }
  return validateAudit(result);
}
export function shouldAudit(config: Json, category: AuditCategory, user: string, path: string): boolean {
  return config.enabled && config.audit.enable_rest && !config.audit.disabled_rest_categories.includes(category) && !config.audit.ignore_users.some((pattern: string) => wildcard(pattern, user)) && !config.audit.ignore_requests.some((pattern: string) => wildcard(pattern, path));
}
