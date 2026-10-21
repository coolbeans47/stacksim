import { canonicalJson, cfnResource, clone, eventError, fnSub, generatedLogicalId, getAtt, isIntrinsic, isObject, pythonStr, validateProperties, type PropertySpec, passthroughAttributes, primaryAttributes, ref, resourceError, SamCause, SamDocumentError, sha1Hex, tagList, type JsonObject } from "./common.js";
import { addReference, type SamContext } from "./context.js";
import { readEventProperties, truthy, type EventSpec, type EventTarget } from "./events/common.js";
import { addAuthToMethod, addCors, addCustomStatements, addModels, addRequestModel, addRequestParameters, addRequestValidator, addResourcePolicy, addApiKeySecurityDefinition, authorizerSwagger, CorsError, documentError, expect, methodDefinitions, paths, restAuthorizers, setPathDefaultApiKeyRequired, setPathDefaultAuthorizer, validateIsDict, validatePaths, type RestAuthorizer } from "./rest-auth.js";
import { startExecutionRole, type StateMachineTarget } from "./state-machine.js";
import { resolveParameterRefs } from "./parameters.js";
import { addPath, hasIntegration, isOpenApi3Version, isSupportedRestOpenApiVersion, isSwaggerDocument, lambdaIntegrationUri, normalizeMethod, pathItem, permissionPath, swaggerSkeleton, X_INTEGRATION } from "./swagger.js";

export const IMPLICIT_REST_API = "ServerlessRestApi";
const API_TYPE = "AWS::Serverless::Api";
const HTTP_API_TYPE = "AWS::Serverless::HttpApi";

export function restApiIdString(value: unknown): unknown {
  return isObject(value) && Object.hasOwn(value, "Ref") ? value.Ref : value;
}

/** DefaultDefinitionBodyPlugin for REST APIs. */
export function applyDefaultRestDefinitionBody(resources: Record<string, JsonObject>): void {
  for (const resource of Object.values(resources)) {
    if (resource.Type !== API_TYPE || !isObject(resource.Properties)) continue;
    if (resource.Properties.DefinitionBody || resource.Properties.DefinitionUri) continue;
    resource.Properties.DefinitionBody = swaggerSkeleton();
    resource.Properties.__MANAGE_SWAGGER = true;
  }
}

function eventProperties(eventId: string, event: JsonObject): JsonObject | undefined {
  const properties = event.Properties;
  if (properties === undefined || properties === null || (isObject(properties) && Object.keys(properties).length === 0)) return undefined;
  if (!isObject(properties)) throw eventError(eventId, "Properties should be a map.");
  return properties;
}

function expectEventString(eventId: string, value: unknown, property: string): string {
  if (value === undefined || value === null) throw eventError(eventId, `Property '${property}' is required.`);
  if (typeof value !== "string") throw eventError(eventId, `Property '${property}' should be a string.`);
  return value;
}

/**
 * ImplicitRestApiPlugin: create ServerlessRestApi, point events without a
 * RestApiId at it, and add every event's path and method to its definition.
 */
export function applyImplicitRestApi(resources: Record<string, JsonObject>, globals?: unknown): void {
  const existing = resources[IMPLICIT_REST_API] ? clone(resources[IMPLICIT_REST_API]) : undefined;
  resources[IMPLICIT_REST_API] = { Type: API_TYPE, Properties: { StageName: "Prod", DefinitionBody: swaggerSkeleton(), __MANAGE_SWAGGER: true } };
  const causes: SamCause[] = [];
  const deletionPolicies: unknown[] = [];
  const updateReplacePolicies: unknown[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    // Functions and state machines both put Api events on the implicit API.
    if ((resource.Type !== "AWS::Serverless::Function" && resource.Type !== "AWS::Serverless::StateMachine") || !isObject(resource.Properties) || !isObject(resource.Properties.Events)) continue;
    for (const [eventId, event] of Object.entries(resource.Properties.Events)) {
      if (!isObject(event) || event.Type !== "Api") continue;
      try {
        const properties = eventProperties(eventId, event);
        if (!properties) continue;
        addImplicitApiTags(resources, resource, properties, "RestApiId", IMPLICIT_REST_API, globals);
        if (!Object.hasOwn(properties, "RestApiId")) properties.RestApiId = ref(IMPLICIT_REST_API);
        const apiId = restApiIdString(properties.RestApiId);
        const path = expectEventString(eventId, properties.Path, "Path");
        const method = expectEventString(eventId, properties.Method, "Method");
        if (typeof apiId !== "string") throw eventError(eventId, "RestApiId should be a string.");
        if (apiId === IMPLICIT_REST_API) { deletionPolicies.push(resource.DeletionPolicy); updateReplacePolicies.push(resource.UpdateReplacePolicy); }
        const api = resources[apiId];
        if (!api || api.Type === HTTP_API_TYPE || api.Type !== API_TYPE) throw eventError(eventId, `RestApiId must be a valid reference to an '${API_TYPE}' resource in same template.`);
        if (!isObject(api.Properties) || !isSwaggerDocument(api.Properties.DefinitionBody) || !api.Properties.__MANAGE_SWAGGER) continue;
        addPath(api.Properties.DefinitionBody, path, method);
      } catch (error) {
        if (error instanceof SamCause) causes.push(resourceError(logicalId, error.message));
        else if (error instanceof Error) causes.push(resourceError(logicalId, error.message));
        else throw error;
      }
    }
  }
  const implicit = resources[IMPLICIT_REST_API];
  applyImplicitPolicies(implicit, deletionPolicies, updateReplacePolicies);
  const body = (implicit.Properties as JsonObject).DefinitionBody as JsonObject;
  if (Object.keys(body.paths as JsonObject).length === 0) {
    if (existing) resources[IMPLICIT_REST_API] = existing;
    else delete resources[IMPLICIT_REST_API];
  }
  if (causes.length) throw new SamDocumentError(causes);
}

/**
 * _add_tags_to_implicit_api_if_necessary: a resource that propagates tags
 * (itself or through the raw Globals section, which merges later) tags the
 * implicit API its events create.
 */
export function addImplicitApiTags(resources: Record<string, JsonObject>, fn: JsonObject, properties: JsonObject, idProperty: string, implicitId: string, globals?: unknown): void {
  if (Object.hasOwn(properties, idProperty)) return;
  const implicit = resources[implicitId];
  const fnProperties = fn.Properties as JsonObject;
  const section = isObject(globals) ? globals[fn.Type === "AWS::Serverless::StateMachine" ? "StateMachine" : "Function"] : undefined;
  const globalValues = isObject(section) ? section : {};
  const propagate = fnProperties.PropagateTags || globalValues.PropagateTags;
  const tags = fnProperties.Tags || globalValues.Tags;
  if (implicit && truthy(tags) && propagate) {
    const implicitProperties = implicit.Properties as JsonObject;
    implicitProperties.Tags = { ...(isObject(implicitProperties.Tags) ? implicitProperties.Tags : {}), ...(tags as JsonObject) };
    implicitProperties.PropagateTags = true;
  }
}

export function applyImplicitPolicies(implicit: JsonObject, deletionPolicies: unknown[], updateReplacePolicies: unknown[]): void {
  if (deletionPolicies.some(Boolean)) {
    if (deletionPolicies.includes("Retain")) implicit.DeletionPolicy = "Retain";
    else if (deletionPolicies.includes("Delete")) implicit.DeletionPolicy = "Delete";
  }
  if (updateReplacePolicies.some(Boolean)) {
    if (updateReplacePolicies.includes("Retain")) implicit.UpdateReplacePolicy = "Retain";
    else if (updateReplacePolicies.includes("Snapshot")) implicit.UpdateReplacePolicy = "Snapshot";
    else if (updateReplacePolicies.includes("Delete")) implicit.UpdateReplacePolicy = "Delete";
  }
}

/** The Lambda permission logical ID: `<F><Event>Permission<suffix>`, hashed when the suffix is not alphanumeric. */
export function permissionLogicalId(prefix: string, suffix: string): string {
  return /^[A-Za-z0-9]+$/.test(suffix) ? `${prefix}Permission${suffix}` : generatedLogicalId(`${prefix}Permission`, suffix);
}

export function lambdaPermission(functionName: JsonObject, sourceArn: unknown, attributes: JsonObject): JsonObject {
  return cfnResource("AWS::Lambda::Permission", { Action: "lambda:InvokeFunction", FunctionName: functionName, Principal: "apigateway.amazonaws.com", SourceArn: sourceArn }, attributes);
}

/** Api event source: the permission, and the integration in a SAM-managed definition. */
export function translateApiEvent(context: SamContext, target: EventTarget, eventId: string, event: JsonObject): Record<string, JsonObject> {
  const functionLogicalId = target.functionLogicalId;
  const properties = isObject(event.Properties) ? event.Properties : {};
  const path = expectEventString(eventId, properties.Path, "Path");
  const method = expectEventString(eventId, properties.Method, "Method").toLowerCase();
  const apiId = restApiIdString(properties.RestApiId);
  if (typeof apiId !== "string") throw eventError(eventId, `RestApiId must be a valid reference to an '${API_TYPE}' resource in same template.`);
  const api = context.resources[apiId];
  if (!isObject(api)) throw eventError(eventId, "RestApiId property of Api event must reference a valid resource in the same template.");
  const explicit = api.Properties === undefined ? {} : api.Properties;
  if (!isObject(explicit)) throw resourceError(apiId, "Attribute 'Properties' should be a map.");
  let suffix = "Stage";
  if (typeof explicit.StageName === "string") {
    if (!explicit.StageName) throw resourceError(apiId, "StageName cannot be empty.");
    suffix = explicit.StageName;
  }
  const permissionMethod = method === "any" ? "*" : method.toUpperCase();
  const sourceArn = fnSub(`arn:${context.partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${__ApiId__}/\${__Stage__}/${permissionMethod}${permissionPath(path, true)}`, { __ApiId__: properties.RestApiId, __Stage__: "*" });
  const output: Record<string, JsonObject> = {};
  output[permissionLogicalId(`${functionLogicalId}${eventId}`, suffix)] = lambdaPermission(target.functionName, sourceArn, passthroughAttributes(target.fn));
  if (explicit.__MANAGE_SWAGGER && isObject(explicit.DefinitionBody)) {
    const body = clone(explicit.DefinitionBody);
    if (hasIntegration(body, path, method)) throw eventError(eventId, `API method "${method}" defined multiple times for path "${path}".`);
    const methodAuth = properties.Auth || {};
    expect(methodAuth, eventId, "Auth", "map", true);
    const apiAuth = explicit.Auth || {};
    expect(apiAuth, apiId, "Auth", "map");
    const definition = addMethod(body, path, method);
    const integration: JsonObject = { type: "aws_proxy", httpMethod: "POST", uri: lambdaIntegrationUri(context.partition, target.functionArn) };
    const credentials = iamIntegrationCredentials(context.partition, methodAuth as JsonObject, apiAuth as JsonObject);
    if (credentials) integration.credentials = credentials;
    definition[X_INTEGRATION] = integration;
    if (definition.responses === undefined) definition.responses = {};
    if (truthy(properties.Auth)) addAuthToSwagger(context, properties.Auth as JsonObject, explicit, apiId, eventId, method, path, suffix, body);
    if (properties.TimeoutInMillis) for (const item of methodDefinitions(body, path, method)) (item[X_INTEGRATION] as JsonObject).timeoutInMillis = properties.TimeoutInMillis;
    if (properties.RequestModel) addEventRequestModel(eventId, explicit, body, path, method, properties.RequestModel);
    if (truthy(properties.RequestParameters)) addEventRequestParameters(eventId, body, path, method, properties.RequestParameters as unknown[]);
    explicit.DefinitionBody = body;
  }
  overrideApiAuth(context, properties.Auth, explicit, apiId, eventId, method, path, suffix);
  return output;
}

/** Api.add_auth_to_swagger: an event's Authorizer, AuthorizationScopes, ApiKeyRequired, and ResourcePolicy. */
export function addAuthToSwagger(context: SamContext, eventAuth: JsonObject, api: JsonObject, apiId: string, eventId: string, method: string, path: string, stage: unknown, body: JsonObject): void {
  const methodAuthorizer = eventAuth.Authorizer;
  // SAM resolves parameter references in the API's Auth in place.
  if (api.Auth !== undefined) api.Auth = resolveParameterRefs(api.Auth, context.parameters);
  const apiAuth = isObject(api.Auth) ? api.Auth : undefined;
  if (methodAuthorizer) {
    const apiAuthorizers = apiAuth ? apiAuth.Authorizers : undefined;
    if (truthy(apiAuthorizers)) expect(apiAuthorizers, apiId, "Auth.Authorizers", "map");
    if (methodAuthorizer !== "AWS_IAM") {
      if (methodAuthorizer !== "NONE") {
        if (!truthy(apiAuthorizers)) throw eventError(eventId, `Unable to set Authorizer [${pythonText(methodAuthorizer)}] on API method [${method}] for path [${path}] because the related API does not define any Authorizers.`);
        checkAuthorizerType(eventId, method, path, methodAuthorizer, apiAuthorizers);
        if (!truthy((apiAuthorizers as JsonObject)[methodAuthorizer as string])) throw eventError(eventId, `Unable to set Authorizer [${pythonText(methodAuthorizer)}] on API method [${method}] for path [${path}] because it wasn't defined in the API's Authorizers.`);
      } else if (!apiAuth || !apiAuth.DefaultAuthorizer) {
        throw eventError(eventId, `Unable to set Authorizer on API method [${method}] for path [${path}] because 'NONE' is only a valid value when a DefaultAuthorizer on the API is specified.`);
      }
    }
  }
  const scopes = eventAuth.AuthorizationScopes;
  if (truthy(scopes)) {
    expect(scopes, eventId, "Auth.AuthorizationScopes", "list", true);
    if (!methodAuthorizer) throw eventError(eventId, "AuthorizationScopes works only when Authorizer is set");
  }
  const apiKeyRequired = eventAuth.ApiKeyRequired;
  if (apiKeyRequired !== undefined && apiKeyRequired !== null && !apiKeyRequired && (!apiAuth || !apiAuth.ApiKeyRequired)) {
    throw eventError(eventId, `Unable to set ApiKeyRequired [False] on API method [${method}] for path [${path}] because the related API does not specify any ApiKeyRequired.`);
  }
  if (methodAuthorizer || (apiKeyRequired !== undefined && apiKeyRequired !== null)) addAuthToMethod(body, path, method, eventAuth, api);
  const resourcePolicy = eventAuth.ResourcePolicy;
  if (truthy(resourcePolicy)) {
    expect(resourcePolicy, eventId, "Auth.ResourcePolicy", "map");
    addResourcePolicy(body, resourcePolicy, path, stage);
    if (truthy((resourcePolicy as JsonObject).CustomStatements)) addCustomStatements(body, (resourcePolicy as JsonObject).CustomStatements);
  }
}

/** _check_valid_authorizer_types for a named authorizer. */
function checkAuthorizerType(eventId: string, method: string, path: string, authorizer: unknown, authorizers: unknown): void {
  if (typeof authorizer !== "string" || !isObject(authorizers)) throw eventError(eventId, `Unable to set Authorizer [${pythonText(authorizer)}] on API method [${method}] for path [${path}]. The method authorizer must be a string with a corresponding dict entry in the api authorizer.`);
}

/** Python's str() of a value in SAM's messages. */
const pythonText = pythonStr;

/** The OverrideApiAuth path: apply an event's Auth to an API definition SAM does not manage. */
function overrideApiAuth(context: SamContext, auth: unknown, api: JsonObject, apiId: string, eventId: string, method: string, path: string, stage: unknown): void {
  const body = api.DefinitionBody;
  if (!truthy(body) || !truthy(auth) || !isObject(auth) || !auth.OverrideApiAuth) return;
  if (!(auth.Authorizer || auth.ApiKeyRequired || auth.ResourcePolicy)) throw eventError(eventId, "Must define one of: Authorizer, ApiKeyRequired or ResourcePolicy when using the OverrideApiAuth property.");
  if (!isSwaggerDocument(body)) throw documentError("Invalid Swagger document or the Swagger document is not explicitly defined in 'DefinitionBody'.");
  const copy = clone(body);
  validatePaths(copy);
  addAuthToSwagger(context, auth, api, apiId, eventId, method, path, stage, copy);
  api.DefinitionBody = copy;
}

/** add_lambda_integration credentials: IAM-authorized methods call Lambda with InvokeRole, or the caller's credentials. */
function iamIntegrationCredentials(partition: string, methodAuth: JsonObject, apiAuth: JsonObject): unknown {
  if (!(methodAuth.Authorizer === "AWS_IAM" || (apiAuth.DefaultAuthorizer === "AWS_IAM" && !truthy(methodAuth)))) return undefined;
  const invokeRole = (auth: JsonObject) => auth.InvokeRole ? auth.InvokeRole : Object.hasOwn(auth, "InvokeRole") ? "NONE" : undefined;
  const role = invokeRole(methodAuth) || invokeRole(apiAuth);
  const credentials = role && role !== "CALLER_CREDENTIALS" ? role : `arn:${partition}:iam::*:user/*`;
  return credentials && credentials !== "NONE" ? credentials : undefined;
}

/** SwaggerEditor.add_path plus the method's definition. */
function addMethod(body: JsonObject, path: string, method: string): JsonObject {
  addPath(body, path, method);
  return pathItem(body, path)[normalizeMethod(method) as string] as JsonObject;
}

const REQUEST_PARAMETER_PROPERTIES = new Set(["Required", "Caching"]);

/** Api event RequestModel: the body parameter or requestBody, and an optional request validator. */
function addEventRequestModel(eventId: string, api: JsonObject, body: JsonObject, path: string, method: string, requestModel: unknown): void {
  expect(requestModel, eventId, "RequestModel", "map", true);
  const model = (requestModel as JsonObject).Model;
  if (!model) return;
  const prefix = `Unable to set RequestModel [${pythonText(model)}] on API method [${method}] for path [${path}] `;
  const models = api.Models;
  if (!truthy(models)) throw eventError(eventId, `${prefix}because the related API does not define any Models.`);
  if (!isIntrinsic(models) && !isObject(models)) throw eventError(eventId, `${prefix}because the related API Models defined is of invalid type.`);
  if (typeof model !== "string") throw eventError(eventId, `${prefix}because the related API does not contain valid Models.`);
  if (!truthy((models as JsonObject)[model])) throw eventError(eventId, `${prefix}because it wasn't defined in the API's Models.`);
  addRequestModel(body, path, method, requestModel as JsonObject);
  let validateBody = (requestModel as JsonObject).ValidateBody;
  let validateParameters = (requestModel as JsonObject).ValidateParameters;
  if ((validateBody === undefined || validateBody === null) && (validateParameters === undefined || validateParameters === null)) return;
  validateBody = validateBody ?? false;
  validateParameters = validateParameters ?? false;
  if (typeof validateBody !== "boolean" || typeof validateParameters !== "boolean") throw eventError(eventId, `Unable to set Validator to RequestModel [${model}] on API method [${method}] for path [${path}] ValidateBody and ValidateParameters must be a boolean type, strings or intrinsics are not supported.`);
  addRequestValidator(body, path, method, validateBody, validateParameters);
}

/** Api event RequestParameters: method parameters and cache keys. */
function addEventRequestParameters(eventId: string, body: JsonObject, path: string, method: string, requestParameters: unknown[]): void {
  const pattern = /^method\.request\.(querystring|path|header)\./;
  const keyError = "Invalid value for 'RequestParameters' property. Keys must be in the format 'method.request.[querystring|path|header].{value}', e.g 'method.request.header.Authorization'.";
  const parameters = requestParameters.map(parameter => {
    if (isObject(parameter)) {
      const [name, value] = Object.entries(parameter)[0] ?? [];
      if (typeof name !== "string" || !pattern.test(name)) throw eventError(eventId, keyError);
      if (!isObject(value) || !Object.keys(value).every(key => REQUEST_PARAMETER_PROPERTIES.has(key))) throw eventError(eventId, "Invalid value for 'RequestParameters' property. Values must be an object, e.g { Required: true, Caching: false }");
      return { Required: false, Caching: false, ...value, Name: name } as { Name: string; Required: unknown; Caching: unknown };
    }
    if (typeof parameter === "string") {
      if (!pattern.test(parameter)) throw eventError(eventId, keyError);
      return { Required: false, Caching: false, Name: parameter };
    }
    throw eventError(eventId, "Invalid value for 'RequestParameters' property. Property must be either a string or an object");
  });
  addRequestParameters(body, path, method, parameters);
}

// --- State machine Api events ---------------------------------------------------------

const STATE_MACHINE_API_SPEC: EventSpec = {
  Path: { type: "string", required: true },
  Method: { type: "string", required: true },
  RestApiId: { type: "string", required: true },
  Stage: { type: "string" },
  Auth: { type: "map" },
  UnescapeMappingTemplate: { type: "boolean", intrinsics: false },
};

export const readStateMachineApiEvent = (eventLogicalId: string, event: JsonObject): JsonObject => readEventProperties(eventLogicalId, "Api", event, STATE_MACHINE_API_SPEC);

/**
 * A state machine Api event: `<S><Event>Role`, which API Gateway assumes, and
 * in a SAM-managed definition an `aws` StartExecution integration whose
 * request template passes the request body as the execution input.
 */
export function translateStateMachineApiEvent(context: SamContext, target: StateMachineTarget, eventId: string, properties: JsonObject): Record<string, JsonObject> {
  const logicalId = `${target.logicalId}${eventId}`;
  const path = properties.Path as string;
  const method = String(properties.Method).toLowerCase();
  const roleLogicalId = `${logicalId}Role`;
  const output: Record<string, JsonObject> = { [roleLogicalId]: startExecutionRole(target, roleLogicalId, "apigateway.amazonaws.com") };
  const apiId = restApiIdString(properties.RestApiId);
  let explicit: JsonObject = {};
  if (typeof apiId === "string") {
    const api = context.resources[apiId];
    if (!isObject(api)) throw resourceError(target.logicalId, eventError(eventId, "RestApiId property of Api event must reference a valid resource in the same template.").message);
    explicit = api.Properties === undefined ? {} : api.Properties as JsonObject;
    if (!isObject(explicit)) throw resourceError(apiId, "Attribute 'Properties' should be a map.");
    if (typeof explicit.StageName === "string" && !explicit.StageName) throw resourceError(apiId, "StageName cannot be empty.");
  }
  if (!explicit.__MANAGE_SWAGGER || !isObject(explicit.DefinitionBody)) return output;
  const body = clone(explicit.DefinitionBody);
  if (hasIntegration(body, path, method)) throw eventError(eventId, `API method "${method}" defined multiple times for path "${path}".`);
  const template = properties.UnescapeMappingTemplate
    ? `{"input": "$util.escapeJavaScript($input.json('$')).replaceAll("\\\\'","'")", "stateMachineArn": "\${${target.logicalId}}"}`
    : `{"input": "$util.escapeJavaScript($input.json('$'))", "stateMachineArn": "\${${target.logicalId}}"}`;
  const definition = addMethod(body, path, method);
  definition[X_INTEGRATION] = {
    type: "aws",
    httpMethod: "POST",
    uri: fnSub("arn:${AWS::Partition}:apigateway:${AWS::Region}:states:action/StartExecution"),
    responses: { 200: { statusCode: "200" }, 400: { statusCode: "400" } },
    credentials: getAtt(roleLogicalId, "Arn"),
    requestTemplates: { "application/json": fnSub(template) },
  };
  if (definition.responses === undefined) definition.responses = { 200: { description: "OK" }, 400: { description: "Bad Request" } };
  if (truthy(properties.Auth)) addAuthToSwagger(context, properties.Auth as JsonObject, explicit, apiId as string, eventId, method, path, properties.Stage, body);
  explicit.DefinitionBody = body;
  return output;
}

/** Translator._get_function_names: FunctionName values of functions with Api events, per API. */
export function recordFunctionNames(context: SamContext, fn: JsonObject): void {
  const properties = isObject(fn.Properties) ? fn.Properties : {};
  if (!isObject(properties.Events)) return;
  for (const event of Object.values(properties.Events)) {
    if (!isObject(event) || event.Type !== "Api" || !isObject(event.Properties) || !event.Properties.RestApiId) continue;
    const apiName = restApiIdString(event.Properties.RestApiId);
    if (typeof apiName !== "string") continue;
    const name = resolveParameterRefs(clone(properties.FunctionName), context.parameters);
    if (!name) continue;
    const names = context.functionNames.get(apiName) ?? [];
    names.push(typeof name === "string" ? name : canonicalJson(name));
    context.functionNames.set(apiName, names);
  }
}

const GATEWAY_RESPONSE_PROPERTIES = new Set(["ResponseParameters", "ResponseTemplates", "StatusCode"]);

function gatewayResponses(logicalId: string, value: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [type, response] of Object.entries(value)) {
    if (!isObject(response)) throw resourceError(logicalId, `Invalid property type '${Array.isArray(response) ? "list" : typeof response}' for GatewayResponses. Expected an object of type 'GatewayResponse'.`);
    if (Object.keys(response).length === 1 && (Object.keys(response)[0] === "Ref" || Object.keys(response)[0].startsWith("Fn::"))) throw resourceError(logicalId, "Unable to set GatewayResponses attribute because intrinsic functions are not supported for this field.");
    for (const key of Object.keys(response)) if (!GATEWAY_RESPONSE_PROPERTIES.has(key)) throw resourceError(logicalId, `Invalid property '${key}' in 'GatewayResponses' property '${type}'.`);
  }
  for (const [type, raw] of Object.entries(value)) {
    const response = raw as JsonObject;
    const parameters = response.ResponseParameters ?? {};
    if (!isObject(parameters)) throw resourceError(logicalId, `Property 'GatewayResponses.${type}.ResponseParameters' should be a map.`);
    for (const key of Object.keys(parameters)) if (!["Headers", "Paths", "QueryStrings"].includes(key)) throw resourceError(logicalId, `Invalid gateway response parameter '${key}'`);
    const statusCode = response.StatusCode === undefined || response.StatusCode === null ? undefined : String(response.StatusCode);
    if (statusCode !== undefined && !/^[0-9]{1,3}$/.test(statusCode)) throw resourceError(logicalId, "Property 'StatusCode' must be numeric");
    const prefixed: JsonObject = {};
    for (const [property, prefix] of [["Headers", "header."], ["Paths", "path."], ["QueryStrings", "querystring."]] as const) {
      const entries = parameters[property] ?? {};
      if (!isObject(entries)) throw resourceError(logicalId, `Property 'ResponseParameters.${property}' should be a map.`);
      for (const [key, item] of Object.entries(entries)) prefixed[`gatewayresponse.${prefix}${key}`] = item;
    }
    result[type] = { responseParameters: prefixed, responseTemplates: response.ResponseTemplates ?? {}, ...(statusCode === undefined ? {} : { statusCode }) };
  }
  return result;
}

function endpointConfiguration(logicalId: string, value: unknown): { EndpointConfiguration: JsonObject; Parameters: JsonObject } {
  if (isObject(value) && value.Type) {
    if ("VPCEndpointIds" in value && "VpcEndpointIds" in value) throw resourceError(logicalId, "'VPCEndpointIds' and 'VpcEndpointIds' cannot be used together in EndpointConfiguration.");
    const configuration: JsonObject = { Types: [value.Type] };
    if ("VPCEndpointIds" in value || "VpcEndpointIds" in value) configuration.VpcEndpointIds = value.VPCEndpointIds || value.VpcEndpointIds;
    if ("IpAddressType" in value) configuration.IpAddressType = value.IpAddressType;
    return { EndpointConfiguration: configuration, Parameters: { endpointConfigurationTypes: value.Type } };
  }
  return { EndpointConfiguration: { Types: [value] }, Parameters: { endpointConfigurationTypes: value } };
}

function s3Location(logicalId: string, value: unknown): JsonObject {
  if (isObject(value)) {
    if (!value.Bucket || !value.Key) throw resourceError(logicalId, "'DefinitionUri' requires Bucket and Key properties to be specified.");
    return { Bucket: value.Bucket, Key: value.Key, ...(value.Version !== undefined ? { Version: value.Version } : {}) };
  }
  const parsed = parseS3Uri(value);
  if (!parsed) throw resourceError(logicalId, "'DefinitionUri' is not a valid S3 Uri of the form 's3://bucket/key' with optional versionId query parameter.");
  return { Bucket: parsed.Bucket, Key: parsed.Key, ...(parsed.Version !== undefined ? { Version: parsed.Version } : {}) };
}

export function parseS3Uri(value: unknown): { Bucket: string; Key: string; Version?: string } | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "s3:" || !url.host || url.pathname.length <= 1) return undefined;
  const versions = url.searchParams.getAll("versionId");
  return { Bucket: url.host, Key: decodeURIComponent(url.pathname.slice(1)), ...(versions.length === 1 ? { Version: versions[0] } : {}) };
}

function openApiPostprocess(body: JsonObject, openApiVersion: unknown): JsonObject {
  if (body.swagger !== undefined && body.swagger !== null) return body;
  const version = body.openapi !== undefined && body.openapi !== null && (openApiVersion === undefined || openApiVersion === null) ? body.openapi : openApiVersion;
  if (!isOpenApi3Version(version)) return body;
  if (body.securityDefinitions) { body.components = { ...(isObject(body.components) ? body.components : {}), securitySchemes: body.securityDefinitions }; delete body.securityDefinitions; }
  if (body.definitions) { body.components = { ...(isObject(body.components) ? body.components : {}), schemas: body.definitions }; delete body.definitions; }
  if (truthy(body.paths)) {
    validateIsDict(body.paths, "Value of paths must be a dictionary according to Swagger spec.");
    for (const [path, item] of Object.entries(body.paths)) {
      validateIsDict(item, `Value of '${path}' path must be a dictionary according to Swagger spec.`);
      const options = item.options;
      if (!truthy(options)) continue;
      validateIsDict(options, `Value of options method for path ${path} must be a dictionary according to Swagger spec.`);
      delete options.produces;
      delete options.consumes;
      if (!Object.hasOwn(options, "responses")) continue;
      // dict_deep_get(responses, "200.headers")
      let headers: unknown = options.responses;
      let traversed = "";
      for (const key of ["200", "headers"]) {
        if (headers === undefined || headers === null) break;
        if (!isObject(headers)) throw documentError(`Invalid responses in options method for path ${path}: ${traversed ? `The value of '${traversed}' should be a map` : "It should be a map"}.`);
        headers = headers[key];
        traversed = traversed ? `${traversed}.${key}` : key;
      }
      if (!truthy(headers)) continue;
      validateIsDict(headers, `Value of response's headers in options method for path ${path} must be a dictionary according to Swagger spec.`);
      for (const [header, value] of Object.entries(headers)) headers[header] = { schema: value };
    }
  }
  return body;
}

const CORS_KEYS = ["AllowMethods", "AllowHeaders", "AllowOrigin", "MaxAge", "AllowCredentials"];
const CORS_WILDCARD = "'*'";
const AUTH_KEYS = ["Authorizers", "DefaultAuthorizer", "InvokeRole", "AddDefaultAuthorizerToCorsPreflight", "AddApiKeyRequiredToCorsPreflight", "ApiKeyRequired", "ResourcePolicy", "UsagePlan"];
const USAGE_PLAN_KEYS = ["CreateUsagePlan", "Description", "Quota", "Tags", "Throttle", "UsagePlanName"];

/** ApiGenerator._add_cors: an OPTIONS mock on every path, once per path ignoring a trailing slash. */
function addRestCors(logicalId: string, cors: unknown, body: JsonObject | undefined): void {
  if (!truthy(cors)) return;
  if (!truthy(body)) throw resourceError(logicalId, "Cors works only with inline Swagger specified in 'DefinitionBody' property.");
  let settings: JsonObject;
  if (typeof cors === "string" || isIntrinsic(cors)) settings = { AllowOrigin: cors };
  else if (isObject(cors)) {
    for (const key of Object.keys(cors)) if (!CORS_KEYS.includes(key)) throw resourceError(logicalId, `Invalid key '${key}' for 'Cors' property.`);
    settings = cors;
  } else throw resourceError(logicalId, "Invalid value for 'Cors' property");
  const origin = Object.hasOwn(settings, "AllowOrigin") ? settings.AllowOrigin : CORS_WILDCARD;
  if (!isSwaggerDocument(body)) throw resourceError(logicalId, "Unable to add Cors configuration because 'DefinitionBody' does not contain a valid Swagger definition.");
  if (settings.AllowCredentials === true && origin === CORS_WILDCARD) throw resourceError(logicalId, "Unable to add Cors configuration because 'AllowCredentials' can not be true when 'AllowOrigin' is \"'*'\" or not set");
  validatePaths(body);
  const processed = new Set<string>();
  for (const path of Object.keys(paths(body))) {
    const normalized = path !== "/" ? path.replace(/\/+$/, "") : path;
    if (processed.has(normalized)) continue;
    processed.add(normalized);
    try {
      addCors(body, path, origin, settings.AllowHeaders, settings.AllowMethods, settings.MaxAge, settings.AllowCredentials ?? false);
    } catch (error) {
      if (error instanceof CorsError) throw resourceError(logicalId, `Structure of the SAM template is invalid. ${error.message}`);
      throw error;
    }
  }
}

/** ApiGenerator._add_auth: authorizers, the default authorizer, API keys, and the resource policy. */
function addRestAuth(context: SamContext, logicalId: string, auth: unknown, body: JsonObject | undefined, stageName: unknown, openApiVersion: unknown): JsonObject | undefined {
  if (!truthy(auth)) return body;
  if (!truthy(body)) throw resourceError(logicalId, "Auth works only with inline Swagger specified in 'DefinitionBody' property.");
  if (!Object.keys(auth as JsonObject).every(key => AUTH_KEYS.includes(key))) throw resourceError(logicalId, "Invalid value for 'Auth' property");
  if (!isSwaggerDocument(body)) throw resourceError(logicalId, "Unable to add Auth configuration because 'DefinitionBody' does not contain a valid Swagger definition.");
  validatePaths(body);
  const settings = auth as JsonObject;
  const authorizers = restAuthorizers(logicalId, settings.Authorizers, settings.DefaultAuthorizer);
  if (authorizers && Object.keys(authorizers).length) {
    const definitions = body.securityDefinitions ? body.securityDefinitions : {};
    if (!isObject(definitions)) throw documentError("securityDefinitions must be a dictionary.");
    for (const [name, authorizer] of Object.entries(authorizers)) definitions[name] = authorizerSwagger(logicalId, authorizer, context.partition);
    if (Object.keys(definitions).length) body.securityDefinitions = definitions;
    setDefaultAuthorizer(logicalId, body, authorizers, settings.DefaultAuthorizer, settings.AddDefaultAuthorizerToCorsPreflight ?? true);
  }
  if (settings.ApiKeyRequired) {
    addApiKeySecurityDefinition(body);
    for (const path of Object.keys(paths(body))) setPathDefaultApiKeyRequired(body, path, Boolean(settings.AddApiKeyRequiredToCorsPreflight ?? true));
  }
  if (truthy(settings.ResourcePolicy)) {
    validateIsDict(settings.ResourcePolicy, "ResourcePolicy must be a map (ResourcePolicyStatement).");
    for (const path of Object.keys(paths(body))) addResourcePolicy(body, settings.ResourcePolicy, path, stageName);
    if (truthy(settings.ResourcePolicy.CustomStatements)) addCustomStatements(body, settings.ResourcePolicy.CustomStatements);
  }
  return openApiPostprocess(body, openApiVersion);
}

/** ApiGenerator._set_default_authorizer. */
function setDefaultAuthorizer(logicalId: string, body: JsonObject, authorizers: Record<string, RestAuthorizer>, defaultAuthorizer: unknown, addToPreflight: unknown): void {
  if (!defaultAuthorizer) return;
  if (typeof defaultAuthorizer !== "string") throw resourceError(logicalId, "DefaultAuthorizer is not a string.");
  if (!authorizers[defaultAuthorizer] && defaultAuthorizer !== "AWS_IAM") throw resourceError(logicalId, `Unable to set DefaultAuthorizer because '${defaultAuthorizer}' was not defined in 'Authorizers'.`);
  for (const path of Object.keys(paths(body))) setPathDefaultAuthorizer(body, path, defaultAuthorizer, authorizers, Boolean(addToPreflight));
}

/** ApiGenerator._add_models. */
function addRestModels(logicalId: string, models: unknown, body: JsonObject | undefined, openApiVersion: unknown): JsonObject | undefined {
  if (!truthy(models)) return body;
  if (!truthy(body)) throw resourceError(logicalId, "Models works only with inline Swagger specified in 'DefinitionBody' property.");
  if (!isSwaggerDocument(body)) throw resourceError(logicalId, "Unable to add Models definitions because 'DefinitionBody' does not contain a valid Swagger definition.");
  if (!isObject(models) || !Object.values(models).every(isObject)) throw resourceError(logicalId, "Invalid value for 'Models' property");
  validatePaths(body);
  addModels(body, models);
  return openApiPostprocess(body, openApiVersion);
}

/** ApiGenerator._construct_authorizer_lambda_permission: `<Api><Authorizer>AuthorizerPermission` for Lambda authorizers. */
function authorizerPermissions(context: SamContext, logicalId: string, auth: unknown, attributes: JsonObject): Record<string, JsonObject> {
  if (!truthy(auth) || !isObject(auth)) return {};
  const authorizers = restAuthorizers(logicalId, auth.Authorizers);
  const output: Record<string, JsonObject> = {};
  for (const [name, authorizer] of Object.entries(authorizers ?? {})) {
    if (!authorizer.functionArn || authorizer.disableFunctionDefaultPermissions) continue;
    output[`${logicalId}${name}AuthorizerPermission`] = cfnResource("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      FunctionName: authorizer.functionArn,
      Principal: "apigateway.amazonaws.com",
      SourceArn: fnSub(`arn:${context.partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${__ApiId__}/authorizers/*`, { __ApiId__: ref(logicalId) }),
    }, attributes);
  }
  return output;
}

/** SharedApiUsagePlan.get_combined_resource_attributes: the strongest policies, and an Or of every API's condition. */
function sharedUsagePlanAttributes(context: SamContext, attributes: JsonObject): JsonObject {
  const shared = context.sharedUsagePlan;
  const deletion = attributes.DeletionPolicy;
  if (deletion && (!shared.deletionPolicy || deletion === "Retain")) shared.deletionPolicy = deletion;
  const replace = attributes.UpdateReplacePolicy;
  if (replace && (!shared.updateReplacePolicy || replace === "Retain" || (replace === "Snapshot" && shared.updateReplacePolicy === "Delete"))) shared.updateReplacePolicy = replace;
  const condition = attributes.Condition;
  if (!shared.anyApiWithoutCondition) {
    const conditions = isObject(context.template.Conditions) ? context.template.Conditions : undefined;
    if (condition && !shared.conditions.includes(condition)) {
      if (!conditions) throw new SamCause("Structure of the SAM template is invalid. Can't have condition without having 'Conditions' section in the template");
      shared.conditions.push(condition);
      conditions[SHARED_USAGE_PLAN_CONDITION] = shared.conditions.length > 1 ? { "Fn::Or": shared.conditions.map(item => ({ Condition: item })) } : condition;
    } else if (condition === undefined || condition === null) {
      shared.anyApiWithoutCondition = true;
      if (conditions) delete conditions[SHARED_USAGE_PLAN_CONDITION];
    }
  }
  return {
    ...(shared.deletionPolicy ? { DeletionPolicy: shared.deletionPolicy } : {}),
    ...(shared.updateReplacePolicy ? { UpdateReplacePolicy: shared.updateReplacePolicy } : {}),
    ...(shared.conditions.length && !shared.anyApiWithoutCondition ? { Condition: SHARED_USAGE_PLAN_CONDITION } : {}),
  };
}

const SHARED_USAGE_PLAN_CONDITION = "SharedUsagePlanCondition";

/** ApiGenerator._construct_usage_plan: the usage plan, API key, and usage plan key for PER_API or SHARED. */
function usagePlan(context: SamContext, logicalId: string, auth: unknown, stageLogicalId: string, attributes: JsonObject): Record<string, JsonObject> {
  if (!truthy(auth) || !isObject(auth) || auth.UsagePlan === undefined || auth.UsagePlan === null) return {};
  const settings = auth.UsagePlan;
  if (!isObject(settings)) throw resourceError(logicalId, "'UsagePlan' must be a dictionary");
  if (!Object.keys(settings).every(key => USAGE_PLAN_KEYS.includes(key))) throw resourceError(logicalId, "Invalid property for 'UsagePlan'");
  const create = settings.CreateUsagePlan;
  if (create === undefined || create === null) throw resourceError(logicalId, "'CreateUsagePlan' is a required field for UsagePlan.");
  if (create !== "SHARED" && create !== "PER_API" && create !== "NONE") throw resourceError(logicalId, "'CreateUsagePlan' accepts one of ['SHARED', 'PER_API', 'NONE'].");
  if (create === "NONE") return {};
  const apiStage = { ApiId: ref(logicalId), Stage: ref(stageLogicalId) };
  const stageKey = { RestApiId: ref(logicalId), StageName: ref(stageLogicalId) };
  let planId: string;
  let keyId: string;
  let planKeyId: string;
  let planAttributes: JsonObject;
  let keyAttributes: JsonObject;
  let planKeyAttributes: JsonObject;
  let dependsOn: string[];
  let apiStages: JsonObject[];
  let stageKeys: JsonObject[];
  if (create === "PER_API") {
    planId = `${logicalId}UsagePlan`; keyId = `${logicalId}ApiKey`; planKeyId = `${logicalId}UsagePlanKey`;
    planAttributes = keyAttributes = planKeyAttributes = attributes;
    dependsOn = [logicalId]; apiStages = [apiStage]; stageKeys = [stageKey];
  } else {
    const shared = context.sharedUsagePlan;
    planId = "ServerlessUsagePlan"; keyId = "ServerlessApiKey"; planKeyId = "ServerlessUsagePlanKey";
    if (!shared.dependsOn.includes(logicalId)) shared.dependsOn.push(logicalId);
    planAttributes = sharedUsagePlanAttributes(context, attributes);
    if (!shared.apiStages.some(item => JSON.stringify(item) === JSON.stringify(apiStage))) shared.apiStages.push(apiStage);
    keyAttributes = sharedUsagePlanAttributes(context, attributes);
    if (!shared.stageKeys.some(item => JSON.stringify(item) === JSON.stringify(stageKey))) shared.stageKeys.push(stageKey);
    planKeyAttributes = sharedUsagePlanAttributes(context, attributes);
    dependsOn = [...shared.dependsOn]; apiStages = structuredClone(shared.apiStages); stageKeys = structuredClone(shared.stageKeys);
  }
  const plan: JsonObject = { ApiStages: apiStages };
  for (const name of ["UsagePlanName", "Description", "Quota", "Tags", "Throttle"]) if (truthy(settings[name])) plan[name] = settings[name];
  return {
    [planId]: cfnResource("AWS::ApiGateway::UsagePlan", plan, { DependsOn: dependsOn, ...planAttributes }),
    [keyId]: cfnResource("AWS::ApiGateway::ApiKey", { Enabled: true, StageKeys: stageKeys }, { DependsOn: [planId], ...keyAttributes }),
    [planKeyId]: cfnResource("AWS::ApiGateway::UsagePlanKey", { KeyId: ref(keyId), KeyType: "API_KEY", UsagePlanId: ref(planId) }, { DependsOn: [keyId], ...planKeyAttributes }),
  };
}

/** SamApi.property_types, in SAM's order. */
const API_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  __MANAGE_SWAGGER: { type: "boolean" },
  Name: { type: "string-or-map", generic: true },
  StageName: { type: "string-or-map", generic: true },
  Tags: { type: "map" },
  PropagateTags: { type: "boolean" },
  DefinitionBody: { type: "map" },
  DefinitionUri: { type: "string-or-map", generic: true },
  MergeDefinitions: { type: "boolean", intrinsics: false },
  CacheClusterEnabled: { type: "boolean" },
  CacheClusterSize: { type: "string" },
  Variables: { type: "map" },
  EndpointConfiguration: { type: "string-or-map", generic: true },
  MethodSettings: { type: "list" },
  BinaryMediaTypes: { type: "list" },
  MinimumCompressionSize: { type: "integer" },
  Cors: { type: "string-or-map", generic: true },
  Auth: { type: "map" },
  GatewayResponses: { type: "map" },
  AccessLogSetting: { type: "map" },
  CanarySetting: { type: "map" },
  TracingEnabled: { type: "boolean" },
  OpenApiVersion: { type: "string" },
  Models: { type: "map" },
  Domain: { type: "map" },
  FailOnWarnings: { type: "boolean" },
  Description: { type: "string" },
  Mode: { type: "string" },
  DisableExecuteApiEndpoint: { type: "boolean" },
  ApiKeySourceType: { type: "string" },
  AlwaysDeploy: { type: "boolean", intrinsics: false },
  Policy: { type: "string-or-map", generic: true },
  SecurityPolicy: { type: "string" },
  EndpointAccessMode: { type: "string" },
};

/** AWS::Serverless::Api → RestApi, Deployment, Stage, authorizer permissions, and usage plan resources. */
export function translateApi(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  const passthrough = passthroughAttributes(resource);
  validateProperties(logicalId, properties, API_PROPERTIES);
  // SamApi resolves template parameters in Auth before generating.
  if (properties.Auth !== undefined) properties.Auth = resolveParameterRefs(properties.Auth, context.parameters);
  if (properties.DefinitionUri && properties.DefinitionBody) throw resourceError(logicalId, "Specify either 'DefinitionUri' or 'DefinitionBody' property and not both.");
  const openApiVersion = properties.OpenApiVersion;
  if (openApiVersion !== undefined && openApiVersion !== null && !isSupportedRestOpenApiVersion(openApiVersion)) throw resourceError(logicalId, "The OpenApiVersion value must be of the format '3.0.0'.");
  if (properties.StageName === undefined || properties.StageName === null) throw resourceError(logicalId, "Missing required property 'StageName'.");
  const binaryMedia = resolveParameterRefs(properties.BinaryMediaTypes, context.parameters);
  let body = isObject(properties.DefinitionBody) ? properties.DefinitionBody : undefined;
  const restApi: JsonObject = {};
  if (binaryMedia !== undefined) restApi.BinaryMediaTypes = binaryMedia;
  if (properties.MinimumCompressionSize !== undefined) restApi.MinimumCompressionSize = properties.MinimumCompressionSize;
  if (properties.EndpointConfiguration) Object.assign(restApi, endpointConfiguration(logicalId, properties.EndpointConfiguration));
  addRestCors(logicalId, properties.Cors, body);
  body = addRestAuth(context, logicalId, properties.Auth, body, properties.StageName, openApiVersion);
  if (isObject(properties.GatewayResponses) && Object.keys(properties.GatewayResponses).length) {
    if (!body) throw resourceError(logicalId, "GatewayResponses works only with inline Swagger specified in 'DefinitionBody' property.");
    const responses = gatewayResponses(logicalId, properties.GatewayResponses);
    if (!isSwaggerDocument(body)) throw resourceError(logicalId, "Unable to add Auth configuration because 'DefinitionBody' does not contain a valid Swagger definition.");
    body["x-amazon-apigateway-gateway-responses"] = { ...(isObject(body["x-amazon-apigateway-gateway-responses"]) ? body["x-amazon-apigateway-gateway-responses"] : {}), ...responses };
  }
  if (Array.isArray(binaryMedia) && binaryMedia.length && body) {
    const replace = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("~1", "/") : Array.isArray(value) ? value.map(replace) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replaceAll("~1", "/"), replace(item)])) : value;
    body["x-amazon-apigateway-binary-media-types"] = replace(binaryMedia);
  }
  body = addRestModels(logicalId, properties.Models, body, openApiVersion);
  if (properties.DefinitionUri) restApi.BodyS3Location = s3Location(logicalId, properties.DefinitionUri);
  else if (body) { body = openApiPostprocess(body, openApiVersion); restApi.Body = body; }
  if (properties.Name) restApi.Name = properties.Name;
  if (properties.Description) restApi.Description = properties.Description;
  if (properties.ApiKeySourceType) restApi.ApiKeySourceType = properties.ApiKeySourceType;
  if (properties.Policy) restApi.Policy = properties.Policy;

  const output: Record<string, JsonObject> = {};
  output[logicalId] = cfnResource("AWS::ApiGateway::RestApi", restApi, primaryAttributes(resource));

  const removeExtraStage = Boolean(openApiVersion);
  const deployment: JsonObject = { RestApiId: ref(logicalId) };
  if (!removeExtraStage) deployment.StageName = "Stage";
  const stageNamePrefix = typeof properties.StageName === "string" ? properties.StageName : "";
  const stageLogicalId = /^[A-Za-z0-9]+$/.test(stageNamePrefix) ? `${logicalId}${stageNamePrefix}Stage` : generatedLogicalId(`${logicalId}Stage`, stageNamePrefix);
  let deploymentLogicalId = `${logicalId}Deployment`;
  const definition = restApi.Body ?? restApi.BodyS3Location;
  if (definition) {
    // Local difference (sam-transform-design.md §3.4): AWS hashes a Python
    // repr() of the definition; StackSim hashes its canonical JSON.
    let inputs = [canonicalJson(definition)];
    if (openApiVersion) inputs.push(typeof openApiVersion === "string" ? openApiVersion : canonicalJson(openApiVersion));
    const names = context.functionNames.get(logicalId);
    if (names?.length) inputs.push(names.join(""));
    if (properties.AlwaysDeploy === true) inputs = [String(Math.floor(context.now / 1000))];
    const digest = sha1Hex(inputs.join("||"));
    deploymentLogicalId = `${logicalId}Deployment${digest.slice(0, 10)}`;
    deployment.Description = `RestApi deployment id: ${digest}`;
  }
  output[deploymentLogicalId] = cfnResource("AWS::ApiGateway::Deployment", deployment, passthrough);
  output[stageLogicalId] = cfnResource("AWS::ApiGateway::Stage", {
    DeploymentId: ref(deploymentLogicalId),
    RestApiId: ref(logicalId),
    StageName: properties.StageName,
    CacheClusterEnabled: properties.CacheClusterEnabled,
    CacheClusterSize: properties.CacheClusterSize,
    Variables: properties.Variables,
    MethodSettings: properties.MethodSettings,
    AccessLogSetting: properties.AccessLogSetting,
    TracingEnabled: properties.TracingEnabled,
    Tags: properties.Tags === undefined || properties.Tags === null ? undefined : tagList(properties.Tags),
  }, passthrough);
  Object.assign(output, authorizerPermissions(context, logicalId, properties.Auth, passthrough), usagePlan(context, logicalId, properties.Auth, stageLogicalId, passthrough));
  if (properties.PropagateTags === true && isObject(properties.Tags) && Object.keys(properties.Tags).length) {
    for (const generated of Object.values(output)) {
      if (["AWS::ApiGateway::RestApi", "AWS::ApiGateway::Stage", "AWS::ApiGateway::UsagePlan", "AWS::ApiGateway::ApiKey"].includes(generated.Type as string)) (generated.Properties as JsonObject).Tags = tagList(properties.Tags);
    }
  }
  // Referable properties resolve to the last generated resource of their type.
  for (const [generatedId, generated] of Object.entries(output)) {
    const property = { "AWS::ApiGateway::Stage": "Stage", "AWS::ApiGateway::Deployment": "Deployment", "AWS::ApiGateway::UsagePlan": "UsagePlan", "AWS::ApiGateway::UsagePlanKey": "UsagePlanKey", "AWS::ApiGateway::ApiKey": "ApiKey" }[generated.Type as string];
    if (property) addReference(context, logicalId, property, generatedId);
  }
  return output;
}
