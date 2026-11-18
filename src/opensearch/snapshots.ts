import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { StateStore } from "../state.js";
import type { Clock } from "../core/clock.js";
import type { PrincipalContext } from "../auth/sigv4.js";
import { AwsError } from "../errors.js";
import type { DomainRecord } from "./model.js";
import type { EmbeddedSearchEngine, EngineResponse } from "./engine.js";
import type { SearchAccess } from "./security.js";
import { fail, keys, record, SearchError, wildcard, type Json } from "./query.js";
import { SNAPSHOT_BYTES, snapshotBoolean, snapshotRestoreOptions, type SnapshotData } from "./snapshot-data.js";

export interface SnapshotRepository { name: string; type: "s3" | "stacksim-automatic"; settings: { bucket: string; base_path: string; region: string; role_arn: string; readonly: boolean } }
export interface SnapshotObjectPort {
  list(prefix: string): Promise<string[]>;
  read(key: string): Promise<Buffer>;
  describe?(key: string): Promise<Json>;
  write(key: string, body: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}
interface SnapshotPorts {
  engine(domain: DomainRecord): EmbeddedSearchEngine;
  all(): Array<{ domain: DomainRecord; engine?: EmbeddedSearchEngine }>;
  admit(domain: DomainRecord): () => void;
  passRole(domain: DomainRecord, principal: PrincipalContext, roleArn: string, secure: boolean): void;
  objects(domain: DomainRecord, repository: SnapshotRepository): Promise<SnapshotObjectPort>;
  automatic?(domain: DomainRecord): SnapshotRepository[];
}
interface SnapshotJob extends Json {
  id: string; repository: string; snapshot: string; kind: "create" | "restore";
  state: "IN_PROGRESS" | "SUCCESS" | "FAILED"; started: number; ended?: number;
  indices: string[]; options: Json; repositoryConfig: SnapshotRepository; error?: string;
}
const reply = (body: any): EngineResponse => ({ status: 200, body });
const name = (value: string, label: string) => { if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(value) || value.startsWith("cs-")) fail(`Invalid ${label} name`); return value; };
const queryBoolean = (url: URL, key: string, fallback = false) => { const value = url.searchParams.get(key); if (value === null) return fallback; if (!["true", "false"].includes(value)) fail(`${key} must be true or false`); return value === "true"; };

/** Durable local snapshot jobs. Staging and state share the domain transaction. */
export class SearchSnapshots {
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly ports: SnapshotPorts) {}
  private repository(engine: EmbeddedSearchEngine, repository: string, domain: DomainRecord): SnapshotRepository {
    return this.ports.automatic?.(domain).find(item => item.name === repository) ?? engine.snapshotRecord("repository", repository) as SnapshotRepository | undefined ?? fail(`Repository [${repository}] is missing`, "repository_missing_exception", 404);
  }
  private jobInRepository(job: Json, repository: SnapshotRepository): boolean {
    return job.repository === repository.name && ["bucket", "base_path", "region"].every(key => job.repositoryConfig?.settings?.[key] === (repository.settings as any)[key]);
  }
  private prefix(repository: SnapshotRepository): string { return `${repository.settings.base_path ? `${repository.settings.base_path}/` : ""}stacksim-snapshots-v1/`; }
  private key(repository: SnapshotRepository, snapshot: string): string { return `${this.prefix(repository)}${snapshot}.json.gz`; }
  private metadata(job: SnapshotJob): Json {
    return { snapshot: job.snapshot, uuid: job.id, version_id: 2190099, version: "2.19.0", indices: job.indices, include_global_state: job.options.include_global_state !== false, state: job.state, start_time: new Date(job.started).toISOString(), start_time_in_millis: job.started, ...(job.ended === undefined ? {} : { end_time: new Date(job.ended).toISOString(), end_time_in_millis: job.ended, duration_in_millis: Math.max(0, job.ended - job.started) }), failures: job.error ? [{ reason: job.error }] : [], shards: { total: job.indices.length, failed: job.state === "FAILED" ? job.indices.length : 0, successful: job.state === "SUCCESS" ? job.indices.length : 0 } };
  }
  private status(repository: string, snapshot: Json): Json {
    const stage = snapshot.state === "IN_PROGRESS" ? "STARTED" : snapshot.state === "SUCCESS" ? "DONE" : "FAILURE";
    const shards = (total: number) => ({ initializing: 0, started: stage === "STARTED" ? total : 0, finalizing: 0, done: stage === "DONE" ? total : 0, failed: stage === "FAILURE" ? total : 0, total });
    const stats = { start_time_in_millis: snapshot.start_time_in_millis, time_in_millis: snapshot.duration_in_millis ?? Math.max(0, this.clock.now() - snapshot.start_time_in_millis) };
    return { repository, snapshot: snapshot.snapshot, uuid: snapshot.uuid, state: stage === "STARTED" ? "STARTED" : snapshot.state, include_global_state: snapshot.include_global_state, shards_stats: shards(snapshot.indices.length), stats, indices: Object.fromEntries(snapshot.indices.map((index: string) => [index, { shards_stats: shards(1), stats, shards: { "0": { stage, stats, ...(snapshot.failures?.[0]?.reason ? { reason: snapshot.failures[0].reason } : {}) } } }])) };
  }
  private decode(bytes: Buffer): { snapshot: Json; data: SnapshotData } {
    let value: Json;
    try { value = record(JSON.parse(gunzipSync(bytes, { maxOutputLength: SNAPSHOT_BYTES }).toString("utf8")), "snapshot"); }
    catch { return fail("Snapshot object is corrupt, oversized, or not a StackSim snapshot", "snapshot_restore_exception"); }
    keys(value, ["snapshot", "data"], "snapshot object");
    if (value.data?.format !== "stacksim-search-snapshot-v1" || typeof value.snapshot?.snapshot !== "string" || value.snapshot.state !== "SUCCESS" || !Array.isArray(value.snapshot.indices)) fail("Unsupported snapshot object", "snapshot_restore_exception");
    return value as { snapshot: Json; data: SnapshotData };
  }
  private async read(objects: SnapshotObjectPort, repository: SnapshotRepository, snapshot: string) {
    try { const value = this.decode(await objects.read(this.key(repository, snapshot))); if (value.snapshot.snapshot !== snapshot) fail("Snapshot object name does not match its metadata", "snapshot_restore_exception"); return value; }
    catch (error) { if (error instanceof AwsError && ["NoSuchKey", "NotFound"].includes(error.code)) fail(`Snapshot [${snapshot}] is missing`, "snapshot_missing_exception", 404); throw error; }
  }
  private pending(engine: EmbeddedSearchEngine): SnapshotJob | undefined { return engine.snapshotRecords("job").find(job => job.state === "IN_PROGRESS") as SnapshotJob | undefined; }
  private ensureIdle(engine: EmbeddedSearchEngine): void { if (this.pending(engine)) fail("Another snapshot or restore is in progress", "concurrent_snapshot_execution_exception", 409); }
  private prune(engine: EmbeddedSearchEngine): void {
    const history = engine.snapshotRecords("job").filter(job => job.state !== "IN_PROGRESS").sort((a, b) => b.started - a.started);
    history.slice(31).forEach(job => engine.snapshotRecord("job", job.id, null));
  }
  private launch(domain: DomainRecord, job: SnapshotJob): Promise<void> {
    const running = this.jobs.get(domain.generation); if (running) return running;
    const release = this.ports.admit(domain);
    const task = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      try {
        const engine = this.ports.engine(domain), current = engine.snapshotRecord("job", job.id) as SnapshotJob;
        if (!current || current.state !== "IN_PROGRESS") return;
        try {
          const data = engine.stagedSnapshot(job.id);
          if (job.kind === "restore") engine.restoreSnapshot(data, job.options, { ...job, ended: this.clock.now() });
          else {
            const objects = await this.ports.objects(domain, job.repositoryConfig), finished: SnapshotJob = { ...job, state: "SUCCESS", ended: this.clock.now() };
            const body = Buffer.from(JSON.stringify({ snapshot: this.metadata(finished), data }));
            if (body.length > SNAPSHOT_BYTES) fail("Snapshot exceeds the 96 MiB object bound", "limit_exceeded_exception", 413);
            await objects.write(this.key(job.repositoryConfig, job.snapshot), gzipSync(body));
            engine.finishSnapshot(finished);
          }
        } catch (error) {
          // Retain the durable intent if the local commit itself fails. On restart,
          // rewriting the same object or atomically replaying restore is safe.
          const message = error instanceof SearchError || error instanceof AwsError ? error.message.slice(0, 512) : "Snapshot storage operation failed";
          try { engine.finishSnapshot({ ...job, state: "FAILED", error: message, ended: this.clock.now() }); } catch { /* Restart owns the last committed intent. */ }
        }
      } finally { release(); }
    }).catch(() => { /* Domain migration/deletion owns unavailable generations. */ }).finally(() => this.jobs.delete(domain.generation));
    this.jobs.set(domain.generation, task); return task;
  }
  resume(domain: DomainRecord): void { const job = this.pending(this.ports.engine(domain)); if (job) void this.launch(domain, job); }
  async drain(domain?: DomainRecord): Promise<void> { await Promise.all(domain ? [this.jobs.get(domain.generation)] : [...this.jobs.values()]); }
  private async verify(domain: DomainRecord, repository: SnapshotRepository): Promise<Json> {
    const objects = await this.ports.objects(domain, repository); await objects.list(this.prefix(repository));
    if (!repository.settings.readonly) {
      const key = `${this.prefix(repository)}verify-${randomUUID()}.probe`, bytes = Buffer.from(randomUUID());
      await objects.write(key, bytes);
      try { if (!(await objects.read(key)).equals(bytes)) fail("Snapshot repository verification returned different bytes", "repository_verification_exception"); }
      finally { await objects.remove(key); }
    }
    return { nodes: { [domain.generation]: { name: "stacksim-embedded" } } };
  }
  async request(domain: DomainRecord, principal: PrincipalContext, method: string, path: string, bytes: Buffer, access?: SearchAccess, secure = true): Promise<EngineResponse> {
    const url = new URL(path, "https://localhost"), parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent), engine = this.ports.engine(domain);
    for (const key of url.searchParams.keys()) {
      if (url.searchParams.getAll(key).length !== 1) fail(`Repeated snapshot parameter [${key}]`);
      if (!["pretty", "wait_for_completion", "verify", "ignore_unavailable", "verbose"].includes(key)) fail(`Snapshot parameter [${key}] is not supported`);
      if (key === "verify" && !(parts.length === 2 && ["PUT", "POST"].includes(method)) || key === "wait_for_completion" && !(["PUT", "POST"].includes(method) && (parts.length === 3 || parts[3] === "_restore")) || ["ignore_unavailable", "verbose"].includes(key) && method !== "GET") fail(`Snapshot parameter [${key}] is not valid for this operation`);
    }
    const wait = queryBoolean(url, "wait_for_completion"), verify = queryBoolean(url, "verify", true); queryBoolean(url, "ignore_unavailable");
    if (url.searchParams.has("verbose") && !queryBoolean(url, "verbose", true)) fail("verbose=false is not supported");
    let body: Json = {}; if (bytes.length) { try { body = record(JSON.parse(bytes.toString("utf8")), "snapshot body"); } catch { fail("Malformed snapshot JSON body", "parse_exception"); } }
    if (parts[0] === "_stacksim" && parts.join("/") === "_stacksim/snapshots/jobs" && method === "GET") { access?.cluster("cluster:admin/snapshot/status"); const automatic = domain.automaticBackups; return reply({ jobs: engine.snapshotRecords("job").map(({ repositoryConfig, options, ...job }) => job).sort((a, b) => b.started - a.started), automatic: { nextAt: automatic?.nextAt ?? Math.floor(domain.createdAt / 3600000) * 3600000 + 3600000, retained: automatic?.items.length ?? 0, storedBytes: automatic?.items.reduce((total, item) => total + item.bytes, 0) ?? 0, ...(automatic?.failure ? { failure: automatic.failure } : {}) } }); }
    if (parts[0] !== "_snapshot" || parts.length > 4) fail("Unsupported snapshot route");
    const repositoryName = parts[1], snapshot = parts[2];
    if (repositoryName === "_status" && parts.length === 2 && method === "GET") {
      keys(body, [], "snapshot status"); access?.cluster("cluster:admin/snapshot/status");
      return reply({ snapshots: engine.snapshotRecords("job").filter(job => job.kind === "create" && job.state === "IN_PROGRESS").map(job => this.status(job.repository, this.metadata(job as SnapshotJob))) });
    }
    const action = !snapshot ? method === "GET" ? "cluster:admin/repository/get" : method === "DELETE" ? "cluster:admin/repository/delete" : "cluster:admin/repository/put" : snapshot === "_verify" ? "cluster:admin/repository/verify" : parts[3] === "_restore" ? "cluster:admin/snapshot/restore" : snapshot === "_status" || parts[3] === "_status" ? "cluster:admin/snapshot/status" : method === "GET" ? "cluster:admin/snapshot/get" : method === "DELETE" ? "cluster:admin/snapshot/delete" : "cluster:admin/snapshot/create";
    access?.cluster(action);
    return this.store.withMutationLock("opensearch:snapshot-repositories", async () => {
      if (!snapshot && method === "GET") {
        keys(body, [], "repository read");
        const found = [...engine.snapshotRecords("repository"), ...(this.ports.automatic?.(domain) ?? [])].filter(repo => !repositoryName || repositoryName === "_all" || repositoryName.split(",").some(pattern => wildcard(pattern, repo.name)));
        if (repositoryName && !found.length) fail("Repository does not exist", "repository_missing_exception", 404);
        return reply(Object.fromEntries(found.map(({ name, ...config }) => [name, config.type === "stacksim-automatic" ? { type: config.type, settings: { readonly: true } } : config])));
      }
      if (!repositoryName) fail("A repository name is required");
      const automatic = this.ports.automatic?.(domain).some(repository => repository.name === repositoryName);
      if (!automatic) name(repositoryName, "repository");
      if (automatic && method !== "GET" && !(method === "POST" && (parts[3] === "_restore" || snapshot === "_verify"))) fail("Automatic repositories and snapshots are service managed and read-only", "repository_exception", 403);
      if (!snapshot && ["PUT", "POST"].includes(method)) {
        keys(body, ["type", "settings"], "repository"); if (body.type !== "s3") fail("Only local S3 snapshot repositories are supported");
        const settings = record(body.settings, "repository settings"); keys(settings, ["bucket", "base_path", "region", "role_arn", "readonly"], "repository settings");
        if (typeof settings.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket)) fail("Invalid S3 bucket name");
        if (settings.region !== undefined && settings.region !== domain.region) fail("Snapshot repository must be in the domain Region");
        if (typeof settings.role_arn !== "string" || !new RegExp(`^arn:(aws|aws-cn|aws-us-gov):iam::${domain.accountId}:role/[A-Za-z0-9+=,.@_/-]+$`).test(settings.role_arn)) fail("Snapshot role must belong to the domain account");
        const prefix = settings.base_path ?? ""; if (typeof prefix !== "string" || prefix.length > 512 || prefix.startsWith("/") || prefix.endsWith("/") || prefix.split("/").some((part: string) => [".", ".."].includes(part)) || /[\u0000-\u001f\\]/.test(prefix)) fail("Invalid repository base_path");
        const repository: SnapshotRepository = { name: repositoryName, type: "s3", settings: { bucket: settings.bucket, base_path: prefix, role_arn: settings.role_arn, region: domain.region, readonly: snapshotBoolean(settings.readonly, false, "readonly") } };
        this.ports.passRole(domain, principal, settings.role_arn, secure); this.ensureIdle(engine);
        if (!repository.settings.readonly) for (const item of this.ports.all()) {
          if (!item.engine && item.domain.storageReady) fail("Cannot establish a unique repository writer while another domain's storage is unavailable", "repository_exception", 503);
          for (const candidate of item.engine?.snapshotRecords("repository") ?? []) if (!(item.domain.generation === domain.generation && candidate.name === repositoryName) && !candidate.settings.readonly && candidate.settings.bucket === settings.bucket && candidate.settings.base_path === prefix) fail("The repository location already has a writer", "repository_exception", 409);
        }
        if (engine.snapshotRecords("repository").length >= 20 && !engine.snapshotRecord("repository", repositoryName)) fail("The local limit is 20 repositories per domain", "limit_exceeded_exception", 429);
        if (verify) await this.verify(domain, repository); else await this.ports.objects(domain, repository);
        engine.snapshotRecord("repository", repositoryName, repository); return reply({ acknowledged: true });
      }
      const repository = this.repository(engine, repositoryName, domain);
      if (!snapshot && method === "DELETE") { keys(body, [], "repository delete"); this.ensureIdle(engine); engine.snapshotRecord("repository", repositoryName, null); return reply({ acknowledged: true }); }
      if (snapshot === "_verify" && parts.length === 3 && method === "POST") { keys(body, [], "repository verify"); return reply(await this.verify(domain, repository)); }
      if (!snapshot) fail("Unsupported repository operation");
      if (snapshot === "_status" || parts[3] === "_status") {
        if (snapshot === "_status" && parts.length !== 3) fail("Unsupported snapshot status route");
        if (method !== "GET") fail("Snapshot status requires GET"); keys(body, [], "snapshot status");
        const local = engine.snapshotRecords("job").filter(job => job.kind === "create" && this.jobInRepository(job, repository) && job.state !== "SUCCESS");
        if (snapshot === "_status") return reply({ snapshots: local.filter(job => job.state === "IN_PROGRESS").map(job => this.status(repositoryName, this.metadata(job as SnapshotJob))) });
        name(snapshot, "snapshot");
        const objects = await this.ports.objects(domain, repository), pending = local.find(job => job.snapshot === snapshot);
        let metadata: Json;
        try { metadata = objects.describe ? await objects.describe(this.key(repository, snapshot)) : (await this.read(objects, repository, snapshot)).snapshot; }
        catch (error) { if (!(error instanceof SearchError && error.type === "snapshot_missing_exception" && pending)) throw error; metadata = this.metadata(pending as SnapshotJob); }
        return reply({ snapshots: [this.status(repositoryName, metadata)] });
      }
      const objects = await this.ports.objects(domain, repository);
      if (method === "GET" && parts.length === 3) {
        keys(body, [], "snapshot read"); const pending = engine.snapshotRecords("job").filter(job => this.jobInRepository(job, repository) && job.kind === "create" && job.state !== "SUCCESS"), all = new Map<string, Json>();
        const matches = (value: string) => snapshot.split(",").some(pattern => wildcard(pattern === "_all" ? "*" : pattern, value));
        if (snapshot !== "_current") {
          const paths = await objects.list(this.prefix(repository)), selected = paths.filter(key => /^[-a-z0-9._]+\.json\.gz$/.test(key.slice(this.prefix(repository).length))).map(key => key.slice(this.prefix(repository).length, -8)).filter(matches);
          const limit = automatic ? 336 : 100; if (selected.length > limit) fail(`Snapshot listing exceeds the local ${limit} snapshot limit`, "limit_exceeded_exception", 429);
          for (const item of selected) all.set(item, objects.describe ? await objects.describe(this.key(repository, item)) : (await this.read(objects, repository, item)).snapshot);
        }
        for (const job of pending) if ((snapshot === "_current" ? job.state === "IN_PROGRESS" : matches(job.snapshot)) && !all.has(job.snapshot)) all.set(job.snapshot, this.metadata(job as SnapshotJob));
        if (!all.size && !["_all", "_current"].includes(snapshot) && !/[?*]/.test(snapshot) && !queryBoolean(url, "ignore_unavailable")) fail("Snapshot does not exist", "snapshot_missing_exception", 404);
        return reply({ snapshots: [...all.values()].sort((a, b) => a.snapshot.localeCompare(b.snapshot)) });
      }
      name(snapshot, "snapshot");
      if (method === "DELETE" && parts.length === 3) {
        keys(body, [], "snapshot delete"); this.ensureIdle(engine); if (repository.settings.readonly) fail("Repository is read-only", "repository_exception", 403);
        const failed = engine.snapshotRecords("job").filter(job => this.jobInRepository(job, repository) && job.snapshot === snapshot && job.kind === "create");
        const exists = (await objects.list(this.prefix(repository))).includes(this.key(repository, snapshot)); if (!exists && !failed.length) fail("Snapshot does not exist", "snapshot_missing_exception", 404);
        if (exists) await objects.remove(this.key(repository, snapshot)); failed.forEach(job => engine.snapshotRecord("job", job.id, null)); return reply({ acknowledged: true });
      }
      if (["PUT", "POST"].includes(method) && parts.length === 3 || method === "POST" && parts[3] === "_restore") {
        this.ensureIdle(engine); this.prune(engine);
        const restore = parts[3] === "_restore";
        let data: SnapshotData, indices: string[], options: Json;
        if (restore) {
          options = snapshotRestoreOptions(body); data = (await this.read(objects, repository, snapshot)).data; indices = engine.validateSnapshotRestore(data, options, access);
        } else {
          if (repository.settings.readonly) fail("Repository is read-only", "repository_exception", 403);
          keys(body, ["indices", "ignore_unavailable", "include_global_state", "partial", "metadata"], "create snapshot");
          for (const key of ["ignore_unavailable", "include_global_state", "partial"]) snapshotBoolean(body[key], false, key);
          if (body.partial) fail("Partial snapshots are not supported"); if (body.metadata !== undefined) fail("Snapshot user metadata is not supported");
          const paths = await objects.list(this.prefix(repository));
          if (paths.includes(this.key(repository, snapshot)) || engine.snapshotRecords("job").some(job => this.jobInRepository(job, repository) && job.snapshot === snapshot && job.kind === "create" && job.state !== "SUCCESS")) fail("Snapshot already exists", "invalid_snapshot_name_exception", 409);
          if (paths.filter(path => path.endsWith(".json.gz")).length >= 100) fail("The local limit is 100 snapshots per repository", "limit_exceeded_exception", 429);
          options = body; data = engine.exportSnapshot(options, access); indices = data.indexes.map(index => index.name);
        }
        const job: SnapshotJob = { id: randomUUID(), repository: repositoryName, snapshot, kind: restore ? "restore" : "create", state: "IN_PROGRESS", started: this.clock.now(), indices, options, repositoryConfig: repository };
        engine.stageSnapshot(job, data); const task = this.launch(domain, job);
        if (!wait) return reply({ accepted: true });
        await task; const result = engine.snapshotRecord("job", job.id) as SnapshotJob;
        if (restore && result.state !== "SUCCESS") fail(result.error ?? "Restore has not completed", "snapshot_restore_exception", 500);
        return reply({ snapshot: restore ? { snapshot, indices, shards: { total: indices.length, successful: indices.length, failed: 0 } } : this.metadata(result) });
      }
      return fail("Unsupported snapshot operation");
    });
  }
}
