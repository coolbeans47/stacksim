import capabilities from "../docs/opensearch-capabilities.json" with { type: "json" };
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import type { StateStore } from "./state.js";
import type { Clock } from "./core/clock.js";
import { ISM_INTERVAL } from "./opensearch/ism.js";
import { SearchPackages, PACKAGE_ACTIONS } from "./opensearch/packages.js";
import { AutomaticSearchBackups } from "./opensearch/automatic-backups.js";
import { SearchInsights, INSIGHT_ACTIONS } from "./opensearch/insights.js";
import { SearchApplications } from "./opensearch/applications.js";
import { compareMetadata, comparisonCategories } from "./opensearch/compare.js";
import { SearchConnections, CONNECTION_ACTIONS } from "./opensearch/connections.js";
import { SearchDirectQueries } from "./opensearch/direct-query.js";
import type { TelemetryEvent } from "./core/telemetry.js";
import { AwsError } from "./errors.js";
import { authenticateSigV4, principalWithoutValidation, type PrincipalContext } from "./auth/sigv4.js";
import { combineIdentityAndResourceAuthorization, evaluateAuthorization, evaluateResourcePolicy, type AuthorizationResult } from "./iam/evaluator.js";
import { json } from "./util.js";
import { EmbeddedSearchEngine, type SearchObservation, type SearchReadView } from "./opensearch/engine.js";
import { SearchLogging, type SearchLogPort } from "./opensearch/logging.js";
import { shouldAudit, type AuditCategory } from "./opensearch/audit.js";
import { domainArn, domainPolicy, type DomainRecord, type DomainChange, type DomainDryRun, type DomainMaintenance } from "./opensearch/model.js";
import { PaginationTokens } from "./core/pagination.js";
import { EncryptedMaterialStore, type MaterialBinding } from "./configuration-secrets/encrypted-material-store.js";
import { passwordVerifier, type SearchAccess, type SearchIdentity, type SecurityMaster } from "./opensearch/security.js";
import { familyForRequest, readOpenSearchBody, resolveOperation, sendOpenSearchError, validateInput, type OperationRoute } from "./opensearch/protocol.js";
import { domainConfiguration, ENGINE_VERSION, INSTANCE_TYPE, reject, tags } from "./opensearch/validation.js";
import { SearchError, record } from "./opensearch/query.js";
import { legacyResponse, modernRoute, LEGACY_ACTIONS } from "./opensearch/legacy.js";
import { OpenSearchServerlessService } from "./opensearch/serverless.js";
import { OpenSearchIngestionService, type IngestionPorts } from "./opensearch/ingestion/service.js";
import type { IngestionConfig } from "./opensearch/ingestion/config.js";
import { SearchSnapshots, type SnapshotRepository, type SnapshotObjectPort } from "./opensearch/snapshots.js";

export const MANAGED_ACTIONS = new Set<string>(capabilities.managedActions);
const DISCOVERY = new Set(["ListDomainNames", "ListVersions", "ListInstanceTypeDetails", "DescribeInstanceTypeLimits"]);
type TlsConfiguration = { certificate: string; privateKey: string; caCertificatePath: string };

export class OpenSearchService {
  readonly serverless: OpenSearchServerlessService;
  readonly ingestion: OpenSearchIngestionService;
  readonly applications: SearchApplications;
  readonly connections: SearchConnections;
  readonly directQueries: SearchDirectQueries;
  private readonly snapshots: SearchSnapshots;
  private readonly logging: SearchLogging;
  private readonly packages: SearchPackages;
  private readonly automaticBackups: AutomaticSearchBackups;
  private readonly insights: SearchInsights;
  private packageSource?: (region: string, accountId: string, bucket: string, key: string, principal?: PrincipalContext) => Promise<Buffer>;
  private snapshotObjects?: (domain: DomainRecord, repository: SnapshotRepository) => Promise<SnapshotObjectPort>;
  private tls?: TlsConfiguration;
  private readonly engines = new Map<string, EmbeddedSearchEngine>();
  private readonly gateways = new Map<string, HttpsServer>();
  private readonly jobs = new Map<string, Promise<void>>();
  private closing = false;
  private ismTimer?: ReturnType<Clock["setTimeout"]>;
  private telemetry?: (region: string, event: TelemetryEvent) => Promise<void>;
  private readonly requests = new Map<string, number>();
  private readonly materials: EncryptedMaterialStore;
  private materialFailure?: unknown;
  private readonly storageTransitions = new Set<string>();
  private readonly publishingMaintenance = new Set<string>();
  constructor(readonly store: StateStore, readonly clock: Clock, private readonly authMode: "off" | "validate" | "enforce" = "enforce") {
    this.logging = new SearchLogging(store, clock);
    this.connections = new SearchConnections(store, clock, () => this.all());
    this.materials = new EncryptedMaterialStore(store.root, "opensearch"); this.serverless = new OpenSearchServerlessService(store, clock, authMode); this.ingestion = new OpenSearchIngestionService(store, clock, authMode);
    this.directQueries = new SearchDirectQueries(store, clock, {
      authorize: (principal, action, resource, region, secure, extra) => this.authorize(principal, action, resource, region, secure, undefined, extra),
      collection: (arn, region, account, principal) => {
        const collection = Object.values(this.serverless.state(region, account).collections).find(collection => collection.arn === arn && collection.status === 'ACTIVE');
        if (!collection) throw new AwsError('ValidationException', 'Direct query associations require active same-account, same-Region collections', 400);
        if (principal) this.serverless.authorizeOperation('BatchGetCollection', { ids: [collection.id] }, region, principal, true);
        return collection.generation;
      },
    }, authMode);
    this.applications = new SearchApplications(store, clock, {
      authorize: (principal, action, resource, region, secure, extra) => this.authorize(principal, action, resource, region, secure, undefined, extra),
      identity: (req, url, region) => this.identity(req, url, region, 'opensearch'),
      source: (arn, region, account, principal) => {
        const domain = this.domains(region, account).find(item => item.arn === arn);
        if (domain) { if (principal) this.authorize(principal, 'es:DescribeDomain', arn, region, true); return { generation: domain.generation, kind: 'domain', active: domain.state === 'active', failed: ['deleting', 'failed'].includes(domain.state) }; }
        const collection = Object.values(this.serverless.state(region, account).collections).find(item => item.arn === arn);
        if (collection) { if (principal) this.serverless.authorizeOperation('BatchGetCollection', { ids: [collection.id] }, region, principal, true); return { generation: collection.generation, kind: 'collection', active: collection.status === 'ACTIVE', failed: ['DELETING', 'FAILED'].includes(collection.status) }; }
        throw new AwsError('ValidationException', 'Application sources require a current same-account, same-Region managed domain or collection', 400);
      },
      query: async (source, app, principal, secure, input) => {
        if (source.kind === 'collection') {
          const collection = Object.values(this.serverless.state(app.region, app.accountId).collections).find(item => item.arn === source.dataSourceArn && item.generation === source.generation);
          if (!collection) throw new AwsError('ResourceNotFoundException', 'Application source was removed', 409);
          return this.serverless.localQuery(app.region, app.accountId, collection.id, principal, secure, input, 'application.opensearchservice.amazonaws.com');
        }
        const domain = this.domains(app.region, app.accountId).find(item => item.arn === source.dataSourceArn && item.generation === source.generation);
        if (!domain) throw new AwsError('ResourceNotFoundException', 'Application source was removed', 409);
        this.dataAuthorization(domain, principal, input.method, input.path, secure); const release = this.admitRequest(domain);
        try { const result = await this.searchRequest(domain, principal, input.method, input.path, Buffer.from(typeof input.body === 'string' ? input.body : input.body === undefined ? '' : JSON.stringify(input.body)), undefined, secure); await this.report(domain, result.status); return result; } finally { release(); }
      },
    });
    const packageEngine = (domain: DomainRecord) => { const engine = this.engines.get(domain.generation); if (!engine) throw new AwsError("InternalException", "Domain storage is unavailable", 503); return engine; };
    this.packages = new SearchPackages(store, clock, this.materials, {
      catalog: (region, accountId) => this.state(region, accountId).packages ??= { records: {}, cursorKey: randomUUID() },
      all: () => Object.values(store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.packages?.records ?? {}))),
      domain: (region, accountId, name) => this.domain(region, name, accountId),
      source: (region, accountId, bucket, key, principal) => { if (!this.packageSource) throw new AwsError("InternalException", "Package S3 source integration is unavailable", 503); return this.packageSource(region, accountId, bucket, key, principal); },
      install: (domain, id, version, versions, validate) => packageEngine(domain).installDictionaryVersions(id, version, versions, validate),
      remove: (domain, id) => packageEngine(domain).removeDictionary(id), inUse: (domain, id) => packageEngine(domain).usesDictionary(id), validate: domain => packageEngine(domain).validateAnalysis(),
      mutate: async (domain, work) => {
        if (domain.state !== "active" || this.storageTransitions.has(domain.generation) || this.maintenance(domain)) throw new AwsError("ConflictException", "Domain is unavailable for package publication", 409);
        this.storageTransitions.add(domain.generation);
        try { const deadline = Date.now() + 30000; while ((this.requests.get(domain.generation) ?? 0) > 0) { if (Date.now() >= deadline) throw new AwsError("InternalException", "Package publication could not drain active requests", 503); await delay(5); } await work(); }
        finally { this.storageTransitions.delete(domain.generation); }
      },
    });
    this.insights = new SearchInsights(store, clock, { domains: (region, accountId) => this.domains(region, accountId), metrics: domain => { try { return this.engines.get(domain.generation)?.metrics(); } catch { return undefined; } } });
    this.automaticBackups = new AutomaticSearchBackups(store, clock, { all: () => this.all(), engine: domain => this.engine(domain), admit: domain => this.admitRequest(domain), available: domain => !this.closing && domain.state === "active" && !this.maintenance(domain) && !this.pending(domain) && !this.storageTransitions.has(domain.generation) });
    this.snapshots = new SearchSnapshots(store, clock, {
      engine: domain => this.engine(domain), all: () => this.all().map(domain => ({ domain, engine: this.engines.get(domain.generation) })), admit: domain => this.admitRequest(domain),
      passRole: (domain, principal, roleArn, secure) => { if (this.authMode !== "off" && (principal.principalType === "anonymous" || principal.accountId !== domain.accountId)) throw new SearchError("security_exception", "Repository registration requires a same-account IAM identity and iam:PassRole", 403); this.authorize(principal, "iam:PassRole", roleArn, domain.region, secure, undefined, { "iam:PassedToService": "es.amazonaws.com", "iam:AssociatedResourceArn": domain.arn }); },
      automatic: domain => this.automaticBackups.repositories(domain),
      objects: async (domain, repository) => { if (repository.type === "stacksim-automatic") return this.automaticBackups.objects(domain, repository); if (!this.snapshotObjects) throw new SearchError("repository_exception", "Snapshot S3 integration is unavailable", 503); return this.snapshotObjects(domain, repository); },
    });
  }
  configureSnapshots(objects: (domain: DomainRecord, repository: SnapshotRepository) => Promise<SnapshotObjectPort>): void { this.snapshotObjects = objects; }
  configurePackageSource(source: (region: string, accountId: string, bucket: string, key: string, principal?: PrincipalContext) => Promise<Buffer>): void { this.packageSource = source; }
  configureLogs(port: SearchLogPort): void { this.logging.configure(port); }
  private async audit(domain: DomainRecord, category: AuditCategory, user: string, method: string, path: string, observation?: SearchObservation): Promise<void> {
    if (!domain.config.AdvancedSecurityOptions.Enabled || !domain.config.LogPublishingOptions?.AUDIT_LOGS?.Enabled) return;
    try {
      const config = this.engine(domain).security.auditConfig(), pathname = path.split("?")[0];
      if (!shouldAudit(config, category, user, pathname)) return;
      await this.logging.event(domain, "AUDIT_LOGS", { audit_category: category, audit_format_version: 4, "@timestamp": new Date(this.clock.now()).toISOString(), audit_cluster_name: `${domain.accountId}:${domain.name}`, audit_node_id: domain.generation, audit_request_layer: "REST", audit_request_origin: "REST", audit_request_effective_user: user.slice(0, 1024), audit_rest_request_method: method, audit_rest_request_path: pathname.slice(0, 1024), ...(config.audit.resolve_indices && observation ? { audit_trace_resolved_indices: observation.indexes.map(index => index.name).slice(0, 20) } : {}) });
    } catch { /* Audit storage/delivery cannot revoke an acknowledged request. */ }
  }
  private async searchRequest(domain: DomainRecord, principal: PrincipalContext, method: string, path: string, body: Buffer, basic?: string, secure = true) {
    const pathname = path.split("?")[0];
    let status = 500, observation: SearchObservation | undefined, access: SearchAccess | undefined, deniedItem = false;
    try {
      access = this.searchAccess(domain, principal, basic);
      if (access) await this.audit(domain, "AUTHENTICATED", access.identity.name, method, path);
      const result = pathname === "/_snapshot" || pathname.startsWith("/_snapshot/") || pathname === "/_stacksim/snapshots/jobs"
        ? await this.snapshots.request(domain, principal, method, path, body, access, secure)
        : /[:]|%3a/i.test(pathname.split("/")[1] ?? "") ? await this.crossClusterSearch(domain, principal, method, path, body, access, basic, secure, event => { observation = event; })
        : await this.engine(domain).request(method, path, body, access?.identity.internal ? `internal:${access.identity.name}` : this.principalKey(principal), domain.config.AdvancedOptions["rest.action.multi.allow_explicit_index"] !== "false", access, event => { observation = event; });
      status = result.status;
      deniedItem = Boolean(result.body?.items?.some((item: Record<string, any>) => Object.values(item).some(value => value?.status === 403)) || result.body?.responses?.some((item: any) => item.status === 403));
      return result;
    } catch (error) { status = error instanceof AwsError || error instanceof SearchError ? error.status : 500; throw error; }
    finally {
      await this.logging.request(domain, method, path, status, observation);
      if (status === 401 && !access) await this.audit(domain, "FAILED_LOGIN", "unauthenticated", method, path);
      else if (access && (status === 403 || deniedItem || status >= 200 && status < 300)) await this.audit(domain, status === 403 || deniedItem ? "MISSING_PRIVILEGES" : "GRANTED_PRIVILEGES", access.identity.name, method, path, observation);
    }
  }
  private async crossClusterSearch(source: DomainRecord, principal: PrincipalContext, method: string, path: string, raw: Buffer, access: SearchAccess | undefined, basic: string | undefined, secure: boolean, observe: (event: SearchObservation) => void) {
    const started = performance.now(), budget = { bytes: 0, documents: 0, indexes: 0, deadline: started + 30000 };
    const url = new URL(path, "https://localhost"); let parts: string[];
    try { parts = url.pathname.split("/").slice(1).map(decodeURIComponent); } catch { throw new SearchError("parse_exception", "Invalid URI encoding"); }
    if (!["GET", "POST"].includes(method) || parts.length !== 2 || parts[1] !== "_search") throw new SearchError("unsupported_operation_exception", "Cross-cluster requests support GET or POST /indexes/_search only");
    if (basic || !access || access.identity.internal || !source.config.NodeToNodeEncryptionOptions.Enabled) throw new SearchError("security_exception", "Cross-cluster search requires IAM authentication, fine-grained security and node-to-node encryption", 403);
    let body; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new SearchError('parse_exception', 'Invalid search JSON'); } record(body, 'search');
    if (body.timeout !== undefined) {
      const match = /^(\d+)(ms|s|m)$/.exec(String(body.timeout)), duration = match ? Number(match[1]) * (match[2] === 'm' ? 60000 : match[2] === 's' ? 1000 : 1) : 0;
      if (duration < 1 || duration > 300000) throw new SearchError('illegal_argument_exception', 'timeout must be between 1ms and 5m');
      budget.deadline = Math.min(budget.deadline, started + duration);
    }
    const patterns = parts[0].split(','), groups = new Map<string, string[]>();
    if (patterns.length > 100) throw new SearchError('limit_exceeded_exception', 'At most 100 cross-cluster index selectors are supported', 429);
    for (const pattern of patterns) {
      const segments = pattern.split(':'), alias = segments.length === 1 ? '' : segments[0], index = segments.at(-1)!;
      if (segments.length > 2 || !index || index.startsWith('.') || index.includes('/') || segments.length === 2 && !/^[a-zA-Z][a-zA-Z0-9_-]{1,99}$/.test(alias)) throw new SearchError('illegal_argument_exception', 'Cross-cluster selectors require a literal connection alias and an index pattern');
      const values = groups.get(alias) ?? []; values.push(index); groups.set(alias, values);
    }
    const view: SearchReadView = { indexes: [], docs: [] }, releases: Array<() => void> = [], remoteObservations: Array<{ domain: DomainRecord; access?: SearchAccess; observation?: SearchObservation; status: number }> = [];
    let skipped = 0;
    try {
      for (const [alias, selectors] of groups) {
        let domain = source, remoteAccess = access, remoteObservation: typeof remoteObservations[number] | undefined;
        if (alias) {
          const resolved = this.connections.resolve(source, alias);
          if (!resolved.remote) { if (resolved.connection.skipUnavailable) { skipped++; continue; } throw new SearchError('unavailable_shards_exception', `Remote cluster [${alias}] is unavailable`, 503); }
          domain = resolved.remote; remoteObservation = { domain, status: 500 }; remoteObservations.push(remoteObservation);
          const context = { 'aws:PrincipalArn': principal.principalArn, 'aws:PrincipalAccount': principal.accountId, 'aws:RequestedRegion': domain.region, 'aws:ResourceAccount': domain.accountId, 'aws:CurrentTime': new Date(this.clock.now()).toISOString(), 'aws:SecureTransport': secure, ...Object.fromEntries(Object.entries(domain.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) };
          // Managed cross-cluster access requires an explicit destination resource-policy grant.
          if (this.authMode === 'enforce' && (!domainPolicy(domain) || evaluateResourcePolicy(domainPolicy(domain)!, principal, 'es:ESCrossClusterGet', domain.arn, context).decision !== 'allowed')) { remoteObservation.status = 403; throw new SearchError('security_exception', 'Destination policy must allow es:ESCrossClusterGet on the domain ARN', 403); }
          try { this.authorize(principal, 'es:ESCrossClusterGet', domain.arn, domain.region, secure, domain, context); } catch (error) { remoteObservation.status = 403; throw error; }
          if (!domain.config.AdvancedSecurityOptions.Enabled || !domain.config.NodeToNodeEncryptionOptions.Enabled) { remoteObservation.status = 403; throw new SearchError('security_exception', 'Destination security prerequisites no longer hold', 403); }
          try { releases.push(this.admitRequest(domain)); remoteAccess = this.searchAccess(domain, principal)!; remoteObservation.access = remoteAccess; }
          catch (error) { remoteObservation.status = error instanceof AwsError || error instanceof SearchError ? error.status : 500; if (resolved.connection.skipUnavailable && remoteObservation.status === 503) { skipped++; continue; } throw error; }
        }
        try {
          const selected = this.engine(domain).crossClusterView(selectors.join(','), remoteAccess!, alias ? `${alias}:` : '', budget);
          view.indexes.push(...selected.indexes); view.docs.push(...selected.docs);
          const observation = { durationMs: performance.now() - started, indexes: selected.indexes.map(index => ({ name: alias ? index.name.slice(alias.length + 1) : index.name, settings: index.settings })) };
          if (remoteObservation) { remoteObservation.observation = observation; remoteObservation.status = 200; } else observe(observation);
        } catch (error) {
          const status = error instanceof AwsError || error instanceof SearchError ? error.status : 500;
          if (remoteObservation) remoteObservation.status = status;
          if (alias && status === 503 && this.connections.resolve(source, alias).connection.skipUnavailable) { skipped++; continue; }
          throw error;
        }
      }
      const result = this.engine(source).crossClusterSearch(body, url.searchParams, view, budget.deadline);
      result.body._shards = { total: view.indexes.length, successful: view.indexes.length, skipped: 0, failed: 0 };
      result.body._clusters = { total: groups.size, successful: groups.size - skipped, skipped };
      return result;
    } finally {
      releases.forEach(release => release());
      for (const item of remoteObservations) {
        await this.report(item.domain, item.status); await this.logging.request(item.domain, method, path, item.status, item.observation);
        await this.audit(item.domain, item.status === 403 ? 'MISSING_PRIVILEGES' : item.status === 200 ? 'GRANTED_PRIVILEGES' : 'AUTHENTICATED', item.access?.identity.name ?? principal.roleArn ?? principal.principalArn, method, path, item.observation);
      }
    }
  }
  private compareConfiguration(input: Record<string, any>, region: string, accountId: string, principal?: PrincipalContext, secure = true) {
    const categories = comparisonCategories(input.Categories);
    const domains = [input.SourceDomainArn, input.TargetDomainArn].map(arn => this.all().find(domain => domain.arn === arn && domain.accountId === accountId));
    if (!domains[0] || !domains[1] || domains[0].region !== region || domains[0].arn.split(':')[1] !== domains[1].arn.split(':')[1]) throw new AwsError('ValidationException', 'Comparison requires two same-account domains in this partition, requested in the source Region', 400);
    for (const domain of domains) if (principal) this.authorize(principal, 'es:CompareDomainConfiguration', domain!.arn, domain!.region, secure, undefined, Object.fromEntries(Object.entries(domain!.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])));
    const releases: Array<() => void> = [];
    try {
      domains.forEach(domain => releases.push(this.admitRequest(domain!)));
      const budget = { bytes: 0, nodes: 0, deadline: performance.now() + 30000 };
      const Categories = Object.fromEntries(categories.map(category => [category, compareMetadata(category, this.engine(domains[0]!).configurationMetadata(category, budget), this.engine(domains[1]!).configurationMetadata(category, budget), budget)]));
      return { SourceDomainArn: input.SourceDomainArn, TargetDomainArn: input.TargetDomainArn, Categories };
    } finally { releases.forEach(release => release()); }
  }
  configureTls(tls: TlsConfiguration): void { this.tls = tls; this.serverless.configureTls(tls); this.ingestion.configureTls(tls); this.applications.configureTls(tls); }
  dataSourceDomain(endpoint: string, region: string, account: string): DomainRecord {
    const domain = this.domains(region, account).find(domain => endpoint === `https://127.0.0.1:${domain.gatewayPort}`);
    if (!domain || domain.state === "deleting") throw new AwsError("ValidationException", "OpenSearch data sources require a current same-account, same-Region managed domain endpoint", 400);
    return domain;
  }
  async dataSourceRequest(endpoint: string, region: string, account: string, principal: PrincipalContext, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (principal.accountId !== account) throw new AwsError("AccessDeniedException", "The data source role must belong to the domain account", 403);
    const domain = this.dataSourceDomain(endpoint, region, account);
    this.dataAuthorization(domain, principal, method, path, true);
    const release = this.admitRequest(domain);
    try {
      const result = await this.searchRequest(domain, principal, method, path, Buffer.from(body === undefined ? "" : JSON.stringify(body)));
      await this.report(domain, result.status);
      if (result.status >= 300) throw new SearchError(result.body?.error?.type ?? "opensearch_exception", result.body?.error?.reason ?? "OpenSearch request failed", result.status);
      if (Buffer.byteLength(JSON.stringify(result.body) ?? "") > 1024 * 1024) throw new AwsError("LimitExceededException", "OpenSearch resolver response exceeds 1 MiB", 413);
      return result.body;
    } finally { release(); }
  }
  configureIngestion(ports: Omit<IngestionPorts, "resolveSink" | "deliver">): void {
    if (ports.s3Source) this.serverless.configureIngestion(ports.s3Source);
    this.ingestion.configurePorts({ ...ports, resolveSink: (config, account) => this.ingestionSink(config, account), deliver: (config, principal, account, index, id, document, write) => this.deliverIngestion(config, principal, account, index, id, document, write) });
  }
  private ingestionSink(config: IngestionConfig, account: string) {
    if (config.sink.serverless) return this.serverless.ingestionSink(config.sink.host, config.sink.region, account);
    const domain = this.domains(config.sink.region, account).find(domain => config.sink.host === `https://127.0.0.1:${domain.gatewayPort}`);
    if (!domain) throw new AwsError("ValidationException", "Sink must name a current same-account managed domain endpoint", 400);
    return { arn: domain.arn, generatedIdsOnly: false, domain };
  }
  private async deliverIngestion(config: IngestionConfig, principal: PrincipalContext, account: string, index: string, id: string | undefined, document: Record<string, any>, write?: import('./opensearch/ingestion/service.js').IngestionWrite): Promise<void> {
    if (write && (!['index', 'delete'].includes(write.action) || !Number.isSafeInteger(write.version) || write.version < 0 || id === undefined)) throw new AwsError('ValidationException', 'Invalid source write metadata', 400);
    const sink = this.ingestionSink(config, account), resourcePath = `/${encodeURIComponent(index)}/_doc${id === undefined ? "" : `/${encodeURIComponent(id)}`}`, path = resourcePath + (write ? `?version=${write.version}&version_type=external` : ''), method = write?.action === 'delete' ? 'DELETE' : id === undefined ? "POST" : "PUT";
    if (config.sink.serverless) { await this.serverless.deliverIngestion(config.sink.host, config.sink.region, account, principal, method, path, document); return; }
    const domain = (sink as { domain: DomainRecord }).domain;
    this.authorize(principal, "es:DescribeDomain", domain.arn, domain.region, true);
    this.dataAuthorization(domain, principal, method, resourcePath, true);
    const release = this.admitRequest(domain);
    try {
      const result = await this.searchRequest(domain, principal, method, path, Buffer.from(method === 'DELETE' ? '' : JSON.stringify(document))).catch(error => {
        // A conflict means the same or a later stream version already committed.
        // Authentication/authorization happened above; only this exact engine
        // conflict is an acknowledgment, never an arbitrary 409 response.
        if (write && error instanceof SearchError && error.type === 'version_conflict_engine_exception') return { status: 200, body: {} };
        throw error;
      });
      if (write && (result.status === 409 && result.body?.error?.type === 'version_conflict_engine_exception' || method === 'DELETE' && result.status === 404 && result.body?.result === 'not_found')) return;
      if (result.status >= 300) throw new SearchError("ingestion_delivery_exception", "The managed sink rejected the event", result.status);
      await this.report(domain, result.status);
    } finally { release(); }
  }
  setTelemetryPublisher(publisher: (region: string, event: TelemetryEvent) => Promise<void>): void { this.telemetry = publisher; }
  private async report(domain: DomainRecord, status?: number): Promise<void> {
    if (!this.telemetry) return;
    try {
      const metrics = this.engines.get(domain.generation)?.metrics();
      const gauges: Record<string, number> = metrics ? { SearchableDocuments: metrics.searchable, DeletedDocuments: metrics.deleted, "ClusterStatus.green": domain.state === "active" && !this.maintenance(domain) && !this.storageTransitions.has(domain.generation) ? 1 : 0, Nodes: 1 } : {};
      for (const [metricName, value] of [...Object.entries(gauges), ...(status === undefined ? [] : [["OpenSearchRequests", 1], [`${Math.floor(status / 100)}xx`, 1]] as Array<[string, number]>)]) await this.telemetry(domain.region, { namespace: "AWS/ES", metricName, dimensions: { ClientId: domain.accountId, DomainName: domain.name }, unit: "Count", value, timestamp: this.clock.now(), aggregation: Object.hasOwn(gauges, metricName) ? "gauge" : "sample" });
    } catch { /* Metric-storage failure must not change an acknowledged search write. */ }
  }
  private state(region: string, accountId = this.store.accountId) { return this.store.regionState(region, accountId).opensearch; }
  domains(region: string, accountId = this.store.accountId): DomainRecord[] { return Object.values(this.state(region, accountId).domains); }
  domain(region: string, name: string, accountId = this.store.accountId): DomainRecord { const domains = this.state(region, accountId).domains; if (Object.hasOwn(domains, name)) return domains[name]; throw new AwsError("ResourceNotFoundException", `Domain [${name}] does not exist`, 409); }
  private all(): DomainRecord[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.domains ?? {}))); }
  private directory(domain: DomainRecord): string { if (!/^[a-f0-9-]{36}$/.test(domain.generation)) throw new Error("Invalid OpenSearch generation"); return join(this.store.root, "data", "opensearch", domain.generation); }
  private keyFile(domain: DomainRecord): string { this.directory(domain); return join(this.store.root, "secrets", "opensearch", `${domain.generation}.key`); }
  private materialBinding(domain: DomainRecord, version: number): MaterialBinding { return { service: "opensearch", accountId: domain.accountId, region: domain.region, resourceArn: domain.arn, generationId: domain.generation, valueKind: "PasswordVerifier", version }; }
  private async publishMaster(domain: DomainRecord, input: Record<string, any>, version: number): Promise<DomainRecord["securityMaterial"]> {
    const options = input.AdvancedSecurityOptions?.MasterUserOptions;
    if (!options) return undefined;
    if (this.materialFailure) throw new AwsError("InternalException", "Protected OpenSearch credentials are unavailable", 503);
    const master: SecurityMaster = options.MasterUserARN ? { arn: options.MasterUserARN } : { username: options.MasterUserName, verifier: passwordVerifier(options.MasterUserPassword) };
    const plaintext = Buffer.from(JSON.stringify(master));
    try { return { id: (await this.materials.publish(this.materialBinding(domain, version), plaintext)).materialId, version }; }
    finally { plaintext.fill(0); }
  }
  private async applyMaster(domain: DomainRecord, engine: EmbeddedSearchEngine, reference = domain.securityMaterial): Promise<void> {
    if (!reference) return;
    if (this.materialFailure) throw new AwsError("InternalException", "Protected OpenSearch credentials are unavailable", 503);
    const plaintext = await this.materials.read(this.materialBinding(domain, reference.version), reference.id);
    try { engine.setSecurityMaster(JSON.parse(plaintext.toString("utf8"))); } finally { plaintext.fill(0); }
  }
  private pending(domain: DomainRecord): DomainChange | undefined { return domain.changes?.find(change => change.state === "PENDING" || change.state === "PROCESSING"); }
  private maintenance(domain: DomainRecord): DomainMaintenance | undefined { return domain.maintenances?.find(job => job.state === "PENDING" || job.state === "IN_PROGRESS"); }
  private maintenanceView(domain: DomainRecord, job: DomainMaintenance) { return { MaintenanceId: job.id, DomainName: domain.name, Action: job.action, NodeId: domain.generation, Status: this.publishingMaintenance.has(job.id) ? "IN_PROGRESS" : job.state, StatusMessage: this.publishingMaintenance.has(job.id) ? "Publishing the recovered search endpoint" : job.message, CreatedAt: job.createdAt / 1000, UpdatedAt: job.updatedAt / 1000 }; }
  private maintenanceList(domain: DomainRecord, input: Record<string, any>) {
    const list = [...(domain.maintenances ?? [])].reverse().filter(job => (!input.Action || job.action === input.Action) && (!input.Status || job.state === input.Status));
    const size = input.MaxResults ?? 100; if (!Number.isInteger(size) || size < 1 || size > 100) reject("MaxResults must be between 1 and 100");
    const fingerprint = createHash("sha256").update(JSON.stringify([domain.generation, input.Action, input.Status, list])).digest("hex");
    const tokens = new PaginationTokens(domain.maintenanceCursorKey ?? "empty-maintenance-history"), scope = `${domain.arn}:ListDomainMaintenances`;
    let offset = 0;
    if (input.NextToken) {
      try { const cursor = tokens.decode<{ offset: number; fingerprint: string; expires: number }>(scope, input.NextToken); if (cursor.fingerprint !== fingerprint || cursor.expires <= this.clock.now() || !Number.isInteger(cursor.offset) || cursor.offset < 1 || cursor.offset >= list.length) throw new Error(); offset = cursor.offset; }
      catch { reject("Invalid, expired or stale maintenance pagination token"); }
    }
    return { DomainMaintenances: list.slice(offset, offset + size).map(job => this.maintenanceView(domain, job)), ...(offset + size < list.length ? { NextToken: tokens.encode(scope, { offset: offset + size, fingerprint, expires: this.clock.now() + 600000 }) } : {}) };
  }
  private scheduleMaintenance(domain: DomainRecord, job: DomainMaintenance): void {
    this.enqueue(domain, async () => {
      this.storageTransitions.add(domain.generation);
      let operational = true;
      try {
        job.state = "IN_PROGRESS"; job.updatedAt = this.clock.now(); job.message = "Draining requests before reopening embedded storage"; await this.store.save();
        await this.report(domain);
        const deadline = Date.now() + 30000;
        while (this.requests.get(domain.generation)) {
          if (Date.now() >= deadline) { job.state = "TIMED_OUT"; job.message = "Active requests did not drain within 30 seconds"; job.updatedAt = this.clock.now(); await this.store.save(); return; }
          await delay(10);
        }
        operational = false;
        if (job.action === "REBOOT_NODE") await this.closeGateway(domain);
        const old = this.engines.get(domain.generation); this.engines.delete(domain.generation); old?.close();
        const encrypted = domain.config.EncryptionAtRestOptions.Enabled === true, file = join(this.directory(domain), encrypted ? "search.enc" : "search.sqlite");
        await access(file);
        const replacement = new EmbeddedSearchEngine(file, () => this.clock.now(), encrypted ? { keyFile: this.keyFile(domain) } : undefined);
        this.engines.set(domain.generation, replacement); await this.applyMaster(domain, replacement); await this.packages.restoreDomain(domain);
        if (job.action === "REBOOT_NODE") await this.bind(domain, domain.gatewayPort);
        await replacement.request("GET", "/_cluster/health", Buffer.alloc(0), "maintenance");
        operational = true;
        this.publishingMaintenance.add(job.id);
        job.state = "COMPLETED"; job.updatedAt = this.clock.now(); job.message = job.action === "REBOOT_NODE" ? "Reopened embedded storage and rebound the same HTTPS endpoint" : "Reopened embedded storage; in-memory search contexts were discarded";
        delete domain.failure; await this.store.save();
      } catch (error) {
        job.state = "FAILED"; job.updatedAt = this.clock.now(); job.message = error instanceof AwsError || error instanceof SearchError ? error.message.slice(0, 1000) : "Embedded storage or endpoint restart failed";
        if (!operational) { domain.state = "failed"; domain.failure = job.message; await this.closeGateway(domain); try { this.engines.get(domain.generation)?.close(); } finally { this.engines.delete(domain.generation); } }
        await this.store.save();
      } finally { this.storageTransitions.delete(domain.generation); this.publishingMaintenance.delete(job.id); await this.report(domain); }
    }, `${domain.generation}:maintenance:${job.id}`);
  }
  private engine(domain: DomainRecord): EmbeddedSearchEngine {
    if (this.storageTransitions.has(domain.generation)) throw new AwsError("InternalException", "The search endpoint is migrating encrypted storage; retry after configuration processing", 503);
    const engine = domain.state === "active" ? this.engines.get(domain.generation) : undefined;
    if (!engine) throw new AwsError("InternalException", "Domain search endpoint is not ready", 503);
    return engine;
  }
  private status(domain: DomainRecord): Record<string, any> {
    const change = this.pending(domain), maintenance = this.maintenance(domain);
    return { DomainId: `${domain.accountId}/${domain.name}`, DomainName: domain.name, ARN: domain.arn, Created: domain.state === "active", Deleted: domain.state === "deleting", Processing: domain.state === "creating" || domain.state === "deleting" || Boolean(change) || Boolean(maintenance) || this.storageTransitions.has(domain.generation), UpgradeProcessing: false, ...structuredClone(domain.config), ...(domain.state === "active" ? { Endpoint: `127.0.0.1:${domain.gatewayPort}` } : {}), ...(change ? { ChangeProgressDetails: this.changeDetails(change), ModifyingProperties: change.properties.map(Name => ({ Name, ActiveValue: JSON.stringify(domain.config[Name]), PendingValue: JSON.stringify(change.config[Name]), ValueType: "STRING" })) } : {}), DomainProcessingStatus: domain.state === "active" ? change || maintenance || this.storageTransitions.has(domain.generation) ? "Modifying" : "Active" : domain.state === "deleting" ? "Deleting" : domain.state === "failed" ? "Isolated" : "Creating" };
  }
  private config(domain: DomainRecord): Record<string, any> {
    const status = { CreationDate: domain.createdAt / 1000, UpdateDate: domain.updatedAt / 1000, UpdateVersion: domain.revision, State: domain.state === "active" ? "Active" : "Processing", PendingDeletion: domain.state === "deleting" };
    const change = this.pending(domain);
    return { ...Object.fromEntries(Object.entries(domain.config).map(([key, Options]) => [key, { Options: structuredClone(change?.config[key] ?? Options), Status: { ...status, ...(change?.properties.includes(key) ? { State: "Processing", UpdateVersion: change.revision } : {}) } }])), ...(change ? { ChangeProgressDetails: this.changeDetails(change) } : {}) };
  }
  private changeDetails(change: DomainChange): Record<string, any> { return { ChangeId: change.id, ConfigChangeStatus: change.state === "CANCELLED" ? "Cancelled" : change.state === "PENDING" ? "Pending" : change.state === "PROCESSING" ? "ApplyingChanges" : change.state === "COMPLETED" ? "Completed" : "ValidationFailed", InitiatedBy: "CUSTOMER", StartTime: change.startedAt / 1000, LastUpdatedTime: change.updatedAt / 1000 }; }
  private dryRunStatus(run: DomainDryRun): Record<string, any> { return { DryRunId: run.id, DryRunStatus: run.state === "COMPLETED" ? "succeeded" : "pending", CreationDate: new Date(run.createdAt).toISOString(), UpdateDate: new Date(run.updatedAt).toISOString() }; }
  diagnostics(region: string, name?: string, accountId = this.store.accountId): Record<string, any> {
    return { ...capabilities, legacyActions: Object.keys(LEGACY_ACTIONS), nativeEngine: false, status: "available", caCertificatePath: this.tls?.caCertificatePath, domains: this.domains(region, accountId).filter(domain => name === undefined || domain.name === name).map(domain => ({ name: domain.name, state: domain.state, logDeliveryFailures: structuredClone(domain.logDeliveryFailures ?? {}), ...(domain.failure ? { failure: domain.failure } : {}) })) };
  }
  async start(): Promise<void> {
    this.closing = false;
    await this.automaticBackups.start();
    await this.serverless.start();
    try {
      const securityReferences = this.all().flatMap(domain => [domain.securityMaterial?.id, ...(domain.changes ?? []).map(change => change.securityMaterial?.id)]).filter((id): id is string => Boolean(id));
      await this.materials.start(new Set([...securityReferences, ...this.packages.references()]));
    }
    catch (error) { this.materialFailure = error; }
    for (const domain of this.all()) {
      if (domain.state === "deleting") this.enqueueDeletion(domain);
      else this.enqueue(domain, () => this.activate(domain));
    }
    await Promise.all([...this.jobs.values()]);
    for (const domain of this.all()) {
      if (domain.state !== "active") continue;
      this.snapshots.resume(domain);
      const maintenance = this.maintenance(domain); if (maintenance) this.scheduleMaintenance(domain, maintenance);
      const change = this.pending(domain); if (change) this.scheduleChange(domain, change);
      for (const run of domain.dryRuns ?? []) if (run.state === "PROCESSING") this.scheduleDryRun(domain, run);
    }
    await this.packages.resume();
    await this.ingestion.start();
    await this.applications.start();
    await this.directQueries.resume();
    this.scheduleIndexManagement();
  }
  private scheduleIndexManagement(): void {
    if (this.closing) return;
    this.ismTimer = this.clock.setTimeout(() => {
      for (const domain of this.all()) if (domain.state === "active" && !this.maintenance(domain) && !this.storageTransitions.has(domain.generation)) {
        try { this.engines.get(domain.generation)?.runIndexManagement(); }
        catch { /* Storage failures fence the engine; restart recovers its durable checkpoint. */ }
      }
      this.scheduleIndexManagement();
    }, ISM_INTERVAL);
    if (typeof this.ismTimer === "object") this.ismTimer.unref?.();
  }
  async stop(): Promise<void> {
    await this.applications.stop();
    this.closing = true; if (this.ismTimer !== undefined) this.clock.clearTimeout(this.ismTimer);
    await this.automaticBackups.stop();
    await this.packages.drain();
    await this.ingestion.stop();
    this.closing = true;
    await this.snapshots.drain();
    await this.serverless.stop();
    this.closing = true; await Promise.all([...this.jobs.values()]);
    await Promise.all([...this.gateways.values()].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); })));
    this.gateways.clear();
    const failures: unknown[] = [];
    for (const engine of this.engines.values()) { try { engine.close(); } catch (error) { failures.push(error); } }
    this.engines.clear();
    if (failures.length) throw new AggregateError(failures, "OpenSearch storage checkpoint failed during shutdown");
  }
  private enqueue(domain: DomainRecord, work: () => Promise<void>, key = domain.generation): void {
    if (this.jobs.has(key)) return;
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(work).catch(async error => {
      domain.failure = error instanceof AwsError || error instanceof SearchError ? error.message : "The local storage or endpoint operation failed. Check storage permissions and the reserved endpoint port.";
      if (domain.state !== "deleting") domain.state = "failed";
      // The original persisted intent remains retryable even if failure reporting
      // also encounters a full/unavailable control-state filesystem.
      try { await this.store.save(); } catch { /* Keep the failure visible in memory. */ }
    }).finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, job);
  }
  private enqueueDeletion(domain: DomainRecord): void {
    const current = this.state(domain.region, domain.accountId).domains[domain.name];
    if (this.closing || current?.generation !== domain.generation || current.state !== "deleting") return;
    const pending = this.jobs.get(domain.generation);
    if (pending) {
      // A failed job exposes its error before its final save finishes. Keep an
      // accepted delete/retry until that job releases the generation's slot.
      void pending.then(() => this.enqueueDeletion(current));
    } else this.enqueue(current, () => this.destroy(current));
  }
  private scheduleDryRun(domain: DomainRecord, run: DomainDryRun): void {
    this.enqueue(domain, async () => {
      await delay(50);
      if (domain.state !== "active" || run.state !== "PROCESSING") return;
      run.state = "COMPLETED"; run.updatedAt = this.clock.now();
      try { await this.store.save(); } catch { run.state = "PROCESSING"; }
    }, `${domain.generation}:dry-run:${run.id}`);
  }
  private scheduleChange(domain: DomainRecord, change: DomainChange): void {
    this.enqueue(domain, async () => {
      // Queue admission is observable and cancellable; the existing engine
      // continues serving the active revision until the atomic publish below.
      await delay(100);
      await this.store.withMutationLock(`opensearch:${domain.generation}`, async () => {
        if (domain.state !== "active" || !["PENDING", "PROCESSING"].includes(change.state)) return;
        const config = domain.config, reference = domain.securityMaterial, revision = domain.revision, updatedAt = domain.updatedAt;
        try {
          change.state = "PROCESSING"; change.updatedAt = this.clock.now(); await this.store.save();
          if (!domain.config.EncryptionAtRestOptions.Enabled && change.config.EncryptionAtRestOptions.Enabled) {
            await this.migrateStorage(domain, change);
            return;
          }
          if (change.securityMaterial) await this.applyMaster(domain, this.engine(domain), change.securityMaterial);
          domain.config = change.config; domain.securityMaterial = change.securityMaterial ?? reference;
          if (change.securityMaterial && reference) domain.retiredSecurityMaterials = [...(domain.retiredSecurityMaterials ?? []), reference.id];
          domain.revision = change.revision; domain.updatedAt = this.clock.now(); change.updatedAt = domain.updatedAt; change.state = "COMPLETED";
          await this.store.save();
          if (change.securityMaterial) await this.materials.commit(change.securityMaterial.id).catch(() => undefined);
        } catch {
          if (change.encryptedReady) {
            // The durable transition marker selects encrypted storage after a
            // restart, including a crash midway through plaintext cleanup.
            domain.state = "failed"; domain.failure = "Encrypted storage migration needs a restart to finish cleanup and publish its revision";
            await this.store.save().catch(() => undefined); return;
          }
          domain.config = config; domain.securityMaterial = reference; domain.revision = revision; domain.updatedAt = updatedAt;
          change.state = "FAILED"; change.updatedAt = this.clock.now(); change.failure = "The configuration could not be published; the previous revision remains active";
          if (reference) await this.applyMaster(domain, this.engine(domain), reference).catch(() => { domain.state = "failed"; domain.failure = "Security configuration recovery requires a restart"; });
          await this.store.save().catch(() => undefined);
        }
      });
    }, `${domain.generation}:config:${change.id}`);
  }
  private async removePlainStorage(domain: DomainRecord): Promise<void> {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(join(this.directory(domain), `search.sqlite${suffix}`), { force: true });
  }
  private async migrateStorage(domain: DomainRecord, change: DomainChange): Promise<void> {
    const old = this.engines.get(domain.generation)!;
    let replacement: EmbeddedSearchEngine | undefined;
    this.storageTransitions.add(domain.generation);
    try {
      const deadline = Date.now() + 30000;
      while (this.requests.get(domain.generation)) { if (Date.now() >= deadline) throw new Error("Active requests did not drain for encryption migration"); await delay(10); }
      const file = join(this.directory(domain), "search.enc");
      for (const suffix of ["", ".head", ".journal"]) await rm(`${file}${suffix}`, { recursive: true, force: true });
      replacement = new EmbeddedSearchEngine(file, () => this.clock.now(), { keyFile: this.keyFile(domain) });
      old.copyStorageTo(replacement);
      await this.applyMaster(domain, replacement, change.securityMaterial ?? domain.securityMaterial);
      change.encryptedReady = true;
      // A failed control save can be ambiguous after atomic replacement. Keep
      // admission closed and recover from either durable revision on restart.
      await this.store.save();
      // From this durable marker onward, recovery uses the encrypted copy.
      old.close(); this.engines.set(domain.generation, replacement);
      await this.packages.restoreDomain(domain);
      await this.removePlainStorage(domain);
      const previous = domain.securityMaterial;
      domain.config = change.config; domain.securityMaterial = change.securityMaterial ?? previous;
      if (change.securityMaterial && previous) domain.retiredSecurityMaterials = [...(domain.retiredSecurityMaterials ?? []), previous.id];
      domain.revision = change.revision; domain.updatedAt = change.updatedAt = this.clock.now(); change.state = "COMPLETED";
      try { await this.store.save(); } catch (error) { change.state = "PROCESSING"; throw error; }
      if (change.securityMaterial) await this.materials.commit(change.securityMaterial.id).catch(() => undefined);
    } catch (error) {
      if (!change.encryptedReady) replacement?.close();
      else if (this.engines.get(domain.generation) !== replacement) { try { old.close(); } catch { /* Recovery owns the encrypted copy. */ } if (replacement) this.engines.set(domain.generation, replacement); }
      throw error;
    } finally { this.storageTransitions.delete(domain.generation); }
  }
  private async activate(domain: DomainRecord): Promise<void> {
    if (!this.tls) throw new AwsError("InternalException", "OpenSearch TLS is not initialized", 503);
    try {
      const transition = this.pending(domain);
      const encrypted = domain.config.EncryptionAtRestOptions.Enabled === true || transition?.encryptedReady === true;
      const file = join(this.directory(domain), encrypted ? "search.enc" : "search.sqlite");
      // Never silently replace an acknowledged resource with a new empty DB.
      if (domain.storageReady || domain.state === "active") await access(file);
      const engine = new EmbeddedSearchEngine(file, () => this.clock.now(), encrypted ? { keyFile: this.keyFile(domain) } : undefined);
      this.engines.set(domain.generation, engine);
      if (transition?.encryptedReady) {
        await this.removePlainStorage(domain);
        const previous = domain.securityMaterial;
        domain.config = transition.config; domain.securityMaterial = transition.securityMaterial ?? previous;
        if (transition.securityMaterial && previous && previous.id !== transition.securityMaterial.id) domain.retiredSecurityMaterials = [...(domain.retiredSecurityMaterials ?? []), previous.id];
        domain.revision = transition.revision; domain.updatedAt = transition.updatedAt = this.clock.now(); transition.state = "COMPLETED";
      }
      await this.applyMaster(domain, engine); await this.packages.restoreDomain(domain);
      if (!this.gateways.has(domain.generation)) await this.bind(domain, domain.gatewayPort);
      domain.storageReady = true; domain.state = "active"; delete domain.failure; await this.store.save();
      await this.report(domain);
      await this.logging.event(domain, "ES_APPLICATION_LOGS", { level: "INFO", event: "domain_activated" });
    } catch (error) {
      await this.closeGateway(domain);
      try { this.engines.get(domain.generation)?.close(); } finally { this.engines.delete(domain.generation); }
      throw error;
    }
  }
  private async bind(domain: DomainRecord, port: number): Promise<number> {
    const server = createHttpsServer({ cert: this.tls!.certificate, key: this.tls!.privateKey, minVersion: "TLSv1.2", requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => { void this.gateway(domain, req, res); });
    server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", () => { domain.failure = "The resource endpoint failed"; domain.state = "failed"; void this.store.save(); });
    this.gateways.set(domain.generation, server);
    return (server.address() as { port: number }).port;
  }
  private async reserve(domain: DomainRecord): Promise<void> {
    const retired = new Set(Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => region.opensearch?.retiredPorts ?? [])));
    const used = new Set(this.all().map(value => value.gatewayPort));
    // Binding reserves the actual lease before persisting it; it responds unavailable until ready.
    // Spread independent installations across the range so a new domain does
    // not preferentially claim another installation's endpoint during restart.
    const offset = createHash("sha256").update(this.store.root).digest().readUInt32BE(0) % 12000;
    for (let attempt = 0; attempt < 12000; attempt++) {
      const port = 48000 + (offset + attempt) % 12000;
      if (retired.has(port) || used.has(port)) continue;
      try { domain.gatewayPort = await this.bind(domain, port); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
    }
    throw new AwsError("LimitExceededException", "No free OpenSearch gateway port is available", 409);
  }
  private async closeGateway(domain: DomainRecord): Promise<void> {
    const server = this.gateways.get(domain.generation);
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    this.gateways.delete(domain.generation);
  }
  private async destroy(domain: DomainRecord): Promise<void> {
    await this.closeGateway(domain);
    await this.snapshots.drain(domain);
    await this.automaticBackups.removeDomain(domain);
    try { this.engines.get(domain.generation)?.close(); } finally { this.engines.delete(domain.generation); }
    await rm(this.directory(domain), { recursive: true, force: true });
    await rm(this.keyFile(domain), { force: true });
    for (const id of new Set([domain.securityMaterial?.id, ...(domain.changes ?? []).map(change => change.securityMaterial?.id), ...(domain.retiredSecurityMaterials ?? [])].filter((id): id is string => Boolean(id)))) await this.materials.remove(id);
    await this.packages.removeDomain(domain);
    await this.store.withMutationLock("opensearch:admission", async () => {
      const state = this.state(domain.region, domain.accountId);
      if (!state.retiredPorts.includes(domain.gatewayPort)) state.retiredPorts.push(domain.gatewayPort);
      delete state.domains[domain.name];
      try { await this.store.save(); }
      catch (error) { state.domains[domain.name] = domain; throw error; }
    });
  }
  private authorize(principal: PrincipalContext, action: string, resource: string, region: string, secure: boolean, domain?: DomainRecord, extra: Record<string, any> = {}): void {
    if (this.authMode !== "enforce") return;
    const context = { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:SecureTransport": secure, ...Object.fromEntries(Object.entries(domain?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])), ...extra };
    const caller = this.store.state.accounts[principal.accountId];
    const identity: AuthorizationResult = caller ? evaluateAuthorization(caller.iam, principal, action, resource, context) : { decision: "implicitDeny", reason: "Caller account is unavailable", matchedStatements: [] };
    const policy = domain && domainPolicy(domain);
    const result = policy ? combineIdentityAndResourceAuthorization(identity, evaluateResourcePolicy(policy, principal, action, resource, context), principal.principalType === "anonymous" ? "service" : principal.accountId === domain.accountId ? "sameAccount" : "crossAccount") : domain && principal.accountId !== domain.accountId ? { decision: "implicitDeny", reason: "Cross-account data access requires an explicit domain policy" } : identity;
    if (result.decision !== "allowed") throw new AwsError("AccessDeniedException", `User ${principal.principalArn} is not authorized to perform ${action} on ${resource}. ${result.reason}`, 403);
  }
  private target(route: OperationRoute, region: string, accountId: string): string {
    if (DISCOVERY.has(route.operation)) return "*";
    if (INSIGHT_ACTIONS.has(route.operation) && route.input.Entity?.Type === "DomainName") return domainArn(region, accountId, route.input.Entity.Value);
    return route.input.ARN ?? (route.input.DomainName ? domainArn(region, accountId, route.input.DomainName) : "*");
  }
  private async identity(req: IncomingMessage, url: URL, region: string, service = "es"): Promise<PrincipalContext> {
    await readOpenSearchBody(req);
    return this.authMode === "off" ? principalWithoutValidation(req, url, this.store, this.clock) : authenticateSigV4(req, url, this.store, this.clock, region, service);
  }
  private searchAccess(domain: DomainRecord, principal: PrincipalContext, basic?: string): SearchAccess | undefined {
    if (!domain.config.AdvancedSecurityOptions.Enabled) { if (basic) throw new SearchError("security_exception", "Basic authentication requires fine-grained security", 401); return undefined; }
    let identity: SearchIdentity;
    if (basic) {
      if (!domain.config.AdvancedSecurityOptions.InternalUserDatabaseEnabled) throw new SearchError("security_exception", "The internal user database is disabled", 401);
      identity = this.engine(domain).security.authenticate(basic);
    } else {
      if (principal.principalType === "anonymous") throw new SearchError("security_exception", "Fine-grained security requires an authenticated identity", 401);
      identity = { name: principal.roleArn ?? principal.principalArn, backendRoles: [principal.roleArn ?? principal.principalArn] };
    }
    return this.engine(domain).security.access(identity);
  }
  private principalKey(principal: PrincipalContext): string { return this.authMode === "off" && principal.principalType === "anonymous" ? "local-development" : principal.sessionArn ?? principal.principalArn; }
  private async workspaceAsset(domain: DomainRecord, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method !== "GET") return false;
    const files: Record<string, [string, string]> = {
      "/_stacksim/workspace-ui/": ["opensearch-workspace.html", "text/html"],
      "/_stacksim/workspace-ui/entry.js": ["opensearch-workspace-entry.js", "text/javascript"],
      "/_stacksim/workspace-ui/workspace.js": ["services/opensearch-workspace.js", "text/javascript"],
      "/_stacksim/workspace-ui/sigv4.js": ["sigv4.js", "text/javascript"],
      "/_stacksim/workspace-ui/styles.css": ["styles.css", "text/css"],
    };
    if (!Object.hasOwn(files, path)) return false;
    const [file, type] = files[path];
    let body = await readFile(join(process.cwd(), "web", file), "utf8");
    if (type === "text/html") body = body.replaceAll("{{REGION}}", domain.region.replace(/[&<>"']/g, "")).replaceAll("{{INTERNAL}}", String(Boolean(domain.config.AdvancedSecurityOptions.InternalUserDatabaseEnabled)));
    res.setHeader("content-type", `${type}; charset=utf-8`); res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.end(body); return true;
  }
  private dataAuthorization(domain: DomainRecord, principal: PrincipalContext, method: string, path: string, secure: boolean, req?: IncomingMessage): void {
    const pathname = path.split("?")[0];
    if (!path.startsWith("/") || /[\\]|%2f|%5c|%00|%25|\/\.|\/\//i.test(pathname)) throw new AwsError("ValidationException", "Ambiguous OpenSearch request path");
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new AwsError("ValidationException", "Unsupported HTTP method");
    this.authorize(principal, `es:ESHttp${method[0]}${method.slice(1).toLowerCase()}`, `${domain.arn}${pathname}`, domain.region, secure, domain, { "aws:SourceIp": req?.socket.remoteAddress?.replace(/^::ffff:/, ""), "aws:UserAgent": req?.headers["user-agent"] ?? "", "aws:TokenIssueTime": principal.issuedAt === undefined ? undefined : new Date(principal.issuedAt).toISOString(), "aws:SourceIdentity": principal.sourceIdentity });
  }
  private admitRequest(domain: DomainRecord): () => void {
    if (this.closing || domain.state !== "active" || this.storageTransitions.has(domain.generation)) throw new AwsError("InternalException", "Domain endpoint is not ready", 503);
    const active = this.requests.get(domain.generation) ?? 0;
    if (active >= capabilities.limits.concurrentGatewayRequestsPerDomain) throw new SearchError("rejected_execution_exception", "The local limit of 16 concurrent requests was reached", 429);
    this.requests.set(domain.generation, active + 1);
    return () => { const remaining = (this.requests.get(domain.generation) ?? 1) - 1; if (remaining) this.requests.set(domain.generation, remaining); else this.requests.delete(domain.generation); };
  }
  private async gateway(domain: DomainRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID(); res.setHeader("x-amzn-requestid", requestId);
    let release: (() => void) | undefined;
    try {
      release = this.admitRequest(domain);
      if (req.headers["x-stacksim-region"] && req.headers["x-stacksim-region"] !== domain.region) throw new AwsError("ValidationException", "Region header contradicts the domain Region");
      if (![`127.0.0.1:${domain.gatewayPort}`, `localhost:${domain.gatewayPort}`, "127.0.0.1", "localhost"].includes(String(req.headers.host))) throw new AwsError("AccessDeniedException", "Host does not match this resource endpoint", 403);
      const url = new URL(req.url!, `https://${req.headers.host}`);
      if (await this.workspaceAsset(domain, req, res, url.pathname)) return;
      const basic = req.headers.authorization?.startsWith("Basic ") ? req.headers.authorization : undefined;
      const principal: PrincipalContext = basic || this.authMode === "enforce" && !req.headers.authorization && !url.searchParams.has("X-Amz-Credential")
        ? { principalType: "anonymous" as const, accessKeyId: "", principalId: "anonymous", principalArn: "*", accountId: "" }
        : await this.identity(req, url, domain.region);
      this.dataAuthorization(domain, principal, req.method!, req.url!, true, req);
      let body = await readOpenSearchBody(req);
      if (req.headers["content-encoding"] === "gzip") {
        try { body = gunzipSync(body, { maxOutputLength: capabilities.limits.requestBytes }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new SearchError("content_too_long_exception", "Expanded request exceeds the local 10 MiB limit", 413);
          throw new SearchError("parse_exception", "Malformed gzip request body");
        }
      }
      else if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new AwsError("ValidationException", "Only gzip content encoding is supported");
      const result = await this.searchRequest(domain, principal, req.method!, req.url!, body, basic);
      res.statusCode = result.status; res.setHeader("content-type", result.contentType ?? "application/json");
      const encoded = result.contentType === "text/plain" ? String(result.body) : JSON.stringify(result.body, null, url.searchParams.has("pretty") && url.searchParams.get("pretty") !== "false" ? 2 : undefined);
      if (Buffer.byteLength(encoded ?? "") > 32 * 1024 * 1024) throw new AwsError("LimitExceededException", "Response exceeds the local 32 MiB limit", 413);
      res.end(req.method === "HEAD" ? undefined : encoded);
    } catch (error) {
      const failure = error instanceof SearchError ? error : error instanceof AwsError ? new SearchError(error.status === 403 ? "security_exception" : error.code, error.message, error.status) : new SearchError("internal_server_error", "The local search request failed", 500);
      res.statusCode = failure.status; res.setHeader("content-type", "application/json"); res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: { type: failure.type, reason: failure.message }, status: failure.status }));
    } finally {
      release?.();
      await this.report(domain, res.statusCode);
    }
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, region: string): Promise<void> {
    res.setHeader("x-amzn-requestid", randomUUID());
    const family = familyForRequest(req, url) ?? "opensearch";
    try {
      const principal = await this.identity(req, url, region, family === "opensearchserverless" ? "aoss" : family === "osis" ? "osis" : "es");
      const accountId = principal.accountId || this.store.accountId;
      const raw = await readOpenSearchBody(req); let body: Record<string, any>;
      try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { reject("Request body must contain valid JSON"); }
      const applicationRoute = /^\/_stacksim\/api\/opensearch\/applications\/([a-z0-9-]+)\/(context|workspaces|query)$/.exec(url.pathname);
      if (applicationRoute && (applicationRoute[2] === 'context' ? req.method === 'GET' : req.method === 'POST')) { const result = await this.applications.local(region, accountId, applicationRoute[1], principal, Boolean((req.socket as any).encrypted), applicationRoute[2], body); json(res, result.body, result.status); return; }
      const directQueryRoute = /^\/_stacksim\/api\/opensearch\/direct-query\/([a-z][a-z0-9_]+)\/(start|get|cancel)$/.exec(url.pathname);
      if (directQueryRoute && req.method === 'POST') { json(res, await this.directQueries.local(region, accountId, directQueryRoute[1], directQueryRoute[2], body, principal, Boolean((req.socket as any).encrypted), req.socket.remoteAddress?.replace(/^::ffff:/, ''))); return; }
      const pipelineDiagnostic = /^\/_stacksim\/api\/opensearch\/ingestion\/pipelines\/([^/]+)$/.exec(url.pathname);
      if (pipelineDiagnostic && req.method === "GET") { json(res, this.ingestion.diagnostics(region, decodeURIComponent(pipelineDiagnostic[1]), accountId, principal, Boolean((req.socket as any).encrypted))); return; }
      const pipelineIngest = /^\/_stacksim\/api\/opensearch\/ingestion\/pipelines\/([^/]+)\/ingest$/.exec(url.pathname);
      if (pipelineIngest && req.method === "POST") { this.ingestion.ingest(region, decodeURIComponent(pipelineIngest[1]), accountId, principal, Boolean((req.socket as any).encrypted), body.events); json(res, { accepted: body.events.length }); return; }
      const serverlessQuery = /^\/_stacksim\/api\/opensearch\/serverless\/collections\/([a-z0-9]+)\/query$/.exec(url.pathname);
      if (serverlessQuery && req.method === "POST") { const result = await this.serverless.localQuery(region, accountId, serverlessQuery[1], principal, Boolean((req.socket as any).encrypted), body); json(res, result.body, result.status); return; }
      if (url.pathname === "/_stacksim/api/opensearch/capabilities" && req.method === "GET") { this.authorize(principal, "es:ListDomainNames", "*", region, Boolean((req.socket as any).encrypted)); json(res, this.diagnostics(region, undefined, accountId)); return; }
      const diagnostic = /^\/_stacksim\/api\/opensearch\/domains\/([^/]+)\/capabilities$/.exec(url.pathname);
      if (diagnostic && req.method === "GET") {
        const name = decodeURIComponent(diagnostic[1]);
        this.authorize(principal, "es:DescribeDomain", domainArn(region, accountId, name), region, Boolean((req.socket as any).encrypted));
        this.domain(region, name, accountId); json(res, this.diagnostics(region, name, accountId)); return;
      }
      const local = /^\/_stacksim\/api\/opensearch\/domains\/([^/]+)\/query$/.exec(url.pathname);
      if (local && req.method === "POST") {
        const domain = this.domain(region, decodeURIComponent(local[1]), accountId);
        if (typeof body.method !== "string" || typeof body.path !== "string") reject("Query requires method and path");
        const release = this.admitRequest(domain);
        try {
        this.dataAuthorization(domain, principal, body.method, body.path, Boolean((req.socket as any).encrypted), req);
        let result;
        try { result = await this.searchRequest(domain, principal, body.method, body.path, Buffer.from(typeof body.body === "string" ? body.body : body.body === undefined ? "" : JSON.stringify(body.body)), undefined, Boolean((req.socket as any).encrypted)); }
        catch (error) { await this.report(domain, error instanceof SearchError ? error.status : 500); throw error; }
        if (Buffer.byteLength(JSON.stringify(result.body) ?? "") > capabilities.limits.responseBytes) throw new AwsError("LimitExceededException", "Response exceeds the local 32 MiB limit", 413);
        await this.report(domain, result.status); json(res, result.body, result.status); return;
        } finally { release(); }
      }
      const wire = resolveOperation(req, url, body); if (!wire) throw new AwsError("ValidationException", "Unknown OpenSearch configuration operation");
      validateInput(wire);
      if (family === 'opensearch' && this.applications.handles(wire.operation, wire.input)) { json(res, await this.applications.execute(wire.operation, wire.input, region, accountId, principal, undefined, Boolean((req.socket as any).encrypted)), wire.status); return; }
      if (family === 'opensearch' && wire.operation === 'CompareDomainConfiguration') { json(res, this.compareConfiguration(wire.input, region, accountId, principal, Boolean((req.socket as any).encrypted))); return; }
      if (family === 'opensearch' && this.directQueries.handles(wire.operation, wire.input)) { json(res, await this.directQueries.execute(wire.operation, wire.input, region, accountId, principal, Boolean((req.socket as any).encrypted)), wire.status); return; }
      if (family === "osis") {
        this.ingestion.authorizeOperation(wire.operation, wire.input, region, principal, Boolean((req.socket as any).encrypted));
        json(res, await this.ingestion.execute(wire.operation, wire.input, region, accountId), wire.status); return;
      }
      if (family === "opensearchserverless") {
        this.serverless.authorizeOperation(wire.operation, wire.input, region, principal, Boolean((req.socket as any).encrypted));
        json(res, await this.serverless.execute(wire.operation, wire.input, region, accountId, principal), wire.status, "application/x-amz-json-1.0"); return;
      }
      if (family !== "opensearch" && family !== "es") throw new AwsError("ValidationException", `${family} is not implemented by the embedded provider. See OpenSearch capabilities for dependency details.`);
      const route = modernRoute(wire);
      const resource = this.target(route, region, accountId); const secure = Boolean((req.socket as any).encrypted);
      const tagContext = { "aws:TagKeys": route.input.TagKeys ?? route.input.TagList?.map((tag: any) => tag.Key) ?? [], ...Object.fromEntries((route.input.TagList ?? []).map((tag: any) => [`aws:RequestTag/${tag.Key}`, tag.Value])) };
      const domainTags = this.domains(region, accountId).find(domain => domain.arn === resource)?.tags ?? {};
      if (route.operation !== "DescribeDomains") this.authorize(principal, `es:${wire.operation}`, resource, region, secure, undefined, { ...tagContext, ...Object.fromEntries(Object.entries(domainTags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
      if (route.operation === "DescribeDomains") for (const name of route.input.DomainNames) this.authorize(principal, `es:${wire.operation}`, domainArn(region, accountId, name), region, secure);
      if (route.operation === "CreateDomain" && route.input.TagList?.length) this.authorize(principal, "es:AddTags", resource, region, secure, undefined, tagContext);
      const result = await this.execute(route.operation, route.input, region, undefined, accountId, principal);
      json(res, family === "es" ? legacyResponse(wire.operation, result) : result, wire.status);
    } catch (error) {
      if (error instanceof SearchError) json(res, { error: { type: error.type, reason: error.message }, status: error.status }, error.status);
      else sendOpenSearchError(res, error, family);
    }
  }
  async execute(operation: string, input: Record<string, any>, region: string, owner?: string, accountId = this.store.accountId, principal?: PrincipalContext): Promise<any> {
    if (this.applications.handles(operation, input)) return this.applications.execute(operation, input, region, accountId, principal, owner);
    if (this.directQueries.handles(operation, input)) return this.directQueries.execute(operation, input, region, accountId, principal);
    if (!MANAGED_ACTIONS.has(operation)) throw new AwsError("ValidationException", `${operation} is not implemented by the embedded OpenSearch provider`);
    if (operation === 'CompareDomainConfiguration') { validateInput({ family: 'opensearch', operation, input, status: 200 }); return this.compareConfiguration(input, region, accountId, principal); }
    if (CONNECTION_ACTIONS.has(operation)) return this.connections.execute(operation, input, region, accountId);
    if (PACKAGE_ACTIONS.has(operation)) return this.packages.execute(operation, input, region, accountId, principal);
    if (INSIGHT_ACTIONS.has(operation)) return this.insights.execute(operation, input, region, accountId);
    if (input.NextToken !== undefined && operation !== "ListDomainMaintenances") reject("Invalid pagination token");
    if (input.DryRunMode && (!["Basic", "Verbose"].includes(input.DryRunMode) || input.DryRun !== true)) reject("DryRunMode requires DryRun=true and Basic or Verbose mode");
    if (operation === "ListDomainNames") return { DomainNames: this.domains(region, accountId).filter(domain => !input.EngineType || input.EngineType === "OpenSearch").map(domain => ({ DomainName: domain.name, EngineType: "OpenSearch" })) };
    if (operation === "ListVersions") return { Versions: [ENGINE_VERSION] };
    if (operation === "ListInstanceTypeDetails") { if (input.EngineVersion !== ENGINE_VERSION) reject(`Only ${ENGINE_VERSION} is supported`); if (input.DomainName) this.domain(region, input.DomainName, accountId); return { InstanceTypeDetails: input.InstanceType && input.InstanceType !== INSTANCE_TYPE ? [] : [{ InstanceType: INSTANCE_TYPE, EncryptionEnabled: true, CognitoEnabled: false, AppLogsEnabled: false, AdvancedSecurityEnabled: true, WarmEnabled: false, InstanceRole: ["data"], AvailabilityZones: [] }] }; }
    if (operation === "DescribeInstanceTypeLimits") { if (input.EngineVersion !== ENGINE_VERSION || input.InstanceType !== INSTANCE_TYPE) reject("Unsupported engine or instance profile"); return { LimitsByRole: { data: { InstanceLimits: { InstanceCountLimits: { MinimumInstanceCount: 1, MaximumInstanceCount: 1 } }, StorageTypes: [], AdditionalLimits: [] } } }; }
    if (operation === "DescribeDomains") return { DomainStatusList: input.DomainNames.map((name: string) => this.status(this.domain(region, name, accountId))) };
    if (operation === "CreateDomain") {
      const config = domainConfiguration(input); const tagList = tags(input.TagList ?? [], {}, Boolean(owner));
      if (!this.tls || this.closing) throw new AwsError("InternalException", "OpenSearch is not accepting new domains", 503);
      return this.store.withMutationLock("opensearch:admission", async () => {
        if (Object.hasOwn(this.state(region, accountId).domains, input.DomainName)) throw new AwsError("ResourceAlreadyExistsException", "A domain with this name already exists", 409);
        if (this.all().length >= 20) throw new AwsError("LimitExceededException", "The local limit of 20 domains was reached", 409);
        const domain: DomainRecord = { name: input.DomainName, arn: domainArn(region, accountId, input.DomainName), accountId, region, generation: randomUUID(), config, tags: tagList, state: "creating", createdAt: this.clock.now(), updatedAt: this.clock.now(), revision: 1, gatewayPort: 0, ...(owner ? { owner } : {}) };
        this.logging.validate(domain, config.LogPublishingOptions);
        domain.securityMaterial = await this.publishMaster(domain, input, 1);
        try { await this.reserve(domain); } catch (error) { if (domain.securityMaterial) await this.materials.abort(domain.securityMaterial.id); throw error; }
        this.state(region, accountId).domains[domain.name] = domain;
        try { await this.store.save(); } catch (error) { delete this.state(region, accountId).domains[domain.name]; const server = this.gateways.get(domain.generation)!; await new Promise<void>(resolve => server.close(() => resolve())); this.gateways.delete(domain.generation); if (domain.securityMaterial) await this.materials.abort(domain.securityMaterial.id); throw error; }
        if (domain.securityMaterial) await this.materials.commit(domain.securityMaterial.id).catch(() => undefined);
        const result = { DomainStatus: this.status(domain) }; this.enqueue(domain, () => this.activate(domain)); return result;
      });
    }
    const name = input.DomainName ?? String(input.ARN ?? "").split(":domain/")[1];
    const domain = this.domain(region, name, accountId);
    if (["CreateIndex", "GetIndex", "UpdateIndex", "DeleteIndex"].includes(operation)) {
      try { return this.engine(domain).manageIndex(operation, input.IndexName, input.IndexSchema); }
      catch (error) {
        if (error instanceof SearchError) throw new AwsError(error.type === "index_not_found_exception" ? "ResourceNotFoundException" : error.type === "resource_already_exists_exception" ? "ResourceAlreadyExistsException" : "ValidationException", error.message, ["index_not_found_exception", "resource_already_exists_exception"].includes(error.type) ? 409 : 400);
        throw error;
      }
    }
    if (input.ARN && input.ARN !== domain.arn) throw new AwsError("ResourceNotFoundException", "Domain ARN does not exist in this account and Region", 409);
    if (operation === "DescribeDomain") return { DomainStatus: this.status(domain) };
    if (operation === "DescribeDomainConfig") return { DomainConfig: this.config(domain) };
    if (operation === "ListTags") return { TagList: Object.entries(domain.tags).map(([Key, Value]) => ({ Key, Value })) };
    if (operation === "DescribeDryRunProgress") {
      const run = input.DryRunId ? domain.dryRuns?.find(run => run.id === input.DryRunId) : domain.dryRuns?.at(-1);
      if (!run) throw new AwsError("ResourceNotFoundException", "Dry run does not exist", 409);
      return { DryRunProgressStatus: this.dryRunStatus(run), DryRunResults: { DeploymentType: run.deployment, Message: "Validation of the embedded configuration completed without applying changes" }, ...(input.LoadDryRunConfig ? { DryRunConfig: { ...this.status(domain), ...structuredClone(run.config) } } : {}) };
    }
    if (operation === "DescribeDomainChangeProgress" && domain.changes?.length) {
      const change = input.ChangeId ? domain.changes.find(change => change.id === input.ChangeId) : domain.changes.at(-1);
      if (!change) throw new AwsError("ResourceNotFoundException", "Configuration change does not exist", 409);
      return { ChangeProgressStatus: { ...this.changeDetails(change), Status: change.state === "CANCELLED" ? "COMPLETED" : change.state, PendingProperties: this.pending(domain)?.id === change.id ? change.properties : [], CompletedProperties: change.state === "COMPLETED" ? change.properties : [], TotalNumberOfStages: 2, ChangeProgressStages: [{ Name: "Validation", Status: "COMPLETED", Description: "Validate supported embedded options" }, { Name: "Apply configuration", Status: change.state === "PENDING" ? "PENDING" : change.state === "PROCESSING" ? "IN_PROGRESS" : change.state === "CANCELLED" ? "COMPLETED" : change.state, Description: change.failure ?? (change.state === "CANCELLED" ? "Cancelled before applying changes" : "Publish the new configuration revision") }] } };
    }
    if (operation === "DescribeDomainChangeProgress") return { ChangeProgressStatus: { ChangeId: domain.generation, StartTime: domain.createdAt / 1000, LastUpdatedTime: domain.updatedAt / 1000, Status: domain.state === "active" ? "COMPLETED" : domain.state === "failed" ? "FAILED" : "PROCESSING", TotalNumberOfStages: 1, ChangeProgressStages: [{ Name: "Embedded search endpoint", Status: domain.state === "active" ? "COMPLETED" : domain.state === "failed" ? "FAILED" : "IN_PROGRESS", Description: domain.failure ?? "Initialize persistent storage and the resource gateway" }] } };
    if (operation === "DescribeDomainHealth") return { DomainState: domain.state === "active" && !this.maintenance(domain) ? "Active" : "Processing", AvailabilityZoneCount: "1", ActiveAvailabilityZoneCount: "1", StandByAvailabilityZoneCount: "0", DataNodeCount: domain.state === "active" ? "1" : "0", DedicatedMaster: false, MasterEligibleNodeCount: "1", ClusterHealth: domain.state === "active" && !this.maintenance(domain) && !this.storageTransitions.has(domain.generation) ? "Green" : "NotAvailable" };
    if (operation === "DescribeDomainNodes") return { DomainNodesStatusList: [{ NodeId: domain.generation, NodeType: "Data", NodeStatus: domain.state === "active" && !this.maintenance(domain) && !this.storageTransitions.has(domain.generation) ? "Active" : "NotAvailable", StorageType: "local" }] };
    if (operation === "ListDomainMaintenances") return this.maintenanceList(domain, input);
    if (operation === "GetDomainMaintenanceStatus") {
      const job = domain.maintenances?.find(job => job.id === input.MaintenanceId); if (!job) throw new AwsError("ResourceNotFoundException", "Maintenance job does not exist", 409);
      const { MaintenanceId, DomainName, ...status } = this.maintenanceView(domain, job); return status;
    }
    if (operation === "StartDomainMaintenance") return this.store.withMutationLock(`opensearch:${domain.generation}`, async () => {
      if (!["REBOOT_NODE", "RESTART_SEARCH_PROCESS"].includes(input.Action)) throw new AwsError("DisabledOperationException", "The embedded workspace has no separate Dashboard process to restart", 409);
      if (input.NodeId !== undefined && input.NodeId !== domain.generation) throw new AwsError("ResourceNotFoundException", "Node does not belong to this domain generation", 409);
      if (domain.state !== "active" || this.pending(domain) || this.maintenance(domain) || this.storageTransitions.has(domain.generation)) reject("Domain must be active with no pending configuration or maintenance operation");
      const previous = structuredClone(domain), job: DomainMaintenance = { id: randomUUID(), action: input.Action, state: "PENDING", createdAt: this.clock.now(), updatedAt: this.clock.now(), message: "Queued embedded node maintenance" };
      domain.maintenances = [...(domain.maintenances ?? []).slice(-99), job]; domain.maintenanceCursorKey ??= randomBytes(32).toString("hex");
      try { await this.store.save(); } catch (error) { Object.assign(domain, previous); if (!previous.maintenances) delete domain.maintenances; if (!previous.maintenanceCursorKey) delete domain.maintenanceCursorKey; throw error; }
      this.scheduleMaintenance(domain, job); return { MaintenanceId: job.id };
    });
    if (operation === "DeleteDomain") {
      return this.store.withMutationLock(`opensearch:${domain.generation}`, async () => {
        this.connections.assertDeletable(domain);
        if (this.maintenance(domain)) reject("Wait for domain maintenance to complete before deleting");
        if (domain.state === "creating") throw new AwsError("ValidationException", "Wait for domain creation to complete before deleting");
        if (domain.state === "deleting") { this.enqueueDeletion(domain); return { DomainStatus: this.status(domain) }; }
        const previous = structuredClone(domain);
        domain.state = "deleting"; domain.updatedAt = this.clock.now();
        try { await this.store.save(); } catch (error) { Object.assign(domain, previous); throw error; }
        const result = { DomainStatus: this.status(domain) }; this.enqueueDeletion(domain); return result;
      });
    }
    return this.store.withMutationLock(`opensearch:${domain.generation}`, async () => {
      if (domain.state === "deleting") throw new AwsError("ValidationException", "Domain is being deleted");
      const previous = structuredClone(domain);
      if (operation === "AddTags") domain.tags = tags(input.TagList, domain.tags, Boolean(owner && domain.owner === owner));
      else if (operation === "RemoveTags") { if (input.TagKeys.some((key: string) => key.toLowerCase().startsWith("aws:")) && (!owner || domain.owner !== owner)) reject("Reserved AWS tags cannot be removed"); const next = { ...domain.tags }; input.TagKeys.forEach((key: string) => delete next[key]); domain.tags = next; }
      else if (operation === "UpdateDomainConfig") {
        if (this.maintenance(domain)) reject("Wait for maintenance to complete before changing configuration");
        const config = domainConfiguration(input, domain.config);
        if (input.LogPublishingOptions) this.logging.validate(domain, config.LogPublishingOptions);
        const asynchronous = ["AdvancedSecurityOptions", "NodeToNodeEncryptionOptions", "EncryptionAtRestOptions"].some(key => JSON.stringify(config[key]) !== JSON.stringify(domain.config[key])) || Boolean(input.AdvancedSecurityOptions?.MasterUserOptions);
        const deployment = asynchronous ? "Blue/Green" : "DynamicUpdate";
        if (input.DryRun) {
          if (input.DryRunMode !== "Verbose") return { DomainConfig: this.config(domain), DryRunResults: { DeploymentType: deployment, Message: "The local update is valid; no configuration was changed" } };
          if (domain.dryRuns?.some(run => run.state === "PROCESSING")) reject("A verbose dry run is already in progress");
          const run: DomainDryRun = { id: randomUUID(), state: "PROCESSING", config, createdAt: this.clock.now(), updatedAt: this.clock.now(), deployment };
          domain.dryRuns = [...(domain.dryRuns ?? []).slice(-19), run];
          try { await this.store.save(); } catch (error) { domain.dryRuns = previous.dryRuns; throw error; }
          this.scheduleDryRun(domain, run);
          return { DomainConfig: this.config(domain), DryRunProgressStatus: this.dryRunStatus(run) };
        }
        if (domain.state !== "active") reject("Domain must be active before updating its configuration");
        if (this.pending(domain)) reject("A configuration update is already in progress");
        if (asynchronous) {
          const reference = await this.publishMaster(domain, input, domain.revision + 1);
          const change: DomainChange = { id: randomUUID(), state: "PENDING", config, properties: Object.keys(config).filter(key => JSON.stringify(config[key]) !== JSON.stringify(domain.config[key]) || key === "AdvancedSecurityOptions" && Boolean(reference)), startedAt: this.clock.now(), updatedAt: this.clock.now(), revision: domain.revision + 1, ...(reference ? { securityMaterial: reference } : {}) };
          domain.changes = [...(domain.changes ?? []).slice(-19), change];
          try { await this.store.save(); } catch (error) { domain.changes = previous.changes; if (reference) await this.materials.abort(reference.id); throw error; }
          this.scheduleChange(domain, change);
          return { DomainConfig: this.config(domain) };
        }
        domain.config = config; domain.revision++;
      } else if (operation === "CancelDomainConfigChange") {
        const change = this.pending(domain);
        if (!change || change.state !== "PENDING") reject("No cancellable configuration change is pending");
        const properties = change.properties.map(PropertyName => ({ PropertyName, CancelledValue: JSON.stringify(change.config[PropertyName]), ActiveValue: JSON.stringify(domain.config[PropertyName]) }));
        if (!input.DryRun) { change.state = "CANCELLED"; change.updatedAt = this.clock.now(); try { await this.store.save(); } catch (error) { change.state = "PENDING"; throw error; } }
        return { CancelledChangeIds: [change.id], CancelledChangeProperties: properties, DryRun: Boolean(input.DryRun) };
      }
      domain.updatedAt = this.clock.now();
      try { await this.store.save(); } catch (error) { Object.assign(domain, previous); throw error; }
      return operation === "UpdateDomainConfig" ? { DomainConfig: this.config(domain) } : {};
    });
  }
}
