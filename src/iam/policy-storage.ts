import type { PolicyDocument, PolicyStatement } from "../types.js";

const LIST_FIELDS = new Set(["Action", "NotAction", "Resource", "NotResource"]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(item => stable(item));
    return items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as object).sort().map(name => [name, stable((value as Record<string, unknown>)[name])]));
}

function normalizeLists(statement: PolicyStatement): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...statement };
  for (const field of LIST_FIELDS) if (normalized[field] !== undefined) normalized[field] = Array.isArray(normalized[field]) ? normalized[field] : [normalized[field]];
  for (const field of ["Principal", "NotPrincipal"]) {
    const principal = normalized[field];
    if (typeof principal === "string") normalized[field] = [principal];
    else if (principal && typeof principal === "object" && !Array.isArray(principal)) normalized[field] = Object.fromEntries(Object.entries(principal).map(([kind, value]) => [kind, Array.isArray(value) ? value : [value]]));
  }
  if (statement.Condition) normalized.Condition = Object.fromEntries(Object.entries(statement.Condition).map(([operator, entries]) => [operator, Object.fromEntries(Object.entries(entries).map(([conditionKey, value]) => [conditionKey, Array.isArray(value) ? value : [value]]))]));
  return normalized;
}

/** Stable internal representation; callers continue returning the separate semantic document. */
export function canonicalPolicyDocument(document: PolicyDocument): string {
  const statements = (Array.isArray(document.Statement) ? document.Statement : [document.Statement]).map(normalizeLists);
  return JSON.stringify(stable({ ...document, Statement: statements }));
}

export function storedPolicyDocument(document: PolicyDocument): { document: PolicyDocument; canonicalDocument: string } {
  const semantic = structuredClone(document);
  return { document: semantic, canonicalDocument: canonicalPolicyDocument(semantic) };
}
