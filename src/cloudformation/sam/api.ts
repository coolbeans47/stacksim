import { canonicalJson, cfnResource, clone, eventError, fnSub, generatedLogicalId, isObject, passthroughAttributes, primaryAttributes, ref, resourceError, SamCause, SamDocumentError, sha1Hex, tagList, type JsonObject } from "./common.js";
import { addReference, type SamContext } from "./context.js";
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
export function applyImplicitRestApi(resources: Record<string, JsonObject>): void {
  const existing = resources[IMPLICIT_REST_API] ? clone(resources[IMPLICIT_REST_API]) : undefined;
  resources[IMPLICIT_REST_API] = { Type: API_TYPE, Properties: { StageName: "Prod", DefinitionBody: swaggerSkeleton(), __MANAGE_SWAGGER: true } };
  const causes: SamCause[] = [];
  const deletionPolicies: unknown[] = [];
  const updateReplacePolicies: unknown[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function" || !isObject(resource.Properties) || !isObject(resource.Properties.Events)) continue;
    for (const [eventId, event] of Object.entries(resource.Properties.Events)) {
      if (!isObject(event) || event.Type !== "Api") continue;
      try {
        const properties = eventProperties(eventId, event);
        if (!properties) continue;
        addImplicitApiTags(resources, resource, properties, "RestApiId", IMPLICIT_REST_API);
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

export function addImplicitApiTags(resources: Record<string, JsonObject>, fn: JsonObject, properties: JsonObject, idProperty: string, implicitId: string): void {
  if (Object.hasOwn(properties, idProperty)) return;
  const implicit = resources[implicitId];
  const fnProperties = fn.Properties as JsonObject;
  if (implicit && isObject(fnProperties.Tags) && fnProperties.PropagateTags) {
    const implicitProperties = implicit.Properties as JsonObject;
    implicitProperties.Tags = { ...(isObject(implicitProperties.Tags) ? implicitProperties.Tags : {}), ...fnProperties.Tags };
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

export function lambdaPermission(functionLogicalId: string, sourceArn: unknown, attributes: JsonObject): JsonObject {
  return cfnResource("AWS::Lambda::Permission", { Action: "lambda:InvokeFunction", FunctionName: ref(functionLogicalId), Principal: "apigateway.amazonaws.com", SourceArn: sourceArn }, attributes);
}

/** Api event source: the permission, and the integration in a SAM-managed definition. */
export function translateApiEvent(context: SamContext, fn: JsonObject, functionLogicalId: string, eventId: string, event: JsonObject): Record<string, JsonObject> {
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
  output[permissionLogicalId(`${functionLogicalId}${eventId}`, suffix)] = lambdaPermission(functionLogicalId, sourceArn, passthroughAttributes(fn));
  if (explicit.__MANAGE_SWAGGER && isObject(explicit.DefinitionBody)) {
    const body = explicit.DefinitionBody;
    if (hasIntegration(body, path, method)) throw eventError(eventId, `API method "${method}" defined multiple times for path "${path}".`);
    const normalized = normalizeMethod(method) as string;
    addPath(body, path, method);
    const definition = pathItem(body, path)[normalized] as JsonObject;
    definition[X_INTEGRATION] = { type: "aws_proxy", httpMethod: "POST", uri: lambdaIntegrationUri(context.partition, functionLogicalId) };
    if (properties.TimeoutInMillis) (definition[X_INTEGRATION] as JsonObject).timeoutInMillis = properties.TimeoutInMillis;
    if (definition.responses === undefined) definition.responses = {};
  }
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
  if (isObject(body.paths)) {
    for (const [path, item] of Object.entries(body.paths)) {
      if (!isObject(item)) throw new SamCause(`Structure of the SAM template is invalid. Value of '${path}' path must be a dictionary according to Swagger spec.`);
      const options = item.options;
      if (!isObject(options)) continue;
      delete options.produces;
      delete options.consumes;
      const headers = isObject(options.responses) && isObject(options.responses["200"]) ? (options.responses["200"] as JsonObject).headers : undefined;
      if (isObject(headers)) for (const [header, value] of Object.entries(headers)) headers[header] = { schema: value };
    }
  }
  return body;
}

/** AWS::Serverless::Api → RestApi, Deployment, and Stage. */
export function translateApi(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  const passthrough = passthroughAttributes(resource);
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
  if (properties.DefinitionUri) restApi.BodyS3Location = s3Location(logicalId, properties.DefinitionUri);
  else if (body) { body = openApiPostprocess(body, openApiVersion); restApi.Body = body; }
  if (properties.Name) restApi.Name = properties.Name;
  if (properties.Description) restApi.Description = properties.Description;

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
  if (properties.PropagateTags === true && isObject(properties.Tags) && Object.keys(properties.Tags).length) {
    for (const id of [logicalId, stageLogicalId]) (output[id].Properties as JsonObject).Tags = tagList(properties.Tags);
  }
  addReference(context, logicalId, "Stage", stageLogicalId);
  addReference(context, logicalId, "Deployment", deploymentLogicalId);
  return output;
}
