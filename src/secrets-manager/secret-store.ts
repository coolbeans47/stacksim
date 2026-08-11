import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Clock } from "../core/clock.js";
import type { Scheduler } from "../core/scheduler.js";
import { PaginationTokens } from "../core/pagination.js";
import { nextScheduleOccurrence, parseScheduleExpression } from "../eventbridge/schedule-expression.js";
import { EncryptedMaterialStore, type MaterialBinding } from "../configuration-secrets/encrypted-material-store.js";
import { AwsError } from "../errors.js";
import type { StateStore } from "../state.js";
import type { SecretRotationOperationState, SecretRotationRulesState, SecretState, SecretVersionState, SecretsManagerRegionState } from "../types.js";
import type { PrincipalContext } from "../auth/sigv4.js";
import { evaluateResourcePolicy } from "../iam/evaluator.js";
import { description, invalid, invalidRequest, positiveInteger, rejectUnsupported, requestToken, secretName, secretValue, tagMap } from "./validation.js";
import { parseSecretResourcePolicy } from "./resource-policy.js";

const DAY_MS = 86_400_000;
const MAX_VERSIONS = 100;
const SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_PUNCTUATION = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

function partition(region: string): string {
  return region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
}

export function secretArn(region: string, accountId: string, name: string, suffix: string): string {
  return `arn:${partition(region)}:secretsmanager:${region}:${accountId}:secret:${name}-${suffix}`;
}

export function prospectiveSecretArn(region: string, accountId: string, secretId: unknown): string {
  if (typeof secretId === "string" && secretId.startsWith("arn:")) return secretId;
  return `arn:${partition(region)}:secretsmanager:${region}:${accountId}:secret:${String(secretId ?? "*")}-*`;
}

type TagAuthorization = (
  principal: any,
  action: "secretsmanager:TagResource" | "secretsmanager:UntagResource",
  resource: string,
  requestTags: Record<string, string>,
  resourceTags: Record<string, string>,
) => Promise<void>;

export type BatchValueAuthorization = (input: {
  secret: SecretState;
  action: "secretsmanager:GetSecretValue";
  versionStage: string;
}) => Promise<{ decision: "allowed" | "implicitDeny" | "explicitDeny"; reason: string }>;

export interface SecretsManagerRotationInvoker {
  assertFunction(lambdaArn: string, secretArn: string): void;
  invoke(lambdaArn: string, event: { Step: string; SecretId: string; ClientRequestToken: string }, requestId: string, lineage: string[]): Promise<void>;
}

export interface SecretsManagerRdsTargetPort {
  describeTarget(targetId: string): { targetArn: string; targetGenerationId: string; engine: "mysql"; host: "127.0.0.1"; port: number; username: string };
  applyPending(secretArn: string, token: string): Promise<void>;
  finalize(secretArn: string, token: string): Promise<void>;
  compensate(secretArn: string, token: string): Promise<void>;
}

export class SecretsManagerStore {
  private readonly materials: EncryptedMaterialStore;
  private readonly tokens: PaginationTokens;
  private started = false;
  private cancelDeletionTimer?: () => void;
  private cancelRotationTimer?: () => void;
  private rotationWorkerRunning = false;
  private rotationInvoker?: SecretsManagerRotationInvoker;
  private rdsTargets?: SecretsManagerRdsTargetPort;

  constructor(
    private readonly store: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler?: Scheduler,
    private readonly authorizeTagMutation?: TagAuthorization,
    private readonly suffixGenerator: () => string = () => Array.from({ length: 6 }, () => SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)]).join(""),
  ) {
    this.materials = new EncryptedMaterialStore(store.root, "secretsmanager");
    this.tokens = new PaginationTokens(store.state.installation.paginationSecret);
  }

  private get control(): SecretsManagerRegionState {
    return this.store.regionState(this.region).secretsManager;
  }

  setRotationInvoker(value: SecretsManagerRotationInvoker): void { this.rotationInvoker = value; }
  setRdsTargetPort(value: SecretsManagerRdsTargetPort): void { this.rdsTargets = value; }

  async start(): Promise<void> {
    const referenced = new Set<string>();
    const bindings: Array<{ binding: MaterialBinding; materialId: string }> = [];
    for (const [accountId, account] of Object.entries(this.store.state.accounts)) for (const [regionName, region] of Object.entries(account.regions)) {
      for (const secret of Object.values(region.secretsManager?.secrets ?? {})) {
        if (secret.owner !== "application" || secret.cloudFormationOwner !== undefined && !secret.cloudFormationOwner || secret.resourcePolicy?.cloudFormationOwner !== undefined && !secret.resourcePolicy.cloudFormationOwner) throw new AwsError("InternalServiceError", `Secret ${secret.arn} has corrupt ownership metadata.`, 500);
        const stageOwners = new Map<string, string>();
        let currentCount = 0;
        for (const version of Object.values(secret.versions)) {
          if (version.stages.length > 20 || new Set(version.stages).size !== version.stages.length) throw new AwsError("InternalServiceError", `Secret ${secret.arn} has corrupt staging-label metadata.`, 500);
          for (const stage of version.stages) {
            if (stageOwners.has(stage)) throw new AwsError("InternalServiceError", `Secret ${secret.arn} has a staging label on multiple versions.`, 500);
            stageOwners.set(stage, version.versionId);
            if (stage === "AWSCURRENT") currentCount++;
          }
          referenced.add(version.materialId);
          bindings.push({ binding: {
            service: "secretsmanager",
            accountId,
            region: regionName,
            resourceArn: secret.arn,
            generationId: secret.generationId,
            valueKind: version.valueKind,
            version: version.versionId,
          }, materialId: version.materialId });
        }
        if (Object.keys(secret.versions).length && currentCount !== 1) throw new AwsError("InternalServiceError", `Secret ${secret.arn} doesn't have exactly one current version.`, 500);
        if (secret.resourcePolicy && secret.policyRevision < secret.resourcePolicy.revision) throw new AwsError("InternalServiceError", `Secret ${secret.arn} has corrupt resource-policy revision metadata.`, 500);
        if (secret.rotation?.operation?.status === "ACTIVE" && secret.rotation.operation.leaseUntil !== undefined) { delete secret.rotation.operation.leaseId; delete secret.rotation.operation.leaseUntil; secret.rotation.operation.nextAttemptAt = Math.min(secret.rotation.operation.nextAttemptAt, this.clock.now()); }
      }
    }
    await this.materials.start(referenced);
    for (const candidate of bindings) await this.materials.opaqueValue(candidate.binding, candidate.materialId);
    this.started = true;
    await this.sweepDueDeletions();
    this.scheduleDeletionSweep();
    this.scheduleRotationWorker();
  }

  stop(): void {
    this.started = false;
    this.cancelDeletionTimer?.(); this.cancelDeletionTimer = undefined;
    this.cancelRotationTimer?.(); this.cancelRotationTimer = undefined;
  }

  private requireStarted(): void {
    if (!this.started) throw new AwsError("InternalServiceError", "Secrets Manager protected storage is not ready.", 500);
  }

  private binding(secret: SecretState, version: SecretVersionState): MaterialBinding {
    return {
      service: "secretsmanager",
      accountId: this.store.accountId,
      region: this.region,
      resourceArn: secret.arn,
      generationId: secret.generationId,
      valueKind: version.valueKind,
      version: version.versionId,
    };
  }

  private find(secretId: unknown): SecretState | undefined {
    if (typeof secretId !== "string" || !secretId || secretId.length > 2048) invalid("SecretId must be a non-empty secret name or complete ARN.");
    if (!secretId.startsWith("arn:")) return this.control.secrets[secretId];
    return Object.values(this.control.secrets).find(secret => secret.arn === secretId);
  }

  resolveArn(secretId: unknown): string | undefined {
    try { return this.find(secretId)?.arn; } catch { return undefined; }
  }

  resourceTags(secretId: unknown): Record<string, string> {
    try { return this.find(secretId)?.tags ?? {}; } catch { return {}; }
  }

  resourcePolicy(secretId: unknown): SecretState["resourcePolicy"] | undefined {
    try { return this.find(secretId)?.resourcePolicy; } catch { return undefined; }
  }

  private required(secretId: unknown, allowDeleted = false): SecretState {
    const secret = this.find(secretId);
    if (!secret) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret.", 400);
    if (!allowDeleted && secret.deletedAt !== undefined) invalidRequest("You can't perform this operation on a secret scheduled for deletion.");
    return secret;
  }

  private assertCloudFormationMutation(secret: SecretState, cloudFormationOwner?: string): void {
    if (secret.cloudFormationOwner && secret.cloudFormationOwner !== cloudFormationOwner) {
      throw new AwsError("AccessDeniedException", `Secret ${secret.arn} is owned by a CloudFormation stack resource.`, 400);
    }
    if (cloudFormationOwner && secret.cloudFormationOwner !== cloudFormationOwner) {
      throw new AwsError("ResourceExistsException", `Secret ${secret.arn} is not owned by this CloudFormation resource.`, 400);
    }
  }

  private versionResponse(secret: SecretState, version: SecretVersionState): any {
    return {
      ARN: secret.arn,
      Name: secret.name,
      VersionId: version.versionId,
      VersionStages: [...version.stages],
    };
  }

  private allocateSuffix(name: string): string {
    const unavailable = new Set([
      ...Object.values(this.control.secrets).map(secret => secret.arnSuffix),
      ...(this.control.retiredSuffixes[name] ?? []),
    ]);
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = this.suffixGenerator();
      if (/^[A-Za-z0-9]{6}$/.test(candidate) && !unavailable.has(candidate)) return candidate;
    }
    throw new AwsError("InternalServiceError", "Unable to allocate a unique secret identity.", 500);
  }

  private async sameValue(secret: SecretState, version: SecretVersionState, kind: "SecretString" | "SecretBinary", bytes: Buffer): Promise<boolean> {
    if (version.valueKind !== kind) return false;
    const stored = await this.materials.read(this.binding(secret, version), version.materialId);
    try { return stored.length === bytes.length && timingSafeEqual(stored, bytes); }
    finally { stored.fill(0); }
  }

  private moveCurrent(secret: SecretState, next: SecretVersionState): void {
    for (const version of Object.values(secret.versions)) {
      if (version.stages.includes("AWSPREVIOUS")) version.stages = version.stages.filter(stage => stage !== "AWSPREVIOUS");
      if (version.stages.includes("AWSCURRENT")) {
        version.stages = version.stages.filter(stage => stage !== "AWSCURRENT");
        if (!version.stages.includes("AWSPREVIOUS")) version.stages.push("AWSPREVIOUS");
      }
    }
    next.stages = next.stages.filter(stage => stage !== "AWSCURRENT" && stage !== "AWSPREVIOUS");
    next.stages.unshift("AWSCURRENT");
  }

  private stageName(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9_+=.@-]+$/.test(value)) invalid("VersionStage must contain between 1 and 256 valid characters.");
    return value;
  }

  private versionId(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length < 32 || value.length > 64) invalid(`${field} must contain between 32 and 64 characters.`);
    return value;
  }

  private versionStages(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(stage => typeof stage !== "string")) invalid("VersionStages must contain between 1 and 20 staging labels.");
    const stages = value.map(stage => this.stageName(stage));
    if (new Set(stages).size !== stages.length) invalid("VersionStages must not contain duplicates.");
    return stages;
  }

  private attachStagesForWrite(secret: SecretState, draft: SecretVersionState, requested: string[] | undefined): void {
    if (!requested || Object.keys(secret.versions).length === 0) this.moveCurrent(secret, draft);
    if (requested) {
      for (const stage of requested) {
        if (stage === "AWSCURRENT") { this.moveCurrent(secret, draft); continue; }
        for (const version of Object.values(secret.versions)) version.stages = version.stages.filter(candidate => candidate !== stage);
        if (!draft.stages.includes(stage)) draft.stages.push(stage);
      }
    }
    for (const version of [...Object.values(secret.versions), draft]) if (version.stages.length > 20) throw new AwsError("LimitExceededException", "A secret version can have at most 20 staging labels.", 400);
  }

  private pruneCandidate(secret: SecretState): SecretVersionState | undefined {
    if (Object.keys(secret.versions).length < MAX_VERSIONS) return undefined;
    return Object.values(secret.versions)
      .filter(version => version.stages.length === 0 && version.createdAt <= this.clock.now() - DAY_MS)
      .sort((left, right) => left.createdAt - right.createdAt || left.versionId.localeCompare(right.versionId))[0];
  }

  private assertVersionCapacity(secret: SecretState): SecretVersionState | undefined {
    if (Object.keys(secret.versions).length < MAX_VERSIONS) return undefined;
    const candidate = this.pruneCandidate(secret);
    if (!candidate) throw new AwsError("LimitExceededException", "The secret has reached its retained version limit.", 400);
    return candidate;
  }

  async CreateSecret(input: any, cloudFormationOwner?: string, cloudFormationGeneration?: Readonly<Record<string, unknown>>): Promise<any> {
    this.requireStarted();
    rejectUnsupported(input, ["KmsKeyId", "AddReplicaRegions", "ForceOverwriteReplicaSecret", "Type"]);
    const name = secretName(input?.Name);
    const Description = description(input?.Description);
    const Tags = tagMap(input?.Tags);
    const value = secretValue(input, false);
    const token = requestToken(input?.ClientRequestToken, Boolean(value));
    try {
      return await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
        const existing = this.control.secrets[name];
        if (existing) {
          if (existing.deletedAt !== undefined) invalidRequest("You can't create this secret because a secret with this name is scheduled for deletion.");
          if (value && token && existing.versions[token] && await this.sameValue(existing, existing.versions[token], value.kind, value.bytes)) {
            return this.versionResponse(existing, existing.versions[token]);
          }
          throw new AwsError("ResourceExistsException", `The operation failed because the secret ${name} already exists.`, 400);
        }
        const now = this.clock.now();
        const suffix = this.allocateSuffix(name);
        const secret: SecretState = {
          name,
          arn: secretArn(this.region, this.store.accountId, name, suffix),
          arnSuffix: suffix,
          generationId: randomUUID(),
          ...(Description === undefined ? {} : { description: Description }),
          tags: Tags,
          versions: {},
          createdAt: now,
          lastChangedAt: now,
          policyRevision: 0,
          owner: "application",
          ...(cloudFormationOwner ? { cloudFormationOwner } : {}),
          ...(cloudFormationGeneration ? { cloudFormationGeneration: structuredClone(cloudFormationGeneration) } : {}),
          revision: 1,
        };
        let materialId: string | undefined;
        let catalogCommitted = false;
        try {
          if (value && token) {
            const draft: SecretVersionState = { versionId: token, createdAt: now, valueKind: value.kind, materialId: "", stages: ["AWSCURRENT"] };
            materialId = (await this.materials.publish(this.binding(secret, draft), value.bytes)).materialId;
            draft.materialId = materialId;
            secret.versions[token] = draft;
          }
          const before = structuredClone(this.control);
          try {
            this.control.secrets[name] = secret;
            this.control.revision++;
            await this.store.save();
            catalogCommitted = true;
          } catch (error) {
            this.store.regionState(this.region).secretsManager = before;
            throw error;
          }
          if (materialId) await this.materials.commit(materialId).catch(() => undefined);
          return { ARN: secret.arn, Name: secret.name, ...(token ? { VersionId: token } : {}) };
        } catch (error) {
          if (materialId && !catalogCommitted) await this.materials.abort(materialId).catch(() => undefined);
          throw error;
        }
      });
    } finally {
      value?.bytes.fill(0);
    }
  }

  async PutSecretValue(input: any): Promise<any> {
    rejectUnsupported(input, ["RotationToken"]);
    const stages = this.versionStages(input?.VersionStages);
    const selected = (() => { try { return this.find(input?.SecretId); } catch { return undefined; } })();
    const rotating = selected?.rotation?.operation;
    if (selected?.owningService === "rds.amazonaws.com" && !(rotating?.status === "ACTIVE" && rotating.token === input?.ClientRequestToken && stages?.length === 1 && stages[0] === "AWSPENDING")) invalidRequest("This secret is managed by Amazon RDS and can't be changed directly.");
    if (rotating?.status === "ACTIVE" && rotating.token === input?.ClientRequestToken && (!stages || stages.includes("AWSCURRENT"))) invalidRequest("A rotation version can't become AWSCURRENT before the testSecret checkpoint succeeds.");
    return this.writeVersion(input, "PutSecretValue");
  }

  async UpdateSecret(input: any, cloudFormationOwner?: string, cloudFormationGeneration?: Readonly<Record<string, unknown>>): Promise<any> {
    rejectUnsupported(input, ["KmsKeyId", "Type"]);
    const Description = description(input?.Description);
    const value = secretValue(input, false);
    const selected = (() => { try { return this.find(input?.SecretId); } catch { return undefined; } })();
    if (selected?.owningService === "rds.amazonaws.com") { value?.bytes.fill(0); invalidRequest("This secret is managed by Amazon RDS and can't be changed directly."); }
    if (Description === undefined && !value) invalid("UpdateSecret requires Description, SecretString, or SecretBinary.");
    const token = requestToken(input?.ClientRequestToken, Boolean(value));
    if (!value) {
      return this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
        const secret = this.required(input?.SecretId);
        this.assertCloudFormationMutation(secret, cloudFormationOwner);
        const before = structuredClone(this.control);
        try {
          secret.description = Description;
          if (cloudFormationGeneration) secret.cloudFormationGeneration = structuredClone(cloudFormationGeneration);
          secret.lastChangedAt = this.clock.now();
          secret.revision++;
          this.control.revision++;
          await this.store.save();
          return { ARN: secret.arn, Name: secret.name };
        } catch (error) {
          this.store.regionState(this.region).secretsManager = before;
          throw error;
        }
      });
    }
    const result = await this.writeVersion(input, "UpdateSecret", Description, cloudFormationOwner, cloudFormationGeneration);
    return result;
  }

  private async writeVersion(input: any, action: "PutSecretValue" | "UpdateSecret", nextDescription?: string, cloudFormationOwner?: string, cloudFormationGeneration?: Readonly<Record<string, unknown>>): Promise<any> {
    this.requireStarted();
    const value = secretValue(input, true)!;
    const token = requestToken(input?.ClientRequestToken, true)!;
    try {
      return await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
        const secret = this.required(input?.SecretId);
        this.assertCloudFormationMutation(secret, cloudFormationOwner);
        const existing = secret.versions[token];
        if (existing) {
          if (action === "UpdateSecret") invalidRequest("A version with this ClientRequestToken already exists.");
          if (await this.sameValue(secret, existing, value.kind, value.bytes)) return this.versionResponse(secret, existing);
          invalidRequest("A version with this ClientRequestToken already exists with different secret data.");
        }
        const pruned = this.assertVersionCapacity(secret);
        const now = this.clock.now();
        const draft: SecretVersionState = { versionId: token, createdAt: now, valueKind: value.kind, materialId: "", stages: [] };
        let materialId: string | undefined;
        let catalogCommitted = false;
        try {
          materialId = (await this.materials.publish(this.binding(secret, draft), value.bytes)).materialId;
          draft.materialId = materialId;
          const before = structuredClone(this.control);
          try {
            if (pruned) delete secret.versions[pruned.versionId];
            this.attachStagesForWrite(secret, draft, action === "PutSecretValue" ? this.versionStages(input?.VersionStages) : undefined);
            secret.versions[token] = draft;
            if (action === "UpdateSecret" && nextDescription !== undefined) secret.description = nextDescription;
            if (cloudFormationGeneration) secret.cloudFormationGeneration = structuredClone(cloudFormationGeneration);
            secret.lastChangedAt = now;
            secret.revision++;
            this.control.revision++;
            await this.store.save();
            catalogCommitted = true;
          } catch (error) {
            this.store.regionState(this.region).secretsManager = before;
            throw error;
          }
          await this.materials.commit(materialId).catch(() => undefined);
          if (pruned) await this.materials.remove(pruned.materialId).catch(() => undefined);
          return this.versionResponse(secret, draft);
        } catch (error) {
          if (materialId && !catalogCommitted) await this.materials.abort(materialId).catch(() => undefined);
          throw error;
        }
      });
    } finally {
      value.bytes.fill(0);
    }
  }

  async GetSecretValue(input: any): Promise<any> {
    this.requireStarted();
    await this.sweepDueDeletions();
    const secret = this.required(input?.SecretId);
    const stage = input?.VersionStage === undefined
      ? input?.VersionId === undefined ? "AWSCURRENT" : undefined
      : String(input.VersionStage);
    if (stage !== undefined) this.stageName(stage);
    const byId = input?.VersionId === undefined ? undefined : secret.versions[String(input.VersionId)];
    const byStage = stage === undefined ? undefined : Object.values(secret.versions).find(version => version.stages.includes(stage));
    const version = byId ?? byStage;
    if (!version || (byId && stage !== undefined && !byId.stages.includes(stage))) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret value.", 400);
    return this.readValueEntry(secret, version);
  }

  private async readValueEntry(secret: SecretState, version: SecretVersionState): Promise<any> {
    const plaintext = await this.materials.read(this.binding(secret, version), version.materialId);
    try {
      return {
        ...this.versionResponse(secret, version),
        CreatedDate: version.createdAt / 1_000,
        ...(version.valueKind === "SecretString" ? { SecretString: plaintext.toString("utf8") } : { SecretBinary: plaintext.toString("base64") }),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  async BatchGetSecretValue(input: any, authorize?: BatchValueAuthorization): Promise<any> {
    this.requireStarted();
    await this.sweepDueDeletions();
    const hasIds = input?.SecretIdList !== undefined;
    const hasFilters = input?.Filters !== undefined;
    if (hasIds === hasFilters) invalid("You must specify either SecretIdList or Filters, but not both.");
    let candidates: Array<{ supplied: string; secret?: SecretState }>;
    let NextToken: string | undefined;
    if (hasIds) {
      if (!Array.isArray(input.SecretIdList) || input.SecretIdList.length < 1 || input.SecretIdList.length > 20 || input.SecretIdList.some((id: unknown) => typeof id !== "string" || id.length < 1 || id.length > 2048)) invalid("SecretIdList must contain between 1 and 20 secret names or ARNs.");
      if (new Set(input.SecretIdList).size !== input.SecretIdList.length) invalid("SecretIdList must not contain duplicates.");
      if (input.MaxResults !== undefined || input.NextToken !== undefined) invalid("MaxResults and NextToken can only be used with Filters.");
      candidates = input.SecretIdList.map((supplied: string) => {
        try { return { supplied, secret: this.find(supplied) }; } catch { return { supplied }; }
      });
    } else {
      const filters = this.validateFilters(input.Filters);
      const selected = this.filterSecrets(Object.values(this.control.secrets).filter(secret => secret.deletedAt === undefined), filters)
        .sort((left, right) => left.name.localeCompare(right.name));
      const max = positiveInteger(input?.MaxResults, "MaxResults", 1, 20, 20);
      const signature = JSON.stringify({ filters });
      const index = this.cursor("BatchGetSecretValue", input?.NextToken, signature);
      const page = selected.slice(index, index + max);
      const next = index + page.length;
      candidates = page.map(secret => ({ supplied: secret.arn, secret }));
      if (next < selected.length) NextToken = this.tokens.encode("BatchGetSecretValue", { index: next, signature });
    }
    const SecretValues: any[] = [];
    const Errors: any[] = [];
    for (const candidate of candidates) {
      const secret = candidate.secret;
      if (!secret) {
        Errors.push({ SecretId: candidate.supplied, ErrorCode: "ResourceNotFoundException", Message: "Secrets Manager can't find the specified secret." });
        continue;
      }
      if (secret.deletedAt !== undefined) {
        Errors.push({ SecretId: candidate.supplied, ErrorCode: "InvalidRequestException", Message: "You can't perform this operation on a secret scheduled for deletion." });
        continue;
      }
      const current = Object.values(secret.versions).find(version => version.stages.includes("AWSCURRENT"));
      if (!current) {
        Errors.push({ SecretId: candidate.supplied, ErrorCode: "ResourceNotFoundException", Message: "Secrets Manager can't find the specified secret value." });
        continue;
      }
      if (authorize) {
        const decision = await authorize({ secret, action: "secretsmanager:GetSecretValue", versionStage: "AWSCURRENT" });
        if (decision.decision !== "allowed") {
          Errors.push({ SecretId: candidate.supplied, ErrorCode: "AccessDeniedException", Message: `Access to this secret value is denied. ${decision.reason}` });
          continue;
        }
      }
      try { SecretValues.push(await this.readValueEntry(secret, current)); }
      catch (error) {
        const aws = error instanceof AwsError ? error : new AwsError("InternalServiceError", "The secret value could not be read safely.", 500);
        Errors.push({ SecretId: candidate.supplied, ErrorCode: aws.code, Message: aws.message });
      }
    }
    return { SecretValues, Errors, ...(NextToken ? { NextToken } : {}) };
  }

  async DescribeSecret(input: any): Promise<any> {
    await this.sweepDueDeletions();
    const secret = this.required(input?.SecretId, true);
    return this.metadata(secret, true);
  }

  private metadata(secret: SecretState, detailed: boolean): any {
    const VersionIdsToStages = Object.fromEntries(Object.values(secret.versions).filter(version => version.stages.length).map(version => [version.versionId, [...version.stages]]));
    return {
      ARN: secret.arn,
      Name: secret.name,
      ...(secret.description === undefined ? {} : { Description: secret.description }),
      CreatedDate: secret.createdAt / 1_000,
      LastChangedDate: secret.lastChangedAt / 1_000,
      ...(secret.lastAccessedAt === undefined ? {} : { LastAccessedDate: secret.lastAccessedAt / 1_000 }),
      ...(secret.deletedAt === undefined ? {} : { DeletedDate: secret.deletedAt / 1_000 }),
      ...(secret.rotation ? {
        RotationEnabled: secret.rotation.enabled,
        RotationLambdaARN: secret.rotation.lambdaArn,
        RotationRules: {
          ...(secret.rotation.rules.automaticallyAfterDays === undefined ? {} : { AutomaticallyAfterDays: secret.rotation.rules.automaticallyAfterDays }),
          Duration: secret.rotation.rules.duration,
          ScheduleExpression: secret.rotation.rules.scheduleExpression,
        },
        ...(secret.rotation.lastRotatedAt === undefined ? {} : { LastRotatedDate: secret.rotation.lastRotatedAt / 1_000 }),
        ...(secret.rotation.nextRotationAt === undefined ? {} : { NextRotationDate: secret.rotation.nextRotationAt / 1_000 }),
      } : {}),
      ...(secret.owningService ? { OwningService: secret.owningService } : {}),
      Tags: Object.entries(secret.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })),
      ...(detailed ? { VersionIdsToStages } : { SecretVersionsToStages: VersionIdsToStages }),
    };
  }

  private validateFilters(value: unknown): any[] {
    const filters = value ?? [];
    if (!Array.isArray(filters) || filters.length > 10) invalid("Filters must contain no more than 10 entries.");
    for (const filter of filters) {
      if (!filter || typeof filter.Key !== "string" || !Array.isArray(filter.Values) || filter.Values.length < 1 || filter.Values.some((item: unknown) => typeof item !== "string" || !item)) invalid("Each filter requires a Key and non-empty string Values.");
      if (!["name", "description", "tag-key", "tag-value", "all", "primary-region", "owning-service"].includes(filter.Key)) invalid(`Unsupported filter key ${filter.Key}.`);
    }
    return filters;
  }

  private filterSecrets(input: SecretState[], filters: any[]): SecretState[] {
    let secrets = input;
    for (const filter of filters) {
      const include = filter.Values.filter((value: string) => !value.startsWith("!"));
      const exclude = filter.Values.filter((value: string) => value.startsWith("!")).map((value: string) => value.slice(1));
      const matches = (secret: SecretState, value: string): boolean => {
        if (filter.Key === "name") return secret.name.startsWith(value);
        if (filter.Key === "description") return (secret.description ?? "").toLowerCase().includes(value.toLowerCase());
        if (filter.Key === "tag-key") return Object.keys(secret.tags).some(key => key.startsWith(value));
        if (filter.Key === "tag-value") return Object.values(secret.tags).some(tag => tag.startsWith(value));
        if (filter.Key === "all") return [secret.name, secret.description ?? "", ...Object.keys(secret.tags), ...Object.values(secret.tags)].some(field => field.toLowerCase().includes(value.toLowerCase()));
        return false;
      };
      secrets = secrets.filter(secret => (!include.length || include.some((value: string) => matches(secret, value))) && !exclude.some((value: string) => matches(secret, value)));
      if (filter.Key === "primary-region" || filter.Key === "owning-service") secrets = [];
    }
    return secrets;
  }

  async ListSecrets(input: any): Promise<any> {
    await this.sweepDueDeletions();
    const includeDeleted = input?.IncludePlannedDeletion === true;
    const filters = this.validateFilters(input?.Filters);
    let secrets = Object.values(this.control.secrets).filter(secret => includeDeleted || secret.deletedAt === undefined);
    secrets = this.filterSecrets(secrets, filters);
    const order = input?.SortOrder ?? "asc";
    if (!["asc", "desc"].includes(order)) invalid("SortOrder must be asc or desc.");
    secrets.sort((a, b) => (a.createdAt - b.createdAt || a.name.localeCompare(b.name)) * (order === "desc" ? -1 : 1));
    const max = positiveInteger(input?.MaxResults, "MaxResults", 1, 100, 100);
    const signature = JSON.stringify({ includeDeleted, filters, order });
    const index = this.cursor("ListSecrets", input?.NextToken, signature);
    const page = secrets.slice(index, index + max);
    const next = index + page.length;
    return { SecretList: page.map(secret => this.metadata(secret, false)), ...(next < secrets.length ? { NextToken: this.tokens.encode("ListSecrets", { index: next, signature }) } : {}) };
  }

  async ListSecretVersionIds(input: any): Promise<any> {
    await this.sweepDueDeletions();
    const secret = this.required(input?.SecretId);
    const includeDeprecated = input?.IncludeDeprecated === true;
    const versions = Object.values(secret.versions)
      .filter(version => includeDeprecated || version.stages.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt || a.versionId.localeCompare(b.versionId));
    const max = positiveInteger(input?.MaxResults, "MaxResults", 1, 100, 100);
    const signature = JSON.stringify({ arn: secret.arn, includeDeprecated });
    const index = this.cursor("ListSecretVersionIds", input?.NextToken, signature);
    const page = versions.slice(index, index + max);
    const next = index + page.length;
    return {
      ARN: secret.arn,
      Name: secret.name,
      Versions: page.map(version => ({ VersionId: version.versionId, VersionStages: [...version.stages], CreatedDate: version.createdAt / 1_000 })),
      ...(next < versions.length ? { NextToken: this.tokens.encode("ListSecretVersionIds", { index: next, signature }) } : {}),
    };
  }

  async UpdateSecretVersionStage(input: any): Promise<any> {
    const stage = this.stageName(input?.VersionStage);
    const moveTo = input?.MoveToVersionId === undefined ? undefined : this.versionId(input.MoveToVersionId, "MoveToVersionId");
    const removeFrom = input?.RemoveFromVersionId === undefined ? undefined : this.versionId(input.RemoveFromVersionId, "RemoveFromVersionId");
    const rotating = (() => { try { return this.find(input?.SecretId)?.rotation?.operation; } catch { return undefined; } })();
    if (stage === "AWSCURRENT" && moveTo && rotating?.status === "ACTIVE" && rotating.token === moveTo && !rotating.tested) invalidRequest("The active rotation version hasn't passed testSecret and can't become AWSCURRENT.");
    if (!moveTo && !removeFrom) invalid("MoveToVersionId or RemoveFromVersionId is required.");
    return this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(input?.SecretId);
      const before = structuredClone(this.control);
      try {
        const source = removeFrom ? secret.versions[removeFrom] : undefined;
        const target = moveTo ? secret.versions[moveTo] : undefined;
        if (removeFrom && !source || moveTo && !target) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret version.", 400);
        const owner = Object.values(secret.versions).find(version => version.stages.includes(stage));
        if (removeFrom && (!source!.stages.includes(stage) || owner?.versionId !== removeFrom)) invalid("RemoveFromVersionId does not identify the version that owns this staging label.");
        if (moveTo) {
          if (owner && owner.versionId !== moveTo && removeFrom !== owner.versionId) invalid("RemoveFromVersionId is required and must identify the current staging-label owner.");
          if (stage === "AWSCURRENT") this.moveCurrent(secret, target!);
          else {
            if (owner && owner.versionId !== moveTo) owner.stages = owner.stages.filter(candidate => candidate !== stage);
            if (!target!.stages.includes(stage)) target!.stages.push(stage);
          }
        } else {
          if (stage === "AWSCURRENT") invalidRequest("AWSCURRENT can't be removed without moving it to another version.");
          source!.stages = source!.stages.filter(candidate => candidate !== stage);
        }
        for (const version of Object.values(secret.versions)) if (version.stages.length > 20) throw new AwsError("LimitExceededException", "A secret version can have at most 20 staging labels.", 400);
        const currents = Object.values(secret.versions).filter(version => version.stages.includes("AWSCURRENT"));
        if (Object.keys(secret.versions).length && currents.length !== 1) throw new AwsError("InternalServiceError", "The staging-label update would violate the current-version invariant.", 500);
        secret.lastChangedAt = this.clock.now();
        secret.revision++;
        this.control.revision++;
        await this.store.save();
        return { ARN: secret.arn, Name: secret.name };
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
  }

  private validatePolicyForSecret(secret: SecretState, value: unknown, principal?: PrincipalContext): {
    document: import("../types.js").PolicyDocument;
    publicPolicy: boolean;
    callerLockout: boolean;
  } {
    const parsed = parseSecretResourcePolicy(value, secret.arn, this.store.accountId, this.store.ensureAccount().iam);
    const principalArn = principal?.principalArn ?? `arn:aws:iam::${this.store.accountId}:root`;
    const result = evaluateResourcePolicy(parsed.document, principalArn, "secretsmanager:PutResourcePolicy", secret.arn, {
      "aws:PrincipalArn": principalArn,
      "aws:PrincipalAccount": principal?.accountId ?? this.store.accountId,
      "aws:RequestedRegion": this.region,
      "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
    });
    return { document: parsed.document, publicPolicy: parsed.publicPolicy, callerLockout: result.decision === "explicitDeny" };
  }

  async ValidateResourcePolicy(input: any, principal?: PrincipalContext): Promise<any> {
    const secret = this.required(input?.SecretId);
    const result = this.validatePolicyForSecret(secret, input?.ResourcePolicy, principal);
    const ValidationErrors = [
      ...(result.publicPolicy ? [{ CheckName: "PUBLIC_POLICY_CHECK", ErrorMessage: "The policy grants broad public access." }] : []),
      ...(result.callerLockout ? [{ CheckName: "CALLER_LOCKOUT_CHECK", ErrorMessage: "The policy explicitly denies the caller permission to update the resource policy." }] : []),
    ];
    return { PolicyValidationPassed: ValidationErrors.length === 0, ValidationErrors };
  }

  async PutResourcePolicy(input: any, principal?: PrincipalContext, cloudFormationOwner?: string): Promise<any> {
    if (input?.BlockPublicPolicy !== undefined && typeof input.BlockPublicPolicy !== "boolean") invalid("BlockPublicPolicy must be a boolean.");
    return this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(input?.SecretId);
      if (secret.cloudFormationOwner && !cloudFormationOwner) this.assertCloudFormationMutation(secret);
      if (secret.resourcePolicy?.cloudFormationOwner && secret.resourcePolicy.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("ResourceExistsException", `The secret resource policy is owned by a different CloudFormation resource.`, 400);
      if (cloudFormationOwner && secret.resourcePolicy && secret.resourcePolicy.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("ResourceExistsException", `The secret already has an unowned resource policy.`, 400);
      const result = this.validatePolicyForSecret(secret, input?.ResourcePolicy, principal);
      if (result.publicPolicy) throw new AwsError("PublicPolicyException", input?.BlockPublicPolicy === true
        ? "BlockPublicPolicy rejected a policy that grants broad access."
        : "Public secret grants are not supported by this configured-account development profile.", 400);
      const before = structuredClone(this.control);
      try {
        const revision = secret.policyRevision + 1;
        secret.resourcePolicy = {
          document: String(input.ResourcePolicy),
          normalized: result.document,
          revision,
          updatedAt: this.clock.now(),
          validation: { publicPolicy: false, callerLockout: result.callerLockout, checkedAt: this.clock.now() },
          ...(cloudFormationOwner ? { cloudFormationOwner } : {}),
        };
        secret.policyRevision = revision;
        secret.lastChangedAt = this.clock.now();
        secret.revision++;
        this.control.revision++;
        await this.store.save();
        return { ARN: secret.arn, Name: secret.name };
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
  }

  async GetResourcePolicy(input: any): Promise<any> {
    const secret = this.required(input?.SecretId, true);
    return { ARN: secret.arn, Name: secret.name, ...(secret.resourcePolicy ? { ResourcePolicy: secret.resourcePolicy.document } : {}) };
  }

  async DeleteResourcePolicy(input: any, cloudFormationOwner?: string): Promise<any> {
    return this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(input?.SecretId);
      if (secret.cloudFormationOwner && !cloudFormationOwner) this.assertCloudFormationMutation(secret);
      if (cloudFormationOwner && secret.resourcePolicy?.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", "The secret resource policy is not owned by this CloudFormation resource.", 400);
      if (!cloudFormationOwner && secret.resourcePolicy?.cloudFormationOwner) throw new AwsError("AccessDeniedException", "The secret resource policy is owned by a CloudFormation stack resource.", 400);
      if (!secret.resourcePolicy) return { ARN: secret.arn, Name: secret.name };
      const before = structuredClone(this.control);
      try {
        delete secret.resourcePolicy;
        secret.policyRevision++;
        secret.lastChangedAt = this.clock.now();
        secret.revision++;
        this.control.revision++;
        await this.store.save();
        return { ARN: secret.arn, Name: secret.name };
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
  }

  private rotationRules(value: unknown, previous?: SecretRotationRulesState): SecretRotationRulesState {
    if (value === undefined) {
      if (previous) return structuredClone(previous);
      return { automaticallyAfterDays: 30, scheduleExpression: "rate(30 days)", duration: "24h", durationMs: DAY_MS };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("RotationRules must be an object.");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["AutomaticallyAfterDays", "Duration", "ScheduleExpression"].includes(key))) invalid("RotationRules contains an unsupported field.");
    if (input.AutomaticallyAfterDays !== undefined && input.ScheduleExpression !== undefined) invalid("AutomaticallyAfterDays and ScheduleExpression are mutually exclusive.");
    let automaticallyAfterDays: number | undefined;
    let expression: string;
    if (input.AutomaticallyAfterDays !== undefined) {
      automaticallyAfterDays = positiveInteger(input.AutomaticallyAfterDays, "AutomaticallyAfterDays", 1, 1000, 30);
      expression = `rate(${automaticallyAfterDays} ${automaticallyAfterDays === 1 ? "day" : "days"})`;
    } else expression = String(input.ScheduleExpression ?? previous?.scheduleExpression ?? "rate(30 days)");
    let parsed;
    try { parsed = parseScheduleExpression(expression); } catch { invalid("ScheduleExpression must be a valid UTC rate() or cron() expression."); }
    if (parsed.kind === "at") invalid("Secrets Manager rotation schedules don't support at() expressions.");
    if (parsed.kind === "rate" && parsed.intervalMs < 4 * 3_600_000) invalid("Rotation schedules can't run more often than every four hours.");
    const anchor = this.clock.now();
    const first = nextScheduleOccurrence({ expression, timezone: "UTC", after: anchor, anchor });
    const second = first && nextScheduleOccurrence({ expression, timezone: "UTC", after: first.at, anchor });
    if (!first || second && second.at - first.at < 4 * 3_600_000) invalid("Rotation schedules can't run more often than every four hours.");
    // Keep the default window inside one UTC day even when a rate expression
    // is anchored at the caller's current wall-clock time.
    const defaultDurationMs = 3_600_000;
    const duration = input.Duration === undefined ? previous?.duration ?? `${defaultDurationMs / 3_600_000}h` : String(input.Duration);
    if (!/^[1-9]\d?h$/.test(duration)) invalid("Duration must contain one or two positive hours followed by h.");
    const durationMs = Number(duration.slice(0, -1)) * 3_600_000;
    if (second && first.at + durationMs > second.at) invalid("The rotation window can't extend into the next rotation window.");
    if (parsed.kind !== "rate" || parsed.intervalMs >= DAY_MS) if (new Date(first.at).getUTCDate() !== new Date(first.at + durationMs - 1).getUTCDate()) invalid("The rotation window can't extend into the next UTC day.");
    return { ...(automaticallyAfterDays === undefined ? {} : { automaticallyAfterDays }), scheduleExpression: expression, duration, durationMs };
  }

  private nextRotationAt(rules: SecretRotationRulesState, after: number, anchor: number): number | undefined {
    return nextScheduleOccurrence({ expression: rules.scheduleExpression, timezone: "UTC", after, anchor })?.at;
  }

  private pendingVersion(secret: SecretState, token: string): SecretVersionState | undefined { return secret.versions[token]; }

  private assertRotationAdmission(secret: SecretState, lambdaArn: string): void {
    if (!this.rotationInvoker) throw new AwsError("InternalServiceError", "Lambda rotation is not initialized.", 500);
    if (!/^arn:(?:aws|aws-cn|aws-us-gov):lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9-_]{1,64}(?::[A-Za-z0-9-_$]+)?$/.test(lambdaArn)) invalid("RotationLambdaARN must identify an existing same-account, same-Region Lambda function.");
    this.rotationInvoker.assertFunction(lambdaArn, secret.arn);
  }

  async RotateSecret(input: any, cloudFormationOwner?: string, cloudFormationRotateImmediatelyOnUpdate?: boolean): Promise<any> {
    if (input?.ExternalSecretRotationMetadata !== undefined || input?.ExternalSecretRotationRoleArn !== undefined) invalid("Managed external and hosted rotation are outside the local PSS-06 profile.");
    const secret = this.required(input?.SecretId);
    const lambdaArn = String(input?.RotationLambdaARN ?? secret.rotation?.lambdaArn ?? "");
    if (!lambdaArn) invalid("RotationLambdaARN is required when rotation isn't already configured.");
    this.assertRotationAdmission(secret, lambdaArn);
    const rules = this.rotationRules(input?.RotationRules, secret.rotation?.rules);
    const token = requestToken(input?.ClientRequestToken, false) ?? randomUUID();
    const rotateImmediately = input?.RotateImmediately !== false;
    const output = await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const current = this.required(secret.arn);
      if (current.rotation?.cloudFormationOwner && current.rotation.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `Rotation on ${current.arn} is owned by a CloudFormation stack resource.`, 400);
      if (cloudFormationOwner && current.rotation && current.rotation.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("ResourceExistsException", `Rotation on ${current.arn} is not owned by this CloudFormation resource.`, 400);
      const active = current.rotation?.operation;
      if (active?.token === token) return { ARN: current.arn, Name: current.name, VersionId: token };
      if (active && new Set(["ACTIVE", "CANCELLING"]).has(active.status)) invalidRequest("A rotation is already in progress for this secret.");
      const pending = Object.values(current.versions).find(version => version.stages.includes("AWSPENDING") && !version.stages.includes("AWSCURRENT"));
      if (pending) invalidRequest("A previous rotation left an AWSPENDING version; remove that stage before starting another rotation.");
      const now = this.clock.now();
      const operation: SecretRotationOperationState | undefined = rotateImmediately ? { token, status: "ACTIVE", step: "createSecret", completedSteps: [], attempts: {}, startedAt: now, updatedAt: now, nextAttemptAt: now, scheduled: false, testOnly: false, tested: false } : undefined;
      current.rotation = { enabled: true, lambdaArn, rules, configuredAt: current.rotation?.configuredAt ?? now, nextRotationAt: this.nextRotationAt(rules, now, now), ...(current.rotation?.lastRotatedAt === undefined ? {} : { lastRotatedAt: current.rotation.lastRotatedAt }), ...(current.rotation?.lastStatus === undefined ? {} : { lastStatus: current.rotation.lastStatus }), ...(cloudFormationOwner ? { cloudFormationOwner, cloudFormationRotateImmediatelyOnUpdate: cloudFormationRotateImmediatelyOnUpdate !== false } : {}), ...(operation ? { operation } : {}) };
      current.lastChangedAt = now; current.revision++; this.control.revision++; await this.store.save();
      return { ARN: current.arn, Name: current.name, VersionId: token };
    });
    this.scheduleRotationWorker();
    return output;
  }

  async CancelRotateSecret(input: any, cloudFormationOwner?: string): Promise<any> {
    const output = await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(input?.SecretId);
      if (!secret.rotation) invalidRequest("Rotation isn't configured for this secret.");
      if (secret.rotation.cloudFormationOwner && secret.rotation.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `Rotation on ${secret.arn} is owned by a CloudFormation stack resource.`, 400);
      if (cloudFormationOwner && secret.rotation.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("ResourceExistsException", `Rotation on ${secret.arn} is not owned by this CloudFormation resource.`, 400);
      secret.rotation.enabled = false; delete secret.rotation.nextRotationAt;
      const operation = secret.rotation.operation;
      if (operation?.status === "ACTIVE") { operation.status = "CANCELLING"; operation.updatedAt = this.clock.now(); operation.nextAttemptAt = this.clock.now(); }
      else { secret.rotation.lastStatus = "CANCELLED"; delete secret.rotation.operation; }
      secret.lastChangedAt = this.clock.now(); secret.revision++; this.control.revision++; await this.store.save();
      return { ARN: secret.arn, Name: secret.name, ...(operation ? { VersionId: operation.token } : {}) };
    });
    this.scheduleRotationWorker(); return output;
  }

  private async currentSecretObject(secret: SecretState): Promise<Record<string, unknown>> {
    const current = Object.values(secret.versions).find(version => version.stages.includes("AWSCURRENT"));
    if (!current || current.valueKind !== "SecretString") invalidRequest("An RDS target attachment requires a current JSON SecretString.");
    const plaintext = await this.materials.read(this.binding(secret, current), current.materialId);
    try {
      const parsed = JSON.parse(plaintext.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidRequest("An RDS target attachment requires a current JSON object.");
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof AwsError) throw error;
      invalidRequest("An RDS target attachment requires a current JSON SecretString.");
    } finally { plaintext.fill(0); }
  }

  async AttachSecretTarget(input: any, cloudFormationOwner?: string): Promise<any> {
    const supported = new Set(["SecretId", "TargetId", "TargetType"]);
    const unknown = Object.keys(input ?? {}).find(key => !supported.has(key));
    if (unknown) invalid(`${unknown} is outside the bounded SecretTargetAttachment profile.`);
    if (input?.TargetType !== "AWS::RDS::DBInstance") invalid("TargetType must be AWS::RDS::DBInstance.");
    if (!this.rdsTargets) throw new AwsError("InternalServiceError", "The local RDS attachment port is unavailable.", 500);
    const secret = this.required(input?.SecretId);
    if (secret.rotation?.operation && new Set(["ACTIVE", "CANCELLING"]).has(secret.rotation.operation.status)) invalidRequest("A target attachment can't change during rotation.");
    if (secret.targetAttachment?.cloudFormationOwner && secret.targetAttachment.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `The target attachment on ${secret.arn} is owned by another CloudFormation resource.`, 400);
    if (cloudFormationOwner && secret.targetAttachment && secret.targetAttachment.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("ResourceExistsException", `The target attachment on ${secret.arn} isn't owned by this CloudFormation resource.`, 400);
    const target = this.rdsTargets.describeTarget(String(input?.TargetId ?? ""));
    if (secret.targetAttachment && (secret.targetAttachment.targetArn !== target.targetArn || secret.targetAttachment.targetGenerationId !== target.targetGenerationId)) invalidRequest("The secret is already attached to a different target.");
    const value = await this.currentSecretObject(secret);
    if (typeof value.password !== "string" || !value.password || typeof value.username !== "string" || !value.username) invalidRequest("An RDS target attachment requires username and password string fields.");
    const next = { ...value, engine: target.engine, host: target.host, port: target.port, username: target.username, dbInstanceIdentifier: String(input.TargetId) };
    const token = randomUUID();
    await this.writeVersion({ SecretId: secret.arn, ClientRequestToken: token, SecretString: JSON.stringify(next) }, "UpdateSecret", undefined, secret.cloudFormationOwner);
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const current = this.required(secret.arn);
      current.targetAttachment = { targetType: "AWS::RDS::DBInstance", targetId: String(input.TargetId), targetArn: target.targetArn, targetGenerationId: target.targetGenerationId, attachedAt: this.clock.now(), ...(cloudFormationOwner ? { cloudFormationOwner } : {}) };
      current.lastChangedAt = this.clock.now(); current.revision++; this.control.revision++; await this.store.save();
    });
    return { ARN: secret.arn, Name: secret.name };
  }

  async DetachSecretTarget(secretId: unknown, cloudFormationOwner?: string): Promise<void> {
    const secret = this.required(secretId);
    const attachment = secret.targetAttachment;
    if (!attachment) return;
    if (attachment.cloudFormationOwner && attachment.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `The target attachment on ${secret.arn} is owned by another CloudFormation resource.`, 400);
    if (cloudFormationOwner && attachment.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("ResourceExistsException", `The target attachment on ${secret.arn} isn't owned by this CloudFormation resource.`, 400);
    if (secret.rotation?.operation && new Set(["ACTIVE", "CANCELLING"]).has(secret.rotation.operation.status)) invalidRequest("A target attachment can't change during rotation.");
    const value = await this.currentSecretObject(secret);
    const next = { ...value };
    for (const key of ["engine", "host", "port", "dbInstanceIdentifier"]) delete next[key];
    await this.writeVersion({ SecretId: secret.arn, ClientRequestToken: randomUUID(), SecretString: JSON.stringify(next) }, "UpdateSecret", undefined, secret.cloudFormationOwner);
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const current = this.required(secret.arn); delete current.targetAttachment; current.lastChangedAt = this.clock.now(); current.revision++; this.control.revision++; await this.store.save();
    });
  }

  async CreateManagedRdsSecret(input: { resourceId: string; targetArn: string; dbInstanceIdentifier: string; username: string; port: number; currentPassword?: string }): Promise<{ arn: string; generationId: string; versionId: string; password: string }> {
    if (!/^db-[a-f0-9]{26}$/.test(input.resourceId)) invalid("The managed RDS resource identity is invalid.");
    const password = input.currentPassword ?? String((await this.GetRandomPassword({ PasswordLength: 32, ExcludeCharacters: "/@\"" })).RandomPassword);
    const versionId = randomUUID();
    const name = `rds/${input.resourceId}`;
    const value = JSON.stringify({ engine: "mysql", host: "127.0.0.1", port: input.port, dbInstanceIdentifier: input.dbInstanceIdentifier, username: input.username, password });
    const created = await this.CreateSecret({ Name: name, ClientRequestToken: versionId, SecretString: value, Description: `RDS managed master credential for ${input.dbInstanceIdentifier}` });
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(created.ARN);
      secret.owningService = "rds.amazonaws.com"; secret.managedResourceArn = input.targetArn;
      secret.targetAttachment = { targetType: "AWS::RDS::DBInstance", targetId: input.dbInstanceIdentifier, targetArn: input.targetArn, targetGenerationId: input.resourceId, attachedAt: this.clock.now() };
      secret.lastChangedAt = this.clock.now(); secret.revision++; this.control.revision++; await this.store.save();
    });
    return { arn: String(created.ARN), generationId: this.required(created.ARN).generationId, versionId, password };
  }

  async DeleteManagedRdsSecret(secretId: string, managedResourceArn: string): Promise<void> {
    const secret = this.required(secretId, true);
    if (secret.owningService !== "rds.amazonaws.com" || secret.managedResourceArn !== managedResourceArn) throw new AwsError("AccessDeniedException", "The RDS managed-secret ownership boundary doesn't match.", 403);
    const removedMaterials = Object.values(secret.versions).map(version => version.materialId);
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const current = this.required(secret.arn, true);
      delete this.control.secrets[current.name]; (this.control.retiredSuffixes[current.name] ??= []).push(current.arnSuffix); this.control.revision++; await this.store.save();
    });
    for (const materialId of removedMaterials) await this.materials.remove(materialId).catch(() => undefined);
  }

  private scheduleRotationWorker(): void {
    this.cancelRotationTimer?.(); this.cancelRotationTimer = undefined;
    if (!this.scheduler || !this.started) return;
    const now = this.clock.now(); const times: number[] = [];
    for (const secret of Object.values(this.control.secrets)) {
      const operation = secret.rotation?.operation;
      if (operation && new Set(["ACTIVE", "CANCELLING"]).has(operation.status)) times.push(operation.leaseUntil ?? operation.nextAttemptAt);
      else if (secret.rotation?.enabled && secret.rotation.nextRotationAt !== undefined) times.push(secret.rotation.nextRotationAt);
    }
    if (!times.length) return;
    this.cancelRotationTimer = this.scheduler.schedule(async () => { this.cancelRotationTimer = undefined; await this.runRotationWorker(); this.scheduleRotationWorker(); }, Math.max(0, Math.min(...times) - now));
  }

  private async admitScheduledRotations(): Promise<void> {
    const now = this.clock.now();
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      let dirty = false;
      for (const secret of Object.values(this.control.secrets)) {
        const rotation = secret.rotation;
        if (!rotation?.enabled || rotation.operation && new Set(["ACTIVE", "CANCELLING"]).has(rotation.operation.status) || rotation.nextRotationAt === undefined || rotation.nextRotationAt > now) continue;
        const token = randomUUID(); rotation.operation = { token, status: "ACTIVE", step: "createSecret", completedSteps: [], attempts: {}, startedAt: now, updatedAt: now, nextAttemptAt: now, scheduled: true, testOnly: false, tested: false };
        rotation.nextRotationAt = this.nextRotationAt(rotation.rules, rotation.nextRotationAt, rotation.configuredAt); dirty = true;
      }
      if (dirty) await this.store.save();
    });
  }

  private safeRotationError(error: unknown): string {
    return error instanceof AwsError ? error.code : error instanceof Error ? error.name : "RotationStepFailure";
  }

  private async failOrRetry(secretArn: string, token: string, step: SecretRotationOperationState["step"], error: unknown): Promise<void> {
    let compensate = false;
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.find(secretArn); const operation = secret?.rotation?.operation; if (!secret || !operation || operation.token !== token) return;
      const attempts = operation.attempts[step] ?? 1; operation.updatedAt = this.clock.now(); operation.errorSummary = this.safeRotationError(error); delete operation.leaseId; delete operation.leaseUntil;
      if (attempts >= 3) { operation.status = "FAILED"; secret.rotation!.lastStatus = "FAILED"; secret.rotation!.lastErrorSummary = operation.errorSummary; compensate = Boolean(secret.targetAttachment); }
      else operation.nextAttemptAt = this.clock.now() + Math.min(60_000, 1000 * 2 ** (attempts - 1));
      secret.revision++; this.control.revision++; await this.store.save();
    });
    if (compensate) await this.rdsTargets?.compensate(secretArn, token).catch(() => undefined);
  }

  private async runRotationWorker(): Promise<void> {
    if (this.rotationWorkerRunning) return; this.rotationWorkerRunning = true;
    try {
      await this.admitScheduledRotations(); const now = this.clock.now();
      const candidate = Object.values(this.control.secrets).filter(secret => { const operation = secret.rotation?.operation; return operation && new Set(["ACTIVE", "CANCELLING"]).has(operation.status) && (operation.leaseUntil ?? operation.nextAttemptAt) <= now; }).sort((a, b) => a.arn.localeCompare(b.arn))[0];
      const operation = candidate?.rotation?.operation; if (!candidate || !operation) return;
      if (operation.status === "CANCELLING") {
        await this.rdsTargets?.compensate(candidate.arn, operation.token).catch(() => undefined);
        await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => { const current = this.find(candidate.arn); const active = current?.rotation?.operation; if (!current?.rotation || !active || active.token !== operation.token) return; active.status = "CANCELLED"; active.updatedAt = this.clock.now(); current.rotation.lastStatus = "CANCELLED"; delete current.rotation.operation; current.revision++; this.control.revision++; await this.store.save(); });
        return;
      }
      const step = operation.step; const token = operation.token; const requestId = randomUUID();
      await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => { const current = this.find(candidate.arn)!.rotation!.operation!; current.attempts[step] = (current.attempts[step] ?? 0) + 1; current.lastRequestId = requestId; current.leaseId = randomUUID(); current.leaseUntil = this.clock.now() + 30_000; current.updatedAt = this.clock.now(); await this.store.save(); });
      try {
        if (!this.rotationInvoker) throw new AwsError("InternalServiceError", "Lambda rotation is not initialized.", 500);
        await this.rotationInvoker.invoke(candidate.rotation!.lambdaArn, { Step: step, SecretId: candidate.arn, ClientRequestToken: token }, requestId, [candidate.arn, `rotation:${token}`, `step:${step}`]);
        const refreshed = this.required(candidate.arn); const version = this.pendingVersion(refreshed, token);
        if (step === "createSecret" && (!version || !version.stages.includes("AWSPENDING") || version.stages.includes("AWSCURRENT"))) invalidRequest("createSecret didn't leave the client token at AWSPENDING.");
        if (step === "setSecret" && refreshed.targetAttachment) await this.rdsTargets?.applyPending(refreshed.arn, token);
        if (step === "finishSecret" && (!version?.stages.includes("AWSCURRENT") || !operation.tested)) invalidRequest("finishSecret didn't promote the tested client token to AWSCURRENT.");
        if (step === "finishSecret" && refreshed.targetAttachment) await this.rdsTargets?.finalize(refreshed.arn, token);
        await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
          const secret = this.find(candidate.arn); const active = secret?.rotation?.operation; if (!secret?.rotation || !active || active.token !== token || active.status !== "ACTIVE") return;
          active.completedSteps.push(step); active.updatedAt = this.clock.now(); delete active.leaseId; delete active.leaseUntil; delete active.errorSummary;
          const steps: SecretRotationOperationState["step"][] = ["createSecret", "setSecret", "testSecret", "finishSecret"];
          if (step === "testSecret") active.tested = true;
          const index = steps.indexOf(step);
          if (index === steps.length - 1) { active.status = "SUCCEEDED"; secret.rotation.lastStatus = "SUCCEEDED"; secret.rotation.lastRotatedAt = this.clock.now(); secret.rotation.nextRotationAt = this.nextRotationAt(secret.rotation.rules, this.clock.now(), secret.rotation.configuredAt); delete secret.rotation.lastErrorSummary; delete secret.rotation.operation; }
          else { active.step = steps[index + 1]; active.nextAttemptAt = this.clock.now(); }
          secret.lastChangedAt = this.clock.now(); secret.revision++; this.control.revision++; await this.store.save();
        });
      } catch (error) { await this.failOrRetry(candidate.arn, token, step, error); }
    } finally { this.rotationWorkerRunning = false; }
  }

  private cursor(scope: string, token: unknown, signature: string): number {
    if (token === undefined) return 0;
    try {
      const decoded = this.tokens.decode<{ index: number; signature: string }>(scope, String(token));
      if (decoded.signature !== signature || !Number.isInteger(decoded.index) || decoded.index < 0) throw new Error();
      return decoded.index;
    } catch {
      throw new AwsError("InvalidNextTokenException", "The next token is invalid.", 400);
    }
  }

  async DeleteSecret(input: any, cloudFormationOwner?: string): Promise<any> {
    await this.sweepDueDeletions();
    if (input?.ForceDeleteWithoutRecovery === true && input?.RecoveryWindowInDays !== undefined) invalid("You can't use ForceDeleteWithoutRecovery and RecoveryWindowInDays together.");
    const force = input?.ForceDeleteWithoutRecovery === true;
    const days = force ? undefined : positiveInteger(input?.RecoveryWindowInDays, "RecoveryWindowInDays", 7, 30, 30);
    let removedMaterials: string[] = [];
    const output = await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(input?.SecretId, true);
      if (secret.owningService === "rds.amazonaws.com") invalidRequest("This secret is managed by Amazon RDS and can't be deleted directly.");
      if (secret.rotation?.operation && new Set(["ACTIVE", "CANCELLING"]).has(secret.rotation.operation.status)) invalidRequest("A secret can't be deleted while rotation is active; cancel rotation first.");
      this.assertCloudFormationMutation(secret, cloudFormationOwner);
      const before = structuredClone(this.control);
      try {
        if (force) {
          removedMaterials = Object.values(secret.versions).map(version => version.materialId);
          delete this.control.secrets[secret.name];
          (this.control.retiredSuffixes[secret.name] ??= []).push(secret.arnSuffix);
          this.control.revision++;
          await this.store.save();
          return { ARN: secret.arn, Name: secret.name, DeletionDate: this.clock.now() / 1_000 };
        }
        if (secret.deletedAt === undefined) {
          if (secret.rotation) { secret.rotation.enabled = false; delete secret.rotation.nextRotationAt; }
          secret.deletedAt = this.clock.now() + days! * DAY_MS;
          secret.lastChangedAt = this.clock.now();
          secret.revision++;
          this.control.revision++;
          await this.store.save();
        }
        return { ARN: secret.arn, Name: secret.name, DeletionDate: secret.deletedAt! / 1_000 };
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
    for (const materialId of removedMaterials) await this.materials.remove(materialId).catch(() => undefined);
    this.scheduleDeletionSweep();
    return output;
  }

  async RestoreSecret(input: any, cloudFormationOwner?: string): Promise<any> {
    await this.sweepDueDeletions();
    const output = await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(input?.SecretId, true);
      this.assertCloudFormationMutation(secret, cloudFormationOwner);
      if (secret.deletedAt === undefined) invalidRequest("The secret is not scheduled for deletion.");
      const before = structuredClone(this.control);
      try {
        delete secret.deletedAt;
        secret.lastChangedAt = this.clock.now();
        secret.revision++;
        this.control.revision++;
        await this.store.save();
        return { ARN: secret.arn, Name: secret.name };
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
    this.scheduleDeletionSweep();
    return output;
  }

  async TagResource(input: any, principal?: any): Promise<any> {
    const additions = tagMap(input?.Tags);
    return this.mutateTags(input?.SecretId, additions, [], principal);
  }

  async UntagResource(input: any, principal?: any): Promise<any> {
    if (!Array.isArray(input?.TagKeys) || input.TagKeys.length < 1 || input.TagKeys.length > 50 || input.TagKeys.some((key: unknown) => typeof key !== "string" || !key)) invalid("TagKeys must contain between 1 and 50 keys.");
    return this.mutateTags(input?.SecretId, {}, input.TagKeys, principal);
  }

  private async mutateTags(secretId: unknown, additions: Record<string, string>, removals: string[], principal?: any, cloudFormationOwner?: string): Promise<any> {
    return this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const secret = this.required(secretId);
      this.assertCloudFormationMutation(secret, cloudFormationOwner);
      const prospective = { ...secret.tags, ...additions };
      for (const key of removals) delete prospective[key];
      if (Object.keys(prospective).length > 50) invalid("A secret can have at most 50 tags.");
      const action = removals.length ? "secretsmanager:UntagResource" : "secretsmanager:TagResource";
      if (principal && this.authorizeTagMutation) await this.authorizeTagMutation(principal, action, secret.arn, additions, prospective);
      const before = structuredClone(this.control);
      try {
        secret.tags = prospective;
        secret.lastChangedAt = this.clock.now();
        secret.revision++;
        this.control.revision++;
        await this.store.save();
        return {};
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
  }

  async GetRandomPassword(input: any): Promise<any> {
    const length = positiveInteger(input?.PasswordLength, "PasswordLength", 4, 4096, 32);
    if (input?.ExcludeCharacters !== undefined && (typeof input.ExcludeCharacters !== "string" || input.ExcludeCharacters.length > 4096)) invalid("ExcludeCharacters must be a string no longer than 4096 characters.");
    const excluded = new Set(String(input?.ExcludeCharacters ?? ""));
    const groups = [
      input?.ExcludeLowercase === true ? "" : "abcdefghijklmnopqrstuvwxyz",
      input?.ExcludeUppercase === true ? "" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      input?.ExcludeNumbers === true ? "" : "0123456789",
      input?.ExcludePunctuation === true ? "" : PASSWORD_PUNCTUATION,
    ].map(group => [...group].filter(character => !excluded.has(character)).join("")).filter(Boolean);
    const alphabet = [...new Set(`${groups.join("")}${input?.IncludeSpace === true && !excluded.has(" ") ? " " : ""}`)].join("");
    if (!alphabet) invalid("No characters remain after applying the exclusions.");
    const required = input?.RequireEachIncludedType !== false ? groups.map(group => group[randomInt(group.length)]) : [];
    if (required.length > length) invalid("PasswordLength is too short to include each requested character type.");
    const characters = [...required, ...Array.from({ length: length - required.length }, () => alphabet[randomInt(alphabet.length)])];
    for (let index = characters.length - 1; index > 0; index--) {
      const other = randomInt(index + 1);
      [characters[index], characters[other]] = [characters[other], characters[index]];
    }
    return { RandomPassword: characters.join("") };
  }

  private async generatedSecretString(value: unknown): Promise<string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("GenerateSecretString must be an object.");
    const input = value as Record<string, unknown>;
    const supported = new Set(["ExcludeCharacters", "ExcludeLowercase", "ExcludeNumbers", "ExcludePunctuation", "ExcludeUppercase", "GenerateStringKey", "IncludeSpace", "PasswordLength", "RequireEachIncludedType", "SecretStringTemplate"]);
    const unsupported = Object.keys(input).filter(key => !supported.has(key)).sort()[0];
    if (unsupported) invalid(`GenerateSecretString.${unsupported} is not supported.`);
    const password = (await this.GetRandomPassword(input)).RandomPassword as string;
    const template = input.SecretStringTemplate;
    const key = input.GenerateStringKey;
    if (key !== undefined && (typeof key !== "string" || !key || key.includes(":"))) invalid("GenerateStringKey must be a non-empty string without a colon.");
    if ((template === undefined) !== (key === undefined)) invalid("GenerateStringKey and SecretStringTemplate must be specified together.");
    if (template === undefined) return password;
    if (typeof template !== "string") invalid("SecretStringTemplate must be a JSON string.");
    let parsed: unknown;
    try { parsed = JSON.parse(template); } catch { return invalid("SecretStringTemplate must contain valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("SecretStringTemplate must contain a JSON object.");
    if (Object.hasOwn(parsed, key as string)) invalid("GenerateStringKey must not already exist in SecretStringTemplate.");
    return JSON.stringify({ ...(parsed as Record<string, unknown>), [key as string]: password });
  }

  async CreateSecretCloudFormation(input: any, cloudFormationOwner: string, clientRequestToken: string): Promise<SecretState> {
    const existing = this.find(input?.Name);
    if (existing) {
      this.assertCloudFormationMutation(existing, cloudFormationOwner);
      return structuredClone(existing);
    }
    if (input?.SecretString !== undefined && input?.GenerateSecretString !== undefined) invalid("SecretString and GenerateSecretString are mutually exclusive.");
    const generated = input?.GenerateSecretString === undefined ? undefined : await this.generatedSecretString(input.GenerateSecretString);
    await this.CreateSecret({
      Name: input?.Name,
      ...(input?.Description === undefined ? {} : { Description: input.Description }),
      ...(input?.Tags === undefined ? {} : { Tags: input.Tags }),
      ...(input?.SecretString === undefined && generated === undefined ? {} : { SecretString: input.SecretString ?? generated, ClientRequestToken: clientRequestToken }),
    }, cloudFormationOwner, input?.GenerateSecretString);
    return structuredClone(this.required(input.Name));
  }

  async UpdateSecretCloudFormation(input: any, cloudFormationOwner: string, clientRequestToken: string, writeValue: boolean): Promise<SecretState> {
    let secret = this.required(input?.SecretId);
    this.assertCloudFormationMutation(secret, cloudFormationOwner);
    if (writeValue) {
      if (secret.versions[clientRequestToken]) return structuredClone(secret);
      const generated = input?.GenerateSecretString === undefined ? undefined : await this.generatedSecretString(input.GenerateSecretString);
      if (input?.SecretString === undefined && generated === undefined) invalid("A changed secret-value property must provide SecretString or GenerateSecretString.");
      await this.UpdateSecret({ SecretId: secret.arn, Description: input?.Description ?? "", SecretString: input?.SecretString ?? generated, ClientRequestToken: clientRequestToken }, cloudFormationOwner, input?.GenerateSecretString);
    } else if ((secret.description ?? "") !== (input?.Description ?? "")) {
      await this.UpdateSecret({ SecretId: secret.arn, Description: input?.Description ?? "" }, cloudFormationOwner, input?.GenerateSecretString);
    }
    secret = this.required(input.SecretId);
    const desiredTags = tagMap(input?.Tags);
    const additions = Object.fromEntries(Object.entries(desiredTags).filter(([key, value]) => secret.tags[key] !== value));
    const removals = Object.keys(secret.tags).filter(key => !Object.hasOwn(desiredTags, key));
    if (Object.keys(additions).length || removals.length) await this.mutateTags(secret.arn, additions, removals, undefined, cloudFormationOwner);
    return structuredClone(this.required(secret.arn));
  }

  readSecretCloudFormation(secretId: unknown): SecretState | undefined {
    const secret = this.find(secretId);
    return secret ? structuredClone(secret) : undefined;
  }

  async DeleteSecretCloudFormation(secretId: unknown, cloudFormationOwner: string): Promise<void> {
    const secret = this.find(secretId);
    if (!secret) return;
    this.assertCloudFormationMutation(secret, cloudFormationOwner);
    await this.DeleteSecret({ SecretId: secret.arn, ForceDeleteWithoutRecovery: true }, cloudFormationOwner);
  }

  async PutResourcePolicyCloudFormation(input: any, cloudFormationOwner: string, principal?: PrincipalContext): Promise<SecretState> {
    await this.PutResourcePolicy(input, principal, cloudFormationOwner);
    return structuredClone(this.required(input.SecretId, true));
  }

  async DeleteResourcePolicyCloudFormation(secretId: unknown, cloudFormationOwner: string): Promise<void> {
    const secret = this.find(secretId);
    if (!secret || !secret.resourcePolicy) return;
    await this.DeleteResourcePolicy({ SecretId: secret.arn }, cloudFormationOwner);
  }

  private async sweepDueDeletions(): Promise<void> {
    if (!this.started) return;
    const due = Object.values(this.control.secrets).filter(secret => secret.deletedAt !== undefined && secret.deletedAt <= this.clock.now());
    if (!due.length) return;
    const materials: string[] = [];
    await this.store.withMutationLock(`secretsmanager:${this.store.accountId}:${this.region}`, async () => {
      const currentDue = Object.values(this.control.secrets).filter(secret => secret.deletedAt !== undefined && secret.deletedAt <= this.clock.now());
      if (!currentDue.length) return;
      const before = structuredClone(this.control);
      try {
        for (const secret of currentDue) {
          materials.push(...Object.values(secret.versions).map(version => version.materialId));
          delete this.control.secrets[secret.name];
          (this.control.retiredSuffixes[secret.name] ??= []).push(secret.arnSuffix);
        }
        this.control.revision++;
        await this.store.save();
      } catch (error) {
        this.store.regionState(this.region).secretsManager = before;
        throw error;
      }
    });
    for (const materialId of materials) await this.materials.remove(materialId).catch(() => undefined);
  }

  private scheduleDeletionSweep(): void {
    this.cancelDeletionTimer?.();
    this.cancelDeletionTimer = undefined;
    if (!this.scheduler) return;
    const dates = Object.values(this.control.secrets).flatMap(secret => secret.deletedAt === undefined ? [] : [secret.deletedAt]);
    if (!dates.length) return;
    const delay = Math.min(2_147_000_000, Math.max(0, Math.min(...dates) - this.clock.now()));
    this.cancelDeletionTimer = this.scheduler.schedule(async () => {
      this.cancelDeletionTimer = undefined;
      await this.sweepDueDeletions();
      this.scheduleDeletionSweep();
    }, delay);
  }

  localMetadata(): Array<Record<string, unknown>> {
    return Object.values(this.control.secrets).sort((a, b) => a.name.localeCompare(b.name)).map(secret => ({
      name: secret.name, arn: secret.arn, deletedAt: secret.deletedAt, cloudFormationOwner: secret.cloudFormationOwner,
      resourcePolicyCloudFormationOwner: secret.resourcePolicy?.cloudFormationOwner,
      owningService: secret.owningService,
      rotation: secret.rotation ? { enabled: secret.rotation.enabled, lambdaArn: secret.rotation.lambdaArn, nextRotationAt: secret.rotation.nextRotationAt, lastRotatedAt: secret.rotation.lastRotatedAt, lastStatus: secret.rotation.lastStatus, lastErrorSummary: secret.rotation.lastErrorSummary, activeStep: secret.rotation.operation?.step, cloudFormationOwner: secret.rotation.cloudFormationOwner } : undefined,
      targetAttachment: secret.targetAttachment ? { targetType: secret.targetAttachment.targetType, targetId: secret.targetAttachment.targetId, targetArn: secret.targetAttachment.targetArn, cloudFormationOwner: secret.targetAttachment.cloudFormationOwner } : undefined,
    }));
  }
}
