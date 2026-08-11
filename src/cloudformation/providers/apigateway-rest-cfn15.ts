import { createHash } from "node:crypto";
import type { ApiGatewayService } from "../../apigateway.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderFailed,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import { invokeJsonService } from "./service-invoker.js";

export const API_GATEWAY_DOMAIN_NAME_TYPE = "AWS::ApiGateway::DomainName";
export const API_GATEWAY_BASE_PATH_MAPPING_TYPE = "AWS::ApiGateway::BasePathMapping";
export const API_GATEWAY_DOMAIN_NAME_V2_TYPE = "AWS::ApiGateway::DomainNameV2";
export const API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE = "AWS::ApiGateway::BasePathMappingV2";
export const API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE = "AWS::ApiGateway::DomainNameAccessAssociation";
export const API_GATEWAY_VPC_LINK_TYPE = "AWS::ApiGateway::VpcLink";
export const API_GATEWAY_CLIENT_CERTIFICATE_TYPE = "AWS::ApiGateway::ClientCertificate";
export const API_GATEWAY_DOCUMENTATION_PART_TYPE = "AWS::ApiGateway::DocumentationPart";
export const API_GATEWAY_DOCUMENTATION_VERSION_TYPE = "AWS::ApiGateway::DocumentationVersion";

type JsonObject = Record<string, any>;
type Tag = { readonly Key: string; readonly Value: string };
type EndpointType = "EDGE" | "REGIONAL" | "PRIVATE";

interface EndpointConfigurationModel {
  readonly Types: readonly EndpointType[];
  readonly IpAddressType?: "ipv4" | "dualstack";
}

interface MutualTlsAuthenticationModel {
  readonly TruststoreUri: string;
  readonly TruststoreVersion?: string;
}

export interface ApiGatewayDomainNameModel {
  readonly CertificateArn?: string;
  readonly DomainName: string;
  readonly EndpointAccessMode?: "BASIC" | "STRICT";
  readonly EndpointConfiguration: EndpointConfigurationModel;
  readonly MutualTlsAuthentication?: MutualTlsAuthenticationModel;
  readonly OwnershipVerificationCertificateArn?: string;
  readonly RegionalCertificateArn?: string;
  readonly RoutingMode: "BASE_PATH_MAPPING_ONLY" | "ROUTING_RULE_ONLY" | "ROUTING_RULE_THEN_BASE_PATH_MAPPING";
  readonly SecurityPolicy: string;
  readonly Tags: readonly Tag[];
}

export interface ApiGatewayBasePathMappingModel {
  readonly BasePath: string;
  readonly DomainName: string;
  readonly RestApiId: string;
  readonly Stage: string;
}

export interface ApiGatewayDomainNameV2Model {
  readonly CertificateArn: string;
  readonly DomainName: string;
  readonly EndpointAccessMode?: "BASIC" | "STRICT";
  readonly EndpointConfiguration: EndpointConfigurationModel;
  readonly Policy?: string;
  readonly RoutingMode: "BASE_PATH_MAPPING_ONLY" | "ROUTING_RULE_ONLY" | "ROUTING_RULE_THEN_BASE_PATH_MAPPING";
  readonly SecurityPolicy: string;
  readonly Tags: readonly Tag[];
}

export interface ApiGatewayBasePathMappingV2Model {
  readonly BasePath: string;
  readonly DomainNameArn: string;
  readonly RestApiId: string;
  readonly Stage: string;
}

export interface ApiGatewayDomainNameAccessAssociationModel {
  readonly AccessAssociationSource: string;
  readonly AccessAssociationSourceType: "VPCE";
  readonly DomainNameArn: string;
  readonly Tags: readonly Tag[];
}

export interface ApiGatewayVpcLinkModel {
  readonly Description?: string;
  readonly Name: string;
  readonly Tags: readonly Tag[];
  readonly TargetArns: readonly string[];
}

export interface ApiGatewayClientCertificateModel {
  readonly Description?: string;
  readonly Tags: readonly Tag[];
}

export interface ApiGatewayDocumentationPartLocationModel {
  readonly Method?: string;
  readonly Name?: string;
  readonly Path?: string;
  readonly StatusCode?: string;
  readonly Type: string;
}

export interface ApiGatewayDocumentationPartModel {
  readonly Location: ApiGatewayDocumentationPartLocationModel;
  readonly Properties: string;
  readonly RestApiId: string;
}

export interface ApiGatewayDocumentationVersionModel {
  readonly Description?: string;
  readonly DocumentationVersion: string;
  readonly RestApiId: string;
}

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
const STACK_TAGS = Object.freeze({
  behavior: "STACK_AND_RESOURCE" as const,
  propertyName: "Tags",
  propagatesCloudFormationTags: true,
});
const CREATE_BEFORE_DELETE = Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const });
const PRIVATE_DOMAIN_REPLACEMENT = Object.freeze({
  defaultOrder: "DELETE_BEFORE_CREATE" as const,
  deleteBeforeCreateReason: "Private domain endpoint and security replacements retain an account/Region-unique domain name.",
});
const ASSOCIATION_REPLACEMENT = Object.freeze({
  defaultOrder: "DELETE_BEFORE_CREATE" as const,
  deleteBeforeCreateReason: "Domain access associations are unique for a private domain and VPC endpoint, and tags are create-only.",
});
const VPC_LINK_REPLACEMENT = Object.freeze({
  defaultOrder: "DELETE_BEFORE_CREATE" as const,
  deleteBeforeCreateReason: "VpcLink names are unique, including TargetArns replacements which retain Name.",
});

type UpdateBehavior = "MUTABLE" | "REPLACEMENT" | "CONDITIONAL_REPLACEMENT" | "NOT_SUPPORTED";
const stringProperty = (updateBehavior: UpdateBehavior, required = false) => Object.freeze({
  valueType: "string" as const,
  updateBehavior,
  ...(required ? { required: true } : {}),
});
const objectProperty = (updateBehavior: UpdateBehavior, required = false) => Object.freeze({
  valueType: "object" as const,
  updateBehavior,
  ...(required ? { required: true } : {}),
});
const arrayProperty = (updateBehavior: UpdateBehavior, required = false) => Object.freeze({
  valueType: "array" as const,
  updateBehavior,
  ...(required ? { required: true } : {}),
});
const anyProperty = (updateBehavior: UpdateBehavior) => Object.freeze({ valueType: "any" as const, updateBehavior });

export const API_GATEWAY_DOMAIN_NAME_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_DOMAIN_NAME_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    CertificateArn: stringProperty("MUTABLE"),
    DomainName: stringProperty("REPLACEMENT", true),
    EndpointAccessMode: stringProperty("MUTABLE"),
    EndpointConfiguration: objectProperty("MUTABLE"),
    MutualTlsAuthentication: objectProperty("MUTABLE"),
    OwnershipVerificationCertificateArn: stringProperty("MUTABLE"),
    RegionalCertificateArn: stringProperty("MUTABLE"),
    RoutingMode: stringProperty("MUTABLE"),
    SecurityPolicy: stringProperty("MUTABLE"),
    Tags: arrayProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Public custom domain name." }),
  attributes: Object.freeze({
    DistributionDomainName: Object.freeze({ valueType: "string" as const }),
    DistributionHostedZoneId: Object.freeze({ valueType: "string" as const }),
    DomainNameArn: Object.freeze({ valueType: "string" as const }),
    RegionalDomainName: Object.freeze({ valueType: "string" as const }),
    RegionalHostedZoneId: Object.freeze({ valueType: "string" as const }),
  }),
  replacement: CREATE_BEFORE_DELETE,
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const API_GATEWAY_BASE_PATH_MAPPING_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_BASE_PATH_MAPPING_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    BasePath: stringProperty("REPLACEMENT"),
    DomainName: stringProperty("REPLACEMENT", true),
    RestApiId: stringProperty("MUTABLE", true),
    Stage: stringProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "DomainName and BasePath separated by |." }),
  attributes: Object.freeze({}),
  replacement: CREATE_BEFORE_DELETE,
  retention: RETENTION,
  tags: NO_TAGS,
});

export const API_GATEWAY_DOMAIN_NAME_V2_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_DOMAIN_NAME_V2_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    CertificateArn: stringProperty("MUTABLE", true),
    DomainName: stringProperty("REPLACEMENT", true),
    EndpointAccessMode: stringProperty("MUTABLE"),
    EndpointConfiguration: objectProperty("REPLACEMENT"),
    Policy: anyProperty("MUTABLE"),
    RoutingMode: stringProperty("MUTABLE"),
    SecurityPolicy: stringProperty("REPLACEMENT"),
    Tags: arrayProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Private custom domain ARN." }),
  attributes: Object.freeze({
    DomainNameArn: Object.freeze({ valueType: "string" as const }),
    DomainNameId: Object.freeze({ valueType: "string" as const }),
  }),
  replacement: PRIVATE_DOMAIN_REPLACEMENT,
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const API_GATEWAY_BASE_PATH_MAPPING_V2_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    BasePath: stringProperty("REPLACEMENT"),
    DomainNameArn: stringProperty("REPLACEMENT", true),
    RestApiId: stringProperty("MUTABLE", true),
    Stage: stringProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Base path mapping ARN." }),
  attributes: Object.freeze({ BasePathMappingArn: Object.freeze({ valueType: "string" as const }) }),
  replacement: CREATE_BEFORE_DELETE,
  retention: RETENTION,
  tags: NO_TAGS,
});

export const API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AccessAssociationSource: stringProperty("REPLACEMENT", true),
    AccessAssociationSourceType: stringProperty("REPLACEMENT", true),
    DomainNameArn: stringProperty("REPLACEMENT", true),
    Tags: arrayProperty("REPLACEMENT"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Domain name access association ARN." }),
  attributes: Object.freeze({ DomainNameAccessAssociationArn: Object.freeze({ valueType: "string" as const }) }),
  replacement: ASSOCIATION_REPLACEMENT,
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const API_GATEWAY_VPC_LINK_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_VPC_LINK_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: stringProperty("MUTABLE"),
    Name: stringProperty("MUTABLE", true),
    Tags: arrayProperty("MUTABLE"),
    TargetArns: arrayProperty("REPLACEMENT", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "VPC link identifier." }),
  attributes: Object.freeze({ VpcLinkId: Object.freeze({ valueType: "string" as const }) }),
  replacement: VPC_LINK_REPLACEMENT,
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const API_GATEWAY_CLIENT_CERTIFICATE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_CLIENT_CERTIFICATE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: stringProperty("MUTABLE"),
    Tags: arrayProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Client certificate identifier." }),
  attributes: Object.freeze({ ClientCertificateId: Object.freeze({ valueType: "string" as const }) }),
  replacement: CREATE_BEFORE_DELETE,
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const API_GATEWAY_DOCUMENTATION_PART_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_DOCUMENTATION_PART_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Location: objectProperty("REPLACEMENT", true),
    Properties: stringProperty("MUTABLE", true),
    RestApiId: stringProperty("REPLACEMENT", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Documentation part identifier." }),
  attributes: Object.freeze({ DocumentationPartId: Object.freeze({ valueType: "string" as const }) }),
  replacement: CREATE_BEFORE_DELETE,
  retention: RETENTION,
  tags: NO_TAGS,
});

export const API_GATEWAY_DOCUMENTATION_VERSION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_DOCUMENTATION_VERSION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: stringProperty("MUTABLE"),
    DocumentationVersion: stringProperty("REPLACEMENT", true),
    RestApiId: stringProperty("REPLACEMENT", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "DocumentationVersion and RestApiId separated by |." }),
  attributes: Object.freeze({}),
  replacement: CREATE_BEFORE_DELETE,
  retention: RETENTION,
  tags: NO_TAGS,
});

const ROUTING_MODES = new Set(["BASE_PATH_MAPPING_ONLY", "ROUTING_RULE_ONLY", "ROUTING_RULE_THEN_BASE_PATH_MAPPING"]);
const SECURITY_POLICIES = new Set([
  "TLS_1_0",
  "TLS_1_2",
  "SecurityPolicy_TLS12_2018_EDGE",
  "SecurityPolicy_TLS12_PFS_2025_EDGE",
  "SecurityPolicy_TLS13_1_2_2021_06",
  "SecurityPolicy_TLS13_1_2_FIPS_PFS_PQ_2025_09",
  "SecurityPolicy_TLS13_1_2_FIPS_PQ_2025_09",
  "SecurityPolicy_TLS13_1_2_PFS_PQ_2025_09",
  "SecurityPolicy_TLS13_1_2_PQ_2025_09",
  "SecurityPolicy_TLS13_1_3_2025_09",
  "SecurityPolicy_TLS13_1_3_FIPS_2025_09",
  "SecurityPolicy_TLS13_2025_EDGE",
]);
const DOCUMENTATION_PART_TYPES = new Set([
  "API", "AUTHORIZER", "MODEL", "RESOURCE", "METHOD", "PATH_PARAMETER", "QUERY_PARAMETER",
  "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE", "RESPONSE_HEADER", "RESPONSE_BODY",
]);
const OWNER_TAG_KEY = "stacksim:cloudformation:owner";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}

function withoutUndefined(value: any): any {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, withoutUndefined(item)]));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function issue(
  path: string,
  message: string,
  code: ProviderValidationIssue["code"] = "InvalidProperty",
): ProviderValidationIssue {
  return { code, path, message };
}

function throwIssues(issues: readonly ProviderValidationIssue[]): void {
  if (issues.length) throw new TypeError(issues.map(value => `${value.path}: ${value.message}`).join("; "));
}

function failure(error: unknown): ProviderFailed {
  if (error instanceof AwsError) {
    return {
      status: "FAILED",
      errorCode: error.code,
      message: error.message,
      ...(error.status >= 500 ? { retryable: true } : {}),
    };
  }
  return {
    status: "FAILED",
    errorCode: "InternalFailure",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof AwsError && ["NotFoundException", "ResourceNotFoundException"].includes(error.code);
}

async function call<T>(
  service: ApiGatewayService,
  method: string,
  path: string,
  input?: unknown,
  cloudFormationIdempotencyKey?: string,
  cloudFormationOwner?: string,
): Promise<T> {
  return (await invokeJsonService<T>({
    method,
    path,
    input,
    cloudFormationIdempotencyKey,
    cloudFormationOwner,
    handle: service.handle.bind(service),
  })).body;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function physical(kind: string, values: readonly string[]): string {
  return `stacksim:apigateway:${kind}:${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
}

function parsePhysical(value: string, kind: string, count: number): string[] {
  const prefix = `stacksim:apigateway:${kind}:`;
  try {
    const parts = JSON.parse(Buffer.from(value.startsWith(prefix) ? value.slice(prefix.length) : "", "base64url").toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== count || parts.some(part => typeof part !== "string" || !part)) throw new Error();
    return parts;
  } catch {
    throw new AwsError("InvalidPhysicalResourceId", `Invalid API Gateway ${kind} physical resource identifier`, 400);
  }
}

function plan<Model>(
  previous: Model | undefined,
  desired: Model,
  schema: ProviderSchema,
  replacements: readonly string[],
  replacementOrder?: (changed: readonly string[]) => "CREATE_BEFORE_DELETE" | "DELETE_BEFORE_CREATE",
): ProviderPlan<Model> {
  const names = Object.keys(schema.properties).sort();
  if (!previous) {
    return {
      action: "CREATE",
      desired,
      changedProperties: names.filter(name => (desired as any)[name] !== undefined),
      replacementProperties: [],
    };
  }
  const changedProperties = names.filter(name => !same((previous as any)[name], (desired as any)[name]));
  if (!changedProperties.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacementProperties = changedProperties.filter(name => replacements.includes(name));
  return replacementProperties.length
    ? {
        action: "REPLACE",
        desired,
        changedProperties,
        replacementProperties,
        replacementOrder: replacementOrder?.(changedProperties) ?? schema.replacement.defaultOrder,
      }
    : { action: "UPDATE", desired, changedProperties, replacementProperties: [] };
}

function getAtt(typeName: string, schema: ProviderSchema, model: ProviderReadModel<any>, attribute: string): unknown {
  if (!Object.hasOwn(schema.attributes, attribute)) throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`);
  return model.attributes[attribute];
}

function success<Model>(physicalId: string, model: ProviderReadModel<Model>): ProviderSuccess<Model> {
  return { status: "SUCCESS", physicalId, model };
}

function rejectUnknown(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: ProviderValidationIssue[],
): void {
  if (!isObject(value)) return;
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) issues.push(issue(`${path}.${key}`, `${path} does not support ${key}`, "UnsupportedProperty"));
  }
}

function requiredNonEmptyString(input: JsonObject, name: string, issues: ProviderValidationIssue[]): void {
  if (typeof input[name] === "string" && !input[name].trim()) {
    issues.push(issue(`Properties.${name}`, `${name} must not be empty`));
  }
}

function normalizeDomainName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function validateDomainName(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string") return;
  const name = normalizeDomainName(value);
  const labels = name.replace(/^\*\./, "").split(".");
  if (
    name.length > 253
    || labels.length < 2
    || labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    || (name.includes("*") && !name.startsWith("*."))
  ) {
    issues.push(issue(path, "DomainName must be a valid DNS host name with an optional leftmost wildcard"));
  }
}

function validateCertificateArn(
  value: unknown,
  path: string,
  context: ProviderContext,
  issues: ProviderValidationIssue[],
): void {
  if (value === undefined) return;
  const expression = new RegExp(`^arn:${context.partition}:acm:${context.region}:${context.accountId}:certificate\\/[A-Za-z0-9-]+$`);
  if (typeof value !== "string" || !expression.test(value)) {
    issues.push(issue(path, "Certificate ARN must identify an ACM certificate in this account and Region"));
  }
}

function validateTags(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > 49) issues.push(issue(path, `${path} can contain at most 49 tags because stacksim reserves one ownership tag`));
  const keys = new Set<string>();
  value.forEach((tag, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(tag)) {
      issues.push(issue(itemPath, "Tag must be an object", "InvalidType"));
      return;
    }
    rejectUnknown(tag, itemPath, ["Key", "Value"], issues);
    if (typeof tag.Key !== "string" || !tag.Key) issues.push(issue(`${itemPath}.Key`, "Tag Key is required"));
    else if (keys.has(tag.Key)) issues.push(issue(`${itemPath}.Key`, `Duplicate tag key ${tag.Key}`));
    else keys.add(tag.Key);
    if (tag.Key === OWNER_TAG_KEY) issues.push(issue(`${itemPath}.Key`, `${OWNER_TAG_KEY} is reserved by stacksim`));
    if (
      typeof tag.Key === "string"
      && (tag.Key.length > 128 || tag.Key.toLowerCase().startsWith("aws:") || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(tag.Key))
    ) issues.push(issue(`${itemPath}.Key`, "Tag Key is invalid"));
    if (typeof tag.Value !== "string") issues.push(issue(`${itemPath}.Value`, "Tag Value must be a string", "InvalidType"));
    else if (tag.Value.length > 256 || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(tag.Value)) {
      issues.push(issue(`${itemPath}.Value`, "Tag Value is invalid"));
    }
  });
}

function canonicalTags(value: unknown): readonly Tag[] {
  return Object.freeze((Array.isArray(value) ? value : [])
    .map(tag => Object.freeze({ Key: String(tag.Key), Value: String(tag.Value) }))
    .sort((left, right) => left.Key.localeCompare(right.Key)));
}

function userTagsFromRaw(value: unknown): readonly Tag[] {
  const map = isObject(value) ? value : {};
  return Object.freeze(Object.entries(map)
    .filter(([key]) => key !== OWNER_TAG_KEY)
    .map(([Key, Value]) => Object.freeze({ Key, Value: String(Value) }))
    .sort((left, right) => left.Key.localeCompare(right.Key)));
}

function ownerValue(context: ProviderContext): string {
  return createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
}

function serviceTagMap(tags: readonly Tag[], context: ProviderContext): Record<string, string> {
  return { ...Object.fromEntries(tags.map(tag => [tag.Key, tag.Value])), [OWNER_TAG_KEY]: ownerValue(context) };
}

function assertOwned(rawTags: unknown, context: ProviderContext, label: string): void {
  const tags = isObject(rawTags) ? rawTags : {};
  if (tags[OWNER_TAG_KEY] !== ownerValue(context)) {
    throw new AwsError("OwnershipConflict", `${label} is not owned by this CloudFormation stack resource`, 409);
  }
}

async function reconcileTags(
  service: ApiGatewayService,
  resourceArn: string,
  current: unknown,
  desired: readonly Tag[],
  context: ProviderContext,
): Promise<void> {
  const before = isObject(current) ? Object.fromEntries(Object.entries(current).map(([key, value]) => [key, String(value)])) : {};
  const after = serviceTagMap(desired, context);
  const removed = Object.keys(before).filter(key => !Object.hasOwn(after, key));
  if (removed.length) {
    const query = new URLSearchParams();
    for (const key of removed) query.append("tagKeys", key);
    await call(service, "DELETE", `/tags/${segment(resourceArn)}?${query.toString()}`);
  }
  const changed = Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key] !== value));
  if (Object.keys(changed).length) await call(service, "PUT", `/tags/${segment(resourceArn)}`, { tags: changed });
}

async function listAll(service: ApiGatewayService, basePath: string): Promise<JsonObject[]> {
  const items: JsonObject[] = [];
  let position: string | undefined;
  do {
    const url = new URL(basePath, "http://stacksim.local");
    url.searchParams.set("limit", "500");
    if (position) url.searchParams.set("position", position);
    const page = await call<JsonObject>(service, "GET", `${url.pathname}${url.search}`);
    items.push(...(Array.isArray(page.item) ? page.item : []));
    position = typeof page.position === "string" && page.position ? page.position : undefined;
  } while (position);
  return items;
}

function patchValue(path: string, value: unknown): JsonObject {
  return value === undefined ? { op: "remove", path } : { op: "replace", path, value };
}

function endpointConfigurationIssues(
  value: unknown,
  path: string,
  allowedTypes: readonly EndpointType[],
  issues: ProviderValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isObject(value)) return;
  rejectUnknown(value, path, ["Types", "IpAddressType"], issues);
  if (value.Types !== undefined) {
    if (!Array.isArray(value.Types) || value.Types.length !== 1 || !allowedTypes.includes(value.Types[0])) {
      issues.push(issue(`${path}.Types`, `Types must contain exactly one of ${allowedTypes.join(", ")}`));
    }
  }
  if (value.IpAddressType !== undefined && !["ipv4", "dualstack"].includes(value.IpAddressType)) {
    issues.push(issue(`${path}.IpAddressType`, "IpAddressType must be ipv4 or dualstack"));
  }
}

function canonicalEndpointConfiguration(value: unknown, defaultType: EndpointType): EndpointConfigurationModel {
  const input = isObject(value) ? value : {};
  return Object.freeze({
    Types: Object.freeze([String(Array.isArray(input.Types) ? input.Types[0] : defaultType) as EndpointType]),
    ...(input.IpAddressType === undefined ? {} : { IpAddressType: String(input.IpAddressType) as "ipv4" | "dualstack" }),
  });
}

function serviceEndpointConfiguration(value: EndpointConfigurationModel): JsonObject {
  return { types: [...value.Types], ...(value.IpAddressType === undefined ? {} : { ipAddressType: value.IpAddressType }) };
}

function canonicalMutualTls(value: unknown): MutualTlsAuthenticationModel | undefined {
  if (!isObject(value)) return undefined;
  return Object.freeze({
    TruststoreUri: String(value.TruststoreUri),
    ...(value.TruststoreVersion === undefined ? {} : { TruststoreVersion: String(value.TruststoreVersion) }),
  });
}

function serviceMutualTls(value: MutualTlsAuthenticationModel | undefined): JsonObject | undefined {
  if (!value) return undefined;
  return {
    truststoreUri: value.TruststoreUri,
    ...(value.TruststoreVersion === undefined ? {} : { truststoreVersion: value.TruststoreVersion }),
  };
}

function publicDomainIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_DOMAIN_NAME_SCHEMA);
  if (!isObject(properties)) return issues;
  requiredNonEmptyString(properties, "DomainName", issues);
  validateDomainName(properties.DomainName, "Properties.DomainName", issues);
  validateTags(properties.Tags, "Properties.Tags", issues);
  endpointConfigurationIssues(
    properties.EndpointConfiguration,
    "Properties.EndpointConfiguration",
    ["EDGE", "REGIONAL"],
    issues,
  );
  validateCertificateArn(properties.CertificateArn, "Properties.CertificateArn", context, issues);
  validateCertificateArn(properties.RegionalCertificateArn, "Properties.RegionalCertificateArn", context, issues);
  validateCertificateArn(
    properties.OwnershipVerificationCertificateArn,
    "Properties.OwnershipVerificationCertificateArn",
    context,
    issues,
  );
  if (properties.RoutingMode !== undefined && !ROUTING_MODES.has(properties.RoutingMode)) {
    issues.push(issue("Properties.RoutingMode", "RoutingMode is invalid"));
  }
  if (properties.SecurityPolicy !== undefined && !SECURITY_POLICIES.has(properties.SecurityPolicy)) {
    issues.push(issue("Properties.SecurityPolicy", "SecurityPolicy is not supported by the local API Gateway service"));
  }
  if (properties.EndpointAccessMode !== undefined && !["BASIC", "STRICT"].includes(properties.EndpointAccessMode)) {
    issues.push(issue("Properties.EndpointAccessMode", "EndpointAccessMode must be BASIC or STRICT"));
  }
  if (isObject(properties.MutualTlsAuthentication)) {
    rejectUnknown(
      properties.MutualTlsAuthentication,
      "Properties.MutualTlsAuthentication",
      ["TruststoreUri", "TruststoreVersion"],
      issues,
    );
    if (
      typeof properties.MutualTlsAuthentication.TruststoreUri !== "string"
      || !/^s3:\/\/[A-Za-z0-9.-]{3,63}\/.+/.test(properties.MutualTlsAuthentication.TruststoreUri)
    ) {
      issues.push(issue(
        "Properties.MutualTlsAuthentication.TruststoreUri",
        "TruststoreUri must be an S3 URI with a bucket and object key",
      ));
    }
    if (
      properties.MutualTlsAuthentication.TruststoreVersion !== undefined
      && typeof properties.MutualTlsAuthentication.TruststoreVersion !== "string"
    ) {
      issues.push(issue(
        "Properties.MutualTlsAuthentication.TruststoreVersion",
        "TruststoreVersion must be a string",
        "InvalidType",
      ));
    }
  }
  const endpointType = isObject(properties.EndpointConfiguration) && Array.isArray(properties.EndpointConfiguration.Types)
    ? properties.EndpointConfiguration.Types[0]
    : "EDGE";
  if (endpointType === "EDGE") {
    if (typeof properties.CertificateArn !== "string" || !properties.CertificateArn) {
      issues.push(issue("Properties.CertificateArn", "CertificateArn is required for an EDGE domain"));
    }
    if (properties.RegionalCertificateArn !== undefined) {
      issues.push(issue("Properties.RegionalCertificateArn", "RegionalCertificateArn is supported only for REGIONAL domains"));
    }
    if (properties.MutualTlsAuthentication !== undefined) {
      issues.push(issue("Properties.MutualTlsAuthentication", "MutualTlsAuthentication is supported only for REGIONAL domains"));
    }
  } else if (endpointType === "REGIONAL") {
    if (typeof properties.RegionalCertificateArn !== "string" || !properties.RegionalCertificateArn) {
      issues.push(issue("Properties.RegionalCertificateArn", "RegionalCertificateArn is required for a REGIONAL domain"));
    }
    if (properties.CertificateArn !== undefined) {
      issues.push(issue("Properties.CertificateArn", "CertificateArn is supported only for EDGE domains"));
    }
  }
  const securityPolicy = String(properties.SecurityPolicy ?? "TLS_1_2");
  if (properties.EndpointAccessMode !== undefined && !securityPolicy.startsWith("SecurityPolicy_")) {
    issues.push(issue("Properties.EndpointAccessMode", "EndpointAccessMode requires a modern SecurityPolicy_ policy"));
  }
  return issues;
}

function canonicalPublicDomain(properties: unknown, context: ProviderContext): ApiGatewayDomainNameModel {
  const issues = publicDomainIssues(properties, context);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    ...(input.CertificateArn === undefined ? {} : { CertificateArn: String(input.CertificateArn) }),
    DomainName: normalizeDomainName(String(input.DomainName)),
    ...(input.EndpointAccessMode === undefined ? {} : { EndpointAccessMode: input.EndpointAccessMode as "BASIC" | "STRICT" }),
    EndpointConfiguration: canonicalEndpointConfiguration(input.EndpointConfiguration, "EDGE"),
    ...(input.MutualTlsAuthentication === undefined
      ? {}
      : { MutualTlsAuthentication: canonicalMutualTls(input.MutualTlsAuthentication) }),
    ...(input.OwnershipVerificationCertificateArn === undefined
      ? {}
      : { OwnershipVerificationCertificateArn: String(input.OwnershipVerificationCertificateArn) }),
    ...(input.RegionalCertificateArn === undefined
      ? {}
      : { RegionalCertificateArn: String(input.RegionalCertificateArn) }),
    RoutingMode: input.RoutingMode ?? "BASE_PATH_MAPPING_ONLY",
    SecurityPolicy: input.SecurityPolicy ?? "TLS_1_2",
    Tags: canonicalTags(input.Tags),
  });
}

function publicDomainFromRaw(raw: JsonObject): ApiGatewayDomainNameModel {
  const mutualTls = raw.mutualTlsAuthentication;
  return Object.freeze({
    ...(raw.certificateArn === undefined ? {} : { CertificateArn: String(raw.certificateArn) }),
    DomainName: normalizeDomainName(String(raw.domainName)),
    ...(raw.endpointAccessMode === undefined ? {} : { EndpointAccessMode: raw.endpointAccessMode as "BASIC" | "STRICT" }),
    EndpointConfiguration: canonicalEndpointConfiguration({
      Types: raw.endpointConfiguration?.types,
      IpAddressType: raw.endpointConfiguration?.ipAddressType,
    }, "EDGE"),
    ...(mutualTls === undefined
      ? {}
      : {
          MutualTlsAuthentication: Object.freeze({
            TruststoreUri: String(mutualTls.truststoreUri),
            ...(mutualTls.truststoreVersion === undefined
              ? {}
              : { TruststoreVersion: String(mutualTls.truststoreVersion) }),
          }),
        }),
    ...(raw.ownershipVerificationCertificateArn === undefined
      ? {}
      : { OwnershipVerificationCertificateArn: String(raw.ownershipVerificationCertificateArn) }),
    ...(raw.regionalCertificateArn === undefined
      ? {}
      : { RegionalCertificateArn: String(raw.regionalCertificateArn) }),
    RoutingMode: raw.routingMode ?? "BASE_PATH_MAPPING_ONLY",
    SecurityPolicy: raw.securityPolicy ?? "TLS_1_2",
    Tags: userTagsFromRaw(raw.tags),
  });
}

function publicDomainInput(model: ApiGatewayDomainNameModel, context: ProviderContext): JsonObject {
  return withoutUndefined({
    certificateArn: model.CertificateArn,
    domainName: model.DomainName,
    endpointAccessMode: model.EndpointAccessMode,
    endpointConfiguration: serviceEndpointConfiguration(model.EndpointConfiguration),
    mutualTlsAuthentication: serviceMutualTls(model.MutualTlsAuthentication),
    ownershipVerificationCertificateArn: model.OwnershipVerificationCertificateArn,
    regionalCertificateArn: model.RegionalCertificateArn,
    routingMode: model.RoutingMode,
    securityPolicy: model.SecurityPolicy,
    tags: serviceTagMap(model.Tags, context),
  });
}

function publicDomainPath(domainName: string): string {
  return `/domainnames/${segment(domainName)}`;
}

async function readPublicDomainRaw(service: ApiGatewayService, domainName: string): Promise<JsonObject> {
  return call<JsonObject>(service, "GET", publicDomainPath(domainName));
}

function publicDomainReadModel(raw: JsonObject): ProviderReadModel<ApiGatewayDomainNameModel> {
  const domainName = normalizeDomainName(String(raw.domainName));
  return {
    physicalId: physical("domain-name", [domainName]),
    properties: publicDomainFromRaw(raw),
    attributes: {
      DistributionDomainName: String(raw.distributionDomainName ?? ""),
      DistributionHostedZoneId: String(raw.distributionHostedZoneId ?? ""),
      DomainNameArn: String(raw.domainNameArn),
      RegionalDomainName: String(raw.regionalDomainName ?? ""),
      RegionalHostedZoneId: String(raw.regionalHostedZoneId ?? ""),
    },
  };
}

export function createApiGatewayDomainNameProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayDomainNameModel> {
  return {
    typeName: API_GATEWAY_DOMAIN_NAME_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_DOMAIN_NAME_SCHEMA,
    validate(properties, context) { return publicDomainIssues(properties, context); },
    canonicalize(properties, context) { return canonicalPublicDomain(properties, context); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_DOMAIN_NAME_SCHEMA, ["DomainName"]);
    },
    async create(desired, context) {
      try {
        try {
          const existing = await readPublicDomainRaw(service, desired.DomainName);
          assertOwned(existing.tags, context, `Domain name ${desired.DomainName}`);
          const model = publicDomainReadModel(existing);
          if (same(model.properties, desired)) return success(model.physicalId, model);
          throw new AwsError(
            "ConflictException",
            `Domain name ${desired.DomainName} already exists with different properties`,
            409,
          );
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        const raw = await call<JsonObject>(
          service,
          "POST",
          "/domainnames",
          publicDomainInput(desired, context),
          context.idempotencyKey,
        );
        const model = publicDomainReadModel(await readPublicDomainRaw(service, String(raw.domainName)));
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayDomainNameModel>> {
      try {
        const [domainName] = parsePhysical(physicalId, "domain-name", 1);
        const raw = await readPublicDomainRaw(service, domainName);
        assertOwned(raw.tags, context, `Domain name ${domainName}`);
        return success(physicalId, { ...publicDomainReadModel(raw), physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayDomainNameModel>> {
      try {
        const [domainName] = parsePhysical(physicalId, "domain-name", 1);
        if (domainName !== desired.DomainName || previous.DomainName !== desired.DomainName) {
          throw new AwsError("RequiresReplacement", "DomainName changes require replacement", 409);
        }
        const current = await readPublicDomainRaw(service, domainName);
        assertOwned(current.tags, context, `Domain name ${domainName}`);
        const input = publicDomainInput(desired, context);
        const patchOperations = [
          patchValue("/certificateArn", input.certificateArn),
          patchValue("/endpointAccessMode", input.endpointAccessMode),
          patchValue("/endpointConfiguration", input.endpointConfiguration),
          patchValue("/mutualTlsAuthentication", input.mutualTlsAuthentication),
          patchValue("/ownershipVerificationCertificateArn", input.ownershipVerificationCertificateArn),
          patchValue("/regionalCertificateArn", input.regionalCertificateArn),
          patchValue("/routingMode", input.routingMode),
          patchValue("/securityPolicy", input.securityPolicy),
        ];
        await call(service, "PATCH", publicDomainPath(domainName), { patchOperations });
        await reconcileTags(service, String(current.domainNameArn), current.tags, desired.Tags, context);
        const model = publicDomainReadModel(await readPublicDomainRaw(service, domainName));
        return success(physicalId, { ...model, physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [domainName] = parsePhysical(physicalId, "domain-name", 1);
        const raw = await readPublicDomainRaw(service, domainName);
        assertOwned(raw.tags, context, `Domain name ${domainName}`);
        await call(service, "DELETE", publicDomainPath(domainName));
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.properties.DomainName; },
    getAtt(model, attribute) {
      return getAtt(API_GATEWAY_DOMAIN_NAME_TYPE, API_GATEWAY_DOMAIN_NAME_SCHEMA, model, attribute);
    },
  };
}

function normalizeBasePath(value: unknown): string {
  return value === undefined || value === null || value === "" ? "(none)" : String(value);
}

function basePathIssues(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (value === undefined || value === "") return;
  if (typeof value !== "string") return;
  if (
    value === "(none)"
      ? false
      : value.length > 300
        || value.startsWith("/")
        || value.endsWith("/")
        || value.split("/").some(part => !part || !/^[A-Za-z0-9._~-]+$/.test(part))
  ) {
    issues.push(issue(path, "BasePath must contain URL path segments without leading or trailing slashes"));
  }
}

function basePathMappingIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_BASE_PATH_MAPPING_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["DomainName", "RestApiId"]) requiredNonEmptyString(properties, name, issues);
  validateDomainName(properties.DomainName, "Properties.DomainName", issues);
  basePathIssues(properties.BasePath, "Properties.BasePath", issues);
  if (properties.Stage !== undefined && (typeof properties.Stage !== "string" || !properties.Stage.trim())) {
    issues.push(issue("Properties.Stage", "Stage must be a non-empty string when specified"));
  }
  return issues;
}

function canonicalBasePathMapping(properties: unknown): ApiGatewayBasePathMappingModel {
  const issues = basePathMappingIssues(properties);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    BasePath: normalizeBasePath(input.BasePath),
    DomainName: normalizeDomainName(String(input.DomainName)),
    RestApiId: String(input.RestApiId),
    Stage: normalizeBasePath(input.Stage),
  });
}

function basePathMappingFromRaw(domainName: string, raw: JsonObject): ApiGatewayBasePathMappingModel {
  return Object.freeze({
    BasePath: normalizeBasePath(raw.basePath),
    DomainName: normalizeDomainName(domainName),
    RestApiId: String(raw.restApiId),
    Stage: normalizeBasePath(raw.stage),
  });
}

function mappingCollectionPath(domainName: string, domainNameId?: string): string {
  const query = domainNameId ? `?domainNameId=${encodeURIComponent(domainNameId)}` : "";
  return `${publicDomainPath(domainName)}/basepathmappings${query}`;
}

function mappingItemPath(domainName: string, basePath: string, domainNameId?: string): string {
  const query = domainNameId ? `?domainNameId=${encodeURIComponent(domainNameId)}` : "";
  return `${publicDomainPath(domainName)}/basepathmappings/${segment(basePath)}${query}`;
}

async function readBasePathMappingRaw(
  service: ApiGatewayService,
  domainName: string,
  basePath: string,
  domainNameId?: string,
  cloudFormationOwner?: string,
): Promise<JsonObject> {
  return call<JsonObject>(
    service,
    "GET",
    mappingItemPath(domainName, basePath, domainNameId),
    undefined,
    undefined,
    cloudFormationOwner,
  );
}

function basePathMappingReadModel(
  domainName: string,
  raw: JsonObject,
): ProviderReadModel<ApiGatewayBasePathMappingModel> {
  const model = basePathMappingFromRaw(domainName, raw);
  return {
    physicalId: physical("base-path-mapping", [model.DomainName, model.BasePath]),
    properties: model,
    attributes: {},
  };
}

export function createApiGatewayBasePathMappingProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayBasePathMappingModel> {
  return {
    typeName: API_GATEWAY_BASE_PATH_MAPPING_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_BASE_PATH_MAPPING_SCHEMA,
    validate(properties) { return basePathMappingIssues(properties); },
    canonicalize(properties) { return canonicalBasePathMapping(properties); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_BASE_PATH_MAPPING_SCHEMA, ["BasePath", "DomainName"]);
    },
    async create(desired, context) {
      try {
        await call(service, "POST", mappingCollectionPath(desired.DomainName), {
          basePath: desired.BasePath,
          restApiId: desired.RestApiId,
          stage: desired.Stage,
        }, context.idempotencyKey, ownerValue(context));
        const model = basePathMappingReadModel(
          desired.DomainName,
          await readBasePathMappingRaw(
            service,
            desired.DomainName,
            desired.BasePath,
            undefined,
            ownerValue(context),
          ),
        );
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayBasePathMappingModel>> {
      try {
        const [domainName, basePath] = parsePhysical(physicalId, "base-path-mapping", 2);
        const model = basePathMappingReadModel(
          domainName,
          await readBasePathMappingRaw(service, domainName, basePath, undefined, ownerValue(context)),
        );
        return success(physicalId, { ...model, physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayBasePathMappingModel>> {
      try {
        const [domainName, basePath] = parsePhysical(physicalId, "base-path-mapping", 2);
        if (
          domainName !== desired.DomainName
          || basePath !== desired.BasePath
          || previous.DomainName !== desired.DomainName
          || previous.BasePath !== desired.BasePath
        ) {
          throw new AwsError("RequiresReplacement", "DomainName and BasePath changes require replacement", 409);
        }
        await call(service, "PATCH", mappingItemPath(domainName, basePath), {
          patchOperations: [
            patchValue("/restApiId", desired.RestApiId),
            patchValue("/stage", desired.Stage),
          ],
        }, undefined, ownerValue(context));
        const model = basePathMappingReadModel(
          domainName,
          await readBasePathMappingRaw(service, domainName, basePath, undefined, ownerValue(context)),
        );
        return success(physicalId, { ...model, physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [domainName, basePath] = parsePhysical(physicalId, "base-path-mapping", 2);
        await call(
          service,
          "DELETE",
          mappingItemPath(domainName, basePath),
          undefined,
          undefined,
          ownerValue(context),
        );
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return `${model.properties.DomainName}|${model.properties.BasePath}`; },
    getAtt(model, attribute) {
      return getAtt(API_GATEWAY_BASE_PATH_MAPPING_TYPE, API_GATEWAY_BASE_PATH_MAPPING_SCHEMA, model, attribute);
    },
  };
}

function policyIssue(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (value === undefined) return;
  try {
    const document = typeof value === "string" ? JSON.parse(value) : value;
    if (!isObject(document) || !Array.isArray(document.Statement)) throw new Error();
  } catch {
    issues.push(issue(path, `${path} must be a JSON policy document with a Statement array`));
  }
}

function canonicalPolicy(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const document = typeof value === "string" ? JSON.parse(value) : value;
  return JSON.stringify(canonicalJson(document));
}

function privateDomainIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_DOMAIN_NAME_V2_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["CertificateArn", "DomainName"]) requiredNonEmptyString(properties, name, issues);
  validateDomainName(properties.DomainName, "Properties.DomainName", issues);
  validateCertificateArn(properties.CertificateArn, "Properties.CertificateArn", context, issues);
  validateTags(properties.Tags, "Properties.Tags", issues);
  endpointConfigurationIssues(
    properties.EndpointConfiguration,
    "Properties.EndpointConfiguration",
    ["PRIVATE"],
    issues,
  );
  if (
    isObject(properties.EndpointConfiguration)
    && properties.EndpointConfiguration.IpAddressType !== undefined
    && properties.EndpointConfiguration.IpAddressType !== "dualstack"
  ) {
    issues.push(issue(
      "Properties.EndpointConfiguration.IpAddressType",
      "Private domains support only dualstack IpAddressType",
    ));
  }
  if (properties.RoutingMode !== undefined && !ROUTING_MODES.has(properties.RoutingMode)) {
    issues.push(issue("Properties.RoutingMode", "RoutingMode is invalid"));
  }
  if (properties.SecurityPolicy !== undefined && !SECURITY_POLICIES.has(properties.SecurityPolicy)) {
    issues.push(issue("Properties.SecurityPolicy", "SecurityPolicy is not supported by the local API Gateway service"));
  }
  if (properties.EndpointAccessMode !== undefined && !["BASIC", "STRICT"].includes(properties.EndpointAccessMode)) {
    issues.push(issue("Properties.EndpointAccessMode", "EndpointAccessMode must be BASIC or STRICT"));
  }
  const securityPolicy = String(properties.SecurityPolicy ?? "TLS_1_2");
  if (properties.EndpointAccessMode !== undefined && !securityPolicy.startsWith("SecurityPolicy_")) {
    issues.push(issue("Properties.EndpointAccessMode", "EndpointAccessMode requires a modern SecurityPolicy_ policy"));
  }
  policyIssue(properties.Policy, "Properties.Policy", issues);
  return issues;
}

function canonicalPrivateDomain(properties: unknown, context: ProviderContext): ApiGatewayDomainNameV2Model {
  const issues = privateDomainIssues(properties, context);
  throwIssues(issues);
  const input = properties as JsonObject;
  const endpoint = canonicalEndpointConfiguration(input.EndpointConfiguration, "PRIVATE");
  return Object.freeze({
    CertificateArn: String(input.CertificateArn),
    DomainName: normalizeDomainName(String(input.DomainName)),
    ...(input.EndpointAccessMode === undefined ? {} : { EndpointAccessMode: input.EndpointAccessMode as "BASIC" | "STRICT" }),
    EndpointConfiguration: Object.freeze({
      Types: Object.freeze(["PRIVATE"] as const),
      IpAddressType: endpoint.IpAddressType ?? "dualstack",
    }),
    ...(input.Policy === undefined ? {} : { Policy: canonicalPolicy(input.Policy) }),
    RoutingMode: input.RoutingMode ?? "BASE_PATH_MAPPING_ONLY",
    SecurityPolicy: input.SecurityPolicy ?? "TLS_1_2",
    Tags: canonicalTags(input.Tags),
  });
}

function privateDomainFromRaw(raw: JsonObject): ApiGatewayDomainNameV2Model {
  return Object.freeze({
    CertificateArn: String(raw.certificateArn),
    DomainName: normalizeDomainName(String(raw.domainName)),
    ...(raw.endpointAccessMode === undefined ? {} : { EndpointAccessMode: raw.endpointAccessMode as "BASIC" | "STRICT" }),
    EndpointConfiguration: Object.freeze({
      Types: Object.freeze(["PRIVATE"] as const),
      IpAddressType: (raw.endpointConfiguration?.ipAddressType ?? "dualstack") as "ipv4" | "dualstack",
    }),
    ...(raw.policy === undefined ? {} : { Policy: canonicalPolicy(raw.policy) }),
    RoutingMode: raw.routingMode ?? "BASE_PATH_MAPPING_ONLY",
    SecurityPolicy: raw.securityPolicy ?? "TLS_1_2",
    Tags: userTagsFromRaw(raw.tags),
  });
}

function privateDomainInput(model: ApiGatewayDomainNameV2Model, context: ProviderContext): JsonObject {
  return withoutUndefined({
    certificateArn: model.CertificateArn,
    domainName: model.DomainName,
    endpointAccessMode: model.EndpointAccessMode,
    endpointConfiguration: serviceEndpointConfiguration(model.EndpointConfiguration),
    policy: model.Policy,
    routingMode: model.RoutingMode,
    securityPolicy: model.SecurityPolicy,
    tags: serviceTagMap(model.Tags, context),
  });
}

function privateDomainPath(domainName: string, domainNameId: string): string {
  return `${publicDomainPath(domainName)}?domainNameId=${encodeURIComponent(domainNameId)}`;
}

async function readPrivateDomainRaw(
  service: ApiGatewayService,
  domainName: string,
  domainNameId: string,
): Promise<JsonObject> {
  return call<JsonObject>(service, "GET", privateDomainPath(domainName, domainNameId));
}

function privateDomainReadModel(raw: JsonObject): ProviderReadModel<ApiGatewayDomainNameV2Model> {
  const domainName = normalizeDomainName(String(raw.domainName));
  const domainNameId = String(raw.domainNameId);
  return {
    physicalId: physical("domain-name-v2", [domainName, domainNameId]),
    properties: privateDomainFromRaw(raw),
    attributes: {
      DomainNameArn: String(raw.domainNameArn),
      DomainNameId: domainNameId,
    },
  };
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePrivateDomainArn(
  value: string,
  context: Pick<ProviderContext, "partition" | "region" | "accountId">,
): { readonly arn: string; readonly domainName: string; readonly domainNameId: string } {
  const expression = new RegExp(
    `^arn:${regexpEscape(context.partition)}:apigateway:${regexpEscape(context.region)}:${regexpEscape(context.accountId)}:/domainnames/([^+]+)\\+([^/]+)$`,
  );
  const match = expression.exec(value);
  if (!match) {
    throw new AwsError(
      "BadRequestException",
      "DomainNameArn must identify a private API Gateway domain in this account and Region",
      400,
    );
  }
  return {
    arn: value,
    domainName: normalizeDomainName(match[1]),
    domainNameId: match[2],
  };
}

export function createApiGatewayDomainNameV2Provider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayDomainNameV2Model> {
  return {
    typeName: API_GATEWAY_DOMAIN_NAME_V2_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_DOMAIN_NAME_V2_SCHEMA,
    validate(properties, context) { return privateDomainIssues(properties, context); },
    canonicalize(properties, context) { return canonicalPrivateDomain(properties, context); },
    plan(previous, desired) {
      return plan(
        previous,
        desired,
        API_GATEWAY_DOMAIN_NAME_V2_SCHEMA,
        ["DomainName", "EndpointConfiguration", "SecurityPolicy"],
        changed => changed.includes("DomainName") ? "CREATE_BEFORE_DELETE" : "DELETE_BEFORE_CREATE",
      );
    },
    async create(desired, context) {
      try {
        try {
          const listed = await listAll(service, "/domainnames?resourceOwner=SELF");
          const existing = listed.find(item => normalizeDomainName(String(item.domainName)) === desired.DomainName);
          if (existing) {
            if (!existing.domainNameId) {
              throw new AwsError("ConflictException", `A public domain already uses ${desired.DomainName}`, 409);
            }
            const raw = await readPrivateDomainRaw(service, desired.DomainName, String(existing.domainNameId));
            assertOwned(raw.tags, context, `Private domain name ${desired.DomainName}`);
            const model = privateDomainReadModel(raw);
            if (same(model.properties, desired)) return success(model.physicalId, model);
            throw new AwsError(
              "ConflictException",
              `Private domain name ${desired.DomainName} already exists with different properties`,
              409,
            );
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        const raw = await call<JsonObject>(
          service,
          "POST",
          "/domainnames",
          privateDomainInput(desired, context),
          context.idempotencyKey,
        );
        const model = privateDomainReadModel(
          await readPrivateDomainRaw(service, desired.DomainName, String(raw.domainNameId)),
        );
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayDomainNameV2Model>> {
      try {
        const [domainName, domainNameId] = parsePhysical(physicalId, "domain-name-v2", 2);
        const raw = await readPrivateDomainRaw(service, domainName, domainNameId);
        assertOwned(raw.tags, context, `Private domain name ${domainName}`);
        return success(physicalId, { ...privateDomainReadModel(raw), physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayDomainNameV2Model>> {
      try {
        const [domainName, domainNameId] = parsePhysical(physicalId, "domain-name-v2", 2);
        if (
          domainName !== desired.DomainName
          || previous.DomainName !== desired.DomainName
          || !same(previous.EndpointConfiguration, desired.EndpointConfiguration)
          || previous.SecurityPolicy !== desired.SecurityPolicy
        ) {
          throw new AwsError(
            "RequiresReplacement",
            "DomainName, EndpointConfiguration, and SecurityPolicy changes require replacement",
            409,
          );
        }
        const current = await readPrivateDomainRaw(service, domainName, domainNameId);
        assertOwned(current.tags, context, `Private domain name ${domainName}`);
        await call(service, "PATCH", privateDomainPath(domainName, domainNameId), {
          patchOperations: [
            patchValue("/certificateArn", desired.CertificateArn),
            patchValue("/endpointAccessMode", desired.EndpointAccessMode),
            patchValue("/policy", desired.Policy),
            patchValue("/routingMode", desired.RoutingMode),
          ],
        });
        await reconcileTags(service, String(current.domainNameArn), current.tags, desired.Tags, context);
        const model = privateDomainReadModel(await readPrivateDomainRaw(service, domainName, domainNameId));
        return success(physicalId, { ...model, physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [domainName, domainNameId] = parsePhysical(physicalId, "domain-name-v2", 2);
        const raw = await readPrivateDomainRaw(service, domainName, domainNameId);
        assertOwned(raw.tags, context, `Private domain name ${domainName}`);
        await call(service, "DELETE", privateDomainPath(domainName, domainNameId));
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.attributes.DomainNameArn; },
    getAtt(model, attribute) {
      return getAtt(API_GATEWAY_DOMAIN_NAME_V2_TYPE, API_GATEWAY_DOMAIN_NAME_V2_SCHEMA, model, attribute);
    },
  };
}

function basePathMappingV2Issues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_BASE_PATH_MAPPING_V2_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["DomainNameArn", "RestApiId"]) requiredNonEmptyString(properties, name, issues);
  basePathIssues(properties.BasePath, "Properties.BasePath", issues);
  if (typeof properties.DomainNameArn === "string") {
    try { parsePrivateDomainArn(properties.DomainNameArn, context); }
    catch (error) { issues.push(issue("Properties.DomainNameArn", error instanceof Error ? error.message : String(error))); }
  }
  if (properties.Stage !== undefined && (typeof properties.Stage !== "string" || !properties.Stage.trim())) {
    issues.push(issue("Properties.Stage", "Stage must be a non-empty string when specified"));
  }
  return issues;
}

function canonicalBasePathMappingV2(
  properties: unknown,
  context: ProviderContext,
): ApiGatewayBasePathMappingV2Model {
  const issues = basePathMappingV2Issues(properties, context);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    BasePath: normalizeBasePath(input.BasePath),
    DomainNameArn: String(input.DomainNameArn),
    RestApiId: String(input.RestApiId),
    Stage: normalizeBasePath(input.Stage),
  });
}

function basePathMappingV2FromRaw(
  domainNameArn: string,
  raw: JsonObject,
): ApiGatewayBasePathMappingV2Model {
  return Object.freeze({
    BasePath: normalizeBasePath(raw.basePath),
    DomainNameArn: domainNameArn,
    RestApiId: String(raw.restApiId),
    Stage: normalizeBasePath(raw.stage),
  });
}

function basePathMappingArn(domainNameArn: string, basePath: string): string {
  return `${domainNameArn}/basepathmappings/${basePath}`;
}

function basePathMappingV2ReadModel(
  domainNameArn: string,
  raw: JsonObject,
): ProviderReadModel<ApiGatewayBasePathMappingV2Model> {
  const model = basePathMappingV2FromRaw(domainNameArn, raw);
  const arn = basePathMappingArn(domainNameArn, model.BasePath);
  return {
    physicalId: physical("base-path-mapping-v2", [domainNameArn, model.BasePath]),
    properties: model,
    attributes: { BasePathMappingArn: arn },
  };
}

export function createApiGatewayBasePathMappingV2Provider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayBasePathMappingV2Model> {
  return {
    typeName: API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_BASE_PATH_MAPPING_V2_SCHEMA,
    validate(properties, context) { return basePathMappingV2Issues(properties, context); },
    canonicalize(properties, context) { return canonicalBasePathMappingV2(properties, context); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_BASE_PATH_MAPPING_V2_SCHEMA, ["BasePath", "DomainNameArn"]);
    },
    async create(desired, context) {
      try {
        const domain = parsePrivateDomainArn(desired.DomainNameArn, context);
        await call(service, "POST", mappingCollectionPath(domain.domainName, domain.domainNameId), {
          basePath: desired.BasePath,
          restApiId: desired.RestApiId,
          stage: desired.Stage,
        }, context.idempotencyKey, ownerValue(context));
        const model = basePathMappingV2ReadModel(
          desired.DomainNameArn,
          await readBasePathMappingRaw(
            service,
            domain.domainName,
            desired.BasePath,
            domain.domainNameId,
            ownerValue(context),
          ),
        );
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayBasePathMappingV2Model>> {
      try {
        const [domainNameArn, basePath] = parsePhysical(physicalId, "base-path-mapping-v2", 2);
        const domain = parsePrivateDomainArn(domainNameArn, context);
        const model = basePathMappingV2ReadModel(
          domainNameArn,
          await readBasePathMappingRaw(
            service,
            domain.domainName,
            basePath,
            domain.domainNameId,
            ownerValue(context),
          ),
        );
        return success(physicalId, { ...model, physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayBasePathMappingV2Model>> {
      try {
        const [domainNameArn, basePath] = parsePhysical(physicalId, "base-path-mapping-v2", 2);
        if (
          domainNameArn !== desired.DomainNameArn
          || basePath !== desired.BasePath
          || previous.DomainNameArn !== desired.DomainNameArn
          || previous.BasePath !== desired.BasePath
        ) {
          throw new AwsError("RequiresReplacement", "DomainNameArn and BasePath changes require replacement", 409);
        }
        const domain = parsePrivateDomainArn(domainNameArn, context);
        await call(service, "PATCH", mappingItemPath(domain.domainName, basePath, domain.domainNameId), {
          patchOperations: [
            patchValue("/restApiId", desired.RestApiId),
            patchValue("/stage", desired.Stage),
          ],
        }, undefined, ownerValue(context));
        const model = basePathMappingV2ReadModel(
          domainNameArn,
          await readBasePathMappingRaw(
            service,
            domain.domainName,
            basePath,
            domain.domainNameId,
            ownerValue(context),
          ),
        );
        return success(physicalId, { ...model, physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [domainNameArn, basePath] = parsePhysical(physicalId, "base-path-mapping-v2", 2);
        const domain = parsePrivateDomainArn(domainNameArn, context);
        await call(
          service,
          "DELETE",
          mappingItemPath(domain.domainName, basePath, domain.domainNameId),
          undefined,
          undefined,
          ownerValue(context),
        );
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.attributes.BasePathMappingArn; },
    getAtt(model, attribute) {
      return getAtt(
        API_GATEWAY_BASE_PATH_MAPPING_V2_TYPE,
        API_GATEWAY_BASE_PATH_MAPPING_V2_SCHEMA,
        model,
        attribute,
      );
    },
  };
}

function associationIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["AccessAssociationSource", "AccessAssociationSourceType", "DomainNameArn"]) {
    requiredNonEmptyString(properties, name, issues);
  }
  if (properties.AccessAssociationSourceType !== undefined && properties.AccessAssociationSourceType !== "VPCE") {
    issues.push(issue("Properties.AccessAssociationSourceType", "AccessAssociationSourceType must be VPCE"));
  }
  if (
    properties.AccessAssociationSource !== undefined
    && (typeof properties.AccessAssociationSource !== "string" || !/^vpce-[a-z0-9]+$/.test(properties.AccessAssociationSource))
  ) {
    issues.push(issue("Properties.AccessAssociationSource", "AccessAssociationSource must be a VPC endpoint ID"));
  }
  if (typeof properties.DomainNameArn === "string") {
    try { parsePrivateDomainArn(properties.DomainNameArn, context); }
    catch (error) { issues.push(issue("Properties.DomainNameArn", error instanceof Error ? error.message : String(error))); }
  }
  validateTags(properties.Tags, "Properties.Tags", issues);
  return issues;
}

function canonicalAssociation(
  properties: unknown,
  context: ProviderContext,
): ApiGatewayDomainNameAccessAssociationModel {
  const issues = associationIssues(properties, context);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    AccessAssociationSource: String(input.AccessAssociationSource),
    AccessAssociationSourceType: "VPCE" as const,
    DomainNameArn: String(input.DomainNameArn),
    Tags: canonicalTags(input.Tags),
  });
}

function associationFromRaw(raw: JsonObject): ApiGatewayDomainNameAccessAssociationModel {
  return Object.freeze({
    AccessAssociationSource: String(raw.accessAssociationSource),
    AccessAssociationSourceType: "VPCE" as const,
    DomainNameArn: String(raw.domainNameArn),
    Tags: userTagsFromRaw(raw.tags),
  });
}

function associationReadModel(raw: JsonObject): ProviderReadModel<ApiGatewayDomainNameAccessAssociationModel> {
  const arn = String(raw.domainNameAccessAssociationArn);
  return {
    physicalId: physical("domain-name-access-association", [arn]),
    properties: associationFromRaw(raw),
    attributes: { DomainNameAccessAssociationArn: arn },
  };
}

async function findAssociation(service: ApiGatewayService, arn: string): Promise<JsonObject | undefined> {
  return (await listAll(service, "/domainnameaccessassociations?resourceOwner=SELF"))
    .find(item => item.domainNameAccessAssociationArn === arn);
}

export function createApiGatewayDomainNameAccessAssociationProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayDomainNameAccessAssociationModel> {
  return {
    typeName: API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_SCHEMA,
    validate(properties, context) { return associationIssues(properties, context); },
    canonicalize(properties, context) { return canonicalAssociation(properties, context); },
    plan(previous, desired) {
      return plan(
        previous,
        desired,
        API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_SCHEMA,
        ["AccessAssociationSource", "AccessAssociationSourceType", "DomainNameArn", "Tags"],
      );
    },
    async create(desired, context) {
      try {
        const existing = (await listAll(service, "/domainnameaccessassociations?resourceOwner=SELF"))
          .find(item =>
            item.domainNameArn === desired.DomainNameArn
            && item.accessAssociationSource === desired.AccessAssociationSource
            && item.accessAssociationSourceType === desired.AccessAssociationSourceType);
        if (existing) {
          assertOwned(existing.tags, context, "Domain name access association");
          const model = associationReadModel(existing);
          if (same(model.properties, desired)) return success(model.physicalId, model);
          throw new AwsError(
            "ConflictException",
            "The domain name access association already exists with different properties",
            409,
          );
        }
        const raw = await call<JsonObject>(
          service,
          "POST",
          "/domainnameaccessassociations",
          {
            accessAssociationSource: desired.AccessAssociationSource,
            accessAssociationSourceType: desired.AccessAssociationSourceType,
            domainNameArn: desired.DomainNameArn,
            tags: serviceTagMap(desired.Tags, context),
          },
          context.idempotencyKey,
        );
        const model = associationReadModel(raw);
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayDomainNameAccessAssociationModel>> {
      try {
        const [arn] = parsePhysical(physicalId, "domain-name-access-association", 1);
        const raw = await findAssociation(service, arn);
        if (!raw) return { status: "NOT_FOUND", physicalId };
        assertOwned(raw.tags, context, "Domain name access association");
        return success(physicalId, { ...associationReadModel(raw), physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayDomainNameAccessAssociationModel>> {
      if (!same(previous, desired)) {
        return {
          status: "FAILED",
          errorCode: "RequiresReplacement",
          message: "All DomainNameAccessAssociation properties require replacement",
        };
      }
      try {
        const [arn] = parsePhysical(physicalId, "domain-name-access-association", 1);
        const raw = await findAssociation(service, arn);
        if (!raw) {
          return {
            status: "FAILED",
            errorCode: "NotFoundException",
            message: "Domain name access association was not found",
          };
        }
        assertOwned(raw.tags, context, "Domain name access association");
        return success(physicalId, { ...associationReadModel(raw), physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [arn] = parsePhysical(physicalId, "domain-name-access-association", 1);
        const raw = await findAssociation(service, arn);
        if (!raw) return { status: "NOT_FOUND", physicalId };
        assertOwned(raw.tags, context, "Domain name access association");
        await call(service, "DELETE", `/domainnameaccessassociations/${segment(arn)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.attributes.DomainNameAccessAssociationArn; },
    getAtt(model, attribute) {
      return getAtt(
        API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_TYPE,
        API_GATEWAY_DOMAIN_NAME_ACCESS_ASSOCIATION_SCHEMA,
        model,
        attribute,
      );
    },
  };
}

function vpcLinkIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_VPC_LINK_SCHEMA);
  if (!isObject(properties)) return issues;
  requiredNonEmptyString(properties, "Name", issues);
  if (typeof properties.Name === "string" && properties.Name.trim().length > 128) {
    issues.push(issue("Properties.Name", "Name must not exceed 128 characters"));
  }
  validateTags(properties.Tags, "Properties.Tags", issues);
  if (Array.isArray(properties.TargetArns)) {
    if (properties.TargetArns.length !== 1) {
      issues.push(issue("Properties.TargetArns", "TargetArns must contain exactly one load balancer ARN"));
    }
    const targetExpression = new RegExp(
      `^arn:${context.partition}:elasticloadbalancing:${context.region}:${context.accountId}:`
      + "loadbalancer\\/(?:net|app)\\/[A-Za-z0-9-]+\\/[A-Fa-f0-9]+$",
    );
    properties.TargetArns.forEach((targetArn, index) => {
      if (typeof targetArn !== "string" || !targetExpression.test(targetArn)) {
        issues.push(issue(
          `Properties.TargetArns[${index}]`,
          "TargetArns must identify one load balancer in this account and Region",
        ));
      }
    });
  }
  return issues;
}

function canonicalVpcLink(properties: unknown, context: ProviderContext): ApiGatewayVpcLinkModel {
  const issues = vpcLinkIssues(properties, context);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    ...(input.Description === undefined ? {} : { Description: String(input.Description) }),
    Name: String(input.Name).trim(),
    Tags: canonicalTags(input.Tags),
    TargetArns: Object.freeze((input.TargetArns as unknown[]).map(String)),
  });
}

function vpcLinkFromRaw(raw: JsonObject): ApiGatewayVpcLinkModel {
  return Object.freeze({
    ...(raw.description === undefined ? {} : { Description: String(raw.description) }),
    Name: String(raw.name),
    Tags: userTagsFromRaw(raw.tags),
    TargetArns: Object.freeze((Array.isArray(raw.targetArns) ? raw.targetArns : []).map(String)),
  });
}

function vpcLinkReadModel(raw: JsonObject): ProviderReadModel<ApiGatewayVpcLinkModel> {
  const id = String(raw.id);
  return {
    physicalId: id,
    properties: vpcLinkFromRaw(raw),
    attributes: { VpcLinkId: id },
  };
}

function vpcLinkArn(id: string, context: ProviderContext): string {
  return `arn:${context.partition}:apigateway:${context.region}::/vpclinks/${id}`;
}

function vpcLinkStatusFailure(raw: JsonObject, physicalId?: string): ProviderFailed {
  return {
    status: "FAILED",
    errorCode: "DependencyUnavailable",
    message: String(raw.statusMessage ?? `VPC link is ${String(raw.status ?? "not available")}`),
    ...(physicalId === undefined ? {} : { physicalId }),
  };
}

export function createApiGatewayVpcLinkProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayVpcLinkModel> {
  return {
    typeName: API_GATEWAY_VPC_LINK_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_VPC_LINK_SCHEMA,
    validate(properties, context) { return vpcLinkIssues(properties, context); },
    canonicalize(properties, context) { return canonicalVpcLink(properties, context); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_VPC_LINK_SCHEMA, ["TargetArns"]);
    },
    async create(desired, context) {
      try {
        const existing = (await listAll(service, "/vpclinks")).find(item => item.name === desired.Name);
        if (existing) {
          assertOwned(existing.tags, context, `VPC link ${desired.Name}`);
          const model = vpcLinkReadModel(existing);
          if (!same(model.properties, desired)) {
            throw new AwsError("ConflictException", `VPC link ${desired.Name} already exists with different properties`, 409);
          }
          if (existing.status !== "AVAILABLE") return vpcLinkStatusFailure(existing, model.physicalId);
          return success(model.physicalId, model);
        }

        const raw = await call<JsonObject>(
          service,
          "POST",
          "/vpclinks",
          {
            name: desired.Name,
            ...(desired.Description === undefined ? {} : { description: desired.Description }),
            targetArns: [...desired.TargetArns],
            tags: serviceTagMap(desired.Tags, context),
          },
          context.idempotencyKey,
        );
        const model = vpcLinkReadModel(raw);
        if (raw.status !== "AVAILABLE") {
          // Preserve the backing FAILED state and return its identity so the
          // executor can durably compensate it through the normal DELETE path.
          return vpcLinkStatusFailure(raw, model.physicalId);
        }
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayVpcLinkModel>> {
      try {
        const raw = await call<JsonObject>(service, "GET", `/vpclinks/${segment(physicalId)}`);
        assertOwned(raw.tags, context, `VPC link ${physicalId}`);
        if (raw.status !== "AVAILABLE") return vpcLinkStatusFailure(raw, physicalId);
        return success(physicalId, { ...vpcLinkReadModel(raw), physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayVpcLinkModel>> {
      try {
        if (!same(previous.TargetArns, desired.TargetArns)) {
          throw new AwsError("RequiresReplacement", "TargetArns changes require replacement", 409);
        }
        const current = await call<JsonObject>(service, "GET", `/vpclinks/${segment(physicalId)}`);
        assertOwned(current.tags, context, `VPC link ${physicalId}`);
        const updated = await call<JsonObject>(service, "PATCH", `/vpclinks/${segment(physicalId)}`, {
          patchOperations: [
            patchValue("/name", desired.Name),
            patchValue("/description", desired.Description),
          ],
        });
        if (updated.status !== "AVAILABLE") {
          try {
            await call(service, "PATCH", `/vpclinks/${segment(physicalId)}`, {
              patchOperations: [
                patchValue("/name", current.name),
                patchValue("/description", current.description),
              ],
            });
          } catch { /* Preserve the status failure that triggered rollback. */ }
          return vpcLinkStatusFailure(updated, physicalId);
        }
        await reconcileTags(service, vpcLinkArn(physicalId, context), current.tags, desired.Tags, context);
        const raw = await call<JsonObject>(service, "GET", `/vpclinks/${segment(physicalId)}`);
        return success(physicalId, { ...vpcLinkReadModel(raw), physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const raw = await call<JsonObject>(service, "GET", `/vpclinks/${segment(physicalId)}`);
        assertOwned(raw.tags, context, `VPC link ${physicalId}`);
        await call(service, "DELETE", `/vpclinks/${segment(physicalId)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.attributes.VpcLinkId; },
    getAtt(model, attribute) {
      return getAtt(API_GATEWAY_VPC_LINK_TYPE, API_GATEWAY_VPC_LINK_SCHEMA, model, attribute);
    },
  };
}

function clientCertificateIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_CLIENT_CERTIFICATE_SCHEMA);
  if (!isObject(properties)) return issues;
  validateTags(properties.Tags, "Properties.Tags", issues);
  return issues;
}

function canonicalClientCertificate(properties: unknown): ApiGatewayClientCertificateModel {
  const issues = clientCertificateIssues(properties);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    ...(input.Description === undefined ? {} : { Description: String(input.Description) }),
    Tags: canonicalTags(input.Tags),
  });
}

function clientCertificateFromRaw(raw: JsonObject): ApiGatewayClientCertificateModel {
  return Object.freeze({
    ...(raw.description === undefined ? {} : { Description: String(raw.description) }),
    Tags: userTagsFromRaw(raw.tags),
  });
}

function clientCertificateReadModel(raw: JsonObject): ProviderReadModel<ApiGatewayClientCertificateModel> {
  const id = String(raw.clientCertificateId);
  return {
    physicalId: id,
    properties: clientCertificateFromRaw(raw),
    attributes: { ClientCertificateId: id },
  };
}

function clientCertificateArn(id: string, context: ProviderContext): string {
  return `arn:${context.partition}:apigateway:${context.region}::/clientcertificates/${id}`;
}

export function createApiGatewayClientCertificateProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayClientCertificateModel> {
  return {
    typeName: API_GATEWAY_CLIENT_CERTIFICATE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_CLIENT_CERTIFICATE_SCHEMA,
    validate(properties) { return clientCertificateIssues(properties); },
    canonicalize(properties) { return canonicalClientCertificate(properties); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_CLIENT_CERTIFICATE_SCHEMA, []);
    },
    async create(desired, context) {
      try {
        const owned = (await listAll(service, "/clientcertificates"))
          .filter(item => isObject(item.tags) && item.tags[OWNER_TAG_KEY] === ownerValue(context));
        if (owned.length > 1) {
          throw new AwsError(
            "OwnershipConflict",
            "Multiple client certificates are owned by this CloudFormation stack resource",
            409,
          );
        }
        if (owned.length === 1) {
          const model = clientCertificateReadModel(owned[0]);
          if (same(model.properties, desired)) return success(model.physicalId, model);
          throw new AwsError(
            "ConflictException",
            "The owned client certificate already exists with different properties",
            409,
          );
        }
        const raw = await call<JsonObject>(
          service,
          "POST",
          "/clientcertificates",
          {
            ...(desired.Description === undefined ? {} : { description: desired.Description }),
            tags: serviceTagMap(desired.Tags, context),
          },
          context.idempotencyKey,
        );
        const model = clientCertificateReadModel(raw);
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayClientCertificateModel>> {
      try {
        const raw = await call<JsonObject>(service, "GET", `/clientcertificates/${segment(physicalId)}`);
        assertOwned(raw.tags, context, `Client certificate ${physicalId}`);
        return success(physicalId, { ...clientCertificateReadModel(raw), physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(
      physicalId,
      _previous,
      desired,
      context,
    ): Promise<ProviderUpdateResult<ApiGatewayClientCertificateModel>> {
      try {
        const current = await call<JsonObject>(service, "GET", `/clientcertificates/${segment(physicalId)}`);
        assertOwned(current.tags, context, `Client certificate ${physicalId}`);
        await call(service, "PATCH", `/clientcertificates/${segment(physicalId)}`, {
          patchOperations: [patchValue("/description", desired.Description)],
        });
        await reconcileTags(
          service,
          clientCertificateArn(physicalId, context),
          current.tags,
          desired.Tags,
          context,
        );
        const raw = await call<JsonObject>(service, "GET", `/clientcertificates/${segment(physicalId)}`);
        return success(physicalId, { ...clientCertificateReadModel(raw), physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const raw = await call<JsonObject>(service, "GET", `/clientcertificates/${segment(physicalId)}`);
        assertOwned(raw.tags, context, `Client certificate ${physicalId}`);
        await call(service, "DELETE", `/clientcertificates/${segment(physicalId)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.attributes.ClientCertificateId; },
    getAtt(model, attribute) {
      return getAtt(
        API_GATEWAY_CLIENT_CERTIFICATE_TYPE,
        API_GATEWAY_CLIENT_CERTIFICATE_SCHEMA,
        model,
        attribute,
      );
    },
  };
}

function documentationLocationIssues(
  value: unknown,
  path: string,
  issues: ProviderValidationIssue[],
): void {
  if (!isObject(value)) return;
  rejectUnknown(value, path, ["Method", "Name", "Path", "StatusCode", "Type"], issues);
  if (value.Type === undefined) {
    issues.push(issue(`${path}.Type`, "Type is required", "MissingRequiredProperty"));
  } else if (typeof value.Type !== "string" || !DOCUMENTATION_PART_TYPES.has(value.Type.toUpperCase())) {
    issues.push(issue(`${path}.Type`, "Type must be a supported documentation part type"));
  }
  if (
    value.Method !== undefined
    && (typeof value.Method !== "string" || (value.Method !== "*" && !/^[A-Za-z]+$/.test(value.Method)))
  ) {
    issues.push(issue(`${path}.Method`, "Method must be * or contain only letters"));
  }
  if (
    value.Name !== undefined
    && (typeof value.Name !== "string" || !value.Name.trim())
  ) {
    issues.push(issue(`${path}.Name`, "Name must be a non-empty string"));
  }
  if (
    value.Path !== undefined
    && (typeof value.Path !== "string" || !value.Path.startsWith("/") || value.Path.length > 1600)
  ) {
    issues.push(issue(`${path}.Path`, "Path must start with / and must not exceed 1600 characters"));
  }
  if (
    value.StatusCode !== undefined
    && (typeof value.StatusCode !== "string" || (value.StatusCode !== "*" && !/^\d{3}$/.test(value.StatusCode)))
  ) {
    issues.push(issue(`${path}.StatusCode`, "StatusCode must be * or a three-digit status code"));
  }
  const type = typeof value.Type === "string" ? value.Type.toUpperCase() : "";
  if (
    ["AUTHORIZER", "MODEL", "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE_HEADER"]
      .includes(type)
    && (typeof value.Name !== "string" || !value.Name.trim())
  ) {
    issues.push(issue(`${path}.Name`, `Name is required for ${type}`));
  }
}

function canonicalDocumentationLocation(value: unknown): ApiGatewayDocumentationPartLocationModel {
  const input = value as JsonObject;
  return Object.freeze({
    ...(input.Method === undefined ? {} : { Method: String(input.Method).toUpperCase() }),
    ...(input.Name === undefined ? {} : { Name: String(input.Name).trim() }),
    ...(input.Path === undefined ? {} : { Path: String(input.Path) }),
    ...(input.StatusCode === undefined ? {} : { StatusCode: String(input.StatusCode) }),
    Type: String(input.Type).toUpperCase(),
  });
}

function documentationPartIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_DOCUMENTATION_PART_SCHEMA);
  if (!isObject(properties)) return issues;
  requiredNonEmptyString(properties, "RestApiId", issues);
  documentationLocationIssues(properties.Location, "Properties.Location", issues);
  if (typeof properties.Properties === "string") {
    if (Buffer.byteLength(properties.Properties, "utf8") > 32_768) {
      issues.push(issue("Properties.Properties", "Properties must not exceed 32768 UTF-8 bytes"));
    }
    try {
      const parsed = JSON.parse(properties.Properties);
      if (!isObject(parsed)) throw new Error();
    } catch {
      issues.push(issue("Properties.Properties", "Properties must be a JSON object encoded as a string"));
    }
  }
  return issues;
}

function canonicalDocumentationPart(properties: unknown): ApiGatewayDocumentationPartModel {
  const issues = documentationPartIssues(properties);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    Location: canonicalDocumentationLocation(input.Location),
    Properties: JSON.stringify(canonicalJson(JSON.parse(String(input.Properties)))),
    RestApiId: String(input.RestApiId),
  });
}

function documentationPartFromRaw(
  restApiId: string,
  raw: JsonObject,
): ApiGatewayDocumentationPartModel {
  const location = isObject(raw.location) ? raw.location : {};
  return Object.freeze({
    Location: Object.freeze({
      ...(location.method === undefined ? {} : { Method: String(location.method).toUpperCase() }),
      ...(location.name === undefined ? {} : { Name: String(location.name) }),
      ...(location.path === undefined ? {} : { Path: String(location.path) }),
      ...(location.statusCode === undefined ? {} : { StatusCode: String(location.statusCode) }),
      Type: String(location.type).toUpperCase(),
    }),
    Properties: JSON.stringify(canonicalJson(JSON.parse(String(raw.properties)))),
    RestApiId: restApiId,
  });
}

function documentationPartInput(model: ApiGatewayDocumentationPartModel): JsonObject {
  return {
    location: withoutUndefined({
      method: model.Location.Method,
      name: model.Location.Name,
      path: model.Location.Path,
      statusCode: model.Location.StatusCode,
      type: model.Location.Type,
    }),
    properties: model.Properties,
  };
}

function documentationPartReadModel(
  restApiId: string,
  raw: JsonObject,
): ProviderReadModel<ApiGatewayDocumentationPartModel> {
  const id = String(raw.id);
  return {
    physicalId: physical("documentation-part", [restApiId, id]),
    properties: documentationPartFromRaw(restApiId, raw),
    attributes: { DocumentationPartId: id },
  };
}

function documentationPartsPath(restApiId: string): string {
  return `/restapis/${segment(restApiId)}/documentation/parts`;
}

function documentationPartPath(restApiId: string, partId: string): string {
  return `${documentationPartsPath(restApiId)}/${segment(partId)}`;
}

export function createApiGatewayDocumentationPartProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayDocumentationPartModel> {
  return {
    typeName: API_GATEWAY_DOCUMENTATION_PART_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_DOCUMENTATION_PART_SCHEMA,
    validate(properties) { return documentationPartIssues(properties); },
    canonicalize(properties) { return canonicalDocumentationPart(properties); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_DOCUMENTATION_PART_SCHEMA, ["Location", "RestApiId"]);
    },
    async create(desired, context) {
      try {
        const raw = await call<JsonObject>(
          service,
          "POST",
          documentationPartsPath(desired.RestApiId),
          documentationPartInput(desired),
          context.idempotencyKey,
          ownerValue(context),
        );
        const model = documentationPartReadModel(desired.RestApiId, raw);
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayDocumentationPartModel>> {
      try {
        const [restApiId, partId] = parsePhysical(physicalId, "documentation-part", 2);
        const raw = await call<JsonObject>(
          service,
          "GET",
          documentationPartPath(restApiId, partId),
          undefined,
          undefined,
          ownerValue(context),
        );
        return success(physicalId, { ...documentationPartReadModel(restApiId, raw), physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(
      physicalId,
      previous,
      desired,
      context,
    ): Promise<ProviderUpdateResult<ApiGatewayDocumentationPartModel>> {
      try {
        const [restApiId, partId] = parsePhysical(physicalId, "documentation-part", 2);
        if (
          restApiId !== desired.RestApiId
          || previous.RestApiId !== desired.RestApiId
          || !same(previous.Location, desired.Location)
        ) {
          throw new AwsError("RequiresReplacement", "Location and RestApiId changes require replacement", 409);
        }
        const raw = await call<JsonObject>(service, "PATCH", documentationPartPath(restApiId, partId), {
          patchOperations: [patchValue("/properties", desired.Properties)],
        }, undefined, ownerValue(context));
        return success(physicalId, { ...documentationPartReadModel(restApiId, raw), physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [restApiId, partId] = parsePhysical(physicalId, "documentation-part", 2);
        await call(
          service,
          "DELETE",
          documentationPartPath(restApiId, partId),
          undefined,
          undefined,
          ownerValue(context),
        );
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) { return model.attributes.DocumentationPartId; },
    getAtt(model, attribute) {
      return getAtt(
        API_GATEWAY_DOCUMENTATION_PART_TYPE,
        API_GATEWAY_DOCUMENTATION_PART_SCHEMA,
        model,
        attribute,
      );
    },
  };
}

function documentationVersionIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_DOCUMENTATION_VERSION_SCHEMA);
  if (!isObject(properties)) return issues;
  requiredNonEmptyString(properties, "DocumentationVersion", issues);
  requiredNonEmptyString(properties, "RestApiId", issues);
  if (
    typeof properties.DocumentationVersion === "string"
    && properties.DocumentationVersion.trim().length > 64
  ) {
    issues.push(issue("Properties.DocumentationVersion", "DocumentationVersion must not exceed 64 characters"));
  }
  return issues;
}

function canonicalDocumentationVersion(properties: unknown): ApiGatewayDocumentationVersionModel {
  const issues = documentationVersionIssues(properties);
  throwIssues(issues);
  const input = properties as JsonObject;
  return Object.freeze({
    ...(input.Description === undefined ? {} : { Description: String(input.Description) }),
    DocumentationVersion: String(input.DocumentationVersion).trim(),
    RestApiId: String(input.RestApiId),
  });
}

function documentationVersionFromRaw(
  restApiId: string,
  raw: JsonObject,
): ApiGatewayDocumentationVersionModel {
  return Object.freeze({
    ...(raw.description === undefined ? {} : { Description: String(raw.description) }),
    DocumentationVersion: String(raw.version),
    RestApiId: restApiId,
  });
}

function documentationVersionReadModel(
  restApiId: string,
  raw: JsonObject,
): ProviderReadModel<ApiGatewayDocumentationVersionModel> {
  const version = String(raw.version);
  return {
    physicalId: physical("documentation-version", [restApiId, version]),
    properties: documentationVersionFromRaw(restApiId, raw),
    attributes: {},
  };
}

function documentationVersionsPath(restApiId: string): string {
  return `/restapis/${segment(restApiId)}/documentation/versions`;
}

function documentationVersionPath(restApiId: string, version: string): string {
  return `${documentationVersionsPath(restApiId)}/${segment(version)}`;
}

export function createApiGatewayDocumentationVersionProvider(
  service: ApiGatewayService,
): ProductionResourceProvider<ApiGatewayDocumentationVersionModel> {
  return {
    typeName: API_GATEWAY_DOCUMENTATION_VERSION_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: API_GATEWAY_DOCUMENTATION_VERSION_SCHEMA,
    validate(properties) { return documentationVersionIssues(properties); },
    canonicalize(properties) { return canonicalDocumentationVersion(properties); },
    plan(previous, desired) {
      return plan(
        previous,
        desired,
        API_GATEWAY_DOCUMENTATION_VERSION_SCHEMA,
        ["DocumentationVersion", "RestApiId"],
      );
    },
    async create(desired, context) {
      try {
        const raw = await call<JsonObject>(
          service,
          "POST",
          documentationVersionsPath(desired.RestApiId),
          {
            documentationVersion: desired.DocumentationVersion,
            ...(desired.Description === undefined ? {} : { description: desired.Description }),
          },
          context.idempotencyKey,
          ownerValue(context),
        );
        const model = documentationVersionReadModel(desired.RestApiId, raw);
        return success(model.physicalId, model);
      } catch (error) {
        return failure(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayDocumentationVersionModel>> {
      try {
        const [restApiId, version] = parsePhysical(physicalId, "documentation-version", 2);
        const raw = await call<JsonObject>(
          service,
          "GET",
          documentationVersionPath(restApiId, version),
          undefined,
          undefined,
          ownerValue(context),
        );
        return success(physicalId, { ...documentationVersionReadModel(restApiId, raw), physicalId });
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    async update(
      physicalId,
      previous,
      desired,
      context,
    ): Promise<ProviderUpdateResult<ApiGatewayDocumentationVersionModel>> {
      try {
        const [restApiId, version] = parsePhysical(physicalId, "documentation-version", 2);
        if (
          restApiId !== desired.RestApiId
          || version !== desired.DocumentationVersion
          || previous.RestApiId !== desired.RestApiId
          || previous.DocumentationVersion !== desired.DocumentationVersion
        ) {
          throw new AwsError(
            "RequiresReplacement",
            "DocumentationVersion and RestApiId changes require replacement",
            409,
          );
        }
        const raw = await call<JsonObject>(service, "PATCH", documentationVersionPath(restApiId, version), {
          patchOperations: [patchValue("/description", desired.Description)],
        }, undefined, ownerValue(context));
        return success(physicalId, { ...documentationVersionReadModel(restApiId, raw), physicalId });
      } catch (error) {
        return failure(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const [restApiId, version] = parsePhysical(physicalId, "documentation-version", 2);
        await call(
          service,
          "DELETE",
          documentationVersionPath(restApiId, version),
          undefined,
          undefined,
          ownerValue(context),
        );
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error);
      }
    },
    ref(model) {
      return `${model.properties.DocumentationVersion}|${model.properties.RestApiId}`;
    },
    getAtt(model, attribute) {
      return getAtt(
        API_GATEWAY_DOCUMENTATION_VERSION_TYPE,
        API_GATEWAY_DOCUMENTATION_VERSION_SCHEMA,
        model,
        attribute,
      );
    },
  };
}

export function createApiGatewayRestCfn15CloudFormationProviders(
  service: ApiGatewayService,
): readonly ProductionResourceProvider<any>[] {
  return [
    createApiGatewayDomainNameProvider(service),
    createApiGatewayBasePathMappingProvider(service),
    createApiGatewayDomainNameV2Provider(service),
    createApiGatewayBasePathMappingV2Provider(service),
    createApiGatewayDomainNameAccessAssociationProvider(service),
    createApiGatewayVpcLinkProvider(service),
    createApiGatewayClientCertificateProvider(service),
    createApiGatewayDocumentationPartProvider(service),
    createApiGatewayDocumentationVersionProvider(service),
  ];
}
