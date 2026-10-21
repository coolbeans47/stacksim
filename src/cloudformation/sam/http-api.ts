import { addImplicitApiTags, applyImplicitPolicies, lambdaPermission, parseS3Uri } from "./api.js";
import { cfnResource, clone, eventError, fnSub, generatedLogicalId, isIntrinsic, isObject, passthroughAttributes, primaryAttributes, ref, resourceError, SamCause, SamDocumentError, type JsonObject } from "./common.js";
import { addReference, type SamContext } from "./context.js";
import { resolveParameterRefs } from "./parameters.js";
import { HTTP_DEFAULT_PATH, X_ANY_METHOD, X_INTEGRATION, addPath, hasIntegration, isOpenApiDocument, lambdaIntegrationUri, normalizeMethod, openApiSkeleton, pathItem, permissionPath } from "./swagger.js";

export const IMPLICIT_HTTP_API = "ServerlessHttpApi";
const HTTP_API_TYPE = "AWS::Serverless::HttpApi";
const DEFAULT_TITLE = JSON.stringify({ Ref: "AWS::StackName" });
const INVALID_OPENAPI = "Structure of the SAM template is invalid. Invalid OpenApi document. Invalid values or missing keys for 'openapi' or 'paths' in 'DefinitionBody'.";

const apiIdString = (value: unknown): unknown => isObject(value) && Object.hasOwn(value, "Ref") ? value.Ref : value;

/** DefaultDefinitionBodyPlugin for HTTP APIs. */
export function applyDefaultHttpDefinitionBody(resources: Record<string, JsonObject>): void {
  for (const resource of Object.values(resources)) {
    if (resource.Type !== HTTP_API_TYPE) continue;
    if (resource.Properties === undefined || resource.Properties === null) resource.Properties = {};
    if (!isObject(resource.Properties)) continue;
    if (resource.Properties.DefinitionBody || resource.Properties.DefinitionUri) continue;
    resource.Properties.DefinitionBody = openApiSkeleton();
    resource.Properties.__MANAGE_SWAGGER = true;
  }
}

function expectEventString(eventId: string, value: unknown, property: string): string {
  if (value === undefined || value === null) throw eventError(eventId, `Property '${property}' is required.`);
  if (typeof value !== "string") throw eventError(eventId, `Property '${property}' should be a string.`);
  return value;
}

/** ImplicitHttpApiPlugin. */
export function applyImplicitHttpApi(resources: Record<string, JsonObject>): void {
  const existing = resources[IMPLICIT_HTTP_API] ? clone(resources[IMPLICIT_HTTP_API]) : undefined;
  resources[IMPLICIT_HTTP_API] = { Type: HTTP_API_TYPE, Properties: { DefinitionBody: openApiSkeleton(), __MANAGE_SWAGGER: true } };
  const causes: SamCause[] = [];
  const deletionPolicies: unknown[] = [];
  const updateReplacePolicies: unknown[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function" || !isObject(resource.Properties) || !isObject(resource.Properties.Events)) continue;
    for (const [eventId, event] of Object.entries(resource.Properties.Events)) {
      if (!isObject(event) || event.Type !== "HttpApi") continue;
      try {
        let properties = event.Properties;
        if (properties === undefined || properties === null) properties = {};
        if (!isObject(properties)) throw eventError(eventId, "Properties should be a map.");
        event.Properties = properties;
        addImplicitApiTags(resources, resource, properties, "ApiId", IMPLICIT_HTTP_API);
        if (!Object.hasOwn(properties, "ApiId")) properties.ApiId = ref(IMPLICIT_HTTP_API);
        if (!properties.Path && !properties.Method) { properties.Path = HTTP_DEFAULT_PATH; properties.Method = X_ANY_METHOD; }
        const apiId = apiIdString(properties.ApiId);
        const path = expectEventString(eventId, properties.Path, "Path");
        const method = expectEventString(eventId, properties.Method, "Method");
        if (typeof apiId !== "string") throw eventError(eventId, "ApiId should be a string.");
        if (apiId === IMPLICIT_HTTP_API) { deletionPolicies.push(resource.DeletionPolicy); updateReplacePolicies.push(resource.UpdateReplacePolicy); }
        const api = resources[apiId];
        if (!api) throw eventError(eventId, `ApiId must be a valid reference to an '${HTTP_API_TYPE}' resource in same template.`);
        if (isObject(api.Properties) && isOpenApiDocument(api.Properties.DefinitionBody) && api.Properties.__MANAGE_SWAGGER) addPath(api.Properties.DefinitionBody, path, method);
        if (properties.RouteSettings !== undefined) {
          const apiProperties = api.Properties as JsonObject;
          const route = method === X_ANY_METHOD ? path : `${method.toUpperCase()} ${path}`;
          const routeSettings = apiProperties.RouteSettings ?? {};
          if (!isObject(routeSettings)) throw resourceError(apiId, "Property 'RouteSettings' should be a map.");
          if (!isObject(properties.RouteSettings)) throw eventError(eventId, "Property 'RouteSettings' should be a map.");
          routeSettings[route] = { ...(isObject(routeSettings[route]) ? routeSettings[route] : {}), ...properties.RouteSettings };
          apiProperties.RouteSettings = routeSettings;
        }
      } catch (error) {
        if (error instanceof SamCause && error.message.startsWith("Resource with id [")) causes.push(error);
        else if (error instanceof Error) causes.push(resourceError(logicalId, error.message));
        else throw error;
      }
    }
  }
  const implicit = resources[IMPLICIT_HTTP_API];
  applyImplicitPolicies(implicit, deletionPolicies, updateReplacePolicies);
  const body = (implicit.Properties as JsonObject).DefinitionBody as JsonObject;
  if (Object.keys(body.paths as JsonObject).length === 0) {
    if (existing) resources[IMPLICIT_HTTP_API] = existing;
    else delete resources[IMPLICIT_HTTP_API];
  }
  if (causes.length) throw new SamDocumentError(causes);
}

function defaultRouteFunctionMatches(body: JsonObject, functionLogicalId: string): boolean {
  if (!hasIntegration(body, HTTP_DEFAULT_PATH, X_ANY_METHOD)) return false;
  const integration = (pathItem(body, HTTP_DEFAULT_PATH)[X_ANY_METHOD] as JsonObject)[X_INTEGRATION];
  if (!isObject(integration) || !isObject(integration.uri)) return false;
  const arn = integration.uri["Fn::Sub"];
  const match = typeof arn === "string" ? /([A-Za-z0-9]+\.Arn)/.exec(arn) : null;
  return match !== null && match[1].split(".Arn")[0] === functionLogicalId;
}

/** HttpApi event source: the permission and the OpenAPI integration. */
export function translateHttpApiEvent(context: SamContext, fn: JsonObject, functionLogicalId: string, eventId: string, event: JsonObject): Record<string, JsonObject> {
  const properties = isObject(event.Properties) ? event.Properties : {};
  const path = expectEventString(eventId, properties.Path, "Path");
  const method = expectEventString(eventId, properties.Method, "Method").toLowerCase();
  const apiId = apiIdString(properties.ApiId);
  if (typeof apiId !== "string" || !isObject(context.resources[apiId])) throw eventError(eventId, `ApiId must be a valid reference to an '${HTTP_API_TYPE}' resource in same template.`);
  const api = context.resources[apiId];
  const explicit = isObject(api.Properties) ? api.Properties : {};
  const output: Record<string, JsonObject> = {};

  let permissionResourcePath = path.replace(/^(.+)\/$/, "$1");
  let createPermission = true;
  if (explicit.DefinitionBody && !isOpenApiDocument(explicit.DefinitionBody)) throw resourceError(apiId, INVALID_OPENAPI);
  if (permissionResourcePath === HTTP_DEFAULT_PATH) permissionResourcePath = "";
  else if (isOpenApiDocument(explicit.DefinitionBody) && defaultRouteFunctionMatches(explicit.DefinitionBody, functionLogicalId)) createPermission = false;
  if (createPermission) {
    permissionResourcePath = permissionPath(permissionResourcePath, false);
    const permissionMethod = method === "any" || method === X_ANY_METHOD ? "*" : method.toUpperCase();
    const resource = method === "any" && permissionResourcePath === `/${HTTP_DEFAULT_PATH}` ? `\${__ApiId__}/\${__Stage__}${permissionResourcePath}` : `\${__ApiId__}/\${__Stage__}/${permissionMethod}${permissionResourcePath}`;
    const sourceArn = fnSub(`arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:${resource}`, { __ApiId__: properties.ApiId, __Stage__: "*" });
    output[`${functionLogicalId}${eventId}Permission`] = lambdaPermission(functionLogicalId, sourceArn, passthroughAttributes(fn));
  }

  const body = explicit.DefinitionBody;
  if (body === undefined || body === null) return output;
  if (!isOpenApiDocument(body)) throw new SamCause(INVALID_OPENAPI);
  if (explicit.__MANAGE_SWAGGER && hasIntegration(body, path, method)) throw eventError(eventId, `API method '${method}' defined multiple times for path '${path}'.`);
  const normalized = normalizeMethod(method) as string;
  if (!hasIntegration(body, path, method)) {
    addPath(body, path, method);
    const definition = pathItem(body, path)[normalized] as JsonObject;
    definition[X_INTEGRATION] = { type: "aws_proxy", httpMethod: "POST", payloadFormatVersion: "2.0", uri: lambdaIntegrationUri("${AWS::Partition}", functionLogicalId) };
    if (path === HTTP_DEFAULT_PATH && normalized === X_ANY_METHOD) definition.isDefaultRoute = true;
    if (definition.responses === undefined) definition.responses = {};
  }
  const definition = pathItem(body, path)[normalized] as JsonObject;
  if (properties.TimeoutInMillis && isObject(definition[X_INTEGRATION])) (definition[X_INTEGRATION] as JsonObject).timeoutInMillis = properties.TimeoutInMillis;
  const pathParameters = [...path.matchAll(/\{(.*?)\}/g)].map(match => match[1]);
  if (pathParameters.length) {
    const parameters = Array.isArray(definition.parameters) ? definition.parameters : (definition.parameters = []) as unknown[];
    for (const name of pathParameters) {
      const existing = parameters.find(parameter => isObject(parameter) && parameter.name === name) as JsonObject | undefined;
      if (existing) { existing.in = "path"; existing.required = true; } else parameters.push({ name, in: "path", required: true });
    }
  }
  if (properties.PayloadFormatVersion && isObject(definition[X_INTEGRATION])) (definition[X_INTEGRATION] as JsonObject).payloadFormatVersion = properties.PayloadFormatVersion;
  return output;
}

const CORS_KEYS = ["AllowMethods", "AllowHeaders", "AllowOrigins", "MaxAge", "ExposeHeaders", "AllowCredentials"] as const;

function addCors(logicalId: string, body: JsonObject, value: unknown): void {
  let properties: Partial<Record<(typeof CORS_KEYS)[number], unknown>>;
  if (typeof value === "boolean") properties = { AllowOrigins: ["*"] };
  else if (isIntrinsic(value)) properties = { AllowOrigins: value };
  else if (isObject(value)) {
    for (const key of Object.keys(value)) if (!(CORS_KEYS as readonly string[]).includes(key)) throw resourceError(logicalId, `Invalid key '${key}' for 'Cors' property.`);
    properties = value;
  } else throw resourceError(logicalId, "Invalid value for 'Cors' property.");
  if (!isOpenApiDocument(body)) throw resourceError(logicalId, "Unable to add Cors configuration because 'DefinitionBody' does not contain a valid OpenApi definition.");
  const origins = properties.AllowOrigins;
  if (properties.AllowCredentials === true && Array.isArray(origins) && origins.length === 1 && origins[0] === "*") throw resourceError(logicalId, "Unable to add Cors configuration because 'AllowCredentials' can not be true when 'AllowOrigin' is \"'*'\" or not set.");
  const cors = body["x-amazon-apigateway-cors"] ?? {};
  if (!isObject(cors)) throw new SamCause("Structure of the SAM template is invalid. Value of 'x-amazon-apigateway-cors' must be a dictionary according to Swagger spec.");
  if (origins && isIntrinsic(origins)) {
    let text = JSON.stringify(origins);
    for (const key of CORS_KEYS) text = text.replaceAll(key, key[0].toLowerCase() + key.slice(1));
    Object.assign(cors, JSON.parse(text));
  } else {
    if (origins) cors.allowOrigins = origins;
    if (properties.AllowHeaders) cors.allowHeaders = properties.AllowHeaders;
    if (properties.AllowMethods) cors.allowMethods = properties.AllowMethods;
    if (properties.ExposeHeaders) cors.exposeHeaders = properties.ExposeHeaders;
    if (properties.MaxAge !== undefined && properties.MaxAge !== null) cors.maxAge = properties.MaxAge;
    if (properties.AllowCredentials === true) cors.allowCredentials = true;
  }
  body["x-amazon-apigateway-cors"] = cors;
}

/** AWS::Serverless::HttpApi → ApiGatewayV2 Api and Stage. */
export function translateHttpApi(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  const passthrough = passthroughAttributes(resource);
  if (properties.DefinitionUri && properties.DefinitionBody) throw resourceError(logicalId, "Specify either 'DefinitionUri' or 'DefinitionBody' property and not both.");
  const body = isObject(properties.DefinitionBody) ? properties.DefinitionBody : undefined;
  const corsConfiguration = resolveParameterRefs(properties.CorsConfiguration, context.parameters);
  if (corsConfiguration) {
    if (!body) throw resourceError(logicalId, "Cors works only with inline OpenApi specified in 'DefinitionBody' property.");
    addCors(logicalId, body, corsConfiguration);
  }
  let tags = isObject(properties.Tags) ? properties.Tags : undefined;
  if (tags && Object.keys(tags).length && !body) throw resourceError(logicalId, "Tags works only with inline OpenApi specified in the 'DefinitionBody' property.");
  if (body) {
    if (tags && Object.keys(tags).length && !isOpenApiDocument(body)) throw resourceError(logicalId, "Unable to add `Tags` because 'DefinitionBody' does not contain a valid OpenApi definition.");
    if (isOpenApiDocument(body)) {
      tags = { ...(tags ?? {}), "httpapi:createdBy": "SAM" };
      const bodyTags = body.tags ?? [];
      if (!Array.isArray(bodyTags)) throw new SamCause(`Structure of the SAM template is invalid. Tags in OpenApi DefinitionBody needs to be a list. ${JSON.stringify(bodyTags)} is a ${typeof bodyTags} not a list.`);
      for (const [name, value] of Object.entries(tags)) {
        const existing = bodyTags.find(tag => isObject(tag) && tag.name === name) as JsonObject | undefined;
        if (existing) existing["x-amazon-apigateway-tag-value"] = value;
        else bodyTags.push({ name, "x-amazon-apigateway-tag-value": value });
      }
      body.tags = bodyTags;
    }
  }
  if (properties.DisableExecuteApiEndpoint !== undefined && properties.DisableExecuteApiEndpoint !== null) {
    if (!body) throw resourceError(logicalId, "DisableExecuteApiEndpoint works only within 'DefinitionBody' property.");
    const servers = Array.isArray(body.servers) ? body.servers : [{}];
    for (const server of servers) {
      if (!isObject(server)) throw new SamCause("Structure of the SAM template is invalid. Value of 'servers' item must be a dictionary according to Swagger spec.");
      server["x-amazon-apigateway-endpoint-configuration"] = { ...(isObject(server["x-amazon-apigateway-endpoint-configuration"]) ? server["x-amazon-apigateway-endpoint-configuration"] : {}), disableExecuteApiEndpoint: properties.DisableExecuteApiEndpoint };
    }
    body.servers = servers;
  }
  if (properties.Name) {
    if (!body) throw resourceError(logicalId, "Name works only with inline OpenApi specified in the 'DefinitionBody' property.");
    const info = isObject(body.info) ? body.info : (body.info = {}) as JsonObject;
    if (JSON.stringify(info.title) !== DEFAULT_TITLE) throw resourceError(logicalId, "Unable to set Name because it is already defined within inline OpenAPI specified in the 'DefinitionBody' property.");
    info.title = properties.Name;
  }
  if (properties.Description) {
    if (!body) throw resourceError(logicalId, "Description works only with inline OpenApi specified in the 'DefinitionBody' property.");
    const info = isObject(body.info) ? body.info : (body.info = {}) as JsonObject;
    if (info.description) throw resourceError(logicalId, "Unable to set Description because it is already defined within inline OpenAPI specified in the 'DefinitionBody' property.");
    info.description = properties.Description;
  }
  if (properties.FailOnWarnings && body && isObject(body.paths) && Object.hasOwn(body.paths, HTTP_DEFAULT_PATH)) {
    body.paths[`/${HTTP_DEFAULT_PATH}`] = body.paths[HTTP_DEFAULT_PATH];
    delete body.paths[HTTP_DEFAULT_PATH];
  }
  const api: JsonObject = {};
  if (properties.FailOnWarnings) api.FailOnWarnings = properties.FailOnWarnings;
  if (properties.DefinitionUri) {
    const uri = properties.DefinitionUri;
    if (isObject(uri)) {
      if (!uri.Bucket || !uri.Key) throw resourceError(logicalId, "'DefinitionUri' requires Bucket and Key properties to be specified.");
      api.BodyS3Location = { Bucket: uri.Bucket, Key: uri.Key, ...(uri.Version !== undefined ? { Version: uri.Version } : {}) };
    } else {
      const parsed = parseS3Uri(uri);
      if (!parsed) throw resourceError(logicalId, "'DefinitionUri' is not a valid S3 Uri of the form 's3://bucket/key' with optional versionId query parameter.");
      api.BodyS3Location = parsed;
    }
  } else if (body) api.Body = body;
  else throw resourceError(logicalId, "'DefinitionUri' or 'DefinitionBody' are required properties of an 'AWS::Serverless::HttpApi'. Add a value for one of these properties or add a 'HttpApi' event to an 'AWS::Serverless::Function'.");

  const output: Record<string, JsonObject> = {};
  output[logicalId] = cfnResource("AWS::ApiGatewayV2::Api", api, primaryAttributes(resource));
  const stageName = properties.StageName === undefined || properties.StageName === null || properties.StageName === "" ? HTTP_DEFAULT_PATH : properties.StageName;
  const prefix = typeof stageName === "string" ? stageName : "";
  const stageLogicalId = /^[A-Za-z0-9]+$/.test(prefix) ? `${logicalId}${prefix}Stage` : prefix === HTTP_DEFAULT_PATH ? `${logicalId}ApiGatewayDefaultStage` : generatedLogicalId(`${logicalId}Stage`, prefix);
  output[stageLogicalId] = cfnResource("AWS::ApiGatewayV2::Stage", {
    ApiId: ref(logicalId),
    StageName: stageName,
    StageVariables: properties.StageVariables,
    AccessLogSettings: properties.AccessLogSettings,
    DefaultRouteSettings: properties.DefaultRouteSettings,
    Tags: tags,
    AutoDeploy: true,
    RouteSettings: properties.RouteSettings,
  }, passthrough);
  addReference(context, logicalId, "Stage", stageLogicalId);
  return output;
}
