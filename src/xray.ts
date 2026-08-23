import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { AwsError } from "./errors.js";
import type { StateStore } from "./state.js";
import { json, readBody } from "./util.js";
import { xrayOperation } from "./xray/action-inventory.js";
import { ApiGatewayTraceScope, type ApiGatewayTraceInput } from "./xray/collector.js";
import type { StoredTrace, StoredTraceSummary, XRayRepositoryHealth, XRayStoreOptions } from "./xray/model.js";
import { XRayDefaultSampler } from "./xray/sampling.js";
import { validateSegmentDocument } from "./xray/segment-document.js";
import { XRayTraceStore } from "./xray/trace-store.js";
import { TRACE_ID_PATTERN, type RandomBytesSource } from "./xray/trace-header.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const PAGE_SIZE = 100;

interface TokenEnvelope { v: 1; accountId: string; region: string; operation: string; filter: string; position: number; generation: string }

function xrayError(res: ServerResponse, error: unknown): void {
  const aws = error instanceof AwsError ? error : new AwsError("InternalServerError", error instanceof Error ? error.message : String(error), 500);
  res.statusCode = aws.status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ __type: aws.code, Message: aws.message }));
}

function requireObject(value: unknown): any { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("InvalidRequestException", "Request body must be a JSON object", 400); return value; }
function epoch(value: unknown, name: string): number { const output = value instanceof Date ? value.getTime() / 1000 : Number(value); if (!Number.isFinite(output) || output < 0) throw new AwsError("InvalidRequestException", `${name} must be a non-negative timestamp`, 400); return output; }
function traceIds(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(item => typeof item !== "string" || !TRACE_ID_PATTERN.test(item))) throw new AwsError("InvalidRequestException", "TraceIds must contain 1 through 100 canonical trace IDs", 400); return [...new Set(value)]; }

export class XRayService {
  readonly sampler: XRayDefaultSampler;
  readonly store: XRayTraceStore;
  private started = false;

  constructor(
    private readonly state: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    random: () => number = Math.random,
    private readonly randomBytesSource: RandomBytesSource = randomBytes,
    storeOptions: XRayStoreOptions = {},
  ) {
    this.sampler = new XRayDefaultSampler(clock, random);
    this.store = new XRayTraceStore(state.root, state.accountId, region, () => clock.now(), storeOptions);
  }

  async start(): Promise<void> { if (!this.started) { await this.store.start(); this.started = true; } }
  async stop(): Promise<void> { if (this.started) { await this.store.stop(); this.started = false; } }

  beginApiGatewayRequest(input: ApiGatewayTraceInput): ApiGatewayTraceScope { return new ApiGatewayTraceScope(this, this.clock, this.randomBytesSource, input); }

  async ingestTrusted(document: string, context: { principal: string; sourceService: "apigateway"; requestId: string }): Promise<void> {
    if (context.principal !== "ops.apigateway.amazonaws.com" || context.sourceService !== "apigateway") throw new AwsError("AccessDeniedException", "Untrusted X-Ray producer", 403);
    try { this.store.ingest(validateSegmentDocument(document)); }
    catch (error) { this.store.recordFailure(error instanceof AwsError ? error.code : "InternalServerError", error instanceof Error ? error.message : String(error)); throw error; }
  }

  private tokenSecret(): Buffer { return Buffer.from(this.state.state.installation.paginationSecret, "base64url"); }
  private encodeToken(operation: string, filter: string, position: number): string {
    const envelope: TokenEnvelope = { v: 1, accountId: this.state.accountId, region: this.region, operation, filter, position, generation: this.store.generation() };
    const payload = Buffer.from(JSON.stringify(envelope)).toString("base64url"); const signature = createHmac("sha256", this.tokenSecret()).update(payload).digest("base64url"); return `${payload}.${signature}`;
  }
  private decodeToken(token: unknown, operation: string, filter: string): number {
    if (token === undefined) return 0;
    if (typeof token !== "string" || token.length > 2_048) throw new AwsError("InvalidRequestException", "NextToken is invalid", 400);
    const [payload, signature, extra] = token.split("."); if (!payload || !signature || extra) throw new AwsError("InvalidRequestException", "NextToken is invalid", 400);
    const expected = createHmac("sha256", this.tokenSecret()).update(payload).digest("base64url");
    if (signature.length !== expected.length || !Buffer.from(signature).equals(Buffer.from(expected))) throw new AwsError("InvalidRequestException", "NextToken is invalid", 400);
    let decoded: TokenEnvelope; try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new AwsError("InvalidRequestException", "NextToken is invalid", 400); }
    if (decoded.v !== 1 || decoded.accountId !== this.state.accountId || decoded.region !== this.region || decoded.operation !== operation || decoded.filter !== filter || decoded.generation !== this.store.generation() || !Number.isSafeInteger(decoded.position) || decoded.position < 0) throw new AwsError("InvalidRequestException", "NextToken is invalid for this query", 400);
    return decoded.position;
  }

  private async request(req: IncomingMessage): Promise<any> {
    const body = await readBody(req); if (body.length > MAX_REQUEST_BYTES) throw new AwsError("InvalidRequestException", "Request body exceeds 1 MiB", 400);
    try { return requireObject(body.length ? JSON.parse(body.toString("utf8")) : {}); } catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("InvalidRequestException", "Request body is not valid JSON", 400); }
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    try {
      const operation = xrayOperation(pathname, req.method); if (!operation) throw new AwsError("InvalidRequestException", "Unknown X-Ray operation", 400);
      const input = await this.request(req); const output = await (this as any)[operation](input); json(res, output);
    } catch (error) { xrayError(res, error); }
  }

  PutTraceSegments(input: any): any {
    if (!Array.isArray(input.TraceSegmentDocuments) || !input.TraceSegmentDocuments.length || input.TraceSegmentDocuments.length > 50) throw new AwsError("InvalidRequestException", "TraceSegmentDocuments must contain 1 through 50 documents", 400);
    const unprocessed: any[] = [];
    for (const document of input.TraceSegmentDocuments) {
      let id: string | undefined; try { if (typeof document === "string") id = JSON.parse(document)?.id; } catch {}
      try { this.store.ingest(validateSegmentDocument(document)); }
      catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalServerError", error instanceof Error ? error.message : String(error), 500); this.store.recordFailure(aws.code, aws.message); unprocessed.push({ ...(typeof id === "string" ? { Id: id } : {}), ErrorCode: aws.code, Message: aws.message.slice(0, 500) }); }
    }
    return { UnprocessedTraceSegments: unprocessed };
  }

  GetTraceSummaries(input: any): any {
    const start = epoch(input.StartTime, "StartTime"); const end = epoch(input.EndTime, "EndTime"); if (end < start) throw new AwsError("InvalidRequestException", "EndTime must not precede StartTime", 400);
    if (input.Sampling === true || input.SamplingStrategy !== undefined) throw new AwsError("InvalidRequestException", "Sampling trace summaries is outside XRY-01", 400);
    if (input.TimeRangeType !== undefined && input.TimeRangeType !== "TraceId") throw new AwsError("InvalidRequestException", "Only TraceId time ranges are supported in XRY-01", 400);
    const filter = input.FilterExpression === undefined ? "" : String(input.FilterExpression); const predicate = this.summaryFilter(filter);
    const binding = XRayTraceStore.filterHash({ start, end, filter }); const position = this.decodeToken(input.NextToken, "GetTraceSummaries", binding);
    const page = this.store.summaries(start, end, position, PAGE_SIZE); const summaries = page.items.filter(predicate).map(summary => this.traceSummaryView(summary));
    return { TraceSummaries: summaries, ApproximateTime: end, TracesProcessedCount: summaries.length, ...(page.nextPosition === undefined ? {} : { NextToken: this.encodeToken("GetTraceSummaries", binding, page.nextPosition) }) };
  }

  private summaryFilter(filter: string): (summary: StoredTraceSummary) => boolean {
    if (!filter.trim()) return () => true;
    const service = /^service\(["']([^"']+)["']\)$/.exec(filter.trim()); if (service) return summary => summary.rootService === service[1];
    const status = /^http\.status\s*=\s*(\d{3})$/.exec(filter.trim()); if (status) return summary => summary.responseStatus === Number(status[1]);
    if (filter.trim() === "fault") return summary => summary.fault;
    if (filter.trim() === "error") return summary => summary.error;
    if (filter.trim() === "throttle") return summary => summary.throttle;
    throw new AwsError("InvalidRequestException", "FilterExpression uses syntax outside the XRY-01 subset", 400);
  }

  private traceSummaryView(summary: StoredTraceSummary): any {
    return { Id: summary.traceId, StartTime: summary.startTime, Duration: summary.duration, ResponseTime: summary.duration, HasFault: summary.fault, HasError: summary.error, HasThrottle: summary.throttle, IsPartial: false, Http: { ...(summary.responseStatus === undefined ? {} : { HttpStatus: summary.responseStatus }) }, Annotations: summary.annotations, ServiceIds: [{ Name: summary.rootService, Type: "AWS::ApiGateway::Stage", AccountId: this.state.accountId }] };
  }

  BatchGetTraces(input: any): any {
    const ids = traceIds(input.TraceIds); const binding = XRayTraceStore.filterHash(ids); const position = this.decodeToken(input.NextToken, "BatchGetTraces", binding); const page = this.store.getTraces(ids, position, PAGE_SIZE);
    return { Traces: page.items.map(trace => this.traceView(trace)), UnprocessedTraceIds: page.unprocessed, ...(page.nextPosition === undefined ? {} : { NextToken: this.encodeToken("BatchGetTraces", binding, page.nextPosition) }) };
  }

  private traceView(trace: StoredTrace): any { return { Id: trace.id, Duration: trace.duration, LimitExceeded: trace.limitExceeded, Segments: trace.segments.map(segment => ({ Id: segment.id, Document: segment.document })) }; }

  GetTraceGraph(input: any): any {
    const ids = traceIds(input.TraceIds); const binding = XRayTraceStore.filterHash(ids); const position = this.decodeToken(input.NextToken, "GetTraceGraph", binding); const selected = ids.slice(position, position + PAGE_SIZE); const services = this.graphForTraces(selected);
    return { Services: services, ...(position + PAGE_SIZE < ids.length ? { NextToken: this.encodeToken("GetTraceGraph", binding, position + PAGE_SIZE) } : {}) };
  }

  GetServiceGraph(input: any): any {
    const start = epoch(input.StartTime, "StartTime"); const end = epoch(input.EndTime, "EndTime"); if (end < start) throw new AwsError("InvalidRequestException", "EndTime must not precede StartTime", 400);
    if (input.GroupName !== undefined || input.GroupARN !== undefined) throw new AwsError("InvalidRequestException", "Groups are outside XRY-01", 400);
    const binding = XRayTraceStore.filterHash({ start, end }); const position = this.decodeToken(input.NextToken, "GetServiceGraph", binding); const page = this.store.summaries(start, end, position, PAGE_SIZE); const services = this.graphForTraces(page.items.map(item => item.traceId));
    return { StartTime: start, EndTime: end, Services: services, ContainsOldGroupVersions: false, ...(page.nextPosition === undefined ? {} : { NextToken: this.encodeToken("GetServiceGraph", binding, page.nextPosition) }) };
  }

  private graphForTraces(ids: readonly string[]): any[] {
    const nodes = new Map<string, { reference: number; name: string; type: string; start: number; end: number; ok: number; error: number; fault: number; throttle: number; edges: Set<string> }>();
    const idToNode = new Map<string, string>();
    for (const traceId of ids) {
      const trace = this.store.getTrace(traceId); if (!trace) continue;
      for (const segment of trace.segments) {
        let document: any; try { document = JSON.parse(segment.document); } catch { continue; }
        const visit = (node: any, parent?: any) => {
          const key = `${node.name ?? "unknown"}\0${node.namespace === "aws" ? "AWS::Service" : node.origin ?? "local"}`;
          let aggregate = nodes.get(key); if (!aggregate) { aggregate = { reference: nodes.size, name: node.name ?? "unknown", type: node.origin ?? (node.namespace === "aws" ? "AWS::Service" : "local"), start: node.start_time, end: node.end_time ?? node.start_time, ok: 0, error: 0, fault: 0, throttle: 0, edges: new Set() }; nodes.set(key, aggregate); }
          aggregate.start = Math.min(aggregate.start, node.start_time); aggregate.end = Math.max(aggregate.end, node.end_time ?? node.start_time); aggregate.ok += node.error || node.fault ? 0 : 1; aggregate.error += node.error ? 1 : 0; aggregate.fault += node.fault ? 1 : 0; aggregate.throttle += node.throttle ? 1 : 0; idToNode.set(node.id, key);
          if (parent) nodes.get(idToNode.get(parent.id)!)?.edges.add(key);
          for (const child of node.subsegments ?? []) visit(child, node);
        };
        visit(document);
      }
    }
    return [...nodes.entries()].map(([key, node]) => ({ ReferenceId: node.reference, Name: node.name, Names: [node.name], Type: node.type, State: "active", StartTime: node.start, EndTime: node.end, SummaryStatistics: { OkCount: node.ok, ErrorStatistics: { ThrottleCount: node.throttle, TotalCount: node.error }, FaultStatistics: { OtherCount: node.fault, TotalCount: node.fault }, TotalCount: node.ok + node.error + node.fault, TotalResponseTime: Math.max(0, node.end - node.start) }, Edges: [...node.edges].map(destination => ({ ReferenceId: nodes.get(destination)!.reference, StartTime: node.start, EndTime: node.end, SummaryStatistics: { OkCount: node.ok, ErrorStatistics: { ThrottleCount: node.throttle, TotalCount: node.error }, FaultStatistics: { OtherCount: node.fault, TotalCount: node.fault }, TotalCount: node.ok + node.error + node.fault, TotalResponseTime: Math.max(0, node.end - node.start) } })) }));
  }

  health(): XRayRepositoryHealth { return this.store.health(); }
  consoleTraces(start = 0, end = this.clock.now() / 1000): any[] { return this.store.summaries(start, end, 0, PAGE_SIZE).items.map(summary => this.traceSummaryView(summary)); }
  consoleTrace(traceId: string): any | undefined { const trace = this.store.getTrace(traceId); return trace ? this.traceView(trace) : undefined; }
  consoleTraceSafe(traceId: string): any | undefined {
    const trace = this.store.getTrace(traceId); if (!trace) return undefined;
    const sensitive = /authorization|cookie|password|secret|token|accesskey|sessiontoken|credential/i;
    const redact = (value: any, depth = 0): any => {
      if (depth > 32) return "<max-depth>";
      if (Array.isArray(value)) return value.slice(0, 1_000).map(item => redact(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 1_000).map(([key, item]) => [key, sensitive.test(key) ? "<redacted>" : redact(item, depth + 1)]));
      return typeof value === "string" && value.length > 16_384 ? `${value.slice(0, 16_384)}…` : value;
    };
    return { Id: trace.id, Duration: trace.duration, LimitExceeded: trace.limitExceeded, Segments: trace.segments.map(segment => { let document: any; try { document = JSON.parse(segment.document); } catch { document = "<invalid-json>"; } return { Id: segment.id, Document: redact(document) }; }) };
  }
}
