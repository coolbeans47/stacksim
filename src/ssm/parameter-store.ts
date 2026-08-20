import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../core/clock.js";
import type { Scheduler } from "../core/scheduler.js";
import { PaginationTokens } from "../core/pagination.js";
import { EncryptedMaterialStore, type MaterialBinding } from "../configuration-secrets/encrypted-material-store.js";
import { AwsError } from "../errors.js";
import type { StateStore } from "../state.js";
import type { CloudFormationBootstrapState, ParameterPolicyState, ParameterState, ParameterStoreEventOutboxState, ParameterStoreRegionState, ParameterVersionState } from "../types.js";
import { canonicalParameterName, canonicalParameterPath, parameterValue, positiveInteger, tags, validation } from "./validation.js";

const TOMBSTONE_MS = 30_000;
const MAX_VERSIONS = 100;
const POLICY_LIMIT = 10;
const EVENT_RETRY_LIMIT_MS = 60_000;
const DEFAULT_SECURE_STRING_KEY_ID = "alias/aws/ssm";

const DESCRIBE_PARAMETER_FILTER_KEYS = new Set(["Name", "Type", "KeyId", "Path", "Tier", "DataType"]);

function invalidFilterKey(key: unknown): never {
  throw new AwsError("InvalidFilterKey", `The specified filter key ${String(key ?? "(empty)")} isn't valid.`, 400);
}

function invalidFilterOption(): never {
  throw new AwsError("InvalidFilterOption", "The specified filter option isn't valid. Valid options are Equals and BeginsWith. For Path filter, valid options are Recursive and OneLevel.", 400);
}

function invalidFilterValue(): never {
  throw new AwsError("InvalidFilterValue", "The filter value isn't valid. Verify the value and try again.", 400);
}

function matchesStringFilter(actual: string, option: string, requested: readonly string[]): boolean {
  return requested.some(value => option === "BeginsWith" ? actual.startsWith(value) : option === "Contains" ? actual.includes(value) : actual === value);
}

export type ParameterStoreEventPublisher = (input: { source: "aws.ssm"; detailType: ParameterStoreEventOutboxState["detailType"]; detail: Readonly<Record<string, string>>; resources: string[]; time: number; eventBusName: "default"; deliveryLineage: string[] }) => Promise<unknown>;

function partition(region: string): string {
  return region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
}

export function parameterArn(region: string, accountId: string, name: string): string {
  return `arn:${partition(region)}:ssm:${region}:${accountId}:parameter/${name.replace(/^\/+/, "")}`;
}

interface Selector {
  name: string;
  selector?: string;
  version?: string;
  label?: string;
}

export class ParameterStore {
  private readonly materials: EncryptedMaterialStore;
  private readonly tokens: PaginationTokens;
  private started = false;
  private cancelWorker?: () => void;

  constructor(
    private readonly store: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler?: Scheduler,
    private readonly publishEvent?: ParameterStoreEventPublisher,
  ) {
    this.materials = new EncryptedMaterialStore(store.root, "ssm");
    this.tokens = new PaginationTokens(store.state.installation.paginationSecret);
  }

  async start(): Promise<void> {
    this.control.eventOutbox ??= [];
    this.control.completedPolicyOccurrences ??= {};
    await this.reconcileBootstrapFromState();
    const referenced = new Set<string>();
    for (const account of Object.values(this.store.state.accounts)) for (const region of Object.values(account.regions)) {
      const parameterArns = new Set<string>();
      for (const parameter of Object.values(region.parameterStore?.parameters ?? {})) {
        parameter.policies ??= [];
        if (parameterArns.has(parameter.arn)) throw new AwsError("InternalServerError", `Parameter ${parameter.name} has a duplicate catalog identity.`, 500);
        parameterArns.add(parameter.arn);
        if (parameter.owner === "stacksim:cdk-bootstrap" && (parameter.cloudFormationOwner || parameter.cloudFormationRetained) || parameter.cloudFormationOwner !== undefined && !parameter.cloudFormationOwner || parameter.cloudFormationOwner && parameter.cloudFormationRetained) throw new AwsError("InternalServerError", `Parameter ${parameter.name} has corrupt ownership metadata.`, 500);
        const counts = new Map<number, number>();
        for (const [label, version] of Object.entries(parameter.labels ?? {})) {
          if (!this.validLabel(label) || !parameter.versions[String(version)]) throw new AwsError("InternalServerError", `Parameter ${parameter.name} has corrupt label metadata.`, 500);
          counts.set(version, (counts.get(version) ?? 0) + 1);
        }
        if ([...counts.values()].some(count => count > 10)) throw new AwsError("InternalServerError", `Parameter ${parameter.name} exceeds the label limit.`, 500);
        for (const version of Object.values(parameter.versions)) {
          if (version.storageKind === "ENCRYPTED" && version.materialId) referenced.add(version.materialId);
        }
      }
    }
    await this.materials.start(referenced);
    this.started = true;
    await this.processDuePolicies();
    this.scheduleWorker();
  }

  stop(): void { this.cancelWorker?.(); this.cancelWorker = undefined; }

  private requireStarted(): void {
    if (!this.started) throw new AwsError("InternalServerError", "Parameter Store protected storage is not ready.", 500);
  }

  private get control() {
    return this.store.regionState(this.region).parameterStore;
  }

  private outbox(): ParameterStoreEventOutboxState[] { return this.control.eventOutbox ??= []; }
  private completions(): Record<string, number> { return this.control.completedPolicyOccurrences ??= {}; }

  private enqueueChange(parameter: Pick<ParameterState, "name" | "arn" | "type" | "description">, operation: "Create" | "Update" | "Delete" | "LabelParameterVersion", now: number): void {
    this.outbox().push({ id: randomUUID(), detailType: "Parameter Store Change", parameterName: parameter.name, parameterArn: parameter.arn, detail: { name: parameter.name, type: parameter.type, operation, ...(parameter.description === undefined ? {} : { description: parameter.description }) }, createdAt: now, attempts: 0, nextAttemptAt: now });
  }

  private enqueuePolicy(parameter: Pick<ParameterState, "name" | "arn">, policy: ParameterPolicyState, now: number): void {
    this.outbox().push({ id: policy.occurrenceId, detailType: "Parameter Store Policy Action", parameterName: parameter.name, parameterArn: parameter.arn, detail: { "parameter-name": parameter.name, "policy-type": policy.type }, createdAt: now, attempts: 0, nextAttemptAt: now });
  }

  private policyOccurrence(generationId: string, revision: number, index: number, type: string, dueAt: number): string {
    return createHash("sha256").update(`pss05\0${generationId}\0${revision}\0${index}\0${type}\0${dueAt}`).digest("hex");
  }

  private policies(value: unknown, tier: ParameterState["tier"], generationId: string, revision: number, modifiedAt: number): ParameterPolicyState[] {
    if (value === undefined) return [];
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) validation("Policies must be a JSON string no larger than 4096 bytes.");
    if (value === "") return [];
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { validation("Policies must contain a valid JSON array."); }
    if (!Array.isArray(parsed) || parsed.length > POLICY_LIMIT) validation("Policies must contain at most ten policy objects.");
    if (parsed.length === 1 && parsed[0] && typeof parsed[0] === "object" && !Array.isArray(parsed[0]) && Object.keys(parsed[0]).length === 0) return [];
    if (tier !== "Advanced" && parsed.length) validation("Parameter policies require Tier=Advanced.");
    const normalized = parsed.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) validation("Each parameter policy must be an object.");
      const object = raw as Record<string, unknown>;
      if (Object.keys(object).some(key => !["Type", "Version", "Attributes"].includes(key))) validation("A parameter policy contains an unsupported field.");
      const type = String(object.Type ?? "") as ParameterPolicyState["type"];
      if (!new Set(["Expiration", "ExpirationNotification", "NoChangeNotification"]).has(type)) throw new AwsError("InvalidPolicyTypeException", `Policy type ${type || "(empty)"} is not supported.`, 400);
      if (object.Version !== "1.0") throw new AwsError("InvalidPolicyAttributeException", "Parameter policy Version must be 1.0.", 400);
      if (!object.Attributes || typeof object.Attributes !== "object" || Array.isArray(object.Attributes)) throw new AwsError("InvalidPolicyAttributeException", "Parameter policy Attributes must be an object.", 400);
      const attributes = Object.fromEntries(Object.entries(object.Attributes as Record<string, unknown>).map(([key, item]) => [key, String(item)]).sort(([a], [b]) => a.localeCompare(b)));
      let dueAt: number;
      if (type === "Expiration") {
        if (Object.keys(attributes).length !== 1 || !attributes.Timestamp) throw new AwsError("InvalidPolicyAttributeException", "Expiration requires only Attributes.Timestamp.", 400);
        dueAt = Date.parse(attributes.Timestamp);
        if (!Number.isFinite(dueAt) || dueAt <= modifiedAt) throw new AwsError("InvalidPolicyAttributeException", "Expiration Timestamp must be a valid future ISO-8601 instant.", 400);
      } else {
        const amountKey = type === "ExpirationNotification" ? "Before" : "After";
        if (Object.keys(attributes).length !== 2 || !/^[1-9]\d*$/.test(attributes[amountKey] ?? "") || !new Set(["Hours", "Days"]).has(attributes.Unit)) throw new AwsError("InvalidPolicyAttributeException", `${type} requires a positive ${amountKey} and Unit Hours or Days.`, 400);
        const delta = Number(attributes[amountKey]) * (attributes.Unit === "Hours" ? 3_600_000 : 86_400_000);
        dueAt = type === "NoChangeNotification" ? modifiedAt + delta : 0;
      }
      return { type, version: "1.0" as const, attributes, dueAt, occurrenceId: "" };
    });
    if (normalized.filter(policy => policy.type === "Expiration").length > 1 || normalized.filter(policy => policy.type === "NoChangeNotification").length > 1) throw new AwsError("IncompatiblePolicyException", "Only one Expiration and one NoChangeNotification policy are supported per parameter.", 400);
    const expiration = normalized.find(policy => policy.type === "Expiration")?.dueAt;
    for (const policy of normalized) if (policy.type === "ExpirationNotification") {
      if (expiration === undefined) throw new AwsError("IncompatiblePolicyException", "ExpirationNotification requires an Expiration policy.", 400);
      const delta = Number(policy.attributes.Before) * (policy.attributes.Unit === "Hours" ? 3_600_000 : 86_400_000);
      policy.dueAt = expiration - delta;
      if (policy.dueAt <= modifiedAt) throw new AwsError("InvalidPolicyAttributeException", "ExpirationNotification must be scheduled in the future and before expiration.", 400);
    }
    normalized.forEach((policy, index) => { policy.occurrenceId = this.policyOccurrence(generationId, revision, index, policy.type, policy.dueAt); });
    return normalized;
  }

  private policyViews(parameter: ParameterState): Array<{ PolicyText: string; PolicyType: string; PolicyStatus: string }> {
    return parameter.policies.map(policy => ({ PolicyText: JSON.stringify({ Type: policy.type, Version: policy.version, Attributes: policy.attributes }), PolicyType: policy.type, PolicyStatus: this.completions()[policy.occurrenceId] ? "FINISHED" : "PENDING" }));
  }

  private scheduleWorker(): void {
    this.cancelWorker?.(); this.cancelWorker = undefined;
    if (!this.scheduler || !this.started) return;
    const now = this.clock.now();
    const due = [
      ...Object.values(this.control.parameters).flatMap(parameter => parameter.policies.map(policy => policy.dueAt)).filter(at => at >= now),
      ...this.outbox().map(item => item.nextAttemptAt),
    ].sort((a, b) => a - b)[0];
    if (due === undefined) return;
    this.cancelWorker = this.scheduler.schedule(async () => { this.cancelWorker = undefined; await this.processDuePolicies(); await this.deliverOutbox(); this.scheduleWorker(); }, Math.max(0, due - now));
  }

  private async processDuePolicies(): Promise<void> {
    const now = this.clock.now();
    await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
      let dirty = false;
      for (const parameter of Object.values(this.control.parameters)) {
        const due = parameter.policies.filter(policy => policy.dueAt <= now && !this.completions()[policy.occurrenceId]);
        for (const policy of due) {
          this.enqueuePolicy(parameter, policy, now); this.completions()[policy.occurrenceId] = now; dirty = true;
          if (policy.type === "Expiration" && this.control.parameters[parameter.name]) {
            this.enqueueChange(parameter, "Delete", now);
            delete this.control.parameters[parameter.name];
            this.control.tombstones[parameter.name] = { generationId: parameter.generationId, deletedAt: now, reusableAt: now + TOMBSTONE_MS, ...(parameter.cloudFormationOwner ? { cloudFormationOwner: parameter.cloudFormationOwner } : {}) };
            this.control.revision++;
          }
        }
      }
      const completions = Object.entries(this.completions()).sort((a, b) => a[1] - b[1]);
      while (completions.length > 2_000) delete this.completions()[completions.shift()![0]];
      if (dirty) await this.store.save();
    });
  }

  private async deliverOutbox(): Promise<void> {
    if (!this.publishEvent) return;
    const now = this.clock.now();
    for (const item of [...this.outbox()].filter(candidate => candidate.nextAttemptAt <= now)) {
      try {
        await this.publishEvent({ source: "aws.ssm", detailType: item.detailType, detail: item.detail, resources: [item.parameterArn], time: item.createdAt, eventBusName: "default", deliveryLineage: [item.parameterArn, `ssm-event:${item.id}`] });
        await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => { const index = this.outbox().findIndex(candidate => candidate.id === item.id); if (index >= 0) { this.outbox().splice(index, 1); await this.store.save(); } });
      } catch {
        await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => { const current = this.outbox().find(candidate => candidate.id === item.id); if (current) { current.attempts++; current.nextAttemptAt = this.clock.now() + Math.min(EVENT_RETRY_LIMIT_MS, 1000 * 2 ** Math.min(6, current.attempts - 1)); await this.store.save(); } });
      }
    }
  }

  private selector(value: unknown): Selector {
    if (typeof value !== "string" || !value) validation("Name is required.");
    if (Buffer.byteLength(value, "utf8") > 2_048) validation("Name exceeds the maximum length of 2048 characters.");
    const supplied = value.trim();
    if (!supplied) validation("Name is required.");
    let base = supplied;
    let selector: string | undefined;
    const arnParameter = supplied.startsWith("arn:") ? supplied.indexOf(":parameter/") : -1;
    const lastColon = supplied.lastIndexOf(":");
    if (lastColon > (arnParameter >= 0 ? arnParameter + 11 : 0)) {
      base = supplied.slice(0, lastColon);
      selector = supplied.slice(lastColon + 1);
    }
    const name = canonicalParameterName(base, true);
    if (selector === undefined) return { name };
    if (/^[1-9]\d*$/.test(selector)) return { name, selector, version: selector };
    if (!/^[A-Za-z_.-][A-Za-z0-9_.-]{0,99}$/.test(selector) || /^(?:aws|ssm)/i.test(selector)) validation("The parameter selector is invalid.");
    return { name, selector, label: selector };
  }

  private parameterEntry(name: string): { key: string; parameter: ParameterState } | undefined {
    const exact = this.control.parameters[name];
    if (exact) return { key: name, parameter: exact };
    const alias = name.startsWith("/") ? name.slice(1) : `/${name}`;
    const parameter = this.control.parameters[alias];
    return parameter ? { key: alias, parameter } : undefined;
  }

  private parameter(name: string): ParameterState | undefined {
    return this.parameterEntry(name)?.parameter;
  }

  private tombstoneEntry(name: string): { key: string; tombstone: ParameterStoreRegionState["tombstones"][string] } | undefined {
    const exact = this.control.tombstones[name];
    if (exact) return { key: name, tombstone: exact };
    const alias = name.startsWith("/") ? name.slice(1) : `/${name}`;
    const tombstone = this.control.tombstones[alias];
    return tombstone ? { key: alias, tombstone } : undefined;
  }

  private resolve(selector: Selector): { parameter?: ParameterState; version?: ParameterVersionState } {
    const parameter = this.parameter(selector.name);
    if (!parameter) return {};
    const version = selector.label === undefined
      ? selector.version ?? String(parameter.currentVersion)
      : String(parameter.labels[selector.label] ?? "");
    return { parameter, version: parameter.versions[version] };
  }

  private binding(parameter: ParameterState, version: ParameterVersionState): MaterialBinding {
    return {
      service: "ssm",
      accountId: this.store.accountId,
      region: this.region,
      resourceArn: parameter.arn,
      generationId: parameter.generationId,
      valueKind: "SecureString",
      version: version.version,
    };
  }

  private async view(parameter: ParameterState, version: ParameterVersionState, withDecryption: boolean, selector?: string): Promise<any> {
    let Value: string;
    if (version.storageKind === "PLAIN") Value = version.value ?? "";
    else {
      this.requireStarted();
      Value = withDecryption
        ? (await this.materials.read(this.binding(parameter, version), version.materialId!)).toString("utf8")
        : await this.materials.opaqueValue(this.binding(parameter, version), version.materialId!);
    }
    return {
      Name: parameter.name,
      Type: parameter.type,
      Value,
      Version: version.version,
      ...(selector ? { Selector: selector } : {}),
      LastModifiedDate: version.createdAt / 1_000,
      ARN: parameter.arn,
      DataType: parameter.dataType,
    };
  }

  async GetParameter(input: any): Promise<any> {
    await this.reconcileBootstrapFromState();
    const selected = this.selector(input?.Name);
    const found = this.resolve(selected);
    if (!found.parameter) throw new AwsError("ParameterNotFound", `Parameter ${selected.name} not found.`, 400);
    if (!found.version) {
      if (selected.version) throw new AwsError("ParameterVersionNotFound", `Parameter version ${selected.version} for ${selected.name} was not found.`, 400);
      throw new AwsError("ParameterNotFound", `Parameter ${selected.name} not found.`, 400);
    }
    return { Parameter: await this.view(found.parameter, found.version, input?.WithDecryption === true, selected.selector) };
  }

  async GetParameters(input: any): Promise<any> {
    await this.reconcileBootstrapFromState();
    if (!Array.isArray(input?.Names) || input.Names.length < 1 || input.Names.length > 10 || input.Names.some((name: unknown) => typeof name !== "string")) validation("Names must contain between 1 and 10 parameter name strings.");
    const Parameters: any[] = [];
    const InvalidParameters: string[] = [];
    for (const supplied of input.Names as string[]) {
      let selected: Selector;
      try { selected = this.selector(supplied); } catch { InvalidParameters.push(supplied); continue; }
      const found = this.resolve(selected);
      if (!found.parameter || !found.version) InvalidParameters.push(supplied);
      else Parameters.push(await this.view(found.parameter, found.version, input?.WithDecryption === true, selected.selector));
    }
    Parameters.sort((left, right) => left.Name.localeCompare(right.Name));
    return { Parameters, InvalidParameters };
  }

  async PutParameter(input: any, principalArn = `arn:aws:iam::${this.store.accountId}:root`, cloudFormationOwner?: string): Promise<any> {
    this.requireStarted();
    const name = canonicalParameterName(input?.Name, false);
    if (Buffer.byteLength(parameterArn(this.region, this.store.accountId, name), "utf8") > 1011) validation("Parameter name exceeds the maximum length after ARN prefix accounting.");
    const existingEntry = this.parameterEntry(name);
    const existing = existingEntry?.parameter;
    if (!existing && (input?.Type === undefined || input.Type === "")) validation("Type is required when creating a parameter.");
    const type = String(input?.Type ?? existing?.type);
    if (!["String", "StringList", "SecureString"].includes(type)) validation("Type must be String, StringList, or SecureString.");
    const requestedTier = String(input?.Tier ?? existing?.tier ?? "Standard");
    if (!new Set(["Standard", "Advanced"]).has(requestedTier)) validation("Tier must be Standard or Advanced; Intelligent-Tiering remains unsupported.");
    if (existing?.tier === "Advanced" && requestedTier !== "Advanced") validation("An Advanced parameter cannot be downgraded to Standard.");
    const tier = requestedTier as ParameterState["tier"];
    if (input?.DataType !== undefined && input.DataType !== "text") validation("Only the text data type is supported.");
    if (input?.KeyId !== undefined) validation("Customer-managed and explicit KMS keys are not supported; omit KeyId to use local service-default protection.");
    if (input?.Description !== undefined && (typeof input.Description !== "string" || input.Description.length > 1024)) validation("Description is invalid.");
    const suppliedTags = tags(input?.Tags);
    if (existing?.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${name} is simulator-managed and cannot be changed through the public API.`, 400);
    if (existing?.cloudFormationOwner && existing.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `Parameter ${name} is owned by a CloudFormation stack resource.`, 400);
    if (existing && cloudFormationOwner && existing.cloudFormationOwner !== cloudFormationOwner && !existing.cloudFormationRetained) throw new AwsError("ParameterAlreadyExists", `The parameter already exists and is not owned by this CloudFormation resource.`, 400);
    if (existing && cloudFormationOwner && existing.cloudFormationOwner === cloudFormationOwner) {
      const current = existing.versions[String(existing.currentVersion)];
      const sameValue = current?.storageKind === "PLAIN" && current.value === String(input?.Value ?? "");
      const sameTags = JSON.stringify(existing.tags) === JSON.stringify(suppliedTags);
      const sameDescription = existing.description === (input?.Description || undefined);
      const samePattern = existing.allowedPattern === (input?.AllowedPattern || undefined);
      const sameTier = existing.tier === tier;
      const samePolicies = input?.Policies === undefined || JSON.stringify(this.policyViews(existing).map(policy => JSON.parse(policy.PolicyText))) === JSON.stringify(JSON.parse(String(input.Policies || "[]")));
      if (existing.type === type && sameValue && sameTags && sameDescription && samePattern && sameTier && samePolicies) return { Version: existing.currentVersion, Tier: existing.tier };
    }
    if (existing && input?.Overwrite !== true) throw new AwsError("ParameterAlreadyExists", `The parameter already exists. To overwrite this value, set the overwrite option in the request to true.`, 400);
    if (existing && existing.type !== type) validation("The parameter type cannot be changed during overwrite.");
    if (existing && Object.keys(suppliedTags).length && !cloudFormationOwner) validation("Tags can only be specified when a parameter is created.");
    const allowedPattern = input?.AllowedPattern === undefined ? existing?.allowedPattern : input.AllowedPattern;
    const value = parameterValue(input?.Value, type as ParameterState["type"], allowedPattern, tier === "Advanced" ? 8192 : 4096);
    const now = this.clock.now();
    const tombstoneEntry = this.tombstoneEntry(name);
    const tombstone = tombstoneEntry?.tombstone;
    if (!existing && tombstone && tombstone.reusableAt > now && !(cloudFormationOwner !== undefined && tombstone.cloudFormationOwner === cloudFormationOwner)) throw new AwsError("ParameterAlreadyExists", `Parameter ${name} was recently deleted and cannot yet be recreated.`, 400);
    const nextVersion = (existing?.currentVersion ?? 0) + 1;
    if (existing && Object.keys(existing.versions).length >= MAX_VERSIONS) {
      const oldest = Math.min(...Object.values(existing.versions).map(version => version.version));
      if (Object.values(existing.labels).includes(oldest)) {
        throw new AwsError("ParameterMaxVersionLimitExceeded", `The oldest retained version ${oldest} of ${name} has a label and can't be deleted.`, 400);
      }
    }
    const generationId = existing?.generationId ?? randomUUID();
    const arn = existing?.arn ?? parameterArn(this.region, this.store.accountId, name);
    const retainedPolicies = existing?.policies?.map(policy => ({ Type: policy.type, Version: policy.version, Attributes: policy.attributes })) ?? [];
    const policies = this.policies(input?.Policies === undefined ? JSON.stringify(retainedPolicies) : input.Policies, tier, generationId, nextVersion, now);
    let materialId: string | undefined;
    if (type === "SecureString") {
      const provisional: ParameterState = existing ?? {
        name, arn, generationId, type: "SecureString", dataType: "text", tier, policies,
        currentVersion: 0, versions: {}, labels: {}, tags: suppliedTags, owner: "application", createdAt: now, lastModifiedAt: now, revision: 0,
      };
      const published = await this.materials.publish(this.binding(provisional, { version: nextVersion, createdAt: now, lastModifiedUser: principalArn, storageKind: "ENCRYPTED" }), Buffer.from(value, "utf8"));
      materialId = published.materialId;
    }
    try {
      return await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
        const currentEntry = this.parameterEntry(name);
        const current = currentEntry?.parameter;
        const currentTombstoneEntry = this.tombstoneEntry(name);
        const currentTombstone = currentTombstoneEntry?.tombstone;
        if (current?.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${name} is simulator-managed.`, 400);
        if (currentEntry?.key !== existingEntry?.key || Boolean(current) !== Boolean(existing) || current && current.revision !== existing!.revision) throw new AwsError("TooManyUpdates", "The parameter was changed by another request.", 400);
        if (!current && currentTombstone && currentTombstone.reusableAt > now && !(cloudFormationOwner !== undefined && currentTombstone.cloudFormationOwner === cloudFormationOwner)) throw new AwsError("ParameterAlreadyExists", `Parameter ${name} was recently deleted and cannot yet be recreated.`, 400);
        const versionMetadata = {
          version: nextVersion,
          createdAt: now,
          lastModifiedUser: principalArn,
          ...(input?.Description === undefined ? current?.description ? { description: current.description } : {} : input.Description ? { description: input.Description } : {}),
          ...(allowedPattern ? { allowedPattern } : {}),
        };
        const version: ParameterVersionState = materialId
          ? { ...versionMetadata, storageKind: "ENCRYPTED", materialId }
          : { ...versionMetadata, storageKind: "PLAIN", value };
        const parameter: ParameterState = current ? structuredClone(current) : {
          name, arn, generationId, type: type as ParameterState["type"], dataType: "text", tier, policies,
          currentVersion: 0, versions: {}, labels: {}, tags: suppliedTags, owner: "application", createdAt: now, lastModifiedAt: now, revision: 0,
        };
        if (cloudFormationOwner) {
          parameter.cloudFormationOwner = cloudFormationOwner;
          delete parameter.cloudFormationRetained;
        }
        if (cloudFormationOwner) parameter.tags = suppliedTags;
        parameter.description = input?.Description === undefined ? parameter.description : input.Description || undefined;
        parameter.allowedPattern = allowedPattern || undefined;
        parameter.tier = tier;
        parameter.policies = policies;
        parameter.currentVersion = nextVersion;
        parameter.versions[String(nextVersion)] = version;
        parameter.lastModifiedAt = now;
        parameter.revision++;
        const versions = Object.keys(parameter.versions).map(Number).sort((a, b) => a - b);
        while (versions.length > MAX_VERSIONS) delete parameter.versions[String(versions.shift()!)];
        const before = structuredClone(this.control);
        try {
          const catalogKey = currentEntry?.key ?? name;
          this.control.parameters[catalogKey] = parameter;
          if (currentTombstoneEntry) delete this.control.tombstones[currentTombstoneEntry.key];
          this.enqueueChange(parameter, current ? "Update" : "Create", now);
          this.control.revision++;
          await this.store.save();
          if (materialId) await this.materials.commit(materialId).catch(() => undefined);
        } catch (error) {
          this.store.regionState(this.region).parameterStore = before;
          throw error;
        }
        this.scheduleWorker();
        return { Version: nextVersion, Tier: tier };
      });
    } catch (error) {
      if (materialId) await this.materials.abort(materialId);
      throw error;
    }
  }

  async PutParameterCloudFormation(input: any, cloudFormationOwner: string, principalArn: string): Promise<any> {
    const Tags = input?.Tags && typeof input.Tags === "object" && !Array.isArray(input.Tags)
      ? Object.entries(input.Tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value: String(Value) }))
      : input?.Tags;
    return this.PutParameter({ ...input, Tags, Overwrite: this.parameter(canonicalParameterName(input?.Name, false)) !== undefined }, principalArn, cloudFormationOwner);
  }

  readParameterCloudFormation(name: string): ParameterState | undefined {
    const canonical = canonicalParameterName(name, false);
    const parameter = this.parameter(canonical);
    return parameter ? structuredClone(parameter) : undefined;
  }

  async DeleteParameterCloudFormation(name: string, cloudFormationOwner: string): Promise<void> {
    const canonical = canonicalParameterName(name, false);
    const entry = this.parameterEntry(canonical);
    const parameter = entry?.parameter;
    if (!entry || !parameter) return;
    if (parameter.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `Parameter ${canonical} is not owned by this CloudFormation resource.`, 400);
    await this.deleteOne(entry.key, false, cloudFormationOwner);
  }

  async ReleaseParameterCloudFormation(name: string, cloudFormationOwner: string): Promise<void> {
    const canonical = canonicalParameterName(name, false);
    await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
      const entry = this.parameterEntry(canonical);
      if (!entry) return;
      if (entry.parameter.cloudFormationRetained && !entry.parameter.cloudFormationOwner) return;
      if (entry.parameter.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `Parameter ${canonical} is not owned by this CloudFormation resource.`, 400);
      const before = structuredClone(this.control);
      try {
        delete entry.parameter.cloudFormationOwner;
        entry.parameter.cloudFormationRetained = true;
        entry.parameter.revision++;
        this.control.revision++;
        await this.store.save();
      } catch (error) {
        this.store.regionState(this.region).parameterStore = before;
        throw error;
      }
    });
  }

  async DeleteParameter(input: any): Promise<any> {
    const name = canonicalParameterName(input?.Name, false);
    await this.deleteOne(name, false);
    return {};
  }

  async DeleteParameters(input: any): Promise<any> {
    if (!Array.isArray(input?.Names) || input.Names.length < 1 || input.Names.length > 10) validation("Names must contain between 1 and 10 parameter names.");
    const DeletedParameters: string[] = [];
    const InvalidParameters: string[] = [];
    for (const supplied of input.Names) {
      try {
        const name = canonicalParameterName(supplied, false);
        const entry = this.parameterEntry(name);
        const parameter = entry?.parameter;
        if (parameter?.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${name} is simulator-managed and cannot be deleted.`, 400);
        if (!parameter) InvalidParameters.push(String(supplied));
        else { await this.deleteOne(entry!.key, true); DeletedParameters.push(parameter.name); }
      } catch { InvalidParameters.push(String(supplied)); }
    }
    return { DeletedParameters, InvalidParameters };
  }

  private async deleteOne(name: string, batch: boolean, cloudFormationOwner?: string): Promise<void> {
    await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
      const entry = this.parameterEntry(name);
      const parameter = entry?.parameter;
      if (!parameter) {
        if (batch) return;
        throw new AwsError("ParameterNotFound", `Parameter ${name} not found.`, 400);
      }
      if (parameter.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${name} is simulator-managed and cannot be deleted.`, 400);
      if (parameter.cloudFormationOwner && parameter.cloudFormationOwner !== cloudFormationOwner) throw new AwsError("AccessDeniedException", `Parameter ${name} is owned by a CloudFormation stack resource.`, 400);
      const now = this.clock.now();
      const before = structuredClone(this.control);
      try {
        const catalogKey = entry!.key;
        delete this.control.parameters[catalogKey];
        this.control.tombstones[catalogKey] = { generationId: parameter.generationId, deletedAt: now, reusableAt: now + TOMBSTONE_MS, ...(cloudFormationOwner ? { cloudFormationOwner } : {}) };
        this.enqueueChange(parameter, "Delete", now);
        this.control.revision++;
        await this.store.save();
      } catch (error) {
        this.store.regionState(this.region).parameterStore = before;
        throw error;
      }
    });
    this.scheduleWorker();
  }

  async DescribeParameters(input: any): Promise<any> {
    await this.reconcileBootstrapFromState();
    if (input?.Shared === true) validation("Shared parameters are not supported in the installation-local Parameter Store profile.");
    const filters = input?.ParameterFilters === undefined ? [] : input.ParameterFilters;
    if (!Array.isArray(filters)) validation("ParameterFilters is invalid.");
    let values = Object.values(this.control.parameters).sort((left, right) => left.name.localeCompare(right.name));
    for (const filter of filters) {
      const key = filter?.Key;
      const tagFilter = typeof key === "string" && key.startsWith("tag:") && key.length > 4 && key.length <= 132;
      if (typeof key !== "string" || key.length > 132 || !tagFilter && !DESCRIBE_PARAMETER_FILTER_KEYS.has(key)) invalidFilterKey(key);
      const option = filter.Option === undefined ? key === "Path" ? "Recursive" : "Equals" : filter.Option;
      const supportedOptions = key === "Path"
        ? new Set(["Recursive", "OneLevel"])
        : key === "Name"
          ? new Set(["Equals", "BeginsWith", "Contains"])
          : new Set(["Equals", "BeginsWith"]);
      if (typeof option !== "string" || !supportedOptions.has(option)) invalidFilterOption();
      if (!Array.isArray(filter.Values) || filter.Values.length < 1 || filter.Values.length > 50 || filter.Values.some((value: unknown) => typeof value !== "string" || value.length < 1 || value.length > 1024)) invalidFilterValue();
      const requested = filter.Values as string[];
      if (key === "Path") {
        const paths = requested.map(value => {
          try { return canonicalParameterPath(value); } catch { return invalidFilterValue(); }
        });
        values = values.filter(parameter => {
          const hierarchyName = parameter.name.startsWith("/") ? parameter.name : `/${parameter.name}`;
          return paths.some(path => {
            const prefix = path === "/" ? path : `${path}/`;
            if (!hierarchyName.startsWith(prefix)) return false;
            return option === "Recursive" || !hierarchyName.slice(prefix.length).includes("/");
          });
        });
      } else if (tagFilter) {
        const tagKey = key.slice(4);
        values = values.filter(parameter => Object.hasOwn(parameter.tags, tagKey) && matchesStringFilter(parameter.tags[tagKey], option, requested));
      } else if (key === "KeyId") {
        values = values.filter(parameter => parameter.type === "SecureString" && matchesStringFilter(DEFAULT_SECURE_STRING_KEY_ID, option, requested));
      } else {
        values = values.filter(parameter => {
          const actual = key === "Name" ? parameter.name : key === "Type" ? parameter.type : key === "Tier" ? parameter.tier : parameter.dataType;
          return matchesStringFilter(actual, option, requested);
        });
      }
    }
    const max = positiveInteger(input?.MaxResults, "MaxResults", 1, 50, 50);
    const signature = JSON.stringify(filters);
    let index = 0;
    if (input?.NextToken) {
      try { const cursor = this.tokens.decode<{ index: number; signature: string }>("DescribeParameters", String(input.NextToken)); if (cursor.signature !== signature) throw new Error(); index = cursor.index; }
      catch { throw new AwsError("InvalidNextToken", "The next token is invalid.", 400); }
    }
    const page = values.slice(index, index + max);
    const next = index + page.length;
    return {
      Parameters: page.map(parameter => ({
        Name: parameter.name,
        ARN: parameter.arn,
        Type: parameter.type,
        LastModifiedDate: parameter.lastModifiedAt / 1_000,
        LastModifiedUser: parameter.versions[String(parameter.currentVersion)]?.lastModifiedUser,
        Description: parameter.description,
        AllowedPattern: parameter.allowedPattern,
        Version: parameter.currentVersion,
        Tier: parameter.tier,
        Policies: this.policyViews(parameter),
        DataType: parameter.dataType,
      })),
      ...(next < values.length ? { NextToken: this.tokens.encode("DescribeParameters", { index: next, signature }) } : {}),
    };
  }

  async GetParametersByPath(input: any): Promise<any> {
    await this.reconcileBootstrapFromState();
    const path = canonicalParameterPath(input?.Path);
    const prefix = path === "/" ? path : `${path}/`;
    const recursive = input?.Recursive === true;
    let values = Object.values(this.control.parameters).filter(parameter => {
      const hierarchyName = parameter.name.startsWith("/") ? parameter.name : `/${parameter.name}`;
      if (!hierarchyName.startsWith(prefix)) return false;
      return recursive || !hierarchyName.slice(prefix.length).includes("/");
    }).sort((left, right) => left.name.localeCompare(right.name));
    const filters = input?.ParameterFilters ?? [];
    if (!Array.isArray(filters) || filters.some((filter: any) => !["Type", "KeyId", "Label"].includes(filter?.Key))) validation("Only Type, KeyId, and Label filters are valid for GetParametersByPath.");
    let label: string | undefined;
    for (const filter of filters) {
      if (!Array.isArray(filter.Values) || filter.Values.length < 1) validation("Each parameter filter requires Values.");
      if (filter.Key === "Type") values = values.filter(parameter => (filter.Values ?? []).includes(parameter.type));
      else if (filter.Key === "KeyId") {
        const option = String(filter.Option ?? "Equals");
        if (!new Set(["Equals", "BeginsWith"]).has(option)) validation("KeyId filters support Equals or BeginsWith.");
        const matchesServiceKey = filter.Values.map(String).some((value: string) => option === "BeginsWith" ? DEFAULT_SECURE_STRING_KEY_ID.startsWith(value) : DEFAULT_SECURE_STRING_KEY_ID === value);
        values = matchesServiceKey ? values.filter(parameter => parameter.type === "SecureString") : [];
      }
      else if (filter.Key === "Label") {
        if (filter.Option !== undefined && filter.Option !== "Equals" || filter.Values.length !== 1) validation("Label filters require exactly one value and the Equals option.");
        label = String(filter.Values[0]);
        if (!this.validLabel(label)) validation("The parameter label filter is invalid.");
        values = values.filter(parameter => parameter.labels[label!] !== undefined);
      }
    }
    const max = positiveInteger(input?.MaxResults, "MaxResults", 1, 10, 10);
    const signature = JSON.stringify({ path, recursive, filters });
    let index = 0;
    if (input?.NextToken) {
      try { const cursor = this.tokens.decode<{ index: number; signature: string }>("GetParametersByPath", String(input.NextToken)); if (cursor.signature !== signature) throw new Error(); index = cursor.index; }
      catch { throw new AwsError("InvalidNextToken", "The next token is invalid.", 400); }
    }
    const page = values.slice(index, index + max);
    const next = index + page.length;
    const Parameters = [];
    for (const parameter of page) {
      const selectedVersion = label === undefined ? parameter.currentVersion : parameter.labels[label];
      Parameters.push(await this.view(parameter, parameter.versions[String(selectedVersion)], input?.WithDecryption === true));
    }
    return { Parameters, ...(next < values.length ? { NextToken: this.tokens.encode("GetParametersByPath", { index: next, signature }) } : {}) };
  }

  async GetParameterHistory(input: any): Promise<any> {
    await this.reconcileBootstrapFromState();
    const name = canonicalParameterName(input?.Name, true);
    const parameter = this.parameter(name);
    if (!parameter) throw new AwsError("ParameterNotFound", `Parameter ${name} not found.`, 400);
    const max = positiveInteger(input?.MaxResults, "MaxResults", 1, 50, 50);
    const withDecryption = input?.WithDecryption === true;
    const signature = JSON.stringify({ arn: parameter.arn, generationId: parameter.generationId, revision: parameter.revision });
    let index = 0;
    if (input?.NextToken !== undefined) {
      try {
        const cursor = this.tokens.decode<{ index: number; signature: string }>("GetParameterHistory", String(input.NextToken));
        if (cursor.signature !== signature || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error();
        index = cursor.index;
      } catch { throw new AwsError("InvalidNextToken", "The next token is invalid.", 400); }
    }
    const versions = Object.values(parameter.versions).sort((left, right) => right.version - left.version);
    const page = versions.slice(index, index + max);
    const Parameters = [];
    for (const version of page) {
      const viewed = await this.view(parameter, version, withDecryption);
      Parameters.push({
        Name: parameter.name,
        Type: parameter.type,
        LastModifiedDate: viewed.LastModifiedDate,
        LastModifiedUser: version.lastModifiedUser,
        ...(version.description ?? parameter.description ? { Description: version.description ?? parameter.description } : {}),
        Value: viewed.Value,
        ...(version.allowedPattern ?? parameter.allowedPattern ? { AllowedPattern: version.allowedPattern ?? parameter.allowedPattern } : {}),
        Version: version.version,
        Labels: Object.entries(parameter.labels).filter(([, number]) => number === version.version).map(([label]) => label).sort(),
        Tier: parameter.tier,
        Policies: this.policyViews(parameter),
        DataType: parameter.dataType,
      });
    }
    const next = index + page.length;
    return { Parameters, ...(next < versions.length ? { NextToken: this.tokens.encode("GetParameterHistory", { index: next, signature }) } : {}) };
  }

  async LabelParameterVersion(input: any): Promise<any> {
    const name = canonicalParameterName(input?.Name, false);
    const requested = this.labelList(input?.Labels);
    const valid = requested.filter(this.validLabel);
    const invalid = requested.filter(label => !this.validLabel(label));
    return this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
      const entry = this.parameterEntry(name);
      const parameter = entry?.parameter;
      if (!parameter) throw new AwsError("ParameterNotFound", `Parameter ${name} not found.`, 400);
      if (parameter.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${name} is simulator-managed.`, 400);
      const versionNumber = input?.ParameterVersion === undefined ? parameter.currentVersion : this.parameterVersion(input.ParameterVersion);
      if (!parameter.versions[String(versionNumber)]) throw new AwsError("ParameterVersionNotFound", `Parameter version ${versionNumber} for ${name} was not found.`, 400);
      const labelsAfter = new Set(Object.entries(parameter.labels).filter(([, version]) => version === versionNumber).map(([label]) => label));
      for (const label of valid) labelsAfter.add(label);
      if (labelsAfter.size > 10) throw new AwsError("ParameterVersionLabelLimitExceeded", "A parameter version can have a maximum of ten labels.", 400);
      if (valid.length) await this.commitParameterMutation(entry!.key, current => { for (const label of valid) current.labels[label] = versionNumber; }, "LabelParameterVersion");
      return { InvalidLabels: invalid, ParameterVersion: versionNumber };
    });
  }

  async UnlabelParameterVersion(input: any): Promise<any> {
    const name = canonicalParameterName(input?.Name, false);
    const versionNumber = this.parameterVersion(input?.ParameterVersion);
    const requested = this.labelList(input?.Labels);
    return this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
      const entry = this.parameterEntry(name);
      const parameter = entry?.parameter;
      if (!parameter) throw new AwsError("ParameterNotFound", `Parameter ${name} not found.`, 400);
      if (parameter.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${name} is simulator-managed.`, 400);
      if (!parameter.versions[String(versionNumber)]) throw new AwsError("ParameterVersionNotFound", `Parameter version ${versionNumber} for ${name} was not found.`, 400);
      const RemovedLabels = requested.filter(label => this.validLabel(label) && parameter.labels[label] === versionNumber);
      const InvalidLabels = requested.filter(label => !RemovedLabels.includes(label));
      if (RemovedLabels.length) await this.commitParameterMutation(entry!.key, current => { for (const label of RemovedLabels) delete current.labels[label]; }, "LabelParameterVersion");
      return { RemovedLabels, InvalidLabels };
    });
  }

  private validLabel(label: string): boolean {
    return /^[A-Za-z_.-][A-Za-z0-9_.-]{0,99}$/.test(label) && !/^(?:aws|ssm)/i.test(label);
  }

  private labelList(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10 || value.some(label => typeof label !== "string")) validation("Labels must contain between 1 and 10 strings.");
    if (new Set(value).size !== value.length) validation("Labels must not contain duplicates.");
    return value;
  }

  private parameterVersion(value: unknown): number {
    if (!Number.isInteger(value) || Number(value) < 1) validation("ParameterVersion must be a positive integer.");
    return Number(value);
  }

  private async commitParameterMutation(name: string, mutation: (parameter: ParameterState) => void, eventOperation?: "LabelParameterVersion"): Promise<void> {
    const before = structuredClone(this.control);
    try {
      const parameter = this.control.parameters[name];
      mutation(parameter);
      parameter.lastModifiedAt = this.clock.now();
      parameter.revision++;
      if (eventOperation) this.enqueueChange(parameter, eventOperation, this.clock.now());
      this.control.revision++;
      await this.store.save();
    } catch (error) {
      this.store.regionState(this.region).parameterStore = before;
      throw error;
    }
    this.scheduleWorker();
  }

  async AddTagsToResource(input: any): Promise<any> {
    const parameter = this.tagTarget(input);
    if (parameter.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${parameter.name} is simulator-managed.`, 400);
    const additions = tags(input?.Tags);
    if (new Set([...Object.keys(parameter.tags), ...Object.keys(additions)]).size > 50) validation("A parameter can have at most 50 tags.");
    await this.mutateTags(parameter.name, current => Object.assign(current, additions));
    return {};
  }

  async RemoveTagsFromResource(input: any): Promise<any> {
    const parameter = this.tagTarget(input);
    if (parameter.owner === "stacksim:cdk-bootstrap") throw new AwsError("AccessDeniedException", `Parameter ${parameter.name} is simulator-managed.`, 400);
    if (!Array.isArray(input?.TagKeys) || input.TagKeys.length < 1 || input.TagKeys.some((key: unknown) => typeof key !== "string")) validation("TagKeys is required.");
    await this.mutateTags(parameter.name, current => { for (const key of input.TagKeys) delete current[key]; });
    return {};
  }

  async ListTagsForResource(input: any): Promise<any> {
    const parameter = this.tagTarget(input);
    return { TagList: Object.entries(parameter.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })) };
  }

  private tagTarget(input: any): ParameterState {
    if (input?.ResourceType !== "Parameter") validation("Only ResourceType Parameter is supported.");
    const name = canonicalParameterName(input?.ResourceId, true);
    const parameter = this.parameter(name);
    if (!parameter) throw new AwsError("InvalidResourceId", `Parameter ${name} does not exist.`, 400);
    return parameter;
  }

  private async mutateTags(name: string, mutation: (tags: Record<string, string>) => void): Promise<void> {
    await this.store.withMutationLock(`ssm:${this.store.accountId}:${this.region}`, async () => {
      const parameter = this.control.parameters[name];
      if (!parameter) throw new AwsError("InvalidResourceId", `Parameter ${name} does not exist.`, 400);
      const before = structuredClone(this.control);
      try {
        mutation(parameter.tags);
        parameter.revision++;
        this.control.revision++;
        await this.store.save();
      } catch (error) {
        this.store.regionState(this.region).parameterStore = before;
        throw error;
      }
    });
  }

  reconcileBootstrapRecord(bootstrap: CloudFormationBootstrapState): boolean {
    const name = canonicalParameterName(bootstrap.versionParameterName, false);
    const existing = this.parameter(name);
    const value = String(bootstrap.compatibilityVersion);
    if (existing) {
      if (existing.owner !== "stacksim:cdk-bootstrap") throw new AwsError("InvalidBootstrapState", `CDK bootstrap parameter ${name} already exists and is not owned by StackSim. Reset the local environment or remove the collision.`, 409);
      const current = existing.versions[String(existing.currentVersion)];
      if (existing.type !== "String" || current?.storageKind !== "PLAIN") throw new AwsError("InvalidBootstrapState", `CDK bootstrap parameter ${name} is corrupt.`, 409);
      if (current.value === value && existing.lastModifiedAt === bootstrap.updatedAt) return false;
      const version = existing.currentVersion + 1;
      existing.currentVersion = version;
      existing.versions[String(version)] = { version, createdAt: bootstrap.updatedAt, lastModifiedUser: "stacksim:cdk-bootstrap", storageKind: "PLAIN", value };
      existing.lastModifiedAt = bootstrap.updatedAt;
      existing.revision++;
      this.control.revision++;
      return true;
    }
    const generationId = randomUUID();
    this.control.parameters[name] = {
      name,
      arn: parameterArn(this.region, this.store.accountId, name),
      generationId,
      type: "String",
      dataType: "text",
      tier: "Standard",
      policies: [],
      currentVersion: 1,
      versions: { "1": { version: 1, createdAt: bootstrap.updatedAt, lastModifiedUser: "stacksim:cdk-bootstrap", storageKind: "PLAIN", value } },
      labels: {},
      tags: {},
      owner: "stacksim:cdk-bootstrap",
      createdAt: bootstrap.updatedAt,
      lastModifiedAt: bootstrap.updatedAt,
      revision: 1,
    };
    this.control.revision++;
    return true;
  }

  validateBootstrapRecord(bootstrap: CloudFormationBootstrapState): void {
    const name = canonicalParameterName(bootstrap.versionParameterName, false);
    const existing = this.parameter(name);
    if (existing && existing.owner !== "stacksim:cdk-bootstrap") {
      throw new AwsError("InvalidBootstrapState", `CDK bootstrap parameter ${name} already exists and is not owned by StackSim. Reset the local environment or remove the collision.`, 409);
    }
    if (existing) {
      const current = existing.versions[String(existing.currentVersion)];
      if (existing.type !== "String" || current?.storageKind !== "PLAIN") throw new AwsError("InvalidBootstrapState", `CDK bootstrap parameter ${name} is corrupt.`, 409);
    }
  }

  resolveBootstrapPlain(name: string): string | undefined {
    const parameter = this.parameter(name);
    if (!parameter || parameter.owner !== "stacksim:cdk-bootstrap" || parameter.type !== "String") return undefined;
    const version = parameter.versions[String(parameter.currentVersion)];
    return version?.storageKind === "PLAIN" ? version.value : undefined;
  }

  resolveCloudFormationPlain(name: string): string | undefined {
    return this.resolveCloudFormationParameter(name)?.value;
  }

  resolveCloudFormationParameter(name: string): { value: string; generationId: string; version: number } | undefined {
    const canonical = canonicalParameterName(name, false);
    const parameter = this.parameter(canonical);
    if (!parameter || parameter.type !== "String") return undefined;
    const version = parameter.versions[String(parameter.currentVersion)];
    return version?.storageKind === "PLAIN" ? { value: version.value ?? "", generationId: parameter.generationId, version: version.version } : undefined;
  }

  async getParameterForService(name: string, withDecryption: boolean): Promise<any> {
    const selected = this.selector(name);
    const found = this.resolve(selected);
    if (!found.parameter) throw new AwsError("ParameterNotFound", `Parameter ${selected.name} not found.`, 400);
    if (!found.version) {
      if (selected.version) throw new AwsError("ParameterVersionNotFound", `Parameter version ${selected.version} for ${selected.name} was not found.`, 400);
      throw new AwsError("ParameterNotFound", `Parameter ${selected.name} not found.`, 400);
    }
    return { Parameter: await this.view(found.parameter, found.version, withDecryption, selected.selector), generationId: found.parameter.generationId, version: found.version.version };
  }

  async reconcileBootstrapFromState(): Promise<void> {
    const bootstrap = this.store.regionState(this.region).cloudformation.bootstrap;
    if (!bootstrap) return;
    const before = structuredClone(this.control);
    if (!this.reconcileBootstrapRecord(bootstrap)) return;
    try { await this.store.save(); }
    catch (error) {
      this.store.regionState(this.region).parameterStore = before;
      throw error;
    }
  }

  localMetadata(): Array<{ name: string; arn: string; owner: ParameterState["owner"]; cloudFormationOwner?: string; policies: Array<{ type: string; dueAt: number; status: string }> }> {
    return Object.values(this.control.parameters)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(parameter => ({ name: parameter.name, arn: parameter.arn, owner: parameter.owner, cloudFormationOwner: parameter.cloudFormationOwner, policies: parameter.policies.map(policy => ({ type: policy.type, dueAt: policy.dueAt, status: this.completions()[policy.occurrenceId] ? "FINISHED" : "PENDING" })) }));
  }
}
