import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { StateStore } from "../state.js";
import type { Clock } from "../core/clock.js";
import { EncryptedMaterialStore, type MaterialBinding } from "../configuration-secrets/encrypted-material-store.js";
import type { DomainRecord } from "./model.js";
import type { EmbeddedSearchEngine } from "./engine.js";
import type { SnapshotObjectPort, SnapshotRepository } from "./snapshots.js";
import { SNAPSHOT_BYTES } from "./snapshot-data.js";
import { fail, SearchError, type Json } from "./query.js";

export const AUTOMATIC_INTERVAL = 3600000, AUTOMATIC_RETENTION = 14 * 24 * AUTOMATIC_INTERVAL, AUTOMATIC_STORAGE = 1024 ** 3;
interface AutomaticBackup { id: string; name: string; repository: string; material: string; bytes: number; createdAt: number; metadata: Json }
export interface AutomaticBackupState { nextAt: number; items: AutomaticBackup[]; retired: string[]; failure?: { at: number; message: string } }
interface BackupPorts { all(): DomainRecord[]; engine(domain: DomainRecord): EmbeddedSearchEngine; admit(domain: DomainRecord): () => void; available(domain: DomainRecord): boolean }
const prefix = "stacksim-snapshots-v1/";

/** Service-owned, encrypted portable backups. Their lifecycle follows the domain. */
export class AutomaticSearchBackups {
  private readonly materials: EncryptedMaterialStore;
  private readonly jobs = new Map<string, Promise<void>>();
  private timer?: ReturnType<Clock["setTimeout"]>;
  private stopped = true;
  private storageFailure = false;
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly ports: BackupPorts) { this.materials = new EncryptedMaterialStore(store.root, "opensearch-backups"); }
  private binding(domain: DomainRecord, id: string): MaterialBinding { return { service: "opensearch-backups", accountId: domain.accountId, region: domain.region, resourceArn: domain.arn, generationId: domain.generation, valueKind: "SecretString", version: id }; }
  private state(domain: DomainRecord): AutomaticBackupState { return domain.automaticBackups ??= { nextAt: Math.floor(domain.createdAt / AUTOMATIC_INTERVAL) * AUTOMATIC_INTERVAL + AUTOMATIC_INTERVAL, items: [], retired: [] }; }
  private repositoryName(domain: DomainRecord): string { return domain.config.EncryptionAtRestOptions?.Enabled ? "cs-automated-enc" : "cs-automated"; }
  repositories(domain: DomainRecord): SnapshotRepository[] {
    return [...new Set([this.repositoryName(domain), ...(domain.automaticBackups?.items ?? []).map(item => item.repository)])].map(name => ({ name, type: "stacksim-automatic", settings: { bucket: "", base_path: "", role_arn: "", region: domain.region, readonly: true } }));
  }
  async start(): Promise<void> {
    this.stopped = false;
    try { await this.materials.start(new Set(this.ports.all().filter(domain => domain.state !== "deleting").flatMap(domain => domain.automaticBackups?.items.map(item => item.material) ?? []))); }
    catch {
      this.storageFailure = true;
      for (const domain of this.ports.all()) if (domain.state !== "deleting" && domain.automaticBackups) domain.automaticBackups.failure = { at: this.clock.now(), message: "Automatic backup storage is unavailable; restore its matching key and material files" };
      await this.store.save().catch(() => undefined);
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => { void this.tick(); this.schedule(); }, 60000);
    if (typeof this.timer === "object") this.timer.unref?.();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer !== undefined) this.clock.clearTimeout(this.timer); await this.drain(); }
  async drain(): Promise<void> { await Promise.all([...this.jobs.values()]); }
  async tick(): Promise<void> {
    for (const domain of this.ports.all()) {
      if (domain.state === "deleting" || this.jobs.has(domain.generation)) continue;
      const state = domain.automaticBackups;
      const due = (state?.nextAt ?? Math.floor(domain.createdAt / AUTOMATIC_INTERVAL) * AUTOMATIC_INTERVAL + AUTOMATIC_INTERVAL) <= this.clock.now();
      const expired = state?.items.some(item => item.createdAt <= this.clock.now() - AUTOMATIC_RETENTION);
      if (!due && !expired && !state?.retired.length) continue;
      // Serialize with repository reads/restores so a success is never listed
      // before its catalog reference is durable, and retention cannot race reads.
      const job = this.store.withMutationLock("opensearch:snapshot-repositories", () => this.capture(domain, due)).catch(() => { /* Persisted schedule/reference remains retryable after a control-store failure. */ }).finally(() => this.jobs.delete(domain.generation)); this.jobs.set(domain.generation, job);
    }
    await this.drain();
  }
  private async cleanup(domain: DomainRecord): Promise<void> {
    const state = this.state(domain); if (!state.retired.length) return;
    for (const id of state.retired) await this.materials.remove(id);
    const previous = state.retired; state.retired = [];
    try { await this.store.save(); } catch (error) { state.retired = previous; throw error; }
  }
  private async capture(domain: DomainRecord, due: boolean): Promise<void> {
    const before = structuredClone(domain.automaticBackups), state = this.state(domain), now = this.clock.now(); let published: string | undefined, release: (() => void) | undefined;
    try {
      if (this.storageFailure) fail("Automatic backup storage is unavailable; restore its matching key and material files", "snapshot_exception", 503);
      if (due && this.ports.available(domain)) {
        release = this.ports.admit(domain);
        const engine = this.ports.engine(domain), data = engine.exportSnapshot({ include_global_state: true }), id = randomUUID(), name = `automatic-${now}-${id.slice(0, 8)}`, indices = data.indexes.map(index => index.name);
        const metadata = { snapshot: name, uuid: id, version_id: 2190099, version: "2.19.0", indices, data_streams: [], include_global_state: true, state: "SUCCESS", start_time: new Date(now).toISOString(), start_time_in_millis: now, end_time: new Date(this.clock.now()).toISOString(), end_time_in_millis: this.clock.now(), duration_in_millis: Math.max(0, this.clock.now() - now), failures: [], shards: { total: indices.length, failed: 0, successful: indices.length } };
        const plain = Buffer.from(JSON.stringify({ snapshot: metadata, data })); if (plain.length > SNAPSHOT_BYTES) fail("Automatic backup exceeds the 96 MiB expanded limit", "limit_exceeded_exception", 413);
        const compressed = gzipSync(plain); plain.fill(0);
        try { published = (await this.materials.publish(this.binding(domain, id), compressed)).materialId; } finally { compressed.fill(0); }
        // Compressed length survives zeroing; the dictionary/body never enters control state.
        state.items.push({ id, name, repository: this.repositoryName(domain), material: published, bytes: compressed.length, createdAt: now, metadata });
        state.nextAt = Math.floor(now / AUTOMATIC_INTERVAL) * AUTOMATIC_INTERVAL + AUTOMATIC_INTERVAL; delete state.failure;
      } else if (due) { state.failure = { at: now, message: "Domain is unavailable; automatic backup will retry" }; state.nextAt = now + 60000; }
      let bytes = state.items.reduce((total, item) => total + item.bytes, 0);
      while (state.items.length && (state.items[0].createdAt <= now - AUTOMATIC_RETENTION || state.items.length > 336 || bytes > AUTOMATIC_STORAGE)) { const item = state.items.shift()!; state.retired.push(item.material); bytes -= item.bytes; }
      try { await this.store.save(); } catch (error) { domain.automaticBackups = before; throw error; }
      const committed = published; published = undefined; if (committed) await this.materials.commit(committed);
      await this.cleanup(domain);
    } catch (error) {
      if (published) { domain.automaticBackups = before; await this.materials.abort(published).catch(() => undefined); }
      const current = this.state(domain); current.failure = { at: now, message: error instanceof SearchError ? error.message : "Automatic backup storage operation failed" }; current.nextAt = now + 60000;
      await this.store.save();
    } finally { release?.(); }
  }
  objects(domain: DomainRecord, repository: SnapshotRepository): SnapshotObjectPort {
    const items = () => domain.automaticBackups?.items.filter(item => item.repository === repository.name) ?? [];
    const item = (key: string) => items().find(item => key === `${prefix}${item.name}.json.gz`) ?? fail("Automatic snapshot does not exist", "snapshot_missing_exception", 404);
    return {
      list: async path => items().map(item => `${prefix}${item.name}.json.gz`).filter(key => key.startsWith(path)),
      read: async key => { if (this.storageFailure) fail("Automatic backup storage is unavailable", "snapshot_exception", 503); const value = item(key); return this.materials.read(this.binding(domain, value.id), value.material); },
      describe: async key => structuredClone(item(key).metadata),
      write: async () => fail("Automatic snapshots are service managed and read-only", "repository_exception", 403),
      remove: async () => fail("Automatic snapshots are service managed and read-only", "repository_exception", 403),
    };
  }
  async removeDomain(domain: DomainRecord): Promise<void> {
    await this.jobs.get(domain.generation);
    await this.store.withMutationLock("opensearch:snapshot-repositories", async () => {
      const state = domain.automaticBackups; if (!state) return;
      for (const id of [...state.items.map(item => item.material), ...state.retired]) await this.materials.remove(id);
    });
  }
}
