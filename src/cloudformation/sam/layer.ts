import { codeLocation } from "./function.js";
import { canonicalJson, cfnResource, isIntrinsic, isObject, logicalIdHash, passthroughAttributes, resourceError, validateProperties, type JsonObject, type PropertySpec } from "./common.js";
import type { SamContext } from "./context.js";
import { resolveParameterRefs } from "./parameters.js";

/** SamLayerVersion.property_types, in SAM's order. */
const LAYER_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  LayerName: { type: "string-or-map", generic: true },
  Description: { type: "string" },
  PublishLambdaVersion: { type: "boolean" },
  ContentUri: { type: "string-or-map", required: true, generic: true },
  CompatibleArchitectures: { type: "list-of-string-or-map", generic: true },
  CompatibleRuntimes: { type: "list-of-string-or-map", generic: true },
  LicenseInfo: { type: "string" },
  RetentionPolicy: { type: "string" },
};

/** Resource attributes SAM's resource model keeps (Resource._supported_resource_attributes). */
const SUPPORTED_ATTRIBUTES = ["DeletionPolicy", "UpdatePolicy", "Condition", "UpdateReplacePolicy", "Metadata"];
const RETENTION_OPTIONS = ["Retain", "Delete"];
const RETENTION_LIST = "['Retain', 'Delete']";

/** resolve_string_parameter_in_resource: resolve parameter references; the result must stay a string or map. */
function resolveString(context: SamContext, logicalId: string, value: unknown, property: string): unknown {
  if (value === undefined || value === null || value === "" || value === false || value === 0) return value;
  const resolved = resolveParameterRefs(value, context.parameters);
  if (typeof resolved !== "string" && !isObject(resolved)) throw resourceError(logicalId, `Could not resolve parameter for '${property}' or parameter is not a String.`);
  return resolved;
}

function retentionPolicy(logicalId: string, value: unknown): string | undefined {
  if (isIntrinsic(value)) throw resourceError(logicalId, `'RetentionPolicy' does not accept intrinsic functions, please use one of the following options: ${RETENTION_LIST}`);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw resourceError(logicalId, `Invalid 'RetentionPolicy' type, please use one of the following options: ${RETENTION_LIST}`);
  const option = RETENTION_OPTIONS.find(candidate => candidate.toLowerCase() === value.toLowerCase());
  if (!option) throw resourceError(logicalId, `'RetentionPolicy' must be one of the following options: ${RETENTION_LIST}.`);
  return option;
}

/**
 * AWS::Serverless::LayerVersion → `AWS::Lambda::LayerVersion` named
 * `<L><hash>`, where the hash covers the SAM resource (minus its deletion
 * and update policies and metadata), so every change publishes a new layer
 * version. The version is retained unless RetentionPolicy says Delete, and
 * LayerName defaults to the original logical ID so the layer ARN stays the
 * same apart from its version number. References to `<L>` are rewritten to
 * the new logical ID.
 */
export function translateLayerVersion(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties: JsonObject = isObject(resource.Properties) ? { ...resource.Properties } : {};
  validateProperties(logicalId, properties, LAYER_PROPERTIES);
  for (const property of ["LayerName", "LicenseInfo", "Description", "RetentionPolicy"]) {
    if (Object.hasOwn(properties, property)) properties[property] = resolveString(context, logicalId, properties[property], property);
  }
  const retention = retentionPolicy(logicalId, properties.RetentionPolicy);
  const attributes = passthroughAttributes(resource);
  if (!Object.hasOwn(attributes, "DeletionPolicy")) attributes.DeletionPolicy = "Retain";
  if (retention !== undefined) attributes.DeletionPolicy = retention;

  // SAM hashes its own resource dict: Type, DependsOn, attributes, and the (resolved) properties.
  const hashed: JsonObject = { Type: resource.Type };
  if (resource.DependsOn !== undefined && resource.DependsOn !== null && !(Array.isArray(resource.DependsOn) && resource.DependsOn.length === 0)) hashed.DependsOn = resource.DependsOn;
  for (const attribute of SUPPORTED_ATTRIBUTES) if (resource[attribute] !== undefined && !["DeletionPolicy", "UpdateReplacePolicy", "Metadata"].includes(attribute)) hashed[attribute] = resource[attribute];
  hashed.Properties = Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
  const newLogicalId = `${logicalId}${logicalIdHash(canonicalJson({ [logicalId]: hashed }))}`;
  context.changedLogicalIds.set(logicalId, newLogicalId);

  const architectures = properties.CompatibleArchitectures;
  if (!isIntrinsic(architectures)) {
    for (const architecture of Array.isArray(architectures) && architectures.length ? architectures : ["x86_64"]) {
      if (!isIntrinsic(architecture) && architecture !== "x86_64" && architecture !== "arm64") throw resourceError(newLogicalId, "CompatibleArchitectures needs to be a list of 'x86_64' or 'arm64'");
    }
  }
  const layerName = properties.LayerName === undefined || properties.LayerName === null || properties.LayerName === "" ? logicalId : properties.LayerName;
  return {
    [newLogicalId]: cfnResource("AWS::Lambda::LayerVersion", {
      LayerName: layerName,
      Description: properties.Description,
      Content: codeLocation(newLogicalId, properties.ContentUri, "ContentUri"),
      CompatibleArchitectures: properties.CompatibleArchitectures,
      CompatibleRuntimes: properties.CompatibleRuntimes,
      LicenseInfo: properties.LicenseInfo,
    }, { ...(hashed.DependsOn !== undefined ? { DependsOn: hashed.DependsOn } : {}), ...attributes }),
  };
}
