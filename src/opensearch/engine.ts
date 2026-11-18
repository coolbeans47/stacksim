import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import capabilities from "../../docs/opensearch-capabilities.json" with { type: "json" };
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ComparisonCategory } from "./compare.js";
import { aggregate } from "./aggregations.js";
import { EncryptedSearchStorage } from "./encrypted-storage.js";
import { SearchSecurity, type SearchAccess, type SecurityMaster } from "./security.js";
import { restoreIndexName, selectSnapshotIndexes, snapshotRestoreOptions, SNAPSHOT_BYTES, type SnapshotData } from "./snapshot-data.js";
import { IngestPipelines, pipelineName } from "./ingest-pipelines.js";
import { executeLanguage, parseLanguage } from "./query-languages.js";
import { SearchPipelines, prepareHybrid } from "./search-pipelines.js";
import { IndexStateManagement } from "./ism.js";
import { compileAnalysis, type CompiledAnalysis, type DictionaryVersion } from "./analyzers.js";
import { indexSettings, mapDocument, mergeMappings, validateMappings } from "./mappings.js";
import { analyze, analyzeTokens, compileQuery, fail, fieldMapping, fieldValues, indexAnalyzer, integer, keys, record, SearchError, selectSource, wildcard, type Candidate, type Json } from "./query.js";

interface Index { name: string; settings: Json; mappings: Json; aliases: Json; seq: number; refreshedAt: number; createdAt?: number; uuid?: string; owner?: string; packageVersions?: Record<string, string> }
interface StoredDoc { index_name: string; id: string; source: string | null; visible: string | null; seq: number; version: number; visible_seq: number; visible_version: number; routing: string | null }
export interface EngineResponse { status: number; body?: any; contentType?: string }
export interface SearchReadView { indexes: Array<Index & { analysis: CompiledAnalysis }>; docs: Candidate[] }
export interface SearchReadBudget { bytes: number; documents: number; indexes: number; deadline: number }
export interface SearchObservation { durationMs: number; indexes: Array<{ name: string; settings: Json }> }
const SHARDS = { total: 1, successful: 1, skipped: 0, failed: 0 };
const response = (body: any, status = 200): EngineResponse => ({ body, status });
const acknowledged = () => response({ acknowledged: true });

/** Each resource owns a WAL database. Acknowledgement follows a FULL synchronous commit. */
export class EmbeddedSearchEngine {
  private readonly db: DatabaseSync;
  private readonly encrypted?: EncryptedSearchStorage;
  private inTransaction = false;
  private storageFailed = false;
  readonly security: SearchSecurity;
  private readonly ingest: IngestPipelines;
  private readonly searchPipelines: SearchPipelines;
  private readonly ism: IndexStateManagement;
  private readonly dictionaries = new Map<string, { current: string; versions: Map<string, string> }>();
  private readonly analysisCache = new Map<string, { key: string; value: CompiledAnalysis }>();
  private readonly authority = new AsyncLocalStorage<{ access: SearchAccess; action: string }>();
  private readonly trace = new AsyncLocalStorage<Set<string>>();
  private readonly contexts = new Map<string, { principal: string; expires: number; docs: Candidate[]; page?: Json; offset: number; size: number; bytes: number; kind: "pit" | "scroll" | "sql" }>();
  private closed = false;
  constructor(readonly file: string, private readonly now: () => number = Date.now, encryption?: { keyFile: string }, private readonly runtime: { refreshIntervalMs?: number; catIndexAction?: string; appendOnly?: boolean; ingestionTimestamps?: boolean; allowVectors?: boolean; externalWorkspaceSources?: boolean } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(encryption ? ":memory:" : file);
    try { this.db.exec(`PRAGMA journal_mode=${encryption ? "MEMORY" : "WAL"}; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (kind TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,name));
      CREATE TABLE IF NOT EXISTS documents (index_name TEXT NOT NULL, id TEXT NOT NULL, source TEXT, visible TEXT, seq INTEGER NOT NULL, version INTEGER NOT NULL, visible_seq INTEGER NOT NULL DEFAULT -1, visible_version INTEGER NOT NULL DEFAULT 0, routing TEXT, PRIMARY KEY(index_name,id));`);
      if (encryption) this.encrypted = new EncryptedSearchStorage(file, encryption.keyFile, this.db);
    }
    catch (error) { this.db.close(); throw error; }
    this.ingest = new IngestPipelines(name => this.get("ingest-pipeline", name)?.pipeline, () => this.entries("ingest-pipeline"), (name, pipeline) => this.put("ingest-pipeline", name, { name, pipeline }), name => this.remove("ingest-pipeline", name), this.now);
    this.searchPipelines = new SearchPipelines(name => this.get("search-pipeline", name)?.pipeline, () => this.entries("search-pipeline"), (name, pipeline) => this.put("search-pipeline", name, { name, pipeline }), name => this.remove("search-pipeline", name));
    this.security = new SearchSecurity(name => this.get("security", name), (name, value) => this.put("security", name, value), name => this.remove("security", name), () => this.entries("security"));
    this.ism = new IndexStateManagement({
      get: (kind, name) => this.get(kind, name), entries: kind => this.entries(kind), put: (kind, name, value) => this.put(kind, name, value), remove: (kind, name) => this.remove(kind, name),
      indexes: () => this.indexes(), transaction: work => this.transaction(work), access: identity => this.security.jobAccess(identity),
      stats: name => { const row = this.db.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(source AS BLOB))),0) AS bytes FROM documents WHERE index_name=? AND source IS NOT NULL").get(name)!; return { count: Number(row.count), bytes: Number(row.bytes) }; },
      block: (name, value) => { const index = this.index(name); index.settings["blocks.write"] = String(value); this.put("index", name, index); },
      delete: name => this.deleteIndex(name), rollover: (name, access) => this.rolloverIndex(name, access),
    }, this.now);
  }
  runIndexManagement(): void { if (!this.closed && !this.storageFailed && this.runtime.refreshIntervalMs === undefined) this.ism.tick(); }
  usesDictionary(id: string): boolean { return this.indexes().some(index => Object.values<any>(index.settings.analysis?.filter ?? {}).some(filter => [filter.synonyms_path, filter.stopwords_path].includes(`analyzers/${id}`))); }
  installDictionary(id: string, version: string, text: string, validate = true): void {
    this.installDictionaryVersions(id, version, [{ version, text }], validate);
  }
  installDictionaryVersions(id: string, version: string, values: DictionaryVersion[], validate = true): () => void {
    if (!/^(?:[FG]\d+|pkg-[a-f0-9]+)$/.test(id) || !/^[1-9]\d{0,5}$/.test(version) || values.length > 20 || values.some(value => !/^[1-9]\d{0,5}$/.test(value.version) || Buffer.byteLength(value.text) > 65536)) fail("Invalid dictionary package");
    const previous = this.dictionaries.get(id), versions = new Map(previous?.versions); values.forEach(value => versions.set(value.version, value.text));
    if (!versions.has(version)) fail("Current dictionary version is missing");
    if (versions.size > 20 || !previous && this.dictionaries.size >= 20) fail("Dictionary package limits exceeded");
    this.dictionaries.set(id, { current: version, versions }); this.analysisCache.clear();
    const undo = () => { if (previous) this.dictionaries.set(id, previous); else this.dictionaries.delete(id); this.analysisCache.clear(); };
    try { if (validate) this.validateAnalysis(); } catch (error) { undo(); throw error; } return undo;
  }
  removeDictionary(id: string): () => void { if (this.usesDictionary(id)) fail("Indexes still reference this package"); const previous = this.dictionaries.get(id); this.dictionaries.delete(id); this.analysisCache.clear(); return () => { if (previous) this.dictionaries.set(id, previous); this.analysisCache.clear(); }; }
  validateAnalysis(): void { for (const index of this.indexes()) this.analysis(index); }
  private packageVersions(settings: Json): Record<string, string> {
    return Object.fromEntries(Object.values<any>(settings.analysis?.filter ?? {}).flatMap(filter => [filter.synonyms_path, filter.stopwords_path].filter(path => typeof path === "string").map(path => { const id = path.slice(10), dictionary = this.dictionaries.get(id); if (!dictionary) fail(`Dictionary package [${id}] is not associated with this domain`); return [id, dictionary.current]; })));
  }
  private analysis(index: Pick<Index, "name" | "settings" | "packageVersions">): CompiledAnalysis {
    if (!index.settings.analysis) return {};
    if (this.runtime.refreshIntervalMs !== undefined) fail("Custom analysis is supported only on managed domains");
    const key = JSON.stringify([index.settings.analysis, index.packageVersions]), cached = this.analysisCache.get(index.name); if (cached?.key === key) return cached.value;
    const value = compileAnalysis(index.settings.analysis, (id, updateable): DictionaryVersion | undefined => {
      const dictionary = this.dictionaries.get(id), version = updateable ? dictionary?.current : index.packageVersions?.[id] ?? dictionary?.current, text = version && dictionary?.versions.get(version);
      return typeof text === "string" ? { version: version!, text } : undefined;
    });
    if (this.analysisCache.size >= 100 && !this.analysisCache.has(index.name)) this.analysisCache.delete(this.analysisCache.keys().next().value!);
    this.analysisCache.set(index.name, { key, value }); return value;
  }
  private analysisNames(pattern: string): Set<string> {
    const indexes = this.resolve(pattern); return new Set(indexes.length ? Object.keys(this.analysis(indexes[0])).filter(name => indexes.every(index => Object.hasOwn(this.analysis(index), name))) : []);
  }
  private queryPredicate(query: Json | undefined, pattern: string) { return compileQuery(query, 0, { clauses: 0, analyzerNames: this.analysisNames(pattern) }); }
  private validateIndexAnalysis(mappings: Json, settings: Json): void {
    const check = (name: string) => { const definition = settings.analysis?.analyzer?.[name]; if (definition?.filter.some((id: string) => settings.analysis.filter?.[id]?.updateable)) fail("Updateable dictionary filters are allowed only in search analyzers"); };
    check("default");
    const walk = (properties: Json) => { for (const field of Object.values<any>(properties)) {
      if (field.analyzer) check(field.analyzer);
      if (field.properties) walk(field.properties); if (field.fields) walk(field.fields);
    } }; walk(mappings.properties ?? {});
  }
  setSecurityMaster(master: SecurityMaster): void { if (!this.encrypted) fail("Security requires encrypted storage"); this.transaction(() => this.security.setMaster(master)); }
  copyStorageTo(target: EmbeddedSearchEngine): void {
    if (target.db.prepare("SELECT count(*) AS count FROM metadata").get()!.count || target.db.prepare("SELECT count(*) AS count FROM documents").get()!.count) fail("Storage migration requires an empty destination");
    target.transaction(() => {
      const metadata = target.db.prepare("INSERT INTO metadata(kind,name,value) VALUES(?,?,?)");
      for (const row of this.db.prepare("SELECT * FROM metadata").all()) metadata.run(row.kind, row.name, row.value);
      const document = target.db.prepare("INSERT INTO documents(index_name,id,source,visible,seq,version,visible_seq,visible_version,routing) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const row of this.db.prepare("SELECT * FROM documents").all()) document.run(row.index_name, row.id, row.source, row.visible, row.seq, row.version, row.visible_seq, row.visible_version, row.routing);
    });
  }
  private authorizeIndex(name: string): void { this.trace.getStore()?.add(name); const context = this.authority.getStore(); context?.access.index(name, context.action); }
  private securedCandidate(doc: Candidate): Candidate | undefined { const context = this.authority.getStore(); return context ? context.access.candidate(doc, context.action) : doc; }
  private readableIndex(index: Index): Index { const context = this.authority.getStore(); return context ? { ...index, mappings: context.access.mappings(index.name, index.mappings, context.action) } : index; }
  close(): void { if (this.closed) return; this.closed = true; this.contexts.clear(); this.dictionaries.clear(); this.analysisCache.clear(); try { if (!this.encrypted) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.encrypted?.close(); this.db.close(); } }
  private transaction<T>(work: () => T): T {
    if (this.storageFailed) fail("Storage must be recovered by restarting the domain", "unavailable_shards_exception", 503);
    if (this.inTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE"); this.inTransaction = true;
    const session = this.encrypted ? this.db.createSession() : undefined;
    let durable = false;
    try {
      const result = work();
      if (session) { const changeset = session.changeset(); try { this.encrypted!.commit(changeset); durable = changeset.length > 0; } catch (error) { this.storageFailed = true; throw error; } finally { changeset.fill(0); } }
      this.db.exec("COMMIT");
      this.encrypted?.compactIfNeeded();
      return result;
    } catch (error) {
      if (durable) this.storageFailed = true;
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    } finally { session?.close(); this.inTransaction = false; }
  }
  private entries(kind: string): any[] { return this.db.prepare("SELECT value FROM metadata WHERE kind = ? ORDER BY name").all(kind).map(row => JSON.parse(String(row.value))); }
  private get(kind: string, name: string): any { const row = this.db.prepare("SELECT value FROM metadata WHERE kind = ? AND name = ?").get(kind, name); return row ? JSON.parse(String(row.value)) : undefined; }
  private put(kind: string, name: string, value: any): void { this.transaction(() => this.db.prepare("INSERT INTO metadata(kind,name,value) VALUES(?,?,?) ON CONFLICT(kind,name) DO UPDATE SET value=excluded.value").run(kind, name, JSON.stringify(value))); }
  private remove(kind: string, name: string): void { this.transaction(() => this.db.prepare("DELETE FROM metadata WHERE kind=? AND name=?").run(kind, name)); }
  indexes(): Index[] { return this.entries("index"); }
  snapshotRecords(kind: "repository" | "job"): Json[] { return this.entries(`snapshot-${kind}`); }
  snapshotRecord(kind: "repository" | "job", name: string, value?: Json | null): Json | undefined {
    if (value === undefined) return this.get(`snapshot-${kind}`, name);
    if (value === null) this.remove(`snapshot-${kind}`, name); else this.put(`snapshot-${kind}`, name, value);
  }
  stageSnapshot(job: Json, data: SnapshotData): void {
    if (Buffer.byteLength(JSON.stringify(data)) > SNAPSHOT_BYTES) fail("Snapshot exceeds the local 96 MiB bound", "limit_exceeded_exception", 413);
    this.transaction(() => { this.put("snapshot-job", job.id, job); this.put("snapshot-stage", job.id, data); });
  }
  stagedSnapshot(id: string): SnapshotData { return this.get("snapshot-stage", id) ?? fail("Snapshot staging data is missing", "snapshot_exception", 500); }
  finishSnapshot(job: Json): void { this.transaction(() => { this.put("snapshot-job", job.id, job); this.remove("snapshot-stage", job.id); }); }
  exportSnapshot(options: Json, access?: SearchAccess): SnapshotData {
    const indexes = selectSnapshotIndexes(this.indexes(), options.indices, options.ignore_unavailable);
    for (const index of indexes) {
      access?.index(index.name, "indices:admin/snapshot/create");
      if (access && !access.unrestrictedMetadata(index.name, "indices:admin/snapshot/create")) fail("Snapshots require unrestricted index access", "security_exception", 403);
    }
    if (options.include_global_state !== false) { access?.cluster("cluster:admin/index_template/get"); if (this.entries("ingest-pipeline").length) access?.cluster("cluster:admin/ingest/pipeline/get"); if (this.entries("search-pipeline").length) access?.cluster("cluster:admin/search/pipeline/get"); }
    // Only user indexes, supported templates and ingest pipelines are portable. Security records,
    // workspace objects, ownership, repositories and job state never leave here.
    return { format: "stacksim-search-snapshot-v1", indexes: indexes.map(index => ({ name: index.name, settings: index.settings, mappings: index.mappings, aliases: index.aliases, seq: index.seq, ...(index.packageVersions ? { packageVersions: index.packageVersions } : {}), documents: (this.db.prepare("SELECT * FROM documents WHERE index_name=? AND source IS NOT NULL ORDER BY id").all(index.name) as unknown as StoredDoc[]).map(doc => ({ id: doc.id, source: JSON.parse(doc.source!), seq: doc.seq, version: doc.version, routing: doc.routing })) })), ...(options.include_global_state === false ? {} : { templates: this.entries("template"), ...(this.entries("ingest-pipeline").length ? { pipelines: this.entries("ingest-pipeline") } : {}), ...(this.entries("search-pipeline").length ? { searchPipelines: this.entries("search-pipeline") } : {}) }) };
  }
  validateSnapshotRestore(data: SnapshotData, options: Json, access?: SearchAccess): string[] {
    if (this.inTransaction || this.storageFailed) fail("Snapshot validation requires healthy idle storage", "snapshot_restore_exception", 503);
    // Exercise the exact restore validation inside a rollback-only transaction.
    // Nested writes cannot publish an encrypted changeset or acknowledge data.
    this.db.exec("BEGIN IMMEDIATE"); this.inTransaction = true;
    try { return this.restoreSnapshot(data, options, undefined, access); }
    finally { try { this.db.exec("ROLLBACK"); } finally { this.inTransaction = false; } }
  }
  restoreSnapshot(data: SnapshotData, input: Json, job?: Json, access?: SearchAccess): string[] {
    const options = snapshotRestoreOptions(input);
    keys(record(data, "snapshot data"), ["format", "indexes", "templates", "pipelines", "searchPipelines"], "snapshot data");
    if (data.format !== "stacksim-search-snapshot-v1" || !Array.isArray(data.indexes) || data.indexes.length > 100 || data.templates !== undefined && (!Array.isArray(data.templates) || data.templates.length > 100)) fail("Unsupported or corrupt StackSim snapshot", "snapshot_restore_exception");
    if (data.pipelines !== undefined && (!Array.isArray(data.pipelines) || data.pipelines.length > 100)) fail("Invalid snapshot ingest pipelines");
    if (data.searchPipelines !== undefined && (!Array.isArray(data.searchPipelines) || data.searchPipelines.length > 100)) fail("Invalid snapshot search pipelines");
    if (data.indexes.some(index => !index || typeof index.name !== "string") || new Set(data.indexes.map(index => index.name)).size !== data.indexes.length) fail("Invalid or duplicate snapshot index names");
    const selected = selectSnapshotIndexes(data.indexes, options.indices, options.ignore_unavailable), names = selected.map(index => restoreIndexName(index.name, options));
    if (new Set(names).size !== names.length || this.indexes().length + names.length > 100) fail("Snapshot restore has duplicate indexes or exceeds the 100 index limit", "snapshot_restore_exception");
    for (const name of names) { this.validName(name); access?.index(name, "indices:admin/create"); if (access && !access.unrestrictedMetadata(name, "indices:admin/create")) fail("Snapshot restore requires unrestricted target access", "security_exception", 403); }
    if (options.include_global_state) { if (data.pipelines?.length) access?.cluster("cluster:admin/ingest/pipeline/put"); if (data.searchPipelines?.length) access?.cluster("cluster:admin/search/pipeline/put"); access?.cluster("cluster:admin/index_template/put"); if (!data.templates) fail("Snapshot does not contain global state", "snapshot_restore_exception"); }
    const existing = this.db.prepare("SELECT count(*) AS records, sum(CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END) AS live, coalesce(sum(length(CAST(source AS BLOB))),0) AS bytes FROM documents").get()!;
    let count = Number(existing.live ?? 0), bytes = Number(existing.bytes), records = Number(existing.records);
    this.transaction(() => {
      for (let at = 0; at < selected.length; at++) {
        const source = selected[at], name = names[at];
        keys(record(source, "snapshot index"), ["name", "settings", "mappings", "aliases", "seq", "documents", "packageVersions"], "snapshot index");
        if (this.get("index", name) || this.indexes().some(index => Object.hasOwn(index.aliases, name))) fail(`Cannot restore over existing index or alias [${name}]`, "snapshot_restore_exception");
        if (!Array.isArray(source.documents) || source.documents.length > 50000) fail("Invalid snapshot documents");
        if (!Number.isSafeInteger(source.seq)) fail("Snapshot index sequence metadata is required");
        const seq = integer(source.seq, -1, -1, Number.MAX_SAFE_INTEGER);
        const supplied = { ...record(source.settings, "snapshot settings") };
        for (const setting of Object.keys(supplied)) if ((options.ignore_index_settings ?? []).some((pattern: string) => wildcard(pattern.replace(/^index\./, ""), setting))) delete supplied[setting];
        const settings = indexSettings(options.index_settings, indexSettings(supplied), false);
        const references = this.packageVersions(settings), bindings = record(source.packageVersions ?? references, "snapshot package versions");
        if (Object.keys(bindings).length > 20 || Object.values(bindings).some(version => typeof version !== "string" || !/^[1-9]\d{0,5}$/.test(version))) fail("Invalid snapshot package versions");
        const packageVersions = Object.fromEntries(Object.keys(references).map(id => { if (!bindings[id]) fail(`Snapshot dictionary binding [${id}] is missing`); return [id, bindings[id]]; }));
        const analysis = this.analysis({ name, settings, packageVersions }), mappings = structuredClone(record(source.mappings, "snapshot mappings")); validateMappings(mappings, 0, new Set(Object.keys(analysis))); this.validateIndexAnalysis(mappings, settings); this.validateCollectionIndex(mappings, settings);
        if (settings.knn !== "true" && Object.values<any>(mappings.properties ?? {}).some(field => field.type === "knn_vector")) fail("Vector indexes require index.knn=true");
        const aliases = options.include_aliases === false ? {} : record(source.aliases, "snapshot aliases"); this.validateAliases(aliases);
        for (const [alias, config] of Object.entries<any>(aliases)) {
          if (names.includes(alias)) fail(`Alias [${alias}] conflicts with a restored index`);
          if (config.is_write_index && this.indexes().some(index => index.aliases[alias]?.is_write_index)) fail(`Alias [${alias}] has multiple write indexes`);
        }
        this.put("index", name, { name, settings, mappings, aliases, seq, uuid: randomUUID(), refreshedAt: this.now(), createdAt: this.now(), ...(Object.keys(packageVersions).length ? { packageVersions } : {}) });
        const insert = this.db.prepare("INSERT INTO documents(index_name,id,source,visible,seq,version,visible_seq,visible_version,routing) VALUES(?,?,?,?,?,?,?,?,?)"), ids = new Set<string>();
        for (const doc of source.documents) {
          keys(record(doc, "snapshot document"), ["id", "source", "seq", "version", "routing"], "snapshot document");
          if (typeof doc.id !== "string" || !doc.id || Buffer.byteLength(doc.id) > 512 || ids.has(doc.id) || doc.routing !== null && (typeof doc.routing !== "string" || doc.routing.length > 512)) fail("Invalid snapshot document identity");
          if (!Number.isSafeInteger(doc.seq) || !Number.isSafeInteger(doc.version)) fail("Snapshot document sequence/version metadata is required");
          ids.add(doc.id); integer(doc.seq, 0, 0, seq); integer(doc.version, 1, 0, Number.MAX_SAFE_INTEGER);
          const encoded = JSON.stringify(record(doc.source, "snapshot source")), size = Buffer.byteLength(encoded);
          if (size > 1024 * 1024 || ++count > 50000 || ++records > 100000 || (bytes += size) > 64 * 1024 * 1024) fail("Restored documents exceed the local storage limits", "limit_exceeded_exception", 429);
          if (JSON.stringify(mapDocument(doc.source, mappings)) !== JSON.stringify(mappings)) fail("Snapshot source does not match its saved mappings", "snapshot_restore_exception");
          insert.run(name, doc.id, encoded, encoded, doc.seq, doc.version, doc.seq, doc.version, doc.routing);
        }
      }
      if (options.include_global_state) for (const template of data.templates!) { const { name, ...body } = record(template, "snapshot template"); if (typeof name !== "string" || !name || name.length > 255) fail("Invalid snapshot template name"); this.templateRequest("PUT", name, body); }
      if (options.include_global_state) for (const item of data.pipelines ?? []) { keys(record(item, "snapshot pipeline"), ["name", "pipeline"], "snapshot pipeline"); this.ingest.request("PUT", ["_ingest", "pipeline", pipelineName(item.name)], item.pipeline, new URLSearchParams()); }
      if (options.include_global_state) for (const item of data.searchPipelines ?? []) { keys(record(item, "snapshot search pipeline"), ["name", "pipeline"], "snapshot search pipeline"); this.searchPipelines.request("PUT", pipelineName(item.name), item.pipeline); }
      if (job) this.finishSnapshot({ ...job, state: "SUCCESS", restored: names, ended: this.now() });
    });
    this.contexts.clear(); return names;
  }
  private validateCollectionIndex(mappings: Json, settings: Json): void {
    if (this.runtime.refreshIntervalMs !== undefined && Object.keys(settings).some(key => key.startsWith("search.slowlog.") || key.startsWith("indexing.slowlog."))) fail("Slow log settings are supported only on managed domains");
    if (this.runtime.refreshIntervalMs !== undefined && (settings.default_pipeline || settings.final_pipeline)) fail("Ingest pipelines are supported only on managed domains");
    if (this.runtime.refreshIntervalMs !== undefined && settings["search.default_pipeline"]) fail("Search pipelines are supported only on managed domains");
    const vector = (value: any): boolean => value && typeof value === "object" && (value.type === "knn_vector" || Object.values(value).some(vector));
    if (this.runtime.allowVectors === false && (settings.knn === "true" || vector(mappings))) fail("k-NN indexes require a VECTORSEARCH collection");
  }
  metrics(): { searchable: number; deleted: number; indexes: number; documentBytes: number } {
    this.refreshDue();
    const row = this.db.prepare("SELECT sum(CASE WHEN visible IS NOT NULL THEN 1 ELSE 0 END) AS searchable, sum(CASE WHEN source IS NULL THEN 1 ELSE 0 END) AS deleted, coalesce(sum(length(CAST(source AS BLOB))),0) AS bytes FROM documents").get()!;
    return { searchable: Number(row.searchable ?? 0), deleted: Number(row.deleted ?? 0), indexes: this.indexes().length, documentBytes: Number(row.bytes) };
  }
  expireDocuments(cutoff: (index: string) => number): number {
    let removed = 0;
    this.transaction(() => {
      for (const index of this.indexes()) {
        const before = cutoff(index.name); if (!Number.isFinite(before)) continue;
        const kind = `ingestion:${index.name}`;
        const ids = this.db.prepare("SELECT name FROM metadata WHERE kind=? AND json_extract(value,'$.at')<=?").all(kind, before);
        for (const row of ids) { this.db.prepare("DELETE FROM documents WHERE index_name=? AND id=?").run(index.name, row.name); this.remove(kind, String(row.name)); removed++; }
      }
    });
    if (removed) this.contexts.clear(); return removed;
  }
  manageIndex(operation: string, name: string, schema?: Json): Json {
    this.validName(name);
    if (operation === "CreateIndex") { this.createIndex(name, record(schema, "IndexSchema")); return { Status: "CREATED" }; }
    const index = this.index(name);
    if (operation === "GetIndex") return { IndexSchema: { mappings: index.mappings, settings: { index: index.settings }, aliases: index.aliases } };
    if (operation === "DeleteIndex") { this.transaction(() => { this.db.prepare("DELETE FROM documents WHERE index_name=?").run(name); this.db.prepare("DELETE FROM metadata WHERE kind=?").run(`ingestion:${name}`); this.remove("index", name); }); return { Status: "DELETED" }; }
    keys(record(schema, "IndexSchema"), ["mappings", "settings"], "IndexSchema");
    index.mappings = mergeMappings(index.mappings, schema!.mappings ?? {}, new Set(Object.keys(this.analysis(index)))); this.validateIndexAnalysis(index.mappings, index.settings);
    index.settings = indexSettings(schema!.settings, index.settings, false);
    this.validateCollectionIndex(index.mappings, index.settings);
    if (index.settings.knn !== "true" && Object.values<any>(index.mappings.properties ?? {}).some(field => field.type === "knn_vector")) fail("Vector indexes require index.knn=true");
    this.put("index", name, index); return { Status: "UPDATED" };
  }
  /** Ownership is committed with the index, not in a separate control catalog. */
  ownedIndex(operation: "create" | "read" | "update" | "delete" | "retain", name: string, owner: string, schema?: Json): Json {
    return this.transaction(() => {
      let index: Index | undefined = this.get("index", name);
      if (!index && operation === "create") { this.createIndex(name, schema ?? {}); index = this.index(name); index.owner = owner; this.put("index", name, index); }
      if (!index) fail("Index does not exist", "index_not_found_exception", 404);
      if (index.owner !== owner) fail("Index belongs to a different owner or generation", "ownership_conflict", 409);
      if (operation === "update") { this.manageIndex("UpdateIndex", name, schema); index = this.index(name); }
      if (operation === "delete") { this.manageIndex("DeleteIndex", name); return {}; }
      if (operation === "retain") { delete index.owner; this.put("index", name, index); }
      return { uuid: index.uuid, schema: { mappings: index.mappings, settings: { index: index.settings }, aliases: index.aliases } };
    });
  }
  private index(name: string): Index { this.authorizeIndex(name); return this.get("index", name) ?? fail(`no such index [${name}]`, "index_not_found_exception", 404); }
  private validName(name: string): void {
    if (!name || name === "." || name === ".." || name.length > 255 || name !== name.toLowerCase() || /^[_.+\-]/.test(name) || /[\\/*?"<>| ,#:]/.test(name)) fail(`Invalid index name [${name}]`, "invalid_index_name_exception");
  }
  private resolve(pattern = "*", allowMissing = false): Index[] {
    const all = this.indexes(); const found = new Map<string, Index>();
    for (const part of pattern.split(",")) {
      const matching = all.filter(index => wildcard(part === "_all" ? "*" : part, index.name) || Object.keys(index.aliases).some(alias => wildcard(part, alias)));
      if (!matching.length) this.authorizeIndex(part);
      matching.forEach(index => this.authorizeIndex(index.name));
      if (!matching.length && !allowMissing && !part.includes("*") && !part.includes("?")) fail(`no such index [${part}]`, "index_not_found_exception", 404);
      for (const index of matching) found.set(index.name, index);
    }
    return [...found.values()];
  }
  private writeIndex(name: string, auto = true): Index {
    const direct = this.get("index", name); if (direct) { this.authorizeIndex(name); return direct; }
    const aliases = this.indexes().filter(index => Object.hasOwn(index.aliases, name));
    const writable = aliases.filter(index => index.aliases[name].is_write_index === true);
    if (writable.length === 1) { this.authorizeIndex(writable[0].name); return writable[0]; }
    if (aliases.length === 1 && aliases[0].aliases[name].is_write_index !== false) { this.authorizeIndex(aliases[0].name); return aliases[0]; }
    if (aliases.length) fail(`Alias [${name}] does not have a single write index`);
    if (!auto) return this.index(name);
    this.authorizeIndex(name);
    this.createIndex(name, {}); return this.index(name);
  }
  private validateAliases(aliases: Json): void {
    record(aliases, "aliases");
    for (const [name, config] of Object.entries<any>(aliases)) { this.validName(name); keys(record(config, "alias"), ["is_write_index"], "alias"); if (config.is_write_index !== undefined && typeof config.is_write_index !== "boolean") fail("is_write_index must be boolean"); if (this.get("index", name)) fail(`Alias [${name}] conflicts with an index`); }
  }
  createIndex(name: string, body: Json): Json {
    this.authority.getStore()?.access.index(name, "indices:admin/create");
    this.validName(name); keys(record(body, "create index"), ["settings", "mappings", "aliases"], "create index");
    if (this.get("index", name) || this.indexes().some(index => Object.hasOwn(index.aliases, name))) fail(`Index [${name}] already exists`, "resource_already_exists_exception");
    if (this.indexes().length >= 100) fail("The local limit of 100 indexes was reached", "limit_exceeded_exception", 429);
    const templates = this.entries("template").filter(template => template.index_patterns.some((pattern: string) => wildcard(pattern, name))).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const defaults = templates[0]?.template ?? {};
    const settings = indexSettings({ ...defaults.settings, ...body.settings });
    const packageVersions = this.packageVersions(settings), analysis = this.analysis({ name, settings, packageVersions });
    const mappings = mergeMappings(defaults.mappings ?? {}, body.mappings ?? {}, new Set(Object.keys(analysis))); this.validateIndexAnalysis(mappings, settings);
    this.validateCollectionIndex(mappings, settings);
    if (this.runtime.refreshIntervalMs !== undefined) settings.refresh_interval = `${this.runtime.refreshIntervalMs}ms`;
    if (Object.values<any>(mappings.properties ?? {}).some(field => field.type === "knn_vector") && settings.knn !== "true") fail("Vector indexes require index.knn=true");
    const aliases = { ...defaults.aliases, ...body.aliases }; this.validateAliases(aliases);
    for (const [alias, options] of Object.entries<any>(aliases)) if (options.is_write_index && this.indexes().some(index => index.aliases[alias]?.is_write_index)) fail(`Alias [${alias}] has multiple write indexes`);
    this.transaction(() => { const index = { name, mappings, settings, aliases, seq: -1, uuid: randomUUID(), refreshedAt: this.now(), createdAt: this.now(), ...(Object.keys(packageVersions).length ? { packageVersions } : {}) }; this.put("index", name, index); if (this.runtime.refreshIntervalMs === undefined) this.ism.created(index); });
    return { acknowledged: true, shards_acknowledged: true, index: name };
  }
  private deleteIndex(name: string): void {
    this.db.prepare("DELETE FROM documents WHERE index_name=?").run(name);
    this.db.prepare("DELETE FROM metadata WHERE kind=?").run(`ingestion:${name}`);
    this.remove("index", name); this.remove("ism-job", name);
    this.analysisCache.delete(name);
  }
  private rolloverIndex(name: string, access?: SearchAccess): void {
    const index = this.index(name), alias = index.settings["plugins.index_state_management.rollover_alias"], match = /^(.*)-(\d{1,12})$/.exec(name);
    if (!alias || !match || index.aliases[alias]?.is_write_index !== true) fail("ISM rollover requires a numeric index suffix and an explicit write alias matching rollover_alias");
    const target = `${match[1]}-${String(Number(match[2]) + 1).padStart(Math.max(6, match[2].length), "0")}`;
    access?.index(target, "indices:admin/create"); access?.index(target, "indices:admin/aliases");
    index.aliases[alias].is_write_index = false; this.put("index", name, index);
    this.createIndex(target, { mappings: index.mappings, settings: { ...index.settings, "blocks.write": "false" }, aliases: { [alias]: { is_write_index: true } } });
  }
  private writable(index: Index): void { if (index.settings["blocks.write"] === "true") fail(`Index [${index.name}] is read-only`, "cluster_block_exception", 403); }
  private refresh(index: Index): void { this.db.prepare("UPDATE documents SET visible=source, visible_seq=seq, visible_version=version WHERE index_name=?").run(index.name); index.refreshedAt = this.now(); this.put("index", index.name, index); }
  private refreshInterval(index: Index): number { if (this.runtime.refreshIntervalMs !== undefined) return this.runtime.refreshIntervalMs; const value = index.settings.refresh_interval; if (value === "-1") return Infinity; const match = /^(\d+)(ms|s|m)$/.exec(value)!; return Number(match[1]) * (match[2] === "m" ? 60000 : match[2] === "s" ? 1000 : 1); }
  private refreshDue(): void { for (const index of this.indexes()) if (this.now() - index.refreshedAt >= this.refreshInterval(index)) this.transaction(() => this.refresh(index)); }
  private async afterWrite(pattern: string, refresh: string | null): Promise<void> {
    if (refresh === "true" || refresh === "wait_for") {
      const indexes = this.resolve(pattern);
      if (refresh === "wait_for") { const wait = Math.max(...indexes.map(index => this.refreshInterval(index))); if (!Number.isFinite(wait) || wait > 30000) fail("refresh=wait_for exceeds the local 30s request deadline", "timeout_exception", 408); await delay(wait); }
      this.transaction(() => indexes.forEach(index => this.refresh(this.index(index.name))));
    }
  }
  private checkRefresh(pattern: string | undefined, refresh: string | null): void {
    if (refresh !== "wait_for") return;
    const indexes = pattern ? this.resolve(pattern, true) : this.indexes();
    if (indexes.some(index => !Number.isFinite(this.refreshInterval(index)) || this.refreshInterval(index) > 30000)) fail("refresh=wait_for exceeds the local 30s request deadline", "timeout_exception", 408);
  }
  private doc(index: string, id: string): StoredDoc | undefined { return this.db.prepare("SELECT * FROM documents WHERE index_name=? AND id=?").get(index, id) as unknown as StoredDoc | undefined; }
  private write(name: string, id: string, source: Json | null, options: Json = {}): Json {
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 512) fail("Document IDs must contain 1–512 bytes");
    const versionType = options.version_type ?? "internal";
    if (!["internal", "external", "external_gte"].includes(versionType)) fail("version_type must be internal, external or external_gte");
    const suppliedVersion = options.version === undefined ? undefined : integer(options.version, 0, versionType === "internal" ? 1 : 0, Number.MAX_SAFE_INTEGER);
    if (versionType !== "internal" && suppliedVersion === undefined) fail("External versioning requires version");
    if ((suppliedVersion !== undefined || versionType !== "internal") && (options.if_seq_no !== undefined || options.if_primary_term !== undefined)) fail("Versioning cannot be combined with sequence number conditions");
    if (options.op_type === "create" && (suppliedVersion !== undefined || versionType !== "internal")) fail("Create operations do not support explicit versioning");
    for (const key of ["if_seq_no", "if_primary_term"]) if (options[key] !== undefined) integer(options[key], 0, key === "if_primary_term" ? 1 : 0, Number.MAX_SAFE_INTEGER);
    if (options.pipeline !== undefined && options.pipeline !== "_none") pipelineName(options.pipeline);
    if (options.routing !== undefined && typeof options.routing !== "string") fail("routing must be a string");
    return this.transaction(() => {
      const index = this.writeIndex(name, source !== null || versionType !== "internal");
      this.writable(index);
      if (source !== null) {
        const initial = options.pipeline ?? index.settings.default_pipeline, final = index.settings.final_pipeline;
        if (options.skipIngest && [initial, final].some(id => id && id !== "_none")) fail("Updates on indexes with ingest pipelines are not supported; use an index request");
        for (const pipeline of [initial, final]) if (pipeline && pipeline !== "_none") {
          source = this.ingest.run(pipelineName(pipeline), index.name, id, source);
          if (source === null) return { _index: index.name, _id: id, _version: -1, result: "noop", _shards: { total: 0, successful: 0, failed: 0 }, _seq_no: -2, _primary_term: 0 };
        }
      }
      const old = this.doc(index.name, id);
      if (suppliedVersion !== undefined && (versionType === "internal" ? !old?.source || old.version !== suppliedVersion : old !== undefined && (versionType === "external" ? suppliedVersion <= old.version : suppliedVersion < old.version))) fail("version conflict, supplied version does not satisfy the current document version", "version_conflict_engine_exception", 409);
      const version = versionType === "internal" ? (old?.version ?? 0) + 1 : suppliedVersion!;
      if (!Number.isSafeInteger(version)) fail("Document version exceeds the local safe-integer limit", "illegal_argument_exception", 400);
      if (!old && Number(this.db.prepare("SELECT count(*) AS count FROM documents").get()!.count) >= 100000) fail("The local limit of 100000 document records including tombstones was reached", "limit_exceeded_exception", 429);
      if (options.if_seq_no !== undefined || options.if_primary_term !== undefined) {
        if (options.if_seq_no === undefined || options.if_primary_term === undefined) fail("if_seq_no and if_primary_term must be supplied together");
        if (!old?.source || old.seq !== Number(options.if_seq_no) || Number(options.if_primary_term) !== 1) fail("version conflict, required sequence number and primary term do not match", "version_conflict_engine_exception", 409);
      }
      if (options.op_type === "create" && old?.source) fail(`Document [${id}] already exists`, "version_conflict_engine_exception", 409);
      if (source !== null) {
        record(source, "document");
        if (Buffer.byteLength(JSON.stringify(source)) > 1024 * 1024) fail("Document exceeds the local 1 MiB limit", "content_too_long_exception", 413);
        const count = Number(this.db.prepare("SELECT count(*) AS count FROM documents WHERE source IS NOT NULL").get()!.count);
        if (!old?.source && count >= 50000) fail("The local 50000 document limit was reached", "limit_exceeded_exception", 429);
        const bytes = Number(this.db.prepare("SELECT coalesce(sum(length(CAST(source AS BLOB))),0) AS bytes FROM documents").get()!.bytes);
        if (bytes - Buffer.byteLength(old?.source ?? "") + Buffer.byteLength(JSON.stringify(source)) > 64 * 1024 * 1024) fail("The local 64 MiB document storage limit was reached", "limit_exceeded_exception", 429);
        index.mappings = mapDocument(source, index.mappings);
      }
      index.seq++;
      this.db.prepare("INSERT INTO documents(index_name,id,source,seq,version,routing) VALUES(?,?,?,?,?,?) ON CONFLICT(index_name,id) DO UPDATE SET source=excluded.source,seq=excluded.seq,version=excluded.version,routing=excluded.routing").run(index.name, id, source === null ? null : JSON.stringify(source), index.seq, version, options.routing ?? old?.routing ?? null);
      if (this.runtime.ingestionTimestamps) { if (source === null) this.remove(`ingestion:${index.name}`, id); else if (!old?.source) this.put(`ingestion:${index.name}`, id, { at: this.now() }); }
      this.put("index", index.name, index);
      return { _index: index.name, _id: id, _version: version, result: source === null ? old?.source ? "deleted" : "not_found" : old?.source ? "updated" : "created", _shards: { total: 1, successful: 1, failed: 0 }, _seq_no: index.seq, _primary_term: 1 };
    });
  }
  private getDocument(name: string, id: string, options: Json = {}): EngineResponse {
    if (options.realtime === "false") this.refreshDue();
    const index = this.writeIndex(name, false); const doc = this.doc(index.name, id);
    const source = options.realtime === "false" ? doc?.visible : doc?.source;
    if (!source) return response({ _index: index.name, _id: id, found: false }, 404);
    const selection = options._source_includes || options._source_excludes ? { includes: options._source_includes?.split(","), excludes: options._source_excludes?.split(",") } : options._source === "false" ? false : options._source === "true" ? true : options._source;
    const secured = this.securedCandidate({ _index: index.name, _id: id, _source: JSON.parse(source), mappings: index.mappings, analysis: this.analysis(index), _score: 0, _seq_no: doc!.seq, _version: doc!.version, _primary_term: 1 });
    if (!secured) return response({ _index: index.name, _id: id, found: false }, 404);
    const selected = selectSource(secured._source, selection);
    return response({ _index: index.name, _id: id, _version: options.realtime === "false" ? doc!.visible_version : doc!.version, _seq_no: options.realtime === "false" ? doc!.visible_seq : doc!.seq, _primary_term: 1, found: true, ...(selected === undefined ? {} : { _source: selected }) });
  }
  private updateDocument(name: string, id: string, body: Json, options: Json): EngineResponse {
    if (options.version !== undefined || options.version_type !== undefined) fail("Update operations require sequence number conditions instead of explicit versioning");
    keys(record(body, "update"), ["doc", "upsert", "doc_as_upsert", "detect_noop", "_source"], "update");
    if (body.doc !== undefined) record(body.doc, "doc");
    if (body.upsert !== undefined) record(body.upsert, "upsert");
    for (const key of ["doc_as_upsert", "detect_noop"]) if (body[key] !== undefined && typeof body[key] !== "boolean") fail(`${key} must be boolean`);
    selectSource({}, body._source);
    if (body.doc_as_upsert && !body.doc) fail("doc_as_upsert requires a document");
    const index = this.resolve(name, true).length ? this.writeIndex(name, false) : undefined;
    if (index) this.writable(index);
    if ([options.pipeline, index?.settings.default_pipeline, index?.settings.final_pipeline].some(id => id && id !== "_none")) fail("Updates on indexes with ingest pipelines are not supported; use an index request");
    const old = index ? this.doc(index.name, id) : undefined;
    const merge = (target: Json, patch: Json): Json => { const result = { ...target }; for (const [key, value] of Object.entries(patch)) Object.defineProperty(result, key, { value: value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key]) ? merge(result[key], value) : value, enumerable: true, configurable: true, writable: true }); return result; };
    let source: Json;
    if (old?.source) { if (!body.doc) fail("update.doc is required"); source = merge(JSON.parse(old.source), record(body.doc, "doc")); }
    else { if (!body.upsert && !body.doc_as_upsert) fail(`Document [${id}] not found`, "document_missing_exception", 404); source = body.upsert ?? body.doc; }
    if (old?.source === JSON.stringify(source) && body.detect_noop !== false && options.if_seq_no === undefined && options.if_primary_term === undefined) return response({ _index: index!.name, _id: id, _version: old.version, _seq_no: old.seq, _primary_term: 1, result: "noop", _shards: { total: 0, successful: 0, failed: 0 } });
    const result = this.write(name, id, source, { ...options, skipIngest: true });
    if (body._source) result.get = { found: true, _source: selectSource(source, body._source) };
    return response(result, result.result === "created" ? 201 : 200);
  }
  private candidates(pattern: string): Candidate[] {
    this.refreshDue();
    return this.resolve(pattern).flatMap(index => (this.db.prepare("SELECT * FROM documents WHERE index_name=? AND visible IS NOT NULL").all(index.name) as unknown as StoredDoc[]).flatMap(doc => { const secured = this.securedCandidate({ _id: doc.id, _index: index.name, _source: JSON.parse(doc.visible!), _score: 0, _version: doc.visible_version, _seq_no: doc.visible_seq, _primary_term: 1, mappings: index.mappings, analysis: this.analysis(index) }); return secured ? [secured] : []; }));
  }
  /** Internal owner read: security is applied before a document enters the coordinating domain. */
  crossClusterView(pattern: string, access: SearchAccess, prefix: string, budget: SearchReadBudget): SearchReadView {
    if (this.closed || this.storageFailed) fail("Remote search engine is unavailable", "unavailable_shards_exception", 503);
    return this.authority.run({ access, action: "indices:data/read/search" }, () => {
      this.refreshDue();
      const indexes = this.resolve(pattern);
      // Shard discovery is read-only but requires its own explicit FGAC grant.
      this.authority.run({ access, action: "indices:admin/shards/search_shards" }, () => this.resolve(pattern));
      const view: SearchReadView = { indexes: [], docs: [] };
      for (const index of indexes) {
        if (++budget.indexes > 100) fail("Cross-cluster search exceeds 100 resolved indexes", "limit_exceeded_exception", 429);
        if (Object.keys(index.packageVersions ?? {}).length) fail("Dictionary packages are unsupported in cross-cluster search");
        if (index.settings["search.default_pipeline"] && index.settings["search.default_pipeline"] !== "_none") fail("Cross-cluster search does not support default search pipelines");
        const selected = { ...this.readableIndex(index), name: prefix + index.name, analysis: this.analysis(index) };
        budget.bytes += Buffer.byteLength(JSON.stringify(selected)); view.indexes.push(selected);
        for (const row of this.db.prepare("SELECT * FROM documents WHERE index_name=? AND visible IS NOT NULL").iterate(index.name)) {
          if (performance.now() > budget.deadline) fail("Cross-cluster read exceeded its deadline", "timeout_exception", 408);
          const doc = row as unknown as StoredDoc;
          if (++budget.documents > 50000 || (budget.bytes += Buffer.byteLength(doc.visible!)) > 64 * 1024 * 1024) fail("Cross-cluster reads exceed 50000 documents or 64 MiB", "limit_exceeded_exception", 429);
          const secured = this.securedCandidate({ _id: doc.id, _index: index.name, _source: JSON.parse(doc.visible!), _score: 0, _version: doc.visible_version, _seq_no: doc.visible_seq, _primary_term: 1, mappings: index.mappings, analysis: selected.analysis });
          if (secured) view.docs.push({ ...secured, _index: prefix + index.name });
        }
        if (budget.bytes > 64 * 1024 * 1024) fail("Cross-cluster reads exceed 64 MiB", "limit_exceeded_exception", 429);
      }
      return view;
    });
  }
  crossClusterSearch(body: Json, query: URLSearchParams, view: SearchReadView, deadline: number): EngineResponse {
    if (body.pit !== undefined || query.has("scroll") || body.search_pipeline !== undefined || query.has("search_pipeline") || body.query?.hybrid !== undefined) fail("Cross-cluster PIT, scroll, hybrid and search pipelines are unsupported");
    const allowed = ["pretty", "size", "from", "sort", "_source", "_source_includes", "_source_excludes"];
    for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) fail(`Unsupported or repeated cross-cluster parameter [${key}]`);
    if (query.has("pretty") && !["true", "false", ""].includes(query.get("pretty")!)) fail("pretty must be boolean");
    return response(this.search("", body, query, "cross-cluster", deadline, view));
  }
  /** Control-plane metadata owner; caller must hold comparison permission on both domains. */
  configurationMetadata(category: ComparisonCategory, budget = { bytes: 0 }): Record<string, Json> {
    if (this.closed || this.storageFailed) fail("Domain metadata is unavailable", "unavailable_shards_exception", 503);
    const storageKind = { aliases: 'index', templates: 'template', ingest_pipelines: 'ingest-pipeline', ism_policies: 'ism-policy', security_roles: 'security', security_role_mappings: 'security', security_internal_users: 'security' }[category];
    budget.bytes += Number(this.db.prepare("SELECT coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM metadata WHERE kind=?").get(storageKind)!.bytes);
    if (budget.bytes > 64 * 1024 * 1024) fail("Comparison metadata exceeds 64 MiB", "limit_exceeded_exception", 429);
    if (category === 'aliases') {
      const aliases: Record<string, Json> = Object.create(null);
      for (const index of this.indexes()) for (const [name, definition] of Object.entries(index.aliases)) (aliases[name] ??= { indexes: {} }).indexes[index.name] = definition;
      return aliases;
    }
    if (category === 'templates') return Object.fromEntries(this.entries('template').map(({ name, ...definition }) => [name, definition]));
    if (category === 'ingest_pipelines') return Object.fromEntries(this.entries('ingest-pipeline').map(item => [item.name, item.pipeline]));
    if (category === 'ism_policies') return Object.fromEntries(this.entries('ism-policy').map(item => { const { last_updated_time, ...policy } = item.policy; return [item.name, { policy }]; }));
    const kind = { security_roles: 'role', security_role_mappings: 'mapping', security_internal_users: 'user' }[category];
    return Object.fromEntries(this.entries('security').filter(item => item.kind === kind).map(({ name, kind: _kind, verifier, ...definition }) => [name, { ...definition, ...(verifier ? { hash: `${verifier.salt}:${verifier.hash}` } : {}) }]));
  }
  private ttl(value: any): number { const match = /^(\d+)(ms|s|m)$/.exec(String(value ?? "1m")); if (!match) return fail("Invalid keep_alive"); const duration = Number(match[1]) * (match[2] === "m" ? 60000 : match[2] === "s" ? 1000 : 1); if (duration < 1 || duration > 300000) fail("keep_alive must be between 1ms and 5m"); return duration; }
  private context(id: string, principal: string, kind: "pit" | "scroll" | "sql") { const value = this.contexts.get(id); if (!value || value.principal !== principal || value.kind !== kind || value.expires <= this.now()) fail("Search context is missing or expired", "search_context_missing_exception", 404); return value; }
  private saveContext(docs: Candidate[], principal: string, kind: "pit" | "scroll" | "sql", keepAlive: any, size = 10, page?: Json): string {
    for (const [id, value] of this.contexts) if (value.expires <= this.now()) this.contexts.delete(id);
    if (this.contexts.size >= 20) fail("The local limit of 20 search contexts was reached", "limit_exceeded_exception", 429);
    const bytes = Buffer.byteLength(JSON.stringify(page ?? docs));
    if (bytes + [...this.contexts.values()].reduce((sum, value) => sum + value.bytes, 0) > capabilities.limits.searchContextBytesPerDomain) fail("Search contexts exceed the local 64 MiB memory budget", "limit_exceeded_exception", 429);
    const id = randomUUID(); this.contexts.set(id, { docs: structuredClone(docs), ...(page ? { page: structuredClone(page) } : {}), principal, expires: this.now() + this.ttl(keepAlive), offset: size, size, bytes, kind }); return id;
  }
  private search(pattern: string, body: Json, query: URLSearchParams, principal: string, requestDeadline = performance.now() + 30000, view?: SearchReadView): Json {
    const started = performance.now();
    const resolve = () => view?.indexes ?? this.resolve(pattern);
    const analyses = () => view ? new Set(view.indexes.length ? Object.keys(view.indexes[0].analysis).filter(name => view.indexes.every(index => Object.hasOwn(index.analysis, name))) : []) : this.analysisNames(pattern);
    keys(record(body, "search"), ["query", "from", "size", "sort", "_source", "track_total_hits", "aggs", "aggregations", "post_filter", "search_after", "pit", "version", "seq_no_primary_term", "fields", "highlight", "timeout", "track_scores", "search_pipeline"], "search");
    if (body.fields !== undefined && (!Array.isArray(body.fields) || body.fields.some((field: any) => typeof field !== "string"))) fail("fields must be an array of field names");
    for (const key of ["version", "seq_no_primary_term", "track_scores"]) if (body[key] !== undefined && typeof body[key] !== "boolean") fail(`${key} must be boolean`);
    if (body.pit !== undefined) { keys(record(body.pit, "pit"), ["id", "keep_alive"], "pit"); if (typeof body.pit.id !== "string") fail("pit.id must be a string"); }
    if (body.aggs !== undefined && body.aggregations !== undefined) fail("Specify either aggs or aggregations");
    if (query.has("q")) fail("Lucene query-string syntax is not implemented; use a JSON query");
    const deadline = Math.min(requestDeadline, performance.now() + (body.timeout === undefined ? 30000 : this.ttl(body.timeout)));
    const checkDeadline = () => { if (performance.now() > deadline) fail("Query exceeded its local deadline", "timeout_exception", 408); };
    if (body.highlight) {
      keys(record(body.highlight, "highlight"), ["fields", "pre_tags", "post_tags"], "highlight");
      for (const options of Object.values(record(body.highlight.fields, "highlight.fields"))) keys(record(options, "highlight field"), [], "highlight field");
      if ((body.highlight.pre_tags && (!Array.isArray(body.highlight.pre_tags) || body.highlight.pre_tags.length !== 1)) || (body.highlight.post_tags && (!Array.isArray(body.highlight.post_tags) || body.highlight.post_tags.length !== 1))) fail("Highlight requires one pre/post tag");
    }
    const hybrid = body.query?.hybrid !== undefined;
    if (hybrid) {
      keys(record(body.query, "query"), ["hybrid"], "query");
      if (body.pit || query.has("scroll") || body.search_after) fail("Hybrid queries with PIT, scroll or search_after are unsupported");
      const sort = body.sort ?? (query.has("sort") ? query.get("sort") : undefined);
      if (sort !== undefined && !["_score", "_score:desc", '[{"_score":"desc"}]', '{"_score":"desc"}', '["_score"]'].includes(typeof sort === "string" ? sort : JSON.stringify(sort))) fail("Hybrid search supports descending score order only");
    }
    if (query.has("search_pipeline") && body.search_pipeline !== undefined) fail("Specify search_pipeline in the body or URL, not both");
    let pipelineInput = body.search_pipeline !== undefined ? body.search_pipeline : query.get("search_pipeline") ?? undefined;
    if (pipelineInput === undefined && !body.pit) { const defaults = new Set(resolve().map(index => index.settings["search.default_pipeline"] ?? "_none")); if (defaults.size > 1) fail("Selected indexes have different default search pipelines; specify one explicitly"); pipelineInput = defaults.values().next().value; }
    if (this.runtime.refreshIntervalMs !== undefined && (hybrid || pipelineInput !== undefined && pipelineInput !== "_none")) fail("Hybrid search and search pipelines are supported only on managed domains");
    const pit = body.pit ? this.context(String(body.pit.id), principal, "pit") : undefined;
    const pitAnalyses = pit?.docs.map(doc => doc.analysis ?? {}), analyzerNames = pitAnalyses ? new Set(pitAnalyses.length ? Object.keys(pitAnalyses[0]).filter(name => pitAnalyses.every(analysis => Object.hasOwn(analysis, name))) : []) : analyses();
    const pipeline = this.searchPipelines.resolve(pipelineInput), predicate = hybrid ? undefined : compileQuery(body.query, 0, { clauses: 0, analyzerNames });
    if (body.query?.knn) {
      if (body.pit || query.has("scroll")) fail("Vector queries with PIT or scroll are not implemented");
      for (const index of resolve()) {
        if (index.settings.knn !== "true") fail("k-NN search requires index.knn=true");
        predicate!({ _id: "", _index: index.name, _source: {}, _score: 0, _seq_no: 0, _primary_term: 1, _version: 0, mappings: index.mappings });
      }
    }
    if (body._source === undefined) {
      if (query.has("_source_includes") || query.has("_source_excludes")) body._source = { includes: query.get("_source_includes")?.split(","), excludes: query.get("_source_excludes")?.split(",") };
      else if (query.has("_source")) body._source = query.get("_source") === "false" ? false : query.get("_source") === "true" ? true : query.get("_source")!.split(",");
    }
    selectSource({}, body._source);
    const from = integer(body.from !== undefined ? body.from : query.get("from") ?? undefined, 0); const size = integer(body.size !== undefined ? body.size : query.get("size") ?? undefined, 10);
    const window = body.pit ? 10000 : Math.min(10000, ...resolve().map(index => Number(index.settings.max_result_window)));
    if (from + size > window) fail(`Result window exceeds ${window}; use search_after`);
    const executeHybrid = hybrid ? prepareHybrid(body.query.hybrid, pipeline, resolve().map(index => view ? index : this.readableIndex(index)), size, from, deadline, analyses()) : undefined;
    let docs = body.pit ? this.context(String(body.pit.id), principal, "pit").docs : view?.docs ?? this.candidates(pattern), hybridMatches: Candidate[] | undefined;
    if (body.pit?.keep_alive) this.context(String(body.pit.id), principal, "pit").expires = this.now() + this.ttl(body.pit.keep_alive);
    if (executeHybrid) { const result = executeHybrid(docs); docs = result.ranked; hybridMatches = result.matched; }
    else docs = docs.flatMap(doc => { if (performance.now() > deadline) fail("Query exceeded its local deadline", "timeout_exception", 408); const score = predicate!(doc); return score === null ? [] : [{ ...doc, _score: score }]; });
    if (body.query?.knn) docs = docs.sort((a, b) => b._score - a._score || a._index.localeCompare(b._index) || a._id.localeCompare(b._id)).slice(0, Number(Object.values<any>(body.query.knn)[0].k));
    const schemas = body.pit ? [...new Map(this.context(String(body.pit.id), principal, "pit").docs.map(doc => [doc._index, doc.mappings])).values()] : resolve().map(index => (view ? index : this.readableIndex(index)).mappings);
    const aggregations = aggregate(body.aggs ?? body.aggregations, hybridMatches ?? docs, 0, schemas, { buckets: 0, deadline });
    if (body.post_filter) { const filter = compileQuery(body.post_filter, 0, { clauses: 0, analyzerNames }); docs = docs.filter(doc => filter(doc) !== null); if (hybridMatches) hybridMatches = hybridMatches.filter(doc => filter(doc) !== null); }
    const total = hybridMatches?.length ?? docs.length;
    const sortInput = body.sort ?? (query.has("sort") ? query.get("sort")!.split(",").map(value => { const [field, order = "asc"] = value.split(":"); return { [field]: order }; }) : undefined);
    const sort = (sortInput === undefined ? [{ _score: "desc" }] : Array.isArray(sortInput) ? sortInput : [sortInput]).map((value: any) => {
      if (typeof value !== "string" && Object.keys(record(value, "sort")).length !== 1) fail("Each sort entry requires exactly one field");
      const field = typeof value === "string" ? value : Object.keys(record(value, "sort"))[0]; const raw = typeof value === "string" ? field === "_score" ? "desc" : "asc" : value[field]; const options = typeof raw === "string" ? { order: raw } : record(raw, "sort options");
      keys(options, ["order", "missing", "unmapped_type", "mode"], "sort"); if (options.mode && !["min", "max"].includes(options.mode)) fail("Only min/max multi-value sorting is implemented"); if (options.order && !["asc", "desc"].includes(options.order)) fail("Invalid sort order"); return { field, ...options, order: options.order ?? "asc" };
    });
    const sortValues = (doc: Candidate) => sort.map((item: Json) => {
      if (item.field === "_score") return doc._score; if (item.field === "_id" || item.field === "_doc" || item.field === "_shard_doc") return doc._id;
      const found = fieldValues(doc._source, item.field, doc.mappings).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      return found.length ? found[item.mode === "max" || !item.mode && item.order === "desc" ? found.length - 1 : 0] : item.missing && !["_first", "_last"].includes(item.missing) ? item.missing : null;
    });
    const compare = (a: any[], b: any[]) => { checkDeadline(); for (let i = 0; i < sort.length; i++) { const item: Json = sort[i]; const missing = item.missing === "_first" ? -1 : 1; const order = a[i] === b[i] ? 0 : a[i] === null ? missing : b[i] === null ? -missing : (a[i] < b[i] ? -1 : 1) * (item.order === "desc" ? -1 : 1); if (order) return order; } return 0; };
    docs.sort((a, b) => compare(sortValues(a), sortValues(b)) || a._index.localeCompare(b._index) || a._id.localeCompare(b._id));
    if (body.search_after) { if (!sortInput || !Array.isArray(body.search_after) || body.search_after.length !== sort.length || from) fail("search_after requires matching sort values and from=0"); docs = docs.filter(doc => compare(sortValues(doc), body.search_after) > 0); }
    const hit = (doc: Candidate) => {
      checkDeadline();
      const source = selectSource(doc._source, body._source ?? (query.get("_source") === "false" ? false : query.has("_source_includes") || query.has("_source_excludes") ? { includes: query.get("_source_includes")?.split(","), excludes: query.get("_source_excludes")?.split(",") } : undefined));
      const result: Json = { _index: doc._index, _id: doc._id, _score: doc._score, ...(source === undefined ? {} : { _source: source }), ...(sortInput ? { sort: sortValues(doc) } : {}), ...(body.version ? { _version: doc._version } : {}), ...(body.seq_no_primary_term ? { _seq_no: doc._seq_no, _primary_term: 1 } : {}) };
      if (body.fields) { if (!Array.isArray(body.fields) || body.fields.some((field: any) => typeof field !== "string")) fail("fields must be an array of field names"); result.fields = Object.fromEntries(body.fields.map((field: string) => [field, fieldValues(doc._source, field, doc.mappings)])); }
      if (body.highlight) {
        const terms: string[] = [];
        const extract = (value: any, underMatch = false): void => {
          if (typeof value === "string" && underMatch) terms.push(...analyze(value));
          else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { if (["match", "match_phrase", "multi_match"].includes(key)) extract(child, true); else if (!["fields", "operator", "analyzer"].includes(key)) extract(child, underMatch); }
        };
        extract(body.query);
        const pre = body.highlight.pre_tags?.[0] ?? "<em>", post = body.highlight.post_tags?.[0] ?? "</em>";
        result.highlight = {};
        for (const field of Object.keys(body.highlight.fields)) {
          const snippets = fieldValues(doc._source, field, doc.mappings).filter(value => typeof value === "string" && analyze(value).some(token => terms.includes(token))).map(value => value.replace(/[\p{L}\p{N}]+/gu, (token: string) => terms.includes(token.toLowerCase()) ? `${pre}${token}${post}` : token));
          if (snippets.length) result.highlight[field] = snippets;
        }
      }
      return result;
    };
    const limit = body.track_total_hits === true ? Infinity : body.track_total_hits === false ? -1 : integer(body.track_total_hits, 10000, 0, 50000);
    const result: Json = { took: Math.floor(performance.now() - started), timed_out: false, _shards: SHARDS, hits: { ...(limit < 0 ? {} : { total: { value: Math.min(total, limit), relation: total > limit ? "gte" : "eq" } }), max_score: docs.length ? docs.reduce((score, doc) => Math.max(score, doc._score), 0) : null, hits: docs.slice(from, from + size).map(hit) } };
    if (body.aggs || body.aggregations) result.aggregations = aggregations;
    if (query.has("scroll")) {
      if (from || body.search_after || body.pit || !size) fail("scroll requires size > 0 and cannot be combined with from, search_after, or PIT");
      // Preserve the original projection, sort values and hit-count policy on
      // every page. Never expose raw stored candidates on subsequent requests.
      result._scroll_id = this.saveContext([], principal, "scroll", query.get("scroll"), size, { ...result.hits, hits: docs.map(hit) });
    }
    return result;
  }
  async request(method: string, path: string, raw: Buffer, principal: string, allowExplicitIndex = true, access?: SearchAccess, observe?: (event: SearchObservation) => void): Promise<EngineResponse> {
    const execute = () => access ? this.authority.run({ access, action: "indices:data/read/search" }, () => this.dispatch(method, path, raw, `${principal}:${access.fingerprint}`, allowExplicitIndex, principal)) : this.dispatch(method, path, raw, principal, allowExplicitIndex, principal);
    if (!observe) return execute();
    const indexes = new Set<string>(), started = performance.now();
    return this.trace.run(indexes, async () => {
      try { return await execute(); }
      finally { try { observe({ durationMs: Math.max(0, performance.now() - started), indexes: [...indexes].flatMap(name => { const index = this.get("index", name); return index ? [{ name, settings: index.settings }] : []; }) }); } catch { /* Observation must not change search results or acknowledgment. */ } }
    });
  }
  private async dispatch(method: string, path: string, raw: Buffer, principal: string, allowExplicitIndex: boolean, workspacePrincipal: string): Promise<EngineResponse> {
    if (this.closed || this.storageFailed) fail("Search engine is stopped or storage requires recovery", "unavailable_shards_exception", 503);
    if (raw.length > capabilities.limits.requestBytes) fail("Request exceeds the local 10 MiB limit", "content_too_long_exception", 413);
    const requestDeadline = performance.now() + 30000;
    const url = new URL(path, "https://localhost");
    if (/[\\]|%2f|%5c|%00|%25|\/\.|\/\//i.test(url.pathname) || path.split("?")[0] !== url.pathname) fail("Ambiguous request path");
    let parts: string[]; try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { return fail("Invalid URI encoding"); }
    if (url.pathname === "/_stacksim/workspace") {
      if (url.search) fail("Workspace query parameters are unsupported");
      if (!workspacePrincipal || ["*", "anonymous"].includes(workspacePrincipal)) fail("Workspace state requires an authenticated identity", "security_exception", 401);
      let body; try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { fail("Invalid workspace JSON", "parse_exception"); }
      return response(this.workspace(method, record(body, "workspace"), workspacePrincipal));
    }
    if (parts[0] === "_search" && parts[1] === "pipeline") {
      if (this.runtime.refreshIntervalMs !== undefined) fail("Search pipelines are supported only on managed domains");
      if (parts.length > 3 || url.search) fail("Unsupported search pipeline path or query parameter");
      this.authority.getStore()?.access.cluster(`cluster:admin/search/pipeline/${method.toLowerCase()}`);
      let body; try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { fail("Invalid search pipeline JSON", "parse_exception"); }
      return response(this.transaction(() => this.searchPipelines.request(method, parts[2], record(body, "search pipeline request"))));
    }
    if (parts[0] === "_plugins" && parts[1] === "_ism") {
      if (this.runtime.refreshIntervalMs !== undefined) fail("ISM is supported only on managed domains");
      let body; try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { fail("Invalid ISM JSON", "parse_exception"); }
      return this.transaction(() => this.ism.request(method, parts.slice(2), record(body, "ISM request"), url.searchParams, this.authority.getStore()?.access));
    }
    if (parts[0] === "_plugins" && ["_sql", "_ppl"].includes(parts[1])) {
      if (this.runtime.refreshIntervalMs !== undefined) fail("SQL/PPL is supported only on managed domains");
      if (!allowExplicitIndex) fail("SQL/PPL requires explicit index names in request bodies to be enabled");
      if (!["POST", "GET"].includes(method) || parts.length > 3 || parts[2] && !["_explain", "close"].includes(parts[2])) fail("Unsupported SQL/PPL API path or method");
      for (const key of url.searchParams.keys()) if (key !== "format" || url.searchParams.getAll(key).length > 1 || url.searchParams.get(key) !== "jdbc") fail("SQL/PPL supports only the JDBC response format");
      let input; try { input = JSON.parse(raw.toString("utf8")); } catch { fail("Invalid SQL/PPL JSON", "parse_exception"); }
      const body = record(input, "SQL/PPL request"), language = parts[1] === "_sql" ? "sql" : "ppl";
      if (body.cursor !== undefined || parts[2] === "close") {
        keys(body, ["cursor"], "SQL cursor request");
        if (language !== "sql" || parts[2] === "_explain" || typeof body.cursor !== "string") fail("SQL cursor is required");
        const cursor = this.context(body.cursor, principal, "sql");
        // Fresh IAM/resource policies run at the gateway. The principal includes
        // the current FGAC fingerprint, so a role change invalidates the cursor.
        for (const index of cursor.page!.indexes) this.authorizeIndex(index);
        if (parts[2] === "close") { this.contexts.delete(body.cursor); return response({ succeeded: true }); }
        const datarows = cursor.page!.datarows.slice(cursor.offset, cursor.offset + cursor.size); cursor.offset += cursor.size;
        const more = cursor.offset < cursor.page!.datarows.length;
        if (!more) this.contexts.delete(body.cursor);
        return response({ datarows, ...(more ? { cursor: body.cursor } : {}) });
      }
      keys(body, ["query", "filter", "fetch_size"], "SQL/PPL request");
      if (body.fetch_size !== undefined && (language !== "sql" || parts[2])) fail("fetch_size is supported only for SQL query requests");
      const fetchSize = integer(body.fetch_size, 0, 0, 10000), plan = parseLanguage(language, body.query), indexes = this.resolve(plan.source);
      const result = executeLanguage(plan, indexes.map(index => this.readableIndex(index).mappings), () => parts[2] ? [] : this.candidates(plan.source), body.filter, requestDeadline);
      if (parts[2] === "_explain") return response({ root: { name: "StackSimQueryPlan", description: { language, source: plan.source, stages: plan.stages, ...(body.filter ? { filter: body.filter } : {}) }, children: [{ name: "StackSimIndexScan", description: { indexes: indexes.map(index => index.name), authorization: "Current index, document and field permissions" }, children: [] }] } });
      if (fetchSize && result.datarows.length > fetchSize) { result.cursor = this.saveContext([], principal, "sql", "5m", fetchSize, { datarows: result.datarows, indexes: indexes.map(index => index.name) }); result.datarows = result.datarows.slice(0, fetchSize); result.size = result.datarows.length; }
      return response(result);
    }
    if (parts[0] === "_plugins" && parts[1] === "_security") {
      const access = this.authority.getStore()?.access;
      if (!access) fail("Fine-grained security is not enabled", "security_exception", 403);
      let body; try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { fail("Invalid security JSON", "parse_exception"); }
      if (url.search) fail("Security API query parameters are unsupported");
      return response(this.transaction(() => this.security.request(method, url.pathname, parts[3] === "audit" && method === "PATCH" ? body : record(body, "security request"), access)));
    }
    if (parts[0] === "_ingest") {
      if (this.runtime.refreshIntervalMs !== undefined) fail("Ingest pipelines are supported only on managed domains");
      if (parts[1] !== "pipeline" || parts.length > 4 || parts.length === 4 && parts[3] !== "_simulate") fail("Unsupported ingest API path");
      const operation = parts.at(-1) === "_simulate" ? "simulate" : method.toLowerCase();
      this.authority.getStore()?.access.cluster(`cluster:admin/ingest/pipeline/${operation}`);
      let body; try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { fail("Invalid ingest JSON", "parse_exception"); }
      return response(this.transaction(() => this.ingest.request(method, parts, record(body, "ingest request"), url.searchParams)));
    }
    if (parts.some(part => part.startsWith("."))) fail("System indexes are not available", "security_exception", 403);
    // Do not authorize a longer path and then execute a shorter, different resource.
    const isGlobal = parts[0]?.startsWith("_");
    const routeAction = isGlobal ? parts[0] : parts[1];
    const context = this.authority.getStore();
    if (context) {
      const reading = method === "GET" || method === "HEAD";
      const actions: Json = { _search: "indices:data/read/search", _msearch: "indices:data/read/msearch", _count: "indices:data/read/count", _mget: "indices:data/read/mget", _explain: "indices:data/read/explain", _validate: "indices:data/read/validate/query", _doc: reading ? "indices:data/read/get" : method === "DELETE" ? "indices:data/write/delete" : "indices:data/write/index", _source: "indices:data/read/get", _create: "indices:data/write/index", _update: "indices:data/write/update", _bulk: "indices:data/write/bulk", _mapping: reading ? "indices:admin/mappings/get" : "indices:admin/mapping/put", _settings: reading ? "indices:admin/settings/get" : "indices:admin/settings/update", _field_caps: "indices:data/read/field_caps", _refresh: "indices:admin/refresh", _alias: reading ? "indices:admin/aliases/get" : "indices:admin/aliases", _aliases: reading ? "indices:admin/aliases/get" : "indices:admin/aliases", _analyze: "indices:admin/analyze", _cat: "indices:data/read/search" };
      context.action = actions[routeAction] ?? (reading ? "indices:admin/get" : method === "DELETE" ? "indices:admin/delete" : "indices:admin/create");
      if (routeAction === "_cat" && this.runtime.catIndexAction) context.action = this.runtime.catIndexAction;
      if (!parts.length) context.access.cluster("cluster:monitor/main");
      if (routeAction === "_cluster") context.access.cluster("cluster:monitor/health");
      if (routeAction === "_index_template") context.access.cluster(`cluster:admin/index_template/${reading ? "get" : method.toLowerCase()}`);
      if (routeAction === "_analyze" && isGlobal) context.access.cluster("cluster:admin/analyze");
    }
    const suffix = parts.slice(isGlobal ? 1 : 2);
    let validPath = !parts.length || !routeAction;
    if (["_doc", "_create", "_update", "_source", "_explain"].includes(routeAction)) validPath = !isGlobal && (suffix.length === 1 || routeAction === "_doc" && suffix.length === 0 && method === "POST");
    else if (routeAction === "_search") validPath = suffix.length === 0 || suffix.length === 1 && (suffix[0] === "point_in_time" || isGlobal && suffix[0] === "scroll");
    else if (routeAction === "_validate") validPath = suffix.length === 1 && suffix[0] === "query";
    else if (routeAction === "_cluster") validPath = isGlobal && suffix.length === 1 && suffix[0] === "health";
    else if (routeAction === "_cat") validPath = isGlobal && (suffix.length === 1 || suffix.length === 2) && suffix[0] === "indices";
    else if (routeAction === "_index_template") validPath = isGlobal && suffix.length <= 1;
    else if (["_alias", "_aliases"].includes(routeAction)) validPath = suffix.length <= 1;
    else if (["_bulk", "_msearch", "_count", "_refresh", "_analyze", "_mget", "_mapping", "_settings", "_field_caps"].includes(routeAction)) validPath = suffix.length === 0;
    if (!validPath) fail(`Unsupported request path [${url.pathname}]`, "unsupported_operation_exception");
    const query = url.searchParams;
    const parse = () => { let parsed; try { parsed = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { return fail("Failed to parse JSON request", "parse_exception"); } return record(parsed, "request body"); };
    const param = Object.fromEntries(query);
    const allowedParams = ["pretty"];
    const sourceParams = ["_source", "_source_includes", "_source_excludes"];
    if (["_doc", "_create", "_update", "_source"].includes(routeAction)) {
      allowedParams.push("routing");
      if (["_doc", "_create"].includes(routeAction) && !["GET", "HEAD"].includes(method)) allowedParams.push("version", "version_type");
      if (method === "GET" || method === "HEAD") allowedParams.push("realtime", ...sourceParams);
      else { if (["_doc", "_create"].includes(routeAction) && ["PUT", "POST"].includes(method)) allowedParams.push("pipeline"); allowedParams.push("refresh", "if_seq_no", "if_primary_term"); if (routeAction === "_doc") allowedParams.push("op_type"); }
    }
    if (["_search", "_msearch"].includes(routeAction) && !suffix.length) allowedParams.push("size", "from", "sort", "scroll", "routing", "search_pipeline", ...sourceParams);
    if (routeAction === "_search" && suffix[0] === "point_in_time") allowedParams.push("keep_alive");
    if (routeAction === "_bulk") allowedParams.push("refresh", "routing", "pipeline");
    if (routeAction === "_mget") allowedParams.push("realtime", ...sourceParams);
    if (routeAction === "_field_caps") allowedParams.push("fields");
    if (routeAction === "_cat") allowedParams.push("format");
    for (const key of query.keys()) { if (!allowedParams.includes(key)) fail(`Query parameter [${key}] is not implemented`); if (query.getAll(key).length !== 1) fail(`Repeated query parameter [${key}]`); }
    if (query.has("pipeline") && query.get("pipeline") !== "_none") pipelineName(query.get("pipeline"));
    if (query.has("refresh") && !["true", "false", "wait_for"].includes(query.get("refresh")!)) fail("refresh must be true, false, or wait_for");
    for (const key of ["realtime", "pretty"]) if (query.has(key) && !["true", "false", ""].includes(query.get(key)!)) fail(`${key} must be true or false`);
    if (query.has("if_seq_no") !== query.has("if_primary_term")) fail("if_seq_no and if_primary_term must be supplied together");
    for (const key of ["if_seq_no", "if_primary_term"]) if (query.has(key)) integer(query.get(key), 0, key === "if_primary_term" ? 1 : 0, Number.MAX_SAFE_INTEGER);
    if (query.has("op_type") && !["create", "index"].includes(query.get("op_type")!)) fail("op_type must be create or index");
    if (query.has("format") && !["json", "text"].includes(query.get("format")!)) fail("Only json and text output formats are implemented");
    if (!parts.length && (method === "GET" || method === "HEAD")) return response({ name: "stacksim", cluster_name: "stacksim-embedded", cluster_uuid: "local", version: { distribution: "opensearch", number: "2.19.3", build_type: "stacksim-embedded", build_hash: "local", build_date: "2026-11-16T00:00:00Z", build_snapshot: false, lucene_version: "not-used", minimum_wire_compatibility_version: "7.10.0", minimum_index_compatibility_version: "7.0.0" }, tagline: "StackSim embedded OpenSearch-compatible emulator" });
    if (parts[0] === "_cluster" && parts[1] === "health" && method === "GET") return response({ cluster_name: "stacksim-embedded", status: "green", timed_out: false, number_of_nodes: 1, number_of_data_nodes: 1, active_primary_shards: this.indexes().length, active_shards: this.indexes().length, relocating_shards: 0, initializing_shards: 0, unassigned_shards: 0, number_of_pending_tasks: 0, active_shards_percent_as_number: 100 });
    if (parts[0] === "_cat" && parts[1] === "indices" && method === "GET") {
      const rows = this.resolve(parts[2] ?? "*").map(index => ({ health: "green", status: "open", index: index.name, uuid: index.name, pri: "1", rep: "0", "docs.count": String(this.candidates(index.name).length), ...(this.authority.getStore() && !this.authority.getStore()!.access.unrestrictedMetadata(index.name, this.authority.getStore()!.action) ? {} : { "docs.deleted": String(this.db.prepare("SELECT count(*) AS count FROM documents WHERE index_name=? AND source IS NULL").get(index.name)!.count) }) }));
      return query.get("format") === "json" ? response(rows) : { status: 200, body: rows.map(row => Object.values(row).join(" ")).join("\n") + "\n", contentType: "text/plain" };
    }
    if (parts[0] === "_index_template") return this.templateRequest(method, parts[1], parse());
    if (parts[0] === "_aliases" && method === "POST") { if (parts.length !== 1) fail("Alias actions require /_aliases"); return this.aliasRequest(parse()); }
    if (parts[0] === "_search" && parts[1] === "scroll") {
      const body = parse(); keys(body, ["scroll_id", "scroll"], "scroll");
      if (method === "DELETE") { const ids = Array.isArray(body.scroll_id) ? body.scroll_id : [body.scroll_id]; ids.forEach((id: string) => this.context(id, principal, "scroll")); ids.forEach((id: string) => this.contexts.delete(id)); return response({ succeeded: true, num_freed: ids.length }); }
      if (method === "POST" || method === "GET") { const context = this.context(body.scroll_id, principal, "scroll"); if (body.scroll !== undefined) context.expires = this.now() + this.ttl(body.scroll); const hits = context.page!.hits.slice(context.offset, context.offset + context.size); context.offset += context.size; return response({ _scroll_id: body.scroll_id, took: 0, timed_out: false, _shards: SHARDS, hits: { ...context.page, hits } }); }
    }
    if (parts[0] === "_search" && parts[1] === "point_in_time" && method === "DELETE") { const body = parse(); keys(body, ["pit_id"], "delete PIT"); const ids = Array.isArray(body.pit_id) ? body.pit_id : [body.pit_id]; ids.forEach((id: string) => this.context(id, principal, "pit")); ids.forEach((id: string) => this.contexts.delete(id)); return response({ pits: ids.map((pit_id: string) => ({ pit_id, successful: true })) }); }
    const global = parts[0]?.startsWith("_"); const pattern = global ? "*" : parts[0]; const action = global ? parts[0] : parts[1];
    if (action === "_bulk" && ["POST", "PUT"].includes(method)) return this.bulk(global ? undefined : pattern, raw, param, allowExplicitIndex);
    if (action === "_msearch" && (method === "POST" || method === "GET")) {
      const lines = this.ndjson(raw); if (lines.length % 2) fail("msearch requires header/body pairs");
      const pairs = []; for (let i = 0; i < lines.length; i += 2) { keys(record(lines[i], "msearch header"), ["index"], "msearch header"); if (!allowExplicitIndex && lines[i].index) fail("Explicit index in msearch is disabled"); pairs.push([lines[i], lines[i + 1]]); }
      return response({ responses: pairs.map(([header, body]) => { try { return this.search(header.index ?? pattern, body, query, principal, requestDeadline); } catch (error) { return this.error(error).body; } }) });
    }
    if (action === "_search" && parts.at(-1) === "point_in_time") {
      if (method !== "POST" || global) fail("Creating a point in time requires POST /{index}/_search/point_in_time");
      return response({ pit_id: this.saveContext(this.candidates(pattern), principal, "pit", query.get("keep_alive")), creation_time: this.now(), _shards: SHARDS });
    }
    if (action === "_search" && (method === "POST" || method === "GET")) return response(this.search(pattern, parse(), query, principal, requestDeadline));
    if (action === "_count" && (method === "POST" || method === "GET")) { const body = parse(); keys(body, ["query"], "count"); const predicate = this.queryPredicate(body.query, pattern); return response({ count: this.candidates(pattern).filter(doc => predicate(doc) !== null).length, _shards: SHARDS }); }
    if (action === "_validate" && parts.at(-1) === "query" && (method === "POST" || method === "GET")) { try { const body = parse(); keys(body, ["query"], "validate"); this.queryPredicate(body.query, pattern); return response({ valid: true, _shards: SHARDS }); } catch (error) { return response({ valid: false, _shards: SHARDS, explanations: [{ valid: false, error: (error as Error).message }] }); } }
    if (action === "_refresh" && (method === "POST" || method === "GET")) { this.transaction(() => this.resolve(pattern).forEach(index => this.refresh(index))); return response({ _shards: SHARDS }); }
    if (action === "_analyze" && (method === "POST" || method === "GET")) {
      const body = record(parse(), "analyze"); keys(body, ["text", "analyzer", "field"], "analyze");
      const texts = Array.isArray(body.text) ? body.text : [body.text];
      if (!texts.length || texts.some((text: any) => typeof text !== "string")) fail("analyze.text must be a string or nonempty string array");
      if (body.field && body.analyzer) fail("Specify either field or analyzer");
      const analysis = global ? undefined : this.analysis(this.index(pattern));
      let analyzer = body.analyzer ?? indexAnalyzer({}, analysis);
      if (body.field) { const mapping = fieldMapping(this.readableIndex(this.index(pattern)).mappings, body.field); if (!mapping.type) fail(`Unknown field [${body.field}]`); analyzer = indexAnalyzer(mapping, analysis); }
      if (texts.reduce((size: number, text: string) => size + Buffer.byteLength(text), 0) > 1024 * 1024) fail("Analysis input exceeds 1 MiB", "limit_exceeded_exception", 413);
      let offset = 0, position = 0;
      const tokens: ReturnType<typeof analyzeTokens> = []; let bytes = 0;
      for (const text of texts) {
        const analyzed = analyzeTokens(text, analyzer, analysis); bytes += analyzed.reduce((size, token) => size + Buffer.byteLength(token.token), 0);
        if (tokens.length + analyzed.length > 65536 || bytes > 4 * 1024 * 1024) fail("Analysis exceeds 65536 tokens or 4 MiB of token text", "limit_exceeded_exception", 413);
        for (const token of analyzed) tokens.push({ ...token, start_offset: token.start_offset + offset, end_offset: token.end_offset + offset, position: token.position + position });
        offset += text.length + 1; position += (analyzed.at(-1)?.position ?? -1) + 1;
      }
      return response({ tokens });
    }
    if (action === "_mget" && (method === "POST" || method === "GET")) {
      const body = record(parse(), "mget"); keys(body, ["docs", "ids"], "mget");
      if (body.docs && body.ids) fail("Specify either docs or ids");
      if (body.ids !== undefined && !Array.isArray(body.ids)) fail("mget.ids must be an array");
      const documents = body.docs ?? body.ids?.map((_id: string) => ({ _id }));
      if (!Array.isArray(documents) || !documents.length || documents.length > 1000) fail("mget requires 1–1000 documents");
      for (const doc of documents) { keys(record(doc, "mget document"), ["_index", "_id", "_source", "routing"], "mget document"); if (typeof doc._id !== "string" || !doc._id || doc._index !== undefined && typeof doc._index !== "string") fail("mget documents require string IDs and index names"); if (!allowExplicitIndex && doc._index) fail("Explicit index in mget is disabled"); selectSource({}, doc._source); }
      return response({ docs: documents.map((doc: Json) => { try { return this.getDocument(doc._index ?? pattern, doc._id, { ...param, ...doc }).body; } catch (error) { return { _index: doc._index ?? pattern, _id: doc._id, error: this.error(error).body.error }; } }) });
    }
    if (action === "_mapping") {
      if (method === "GET") return response(Object.fromEntries(this.resolve(pattern).map(index => [index.name, { mappings: this.readableIndex(index).mappings }])));
      if (method === "PUT" || method === "POST") { const body = parse(); const changes = this.resolve(pattern).map(index => ({ ...index, mappings: mergeMappings(index.mappings, body, new Set(Object.keys(this.analysis(index)))) })); if (changes.some(index => index.settings.knn !== "true" && Object.values<any>(index.mappings.properties ?? {}).some(field => field.type === "knn_vector"))) fail("Vector indexes require index.knn=true"); changes.forEach(index => { this.validateCollectionIndex(index.mappings, index.settings); this.validateIndexAnalysis(index.mappings, index.settings); }); this.transaction(() => changes.forEach(index => this.put("index", index.name, index))); return acknowledged(); }
    }
    if (action === "_field_caps" && (method === "POST" || method === "GET")) {
      const body = parse(); keys(body, ["fields"], "field_caps");
      const requested = body.fields ?? query.get("fields")?.split(",") ?? ["*"];
      if (!Array.isArray(requested) || requested.some((field: any) => typeof field !== "string")) fail("field_caps.fields must be a string array");
      const fields: Json = Object.create(null); const indexes = this.resolve(pattern);
      const visit = (properties: Json, prefix: string, index: string) => { for (const [name, field] of Object.entries<any>(properties)) { const path = prefix ? `${prefix}.${name}` : name; if (requested.some((part: string) => wildcard(part, path))) { const type = field.type ?? "object"; fields[path] ??= Object.create(null); fields[path][type] ??= { type, searchable: true, aggregatable: !["text", "knn_vector", "object", "nested"].includes(type), indices: [] }; fields[path][type].indices.push(index); } if (field.properties) visit(field.properties, path, index); if (field.fields) visit(field.fields, path, index); } };
      indexes.forEach(index => visit(this.readableIndex(index).mappings.properties ?? {}, "", index.name));
      return response({ indices: indexes.map(index => index.name), fields });
    }
    if (action === "_settings") {
      if (method === "GET") return response(Object.fromEntries(this.resolve(pattern).map(index => [index.name, { settings: { index: index.settings } }])));
      if (method === "PUT") { const body = parse(); const changes = this.resolve(pattern).map(index => ({ ...index, settings: indexSettings(body, index.settings, false) })); changes.forEach(index => { this.validateCollectionIndex(index.mappings, index.settings); this.validateIndexAnalysis(index.mappings, index.settings); }); this.transaction(() => changes.forEach(index => this.put("index", index.name, index))); return acknowledged(); }
    }
    if (action === "_alias" || action === "_aliases") {
      const alias = global ? parts[1] : parts[2];
      if (method === "GET" || method === "HEAD") { const found = this.resolve(pattern).filter(index => !alias || Object.keys(index.aliases).some(name => wildcard(alias, name))); if (alias && !found.length) fail(`alias [${alias}] missing`, "aliases_not_found_exception", 404); return response(Object.fromEntries(found.map(index => [index.name, { aliases: Object.fromEntries(Object.entries(index.aliases).filter(([name]) => !alias || wildcard(alias, name))) }]))); }
      if (method === "PUT" && alias) return this.aliasRequest({ actions: [{ add: { index: pattern, alias, ...parse() } }] });
      if (method === "DELETE" && alias) return this.aliasRequest({ actions: [{ remove: { index: pattern, alias } }] });
    }
    if (action === "_doc" || action === "_create" || action === "_update" || action === "_source" || action === "_explain") {
      if (this.runtime.appendOnly && ["POST", "PUT"].includes(method) && ["_doc", "_create", "_update"].includes(action) && (action !== "_doc" || method !== "POST" || parts[2] !== undefined)) fail("This collection type requires auto-generated document IDs and does not support updates");
      const id = parts[2] ?? (method === "POST" && action === "_doc" ? randomUUID() : "");
      let result: EngineResponse;
      if ((method === "GET" || method === "HEAD") && ["_doc", "_source"].includes(action)) { result = this.getDocument(pattern, id, param); if (action === "_source" && result.status === 200) result.body = result.body._source; return result; }
      if (action === "_explain" && (method === "GET" || method === "POST")) { const body = parse(); keys(body, ["query"], "explain"); const predicate = this.queryPredicate(body.query, pattern); const index = this.writeIndex(pattern, false); const doc = this.getDocument(index.name, id).body; if (!doc.found) return response({ _index: index.name, _id: id, matched: false }, 404); const score = predicate({ ...doc, mappings: index.mappings, analysis: this.analysis(index), _score: 0 }); return response({ _index: index.name, _id: id, matched: score !== null, explanation: { value: score ?? 0, description: "StackSim local term-count score (not Lucene BM25)", details: [] } }); }
      this.checkRefresh(pattern, query.get("refresh"));
      if (action === "_update" && method === "POST") result = this.updateDocument(pattern, id, parse(), param);
      else if (action === "_doc" && method === "DELETE") { const body = this.write(pattern, id, null, param); result = response(body, body.result === "not_found" ? 404 : 200); }
      else if (["_doc", "_create"].includes(action) && ["PUT", "POST"].includes(method)) { const body = this.write(pattern, id, parse(), { ...param, ...(action === "_create" ? { op_type: "create" } : {}) }); result = response(body, body.result === "created" ? 201 : 200); }
      else return fail("Unsupported document operation");
      await this.afterWrite(pattern, query.get("refresh")); return result;
    }
    if (!action && pattern) {
      if (method === "PUT") return response(this.createIndex(pattern, parse()));
      if (method === "GET" || method === "HEAD") return response(Object.fromEntries(this.resolve(pattern).map(index => [index.name, { aliases: index.aliases, mappings: this.readableIndex(index).mappings, settings: { index: index.settings } }])));
      if (method === "DELETE") { const indexes = this.resolve(pattern); this.transaction(() => indexes.forEach(index => this.deleteIndex(index.name))); return acknowledged(); }
    }
    return fail(`Operation [${method} ${url.pathname}] is not implemented by the embedded engine`, "unsupported_operation_exception");
  }
  private ndjson(raw: Buffer): Json[] {
    if (!raw.length || raw.at(-1) !== 10) fail("The request must end with a newline", "parse_exception");
    const lines = raw.toString("utf8").trimEnd().split("\n"); if (lines.length > 2000) fail("NDJSON requests are limited to 2000 lines");
    return lines.map(line => { try { return record(JSON.parse(line), "NDJSON line"); } catch (error) { if (error instanceof SearchError) throw error; return fail("Malformed NDJSON", "parse_exception"); } });
  }
  private validateWorkspaceObject(body: Json): void {
    keys(body, ["id", "type", "title", "pattern", "query", "sort", "fields"], "workspace object");
    if (!["data-view", "saved-search"].includes(body.type)) fail("Saved object type must be data-view or saved-search");
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 128) fail("Saved object title requires 1–128 characters");
    if (typeof body.pattern !== "string" || !/^[a-z0-9*?][a-z0-9*?_,.-]{0,254}$/.test(body.pattern)) fail("Invalid data view index pattern");
    if (!this.runtime.externalWorkspaceSources) this.resolve(body.pattern);
    if (body.query !== undefined) compileQuery(body.query);
    if (body.fields !== undefined && (!Array.isArray(body.fields) || body.fields.length > 100 || body.fields.some((field: any) => typeof field !== "string" || field.length > 255))) fail("Saved fields must contain at most 100 field names");
    if (body.sort !== undefined && (!Array.isArray(body.sort) || body.sort.length > 10 || body.sort.some((entry: any) => !entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1 || !["asc", "desc"].includes(Object.values(entry)[0] as string)))) fail("Saved sort requires at most 10 single-field asc/desc entries");
    if (Buffer.byteLength(JSON.stringify(body)) > 65536) fail("Saved objects must not exceed 64 KiB");
  }
  private workspace(method: string, body: Json, principal: string): Json {
    const owner = createHash("sha256").update(principal).digest("hex");
    const objects: Json[] = this.get("workspace", owner) ?? [];
    if (method === "GET") { keys(body, [], "workspace list"); return { objects }; }
    if (method === "DELETE") {
      keys(body, ["id"], "workspace delete");
      if (typeof body.id !== "string" || !objects.some(object => object.id === body.id)) fail("Saved object does not exist", "resource_not_found_exception", 404);
      this.put("workspace", owner, objects.filter(object => object.id !== body.id)); return { deleted: true };
    }
    if (method !== "PUT") fail("Workspace methods are GET, PUT and DELETE");
    this.validateWorkspaceObject(body);
    if (body.id !== undefined && (typeof body.id !== "string" || !objects.some(object => object.id === body.id))) fail("Saved object does not exist", "resource_not_found_exception", 404);
    if (!body.id && (objects.length >= 100 || this.entries("workspace").reduce((sum, entries) => sum + entries.length, 0) >= 1000)) fail("Workspace saved-object limit reached", "limit_exceeded_exception", 429);
    const object = { ...body, id: body.id ?? randomUUID(), updatedAt: this.now() };
    this.put("workspace", owner, [...objects.filter(value => value.id !== object.id), object]);
    return { object };
  }
  private async bulk(index: string | undefined, raw: Buffer, query: Json, allowExplicitIndex: boolean): Promise<EngineResponse> {
    const started = performance.now();
    const lines = this.ndjson(raw); const actions: Array<{ operation: string; meta: Json; body?: Json }> = [];
    for (let at = 0; at < lines.length; at++) {
      const header = lines[at]; if (Object.keys(header).length !== 1) fail("Malformed bulk action"); const [operation, meta] = Object.entries<any>(header)[0];
      if (!["index", "create", "update", "delete"].includes(operation)) fail(`Unknown bulk operation [${operation}]`);
      keys(record(meta, "bulk metadata"), ["_index", "_id", "routing", "if_seq_no", "if_primary_term", "pipeline", "version", "version_type"], "bulk metadata");
      if (!allowExplicitIndex && meta._index) fail("Explicit index in bulk is disabled");
      const body = operation === "delete" ? undefined : lines[++at]; if (operation !== "delete" && !body) fail("Bulk action is missing its source line");
      actions.push({ operation, meta, body });
    }
    for (const { meta } of actions) { const name = meta._index ?? index; if (name !== undefined && typeof name !== "string") fail("Bulk index names must be strings"); this.checkRefresh(name, query.refresh ?? null); }
    const touched = new Set<string>();
    const items = actions.map(({ operation, meta, body }) => {
      const invoke = () => {
      const name = meta._index ?? index; const id = meta._id ?? (operation === "index" || operation === "create" ? randomUUID() : "");
      try {
        if (typeof name !== "string" || !name) fail("An index is required for each bulk item");
        if (this.runtime.appendOnly && operation !== "delete" && (operation !== "index" || meta._id !== undefined)) fail("This collection type supports bulk index with auto-generated IDs; explicit IDs and updates are unavailable");
        const options = { ...meta, routing: meta.routing ?? query.routing, pipeline: meta.pipeline ?? query.pipeline };
        if (meta.pipeline !== undefined && !["index", "create"].includes(operation)) fail("Per-item pipelines require index or create operations");
        const result = operation === "update" ? this.updateDocument(name, id, body!, options) : (() => { const data = this.write(name, id, operation === "delete" ? null : body!, { ...options, op_type: operation === "create" ? "create" : "index" }); return response(data, data.result === "created" ? 201 : data.result === "not_found" ? 404 : 200); })();
        touched.add(result.body._index); return { [operation]: { ...result.body, status: result.status } };
      } catch (error) { const failed = this.error(error); return { [operation]: { _index: name, _id: id, status: failed.status, error: failed.body.error } }; }
      };
      const context = this.authority.getStore();
      return context ? this.authority.run({ access: context.access, action: `indices:data/write/${operation === "create" ? "index" : operation}` }, invoke) : invoke();
    });
    if (touched.size) await this.authority.exit(() => this.afterWrite([...touched].join(","), query.refresh ?? null));
    return response({ took: Math.floor(performance.now() - started), errors: items.some(item => Object.values(item)[0].status >= 300), items });
  }
  private templateRequest(method: string, name: string | undefined, body: Json): EngineResponse {
    if (method === "GET" || method === "HEAD") { const found = this.entries("template").filter(template => !name || wildcard(name, template.name)); if (name && !found.length) fail(`Template [${name}] not found`, "resource_not_found_exception", 404); return response({ index_templates: found.map(({ name, ...index_template }) => ({ name, index_template })) }); }
    if (!name) fail("A template name is required");
    if (method === "DELETE") { if (!this.get("template", name)) fail(`Template [${name}] not found`, "resource_not_found_exception", 404); this.remove("template", name); return acknowledged(); }
    if (method === "PUT") {
      keys(record(body, "template"), ["index_patterns", "template", "priority", "version", "_meta"], "template");
      if (body.priority !== undefined) integer(body.priority, 0, 0, Number.MAX_SAFE_INTEGER);
      if (body.version !== undefined) integer(body.version, 0, 0, Number.MAX_SAFE_INTEGER);
      if (!Array.isArray(body.index_patterns) || !body.index_patterns.length || body.index_patterns.some((pattern: any) => typeof pattern !== "string" || !pattern.length)) fail("index_patterns must be a nonempty string array");
      const template = record(body.template ?? {}, "template body"); keys(template, ["mappings", "settings", "aliases"], "template body"); const settings = indexSettings(template.settings), analysis = this.analysis({ name: `_template:${name}`, settings, packageVersions: this.packageVersions(settings) }); validateMappings(template.mappings ?? {}, 0, new Set(Object.keys(analysis))); this.validateIndexAnalysis(template.mappings ?? {}, settings); this.validateAliases(template.aliases ?? {});
      if (this.entries("template").length >= 100 && !this.get("template", name)) fail("The local 100 template limit was reached");
      this.put("template", name, { ...body, name }); return acknowledged();
    }
    return fail("Unsupported template operation");
  }
  private aliasRequest(body: Json): EngineResponse {
    keys(record(body, "aliases"), ["actions"], "aliases"); if (!Array.isArray(body.actions) || !body.actions.length || body.actions.length > 1000) fail("aliases requires 1–1000 actions");
    return this.transaction(() => {
      for (const action of body.actions) {
        if (Object.keys(record(action, "alias action")).length !== 1) fail("An alias action must have one operation");
        const [operation, options] = Object.entries<any>(action)[0]; if (!["add", "remove"].includes(operation)) fail("Only alias add/remove are implemented");
        keys(record(options, "alias action"), ["index", "alias", "is_write_index", "must_exist"], "alias action");
        if (typeof options.index !== "string" || typeof options.alias !== "string") fail("Alias actions require index and alias");
        for (const index of this.resolve(options.index)) {
          if (operation === "add") { const config = options.is_write_index === undefined ? {} : { is_write_index: options.is_write_index }; this.validateAliases({ [options.alias]: config }); index.aliases[options.alias] = config; }
          else { if (options.must_exist && !Object.hasOwn(index.aliases, options.alias)) fail("Alias does not exist", "aliases_not_found_exception", 404); delete index.aliases[options.alias]; }
          this.put("index", index.name, index);
        }
      }
      const writers = new Set<string>(); for (const index of this.indexes()) for (const [alias, options] of Object.entries<any>(index.aliases)) if (options.is_write_index) { if (writers.has(alias)) fail(`Alias [${alias}] has multiple write indexes`); writers.add(alias); }
      return acknowledged();
    });
  }
  error(error: unknown): EngineResponse { const value = error instanceof SearchError ? error : new SearchError("internal_server_error", "The embedded search operation failed", 500); return response({ error: { root_cause: [{ type: value.type, reason: value.message }], type: value.type, reason: value.message }, status: value.status }, value.status); }
}
