import { SamCause, canonicalJson, cfnResource, clone, isObject, logicalIdFromIntrinsic, resourceError, validateProperties, type JsonObject, type PropertySpec } from "./common.js";
import { connectorPairCoverage } from "./coverage.js";
import { SAM_CONNECTOR_PROFILES, SAM_CONNECTOR_RESOURCE_PROPERTIES, type SamConnectorProfile } from "./generated/connector-profiles.js";

export const CONNECTOR_TYPE = "AWS::Serverless::Connector";

/** SamConnector's property types: dict_of, one_of, and list_of validators, so SAM's messages name no type. */
const CONNECTOR_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  Source: { type: "map", required: true, generic: true },
  Destination: { type: "map-or-list-of-map", required: true, generic: true },
  Permissions: { type: "list-of-string", required: true, generic: true },
};

/** The resource attributes SAM's Resource keeps (and copies onto every resource a connector generates). */
const SUPPORTED_ATTRIBUTES = ["DeletionPolicy", "UpdatePolicy", "Condition", "UpdateReplacePolicy", "Metadata"] as const;

/** Profiles name CloudFormation types; a reference without Id may name the SAM type instead. */
const SAM_TO_CFN_TYPE: Readonly<Record<string, string>> = {
  "AWS::Serverless::Function": "AWS::Lambda::Function",
  "AWS::Serverless::StateMachine": "AWS::StepFunctions::StateMachine",
  "AWS::Serverless::Api": "AWS::ApiGateway::RestApi",
  "AWS::Serverless::HttpApi": "AWS::ApiGatewayV2::Api",
  "AWS::Serverless::SimpleTable": "AWS::DynamoDB::Table",
};

/** Python truthiness of a JSON value. */
const truthy = (value: unknown): boolean => !(value === undefined || value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && !value.length) || (isObject(value) && !Object.keys(value).length));
const nonBlankString = (value: unknown): value is string => typeof value === "string" && value !== "";
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [value];

function insertUnique(values: unknown, additions: unknown): unknown[] {
  const result = [...asArray(clone(values))];
  for (const addition of asArray(additions)) if (!result.some(value => canonicalJson(value) === canonicalJson(addition))) result.push(addition);
  return result;
}

/** A ConnectorResourceError: SAM reports it against the connector. */
class ConnectorResourceError extends Error {}

interface ResourceReference {
  readonly logicalId?: string;
  readonly resourceType: string;
  readonly arn?: unknown;
  readonly roleName?: unknown;
  readonly queueUrl?: unknown;
  readonly resourceId?: unknown;
  readonly name?: unknown;
  readonly qualifier?: unknown;
}

/** What connectors see: the template's resources once every other SAM resource is translated. */
export interface ConnectorView {
  readonly resources: Record<string, JsonObject>;
  /** Resource types before translation (SAM's original_template), for the aws:sam:connectors metadata. */
  readonly originalTypes: ReadonlyMap<string, unknown>;
}

/**
 * SAM's profile_replace: `%{Name}` becomes the value when it is the whole
 * string, and otherwise a Fn::Sub variable; any string with `${…}` is wrapped
 * in Fn::Sub. A placeholder whose value is missing fails.
 */
function profileReplace(value: unknown, replacements: ReadonlyArray<readonly [string, unknown]>): unknown {
  if (Array.isArray(value)) return value.map(item => profileReplace(item, replacements));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, profileReplace(item, replacements)]));
  if (typeof value !== "string") return value;
  let text = value;
  const variables: JsonObject = {};
  for (const [key, replacement] of replacements) {
    const pattern = `%{${key}}`;
    const variable = key.replace(/[^A-Za-z0-9]/g, "");
    if (text.includes(pattern) && (replacement === undefined || replacement === null)) throw new ConnectorResourceError(`${key} is missing.`);
    if (text === pattern) return replacement;
    if (text.includes(pattern)) {
      text = text.replaceAll(pattern, `\${${variable}}`);
      variables[variable] = replacement;
    }
  }
  if (/\$\{.+\}/.test(text)) return { "Fn::Sub": Object.keys(variables).length ? [text, variables] : text };
  return text;
}

function eventsRuleRole(connectingId: unknown, connectingArn: unknown, properties: JsonObject): unknown {
  for (const target of Array.isArray(properties.Targets) ? properties.Targets : []) {
    if (!isObject(target)) continue;
    const targetLogicalId = logicalIdFromIntrinsic(target.Arn);
    if ((targetLogicalId && targetLogicalId === connectingId) || (truthy(connectingArn) && canonicalJson(target.Arn) === canonicalJson(connectingArn))) return target.RoleArn;
  }
  return undefined;
}

/** SAM's _get_resource_role_name: a Ref to the role named by the resource's role property, if that is a Ref or GetAtt. */
function roleName(connecting: JsonObject, resourceProperties: JsonObject, properties: JsonObject): unknown {
  const inputs = isObject(resourceProperties.Inputs) ? resourceProperties.Inputs : {};
  const roleProperty = inputs.Role;
  const role = typeof roleProperty === "string" ? properties[roleProperty]
    : isObject(roleProperty) && roleProperty.Function === "GetEventsRuleRole" ? eventsRuleRole(connecting.Id, connecting.Arn, properties)
      : undefined;
  if (!truthy(role)) return undefined;
  const logicalId = logicalIdFromIntrinsic(role);
  return logicalId ? { Ref: logicalId } : undefined;
}

/** SAM's get_resource_reference for one Source or Destination entry. */
function resourceReference(reference: JsonObject, view: ConnectorView, connecting: JsonObject): ResourceReference {
  const idProvided = Object.hasOwn(reference, "Id");
  const otherProvided = Object.keys(reference).some(key => key !== "Id" && key !== "Qualifier");
  if (idProvided === otherProvided) throw new ConnectorResourceError("Must provide 'Id' (with optional 'Qualifier') or a supported combination of other properties.");
  const logicalId = reference.Id;
  if (!truthy(logicalId)) {
    const type = reference.Type;
    if (!nonBlankString(type)) throw new ConnectorResourceError("'Type' is missing or not a string.");
    return {
      resourceType: SAM_TO_CFN_TYPE[type] ?? type,
      arn: reference.Arn,
      roleName: reference.RoleName,
      queueUrl: reference.QueueUrl,
      resourceId: reference.ResourceId,
      name: reference.Name,
      qualifier: reference.Qualifier,
    };
  }
  if (!nonBlankString(logicalId)) throw new ConnectorResourceError("'Id' is missing or not a string.");
  const resource = Object.hasOwn(view.resources, logicalId) ? view.resources[logicalId] : undefined;
  if (!truthy(resource)) throw new ConnectorResourceError(`Unable to find resource with logical ID '${logicalId}'.`);
  const type = resource!.Type;
  if (!nonBlankString(type)) throw new ConnectorResourceError("'Type' is missing or not a string.");
  const properties = isObject(resource!.Properties) ? resource!.Properties : {};
  const resourceProperties = profileReplace(SAM_CONNECTOR_RESOURCE_PROPERTIES[type] ?? {}, [["logicalId", logicalId]]) as JsonObject;
  const outputs = isObject(resourceProperties.Outputs) ? resourceProperties.Outputs : {};
  return {
    logicalId,
    resourceType: type,
    arn: outputs.Arn,
    roleName: roleName(connecting, resourceProperties, properties),
    queueUrl: outputs.Url,
    resourceId: outputs.Id,
    name: outputs.Name,
    qualifier: Object.hasOwn(reference, "Qualifier") ? reference.Qualifier : outputs.Qualifier,
  };
}

function addDependsOn(view: ConnectorView, logicalId: string, dependsOn: string): void {
  const resource = view.resources[logicalId];
  if (!resource) return;
  resource.DependsOn = insertUnique(resource.DependsOn ?? [], dependsOn);
}

/** SAM's replace_depends_on_logical_id: a DependsOn on the connector now names what it generated. */
function replaceDependsOn(view: ConnectorView, logicalId: string, replacement: string[]): void {
  for (const resource of Object.values(view.resources)) {
    const dependsOn = [...asArray(resource.DependsOn ?? [])];
    const index = dependsOn.indexOf(logicalId);
    if (index < 0) continue;
    dependsOn.splice(index, 1);
    resource.DependsOn = insertUnique(dependsOn, replacement);
  }
}

function eventSourceMappings(view: ConnectorView, eventSourceId: string, functionId: string): string[] {
  return Object.entries(view.resources).filter(([, resource]) => {
    if (resource.Type !== "AWS::Lambda::EventSourceMapping") return false;
    const properties = isObject(resource.Properties) ? resource.Properties : {};
    const resourceFunctionId = logicalIdFromIntrinsic(properties.FunctionName);
    const resourceEventSourceId = logicalIdFromIntrinsic(properties.EventSourceArn);
    return Boolean(resourceFunctionId && resourceEventSourceId && resourceFunctionId === functionId && resourceEventSourceId === eventSourceId);
  }).map(([logicalId]) => logicalId);
}

interface Connector {
  readonly logicalId: string;
  readonly permissions: readonly string[];
  readonly dependsOn: unknown;
  readonly attributes: JsonObject;
}

function policyDocument(connector: Connector, categories: Readonly<Record<string, unknown>>): JsonObject {
  const statements: unknown[] = [];
  for (const [name, category] of Object.entries(categories)) if (connector.permissions.includes(name)) statements.push(...((category as JsonObject).Statement as unknown[]));
  return { Version: "2012-10-17", Statement: statements };
}

function generatedAttributes(connector: Connector): JsonObject {
  return { ...(truthy(connector.dependsOn) ? { DependsOn: clone(connector.dependsOn) } : {}), ...clone(connector.attributes) };
}

/** SamConnector.generate_resources for one source/destination pair. */
function generateResources(view: ConnectorView, connector: Connector, source: ResourceReference, destination: ResourceReference, index: number, multiDestination: boolean): Record<string, JsonObject> {
  const { logicalId } = connector;
  const profile = clone(SAM_CONNECTOR_PROFILES[source.resourceType]?.[destination.resourceType]) as SamConnectorProfile | undefined;
  if (!profile) throw resourceError(logicalId, `Unable to create connector from ${source.resourceType} to ${destination.resourceType}; it's not supported or the template is invalid.`);
  const categories = Object.keys(profile.Properties.AccessCategories);
  const valid = categories.join(", ");
  if (!connector.permissions.length) throw resourceError(logicalId, `'Permissions' cannot be empty; valid values are: ${valid}.`);
  if (connector.permissions.some(permission => !categories.includes(permission))) {
    throw resourceError(logicalId, `Unsupported 'Permissions' provided for connector from ${source.resourceType} to ${destination.resourceType}; valid values are: ${valid}.`);
  }
  const combinations = profile.Properties.ValidAccessCategories;
  if (combinations) {
    const sorted = combinations.map(combination => [...combination].sort());
    const requested = JSON.stringify([...connector.permissions].sort());
    if (!sorted.some(combination => JSON.stringify(combination) === requested)) {
      throw resourceError(logicalId, `Unsupported 'Permissions' provided for connector from ${source.resourceType} to ${destination.resourceType}; valid combinations are: ${sorted.map(combination => combination.join(" + ")).join(", ")}.`);
    }
  }
  let properties: SamConnectorProfile["Properties"];
  try {
    properties = profileReplace(profile.Properties, [
      ["Source.Arn", source.arn],
      ["Destination.Arn", destination.arn],
      ["Source.ResourceId", source.resourceId],
      ["Destination.ResourceId", destination.resourceId],
      ["Source.Name", source.name],
      ["Destination.Name", destination.name],
      ["Source.Qualifier", source.qualifier],
      ["Destination.Qualifier", destination.qualifier],
    ]) as SamConnectorProfile["Properties"];
  } catch (error) {
    if (error instanceof ConnectorResourceError) throw resourceError(logicalId, error.message);
    throw error;
  }
  const side = properties.SourcePolicy ? "Source" : "Destination";
  const target = properties.SourcePolicy ? source : destination;
  const suffix = (name: string) => multiDestination ? `${logicalId}${name}Destination${index}` : `${logicalId}${name}`;
  const generated: Record<string, JsonObject> = {};
  switch (profile.Type) {
    case "AWS_IAM_ROLE_MANAGED_POLICY": {
      if (!truthy(target.roleName)) throw resourceError(logicalId, `Unable to get IAM role name from '${side}' resource.`);
      const policyId = suffix("Policy");
      generated[policyId] = cfnResource("AWS::IAM::ManagedPolicy", { PolicyDocument: policyDocument(connector, properties.AccessCategories), Roles: [target.roleName] }, generatedAttributes(connector));
      if (properties.DependedBy === "DESTINATION_EVENT_SOURCE_MAPPING" && source.logicalId && destination.logicalId) {
        // Only one mapping may connect a source to a function, or the deployment fails.
        const mappings = eventSourceMappings(view, source.logicalId, destination.logicalId);
        if (mappings.length === 1) addDependsOn(view, mappings[0], policyId);
      }
      if (properties.DependedBy === "SOURCE" && source.logicalId) addDependsOn(view, source.logicalId, policyId);
      break;
    }
    case "AWS_SQS_QUEUE_POLICY":
      if (!truthy(target.queueUrl)) throw resourceError(logicalId, `Unable to get SQS queue URL from '${side}' resource.`);
      generated[suffix("QueuePolicy")] = cfnResource("AWS::SQS::QueuePolicy", { PolicyDocument: policyDocument(connector, properties.AccessCategories), Queues: [target.queueUrl] }, generatedAttributes(connector));
      break;
    case "AWS_SNS_TOPIC_POLICY":
      if (!truthy(target.arn)) throw resourceError(logicalId, `Unable to get SNS topic ARN from '${side}' resource.`);
      generated[suffix("TopicPolicy")] = cfnResource("AWS::SNS::TopicPolicy", { Topics: [target.arn], PolicyDocument: policyDocument(connector, properties.AccessCategories) }, generatedAttributes(connector));
      break;
    case "AWS_LAMBDA_PERMISSION":
      if (!truthy(target.arn)) throw resourceError(logicalId, `Unable to get Lambda function ARN from '${side}' resource.`);
      for (const [name, category] of Object.entries(properties.AccessCategories)) {
        if (!connector.permissions.includes(name)) continue;
        generated[suffix(`${name}LambdaPermission`)] = cfnResource("AWS::Lambda::Permission", {
          Action: category.Action,
          FunctionName: target.arn,
          Principal: category.Principal,
          SourceArn: category.SourceArn,
          SourceAccount: category.SourceAccount,
        }, generatedAttributes(connector));
      }
      break;
  }
  // SAM accepts the pair; StackSim generates it only when it can back and enforce what it generates.
  const coverage = connectorPairCoverage(source.resourceType, destination.resourceType);
  if (coverage !== undefined) throw resourceError(logicalId, coverage);
  return generated;
}

/** SamConnector._add_connector_metadata: the aws:sam:connectors entry, keeping any Metadata the connector declares. */
function addConnectorMetadata(view: ConnectorView, connector: Connector, generated: Record<string, JsonObject>, source: ResourceReference, destination: ResourceReference): void {
  const originalType = (reference: ResourceReference) => {
    const type = reference.logicalId === undefined ? undefined : view.originalTypes.get(reference.logicalId);
    return truthy(type) ? type : reference.resourceType;
  };
  const metadata = { "aws:sam:connectors": { [connector.logicalId]: { Source: { Type: originalType(source) }, Destination: { Type: originalType(destination) } } } };
  for (const resource of Object.values(generated)) resource.Metadata = { ...(isObject(resource.Metadata) ? resource.Metadata : {}), ...clone(metadata) };
}

/**
 * Translate one AWS::Serverless::Connector, as SAM's SamConnector does once
 * every other SAM resource is translated. DependsOn edits on the view's
 * resources (event source mappings, a source state machine, and anything
 * that depended on the connector) happen in place.
 */
export function translateConnector(view: ConnectorView, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  validateProperties(logicalId, properties, CONNECTOR_PROPERTIES);
  const sourceEntry = properties.Source as JsonObject;
  const destinations = isObject(properties.Destination) ? [properties.Destination] : properties.Destination as JsonObject[];
  const multiDestination = !isObject(properties.Destination);
  const permissions = properties.Permissions;
  const attributes: JsonObject = {};
  for (const name of SUPPORTED_ATTRIBUTES) if (Object.hasOwn(resource, name)) attributes[name] = resource[name];
  const connector: Connector = {
    logicalId,
    // SAM deduplicates with a set; a single-key map (an intrinsic) skips the type check and yields its key.
    permissions: [...new Set(Array.isArray(permissions) ? permissions as string[] : Object.keys(permissions as JsonObject))],
    dependsOn: resource.DependsOn,
    attributes,
  };
  const generated: Record<string, JsonObject> = {};
  destinations.forEach((destinationEntry, index) => {
    let destination: ResourceReference;
    let source: ResourceReference;
    try {
      destination = resourceReference(destinationEntry, view, sourceEntry);
      source = resourceReference(sourceEntry, view, destinationEntry);
    } catch (error) {
      if (error instanceof ConnectorResourceError) throw resourceError(logicalId, error.message);
      throw error;
    }
    const resources = generateResources(view, connector, source, destination, index, multiDestination);
    addConnectorMetadata(view, connector, resources, source, destination);
    Object.assign(generated, resources);
  });
  replaceDependsOn(view, logicalId, Object.keys(generated));
  if (!Object.keys(generated).length) throw resourceError(logicalId, "'Destination' is an empty list");
  return generated;
}

/**
 * SAM's Translator._get_embedded_connectors: each entry of a resource's
 * `Connectors` attribute becomes the connector `<Resource><Name>` with Source
 * `{Id: <Resource>}` plus its SourceReference. The attribute is removed from
 * every resource. Causes are collected, as SAM collects them, and the
 * transform continues.
 */
export function extractEmbeddedConnectors(resources: Record<string, JsonObject>, causes: SamCause[]): void {
  const connectors: Record<string, JsonObject> = {};
  for (const [sourceId, resource] of Object.entries(resources)) {
    if (!Object.hasOwn(resource, "Connectors")) continue;
    if (!isObject(resource.Connectors)) { causes.push(resourceError(sourceId, `Attribute '${sourceId}.Connectors' should be a map.`)); continue; }
    for (const [name, entry] of Object.entries(resource.Connectors)) {
      const logicalId = sourceId + name;
      try {
        if (!isObject(entry)) throw resourceError(logicalId, `${sourceId}.${logicalId} should be a map.`);
        const connector = clone(entry);
        connector.Type = CONNECTOR_TYPE;
        if (!isObject(connector.Properties)) throw resourceError(sourceId, `Attribute 'Connectors.${name}.Properties' should be a map.`);
        const properties = connector.Properties;
        properties.Source = { Id: sourceId };
        if (Object.hasOwn(properties, "SourceReference")) {
          const sourceReference = properties.SourceReference;
          if (!isObject(sourceReference)) throw resourceError(sourceId, `Property 'Connectors.${name}.Properties.SourceReference' should be a map.`);
          if (Object.hasOwn(sourceReference, "Id")) throw resourceError(name, "'Id' shouldn't be defined in 'SourceReference'.");
          Object.assign(properties.Source as JsonObject, sourceReference);
          delete properties.SourceReference;
        }
        const generated = connectorResource(logicalId, connector);
        if (Object.hasOwn(resources, logicalId)) {
          throw new SamCause(`Transforming resource with id [${sourceId}] attempts to create a new resource with id [${logicalId}] and type "${CONNECTOR_TYPE}". A resource with that id already exists within this template. Please use a different id for that resource.`);
        }
        connectors[logicalId] = generated;
      } catch (error) {
        if (error instanceof SamCause) causes.push(error); else throw error;
      }
    }
  }
  Object.assign(resources, connectors);
  for (const resource of Object.values(resources)) delete resource.Connectors;
}

/**
 * SamConnector.from_dict followed by to_dict for an embedded connector: the
 * logical ID must be alphanumeric, every property must be a connector
 * property, and only DependsOn and SAM's supported attributes are kept.
 */
function connectorResource(logicalId: string, connector: JsonObject): JsonObject {
  if (!/^[A-Za-z0-9]+$/.test(logicalId)) throw resourceError(logicalId, "Logical ids must be alphanumeric.");
  const properties = connector.Properties as JsonObject;
  for (const property of Object.keys(properties)) {
    if (!Object.hasOwn(CONNECTOR_PROPERTIES, property)) throw resourceError(logicalId, `property ${property} not defined for resource of type ${CONNECTOR_TYPE}`);
  }
  validateProperties(logicalId, properties, CONNECTOR_PROPERTIES);
  const result: JsonObject = { Type: CONNECTOR_TYPE };
  if (truthy(connector.DependsOn)) result.DependsOn = connector.DependsOn;
  for (const name of SUPPORTED_ATTRIBUTES) if (Object.hasOwn(connector, name)) result[name] = connector[name];
  result.Properties = Object.fromEntries(Object.keys(CONNECTOR_PROPERTIES).filter(name => properties[name] !== undefined && properties[name] !== null).map(name => [name, properties[name]]));
  return result;
}
