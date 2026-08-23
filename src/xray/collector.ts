import type { Clock } from "../core/clock.js";
import type { XRayService } from "../xray.js";
import { formatTraceHeader, generateSegmentId, generateTraceId, parseTraceHeader, type RandomBytesSource } from "./trace-header.js";

export interface ApiGatewayTraceInput {
  accountId: string;
  region: string;
  apiId: string;
  apiName: string;
  stageName: string;
  requestId: string;
  method: string;
  url: string;
  clientIp?: string;
  userAgent?: string;
  incomingHeader?: string | string[];
  active: boolean;
}

interface IntegrationTrace {
  id: string;
  name: string;
  operation?: string;
  resourceName?: string;
  url?: string;
  startTime: number;
  endTime?: number;
  status?: number;
  error?: boolean;
  fault?: boolean;
  throttle?: boolean;
}

export class ApiGatewayTraceScope {
  readonly traceId: string;
  readonly segmentId?: string;
  readonly sampled: boolean;
  readonly samplingSource: "upstream" | "default" | "passive";
  readonly samplingRuleName?: string;
  private readonly startTime: number;
  private integration?: IntegrationTrace;
  private finished = false;

  constructor(
    private readonly service: XRayService,
    private readonly clock: Clock,
    private readonly randomBytes: RandomBytesSource,
    readonly input: ApiGatewayTraceInput,
  ) {
    const parsed = parseTraceHeader(input.incomingHeader);
    const sampling = service.sampler.decide(input.accountId, input.region, input.active, parsed.valid ? parsed.decision : "undecided");
    this.samplingSource = sampling.source; this.samplingRuleName = sampling.ruleName;
    this.sampled = sampling.sampled;
    this.traceId = parsed.valid && parsed.root ? parsed.root : generateTraceId(clock.now(), randomBytes);
    this.segmentId = this.sampled ? generateSegmentId(randomBytes) : undefined;
    this.startTime = clock.now() / 1000;
  }

  propagationHeader(): string {
    return formatTraceHeader({ root: this.traceId, ...(this.integration ? { parent: this.integration.id } : this.segmentId ? { parent: this.segmentId } : {}), decision: this.sampled ? "sampled" : this.samplingSource === "upstream" ? "not-sampled" : "undecided" });
  }

  beginIntegration(input: { name: string; operation?: string; resourceName?: string; url?: string }): string {
    if (!this.sampled) return this.propagationHeader();
    if (!this.integration) this.integration = { id: generateSegmentId(this.randomBytes), name: input.name, operation: input.operation, resourceName: input.resourceName, url: input.url, startTime: this.clock.now() / 1000 };
    return this.propagationHeader();
  }

  finishIntegration(status: number): void {
    if (!this.integration || this.integration.endTime !== undefined) return;
    this.integration.endTime = Math.max(this.clock.now() / 1000, this.integration.startTime + 0.000001);
    this.integration.status = status; this.integration.error = status >= 400 && status < 500; this.integration.throttle = status === 429; this.integration.fault = status >= 500;
  }

  async finish(status: number, contentLength: number): Promise<void> {
    if (this.finished || !this.sampled || !this.segmentId) return;
    this.finished = true;
    if (this.integration && this.integration.endTime === undefined) this.finishIntegration(status);
    const endTime = Math.max(this.clock.now() / 1000, this.startTime + 0.000001);
    const segment: any = {
      name: `${this.input.apiName}/${this.input.stageName}`,
      id: this.segmentId,
      trace_id: this.traceId,
      start_time: this.startTime,
      end_time: endTime,
      origin: "AWS::ApiGateway::Stage",
      resource_arn: `arn:aws:apigateway:${this.input.region}::/restapis/${this.input.apiId}/stages/${this.input.stageName}`,
      annotations: { "aws:api_id": this.input.apiId, "aws:api_stage": this.input.stageName },
      aws: {
        ...(this.samplingRuleName ? { xray: { sampling_rule_name: this.samplingRuleName } } : {}),
        api_gateway: { account_id: this.input.accountId, rest_api_id: this.input.apiId, stage: this.input.stageName, request_id: this.input.requestId },
      },
      http: {
        request: { method: this.input.method, url: this.input.url, ...(this.input.clientIp ? { client_ip: this.input.clientIp } : {}), ...(this.input.userAgent ? { user_agent: this.input.userAgent } : {}) },
        response: { status, content_length: contentLength },
      },
      ...(status >= 400 && status < 500 ? { error: true } : {}),
      ...(status === 429 ? { throttle: true } : {}),
      ...(status >= 500 ? { fault: true } : {}),
    };
    if (this.integration) {
      const integration: any = {
        id: this.integration.id, name: this.integration.name, namespace: "aws", start_time: this.integration.startTime,
        end_time: this.integration.endTime ?? endTime,
        ...(this.integration.url ? { http: { request: { url: this.integration.url, method: "POST" }, response: { status: this.integration.status ?? status, content_length: 0 } } } : {}),
        aws: { ...(this.integration.operation ? { operation: this.integration.operation } : {}), region: this.input.region, ...(this.integration.resourceName ? { resource_names: [this.integration.resourceName], function_name: this.integration.resourceName } : {}) },
        ...(this.integration.error ? { error: true } : {}), ...(this.integration.throttle ? { throttle: true } : {}), ...(this.integration.fault ? { fault: true } : {}),
      };
      segment.subsegments = [integration];
    }
    await this.service.ingestTrusted(JSON.stringify(segment), { principal: "ops.apigateway.amazonaws.com", sourceService: "apigateway", requestId: this.input.requestId });
  }
}

