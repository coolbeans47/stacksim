import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { StateStore } from "../../state.js";
import type { Clock } from "../../core/clock.js";
import { AwsError } from "../../errors.js";
import { authenticateSigV4, principalWithoutValidation, type PrincipalContext } from "../../auth/sigv4.js";
import { evaluateAuthorization } from "../../iam/evaluator.js";
import { readOpenSearchBody } from "../protocol.js";
import { SearchError } from "../query.js";
import { parseIngestionConfig, renderIngestionFormat, transformIngestionEvent, type IngestionConfig } from "./config.js";
import { IngestionBuffer, type BufferedEvent } from "./buffer.js";
import { pipelineArn, type IngestionState, type PipelineRecord, type PipelineLogOptions } from "./model.js";
import { DYNAMO_EXPORT_BLUEPRINT, DYNAMO_EXPORT_BLUEPRINT_CONFIG, DYNAMO_EXPORT_BLUEPRINT_YAML, DYNAMO_BLUEPRINT, DYNAMO_BLUEPRINT_CONFIG, DYNAMO_BLUEPRINT_YAML, HTTP_BLUEPRINT, HTTP_BLUEPRINT_CONFIG, HTTP_BLUEPRINT_YAML, S3_BLUEPRINT, S3_BLUEPRINT_CONFIG, S3_BLUEPRINT_YAML } from "./blueprints.js";
import { pollS3Source, type S3SourcePort } from './s3-source.js';
import { pollDynamoSource, type DynamoSourcePort } from './dynamodb-source.js';
export interface IngestionWrite { action: 'index' | 'delete'; version: number }

export const INGESTION_ACTIONS = new Set(["CreatePipeline", "UpdatePipeline", "DeletePipeline", "GetPipeline", "GetPipelineChangeProgress", "ListPipelines", "StartPipeline", "StopPipeline", "ValidatePipeline", "GetPipelineBlueprint", "ListPipelineBlueprints", "TagResource", "UntagResource", "ListTagsForResource"]);
export interface IngestionPorts {
  s3Source?: S3SourcePort;
  dynamoSource?: DynamoSourcePort;
  assumeRole(roleArn: string, pipeline: PipelineRecord): Promise<PrincipalContext>;
  resolveSink(config: IngestionConfig, account: string): { arn: string; generatedIdsOnly: boolean };
  deliver(config: IngestionConfig, principal: PrincipalContext, account: string, index: string, id: string | undefined, document: Record<string, any>, write?: IngestionWrite): Promise<void>;
  deadLetter?(config: NonNullable<IngestionConfig["sink"]["dlq"]>, principal: PrincipalContext, event: BufferedEvent, reason: string): Promise<void>;
  metric?(pipeline: PipelineRecord, name: string, value: number): Promise<void>;
  validateLogs?(pipeline: Pick<PipelineRecord, "accountId" | "region" | "generation">, group: string): void;
  log?(pipeline: PipelineRecord, group: string, event: { timestamp: number; message: string }): Promise<void>;
}
type Tls = { certificate: string; privateKey: string; caCertificatePath: string };
const invalid = (message: string): never => { throw new AwsError("ValidationException", message, 400); };
const conflict = (message: string): never => { throw new AwsError("ConflictException", message, 409); };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class OpenSearchIngestionService {
  private tls?: Tls;
  private ports?: IngestionPorts;
  private closing = false;
  private readonly buffers = new Map<string, IngestionBuffer>();
  private readonly gateways = new Map<string, Server>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<Clock["setTimeout"]>>();
  private readonly active = new Map<string, number>();
  constructor(readonly store: StateStore, readonly clock: Clock, readonly authMode: "off" | "validate" | "enforce") {}
  configureTls(tls: Tls): void { this.tls = tls; }
  configurePorts(ports: IngestionPorts): void { this.ports = ports; }
  private async log(pipeline: PipelineRecord, level: "INFO" | "WARN" | "ERROR", event: string, details: Record<string, string | number | boolean> = {}): Promise<void> {
    if (!pipeline.logPublishingOptions?.IsLoggingEnabled || !this.ports?.log) return;
    try {
      await this.ports.log(pipeline, pipeline.logPublishingOptions.CloudWatchLogDestination!.LogGroup, { timestamp: this.clock.now(), message: JSON.stringify({ provider: "stacksim-embedded", pipeline: pipeline.name, level, event, ...details }) });
      if (pipeline.logDeliveryFailure) { delete pipeline.logDeliveryFailure; await this.store.save(); }
    } catch (error) {
      pipeline.logDeliveryFailure = { count: (pipeline.logDeliveryFailure?.count ?? 0) + 1, at: this.clock.now(), message: error instanceof AwsError ? error.message.slice(0, 512) : "Pipeline log delivery failed" };
      await this.store.save().catch(() => undefined);
    }
  }
  private validateLogs(pipeline: Pick<PipelineRecord, "accountId" | "region" | "generation">, options: PipelineLogOptions): void {
    if (!options.IsLoggingEnabled) return;
    if (!this.ports?.validateLogs || !this.ports.log) invalid("Pipeline log delivery is unavailable");
    this.ports!.validateLogs!(pipeline, options.CloudWatchLogDestination!.LogGroup);
  }
  state(region: string, account = this.store.accountId): IngestionState { return this.store.regionState(region, account).opensearch.ingestion ??= { pipelines: {}, retiredPorts: [], cursorKey: randomBytes(32).toString("hex") }; }
  pipeline(region: string, name: string, account = this.store.accountId): PipelineRecord { const pipelines = this.state(region, account).pipelines; if (Object.hasOwn(pipelines, name)) return pipelines[name]; throw new AwsError("ResourceNotFoundException", "Pipeline does not exist in this account and Region", 404); }
  private all(): PipelineRecord[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.ingestion?.pipelines ?? {}))); }
  private directory(pipeline: PipelineRecord): string { if (!/^[a-f0-9-]{36}$/.test(pipeline.generation)) throw new Error("Invalid pipeline generation"); return join(this.store.root, "data", "opensearch-ingestion", pipeline.generation); }
  private keyFile(pipeline: PipelineRecord): string { this.directory(pipeline); return join(this.store.root, "secrets", "opensearch-ingestion", `${pipeline.generation}.key`); }
  private buffer(pipeline: PipelineRecord): IngestionBuffer { const buffer = this.buffers.get(pipeline.generation); if (!buffer) throw new AwsError("InternalException", "Pipeline buffer is unavailable", 503); return buffer; }
  detail(pipeline: PipelineRecord): Record<string, any> {
    return { PipelineName: pipeline.name, PipelineArn: pipeline.arn, Status: pipeline.status, ...(pipeline.failure ? { StatusReason: { Description: pipeline.failure } } : {}), MinUnits: pipeline.minUnits, MaxUnits: pipeline.maxUnits, PipelineConfigurationBody: pipeline.configurationBody, CreatedAt: pipeline.createdAt / 1000, LastUpdatedAt: pipeline.updatedAt / 1000, IngestEndpointUrls: pipeline.status === "ACTIVE" && !pipeline.config.s3 && !pipeline.config.dynamodb ? [`127.0.0.1:${pipeline.gatewayPort}`] : [], BufferOptions: { PersistentBufferEnabled: pipeline.persistentBuffer }, LogPublishingOptions: structuredClone(pipeline.logPublishingOptions ?? { IsLoggingEnabled: false }), PipelineRoleArn: pipeline.config.sink.roleArn, Tags: Object.entries(pipeline.tags).map(([Key, Value]) => ({ Key, Value })), Destinations: [{ ServiceName: pipeline.config.sink.serverless ? "OpenSearchServerless" : "OpenSearch", Endpoint: pipeline.config.sink.host }] };
  }
  private authorize(principal: PrincipalContext, action: string, resource: string, region: string, extra: Record<string, any> = {}): void {
    if (this.authMode !== "enforce") return;
    const iam = this.store.state.accounts[principal.accountId]?.iam;
    if (!iam || evaluateAuthorization(iam, principal, action, resource, { "aws:PrincipalArn": principal.roleArn ?? principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:SecureTransport": true, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), ...extra }).decision !== "allowed") throw new AwsError("AccessDeniedException", `Not authorized for ${action} on ${resource}`, 403);
  }
  authorizeOperation(operation: string, input: any, region: string, principal: PrincipalContext, secure = true): void {
    const name = input.PipelineName, account = principal.accountId || this.store.accountId;
    const pipelines = this.state(region, account).pipelines;
    const existing = name && Object.hasOwn(pipelines, name) ? pipelines[name] : Object.values(pipelines).find(pipeline => pipeline.arn === input.Arn);
    const arn = existing?.arn ?? input.Arn ?? pipelineArn(region, account, name);
    const resource = ["CreatePipeline", "ListPipelines", "ValidatePipeline", "ListPipelineBlueprints", "GetPipelineBlueprint"].includes(operation) ? "*" : arn;
    const tags = input.Tags ?? [];
    const context = { "aws:SecureTransport": secure, "aws:TagKeys": input.TagKeys ?? tags.map((tag: any) => tag.Key), ...Object.fromEntries(tags.map((tag: any) => [`aws:RequestTag/${tag.Key}`, tag.Value])), ...Object.fromEntries(Object.entries(existing?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) };
    this.authorize(principal, `osis:${operation}`, resource, region, context);
    if (operation === "CreatePipeline" && tags.length) this.authorize(principal, "osis:TagResource", arn, region, context);
    if (operation === "CreatePipeline" || operation === "UpdatePipeline") {
      const config = parseIngestionConfig(input.PipelineConfigurationBody ?? existing?.configurationBody, input.PipelineRoleArn ?? existing?.config.sink.roleArn);
      this.authorize(principal, "iam:PassRole", config.sink.roleArn, region, { "aws:SecureTransport": secure, "iam:PassedToService": "osis-pipelines.amazonaws.com", "iam:AssociatedResourceArn": arn });
    }
    if (input.LogPublishingOptions !== undefined && ["CreatePipeline", "UpdatePipeline"].includes(operation)) {
      const enabled = input.LogPublishingOptions.IsLoggingEnabled;
      if (enabled || existing?.logPublishingOptions?.IsLoggingEnabled) this.authorize(principal, `logs:${enabled ? existing?.logPublishingOptions?.IsLoggingEnabled ? "UpdateLogDelivery" : "CreateLogDelivery" : "DeleteLogDelivery"}`, "*", region);
    }
    if (operation === "DeletePipeline" && existing?.logPublishingOptions?.IsLoggingEnabled) this.authorize(principal, "logs:DeleteLogDelivery", "*", region);
    if (operation === "ValidatePipeline") {
      let config: IngestionConfig;
      try { config = parseIngestionConfig(input.PipelineConfigurationBody); } catch { return; }
      this.authorize(principal, "iam:PassRole", config.sink.roleArn, region, { "aws:SecureTransport": secure, "iam:PassedToService": "osis-pipelines.amazonaws.com" });
    }
  }
  async start(): Promise<void> { this.closing = false; for (const pipeline of this.all()) this.enqueue(pipeline); await Promise.all(this.jobs.values()); }
  async stop(): Promise<void> {
    this.closing = true; for (const timer of this.timers.values()) this.clock.clearTimeout(timer); this.timers.clear();
    await Promise.all(this.jobs.values()); await Promise.all(this.workers.values());
    for (const pipeline of this.all()) await this.closeGateway(pipeline);
    for (const buffer of this.buffers.values()) buffer.close(); this.buffers.clear();
  }
  private async bind(pipeline: PipelineRecord, port: number): Promise<void> {
    if (!this.tls) throw new Error("Pipeline TLS is unavailable");
    const server = createServer({ key: this.tls.privateKey, cert: this.tls.certificate, minVersion: "TLSv1.2", requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 32768 }, (req, res) => { void this.gateway(pipeline, req, res); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", () => undefined); pipeline.gatewayPort = port; this.gateways.set(pipeline.generation, server);
  }
  private async reserve(pipeline: PipelineRecord): Promise<void> {
    const retired = new Set(Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => region.opensearch?.ingestion?.retiredPorts ?? []))), used = new Set(this.all().map(pipeline => pipeline.gatewayPort));
    for (let port = 45000; port < 48000; port++) { if (retired.has(port) || used.has(port)) continue; try { await this.bind(pipeline, port); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; } }
    throw new AwsError("LimitExceededException", "No free local pipeline endpoint port", 400);
  }
  private async closeGateway(pipeline: PipelineRecord): Promise<void> { const server = this.gateways.get(pipeline.generation); if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); this.gateways.delete(pipeline.generation); }
  private enqueue(pipeline: PipelineRecord): void {
    if (this.jobs.has(pipeline.generation)) return;
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.store.withMutationLock("osis:catalog", async () => {
      const last = pipeline.changes.at(-1); if (last && last.status !== "COMPLETED") { last.status = "IN_PROGRESS"; last.updatedAt = this.clock.now(); }
      await this.workers.get(pipeline.generation);
      if (pipeline.status === "DELETING") {
        await this.closeGateway(pipeline); this.buffers.get(pipeline.generation)?.close(); this.buffers.delete(pipeline.generation);
        await this.log(pipeline, "INFO", "pipeline_deleted");
        await rm(this.directory(pipeline), { recursive: true, force: true }); await rm(this.keyFile(pipeline), { force: true });
        const state = this.state(pipeline.region, pipeline.accountId); if (!state.retiredPorts.includes(pipeline.gatewayPort)) state.retiredPorts.push(pipeline.gatewayPort); delete state.pipelines[pipeline.name];
        try { await this.store.save(); } catch (error) { state.pipelines[pipeline.name] = pipeline; throw error; } return;
      }
      if (!this.buffers.has(pipeline.generation)) {
        const file = join(this.directory(pipeline), "buffer.enc"); if (pipeline.storageReady) { await access(file); await access(this.keyFile(pipeline)); }
        this.buffers.set(pipeline.generation, new IngestionBuffer(file, this.keyFile(pipeline))); pipeline.storageReady = true;
      }
      if (pipeline.status === "STOPPING" || pipeline.status === "STOPPED") { pipeline.status = "STOPPED"; await this.closeGateway(pipeline); }
      else {
        if (!this.ports) throw new Error("Pipeline delivery integration is unavailable");
        this.ports.resolveSink(pipeline.config, pipeline.accountId);
        await this.ports.assumeRole(pipeline.config.sink.roleArn, pipeline);
        if (pipeline.config.s3 || pipeline.config.dynamodb) { this.validateSource(pipeline.config, pipeline.accountId); pipeline.sourceRunId ??= randomUUID(); await this.closeGateway(pipeline); }
        else if (!this.gateways.has(pipeline.generation)) await this.bind(pipeline, pipeline.gatewayPort);
        pipeline.status = "ACTIVE";
      }
      delete pipeline.failure; pipeline.updatedAt = this.clock.now(); if (last) { last.status = "COMPLETED"; last.updatedAt = this.clock.now(); }
      await this.store.save();
      await this.log(pipeline, "INFO", "pipeline_state", { status: pipeline.status, operation: last?.operation ?? "restart" });
      if (pipeline.status === "ACTIVE") this.wake(pipeline);
    })).catch(async error => {
      pipeline.failure = error instanceof AwsError ? error.message : "The pipeline buffer, endpoint or delivery integration could not be opened";
      if (pipeline.status !== "DELETING") pipeline.status = pipeline.changes.at(-1)?.status === "COMPLETED" ? "START_FAILED" : pipeline.changes.at(-1)?.operation === "CreatePipeline" ? "CREATE_FAILED" : pipeline.changes.at(-1)?.operation === "UpdatePipeline" ? "UPDATE_FAILED" : "START_FAILED";
      const last = pipeline.changes.at(-1); if (last) { last.status = "FAILED"; last.message = pipeline.failure; last.updatedAt = this.clock.now(); }
      await this.closeGateway(pipeline); await this.store.save().catch(() => undefined);
      await this.log(pipeline, "ERROR", "pipeline_state_failed", { status: pipeline.status, operation: last?.operation ?? "restart" });
    }).finally(() => this.jobs.delete(pipeline.generation));
    this.jobs.set(pipeline.generation, job);
  }
  private wake(pipeline: PipelineRecord, delay = 0): void {
    if (this.closing || pipeline.status !== "ACTIVE" || this.timers.has(pipeline.generation) || this.workers.has(pipeline.generation)) return;
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(pipeline.generation);
      const work = this.drain(pipeline).catch(error => { pipeline.failure = error instanceof AwsError ? error.message : "Pipeline buffer delivery failed"; }).finally(() => { this.workers.delete(pipeline.generation); this.wake(pipeline, 1000); });
      this.workers.set(pipeline.generation, work);
    }, delay);
    (timer as any)?.unref?.(); this.timers.set(pipeline.generation, timer);
  }
  private async drain(pipeline: PipelineRecord): Promise<void> {
    if (this.closing || pipeline.status !== "ACTIVE" || !this.ports) return;
    const buffer = this.buffer(pipeline), sessions = new Map<string, PrincipalContext>();
    if (pipeline.config.dynamodb && this.ports.dynamoSource) {
      const before = buffer.stats().accepted ?? 0;
      await pollDynamoSource(pipeline, buffer, this.ports.dynamoSource, () => this.ports!.assumeRole(pipeline.config.sink.roleArn, pipeline), () => this.clock.now(), () => !this.closing && pipeline.status === "ACTIVE").catch(error => { if (!(error instanceof AwsError) || error.status !== 429) throw error; });
      const accepted = (buffer.stats().accepted ?? 0) - before;
      if (accepted) await this.ports.metric?.(pipeline, "recordsIn.count", accepted).catch(() => undefined);
    }
    if (pipeline.config.s3 && this.ports.s3Source) {
      const before = buffer.stats().accepted ?? 0;
      // A full checkpoint must not prevent existing rows from draining.
      await pollS3Source(pipeline, buffer, this.ports.s3Source, () => this.ports!.assumeRole(pipeline.config.sink.roleArn, pipeline), () => this.clock.now(), () => !this.closing && pipeline.status === 'ACTIVE').catch(error => { if (!(error instanceof AwsError) || error.status !== 429) throw error; });
      const accepted = (buffer.stats().accepted ?? 0) - before;
      if (accepted) await this.ports.metric?.(pipeline, 'recordsIn.count', accepted).catch(() => undefined);
    }
    const events = buffer.due(this.clock.now(), this.allocatedUnits(pipeline) * 10);
    for (const event of events) {
      if (this.closing || pipeline.status !== "ACTIVE") break;
      let principal: PrincipalContext | undefined;
      try {
        const config = event.config;
        principal = sessions.get(config.sink.roleArn);
        if (!principal) { principal = await this.ports.assumeRole(config.sink.roleArn, pipeline); sessions.set(config.sink.roleArn, principal); }
        const document = event.metadata?.opensearch_action === "delete" ? event.source : transformIngestionEvent(config, event.source), index = renderIngestionFormat(config.sink.index, document, event.metadata), sink = this.ports.resolveSink(config, pipeline.accountId);
        if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(index) || [".", ".."].includes(index)) invalid("Rendered sink index name is invalid");
        const id = config.sink.documentId ? renderIngestionFormat(config.sink.documentId, document, event.metadata) : sink.generatedIdsOnly ? undefined : event.id;
        if (id !== undefined && (!id.length || Buffer.byteLength(id) > 512)) invalid("Rendered document ID must contain 1–512 bytes");
        const write = config.dynamodb ? { action: renderIngestionFormat(config.sink.action!, document, event.metadata) as "index" | "delete", version: Number(renderIngestionFormat(config.sink.documentVersion!, document, event.metadata)) } : undefined;
        await this.ports.deliver(config, principal, pipeline.accountId, index, id, document, write);
        buffer.delivered(event.id, false, this.clock.now()); await this.ports.metric?.(pipeline, "recordsOut.count", 1).catch(() => undefined);
      } catch (error) {
        const status = error instanceof AwsError ? error.status : Number((error as any)?.status ?? 500), max = event.config.sink.maxRetries;
        const permanent = status === 400 || status === 409 || max !== undefined && event.attempts >= max;
        const reason = error instanceof AwsError || error instanceof SearchError ? error.message : "Sink rejected the event or could not be reached";
        if (permanent && event.config.sink.dlq && this.ports.deadLetter && principal) {
          try { await this.ports.deadLetter(event.config.sink.dlq, principal, event, reason); buffer.delivered(event.id, true, this.clock.now()); }
          catch { buffer.retry(event, this.clock.now(), "Dead-letter delivery is unavailable"); }
        } else buffer.retry(event, this.clock.now(), reason, permanent);
        await this.ports.metric?.(pipeline, "recordsOut.errors.count", 1).catch(() => undefined);
        // Error text can contain event values; publish only stable diagnostic metadata.
        await this.log(pipeline, permanent ? "ERROR" : "WARN", "delivery_failed", { event_id: event.id, attempt: event.attempts + 1, status, permanent });
      }
    }
    if ((pipeline.config.s3 || pipeline.config.dynamodb) && pipeline.status === 'ACTIVE') {
      const failure = pipeline.config.s3 ? buffer.scan()?.failure : buffer.stream()?.failure;
      if (pipeline.failure !== failure) { pipeline.failure = failure; await this.store.save(); }
    }
  }
  private allocatedUnits(pipeline: PipelineRecord): number {
    const stats = this.buffers.get(pipeline.generation)?.stats();
    const waiting = Math.max(0, (stats?.buffered ?? 0) - (stats?.failed ?? 0));
    return Math.min(pipeline.maxUnits, Math.max(pipeline.minUnits, Math.ceil(waiting / 100), Math.ceil((this.active.get(pipeline.generation) ?? 0) / 4)));
  }
  private async gateway(pipeline: PipelineRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-amzn-requestid", randomUUID()); let admitted = false;
    try {
      if (this.closing || pipeline.status !== "ACTIVE") throw new AwsError("ServiceUnavailableException", "Pipeline is not active", 503);
      if (pipeline.config.s3 || pipeline.config.dynamodb) throw new AwsError('ResourceNotFoundException', 'This source does not accept HTTP events', 404);
      // The official OpenSearch signer's Host omits the port. The dedicated
      // listener and retired lease still identify the pipeline generation.
      if (![`127.0.0.1:${pipeline.gatewayPort}`, `localhost:${pipeline.gatewayPort}`, "127.0.0.1", "localhost"].includes(String(req.headers.host))) throw new AwsError("AccessDeniedException", "Host does not match this pipeline", 403);
      if (req.method !== "POST" || req.url !== pipeline.config.path) throw new AwsError("ResourceNotFoundException", "Unknown ingestion path", 404);
      const configuration = pipeline.config;
      const active = this.active.get(pipeline.generation) ?? 0;
      if (active >= Math.min(32, pipeline.maxUnits * 4)) throw new AwsError("ThrottlingException", "Pipeline request capacity exhausted", 429);
      this.active.set(pipeline.generation, active + 1); admitted = true;
      const raw = await readOpenSearchBody(req), url = new URL(req.url!, `https://${req.headers.host}`);
      const principal = this.authMode === "off" ? principalWithoutValidation(req, url, this.store, this.clock) : await authenticateSigV4(req, url, this.store, this.clock, pipeline.region, "osis");
      if (principal.accountId !== pipeline.accountId) throw new AwsError("AccessDeniedException", "Assume an ingestion role in the pipeline account", 403);
      this.authorize(principal, "osis:Ingest", pipeline.arn, pipeline.region, Object.fromEntries(Object.entries(pipeline.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])));
      let bytes = raw;
      if (req.headers["content-encoding"] === "gzip" && configuration.compression === "gzip") { try { bytes = gunzipSync(raw, { maxOutputLength: 10 * 1024 * 1024 }); } catch { invalid("Malformed or oversized gzip input"); } }
      else if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") invalid("The pipeline does not accept this content encoding");
      let events: any;
      try { events = configuration.codec === "json" ? JSON.parse(bytes.toString("utf8")) : bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { invalid("Malformed ingestion payload"); }
      if (!Array.isArray(events) || !events.length || events.length > 1000 || events.some(event => !event || typeof event !== "object" || Array.isArray(event) || Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024)) invalid("Payload requires 1–1000 JSON objects, each at most 1 MiB");
      if (this.closing || pipeline.status !== "ACTIVE" || pipeline.config !== configuration) throw new AwsError("ServiceUnavailableException", "Pipeline configuration changed while receiving this batch; retry it", 503);
      this.buffer(pipeline).accept(events, configuration, this.clock.now()); this.wake(pipeline);
      res.statusCode = 200; res.end(); await this.ports?.metric?.(pipeline, "recordsIn.count", events.length).catch(() => undefined);
    } catch (error) {
      res.statusCode = error instanceof AwsError ? error.status : 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: error instanceof AwsError ? error.message : "Pipeline ingestion failed" }));
    } finally { if (admitted) this.active.set(pipeline.generation, (this.active.get(pipeline.generation) ?? 1) - 1); }
  }
  ingest(region: string, name: string, account: string, principal: PrincipalContext, secure: boolean, events: unknown): void {
    const pipeline = this.pipeline(region, name, account);
    if (pipeline.config.s3 || pipeline.config.dynamodb) throw new AwsError('ValidationException', 'This source does not accept HTTP events', 400);
    if (this.closing || pipeline.status !== "ACTIVE") throw new AwsError("ServiceUnavailableException", "Pipeline is not active", 503);
    if (principal.accountId !== account) throw new AwsError("AccessDeniedException", "Assume an ingestion role in the pipeline account", 403);
    this.authorize(principal, "osis:Ingest", pipeline.arn, region, { "aws:SecureTransport": secure, ...Object.fromEntries(Object.entries(pipeline.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) });
    if ((this.active.get(pipeline.generation) ?? 0) >= Math.min(32, pipeline.maxUnits * 4)) throw new AwsError("ThrottlingException", "Pipeline request capacity exhausted", 429);
    if (!Array.isArray(events) || !events.length || events.length > 1000 || events.some(event => !event || typeof event !== "object" || Array.isArray(event) || Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024)) return invalid("Payload requires 1–1000 JSON objects, each at most 1 MiB");
    this.buffer(pipeline).accept(events, pipeline.config, this.clock.now()); this.wake(pipeline);
    void this.ports?.metric?.(pipeline, "recordsIn.count", events.length).catch(() => undefined);
  }
  validateConfiguration(input: any, previous?: PipelineRecord): { config: IngestionConfig; configurationBody: string; minUnits: number; maxUnits: number; persistentBuffer: boolean; logPublishingOptions: PipelineLogOptions } {
    if (input.VpcOptions !== undefined) invalid("VPC pipeline endpoints are not implemented by the embedded provider");
    if (input.EncryptionAtRestOptions !== undefined) invalid("Customer KMS keys are not implemented; pipeline buffers use a local generation-owned encryption key");
    const logPublishingOptions = structuredClone(input.LogPublishingOptions ?? previous?.logPublishingOptions ?? { IsLoggingEnabled: false }) as PipelineLogOptions;
    if (!logPublishingOptions || typeof logPublishingOptions !== "object" || Array.isArray(logPublishingOptions) || typeof logPublishingOptions.IsLoggingEnabled !== "boolean" || Object.keys(logPublishingOptions).some(key => !["IsLoggingEnabled", "CloudWatchLogDestination"].includes(key))) invalid("LogPublishingOptions requires IsLoggingEnabled");
    const destination = logPublishingOptions.CloudWatchLogDestination;
    if (destination !== undefined && (!destination || Object.keys(destination).some(key => key !== "LogGroup") || typeof destination.LogGroup !== "string" || !/^\/aws\/vendedlogs\/[.\-_/#A-Za-z0-9]{1,490}$/.test(destination.LogGroup))) invalid("Pipeline log groups must use /aws/vendedlogs/ and a valid log group name");
    if (logPublishingOptions.IsLoggingEnabled && !destination) invalid("Enabled logging requires CloudWatchLogDestination.LogGroup");
    if (input.BufferOptions?.PersistentBufferEnabled === false) invalid("The embedded ingestion profile requires persistent buffering");
    const minUnits = input.MinUnits ?? previous?.minUnits, maxUnits = input.MaxUnits ?? previous?.maxUnits;
    if (!Number.isInteger(minUnits) || !Number.isInteger(maxUnits) || minUnits < 1 || minUnits > maxUnits || maxUnits > 8) invalid("Embedded pipeline capacity requires 1 <= MinUnits <= MaxUnits <= 8");
    const configurationBody = input.PipelineConfigurationBody ?? previous?.configurationBody;
    const config = parseIngestionConfig(configurationBody, input.PipelineRoleArn ?? previous?.config.sink.roleArn);
    if (config.sink.dlq && !this.ports?.deadLetter) invalid("S3 dead-letter delivery is unavailable");
    return { config, configurationBody, minUnits, maxUnits, persistentBuffer: true, logPublishingOptions };
  }
  private validateSource(config: IngestionConfig, account: string): void {
    if (config.dynamodb) { if (!this.ports?.dynamoSource) invalid('DynamoDB source delivery is unavailable'); this.ports!.dynamoSource!.validate(config.dynamodb, account); }
    if (!config.s3) return;
    if (!this.ports?.s3Source) invalid('S3 source delivery is unavailable');
    this.ports!.s3Source!.validate(config.s3, account);
  }
  private tagMap(tags: any[], previous: Record<string, string> = {}, system = false): Record<string, string> {
    const result = { ...previous }, keys = new Set<string>();
    for (const tag of tags) {
      if (typeof tag.Key !== "string" || !tag.Key.length || tag.Key.length > 128 || typeof tag.Value !== "string" || tag.Value.length > 256 || !system && tag.Key.toLowerCase().startsWith("aws:") || keys.has(tag.Key)) invalid("Invalid, duplicate or reserved pipeline tag");
      keys.add(tag.Key); Object.defineProperty(result, tag.Key, { value: tag.Value, enumerable: true, configurable: true, writable: true });
    }
    if (Object.keys(result).filter(key => !key.toLowerCase().startsWith("aws:")).length > 50) invalid("At most 50 pipeline tags are supported");
    return result;
  }
  private page(state: IngestionState, input: any, scope: string): Record<string, any> {
    const rows = Object.values(state.pipelines).sort((a, b) => a.name.localeCompare(b.name)), fingerprint = hash(rows.map(row => [row.name, row.generation])), limit = input.MaxResults ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("MaxResults must be 1–100");
    let offset = 0;
    if (input.NextToken) {
      try {
        const [data, signature, extra] = String(input.NextToken).split(".");
        const expected = createHmac("sha256", state.cursorKey).update(data).digest(), actual = Buffer.from(signature, "base64url");
        if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const token = JSON.parse(Buffer.from(data, "base64url").toString());
        if (token.scope !== scope || token.fingerprint !== fingerprint || token.limit !== limit || !Number.isInteger(token.offset) || token.offset < 0 || token.expires < this.clock.now()) throw new Error(); offset = token.offset;
      } catch { invalid("Invalid, expired or stale pipeline pagination token"); }
    }
    const Pipelines = rows.slice(offset, offset + limit).map(row => { const { PipelineConfigurationBody, IngestEndpointUrls, BufferOptions, PipelineRoleArn, LogPublishingOptions, ...summary } = this.detail(row); return summary; });
    if (offset + limit >= rows.length) return { Pipelines };
    const data = Buffer.from(JSON.stringify({ scope, fingerprint, limit, offset: offset + limit, expires: this.clock.now() + 3600000 })).toString("base64url");
    return { Pipelines, NextToken: `${data}.${createHmac("sha256", state.cursorKey).update(data).digest("base64url")}` };
  }
  diagnostics(region: string, name: string, account: string, principal: PrincipalContext, secure: boolean): Record<string, any> {
    this.authorizeOperation("GetPipeline", { PipelineName: name }, region, principal, secure);
    const pipeline = this.pipeline(region, name, account);
    const scan = pipeline.config.s3 ? this.buffers.get(pipeline.generation)?.scan() : undefined;
    const stream = pipeline.config.dynamodb ? this.buffers.get(pipeline.generation)?.stream() : undefined;
    const source = pipeline.config.dynamodb ? { type: 'dynamodb', tableArn: pipeline.config.dynamodb.tableArn, ...(stream && stream.runId === pipeline.sourceRunId ? { status: stream.status, streamArn: stream.cursor?.streamArn, nextSequence: stream.cursor?.nextSequence, accepted: stream.accepted, delivered: stream.delivered, deadLettered: stream.deadLettered, pending: stream.pending?.remaining ?? 0, failure: stream.failure, ...(stream.export ? { initialExport: { arn: stream.export.arn, status: stream.export.completed ? "COMPLETED" : "IN_PROGRESS", acknowledged: stream.export.offset, total: stream.export.total, baselineVersion: stream.export.version } } : {}) } : { status: 'PENDING' }) } : pipeline.config.s3 ? { type: 's3', bucket: pipeline.config.s3.bucket, prefix: pipeline.config.s3.prefix, ...(scan && scan.runId === pipeline.sourceRunId ? { status: scan.status, startedAt: scan.startedAt, updatedAt: scan.updatedAt, listed: scan.objects?.length ?? 0, completed: scan.cursor, accepted: scan.accepted, delivered: scan.delivered, deadLettered: scan.deadLettered, pending: scan.pending?.remaining ?? 0, failure: scan.failure } : { status: 'PENDING' }) } : { type: 'http' };
    return { pipeline: this.detail(pipeline), logDeliveryFailure: structuredClone(pipeline.logDeliveryFailure), source, sourcePath: pipeline.config.s3 || pipeline.config.dynamodb ? undefined : pipeline.config.path, caCertificatePath: this.tls?.caCertificatePath, buffer: this.buffers.get(pipeline.generation)?.stats(), allocatedUnits: pipeline.status === "ACTIVE" ? this.allocatedUnits(pipeline) : 0, failures: this.buffers.get(pipeline.generation)?.failures().map(({ id, attempts, acceptedAt, error }) => ({ id, attempts, acceptedAt, error })) ?? [], limits: { records: 10000, bytes: 64 * 1024 * 1024, concurrentRequests: Math.min(32, pipeline.maxUnits * 4), batchRecords: 1000 }, delivery: "at-least-once" };
  }
  async execute(operation: string, input: any, region: string, account = this.store.accountId, principal?: PrincipalContext, owner?: string): Promise<Record<string, any>> {
    if (!INGESTION_ACTIONS.has(operation)) invalid(`${operation} is not implemented by the embedded ingestion provider`);
    if (principal) this.authorizeOperation(operation, input, region, principal);
    if (operation === "ValidatePipeline") { try { const config = parseIngestionConfig(input.PipelineConfigurationBody); if (config.sink.dlq && !this.ports?.deadLetter) invalid("S3 dead-letter delivery is unavailable"); this.validateSource(config, account); return { isValid: true, Errors: [] }; } catch (error) { if (!(error instanceof AwsError)) throw error; return { isValid: false, Errors: [{ Message: error.message }] }; } }
    if (operation === "ListPipelineBlueprints") return { Blueprints: [HTTP_BLUEPRINT, S3_BLUEPRINT, DYNAMO_BLUEPRINT, DYNAMO_EXPORT_BLUEPRINT] };
    if (operation === "GetPipelineBlueprint") {
      const entry = [{ description: DYNAMO_EXPORT_BLUEPRINT, config: DYNAMO_EXPORT_BLUEPRINT_CONFIG, yaml: DYNAMO_EXPORT_BLUEPRINT_YAML }, { description: DYNAMO_BLUEPRINT, config: DYNAMO_BLUEPRINT_CONFIG, yaml: DYNAMO_BLUEPRINT_YAML }, { description: HTTP_BLUEPRINT, config: HTTP_BLUEPRINT_CONFIG, yaml: HTTP_BLUEPRINT_YAML }, { description: S3_BLUEPRINT, config: S3_BLUEPRINT_CONFIG, yaml: S3_BLUEPRINT_YAML }].find(entry => entry.description.BlueprintName === input.BlueprintName);
      if (!entry) throw new AwsError('ResourceNotFoundException', 'Blueprint not found', 404);
      const Format = input.Format ?? 'YAML'; if (!['YAML', 'JSON'].includes(Format)) invalid('Blueprint format must be YAML or JSON');
      return { Blueprint: { ...entry.description, PipelineConfigurationBody: Format === 'JSON' ? JSON.stringify(entry.config, null, 2) : entry.yaml }, Format };
    }
    const state = this.state(region, account);
    if (operation === "ListPipelines") return this.page(state, input, `${account}:${region}:${principal?.sessionArn ?? principal?.principalArn ?? "internal"}`);
    return this.store.withMutationLock("osis:catalog", async () => {
      if (operation === "CreatePipeline") {
        if (!/^[a-z][a-z0-9-]{2,27}$/.test(input.PipelineName)) invalid("PipelineName must contain 3–28 lowercase letters, digits or hyphens and start with a letter");
        if (Object.hasOwn(state.pipelines, input.PipelineName)) conflict("A pipeline with this name already exists");
        if (this.all().length >= 20) throw new AwsError("LimitExceededException", "The local limit of 20 pipelines was reached", 400);
        if (!this.tls || !this.ports || this.closing) throw new AwsError("InternalException", "Ingestion is not accepting new pipelines", 503);
        const now = this.clock.now(), options = this.validateConfiguration(input), tags = this.tagMap(input.Tags ?? [], {}, Boolean(owner));
        if (options.config.sink.region !== region) invalid("The embedded pipeline sink must be in the pipeline Region");
        this.ports.resolveSink(options.config, account);
        this.validateSource(options.config, account);
        const pipeline: PipelineRecord = { name: input.PipelineName, arn: pipelineArn(region, account, input.PipelineName), accountId: account, region, generation: randomUUID(), gatewayPort: 0, status: "CREATING", ...options, tags, createdAt: now, updatedAt: now, changes: [{ startedAt: now, updatedAt: now, operation, status: "PENDING" }], ...(owner ? { owner } : {}) };
        this.validateLogs(pipeline, options.logPublishingOptions);
        if (pipeline.config.s3 || pipeline.config.dynamodb) pipeline.sourceRunId = randomUUID();
        await this.reserve(pipeline); if (pipeline.config.s3 || pipeline.config.dynamodb) await this.closeGateway(pipeline); state.pipelines[pipeline.name] = pipeline;
        try { await this.store.save(); } catch (error) { delete state.pipelines[pipeline.name]; await this.closeGateway(pipeline); throw error; }
        const result = { Pipeline: this.detail(pipeline) }; this.enqueue(pipeline); return result;
      }
      const pipeline = input.PipelineName ? this.pipeline(region, input.PipelineName, account) : Object.values(state.pipelines).find(row => row.arn === input.Arn);
      if (!pipeline) throw new AwsError("ResourceNotFoundException", "Pipeline not found", 404);
      if (owner && pipeline.owner !== owner) conflict("Pipeline is not owned by this resource generation");
      if (operation === "GetPipeline") return { Pipeline: this.detail(pipeline) };
      if (operation === "ListTagsForResource") return { Tags: Object.entries(pipeline.tags).map(([Key, Value]) => ({ Key, Value })) };
      if (operation === "GetPipelineChangeProgress") return { ChangeProgressStatuses: pipeline.changes.map(change => ({ StartTime: change.startedAt / 1000, Status: change.status, TotalNumberOfStages: 1, ChangeProgressStages: [{ Name: change.operation, Status: change.status, Description: change.message ?? "Publish configuration and open the encrypted buffer and endpoint", LastUpdatedAt: change.updatedAt / 1000 }] })) };
      if (pipeline.status === "DELETING") { if (operation === "DeletePipeline") { this.enqueue(pipeline); return {}; } conflict("Pipeline is being deleted"); }
      if (this.jobs.has(pipeline.generation) || ["CREATING", "UPDATING", "STARTING", "STOPPING"].includes(pipeline.status)) conflict("Pipeline has a change in progress");
      const before = structuredClone(pipeline);
      if (operation === "TagResource") pipeline.tags = this.tagMap(input.Tags, pipeline.tags);
      else if (operation === "UntagResource") { if (input.TagKeys.some((key: string) => key.toLowerCase().startsWith("aws:"))) invalid("Reserved tags cannot be removed"); for (const key of input.TagKeys) delete pipeline.tags[key]; }
      else {
        if (operation === "UpdatePipeline") { const options = this.validateConfiguration(input, pipeline); if (options.config.sink.region !== region) invalid("The embedded pipeline sink must be in the pipeline Region"); this.ports?.resolveSink(options.config, account); this.validateSource(options.config, account); this.validateLogs(pipeline, options.logPublishingOptions); if (pipeline.config.dynamodb && hash(options.config.dynamodb ?? null) !== hash(pipeline.config.dynamodb)) invalid("A DynamoDB source is immutable; create a new pipeline and resynchronize into a new index"); if (hash(options.config.s3 ?? options.config.dynamodb ?? null) !== hash(pipeline.config.s3 ?? pipeline.config.dynamodb ?? null)) pipeline.sourceRunId = options.config.s3 || options.config.dynamodb ? randomUUID() : undefined; Object.assign(pipeline, options); pipeline.status = "UPDATING"; }
        else if (operation === "StopPipeline") { if (pipeline.status === "STOPPED") return { Pipeline: this.detail(pipeline) }; pipeline.status = "STOPPING"; }
        else if (operation === "StartPipeline") { if (pipeline.status === "ACTIVE") return { Pipeline: this.detail(pipeline) }; if (pipeline.config.s3) pipeline.sourceRunId = randomUUID(); pipeline.status = "STARTING"; }
        else if (operation === "DeletePipeline") pipeline.status = "DELETING";
        else return invalid(`Unsupported pipeline operation ${operation}`);
        const now = this.clock.now(); pipeline.changes = [...pipeline.changes.slice(-19), { startedAt: now, updatedAt: now, operation, status: "PENDING" }];
      }
      pipeline.updatedAt = this.clock.now();
      try { await this.store.save(); } catch (error) { Object.assign(pipeline, before); throw error; }
      const result = operation === "DeletePipeline" || operation.endsWith("tagResource") || operation === "TagResource" ? {} : { Pipeline: this.detail(pipeline) };
      if (!["TagResource", "UntagResource"].includes(operation)) this.enqueue(pipeline);
      return result;
    });
  }
}
