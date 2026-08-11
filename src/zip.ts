import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { AwsError } from "./errors.js";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const DEFAULT_MAX_ENTRY_COUNT = 10_000;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_OBJECT_KEY_BYTES = 1_024;
const ALLOWED_GENERAL_PURPOSE_FLAGS = 0x080e; // deflate options, data descriptor, UTF-8 names

function u16(data: Buffer, offset: number): number { return data.readUInt16LE(offset); }
function u32(data: Buffer, offset: number): number { return data.readUInt32LE(offset); }

export interface ZipExtractionOptions {
  maxUncompressedSize?: number;
  maxEntryCount?: number;
  maxEntrySize?: number;
}

export interface ZipExtractionResult { uncompressedSize: number; fileCount: number }

/** A completely validated regular file from an archive. */
export interface ValidatedZipEntry {
  readonly name: string;
  readonly content: Buffer;
}

export interface ValidatedZipArchive extends ZipExtractionResult {
  readonly entries: readonly ValidatedZipEntry[];
}

function invalid(message: string): never {
  throw new AwsError("InvalidParameterValueException", message);
}

function boundedLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return result;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_OBJECT_KEY_BYTES) invalid("ZIP contains an invalid entry name");
  let name: string;
  try { name = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { invalid("ZIP entry names must be valid UTF-8"); }
  if (Buffer.byteLength(name!, "utf8") !== bytes.length) invalid("ZIP entry names must use canonical UTF-8");
  return name!;
}

function validateEntryName(name: string): { directory: boolean } {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    invalid("ZIP contains an unsafe path");
  }
  const directory = name.endsWith("/");
  const parts = name.split("/");
  if (directory) parts.pop();
  if (!parts.length || parts.some(part => !part || part === "." || part === "..")) invalid("ZIP contains an unsafe path");
  return { directory };
}

function validateFilesystemEntryName(name: string): void {
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  for (const component of name.split("/")) {
    if (!component || component.includes(":") || component.endsWith(".") || component.endsWith(" ") || reserved.test(component)) {
      invalid("ZIP contains a path that is unsafe for portable filesystem extraction");
    }
  }
}

function validateExtraFields(data: Buffer, start: number, length: number): void {
  const end = start + length;
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) invalid("ZIP contains malformed extra fields");
    const id = u16(data, cursor);
    const size = u16(data, cursor + 2);
    cursor += 4;
    if (cursor + size > end) invalid("ZIP contains malformed extra fields");
    if (id === 0x0001) invalid("ZIP64 archives are not supported");
    cursor += size;
  }
}

function validateFileType(versionMadeBy: number, externalAttributes: number, directory: boolean): void {
  const platform = versionMadeBy >>> 8;
  if (platform !== 3) return;
  const unixType = (externalAttributes >>> 16) & 0o170000;
  if (unixType === 0o120000) invalid("ZIP archives containing symbolic links are not supported");
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) invalid("ZIP contains a non-regular entry");
  if (directory && unixType !== 0 && unixType !== 0o040000) invalid("ZIP directory type does not match its entry name");
  if (!directory && unixType === 0o040000) invalid("ZIP file type does not match its entry name");
}

interface ParsedCentralEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly directory: boolean;
  readonly flags: number;
  readonly method: number;
  readonly checksum: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/**
 * Validate and expand a bounded ZIP archive entirely before returning bytes.
 * No filesystem or S3 mutation occurs while validation is in progress.
 */
export function readZipEntries(data: Buffer, options: ZipExtractionOptions = {}): ValidatedZipArchive {
  if (!Buffer.isBuffer(data)) throw new TypeError("ZIP input must be a Buffer");
  const maxEntryCount = boundedLimit(options.maxEntryCount, DEFAULT_MAX_ENTRY_COUNT, "maxEntryCount");
  const maxEntrySize = boundedLimit(options.maxEntrySize, DEFAULT_MAX_ENTRY_BYTES, "maxEntrySize");
  const maxUncompressedSize = boundedLimit(options.maxUncompressedSize, DEFAULT_MAX_UNCOMPRESSED_BYTES, "maxUncompressedSize");
  if (data.length < 22) invalid("Archive is not a valid ZIP file");

  let eocd = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - MAX_ZIP_COMMENT_BYTES); offset--) {
    if (u32(data, offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = u16(data, offset + 20);
    if (offset + 22 + commentLength === data.length) { eocd = offset; break; }
  }
  if (eocd < 0) invalid("Archive is not a valid ZIP file");

  const diskNumber = u16(data, eocd + 4);
  const centralDirectoryDisk = u16(data, eocd + 6);
  const entriesOnDisk = u16(data, eocd + 8);
  const entryCount = u16(data, eocd + 10);
  const centralSize = u32(data, eocd + 12);
  const centralOffset = u32(data, eocd + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) invalid("Multi-disk ZIP archives are not supported");
  if (entryCount === ZIP64_SENTINEL_16 || centralSize === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32) invalid("ZIP64 archives are not supported");
  if (entryCount > maxEntryCount) invalid(`ZIP contains more than ${maxEntryCount} entries`);
  if (!Number.isSafeInteger(centralOffset + centralSize) || centralOffset + centralSize !== eocd) invalid("ZIP central directory is malformed");

  let cursor = centralOffset;
  let total = 0;
  const names = new Set<string>();
  const centralEntries: ParsedCentralEntry[] = [];
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || u32(data, cursor) !== CENTRAL_DIRECTORY_ENTRY) invalid("ZIP central directory is malformed");
    const versionMadeBy = u16(data, cursor + 4);
    const flags = u16(data, cursor + 8);
    const method = u16(data, cursor + 10);
    const checksum = u32(data, cursor + 16);
    const compressedSize = u32(data, cursor + 20);
    const uncompressedSize = u32(data, cursor + 24);
    const nameLength = u16(data, cursor + 28);
    const extraLength = u16(data, cursor + 30);
    const commentLength = u16(data, cursor + 32);
    const startingDisk = u16(data, cursor + 34);
    const externalAttributes = u32(data, cursor + 38);
    const localOffset = u32(data, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || startingDisk !== 0) invalid("ZIP central directory is malformed");
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32 || localOffset === ZIP64_SENTINEL_32) invalid("ZIP64 archives are not supported");
    if (flags & ~ALLOWED_GENERAL_PURPOSE_FLAGS || flags & 0x0001) invalid("Encrypted or unsupported ZIP entries are not supported");
    if (method !== 0 && method !== 8) invalid("ZIP uses an unsupported compression method");
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(nameBytes);
    const { directory } = validateEntryName(name);
    if (names.has(name)) invalid("ZIP contains duplicate entry names");
    names.add(name);
    validateFileType(versionMadeBy, externalAttributes, directory);
    validateExtraFields(data, cursor + 46 + nameLength, extraLength);
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) invalid("ZIP directory entries must be empty");
    if (uncompressedSize > maxEntrySize) invalid(`ZIP entry exceeds the ${maxEntrySize} byte per-entry limit`);
    total += uncompressedSize;
    if (!Number.isSafeInteger(total) || total > maxUncompressedSize) invalid(`Unzipped size must be no larger than ${maxUncompressedSize} bytes`);
    centralEntries.push({ name, nameBytes: Buffer.from(nameBytes), directory, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    cursor = end;
  }
  if (cursor !== eocd) invalid("ZIP central directory entry count is inconsistent");

  const occupiedRanges: Array<{ start: number; end: number }> = [];
  const entries: ValidatedZipEntry[] = [];
  for (const entry of centralEntries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || u32(data, offset) !== LOCAL_FILE_HEADER) invalid("ZIP local file header is malformed");
    const localFlags = u16(data, offset + 6);
    const localMethod = u16(data, offset + 8);
    const localChecksum = u32(data, offset + 14);
    const localCompressedSize = u32(data, offset + 18);
    const localUncompressedSize = u32(data, offset + 22);
    const localNameLength = u16(data, offset + 26);
    const localExtraLength = u16(data, offset + 28);
    const headerEnd = offset + 30 + localNameLength + localExtraLength;
    const dataEnd = headerEnd + entry.compressedSize;
    if (headerEnd > centralOffset || dataEnd > centralOffset) invalid("ZIP entry data is truncated or overlaps its central directory");
    if (localFlags !== entry.flags || localMethod !== entry.method) invalid("ZIP local and central headers are inconsistent");
    if (!data.subarray(offset + 30, offset + 30 + localNameLength).equals(entry.nameBytes)) invalid("ZIP local and central entry names are inconsistent");
    validateExtraFields(data, offset + 30 + localNameLength, localExtraLength);
    const hasDescriptor = Boolean(entry.flags & 0x0008);
    if (!hasDescriptor && (localChecksum !== entry.checksum || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize)) invalid("ZIP local and central entry sizes are inconsistent");
    if (hasDescriptor && (localChecksum !== 0 && localChecksum !== entry.checksum || localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize || localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)) invalid("ZIP data descriptor metadata is inconsistent");
    let occupiedEnd = dataEnd;
    if (hasDescriptor) {
      let descriptor = dataEnd;
      if (descriptor + 4 <= centralOffset && u32(data, descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > centralOffset || u32(data, descriptor) !== entry.checksum || u32(data, descriptor + 4) !== entry.compressedSize || u32(data, descriptor + 8) !== entry.uncompressedSize) {
        invalid("ZIP data descriptor is missing or inconsistent");
      }
      occupiedEnd = descriptor + 12;
    }
    occupiedRanges.push({ start: offset, end: occupiedEnd });

    if (entry.directory) continue;
    const compressed = data.subarray(headerEnd, dataEnd);
    let content: Buffer;
    try {
      if (entry.method === 0) content = Buffer.from(compressed);
      else content = inflateRawSync(compressed, { maxOutputLength: Math.min(maxEntrySize, entry.uncompressedSize) });
    } catch { invalid("ZIP contains corrupt compressed data"); }
    if (content!.length !== entry.uncompressedSize || crc32(content!) !== entry.checksum) invalid("ZIP entry checksum or size is invalid");
    entries.push(Object.freeze({ name: entry.name, content: Buffer.from(content!) }));
  }

  occupiedRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < occupiedRanges.length; index++) {
    if (occupiedRanges[index].start < occupiedRanges[index - 1].end) invalid("ZIP entries overlap");
  }
  return Object.freeze({ entries: Object.freeze(entries), uncompressedSize: total, fileCount: entries.length });
}

export async function extractZip(data: Buffer, destination: string, options: ZipExtractionOptions = {}): Promise<ZipExtractionResult> {
  const archive = readZipEntries(data, options);
  for (const entry of archive.entries) validateFilesystemEntryName(entry.name);
  const root = resolve(destination);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  try {
    await mkdir(root, { recursive: true });
    for (const entry of archive.entries) {
      const output = resolve(root, entry.name);
      if (!output.startsWith(rootPrefix)) invalid("ZIP contains an unsafe path");
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, entry.content, { flag: "wx" });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { uncompressedSize: archive.uncompressedSize, fileCount: archive.fileCount };
}
