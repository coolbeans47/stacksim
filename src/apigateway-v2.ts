import { createHash, type JsonWebKey } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { AwsError, sendAwsError } from "./errors.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { InvokeResult, LambdaService } from "./lambda.js";
import type { SqsService, SendMessageInput } from "./sqs.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import type { StateStore } from "./state.js";
import type {
  ApiGatewayV2ApiMappingState,
  ApiGatewayV2DomainNameState,
  HttpApiAuthorizerState,
  HttpApiCorsState,
  HttpApiDeploymentSnapshotState,
  HttpApiDeploymentState,
  HttpApiIntegrationState,
  HttpApiRouteSettingsState,
  HttpApiRouteState,
  HttpApiStageState,
  HttpApiState,
} from "./types.js";
import { evaluateIdentityPolicy, evaluateRoleAuthorization, evaluateTrust, type AuthorizationResult } from "./iam/evaluator.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import { id, json, readBody, readJson } from "./util.js";
import { ApiGatewayWebSocketService, webSocketApiView } from "./apigateway-websocket.js";
import { cloudFormationChildToken, cloudFormationResourceId, getCloudFormationIdempotencyKey } from "./core/internal-request.js";
import {
  JwtValidationError,
  parseJwt,
  verifyParsedJwt,
} from "./core/jwt.js";
import type { CognitoIssuerKeySource } from "./cognito/gateway.js";

const METHODS = new Set(["ANY", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const AUTHORIZATION_TYPES = new Set(["NONE", "AWS_IAM", "CUSTOM", "JWT"]);
const SECURITY_POLICIES = new Set(["TLS_1_2", "TLS_1_0"]);
const DOMAIN_ROUTING_MODES = new Set(["API_MAPPING_ONLY", "ROUTING_RULE_ONLY", "ROUTING_RULE_THEN_API_MAPPING"]);
const JWT_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]);
const MAX_HTTP_JWT_CLAIMS = 128;
const MAX_HTTP_JWT_CLAIM_NAME_BYTES = 256;
const MAX_HTTP_JWT_CLAIM_VALUE_BYTES = 8_192;
const MAX_HTTP_JWT_CLAIM_TOTAL_BYTES = 24_576;

function present<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/*
 * API Gateway v2 exposes a String-to-String claims map rather than the parsed
 * JSON object. Keep this adapter independent from the REST Cognito adapter:
 * the two AWS surfaces have separate golden contracts even when scalar values
 * happen to have the same spelling.
 */
export function httpJwtClaimsAsStrings(claims: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(claims);
  if (entries.length > MAX_HTTP_JWT_CLAIMS) throw new JwtValidationError();
  let total = 0;
  const result: Record<string, string> = {};
  for (const [name, value] of entries) {
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (!name || nameBytes > MAX_HTTP_JWT_CLAIM_NAME_BYTES) throw new JwtValidationError();
    let stringValue: string;
    if (typeof value === "string") {
      stringValue = value;
    } else if (typeof value === "boolean") {
      stringValue = value ? "true" : "false";
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new JwtValidationError();
      stringValue = String(value);
    } else if (
      (Array.isArray(value) || value !== null && typeof value === "object")
      && value !== undefined
    ) {
      try {
        stringValue = JSON.stringify(value);
      } catch {
        throw new JwtValidationError();
      }
    } else {
      throw new JwtValidationError();
    }
    const valueBytes = Buffer.byteLength(stringValue, "utf8");
    if (valueBytes > MAX_HTTP_JWT_CLAIM_VALUE_BYTES) throw new JwtValidationError();
    total += nameBytes + valueBytes;
    if (total > MAX_HTTP_JWT_CLAIM_TOTAL_BYTES) throw new JwtValidationError();
    result[name] = stringValue;
  }
  return result;
}

function corsView(cors: HttpApiCorsState | undefined): any {
  return cors ? structuredClone(cors) : undefined;
}

function apiView(api: HttpApiState): any {
  return present({
    apiEndpoint: api.apiEndpoint,
    apiGatewayManaged: api.apiGatewayManaged,
    apiId: api.apiId,
    apiKeySelectionExpression: "$request.header.x-api-key",
    corsConfiguration: corsView(api.corsConfiguration),
    createdDate: new Date(api.createdDate).toISOString(),
    description: api.description,
    disableExecuteApiEndpoint: api.disableExecuteApiEndpoint,
    ipAddressType: api.ipAddressType,
    name: api.name,
    protocolType: api.protocolType,
    routeSelectionExpression: api.routeSelectionExpression,
    tags: structuredClone(api.tags),
    version: api.version,
  });
}

function integrationView(integration: HttpApiIntegrationState): any {
  return present({
    apiGatewayManaged: integration.apiGatewayManaged,
    connectionType: integration.connectionType,
    credentialsArn: integration.credentialsArn,
    description: integration.description,
    integrationId: integration.integrationId,
    integrationMethod: integration.integrationMethod,
    integrationResponseSelectionExpression: "${response.statuscode}",
    integrationSubtype: integration.integrationSubtype,
    integrationType: integration.integrationType,
    integrationUri: integration.integrationUri,
    payloadFormatVersion: integration.payloadFormatVersion,
    requestParameters: structuredClone(integration.requestParameters),
    responseParameters: structuredClone(integration.responseParameters),
    timeoutInMillis: integration.timeoutInMillis,
    tlsConfig: structuredClone(integration.tlsConfig),
  });
}

function routeView(route: HttpApiRouteState): any {
  return present({
    apiGatewayManaged: route.apiGatewayManaged,
    apiKeyRequired: false,
    authorizationScopes: [...route.authorizationScopes],
    authorizationType: route.authorizationType,
    authorizerId: route.authorizerId,
    operationName: route.operationName,
    requestModels: {},
    requestParameters: {},
    routeId: route.routeId,
    routeKey: route.routeKey,
    target: route.target,
  });
}

function authorizerView(authorizer: HttpApiAuthorizerState): any {
  return present({
    authorizerCredentialsArn: authorizer.authorizerCredentialsArn,
    authorizerId: authorizer.authorizerId,
    authorizerPayloadFormatVersion: authorizer.authorizerPayloadFormatVersion,
    authorizerResultTtlInSeconds: authorizer.authorizerResultTtlInSeconds,
    authorizerType: authorizer.authorizerType,
    authorizerUri: authorizer.authorizerUri,
    enableSimpleResponses: authorizer.enableSimpleResponses,
    identitySource: [...authorizer.identitySource],
    jwtConfiguration: structuredClone(authorizer.jwtConfiguration),
    name: authorizer.name,
  });
}

function deploymentView(deployment: HttpApiDeploymentState): any {
  return present({
    autoDeployed: deployment.autoDeployed,
    createdDate: new Date(deployment.createdDate).toISOString(),
    deploymentId: deployment.deploymentId,
    deploymentStatus: deployment.deploymentStatus,
    description: deployment.description,
  });
}

function stageView(stage: HttpApiStageState): any {
  return present({
    accessLogSettings: structuredClone(stage.accessLogSettings),
    apiGatewayManaged: stage.apiGatewayManaged,
    autoDeploy: stage.autoDeploy,
    createdDate: new Date(stage.createdDate).toISOString(),
    defaultRouteSettings: structuredClone(stage.defaultRouteSettings),
    deploymentId: stage.deploymentId,
    description: stage.description,
    lastDeploymentStatusMessage: stage.lastDeploymentStatusMessage,
    lastUpdatedDate: new Date(stage.lastUpdatedDate).toISOString(),
    routeSettings: structuredClone(stage.routeSettings),
    stageName: stage.stageName,
    stageVariables: structuredClone(stage.stageVariables),
    tags: structuredClone(stage.tags),
  });
}

function mappingView(mapping: ApiGatewayV2ApiMappingState): any {
  return present({ apiId: mapping.apiId, apiMappingId: mapping.apiMappingId, apiMappingKey: mapping.apiMappingKey, stage: mapping.stage });
}

function domainView(domain: ApiGatewayV2DomainNameState): any {
  return present({
    apiMappingSelectionExpression: domain.apiMappingSelectionExpression,
    domainName: domain.domainName,
    domainNameArn: domain.domainNameArn,
    domainNameConfigurations: structuredClone(domain.domainNameConfigurations).map(value => present({ ...value, certificateUploadDate: value.certificateUploadDate === undefined ? undefined : new Date(value.certificateUploadDate).toISOString() })),
    mutualTlsAuthentication: structuredClone(domain.mutualTlsAuthentication),
    routingMode: domain.routingMode,
    tags: structuredClone(domain.tags),
  });
}

export interface HttpApiDomainResolution { matched: boolean; pathname?: string }

export interface HttpApiJwtJwks { keys: JsonWebKey[] }

interface HttpInvocationInput {
  method: string;
  path: string;
  rawQueryString: string;
  headers: Record<string, string>;
  multiHeaders: Record<string, string[]>;
  query: Record<string, string>;
  multiQuery: Record<string, string[]>;
  pathParameters: Record<string, string>;
  body: Buffer;
  requestId: string;
  sourceIp?: string;
  stage: HttpApiStageState;
  api: HttpApiState;
  route: HttpApiRouteState;
  snapshot: HttpApiDeploymentSnapshotState;
  principal?: PrincipalContext;
  identityAuthorization?: AuthorizationResult;
}

interface ResolvedHttpInvocation {
  api: HttpApiState;
  stage: HttpApiStageState;
  snapshot: HttpApiDeploymentSnapshotState;
  route: HttpApiRouteState;
  path: string;
  pathParameters: Record<string, string>;
}

interface HttpBackendResult { status: number; headers: Record<string, string | string[]>; body: Buffer; integrationLatency: number }

interface HttpAuthorizerResult { allowed: boolean; principalId?: string; context: Record<string, unknown>; jwt?: { claims: Record<string, string>; scopes: string[] } }

export class ApiGatewayV2Service {
  private readonly authorizerCache = new Map<string, { expiresAt: number; value: HttpAuthorizerResult }>();
  private readonly remoteJwksCache = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();
  private readonly throttleBuckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly store: StateStore,
    private readonly lambda: LambdaService,
    private readonly invokePort: number | (() => number),
    private readonly region: string,
    private readonly clock: Clock = new SystemClock(),
    private readonly authMode: "off" | "validate" | "enforce" = "off",
    private readonly telemetry?: TelemetryBus,
    private readonly logs?: CloudWatchLogsService,
    private readonly accountRateLimit = 10_000,
    private readonly accountBurstLimit = 5_000,
    private readonly invokeProtocol: "http" | "https" = "http",
    private readonly jwtJwks: Record<string, HttpApiJwtJwks> = {},
    private readonly allowRemoteJwtJwks = false,
    private readonly allowPrivateJwtJwks = false,
    private readonly webSocket?: ApiGatewayWebSocketService,
    private readonly sqs?: SqsService,
    private readonly cognitoIssuerKeys?: CognitoIssuerKeySource,
  ) {}

  private get apis(): Record<string, HttpApiState> { return this.store.regionState(this.region).httpApis; }
  private get domains(): Record<string, ApiGatewayV2DomainNameState> { return this.store.regionState(this.region).apiGatewayV2DomainNames; }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private currentInvokePort(): number { return typeof this.invokePort === "function" ? this.invokePort() : this.invokePort; }

  private assertGatewayRole(roleArn: unknown, label: string, runtime = false): void {
    if (roleArn === undefined || roleArn === null || roleArn === "") return;
    const role = typeof roleArn === "string" ? Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === roleArn) : undefined;
    if (!role || evaluateTrust(role.assumeRolePolicyDocument, "apigateway.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "apigateway.amazonaws.com" }).decision !== "allowed") {
      throw runtime
        ? new AwsError("InternalServerErrorException", `API Gateway cannot assume the configured ${label} role`, 500)
        : new AwsError("BadRequestException", `API Gateway cannot assume the configured ${label} role`);
    }
  }

  private replayCreated<T extends { cloudFormationOperationToken?: string }>(existing: T | undefined, operationToken: string | undefined, resource: string): T | undefined {
    if (!existing || !operationToken) return undefined;
    if (existing.cloudFormationOperationToken === operationToken) return existing;
    throw new AwsError("ConflictException", `A different ${resource} already uses the derived CloudFormation identifier`, 409);
  }

  hasApi(apiId: string): boolean { return Boolean(this.apis[apiId]) || Boolean(this.webSocket?.hasApi(apiId)); }

  private api(apiId: string): HttpApiState {
    const api = this.apis[apiId];
    if (!api) throw new AwsError("NotFoundException", `Invalid API identifier specified ${apiId}`, 404);
    return api;
  }

  private integration(api: HttpApiState, integrationId: string): HttpApiIntegrationState {
    const integration = api.integrations[integrationId];
    if (!integration) throw new AwsError("NotFoundException", `Invalid Integration identifier specified ${integrationId}`, 404);
    return integration;
  }

  private route(api: HttpApiState, routeId: string): HttpApiRouteState {
    const route = api.routes[routeId];
    if (!route) throw new AwsError("NotFoundException", `Invalid Route identifier specified ${routeId}`, 404);
    return route;
  }

  private authorizer(api: HttpApiState, authorizerId: string): HttpApiAuthorizerState {
    const authorizer = api.authorizers[authorizerId];
    if (!authorizer) throw new AwsError("NotFoundException", `Invalid Authorizer identifier specified ${authorizerId}`, 404);
    return authorizer;
  }

  private deployment(api: HttpApiState, deploymentId: string): HttpApiDeploymentState {
    const deployment = api.deployments[deploymentId];
    if (!deployment) throw new AwsError("NotFoundException", `Invalid Deployment identifier specified ${deploymentId}`, 404);
    return deployment;
  }

  private stage(api: HttpApiState, stageName: string): HttpApiStageState {
    const stage = api.stages[stageName];
    if (!stage) throw new AwsError("NotFoundException", `Invalid Stage identifier specified ${stageName}`, 404);
    return stage;
  }

  private domain(value: string): ApiGatewayV2DomainNameState {
    const name = this.normalizeDomainName(value);
    const domain = this.domains[name];
    if (!domain) throw new AwsError("NotFoundException", `Invalid DomainName identifier specified ${value}`, 404);
    return domain;
  }

  private normalizeDomainName(value: unknown): string {
    const name = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
    const labels = name.replace(/^\*\./, "").split(".");
    if (name.length > 253 || labels.length < 2 || labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || name.includes("*") && !name.startsWith("*.")) throw new AwsError("BadRequestException", "DomainName must be a valid DNS host name");
    return name;
  }

  private tags(input: unknown): Record<string, string> {
    if (input === undefined) return {};
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AwsError("BadRequestException", "Tags must be a map");
    const tags: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      const value = String(raw);
      if (!key || key.length > 128 || value.length > 256 || key.toLowerCase().startsWith("aws:")) throw new AwsError("BadRequestException", "Invalid tag");
      tags[key] = value;
    }
    if (Object.keys(tags).length > 50) throw new AwsError("BadRequestException", "A resource can have at most 50 tags");
    return tags;
  }

  private page<T>(operation: string, scope: string, values: T[], url: URL): { items: T[]; nextToken?: string } {
    const max = Math.min(500, Math.max(1, Number(url.searchParams.get("maxResults") ?? 25)));
    if (!Number.isInteger(max)) throw new AwsError("BadRequestException", "MaxResults must be an integer");
    let start = 0;
    const token = url.searchParams.get("nextToken");
    if (token) {
      try { const cursor = this.tokens.decode<{ scope: string; index: number }>(operation, token); if (cursor.scope !== scope || !Number.isInteger(cursor.index) || cursor.index < 0 || cursor.index > values.length) throw new Error(); start = cursor.index; }
      catch { throw new AwsError("BadRequestException", "Invalid NextToken"); }
    }
    const items = values.slice(start, start + max);
    const next = start + items.length;
    return { items, ...(next < values.length ? { nextToken: this.tokens.encode(operation, { scope, index: next }) } : {}) };
  }

  private snapshot(api: HttpApiState): HttpApiDeploymentSnapshotState {
    return structuredClone({ routes: api.routes, integrations: api.integrations, authorizers: api.authorizers, models: api.models, corsConfiguration: api.corsConfiguration });
  }

  private contentHash(snapshot: HttpApiDeploymentSnapshotState): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  private createDeploymentState(api: HttpApiState, description?: string, autoDeployed = false): HttpApiDeploymentState {
    const snapshot = this.snapshot(api);
    return { deploymentId: id(10), description, createdDate: this.clock.now(), deploymentStatus: "SUCCEEDED", autoDeployed, snapshot, contentHash: this.contentHash(snapshot) };
  }

  private async autoDeploy(api: HttpApiState): Promise<void> {
    const stages = Object.values(api.stages).filter(stage => stage.autoDeploy);
    if (!stages.length) { await this.store.save(); return; }
    const deployment = this.createDeploymentState(api, "Automatic deployment", true);
    api.deployments[deployment.deploymentId] = deployment;
    for (const stage of stages) { stage.deploymentId = deployment.deploymentId; stage.lastUpdatedDate = this.clock.now(); stage.lastDeploymentStatusMessage = "Deployment completed successfully."; }
    await this.store.save();
  }

  private validateCors(value: unknown): HttpApiCorsState | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "CorsConfiguration must be an object");
    const input = value as any;
    const list = (name: string, limit: number): string[] | undefined => { if (input[name] === undefined) return undefined; if (!Array.isArray(input[name]) || input[name].length > limit || input[name].some((item: unknown) => typeof item !== "string" || !item)) throw new AwsError("BadRequestException", `Invalid ${name}`); return [...input[name]]; };
    const maxAge = input.maxAge === undefined ? undefined : Number(input.maxAge);
    if (maxAge !== undefined && (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > 86_400)) throw new AwsError("BadRequestException", "MaxAge must be between 0 and 86400");
    const allowOrigins = list("allowOrigins", 100); const allowCredentials = input.allowCredentials === undefined ? undefined : Boolean(input.allowCredentials);
    if (allowCredentials && allowOrigins?.includes("*")) throw new AwsError("BadRequestException", "AllowCredentials cannot be combined with a wildcard origin");
    return present({ allowCredentials, allowHeaders: list("allowHeaders", 100), allowMethods: list("allowMethods", 10), allowOrigins, exposeHeaders: list("exposeHeaders", 100), maxAge });
  }

  private validateRouteKey(value: unknown): string {
    const routeKey = String(value ?? "").trim();
    if (routeKey === "$default") return routeKey;
    const match = routeKey.match(/^([A-Z]+)\s+(\/.*)$/);
    if (!match || !METHODS.has(match[1]) || match[2].includes("?") || match[2].includes("#")) throw new AwsError("BadRequestException", "RouteKey must be $default or METHOD /path");
    const names = new Set<string>();
    const segments = match[2].split("/").slice(1);
    for (const [index, segment] of segments.entries()) if (segment.includes("{") || segment.includes("}")) {
      const parameter = segment.match(/^\{([A-Za-z0-9._-]+)(\+)?\}$/);
      if (!parameter || names.has(parameter[1]) || parameter[2] && index !== segments.length - 1) throw new AwsError("BadRequestException", "Invalid route path parameter");
      names.add(parameter[1]);
    }
    return routeKey;
  }

  private validateRouteReferences(api: HttpApiState, route: HttpApiRouteState, routeId?: string): void {
    if (Object.values(api.routes).some(value => value.routeKey === route.routeKey && value.routeId !== routeId)) throw new AwsError("ConflictException", "A route with this RouteKey already exists", 409);
    if (route.target !== undefined && !/^integrations\/[A-Za-z0-9]+$/.test(route.target)) throw new AwsError("BadRequestException", "Target must use integrations/{integrationId}");
    if (route.target && !api.integrations[route.target.slice("integrations/".length)]) throw new AwsError("BadRequestException", "The referenced integration does not exist");
    if (route.authorizationType === "CUSTOM" || route.authorizationType === "JWT") {
      if (!route.authorizerId || !api.authorizers[route.authorizerId]) throw new AwsError("BadRequestException", "AuthorizerId must reference an authorizer");
      const expected = route.authorizationType === "JWT" ? "JWT" : "REQUEST";
      if (api.authorizers[route.authorizerId].authorizerType !== expected) throw new AwsError("BadRequestException", "AuthorizationType does not match the authorizer type");
    } else if (route.authorizerId !== undefined) throw new AwsError("BadRequestException", "AuthorizerId is valid only for CUSTOM or JWT authorization");
  }

  private validateIntegration(input: any, existing?: HttpApiIntegrationState): HttpApiIntegrationState {
    const type = String(input.integrationType ?? existing?.integrationType ?? "") as HttpApiIntegrationState["integrationType"];
    if (!new Set(["AWS_PROXY", "HTTP_PROXY"]).has(type)) throw new AwsError("BadRequestException", "HTTP APIs support AWS_PROXY and HTTP_PROXY integrations");
    const subtype = input.integrationSubtype ?? existing?.integrationSubtype;
    if (subtype !== undefined && subtype !== "SQS-SendMessage") throw new AwsError("BadRequestException", `Unsupported AWS service integration subtype ${String(subtype)}`);
    const sqsIntegration = subtype === "SQS-SendMessage";
    if (sqsIntegration && type !== "AWS_PROXY") throw new AwsError("BadRequestException", "SQS-SendMessage requires AWS_PROXY");
    if (input.connectionType !== undefined && input.connectionType !== "INTERNET") throw new AwsError("BadRequestException", "VPC_LINK integrations are outside APIG-11");
    const rawUri = input.integrationUri ?? existing?.integrationUri;
    const uri = rawUri === undefined || rawUri === null || rawUri === "" ? undefined : String(rawUri);
    if (!sqsIntegration && !uri) throw new AwsError("BadRequestException", "IntegrationUri is required");
    if (type === "AWS_PROXY" && !sqsIntegration && !/^(?:arn:aws(?:-[a-z]+)?:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?|arn:aws:apigateway:[a-z0-9-]+:lambda:path\/2015-03-31\/functions\/arn:aws(?:-[a-z]+)?:lambda:[^/]+\/invocations)$/.test(uri!)) throw new AwsError("BadRequestException", "AWS_PROXY IntegrationUri must identify a Lambda function");
    if (type === "HTTP_PROXY") { try { const target = new URL(uri!); if (!new Set(["http:", "https:"]).has(target.protocol)) throw new Error(); } catch { throw new AwsError("BadRequestException", "HTTP_PROXY IntegrationUri must be an HTTP or HTTPS URL"); } }
    const payload = String(input.payloadFormatVersion ?? existing?.payloadFormatVersion ?? (type === "HTTP_PROXY" || sqsIntegration ? "1.0" : "2.0")) as "1.0" | "2.0";
    if (!new Set(["1.0", "2.0"]).has(payload)) throw new AwsError("BadRequestException", "PayloadFormatVersion must be 1.0 or 2.0");
    if ((type === "HTTP_PROXY" || sqsIntegration) && payload !== "1.0") throw new AwsError("BadRequestException", `${sqsIntegration ? "SQS-SendMessage" : "HTTP_PROXY"} integrations use payload format version 1.0`);
    if (input.tlsConfig !== undefined || existing?.tlsConfig) throw new AwsError("BadRequestException", "TlsConfig requires a VPC_LINK private integration, which is outside APIG-11");
    const timeout = Number(input.timeoutInMillis ?? existing?.timeoutInMillis ?? 30_000);
    if (!Number.isInteger(timeout) || timeout < 50 || timeout > 30_000) throw new AwsError("BadRequestException", "TimeoutInMillis must be between 50 and 30000");
    const method = input.integrationMethod ?? existing?.integrationMethod ?? (type === "AWS_PROXY" ? "POST" : "ANY");
    if (method !== undefined && !METHODS.has(String(method).toUpperCase())) throw new AwsError("BadRequestException", "Invalid IntegrationMethod");
    if (sqsIntegration && String(method).toUpperCase() !== "POST") throw new AwsError("BadRequestException", "SQS-SendMessage uses POST");
    const requestParameters = input.requestParameters ?? existing?.requestParameters ?? {};
    const responseParameters = input.responseParameters ?? existing?.responseParameters ?? {};
    if (!requestParameters || typeof requestParameters !== "object" || Array.isArray(requestParameters) || !responseParameters || typeof responseParameters !== "object" || Array.isArray(responseParameters)) throw new AwsError("BadRequestException", "Parameter mappings must be maps");
    if (sqsIntegration) {
      const allowed = new Set(["QueueUrl", "MessageBody", "DelaySeconds", "MessageAttributes", "MessageDeduplicationId", "MessageGroupId", "MessageSystemAttributes", "Region"]);
      for (const [key, expression] of Object.entries(requestParameters)) if (!allowed.has(key) || typeof expression !== "string") throw new AwsError("BadRequestException", `Invalid SQS-SendMessage request parameter ${key}`);
      for (const required of ["QueueUrl", "MessageBody"]) if (typeof requestParameters[required] !== "string" || !requestParameters[required]) throw new AwsError("BadRequestException", `${required} is required for SQS-SendMessage`);
    } else for (const [key, expression] of Object.entries(requestParameters)) if (!(key === "overwrite:path" || /^(?:append|overwrite|remove):(?:header|querystring)\.[A-Za-z0-9._-]+$/i.test(key)) || typeof expression !== "string") throw new AwsError("BadRequestException", `Invalid request parameter mapping ${key}`);
    for (const [status, mappings] of Object.entries(responseParameters)) {
      if (!(status === "$default" || /^[1-5][0-9]{2}$/.test(status)) || !mappings || typeof mappings !== "object" || Array.isArray(mappings)) throw new AwsError("BadRequestException", `Invalid response parameter mapping status ${status}`);
      for (const [key, expression] of Object.entries(mappings as Record<string, unknown>)) if (!(key === "overwrite:statuscode" || /^(?:append|overwrite|remove):header\.[A-Za-z0-9._-]+$/i.test(key)) || typeof expression !== "string") throw new AwsError("BadRequestException", `Invalid response parameter mapping ${key}`);
    }
    const credentialsArn = input.credentialsArn ?? existing?.credentialsArn;
    if (sqsIntegration && !credentialsArn) throw new AwsError("BadRequestException", "CredentialsArn is required for SQS-SendMessage");
    this.assertGatewayRole(credentialsArn, sqsIntegration ? "SQS integration" : "integration");
    return {
      integrationId: existing?.integrationId ?? id(10), description: input.description ?? existing?.description,
      integrationType: type, integrationSubtype: subtype,
      integrationMethod: String(method).toUpperCase(), integrationUri: uri,
      credentialsArn, connectionType: "INTERNET",
      requestParameters: structuredClone(requestParameters), responseParameters: structuredClone(responseParameters),
      timeoutInMillis: timeout, payloadFormatVersion: payload, tlsConfig: structuredClone(input.tlsConfig ?? existing?.tlsConfig),
      apiGatewayManaged: existing?.apiGatewayManaged ?? false,
      cloudFormationOperationToken: existing?.cloudFormationOperationToken,
    };
  }

  private validateAuthorizer(input: any, existing?: HttpApiAuthorizerState): HttpApiAuthorizerState {
    const type = String(input.authorizerType ?? existing?.authorizerType ?? "") as HttpApiAuthorizerState["authorizerType"];
    if (!new Set(["REQUEST", "JWT"]).has(type)) throw new AwsError("BadRequestException", "AuthorizerType must be REQUEST or JWT");
    const name = String(input.name ?? existing?.name ?? "").trim();
    if (!name || name.length > 128) throw new AwsError("BadRequestException", "Name is required");
    const ttl = Number(input.authorizerResultTtlInSeconds ?? existing?.authorizerResultTtlInSeconds ?? 300);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 3600) throw new AwsError("BadRequestException", "AuthorizerResultTtlInSeconds must be between 0 and 3600");
    const identitySource = input.identitySource ?? existing?.identitySource ?? [];
    if (!Array.isArray(identitySource) || identitySource.some((item: unknown) => typeof item !== "string" || !String(item).startsWith("$request."))) throw new AwsError("BadRequestException", "IdentitySource entries must use $request selection expressions");
    if (type === "JWT") {
      if (identitySource.length !== 1 || !/^\$request\.(?:header|querystring)\.[A-Za-z0-9._-]+$/i.test(identitySource[0])) throw new AwsError("BadRequestException", "JWT authorizers require one header or query string IdentitySource");
      const jwt = input.jwtConfiguration ?? existing?.jwtConfiguration;
      if (!jwt?.issuer || !Array.isArray(jwt.audience) || !jwt.audience.length) throw new AwsError("BadRequestException", "JwtConfiguration issuer and audience are required");
      try { new URL(jwt.issuer); } catch { throw new AwsError("BadRequestException", "JWT issuer must be a URL"); }
      if (input.authorizerUri !== undefined || existing?.authorizerUri) throw new AwsError("BadRequestException", "AuthorizerUri is not valid for JWT authorizers");
      return { authorizerId: existing?.authorizerId ?? id(10), name, authorizerType: type, identitySource: [...identitySource], authorizerResultTtlInSeconds: ttl, jwtConfiguration: { issuer: String(jwt.issuer).replace(/\/$/, ""), audience: jwt.audience.map(String) }, cloudFormationOperationToken: existing?.cloudFormationOperationToken };
    }
    const uri = String(input.authorizerUri ?? existing?.authorizerUri ?? "");
    if (!uri) throw new AwsError("BadRequestException", "AuthorizerUri is required for REQUEST authorizers");
    if (ttl > 0 && !identitySource.length) throw new AwsError("BadRequestException", "IdentitySource is required when authorizer caching is enabled");
    const payload = String(input.authorizerPayloadFormatVersion ?? existing?.authorizerPayloadFormatVersion ?? "2.0") as "1.0" | "2.0";
    if (!new Set(["1.0", "2.0"]).has(payload)) throw new AwsError("BadRequestException", "AuthorizerPayloadFormatVersion must be 1.0 or 2.0");
    const simple = input.enableSimpleResponses ?? existing?.enableSimpleResponses ?? false;
    if (simple && payload !== "2.0") throw new AwsError("BadRequestException", "Simple responses require payload format 2.0");
    const authorizerCredentialsArn = input.authorizerCredentialsArn ?? existing?.authorizerCredentialsArn;
    this.assertGatewayRole(authorizerCredentialsArn, "authorizer");
    return { authorizerId: existing?.authorizerId ?? id(10), name, authorizerType: type, authorizerUri: uri, authorizerCredentialsArn, identitySource: [...identitySource], authorizerPayloadFormatVersion: payload, authorizerResultTtlInSeconds: ttl, enableSimpleResponses: Boolean(simple), cloudFormationOperationToken: existing?.cloudFormationOperationToken };
  }

  private routeSettings(value: any, existing: HttpApiRouteSettingsState = {}): HttpApiRouteSettingsState {
    if (value === undefined) return structuredClone(existing);
    const result: HttpApiRouteSettingsState = { ...existing };
    if (value.detailedMetricsEnabled !== undefined) result.detailedMetricsEnabled = Boolean(value.detailedMetricsEnabled);
    if (value.throttlingBurstLimit !== undefined) { const burst = Number(value.throttlingBurstLimit); if (!Number.isInteger(burst) || burst < 0) throw new AwsError("BadRequestException", "ThrottlingBurstLimit must be a non-negative integer"); result.throttlingBurstLimit = burst; }
    if (value.throttlingRateLimit !== undefined) { const rate = Number(value.throttlingRateLimit); if (!Number.isFinite(rate) || rate < 0) throw new AwsError("BadRequestException", "ThrottlingRateLimit must be non-negative"); result.throttlingRateLimit = rate; }
    return result;
  }

  private stageVariables(value: unknown, existing: Record<string, string> = {}): Record<string, string> {
    if (value === undefined) return structuredClone(existing);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "StageVariables must be a map");
    const variables: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9]+$/.test(key) || typeof raw !== "string" || !raw || raw.length > 512 || !/^[A-Za-z0-9\-._~:/?#&=,]+$/.test(raw)) throw new AwsError("BadRequestException", "Invalid stage variable");
      variables[key] = raw;
    }
    return variables;
  }

  private accessLogSettings(value: unknown, existing?: HttpApiStageState["accessLogSettings"]): HttpApiStageState["accessLogSettings"] {
    if (value === undefined) return structuredClone(existing);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "AccessLogSettings must be an object");
    const input = value as Record<string, unknown>; const destinationArn = String(input.destinationArn ?? existing?.destinationArn ?? ""); const format = String(input.format ?? existing?.format ?? "");
    const arn = new RegExp(`^arn:aws(?:-[a-z]+)?:logs:${this.region}:${this.store.accountId}:log-group:[^:*]+(?::\\*)?$`);
    if (!arn.test(destinationArn)) throw new AwsError("BadRequestException", "DestinationArn must identify a local CloudWatch Logs log group");
    if (!format || format.length > 1024 || !/\$context\.(?:requestId|extendedRequestId)\b/.test(format)) throw new AwsError("BadRequestException", "Access log format must include $context.requestId or $context.extendedRequestId");
    return { destinationArn, format };
  }

  private stageRouteSettings(api: HttpApiState, value: unknown): Record<string, HttpApiRouteSettingsState> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "RouteSettings must be a map");
    const validKeys = new Set(Object.values(api.routes).map(route => route.routeKey)); const settings: Record<string, HttpApiRouteSettingsState> = {};
    for (const [key, routeSetting] of Object.entries(value as Record<string, unknown>)) { if (!validKeys.has(key)) throw new AwsError("BadRequestException", `RouteSettings references unknown route ${key}`); settings[key] = this.routeSettings(routeSetting); }
    return settings;
  }

  private async createApi(input: any, operationToken?: string): Promise<HttpApiState> {
    if (input.protocolType !== "HTTP") throw new AwsError("BadRequestException", "APIG-11 supports ProtocolType HTTP; WebSocket APIs are implemented in APIG-12");
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 128) throw new AwsError("BadRequestException", "Name is required and must not exceed 128 characters");
    const routeSelectionExpression = input.routeSelectionExpression ?? "${request.method} ${request.path}";
    if (!["${request.method} ${request.path}", "$request.method $request.path"].includes(routeSelectionExpression)) throw new AwsError("BadRequestException", "HTTP APIs use the standard route selection expression");
    const apiId = cloudFormationResourceId(operationToken, "api") ?? id(10);
    const replay = this.apis[apiId];
    if (replay) {
      if (operationToken && replay.cloudFormationOperationToken === operationToken) return replay;
      throw new AwsError("ConflictException", "An API with this identifier already exists", 409);
    }
    const api: HttpApiState = {
      apiId, name, description: input.description, version: input.version, protocolType: "HTTP",
      ipAddressType: input.ipAddressType ?? "ipv4", routeSelectionExpression,
      apiEndpoint: `${this.invokeProtocol}://localhost:${this.currentInvokePort()}/${apiId}`, apiGatewayManaged: false,
      createdDate: this.clock.now(), tags: this.tags(input.tags), corsConfiguration: this.validateCors(input.corsConfiguration),
      disableExecuteApiEndpoint: Boolean(input.disableExecuteApiEndpoint), integrations: {}, routes: {}, authorizers: {}, deployments: {}, stages: {}, models: {},
      cloudFormationOperationToken: operationToken,
    };
    if (!new Set(["ipv4", "dualstack"]).has(api.ipAddressType)) throw new AwsError("BadRequestException", "IpAddressType must be ipv4 or dualstack");
    if (input.target !== undefined) {
      const integration = this.validateIntegration({ integrationType: "AWS_PROXY", integrationUri: input.target, credentialsArn: input.credentialsArn, payloadFormatVersion: "2.0" });
      if (operationToken) { integration.integrationId = cloudFormationResourceId(operationToken, "quick-integration")!; integration.cloudFormationOperationToken = cloudFormationChildToken(operationToken, "quick-integration"); }
      integration.apiGatewayManaged = true; api.integrations[integration.integrationId] = integration;
      const route: HttpApiRouteState = { routeId: cloudFormationResourceId(operationToken, "quick-route") ?? id(10), routeKey: this.validateRouteKey(input.routeKey ?? "$default"), authorizationType: "NONE", authorizationScopes: [], target: `integrations/${integration.integrationId}`, apiGatewayManaged: true, ...(operationToken ? { cloudFormationOperationToken: cloudFormationChildToken(operationToken, "quick-route") } : {}) };
      api.routes[route.routeId] = route;
      const now = this.clock.now(); const stage: HttpApiStageState = { stageName: "$default", defaultRouteSettings: {}, routeSettings: {}, stageVariables: {}, autoDeploy: true, createdDate: now, lastUpdatedDate: now, tags: {}, apiGatewayManaged: true, ...(operationToken ? { cloudFormationOperationToken: cloudFormationChildToken(operationToken, "quick-stage") } : {}) };
      api.stages[stage.stageName] = stage;
      const deployment = this.createDeploymentState(api, "Automatic deployment", true); api.deployments[deployment.deploymentId] = deployment; stage.deploymentId = deployment.deploymentId;
      if (operationToken) { const deploymentId = cloudFormationResourceId(operationToken, "quick-deployment")!; delete api.deployments[deployment.deploymentId]; deployment.deploymentId = deploymentId; deployment.cloudFormationOperationToken = cloudFormationChildToken(operationToken, "quick-deployment"); api.deployments[deploymentId] = deployment; stage.deploymentId = deploymentId; }
    }
    this.apis[apiId] = api;
    await this.store.save();
    return api;
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    try {
      if (pathname === "/v2/apis") {
        if (req.method === "POST") { const input = await readJson(req); const operationToken = getCloudFormationIdempotencyKey(req); const stableApiId = cloudFormationResourceId(operationToken, "api"); if (stableApiId) { const replay = this.replayCreated(this.apis[stableApiId], operationToken, "API"); if (replay) { if (input.protocolType !== "HTTP") throw new AwsError("ConflictException", "The CloudFormation operation token is already bound to an HTTP API", 409); return json(res, apiView(replay), 201); } if (this.webSocket?.hasApi(stableApiId) && input.protocolType !== "WEBSOCKET") throw new AwsError("ConflictException", "A different API already uses the derived CloudFormation identifier", 409); } if (input.protocolType === "WEBSOCKET") { if (!this.webSocket) throw new AwsError("BadRequestException", "WebSocket APIs are unavailable"); return json(res, webSocketApiView(await this.webSocket.createApi(input, operationToken)), 201); } return json(res, apiView(await this.createApi(input, operationToken)), 201); }
        if (req.method === "GET") { const values = [...Object.values(this.apis).map(apiView), ...(this.webSocket?.apiViews() ?? [])].sort((a, b) => a.apiId.localeCompare(b.apiId)); return json(res, this.page("GetApis", "apis", values, url)); }
      }

      if (pathname.startsWith("/v2/tags/")) {
        let arn: string; try { arn = decodeURIComponent(pathname.slice("/v2/tags/".length)); } catch { throw new AwsError("BadRequestException", "Invalid resource ARN"); }
        const target = this.tagTarget(arn);
        if (req.method === "GET") return json(res, { tags: structuredClone(target.tags) });
        if (req.method === "POST") { target.set(this.tags({ ...target.tags, ...(await readJson(req)).tags })); await this.store.save(); res.statusCode = 204; res.end(); return; }
        if (req.method === "DELETE") { const keys = url.searchParams.getAll("tagKeys"); const tags = { ...target.tags }; for (const key of keys) delete tags[key]; target.set(tags); await this.store.save(); res.statusCode = 204; res.end(); return; }
      }

      if (pathname === "/v2/domainnames") {
        if (req.method === "POST") { const input = await readJson(req); const operationToken = getCloudFormationIdempotencyKey(req); const domainName = this.normalizeDomainName(input.domainName); const replay = this.replayCreated(this.domains[domainName], operationToken, "domain name"); if (replay) return json(res, domainView(replay), 201); const domain = this.createDomain(input, operationToken); this.domains[domain.domainName] = domain; await this.store.save(); return json(res, domainView(domain), 201); }
        if (req.method === "GET") { const values = Object.values(this.domains).sort((a, b) => a.domainName.localeCompare(b.domainName)).map(domainView); return json(res, this.page("GetDomainNamesV2", "domains", values, url)); }
      }

      const domainMatch = pathname.match(/^\/v2\/domainnames\/([^/]+)(.*)$/);
      if (domainMatch) {
        const name = decodeURIComponent(domainMatch[1]); const domain = this.domain(name); const suffix = domainMatch[2];
        if (!suffix) {
          if (req.method === "GET") return json(res, domainView(domain));
          if (req.method === "PATCH") { const updated = this.updateDomain(domain, await readJson(req)); if (updated.domainName !== domain.domainName) { delete this.domains[domain.domainName]; this.domains[updated.domainName] = updated; } else this.domains[domain.domainName] = updated; await this.store.save(); return json(res, domainView(updated)); }
          if (req.method === "DELETE") { delete this.domains[domain.domainName]; await this.store.save(); res.statusCode = 204; res.end(); return; }
        }
        if (suffix === "/apimappings") {
          if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const mappingId = cloudFormationResourceId(operationToken, "api-mapping"); const replay = mappingId ? this.replayCreated(domain.apiMappings[mappingId], operationToken, "API mapping") : undefined; if (replay) return json(res, mappingView(replay), 201); const mapping = this.createMapping(domain, await readJson(req), operationToken); domain.apiMappings[mapping.apiMappingId] = mapping; domain.lastUpdatedDate = this.clock.now(); await this.store.save(); return json(res, mappingView(mapping), 201); }
          if (req.method === "GET") { const values = Object.values(domain.apiMappings).sort((a, b) => (a.apiMappingKey ?? "").localeCompare(b.apiMappingKey ?? "")).map(mappingView); return json(res, this.page("GetApiMappings", domain.domainName, values, url)); }
        }
        const mappingMatch = suffix.match(/^\/apimappings\/([^/]+)$/);
        if (mappingMatch) {
          const mapping = domain.apiMappings[decodeURIComponent(mappingMatch[1])]; if (!mapping) throw new AwsError("NotFoundException", "Invalid ApiMapping identifier specified", 404);
          if (req.method === "GET") return json(res, mappingView(mapping));
          if (req.method === "PATCH") { const input = await readJson(req); const candidate = { ...mapping, apiId: input.apiId ?? mapping.apiId, apiMappingKey: input.apiMappingKey === undefined ? mapping.apiMappingKey : this.mappingKey(input.apiMappingKey), stage: input.stage ?? mapping.stage }; this.validateMapping(domain, candidate, mapping.apiMappingId); Object.assign(mapping, candidate); domain.lastUpdatedDate = this.clock.now(); await this.store.save(); return json(res, mappingView(mapping)); }
          if (req.method === "DELETE") { delete domain.apiMappings[mapping.apiMappingId]; domain.lastUpdatedDate = this.clock.now(); await this.store.save(); res.statusCode = 204; res.end(); return; }
        }
        throw new AwsError("NotFoundException", "Unknown API Gateway v2 domain route", 404);
      }

      const apiMatch = pathname.match(/^\/v2\/apis\/([^/]+)(.*)$/);
      if (!apiMatch) throw new AwsError("NotFoundException", "Unknown API Gateway v2 route", 404);
      if (this.webSocket?.hasApi(decodeURIComponent(apiMatch[1]))) {
        await this.webSocket.handle(req, res, pathname, url);
        if (req.method === "DELETE" && !apiMatch[2] && res.statusCode < 300) {
          for (const domain of Object.values(this.domains)) for (const [mappingId, mapping] of Object.entries(domain.apiMappings)) if (mapping.apiId === decodeURIComponent(apiMatch[1])) delete domain.apiMappings[mappingId];
          await this.store.save();
        }
        return;
      }
      const api = this.api(decodeURIComponent(apiMatch[1])); const suffix = apiMatch[2];

      if (!suffix) {
        if (req.method === "GET") return json(res, apiView(api));
        if (req.method === "PATCH") { const input = await readJson(req); const candidate = structuredClone(api); if (input.protocolType !== undefined && input.protocolType !== "HTTP") throw new AwsError("BadRequestException", "ProtocolType cannot be changed"); if (input.name !== undefined) { const name = String(input.name).trim(); if (!name || name.length > 128) throw new AwsError("BadRequestException", "Invalid Name"); candidate.name = name; } if (input.description !== undefined) candidate.description = input.description; if (input.version !== undefined) candidate.version = input.version; if (input.disableExecuteApiEndpoint !== undefined) candidate.disableExecuteApiEndpoint = Boolean(input.disableExecuteApiEndpoint); if (input.corsConfiguration !== undefined) candidate.corsConfiguration = this.validateCors(input.corsConfiguration); if (input.ipAddressType !== undefined) { if (!new Set(["ipv4", "dualstack"]).has(input.ipAddressType)) throw new AwsError("BadRequestException", "Invalid IpAddressType"); candidate.ipAddressType = input.ipAddressType; } this.apis[api.apiId] = candidate; await this.autoDeploy(candidate); return json(res, apiView(candidate)); }
        if (req.method === "DELETE") { delete this.apis[api.apiId]; for (const domain of Object.values(this.domains)) for (const [mappingId, mapping] of Object.entries(domain.apiMappings)) if (mapping.apiId === api.apiId) delete domain.apiMappings[mappingId]; await this.store.save(); res.statusCode = 204; res.end(); return; }
      }

      if (suffix === "/cors" && req.method === "DELETE") { delete api.corsConfiguration; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; }
      if (suffix === "/models" || /^\/models\//.test(suffix)) throw new AwsError("BadRequestException", "Models are supported only for WebSocket APIs", 400);

      if (suffix === "/integrations") {
        if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const integrationId = cloudFormationResourceId(operationToken, "integration"); const replay = integrationId ? this.replayCreated(api.integrations[integrationId], operationToken, "integration") : undefined; if (replay) return json(res, integrationView(replay), 201); const integration = this.validateIntegration(await readJson(req)); if (operationToken) { integration.integrationId = integrationId!; integration.cloudFormationOperationToken = operationToken; } api.integrations[integration.integrationId] = integration; await this.autoDeploy(api); return json(res, integrationView(integration), 201); }
        if (req.method === "GET") { const values = Object.values(api.integrations).sort((a, b) => a.integrationId.localeCompare(b.integrationId)).map(integrationView); return json(res, this.page("GetIntegrations", api.apiId, values, url)); }
      }
      const integrationMatch = suffix.match(/^\/integrations\/([^/]+)$/);
      if (integrationMatch) {
        const integration = this.integration(api, decodeURIComponent(integrationMatch[1]));
        if (req.method === "GET") return json(res, integrationView(integration));
        if (req.method === "PATCH") { const candidate = this.validateIntegration(await readJson(req), integration); api.integrations[integration.integrationId] = candidate; await this.autoDeploy(api); return json(res, integrationView(candidate)); }
        if (req.method === "DELETE") { if (Object.values(api.routes).some(route => route.target === `integrations/${integration.integrationId}`)) throw new AwsError("ConflictException", "The integration is referenced by a route", 409); delete api.integrations[integration.integrationId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; }
      }

      if (suffix === "/authorizers") {
        if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const authorizerId = cloudFormationResourceId(operationToken, "authorizer"); const replay = authorizerId ? this.replayCreated(api.authorizers[authorizerId], operationToken, "authorizer") : undefined; if (replay) return json(res, authorizerView(replay), 201); const authorizer = this.validateAuthorizer(await readJson(req)); if (operationToken) { authorizer.authorizerId = authorizerId!; authorizer.cloudFormationOperationToken = operationToken; } if (Object.values(api.authorizers).some(value => value.name === authorizer.name)) throw new AwsError("ConflictException", "An authorizer with this name already exists", 409); api.authorizers[authorizer.authorizerId] = authorizer; await this.autoDeploy(api); return json(res, authorizerView(authorizer), 201); }
        if (req.method === "GET") { const values = Object.values(api.authorizers).sort((a, b) => a.authorizerId.localeCompare(b.authorizerId)).map(authorizerView); return json(res, this.page("GetAuthorizers", api.apiId, values, url)); }
      }
      const authorizerMatch = suffix.match(/^\/authorizers\/([^/]+)$/);
      if (authorizerMatch) {
        const authorizer = this.authorizer(api, decodeURIComponent(authorizerMatch[1]));
        if (req.method === "GET") return json(res, authorizerView(authorizer));
        if (req.method === "PATCH") { const candidate = this.validateAuthorizer(await readJson(req), authorizer); if (Object.values(api.authorizers).some(value => value.name === candidate.name && value.authorizerId !== authorizer.authorizerId)) throw new AwsError("ConflictException", "An authorizer with this name already exists", 409); api.authorizers[authorizer.authorizerId] = candidate; this.clearAuthorizerCache(api.apiId, authorizer.authorizerId); await this.autoDeploy(api); return json(res, authorizerView(candidate)); }
        if (req.method === "DELETE") { if (Object.values(api.routes).some(route => route.authorizerId === authorizer.authorizerId)) throw new AwsError("ConflictException", "The authorizer is referenced by a route", 409); delete api.authorizers[authorizer.authorizerId]; this.clearAuthorizerCache(api.apiId, authorizer.authorizerId); await this.autoDeploy(api); res.statusCode = 204; res.end(); return; }
      }

      if (suffix === "/routes") {
        if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const routeId = cloudFormationResourceId(operationToken, "route"); const replay = routeId ? this.replayCreated(api.routes[routeId], operationToken, "route") : undefined; if (replay) return json(res, routeView(replay), 201); const input = await readJson(req); const authorizationType = String(input.authorizationType ?? "NONE") as HttpApiRouteState["authorizationType"]; if (!AUTHORIZATION_TYPES.has(authorizationType)) throw new AwsError("BadRequestException", "Invalid AuthorizationType"); const route: HttpApiRouteState = { routeId: routeId ?? id(10), routeKey: this.validateRouteKey(input.routeKey), authorizationType, authorizerId: input.authorizerId, authorizationScopes: Array.isArray(input.authorizationScopes) ? input.authorizationScopes.map(String) : [], target: input.target, operationName: input.operationName, apiGatewayManaged: false, cloudFormationOperationToken: operationToken }; this.validateRouteReferences(api, route); api.routes[route.routeId] = route; await this.autoDeploy(api); return json(res, routeView(route), 201); }
        if (req.method === "GET") { const values = Object.values(api.routes).sort((a, b) => a.routeKey.localeCompare(b.routeKey)).map(routeView); return json(res, this.page("GetRoutes", api.apiId, values, url)); }
      }
      const routeMatch = suffix.match(/^\/routes\/([^/]+)$/);
      if (routeMatch) {
        const route = this.route(api, decodeURIComponent(routeMatch[1]));
        if (req.method === "GET") return json(res, routeView(route));
        if (req.method === "PATCH") { const input = await readJson(req); const candidate: HttpApiRouteState = { ...route, routeKey: input.routeKey === undefined ? route.routeKey : this.validateRouteKey(input.routeKey), authorizationType: input.authorizationType ?? route.authorizationType, authorizerId: input.authorizerId === undefined ? route.authorizerId : input.authorizerId || undefined, authorizationScopes: input.authorizationScopes === undefined ? route.authorizationScopes : input.authorizationScopes.map(String), target: input.target === undefined ? route.target : input.target || undefined, operationName: input.operationName === undefined ? route.operationName : input.operationName || undefined }; if (!AUTHORIZATION_TYPES.has(candidate.authorizationType)) throw new AwsError("BadRequestException", "Invalid AuthorizationType"); this.validateRouteReferences(api, candidate, route.routeId); api.routes[route.routeId] = candidate; await this.autoDeploy(api); return json(res, routeView(candidate)); }
        if (req.method === "DELETE") { delete api.routes[route.routeId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; }
      }

      if (suffix === "/deployments") {
        if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const deploymentId = cloudFormationResourceId(operationToken, "deployment"); const replay = deploymentId ? this.replayCreated(api.deployments[deploymentId], operationToken, "deployment") : undefined; if (replay) return json(res, deploymentView(replay), 201); const input = await readJson(req); const targetStage = input.stageName === undefined ? undefined : this.stage(api, String(input.stageName)); const deployment = this.createDeploymentState(api, input.description, false); if (operationToken) { deployment.deploymentId = deploymentId!; deployment.cloudFormationOperationToken = operationToken; } api.deployments[deployment.deploymentId] = deployment; if (targetStage) { targetStage.deploymentId = deployment.deploymentId; targetStage.lastUpdatedDate = this.clock.now(); } await this.store.save(); return json(res, deploymentView(deployment), 201); }
        if (req.method === "GET") { const values = Object.values(api.deployments).sort((a, b) => a.createdDate - b.createdDate || a.deploymentId.localeCompare(b.deploymentId)).map(deploymentView); return json(res, this.page("GetDeployments", api.apiId, values, url)); }
      }
      const deploymentMatch = suffix.match(/^\/deployments\/([^/]+)$/);
      if (deploymentMatch) {
        const deployment = this.deployment(api, decodeURIComponent(deploymentMatch[1]));
        if (req.method === "GET") return json(res, deploymentView(deployment));
        if (req.method === "PATCH") { const input = await readJson(req); if (input.description !== undefined) deployment.description = input.description; await this.store.save(); return json(res, deploymentView(deployment)); }
        if (req.method === "DELETE") { if (Object.values(api.stages).some(stage => stage.deploymentId === deployment.deploymentId)) throw new AwsError("ConflictException", "The deployment is referenced by a stage", 409); delete api.deployments[deployment.deploymentId]; await this.store.save(); res.statusCode = 204; res.end(); return; }
      }

      if (suffix === "/stages") {
        if (req.method === "POST") { const input = await readJson(req); const name = String(input.stageName ?? ""); if (!name || name.length > 128 || name !== "$default" && !/^[A-Za-z0-9_-]+$/.test(name)) throw new AwsError("BadRequestException", "Invalid StageName"); const operationToken = getCloudFormationIdempotencyKey(req); const replay = this.replayCreated(api.stages[name], operationToken, "stage"); if (replay) return json(res, stageView(replay), 201); if (api.stages[name]) throw new AwsError("ConflictException", "A stage with this name already exists", 409); if (input.deploymentId !== undefined) this.deployment(api, String(input.deploymentId)); const now = this.clock.now(); const stage: HttpApiStageState = { stageName: name, description: input.description, deploymentId: input.deploymentId, defaultRouteSettings: this.routeSettings(input.defaultRouteSettings), routeSettings: this.stageRouteSettings(api, input.routeSettings), stageVariables: this.stageVariables(input.stageVariables), accessLogSettings: this.accessLogSettings(input.accessLogSettings), autoDeploy: Boolean(input.autoDeploy), createdDate: now, lastUpdatedDate: now, tags: this.tags(input.tags), apiGatewayManaged: false, cloudFormationOperationToken: operationToken }; api.stages[name] = stage; if (stage.autoDeploy && !stage.deploymentId) { const deployment = this.createDeploymentState(api, "Automatic deployment", true); api.deployments[deployment.deploymentId] = deployment; stage.deploymentId = deployment.deploymentId; } await this.store.save(); return json(res, stageView(stage), 201); }
        if (req.method === "GET") { const values = Object.values(api.stages).sort((a, b) => a.stageName.localeCompare(b.stageName)).map(stageView); return json(res, this.page("GetStages", api.apiId, values, url)); }
      }
      const stageMatch = suffix.match(/^\/stages\/([^/]+)(.*)$/);
      if (stageMatch) {
        const stage = this.stage(api, decodeURIComponent(stageMatch[1])); const tail = stageMatch[2];
        if (tail === "/accesslogsettings" && req.method === "DELETE") { delete stage.accessLogSettings; stage.lastUpdatedDate = this.clock.now(); await this.store.save(); res.statusCode = 204; res.end(); return; }
        const routeSettingsMatch = tail.match(/^\/routesettings\/(.+)$/); if (routeSettingsMatch && req.method === "DELETE") { delete stage.routeSettings[decodeURIComponent(routeSettingsMatch[1])]; stage.lastUpdatedDate = this.clock.now(); await this.store.save(); res.statusCode = 204; res.end(); return; }
        if (tail === "/cache/authorizers" && req.method === "DELETE") { this.clearAuthorizerCache(api.apiId); res.statusCode = 204; res.end(); return; }
        if (!tail) {
          if (req.method === "GET") return json(res, stageView(stage));
          if (req.method === "PATCH") { const input = await readJson(req); const candidate = structuredClone(stage); const nextAutoDeploy = input.autoDeploy === undefined ? candidate.autoDeploy : Boolean(input.autoDeploy); if (nextAutoDeploy && input.deploymentId) throw new AwsError("BadRequestException", "DeploymentId cannot be set while AutoDeploy is enabled"); if (input.deploymentId !== undefined) { if (input.deploymentId) this.deployment(api, String(input.deploymentId)); candidate.deploymentId = input.deploymentId || undefined; } if (input.description !== undefined) candidate.description = input.description || undefined; candidate.autoDeploy = nextAutoDeploy; if (input.defaultRouteSettings !== undefined) candidate.defaultRouteSettings = this.routeSettings(input.defaultRouteSettings, candidate.defaultRouteSettings); if (input.routeSettings !== undefined) candidate.routeSettings = this.stageRouteSettings(api, input.routeSettings); if (input.stageVariables !== undefined) candidate.stageVariables = this.stageVariables(input.stageVariables, candidate.stageVariables); if (input.accessLogSettings !== undefined) candidate.accessLogSettings = this.accessLogSettings(input.accessLogSettings, candidate.accessLogSettings); candidate.lastUpdatedDate = this.clock.now(); if (candidate.autoDeploy && !candidate.deploymentId) { const deployment = this.createDeploymentState(api, "Automatic deployment", true); api.deployments[deployment.deploymentId] = deployment; candidate.deploymentId = deployment.deploymentId; } api.stages[stage.stageName] = candidate; await this.store.save(); return json(res, stageView(candidate)); }
          if (req.method === "DELETE") { delete api.stages[stage.stageName]; await this.store.save(); res.statusCode = 204; res.end(); return; }
        }
      }

      throw new AwsError("NotFoundException", "Unknown API Gateway v2 route", 404);
    } catch (error) { sendAwsError(res, error, "rest"); }
  }

  private clearAuthorizerCache(apiId: string, authorizerId?: string): void {
    for (const key of this.authorizerCache.keys()) if (key.startsWith(`${apiId}\0`) && (!authorizerId || key.startsWith(`${apiId}\0${authorizerId}\0`))) this.authorizerCache.delete(key);
  }

  private tagTarget(arn: string): { tags: Record<string, string>; set(tags: Record<string, string>): void } {
    const webSocket = this.webSocket?.tagTarget(arn); if (webSocket) return webSocket;
    for (const api of Object.values(this.apis)) {
      if (arn === `arn:aws:apigateway:${this.region}::/apis/${api.apiId}`) return { tags: api.tags, set: tags => { api.tags = tags; } };
      for (const stage of Object.values(api.stages)) if (arn === `arn:aws:apigateway:${this.region}::/apis/${api.apiId}/stages/${stage.stageName}`) return { tags: stage.tags, set: tags => { stage.tags = tags; } };
    }
    for (const domain of Object.values(this.domains)) if (arn === domain.domainNameArn) return { tags: domain.tags, set: tags => { domain.tags = tags; } };
    throw new AwsError("NotFoundException", "Resource not found", 404);
  }

  private createDomain(input: any, operationToken?: string): ApiGatewayV2DomainNameState {
    const domainName = this.normalizeDomainName(input.domainName);
    if (this.domains[domainName] || this.store.regionState(this.region).apiGatewayDomainNames[domainName]) throw new AwsError("ConflictException", "The domain name already exists", 409);
    if (!Array.isArray(input.domainNameConfigurations) || input.domainNameConfigurations.length !== 1) throw new AwsError("BadRequestException", "One DomainNameConfiguration is required");
    const config = input.domainNameConfigurations[0]; if (config.endpointType !== undefined && config.endpointType !== "REGIONAL") throw new AwsError("BadRequestException", "HTTP API custom domains support REGIONAL endpoints");
    if (!config.certificateArn) throw new AwsError("BadRequestException", "CertificateArn is required");
    const certificateArn = String(config.certificateArn); if (!new RegExp(`^arn:aws(?:-[a-z]+)?:acm:${this.region}:${this.store.accountId}:certificate\/[A-Za-z0-9-]+$`).test(certificateArn)) throw new AwsError("BadRequestException", "CertificateArn must identify a local ACM certificate");
    if (config.ipAddressType !== undefined && !new Set(["ipv4", "dualstack"]).has(config.ipAddressType)) throw new AwsError("BadRequestException", "Invalid IpAddressType");
    if (config.securityPolicy !== undefined && !SECURITY_POLICIES.has(config.securityPolicy)) throw new AwsError("BadRequestException", "Invalid SecurityPolicy");
    const routingMode = input.routingMode ?? "API_MAPPING_ONLY"; if (!DOMAIN_ROUTING_MODES.has(routingMode)) throw new AwsError("BadRequestException", "Invalid RoutingMode");
    if (input.mutualTlsAuthentication !== undefined) { const truststore = input.mutualTlsAuthentication; if (!truststore || typeof truststore !== "object" || !/^s3:\/\/[A-Za-z0-9.-]+\/.+/.test(String(truststore.truststoreUri ?? ""))) throw new AwsError("BadRequestException", "MutualTlsAuthentication requires an S3 truststore URI"); }
    const alias = createHash("sha256").update(`${domainName}:${this.region}`).digest("hex").slice(0, 14);
    const now = this.clock.now(); return { domainName, domainNameArn: `arn:aws:apigateway:${this.region}::/domainnames/${domainName}`, domainNameConfigurations: [{ endpointType: "REGIONAL", ipAddressType: config.ipAddressType ?? "ipv4", certificateName: config.certificateName, certificateArn, ownershipVerificationCertificateArn: config.ownershipVerificationCertificateArn, apiGatewayDomainName: `${alias}.execute-api.${this.region}.local`, hostedZoneId: `Z${createHash("sha256").update(this.region).digest("hex").slice(0, 13).toUpperCase()}`, certificateUploadDate: now, securityPolicy: config.securityPolicy ?? "TLS_1_2", domainNameStatus: "AVAILABLE" }], apiMappingSelectionExpression: "$request.basepath", mutualTlsAuthentication: structuredClone(input.mutualTlsAuthentication), routingMode, tags: this.tags(input.tags), apiMappings: {}, createdDate: now, lastUpdatedDate: now, cloudFormationOperationToken: operationToken };
  }

  private updateDomain(domain: ApiGatewayV2DomainNameState, input: any): ApiGatewayV2DomainNameState {
    const candidate = structuredClone(domain); if (input.domainName !== undefined) candidate.domainName = this.normalizeDomainName(input.domainName); if (candidate.domainName !== domain.domainName && (this.domains[candidate.domainName] || this.store.regionState(this.region).apiGatewayDomainNames[candidate.domainName])) throw new AwsError("ConflictException", "The domain name already exists", 409); if (input.domainNameConfigurations !== undefined) { const replacement = this.createDomain({ domainName: `${id(8)}.validation.local`, domainNameConfigurations: input.domainNameConfigurations }).domainNameConfigurations; replacement[0].apiGatewayDomainName = candidate.domainNameConfigurations[0].apiGatewayDomainName; replacement[0].hostedZoneId = candidate.domainNameConfigurations[0].hostedZoneId; candidate.domainNameConfigurations = replacement; } if (input.mutualTlsAuthentication !== undefined) { const validated = this.createDomain({ domainName: `${id(8)}.validation.local`, domainNameConfigurations: candidate.domainNameConfigurations, mutualTlsAuthentication: input.mutualTlsAuthentication }).mutualTlsAuthentication; candidate.mutualTlsAuthentication = validated; } if (input.routingMode !== undefined) { if (!DOMAIN_ROUTING_MODES.has(input.routingMode)) throw new AwsError("BadRequestException", "Invalid RoutingMode"); candidate.routingMode = input.routingMode; } candidate.domainNameArn = `arn:aws:apigateway:${this.region}::/domainnames/${candidate.domainName}`; candidate.lastUpdatedDate = this.clock.now(); return candidate;
  }

  private mappingKey(value: unknown): string | undefined {
    if (value === undefined || value === "") return undefined;
    const key = String(value).replace(/^\/+|\/+$/g, ""); if (!key || key.length > 300 || key.split("/").some(segment => !/^[A-Za-z0-9$_.+!*'(),:@&=-]+$/.test(segment))) throw new AwsError("BadRequestException", "Invalid ApiMappingKey"); return key;
  }

  private validateMapping(domain: ApiGatewayV2DomainNameState, mapping: ApiGatewayV2ApiMappingState, ignoreId?: string): void {
    if (this.webSocket?.hasApi(mapping.apiId)) { if (!this.webSocket.stageExists(mapping.apiId, mapping.stage)) throw new AwsError("NotFoundException", `Invalid Stage identifier specified ${mapping.stage}`, 404); }
    else { const api = this.api(mapping.apiId); this.stage(api, mapping.stage); }
    if (Object.values(domain.apiMappings).some(value => value.apiMappingId !== ignoreId && value.apiMappingKey === mapping.apiMappingKey)) throw new AwsError("ConflictException", "An API mapping with this key already exists", 409);
  }

  private createMapping(domain: ApiGatewayV2DomainNameState, input: any, operationToken?: string): ApiGatewayV2ApiMappingState {
    const mapping: ApiGatewayV2ApiMappingState = { apiMappingId: cloudFormationResourceId(operationToken, "api-mapping") ?? id(10), apiMappingKey: this.mappingKey(input.apiMappingKey), apiId: String(input.apiId ?? ""), stage: String(input.stage ?? ""), cloudFormationOperationToken: operationToken }; this.validateMapping(domain, mapping); return mapping;
  }

  private matchRoute(snapshot: HttpApiDeploymentSnapshotState, method: string, path: string): { route?: HttpApiRouteState; parameters: Record<string, string> } {
    const requestedSegments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const candidates: Array<{ route: HttpApiRouteState; parameters: Record<string, string>; score: number }> = [];
    for (const route of Object.values(snapshot.routes)) {
      if (route.routeKey === "$default") continue;
      const [configuredMethod, template = "/"] = route.routeKey.split(/\s+/, 2);
      if (configuredMethod !== method && configuredMethod !== "ANY") continue;
      const templateSegments = template.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean); const parameters: Record<string, string> = {}; let matched = true; let greedy = false; let staticSegments = 0; let cursor = 0;
      for (let index = 0; index < templateSegments.length; index++) {
        const segment = templateSegments[index]; const parameter = segment.match(/^\{([^}]+?)(\+)?\}$/);
        if (parameter?.[2]) { greedy = true; const remaining = requestedSegments.slice(cursor); if (!remaining.length) { matched = false; break; } parameters[parameter[1]] = remaining.map(value => decodeURIComponent(value)).join("/"); cursor = requestedSegments.length; break; }
        const actual = requestedSegments[cursor++]; if (actual === undefined) { matched = false; break; }
        if (parameter) parameters[parameter[1]] = decodeURIComponent(actual); else if (decodeURIComponent(actual) !== segment) { matched = false; break; } else staticSegments++;
      }
      if (!matched || cursor !== requestedSegments.length) continue;
      const score = (greedy ? 0 : 1_000_000) + (configuredMethod === method ? 100_000 : 0) + staticSegments * 1000 + templateSegments.length;
      candidates.push({ route, parameters, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.route.routeKey.localeCompare(b.route.routeKey));
    if (candidates[0]) return { route: candidates[0].route, parameters: candidates[0].parameters };
    return { route: Object.values(snapshot.routes).find(route => route.routeKey === "$default"), parameters: {} };
  }

  private resolveInvocation(pathname: string, method: string): ResolvedHttpInvocation {
    const segments = pathname.replace(/^\//, "").split("/"); const apiId = decodeURIComponent(segments.shift() ?? ""); const api = this.api(apiId);
    const firstRaw = segments[0] ?? ""; const first = decodeURIComponent(firstRaw); let stage: HttpApiStageState | undefined;
    if (first && first !== "$default" && api.stages[first]) { stage = api.stages[first]; segments.shift(); }
    else if (first === "$default" && /^%24/i.test(firstRaw) && api.stages.$default) { stage = api.stages.$default; segments.shift(); }
    else stage = api.stages.$default;
    if (!stage) throw new AwsError("NotFoundException", "Not Found", 404);
    if (!stage.deploymentId) throw new AwsError("NotFoundException", "Not Found", 404);
    const deployment = api.deployments[stage.deploymentId]; if (!deployment) throw new AwsError("NotFoundException", "Not Found", 404);
    const path = `/${segments.join("/")}` || "/"; const matched = this.matchRoute(deployment.snapshot, method, path);
    if (!matched.route) {
      if (method === "OPTIONS" && deployment.snapshot.corsConfiguration) return { api, stage, snapshot: deployment.snapshot, route: { routeId: "cors-preflight", routeKey: "OPTIONS /{proxy+}", authorizationType: "NONE", authorizationScopes: [], apiGatewayManaged: true }, path, pathParameters: {} };
      throw new AwsError("NotFoundException", "Not Found", 404);
    }
    return { api, stage, snapshot: deployment.snapshot, route: matched.route, path, pathParameters: matched.parameters };
  }

  private consumeBucket(key: string, rate = this.accountRateLimit, burst = this.accountBurstLimit): boolean {
    if (rate === undefined || burst === undefined) return true; if (rate <= 0 || burst <= 0) return false;
    const now = this.clock.now(); const bucket = this.throttleBuckets.get(key) ?? { tokens: burst, updatedAt: now }; bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.updatedAt) / 1000 * rate); bucket.updatedAt = now;
    if (bucket.tokens < 1) { this.throttleBuckets.set(key, bucket); return false; } bucket.tokens -= 1; this.throttleBuckets.set(key, bucket); return true;
  }

  private requestHeaders(req: IncomingMessage): { headers: Record<string, string>; multiHeaders: Record<string, string[]> } {
    const headers: Record<string, string> = {}; const multiHeaders: Record<string, string[]> = {};
    for (const [name, raw] of Object.entries(req.headers)) { const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)]; multiHeaders[name.toLowerCase()] = values; headers[name.toLowerCase()] = values.join(","); }
    return { headers, multiHeaders };
  }

  private requestQueries(url: URL): { query: Record<string, string>; multiQuery: Record<string, string[]> } {
    const names = [...new Set(url.searchParams.keys())]; return { query: Object.fromEntries(names.map(name => [name, url.searchParams.getAll(name).join(",")])), multiQuery: Object.fromEntries(names.map(name => [name, url.searchParams.getAll(name)])) };
  }

  private identityValue(source: string, input: HttpInvocationInput): string {
    const header = source.match(/^\$request\.header\.([A-Za-z0-9._-]+)$/i)?.[1]; if (header) return input.headers[header.toLowerCase()] ?? "";
    const query = source.match(/^\$request\.querystring\.([A-Za-z0-9._-]+)$/i)?.[1]; if (query) return input.query[query] ?? "";
    const path = source.match(/^\$request\.path\.([A-Za-z0-9._-]+)$/i)?.[1]; if (path) return input.pathParameters[path] ?? "";
    const stage = source.match(/^\$stageVariables\.([A-Za-z0-9._-]+)$/)?.[1]; if (stage) return input.stage.stageVariables[stage] ?? "";
    if (source === "$context.routeKey") return input.route.routeKey; if (source === "$context.httpMethod") return input.method;
    return "";
  }

  private lambdaArn(uri: string | undefined): string {
    const arn = uri?.match(/functions\/(arn:[^/]+)\/invocations/)?.[1] ?? (uri?.startsWith("arn:") ? uri : undefined);
    if (!arn) throw new AwsError("InternalServerErrorException", "Invalid Lambda integration URI", 500); return arn;
  }

  private methodArn(input: HttpInvocationInput): string { return `arn:aws:execute-api:${this.region}:${this.store.accountId}:${input.api.apiId}/${input.stage.stageName}/${input.method}/${input.path.replace(/^\//, "")}`; }

  private requestContext(input: HttpInvocationInput, authorizer: HttpAuthorizerResult = { allowed: true, context: {} }): any {
    const now = this.clock.now(); return {
      accountId: this.store.accountId, apiId: input.api.apiId,
      authorizer: authorizer.jwt ? { jwt: authorizer.jwt } : authorizer.principalId || Object.keys(authorizer.context).length ? { lambda: authorizer.context } : undefined,
      domainName: input.headers.host, domainPrefix: input.headers.host?.split(".")[0],
      http: { method: input.method, path: input.path, protocol: "HTTP/1.1", sourceIp: input.sourceIp, userAgent: input.headers["user-agent"] ?? "" },
      requestId: input.requestId, routeKey: input.route.routeKey, stage: input.stage.stageName,
      time: new Date(now).toUTCString(), timeEpoch: now,
    };
  }

  private async runRequestAuthorizer(authorizer: HttpApiAuthorizerState, input: HttpInvocationInput): Promise<HttpAuthorizerResult> {
    this.assertGatewayRole(authorizer.authorizerCredentialsArn, "authorizer", true);
    const identities = authorizer.identitySource.map(source => this.identityValue(source, input)); if (identities.some(value => !value)) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const cacheKey = `${input.api.apiId}\0${authorizer.authorizerId}\0${input.stage.stageName}\0${identities.join("\0")}`; const cached = this.authorizerCache.get(cacheKey); if (cached && cached.expiresAt > this.clock.now()) return cached.value;
    const routeArn = this.methodArn(input); const context = this.requestContext(input); const event = authorizer.authorizerPayloadFormatVersion === "1.0" ? {
      type: "REQUEST", methodArn: routeArn, resource: input.path, path: input.path, httpMethod: input.method, headers: input.headers,
      multiValueHeaders: input.multiHeaders, queryStringParameters: input.query, multiValueQueryStringParameters: input.multiQuery,
      pathParameters: input.pathParameters, stageVariables: input.stage.stageVariables,
      requestContext: { ...context, identity: { sourceIp: input.sourceIp, userAgent: input.headers["user-agent"] } },
    } : {
      version: "2.0", type: "REQUEST", routeArn, identitySource: identities, routeKey: input.route.routeKey, rawPath: input.path,
      rawQueryString: input.rawQueryString, cookies: this.requestCookies(input.headers.cookie), headers: input.headers,
      requestContext: context, pathParameters: input.pathParameters, stageVariables: input.stage.stageVariables,
    };
    const sourceArn = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${input.api.apiId}/authorizers/${authorizer.authorizerId}`; let invocation: InvokeResult;
    const functionArn = this.lambdaArn(authorizer.authorizerUri); if (authorizer.authorizerCredentialsArn && evaluateRoleAuthorization(this.store.ensureAccount().iam, authorizer.authorizerCredentialsArn, "lambda:InvokeFunction", functionArn).decision !== "allowed") throw new AwsError("InternalServerErrorException", "The authorizer role cannot invoke the Lambda function", 500);
    try { invocation = await this.lambda.invoke(functionArn, Buffer.from(JSON.stringify(event)), id(24), { principal: "apigateway.amazonaws.com", sourceArn, sourceAccount: this.store.accountId, enforceResourcePolicy: !authorizer.authorizerCredentialsArn, lineage: input.principal?.lambdaLineage }); }
    catch (error) { if (error instanceof AwsError && error.code === "AccessDeniedException") throw new AwsError("InternalServerErrorException", "API Gateway is not authorized to invoke the authorizer", 500); throw error; }
    if (invocation.functionError) throw new AwsError("InternalServerErrorException", "Authorizer execution failed", 500);
    let output: any; try { output = JSON.parse(invocation.payload.toString("utf8")); } catch { throw new AwsError("InternalServerErrorException", "Invalid authorizer response", 500); }
    let result: HttpAuthorizerResult;
    if (authorizer.enableSimpleResponses) {
      if (typeof output?.isAuthorized !== "boolean") throw new AwsError("InternalServerErrorException", "Simple authorizer response requires isAuthorized", 500);
      result = { allowed: output.isAuthorized, context: output.context && typeof output.context === "object" ? output.context : {} };
    } else {
      if (!output?.principalId || !output.policyDocument?.Statement) throw new AwsError("InternalServerErrorException", "Authorizer response requires principalId and policyDocument", 500);
      result = { allowed: evaluateIdentityPolicy(output.policyDocument, "execute-api:Invoke", routeArn).decision === "allowed", principalId: String(output.principalId), context: output.context && typeof output.context === "object" ? output.context : {} };
    }
    if (authorizer.authorizerResultTtlInSeconds > 0) this.authorizerCache.set(cacheKey, { expiresAt: this.clock.now() + authorizer.authorizerResultTtlInSeconds * 1000, value: result }); return result;
  }

  private async remoteJwtJson(target: URL): Promise<any> {
    if (target.username || target.password || target.protocol !== "https:" && !(this.allowPrivateJwtJwks && target.protocol === "http:")) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const hostname = target.hostname.toLowerCase(); const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }).catch(() => []);
    const forbidden = (address: string) => address === "0.0.0.0" || address === "::" || address.startsWith("169.254.") || address.toLowerCase().startsWith("fe80:");
    if (!addresses.length || addresses.some(value => forbidden(value.address)) || !this.allowPrivateJwtJwks && (hostname === "localhost" || hostname.endsWith(".localhost") || addresses.some(value => this.privateAddress(value.address)))) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(target, { headers: { accept: "application/json" }, redirect: "manual", signal: controller.signal });
      if (!response.ok || response.status >= 300 || Number(response.headers.get("content-length") ?? 0) > 1_048_576) throw new Error();
      const body = Buffer.from(await response.arrayBuffer()); if (body.length > 1_048_576) throw new Error(); return JSON.parse(body.toString("utf8"));
    } catch { throw new AwsError("UnauthorizedException", "Unauthorized", 401); } finally { clearTimeout(timer); }
  }

  private async jwtKeys(issuer: string): Promise<JsonWebKey[] | undefined> {
    if (this.cognitoIssuerKeys) {
      const resolution = await this.cognitoIssuerKeys.resolveIssuer(issuer);
      if (resolution.kind === "AVAILABLE") return resolution.keys;
      if (resolution.kind === "CLAIMED_UNAVAILABLE") throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    }
    const local = this.jwtJwks[issuer] ?? this.jwtJwks[`${issuer}/`]; if (local) return local.keys;
    if (!this.allowRemoteJwtJwks) return undefined; const cached = this.remoteJwksCache.get(issuer); if (cached && cached.expiresAt > this.clock.now()) return cached.keys;
    const discoveryUrl = new URL(issuer); discoveryUrl.pathname = `${discoveryUrl.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`; discoveryUrl.search = ""; discoveryUrl.hash = "";
    const discovery = await this.remoteJwtJson(discoveryUrl); if (discovery.issuer && String(discovery.issuer).replace(/\/$/, "") !== issuer) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    let jwksUrl: URL; try { jwksUrl = new URL(String(discovery.jwks_uri ?? "")); } catch { throw new AwsError("UnauthorizedException", "Unauthorized", 401); } const jwks = await this.remoteJwtJson(jwksUrl); if (!Array.isArray(jwks.keys) || jwks.keys.some((key: unknown) => !key || typeof key !== "object")) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const keys = jwks.keys as JsonWebKey[]; this.remoteJwksCache.set(issuer, { expiresAt: this.clock.now() + 600_000, keys }); return keys;
  }

  private async runJwtAuthorizer(authorizer: HttpApiAuthorizerState, input: HttpInvocationInput): Promise<HttpAuthorizerResult> {
    const identity = this.identityValue(authorizer.identitySource[0], input);
    const bearer = /^Bearer ([^\s]+)$/i.exec(identity);
    const token = bearer ? bearer[1] : /^[^\s]+$/.test(identity) ? identity : "";
    if (!token) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    try {
      const parsed = parseJwt(token);
      const issuer = authorizer.jwtConfiguration!.issuer.replace(/\/$/, "");
      const keys = await this.jwtKeys(issuer);
      if (!keys) throw new JwtValidationError();
      verifyParsedJwt(parsed, keys, JWT_ALGORITHMS);
      const claims = parsed.claims;
      const now = Math.floor(this.clock.now() / 1000);
      if (
        claims.iss !== issuer
        || !Number.isSafeInteger(claims.exp)
        || Number(claims.exp) <= now
        || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || Number(claims.nbf) > now)
        || claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || Number(claims.iat) > now)
      ) {
        throw new JwtValidationError();
      }
      let audiences: string[];
      if (Object.prototype.hasOwnProperty.call(claims, "aud")) {
        audiences = typeof claims.aud === "string"
          ? [claims.aud]
          : Array.isArray(claims.aud) && claims.aud.every(value => typeof value === "string")
            ? claims.aud
            : [];
      } else {
        audiences = typeof claims.client_id === "string" ? [claims.client_id] : [];
      }
      if (!audiences.length || !audiences.some(value => authorizer.jwtConfiguration!.audience.includes(value))) throw new JwtValidationError();
      const rawScopes = claims.scope ?? claims.scp ?? "";
      if (typeof rawScopes !== "string") throw new JwtValidationError();
      const scopes = [...new Set(rawScopes.split(/\s+/).filter(Boolean))];
      if (input.route.authorizationScopes.length && !input.route.authorizationScopes.some(scope => scopes.includes(scope))) throw new AwsError("ForbiddenException", "Forbidden", 403);
      return { allowed: true, context: {}, jwt: { claims: httpJwtClaimsAsStrings(claims), scopes } };
    } catch (error) {
      if (error instanceof AwsError && error.code === "ForbiddenException") throw error;
      throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    }
  }

  private async authorizeInvocation(input: HttpInvocationInput): Promise<HttpAuthorizerResult> {
    if (input.route.authorizationType === "NONE") return { allowed: true, context: {} };
    if (input.route.authorizationType === "AWS_IAM") { if (this.authMode === "enforce" && input.identityAuthorization?.decision !== "allowed") throw new AwsError("ForbiddenException", "Forbidden", 403); return { allowed: true, principalId: input.principal?.principalId, context: {} }; }
    const authorizer = input.snapshot.authorizers[input.route.authorizerId ?? ""]; if (!authorizer) throw new AwsError("InternalServerErrorException", "Authorizer configuration is unavailable", 500);
    const result = authorizer.authorizerType === "JWT" ? await this.runJwtAuthorizer(authorizer, input) : await this.runRequestAuthorizer(authorizer, input); if (!result.allowed) throw new AwsError("ForbiddenException", "Forbidden", 403); return result;
  }

  private requestCookies(value: string | undefined): string[] | undefined { const cookies = value?.split(/;\s*/).filter(Boolean); return cookies?.length ? cookies : undefined; }

  private bodyValue(body: Buffer): { body?: string; isBase64Encoded: boolean } {
    if (!body.length) return { isBase64Encoded: false }; const text = body.toString("utf8"); return Buffer.from(text).equals(body) ? { body: text, isBase64Encoded: false } : { body: body.toString("base64"), isBase64Encoded: true };
  }

  private lambdaEvent(input: HttpInvocationInput, integration: HttpApiIntegrationState, authorizer: HttpAuthorizerResult): any {
    const body = this.bodyValue(input.body); const context = this.requestContext(input, authorizer);
    if (integration.payloadFormatVersion === "2.0") return present({ version: "2.0", routeKey: input.route.routeKey, rawPath: input.path, rawQueryString: input.rawQueryString, cookies: this.requestCookies(input.headers.cookie), headers: input.headers, queryStringParameters: Object.keys(input.query).length ? input.query : undefined, requestContext: context, body: body.body, pathParameters: Object.keys(input.pathParameters).length ? input.pathParameters : undefined, isBase64Encoded: body.isBase64Encoded, stageVariables: Object.keys(input.stage.stageVariables).length ? input.stage.stageVariables : undefined });
    return present({ resource: input.route.routeKey === "$default" ? "$default" : input.route.routeKey.split(/\s+/, 2)[1], path: input.path, httpMethod: input.method, headers: input.headers, multiValueHeaders: input.multiHeaders, queryStringParameters: Object.keys(input.query).length ? input.query : undefined, multiValueQueryStringParameters: Object.keys(input.multiQuery).length ? input.multiQuery : undefined, pathParameters: Object.keys(input.pathParameters).length ? input.pathParameters : undefined, stageVariables: Object.keys(input.stage.stageVariables).length ? input.stage.stageVariables : undefined, requestContext: { ...context, identity: { sourceIp: input.sourceIp, userAgent: input.headers["user-agent"] }, authorizer: authorizer.jwt ? authorizer.jwt.claims : authorizer.context }, body: body.body, isBase64Encoded: body.isBase64Encoded });
  }

  private parseLambdaResponse(invocation: InvokeResult, payloadVersion: "1.0" | "2.0", started: number): HttpBackendResult {
    if (invocation.functionError) throw new AwsError("InternalServerErrorException", "Internal Server Error", 502); let output: any; try { output = JSON.parse(invocation.payload.toString("utf8")); } catch { throw new AwsError("InternalServerErrorException", "Internal Server Error", 502); }
    if (payloadVersion === "2.0" && (output === null || typeof output !== "object" || output.statusCode === undefined)) { const value = typeof output === "string" ? output : JSON.stringify(output); return { status: 200, headers: { "content-type": typeof output === "string" ? "text/plain; charset=utf-8" : "application/json" }, body: Buffer.from(value ?? ""), integrationLatency: performance.now() - started }; }
    const status = Number(output?.statusCode); if (!Number.isInteger(status) || status < 100 || status > 599) throw new AwsError("InternalServerErrorException", "Internal Server Error", 502);
    const headers: Record<string, string | string[]> = {}; for (const [name, value] of Object.entries(output.headers ?? {})) headers[name.toLowerCase()] = String(value); if (payloadVersion === "1.0") for (const [name, value] of Object.entries(output.multiValueHeaders ?? {})) headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : [String(value)]; if (payloadVersion === "2.0" && Array.isArray(output.cookies)) headers["set-cookie"] = output.cookies.map(String);
    let body = output.body === undefined || output.body === null ? Buffer.alloc(0) : Buffer.from(typeof output.body === "string" ? output.body : JSON.stringify(output.body)); if (output.isBase64Encoded) { try { body = Buffer.from(String(output.body ?? ""), "base64"); } catch { throw new AwsError("InternalServerErrorException", "Internal Server Error", 502); } }
    return { status, headers, body, integrationLatency: performance.now() - started };
  }

  private async invokeLambdaIntegration(integration: HttpApiIntegrationState, input: HttpInvocationInput, authorizer: HttpAuthorizerResult): Promise<HttpBackendResult> {
    const started = performance.now(); const sourceArn = this.methodArn(input); const functionArn = this.lambdaArn(integration.integrationUri); let invocation: InvokeResult; this.assertGatewayRole(integration.credentialsArn, "integration", true); if (integration.credentialsArn && evaluateRoleAuthorization(this.store.ensureAccount().iam, integration.credentialsArn, "lambda:InvokeFunction", functionArn).decision !== "allowed") throw new AwsError("InternalServerErrorException", "The integration role cannot invoke the Lambda function", 500);
    try { invocation = await this.lambda.invoke(functionArn, Buffer.from(JSON.stringify(this.lambdaEvent(input, integration, authorizer))), id(24), { principal: "apigateway.amazonaws.com", sourceArn, sourceAccount: this.store.accountId, enforceResourcePolicy: !integration.credentialsArn, lineage: input.principal?.lambdaLineage }); }
    catch (error) { if (error instanceof AwsError && error.code === "AccessDeniedException") throw new AwsError("InternalServerErrorException", "Internal Server Error", 500); throw error; }
    return this.parseLambdaResponse(invocation, integration.payloadFormatVersion, started);
  }

  private privateAddress(address: string): boolean {
    if (address === "::1" || address === "::" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
    const octets = address.split(".").map(Number); return octets.length === 4 && (octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168);
  }

  private async assertHttpTarget(target: URL): Promise<void> {
    if (process.env.STACKSIM_ALLOW_OUTBOUND_HTTP !== "true") throw new AwsError("InternalServerErrorException", "Outbound HTTP integrations require STACKSIM_ALLOW_OUTBOUND_HTTP=true", 502);
    if (!new Set(["http:", "https:"]).has(target.protocol) || target.username || target.password) throw new AwsError("InternalServerErrorException", "Invalid HTTP integration endpoint", 502);
    if (process.env.STACKSIM_ALLOW_PRIVATE_HTTP === "true") return; const hostname = target.hostname.toLowerCase(); if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "169.254.169.254") throw new AwsError("InternalServerErrorException", "Private HTTP integration endpoints are disabled", 502);
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }).catch(() => []); if (!addresses.length || addresses.some(value => this.privateAddress(value.address))) throw new AwsError("InternalServerErrorException", "Private HTTP integration endpoints are disabled", 502);
  }

  private requestExpression(expression: string, input: HttpInvocationInput): string {
    const value = String(expression); if (/^'.*'$/.test(value)) return value.slice(1, -1);
    if (value === "$request.body") return input.body.toString("utf8"); const bodyPath = value.match(/^\$request\.body\.([A-Za-z0-9_.-]+)$/)?.[1]; if (bodyPath) { try { let current: any = JSON.parse(input.body.toString("utf8")); for (const part of bodyPath.split(".")) current = current?.[part]; return current === undefined ? "" : typeof current === "string" ? current : JSON.stringify(current); } catch { return ""; } }
    return this.identityValue(value, input) || value.replace(/\$context\.requestId/g, input.requestId).replace(/\$context\.routeKey/g, input.route.routeKey).replace(/\$context\.stage/g, input.stage.stageName);
  }

  private sqsObjectParameter(value: string, name: string): Record<string, any> {
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch { throw new AwsError("InternalServerErrorException", `${name} must evaluate to a JSON object`, 500); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AwsError("InternalServerErrorException", `${name} must evaluate to a JSON object`, 500);
    return parsed as Record<string, any>;
  }

  private async invokeSqsIntegration(integration: HttpApiIntegrationState, input: HttpInvocationInput): Promise<HttpBackendResult> {
    const started = performance.now();
    if (!this.sqs) throw new AwsError("InternalServerErrorException", "The SQS integration service is not available", 500);
    const request = {} as SendMessageInput;
    for (const [name, expression] of Object.entries(integration.requestParameters)) {
      const value = this.requestExpression(expression, input);
      if (name === "Region") {
        if (value !== this.region) throw new AwsError("InternalServerErrorException", "SQS-SendMessage targets must use the API Region", 500);
      } else if (name === "DelaySeconds") {
        if (value !== "") (request as any).DelaySeconds = Number(value);
      } else if (name === "MessageAttributes" || name === "MessageSystemAttributes") {
        if (value !== "") (request as any)[name] = this.sqsObjectParameter(value, name);
      } else (request as any)[name] = value;
    }
    let queueArn: string;
    try { queueArn = this.sqs.resolveQueueUrl(String(request.QueueUrl ?? "")).queueArn; }
    catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      throw new AwsError("InternalServerErrorException", `SQS SendMessage failed: ${aws.message}`, 500);
    }
    if (!integration.credentialsArn) throw new AwsError("InternalServerErrorException", "The integration role cannot send messages to the SQS queue", 500);
    this.assertGatewayRole(integration.credentialsArn, "integration", true);
    try {
      const { QueueUrl: _queueUrl, ...message } = request;
      const sourceArn = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${input.api.apiId}/${input.stage.stageName}/${input.route.routeKey}`;
      const response = await this.sqs.sendAuthorizedMessageToArn(queueArn, message, { kind: "role", roleArn: integration.credentialsArn, sourceArn, sourceAccount: this.store.accountId });
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(response)), integrationLatency: performance.now() - started };
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      throw new AwsError("InternalServerErrorException", `SQS SendMessage failed: ${aws.message}`, 500);
    }
  }

  private applyRequestParameters(integration: HttpApiIntegrationState, input: HttpInvocationInput, target: URL): { headers: Record<string, string>; method: string } {
    const headers = Object.fromEntries(Object.entries(input.headers).filter(([name]) => !new Set(["host", "content-length"]).has(name))); target.search = ""; for (const [name, values] of Object.entries(input.multiQuery)) for (const value of values) target.searchParams.append(name, value);
    for (const [key, expression] of Object.entries(integration.requestParameters)) {
      const match = key.match(/^(append|overwrite|remove):(header|querystring)\.([A-Za-z0-9._-]+)$/i); if (match) { const [, action, location, name] = match; const value = this.requestExpression(expression, input); if (location.toLowerCase() === "header") { const normalized = name.toLowerCase(); if (action === "remove") delete headers[normalized]; else if (action === "append" && headers[normalized]) headers[normalized] += `,${value}`; else headers[normalized] = value; } else { if (action === "remove") target.searchParams.delete(name); else if (action === "append") target.searchParams.append(name, value); else { target.searchParams.delete(name); target.searchParams.set(name, value); } } continue; }
      if (key === "overwrite:path") { const path = this.requestExpression(expression, input); target.pathname = path.startsWith("/") ? path : `/${path}`; continue; }
      throw new AwsError("InternalServerErrorException", `Invalid request parameter mapping ${key}`, 500);
    }
    return { headers, method: integration.integrationMethod === "ANY" ? input.method : integration.integrationMethod ?? input.method };
  }

  private responseExpression(expression: string, result: HttpBackendResult, input: HttpInvocationInput): string {
    const value = String(expression); if (/^'.*'$/.test(value)) return value.slice(1, -1); const header = value.match(/^\$response\.header\.([A-Za-z0-9._-]+)$/i)?.[1]; if (header) { const found = Object.entries(result.headers).find(([name]) => name.toLowerCase() === header.toLowerCase())?.[1]; return Array.isArray(found) ? found.join(",") : found ?? ""; } if (value === "$response.body") return result.body.toString("utf8"); return value.replace(/\$context\.requestId/g, input.requestId).replace(/\$context\.routeKey/g, input.route.routeKey);
  }

  private applyResponseParameters(integration: HttpApiIntegrationState, result: HttpBackendResult, input: HttpInvocationInput): HttpBackendResult {
    const mappings = integration.responseParameters[String(result.status)] ?? integration.responseParameters.$default; if (!mappings) return result; const output: HttpBackendResult = { ...result, headers: { ...result.headers } };
    for (const [key, expression] of Object.entries(mappings)) { if (key === "overwrite:statuscode") { const status = Number(this.responseExpression(expression, result, input)); if (!Number.isInteger(status) || status < 100 || status > 599) throw new AwsError("InternalServerErrorException", "Invalid response status mapping", 500); output.status = status; continue; } const match = key.match(/^(append|overwrite|remove):header\.([A-Za-z0-9._-]+)$/i); if (!match) throw new AwsError("InternalServerErrorException", `Invalid response parameter mapping ${key}`, 500); const [, action, name] = match; const normalized = name.toLowerCase(); if (action === "remove") delete output.headers[normalized]; else { const value = this.responseExpression(expression, result, input); const current = output.headers[normalized]; output.headers[normalized] = action === "append" && current ? `${Array.isArray(current) ? current.join(",") : current},${value}` : value; } }
    return output;
  }

  private async invokeHttpIntegration(integration: HttpApiIntegrationState, input: HttpInvocationInput): Promise<HttpBackendResult> {
    const target = new URL(integration.integrationUri!); await this.assertHttpTarget(target); const mapped = this.applyRequestParameters(integration, input, target); const started = performance.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), integration.timeoutInMillis);
    try { const response = await fetch(target, { method: mapped.method, headers: mapped.headers, body: new Set(["GET", "HEAD"]).has(mapped.method) ? undefined : Uint8Array.from(input.body), redirect: "manual", signal: controller.signal }); const headers: Record<string, string | string[]> = {}; response.headers.forEach((value, name) => { headers[name.toLowerCase()] = name.toLowerCase() === "set-cookie" && typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : value; }); const result = { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()), integrationLatency: performance.now() - started }; return this.applyResponseParameters(integration, result, input); }
    catch (error) { if ((error as any)?.name === "AbortError") throw new AwsError("InternalServerErrorException", "Endpoint request timed out", 504); throw new AwsError("InternalServerErrorException", "Internal Server Error", 502); } finally { clearTimeout(timer); }
  }

  private corsHeaders(cors: HttpApiCorsState, origin: string | undefined, preflight: boolean): Record<string, string> {
    const headers: Record<string, string> = {}; const allowedOrigin = cors.allowOrigins?.includes("*") ? "*" : origin && cors.allowOrigins?.includes(origin) ? origin : undefined; if (!allowedOrigin) return headers; headers["access-control-allow-origin"] = allowedOrigin; if (cors.allowCredentials) headers["access-control-allow-credentials"] = "true"; if (preflight) { if (cors.allowMethods?.length) headers["access-control-allow-methods"] = cors.allowMethods.join(","); if (cors.allowHeaders?.length) headers["access-control-allow-headers"] = cors.allowHeaders.join(","); if (cors.maxAge !== undefined) headers["access-control-max-age"] = String(cors.maxAge); } else if (cors.exposeHeaders?.length) headers["access-control-expose-headers"] = cors.exposeHeaders.join(","); return headers;
  }

  private applyCors(result: HttpBackendResult, cors: HttpApiCorsState | undefined, origin: string | undefined): HttpBackendResult {
    if (!cors) return result; const headers = Object.fromEntries(Object.entries(result.headers).filter(([name]) => !name.toLowerCase().startsWith("access-control-"))); return { ...result, headers: { ...headers, ...this.corsHeaders(cors, origin, false) } };
  }

  private async publishMetrics(input: HttpInvocationInput, result: HttpBackendResult, latency: number): Promise<void> {
    if (!this.telemetry) return; const dimensions: Array<Record<string, string>> = [{ ApiId: input.api.apiId }, { ApiId: input.api.apiId, Stage: input.stage.stageName }]; const setting = input.stage.routeSettings[input.route.routeKey] ?? input.stage.defaultRouteSettings; if (setting.detailedMetricsEnabled) dimensions.push({ ApiId: input.api.apiId, Stage: input.stage.stageName, Route: input.route.routeKey }); const events: Promise<void>[] = [];
    for (const values of dimensions) { for (const [metricName, value, unit] of [["Count", 1, "Count"], ["Latency", latency, "Milliseconds"], ["IntegrationLatency", result.integrationLatency, "Milliseconds"], ["DataProcessed", input.body.length + result.body.length, "Bytes"]] as const) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName, dimensions: values, value, unit, timestamp: this.clock.now() })); if (result.status >= 400 && result.status < 500) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "4xx", dimensions: values, value: 1, unit: "Count", timestamp: this.clock.now() })); if (result.status >= 500) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "5xx", dimensions: values, value: 1, unit: "Count", timestamp: this.clock.now() })); }
    await Promise.all(events);
  }

  private accessLogGroup(destinationArn: string): string | undefined { return destinationArn.match(/:log-group:([^:*]+)(?::\*)?$/)?.[1]; }

  private async writeAccessLog(input: HttpInvocationInput, result: HttpBackendResult, latency: number, error?: AwsError): Promise<void> {
    if (!this.logs || !input.stage.accessLogSettings) return; const group = this.accessLogGroup(input.stage.accessLogSettings.destinationArn); if (!group) return; const values: Record<string, unknown> = { accountId: this.store.accountId, apiId: input.api.apiId, domainName: input.headers.host, httpMethod: input.method, integrationErrorMessage: error?.message, integrationLatency: result.integrationLatency, integrationStatus: result.status, path: input.path, protocol: "HTTP/1.1", requestId: input.requestId, requestTime: new Date(this.clock.now()).toUTCString(), requestTimeEpoch: this.clock.now(), responseLatency: latency, responseLength: result.body.length, routeKey: input.route.routeKey, stage: input.stage.stageName, status: result.status };
    const message = input.stage.accessLogSettings.format.replace(/\$context\.([A-Za-z0-9_.]+)/g, (_match, key) => values[key] === undefined ? "-" : String(values[key])); const stream = `${new Date(this.clock.now()).toISOString().slice(0, 10).replace(/-/g, "/")}/${input.requestId}`;
    try { await this.logs.CreateLogStream({ logGroupName: group, logStreamName: stream }); } catch (caught) { if (!(caught instanceof AwsError) || caught.code !== "ResourceAlreadyExistsException") return; }
    await this.logs.PutLogEvents({ logGroupName: group, logStreamName: stream, logEvents: [{ timestamp: this.clock.now(), message }] }).catch(() => undefined);
  }

  customDomainInvocation(host: string | undefined, pathname: string): HttpApiDomainResolution {
    const requested = String(host ?? "").split(":")[0].toLowerCase(); const domain = Object.values(this.domains).find(candidate => candidate.domainName === requested || candidate.domainName.startsWith("*.") && requested.endsWith(candidate.domainName.slice(1)));
    if (!domain) return { matched: false };
    const segments = pathname.replace(/^\/+/, "").split("/"); const mappings = Object.values(domain.apiMappings).sort((a, b) => (b.apiMappingKey?.length ?? 0) - (a.apiMappingKey?.length ?? 0));
    const mapping = mappings.find(candidate => { const key = candidate.apiMappingKey?.split("/") ?? []; return key.every((part, index) => segments[index] === part); });
    if (!mapping) return { matched: true };
    const consumed = mapping.apiMappingKey?.split("/").length ?? 0; const tail = `/${segments.slice(consumed).join("/")}`; return { matched: true, pathname: `/${mapping.apiId}/${encodeURIComponent(mapping.stage)}${tail === "/" ? "" : tail}` };
  }

  invocationAuthorizationType(pathname: string, method: string): HttpApiRouteState["authorizationType"] { return this.resolveInvocation(pathname, method).route.authorizationType; }

  canonicalAuthorizationPath(pathname: string, method: string): string {
    const resolved = this.resolveInvocation(pathname, method); return `/${resolved.api.apiId}/${encodeURIComponent(resolved.stage.stageName)}${resolved.path === "/" ? "/" : resolved.path}`;
  }

  sendInvocationError(_req: IncomingMessage, res: ServerResponse, _pathname: string, error: unknown, requestId: string): void {
    const aws = error instanceof AwsError ? error : new AwsError("InternalServerErrorException", error instanceof Error ? error.message : String(error), 500); res.setHeader("x-amzn-requestid", requestId); json(res, { message: aws.status === 403 ? "Forbidden" : aws.message }, aws.status);
  }

  async invoke(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const started = performance.now(); let input: HttpInvocationInput | undefined; let result: HttpBackendResult | undefined; let failure: AwsError | undefined;
    try {
      const resolved = this.resolveInvocation(pathname, req.method ?? "GET"); const { headers, multiHeaders } = this.requestHeaders(req); const { query, multiQuery } = this.requestQueries(url); const customDomain = this.customDomainInvocation(req.headers.host, url.pathname).matched;
      if (resolved.api.disableExecuteApiEndpoint && !customDomain) throw new AwsError("ForbiddenException", "Forbidden", 403);
      input = { method: req.method ?? "GET", path: resolved.path, rawQueryString: url.search.slice(1), headers, multiHeaders, query, multiQuery, pathParameters: resolved.pathParameters, body: await readBody(req), requestId: String(res.getHeader("x-amzn-requestid") ?? id(24)), sourceIp: req.socket.remoteAddress?.replace(/^::ffff:/, ""), stage: resolved.stage, api: resolved.api, route: resolved.route, snapshot: resolved.snapshot, principal: (req as any).awsPrincipal as PrincipalContext | undefined, identityAuthorization: (req as any).awsIdentityAuthorization as AuthorizationResult | undefined };
      const cors = input.snapshot.corsConfiguration; const preflight = input.method === "OPTIONS" && Boolean(input.headers.origin) && Boolean(input.headers["access-control-request-method"]);
      if (preflight && cors) result = { status: 204, headers: this.corsHeaders(cors, input.headers.origin, true), body: Buffer.alloc(0), integrationLatency: 0 };
      else {
        const settings = input.stage.routeSettings[input.route.routeKey] ?? input.stage.defaultRouteSettings;
        if (!this.consumeBucket(`account:${this.region}`) || !this.consumeBucket(`stage:${input.api.apiId}:${input.stage.stageName}:${input.route.routeKey}`, settings.throttlingRateLimit ?? this.accountRateLimit, settings.throttlingBurstLimit ?? this.accountBurstLimit)) throw new AwsError("TooManyRequestsException", "Too Many Requests", 429);
        const authorization = await this.authorizeInvocation(input); const integrationId = input.route.target?.match(/^integrations\/(.+)$/)?.[1]; const integration = integrationId ? input.snapshot.integrations[integrationId] : undefined; if (!integration) throw new AwsError("NotFoundException", "Not Found", 404);
        result = integration.integrationSubtype === "SQS-SendMessage" ? await this.invokeSqsIntegration(integration, input) : integration.integrationType === "AWS_PROXY" ? await this.invokeLambdaIntegration(integration, input, authorization) : await this.invokeHttpIntegration(integration, input); result = this.applyCors(result, cors, input.headers.origin);
      }
      const latency = performance.now() - started; await Promise.all([this.publishMetrics(input, result, latency), this.writeAccessLog(input, result, latency)]);
      res.statusCode = result.status; for (const [name, value] of Object.entries(result.headers)) if (!new Set(["connection", "content-length", "transfer-encoding"]).has(name.toLowerCase())) res.setHeader(name, value); if (!res.hasHeader("content-length")) res.setHeader("content-length", String(result.body.length)); res.end(result.body); return;
    } catch (error) {
      failure = error instanceof AwsError ? error : new AwsError("InternalServerErrorException", error instanceof Error ? error.message : String(error), 500); const message = new Set([401, 403, 404, 429]).has(failure.status) ? failure.status === 401 ? "Unauthorized" : failure.status === 403 ? "Forbidden" : failure.status === 404 ? "Not Found" : "Too Many Requests" : "Internal Server Error"; result = { status: failure.status >= 400 && failure.status <= 599 ? failure.status : 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ message })), integrationLatency: 0 }; if (input) { result = this.applyCors(result, input.snapshot.corsConfiguration, input.headers.origin); const latency = performance.now() - started; await Promise.all([this.publishMetrics(input, result, latency), this.writeAccessLog(input, result, latency, failure)]); } res.statusCode = result.status; for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value); res.setHeader("content-length", String(result.body.length)); res.end(result.body);
    }
  }
}
