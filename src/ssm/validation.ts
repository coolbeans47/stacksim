import { Buffer } from "node:buffer";
import { AwsError } from "../errors.js";

const NAME_CHARACTERS = /^[A-Za-z0-9_.\-/]+$/;

export function validation(message: string): never {
  throw new AwsError("ValidationException", message, 400);
}

export function canonicalParameterName(value: unknown, allowArn = true): string {
  if (typeof value !== "string" || !value) return validation("Name is required.");
  let supplied = value.trim();
  if (supplied.startsWith("arn:")) {
    if (!allowArn) return validation("PutParameter does not accept a parameter ARN.");
    const match = supplied.match(/^arn:(?:aws|aws-cn|aws-us-gov):ssm:[a-z0-9-]+:\d{12}:parameter\/(.+)$/);
    if (!match) return validation("The parameter ARN is invalid.");
    supplied = `/${match[1]}`;
  }
  if (/\s/.test(supplied)) return validation(`Parameter name "${value}" contains invalid spaces.`);
  if (!NAME_CHARACTERS.test(supplied)) return validation(`Parameter name "${value}" contains invalid characters.`);
  if (Buffer.byteLength(supplied, "utf8") > 1011) return validation("Parameter name exceeds the maximum length.");
  if (supplied.includes("//")) return validation("Parameter names cannot contain empty hierarchy segments.");
  const withoutSlash = supplied.replace(/^\/+/, "");
  if (!withoutSlash) return validation("Parameter name cannot be empty.");
  if (/^(?:aws|ssm)/i.test(withoutSlash)) return validation("Parameter names cannot use the reserved prefix aws or ssm.");
  if (withoutSlash.split("/").length > 15) return validation("Parameter hierarchy exceeds the maximum depth of 15.");
  return supplied.startsWith("/") ? supplied : supplied;
}

export function canonicalParameterPath(value: unknown): string {
  if (typeof value !== "string" || !value) return validation("Path is required.");
  const supplied = value.trim();
  if (!supplied.startsWith("/")) return validation("Path must be a hierarchy beginning with a slash.");
  if (supplied === "/") return supplied;
  const normalized = supplied.endsWith("/") ? supplied.slice(0, -1) : supplied;
  if (normalized.endsWith("/")) return validation("Paths cannot contain empty hierarchy segments.");
  canonicalParameterName(normalized, false);
  return normalized;
}

export function normalizeStringList(value: string): string {
  return value.split(",").map(item => item.trim()).join(",");
}

export function parameterValue(value: unknown, type: "String" | "StringList" | "SecureString", allowedPattern?: string, maximumBytes = 4096): string {
  if (typeof value !== "string") return validation("Value is required and must be a string.");
  if (Buffer.byteLength(value, "utf8") > maximumBytes) return validation(`${maximumBytes === 8192 ? "Advanced" : "Standard"} parameter values cannot exceed ${maximumBytes} bytes.`);
  const normalized = type === "StringList" ? normalizeStringList(value) : value;
  if (/\{\{(?:ssm|ssm-secure):/i.test(normalized)) return validation("Parameter values cannot contain nested Parameter Store references.");
  if (allowedPattern !== undefined) {
    if (typeof allowedPattern !== "string" || allowedPattern.length > 1024) return validation("AllowedPattern is invalid.");
    let pattern: RegExp;
    try { pattern = new RegExp(allowedPattern); } catch { return validation("AllowedPattern is not a valid regular expression."); }
    if (!pattern.test(normalized)) return validation("The parameter value does not match the allowed pattern.");
  }
  return normalized;
}

export function tags(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 50) return validation("Tags must contain at most 50 entries.");
  const result: Record<string, string> = {};
  for (const item of value) {
    if (!item || typeof item.Key !== "string" || !item.Key || item.Key.length > 128 || typeof item.Value !== "string" || item.Value.length > 256) return validation("Each tag requires a valid Key and Value.");
    if (item.Key.toLowerCase().startsWith("aws:")) return validation("Tag keys beginning with aws: are reserved.");
    if (Object.hasOwn(result, item.Key)) return validation(`Duplicate tag key ${item.Key}.`);
    result[item.Key] = item.Value;
  }
  return result;
}

export function positiveInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) return validation(`${field} must be between ${minimum} and ${maximum}.`);
  return Number(value);
}
