import { AwsError } from "../errors.js";
import { wildcard } from "./query.js";

export interface RetentionPolicy {
  type: "retention"; name: string; policyVersion: string; description?: string;
  policy: { Rules: Array<{ ResourceType: "index"; Resource: string[]; MinIndexRetention?: string; NoMinIndexRetention?: true }> };
  createdDate: number; lastModifiedDate: number;
}
const invalid = (message: string): never => { throw new AwsError("ValidationException", message, 400); };
export function retentionMilliseconds(value: string): number {
  const match = /^(\d+)(h|d)$/.exec(value); if (!match) return invalid("Retention must be an integer number of hours (h) or days (d)");
  const duration = Number(match[1]) * (match[2] === "d" ? 86400000 : 3600000);
  if (duration < 86400000 || duration > 3650 * 86400000) invalid("Retention must be between 24h and 3650d");
  return duration;
}
export function parseRetentionPolicy(source: string): RetentionPolicy["policy"] {
  let policy: any; try { policy = JSON.parse(source); } catch { invalid("Policy must contain valid JSON"); }
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(key => key !== "Rules") || !Array.isArray(policy.Rules) || !policy.Rules.length || policy.Rules.length > 100) invalid("Retention policy requires 1–100 Rules");
  const resources = new Set<string>();
  for (const rule of policy.Rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).some(key => !["ResourceType", "Resource", "MinIndexRetention", "NoMinIndexRetention"].includes(key)) || rule.ResourceType !== "index") invalid("Retention rules apply only to indexes");
    if (!Array.isArray(rule.Resource) || !rule.Resource.length || rule.Resource.length > 100) invalid("Each rule requires 1–100 resources");
    for (const resource of rule.Resource) {
      if (typeof resource !== "string" || !/^index\/(?:[a-z][a-z0-9_-]*\*?|\*)\/(?:[a-z0-9][a-z0-9_.-]*\*?|\*)$/.test(resource)) invalid("Invalid retention index resource pattern");
      if (resources.has(resource)) invalid("A retention resource pattern may appear only once in a policy"); resources.add(resource);
    }
    if (rule.NoMinIndexRetention !== undefined && rule.NoMinIndexRetention !== true || Boolean(rule.NoMinIndexRetention) === (rule.MinIndexRetention !== undefined)) invalid("Choose MinIndexRetention or NoMinIndexRetention:true, not both");
    if (rule.MinIndexRetention !== undefined) retentionMilliseconds(rule.MinIndexRetention);
  }
  return policy;
}
export function effectiveRetention(policies: RetentionPolicy[], resource: string): { policyName?: string; retentionPeriod?: string; noMinRetentionPeriod: boolean; milliseconds: number } {
  const matches = policies.flatMap(policy => policy.policy.Rules.flatMap(rule => rule.Resource.filter(pattern => wildcard(pattern, resource)).map(pattern => ({ policy, rule, pattern }))));
  matches.sort((a, b) => b.pattern.replaceAll("*", "").length - a.pattern.replaceAll("*", "").length || a.policy.name.localeCompare(b.policy.name));
  const best = matches[0];
  if (!best) return { noMinRetentionPeriod: true, milliseconds: Infinity };
  return { policyName: best.policy.name, ...(best.rule.MinIndexRetention ? { retentionPeriod: best.rule.MinIndexRetention } : {}), noMinRetentionPeriod: Boolean(best.rule.NoMinIndexRetention), milliseconds: best.rule.MinIndexRetention ? retentionMilliseconds(best.rule.MinIndexRetention) : Infinity };
}
