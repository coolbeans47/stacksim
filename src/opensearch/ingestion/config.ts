import { AwsError } from "../../errors.js";
import { parseCloudFormationYaml } from "../../cloudformation/yaml.js";
import { parseS3Scan, type S3ScanConfig } from './s3-config.js';
import { parseDynamoSource, DYNAMO_METADATA, type DynamoSourceConfig } from './dynamodb-config.js';

type Json = Record<string, any>;
export interface IngestionConfig {
  name: string;
  path: string;
  compression: "none" | "gzip";
  codec: "json" | "ndjson";
  s3?: S3ScanConfig;
  dynamodb?: DynamoSourceConfig;
  processors: Array<{ kind: string; config: Json }>;
  sink: { host: string; region: string; roleArn: string; serverless: boolean; index: string; documentId?: string; action?: string; documentVersion?: string; versionType?: 'external'; maxRetries?: number; dlq?: { bucket: string; prefix: string; region: string; roleArn: string } };
}
const invalid = (message: string): never => { throw new AwsError("ValidationException", message, 400); };
function object(value: unknown, allowed: string[] | undefined, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be an object`);
  if (allowed) for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unsupported ${label} option: ${key}`);
  return value as Json;
}
function array(value: any, label: string, maximum = 100): any[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) return invalid(`${label} requires 1–${maximum} entries`);
  return value;
}
function boolean(value: any, label: string): void { if (value !== undefined && typeof value !== "boolean") invalid(`${label} must be boolean`); }
function field(value: any): string[] {
  if (typeof value !== "string" || !value.length || value.length > 256 || /\$\{|%\{/.test(value)) return invalid("Event paths must be literal strings of 1–256 characters");
  const parts = value.replace(/^\//, "").split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length > 16 || parts.some(part => !part || ["__proto__", "constructor", "prototype"].includes(part))) invalid("Invalid or unsafe event path");
  return parts;
}
function format(value: any, label: string, metadata = false): string {
  if (typeof value !== "string" || !value.length || value.length > 512) return invalid(`${label} must be a nonempty format string of at most 512 characters`);
  const literal = value.replace(/\$\{(\/[^{}]+)\}/g, (_, path) => { field(path); return ""; }).replace(/\$\{getMetadata\("([a-z_]+)"\)\}/g, (match, key) => metadata && DYNAMO_METADATA.includes(key) ? '' : match);
  if (/\$\{|%\{/.test(literal)) invalid(`${label} supports literal strings and event-field substitutions only`);
  return value;
}
function role(value: any): string {
  if (typeof value !== "string" || !/^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(value)) return invalid("A valid IAM pipeline role ARN is required");
  return value;
}

/** Strict executable subset; no user scripts, native plugins, network fetches or
 * speculative success for unrecognized Data Prepper options. */
export function parseIngestionConfig(source: string, pipelineRoleArn?: string): IngestionConfig {
  if (typeof source !== "string" || Buffer.byteLength(source) > 100000) invalid("Pipeline configuration must be at most 100,000 bytes");
  let document: Json;
  try { document = object(parseCloudFormationYaml(source), undefined, "Pipeline configuration"); }
  catch (error) { if (error instanceof AwsError) throw error; return invalid(`Invalid pipeline YAML: ${(error as Error).message}`); }
  if (document.version !== "2") invalid('Only the embedded version: "2" pipeline profile is supported');
  const names = Object.keys(document).filter(key => key !== "version");
  if (names.length !== 1 || !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(names[0])) invalid("Exactly one named sub-pipeline is supported");
  const name = names[0], pipeline = object(document[name], ["source", "processor", "sink"], "pipeline");
  const input = object(pipeline.source, ["http", "s3", "dynamodb"], "source");
  if (Object.keys(input).length !== 1) invalid('Exactly one HTTP, S3 or DynamoDB source is required');
  const http = input.http === undefined && (input.s3 !== undefined || input.dynamodb !== undefined) ? {} : object(input.http, ["path", "compression", "codec"], "HTTP source");
  if (http.path !== undefined && typeof http.path !== "string") invalid("HTTP source path must be a string");
  const path = (http.path ?? "/log/ingest").replaceAll("${pipelineName}", name);
  if (typeof path !== "string" || !/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.length > 512 || /\/\.|\/\//.test(path)) invalid("HTTP source path is invalid");
  if (http.compression !== undefined && !["none", "gzip"].includes(http.compression)) invalid("HTTP compression must be none or gzip");
  if (http.codec !== undefined) { const codec = object(http.codec, ["ndjson"], "codec"); object(codec.ndjson, [], "NDJSON codec"); }
  const processors: IngestionConfig["processors"] = [];
  if (pipeline.processor !== undefined) {
    if (!Array.isArray(pipeline.processor) || pipeline.processor.length > 32) invalid("At most 32 processors are supported");
    for (const definition of pipeline.processor) {
      const entries = Object.entries(object(definition, undefined, "processor"));
      if (entries.length !== 1) invalid("Each processor requires exactly one plugin");
      const [kind, value] = entries[0]; let config: Json;
      if (kind === "add_entries") {
        config = object(value, ["entries"], kind);
        for (const item of array(config.entries, "add_entries.entries")) { const entry = object(item, ["key", "value", "overwrite_if_key_exists"], kind); field(entry.key); if (!Object.hasOwn(entry, "value")) invalid("add_entries requires a value"); boolean(entry.overwrite_if_key_exists, "overwrite_if_key_exists"); }
      } else if (kind === "delete_entries") {
        config = object(value, ["with_keys"], kind); array(config.with_keys, "with_keys").forEach(field);
      } else if (kind === "rename_keys") {
        config = object(value, ["entries"], kind);
        for (const item of array(config.entries, "rename_keys.entries")) { const entry = object(item, ["from_key", "to_key", "overwrite_if_to_key_exists"], kind); field(entry.from_key); field(entry.to_key); boolean(entry.overwrite_if_to_key_exists, "overwrite_if_to_key_exists"); }
      } else if (kind === "parse_json") {
        config = object(value, ["source", "destination"], kind); field(config.source ?? "message"); if (config.destination !== undefined) field(config.destination);
      } else if (kind === "convert_type" || kind === "convert_entry_type") {
        config = object(value, ["key", "keys", "type"], kind);
        if (Boolean(config.key) === Boolean(config.keys)) invalid("convert_type requires exactly one of key or keys");
        (config.keys ? array(config.keys, "keys") : [config.key]).forEach(field);
        if (config.type !== undefined && !["integer", "long", "double", "string", "boolean"].includes(config.type)) invalid("Unsupported conversion type");
      } else return invalid(`Processor ${kind} is not implemented`);
      processors.push({ kind, config });
    }
  }
  const sinks = array(pipeline.sink, "sink", 1), wrapper = object(sinks[0], ["opensearch"], "sink"), sink = object(wrapper.opensearch, ["hosts", "aws", "index", "index_type", "document_id", "max_retries", "dlq", "action", "document_version", "document_version_type"], "OpenSearch sink");
  const hosts = array(sink.hosts, "hosts", 1), host = hosts[0];
  try { const url = new URL(host); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(); }
  catch { invalid("Sink hosts must contain one HTTPS origin without credentials, query, path or fragment"); }
  const aws = object(sink.aws, ["region", "sts_role_arn", "serverless"], "sink.aws");
  if (typeof aws.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(aws.region)) invalid("sink.aws.region is required");
  boolean(aws.serverless, "serverless");
  if (pipelineRoleArn && aws.sts_role_arn && pipelineRoleArn !== aws.sts_role_arn) invalid("PipelineRoleArn and sink role must match in the embedded profile");
  const roleArn = role(pipelineRoleArn ?? aws.sts_role_arn);
  const dynamodb = input.dynamodb === undefined ? undefined : parseDynamoSource(input.dynamodb, roleArn, aws.region);
  if (dynamodb) {
    if (aws.serverless) invalid('DynamoDB ingestion currently requires a managed OpenSearch sink');
    if (typeof sink.index !== 'string' || sink.index.includes('${/')) invalid('DynamoDB sink indexes require a literal or source metadata so deletes use the same destination');
    if (sink.document_id !== '${getMetadata("primary_key")}' || sink.action !== '${getMetadata("opensearch_action")}' || sink.document_version !== '${getMetadata("document_version")}' || sink.document_version_type !== 'external') invalid('DynamoDB sinks require primary_key, opensearch_action and document_version metadata with external versioning');
  } else if ([sink.action, sink.document_version, sink.document_version_type].some(value => value !== undefined)) invalid('Sink action and version metadata require a DynamoDB source');
  if (sink.index_type !== undefined && !["custom", "management_disabled"].includes(sink.index_type)) invalid("Only custom/management_disabled index types are supported");
  if (sink.max_retries !== undefined && (!Number.isInteger(sink.max_retries) || sink.max_retries < 0 || sink.max_retries > 100)) invalid("max_retries must be an integer from 0 to 100");
  let dlq: IngestionConfig["sink"]["dlq"];
  if (sink.dlq !== undefined) {
    const config = object(object(sink.dlq, ["s3"], "dlq").s3, ["bucket", "key_path_prefix", "region", "sts_role_arn"], "S3 DLQ");
    if (typeof config.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) invalid("DLQ requires a valid S3 bucket");
    if (config.region !== aws.region || config.sts_role_arn && config.sts_role_arn !== roleArn) invalid("DLQ must use the sink Region and pipeline role");
    if (config.key_path_prefix !== undefined && (typeof config.key_path_prefix !== "string" || config.key_path_prefix.length > 512 || config.key_path_prefix.includes("${"))) invalid("DLQ prefix must be a literal string of at most 512 characters");
    dlq = { bucket: config.bucket, prefix: config.key_path_prefix ?? "", region: config.region, roleArn };
  }
  return { name, path, compression: http.compression ?? "none", codec: http.codec ? "ndjson" : "json", ...(input.s3 === undefined ? {} : { s3: parseS3Scan(input.s3, roleArn, aws.region) }), ...(dynamodb ? { dynamodb } : {}), processors, sink: { host: new URL(host).origin, region: aws.region, roleArn, serverless: aws.serverless ?? false, index: format(sink.index, "index", Boolean(dynamodb)), ...(sink.document_id !== undefined ? { documentId: format(sink.document_id, "document_id", Boolean(dynamodb)) } : {}), ...(dynamodb ? { action: sink.action, documentVersion: sink.document_version, versionType: 'external' as const } : {}), ...(sink.max_retries !== undefined ? { maxRetries: sink.max_retries } : {}), ...(dlq ? { dlq } : {}) } };
}

function get(event: Json, path: string): any { let value: any = event; for (const part of field(path)) { if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined; value = value[part]; } return value; }
function put(event: Json, path: string, value: any, overwrite = false): boolean {
  const parts = field(path); let parent = event;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(parent, part)) Object.defineProperty(parent, part, { value: {}, writable: true, configurable: true, enumerable: true });
    parent = object(parent[part], undefined, "Event path parent");
  }
  const key = parts.at(-1)!; if (!overwrite && Object.hasOwn(parent, key)) return false;
  Object.defineProperty(parent, key, { value, writable: true, configurable: true, enumerable: true }); return true;
}
function remove(event: Json, path: string): void { const parts = field(path); let parent = event; for (const part of parts.slice(0, -1)) { if (!parent || !Object.hasOwn(parent, part)) return; parent = parent[part]; } if (parent && typeof parent === "object") delete parent[parts.at(-1)!]; }
export function renderIngestionFormat(template: string, event: Json, metadata: Json = {}): string {
  return template.replace(/\$\{(\/[^{}]+)\}|\$\{getMetadata\("([a-z_]+)"\)\}/g, (_, path, key) => { const value = path ? get(event, path) : Object.hasOwn(metadata, key) ? metadata[key] : undefined; if (!["string", "number", "boolean"].includes(typeof value)) return invalid("A sink format field is missing or not scalar"); return String(value); });
}
export function transformIngestionEvent(config: IngestionConfig, source: unknown): Json {
  const event = structuredClone(object(source, undefined, "Event"));
  for (const { kind, config: options } of config.processors) {
    if (kind === "add_entries") for (const entry of options.entries) put(event, entry.key, structuredClone(entry.value), entry.overwrite_if_key_exists);
    if (kind === "delete_entries") for (const key of options.with_keys) remove(event, key);
    if (kind === "rename_keys") for (const entry of options.entries) { const value = get(event, entry.from_key); if (value !== undefined && entry.from_key !== entry.to_key && put(event, entry.to_key, value, entry.overwrite_if_to_key_exists)) remove(event, entry.from_key); }
    if (kind === "parse_json") {
      const raw = get(event, options.source ?? "message"); if (raw === undefined) continue;
      if (typeof raw !== "string") invalid("parse_json source is not a string");
      let parsed: any; try { parsed = JSON.parse(raw); } catch { invalid("parse_json source contains invalid JSON"); }
      if (options.destination !== undefined) put(event, options.destination, parsed, true);
      else for (const [key, value] of Object.entries(object(parsed, undefined, "Parsed JSON root"))) Object.defineProperty(event, key, { value, enumerable: true, configurable: true, writable: true });
    }
    if (kind === "convert_type" || kind === "convert_entry_type") for (const key of options.keys ?? [options.key]) {
      const value = get(event, key); if (value === undefined || value === null) continue;
      let converted: any;
      const type = options.type ?? "integer";
      if (type === "string") { if (typeof value === "object") invalid("Object-to-string conversion is unavailable"); converted = String(value); }
      else if (type === "boolean") { if (value === true || value === "true") converted = true; else if (value === false || value === "false") converted = false; else invalid("Invalid boolean conversion"); }
      else {
        if (!["string", "number"].includes(typeof value) || String(value).trim() === "") invalid("Invalid numeric conversion");
        converted = Number(value);
        if (!Number.isFinite(converted) || type !== "double" && !Number.isSafeInteger(converted) || type === "integer" && (converted < -2147483648 || converted > 2147483647)) invalid("Numeric conversion is outside the supported range");
      }
      put(event, key, converted, true);
    }
    if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024) invalid("Transformed event exceeds 1 MiB");
  }
  return event;
}
