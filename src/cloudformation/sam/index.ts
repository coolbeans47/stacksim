import { applyDefaultRestDefinitionBody, applyImplicitRestApi, recordFunctionNames, translateApi } from "./api.js";
import { SamCause, SamDocumentError, SamInvalidDocument, clone, eventError, isObject, resourceError, templateError, type JsonObject } from "./common.js";
import type { SamContext } from "./context.js";
import { SAM_RESOURCE_ATTRIBUTE_COVERAGE, eventCoverage, propertyCoverage, resourceCoverage, unsupported } from "./coverage.js";
import { CONNECTOR_TYPE, extractEmbeddedConnectors, translateConnector, type ConnectorView } from "./connector.js";
import { translateFunction } from "./function.js";
import { SAM_SCHEMA_RESOURCE_PROPERTIES } from "./generated/schema.js";
import { mergeGlobals, parseGlobals } from "./globals.js";
import { applyDefaultHttpDefinitionBody, applyImplicitHttpApi, translateHttpApi } from "./http-api.js";
import { samParameterValues } from "./parameters.js";
import { expandPolicyTemplates } from "./policies.js";
import { resolveChangedLogicalIds, resolveSamReferences } from "./references.js";
import { translateSimpleTable } from "./simple-table.js";
import { isOpenApi3Version } from "./swagger.js";
import { translateLayerVersion } from "./layer.js";
import { translateStateMachine } from "./state-machine.js";

export const SERVERLESS_TRANSFORM = "AWS::Serverless-2016-10-31";

export interface ServerlessExpansionContext {
  readonly region: string;
  readonly partition: string;
  readonly accountId: string;
  readonly stackName?: string;
  /** Supplied template parameter values, for the few properties SAM resolves. */
  readonly parameterValues?: Readonly<Record<string, string>>;
  /** Milliseconds since the epoch; only AlwaysDeploy uses it. */
  readonly now?: number;
}

/** The failure in the format CloudFormation reports for this transform. */
export class ServerlessTransformError extends Error {
  readonly code = "ValidationError" as const;

  constructor(public readonly causes: readonly string[]) {
    super(`Transform ${SERVERLESS_TRANSFORM} failed with: Invalid Serverless Application Specification document. Number of errors found: ${causes.length}. ${causes.join(" ")}`);
    this.name = "ServerlessTransformError";
  }
}

const SHARED_USAGE_PLAN_IDS = new Set(["ServerlessUsagePlan", "ServerlessApiKey", "ServerlessUsagePlanKey"]);

const GLOBALS_SECTION: Readonly<Record<string, string>> = {
  "AWS::Serverless::Function": "Function",
  "AWS::Serverless::Api": "Api",
  "AWS::Serverless::HttpApi": "HttpApi",
  "AWS::Serverless::SimpleTable": "SimpleTable",
  "AWS::Serverless::LayerVersion": "LayerVersion",
  "AWS::Serverless::StateMachine": "StateMachine",
};

/** Reject every SAM resource type, property, event, and attribute StackSim does not implement. */
function checkCoverage(resources: Record<string, JsonObject>): void {
  const causes: SamCause[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = resource.Type;
    // Embedded Connectors (on any resource) are expanded by extractEmbeddedConnectors.
    if (typeof type !== "string" || !type.startsWith("AWS::Serverless::")) continue;
    const coverage = resourceCoverage(type);
    if (coverage === undefined) { causes.push(resourceError(logicalId, `Resource type ${type} is not supported by StackSim.`)); continue; }
    if (coverage !== "implemented") { causes.push(resourceError(logicalId, unsupported(`Resource type ${type}`, coverage))); continue; }
    for (const attribute of Object.keys(resource)) {
      const attributeCoverage = SAM_RESOURCE_ATTRIBUTE_COVERAGE[attribute];
      if (attributeCoverage !== undefined && attributeCoverage !== "implemented") causes.push(resourceError(logicalId, unsupported(`Attribute '${attribute}'`, attributeCoverage)));
    }
    if (resource.Properties === undefined || resource.Properties === null) continue;
    if (!isObject(resource.Properties)) { causes.push(resourceError(logicalId, "Attribute 'Properties' should be a map.")); continue; }
    const known = new Set(SAM_SCHEMA_RESOURCE_PROPERTIES[type] ?? []);
    for (const property of Object.keys(resource.Properties)) {
      if (!known.has(property)) { causes.push(resourceError(logicalId, `property ${property} not defined for resource of type ${type}`)); continue; }
      const propertyState = propertyCoverage(type, property) ?? "non-goal";
      if (propertyState !== "implemented") causes.push(resourceError(logicalId, unsupported(`Property '${property}'`, propertyState)));
    }
    const events = resource.Properties.Events;
    if ((type !== "AWS::Serverless::Function" && type !== "AWS::Serverless::StateMachine") || !isObject(events)) continue;
    let hasApiEvent = false;
    for (const [eventId, event] of Object.entries(events)) {
      if (!isObject(event) || typeof event.Type !== "string") continue;
      const state = eventCoverage(type, event.Type);
      if (!state) continue;
      if (state.event !== "implemented") { causes.push(resourceError(logicalId, eventError(eventId, unsupported(`Event type '${event.Type}'`, state.event)).message)); continue; }
      if (event.Type === "Api" || event.Type === "HttpApi") hasApiEvent = true;
      if (!isObject(event.Properties)) continue;
      for (const property of Object.keys(event.Properties)) {
        const propertyState = state.properties?.[property] ?? state.extraProperties?.[property];
        if (propertyState !== undefined && propertyState !== "implemented") causes.push(resourceError(logicalId, eventError(eventId, unsupported(`Property '${property}'`, propertyState)).message));
      }
    }
    if (hasApiEvent && resource.Condition !== undefined) causes.push(resourceError(logicalId, `A Condition on an ${type} with Api or HttpApi events is not supported by StackSim.`));
  }
  if (causes.length) throw new SamDocumentError(causes);
}

function fixOpenApiDefinitions(resources: Record<string, JsonObject>): void {
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::Serverless::Api" || !isObject(resource.Properties)) continue;
    const properties = resource.Properties;
    if (!("OpenApiVersion" in properties) || !properties.__MANAGE_SWAGGER) continue;
    const version = typeof properties.OpenApiVersion === "number" ? String(properties.OpenApiVersion) : properties.OpenApiVersion;
    if (!isOpenApi3Version(version)) continue;
    properties.OpenApiVersion = version;
    if (isObject(properties.DefinitionBody)) {
      properties.DefinitionBody.openapi = version;
      delete properties.DefinitionBody.swagger;
    }
  }
}

function expand(document: JsonObject, context: ServerlessExpansionContext): JsonObject {
  const template = clone(document);
  if (!isObject(template.Resources)) throw new SamDocumentError([templateError("'Resources' section is required")]);
  const resources = template.Resources as Record<string, JsonObject>;
  for (const [logicalId, resource] of Object.entries(resources)) if (!isObject(resource)) throw new SamDocumentError([templateError(`All 'Resources' must be Objects. Resource '${logicalId}' is not an Object.`)]);

  const globals = parseGlobals(template);
  checkCoverage(resources);
  applyDefaultRestDefinitionBody(resources);
  applyDefaultHttpDefinitionBody(resources);
  applyImplicitRestApi(resources, template.Globals);
  applyImplicitHttpApi(resources, template.Globals);
  const causes: SamCause[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    const section = GLOBALS_SECTION[resource.Type as string];
    if (!section) continue;
    try {
      const merged = mergeGlobals(globals, section, logicalId, resource);
      if (merged !== undefined) resource.Properties = merged;
    } catch (error) {
      if (error instanceof SamCause) throw new SamDocumentError([error]);
      throw error;
    }
  }
  delete template.Globals;
  fixOpenApiDefinitions(resources);
  // SAM collects embedded-connector errors and still translates the rest of the template.
  const embeddedCauses: SamCause[] = [];
  extractEmbeddedConnectors(resources, embeddedCauses);
  const originalIds = new Set(Object.keys(resources));
  const originalTypes = new Map(Object.entries(resources).map(([logicalId, resource]) => [logicalId, resource.Type]));
  for (const [logicalId, resource] of Object.entries(resources)) {
    if ((resource.Type !== "AWS::Serverless::Function" && resource.Type !== "AWS::Serverless::StateMachine") || !isObject(resource.Properties) || resource.Properties.Policies === undefined) continue;
    try { resource.Properties.Policies = expandPolicyTemplates(logicalId, resource.Properties.Policies); }
    catch (error) { if (error instanceof SamCause) causes.push(error); else throw error; }
  }

  const samContext: SamContext = {
    region: context.region,
    partition: context.partition,
    accountId: context.accountId,
    parameters: samParameterValues(template, context.parameterValues, context.region, context.partition),
    template,
    resources,
    output: {},
    references: new Map(),
    functionNames: new Map(),
    now: context.now ?? 0,
    bucketTags: new Map(),
    changedLogicalIds: new Map(),
    sharedUsagePlan: { dependsOn: [], apiStages: [], stageKeys: [], conditions: [], anyApiWithoutCondition: false },
  };
  const functions = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Serverless::Function");
  const stateMachines = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Serverless::StateMachine");
  const apis = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Serverless::Api" || resource.Type === "AWS::Serverless::HttpApi");
  const others = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Serverless::SimpleTable" || resource.Type === "AWS::Serverless::LayerVersion");
  const connectors = Object.entries(resources).filter(([, resource]) => resource.Type === CONNECTOR_TYPE);
  for (const [, resource] of functions) recordFunctionNames(samContext, resource);
  const failed = new Set(causes.map(cause => cause.message));
  const generated: Record<string, JsonObject> = {};
  const translated: string[] = [];
  for (const [logicalId, resource] of [...functions, ...stateMachines, ...apis, ...others]) {
    if ([...failed].some(message => message.startsWith(`Resource with id [${logicalId}] `))) continue;
    try {
      const output = resource.Type === "AWS::Serverless::Function" ? translateFunction(samContext, logicalId, resource)
        : resource.Type === "AWS::Serverless::StateMachine" ? translateStateMachine(samContext, logicalId, resource)
        : resource.Type === "AWS::Serverless::Api" ? translateApi(samContext, logicalId, resource)
          : resource.Type === "AWS::Serverless::HttpApi" ? translateHttpApi(samContext, logicalId, resource)
            : resource.Type === "AWS::Serverless::LayerVersion" ? translateLayerVersion(samContext, logicalId, resource)
              : translateSimpleTable(logicalId, resource);
      for (const [generatedId, generatedResource] of Object.entries(output)) {
        // APIs with a SHARED usage plan each write the plan they share; the last one holds every API.
        if (generatedId !== logicalId && (Object.hasOwn(resources, generatedId) || (Object.hasOwn(generated, generatedId) && !SHARED_USAGE_PLAN_IDS.has(generatedId)))) {
          causes.push(new SamCause(`Transforming resource with id [${logicalId}] attempts to create a new resource with id [${generatedId}] and type "${String(generatedResource.Type)}". A resource with that id already exists within this template. Please use a different id for that resource.`));
          continue;
        }
        generated[generatedId] = generatedResource;
      }
      translated.push(logicalId);
    } catch (error) {
      // SAM's translator does not catch InvalidDocumentException per resource: it ends the transform.
      if (error instanceof SamInvalidDocument) throw new SamDocumentError(error.causes);
      if (error instanceof SamDocumentError) causes.push(...error.causes);
      else if (error instanceof SamCause) causes.push(error.message.startsWith("Resource with id [") || error.message.startsWith("Structure of the SAM template") ? error : resourceError(logicalId, error.message));
      else throw error;
    }
  }
  for (const logicalId of translated) delete resources[logicalId];
  Object.assign(resources, generated);
  // Connectors come last: their profiles read the CloudFormation resources the rest of the template became.
  const view: ConnectorView = { resources, originalTypes };
  for (const [logicalId, resource] of connectors) {
    try {
      const output = translateConnector(view, logicalId, resource);
      delete resources[logicalId];
      for (const [generatedId, generatedResource] of Object.entries(output)) {
        if (originalIds.has(generatedId)) {
          causes.push(new SamCause(`Transforming resource with id [${logicalId}] attempts to create a new resource with id [${generatedId}] and type "${String(generatedResource.Type)}". A resource with that id already exists within this template. Please use a different id for that resource.`));
          continue;
        }
        resources[generatedId] = generatedResource;
      }
    } catch (error) {
      if (error instanceof SamCause) causes.push(error); else throw error;
    }
  }
  if (embeddedCauses.length || causes.length) throw new SamDocumentError([...embeddedCauses, ...causes]);
  for (const [bucketId, tags] of samContext.bucketTags) (resources[bucketId].Properties as JsonObject).Tags = tags;
  delete template.Transform;
  return resolveSamReferences(resolveChangedLogicalIds(template, samContext.changedLogicalIds), samContext.references) as JsonObject;
}

/**
 * Expand AWS::Serverless-2016-10-31. The expansion is a pure function of the
 * template and context: it never reads S3 or simulator state, and the same
 * input always produces the same output (AlwaysDeploy alone reads `now`).
 */
export function expandServerlessTransform(document: JsonObject, context: ServerlessExpansionContext): JsonObject {
  try {
    return expand(document, context);
  } catch (error) {
    if (error instanceof SamDocumentError) throw new ServerlessTransformError([...new Set(error.causes.map(cause => cause.message))]);
    if (error instanceof SamCause) throw new ServerlessTransformError([error.message]);
    throw error;
  }
}
