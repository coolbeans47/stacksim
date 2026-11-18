import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { StateStore } from "../state.js";
import type { Clock } from "../core/clock.js";
import { AwsError } from "../errors.js";
import { authenticateSigV4, principalWithoutValidation, type PrincipalContext } from "../auth/sigv4.js";
import { evaluateAuthorization } from "../iam/evaluator.js";
import { EmbeddedSearchEngine } from "./engine.js";
import { readOpenSearchBody } from "./protocol.js";
import { SearchError, wildcard } from "./query.js";
import { matchingEncryption, parseServerlessPolicy, publicNetwork, serverlessAccess, type ServerlessPolicy } from "./serverless-policies.js";
import { aossArn, type ServerlessCollection, type ServerlessState, type ServerlessGroup } from "./serverless-model.js";
import { effectiveRetention, parseRetentionPolicy, type RetentionPolicy } from "./serverless-retention.js";
import { groupLimits, ServerlessCapacity } from "./serverless-capacity.js";
import { ServerlessIngestion, SERVERLESS_INGESTION_ACTIONS, type ServerlessIngestionHost } from './serverless-ingestion.js';
import { ServerlessStreams, SERVERLESS_STREAM_ACTIONS, type ServerlessStreamPorts } from './serverless-streams.js';
import type { S3SourcePort } from './ingestion/s3-source.js';

export const SERVERLESS_ACTIONS = new Set([
  ...SERVERLESS_INGESTION_ACTIONS, ...SERVERLESS_STREAM_ACTIONS,
  "CreateCollection", "UpdateCollection", "DeleteCollection", "BatchGetCollection", "ListCollections",
  "CreateAccessPolicy", "UpdateAccessPolicy", "DeleteAccessPolicy", "GetAccessPolicy", "ListAccessPolicies",
  "CreateSecurityPolicy", "UpdateSecurityPolicy", "DeleteSecurityPolicy", "GetSecurityPolicy", "ListSecurityPolicies",
  "CreateIndex", "UpdateIndex", "DeleteIndex", "GetIndex", "GetAccountSettings", "UpdateAccountSettings",
  "GetPoliciesStats", "TagResource", "UntagResource", "ListTagsForResource",
  "CreateCollectionGroup", "UpdateCollectionGroup", "DeleteCollectionGroup", "BatchGetCollectionGroup", "ListCollectionGroups",
  "CreateLifecyclePolicy", "UpdateLifecyclePolicy", "DeleteLifecyclePolicy", "ListLifecyclePolicies", "BatchGetLifecyclePolicy", "BatchGetEffectiveLifecyclePolicy",
]);
type Tls = { certificate: string; privateKey: string; caCertificatePath: string };
const invalid = (message: string): never => { throw new AwsError("ValidationException", message, 400); };
const missing = (message: string): never => { throw new AwsError("ResourceNotFoundException", message, 400); };
const conflict = (message: string): never => { throw new AwsError("ConflictException", message, 400); };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const writes = (operation: string) => /^(Create|Update|Delete|Tag|Untag)/.test(operation);

/** A separate AOSS catalog, encrypted data store and authorization boundary. */
export class OpenSearchServerlessService {
  private tls?: Tls;
  private closing = false;
  private readonly engines = new Map<string, EmbeddedSearchEngine>();
  private readonly gateways = new Map<string, Server>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly capacity: ServerlessCapacity;
  private retentionTimer?: ReturnType<Clock["setTimeout"]>;
  readonly ingestion: ServerlessIngestion;
  readonly streams: ServerlessStreams;
  private ingestionSource?: S3SourcePort;
  constructor(readonly store: StateStore, readonly clock: Clock, readonly authMode: "off" | "validate" | "enforce") {
    this.capacity = new ServerlessCapacity(() => clock.now());
    const ingestionHost: ServerlessIngestionHost = { state: (region, account) => this.state(region, account), collection: (region, id, account) => this.collection(region, id, account), eligible: collection => this.nextGeneration(collection) && collection.type !== 'TIMESERIES', page: (state, rows, input, scope) => this.page(state, rows, input, scope), write: async (collection, principal, index, id, document) => { const result = await this.localQuery(collection.region, collection.accountId, collection.id, principal, true, { method: 'PUT', path: `/${encodeURIComponent(index)}/_doc/${id}`, body: document }); if (result.status >= 300) throw new SearchError(result.body?.error?.type ?? 'ingestion_exception', 'The collection rejected this document', result.status); } };
    this.ingestion = new ServerlessIngestion(store, clock, ingestionHost);
    this.streams = new ServerlessStreams(store, clock, ingestionHost);
  }
  configureIngestion(source: S3SourcePort): void { this.ingestionSource = source; this.ingestion.configure(source); }
  configureStreams(ports: ServerlessStreamPorts): void { if (!this.ingestionSource) throw new Error("S3 source is not configured"); this.streams.configure(this.ingestionSource, ports); }
  configureTls(tls: Tls): void { this.tls = tls; }
  state(region: string, account = this.store.accountId): ServerlessState {
    return this.store.regionState(region, account).opensearch.serverless ??= { collections: {}, policies: {}, retiredPorts: [], capacityLimits: { maxIndexingCapacityInOCU: 10, maxSearchCapacityInOCU: 10 }, tokens: {}, cursorKey: randomBytes(32).toString("hex") };
  }
  private all(): ServerlessCollection[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.serverless?.collections ?? {}))); }
  collection(region: string, id: string, account = this.store.accountId): ServerlessCollection { const collections = this.state(region, account).collections; return Object.hasOwn(collections, id) ? collections[id] : missing("Collection does not exist in this account and Region"); }
  private directory(collection: ServerlessCollection): string {
    if (!/^[a-f0-9-]{36}$/.test(collection.generation)) throw new Error("Invalid collection generation");
    return join(this.store.root, "data", "opensearchserverless", collection.generation);
  }
  private keyFile(collection: ServerlessCollection): string { this.directory(collection); return join(this.store.root, "secrets", "opensearchserverless", `${collection.generation}.key`); }
  private nextGeneration(collection: ServerlessCollection): boolean { return Object.values(this.state(collection.region, collection.accountId).groups ?? {}).some(group => group.name === collection.collectionGroupName && group.generation === "NEXTGEN"); }
  private refreshSeconds(collection: ServerlessCollection): number { return collection.type === "VECTORSEARCH" && !this.nextGeneration(collection) ? 60 : 10; }
  private engine(collection: ServerlessCollection): EmbeddedSearchEngine {
    if (this.closing || collection.status !== "ACTIVE") throw new AwsError("ConflictException", "Collection endpoint is not active", 503);
    const engine = this.engines.get(collection.generation) ?? missing("Collection engine is unavailable");
    this.expire(collection, engine); return engine;
  }
  detail(collection: ServerlessCollection, endpoints = false): Record<string, any> {
    const { id, name, arn, status, type, description, standbyReplicas, deletionProtection, createdDate, lastModifiedDate, failureMessage } = collection;
    return { id, name, arn, status, type, description, standbyReplicas, deletionProtection, createdDate, lastModifiedDate, kmsKeyArn: "auto", ...(collection.collectionGroupName ? { collectionGroupName: collection.collectionGroupName } : {}), ...(failureMessage ? { failureCode: "LOCAL_RESOURCE_FAILURE", failureMessage } : {}), ...(endpoints && status === "ACTIVE" ? { collectionEndpoint: `https://127.0.0.1:${collection.gatewayPort}` } : {}) };
  }
  async start(): Promise<void> {
    this.closing = false;
    for (const collection of this.all()) this.enqueue(collection);
    await Promise.all(this.jobs.values());
    this.scheduleRetention();
    await this.ingestion.start(); await this.streams.start();
  }
  async stop(): Promise<void> {
    await this.ingestion.stop(); await this.streams.stop();
    this.closing = true; if (this.retentionTimer !== undefined) this.clock.clearTimeout(this.retentionTimer); this.capacity.clear(); await Promise.all(this.jobs.values());
    await Promise.all([...this.gateways.values()].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); })));
    this.gateways.clear();
    const failures: unknown[] = [];
    for (const engine of this.engines.values()) { try { engine.close(); } catch (error) { failures.push(error); } }
    this.engines.clear(); if (failures.length) throw new AggregateError(failures, "Serverless storage close failed");
  }
  private expire(collection: ServerlessCollection, engine: EmbeddedSearchEngine): void {
    if (collection.type !== "TIMESERIES") return;
    const policies = Object.values(this.state(collection.region, collection.accountId).policies).filter((policy): policy is RetentionPolicy => policy.type === "retention");
    if (policies.length) engine.expireDocuments(index => this.clock.now() - effectiveRetention(policies, `index/${collection.name}/${index}`).milliseconds);
  }
  private scheduleRetention(): void {
    if (this.closing) return;
    this.retentionTimer = this.clock.setTimeout(() => {
      for (const collection of this.all()) {
        const engine = collection.status === "ACTIVE" ? this.engines.get(collection.generation) : undefined;
        if (engine) try { this.expire(collection, engine); } catch { collection.status = "FAILED"; collection.failureMessage = "Retention storage update failed; restart to recover encrypted storage"; }
      }
      this.scheduleRetention();
    }, 60000);
    (this.retentionTimer as any)?.unref?.();
  }
  private enqueue(collection: ServerlessCollection): void {
    if (this.jobs.has(collection.generation)) return;
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(async () => { if (collection.status === 'DELETING') { await this.ingestion.removeCollection(collection); await this.streams.removeCollection(collection); } return this.store.withMutationLock(`aoss:${collection.accountId}:${collection.region}`, async () => {
      const current = this.collection(collection.region, collection.id, collection.accountId);
      if (current.status === "DELETING") await this.destroy(current); else await this.activate(current);
    }); }).catch(async () => {
      const current = this.state(collection.region, collection.accountId).collections[collection.id];
      if (!current) return;
      if (current.status !== "DELETING") current.status = "FAILED";
      current.failureMessage = "Encrypted storage or the reserved endpoint could not be opened; repair storage/port availability and restart";
      await this.store.save().catch(() => undefined);
    }).finally(() => this.jobs.delete(collection.generation));
    this.jobs.set(collection.generation, job);
  }
  private async bind(collection: ServerlessCollection, port: number): Promise<void> {
    if (!this.tls) throw new Error("Serverless TLS is not configured");
    const server = createServer({ key: this.tls.privateKey, cert: this.tls.certificate, minVersion: "TLSv1.2", maxHeaderSize: 32768, requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => { void this.gateway(collection.region, collection.accountId, collection.id, req, res); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", () => undefined); collection.gatewayPort = port; this.gateways.set(collection.generation, server);
  }
  private async reserve(collection: ServerlessCollection): Promise<void> {
    const retired = new Set(Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => region.opensearch?.serverless?.retiredPorts ?? [])));
    const used = new Set(this.all().map(value => value.gatewayPort));
    // Disjoint from the managed-domain range; retired endpoints never identify
    // another resource during this state store's lifetime.
    // Spread independent simulators across the range so creating a collection
    // does not preferentially claim another instance's endpoint during restart.
    const offset = createHash("sha256").update(this.store.root).digest().readUInt32BE(0) % 5000;
    for (let attempt = 0; attempt < 5000; attempt++) {
      const port = 60000 + (offset + attempt) % 5000;
      if (retired.has(port) || used.has(port)) continue;
      try { await this.bind(collection, port); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
    }
    throw new AwsError("ServiceQuotaExceededException", "No free Serverless endpoint port", 400);
  }
  private async closeGateway(collection: ServerlessCollection): Promise<void> {
    const server = this.gateways.get(collection.generation);
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    this.gateways.delete(collection.generation);
  }
  private async activate(collection: ServerlessCollection): Promise<void> {
    const file = join(this.directory(collection), "search.enc");
    if (collection.storageReady) { await access(file); await access(this.keyFile(collection)); }
    const engine = new EmbeddedSearchEngine(file, () => this.clock.now(), { keyFile: this.keyFile(collection) }, { refreshIntervalMs: this.refreshSeconds(collection) * 1000, catIndexAction: "indices:admin/get", appendOnly: collection.type === "TIMESERIES" || collection.type === "VECTORSEARCH" && !this.nextGeneration(collection), ingestionTimestamps: collection.type === "TIMESERIES", allowVectors: collection.type === "VECTORSEARCH" });
    try {
      if (!this.gateways.has(collection.generation)) await this.bind(collection, collection.gatewayPort);
      this.engines.set(collection.generation, engine); collection.storageReady = true; collection.status = "ACTIVE"; delete collection.failureMessage;
      collection.lastModifiedDate = this.clock.now(); await this.store.save();
    } catch (error) { this.engines.delete(collection.generation); engine.close(); await this.closeGateway(collection); throw error; }
  }
  private async destroy(collection: ServerlessCollection): Promise<void> {
    await this.closeGateway(collection);
    try { this.engines.get(collection.generation)?.close(); } finally { this.engines.delete(collection.generation); }
    await rm(this.directory(collection), { recursive: true, force: true }); await rm(this.keyFile(collection), { force: true });
    const state = this.state(collection.region, collection.accountId);
    if (!state.retiredPorts.includes(collection.gatewayPort)) state.retiredPorts.push(collection.gatewayPort);
    delete state.collections[collection.id];
    try { await this.store.save(); } catch (error) { state.collections[collection.id] = collection; throw error; }
  }
  private authorize(principal: PrincipalContext, action: string, resource: string, region: string, secure: boolean, extra: Record<string, any> = {}): void {
    if (this.authMode !== "enforce") return;
    const account = this.store.state.accounts[principal.accountId];
    const result = account && evaluateAuthorization(account.iam, principal, `aoss:${action}`, resource, { "aws:PrincipalArn": principal.roleArn ?? principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:SecureTransport": secure, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), ...extra });
    if (!result || result.decision !== "allowed") throw new AwsError("AccessDeniedException", `Not authorized for aoss:${action} on ${resource}`, 403);
  }
  authorizeOperation(operation: string, input: any, region: string, principal: PrincipalContext, secure: boolean): void {
    const account = principal.accountId || this.store.accountId, state = this.state(region, account);
    const ingestionJob = [...Object.values(state.ingestionJobs ?? {}), ...Object.values(state.ingestionStreams ?? {})].find(job => job.arn === input.resourceArn || job.id === (input.ingestionJobId ?? input.ingestionStreamId) && job.collectionId === input.collectionId);
    const collection = Object.values(state.collections).find(c => c.id === input.id || c.id === input.collectionId || c.id === ingestionJob?.collectionId || c.arn === input.resourceArn);
    const group = Object.values(state.groups ?? {}).find(g => g.id === input.id || g.arn === input.resourceArn);
    const context = { "aoss:collection": collection?.name ?? (operation === "CreateCollection" ? input.name : undefined), "aoss:CollectionId": collection?.id, "aoss:collection-group": group?.name ?? input.collectionGroupName ?? (operation === "CreateCollectionGroup" ? input.name : undefined), "aoss:DeletionProtection": input.deletionProtection?.toLowerCase(), "aws:TagKeys": input.tags?.map((tag: any) => tag.key) ?? input.tagKeys ?? [], ...Object.fromEntries((input.tags ?? []).map((tag: any) => [`aws:RequestTag/${tag.key}`, tag.value])), ...Object.fromEntries(Object.entries(ingestionJob?.tags ?? collection?.tags ?? group?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) };
    if (SERVERLESS_INGESTION_ACTIONS.has(operation) || SERVERLESS_STREAM_ACTIONS.has(operation)) {
      const arn = collection?.arn ?? aossArn(region, account, `collection/${input.collectionId}`);
      const resource = input.ingestionJobId ? `${arn}/ingestion-job/${input.ingestionJobId}` : input.ingestionStreamId ? `${arn}/ingestion-stream/${input.ingestionStreamId}` : arn;
      this.authorize(principal, operation, resource, region, secure, context);
      if (operation === 'CreateIngestionJob' && input.tags?.length) this.authorize(principal, 'TagResource', `${arn}/ingestion-job/*`, region, secure, context);
      if (operation === 'CreateIngestionStream') {
        if (input.tags?.length) this.authorize(principal, 'TagResource', `${arn}/ingestion-stream/*`, region, secure, context);
        if (this.authMode === 'enforce' && evaluateAuthorization(this.store.ensureAccount(account).iam, principal, 'iam:PassRole', input.roleArn, { 'aws:PrincipalArn': principal.roleArn ?? principal.principalArn, 'aws:PrincipalAccount': account, 'aws:SecureTransport': secure, 'aws:RequestedRegion': region, 'aws:CurrentTime': new Date(this.clock.now()).toISOString(), 'iam:PassedToService': 'aoss.amazonaws.com', 'iam:AssociatedResourceArn': `${arn}/ingestion-stream/*` }).decision !== 'allowed') throw new AwsError('AccessDeniedException', 'Not authorized to pass the ingestion role to aoss.amazonaws.com', 403);
      }
    } else if (operation === "BatchGetCollection" || operation === "BatchGetCollectionGroup") {
      const groups = operation === "BatchGetCollectionGroup", records = Object.values(groups ? state.groups ?? {} : state.collections), key = groups ? "aoss:collection-group" : "aoss:collection";
      const names = [...(input.names ?? []), ...(input.ids ?? []).map((id: string) => records.find(record => record.id === id)?.name)];
      for (const name of names.length ? names : [undefined]) this.authorize(principal, operation, "*", region, secure, { ...context, [key]: name });
    } else if (/^(Create|Update|Get|Delete)(Access|Security|Lifecycle)Policy$/.test(operation)) {
      let supplied: any; if (input.policy !== undefined) try { supplied = JSON.parse(input.policy); } catch { invalid("Policy must contain valid JSON"); }
      const previous = state.policies[`${input.type}:${input.name}`]?.policy;
      const resources = [supplied, previous].filter(Boolean).flatMap(document => (Array.isArray(document) ? document : [document]).flatMap(statement => Array.isArray(statement.Rules) ? statement.Rules.flatMap((rule: any) => Array.isArray(rule.Resource) ? rule.Resource : []) : []));
      for (const resource of resources.length ? resources : [""]) {
        const parts = String(resource).split("/");
        this.authorize(principal, operation, "*", region, secure, { ...context, "aoss:collection": parts[1], "aoss:index": parts[0] === "index" ? parts[2] : undefined });
      }
    } else {
      const scoped = ["UpdateCollection", "DeleteCollection", "UpdateCollectionGroup", "DeleteCollectionGroup", "TagResource", "UntagResource", "ListTagsForResource"].includes(operation);
      this.authorize(principal, operation, scoped ? ingestionJob?.arn ?? collection?.arn ?? group?.arn ?? input.resourceArn ?? aossArn(region, account, `${operation.includes("Group") ? "collection-group" : "collection"}/${input.id}`) : "*", region, secure, context);
    }
    if ((operation === "CreateCollection" || operation === "CreateCollectionGroup") && input.tags?.length) this.authorize(principal, "TagResource", aossArn(region, account, `${operation === "CreateCollectionGroup" ? "collection-group" : "collection"}/*`), region, secure, context);
    if (operation === "CreateCollection" && input.collectionGroupName) {
      const target = Object.values(state.groups ?? {}).find(group => group.name === input.collectionGroupName);
      this.authorize(principal, "AddCollectionToCollectionGroup", target?.arn ?? aossArn(region, account, "collection-group/*"), region, secure, { ...context, ...Object.fromEntries(Object.entries(target?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
    }
  }
  private policies(collection: ServerlessCollection): ServerlessPolicy[] { return Object.values(this.state(collection.region, collection.accountId).policies).filter((policy): policy is ServerlessPolicy => policy.type !== "retention"); }
  private network(collection: ServerlessCollection): void { if (!publicNetwork(this.policies(collection), collection.name)) throw new AwsError("AccessDeniedException", "Collection network policy denies this local public endpoint", 403); }
  private async gateway(region: string, account: string, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-amzn-requestid", randomUUID()); let release: (() => void) | undefined;
    try {
      const collection = this.collection(region, id, account); this.engine(collection);
      if (![`127.0.0.1:${collection.gatewayPort}`, `localhost:${collection.gatewayPort}`, "127.0.0.1", "localhost"].includes(String(req.headers.host))) throw new AwsError("AccessDeniedException", "Host does not match the collection", 403);
      if (req.headers["x-stacksim-region"] && req.headers["x-stacksim-region"] !== region) invalid("Region header contradicts the collection Region");
      try { this.network(collection); } catch (error) { res.setHeader("x-aoss-response-hint", "X01:network-policy-deny"); throw error; }
      const url = new URL(req.url!, `https://${req.headers.host}`);
      release = this.admit(collection, req.method!, url.pathname);
      const raw = await readOpenSearchBody(req);
      const principal = this.authMode === "off" ? principalWithoutValidation(req, url, this.store, this.clock) : await authenticateSigV4(req, url, this.store, this.clock, region, "aoss");
      this.authorize(principal, "APIAccessAll", collection.arn, region, true, { "aoss:collection": collection.name, "aoss:CollectionId": collection.id, ...Object.fromEntries(Object.entries(collection.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
      let body = raw;
      if (req.headers["content-encoding"] === "gzip") { try { body = gunzipSync(raw, { maxOutputLength: 10 * 1024 * 1024 }); } catch { throw new SearchError("parse_exception", "Malformed or oversized gzip request", 400); } }
      else if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") invalid("Only gzip content encoding is supported");
      const result = await this.query(collection, principal, req.method!, req.url!, body);
      const encoded = result.contentType === "text/plain" ? String(result.body) : JSON.stringify(result.body);
      if (Buffer.byteLength(encoded ?? "") > 32 * 1024 * 1024) throw new SearchError("content_too_long_exception", "Response exceeds 32 MiB", 413);
      res.statusCode = result.status; res.setHeader("content-type", result.contentType ?? "application/json"); res.end(req.method === "HEAD" ? undefined : encoded);
    } catch (error) {
      const status = error instanceof AwsError || error instanceof SearchError ? error.status : 500;
      if (status === 403 && !res.hasHeader("x-aoss-response-hint")) res.setHeader("x-aoss-response-hint", "X02:authorization-deny");
      res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: { type: error instanceof SearchError ? error.type : error instanceof AwsError ? error.code : "internal_server_error", reason: error instanceof AwsError || error instanceof SearchError ? error.message : "Local Serverless request failed" }, status }));
    } finally { release?.(); }
  }
  private admit(collection: ServerlessCollection, method: string, path: string): () => void {
    const kind = method === "GET" || method === "HEAD" || /\/(?:_search|_msearch|_count|_field_caps)(?:\/|$)/.test(path) ? "read" : "write";
    const state = this.state(collection.region, collection.accountId), group = collection.collectionGroupName ? Object.values(state.groups ?? {}).find(group => group.name === collection.collectionGroupName) : undefined;
    if (collection.collectionGroupName && !group) throw new SearchError("unavailable_shards_exception", "Collection group is unavailable", 503);
    const limits = group?.capacityLimits ?? { ...state.capacityLimits, minIndexingCapacityInOCU: 0, minSearchCapacityInOCU: 0 };
    return this.capacity.admit(group ? group.arn : `${collection.accountId}:${collection.region}`, limits, kind, group?.generation);
  }
  private async query(collection: ServerlessCollection, principal: PrincipalContext, method: string, path: string, body: Buffer) {
    const url = new URL(path, "https://localhost"), parts = url.pathname.split("/").filter(Boolean), action = parts[0]?.startsWith("_") ? parts[0] : parts[1];
    if (!path.startsWith("/") || path.startsWith("//") || url.pathname !== path.split("?")[0] || /[\\]|%2f|%5c|%00|%25|\/\.|\/\//i.test(url.pathname)) invalid("Ambiguous collection request path");
    if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method)) invalid("Unsupported collection HTTP method");
    const allowed = [undefined, "_search", "_msearch", "_mget", "_count", "_doc", "_source", "_create", "_update", "_bulk", "_mapping", "_settings", "_field_caps", "_analyze", "_explain", "_validate", "_cat"];
    if (!allowed.includes(action) || action === "_search" && parts.includes("scroll") || action === "_cat" && parts[1] !== "indices") invalid("This API is not in the embedded Serverless data-plane allowlist");
    if (url.searchParams.has("refresh") || url.searchParams.has("scroll")) invalid(`Serverless refresh and scroll parameters are unavailable; search refreshes every ${this.refreshSeconds(collection)} seconds`);
    if (method === "PUT" && (!action || action === "_settings")) this.validateIndexSettings(body.length ? JSON.parse(body.toString("utf8")) : {}, action === "_settings");
    const identity = principal.roleArn ?? principal.principalArn;
    const result = await this.engine(collection).request(method, path, body, principal.sessionArn ?? identity, true, serverlessAccess(this.policies(collection), collection.name, identity));
    if (action === "_cat" && result.status === 200) {
      // AOSS does not expose cluster health/status through CAT indices.
      if (Array.isArray(result.body)) result.body = result.body.map(({ health, status, ...row }: any) => row);
      else if (typeof result.body === "string") result.body = result.body.split("\n").map(line => line.split(" ").slice(2).join(" ")).join("\n");
    }
    return result;
  }
  async localQuery(region: string, account: string, id: string, principal: PrincipalContext, secure: boolean, input: any, sourceService?: 'application.opensearchservice.amazonaws.com') {
    if (typeof input.method !== "string" || typeof input.path !== "string") invalid("Query requires method and path");
    const collection = this.collection(region, id, account); this.engine(collection);
    if (!publicNetwork(this.policies(collection), collection.name, 'collection', sourceService)) throw new AwsError('AccessDeniedException', 'Collection network policy denies this request', 403);
    this.authorize(principal, "APIAccessAll", collection.arn, region, secure, { "aoss:collection": collection.name, "aoss:CollectionId": id, ...Object.fromEntries(Object.entries(collection.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
    const release = this.admit(collection, input.method, input.path);
    try {
      const result = await this.query(collection, principal, input.method, input.path, Buffer.from(typeof input.body === "string" ? input.body : input.body === undefined ? "" : JSON.stringify(input.body)));
      if (Buffer.byteLength(JSON.stringify(result.body) ?? "") > 32 * 1024 * 1024) throw new SearchError("content_too_long_exception", "Response exceeds 32 MiB", 413);
      return result;
    } finally { release(); }
  }
  ingestionSink(host: string, region: string, account: string) {
    const collection = Object.values(this.state(region, account).collections).find(collection => host === `https://127.0.0.1:${collection.gatewayPort}`);
    if (!collection) return invalid("Sink must name a current same-account Serverless collection endpoint");
    return { arn: collection.arn, generatedIdsOnly: collection.type === "TIMESERIES" || collection.type === "VECTORSEARCH" && !this.nextGeneration(collection), collection };
  }
  async deliverIngestion(host: string, region: string, account: string, principal: PrincipalContext, method: string, path: string, body: Record<string, any>): Promise<void> {
    const { collection } = this.ingestionSink(host, region, account);
    this.authorizeOperation("BatchGetCollection", { ids: [collection.id] }, region, principal, true);
    const result = await this.localQuery(region, account, collection.id, principal, true, { method, path, body });
    if (result.status >= 300) throw new SearchError("ingestion_delivery_exception", "The Serverless sink rejected the event", result.status);
  }
  private validateIndexSettings(schema: any, settingsOnly = false): void {
    const settings = settingsOnly ? schema : schema.settings;
    if (settings && (settings.refresh_interval !== undefined || settings["index.refresh_interval"] !== undefined || settings.index?.refresh_interval !== undefined)) invalid("Serverless refresh interval is service-managed");
    if (schema.aliases && Object.keys(schema.aliases).length) invalid("Serverless alias administration is not implemented");
  }
  private page<T extends { name?: string; id?: string }>(state: ServerlessState, items: T[], input: any, scope: string): { items: T[]; nextToken?: string } {
    const sorted = [...items].sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id))), signature = hash(/^ingestion-(jobs|streams):/.test(scope) ? sorted.map(item => ({ id: item.id, name: item.name })) : sorted), count = input.maxResults ?? 20;
    let offset = 0;
    if (input.nextToken) {
      try {
        const parts = input.nextToken.split('.'); if (parts.length !== 2) throw new Error();
        const [encoded, mac] = parts, expected = createHmac("sha256", state.cursorKey).update(encoded).digest(), actual = Buffer.from(mac, "base64url");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const token = JSON.parse(Buffer.from(encoded, "base64url").toString());
        if (token.scope !== scope || token.signature !== signature || token.expires < this.clock.now() || !Number.isSafeInteger(token.offset) || token.offset < 0) throw new Error();
        offset = token.offset;
      } catch { invalid("Invalid, expired or stale pagination token"); }
    }
    const page = sorted.slice(offset, offset + count);
    if (offset + count >= sorted.length) return { items: page };
    const encoded = Buffer.from(JSON.stringify({ scope, signature, offset: offset + count, expires: this.clock.now() + 900000 })).toString("base64url");
    return { items: page, nextToken: `${encoded}.${createHmac("sha256", state.cursorKey).update(encoded).digest("base64url")}` };
  }
  async execute(operation: string, input: any, region: string, account = this.store.accountId, principal?: PrincipalContext, owner?: string): Promise<Record<string, any>> {
    if (!SERVERLESS_ACTIONS.has(operation)) invalid(`${operation} is not yet implemented by the embedded Serverless provider`);
    if (principal) this.authorizeOperation(operation, input, region, principal, true);
    if (SERVERLESS_STREAM_ACTIONS.has(operation)) return this.streams.execute(operation, input, this.collection(region, input.collectionId, account));
    if (SERVERLESS_INGESTION_ACTIONS.has(operation)) return this.ingestion.execute(operation, input, this.collection(region, input.collectionId, account), principal);
    const ingestionJob = [...Object.values(this.state(region, account).ingestionJobs ?? {}), ...Object.values(this.state(region, account).ingestionStreams ?? {})].find(job => job.arn === input.resourceArn);
    if (ingestionJob && ['TagResource', 'UntagResource', 'ListTagsForResource'].includes(operation)) return this.store.withMutationLock(`aoss:${account}:${region}`, async () => {
      const job = (this.state(region, account).ingestionJobs?.[ingestionJob.id] ?? this.state(region, account).ingestionStreams?.[ingestionJob.id]); if (!job) return missing('Ingestion job does not exist');
      if (operation === 'ListTagsForResource') return { tags: Object.entries(job.tags).map(([key, value]) => ({ key, value })) };
      const previous = structuredClone(job.tags);
      if (operation === 'TagResource') job.tags = this.tags(input.tags, job.tags);
      else { if (input.tagKeys.some((key: string) => key.toLowerCase().startsWith('aws:'))) invalid('Reserved tags cannot be removed'); for (const key of input.tagKeys) delete job.tags[key]; }
      try { await this.store.save(); } catch (error) { job.tags = previous; throw error; } return {};
    });
    if (operation.endsWith("Index")) return this.indexOperation(operation, input, region, account, principal);
    return this.store.withMutationLock(`aoss:${account}:${region}`, async () => {
      const state = this.state(region, account), before = structuredClone(state), now = this.clock.now();
      const tokenKey = input.clientToken ? hash([operation, input.clientToken]) : undefined;
      const { clientToken, ...payload } = input, fingerprint = hash(canonical(payload));
      if (tokenKey && state.tokens[tokenKey]?.expires > now) {
        if (state.tokens[tokenKey].fingerprint !== fingerprint) conflict("Client token was already used with different parameters");
        return structuredClone(state.tokens[tokenKey].response);
      }
      const pending: ServerlessCollection[] = [];
      try {
        const result = await this.operation(operation, input, region, account, pending, owner);
        if (writes(operation)) {
          for (const [key, token] of Object.entries(state.tokens)) if (token.expires <= now) delete state.tokens[key];
          if (tokenKey) {
            if (Object.keys(state.tokens).length >= 1000) throw new AwsError("ServiceQuotaExceededException", "Local idempotency capacity reached; retry after token expiry", 400);
            state.tokens[tokenKey] = { fingerprint, response: structuredClone(result), expires: now + 86400000 };
          }
          await this.store.save();
        }
        pending.forEach(collection => this.enqueue(collection)); return result;
      } catch (error) {
        for (const collection of pending) if (!before.collections[collection.id]) await this.closeGateway(collection);
        for (const key of Object.keys(state)) if (!Object.hasOwn(before, key)) delete (state as any)[key];
        Object.assign(state, before); throw error;
      }
    });
  }
  private async indexOperation(operation: string, input: any, region: string, account: string, principal?: PrincipalContext): Promise<Record<string, any>> {
    const collection = this.collection(region, input.id, account);
    if (!principal) throw new AwsError("AccessDeniedException", "Index operations require an execution identity", 403);
    this.authorize(principal, "APIAccessAll", collection.arn, region, true, { "aoss:collection": collection.name, "aoss:CollectionId": collection.id, ...Object.fromEntries(Object.entries(collection.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
    const actions: Record<string, string> = { CreateIndex: "indices:admin/create", UpdateIndex: "indices:admin/mapping/put", GetIndex: "indices:admin/get", DeleteIndex: "indices:admin/delete" };
    serverlessAccess(this.policies(collection), collection.name, principal.roleArn ?? principal.principalArn).index(input.indexName, actions[operation]);
    if (input.indexSchema) this.validateIndexSettings(input.indexSchema);
    try { const result = this.engine(collection).manageIndex(operation, input.indexName, input.indexSchema ?? {}); return operation === "GetIndex" ? { indexSchema: result.IndexSchema } : {}; }
    catch (error) { if (error instanceof SearchError) throw new AwsError(error.status === 404 ? "ResourceNotFoundException" : error.type === "resource_already_exists_exception" ? "ConflictException" : "ValidationException", error.message, 400); throw error; }
  }
  collectionForEndpoint(region: string, account: string, endpoint: string): ServerlessCollection {
    // Resolve only an owned catalog endpoint; never send caller-selected URLs
    // over the network from a CloudFormation provider.
    return Object.values(this.state(region, account).collections).find(collection => endpoint === `https://127.0.0.1:${collection.gatewayPort}`) ?? missing("Endpoint does not identify a collection in this account and Region");
  }
  async ownedIndex(operation: "create" | "read" | "update" | "delete" | "retain", collection: ServerlessCollection, name: string, owner: string, principal: PrincipalContext, schema?: any, endpointBased = false): Promise<Record<string, any>> {
    const request = { id: collection.id, indexName: name };
    const action = operation === "retain" ? "GetIndex" : `${operation === "read" ? "Get" : operation[0].toUpperCase() + operation.slice(1)}Index`;
    if (!endpointBased) this.authorizeOperation(action, request, collection.region, principal, true);
    this.authorize(principal, "APIAccessAll", collection.arn, collection.region, true, { "aoss:collection": collection.name, "aoss:CollectionId": collection.id, ...Object.fromEntries(Object.entries(collection.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
    if (endpointBased) this.network(collection);
    const permission = ({ create: "indices:admin/create", read: "indices:admin/get", update: "indices:admin/mapping/put", delete: "indices:admin/delete", retain: "indices:admin/get" })[operation];
    serverlessAccess(this.policies(collection), collection.name, principal.roleArn ?? principal.principalArn).index(name, permission);
    if (schema) this.validateIndexSettings(schema);
    return this.engine(collection).ownedIndex(operation, name, owner, schema);
  }
  private tags(input: any[], current: Record<string, string> = {}, owner?: string): Record<string, string> {
    const result = { ...current };
    for (const tag of input) { if (tag.key.toLowerCase().startsWith("aws:") && !owner) invalid("Reserved AWS tags cannot be set"); Object.defineProperty(result, tag.key, { value: tag.value, enumerable: true, configurable: true, writable: true }); }
    if (Object.keys(result).length > 50) throw new AwsError("ServiceQuotaExceededException", "Collections support at most 50 tags", 400);
    return result;
  }
  private groupDetail(group: ServerlessGroup, state: ServerlessState, detail = false): Record<string, any> {
    const { owner, tags, lastModifiedDate, ...value } = group;
    return { ...value, tags: Object.entries(tags).map(([key, value]) => ({ key, value })), ...(detail ? { numberOfCollections: Object.values(state.collections).filter(collection => collection.collectionGroupName === group.name).length, currentCapacity: this.capacity.current(group.arn, group.capacityLimits) } : {}) };
  }
  private async operation(operation: string, input: any, region: string, account: string, pending: ServerlessCollection[], owner?: string): Promise<Record<string, any>> {
    const state = this.state(region, account), now = this.clock.now();
    if (operation.includes("CollectionGroup")) {
      const groups = state.groups ??= {};
      if (operation === "ListCollectionGroups") { const page = this.page(state, Object.values(groups), input, hash([operation, region, account])); return { collectionGroupSummaries: page.items.map(group => { const { standbyReplicas, tags, description, currentCapacity, ...summary } = this.groupDetail(group, state, true); return summary; }), ...(page.nextToken ? { nextToken: page.nextToken } : {}) }; }
      if (operation === "BatchGetCollectionGroup") {
        if (Boolean(input.ids?.length) === Boolean(input.names?.length)) invalid("Specify exactly one nonempty list of ids or names");
        const field = input.ids ? "id" : "name", found: any[] = [], errors: any[] = [];
        for (const value of input.ids ?? input.names) { const group = Object.values(groups).find(group => group[field] === value); if (group) found.push(this.groupDetail(group, state, true)); else errors.push({ [field]: value, errorCode: "RESOURCE_NOT_FOUND", errorMessage: "Collection group not found" }); }
        return { collectionGroupDetails: found, collectionGroupErrorDetails: errors };
      }
      if (operation === "CreateCollectionGroup") {
        if (Object.values(groups).some(group => group.name === input.name)) conflict("Collection group name already exists");
        if (Object.keys(groups).length >= 20) throw new AwsError("ServiceQuotaExceededException", "Local limit of 20 groups per account/Region reached", 400);
        const generation = input.generation ?? "CLASSIC", id = randomBytes(10).toString("hex");
        const group: ServerlessGroup = { id, arn: aossArn(region, account, `collection-group/${id}`), name: input.name, description: input.description ?? "", generation, standbyReplicas: input.standbyReplicas, capacityLimits: groupLimits(generation, input.capacityLimits), tags: this.tags(input.tags ?? [], {}, owner), createdDate: now, lastModifiedDate: now, ...(owner ? { owner } : {}) };
        groups[id] = group; return { createCollectionGroupDetail: this.groupDetail(group, state) };
      }
      const group = Object.hasOwn(groups, input.id) ? groups[input.id] : missing("Collection group not found");
      if (operation === "DeleteCollectionGroup") { if (Object.values(state.collections).some(collection => collection.collectionGroupName === group.name)) conflict("Delete member collections before deleting their group"); delete groups[group.id]; this.capacity.remove(group.arn); return {}; }
      group.capacityLimits = groupLimits(group.generation, input.capacityLimits, group.capacityLimits);
      if (input.description !== undefined) group.description = input.description;
      group.lastModifiedDate = now; const { standbyReplicas, tags, ...detail } = this.groupDetail(group, state); return { updateCollectionGroupDetail: { ...detail, lastModifiedDate: now } };
    }
    if (operation === "GetAccountSettings" || operation === "UpdateAccountSettings") {
      if (operation === "UpdateAccountSettings") state.capacityLimits = { ...state.capacityLimits, ...input.capacityLimits };
      return { accountSettingsDetail: { capacityLimits: { ...state.capacityLimits } } };
    }
    if (operation === "GetPoliciesStats") {
      const count = (type: string) => Object.values(state.policies).filter(p => p.type === type).length;
      return { AccessPolicyStats: { DataPolicyCount: count("data") }, SecurityPolicyStats: { EncryptionPolicyCount: count("encryption"), NetworkPolicyCount: count("network") }, SecurityConfigStats: { SamlConfigCount: 0 }, LifecyclePolicyStats: { RetentionPolicyCount: count("retention") }, TotalPolicyCount: Object.keys(state.policies).length };
    }
    if (operation === "BatchGetLifecyclePolicy") {
      const found: any[] = [], errors: any[] = [];
      for (const item of input.identifiers) { const policy = state.policies[`${item.type}:${item.name}`]; if (policy) found.push(structuredClone(policy)); else errors.push({ ...item, errorCode: "RESOURCE_NOT_FOUND", errorMessage: "Lifecycle policy not found" }); }
      return { lifecyclePolicyDetails: found, lifecyclePolicyErrorDetails: errors };
    }
    if (operation === "BatchGetEffectiveLifecyclePolicy") {
      const found: any[] = [], errors: any[] = [], policies = Object.values(state.policies).filter((policy): policy is RetentionPolicy => policy.type === "retention");
      for (const item of input.resourceIdentifiers) {
        const parts = item.resource.split("/"), collection = Object.values(state.collections).find(collection => collection.name === parts[1]);
        if (parts.length !== 3 || parts[0] !== "index" || !collection || collection.type !== "TIMESERIES") { errors.push({ ...item, errorCode: "RESOURCE_NOT_FOUND", errorMessage: "A time-series index resource is required" }); continue; }
        const { milliseconds, ...effective } = effectiveRetention(policies, item.resource); found.push({ type: "retention", resource: item.resource, resourceType: "index", ...effective });
      }
      return { effectiveLifecyclePolicyDetails: found, effectiveLifecyclePolicyErrorDetails: errors };
    }
    if (/(AccessPolic|SecurityPolic|LifecyclePolic)/.test(operation)) {
      const kind = operation.includes("Access") ? "access" : operation.includes("Lifecycle") ? "lifecycle" : "security", key = `${input.type}:${input.name}`;
      const collection = Object.values(state.policies).filter(policy => policy.type === input.type);
      if (operation.startsWith("List")) {
        const resources = input.resources ?? input.resource;
        const filtered = collection.filter(policy => !resources?.length || (Array.isArray(policy.policy) ? policy.policy : [policy.policy]).some((statement: any) => statement.Rules.some((rule: any) => rule.Resource.some((pattern: string) => resources.some((resource: string) => wildcard(pattern, resource))))));
        const page = this.page(state, filtered, input, hash([operation, region, account, input.type, resources ?? []]));
        return { [`${kind}PolicySummaries`]: page.items.map(({ policy, ...summary }) => summary), ...(page.nextToken ? { nextToken: page.nextToken } : {}) };
      }
      const existing = state.policies[key];
      if (operation.startsWith("Create") && existing) conflict("Policy already exists");
      if (!operation.startsWith("Create") && !existing) missing("Policy does not exist");
      if (operation.startsWith("Get")) return { [`${kind}PolicyDetail`]: structuredClone(existing) };
      if (operation.startsWith("Delete")) { delete state.policies[key]; if (state.policyOwners) delete state.policyOwners[key]; return {}; }
      if (operation.startsWith("Update") && input.policyVersion !== existing.policyVersion) conflict("Policy version is stale");
      if (!existing && Object.keys(state.policies).length >= 100) throw new AwsError("ServiceQuotaExceededException", "Local limit of 100 Serverless policies reached", 400);
      const document = input.policy === undefined ? existing.policy : input.type === "retention" ? parseRetentionPolicy(input.policy) : parseServerlessPolicy(input.type, input.policy);
      if (input.type === "encryption" || input.type === "retention") {
        const patterns = new Set(document.Rules.flatMap((rule: any) => rule.Resource));
        if (collection.some(policy => policy.name !== input.name && policy.policy.Rules.some((rule: any) => rule.Resource.some((pattern: string) => patterns.has(pattern))))) conflict("A resource pattern is already assigned by another policy of this type");
      }
      const policy: ServerlessPolicy | RetentionPolicy = { type: input.type, name: input.name, policy: document, policyVersion: randomBytes(16).toString("base64"), description: input.description ?? existing?.description, createdDate: existing?.createdDate ?? now, lastModifiedDate: now };
      state.policies[key] = policy; if (owner && !existing) (state.policyOwners ??= {})[key] = owner; return { [`${kind}PolicyDetail`]: structuredClone(policy) };
    }
    if (operation === "CreateCollection") {
      if (Object.values(state.collections).some(collection => collection.name === input.name)) conflict("Collection name already exists");
      if (Object.keys(state.collections).length >= 20) throw new AwsError("ServiceQuotaExceededException", "Local limit of 20 collections per account/Region reached", 400);
      if (input.vectorOptions) invalid("Vector acceleration is not implemented; vector collections use bounded exact search");
      const group = input.collectionGroupName ? Object.values(state.groups ?? {}).find(group => group.name === input.collectionGroupName) ?? missing("Collection group not found") : undefined;
      if ((!group || group.generation === "CLASSIC") && (!/^[a-z][a-z0-9-]{2,31}$/.test(input.name))) invalid("Classic collection names require 3–32 lowercase letters, digits or hyphens and must start with a letter");
      if (group && Object.values(state.collections).some(collection => collection.collectionGroupName === group.name && collection.type !== (input.type ?? "TIMESERIES"))) invalid("The embedded collection group supports one collection type; choose a matching or empty group");
      if (group && input.standbyReplicas && input.standbyReplicas !== group.standbyReplicas) invalid("Collection standby replicas must match its group");
      if (input.encryptionConfig && (input.encryptionConfig.aWSOwnedKey !== true || input.encryptionConfig.kmsKeyArn !== undefined)) invalid("Only resource-owned encryption is implemented");
      const encryption = matchingEncryption(Object.values(state.policies).filter((policy): policy is ServerlessPolicy => policy.type !== "retention"), input.name);
      if (!encryption && !input.encryptionConfig) invalid("No encryption policy matches the collection name");
      const id = randomBytes(11).toString("hex").slice(0, 20);
      const collection: ServerlessCollection = { id, name: input.name, arn: aossArn(region, account, `collection/${id}`), accountId: account, region, generation: randomUUID(), gatewayPort: 0, status: "CREATING", type: input.type ?? "TIMESERIES", ...(group ? { collectionGroupName: group.name } : {}), description: input.description ?? "", standbyReplicas: group?.standbyReplicas ?? input.standbyReplicas ?? "ENABLED", deletionProtection: input.deletionProtection ?? "DISABLED", encryptionPolicy: encryption?.name, ...(input.encryptionConfig ? { encryptionConfig: { aWSOwnedKey: true as const } } : {}), createdDate: now, lastModifiedDate: now, tags: this.tags(input.tags ?? [], {}, owner), ...(owner ? { owner } : {}) };
      await this.reserve(collection); state.collections[id] = collection; pending.push(collection); return { createCollectionDetail: this.detail(collection) };
    }
    if (operation === "ListCollections") {
      const filtered = Object.values(state.collections).filter(collection => Object.entries(input.collectionFilters ?? {}).every(([key, value]) => (collection as any)[key] === value));
      const page = this.page(state, filtered, input, hash([operation, region, account, input.collectionFilters ?? {}]));
      return { collectionSummaries: page.items.map(({ id, name, status, arn, collectionGroupName }) => ({ id, name, status, arn, kmsKeyArn: "auto", ...(collectionGroupName ? { collectionGroupName } : {}) })), ...(page.nextToken ? { nextToken: page.nextToken } : {}) };
    }
    if (operation === "BatchGetCollection") {
      if (Boolean(input.ids?.length) === Boolean(input.names?.length)) invalid("Specify exactly one nonempty list of ids or names");
      const field = input.ids ? "id" : "name", values = input.ids ?? input.names;
      const found: any[] = [], errors: any[] = [];
      for (const value of values) { const collection = Object.values(state.collections).find(item => item[field] === value); if (collection) found.push(this.detail(collection, true)); else errors.push({ [field]: value, errorCode: "RESOURCE_NOT_FOUND", errorMessage: "Collection not found" }); }
      return { collectionDetails: found, collectionErrorDetails: errors };
    }
    const taggedGroup = input.resourceArn && Object.values(state.groups ?? {}).find(group => group.arn === input.resourceArn);
    if (taggedGroup) {
      if (operation === "ListTagsForResource") return { tags: Object.entries(taggedGroup.tags).map(([key, value]) => ({ key, value })) };
      if (operation === "TagResource") taggedGroup.tags = this.tags(input.tags, taggedGroup.tags, owner && taggedGroup.owner === owner ? owner : undefined);
      else if (operation === "UntagResource") for (const key of input.tagKeys) { if (key.toLowerCase().startsWith("aws:") && (!owner || taggedGroup.owner !== owner)) invalid("Reserved AWS tags cannot be removed"); delete taggedGroup.tags[key]; }
      return {};
    }
    const collection = input.id ? this.collection(region, input.id, account) : Object.values(state.collections).find(item => item.arn === input.resourceArn) ?? missing("Collection not found");
    if (operation === "ListTagsForResource") return { tags: Object.entries(collection.tags).map(([key, value]) => ({ key, value })) };
    if (operation === "DeleteCollection") {
      if (collection.deletionProtection === "ENABLED") conflict("Disable deletion protection before deleting the collection");
      if (collection.status === "CREATING") conflict("Collection is still being created");
      collection.status = "DELETING"; collection.lastModifiedDate = now; pending.push(collection); return { deleteCollectionDetail: { id: collection.id, name: collection.name, status: collection.status } };
    }
    if (collection.status !== "ACTIVE") conflict("Collection must be active before updating");
    if (operation === "UpdateCollection") {
      if (input.vectorOptions || input.encryptionConfig) invalid("Vector acceleration and encryption-key changes are not implemented");
      if (input.description !== undefined) collection.description = input.description;
      if (input.deletionProtection !== undefined) collection.deletionProtection = input.deletionProtection;
      collection.lastModifiedDate = now; return { updateCollectionDetail: this.detail(collection) };
    }
    if (operation === "TagResource") collection.tags = this.tags(input.tags, collection.tags, owner && collection.owner === owner ? owner : undefined);
    else if (operation === "UntagResource") { for (const key of input.tagKeys) { if (key.toLowerCase().startsWith("aws:") && (!owner || collection.owner !== owner)) invalid("Reserved AWS tags cannot be removed"); delete collection.tags[key]; } }
    return {};
  }
}
