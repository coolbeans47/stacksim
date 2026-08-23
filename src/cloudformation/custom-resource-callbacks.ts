import { createHash, createHmac, createPrivateKey, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Clock } from "../core/clock.js";
import { createLoopbackServerCertificate } from "../core/x509.js";
import type { StateStore } from "../state.js";
import { CloudFormationJournal } from "./journal.js";

const CALLBACK_PATH = "/_stacksim/cloudformation/custom-resource-response/";
const CALLBACK_COLLECTION = "custom-resource-callbacks";
const MAX_CALLBACK_BYTES = 64 * 1024;

function errno(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    // Windows and some file-system drivers cannot open or fsync directories.
    // The individual PKI files are still fsynced before they are renamed.
    if (!new Set(["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"]).has(errno(error) ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replacePkiBundle(directory: string, files: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const staged: Array<{ target: string; temporary: string }> = [];
  try {
    // Stage and fsync the complete generation before replacing any live file.
    // If replacement is interrupted, initializePki's chain and key checks make
    // every mixed old/new generation invalid and therefore self-repairing.
    for (const [target, contents] of files) {
      const temporary = resolve(directory, `.${randomUUID()}.tmp`);
      staged.push({ target, temporary });
      let handle: FileHandle | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    for (const { target, temporary } of staged) {
      await rename(temporary, target);
      await syncDirectory(directory);
    }
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true }).catch(() => undefined)));
    throw error;
  }
}

export type CustomResourceRequestType = "Create" | "Update" | "Delete";

export interface CustomResourceCallbackResponse {
  readonly Status: "SUCCESS" | "FAILED";
  readonly Reason?: string;
  readonly PhysicalResourceId: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  readonly NoEcho: boolean;
  readonly Data: Readonly<Record<string, unknown>>;
}

export interface CustomResourceCallbackRecord {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: string;
  readonly requestType: CustomResourceRequestType;
  /** Parent CloudFormation stack operation. Optional only for pre-CFN-14 records. */
  readonly operationId?: string;
  readonly resourceOperationId: string;
  readonly stackId: string;
  readonly logicalId: string;
  readonly serviceToken: string;
  readonly expiresAt: number;
  readonly tokenDigest: string;
  readonly createdAt: number;
  readonly invocationStatus: "INTENT" | "INVOKED" | "COMPLETED" | "INVOCATION_FAILED";
  readonly invokedAt?: number;
  readonly invocationFailure?: string;
  readonly consumedAt?: number;
  readonly response?: CustomResourceCallbackResponse;
}

export interface CustomResourceCallbackIntent {
  readonly region: string;
  readonly resourceType: string;
  readonly requestType: CustomResourceRequestType;
  readonly operationId?: string;
  readonly resourceOperationId: string;
  readonly stackId: string;
  readonly logicalId: string;
  readonly serviceToken: string;
  readonly expiresAt: number;
}

export interface CustomResourceCompletionWatch {
  readonly completed: Promise<void>;
  cancel(): void;
}

interface TokenPayload { readonly r: string; readonly o: string; readonly e: number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ message }));
}

async function boundedBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_BYTES) throw Object.assign(new Error("Callback body exceeds 64 KiB"), { status: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CALLBACK_BYTES) throw Object.assign(new Error("Callback body exceeds 64 KiB"), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function canonicalResponse(value: unknown, expected: CustomResourceCallbackRecord): CustomResourceCallbackResponse {
  if (!record(value)) throw new TypeError("Callback body must be a JSON object");
  const allowed = new Set(["Status", "Reason", "PhysicalResourceId", "StackId", "RequestId", "LogicalResourceId", "NoEcho", "Data"]);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new TypeError(`Callback contains unsupported field ${unknown}`);
  if (value.Status !== "SUCCESS" && value.Status !== "FAILED") throw new TypeError("Status must be SUCCESS or FAILED");
  if (typeof value.PhysicalResourceId !== "string" || !value.PhysicalResourceId || value.PhysicalResourceId.length > 1024) throw new TypeError("PhysicalResourceId must contain 1-1024 characters");
  if (value.StackId !== expected.stackId || value.RequestId !== expected.resourceOperationId || value.LogicalResourceId !== expected.logicalId) throw new TypeError("Callback operation binding does not match the issued response URL");
  if (value.Reason !== undefined && (typeof value.Reason !== "string" || value.Reason.length > 4096)) throw new TypeError("Reason must be a string of at most 4096 characters");
  if (value.NoEcho !== undefined && typeof value.NoEcho !== "boolean") throw new TypeError("NoEcho must be a boolean");
  if (value.Data !== undefined && !record(value.Data)) throw new TypeError("Data must be a JSON object");
  return {
    Status: value.Status,
    ...(value.Reason === undefined ? {} : { Reason: value.Reason }),
    PhysicalResourceId: value.PhysicalResourceId,
    StackId: expected.stackId,
    RequestId: expected.resourceOperationId,
    LogicalResourceId: expected.logicalId,
    NoEcho: value.NoEcho === true,
    Data: structuredClone((value.Data ?? {}) as Record<string, unknown>),
  };
}

/** Shared durable broker behind the private HTTPS callback listener. */
export class CustomResourceCallbackBroker {
  private readonly journals = new Map<string, CloudFormationJournal>();
  private readonly completionWaiters = new Map<string, Set<() => void>>();
  private callbackWriteQueue: Promise<void> = Promise.resolve();
  private endpointPort = 0;
  private readonly pkiDirectory: string;
  readonly caCertificatePath: string;
  readonly caPrivateKeyPath: string;
  readonly serverCertificatePath: string;
  readonly serverPrivateKeyPath: string;

  constructor(private readonly store: StateStore, private readonly clock: Clock) {
    this.pkiDirectory = resolve(store.root, "data", "cloudformation", "custom-resource-pki");
    this.caCertificatePath = resolve(this.pkiDirectory, "ca.pem");
    this.caPrivateKeyPath = resolve(this.pkiDirectory, "ca-key.pem");
    this.serverCertificatePath = resolve(this.pkiDirectory, "localhost.pem");
    this.serverPrivateKeyPath = resolve(this.pkiDirectory, "localhost-key.pem");
  }

  private journal(region: string): CloudFormationJournal {
    let journal = this.journals.get(region);
    if (!journal) { journal = new CloudFormationJournal(this.store.root, this.store.accountId, region); this.journals.set(region, journal); }
    return journal;
  }

  private artifactId(resourceOperationId: string): string { return `${resourceOperationId}.json`; }

  async initializePki(): Promise<{ ca: string; caPrivateKey: string; certificate: string; privateKey: string }> {
    await mkdir(this.pkiDirectory, { recursive: true, mode: 0o700 });
    try {
      const [ca, caPrivateKey, certificate, privateKey] = await Promise.all([
        readFile(this.caCertificatePath, "utf8"),
        readFile(this.caPrivateKeyPath, "utf8"),
        readFile(this.serverCertificatePath, "utf8"),
        readFile(this.serverPrivateKeyPath, "utf8"),
      ]);
      const parsed = new X509Certificate(certificate);
      const caCertificate = new X509Certificate(ca);
      const caKey = createPrivateKey(caPrivateKey);
      const key = createPrivateKey(privateKey);
      // TLS peers validate certificate dates against host wall time, even when
      // the simulator uses an injected clock for modeled AWS timestamps.
      if (!caCertificate.checkPrivateKey(caKey) || !parsed.verify(caCertificate.publicKey) || !parsed.checkPrivateKey(key) || !parsed.checkHost("localhost") || !parsed.checkIP("127.0.0.1") || Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) <= Date.now() + 24 * 60 * 60_000) throw new Error("Callback certificate is invalid, mismatched, not yet valid, or expiring");
      return { ca, caPrivateKey, certificate, privateKey };
    } catch {
      const generated = createLoopbackServerCertificate(Date.now());
      await replacePkiBundle(this.pkiDirectory, [
        [this.caCertificatePath, generated.caCertificate],
        [this.caPrivateKeyPath, generated.caPrivateKey],
        [this.serverCertificatePath, generated.certificate],
        [this.serverPrivateKeyPath, generated.privateKey],
      ]);
      return { ca: generated.caCertificate, caPrivateKey: generated.caPrivateKey, certificate: generated.certificate, privateKey: generated.privateKey };
    }
  }

  setEndpointPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError("Custom-resource callback port must be 1-65535");
    this.endpointPort = port;
  }

  now(): number { return this.clock.now(); }
  port(): number { return this.endpointPort; }

  private signingKey(): Buffer { return Buffer.from(this.store.state.installation.paginationSecret, "utf8"); }

  private token(payload: TokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.signingKey()).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private parseToken(token: string): TokenPayload {
    const [encoded, supplied, extra] = token.split(".");
    if (!encoded || !supplied || extra !== undefined) throw new TypeError("Invalid callback token");
    const expected = createHmac("sha256", this.signingKey()).update(encoded).digest();
    let actual: Buffer;
    try { actual = Buffer.from(supplied, "base64url"); } catch { throw new TypeError("Invalid callback token"); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new TypeError("Invalid callback token");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new TypeError("Invalid callback token"); }
    if (!record(value) || typeof value.r !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value.r) || typeof value.o !== "string" || !/^[a-f0-9]{64}$/.test(value.o) || typeof value.e !== "number" || !Number.isSafeInteger(value.e)) throw new TypeError("Invalid callback token");
    return { r: value.r, o: value.o, e: value.e };
  }

  responseUrl(region: string, resourceOperationId: string, expiresAt: number): string {
    if (!this.endpointPort) throw new Error("Custom-resource callback listener has not started");
    const token = this.token({ r: region, o: resourceOperationId, e: expiresAt });
    return `https://localhost:${this.endpointPort}${CALLBACK_PATH}${token}`;
  }

  async prepare(intent: CustomResourceCallbackIntent): Promise<CustomResourceCallbackRecord> {
    return this.enqueueCallbackWrite(async () => {
      const journal = this.journal(intent.region);
      const artifactId = this.artifactId(intent.resourceOperationId);
      const existing = await journal.readJsonArtifact<CustomResourceCallbackRecord>(CALLBACK_COLLECTION, artifactId);
      const operationId = intent.operationId ?? intent.resourceOperationId;
      const tokenDigest = createHash("sha256").update(this.token({ r: intent.region, o: intent.resourceOperationId, e: intent.expiresAt })).digest("hex");
      if (existing) {
        if (existing.schemaVersion !== 1 || existing.accountId !== this.store.accountId || existing.region !== intent.region || existing.resourceType !== intent.resourceType || existing.requestType !== intent.requestType || existing.operationId !== undefined && existing.operationId !== operationId || existing.resourceOperationId !== intent.resourceOperationId || existing.stackId !== intent.stackId || existing.logicalId !== intent.logicalId || existing.serviceToken !== intent.serviceToken || existing.expiresAt !== intent.expiresAt || existing.tokenDigest !== tokenDigest) throw new Error("Durable custom-resource callback intent does not match the active operation");
        if (existing.operationId !== undefined) return existing;
        const upgraded: CustomResourceCallbackRecord = { ...existing, operationId };
        await journal.replaceJsonArtifact(CALLBACK_COLLECTION, artifactId, upgraded);
        return upgraded;
      }
      const created: CustomResourceCallbackRecord = { schemaVersion: 1, accountId: this.store.accountId, ...intent, operationId, tokenDigest, createdAt: this.clock.now(), invocationStatus: "INTENT" };
      await journal.replaceJsonArtifact(CALLBACK_COLLECTION, artifactId, created);
      return created;
    });
  }

  async read(region: string, resourceOperationId: string): Promise<CustomResourceCallbackRecord | undefined> {
    return this.journal(region).readJsonArtifact<CustomResourceCallbackRecord>(CALLBACK_COLLECTION, this.artifactId(resourceOperationId));
  }

  /**
   * Observe a durable callback without polling.  The listener is registered
   * before the journal read so a callback racing this method cannot be lost.
   * Callers must cancel the watch when the Lambda invocation finishes first.
   */
  watchCompletion(region: string, resourceOperationId: string): CustomResourceCompletionWatch {
    const key = `${region}:${resourceOperationId}`;
    let active = true;
    let resolveCompleted!: () => void;
    const remove = () => {
      const waiters = this.completionWaiters.get(key);
      waiters?.delete(resolveWatch);
      if (waiters?.size === 0) this.completionWaiters.delete(key);
    };
    const resolveWatch = () => {
      if (!active) return;
      active = false;
      remove();
      resolveCompleted();
    };
    const completed = new Promise<void>(resolvePromise => { resolveCompleted = resolvePromise; });
    const waiters = this.completionWaiters.get(key) ?? new Set<() => void>();
    waiters.add(resolveWatch);
    this.completionWaiters.set(key, waiters);
    void this.read(region, resourceOperationId).then(record => {
      if (record?.invocationStatus === "COMPLETED") resolveWatch();
    }).catch(() => undefined);
    return {
      completed,
      cancel() {
        if (!active) return;
        active = false;
        remove();
      },
    };
  }

  private notifyCompletion(region: string, resourceOperationId: string): void {
    const waiters = this.completionWaiters.get(`${region}:${resourceOperationId}`);
    if (!waiters) return;
    for (const resolveWaiter of [...waiters]) resolveWaiter();
  }

  async markInvoked(record: CustomResourceCallbackRecord): Promise<CustomResourceCallbackRecord> {
    return this.enqueueCallbackWrite(async () => {
      const current = await this.read(record.region, record.resourceOperationId);
      if (!current) throw new Error("Custom-resource callback intent disappeared before invocation");
      if (current.invocationStatus !== "INTENT") return current;
      const next: CustomResourceCallbackRecord = { ...current, invocationStatus: "INVOKED", invokedAt: this.clock.now() };
      await this.journal(record.region).replaceJsonArtifact(CALLBACK_COLLECTION, this.artifactId(record.resourceOperationId), next);
      return next;
    });
  }

  async markInvocationFailed(record: CustomResourceCallbackRecord, reason: string): Promise<CustomResourceCallbackRecord> {
    return this.enqueueCallbackWrite(async () => {
      const current = await this.read(record.region, record.resourceOperationId);
      if (!current) throw new Error("Custom-resource callback intent disappeared after invocation");
      if (current.invocationStatus === "COMPLETED") return current;
      const next: CustomResourceCallbackRecord = { ...current, invocationStatus: "INVOCATION_FAILED", invocationFailure: reason.slice(0, 4096) };
      await this.journal(record.region).replaceJsonArtifact(CALLBACK_COLLECTION, this.artifactId(record.resourceOperationId), next);
      return next;
    });
  }

  private enqueueCallbackWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.callbackWriteQueue.then(operation, operation);
    this.callbackWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Reclaim callback bodies outside the configured CloudFormation history
   * window while preserving every live/recoverable parent operation and every
   * still-valid one-use URL. The sweep shares the callback write queue, so it
   * cannot race prepare, invocation-state transitions, or an accepted PUT.
   */
  async sweep(region: string, options: { readonly cutoff: number; readonly preserveOperationIds: readonly string[] }): Promise<number> {
    return this.enqueueCallbackWrite(async () => {
      const journal = this.journal(region);
      const preserved = new Set(options.preserveOperationIds);
      const obsolete: string[] = [];
      for (const artifactId of await journal.listArtifacts(CALLBACK_COLLECTION)) {
        const callback = await journal.readJsonArtifact<CustomResourceCallbackRecord>(CALLBACK_COLLECTION, artifactId);
        if (!callback) continue;
        // Pre-CFN-14 records cannot be tied safely to a parent operation. Their
        // population is finite, so preserve them until prepare() can migrate a
        // replaying operation rather than risking duplicate provider mutation
        // during the first upgraded startup sweep.
        if (!callback.operationId) continue;
        if (callback.operationId && preserved.has(callback.operationId)) continue;
        if ((callback.invocationStatus === "INTENT" || callback.invocationStatus === "INVOKED") && callback.expiresAt > this.clock.now()) continue;
        const retainedAt = callback.consumedAt ?? callback.invokedAt ?? callback.createdAt;
        if (retainedAt >= options.cutoff) continue;
        obsolete.push(artifactId);
      }
      return obsolete.length ? journal.deleteArtifacts(CALLBACK_COLLECTION, obsolete) : 0;
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    try {
      const host = String(req.headers.host ?? "");
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) return responseError(res, 400, "Invalid callback host");
      if (req.method !== "PUT") return responseError(res, 405, "Only PUT is accepted");
      const url = new URL(req.url ?? "/", `https://${host}`);
      if (!url.pathname.startsWith(CALLBACK_PATH) || url.search || url.hash) return responseError(res, 404, "Callback not found");
      const rawToken = url.pathname.slice(CALLBACK_PATH.length);
      if (!rawToken || rawToken.includes("/")) return responseError(res, 404, "Callback not found");
      const token = this.parseToken(rawToken);
      if (this.clock.now() >= token.e) return responseError(res, 410, "Callback URL has expired");
      const callback = await this.read(token.r, token.o);
      if (!callback || callback.expiresAt !== token.e || callback.tokenDigest !== createHash("sha256").update(rawToken).digest("hex")) return responseError(res, 404, "Callback not found");
      if (callback.invocationStatus === "COMPLETED") return responseError(res, 409, "Callback URL has already been used");
      if (callback.invocationStatus === "INVOCATION_FAILED") return responseError(res, 409, "Callback invocation is no longer active");
      const body = await boundedBody(req);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { return responseError(res, 400, "Callback body must be valid JSON"); }
      try {
        await this.enqueueCallbackWrite(async () => {
          const current = await this.read(token.r, token.o);
          if (!current || current.expiresAt !== token.e || current.tokenDigest !== createHash("sha256").update(rawToken).digest("hex")) throw Object.assign(new Error("Callback not found"), { status: 404 });
          if (this.clock.now() >= current.expiresAt) throw Object.assign(new Error("Callback URL has expired"), { status: 410 });
          if (current.invocationStatus === "COMPLETED") throw Object.assign(new Error("Callback URL has already been used"), { status: 409 });
          if (current.invocationStatus === "INVOCATION_FAILED") throw Object.assign(new Error("Callback invocation is no longer active"), { status: 409 });
          const response = canonicalResponse(parsed, current);
          const completed: CustomResourceCallbackRecord = { ...current, invocationStatus: "COMPLETED", consumedAt: this.clock.now(), response };
          await this.journal(token.r).replaceJsonArtifact(CALLBACK_COLLECTION, this.artifactId(token.o), completed);
          this.notifyCompletion(token.r, token.o);
        });
      } catch (error) { return responseError(res, Number((error as any)?.status ?? 400), error instanceof Error ? error.message : String(error)); }
      res.statusCode = 200;
      res.end();
    } catch (error) {
      responseError(res, Number((error as any)?.status ?? 400), error instanceof Error ? error.message : "Invalid callback");
    }
  }

  async flush(): Promise<void> { await this.callbackWriteQueue; await Promise.all([...this.journals.values()].map(journal => journal.flush())); }
}
