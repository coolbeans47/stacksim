import { createHash, randomUUID } from "node:crypto";
import { AwsError } from "../errors.js";
import type { IncomingMessage } from "node:http";
import type {
  CloudFormationHotswapDriftState,
  CloudFormationRegionState,
  CloudFormationResourceOwnershipState,
  CloudFormationStackResourceState,
  CloudFormationStackState,
} from "../types.js";

const HISTORY_LIMIT = 2_000;

export type HotswapCheckpoint = "before-direct-call" | "after-direct-call";
export type HotswapCheckpointInterceptor = (checkpoint: HotswapCheckpoint, operation: Readonly<CloudFormationHotswapDriftState>) => void | Promise<void>;
const checkpointInterceptors = new WeakMap<CloudFormationRegionState, HotswapCheckpointInterceptor>();

/** Deterministic fault injection for direct-call boundary tests; production has no interceptor. */
export function setHotswapCheckpointInterceptorForTest(state: CloudFormationRegionState, interceptor?: HotswapCheckpointInterceptor): void {
  if (interceptor) checkpointInterceptors.set(state, interceptor);
  else checkpointInterceptors.delete(state);
}

export async function hotswapCheckpoint(state: CloudFormationRegionState, checkpoint: HotswapCheckpoint, operation: CloudFormationHotswapDriftState): Promise<void> {
  await checkpointInterceptors.get(state)?.(checkpoint, structuredClone(operation));
}

/** The pinned CDK client marks native SDK calls with its standard hotswap user agent. */
export function isPinnedCdkHotswapRequest(req: IncomingMessage, service?: string): boolean {
  const value = String(req.headers["user-agent"] ?? "");
  return value.includes("cdk-hotswap/success-") && (!service || value.includes(`cdk-hotswap/success-${service}`));
}

export function requestPayloadDigest(payload: Uint8Array | string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function physicalOwnershipKey(value: string): string { return `physical:${value}`; }
export function arnOwnershipKey(value: string): string { return `arn:${value}`; }
export function lambdaOwnershipKey(value: string): string { return `lambda:function:${value}`; }
export function appSyncSchemaOwnershipKey(apiId: string): string { return `appsync:schema:${apiId}`; }
export function appSyncFunctionOwnershipKey(apiId: string, functionId: string): string { return `appsync:function:${apiId}:${functionId}`; }
export function appSyncResolverOwnershipKey(apiId: string, typeName: string, fieldName: string): string { return `appsync:resolver:${apiId}:${typeName}:${fieldName}`; }
export function appSyncApiKeyOwnershipKey(apiId: string, id: string): string { return `appsync:api-key:${apiId}:${id}`; }

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

function decodePhysicalParts(value: string, kind: string): string[] | undefined {
  if (!value.startsWith(`${kind}:`)) return undefined;
  try {
    const result = JSON.parse(Buffer.from(value.slice(kind.length + 1), "base64url").toString("utf8"));
    return Array.isArray(result) && result.every(item => typeof item === "string" && item) ? result : undefined;
  } catch { return undefined; }
}

function ownershipKeys(resource: CloudFormationStackResourceState): string[] {
  const physical = resource.physicalResourceId;
  if (!physical) return [];
  const keys = new Set<string>([physicalOwnershipKey(physical)]);
  for (const value of Object.values(resource.attributes)) if (typeof value === "string" && value.startsWith("arn:")) keys.add(arnOwnershipKey(value));
  if (resource.resourceType === "AWS::Lambda::Function") {
    keys.add(lambdaOwnershipKey(physical));
    const arn = stringValue(resource.attributes.Arn);
    if (arn) keys.add(lambdaOwnershipKey(arn));
  } else if (resource.resourceType === "AWS::AppSync::GraphQLSchema") {
    const apiId = stringValue(resource.properties.ApiId) ?? decodePhysicalParts(physical, "schema")?.[0];
    if (apiId) keys.add(appSyncSchemaOwnershipKey(apiId));
  } else if (resource.resourceType === "AWS::AppSync::FunctionConfiguration") {
    const apiId = stringValue(resource.properties.ApiId);
    const functionId = stringValue(resource.attributes.FunctionId) ?? decodePhysicalParts(physical, "function")?.[1];
    if (apiId && functionId) keys.add(appSyncFunctionOwnershipKey(apiId, functionId));
  } else if (resource.resourceType === "AWS::AppSync::Resolver") {
    const parts = decodePhysicalParts(physical, "resolver");
    const apiId = stringValue(resource.properties.ApiId) ?? parts?.[0];
    const typeName = stringValue(resource.properties.TypeName) ?? parts?.[1];
    const fieldName = stringValue(resource.properties.FieldName) ?? parts?.[2];
    if (apiId && typeName && fieldName) keys.add(appSyncResolverOwnershipKey(apiId, typeName, fieldName));
  } else if (resource.resourceType === "AWS::AppSync::ApiKey") {
    const parts = decodePhysicalParts(physical, "key");
    const apiId = stringValue(resource.properties.ApiId) ?? parts?.[0];
    const id = parts?.[1];
    if (apiId && id) keys.add(appSyncApiKeyOwnershipKey(apiId, id));
  }
  return [...keys].sort();
}

function removeRootCatalog(state: CloudFormationRegionState, rootStackId: string): void {
  const catalog = state.resourceOwnership ??= {};
  for (const [key, owners] of Object.entries(catalog)) {
    const retained = owners.filter(owner => owner.rootStackId !== rootStackId);
    if (retained.length) catalog[key] = retained;
    else delete catalog[key];
  }
}

export function publishCompletedDeploymentGeneration(
  state: CloudFormationRegionState,
  accountId: string,
  region: string,
  completedRoot: CloudFormationStackState,
): number | undefined {
  if (completedRoot.parentId) return undefined;
  const rootStackId = completedRoot.stackId;
  const generation = (state.deploymentGeneration ?? 0) + 1;
  state.deploymentGeneration = generation;
  removeRootCatalog(state, rootStackId);
  const catalog = state.resourceOwnership ??= {};
  for (const stack of Object.values(state.stacks).filter(candidate => candidate.stackId === rootStackId || candidate.rootId === rootStackId)) {
    if (stack.stackStatus === "DELETE_COMPLETE") continue;
    stack.completedDeploymentGeneration = generation;
    for (const resource of Object.values(stack.resources)) {
      if (!resource.physicalResourceId || resource.resourceStatus.startsWith("DELETE")) continue;
      resource.completedDeploymentGeneration = generation;
      const owner: CloudFormationResourceOwnershipState = {
        accountId,
        region,
        rootStackId,
        stackId: stack.stackId,
        parentStackId: stack.parentId,
        logicalResourceId: resource.logicalResourceId,
        resourceType: resource.resourceType,
        physicalResourceId: resource.physicalResourceId,
        completedDeploymentGeneration: generation,
      };
      for (const key of ownershipKeys(resource)) (catalog[key] ??= []).push(structuredClone(owner));
    }
  }
  const drift = state.hotswapDrift ??= {};
  for (const [key, record] of Object.entries(drift)) if (record.rootStackId === rootStackId) delete drift[key];
  return generation;
}

export function removeCompletedDeploymentOwnership(state: CloudFormationRegionState, rootStackId: string): void {
  removeRootCatalog(state, rootStackId);
  const drift = state.hotswapDrift ??= {};
  for (const [key, record] of Object.entries(drift)) if (record.rootStackId === rootStackId) delete drift[key];
}

export function uniqueCompletedOwner(state: CloudFormationRegionState, key: string): CloudFormationResourceOwnershipState {
  const owners = (state.resourceOwnership ?? {})[key] ?? [];
  if (owners.length === 0) throw new AwsError("HotswapTargetNotManaged", "The direct-update target is not owned by a completed CloudFormation deployment", 409);
  if (owners.length !== 1) throw new AwsError("HotswapTargetAmbiguous", "The direct-update target has ambiguous CloudFormation ownership", 409);
  const owner = owners[0];
  const stack = state.stacks[owner.stackId];
  const resource = stack?.resources[owner.logicalResourceId];
  if (!stack || stack.stackStatus === "DELETE_COMPLETE" || stack.completedDeploymentGeneration !== owner.completedDeploymentGeneration
    || !resource || resource.physicalResourceId !== owner.physicalResourceId || resource.completedDeploymentGeneration !== owner.completedDeploymentGeneration) {
    throw new AwsError("HotswapOwnershipStale", "The direct-update target ownership is not from the current completed deployment generation", 409);
  }
  return structuredClone(owner);
}

export function beginHotswapDrift(
  state: CloudFormationRegionState,
  owner: CloudFormationResourceOwnershipState,
  service: "appsync" | "lambda",
  action: string,
  payload: Uint8Array | string,
  priorServiceRevision: string,
  now: number,
): CloudFormationHotswapDriftState {
  const record: CloudFormationHotswapDriftState = {
    driftId: randomUUID(),
    ...owner,
    service,
    action,
    requestPayloadSha256: requestPayloadDigest(payload),
    priorServiceRevision,
    currentServiceRevision: priorServiceRevision,
    status: "PENDING",
    startedAt: now,
  };
  (state.hotswapOperations ??= []).push(record);
  if (state.hotswapOperations.length > HISTORY_LIMIT) state.hotswapOperations.splice(0, state.hotswapOperations.length - HISTORY_LIMIT);
  return record;
}

export function completeHotswapDrift(state: CloudFormationRegionState, record: CloudFormationHotswapDriftState, revision: string, now: number): void {
  record.currentServiceRevision = revision;
  record.status = "INTENTIONAL";
  record.completedAt = now;
  (state.hotswapDrift ??= {})[`${record.stackId}\u0000${record.logicalResourceId}`] = structuredClone(record);
}

export function failHotswapDrift(record: CloudFormationHotswapDriftState, error: unknown, now: number): void {
  record.status = "FAILED";
  record.failure = error instanceof Error ? error.message : String(error);
  record.completedAt = now;
}
