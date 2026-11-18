import { RE2JS } from "re2js";
import { fail, keys, record, wildcard, type Json } from "./query.js";

export interface SnapshotIndex {
  name: string; settings: Json; mappings: Json; aliases: Json; seq: number;
  packageVersions?: Record<string, string>;
  documents: Array<{ id: string; source: Json; seq: number; version: number; routing: string | null }>;
}
export interface SnapshotData { format: "stacksim-search-snapshot-v1"; indexes: SnapshotIndex[]; templates?: Json[]; pipelines?: Array<{ name: string; pipeline: Json }>; searchPipelines?: Array<{ name: string; pipeline: Json }> }
export const SNAPSHOT_BYTES = 96 * 1024 * 1024;

export function snapshotBoolean(value: any, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}
export function selectSnapshotIndexes<T extends { name: string }>(all: T[], input: any, ignoreMissing = false): T[] {
  if (input !== undefined && typeof input !== "string" && (!Array.isArray(input) || input.some(item => typeof item !== "string"))) fail("indices must be a string or array of strings");
  const patterns = input === undefined ? ["*"] : (Array.isArray(input) ? input : input.split(","));
  if (!patterns.length || patterns.length > 100 || patterns.some((part: string) => !part || part.length > 255)) fail("indices requires 1–100 nonempty patterns");
  const selected = new Map<string, T>();
  if (patterns[0].startsWith("-")) all.forEach(index => selected.set(index.name, index));
  for (const input of patterns) {
    const exclude = input.startsWith("-"), pattern = input.replace(/^-/, ""), matches = all.filter(index => wildcard(pattern === "_all" ? "*" : pattern, index.name));
    if (!matches.length && !ignoreMissing && !exclude && !/[?*]/.test(pattern)) fail(`Index [${pattern}] is absent from the snapshot selection`, "index_not_found_exception", 404);
    matches.forEach(index => exclude ? selected.delete(index.name) : selected.set(index.name, index));
  }
  return [...selected.values()];
}
export function snapshotRestoreOptions(input: Json): Json {
  keys(record(input, "restore"), ["indices", "ignore_unavailable", "include_global_state", "include_aliases", "rename_pattern", "rename_replacement", "partial", "index_settings", "ignore_index_settings"], "restore");
  for (const key of ["ignore_unavailable", "include_global_state", "include_aliases", "partial"]) snapshotBoolean(input[key], false, key);
  if (input.partial) fail("Partial snapshots are not supported");
  if (input.rename_pattern !== undefined || input.rename_replacement !== undefined) {
    if (typeof input.rename_pattern !== "string" || input.rename_pattern.length > 1024 || typeof input.rename_replacement !== "string" || input.rename_replacement.length > 1024) fail("Renaming requires a pattern and replacement of at most 1024 characters");
    try { RE2JS.compile(input.rename_pattern); } catch { fail("rename_pattern requires a valid RE2 expression"); }
  }
  if (input.index_settings !== undefined) record(input.index_settings, "index_settings");
  if (input.ignore_index_settings !== undefined && (!Array.isArray(input.ignore_index_settings) || input.ignore_index_settings.length > 100 || input.ignore_index_settings.some((item: any) => typeof item !== "string" || item.length > 255))) fail("ignore_index_settings requires at most 100 setting names");
  return structuredClone(input);
}
export function restoreIndexName(name: string, options: Json): string {
  if (options.rename_pattern === undefined) return name;
  try { return RE2JS.compile(options.rename_pattern).matcher(name).replaceAll(options.rename_replacement, true); }
  catch { return fail("Invalid snapshot rename replacement"); }
}
