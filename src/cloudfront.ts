import { createServer as createSecureServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { readBody } from "./util.js";
import type { Clock } from "./core/clock.js";
import type { StateStore } from "./state.js";
import type { CloudFrontDistributionState, CloudFrontFunctionState, CloudFrontInvalidationState, CloudFrontOriginAccessControlState, CloudFrontResourceOwnerState, CloudFrontResponseHeadersPolicyState } from "./types.js";
import type { CloudFrontS3OriginPort } from "./s3/cloudfront-origin-port.js";
import { CloudFrontCache } from "./cloudfront/cache.js";
import { CloudFrontFunctionRunner } from "./cloudfront/function-runner.js";
import type { CloudFrontFunctionEvent, CloudFrontFunctionRequest } from "./cloudfront/function-event.js";
import { applySecurityHeaders, validateOpeningSecurityHeaders } from "./cloudfront/response-headers.js";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID, canonical, cloudFrontArn, domainName, etag, items, MANAGED_CACHE_POLICIES, nameValid, opaqueId, same, tagItems, tags } from "./cloudfront/model.js";
import { CloudFrontError, parseCloudFrontXml, sendCloudFrontError, sendCloudFrontXml } from "./cloudfront/protocol.js";
import { AwsError } from "./errors.js";
import { createLoopbackHostCertificate } from "./core/x509.js";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const MAX_ORIGIN_BYTES = 10 * 1024 * 1024;

type RecordValue = Record<string, any>;
type OriginResolver = (input: { accountId: string; region: string; bucketName: string }) => CloudFrontS3OriginPort;

export interface CloudFrontInternalOwner { stackId: string; logicalId: string; resourceOperationId: string }
export interface CloudFrontTlsConfiguration { certificate: string; privateKey: string; caPrivateKey: string; caCertificatePath: string }

function record(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new CloudFrontError("InvalidArgument", `${name} is required`); return value; }
function ifMatch(value: string | undefined, current: string): void { if (!value) throw new CloudFrontError("InvalidIfMatchVersion", "The If-Match header is required", 400); if (value !== current) throw new CloudFrontError("PreconditionFailed", "The precondition in one or more request-header fields evaluated to false", 412); }
function apiDate(value: number): string { return new Date(value).toISOString(); }
function owner(value?: CloudFrontInternalOwner): CloudFrontResourceOwnerState | undefined { return value ? { stackId: value.stackId, logicalId: value.logicalId, createOperationId: value.resourceOperationId } : undefined; }
function ownerEquals(left: CloudFrontResourceOwnerState | undefined, right: CloudFrontInternalOwner | undefined): boolean { return Boolean(left && right && left.stackId === right.stackId && left.logicalId === right.logicalId && left.createOperationId === right.resourceOperationId); }
function quantity<T>(values: T[], member: string): RecordValue { return { Quantity: values.length, ...(values.length ? { Items: { [member]: values } } : {}) }; }

function originConfig(config: RecordValue): RecordValue[] { return Array.isArray(config.Origins) ? config.Origins : items(config.Origins, "Origin"); }
function cacheBehaviors(config: RecordValue): RecordValue[] { return Array.isArray(config.CacheBehaviors) ? config.CacheBehaviors : items(config.CacheBehaviors, "CacheBehavior"); }
function functionAssociations(behavior: RecordValue): RecordValue[] { return Array.isArray(behavior.FunctionAssociations) ? behavior.FunctionAssociations : items(behavior.FunctionAssociations, "FunctionAssociation"); }
function allowedMethods(behavior: RecordValue): string[] {
  if (Array.isArray(behavior.AllowedMethods)) return behavior.AllowedMethods.map(String);
  const values = items(behavior.AllowedMethods, "Method");
  return values.map(value => typeof value === "string" ? value : String(value));
}

function normalizeDistributionConfig(input: RecordValue): RecordValue {
  const config = canonical(input);
  config.Enabled = config.Enabled === true;
  config.IsIPV6Enabled = config.IsIPV6Enabled ?? config.IPV6Enabled;
  return config;
}

function pathMatches(pattern: string, uri: string): boolean {
  const value = uri.replace(/^\//, "");
  const escaped = pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function bucketFromDomain(value: string): { bucketName: string; region: string } | undefined {
  const regional = value.match(/^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3[.-]([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com$/i);
  return regional ? { bucketName: regional[1], region: regional[2] } : undefined;
}

function oacView(value: CloudFrontOriginAccessControlState): RecordValue {
  return { Id: value.id, OriginAccessControlConfig: { Name: value.name, Description: value.description, SigningProtocol: value.signingProtocol, SigningBehavior: value.signingBehavior, OriginAccessControlOriginType: value.originType } };
}
function responsePolicyConfig(value: CloudFrontResponseHeadersPolicyState): RecordValue { return { Name: value.name, Comment: value.comment, SecurityHeadersConfig: canonical(value.securityHeadersConfig) }; }
function responsePolicyView(value: CloudFrontResponseHeadersPolicyState): RecordValue { return { Id: value.id, LastModifiedTime: apiDate(value.lastModifiedAt), ResponseHeadersPolicyConfig: responsePolicyConfig(value) }; }
function functionSummary(value: CloudFrontFunctionState, stage: "DEVELOPMENT" | "LIVE" = "DEVELOPMENT"): RecordValue {
  const revision = stage === "LIVE" ? value.live : value.development;
  if (!revision) throw new CloudFrontError("NoSuchFunctionExists", `Function ${value.name} has no ${stage} stage`, 404);
  return { Name: value.name, Status: "UNPUBLISHED", FunctionConfig: { Comment: revision.comment, Runtime: revision.runtime }, FunctionMetadata: { FunctionARN: value.arn, Stage: stage, CreatedTime: apiDate(revision.createdAt), LastModifiedTime: apiDate(revision.lastModifiedAt) } };
}
function distributionView(value: CloudFrontDistributionState): RecordValue {
  return { Id: value.id, ARN: value.arn, Status: value.status, LastModifiedTime: apiDate(value.lastModifiedAt), InProgressInvalidationBatches: 0, DomainName: value.domainName, ActiveTrustedSigners: { Enabled: false, Quantity: 0 }, ActiveTrustedKeyGroups: { Enabled: false, Quantity: 0 }, DistributionConfig: canonical(value.config) };
}
function invalidationView(value: CloudFrontInvalidationState): RecordValue { return { Id: value.id, Status: value.status, CreateTime: apiDate(value.createTime), InvalidationBatch: { Paths: quantity(value.paths, "Path"), CallerReference: value.callerReference } }; }

export class CloudFrontService {
  readonly cache: CloudFrontCache;
  readonly functions: CloudFrontFunctionRunner;
  private tls?: CloudFrontTlsConfiguration;
  private readonly viewers = new Map<string, HttpsServer>();
  private readonly reservedViewerPorts = new Set<number>();
  private portReservationTail: Promise<void> = Promise.resolve();
  private acceptingViewers = true;

  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly resolveOrigin: OriginResolver, private readonly portRange = { start: 47000, end: 47999 }) {
    this.cache = new CloudFrontCache(1_000, 128 * 1024 * 1024, () => this.clock.now());
    this.functions = new CloudFrontFunctionRunner();
  }

  private state(accountId = this.store.accountId) { return this.store.ensureAccount(accountId).cloudfront; }
  private nextRevision(state = this.state()): number { state.revision += 1; return state.revision; }

  configureTls(value: CloudFrontTlsConfiguration): void { this.tls = value; }
  get caCertificatePath(): string | undefined { return this.tls?.caCertificatePath; }

  async start(): Promise<void> {
    this.acceptingViewers = true;
    await this.reconcilePersistentState();
    if (!this.tls) return;
    for (const distribution of Object.values(this.state().distributions)) if (!this.viewers.has(distribution.id)) await this.bindViewer(distribution).catch(() => undefined);
  }

  private async reconcilePersistentState(): Promise<void> {
    await this.store.withAccountMutation(this.store.accountId, async () => {
      const state = this.state();
      const distributionRefs: Record<string, string> = {};
      const oacNames: Record<string, string> = {};
      const policyNames: Record<string, string> = {};
      const ports = new Set<number>();
      let changed = false;
      for (const [id, distribution] of Object.entries(state.distributions)) {
        if (distribution.id !== id || distributionRefs[distribution.callerReference] || ports.has(distribution.localViewerPort)) throw new Error("CloudFront distribution state contains a duplicate or corrupt identity index");
        distributionRefs[distribution.callerReference] = id; ports.add(distribution.localViewerPort);
      }
      for (const [id, accessControl] of Object.entries(state.originAccessControls)) {
        if (accessControl.id !== id || oacNames[accessControl.name]) throw new Error("CloudFront origin-access-control state contains a duplicate or corrupt name index");
        oacNames[accessControl.name] = id;
      }
      for (const [id, policy] of Object.entries(state.responseHeadersPolicies)) {
        if (policy.id !== id || policyNames[policy.name]) throw new Error("CloudFront response-policy state contains a duplicate or corrupt name index");
        policyNames[policy.name] = id;
      }
      const sameIndex = (left: Record<string, string>, right: Record<string, string>) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
      if (!sameIndex(state.distributionCallerReferences, distributionRefs)) { state.distributionCallerReferences = distributionRefs; changed = true; }
      if (!sameIndex(state.originAccessControlNames, oacNames)) { state.originAccessControlNames = oacNames; changed = true; }
      if (!sameIndex(state.responseHeadersPolicyNames, policyNames)) { state.responseHeadersPolicyNames = policyNames; changed = true; }
      for (const [distributionId, distribution] of Object.entries(state.distributions)) {
        const references: Record<string, string> = {};
        for (const [id, invalidation] of Object.entries(state.invalidations[distributionId] ?? {})) {
          if (invalidation.id !== id || invalidation.distributionId !== distributionId || references[invalidation.callerReference]) throw new Error("CloudFront invalidation state contains a duplicate or corrupt caller-reference index");
          references[invalidation.callerReference] = id;
          if (invalidation.status === "InProgress") { this.cache.invalidate(distributionId, invalidation.paths); invalidation.status = "Completed"; changed = true; }
        }
        if (!sameIndex(state.invalidationCallerReferences[distributionId] ?? {}, references)) { state.invalidationCallerReferences[distributionId] = references; changed = true; }
        if (!state.invalidations[distributionId]) { state.invalidations[distributionId] = {}; changed = true; }
        void distribution;
      }
      if (changed) { this.nextRevision(state); await this.store.save(); }
    });
  }

  beginShutdown(): void { this.acceptingViewers = false; }
  async stop(): Promise<void> {
    const close = (server: HttpsServer) => server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    await Promise.all([...this.viewers.values()].map(close)); this.viewers.clear();
  }

  localViewer(distributionId: string): RecordValue | undefined {
    const distribution = this.state().distributions[distributionId];
    if (!distribution) return undefined;
    const host = distribution.domainName.replace(/\.cloudfront\.net$/, ".localhost");
    return { distributionId, canonicalDomainName: distribution.domainName, localUrl: `https://${host}:${distribution.localViewerPort}/`, port: distribution.localViewerPort, caCertificatePath: this.tls?.caCertificatePath, available: this.viewers.get(distributionId)?.listening === true, cache: this.cache.diagnostics(distributionId) };
  }

  listLocalViewers(): RecordValue[] { return Object.keys(this.state().distributions).sort().flatMap(id => this.localViewer(id) ?? []); }

  consoleSnapshot(): RecordValue {
    const state = this.state();
    return {
      distributions: Object.values(state.distributions).sort((a, b) => a.id.localeCompare(b.id)).map(value => ({ id: value.id, arn: value.arn, domainName: value.domainName, etag: value.etag, status: value.status, configRevision: value.configRevision, deployedRevision: value.deployedRevision, config: canonical(value.config), tags: canonical(value.tags), createdAt: value.createdAt, lastModifiedAt: value.lastModifiedAt })),
      functions: Object.values(state.functions).sort((a, b) => a.name.localeCompare(b.name)).map(value => ({ name: value.name, arn: value.arn, development: { runtime: value.development.runtime, comment: value.development.comment, version: value.development.version, lastModifiedAt: value.development.lastModifiedAt }, ...(value.live ? { live: { runtime: value.live.runtime, comment: value.live.comment, version: value.live.version, lastModifiedAt: value.live.lastModifiedAt } } : {}), tags: canonical(value.tags) })),
      originAccessControls: Object.values(state.originAccessControls).sort((a, b) => a.id.localeCompare(b.id)).map(value => ({ id: value.id, arn: value.arn, name: value.name, description: value.description, originType: value.originType, signingBehavior: value.signingBehavior, signingProtocol: value.signingProtocol, lastModifiedAt: value.lastModifiedAt })),
      responseHeadersPolicies: Object.values(state.responseHeadersPolicies).sort((a, b) => a.id.localeCompare(b.id)).map(value => ({ id: value.id, arn: value.arn, name: value.name, comment: value.comment, securityHeadersConfig: canonical(value.securityHeadersConfig), lastModifiedAt: value.lastModifiedAt })),
      localViewers: this.listLocalViewers(),
    };
  }

  consoleDistribution(id: string): RecordValue | undefined {
    const distribution = this.state().distributions[id];
    if (!distribution) return undefined;
    return {
      distribution: { id: distribution.id, arn: distribution.arn, domainName: distribution.domainName, etag: distribution.etag, status: distribution.status, configRevision: distribution.configRevision, deployedRevision: distribution.deployedRevision, config: canonical(distribution.config), tags: canonical(distribution.tags), createdAt: distribution.createdAt, lastModifiedAt: distribution.lastModifiedAt },
      invalidations: Object.values(this.state().invalidations[id] ?? {}).sort((a, b) => b.createTime - a.createTime).map(value => canonical(value)),
      localViewer: this.localViewer(id),
    };
  }

  private async bindViewer(distribution: CloudFrontDistributionState): Promise<void> {
    if (!this.tls || this.viewers.has(distribution.id)) return;
    const host = distribution.domainName.replace(/\.cloudfront\.net$/, ".localhost");
    const leaf = createLoopbackHostCertificate(host, this.tls.caPrivateKey, Date.now());
    const server = createSecureServer({ cert: leaf.certificate, key: leaf.privateKey }, (req, res) => { void this.handleViewer(distribution.id, req, res, true); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(distribution.localViewerPort, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    this.viewers.set(distribution.id, server);
  }

  private async reserveViewerPort(): Promise<number> {
    let release!: () => void;
    const previous = this.portReservationTail;
    this.portReservationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const used = new Set([...Object.values(this.state().distributions).map(value => value.localViewerPort), ...this.reservedViewerPorts]);
      for (let port = this.portRange.start; port <= this.portRange.end; port += 1) {
        if (used.has(port)) continue;
        if (!this.tls) { this.reservedViewerPorts.add(port); return port; }
        const probe = createSecureServer({ cert: this.tls.certificate, key: this.tls.privateKey });
        try { await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", () => { probe.off("error", reject); resolve(); }); }); this.reservedViewerPorts.add(port); return port; }
        catch { continue; }
        finally { if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve())); }
      }
      throw new CloudFrontError("TooManyDistributions", "No local CloudFront viewer ports are available", 400);
    } finally { release(); }
  }

  async createOriginAccessControl(config: RecordValue, cfnOwner?: CloudFrontInternalOwner): Promise<CloudFrontOriginAccessControlState> {
    const name = requiredString(config.Name, "Name");
    if (!nameValid(name)) throw new CloudFrontError("InvalidArgument", "Origin access control name is invalid");
    if (config.OriginAccessControlOriginType !== "s3" || config.SigningBehavior !== "always" || config.SigningProtocol !== "sigv4") throw new CloudFrontError("InvalidOriginAccessControl", "CFR-01 supports only s3/always/sigv4");
    return this.store.withAccountMutation(this.store.accountId, async () => {
      const state = this.state(); const existingId = state.originAccessControlNames[name];
      if (existingId) { const existing = state.originAccessControls[existingId]; if (ownerEquals(existing.cloudFormationOwner, cfnOwner)) return existing; throw new CloudFrontError("OriginAccessControlAlreadyExists", "An origin access control with this name already exists", 409); }
      const id = opaqueId("E", 8); const now = this.clock.now(); const revision = this.nextRevision(state);
      const created: CloudFrontOriginAccessControlState = { id, arn: cloudFrontArn(this.store.accountId, "origin-access-control", id), etag: etag(config, revision), name, description: String(config.Description ?? ""), originType: "s3", signingBehavior: "always", signingProtocol: "sigv4", createdAt: now, lastModifiedAt: now, ...(cfnOwner ? { cloudFormationOwner: owner(cfnOwner) } : {}) };
      state.originAccessControls[id] = created; state.originAccessControlNames[name] = id; await this.store.save(); return canonical(created);
    });
  }

  getOriginAccessControl(id: string): CloudFrontOriginAccessControlState { const value = this.state().originAccessControls[id]; if (!value) throw new CloudFrontError("NoSuchOriginAccessControl", "The origin access control does not exist", 404); return canonical(value); }
  async updateOriginAccessControl(id: string, config: RecordValue, suppliedEtag?: string): Promise<CloudFrontOriginAccessControlState> {
    return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.originAccessControls[id]; if (!current) throw new CloudFrontError("NoSuchOriginAccessControl", "The origin access control does not exist", 404); ifMatch(suppliedEtag, current.etag); if (config.OriginAccessControlOriginType !== "s3" || config.SigningBehavior !== "always" || config.SigningProtocol !== "sigv4") throw new CloudFrontError("InvalidOriginAccessControl", "CFR-01 supports only s3/always/sigv4"); const name = requiredString(config.Name, "Name"); const collision = state.originAccessControlNames[name]; if (collision && collision !== id) throw new CloudFrontError("OriginAccessControlAlreadyExists", "An origin access control with this name already exists", 409); const next = { ...current, name, description: String(config.Description ?? ""), lastModifiedAt: this.clock.now() }; if (same(oacView(current).OriginAccessControlConfig, oacView(next).OriginAccessControlConfig)) return canonical(current); delete state.originAccessControlNames[current.name]; state.originAccessControlNames[name] = id; next.etag = etag(config, this.nextRevision(state)); state.originAccessControls[id] = next; await this.store.save(); return canonical(next); });
  }
  async deleteOriginAccessControl(id: string, suppliedEtag?: string): Promise<void> { await this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.originAccessControls[id]; if (!current) throw new CloudFrontError("NoSuchOriginAccessControl", "The origin access control does not exist", 404); ifMatch(suppliedEtag, current.etag); if (Object.values(state.distributions).some(distribution => originConfig(distribution.config).some(origin => origin.OriginAccessControlId === id))) throw new CloudFrontError("OriginAccessControlInUse", "The origin access control is in use", 409); delete state.originAccessControls[id]; delete state.originAccessControlNames[current.name]; this.nextRevision(state); await this.store.save(); }); }

  async createResponseHeadersPolicy(config: RecordValue, cfnOwner?: CloudFrontInternalOwner): Promise<CloudFrontResponseHeadersPolicyState> {
    const name = requiredString(config.Name, "Name"); const validation = validateOpeningSecurityHeaders(config.SecurityHeadersConfig); if (validation) throw new CloudFrontError("InvalidArgument", validation); if (!nameValid(name, 128)) throw new CloudFrontError("InvalidArgument", "Response headers policy name is invalid");
    return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const existingId = state.responseHeadersPolicyNames[name]; if (existingId) { const existing = state.responseHeadersPolicies[existingId]; if (ownerEquals(existing.cloudFormationOwner, cfnOwner)) return existing; throw new CloudFrontError("ResponseHeadersPolicyAlreadyExists", "A response headers policy with this name already exists", 409); } const id = opaqueId("E", 8); const now = this.clock.now(); const revision = this.nextRevision(state); const created: CloudFrontResponseHeadersPolicyState = { id, arn: cloudFrontArn(this.store.accountId, "response-headers-policy", id), etag: etag(config, revision), name, comment: String(config.Comment ?? ""), securityHeadersConfig: canonical(config.SecurityHeadersConfig), createdAt: now, lastModifiedAt: now, ...(cfnOwner ? { cloudFormationOwner: owner(cfnOwner) } : {}) }; state.responseHeadersPolicies[id] = created; state.responseHeadersPolicyNames[name] = id; await this.store.save(); return canonical(created); });
  }
  getResponseHeadersPolicy(id: string): CloudFrontResponseHeadersPolicyState { const value = this.state().responseHeadersPolicies[id]; if (!value) throw new CloudFrontError("NoSuchResponseHeadersPolicy", "The response headers policy does not exist", 404); return canonical(value); }
  async updateResponseHeadersPolicy(id: string, config: RecordValue, suppliedEtag?: string): Promise<CloudFrontResponseHeadersPolicyState> { const validation = validateOpeningSecurityHeaders(config.SecurityHeadersConfig); if (validation) throw new CloudFrontError("InvalidArgument", validation); return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.responseHeadersPolicies[id]; if (!current) throw new CloudFrontError("NoSuchResponseHeadersPolicy", "The response headers policy does not exist", 404); ifMatch(suppliedEtag, current.etag); const name = requiredString(config.Name, "Name"); const collision = state.responseHeadersPolicyNames[name]; if (collision && collision !== id) throw new CloudFrontError("ResponseHeadersPolicyAlreadyExists", "A response headers policy with this name already exists", 409); const next = { ...current, name, comment: String(config.Comment ?? ""), securityHeadersConfig: canonical(config.SecurityHeadersConfig), lastModifiedAt: this.clock.now() }; if (same(responsePolicyConfig(current), responsePolicyConfig(next))) return canonical(current); delete state.responseHeadersPolicyNames[current.name]; state.responseHeadersPolicyNames[name] = id; next.etag = etag(config, this.nextRevision(state)); state.responseHeadersPolicies[id] = next; await this.store.save(); return canonical(next); }); }
  async deleteResponseHeadersPolicy(id: string, suppliedEtag?: string): Promise<void> { await this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.responseHeadersPolicies[id]; if (!current) throw new CloudFrontError("NoSuchResponseHeadersPolicy", "The response headers policy does not exist", 404); ifMatch(suppliedEtag, current.etag); if (Object.values(state.distributions).some(distribution => [distribution.config.DefaultCacheBehavior as RecordValue, ...cacheBehaviors(distribution.config)].some(behavior => behavior?.ResponseHeadersPolicyId === id))) throw new CloudFrontError("ResponseHeadersPolicyInUse", "The response headers policy is in use", 409); delete state.responseHeadersPolicies[id]; delete state.responseHeadersPolicyNames[current.name]; this.nextRevision(state); await this.store.save(); }); }

  private validateFunctionConfig(name: string, config: RecordValue, code: string): void { if (!nameValid(name, 64)) throw new CloudFrontError("InvalidArgument", "Function name is invalid"); if (config.Runtime !== "cloudfront-js-1.0") throw new CloudFrontError("InvalidArgument", "CFR-01 supports only cloudfront-js-1.0"); if (Buffer.byteLength(code) > 10 * 1024) throw new CloudFrontError("FunctionSizeLimitExceeded", "Function code exceeds 10 KiB"); if (/\b(?:require|process|fetch|WebAssembly|Worker|eval|Function|AsyncFunction|let|const|class|async|await)\b|\bimport\s*\(|\bimport\s+/.test(code)) throw new CloudFrontError("InvalidArgument", "Function code uses a feature outside CloudFront JavaScript runtime 1.0"); }
  async createFunction(name: string, config: RecordValue, code: string, requestedTags: Record<string, string> = {}, cfnOwner?: CloudFrontInternalOwner): Promise<CloudFrontFunctionState> { this.validateFunctionConfig(name, config, code); return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const existing = state.functions[name]; if (existing) { if (ownerEquals(existing.cloudFormationOwner, cfnOwner)) return existing; throw new CloudFrontError("FunctionAlreadyExists", "The function already exists", 409); } const now = this.clock.now(); const revisionNumber = this.nextRevision(state); const revision = { etag: etag({ name, config, code }, revisionNumber), code, runtime: "cloudfront-js-1.0" as const, comment: String(config.Comment ?? ""), createdAt: now, lastModifiedAt: now, version: 1 }; const created: CloudFrontFunctionState = { name, arn: cloudFrontArn(this.store.accountId, "function", name), development: revision, tags: canonical(requestedTags), ...(cfnOwner ? { cloudFormationOwner: owner(cfnOwner) } : {}) }; state.functions[name] = created; await this.store.save(); return canonical(created); }); }
  getFunction(name: string): CloudFrontFunctionState { const value = this.state().functions[name]; if (!value) throw new CloudFrontError("NoSuchFunctionExists", "The function does not exist", 404); return canonical(value); }
  async updateFunction(name: string, config: RecordValue, code: string, suppliedEtag?: string): Promise<CloudFrontFunctionState> { this.validateFunctionConfig(name, config, code); return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.functions[name]; if (!current) throw new CloudFrontError("NoSuchFunctionExists", "The function does not exist", 404); ifMatch(suppliedEtag, current.development.etag); const desired = { code, runtime: "cloudfront-js-1.0" as const, comment: String(config.Comment ?? "") }; if (current.development.code === code && current.development.runtime === desired.runtime && current.development.comment === desired.comment) return canonical(current); const now = this.clock.now(); const revisionNumber = this.nextRevision(state); current.development = { ...desired, etag: etag(desired, revisionNumber), createdAt: current.development.createdAt, lastModifiedAt: now, version: current.development.version + 1 }; await this.store.save(); return canonical(current); }); }
  async publishFunction(name: string, suppliedEtag?: string): Promise<CloudFrontFunctionState> { return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.functions[name]; if (!current) throw new CloudFrontError("NoSuchFunctionExists", "The function does not exist", 404); ifMatch(suppliedEtag, current.development.etag); if (current.live?.etag === current.development.etag) return canonical(current); current.live = { ...canonical(current.development), version: (current.live?.version ?? 0) + 1, lastModifiedAt: this.clock.now() }; this.nextRevision(state); await this.store.save(); return canonical(current); }); }
  async deleteFunction(name: string, suppliedEtag?: string): Promise<void> { await this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.functions[name]; if (!current) throw new CloudFrontError("NoSuchFunctionExists", "The function does not exist", 404); ifMatch(suppliedEtag, current.development.etag); if (Object.values(state.distributions).some(distribution => [distribution.config.DefaultCacheBehavior, ...cacheBehaviors(distribution.config)].some(behavior => functionAssociations(behavior ?? {}).some(association => association.FunctionARN === current.arn)))) throw new CloudFrontError("FunctionInUse", "The function is associated with a distribution", 409); delete state.functions[name]; this.nextRevision(state); await this.store.save(); }); }
  async testFunction(name: string, stage: "DEVELOPMENT" | "LIVE", event: CloudFrontFunctionEvent): Promise<RecordValue> { const fn = this.getFunction(name); const revision = stage === "LIVE" ? fn.live : fn.development; if (!revision) throw new CloudFrontError("NoSuchFunctionExists", `Function ${name} has no ${stage} stage`, 404); const result = await this.functions.invoke(revision.code, event); return { FunctionSummary: functionSummary(fn, stage), ComputeUtilization: "1", FunctionExecutionLogs: [], FunctionErrorMessage: "", FunctionOutput: JSON.stringify(result) }; }

  private validateDistributionConfig(config: RecordValue, id?: string): void {
    const origins = originConfig(config); if (origins.length !== 1) throw new CloudFrontError("InvalidArgument", "CFR-01 requires exactly one S3 origin");
    const origin = origins[0]; const domain = bucketFromDomain(String(origin.DomainName ?? "")); if (!domain) throw new CloudFrontError("InvalidArgument", "The origin must be a simulator-owned regional S3 domain");
    const oac = this.state().originAccessControls[String(origin.OriginAccessControlId ?? "")]; if (!oac) throw new CloudFrontError("NoSuchOriginAccessControl", "The origin access control does not exist", 404);
    if (!record(origin.S3OriginConfig) || origin.S3OriginConfig.OriginAccessIdentity !== "") throw new CloudFrontError("IllegalOriginAccessConfiguration", "OAC requires an empty legacy OriginAccessIdentity");
    if (config.HttpVersion !== undefined && config.HttpVersion !== "http2and3") throw new CloudFrontError("InvalidArgument", "CFR-01 accepts only HttpVersion http2and3");
    if (config.IsIPV6Enabled !== undefined && config.IsIPV6Enabled !== true || config.IPV6Enabled !== undefined && config.IPV6Enabled !== true) throw new CloudFrontError("InvalidArgument", "CFR-01 accepts only IPv6 enabled");
    for (const behavior of [config.DefaultCacheBehavior, ...cacheBehaviors(config)]) {
      if (!record(behavior)) throw new CloudFrontError("InvalidArgument", "Cache behavior is invalid");
      if (![CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID].includes(String(behavior.CachePolicyId))) throw new CloudFrontError("NoSuchCachePolicy", "Only the two CFR-01 AWS-managed cache policies are supported", 404);
      if (behavior.ViewerProtocolPolicy !== "redirect-to-https" || behavior.Compress !== true) throw new CloudFrontError("InvalidArgument", "CFR-01 behaviors require redirect-to-https and Compress=true");
      const policy = this.state().responseHeadersPolicies[String(behavior.ResponseHeadersPolicyId ?? "")]; if (!policy) throw new CloudFrontError("NoSuchResponseHeadersPolicy", "The response headers policy does not exist", 404);
      for (const association of functionAssociations(behavior)) { if (association.EventType !== "viewer-request") throw new CloudFrontError("InvalidFunctionAssociation", "Only viewer-request Functions are supported"); const fn = Object.values(this.state().functions).find(candidate => candidate.arn === association.FunctionARN); if (!fn?.live) throw new CloudFrontError("InvalidFunctionAssociation", "The associated Function must be published to LIVE"); }
      const methods = allowedMethods(behavior); if (methods.length && methods.some(method => !["GET", "HEAD", "OPTIONS"].includes(method))) throw new CloudFrontError("InvalidArgument", "CFR-01 supports GET, HEAD and OPTIONS only");
    }
    if (cacheBehaviors(config).length !== 2 || cacheBehaviors(config)[0]?.PathPattern !== "assets/*" || cacheBehaviors(config)[1]?.PathPattern !== "runtime-config.json") throw new CloudFrontError("InvalidArgument", "CFR-01 requires ordered assets/* and runtime-config.json behaviors");
    const registry = this.store.state.installation.s3BucketNames[domain.bucketName]; if (!registry || registry.accountId !== this.store.accountId || registry.region !== domain.region) throw new CloudFrontError("InvalidArgument", "The origin domain does not identify a same-account simulator S3 bucket");
    void id;
  }

  async createDistribution(configInput: RecordValue, requestedTags: Record<string, string> = {}, cfnOwner?: CloudFrontInternalOwner): Promise<CloudFrontDistributionState> {
    const config = normalizeDistributionConfig(configInput); const callerReference = requiredString(config.CallerReference, "CallerReference"); this.validateDistributionConfig(config);
    const port = await this.reserveViewerPort();
    try {
      const result = await this.store.withAccountMutation(this.store.accountId, async () => {
        const state = this.state(); const duplicateId = state.distributionCallerReferences[callerReference];
        if (duplicateId) { const duplicate = state.distributions[duplicateId]; if (ownerEquals(duplicate.cloudFormationOwner, cfnOwner)) return { value: canonical(duplicate), inserted: false }; throw new CloudFrontError("DistributionAlreadyExists", "The caller reference is already in use", 409); }
        const id = opaqueId("E", 7); const domain = domainName(); const now = this.clock.now(); const revision = this.nextRevision(state); const value: CloudFrontDistributionState = { id, arn: cloudFrontArn(this.store.accountId, "distribution", id), domainName: domain, localViewerPort: port, callerReference, etag: etag(config, revision), status: "Deployed", configRevision: 1, deployedRevision: 1, config, deployedConfig: canonical(config), tags: canonical(requestedTags), createdAt: now, lastModifiedAt: now, ...(cfnOwner ? { cloudFormationOwner: owner(cfnOwner) } : {}) };
        state.distributions[id] = value; state.distributionCallerReferences[callerReference] = id; state.invalidations[id] = {}; state.invalidationCallerReferences[id] = {}; await this.store.save(); return { value: canonical(value), inserted: true };
      });
      try { await this.bindViewer(result.value); }
      catch (error) {
        if (result.inserted) await this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); delete state.distributions[result.value.id]; delete state.distributionCallerReferences[result.value.callerReference]; delete state.invalidations[result.value.id]; delete state.invalidationCallerReferences[result.value.id]; this.nextRevision(state); await this.store.save(); });
        throw error;
      }
      return result.value;
    } finally { this.reservedViewerPorts.delete(port); }
  }
  getDistribution(id: string): CloudFrontDistributionState { const value = this.state().distributions[id]; if (!value) throw new CloudFrontError("NoSuchDistribution", "The specified distribution does not exist", 404); return canonical(value); }
  async updateDistribution(id: string, configInput: RecordValue, suppliedEtag?: string): Promise<CloudFrontDistributionState> { const config = normalizeDistributionConfig(configInput); this.validateDistributionConfig(config, id); return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.distributions[id]; if (!current) throw new CloudFrontError("NoSuchDistribution", "The specified distribution does not exist", 404); ifMatch(suppliedEtag, current.etag); if (config.CallerReference !== current.callerReference) throw new CloudFrontError("InvalidArgument", "CallerReference cannot be changed"); if (same(current.config, config)) return canonical(current); current.config = config; current.deployedConfig = canonical(config); current.configRevision += 1; current.deployedRevision = current.configRevision; current.status = "Deployed"; current.lastModifiedAt = this.clock.now(); current.etag = etag(config, this.nextRevision(state)); await this.store.save(); return canonical(current); }); }
  async deleteDistribution(id: string, suppliedEtag?: string): Promise<void> { const server = this.viewers.get(id); await this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); const current = state.distributions[id]; if (!current) throw new CloudFrontError("NoSuchDistribution", "The specified distribution does not exist", 404); ifMatch(suppliedEtag, current.etag); if (current.config.Enabled === true) throw new CloudFrontError("DistributionNotDisabled", "The distribution must be disabled before it can be deleted", 409); delete state.distributions[id]; delete state.distributionCallerReferences[current.callerReference]; delete state.invalidations[id]; delete state.invalidationCallerReferences[id]; this.nextRevision(state); await this.store.save(); }); if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); this.viewers.delete(id); this.cache.clearDistribution(id); }

  async createInvalidation(distributionId: string, pathsInput: string[], callerReference: string): Promise<CloudFrontInvalidationState> { if (!pathsInput.length || pathsInput.length > 3_000 || pathsInput.some(path => !path.startsWith("/") || Buffer.byteLength(path) > 4_000 || path.slice(0, -1).includes("*"))) throw new CloudFrontError("InvalidArgument", "Invalidation paths are invalid"); return this.store.withAccountMutation(this.store.accountId, async () => { const state = this.state(); if (!state.distributions[distributionId]) throw new CloudFrontError("NoSuchDistribution", "The specified distribution does not exist", 404); const references = state.invalidationCallerReferences[distributionId] ??= {}; const priorId = references[callerReference]; if (priorId) { const prior = state.invalidations[distributionId][priorId]; if (same(prior.paths, pathsInput)) return canonical(prior); throw new CloudFrontError("InvalidationBatchAlreadyExists", "The caller reference was already used with different paths", 409); } const id = opaqueId("I", 7); const value: CloudFrontInvalidationState = { id, distributionId, callerReference, paths: [...pathsInput], status: "InProgress", createTime: this.clock.now() }; (state.invalidations[distributionId] ??= {})[id] = value; references[callerReference] = id; this.nextRevision(state); await this.store.save(); this.cache.invalidate(distributionId, pathsInput); value.status = "Completed"; this.nextRevision(state); await this.store.save(); return canonical(value); }); }
  getInvalidation(distributionId: string, id: string): CloudFrontInvalidationState { if (!this.state().distributions[distributionId]) throw new CloudFrontError("NoSuchDistribution", "The specified distribution does not exist", 404); const value = this.state().invalidations[distributionId]?.[id]; if (!value) throw new CloudFrontError("NoSuchInvalidation", "The invalidation does not exist", 404); return canonical(value); }

  async tagResource(arn: string, changes: { add?: Record<string, string>; remove?: string[] }): Promise<void> { await this.store.withAccountMutation(this.store.accountId, async () => { const distribution = Object.values(this.state().distributions).find(item => item.arn === arn); const fn = Object.values(this.state().functions).find(item => item.arn === arn); const resource = distribution ?? fn; if (!resource) throw new CloudFrontError("InvalidArgument", "The resource is not taggable in CFR-01", 400); const next = { ...resource.tags, ...(changes.add ?? {}) }; for (const key of changes.remove ?? []) delete next[key]; if (Object.keys(next).length > 50) throw new CloudFrontError("InvalidArgument", "A resource cannot have more than 50 tags"); resource.tags = next; this.nextRevision(this.state()); await this.store.save(); }); }
  listTags(arn: string): Record<string, string> { const resource = Object.values(this.state().distributions).find(item => item.arn === arn) ?? Object.values(this.state().functions).find(item => item.arn === arn); if (!resource) throw new CloudFrontError("InvalidArgument", "The resource is not taggable in CFR-01", 400); return canonical(resource.tags); }

  async releaseCloudFormationOwnership(
    kind: "distribution" | "function" | "origin-access-control" | "response-headers-policy",
    id: string,
    expected: Pick<CloudFrontInternalOwner, "stackId" | "logicalId">,
  ): Promise<void> {
    await this.store.withAccountMutation(this.store.accountId, async () => {
      const state = this.state();
      const resource = kind === "distribution" ? state.distributions[id]
        : kind === "function" ? state.functions[id]
          : kind === "origin-access-control" ? state.originAccessControls[id]
            : state.responseHeadersPolicies[id];
      if (!resource) {
        const code = kind === "distribution" ? "NoSuchDistribution"
          : kind === "function" ? "NoSuchFunctionExists"
            : kind === "origin-access-control" ? "NoSuchOriginAccessControl"
              : "NoSuchResponseHeadersPolicy";
        throw new CloudFrontError(code, `The ${kind} does not exist`, 404);
      }
      const current = resource.cloudFormationOwner;
      if (!current) return;
      if (current.stackId !== expected.stackId || current.logicalId !== expected.logicalId) {
        throw new CloudFrontError("OwnershipConflict", `The ${kind} is not owned by this stack resource`, 409);
      }
      delete resource.cloudFormationOwner;
      this.nextRevision(state);
      await this.store.save();
    });
  }

  private behaviorFor(config: RecordValue, originalUri: string): RecordValue { return cacheBehaviors(config).find(behavior => pathMatches(String(behavior.PathPattern), originalUri)) ?? config.DefaultCacheBehavior; }
  private cacheTtl(headers: Record<string, string>): number { const maxAge = headers["cache-control"]?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1]; return Math.min(31_536_000, Math.max(1, maxAge ? Number(maxAge) : 86_400)); }

  async handleViewer(distributionId: string, req: IncomingMessage, res: ServerResponse, secure: boolean): Promise<void> {
    const requestId = opaqueId("", 8).toLowerCase();
    try {
      if (!this.acceptingViewers) throw new CloudFrontError("ServiceUnavailable", "The local CloudFront viewer is stopping", 503);
      const distribution = this.getDistribution(distributionId); const config = distribution.deployedConfig;
      if (distribution.status !== "Deployed" || !config || config.Enabled !== true) throw new CloudFrontError("AccessDenied", "The distribution is disabled or not deployed", 403);
      const url = new URL(req.url ?? "/", `https://${req.headers.host ?? distribution.domainName}`); let uri: string;
      try { uri = decodeURI(url.pathname); } catch { throw new CloudFrontError("BadRequest", "The viewer URI is malformed", 400); }
      if (!uri.startsWith("/") || /[\0-\x1f\x7f\\]/.test(uri) || uri.split("/").some(part => part === "..") || Buffer.byteLength(uri) > 8 * 1024) throw new CloudFrontError("BadRequest", "The viewer URI is invalid", 400);
      const originalUri = uri; const behavior = this.behaviorFor(config, originalUri); const method = String(req.method ?? "GET").toUpperCase();
      if (!secure) { const host = distribution.domainName.replace(/\.cloudfront\.net$/, ".localhost"); const status = method === "GET" || method === "HEAD" ? 301 : 307; res.statusCode = status; res.setHeader("location", `https://${host}:${distribution.localViewerPort}${url.pathname}${url.search}`); res.end(); return; }
      const methods = allowedMethods(behavior); const effectiveMethods = methods.length ? methods : ["GET", "HEAD"];
      if (!effectiveMethods.includes(method)) throw new CloudFrontError("MethodNotAllowed", "The distribution does not allow this method", 403);
      if (!config.DefaultRootObject && uri === "/") uri = "/"; else if (uri === "/") uri = `/${String(config.DefaultRootObject)}`;
      const headers = Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key.toLowerCase(), Array.isArray(value) ? value.join(",") : value]]));
      let functionRequest: CloudFrontFunctionRequest = { method, uri, querystring: Object.fromEntries([...url.searchParams].map(([key, value]) => [key, { value }])), headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, { value }])), cookies: {} };
      const association = functionAssociations(behavior)[0];
      if (association) { const fn = Object.values(this.state().functions).find(candidate => candidate.arn === association.FunctionARN); if (!fn?.live) throw new CloudFrontError("FunctionError", "The associated Function is unavailable", 502); const event: CloudFrontFunctionEvent = { version: "1.0", context: { distributionDomainName: distribution.domainName, distributionId, eventType: "viewer-request", requestId }, viewer: { ip: req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "127.0.0.1" }, request: functionRequest }; const result = await this.functions.invoke(fn.live.code, event); if (!record(result) || !("uri" in result)) throw new CloudFrontError("FunctionError", "Immediate Function responses are outside CFR-01", 502); functionRequest = result as unknown as CloudFrontFunctionRequest; uri = functionRequest.uri; }
      const policyId = String(behavior.CachePolicyId); const accept = String(req.headers["accept-encoding"] ?? "").toLowerCase(); const encoding = behavior.Compress === true && policyId === CACHING_OPTIMIZED_ID ? /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : "identity" : "identity";
      const cacheKey = `${distributionId}\0${String(behavior.PathPattern ?? "default")}\0${method}\0${uri}\0${encoding}`; const fence = this.cache.generation(distributionId);
      let response = policyId === CACHING_OPTIMIZED_ID && method !== "OPTIONS" ? this.cache.lookup(cacheKey, distributionId) : undefined; const hit = Boolean(response);
      if (!response) {
        const origin = originConfig(config).find(candidate => candidate.Id === behavior.TargetOriginId); if (!origin) throw new CloudFrontError("InvalidOrigin", "The selected origin is unavailable", 502);
        const location = bucketFromDomain(String(origin.DomainName)); if (!location) throw new CloudFrontError("InvalidOrigin", "The origin domain is invalid", 502);
        const port = this.resolveOrigin({ accountId: this.store.accountId, region: location.region, bucketName: location.bucketName });
        try {
          const fetched = await port.request({ accountId: this.store.accountId, bucketRegion: location.region, bucketName: location.bucketName, key: uri.replace(/^\//, ""), distributionArn: distribution.arn, method: method as "GET" | "HEAD" | "OPTIONS", headers, maximumBytes: MAX_ORIGIN_BYTES });
          let body = fetched.body; const originHeaders = { ...fetched.headers };
          const contentType = originHeaders["content-type"] ?? ""; const compressible = /^(?:text\/|application\/(?:javascript|json|xml|wasm)|image\/svg\+xml)/i.test(contentType) && body.length >= 1_000 && body.length <= 10 * 1024 * 1024 && !originHeaders["content-encoding"];
          if (compressible && encoding === "br") { body = await brotliAsync(body); originHeaders["content-encoding"] = "br"; originHeaders["content-length"] = String(body.length); }
          else if (compressible && encoding === "gzip") { body = await gzipAsync(body); originHeaders["content-encoding"] = "gzip"; originHeaders["content-length"] = String(body.length); }
          response = { status: fetched.status, headers: originHeaders, body, storedAt: this.clock.now(), expiresAt: this.clock.now() + this.cacheTtl(originHeaders) * 1_000 };
          if (policyId === CACHING_OPTIMIZED_ID && method !== "OPTIONS") this.cache.publish(cacheKey, distributionId, originalUri, { status: response.status, headers: response.headers, body: response.body, expiresAt: response.expiresAt }, fence);
        } catch (error) { if (error instanceof AwsError) throw new CloudFrontError(error.code === "NoSuchKey" ? "NoSuchKey" : "AccessDenied", error.code === "NoSuchKey" ? "Not Found" : "Access Denied", error.code === "NoSuchKey" ? 404 : 403); throw error; }
      }
      const policy = this.state().responseHeadersPolicies[String(behavior.ResponseHeadersPolicyId)]; if (!policy) throw new CloudFrontError("ResponseHeadersPolicyError", "The response policy is unavailable", 502);
      const responseHeaders = applySecurityHeaders(response.headers, policy.securityHeadersConfig); responseHeaders["x-cache"] = hit ? "Hit from cloudfront" : "Miss from cloudfront"; responseHeaders["x-amz-cf-id"] = requestId; if (hit) responseHeaders.age = String(Math.max(0, Math.floor((this.clock.now() - response.storedAt) / 1_000)));
      res.statusCode = response.status; for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value); res.end(method === "HEAD" ? undefined : response.body);
    } catch (error) { const modeled = error instanceof CloudFrontError ? error : new CloudFrontError("InternalError", "The local CloudFront viewer request failed", 500); res.statusCode = modeled.status; res.setHeader("content-type", "text/plain; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("x-amz-cf-id", requestId); res.end(modeled.message); }
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): Promise<unknown> {
    try {
      const path = url.pathname; const method = req.method ?? "GET"; const body = method === "GET" || method === "DELETE" ? Buffer.alloc(0) : await readBody(req);
      if (path === "/2020-05-31/origin-access-control" && method === "POST") { const config = parseCloudFrontXml(body, "OriginAccessControlConfig").value; const created = await this.createOriginAccessControl(config); return sendCloudFrontXml(res, requestId, "OriginAccessControl", oacView(created), 201, { location: `/2020-05-31/origin-access-control/${created.id}`, etag: created.etag }); }
      if (path === "/2020-05-31/origin-access-control" && method === "GET") { const values = Object.values(this.state().originAccessControls).sort((a, b) => a.id.localeCompare(b.id)).map(oacView); return sendCloudFrontXml(res, requestId, "OriginAccessControlList", { Marker: "", MaxItems: 100, IsTruncated: false, Quantity: values.length, ...(values.length ? { Items: { OriginAccessControlSummary: values } } : {}) }); }
      let match = path.match(/^\/2020-05-31\/origin-access-control\/([^/]+)(\/config)?$/); if (match) { const current = this.getOriginAccessControl(match[1]); if (method === "GET") return sendCloudFrontXml(res, requestId, match[2] ? "OriginAccessControlConfig" : "OriginAccessControl", match[2] ? oacView(current).OriginAccessControlConfig : oacView(current), 200, { etag: current.etag }); if (method === "PUT" && match[2]) { const updated = await this.updateOriginAccessControl(match[1], parseCloudFrontXml(body, "OriginAccessControlConfig").value, String(req.headers["if-match"] ?? "") || undefined); return sendCloudFrontXml(res, requestId, "OriginAccessControl", oacView(updated), 200, { etag: updated.etag }); } if (method === "DELETE" && !match[2]) { await this.deleteOriginAccessControl(match[1], String(req.headers["if-match"] ?? "") || undefined); res.statusCode = 204; return res.end(); } }
      if (path === "/2020-05-31/response-headers-policy" && method === "POST") { const config = parseCloudFrontXml(body, "ResponseHeadersPolicyConfig").value; const created = await this.createResponseHeadersPolicy(config); return sendCloudFrontXml(res, requestId, "ResponseHeadersPolicy", responsePolicyView(created), 201, { location: `/2020-05-31/response-headers-policy/${created.id}`, etag: created.etag }); }
      if (path === "/2020-05-31/response-headers-policy" && method === "GET") { const values = Object.values(this.state().responseHeadersPolicies).sort((a, b) => a.id.localeCompare(b.id)).map(responsePolicyView); return sendCloudFrontXml(res, requestId, "ResponseHeadersPolicyList", { Type: url.searchParams.get("Type") ?? "custom", MaxItems: 100, IsTruncated: false, Quantity: values.length, ...(values.length ? { Items: { ResponseHeadersPolicySummary: values.map(item => ({ Type: "custom", ResponseHeadersPolicy: item })) } } : {}) }); }
      match = path.match(/^\/2020-05-31\/response-headers-policy\/([^/]+)(\/config)?$/); if (match) { const current = this.getResponseHeadersPolicy(match[1]); if (method === "GET") return sendCloudFrontXml(res, requestId, match[2] ? "ResponseHeadersPolicyConfig" : "ResponseHeadersPolicy", match[2] ? responsePolicyConfig(current) : responsePolicyView(current), 200, { etag: current.etag }); if (method === "PUT" && match[2]) { const updated = await this.updateResponseHeadersPolicy(match[1], parseCloudFrontXml(body, "ResponseHeadersPolicyConfig").value, String(req.headers["if-match"] ?? "") || undefined); return sendCloudFrontXml(res, requestId, "ResponseHeadersPolicy", responsePolicyView(updated), 200, { etag: updated.etag }); } if (method === "DELETE" && !match[2]) { await this.deleteResponseHeadersPolicy(match[1], String(req.headers["if-match"] ?? "") || undefined); res.statusCode = 204; return res.end(); } }
      if (path === "/2020-05-31/function" && method === "POST") { const input = parseCloudFrontXml(body, "CreateFunctionRequest").value; const created = await this.createFunction(requiredString(input.Name, "Name"), input.FunctionConfig ?? {}, Buffer.from(requiredString(input.FunctionCode, "FunctionCode"), "base64").toString("utf8")); return sendCloudFrontXml(res, requestId, "FunctionSummary", functionSummary(created), 201, { location: `/2020-05-31/function/${encodeURIComponent(created.name)}`, etag: created.development.etag }); }
      if (path === "/2020-05-31/function" && method === "GET") { const values = Object.values(this.state().functions).sort((a, b) => a.name.localeCompare(b.name)).map(value => functionSummary(value, url.searchParams.get("Stage") === "LIVE" ? "LIVE" : "DEVELOPMENT")); return sendCloudFrontXml(res, requestId, "FunctionList", { MaxItems: 100, IsTruncated: false, Quantity: values.length, ...(values.length ? { Items: { FunctionSummary: values } } : {}) }); }
      match = path.match(/^\/2020-05-31\/function\/([^/]+)(?:\/(describe|publish|test))?$/); if (match) { const name = decodeURIComponent(match[1]); const action = match[2]; const current = this.getFunction(name); const stage = url.searchParams.get("Stage") === "LIVE" ? "LIVE" : "DEVELOPMENT"; const revision = stage === "LIVE" ? current.live : current.development; if (!revision) throw new CloudFrontError("NoSuchFunctionExists", `Function ${name} has no ${stage} stage`, 404); if (method === "GET" && action === "describe") return sendCloudFrontXml(res, requestId, "FunctionSummary", functionSummary(current, stage), 200, { etag: revision.etag }); if (method === "GET" && !action) { res.statusCode = 200; res.setHeader("content-type", "application/octet-stream"); res.setHeader("etag", revision.etag); return res.end(Buffer.from(revision.code)); } if (method === "PUT" && !action) { const input = parseCloudFrontXml(body, "UpdateFunctionRequest").value; const updated = await this.updateFunction(name, input.FunctionConfig ?? {}, Buffer.from(requiredString(input.FunctionCode, "FunctionCode"), "base64").toString("utf8"), String(req.headers["if-match"] ?? "") || undefined); return sendCloudFrontXml(res, requestId, "FunctionSummary", functionSummary(updated), 200, { etag: updated.development.etag }); } if (method === "POST" && action === "publish") { const updated = await this.publishFunction(name, String(req.headers["if-match"] ?? "") || undefined); return sendCloudFrontXml(res, requestId, "FunctionSummary", functionSummary(updated, "LIVE"), 200, { etag: updated.live!.etag }); } if (method === "POST" && action === "test") { const input = parseCloudFrontXml(body, "TestFunctionRequest").value; const event = JSON.parse(Buffer.from(requiredString(input.EventObject, "EventObject"), "base64").toString("utf8")); const result = await this.testFunction(name, input.Stage === "LIVE" ? "LIVE" : "DEVELOPMENT", event); return sendCloudFrontXml(res, requestId, "TestResult", result); } if (method === "DELETE" && !action) { await this.deleteFunction(name, String(req.headers["if-match"] ?? "") || undefined); res.statusCode = 204; return res.end(); } }
      if (path === "/2020-05-31/distribution" && method === "POST") { const parsed = parseCloudFrontXml(body); const withTags = parsed.root === "DistributionConfigWithTags"; const config = withTags ? parsed.value.DistributionConfig : parsed.value; const created = await this.createDistribution(config, withTags ? tags(parsed.value.Tags) : {}); return sendCloudFrontXml(res, requestId, "Distribution", distributionView(created), 201, { location: `/2020-05-31/distribution/${created.id}`, etag: created.etag }); }
      if (path === "/2020-05-31/distribution" && method === "GET") { const values = Object.values(this.state().distributions).sort((a, b) => a.id.localeCompare(b.id)).map(distributionView); return sendCloudFrontXml(res, requestId, "DistributionList", { Marker: "", MaxItems: 100, IsTruncated: false, Quantity: values.length, ...(values.length ? { Items: { DistributionSummary: values.map(item => { const { DistributionConfig, ...summary } = item; return { ...summary, ...DistributionConfig }; }) } } : {}) }); }
      match = path.match(/^\/2020-05-31\/distribution\/([^/]+)(\/config)?$/); if (match) { const current = this.getDistribution(match[1]); if (method === "GET") return sendCloudFrontXml(res, requestId, match[2] ? "DistributionConfig" : "Distribution", match[2] ? current.config : distributionView(current), 200, { etag: current.etag }); if (method === "PUT" && match[2]) { const updated = await this.updateDistribution(match[1], parseCloudFrontXml(body, "DistributionConfig").value, String(req.headers["if-match"] ?? "") || undefined); return sendCloudFrontXml(res, requestId, "Distribution", distributionView(updated), 200, { etag: updated.etag }); } if (method === "DELETE" && !match[2]) { await this.deleteDistribution(match[1], String(req.headers["if-match"] ?? "") || undefined); res.statusCode = 204; return res.end(); } }
      match = path.match(/^\/2020-05-31\/distribution\/([^/]+)\/invalidation(?:\/([^/]+))?$/); if (match) { if (method === "POST" && !match[2]) { const input = parseCloudFrontXml(body, "InvalidationBatch").value; const paths = items(input.Paths, "Path").map(String); const created = await this.createInvalidation(match[1], paths, requiredString(input.CallerReference, "CallerReference")); return sendCloudFrontXml(res, requestId, "Invalidation", invalidationView(created), 201, { location: `${path}/${created.id}` }); } if (method === "GET" && match[2]) return sendCloudFrontXml(res, requestId, "Invalidation", invalidationView(this.getInvalidation(match[1], match[2]))); if (method === "GET" && !match[2]) { this.getDistribution(match[1]); const values = Object.values(this.state().invalidations[match[1]] ?? {}).sort((a, b) => a.createTime - b.createTime).map(invalidationView); return sendCloudFrontXml(res, requestId, "InvalidationList", { Marker: "", MaxItems: 100, IsTruncated: false, Quantity: values.length, ...(values.length ? { Items: { InvalidationSummary: values.map(value => ({ Id: value.Id, CreateTime: value.CreateTime, Status: value.Status })) } } : {}) }); } }
      match = path.match(/^\/2020-05-31\/cache-policy(?:\/([^/]+)(\/config)?)?$/); if (match && method === "GET") { if (!match[1]) { const policies = Object.values(MANAGED_CACHE_POLICIES); return sendCloudFrontXml(res, requestId, "CachePolicyList", { Type: url.searchParams.get("Type") ?? "managed", MaxItems: 100, IsTruncated: false, Quantity: policies.length, Items: { CachePolicySummary: policies.map(policy => ({ Type: "managed", CachePolicy: policy })) } }); } const policy = MANAGED_CACHE_POLICIES[match[1] as keyof typeof MANAGED_CACHE_POLICIES]; if (!policy) throw new CloudFrontError("NoSuchCachePolicy", "The cache policy does not exist", 404); return sendCloudFrontXml(res, requestId, match[2] ? "CachePolicyConfig" : "CachePolicy", match[2] ? policy.CachePolicyConfig : policy, 200, { etag: "managed" }); }
      if (path === "/2020-05-31/tagging") { const resource = requiredString(url.searchParams.get("Resource"), "Resource"); if (method === "GET") return sendCloudFrontXml(res, requestId, "Tags", tagItems(this.listTags(resource))); const input = parseCloudFrontXml(body); if (url.searchParams.get("Operation") === "Tag") await this.tagResource(resource, { add: tags(input.value) }); else if (url.searchParams.get("Operation") === "Untag") await this.tagResource(resource, { remove: items(input.value, "Key").map(String) }); else throw new CloudFrontError("InvalidArgument", "Tagging Operation must be Tag or Untag"); res.statusCode = 204; return res.end(); }
      throw new CloudFrontError("NoSuchResource", "The requested CloudFront operation is not implemented by CFR-01", 404);
    } catch (error) { sendCloudFrontError(res, requestId, error); }
  }
}
