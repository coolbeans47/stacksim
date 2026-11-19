import { AwsError } from "../errors.js";

export function namedList(value: any, memberName: string): any[] {
  const members = value?.[memberName] ?? value;
  if (members === undefined || members === null) return [];
  return Array.isArray(members) ? members : [members];
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new AwsError("InvalidParameterValue", `${field} is required`);
  return value;
}

export function integer(value: unknown, fallback: number, field: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed)) throw new AwsError("InvalidParameterValue", `${field} must be an integer`);
  return parsed;
}

export function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new AwsError("InvalidParameterValue", "Boolean parameters must be true or false");
}

export function rejectUnsupportedInput(input: Record<string, unknown>, supported: readonly string[]): void {
  const allowed = new Set(supported);
  const field = Object.keys(input).find(key => !allowed.has(key));
  if (field) throw new AwsError("InvalidParameterCombination", `${field} is not supported by the local RDS development profile`);
}

export function tags(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = namedList(value, "Tag");
  if (entries.length > 50) throw new AwsError("InvalidParameterValue", "A maximum of 50 tags is allowed");
  for (const entry of entries) {
    const key = String(entry?.Key ?? ""); const tagValue = String(entry?.Value ?? "");
    if (!key || key.length > 128 || tagValue.length > 256 || key.toLowerCase().startsWith("aws:")) throw new AwsError("InvalidParameterValue", "Tag keys or values are invalid");
    if (Object.hasOwn(result, key)) throw new AwsError("InvalidParameterValue", `Duplicate tag key ${key}`);
    result[key] = tagValue;
  }
  return result;
}

export function validatePassword(value: unknown): string {
  const password = requiredString(value, "MasterUserPassword");
  if (password.length < 8 || password.length > 41 || /[^\x20-\x7e]/.test(password) || /[\/@\"]/.test(password)) throw new AwsError("InvalidParameterValue", "MasterUserPassword must be 8-41 printable ASCII characters and cannot contain slash, at-sign, or double quote");
  return password;
}
