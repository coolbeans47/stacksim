import { RE2JS } from "re2js";
import { fail, integer, keys, record, SearchError, wildcard, type Json } from "./query.js";

export const INGEST_PROCESSORS = ["set", "remove", "rename", "append", "convert", "json", "lowercase", "uppercase", "trim", "split", "join", "gsub", "drop", "fail", "pipeline"];
const COMMON = ["tag", "description", "ignore_failure", "on_failure"];
const OPTIONS: Record<string, string[]> = {
  set: ["field", "value", "copy_from", "override", "ignore_empty_value"], remove: ["field", "ignore_missing"],
  rename: ["field", "target_field", "ignore_missing", "override_target"], append: ["field", "value", "allow_duplicates"],
  convert: ["field", "target_field", "type", "ignore_missing"], json: ["field", "target_field", "add_to_root"],
  lowercase: ["field", "target_field", "ignore_missing"], uppercase: ["field", "target_field", "ignore_missing"], trim: ["field", "target_field", "ignore_missing"],
  split: ["field", "target_field", "separator", "ignore_missing", "preserve_trailing"], join: ["field", "target_field", "separator"],
  gsub: ["field", "target_field", "pattern", "replacement", "ignore_missing"], drop: [], fail: ["message"], pipeline: ["name", "ignore_missing_pipeline"],
};
export interface IngestDocument { _index: string; _id: string; _source: Json; _ingest: Json }
function fieldPath(value: any): string[] {
  if (typeof value !== "string" || !value || value.length > 512) return fail("Processor field must contain 1–512 characters");
  const parts = value.replace(/^_source\./, "").split(".");
  if (parts.length > 20 || parts.some(part => !part || part.startsWith("_") || ["constructor", "prototype"].includes(part) || /[{}]/.test(part))) fail("Ingest field paths cannot contain metadata, templates or reserved segments");
  return parts;
}
function read(source: Json, field: string): any {
  let value: any = source;
  for (const part of fieldPath(field)) { if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined; value = value[part]; }
  return value;
}
function write(source: Json, field: string, value: any, remove = false): void {
  const parts = fieldPath(field); let target = source;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(target, part)) { if (remove) return; target[part] = {}; }
    target = record(target[part], `Field ${part}`);
  }
  if (remove) delete target[parts.at(-1)!]; else Object.defineProperty(target, parts.at(-1)!, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
}
function template(value: any, doc: IngestDocument, depth = 0): any {
  if (depth > 20) fail("Ingest template nesting exceeds 20");
  if (typeof value === "string") {
    if (value.replace(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g, "").includes("{{")) fail("Only simple ingest field templates are supported");
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_all, field: string) => {
      const found = field === "_index" ? doc._index : field === "_id" ? doc._id : field.startsWith("_ingest.") ? doc._ingest[field.slice(8)] : read(doc._source, field);
      if (found === undefined || found === null) return "";
      if (typeof found === "object") fail("Ingest templates support scalar fields only"); return String(found);
    });
  }
  if (Array.isArray(value)) return value.map(item => template(item, doc, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, template(item, doc, depth + 1)]));
  return value;
}
function expression(value: string): RE2JS { try { return RE2JS.compile(value); } catch { return fail("Ingest patterns must be valid RE2 expressions"); } }
function processorList(value: any, depth = 0, budget = { count: 0 }): void {
  if (!Array.isArray(value) || value.length > 64 || depth > 8) fail("Pipeline processors require at most 64 entries and eight nested failure handlers");
  for (const processor of value) {
    if (++budget.count > 64) fail("Pipeline definition exceeds 64 processors");
    if (Object.keys(record(processor, "processor")).length !== 1) fail("Each processor requires exactly one type");
    const [kind, input] = Object.entries<any>(processor)[0];
    if (!INGEST_PROCESSORS.includes(kind)) fail(`Ingest processor [${kind}] is not implemented`);
    const config = record(input, kind); keys(config, [...COMMON, ...OPTIONS[kind]], `${kind} processor`);
    for (const key of ["ignore_failure", "ignore_missing", "override", "ignore_empty_value", "override_target", "allow_duplicates", "add_to_root", "preserve_trailing", "ignore_missing_pipeline"]) if (config[key] !== undefined && typeof config[key] !== "boolean") fail(`${key} must be boolean`);
    for (const key of ["tag", "description", "name", "message", "pattern", "replacement", "separator", "type"]) if (config[key] !== undefined && (typeof config[key] !== "string" || config[key].length > 4096)) fail(`${key} must be a string of at most 4096 characters`);
    if (OPTIONS[kind].includes("field")) { if (kind === "remove" && Array.isArray(config.field)) { if (!config.field.length || config.field.length > 100) fail("remove.field requires 1–100 fields"); config.field.forEach(fieldPath); } else fieldPath(config.field); }
    if (config.target_field !== undefined) fieldPath(config.target_field);
    if (kind === "rename" && config.target_field === undefined) fail("rename.target_field is required");
    if (kind === "set" && Number(Object.hasOwn(config, "value")) + Number(Object.hasOwn(config, "copy_from")) !== 1) fail("set requires either value or copy_from");
    if (config.copy_from !== undefined) fieldPath(config.copy_from);
    if (kind === "append" && !Object.hasOwn(config, "value")) fail("append.value is required");
    if (kind === "convert" && !["integer", "long", "float", "double", "string", "boolean", "auto"].includes(config.type)) fail("Unsupported conversion type");
    if (kind === "json" && config.add_to_root && config.target_field !== undefined) fail("json target_field and add_to_root cannot be combined");
    for (const key of kind === "gsub" ? ["pattern", "replacement"] : ["split", "join"].includes(kind) ? ["separator"] : kind === "fail" ? ["message"] : kind === "pipeline" ? ["name"] : []) if (typeof config[key] !== "string" || !config[key] && key !== "replacement" && key !== "separator") fail(`${kind}.${key} is required`);
    if (kind === "gsub" || kind === "split") expression(config.pattern ?? config.separator);
    if (kind === "pipeline") pipelineName(config.name);
    if (config.on_failure !== undefined) processorList(config.on_failure, depth + 1, budget);
    // Validate template syntax before accepting a definition, including nested values.
    if (kind === "set" || kind === "append" || kind === "fail") template(config.value ?? config.message, { _index: "", _id: "", _source: {}, _ingest: {} });
  }
}
export function pipelineName(value: any): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) fail("Pipeline IDs require 1–255 letters, digits, dots, underscores or hyphens"); return value; }
export function validateIngestPipeline(input: any): Json {
  const pipeline = record(input, "pipeline"); keys(pipeline, ["processors", "on_failure", "description", "version", "_meta"], "pipeline");
  if (Buffer.byteLength(JSON.stringify(pipeline)) > 262144) fail("Pipeline definitions must not exceed 256 KiB");
  if (pipeline.description !== undefined && (typeof pipeline.description !== "string" || pipeline.description.length > 4096)) fail("Pipeline description must not exceed 4096 characters");
  if (pipeline.version !== undefined) integer(pipeline.version, 0, 0, Number.MAX_SAFE_INTEGER);
  if (pipeline._meta !== undefined) record(pipeline._meta, "pipeline _meta");
  const budget = { count: 0 }; processorList(pipeline.processors, 0, budget); if (pipeline.on_failure !== undefined) processorList(pipeline.on_failure, 0, budget);
  return structuredClone(pipeline);
}
function convert(value: any, type: string): any {
  if (type === "auto") { if (typeof value !== "string") return value; if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true"; const n = value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : value; }
  if (value === null || typeof value === "object") fail("Cannot convert a null or object field");
  if (type === "string") return String(value);
  if (type === "boolean") { if (typeof value === "boolean") return value; if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true"; return fail("Boolean conversion requires true or false"); }
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) fail("Numeric conversion requires a number");
  const number = Number(value); if (!Number.isFinite(number)) fail("Numeric conversion requires a finite number");
  if (["integer", "long"].includes(type) && (!Number.isSafeInteger(number) || type === "integer" && (number < -2147483648 || number > 2147483647))) fail("Integer conversion is out of range");
  if (type === "float" && !Number.isFinite(Math.fround(number))) fail("Float conversion is out of range");
  return type === "float" ? Math.fround(number) : number;
}

/** Data-only transformations: no scripts, caller code, network or native plugins. */
export class IngestPipelines {
  constructor(private readonly get: (id: string) => Json | undefined, private readonly list: () => Array<{ name: string; pipeline: Json }>, private readonly put: (id: string, pipeline: Json) => void, private readonly remove: (id: string) => void, private readonly now: () => number) {}
  private required(id: string): Json { return this.get(id) ?? fail(`Pipeline [${id}] does not exist`, "resource_not_found_exception", 404); }
  run(id: string, index: string, documentId: string, source: Json): Json | null {
    const doc: IngestDocument = { _index: index, _id: documentId, _source: structuredClone(source), _ingest: { timestamp: new Date(this.now()).toISOString() } };
    return this.execute(this.required(id), doc, [], { remaining: 64, depth: 0 }) ? doc._source : null;
  }
  private execute(pipeline: Json, doc: IngestDocument, results: Json[], budget: { remaining: number; depth: number }, verbose = false): boolean {
    if (++budget.depth > 8) fail("Nested ingest pipeline depth exceeds eight");
    try { return this.steps(pipeline.processors, doc, results, budget, verbose); }
    catch (error) { if (error instanceof SearchError && [413, 429].includes(error.status)) throw error; if (!pipeline.on_failure?.length) throw error; return this.failure(pipeline.on_failure, doc, results, budget, verbose, error); }
    finally { budget.depth--; }
  }
  private failure(steps: Json[], doc: IngestDocument, results: Json[], budget: { remaining: number; depth: number }, verbose: boolean, error: unknown, kind?: string, tag?: string): boolean {
    const previous = { ...doc._ingest }; Object.assign(doc._ingest, { on_failure_message: error instanceof Error ? error.message : "Processor failed", on_failure_processor_type: kind ?? "", on_failure_processor_tag: tag ?? "" });
    try { return this.steps(steps, doc, results, budget, verbose); } finally { doc._ingest = previous; }
  }
  private steps(steps: Json[], doc: IngestDocument, results: Json[], budget: { remaining: number; depth: number }, verbose: boolean): boolean {
    for (const processor of steps) {
      if (--budget.remaining < 0) fail("Ingest execution exceeds 64 processor steps", "limit_exceeded_exception", 429);
      const [kind, config] = Object.entries<any>(processor)[0]; let alive = true;
      const result: Json = { processor_type: kind, ...(config.tag ? { tag: config.tag } : {}), ...(config.description ? { description: config.description } : {}) };
      try {
        alive = this.apply(kind, config, doc, results, budget, verbose);
        if (Buffer.byteLength(JSON.stringify(doc)) > 1024 * 1024) fail("Transformed document exceeds 1 MiB", "content_too_long_exception", 413);
        if (verbose) this.result(results, { ...result, status: alive ? "success" : "dropped", doc: alive ? structuredClone(doc) : null });
      } catch (error) {
        if (error instanceof SearchError && [413, 429].includes(error.status)) throw error;
        const detail = { type: error instanceof SearchError ? error.type : "illegal_argument_exception", reason: error instanceof SearchError ? error.message : "Processor failed" };
        if (verbose) this.result(results, { ...result, status: config.ignore_failure ? "error_ignored" : "error", error: detail });
        if (config.ignore_failure) continue;
        if (!config.on_failure?.length) throw error;
        alive = this.failure(config.on_failure, doc, results, budget, verbose, error, kind, config.tag);
      }
      if (!alive) return false;
    }
    return true;
  }
  private result(results: Json[], result: Json): void {
    const bytes = Buffer.byteLength(JSON.stringify(result)), used = (results as any).bytes ?? 0;
    if (used + bytes > 32 * 1024 * 1024) fail("Simulation response exceeds 32 MiB", "content_too_long_exception", 413);
    (results as any).bytes = used + bytes; results.push(result);
  }
  private apply(kind: string, config: Json, doc: IngestDocument, results: Json[], budget: { remaining: number; depth: number }, verbose: boolean): boolean {
    const source = doc._source, target = config.target_field ?? config.field;
    if (kind === "drop") return false;
    if (kind === "fail") return fail(template(config.message, doc));
    if (kind === "pipeline") { const pipeline = this.get(config.name); if (!pipeline && config.ignore_missing_pipeline) return true; return this.execute(pipeline ?? this.required(config.name), doc, results, budget, verbose); }
    if (kind === "set") {
      const value = config.copy_from !== undefined ? read(source, config.copy_from) : template(config.value, doc);
      if (value === undefined || value === null || value === "") { if (config.ignore_empty_value) return true; if (value === undefined) fail("set.copy_from field is missing"); }
      if (config.override !== false || read(source, config.field) == null) write(source, config.field, value); return true;
    }
    if (kind === "append") { const old = read(source, config.field), value = template(config.value, doc), added = Array.isArray(value) ? value : [value], current = old === undefined ? [] : Array.isArray(old) ? [...old] : [old]; for (const item of added) if (config.allow_duplicates !== false || !current.some(entry => JSON.stringify(entry) === JSON.stringify(item))) current.push(item); write(source, config.field, current); return true; }
    if (kind === "remove") { for (const field of Array.isArray(config.field) ? config.field : [config.field]) { if (read(source, field) === undefined && !config.ignore_missing) fail(`Field [${field}] is missing`); write(source, field, undefined, true); } return true; }
    const value = read(source, config.field);
    if (value === undefined || value === null) { if (config.ignore_missing) return true; fail(`Field [${config.field}] is missing or null`); }
    if (kind === "rename") { if (read(source, target) !== undefined && !config.override_target) fail(`Target field [${target}] already exists`); write(source, target, value); write(source, config.field, undefined, true); return true; }
    if (kind === "json") { if (typeof value !== "string") fail("JSON processor requires a string"); let parsed; try { parsed = JSON.parse(value); } catch { fail("JSON processor input is invalid"); } if (config.add_to_root) { record(parsed, "Parsed JSON"); for (const [key, item] of Object.entries(parsed)) write(source, key, item); } else write(source, target, parsed); return true; }
    if (kind === "join") { if (!Array.isArray(value) || value.some(item => item === null || typeof item === "object")) fail("join requires an array of scalar values"); write(source, target, value.join(config.separator)); return true; }
    const transform = (item: any): any => {
      if (kind === "convert") return convert(item, config.type);
      if (typeof item !== "string") fail(`${kind} requires string fields`);
      if (kind === "lowercase") return item.toLowerCase(); if (kind === "uppercase") return item.toUpperCase(); if (kind === "trim") return item.trim();
      if (kind === "gsub") return expression(config.pattern).matcher(item).replaceAll(config.replacement, true);
      if (kind === "split") return expression(config.separator).split(item, config.preserve_trailing ? -1 : 0);
      return fail("Unsupported ingest processor");
    };
    if (kind === "split" && Array.isArray(value)) fail("split requires a string field");
    write(source, target, Array.isArray(value) ? value.map(transform) : transform(value)); return true;
  }
  request(method: string, parts: string[], body: Json, query: URLSearchParams): Json {
    const simulate = parts.at(-1) === "_simulate", name = parts[2] === "_simulate" ? undefined : parts[2];
    for (const key of query.keys()) if (!["pretty", ...(simulate ? ["verbose"] : method === "PUT" ? ["if_version"] : [])].includes(key) || query.getAll(key).length !== 1) fail(`Unsupported or repeated ingest parameter [${key}]`);
    for (const key of ["pretty", "verbose"]) if (query.has(key) && !["true", "false"].includes(query.get(key)!)) fail(`${key} must be boolean`);
    if (simulate) {
      if (!["POST", "GET"].includes(method)) fail("Simulation requires GET or POST");
      keys(body, ["pipeline", "docs"], "simulation"); if (name && body.pipeline !== undefined) fail("Choose a saved or an inline pipeline");
      const pipeline = name ? this.required(name) : validateIngestPipeline(body.pipeline);
      if (!Array.isArray(body.docs) || !body.docs.length || body.docs.length > 1000) fail("Simulation requires 1–1000 documents");
      let bytes = 0; const verbose = query.get("verbose") === "true";
      return { docs: body.docs.map((input: any) => {
        keys(record(input, "simulation document"), ["_index", "_id", "_source"], "simulation document");
        for (const key of ["_index", "_id"]) if (input[key] !== undefined && typeof input[key] !== "string") fail(`Simulation ${key} must be a string`);
        const doc: IngestDocument = { _index: input._index ?? "_index", _id: input._id ?? "_id", _source: structuredClone(record(input._source, "_source")), _ingest: { timestamp: new Date(this.now()).toISOString() } }, results: Json[] = [];
        if (Buffer.byteLength(JSON.stringify(doc)) > 1024 * 1024) fail("Simulation documents must not exceed 1 MiB");
        let output: Json;
        try { const alive = this.execute(pipeline, doc, results, { remaining: 64, depth: 0 }, verbose); output = verbose ? { processor_results: results } : { doc: alive ? doc : null }; }
        catch (error) { if (!(error instanceof SearchError)) throw error; output = verbose ? { processor_results: results, error: { type: error.type, reason: error.message } } : { error: { type: error.type, reason: error.message } }; }
        bytes += Buffer.byteLength(JSON.stringify(output)); if (bytes > 32 * 1024 * 1024) fail("Simulation response exceeds 32 MiB", "content_too_long_exception", 413); return output;
      }) };
    }
    if (method === "GET") { const found = this.list().filter(row => !name || wildcard(name, row.name)); if (name && !found.length) this.required(name); return Object.fromEntries(found.map(row => [row.name, row.pipeline])); }
    if (!name) fail("A pipeline ID is required"); pipelineName(name);
    if (method === "DELETE") { this.required(name); this.remove(name); return { acknowledged: true }; }
    if (method !== "PUT") fail("Pipeline methods are GET, PUT and DELETE");
    const pipeline = validateIngestPipeline(body);
    if (query.has("if_version")) { const version = integer(query.get("if_version"), 0, 0, Number.MAX_SAFE_INTEGER); if (this.required(name).version !== version) fail("Pipeline version conflict", "version_conflict_engine_exception", 409); pipeline.version = version + 1; }
    if (!this.get(name) && this.list().length >= 100) fail("At most 100 ingest pipelines are supported", "limit_exceeded_exception", 429);
    this.put(name, pipeline); return { acknowledged: true };
  }
}
