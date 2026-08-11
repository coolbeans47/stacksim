export type DynamicReferenceFamily = "ssm" | "ssm-secure" | "secretsmanager";

export interface ParsedDynamicReference {
  readonly literal: string;
  readonly family: DynamicReferenceFamily;
  readonly secret: boolean;
  readonly parameterName?: string;
  readonly parameterVersion?: number;
  readonly secretId?: string;
  readonly jsonKey?: string;
  readonly versionStage?: string;
  readonly versionId?: string;
}

const COMPLETE_REFERENCE = /\{\{resolve:[^{}]+\}\}/g;

export class DynamicReferenceError extends Error {
  readonly code = "ValidationError" as const;
  constructor(message: string, readonly path = "$") { super(`${message} at ${path}`); this.name = "DynamicReferenceError"; }
}

function fail(message: string, path: string): never { throw new DynamicReferenceError(message, path); }

export function parseDynamicReference(literal: string, path = "$"): ParsedDynamicReference {
  if (!literal.startsWith("{{resolve:") || !literal.endsWith("}}")) fail("Dynamic reference is malformed", path);
  const body = literal.slice(10, -2);
  if (body.endsWith("\\")) fail("Dynamic references cannot end with a backslash", path);
  if (body.startsWith("ssm-secure:") || body.startsWith("ssm:")) {
    const family: "ssm" | "ssm-secure" = body.startsWith("ssm-secure:") ? "ssm-secure" : "ssm";
    const source = body.slice(family.length + 1);
    const parts = source.split(":");
    if (parts.length > 2 || !parts[0] || !/^[A-Za-z0-9_.\-/]+$/.test(parts[0])) fail(`${family} dynamic reference has an invalid parameter name`, path);
    let parameterVersion: number | undefined;
    if (parts.length === 2) {
      if (!/^[1-9]\d*$/.test(parts[1])) fail(`${family} dynamic reference version must be a positive integer`, path);
      parameterVersion = Number(parts[1]);
      if (!Number.isSafeInteger(parameterVersion)) fail(`${family} dynamic reference version is too large`, path);
    }
    return { literal, family, secret: family === "ssm-secure", parameterName: parts[0], ...(parameterVersion === undefined ? {} : { parameterVersion }) };
  }
  if (body.startsWith("secretsmanager:")) {
    const source = body.slice("secretsmanager:".length);
    const separator = source.indexOf(":SecretString");
    if (separator <= 0) fail("Secrets Manager dynamic references require secret-id:SecretString", path);
    const secretId = source.slice(0, separator);
    const remainder = source.slice(separator + ":SecretString".length);
    if (remainder && !remainder.startsWith(":")) fail("Secrets Manager dynamic reference is malformed", path);
    const parts = remainder ? remainder.slice(1).split(":") : [];
    if (parts.length > 3) fail("Secrets Manager dynamic reference contains too many segments", path);
    const [jsonKey, versionStage, versionId] = parts;
    if (jsonKey?.includes(":")) fail("Secrets Manager JSON keys cannot contain a colon", path);
    if (versionStage && versionId) fail("Secrets Manager dynamic references cannot specify both version-stage and version-id", path);
    if (versionStage && !/^[A-Za-z0-9_+=.@-]{1,256}$/.test(versionStage)) fail("Secrets Manager version-stage is invalid", path);
    if (versionId && (versionId.length < 32 || versionId.length > 64 || !/^[A-Za-z0-9-]+$/.test(versionId))) fail("Secrets Manager version-id is invalid", path);
    return { literal, family: "secretsmanager", secret: true, secretId, ...(jsonKey ? { jsonKey } : {}), ...(versionStage ? { versionStage } : {}), ...(versionId ? { versionId } : {}) };
  }
  fail("Unsupported dynamic reference family", path);
}

export function dynamicReferencesInString(value: string, path = "$"): ParsedDynamicReference[] {
  const starts = value.match(/\{\{resolve:/g)?.length ?? 0;
  const literals = [...value.matchAll(COMPLETE_REFERENCE)].map(match => match[0]);
  if (starts !== literals.length) fail("Dynamic reference is unterminated or contains braces", path);
  return literals.map(literal => parseDynamicReference(literal, path));
}

export function collectDynamicReferences(value: unknown, path = "$"): Array<{ path: string; reference: ParsedDynamicReference }> {
  const found: Array<{ path: string; reference: ParsedDynamicReference }> = [];
  const visit = (candidate: unknown, currentPath: string): void => {
    if (typeof candidate === "string") { for (const reference of dynamicReferencesInString(candidate, currentPath)) found.push({ path: currentPath, reference }); return; }
    if (Array.isArray(candidate)) { candidate.forEach((item, index) => visit(item, `${currentPath}[${index}]`)); return; }
    if (!candidate || typeof candidate !== "object") return;
    if (!Array.isArray(candidate)) {
      const object = candidate as Record<string, unknown>;
      const joined = object["Fn::Join"];
      if (Object.keys(object).length === 1 && Array.isArray(joined) && joined.length === 2 && typeof joined[0] === "string" && Array.isArray(joined[1])) {
        const reconstructed = joined[1].map((part, index) => typeof part === "string" ? part : `__CFN_VALUE_${index}__`).join(joined[0]);
        if (reconstructed.includes("{{resolve:")) {
          for (const reference of dynamicReferencesInString(reconstructed, currentPath)) found.push({ path: currentPath, reference });
          return;
        }
      }
    }
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) visit(item, `${currentPath}.${key}`);
  };
  visit(value, path);
  return found;
}

export function containsDynamicReference(value: unknown): boolean { return collectDynamicReferences(value).length > 0; }
