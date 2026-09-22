import { createHash } from "node:crypto";
import type { AuthorizationDecisionState, IamRoleState, PolicyDocument, PolicyStatement } from "../types.js";

export type PolicyLayer = "identity" | "resource" | "boundary" | "session" | "trust";
export interface PolicySource {
  kind: "managed" | "inline" | "resource" | "session" | "trust" | "standalone";
  policyArn?: string;
  versionId?: string;
  entityArn?: string;
  entityType?: "user" | "group" | "role" | "session";
  policyName?: string;
  service?: string;
  resourceArn?: string;
  revision?: string;
}
export interface PolicyProvenanceEntry {
  source: PolicySource;
  layer: PolicyLayer;
  statementIndex?: number;
  sid?: string;
  effect?: "Allow" | "Deny";
  matched: boolean;
  status: "evaluated" | "missing" | "invalid";
  /** Selector summaries only: never resolved variables, conditions or bodies. */
  actionScope?: "Action" | "NotAction";
  resourceScope?: "Resource" | "NotResource" | "implicit";
}
export interface AuthorizationProvenance {
  provenance?: PolicyProvenanceEntry[];
  provenanceTotalCount?: number;
  provenanceMatchedCount?: number;
  provenanceTruncated?: boolean;
  provenanceUnavailable?: boolean;
}
export interface SourcedPolicy { document?: PolicyDocument; source: PolicySource; layer: PolicyLayer }

/** Content-addressed revisions identify exact documents where no native
 * revision exists. Canonicalization never reorders statements. */
export function policyRevision(document: PolicyDocument): string {
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(document)) ?? "null").digest("hex")}`;
}
export function resourcePolicySource(service: string, resourceArn: string, document: PolicyDocument, revision?: string, policyName?: string): PolicySource {
  return { kind: "resource", service, resourceArn, revision: revision ?? policyRevision(document), ...(policyName ? { policyName } : {}) };
}
export function trustPolicySource(role: Pick<IamRoleState, "arn" | "assumeRolePolicyDocument">): PolicySource {
  return { kind: "trust", entityType: "role", entityArn: role.arn, revision: policyRevision(role.assumeRolePolicyDocument) };
}
export function statementProvenance(policy: SourcedPolicy, statement: PolicyStatement, statementIndex: number, matched: boolean): PolicyProvenanceEntry {
  return { source: policy.source, layer: policy.layer, statementIndex, ...(statement.Sid === undefined ? {} : { sid: statement.Sid }), effect: statement.Effect, matched, status: "evaluated", actionScope: statement.Action === undefined ? "NotAction" : "Action", resourceScope: statement.Resource !== undefined ? "Resource" : statement.NotResource !== undefined ? "NotResource" : "implicit" };
}
function orderKey(entry: PolicyProvenanceEntry): string {
  const source = entry.source;
  return JSON.stringify([entry.layer, source.kind, source.policyArn, source.entityArn, source.entityType, source.service, source.resourceArn, source.policyName, source.versionId, source.revision]);
}
/** Bound at every evaluation/combination, with stable source and statement order.
 * Counts describe the full evaluated set even when entries cannot be retained. */
export function boundProvenance(entries: PolicyProvenanceEntry[], total = entries.length, matched = entries.filter(entry => entry.matched).length, truncated = false, byteBudget = 16 * 1024 - 256): AuthorizationProvenance {
  const sorted = [...entries].sort((a, b) => { const left = orderKey(a); const right = orderKey(b); return left < right ? -1 : left > right ? 1 : (a.statementIndex ?? -1) - (b.statementIndex ?? -1); });
  const provenance: PolicyProvenanceEntry[] = [];
  let bytes = 2;
  for (const entry of sorted) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + (provenance.length ? 1 : 0);
    // Reserve space for counts/flags within the 16-KiB provenance envelope.
    if (provenance.length === 32 || bytes + size > byteBudget) break;
    provenance.push(entry); bytes += size;
  }
  return { provenance, provenanceTotalCount: total, provenanceMatchedCount: matched, provenanceTruncated: truncated || provenance.length < total };
}
export function mergeProvenance(...results: Array<AuthorizationProvenance | undefined>): AuthorizationProvenance {
  const present = results.filter((result): result is AuthorizationProvenance => Boolean(result));
  return boundProvenance(present.flatMap(result => result.provenance ?? []), present.reduce((sum, result) => sum + (result.provenanceTotalCount ?? result.provenance?.length ?? 0), 0), present.reduce((sum, result) => sum + (result.provenanceMatchedCount ?? result.provenance?.filter(entry => entry.matched).length ?? 0), 0), present.some(result => result.provenanceTruncated));
}

/** Copy only diagnostic fields into durable history. Never serialize a result's
 * policy documents, context, credentials or other future internal properties. */
export function decisionProvenance(result: AuthorizationProvenance): AuthorizationProvenance { return mergeProvenance(result); }

/** Account for the decision envelope as well as provenance when persisting. */
export function authorizationDecision(base: AuthorizationDecisionState, result: AuthorizationProvenance): AuthorizationDecisionState {
  const { time, requestId, principalArn, action, resource, decision, reason } = base;
  const fields: AuthorizationDecisionState = { time, requestId, principalArn, action, resource, decision, reason };
  const textFields = ["requestId", "principalArn", "action", "resource", "reason"] as const;
  // Usually only provenance needs bounding. A caller-controlled target can
  // itself exceed the envelope; retain an explicitly marked prefix in that case.
  while (Buffer.byteLength(JSON.stringify(fields)) > 12 * 1024) {
    const key = [...textFields].sort((a, b) => Buffer.byteLength(JSON.stringify(fields[b])) - Buffer.byteLength(JSON.stringify(fields[a])))[0];
    const characters = Array.from(fields[key]);
    fields[key] = characters.slice(0, Math.floor(characters.length / 2)).join("") + "…";
    fields.diagnosticFieldsTruncated = [...new Set([...(fields.diagnosticFieldsTruncated ?? []), key])];
  }
  const provenance = mergeProvenance(result);
  return { ...fields, ...boundProvenance(provenance.provenance ?? [], provenance.provenanceTotalCount, provenance.provenanceMatchedCount, provenance.provenanceTruncated, Math.max(2, 16 * 1024 - Buffer.byteLength(JSON.stringify(fields)) - 256)) };
}
