import { createHash } from "node:crypto";
import { AwsError } from "../errors.js";
import { SearchAccess } from "./security.js";
import { wildcard } from "./query.js";

export interface ServerlessPolicy {
  type: "data" | "encryption" | "network";
  name: string;
  policyVersion: string;
  description?: string;
  policy: any;
  createdDate: number;
  lastModifiedDate: number;
}
const invalid = (message: string): never => { throw new AwsError("ValidationException", message, 400); };
function object(value: any, names: string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!names.includes(key)) invalid(`Unsupported ${label} field ${key}`);
}
function list(value: any, label: string): any[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) invalid(`${label} requires 1–100 entries`);
  return value;
}
const INDEX_PERMISSIONS: Record<string, string[]> = {
  "aoss:ReadDocument": ["indices:data/read/*", "indices:admin/analyze"],
  "aoss:WriteDocument": ["indices:data/write/*"],
  "aoss:CreateIndex": ["indices:admin/create"],
  "aoss:DeleteIndex": ["indices:admin/delete"],
  "aoss:UpdateIndex": ["indices:admin/mapping/put", "indices:admin/settings/update"],
  "aoss:DescribeIndex": ["indices:admin/get", "indices:admin/mappings/get", "indices:admin/settings/get"],
  "aoss:*": ["indices:*"],
};
const COLLECTION_PERMISSIONS: Record<string, string[]> = {
  "aoss:CreateCollectionItems": ["indices:admin/aliases", "cluster:admin/index_template/put"],
  "aoss:DeleteCollectionItems": ["indices:admin/aliases", "cluster:admin/index_template/delete"],
  "aoss:UpdateCollectionItems": ["indices:admin/aliases", "cluster:admin/index_template/put"],
  "aoss:DescribeCollectionItems": ["indices:admin/aliases/get", "cluster:admin/index_template/get"],
  "aoss:*": ["indices:admin/aliases*", "cluster:admin/index_template/*"],
};

/** Validate policy syntax before storing it; unknown security semantics never become allows. */
export function parseServerlessPolicy(type: ServerlessPolicy["type"], source: string): any {
  let document: any;
  try { document = JSON.parse(source); } catch { invalid("Policy must contain valid JSON"); }
  const statements = type === "encryption" ? [document] : list(document, "Policy");
  for (const statement of statements) {
    object(statement, type === "encryption" ? ["Rules", "AWSOwnedKey", "KmsARN"] : type === "network" ? ["Description", "Rules", "AllowFromPublic", "SourceVPCEs", "SourceServices"] : ["Description", "Rules", "Principal"], "policy");
    if (statement.Description !== undefined && typeof statement.Description !== "string") invalid("Description must be a string");
    if (type === "encryption" && (statement.AWSOwnedKey !== true || statement.KmsARN !== undefined)) invalid("Embedded Serverless currently requires AWSOwnedKey:true; local resource keys encrypt all collection data. Customer KMS keys are not implemented.");
    if (type === "network") {
      if (typeof statement.AllowFromPublic !== "boolean") invalid("AllowFromPublic must be a boolean");
      if (statement.SourceVPCEs?.length) invalid("Private endpoint network adapters are not implemented");
      for (const key of ["SourceVPCEs", "SourceServices"]) if (statement[key] !== undefined && !Array.isArray(statement[key])) invalid(`${key} must be an array`);
      if (statement.SourceServices?.some((service: unknown) => service !== 'application.opensearchservice.amazonaws.com')) invalid('Only the OpenSearch application service network adapter is implemented');
    }
    if (type === "data") for (const principal of list(statement.Principal, "Principal")) {
      if (typeof principal !== "string" || !/^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:(root|user\/[\w+=,.@\/-]+|role\/[\w+=,.@\/-]+)$/.test(principal)) invalid("Data access principals must be explicit IAM user, role or account root ARNs");
    }
    for (const rule of list(statement.Rules, "Rules")) {
      object(rule, type === "data" ? ["ResourceType", "Resource", "Permission"] : ["ResourceType", "Resource"], "rule");
      if (!(type === "encryption" ? ["collection"] : type === "network" ? ["collection", "dashboard"] : ["collection", "index"]).includes(rule.ResourceType)) invalid("Invalid policy resource type");
      for (const resource of list(rule.Resource, "Resource")) {
        const pattern = rule.ResourceType === "index" ? /^index\/(?:[a-z][a-z0-9_-]*\*?|\*)\/[^\s\\/,#?:]+$/ : /^collection\/(?:[a-z][a-z0-9_-]*\*?|\*)$/;
        if (typeof resource !== "string" || resource.length > 300 || !pattern.test(resource)) invalid(`Invalid policy resource ${String(resource)}`);
      }
      if (type === "data") for (const permission of list(rule.Permission, "Permission")) if (!Object.hasOwn(rule.ResourceType === "index" ? INDEX_PERMISSIONS : COLLECTION_PERMISSIONS, permission)) invalid(`Invalid permission ${permission} for ${rule.ResourceType}`);
    }
  }
  return document;
}

export function matchingEncryption(policies: ServerlessPolicy[], name: string): ServerlessPolicy | undefined {
  return policies.filter(policy => policy.type === "encryption" && policy.policy.Rules.some((rule: any) => rule.Resource.some((resource: string) => wildcard(resource, `collection/${name}`))))
    .sort((a, b) => Math.max(...b.policy.Rules.flatMap((r: any) => r.Resource.filter((p: string) => wildcard(p, `collection/${name}`)).map((p: string) => p.length))) - Math.max(...a.policy.Rules.flatMap((r: any) => r.Resource.filter((p: string) => wildcard(p, `collection/${name}`)).map((p: string) => p.length))))[0];
}

export function publicNetwork(policies: ServerlessPolicy[], name: string, kind = "collection", sourceService?: 'application.opensearchservice.amazonaws.com'): boolean {
  return policies.some(policy => policy.type === "network" && policy.policy.some((statement: any) => (statement.AllowFromPublic === true || sourceService && kind === 'collection' && statement.SourceServices?.includes(sourceService)) && statement.Rules.some((rule: any) => rule.ResourceType === kind && rule.Resource.some((pattern: string) => wildcard(pattern, `collection/${name}`)))));
}

export function serverlessAccess(policies: ServerlessPolicy[], collection: string, principal: string): SearchAccess {
  const permissions: Array<{ index_patterns: string[]; allowed_actions: string[] }> = [], cluster: string[] = [];
  for (const policy of policies.filter(value => value.type === "data")) for (const statement of policy.policy) {
    if (!statement.Principal.includes(principal)) continue;
    for (const rule of statement.Rules) for (const resource of rule.Resource) {
      const [, name, index] = resource.split("/");
      if (!wildcard(name, collection)) continue;
      const actions = rule.Permission.flatMap((permission: string) => (rule.ResourceType === "index" ? INDEX_PERMISSIONS : COLLECTION_PERMISSIONS)[permission]);
      permissions.push({ index_patterns: [index ?? "*"], allowed_actions: actions.filter((action: string) => action.startsWith("indices:")) });
      cluster.push(...actions.filter((action: string) => action.startsWith("cluster:")));
    }
  }
  // Root information and analysis reveal no index data. Index-level analysis is
  // still authorized against that index by the engine.
  if (permissions.length) cluster.push("cluster:monitor/main", "cluster:admin/analyze");
  const revision = createHash("sha256").update(JSON.stringify(policies.map(p => [p.type, p.name, p.policyVersion]).sort())).digest("hex");
  return new SearchAccess({ name: principal, backendRoles: [principal] }, false, [{ cluster_permissions: cluster, index_permissions: permissions }], revision);
}
