import { analyze, fail, integer, keys, record, type Json } from "./query.js";
import { slowMilliseconds, SLOW_SETTINGS } from "./logging.js";

const TYPES = new Set(["text", "keyword", "byte", "short", "integer", "long", "float", "half_float", "double", "boolean", "date", "object", "nested", "knn_vector"]);
export function validateMappings(mappings: Json, depth = 0, analyzerNames?: Set<string>): void {
  if (depth > 20) fail("Mapping nesting exceeds the local limit");
  keys(record(mappings, "mappings"), ["properties", "dynamic", "_meta", "_source"], "mappings");
  if (mappings.dynamic !== undefined && ![true, false, "strict"].includes(mappings.dynamic)) fail("dynamic must be true, false, or strict");
  if (mappings.properties !== undefined) record(mappings.properties, "mappings.properties");
  if (mappings._source !== undefined) { keys(record(mappings._source, "_source"), ["enabled"], "_source"); if (mappings._source.enabled !== true) fail("Disabling _source is not implemented"); }
  for (const [name, field] of Object.entries<any>(mappings.properties ?? {})) {
    if (!name || name.startsWith("_")) fail("Mapping fields must have nonempty, nonreserved names");
    record(field, name);
    if (field.type === "knn_vector") {
      keys(field, ["type", "dimension", "space_type", "data_type"], name);
      if (depth) fail("Vector fields are supported only at the top level");
      if (field.dimension === undefined) fail("Vector dimension is required");
      integer(field.dimension, 0, 1, 4096);
      if (field.data_type !== undefined && field.data_type !== "float") fail("Only float vectors are implemented");
      if (field.space_type !== undefined && !["l2", "l1", "linf", "cosinesimil", "innerproduct"].includes(field.space_type)) fail("Unsupported vector space_type");
      continue;
    }
    keys(field, ["type", "properties", "fields", "dynamic", "analyzer", "search_analyzer", "index", "doc_values", "null_value", "ignore_above", "coerce", "format"], name);
    if (!TYPES.has(field.type ?? "object")) fail(`Mapping type [${field.type}] is not implemented`);
    if (field.index !== undefined && field.index !== true || field.doc_values !== undefined && field.doc_values !== true) fail("Disabled field indexing/doc_values is not implemented");
    if (field.coerce !== undefined && typeof field.coerce !== "boolean") fail("coerce must be boolean");
    if (field.ignore_above !== undefined) integer(field.ignore_above, 256, 0, 1048576);
    if (field.null_value !== undefined && !["string", "number", "boolean"].includes(typeof field.null_value)) fail("null_value must be a scalar");
    if (field.analyzer && !analyzerNames?.has(field.analyzer)) analyze("", field.analyzer);
    if (field.search_analyzer && !analyzerNames?.has(field.search_analyzer)) analyze("", field.search_analyzer);
    if (field.format && field.format !== "strict_date_optional_time||epoch_millis") fail("Only the default date format is implemented");
    if (field.properties) validateMappings({ properties: field.properties, dynamic: field.dynamic ?? true }, depth + 1, analyzerNames);
    if (field.fields) validateMappings({ properties: field.fields }, depth + 1, analyzerNames);
  }
}

export function mergeMappings(previous: Json, update: Json, analyzerNames?: Set<string>): Json {
  validateMappings(update, 0, analyzerNames);
  const merged = structuredClone(previous);
  for (const [key, value] of Object.entries(update)) {
    if (key !== "properties") { merged[key] = value; continue; }
    merged.properties ??= {};
    for (const [name, field] of Object.entries<any>(value as Json)) {
      const old = Object.hasOwn(merged.properties, name) ? merged.properties[name] : undefined;
      if (old && (old.type ?? "object") !== (field.type ?? old.type ?? "object")) fail(`Cannot change the type of [${name}]`, "illegal_argument_exception");
      if (old?.analyzer && field.analyzer && old.analyzer !== field.analyzer) fail(`Cannot change the analyzer of [${name}]`);
      if (old?.type === "knn_vector") for (const key of ["dimension", "space_type", "data_type"]) if (field[key] !== undefined && field[key] !== (old[key] ?? (key === "space_type" ? "l2" : key === "data_type" ? "float" : undefined))) fail(`Cannot change vector ${key} of [${name}]`);
      Object.defineProperty(merged.properties, name, { value: old ? { ...old, ...field, ...(field.properties ? { properties: mergeMappings({ properties: old.properties ?? {} }, { properties: field.properties }, analyzerNames).properties } : {}), ...(field.fields ? { fields: mergeMappings({ properties: old.fields ?? {} }, { properties: field.fields }, analyzerNames).properties } : {}) } : structuredClone(field), enumerable: true, configurable: true, writable: true });
    }
  }
  return merged;
}

/** Validate a document against a cloned mapping, so rejected writes cannot mutate it. */
export function mapDocument(source: Json, mappings: Json): Json {
  const next = structuredClone(mappings); next.properties ??= {};
  const walk = (document: Json, mapping: Json, prefix: string, inheritedDynamic: any, depth = 0): void => {
    if (depth > 20) fail("Document nesting exceeds the local limit", "mapper_parsing_exception");
    const dynamic = mapping.dynamic ?? inheritedDynamic; mapping.properties ??= {};
    for (const [name, original] of Object.entries(document)) {
      const label = prefix ? `${prefix}.${name}` : name;
      const values = Array.isArray(original) ? original : [original];
      const nonnull = values.filter(value => value !== null);
      let field = Object.hasOwn(mapping.properties, name) ? mapping.properties[name] : undefined;
      if (!field) {
        if (!nonnull.length) continue;
        if (dynamic === "strict") fail(`Mapping set to strict; dynamic introduction of [${label}] is not allowed`, "strict_dynamic_mapping_exception");
        if (dynamic === false) continue;
        const value = nonnull[0];
        field = typeof value === "object" ? { properties: {} } : typeof value === "boolean" ? { type: "boolean" } : typeof value === "number" ? { type: Number.isInteger(value) ? "long" : "float" } : { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } };
        Object.defineProperty(mapping.properties, name, { value: field, enumerable: true, writable: true, configurable: true });
      }
      if (field.type === "knn_vector") {
        if (original === null) continue;
        if (!Array.isArray(original) || original.length !== Number(field.dimension) || original.some(value => typeof value !== "number" || !Number.isFinite(Math.fround(value)))) fail(`Vector [${label}] requires ${field.dimension} finite float components`, "mapper_parsing_exception");
        if (field.space_type === "cosinesimil" && original.every(value => Math.fround(value) === 0)) fail("Cosine vectors cannot have zero magnitude", "mapper_parsing_exception");
        continue;
      }
      for (let value of nonnull) {
        const type = field.type ?? "object";
        if (type === "object" || type === "nested") { walk(record(value, label), field, label, dynamic, depth + 1); continue; }
        if (typeof value === "object") fail(`Cannot parse object as ${type} in [${label}]`, "mapper_parsing_exception");
        if (["byte", "short", "integer", "long", "float", "half_float", "double"].includes(type)) {
          if (field.coerce !== false && typeof value === "string" && value.trim()) value = Number(value);
          if (typeof value !== "number" || !Number.isFinite(value)) fail(`Failed to parse [${label}] as ${type}`, "mapper_parsing_exception");
          const limits: Record<string, number> = { byte: 128, short: 32768, integer: 2147483648, long: Number.MAX_SAFE_INTEGER };
          if (limits[type] && (!Number.isInteger(value) || value < -limits[type] || (type === "long" ? value > limits[type] : value >= limits[type]))) fail(`Value out of range for [${label}]`, "mapper_parsing_exception");
        } else if (type === "boolean" && typeof value !== "boolean") fail(`Failed to parse [${label}] as boolean`, "mapper_parsing_exception");
        else if (type === "date" && !(typeof value === "number" && Number.isFinite(value)) && !(typeof value === "string" && Number.isFinite(Date.parse(value)))) fail(`Failed to parse [${label}] as date`, "mapper_parsing_exception");
      }
    }
  };
  walk(source, next, "", next.dynamic ?? true);
  return next;
}

export function indexSettings(input: Json = {}, previous: Json = {}, creating = true): Json {
  record(input, "settings"); const flat: Json = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "index") { for (const [nested, item] of Object.entries(record(value, "settings.index"))) flat[nested] = item; }
    else flat[key.replace(/^index\./, "")] = value;
  }
  keys(flat, ["number_of_shards", "number_of_replicas", "refresh_interval", "max_result_window", "knn", "default_pipeline", "final_pipeline", "search.default_pipeline", "blocks.write", "plugins.index_state_management.rollover_alias", "analysis", ...SLOW_SETTINGS], "settings");
  const result = { number_of_shards: "1", number_of_replicas: "0", refresh_interval: "1s", max_result_window: "10000", ...previous };
  for (const [key, value] of Object.entries(flat)) {
    if (key === "analysis") { if (!creating && JSON.stringify(value) !== JSON.stringify(previous.analysis)) fail("Index analysis settings are immutable"); (result as Json).analysis = structuredClone(record(value, "analysis")); continue; }
    if (key === "blocks.write") { if (value === null) { (result as Json)[key] = "false"; continue; } if (![true, false, "true", "false"].includes(value)) fail("index.blocks.write must be boolean"); }
    if (key === "plugins.index_state_management.rollover_alias" && (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(value))) fail("Invalid ISM rollover alias");
    if (key === "search.default_pipeline") { if (value === null) { (result as Json)[key] = "_none"; continue; } if (typeof value !== "string" || value !== "_none" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) fail("Invalid search pipeline ID"); }
    if (!creating && key === "number_of_shards" && String(value) !== result.number_of_shards) fail("number_of_shards is immutable");
    if (["default_pipeline", "final_pipeline"].includes(key) && (typeof value !== "string" || value !== "_none" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value))) fail("Invalid ingest pipeline ID");
    if (key === "knn") { if (![true, false, "true", "false"].includes(value)) fail("index.knn must be boolean"); if (!creating && String(value) !== String(previous.knn ?? "false")) fail("index.knn is immutable"); }
    if (key === "number_of_shards" && Number(value) !== 1) fail("The embedded engine supports one shard");
    if (key === "number_of_replicas" && Number(value) !== 0) fail("Replicas require multiple nodes and are unavailable locally");
    if (key === "refresh_interval" && !/^(?:-1|[1-9]\d{0,5}(?:ms|s|m))$/.test(String(value))) fail("Invalid refresh_interval");
    if (key === "max_result_window") integer(value, 10000, 1, 10000);
    if (SLOW_SETTINGS.includes(key) && (typeof value !== "string" || Number.isNaN(slowMilliseconds(value)) || slowMilliseconds(value) > 86400000 && value !== "-1")) fail("Slow log thresholds require -1 or a duration from 0ms to 24h in ms, s or m");
    (result as Json)[key] = String(value);
  }
  return result;
}
