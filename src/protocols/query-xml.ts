import type { ServerResponse } from "node:http";

export interface AwsQueryParseOptions { readonly coerceTimestamps?: boolean }

function scalar(value: string, options: AwsQueryParseOptions): string | boolean | Date {
  if (value === "true") return true;
  if (value === "false") return false;
  if (options.coerceTimestamps !== false && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return new Date(value);
  return value;
}

function setPath(root: any, rawPath: string, value: unknown): void {
  const source = rawPath.split(".");
  const path: Array<string | number> = [];
  for (let index = 0; index < source.length; index++) {
    if ((source[index] === "member" || source[index] === "entry") && /^\d+$/.test(source[index + 1] ?? "")) {
      path.push(Number(source[++index]) - 1);
    } else if (/^\d+$/.test(source[index + 1] ?? "")) {
      path.push(source[index], Number(source[++index]) - 1);
    } else path.push(source[index]);
  }
  let target = root;
  for (let index = 0; index < path.length - 1; index++) {
    const part = path[index];
    const next = path[index + 1];
    if (typeof part === "number") {
      if (!Array.isArray(target)) throw new Error(`Invalid AWS Query list path: ${rawPath}`);
      target[part] ??= typeof next === "number" ? [] : {};
      target = target[part];
    } else {
      target[part] ??= typeof next === "number" ? [] : {};
      target = target[part];
    }
  }
  const final = path.at(-1)!;
  if (typeof final === "number") {
    if (!Array.isArray(target)) throw new Error(`Invalid AWS Query list path: ${rawPath}`);
    target[final] = value;
  } else target[final] = value;
}

export function parseAwsQuery(body: string | URLSearchParams, options: AwsQueryParseOptions = {}): Record<string, unknown> {
  const params = typeof body === "string" ? new URLSearchParams(body) : body;
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) setPath(result, key, scalar(value, options));
  return result;
}

export function escapeXml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function valueXml(value: unknown, memberName = "member"): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return escapeXml(value.toISOString());
  if (isAwsQueryMap(value)) return value.entries.map(([key, item]) => `<entry><key>${escapeXml(key)}</key><value>${valueXml(item)}</value></entry>`).join("");
  if (isAwsQueryList(value)) return value.items.map(item => `<${value.memberName}>${typeof item === "object" && item !== null ? objectXml(item as Record<string, unknown>) : valueXml(item)}</${value.memberName}>`).join("");
  if (Array.isArray(value)) return value.map(item => `<${memberName}>${typeof item === "object" && item !== null ? objectXml(item as Record<string, unknown>) : valueXml(item)}</${memberName}>`).join("");
  if (typeof value === "object") return objectXml(value as Record<string, unknown>);
  return escapeXml(value);
}

export interface AwsQueryMap { readonly __awsQueryMap: true; readonly entries: Array<[string, unknown]> }
function isAwsQueryMap(value: unknown): value is AwsQueryMap { return Boolean(value && typeof value === "object" && (value as AwsQueryMap).__awsQueryMap === true && Array.isArray((value as AwsQueryMap).entries)); }
export function awsQueryMap(value: Record<string, unknown>): AwsQueryMap { return { __awsQueryMap: true, entries: Object.entries(value) }; }

export interface AwsQueryList { readonly __awsQueryList: true; readonly memberName: string; readonly items: unknown[] }
function isAwsQueryList(value: unknown): value is AwsQueryList { return Boolean(value && typeof value === "object" && (value as AwsQueryList).__awsQueryList === true && typeof (value as AwsQueryList).memberName === "string" && Array.isArray((value as AwsQueryList).items)); }
export function awsQueryList(memberName: string, items: unknown[]): AwsQueryList { return { __awsQueryList: true, memberName, items }; }

function objectXml(value: Record<string, unknown>): string {
  return Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `<${key}>${valueXml(item)}</${key}>`).join("");
}

export function awsQueryXml(root: string, value: Record<string, unknown>, namespace?: string): string {
  const ns = namespace ? ` xmlns="${escapeXml(namespace)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><${root}${ns}>${objectXml(value)}</${root}>`;
}

export function awsQueryErrorXml(code: string, message: string, requestId: string): string {
  return awsQueryXml("ErrorResponse", { Error: { Type: "Sender", Code: code, Message: message }, RequestId: requestId });
}

export function sendAwsQueryXml(res: ServerResponse, root: string, value: Record<string, unknown>, namespace?: string, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/xml; charset=utf-8");
  res.end(awsQueryXml(root, value, namespace));
}
