import { AwsError } from "../errors.js";

export function invalid(message: string): never {
  throw new AwsError("InvalidParameterException", message, 400);
}
export function invalidRequest(message: string): never {
  throw new AwsError("InvalidRequestException", message, 400);
}

export function secretName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) invalid("The parameter Name must be between 1 and 512 characters.");
  if (!/^[A-Za-z0-9/_+=.@-]+$/.test(value)) invalid("The parameter Name contains invalid characters.");
  return value;
}

export function description(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2048) invalid("Description must be a string no longer than 2048 characters.");
  return value;
}

export function requestToken(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length < 32 || value.length > 64 || !/^[A-Za-z0-9-]+$/.test(value)) {
    invalid("ClientRequestToken must be between 32 and 64 alphanumeric or hyphen characters.");
  }
  return value;
}

export function tagMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 50) invalid("Tags must contain no more than 50 entries.");
  const output: Record<string, string> = {};
  for (const tag of value) {
    if (!tag || typeof tag.Key !== "string" || tag.Key.length < 1 || tag.Key.length > 128 || typeof tag.Value !== "string" || tag.Value.length > 256) {
      invalid("Each tag requires a key of 1-128 characters and a value of no more than 256 characters.");
    }
    if (tag.Key.toLowerCase().startsWith("aws:")) invalid("Tag keys beginning with aws: are reserved.");
    if (Object.hasOwn(output, tag.Key)) invalid(`Duplicate tag key ${tag.Key}.`);
    output[tag.Key] = tag.Value;
  }
  return output;
}

export function secretValue(input: any, required: boolean): { kind: "SecretString" | "SecretBinary"; bytes: Buffer } | undefined {
  const hasString = input?.SecretString !== undefined;
  const hasBinary = input?.SecretBinary !== undefined;
  if (hasString && hasBinary) invalid("You must specify either SecretString or SecretBinary, but not both.");
  if (!hasString && !hasBinary) {
    if (required) invalid("You must specify SecretString or SecretBinary.");
    return undefined;
  }
  let bytes: Buffer;
  let kind: "SecretString" | "SecretBinary";
  if (hasString) {
    if (typeof input.SecretString !== "string") invalid("SecretString must be a string.");
    kind = "SecretString";
    bytes = Buffer.from(input.SecretString, "utf8");
  } else {
    if (typeof input.SecretBinary !== "string") invalid("SecretBinary must be base64-encoded.");
    const supplied = input.SecretBinary;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(supplied)) invalid("SecretBinary must be valid base64.");
    kind = "SecretBinary";
    bytes = Buffer.from(supplied, "base64");
    if (bytes.toString("base64") !== supplied) invalid("SecretBinary must be canonical base64.");
  }
  if (bytes.length < 1 || bytes.length > 65_536) invalid(`${kind} must contain between 1 and 65536 bytes.`);
  return { kind, bytes };
}

export function rejectUnsupported(input: any, fields: string[]): void {
  for (const field of fields) if (input?.[field] !== undefined) invalid(`${field} is not supported in PSS-02.`);
}

export function positiveInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid(`${name} must be between ${minimum} and ${maximum}.`);
  return Number(value);
}
