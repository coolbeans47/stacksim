import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { deflateSync, gzipSync } from "node:zlib";
import { AwsError, sendAwsError } from "./errors.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { InvokeResult, LambdaService } from "./lambda.js";
import type { DynamoDbService } from "./dynamodb.js";
import type { SqsService } from "./sqs.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import { ServiceRegistry } from "./core/service-registry.js";
import { combineIdentityAndResourceAuthorization, evaluateAuthorization, evaluateIdentityPolicy, evaluateResourcePolicy, evaluateRoleAuthorization, evaluateTrust, roleSessionAuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import type { StateStore } from "./state.js";
import type { ApiAuthorizerState, ApiDeploymentSnapshot, ApiDocumentationPartLocationState, ApiDocumentationPartState, ApiDocumentationVersionState, ApiGatewayApiKeyState, ApiGatewayBasePathMappingState, ApiGatewayCachedResponseState, ApiGatewayClientCertificateState, ApiGatewayDomainNameAccessAssociationState, ApiGatewayDomainNameState, ApiGatewayResponseCacheEntryState, ApiGatewayResponseState, ApiGatewayStageCacheState, ApiGatewayThrottleSettingsState, ApiGatewayUsagePlanStageState, ApiGatewayUsagePlanState, ApiGatewayVpcLinkState, ApiIntegrationResponseState, ApiIntegrationState, ApiMethodResponseState, ApiMethodSettingState, ApiMethodState, ApiModelState, ApiRequestValidatorState, ApiResource, ApiStageState, PolicyDocument, RestApiState } from "./types.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import { id, json, readBody, readJson } from "./util.js";
import { renderVtl, validateVtl, type VtlContext } from "./apigateway-vtl.js";
import { DRAFT4_PROFILE_VERSION, defaultApiModels, modelTemplate, validateJsonModel, validateModelCatalog } from "./apigateway-schema.js";
import { applyOpenApiDocument, exportOpenApi, parseOpenApiDocument, stringifyOpenApiYaml } from "./apigateway-openapi.js";
import { createSelfSignedClientCertificate } from "./core/x509.js";
import { createZip } from "./core/zip-create.js";
import { parseAwsQuery } from "./protocols/query-xml.js";
import { getCloudFormationIdempotencyKey, getCloudFormationOwner } from "./core/internal-request.js";
import {
  CognitoRestConfigurationError,
  CognitoRestTokenError,
  parseCognitoUserPoolArn,
  restClaimsAsStrings,
  type CognitoRestAuthorizerVerifier,
} from "./cognito/gateway.js";
import { ApiGatewayCacheCrypto, ApiGatewayCacheSecurityError, type ApiGatewayCacheBinding } from "./apigateway-cache-crypto.js";

function parsePolicy(value: unknown): PolicyDocument | undefined { if (value === undefined || value === null || value === "") return undefined; let document: any = value; if (typeof value === "string") try { document = JSON.parse(value); } catch { throw new AwsError("BadRequestException", "Invalid resource policy JSON"); } if (!document || !document.Statement) throw new AwsError("BadRequestException", "Resource policy requires Statement"); return document; }
const GATEWAY_RESPONSE_STATUS: Record<string, number | undefined> = {
  ACCESS_DENIED: 403, API_CONFIGURATION_ERROR: 500, AUTHORIZER_CONFIGURATION_ERROR: 500, AUTHORIZER_FAILURE: 500,
  BAD_REQUEST_PARAMETERS: 400, BAD_REQUEST_BODY: 400, DEFAULT_4XX: undefined, DEFAULT_5XX: undefined, EXPIRED_TOKEN: 403,
  INTEGRATION_FAILURE: 504, INTEGRATION_TIMEOUT: 504, INVALID_API_KEY: 403, INVALID_SIGNATURE: 403,
  MISSING_AUTHENTICATION_TOKEN: 403, QUOTA_EXCEEDED: 429, REQUEST_TOO_LARGE: 413, RESOURCE_NOT_FOUND: 404,
  THROTTLED: 429, UNAUTHORIZED: 401, UNSUPPORTED_MEDIA_TYPE: 415, WAF_FILTERED: 403,
};
const GATEWAY_RESPONSE_TYPES = new Set(Object.keys(GATEWAY_RESPONSE_STATUS));
const DEFAULT_GATEWAY_TEMPLATE = "{\"message\":$context.error.messageString}";
const DOMAIN_SECURITY_POLICIES = new Set(["TLS_1_0", "TLS_1_2", "SecurityPolicy_TLS12_2018_EDGE", "SecurityPolicy_TLS12_PFS_2025_EDGE", "SecurityPolicy_TLS13_1_2_2021_06", "SecurityPolicy_TLS13_1_2_FIPS_PFS_PQ_2025_09", "SecurityPolicy_TLS13_1_2_FIPS_PQ_2025_09", "SecurityPolicy_TLS13_1_2_PFS_PQ_2025_09", "SecurityPolicy_TLS13_1_2_PQ_2025_09", "SecurityPolicy_TLS13_1_3_2025_09", "SecurityPolicy_TLS13_1_3_FIPS_2025_09", "SecurityPolicy_TLS13_2025_EDGE"]);
const DOMAIN_ROUTING_MODES = new Set(["BASE_PATH_MAPPING_ONLY", "ROUTING_RULE_ONLY", "ROUTING_RULE_THEN_BASE_PATH_MAPPING"]);
const DOCUMENTATION_PART_TYPES = new Set(["API", "AUTHORIZER", "MODEL", "RESOURCE", "METHOD", "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE", "RESPONSE_HEADER", "RESPONSE_BODY"]);
const SDK_TYPES = [
  { id: "javascript", friendlyName: "JavaScript", description: "Minimal dependency-free stacksim JavaScript client", configurationProperties: [] },
  { id: "java", friendlyName: "Java", description: "AWS Java SDK generator dependency is not installed", configurationProperties: [{ name: "serviceName", friendlyName: "Service name", description: "Generated service name", required: true }, { name: "javaPackageName", friendlyName: "Java package", description: "Generated package name", required: true }] },
  { id: "android", friendlyName: "Android", description: "AWS Android SDK generator dependency is not installed", configurationProperties: [] },
  { id: "objectivec", friendlyName: "Objective-C", description: "AWS Objective-C SDK generator dependency is not installed", configurationProperties: [] },
  { id: "swift", friendlyName: "Swift", description: "AWS Swift SDK generator dependency is not installed", configurationProperties: [] },
  { id: "ruby", friendlyName: "Ruby", description: "AWS Ruby SDK generator dependency is not installed", configurationProperties: [] },
];

class GatewayFailure extends AwsError {
  constructor(readonly responseType: string, code: string, message: string, status: number) { super(code, message, status); }
}

function apiView(api: RestApiState, warnings: string[] = []): any { return { id: api.id, name: api.name, description: api.description, version: api.version, ...(warnings.length ? { warnings } : {}), createdDate: api.createdDate / 1000, endpointConfiguration: { types: ["REGIONAL"] }, apiKeySource: api.apiKeySource ?? "HEADER", policy: api.policy ? JSON.stringify(api.policy) : undefined, binaryMediaTypes: api.binaryMediaTypes ?? [], minimumCompressionSize: api.minimumCompressionSize, rootResourceId: api.rootResourceId, tags: api.tags ?? {} }; }
function methodView(method: string, value: ApiMethodState, integration?: ApiIntegrationState): any { return { httpMethod: method, authorizationType: value.authorizationType, authorizerId: value.authorizerId, authorizationScopes: value.authorizationScopes, apiKeyRequired: value.apiKeyRequired, requestParameters: value.requestParameters ?? {}, requestModels: value.requestModels ?? {}, requestValidatorId: value.requestValidatorId, operationName: value.operationName, methodResponses: Object.fromEntries(Object.entries(value.responses ?? {}).map(([key, response]) => [key, methodResponseView(response)])), ...(integration ? { methodIntegration: integrationView(integration) } : {}) }; }
function resourceView(resource: ApiResource, embed?: string[]): any { const methods = Object.fromEntries(Object.entries(resource.methods).map(([method, value]) => [method, methodView(method, value, embed?.some(v => v.toLowerCase().includes("integration")) ? resource.integrations[method] : undefined)])); return { id: resource.id, parentId: resource.parentId, pathPart: resource.pathPart, path: resource.path, ...(Object.keys(methods).length ? { resourceMethods: methods } : {}) }; }
function integrationResponseView(response: ApiIntegrationResponseState): any { return { statusCode: response.statusCode, selectionPattern: response.selectionPattern, responseParameters: response.responseParameters ?? {}, responseTemplates: response.responseTemplates ?? {}, contentHandling: response.contentHandling }; }
function integrationView(integration: ApiIntegrationState): any { return { type: integration.type, httpMethod: integration.integrationHttpMethod, uri: integration.uri, connectionType: integration.connectionType ?? "INTERNET", connectionId: integration.connectionId, credentials: integration.credentials, requestParameters: integration.requestParameters ?? {}, requestTemplates: integration.requestTemplates ?? {}, passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH", contentHandling: integration.contentHandling, timeoutInMillis: integration.timeoutInMillis ?? 29_000, cacheNamespace: integration.cacheNamespace, cacheKeyParameters: integration.cacheKeyParameters ?? [], tlsConfig: structuredClone(integration.tlsConfig), integrationResponses: Object.fromEntries(Object.entries(integration.responses ?? {}).map(([key, response]) => [key, integrationResponseView(response)])) }; }
function methodResponseView(response: ApiMethodResponseState): any { return { statusCode: response.statusCode, responseParameters: response.responseParameters ?? {}, responseModels: response.responseModels ?? {} }; }
function deploymentView(deployment: RestApiState["deployments"][string]): any { return { id: deployment.id, createdDate: deployment.createdDate / 1000, description: deployment.description }; }
function stageView(api: RestApiState, stage: RestApiState["stages"][string], invokePort: number, invokeProtocol: "http" | "https"): any { return { ...stage, createdDate: (stage.createdDate ?? api.deployments[stage.deploymentId]?.createdDate ?? Date.now()) / 1000, lastUpdatedDate: (stage.lastUpdatedDate ?? stage.createdDate ?? Date.now()) / 1000, variables: stage.variables ?? {}, methodSettings: stage.methodSettings ?? {}, tracingEnabled: stage.tracingEnabled ?? false, cacheClusterEnabled: stage.cacheClusterEnabled ?? false, cacheClusterStatus: stage.cacheClusterEnabled ? "AVAILABLE" : "NOT_AVAILABLE", tags: stage.tags ?? {}, invokeUrl: `${invokeProtocol}://localhost:${invokePort}/${api.id}/${stage.stageName}` }; }
function authorizerView(authorizer: ApiAuthorizerState): any { return { id: authorizer.id, name: authorizer.name, type: authorizer.type, authorizerUri: authorizer.authorizerUri, authorizerCredentials: authorizer.authorizerCredentials, identitySource: authorizer.identitySource, identityValidationExpression: authorizer.identityValidationExpression, authorizerResultTtlInSeconds: authorizer.authorizerResultTtlInSeconds, providerARNs: authorizer.providerARNs ? [...authorizer.providerARNs] : undefined }; }
function modelView(model: ApiModelState): any { return { id: model.id, name: model.name, description: model.description, schema: model.schema, contentType: model.contentType }; }
function requestValidatorView(validator: ApiRequestValidatorState): any { return { id: validator.id, name: validator.name, validateRequestBody: validator.validateRequestBody, validateRequestParameters: validator.validateRequestParameters }; }
function gatewayResponseView(responseType: string, response?: ApiGatewayResponseState): any { return { responseType, statusCode: response?.statusCode ?? (GATEWAY_RESPONSE_STATUS[responseType] === undefined ? undefined : String(GATEWAY_RESPONSE_STATUS[responseType])), defaultResponse: !response, responseParameters: response?.responseParameters ?? {}, responseTemplates: response?.responseTemplates ?? { "application/json": DEFAULT_GATEWAY_TEMPLATE } }; }
function apiKeyView(key: ApiGatewayApiKeyState, includeValue = false): any { return { id: key.id, ...(includeValue ? { value: key.value } : {}), name: key.name, customerId: key.customerId, description: key.description, enabled: key.enabled, createdDate: key.createdDate / 1000, lastUpdatedDate: key.lastUpdatedDate / 1000, stageKeys: key.stageKeys, tags: key.tags }; }
function usagePlanView(plan: ApiGatewayUsagePlanState): any { return { id: plan.id, name: plan.name, description: plan.description, apiStages: structuredClone(plan.apiStages), throttle: structuredClone(plan.throttle), quota: structuredClone(plan.quota), productCode: plan.productCode, tags: structuredClone(plan.tags) }; }
function usagePlanKeyView(key: ApiGatewayApiKeyState): any { return { id: key.id, type: "API_KEY", value: key.value, name: key.name }; }
function domainNameView(domain: ApiGatewayDomainNameState): any { return { domainName: domain.domainName, domainNameId: domain.domainNameId, domainNameArn: domain.domainNameArn, certificateName: domain.certificateName, certificateArn: domain.certificateArn, certificateUploadDate: domain.certificateUploadDate === undefined ? undefined : domain.certificateUploadDate / 1000, regionalDomainName: domain.regionalDomainName, regionalHostedZoneId: domain.regionalHostedZoneId, regionalCertificateName: domain.regionalCertificateName, regionalCertificateArn: domain.regionalCertificateArn, distributionDomainName: domain.distributionDomainName, distributionHostedZoneId: domain.distributionHostedZoneId, endpointConfiguration: structuredClone(domain.endpointConfiguration), domainNameStatus: domain.domainNameStatus, securityPolicy: domain.securityPolicy, endpointAccessMode: domain.endpointAccessMode, tags: structuredClone(domain.tags), mutualTlsAuthentication: structuredClone(domain.mutualTlsAuthentication), ownershipVerificationCertificateArn: domain.ownershipVerificationCertificateArn, managementPolicy: domain.managementPolicy, policy: domain.policy, routingMode: domain.routingMode }; }
function basePathMappingView(mapping: ApiGatewayBasePathMappingState): any { return { basePath: mapping.basePath, restApiId: mapping.restApiId, stage: mapping.stage }; }
function domainNameAccessAssociationView(association: ApiGatewayDomainNameAccessAssociationState): any { return { domainNameAccessAssociationArn: association.domainNameAccessAssociationArn, domainNameArn: association.domainNameArn, accessAssociationSourceType: association.accessAssociationSourceType, accessAssociationSource: association.accessAssociationSource, tags: structuredClone(association.tags) }; }
function documentationPartView(part: ApiDocumentationPartState): any { return { id: part.id, location: structuredClone(part.location), properties: part.properties }; }
function documentationVersionView(version: ApiDocumentationVersionState): any { return { version: version.version, createdDate: version.createdDate / 1000, description: version.description }; }
function vpcLinkView(link: ApiGatewayVpcLinkState): any { return { id: link.id, name: link.name, description: link.description, targetArns: structuredClone(link.targetArns), status: link.status, statusMessage: link.statusMessage, tags: structuredClone(link.tags) }; }
function clientCertificateView(certificate: ApiGatewayClientCertificateState): any { return { clientCertificateId: certificate.clientCertificateId, description: certificate.description, pemEncodedCertificate: certificate.pemEncodedCertificate, createdDate: certificate.createdDate / 1000, expirationDate: certificate.expirationDate / 1000, tags: structuredClone(certificate.tags) }; }
function patchValue(value: unknown): any { if (value === "true") return true; if (value === "false") return false; return value; }
function responseHeaders(headers: Headers): Record<string, string> { return Object.fromEntries([...headers.entries()]); }
function mediaType(value: string | undefined): string { return String(value ?? "").split(",")[0].split(";")[0].trim().toLowerCase(); }
function validMediaType(value: string | undefined): boolean { return /^(?:\*|[A-Za-z0-9!#$&^_.+-]+)\/(?:\*|[A-Za-z0-9!#$&^_.+-]+)$/.test(mediaType(value)); }
function matchesMediaType(value: string | undefined, configured: string[] = []): boolean { const actual = mediaType(value); if (!actual) return false; return configured.some(candidate => { const expected = mediaType(candidate); if (expected === "*/*") return true; if (expected.endsWith("/*")) return actual.startsWith(`${expected.slice(0, -1)}`); return actual === expected; }); }
function decodeBase64(value: Buffer): Buffer { const text = value.toString("utf8").replace(/\s+/g, ""); if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", "Unable to transform request", 500); const decoded = Buffer.from(text, "base64"); if (decoded.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", "Unable to transform request", 500); return decoded; }

const SQS_SEND_ACTIONS = new Set(["SendMessage", "SendMessageBatch"]);

function sqsQueryAttributes(value: unknown): Record<string, any> | undefined {
  if (value === undefined) return undefined;
  const attributes: Record<string, any> = {};
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!entry || typeof entry !== "object" || (entry as any).Name === undefined) continue;
    attributes[String((entry as any).Name)] = { ...((entry as any).Value ?? {}) };
  }
  return attributes;
}

function sqsQueryEntry(value: any): any {
  const entry = { ...(value ?? {}) };
  if (entry.MessageAttribute !== undefined) { entry.MessageAttributes = sqsQueryAttributes(entry.MessageAttribute); delete entry.MessageAttribute; }
  if (entry.MessageSystemAttribute !== undefined) { entry.MessageSystemAttributes = sqsQueryAttributes(entry.MessageSystemAttribute); delete entry.MessageSystemAttribute; }
  return entry;
}

function sqsQueryRequest(body: Buffer, queueUrl?: string): { operation: string; request: any } {
  let parsed: any;
  try { parsed = parseAwsQuery(body.toString("utf8")); }
  catch { throw new AwsError("BadGatewayException", "SQS integration request must be valid form data", 502); }
  const operation = String(parsed.Action ?? "");
  if (!SQS_SEND_ACTIONS.has(operation)) throw new AwsError("BadGatewayException", `Unsupported SQS integration action ${operation || "(empty)"}`, 502);
  delete parsed.Action; delete parsed.Version;
  if (parsed.MessageAttribute !== undefined) { parsed.MessageAttributes = sqsQueryAttributes(parsed.MessageAttribute); delete parsed.MessageAttribute; }
  if (parsed.MessageSystemAttribute !== undefined) { parsed.MessageSystemAttributes = sqsQueryAttributes(parsed.MessageSystemAttribute); delete parsed.MessageSystemAttribute; }
  if (operation === "SendMessageBatch") {
    parsed.Entries = (Array.isArray(parsed.SendMessageBatchRequestEntry) ? parsed.SendMessageBatchRequestEntry : parsed.SendMessageBatchRequestEntry === undefined ? [] : [parsed.SendMessageBatchRequestEntry]).map(sqsQueryEntry);
    delete parsed.SendMessageBatchRequestEntry;
  }
  if (queueUrl) parsed.QueueUrl = queueUrl;
  return { operation, request: parsed };
}

interface InvocationInput { method: string; path: string; headers: Record<string, string>; query: Record<string, string>; multiQuery: Record<string, string[]>; pathParameters: Record<string, string>; body: Buffer; stageName: string; stageVariables: Record<string, string>; requestId: string; deploymentId?: string; isCanaryRequest?: boolean; sourceIp?: string; userAgent?: string; domainName?: string; principal?: string; principalContext?: PrincipalContext; lambdaLineage?: string[]; identityAuthorization?: AuthorizationResult; sourceArn?: string; sourceAccount?: string; apiKeyId?: string; apiKeyValue?: string }
interface ServiceLogCorrelation { lambdaRequestId: string; functionName: string }
interface BackendResult { status: number; body: Buffer; headers: Record<string, string>; error?: string; latency: number; serviceLogCorrelation?: ServiceLogCorrelation }
interface PipelineResult { status: number; body: Buffer; headers: Record<string, string>; latency: number; integrationLatency: number; log: string; cacheStatus?: "hit" | "miss"; serviceLogCorrelation?: ServiceLogCorrelation; accessLogValues?: Record<string, unknown> }
interface InvocationConfiguration { binaryMediaTypes: string[]; minimumCompressionSize?: number; gatewayResponses: Record<string, ApiGatewayResponseState>; models: Record<string, ApiModelState>; requestValidators: Record<string, ApiRequestValidatorState>; apiKeySource: "HEADER" | "AUTHORIZER" }
interface InvocationCacheConfiguration { stage: ApiStageState; setting: ApiMethodSettingState; enabled: boolean }
interface CloudFormationResourceIdentity { cloudFormationOwner: string; cloudFormationOperationToken: string }
interface RestAuthorizerResult {
  principalId?: string;
  context: Record<string, unknown>;
  policy?: PolicyDocument;
  usageIdentifierKey?: string;
  authorization: AuthorizationResult;
  allowed: boolean;
  bearerDigest?: string;
}
type CachedRestAuthorizer =
  | {
      kind: "LAMBDA";
      expiresAt: number;
      value: {
        principalId: string;
        context: Record<string, unknown>;
        policy: PolicyDocument;
        usageIdentifierKey?: string;
      };
    }
  | {
      kind: "COGNITO";
      expiresAt: number;
      cacheVersion: string;
      userPoolArn: string;
      value: {
        principalId?: string;
        context: Record<string, unknown>;
        bearerDigest: string;
      };
    };

export class ApiGatewayService {
  private readonly authorizerCache = new Map<string, CachedRestAuthorizer>();
  private readonly throttleBuckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly canaryCounters = new Map<string, number>();
  private readonly registry = new ServiceRegistry();
  private readonly cacheCrypto: ApiGatewayCacheCrypto;
  constructor(private readonly store: StateStore, private readonly lambda: LambdaService, private readonly dynamodb: DynamoDbService, private readonly invokePort: number, private readonly region: string, private readonly clock: Clock = new SystemClock(), private readonly authMode: "off" | "validate" | "enforce" = "off", private readonly telemetry?: TelemetryBus, private readonly logs?: CloudWatchLogsService, private readonly accountRateLimit = 10_000, private readonly accountBurstLimit = 5_000, private readonly invokeProtocol: "http" | "https" = "http", private readonly vpcLinkOrigins: Record<string, string> = {}, private readonly allowClientCertificates = false, private readonly sqs?: SqsService, private readonly cognitoVerifier?: CognitoRestAuthorizerVerifier) {
    this.cacheCrypto = new ApiGatewayCacheCrypto(store.root);
    if (!Number.isFinite(accountRateLimit) || accountRateLimit <= 0 || !Number.isInteger(accountBurstLimit) || accountBurstLimit <= 0) throw new Error("API Gateway account throttle limits must be positive");
    for (const operation of ["PutItem", "GetItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem", "TransactGetItems", "TransactWriteItems"]) this.registry.register("dynamodb", operation, request => (this.dynamodb as any)[operation](request));
    this.registry.register("lambda", "Invoke", (request: any) => this.lambda.invoke(request.arn, request.payload, request.requestId, request.options));
    if (this.sqs) for (const operation of SQS_SEND_ACTIONS) this.registry.register("sqs", operation, request => (this.sqs as any)[operation](request));
  }
  async start(): Promise<void> {
    const entries = Object.values(this.responseCaches).flatMap(cache => Object.values(cache.entries));
    await this.cacheCrypto.start(entries.some(entry => entry.encrypted === true && "envelope" in entry));
  }
  /** Installation-private rotation hook; intentionally absent from the API Gateway action router. */
  rotateResponseCacheKey(): Promise<string> { return this.cacheCrypto.rotate(); }
  /** Pure service-capability check used by CloudFormation before PutMethod mutates an API. */
  validateCloudFormationIntegration(restApiId: string, resourceId: string, httpMethod: string, integration: Record<string, unknown>): void {
    const api = this.api(restApiId); const resource = api.resources[resourceId];
    if (!resource) throw new AwsError("BadRequestException", `API Gateway resource ${resourceId} does not exist in REST API ${restApiId}`);
    const type = String(integration.Type ?? ""); const uri = String(integration.Uri ?? ""); const credentials = integration.Credentials === undefined ? undefined : String(integration.Credentials);
    if (credentials) this.validateIntegrationRole(credentials);
    const lambdaTarget = /^arn:aws:apigateway:([a-z0-9-]+):lambda:path\/2015-03-31\/functions\/(arn:aws:lambda:([a-z0-9-]+):(\d{12}):function:([A-Za-z0-9-_]+)(?::([A-Za-z0-9-_]+))?)\/invocations$/.exec(uri);
    if (lambdaTarget) {
      if (lambdaTarget[1] !== this.region || lambdaTarget[3] !== this.region || lambdaTarget[4] !== this.store.accountId) throw new AwsError("BadRequestException", "Lambda integrations must target the simulator account and API Region");
      const functionArn = lambdaTarget[2]; const functionName = lambdaTarget[5]; const qualifier = lambdaTarget[6]; const fn = this.store.regionState(this.region).functions[functionName];
      if (!fn) throw new AwsError("BadRequestException", `Lambda integration target ${functionName} does not exist`);
      if (qualifier && !fn.versions?.[qualifier] && !fn.aliases?.[qualifier]) throw new AwsError("BadRequestException", `Lambda integration qualifier ${qualifier} does not exist`);
      if (credentials) {
        if (evaluateRoleAuthorization(this.store.ensureAccount().iam, credentials, "lambda:InvokeFunction", functionArn).decision !== "allowed") throw new AwsError("BadRequestException", "The API Gateway integration role cannot invoke the target Lambda function");
      }
      return;
    }
    if (type === "AWS") {
      const target = /^arn:aws:apigateway:([a-z0-9-]+):(dynamodb|sqs):(action|path)\/?(.+)$/.exec(uri);
      if (!target || target[1] !== this.region) throw new AwsError("BadRequestException", "AWS integrations must use a supported target in the API Region");
      if (target[2] === "sqs" && target[3] === "path" && target[4].split("/")[0] !== this.store.accountId) throw new AwsError("BadRequestException", "SQS path integrations must target the simulator account");
      return;
    }
    if (type === "HTTP" || type === "HTTP_PROXY") {
      if (process.env.STACKSIM_ALLOW_OUTBOUND_HTTP !== "true") throw new AwsError("BadRequestException", "Outbound HTTP integrations are disabled; set STACKSIM_ALLOW_OUTBOUND_HTTP=true");
      const target = new URL(uri); const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase(); if (process.env.STACKSIM_ALLOW_PRIVATE_HTTP !== "true" && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "169.254.169.254" || isIP(hostname) && this.privateIp(hostname))) throw new AwsError("BadRequestException", "Private and metadata HTTP integration targets are blocked");
    }
  }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); } private get apis(): Record<string, RestApiState> { return this.store.regionState(this.region).apis; }
  private get account() { return this.store.regionState(this.region).apiGatewayAccount; }
  private get apiKeys(): Record<string, ApiGatewayApiKeyState> { return this.store.regionState(this.region).apiGatewayApiKeys; }
  private get usagePlans(): Record<string, ApiGatewayUsagePlanState> { return this.store.regionState(this.region).apiGatewayUsagePlans; }
  private get responseCaches(): Record<string, ApiGatewayStageCacheState> { return this.store.regionState(this.region).apiGatewayResponseCaches; }
  private get domainNames(): Record<string, ApiGatewayDomainNameState> { return this.store.regionState(this.region).apiGatewayDomainNames; }
  private get domainNameAccessAssociations(): Record<string, ApiGatewayDomainNameAccessAssociationState> { return this.store.regionState(this.region).apiGatewayDomainNameAccessAssociations; }
  private get vpcLinks(): Record<string, ApiGatewayVpcLinkState> { return this.store.regionState(this.region).apiGatewayVpcLinks; }
  private get clientCertificates(): Record<string, ApiGatewayClientCertificateState> { return this.store.regionState(this.region).apiGatewayClientCertificates; }
  private cacheStageKey(apiId: string, stageName: string): string { return `${apiId}\0${stageName}`; }
  private stageCache(apiId: string, stageName: string): ApiGatewayStageCacheState { return this.responseCaches[this.cacheStageKey(apiId, stageName)] ??= { entries: {} }; }
  private clearResponseCache(apiId: string, stageName: string): void { delete this.responseCaches[this.cacheStageKey(apiId, stageName)]; }
  private api(apiId: string): RestApiState { const api = this.apis[apiId]; if (!api) throw new AwsError("NotFoundException", `Invalid REST API identifier specified ${apiId}`, 404); api.authorizers ??= {}; api.models ??= defaultApiModels(); api.requestValidators ??= {}; api.documentationParts ??= {}; api.documentationVersions ??= {}; api.binaryMediaTypes ??= []; api.gatewayResponses ??= {}; api.apiKeySource ??= "HEADER"; api.tags ??= {}; return api; }
  private domainName(value: string, domainNameId?: string | null): ApiGatewayDomainNameState { const name = this.normalizeDomainName(value); const domain = this.domainNames[name]; if (!domain || domain.domainNameId && domain.domainNameId !== domainNameId) throw new AwsError("NotFoundException", `Invalid domain name identifier specified ${value}`, 404); return domain; }
  private normalizeDomainName(value: unknown): string { const name = String(value ?? "").trim().toLowerCase().replace(/\.$/, ""); const labels = name.replace(/^\*\./, "").split("."); if (name.length > 253 || labels.length < 2 || labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || name.includes("*") && !name.startsWith("*.")) throw new AwsError("BadRequestException", "domainName must be a valid DNS host name; a wildcard is allowed only in the leftmost label"); return name; }
  private validateCertificateArn(value: string | undefined, label: string): void { if (value !== undefined && !new RegExp(`^arn:aws(?:-[a-z]+)?:acm:[a-z0-9-]+:${this.store.accountId}:certificate/[A-Za-z0-9-]+$`).test(value)) throw new AwsError("BadRequestException", `${label} must be a local-account ACM certificate ARN`); }
  private stringifyDomainPolicy(value: unknown, label: string): string | undefined { if (value === undefined || value === null || value === "") return undefined; try { const document = typeof value === "string" ? JSON.parse(value) : value; if (!document || typeof document !== "object" || !Array.isArray((document as any).Statement)) throw new Error(); return JSON.stringify(document); } catch { throw new AwsError("BadRequestException", `${label} must be a valid JSON policy document with Statement`); } }
  private configureDomainEndpointAlias(domain: ApiGatewayDomainNameState): void { const type = domain.endpointConfiguration.types[0]; const aliasId = domain.regionalDomainName?.split(".")[0] ?? domain.distributionDomainName?.split(".")[0] ?? createHash("sha256").update(domain.domainNameArn).digest("hex").slice(0, 14); delete domain.regionalDomainName; delete domain.regionalHostedZoneId; delete domain.distributionDomainName; delete domain.distributionHostedZoneId; if (type === "REGIONAL" || type === "PRIVATE") { domain.regionalDomainName = `${aliasId}.execute-api.${this.region}.local`; domain.regionalHostedZoneId = `Z${createHash("sha256").update(this.region).digest("hex").slice(0, 13).toUpperCase()}`; } else { domain.distributionDomainName = `${aliasId}.cloudfront.local`; domain.distributionHostedZoneId = "Z2FDTNDATAQYW2"; } }
  private validateDomainName(domain: ApiGatewayDomainNameState): void {
    domain.domainName = this.normalizeDomainName(domain.domainName); const types = domain.endpointConfiguration?.types; if (!Array.isArray(types) || types.length !== 1 || !new Set(["EDGE", "REGIONAL", "PRIVATE"]).has(types[0])) throw new AwsError("BadRequestException", "endpointConfiguration.types must contain exactly one of EDGE, REGIONAL, or PRIVATE");
    const type = types[0]; if (domain.endpointConfiguration.ipAddressType !== undefined && !["ipv4", "dualstack"].includes(domain.endpointConfiguration.ipAddressType)) throw new AwsError("BadRequestException", "endpointConfiguration.ipAddressType must be ipv4 or dualstack");
    if (domain.endpointConfiguration.vpcEndpointIds !== undefined && (!Array.isArray(domain.endpointConfiguration.vpcEndpointIds) || domain.endpointConfiguration.vpcEndpointIds.some(value => !/^vpce-[a-z0-9]+$/.test(value)))) throw new AwsError("BadRequestException", "endpointConfiguration.vpcEndpointIds must contain VPC endpoint IDs");
    if (type !== "PRIVATE" && domain.endpointConfiguration.vpcEndpointIds?.length) throw new AwsError("BadRequestException", "vpcEndpointIds are supported only for PRIVATE domain names");
    if (!DOMAIN_SECURITY_POLICIES.has(domain.securityPolicy)) throw new AwsError("BadRequestException", "Unsupported securityPolicy"); if (!DOMAIN_ROUTING_MODES.has(domain.routingMode)) throw new AwsError("BadRequestException", "Unsupported routingMode");
    if (domain.endpointAccessMode !== undefined && !["BASIC", "STRICT"].includes(domain.endpointAccessMode)) throw new AwsError("BadRequestException", "endpointAccessMode must be BASIC or STRICT"); if (domain.endpointAccessMode && !domain.securityPolicy.startsWith("SecurityPolicy_")) throw new AwsError("BadRequestException", "endpointAccessMode requires a modern SecurityPolicy_ policy");
    this.validateCertificateArn(domain.certificateArn, "certificateArn"); this.validateCertificateArn(domain.regionalCertificateArn, "regionalCertificateArn"); this.validateCertificateArn(domain.ownershipVerificationCertificateArn, "ownershipVerificationCertificateArn");
    if (type === "REGIONAL" && !domain.regionalCertificateArn) throw new AwsError("BadRequestException", "regionalCertificateArn is required for REGIONAL domain names"); if (type !== "REGIONAL" && domain.regionalCertificateArn) throw new AwsError("BadRequestException", "regionalCertificateArn is supported only for REGIONAL domain names");
    if (type !== "REGIONAL" && domain.mutualTlsAuthentication) throw new AwsError("BadRequestException", "Mutual TLS is supported only for REGIONAL domain names"); if (domain.mutualTlsAuthentication) { const truststoreUri = domain.mutualTlsAuthentication.truststoreUri; if (!truststoreUri || !/^s3:\/\/[A-Za-z0-9.-]{3,63}\/.+/.test(truststoreUri)) throw new AwsError("BadRequestException", "mutualTlsAuthentication.truststoreUri must be an S3 URI"); }
    if (type === "PRIVATE") { if (!domain.certificateArn) throw new AwsError("BadRequestException", "certificateArn is required for PRIVATE domain names"); domain.policy = this.stringifyDomainPolicy(domain.policy, "policy"); domain.managementPolicy = this.stringifyDomainPolicy(domain.managementPolicy, "managementPolicy"); } else if (domain.policy || domain.managementPolicy) throw new AwsError("BadRequestException", "policy and managementPolicy are supported only for PRIVATE domain names");
    if (type === "EDGE" && !domain.certificateArn && !domain.certificateUploadDate) throw new AwsError("BadRequestException", "certificateArn or an uploaded certificate is required for EDGE domain names"); domain.tags = this.validateTags(domain.tags);
  }
  private createDomainName(input: any): ApiGatewayDomainNameState {
    const domainName = this.normalizeDomainName(input.domainName); if (this.domainNames[domainName]) throw new AwsError("ConflictException", "The domain name already exists", 409); const types = Array.isArray(input.endpointConfiguration?.types) ? input.endpointConfiguration.types.map(String) : ["EDGE"]; const type = types[0];
    const uploaded = [input.certificateBody, input.certificatePrivateKey, input.certificateChain].filter(value => value !== undefined); if (uploaded.length && uploaded.length !== 3) throw new AwsError("BadRequestException", "certificateBody, certificatePrivateKey, and certificateChain must be provided together");
    const now = this.clock.now(); const domainNameId = type === "PRIVATE" ? id(10) : undefined; const domainNameArn = type === "PRIVATE" ? `arn:aws:apigateway:${this.region}:${this.store.accountId}:/domainnames/${domainName}+${domainNameId}` : `arn:aws:apigateway:${this.region}::/domainnames/${domainName}`; const aliasId = id(14).toLowerCase();
    const domain: ApiGatewayDomainNameState = { domainName, domainNameId, domainNameArn, certificateName: input.certificateName, certificateArn: input.certificateArn, certificateUploadDate: uploaded.length ? now : input.certificateArn ? now : undefined, regionalCertificateName: input.regionalCertificateName, regionalCertificateArn: input.regionalCertificateArn, endpointConfiguration: { types: types as any, ipAddressType: input.endpointConfiguration?.ipAddressType, vpcEndpointIds: input.endpointConfiguration?.vpcEndpointIds?.map(String) }, domainNameStatus: "AVAILABLE", securityPolicy: input.securityPolicy ?? "TLS_1_2", endpointAccessMode: input.endpointAccessMode, mutualTlsAuthentication: input.mutualTlsAuthentication ? { truststoreUri: input.mutualTlsAuthentication.truststoreUri, truststoreVersion: input.mutualTlsAuthentication.truststoreVersion } : undefined, ownershipVerificationCertificateArn: input.ownershipVerificationCertificateArn, policy: this.stringifyDomainPolicy(input.policy, "policy"), routingMode: input.routingMode ?? "BASE_PATH_MAPPING_ONLY", tags: input.tags ?? {}, basePathMappings: {}, createdDate: now, lastUpdatedDate: now };
    if (type === "REGIONAL" || type === "PRIVATE") { domain.regionalDomainName = `${aliasId}.execute-api.${this.region}.local`; domain.regionalHostedZoneId = `Z${createHash("sha256").update(this.region).digest("hex").slice(0, 13).toUpperCase()}`; } else { domain.distributionDomainName = `${aliasId}.cloudfront.local`; domain.distributionHostedZoneId = "Z2FDTNDATAQYW2"; }
    this.validateDomainName(domain); return domain;
  }
  private normalizeBasePath(value: unknown): string { const basePath = value === undefined || value === null || value === "" ? "(none)" : String(value); if (basePath === "(none)") return basePath; if (basePath.length > 300 || basePath.startsWith("/") || basePath.endsWith("/") || basePath.split("/").some(part => !part || !/^[A-Za-z0-9._~-]+$/.test(part))) throw new AwsError("BadRequestException", "basePath must contain URL path segments without leading or trailing slashes"); return basePath; }
  private validateBasePathMapping(mapping: ApiGatewayBasePathMappingState): void { mapping.basePath = this.normalizeBasePath(mapping.basePath); const api = this.api(mapping.restApiId); if (mapping.stage !== "(none)" && !api.stages[mapping.stage]) throw new AwsError("BadRequestException", "The stage identifier is invalid"); }
  private cloudFormationCreateIdentity(request: IncomingMessage): CloudFormationResourceIdentity | undefined {
    const cloudFormationOwner = getCloudFormationOwner(request);
    const cloudFormationOperationToken = getCloudFormationIdempotencyKey(request);
    if ((cloudFormationOwner === undefined) !== (cloudFormationOperationToken === undefined)) {
      throw new AwsError("InternalFailure", "CloudFormation resource owner and operation token must be supplied together", 500);
    }
    return cloudFormationOwner === undefined
      ? undefined
      : { cloudFormationOwner, cloudFormationOperationToken: cloudFormationOperationToken! };
  }
  private assertCloudFormationOwner(
    request: IncomingMessage,
    resource: { cloudFormationOwner?: string },
    label: string,
  ): void {
    const expected = getCloudFormationOwner(request);
    if (expected !== undefined && resource.cloudFormationOwner !== expected) {
      throw new AwsError("OwnershipConflict", `${label} is not owned by this CloudFormation stack resource`, 409);
    }
  }
  private assertCloudFormationReplay(
    identity: CloudFormationResourceIdentity,
    resource: { cloudFormationOwner?: string; cloudFormationOperationToken?: string },
    label: string,
  ): void {
    if (resource.cloudFormationOwner !== identity.cloudFormationOwner) {
      throw new AwsError("OwnershipConflict", `${label} is not owned by this CloudFormation stack resource`, 409);
    }
    if (resource.cloudFormationOperationToken !== identity.cloudFormationOperationToken) {
      throw new AwsError("ConflictException", `${label} belongs to a different CloudFormation create operation`, 409);
    }
  }
  private applyDomainPatch(domain: ApiGatewayDomainNameState, operations: any[]): ApiGatewayDomainNameState { const candidate = structuredClone(domain); for (const operation of operations ?? []) { const path = String(operation.path ?? ""); if (!new Set(["add", "replace", "remove", "copy"]).has(operation.op)) throw new AwsError("BadRequestException", `Invalid patch operation: ${operation.op}`); if (path.startsWith("/endpointConfiguration/types/")) { const type = decodeURIComponent(path.slice("/endpointConfiguration/types/".length)); if (operation.op === "remove") candidate.endpointConfiguration.types = candidate.endpointConfiguration.types.filter(value => value !== type); else if (operation.op === "add") candidate.endpointConfiguration.types.push(type as any); else throw new AwsError("BadRequestException", "Endpoint types support add and remove operations"); continue; } this.applyPatch(candidate, [operation], new Set(["/certificateName", "/certificateArn", "/regionalCertificateName", "/regionalCertificateArn", "/endpointConfiguration", "/securityPolicy", "/endpointAccessMode", "/mutualTlsAuthentication", "/ownershipVerificationCertificateArn", "/managementPolicy", "/policy", "/routingMode"])); }
    if ((candidate.endpointConfiguration.types[0] === "PRIVATE") !== Boolean(candidate.domainNameId)) throw new AwsError("BadRequestException", "A domain name cannot be migrated between public and private endpoint types"); candidate.policy = this.stringifyDomainPolicy(candidate.policy, "policy"); candidate.managementPolicy = this.stringifyDomainPolicy(candidate.managementPolicy, "managementPolicy"); candidate.lastUpdatedDate = this.clock.now(); this.validateDomainName(candidate); this.configureDomainEndpointAlias(candidate); return candidate; }
  private resource(api: RestApiState, resourceId: string): ApiResource { const resource = api.resources[resourceId]; if (!resource) throw new AwsError("NotFoundException", `Invalid Resource identifier specified ${resourceId}`, 404); return resource; }
  private route(resources: Record<string, ApiResource>, path: string): { resource: ApiResource; parameters: Record<string, string> } | undefined { for (const resource of Object.values(resources).sort((a, b) => b.path.length - a.path.length)) { const names: string[] = []; const pattern = resource.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([^}]+)\\\+\\\}/g, (_m, name) => { names.push(name); return "(.+)"; }).replace(/\\\{([^}]+)\\\}/g, (_m, name) => { names.push(name); return "([^/]+)"; }); const match = path.match(new RegExp(`^${pattern}$`)); if (match) return { resource, parameters: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) }; } return undefined; }
  invocationAuthorizationType(pathname: string, method: string): string { const match = pathname.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/); if (!match) throw new AwsError("NotFoundException", "Use /{apiId}/{stage}/{resourcePath}", 404); const api = this.api(match[1]); const stage = api.stages[decodeURIComponent(match[2])]; if (!stage) throw new AwsError("MissingAuthenticationTokenException", "Missing Authentication Token", 403); const resources = api.deployments[stage.deploymentId]?.snapshot?.resources; if (!resources) throw new AwsError("InternalServerErrorException", "Stage deployment is missing", 500); const routed = this.route(resources, match[3] ?? "/"); return routed?.resource.methods[method.toUpperCase()]?.authorizationType ?? routed?.resource.methods.ANY?.authorizationType ?? "NONE"; }
  customDomainInvocation(hostHeader: string | undefined, pathname: string): { matched: boolean; pathname?: string } {
    const host = String(hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, ""); if (!host) return { matched: false };
    const exact = this.domainNames[host]; const wildcard = Object.values(this.domainNames).filter(domain => domain.domainName.startsWith("*.")).filter(domain => { const suffix = domain.domainName.slice(1); return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes("."); }).sort((left, right) => right.domainName.length - left.domainName.length)[0]; const domain = exact ?? wildcard; if (!domain) return { matched: false };
    if (domain.routingMode === "ROUTING_RULE_ONLY") return { matched: true }; const requestPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const mappings = Object.values(domain.basePathMappings).filter(mapping => mapping.basePath === "(none)" || requestPath === `/${mapping.basePath}` || requestPath.startsWith(`/${mapping.basePath}/`)).sort((left, right) => (right.basePath === "(none)" ? 0 : right.basePath.length) - (left.basePath === "(none)" ? 0 : left.basePath.length)); const mapping = mappings[0]; if (!mapping) return { matched: true };
    let remaining = mapping.basePath === "(none)" ? requestPath : requestPath.slice(mapping.basePath.length + 1) || "/"; if (!remaining.startsWith("/")) remaining = `/${remaining}`; let stage = mapping.stage;
    if (stage === "(none)") { const stageMatch = remaining.match(/^\/([^/]+)(\/.*)?$/); if (!stageMatch) return { matched: true }; stage = decodeURIComponent(stageMatch[1]); remaining = stageMatch[2] ?? "/"; }
    const api = this.apis[mapping.restApiId]; if (!api?.stages[stage]) return { matched: true }; return { matched: true, pathname: `/${mapping.restApiId}/${encodeURIComponent(stage)}${remaining === "/" ? "" : remaining}` };
  }
  private page<T>(operation: string, apiId: string, values: T[], url: URL): { item: T[]; position?: string } { const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 25))); let start = 0; const position = url.searchParams.get("position"); if (position) try { const cursor = this.tokens.decode<{ apiId: string; index: number }>(operation, position); if (cursor.apiId !== apiId) throw new Error(); start = cursor.index; } catch { throw new AwsError("BadRequestException", "Invalid pagination position"); } const item = values.slice(start, start + limit); const next = start + item.length; return { item, ...(next < values.length ? { position: this.tokens.encode(operation, { apiId, index: next }) } : {}) }; }
  private applyPatch(target: any, operations: any[], allowed: Set<string>): void { for (const operation of operations ?? []) { const path = String(operation.path ?? ""); const root = `/${path.split("/").filter(Boolean)[0] ?? ""}`; if (!allowed.has(root) || !["add", "replace", "remove", "copy"].includes(operation.op)) throw new AwsError("BadRequestException", `Invalid patch path or operation: ${operation.op} ${path}`); const parts = path.split("/").slice(1).map((part: string) => part.replace(/~1/g, "/").replace(/~0/g, "~")); let owner = target; for (const part of parts.slice(0, -1)) owner = owner[part] ??= {}; const key = parts.at(-1); if (!key) throw new AwsError("BadRequestException", `Invalid patch path: ${path}`); if (operation.op === "remove") delete owner[key]; else if (operation.op === "copy") { const from = String(operation.from ?? "").split("/").filter(Boolean); let source = target; for (const part of from) source = source?.[part]; owner[key] = structuredClone(source); } else owner[key] = patchValue(operation.value); } }
  private replaceObject(target: any, replacement: any): void { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, replacement); }
  private applyRestApiPatch(api: RestApiState, operations: any[]): void {
    for (const operation of operations ?? []) {
      const path = String(operation.path ?? "");
      if (path === "/binaryMediaTypes") {
        if (operation.op === "remove") api.binaryMediaTypes = [];
        else if (["add", "replace"].includes(operation.op) && Array.isArray(operation.value)) api.binaryMediaTypes = operation.value.map(String);
        else throw new AwsError("BadRequestException", `Invalid patch path or operation: ${operation.op} ${path}`);
        continue;
      }
      if (path.startsWith("/binaryMediaTypes/")) {
        if (!["add", "remove", "replace"].includes(operation.op)) throw new AwsError("BadRequestException", `Invalid patch path or operation: ${operation.op} ${path}`);
        const original = path.slice("/binaryMediaTypes/".length).replace(/~1/g, "/").replace(/~0/g, "~");
        api.binaryMediaTypes ??= [];
        if (operation.op === "remove" || operation.op === "replace") api.binaryMediaTypes = api.binaryMediaTypes.filter(value => value !== original);
        if (operation.op === "add" || operation.op === "replace") { const value = String(operation.value ?? original); if (!api.binaryMediaTypes.includes(value)) api.binaryMediaTypes.push(value); }
        continue;
      }
      if (path === "/minimumCompressionSize") {
        if (operation.op === "remove" || operation.value === null || operation.value === "") delete api.minimumCompressionSize;
        else if (["add", "replace"].includes(operation.op)) api.minimumCompressionSize = Number(operation.value);
        else throw new AwsError("BadRequestException", `Invalid patch path or operation: ${operation.op} ${path}`);
        continue;
      }
      this.applyPatch(api, [operation], new Set(["/name", "/description", "/policy", "/apiKeySource"]));
    }
  }
  private validateRestApiSettings(api: RestApiState): void {
    if (!Array.isArray(api.binaryMediaTypes)) throw new AwsError("BadRequestException", "binaryMediaTypes must be an array");
    const normalized = api.binaryMediaTypes.map(value => mediaType(String(value)));
    if (normalized.some(value => !/^(?:\*|[A-Za-z0-9!#$&^_.+-]+)\/(?:\*|[A-Za-z0-9!#$&^_.+-]+)$/.test(value))) throw new AwsError("BadRequestException", "binaryMediaTypes contains an invalid media type");
    if (new Set(normalized).size !== normalized.length) throw new AwsError("BadRequestException", "binaryMediaTypes must not contain duplicates");
    api.binaryMediaTypes = normalized;
    api.apiKeySource ??= "HEADER";
    if (!["HEADER", "AUTHORIZER"].includes(api.apiKeySource)) throw new AwsError("BadRequestException", "apiKeySource must be HEADER or AUTHORIZER");
    if (api.minimumCompressionSize !== undefined && (!Number.isInteger(api.minimumCompressionSize) || api.minimumCompressionSize < 0 || api.minimumCompressionSize > 10_485_760)) throw new AwsError("BadRequestException", "minimumCompressionSize must be between 0 and 10485760");
    api.gatewayResponses ??= {};
    api.documentationParts ??= {};
    api.documentationVersions ??= {};
  }
  private validateGatewayResponseType(responseType: string): void { if (!GATEWAY_RESPONSE_TYPES.has(responseType)) throw new AwsError("BadRequestException", `Invalid gateway response type: ${responseType}`); }
  private applyGatewayResponsePatch(response: ApiGatewayResponseState, operations: any[]): void { this.applyPatch(response, operations, new Set(["/statusCode", "/responseParameters", "/responseTemplates"])); }
  private validateGatewayResponse(response: ApiGatewayResponseState): void {
    this.validateGatewayResponseType(response.responseType);
    if (response.statusCode !== undefined && !/^[1-5]\d\d$/.test(String(response.statusCode))) throw new AwsError("BadRequestException", "statusCode must contain three digits");
    response.statusCode = response.statusCode === undefined ? undefined : String(response.statusCode);
    response.responseParameters ??= {}; response.responseTemplates ??= {};
    for (const [name, value] of Object.entries(response.responseParameters)) if (!/^gatewayresponse\.header\.[A-Za-z0-9._-]+$/.test(name) || typeof value !== "string") throw new AwsError("BadRequestException", `Invalid gateway response parameter: ${name}`);
    for (const [type, template] of Object.entries(response.responseTemplates)) if (!mediaType(type) || typeof template !== "string") throw new AwsError("BadRequestException", `Invalid gateway response template: ${type}`);
  }
  private validateModels(models: Record<string, ApiModelState>): void { try { validateModelCatalog(models); } catch (error) { throw new AwsError("BadRequestException", error instanceof Error ? error.message : String(error)); } }
  private validateModelMap(api: RestApiState, models: Record<string, string> | undefined): void { for (const [contentType, name] of Object.entries(models ?? {})) { if (contentType !== "$default" && !validMediaType(contentType)) throw new AwsError("BadRequestException", `Invalid model content type: ${contentType}`); if (!api.models?.[name]) throw new AwsError("BadRequestException", `Invalid model identifier specified: ${name}`); } }
  private validateMethodConfiguration(api: RestApiState, method: ApiMethodState): void {
    this.validateModelMap(api, method.requestModels);
    if (method.requestValidatorId && !api.requestValidators?.[method.requestValidatorId]) throw new AwsError("BadRequestException", "Invalid request validator identifier specified");
    if (!["NONE", "AWS_IAM", "CUSTOM", "COGNITO_USER_POOLS"].includes(method.authorizationType)) throw new AwsError("BadRequestException", "Invalid authorization type");
    const authorizer = method.authorizerId ? api.authorizers?.[method.authorizerId] : undefined;
    if (method.authorizationType === "CUSTOM" && (!authorizer || authorizer.type === "COGNITO_USER_POOLS")) throw new AwsError("BadRequestException", "A valid Lambda authorizerId is required");
    if (method.authorizationType === "COGNITO_USER_POOLS" && authorizer?.type !== "COGNITO_USER_POOLS") throw new AwsError("BadRequestException", "A valid Cognito user-pool authorizerId is required");
    if (!["CUSTOM", "COGNITO_USER_POOLS"].includes(method.authorizationType) && method.authorizerId) throw new AwsError("BadRequestException", "authorizerId is valid only for authorizer-backed methods");
    if (!Array.isArray(method.authorizationScopes ?? []) || (method.authorizationScopes ?? []).some(scope => typeof scope !== "string" || scope.length < 1 || scope.length > 256) || new Set(method.authorizationScopes ?? []).size !== (method.authorizationScopes ?? []).length || (method.authorizationScopes ?? []).length > 10) throw new AwsError("BadRequestException", "authorizationScopes must contain up to 10 unique non-empty strings");
    if (method.authorizationType !== "COGNITO_USER_POOLS" && (method.authorizationScopes?.length ?? 0) > 0) throw new AwsError("BadRequestException", "authorizationScopes are valid only for Cognito user-pool methods");
  }
  private documentationPart(api: RestApiState, partId: string): ApiDocumentationPartState { const part = api.documentationParts?.[partId]; if (!part) throw new AwsError("NotFoundException", "Invalid DocumentationPart identifier specified", 404); return part; }
  private documentationVersion(api: RestApiState, version: string) { const item = api.documentationVersions?.[version]; if (!item) throw new AwsError("NotFoundException", "Invalid DocumentationVersion identifier specified", 404); return item; }
  private validateDocumentationLocation(api: RestApiState, input: any): ApiDocumentationPartLocationState {
    const type = String(input?.type ?? "").toUpperCase() as ApiDocumentationPartLocationState["type"];
    if (!DOCUMENTATION_PART_TYPES.has(type)) throw new AwsError("BadRequestException", "Documentation location type is invalid");
    const location: ApiDocumentationPartLocationState = { type };
    if (input.path !== undefined) { const path = String(input.path); if (!path.startsWith("/") || path.length > 1600) throw new AwsError("BadRequestException", "Documentation location path must start with /"); location.path = path; }
    if (input.method !== undefined) { const method = String(input.method).toUpperCase(); if (method !== "*" && !/^[A-Z]+$/.test(method)) throw new AwsError("BadRequestException", "Documentation location method is invalid"); location.method = method; }
    if (input.statusCode !== undefined) { const statusCode = String(input.statusCode); if (statusCode !== "*" && !/^\d{3}$/.test(statusCode)) throw new AwsError("BadRequestException", "Documentation location statusCode is invalid"); location.statusCode = statusCode; }
    if (input.name !== undefined) { const name = String(input.name).trim(); if (!name) throw new AwsError("BadRequestException", "Documentation location name must not be empty"); location.name = name; }
    const nameRequired = new Set(["AUTHORIZER", "MODEL", "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE_HEADER"]); if (nameRequired.has(type) && !location.name) throw new AwsError("BadRequestException", `Documentation location name is required for ${type}`);
    const pathTypes = new Set(["RESOURCE", "METHOD", "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE", "RESPONSE_HEADER", "RESPONSE_BODY"]); if (pathTypes.has(type) && location.path && !Object.values(api.resources).some(resource => resource.path === location.path)) throw new AwsError("BadRequestException", "Documentation location path does not identify an API resource");
    if (type === "MODEL" && location.name && !api.models?.[location.name]) throw new AwsError("BadRequestException", "Documentation location model does not exist");
    if (type === "AUTHORIZER" && location.name && !Object.values(api.authorizers ?? {}).some(authorizer => authorizer.name === location.name || authorizer.id === location.name)) throw new AwsError("BadRequestException", "Documentation location authorizer does not exist");
    return location;
  }
  private validateDocumentationProperties(value: unknown): string { const text = typeof value === "string" ? value : JSON.stringify(value); if (!text || Buffer.byteLength(text) > 32_768) throw new AwsError("BadRequestException", "Documentation properties must be a JSON object no larger than 32768 bytes"); try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return JSON.stringify(parsed); } catch { throw new AwsError("BadRequestException", "Documentation properties must be a JSON object"); } }
  private documentationLocationKey(location: ApiDocumentationPartLocationState): string { return JSON.stringify({ type: location.type, path: location.path, method: location.method, statusCode: location.statusCode, name: location.name }); }
  private createDocumentationPartState(
    api: RestApiState,
    input: any,
    existingId?: string,
    identity?: CloudFormationResourceIdentity,
  ): ApiDocumentationPartState {
    const location = this.validateDocumentationLocation(api, input.location);
    const properties = this.validateDocumentationProperties(input.properties);
    const duplicate = Object.values(api.documentationParts ?? {}).find(
      part => part.id !== existingId
        && this.documentationLocationKey(part.location) === this.documentationLocationKey(location),
    );
    if (duplicate) {
      if (identity) {
        this.assertCloudFormationReplay(identity, duplicate, "Documentation part");
        if (duplicate.properties !== properties) {
          throw new AwsError(
            "ConflictException",
            "The CloudFormation operation token belongs to a documentation part with different properties",
            409,
          );
        }
        return duplicate;
      }
      throw new AwsError("ConflictException", "A documentation part already exists for this location", 409);
    }
    return {
      id: existingId ?? id(10),
      location,
      properties,
      ...identity,
    };
  }
  private applyImportedDocumentation(api: RestApiState, document: Record<string, any>, mode: "merge" | "overwrite", warnings: string[]): void {
    const extension = document["x-amazon-apigateway-documentation"];
    if (extension === undefined) return;
    const inputs = Array.isArray(extension) ? extension : extension?.documentationParts;
    if (!Array.isArray(inputs)) { warnings.push("x-amazon-apigateway-documentation.documentationParts must be an array"); return; }
    const candidate: Record<string, ApiDocumentationPartState> = mode === "overwrite" ? {} : structuredClone(api.documentationParts ?? {});
    for (let index = 0; index < inputs.length; index++) {
      try { const candidateApi = { ...api, documentationParts: candidate }; const part = this.createDocumentationPartState(candidateApi, inputs[index]); candidate[part.id] = part; }
      catch (error) { warnings.push(`Documentation part ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    api.documentationParts = candidate;
  }
  private documentationForStage(api: RestApiState, stage: ApiStageState): ApiDocumentationPartState[] { const selected = stage.documentationVersion ? this.documentationVersion(api, stage.documentationVersion).parts : api.documentationParts ?? {}; return Object.values(selected).map(part => structuredClone(part)); }
  private applyDocumentationToExport(document: Record<string, any>, parts: ApiDocumentationPartState[]): void {
    if (!parts.length) return;
    document["x-amazon-apigateway-documentation"] = { documentationParts: parts.map(part => ({ location: structuredClone(part.location), properties: JSON.parse(part.properties) })) };
    for (const part of parts) { const properties = JSON.parse(part.properties); const path = part.location.path ?? "/"; if (part.location.type === "API") Object.assign(document.info ??= {}, properties); else if (part.location.type === "RESOURCE" && document.paths?.[path]) Object.assign(document.paths[path], properties); else if (part.location.type === "METHOD" && document.paths?.[path]) Object.assign(document.paths[path][String(part.location.method ?? "get").toLowerCase()] ??= {}, properties); else if (part.location.type === "MODEL" && part.location.name) { const schemas = document.swagger ? document.definitions ??= {} : (document.components ??= {}).schemas ??= {}; if (schemas[part.location.name]) Object.assign(schemas[part.location.name], properties); } }
  }
  private vpcLink(idValue: string): ApiGatewayVpcLinkState { const link = this.vpcLinks[idValue]; if (!link) throw new AwsError("NotFoundException", "Invalid VpcLink identifier specified", 404); return link; }
  private clientCertificate(idValue: string): ApiGatewayClientCertificateState { const certificate = this.clientCertificates[idValue]; if (!certificate) throw new AwsError("NotFoundException", "Invalid ClientCertificate identifier specified", 404); return certificate; }
  private vpcLinkOrigin(link: ApiGatewayVpcLinkState): string | undefined { return this.vpcLinkOrigins[link.id] ?? this.vpcLinkOrigins[link.name] ?? link.targetArns.map(arn => this.vpcLinkOrigins[arn]).find(Boolean); }
  private validateVpcLinkTargetArns(value: unknown): string[] { if (!Array.isArray(value) || value.length !== 1 || value.some(item => typeof item !== "string" || !/^arn:aws(?:-[a-z]+)?:elasticloadbalancing:[a-z0-9-]+:\d{12}:loadbalancer\/(?:net|app)\/[A-Za-z0-9-]+\/[A-Fa-f0-9]+$/.test(item))) throw new AwsError("BadRequestException", "targetArns must contain one load balancer ARN"); return value.map(String); }
  private sdkType(idValue: string) { const type = SDK_TYPES.find(item => item.id === idValue); if (!type) throw new AwsError("NotFoundException", "Invalid SdkType identifier specified", 404); return type; }
  private javascriptSdk(api: RestApiState, stage: ApiStageState): Buffer {
    const endpoint = `${this.invokeProtocol}://localhost:${this.invokePort}/${api.id}/${encodeURIComponent(stage.stageName)}`;
    const client = `export class ApiClient {\n  constructor({ endpoint = ${JSON.stringify(endpoint)}, fetchImpl = globalThis.fetch } = {}) { this.endpoint = endpoint.replace(/\\/$/, ""); this.fetch = fetchImpl; }\n  async invoke(path = "/", { method = "GET", headers = {}, body } = {}) { const response = await this.fetch(this.endpoint + (path.startsWith("/") ? path : "/" + path), { method, headers, body }); return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }; }\n}\n`;
    return createZip([{ name: "README.md", content: `# ${api.name} JavaScript client\n\nGenerated locally by stacksim for stage \`${stage.stageName}\`. This dependency-free client invokes ${endpoint}. It does not copy AWS generator code and does not implement SigV4 signing.\n` }, { name: "package.json", content: JSON.stringify({ name: `${api.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-client`, version: "1.0.0", type: "module", exports: "./client.js" }, null, 2) }, { name: "client.js", content: client }]);
  }
  private importParameters(url: URL): Record<string, string> { const result: Record<string, string> = {}; for (const [key, value] of url.searchParams) { const match = key.match(/^parameters\[([^\]]+)\]$/); if (match) result[match[1]] = value; else if (!["mode", "failonwarnings"].includes(key.toLowerCase())) result[key] = value; } return result; }
  private validateImportedApi(api: RestApiState): void {
    this.validateRestApiSettings(api); this.validateModels(api.models ?? {}); if (typeof (api as any).policy === "string") api.policy = parsePolicy((api as any).policy);
    for (const response of Object.values(api.gatewayResponses ?? {})) this.validateGatewayResponse(response);
    for (const authorizer of Object.values(api.authorizers ?? {})) this.validateAuthorizerConfiguration(authorizer);
    for (const resource of Object.values(api.resources)) for (const [methodName, method] of Object.entries(resource.methods)) { this.validateMethodConfiguration(api, method); for (const response of Object.values(method.responses ?? {})) this.validateModelMap(api, response.responseModels); const integration = resource.integrations[methodName]; if (integration) { this.validateIntegrationConfiguration(integration, method); for (const response of Object.values(integration.responses ?? {})) this.validateIntegrationResponse(method, response); } }
  }
  private accountView(): any { return { cloudwatchRoleArn: this.account.cloudwatchRoleArn, throttleSettings: { rateLimit: this.accountRateLimit, burstLimit: this.accountBurstLimit }, features: ["UsagePlans"], apiKeyVersion: "4" }; }
  private stageArn(apiId: string, stageName: string): string { return `arn:aws:apigateway:${this.region}::/restapis/${apiId}/stages/${stageName}`; }
  private taggedResource(resourceArn: string): { tags: Record<string, string>; assign: (tags: Record<string, string>) => void } {
    const escapedRegion = this.region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const stageMatch = resourceArn.match(new RegExp(`^arn:aws:apigateway:${escapedRegion}::/restapis/([^/]+)/stages/([^/]+)$`)); if (stageMatch) { const api = this.api(stageMatch[1]); const stage = api.stages[decodeURIComponent(stageMatch[2])]; if (!stage) throw new AwsError("NotFoundException", "Invalid Stage identifier specified", 404); stage.tags ??= {}; return { tags: stage.tags, assign: tags => { stage.tags = tags; } }; }
    const apiMatch = resourceArn.match(new RegExp(`^arn:aws:apigateway:${escapedRegion}::/restapis/([^/]+)$`)); if (apiMatch) { const api = this.api(decodeURIComponent(apiMatch[1])); api.tags ??= {}; return { tags: api.tags, assign: tags => { api.tags = tags; } }; }
    const keyMatch = resourceArn.match(new RegExp(`^arn:aws:apigateway:${escapedRegion}::/apikeys/([^/]+)$`)); if (keyMatch) { const key = this.requireApiKey(decodeURIComponent(keyMatch[1])); return { tags: key.tags, assign: tags => { key.tags = tags; key.lastUpdatedDate = this.clock.now(); } }; }
    const planMatch = resourceArn.match(new RegExp(`^arn:aws:apigateway:${escapedRegion}::/usageplans/([^/]+)$`)); if (planMatch) { const plan = this.requireUsagePlan(decodeURIComponent(planMatch[1])); return { tags: plan.tags, assign: tags => { plan.tags = tags; } }; }
    const domain = Object.values(this.domainNames).find(candidate => candidate.domainNameArn === resourceArn); if (domain) return { tags: domain.tags, assign: tags => { domain.tags = tags; domain.lastUpdatedDate = this.clock.now(); } };
    const association = this.domainNameAccessAssociations[resourceArn]; if (association) return { tags: association.tags, assign: tags => { association.tags = tags; } };
    const vpcLinkMatch = resourceArn.match(new RegExp(`^arn:aws:apigateway:${escapedRegion}::/vpclinks/([^/]+)$`)); if (vpcLinkMatch) { const link = this.vpcLink(decodeURIComponent(vpcLinkMatch[1])); return { tags: link.tags, assign: tags => { link.tags = tags; } }; }
    const certificateMatch = resourceArn.match(new RegExp(`^arn:aws:apigateway:${escapedRegion}::/clientcertificates/([^/]+)$`)); if (certificateMatch) { const certificate = this.clientCertificate(decodeURIComponent(certificateMatch[1])); return { tags: certificate.tags, assign: tags => { certificate.tags = tags; } }; }
    throw new AwsError("BadRequestException", "The resource ARN is not taggable by the implemented API Gateway surface");
  }
  private validateTags(tags: Record<string, string> | undefined): Record<string, string> { const result: Record<string, string> = {}; for (const [key, value] of Object.entries(tags ?? {})) { if (!key || key.length > 128 || key.toLowerCase().startsWith("aws:") || value.length > 256 || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(key) || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(value)) throw new AwsError("BadRequestException", `Invalid tag: ${key}`); result[key] = value; } if (Object.keys(result).length > 50) throw new AwsError("BadRequestException", "A resource can have at most 50 tags"); return result; }
  private validateStageVariables(variables: Record<string, string> | undefined): Record<string, string> { const result: Record<string, string> = {}; for (const [key, value] of Object.entries(variables ?? {})) { if (!/^[A-Za-z0-9_]+$/.test(key) || !/^[A-Za-z0-9\-._~:/?#&=,]+$/.test(String(value))) throw new AwsError("BadRequestException", `Invalid stage variable: ${key}`); result[key] = String(value); } return result; }
  private validateMethodSetting(setting: ApiMethodSettingState): void {
    if (setting.loggingLevel !== undefined && !["OFF", "ERROR", "INFO"].includes(setting.loggingLevel)) throw new AwsError("BadRequestException", "loggingLevel must be OFF, ERROR, or INFO");
    if (setting.throttlingBurstLimit !== undefined && (!Number.isInteger(setting.throttlingBurstLimit) || setting.throttlingBurstLimit < 0)) throw new AwsError("BadRequestException", "throttlingBurstLimit must be a non-negative integer");
    if (setting.throttlingRateLimit !== undefined && (!Number.isFinite(setting.throttlingRateLimit) || setting.throttlingRateLimit < 0)) throw new AwsError("BadRequestException", "throttlingRateLimit must be non-negative");
    if (setting.cacheTtlInSeconds !== undefined && (!Number.isInteger(setting.cacheTtlInSeconds) || setting.cacheTtlInSeconds < 0 || setting.cacheTtlInSeconds > 3_600)) throw new AwsError("BadRequestException", "cacheTtlInSeconds must be between 0 and 3600");
    if (setting.unauthorizedCacheControlHeaderStrategy !== undefined && !["FAIL_WITH_403", "SUCCEED_WITH_RESPONSE_HEADER", "SUCCEED_WITHOUT_RESPONSE_HEADER"].includes(setting.unauthorizedCacheControlHeaderStrategy)) throw new AwsError("BadRequestException", "Invalid unauthorized cache-control strategy");
  }
  private validateStage(api: RestApiState, stage: ApiStageState): void {
    if (!api.deployments[stage.deploymentId]) throw new AwsError("BadRequestException", "Invalid deployment identifier specified"); stage.variables = this.validateStageVariables(stage.variables); stage.tags = this.validateTags(stage.tags); stage.methodSettings ??= {}; for (const setting of Object.values(stage.methodSettings)) this.validateMethodSetting(setting);
    if (stage.documentationVersion && !api.documentationVersions?.[stage.documentationVersion]) throw new AwsError("BadRequestException", "Invalid documentation version specified");
    if (stage.clientCertificateId && !this.clientCertificates[stage.clientCertificateId]) throw new AwsError("BadRequestException", "Invalid client certificate specified");
    if (stage.cacheClusterSize !== undefined && !["0.5", "1.6", "6.1", "13.5", "28.4", "58.2", "118", "237"].includes(stage.cacheClusterSize)) throw new AwsError("BadRequestException", "Invalid cache cluster size");
    const canary = stage.canarySettings; if (canary) { if (canary.deploymentId && !api.deployments[canary.deploymentId]) throw new AwsError("BadRequestException", "Invalid canary deployment identifier specified"); if (canary.percentTraffic !== undefined && (!Number.isFinite(canary.percentTraffic) || canary.percentTraffic < 0 || canary.percentTraffic > 100)) throw new AwsError("BadRequestException", "Canary percentTraffic must be between 0 and 100"); if ((canary.percentTraffic ?? 0) > 0 && !canary.deploymentId) throw new AwsError("BadRequestException", "A canary deploymentId is required when percentTraffic is greater than zero"); canary.stageVariableOverrides = this.validateStageVariables(canary.stageVariableOverrides); canary.useStageCache = canary.useStageCache ?? false; }
    if (stage.accessLogSettings) { const { destinationArn, format } = stage.accessLogSettings; if (destinationArn && !new RegExp(`^arn:aws:logs:${this.region}:${this.store.accountId}:log-group:[^:*]+(?:[:*].*)?$`).test(destinationArn)) throw new AwsError("BadRequestException", "Access log destinationArn must identify a local CloudWatch Logs group"); if (destinationArn && (!format || !/\$context\.(?:requestId|extendedRequestId)\b/.test(format))) throw new AwsError("BadRequestException", "Access log format must include $context.requestId or $context.extendedRequestId"); }
  }
  private stageSettingPath(path: string): { key: string; property: keyof ApiMethodSettingState } | undefined {
    const parts = path.split("/").slice(1); if (parts.length < 4) return undefined; const suffix = parts.slice(-2).join("/"); const properties: Record<string, keyof ApiMethodSettingState> = { "metrics/enabled": "metricsEnabled", "logging/loglevel": "loggingLevel", "logging/dataTrace": "dataTraceEnabled", "throttling/burstLimit": "throttlingBurstLimit", "throttling/rateLimit": "throttlingRateLimit", "caching/enabled": "cachingEnabled", "caching/ttlInSeconds": "cacheTtlInSeconds", "caching/dataEncrypted": "cacheDataEncrypted", "caching/requireAuthorizationForCacheControl": "requireAuthorizationForCacheControl", "caching/unauthorizedCacheControlHeaderStrategy": "unauthorizedCacheControlHeaderStrategy" }; const property = properties[suffix]; if (!property) return undefined; const resource = parts.slice(0, -3).join("/").replace(/~1/g, "/").replace(/~0/g, "~"); const method = parts.at(-3)!.replace(/~1/g, "/").replace(/~0/g, "~").toUpperCase(); const normalizedResource = resource === "*" || resource.startsWith("/") ? resource : `/${resource}`; const key = normalizedResource === "*" ? `*/${method}` : normalizedResource === "/" ? `/${method}` : `${normalizedResource}/${method}`; return { key, property };
  }
  private applyStagePatch(stage: ApiStageState, operations: any[]): void {
    for (const operation of operations ?? []) { const path = String(operation.path ?? ""); if (!["add", "replace", "remove", "copy"].includes(operation.op)) throw new AwsError("BadRequestException", `Invalid patch operation: ${operation.op}`); const methodPath = this.stageSettingPath(path); if (methodPath) { const setting = stage.methodSettings![methodPath.key] ??= {}; if (operation.op === "remove") delete setting[methodPath.property]; else { let value = operation.op === "copy" ? (() => { const source = this.stageSettingPath(String(operation.from ?? "")); if (!source) throw new AwsError("BadRequestException", "Invalid method setting copy source"); return stage.methodSettings?.[source.key]?.[source.property]; })() : patchValue(operation.value); if (["throttlingBurstLimit", "throttlingRateLimit", "cacheTtlInSeconds"].includes(methodPath.property) && value !== undefined) value = Number(value); (setting as any)[methodPath.property] = value; } if (!Object.keys(setting).length) delete stage.methodSettings![methodPath.key]; continue; }
      const allowed = new Set(["/deploymentId", "/description", "/documentationVersion", "/clientCertificateId", "/variables", "/tracingEnabled", "/accessLogSettings", "/cacheClusterEnabled", "/cacheClusterSize", "/canarySettings"]); this.applyPatch(stage, [operation], allowed);
    }
    if (stage.canarySettings?.percentTraffic !== undefined) stage.canarySettings.percentTraffic = Number(stage.canarySettings.percentTraffic);
  }
  private methodSettingKey(resourcePath: string, method: string): string { return resourcePath === "/" ? `/${method}` : `${resourcePath}/${method}`; }
  private methodSetting(stage: ApiStageState, resourcePath: string, method: string): ApiMethodSettingState { return { ...(stage.methodSettings?.["*/*"] ?? {}), ...(stage.methodSettings?.[`*/${method}`] ?? {}), ...(stage.methodSettings?.[this.methodSettingKey(resourcePath, "*")] ?? {}), ...(stage.methodSettings?.[this.methodSettingKey(resourcePath, method)] ?? {}) }; }
  private methodCacheEnabled(stage: ApiStageState, resourcePath: string, method: string, setting: ApiMethodSettingState, canary: boolean): boolean {
    if (!stage.cacheClusterEnabled || !setting.cachingEnabled || (setting.cacheTtlInSeconds ?? 300) <= 0 || canary && !stage.canarySettings?.useStageCache) return false;
    if (method === "GET") return true;
    const overrides = [stage.methodSettings?.[`*/${method}`], stage.methodSettings?.[this.methodSettingKey(resourcePath, "*")], stage.methodSettings?.[this.methodSettingKey(resourcePath, method)]];
    let explicitlyEnabled: boolean | undefined;
    for (const override of overrides) if (override?.cachingEnabled !== undefined) explicitlyEnabled = override.cachingEnabled;
    return explicitlyEnabled === true;
  }
  private cacheParameterValue(parameter: string, input: InvocationInput, mapped: { headers: Record<string, string>; query: Record<string, string>; path: Record<string, string> }): string {
    const parts = parameter.split("."); const scope = parts[0]; const location = parts[2]; const name = parts.slice(3).join("."); const source = scope === "integration" ? mapped : { headers: input.headers, query: input.query, path: input.pathParameters };
    if (location === "header") return source.headers[name.toLowerCase()] ?? "";
    if (location === "querystring") return source.query[name] ?? "";
    if (location === "path") return source.path[name] ?? "";
    return "";
  }
  private responseCacheKey(resource: ApiResource, method: ApiMethodState, configuredMethod: string, integration: ApiIntegrationState, input: InvocationInput, mapped: { headers: Record<string, string>; query: Record<string, string>; path: Record<string, string> }, principalId?: string, apiKeyId?: string, bearerDigest?: string): string {
    const identity = method.authorizationType === "AWS_IAM" ? input.principal : method.authorizationType === "CUSTOM" ? principalId : undefined;
    const value = { deploymentId: input.deploymentId, method: configuredMethod, namespace: integration.cacheNamespace ?? resource.id, parameters: (integration.cacheKeyParameters ?? []).map(parameter => [parameter, this.cacheParameterValue(parameter, input, mapped)]), identity, bearerDigest: method.authorizationType === "COGNITO_USER_POOLS" ? bearerDigest : undefined, apiKeyId: method.apiKeyRequired ? apiKeyId : undefined };
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  private cacheControl(input: InvocationInput, setting: ApiMethodSettingState, methodArn: string): { invalidate: boolean; warning?: string } {
    if (!/(?:^|,)\s*max-age\s*=\s*0(?:\s*(?:,|$))/i.test(input.headers["cache-control"] ?? "")) return { invalidate: false };
    if (!setting.requireAuthorizationForCacheControl) return { invalidate: true };
    const principal = input.principalContext; const context = { "aws:PrincipalArn": principal?.principalArn, "aws:PrincipalAccount": principal?.accountId, "aws:RequestedRegion": this.region, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:SourceIp": input.sourceIp, "aws:UserAgent": input.userAgent ?? "", "aws:SecureTransport": false };
    const authorized = principal && principal.accountId === this.store.accountId && evaluateAuthorization(this.store.ensureAccount().iam, principal, "execute-api:InvalidateCache", methodArn, context).decision === "allowed";
    if (authorized) return { invalidate: true };
    const strategy = setting.unauthorizedCacheControlHeaderStrategy ?? "SUCCEED_WITH_RESPONSE_HEADER";
    if (strategy === "FAIL_WITH_403") throw new GatewayFailure("ACCESS_DENIED", "AccessDeniedException", "User is not authorized to invalidate the API cache", 403);
    return { invalidate: false, ...(strategy === "SUCCEED_WITH_RESPONSE_HEADER" ? { warning: '199 - "The Cache-Control header was not honored because the caller is not authorized to invalidate this cache entry"' } : {}) };
  }
  private cacheBinding(apiId: string, stageName: string, cacheKey: string, entry: Pick<ApiGatewayResponseCacheEntryState, "deploymentId" | "method" | "namespace">): ApiGatewayCacheBinding { return { accountId: this.store.accountId, region: this.region, apiId, stageName, cacheKey, deploymentId: entry.deploymentId, method: entry.method, namespace: entry.namespace }; }
  private cachedPipelineResult(response: ApiGatewayCachedResponseState, started: number, warning?: string): PipelineResult { return { status: response.status, body: Buffer.from(response.body, "base64"), headers: { ...response.headers, ...(warning ? { Warning: warning } : {}) }, latency: performance.now() - started, integrationLatency: 0, log: "Response served from the API Gateway stage cache", cacheStatus: "hit" }; }
  private consumeBucket(key: string, rate: number | undefined, burst: number | undefined): boolean { if (rate === undefined || burst === undefined) return true; if (burst <= 0) return false; const now = this.clock.now(); const bucket = this.throttleBuckets.get(key) ?? { tokens: burst, updatedAt: now }; bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.updatedAt) * Math.max(0, rate) / 1_000); bucket.updatedAt = now; if (bucket.tokens < 1) { this.throttleBuckets.set(key, bucket); return false; } bucket.tokens -= 1; this.throttleBuckets.set(key, bucket); return true; }
  private enforceThrottle(api: RestApiState, stage: ApiStageState, resource: ApiResource, method: string): void { if (!this.consumeBucket("account", this.accountRateLimit, this.accountBurstLimit)) throw new GatewayFailure("THROTTLED", "TooManyRequestsException", "Too Many Requests", 429); const stageSetting = stage.methodSettings?.["*/*"] ?? {}; const methodSetting = { ...(stage.methodSettings?.[`*/${method}`] ?? {}), ...(stage.methodSettings?.[this.methodSettingKey(resource.path, "*")] ?? {}), ...(stage.methodSettings?.[this.methodSettingKey(resource.path, method)] ?? {}) }; if (!this.consumeBucket(`stage:${api.id}:${stage.stageName}`, stageSetting.throttlingRateLimit, stageSetting.throttlingBurstLimit) || !this.consumeBucket(`method:${api.id}:${stage.stageName}:${resource.path}:${method}`, methodSetting.throttlingRateLimit, methodSetting.throttlingBurstLimit)) throw new GatewayFailure("THROTTLED", "TooManyRequestsException", "Too Many Requests", 429); }
  private chooseCanary(api: RestApiState, stage: ApiStageState): { snapshot: ApiDeploymentSnapshot; deploymentId: string; variables: Record<string, string>; canary: boolean } { const percent = stage.canarySettings?.percentTraffic ?? 0; const canaryId = stage.canarySettings?.deploymentId; let canary = false; if (canaryId && percent > 0) { const key = `${api.id}:${stage.stageName}`; const next = (this.canaryCounters.get(key) ?? 0) + percent; canary = next >= 100; this.canaryCounters.set(key, next % 100); } const deploymentId = canary ? canaryId! : stage.deploymentId; const snapshot = api.deployments[deploymentId]?.snapshot; if (!snapshot) throw new AwsError("InternalServerErrorException", "Stage deployment is missing", 500); return { snapshot, deploymentId, canary, variables: canary ? { ...(stage.variables ?? {}), ...(stage.canarySettings?.stageVariableOverrides ?? {}) } : { ...(stage.variables ?? {}) } }; }
  private invocationConfiguration(api: RestApiState, snapshot?: ApiDeploymentSnapshot): InvocationConfiguration { return { binaryMediaTypes: structuredClone(snapshot ? snapshot.binaryMediaTypes ?? [] : api.binaryMediaTypes ?? []), minimumCompressionSize: snapshot ? snapshot.minimumCompressionSize : api.minimumCompressionSize, gatewayResponses: structuredClone(snapshot ? snapshot.gatewayResponses ?? {} : api.gatewayResponses ?? {}), models: structuredClone(snapshot ? snapshot.models ?? {} : api.models ?? {}), requestValidators: structuredClone(snapshot ? snapshot.requestValidators ?? {} : api.requestValidators ?? {}), apiKeySource: snapshot?.apiKeySource ?? api.apiKeySource ?? "HEADER" }; }

  private requireApiKey(keyId: string): ApiGatewayApiKeyState { const key = this.apiKeys[keyId]; if (!key) throw new AwsError("NotFoundException", "Invalid API Key identifier specified", 404); return key; }
  private requireUsagePlan(planId: string): ApiGatewayUsagePlanState { const plan = this.usagePlans[planId]; if (!plan) throw new AwsError("NotFoundException", "Invalid Usage Plan identifier specified", 404); return plan; }
  private validateApiKeyValue(value: string, ownId?: string): void { if (!/^[A-Za-z0-9]{20,128}$/.test(value)) throw new AwsError("BadRequestException", "API key values must contain 20 to 128 alphanumeric characters"); if (Object.values(this.apiKeys).some(key => key.id !== ownId && key.value === value)) throw new AwsError("ConflictException", "API key value already exists", 409); }
  private apiKeyStageKeys(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new AwsError("BadRequestException", "stageKeys must be an array"); return value.map((entry: any) => { const api = this.api(String(entry?.restApiId ?? "")); const stageName = String(entry?.stageName ?? ""); if (!api.stages[stageName]) throw new AwsError("BadRequestException", "stageKeys contains an invalid API stage"); return `${api.id}/${stageName}`; }); }
  private newApiKey(input: any): ApiGatewayApiKeyState { const value = input.value === undefined || input.value === "" ? id(40) : String(input.value); this.validateApiKeyValue(value); const name = input.name === undefined || input.name === "" ? undefined : String(input.name); if (name && Object.values(this.apiKeys).some(key => key.name === name)) throw new AwsError("ConflictException", "API key name already exists", 409); const now = this.clock.now(); return { id: id(20), value, name, customerId: input.customerId === undefined || input.customerId === "" ? undefined : String(input.customerId), description: input.description === undefined || input.description === "" ? undefined : String(input.description), enabled: input.enabled ?? false, createdDate: now, lastUpdatedDate: now, stageKeys: this.apiKeyStageKeys(input.stageKeys), tags: this.validateTags(input.tags) }; }
  private updateApiKey(key: ApiGatewayApiKeyState, operations: any[]): ApiGatewayApiKeyState { const candidate = structuredClone(key); const ordinary: any[] = []; for (const operation of operations ?? []) { if (operation.path !== "/stages") { ordinary.push(operation); continue; } const token = String(operation.value ?? ""); const separator = token.indexOf("/"); const apiId = separator < 0 ? "" : token.slice(0, separator); const stageName = separator < 0 ? "" : token.slice(separator + 1); const api = this.api(apiId); if (!stageName || !api.stages[stageName]) throw new AwsError("BadRequestException", `Invalid API key stage ${token}`); if (operation.op === "add") { if (!candidate.stageKeys.includes(token)) candidate.stageKeys.push(token); } else if (operation.op === "remove") candidate.stageKeys = candidate.stageKeys.filter(value => value !== token); else throw new AwsError("BadRequestException", "API key /stages supports only add and remove patch operations"); } this.applyPatch(candidate, ordinary, new Set(["/name", "/description", "/enabled", "/customerId", "/value"])); candidate.stageKeys = [...new Set(candidate.stageKeys)].sort(); if (candidate.name === "") delete candidate.name; if (candidate.description === "") delete candidate.description; if (candidate.customerId === "") delete candidate.customerId; candidate.enabled = Boolean(candidate.enabled); this.validateApiKeyValue(String(candidate.value), key.id); if (candidate.name && Object.values(this.apiKeys).some(value => value.id !== key.id && value.name === candidate.name)) throw new AwsError("ConflictException", "API key name already exists", 409); candidate.lastUpdatedDate = this.clock.now(); return candidate; }

  private parseCsv(body: string): string[][] { const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; for (let index = 0; index < body.length; index++) { const character = body[index]; if (quoted) { if (character === '"' && body[index + 1] === '"') { field += '"'; index++; } else if (character === '"') quoted = false; else field += character; } else if (character === '"') { if (field) throw new AwsError("BadRequestException", "Invalid quoted CSV field"); quoted = true; } else if (character === ",") { row.push(field); field = ""; } else if (character === "\n") { row.push(field.replace(/\r$/, "")); if (row.some(value => value !== "")) rows.push(row); row = []; field = ""; } else field += character; } if (quoted) throw new AwsError("BadRequestException", "Unterminated quoted CSV field"); row.push(field.replace(/\r$/, "")); if (row.some(value => value !== "")) rows.push(row); return rows; }

  private validateThrottle(value: ApiGatewayThrottleSettingsState | undefined, label = "throttle"): void { if (!value) return; if (value.burstLimit !== undefined) value.burstLimit = Number(value.burstLimit); if (value.rateLimit !== undefined) value.rateLimit = Number(value.rateLimit); if (value.burstLimit !== undefined && (!Number.isInteger(value.burstLimit) || value.burstLimit < 0)) throw new AwsError("BadRequestException", `${label}.burstLimit must be a non-negative integer`); if (value.rateLimit !== undefined && (!Number.isFinite(value.rateLimit) || value.rateLimit < 0)) throw new AwsError("BadRequestException", `${label}.rateLimit must be non-negative`); }
  private normalizeApiStages(value: unknown): ApiGatewayUsagePlanStageState[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new AwsError("BadRequestException", "apiStages must be an array"); const result = value.map((entry: any) => { const apiId = String(entry?.apiId ?? ""); const stage = String(entry?.stage ?? ""); const api = this.api(apiId); if (!stage || !api.stages[stage]) throw new AwsError("BadRequestException", `Invalid API stage ${apiId}:${stage}`); const throttle: Record<string, ApiGatewayThrottleSettingsState> = {}; for (const [key, settings] of Object.entries<any>(entry.throttle ?? {})) { if (!/^\/.*\/[A-Z]+$/.test(key)) throw new AwsError("BadRequestException", `Invalid method throttle key: ${key}`); const normalized = structuredClone(settings); this.validateThrottle(normalized, `apiStages throttle ${key}`); throttle[key] = normalized; } return { apiId, stage, ...(Object.keys(throttle).length ? { throttle } : {}) }; }); if (new Set(result.map(stage => `${stage.apiId}:${stage.stage}`)).size !== result.length) throw new AwsError("BadRequestException", "apiStages must not contain duplicates"); return result; }
  private quotaPeriodStart(period: "DAY" | "WEEK" | "MONTH", at: number): string { const date = new Date(at); date.setUTCHours(0, 0, 0, 0); if (period === "WEEK") date.setUTCDate(date.getUTCDate() - date.getUTCDay()); else if (period === "MONTH") date.setUTCDate(1); return date.toISOString().slice(0, 10); }
  private validateUsagePlan(plan: ApiGatewayUsagePlanState): void { if (!plan.name || plan.name.length > 1024) throw new AwsError("BadRequestException", "Usage plan name is required"); plan.apiStages = this.normalizeApiStages(plan.apiStages); this.validateThrottle(plan.throttle); if (plan.quota) { plan.quota.limit = Number(plan.quota.limit); plan.quota.offset = plan.quota.offset === undefined ? undefined : Number(plan.quota.offset); if (!Number.isInteger(plan.quota.limit) || plan.quota.limit <= 0) throw new AwsError("BadRequestException", "quota.limit must be a positive integer"); if (!new Set(["DAY", "WEEK", "MONTH"]).has(plan.quota.period)) throw new AwsError("BadRequestException", "quota.period must be DAY, WEEK, or MONTH"); if (plan.quota.offset !== undefined && (!Number.isInteger(plan.quota.offset) || plan.quota.offset < 0 || plan.quota.offset >= plan.quota.limit)) throw new AwsError("BadRequestException", "quota.offset must be a non-negative integer below the limit"); plan.initialQuotaPeriodStart ??= this.quotaPeriodStart(plan.quota.period, plan.createdDate); } plan.tags = this.validateTags(plan.tags); plan.keyIds ??= []; plan.usage ??= {}; plan.quotaExtensions ??= {}; this.validatePlanAssociationConflicts(plan); }
  private validatePlanAssociationConflicts(candidate: ApiGatewayUsagePlanState): void { const stages = new Set(candidate.apiStages.map(stage => `${stage.apiId}:${stage.stage}`)); for (const keyId of candidate.keyIds) for (const plan of Object.values(this.usagePlans)) if (plan.id !== candidate.id && plan.keyIds.includes(keyId) && plan.apiStages.some(stage => stages.has(`${stage.apiId}:${stage.stage}`))) throw new AwsError("ConflictException", "An API key can belong to only one usage plan for an API stage", 409); }
  private newUsagePlan(input: any): ApiGatewayUsagePlanState { const now = this.clock.now(); const plan: ApiGatewayUsagePlanState = { id: id(10), name: String(input.name ?? ""), description: input.description === undefined || input.description === "" ? undefined : String(input.description), apiStages: structuredClone(input.apiStages ?? []), throttle: input.throttle === undefined ? undefined : structuredClone(input.throttle), quota: input.quota === undefined ? undefined : structuredClone(input.quota), productCode: input.productCode === undefined || input.productCode === "" ? undefined : String(input.productCode), tags: structuredClone(input.tags ?? {}), keyIds: [], createdDate: now, usage: {}, quotaExtensions: {} }; this.validateUsagePlan(plan); return plan; }
  private usagePlanStage(plan: ApiGatewayUsagePlanState, token: string): ApiGatewayUsagePlanStageState { const separator = token.indexOf(":"); const apiId = separator < 0 ? "" : token.slice(0, separator); const stageName = separator < 0 ? "" : token.slice(separator + 1); const stage = plan.apiStages.find(value => value.apiId === apiId && value.stage === stageName); if (!stage) throw new AwsError("BadRequestException", `Invalid usage-plan API stage ${token}`); return stage; }
  private updateUsagePlan(plan: ApiGatewayUsagePlanState, operations: any[]): ApiGatewayUsagePlanState { const candidate = structuredClone(plan); for (const operation of operations ?? []) { const path = String(operation.path ?? ""); const parts = path.split("/").slice(1).map(part => part.replace(/~1/g, "/").replace(/~0/g, "~")); if (!["add", "replace", "remove", "copy"].includes(operation.op)) throw new AwsError("BadRequestException", `Invalid patch operation: ${operation.op}`); if (path === "/apiStages") { if (operation.op === "remove") candidate.apiStages = []; else if (Array.isArray(operation.value)) candidate.apiStages = structuredClone(operation.value); else if (operation.op === "add" && typeof operation.value === "string") { const [apiId, ...stage] = operation.value.split(":"); candidate.apiStages.push({ apiId, stage: stage.join(":") }); } else throw new AwsError("BadRequestException", "Invalid apiStages patch operation"); continue; } if (parts[0] === "apiStages" && parts[1]) { const token = parts[1]; if (parts.length === 2 && operation.op === "remove") { candidate.apiStages = candidate.apiStages.filter(value => `${value.apiId}:${value.stage}` !== token); continue; } const apiStage = this.usagePlanStage(candidate, token); if (parts[2] !== "throttle") throw new AwsError("BadRequestException", `Invalid usage plan patch path: ${path}`); if (parts.length === 3) { if (operation.op === "remove") delete apiStage.throttle; else apiStage.throttle = structuredClone(operation.value ?? {}); continue; } const property = parts.at(-1); if (!new Set(["rateLimit", "burstLimit"]).has(property!)) throw new AwsError("BadRequestException", `Invalid method throttle patch path: ${path}`); const method = parts.at(-2)!.toUpperCase(); const resourcePath = `/${parts.slice(3, -2).join("/")}`.replace(/^\/\//, "/"); const key = `${resourcePath}/${method}`; const throttle = apiStage.throttle ??= {}; const setting = throttle[key] ??= {}; if (operation.op === "remove") delete (setting as any)[property!]; else (setting as any)[property!] = Number(operation.value); if (!Object.keys(setting).length) delete throttle[key]; continue; } if (parts[0] === "throttle" && parts[1]) { candidate.throttle ??= {}; if (operation.op === "remove") delete (candidate.throttle as any)[parts[1]]; else (candidate.throttle as any)[parts[1]] = Number(operation.value); continue; } if (path === "/throttle") { if (operation.op === "remove") delete candidate.throttle; else candidate.throttle = structuredClone(operation.value ?? {}); continue; } if (parts[0] === "quota" && parts[1]) { candidate.quota ??= { limit: 1, period: "DAY" }; if (operation.op === "remove") delete (candidate.quota as any)[parts[1]]; else (candidate.quota as any)[parts[1]] = parts[1] === "period" ? String(operation.value) : Number(operation.value); continue; } if (path === "/quota") { if (operation.op === "remove") delete candidate.quota; else candidate.quota = structuredClone(operation.value); continue; } this.applyPatch(candidate, [operation], new Set(["/name", "/description", "/productCode"])); }
    if (candidate.description === "") delete candidate.description; if (candidate.productCode === "") delete candidate.productCode; if (candidate.quota && (!plan.quota || candidate.quota.period !== plan.quota.period)) candidate.initialQuotaPeriodStart = this.quotaPeriodStart(candidate.quota.period, this.clock.now()); this.validateUsagePlan(candidate); return candidate; }

  private parseUsageDate(value: string | null, label: string): number { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AwsError("BadRequestException", `${label} must use YYYY-MM-DD`); const at = Date.parse(`${value}T00:00:00.000Z`); if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new AwsError("BadRequestException", `${label} is invalid`); return at; }
  private usageDates(start: number, end: number): string[] { if (end < start) throw new AwsError("BadRequestException", "endDate must not precede startDate"); if (end - start > 366 * 86_400_000) throw new AwsError("BadRequestException", "Usage date range cannot exceed 366 days"); const dates: string[] = []; for (let at = start; at <= end; at += 86_400_000) dates.push(new Date(at).toISOString().slice(0, 10)); return dates; }
  private usageInPeriod(plan: ApiGatewayUsagePlanState, keyId: string, date: string): number { if (!plan.quota) return 0; const period = this.quotaPeriodStart(plan.quota.period, Date.parse(`${date}T00:00:00.000Z`)); return Object.entries(plan.usage[keyId] ?? {}).filter(([day]) => day <= date && this.quotaPeriodStart(plan.quota!.period, Date.parse(`${day}T00:00:00.000Z`)) === period).reduce((sum, [, used]) => sum + used, 0); }
  private effectiveQuota(plan: ApiGatewayUsagePlanState, keyId: string, date: string): number | undefined { if (!plan.quota) return undefined; const period = this.quotaPeriodStart(plan.quota.period, Date.parse(`${date}T00:00:00.000Z`)); const override = plan.quotaExtensions[keyId]?.[period]; if (override !== undefined) return override; return Math.max(0, plan.quota.limit - (period === plan.initialQuotaPeriodStart ? plan.quota.offset ?? 0 : 0)); }
  private usageResponse(plan: ApiGatewayUsagePlanState, keyIds: string[], startDate: string, endDate: string, url?: URL): any { const dates = this.usageDates(this.parseUsageDate(startDate, "startDate"), this.parseUsageDate(endDate, "endDate")); let selected = keyIds; let position: string | undefined; if (url) { const page = this.page("GetUsage", `${plan.id}:${startDate}:${endDate}:${keyIds.join(",")}`, keyIds, url); selected = page.item; position = page.position; } const values = Object.fromEntries(selected.map(keyId => [keyId, dates.map(date => { const used = plan.usage[keyId]?.[date] ?? 0; const limit = this.effectiveQuota(plan, keyId, date); return [used, limit === undefined ? -1 : Math.max(0, limit - this.usageInPeriod(plan, keyId, date))]; })])); return { usagePlanId: plan.id, startDate, endDate, values, ...(position ? { position } : {}) }; }

  private methodUsageThrottle(stage: ApiGatewayUsagePlanStageState, resourcePath: string, method: string): ApiGatewayThrottleSettingsState | undefined { return stage.throttle?.[`${resourcePath}/${method}`] ?? stage.throttle?.[`${resourcePath}/*`] ?? stage.throttle?.[`*/${method}`] ?? stage.throttle?.["*/*"]; }
  private async enforceApiKey(api: RestApiState, resource: ApiResource, method: ApiMethodState, methodName: string, input: InvocationInput, source: "HEADER" | "AUTHORIZER", usageIdentifierKey?: string): Promise<ApiGatewayApiKeyState | undefined> { if (!method.apiKeyRequired || input.stageName === "test-invoke-stage") return undefined; const supplied = source === "AUTHORIZER" ? usageIdentifierKey : input.headers["x-api-key"]; const key = supplied ? Object.values(this.apiKeys).find(candidate => candidate.value === supplied) : undefined; if (!key?.enabled) throw new GatewayFailure("INVALID_API_KEY", "ForbiddenException", "Forbidden", 403); const plans = Object.values(this.usagePlans).filter(plan => plan.keyIds.includes(key.id) && plan.apiStages.some(stage => stage.apiId === api.id && stage.stage === input.stageName)); if (plans.length !== 1) throw new GatewayFailure("INVALID_API_KEY", "ForbiddenException", "Forbidden", 403); const plan = plans[0]; const apiStage = plan.apiStages.find(stage => stage.apiId === api.id && stage.stage === input.stageName)!; const methodThrottle = this.methodUsageThrottle(apiStage, resource.path, methodName); if (!this.consumeBucket(`usage-plan:${plan.id}:${key.id}`, plan.throttle?.rateLimit, plan.throttle?.burstLimit) || !this.consumeBucket(`usage-method:${plan.id}:${key.id}:${api.id}:${input.stageName}:${resource.path}:${methodName}`, methodThrottle?.rateLimit, methodThrottle?.burstLimit)) throw new GatewayFailure("THROTTLED", "TooManyRequestsException", "Too Many Requests", 429); const today = new Date(this.clock.now()).toISOString().slice(0, 10); const limit = this.effectiveQuota(plan, key.id, today); if (limit !== undefined && this.usageInPeriod(plan, key.id, today) >= limit) throw new GatewayFailure("QUOTA_EXCEEDED", "LimitExceededException", "Limit Exceeded", 429); const usage = plan.usage[key.id] ??= {}; usage[today] = (usage[today] ?? 0) + 1; input.apiKeyId = key.id; input.apiKeyValue = key.value; await this.store.save(); return key; }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    try {
      if (pathname === "/account") {
        if (req.method === "GET") return json(res, this.accountView());
        if (req.method === "PATCH") { const input = await readJson(req); const candidate = structuredClone(this.account); this.applyPatch(candidate, input.patchOperations, new Set(["/cloudwatchRoleArn"])); if (candidate.cloudwatchRoleArn) this.validateIntegrationRole(candidate.cloudwatchRoleArn); this.replaceObject(this.account, candidate); await this.store.save(); return json(res, this.accountView()); }
      }
      if (pathname.startsWith("/tags/")) {
        let resourceArn: string; try { resourceArn = decodeURIComponent(pathname.slice("/tags/".length)); } catch { throw new AwsError("BadRequestException", "Invalid resource ARN"); }
        const target = this.taggedResource(resourceArn);
        if (req.method === "GET") return json(res, { tags: { ...target.tags } });
        if (req.method === "PUT") { const input = await readJson(req); target.assign(this.validateTags({ ...target.tags, ...(input.tags ?? {}) })); await this.store.save(); res.statusCode = 204; res.end(); return; }
        if (req.method === "DELETE") { const keys = [...url.searchParams.getAll("tagKeys"), ...[...url.searchParams].filter(([key]) => /^tagKeys(?:\.member)?\.\d+$/.test(key)).map(([, value]) => value)]; const tags = { ...target.tags }; for (const key of keys) delete tags[key]; target.assign(tags); await this.store.save(); res.statusCode = 204; res.end(); return; }
      }
      if (pathname === "/domainnames" && req.method === "POST") { const domain = this.createDomainName(await readJson(req)); this.domainNames[domain.domainName] = domain; await this.store.save(); return json(res, domainNameView(domain), 201); }
      if (pathname === "/domainnames" && req.method === "GET") { const owner = url.searchParams.get("resourceOwner") ?? "SELF"; if (!new Set(["SELF", "OTHER_ACCOUNTS"]).has(owner)) throw new AwsError("BadRequestException", "resourceOwner must be SELF or OTHER_ACCOUNTS"); const values = owner === "OTHER_ACCOUNTS" ? [] : Object.values(this.domainNames).sort((left, right) => left.domainName.localeCompare(right.domainName)).map(domainNameView); return json(res, this.page("GetDomainNames", owner, values, url)); }
      if (pathname === "/domainnameaccessassociations" && req.method === "POST") { const input = await readJson(req); const domain = Object.values(this.domainNames).find(candidate => candidate.domainNameArn === input.domainNameArn); if (!domain || domain.endpointConfiguration.types[0] !== "PRIVATE") throw new AwsError("NotFoundException", "The private domain name ARN was not found", 404); if (input.accessAssociationSourceType !== "VPCE" || !/^vpce-[a-z0-9]+$/.test(String(input.accessAssociationSource ?? ""))) throw new AwsError("BadRequestException", "A VPCE access association source is required"); if (Object.values(this.domainNameAccessAssociations).some(candidate => candidate.domainNameArn === domain.domainNameArn && candidate.accessAssociationSource === input.accessAssociationSource)) throw new AwsError("ConflictException", "The domain name access association already exists", 409); const source = String(input.accessAssociationSource); const arn = `arn:aws:apigateway:${this.region}:${this.store.accountId}:/domainnameaccessassociations/domainname/${domain.domainName}+${domain.domainNameId}/vpcesource/${source}`; const association: ApiGatewayDomainNameAccessAssociationState = { domainNameAccessAssociationArn: arn, domainNameArn: domain.domainNameArn, accessAssociationSourceType: "VPCE", accessAssociationSource: source, tags: this.validateTags(input.tags), createdDate: this.clock.now() }; this.domainNameAccessAssociations[arn] = association; await this.store.save(); return json(res, domainNameAccessAssociationView(association), 201); }
      if (pathname === "/domainnameaccessassociations" && req.method === "GET") { const owner = url.searchParams.get("resourceOwner") ?? "SELF"; if (!new Set(["SELF", "OTHER_ACCOUNTS"]).has(owner)) throw new AwsError("BadRequestException", "resourceOwner must be SELF or OTHER_ACCOUNTS"); const values = owner === "OTHER_ACCOUNTS" ? [] : Object.values(this.domainNameAccessAssociations).sort((left, right) => left.domainNameAccessAssociationArn.localeCompare(right.domainNameAccessAssociationArn)).map(domainNameAccessAssociationView); return json(res, this.page("GetDomainNameAccessAssociations", owner, values, url)); }
      const accessAssociationMatch = pathname.match(/^\/domainnameaccessassociations\/(.+)$/); if (accessAssociationMatch && req.method === "DELETE") { let arn: string; try { arn = decodeURIComponent(accessAssociationMatch[1]); } catch { throw new AwsError("BadRequestException", "Invalid domain name access association ARN"); } if (!this.domainNameAccessAssociations[arn]) throw new AwsError("NotFoundException", "The domain name access association was not found", 404); delete this.domainNameAccessAssociations[arn]; await this.store.save(); res.statusCode = 202; res.end(); return; }
      if (pathname === "/rejectdomainnameaccessassociations" && req.method === "POST") { const arn = url.searchParams.get("domainNameAccessAssociationArn"); const domainArn = url.searchParams.get("domainNameArn"); const association = arn ? this.domainNameAccessAssociations[arn] : undefined; if (!association || association.domainNameArn !== domainArn) throw new AwsError("NotFoundException", "The domain name access association was not found", 404); delete this.domainNameAccessAssociations[arn!]; await this.store.save(); res.statusCode = 202; res.end(); return; }
      const domainPathMatch = pathname.match(/^\/domainnames\/([^/]+)(.*)$/); if (domainPathMatch) {
        let requestedName: string; try { requestedName = decodeURIComponent(domainPathMatch[1]); } catch { throw new AwsError("BadRequestException", "Invalid domain name"); } const domain = this.domainName(requestedName, url.searchParams.get("domainNameId")); const suffix = domainPathMatch[2];
        if (suffix === "" && req.method === "GET") return json(res, domainNameView(domain));
        if (suffix === "" && req.method === "PATCH") { const candidate = this.applyDomainPatch(domain, (await readJson(req)).patchOperations); this.domainNames[domain.domainName] = candidate; await this.store.save(); return json(res, domainNameView(candidate)); }
        if (suffix === "" && req.method === "DELETE") { delete this.domainNames[domain.domainName]; for (const [arn, association] of Object.entries(this.domainNameAccessAssociations)) if (association.domainNameArn === domain.domainNameArn) delete this.domainNameAccessAssociations[arn]; await this.store.save(); res.statusCode = 202; res.end(); return; }
        if (suffix === "/basepathmappings" && req.method === "POST") {
          const input = await readJson(req);
          const identity = this.cloudFormationCreateIdentity(req);
          const mapping: ApiGatewayBasePathMappingState = {
            basePath: this.normalizeBasePath(input.basePath),
            restApiId: String(input.restApiId ?? ""),
            stage: input.stage === undefined || input.stage === "" ? "(none)" : String(input.stage),
            ...identity,
          };
          this.validateBasePathMapping(mapping);
          const existing = domain.basePathMappings[mapping.basePath];
          if (existing) {
            if (identity) {
              this.assertCloudFormationReplay(identity, existing, "Base path mapping");
              if (existing.restApiId !== mapping.restApiId || existing.stage !== mapping.stage) {
                throw new AwsError(
                  "ConflictException",
                  "The CloudFormation operation token belongs to a base path mapping with different properties",
                  409,
                );
              }
              return json(res, basePathMappingView(existing), 201);
            }
            throw new AwsError("ConflictException", "The base path mapping already exists", 409);
          }
          domain.basePathMappings[mapping.basePath] = mapping;
          domain.lastUpdatedDate = this.clock.now();
          await this.store.save();
          return json(res, basePathMappingView(mapping), 201);
        }
        if (suffix === "/basepathmappings" && req.method === "GET") { const values = Object.values(domain.basePathMappings).sort((left, right) => left.basePath.localeCompare(right.basePath)).map(basePathMappingView); return json(res, this.page("GetBasePathMappings", `${domain.domainName}:${domain.domainNameId ?? ""}`, values, url)); }
        const mappingMatch = suffix.match(/^\/basepathmappings\/([^/]+)$/);
        if (mappingMatch) {
          let basePath: string;
          try { basePath = this.normalizeBasePath(decodeURIComponent(mappingMatch[1])); }
          catch (error) {
            if (error instanceof AwsError) throw error;
            throw new AwsError("BadRequestException", "Invalid base path");
          }
          const mapping = domain.basePathMappings[basePath];
          if (!mapping) throw new AwsError("NotFoundException", "Invalid base path mapping identifier specified", 404);
          this.assertCloudFormationOwner(req, mapping, "Base path mapping");
          if (req.method === "GET") return json(res, basePathMappingView(mapping));
          if (req.method === "DELETE") {
            delete domain.basePathMappings[basePath];
            domain.lastUpdatedDate = this.clock.now();
            await this.store.save();
            res.statusCode = 202;
            res.end();
            return;
          }
          if (req.method === "PATCH") {
            const candidate = structuredClone(mapping);
            this.applyPatch(candidate, (await readJson(req)).patchOperations, new Set(["/basePath", "/restApiId", "/stage"]));
            candidate.basePath = this.normalizeBasePath(candidate.basePath);
            candidate.restApiId = String(candidate.restApiId ?? "");
            candidate.stage = candidate.stage === undefined || candidate.stage === "" ? "(none)" : String(candidate.stage);
            if (candidate.basePath !== basePath && domain.basePathMappings[candidate.basePath]) throw new AwsError("ConflictException", "The base path mapping already exists", 409);
            this.validateBasePathMapping(candidate);
            delete domain.basePathMappings[basePath];
            domain.basePathMappings[candidate.basePath] = candidate;
            domain.lastUpdatedDate = this.clock.now();
            await this.store.save();
            return json(res, basePathMappingView(candidate));
          }
        }
        throw new AwsError("NotFoundException", "Unknown custom domain route", 404);
      }
      if (pathname === "/apikeys" && req.method === "POST" && url.searchParams.get("mode") === "import") {
        if (url.searchParams.get("format") !== "csv") throw new AwsError("BadRequestException", "Only CSV API key imports are supported"); const rows = this.parseCsv((await readBody(req)).toString("utf8").replace(/^\uFEFF/, "")); if (!rows.length) throw new AwsError("BadRequestException", "API key import is empty"); const headers = rows[0].map(value => value.trim().toLowerCase()); const nameIndex = headers.indexOf("name"); const keyIndex = headers.indexOf("key"); const descriptionIndex = headers.indexOf("description"); const enabledIndex = headers.indexOf("enabled"); if (nameIndex < 0 || keyIndex < 0 || descriptionIndex < 0 || enabledIndex < 0) throw new AwsError("BadRequestException", "CSV header must contain name,key,description,enabled"); const warnings: string[] = []; const imported: ApiGatewayApiKeyState[] = [];
        for (const [offset, row] of rows.slice(1).entries()) { const line = offset + 2; try { const enabled = String(row[enabledIndex] ?? "").trim().toLowerCase(); if (!["true", "false"].includes(enabled)) throw new AwsError("BadRequestException", "enabled must be true or false"); const key = this.newApiKey({ name: row[nameIndex]?.trim() || undefined, value: row[keyIndex]?.trim(), description: row[descriptionIndex]?.trim() || undefined, enabled: enabled === "true" }); if (imported.some(value => value.value === key.value || key.name && value.name === key.name)) throw new AwsError("ConflictException", "A duplicate name or value occurs in the import", 409); imported.push(key); } catch (error) { warnings.push(`Line ${line}: ${error instanceof Error ? error.message : String(error)}`); } }
        if (warnings.length && url.searchParams.get("failonwarnings") === "true") throw new AwsError("BadRequestException", warnings.join("; ")); for (const key of imported) this.apiKeys[key.id] = key; if (imported.length) await this.store.save(); return json(res, { ids: imported.map(key => key.id), ...(warnings.length ? { warnings } : {}) }, 201);
      }
      if (pathname === "/apikeys" && req.method === "POST") { const key = this.newApiKey(await readJson(req)); this.apiKeys[key.id] = key; await this.store.save(); return json(res, apiKeyView(key, true), 201); }
      if (pathname === "/apikeys" && req.method === "GET") { const nameQuery = url.searchParams.get("name"); const customerId = url.searchParams.get("customerId"); const includeValues = url.searchParams.get("includeValues") === "true"; const values = Object.values(this.apiKeys).filter(key => !nameQuery || key.name?.toLowerCase().includes(nameQuery.toLowerCase())).filter(key => !customerId || key.customerId === customerId).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map(key => apiKeyView(key, includeValues)); return json(res, this.page("GetApiKeys", `keys:${nameQuery ?? ""}:${customerId ?? ""}:${includeValues}`, values, url)); }
      const apiKeyMatch = pathname.match(/^\/apikeys\/([^/]+)$/); if (apiKeyMatch) { const key = this.requireApiKey(decodeURIComponent(apiKeyMatch[1])); if (req.method === "GET") return json(res, apiKeyView(key, url.searchParams.get("includeValue") === "true")); if (req.method === "PATCH") { const candidate = this.updateApiKey(key, (await readJson(req)).patchOperations); this.apiKeys[key.id] = candidate; await this.store.save(); return json(res, apiKeyView(candidate, true)); } if (req.method === "DELETE") { delete this.apiKeys[key.id]; for (const plan of Object.values(this.usagePlans)) plan.keyIds = plan.keyIds.filter(id => id !== key.id); await this.store.save(); res.statusCode = 202; res.end(); return; } }

      if (pathname === "/usageplans" && req.method === "POST") { const plan = this.newUsagePlan(await readJson(req)); this.usagePlans[plan.id] = plan; await this.store.save(); return json(res, usagePlanView(plan), 201); }
      if (pathname === "/usageplans" && req.method === "GET") { const keyId = url.searchParams.get("keyId"); if (keyId) this.requireApiKey(keyId); const values = Object.values(this.usagePlans).filter(plan => !keyId || plan.keyIds.includes(keyId)).sort((a, b) => a.name.localeCompare(b.name)).map(usagePlanView); return json(res, this.page("GetUsagePlans", `plans:${keyId ?? ""}`, values, url)); }
      const updateUsageMatch = pathname.match(/^\/usageplans\/([^/]+)\/keys\/([^/]+)\/usage$/); if (updateUsageMatch && req.method === "PATCH") { const plan = this.requireUsagePlan(decodeURIComponent(updateUsageMatch[1])); const key = this.requireApiKey(decodeURIComponent(updateUsageMatch[2])); if (!plan.keyIds.includes(key.id)) throw new AwsError("NotFoundException", "The API key is not associated with this usage plan", 404); if (!plan.quota) throw new AwsError("BadRequestException", "A quota is required before remaining usage can be updated"); const operations = (await readJson(req)).patchOperations ?? []; if (operations.length !== 1 || operations[0].op !== "replace" || operations[0].path !== "/remaining") throw new AwsError("BadRequestException", "UpdateUsage supports replace /remaining"); const remaining = Number(operations[0].value); if (!Number.isInteger(remaining) || remaining < 0) throw new AwsError("BadRequestException", "remaining must be a non-negative integer"); const today = new Date(this.clock.now()).toISOString().slice(0, 10); const period = this.quotaPeriodStart(plan.quota.period, this.clock.now()); (plan.quotaExtensions[key.id] ??= {})[period] = this.usageInPeriod(plan, key.id, today) + remaining; await this.store.save(); return json(res, this.usageResponse(plan, [key.id], today, today)); }
      const getUsageMatch = pathname.match(/^\/usageplans\/([^/]+)\/usage$/); if (getUsageMatch && req.method === "GET") { const plan = this.requireUsagePlan(decodeURIComponent(getUsageMatch[1])); const startDate = url.searchParams.get("startDate") ?? ""; const endDate = url.searchParams.get("endDate") ?? ""; const keyId = url.searchParams.get("keyId"); if (keyId && !plan.keyIds.includes(keyId)) throw new AwsError("NotFoundException", "The API key is not associated with this usage plan", 404); return json(res, this.usageResponse(plan, keyId ? [keyId] : plan.keyIds.filter(id => this.apiKeys[id]), startDate, endDate, url)); }
      const usagePlanKeysMatch = pathname.match(/^\/usageplans\/([^/]+)\/keys$/); if (usagePlanKeysMatch) { const plan = this.requireUsagePlan(decodeURIComponent(usagePlanKeysMatch[1])); if (req.method === "POST") { const input = await readJson(req); if (input.keyType !== "API_KEY") throw new AwsError("BadRequestException", "keyType must be API_KEY"); const key = this.requireApiKey(String(input.keyId ?? "")); if (plan.keyIds.includes(key.id)) throw new AwsError("ConflictException", "The API key is already associated with this usage plan", 409); const candidate = structuredClone(plan); candidate.keyIds.push(key.id); this.validatePlanAssociationConflicts(candidate); plan.keyIds.push(key.id); await this.store.save(); return json(res, usagePlanKeyView(key), 201); } if (req.method === "GET") { const nameQuery = url.searchParams.get("name"); const values = plan.keyIds.map(id => this.apiKeys[id]).filter((key): key is ApiGatewayApiKeyState => Boolean(key)).filter(key => !nameQuery || key.name?.toLowerCase().includes(nameQuery.toLowerCase())).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map(usagePlanKeyView); return json(res, this.page("GetUsagePlanKeys", `${plan.id}:${nameQuery ?? ""}`, values, url)); } }
      const usagePlanKeyMatch = pathname.match(/^\/usageplans\/([^/]+)\/keys\/([^/]+)$/); if (usagePlanKeyMatch) { const plan = this.requireUsagePlan(decodeURIComponent(usagePlanKeyMatch[1])); const key = this.requireApiKey(decodeURIComponent(usagePlanKeyMatch[2])); if (!plan.keyIds.includes(key.id)) throw new AwsError("NotFoundException", "The API key is not associated with this usage plan", 404); if (req.method === "GET") return json(res, usagePlanKeyView(key)); if (req.method === "DELETE") { plan.keyIds = plan.keyIds.filter(id => id !== key.id); await this.store.save(); res.statusCode = 202; res.end(); return; } }
      const usagePlanMatch = pathname.match(/^\/usageplans\/([^/]+)$/); if (usagePlanMatch) { const plan = this.requireUsagePlan(decodeURIComponent(usagePlanMatch[1])); if (req.method === "GET") return json(res, usagePlanView(plan)); if (req.method === "PATCH") { const candidate = this.updateUsagePlan(plan, (await readJson(req)).patchOperations); this.usagePlans[plan.id] = candidate; await this.store.save(); return json(res, usagePlanView(candidate)); } if (req.method === "DELETE") { delete this.usagePlans[plan.id]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (pathname === "/vpclinks" && req.method === "POST") { const input = await readJson(req); const name = String(input.name ?? "").trim(); if (!name || name.length > 128) throw new AwsError("BadRequestException", "VpcLink name is required and must not exceed 128 characters"); if (Object.values(this.vpcLinks).some(link => link.name === name)) throw new AwsError("ConflictException", "A VpcLink with this name already exists", 409); const link: ApiGatewayVpcLinkState = { id: id(10), name, description: input.description, targetArns: this.validateVpcLinkTargetArns(input.targetArns), status: "PENDING", tags: this.validateTags(input.tags), createdDate: this.clock.now() }; const origin = this.vpcLinkOrigin(link); link.status = origin ? "AVAILABLE" : "FAILED"; link.statusMessage = origin ? "Local origin mapping is configured." : "No local origin mapping is configured for this VPC link target."; this.vpcLinks[link.id] = link; await this.store.save(); return json(res, vpcLinkView(link), 202); }
      if (pathname === "/vpclinks" && req.method === "GET") return json(res, this.page("GetVpcLinks", this.region, Object.values(this.vpcLinks).sort((a, b) => a.name.localeCompare(b.name)).map(vpcLinkView), url));
      const vpcLinkMatch = pathname.match(/^\/vpclinks\/([^/]+)$/); if (vpcLinkMatch) { const link = this.vpcLink(decodeURIComponent(vpcLinkMatch[1])); if (req.method === "GET") return json(res, vpcLinkView(link)); if (req.method === "PATCH") { const input = await readJson(req); const candidate = structuredClone(link); this.applyPatch(candidate, input.patchOperations, new Set(["/name", "/description", "/targetArns"])); candidate.name = String(candidate.name ?? "").trim(); if (!candidate.name || candidate.name.length > 128 || Object.values(this.vpcLinks).some(value => value.id !== link.id && value.name === candidate.name)) throw new AwsError("ConflictException", "VpcLink name is invalid or already exists", 409); candidate.targetArns = this.validateVpcLinkTargetArns(candidate.targetArns); const origin = this.vpcLinkOrigin(candidate); candidate.status = origin ? "AVAILABLE" : "FAILED"; candidate.statusMessage = origin ? "Local origin mapping is configured." : "No local origin mapping is configured for this VPC link target."; this.vpcLinks[link.id] = candidate; await this.store.save(); return json(res, vpcLinkView(candidate)); } if (req.method === "DELETE") { const referenced = Object.values(this.apis).some(api => Object.values(api.resources ?? {}).some(resource => Object.values(resource.integrations ?? {}).some(integration => integration.connectionType === "VPC_LINK" && integration.connectionId === link.id)) || Object.values(api.deployments ?? {}).some(deployment => Object.values(deployment.snapshot?.resources ?? {}).some(resource => Object.values(resource.integrations ?? {}).some(integration => integration.connectionType === "VPC_LINK" && integration.connectionId === link.id)))); if (referenced) throw new AwsError("ConflictException", "The VpcLink is referenced by an integration or deployment", 409); delete this.vpcLinks[link.id]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (pathname === "/clientcertificates" && req.method === "POST") { if (!this.allowClientCertificates) throw new AwsError("BadRequestException", "Local self-signed client-certificate generation requires explicit opt-in"); const input = await readJson(req); const certificateId = id(10); const createdDate = this.clock.now(); const generated = createSelfSignedClientCertificate(`stacksim-apigateway-${certificateId}`, createdDate); const certificate: ApiGatewayClientCertificateState = { clientCertificateId: certificateId, description: input.description, pemEncodedCertificate: generated.certificate, createdDate, expirationDate: generated.expirationDate, tags: this.validateTags(input.tags) }; this.clientCertificates[certificateId] = certificate; await this.store.save(); return json(res, clientCertificateView(certificate), 201); }
      if (pathname === "/clientcertificates" && req.method === "GET") return json(res, this.page("GetClientCertificates", this.region, Object.values(this.clientCertificates).sort((a, b) => a.createdDate - b.createdDate).map(clientCertificateView), url));
      const clientCertificateMatch = pathname.match(/^\/clientcertificates\/([^/]+)$/); if (clientCertificateMatch) { const certificate = this.clientCertificate(decodeURIComponent(clientCertificateMatch[1])); if (req.method === "GET") return json(res, clientCertificateView(certificate)); if (req.method === "PATCH") { const input = await readJson(req); this.applyPatch(certificate, input.patchOperations, new Set(["/description"])); await this.store.save(); return json(res, clientCertificateView(certificate)); } if (req.method === "DELETE") { if (Object.values(this.apis).some(api => Object.values(api.stages ?? {}).some(stage => stage.clientCertificateId === certificate.clientCertificateId))) throw new AwsError("ConflictException", "The client certificate is associated with a stage", 409); delete this.clientCertificates[certificate.clientCertificateId]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (pathname === "/sdktypes" && req.method === "GET") return json(res, this.page("GetSdkTypes", this.region, SDK_TYPES.map(value => structuredClone(value)), url));
      const sdkTypeMatch = pathname.match(/^\/sdktypes\/([^/]+)$/); if (sdkTypeMatch && req.method === "GET") return json(res, structuredClone(this.sdkType(decodeURIComponent(sdkTypeMatch[1]))));
      if (pathname === "/restapis" && req.method === "POST" && url.searchParams.get("mode") === "import") { const body = await readBody(req); let document: Record<string, any>; try { document = parseOpenApiDocument(body); } catch (error) { throw new AwsError("BadRequestException", error instanceof Error ? error.message : String(error)); } const apiId = id(10); const rootId = id(10); const base: RestApiState = { id: apiId, name: String(document.info?.title ?? "Imported API"), description: document.info?.description, tags: {}, version: document.info?.version === undefined ? undefined : String(document.info.version), binaryMediaTypes: [], gatewayResponses: {}, apiKeySource: "HEADER", createdDate: this.clock.now(), rootResourceId: rootId, resources: { [rootId]: { id: rootId, path: "/", methods: {}, integrations: {} } }, deployments: {}, stages: {}, authorizers: {}, models: defaultApiModels(), requestValidators: {}, documentationParts: {}, documentationVersions: {} }; let imported; try { imported = applyOpenApiDocument(base, document, "overwrite", this.importParameters(url)); this.applyImportedDocumentation(imported.api, document, "overwrite", imported.warnings); this.validateImportedApi(imported.api); } catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("BadRequestException", error instanceof Error ? error.message : String(error)); } if (url.searchParams.get("failonwarnings") === "true" && imported.warnings.length) throw new AwsError("BadRequestException", imported.warnings.join("; ")); this.apis[apiId] = imported.api; await this.store.save(); return json(res, apiView(imported.api, imported.warnings), 201); }
      if (pathname === "/restapis" && req.method === "POST") { const input = await readJson(req); if (!input.name) throw new AwsError("BadRequestException", "name is required"); const apiId = id(10); const rootId = id(10); const api: RestApiState = { id: apiId, name: input.name, description: input.description, tags: this.validateTags(input.tags), policy: parsePolicy(input.policy), binaryMediaTypes: input.binaryMediaTypes ?? [], minimumCompressionSize: input.minimumCompressionSize, gatewayResponses: {}, apiKeySource: input.apiKeySource ?? "HEADER", createdDate: this.clock.now(), rootResourceId: rootId, resources: {}, deployments: {}, stages: {}, authorizers: {}, models: defaultApiModels(), requestValidators: {}, documentationParts: {}, documentationVersions: {} }; this.validateRestApiSettings(api); api.resources[rootId] = { id: rootId, path: "/", methods: {}, integrations: {} }; this.apis[apiId] = api; await this.store.save(); return json(res, apiView(api), 201); }
      if (pathname === "/restapis" && req.method === "GET") return json(res, { item: Object.values(this.apis).map(api => apiView(api)) });
      const root = pathname.match(/^\/restapis\/([^/]+)(.*)$/); if (!root) throw new AwsError("NotFoundException", "Unknown API Gateway route", 404); const api = this.api(root[1]); const suffix = root[2];
      if (suffix === "" && req.method === "GET") return json(res, apiView(api)); if (suffix === "" && req.method === "DELETE") { delete this.apis[api.id]; for (const plan of Object.values(this.usagePlans)) plan.apiStages = plan.apiStages.filter(stage => stage.apiId !== api.id); for (const key of Object.keys(this.responseCaches)) if (key.startsWith(`${api.id}\0`)) delete this.responseCaches[key]; for (const domain of Object.values(this.domainNames)) for (const [basePath, mapping] of Object.entries(domain.basePathMappings)) if (mapping.restApiId === api.id) delete domain.basePathMappings[basePath]; await this.store.save(); res.statusCode = 202; res.end(); return; }
      if (suffix === "" && req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(api); this.applyRestApiPatch(updated, input.patchOperations); if (typeof (updated as any).policy === "string") updated.policy = parsePolicy((updated as any).policy); this.validateRestApiSettings(updated); this.replaceObject(api, updated); await this.store.save(); return json(res, apiView(api)); }
      if (suffix === "" && req.method === "PUT") { const body = await readBody(req); const mode = url.searchParams.get("mode") ?? "merge"; if (!["merge", "overwrite"].includes(mode)) throw new AwsError("BadRequestException", "mode must be merge or overwrite"); let document: Record<string, any>; let imported; try { document = parseOpenApiDocument(body); imported = applyOpenApiDocument(api, document, mode as "merge" | "overwrite", this.importParameters(url)); this.applyImportedDocumentation(imported.api, document, mode as "merge" | "overwrite", imported.warnings); this.validateImportedApi(imported.api); } catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("BadRequestException", error instanceof Error ? error.message : String(error)); } if (url.searchParams.get("failonwarnings") === "true" && imported.warnings.length) throw new AwsError("BadRequestException", imported.warnings.join("; ")); this.replaceObject(api, imported.api); await this.store.save(); return json(res, apiView(api, imported.warnings)); }
      if (suffix === "/documentation/parts" && req.method === "POST") {
        const part = this.createDocumentationPartState(
          api,
          await readJson(req),
          undefined,
          this.cloudFormationCreateIdentity(req),
        );
        api.documentationParts![part.id] = part;
        await this.store.save();
        return json(res, documentationPartView(part), 201);
      }
      if (suffix === "/documentation/parts" && req.method === "GET") { const type = url.searchParams.get("type")?.toUpperCase(); const name = url.searchParams.get("nameQuery")?.toLowerCase(); const path = url.searchParams.get("path"); const locationStatus = url.searchParams.get("locationStatus"); if (type && !DOCUMENTATION_PART_TYPES.has(type) || locationStatus && !["DOCUMENTED", "UNDOCUMENTED"].includes(locationStatus)) throw new AwsError("BadRequestException", "Invalid documentation filter"); const values = Object.values(api.documentationParts!).filter(part => !type || part.location.type === type).filter(part => !name || part.location.name?.toLowerCase().includes(name)).filter(part => !path || part.location.path === path).filter(part => locationStatus !== "UNDOCUMENTED").sort((a, b) => a.id.localeCompare(b.id)).map(documentationPartView); return json(res, this.page("GetDocumentationParts", `${api.id}:${type ?? ""}:${name ?? ""}:${path ?? ""}:${locationStatus ?? ""}`, values, url)); }
      if (suffix === "/documentation/parts" && req.method === "PUT") { const mode = url.searchParams.get("mode") ?? "merge"; if (!["merge", "overwrite"].includes(mode)) throw new AwsError("BadRequestException", "mode must be merge or overwrite"); let document: any; try { document = JSON.parse((await readBody(req)).toString("utf8")); } catch { throw new AwsError("BadRequestException", "Documentation import body must be JSON"); } const inputs = Array.isArray(document) ? document : document.documentationParts ?? document["x-amazon-apigateway-documentation"]?.documentationParts; if (!Array.isArray(inputs)) throw new AwsError("BadRequestException", "Documentation import must contain documentationParts"); const candidate = mode === "overwrite" ? {} : structuredClone(api.documentationParts!); const warnings: string[] = []; const importedIds: string[] = []; for (let index = 0; index < inputs.length; index++) { try { const candidateApi = { ...api, documentationParts: candidate }; const part = this.createDocumentationPartState(candidateApi, inputs[index]); candidate[part.id] = part; importedIds.push(part.id); } catch (error) { warnings.push(`Part ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); } } if (url.searchParams.get("failonwarnings") === "true" && warnings.length) throw new AwsError("BadRequestException", warnings.join("; ")); api.documentationParts = candidate; await this.store.save(); return json(res, { ids: importedIds, ...(warnings.length ? { warnings } : {}) }); }
      const documentationPartMatch = suffix.match(/^\/documentation\/parts\/([^/]+)$/);
      if (documentationPartMatch) {
        const part = this.documentationPart(api, decodeURIComponent(documentationPartMatch[1]));
        this.assertCloudFormationOwner(req, part, "Documentation part");
        if (req.method === "GET") return json(res, documentationPartView(part));
        if (req.method === "PATCH") {
          const candidate = structuredClone(part) as any;
          this.applyPatch(candidate, (await readJson(req)).patchOperations, new Set(["/location", "/properties"]));
          const updated = this.createDocumentationPartState(
            api,
            { location: candidate.location, properties: candidate.properties },
            part.id,
          );
          updated.cloudFormationOwner = part.cloudFormationOwner;
          updated.cloudFormationOperationToken = part.cloudFormationOperationToken;
          api.documentationParts![part.id] = updated;
          await this.store.save();
          return json(res, documentationPartView(updated));
        }
        if (req.method === "DELETE") {
          delete api.documentationParts![part.id];
          await this.store.save();
          res.statusCode = 202;
          res.end();
          return;
        }
      }
      if (suffix === "/documentation/versions" && req.method === "POST") {
        const input = await readJson(req);
        const identity = this.cloudFormationCreateIdentity(req);
        const version = String(input.documentationVersion ?? "").trim();
        if (!version || version.length > 64) {
          throw new AwsError("BadRequestException", "Documentation version is required and must be unique");
        }
        const existing = api.documentationVersions![version];
        if (existing) {
          if (identity) {
            this.assertCloudFormationReplay(identity, existing, "Documentation version");
            if (existing.description !== input.description) {
              throw new AwsError(
                "ConflictException",
                "The CloudFormation operation token belongs to a documentation version with different properties",
                409,
              );
            }
            return json(res, documentationVersionView(existing), 201);
          }
          throw new AwsError(
            "ConflictException",
            "Documentation version is required and must be unique",
            409,
          );
        }
        const item: ApiDocumentationVersionState = {
          version,
          createdDate: this.clock.now(),
          description: input.description,
          parts: structuredClone(api.documentationParts!),
          ...identity,
        };
        api.documentationVersions![version] = item;
        if (input.stageName) {
          const stage = api.stages[String(input.stageName)];
          if (!stage) {
            delete api.documentationVersions![version];
            throw new AwsError("NotFoundException", "Invalid Stage identifier specified", 404);
          }
          stage.documentationVersion = version;
          stage.lastUpdatedDate = this.clock.now();
        }
        await this.store.save();
        return json(res, documentationVersionView(item), 201);
      }
      if (suffix === "/documentation/versions" && req.method === "GET") return json(res, this.page("GetDocumentationVersions", api.id, Object.values(api.documentationVersions!).sort((a, b) => b.createdDate - a.createdDate).map(documentationVersionView), url));
      const documentationVersionMatch = suffix.match(/^\/documentation\/versions\/([^/]+)$/);
      if (documentationVersionMatch) {
        const item = this.documentationVersion(api, decodeURIComponent(documentationVersionMatch[1]));
        this.assertCloudFormationOwner(req, item, "Documentation version");
        if (req.method === "GET") return json(res, documentationVersionView(item));
        if (req.method === "PATCH") {
          this.applyPatch(item, (await readJson(req)).patchOperations, new Set(["/description"]));
          await this.store.save();
          return json(res, documentationVersionView(item));
        }
        if (req.method === "DELETE") {
          if (Object.values(api.stages).some(stage => stage.documentationVersion === item.version)) throw new AwsError("ConflictException", "The documentation version is associated with a stage", 409);
          delete api.documentationVersions![item.version];
          await this.store.save();
          res.statusCode = 202;
          res.end();
          return;
        }
      }
      if (suffix === "/models" && req.method === "POST") { const input = await readJson(req); if (!/^[A-Za-z0-9]+$/.test(input.name ?? "")) throw new AwsError("BadRequestException", "Model name must contain only alphanumeric characters"); if (!input.contentType || !validMediaType(input.contentType)) throw new AwsError("BadRequestException", "contentType must be a valid media type"); if (api.models![input.name]) throw new AwsError("ConflictException", "Model already exists", 409); const model: ApiModelState = { id: id(10), name: input.name, description: input.description, schema: input.schema ?? "{}", contentType: mediaType(input.contentType) }; const candidate = { ...api.models!, [model.name]: model }; this.validateModels(candidate); api.models![model.name] = model; await this.store.save(); return json(res, modelView(model), 201); }
      if (suffix === "/models" && req.method === "GET") return json(res, this.page("GetModels", api.id, Object.values(api.models!).sort((a, b) => a.name.localeCompare(b.name)).map(modelView), url));
      const modelTemplateMatch = suffix.match(/^\/models\/([^/]+)\/default_template$/); if (modelTemplateMatch && req.method === "GET") { const name = decodeURIComponent(modelTemplateMatch[1]); if (!api.models![name]) throw new AwsError("NotFoundException", "Invalid Model identifier specified", 404); return json(res, { value: JSON.stringify(modelTemplate(name, api.models!)) }); }
      const modelMatch = suffix.match(/^\/models\/([^/]+)$/); if (modelMatch) { const name = decodeURIComponent(modelMatch[1]); const model = api.models![name]; if (!model) throw new AwsError("NotFoundException", "Invalid Model identifier specified", 404); if (req.method === "GET") return json(res, modelView(model)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(model); this.applyPatch(updated, input.patchOperations, new Set(["/description", "/schema", "/contentType"])); if (!updated.contentType || !validMediaType(updated.contentType)) throw new AwsError("BadRequestException", "contentType must be a valid media type"); updated.contentType = mediaType(updated.contentType); const candidate = { ...api.models!, [name]: updated }; this.validateModels(candidate); this.replaceObject(model, updated); await this.store.save(); return json(res, modelView(model)); } if (req.method === "DELETE") { if (["Empty", "Error"].includes(name)) throw new AwsError("BadRequestException", "Default models cannot be deleted"); const referenced = Object.values(api.resources).some(resource => Object.values(resource.methods).some(method => Object.values(method.requestModels ?? {}).includes(name) || Object.values(method.responses ?? {}).some(response => Object.values(response.responseModels ?? {}).includes(name)))); if (referenced) throw new AwsError("ConflictException", "Model is still referenced by a method", 409); const candidate = { ...api.models! }; delete candidate[name]; this.validateModels(candidate); delete api.models![name]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (suffix === "/requestvalidators" && req.method === "POST") { const input = await readJson(req); const validator: ApiRequestValidatorState = { id: id(10), name: input.name, validateRequestBody: input.validateRequestBody ?? false, validateRequestParameters: input.validateRequestParameters ?? false }; api.requestValidators![validator.id] = validator; await this.store.save(); return json(res, requestValidatorView(validator), 201); }
      if (suffix === "/requestvalidators" && req.method === "GET") return json(res, this.page("GetRequestValidators", api.id, Object.values(api.requestValidators!).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")).map(requestValidatorView), url));
      const requestValidatorMatch = suffix.match(/^\/requestvalidators\/([^/]+)$/); if (requestValidatorMatch) { const validator = api.requestValidators![decodeURIComponent(requestValidatorMatch[1])]; if (!validator) throw new AwsError("NotFoundException", "Invalid Request Validator identifier specified", 404); if (req.method === "GET") return json(res, requestValidatorView(validator)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(validator); this.applyPatch(updated, input.patchOperations, new Set(["/name", "/validateRequestBody", "/validateRequestParameters"])); updated.validateRequestBody = Boolean(updated.validateRequestBody); updated.validateRequestParameters = Boolean(updated.validateRequestParameters); this.replaceObject(validator, updated); await this.store.save(); return json(res, requestValidatorView(validator)); } if (req.method === "DELETE") { if (Object.values(api.resources).some(resource => Object.values(resource.methods).some(method => method.requestValidatorId === validator.id))) throw new AwsError("ConflictException", "Request validator is still referenced by a method", 409); delete api.requestValidators![validator.id]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (suffix === "/gatewayresponses" && req.method === "GET") return json(res, { item: [...GATEWAY_RESPONSE_TYPES].sort().map(type => gatewayResponseView(type, api.gatewayResponses![type])) });
      const gatewayResponseMatch = suffix.match(/^\/gatewayresponses\/([^/]+)$/); if (gatewayResponseMatch) { const responseType = decodeURIComponent(gatewayResponseMatch[1]); this.validateGatewayResponseType(responseType); const current = api.gatewayResponses![responseType]; if (req.method === "GET") return json(res, gatewayResponseView(responseType, current)); if (req.method === "PUT") { const input = await readJson(req); const candidate: ApiGatewayResponseState = { responseType, statusCode: input.statusCode, responseParameters: input.responseParameters ?? {}, responseTemplates: input.responseTemplates ?? {} }; this.validateGatewayResponse(candidate); api.gatewayResponses![responseType] = candidate; await this.store.save(); return json(res, gatewayResponseView(responseType, candidate), 201); } if (req.method === "PATCH") { const input = await readJson(req); const candidate: ApiGatewayResponseState = structuredClone(current ?? { responseType, statusCode: GATEWAY_RESPONSE_STATUS[responseType] === undefined ? undefined : String(GATEWAY_RESPONSE_STATUS[responseType]), responseParameters: {}, responseTemplates: {} }); this.applyGatewayResponsePatch(candidate, input.patchOperations); this.validateGatewayResponse(candidate); api.gatewayResponses![responseType] = candidate; await this.store.save(); return json(res, gatewayResponseView(responseType, candidate)); } if (req.method === "DELETE") { delete api.gatewayResponses![responseType]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (suffix === "/resources" && req.method === "GET") return json(res, { item: Object.values(api.resources).map(r => resourceView(r, url.searchParams.getAll("embed"))) });
      const resourceMatch = suffix.match(/^\/resources\/([^/]+)(.*)$/);
      if (resourceMatch) { const resource = this.resource(api, resourceMatch[1]); const rest = resourceMatch[2];
        if (rest === "" && req.method === "GET") return json(res, resourceView(resource, url.searchParams.getAll("embed")));
        if (rest === "" && req.method === "PATCH") { if (resource.id === api.rootResourceId) throw new AwsError("BadRequestException", "The root resource path cannot be changed"); const input = await readJson(req); const candidate = structuredClone(resource); this.applyPatch(candidate, input.patchOperations, new Set(["/pathPart"])); const pathPart = String(candidate.pathPart ?? "").trim(); if (!pathPart || pathPart.includes("/") || pathPart.length > 256) throw new AwsError("BadRequestException", "pathPart must be one non-empty path segment"); const parent = resource.parentId ? this.resource(api, resource.parentId) : undefined; const nextPath = parent?.path === "/" ? `/${pathPart}` : `${parent?.path}/${pathPart}`; if (Object.values(api.resources).some(value => value.id !== resource.id && value.parentId === resource.parentId && value.pathPart === pathPart)) throw new AwsError("ConflictException", "Another resource with the same parent already has this name", 409); const previousPath = resource.path; resource.pathPart = pathPart; resource.path = nextPath; for (const descendant of Object.values(api.resources)) if (descendant.id !== resource.id && descendant.path.startsWith(`${previousPath}/`)) descendant.path = `${nextPath}${descendant.path.slice(previousPath.length)}`; await this.store.save(); return json(res, resourceView(resource)); }
        if (rest === "" && req.method === "POST") { const input = await readJson(req); if (!input.pathPart) throw new AwsError("BadRequestException", "pathPart is required"); const path = resource.path === "/" ? `/${input.pathPart}` : `${resource.path}/${input.pathPart}`; if (Object.values(api.resources).some(r => r.path === path)) throw new AwsError("ConflictException", "Another resource with the same parent already has this name", 409); const child: ApiResource = { id: id(10), parentId: resource.id, pathPart: input.pathPart, path, methods: {}, integrations: {} }; api.resources[child.id] = child; await this.store.save(); return json(res, resourceView(child), 201); }
        if (rest === "" && req.method === "DELETE") {
          if (resource.id === api.rootResourceId) throw new AwsError("BadRequestException", "Cannot delete root resource");
          const remove = new Set<string>();
          const visit = (id: string) => {
            remove.add(id);
            for (const child of Object.values(api.resources)) if (child.parentId === id) visit(child.id);
          };
          visit(resource.id);
          for (const id of remove) delete api.resources[id];
          await this.store.save();
          res.statusCode = 202;
          res.end();
          return;
        }
        const methodMatch = rest.match(/^\/methods\/([^/]+)(.*)$/); if (methodMatch) { const method = decodeURIComponent(methodMatch[1]).toUpperCase(); const tail = methodMatch[2];
          if (tail === "" && req.method === "PUT") { const input = await readJson(req); const candidate: ApiMethodState = { authorizationType: input.authorizationType ?? "NONE", authorizerId: input.authorizerId, authorizationScopes: input.authorizationScopes ?? [], apiKeyRequired: input.apiKeyRequired ?? false, requestParameters: input.requestParameters ?? {}, requestModels: input.requestModels ?? {}, requestValidatorId: input.requestValidatorId, operationName: input.operationName, responses: {} }; this.validateMethodConfiguration(api, candidate); resource.methods[method] = candidate; await this.store.save(); return json(res, methodView(method, resource.methods[method]), 201); }
          if (tail === "" && req.method === "GET") { const value = resource.methods[method]; if (!value) throw new AwsError("NotFoundException", "Invalid Method identifier specified", 404); return json(res, methodView(method, value, resource.integrations[method])); }
          if (tail === "" && req.method === "PATCH") {
            const value = resource.methods[method];
            if (!value) throw new AwsError("NotFoundException", "Invalid Method identifier specified", 404);
            const input = await readJson(req);
            const updated = structuredClone(value);
            const ordinary: any[] = [];
            for (const operation of input.patchOperations ?? []) {
              if (operation.path !== "/authorizationScopes") {
                ordinary.push(operation);
                continue;
              }
              if (!["add", "remove"].includes(operation.op) || typeof operation.value !== "string" || !operation.value) {
                throw new AwsError("BadRequestException", "authorizationScopes supports add and remove with one scope value");
              }
              updated.authorizationScopes ??= [];
              if (operation.op === "add") updated.authorizationScopes.push(operation.value);
              else updated.authorizationScopes = updated.authorizationScopes.filter(scope => scope !== operation.value);
            }
            this.applyPatch(updated, ordinary, new Set(["/authorizationType", "/authorizerId", "/apiKeyRequired", "/requestParameters", "/requestModels", "/requestValidatorId", "/operationName"]));
            if (!updated.requestValidatorId) delete updated.requestValidatorId;
            updated.authorizationScopes ??= [];
            this.validateMethodConfiguration(api, updated);
            this.replaceObject(value, updated);
            await this.store.save();
            return json(res, methodView(method, value, resource.integrations[method]));
          }
          if (tail === "" && req.method === "DELETE") { delete resource.methods[method]; delete resource.integrations[method]; await this.store.save(); res.statusCode = 204; res.end(); return; }
          if (tail === "/integration" && req.method === "PUT") { if (!resource.methods[method]) throw new AwsError("NotFoundException", "Invalid Method identifier specified", 404); const input = await readJson(req); const integration: ApiIntegrationState = { type: input.type, integrationHttpMethod: input.integrationHttpMethod ?? input.httpMethod ?? (input.type === "MOCK" ? "POST" : method), uri: input.uri, connectionType: input.connectionType ?? "INTERNET", connectionId: input.connectionId, credentials: input.credentials, requestParameters: input.requestParameters ?? {}, requestTemplates: input.requestTemplates ?? {}, passthroughBehavior: input.passthroughBehavior ?? "WHEN_NO_MATCH", contentHandling: input.contentHandling, timeoutInMillis: input.timeoutInMillis ?? 29_000, cacheNamespace: input.cacheNamespace ?? resource.id, cacheKeyParameters: input.cacheKeyParameters ?? [], tlsConfig: input.tlsConfig, responses: {} }; this.validateIntegrationConfiguration(integration, resource.methods[method]); resource.integrations[method] = integration; await this.store.save(); return json(res, integrationView(integration), 201); }
          if (tail === "/integration" && req.method === "GET") { const integration = resource.integrations[method]; if (!integration) throw new AwsError("NotFoundException", "Invalid Integration identifier specified", 404); return json(res, integrationView(integration)); }
          if (tail === "/integration" && req.method === "PATCH") { const integration = resource.integrations[method]; if (!integration) throw new AwsError("NotFoundException", "Invalid Integration identifier specified", 404); const input = await readJson(req); const operations = (input.patchOperations ?? []).map((operation: any) => operation.path === "/httpMethod" ? { ...operation, path: "/integrationHttpMethod" } : operation); const updated = structuredClone(integration); this.applyPatch(updated, operations, new Set(["/type", "/integrationHttpMethod", "/uri", "/connectionType", "/connectionId", "/credentials", "/requestParameters", "/requestTemplates", "/passthroughBehavior", "/contentHandling", "/timeoutInMillis", "/cacheKeyParameters", "/cacheNamespace", "/tlsConfig"])); updated.timeoutInMillis = Number(updated.timeoutInMillis); this.validateIntegrationConfiguration(updated, resource.methods[method]); this.replaceObject(integration, updated); await this.store.save(); return json(res, integrationView(integration)); }
          if (tail === "/integration" && req.method === "DELETE") { delete resource.integrations[method]; await this.store.save(); res.statusCode = 204; res.end(); return; }
          const methodResponse = tail.match(/^\/responses\/([^/]+)$/); if (methodResponse) { const status = decodeURIComponent(methodResponse[1]); const value = resource.methods[method]; if (!value) throw new AwsError("NotFoundException", "Method not found", 404); if (req.method === "PUT") { if (!/^\d{3}$/.test(status)) throw new AwsError("BadRequestException", "statusCode must contain three digits"); const input = await readJson(req); this.validateModelMap(api, input.responseModels); value.responses ??= {}; value.responses[status] = { statusCode: status, responseParameters: input.responseParameters ?? {}, responseModels: input.responseModels ?? {} }; await this.store.save(); return json(res, methodResponseView(value.responses[status]), 201); } const response = value.responses?.[status]; if (!response) throw new AwsError("NotFoundException", "Method response not found", 404); if (req.method === "GET") return json(res, methodResponseView(response)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(response); this.applyPatch(updated, input.patchOperations, new Set(["/responseParameters", "/responseModels"])); this.validateModelMap(api, updated.responseModels); this.replaceObject(response, updated); await this.store.save(); return json(res, methodResponseView(response)); } if (req.method === "DELETE") { delete value.responses![status]; await this.store.save(); res.statusCode = 204; res.end(); return; } }
          const integrationResponse = tail.match(/^\/integration\/responses\/([^/]+)$/); if (integrationResponse) { const status = decodeURIComponent(integrationResponse[1]); const integration = resource.integrations[method]; if (!integration) throw new AwsError("NotFoundException", "Integration not found", 404); if (req.method === "PUT") { const input = await readJson(req); const response: ApiIntegrationResponseState = { statusCode: input.statusCode ?? status, selectionPattern: input.selectionPattern, responseParameters: input.responseParameters ?? {}, responseTemplates: input.responseTemplates ?? {}, contentHandling: input.contentHandling }; this.validateIntegrationResponse(resource.methods[method], response); integration.responses ??= {}; integration.responses[status] = response; await this.store.save(); return json(res, integrationResponseView(response), 201); } const response = integration.responses?.[status]; if (!response) throw new AwsError("NotFoundException", "Integration response not found", 404); if (req.method === "GET") return json(res, integrationResponseView(response)); if (req.method === "PATCH") { const input = await readJson(req); const updated = structuredClone(response); this.applyPatch(updated, input.patchOperations, new Set(["/statusCode", "/selectionPattern", "/responseParameters", "/responseTemplates", "/contentHandling"])); this.validateIntegrationResponse(resource.methods[method], updated); this.replaceObject(response, updated); await this.store.save(); return json(res, integrationResponseView(response)); } if (req.method === "DELETE") { delete integration.responses![status]; await this.store.save(); res.statusCode = 204; res.end(); return; } }
          if (tail === "" && req.method === "POST") { const input = await readJson(req); const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])); const testUrl = new URL(input.pathWithQueryString ?? resource.path, "http://test-invoke.local"); const query = { ...Object.fromEntries(testUrl.searchParams.entries()), ...Object.fromEntries(Object.entries(input.queryStringParameters ?? {}).map(([key, value]) => [key, String(value)])) }; const pathParameters = this.route(api.resources, testUrl.pathname)?.parameters ?? {}; const body = Buffer.from(input.body ?? ""); const result = await this.pipeline(api, resource, method, { method, path: testUrl.pathname, headers, query, multiQuery: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, [value]])), pathParameters, body, stageName: "test-invoke-stage", stageVariables: input.stageVariables ?? {}, requestId: id(24) }, this.invocationConfiguration(api), api.authorizers, api.policy); return json(res, { status: result.status, body: result.body.toString("utf8"), headers: result.headers, multiValueHeaders: Object.fromEntries(Object.entries(result.headers).map(([key, value]) => [key, [value]])), log: result.log, latency: Math.round(result.latency) }); }
        }
      }
      if (suffix === "/authorizers" && req.method === "POST") { const input = await readJson(req); const authorizer: ApiAuthorizerState = { id: id(10), name: input.name, type: input.type, authorizerUri: input.authorizerUri, authorizerCredentials: input.authorizerCredentials, identitySource: input.identitySource ?? (input.type === "COGNITO_USER_POOLS" ? "method.request.header.Authorization" : undefined), identityValidationExpression: input.identityValidationExpression, authorizerResultTtlInSeconds: input.authorizerResultTtlInSeconds ?? 300, providerARNs: input.providerARNs }; this.validateAuthorizerConfiguration(authorizer); api.authorizers![authorizer.id] = authorizer; await this.store.save(); return json(res, authorizerView(authorizer), 201); }
      if (suffix === "/authorizers" && req.method === "GET") return json(res, this.page("GetAuthorizers", api.id, Object.values(api.authorizers!).map(authorizerView), url));
      const authorizerMatch = suffix.match(/^\/authorizers\/([^/]+)$/); if (authorizerMatch) { const authorizer = api.authorizers![decodeURIComponent(authorizerMatch[1])]; if (!authorizer) throw new AwsError("NotFoundException", "Authorizer not found", 404); if (req.method === "GET") return json(res, authorizerView(authorizer)); if (req.method === "PATCH") {
        const input = await readJson(req);
        const updated = structuredClone(authorizer);
        const ordinary: any[] = [];
        for (const operation of input.patchOperations ?? []) {
          if (operation.path !== "/providerARNs") {
            ordinary.push(operation);
            continue;
          }
          if (!["add", "remove"].includes(operation.op) || typeof operation.value !== "string" || !operation.value) {
            throw new AwsError("BadRequestException", "providerARNs supports add and remove with one user-pool ARN value");
          }
          updated.providerARNs ??= [];
          if (operation.op === "add") updated.providerARNs.push(operation.value);
          else updated.providerARNs = updated.providerARNs.filter(value => value !== operation.value);
        }
        this.applyPatch(updated, ordinary, new Set(["/name", "/type", "/authorizerUri", "/authorizerCredentials", "/identitySource", "/identityValidationExpression", "/authorizerResultTtlInSeconds"]));
        updated.authorizerResultTtlInSeconds = Number(updated.authorizerResultTtlInSeconds);
        this.validateAuthorizerConfiguration(updated);
        this.replaceObject(authorizer, updated);
        this.clearAuthorizerCache(api.id, authorizer.id);
        await this.store.save();
        return json(res, authorizerView(authorizer));
      } if (req.method === "DELETE") { if (Object.values(api.resources).some(resource => Object.values(resource.methods).some(method => method.authorizerId === authorizer.id))) throw new AwsError("ConflictException", "Authorizer is still referenced by a method", 409); this.clearAuthorizerCache(api.id, authorizer.id); delete api.authorizers![authorizer.id]; await this.store.save(); res.statusCode = 202; res.end(); return; } if (req.method === "POST") { const input = await readJson(req); const testUrl = new URL(input.pathWithQueryString ?? "/", "http://test-authorizer.local"); const result = await this.runAuthorizer(api, authorizer, { method: "GET", path: testUrl.pathname, headers: Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), query: Object.fromEntries(testUrl.searchParams.entries()), multiQuery: Object.fromEntries([...new Set(testUrl.searchParams.keys())].map(key => [key, testUrl.searchParams.getAll(key)])), pathParameters: {}, body: Buffer.from(input.body ?? ""), stageName: "test-invoke-stage", stageVariables: input.stageVariables ?? {}, requestId: id(24) }, `arn:aws:execute-api:${this.region}:${this.store.accountId}:${api.id}/test-invoke-stage/GET/${testUrl.pathname.replace(/^\//, "")}`, { authorizationType: "COGNITO_USER_POOLS", authorizationScopes: [], apiKeyRequired: false, requestParameters: {}, requestModels: {}, responses: {} }); return authorizer.type === "COGNITO_USER_POOLS" ? json(res, { clientStatus: 0, log: "Cognito authorizer token validation succeeded", latency: 0, claims: (result.context.claims ?? {}) }) : json(res, { clientStatus: 0, log: "Authorizer invocation succeeded", latency: 0, principalId: result.principalId, policy: JSON.stringify(result.policy), authorization: result.allowed ? {} : { failureReason: "DENY" }, claims: result.context }); } }
      const sdkMatch = suffix.match(/^\/stages\/([^/]+)\/sdks\/([^/]+)$/); if (sdkMatch && req.method === "GET") { const stageName = decodeURIComponent(sdkMatch[1]); const sdkType = decodeURIComponent(sdkMatch[2]); const stage = api.stages[stageName]; if (!stage) throw new AwsError("NotFoundException", "Invalid Stage identifier specified", 404); this.sdkType(sdkType); if (sdkType !== "javascript") throw new AwsError("BadRequestException", `SDK generation for ${sdkType} is dependency-blocked; the local JavaScript generator is supported`); const body = this.javascriptSdk(api, stage); res.statusCode = 200; res.setHeader("content-type", "application/zip"); res.setHeader("content-disposition", `attachment; filename=\"${api.id}-${stageName}-javascript.zip\"`); res.end(body); return; }
      const exportMatch = suffix.match(/^\/stages\/([^/]+)\/exports\/([^/]+)$/); if (exportMatch && req.method === "GET") { const stageName = decodeURIComponent(exportMatch[1]); const exportType = decodeURIComponent(exportMatch[2]); const stage = api.stages[stageName]; if (!stage) throw new AwsError("NotFoundException", "Invalid Stage identifier specified", 404); const snapshot = api.deployments[stage.deploymentId]?.snapshot; if (!snapshot) throw new AwsError("NotFoundException", "Stage deployment snapshot is missing", 404); if (!new Set(["swagger", "oas30"]).has(exportType)) throw new AwsError("BadRequestException", "exportType must be swagger or oas30"); const parameters = this.importParameters(url); const extensions = new Set(String(parameters.extensions ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean)); const postman = extensions.has("postman") || parameters.postman === "true"; const document = exportOpenApi(api, snapshot, exportType as "swagger" | "oas30", extensions, postman); this.applyDocumentationToExport(document, this.documentationForStage(api, stage)); const accept = mediaType(Array.isArray(req.headers.accept) ? req.headers.accept[0] : req.headers.accept) || "application/json"; if (!new Set(["application/json", "application/yaml", "text/yaml"]).has(accept)) throw new AwsError("NotAcceptableException", "Only application/json and application/yaml exports are supported", 406); const yaml = accept !== "application/json"; const body = Buffer.from(yaml ? stringifyOpenApiYaml(document) : JSON.stringify(document, null, 2)); res.statusCode = 200; res.setHeader("content-type", yaml ? "application/yaml" : "application/json"); res.setHeader("content-disposition", `attachment; filename=\"${api.id}-${stageName}.${yaml ? "yaml" : "json"}\"`); res.end(body); return; }
      const flush = suffix.match(/^\/stages\/([^/]+)\/cache\/authorizers$/); if (flush && req.method === "DELETE") { for (const key of this.authorizerCache.keys()) if (key.startsWith(`${api.id}\0${decodeURIComponent(flush[1])}\0`)) this.authorizerCache.delete(key); res.statusCode = 202; res.end(); return; }
      const flushData = suffix.match(/^\/stages\/([^/]+)\/cache\/data$/); if (flushData && req.method === "DELETE") { const stageName = decodeURIComponent(flushData[1]); if (!api.stages[stageName]) throw new AwsError("NotFoundException", "Invalid Stage identifier specified", 404); this.clearResponseCache(api.id, stageName); await this.store.save(); res.statusCode = 202; res.end(); return; }
      if (suffix === "/deployments" && req.method === "POST") {
        const input = await readJson(req); if (input.stageName && !/^[A-Za-z0-9_-]{1,128}$/.test(input.stageName)) throw new AwsError("BadRequestException", "Invalid stage name"); const operationToken = input.stackSimCloudFormationOperationToken; if (operationToken !== undefined && (typeof operationToken !== "string" || !/^[a-f0-9]{64}$/.test(operationToken))) throw new AwsError("BadRequestException", "stackSimCloudFormationOperationToken must contain 64 lowercase hexadecimal characters"); if (operationToken) { const existing = Object.values(api.deployments).find(candidate => candidate.cloudFormationOperationToken === operationToken); if (existing) { if (input.description !== undefined && input.description !== existing.description) throw new AwsError("ConflictException", "The CloudFormation operation token belongs to a different deployment", 409); return json(res, deploymentView(existing), 201); } } const deploymentId = id(10); const snapshot: ApiDeploymentSnapshot = { rootResourceId: api.rootResourceId, resources: structuredClone(api.resources), authorizers: structuredClone(api.authorizers), models: structuredClone(api.models), requestValidators: structuredClone(api.requestValidators), policy: structuredClone(api.policy), binaryMediaTypes: structuredClone(api.binaryMediaTypes), minimumCompressionSize: api.minimumCompressionSize, gatewayResponses: structuredClone(api.gatewayResponses), apiKeySource: api.apiKeySource ?? "HEADER", schemaProfileVersion: DRAFT4_PROFILE_VERSION }; api.deployments[deploymentId] = { id: deploymentId, createdDate: this.clock.now(), description: input.description, snapshot, contentHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), ...(operationToken ? { cloudFormationOperationToken: operationToken } : {}) };
        try { if (input.stageName) { const now = this.clock.now(); const existing = api.stages[input.stageName]; const candidate: ApiStageState = existing && input.canarySettings ? { ...structuredClone(existing), canarySettings: { ...input.canarySettings, percentTraffic: Number(input.canarySettings.percentTraffic ?? 0), deploymentId }, lastUpdatedDate: now } : { ...structuredClone(existing), stageName: input.stageName, deploymentId, description: input.stageDescription ?? existing?.description, variables: existing?.variables ?? {}, methodSettings: existing?.methodSettings ?? {}, tracingEnabled: input.tracingEnabled ?? existing?.tracingEnabled ?? false, cacheClusterEnabled: input.cacheClusterEnabled ?? existing?.cacheClusterEnabled ?? false, cacheClusterSize: input.cacheClusterSize ?? existing?.cacheClusterSize, tags: existing?.tags ?? {}, createdDate: existing?.createdDate ?? now, lastUpdatedDate: now }; this.validateStage(api, candidate); api.stages[input.stageName] = candidate; if (existing && candidate.deploymentId !== existing.deploymentId) this.clearResponseCache(api.id, input.stageName); } } catch (error) { delete api.deployments[deploymentId]; throw error; }
        await this.store.save(); return json(res, deploymentView(api.deployments[deploymentId]), 201);
      }
      if (suffix === "/deployments" && req.method === "GET") { const operationToken = url.searchParams.get("stacksim-cloudformation-operation-token"); if (operationToken !== null && !/^[a-f0-9]{64}$/.test(operationToken)) throw new AwsError("BadRequestException", "Invalid CloudFormation operation token"); const deployments = Object.values(api.deployments).filter(deployment => operationToken === null || deployment.cloudFormationOperationToken === operationToken).sort((a, b) => b.createdDate - a.createdDate).map(deploymentView); return json(res, this.page("GetDeployments", `${api.id}:${operationToken ?? ""}`, deployments, url)); }
      const deploymentMatch = suffix.match(/^\/deployments\/([^/]+)$/); if (deploymentMatch) { const deployment = api.deployments[decodeURIComponent(deploymentMatch[1])]; if (!deployment) throw new AwsError("NotFoundException", "Invalid Deployment identifier specified", 404); if (req.method === "GET") return json(res, deploymentView(deployment)); if (req.method === "PATCH") { const input = await readJson(req); this.applyPatch(deployment, input.patchOperations, new Set(["/description"])); await this.store.save(); return json(res, deploymentView(deployment)); } if (req.method === "DELETE") { if (Object.values(api.stages).some(stage => stage.deploymentId === deployment.id || stage.canarySettings?.deploymentId === deployment.id)) throw new AwsError("ConflictException", "Cannot delete deployment while a stage refers to it", 409); delete api.deployments[deployment.id]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      if (suffix === "/stages" && req.method === "GET") return json(res, this.page("GetStages", api.id, Object.values(api.stages).sort((a, b) => a.stageName.localeCompare(b.stageName)).map(stage => stageView(api, stage, this.invokePort, this.invokeProtocol)), url));
      if (suffix === "/stages" && req.method === "POST") { const input = await readJson(req); if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(input.stageName ?? ""))) throw new AwsError("BadRequestException", "Invalid stage name"); if (!api.deployments[input.deploymentId]) throw new AwsError("NotFoundException", "Invalid Deployment identifier specified", 404); if (api.stages[input.stageName]) throw new AwsError("ConflictException", "Stage already exists", 409); const now = this.clock.now(); const candidate: ApiStageState = { stageName: input.stageName, deploymentId: input.deploymentId, description: input.description, variables: input.variables ?? {}, methodSettings: {}, tracingEnabled: input.tracingEnabled ?? false, accessLogSettings: input.accessLogSettings, cacheClusterEnabled: input.cacheClusterEnabled ?? false, cacheClusterSize: input.cacheClusterSize, canarySettings: input.canarySettings ? { ...input.canarySettings, percentTraffic: Number(input.canarySettings.percentTraffic ?? 0) } : undefined, documentationVersion: input.documentationVersion, clientCertificateId: input.clientCertificateId, tags: input.tags ?? {}, createdDate: now, lastUpdatedDate: now }; this.validateStage(api, candidate); api.stages[input.stageName] = candidate; await this.store.save(); return json(res, stageView(api, candidate, this.invokePort, this.invokeProtocol), 201); }
      const stageMatch = suffix.match(/^\/stages\/([^/]+)$/); if (stageMatch) { const stage = api.stages[decodeURIComponent(stageMatch[1])]; if (!stage) throw new AwsError("NotFoundException", "Invalid Stage identifier specified", 404); if (req.method === "GET") return json(res, stageView(api, stage, this.invokePort, this.invokeProtocol)); if (req.method === "PATCH") { const input = await readJson(req); const candidate = structuredClone(stage); this.applyStagePatch(candidate, input.patchOperations); this.validateStage(api, candidate); candidate.lastUpdatedDate = this.clock.now(); api.stages[stage.stageName] = candidate; if ((input.patchOperations ?? []).some((operation: any) => String(operation.path ?? "").includes("/caching/") || ["/deploymentId", "/cacheClusterEnabled", "/cacheClusterSize"].includes(String(operation.path ?? "")))) this.clearResponseCache(api.id, stage.stageName); await this.store.save(); return json(res, stageView(api, candidate, this.invokePort, this.invokeProtocol)); } if (req.method === "DELETE") { delete api.stages[stage.stageName]; this.clearResponseCache(api.id, stage.stageName); for (const plan of Object.values(this.usagePlans)) plan.apiStages = plan.apiStages.filter(value => value.apiId !== api.id || value.stage !== stage.stageName); for (const domain of Object.values(this.domainNames)) for (const [basePath, mapping] of Object.entries(domain.basePathMappings)) if (mapping.restApiId === api.id && mapping.stage === stage.stageName) delete domain.basePathMappings[basePath]; await this.store.save(); res.statusCode = 202; res.end(); return; } }
      throw new AwsError("NotFoundException", "Unknown API Gateway route", 404);
    } catch (error) { sendAwsError(res, error, "rest"); }
  }

  async invoke(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const started = performance.now(); let apiName: string | undefined; let metricStage: string | undefined; let logApi: RestApiState | undefined; let logStage: ApiStageState | undefined; let logInput: InvocationInput | undefined; let metricResource: string | undefined; let metricMethod: string | undefined; let methodSetting: ApiMethodSettingState = {}; let canary = false; const invocationRequestId = id(24);
    try {
      const match = pathname.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/); if (!match) throw new AwsError("NotFoundException", "Use /{apiId}/{stage}/{resourcePath}", 404);
      const api = this.api(match[1]); logApi = api; apiName = api.name.replace(/[^\x20-\x7E]/g, "") || api.id;
      const stageName = decodeURIComponent(match[2]); metricStage = stageName; const requestPath = match[3] ?? "/";
      const stage = api.stages[stageName]; logStage = stage; if (!stage) throw new AwsError("MissingAuthenticationTokenException", "Missing Authentication Token", 403); methodSetting = stage.methodSettings?.["*/*"] ?? {};
      const selected = this.chooseCanary(api, stage); canary = selected.canary; const snapshot = selected.snapshot;
      const configuration = this.invocationConfiguration(api, snapshot); const routed = this.route(snapshot.resources, requestPath); const method = req.method?.toUpperCase() ?? "GET"; metricMethod = method; const selectedMethod = routed?.resource.methods[method] ? method : routed?.resource.methods.ANY ? "ANY" : method;
      const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value ?? ""])); const query = Object.fromEntries([...new Set([...url.searchParams.keys()])].map(key => [key, url.searchParams.get(key) ?? ""])); const multiQuery = Object.fromEntries([...new Set([...url.searchParams.keys()])].map(key => [key, url.searchParams.getAll(key)])); const principalContext = (req as any).awsPrincipal as PrincipalContext | undefined; const principal = principalContext?.principalArn;
      logInput = { method, path: requestPath, headers, query, multiQuery, pathParameters: routed?.parameters ?? {}, body: Buffer.alloc(0), stageName, stageVariables: selected.variables, requestId: invocationRequestId, deploymentId: selected.deploymentId, isCanaryRequest: canary, sourceIp: req.socket.remoteAddress?.replace(/^::ffff:/, ""), userAgent: headers["user-agent"], domainName: headers.host, principal, principalContext, lambdaLineage: principalContext?.lambdaLineage, identityAuthorization: (req as any).awsIdentityAuthorization };
      if (!routed?.resource.integrations[selectedMethod]) throw new AwsError("MissingAuthenticationTokenException", "Missing Authentication Token", 403);
      metricResource = routed.resource.path; methodSetting = this.methodSetting(stage, routed.resource.path, selectedMethod); this.enforceThrottle(api, stage, routed.resource, selectedMethod); logInput.body = await readBody(req);
      let result = await this.pipeline(api, routed.resource, selectedMethod, logInput, configuration, snapshot.authorizers, snapshot.policy, { stage, setting: methodSetting, enabled: this.methodCacheEnabled(stage, routed.resource.path, selectedMethod, methodSetting, canary) });
      result = this.compressResponse(result, headers["accept-encoding"], configuration.minimumCompressionSize);
      await Promise.all([this.publishInvocationMetrics(apiName, stageName, result.status, result.latency, result.integrationLatency, metricResource, metricMethod, methodSetting, canary, result.cacheStatus), this.writeInvocationLogs(api, stage, logInput, methodSetting, result.status, result.body.length, result)]).catch(() => undefined);
      res.setHeader("x-amzn-requestid", invocationRequestId); res.setHeader("x-amz-apigw-id", invocationRequestId.slice(0, 16));
      res.statusCode = result.status; for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value); if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json"); res.end(result.body);
    } catch (error) {
      const status = this.gatewayErrorStatus(error); const work: Array<Promise<unknown>> = []; if (apiName && metricStage) work.push(this.publishInvocationMetrics(apiName, metricStage, status, performance.now() - started, undefined, metricResource, metricMethod, methodSetting, canary)); if (logApi && logStage && logInput) work.push(this.writeInvocationLogs(logApi, logStage, logInput, methodSetting, status, 0, undefined, error)); await Promise.all(work).catch(() => undefined); if (status === 429) res.setHeader("retry-after", "1"); res.setHeader("x-amzn-requestid", invocationRequestId); res.setHeader("x-amz-apigw-id", invocationRequestId.slice(0, 16));
      this.sendInvocationError(req, res, pathname, error, invocationRequestId);
    }
  }

  async invokeEventBridgeTarget(input: {
    targetArn: string;
    payload: string;
    ruleArn: string;
    roleArn?: string;
    pathParameterValues?: string[];
    queryStringParameters?: Record<string, string>;
    headerParameters?: Record<string, string>;
    deliveryLineage?: string[];
  }): Promise<{ statusCode: number }> {
    const match = /^arn:aws:execute-api:([^:]+):(\d{12}):([^/]+)\/([^/]+)\/([A-Za-z*]+)(?:\/(.*))?$/.exec(input.targetArn);
    if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("ResourceNotFoundException", `API Gateway target ${input.targetArn} does not exist.`, 404);
    const api = this.api(match[3]);
    const stageName = decodeURIComponent(match[4]);
    const method = match[5].toUpperCase();
    if (method === "*" || !/^(?:ANY|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/.test(method)) throw new AwsError("BadRequestException", "An EventBridge API Gateway target must specify a concrete HTTP method.", 400);
    const stage = api.stages[stageName];
    if (!stage) throw new AwsError("MissingAuthenticationTokenException", "Missing Authentication Token", 403);
    const values = (input.pathParameterValues ?? []).map(String);
    const targetPath = match[6] ?? "";
    const wildcardCount = [...targetPath].filter(character => character === "*").length;
    if (values.length !== wildcardCount) throw new AwsError("BadRequestException", `HttpParameters.PathParameterValues must contain exactly ${wildcardCount} value(s).`, 400);
    let valueIndex = 0;
    const requestPath = `/${targetPath.replace(/\*/g, () => encodeURIComponent(values[valueIndex++]))}`.replace(/\/$/, "") || "/";
    const selected = this.chooseCanary(api, stage);
    const snapshot = selected.snapshot;
    const configuration = this.invocationConfiguration(api, snapshot);
    const routed = this.route(snapshot.resources, requestPath);
    const configuredMethod = routed?.resource.methods[method] ? method : routed?.resource.methods.ANY ? "ANY" : method;
    if (!routed?.resource.integrations[configuredMethod]) throw new AwsError("MissingAuthenticationTokenException", "Missing Authentication Token", 403);
    const resource = routed.resource;
    const apiMethod = resource.methods[configuredMethod];
    const methodArn = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${api.id}/${stageName}/${method}/${requestPath.replace(/^\//, "")}`;
    let identityAuthorization: AuthorizationResult | undefined;
    if (input.roleArn) {
      identityAuthorization = evaluateRoleAuthorization(this.store.ensureAccount().iam, input.roleArn, "execute-api:Invoke", methodArn, roleSessionAuthorizationContext(input.roleArn, this.region, this.clock.now(), { "aws:SourceArn": input.ruleArn, "aws:SourceAccount": this.store.accountId }));
      if (identityAuthorization.decision !== "allowed") throw new AwsError("AccessDeniedException", `EventBridge target role ${input.roleArn} cannot invoke ${methodArn}.`, 403);
    }
    else if (apiMethod.authorizationType === "AWS_IAM") throw new AwsError("AccessDeniedException", "An AWS_IAM API Gateway target requires an authorized EventBridge target role.", 403);
    const headers: Record<string, string> = { "content-type": "application/json", ...Object.fromEntries(Object.entries(input.headerParameters ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)])) };
    const query = Object.fromEntries(Object.entries(input.queryStringParameters ?? {}).map(([name, value]) => [name, String(value)]));
    const invocation: InvocationInput = {
      method,
      path: requestPath,
      headers,
      query,
      multiQuery: Object.fromEntries(Object.entries(query).map(([name, value]) => [name, [value]])),
      pathParameters: routed.parameters,
      body: Buffer.from(input.payload),
      stageName,
      stageVariables: selected.variables,
      requestId: id(24),
      deploymentId: selected.deploymentId,
      isCanaryRequest: selected.canary,
      userAgent: "Amazon/EventBridge",
      domainName: `${api.id}.execute-api.${this.region}.amazonaws.com`,
      principal: input.roleArn ?? "events.amazonaws.com",
      identityAuthorization,
      sourceArn: input.ruleArn,
      sourceAccount: this.store.accountId,
      lambdaLineage: input.deliveryLineage,
    };
    const setting = this.methodSetting(stage, resource.path, configuredMethod);
    const apiName = api.name.replace(/[^\x20-\x7E]/g, "") || api.id;
    const started = performance.now();
    try {
      this.enforceThrottle(api, stage, resource, configuredMethod);
      const result = await this.withTimeout(this.pipeline(api, resource, configuredMethod, invocation, configuration, snapshot.authorizers, snapshot.policy, { stage, setting, enabled: this.methodCacheEnabled(stage, resource.path, configuredMethod, setting, selected.canary) }), 5_000);
      await Promise.all([
        this.publishInvocationMetrics(apiName, stageName, result.status, result.latency, result.integrationLatency, resource.path, method, setting, selected.canary, result.cacheStatus),
        this.writeInvocationLogs(api, stage, invocation, setting, result.status, result.body.length, result),
      ]).catch(() => undefined);
      return { statusCode: result.status };
    } catch (error) {
      const status = this.gatewayErrorStatus(error);
      await Promise.all([
        this.publishInvocationMetrics(apiName, stageName, status, performance.now() - started, undefined, resource.path, method, setting, selected.canary),
        this.writeInvocationLogs(api, stage, invocation, setting, status, 0, undefined, error),
      ]).catch(() => undefined);
      throw error;
    }
  }

  sendInvocationError(req: IncomingMessage, res: ServerResponse, pathname: string, error: unknown, requestId = id(24)): void {
    if (res.headersSent) { res.end(); return; }
    const match = pathname.match(/^\/([^/]+)\/([^/]+)/); const api = match ? this.apis[match[1]] : undefined; const stage = api && match ? api.stages[decodeURIComponent(match[2])] : undefined; const snapshot = api && stage ? api.deployments[stage.deploymentId]?.snapshot : undefined; const configuration: InvocationConfiguration = api ? this.invocationConfiguration(api, snapshot) : { binaryMediaTypes: [], gatewayResponses: {}, models: {}, requestValidators: {}, apiKeySource: "HEADER" };
    const responseType = this.gatewayResponseType(error); const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); const defaultType = this.gatewayErrorStatus(error) >= 500 ? "DEFAULT_5XX" : "DEFAULT_4XX"; const specific = configuration.gatewayResponses[responseType]; const fallback = configuration.gatewayResponses[defaultType]; const customized = specific ?? fallback;
    const status = Number(specific?.statusCode ?? fallback?.statusCode ?? GATEWAY_RESPONSE_STATUS[responseType] ?? aws.status); const values: Record<string, string> = { "$context.error.messageString": JSON.stringify(aws.message), "$context.error.message": aws.message, "$context.error.responseType": responseType, "$context.status": String(status), "$context.requestId": requestId };
    const substitute = (value: string): string => Object.entries(values).reduce((result, [token, replacement]) => result.split(token).join(replacement), value);
    const templates = customized?.responseTemplates ?? {}; const accept = mediaType(Array.isArray(req.headers.accept) ? req.headers.accept[0] : req.headers.accept); const selectedType = Object.keys(templates).find(type => mediaType(type) === accept) ?? (templates["application/json"] !== undefined ? "application/json" : Object.keys(templates)[0]) ?? "application/json"; const template = templates[selectedType] ?? DEFAULT_GATEWAY_TEMPLATE;
    res.statusCode = status; res.setHeader("content-type", selectedType);
    for (const [target, source] of Object.entries(customized?.responseParameters ?? {})) { const name = target.replace(/^gatewayresponse\.header\./, ""); const unquoted = /^'.*'$/.test(source) ? source.slice(1, -1) : substitute(source); res.setHeader(name, unquoted); }
    res.end(substitute(template));
  }

  private gatewayResponseType(error: unknown): string {
    if (error instanceof GatewayFailure) return error.responseType;
    const code = error instanceof AwsError ? error.code : "InternalFailure";
    if (["MissingAuthenticationTokenException", "NotFoundException"].includes(code)) return "MISSING_AUTHENTICATION_TOKEN";
    if (code === "AccessDeniedException") return "ACCESS_DENIED"; if (code === "UnauthorizedException") return "UNAUTHORIZED";
    if (code === "AuthorizerConfigurationException") return "AUTHORIZER_CONFIGURATION_ERROR"; if (code === "AuthorizerFailureException") return "AUTHORIZER_FAILURE";
    if (code === "RequestExpired") return "EXPIRED_TOKEN"; if (["SignatureDoesNotMatch", "IncompleteSignature", "InvalidSignatureException", "InvalidSignature"].includes(code)) return "INVALID_SIGNATURE";
    if (code === "UnsupportedMediaTypeException") return "UNSUPPORTED_MEDIA_TYPE"; if (code === "RequestEntityTooLargeException") return "REQUEST_TOO_LARGE";
    if (["TooManyRequestsException", "ThrottlingException", "ThrottledException"].includes(code)) return "THROTTLED"; if (code === "LimitExceededException") return "QUOTA_EXCEEDED";
    if (code === "IntegrationFailureException") return error instanceof AwsError && /timed out/i.test(error.message) ? "INTEGRATION_TIMEOUT" : "INTEGRATION_FAILURE";
    if (code === "BadRequestException") return "BAD_REQUEST_PARAMETERS";
    return error instanceof AwsError && error.status < 500 ? "DEFAULT_4XX" : "DEFAULT_5XX";
  }
  private gatewayErrorStatus(error: unknown): number { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", String(error), 500); return GATEWAY_RESPONSE_STATUS[this.gatewayResponseType(error)] ?? aws.status; }
  private compressResponse(result: PipelineResult, acceptEncoding: string | undefined, minimumCompressionSize: number | undefined): PipelineResult {
    if (minimumCompressionSize === undefined || result.body.length < minimumCompressionSize || result.body.length === 0 || Object.keys(result.headers).some(name => name.toLowerCase() === "content-encoding")) return result;
    const accepted = new Map(String(acceptEncoding ?? "").split(",").map(part => { const [name, ...parameters] = part.trim().toLowerCase().split(";"); const q = Number(parameters.find(value => value.trim().startsWith("q="))?.trim().slice(2) ?? 1); return [name, Number.isFinite(q) ? q : 0] as const; })); const gzip = accepted.get("gzip") ?? accepted.get("*") ?? 0; const deflate = accepted.get("deflate") ?? accepted.get("*") ?? 0; if (gzip <= 0 && deflate <= 0) return result;
    const encoding = gzip >= deflate ? "gzip" : "deflate"; const headers: Record<string, string> = { ...result.headers, "content-encoding": encoding }; const varyName = Object.keys(headers).find(name => name.toLowerCase() === "vary") ?? "vary"; headers[varyName] = headers[varyName] ? `${headers[varyName]}, Accept-Encoding` : "Accept-Encoding"; for (const name of Object.keys(headers)) if (name.toLowerCase() === "content-length") delete headers[name]; return { ...result, headers, body: encoding === "gzip" ? gzipSync(result.body) : deflateSync(result.body) };
  }

  private async publishInvocationMetrics(apiName: string, stage: string, status: number, latency: number, integrationLatency?: number, resource?: string, method?: string, setting: ApiMethodSettingState = {}, canary = false, cacheStatus?: "hit" | "miss"): Promise<void> {
    if (!this.telemetry) return; const at = this.clock.now(); const dimensions: Array<Record<string, string>> = [{ ApiName: apiName }, { ApiName: apiName, Stage: stage }]; if (setting.metricsEnabled && resource && method) dimensions.push({ ApiName: apiName, Stage: stage, Resource: resource, Method: method }); if (canary) dimensions.push({ ApiName: apiName, Stage: stage, Canary: "true" });
    const events: Array<Promise<void>> = []; for (const values of dimensions) {
      events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "Count", dimensions: values, value: 1, unit: "Count", timestamp: at }));
      events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "Latency", dimensions: values, value: latency, unit: "Milliseconds", timestamp: at }));
      if (integrationLatency !== undefined) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "IntegrationLatency", dimensions: values, value: integrationLatency, unit: "Milliseconds", timestamp: at }));
      if (status >= 400 && status < 500) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "4XXError", dimensions: values, value: 1, unit: "Count", timestamp: at }));
      if (status >= 500) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: "5XXError", dimensions: values, value: 1, unit: "Count", timestamp: at }));
      if (cacheStatus) events.push(this.telemetry.publish({ namespace: "AWS/ApiGateway", metricName: cacheStatus === "hit" ? "CacheHitCount" : "CacheMissCount", dimensions: values, value: 1, unit: "Count", timestamp: at }));
    }
    await Promise.all(events);
  }

  private async putGatewayLog(groupName: string, streamName: string, message: string): Promise<void> {
    const roleArn = this.account.cloudwatchRoleArn; if (!this.logs || !roleArn) return; const iam = this.store.ensureAccount().iam; const role = Object.values(iam.roles).find(candidate => candidate.arn === roleArn);
    if (!role || evaluateTrust(role.assumeRolePolicyDocument, "apigateway.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "apigateway.amazonaws.com" }).decision !== "allowed") return;
    await this.logs.deliverServiceEvents(
      { logGroupName: groupName, logStreamName: streamName, logEvents: [{ timestamp: this.clock.now(), message }] },
      (action, resource) => evaluateRoleAuthorization(iam, roleArn, action, resource).decision === "allowed",
    ).catch(() => false);
  }

  private accessLogGroup(destinationArn: string | undefined, canary: boolean): string | undefined { const group = destinationArn?.match(/:log-group:([^:*]+)(?::\*)?$/)?.[1]; return group ? `${group}${canary ? "/Canary" : ""}` : undefined; }

  private accessLogMessage(format: string, values: Record<string, unknown>): string {
    const bracketed = format.replace(/\$context\.authorizer\.claims\[['"]([^'"]+)['"]\]/g, (_match, key) => {
      const value = values[`authorizer.claims.${key}`];
      return value === undefined || value === null ? "-" : String(value);
    });
    return bracketed.replace(/\$context\.([A-Za-z0-9_.-]+)/g, (_match, key) => { const value = values[key]; return value === undefined || value === null ? "-" : String(value); });
  }

  private async writeInvocationLogs(api: RestApiState, stage: ApiStageState, input: InvocationInput, setting: ApiMethodSettingState, status: number, responseLength: number, result?: PipelineResult, error?: unknown): Promise<void> {
    const canary = input.isCanaryRequest ?? false; const now = this.clock.now(); const extendedRequestId = input.requestId.slice(0, 16); const stream = `${new Date(now).toISOString().slice(0, 10).replace(/-/g, "/")}/${input.requestId}`; const aws = error instanceof AwsError ? error : error ? new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), status) : undefined;
    if (setting.loggingLevel === "INFO" || setting.loggingLevel === "ERROR" && status >= 400) { let message = result?.log ?? [`Starting execution for request: ${input.requestId}`, `HTTP Method: ${input.method}, Resource Path: ${input.path}`, `Execution failed with status ${status}: ${aws?.message ?? "Unknown error"}`].join("\n"); if (!setting.dataTraceEnabled) message = message.split("\n").filter(line => !/body (?:after|before) transformations:/i.test(line)).join("\n"); const correlation = { timestamp: new Date(now).toISOString(), apiGatewayRequestId: input.requestId, apiGatewayExtendedRequestId: extendedRequestId, apiId: api.id, stage: stage.stageName, ...(result?.serviceLogCorrelation ?? {}) }; await this.putGatewayLog(`API-Gateway-Execution-Logs_${api.id}/${stage.stageName}${canary ? "/Canary" : ""}`, stream, `STACKSIM-SERVICE-CORRELATION ${JSON.stringify(correlation)}\n${message}`); }
    const access = stage.accessLogSettings; const group = this.accessLogGroup(access?.destinationArn, canary); if (!group || !access?.format) return; const sourceIp = input.sourceIp ?? "-"; const userArn = input.principal ?? "-"; const values: Record<string, unknown> = {
      accountId: this.store.accountId, apiId: api.id, deploymentId: input.deploymentId, domainName: input.domainName, domainPrefix: input.domainName?.split(".")[0], extendedRequestId, httpMethod: input.method, integrationLatency: result?.integrationLatency, integrationStatus: result?.status, integrationErrorMessage: aws?.message, isCanaryRequest: canary, path: `/${stage.stageName}${input.path}`, protocol: "HTTP/1.1", requestId: input.requestId, requestTime: new Date(now).toUTCString(), requestTimeEpoch: now, resourcePath: input.path, responseLatency: result?.latency, stage: stage.stageName, status, responseLength, "integration.requestId": result?.serviceLogCorrelation?.lambdaRequestId,
      "identity.sourceIp": sourceIp, "identity.userAgent": input.userAgent ?? "-", "identity.caller": userArn, "identity.user": userArn, "identity.userArn": userArn, "identity.apiKey": input.apiKeyValue, "identity.apiKeyId": input.apiKeyId, "integration.status": result?.status, "integration.integrationStatus": result?.status, "integration.error": aws?.message, "error.message": aws?.message, "error.messageString": aws ? JSON.stringify(aws.message) : undefined, "error.responseType": error ? this.gatewayResponseType(error) : undefined, ...(result?.accessLogValues ?? {}),
    }; await this.putGatewayLog(group, stream, this.accessLogMessage(access.format, values));
  }

  private async pipeline(api: RestApiState, resource: ApiResource, configuredMethod: string, input: InvocationInput, configuration: InvocationConfiguration, authorizers: Record<string, ApiAuthorizerState> = {}, resourcePolicy?: PolicyDocument, cache?: InvocationCacheConfiguration): Promise<PipelineResult> {
    const started = performance.now(); const log: string[] = [`Starting execution for request: ${input.requestId}`, `HTTP Method: ${input.method}, Resource Path: ${resource.path}`]; const method = resource.methods[configuredMethod]; const integration = resource.integrations[configuredMethod]; if (!method || !integration) throw new AwsError("MissingAuthenticationTokenException", "Missing Authentication Token", 403);
    const validator = method.requestValidatorId ? configuration.requestValidators[method.requestValidatorId] : undefined;
    if (method.requestValidatorId && !validator) throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", "Invalid request validator configuration", 500);
    if (validator?.validateRequestParameters) this.validateRequestParameters(method, input);
    if (validator?.validateRequestBody) this.validateRequestBody(method, input, configuration.models);
    const methodArn = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${api.id}/${input.stageName}/${input.method}/${input.path.replace(/^\//, "")}`;
    const resourceAuthorization = resourcePolicy ? evaluateResourcePolicy(this.expandApiPolicy(resourcePolicy, api.id), input.principalContext ?? input.principal ?? "anonymous", "execute-api:Invoke", methodArn, { "aws:SourceIp": input.sourceIp, "aws:PrincipalArn": input.principal, "aws:SourceArn": input.sourceArn, "aws:SourceAccount": input.sourceAccount, "aws:TokenIssueTime": input.principalContext?.issuedAt === undefined ? undefined : new Date(input.principalContext.issuedAt).toISOString(), "aws:SourceIdentity": input.principalContext?.sourceIdentity }) : undefined;
    let authorizerContext: Record<string, unknown> = {}; let principalId: string | undefined; let usageIdentifierKey: string | undefined; let bearerDigest: string | undefined;
    if (method.authorizationType === "AWS_IAM") { const identityAuthorization = this.authMode !== "enforce" || input.stageName === "test-invoke-stage" ? { decision: "allowed", reason: "IAM policy enforcement is disabled", matchedStatements: [] } as AuthorizationResult : input.identityAuthorization ?? { decision: "implicitDeny", reason: "No authenticated IAM authorization decision is available", matchedStatements: [] }; const combined = resourceAuthorization ? combineIdentityAndResourceAuthorization(identityAuthorization, resourceAuthorization, input.principalContext?.accountId === this.store.accountId ? "sameAccount" : "crossAccount") : identityAuthorization; if (combined.decision !== "allowed") throw new AwsError("AccessDeniedException", "User is not authorized to access this resource", 403); }
    else if (method.authorizationType === "CUSTOM" || method.authorizationType === "COGNITO_USER_POOLS") { const authorizer = authorizers[method.authorizerId ?? ""]; if (!authorizer) throw new AwsError(method.authorizationType === "COGNITO_USER_POOLS" ? "AuthorizerConfigurationException" : "UnauthorizedException", method.authorizationType === "COGNITO_USER_POOLS" ? "Cognito authorizer configuration is unavailable" : "Unauthorized", method.authorizationType === "COGNITO_USER_POOLS" ? 500 : 401); const result = await this.runAuthorizer(api, authorizer, input, methodArn, method); this.requireCombinedAuthorization(result.authorization, resourceAuthorization); authorizerContext = result.context; principalId = result.principalId; usageIdentifierKey = result.usageIdentifierKey; bearerDigest = result.bearerDigest; }
    else if (resourceAuthorization && resourceAuthorization.decision !== "allowed") throw new AwsError("AccessDeniedException", "User is not authorized to access this resource", 403);
    const apiKey = await this.enforceApiKey(api, resource, method, configuredMethod, input, configuration.apiKeySource, usageIdentifierKey);
    const context = { resourceId: resource.id, resourcePath: resource.path, httpMethod: input.method, path: `/${input.stageName}${input.path}`, stage: input.stageName, requestId: input.requestId, deploymentId: input.deploymentId, isCanaryRequest: input.isCanaryRequest ?? false, identity: { sourceIp: input.sourceIp, userAgent: input.userAgent ?? "", apiKey: apiKey?.value, apiKeyId: apiKey?.id }, domainName: input.domainName, apiId: api.id, authorizer: { principalId, ...authorizerContext } };
    const requestBinary = matchesMediaType(input.headers["content-type"], configuration.binaryMediaTypes); const vtl: VtlContext = { body: requestBinary ? input.body.toString("base64") : input.body.toString("utf8"), headers: input.headers, query: input.query, path: input.pathParameters, context, stageVariables: input.stageVariables };
    const accessLogValues = Object.fromEntries(Object.entries((authorizerContext.claims as Record<string, unknown> | undefined) ?? {}).map(([name, value]) => [`authorizer.claims.${name}`, value]));
    const mapped = this.integrationRequest(integration, input, vtl, configuration); const cacheControl = cache?.enabled ? this.cacheControl(input, cache.setting, methodArn) : { invalidate: false }; const cacheKey = cache?.enabled ? this.responseCacheKey(resource, method, configuredMethod, integration, input, mapped, principalId, apiKey?.id, bearerDigest) : undefined; const cacheState = cacheKey ? this.stageCache(api.id, input.stageName) : undefined;
    let cacheAuthenticationFailed = false;
    if (cacheKey && cacheState) {
      if (cacheControl.invalidate) {
        if (cacheState.entries[cacheKey]) { delete cacheState.entries[cacheKey]; await this.store.save(); }
      } else {
        const cached = cacheState.entries[cacheKey];
        if (cached && cached.expiresAt > this.clock.now() && cached.deploymentId === input.deploymentId) {
          if (!cached.encrypted) return { ...this.cachedPipelineResult(cached.response, started, cacheControl.warning), accessLogValues };
          try {
            const binding = this.cacheBinding(api.id, input.stageName, cacheKey, cached);
            const decrypted = this.cacheCrypto.decrypt(cached.envelope, binding);
            if (decrypted.needsRotation) {
              cached.envelope = this.cacheCrypto.encrypt(decrypted.response, binding);
              await this.store.save();
            }
            return { ...this.cachedPipelineResult(decrypted.response, started, cacheControl.warning), accessLogValues };
          } catch (error) {
            if (!(error instanceof ApiGatewayCacheSecurityError)) throw error;
            delete cacheState.entries[cacheKey];
            await this.store.save();
            cacheAuthenticationFailed = true;
            log.push(`Encrypted response cache entry ${cacheKey} failed authentication and was evicted`);
          }
        } else if (cached) {
          delete cacheState.entries[cacheKey];
          await this.store.save();
        }
      }
    }
    log.push(`Endpoint request body after transformations: ${mapped.body.toString("utf8")}`); let backend: BackendResult;
    try { backend = await this.withTimeout(this.callBackend(api, resource, integration, input, mapped, context, configuration), integration.timeoutInMillis ?? 29_000); }
    catch (error) { if (error instanceof GatewayFailure) throw error; const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); if (aws.code === "AccessDeniedException") throw aws; throw new GatewayFailure(aws.code === "IntegrationFailureException" && /timed out/i.test(aws.message) ? "INTEGRATION_TIMEOUT" : "INTEGRATION_FAILURE", aws.code, aws.message, aws.status); }
    if (backend.serviceLogCorrelation) log.push(`Lambda invocation: ${backend.serviceLogCorrelation.functionName}, RequestId: ${backend.serviceLogCorrelation.lambdaRequestId}`); log.push(`Endpoint response body before transformations: ${backend.body.toString("utf8")}`); const result = this.integrationResponse(method, integration, backend, vtl, input, configuration); log.push(`Method completed with status: ${result.status}`); const pipeline: PipelineResult = { ...result, headers: { ...result.headers, ...(cacheControl.warning ? { Warning: cacheControl.warning } : {}) }, latency: performance.now() - started, integrationLatency: backend.latency, log: log.join("\n"), accessLogValues, ...(backend.serviceLogCorrelation ? { serviceLogCorrelation: backend.serviceLogCorrelation } : {}), ...(cache?.enabled ? { cacheStatus: "miss" as const } : {}) };
    if (cacheKey && cacheState && !cacheAuthenticationFailed && pipeline.status < 400 && pipeline.body.length <= 1_048_576) {
      const response: ApiGatewayCachedResponseState = { status: pipeline.status, body: pipeline.body.toString("base64"), headers: result.headers };
      const metadata = { expiresAt: this.clock.now() + (cache!.setting.cacheTtlInSeconds ?? 300) * 1_000, deploymentId: input.deploymentId!, method: configuredMethod, namespace: integration.cacheNamespace ?? resource.id };
      if (cache!.setting.cacheDataEncrypted) {
        try {
          cacheState.entries[cacheKey] = { ...metadata, encrypted: true, envelope: this.cacheCrypto.encrypt(response, this.cacheBinding(api.id, input.stageName, cacheKey, metadata)) };
        } catch (error) {
          if (!(error instanceof ApiGatewayCacheSecurityError)) throw error;
          pipeline.log += `\nEncrypted response cache entry ${cacheKey} was not stored because the installation keyring is unavailable`;
        }
      } else cacheState.entries[cacheKey] = { ...metadata, encrypted: false, response };
      if (cacheState.entries[cacheKey]) await this.store.save();
    }
    return pipeline;
  }
  private validateRequestParameters(method: ApiMethodState, input: InvocationInput): void { for (const [name, required] of Object.entries(method.requestParameters ?? {})) if (required) { const [, , location, key] = name.split("."); const found = location === "path" ? input.pathParameters[key] : location === "querystring" ? input.query[key] : location === "header" ? input.headers[key.toLowerCase()] : undefined; if (found === undefined || found === "") throw new GatewayFailure("BAD_REQUEST_PARAMETERS", "BadRequestException", `Missing required request parameter: ${key}`, 400); } }
  private validateRequestBody(method: ApiMethodState, input: InvocationInput, models: Record<string, ApiModelState>): void {
    const contentType = mediaType(input.headers["content-type"]) || "application/json";
    const modelName = Object.entries(method.requestModels ?? {}).find(([type]) => mediaType(type) === contentType)?.[1] ?? method.requestModels?.$default;
    if (!modelName) return;
    if (!models[modelName]) throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", `Invalid request model configuration: ${modelName}`, 500);
    let body: unknown; try { body = JSON.parse(input.body.toString("utf8")); } catch { throw new GatewayFailure("BAD_REQUEST_BODY", "BadRequestException", "Invalid request body: malformed JSON", 400); }
    let failures: string[]; try { failures = validateJsonModel(body, modelName, models); } catch (error) { throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", error instanceof Error ? error.message : String(error), 500); }
    if (failures.length) throw new GatewayFailure("BAD_REQUEST_BODY", "BadRequestException", `Invalid request body: ${failures.join("; ")}`, 400);
  }
  private integrationRequest(integration: ApiIntegrationState, input: InvocationInput, vtl: VtlContext, configuration: InvocationConfiguration): { body: Buffer; headers: Record<string, string>; query: Record<string, string>; path: Record<string, string> } {
    const headers = { ...input.headers }; const query = { ...input.query }; const path = { ...input.pathParameters }; for (const [target, source] of Object.entries(integration.requestParameters ?? {})) { const value = this.mappingValue(source, input, vtl); const [, , location, key] = target.split("."); if (location === "header") headers[key.toLowerCase()] = value; else if (location === "querystring") query[key] = value; else if (location === "path") path[key] = value; }
    if (integration.type === "AWS_PROXY" || integration.type === "HTTP_PROXY") return { body: input.body, headers, query, path };
    const requestBinary = matchesMediaType(input.headers["content-type"], configuration.binaryMediaTypes); const contentType = mediaType(input.headers["content-type"]) || "application/json"; const templates = integration.requestTemplates ?? {}; const template = Object.entries(templates).find(([type]) => mediaType(type) === contentType)?.[1]; const hasTemplates = Object.keys(templates).length > 0; let body = input.body;
    if (template !== undefined) body = Buffer.from(renderVtl(template, vtl)); else if (integration.passthroughBehavior === "NEVER" || integration.passthroughBehavior === "WHEN_NO_TEMPLATES" && hasTemplates) throw new GatewayFailure("UNSUPPORTED_MEDIA_TYPE", "UnsupportedMediaTypeException", "Unsupported Media Type", 415);
    if (integration.contentHandling === "CONVERT_TO_BINARY" && (template !== undefined || !requestBinary)) body = decodeBase64(body);
    else if (integration.contentHandling === "CONVERT_TO_TEXT" && template === undefined && requestBinary) body = Buffer.from(body.toString("base64"));
    return { body, headers, query, path };
  }
  private mappingValue(source: string, input: InvocationInput, vtl: VtlContext): string { if (/^'.*'$/.test(source)) return source.slice(1, -1); if (source.startsWith("method.request.header.")) return input.headers[source.slice(22).toLowerCase()] ?? ""; if (source.startsWith("method.request.querystring.")) return input.query[source.slice(27)] ?? ""; if (source.startsWith("method.request.path.")) return input.pathParameters[source.slice(20)] ?? ""; if (source.startsWith("stageVariables.")) return input.stageVariables[source.slice(15)] ?? ""; if (source.startsWith("context.")) return String((vtl.context as any)[source.slice(8)] ?? ""); return source; }
  private sqsIntegrationRequest(uri: string, mapped: { body: Buffer; headers: Record<string, string> }): { operation: string; request: any } | undefined {
    const target = uri.match(/^arn:aws(?:-[a-z]+)?:apigateway:([^:]+):sqs:(action|path)\/(.+)$/);
    if (!target) return undefined;
    if (!this.sqs) throw new AwsError("BadGatewayException", "The SQS integration service is not available", 502);
    if (target[1] !== this.region) throw new AwsError("BadGatewayException", "The SQS integration must use the API Region", 502);
    if (target[2] === "path") {
      const path = target[3].split("/");
      if (path.length !== 2) throw new AwsError("BadGatewayException", "SQS path integrations require account-id/queue-name", 502);
      const [accountId, encodedQueueName] = path;
      let queueName: string;
      try { queueName = decodeURIComponent(encodedQueueName); } catch { throw new AwsError("BadGatewayException", "The SQS integration queue path is invalid", 502); }
      const parsed = sqsQueryRequest(mapped.body, accountId === this.store.accountId ? this.sqs.queueUrl(queueName) : undefined);
      if (accountId !== this.store.accountId) parsed.request.QueueUrl = `https://sqs.${this.region}.amazonaws.com/${accountId}/${encodeURIComponent(queueName)}`;
      return parsed;
    }
    const [operation, ...fixedParts] = target[3].split("&");
    if (!SQS_SEND_ACTIONS.has(operation)) throw new AwsError("BadGatewayException", `Unsupported SQS integration action ${operation}`, 502);
    const formRequest = mediaType(mapped.headers["content-type"]) === "application/x-www-form-urlencoded" || /^\s*Action=/.test(mapped.body.toString("utf8"));
    if (formRequest) {
      const parsed = sqsQueryRequest(mapped.body);
      if (parsed.operation !== operation) throw new AwsError("BadGatewayException", "SQS integration action does not match the request body", 502);
      return parsed;
    }
    let request: any;
    try { request = JSON.parse(mapped.body.toString("utf8") || "{}"); }
    catch { throw new AwsError("BadGatewayException", "AWS integration request must be JSON", 502); }
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new AwsError("BadGatewayException", "AWS integration request must be a JSON object", 502);
    if (fixedParts.length) Object.assign(request, parseAwsQuery(new URLSearchParams(fixedParts.join("&"))));
    return { operation, request };
  }
  private async callSqsIntegration(integration: ApiIntegrationState, uri: string, mapped: { body: Buffer; headers: Record<string, string> }, input: InvocationInput, started: number): Promise<BackendResult | undefined> {
    const target = this.sqsIntegrationRequest(uri, mapped);
    if (!target) return undefined;
    let queueArn: string;
    try { queueArn = this.sqs!.resolveQueueUrl(String(target.request.QueueUrl ?? "")).queueArn; }
    catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      return { status: aws.status, body: Buffer.from(JSON.stringify({ __type: aws.code, message: aws.message })), headers: { "content-type": "application/json" }, error: aws.code, latency: performance.now() - started };
    }
    if (!integration.credentials) throw new AwsError("AccessDeniedException", "API Gateway integration role is not authorized to send messages to the SQS queue", 500);
    try {
      const request = (({ QueueUrl: _queueUrl, ...message }) => message)(target.request);
      const caller = { kind: "role" as const, roleArn: integration.credentials, sourceAccount: this.store.accountId, deliveryLineage: input.lambdaLineage?.slice(-32) };
      const response = target.operation === "SendMessage"
        ? await this.sqs!.sendAuthorizedMessageToArn(queueArn, request, caller)
        : await this.sqs!.sendAuthorizedMessageBatchToArn(queueArn, request, caller);
      return { status: 200, body: Buffer.from(JSON.stringify(response)), headers: { "content-type": "application/json" }, latency: performance.now() - started };
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      if (aws.code === "AccessDeniedException") throw aws;
      return { status: aws.status, body: Buffer.from(JSON.stringify({ __type: aws.code, message: aws.message })), headers: { "content-type": "application/json" }, error: aws.code, latency: performance.now() - started };
    }
  }
  private async callBackend(api: RestApiState, resource: ApiResource, integration: ApiIntegrationState, input: InvocationInput, mapped: { body: Buffer; headers: Record<string, string>; query: Record<string, string>; path: Record<string, string> }, context: Record<string, unknown>, configuration: InvocationConfiguration): Promise<BackendResult> { const started = performance.now(); const uri = String(integration.uri ?? "").replace(/\$\{stageVariables\.([A-Za-z0-9_-]+)\}/g, (_m, name) => input.stageVariables[name] ?? "");
    if (integration.type === "MOCK") { let status = 200; try { status = Number(JSON.parse(mapped.body.toString("utf8") || "{}").statusCode ?? 200); } catch {} return { status, body: mapped.body, headers: {}, latency: performance.now() - started }; }
    if ((integration.type === "AWS_PROXY" || integration.type === "AWS") && uri.includes(":lambda:path/")) { const arn = uri.match(/functions\/(arn:[^/]+)\/invocations/)?.[1]; if (!arn) throw new AwsError("BadGatewayException", "Invalid Lambda integration URI", 502); if (integration.credentials && evaluateRoleAuthorization(this.store.ensureAccount().iam, integration.credentials, "lambda:InvokeFunction", arn).decision !== "allowed") throw new AwsError("AccessDeniedException", "API Gateway integration role is not authorized to invoke the Lambda function", 500); const sourceArn = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${api.id}/${input.stageName}/${input.method}/${input.path.replace(/^\//, "")}`; const requestBinary = matchesMediaType(input.headers["content-type"], configuration.binaryMediaTypes); const event = integration.type === "AWS_PROXY" ? { resource: resource.path, path: input.path, httpMethod: input.method, headers: input.headers, multiValueHeaders: Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key, [value]])), queryStringParameters: Object.keys(input.query).length ? input.query : null, multiValueQueryStringParameters: Object.keys(input.multiQuery).length ? input.multiQuery : null, pathParameters: Object.keys(input.pathParameters).length ? input.pathParameters : null, stageVariables: input.stageVariables, requestContext: context, body: input.body.length ? input.body.toString(requestBinary ? "base64" : "utf8") : null, isBase64Encoded: requestBinary } : JSON.parse(mapped.body.toString("utf8") || "null"); const lambdaRequestId = id(24); const functionName = arn.split(":function:")[1]?.split(":")[0] ?? arn; const serviceLogContext = { apiGatewayRequestId: input.requestId, apiGatewayExtendedRequestId: input.requestId.slice(0, 16), apiId: api.id, stage: input.stageName }; const result = await this.registry.dispatch("lambda", "Invoke", { arn, payload: Buffer.from(JSON.stringify(event)), requestId: lambdaRequestId, options: { principal: "apigateway.amazonaws.com", sourceArn, sourceAccount: this.store.accountId, enforceResourcePolicy: true, lineage: input.lambdaLineage, serviceLogContext } }, this.registryContext("lambda", "Invoke", input)) as InvokeResult; const serviceLogCorrelation = { lambdaRequestId: result.requestId, functionName }; if (integration.type === "AWS_PROXY") { if (result.functionError) throw new AwsError("InternalServerErrorException", "Lambda execution failed", 502); let response: any; try { response = JSON.parse(result.payload.toString("utf8")); } catch { throw new AwsError("InternalServerErrorException", "Malformed Lambda proxy response", 502); } if (!Number.isInteger(response.statusCode)) throw new AwsError("InternalServerErrorException", "Malformed Lambda proxy response", 502); const headers: Record<string, string> = Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key, String(value)])); for (const [key, values] of Object.entries<any>(response.multiValueHeaders ?? {})) headers[key] = Array.isArray(values) ? values.join(",") : String(values); const encoded = Buffer.from(String(response.body ?? "")); const body = response.isBase64Encoded ? (matchesMediaType(input.headers.accept, configuration.binaryMediaTypes) ? decodeBase64(encoded) : encoded) : encoded; return { status: response.statusCode, body, headers, latency: performance.now() - started, serviceLogCorrelation }; } return { status: result.functionError ? 500 : 200, body: result.payload, headers: {}, error: result.functionError ? result.payload.toString("utf8") : undefined, latency: performance.now() - started, serviceLogCorrelation }; }
    if (integration.type === "AWS") { const sqs = await this.callSqsIntegration(integration, uri, mapped, input, started); if (sqs) return sqs; const target = uri.match(/:([a-z0-9-]+):(?:action|path)\/?(.+)$/); if (!target) throw new AwsError("BadGatewayException", "Unsupported AWS integration URI", 502); const service = target[1]; const operation = target[2].replace(/^\//, ""); if (!this.registry.has(service, operation)) throw new AwsError("BadGatewayException", `AWS integration ${service}.${operation} is not available`, 502); let request: any; try { request = JSON.parse(mapped.body.toString("utf8") || "{}"); } catch { throw new AwsError("BadGatewayException", "AWS integration request must be JSON", 502); } if (integration.credentials) { const tableArn = request.TableName ? `arn:aws:dynamodb:${this.region}:${this.store.accountId}:table/${request.TableName}` : "*"; if (evaluateRoleAuthorization(this.store.ensureAccount().iam, integration.credentials, `${service}:${operation}`, tableArn).decision !== "allowed") throw new AwsError("AccessDeniedException", "API Gateway integration role is not authorized", 500); } try { const response = await this.registry.dispatch(service, operation, request, this.registryContext(service, operation, input)); return { status: 200, body: Buffer.from(JSON.stringify(response)), headers: { "content-type": "application/json" }, latency: performance.now() - started }; } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", String(error), 500); return { status: aws.status, body: Buffer.from(JSON.stringify({ __type: aws.code, message: aws.message })), headers: {}, error: aws.code, latency: performance.now() - started }; } }
    if (integration.type === "HTTP" || integration.type === "HTTP_PROXY") { if (process.env.STACKSIM_ALLOW_OUTBOUND_HTTP !== "true") throw new AwsError("BadGatewayException", "Outbound HTTP integrations are disabled; set STACKSIM_ALLOW_OUTBOUND_HTTP=true", 502); let target = new URL(uri); if (integration.connectionType === "VPC_LINK") { const link = this.vpcLink(integration.connectionId!); const configured = this.vpcLinkOrigin(link); if (link.status !== "AVAILABLE" || !configured) throw new AwsError("BadGatewayException", `VpcLink ${link.id} has no available local origin mapping`, 502); const logical = target; target = new URL(configured); target.pathname = `${target.pathname.replace(/\/$/, "")}${logical.pathname.startsWith("/") ? logical.pathname : `/${logical.pathname}`}` || "/"; target.search = logical.search; } if (integration.tlsConfig?.insecureSkipVerification) throw new AwsError("BadGatewayException", "insecureSkipVerification is not enabled for local outbound TLS", 502); await this.assertSafeHttpTarget(target); for (const [key, value] of Object.entries(mapped.path)) target.pathname = target.pathname.replace(`{${key}}`, encodeURIComponent(value)); for (const [key, value] of Object.entries(mapped.query)) target.searchParams.set(key, value); const controller = new AbortController(); const response = await fetch(target, { method: integration.integrationHttpMethod, headers: mapped.headers, body: ["GET", "HEAD"].includes(integration.integrationHttpMethod) ? undefined : new Uint8Array(mapped.body), redirect: "manual", signal: controller.signal }); return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: responseHeaders(response.headers), error: response.status >= 400 ? String(response.status) : undefined, latency: performance.now() - started }; }
    throw new AwsError("BadGatewayException", "Unsupported integration", 502);
  }
  private integrationResponse(method: ApiMethodState, integration: ApiIntegrationState, backend: BackendResult, vtl: VtlContext, input: InvocationInput, configuration: InvocationConfiguration): { status: number; body: Buffer; headers: Record<string, string> } {
    if (integration.type.endsWith("_PROXY")) return { status: backend.status, body: backend.body, headers: backend.headers };
    const candidates = Object.values(integration.responses ?? {}); const matchText = backend.error ?? String(backend.status); const selected = candidates.find(response => response.selectionPattern && (() => { try { return new RegExp(response.selectionPattern).test(matchText); } catch { return false; } })()) ?? integration.responses?.default ?? integration.responses?.[String(backend.status)] ?? candidates.find(response => !response.selectionPattern); if (!selected) throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", "No match for output mapping and no default output mapping configured", 500);
    const backendContentType = Object.entries(backend.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]; const backendBinary = matchesMediaType(backendContentType, configuration.binaryMediaTypes); const acceptBinary = matchesMediaType(input.headers.accept, configuration.binaryMediaTypes); const responseVtl = { ...vtl, body: backendBinary ? backend.body.toString("base64") : backend.body.toString("utf8") }; const templates = selected.responseTemplates ?? {}; const requestedType = mediaType(input.headers.accept); const sourceType = mediaType(backendContentType); const template = Object.entries(templates).find(([type]) => mediaType(type) === requestedType)?.[1] ?? Object.entries(templates).find(([type]) => mediaType(type) === sourceType)?.[1] ?? templates["application/json"] ?? Object.values(templates)[0]; let body = template === undefined ? backend.body : Buffer.from(renderVtl(template, responseVtl));
    if (selected.contentHandling === "CONVERT_TO_BINARY" && (template !== undefined || !backendBinary)) body = decodeBase64(body); else if (selected.contentHandling === "CONVERT_TO_TEXT") body = Buffer.from(body.toString("base64")); else if (selected.contentHandling === undefined && template === undefined && backendBinary && !acceptBinary) body = Buffer.from(body.toString("base64"));
    const headers: Record<string, string> = {}; for (const [target, source] of Object.entries(selected.responseParameters ?? {})) { const name = target.replace(/^method\.response\.header\./, ""); if (/^'.*'$/.test(source)) headers[name] = source.slice(1, -1); else if (source.startsWith("integration.response.header.")) { const sourceName = source.slice(28).toLowerCase(); headers[name] = Object.entries(backend.headers).find(([candidate]) => candidate.toLowerCase() === sourceName)?.[1] ?? ""; } }
    const status = Number(selected.statusCode); if (!method.responses?.[selected.statusCode]) throw new GatewayFailure("API_CONFIGURATION_ERROR", "InternalServerErrorException", "Invalid method response mapping", 500); return { status, body, headers };
  }
  private async runAuthorizer(
    api: RestApiState,
    authorizer: ApiAuthorizerState,
    input: InvocationInput,
    methodArn: string,
    method?: ApiMethodState,
  ): Promise<RestAuthorizerResult> {
    if (authorizer.type === "COGNITO_USER_POOLS") {
      return this.runCognitoAuthorizer(api, authorizer, input, method);
    }
    const identities = (authorizer.identitySource ?? "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
      .map(source => this.identityValue(source, input));
    if (identities.some(value => !value)) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    if (authorizer.identityValidationExpression && !new RegExp(authorizer.identityValidationExpression).test(identities[0] ?? "")) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const cacheKey = `${api.id}\0${input.stageName}\0${authorizer.id}\0${identities.join("\0")}`;
    const cached = this.authorizerCache.get(cacheKey);
    if (cached?.kind === "LAMBDA" && cached.expiresAt > this.clock.now()) {
    const authorization = evaluateIdentityPolicy(cached.value.policy, "execute-api:Invoke", methodArn);
      return { ...cached.value, authorization, allowed: authorization.decision === "allowed" };
    }
    const arn = authorizer.authorizerUri?.match(/functions\/(arn:[^/]+)\/invocations/)?.[1];
    if (!arn) throw new AwsError("AuthorizerConfigurationException", "Invalid authorizer URI", 500);
    if (authorizer.authorizerCredentials && evaluateRoleAuthorization(this.store.ensureAccount().iam, authorizer.authorizerCredentials, "lambda:InvokeFunction", arn).decision !== "allowed") throw new AwsError("AuthorizerConfigurationException", "API Gateway authorizer role is not authorized to invoke the Lambda function", 500);
    const sourceArn = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${api.id}/authorizers/${authorizer.id}`;
    const event = authorizer.type === "TOKEN"
      ? { type: "TOKEN", authorizationToken: identities[0], methodArn }
      : { type: "REQUEST", methodArn, resource: input.path, path: input.path, httpMethod: input.method, headers: input.headers, queryStringParameters: input.query, pathParameters: input.pathParameters, stageVariables: input.stageVariables, requestContext: { path: input.path, stage: input.stageName, requestId: input.requestId, identity: { sourceIp: input.sourceIp } } };
    let invocation: InvokeResult;
    try {
      invocation = await this.lambda.invoke(arn, Buffer.from(JSON.stringify(event)), id(24), { principal: "apigateway.amazonaws.com", sourceArn, sourceAccount: this.store.accountId, enforceResourcePolicy: true, lineage: input.lambdaLineage });
    } catch (error) {
      if (error instanceof AwsError && error.code === "AccessDeniedException") throw new AwsError("AuthorizerConfigurationException", "API Gateway is not authorized to invoke the authorizer Lambda function", 500);
      throw error;
    }
    if (invocation.functionError) throw new AwsError("AuthorizerFailureException", "Authorizer execution failed", 500);
    let output: any;
    try {
      output = JSON.parse(invocation.payload.toString("utf8"));
    } catch {
      throw new AwsError("AuthorizerConfigurationException", "Invalid authorizer response", 500);
    }
    if (!output.principalId || !output.policyDocument?.Statement) throw new AwsError("AuthorizerConfigurationException", "Authorizer response is missing principalId or policyDocument", 500);
    const context = output.context ?? {};
    if (Object.values(context).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value))) throw new AwsError("AuthorizerConfigurationException", "Authorizer context values must be scalar", 500);
    if (output.usageIdentifierKey !== undefined && typeof output.usageIdentifierKey !== "string") throw new AwsError("AuthorizerConfigurationException", "usageIdentifierKey must be a string", 500);
    const policy = output.policyDocument as PolicyDocument;
    const authorization = evaluateIdentityPolicy(policy, "execute-api:Invoke", methodArn);
    const result: RestAuthorizerResult = { principalId: String(output.principalId), context, policy, usageIdentifierKey: output.usageIdentifierKey as string | undefined, authorization, allowed: authorization.decision === "allowed" };
    if (authorizer.authorizerResultTtlInSeconds > 0) {
      this.authorizerCache.set(cacheKey, {
        kind: "LAMBDA",
        expiresAt: this.clock.now() + authorizer.authorizerResultTtlInSeconds * 1000,
        value: { principalId: result.principalId!, context, policy, usageIdentifierKey: result.usageIdentifierKey },
      });
    }
    return result;
  }

  private bearerToken(value: string): string {
    if (/^[^\s]+$/.test(value)) return value;
    const match = /^Bearer ([^\s]+)$/i.exec(value);
    if (!match) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    return match[1];
  }

  private cognitoAuthorizerError(error: unknown): never {
    if (error instanceof CognitoRestConfigurationError) throw new AwsError("AuthorizerConfigurationException", error.message, 500);
    if (error instanceof CognitoRestTokenError) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    throw error;
  }

  private async runCognitoAuthorizer(
    api: RestApiState,
    authorizer: ApiAuthorizerState,
    input: InvocationInput,
    method?: ApiMethodState,
  ): Promise<RestAuthorizerResult> {
    if (!this.cognitoVerifier) throw new AwsError("AuthorizerConfigurationException", "The Cognito verifier is unavailable", 500);
    const identity = this.identityValue(authorizer.identitySource ?? "", input);
    if (!identity) throw new AwsError("UnauthorizedException", "Unauthorized", 401);
    const token = this.bearerToken(identity);
    const bearerDigest = createHash("sha256").update(token).digest("hex");
    const expectedUse = method?.authorizationScopes?.length ? "access" : "id";
    const authorizationRequirement = createHash("sha256")
      .update(expectedUse)
      .update("\0")
      .update([...(method?.authorizationScopes ?? [])].sort().join("\0"))
      .digest("hex");
    const authorizerConfiguration = createHash("sha256")
      .update(JSON.stringify({
        providerARNs: authorizer.providerARNs ?? [],
        identitySource: authorizer.identitySource,
        identityValidationExpression: authorizer.identityValidationExpression,
      }))
      .digest("hex");
    const cacheKey = `${api.id}\0${input.stageName}\0${authorizer.id}\0${authorizerConfiguration}\0${authorizationRequirement}\0${bearerDigest}`;
    const cached = this.authorizerCache.get(cacheKey);
    if (cached?.kind === "COGNITO" && cached.expiresAt > this.clock.now()) {
      try {
        const version = await this.cognitoVerifier.cacheVersion([cached.userPoolArn]);
        if (version === cached.cacheVersion) {
          const authorization: AuthorizationResult = { decision: "allowed", reason: "Cognito token verified", matchedStatements: [] };
          return { ...cached.value, authorization, allowed: true };
        }
      } catch (error) {
        this.cognitoAuthorizerError(error);
      }
      this.authorizerCache.delete(cacheKey);
    }
    try {
      const verified = await this.cognitoVerifier.verify({
        token,
        allowedUserPoolArns: authorizer.providerARNs ?? [],
        expectedUse,
        audienceExpression: expectedUse === "id" ? authorizer.identityValidationExpression : undefined,
        requiredScopes: expectedUse === "access" ? method?.authorizationScopes : undefined,
      });
      if (!verified.userPoolArn) {
        throw new CognitoRestConfigurationError("The Cognito verifier did not identify its user pool");
      }
      const claims = restClaimsAsStrings(verified.claims);
      const context = { claims };
      const authorization: AuthorizationResult = { decision: "allowed", reason: "Cognito token verified", matchedStatements: [] };
      const result: RestAuthorizerResult = { context, authorization, allowed: true, bearerDigest };
      if (authorizer.authorizerResultTtlInSeconds > 0) {
        const expiresAt = Math.min(
          this.clock.now() + authorizer.authorizerResultTtlInSeconds * 1_000,
          verified.expiresAt,
        );
        if (expiresAt > this.clock.now()) {
          this.authorizerCache.set(cacheKey, {
            kind: "COGNITO",
            expiresAt,
            cacheVersion: await this.cognitoVerifier.cacheVersion([verified.userPoolArn]),
            userPoolArn: verified.userPoolArn,
            value: { context, bearerDigest },
          });
        }
      }
      return result;
    } catch (error) {
      return this.cognitoAuthorizerError(error);
    }
  }
  private identityValue(source: string, input: InvocationInput): string { if (source.startsWith("method.request.header.")) return input.headers[source.slice(22).toLowerCase()] ?? ""; if (source.startsWith("method.request.querystring.")) return input.query[source.slice(27)] ?? ""; if (source.startsWith("method.request.path.")) return input.pathParameters[source.slice(20)] ?? ""; if (source.startsWith("stageVariables.")) return input.stageVariables[source.slice(15)] ?? ""; if (source.startsWith("context.")) return String((input as any)[source.slice(8)] ?? ""); return ""; }
  private registryContext(service: string, operation: string, input: InvocationInput): any { return { requestId: input.requestId, service, operation, region: this.region, accountId: this.store.accountId, requestTime: new Date(this.clock.now()), sourceIp: input.sourceIp, userAgent: input.userAgent, ...(input.lambdaLineage?.length ? { deliveryLineage: input.lambdaLineage.slice(-32) } : {}) }; }
  private expandApiPolicy(policy: PolicyDocument, apiId: string): PolicyDocument {
    const expanded = structuredClone(policy); const prefix = `arn:aws:execute-api:${this.region}:${this.store.accountId}:${apiId}`;
    for (const statement of (Array.isArray(expanded.Statement) ? expanded.Statement : [expanded.Statement]) as any[]) for (const field of ["Resource", "NotResource"] as const) if (statement?.[field] !== undefined) { const original = statement[field]; const values = Array.isArray(original) ? original : [original]; const mapped = values.map((value: unknown) => typeof value === "string" && value.startsWith("execute-api:") ? `${prefix}${value.slice("execute-api:".length).startsWith("/") ? "" : "/"}${value.slice("execute-api:".length)}` : value); statement[field] = Array.isArray(original) ? mapped : mapped[0]; }
    return expanded;
  }
  private requireCombinedAuthorization(primary: AuthorizationResult, resource?: AuthorizationResult): void {
    if (primary.decision === "explicitDeny" || resource?.decision === "explicitDeny") throw new AwsError("AccessDeniedException", "User is not authorized to access this resource", 403);
    if (primary.decision === "allowed" || resource?.decision === "allowed") return;
    throw new AwsError("AccessDeniedException", "User is not authorized to access this resource", 403);
  }
  private validateIntegrationConfiguration(integration: ApiIntegrationState, method?: ApiMethodState): void {
    if (!["MOCK", "AWS_PROXY", "AWS", "HTTP_PROXY", "HTTP"].includes(integration.type)) throw new AwsError("BadRequestException", "Unsupported integration type");
    if (integration.type !== "MOCK" && !integration.uri) throw new AwsError("BadRequestException", "uri is required");
    integration.connectionType ??= "INTERNET";
    if (!["INTERNET", "VPC_LINK"].includes(integration.connectionType)) throw new AwsError("BadRequestException", "connectionType must be INTERNET or VPC_LINK");
    if (integration.connectionType === "VPC_LINK") { if (!["HTTP", "HTTP_PROXY"].includes(integration.type)) throw new AwsError("BadRequestException", "VPC_LINK is supported only for HTTP integrations"); if (!integration.connectionId) throw new AwsError("BadRequestException", "connectionId is required for VPC_LINK integrations"); const link = this.vpcLink(integration.connectionId); if (link.status !== "AVAILABLE") throw new AwsError("BadRequestException", `VpcLink ${link.id} is not available: ${link.statusMessage ?? link.status}`); }
    else if (integration.connectionId) throw new AwsError("BadRequestException", "connectionId is valid only for VPC_LINK integrations");
    if (!integration.integrationHttpMethod || typeof integration.integrationHttpMethod !== "string") throw new AwsError("BadRequestException", "integrationHttpMethod is required");
    const timeout = Number(integration.timeoutInMillis ?? 29_000); if (!Number.isInteger(timeout) || timeout < 50 || timeout > 29_000) throw new AwsError("BadRequestException", "timeoutInMillis must be between 50 and 29000"); integration.timeoutInMillis = timeout;
    if (!["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"].includes(integration.passthroughBehavior ?? "WHEN_NO_MATCH")) throw new AwsError("BadRequestException", "Invalid passthroughBehavior");
    if (integration.contentHandling !== undefined && !["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"].includes(integration.contentHandling)) throw new AwsError("BadRequestException", "Invalid contentHandling");
    if (integration.tlsConfig !== undefined) { if (!["HTTP", "HTTP_PROXY"].includes(integration.type) || typeof integration.tlsConfig.insecureSkipVerification !== "boolean") throw new AwsError("BadRequestException", "tlsConfig is valid only for HTTP integrations and requires insecureSkipVerification"); }
    if (!Array.isArray(integration.cacheKeyParameters ?? [])) throw new AwsError("BadRequestException", "cacheKeyParameters must be an array");
    if (integration.cacheNamespace !== undefined && (!integration.cacheNamespace || integration.cacheNamespace.length > 34)) throw new AwsError("BadRequestException", "cacheNamespace must contain 1 to 34 characters");
    for (const parameter of integration.cacheKeyParameters ?? []) { if (!/^(?:method|integration)\.request\.(?:header|querystring|path)\.[A-Za-z0-9._-]+$/.test(parameter)) throw new AwsError("BadRequestException", `Invalid cache key parameter: ${parameter}`); if (method) { const source = parameter.startsWith("integration.request.") ? integration.requestParameters?.[parameter] : parameter; if (!source || !Object.prototype.hasOwnProperty.call(method.requestParameters ?? {}, source)) throw new AwsError("BadRequestException", `Cache key parameter must reference a declared method request parameter: ${parameter}`); } }
    for (const [target, source] of Object.entries(integration.requestParameters ?? {})) { if (!/^integration\.request\.(header|querystring|path)\.[A-Za-z0-9._-]+$/.test(target) || typeof source !== "string") throw new AwsError("BadRequestException", `Invalid integration request parameter mapping: ${target}`); }
    for (const template of Object.values(integration.requestTemplates ?? {})) validateVtl(template);
    if (integration.credentials) this.validateIntegrationRole(integration.credentials);
  }
  private validateIntegrationResponse(method: ApiMethodState, response: ApiIntegrationResponseState): void {
    if (!/^\d{3}$/.test(response.statusCode) || !method.responses?.[response.statusCode]) throw new AwsError("BadRequestException", "A matching method response must exist");
    if (response.selectionPattern) try { new RegExp(response.selectionPattern); } catch { throw new AwsError("BadRequestException", "selectionPattern must be a valid regular expression"); }
    if (response.contentHandling !== undefined && !["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"].includes(response.contentHandling)) throw new AwsError("BadRequestException", "Invalid contentHandling");
    for (const [target, source] of Object.entries(response.responseParameters ?? {})) if (!/^method\.response\.header\.[A-Za-z0-9._-]+$/.test(target) || typeof source !== "string") throw new AwsError("BadRequestException", `Invalid integration response parameter mapping: ${target}`);
    for (const template of Object.values(response.responseTemplates ?? {})) validateVtl(template);
  }
  private validateAuthorizerConfiguration(authorizer: ApiAuthorizerState): void {
    if (!authorizer.name || authorizer.name.length > 128 || !["TOKEN", "REQUEST", "COGNITO_USER_POOLS"].includes(authorizer.type)) throw new AwsError("BadRequestException", "Authorizer name and type are invalid");
    const ttl = authorizer.authorizerResultTtlInSeconds; if (!Number.isInteger(ttl) || ttl < 0 || ttl > 3600) throw new AwsError("BadRequestException", "Authorizer cache TTL must be between 0 and 3600 seconds");
    if (authorizer.type === "COGNITO_USER_POOLS") {
      if (authorizer.authorizerUri || authorizer.authorizerCredentials) throw new AwsError("BadRequestException", "Lambda URI and credentials are not valid for Cognito user-pool authorizers");
      if (!Array.isArray(authorizer.providerARNs) || authorizer.providerARNs.length < 1 || authorizer.providerARNs.length > 1_000 || new Set(authorizer.providerARNs).size !== authorizer.providerARNs.length) throw new AwsError("BadRequestException", "providerARNs must contain 1 to 1000 unique Cognito user pool ARNs");
      for (const value of authorizer.providerARNs) {
        const parsed = parseCognitoUserPoolArn(value);
        if (!parsed || parsed.accountId !== this.store.accountId || parsed.region !== this.region) throw new AwsError("BadRequestException", "Cognito user-pool authorizers require same-account, same-Region user pool ARNs");
        const pool = this.store.regionState(this.region).cognito.pools[parsed.userPoolId];
        if (!pool || value !== pool.arn || pool.status !== "ACTIVE" || !pool.signingKeys) throw new AwsError("BadRequestException", `Cognito user pool ${parsed.userPoolId} is unavailable`);
      }
      if (!/^method\.request\.header\.[A-Za-z0-9._-]+$/.test(authorizer.identitySource ?? "")) throw new AwsError("BadRequestException", "Cognito identitySource must select exactly one request header");
      if (authorizer.identityValidationExpression) try { new RegExp(authorizer.identityValidationExpression); } catch { throw new AwsError("BadRequestException", "identityValidationExpression must be a valid regular expression"); }
      return;
    }
    if (authorizer.providerARNs !== undefined) throw new AwsError("BadRequestException", "providerARNs are valid only for Cognito user-pool authorizers");
    if (!/^arn:aws:apigateway:[^:]+:lambda:path\/2015-03-31\/functions\/arn:aws:lambda:[^/]+\/invocations$/.test(String(authorizer.authorizerUri ?? ""))) throw new AwsError("BadRequestException", "A well-formed Lambda authorizer URI is required");
    if (authorizer.type === "TOKEN" && !authorizer.identitySource || authorizer.type === "REQUEST" && ttl > 0 && !authorizer.identitySource) throw new AwsError("BadRequestException", "identitySource is required for TOKEN authorizers and cached REQUEST authorizers");
    for (const source of (authorizer.identitySource ?? "").split(",").map(value => value.trim()).filter(Boolean)) if (!/^(method\.request\.(header|querystring|path)\.[A-Za-z0-9._-]+|stageVariables\.[A-Za-z0-9_-]+|context\.[A-Za-z0-9._-]+)$/.test(source)) throw new AwsError("BadRequestException", `Invalid authorizer identity source: ${source}`);
    if (authorizer.identityValidationExpression) try { new RegExp(authorizer.identityValidationExpression); } catch { throw new AwsError("BadRequestException", "identityValidationExpression must be a valid regular expression"); }
    if (authorizer.authorizerCredentials) this.validateIntegrationRole(authorizer.authorizerCredentials);
  }
  private clearAuthorizerCache(apiId: string, authorizerId?: string): void { for (const key of this.authorizerCache.keys()) { const [cachedApiId, , cachedAuthorizerId] = key.split("\0"); if (cachedApiId === apiId && (!authorizerId || cachedAuthorizerId === authorizerId)) this.authorizerCache.delete(key); } }
  private validateIntegrationRole(roleArn: string): void { const role = Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === roleArn); if (!role || evaluateTrust(role.assumeRolePolicyDocument, "apigateway.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "apigateway.amazonaws.com" }).decision !== "allowed") throw new AwsError("BadRequestException", "API Gateway cannot assume the configured integration role"); }
  private async assertSafeHttpTarget(target: URL): Promise<void> { if (!["http:", "https:"].includes(target.protocol)) throw new AwsError("BadGatewayException", "Only HTTP and HTTPS integration targets are allowed", 502); if (process.env.STACKSIM_ALLOW_PRIVATE_HTTP === "true") return; const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase(); if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "169.254.169.254") throw new AwsError("BadGatewayException", "Private and metadata HTTP integration targets are blocked", 502); const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }); if (addresses.some(({ address }) => this.privateIp(address))) throw new AwsError("BadGatewayException", "Private and metadata HTTP integration targets are blocked", 502); }
  private privateIp(address: string): boolean { if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true; const parts = address.split(".").map(Number); return parts.length === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 169 && parts[1] === 254); }
  private async withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> { let timer: NodeJS.Timeout; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AwsError("IntegrationFailureException", "Endpoint request timed out", 504)), milliseconds); })]); } finally { clearTimeout(timer!); } }
}
