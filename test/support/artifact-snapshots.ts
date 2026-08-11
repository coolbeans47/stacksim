import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function normalizedAnalytics(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("v2:deflate64:")) return value;
  const encoded = value.split(":", 3)[2];
  return `v2:plaintext:${gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")}`;
}

function normalizeCdkMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCdkMetadata);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, normalizeCdkMetadata(item)]));
  if (record.Type === "AWS::CDK::Metadata" && normalized.Properties && typeof normalized.Properties === "object") {
    const properties = normalized.Properties as Record<string, unknown>;
    properties.Analytics = normalizedAnalytics(properties.Analytics);
  }
  return normalized;
}

function replaceHashes(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let normalized = value;
    for (const [rawHash, semanticHash] of replacements) normalized = normalized.replaceAll(rawHash, semanticHash);
    return normalized;
  }
  if (Array.isArray(value)) return value.map(item => replaceHashes(item, replacements));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    replaceHashes(key, replacements) as string,
    replaceHashes(item, replacements),
  ]));
}

function normalizeAssetDestinations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAssetDestinations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (key !== "destinations" || !item || typeof item !== "object" || Array.isArray(item)) {
      return [key, normalizeAssetDestinations(item)];
    }
    const destinations = Object.values(item as Record<string, unknown>)
      .map(normalizeAssetDestinations)
      .sort((left, right) => {
        const leftJson = JSON.stringify(canonical(left));
        const rightJson = JSON.stringify(canonical(right));
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
      });
    return [key, destinations];
  }));
}

function semanticJsonDigest(bytes: Buffer, replacements: ReadonlyMap<string, string>): string {
  const parsed = JSON.parse(bytes.toString("utf8"));
  const replaced = replaceHashes(normalizeCdkMetadata(parsed), replacements);
  const assetManifest = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && "version" in parsed && ("files" in parsed || "dockerImages" in parsed);
  const normalized = assetManifest ? normalizeAssetDestinations(replaced) : replaced;
  return sha256(JSON.stringify(canonical(normalized)));
}

/**
 * Hashes a CDK assembly by JSON meaning rather than serialization details.
 *
 * CDK stores gzip-compressed construct analytics in every synthesized template.
 * Different zlib builds may emit different valid streams for the same analytics.
 * The raw template hash then propagates into asset IDs and manifest object URLs.
 * This helper snapshots the decompressed analytics and replaces every propagated
 * raw template hash with its semantic template hash before canonicalizing JSON.
 */
export async function semanticCdkAssemblyDigests(
  outputDirectory: string,
  templateFiles: readonly string[],
  jsonFiles: readonly string[],
): Promise<Record<string, string>> {
  const templateBytes = new Map<string, Buffer>();
  const replacements = new Map<string, string>();
  const result: Record<string, string> = {};
  const requestedTemplates = new Set(templateFiles);
  const normalizationTemplates = new Set(templateFiles);

  // A cloud assembly manifest can contain sibling stacks that the caller is
  // not snapshotting. Their raw template hashes still appear in asset object
  // URLs, so normalize those propagated hashes too. Otherwise compressor
  // differences in an unrelated stack make the manifest OS-dependent.
  if (jsonFiles.includes("manifest.json")) {
    const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")) as {
      artifacts?: Record<string, { properties?: { templateFile?: unknown } }>;
    };
    for (const artifact of Object.values(manifest.artifacts ?? {})) {
      if (typeof artifact.properties?.templateFile === "string") normalizationTemplates.add(artifact.properties.templateFile);
    }
  }

  for (const name of normalizationTemplates) {
    const bytes = await readFile(join(outputDirectory, name));
    templateBytes.set(name, bytes);
    const semanticHash = semanticJsonDigest(bytes, new Map());
    replacements.set(sha256(bytes), semanticHash);
    if (requestedTemplates.has(name)) result[name] = semanticHash;
  }

  for (const name of jsonFiles) {
    const bytes = templateBytes.get(name) ?? await readFile(join(outputDirectory, name));
    result[name] = semanticJsonDigest(bytes, replacements);
  }
  return result;
}

export interface ZipContentEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ZipContentSnapshot {
  entries: number;
  uncompressedBytes: number;
  sha256: string;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minimumOffset = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimumOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

/** Returns a complete payload snapshot while ignoring compressor-specific bytes. */
export function zipContentSnapshot(zip: Buffer): ZipContentSnapshot {
  const end = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries: ZipContentEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`Invalid ZIP central-directory entry ${index}`);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 assets are not supported by the test snapshot reader");
    }
    if (flags & 0x1) throw new Error("Encrypted ZIP entries are not supported");
    const path = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header is missing for ${path}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined;
    if (!content) throw new Error(`Unsupported ZIP compression method ${method} for ${path}`);
    if (content.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${path}`);
    if (!path.endsWith("/")) entries.push({ path, bytes: content.length, sha256: sha256(content) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error("ZIP contains duplicate file paths");
  return {
    entries: entries.length,
    uncompressedBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(JSON.stringify(entries)),
  };
}
