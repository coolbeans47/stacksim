import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip, gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsError } from "../errors.js";
import type { S3TransferPort, S3TransferCaller, S3PinnedObject } from "../s3/transfer-port.js";
import { DYNAMODB_S3_SERVICE_PRINCIPAL } from "../s3/transfer-port.js";
import type {
  DynamoExportState,
  DynamoImportState,
  DynamoPinnedS3ObjectState,
  Item,
  TableState,
} from "../types.js";
import { clone, stableItemKey, validateItem } from "./values.js";

const DATA_FILE_PATTERN = /\.(?:json|jsonl)(?:\.gz)?$/i;

export function isFileBucket(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("file://");
}

export function transferCaller(sourceAccount: string, sourceArn: string, expectedBucketOwner?: string): S3TransferCaller {
  return {
    servicePrincipal: DYNAMODB_S3_SERVICE_PRINCIPAL,
    sourceAccount,
    sourceArn,
    ...(expectedBucketOwner ? { expectedBucketOwner } : {}),
  };
}

export function localBucketRoot(value: unknown, allowLocalFiles: boolean): string {
  if (!allowLocalFiles) {
    throw new AwsError("ValidationException", "Local file:// DynamoDB import/export requires STACKSIM_ALLOW_LOCAL_FILES=true");
  }
  if (typeof value !== "string" || !value.startsWith("file://")) {
    throw new AwsError("ValidationException", "S3Bucket must be a valid absolute file:// location when using the local file extension");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") throw new Error();
    return resolve(fileURLToPath(url));
  } catch {
    throw new AwsError("ValidationException", "S3Bucket must be a valid absolute file:// location");
  }
}

export function localObjectPath(bucket: unknown, prefix: unknown, allowLocalFiles: boolean): string {
  const root = localBucketRoot(bucket, allowLocalFiles);
  const value = prefix === undefined ? "" : String(prefix);
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.split("/").some(segment => segment === "..")) {
    throw new AwsError("ValidationException", "Local S3 prefixes must be relative and cannot traverse outside the file:// bucket");
  }
  const target = resolve(root, value);
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith("..") || fromRoot.startsWith("/")) {
    throw new AwsError("ValidationException", "Local S3 prefix escapes the file:// bucket");
  }
  return target;
}

export function exportKeyPrefix(prefix: string | undefined, exportId: string): string {
  return [String(prefix ?? "").replace(/^\/+|\/+$/g, ""), "AWSDynamoDB", exportId].filter(Boolean).join("/");
}

export function pinState(pin: S3PinnedObject, completed = false): DynamoPinnedS3ObjectState {
  return {
    bucket: pin.bucket,
    key: pin.key,
    generation: pin.generation,
    versionId: pin.versionId,
    etag: pin.etag,
    size: pin.size,
    storageClass: pin.storageClass,
    ...(completed ? { completed: true } : {}),
  };
}

export async function listLocalImportFiles(path: string): Promise<string[]> {
  let info;
  try { info = await stat(path); } catch { throw new AwsError("ValidationException", "The local import source does not exist"); }
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new AwsError("ValidationException", "The local import source must be a file or directory");
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && !entry.name.startsWith("manifest-") && !entry.name.endsWith(".checksum") && entry.name !== "_started" && DATA_FILE_PATTERN.test(entry.name)) {
        result.push(child);
      }
    }
  };
  await visit(path);
  result.sort();
  if (!result.length) throw new AwsError("ValidationException", "No DynamoDB JSON data files were found under the local import prefix");
  return result;
}

export function decodeImportLines(raw: Buffer, compression: "NONE" | "GZIP", label: string): Item[] {
  let decoded: Buffer;
  try { decoded = compression === "GZIP" ? gunzipSync(raw) : raw; }
  catch { throw new AwsError("ValidationException", `Unable to decompress import data file ${label}`); }
  const imported: Item[] = [];
  for (const [index, line] of decoded.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: any;
    try { value = JSON.parse(line); }
    catch { throw new AwsError("ValidationException", `Invalid DynamoDB JSON at ${label}:${index + 1}`); }
    if (!value?.Item || typeof value.Item !== "object" || Array.isArray(value.Item)) {
      throw new AwsError("ValidationException", `DynamoDB JSON lines must contain an Item object (${label}:${index + 1})`);
    }
    imported.push(value.Item);
  }
  return imported;
}

export function mapTransferFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AwsError) {
    if (error.code === "AccessDenied") return { code: "S3AccessDenied", message: error.message };
    if (error.code === "NoSuchBucket") return { code: "S3NoSuchBucket", message: error.message };
    if (error.code === "NoSuchKey") return { code: "S3NoSuchKey", message: error.message };
    if (error.code === "PermanentRedirect") return { code: "S3WrongRegion", message: error.message };
    if (error.code === "InvalidObjectState") return { code: "S3InvalidObjectState", message: error.message };
    if (error.code === "PreconditionFailed") return { code: "S3ObjectConflict", message: error.message };
    if (error.code === "EntityTooLarge") return { code: "S3EntityTooLarge", message: error.message };
    return { code: error.code, message: error.message };
  }
  return { code: "InternalFailure", message: error instanceof Error ? error.message : String(error) };
}

export async function writeLocalExportArtifacts(input: {
  root: string;
  keyPrefix: string;
  dataKey: string;
  exportArn: string;
  tableArn: string;
  tableId: string;
  exportTime: number;
  startTime: number;
  s3Bucket: string;
  s3Prefix: string;
  compressed: AsyncIterable<Uint8Array>;
  md5Base64: string;
  itemCount: number;
  billedSizeBytes: number;
}): Promise<void> {
  const directory = resolve(input.root, input.keyPrefix);
  const dataPath = resolve(input.root, input.dataKey);
  await mkdir(dirname(dataPath), { recursive: true, mode: 0o700 });
  await pipeline(Readable.from(input.compressed), createWriteStream(dataPath, { mode: 0o600 }));
  const manifestFilesKey = `${input.keyPrefix}/manifest-files.json`;
  const manifestFiles = `${JSON.stringify({
    itemCount: input.itemCount,
    md5Checksum: input.md5Base64,
    etag: Buffer.from(input.md5Base64, "base64").toString("hex"),
    dataFileS3Key: input.dataKey,
  })}\n`;
  const summary = JSON.stringify({
    version: "2020-06-30",
    exportArn: input.exportArn,
    startTime: new Date(input.startTime).toISOString(),
    endTime: new Date(input.startTime + 50).toISOString(),
    tableArn: input.tableArn,
    tableId: input.tableId,
    exportTime: new Date(input.exportTime).toISOString(),
    s3Bucket: input.s3Bucket,
    s3Prefix: input.s3Prefix,
    s3SseAlgorithm: "AES256",
    s3SseKmsKeyId: null,
    manifestFilesS3Key: manifestFilesKey,
    billedSizeBytes: input.billedSizeBytes,
    itemCount: input.itemCount,
    outputFormat: "DYNAMODB_JSON",
  }, null, 2);
  await writeFile(resolve(directory, "manifest-files.json"), manifestFiles, { mode: 0o600 });
  await writeFile(resolve(directory, "manifest-files.checksum"), createHash("md5").update(manifestFiles).digest("hex"), { mode: 0o600 });
  await writeFile(resolve(directory, "manifest-summary.json"), summary, { mode: 0o600 });
  await writeFile(resolve(directory, "manifest-summary.checksum"), createHash("md5").update(summary).digest("hex"), { mode: 0o600 });
}

export async function writeS3ExportDataObject(input: {
  port: S3TransferPort;
  caller: S3TransferCaller;
  job: DynamoExportState;
  compressed: AsyncIterable<Uint8Array>;
}): Promise<S3PinnedObject> {
  if (input.job.dataObject?.completed) {
    return {
      bucket: input.job.dataObject.bucket,
      key: input.job.dataObject.key,
      generation: input.job.dataObject.generation,
      versionId: input.job.dataObject.versionId,
      etag: input.job.dataObject.etag,
      size: input.job.dataObject.size,
      storageClass: input.job.dataObject.storageClass,
    };
  }
  return input.port.writeObject(input.job.s3Bucket, input.job.dataKey!, input.compressed, input.caller, {
    contentType: "application/x-gzip",
    contentEncoding: "gzip",
    failIfExists: true,
  });
}

export async function writeS3ExportManifests(input: {
  port: S3TransferPort;
  caller: S3TransferCaller;
  job: DynamoExportState;
  data: S3PinnedObject;
}): Promise<string> {
  const keyPrefix = input.job.keyPrefix!;
  const manifestFilesKey = `${keyPrefix}/manifest-files.json`;
  const manifestFiles = `${JSON.stringify({
    itemCount: input.job.itemCount,
    md5Checksum: input.job.snapshotMd5,
    etag: input.data.etag,
    dataFileS3Key: input.job.dataKey!,
  })}\n`;
  await input.port.writeObject(input.job.s3Bucket, manifestFilesKey, oneChunk(manifestFiles), input.caller, {
    contentType: "application/json",
    failIfExists: true,
  });
  await input.port.writeObject(input.job.s3Bucket, `${keyPrefix}/manifest-files.checksum`, oneChunk(createHash("md5").update(manifestFiles).digest("hex")), input.caller, {
    contentType: "text/plain",
    failIfExists: true,
  });
  const summary = JSON.stringify({
    version: "2020-06-30",
    exportArn: input.job.exportArn,
    startTime: new Date(input.job.startTime).toISOString(),
    endTime: new Date(input.job.startTime + 50).toISOString(),
    tableArn: input.job.tableArn,
    tableId: input.job.tableId,
    exportTime: new Date(input.job.exportTime).toISOString(),
    s3Bucket: input.job.s3Bucket,
    s3Prefix: input.job.s3Prefix ?? "",
    s3SseAlgorithm: "AES256",
    s3SseKmsKeyId: null,
    manifestFilesS3Key: manifestFilesKey,
    billedSizeBytes: input.job.billedSizeBytes,
    itemCount: input.job.itemCount,
    outputFormat: "DYNAMODB_JSON",
  }, null, 2);
  await input.port.writeObject(input.job.s3Bucket, `${keyPrefix}/manifest-summary.json`, oneChunk(summary), input.caller, {
    contentType: "application/json",
    failIfExists: true,
  });
  await input.port.writeObject(input.job.s3Bucket, `${keyPrefix}/manifest-summary.checksum`, oneChunk(createHash("md5").update(summary).digest("hex")), input.caller, {
    contentType: "text/plain",
    failIfExists: true,
  });
  return manifestFilesKey;
}

export function validateImportedItems(table: TableState, imported: Item[], validateIndexes: (table: TableState, item: Item) => void): Record<string, Item> {
  const items: Record<string, Item> = {};
  for (const item of imported) {
    validateItem(table, item);
    validateIndexes(table, item);
    items[stableItemKey(table, item)] = clone(item);
  }
  return items;
}

export function selectImportDataPins(pins: DynamoPinnedS3ObjectState[]): DynamoPinnedS3ObjectState[] {
  return pins
    .filter(pin => DATA_FILE_PATTERN.test(pin.key) && !/(^|\/)manifest-/i.test(pin.key) && !pin.key.endsWith(".checksum") && !pin.key.endsWith("/_started"))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function oneChunk(value: string | Uint8Array): AsyncIterable<Uint8Array> {
  const chunk = typeof value === "string" ? Buffer.from(value) : value;
  return (async function* () { yield chunk; })();
}

function transferPin(pin: DynamoPinnedS3ObjectState): S3PinnedObject {
  return { bucket: pin.bucket, key: pin.key, generation: pin.generation, versionId: pin.versionId, etag: pin.etag, size: pin.size, storageClass: pin.storageClass };
}

async function collectPinned(port: S3TransferPort, caller: S3TransferCaller, pin: DynamoPinnedS3ObjectState, maximumBytes = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of port.readPinned(transferPin(pin), caller, maximumBytes)) { size += chunk.byteLength; chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks, size);
}

/** Validate AWS export manifests when present and return only their admitted data objects. */
export async function admitImportManifest(port: S3TransferPort, caller: S3TransferCaller, pins: DynamoPinnedS3ObjectState[]): Promise<DynamoPinnedS3ObjectState[]> {
  const summary = pins.find(pin => pin.key.endsWith("/manifest-summary.json"));
  const files = pins.find(pin => pin.key.endsWith("/manifest-files.json"));
  if (!summary && !files) return selectImportDataPins(pins);
  const summaryChecksum = pins.find(pin => pin.key === summary?.key.replace(/\.json$/, ".checksum"));
  const filesChecksum = pins.find(pin => pin.key === files?.key.replace(/\.json$/, ".checksum"));
  if (!summary || !files || !summaryChecksum || !filesChecksum) throw new AwsError("ValidationException", "The DynamoDB export manifest set is incomplete");
  const [summaryBody, filesBody, summaryDigest, filesDigest] = await Promise.all([
    collectPinned(port, caller, summary), collectPinned(port, caller, files), collectPinned(port, caller, summaryChecksum, 1024), collectPinned(port, caller, filesChecksum, 1024),
  ]);
  if (createHash("md5").update(summaryBody).digest("hex") !== summaryDigest.toString("utf8").trim().toLowerCase()) throw new AwsError("ValidationException", "The DynamoDB export summary checksum does not match");
  if (createHash("md5").update(filesBody).digest("hex") !== filesDigest.toString("utf8").trim().toLowerCase()) throw new AwsError("ValidationException", "The DynamoDB export files checksum does not match");
  let parsedSummary: any;
  try { parsedSummary = JSON.parse(summaryBody.toString("utf8")); } catch { throw new AwsError("ValidationException", "The DynamoDB export summary manifest is invalid JSON"); }
  if (parsedSummary.outputFormat !== "DYNAMODB_JSON" || parsedSummary.manifestFilesS3Key !== files.key) throw new AwsError("ValidationException", "The DynamoDB export summary manifest is inconsistent");
  const admitted: DynamoPinnedS3ObjectState[] = [];
  for (const [lineNumber, line] of filesBody.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { throw new AwsError("ValidationException", `The DynamoDB files manifest is invalid at line ${lineNumber + 1}`); }
    const pin = pins.find(candidate => candidate.key === entry.dataFileS3Key);
    if (!pin || typeof entry.md5Checksum !== "string" || typeof entry.itemCount !== "number") throw new AwsError("ValidationException", `The DynamoDB files manifest entry ${lineNumber + 1} is incomplete`);
    if (entry.etag !== pin.etag) throw new AwsError("ValidationException", `The DynamoDB data object ETag does not match its manifest: ${pin.key}`);
    admitted.push({ ...pin, checksumMd5: entry.md5Checksum, manifestItemCount: entry.itemCount });
  }
  if (!admitted.length) throw new AwsError("ValidationException", "The DynamoDB files manifest contains no data objects");
  return admitted.sort((left, right) => left.key.localeCompare(right.key));
}

export async function* streamPinnedImportItems(port: S3TransferPort, caller: S3TransferCaller, pin: DynamoPinnedS3ObjectState, compression: "NONE" | "GZIP"): AsyncGenerator<Item> {
  const digest = createHash("md5");
  const source = (async function* () { for await (const chunk of port.readPinned(transferPin(pin), caller)) { digest.update(chunk); yield chunk; } })();
  const input = Readable.from(source);
  const decoded = compression === "GZIP" ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let value: any;
      try { value = JSON.parse(line); } catch { throw new AwsError("ValidationException", `Invalid DynamoDB JSON at s3://${pin.bucket}/${pin.key}:${lineNumber}`); }
      if (!value?.Item || typeof value.Item !== "object" || Array.isArray(value.Item)) throw new AwsError("ValidationException", `DynamoDB JSON lines must contain an Item object (s3://${pin.bucket}/${pin.key}:${lineNumber})`);
      yield value.Item;
    }
  } catch (error) {
    if (error instanceof AwsError) throw error;
    throw new AwsError("ValidationException", `Unable to decompress import data file s3://${pin.bucket}/${pin.key}`);
  }
  if (pin.checksumMd5 && digest.digest("base64") !== pin.checksumMd5) throw new AwsError("ValidationException", `The DynamoDB data object checksum does not match its manifest: ${pin.key}`);
}
