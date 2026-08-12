import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { AwsError } from "../errors.js";
import type { StateStore } from "../state.js";
import type { S3AccessControlListState } from "../types.js";
import type { S3ChecksumAlgorithm, S3ChecksumValues } from "./checksums.js";
import { S3Checksums, validateProvidedChecksums } from "./checksums.js";

const REQUEST_BODY = Symbol.for("stacksim.request-body");
const REQUEST_BODY_FILE = Symbol.for("stacksim.request-body-file");
const STREAMING_SIGNATURE = Symbol.for("stacksim.sigv4-stream");
// Persisted blob format identifier.
const BLOB_MAGIC = Buffer.from("STACKSIM-S3\0", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface S3ObjectPartState {
  partNumber: number;
  size: number;
  etag: string;
  blobId: string;
  lastModified: number;
  checksums: S3ChecksumValues;
  copySource?: { bucket: string; key: string; versionId: string; range?: string };
}

export interface S3ObjectVersionState {
  versionId: string;
  deleteMarker?: boolean;
  blobId?: string;
  size: number;
  etag: string;
  lastModified: number;
  /** Time this version stopped being current; absent on legacy journal entries. */
  noncurrentSince?: number;
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
  expires?: string;
  websiteRedirectLocation?: string;
  metadata: Record<string, string>;
  tags?: Record<string, string>;
  checksums: S3ChecksumValues;
  checksumAlgorithm?: S3ChecksumAlgorithm;
  checksumType?: "FULL_OBJECT" | "COMPOSITE";
  storageClass: string;
  encryption: "AES256" | "aws:kms" | "aws:kms:dsse";
  kmsKeyId?: string;
  bucketKeyEnabled?: boolean;
  /** Only the digest is retained; the SSE-C key is never persisted. */
  sseCustomerKeyMd5?: string;
  retention?: { mode: "GOVERNANCE" | "COMPLIANCE"; retainUntil: number };
  legalHold?: "ON" | "OFF";
  annotations?: Record<string, { payloadBase64: string; size: number; etag: string; lastModified: number; checksums: S3ChecksumValues; checksumAlgorithm: S3ChecksumAlgorithm }>;
  transitionHistory?: Array<{ at: number; from: string; to: string; ruleId?: string }>;
  restore?: { requestedAt: number; completesAt: number; expiryAt: number; tier: "Expedited" | "Standard" | "Bulk"; completionEventSent?: boolean };
  ownerAccountId?: string;
  ownerId?: string;
  acl?: S3AccessControlListState;
  parts?: S3ObjectPartState[];
}

export interface S3MultipartUploadState {
  uploadId: string;
  key: string;
  initiatedAt: number;
  metadata: Record<string, string>;
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
  expires?: string;
  websiteRedirectLocation?: string;
  tags?: Record<string, string>;
  storageClass: string;
  checksumAlgorithm?: S3ChecksumAlgorithm;
  checksumType?: "FULL_OBJECT" | "COMPOSITE";
  ownerAccountId?: string;
  ownerId?: string;
  acl?: S3AccessControlListState;
  encryption?: "AES256" | "aws:kms" | "aws:kms:dsse";
  kmsKeyId?: string;
  bucketKeyEnabled?: boolean;
  sseCustomerKeyMd5?: string;
  retention?: { mode: "GOVERNANCE" | "COMPLIANCE"; retainUntil: number };
  legalHold?: "ON" | "OFF";
  parts: Record<string, S3ObjectPartState>;
}

export interface S3BucketIndex {
  schemaVersion: 1;
  objects: Record<string, S3ObjectVersionState[]>;
  multipartUploads: Record<string, S3MultipartUploadState>;
  /**
   * Immutable generations retained for admitted cross-service reads. The
   * opaque key is owned by S3; consumers never receive blob identifiers.
   */
  transferPins?: Record<string, { key: string; sourceArn: string; object: S3ObjectVersionState }>;
  notificationDeliveries?: Record<string, {
    id: string;
    destinationType: "lambda" | "queue" | "eventbridge";
    destinationArn?: string;
    configurationId: string;
    payload: string;
    eventName: string;
    enqueuedAt: number;
    nextAttemptAt: number;
    attempts: number;
    leaseId?: string;
    leaseUntil?: number;
    lineage: string[];
  }>;
  notificationDiagnostics?: Array<{ at: number; deliveryId: string; destination: string; eventName: string; status: "SUCCESS" | "FAILED" | "EXPIRED"; attempts: number; error?: string }>;
}

export interface StagedS3Object {
  file: string;
  size: number;
  digest: Awaited<ReturnType<S3Checksums["digest"]>>;
  trailers: Record<string, string>;
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => stream.write(chunk, error => error ? reject(error) : resolve()));
}

async function finish(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  stream.end(); await once(stream, "close");
}

async function* rawRequest(req: IncomingMessage): AsyncGenerator<Buffer> {
  const cached = (req as any)[REQUEST_BODY] as Buffer | undefined;
  if (cached) { if (cached.length) yield cached; return; }
  const staged = (req as any)[REQUEST_BODY_FILE] as { file: string } | undefined;
  if (staged) { try { for await (const chunk of createReadStream(staged.file)) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); } finally { try { await unlink(staged.file); } catch {} delete (req as any)[REQUEST_BODY_FILE]; } return; }
  for await (const chunk of req) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

async function* awsChunkedRequest(req: IncomingMessage, trailers: Record<string, string>): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0); let chunkSize: number | undefined; let terminal = false; let chunkSignature: string | undefined; const signature = (req as any)[STREAMING_SIGNATURE] as { amzDate: string; scope: string; previous: string; signingKey: string; trailer?: boolean } | undefined;
  const verifyTrailerSignature = () => {
    if (!signature?.trailer) return;
    const trailerSignature = trailers["x-amz-trailer-signature"];
    if (!trailerSignature || !/^[0-9a-f]{64}$/i.test(trailerSignature)) throw new AwsError("SignatureDoesNotMatch", "A signed streaming request is missing its trailer signature", 403);
    const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
    const canonical = Object.entries(trailers).filter(([name]) => name !== "x-amz-trailer-signature").map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, " ")}\n`).join("");
    const stringToSign = `AWS4-HMAC-SHA256-TRAILER\n${signature.amzDate}\n${signature.scope}\n${signature.previous}\n${hash(canonical)}`;
    const expected = createHmac("sha256", Buffer.from(signature.signingKey, "base64")).update(stringToSign).digest("hex");
    if (expected !== trailerSignature.toLowerCase()) throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the streaming trailer signature you provided", 403);
    delete trailers["x-amz-trailer-signature"];
  };
  for await (const incoming of rawRequest(req)) {
    pending = pending.length ? Buffer.concat([pending, incoming]) : Buffer.from(incoming);
    while (true) {
      if (terminal) {
        if (pending.length >= 2 && pending.subarray(0, 2).equals(Buffer.from("\r\n"))) { pending = pending.subarray(2); verifyTrailerSignature(); return; }
        const trailerEnd = pending.indexOf("\r\n\r\n"); if (trailerEnd < 0) break;
        for (const line of pending.subarray(0, trailerEnd).toString("utf8").split("\r\n")) { const separator = line.indexOf(":"); if (separator > 0) trailers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim(); }
        pending = pending.subarray(trailerEnd + 4); verifyTrailerSignature(); return;
      }
      if (chunkSize === undefined) {
        const lineEnd = pending.indexOf("\r\n"); if (lineEnd < 0) break;
        const header = pending.subarray(0, lineEnd).toString("ascii"); const [sizeText, ...extensions] = header.split(";"); chunkSignature = extensions.map(value => value.split("=", 2)).find(([name]) => name.toLowerCase() === "chunk-signature")?.[1];
        if (!/^[0-9a-f]+$/i.test(sizeText)) throw new AwsError("InvalidRequest", "Malformed aws-chunked request body", 400);
        chunkSize = Number.parseInt(sizeText, 16); pending = pending.subarray(lineEnd + 2);
        if (chunkSize === 0) { if (signature) { if (!chunkSignature || !/^[0-9a-f]{64}$/i.test(chunkSignature)) throw new AwsError("SignatureDoesNotMatch", "A signed streaming chunk is missing its chunk signature", 403); const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex"); const stringToSign = `AWS4-HMAC-SHA256-PAYLOAD\n${signature.amzDate}\n${signature.scope}\n${signature.previous}\n${hash("")}\n${hash("")}`; const expected = createHmac("sha256", Buffer.from(signature.signingKey, "base64")).update(stringToSign).digest("hex"); if (expected !== chunkSignature.toLowerCase()) throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the streaming chunk signature you provided", 403); signature.previous = chunkSignature.toLowerCase(); } terminal = true; chunkSize = undefined; chunkSignature = undefined; continue; }
      }
      if (pending.length < chunkSize + 2) break;
      const data = pending.subarray(0, chunkSize); if (!pending.subarray(chunkSize, chunkSize + 2).equals(Buffer.from("\r\n"))) throw new AwsError("InvalidRequest", "Malformed aws-chunked request body", 400);
      if (signature) { if (!chunkSignature || !/^[0-9a-f]{64}$/i.test(chunkSignature)) throw new AwsError("SignatureDoesNotMatch", "A signed streaming chunk is missing its chunk signature", 403); const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex"); const stringToSign = `AWS4-HMAC-SHA256-PAYLOAD\n${signature.amzDate}\n${signature.scope}\n${signature.previous}\n${hash("")}\n${hash(data)}`; const expected = createHmac("sha256", Buffer.from(signature.signingKey, "base64")).update(stringToSign).digest("hex"); if (expected !== chunkSignature.toLowerCase()) throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the streaming chunk signature you provided", 403); signature.previous = chunkSignature.toLowerCase(); }
      pending = pending.subarray(chunkSize + 2); chunkSize = undefined; chunkSignature = undefined; yield data;
    }
  }
  if (!terminal) throw new AwsError("IncompleteBody", "The request body terminated before the declared data was received.", 400);
  if (pending.length) {
    if (pending.equals(Buffer.from("\r\n"))) { verifyTrailerSignature(); return; }
    const text = pending.toString("utf8");
    for (const line of text.split("\r\n")) { const separator = line.indexOf(":"); if (separator > 0) trailers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim(); }
  }
  verifyTrailerSignature();
}

const initializationByStore = new WeakMap<StateStore, Promise<void>>();

export class S3Storage {
  readonly root: string;
  readonly blobsRoot: string;
  readonly bucketsRoot: string;
  readonly stagingRoot: string;

  constructor(private readonly store: StateStore) {
    this.root = resolve(store.root, "s3"); this.blobsRoot = resolve(this.root, "blobs"); this.bucketsRoot = resolve(this.root, "buckets"); this.stagingRoot = resolve(this.root, "staging");
  }

  initialize(): Promise<void> {
    const existing = initializationByStore.get(this.store); if (existing) return existing;
    const initialization = this.initializeAtRest(); initializationByStore.set(this.store, initialization); return initialization;
  }

  private async initializeAtRest(): Promise<void> {
    await Promise.all([mkdir(this.blobsRoot, { recursive: true }), mkdir(this.bucketsRoot, { recursive: true }), mkdir(this.stagingRoot, { recursive: true })]);
    await this.cleanStaging(); await this.garbageCollectAtRest();
  }

  private async filesBelow(root: string): Promise<string[]> {
    const output: string[] = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = resolve(root, entry.name); if (entry.isDirectory()) output.push(...await this.filesBelow(path)); else if (entry.isFile()) output.push(path); } return output;
  }

  private async cleanStaging(): Promise<void> { for (const file of await this.filesBelow(this.stagingRoot)) try { await unlink(file); } catch {} }

  private async garbageCollectAtRest(): Promise<void> {
    const reachable = new Set<string>();
    for (const file of await this.filesBelow(this.bucketsRoot)) {
      if (!file.endsWith(".json")) continue;
      try { const index = JSON.parse(await readFile(file, "utf8")) as S3BucketIndex; for (const versions of Object.values(index.objects ?? {})) for (const version of versions) if (version.blobId) reachable.add(version.blobId); for (const upload of Object.values(index.multipartUploads ?? {})) for (const part of Object.values(upload.parts ?? {})) if (part.blobId) reachable.add(part.blobId); for (const pin of Object.values(index.transferPins ?? {})) if (pin.object.blobId) reachable.add(pin.object.blobId); } catch { /* A corrupt index must fail when its bucket is accessed; GC stays conservative here. */ return; }
    }
    for (const file of await this.filesBelow(this.blobsRoot)) {
      // Blob IDs are split across one directory level. Normalize both path
      // separators: Windows paths otherwise retain "\\", fail the digest
      // check, and make startup garbage collection delete live objects.
      const relative = file.slice(this.blobsRoot.length + 1).replace(/[\\/]/g, "");
      if (!/^[a-f0-9]{64}$/.test(relative) || !reachable.has(relative)) try { await unlink(file); } catch {}
    }
  }

  bucketIndexFile(accountId: string, region: string, bucket: string): string {
    const name = createHash("sha256").update(`${accountId}\0${region}\0${bucket}`).digest("hex");
    return resolve(this.bucketsRoot, accountId, region, `${name}.json`);
  }

  bucketJournalFile(accountId: string, region: string, bucket: string): string { return this.bucketIndexFile(accountId, region, bucket).replace(/\.json$/, ".journal"); }

  async loadBucket(accountId: string, region: string, bucket: string): Promise<S3BucketIndex> {
    try {
      const records = (await readFile(this.bucketJournalFile(accountId, region, bucket), "utf8")).trimEnd().split("\n");
      for (let index = records.length - 1; index >= 0; index--) { try { const parsed = JSON.parse(records[index]) as S3BucketIndex; if (parsed.schemaVersion === 1 && parsed.objects && parsed.multipartUploads) return parsed; } catch {} }
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    try {
      const parsed = JSON.parse(await readFile(this.bucketIndexFile(accountId, region, bucket), "utf8"));
      if (parsed.schemaVersion !== 1 || !parsed.objects || !parsed.multipartUploads) throw new Error("Unsupported S3 bucket index schema");
      return parsed;
    } catch (error: any) { if (error.code !== "ENOENT") throw error; return { schemaVersion: 1, objects: {}, multipartUploads: {} }; }
  }

  async saveBucket(accountId: string, region: string, bucket: string, index: S3BucketIndex): Promise<void> {
    const file = this.bucketIndexFile(accountId, region, bucket); await mkdir(dirname(file), { recursive: true });
    const serialized = JSON.stringify(index); await appendFile(this.bucketJournalFile(accountId, region, bucket), `${serialized}\n`, { mode: 0o600 }); const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, file);
  }

  async deleteBucket(accountId: string, region: string, bucket: string): Promise<void> {
    for (const file of [this.bucketIndexFile(accountId, region, bucket), this.bucketJournalFile(accountId, region, bucket)]) try { await unlink(file); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }

  async stageRequest(req: IncomingMessage, maximumBytes: number): Promise<StagedS3Object> {
    await mkdir(this.stagingRoot, { recursive: true }); const file = resolve(this.stagingRoot, `${randomUUID()}.plain`); const output = createWriteStream(file, { mode: 0o600, flags: "wx" }); const checksums = new S3Checksums(); const trailers: Record<string, string> = {};
    const decodedLength = req.headers["x-amz-decoded-content-length"] === undefined ? undefined : Number(req.headers["x-amz-decoded-content-length"]);
    const source = String(req.headers["content-encoding"] ?? "").toLowerCase().split(",").map(value => value.trim()).includes("aws-chunked") ? awsChunkedRequest(req, trailers) : rawRequest(req);
    try {
      for await (const chunk of source) { await checksums.update(chunk); if (checksums.size > maximumBytes) throw new AwsError("EntityTooLarge", "Your proposed upload exceeds the maximum allowed object size.", 400); await writeChunk(output, chunk); }
      await finish(output); const digest = await checksums.digest();
      if (Number.isFinite(decodedLength) && decodedLength !== checksums.size) throw new AwsError("IncompleteBody", `You did not provide the number of bytes specified by x-amz-decoded-content-length.`, 400);
      validateProvidedChecksums(req.headers, trailers, digest); return { file, size: checksums.size, digest, trailers };
    } catch (error) { output.destroy(); try { await unlink(file); } catch {} throw error; }
  }

  async stageFromBlobs(blobIds: string[], maximumBytes: number): Promise<StagedS3Object> {
    const self = this;
    async function* source(): AsyncGenerator<Buffer> { for (const blobId of blobIds) yield* self.readBlob(blobId); }
    return this.stageIterable(source(), maximumBytes);
  }

  async stageIterable(source: AsyncIterable<Uint8Array>, maximumBytes: number): Promise<StagedS3Object> {
    await mkdir(this.stagingRoot, { recursive: true }); const file = resolve(this.stagingRoot, `${randomUUID()}.plain`); const output = createWriteStream(file, { mode: 0o600, flags: "wx" }); const checksums = new S3Checksums();
    try {
      for await (const chunk of source) { await checksums.update(chunk); if (checksums.size > maximumBytes) throw new AwsError("EntityTooLarge", "Your proposed upload exceeds the maximum allowed object size.", 400); await writeChunk(output, chunk); }
      await finish(output); return { file, size: checksums.size, digest: await checksums.digest(), trailers: {} };
    } catch (error) { output.destroy(); try { await unlink(file); } catch {} throw error; }
  }

  private blobPath(blobId: string): string { return resolve(this.blobsRoot, blobId.slice(0, 2), blobId.slice(2)); }

  async publish(staged: StagedS3Object): Promise<string> {
    const blobId = staged.digest.sha256Hex; const target = this.blobPath(blobId);
    if (await exists(target)) { await unlink(staged.file); return blobId; }
    await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; const output = createWriteStream(temporary, { mode: 0o600, flags: "wx" });
    const key = Buffer.from(this.store.state.installation.s3EncryptionKey, "base64"); const iv = randomBytes(IV_LENGTH); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(blobId));
    try {
      await writeChunk(output, BLOB_MAGIC); await writeChunk(output, iv); createReadStream(staged.file).pipe(cipher);
      for await (const chunk of cipher) await writeChunk(output, chunk as Buffer);
      await writeChunk(output, cipher.getAuthTag()); await finish(output); await rename(temporary, target); await unlink(staged.file); return blobId;
    } catch (error) { output.destroy(); try { await unlink(temporary); } catch {} try { await unlink(staged.file); } catch {} throw error; }
  }

  async *readBlob(blobId: string): AsyncGenerator<Buffer> {
    const path = this.blobPath(blobId); const details = await stat(path); const ciphertextStart = BLOB_MAGIC.length + IV_LENGTH; const ciphertextEnd = details.size - TAG_LENGTH - 1;
    if (ciphertextEnd < ciphertextStart - 1) throw new Error(`Corrupt S3 blob ${blobId}`);
    const descriptor = await open(path, "r"); const prefix = Buffer.alloc(BLOB_MAGIC.length + IV_LENGTH); const tag = Buffer.alloc(TAG_LENGTH);
    try { await descriptor.read(prefix, 0, prefix.length, 0); await descriptor.read(tag, 0, tag.length, details.size - TAG_LENGTH); } finally { await descriptor.close(); }
    if (!prefix.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) throw new Error(`Corrupt S3 blob ${blobId}`);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.store.state.installation.s3EncryptionKey, "base64"), prefix.subarray(BLOB_MAGIC.length)); decipher.setAAD(Buffer.from(blobId)); decipher.setAuthTag(tag);
    if (ciphertextEnd >= ciphertextStart) createReadStream(path, { start: ciphertextStart, end: ciphertextEnd }).pipe(decipher); else decipher.end();
    for await (const chunk of decipher as Readable) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  async discardStaged(staged: StagedS3Object): Promise<void> { try { await unlink(staged.file); } catch {} }
}
