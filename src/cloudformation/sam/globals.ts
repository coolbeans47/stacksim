import { SAM_GLOBALS_SECTIONS, propertyCoverage, resourceCoverage, unsupported } from "./coverage.js";
import { SAM_SCHEMA_GLOBALS } from "./generated/schema.js";
import { SamDocumentError, globalsError, isIntrinsic, isObject, resourceError, type JsonObject } from "./common.js";

/** Globals keys that replace instead of merging (SAM's CUSTOM_STRATEGIES). */
const REPLACE_PATHS: Readonly<Record<string, ReadonlySet<string>>> = { Function: new Set(["Architectures"]) };

export interface ParsedGlobals {
  readonly sections: Readonly<Record<string, JsonObject>>;
}

/** Python's repr of a list of strings, as SAM prints supported values. */
const pythonList = (values: readonly string[]) => `[${values.map(value => `'${value}'`).join(", ")}]`;

/**
 * Validate the Globals section the way SAM does, then reject sections and keys
 * that StackSim does not implement yet.
 */
export function parseGlobals(template: JsonObject): ParsedGlobals | undefined {
  if (!Object.hasOwn(template, "Globals")) return undefined;
  const raw = template.Globals;
  if (!isObject(raw)) throw new SamDocumentError([globalsError("It must be a non-empty dictionary")]);
  const sectionNames = Object.keys(SAM_GLOBALS_SECTIONS).sort();
  const sections: Record<string, JsonObject> = {};
  const causes = [];
  for (const [section, properties] of Object.entries(raw)) {
    const type = SAM_GLOBALS_SECTIONS[section];
    if (!type) throw new SamDocumentError([globalsError(`'${section}' is not supported. Must be one of the following values - ${pythonList(sectionNames)}`)]);
    if (!isObject(properties)) throw new SamDocumentError([globalsError("Value of ${section} must be a dictionary")]);
    const supported = SAM_SCHEMA_GLOBALS[section] ?? [];
    for (const key of Object.keys(properties)) {
      if (!supported.includes(key)) throw new SamDocumentError([globalsError(`'${key}' is not a supported property of '${section}'. Must be one of the following values - ${pythonList(supported)}`)]);
    }
    const sectionCoverage = resourceCoverage(type) ?? "non-goal";
    if (sectionCoverage !== "implemented") { causes.push(globalsError(unsupported(`'${section}'`, sectionCoverage))); continue; }
    for (const key of Object.keys(properties)) {
      const coverage = propertyCoverage(type, key) ?? "non-goal";
      if (coverage !== "implemented") causes.push(globalsError(unsupported(`'${key}' in '${section}'`, coverage)));
    }
    sections[section] = properties;
  }
  if (causes.length) throw new SamDocumentError(causes);
  return { sections };
}

type Token = "primitive" | "dict" | "list";
const tokenOf = (value: unknown): Token => Array.isArray(value) ? "list" : isObject(value) && !isIntrinsic(value) ? "dict" : "primitive";

function mergeValue(global: unknown, local: unknown, path: string, replace: ReadonlySet<string>): unknown {
  const globalToken = tokenOf(global);
  if (globalToken !== tokenOf(local) || globalToken === "primitive") return local;
  if (replace.has(path)) return local;
  if (globalToken === "list") return [...(global as unknown[]), ...(local as unknown[])];
  const merged: JsonObject = { ...(global as JsonObject) };
  for (const [key, value] of Object.entries(local as JsonObject)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeValue(merged[key], value, path ? `${path}.${key}` : key, replace) : value;
  }
  return merged;
}

/** Merge a section's globals into one resource's properties, honoring IgnoreGlobals. */
export function mergeGlobals(globals: ParsedGlobals | undefined, section: string, logicalId: string, resource: JsonObject): JsonObject | undefined {
  const sectionGlobals = globals?.sections[section];
  const properties = isObject(resource.Properties) ? resource.Properties : resource.Properties === undefined ? {} : undefined;
  if (!sectionGlobals || properties === undefined) return properties;
  let applicable: JsonObject = sectionGlobals;
  const ignore = resource.IgnoreGlobals;
  if (ignore !== undefined && ignore !== null && ignore !== "" && !(Array.isArray(ignore) && ignore.length === 0)) {
    if (ignore === "*") return properties;
    if (!Array.isArray(ignore)) throw resourceError(logicalId, `Attribute 'IgnoreGlobals' is invalid. Resource ${logicalId} has invalid resource attribute 'IgnoreGlobals'.`);
    applicable = { ...sectionGlobals };
    for (const key of ignore) {
      if (typeof key !== "string" || !Object.hasOwn(applicable, key)) throw resourceError(logicalId, `Attribute 'IgnoreGlobals' is invalid. Resource ${logicalId} has invalid resource attribute 'IgnoreGlobals' on item '${String(key)}'.`);
      delete applicable[key];
    }
  }
  return mergeValue(applicable, properties, "", REPLACE_PATHS[section] ?? new Set()) as JsonObject;
}
