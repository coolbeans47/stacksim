import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import { awsQueryErrorXml, parseAwsQuery, sendAwsQueryXml } from "./protocols/query-xml.js";
import type { StateStore } from "./state.js";
import type { S3Service } from "./s3.js";
import type {
  CloudFormationChangeSetState,
  CloudFormationOutputState,
  CloudFormationNotificationOutboxState,
  CloudFormationParameterState,
  CloudFormationResourceStatus,
  CloudFormationStackEventState,
  CloudFormationStackResourceState,
  CloudFormationStackState,
  CloudFormationStackStatus,
} from "./types.js";
import { readBody } from "./util.js";
import { parseLocalS3ObjectUrl, readLocalS3Template } from "./cloudformation/assets.js";
import { CloudFormationJournal } from "./cloudformation/journal.js";
import { publishCompletedDeploymentGeneration, removeCompletedDeploymentOwnership } from "./cloudformation/hotswap.js";
import type { CustomResourceCallbackBroker } from "./cloudformation/custom-resource-callbacks.js";
import { buildResourceDependencyGraph } from "./cloudformation/dependencies.js";
import { collectImportValueNames, collectIntrinsicReferences, evaluateIntrinsicValue } from "./cloudformation/intrinsics.js";
import { cloudFormationPseudoParameters, conditionallyProcessedTemplate, evaluateTemplateConditions, resolveTemplateParameters, validateTemplateRules, type ResolvedParameters } from "./cloudformation/parameters.js";
import { parseCloudFormationTemplate, TemplateValidationError, type CloudFormationTemplate } from "./cloudformation/template.js";
import { collectDynamicReferences, containsDynamicReference, dynamicReferencesInString, type ParsedDynamicReference } from "./cloudformation/dynamic-references.js";
import {
  createDefaultCloudFormationProviderRegistry,
  COGNITO_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  COGNITO_CLOUDFORMATION_RESOURCE_TYPES,
  COGNITO_USER_POOL_GROUP_TYPE,
  COGNITO_USER_POOL_TYPE,
  RDS_DB_INSTANCE_TYPE,
  RDS_DB_PARAMETER_GROUP_TYPE,
  SECRETS_MANAGER_SECRET_TYPE,
  SECRETS_MANAGER_SECRET_AUTHORIZATION_MATRIX,
  SECRETS_MANAGER_RESOURCE_POLICY_TYPE,
  SECRETS_MANAGER_RESOURCE_POLICY_AUTHORIZATION_MATRIX,
  SECRETS_MANAGER_ROTATION_SCHEDULE_TYPE,
  SECRETS_MANAGER_ROTATION_SCHEDULE_AUTHORIZATION_MATRIX,
  SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_TYPE,
  SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_AUTHORIZATION_MATRIX,
  rdsDbParameterGroupPhysicalId,
  SES_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  SES_CLOUDFORMATION_RESOURCE_TYPES,
  SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
  SES_CONFIGURATION_SET_TYPE,
  SES_CONTACT_LIST_TYPE,
  SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
  SES_EMAIL_IDENTITY_TYPE,
  SES_TEMPLATE_TYPE,
  sesCloudFormationPhysicalId,
  SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  SNS_CLOUDFORMATION_RESOURCE_TYPES,
  CLOUDFORMATION_NESTED_STACK_TYPE,
  createNestedStackProvider,
  type NestedStackAdapter,
  type NestedStackModel,
  type NestedStackSnapshot,
  type CloudFormationResourceProvider,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderOperation,
  type ProviderOperationCheckpoint,
  type ProviderProgress,
  validateDeclaredProperties,
} from "./cloudformation/providers/index.js";

const NAMESPACE = "http://cloudformation.amazonaws.com/doc/2010-05-15/";
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
export const CLOUDFORMATION_SUPPORTED_ACTIONS = Object.freeze([
  "ValidateTemplate", "CreateStack", "DescribeStacks", "ListStacks", "DescribeStackEvents",
  "DescribeStackResource", "DescribeStackResources", "ListStackResources", "GetTemplate",
  "GetTemplateSummary", "UpdateTerminationProtection", "DeleteStack",
  "UpdateStack", "CancelUpdateStack", "RollbackStack", "ContinueUpdateRollback",
  "CreateChangeSet", "DescribeChangeSet", "ListChangeSets", "DeleteChangeSet", "ExecuteChangeSet",
  "ListExports", "ListImports",
]);
const SUPPORTED_ACTIONS = new Set<string>(CLOUDFORMATION_SUPPORTED_ACTIONS);
const MUTATING_ACTIONS = new Set([
  "CreateStack", "UpdateStack", "CancelUpdateStack", "RollbackStack", "ContinueUpdateRollback", "DeleteStack", "UpdateTerminationProtection",
  "CreateChangeSet", "DeleteChangeSet", "ExecuteChangeSet",
]);

interface ParsedTemplate {
  body: string;
  value: CloudFormationTemplate;
  digest: string;
  source?: TemplateSourceArtifact;
}

interface TemplateSourceArtifact {
  readonly templateUrl: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly etag: string;
  readonly size: number;
  readonly digest: string;
}

interface NestedStackHierarchyInput {
  readonly parentId: string;
  readonly rootId: string;
  readonly parentLogicalId: string;
  readonly source: NestedStackModel;
  readonly parentOperationId: string;
  readonly stackId?: string;
}

interface CloudFormationAssetReference {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly propertyPath: "Code" | "Content" | "BodyS3Location" | "SourceObjectKeys";
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly etag: string;
  readonly size: number;
}

interface CloudFormationAssetManifest {
  readonly schemaVersion: 1;
  readonly references: readonly CloudFormationAssetReference[];
}

interface NestedTemplateAsset {
  readonly logicalId: string;
  readonly logicalPath?: string;
  readonly templateUrl: string;
  readonly body: string;
  readonly digest: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly etag: string;
  readonly size: number;
  readonly sourceDigest?: string;
  readonly childStackId?: string;
  readonly childStackName?: string;
  readonly outputs?: readonly string[];
  readonly nestedTemplateManifest?: NestedTemplateManifest;
}

interface NestedTemplateManifest {
  readonly schemaVersion: 1 | 2;
  readonly assets: readonly NestedTemplateAsset[];
  readonly totalResources?: number;
  readonly totalTemplates?: number;
  readonly uniqueTemplateBytes?: number;
  readonly admissionFailure?: string;
}

interface RecursiveAdmissionNode {
  readonly logicalPath: string;
  readonly stackId: string;
  readonly stackName: string;
  readonly template: CloudFormationTemplate;
  readonly parameters: Record<string, unknown>;
  readonly pseudoParameters: Record<string, unknown>;
  readonly conditions: Record<string, boolean>;
  readonly tags: Record<string, string>;
  readonly previousResources: Record<string, CloudFormationStackResourceState>;
  readonly manifest: NestedTemplateManifest;
}

interface ProviderAuthorizationTarget {
  readonly action: string;
  readonly resource: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

interface OperationJournalPayload {
  stackId: string;
  stackName: string;
  kind: string;
  checkpoint: string;
  stackStatus: string;
  completedLogicalIds: string[];
  failureReason?: string;
}

interface ChangeSetPlanningArtifact {
  schemaVersion: 1;
  input: Record<string, unknown>;
  principal: PrincipalContext;
  planningOperationId: string;
  baselineDigest: string;
  availableExports: Record<string, string>;
}

interface ChangeSetExecutionArtifact {
  schemaVersion: 2;
  StackName: string;
  processedTemplateBody: string;
  originalTemplateBody: string;
  originalTemplateDigest: string;
  processedTemplateDigest: string;
  /** Admission limit of the original template source, retained for execution. */
  templateBodyMaximumBytes?: number;
  Parameters: any[];
  Capabilities: string[];
  RoleARN?: string;
  NotificationARNs: string[];
  RollbackConfiguration?: unknown;
  Tags: Array<{ Key: string; Value: string }>;
  baselineTemplateDigest?: string;
  baselineProcessedTemplateDigest?: string;
  imports: Record<string, string>;
  ssmParameters: Array<{ name: string; value: string }>;
  nestedTemplateManifest?: NestedTemplateManifest;
  templateSource?: TemplateSourceArtifact;
}

type ResourceMutationKind = "CREATE" | "UPDATE" | "DELETE" | "REPLACE_CREATE" | "REPLACE_DELETE";

interface ResourceMutationRecord {
  key: string;
  sequence: number;
  logicalId: string;
  kind: ResourceMutationKind;
  status: "INTENT" | "COMPLETE";
  before?: CloudFormationStackResourceState;
  after?: CloudFormationStackResourceState;
  rollbackStatus?: "COMPLETE" | "SKIPPED" | "FAILED";
  rollbackReason?: string;
  rollbackAfter?: CloudFormationStackResourceState;
  replacementOrder?: "CREATE_BEFORE_DELETE" | "DELETE_BEFORE_CREATE";
  retentionPolicy?: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot";
}

interface ResourceMutationLedger {
  schemaVersion: 1;
  records: ResourceMutationRecord[];
}

interface PreflightResourceModel {
  readonly properties: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly plan: {
    readonly action: "CREATE" | "NO_OP" | "UPDATE" | "REPLACE";
    readonly changedProperties: readonly string[];
    readonly replacementProperties: readonly string[];
  };
}

interface PreparedTemplateArtifact {
  readonly originalBody: string;
  readonly originalDigest: string;
  readonly templateBodyMaximumBytes: number;
  readonly assetManifest?: CloudFormationAssetManifest;
  readonly nestedTemplateManifest?: NestedTemplateManifest;
  readonly templateSource?: TemplateSourceArtifact;
}

class ProviderDeferred extends Error {
  constructor(readonly resumeAfter: number) {
    super(`Provider callback is scheduled for ${new Date(resumeAfter).toISOString()}`);
    this.name = "ProviderDeferred";
  }
}

class ProviderInvocationFailure extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(`${errorCode}: ${message}`);
    this.name = "ProviderInvocationFailure";
  }
}

export interface CloudFormationCheckpointObservation {
  readonly stackId: string;
  readonly stackName: string;
  readonly operationId: string;
  readonly operationKind: NonNullable<CloudFormationStackState["activeOperation"]>["kind"];
  readonly checkpoint: string;
  readonly stackStatus: CloudFormationStackState["stackStatus"];
  readonly logicalResourceId?: string;
  readonly resourceType?: string;
}

export type CloudFormationCheckpointInterceptor = (
  observation: CloudFormationCheckpointObservation,
) => boolean | Promise<boolean>;

// The deadline is the authoritative stabilization bound.  A 15-minute custom
// resource polling every 250 ms legitimately needs up to 3,600 callbacks, and
// RDS can likewise require hundreds of short polls during local engine start.
const MAX_PROVIDER_ATTEMPTS = 4_096;
const PROVIDER_DEADLINE_MS = 15 * 60_000;
const EXECUTOR_LEASE_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
const TEMPLATE_BODY_MAXIMUM_BYTES = 51_200;
const TEMPLATE_URL_MAXIMUM_BYTES = 1_048_576;

export interface CloudFormationRetentionPolicy {
  /** Age after which terminal catalog entries may be reclaimed. */
  historyRetentionMs: number;
  /** Hard bounds apply even when more entries are younger than the age window. */
  maxDeletedStacks: number;
  maxTerminalChangeSets: number;
  maxTerminalJournalOperations: number;
  maxStackEvents: number;
  maxClientTokens: number;
  /** Available/planning change sets are protected, so admission enforces a quota. */
  maxActiveChangeSetsPerStack: number;
}

const DEFAULT_RETENTION_POLICY: CloudFormationRetentionPolicy = {
  historyRetentionMs: 7 * DAY_MS,
  maxDeletedStacks: 100,
  maxTerminalChangeSets: 1_000,
  maxTerminalJournalOperations: 1_000,
  maxStackEvents: 2_000,
  maxClientTokens: 10_000,
  maxActiveChangeSetsPerStack: 1_000,
};

// The CloudFormation Query serializer emits empty collections as `Name=`.
// Treat that wire representation as an empty list rather than one blank item.
function list<T>(value: T | T[] | undefined): T[] { return value === undefined || value === "" ? [] : Array.isArray(value) ? value : [value]; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function isIntrinsicExpression(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value); return keys.length === 1 && (keys[0] === "Ref" || keys[0] === "Condition" || keys[0].startsWith("Fn::"));
}

interface ChangeDetailCause {
  readonly Evaluation: "Static" | "Dynamic";
  readonly ChangeSource: "DirectModification" | "ParameterReference" | "ResourceReference" | "ResourceAttribute";
  readonly CausingEntity?: string;
}

function changeDetailCauses(value: unknown, template: CloudFormationTemplate): ChangeDetailCause[] {
  const parameters = new Set(Object.keys(template.Parameters ?? {}));
  const resources = new Set(Object.keys(template.Resources ?? {}));
  const found = new Map<string, ChangeDetailCause>();
  const add = (cause: ChangeDetailCause): void => {
    const key = `${cause.ChangeSource}\0${cause.CausingEntity ?? ""}`;
    found.set(key, cause);
  };
  const symbolic = (name: string): void => {
    if (parameters.has(name)) add({ Evaluation: "Static", ChangeSource: "ParameterReference", CausingEntity: name });
    else if (resources.has(name)) add({ Evaluation: "Dynamic", ChangeSource: "ResourceReference", CausingEntity: name });
  };
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return; }
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    if (typeof record.Ref === "string") { symbolic(record.Ref); return; }
    if (record["Fn::GetAtt"] !== undefined) {
      const getAtt = record["Fn::GetAtt"];
      const parts = Array.isArray(getAtt) ? getAtt.map(String) : String(getAtt).split(".", 2);
      if (parts[0] && resources.has(parts[0])) add({ Evaluation: "Dynamic", ChangeSource: "ResourceAttribute", CausingEntity: parts.length > 1 ? `${parts[0]}.${parts[1]}` : parts[0] });
      return;
    }
    if (record["Fn::Sub"] !== undefined) {
      const sub = record["Fn::Sub"];
      const source = Array.isArray(sub) ? String(sub[0] ?? "") : String(sub);
      const variables = Array.isArray(sub) && sub[1] && typeof sub[1] === "object" && !Array.isArray(sub[1]) ? sub[1] as Record<string, unknown> : {};
      for (const match of source.matchAll(/\$\{([^}]+)\}/g)) {
        const token = match[1];
        if (token.startsWith("!")) continue;
        if (Object.hasOwn(variables, token)) visit(variables[token]);
        else if (token.includes(".")) {
          const [logicalId, attribute] = token.split(".", 2);
          if (resources.has(logicalId)) add({ Evaluation: "Dynamic", ChangeSource: "ResourceAttribute", CausingEntity: `${logicalId}.${attribute}` });
        } else symbolic(token);
      }
      for (const mapped of Object.values(variables)) visit(mapped);
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  const causes = [...found.values()].sort((left, right) => left.ChangeSource.localeCompare(right.ChangeSource) || (left.CausingEntity ?? "").localeCompare(right.CausingEntity ?? ""));
  return causes.length ? causes : [{ Evaluation: "Static", ChangeSource: "DirectModification" }];
}

function tags(input: any): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of list<any>(input)) {
    const key = String(tag?.Key ?? ""); const value = String(tag?.Value ?? "");
    if (!key || key.length > 128 || value.length > 256 || key.toLowerCase().startsWith("aws:")) throw new AwsError("ValidationError", "Stack tags contain an invalid key or value", 400);
    if (result[key] !== undefined) throw new AwsError("ValidationError", `Duplicate tag key ${key}`, 400);
    result[key] = value;
  }
  if (Object.keys(result).length > 50) throw new AwsError("ValidationError", "A stack can have at most 50 tags", 400);
  return result;
}

function parameters(input: any): CloudFormationParameterState[] {
  const values = list<any>(input);
  if (values.length > 200) throw new AwsError("ValidationError", "A stack can have at most 200 parameters", 400);
  const seen = new Set<string>();
  return values.map(item => {
    const parameterKey = String(item?.ParameterKey ?? "");
    if (!parameterKey || seen.has(parameterKey)) throw new AwsError("ValidationError", "Parameters require unique ParameterKey values", 400);
    seen.add(parameterKey);
    if (item?.UsePreviousValue === true && item?.ParameterValue !== undefined) throw new AwsError("ValidationError", `Parameter ${parameterKey} cannot specify both ParameterValue and UsePreviousValue`, 400);
    return { parameterKey, ...(item?.ParameterValue !== undefined ? { parameterValue: String(item.ParameterValue) } : {}), ...(item?.ResolvedValue !== undefined ? { resolvedValue: String(item.ResolvedValue) } : {}), ...(item?.UsePreviousValue === true ? { usePreviousValue: true } : {}) };
  });
}

function parameterView(parameter: CloudFormationParameterState): any {
  return { ParameterKey: parameter.parameterKey, ParameterValue: parameter.noEcho ? "****" : parameter.parameterValue, ResolvedValue: parameter.noEcho ? "****" : parameter.resolvedValue, UsePreviousValue: parameter.usePreviousValue };
}

function outputView(output: CloudFormationOutputState): any {
  return { OutputKey: output.outputKey, OutputValue: output.outputValue, Description: output.description, ExportName: output.exportName };
}

function resourceView(stack: CloudFormationStackState, resource: CloudFormationStackResourceState): any {
  return {
    StackId: stack.stackId,
    StackName: stack.stackName,
    LogicalResourceId: resource.logicalResourceId,
    PhysicalResourceId: resource.physicalResourceId,
    ResourceType: resource.resourceType,
    Timestamp: new Date(resource.lastUpdatedTimestamp),
    ResourceStatus: resource.resourceStatus,
    ResourceStatusReason: resource.resourceStatusReason,
    DriftInformation: { StackResourceDriftStatus: "NOT_CHECKED" },
  };
}

export class CloudFormationService {
  private readonly tokens: PaginationTokens;
  private readonly journal: CloudFormationJournal<OperationJournalPayload>;
  private readonly providers;
  private readonly executorId = randomUUID();
  private readonly running = new Map<string, Promise<void>>();
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private assetReclaimTimer?: ReturnType<typeof setTimeout>;
  private assetAdmissions = 0;
  private catalogAdmissions = 0;
  private retentionRequested = false;
  private readonly retentionPolicy: CloudFormationRetentionPolicy;
  private retentionRun?: Promise<void>;
  private started?: Promise<void>;
  private stopping = false;
  private checkpointInterceptorForTest?: CloudFormationCheckpointInterceptor;
  private publishNotification?: (topicArn: string, message: string, stackId: string) => Promise<void>;
  private notificationDrain?: Promise<void>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private bootstrapParameterResolver?: (name: string) => string | undefined;
  private dynamicReferenceResolver?: (reference: ParsedDynamicReference) => Promise<string>;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly s3: S3Service,
    private readonly assumeExecutionRole?: (roleArn: string, sessionName: string) => Promise<PrincipalContext>,
    providers: Iterable<ProductionResourceProvider<any>> = [],
    private readonly authorizeProviderTargets?: (principal: PrincipalContext, targets: readonly ProviderAuthorizationTarget[]) => Promise<void>,
    retentionPolicy: Partial<CloudFormationRetentionPolicy> = {},
    customResourceFactory?: (typeName: string) => ProductionResourceProvider<any>,
    private readonly customResourceCallbacks?: Pick<CustomResourceCallbackBroker, "sweep">,
  ) {
    this.tokens = new PaginationTokens(store.state.installation.paginationSecret);
    this.journal = new CloudFormationJournal<OperationJournalPayload>(store.root, store.accountId, region);
    this.providers = createDefaultCloudFormationProviderRegistry().registerAll(providers).register(createNestedStackProvider(this.nestedStackAdapter()));
    if (customResourceFactory) this.providers.setCustomResourceFactory(customResourceFactory);
    this.retentionPolicy = this.normalizedRetentionPolicy(retentionPolicy);
    this.installCatalogAdmissionWrappers();
  }

  private get state() { return this.store.regionState(this.region).cloudformation; }

  private nestedStackAdapter(): NestedStackAdapter {
    return {
      create: (desired, context) => this.createNestedStack(desired, context),
      read: (stackId, context) => this.readNestedStack(stackId, context),
      update: (stackId, previous, desired, context) => this.updateNestedStack(stackId, previous, desired, context),
      delete: (stackId, previous, context) => this.deleteNestedStack(stackId, previous, context),
    };
  }

  private nestedStackName(parent: CloudFormationStackState, logicalId: string): string {
    const suffix = createHash("sha256").update(`${parent.stackId}:${logicalId}`).digest("hex").slice(0, 12);
    const prefix = `${parent.stackName}-${logicalId}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 115).replace(/-+$/g, "");
    return `${prefix || "NestedStack"}-${suffix}`;
  }

  private nestedStackInput(parent: CloudFormationStackState, desired: NestedStackModel, clientRequestToken: string): Record<string, unknown> {
    return {
      TemplateURL: desired.TemplateURL,
      Parameters: Object.entries(desired.Parameters ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      NotificationARNs: [...(desired.NotificationARNs ?? [])],
      Tags: (desired.Tags ?? []).map(tag => ({ Key: tag.Key, Value: tag.Value })),
      Capabilities: [...parent.capabilities],
      ClientRequestToken: clientRequestToken,
    };
  }

  private nestedTemplateSourceDigest(value: Pick<NestedStackModel, "TemplateURL" | "Parameters">): string {
    return createHash("sha256").update(canonical({ TemplateURL: value.TemplateURL, Parameters: value.Parameters ?? {} })).digest("hex");
  }

  private async pinnedNestedTemplate(parent: CloudFormationStackState, logicalId: string, desired: NestedStackModel): Promise<NestedTemplateAsset | undefined> {
    const operation = parent.activeOperation;
    const artifactIds = [...new Set([
      operation?.desiredTemplateArtifactId,
      operation?.previousTemplateArtifactId,
      parent.templateArtifactId,
    ].filter((value): value is string => typeof value === "string" && value.length > 0))];
    for (const artifactId of artifactIds) {
      const manifest = await this.journal.readJsonArtifact<NestedTemplateManifest>("plans", `${artifactId}.nested-templates.json`);
      const matching = manifest && (manifest.schemaVersion === 1 || manifest.schemaVersion === 2) ? manifest.assets.filter(candidate => candidate.logicalId === logicalId && candidate.templateUrl === desired.TemplateURL) : [];
      const desiredDigest = this.nestedTemplateSourceDigest(desired);
      const asset = matching?.find(candidate => candidate.sourceDigest === desiredDigest) ?? matching?.find(candidate => candidate.sourceDigest === undefined);
      if (!asset) continue;
      if (createHash("sha256").update(asset.body).digest("hex") !== asset.digest || Buffer.byteLength(asset.body) !== asset.size) throw new Error(`Pinned nested template for ${logicalId} failed integrity validation`);
      return asset;
    }
    return undefined;
  }

  private async linkedNestedTemplateManifest(childStackId: string, templateDigest: string, parentOperationId: string): Promise<NestedTemplateManifest | undefined> {
    const parentStack = Object.values(this.state.stacks).find(candidate => candidate.activeOperation?.operationId === parentOperationId);
    const rootOperationId = parentStack?.activeOperation?.owningParentOperationId ?? parentOperationId;
    const rootChangeSet = Object.values(this.state.changeSets).find(candidate => candidate.executionOperationId === rootOperationId && !candidate.parentChangeSetId);
    if (!rootChangeSet) return undefined;
    const linked = Object.values(this.state.changeSets)
      .filter(candidate => candidate.stackId === childStackId && candidate.rootChangeSetId === rootChangeSet.changeSetId && candidate.templateDigest === templateDigest && candidate.templateArtifactId)
      .sort((left, right) => right.creationTime - left.creationTime || right.changeSetId.localeCompare(left.changeSetId))[0];
    if (!linked?.templateArtifactId) return undefined;
    return this.journal.readJsonArtifact<NestedTemplateManifest>("plans", `${linked.templateArtifactId}.nested-templates.json`);
  }

  private nestedSnapshot(child: CloudFormationStackState, fallback: NestedStackModel): NestedStackSnapshot {
    return {
      stackId: child.stackId,
      status: child.stackStatus,
      outputs: Object.fromEntries(child.outputs.map(output => [output.outputKey, output.outputValue])),
      properties: structuredClone((child.nestedStackSource ?? fallback) as unknown as NestedStackModel),
    };
  }

  private nestedProgress(child: CloudFormationStackState, action: "CREATE" | "UPDATE" | "DELETE") {
    return {
      status: "IN_PROGRESS" as const,
      callbackAfterMs: 25,
      checkpoint: {
        schemaVersion: 1 as const,
        callbackContext: {
          childStackId: child.stackId,
          childOperationId: child.activeOperation?.operationId ?? "settling",
          action,
        },
        physicalId: child.stackId,
      },
      message: `Nested stack ${child.stackName} is ${child.stackStatus}`,
    };
  }

  private nestedFailure(child: CloudFormationStackState, action: string, includePhysicalId = false) {
    return {
      status: "FAILED" as const,
      errorCode: "NestedStackFailure",
      message: `Nested stack ${child.stackName} failed ${action} in ${child.stackStatus}${child.stackStatusReason ? `: ${child.stackStatusReason}` : ""}`,
      ...(includePhysicalId ? { physicalId: child.stackId } : {}),
    };
  }

  private nestedSourceMatches(child: CloudFormationStackState, desired: NestedStackModel): boolean {
    return child.nestedStackSource !== undefined && canonical(child.nestedStackSource) === canonical(desired);
  }

  private async createNestedStack(desired: NestedStackModel, context: ProviderContext) {
    const parent = this.state.stacks[context.stackId];
    if (!parent) return { status: "FAILED" as const, errorCode: "ParentStackNotFound", message: `Parent stack ${context.stackId} no longer exists` };
    const callbackId = typeof context.callbackContext?.childStackId === "string" ? context.callbackContext.childStackId : undefined;
    const childName = this.nestedStackName(parent, context.logicalId);
    const existingId = callbackId ?? this.state.stackNames[childName];
    let child = existingId ? this.state.stacks[existingId] : undefined;
    if (child && (child.parentId !== parent.stackId || child.parentLogicalId !== context.logicalId)) {
      return { status: "FAILED" as const, errorCode: "OwnershipConflict", message: `Generated nested stack name ${childName} is not owned by ${parent.stackName}.${context.logicalId}` };
    }
    if (!child || child.stackStatus === "DELETE_COMPLETE" || child.stackStatus === "REVIEW_IN_PROGRESS") {
      try {
        const token = `nested-${context.resourceOperationId.slice(0, 40)}`;
        const input: Record<string, unknown> = { StackName: childName, ...this.nestedStackInput(parent, desired, token) };
        const pinned = await this.pinnedNestedTemplate(parent, context.logicalId, desired);
        let prepared: PreparedTemplateArtifact | undefined;
        if (pinned) {
          delete input.TemplateURL;
          input.TemplateBody = pinned.body;
          prepared = {
            originalBody: pinned.body,
            originalDigest: pinned.digest,
            templateBodyMaximumBytes: TEMPLATE_URL_MAXIMUM_BYTES,
            nestedTemplateManifest: pinned.nestedTemplateManifest ?? (child ? await this.linkedNestedTemplateManifest(child.stackId, pinned.digest, context.operationId) : undefined),
            templateSource: { templateUrl: pinned.templateUrl, bucket: pinned.bucket, key: pinned.key, versionId: pinned.versionId, etag: pinned.etag, size: pinned.size, digest: pinned.digest },
          };
        }
        const reviewStack = child?.stackStatus === "REVIEW_IN_PROGRESS" ? child : undefined;
        const result = await this.CreateStack(
          input,
          context.principal.identity as PrincipalContext,
          reviewStack,
          prepared,
          { parentId: parent.stackId, rootId: parent.rootId ?? parent.stackId, parentLogicalId: context.logicalId, source: desired, parentOperationId: context.operationId, stackId: pinned?.childStackId },
        );
        child = this.state.stacks[String(result.StackId)];
      } catch (error) {
        const aws = error instanceof AwsError ? error : new AwsError("NestedStackFailure", error instanceof Error ? error.message : String(error), 400);
        return { status: "FAILED" as const, errorCode: aws.code, message: aws.message };
      }
    }
    if (!child) return { status: "FAILED" as const, errorCode: "NestedStackFailure", message: `Nested stack ${childName} was not durably published` };
    if (child.stackStatus === "CREATE_COMPLETE" && this.nestedSourceMatches(child, desired)) return this.nestedSnapshot(child, desired);
    if (child.activeOperation?.status === "PENDING" || child.activeOperation?.status === "RUNNING") return this.nestedProgress(child, "CREATE");
    return this.nestedFailure(child, "creation", true);
  }

  private async readNestedStack(stackId: string, context: ProviderContext): Promise<NestedStackSnapshot | undefined> {
    const child = this.state.stacks[stackId];
    if (!child || child.stackStatus === "DELETE_COMPLETE" || child.parentId !== context.stackId || child.parentLogicalId !== context.logicalId) return undefined;
    return this.nestedSnapshot(child, (child.nestedStackSource ?? {}) as unknown as NestedStackModel);
  }

  private async updateNestedStack(stackId: string, _previous: NestedStackModel, desired: NestedStackModel, context: ProviderContext) {
    const parent = this.state.stacks[context.stackId];
    const child = this.state.stacks[stackId];
    if (!parent) return { status: "FAILED" as const, errorCode: "ParentStackNotFound", message: `Parent stack ${context.stackId} no longer exists` };
    if (!child || child.stackStatus === "DELETE_COMPLETE") return { status: "FAILED" as const, errorCode: "NotFound", message: `Nested child stack ${stackId} no longer exists` };
    if (child.parentId !== parent.stackId || child.parentLogicalId !== context.logicalId) return { status: "FAILED" as const, errorCode: "OwnershipConflict", message: `Nested child stack ${stackId} is not owned by ${parent.stackName}.${context.logicalId}` };
    if (child.activeOperation?.status === "PENDING" || child.activeOperation?.status === "RUNNING") return this.nestedProgress(child, "UPDATE");
    if (this.nestedSourceMatches(child, desired) && new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]).has(child.stackStatus)) return this.nestedSnapshot(child, desired);
    if (new Set(["UPDATE_FAILED", "UPDATE_ROLLBACK_FAILED", "UPDATE_ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "ROLLBACK_COMPLETE"]).has(child.stackStatus) && !this.nestedSourceMatches(child, desired)) return this.nestedFailure(child, "update");
    try {
      const token = `nested-${context.resourceOperationId.slice(0, 40)}`;
      const input: Record<string, unknown> = { StackName: child.stackId, ...this.nestedStackInput(parent, desired, token) };
      const pinned = await this.pinnedNestedTemplate(parent, context.logicalId, desired);
      let prepared: PreparedTemplateArtifact | undefined;
      if (pinned) {
        delete input.TemplateURL;
        input.TemplateBody = pinned.body;
        prepared = {
          originalBody: pinned.body,
          originalDigest: pinned.digest,
          templateBodyMaximumBytes: TEMPLATE_URL_MAXIMUM_BYTES,
          nestedTemplateManifest: pinned.nestedTemplateManifest ?? await this.linkedNestedTemplateManifest(child.stackId, pinned.digest, context.operationId),
          templateSource: { templateUrl: pinned.templateUrl, bucket: pinned.bucket, key: pinned.key, versionId: pinned.versionId, etag: pinned.etag, size: pinned.size, digest: pinned.digest },
        };
      }
      await this.UpdateStack(
        input,
        context.principal.identity as PrincipalContext,
        prepared,
        desired,
        context.operationId,
      );
      return this.nestedProgress(child, "UPDATE");
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("NestedStackFailure", error instanceof Error ? error.message : String(error), 400);
      return { status: "FAILED" as const, errorCode: aws.code, message: aws.message };
    }
  }

  private async deleteNestedStack(stackId: string, _previous: NestedStackModel, context: ProviderContext) {
    const child = this.state.stacks[stackId];
    if (!child || child.stackStatus === "DELETE_COMPLETE") return "DELETED" as const;
    if (child.parentId !== context.stackId || child.parentLogicalId !== context.logicalId) return { status: "FAILED" as const, errorCode: "OwnershipConflict", message: `Nested child stack ${stackId} is no longer owned by ${context.stackId}.${context.logicalId}` };
    if (child.activeOperation?.status === "PENDING" || child.activeOperation?.status === "RUNNING") return this.nestedProgress(child, "DELETE");
    if (child.stackStatus === "DELETE_FAILED") return this.nestedFailure(child, "deletion");
    try {
      await this.DeleteStack({ StackName: child.stackId, ClientRequestToken: `nested-${context.resourceOperationId.slice(0, 40)}` }, context.principal.identity as PrincipalContext, true, context.operationId);
      return this.nestedProgress(child, "DELETE");
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("NestedStackFailure", error instanceof Error ? error.message : String(error), 400);
      return { status: "FAILED" as const, errorCode: aws.code, message: aws.message };
    }
  }

  /**
   * Installs a deterministic, test-only process-interruption point after a
   * checkpoint has reached both the journal and the state store. Returning
   * true pauses the executor without marking the stack operation as failed;
   * constructing a new service over the same data directory resumes it.
   */
  setCheckpointInterceptorForTest(interceptor?: CloudFormationCheckpointInterceptor): void {
    this.checkpointInterceptorForTest = interceptor;
  }

  setSnsNotificationPublisher(publisher: (topicArn: string, message: string, stackId: string) => Promise<void>): void {
    this.publishNotification = publisher;
    if (!this.stopping) void this.drainNotificationOutbox();
  }

  setBootstrapParameterResolver(resolver: (name: string) => string | undefined): void {
    this.bootstrapParameterResolver = resolver;
  }

  setDynamicReferenceResolver(resolver: (reference: ParsedDynamicReference) => Promise<string>): void {
    this.dynamicReferenceResolver = resolver;
  }

  private async resolveDynamicReferenceProperties(typeName: string, properties: Record<string, unknown>, principal: PrincipalContext): Promise<Record<string, unknown>> {
    const provider = this.providers.require(typeName);
    const visit = async (value: unknown, path: string, topProperty?: string): Promise<unknown> => {
      if (typeof value === "string") {
        const references = dynamicReferencesInString(value, path);
        let resolved = value;
        for (const reference of references) {
          if (reference.secret) {
            if (typeName === "AWS::CloudFormation::CustomResource" || typeName.startsWith("Custom::")) throw new AwsError("ValidationError", `Secure dynamic references are not supported in custom resources at ${path}`, 400);
            const declaration = topProperty ? provider.schema.properties[topProperty] : undefined;
            if (declaration?.updateBehavior === "REPLACEMENT") throw new AwsError("ValidationError", `Secure dynamic references cannot contribute to a primary identifier at ${path}`, 400);
            const reviewedDestination = typeName === RDS_DB_INSTANCE_TYPE && topProperty === "MasterUserPassword"
              || typeName === SECRETS_MANAGER_SECRET_TYPE && topProperty === "SecretString";
            if (!reviewedDestination) throw new AwsError("ValidationError", `Secure dynamic reference destination ${typeName}.${topProperty ?? "Properties"} has no reviewed protected-storage contract`, 400);
          }
          let resource: string;
          let action: string;
          let context: Readonly<Record<string, unknown>> | undefined;
          if (reference.family === "secretsmanager") {
            action = "secretsmanager:GetSecretValue";
            resource = reference.secretId!.startsWith("arn:") ? reference.secretId! : `arn:aws:secretsmanager:${this.region}:${this.store.accountId}:secret:${reference.secretId}-*`;
            context = { ...(reference.versionStage || !reference.versionId ? { "secretsmanager:VersionStage": reference.versionStage ?? "AWSCURRENT" } : {}), ...(reference.versionId ? { "secretsmanager:VersionId": reference.versionId } : {}) };
          } else {
            action = "ssm:GetParameters";
            resource = `arn:aws:ssm:${this.region}:${this.store.accountId}:parameter/${reference.parameterName!.replace(/^\/+/, "")}`;
          }
          if (this.authorizeProviderTargets) await this.authorizeProviderTargets(principal, [{ action, resource, ...(context ? { context } : {}) }]);
          if (!this.dynamicReferenceResolver) throw new AwsError("ValidationError", "CloudFormation dynamic-reference resolution is unavailable", 400);
          const replacement = await this.dynamicReferenceResolver(reference);
          resolved = resolved.split(reference.literal).join(replacement);
        }
        return resolved;
      }
      if (Array.isArray(value)) return Promise.all(value.map((item, index) => visit(item, `${path}[${index}]`, topProperty)));
      if (!value || typeof value !== "object") return value;
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = await visit(item, `${path}.${key}`, topProperty ?? key);
      return output;
    };
    return await visit(properties, `$.Properties`) as Record<string, unknown>;
  }

  private get notificationOutbox(): CloudFormationNotificationOutboxState[] {
    return (this.state.notificationOutbox ??= []);
  }

  private scheduleNotificationDrain(delayMs: number): void {
    if (this.stopping || this.notificationTimer) return;
    this.notificationTimer = this.clock.setTimeout(() => {
      this.notificationTimer = undefined;
      void this.drainNotificationOutbox();
    }, Math.max(0, delayMs));
  }

  private async drainNotificationOutbox(): Promise<void> {
    if (this.stopping || !this.publishNotification || this.notificationDrain) return this.notificationDrain;
    const running = (async () => {
      while (!this.stopping && this.publishNotification && this.notificationOutbox.length) {
        const pending = this.notificationOutbox[0];
        const delay = pending.nextAttemptAt - this.clock.now();
        if (delay > 0) { this.scheduleNotificationDrain(delay); return; }
        try {
          await this.publishNotification(pending.topicArn, pending.message, pending.stackId);
          this.notificationOutbox.shift();
          await this.store.save();
        } catch {
          pending.attempts++;
          const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(6, pending.attempts - 1));
          pending.nextAttemptAt = this.clock.now() + backoff;
          await this.store.save().catch(() => undefined);
          this.scheduleNotificationDrain(backoff);
          return;
        }
      }
    })();
    this.notificationDrain = running;
    try { await running; } finally { if (this.notificationDrain === running) this.notificationDrain = undefined; }
  }

  private normalizedRetentionPolicy(input: Partial<CloudFormationRetentionPolicy>): CloudFormationRetentionPolicy {
    const policy = { ...DEFAULT_RETENTION_POLICY, ...input };
    for (const [name, value] of Object.entries(policy)) {
      const allowsZero = name === "historyRetentionMs";
      if (!Number.isSafeInteger(value) || value < (allowsZero ? 0 : 1)) throw new Error(`${name} must be ${allowsZero ? "a non-negative" : "a positive"} safe integer`);
    }
    return policy;
  }

  private installCatalogAdmissionWrappers(): void {
    for (const action of SUPPORTED_ACTIONS) {
      const original = (this as any)[action];
      if (typeof original !== "function") continue;
      (this as any)[action] = async (...args: unknown[]) => {
        while (this.retentionRun) await this.retentionRun;
        this.catalogAdmissions += 1;
        try { return await original.apply(this, args); }
        finally {
          this.catalogAdmissions -= 1;
          if (MUTATING_ACTIONS.has(action)) this.retentionRequested = true;
          if (this.catalogAdmissions === 0 && this.assetAdmissions === 0 && this.retentionRequested) void this.maintainPersistenceRetention().catch(() => undefined);
        }
      };
    }
  }

  private maintainPersistenceRetention(): Promise<void> {
    if (this.retentionRun) return this.retentionRun;
    const tracked = this.performPersistenceRetention().finally(() => { if (this.retentionRun === tracked) this.retentionRun = undefined; });
    this.retentionRun = tracked;
    return tracked;
  }

  private async performPersistenceRetention(): Promise<void> {
    // Artifact admission and provider execution create new reachability roots.
    // Sweep only at quiescent boundaries; the last executor to finish retries.
    if (this.assetAdmissions > 0 || this.catalogAdmissions > 0 || this.running.size > 0 || Object.values(this.state.changeSets).some(value => value.status === "CREATE_IN_PROGRESS")) return;
    this.retentionRequested = false;

    const now = this.clock.now();
    const cutoff = now - this.retentionPolicy.historyRetentionMs;
    const journalEntries = await this.journal.readAll();
    const latestJournalEntry = new Map<string, (typeof journalEntries)[number]>();
    for (const entry of journalEntries) latestJournalEntry.set(entry.operationId, entry);
    const terminalJournalOperations = new Set([...latestJournalEntry].filter(([, entry]) => entry.terminal).map(([operationId]) => operationId));

    // Reconcile change-set execution before classifying terminal catalog rows.
    for (const value of Object.values(this.state.changeSets)) {
      if (value.executionStatus === "EXECUTE_IN_PROGRESS" && value.executionOperationId && terminalJournalOperations.has(value.executionOperationId)) {
        value.executionStatus = "EXECUTE_COMPLETE";
        value.lastUpdatedTime = Math.max(value.lastUpdatedTime, this.state.stacks[value.stackId]?.activeOperation?.completedAt ?? now);
      }
      if (this.state.stacks[value.stackId]?.stackStatus === "DELETE_COMPLETE" && value.status !== "DELETE_COMPLETE") {
        value.status = "DELETE_COMPLETE";
        value.executionStatus = value.executionStatus === "EXECUTE_COMPLETE" ? "EXECUTE_COMPLETE" : "UNAVAILABLE";
        value.lastUpdatedTime = Math.max(value.lastUpdatedTime, this.state.stacks[value.stackId].deletionTime ?? now);
        const key = this.changeSetKey(value.stackId, value.changeSetName);
        if (this.state.changeSetNames[key] === value.changeSetId) delete this.state.changeSetNames[key];
      }
    }

    const terminalChangeSets = Object.values(this.state.changeSets)
      .filter(value => !this.isProtectedChangeSet(value))
      .sort((left, right) => right.lastUpdatedTime - left.lastUpdatedTime || right.changeSetId.localeCompare(left.changeSetId));
    const retainedTerminalChangeSets = new Set(terminalChangeSets
      .filter(value => value.lastUpdatedTime >= cutoff)
      .slice(0, this.retentionPolicy.maxTerminalChangeSets)
      .map(value => value.changeSetId));
    const removedChangeSetIds = new Set<string>();
    for (const value of terminalChangeSets) {
      if (retainedTerminalChangeSets.has(value.changeSetId)) continue;
      removedChangeSetIds.add(value.changeSetId);
      delete this.state.changeSets[value.changeSetId];
      const key = this.changeSetKey(value.stackId, value.changeSetName);
      if (this.state.changeSetNames[key] === value.changeSetId) delete this.state.changeSetNames[key];
    }

    // A CREATE change set owns its REVIEW_IN_PROGRESS placeholder. Once no
    // retained change-set tombstone remains, release the name. Keeping the
    // placeholder while a recently deleted change set is retained preserves
    // existing DescribeStacks-by-ID behavior.
    for (const stack of Object.values(this.state.stacks)) {
      if (stack.stackStatus !== "REVIEW_IN_PROGRESS") continue;
      const hasRetainedChangeSet = Object.values(this.state.changeSets).some(value => value.stackId === stack.stackId);
      if (hasRetainedChangeSet) continue;
      stack.stackStatus = "DELETE_COMPLETE";
      stack.deletionTime = stack.creationTime;
      delete this.state.stackNames[stack.stackName];
      this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "DELETE_COMPLETE", "Review stack removed after its last change set expired or was deleted", stack.stackId);
    }

    const deletedStacks = Object.values(this.state.stacks)
      .filter(stack => stack.stackStatus === "DELETE_COMPLETE")
      .sort((left, right) => (right.deletionTime ?? right.creationTime) - (left.deletionTime ?? left.creationTime) || right.stackId.localeCompare(left.stackId));
    const retainedDeletedStacks = new Set(deletedStacks
      .filter(stack => (stack.deletionTime ?? stack.creationTime) >= cutoff)
      .slice(0, this.retentionPolicy.maxDeletedStacks)
      .map(stack => stack.stackId));
    const removedStackIds = new Set<string>();
    for (const stack of deletedStacks) {
      if (retainedDeletedStacks.has(stack.stackId)) continue;
      removedStackIds.add(stack.stackId);
      delete this.state.stacks[stack.stackId];
      if (this.state.stackNames[stack.stackName] === stack.stackId) delete this.state.stackNames[stack.stackName];
    }

    const protectedOperationIds = new Set<string>();
    for (const stack of Object.values(this.state.stacks)) {
      const operation = this.recoverableStackOperation(stack);
      if (!operation) continue;
      protectedOperationIds.add(operation.operationId);
      if (operation.rollbackSourceOperationId) protectedOperationIds.add(operation.rollbackSourceOperationId);
    }

    // Legacy records acquire a conservative timestamp on first maintenance;
    // subsequent sweeps can age them normally without a schema migration that
    // might accidentally discard an idempotency response on upgrade.
    for (const [token, record] of Object.entries(this.state.clientTokens)) {
      if (record.createdAt !== undefined) continue;
      const changeSet = record.changeSetId ? this.state.changeSets[record.changeSetId] : undefined;
      const stack = record.stackId ? this.state.stacks[record.stackId] : undefined;
      const stackOperation = stack?.activeOperation;
      const eventTime = stack?.events.filter(event => event.clientRequestToken === token).reduce((latest, event) => Math.max(latest, event.timestamp), Number.NEGATIVE_INFINITY);
      const operationAcceptedAt = stackOperation?.operationId === record.operationId ? stackOperation?.acceptedAt : undefined;
      record.createdAt = changeSet?.creationTime ?? (Number.isFinite(eventTime) ? eventTime : undefined) ?? operationAcceptedAt ?? now;
    }
    const tokenEntries = Object.entries(this.state.clientTokens);
    const protectedTokens = new Set(tokenEntries.filter(([, record]) => {
      if (record.operationId && protectedOperationIds.has(record.operationId)) return true;
      const changeSet = record.changeSetId ? this.state.changeSets[record.changeSetId] : undefined;
      return changeSet !== undefined && this.isProtectedChangeSet(changeSet);
    }).map(([token]) => token));
    const tokenSlots = Math.max(0, this.retentionPolicy.maxClientTokens - protectedTokens.size);
    const retainedOrdinaryTokens = new Set(tokenEntries
      .filter(([token, record]) => !protectedTokens.has(token) && !removedChangeSetIds.has(record.changeSetId ?? "") && !removedStackIds.has(record.stackId ?? "") && (record.createdAt ?? now) >= cutoff)
      .sort((left, right) => (right[1].createdAt ?? 0) - (left[1].createdAt ?? 0) || left[0].localeCompare(right[0]))
      .slice(0, tokenSlots)
      .map(([token]) => token));
    for (const [token, record] of tokenEntries) {
      if (protectedTokens.has(token) || retainedOrdinaryTokens.has(token)) continue;
      delete this.state.clientTokens[token];
    }

    for (const stack of Object.values(this.state.stacks)) this.compactStackEvents(stack, cutoff);

    // Persist the reduced catalog before deleting any referenced artifact. A
    // crash can therefore leave harmless orphans, never a live row whose
    // restart/rollback input disappeared.
    await this.store.save();

    const reachable = new Map<string, Set<string>>();
    const prefixReachable = new Map<string, Set<string>>();
    const mark = (collection: string, artifactId: string): void => {
      const values = reachable.get(collection) ?? new Set<string>(); values.add(artifactId); reachable.set(collection, values);
    };
    const markPrefix = (collection: string, prefix: string): void => {
      const values = prefixReachable.get(collection) ?? new Set<string>(); values.add(prefix); prefixReachable.set(collection, values);
    };
    const markTemplate = (artifactId: string): void => {
      mark("templates", `${artifactId}.original.template`); mark("templates", `${artifactId}.processed.template`); mark("templates", `${artifactId}.previous.template`);
      mark("parameters", `${artifactId}.private.json`); mark("execution", `${artifactId}.principal.json`); mark("assets", `${artifactId}.json`);
      for (const suffix of ["conditions", "graph", "imports", "stack", "provider-models", "nested-templates", "template-source"]) mark("plans", `${artifactId}.${suffix}.json`);
    };
    const markOperation = (operationId: string): void => {
      mark("execution", `${operationId}.principal.json`); mark("rollback", `${operationId}.snapshot.json`); mark("operations", this.mutationArtifactId(operationId));
      markPrefix("provider-checkpoints", `${operationId}.`); markPrefix("assets", `${operationId}.`);
    };
    for (const stack of Object.values(this.state.stacks)) {
      if (stack.templateArtifactId) markTemplate(stack.templateArtifactId);
      const operation = this.recoverableStackOperation(stack);
      if (!operation) continue;
      if (operation.desiredTemplateArtifactId) markTemplate(operation.desiredTemplateArtifactId);
      if (operation.previousTemplateArtifactId) markTemplate(operation.previousTemplateArtifactId);
      markOperation(operation.operationId);
      if (operation.rollbackSourceOperationId) markOperation(operation.rollbackSourceOperationId);
    }
    for (const value of Object.values(this.state.changeSets)) {
      if (!value.templateArtifactId) continue;
      markTemplate(value.templateArtifactId);
      for (const suffix of ["planning", "changes", "input"]) mark("change-sets", `${value.templateArtifactId}.${suffix}.json`);
    }

    for (const collection of ["templates", "parameters", "execution", "plans", "rollback", "operations", "provider-checkpoints", "assets", "change-sets"]) {
      const exact = reachable.get(collection) ?? new Set<string>();
      const prefixes = prefixReachable.get(collection) ?? new Set<string>();
      const obsolete = (await this.journal.listArtifacts(collection)).filter(name => !exact.has(name) && ![...prefixes].some(prefix => name.startsWith(prefix)));
      if (obsolete.length) await this.journal.deleteArtifacts(collection, obsolete);
    }
    await this.customResourceCallbacks?.sweep(this.region, { cutoff, preserveOperationIds: [...protectedOperationIds] });
    await this.journal.compactTerminalOperations({
      retainTerminalOperations: this.retentionPolicy.maxTerminalJournalOperations,
      preserveOperationIds: [...protectedOperationIds],
    });
  }

  private isProtectedChangeSet(value: CloudFormationChangeSetState): boolean {
    // Non-deleted change sets remain addressable (including FAILED, OBSOLETE,
    // and executed sets). Admission quota, rather than silent expiry, bounds
    // those user-visible rows. Only DeleteChangeSet creates a reclaimable row.
    return value.status !== "DELETE_COMPLETE";
  }

  private recoverableStackOperation(stack: CloudFormationStackState): CloudFormationStackState["activeOperation"] | undefined {
    const operation = stack.activeOperation;
    if (!operation) return undefined;
    if (operation.status === "PENDING" || operation.status === "RUNNING") return operation;
    return new Set<CloudFormationStackStatus>(["CREATE_FAILED", "ROLLBACK_FAILED", "UPDATE_FAILED", "UPDATE_ROLLBACK_FAILED", "DELETE_FAILED"]).has(stack.stackStatus) ? operation : undefined;
  }

  private compactStackEvents(stack: CloudFormationStackState, cutoff: number): void {
    if (stack.events.length <= this.retentionPolicy.maxStackEvents) return;
    const operation = stack.activeOperation;
    const protectCurrentOperation = operation !== undefined && (
      operation.status === "PENDING"
      || operation.status === "RUNNING"
      || this.recoverableStackOperation(stack) !== undefined
      || (operation.completedAt ?? operation.acceptedAt) >= cutoff
    );
    const protectedEvents = protectCurrentOperation ? stack.events.filter(event => event.operationId === operation!.operationId) : [];
    const protectedIds = new Set(protectedEvents.map(event => event.eventId));
    const available = Math.max(0, this.retentionPolicy.maxStackEvents - protectedEvents.length);
    const ordinary = stack.events.filter(event => !protectedIds.has(event.eventId));
    const retainedOrdinary = available === 0 ? [] : ordinary.slice(-available);
    const retainedIds = new Set([...protectedEvents, ...retainedOrdinary].map(event => event.eventId));
    stack.events = stack.events.filter(event => retainedIds.has(event.eventId));
  }

  start(): Promise<void> {
    return this.started ??= (async () => {
      this.stopping = false;
      await this.journal.start();
      let migrated = false;
      for (const stack of Object.values(this.state.stacks)) {
        const hasLegacyTemplate = stack.templateBody !== undefined || stack.processedTemplateBody !== undefined;
        const mayOwnStackTemplate = stack.stackStatus !== "REVIEW_IN_PROGRESS" || hasLegacyTemplate;
        const artifactId = stack.templateArtifactId ?? this.artifactId(stack.stackId);
        if (!stack.templateArtifactId && mayOwnStackTemplate) { stack.templateArtifactId = artifactId; migrated = true; }
        if (stack.templateBody !== undefined && await this.journal.readTemplate(artifactId, "original") === undefined) await this.journal.replaceTemplate(artifactId, stack.templateBody, "original");
        if (stack.processedTemplateBody !== undefined && await this.journal.readTemplate(artifactId, "processed") === undefined) await this.journal.replaceTemplate(artifactId, stack.processedTemplateBody, "processed");
        if (stack.templateBody !== undefined || stack.processedTemplateBody !== undefined) { delete stack.templateBody; delete stack.processedTemplateBody; migrated = true; }
      }
      if (migrated) await this.store.save();
      for (const changeSet of Object.values(this.state.changeSets)) {
        if (changeSet.status === "CREATE_IN_PROGRESS") await this.resumeChangeSetPlanning(changeSet);
        await this.syncChangeSetExecution(changeSet);
      }
      await this.maintainPersistenceRetention();
      await this.reclaimUnreferencedBootstrapAssets();
      this.armAssetReclaimer();
      for (const stack of Object.values(this.state.stacks)) if (stack.activeOperation?.status === "RUNNING" || stack.activeOperation?.status === "PENDING") this.schedule(stack.stackId);
      void this.drainNotificationOutbox();
    })();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.notificationTimer) this.clock.clearTimeout(this.notificationTimer);
    this.notificationTimer = undefined;
    await this.notificationDrain?.catch(() => undefined);
    if (this.assetReclaimTimer) this.clock.clearTimeout(this.assetReclaimTimer);
    this.assetReclaimTimer = undefined;
    for (const handle of this.resumeTimers.values()) this.clock.clearTimeout(handle);
    this.resumeTimers.clear();
    await Promise.allSettled([...this.running.values()]);
    let releasedLease = false;
    for (const stack of Object.values(this.state.stacks)) {
      const operation = stack.activeOperation;
      if (operation?.leaseOwner !== this.executorId) continue;
      delete operation.leaseOwner; delete operation.leaseExpiresAt; releasedLease = true;
    }
    if (releasedLease) await this.store.save();
    await this.retentionRun?.catch(() => undefined);
    await this.journal.flush();
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string, principal: PrincipalContext): Promise<void> {
    try {
      await this.start();
      const input = parseAwsQuery(req.method === "GET" ? url.searchParams : (await readBody(req)).toString("utf8"), { coerceTimestamps: false }) as any;
      const action = String(input.Action ?? "");
      if (!SUPPORTED_ACTIONS.has(action) || typeof (this as any)[action] !== "function") throw new AwsError("InvalidAction", `Action ${action || "(missing)"} is not valid for this web service`, 400);
      if (input.Version !== undefined && input.Version !== "2010-05-15") throw new AwsError("InvalidAction", `Unsupported CloudFormation API version ${input.Version}`, 400);
      delete input.Action; delete input.Version;
      const admitsAssets = action === "CreateStack" || action === "UpdateStack" || action === "CreateChangeSet";
      while (this.retentionRun) await this.retentionRun;
      this.catalogAdmissions += 1;
      if (admitsAssets) this.assetAdmissions += 1;
      let result;
      try { result = await (this as any)[action](input, principal); }
      finally {
        if (admitsAssets) this.assetAdmissions -= 1;
        this.catalogAdmissions -= 1;
        if (MUTATING_ACTIONS.has(action)) this.retentionRequested = true;
        if (this.catalogAdmissions === 0 && this.assetAdmissions === 0 && this.retentionRequested) void this.maintainPersistenceRetention().catch(() => undefined);
      }
      sendAwsQueryXml(res, `${action}Response`, { [`${action}Result`]: result, ResponseMetadata: { RequestId: requestId } }, NAMESPACE);
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code, aws.message, requestId));
    }
  }

  async ValidateTemplate(input: any, principal: PrincipalContext): Promise<any> {
    const parsed = await this.template(input, principal);
    const declared = parsed.value.Parameters && typeof parsed.value.Parameters === "object" ? Object.entries(parsed.value.Parameters).map(([ParameterKey, definition]: [string, any]) => ({ ParameterKey, DefaultValue: definition?.Default !== undefined ? String(definition.Default) : undefined, NoEcho: Boolean(definition?.NoEcho), Description: definition?.Description })) : [];
    const capabilities = this.requiredCapabilities(parsed.value);
    return { Parameters: declared, Description: parsed.value.Description, Capabilities: capabilities, CapabilitiesReason: capabilities.length ? "The template contains IAM resources" : undefined, DeclaredTransforms: [] };
  }

  async GetTemplateSummary(input: any, principal: PrincipalContext): Promise<any> {
    let parsed: ParsedTemplate;
    if (input.StackName !== undefined) {
      if (input.TemplateBody !== undefined || input.TemplateURL !== undefined) throw new AwsError("ValidationError", "StackName cannot be combined with TemplateBody or TemplateURL", 400);
      parsed = await this.templateFromBody(await this.localTemplate(String(input.StackName)));
    } else parsed = await this.template(input, principal);
    const capabilities = this.requiredCapabilities(parsed.value);
    return {
      Parameters: Object.entries(parsed.value.Parameters ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([ParameterKey, definition]) => ({ ParameterKey, DefaultValue: definition.Default === undefined ? undefined : String(definition.Default), ParameterType: definition.Type, NoEcho: Boolean(definition.NoEcho), Description: definition.Description, ParameterConstraints: definition.AllowedValues ? { AllowedValues: definition.AllowedValues.map(String) } : undefined })),
      Description: parsed.value.Description,
      Capabilities: capabilities,
      CapabilitiesReason: capabilities.length ? "The template contains IAM resources" : undefined,
      ResourceTypes: [...new Set(Object.values(parsed.value.Resources).map(resource => resource.Type))].sort(),
      Version: parsed.value.AWSTemplateFormatVersion,
      Metadata: JSON.stringify(parsed.value.Metadata ?? {}),
      DeclaredTransforms: [],
      ResourceIdentifierSummaries: [],
    };
  }

  async CreateStack(input: any, principal: PrincipalContext, reviewStack?: CloudFormationStackState, prepared?: PreparedTemplateArtifact, hierarchy?: NestedStackHierarchyInput): Promise<any> {
    const stackName = String(input.StackName ?? "");
    if (!STACK_NAME.test(stackName)) throw new AwsError("ValidationError", "StackName must start with a letter and contain only letters, numbers, and hyphens", 400);
    const operationId = randomUUID();
    const executionPrincipal = await this.operationPrincipal(input.RoleARN, operationId, principal);
    const parsed = await this.template(input, executionPrincipal, prepared?.templateBodyMaximumBytes);
    if (prepared?.templateSource) await this.validatePinnedTemplateSource(prepared.templateSource, prepared.originalBody);
    const clientRequestToken = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken);
    if (clientRequestToken && (clientRequestToken.length < 1 || clientRequestToken.length > 128)) throw new AwsError("ValidationError", "ClientRequestToken must contain 1-128 characters", 400);
    const onFailure = input.OnFailure === undefined ? undefined : String(input.OnFailure);
    if (onFailure && !new Set(["DELETE", "DO_NOTHING", "ROLLBACK"]).has(onFailure)) throw new AwsError("ValidationError", `OnFailure ${onFailure} is invalid`, 400);
    if (onFailure && input.DisableRollback !== undefined) throw new AwsError("ValidationError", "DisableRollback and OnFailure cannot both be specified", 400);
    const disableRollback = onFailure === "DO_NOTHING" || (onFailure === undefined && input.DisableRollback === true);
    const retainExceptOnCreate = input.RetainExceptOnCreate === true;
    const rollbackConfiguration = this.normalizedRollbackConfiguration(input.RollbackConfiguration);
    const requestTemplateDigest = prepared?.originalDigest ?? parsed.digest;
    const inputDigest = createHash("sha256").update(canonical({ action: "CreateStack", stackName, template: requestTemplateDigest, parameters: input.Parameters, tags: input.Tags, capabilities: input.Capabilities, roleArn: input.RoleARN, notificationArns: input.NotificationARNs, onFailure, disableRollback, retainExceptOnCreate, rollbackConfiguration })).digest("hex");
    if (clientRequestToken) {
      const prior = this.state.clientTokens[clientRequestToken];
      if (prior) {
        if (prior.operation !== "CreateStack" || prior.inputDigest !== inputDigest) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${clientRequestToken}`, 400);
        if (prior.stackId) return { StackId: prior.stackId, OperationId: prior.operationId };
      }
    }
    const existingId = this.state.stackNames[stackName];
    if (existingId && this.state.stacks[existingId]?.stackStatus !== "DELETE_COMPLETE" && (!reviewStack || reviewStack.stackId !== existingId || reviewStack.stackStatus !== "REVIEW_IN_PROGRESS")) throw new AwsError("AlreadyExistsException", `Stack [${stackName}] already exists`, 400);
    const now = this.clock.now(); const stackId = reviewStack?.stackId ?? hierarchy?.stackId ?? `arn:aws:cloudformation:${this.region}:${this.store.accountId}:stack/${stackName}/${randomUUID()}`; const templateArtifactId = this.artifactId(stackId);
    const notificationArns = this.normalizedNotificationArns(input.NotificationARNs);
    const suppliedCapabilities = list<string>(input.Capabilities).map(String);
    const desiredTags = tags(input.Tags);
    let resolvedParameters: ResolvedParameters; let conditions: Record<string, boolean>; let processed: CloudFormationTemplate; let graph: ReturnType<typeof buildResourceDependencyGraph>; let importNames: string[];
    try {
      const suppliedParameters = parameters(input.Parameters);
      await this.authorizeTypedSsmParameters(parsed.value, suppliedParameters, executionPrincipal);
      resolvedParameters = resolveTemplateParameters(parsed.value.Parameters, suppliedParameters, { resolveSsmParameter: (name, type) => this.resolveBootstrapSsmParameter(name, type) });
      const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, stackId, stackName), "AWS::NotificationARNs": notificationArns };
      const availableExports = this.exportValues(); conditions = evaluateTemplateConditions(parsed.value, resolvedParameters.values, pseudos, availableExports); validateTemplateRules(parsed.value, resolvedParameters.values, pseudos, conditions, availableExports); processed = conditionallyProcessedTemplate(parsed.value, conditions); const openingEvaluation = { parameters: resolvedParameters.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, resourceRefs: {}, resourceAttributes: {}, imports: availableExports }; processed = await this.pinStaticFileAssets(processed, openingEvaluation, templateArtifactId, executionPrincipal, false, {}, prepared?.assetManifest); await this.pinNestedTemplateAssets(processed, openingEvaluation, templateArtifactId, executionPrincipal, prepared?.nestedTemplateManifest, { stackId, stackName, capabilities: suppliedCapabilities, tags: desiredTags }); this.assertCapabilities(processed, suppliedCapabilities); importNames = this.plannedImportNames(processed, resolvedParameters.values, pseudos, conditions, stackId); graph = buildResourceDependencyGraph(processed); this.validateOpeningResources(processed, stackId, operationId, executionPrincipal); this.validateProviderReferences(processed); this.preflightProviderModels(processed, { parameters: resolvedParameters.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, imports: availableExports }, stackId, operationId, executionPrincipal, desiredTags);
    } catch (error) { throw this.validationError(error); }
    const processedBody = JSON.stringify(processed); const processedDigest = createHash("sha256").update(processedBody).digest("hex");
    const stack: CloudFormationStackState = {
      stackId, stackName, description: parsed.value.Description, stackStatus: "CREATE_IN_PROGRESS", creationTime: reviewStack?.creationTime ?? now,
      enableTerminationProtection: Boolean(input.EnableTerminationProtection), disableRollback, roleArn: input.RoleARN,
      notificationArns, rollbackConfiguration, capabilities: suppliedCapabilities, tags: desiredTags, parameters: resolvedParameters.entries.map(entry => ({ parameterKey: entry.parameterKey, parameterValue: entry.parameterValue, resolvedValue: entry.resolvedValue, noEcho: entry.noEcho })), outputs: [],
      templateArtifactId, templateDigest: requestTemplateDigest, processedTemplateDigest: processedDigest, resources: {}, events: reviewStack ? structuredClone(reviewStack.events) : [], lastClientRequestToken: clientRequestToken,
      ...(hierarchy ? { parentId: hierarchy.parentId, rootId: hierarchy.rootId, parentLogicalId: hierarchy.parentLogicalId, nestedStackSource: structuredClone(hierarchy.source) as unknown as Record<string, unknown> } : {}),
      activeOperation: { operationId, kind: "CREATE", status: "PENDING", acceptedAt: now, clientRequestToken, orderedLogicalIds: graph.order, completedLogicalIds: [], rollbackLogicalIds: [], disableRollback, retainExceptOnCreate, onFailure: (onFailure ?? "ROLLBACK") as "DELETE" | "DO_NOTHING" | "ROLLBACK", ...(hierarchy ? { owningParentOperationId: hierarchy.parentOperationId } : {}) },
    };
    this.state.stacks[stackId] = stack; this.state.stackNames[stackName] = stackId;
    if (clientRequestToken) this.state.clientTokens[clientRequestToken] = { operation: "CreateStack", stackId, operationId, inputDigest, createdAt: now };
    this.event(stack, stackName, "AWS::CloudFormation::Stack", "CREATE_IN_PROGRESS", undefined, stackId, clientRequestToken);
    await this.journal.replaceTemplate(templateArtifactId, prepared?.originalBody ?? parsed.body, "original");
    await this.journal.replaceTemplate(templateArtifactId, processedBody, "processed");
    await this.journal.replaceJsonArtifact("parameters", `${templateArtifactId}.private.json`, { values: resolvedParameters.values, entries: resolvedParameters.entries });
    await this.journal.replaceJsonArtifact("execution", `${templateArtifactId}.principal.json`, executionPrincipal);
    await this.journal.replaceJsonArtifact("plans", `${templateArtifactId}.conditions.json`, conditions);
    await this.journal.replaceJsonArtifact("plans", `${templateArtifactId}.graph.json`, graph);
    await this.journal.replaceJsonArtifact("plans", `${templateArtifactId}.imports.json`, importNames);
    if (prepared?.templateSource ?? parsed.source) await this.journal.replaceJsonArtifact("plans", `${templateArtifactId}.template-source.json`, prepared?.templateSource ?? parsed.source);
    await this.checkpoint(stack, "accepted");
    await this.store.save();
    this.schedule(stackId);
    return { StackId: stackId, OperationId: operationId };
  }

  async UpdateStack(input: any, principal: PrincipalContext, prepared?: PreparedTemplateArtifact, nestedSource?: NestedStackModel, owningParentOperationId?: string): Promise<any> {
    const stack = this.stack(String(input.StackName ?? "")); if (!owningParentOperationId) this.assertNoActiveAncestor(stack); if (!new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]).has(stack.stackStatus)) throw new AwsError("ValidationError", `Stack ${stack.stackName} is in ${stack.stackStatus} and cannot be updated`, 400); if (stack.activeOperation?.status === "PENDING" || stack.activeOperation?.status === "RUNNING") throw new AwsError("ValidationError", `Stack ${stack.stackName} is currently being modified`, 400);
    if (input.UsePreviousTemplate === true && (input.TemplateBody !== undefined || input.TemplateURL !== undefined)) throw new AwsError("ValidationError", "UsePreviousTemplate cannot be combined with TemplateBody or TemplateURL", 400);
    const operationId = randomUUID();
    const desiredRoleArn = input.RoleARN ?? stack.roleArn; const executionPrincipal = await this.operationPrincipal(desiredRoleArn, operationId, principal);
    const parsed = input.UsePreviousTemplate === true ? await this.templateFromBody(await this.localTemplate(stack.stackId)) : await this.template(input, executionPrincipal, prepared?.templateBodyMaximumBytes);
    if (prepared?.templateSource) await this.validatePinnedTemplateSource(prepared.templateSource, prepared.originalBody);
    const clientRequestToken = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken); if (clientRequestToken && (clientRequestToken.length < 1 || clientRequestToken.length > 128)) throw new AwsError("ValidationError", "ClientRequestToken must contain 1-128 characters", 400);
    const disableRollback = input.DisableRollback === true;
    const retainExceptOnCreate = input.RetainExceptOnCreate === true;
    const rollbackConfiguration = this.normalizedRollbackConfiguration(input.RollbackConfiguration, stack.rollbackConfiguration);
    const requestTemplateDigest = prepared?.originalDigest ?? parsed.digest;
    const inputDigest = createHash("sha256").update(canonical({ action: "UpdateStack", stackId: stack.stackId, template: requestTemplateDigest, parameters: input.Parameters, tags: input.Tags, capabilities: input.Capabilities, roleArn: input.RoleARN, notificationArns: input.NotificationARNs, disableRollback, retainExceptOnCreate, rollbackConfiguration })).digest("hex"); if (clientRequestToken) { const prior = this.state.clientTokens[clientRequestToken]; if (prior) { if (prior.operation !== "UpdateStack" || prior.inputDigest !== inputDigest) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${clientRequestToken}`, 400); return { StackId: stack.stackId, OperationId: prior.operationId }; } }
    const desiredTemplateArtifactId = `${this.artifactId(stack.stackId)}-${operationId}`; const previousValues = Object.fromEntries(stack.parameters.filter(parameter => parameter.parameterValue !== undefined).map(parameter => [parameter.parameterKey, parameter.parameterValue!])); const suppliedParameterInputs = parameters(input.Parameters); const suppliedNames = new Set(suppliedParameterInputs.map(parameter => parameter.parameterKey)); for (const name of Object.keys(parsed.value.Parameters ?? {})) if (!suppliedNames.has(name) && previousValues[name] !== undefined) suppliedParameterInputs.push({ parameterKey: name, usePreviousValue: true });
    const notificationArns = input.NotificationARNs === undefined ? [...stack.notificationArns] : this.normalizedNotificationArns(input.NotificationARNs); const suppliedCapabilities = input.Capabilities === undefined ? [...stack.capabilities] : list<string>(input.Capabilities).map(String); const desiredTags = input.Tags === undefined ? structuredClone(stack.tags) : tags(input.Tags);
    let resolvedParameters: ResolvedParameters; let conditions: Record<string, boolean>; let processed: CloudFormationTemplate; let graph: ReturnType<typeof buildResourceDependencyGraph>; let importNames: string[];
    try { await this.authorizeTypedSsmParameters(parsed.value, suppliedParameterInputs, executionPrincipal, previousValues); resolvedParameters = resolveTemplateParameters(parsed.value.Parameters, suppliedParameterInputs, { previous: previousValues, resolveSsmParameter: (name, type) => this.resolveBootstrapSsmParameter(name, type) }); const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, stack.stackId, stack.stackName), "AWS::NotificationARNs": notificationArns }; const availableExports = this.exportValues(); conditions = evaluateTemplateConditions(parsed.value, resolvedParameters.values, pseudos, availableExports); validateTemplateRules(parsed.value, resolvedParameters.values, pseudos, conditions, availableExports); processed = conditionallyProcessedTemplate(parsed.value, conditions); const openingEvaluation = { parameters: resolvedParameters.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, resourceRefs: {}, resourceAttributes: {}, imports: availableExports }; processed = await this.pinStaticFileAssets(processed, openingEvaluation, desiredTemplateArtifactId, executionPrincipal, false, stack.resources, prepared?.assetManifest); await this.pinNestedTemplateAssets(processed, openingEvaluation, desiredTemplateArtifactId, executionPrincipal, prepared?.nestedTemplateManifest, { stackId: stack.stackId, stackName: stack.stackName, logicalPath: stack.parentLogicalId, capabilities: suppliedCapabilities, tags: desiredTags, previousResources: stack.resources }); this.assertCapabilities(processed, suppliedCapabilities); importNames = this.plannedImportNames(processed, resolvedParameters.values, pseudos, conditions, stack.stackId); graph = buildResourceDependencyGraph(processed); this.validateOpeningResources(processed, stack.stackId, operationId, executionPrincipal); this.validateProviderReferences(processed); this.preflightProviderModels(processed, { parameters: resolvedParameters.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, imports: availableExports }, stack.stackId, operationId, executionPrincipal, desiredTags, stack.resources); } catch (error) { throw this.validationError(error); }
    const processedBody = JSON.stringify(processed); const processedDigest = createHash("sha256").update(processedBody).digest("hex"); const sameParameters = canonical(resolvedParameters.entries.map(entry => [entry.parameterKey, entry.parameterValue, entry.resolvedValue])) === canonical(stack.parameters.map(entry => [entry.parameterKey, entry.parameterValue, entry.resolvedValue])); if (processedDigest === stack.processedTemplateDigest && sameParameters && canonical(desiredTags) === canonical(stack.tags) && canonical(suppliedCapabilities) === canonical(stack.capabilities) && canonical(notificationArns) === canonical(stack.notificationArns) && canonical(rollbackConfiguration) === canonical(stack.rollbackConfiguration ?? { rollbackTriggers: [] }) && (input.RoleARN ?? stack.roleArn) === stack.roleArn) throw new AwsError("ValidationError", "No updates are to be performed.", 400);
    const snapshot = { resources: stack.resources, outputs: stack.outputs, parameters: stack.parameters, tags: stack.tags, capabilities: stack.capabilities, notificationArns: stack.notificationArns, rollbackConfiguration: stack.rollbackConfiguration, roleArn: stack.roleArn, description: stack.description, nestedStackSource: stack.nestedStackSource, templateArtifactId: stack.templateArtifactId, templateDigest: stack.templateDigest, processedTemplateDigest: stack.processedTemplateDigest };
    await this.journal.replaceTemplate(desiredTemplateArtifactId, prepared?.originalBody ?? parsed.body, "original"); await this.journal.replaceTemplate(desiredTemplateArtifactId, processedBody, "processed"); await this.journal.replaceJsonArtifact("parameters", `${desiredTemplateArtifactId}.private.json`, { values: resolvedParameters.values, entries: resolvedParameters.entries }); await this.journal.replaceJsonArtifact("execution", `${desiredTemplateArtifactId}.principal.json`, executionPrincipal); await this.journal.replaceJsonArtifact("plans", `${desiredTemplateArtifactId}.conditions.json`, conditions); await this.journal.replaceJsonArtifact("plans", `${desiredTemplateArtifactId}.graph.json`, graph); await this.journal.replaceJsonArtifact("plans", `${desiredTemplateArtifactId}.imports.json`, importNames); if (prepared?.templateSource ?? parsed.source) await this.journal.replaceJsonArtifact("plans", `${desiredTemplateArtifactId}.template-source.json`, prepared?.templateSource ?? parsed.source); await this.journal.replaceJsonArtifact("rollback", `${operationId}.snapshot.json`, snapshot); await this.journal.replaceJsonArtifact("plans", `${desiredTemplateArtifactId}.stack.json`, { parameters: resolvedParameters.entries, tags: desiredTags, capabilities: suppliedCapabilities, notificationArns, rollbackConfiguration, roleArn: desiredRoleArn, description: processed.Description, templateDigest: requestTemplateDigest, processedTemplateDigest: processedDigest });
    const removed = Object.keys(stack.resources).filter(logicalId => !processed.Resources[logicalId]).reverse(); const acceptedAt = this.clock.now(); stack.stackStatus = "UPDATE_IN_PROGRESS"; stack.stackStatusReason = undefined; stack.lastClientRequestToken = clientRequestToken; if (nestedSource) stack.nestedStackSource = structuredClone(nestedSource) as unknown as Record<string, unknown>; stack.activeOperation = { operationId, kind: "UPDATE", status: "PENDING", acceptedAt, clientRequestToken, orderedLogicalIds: [...graph.order, ...removed], completedLogicalIds: [], rollbackLogicalIds: [], desiredTemplateArtifactId, previousTemplateArtifactId: stack.templateArtifactId, desiredTemplateDigest: requestTemplateDigest, desiredProcessedTemplateDigest: processedDigest, disableRollback, retainExceptOnCreate, ...(owningParentOperationId ? { owningParentOperationId } : {}) }; if (clientRequestToken) this.state.clientTokens[clientRequestToken] = { operation: "UpdateStack", stackId: stack.stackId, operationId, inputDigest, createdAt: acceptedAt }; this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_IN_PROGRESS", undefined, stack.stackId, clientRequestToken); await this.checkpoint(stack, "accepted"); await this.store.save(); this.schedule(stack.stackId); return { StackId: stack.stackId, OperationId: operationId };
  }

  async CancelUpdateStack(input: any): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""));
    this.assertNoActiveAncestor(stack);
    const token = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken); this.validateClientRequestToken(token);
    const inputDigest = createHash("sha256").update(canonical({ action: "CancelUpdateStack", stackId: stack.stackId })).digest("hex");
    if (token) {
      const prior = this.state.clientTokens[token];
      if (prior) {
        if (prior.operation !== "CancelUpdateStack" || prior.inputDigest !== inputDigest || prior.stackId !== stack.stackId) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${token}`, 400);
        return {};
      }
    }
    if (stack.stackStatus !== "UPDATE_IN_PROGRESS" || stack.activeOperation?.kind !== "UPDATE" || !new Set(["PENDING", "RUNNING"]).has(stack.activeOperation.status)) throw new AwsError("ValidationError", `Stack ${stack.stackName} is not in UPDATE_IN_PROGRESS`, 400);
    stack.activeOperation.cancelRequestedAt ??= this.clock.now();
    if (token) this.state.clientTokens[token] = { operation: "CancelUpdateStack", stackId: stack.stackId, operationId: stack.activeOperation.operationId, inputDigest, createdAt: this.clock.now() };
    await this.checkpoint(stack, "cancel-requested"); await this.store.save(); return {};
  }

  async RollbackStack(input: any, principal?: PrincipalContext): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""));
    this.assertNoActiveAncestor(stack);
    if (stack.stackStatus !== "CREATE_FAILED" && stack.stackStatus !== "UPDATE_FAILED") throw new AwsError("ValidationError", `RollbackStack requires CREATE_FAILED or UPDATE_FAILED; stack ${stack.stackName} is ${stack.stackStatus}`, 400);
    const prior = stack.activeOperation;
    if (!prior || (stack.stackStatus === "CREATE_FAILED" ? prior.kind !== "CREATE" : prior.kind !== "UPDATE")) throw new AwsError("ValidationError", `Stack ${stack.stackName} does not retain a failed operation that can be rolled back`, 400);
    const token = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken);
    this.validateClientRequestToken(token);
    const retainExceptOnCreate = input.RetainExceptOnCreate === true;
    const inputDigest = createHash("sha256").update(canonical({ action: "RollbackStack", stackId: stack.stackId, roleArn: input.RoleARN, retainExceptOnCreate })).digest("hex");
    if (token) {
      const previous = this.state.clientTokens[token];
      if (previous) {
        if (previous.operation !== "RollbackStack" || previous.inputDigest !== inputDigest || previous.stackId !== stack.stackId) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${token}`, 400);
        return { StackId: stack.stackId, OperationId: previous.operationId };
      }
    }
    const operationId = randomUUID();
    const caller = principal ?? this.defaultExecutionPrincipal();
    const executionPrincipal = await this.operationPrincipal(input.RoleARN ?? stack.roleArn, operationId, caller);
    await this.journal.replaceJsonArtifact("execution", `${operationId}.principal.json`, executionPrincipal);
    const updateRollback = stack.stackStatus === "UPDATE_FAILED";
    stack.stackStatus = updateRollback ? "UPDATE_ROLLBACK_IN_PROGRESS" : "ROLLBACK_IN_PROGRESS";
    stack.stackStatusReason = "RollbackStack requested";
    stack.disableRollback = false;
    if (input.RoleARN !== undefined) stack.roleArn = String(input.RoleARN);
    stack.activeOperation = updateRollback
      ? { operationId, kind: "ROLLBACK_UPDATE", status: "PENDING", acceptedAt: this.clock.now(), clientRequestToken: token, orderedLogicalIds: [...prior.orderedLogicalIds], completedLogicalIds: [...prior.completedLogicalIds], rollbackLogicalIds: [...prior.rollbackLogicalIds], desiredTemplateArtifactId: prior.desiredTemplateArtifactId, previousTemplateArtifactId: prior.previousTemplateArtifactId, desiredTemplateDigest: prior.desiredTemplateDigest, desiredProcessedTemplateDigest: prior.desiredProcessedTemplateDigest, rollbackSourceOperationId: prior.operationId, retainExceptOnCreate }
      : { operationId, kind: "ROLLBACK", status: "PENDING", acceptedAt: this.clock.now(), clientRequestToken: token, orderedLogicalIds: [...prior.completedLogicalIds].reverse(), completedLogicalIds: [...prior.completedLogicalIds], rollbackLogicalIds: [], retainExceptOnCreate };
    if (token) this.state.clientTokens[token] = { operation: "RollbackStack", stackId: stack.stackId, operationId, inputDigest, createdAt: this.clock.now() };
    this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", stack.stackStatus, "RollbackStack requested", stack.stackId, token);
    await this.checkpoint(stack, "accepted"); await this.store.save(); this.schedule(stack.stackId);
    return { StackId: stack.stackId, OperationId: operationId };
  }

  async ContinueUpdateRollback(input: any, principal?: PrincipalContext): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""));
    if (stack.parentId) throw new AwsError("ValidationError", `ContinueUpdateRollback for nested stack ${stack.stackName} must target root stack ${this.hierarchyRoot(stack).stackName}`, 400);
    const token = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken); this.validateClientRequestToken(token);
    const resourcesToSkip = list<string>(input.ResourcesToSkip).map(String); if (new Set(resourcesToSkip).size !== resourcesToSkip.length) throw new AwsError("ValidationError", "ResourcesToSkip cannot contain duplicate logical IDs", 400);
    const inputDigest = createHash("sha256").update(canonical({ action: "ContinueUpdateRollback", stackId: stack.stackId, resourcesToSkip, roleArn: input.RoleARN })).digest("hex");
    if (token) {
      const prior = this.state.clientTokens[token];
      if (prior) {
        if (prior.operation !== "ContinueUpdateRollback" || prior.inputDigest !== inputDigest || prior.stackId !== stack.stackId) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${token}`, 400);
        return {};
      }
    }
    const operation = stack.activeOperation;
    if (stack.stackStatus !== "UPDATE_ROLLBACK_FAILED" || !operation || (operation.kind !== "UPDATE" && operation.kind !== "ROLLBACK_UPDATE")) throw new AwsError("ValidationError", `Stack ${stack.stackName} is not in UPDATE_ROLLBACK_FAILED`, 400);
    const sourceOperationId = operation.rollbackSourceOperationId ?? operation.operationId;
    const snapshot = await this.journal.readJsonArtifact<any>("rollback", `${sourceOperationId}.snapshot.json`); const known = new Set([...Object.keys(stack.resources), ...Object.keys(snapshot?.resources ?? {})]); for (const logicalId of resourcesToSkip) if (!known.has(logicalId)) throw new AwsError("ValidationError", `ResourcesToSkip contains unknown logical resource ${logicalId}`, 400);
    if (input.RoleARN !== undefined) {
      const caller = principal ?? this.defaultExecutionPrincipal();
      const executionPrincipal = await this.operationPrincipal(input.RoleARN, operation.operationId, caller);
      await this.journal.replaceJsonArtifact("execution", `${operation.operationId}.principal.json`, executionPrincipal);
      stack.roleArn = String(input.RoleARN);
    }
    operation.resourcesToSkip = resourcesToSkip; operation.status = "RUNNING"; operation.completedAt = undefined; operation.clientRequestToken = token ?? operation.clientRequestToken; stack.stackStatus = "UPDATE_ROLLBACK_IN_PROGRESS"; stack.stackStatusReason = "ContinueUpdateRollback requested";
    if (token) this.state.clientTokens[token] = { operation: "ContinueUpdateRollback", stackId: stack.stackId, operationId: operation.operationId, inputDigest, createdAt: this.clock.now() };
    this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_ROLLBACK_IN_PROGRESS", "ContinueUpdateRollback requested", stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "continue-rollback-accepted"); await this.store.save(); const priorRun = this.running.get(operation.operationId); if (priorRun) void priorRun.finally(() => this.schedule(stack.stackId)); else this.schedule(stack.stackId); return {};
  }

  async CreateChangeSet(input: any, principal: PrincipalContext): Promise<any> {
    const stackIdentifier = String(input.StackName ?? ""); const changeSetName = String(input.ChangeSetName ?? "");
    if (!stackIdentifier) throw new AwsError("ValidationError", "StackName is required", 400);
    if (!STACK_NAME.test(changeSetName)) throw new AwsError("ValidationError", "ChangeSetName must start with a letter and contain only letters, numbers, and hyphens", 400);
    const changeSetType = String(input.ChangeSetType ?? "UPDATE"); if (changeSetType !== "CREATE" && changeSetType !== "UPDATE") throw new AwsError("ValidationError", `ChangeSetType ${changeSetType} is outside the supported CREATE/UPDATE subset`, 400);
    if (input.ResourcesToImport !== undefined || input.ImportExistingResources === true) throw new AwsError("ValidationError", "Resource import change sets are not implemented", 400);
    if (input.ResourceTypes !== undefined) throw new AwsError("ValidationError", "ResourceTypes-scoped change sets are not implemented", 400);
    // Current CDK explicitly sends the ordinary STANDARD deployment config.
    // It has no behavior beyond the normal executor; drift-reverting modes do.
    const deploymentConfig = input.DeploymentConfig;
    const standardDeployment = deploymentConfig === undefined || deploymentConfig === "" || (deploymentConfig && typeof deploymentConfig === "object" && deploymentConfig.Mode === "STANDARD");
    if ((input.DeploymentMode !== undefined && input.DeploymentMode !== "") || !standardDeployment) throw new AwsError("ValidationError", "Drift-aware deployment modes are not implemented", 400);
    const onStackFailure = input.OnStackFailure === undefined ? undefined : String(input.OnStackFailure); if (onStackFailure && !new Set(["DELETE", "DO_NOTHING", "ROLLBACK"]).has(onStackFailure)) throw new AwsError("ValidationError", `OnStackFailure ${onStackFailure} is invalid`, 400); if (onStackFailure && changeSetType !== "CREATE") throw new AwsError("ValidationError", "OnStackFailure is valid only for CREATE change sets", 400);
    const clientToken = input.ClientToken === undefined ? undefined : String(input.ClientToken); if (clientToken && (clientToken.length < 1 || clientToken.length > 128)) throw new AwsError("ValidationError", "ClientToken must contain 1-128 characters", 400);
    const inputDigest = createHash("sha256").update(canonical({ action: "CreateChangeSet", input })).digest("hex");
    if (clientToken) { const prior = this.state.clientTokens[clientToken]; if (prior) { if (prior.operation !== "CreateChangeSet" || prior.inputDigest !== inputDigest) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${clientToken}`, 400); const existing = prior.changeSetId && this.state.changeSets[prior.changeSetId]; if (existing) return { Id: existing.changeSetId, StackId: existing.stackId }; } }

    let stack: CloudFormationStackState | undefined; const existingId = this.state.stackNames[stackIdentifier];
    if (changeSetType === "CREATE") {
      if (!STACK_NAME.test(stackIdentifier)) throw new AwsError("ValidationError", "StackName must start with a letter and contain only letters, numbers, and hyphens", 400);
      if (existingId) { stack = this.state.stacks[existingId]; if (!stack || stack.stackStatus !== "REVIEW_IN_PROGRESS") throw new AwsError("AlreadyExistsException", `Stack [${stackIdentifier}] already exists`, 400); }
      else { const now = this.clock.now(); const stackId = `arn:aws:cloudformation:${this.region}:${this.store.accountId}:stack/${stackIdentifier}/${randomUUID()}`; stack = { stackId, stackName: stackIdentifier, stackStatus: "REVIEW_IN_PROGRESS", creationTime: now, enableTerminationProtection: false, disableRollback: false, notificationArns: [], capabilities: [], tags: {}, parameters: [], outputs: [], templateDigest: "", resources: {}, events: [] }; this.state.stacks[stackId] = stack; this.state.stackNames[stackIdentifier] = stackId; this.event(stack, stackIdentifier, "AWS::CloudFormation::Stack", "REVIEW_IN_PROGRESS", "Change set creation initiated", stackId, clientToken); }
    } else {
      stack = this.stack(stackIdentifier); if (stack.stackStatus === "REVIEW_IN_PROGRESS") throw new AwsError("ValidationError", `Stack ${stack.stackName} is in REVIEW_IN_PROGRESS; use a CREATE change set`, 400); if (!new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]).has(stack.stackStatus)) throw new AwsError("ValidationError", `Stack ${stack.stackName} is in ${stack.stackStatus} and cannot accept an UPDATE change set`, 400);
    }
    if (stack.parentId) this.assertNoActiveAncestor(stack);
    const stackName = stack.stackName;
    const key = this.changeSetKey(stack.stackId, changeSetName); const priorId = this.state.changeSetNames[key]; if (priorId && this.state.changeSets[priorId]?.status !== "DELETE_COMPLETE") throw new AwsError("AlreadyExistsException", `ChangeSet ${changeSetName} already exists for stack ${stackName}`, 400);
    const activeChangeSetCount = Object.values(this.state.changeSets).filter(candidate => candidate.stackId === stack.stackId && candidate.status !== "DELETE_COMPLETE").length;
    if (activeChangeSetCount >= this.retentionPolicy.maxActiveChangeSetsPerStack) throw new AwsError("LimitExceededException", `Stack ${stackName} already has the local limit of ${this.retentionPolicy.maxActiveChangeSetsPerStack} active change sets`, 400);
    const now = this.clock.now(); const changeSetId = `arn:aws:cloudformation:${this.region}:${this.store.accountId}:changeSet/${changeSetName}/${randomUUID()}`; const artifactId = createHash("sha256").update(changeSetId).digest("hex");
    const value: CloudFormationChangeSetState = { changeSetId, changeSetName, stackId: stack.stackId, stackName, changeSetType, status: "CREATE_IN_PROGRESS", executionStatus: "UNAVAILABLE", creationTime: now, lastUpdatedTime: now, clientToken, inputDigest, description: input.Description === undefined ? undefined : String(input.Description), templateArtifactId: artifactId, templateDigest: createHash("sha256").update(canonical({ TemplateBody: input.TemplateBody, TemplateURL: input.TemplateURL, UsePreviousTemplate: input.UsePreviousTemplate })).digest("hex"), parameters: [], capabilities: [], roleArn: input.RoleARN === undefined ? undefined : String(input.RoleARN), tags: {}, changes: [], notificationArns: [], includeNestedStacks: Boolean(input.IncludeNestedStacks), onStackFailure: onStackFailure as any };
    const planning: ChangeSetPlanningArtifact = {
      schemaVersion: 1,
      input: structuredClone(input),
      principal: structuredClone(principal),
      planningOperationId: randomUUID(),
      baselineDigest: this.changeSetBaselineDigest(stack),
      availableExports: this.exportValues(),
    };
    // The immutable planning request must reach durable storage before the
    // CREATE_IN_PROGRESS catalog entry can become visible. A crash after the
    // following state save can therefore be replayed during start().
    await this.journal.replaceJsonArtifact("change-sets", `${artifactId}.planning.json`, planning);
    this.state.changeSets[changeSetId] = value; this.state.changeSetNames[key] = changeSetId; if (clientToken) this.state.clientTokens[clientToken] = { operation: "CreateChangeSet", stackId: stack.stackId, changeSetId, inputDigest, createdAt: now }; await this.store.save();
    await this.resumeChangeSetPlanning(value);
    return { Id: changeSetId, StackId: stack.stackId };
  }

  async DescribeChangeSet(input: any): Promise<any> {
    const value = this.changeSet(String(input.ChangeSetName ?? ""), input.StackName === undefined ? undefined : String(input.StackName)); await this.syncChangeSetExecution(value); const changes = await this.journal.readJsonArtifact<Array<Record<string, unknown>>>("change-sets", `${value.templateArtifactId}.changes.json`) ?? value.changes; const page = this.page(`DescribeChangeSet:${value.changeSetId}`, input.NextToken, this.changeSetChangesView(changes, input.IncludePropertyValues === true), 100);
    return { ChangeSetName: value.changeSetName, ChangeSetId: value.changeSetId, StackId: value.stackId, StackName: value.stackName, Description: value.description, Parameters: value.parameters.map(parameterView), CreationTime: new Date(value.creationTime), ExecutionStatus: value.executionStatus, Status: value.status, StatusReason: value.statusReason, NotificationARNs: value.notificationArns ?? [], RollbackConfiguration: this.rollbackConfigurationView(value.rollbackConfiguration), Capabilities: value.capabilities, Tags: Object.entries(value.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })), Changes: page.values, NextToken: page.nextToken, IncludeNestedStacks: value.includeNestedStacks ?? false, ParentChangeSetId: value.parentChangeSetId, RootChangeSetId: value.rootChangeSetId, OnStackFailure: value.onStackFailure, ChangeSetType: value.changeSetType };
  }

  async ListChangeSets(input: any): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""), true); const values = Object.values(this.state.changeSets).filter(value => value.stackId === stack.stackId && value.status !== "DELETE_COMPLETE").sort((a, b) => b.creationTime - a.creationTime || a.changeSetName.localeCompare(b.changeSetName)); for (const value of values) await this.syncChangeSetExecution(value); const page = this.page(`ListChangeSets:${stack.stackId}`, input.NextToken, values, 100); return { Summaries: page.values.map(value => this.changeSetSummary(value)), NextToken: page.nextToken };
  }

  private deleteLinkedNestedChangeSets(root: CloudFormationChangeSetState): void {
    const linked = Object.values(this.state.changeSets).filter(candidate => candidate.rootChangeSetId === root.changeSetId);
    const reviewStackIds = new Set<string>();
    for (const candidate of linked) {
      candidate.status = "DELETE_COMPLETE";
      candidate.executionStatus = candidate.executionStatus === "EXECUTE_COMPLETE" ? "EXECUTE_COMPLETE" : "UNAVAILABLE";
      candidate.lastUpdatedTime = this.clock.now();
      delete this.state.changeSetNames[this.changeSetKey(candidate.stackId, candidate.changeSetName)];
      if (this.state.stacks[candidate.stackId]?.stackStatus === "REVIEW_IN_PROGRESS") reviewStackIds.add(candidate.stackId);
    }
    for (const stackId of reviewStackIds) {
      const stack = this.state.stacks[stackId];
      if (!stack || Object.values(this.state.changeSets).some(candidate => candidate.stackId === stackId && candidate.status !== "DELETE_COMPLETE")) continue;
      delete this.state.stackNames[stack.stackName];
      delete this.state.stacks[stackId];
    }
  }

  private markLinkedNestedChangeSetsExecuting(root: CloudFormationChangeSetState, operationId: string): void {
    for (const candidate of Object.values(this.state.changeSets)) {
      if (candidate.rootChangeSetId !== root.changeSetId || candidate.status === "DELETE_COMPLETE") continue;
      candidate.executionStatus = "EXECUTE_IN_PROGRESS";
      candidate.executionOperationId = operationId;
      candidate.lastUpdatedTime = this.clock.now();
    }
  }

  async DeleteChangeSet(input: any): Promise<any> {
    let value: CloudFormationChangeSetState;
    try { value = this.changeSet(String(input.ChangeSetName ?? ""), input.StackName === undefined ? undefined : String(input.StackName)); }
    catch (error) { if (error instanceof AwsError && error.code === "ChangeSetNotFound") return {}; throw error; }
    if (value.parentChangeSetId) throw new AwsError("InvalidChangeSetStatus", `Nested change set ${value.changeSetName} is controlled by root change set ${value.rootChangeSetId}`, 400);
    await this.syncChangeSetExecution(value); if (value.executionStatus === "EXECUTE_IN_PROGRESS") throw new AwsError("InvalidChangeSetStatus", `Change set ${value.changeSetName} is being executed`, 400); value.status = "DELETE_COMPLETE"; value.executionStatus = value.executionStatus === "EXECUTE_COMPLETE" ? "EXECUTE_COMPLETE" : "UNAVAILABLE"; value.lastUpdatedTime = this.clock.now(); delete this.state.changeSetNames[this.changeSetKey(value.stackId, value.changeSetName)]; this.deleteLinkedNestedChangeSets(value); await this.store.save(); await this.maintainPersistenceRetention(); return {};
  }

  async ExecuteChangeSet(input: any, principal: PrincipalContext): Promise<any> {
    const value = this.changeSet(String(input.ChangeSetName ?? ""), input.StackName === undefined ? undefined : String(input.StackName)); if (value.parentChangeSetId) throw new AwsError("InvalidChangeSetStatus", `Nested change set ${value.changeSetName} must be executed through root change set ${value.rootChangeSetId}`, 400); await this.syncChangeSetExecution(value); const suppliedToken = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken); this.validateClientRequestToken(suppliedToken); const token = suppliedToken ?? `execute-${value.changeSetId.split("/").at(-1)}`; if (value.executionClientToken === token && (value.executionStatus === "EXECUTE_IN_PROGRESS" || value.executionStatus === "EXECUTE_COMPLETE")) return {}; if (value.status !== "CREATE_COMPLETE" || value.executionStatus !== "AVAILABLE") throw new AwsError("InvalidChangeSetStatus", `Change set ${value.changeSetName} cannot be executed in ${value.status}/${value.executionStatus}`, 400); if (value.onStackFailure && input.DisableRollback !== undefined) throw new AwsError("ValidationError", "DisableRollback cannot be specified when the change set has OnStackFailure", 400);
    const artifactId = value.templateArtifactId;
    if (!artifactId) throw new AwsError("ValidationError", `Change set ${value.changeSetName} is missing its template artifact`, 400);
    const artifact = await this.journal.readJsonArtifact<ChangeSetExecutionArtifact>("change-sets", `${artifactId}.input.json`);
    if (!artifact || artifact.schemaVersion !== 2 || typeof artifact.processedTemplateBody !== "string" || typeof artifact.originalTemplateBody !== "string" || typeof artifact.processedTemplateDigest !== "string" || typeof artifact.originalTemplateDigest !== "string" || (artifact.templateBodyMaximumBytes !== undefined && artifact.templateBodyMaximumBytes !== TEMPLATE_BODY_MAXIMUM_BYTES && artifact.templateBodyMaximumBytes !== TEMPLATE_URL_MAXIMUM_BYTES) || !Array.isArray(artifact.Parameters) || !Array.isArray(artifact.Capabilities) || !Array.isArray(artifact.NotificationARNs) || !Array.isArray(artifact.Tags) || !artifact.imports || typeof artifact.imports !== "object" || !Array.isArray(artifact.ssmParameters) || artifact.nestedTemplateManifest !== undefined && (![1, 2].includes(artifact.nestedTemplateManifest.schemaVersion) || !Array.isArray(artifact.nestedTemplateManifest.assets))) {
      throw new AwsError("ValidationError", `Change set ${value.changeSetName} is missing or has an invalid immutable execution input`, 400);
    }
    const originalDigest = createHash("sha256").update(artifact.originalTemplateBody).digest("hex");
    const processedDigest = createHash("sha256").update(artifact.processedTemplateBody).digest("hex");
    if (originalDigest !== artifact.originalTemplateDigest || processedDigest !== artifact.processedTemplateDigest || value.templateDigest !== artifact.originalTemplateDigest || value.processedTemplateDigest !== artifact.processedTemplateDigest) {
      throw new AwsError("ValidationError", `Change set ${value.changeSetName} immutable template artifact failed integrity validation`, 400);
    }
    const stack = this.state.stacks[value.stackId];
    if (!stack) throw new AwsError("ValidationError", `Stack ${value.stackName} no longer exists`, 400);
    if (artifact.StackName !== stack.stackName) throw new AwsError("ValidationError", `Change set ${value.changeSetName} immutable input targets a different stack`, 400);
    if (value.changeSetType === "UPDATE" && (stack.templateDigest !== artifact.baselineTemplateDigest || stack.processedTemplateDigest !== artifact.baselineProcessedTemplateDigest)) {
      value.executionStatus = "OBSOLETE"; await this.store.save();
      throw new AwsError("InvalidChangeSetStatus", `Stack ${value.stackName} changed after this change set was created`, 400);
    }
    const currentExports = this.exportValues();
    for (const [name, expected] of Object.entries(artifact.imports)) {
      if (!Object.hasOwn(currentExports, name) || String(currentExports[name]) !== String(expected)) {
        value.executionStatus = "OBSOLETE"; value.lastUpdatedTime = this.clock.now(); await this.store.save();
        throw new AwsError("InvalidChangeSetStatus", `Imported value ${name} changed after change set ${value.changeSetName} was created`, 400);
      }
    }
    for (const parameter of artifact.ssmParameters) {
      if (!parameter || typeof parameter.name !== "string" || typeof parameter.value !== "string" || this.resolveBootstrapSsmParameter(parameter.name, "AWS::SSM::Parameter::Value<String>") !== parameter.value) {
        value.executionStatus = "OBSOLETE"; value.lastUpdatedTime = this.clock.now(); await this.store.save();
        throw new AwsError("InvalidChangeSetStatus", `Bootstrap SSM dependency changed after change set ${value.changeSetName} was created`, 400);
      }
    }
    const executionPrincipal = await this.operationPrincipal(artifact.RoleARN, artifactId.slice(0, 32), principal);
    const manifest = await this.journal.readJsonArtifact<CloudFormationAssetManifest>("assets", `${artifactId}.json`);
    if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.references)) throw new AwsError("ValidationError", `Change set ${value.changeSetName} is missing its immutable asset manifest`, 400);
    for (const expected of manifest.references) {
      const actual = await this.readAssetReference(expected.logicalId, expected.resourceType, expected.propertyPath, expected.bucket, expected.key, executionPrincipal, expected.versionId);
      if (!actual) throw new AwsError("ValidationError", `${expected.logicalId}.${expected.propertyPath} asset is missing`, 400);
      if (actual.versionId !== expected.versionId || actual.sha256 !== expected.sha256 || actual.etag !== expected.etag || actual.size !== expected.size) {
        throw new AwsError("ValidationError", `${expected.logicalId}.${expected.propertyPath} asset changed after change set ${value.changeSetName} was created`, 400);
      }
    }
    const executionInput: any = {
      StackName: artifact.StackName,
      TemplateBody: artifact.processedTemplateBody,
      Parameters: structuredClone(artifact.Parameters),
      Capabilities: [...artifact.Capabilities],
      NotificationARNs: [...artifact.NotificationARNs],
      Tags: structuredClone(artifact.Tags),
    };
    if (artifact.RoleARN !== undefined) executionInput.RoleARN = artifact.RoleARN;
    if (artifact.RollbackConfiguration !== undefined) executionInput.RollbackConfiguration = structuredClone(artifact.RollbackConfiguration);
    value.executionClientToken = token; value.lastUpdatedTime = this.clock.now(); await this.store.save();
    try {
      executionInput.ClientRequestToken = token;
      executionInput.RetainExceptOnCreate = input.RetainExceptOnCreate === true;
      if (value.onStackFailure) { executionInput.OnFailure = value.onStackFailure; delete executionInput.DisableRollback; }
      else executionInput.DisableRollback = input.DisableRollback === true;
      // Execution replays a processed immutable artifact through the normal
      // stack paths. Preserve the source's admission limit instead of treating
      // that replay as a new 51,200-byte inline TemplateBody submission.
      const templateBodyMaximumBytes = artifact.templateBodyMaximumBytes
        ?? (Buffer.byteLength(artifact.processedTemplateBody) > TEMPLATE_BODY_MAXIMUM_BYTES
          ? TEMPLATE_URL_MAXIMUM_BYTES
          : TEMPLATE_BODY_MAXIMUM_BYTES);
      const prepared = { originalBody: artifact.originalTemplateBody, originalDigest: artifact.originalTemplateDigest, templateBodyMaximumBytes, assetManifest: manifest, nestedTemplateManifest: artifact.nestedTemplateManifest, templateSource: artifact.templateSource };
      if (value.changeSetType === "CREATE") await this.CreateStack(executionInput, principal, stack, prepared);
      else await this.UpdateStack(executionInput, principal, prepared);
      const active = this.state.stacks[value.stackId]?.activeOperation; if (!active) throw new Error("Executing the change set did not accept a stack operation"); value.executionOperationId = active.operationId; value.executionStatus = "EXECUTE_IN_PROGRESS"; value.lastUpdatedTime = this.clock.now(); this.markLinkedNestedChangeSetsExecuting(value, active.operationId); for (const other of Object.values(this.state.changeSets)) if (other.stackId === value.stackId && other.changeSetId !== value.changeSetId && other.executionStatus === "AVAILABLE") other.executionStatus = "OBSOLETE"; await this.store.save(); return {};
    } catch (error) {
      // CreateStack/UpdateStack can have durably accepted the operation even
      // when a later catalog save fails. Never overwrite that accepted intent
      // with EXECUTE_FAILED; link it and let normal operation recovery resume.
      if (this.linkAcceptedChangeSetExecution(value)) { if (value.executionOperationId) this.markLinkedNestedChangeSetsExecuting(value, value.executionOperationId); await this.store.save(); return {}; }
      value.executionStatus = "EXECUTE_FAILED"; value.statusReason = error instanceof Error ? error.message : String(error); value.lastUpdatedTime = this.clock.now(); await this.store.save(); throw error;
    }
  }

  async ListExports(input: any): Promise<any> {
    const values = Object.values(this.state.exports).sort((a, b) => a.name.localeCompare(b.name)); const page = this.page("ListExports", input.NextToken, values, 100); return { Exports: page.values.map(value => ({ ExportingStackId: value.exportingStackId, Name: value.name, Value: value.value })), NextToken: page.nextToken };
  }

  async ListImports(input: any): Promise<any> {
    const exportName = String(input.ExportName ?? ""); const exported = this.state.exports[exportName]; if (!exported) throw new AwsError("ValidationError", `Export ${exportName || "(missing)"} does not exist`, 400); const values = this.activeImporters(exportName).map(stack => stack.stackName).sort(); const page = this.page(`ListImports:${exportName}`, input.NextToken, values, 100); return { Imports: page.values, NextToken: page.nextToken };
  }

  async DescribeStacks(input: any): Promise<any> {
    const stacks = input.StackName ? [this.stack(String(input.StackName), true)] : Object.values(this.state.stacks).filter(stack => stack.stackStatus !== "DELETE_COMPLETE").sort((a, b) => a.stackName.localeCompare(b.stackName));
    const page = this.page("DescribeStacks", input.NextToken, stacks, 100);
    return { Stacks: page.values.map(stack => this.stackView(stack)), NextToken: page.nextToken };
  }

  async ListStacks(input: any): Promise<any> {
    const filters = new Set(list<string>(input.StackStatusFilter).map(String));
    const values = Object.values(this.state.stacks).filter(stack => !filters.size || filters.has(stack.stackStatus)).sort((a, b) => b.creationTime - a.creationTime || a.stackName.localeCompare(b.stackName));
    const page = this.page("ListStacks", input.NextToken, values, 100);
    return { StackSummaries: page.values.map(stack => ({ StackId: stack.stackId, StackName: stack.stackName, TemplateDescription: stack.description, CreationTime: new Date(stack.creationTime), LastUpdatedTime: stack.lastUpdatedTime === undefined ? undefined : new Date(stack.lastUpdatedTime), DeletionTime: stack.deletionTime === undefined ? undefined : new Date(stack.deletionTime), StackStatus: stack.stackStatus, StackStatusReason: stack.stackStatusReason, ParentId: stack.parentId, RootId: stack.rootId, DriftInformation: { StackDriftStatus: "NOT_CHECKED" } })), NextToken: page.nextToken };
  }

  async DescribeStackEvents(input: any): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""), true); const operationId = input.OperationId === undefined ? undefined : String(input.OperationId); const values = stack.events.filter(event => operationId === undefined || event.operationId === operationId).sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId)); const page = this.page(`DescribeStackEvents:${stack.stackId}:${operationId ?? "all"}`, input.NextToken, values, 100);
    return { StackEvents: page.values.map(event => this.eventView(event)), NextToken: page.nextToken };
  }

  async DescribeStackResource(input: any): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""), true); const resource = stack.resources[String(input.LogicalResourceId ?? "")];
    if (!resource) throw new AwsError("ValidationError", `Logical resource ${input.LogicalResourceId} does not exist for stack ${stack.stackName}`, 400);
    return { StackResourceDetail: { ...resourceView(stack, resource), Metadata: resource.metadata && Object.keys(resource.metadata).length ? JSON.stringify(resource.metadata) : undefined, LastUpdatedTimestamp: new Date(resource.lastUpdatedTimestamp) } };
  }

  async DescribeStackResources(input: any): Promise<any> {
    if (!input.StackName && !input.PhysicalResourceId) throw new AwsError("ValidationError", "Either StackName or PhysicalResourceId must be specified", 400);
    if (input.StackName && input.PhysicalResourceId) throw new AwsError("ValidationError", "Only one of StackName or PhysicalResourceId may be specified", 400);
    const stacks = input.StackName ? [this.stack(String(input.StackName), true)] : Object.values(this.state.stacks).filter(stack => Object.values(stack.resources).some(resource => resource.physicalResourceId === input.PhysicalResourceId));
    const resources = stacks.flatMap(stack => Object.values(stack.resources).filter(resource => !input.LogicalResourceId || resource.logicalResourceId === input.LogicalResourceId).map(resource => resourceView(stack, resource)));
    return { StackResources: resources };
  }

  async ListStackResources(input: any): Promise<any> {
    const stack = this.stack(String(input.StackName ?? ""), true); const values = Object.values(stack.resources).sort((a, b) => a.logicalResourceId.localeCompare(b.logicalResourceId)); const page = this.page("ListStackResources", input.NextToken, values, 100);
    return { StackResourceSummaries: page.values.map(resource => ({ LogicalResourceId: resource.logicalResourceId, PhysicalResourceId: resource.physicalResourceId, ResourceType: resource.resourceType, LastUpdatedTimestamp: new Date(resource.lastUpdatedTimestamp), ResourceStatus: resource.resourceStatus, ResourceStatusReason: resource.resourceStatusReason, DriftInformation: { StackResourceDriftStatus: "NOT_CHECKED" } })), NextToken: page.nextToken };
  }

  async GetTemplate(input: any): Promise<any> {
    const stage = String(input.TemplateStage ?? "Original"); if (!new Set(["Original", "Processed"]).has(stage)) throw new AwsError("ValidationError", `TemplateStage ${stage} is invalid`, 400); let artifactId: string; let label: string;
    if (input.ChangeSetName !== undefined) { const value = this.changeSet(String(input.ChangeSetName), input.StackName === undefined ? undefined : String(input.StackName)); if (!value.templateArtifactId) throw new AwsError("ValidationError", `Template artifact for change set ${value.changeSetName} is unavailable`, 400); artifactId = value.templateArtifactId; label = `change set ${value.changeSetName}`; }
    else {
      const stack = this.stack(String(input.StackName ?? ""), true);
      if (stack.stackStatus !== "REVIEW_IN_PROGRESS" && stack.templateArtifactId) artifactId = stack.templateArtifactId;
      else {
        // A CREATE change set owns the only template while its stack is the
        // AWS-shaped REVIEW_IN_PROGRESS placeholder. The standard CDK
        // execute-change-set workflow asks GetTemplate by stack name before
        // it executes that prepared change set, so expose the newest durable
        // non-deleted CREATE artifact rather than fabricating an empty stack
        // template.
        const prepared = Object.values(this.state.changeSets)
          .filter(value => value.stackId === stack.stackId && value.changeSetType === "CREATE" && value.status !== "DELETE_COMPLETE" && value.templateArtifactId)
          .sort((left, right) => right.creationTime - left.creationTime || right.changeSetId.localeCompare(left.changeSetId))[0];
        artifactId = prepared?.templateArtifactId ?? this.artifactId(stack.stackId);
      }
      label = `stack ${stack.stackName}`;
    }
    const body = await this.journal.readTemplate(artifactId, stage === "Processed" ? "processed" : "original");
    if (body === undefined) throw new AwsError("ValidationError", `Template artifact for ${label} is unavailable`, 400);
    return { TemplateBody: body, StagesAvailable: ["Original", "Processed"] };
  }

  async UpdateTerminationProtection(input: any): Promise<any> {
    const stack = this.stack(String(input.StackName ?? "")); if (stack.parentId) throw new AwsError("ValidationError", `Termination protection for nested stack ${stack.stackName} is controlled by root stack ${this.hierarchyRoot(stack).stackName}`, 400); stack.enableTerminationProtection = Boolean(input.EnableTerminationProtection); stack.lastUpdatedTime = this.clock.now(); await this.store.save(); return { StackId: stack.stackId };
  }

  localStacks(): CloudFormationStackState[] { return Object.values(this.state.stacks).filter(stack => stack.stackStatus !== "DELETE_COMPLETE").sort((left, right) => left.stackName.localeCompare(right.stackName)).map(stack => this.localStackState(stack)); }
  localStack(identifier: string): CloudFormationStackState { return this.localStackState(this.stack(identifier, true)); }
  localHierarchy(identifier: string): CloudFormationStackState[] { const selected = this.stack(identifier, true); const rootId = selected.rootId ?? selected.stackId; return Object.values(this.state.stacks).filter(stack => stack.stackStatus !== "DELETE_COMPLETE" && (stack.stackId === rootId || stack.rootId === rootId)).sort((left, right) => left.stackName.localeCompare(right.stackName)).map(stack => this.localStackState(stack)); }
  localEvents(identifier: string): CloudFormationStackEventState[] { const stack = this.stack(identifier, true); return [...stack.events].sort((left, right) => right.timestamp - left.timestamp || right.eventId.localeCompare(left.eventId)).map(event => this.redactedEvent(stack, event)); }
  localResources(identifier: string): CloudFormationStackResourceState[] { const stack = this.stack(identifier, true); return Object.values(stack.resources).sort((left, right) => left.logicalResourceId.localeCompare(right.logicalResourceId)).map(resource => this.redactedResource(stack, resource)); }
  async localTemplate(identifier: string): Promise<string> { return (await this.GetTemplate({ StackName: identifier, TemplateStage: "Original" })).TemplateBody; }

  async DeleteStack(input: any, principal?: PrincipalContext, internalNested = false, owningParentOperationId?: string): Promise<any> {
    const identifier = String(input.StackName ?? ""); const token = input.ClientRequestToken === undefined ? undefined : String(input.ClientRequestToken); this.validateClientRequestToken(token); const retainLogicalIds = list<string>(input.RetainResources).map(String).sort(); const deletionMode = String(input.DeletionMode ?? "STANDARD"); if (deletionMode !== "STANDARD" && deletionMode !== "FORCE_DELETE_STACK") throw new AwsError("ValidationError", `DeletionMode ${deletionMode} is invalid`, 400); const inputDigest = createHash("sha256").update(canonical({ action: "DeleteStack", identifier, retainLogicalIds, deletionMode, roleArn: input.RoleARN })).digest("hex");
    if (token) { const prior = this.state.clientTokens[token]; if (prior) { if (prior.operation !== "DeleteStack" || prior.inputDigest !== inputDigest) throw new AwsError("TokenAlreadyExistsException", `A different request already uses client token ${token}`, 400); return {}; } }
    const stack = this.stack(identifier); if (!internalNested) this.assertNoActiveAncestor(stack); if (!internalNested && this.hierarchyRoot(stack).enableTerminationProtection) throw new AwsError("ValidationError", `Stack ${stack.stackName} cannot be deleted while root termination protection is enabled`, 400); this.assertStackExportsDeletable(stack);
    if (stack.activeOperation?.status === "PENDING" || stack.activeOperation?.status === "RUNNING") throw new AwsError("ValidationError", `Stack ${stack.stackName} is currently being modified`, 400); for (const logicalId of retainLogicalIds) if (!stack.resources[logicalId]) throw new AwsError("ValidationError", `RetainResources contains unknown logical resource ${logicalId}`, 400);
    if (retainLogicalIds.length && stack.stackStatus !== "DELETE_FAILED") throw new AwsError("ValidationError", "RetainResources can be specified only when retrying a stack in DELETE_FAILED", 400);
    if (deletionMode === "FORCE_DELETE_STACK" && stack.stackStatus !== "DELETE_FAILED") throw new AwsError("ValidationError", "FORCE_DELETE_STACK can be specified only for a stack in DELETE_FAILED", 400);
    const operationId = randomUUID(); const caller = principal ?? this.defaultExecutionPrincipal(); const executionPrincipal = await this.operationPrincipal(input.RoleARN ?? stack.roleArn, operationId, caller); await this.journal.replaceJsonArtifact("execution", `${operationId}.principal.json`, executionPrincipal); if (input.RoleARN !== undefined) stack.roleArn = String(input.RoleARN);
    const graph = stack.templateArtifactId ? await this.journal.readJsonArtifact<{ order?: string[] }>("plans", `${stack.templateArtifactId}.graph.json`) : undefined; const graphOrder = Array.isArray(graph?.order) ? graph!.order! : []; const orderedLogicalIds = [...new Set([...graphOrder.filter(logicalId => stack.resources[logicalId]), ...Object.keys(stack.resources).filter(logicalId => !graphOrder.includes(logicalId)).sort()])].reverse(); const alreadyDeleted = orderedLogicalIds.filter(logicalId => stack.resources[logicalId]?.resourceStatus === "DELETE_COMPLETE");
    const now = this.clock.now(); stack.stackStatus = "DELETE_IN_PROGRESS"; stack.activeOperation = { operationId, kind: "DELETE", status: "PENDING", acceptedAt: now, clientRequestToken: token, orderedLogicalIds, completedLogicalIds: alreadyDeleted, rollbackLogicalIds: [], retainLogicalIds, forceDelete: deletionMode === "FORCE_DELETE_STACK", ...(owningParentOperationId ? { owningParentOperationId } : {}) }; if (token) this.state.clientTokens[token] = { operation: "DeleteStack", stackId: stack.stackId, operationId, inputDigest, createdAt: now }; this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "DELETE_IN_PROGRESS", undefined, stack.stackId, token); await this.checkpoint(stack, "accepted"); await this.store.save(); this.schedule(stack.stackId); return {};
  }

  private async template(input: any, principal: PrincipalContext, admittedTemplateBodyMaximumBytes?: number): Promise<ParsedTemplate> {
    if (input.TemplateBody !== undefined && input.TemplateURL !== undefined) throw new AwsError("ValidationError", "Specify exactly one of TemplateBody or TemplateURL", 400);
    if (input.TemplateBody === undefined && input.TemplateURL === undefined) throw new AwsError("ValidationError", "TemplateBody or TemplateURL is required", 400);
    let body: string;
    let source: TemplateSourceArtifact | undefined;
    if (input.TemplateURL !== undefined) {
      const requested = parseLocalS3ObjectUrl(input.TemplateURL, this.region);
      let owner: string | undefined;
      try { owner = this.s3.bucketOwnerAccountIdInternal(requested.bucket); } catch { /* readLocalS3Template returns the public validation error below. */ }
      if (owner && owner !== this.store.accountId) throw new AwsError("ValidationError", `TemplateURL bucket ${requested.bucket} is owned by account ${owner}, not stack account ${this.store.accountId}`, 400);
      if (this.authorizeProviderTargets) await this.authorizeProviderTargets(principal, [{ action: requested.versionId ? "s3:GetObjectVersion" : "s3:GetObject", resource: `arn:aws:s3:::${requested.bucket}/${requested.key}` }]);
      const loaded = await readLocalS3Template(this.s3, input.TemplateURL, this.region);
      if (loaded.object.ownerAccountId !== this.store.accountId) throw new AwsError("ValidationError", `TemplateURL bucket ${loaded.location.bucket} is owned by account ${loaded.object.ownerAccountId}, not stack account ${this.store.accountId}`, 400);
      body = loaded.body;
      source = { templateUrl: String(input.TemplateURL), bucket: loaded.location.bucket, key: loaded.location.key, versionId: loaded.object.versionId, etag: loaded.object.etag, size: loaded.object.size, digest: loaded.object.sha256 };
    } else body = String(input.TemplateBody);
    const maximum = input.TemplateURL !== undefined ? TEMPLATE_URL_MAXIMUM_BYTES : admittedTemplateBodyMaximumBytes ?? TEMPLATE_BODY_MAXIMUM_BYTES; if (!body || Buffer.byteLength(body) > maximum) throw new AwsError("ValidationError", `Template ${input.TemplateURL !== undefined ? "URL object" : "body"} must contain 1-${maximum} bytes`, 400);
    const parsed = await this.templateFromBody(body);
    return source ? { ...parsed, source } : parsed;
  }

  private async templateFromBody(body: string): Promise<ParsedTemplate> {
    try {
      const value = parseCloudFormationTemplate(body); if (value.Description !== undefined && value.Description.length > 1024) throw new AwsError("ValidationError", "Template Description must be no longer than 1024 characters", 400);
      return { body, value, digest: createHash("sha256").update(body).digest("hex") };
    } catch (error) { throw this.validationError(error); }
  }

  private async readAssetReference(
    logicalId: string,
    resourceType: string,
    propertyPath: CloudFormationAssetReference["propertyPath"],
    bucket: string,
    key: string,
    principal: PrincipalContext,
    versionId?: string,
    allowMissing = false,
  ): Promise<CloudFormationAssetReference | undefined> {
    const maximumBytes = resourceType === "AWS::Lambda::Function" || resourceType === "AWS::Lambda::LayerVersion"
      ? Number(process.env.STACKSIM_LAMBDA_ZIP_LIMIT ?? 50 * 1024 * 1024)
      : resourceType === "Custom::CDKBucketDeployment" ? 128 * 1024 * 1024
        : 50 * 1024 * 1024;
    let object;
    try {
      if (this.authorizeProviderTargets) await this.authorizeProviderTargets(principal, [{ action: versionId ? "s3:GetObjectVersion" : "s3:GetObject", resource: `arn:aws:s3:::${bucket}/${key}` }]);
      object = await this.s3.readObjectBytes(bucket, key, versionId, maximumBytes);
    }
    catch (error) {
      // A review-only change set can precede asset publication. CDK uses this
      // for accurate provider-backed diffs. Authorization and every other S3
      // failure remain strict; execution performs the normal immutable read.
      if (allowMissing && error instanceof AwsError && (error.code === "NoSuchKey" || error.code === "NoSuchVersion")) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new AwsError("ValidationError", `${logicalId}.${propertyPath} cannot read local S3 asset s3://${bucket}/${key}${versionId ? `?versionId=${versionId}` : ""}: ${message}`, 400);
    }
    return { logicalId, resourceType, propertyPath, bucket, key, versionId: object.versionId, sha256: object.sha256, etag: object.etag, size: object.size };
  }

  /**
   * Resolve the literal/parameter/pseudo-parameter file assets that CDK emits
   * before an operation is accepted. The processed template keeps the
   * authoritative S3 version while the manifest keeps the byte digest used to
   * detect an overwritten unversioned object.
   */
  private async pinStaticFileAssets(
    template: CloudFormationTemplate,
    evaluation: Record<string, unknown>,
    artifactId: string,
    principal: PrincipalContext,
    allowMissing = false,
    previousResources: Readonly<Record<string, CloudFormationStackResourceState>> = {},
    acceptedManifest?: CloudFormationAssetManifest,
  ): Promise<CloudFormationTemplate> {
    const processed = structuredClone(template);
    const references: CloudFormationAssetReference[] = [];
    for (const [logicalId, definition] of Object.entries(processed.Resources)) {
      const propertyPath = definition.Type === "AWS::Lambda::Function" ? "Code"
        : definition.Type === "AWS::Lambda::LayerVersion" ? "Content"
          : definition.Type === "AWS::ApiGateway::RestApi" ? "BodyS3Location"
            : definition.Type === "Custom::CDKBucketDeployment" ? "SourceObjectKeys"
              : undefined;
      if (!propertyPath) continue;
      if (propertyPath === "SourceObjectKeys") {
        let sourceBuckets: unknown;
        let sourceKeys: unknown;
        try {
          sourceBuckets = evaluateIntrinsicValue(definition.Properties?.SourceBucketNames, evaluation as any, `$.Resources.${logicalId}.Properties.SourceBucketNames`);
          sourceKeys = evaluateIntrinsicValue(definition.Properties?.SourceObjectKeys, evaluation as any, `$.Resources.${logicalId}.Properties.SourceObjectKeys`);
        } catch { continue; } // Resource-dependent addresses are pinned when the provider becomes dependency-ready.
        if (!Array.isArray(sourceBuckets) || sourceBuckets.length !== 1 || typeof sourceBuckets[0] !== "string" || !sourceBuckets[0]
          || !Array.isArray(sourceKeys) || sourceKeys.length !== 1 || typeof sourceKeys[0] !== "string" || !sourceKeys[0]) continue;
        const accepted = acceptedManifest?.references.find(candidate => candidate.logicalId === logicalId && candidate.propertyPath === propertyPath);
        const reference = await this.readAssetReference(logicalId, definition.Type, propertyPath, sourceBuckets[0], sourceKeys[0], principal, accepted?.versionId, allowMissing);
        if (accepted && reference && (accepted.bucket !== reference.bucket || accepted.key !== reference.key || accepted.versionId !== reference.versionId || accepted.sha256 !== reference.sha256 || accepted.etag !== reference.etag || accepted.size !== reference.size)) {
          throw new AwsError("ValidationError", `${logicalId}.${propertyPath} local S3 asset changed after the change set accepted it`, 400);
        }
        if (reference) references.push(reference);
        continue;
      }
      const raw = definition.Properties?.[propertyPath];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      let location: any;
      try { location = evaluateIntrinsicValue(raw, evaluation as any, `$.Resources.${logicalId}.Properties.${propertyPath}`); }
      catch { continue; } // A resource-dependent location is pinned when its provider becomes dependency-ready.
      const bucket = location?.S3Bucket ?? location?.Bucket;
      const key = location?.S3Key ?? location?.Key;
      const requestedVersion = location?.S3ObjectVersion ?? location?.Version;
      if (typeof bucket !== "string" || !bucket || typeof key !== "string" || !key || (requestedVersion !== undefined && typeof requestedVersion !== "string")) continue;
      let reference = await this.readAssetReference(logicalId, definition.Type, propertyPath, bucket, key, principal, requestedVersion, allowMissing);
      const previousLocation = previousResources[logicalId]?.properties?.[propertyPath];
      if (previousLocation && typeof previousLocation === "object" && !Array.isArray(previousLocation)) {
        const previous = previousLocation as Record<string, unknown>;
        const previousBucket = propertyPath === "Code" || propertyPath === "Content" ? previous.S3Bucket : previous.Bucket;
        const previousKey = propertyPath === "Code" || propertyPath === "Content" ? previous.S3Key : previous.Key;
        const previousVersion = propertyPath === "Code" || propertyPath === "Content" ? previous.S3ObjectVersion : previous.Version;
        if (previousBucket === bucket && previousKey === key && typeof previousVersion === "string" && previousVersion && previousVersion !== reference?.versionId) {
          const prior = await this.readAssetReference(logicalId, definition.Type, propertyPath, bucket, key, principal, previousVersion, allowMissing);
          // The CDK key is content-addressed. Re-publishing identical bytes to a
          // versioned bucket must remain a CloudFormation no-op, so keep the
          // already deployed immutable version when the digest is unchanged.
          if (prior && (!reference || prior.sha256 === reference.sha256 && prior.size === reference.size)) reference = prior;
        }
      }
      if (!reference) continue;
      references.push(reference);
      const target = definition.Properties![propertyPath] as Record<string, unknown>;
      if (propertyPath === "Code" || propertyPath === "Content") target.S3ObjectVersion = reference.versionId;
      else target.Version = reference.versionId;
    }
    const manifest: CloudFormationAssetManifest = { schemaVersion: 1, references: references.sort((left, right) => left.logicalId.localeCompare(right.logicalId) || left.propertyPath.localeCompare(right.propertyPath)) };
    await this.journal.replaceJsonArtifact("assets", `${artifactId}.json`, manifest);
    return processed;
  }

  private async validatePinnedTemplateSource(source: TemplateSourceArtifact, body: string): Promise<void> {
    const location = parseLocalS3ObjectUrl(source.templateUrl, this.region);
    if (location.bucket !== source.bucket || location.key !== source.key || location.versionId && location.versionId !== source.versionId) throw new AwsError("ValidationError", "Immutable TemplateURL artifact has the wrong bucket, key, or object version", 400);
    let owner: string | undefined;
    try { owner = this.s3.bucketOwnerAccountIdInternal(source.bucket); } catch { /* The pinned read below produces the immutable missing-object error. */ }
    if (owner && owner !== this.store.accountId) throw new AwsError("ValidationError", `TemplateURL bucket ${source.bucket} is owned by account ${owner}, not stack account ${this.store.accountId}`, 400);
    if (createHash("sha256").update(body).digest("hex") !== source.digest || Buffer.byteLength(body) !== source.size) throw new AwsError("ValidationError", "Immutable TemplateURL body failed digest validation", 400);
    try {
      const current = await this.s3.readObjectBytes(source.bucket, source.key, source.versionId, TEMPLATE_URL_MAXIMUM_BYTES);
      if (current.ownerAccountId !== this.store.accountId) throw new Error(`bucket is owned by account ${current.ownerAccountId}, not stack account ${this.store.accountId}`);
      if (current.versionId !== source.versionId || current.sha256 !== source.digest || current.etag !== source.etag || current.size !== source.size) throw new Error("pinned S3 object version or digest changed");
    } catch (error) {
      throw new AwsError("ValidationError", `Pinned TemplateURL object s3://${source.bucket}/${source.key}?versionId=${source.versionId} is missing or failed immutable digest validation: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }

  private async pinNestedTemplateAssets(
    template: CloudFormationTemplate,
    evaluation: Record<string, unknown>,
    artifactId: string,
    principal: PrincipalContext,
    acceptedManifest?: NestedTemplateManifest,
    admission?: {
      stackId: string;
      stackName: string;
      logicalPath?: string;
      capabilities?: readonly string[];
      tags?: Record<string, string>;
      previousResources?: Record<string, CloudFormationStackResourceState>;
    },
  ): Promise<NestedTemplateManifest> {
    const rootStackId = admission?.stackId ?? `arn:aws:cloudformation:${this.region}:${this.store.accountId}:stack/admission-root/${randomUUID()}`;
    const rootStackName = admission?.stackName ?? "admission-root";
    const capabilities = [...(admission?.capabilities ?? [])];
    const nodes: Array<RecursiveAdmissionNode | undefined> = [];
    const uniqueTemplates = new Map<string, number>();
    const activeTemplates = new Set<string>();
    const rootResources = Object.keys(template.Resources).length;
    if (rootResources > 500) throw new AwsError("LimitExceededException", `Root template declares ${rootResources} resources; a template may declare at most 500`, 400);
    const rootOutputs = Object.keys(template.Outputs ?? {}).length;
    if (rootOutputs > 200) throw new AwsError("LimitExceededException", `Root template declares ${rootOutputs} outputs; a template may declare at most 200`, 400);
    let totalResources = rootResources;
    let totalTemplates = 1;

    const addTemplateLimits = (candidate: CloudFormationTemplate, digest: string, size: number, logicalPath: string): void => {
      const resources = Object.keys(candidate.Resources).length;
      if (resources > 500) throw new AwsError("LimitExceededException", `${logicalPath} declares ${resources} resources; a template may declare at most 500`, 400);
      const outputs = Object.keys(candidate.Outputs ?? {}).length;
      if (outputs > 200) throw new AwsError("LimitExceededException", `${logicalPath} declares ${outputs} outputs; a template may declare at most 200`, 400);
      totalResources += resources;
      totalTemplates += 1;
      if (totalResources > 2_500) throw new AwsError("LimitExceededException", `Nested stack hierarchy contains ${totalResources} resources; at most 2500 are admitted`, 400);
      if (!uniqueTemplates.has(digest)) uniqueTemplates.set(digest, size);
      const uniqueBytes = [...uniqueTemplates.values()].reduce((sum, value) => sum + value, 0);
      if (uniqueBytes > 64 * 1024 * 1024) throw new AwsError("LimitExceededException", "Nested stack templates exceed the local 64 MiB hierarchy artifact limit", 400);
    };

    const deferredParameterValues = new Set<string>();
    const deferredParameterValue = (logicalPath: string, name: string, raw: unknown): string => {
      const value = `stacksim-deferred-${createHash("sha256").update(canonical({ logicalPath, name, raw })).digest("hex").slice(0, 24)}`;
      deferredParameterValues.add(value);
      return value;
    };

    const discover = async (
      currentTemplate: CloudFormationTemplate,
      currentEvaluation: Record<string, unknown>,
      parent: { stackId: string; stackName: string; logicalPath?: string; tags: Record<string, string>; previousResources: Record<string, CloudFormationStackResourceState> },
      accepted: NestedTemplateManifest | undefined,
    ): Promise<NestedTemplateManifest> => {
      const assets: NestedTemplateAsset[] = [];
      for (const [logicalId, definition] of Object.entries(currentTemplate.Resources).sort(([left], [right]) => left.localeCompare(right))) {
        if (definition.Type !== CLOUDFORMATION_NESTED_STACK_TYPE) continue;
        const logicalPath = parent.logicalPath ? `${parent.logicalPath}/${logicalId}` : logicalId;
        let templateUrl: unknown;
        try { templateUrl = evaluateIntrinsicValue(definition.Properties?.TemplateURL, currentEvaluation as any, `$.Resources.${logicalId}.Properties.TemplateURL`); }
        catch (error) { throw new AwsError("ValidationError", `${logicalPath}.TemplateURL must resolve before any hierarchy resource mutation: ${error instanceof Error ? error.message : String(error)}; owning future requirement: CFN-16`, 400); }
        if (typeof templateUrl !== "string") throw new AwsError("ValidationError", `${logicalPath}.TemplateURL must resolve to a string; owning future requirement: CFN-16`, 400);

        let evaluatedProperties: NestedStackModel | undefined;
        try {
          const value = evaluateIntrinsicValue(definition.Properties ?? {}, currentEvaluation as any, `$.Resources.${logicalId}.Properties`);
          if (value && typeof value === "object" && !Array.isArray(value)) evaluatedProperties = value as NestedStackModel;
        } catch { /* Resource-output-dependent child parameters remain symbolic until their authoritative parent resolves. */ }
        const sourceDigest = evaluatedProperties ? this.nestedTemplateSourceDigest(evaluatedProperties) : undefined;
        const acceptedAsset = accepted?.assets.find(candidate => candidate.logicalId === logicalId && candidate.templateUrl === templateUrl);
        let baseAsset: NestedTemplateAsset;
        if (acceptedAsset) {
          const expectedLocation = parseLocalS3ObjectUrl(templateUrl, this.region);
          let owner: string | undefined;
          try { owner = this.s3.bucketOwnerAccountIdInternal(expectedLocation.bucket); } catch { /* The pinned read below produces the immutable missing-object error. */ }
          if (owner && owner !== this.store.accountId) throw new AwsError("ValidationError", `${logicalPath}.TemplateURL bucket ${expectedLocation.bucket} is owned by account ${owner}, not stack account ${this.store.accountId}; owning future requirement: CFN-16`, 400);
          if (expectedLocation.bucket !== acceptedAsset.bucket || expectedLocation.key !== acceptedAsset.key || expectedLocation.versionId && expectedLocation.versionId !== acceptedAsset.versionId) {
            throw new AwsError("ValidationError", `${logicalPath}.TemplateURL immutable child-template artifact has the wrong bucket, key, or object version; owning future requirement: CFN-16`, 400);
          }
          const actualDigest = createHash("sha256").update(acceptedAsset.body).digest("hex");
          if (actualDigest !== acceptedAsset.digest || Buffer.byteLength(acceptedAsset.body) !== acceptedAsset.size) throw new AwsError("ValidationError", `${logicalPath}.TemplateURL immutable child-template artifact failed integrity validation; owning future requirement: CFN-16`, 400);
          if (sourceDigest && acceptedAsset.sourceDigest && sourceDigest !== acceptedAsset.sourceDigest) throw new AwsError("ValidationError", `${logicalPath}.TemplateURL or Parameters changed after recursive admission; owning future requirement: CFN-16`, 400);
          try {
            if (this.authorizeProviderTargets) await this.authorizeProviderTargets(principal, [{ action: "s3:GetObjectVersion", resource: `arn:aws:s3:::${acceptedAsset.bucket}/${acceptedAsset.key}` }]);
            const current = await this.s3.readObjectBytes(acceptedAsset.bucket, acceptedAsset.key, acceptedAsset.versionId, TEMPLATE_URL_MAXIMUM_BYTES);
            if (current.ownerAccountId !== this.store.accountId) throw new Error(`bucket is owned by account ${current.ownerAccountId}, not stack account ${this.store.accountId}`);
            if (current.versionId !== acceptedAsset.versionId || current.sha256 !== acceptedAsset.digest || current.etag !== acceptedAsset.etag || current.size !== acceptedAsset.size) throw new Error("pinned S3 object version or digest changed");
          } catch (error) {
            throw new AwsError("ValidationError", `${logicalPath}.TemplateURL pinned object s3://${acceptedAsset.bucket}/${acceptedAsset.key}?versionId=${acceptedAsset.versionId} is missing or failed immutable digest validation: ${error instanceof Error ? error.message : String(error)}; owning future requirement: CFN-16`, 400);
          }
          baseAsset = structuredClone(acceptedAsset);
        } else {
          const location = parseLocalS3ObjectUrl(templateUrl, this.region);
          let owner: string | undefined;
          try { owner = this.s3.bucketOwnerAccountIdInternal(location.bucket); } catch { /* readLocalS3Template returns the public validation error below. */ }
          if (owner && owner !== this.store.accountId) throw new AwsError("ValidationError", `${logicalPath}.TemplateURL bucket ${location.bucket} is owned by account ${owner}, not stack account ${this.store.accountId}; owning future requirement: CFN-16`, 400);
          if (this.authorizeProviderTargets) await this.authorizeProviderTargets(principal, [{ action: location.versionId ? "s3:GetObjectVersion" : "s3:GetObject", resource: `arn:aws:s3:::${location.bucket}/${location.key}` }]);
          const loaded = await readLocalS3Template(this.s3, templateUrl, this.region);
          if (loaded.object.ownerAccountId !== this.store.accountId) throw new AwsError("ValidationError", `${logicalPath}.TemplateURL bucket ${loaded.location.bucket} is owned by account ${loaded.object.ownerAccountId}, not stack account ${this.store.accountId}; owning future requirement: CFN-16`, 400);
          baseAsset = {
            logicalId,
            logicalPath,
            templateUrl,
            body: loaded.body,
            digest: createHash("sha256").update(loaded.body).digest("hex"),
            bucket: loaded.location.bucket,
            key: loaded.location.key,
            versionId: loaded.object.versionId,
            etag: loaded.object.etag,
            size: loaded.object.size,
            ...(sourceDigest ? { sourceDigest } : {}),
          };
        }

        let parsed: ParsedTemplate;
        try { parsed = await this.templateFromBody(baseAsset.body); }
        catch (error) { throw new AwsError("ValidationError", `${logicalPath}: ${error instanceof Error ? error.message : String(error)}; owning future requirement: CFN-16`, 400); }
        addTemplateLimits(parsed.value, parsed.digest, baseAsset.size, logicalPath);
        const versionKey = `${baseAsset.bucket}\0${baseAsset.key}\0${baseAsset.versionId}`;
        if (activeTemplates.has(versionKey)) throw new AwsError("ValidationError", `${logicalPath} forms a recursive nested-template cycle through s3://${baseAsset.bucket}/${baseAsset.key}?versionId=${baseAsset.versionId}; owning future requirement: CFN-16`, 400);

        const childName = baseAsset.childStackName ?? this.nestedStackName({ stackId: parent.stackId, stackName: parent.stackName } as CloudFormationStackState, logicalId);
        const existingResource = parent.previousResources[logicalId];
        const existingChild = existingResource?.physicalResourceId ? this.state.stacks[existingResource.physicalResourceId] : undefined;
        const childStackId = existingChild?.stackId ?? baseAsset.childStackId ?? `arn:aws:cloudformation:${this.region}:${this.store.accountId}:stack/${childName}/${randomUUID()}`;
        if (baseAsset.childStackId && existingChild && baseAsset.childStackId !== existingChild.stackId) throw new AwsError("ValidationError", `${logicalPath} immutable admission artifact targets a different child stack; owning future requirement: CFN-16`, 400);

        const rawParameters = definition.Properties?.Parameters;
        if (rawParameters !== undefined && (!rawParameters || typeof rawParameters !== "object" || Array.isArray(rawParameters))) throw new AwsError("ValidationError", `${logicalPath}.Parameters must be an object; owning future requirement: CFN-16`, 400);
        const suppliedParameters = Object.entries((rawParameters ?? {}) as Record<string, unknown>).map(([parameterKey, raw]) => {
          try {
            const value = evaluateIntrinsicValue(raw, currentEvaluation as any, `$.Resources.${logicalId}.Properties.Parameters.${parameterKey}`);
            if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("nested stack parameters must resolve to scalar strings");
            return { parameterKey, parameterValue: String(value) };
          } catch { return { parameterKey, parameterValue: deferredParameterValue(logicalPath, parameterKey, raw) }; }
        });
        let resolved: ResolvedParameters;
        try { resolved = resolveTemplateParameters(parsed.value.Parameters, suppliedParameters, { resolveSsmParameter: (name, type) => this.resolveBootstrapSsmParameter(name, type) }); }
        catch (error) { throw new AwsError("ValidationError", `${logicalPath}: ${error instanceof Error ? error.message : String(error)}; owning future requirement: CFN-16`, 400); }
        const notifications = evaluatedProperties?.NotificationARNs ? [...evaluatedProperties.NotificationARNs] : [];
        const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, childStackId, childName), "AWS::NotificationARNs": notifications };
        const availableExports = this.exportValues();
        let childConditions: Record<string, boolean>;
        let childProcessed: CloudFormationTemplate;
        try {
          childConditions = evaluateTemplateConditions(parsed.value, resolved.values, pseudos, availableExports);
          validateTemplateRules(parsed.value, resolved.values, pseudos, childConditions, availableExports);
          childProcessed = conditionallyProcessedTemplate(parsed.value, childConditions);
          buildResourceDependencyGraph(childProcessed);
        } catch (error) { throw new AwsError("ValidationError", `${logicalPath}: ${error instanceof Error ? error.message : String(error)}; owning future requirement: CFN-16`, 400); }
        const childTags = { ...parent.tags, ...Object.fromEntries((evaluatedProperties?.Tags ?? []).map(tag => [tag.Key, tag.Value])) };
        const nodeIndex = nodes.length;
        nodes.push(undefined);
        activeTemplates.add(versionKey);
        const childEvaluation = { parameters: resolved.values, pseudoParameters: pseudos, mappings: childProcessed.Mappings, conditions: childConditions, resourceRefs: {}, resourceAttributes: {}, imports: availableExports };
        const childManifest = await discover(childProcessed, childEvaluation, { stackId: childStackId, stackName: childName, logicalPath, tags: childTags, previousResources: existingChild?.resources ?? {} }, baseAsset.nestedTemplateManifest);
        activeTemplates.delete(versionKey);
        const asset: NestedTemplateAsset = {
          ...baseAsset,
          logicalPath,
          childStackId,
          childStackName: childName,
          outputs: Object.keys(childProcessed.Outputs ?? {}).sort(),
          nestedTemplateManifest: childManifest,
        };
        assets.push(asset);
        nodes[nodeIndex] = { logicalPath, stackId: childStackId, stackName: childName, template: childProcessed, parameters: resolved.values, pseudoParameters: pseudos, conditions: childConditions, tags: childTags, previousResources: existingChild?.resources ?? {}, manifest: childManifest };
      }
      return { schemaVersion: 2, assets };
    };

    const manifest = await discover(template, evaluation, { stackId: rootStackId, stackName: rootStackName, logicalPath: admission?.logicalPath, tags: admission?.tags ?? {}, previousResources: admission?.previousResources ?? {} }, acceptedManifest);
    const completeNodes = nodes.filter((node): node is RecursiveAdmissionNode => node !== undefined);
    let admissionFailure: string | undefined;
    try {
      for (const node of completeNodes) this.validateRecursiveAdmissionNode(node, principal, capabilities, deferredParameterValues);
      this.validateNestedOutputReferences(template, manifest, admission?.logicalPath);
      for (const node of completeNodes) this.validateNestedOutputReferences(node.template, node.manifest, node.logicalPath);
    } catch (error) {
      admissionFailure = error instanceof Error ? error.message : String(error);
    }
    const completeManifest: NestedTemplateManifest = {
      ...manifest,
      totalResources,
      totalTemplates,
      uniqueTemplateBytes: [...uniqueTemplates.values()].reduce((sum, value) => sum + value, 0),
      ...(admissionFailure ? { admissionFailure } : {}),
    };
    await this.journal.replaceJsonArtifact("plans", `${artifactId}.nested-templates.json`, completeManifest);
    return completeManifest;
  }

  private recursiveAdmissionRequirement(typeName: string): string {
    if (typeName === "AWS::SSM::Parameter" || typeName === "AWS::StepFunctions::StateMachine" || typeName === "AWS::CloudFormation::CustomResource" || typeName.startsWith("Custom::")) return "AMX-04 infrastructure execution";
    if (typeName === "AWS::AppSync::FunctionConfiguration" || typeName === "AWS::AppSync::Resolver") return "AMX-05 executable AppSync pipelines";
    if (typeName.startsWith("AWS::AppSync::")) return "AMX-06 authorization, outputs, and frontend contract";
    return "a later owning CloudFormation requirement";
  }

  private validateRecursiveAdmissionNode(node: RecursiveAdmissionNode, principal: PrincipalContext, capabilities: readonly string[], deferredParameterValues: ReadonlySet<string>): void {
    const graph = buildResourceDependencyGraph(node.template);
    for (const logicalId of graph.order) {
      const typeName = node.template.Resources[logicalId].Type;
      const exactCustomHelper = typeName.startsWith("Custom::") && !this.providers.has(typeName);
      if (!this.providers.get(typeName) || exactCustomHelper) {
        const subject = exactCustomHelper ? `custom-resource helper ${typeName}` : `resource type ${typeName}`;
        throw new AwsError("ValidationError", `${node.logicalPath}/${logicalId}: Unrecognized ${subject} during recursive admission; owning future requirement: ${this.recursiveAdmissionRequirement(typeName)}`, 400);
      }
    }
    try {
      this.assertCapabilities(node.template, capabilities);
      this.validateOpeningResources(node.template, node.stackId, `admission-${createHash("sha256").update(node.stackId).digest("hex").slice(0, 24)}`, principal);
      this.validateProviderReferences(node.template);
      this.preflightProviderModels(node.template, { parameters: node.parameters, pseudoParameters: node.pseudoParameters, mappings: node.template.Mappings, conditions: node.conditions, imports: this.exportValues() }, node.stackId, `admission-${createHash("sha256").update(node.stackId).digest("hex").slice(0, 24)}`, principal, node.tags, node.previousResources, deferredParameterValues);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedLogicalId = message.match(/^([^:]+):/)?.[1];
      const failedType = failedLogicalId ? node.template.Resources[failedLogicalId]?.Type : undefined;
      const mentionedType = message.match(/AWS::[A-Za-z0-9:]+|Custom::[A-Za-z0-9_-]+/)?.[0];
      const owner = this.recursiveAdmissionRequirement(failedType ?? mentionedType ?? "");
      throw new AwsError("ValidationError", `${node.logicalPath}: ${message}; owning future requirement: ${owner}`, 400);
    }
  }

  private validateNestedOutputReferences(template: CloudFormationTemplate, manifest: NestedTemplateManifest, logicalPath?: string): void {
    const children = new Map(manifest.assets.map(asset => [asset.logicalId, asset]));
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      const getAtt = record["Fn::GetAtt"];
      const separator = typeof getAtt === "string" ? getAtt.indexOf(".") : -1;
      const parts = typeof getAtt === "string" && separator > 0 ? [getAtt.slice(0, separator), getAtt.slice(separator + 1)] : Array.isArray(getAtt) && getAtt.length === 2 ? getAtt.map(String) : undefined;
      if (parts) {
        const child = children.get(parts[0]);
        if (child && parts[1].startsWith("Outputs.")) {
          const output = parts[1].slice("Outputs.".length);
          if (!child.outputs?.includes(output)) throw new AwsError("ValidationError", `${logicalPath ? `${logicalPath}/` : ""}${parts[0]}: ${path} references missing authoritative child output ${output}; owning future requirement: CFN-16`, 400);
        }
      }
      for (const [key, item] of Object.entries(record)) visit(item, `${path}.${key}`);
    };
    for (const [logicalId, resource] of Object.entries(template.Resources)) visit(resource.Properties ?? {}, `$.Resources.${logicalId}.Properties`);
    for (const [logicalId, output] of Object.entries(template.Outputs ?? {})) { visit(output.Value, `$.Outputs.${logicalId}.Value`); if (output.Export) visit(output.Export.Name, `$.Outputs.${logicalId}.Export.Name`); }
  }

  private async pinEvaluatedFileAsset(
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>,
    templateArtifactId: string,
    operationId: string,
    principal: PrincipalContext,
  ): Promise<Record<string, unknown>> {
    const propertyPath = resourceType === "AWS::Lambda::Function" ? "Code"
      : resourceType === "AWS::Lambda::LayerVersion" ? "Content"
        : resourceType === "AWS::ApiGateway::RestApi" ? "BodyS3Location"
          : resourceType === "Custom::CDKBucketDeployment" ? "SourceObjectKeys"
            : undefined;
    if (!propertyPath) return properties;
    if (propertyPath === "SourceObjectKeys") {
      const sourceBuckets = properties.SourceBucketNames;
      const sourceKeys = properties.SourceObjectKeys;
      if (!Array.isArray(sourceBuckets) || sourceBuckets.length !== 1 || typeof sourceBuckets[0] !== "string" || !sourceBuckets[0]
        || !Array.isArray(sourceKeys) || sourceKeys.length !== 1 || typeof sourceKeys[0] !== "string" || !sourceKeys[0]) return properties;
      const templateManifest = await this.journal.readJsonArtifact<CloudFormationAssetManifest>("assets", `${templateArtifactId}.json`);
      const accepted = templateManifest?.references?.find(candidate => candidate.logicalId === logicalId && candidate.propertyPath === propertyPath);
      const reference = await this.readAssetReference(logicalId, resourceType, propertyPath, sourceBuckets[0], sourceKeys[0], principal, accepted?.versionId);
      if (!reference) throw new AwsError("ValidationError", `${logicalId}.${propertyPath} local S3 asset is missing`, 400);
      await this.assertAndCheckpointAssetReference(reference, templateArtifactId, operationId);
      return properties;
    }
    const location = properties[propertyPath];
    if (!location || typeof location !== "object" || Array.isArray(location)) return properties;
    const input = location as Record<string, unknown>;
    const bucket = propertyPath === "Code" || propertyPath === "Content" ? input.S3Bucket : input.Bucket;
    const key = propertyPath === "Code" || propertyPath === "Content" ? input.S3Key : input.Key;
    const requestedVersion = propertyPath === "Code" || propertyPath === "Content" ? input.S3ObjectVersion : input.Version;
    if (typeof bucket !== "string" || !bucket || typeof key !== "string" || !key) return properties;
    if (requestedVersion !== undefined && typeof requestedVersion !== "string") throw new AwsError("ValidationError", `${logicalId}.${propertyPath} asset version must resolve to a string`, 400);
    const reference = await this.readAssetReference(logicalId, resourceType, propertyPath, bucket, key, principal, requestedVersion);
    if (!reference) throw new AwsError("ValidationError", `${logicalId}.${propertyPath} local S3 asset is missing`, 400);
    await this.assertAndCheckpointAssetReference(reference, templateArtifactId, operationId);
    const pinned = structuredClone(properties); const target = pinned[propertyPath] as Record<string, unknown>;
    if (propertyPath === "Code" || propertyPath === "Content") target.S3ObjectVersion = reference.versionId;
    else target.Version = reference.versionId;
    return pinned;
  }

  private async assertAndCheckpointAssetReference(
    reference: CloudFormationAssetReference,
    templateArtifactId: string,
    operationId: string,
  ): Promise<void> {
    const templateManifest = await this.journal.readJsonArtifact<CloudFormationAssetManifest>("assets", `${templateArtifactId}.json`);
    const expected = templateManifest?.references?.find(candidate => candidate.logicalId === reference.logicalId && candidate.propertyPath === reference.propertyPath);
    if (expected && (expected.bucket !== reference.bucket || expected.key !== reference.key || expected.versionId !== reference.versionId || expected.sha256 !== reference.sha256 || expected.size !== reference.size || expected.etag !== reference.etag)) {
      throw new AwsError("ValidationError", `${reference.logicalId}.${reference.propertyPath} local S3 asset changed after the stack operation accepted it`, 400);
    }
    const operationArtifact = `${operationId}.${reference.logicalId}.${reference.propertyPath}.json`;
    const durable = await this.journal.readJsonArtifact<CloudFormationAssetReference>("assets", operationArtifact);
    if (durable && (durable.bucket !== reference.bucket || durable.key !== reference.key || durable.versionId !== reference.versionId || durable.sha256 !== reference.sha256 || durable.size !== reference.size || durable.etag !== reference.etag)) {
      throw new AwsError("ValidationError", `${reference.logicalId}.${reference.propertyPath} local S3 asset no longer matches its durable operation checkpoint`, 400);
    }
    if (!durable) await this.journal.replaceJsonArtifact("assets", operationArtifact, reference);
  }

  private assetRetentionMs(): number {
    const raw = process.env.STACKSIM_CDK_ASSET_RETENTION_MS;
    if (raw === undefined || raw === "") return 7 * 24 * 60 * 60_000;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("STACKSIM_CDK_ASSET_RETENTION_MS must be a non-negative safe integer");
    return value;
  }

  private armAssetReclaimer(): void {
    if (this.stopping || this.assetReclaimTimer) return;
    const interval = Math.max(60_000, Math.min(60 * 60_000, this.assetRetentionMs() || 60_000));
    this.assetReclaimTimer = this.clock.setTimeout(() => {
      this.assetReclaimTimer = undefined;
      void this.reclaimUnreferencedBootstrapAssets().catch(() => undefined).finally(() => this.armAssetReclaimer());
    }, interval);
  }

  /**
   * Reclaim only immutable versions in the simulator-managed CDK bucket that
   * are older than the retention window and absent from every live template,
   * available change set, active operation checkpoint, or retained resource.
   */
  private async reclaimUnreferencedBootstrapAssets(): Promise<void> {
    const bootstrap = this.state.bootstrap;
    if (!bootstrap || this.assetAdmissions > 0 || Object.values(this.state.changeSets).some(changeSet => changeSet.status === "CREATE_IN_PROGRESS")) return;
    const templateArtifacts = new Set<string>();
    const activeOperationIds = new Set<string>();
    const reachableVersions = new Set<string>();
    const reachableKeys = new Set<string>();
    const versionKey = (bucket: string, key: string, versionId: string) => `${bucket}\0${key}\0${versionId}`;
    const objectKey = (bucket: string, key: string) => `${bucket}\0${key}`;
    const addReference = (bucket: unknown, key: unknown, versionId: unknown): void => {
      if (typeof bucket !== "string" || !bucket || typeof key !== "string" || !key) return;
      if (typeof versionId === "string" && versionId) reachableVersions.add(versionKey(bucket, key, versionId));
      else reachableKeys.add(objectKey(bucket, key));
    };
    const addResourceReference = (resource: CloudFormationStackResourceState): void => {
      if (resource.resourceType === "AWS::Lambda::Function") {
        const code = resource.properties.Code as Record<string, unknown> | undefined;
        if (code && typeof code === "object" && !Array.isArray(code)) addReference(code.S3Bucket, code.S3Key, code.S3ObjectVersion);
      } else if (resource.resourceType === "AWS::Lambda::LayerVersion") {
        const content = resource.properties.Content as Record<string, unknown> | undefined;
        if (content && typeof content === "object" && !Array.isArray(content)) addReference(content.S3Bucket, content.S3Key, content.S3ObjectVersion);
      } else if (resource.resourceType === "AWS::ApiGateway::RestApi") {
        const body = resource.properties.BodyS3Location as Record<string, unknown> | undefined;
        if (body && typeof body === "object" && !Array.isArray(body)) addReference(body.Bucket, body.Key, body.Version);
      }
    };
    const addNestedTemplateReferences = (manifest: NestedTemplateManifest): boolean => {
      if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.assets)) return false;
      for (const asset of manifest.assets) {
        if (!asset || typeof asset !== "object") return false;
        addReference(asset.bucket, asset.key, asset.versionId);
        if (asset.nestedTemplateManifest && !addNestedTemplateReferences(asset.nestedTemplateManifest)) return false;
      }
      return true;
    };

    for (const stack of Object.values(this.state.stacks)) {
      const operationIsRecoverable = stack.activeOperation && (
        stack.activeOperation.status === "PENDING"
        || stack.activeOperation.status === "RUNNING"
        || stack.stackStatus === "CREATE_FAILED"
        || stack.stackStatus === "ROLLBACK_FAILED"
        || stack.stackStatus === "UPDATE_FAILED"
        || stack.stackStatus === "UPDATE_ROLLBACK_FAILED"
        || stack.stackStatus === "DELETE_FAILED"
      );
      const recoverableOperation = operationIsRecoverable ? stack.activeOperation : undefined;
      if (stack.stackStatus !== "DELETE_COMPLETE") {
        if (stack.templateArtifactId) templateArtifacts.add(stack.templateArtifactId);
        // Terminal operations retain their historical artifact identifiers for
        // observability, but those identifiers are not rollback roots. The
        // current stack artifact and resource models below are authoritative.
        if (recoverableOperation?.desiredTemplateArtifactId) templateArtifacts.add(recoverableOperation.desiredTemplateArtifactId);
        if (recoverableOperation?.previousTemplateArtifactId) templateArtifacts.add(recoverableOperation.previousTemplateArtifactId);
      }
      if (recoverableOperation) {
        activeOperationIds.add(recoverableOperation.operationId);
        if (recoverableOperation.rollbackSourceOperationId) activeOperationIds.add(recoverableOperation.rollbackSourceOperationId);
      }
      for (const resource of Object.values(stack.resources)) if (stack.stackStatus !== "DELETE_COMPLETE" || resource.resourceStatus === "DELETE_SKIPPED") addResourceReference(resource);
    }
    for (const changeSet of Object.values(this.state.changeSets)) {
      if (!changeSet.templateArtifactId) continue;
      if (changeSet.status === "CREATE_IN_PROGRESS" || (changeSet.status === "CREATE_COMPLETE" && (changeSet.executionStatus === "AVAILABLE" || changeSet.executionStatus === "EXECUTE_IN_PROGRESS"))) templateArtifacts.add(changeSet.templateArtifactId);
    }
    for (const artifactId of templateArtifacts) {
      const manifest = await this.journal.readJsonArtifact<CloudFormationAssetManifest>("assets", `${artifactId}.json`);
      if (manifest !== undefined && (manifest.schemaVersion !== 1 || !Array.isArray(manifest.references))) return;
      for (const reference of manifest?.references ?? []) addReference(reference.bucket, reference.key, reference.versionId);
      const templateSource = await this.journal.readJsonArtifact<TemplateSourceArtifact>("plans", `${artifactId}.template-source.json`);
      if (templateSource !== undefined) {
        if (!templateSource || typeof templateSource !== "object") return;
        addReference(templateSource.bucket, templateSource.key, templateSource.versionId);
      }
      const nestedTemplates = await this.journal.readJsonArtifact<NestedTemplateManifest>("plans", `${artifactId}.nested-templates.json`);
      if (nestedTemplates !== undefined && !addNestedTemplateReferences(nestedTemplates)) return;
    }
    for (const artifactName of await this.journal.listArtifacts("assets")) {
      if (![...activeOperationIds].some(operationId => artifactName.startsWith(`${operationId}.`))) continue;
      const reference = await this.journal.readJsonArtifact<CloudFormationAssetReference>("assets", artifactName);
      if (!reference || typeof reference !== "object") return;
      addReference(reference.bucket, reference.key, reference.versionId);
    }

    const cutoff = this.clock.now() - this.assetRetentionMs();
    for (const version of await this.s3.listObjectVersionsInternal(bootstrap.bucketName)) {
      if (version.lastModified > cutoff || reachableKeys.has(objectKey(bootstrap.bucketName, version.key)) || reachableVersions.has(versionKey(bootstrap.bucketName, version.key, version.versionId))) continue;
      await this.s3.deleteObjectVersionInternal(bootstrap.bucketName, version.key, version.versionId);
    }
  }

  private validateOpeningResources(template: CloudFormationTemplate, stackId: string, operationId: string, principal: PrincipalContext): void {
    const unknownTypes = [...new Set(Object.values<any>(template.Resources ?? {}).map(definition => String(definition.Type)).filter(typeName => !this.providers.get(typeName)))].sort();
    if (unknownTypes.length === 1) throw new AwsError("ValidationError", `Unrecognized resource type ${unknownTypes[0]}; support is assigned to a later CloudFormation phase`, 400);
    if (unknownTypes.length > 1) throw new AwsError("ValidationError", `Unrecognized resource types: ${unknownTypes.join(", ")}; support is assigned to later CloudFormation phases`, 400);
    for (const [logicalId, definition] of Object.entries<any>(template.Resources ?? {})) {
      const provider = this.providers.require(definition.Type);
      const properties = definition.Properties ?? {}; const issues = validateDeclaredProperties(properties, provider.schema).filter(issue => {
        if (issue.code !== "InvalidType") return true; const propertyName = issue.path.match(/^Properties\.([^.]+)/)?.[1]; return !propertyName || !isIntrinsicExpression((properties as Record<string, unknown>)[propertyName]);
      }); if (issues.length) throw new AwsError("ValidationError", issues.map(issue => `${logicalId}.${issue.path}: ${issue.message}`).join("; "), 400);
      // Standalone RDS DB instances default to a real RDS-03 final snapshot.
      const deletionPolicy = definition.DeletionPolicy ?? (definition.Type === "AWS::RDS::DBInstance" ? "Snapshot" : "Delete"); if (!provider.schema.retention.deletionPolicies.includes(deletionPolicy)) throw new AwsError("ValidationError", `${definition.Type} does not support DeletionPolicy ${deletionPolicy}`, 400);
      const updateReplacePolicy = definition.UpdateReplacePolicy ?? "Delete"; if (!provider.schema.retention.updateReplacePolicies.includes(updateReplacePolicy)) throw new AwsError("ValidationError", `${definition.Type} does not support UpdateReplacePolicy ${updateReplacePolicy}`, 400);
    }
  }

  /**
   * Run the provider's full pure validation/canonicalization/plan contract for
   * every desired model whose intrinsic dependencies are already resolvable.
   * Resource-dependent additions are validated later when their dependency has
   * a physical model, but literal and existing-resource graphs are rejected
   * before a stack operation or AVAILABLE change set can mutate a service.
   */
  private preflightProviderModels(
    template: CloudFormationTemplate,
    evaluation: { parameters: Record<string, unknown>; pseudoParameters: Record<string, unknown>; mappings?: Record<string, any>; conditions: Record<string, boolean>; imports: Record<string, unknown> },
    stackId: string,
    operationId: string,
    principal: PrincipalContext,
    stackTags: Record<string, string>,
    previousResources: Record<string, CloudFormationStackResourceState> = {},
    deferredParameterValues: ReadonlySet<string> = new Set(),
  ): Record<string, PreflightResourceModel> {
    const planned: Record<string, PreflightResourceModel> = {};
    const resourceRefs: Record<string, unknown> = {};
    const resourceAttributes: Record<string, Record<string, unknown>> = {};
    for (const [logicalId, resource] of Object.entries(previousResources)) {
      if (resource.refValue !== undefined) resourceRefs[logicalId] = resource.refValue;
      resourceAttributes[logicalId] = resource.attributes;
    }
    const graph = buildResourceDependencyGraph(template);
    const resourceLogicalIds = Object.keys(template.Resources);
    for (const logicalId of graph.order) {
      const definition = template.Resources[logicalId];
      const references = collectIntrinsicReferences(definition.Properties ?? {}, { resourceLogicalIds, parameters: evaluation.parameters });
      if (references.resourceDependencies.some(dependency => !Object.hasOwn(resourceAttributes, dependency) && !Object.hasOwn(resourceRefs, dependency))) continue;
      const context = { ...evaluation, resourceRefs, resourceAttributes };
      try {
        const evaluated = evaluateIntrinsicValue(definition.Properties ?? {}, context, `$.Resources.${logicalId}.Properties`) as Record<string, unknown>;
        const metadata = evaluateIntrinsicValue(definition.Metadata ?? {}, context, `$.Resources.${logicalId}.Metadata`) as Record<string, unknown>;
        const provider = this.providers.require(definition.Type);
        const properties = this.mergeStackTags(provider, evaluated, stackTags);
        if (containsDynamicReference(properties)) continue;
        const providerContext = this.providerContext(stackId, logicalId, operationId, principal, undefined, "preflight");
        const issues = provider.validate(properties, providerContext);
        // Recursive discovery may know the shape of a descendant resource before
        // a parent resource has produced the value passed into that descendant.
        // Its opaque marker is not a candidate service value: value-dependent
        // provider validation is repeated with the authoritative value at normal
        // create/update execution.  Literal models remain fully preflighted.
        const containsDeferredParameter = (value: unknown): boolean => {
          if (typeof value === "string") return [...deferredParameterValues].some(marker => value.includes(marker));
          if (Array.isArray(value)) return value.some(containsDeferredParameter);
          return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsDeferredParameter));
        };
        if (containsDeferredParameter(properties)) continue;
        if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
        const desired = provider.canonicalize(properties, providerContext) as Record<string, unknown>;
        const previousState = previousResources[logicalId];
        const previous = previousState?.resourceType === definition.Type ? provider.canonicalize(previousState.properties, providerContext) : undefined;
        const providerPlan = provider.plan(previous, desired, providerContext);
        planned[logicalId] = {
          properties: structuredClone(desired),
          metadata: structuredClone(metadata),
          plan: {
            action: providerPlan.action,
            changedProperties: [...providerPlan.changedProperties],
            replacementProperties: [...providerPlan.replacementProperties],
          },
        };
      } catch (error) {
        throw new AwsError("ValidationError", `${logicalId}: ${error instanceof Error ? error.message : String(error)}`, 400);
      }
    }
    return planned;
  }

  private validateProviderReferences(template: CloudFormationTemplate): void {
    for (const found of collectDynamicReferences(template)) {
      const match = found.path.match(/^\$\.Resources\.([A-Za-z0-9]+)\.Properties\.([A-Za-z0-9]+)/);
      if (!match) throw new AwsError("ValidationError", `Dynamic reference is in an unsupported location ${found.path}`, 400);
      const [, logicalId, propertyName] = match;
      const typeName = template.Resources[logicalId]?.Type;
      if (!typeName) continue;
      const provider = this.providers.require(typeName);
      if (found.reference.secret) {
        if (typeName === "AWS::CloudFormation::CustomResource" || typeName.startsWith("Custom::")) throw new AwsError("ValidationError", `Secure dynamic references are not supported in custom resources at ${found.path}`, 400);
        if (provider.schema.properties[propertyName]?.updateBehavior === "REPLACEMENT") throw new AwsError("ValidationError", `Secure dynamic references cannot contribute to a primary identifier at ${found.path}`, 400);
        const reviewedDestination = typeName === RDS_DB_INSTANCE_TYPE && propertyName === "MasterUserPassword"
          || typeName === SECRETS_MANAGER_SECRET_TYPE && propertyName === "SecretString";
        if (!reviewedDestination) throw new AwsError("ValidationError", `Secure dynamic reference destination ${typeName}.${propertyName} has no reviewed protected-storage contract`, 400);
      }
    }
    const context = { resourceLogicalIds: Object.keys(template.Resources), parameters: Object.fromEntries(Object.keys(template.Parameters ?? {}).map(name => [name, undefined])) };
    const values: Array<[string, unknown]> = [];
    for (const [logicalId, resource] of Object.entries(template.Resources)) values.push([`Resource ${logicalId}`, resource.Properties ?? {}], [`Resource ${logicalId} metadata`, resource.Metadata ?? {}]);
    for (const [logicalId, output] of Object.entries(template.Outputs ?? {})) { values.push([`Output ${logicalId}`, output.Value]); if (output.Export) values.push([`Output ${logicalId} export`, output.Export.Name]); }
    for (const [label, value] of values) {
      const references = collectIntrinsicReferences(value, context);
      for (const name of references.refs) if (template.Resources[name] && !this.providers.require(template.Resources[name].Type).schema.ref.supported) throw new AwsError("ValidationError", `${label} uses Ref for ${name}, but ${template.Resources[name].Type} does not expose Ref`, 400);
      for (const reference of references.getAtts) {
        const target = template.Resources[reference.logicalId]; if (target) { const schema = this.providers.require(target.Type).schema; if (reference.attribute.startsWith("__stackSim")) throw new AwsError("ValidationError", `${label} requests reserved attribute ${reference.logicalId}.${reference.attribute}`, 400); const nestedOutput = target.Type === CLOUDFORMATION_NESTED_STACK_TYPE && /^Outputs\.[A-Za-z0-9]+$/.test(reference.attribute); if (!nestedOutput && !schema.additionalAttributes && !Object.hasOwn(schema.attributes, reference.attribute)) throw new AwsError("ValidationError", `${label} requests unsupported attribute ${reference.logicalId}.${reference.attribute}`, 400); }
      }
    }
  }

  private requiredCapabilities(template: CloudFormationTemplate): string[] {
    const iamResources = Object.values(template.Resources).filter(resource => resource.Type.startsWith("AWS::IAM::"));
    if (!iamResources.length) return [];
    const namedProperties: Readonly<Record<string, string>> = {
      "AWS::IAM::Role": "RoleName",
      "AWS::IAM::ManagedPolicy": "ManagedPolicyName",
      "AWS::IAM::Policy": "PolicyName",
      "AWS::IAM::User": "UserName",
      "AWS::IAM::Group": "GroupName",
      "AWS::IAM::InstanceProfile": "InstanceProfileName",
    };
    return iamResources.some(resource => {
      const propertyName = namedProperties[resource.Type];
      return propertyName !== undefined && resource.Properties?.[propertyName] !== undefined;
    }) ? ["CAPABILITY_NAMED_IAM"] : ["CAPABILITY_IAM"];
  }

  private assertCapabilities(template: CloudFormationTemplate, supplied: readonly string[]): void {
    const known = new Set(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"]);
    if (supplied.some(capability => !known.has(capability))) throw new AwsError("ValidationError", "Capabilities contains an invalid value", 400);
    const missing = this.requiredCapabilities(template).filter(capability => capability === "CAPABILITY_IAM"
      ? !supplied.includes("CAPABILITY_IAM") && !supplied.includes("CAPABILITY_NAMED_IAM")
      : !supplied.includes(capability));
    if (missing.length) throw new AwsError("InsufficientCapabilitiesException", `Requires capabilities : [${missing.join(", ")}]`, 400);
  }

  private mergeStackTags(provider: CloudFormationResourceProvider<any>, properties: Record<string, unknown>, stackTags: Readonly<Record<string, string>>): Record<string, unknown> {
    if (provider.schema.tags.behavior !== "STACK_AND_RESOURCE") return properties;
    const propertyName = provider.schema.tags.propertyName!;
    const current = properties[propertyName];
    const currentIsObject = current !== undefined && current !== null && typeof current === "object" && !Array.isArray(current);
    const objectShape = provider.schema.properties[propertyName]?.valueType === "object" || currentIsObject;
    const resourceTags = Array.isArray(current)
      ? current as Array<Record<string, unknown>>
      : currentIsObject
        ? Object.entries(current as Record<string, unknown>).map(([Key, Value]) => ({ Key, Value }))
        : [];
    const merged = new Map(Object.entries(stackTags));
    for (const tag of resourceTags) if (tag && typeof tag.Key === "string") merged.set(tag.Key, String(tag.Value ?? ""));
    return {
      ...properties,
      [propertyName]: objectShape
        ? Object.fromEntries([...merged].sort(([left], [right]) => left.localeCompare(right)))
        : [...merged].sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })),
    };
  }

  private exportValues(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.state.exports).map(([name, value]) => [name, value.value]));
  }

  private plannedImportNames(template: CloudFormationTemplate, parameters: Readonly<Record<string, unknown>>, pseudoParameters: Readonly<Record<string, unknown>>, conditions: Readonly<Record<string, boolean>>, stackId: string, availableExports = this.exportValues()): string[] {
    const names = collectImportValueNames(template, { parameters, pseudoParameters, mappings: template.Mappings, conditions, imports: availableExports });
    for (const name of names) if (this.state.exports[name]?.exportingStackId === stackId) throw new AwsError("ValidationError", `Stack ${stackId} cannot import its own export ${name}`, 400);
    return names;
  }

  private activeImporters(exportName: string, excludingStackId?: string): CloudFormationStackState[] {
    return (this.state.exports[exportName]?.importingStackIds ?? []).filter(stackId => stackId !== excludingStackId).map(stackId => this.state.stacks[stackId]).filter((stack): stack is CloudFormationStackState => Boolean(stack && stack.stackStatus !== "DELETE_COMPLETE"));
  }

  private assertStackExportsDeletable(stack: CloudFormationStackState): void {
    for (const [name, value] of Object.entries(this.state.exports)) {
      if (value.exportingStackId !== stack.stackId) continue;
      const importers = this.activeImporters(name, stack.stackId);
      if (importers.length) throw new AwsError("ValidationError", `Export ${name} cannot be deleted as it is in use by ${importers.map(importer => importer.stackName).sort().join(", ")}`, 400);
    }
  }

  private reconcileStackCatalog(stack: CloudFormationStackState, outputs: CloudFormationOutputState[], importNames: readonly string[]): void {
    const next = new Map<string, string>();
    for (const output of outputs) {
      if (output.exportName === undefined) continue;
      if (next.has(output.exportName)) throw new Error(`Stack ${stack.stackName} defines duplicate export ${output.exportName}`);
      next.set(output.exportName, output.outputValue);
    }
    for (const [name, value] of next) {
      const existing = this.state.exports[name];
      if (existing && existing.exportingStackId !== stack.stackId) throw new Error(`Export with name ${name} is already exported by stack ${this.state.stacks[existing.exportingStackId]?.stackName ?? existing.exportingStackId}`);
      if (existing && existing.value !== value) { const importers = this.activeImporters(name, stack.stackId); if (importers.length) throw new Error(`Export ${name} cannot be updated as it is in use by ${importers.map(importer => importer.stackName).sort().join(", ")}`); }
    }
    for (const [name, existing] of Object.entries(this.state.exports)) {
      if (existing.exportingStackId !== stack.stackId || next.has(name)) continue;
      const importers = this.activeImporters(name, stack.stackId); if (importers.length) throw new Error(`Export ${name} cannot be deleted as it is in use by ${importers.map(importer => importer.stackName).sort().join(", ")}`);
    }
    for (const value of Object.values(this.state.exports)) value.importingStackIds = value.importingStackIds.filter(stackId => stackId !== stack.stackId);
    for (const [name, existing] of Object.entries(this.state.exports)) if (existing.exportingStackId === stack.stackId && !next.has(name)) delete this.state.exports[name];
    for (const [name, value] of next) { const existing = this.state.exports[name]; this.state.exports[name] = { name, value, exportingStackId: stack.stackId, importingStackIds: [...(existing?.importingStackIds ?? [])] }; }
    for (const name of importNames) { const exported = this.state.exports[name]; if (!exported) throw new Error(`No export named ${name} found`); if (!exported.importingStackIds.includes(stack.stackId)) exported.importingStackIds.push(stack.stackId); exported.importingStackIds.sort(); }
  }

  private removeStackCatalogLinks(stack: CloudFormationStackState): void {
    for (const value of Object.values(this.state.exports)) value.importingStackIds = value.importingStackIds.filter(stackId => stackId !== stack.stackId);
    for (const [name, value] of Object.entries(this.state.exports)) if (value.exportingStackId === stack.stackId) delete this.state.exports[name];
  }

  private changeSetKey(stackId: string, changeSetName: string): string { return `${stackId}\0${changeSetName}`; }

  private changeSet(identifier: string, stackIdentifier?: string, includeDeleted = false): CloudFormationChangeSetState {
    let value = this.state.changeSets[identifier];
    if (!value && stackIdentifier) { const stack = this.stack(stackIdentifier, true); value = this.state.changeSets[this.state.changeSetNames[this.changeSetKey(stack.stackId, identifier)]]; }
    if (!value && !stackIdentifier) {
      const matches = Object.values(this.state.changeSets).filter(candidate => candidate.changeSetName === identifier && (includeDeleted || candidate.status !== "DELETE_COMPLETE"));
      if (matches.length === 1) value = matches[0];
      else if (matches.length > 1) throw new AwsError("ValidationError", `Change set name ${identifier} is ambiguous; specify StackName`, 400);
    }
    if (!value || (!includeDeleted && value.status === "DELETE_COMPLETE")) throw new AwsError("ChangeSetNotFound", `ChangeSet ${identifier || "(missing)"} does not exist`, 404);
    return value;
  }

  private changeSetSummary(value: CloudFormationChangeSetState): any {
    return { StackId: value.stackId, StackName: value.stackName, ChangeSetId: value.changeSetId, ChangeSetName: value.changeSetName, ExecutionStatus: value.executionStatus, Status: value.status, StatusReason: value.statusReason, CreationTime: new Date(value.creationTime), Description: value.description, IncludeNestedStacks: value.includeNestedStacks ?? false, ParentChangeSetId: value.parentChangeSetId, RootChangeSetId: value.rootChangeSetId };
  }

  private changeSetBaselineDigest(stack: CloudFormationStackState): string {
    return createHash("sha256").update(canonical({
      stackId: stack.stackId,
      stackStatus: stack.stackStatus,
      templateDigest: stack.templateDigest,
      processedTemplateDigest: stack.processedTemplateDigest,
      parameters: stack.parameters,
      tags: stack.tags,
      capabilities: stack.capabilities,
      notificationArns: stack.notificationArns,
      roleArn: stack.roleArn,
      resources: stack.resources,
    })).digest("hex");
  }

  private async resumeChangeSetPlanning(value: CloudFormationChangeSetState): Promise<void> {
    if (value.status !== "CREATE_IN_PROGRESS") return;
    try {
      const artifactId = value.templateArtifactId;
      if (!artifactId) throw new Error("Durable change set planning input is unavailable (missing artifact identifier)");
      const planning = await this.journal.readJsonArtifact<ChangeSetPlanningArtifact>("change-sets", `${artifactId}.planning.json`);
      if (!planning || planning.schemaVersion !== 1 || !planning.input || typeof planning.input !== "object" || !planning.principal || typeof planning.planningOperationId !== "string" || typeof planning.baselineDigest !== "string" || !planning.availableExports || typeof planning.availableExports !== "object") {
        throw new Error("Durable change set planning input is unavailable or invalid");
      }
      const input: any = structuredClone(planning.input);
      const stack = this.state.stacks[value.stackId];
      if (!stack) throw new Error(`Stack ${value.stackName} no longer exists`);
      if (this.changeSetBaselineDigest(stack) !== planning.baselineDigest) throw new Error(`Stack ${value.stackName} changed before change set planning could be recovered`);
      if (input.UsePreviousTemplate === true && (input.TemplateBody !== undefined || input.TemplateURL !== undefined)) throw new AwsError("ValidationError", "UsePreviousTemplate cannot be combined with TemplateBody or TemplateURL", 400);
      if (value.changeSetType === "CREATE" && input.UsePreviousTemplate === true) throw new AwsError("ValidationError", "CREATE change sets cannot use a previous template", 400);
      const desiredRoleArn = input.RoleARN ?? stack.roleArn;
      const executionPrincipal = await this.operationPrincipal(desiredRoleArn, planning.planningOperationId, planning.principal);
      const parsed = input.UsePreviousTemplate === true ? await this.templateFromBody(await this.localTemplate(stack.stackId)) : await this.template(input, executionPrincipal);
      const suppliedParameterInputs = parameters(input.Parameters);
      const previousValues = Object.fromEntries(stack.parameters.filter(parameter => parameter.parameterValue !== undefined).map(parameter => [parameter.parameterKey, parameter.parameterValue!]));
      if (value.changeSetType === "UPDATE") {
        const supplied = new Set(suppliedParameterInputs.map(parameter => parameter.parameterKey));
        for (const name of Object.keys(parsed.value.Parameters ?? {})) if (!supplied.has(name) && previousValues[name] !== undefined) suppliedParameterInputs.push({ parameterKey: name, usePreviousValue: true });
      }
      const notificationArns = input.NotificationARNs === undefined ? [...stack.notificationArns] : this.normalizedNotificationArns(input.NotificationARNs);
      const rollbackConfiguration = this.normalizedRollbackConfiguration(input.RollbackConfiguration, value.changeSetType === "UPDATE" ? stack.rollbackConfiguration : undefined);
      const capabilities = input.Capabilities === undefined ? [...stack.capabilities] : list<string>(input.Capabilities).map(String);
      const desiredTags = input.Tags === undefined ? structuredClone(stack.tags) : tags(input.Tags);
      await this.authorizeTypedSsmParameters(parsed.value, suppliedParameterInputs, executionPrincipal, value.changeSetType === "UPDATE" ? previousValues : {});
      const resolvedParameters = resolveTemplateParameters(parsed.value.Parameters, suppliedParameterInputs, { previous: value.changeSetType === "UPDATE" ? previousValues : undefined, resolveSsmParameter: (name, type) => this.resolveBootstrapSsmParameter(name, type) });
      const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, stack.stackId, stack.stackName), "AWS::NotificationARNs": notificationArns };
      const conditions = evaluateTemplateConditions(parsed.value, resolvedParameters.values, pseudos, planning.availableExports);
      validateTemplateRules(parsed.value, resolvedParameters.values, pseudos, conditions, planning.availableExports);
      let processed = conditionallyProcessedTemplate(parsed.value, conditions);
      const openingEvaluation = { parameters: resolvedParameters.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, resourceRefs: {}, resourceAttributes: {}, imports: planning.availableExports };
      processed = await this.pinStaticFileAssets(processed, openingEvaluation, artifactId, executionPrincipal, true, value.changeSetType === "UPDATE" ? stack.resources : {});
      const nestedTemplateManifest = await this.pinNestedTemplateAssets(processed, openingEvaluation, artifactId, executionPrincipal, undefined, { stackId: stack.stackId, stackName: stack.stackName, capabilities, tags: desiredTags, previousResources: value.changeSetType === "UPDATE" ? stack.resources : {} });
      if (nestedTemplateManifest.admissionFailure) throw new AwsError("ValidationError", nestedTemplateManifest.admissionFailure, 400);
      this.assertCapabilities(processed, capabilities);
      const importNames = this.plannedImportNames(processed, resolvedParameters.values, pseudos, conditions, stack.stackId, planning.availableExports);
      const graph = buildResourceDependencyGraph(processed);
      this.validateOpeningResources(processed, stack.stackId, planning.planningOperationId, executionPrincipal);
      this.validateProviderReferences(processed);
      const processedBody = JSON.stringify(processed);
      const processedDigest = createHash("sha256").update(processedBody).digest("hex");
      const preflightModels = this.preflightProviderModels(processed, { parameters: resolvedParameters.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, imports: planning.availableExports }, stack.stackId, planning.planningOperationId, executionPrincipal, desiredTags, value.changeSetType === "UPDATE" ? stack.resources : {});
      const previousProcessedBody = value.changeSetType === "UPDATE" && stack.templateArtifactId ? await this.journal.readTemplate(stack.templateArtifactId, "processed") : undefined;
      const previousProcessed = previousProcessedBody ? JSON.parse(previousProcessedBody) as CloudFormationTemplate : undefined;
      const changes = this.changeSetPlan(value.changeSetType === "UPDATE" ? stack : undefined, processed, preflightModels, previousProcessed);
      if (value.includeNestedStacks) await this.planLinkedNestedChangeSets(value, value, stack, processed, preflightModels, changes, nestedTemplateManifest, executionPrincipal, capabilities);
      const sameParameters = canonical(resolvedParameters.entries.map(entry => [entry.parameterKey, entry.parameterValue, entry.resolvedValue])) === canonical(stack.parameters.map(entry => [entry.parameterKey, entry.parameterValue, entry.resolvedValue]));
      const noUpdates = value.changeSetType === "UPDATE" && processedDigest === stack.processedTemplateDigest && sameParameters && canonical(desiredTags) === canonical(stack.tags) && canonical(capabilities) === canonical(stack.capabilities) && canonical(notificationArns) === canonical(stack.notificationArns) && canonical(rollbackConfiguration) === canonical(stack.rollbackConfiguration ?? { rollbackTriggers: [] }) && desiredRoleArn === stack.roleArn;
      value.templateDigest = parsed.digest;
      value.processedTemplateDigest = processedDigest;
      value.parameters = resolvedParameters.entries.map(entry => ({ parameterKey: entry.parameterKey, parameterValue: entry.parameterValue, resolvedValue: entry.resolvedValue, noEcho: entry.noEcho }));
      value.capabilities = capabilities;
      value.roleArn = desiredRoleArn;
      value.tags = desiredTags;
      value.notificationArns = notificationArns;
      value.rollbackConfiguration = rollbackConfiguration;
      value.changes = changes;
      value.lastUpdatedTime = this.clock.now();
      await this.journal.replaceTemplate(artifactId, parsed.body, "original");
      await this.journal.replaceTemplate(artifactId, processedBody, "processed");
      await this.journal.replaceJsonArtifact("parameters", `${artifactId}.private.json`, { values: resolvedParameters.values, entries: resolvedParameters.entries });
      await this.journal.replaceJsonArtifact("execution", `${artifactId}.principal.json`, executionPrincipal);
      await this.journal.replaceJsonArtifact("plans", `${artifactId}.conditions.json`, conditions);
      await this.journal.replaceJsonArtifact("plans", `${artifactId}.graph.json`, graph);
      await this.journal.replaceJsonArtifact("plans", `${artifactId}.imports.json`, importNames);
      await this.journal.replaceJsonArtifact("plans", `${artifactId}.provider-models.json`, preflightModels);
      if (parsed.source) await this.journal.replaceJsonArtifact("plans", `${artifactId}.template-source.json`, parsed.source);
      await this.journal.replaceJsonArtifact("change-sets", `${artifactId}.changes.json`, changes);
      const ssmParameters = Object.entries(parsed.value.Parameters ?? {}).filter(([, definition]) => definition.Type === "AWS::SSM::Parameter::Value<String>").map(([parameterKey]) => { const entry = resolvedParameters.entries.find(candidate => candidate.parameterKey === parameterKey); return { name: String(entry?.parameterValue ?? ""), value: String(entry?.resolvedValue ?? resolvedParameters.values[parameterKey] ?? "") }; });
      const executionArtifact: ChangeSetExecutionArtifact = { schemaVersion: 2, StackName: stack.stackName, processedTemplateBody: processedBody, originalTemplateBody: parsed.body, originalTemplateDigest: parsed.digest, processedTemplateDigest: processedDigest, templateBodyMaximumBytes: input.TemplateURL !== undefined || input.UsePreviousTemplate === true ? TEMPLATE_URL_MAXIMUM_BYTES : TEMPLATE_BODY_MAXIMUM_BYTES, Parameters: list<any>(input.Parameters), Capabilities: capabilities, RoleARN: desiredRoleArn, NotificationARNs: notificationArns, RollbackConfiguration: input.RollbackConfiguration, Tags: Object.entries(desiredTags).map(([Key, Value]) => ({ Key, Value })), baselineTemplateDigest: value.changeSetType === "UPDATE" ? stack.templateDigest : undefined, baselineProcessedTemplateDigest: value.changeSetType === "UPDATE" ? stack.processedTemplateDigest : undefined, imports: Object.fromEntries(importNames.map(name => [name, String(planning.availableExports[name])])), ssmParameters, nestedTemplateManifest, templateSource: parsed.source };
      await this.journal.replaceJsonArtifact("change-sets", `${artifactId}.input.json`, executionArtifact);
      if (noUpdates) {
        value.status = "FAILED";
        value.executionStatus = "UNAVAILABLE";
        value.statusReason = "The submitted information didn't contain changes. Submit different information to create a change set.";
      } else {
        value.status = "CREATE_COMPLETE";
        value.executionStatus = "AVAILABLE";
        value.statusReason = undefined;
      }
    } catch (error) {
      if (!value.parentChangeSetId) this.deleteLinkedNestedChangeSets(value);
      value.status = "FAILED";
      value.executionStatus = "UNAVAILABLE";
      value.statusReason = error instanceof Error ? error.message : String(error);
    }
    value.lastUpdatedTime = this.clock.now();
    await this.store.save();
  }

  private async planLinkedNestedChangeSets(
    rootValue: CloudFormationChangeSetState,
    parentValue: CloudFormationChangeSetState,
    parentStack: CloudFormationStackState,
    desiredTemplate: CloudFormationTemplate,
    preflightModels: Record<string, PreflightResourceModel>,
    parentChanges: Array<Record<string, unknown>>,
    manifest: NestedTemplateManifest,
    principal: PrincipalContext,
    capabilities: string[],
  ): Promise<void> {
    for (const [logicalId, definition] of Object.entries(desiredTemplate.Resources).sort(([left], [right]) => left.localeCompare(right))) {
      if (definition.Type !== CLOUDFORMATION_NESTED_STACK_TYPE) continue;
      const properties = preflightModels[logicalId]?.properties as unknown as NestedStackModel | undefined;
      if (!properties?.TemplateURL) continue; // Output-dependent children remain dynamic in the parent plan.
      const templateAsset = manifest.assets.find(candidate => candidate.logicalId === logicalId && candidate.templateUrl === properties.TemplateURL && (!candidate.sourceDigest || candidate.sourceDigest === this.nestedTemplateSourceDigest(properties)));
      if (!templateAsset) continue;

      const existingResource = parentStack.resources[logicalId];
      let child = existingResource?.physicalResourceId ? this.state.stacks[existingResource.physicalResourceId] : undefined;
      const childName = this.nestedStackName(parentStack, logicalId);
      if (!child || child.stackStatus === "DELETE_COMPLETE") {
        const existingId = this.state.stackNames[childName];
        child = existingId ? this.state.stacks[existingId] : undefined;
      }
      const isCreate = !child || child.stackStatus === "REVIEW_IN_PROGRESS";
      if (!child) {
        const now = this.clock.now();
        const stackId = templateAsset.childStackId ?? `arn:aws:cloudformation:${this.region}:${this.store.accountId}:stack/${childName}/${randomUUID()}`;
        child = {
          stackId,
          stackName: childName,
          stackStatus: "REVIEW_IN_PROGRESS",
          creationTime: now,
          enableTerminationProtection: false,
          disableRollback: false,
          notificationArns: [],
          capabilities: [],
          tags: {},
          parameters: [],
          outputs: [],
          templateDigest: "",
          resources: {},
          events: [],
          parentId: parentStack.stackId,
          rootId: parentStack.rootId ?? parentStack.stackId,
          parentLogicalId: logicalId,
          nestedStackSource: structuredClone(properties) as unknown as Record<string, unknown>,
        };
        this.state.stacks[stackId] = child;
        this.state.stackNames[childName] = stackId;
        this.event(child, childName, CLOUDFORMATION_NESTED_STACK_TYPE, "REVIEW_IN_PROGRESS", "Nested change set planning initiated", stackId);
      }

      const changeSetNameBase = `${rootValue.changeSetName}-${logicalId}`.replace(/[^A-Za-z0-9-]/g, "-");
      const suffix = createHash("sha256").update(`${rootValue.changeSetId}:${parentValue.changeSetId}:${logicalId}`).digest("hex").slice(0, 8);
      const changeSetName = `${changeSetNameBase.slice(0, 118).replace(/-+$/g, "")}-${suffix}`;
      const changeSetId = `arn:aws:cloudformation:${this.region}:${this.store.accountId}:changeSet/${changeSetName}/${randomUUID()}`;
      const artifactId = createHash("sha256").update(changeSetId).digest("hex");
      const parsed = await this.templateFromBody(templateAsset.body);
      const suppliedParameters = Object.entries(properties.Parameters ?? {}).map(([parameterKey, parameterValue]) => ({ parameterKey, parameterValue }));
      const previousValues = Object.fromEntries(child.parameters.filter(parameter => parameter.parameterValue !== undefined).map(parameter => [parameter.parameterKey, parameter.parameterValue!]));
      const resolved = resolveTemplateParameters(parsed.value.Parameters, suppliedParameters, { previous: isCreate ? undefined : previousValues, resolveSsmParameter: (name, type) => this.resolveBootstrapSsmParameter(name, type) });
      const childNotifications = [...(properties.NotificationARNs ?? [])];
      const childTags = Object.fromEntries((properties.Tags ?? []).map(tag => [tag.Key, tag.Value]));
      const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, child.stackId, child.stackName), "AWS::NotificationARNs": childNotifications };
      const availableExports = this.exportValues();
      const conditions = evaluateTemplateConditions(parsed.value, resolved.values, pseudos, availableExports);
      validateTemplateRules(parsed.value, resolved.values, pseudos, conditions, availableExports);
      let processed = conditionallyProcessedTemplate(parsed.value, conditions);
      const evaluation = { parameters: resolved.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, resourceRefs: {}, resourceAttributes: {}, imports: availableExports };
      processed = await this.pinStaticFileAssets(processed, evaluation, artifactId, principal, true, isCreate ? {} : child.resources);
      const childNestedManifest = await this.pinNestedTemplateAssets(processed, evaluation, artifactId, principal, templateAsset.nestedTemplateManifest, { stackId: child.stackId, stackName: child.stackName, logicalPath: templateAsset.logicalPath ?? logicalId, capabilities, tags: childTags, previousResources: isCreate ? {} : child.resources });
      if (childNestedManifest.admissionFailure) throw new AwsError("ValidationError", childNestedManifest.admissionFailure, 400);
      this.assertCapabilities(processed, capabilities);
      this.validateOpeningResources(processed, child.stackId, changeSetId, principal);
      this.validateProviderReferences(processed);
      const childPreflight = this.preflightProviderModels(processed, { parameters: resolved.values, pseudoParameters: pseudos, mappings: processed.Mappings, conditions, imports: availableExports }, child.stackId, changeSetId, principal, childTags, isCreate ? {} : child.resources);
      const previousBody = !isCreate && child.templateArtifactId ? await this.journal.readTemplate(child.templateArtifactId, "processed") : undefined;
      const childChanges = this.changeSetPlan(isCreate ? undefined : child, processed, childPreflight, previousBody ? parseCloudFormationTemplate(previousBody) : undefined);
      const now = this.clock.now();
      const childValue: CloudFormationChangeSetState = {
        changeSetId,
        changeSetName,
        stackId: child.stackId,
        stackName: child.stackName,
        changeSetType: isCreate ? "CREATE" : "UPDATE",
        status: "CREATE_COMPLETE",
        executionStatus: "UNAVAILABLE",
        statusReason: "Executable from root change set",
        creationTime: now,
        lastUpdatedTime: now,
        description: `Nested plan for ${parentStack.stackName}.${logicalId}`,
        templateArtifactId: artifactId,
        templateDigest: parsed.digest,
        processedTemplateDigest: createHash("sha256").update(JSON.stringify(processed)).digest("hex"),
        parameters: resolved.entries.map(entry => ({ parameterKey: entry.parameterKey, parameterValue: entry.parameterValue, resolvedValue: entry.resolvedValue, noEcho: entry.noEcho })),
        capabilities: [...capabilities],
        tags: childTags,
        changes: childChanges,
        notificationArns: childNotifications,
        includeNestedStacks: true,
        parentChangeSetId: parentValue.changeSetId,
        rootChangeSetId: rootValue.changeSetId,
      };
      this.state.changeSets[changeSetId] = childValue;
      this.state.changeSetNames[this.changeSetKey(child.stackId, changeSetName)] = changeSetId;
      await this.journal.replaceTemplate(artifactId, parsed.body, "original");
      await this.journal.replaceTemplate(artifactId, JSON.stringify(processed), "processed");
      await this.journal.replaceJsonArtifact("change-sets", `${artifactId}.changes.json`, childChanges);
      await this.journal.replaceJsonArtifact("parameters", `${artifactId}.private.json`, { values: resolved.values, entries: resolved.entries });

      const parentChange = parentChanges.find(change => (change as any).ResourceChange?.LogicalResourceId === logicalId);
      if (parentChange) (parentChange as any).ResourceChange.ChangeSetId = changeSetId;
      await this.planLinkedNestedChangeSets(rootValue, childValue, child, processed, childPreflight, childChanges, childNestedManifest, principal, capabilities);
      await this.journal.replaceJsonArtifact("change-sets", `${artifactId}.changes.json`, childChanges);
    }
  }

  private changeSetPlan(previousStack: CloudFormationStackState | undefined, desired: CloudFormationTemplate, preflightModels: Record<string, PreflightResourceModel> = {}, previousTemplate?: CloudFormationTemplate): Array<Record<string, unknown>> {
    const previousResources = previousStack?.resources ?? {};
    const desiredIds = new Set(Object.keys(desired.Resources));
    const allIds = [...new Set([...Object.keys(previousResources), ...desiredIds])].sort();
    const impacts = new Map<string, { changed: boolean; replaced: boolean }>();
    const propertyChangedWithoutPlan = (logicalId: string, name: string, beforeValue: unknown, afterValue: unknown): boolean => {
      const previousDefinition = previousTemplate?.Resources[logicalId];
      if (previousDefinition && canonical((previousDefinition.Properties ?? {})[name]) !== canonical(afterValue)) return true;
      const causes = changeDetailCauses(afterValue, desired);
      if (causes.length === 1 && causes[0].ChangeSource === "DirectModification") return previousDefinition ? false : canonical(beforeValue) !== canonical(afterValue);
      return causes.some(cause => {
        if (cause.ChangeSource === "DirectModification" || cause.ChangeSource === "ParameterReference" || !cause.CausingEntity) return true;
        const source = impacts.get(cause.CausingEntity.split(".", 1)[0]);
        if (!source) return true;
        return cause.ChangeSource === "ResourceAttribute" ? source.changed : source.replaced;
      });
    };
    const graphOrder = buildResourceDependencyGraph(desired).order;
    const impactOrder = [...graphOrder, ...allIds.filter(logicalId => !desiredIds.has(logicalId))];
    for (const logicalId of impactOrder) {
      const before = previousResources[logicalId]; const after = desired.Resources[logicalId];
      if (!before || !after || before.resourceType !== after.Type) { impacts.set(logicalId, { changed: true, replaced: true }); continue; }
      const provider = this.providers.get(after.Type); const beforeProperties = before.properties ?? {}; const afterProperties = preflightModels[logicalId]?.properties ?? after.Properties ?? {}; const providerPlan = preflightModels[logicalId]?.plan;
      const changedNames = [...new Set([...Object.keys(beforeProperties), ...Object.keys(afterProperties)])].filter(name => providerPlan ? providerPlan.changedProperties.includes(name) : propertyChangedWithoutPlan(logicalId, name, beforeProperties[name], (after.Properties ?? {})[name]));
      const replaced = providerPlan ? providerPlan.action === "REPLACE" : changedNames.some(name => {
        const behavior = provider?.schema.properties[name]?.updateBehavior ?? "NOT_SUPPORTED";
        return behavior === "REPLACEMENT" || behavior === "CONDITIONAL_REPLACEMENT" || behavior === "NOT_SUPPORTED";
      });
      const attributesChanged = canonical(before.metadata ?? {}) !== canonical(preflightModels[logicalId]?.metadata ?? after.Metadata ?? {}) || before.deletionPolicy !== after.DeletionPolicy || before.updateReplacePolicy !== after.UpdateReplacePolicy || canonical(before.dependsOn) !== canonical(list<string>(after.DependsOn).map(String));
      impacts.set(logicalId, { changed: (providerPlan ? providerPlan.action !== "NO_OP" : changedNames.length > 0) || attributesChanged, replaced });
    }
    const changes: Array<Record<string, unknown>> = [];
    for (const logicalId of allIds) {
      const beforeState = previousResources[logicalId]; const after = desired.Resources[logicalId];
      if (!beforeState && after) { changes.push({ Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: logicalId, ResourceType: after.Type, Replacement: "False", Scope: [], Details: [] } }); continue; }
      if (beforeState && !after) { const retention = beforeState.deletionPolicy ?? (beforeState.resourceType === RDS_DB_INSTANCE_TYPE ? "Snapshot" : "Delete"); const policy = retention === "Retain" || retention === "RetainExceptOnCreate" ? "Retain" : retention === "Snapshot" ? "Snapshot" : "Delete"; changes.push({ Type: "Resource", ResourceChange: { Action: "Remove", LogicalResourceId: logicalId, PhysicalResourceId: beforeState.physicalResourceId, ResourceType: beforeState.resourceType, Replacement: "False", PolicyAction: policy, Scope: [], Details: [] } }); continue; }
      if (!beforeState || !after) continue;
      const details: Array<Record<string, unknown>> = []; const scope = new Set<string>(); let replacement: "False" | "Conditional" | "True" = beforeState.resourceType === after.Type ? "False" : "True";
      if (beforeState.resourceType !== after.Type) { scope.add("Properties"); details.push({ Target: { Attribute: "Properties", RequiresRecreation: "Always", Path: "/Type", BeforeValue: JSON.stringify(beforeState.resourceType), AfterValue: JSON.stringify(after.Type) }, Evaluation: "Static", ChangeSource: "DirectModification" }); }
      const provider = this.providers.get(after.Type); const beforeProperties = beforeState.properties ?? {}; const afterProperties = preflightModels[logicalId]?.properties ?? after.Properties ?? {}; const providerPlan = preflightModels[logicalId]?.plan;
      for (const name of [...new Set([...Object.keys(beforeProperties), ...Object.keys(afterProperties)])].sort()) {
        const valuesDiffer = providerPlan ? providerPlan.changedProperties.includes(name) : propertyChangedWithoutPlan(logicalId, name, beforeProperties[name], (after.Properties ?? {})[name]);
        const causes = changeDetailCauses((after.Properties as Record<string, unknown> | undefined)?.[name], desired);
        const propagated = valuesDiffer ? causes : causes.filter(cause => {
          if (!cause.CausingEntity) return false;
          const impact = impacts.get(cause.CausingEntity.split(".", 1)[0]);
          return cause.ChangeSource === "ResourceAttribute" ? impact?.changed === true : cause.ChangeSource === "ResourceReference" && impact?.replaced === true;
        });
        if (!valuesDiffer && !propagated.length) continue;
        scope.add("Properties");
        const behavior = provider?.schema.properties[name]?.updateBehavior ?? "NOT_SUPPORTED";
        const sourceReplacement = !valuesDiffer && propagated.some(cause => cause.CausingEntity ? impacts.get(cause.CausingEntity.split(".", 1)[0])?.replaced === true : false);
        const recreation = providerPlan && !sourceReplacement
          ? providerPlan.replacementProperties.includes(name) ? "Always" : "Never"
          : behavior === "REPLACEMENT" || behavior === "NOT_SUPPORTED" ? "Always" : behavior === "CONDITIONAL_REPLACEMENT" ? "Conditionally" : "Never";
        if (recreation === "Always") replacement = "True"; else if (recreation === "Conditionally" && replacement === "False") replacement = "Conditional";
        const sensitive = provider?.schema.properties[name]?.sensitive === true;
        const target = { Attribute: "Properties", Name: name, RequiresRecreation: recreation, Path: `/Properties/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`, BeforeValue: beforeProperties[name] === undefined ? undefined : JSON.stringify(sensitive ? "****" : beforeProperties[name]), AfterValue: valuesDiffer && afterProperties[name] !== undefined ? JSON.stringify(sensitive ? "****" : afterProperties[name]) : undefined };
        for (const cause of propagated) details.push({ Target: structuredClone(target), ...cause });
      }
      for (const [attribute, beforeValue, afterValue] of [["Metadata", beforeState.metadata ?? {}, preflightModels[logicalId]?.metadata ?? after.Metadata ?? {}], ["DeletionPolicy", beforeState.deletionPolicy, after.DeletionPolicy], ["UpdateReplacePolicy", beforeState.updateReplacePolicy, after.UpdateReplacePolicy], ["Properties", beforeState.dependsOn, list<string>(after.DependsOn).map(String)]] as const) {
        if (canonical(beforeValue) === canonical(afterValue)) continue; scope.add(attribute === "Properties" ? "Properties" : attribute); details.push({ Target: { Attribute: attribute, RequiresRecreation: "Never", Path: attribute === "Properties" ? "/DependsOn" : `/${attribute}`, BeforeValue: beforeValue === undefined ? undefined : JSON.stringify(beforeValue), AfterValue: afterValue === undefined ? undefined : JSON.stringify(afterValue) }, Evaluation: "Static", ChangeSource: "DirectModification" });
      }
      if (!details.length) continue;
      const retention = after.UpdateReplacePolicy ?? "Delete"; const policyAction = replacement === "False" ? undefined : retention === "Retain" || retention === "RetainExceptOnCreate" ? "ReplaceAndRetain" : retention === "Snapshot" ? "ReplaceAndSnapshot" : "ReplaceAndDelete";
      changes.push({ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: logicalId, PhysicalResourceId: beforeState.physicalResourceId, ResourceType: after.Type, Replacement: replacement, PolicyAction: policyAction, Scope: [...scope].sort(), Details: details } });
    }
    return changes;
  }

  private changeSetChangesView(changes: Array<Record<string, unknown>>, includePropertyValues: boolean): Array<Record<string, unknown>> {
    const result = structuredClone(changes);
    if (includePropertyValues) return result;
    for (const change of result) for (const detail of ((change as any).ResourceChange?.Details ?? [])) { if (detail.Target) { delete detail.Target.BeforeValue; delete detail.Target.AfterValue; } }
    return result;
  }

  private linkAcceptedChangeSetExecution(value: CloudFormationChangeSetState): boolean {
    if (value.executionOperationId || !value.executionClientToken) return false;
    const tokenRecord = this.state.clientTokens[value.executionClientToken];
    const expectedOperation = value.changeSetType === "CREATE" ? "CreateStack" : "UpdateStack";
    const expectedKind = value.changeSetType === "CREATE" ? "CREATE" : "UPDATE";
    const stack = this.state.stacks[value.stackId];
    const operation = stack?.activeOperation;
    if (!tokenRecord || tokenRecord.operation !== expectedOperation || tokenRecord.stackId !== value.stackId || !operation || operation.kind !== expectedKind || operation.clientRequestToken !== value.executionClientToken) return false;
    value.executionOperationId = operation.operationId;
    value.executionStatus = operation.status === "PENDING" || operation.status === "RUNNING" ? "EXECUTE_IN_PROGRESS" : "EXECUTE_COMPLETE";
    value.lastUpdatedTime = this.clock.now();
    for (const other of Object.values(this.state.changeSets)) if (other.stackId === value.stackId && other.changeSetId !== value.changeSetId && other.executionStatus === "AVAILABLE") other.executionStatus = "OBSOLETE";
    return true;
  }

  private async syncChangeSetExecution(value: CloudFormationChangeSetState): Promise<void> {
    if (value.rootChangeSetId) {
      const root = this.state.changeSets[value.rootChangeSetId];
      if (root && root.changeSetId !== value.changeSetId) {
        await this.syncChangeSetExecution(root);
        const mirrored = root.executionStatus === "EXECUTE_COMPLETE" || root.executionStatus === "EXECUTE_FAILED"
          ? root.executionStatus
          : root.executionStatus === "EXECUTE_IN_PROGRESS" ? "EXECUTE_IN_PROGRESS" : "UNAVAILABLE";
        if (value.executionStatus !== mirrored) {
          value.executionStatus = mirrored;
          value.executionOperationId = root.executionOperationId;
          value.lastUpdatedTime = this.clock.now();
          await this.store.save();
        }
        return;
      }
    }
    let changed = this.linkAcceptedChangeSetExecution(value);
    if (value.executionStatus === "EXECUTE_IN_PROGRESS" && value.executionOperationId) {
      const stack = this.state.stacks[value.stackId]; const operation = stack?.activeOperation;
      if (stack && operation && operation.operationId === value.executionOperationId && operation.status !== "PENDING" && operation.status !== "RUNNING") {
        value.executionStatus = "EXECUTE_COMPLETE"; value.lastUpdatedTime = this.clock.now(); changed = true;
      }
    }
    if (changed) await this.store.save();
  }

  private resolveBootstrapSsmParameter(name: string, type: string): string {
    if (type !== "AWS::SSM::Parameter::Value<String>") throw new AwsError("ValidationError", `CloudFormation supports only AWS::SSM::Parameter::Value<String>; received ${type}`, 400);
    const value = this.bootstrapParameterResolver?.(name);
    if (value === undefined) throw new AwsError("ValidationError", `SSM parameter ${name} is missing or is not a String parameter in the authoritative Parameter Store catalog`, 400);
    return value;
  }

  private async authorizeTypedSsmParameters(template: CloudFormationTemplate, supplied: readonly import("./cloudformation/parameters.js").ParameterInput[], principal: PrincipalContext, previous: Readonly<Record<string, string>> = {}): Promise<void> {
    if (!this.authorizeProviderTargets) return;
    const byName = new Map(supplied.map(input => [input.parameterKey, input]));
    const targets: ProviderAuthorizationTarget[] = [];
    for (const [name, declaration] of Object.entries(template.Parameters ?? {})) {
      if (declaration.Type !== "AWS::SSM::Parameter::Value<String>") continue;
      const input = byName.get(name);
      const value = input?.usePreviousValue ? previous[name] : input?.parameterValue ?? (declaration.Default === undefined ? undefined : String(declaration.Default));
      if (!value) continue;
      targets.push({ action: "ssm:GetParameters", resource: `arn:aws:ssm:${this.region}:${this.store.accountId}:parameter/${value.replace(/^\/+/, "")}` });
    }
    if (targets.length) await this.authorizeProviderTargets(principal, targets);
  }

  private defaultExecutionPrincipal(): PrincipalContext {
    const initialization = this.store.state.installation.defaultAdministrators[this.store.accountId];
    const user = initialization?.originalUserId
      ? Object.values(this.store.ensureAccount().iam.users).find(candidate => candidate.userId === initialization.originalUserId)
      : undefined;
    const key = initialization?.configuredAccessKeyId
      ? this.store.ensureAccount().iam.accessKeys[initialization.configuredAccessKeyId]
      : undefined;
    if (!user || !key || key.status !== "Active") {
      throw new AwsError("AccessDenied", "CloudFormation has no authenticated persisted caller and the configured IAM administrator is unavailable", 403);
    }
    return {
      principalType: "user",
      accessKeyId: key.accessKeyId,
      principalArn: user.arn,
      principalId: user.userId,
      accountId: this.store.accountId,
      userName: user.userName,
      userId: user.userId,
      principalTags: { ...user.tags },
    };
  }

  private async operationPrincipal(roleArn: unknown, operationId: string, caller: PrincipalContext): Promise<PrincipalContext> {
    if (roleArn === undefined || roleArn === null || roleArn === "") return caller;
    if (typeof roleArn !== "string" || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]+$/.test(roleArn)) throw new AwsError("ValidationError", "RoleARN must be a valid IAM role ARN", 400);
    if (!this.assumeExecutionRole) throw new AwsError("ValidationError", `CloudFormation cannot assume execution role ${roleArn}`, 400);
    try { return await this.assumeExecutionRole(roleArn, `stacksim-cfn-${operationId.slice(0, 32)}`); }
    catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("ValidationError", error instanceof Error ? error.message : String(error), 400); }
  }

  private providerContext(stackId: string, logicalId: string, operationId: string, principal: PrincipalContext, callbackContext?: Record<string, any>, step = "resource", deadlineAt?: number): ProviderContext {
    const resourceOperationId = createHash("sha256").update(`${operationId}:${logicalId}:${step}`).digest("hex");
    const operation = this.state.stacks[stackId]?.activeOperation;
    return { accountId: this.store.accountId, region: this.region, partition: "aws", stackId, logicalId, operationId, resourceOperationId, clientRequestToken: operation?.clientRequestToken, idempotencyKey: `${operationId}:${logicalId}:${step}`, deadlineAt: deadlineAt ?? this.clock.now() + PROVIDER_DEADLINE_MS, callbackContext, principal: { identity: principal, serviceRoleArn: this.state.stacks[stackId]?.roleArn } };
  }

  private async releaseRetainedProviderOwnership(
    stack: CloudFormationStackState,
    logicalId: string,
    resource: CloudFormationStackResourceState,
    principal: PrincipalContext,
    step: string,
  ): Promise<void> {
    if (!resource.physicalResourceId) return;
    const provider = this.providers.require(resource.resourceType);
    if (!provider.retain) return;
    const resolved = await this.resolveDynamicReferenceProperties(resource.resourceType, resource.properties, principal);
    const context = this.providerContext(stack.stackId, logicalId, stack.activeOperation!.operationId, principal, undefined, step);
    const previous = provider.canonicalize(resolved, context);
    await provider.retain(resource.physicalResourceId, previous, context);
  }

  private validationError(error: unknown): AwsError {
    if (error instanceof AwsError) return error;
    if (error instanceof TemplateValidationError || (error && typeof error === "object" && (error as any).code === "ValidationError")) return new AwsError("ValidationError", error instanceof Error ? error.message : String(error), 400);
    if (error instanceof Error && (error.name === "IntrinsicEvaluationError" || error.name === "CloudFormationDependencyGraphError" || error.name === "DependencyGraphError")) return new AwsError("ValidationError", error.message, 400);
    return new AwsError("ValidationError", error instanceof Error ? error.message : String(error), 400);
  }

  private validateClientRequestToken(token: string | undefined): void {
    if (token === undefined) return;
    if (!/^[A-Za-z0-9][-A-Za-z0-9]{0,127}$/.test(token)) throw new AwsError("ValidationError", "ClientRequestToken must contain 1-128 letters, numbers, or hyphens and start with a letter or number", 400);
  }

  private normalizedNotificationArns(input: unknown): string[] {
    const values = list<unknown>(input).map(String);
    if (values.length > 5) throw new AwsError("LimitExceededException", "A stack can have at most 5 notification ARNs", 400);
    if (new Set(values).size !== values.length) throw new AwsError("ValidationError", "NotificationARNs cannot contain duplicates", 400);
    for (const arn of values) if (!/^arn:[a-z0-9-]+:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_.-]+$/.test(arn)) throw new AwsError("ValidationError", `NotificationARN ${arn} must be an SNS topic ARN`, 400);
    return values;
  }

  private normalizedRollbackConfiguration(
    input: any,
    previous?: CloudFormationStackState["rollbackConfiguration"],
  ): NonNullable<CloudFormationStackState["rollbackConfiguration"]> {
    if (input === undefined) return structuredClone(previous ?? { rollbackTriggers: [] });
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AwsError("ValidationError", "RollbackConfiguration must be an object", 400);
    const rawMonitoring = input.MonitoringTimeInMinutes;
    let monitoringTimeInMinutes: number | undefined;
    if (rawMonitoring !== undefined && rawMonitoring !== "") {
      monitoringTimeInMinutes = Number(rawMonitoring);
      if (!Number.isInteger(monitoringTimeInMinutes) || monitoringTimeInMinutes < 0 || monitoringTimeInMinutes > 180) throw new AwsError("ValidationError", "RollbackConfiguration.MonitoringTimeInMinutes must be an integer from 0 through 180", 400);
    }
    const rollbackTriggers = list<any>(input.RollbackTriggers).map((trigger, index) => {
      if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) throw new AwsError("ValidationError", `RollbackTriggers member ${index + 1} must be an object`, 400);
      const arn = String(trigger.Arn ?? "");
      const type = String(trigger.Type ?? "");
      if (!/^arn:aws:cloudwatch:[a-z0-9-]+:\d{12}:alarm:.+$/.test(arn)) throw new AwsError("ValidationError", `Rollback trigger ${index + 1} requires a valid CloudWatch alarm ARN`, 400);
      if (type !== "AWS::CloudWatch::Alarm" && type !== "AWS::CloudWatch::CompositeAlarm") throw new AwsError("ValidationError", `Rollback trigger ${index + 1} has unsupported type ${type || "(missing)"}`, 400);
      return { arn, type: type as "AWS::CloudWatch::Alarm" | "AWS::CloudWatch::CompositeAlarm" };
    });
    if (rollbackTriggers.length > 5) throw new AwsError("ValidationError", "RollbackConfiguration supports at most 5 rollback triggers", 400);
    if (new Set(rollbackTriggers.map(trigger => trigger.arn)).size !== rollbackTriggers.length) throw new AwsError("ValidationError", "RollbackConfiguration cannot contain duplicate rollback trigger ARNs", 400);
    if (rollbackTriggers.length) throw new AwsError("ValidationError", "CloudWatch rollback-trigger monitoring is dependency-blocked until CFN-10; only an empty RollbackTriggers list is supported", 400);
    return { rollbackTriggers, ...(monitoringTimeInMinutes === undefined ? {} : { monitoringTimeInMinutes }) };
  }

  private rollbackConfigurationView(value?: CloudFormationStackState["rollbackConfiguration"]): any {
    return {
      RollbackTriggers: (value?.rollbackTriggers ?? []).map(trigger => ({ Arn: trigger.arn, Type: trigger.type })),
      MonitoringTimeInMinutes: value?.monitoringTimeInMinutes,
    };
  }

  private stack(identifier: string, includeDeleted = false): CloudFormationStackState {
    const stack = this.state.stacks[identifier] ?? this.state.stacks[this.state.stackNames[identifier]];
    if (!stack || (!includeDeleted && stack.stackStatus === "DELETE_COMPLETE")) throw new AwsError("ValidationError", `Stack with id ${identifier || "(missing)"} does not exist`, 400);
    if (stack.stackStatus === "DELETE_COMPLETE" && identifier === stack.stackName) throw new AwsError("ValidationError", `Stack with id ${identifier} does not exist`, 400);
    return stack;
  }

  private hierarchyRoot(stack: CloudFormationStackState): CloudFormationStackState {
    return stack.rootId && this.state.stacks[stack.rootId] ? this.state.stacks[stack.rootId] : stack;
  }

  private assertNoActiveAncestor(stack: CloudFormationStackState): void {
    let parentId = stack.parentId;
    while (parentId) {
      const parent = this.state.stacks[parentId];
      if (!parent) break;
      if (parent.activeOperation?.status === "PENDING" || parent.activeOperation?.status === "RUNNING") {
        throw new AwsError("ValidationError", `Nested stack ${stack.stackName} is currently coordinated by ancestor stack ${parent.stackName}`, 400);
      }
      parentId = parent.parentId;
    }
  }

  private detachNestedStack(resource: CloudFormationStackResourceState): void {
    if (resource.resourceType !== CLOUDFORMATION_NESTED_STACK_TYPE || !resource.physicalResourceId) return;
    const child = this.state.stacks[resource.physicalResourceId];
    if (!child || child.stackStatus === "DELETE_COMPLETE" || !child.parentId) return;
    child.formerParentId = child.parentId;
    child.formerParentLogicalId = child.parentLogicalId;
    delete child.parentId;
    delete child.parentLogicalId;
    delete child.rootId;
    const reroot = (parentId: string, rootId: string): void => {
      for (const descendant of Object.values(this.state.stacks)) {
        if (descendant.parentId !== parentId || descendant.stackStatus === "DELETE_COMPLETE") continue;
        descendant.rootId = rootId;
        reroot(descendant.stackId, rootId);
      }
    };
    reroot(child.stackId, child.stackId);
  }

  private stackView(stack: CloudFormationStackState): any {
    return { StackId: stack.stackId, StackName: stack.stackName, Description: stack.description, Parameters: stack.parameters.map(parameterView), CreationTime: new Date(stack.creationTime), LastUpdatedTime: stack.lastUpdatedTime === undefined ? undefined : new Date(stack.lastUpdatedTime), DeletionTime: stack.deletionTime === undefined ? undefined : new Date(stack.deletionTime), RollbackConfiguration: this.rollbackConfigurationView(stack.rollbackConfiguration), StackStatus: stack.stackStatus, StackStatusReason: stack.stackStatusReason, DisableRollback: stack.disableRollback, NotificationARNs: stack.notificationArns, Capabilities: stack.capabilities, Outputs: stack.outputs.map(outputView), RoleARN: stack.roleArn, Tags: Object.entries(stack.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })), EnableTerminationProtection: this.hierarchyRoot(stack).enableTerminationProtection, ParentId: stack.parentId, RootId: stack.rootId, DriftInformation: { StackDriftStatus: "NOT_CHECKED" } };
  }

  private redactValue(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === "string") {
      let redacted = value;
      for (const secret of secrets) if (secret) redacted = redacted.split(secret).join("****");
      return redacted;
    }
    if (Array.isArray(value)) return value.map(item => this.redactValue(item, secrets));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.redactValue(item, secrets)]));
    return value;
  }

  private redactedProperties(stack: CloudFormationStackState, resourceType: string, properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const secrets = stack.parameters.filter(parameter => parameter.noEcho).flatMap(parameter => [parameter.parameterValue, parameter.resolvedValue]).filter((value): value is string => typeof value === "string" && value.length > 0);
    const redacted = this.redactValue(structuredClone(properties), secrets) as Record<string, unknown>;
    const schema = this.providers.get(resourceType)?.schema;
    for (const [name, declaration] of Object.entries(schema?.properties ?? {})) if (declaration.sensitive && Object.hasOwn(redacted, name)) redacted[name] = "****";
    return redacted;
  }

  private redactedResource(stack: CloudFormationStackState, resource: CloudFormationStackResourceState): CloudFormationStackResourceState {
    const redacted = structuredClone(resource);
    redacted.properties = this.redactedProperties(stack, resource.resourceType, resource.properties);
    redacted.metadata = this.redactValue(redacted.metadata, stack.parameters.filter(parameter => parameter.noEcho).flatMap(parameter => [parameter.parameterValue, parameter.resolvedValue]).filter((value): value is string => typeof value === "string" && value.length > 0)) as Record<string, unknown>;
    if (resource.resourceType === "AWS::CloudFormation::CustomResource" || resource.resourceType.startsWith("Custom::") && resource.resourceType !== "Custom::CDKBucketDeployment") {
      const noEcho = redacted.attributes.__stackSimCustomResourceNoEcho === true;
      delete redacted.attributes.__stackSimCustomResourceNoEcho;
      if (noEcho) redacted.attributes = Object.fromEntries(Object.keys(redacted.attributes).map(key => [key, "****"]));
    }
    return redacted;
  }

  private redactedEvent(stack: CloudFormationStackState, event: CloudFormationStackEventState): CloudFormationStackEventState {
    const redacted = structuredClone(event);
    if (event.resourceProperties) {
      try { redacted.resourceProperties = JSON.stringify(this.redactedProperties(stack, event.resourceType, JSON.parse(event.resourceProperties))); }
      catch { redacted.resourceProperties = "****"; }
    }
    return redacted;
  }

  private localStackState(stack: CloudFormationStackState): CloudFormationStackState {
    const redacted = structuredClone(stack);
    redacted.parameters = redacted.parameters.map(parameter => parameter.noEcho ? { ...parameter, parameterValue: parameter.parameterValue === undefined ? undefined : "****", resolvedValue: parameter.resolvedValue === undefined ? undefined : "****" } : parameter);
    redacted.resources = Object.fromEntries(Object.entries(stack.resources).map(([logicalId, resource]) => [logicalId, this.redactedResource(stack, resource)]));
    redacted.events = stack.events.map(event => this.redactedEvent(stack, event));
    return redacted;
  }

  private event(stack: CloudFormationStackState, logicalId: string, resourceType: string, status: CloudFormationStackStatus | CloudFormationResourceStatus, reason?: string, physicalId?: string, token?: string, properties?: Record<string, unknown>): void {
    const event = { eventId: randomUUID(), stackId: stack.stackId, stackName: stack.stackName, operationId: stack.activeOperation?.operationId, logicalResourceId: logicalId, physicalResourceId: physicalId, resourceType, timestamp: this.clock.now(), resourceStatus: status, resourceStatusReason: reason, clientRequestToken: token, resourceProperties: properties === undefined ? undefined : JSON.stringify(this.redactedProperties(stack, resourceType, properties)) };
    stack.events.push(event);
    const message = JSON.stringify({
      StackId: stack.stackId,
      StackName: stack.stackName,
      EventId: event.eventId,
      LogicalResourceId: logicalId,
      PhysicalResourceId: physicalId,
      ResourceType: resourceType,
      Timestamp: new Date(event.timestamp).toISOString(),
      ResourceStatus: status,
      ResourceStatusReason: reason,
      ClientRequestToken: token,
    });
    for (const topicArn of stack.notificationArns) this.notificationOutbox.push({ id: randomUUID(), topicArn, stackId: stack.stackId, message, createdAt: event.timestamp, attempts: 0, nextAttemptAt: event.timestamp });
    if (stack.notificationArns.length) void this.drainNotificationOutbox();
  }

  private eventView(event: CloudFormationStackEventState): any { const stack = this.state.stacks[event.stackId]; const safe = stack ? this.redactedEvent(stack, event) : event; return { EventId: safe.eventId, StackId: safe.stackId, StackName: safe.stackName, OperationId: safe.operationId, LogicalResourceId: safe.logicalResourceId, PhysicalResourceId: safe.physicalResourceId, ResourceType: safe.resourceType, Timestamp: new Date(safe.timestamp), ResourceStatus: safe.resourceStatus, ResourceStatusReason: safe.resourceStatusReason, ClientRequestToken: safe.clientRequestToken, ResourceProperties: safe.resourceProperties }; }

  private evaluatedOutputs(input: unknown, context: any): CloudFormationOutputState[] {
    if (!input || typeof input !== "object" || Array.isArray(input)) return [];
    return Object.entries<any>(input).sort(([a], [b]) => a.localeCompare(b)).map(([outputKey, definition]) => {
      const raw = evaluateIntrinsicValue(definition?.Value, context, `$.Outputs.${outputKey}.Value`);
      if (!["string", "number", "boolean"].includes(typeof raw)) throw new AwsError("ValidationError", `Output ${outputKey} must resolve to a string, number, or boolean`, 400);
      const exportNameValue = definition?.Export === undefined ? undefined : evaluateIntrinsicValue(definition.Export.Name, context, `$.Outputs.${outputKey}.Export.Name`); if (exportNameValue !== undefined && !["string", "number", "boolean"].includes(typeof exportNameValue)) throw new AwsError("ValidationError", `Output ${outputKey} export name must resolve to a scalar`, 400);
      return { outputKey, outputValue: String(raw), description: definition?.Description, exportName: exportNameValue === undefined ? undefined : String(exportNameValue) };
    });
  }

  private page<T>(operation: string, nextToken: unknown, values: T[], maximum: number): { values: T[]; nextToken?: string } {
    let index = 0; if (nextToken !== undefined) { try { index = this.tokens.decode<{ index: number }>(operation, String(nextToken)).index; } catch { throw new AwsError("ValidationError", "NextToken is invalid", 400); } }
    const page = values.slice(index, index + maximum); const next = index + page.length; return { values: page, ...(next < values.length ? { nextToken: this.tokens.encode(operation, { index: next }) } : {}) };
  }

  private artifactId(stackId: string): string { return createHash("sha256").update(stackId).digest("hex"); }

  private mutationArtifactId(operationId: string): string { return `${operationId}.mutations.json`; }

  private async mutationLedger(operationId: string): Promise<ResourceMutationLedger> {
    const existing = await this.journal.readJsonArtifact<ResourceMutationLedger>("operations", this.mutationArtifactId(operationId));
    if (existing === undefined) return { schemaVersion: 1, records: [] };
    if (existing.schemaVersion !== 1 || !Array.isArray(existing.records)) throw new Error(`Mutation ledger for operation ${operationId} is corrupt or unsupported`);
    return existing;
  }

  private async mutationIntent(
    operationId: string,
    input: Omit<ResourceMutationRecord, "sequence" | "status">,
  ): Promise<ResourceMutationRecord> {
    const ledger = await this.mutationLedger(operationId);
    const prior = ledger.records.find(record => record.key === input.key);
    if (prior) return prior;
    const record: ResourceMutationRecord = { ...structuredClone(input), sequence: (ledger.records.at(-1)?.sequence ?? 0) + 1, status: "INTENT" };
    ledger.records.push(record);
    await this.journal.replaceJsonArtifact("operations", this.mutationArtifactId(operationId), ledger);
    return record;
  }

  private async mutationComplete(operationId: string, key: string, after?: CloudFormationStackResourceState): Promise<ResourceMutationRecord> {
    const ledger = await this.mutationLedger(operationId);
    const record = ledger.records.find(candidate => candidate.key === key);
    if (!record) throw new Error(`Mutation ${key} has no durable intent`);
    record.status = "COMPLETE";
    record.after = after === undefined ? undefined : structuredClone(after);
    await this.journal.replaceJsonArtifact("operations", this.mutationArtifactId(operationId), ledger);
    return record;
  }

  private async persistProvisionalCreatePhysicalId(
    stack: CloudFormationStackState,
    logicalId: string,
    step: string,
    physicalId: string,
  ): Promise<void> {
    const operation = stack.activeOperation;
    if (!operation) return;
    const key = step === "create" ? `${logicalId}:create` : step === "replace-create" ? `${logicalId}:replace-create` : undefined;
    if (!key) return;
    const ledger = await this.mutationLedger(operation.operationId);
    const record = ledger.records.find(candidate => candidate.key === key && (candidate.kind === "CREATE" || candidate.kind === "REPLACE_CREATE"));
    if (!record || record.status !== "INTENT" || !record.after) return;
    record.after.physicalResourceId = physicalId;
    record.after.lastUpdatedTimestamp = this.clock.now();
    const resource = stack.resources[logicalId];
    if (record.kind === "CREATE" && resource && resource.resourceStatus === "CREATE_IN_PROGRESS") {
      resource.physicalResourceId = physicalId;
      resource.lastUpdatedTimestamp = this.clock.now();
    }
    await this.journal.replaceJsonArtifact("operations", this.mutationArtifactId(operation.operationId), ledger);
  }

  private async discardUnownedProvisionalCreatePhysicalId(
    stack: CloudFormationStackState,
    logicalId: string,
    step: string,
  ): Promise<void> {
    const operation = stack.activeOperation;
    if (!operation) return;
    const key = step === "create" ? `${logicalId}:create` : step === "replace-create" ? `${logicalId}:replace-create` : undefined;
    if (!key) return;
    const ledger = await this.mutationLedger(operation.operationId);
    const record = ledger.records.find(candidate => candidate.key === key && (candidate.kind === "CREATE" || candidate.kind === "REPLACE_CREATE"));
    if (!record || record.status !== "INTENT" || !record.after?.physicalResourceId) return;
    delete record.after.physicalResourceId;
    const resource = stack.resources[logicalId];
    if (record.kind === "CREATE" && resource?.resourceStatus === "CREATE_IN_PROGRESS") delete resource.physicalResourceId;
    await this.journal.replaceJsonArtifact("operations", this.mutationArtifactId(operation.operationId), ledger);
  }

  private async mutationRollbackResult(operationId: string, key: string, status: "COMPLETE" | "SKIPPED" | "FAILED", reason?: string, rollbackAfter?: CloudFormationStackResourceState): Promise<void> {
    const ledger = await this.mutationLedger(operationId);
    const record = ledger.records.find(candidate => candidate.key === key);
    if (!record) throw new Error(`Mutation ${key} is missing during rollback`);
    record.rollbackStatus = status;
    record.rollbackReason = reason;
    record.rollbackAfter = rollbackAfter === undefined ? undefined : structuredClone(rollbackAfter);
    await this.journal.replaceJsonArtifact("operations", this.mutationArtifactId(operationId), ledger);
  }

  private async hasStartedMutation(operationId: string, logicalId: string): Promise<boolean> {
    return (await this.mutationLedger(operationId)).records.some(record => record.logicalId === logicalId);
  }

  private providerCheckpointArtifactId(operationId: string, logicalId: string, step: string): string {
    return `${operationId}.${logicalId}.${step}.json`;
  }

  private async activeProcessedRoleArns(stack: CloudFormationStackState): Promise<Set<string>> {
    const operation = stack.activeOperation;
    const rollingBackUpdate = stack.stackStatus.startsWith("UPDATE_ROLLBACK") || operation?.kind === "ROLLBACK_UPDATE";
    const artifactId = rollingBackUpdate
      ? operation?.previousTemplateArtifactId
      : operation?.kind === "UPDATE"
        ? operation.desiredTemplateArtifactId
        : stack.templateArtifactId;
    if (!artifactId) throw new Error(`Stack ${stack.stackName} has no active processed template for PassRole ownership`);
    const body = await this.journal.readTemplate(artifactId, "processed");
    if (body === undefined) throw new Error(`Stack ${stack.stackName} active processed template is missing`);
    const template = parseCloudFormationTemplate(body);
    const result = new Set<string>();
    const iamRoles = this.store.ensureAccount().iam.roles;
    for (const [roleLogicalId, definition] of Object.entries(template.Resources)) {
      if (definition.Type !== "AWS::IAM::Role") continue;
      const state = stack.resources[roleLogicalId];
      const stateArn = state?.attributes.Arn;
      if (typeof stateArn === "string" && stateArn) result.add(stateArn);
      if (state?.physicalResourceId && iamRoles[state.physicalResourceId]?.arn) result.add(iamRoles[state.physicalResourceId].arn);
      const roleName = definition.Properties?.RoleName;
      if (typeof roleName === "string" && roleName) {
        const suppliedPath = typeof definition.Properties?.Path === "string" ? definition.Properties.Path : "/";
        const path = suppliedPath.startsWith("/") && suppliedPath.endsWith("/") ? suppliedPath : "/";
        result.add(`arn:aws:iam::${this.store.accountId}:role${path}${roleName}`);
      }
    }
    return result;
  }

  private async authorizeProviderOperation(
    stack: CloudFormationStackState,
    logicalId: string,
    operation: ProviderOperation,
    typeName: string,
    principal: PrincipalContext,
    properties: Readonly<Record<string, unknown>>,
    physicalId?: string,
  ): Promise<void> {
    if (!this.authorizeProviderTargets || typeName === "AWS::CDK::Metadata") return;
    const create = operation === "CREATE"; const update = operation === "UPDATE"; const read = operation === "READ";
    const actions = new Set<string>();
    const add = (...values: string[]) => values.forEach(value => actions.add(value));
    if (typeName === "AWS::IAM::Role") {
      if (create) add("iam:CreateRole", "iam:GetRole");
      if (update) add("iam:GetRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole");
      if (operation === "DELETE") add("iam:GetRole", "iam:DeleteRole");
      if (read) add("iam:GetRole");
      if (operation !== "READ") add("iam:ListAttachedRolePolicies", "iam:ListRolePolicies");
      if (Array.isArray(properties.ManagedPolicyArns) && properties.ManagedPolicyArns.length) add("iam:AttachRolePolicy", "iam:DetachRolePolicy");
      if (Array.isArray(properties.Policies) && properties.Policies.length) add("iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy");
      if (Array.isArray(properties.Tags) && properties.Tags.length) add("iam:TagRole", "iam:UntagRole");
    } else if (typeName === "AWS::IAM::Policy") {
      if (operation === "DELETE") add("iam:DeleteRolePolicy"); else add("iam:PutRolePolicy", "iam:GetRolePolicy");
    } else if (typeName === "AWS::IAM::ManagedPolicy") {
      if (create) add("iam:CreatePolicy", "iam:GetPolicy", "iam:GetPolicyVersion");
      if (update) add("iam:GetPolicy", "iam:GetPolicyVersion", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion");
      if (operation === "DELETE") add("iam:GetPolicy", "iam:DeletePolicy", "iam:ListEntitiesForPolicy", "iam:ListPolicyVersions");
      if (read) add("iam:GetPolicy", "iam:GetPolicyVersion");
      if (operation !== "READ" && Array.isArray(properties.Roles) && properties.Roles.length) add("iam:AttachRolePolicy", "iam:DetachRolePolicy");
    } else if (typeName === "AWS::SSM::Parameter") {
      add("ssm:GetParameter", "ssm:ListTagsForResource");
      if (create) add("ssm:PutParameter", "ssm:AddTagsToResource");
      if (update) add("ssm:PutParameter", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource");
      if (operation === "DELETE") add("ssm:DeleteParameter");
    } else if (typeName === SECRETS_MANAGER_SECRET_TYPE) {
      add(...SECRETS_MANAGER_SECRET_AUTHORIZATION_MATRIX[operation]);
    } else if (typeName === SECRETS_MANAGER_RESOURCE_POLICY_TYPE) {
      add(...SECRETS_MANAGER_RESOURCE_POLICY_AUTHORIZATION_MATRIX[operation]);
    } else if (typeName === SECRETS_MANAGER_ROTATION_SCHEDULE_TYPE) {
      add(...SECRETS_MANAGER_ROTATION_SCHEDULE_AUTHORIZATION_MATRIX[operation]);
    } else if (typeName === SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_TYPE) {
      add(...SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_AUTHORIZATION_MATRIX[operation]);
    } else if (typeName === "AWS::S3::Bucket") {
      add("s3:HeadBucket", "s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketTagging", "s3:GetPublicAccessBlock", "s3:GetBucketWebsite");
      if (create) add("s3:CreateBucket", "s3:PutBucketEncryption", "s3:PutBucketTagging", "s3:PutBucketVersioning");
      if (update) add("s3:PutBucketEncryption", "s3:PutBucketTagging", "s3:DeleteBucketTagging", "s3:PutBucketVersioning", "s3:PutPublicAccessBlock", "s3:DeletePublicAccessBlock", "s3:PutBucketWebsite", "s3:DeleteBucketWebsite");
      if (create && properties.PublicAccessBlockConfiguration !== undefined) add("s3:PutPublicAccessBlock");
      if (create && properties.WebsiteConfiguration !== undefined) add("s3:PutBucketWebsite");
      if (properties.CorsConfiguration !== undefined) {
        add("s3:GetBucketCORS");
        if (create || update) add("s3:PutBucketCORS");
        if (update || operation === "DELETE") add("s3:DeleteBucketCORS");
      }
      if (operation === "DELETE") add("s3:DeleteBucket");
    } else if (typeName === "AWS::S3::BucketPolicy") {
      add("s3:GetBucketPolicy");
      if (create || update) add("s3:PutBucketPolicy");
      if (operation === "DELETE") add("s3:DeleteBucketPolicy");
    } else if (typeName === "AWS::SQS::Queue") {
      add("sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ListQueueTags");
      if (create) add("sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue");
      if (update) add("sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue");
      if (operation === "DELETE") add("sqs:DeleteQueue");
    } else if (typeName === "AWS::SQS::QueuePolicy") {
      add("sqs:ListQueues", "sqs:GetQueueAttributes");
      if (create || update) add("sqs:GetQueueUrl");
      if (create || update || operation === "DELETE") add("sqs:SetQueueAttributes");
    } else if (typeName === "AWS::Events::EventBus") {
      add("events:DescribeEventBus", "events:ListTagsForResource");
      if (create) add("events:CreateEventBus", "events:TagResource", "events:UntagResource");
      if (update) add("events:TagResource", "events:UntagResource");
      if (operation === "DELETE") add("events:DeleteEventBus");
    } else if (typeName === "AWS::Events::Rule") {
      add("events:DescribeRule", "events:ListTargetsByRule", "events:ListTagsForResource");
      if (create || update) add("events:PutRule", "events:PutTargets", "events:RemoveTargets", "events:TagResource", "events:UntagResource");
      if (create) add("events:DeleteRule");
      if (operation === "DELETE") add("events:RemoveTargets", "events:DeleteRule");
    } else if (typeName === "AWS::Lambda::LayerVersionPermission") {
      add("lambda:GetLayerVersionPolicy");
      if (create) add("lambda:AddLayerVersionPermission");
      if (operation === "DELETE") add("lambda:RemoveLayerVersionPermission");
    } else if (typeName === "AWS::Lambda::Url") {
      add("lambda:GetFunctionUrlConfig");
      if (create) add("lambda:CreateFunctionUrlConfig");
      if (update) add("lambda:UpdateFunctionUrlConfig");
      if (operation === "DELETE") add("lambda:DeleteFunctionUrlConfig");
    } else if (typeName === "AWS::Lambda::CodeSigningConfig") {
      add("lambda:ListTags");
      if (read || update || operation === "DELETE") add("lambda:GetCodeSigningConfig");
      if (create) add("lambda:CreateCodeSigningConfig", "lambda:ListCodeSigningConfigs");
      if (update) add("lambda:UpdateCodeSigningConfig", "lambda:TagResource", "lambda:UntagResource");
      if (operation === "DELETE") add("lambda:DeleteCodeSigningConfig");
    } else if (typeName === "AWS::Lambda::LayerVersion") {
      if (create) add("lambda:PublishLayerVersion");
      if (read || operation === "DELETE") add("lambda:GetLayerVersion");
      if (operation === "DELETE") add("lambda:DeleteLayerVersion");
    } else if (typeName === "Custom::CDKBucketDeployment") {
      add("lambda:InvokeFunction");
    } else if (typeName === "AWS::CloudFormation::CustomResource" || typeName.startsWith("Custom::")) {
      add("lambda:InvokeFunction");
    } else if (typeName === "AWS::Lambda::Function") {
      if (create) {
        add(
          "lambda:CreateFunction",
          "lambda:GetFunction",
          "lambda:ListTags",
          "lambda:UpdateFunctionConfiguration",
          "lambda:TagResource",
          "lambda:UntagResource",
          properties.ReservedConcurrentExecutions === undefined
            ? "lambda:DeleteFunctionConcurrency"
            : "lambda:PutFunctionConcurrency",
        );
      }
      if (update) add("lambda:GetFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency");
      if (operation === "DELETE") add("lambda:GetFunction", "lambda:DeleteFunction");
      if (read) add("lambda:GetFunction", "lambda:ListTags");
      if (create || read || update) add("lambda:GetFunctionCodeSigningConfig");
      if (update) add("lambda:PutFunctionCodeSigningConfig", "lambda:DeleteFunctionCodeSigningConfig");
    } else if (typeName === "AWS::Lambda::Permission") {
      if (operation === "DELETE") add("lambda:GetPolicy", "lambda:RemovePermission");
      else {
        add("lambda:GetPolicy");
        if (create) add("lambda:AddPermission");
      }
    } else if (typeName === "AWS::Lambda::Version") {
      if (create) add("lambda:PublishVersion", "lambda:GetFunction", "lambda:ListVersionsByFunction"); else add("lambda:GetFunction");
      if (operation === "DELETE") add("lambda:DeleteFunction");
      if (read) add("lambda:GetProvisionedConcurrencyConfig");
      const previousProvisioned = stack.resources[logicalId]?.properties.ProvisionedConcurrencyConfig;
      if (properties.ProvisionedConcurrencyConfig !== undefined || previousProvisioned !== undefined) {
        if (create || update || operation === "DELETE") add("lambda:GetProvisionedConcurrencyConfig");
        if ((create || update) && properties.ProvisionedConcurrencyConfig !== undefined) add("lambda:PutProvisionedConcurrencyConfig");
        if (update && properties.ProvisionedConcurrencyConfig === undefined && previousProvisioned !== undefined) add("lambda:DeleteProvisionedConcurrencyConfig");
        if (operation === "DELETE") add("lambda:DeleteProvisionedConcurrencyConfig");
      }
    } else if (typeName === "AWS::Lambda::Alias") {
      if (create) add("lambda:CreateAlias", "lambda:GetAlias");
      if (update) add("lambda:UpdateAlias", "lambda:GetAlias");
      if (operation === "DELETE") add("lambda:GetAlias", "lambda:DeleteAlias");
      if (read) add("lambda:GetAlias");
      if (read) add("lambda:GetProvisionedConcurrencyConfig");
      const previousProvisioned = stack.resources[logicalId]?.properties.ProvisionedConcurrencyConfig;
      if (update) add("lambda:GetProvisionedConcurrencyConfig", "lambda:PutProvisionedConcurrencyConfig", "lambda:DeleteProvisionedConcurrencyConfig");
      if (!update && (properties.ProvisionedConcurrencyConfig !== undefined || previousProvisioned !== undefined)) {
        if (create || update || operation === "DELETE") add("lambda:GetProvisionedConcurrencyConfig");
        if ((create || update) && properties.ProvisionedConcurrencyConfig !== undefined) add("lambda:PutProvisionedConcurrencyConfig");
        if (update && properties.ProvisionedConcurrencyConfig === undefined && previousProvisioned !== undefined) add("lambda:DeleteProvisionedConcurrencyConfig");
        if (operation === "DELETE") add("lambda:DeleteProvisionedConcurrencyConfig");
      }
    } else if (typeName === "AWS::Lambda::EventSourceMapping") {
      if (create) add("lambda:ListEventSourceMappings", "lambda:CreateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:ListTags", "lambda:UpdateEventSourceMapping");
      if (update) add("lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings", "lambda:ListTags", "lambda:UpdateEventSourceMapping");
      if (operation === "DELETE") add("lambda:GetEventSourceMapping", "lambda:ListTags", "lambda:DeleteEventSourceMapping");
      if (read) add("lambda:GetEventSourceMapping");
    } else if (typeName === "AWS::Lambda::EventInvokeConfig") {
      add("lambda:GetFunctionEventInvokeConfig");
      if (create || update) add("lambda:PutFunctionEventInvokeConfig");
      if (operation === "DELETE") add("lambda:DeleteFunctionEventInvokeConfig");
    } else if (typeName === "AWS::Logs::LogGroup") {
      if (create) add("logs:CreateLogGroup", "logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource");
      if (update) add("logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource");
      if (operation === "DELETE") add("logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:DeleteLogGroup");
      if (read) add("logs:DescribeLogGroups", "logs:ListTagsForResource");
    } else if (typeName === "AWS::Logs::LogStream") {
      add("logs:DescribeLogStreams");
      if (create) add("logs:CreateLogStream");
      if (operation === "DELETE") add("logs:DeleteLogStream");
    } else if (typeName === "AWS::Logs::MetricFilter") {
      add("logs:DescribeMetricFilters");
      if (create || update) add("logs:PutMetricFilter");
      if (operation === "DELETE") add("logs:DeleteMetricFilter");
    } else if (typeName === "AWS::Logs::SubscriptionFilter") {
      add("logs:DescribeSubscriptionFilters");
      if (create || update) add("logs:PutSubscriptionFilter");
      if (operation === "DELETE") add("logs:DeleteSubscriptionFilter");
    } else if (typeName === "AWS::Logs::Destination") {
      add("logs:DescribeDestinations", "logs:ListTagsForResource");
      if (create || update) add("logs:PutDestination", "logs:PutDestinationPolicy", "logs:TagResource", "logs:UntagResource");
      if (operation === "DELETE") add("logs:DeleteDestination");
    } else if (typeName === "AWS::Logs::ResourcePolicy") {
      add("logs:DescribeResourcePolicies");
      if (create || update) add("logs:PutResourcePolicy");
      if (operation === "DELETE") add("logs:DeleteResourcePolicy");
    } else if (typeName === "AWS::Logs::QueryDefinition") {
      add("logs:DescribeQueryDefinitions");
      if (create || update) add("logs:PutQueryDefinition");
      if (operation === "DELETE") add("logs:DeleteQueryDefinition");
    } else if (typeName === "AWS::CloudWatch::Alarm") {
      add("cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource");
      if (create || update) add("cloudwatch:PutMetricAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource");
      if (operation === "DELETE") add("cloudwatch:DeleteAlarms");
    } else if (typeName === "AWS::CloudWatch::CompositeAlarm") {
      add("cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource");
      if (create || update) add("cloudwatch:PutCompositeAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource");
      if (operation === "DELETE") add("cloudwatch:DeleteAlarms");
    } else if (typeName === "AWS::CloudWatch::Dashboard") {
      add("cloudwatch:GetDashboard");
      if (create || update) add("cloudwatch:PutDashboard");
      if (operation === "DELETE") add("cloudwatch:DeleteDashboards");
    } else if (typeName === "AWS::CloudWatch::AnomalyDetector") {
      add("cloudwatch:DescribeAnomalyDetectors");
      if (create || update) add("cloudwatch:PutAnomalyDetector");
      if (operation === "DELETE") add("cloudwatch:DeleteAnomalyDetector");
    } else if (typeName === "AWS::CloudWatch::InsightRule") {
      add("cloudwatch:DescribeInsightRules", "cloudwatch:ListTagsForResource");
      if (create || update) add("cloudwatch:PutInsightRule", "cloudwatch:TagResource", "cloudwatch:UntagResource");
      if (operation === "DELETE") add("cloudwatch:DeleteInsightRules");
    } else if (typeName === "AWS::CloudWatch::MetricStream") {
      add("cloudwatch:GetMetricStream", "cloudwatch:ListTagsForResource");
      if (create || update) add("cloudwatch:PutMetricStream", "cloudwatch:TagResource", "cloudwatch:UntagResource");
      if (operation === "DELETE") add("cloudwatch:DeleteMetricStream");
    } else if (typeName.startsWith("AWS::ApiGatewayV2::")) {
      if (create) add("apigateway:GET", "apigateway:POST", "apigateway:DELETE");
      if (read) add("apigateway:GET");
      if (update) {
        add("apigateway:GET");
        if (typeName !== "AWS::ApiGatewayV2::Deployment") add("apigateway:PATCH");
        const previous = stack.resources[logicalId]?.properties ?? {};
        const previousTags = previous.Tags && typeof previous.Tags === "object" && !Array.isArray(previous.Tags) ? previous.Tags as Record<string, unknown> : {};
        const desiredTags = properties.Tags && typeof properties.Tags === "object" && !Array.isArray(properties.Tags) ? properties.Tags as Record<string, unknown> : {};
        if (Object.entries(desiredTags).some(([key, value]) => previousTags[key] !== value)) add("apigateway:POST");
        if (Object.keys(previousTags).some(key => !Object.hasOwn(desiredTags, key))
          || typeName === "AWS::ApiGatewayV2::Api" && previous.CorsConfiguration !== undefined && properties.CorsConfiguration === undefined
          || typeName === "AWS::ApiGatewayV2::Stage" && previous.AccessLogSettings !== undefined && properties.AccessLogSettings === undefined) add("apigateway:DELETE");
      }
      if (operation === "DELETE") add("apigateway:DELETE");
    } else if (typeName.startsWith("AWS::ApiGateway::")) {
      if (typeName === "AWS::ApiGateway::RestApi") {
        if (create) add("apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE");
        if (update) add("apigateway:GET", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
      } else if (typeName === "AWS::ApiGateway::Resource") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update || read) add("apigateway:GET");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
      } else if (typeName === "AWS::ApiGateway::Method") {
        if (create || update) add("apigateway:GET", "apigateway:PUT", "apigateway:DELETE");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
      } else if (typeName === "AWS::ApiGateway::Deployment") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update || read) add("apigateway:GET");
        if (operation === "DELETE") add("apigateway:DELETE");
      } else if (typeName === "AWS::ApiGateway::Stage") {
        if (create) add("apigateway:GET", "apigateway:POST", "apigateway:PATCH", "apigateway:DELETE");
        if (update) add("apigateway:GET", "apigateway:PATCH");
        if ((create || update) && (Array.isArray(properties.Tags) && properties.Tags.length || Array.isArray(stack.resources[logicalId]?.properties.Tags) && (stack.resources[logicalId].properties.Tags as unknown[]).length)) add("apigateway:PUT", "apigateway:DELETE");
        if (operation === "DELETE") add("apigateway:DELETE");
      } else if (typeName === "AWS::ApiGateway::Account") {
        if (create || update) add("apigateway:GET", "apigateway:PATCH");
        if (read) add("apigateway:GET");
      } else if (typeName === "AWS::ApiGateway::Authorizer" || typeName === "AWS::ApiGateway::Model" || typeName === "AWS::ApiGateway::RequestValidator"
        || typeName === "AWS::ApiGateway::DomainName" || typeName === "AWS::ApiGateway::DomainNameV2"
        || typeName === "AWS::ApiGateway::VpcLink" || typeName === "AWS::ApiGateway::ClientCertificate"
        || typeName === "AWS::ApiGateway::DocumentationPart") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update) add("apigateway:GET", "apigateway:PATCH");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
        if (read) add("apigateway:GET");
        const previousTags = stack.resources[logicalId]?.properties.Tags;
        if ((typeName === "AWS::ApiGateway::DomainName" || typeName === "AWS::ApiGateway::DomainNameV2"
          || typeName === "AWS::ApiGateway::VpcLink" || typeName === "AWS::ApiGateway::ClientCertificate")
          && update && (Array.isArray(properties.Tags) || Array.isArray(previousTags))) add("apigateway:PUT", "apigateway:DELETE");
      } else if (typeName === "AWS::ApiGateway::BasePathMapping" || typeName === "AWS::ApiGateway::BasePathMappingV2") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update) add("apigateway:GET", "apigateway:PATCH");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
        if (read) add("apigateway:GET");
      } else if (typeName === "AWS::ApiGateway::DomainNameAccessAssociation") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
        if (read) add("apigateway:GET");
      } else if (typeName === "AWS::ApiGateway::DocumentationVersion") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update) add("apigateway:GET", "apigateway:PATCH");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
        if (read) add("apigateway:GET");
      } else if (typeName === "AWS::ApiGateway::GatewayResponse") {
        if (create || update) add("apigateway:GET", "apigateway:PUT");
        if (operation === "DELETE") add("apigateway:GET", "apigateway:DELETE");
        if (read) add("apigateway:GET");
      } else if (typeName === "AWS::ApiGateway::ApiKey" || typeName === "AWS::ApiGateway::UsagePlan") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update) add("apigateway:GET", "apigateway:PATCH");
        if (update && Array.isArray(properties.Tags)) add("apigateway:PUT", "apigateway:DELETE");
        if (operation === "DELETE") add("apigateway:DELETE");
        if (read) add("apigateway:GET");
      } else if (typeName === "AWS::ApiGateway::UsagePlanKey") {
        if (create) add("apigateway:GET", "apigateway:POST");
        if (update || read) add("apigateway:GET");
        if (operation === "DELETE") add("apigateway:DELETE");
      }
      if (read) add("apigateway:GET");
    } else if (typeName === "AWS::RDS::DBInstance") {
      add("rds:DescribeDBInstances", "rds:ListTagsForResource");
      if (create) add("rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:DeleteDBInstance", "rds:AddTagsToResource", "rds:RemoveTagsFromResource");
      if (update) add("rds:ModifyDBInstance", "rds:AddTagsToResource", "rds:RemoveTagsFromResource");
      if (operation === "DELETE") add("rds:DeleteDBInstance");
    } else if (typeName === "AWS::RDS::DBParameterGroup") {
      add("rds:DescribeDBParameterGroups", "rds:DescribeDBParameters", "rds:ListTagsForResource");
      if (create) add("rds:CreateDBParameterGroup", "rds:ModifyDBParameterGroup", "rds:ResetDBParameterGroup", "rds:DeleteDBParameterGroup", "rds:AddTagsToResource", "rds:RemoveTagsFromResource");
      if (update) add("rds:ModifyDBParameterGroup", "rds:ResetDBParameterGroup", "rds:AddTagsToResource", "rds:RemoveTagsFromResource");
      if (operation === "DELETE") add("rds:DeleteDBParameterGroup");
    } else if (typeName === "AWS::DynamoDB::GlobalTable") {
      add("dynamodb:DescribeTable", "dynamodb:ListTagsOfResource");
      if (create) add("dynamodb:CreateTable", "dynamodb:UpdateTable");
      if (update) add("dynamodb:UpdateTable");
      if (operation === "DELETE") add("dynamodb:DeleteTable", "dynamodb:UpdateTable");
    } else if (typeName === "AWS::DynamoDB::Table") {
      add("dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:DescribeContinuousBackups", "dynamodb:ListTagsOfResource");
      if (create) add("dynamodb:CreateTable");
      if (update) add("dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive", "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateContributorInsights", "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:GetResourcePolicy", "dynamodb:PutResourcePolicy", "dynamodb:DeleteResourcePolicy");
      if (operation === "DELETE") add("dynamodb:DeleteTable", "dynamodb:GetResourcePolicy", "dynamodb:DeleteResourcePolicy");
      if (properties.StreamSpecification !== undefined) add("dynamodb:DescribeStream");
      if (properties.ContributorInsightsSpecification !== undefined || Array.isArray(properties.GlobalSecondaryIndexes) && properties.GlobalSecondaryIndexes.some((index: any) => index?.ContributorInsightsSpecification !== undefined)) add("dynamodb:DescribeContributorInsights");
      if (properties.ResourcePolicy !== undefined) add("dynamodb:GetResourcePolicy", "dynamodb:PutResourcePolicy");
      if (Array.isArray(properties.Tags) && properties.Tags.length) add("dynamodb:TagResource");
    } else if (typeName === "AWS::StepFunctions::StateMachine") {
      if (create) add("states:CreateStateMachine", "states:DescribeStateMachine", "states:ListTagsForResource");
      if (update) add("states:DescribeStateMachine", "states:UpdateStateMachine", "states:ListTagsForResource", "states:TagResource", "states:UntagResource");
      if (operation === "DELETE") add("states:DescribeStateMachine", "states:ListTagsForResource", "states:DeleteStateMachine");
      if (read) add("states:DescribeStateMachine", "states:ListTagsForResource");
    } else if (typeName === "AWS::AppSync::GraphQLApi") {
      add("appsync:GetGraphqlApi");
      if (create) add("appsync:CreateGraphqlApi", "appsync:TagResource");
      if (update) add("appsync:UpdateGraphqlApi", "appsync:TagResource", "appsync:UntagResource");
      if (operation === "DELETE") add("appsync:DeleteGraphqlApi");
    } else if (typeName === "AWS::AppSync::GraphQLSchema") {
      add("appsync:GetSchemaCreationStatus");
      if (create || update) add("appsync:StartSchemaCreation");
    } else if (typeName === "AWS::AppSync::ApiKey") {
      add("appsync:ListApiKeys");
      if (create) add("appsync:CreateApiKey");
      if (update) add("appsync:UpdateApiKey");
      if (operation === "DELETE") add("appsync:DeleteApiKey");
    } else if (typeName === "AWS::AppSync::DataSource") {
      add("appsync:GetDataSource");
      if (create) add("appsync:CreateDataSource");
      if (update) add("appsync:UpdateDataSource");
      if (operation === "DELETE") add("appsync:DeleteDataSource");
      if ((create || update) && typeof properties.ServiceRoleArn === "string") add("iam:PassRole");
    } else if (typeName === "AWS::AppSync::FunctionConfiguration") {
      if (create) add("appsync:ListFunctions", "appsync:CreateFunction");
      else add("appsync:GetFunction");
      if (update) add("appsync:UpdateFunction");
      if (operation === "DELETE") add("appsync:DeleteFunction");
    } else if (typeName === "AWS::AppSync::Resolver") {
      add("appsync:GetResolver");
      if (create) add("appsync:CreateResolver");
      if (update) add("appsync:UpdateResolver");
      if (operation === "DELETE") add("appsync:DeleteResolver");
    } else if ((COGNITO_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName)) {
      add(...COGNITO_CLOUDFORMATION_AUTHORIZATION_MATRIX[
        typeName as keyof typeof COGNITO_CLOUDFORMATION_AUTHORIZATION_MATRIX
      ][operation]);
      if (typeName === COGNITO_USER_POOL_GROUP_TYPE
        && (create || update)
        && typeof properties.RoleArn === "string"
        && properties.RoleArn) add("iam:PassRole");
    } else if ((SES_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName)) {
      add(...SES_CLOUDFORMATION_AUTHORIZATION_MATRIX[typeName as keyof typeof SES_CLOUDFORMATION_AUTHORIZATION_MATRIX][operation]);
    } else if ((SNS_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName)) {
      add(...SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX[typeName as keyof typeof SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX][operation]);
      if (typeName === "AWS::SNS::Topic" && Array.isArray(properties.DeliveryStatusLogging)
        && properties.DeliveryStatusLogging.some((item: any) => item?.SuccessFeedbackRoleArn || item?.FailureFeedbackRoleArn)) add("iam:PassRole");
    }
    const targets: ProviderAuthorizationTarget[] = [];
    const seenTargets = new Set<string>();
    const addTarget = (action: string, resource: string, context?: Readonly<Record<string, unknown>>) => {
      const key = canonical({ action, resource, context });
      if (seenTargets.has(key)) return;
      seenTargets.add(key); targets.push({ action, resource, ...(context ? { context } : {}) });
    };
    const iamRoleArn = (name: unknown, path = "/"): string | undefined => {
      if (typeof name !== "string" || !name) return undefined;
      if (name.startsWith("arn:")) return name;
      const stored = this.store.ensureAccount().iam.roles[name]?.arn;
      return stored ?? `arn:aws:iam::${this.store.accountId}:role${path}${name}`;
    };
    const lambdaArn = (value: unknown): string | undefined => typeof value !== "string" || !value ? undefined : value.startsWith("arn:") ? value : `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${value}`;
    const tags = (value: unknown): Array<{ Key: string; Value: string }> => Array.isArray(value) ? value.filter((tag: any) => typeof tag?.Key === "string").map((tag: any) => ({ Key: String(tag.Key), Value: String(tag.Value ?? "") })) : [];
    const accountId = this.store.accountId;

    for (const action of [...actions].sort()) {
      let resources: string[] = [];
      let context: Readonly<Record<string, unknown>> | undefined;
      if (typeName === "AWS::IAM::Role") {
        if ((action === "iam:AttachRolePolicy" || action === "iam:DetachRolePolicy") && Array.isArray(properties.ManagedPolicyArns)) resources = properties.ManagedPolicyArns.filter((arn): arn is string => typeof arn === "string" && arn.length > 0);
        if (!resources.length) {
          const path = typeof properties.Path === "string" ? properties.Path : "/";
          const arn = iamRoleArn(properties.RoleName ?? physicalId, path); if (arn) resources.push(arn);
        }
      } else if (typeName === "AWS::IAM::Policy") {
        resources = (Array.isArray(properties.Roles) ? properties.Roles : []).map(role => iamRoleArn(role)).filter((arn): arn is string => arn !== undefined);
      } else if (typeName === "AWS::IAM::ManagedPolicy") {
        const path = typeof properties.Path === "string" ? properties.Path : "/";
        const name = properties.ManagedPolicyName;
        const arn = typeof physicalId === "string" && physicalId.startsWith("arn:") ? physicalId : typeof name === "string" && name ? `arn:aws:iam::${accountId}:policy${path}${name}`.replace("policy//", "policy/") : undefined;
        if (arn) resources.push(arn);
      } else if (typeName === "AWS::SSM::Parameter") {
        const name = properties.Name ?? physicalId;
        if (typeof name === "string" && name) resources.push(`arn:aws:ssm:${this.region}:${accountId}:parameter/${name.replace(/^\/+/, "")}`);
        const requested = properties.Tags && typeof properties.Tags === "object" && !Array.isArray(properties.Tags) ? properties.Tags as Record<string, unknown> : {};
        context = { "aws:TagKeys": Object.keys(requested), ...Object.fromEntries(Object.entries(requested).map(([key, value]) => [`aws:RequestTag/${key}`, String(value)])) };
      } else if (typeName === SECRETS_MANAGER_SECRET_TYPE) {
        if (action === "secretsmanager:GetRandomPassword") resources.push("*");
        else {
          const supplied = physicalId ?? properties.Name;
          if (typeof supplied === "string" && supplied) resources.push(supplied.startsWith("arn:") ? supplied : `arn:aws:secretsmanager:${this.region}:${accountId}:secret:${supplied}-*`);
          else resources.push(`arn:aws:secretsmanager:${this.region}:${accountId}:secret:*`);
        }
        const requestedTags = tags(properties.Tags);
        context = { "aws:TagKeys": requestedTags.map(tag => tag.Key), ...Object.fromEntries(requestedTags.map(tag => [`aws:RequestTag/${tag.Key}`, tag.Value])), "secretsmanager:ForceDeleteWithoutRecovery": operation === "DELETE" };
      } else if (typeName === SECRETS_MANAGER_RESOURCE_POLICY_TYPE) {
        const supplied = properties.SecretId ?? physicalId;
        if (typeof supplied === "string" && supplied) resources.push(supplied.startsWith("arn:") ? supplied : `arn:aws:secretsmanager:${this.region}:${accountId}:secret:${supplied}-*`);
        context = { "secretsmanager:BlockPublicPolicy": properties.BlockPublicPolicy === true };
      } else if (typeName === "AWS::S3::Bucket" || typeName === "AWS::S3::BucketPolicy") {
        const bucketName = typeName === "AWS::S3::Bucket" ? properties.BucketName ?? physicalId : properties.Bucket ?? physicalId;
        if (typeof bucketName === "string" && bucketName) resources.push(`arn:aws:s3:::${bucketName}`);
      } else if (typeName === "AWS::SQS::Queue") {
        const queueName = properties.QueueName ?? physicalId;
        if (typeof queueName === "string" && queueName) resources.push(`arn:aws:sqs:${this.region}:${accountId}:${queueName}`);
      } else if (typeName === "AWS::SQS::QueuePolicy") {
        if (action === "sqs:ListQueues" || action === "sqs:GetQueueAttributes") {
          resources.push("*");
        }
        const previousQueues = stack.resources[logicalId]?.properties.Queues;
        const queues = [
          ...(Array.isArray(properties.Queues) ? properties.Queues : []),
          ...(Array.isArray(previousQueues) ? previousQueues : []),
        ];
        for (const queue of queues) {
          if (typeof queue !== "string" || !queue) continue;
          const name = queue.startsWith("arn:") ? queue.match(/:([^:]+)$/)?.[1] : (() => {
            try { return new URL(queue).pathname.split("/").filter(Boolean).at(-1); } catch { return queue; }
          })();
          if (name && (action === "sqs:GetQueueUrl" || action === "sqs:SetQueueAttributes")) {
            resources.push(`arn:aws:sqs:${this.region}:${accountId}:${name}`);
          }
        }
      } else if ((SNS_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName) && action === "iam:PassRole") {
        resources.push(...(Array.isArray(properties.DeliveryStatusLogging) ? properties.DeliveryStatusLogging : [])
          .flatMap((item: any) => [item?.SuccessFeedbackRoleArn, item?.FailureFeedbackRoleArn])
          .filter((value: unknown): value is string => typeof value === "string" && value.startsWith("arn:")));
        context = { "iam:PassedToService": "sns.amazonaws.com" };
      } else if ((COGNITO_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName) && action === "iam:PassRole") {
        if (typeof properties.RoleArn === "string" && properties.RoleArn) resources.push(properties.RoleArn);
        context = { "iam:PassedToService": "cognito-idp.amazonaws.com" };
      } else if ((COGNITO_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName)) {
        const poolId = typeName === COGNITO_USER_POOL_TYPE
          ? physicalId
          : typeof properties.UserPoolId === "string"
            ? properties.UserPoolId
            : undefined;
        if (action === "cognito-idp:CreateUserPool" || action === "cognito-idp:ListUserPools") {
          resources.push("*");
        } else if (typeof poolId === "string" && poolId) {
          resources.push(`arn:aws:cognito-idp:${this.region}:${accountId}:userpool/${poolId}`);
          if (typeName === COGNITO_USER_POOL_TYPE) {
            const current = this.store.regionState(this.region).cognito.pools[poolId];
            const requestTags = properties.UserPoolTags && typeof properties.UserPoolTags === "object" && !Array.isArray(properties.UserPoolTags)
              ? properties.UserPoolTags as Record<string, unknown>
              : {};
            context = {
              ...Object.fromEntries(Object.entries(current?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
              ...Object.fromEntries(Object.entries(requestTags).map(([key, value]) => [`aws:RequestTag/${key}`, String(value)])),
              "aws:TagKeys": Object.keys(requestTags),
            };
          }
        }
      } else if ((SNS_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName)) {
        const candidates: unknown[] = [];
        if (typeName === "AWS::SNS::Topic") {
          candidates.push(physicalId, properties.TopicArn);
          if (typeof properties.TopicName === "string") candidates.push(`arn:aws:sns:${this.region}:${accountId}:${properties.TopicName}`);
        } else if (typeName === "AWS::SNS::Subscription") {
          candidates.push(properties.TopicArn);
          if (typeof physicalId === "string") candidates.push(physicalId.replace(/:[^:]+$/, ""));
        } else if (typeName === "AWS::SNS::TopicInlinePolicy") candidates.push(properties.TopicArn);
        else {
          candidates.push(...(Array.isArray(properties.Topics) ? properties.Topics : []));
          const previous = stack.resources[logicalId]?.properties.Topics;
          candidates.push(...(Array.isArray(previous) ? previous : []));
        }
        resources.push(...candidates.filter((value): value is string => typeof value === "string" && /^arn:aws:sns:[^:]+:\d{12}:[^:]+$/.test(value)));
      } else if (typeName === "AWS::Events::EventBus") {
        const supplied = properties.Name ?? physicalId;
        if (typeof supplied === "string" && supplied) resources.push(supplied.startsWith("arn:") ? supplied : `arn:aws:events:${this.region}:${accountId}:event-bus/${supplied}`);
      } else if (typeName === "AWS::Events::Rule") {
        if (typeof physicalId === "string" && physicalId.startsWith("arn:")) resources.push(physicalId);
        else {
          const name = properties.Name ?? physicalId;
          const rawBus = typeof properties.EventBusName === "string" && properties.EventBusName ? properties.EventBusName : "default";
          const bus = rawBus.startsWith("arn:") ? rawBus.match(/:event-bus\/(.+)$/)?.[1] ?? rawBus : rawBus;
          if (typeof name === "string" && name) resources.push(`arn:aws:events:${this.region}:${accountId}:rule/${bus === "default" ? "" : `${bus}/`}${name}`);
        }
      } else if (typeName === "AWS::Lambda::LayerVersion") {
        if (typeof physicalId === "string" && physicalId.startsWith("arn:")) resources.push(physicalId);
        else if (typeof properties.LayerName === "string" && properties.LayerName) resources.push(`arn:aws:lambda:${this.region}:${accountId}:layer:${properties.LayerName}`);
        else resources.push(`arn:aws:lambda:${this.region}:${accountId}:layer:*`);
      } else if (typeName === "AWS::Lambda::LayerVersionPermission") {
        const arn = properties.LayerVersionArn ?? physicalId;
        if (typeof arn === "string" && arn.startsWith("arn:")) resources.push(arn);
      } else if (typeName === "AWS::Lambda::Url") {
        const arn = lambdaArn(properties.TargetFunctionArn);
        if (arn) resources.push(typeof properties.Qualifier === "string" && properties.Qualifier ? `${arn}:${properties.Qualifier}` : arn);
      } else if (typeName === "AWS::Lambda::CodeSigningConfig") {
        if (action === "lambda:CreateCodeSigningConfig" || action === "lambda:ListCodeSigningConfigs") resources.push("*");
        else if (typeof physicalId === "string" && physicalId.startsWith("arn:")) resources.push(physicalId);
        else resources.push(`arn:aws:lambda:${this.region}:${accountId}:code-signing-config:*`);
      } else if (typeName === "Custom::CDKBucketDeployment") {
        const arn = lambdaArn(properties.ServiceToken); if (arn) resources.push(arn);
      } else if (typeName === "AWS::CloudFormation::CustomResource" || typeName.startsWith("Custom::")) {
        const arn = lambdaArn(properties.ServiceToken); if (arn) resources.push(arn);
      } else if (typeName === "AWS::Lambda::EventSourceMapping") {
        const functionResource = lambdaArn(properties.FunctionName);
        const mappingResource = typeof physicalId === "string" && physicalId ? `arn:aws:lambda:${this.region}:${accountId}:event-source-mapping:${physicalId}` : `arn:aws:lambda:${this.region}:${accountId}:event-source-mapping:*`;
        if (action === "lambda:ListEventSourceMappings") resources.push("*");
        else if (action === "lambda:CreateEventSourceMapping" && functionResource) resources.push(functionResource);
        else resources.push(mappingResource);
      } else if (typeName === "AWS::Lambda::EventInvokeConfig") {
        const name = properties.FunctionName ?? (typeof physicalId === "string" ? physicalId.slice(0, physicalId.lastIndexOf("|")) : undefined);
        const arn = lambdaArn(name); if (arn) resources.push(arn);
      } else if (typeName === "AWS::Lambda::Version") {
        const functionArn = lambdaArn(properties.FunctionName);
        const provisionedAction = action === "lambda:GetProvisionedConcurrencyConfig"
          || action === "lambda:PutProvisionedConcurrencyConfig"
          || action === "lambda:DeleteProvisionedConcurrencyConfig";
        if (provisionedAction && typeof physicalId === "string" && physicalId.startsWith("arn:")) resources.push(physicalId);
        else if (provisionedAction && create && functionArn) resources.push(`${functionArn}:*`);
        else if (functionArn) resources.push(functionArn);
      } else if (typeName === "AWS::Lambda::Alias") {
        const functionArn = lambdaArn(properties.FunctionName);
        const provisionedAction = action === "lambda:GetProvisionedConcurrencyConfig"
          || action === "lambda:PutProvisionedConcurrencyConfig"
          || action === "lambda:DeleteProvisionedConcurrencyConfig";
        if (provisionedAction && typeof physicalId === "string" && physicalId.startsWith("arn:")) resources.push(physicalId);
        else if (provisionedAction && functionArn && typeof properties.Name === "string" && properties.Name) resources.push(`${functionArn}:${properties.Name}`);
        else if (functionArn) resources.push(functionArn);
      } else if (typeName === "AWS::Lambda::Function") {
        const arn = lambdaArn(properties.FunctionName);
        if (arn) resources.push(arn);
      } else if (typeName.startsWith("AWS::Lambda::")) {
        const arn = lambdaArn(properties.FunctionName); if (arn) resources.push(arn);
      } else if (typeName === "AWS::Logs::LogGroup") {
        if (typeof properties.LogGroupName === "string" && properties.LogGroupName) resources.push(`arn:aws:logs:${this.region}:${accountId}:log-group:${properties.LogGroupName}:*`);
      } else if (typeName === "AWS::Logs::LogStream" || typeName === "AWS::Logs::MetricFilter" || typeName === "AWS::Logs::SubscriptionFilter") {
        let group = typeof properties.LogGroupName === "string" ? properties.LogGroupName : undefined;
        let stream = typeName === "AWS::Logs::LogStream" && typeof properties.LogStreamName === "string" ? properties.LogStreamName : undefined;
        if ((!group || typeName === "AWS::Logs::LogStream" && !stream) && typeof physicalId === "string") {
          const kind = typeName === "AWS::Logs::LogStream" ? "log-stream" : typeName === "AWS::Logs::MetricFilter" ? "metric-filter" : "subscription-filter";
          if (physicalId.startsWith(`${kind}:`)) try {
            const values = JSON.parse(Buffer.from(physicalId.slice(kind.length + 1), "base64url").toString("utf8"));
            if (Array.isArray(values)) { group ??= typeof values[0] === "string" ? values[0] : undefined; if (typeName === "AWS::Logs::LogStream") stream ??= typeof values[1] === "string" ? values[1] : undefined; }
          } catch { /* Provider reports malformed physical identifiers. */ }
        }
        if (group) resources.push(typeName === "AWS::Logs::LogStream" && stream && action !== "logs:DescribeLogStreams"
          ? `arn:aws:logs:${this.region}:${accountId}:log-group:${group}:log-stream:${stream}`
          : `arn:aws:logs:${this.region}:${accountId}:log-group:${group}:*`);
      } else if (typeName === "AWS::Logs::Destination") {
        const name = properties.DestinationName ?? physicalId;
        if (action === "logs:DescribeDestinations") resources.push("*");
        else if (typeof name === "string" && name) resources.push(`arn:aws:logs:${this.region}:${accountId}:destination:${name}`);
      } else if (typeName === "AWS::CloudWatch::Alarm" || typeName === "AWS::CloudWatch::CompositeAlarm") {
        const name = properties.AlarmName ?? physicalId;
        if (typeName === "AWS::CloudWatch::CompositeAlarm" && action === "cloudwatch:DescribeAlarms" && (create || update)) resources.push("*");
        else if (typeof name === "string" && name) resources.push(`arn:aws:cloudwatch:${this.region}:${accountId}:alarm:${name}`);
      } else if (typeName === "AWS::CloudWatch::Dashboard") {
        const name = properties.DashboardName ?? physicalId;
        if (typeof name === "string" && name) resources.push(`arn:aws:cloudwatch::${accountId}:dashboard/${name}`);
      } else if (typeName === "AWS::CloudWatch::InsightRule") {
        const name = properties.RuleName ?? physicalId;
        if (action === "cloudwatch:DescribeInsightRules") resources.push("*");
        else if (typeof name === "string" && name) resources.push(`arn:aws:cloudwatch:${this.region}:${accountId}:insight-rule/${name}`);
      } else if (typeName === "AWS::CloudWatch::MetricStream") {
        const name = properties.Name ?? physicalId;
        if (typeof name === "string" && name) resources.push(name.startsWith("arn:") ? name : `arn:aws:cloudwatch:${this.region}:${accountId}:metric-stream/${name}`);
      } else if (typeName === "AWS::RDS::DBInstance") {
        const identifier = properties.DBInstanceIdentifier ?? physicalId;
        if (typeof identifier === "string" && identifier) resources.push(`arn:aws:rds:${this.region}:${accountId}:db:${identifier.toLowerCase()}`);
        const current = typeof identifier === "string" ? this.store.regionState(this.region).rdsDbInstances[identifier.toLowerCase()] : undefined;
        const previousTags = tags(stack.resources[logicalId]?.properties.Tags); const desiredTags = tags(properties.Tags);
        const previousMap = Object.fromEntries(previousTags.map(tag => [tag.Key, tag.Value])); const desiredMap = Object.fromEntries(desiredTags.map(tag => [tag.Key, tag.Value]));
        let requestTags: Array<{ Key: string; Value: string }> = []; let tagKeys: string[] = [];
        if (action === "rds:CreateDBInstance") {
          requestTags = [...desiredTags,
            { Key: "stacksim:cloudformation:owner", Value: createHash("sha256").update(`${stack.stackId}\0${logicalId}`).digest("hex") },
            { Key: "stacksim:cloudformation:explicit-identifier", Value: String(properties.DBInstanceIdentifier !== undefined) }];
          tagKeys = requestTags.map(tag => tag.Key);
        } else if (action === "rds:AddTagsToResource") {
          requestTags = create ? [...desiredTags,
            { Key: "stacksim:cloudformation:owner", Value: createHash("sha256").update(`${stack.stackId}\0${logicalId}`).digest("hex") },
            { Key: "stacksim:cloudformation:explicit-identifier", Value: String(properties.DBInstanceIdentifier !== undefined) }]
            : desiredTags.filter(tag => previousMap[tag.Key] !== tag.Value);
          tagKeys = requestTags.map(tag => tag.Key);
        } else if (action === "rds:RemoveTagsFromResource") tagKeys = Object.keys(previousMap).filter(key => !Object.hasOwn(desiredMap, key));
        context = {
          ...Object.fromEntries(Object.entries(current?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
          ...((action === "rds:CreateDBInstance" || action === "rds:AddTagsToResource" || action === "rds:RemoveTagsFromResource") ? { "aws:TagKeys": tagKeys } : {}),
          ...Object.fromEntries(requestTags.map(tag => [`aws:RequestTag/${tag.Key}`, tag.Value])),
        };
      } else if (typeName === "AWS::RDS::DBParameterGroup") {
        const name = properties.DBParameterGroupName ?? physicalId;
        if (typeof name === "string" && name) resources.push(`arn:aws:rds:${this.region}:${accountId}:pg:${name.toLowerCase()}`);
        const current = typeof name === "string" ? this.store.regionState(this.region).rdsDbParameterGroups[name.toLowerCase()] : undefined;
        const previousTags = tags(stack.resources[logicalId]?.properties.Tags); const desiredTags = tags(properties.Tags);
        const previousMap = Object.fromEntries(previousTags.map(tag => [tag.Key, tag.Value])); const desiredMap = Object.fromEntries(desiredTags.map(tag => [tag.Key, tag.Value]));
        let requestTags: Array<{ Key: string; Value: string }> = []; let tagKeys: string[] = [];
        if (action === "rds:CreateDBParameterGroup") {
          requestTags = [...desiredTags, { Key: "stacksim:cloudformation:owner", Value: createHash("sha256").update(`${stack.stackId}\0${logicalId}`).digest("hex") }]; tagKeys = requestTags.map(tag => tag.Key);
        } else if (action === "rds:AddTagsToResource") {
          requestTags = create ? [...desiredTags, { Key: "stacksim:cloudformation:owner", Value: createHash("sha256").update(`${stack.stackId}\0${logicalId}`).digest("hex") }] : desiredTags.filter(tag => previousMap[tag.Key] !== tag.Value);
          tagKeys = requestTags.map(tag => tag.Key);
        } else if (action === "rds:RemoveTagsFromResource") tagKeys = Object.keys(previousMap).filter(key => !Object.hasOwn(desiredMap, key));
        context = {
          ...Object.fromEntries(Object.entries(current?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
          ...((action === "rds:CreateDBParameterGroup" || action === "rds:AddTagsToResource" || action === "rds:RemoveTagsFromResource") ? { "aws:TagKeys": tagKeys } : {}),
          ...Object.fromEntries(requestTags.map(tag => [`aws:RequestTag/${tag.Key}`, tag.Value])),
        };
      } else if (typeName === "AWS::DynamoDB::GlobalTable") {
        const tableName = properties.TableName ?? physicalId;
        if (typeof tableName === "string" && tableName) {
          const regions = new Set<string>([this.region]);
          if (action === "dynamodb:UpdateTable") {
            const previousReplicas = stack.resources[logicalId]?.properties.Replicas;
            for (const replicas of [properties.Replicas, previousReplicas]) {
              for (const replica of Array.isArray(replicas) ? replicas : []) {
                if (replica && typeof replica === "object" && !Array.isArray(replica) && typeof (replica as any).Region === "string") regions.add((replica as any).Region);
              }
            }
          }
          for (const region of [...regions].sort()) resources.push(`arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`);
          if (action === "dynamodb:CreateTable") {
            const owner = createHash("sha256").update(`${stack.stackId}\0${logicalId}`).digest("hex");
            context = {
              "aws:TagKeys": ["stacksim:cloudformation:owner"],
              "aws:RequestTag/stacksim:cloudformation:owner": owner,
            };
          }
        }
      } else if (typeName === "AWS::DynamoDB::Table") {
        const tableName = properties.TableName ?? physicalId;
        if (typeof tableName === "string" && tableName) {
          const tableArn = `arn:aws:dynamodb:${this.region}:${accountId}:table/${tableName}`;
          const authoritativeStreamArn = this.store.regionState(this.region).tables[tableName]?.latestStreamArn;
          const streamArn = typeof stack.resources[logicalId]?.attributes.StreamArn === "string" ? String(stack.resources[logicalId].attributes.StreamArn) : authoritativeStreamArn ?? `${tableArn}/stream/*`;
          if (action === "dynamodb:DescribeStream") resources.push(streamArn);
          else if (action === "dynamodb:DescribeContributorInsights" || action === "dynamodb:UpdateContributorInsights") {
            resources.push(tableArn);
            for (const index of Array.isArray(properties.GlobalSecondaryIndexes) ? properties.GlobalSecondaryIndexes : []) if (typeof (index as any)?.IndexName === "string") resources.push(`${tableArn}/index/${(index as any).IndexName}`);
          } else if (action === "dynamodb:GetResourcePolicy" || action === "dynamodb:PutResourcePolicy" || action === "dynamodb:DeleteResourcePolicy") {
            resources.push(tableArn);
            if (properties.StreamSpecification !== undefined || stack.resources[logicalId]?.properties.StreamSpecification !== undefined) resources.push(streamArn);
          } else resources.push(tableArn);
          const previousTags = tags(stack.resources[logicalId]?.properties.Tags); const desiredTags = tags(properties.Tags);
          const previousMap = Object.fromEntries(previousTags.map(tag => [tag.Key, tag.Value])); const desiredMap = Object.fromEntries(desiredTags.map(tag => [tag.Key, tag.Value]));
          let requestTags: Array<{ Key: string; Value: string }> = [];
          let tagKeys: string[] = [];
          if (action === "dynamodb:CreateTable") {
            const owner = createHash("sha256").update(`${stack.stackId}\0${logicalId}`).digest("hex");
            requestTags = [...desiredTags, { Key: "stacksim:cloudformation:owner", Value: owner }]; tagKeys = requestTags.map(tag => tag.Key);
          } else if (action === "dynamodb:TagResource") {
            requestTags = desiredTags.filter(tag => previousMap[tag.Key] !== tag.Value); tagKeys = requestTags.map(tag => tag.Key);
          } else if (action === "dynamodb:UntagResource") tagKeys = Object.keys(previousMap).filter(key => !Object.hasOwn(desiredMap, key));
          context = { "aws:TagKeys": tagKeys, ...Object.fromEntries(requestTags.map(tag => [`aws:RequestTag/${tag.Key}`, tag.Value])) };
        }
      } else if (typeName === "AWS::StepFunctions::StateMachine") {
        const name = properties.StateMachineName;
        const arn = typeof physicalId === "string" && physicalId.startsWith("arn:")
          ? physicalId
          : typeof name === "string" && name
            ? `arn:aws:states:${this.region}:${accountId}:stateMachine:${name}`
            : `arn:aws:states:${this.region}:${accountId}:stateMachine:*`;
        resources.push(arn);
        const current = this.store.regionState(this.region).stepFunctions.stateMachines[arn];
        const requestTags = tags(properties.Tags);
        context = {
          ...Object.fromEntries(Object.entries(current?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
          ...Object.fromEntries(requestTags.map(tag => [`aws:RequestTag/${tag.Key}`, tag.Value])),
          "aws:TagKeys": requestTags.map(tag => tag.Key),
        };
      } else if (typeName.startsWith("AWS::AppSync::")) {
        if (action === "iam:PassRole") {
          if (typeof properties.ServiceRoleArn === "string") resources.push(properties.ServiceRoleArn);
          context = { "iam:PassedToService": "appsync.amazonaws.com" };
        } else {
          const apiId = typeName === "AWS::AppSync::GraphQLApi"
            ? (typeof physicalId === "string" && !physicalId.includes(":") ? physicalId : undefined)
            : typeof properties.ApiId === "string" ? properties.ApiId : undefined;
          const apiScoped = new Set([
            "appsync:GetGraphqlApi", "appsync:CreateGraphqlApi", "appsync:UpdateGraphqlApi",
            "appsync:DeleteGraphqlApi", "appsync:TagResource", "appsync:UntagResource",
          ]);
          resources.push(apiId && apiScoped.has(action)
            ? `arn:aws:appsync:${this.region}:${accountId}:apis/${apiId}`
            : "*");
        }
      } else if ((SES_CLOUDFORMATION_RESOURCE_TYPES as readonly string[]).includes(typeName)) {
        if (typeName === SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE) {
          const configurationSetName = typeof properties.ConfigurationSetName === "string" ? properties.ConfigurationSetName : undefined;
          if (!configurationSetName) throw new AwsError("InvalidPhysicalResourceId", `${typeName} provider authorization requires ConfigurationSetName`, 400);
          resources.push(`arn:aws:ses:${this.region}:${accountId}:configuration-set/${configurationSetName}`);
        } else {
          const identifier = physicalId ?? sesCloudFormationPhysicalId(typeName, properties);
          if (typeof identifier !== "string" || !identifier) throw new AwsError("InvalidPhysicalResourceId", `${typeName} provider authorization requires its resolved physical identity`, 400);
          const kind = typeName === SES_EMAIL_IDENTITY_TYPE ? "identity"
            : typeName === SES_CONFIGURATION_SET_TYPE ? "configuration-set"
              : typeName === SES_TEMPLATE_TYPE ? "template"
                : typeName === SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE ? "custom-verification-email-template"
                  : typeName === SES_CONTACT_LIST_TYPE ? "contact-list"
                    : undefined;
          if (!kind) throw new AwsError("InvalidPhysicalResourceId", `${typeName} has no SES authorization resource mapping`, 400);
          resources.push(`arn:aws:ses:${this.region}:${accountId}:${kind}/${identifier}`);
        }
      } else if (typeName.startsWith("AWS::ApiGatewayV2::")) {
        const apiArn = (path: string) => `arn:aws:apigateway:${this.region}::${path}`;
        const segment = (value: unknown) => typeof value === "string" && value ? encodeURIComponent(value) : "*";
        const decodedPhysical = (kind: string, count: number): string[] | undefined => {
          const prefix = `stacksim:apigatewayv2:${kind}:`; if (typeof physicalId !== "string" || !physicalId.startsWith(prefix)) return undefined;
          try { const values = JSON.parse(Buffer.from(physicalId.slice(prefix.length), "base64url").toString("utf8")); return Array.isArray(values) && values.length === count && values.every(value => typeof value === "string" && value) ? values : undefined; } catch { return undefined; }
        };
        const tagPath = (resourcePath: string) => `/v2/tags/${encodeURIComponent(apiArn(resourcePath))}`;
        const paths: string[] = [];
        if (typeName === "AWS::ApiGatewayV2::Api") {
          const apiId = typeof physicalId === "string" && !physicalId.startsWith("stacksim:") ? physicalId : undefined;
          const apiPath = `/v2/apis/${segment(apiId)}`;
          if (action === "apigateway:POST" && operation === "CREATE") paths.push("/v2/apis");
          else if (action === "apigateway:GET") {
            paths.push(apiPath);
            if (properties.ProtocolType === "HTTP") paths.push(`${apiPath}/integrations`, `${apiPath}/routes`);
          } else if (action === "apigateway:PATCH") {
            paths.push(apiPath);
            if (properties.Target !== undefined) paths.push(`${apiPath}/integrations/*`, `${apiPath}/routes/*`);
          } else if (operation === "UPDATE") {
            if (action === "apigateway:DELETE") paths.push(`${apiPath}/cors`, tagPath(`/apis/${apiId ?? "*"}`));
            else if (action === "apigateway:POST") paths.push(tagPath(`/apis/${apiId ?? "*"}`));
          } else paths.push(apiPath);
        } else if (typeName === "AWS::ApiGatewayV2::DomainName") {
          const domainName = properties.DomainName ?? physicalId;
          const item = `/v2/domainnames/${segment(domainName)}`;
          if (action === "apigateway:POST" && operation === "CREATE") paths.push("/v2/domainnames");
          else if (operation === "UPDATE" && (action === "apigateway:POST" || action === "apigateway:DELETE")) paths.push(tagPath(`/domainnames/${typeof domainName === "string" ? domainName : "*"}`));
          else paths.push(item);
        } else if (typeName === "AWS::ApiGatewayV2::ApiMapping") {
          const decoded = decodedPhysical("api-mapping", 2); const domainName = properties.DomainName ?? decoded?.[0]; const mappingId = decoded?.[1];
          const collection = `/v2/domainnames/${segment(domainName)}/apimappings`;
          paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(mappingId)}`);
        } else {
          const kind = typeName === "AWS::ApiGatewayV2::Integration" ? "integration"
            : typeName === "AWS::ApiGatewayV2::Route" ? "route"
              : typeName === "AWS::ApiGatewayV2::Deployment" ? "deployment"
                : typeName === "AWS::ApiGatewayV2::Stage" ? "stage"
                  : typeName === "AWS::ApiGatewayV2::Authorizer" ? "authorizer"
                    : typeName === "AWS::ApiGatewayV2::Model" ? "model"
                      : typeName === "AWS::ApiGatewayV2::IntegrationResponse" ? "integration-response"
                        : "route-response";
          const count = kind === "deployment" || kind === "integration-response" || kind === "route-response" ? 3 : 2;
          const decoded = decodedPhysical(kind, count);
          const apiId = properties.ApiId ?? decoded?.[0];
          const apiPath = `/v2/apis/${segment(apiId)}`;
          if (action === "apigateway:GET" && (create || update) && ["integration", "route", "authorizer", "model", "integration-response", "route-response"].includes(kind)) paths.push(apiPath);
          if (action === "apigateway:GET" && create && (kind === "deployment" || kind === "stage")) paths.push(apiPath);
          if (kind === "integration") {
            const collection = `${apiPath}/integrations`; const id = decoded?.[1]; paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(id)}`);
          } else if (kind === "route") {
            const collection = `${apiPath}/routes`; const id = decoded?.[1]; paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(id)}`);
          } else if (kind === "deployment") {
            const collection = `${apiPath}/deployments`; const id = decoded?.[1]; paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(id)}`);
            const stageName = typeof properties.StageName === "string" ? properties.StageName : decoded?.[2]?.startsWith("stage:") ? decoded[2].slice(6) : undefined;
            if (action === "apigateway:GET" && stageName) paths.push(`${apiPath}/stages/${segment(stageName)}`);
          } else if (kind === "stage") {
            const stageName = properties.StageName ?? decoded?.[1]; const collection = `${apiPath}/stages`; const item = `${collection}/${segment(stageName)}`;
            if (action === "apigateway:POST" && operation === "CREATE") paths.push(collection);
            else if (operation === "UPDATE" && action === "apigateway:POST") paths.push(tagPath(`/apis/${typeof apiId === "string" ? apiId : "*"}/stages/${typeof stageName === "string" ? stageName : "*"}`));
            else if (operation === "UPDATE" && action === "apigateway:DELETE") paths.push(`${item}/accesslogsettings`, tagPath(`/apis/${typeof apiId === "string" ? apiId : "*"}/stages/${typeof stageName === "string" ? stageName : "*"}`));
            else paths.push(item);
          } else if (kind === "authorizer") {
            const collection = `${apiPath}/authorizers`; const id = decoded?.[1]; paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(id)}`);
          } else if (kind === "model") {
            const collection = `${apiPath}/models`; const id = decoded?.[1]; paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(id)}`);
          } else if (kind === "integration-response") {
            const integrationId = properties.IntegrationId ?? decoded?.[1]; const responseId = decoded?.[2]; const collection = `${apiPath}/integrations/${segment(integrationId)}/integrationresponses`;
            paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(responseId)}`);
          } else {
            const routeId = properties.RouteId ?? decoded?.[1]; const responseId = decoded?.[2]; const collection = `${apiPath}/routes/${segment(routeId)}/routeresponses`;
            paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(responseId)}`);
          }
        }
        resources.push(...new Set(paths.map(apiArn)));
      } else if (typeName.startsWith("AWS::ApiGateway::")) {
        const apiArn = (path: string) => `arn:aws:apigateway:${this.region}::${path}`;
        const segment = (value: unknown) => encodeURIComponent(String(value));
        const tagPath = (resourcePath: string) => `/tags/${segment(apiArn(resourcePath))}`;
        const previousApiTags = tags(stack.resources[logicalId]?.properties.Tags); const desiredApiTags = tags(properties.Tags);
        const tagsMayMutate = previousApiTags.length > 0 || desiredApiTags.length > 0;
        const decodedPhysical = (kind: string, length: number): string[] | undefined => {
          const prefix = `stacksim:apigateway:${kind}:`; if (typeof physicalId !== "string" || !physicalId.startsWith(prefix)) return undefined;
          try { const values = JSON.parse(Buffer.from(physicalId.slice(prefix.length), "base64url").toString("utf8")); return Array.isArray(values) && values.length === length && values.every(value => typeof value === "string" && value) ? values : undefined; } catch { return undefined; }
        };
        const apiId = properties.RestApiId;
        let paths: string[] = [];
        if (typeName === "AWS::ApiGateway::RestApi") {
          const id = typeof physicalId === "string" && !physicalId.startsWith("stacksim:") ? physicalId : undefined;
          const item = `/restapis/${id ? segment(id) : "*"}`;
          if (action === "apigateway:POST" || action === "apigateway:GET" && operation === "CREATE" && !id) paths.push("/restapis");
          else if (action === "apigateway:DELETE" && operation === "UPDATE") { if (tagsMayMutate) paths.push(tagPath(item)); }
          else { paths.push(item); if (tagsMayMutate && (action === "apigateway:PUT" || action === "apigateway:DELETE" && operation === "CREATE")) paths.push(tagPath(item)); }
        } else if (typeName === "AWS::ApiGateway::Resource") {
          const parts = decodedPhysical("resource", 2); const id = parts?.[1];
          paths.push(action === "apigateway:POST" ? `/restapis/${segment(apiId)}/resources/${segment(properties.ParentId)}` : `/restapis/${segment(apiId)}/resources/${id ? segment(id) : "*"}`);
        } else if (typeName === "AWS::ApiGateway::Method") {
          const base = `/restapis/${segment(apiId)}/resources/${segment(properties.ResourceId)}/methods/${segment(properties.HttpMethod)}`; paths.push(base);
          if (action === "apigateway:PUT") {
            if (properties.Integration !== undefined) paths.push(`${base}/integration`);
            for (const response of Array.isArray(properties.MethodResponses) ? properties.MethodResponses : []) if (typeof (response as any)?.StatusCode === "string") paths.push(`${base}/responses/${segment((response as any).StatusCode)}`);
            for (const response of Array.isArray((properties.Integration as any)?.IntegrationResponses) ? (properties.Integration as any).IntegrationResponses : []) if (typeof response?.StatusCode === "string") paths.push(`${base}/integration/responses/${segment(response.StatusCode)}`);
          }
        } else if (typeName === "AWS::ApiGateway::Deployment") {
          const parts = decodedPhysical("deployment", 2); const id = parts?.[1]; const collection = `/restapis/${segment(apiId)}/deployments`;
          if (action === "apigateway:POST") paths.push(collection);
          else if (action === "apigateway:GET" && operation === "CREATE") paths.push(collection, `${collection}/${id ? segment(id) : "*"}`);
          else paths.push(`${collection}/${id ? segment(id) : "*"}`);
        } else if (typeName === "AWS::ApiGateway::Stage") {
          const item = `/restapis/${segment(apiId)}/stages/${segment(properties.StageName)}`;
          if (action === "apigateway:POST") paths.push(`/restapis/${segment(apiId)}/stages`);
          else if ((action === "apigateway:PUT" || action === "apigateway:DELETE" && operation === "UPDATE") && tagsMayMutate) paths.push(tagPath(item));
          else { paths.push(item); if (action === "apigateway:DELETE" && operation === "CREATE" && tagsMayMutate) paths.push(tagPath(item)); }
        } else if (typeName === "AWS::ApiGateway::Account") paths.push("/account");
        else if (typeName === "AWS::ApiGateway::DomainName" || typeName === "AWS::ApiGateway::DomainNameV2") {
          const privateDomain = typeName === "AWS::ApiGateway::DomainNameV2"
            ? decodedPhysical("domain-name-v2", 2)
            : undefined;
          const supplied = properties.DomainName ?? physicalId;
          const domainName = typeof supplied === "string" && supplied.startsWith("arn:")
            ? supplied.match(/\/domainnames\/([^+/?]+)/)?.[1]
            : supplied;
          const item = `/domainnames/${domainName ? segment(domainName) : "*"}`;
          const domainTagPath = privateDomain
            ? `/tags/${segment(`arn:aws:apigateway:${this.region}:${this.store.accountId}:/domainnames/${privateDomain[0]}+${privateDomain[1]}`)}`
            : tagPath(item);
          if (action === "apigateway:POST") paths.push("/domainnames");
          else if ((action === "apigateway:PUT" || action === "apigateway:DELETE" && operation === "UPDATE") && tagsMayMutate) paths.push(domainTagPath);
          else {
            if (action === "apigateway:GET" && create) paths.push("/domainnames");
            paths.push(item);
          }
        } else if (typeName === "AWS::ApiGateway::BasePathMapping" || typeName === "AWS::ApiGateway::BasePathMappingV2") {
          const supplied = properties.DomainName ?? properties.DomainNameArn;
          const domainName = typeof supplied === "string" && supplied.startsWith("arn:")
            ? supplied.match(/\/domainnames\/([^+/?]+)/)?.[1]
            : supplied;
          const collection = `/domainnames/${domainName ? segment(domainName) : "*"}/basepathmappings`;
          const basePath = properties.BasePath === undefined || properties.BasePath === "" ? "(none)" : properties.BasePath;
          if (action === "apigateway:POST") paths.push(collection);
          else paths.push(`${collection}/${segment(basePath)}`);
        } else if (typeName === "AWS::ApiGateway::DomainNameAccessAssociation") {
          if (action === "apigateway:POST" || action === "apigateway:GET") paths.push("/domainnameaccessassociations");
          else {
            const associationArn = decodedPhysical("domain-name-access-association", 1)?.[0];
            paths.push(`/domainnameaccessassociations/${associationArn ? segment(associationArn) : "*"}`);
          }
        } else if (typeName === "AWS::ApiGateway::VpcLink") {
          const item = `/vpclinks/${physicalId ? segment(physicalId) : "*"}`;
          if (action === "apigateway:POST") paths.push("/vpclinks");
          else if ((action === "apigateway:PUT" || action === "apigateway:DELETE" && operation === "UPDATE") && tagsMayMutate) paths.push(tagPath(item));
          else {
            if (action === "apigateway:GET" && create) paths.push("/vpclinks");
            paths.push(item);
          }
        } else if (typeName === "AWS::ApiGateway::ClientCertificate") {
          const item = `/clientcertificates/${physicalId ? segment(physicalId) : "*"}`;
          if (action === "apigateway:POST") paths.push("/clientcertificates");
          else if ((action === "apigateway:PUT" || action === "apigateway:DELETE" && operation === "UPDATE") && tagsMayMutate) paths.push(tagPath(item));
          else {
            if (action === "apigateway:GET" && create) paths.push("/clientcertificates");
            paths.push(item);
          }
        } else if (typeName === "AWS::ApiGateway::DocumentationPart") {
          const decoded = decodedPhysical("documentation-part", 2);
          const restApiId = properties.RestApiId ?? decoded?.[0];
          const partId = decoded?.[1];
          const collection = `/restapis/${segment(restApiId)}/documentation/parts`;
          paths.push(action === "apigateway:POST" ? collection : action === "apigateway:GET" && create ? collection : `${collection}/${partId ? segment(partId) : "*"}`);
        } else if (typeName === "AWS::ApiGateway::DocumentationVersion") {
          const restApiId = properties.RestApiId;
          const collection = `/restapis/${segment(restApiId)}/documentation/versions`;
          paths.push(action === "apigateway:POST" ? collection : `${collection}/${segment(properties.DocumentationVersion)}`);
        }
        else if (typeName === "AWS::ApiGateway::Authorizer") { const id = decodedPhysical("authorizer", 2)?.[1]; paths.push(action === "apigateway:POST" ? `/restapis/${segment(apiId)}/authorizers` : `/restapis/${segment(apiId)}/authorizers/${id ? segment(id) : "*"}`); }
        else if (typeName === "AWS::ApiGateway::Model") paths.push(action === "apigateway:POST" ? `/restapis/${segment(apiId)}/models` : `/restapis/${segment(apiId)}/models/${segment(properties.Name)}`);
        else if (typeName === "AWS::ApiGateway::RequestValidator") { const id = decodedPhysical("request-validator", 2)?.[1]; paths.push(action === "apigateway:POST" ? `/restapis/${segment(apiId)}/requestvalidators` : `/restapis/${segment(apiId)}/requestvalidators/${id ? segment(id) : "*"}`); }
        else if (typeName === "AWS::ApiGateway::GatewayResponse") paths.push(`/restapis/${segment(apiId)}/gatewayresponses/${segment(properties.ResponseType)}`);
        else if (typeName === "AWS::ApiGateway::ApiKey") { const item = `/apikeys/${physicalId ? segment(physicalId) : "*"}`; if (action === "apigateway:POST") paths.push("/apikeys"); else if (operation === "CREATE" && action === "apigateway:GET") paths.push("/apikeys", item); else paths.push(operation === "UPDATE" && (action === "apigateway:PUT" || action === "apigateway:DELETE") ? tagPath(item) : item); }
        else if (typeName === "AWS::ApiGateway::UsagePlan") { const item = `/usageplans/${physicalId ? segment(physicalId) : "*"}`; if (action === "apigateway:POST") paths.push("/usageplans"); else paths.push(operation === "UPDATE" && (action === "apigateway:PUT" || action === "apigateway:DELETE") ? tagPath(item) : item); }
        else if (typeName === "AWS::ApiGateway::UsagePlanKey") paths.push(action === "apigateway:POST" ? `/usageplans/${segment(properties.UsagePlanId)}/keys` : `/usageplans/${segment(properties.UsagePlanId)}/keys/${segment(properties.KeyId)}`);
        resources.push(...paths.map(apiArn));
      }
      if (!resources.length) resources.push("*");
      for (const resource of resources) addTarget(action, resource, context);
    }

    const passRoles: Array<{ roleArn: unknown; service: string }> = [];
    const apiGatewayV2RoleArn = (value: unknown): string | undefined => typeof value === "string" && /^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/.+/.test(value) ? value : undefined;
    if (typeName === "AWS::Lambda::Function" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: properties.Role, service: "lambda.amazonaws.com" });
    if (typeName === "AWS::ApiGateway::Account" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: properties.CloudWatchRoleArn, service: "apigateway.amazonaws.com" });
    if (typeName === "AWS::ApiGateway::Method" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: (properties.Integration as any)?.Credentials, service: "apigateway.amazonaws.com" });
    if (typeName === "AWS::ApiGateway::Authorizer" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: properties.AuthorizerCredentials, service: "apigateway.amazonaws.com" });
    if (typeName === "AWS::ApiGatewayV2::Api" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: apiGatewayV2RoleArn(properties.CredentialsArn), service: "apigateway.amazonaws.com" });
    if (typeName === "AWS::ApiGatewayV2::Integration" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: apiGatewayV2RoleArn(properties.CredentialsArn), service: "apigateway.amazonaws.com" });
    if (typeName === "AWS::ApiGatewayV2::Authorizer" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: apiGatewayV2RoleArn(properties.AuthorizerCredentialsArn), service: "apigateway.amazonaws.com" });
    if (typeName === "AWS::Logs::Destination" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: properties.RoleArn, service: "logs.amazonaws.com" });
    if (typeName === "AWS::CloudWatch::MetricStream" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: properties.RoleArn, service: "streams.metrics.cloudwatch.amazonaws.com" });
    if (typeName === "AWS::StepFunctions::StateMachine" && operation !== "DELETE" && operation !== "READ") passRoles.push({ roleArn: properties.RoleArn, service: "states.amazonaws.com" });
    if (passRoles.some(item => typeof item.roleArn === "string" && item.roleArn)) {
      const ownedRoleArns = await this.activeProcessedRoleArns(stack);
      for (const item of passRoles) {
        if (typeof item.roleArn !== "string" || !item.roleArn) continue;
        if (!ownedRoleArns.has(item.roleArn)) throw new AwsError("AccessDeniedException", `${logicalId} cannot pass IAM role ${item.roleArn}: CloudFormation may pass only a workload role owned by this stack and declared in the active processed template`, 403);
        addTarget("iam:PassRole", item.roleArn, { "iam:PassedToService": item.service });
      }
    }
    await this.authorizeProviderTargets(principal, targets);
  }

  private async invokeProvider<Model>(
    stack: CloudFormationStackState,
    logicalId: string,
    step: string,
    providerOperation: ProviderOperation,
    provider: CloudFormationResourceProvider<Model>,
    principal: PrincipalContext,
    invoke: (context: ProviderContext) => Promise<any>,
    authorizationProperties?: Readonly<Record<string, unknown>>,
    authorizationPhysicalId?: string,
    retentionPolicy?: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot",
  ): Promise<any> {
    const operation = stack.activeOperation;
    if (!operation) throw new Error(`Stack ${stack.stackName} has no active operation`);
    const artifactId = this.providerCheckpointArtifactId(operation.operationId, logicalId, step);
    const checkpoint = await this.journal.readJsonArtifact<ProviderOperationCheckpoint>("provider-checkpoints", artifactId);
    const baseContext = { ...this.providerContext(stack.stackId, logicalId, operation.operationId, principal, checkpoint?.provider.callbackContext as Record<string, any> | undefined, step, checkpoint?.deadlineAt), ...(retentionPolicy ? { retentionPolicy } : {}) };
    if (checkpoint) {
      if (checkpoint.schemaVersion !== 1 || checkpoint.typeName !== provider.typeName || checkpoint.providerVersion !== provider.providerVersion || checkpoint.operation !== providerOperation || checkpoint.stackId !== stack.stackId || checkpoint.logicalId !== logicalId || checkpoint.operationId !== operation.operationId || checkpoint.resourceOperationId !== baseContext.resourceOperationId || checkpoint.idempotencyKey !== baseContext.idempotencyKey || checkpoint.deadlineAt !== baseContext.deadlineAt) {
        throw new Error(`Provider checkpoint ${logicalId}/${step} does not match the active provider operation`);
      }
      if (!Number.isSafeInteger(checkpoint.attempt) || checkpoint.attempt < 1 || checkpoint.attempt > MAX_PROVIDER_ATTEMPTS || !Number.isFinite(checkpoint.resumeAfter) || checkpoint.provider.physicalId !== undefined && (typeof checkpoint.provider.physicalId !== "string" || checkpoint.provider.physicalId.length === 0)) throw new Error(`Provider checkpoint ${logicalId}/${step} has invalid retry metadata`);
      // A crash can occur after the provider checkpoint is replaced but before
      // its provisional CREATE identity is copied into the mutation ledger.
      // Repair that ordering window before any resume/deadline branch so a
      // subsequent rollback always has the concrete resource to delete.
      if (providerOperation === "CREATE" && checkpoint.provider.physicalId) await this.persistProvisionalCreatePhysicalId(stack, logicalId, step, checkpoint.provider.physicalId);
      if (this.clock.now() < checkpoint.resumeAfter) throw new ProviderDeferred(checkpoint.resumeAfter);
    }
    const attempt = checkpoint?.attempt ?? 0;
    if (attempt >= MAX_PROVIDER_ATTEMPTS) throw new Error(`Provider ${provider.typeName} exceeded ${MAX_PROVIDER_ATTEMPTS} attempts for ${logicalId}`);
    if (this.clock.now() >= baseContext.deadlineAt) throw new Error(`Provider ${provider.typeName} exceeded its stabilization deadline for ${logicalId}`);

    const authorizationTargetPhysicalId = authorizationPhysicalId
      ?? checkpoint?.provider.physicalId
      ?? (providerOperation === "CREATE" && provider.typeName === RDS_DB_PARAMETER_GROUP_TYPE
        ? rdsDbParameterGroupPhysicalId(baseContext)
        : stack.resources[logicalId]?.physicalResourceId);
    await this.authorizeProviderOperation(stack, logicalId, providerOperation, provider.typeName, principal, authorizationProperties ?? stack.resources[logicalId]?.properties ?? {}, authorizationTargetPhysicalId);
    const result = await invoke(baseContext);
    if (result?.status === "IN_PROGRESS") {
      if (!Number.isFinite(result.callbackAfterMs) || result.callbackAfterMs < 0 || !result.checkpoint || result.checkpoint.schemaVersion !== 1 || !this.isProviderJsonObject(result.checkpoint.callbackContext) || (result.checkpoint.physicalId !== undefined && (typeof result.checkpoint.physicalId !== "string" || result.checkpoint.physicalId.length === 0))) throw new Error(`Provider ${provider.typeName} returned an invalid IN_PROGRESS checkpoint for ${logicalId}`);
      const resumeAfter = Math.min(baseContext.deadlineAt, this.clock.now() + Math.floor(result.callbackAfterMs));
      const durable: ProviderOperationCheckpoint = { schemaVersion: 1, typeName: provider.typeName, providerVersion: provider.providerVersion, operation: providerOperation, stackId: stack.stackId, logicalId, operationId: operation.operationId, resourceOperationId: baseContext.resourceOperationId, idempotencyKey: baseContext.idempotencyKey, attempt: attempt + 1, deadlineAt: baseContext.deadlineAt, resumeAfter, provider: structuredClone(result.checkpoint) };
      await this.journal.replaceJsonArtifact("provider-checkpoints", artifactId, durable);
      if (providerOperation === "CREATE" && durable.provider.physicalId) await this.persistProvisionalCreatePhysicalId(stack, logicalId, step, durable.provider.physicalId);
      await this.checkpoint(stack, `provider:${logicalId}:${step}:attempt-${durable.attempt}`);
      await this.store.save();
      throw new ProviderDeferred(resumeAfter);
    }
    if (result?.status === "FAILED") {
      if (result.physicalId !== undefined && (typeof result.physicalId !== "string" || result.physicalId.length === 0)) throw new Error(`Provider ${provider.typeName} returned an invalid FAILED physical ID for ${logicalId}`);
      if (providerOperation === "CREATE" && result.physicalId) await this.persistProvisionalCreatePhysicalId(stack, logicalId, step, result.physicalId);
      if (result.retryable) {
        const resumeAfter = Math.min(baseContext.deadlineAt, this.clock.now() + Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
        const durable: ProviderOperationCheckpoint = { schemaVersion: 1, typeName: provider.typeName, providerVersion: provider.providerVersion, operation: providerOperation, stackId: stack.stackId, logicalId, operationId: operation.operationId, resourceOperationId: baseContext.resourceOperationId, idempotencyKey: baseContext.idempotencyKey, attempt: attempt + 1, deadlineAt: baseContext.deadlineAt, resumeAfter, provider: { ...(checkpoint?.provider ?? { schemaVersion: 1, callbackContext: {} }), ...(result.physicalId ? { physicalId: result.physicalId } : {}) } };
        await this.journal.replaceJsonArtifact("provider-checkpoints", artifactId, durable);
        await this.checkpoint(stack, `provider:${logicalId}:${step}:retry-${durable.attempt}`);
        await this.store.save();
        throw new ProviderDeferred(resumeAfter);
      }
      const errorCode = String(result.errorCode);
      if (providerOperation === "CREATE" && (errorCode === "AlreadyExists" || errorCode === "OwnershipConflict")) {
        await this.discardUnownedProvisionalCreatePhysicalId(stack, logicalId, step);
      }
      throw new ProviderInvocationFailure(errorCode, String(result.message));
    }
    if (result?.status !== "SUCCESS" && result?.status !== "NOT_FOUND") throw new Error(`Provider ${provider.typeName} returned an invalid terminal result for ${logicalId}`);
    return result as ProviderProgress<Model> | ProviderDeleteResult;
  }

  private isProviderJsonObject(value: unknown): value is Record<string, any> {
    const ancestors = new Set<object>();
    const visit = (candidate: unknown): boolean => {
      if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
      if (typeof candidate === "number") return Number.isFinite(candidate);
      if (typeof candidate !== "object") return false;
      if (ancestors.has(candidate)) return false;
      ancestors.add(candidate);
      const valid = Array.isArray(candidate) ? candidate.every(visit) : Object.getPrototypeOf(candidate) === Object.prototype && Object.entries(candidate as Record<string, unknown>).every(([key, item]) => key.length > 0 && visit(item));
      ancestors.delete(candidate);
      return valid;
    };
    return value !== null && typeof value === "object" && !Array.isArray(value) && visit(value);
  }

  private armResume(stack: CloudFormationStackState, resumeAfter: number): void {
    const operation = stack.activeOperation;
    if (!operation || this.stopping) return;
    const prior = this.resumeTimers.get(operation.operationId);
    if (prior) this.clock.clearTimeout(prior);
    const handle = this.clock.setTimeout(() => {
      this.resumeTimers.delete(operation.operationId);
      setImmediate(() => this.schedule(stack.stackId));
    }, Math.max(0, resumeAfter - this.clock.now()));
    this.resumeTimers.set(operation.operationId, handle);
  }

  private resourceFromSuccess(
    logicalId: string,
    definition: CloudFormationTemplate["Resources"][string],
    metadata: Record<string, unknown>,
    provider: CloudFormationResourceProvider<any>,
    result: any,
    status: CloudFormationResourceStatus,
    persistedProperties?: Record<string, unknown>,
  ): CloudFormationStackResourceState {
    if (result?.status !== "SUCCESS" || !result.model || typeof result.physicalId !== "string" || result.physicalId.length === 0) throw new Error(`Provider ${provider.typeName} returned an incomplete success model for ${logicalId}`);
    return { logicalResourceId: logicalId, physicalResourceId: result.physicalId, refValue: provider.schema.ref.supported ? provider.ref(result.model) : undefined, resourceType: definition.Type, resourceStatus: status, lastUpdatedTimestamp: this.clock.now(), properties: structuredClone(persistedProperties ?? result.model.properties as Record<string, unknown>), attributes: structuredClone(result.model.attributes as Record<string, unknown>), metadata: structuredClone(metadata), deletionPolicy: definition.DeletionPolicy, updateReplacePolicy: definition.UpdateReplacePolicy, dependsOn: list<string>(definition.DependsOn).map(String) };
  }

  private restoredResourceFromSuccess(previous: CloudFormationStackResourceState, provider: CloudFormationResourceProvider<any>, result: any): CloudFormationStackResourceState {
    if (result?.status !== "SUCCESS" || !result.model || typeof result.physicalId !== "string" || result.physicalId.length === 0) throw new Error(`Provider ${provider.typeName} returned an incomplete rollback model for ${previous.logicalResourceId}`);
    return { ...structuredClone(previous), physicalResourceId: result.physicalId, refValue: provider.schema.ref.supported ? provider.ref(result.model) : undefined, resourceStatus: "UPDATE_ROLLBACK_COMPLETE", resourceStatusReason: undefined, lastUpdatedTimestamp: this.clock.now(), properties: structuredClone(previous.properties), attributes: structuredClone(result.model.attributes as Record<string, unknown>) };
  }

  private async checkpoint(stack: CloudFormationStackState, checkpoint: string, terminal = false): Promise<void> {
    const operation = stack.activeOperation;
    if (!operation) return;
    if (terminal) { delete operation.leaseOwner; delete operation.leaseExpiresAt; }
    else { operation.leaseOwner = this.executorId; operation.leaseExpiresAt = this.clock.now() + EXECUTOR_LEASE_MS; }
    await this.journal.append({ operationId: operation.operationId, terminal, recordedAt: new Date(this.clock.now()).toISOString(), payload: { stackId: stack.stackId, stackName: stack.stackName, kind: operation.kind, checkpoint, stackStatus: stack.stackStatus, completedLogicalIds: [...operation.completedLogicalIds], failureReason: operation.failureReason } });
    if (this.checkpointInterceptorForTest) {
      const logicalResourceId = /^(?:resource|provider):([^:]+):/.exec(checkpoint)?.[1];
      const pause = await this.checkpointInterceptorForTest({
        stackId: stack.stackId,
        stackName: stack.stackName,
        operationId: operation.operationId,
        operationKind: operation.kind,
        checkpoint,
        stackStatus: stack.stackStatus,
        logicalResourceId,
        resourceType: logicalResourceId === undefined ? undefined : stack.resources[logicalResourceId]?.resourceType,
      });
      if (pause) {
        // Ordinary call sites save immediately after checkpoint(). Persist
        // here too so the injected interruption has real crash timing.
        await this.store.save();
        throw new ProviderDeferred(this.clock.now() + 5 * 60_000);
      }
    }
  }

  private schedule(stackId: string): void {
    if (this.stopping) return;
    if (this.retentionRun) { void this.retentionRun.then(() => this.schedule(stackId), () => this.schedule(stackId)); return; }
    const stack = this.state.stacks[stackId]; const operation = stack?.activeOperation; if (!stack || !operation || this.running.has(operation.operationId)) return;
    if (operation.leaseOwner && operation.leaseOwner !== this.executorId && (operation.leaseExpiresAt ?? 0) > this.clock.now()) { this.armResume(stack, operation.leaseExpiresAt!); return; }
    const promise = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      operation.leaseOwner = this.executorId; operation.leaseExpiresAt = this.clock.now() + EXECUTOR_LEASE_MS; operation.leaseEpoch = (operation.leaseEpoch ?? 0) + 1; await this.checkpoint(stack, "executor-lease-acquired"); await this.store.save();
      if (operation.kind === "CREATE" && (stack.stackStatus === "ROLLBACK_IN_PROGRESS" || (stack.stackStatus === "DELETE_IN_PROGRESS" && operation.onFailure === "DELETE"))) await this.rollbackCreate(stack, operation, operation.failureReason ?? "Create rollback resumed after restart");
      else if (operation.kind === "CREATE") await this.runCreate(stack);
      else if (operation.kind === "UPDATE" && stack.stackStatus === "UPDATE_ROLLBACK_IN_PROGRESS") await this.rollbackUpdate(stack, operation, operation.failureReason ?? "Update rollback resumed after restart");
      else if (operation.kind === "UPDATE") await this.runUpdate(stack);
      else if (operation.kind === "ROLLBACK_UPDATE") await this.rollbackUpdate(stack, operation, operation.failureReason ?? "RollbackStack requested");
      else if (operation.kind === "DELETE") await this.runDelete(stack);
      else if (operation.kind === "ROLLBACK") await this.rollbackCreate(stack, operation, "RollbackStack requested");
    }).catch(() => undefined).finally(async () => {
      this.running.delete(operation.operationId);
      this.retentionRequested = true;
      if (this.running.size === 0) await this.maintainPersistenceRetention().catch(() => undefined);
    });
    this.running.set(operation.operationId, promise);
  }

  private async runCreate(stack: CloudFormationStackState): Promise<void> {
    const operation = stack.activeOperation; if (!operation || operation.kind !== "CREATE" || operation.status === "SUCCEEDED") return;
    operation.status = "RUNNING"; operation.startedAt ??= this.clock.now(); await this.checkpoint(stack, "started"); await this.store.save();
    let activeLogicalId: string | undefined;
    try {
      const artifactId = stack.templateArtifactId ?? this.artifactId(stack.stackId); const body = await this.journal.readTemplate(artifactId, "processed"); if (body === undefined) throw new Error("Processed template artifact is missing"); const parsed = parseCloudFormationTemplate(body);
      const admission = await this.journal.readJsonArtifact<NestedTemplateManifest>("plans", `${artifactId}.nested-templates.json`);
      if (admission?.admissionFailure) throw new Error(admission.admissionFailure);
      const privateParameters = await this.journal.readJsonArtifact<{ values: Record<string, unknown> }>("parameters", `${artifactId}.private.json`); const conditions = await this.journal.readJsonArtifact<Record<string, boolean>>("plans", `${artifactId}.conditions.json`) ?? {}; const importNames = await this.journal.readJsonArtifact<string[]>("plans", `${artifactId}.imports.json`) ?? []; const importedValues = this.exportValues(); const executionPrincipal = await this.journal.readJsonArtifact<PrincipalContext>("execution", `${artifactId}.principal.json`) ?? this.defaultExecutionPrincipal();
      const parameters = privateParameters?.values ?? Object.fromEntries(stack.parameters.map(parameter => [parameter.parameterKey, parameter.resolvedValue ?? parameter.parameterValue]));
      const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, stack.stackId, stack.stackName), "AWS::NotificationARNs": stack.notificationArns };
      const graph = buildResourceDependencyGraph(parsed); if (!operation.orderedLogicalIds.length) operation.orderedLogicalIds = graph.order;
      const resourceRefs: Record<string, unknown> = {}; const resourceAttributes: Record<string, Record<string, unknown>> = {};
      for (const [logicalId, existing] of Object.entries(stack.resources)) if (operation.completedLogicalIds.includes(logicalId) && existing.physicalResourceId) { if (existing.refValue !== undefined) resourceRefs[logicalId] = existing.refValue; resourceAttributes[logicalId] = existing.attributes; }
      for (const logicalId of operation.orderedLogicalIds) {
        activeLogicalId = logicalId;
        const definition = parsed.Resources[logicalId]; if (!definition) throw new Error(`Planned resource ${logicalId} is missing from the processed template`);
        if (operation.completedLogicalIds.includes(logicalId)) continue;
        const provider = this.providers.require(definition.Type);
        let resource = stack.resources[logicalId];
        if (!resource) {
          const context = { parameters, pseudoParameters: pseudos, mappings: parsed.Mappings, conditions, resourceRefs, resourceAttributes, imports: importedValues };
          const evaluatedProperties = evaluateIntrinsicValue(definition.Properties ?? {}, context, `$.Resources.${logicalId}.Properties`) as Record<string, unknown>; const taggedProperties = this.mergeStackTags(provider, evaluatedProperties, stack.tags); const properties = await this.pinEvaluatedFileAsset(definition.Type, logicalId, taggedProperties, artifactId, operation.operationId, executionPrincipal); const resolvedProperties = await this.resolveDynamicReferenceProperties(definition.Type, properties, executionPrincipal); const metadata = evaluateIntrinsicValue(definition.Metadata ?? {}, context, `$.Resources.${logicalId}.Metadata`) as Record<string, unknown>;
          const validationContext = this.providerContext(stack.stackId, logicalId, operation.operationId, executionPrincipal, undefined, "plan"); const issues = provider.validate(resolvedProperties, validationContext); if (issues.length) throw new Error(issues.map(issue => `${logicalId}.${issue.path}: ${issue.message}`).join("; "));
          resource = { logicalResourceId: logicalId, resourceType: definition.Type, resourceStatus: "CREATE_IN_PROGRESS", lastUpdatedTimestamp: this.clock.now(), properties, attributes: {}, metadata, deletionPolicy: definition.DeletionPolicy, updateReplacePolicy: definition.UpdateReplacePolicy, dependsOn: list<string>(definition.DependsOn).map(String) };
          stack.resources[logicalId] = resource; this.event(stack, logicalId, resource.resourceType, "CREATE_IN_PROGRESS", undefined, undefined, operation.clientRequestToken, resource.properties); await this.checkpoint(stack, `resource:${logicalId}:create-intent`); await this.store.save();
        }
        const key = `${logicalId}:create`; let mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "CREATE", after: resource });
        if (mutation.status !== "COMPLETE") {
          resource.properties = await this.pinEvaluatedFileAsset(definition.Type, logicalId, resource.properties, artifactId, operation.operationId, executionPrincipal);
          const resolvedProperties = await this.resolveDynamicReferenceProperties(definition.Type, resource.properties, executionPrincipal); const providerContext = this.providerContext(stack.stackId, logicalId, operation.operationId, executionPrincipal, undefined, "create"); const desired = provider.canonicalize(resolvedProperties, providerContext); const plan = provider.plan(undefined, desired, providerContext); if (plan.action !== "CREATE") throw new Error(`Provider ${definition.Type} returned ${plan.action} for a new resource`);
          const result = await this.invokeProvider(stack, logicalId, "create", "CREATE", provider, executionPrincipal, context => provider.create(desired, context), desired as Readonly<Record<string, unknown>>);
          const created = this.resourceFromSuccess(logicalId, definition, resource.metadata ?? {}, provider, result, "CREATE_COMPLETE", resource.properties); mutation = await this.mutationComplete(operation.operationId, key, created);
        }
        if (!mutation.after) throw new Error(`Create mutation for ${logicalId} has no completed resource model`);
        resource = structuredClone(mutation.after); resource.resourceStatus = "CREATE_COMPLETE"; resource.lastUpdatedTimestamp = this.clock.now(); stack.resources[logicalId] = resource; if (!operation.completedLogicalIds.includes(logicalId)) operation.completedLogicalIds.push(logicalId); if (resource.refValue !== undefined) resourceRefs[logicalId] = resource.refValue; resourceAttributes[logicalId] = resource.attributes; this.event(stack, logicalId, resource.resourceType, "CREATE_COMPLETE", undefined, resource.physicalResourceId, operation.clientRequestToken, resource.properties); await this.checkpoint(stack, `resource:${logicalId}:create-complete`); await this.store.save();
      }
      stack.outputs = this.evaluatedOutputs(parsed.Outputs, { parameters, pseudoParameters: pseudos, mappings: parsed.Mappings, conditions, resourceRefs, resourceAttributes, imports: importedValues });
      await this.checkpoint(stack, "outputs-evaluated"); await this.store.save();
      this.reconcileStackCatalog(stack, stack.outputs, importNames); stack.stackStatus = "CREATE_COMPLETE"; operation.status = "SUCCEEDED"; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "CREATE_COMPLETE", undefined, stack.stackId, operation.clientRequestToken); if (!stack.parentId) publishCompletedDeploymentGeneration(this.state, this.store.accountId, this.region, stack); await this.checkpoint(stack, "complete", true); await this.store.save();
    } catch (error) {
      if (error instanceof ProviderDeferred) { this.armResume(stack, error.resumeAfter); return; }
      const reason = error instanceof Error ? error.message : String(error); operation.failureReason = reason;
      if (activeLogicalId) { const failed = stack.resources[activeLogicalId]; if (failed && failed.resourceStatus === "CREATE_IN_PROGRESS") { failed.resourceStatus = "CREATE_FAILED"; failed.resourceStatusReason = reason; failed.lastUpdatedTimestamp = this.clock.now(); this.event(stack, activeLogicalId, failed.resourceType, "CREATE_FAILED", reason, failed.physicalResourceId, operation.clientRequestToken, failed.properties); await this.checkpoint(stack, `resource:${activeLogicalId}:create-failed`); await this.store.save(); } }
      if (operation.disableRollback ?? stack.disableRollback) { stack.stackStatus = "CREATE_FAILED"; stack.stackStatusReason = reason; operation.status = "FAILED"; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "CREATE_FAILED", reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "failed", true); await this.store.save(); }
      else await this.rollbackCreate(stack, operation, reason);
    }
  }

  private async rollbackCreate(stack: CloudFormationStackState, operation: NonNullable<CloudFormationStackState["activeOperation"]>, reason: string): Promise<void> {
    operation.status = "RUNNING"; operation.failureReason ??= reason;
    const deleteFailedStack = operation.onFailure === "DELETE";
    const progressStatus = deleteFailedStack ? "DELETE_IN_PROGRESS" : "ROLLBACK_IN_PROGRESS";
    if (stack.stackStatus !== progressStatus) { stack.stackStatus = progressStatus; stack.stackStatusReason = reason; this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", progressStatus, reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, deleteFailedStack ? "delete-after-create-failure-started" : "rollback-started"); await this.store.save(); }
    const artifactId = stack.templateArtifactId ?? this.artifactId(stack.stackId); const principalArtifactId = operation.kind === "ROLLBACK" ? operation.operationId : artifactId; const principal = await this.journal.readJsonArtifact<PrincipalContext>("execution", `${principalArtifactId}.principal.json`) ?? await this.journal.readJsonArtifact<PrincipalContext>("execution", `${artifactId}.principal.json`) ?? this.defaultExecutionPrincipal();
    let activeLogicalId: string | undefined;
    try {
      const ledger = await this.mutationLedger(operation.operationId); const durableCreates = ledger.records.filter(record => record.kind === "CREATE" && (record.status === "COMPLETE" || record.status === "INTENT" && Boolean(record.after?.physicalResourceId))).map(record => record.logicalId); const rollbackOrder = [...new Set([...operation.completedLogicalIds, ...durableCreates])].reverse();
      for (const logicalId of rollbackOrder) {
        activeLogicalId = logicalId;
        if (operation.rollbackLogicalIds.includes(logicalId)) continue; const mutation = ledger.records.find(record => record.logicalId === logicalId && record.kind === "CREATE"); const resource = mutation?.after ? structuredClone(mutation.after) : stack.resources[logicalId]; if (!resource) continue;
        if (resource.deletionPolicy === "Retain" && !operation.retainExceptOnCreate) { await this.releaseRetainedProviderOwnership(stack, logicalId, resource, principal, "rollback-retain"); resource.resourceStatus = "DELETE_SKIPPED"; this.detachNestedStack(resource); stack.resources[logicalId] = resource; operation.rollbackLogicalIds.push(logicalId); if (mutation) await this.mutationRollbackResult(operation.operationId, mutation.key, "SKIPPED", "Retained during create rollback"); this.event(stack, logicalId, resource.resourceType, "DELETE_SKIPPED", "Retained during create rollback", resource.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:rollback-retained`); await this.store.save(); continue; }
        resource.resourceStatus = "DELETE_IN_PROGRESS";
        stack.resources[logicalId] = resource;
        this.event(stack, logicalId, resource.resourceType, "DELETE_IN_PROGRESS", "Create rollback", resource.physicalResourceId, operation.clientRequestToken);
        await this.checkpoint(stack, `resource:${logicalId}:rollback-delete-intent`);
        await this.store.save();
        const provider = this.providers.require(resource.resourceType);
        const resolved = await this.resolveDynamicReferenceProperties(resource.resourceType, resource.properties, principal); const previous = provider.canonicalize(resolved, this.providerContext(stack.stackId, logicalId, operation.operationId, principal, undefined, "rollback-create"));
        const rollbackPhysicalId = resource.physicalResourceId;
        try {
          await this.invokeProvider(stack, logicalId, "rollback-create", "DELETE", provider, principal, context => provider.delete(resource.physicalResourceId ?? "", previous, context), previous as Readonly<Record<string, unknown>>, resource.physicalResourceId);
          resource.resourceStatus = "DELETE_COMPLETE";
          if (mutation) await this.mutationRollbackResult(operation.operationId, mutation.key, "COMPLETE");
        } catch (error) {
          if (!(mutation?.status === "INTENT" && error instanceof ProviderInvocationFailure && error.errorCode === "OwnershipConflict")) throw error;
          resource.resourceStatus = "DELETE_SKIPPED";
          resource.resourceStatusReason = "Create rollback skipped a provisional physical resource that is not owned by this stack resource";
          delete resource.physicalResourceId;
          await this.mutationRollbackResult(operation.operationId, mutation.key, "SKIPPED", resource.resourceStatusReason);
        }
        resource.lastUpdatedTimestamp = this.clock.now();
        stack.resources[logicalId] = resource;
        operation.rollbackLogicalIds.push(logicalId);
        this.event(stack, logicalId, resource.resourceType, resource.resourceStatus, resource.resourceStatusReason ?? "Create rollback", rollbackPhysicalId, operation.clientRequestToken);
        await this.checkpoint(stack, `resource:${logicalId}:rollback-delete-complete`);
        await this.store.save();
      }
      if (deleteFailedStack) { this.removeStackCatalogLinks(stack); stack.stackStatus = "DELETE_COMPLETE"; stack.deletionTime = this.clock.now(); delete this.state.stackNames[stack.stackName]; }
      else stack.stackStatus = "ROLLBACK_COMPLETE";
      operation.status = operation.kind === "ROLLBACK" ? "SUCCEEDED" : "FAILED"; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", stack.stackStatus, reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, deleteFailedStack ? "delete-after-create-failure-complete" : "rollback-complete", true); await this.store.save();
    } catch (rollbackError) {
      if (rollbackError instanceof ProviderDeferred) { this.armResume(stack, rollbackError.resumeAfter); return; }
      const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError); if (activeLogicalId) { const failed = stack.resources[activeLogicalId]; if (failed) { failed.resourceStatus = "DELETE_FAILED"; failed.resourceStatusReason = rollbackReason; failed.lastUpdatedTimestamp = this.clock.now(); this.event(stack, activeLogicalId, failed.resourceType, "DELETE_FAILED", rollbackReason, failed.physicalResourceId, operation.clientRequestToken); } } stack.stackStatus = deleteFailedStack ? "DELETE_FAILED" : "ROLLBACK_FAILED"; stack.stackStatusReason = rollbackReason; operation.status = "FAILED"; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", stack.stackStatus, rollbackReason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, deleteFailedStack ? "delete-after-create-failure-failed" : "rollback-failed", true); await this.store.save();
    }
  }

  private async executeReplacement(
    stack: CloudFormationStackState,
    logicalId: string,
    definition: CloudFormationTemplate["Resources"][string],
    desiredProperties: Record<string, unknown>,
    desiredMetadata: Record<string, unknown>,
    previousResource: CloudFormationStackResourceState,
    desiredProvider: CloudFormationResourceProvider<any>,
    principal: PrincipalContext,
    order: "CREATE_BEFORE_DELETE" | "DELETE_BEFORE_CREATE",
    persistedProperties: Record<string, unknown> = desiredProperties,
  ): Promise<CloudFormationStackResourceState> {
    const operation = stack.activeOperation!;
    const oldProvider = this.providers.require(previousResource.resourceType);
    const retentionPolicy = definition.UpdateReplacePolicy ?? "Delete";
    if (retentionPolicy === "Snapshot") throw new Error(`Snapshot UpdateReplacePolicy for ${logicalId} has no provider snapshot executor`);
    if (order === "DELETE_BEFORE_CREATE" && retentionPolicy !== "Delete") throw new Error(`${logicalId} requires delete-before-create replacement, which is incompatible with UpdateReplacePolicy ${retentionPolicy}`);

    const createReplacement = async (): Promise<CloudFormationStackResourceState> => {
      const planningContext = this.providerContext(stack.stackId, logicalId, operation.operationId, principal, undefined, "replace-create");
      const desired = desiredProvider.canonicalize(desiredProperties, planningContext);
      const provisional: CloudFormationStackResourceState = { logicalResourceId: logicalId, resourceType: definition.Type, resourceStatus: "UPDATE_IN_PROGRESS", lastUpdatedTimestamp: this.clock.now(), properties: structuredClone(persistedProperties), attributes: {}, metadata: structuredClone(desiredMetadata), deletionPolicy: definition.DeletionPolicy, updateReplacePolicy: definition.UpdateReplacePolicy, dependsOn: list<string>(definition.DependsOn).map(String) };
      const key = `${logicalId}:replace-create`; let mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "REPLACE_CREATE", before: previousResource, after: provisional, replacementOrder: order, retentionPolicy });
      if (mutation.status !== "COMPLETE") {
        const plan = desiredProvider.plan(undefined, desired, planningContext); if (plan.action !== "CREATE") throw new Error(`Provider ${desiredProvider.typeName} returned ${plan.action} while creating replacement ${logicalId}`);
        const result = await this.invokeProvider(stack, logicalId, "replace-create", "CREATE", desiredProvider, principal, context => desiredProvider.create(desired, context), desired as Readonly<Record<string, unknown>>); const replacement = this.resourceFromSuccess(logicalId, definition, desiredMetadata, desiredProvider, result, "UPDATE_COMPLETE", persistedProperties); mutation = await this.mutationComplete(operation.operationId, key, replacement);
      }
      if (!mutation.after) throw new Error(`Replacement create mutation for ${logicalId} has no completed resource model`);
      return structuredClone(mutation.after);
    };

    if (order === "DELETE_BEFORE_CREATE") {
      await this.cleanupReplacement(stack, logicalId, previousResource, principal, order, retentionPolicy);
      return createReplacement();
    }

    // CREATE_BEFORE_DELETE is deliberately two phase. The completed REPLACE_CREATE
    // record durably stores both physical models. Dependents and outputs are cut over
    // by runUpdate before old resources are cleaned up in reverse dependency order.
    return createReplacement();
  }

  private async cleanupReplacement(
    stack: CloudFormationStackState,
    logicalId: string,
    previousResource: CloudFormationStackResourceState,
    principal: PrincipalContext,
    order: "CREATE_BEFORE_DELETE" | "DELETE_BEFORE_CREATE",
    retentionPolicy: "Delete" | "Retain" | "RetainExceptOnCreate",
  ): Promise<void> {
    const operation = stack.activeOperation!;
    const key = `${logicalId}:replace-delete`;
    let mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "REPLACE_DELETE", before: previousResource, replacementOrder: order, retentionPolicy });
    if (mutation.status === "COMPLETE") return;

    if (retentionPolicy === "Retain" || retentionPolicy === "RetainExceptOnCreate") {
      await this.releaseRetainedProviderOwnership(stack, logicalId, previousResource, principal, "replace-retain");
      mutation = await this.mutationComplete(operation.operationId, key);
      await this.mutationRollbackResult(operation.operationId, mutation.key, "SKIPPED", `Old physical resource retained by UpdateReplacePolicy ${retentionPolicy}`);
      this.event(stack, logicalId, previousResource.resourceType, "DELETE_SKIPPED", `Old physical resource retained by UpdateReplacePolicy ${retentionPolicy}`, previousResource.physicalResourceId, operation.clientRequestToken, previousResource.properties);
      await this.checkpoint(stack, `resource:${logicalId}:replacement-retained`); await this.store.save(); return;
    }

    this.event(stack, logicalId, previousResource.resourceType, "DELETE_IN_PROGRESS", "Deleting old physical resource after replacement cutover", previousResource.physicalResourceId, operation.clientRequestToken, previousResource.properties); await this.checkpoint(stack, `resource:${logicalId}:replacement-delete-intent`); await this.store.save();
    const oldProvider = this.providers.require(previousResource.resourceType);
    const resolvedPrevious = await this.resolveDynamicReferenceProperties(previousResource.resourceType, previousResource.properties, principal); const previous = oldProvider.canonicalize(resolvedPrevious, this.providerContext(stack.stackId, logicalId, operation.operationId, principal, undefined, "replace-delete"));
    await this.invokeProvider(stack, logicalId, "replace-delete", "DELETE", oldProvider, principal, context => oldProvider.delete(previousResource.physicalResourceId ?? "", previous, context), previous as Readonly<Record<string, unknown>>, previousResource.physicalResourceId);
    await this.mutationComplete(operation.operationId, key);
    this.event(stack, logicalId, previousResource.resourceType, "DELETE_COMPLETE", "Old physical resource deleted after replacement cutover", previousResource.physicalResourceId, operation.clientRequestToken, previousResource.properties); await this.checkpoint(stack, `resource:${logicalId}:replacement-delete-complete`); await this.store.save();
  }

  private isLambdaBackedCustomResource(typeName: string): boolean {
    return typeName === "AWS::CloudFormation::CustomResource" || typeName.startsWith("Custom::") && typeName !== "Custom::CDKBucketDeployment";
  }

  private async cleanupCustomResourceUpdateCutover(
    stack: CloudFormationStackState,
    logicalId: string,
    previousResource: CloudFormationStackResourceState,
    replacementResource: CloudFormationStackResourceState,
    principal: PrincipalContext,
    retentionPolicy: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot",
    step: string,
  ): Promise<void> {
    if (!this.isLambdaBackedCustomResource(previousResource.resourceType) || !previousResource.physicalResourceId || previousResource.physicalResourceId === replacementResource.physicalResourceId) return;
    if (retentionPolicy === "Snapshot") throw new Error(`Snapshot UpdateReplacePolicy for ${logicalId} has no provider snapshot executor`);
    const operation = stack.activeOperation!;
    if (retentionPolicy === "Retain" || retentionPolicy === "RetainExceptOnCreate") {
      this.event(stack, logicalId, previousResource.resourceType, "DELETE_SKIPPED", `Old custom-resource physical ID retained by UpdateReplacePolicy ${retentionPolicy}`, previousResource.physicalResourceId, operation.clientRequestToken, previousResource.properties);
      await this.checkpoint(stack, `resource:${logicalId}:${step}-retained`); await this.store.save();
      return;
    }
    this.event(stack, logicalId, previousResource.resourceType, "DELETE_IN_PROGRESS", "Deleting old custom-resource physical ID after update cutover", previousResource.physicalResourceId, operation.clientRequestToken, previousResource.properties);
    await this.checkpoint(stack, `resource:${logicalId}:${step}-intent`); await this.store.save();
    const provider = this.providers.require(previousResource.resourceType);
    const resolvedPrevious = await this.resolveDynamicReferenceProperties(previousResource.resourceType, previousResource.properties, principal); const previous = provider.canonicalize(resolvedPrevious, this.providerContext(stack.stackId, logicalId, operation.operationId, principal, undefined, step));
    await this.invokeProvider(stack, logicalId, step, "DELETE", provider, principal, context => provider.delete(previousResource.physicalResourceId!, previous, context), previous as Readonly<Record<string, unknown>>, previousResource.physicalResourceId);
    this.event(stack, logicalId, previousResource.resourceType, "DELETE_COMPLETE", "Old custom-resource physical ID deleted after update cutover", previousResource.physicalResourceId, operation.clientRequestToken, previousResource.properties);
    await this.checkpoint(stack, `resource:${logicalId}:${step}-complete`); await this.store.save();
  }

  private async runUpdate(stack: CloudFormationStackState): Promise<void> {
    const operation = stack.activeOperation; if (!operation || operation.kind !== "UPDATE" || operation.status === "SUCCEEDED" || !operation.desiredTemplateArtifactId) return; operation.status = "RUNNING"; operation.startedAt ??= this.clock.now(); await this.checkpoint(stack, "started"); await this.store.save();
    const desiredId = operation.desiredTemplateArtifactId;
    let activeLogicalId: string | undefined;
    try {
      const admission = await this.journal.readJsonArtifact<NestedTemplateManifest>("plans", `${desiredId}.nested-templates.json`);
      if (admission?.admissionFailure) throw new Error(admission.admissionFailure);
      const body = await this.journal.readTemplate(desiredId, "processed"); if (body === undefined) throw new Error("Desired processed template artifact is missing"); const desiredTemplate = parseCloudFormationTemplate(body); const graph = buildResourceDependencyGraph(desiredTemplate); const parameterArtifact = await this.journal.readJsonArtifact<{ values: Record<string, unknown> }>("parameters", `${desiredId}.private.json`); const conditions = await this.journal.readJsonArtifact<Record<string, boolean>>("plans", `${desiredId}.conditions.json`) ?? {}; const importNames = await this.journal.readJsonArtifact<string[]>("plans", `${desiredId}.imports.json`) ?? []; const importedValues = this.exportValues(); const principal = await this.journal.readJsonArtifact<PrincipalContext>("execution", `${desiredId}.principal.json`) ?? this.defaultExecutionPrincipal(); const stackPlan = await this.journal.readJsonArtifact<any>("plans", `${desiredId}.stack.json`); const snapshot = await this.journal.readJsonArtifact<any>("rollback", `${operation.operationId}.snapshot.json`); if (!parameterArtifact || !stackPlan || !snapshot) throw new Error("Update operation artifacts are incomplete");
      const previousBody = snapshot.templateArtifactId ? await this.journal.readTemplate(snapshot.templateArtifactId, "processed") : undefined; if (previousBody === undefined) throw new Error("Previous processed template artifact is missing"); const previousTemplate = parseCloudFormationTemplate(previousBody); const previousGraph = buildResourceDependencyGraph(previousTemplate);
      const pseudos = { ...cloudFormationPseudoParameters(this.store.accountId, this.region, stack.stackId, stack.stackName), "AWS::NotificationARNs": stackPlan.notificationArns }; const resourceRefs: Record<string, unknown> = {}; const resourceAttributes: Record<string, Record<string, unknown>> = {}; for (const [logicalId, resource] of Object.entries(stack.resources)) { if ((resource as CloudFormationStackResourceState).refValue !== undefined) resourceRefs[logicalId] = (resource as CloudFormationStackResourceState).refValue; resourceAttributes[logicalId] = (resource as CloudFormationStackResourceState).attributes; }
      for (const logicalId of graph.order) {
        activeLogicalId = logicalId;
        if (operation.completedLogicalIds.includes(logicalId)) continue;
        if (operation.cancelRequestedAt && !await this.hasStartedMutation(operation.operationId, logicalId)) throw new Error("Update cancelled by CancelUpdateStack");
        const definition = desiredTemplate.Resources[logicalId]; const evaluation = { parameters: parameterArtifact.values, pseudoParameters: pseudos, mappings: desiredTemplate.Mappings, conditions, resourceRefs, resourceAttributes, imports: importedValues }; const evaluatedProperties = evaluateIntrinsicValue(definition.Properties ?? {}, evaluation, `$.Resources.${logicalId}.Properties`) as Record<string, unknown>; const desiredMetadata = evaluateIntrinsicValue(definition.Metadata ?? {}, evaluation, `$.Resources.${logicalId}.Metadata`) as Record<string, unknown>; const provider = this.providers.require(definition.Type); const taggedProperties = this.mergeStackTags(provider, evaluatedProperties, stackPlan.tags); const desiredProperties = await this.pinEvaluatedFileAsset(definition.Type, logicalId, taggedProperties, desiredId, operation.operationId, principal); const resolvedDesiredProperties = await this.resolveDynamicReferenceProperties(definition.Type, desiredProperties, principal); const context = this.providerContext(stack.stackId, logicalId, operation.operationId, principal, undefined, "plan"); const issues = provider.validate(resolvedDesiredProperties, context); if (issues.length) throw new Error(issues.map(issue => `${logicalId}.${issue.path}: ${issue.message}`).join("; ")); const desired = provider.canonicalize(resolvedDesiredProperties, context); let existing = stack.resources[logicalId]; const previousResource = snapshot.resources[logicalId] as CloudFormationStackResourceState | undefined;
        if (!previousResource) {
          if (!existing) {
            existing = { logicalResourceId: logicalId, resourceType: definition.Type, resourceStatus: "CREATE_IN_PROGRESS", lastUpdatedTimestamp: this.clock.now(), properties: desiredProperties, attributes: {}, metadata: desiredMetadata, deletionPolicy: definition.DeletionPolicy, updateReplacePolicy: definition.UpdateReplacePolicy, dependsOn: list<string>(definition.DependsOn).map(String) }; stack.resources[logicalId] = existing; this.event(stack, logicalId, definition.Type, "CREATE_IN_PROGRESS", undefined, undefined, operation.clientRequestToken, desiredProperties); await this.checkpoint(stack, `resource:${logicalId}:create-intent`); await this.store.save();
          }
          const key = `${logicalId}:create`; let mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "CREATE", after: existing }); if (mutation.status !== "COMPLETE") { const result = await this.invokeProvider(stack, logicalId, "create", "CREATE", provider, principal, providerContext => provider.create(desired, providerContext), desired as Readonly<Record<string, unknown>>); const created = this.resourceFromSuccess(logicalId, definition, desiredMetadata, provider, result, "CREATE_COMPLETE", desiredProperties); mutation = await this.mutationComplete(operation.operationId, key, created); } if (!mutation.after) throw new Error(`Create mutation for ${logicalId} has no completed resource model`); existing = structuredClone(mutation.after); stack.resources[logicalId] = existing; this.event(stack, logicalId, definition.Type, "CREATE_COMPLETE", undefined, existing.physicalResourceId, operation.clientRequestToken, existing.properties);
        } else {
          if (!previousResource) throw new Error(`Update snapshot is missing prior resource ${logicalId}`);
          const sameType = previousResource.resourceType === definition.Type; const resolvedPreviousProperties = sameType ? await this.resolveDynamicReferenceProperties(definition.Type, previousResource.properties, principal) : undefined; const previous = sameType ? provider.canonicalize(resolvedPreviousProperties!, context) : undefined; const plan = sameType ? provider.plan(previous, desired, context) : { action: "REPLACE" as const, replacementOrder: provider.schema.replacement.defaultOrder, reason: "Resource type changed" };
          if (plan.action === "UPDATE") {
            if (existing.resourceStatus !== "UPDATE_IN_PROGRESS") { existing.resourceStatus = "UPDATE_IN_PROGRESS"; existing.lastUpdatedTimestamp = this.clock.now(); this.event(stack, logicalId, definition.Type, "UPDATE_IN_PROGRESS", undefined, existing.physicalResourceId, operation.clientRequestToken, desiredProperties); await this.checkpoint(stack, `resource:${logicalId}:update-intent`); await this.store.save(); }
            const intendedAfter: CloudFormationStackResourceState = { ...structuredClone(previousResource), resourceStatus: "UPDATE_IN_PROGRESS", resourceStatusReason: undefined, lastUpdatedTimestamp: this.clock.now(), properties: structuredClone(desiredProperties), metadata: structuredClone(desiredMetadata), deletionPolicy: definition.DeletionPolicy, updateReplacePolicy: definition.UpdateReplacePolicy, dependsOn: list<string>(definition.DependsOn).map(String) };
            const retentionPolicy = definition.UpdateReplacePolicy ?? "Delete";
            const key = `${logicalId}:update`;
            const existingMutation = (await this.mutationLedger(operation.operationId)).records.find(candidate => candidate.key === key);
            // Authorize every operation a mutable update can require before
            // recording its mutation intent. The desired authorization is the
            // same check invokeProvider repeats immediately before dispatch; doing
            // it here prevents a denied update from producing a ledger record that
            // rollback would incorrectly compensate. A Lambda-backed custom
            // resource can also change both ServiceToken and physical ID, so its
            // previous token must be authorized for rollback and post-cutover
            // cleanup before the intent exists as well.
            if (existingMutation?.status !== "COMPLETE") {
              if (this.isLambdaBackedCustomResource(definition.Type)) await this.authorizeProviderOperation(stack, logicalId, "UPDATE", provider.typeName, principal, previousResource.properties, previousResource.physicalResourceId);
              await this.authorizeProviderOperation(stack, logicalId, "UPDATE", provider.typeName, principal, desired as Readonly<Record<string, unknown>>, previousResource.physicalResourceId);
            }
            let mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "UPDATE", before: previousResource, after: intendedAfter });
            if (mutation.status !== "COMPLETE") {
              const result = await this.invokeProvider(stack, logicalId, "update", "UPDATE", provider, principal, providerContext => provider.update(previousResource.physicalResourceId ?? "", previous!, desired, providerContext), desired as Readonly<Record<string, unknown>>, previousResource.physicalResourceId);
              const updated = this.resourceFromSuccess(logicalId, definition, desiredMetadata, provider, result, "UPDATE_COMPLETE", desiredProperties); mutation = await this.mutationComplete(operation.operationId, key, updated);
            }
            if (!mutation.after) throw new Error(`Update mutation for ${logicalId} has no completed resource model`);
            await this.cleanupCustomResourceUpdateCutover(stack, logicalId, previousResource, mutation.after, principal, retentionPolicy, "update-cutover-delete");
            existing = structuredClone(mutation.after); stack.resources[logicalId] = existing; this.event(stack, logicalId, definition.Type, "UPDATE_COMPLETE", undefined, existing.physicalResourceId, operation.clientRequestToken, existing.properties);
          } else if (plan.action === "REPLACE") {
            if (existing.resourceStatus !== "UPDATE_IN_PROGRESS") { existing.resourceStatus = "UPDATE_IN_PROGRESS"; existing.lastUpdatedTimestamp = this.clock.now(); this.event(stack, logicalId, definition.Type, "UPDATE_IN_PROGRESS", plan.reason ?? `Replacement (${plan.replacementOrder ?? provider.schema.replacement.defaultOrder})`, existing.physicalResourceId, operation.clientRequestToken, desiredProperties); await this.checkpoint(stack, `resource:${logicalId}:replacement-intent`); await this.store.save(); }
            existing = await this.executeReplacement(stack, logicalId, definition, resolvedDesiredProperties, desiredMetadata, previousResource, provider, principal, plan.replacementOrder ?? provider.schema.replacement.defaultOrder, desiredProperties); stack.resources[logicalId] = existing; this.event(stack, logicalId, definition.Type, "UPDATE_COMPLETE", "Replacement complete", existing.physicalResourceId, operation.clientRequestToken, existing.properties);
          } else if (plan.action === "CREATE") throw new Error(`Provider ${definition.Type} returned CREATE for existing resource ${logicalId}`);
          else { existing.properties = structuredClone(desiredProperties); existing.metadata = structuredClone(desiredMetadata); existing.deletionPolicy = definition.DeletionPolicy; existing.updateReplacePolicy = definition.UpdateReplacePolicy; existing.dependsOn = list<string>(definition.DependsOn).map(String); existing.resourceStatus = "UPDATE_COMPLETE"; existing.lastUpdatedTimestamp = this.clock.now(); }
        }
        if (!operation.completedLogicalIds.includes(logicalId)) operation.completedLogicalIds.push(logicalId); const current = stack.resources[logicalId]; if (current.refValue !== undefined) resourceRefs[logicalId] = current.refValue; else delete resourceRefs[logicalId]; resourceAttributes[logicalId] = current.attributes; await this.checkpoint(stack, `resource:${logicalId}:update-complete`); await this.store.save();
      }
      const previousResourceIds = Object.keys(snapshot.resources as Record<string, CloudFormationStackResourceState>); const previousGraphIds = new Set(previousGraph.order); const removalOrder = [...previousGraph.order, ...previousResourceIds.filter(id => !previousGraphIds.has(id))].filter(id => !desiredTemplate.Resources[id]).reverse();
      for (const logicalId of removalOrder) {
        activeLogicalId = logicalId; if (operation.completedLogicalIds.includes(logicalId)) continue; if (operation.cancelRequestedAt && !await this.hasStartedMutation(operation.operationId, logicalId)) throw new Error("Update cancelled by CancelUpdateStack"); const resource = stack.resources[logicalId] ?? snapshot.resources[logicalId] as CloudFormationStackResourceState; if (!resource) { operation.completedLogicalIds.push(logicalId); continue; } if (resource.resourceStatus !== "DELETE_IN_PROGRESS") { resource.resourceStatus = "DELETE_IN_PROGRESS"; resource.lastUpdatedTimestamp = this.clock.now(); stack.resources[logicalId] = resource; this.event(stack, logicalId, resource.resourceType, "DELETE_IN_PROGRESS", "Removed by stack update", resource.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:remove-intent`); await this.store.save(); }
        const retentionPolicy = resource.deletionPolicy ?? (resource.resourceType === RDS_DB_INSTANCE_TYPE ? "Snapshot" : "Delete");
        if (retentionPolicy === "Retain" || retentionPolicy === "RetainExceptOnCreate") { await this.releaseRetainedProviderOwnership(stack, logicalId, resource, principal, "remove-retain"); resource.resourceStatus = "DELETE_SKIPPED"; this.detachNestedStack(resource); this.event(stack, logicalId, resource.resourceType, "DELETE_SKIPPED", "Removed by stack update and retained", resource.physicalResourceId, operation.clientRequestToken); }
        else { const provider = this.providers.require(resource.resourceType); const key = `${logicalId}:delete`; const mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "DELETE", before: snapshot.resources[logicalId] }); if (mutation.status !== "COMPLETE") { const resolved = await this.resolveDynamicReferenceProperties(resource.resourceType, resource.properties, principal); const previous = provider.canonicalize(resolved, this.providerContext(stack.stackId, logicalId, operation.operationId, principal, undefined, "delete")); await this.invokeProvider(stack, logicalId, "delete", "DELETE", provider, principal, providerContext => provider.delete(resource.physicalResourceId ?? "", previous, providerContext), previous as Readonly<Record<string, unknown>>, resource.physicalResourceId, retentionPolicy); await this.mutationComplete(operation.operationId, key); } resource.resourceStatus = "DELETE_COMPLETE"; this.event(stack, logicalId, resource.resourceType, "DELETE_COMPLETE", "Removed by stack update", resource.physicalResourceId, operation.clientRequestToken); }
        resource.lastUpdatedTimestamp = this.clock.now(); operation.completedLogicalIds.push(logicalId); delete stack.resources[logicalId]; delete resourceRefs[logicalId]; delete resourceAttributes[logicalId]; await this.checkpoint(stack, `resource:${logicalId}:remove-complete`); await this.store.save();
      }
      if (operation.cancelRequestedAt) throw new Error("Update cancelled by CancelUpdateStack");
      stack.outputs = this.evaluatedOutputs(desiredTemplate.Outputs, { parameters: parameterArtifact.values, pseudoParameters: pseudos, mappings: desiredTemplate.Mappings, conditions, resourceRefs, resourceAttributes, imports: importedValues });
      await this.checkpoint(stack, "outputs-evaluated"); await this.store.save();

      const ledger = await this.mutationLedger(operation.operationId); const pendingReplacementCreates = new Map(ledger.records.filter(record => record.kind === "REPLACE_CREATE" && record.status === "COMPLETE" && record.replacementOrder === "CREATE_BEFORE_DELETE" && record.before).map(record => [record.logicalId, record]));
      if (pendingReplacementCreates.size) {
        await this.checkpoint(stack, "replacement-cutover-complete"); await this.store.save();
        const cleanupOrder = [...previousGraph.order, ...[...pendingReplacementCreates.keys()].filter(id => !previousGraphIds.has(id))].filter(id => pendingReplacementCreates.has(id)).reverse();
        for (const logicalId of cleanupOrder) {
          activeLogicalId = logicalId;
          const replacement = pendingReplacementCreates.get(logicalId)!;
          await this.cleanupReplacement(stack, logicalId, replacement.before!, principal, "CREATE_BEFORE_DELETE", replacement.retentionPolicy === "Retain" || replacement.retentionPolicy === "RetainExceptOnCreate" ? replacement.retentionPolicy : "Delete");
        }
      }

      this.reconcileStackCatalog(stack, stack.outputs, importNames); stack.parameters = stackPlan.parameters; stack.tags = stackPlan.tags; stack.capabilities = stackPlan.capabilities; stack.notificationArns = stackPlan.notificationArns; stack.rollbackConfiguration = stackPlan.rollbackConfiguration ?? { rollbackTriggers: [] }; stack.roleArn = stackPlan.roleArn; stack.description = stackPlan.description; stack.templateArtifactId = desiredId; stack.templateDigest = stackPlan.templateDigest; stack.processedTemplateDigest = stackPlan.processedTemplateDigest; stack.lastUpdatedTime = this.clock.now(); stack.stackStatus = "UPDATE_COMPLETE"; stack.stackStatusReason = undefined; operation.status = "SUCCEEDED"; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_COMPLETE", undefined, stack.stackId, operation.clientRequestToken); if (!stack.parentId) publishCompletedDeploymentGeneration(this.state, this.store.accountId, this.region, stack); await this.checkpoint(stack, "complete", true); await this.store.save();
    } catch (error) {
      if (error instanceof ProviderDeferred) { this.armResume(stack, error.resumeAfter); return; }
      const reason = error instanceof Error ? error.message : String(error); operation.failureReason = reason;
      if (activeLogicalId) { const failed = stack.resources[activeLogicalId]; if (failed && (failed.resourceStatus === "UPDATE_IN_PROGRESS" || failed.resourceStatus === "CREATE_IN_PROGRESS" || failed.resourceStatus === "DELETE_IN_PROGRESS")) { failed.resourceStatus = failed.resourceStatus === "DELETE_IN_PROGRESS" ? "DELETE_FAILED" : failed.resourceStatus === "CREATE_IN_PROGRESS" ? "CREATE_FAILED" : "UPDATE_FAILED"; failed.resourceStatusReason = reason; failed.lastUpdatedTimestamp = this.clock.now(); this.event(stack, activeLogicalId, failed.resourceType, failed.resourceStatus, reason, failed.physicalResourceId, operation.clientRequestToken, failed.properties); await this.checkpoint(stack, `resource:${activeLogicalId}:update-failed`); await this.store.save(); } }
      if (operation.disableRollback) { stack.stackStatus = "UPDATE_FAILED"; stack.stackStatusReason = reason; operation.status = "FAILED"; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_FAILED", reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "failed", true); await this.store.save(); }
      else await this.rollbackUpdate(stack, operation, reason);
    }
  }

  private async rollbackUpdate(stack: CloudFormationStackState, operation: NonNullable<CloudFormationStackState["activeOperation"]>, reason: string): Promise<void> {
    operation.status = "RUNNING"; operation.failureReason ??= reason;
    if (stack.stackStatus !== "UPDATE_ROLLBACK_IN_PROGRESS") { stack.stackStatus = "UPDATE_ROLLBACK_IN_PROGRESS"; stack.stackStatusReason = reason; this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_ROLLBACK_IN_PROGRESS", reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "rollback-started"); await this.store.save(); }
    let activeRecord: ResourceMutationRecord | undefined;
    try {
      const sourceOperationId = operation.rollbackSourceOperationId ?? operation.operationId;
      const snapshot = await this.journal.readJsonArtifact<any>("rollback", `${sourceOperationId}.snapshot.json`); if (!snapshot) throw new Error("Update rollback snapshot is missing"); const desiredId = operation.desiredTemplateArtifactId; const explicitPrincipal = await this.journal.readJsonArtifact<PrincipalContext>("execution", `${operation.operationId}.principal.json`); const principal = desiredId ? await this.journal.readJsonArtifact<PrincipalContext>("execution", `${desiredId}.principal.json`) : undefined; const executionPrincipal = explicitPrincipal ?? principal ?? this.defaultExecutionPrincipal();
      let ledger = await this.mutationLedger(sourceOperationId);
      for (const record of [...ledger.records].filter(candidate => candidate.status === "COMPLETE" || candidate.status === "INTENT" && candidate.kind === "UPDATE" && candidate.before !== undefined && candidate.after !== undefined || candidate.status === "INTENT" && (candidate.kind === "CREATE" || candidate.kind === "REPLACE_CREATE") && Boolean(candidate.after?.physicalResourceId)).sort((left, right) => right.sequence - left.sequence)) {
        activeRecord = record;
        if (record.rollbackStatus === "COMPLETE" || record.rollbackStatus === "SKIPPED") continue;
        const logicalId = record.logicalId; const current = stack.resources[logicalId]; const previous = record.before ?? snapshot.resources[logicalId] as CloudFormationStackResourceState | undefined;
        if (operation.resourcesToSkip?.includes(logicalId)) { await this.mutationRollbackResult(sourceOperationId, record.key, "SKIPPED", "Skipped by ContinueUpdateRollback"); if (!operation.rollbackLogicalIds.includes(logicalId)) operation.rollbackLogicalIds.push(logicalId); if (current) { current.resourceStatus = "UPDATE_COMPLETE"; current.resourceStatusReason = "Skipped by ContinueUpdateRollback"; current.lastUpdatedTimestamp = this.clock.now(); } this.event(stack, logicalId, current?.resourceType ?? previous?.resourceType ?? "AWS::CloudFormation::CustomResource", "UPDATE_COMPLETE", "Skipped by ContinueUpdateRollback", current?.physicalResourceId ?? previous?.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:rollback-skipped`); await this.store.save(); continue; }
        if (current) { current.resourceStatus = "UPDATE_ROLLBACK_IN_PROGRESS"; current.resourceStatusReason = reason; current.lastUpdatedTimestamp = this.clock.now(); }
        this.event(stack, logicalId, current?.resourceType ?? previous?.resourceType ?? "AWS::CloudFormation::CustomResource", "UPDATE_ROLLBACK_IN_PROGRESS", reason, current?.physicalResourceId ?? previous?.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:rollback-intent:${record.sequence}`); await this.store.save();
        try {
          if (record.kind === "CREATE" || record.kind === "REPLACE_CREATE") {
            const created = record.after; if (!created) throw new Error(`Rollback record ${record.key} is missing its created resource model`);
            if (created.deletionPolicy === "Retain" && !operation.retainExceptOnCreate) { await this.releaseRetainedProviderOwnership(stack, logicalId, created, executionPrincipal, `rollback-${record.sequence}-retain`); await this.mutationRollbackResult(sourceOperationId, record.key, "SKIPPED", "Retained during update rollback"); }
            else { const provider = this.providers.require(created.resourceType); const step = `rollback-${record.sequence}-delete`; const resolved = await this.resolveDynamicReferenceProperties(created.resourceType, created.properties, executionPrincipal); const model = provider.canonicalize(resolved, this.providerContext(stack.stackId, logicalId, operation.operationId, executionPrincipal, undefined, step)); await this.invokeProvider(stack, logicalId, step, "DELETE", provider, executionPrincipal, context => provider.delete(created.physicalResourceId ?? "", model, context), model as Readonly<Record<string, unknown>>, created.physicalResourceId); await this.mutationRollbackResult(sourceOperationId, record.key, "COMPLETE"); }
          } else if (record.kind === "UPDATE") {
            if (!record.before || !record.after) throw new Error(`Rollback record ${record.key} is missing its update models`);
            const provider = this.providers.require(record.before.resourceType); const step = `rollback-${record.sequence}-update`; const context = this.providerContext(stack.stackId, logicalId, operation.operationId, executionPrincipal, undefined, step); const resolvedFrom = await this.resolveDynamicReferenceProperties(record.after.resourceType, record.after.properties, executionPrincipal); const resolvedTo = await this.resolveDynamicReferenceProperties(record.before.resourceType, record.before.properties, executionPrincipal); const from = provider.canonicalize(resolvedFrom, context); const to = provider.canonicalize(resolvedTo, context); const retentionPolicy = record.after.updateReplacePolicy ?? "Delete";
            if (retentionPolicy === "Delete" && this.isLambdaBackedCustomResource(record.after.resourceType)) await this.authorizeProviderOperation(stack, logicalId, "DELETE", provider.typeName, executionPrincipal, record.after.properties, record.after.physicalResourceId);
            const result = await this.invokeProvider(stack, logicalId, step, "UPDATE", provider, executionPrincipal, providerContext => provider.update(record.after!.physicalResourceId ?? "", from, to, providerContext), to as Readonly<Record<string, unknown>>, record.after.physicalResourceId);
            const restored = this.restoredResourceFromSuccess(record.before, provider, result);
            await this.cleanupCustomResourceUpdateCutover(stack, logicalId, record.after, restored, executionPrincipal, retentionPolicy, `${step}-cutover-delete`);
            await this.mutationRollbackResult(sourceOperationId, record.key, "COMPLETE", undefined, restored);
          } else {
            if (!record.before) throw new Error(`Rollback record ${record.key} is missing its deleted resource model`); const provider = this.providers.require(record.before.resourceType); const step = `rollback-${record.sequence}-create`; const context = this.providerContext(stack.stackId, logicalId, operation.operationId, executionPrincipal, undefined, step); const resolved = await this.resolveDynamicReferenceProperties(record.before.resourceType, record.before.properties, executionPrincipal); const desired = provider.canonicalize(resolved, context); const plan = provider.plan(undefined, desired, context); if (plan.action !== "CREATE") throw new Error(`Provider ${provider.typeName} cannot recreate ${logicalId} during rollback`); const result = await this.invokeProvider(stack, logicalId, step, "CREATE", provider, executionPrincipal, providerContext => provider.create(desired, providerContext), desired as Readonly<Record<string, unknown>>); const restored = this.restoredResourceFromSuccess(record.before, provider, result); await this.mutationRollbackResult(sourceOperationId, record.key, "COMPLETE", undefined, restored);
          }
        } catch (error) {
          if (error instanceof ProviderDeferred) throw error;
          const rollbackReason = error instanceof Error ? error.message : String(error);
          if (
            record.status === "INTENT"
            && (record.kind === "CREATE" || record.kind === "REPLACE_CREATE")
            && error instanceof ProviderInvocationFailure
            && error.errorCode === "OwnershipConflict"
          ) {
            await this.mutationRollbackResult(
              sourceOperationId,
              record.key,
              "SKIPPED",
              "Update rollback skipped a provisional physical resource that is not owned by this stack resource",
            );
          } else {
            await this.mutationRollbackResult(sourceOperationId, record.key, "FAILED", rollbackReason);
            throw error;
          }
        }
        if (!operation.rollbackLogicalIds.includes(logicalId)) operation.rollbackLogicalIds.push(logicalId); this.event(stack, logicalId, previous?.resourceType ?? current?.resourceType ?? "AWS::CloudFormation::CustomResource", "UPDATE_ROLLBACK_COMPLETE", reason, previous?.physicalResourceId ?? current?.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:rollback-complete:${record.sequence}`); await this.store.save();
      }
      ledger = await this.mutationLedger(sourceOperationId); const finalResources = structuredClone(snapshot.resources) as Record<string, CloudFormationStackResourceState>; for (const record of ledger.records) if (record.rollbackAfter) finalResources[record.logicalId] = structuredClone(record.rollbackAfter); for (const logicalId of operation.resourcesToSkip ?? []) { const current = stack.resources[logicalId]; if (current) finalResources[logicalId] = structuredClone(current); else delete finalResources[logicalId]; }
      stack.resources = finalResources; for (const resource of Object.values(stack.resources)) { if (operation.rollbackLogicalIds.includes(resource.logicalResourceId)) { resource.resourceStatus = operation.resourcesToSkip?.includes(resource.logicalResourceId) ? "UPDATE_COMPLETE" : "UPDATE_ROLLBACK_COMPLETE"; resource.lastUpdatedTimestamp = this.clock.now(); } } stack.outputs = structuredClone(snapshot.outputs); stack.parameters = structuredClone(snapshot.parameters); stack.tags = structuredClone(snapshot.tags); stack.capabilities = structuredClone(snapshot.capabilities); stack.notificationArns = structuredClone(snapshot.notificationArns); stack.rollbackConfiguration = structuredClone(snapshot.rollbackConfiguration ?? { rollbackTriggers: [] }); stack.roleArn = snapshot.roleArn; stack.description = snapshot.description; stack.nestedStackSource = snapshot.nestedStackSource === undefined ? undefined : structuredClone(snapshot.nestedStackSource); stack.templateArtifactId = snapshot.templateArtifactId; stack.templateDigest = snapshot.templateDigest; stack.processedTemplateDigest = snapshot.processedTemplateDigest; stack.stackStatus = "UPDATE_ROLLBACK_COMPLETE"; stack.stackStatusReason = reason; stack.lastUpdatedTime = this.clock.now(); operation.status = operation.kind === "ROLLBACK_UPDATE" ? "SUCCEEDED" : "FAILED"; operation.failureReason = reason; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_ROLLBACK_COMPLETE", reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "rollback-complete", true); await this.store.save();
    } catch (error) {
      if (error instanceof ProviderDeferred) { this.armResume(stack, error.resumeAfter); return; }
      const rollbackReason = error instanceof Error ? error.message : String(error); if (activeRecord) { const failed = stack.resources[activeRecord.logicalId] ?? activeRecord.after ?? activeRecord.before; if (failed) { failed.resourceStatus = "UPDATE_ROLLBACK_FAILED"; failed.resourceStatusReason = rollbackReason; failed.lastUpdatedTimestamp = this.clock.now(); stack.resources[activeRecord.logicalId] = failed; this.event(stack, activeRecord.logicalId, failed.resourceType, "UPDATE_ROLLBACK_FAILED", rollbackReason, failed.physicalResourceId, operation.clientRequestToken); } } stack.stackStatus = "UPDATE_ROLLBACK_FAILED"; stack.stackStatusReason = rollbackReason; operation.status = "FAILED"; operation.failureReason = reason; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "UPDATE_ROLLBACK_FAILED", rollbackReason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "rollback-failed"); await this.store.save();
    }
  }

  private async runDelete(stack: CloudFormationStackState): Promise<void> {
    const operation = stack.activeOperation; if (!operation || operation.kind !== "DELETE" || operation.status === "SUCCEEDED") return;
    operation.status = "RUNNING"; operation.startedAt ??= this.clock.now(); await this.checkpoint(stack, "started"); await this.store.save();
    let activeLogicalId: string | undefined;
    try {
      const artifactId = stack.templateArtifactId ?? this.artifactId(stack.stackId); const executionPrincipal = await this.journal.readJsonArtifact<PrincipalContext>("execution", `${operation.operationId}.principal.json`) ?? await this.journal.readJsonArtifact<PrincipalContext>("execution", `${artifactId}.principal.json`) ?? this.defaultExecutionPrincipal();
      for (const logicalId of operation.orderedLogicalIds) {
        activeLogicalId = logicalId;
        if (operation.completedLogicalIds.includes(logicalId)) continue; const resource = stack.resources[logicalId]; if (!resource) { operation.completedLogicalIds.push(logicalId); continue; }
        if (resource.resourceStatus !== "DELETE_IN_PROGRESS") { resource.resourceStatus = "DELETE_IN_PROGRESS"; resource.lastUpdatedTimestamp = this.clock.now(); this.event(stack, logicalId, resource.resourceType, "DELETE_IN_PROGRESS", undefined, resource.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:delete-intent`); await this.store.save(); }
        if (!resource.physicalResourceId) {
          resource.resourceStatus = "DELETE_SKIPPED";
          resource.resourceStatusReason = "No physical resource was created";
        } else if (operation.retainLogicalIds?.includes(logicalId) || resource.deletionPolicy === "Retain" || resource.deletionPolicy === "RetainExceptOnCreate") {
          await this.releaseRetainedProviderOwnership(stack, logicalId, resource, executionPrincipal, "delete-retain");
          resource.resourceStatus = "DELETE_SKIPPED";
          this.detachNestedStack(resource);
        } else {
          try {
            const provider = this.providers.require(resource.resourceType); const key = `${logicalId}:delete`; const mutation = await this.mutationIntent(operation.operationId, { key, logicalId, kind: "DELETE", before: resource }); if (mutation.status !== "COMPLETE") { const resolved = await this.resolveDynamicReferenceProperties(resource.resourceType, resource.properties, executionPrincipal); const previous = provider.canonicalize(resolved, this.providerContext(stack.stackId, logicalId, operation.operationId, executionPrincipal, undefined, "delete")); const retentionPolicy = resource.deletionPolicy ?? (resource.resourceType === RDS_DB_INSTANCE_TYPE ? "Snapshot" : "Delete"); await this.invokeProvider(stack, logicalId, "delete", "DELETE", provider, executionPrincipal, context => provider.delete(resource.physicalResourceId ?? "", previous, context), previous as Readonly<Record<string, unknown>>, resource.physicalResourceId, retentionPolicy); await this.mutationComplete(operation.operationId, key); } resource.resourceStatus = "DELETE_COMPLETE";
          } catch (error) {
            if (error instanceof ProviderDeferred || !operation.forceDelete) throw error;
            resource.resourceStatus = "DELETE_SKIPPED";
            resource.resourceStatusReason = `Force delete retained the resource after deletion failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        resource.lastUpdatedTimestamp = this.clock.now(); operation.completedLogicalIds.push(logicalId); this.event(stack, logicalId, resource.resourceType, resource.resourceStatus, resource.resourceStatusReason, resource.physicalResourceId, operation.clientRequestToken); await this.checkpoint(stack, `resource:${logicalId}:delete-complete`); await this.store.save();
      }
      if (stack.parentId && !operation.owningParentOperationId) {
        const parent = this.state.stacks[stack.parentId];
        const logicalId = stack.parentLogicalId;
        if (parent && logicalId && parent.resources[logicalId]?.physicalResourceId === stack.stackId) {
          const parentResource = parent.resources[logicalId];
          delete parent.resources[logicalId];
          this.event(parent, logicalId, CLOUDFORMATION_NESTED_STACK_TYPE, "DELETE_COMPLETE", `Nested stack ${stack.stackName} was deleted directly`, parentResource.physicalResourceId);
        }
      }
      this.removeStackCatalogLinks(stack); stack.stackStatus = "DELETE_COMPLETE"; stack.deletionTime = this.clock.now(); operation.status = "SUCCEEDED"; operation.completedAt = this.clock.now(); delete this.state.stackNames[stack.stackName]; this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "DELETE_COMPLETE", undefined, stack.stackId, operation.clientRequestToken); if (!stack.parentId) removeCompletedDeploymentOwnership(this.state, stack.stackId); await this.checkpoint(stack, "complete", true); await this.store.save();
    } catch (error) {
      if (error instanceof ProviderDeferred) { this.armResume(stack, error.resumeAfter); return; }
      const reason = error instanceof Error ? error.message : String(error); if (activeLogicalId) { const failed = stack.resources[activeLogicalId]; if (failed) { failed.resourceStatus = "DELETE_FAILED"; failed.resourceStatusReason = reason; failed.lastUpdatedTimestamp = this.clock.now(); this.event(stack, activeLogicalId, failed.resourceType, "DELETE_FAILED", reason, failed.physicalResourceId, operation.clientRequestToken); } } stack.stackStatus = "DELETE_FAILED"; stack.stackStatusReason = reason; operation.status = "FAILED"; operation.failureReason = reason; operation.completedAt = this.clock.now(); this.event(stack, stack.stackName, "AWS::CloudFormation::Stack", "DELETE_FAILED", reason, stack.stackId, operation.clientRequestToken); await this.checkpoint(stack, "failed", true); await this.store.save();
    }
  }
}
