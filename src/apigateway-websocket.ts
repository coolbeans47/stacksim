import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { AwsError, sendAwsError } from "./errors.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import type { InvokeResult, LambdaService } from "./lambda.js";
import type { StateStore } from "./state.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import { evaluateIdentityPolicy, evaluateRoleAuthorization, evaluateTrust, type AuthorizationResult } from "./iam/evaluator.js";
import type {
  HttpApiRouteSettingsState,
  HttpApiStageState,
  WebSocketApiState,
  WebSocketAuthorizerState,
  WebSocketDeploymentSnapshotState,
  WebSocketDeploymentState,
  WebSocketIntegrationResponseState,
  WebSocketIntegrationState,
  WebSocketModelState,
  WebSocketRouteResponseState,
  WebSocketRouteState,
} from "./types.js";
import { id, json, readBody, readJson } from "./util.js";
import { cloudFormationResourceId, getCloudFormationIdempotencyKey } from "./core/internal-request.js";

const METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const AUTHORIZATION_TYPES = new Set(["NONE", "AWS_IAM", "CUSTOM"]);
const INTEGRATION_TYPES = new Set(["AWS_PROXY", "AWS", "HTTP_PROXY", "HTTP", "MOCK"]);

function present<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function webSocketApiView(api: WebSocketApiState): any {
  return present({
    apiEndpoint: api.apiEndpoint,
    apiGatewayManaged: api.apiGatewayManaged,
    apiId: api.apiId,
    apiKeySelectionExpression: "$request.header.x-api-key",
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

function integrationView(integration: WebSocketIntegrationState): any {
  return present({
    apiGatewayManaged: integration.apiGatewayManaged,
    connectionType: integration.connectionType,
    contentHandlingStrategy: integration.contentHandlingStrategy,
    credentialsArn: integration.credentialsArn,
    description: integration.description,
    integrationId: integration.integrationId,
    integrationMethod: integration.integrationMethod,
    integrationResponseSelectionExpression: integration.integrationResponseSelectionExpression,
    integrationType: integration.integrationType,
    integrationUri: integration.integrationUri,
    passthroughBehavior: integration.passthroughBehavior,
    requestParameters: structuredClone(integration.requestParameters),
    requestTemplates: structuredClone(integration.requestTemplates),
    templateSelectionExpression: integration.templateSelectionExpression,
    timeoutInMillis: integration.timeoutInMillis,
    tlsConfig: structuredClone(integration.tlsConfig),
  });
}

function integrationResponseView(response: WebSocketIntegrationResponseState): any {
  return present({
    contentHandlingStrategy: response.contentHandlingStrategy,
    integrationResponseId: response.integrationResponseId,
    integrationResponseKey: response.integrationResponseKey,
    responseParameters: structuredClone(response.responseParameters),
    responseTemplates: structuredClone(response.responseTemplates),
    templateSelectionExpression: response.templateSelectionExpression,
  });
}

function routeView(route: WebSocketRouteState): any {
  return present({
    apiGatewayManaged: route.apiGatewayManaged,
    apiKeyRequired: route.apiKeyRequired,
    authorizationScopes: [...route.authorizationScopes],
    authorizationType: route.authorizationType,
    authorizerId: route.authorizerId,
    modelSelectionExpression: route.modelSelectionExpression,
    operationName: route.operationName,
    requestModels: structuredClone(route.requestModels),
    requestParameters: structuredClone(route.requestParameters),
    routeId: route.routeId,
    routeKey: route.routeKey,
    routeResponseSelectionExpression: route.routeResponseSelectionExpression,
    target: route.target,
  });
}

function routeResponseView(response: WebSocketRouteResponseState): any {
  return present({
    modelSelectionExpression: response.modelSelectionExpression,
    responseModels: structuredClone(response.responseModels),
    responseParameters: structuredClone(response.responseParameters),
    routeResponseId: response.routeResponseId,
    routeResponseKey: response.routeResponseKey,
  });
}

function authorizerView(authorizer: WebSocketAuthorizerState): any {
  return present({
    authorizerCredentialsArn: authorizer.authorizerCredentialsArn,
    authorizerId: authorizer.authorizerId,
    authorizerResultTtlInSeconds: authorizer.authorizerResultTtlInSeconds,
    authorizerType: authorizer.authorizerType,
    authorizerUri: authorizer.authorizerUri,
    identitySource: [...authorizer.identitySource],
    name: authorizer.name,
  });
}

function modelView(model: WebSocketModelState): any {
  return present({ contentType: model.contentType, description: model.description, modelId: model.modelId, name: model.name, schema: model.schema });
}

function deploymentView(deployment: WebSocketDeploymentState): any {
  return present({ autoDeployed: deployment.autoDeployed, createdDate: new Date(deployment.createdDate).toISOString(), deploymentId: deployment.deploymentId, deploymentStatus: deployment.deploymentStatus, description: deployment.description });
}

function stageView(stage: HttpApiStageState): any {
  return present({
    accessLogSettings: structuredClone(stage.accessLogSettings), apiGatewayManaged: stage.apiGatewayManaged,
    autoDeploy: stage.autoDeploy, createdDate: new Date(stage.createdDate).toISOString(),
    defaultRouteSettings: structuredClone(stage.defaultRouteSettings), deploymentId: stage.deploymentId,
    description: stage.description, lastDeploymentStatusMessage: stage.lastDeploymentStatusMessage,
    lastUpdatedDate: new Date(stage.lastUpdatedDate).toISOString(), routeSettings: structuredClone(stage.routeSettings),
    stageName: stage.stageName, stageVariables: structuredClone(stage.stageVariables), tags: structuredClone(stage.tags),
  });
}

function map(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", `${name} must be a map`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new AwsError("BadRequestException", `${name} values must be strings`);
    result[key] = item;
  }
  return result;
}

function constraints(value: unknown, name: string): Record<string, { required: boolean }> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", `${name} must be a map`);
  const result: Record<string, { required: boolean }> = {};
  for (const [key, item] of Object.entries(value as Record<string, any>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AwsError("BadRequestException", `${name} entries must be constraints`);
    result[key] = { required: Boolean(item.required) };
  }
  return result;
}

export interface WebSocketRuntimeSchedule {
  idleTimeoutMs: number;
  lifetimeMs: number;
}

interface ResolvedWebSocketStage {
  api: WebSocketApiState;
  stage: HttpApiStageState;
  snapshot: WebSocketDeploymentSnapshotState;
}

interface LiveConnection extends ResolvedWebSocketStage {
  connectionId: string;
  socket: Socket;
  connectedAt: number;
  lastActiveAt: number;
  headers: Record<string, string>;
  multiHeaders: Record<string, string[]>;
  query: Record<string, string>;
  multiQuery: Record<string, string[]>;
  sourceIp?: string;
  userAgent: string;
  domainName: string;
  principal?: PrincipalContext;
  identityAuthorization?: AuthorizationResult;
  buffer: Buffer;
  fragmentedOpcode?: number;
  fragments: Buffer[];
  fragmentBytes: number;
  closing: boolean;
  finalized: boolean;
  idleTimer?: NodeJS.Timeout;
  lifetimeTimer?: NodeJS.Timeout;
  work: Promise<void>;
}

interface WebSocketIntegrationResult {
  statusCode: number;
  body: Buffer;
  integrationLatency: number;
  error?: AwsError;
}

export class ApiGatewayWebSocketService {
  private readonly authorizerCache = new Map<string, { expiresAt: number; value: { allowed: boolean; principalId?: string; context: Record<string, unknown> } }>();
  private readonly connections = new Map<string, LiveConnection>();
  private readonly sockets = new Set<Socket>();
  private readonly finalizations = new Set<Promise<void>>();

  constructor(
    private readonly store: StateStore,
    private readonly lambda: LambdaService,
    private readonly invokePort: number | (() => number),
    private readonly region: string,
    private readonly clock: Clock = new SystemClock(),
    private readonly authMode: "off" | "validate" | "enforce" = "off",
    private readonly telemetry?: TelemetryBus,
    private readonly logs?: CloudWatchLogsService,
    private readonly invokeProtocol: "http" | "https" = "http",
    private readonly schedule: WebSocketRuntimeSchedule = { idleTimeoutMs: 10 * 60_000, lifetimeMs: 2 * 60 * 60_000 },
  ) {}

  private get apis(): Record<string, WebSocketApiState> { return this.store.regionState(this.region).webSocketApis; }
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

  hasApi(apiId: string): boolean { return Boolean(this.apis[apiId]); }
  apiViews(): any[] { return Object.values(this.apis).sort((a, b) => a.apiId.localeCompare(b.apiId)).map(webSocketApiView); }
  stageExists(apiId: string, stageName: string): boolean { return Boolean(this.apis[apiId]?.stages[stageName]); }

  tagTarget(arn: string): { tags: Record<string, string>; set(tags: Record<string, string>): void } | undefined {
    for (const api of Object.values(this.apis)) {
      if (arn === `arn:aws:apigateway:${this.region}::/apis/${api.apiId}`) return { tags: api.tags, set: tags => { api.tags = tags; } };
      for (const stage of Object.values(api.stages)) if (arn === `arn:aws:apigateway:${this.region}::/apis/${api.apiId}/stages/${stage.stageName}`) return { tags: stage.tags, set: tags => { stage.tags = tags; } };
    }
    return undefined;
  }

  async createApi(input: any, operationToken?: string): Promise<WebSocketApiState> {
    if (input.protocolType !== "WEBSOCKET") throw new AwsError("BadRequestException", "ProtocolType must be WEBSOCKET");
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 128) throw new AwsError("BadRequestException", "Name is required and must not exceed 128 characters");
    const routeSelectionExpression = String(input.routeSelectionExpression ?? "").trim();
    if (!routeSelectionExpression || routeSelectionExpression.length > 256 || !routeSelectionExpression.startsWith("$request.body")) throw new AwsError("BadRequestException", "RouteSelectionExpression must select from $request.body");
    const ipAddressType = input.ipAddressType ?? "ipv4";
    if (!new Set(["ipv4", "dualstack"]).has(ipAddressType)) throw new AwsError("BadRequestException", "IpAddressType must be ipv4 or dualstack");
    if (input.corsConfiguration !== undefined || input.target !== undefined) throw new AwsError("BadRequestException", "CorsConfiguration and quick-create Target are valid only for HTTP APIs");
    const apiId = cloudFormationResourceId(operationToken, "api") ?? id(10);
    const replay = this.replayCreated(this.apis[apiId], operationToken, "API");
    if (replay) return replay;
    if (this.apis[apiId]) throw new AwsError("ConflictException", "An API with this identifier already exists", 409);
    const api: WebSocketApiState = {
      apiId, name, description: input.description, version: input.version, protocolType: "WEBSOCKET", ipAddressType,
      routeSelectionExpression, apiEndpoint: `${this.invokeProtocol === "https" ? "wss" : "ws"}://localhost:${this.currentInvokePort()}/${apiId}`,
      apiGatewayManaged: false, createdDate: this.clock.now(), tags: this.tags(input.tags), disableExecuteApiEndpoint: Boolean(input.disableExecuteApiEndpoint),
      integrations: {}, routes: {}, authorizers: {}, deployments: {}, stages: {}, models: {},
      cloudFormationOperationToken: operationToken,
    };
    this.apis[apiId] = api;
    await this.store.save();
    return api;
  }

  private api(apiId: string): WebSocketApiState {
    const api = this.apis[apiId];
    if (!api) throw new AwsError("NotFoundException", `Invalid API identifier specified ${apiId}`, 404);
    return api;
  }

  private integration(api: WebSocketApiState, integrationId: string): WebSocketIntegrationState {
    const integration = api.integrations[integrationId];
    if (!integration) throw new AwsError("NotFoundException", `Invalid Integration identifier specified ${integrationId}`, 404);
    return integration;
  }

  private route(api: WebSocketApiState, routeId: string): WebSocketRouteState {
    const route = api.routes[routeId];
    if (!route) throw new AwsError("NotFoundException", `Invalid Route identifier specified ${routeId}`, 404);
    return route;
  }

  private authorizer(api: WebSocketApiState, authorizerId: string): WebSocketAuthorizerState {
    const authorizer = api.authorizers[authorizerId];
    if (!authorizer) throw new AwsError("NotFoundException", `Invalid Authorizer identifier specified ${authorizerId}`, 404);
    return authorizer;
  }

  private model(api: WebSocketApiState, modelId: string): WebSocketModelState {
    const model = api.models[modelId];
    if (!model) throw new AwsError("NotFoundException", `Invalid Model identifier specified ${modelId}`, 404);
    return model;
  }

  private deployment(api: WebSocketApiState, deploymentId: string): WebSocketDeploymentState {
    const deployment = api.deployments[deploymentId];
    if (!deployment) throw new AwsError("NotFoundException", `Invalid Deployment identifier specified ${deploymentId}`, 404);
    return deployment;
  }

  private stage(api: WebSocketApiState, stageName: string): HttpApiStageState {
    const stage = api.stages[stageName];
    if (!stage) throw new AwsError("NotFoundException", `Invalid Stage identifier specified ${stageName}`, 404);
    return stage;
  }

  private page<T>(operation: string, scope: string, values: T[], url: URL): { items: T[]; nextToken?: string } {
    const max = Math.min(500, Math.max(1, Number(url.searchParams.get("maxResults") ?? 25)));
    if (!Number.isInteger(max)) throw new AwsError("BadRequestException", "MaxResults must be an integer");
    let start = 0; const token = url.searchParams.get("nextToken");
    if (token) {
      try { const cursor = this.tokens.decode<{ scope: string; index: number }>(operation, token); if (cursor.scope !== scope || !Number.isInteger(cursor.index) || cursor.index < 0 || cursor.index > values.length) throw new Error(); start = cursor.index; }
      catch { throw new AwsError("BadRequestException", "Invalid NextToken"); }
    }
    const items = values.slice(start, start + max); const next = start + items.length;
    return { items, ...(next < values.length ? { nextToken: this.tokens.encode(operation, { scope, index: next }) } : {}) };
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

  private snapshot(api: WebSocketApiState): WebSocketDeploymentSnapshotState {
    return structuredClone({ routes: api.routes, integrations: api.integrations, authorizers: api.authorizers, models: api.models });
  }

  private createDeploymentState(api: WebSocketApiState, description?: string, autoDeployed = false): WebSocketDeploymentState {
    const snapshot = this.snapshot(api);
    return { deploymentId: id(10), description, createdDate: this.clock.now(), deploymentStatus: "SUCCEEDED", autoDeployed, snapshot, contentHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
  }

  private async autoDeploy(api: WebSocketApiState): Promise<void> {
    const stages = Object.values(api.stages).filter(stage => stage.autoDeploy);
    if (!stages.length) { await this.store.save(); return; }
    const deployment = this.createDeploymentState(api, "Automatic deployment", true); api.deployments[deployment.deploymentId] = deployment;
    for (const stage of stages) { stage.deploymentId = deployment.deploymentId; stage.lastUpdatedDate = this.clock.now(); stage.lastDeploymentStatusMessage = "Deployment completed successfully."; }
    await this.store.save();
  }

  private validateIntegration(input: any, existing?: WebSocketIntegrationState): WebSocketIntegrationState {
    const type = String(input.integrationType ?? existing?.integrationType ?? "") as WebSocketIntegrationState["integrationType"];
    if (!INTEGRATION_TYPES.has(type)) throw new AwsError("BadRequestException", "Invalid IntegrationType");
    if (input.connectionType !== undefined && input.connectionType !== "INTERNET") throw new AwsError("BadRequestException", "WebSocket APIs support INTERNET integrations");
    const uri = input.integrationUri === undefined ? existing?.integrationUri : String(input.integrationUri || "") || undefined;
    if (type !== "MOCK" && !uri) throw new AwsError("BadRequestException", "IntegrationUri is required");
    if (type === "MOCK" && uri) throw new AwsError("BadRequestException", "MOCK integrations do not use IntegrationUri");
    if ((type === "AWS_PROXY" || type === "AWS") && uri && !/^(?:arn:aws(?:-[a-z]+)?:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?|arn:aws:apigateway:[a-z0-9-]+:lambda:path\/2015-03-31\/functions\/arn:aws(?:-[a-z]+)?:lambda:[^/]+\/invocations)$/.test(uri)) throw new AwsError("BadRequestException", "AWS integrations must identify a Lambda function");
    if ((type === "HTTP" || type === "HTTP_PROXY") && uri) { try { const target = new URL(uri); if (!new Set(["http:", "https:"]).has(target.protocol)) throw new Error(); } catch { throw new AwsError("BadRequestException", "HTTP integrations require an HTTP or HTTPS URL"); } }
    const method = String(input.integrationMethod ?? existing?.integrationMethod ?? (type === "AWS" || type === "AWS_PROXY" ? "POST" : type === "MOCK" ? "" : "POST")).toUpperCase() || undefined;
    if (method && !METHODS.has(method)) throw new AwsError("BadRequestException", "Invalid IntegrationMethod");
    const timeout = Number(input.timeoutInMillis ?? existing?.timeoutInMillis ?? 29_000);
    if (!Number.isInteger(timeout) || timeout < 50 || timeout > 29_000) throw new AwsError("BadRequestException", "TimeoutInMillis must be between 50 and 29000");
    const contentHandlingStrategy = input.contentHandlingStrategy ?? existing?.contentHandlingStrategy;
    if (contentHandlingStrategy !== undefined && !new Set(["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"]).has(contentHandlingStrategy)) throw new AwsError("BadRequestException", "Invalid ContentHandlingStrategy");
    const passthroughBehavior = input.passthroughBehavior ?? existing?.passthroughBehavior;
    if (passthroughBehavior !== undefined && !new Set(["WHEN_NO_MATCH", "NEVER", "WHEN_NO_TEMPLATES"]).has(passthroughBehavior)) throw new AwsError("BadRequestException", "Invalid PassthroughBehavior");
    const credentialsArn = input.credentialsArn ?? existing?.credentialsArn;
    this.assertGatewayRole(credentialsArn, "integration");
    return {
      integrationId: existing?.integrationId ?? id(10), description: input.description ?? existing?.description, integrationType: type,
      integrationMethod: method, integrationUri: uri, credentialsArn, connectionType: "INTERNET",
      contentHandlingStrategy, passthroughBehavior, requestParameters: input.requestParameters === undefined ? structuredClone(existing?.requestParameters ?? {}) : map(input.requestParameters, "RequestParameters"),
      requestTemplates: input.requestTemplates === undefined ? structuredClone(existing?.requestTemplates ?? {}) : map(input.requestTemplates, "RequestTemplates"),
      templateSelectionExpression: input.templateSelectionExpression ?? existing?.templateSelectionExpression, timeoutInMillis: timeout,
      tlsConfig: structuredClone(input.tlsConfig ?? existing?.tlsConfig), integrationResponseSelectionExpression: input.integrationResponseSelectionExpression ?? existing?.integrationResponseSelectionExpression,
      apiGatewayManaged: existing?.apiGatewayManaged ?? false, integrationResponses: structuredClone(existing?.integrationResponses ?? {}),
      cloudFormationOperationToken: existing?.cloudFormationOperationToken,
    };
  }

  private validateAuthorizer(input: any, existing?: WebSocketAuthorizerState): WebSocketAuthorizerState {
    if (String(input.authorizerType ?? existing?.authorizerType ?? "") !== "REQUEST") throw new AwsError("BadRequestException", "WebSocket APIs support REQUEST authorizers");
    const name = String(input.name ?? existing?.name ?? "").trim(); if (!name || name.length > 128) throw new AwsError("BadRequestException", "Name is required");
    const uri = String(input.authorizerUri ?? existing?.authorizerUri ?? ""); if (!uri) throw new AwsError("BadRequestException", "AuthorizerUri is required");
    const identities = input.identitySource ?? existing?.identitySource ?? [];
    if (!Array.isArray(identities) || identities.some((value: unknown) => typeof value !== "string" || !/^route\.request\.(?:header|querystring)\.[A-Za-z0-9._-]+$/i.test(value))) throw new AwsError("BadRequestException", "IdentitySource entries must use route.request header or querystring expressions");
    const ttl = Number(input.authorizerResultTtlInSeconds ?? existing?.authorizerResultTtlInSeconds ?? 300); if (!Number.isInteger(ttl) || ttl < 0 || ttl > 3600) throw new AwsError("BadRequestException", "AuthorizerResultTtlInSeconds must be between 0 and 3600");
    if (ttl > 0 && !identities.length) throw new AwsError("BadRequestException", "IdentitySource is required when authorizer caching is enabled");
    const authorizerCredentialsArn = input.authorizerCredentialsArn ?? existing?.authorizerCredentialsArn;
    this.assertGatewayRole(authorizerCredentialsArn, "authorizer");
    return { authorizerId: existing?.authorizerId ?? id(10), name, authorizerType: "REQUEST", authorizerUri: uri, authorizerCredentialsArn, identitySource: identities.map(String), authorizerResultTtlInSeconds: ttl, cloudFormationOperationToken: existing?.cloudFormationOperationToken };
  }

  private validateRoute(api: WebSocketApiState, input: any, existing?: WebSocketRouteState): WebSocketRouteState {
    const routeKey = String(input.routeKey ?? existing?.routeKey ?? "").trim();
    if (!routeKey || routeKey.length > 128 || routeKey.startsWith("$") && !new Set(["$connect", "$disconnect", "$default"]).has(routeKey)) throw new AwsError("BadRequestException", "Invalid RouteKey");
    if (Object.values(api.routes).some(route => route.routeKey === routeKey && route.routeId !== existing?.routeId)) throw new AwsError("ConflictException", "A route with this RouteKey already exists", 409);
    const authorizationType = String(input.authorizationType ?? existing?.authorizationType ?? "NONE") as WebSocketRouteState["authorizationType"];
    if (!AUTHORIZATION_TYPES.has(authorizationType)) throw new AwsError("BadRequestException", "Invalid AuthorizationType");
    if (routeKey !== "$connect" && authorizationType !== "NONE") throw new AwsError("BadRequestException", "Authorization is supported only on the $connect route");
    const authorizerId = input.authorizerId === undefined ? existing?.authorizerId : input.authorizerId || undefined;
    if (authorizationType === "CUSTOM" && (!authorizerId || !api.authorizers[authorizerId])) throw new AwsError("BadRequestException", "CUSTOM authorization requires a valid AuthorizerId");
    if (authorizationType !== "CUSTOM" && authorizerId) throw new AwsError("BadRequestException", "AuthorizerId is valid only for CUSTOM authorization");
    const target = input.target === undefined ? existing?.target : input.target || undefined;
    if (target && (!/^integrations\/[A-Za-z0-9]+$/.test(target) || !api.integrations[target.slice("integrations/".length)])) throw new AwsError("BadRequestException", "Target must reference an existing integration");
    const routeResponseSelectionExpression = input.routeResponseSelectionExpression ?? existing?.routeResponseSelectionExpression ?? "$default";
    if (routeResponseSelectionExpression !== "$default") throw new AwsError("BadRequestException", "WebSocket route responses use $default selection");
    return {
      routeId: existing?.routeId ?? id(10), routeKey, authorizationType, authorizerId, authorizationScopes: [], apiKeyRequired: Boolean(input.apiKeyRequired ?? existing?.apiKeyRequired),
      modelSelectionExpression: input.modelSelectionExpression ?? existing?.modelSelectionExpression, operationName: input.operationName ?? existing?.operationName,
      requestModels: input.requestModels === undefined ? structuredClone(existing?.requestModels ?? {}) : map(input.requestModels, "RequestModels"),
      requestParameters: input.requestParameters === undefined ? structuredClone(existing?.requestParameters ?? {}) : constraints(input.requestParameters, "RequestParameters"),
      routeResponseSelectionExpression, target, apiGatewayManaged: existing?.apiGatewayManaged ?? false, routeResponses: structuredClone(existing?.routeResponses ?? {}),
      cloudFormationOperationToken: existing?.cloudFormationOperationToken,
    };
  }

  private routeSettings(value: any, existing: HttpApiRouteSettingsState = {}): HttpApiRouteSettingsState {
    if (value === undefined) return structuredClone(existing); const result = { ...existing };
    if (value.detailedMetricsEnabled !== undefined) result.detailedMetricsEnabled = Boolean(value.detailedMetricsEnabled);
    if (value.throttlingBurstLimit !== undefined) { const burst = Number(value.throttlingBurstLimit); if (!Number.isInteger(burst) || burst < 0) throw new AwsError("BadRequestException", "ThrottlingBurstLimit must be a non-negative integer"); result.throttlingBurstLimit = burst; }
    if (value.throttlingRateLimit !== undefined) { const rate = Number(value.throttlingRateLimit); if (!Number.isFinite(rate) || rate < 0) throw new AwsError("BadRequestException", "ThrottlingRateLimit must be non-negative"); result.throttlingRateLimit = rate; }
    return result;
  }

  private routeSettingsMap(api: WebSocketApiState, value: unknown): Record<string, HttpApiRouteSettingsState> {
    if (value === undefined) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "RouteSettings must be a map");
    const valid = new Set(Object.values(api.routes).map(route => route.routeKey)); const output: Record<string, HttpApiRouteSettingsState> = {};
    for (const [key, setting] of Object.entries(value as Record<string, unknown>)) { if (!valid.has(key)) throw new AwsError("BadRequestException", `RouteSettings references unknown route ${key}`); output[key] = this.routeSettings(setting); }
    return output;
  }

  private stageVariables(value: unknown, existing: Record<string, string> = {}): Record<string, string> {
    if (value === undefined) return structuredClone(existing); if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "StageVariables must be a map");
    const output: Record<string, string> = {}; for (const [key, item] of Object.entries(value as Record<string, unknown>)) { if (!/^[A-Za-z0-9]+$/.test(key) || typeof item !== "string" || !item || item.length > 512) throw new AwsError("BadRequestException", "Invalid stage variable"); output[key] = item; } return output;
  }

  private accessLogSettings(value: unknown, existing?: HttpApiStageState["accessLogSettings"]): HttpApiStageState["accessLogSettings"] {
    if (value === undefined) return structuredClone(existing); if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("BadRequestException", "AccessLogSettings must be an object");
    const input = value as any; const destinationArn = String(input.destinationArn ?? existing?.destinationArn ?? ""); const format = String(input.format ?? existing?.format ?? "");
    if (!new RegExp(`^arn:aws(?:-[a-z]+)?:logs:${this.region}:${this.store.accountId}:log-group:[^:*]+(?::\\*)?$`).test(destinationArn)) throw new AwsError("BadRequestException", "DestinationArn must identify a local CloudWatch Logs log group");
    if (!format || format.length > 1024 || !/\$context\.(?:requestId|extendedRequestId)\b/.test(format)) throw new AwsError("BadRequestException", "Access log format must include $context.requestId or $context.extendedRequestId");
    return { destinationArn, format };
  }

  private clearAuthorizerCache(apiId: string, authorizerId?: string): void {
    for (const key of this.authorizerCache.keys()) if (key.startsWith(`${apiId}\0`) && (!authorizerId || key.startsWith(`${apiId}\0${authorizerId}\0`))) this.authorizerCache.delete(key);
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    try { await this.handleChecked(req, res, pathname, url); }
    catch (error) { sendAwsError(res, error, "rest"); }
  }

  private async handleChecked(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const match = pathname.match(/^\/v2\/apis\/([^/]+)(.*)$/); if (!match) throw new AwsError("NotFoundException", "Unknown API Gateway v2 WebSocket route", 404);
    const api = this.api(decodeURIComponent(match[1])); const suffix = match[2];
    if (!suffix) {
      if (req.method === "GET") return json(res, webSocketApiView(api));
      if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(api); if (input.protocolType !== undefined && input.protocolType !== "WEBSOCKET") throw new AwsError("BadRequestException", "ProtocolType cannot be changed"); if (input.name !== undefined) { const name = String(input.name).trim(); if (!name || name.length > 128) throw new AwsError("BadRequestException", "Invalid Name"); updated.name = name; } if (input.description !== undefined) updated.description = input.description; if (input.version !== undefined) updated.version = input.version; if (input.disableExecuteApiEndpoint !== undefined) updated.disableExecuteApiEndpoint = Boolean(input.disableExecuteApiEndpoint); if (input.routeSelectionExpression !== undefined) { const expression = String(input.routeSelectionExpression); if (!expression.startsWith("$request.body") || expression.length > 256) throw new AwsError("BadRequestException", "Invalid RouteSelectionExpression"); updated.routeSelectionExpression = expression; } if (input.ipAddressType !== undefined) { if (!new Set(["ipv4", "dualstack"]).has(input.ipAddressType)) throw new AwsError("BadRequestException", "Invalid IpAddressType"); updated.ipAddressType = input.ipAddressType; } this.apis[api.apiId] = updated; await this.autoDeploy(updated); return json(res, webSocketApiView(updated)); }
      if (req.method === "DELETE") { delete this.apis[api.apiId]; await this.store.save(); res.statusCode = 204; res.end(); return; }
    }
    if (suffix === "/cors" || suffix.includes("/cache/authorizers")) throw new AwsError("BadRequestException", "This operation is valid only for HTTP APIs");

    if (suffix === "/integrations") {
      if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const integrationId = cloudFormationResourceId(operationToken, "integration"); const replay = integrationId ? this.replayCreated(api.integrations[integrationId], operationToken, "integration") : undefined; if (replay) return json(res, integrationView(replay), 201); const item = this.validateIntegration(await readJson(req)); if (operationToken) { item.integrationId = integrationId!; item.cloudFormationOperationToken = operationToken; } api.integrations[item.integrationId] = item; await this.autoDeploy(api); return json(res, integrationView(item), 201); }
      if (req.method === "GET") return json(res, this.page("GetIntegrations", api.apiId, Object.values(api.integrations).sort((a, b) => a.integrationId.localeCompare(b.integrationId)).map(integrationView), url));
    }
    const integrationMatch = suffix.match(/^\/integrations\/([^/]+)(.*)$/);
    if (integrationMatch) {
      const integration = this.integration(api, decodeURIComponent(integrationMatch[1])); const tail = integrationMatch[2];
      if (!tail) {
        if (req.method === "GET") return json(res, integrationView(integration));
        if (req.method === "PATCH") { const updated = this.validateIntegration(await readJson(req), integration); api.integrations[integration.integrationId] = updated; await this.autoDeploy(api); return json(res, integrationView(updated)); }
        if (req.method === "DELETE") { if (Object.values(api.routes).some(route => route.target === `integrations/${integration.integrationId}`)) throw new AwsError("ConflictException", "The integration is referenced by a route", 409); delete api.integrations[integration.integrationId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; }
      }
      if (tail === "/integrationresponses") {
        if (integration.integrationType.endsWith("PROXY")) throw new AwsError("BadRequestException", "Proxy integrations do not use integration responses");
        if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const responseId = cloudFormationResourceId(operationToken, "integration-response"); const replay = responseId ? this.replayCreated(integration.integrationResponses[responseId], operationToken, "integration response") : undefined; if (replay) return json(res, integrationResponseView(replay), 201); const input = await readJson(req); const key = String(input.integrationResponseKey ?? ""); if (!key) throw new AwsError("BadRequestException", "IntegrationResponseKey is required"); if (Object.values(integration.integrationResponses).some(item => item.integrationResponseKey === key)) throw new AwsError("ConflictException", "An integration response with this key already exists", 409); const item: WebSocketIntegrationResponseState = { integrationResponseId: responseId ?? id(10), integrationResponseKey: key, contentHandlingStrategy: input.contentHandlingStrategy, responseParameters: map(input.responseParameters, "ResponseParameters"), responseTemplates: map(input.responseTemplates, "ResponseTemplates"), templateSelectionExpression: input.templateSelectionExpression, cloudFormationOperationToken: operationToken }; integration.integrationResponses[item.integrationResponseId] = item; await this.autoDeploy(api); return json(res, integrationResponseView(item), 201); }
        if (req.method === "GET") return json(res, this.page("GetIntegrationResponses", `${api.apiId}:${integration.integrationId}`, Object.values(integration.integrationResponses).sort((a, b) => a.integrationResponseKey.localeCompare(b.integrationResponseKey)).map(integrationResponseView), url));
      }
      const responseMatch = tail.match(/^\/integrationresponses\/([^/]+)$/);
      if (responseMatch) { const item = integration.integrationResponses[decodeURIComponent(responseMatch[1])]; if (!item) throw new AwsError("NotFoundException", "Invalid IntegrationResponse identifier specified", 404); if (req.method === "GET") return json(res, integrationResponseView(item)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(item); const key = String(input.integrationResponseKey ?? item.integrationResponseKey); if (!key || Object.values(integration.integrationResponses).some(value => value.integrationResponseKey === key && value.integrationResponseId !== item.integrationResponseId)) throw new AwsError("ConflictException", "Invalid or duplicate IntegrationResponseKey", 409); if (input.integrationResponseKey !== undefined) updated.integrationResponseKey = key; if (input.contentHandlingStrategy !== undefined) updated.contentHandlingStrategy = input.contentHandlingStrategy; if (input.responseParameters !== undefined) updated.responseParameters = map(input.responseParameters, "ResponseParameters"); if (input.responseTemplates !== undefined) updated.responseTemplates = map(input.responseTemplates, "ResponseTemplates"); if (input.templateSelectionExpression !== undefined) updated.templateSelectionExpression = input.templateSelectionExpression || undefined; integration.integrationResponses[item.integrationResponseId] = updated; await this.autoDeploy(api); return json(res, integrationResponseView(updated)); } if (req.method === "DELETE") { delete integration.integrationResponses[item.integrationResponseId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; } }
    }

    if (suffix === "/authorizers") {
      if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const authorizerId = cloudFormationResourceId(operationToken, "authorizer"); const replay = authorizerId ? this.replayCreated(api.authorizers[authorizerId], operationToken, "authorizer") : undefined; if (replay) return json(res, authorizerView(replay), 201); const item = this.validateAuthorizer(await readJson(req)); if (operationToken) { item.authorizerId = authorizerId!; item.cloudFormationOperationToken = operationToken; } if (Object.values(api.authorizers).some(value => value.name === item.name)) throw new AwsError("ConflictException", "An authorizer with this name already exists", 409); api.authorizers[item.authorizerId] = item; await this.autoDeploy(api); return json(res, authorizerView(item), 201); }
      if (req.method === "GET") return json(res, this.page("GetAuthorizers", api.apiId, Object.values(api.authorizers).sort((a, b) => a.authorizerId.localeCompare(b.authorizerId)).map(authorizerView), url));
    }
    const authorizerMatch = suffix.match(/^\/authorizers\/([^/]+)$/);
    if (authorizerMatch) { const item = this.authorizer(api, decodeURIComponent(authorizerMatch[1])); if (req.method === "GET") return json(res, authorizerView(item)); if (req.method === "PATCH") { const updated = this.validateAuthorizer(await readJson(req), item); if (Object.values(api.authorizers).some(value => value.name === updated.name && value.authorizerId !== item.authorizerId)) throw new AwsError("ConflictException", "An authorizer with this name already exists", 409); api.authorizers[item.authorizerId] = updated; this.clearAuthorizerCache(api.apiId, item.authorizerId); await this.autoDeploy(api); return json(res, authorizerView(updated)); } if (req.method === "DELETE") { if (Object.values(api.routes).some(route => route.authorizerId === item.authorizerId)) throw new AwsError("ConflictException", "The authorizer is referenced by a route", 409); delete api.authorizers[item.authorizerId]; this.clearAuthorizerCache(api.apiId, item.authorizerId); await this.autoDeploy(api); res.statusCode = 204; res.end(); return; } }

    if (suffix === "/models") {
      if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const modelId = cloudFormationResourceId(operationToken, "model"); const replay = modelId ? this.replayCreated(api.models[modelId], operationToken, "model") : undefined; if (replay) return json(res, modelView(replay), 201); const input = await readJson(req); const name = String(input.name ?? "").trim(); if (!name || Object.values(api.models).some(value => value.name === name)) throw new AwsError("ConflictException", "Model name is required and must be unique", 409); const schema = String(input.schema ?? ""); try { JSON.parse(schema); } catch { throw new AwsError("BadRequestException", "Schema must be valid JSON"); } const item: WebSocketModelState = { modelId: modelId ?? id(10), name, description: input.description, schema, contentType: input.contentType, cloudFormationOperationToken: operationToken }; api.models[item.modelId] = item; await this.autoDeploy(api); return json(res, modelView(item), 201); }
      if (req.method === "GET") return json(res, this.page("GetModels", api.apiId, Object.values(api.models).sort((a, b) => a.name.localeCompare(b.name)).map(modelView), url));
    }
    const modelMatch = suffix.match(/^\/models\/([^/]+)(\/template)?$/);
    if (modelMatch) { const item = this.model(api, decodeURIComponent(modelMatch[1])); if (modelMatch[2] && req.method === "GET") return json(res, { value: item.schema }); if (!modelMatch[2]) { if (req.method === "GET") return json(res, modelView(item)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(item); if (input.name !== undefined) { const name = String(input.name).trim(); if (!name || Object.values(api.models).some(value => value.name === name && value.modelId !== item.modelId)) throw new AwsError("ConflictException", "Model name must be unique", 409); updated.name = name; } if (input.schema !== undefined) { try { JSON.parse(input.schema); } catch { throw new AwsError("BadRequestException", "Schema must be valid JSON"); } updated.schema = input.schema; } if (input.description !== undefined) updated.description = input.description || undefined; if (input.contentType !== undefined) updated.contentType = input.contentType || undefined; api.models[item.modelId] = updated; await this.autoDeploy(api); return json(res, modelView(updated)); } if (req.method === "DELETE") { if (Object.values(api.routes).some(route => Object.values(route.requestModels).includes(item.name) || Object.values(route.routeResponses).some(response => Object.values(response.responseModels).includes(item.name)))) throw new AwsError("ConflictException", "The model is referenced by a route", 409); delete api.models[item.modelId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; } } }

    if (suffix === "/routes") {
      if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const routeId = cloudFormationResourceId(operationToken, "route"); const replay = routeId ? this.replayCreated(api.routes[routeId], operationToken, "route") : undefined; if (replay) return json(res, routeView(replay), 201); const item = this.validateRoute(api, await readJson(req)); if (operationToken) { item.routeId = routeId!; item.cloudFormationOperationToken = operationToken; } api.routes[item.routeId] = item; await this.autoDeploy(api); return json(res, routeView(item), 201); }
      if (req.method === "GET") return json(res, this.page("GetRoutes", api.apiId, Object.values(api.routes).sort((a, b) => a.routeKey.localeCompare(b.routeKey)).map(routeView), url));
    }
    const routeMatch = suffix.match(/^\/routes\/([^/]+)(.*)$/);
    if (routeMatch) { const route = this.route(api, decodeURIComponent(routeMatch[1])); const tail = routeMatch[2]; if (!tail) { if (req.method === "GET") return json(res, routeView(route)); if (req.method === "PATCH") { const updated = this.validateRoute(api, await readJson(req), route); api.routes[route.routeId] = updated; await this.autoDeploy(api); return json(res, routeView(updated)); } if (req.method === "DELETE") { delete api.routes[route.routeId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; } } if (tail === "/routeresponses") { if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const responseId = cloudFormationResourceId(operationToken, "route-response"); const replay = responseId ? this.replayCreated(route.routeResponses[responseId], operationToken, "route response") : undefined; if (replay) return json(res, routeResponseView(replay), 201); const input = await readJson(req); if (input.routeResponseKey !== "$default") throw new AwsError("BadRequestException", "RouteResponseKey must be $default"); if (Object.keys(route.routeResponses).length) throw new AwsError("ConflictException", "The $default route response already exists", 409); const item: WebSocketRouteResponseState = { routeResponseId: responseId ?? id(10), routeResponseKey: "$default", modelSelectionExpression: input.modelSelectionExpression, responseModels: map(input.responseModels, "ResponseModels"), responseParameters: constraints(input.responseParameters, "ResponseParameters"), cloudFormationOperationToken: operationToken }; route.routeResponses[item.routeResponseId] = item; await this.autoDeploy(api); return json(res, routeResponseView(item), 201); } if (req.method === "GET") return json(res, this.page("GetRouteResponses", `${api.apiId}:${route.routeId}`, Object.values(route.routeResponses).map(routeResponseView), url)); } const responseMatch = tail.match(/^\/routeresponses\/([^/]+)$/); if (responseMatch) { const item = route.routeResponses[decodeURIComponent(responseMatch[1])]; if (!item) throw new AwsError("NotFoundException", "Invalid RouteResponse identifier specified", 404); if (req.method === "GET") return json(res, routeResponseView(item)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(item); if (input.routeResponseKey !== undefined && input.routeResponseKey !== "$default") throw new AwsError("BadRequestException", "RouteResponseKey must be $default"); if (input.modelSelectionExpression !== undefined) updated.modelSelectionExpression = input.modelSelectionExpression || undefined; if (input.responseModels !== undefined) updated.responseModels = map(input.responseModels, "ResponseModels"); if (input.responseParameters !== undefined) updated.responseParameters = constraints(input.responseParameters, "ResponseParameters"); route.routeResponses[item.routeResponseId] = updated; await this.autoDeploy(api); return json(res, routeResponseView(updated)); } if (req.method === "DELETE") { delete route.routeResponses[item.routeResponseId]; await this.autoDeploy(api); res.statusCode = 204; res.end(); return; } } }

    if (suffix === "/deployments") { if (req.method === "POST") { const operationToken = getCloudFormationIdempotencyKey(req); const deploymentId = cloudFormationResourceId(operationToken, "deployment"); const replay = deploymentId ? this.replayCreated(api.deployments[deploymentId], operationToken, "deployment") : undefined; if (replay) return json(res, deploymentView(replay), 201); const input = await readJson(req); const targetStage = input.stageName === undefined ? undefined : this.stage(api, String(input.stageName)); const item = this.createDeploymentState(api, input.description); if (operationToken) { item.deploymentId = deploymentId!; item.cloudFormationOperationToken = operationToken; } api.deployments[item.deploymentId] = item; if (targetStage) { targetStage.deploymentId = item.deploymentId; targetStage.lastUpdatedDate = this.clock.now(); } await this.store.save(); return json(res, deploymentView(item), 201); } if (req.method === "GET") return json(res, this.page("GetDeployments", api.apiId, Object.values(api.deployments).sort((a, b) => a.createdDate - b.createdDate || a.deploymentId.localeCompare(b.deploymentId)).map(deploymentView), url)); }
    const deploymentMatch = suffix.match(/^\/deployments\/([^/]+)$/); if (deploymentMatch) { const item = this.deployment(api, decodeURIComponent(deploymentMatch[1])); if (req.method === "GET") return json(res, deploymentView(item)); if (req.method === "PATCH") { const input = await readJson(req); if (input.description !== undefined) item.description = input.description || undefined; await this.store.save(); return json(res, deploymentView(item)); } if (req.method === "DELETE") { if (Object.values(api.stages).some(stage => stage.deploymentId === item.deploymentId)) throw new AwsError("ConflictException", "The deployment is referenced by a stage", 409); delete api.deployments[item.deploymentId]; await this.store.save(); res.statusCode = 204; res.end(); return; } }

    if (suffix === "/stages") { if (req.method === "POST") { const input = await readJson(req); const name = String(input.stageName ?? ""); if (!name || name.length > 128 || name !== "$default" && !/^[A-Za-z0-9_-]+$/.test(name)) throw new AwsError("BadRequestException", "Invalid StageName"); const operationToken = getCloudFormationIdempotencyKey(req); const replay = this.replayCreated(api.stages[name], operationToken, "stage"); if (replay) return json(res, stageView(replay), 201); if (api.stages[name]) throw new AwsError("ConflictException", "A stage with this name already exists", 409); if (input.deploymentId) this.deployment(api, String(input.deploymentId)); if (input.autoDeploy && input.deploymentId) throw new AwsError("BadRequestException", "DeploymentId cannot be set while AutoDeploy is enabled"); const now = this.clock.now(); const stage: HttpApiStageState = { stageName: name, description: input.description, deploymentId: input.deploymentId, defaultRouteSettings: this.routeSettings(input.defaultRouteSettings), routeSettings: this.routeSettingsMap(api, input.routeSettings), stageVariables: this.stageVariables(input.stageVariables), accessLogSettings: this.accessLogSettings(input.accessLogSettings), autoDeploy: Boolean(input.autoDeploy), createdDate: now, lastUpdatedDate: now, tags: this.tags(input.tags), apiGatewayManaged: false, cloudFormationOperationToken: operationToken }; api.stages[name] = stage; if (stage.autoDeploy) { const deployment = this.createDeploymentState(api, "Automatic deployment", true); api.deployments[deployment.deploymentId] = deployment; stage.deploymentId = deployment.deploymentId; } await this.store.save(); return json(res, stageView(stage), 201); } if (req.method === "GET") return json(res, this.page("GetStages", api.apiId, Object.values(api.stages).sort((a, b) => a.stageName.localeCompare(b.stageName)).map(stageView), url)); }
    const stageMatch = suffix.match(/^\/stages\/([^/]+)(.*)$/); if (stageMatch) { const stage = this.stage(api, decodeURIComponent(stageMatch[1])); const tail = stageMatch[2]; if (tail === "/accesslogsettings" && req.method === "DELETE") { delete stage.accessLogSettings; stage.lastUpdatedDate = this.clock.now(); await this.store.save(); res.statusCode = 204; res.end(); return; } const routeSettingsMatch = tail.match(/^\/routesettings\/(.+)$/); if (routeSettingsMatch && req.method === "DELETE") { delete stage.routeSettings[decodeURIComponent(routeSettingsMatch[1])]; stage.lastUpdatedDate = this.clock.now(); await this.store.save(); res.statusCode = 204; res.end(); return; } if (!tail) { if (req.method === "GET") return json(res, stageView(stage)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(stage); const nextAutoDeploy = input.autoDeploy === undefined ? stage.autoDeploy : Boolean(input.autoDeploy); if (nextAutoDeploy && input.deploymentId) throw new AwsError("BadRequestException", "DeploymentId cannot be set while AutoDeploy is enabled"); if (input.deploymentId !== undefined) { if (input.deploymentId) this.deployment(api, String(input.deploymentId)); updated.deploymentId = input.deploymentId || undefined; } if (input.description !== undefined) updated.description = input.description || undefined; updated.autoDeploy = nextAutoDeploy; if (input.defaultRouteSettings !== undefined) updated.defaultRouteSettings = this.routeSettings(input.defaultRouteSettings, stage.defaultRouteSettings); if (input.routeSettings !== undefined) updated.routeSettings = this.routeSettingsMap(api, input.routeSettings); if (input.stageVariables !== undefined) updated.stageVariables = this.stageVariables(input.stageVariables, stage.stageVariables); if (input.accessLogSettings !== undefined) updated.accessLogSettings = this.accessLogSettings(input.accessLogSettings, stage.accessLogSettings); updated.lastUpdatedDate = this.clock.now(); if (updated.autoDeploy && !updated.deploymentId) { const deployment = this.createDeploymentState(api, "Automatic deployment", true); api.deployments[deployment.deploymentId] = deployment; updated.deploymentId = deployment.deploymentId; } api.stages[stage.stageName] = updated; await this.store.save(); return json(res, stageView(updated)); } if (req.method === "DELETE") { delete api.stages[stage.stageName]; await this.store.save(); res.statusCode = 204; res.end(); return; } } }

    throw new AwsError("NotFoundException", "Unknown API Gateway v2 WebSocket route", 404);
  }

  private resolveRuntime(pathname: string): ResolvedWebSocketStage {
    const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const apiId = decodeURIComponent(parts.shift() ?? ""); const api = this.api(apiId);
    const stageName = decodeURIComponent(parts.shift() ?? "");
    if (!stageName || parts.length) throw new AwsError("NotFoundException", "Not Found", 404);
    const stage = this.stage(api, stageName);
    if (!stage.deploymentId) throw new AwsError("NotFoundException", "Not Found", 404);
    const deployment = api.deployments[stage.deploymentId]; if (!deployment) throw new AwsError("NotFoundException", "Not Found", 404);
    return { api, stage, snapshot: deployment.snapshot };
  }

  upgradeAuthorizationType(pathname: string): WebSocketRouteState["authorizationType"] {
    return Object.values(this.resolveRuntime(pathname).snapshot.routes).find(route => route.routeKey === "$connect")?.authorizationType ?? "NONE";
  }

  canonicalConnectPath(pathname: string): string {
    const resolved = this.resolveRuntime(pathname); return `/${resolved.api.apiId}/${encodeURIComponent(resolved.stage.stageName)}/$connect`;
  }

  rejectUpgrade(socket: Socket, error: unknown): void {
    const aws = error instanceof AwsError ? error : new AwsError("InternalServerErrorException", error instanceof Error ? error.message : String(error), 500);
    const status = aws.status >= 400 && aws.status <= 599 ? aws.status : 500; const title = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Internal Server Error";
    const body = Buffer.from(JSON.stringify({ message: new Set([401, 403]).has(status) ? title : aws.message }));
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${title}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString("utf8")}`);
  }

  async upgrade(req: IncomingMessage, socket: Socket, head: Buffer, pathname: string, url: URL, customDomain = false): Promise<void> {
    let connection: LiveConnection | undefined;
    this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    try {
      const resolved = this.resolveRuntime(pathname);
      if (resolved.api.disableExecuteApiEndpoint && !customDomain) throw new AwsError("ForbiddenException", "Forbidden", 403);
      this.validateHandshake(req);
      const { headers, multiHeaders } = this.requestHeaders(req); const { query, multiQuery } = this.requestQueries(url); const connectedAt = this.clock.now();
      connection = {
        ...resolved, connectionId: id(12), socket, connectedAt, lastActiveAt: connectedAt, headers, multiHeaders, query, multiQuery,
        sourceIp: req.socket.remoteAddress?.replace(/^::ffff:/, ""), userAgent: headers["user-agent"] ?? "", domainName: headers.host ?? "",
        principal: (req as any).awsPrincipal, identityAuthorization: (req as any).awsIdentityAuthorization,
        buffer: Buffer.alloc(0), fragments: [], fragmentBytes: 0, closing: false, finalized: false, work: Promise.resolve(),
      };
      const connectRoute = Object.values(resolved.snapshot.routes).find(route => route.routeKey === "$connect");
      let authorizer: { allowed: boolean; principalId?: string; context: Record<string, unknown> } = { allowed: true, context: {} };
      if (connectRoute?.authorizationType === "CUSTOM") {
        const configured = connectRoute.authorizerId ? resolved.snapshot.authorizers[connectRoute.authorizerId] : undefined;
        if (!configured) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
        authorizer = await this.runAuthorizer(configured, connection, connectRoute);
        if (!authorizer.allowed) throw new AwsError("ForbiddenException", "Forbidden", 403);
      } else if (connectRoute?.authorizationType === "AWS_IAM" && this.authMode === "enforce" && connection.identityAuthorization?.decision !== "allowed") throw new AwsError("ForbiddenException", "Forbidden", 403);
      if (connectRoute?.target) {
        const result = await this.invokeIntegration(connection, connectRoute, "CONNECT", undefined, authorizer);
        if (result.error) throw result.error;
        if (result.statusCode < 200 || result.statusCode >= 300) throw new AwsError(result.statusCode === 401 ? "UnauthorizedException" : "ForbiddenException", result.statusCode === 401 ? "Unauthorized" : "Forbidden", result.statusCode === 401 ? 401 : 403);
      }
      const key = String(req.headers["sec-websocket-key"]); const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      this.connections.set(connection.connectionId, connection); this.armTimers(connection);
      socket.on("data", chunk => this.receive(connection!, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      socket.on("end", () => this.scheduleFinalize(connection!, 1000, "Client disconnected"));
      socket.on("close", () => this.scheduleFinalize(connection!, 1006, "Connection closed"));
      socket.on("error", () => this.scheduleFinalize(connection!, 1011, "Connection error"));
      await Promise.all([this.publishMetric(connection, "$connect", "ConnectCount", 1), this.writeAccessLog(connection, "$connect", "CONNECT", 200)]);
      if (head.length) this.receive(connection, head);
    } catch (error) { if (connection) { clearTimeout(connection.idleTimer); clearTimeout(connection.lifetimeTimer); } this.rejectUpgrade(socket, error); }
  }

  private validateHandshake(req: IncomingMessage): void {
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase(); const connection = String(req.headers.connection ?? "").toLowerCase().split(",").map(value => value.trim());
    const key = String(req.headers["sec-websocket-key"] ?? ""); let decoded: Buffer; try { decoded = Buffer.from(key, "base64"); } catch { decoded = Buffer.alloc(0); }
    if (req.method !== "GET" || upgrade !== "websocket" || !connection.includes("upgrade") || req.headers["sec-websocket-version"] !== "13" || decoded.length !== 16) throw new AwsError("BadRequestException", "Invalid WebSocket upgrade request", 400);
  }

  private requestHeaders(req: IncomingMessage): { headers: Record<string, string>; multiHeaders: Record<string, string[]> } {
    const headers: Record<string, string> = {}; const multiHeaders: Record<string, string[]> = {};
    for (const [name, raw] of Object.entries(req.headers)) { const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)]; headers[name.toLowerCase()] = values.join(","); multiHeaders[name.toLowerCase()] = values; }
    return { headers, multiHeaders };
  }

  private requestQueries(url: URL): { query: Record<string, string>; multiQuery: Record<string, string[]> } {
    const names = [...new Set(url.searchParams.keys())]; return { query: Object.fromEntries(names.map(name => [name, url.searchParams.getAll(name).join(",")])), multiQuery: Object.fromEntries(names.map(name => [name, url.searchParams.getAll(name)])) };
  }

  private methodArn(connection: LiveConnection, routeKey: string): string {
    return `arn:aws:execute-api:${this.region}:${this.store.accountId}:${connection.api.apiId}/${connection.stage.stageName}/${routeKey}`;
  }

  private lambdaArn(uri: string | undefined): string {
    const arn = uri?.match(/functions\/(arn:[^/]+)\/invocations/)?.[1] ?? (uri?.startsWith("arn:") ? uri : undefined);
    if (!arn) throw new AwsError("InternalServerErrorException", "Invalid Lambda integration URI", 500); return arn;
  }

  private identityValue(source: string, connection: LiveConnection): string {
    const header = source.match(/^route\.request\.header\.([A-Za-z0-9._-]+)$/i)?.[1]; if (header) return connection.headers[header.toLowerCase()] ?? "";
    const query = source.match(/^route\.request\.querystring\.([A-Za-z0-9._-]+)$/i)?.[1]; if (query) return connection.query[query] ?? "";
    return "";
  }

  private requestContext(connection: LiveConnection, routeKey: string, eventType: "CONNECT" | "MESSAGE" | "DISCONNECT", authorizer?: { principalId?: string; context: Record<string, unknown> }): any {
    const now = this.clock.now(); return present({
      routeKey, eventType, extendedRequestId: id(16), requestTime: new Date(now).toUTCString(), messageDirection: "IN",
      stage: connection.stage.stageName, connectedAt: connection.connectedAt, requestTimeEpoch: now, requestId: id(24),
      domainName: connection.domainName, connectionId: connection.connectionId, apiId: connection.api.apiId, messageId: eventType === "MESSAGE" ? id(16) : undefined,
      identity: { sourceIp: connection.sourceIp ?? "", userAgent: connection.userAgent },
      authorizer: authorizer?.principalId || Object.keys(authorizer?.context ?? {}).length ? { principalId: authorizer?.principalId, ...authorizer?.context } : undefined,
    });
  }

  private async runAuthorizer(authorizer: WebSocketAuthorizerState, connection: LiveConnection, route: WebSocketRouteState): Promise<{ allowed: boolean; principalId?: string; context: Record<string, unknown> }> {
    this.assertGatewayRole(authorizer.authorizerCredentialsArn, "authorizer", true);
    const identities = authorizer.identitySource.map(source => this.identityValue(source, connection)); if (identities.some(value => !value)) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const cacheKey = `${connection.api.apiId}\0${authorizer.authorizerId}\0${connection.stage.stageName}\0${identities.join("\0")}`; const cached = this.authorizerCache.get(cacheKey); if (cached && cached.expiresAt > this.clock.now()) return cached.value;
    const methodArn = this.methodArn(connection, route.routeKey); const event = {
      type: "REQUEST", methodArn, headers: connection.headers, multiValueHeaders: connection.multiHeaders,
      queryStringParameters: connection.query, multiValueQueryStringParameters: connection.multiQuery,
      stageVariables: connection.stage.stageVariables, requestContext: this.requestContext(connection, route.routeKey, "CONNECT"),
    };
    const functionArn = this.lambdaArn(authorizer.authorizerUri);
    if (authorizer.authorizerCredentialsArn && evaluateRoleAuthorization(this.store.ensureAccount().iam, authorizer.authorizerCredentialsArn, "lambda:InvokeFunction", functionArn).decision !== "allowed") throw new AwsError("InternalServerErrorException", "The authorizer role cannot invoke the Lambda function", 500);
    let invocation: InvokeResult;
    try { invocation = await this.lambda.invoke(functionArn, Buffer.from(JSON.stringify(event)), id(24), { principal: "apigateway.amazonaws.com", sourceArn: `arn:aws:execute-api:${this.region}:${this.store.accountId}:${connection.api.apiId}/authorizers/${authorizer.authorizerId}`, sourceAccount: this.store.accountId, enforceResourcePolicy: !authorizer.authorizerCredentialsArn, lineage: connection.principal?.lambdaLineage }); }
    catch (error) { if (error instanceof AwsError && error.code === "AccessDeniedException") throw new AwsError("InternalServerErrorException", "API Gateway is not authorized to invoke the authorizer", 500); throw error; }
    if (invocation.functionError) throw new AwsError("InternalServerErrorException", "Authorizer execution failed", 500);
    let output: any; try { output = JSON.parse(invocation.payload.toString("utf8")); } catch { throw new AwsError("InternalServerErrorException", "Invalid authorizer response", 500); }
    if (!output?.principalId || !output.policyDocument?.Statement) throw new AwsError("InternalServerErrorException", "Authorizer response requires principalId and policyDocument", 500);
    const result = { allowed: evaluateIdentityPolicy(output.policyDocument, "execute-api:Invoke", methodArn).decision === "allowed", principalId: String(output.principalId), context: output.context && typeof output.context === "object" ? output.context : {} };
    if (authorizer.authorizerResultTtlInSeconds > 0) this.authorizerCache.set(cacheKey, { expiresAt: this.clock.now() + authorizer.authorizerResultTtlInSeconds * 1000, value: result }); return result;
  }

  private lambdaEvent(connection: LiveConnection, route: WebSocketRouteState, eventType: "CONNECT" | "MESSAGE" | "DISCONNECT", body?: Buffer, authorizer?: { principalId?: string; context: Record<string, unknown> }, disconnect?: { statusCode: number; reason: string }): any {
    const base: any = { requestContext: this.requestContext(connection, route.routeKey, eventType, authorizer), isBase64Encoded: false };
    if (eventType === "CONNECT") Object.assign(base, { headers: connection.headers, multiValueHeaders: connection.multiHeaders, queryStringParameters: connection.query, multiValueQueryStringParameters: connection.multiQuery });
    if (eventType === "MESSAGE") base.body = body?.toString("utf8") ?? "";
    if (eventType === "DISCONNECT") Object.assign(base.requestContext, { disconnectStatusCode: disconnect?.statusCode, disconnectReason: disconnect?.reason });
    return base;
  }

  private async invokeIntegration(connection: LiveConnection, route: WebSocketRouteState, eventType: "CONNECT" | "MESSAGE" | "DISCONNECT", body?: Buffer, authorizer?: { principalId?: string; context: Record<string, unknown> }): Promise<WebSocketIntegrationResult> {
    const started = performance.now(); const integrationId = route.target?.match(/^integrations\/(.+)$/)?.[1]; const integration = integrationId ? connection.snapshot.integrations[integrationId] : undefined;
    if (!integration) return { statusCode: 200, body: Buffer.alloc(0), integrationLatency: 0 };
    try {
      if (integration.integrationType === "MOCK") {
        const response = Object.values(integration.integrationResponses).find(item => item.integrationResponseKey === "$default") ?? Object.values(integration.integrationResponses)[0]; const template = response?.responseTemplates.$default ?? "";
        return { statusCode: 200, body: Buffer.from(template), integrationLatency: performance.now() - started };
      }
      if (integration.integrationType === "AWS_PROXY" || integration.integrationType === "AWS") {
        const functionArn = this.lambdaArn(integration.integrationUri);
        this.assertGatewayRole(integration.credentialsArn, "integration", true);
        if (integration.credentialsArn && evaluateRoleAuthorization(this.store.ensureAccount().iam, integration.credentialsArn, "lambda:InvokeFunction", functionArn).decision !== "allowed") throw new AwsError("InternalServerErrorException", "The integration role cannot invoke the Lambda function", 500);
        const event = this.lambdaEvent(connection, route, eventType, body, authorizer); let invocation: InvokeResult;
        try { invocation = await this.lambda.invoke(functionArn, Buffer.from(JSON.stringify(event)), id(24), { principal: "apigateway.amazonaws.com", sourceArn: this.methodArn(connection, route.routeKey), sourceAccount: this.store.accountId, enforceResourcePolicy: !integration.credentialsArn, lineage: connection.principal?.lambdaLineage }); }
        catch (error) { if (error instanceof AwsError && error.code === "AccessDeniedException") throw new AwsError("InternalServerErrorException", "Internal Server Error", 500); throw error; }
        if (invocation.functionError) throw new AwsError("InternalServerErrorException", `Lambda invocation failed: ${invocation.payload.toString("utf8")}`, 500);
        let output: any; try { output = invocation.payload.length ? JSON.parse(invocation.payload.toString("utf8")) : {}; } catch { output = { body: invocation.payload.toString("utf8") }; }
        const statusCode = Number(output?.statusCode ?? 200); const responseBody = output?.body === undefined ? Buffer.alloc(0) : Buffer.from(typeof output.body === "string" ? output.body : JSON.stringify(output.body));
        return { statusCode: Number.isInteger(statusCode) ? statusCode : 500, body: output?.isBase64Encoded ? Buffer.from(String(output.body ?? ""), "base64") : responseBody, integrationLatency: performance.now() - started };
      }
      if (integration.integrationType === "HTTP" || integration.integrationType === "HTTP_PROXY") {
        if (process.env.STACKSIM_ALLOW_OUTBOUND_HTTP !== "true") throw new AwsError("InternalServerErrorException", "Outbound HTTP integrations require STACKSIM_ALLOW_OUTBOUND_HTTP=true", 502);
        const target = new URL(integration.integrationUri!); if ((target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "::1") && process.env.STACKSIM_ALLOW_PRIVATE_HTTP !== "true") throw new AwsError("InternalServerErrorException", "Private HTTP integration endpoints are disabled", 502);
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), integration.timeoutInMillis);
        try { const response = await fetch(target, { method: integration.integrationMethod ?? "POST", body: body ? Uint8Array.from(body) : undefined, signal: controller.signal }); return { statusCode: response.status, body: Buffer.from(await response.arrayBuffer()), integrationLatency: performance.now() - started }; } finally { clearTimeout(timer); }
      }
      throw new AwsError("InternalServerErrorException", "Unsupported integration", 500);
    } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalServerErrorException", error instanceof Error ? error.message : String(error), 500); return { statusCode: aws.status >= 400 ? aws.status : 500, body: Buffer.alloc(0), integrationLatency: performance.now() - started, error: aws }; }
  }

  private selectRoute(connection: LiveConnection, body: Buffer): WebSocketRouteState | undefined {
    let selected = ""; try { let value: any = JSON.parse(body.toString("utf8")); const expression = connection.api.routeSelectionExpression; if (expression === "$request.body") selected = typeof value === "string" ? value : JSON.stringify(value); else { const path = expression.match(/^\$request\.body\.([A-Za-z0-9_.-]+)$/)?.[1]; if (path) { for (const part of path.split(".")) value = value?.[part]; if (value !== undefined && value !== null) selected = typeof value === "string" ? value : JSON.stringify(value); } } } catch {}
    return Object.values(connection.snapshot.routes).find(route => route.routeKey === selected) ?? Object.values(connection.snapshot.routes).find(route => route.routeKey === "$default");
  }

  private receive(connection: LiveConnection, chunk: Buffer): void {
    if (connection.finalized || connection.closing) return; connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (connection.buffer.length >= 2 && !connection.closing) {
      const first = connection.buffer[0]; const second = connection.buffer[1]; const fin = Boolean(first & 0x80); const opcode = first & 0x0f; const masked = Boolean(second & 0x80); let length = second & 0x7f; let offset = 2;
      if (first & 0x70 || !masked) { this.closeConnection(connection, 1002, "Protocol error"); return; }
      if (length === 126) { if (connection.buffer.length < 4) return; length = connection.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (connection.buffer.length < 10) return; const large = connection.buffer.readBigUInt64BE(2); if (large > BigInt(Number.MAX_SAFE_INTEGER)) { this.closeConnection(connection, 1009, "Message too big"); return; } length = Number(large); offset = 10; }
      if (length > 32 * 1024) { this.closeConnection(connection, 1009, "Frame too big"); return; }
      if (opcode >= 8 && (!fin || length > 125)) { this.closeConnection(connection, 1002, "Protocol error"); return; }
      if (connection.buffer.length < offset + 4 + length) return; const mask = connection.buffer.subarray(offset, offset + 4); offset += 4; const payload = Buffer.from(connection.buffer.subarray(offset, offset + length)); connection.buffer = connection.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]; connection.lastActiveAt = this.clock.now(); this.armIdle(connection);
      if (opcode === 0x8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000; const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "Client disconnected"; if (!connection.closing) { this.sendFrame(connection.socket, 0x8, payload); connection.closing = true; connection.socket.end(); } this.scheduleFinalize(connection, code, reason); return; }
      if (opcode === 0x9) { this.sendFrame(connection.socket, 0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x2) { this.closeConnection(connection, 1003, "Binary messages are not supported"); return; }
      if (opcode !== 0 && opcode !== 1 || opcode === 0 && connection.fragmentedOpcode === undefined || opcode === 1 && connection.fragmentedOpcode !== undefined) { this.closeConnection(connection, 1002, "Protocol error"); return; }
      if (opcode === 1 && !fin) { connection.fragmentedOpcode = opcode; connection.fragments = [payload]; connection.fragmentBytes = payload.length; continue; }
      if (opcode === 0) { connection.fragments.push(payload); connection.fragmentBytes += payload.length; if (connection.fragmentBytes > 128 * 1024) { this.closeConnection(connection, 1009, "Message too big"); return; } if (!fin) continue; const message = Buffer.concat(connection.fragments); connection.fragmentedOpcode = undefined; connection.fragments = []; connection.fragmentBytes = 0; this.queueMessage(connection, message); continue; }
      this.queueMessage(connection, payload);
    }
  }

  private queueMessage(connection: LiveConnection, body: Buffer): void {
    if (body.length > 128 * 1024) { this.closeConnection(connection, 1009, "Message too big"); return; }
    try { new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { this.closeConnection(connection, 1007, "Invalid UTF-8"); return; }
    connection.work = connection.work.then(() => this.handleMessage(connection, body)).catch(() => undefined);
  }

  private async handleMessage(connection: LiveConnection, body: Buffer): Promise<void> {
    if (connection.finalized) return; const route = this.selectRoute(connection, body);
    if (!route) { const requestId = id(24); this.sendText(connection, JSON.stringify({ message: "Forbidden", connectionId: connection.connectionId, requestId })); await Promise.all([this.publishMetric(connection, "$default", "ClientError", 1), this.writeAccessLog(connection, "$default", "MESSAGE", 403)]); return; }
    await this.publishMetric(connection, route.routeKey, "MessageCount", 1); const result = await this.invokeIntegration(connection, route, "MESSAGE", body);
    await this.publishMetric(connection, route.routeKey, "IntegrationLatency", result.integrationLatency);
    if (result.error || result.statusCode >= 500) { this.sendText(connection, JSON.stringify({ message: "Internal server error", connectionId: connection.connectionId, requestId: id(24) })); await Promise.all([this.publishMetric(connection, route.routeKey, "IntegrationError", 1), this.writeAccessLog(connection, route.routeKey, "MESSAGE", result.statusCode, result.error)]); return; }
    if (result.statusCode >= 400) await this.publishMetric(connection, route.routeKey, "ClientError", 1);
    if (Object.values(route.routeResponses).some(response => response.routeResponseKey === "$default") && result.body.length) this.sendFrame(connection.socket, 0x1, result.body);
    await this.writeAccessLog(connection, route.routeKey, "MESSAGE", result.statusCode);
  }

  private sendText(connection: LiveConnection, text: string): void { this.sendFrame(connection.socket, 0x1, Buffer.from(text)); }

  private sendFrame(socket: Socket, opcode: number, payload: Buffer): void {
    if (socket.destroyed || !socket.writable) return; let header: Buffer;
    if (payload.length < 126) { header = Buffer.alloc(2); header[1] = payload.length; }
    else if (payload.length <= 0xffff) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    header[0] = 0x80 | opcode; socket.write(Buffer.concat([header, payload]));
  }

  private closeConnection(connection: LiveConnection, code: number, reason: string): void {
    if (connection.closing || connection.finalized) return; connection.closing = true; const text = Buffer.from(reason); const payload = Buffer.alloc(2 + Math.min(123, text.length)); payload.writeUInt16BE(code, 0); text.copy(payload, 2, 0, 123); this.sendFrame(connection.socket, 0x8, payload); connection.socket.end(); setTimeout(() => { if (!connection.socket.destroyed) connection.socket.destroy(); }, 25).unref(); this.scheduleFinalize(connection, code, reason);
  }

  private armTimers(connection: LiveConnection): void {
    this.armIdle(connection); connection.lifetimeTimer = setTimeout(() => this.closeConnection(connection, 1001, "Connection lifetime exceeded"), this.schedule.lifetimeMs); connection.lifetimeTimer.unref();
  }

  private armIdle(connection: LiveConnection): void {
    clearTimeout(connection.idleTimer); connection.idleTimer = setTimeout(() => this.closeConnection(connection, 1001, "Idle timeout"), this.schedule.idleTimeoutMs); connection.idleTimer.unref();
  }

  private async finalize(connection: LiveConnection, statusCode: number, reason: string): Promise<void> {
    if (connection.finalized) return; connection.finalized = true; clearTimeout(connection.idleTimer); clearTimeout(connection.lifetimeTimer); this.connections.delete(connection.connectionId);
    const route = Object.values(connection.snapshot.routes).find(value => value.routeKey === "$disconnect");
    if (route?.target) await this.invokeDisconnect(connection, route, statusCode, reason).catch(() => undefined);
    await this.writeAccessLog(connection, "$disconnect", "DISCONNECT", statusCode).catch(() => undefined);
  }

  private scheduleFinalize(connection: LiveConnection, statusCode: number, reason: string): void {
    const work = this.finalize(connection, statusCode, reason); this.finalizations.add(work); void work.finally(() => this.finalizations.delete(work));
  }

  private async invokeDisconnect(connection: LiveConnection, route: WebSocketRouteState, statusCode: number, reason: string): Promise<void> {
    const integrationId = route.target?.match(/^integrations\/(.+)$/)?.[1]; const integration = integrationId ? connection.snapshot.integrations[integrationId] : undefined; if (!integration || !new Set(["AWS", "AWS_PROXY"]).has(integration.integrationType)) return;
    this.assertGatewayRole(integration.credentialsArn, "integration", true);
    const functionArn = this.lambdaArn(integration.integrationUri);
    if (integration.credentialsArn && evaluateRoleAuthorization(this.store.ensureAccount().iam, integration.credentialsArn, "lambda:InvokeFunction", functionArn).decision !== "allowed") throw new AwsError("InternalServerErrorException", "The integration role cannot invoke the Lambda function", 500);
    const event = this.lambdaEvent(connection, route, "DISCONNECT", undefined, undefined, { statusCode, reason });
    await this.lambda.invoke(functionArn, Buffer.from(JSON.stringify(event)), id(24), { principal: "apigateway.amazonaws.com", sourceArn: this.methodArn(connection, route.routeKey), sourceAccount: this.store.accountId, enforceResourcePolicy: !integration.credentialsArn, lineage: connection.principal?.lambdaLineage });
  }

  async shutdown(): Promise<void> {
    const active = [...this.connections.values()]; const sockets = [...this.sockets]; for (const connection of active) this.closeConnection(connection, 1012, "Service restart");
    await new Promise(resolve => setTimeout(resolve, 30)); for (const socket of sockets) if (!socket.destroyed) socket.destroy();
    await Promise.all(active.map(connection => connection.work.catch(() => undefined))); await Promise.all([...this.finalizations].map(work => work.catch(() => undefined)));
  }

  isManagementPath(pathname: string): boolean { return /^\/[^/]+\/[^/]+\/@connections\/[^/]+\/?$/.test(pathname); }

  managementApiId(pathname: string): string | undefined { try { return decodeURIComponent(pathname.split("/")[1] ?? "") || undefined; } catch { return undefined; } }

  managementAuthorizationResource(pathname: string, method: string): string {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/@connections\/([^/]+)\/?$/); if (!match) throw new AwsError("NotFoundException", "Not Found", 404);
    return `arn:aws:execute-api:${this.region}:${this.store.accountId}:${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}/${method}/@connections/${decodeURIComponent(match[3])}`;
  }

  async handleManagement(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    try {
      const match = pathname.match(/^\/([^/]+)\/([^/]+)\/@connections\/([^/]+)\/?$/); if (!match) throw new AwsError("NotFoundException", "Not Found", 404);
      const apiId = decodeURIComponent(match[1]); const stageName = decodeURIComponent(match[2]); const connectionId = decodeURIComponent(match[3]); this.api(apiId); this.stage(this.api(apiId), stageName);
      const connection = this.connections.get(connectionId); if (!connection || connection.finalized || connection.api.apiId !== apiId || connection.stage.stageName !== stageName) throw new AwsError("GoneException", "The connection with id was not found.", 410);
      if (req.method === "GET") return json(res, { connectedAt: new Date(connection.connectedAt).toISOString(), identity: { sourceIp: connection.sourceIp ?? "", userAgent: connection.userAgent }, lastActiveAt: new Date(connection.lastActiveAt).toISOString() });
      if (req.method === "POST") { const body = await readBody(req); if (body.length > 128 * 1024) throw new AwsError("PayloadTooLargeException", "Payload exceeds the maximum allowed size", 413); this.sendFrame(connection.socket, 0x1, body); res.statusCode = 200; res.end(); return; }
      if (req.method === "DELETE") { this.closeConnection(connection, 1000, "Connection deleted"); res.statusCode = 204; res.end(); return; }
      throw new AwsError("NotFoundException", "Not Found", 404);
    } catch (error) { sendAwsError(res, error, "rest"); }
  }

  private async publishMetric(connection: LiveConnection, routeKey: string, metricName: string, value: number): Promise<void> {
    if (!this.telemetry) return; const dimensions: Array<Record<string, string>> = [{ ApiId: connection.api.apiId }, { ApiId: connection.api.apiId, Stage: connection.stage.stageName }]; const setting = connection.stage.routeSettings[routeKey] ?? connection.stage.defaultRouteSettings; if (setting.detailedMetricsEnabled) dimensions.push({ ApiId: connection.api.apiId, Method: routeKey, Resource: routeKey, Stage: connection.stage.stageName });
    await Promise.all(dimensions.map(items => this.telemetry!.publish({ namespace: "AWS/ApiGateway", metricName, dimensions: items, value, unit: metricName.endsWith("Latency") ? "Milliseconds" : "Count", timestamp: this.clock.now() })));
  }

  private async writeAccessLog(connection: LiveConnection, routeKey: string, eventType: "CONNECT" | "MESSAGE" | "DISCONNECT", status: number, error?: AwsError): Promise<void> {
    if (!this.logs || !connection.stage.accessLogSettings) return; const group = connection.stage.accessLogSettings.destinationArn.match(/:log-group:([^:*]+)(?::\*)?$/)?.[1]; if (!group) return;
    const now = this.clock.now(); const values: Record<string, unknown> = { accountId: this.store.accountId, apiId: connection.api.apiId, connectionId: connection.connectionId, connectedAt: connection.connectedAt, domainName: connection.domainName, eventType, integrationErrorMessage: error?.message, messageDirection: "IN", requestId: id(24), requestTime: new Date(now).toUTCString(), requestTimeEpoch: now, routeKey, stage: connection.stage.stageName, status, "identity.sourceIp": connection.sourceIp, "identity.userAgent": connection.userAgent };
    const message = connection.stage.accessLogSettings.format.replace(/\$context\.([A-Za-z0-9_.]+)/g, (_match, key) => values[key] === undefined ? "-" : String(values[key])); const stream = connection.connectionId;
    try { await this.logs.CreateLogStream({ logGroupName: group, logStreamName: stream }); } catch (caught) { if (!(caught instanceof AwsError) || caught.code !== "ResourceAlreadyExistsException") return; }
    await this.logs.PutLogEvents({ logGroupName: group, logStreamName: stream, logEvents: [{ timestamp: now, message }] }).catch(() => undefined);
  }
}
