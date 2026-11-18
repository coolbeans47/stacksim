import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { StateStore } from '../state.js';
import type { Clock } from '../core/clock.js';
import { AwsError } from '../errors.js';
import { refreshPrincipalIdentity, type PrincipalContext } from '../auth/sigv4.js';
import type { ServerlessCollection, ServerlessState } from './serverless-model.js';
import type { S3SourcePort, S3ReadSource } from './ingestion/s3-source.js';
import { SearchError } from './query.js';
import { ServerlessIngestionStore } from './serverless-ingestion-store.js';

export const SERVERLESS_INGESTION_ACTIONS = new Set(['CreateIngestionJob', 'GetIngestionJob', 'ListIngestionJobs', 'CancelIngestionJob']);
export interface ServerlessIngestionJob {
  id: string; name: string; arn: string; generation: string; collectionId: string; collectionGeneration: string; accountId: string; region: string;
  indexName: string; failureIndexName: string; source: { s3: { bucket: string; bucketOwnerAccountId: string; keyPrefix: string } };
  status: 'CREATING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLING' | 'CANCELLED' | 'FAILED' | 'CREATE_FAILED' | 'CANCEL_FAILED';
  state: 'STARTING' | 'SCANNING' | 'INGESTION_IN_PROGRESS' | 'INGESTION_COMPLETE' | 'STOPPED' | 'FAILED';
  statistics: { s3: { objectsDiscovered: number; objectsIngested: number; objectsFailed: number } };
  revision: number; createdAt: number; updatedAt: number; tags: Record<string, string>; storageReady?: boolean;
  identity: Pick<PrincipalContext, 'accessKeyId' | 'principalArn' | 'principalId' | 'accountId'>;
  failureReasons?: Array<{ code: string; message: string }>;
  activeAlerts?: Array<{ code: string; message: string }>; retryAt?: number; attempts?: number;
}
export interface ServerlessIngestionHost {
  state(region: string, account: string): ServerlessState;
  collection(region: string, id: string, account: string): ServerlessCollection;
  eligible(collection: ServerlessCollection): boolean;
  write(collection: ServerlessCollection, principal: PrincipalContext, index: string, id: string, document: Record<string, any>): Promise<void>;
  page<T extends { name: string; id: string }>(state: ServerlessState, rows: T[], input: any, scope: string): { items: T[]; nextToken?: string };
}
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
const terminal = (job: ServerlessIngestionJob) => ['COMPLETED', 'CANCELLED', 'FAILED', 'CREATE_FAILED', 'CANCEL_FAILED'].includes(job.status);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
export function parseServerlessObject(bytes: Buffer, key: string): Record<string, any>[] {
  if (bytes.length > 10 * 1024 * 1024) invalid('Source object exceeds 10 MiB');
  if (key.endsWith('.gz')) { try { bytes = gunzipSync(bytes, { maxOutputLength: 10 * 1024 * 1024 }); } catch { invalid('Malformed or oversized gzip object'); } key = key.slice(0, -3); }
  if (!/\.(json|jsonl|ndjson)$/i.test(key)) invalid('Only JSON, JSON array and NDJSON objects are supported');
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid('Source object is not UTF-8'); }
  let rows: any[];
  if (/\.(ndjson|jsonl)$/i.test(key)) {
    rows = []; for (let offset = 0; offset < text.length;) { const end = text.indexOf('\n', offset), line = text.slice(offset, end < 0 ? text.length : end).trim(); offset = end < 0 ? text.length : end + 1; if (!line) continue; if (rows.length >= 1000) invalid('Source object exceeds 1000 records'); try { rows.push(JSON.parse(line)); } catch { invalid('Malformed NDJSON'); } }
  } else { let value: any; try { value = JSON.parse(text); } catch { invalid('Malformed JSON'); } rows = Array.isArray(value) ? value : [value]; }
  if (rows.length > 1000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Buffer.byteLength(JSON.stringify(row)) > 1024 * 1024)) invalid('Source requires at most 1000 JSON records, at most 1 MiB each');
  return rows;
}

export class ServerlessIngestion {
  private source?: S3SourcePort;
  private closing = true;
  private timer?: ReturnType<Clock['setTimeout']>;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly publishing = new Set<string>();
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly host: ServerlessIngestionHost) {}
  configure(source: S3SourcePort): void { this.source = source; }
  jobs(region: string, account: string): Record<string, ServerlessIngestionJob> { return this.host.state(region, account).ingestionJobs ??= {}; }
  private all(): ServerlessIngestionJob[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.serverless?.ingestionJobs ?? {}))); }
  private location(job: ServerlessIngestionJob) {
    if (!/^[a-f0-9-]{36}$/.test(job.collectionGeneration) || !/^[a-f0-9]{32}$/.test(job.id)) throw new Error('Invalid ingestion storage identity');
    const directory = join(this.store.root, 'data', 'opensearchserverless-ingestion', job.collectionGeneration, job.id), key = join(this.store.root, 'secrets', 'opensearchserverless-ingestion', job.collectionGeneration, `${job.id}.key`);
    return { directory, file: join(directory, 'work.enc'), key };
  }
  detail(job: ServerlessIngestionJob): Record<string, any> {
    return { ingestionJobId: job.id, ingestionJobName: job.name, arn: job.arn, collectionId: job.collectionId, indexName: job.indexName, failureIndexName: job.failureIndexName, source: structuredClone(job.source), status: job.status, state: job.state, statistics: structuredClone(job.statistics), revision: job.revision, createdAt: job.createdAt / 1000, updatedAt: job.updatedAt / 1000, failureReasons: structuredClone(job.failureReasons ?? []), activeAlerts: structuredClone(job.activeAlerts ?? []) };
  }
  async start(): Promise<void> { this.closing = false; this.schedule(0); }
  async stop(): Promise<void> { this.closing = true; if (this.timer !== undefined) this.clock.clearTimeout(this.timer); this.timer = undefined; await Promise.all(this.workers.values()); }
  private schedule(ms = 1000): void {
    if (this.closing || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; for (const job of this.all()) if (!terminal(job) && (job.status === 'CANCELLING' || (job.retryAt ?? 0) <= this.clock.now()) && !this.publishing.has(job.id) && !this.workers.has(job.id) && this.workers.size < 4) { const work = this.work(job).catch(() => undefined).finally(() => this.workers.delete(job.id)); this.workers.set(job.id, work); } this.schedule(); }, ms); (this.timer as any)?.unref?.();
  }
  async removeCollection(collection: ServerlessCollection): Promise<void> {
    const jobs = Object.values(this.jobs(collection.region, collection.accountId)).filter(job => job.collectionGeneration === collection.generation);
    await Promise.all(jobs.map(job => this.workers.get(job.id)));
    for (const job of jobs) { const path = this.location(job); await rm(path.directory, { recursive: true, force: true }); await rm(path.key, { force: true }); delete this.jobs(job.region, job.accountId)[job.id]; }
  }
  private readSource(job: ServerlessIngestionJob): S3ReadSource { return { bucket: job.source.s3.bucket.replace(/^arn:[^:]+:s3:::/, ''), prefix: job.source.s3.keyPrefix, region: job.region }; }
  private async publish(job: ServerlessIngestionJob, change: (current: ServerlessIngestionJob) => void): Promise<void> {
    await this.store.withMutationLock(`aoss:${job.accountId}:${job.region}`, async () => {
      const current = this.jobs(job.region, job.accountId)[job.id]; if (!current) return; const previous = structuredClone(current);
      change(current); current.updatedAt = this.clock.now(); current.revision++;
      try { await this.store.save(); } catch (error) { Object.assign(current, previous); throw error; }
    });
  }
  async execute(operation: string, input: any, collection: ServerlessCollection, principal?: PrincipalContext): Promise<Record<string, any>> {
    return this.store.withMutationLock(`aoss:${collection.accountId}:${collection.region}`, async () => {
      const state = this.host.state(collection.region, collection.accountId), jobs = this.jobs(collection.region, collection.accountId), now = this.clock.now();
      const tokenKey = input.clientToken ? digest(['ingestion', operation, input.clientToken]) : undefined, { clientToken, ...payload } = input, fingerprint = digest(canonical(payload));
      if (tokenKey && state.tokens[tokenKey]?.expires > now) { if (state.tokens[tokenKey].fingerprint !== fingerprint) invalid('Client token was reused with different parameters'); return structuredClone(state.tokens[tokenKey].response); }
      if (operation === 'ListIngestionJobs') { const page = this.host.page(state, Object.values(jobs).filter(job => job.collectionId === collection.id), input, `ingestion-jobs:${collection.id}`); return { ingestionJobSummaries: page.items.map(job => { const { ingestionJobId, ingestionJobName, arn, indexName, status, createdAt, updatedAt } = this.detail(job); return { ingestionJobId, ingestionJobName, arn, indexName, status, createdAt, updatedAt }; }), ...(page.nextToken ? { nextToken: page.nextToken } : {}) }; }
      let job = jobs[input.ingestionJobId], created = false;
      if (operation === 'CreateIngestionJob') {
        if (!principal || !this.source || this.closing) invalid('Ingestion requires an authenticated execution identity and available source service');
        if (!this.host.eligible(collection) || collection.status !== 'ACTIVE') invalid('Ingestion jobs require an active NextGen SEARCH or VECTORSEARCH collection');
        const source = input.source?.s3, bucket = source?.bucket?.replace(/^arn:[^:]+:s3:::/, '');
        if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || source.bucketOwnerAccountId !== undefined && source.bucketOwnerAccountId !== collection.accountId || source.keyPrefix !== undefined && (typeof source.keyPrefix !== 'string' || Buffer.byteLength(source.keyPrefix) > 1024)) invalid('Ingestion requires one same-account S3 bucket and a literal prefix of at most 1024 bytes');
        const failureIndex = input.failureIndexName ?? `${input.indexName}-ingestion-failures`;
        for (const index of [input.indexName, failureIndex]) if (typeof index !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(index)) invalid('Invalid target or failure index name');
        if (failureIndex === input.indexName) invalid('The failure index must differ from the target index');
        if (Object.values(jobs).some(job => job.collectionId === collection.id && job.name === input.ingestionJobName)) throw new AwsError('ConflictException', 'Ingestion job name already exists', 400);
        if ([...Object.values(jobs).filter(job => !terminal(job)), ...Object.values(state.ingestionStreams ?? {}).filter(stream => !['DELETED', 'CREATE_FAILED', 'DELETE_FAILED'].includes(stream.status))].some(job => job.collectionId === collection.id && [job.indexName, job.failureIndexName].some(index => [input.indexName, failureIndex].includes(index)))) throw new AwsError('ConflictException', 'Another active job uses a target or failure index', 400);
        if (Object.keys(jobs).length >= 100 || this.all().filter(job => !terminal(job)).length >= 20) throw new AwsError('ServiceQuotaExceededException', 'Ingestion job history or active-job limit reached', 400);
        const tags: Record<string, string> = {}; for (const tag of input.tags ?? []) { if (tag.key.toLowerCase().startsWith('aws:') || Object.hasOwn(tags, tag.key)) invalid('Duplicate or reserved job tags'); Object.defineProperty(tags, tag.key, { value: tag.value, enumerable: true, configurable: true, writable: true }); }
        const id = randomBytes(16).toString('hex');
        job = { id, name: input.ingestionJobName, arn: `${collection.arn}/ingestion-job/${id}`, generation: randomUUID(), collectionId: collection.id, collectionGeneration: collection.generation, accountId: collection.accountId, region: collection.region, indexName: input.indexName, failureIndexName: failureIndex, source: { s3: { bucket: source.bucket, bucketOwnerAccountId: collection.accountId, keyPrefix: source.keyPrefix ?? '' } }, status: 'CREATING', state: 'STARTING', statistics: { s3: { objectsDiscovered: 0, objectsIngested: 0, objectsFailed: 0 } }, revision: 1, createdAt: now, updatedAt: now, tags, identity: { accessKeyId: principal!.accessKeyId, principalArn: principal!.principalArn, principalId: principal!.principalId, accountId: principal!.accountId } };
        this.source!.validate(this.readSource(job), collection.accountId); jobs[id] = job; created = true;
      } else if (!job || job.collectionId !== collection.id) throw new AwsError('ResourceNotFoundException', 'Ingestion job does not exist in this collection', 400);
      if (operation === 'GetIngestionJob') return { ingestionJobDetail: this.detail(job) };
      const previous = structuredClone(job);
      if (operation === 'CancelIngestionJob') { if (terminal(job) && job.status !== 'CANCELLED') throw new AwsError('ConflictException', 'Only active ingestion jobs can be cancelled', 400); if (job.status !== 'CANCELLED') { job.status = 'CANCELLING'; job.updatedAt = now; job.revision++; } }
      const result = operation === 'CreateIngestionJob' ? { ingestionJobDetail: this.detail(job) } : { ingestionJobId: job.id, collectionId: job.collectionId, ingestionJobName: job.name, status: job.status };
      const tokens = structuredClone(state.tokens);
      this.publishing.add(job.id);
      try { for (const [key, token] of Object.entries(state.tokens)) if (token.expires <= now) delete state.tokens[key]; if (tokenKey) { if (Object.keys(state.tokens).length >= 1000) throw new AwsError('ServiceQuotaExceededException', 'Idempotency capacity reached', 400); state.tokens[tokenKey] = { fingerprint, response: result, expires: now + 86400000 }; } await this.store.save(); }
      catch (error) { if (created) delete jobs[job.id]; else Object.assign(job, previous); state.tokens = tokens; throw error; }
      finally { this.publishing.delete(job.id); }
      this.schedule(0); return result;
    });
  }
  private async work(original: ServerlessIngestionJob): Promise<void> {
    let work: ServerlessIngestionStore | undefined, stage = 'SOURCE';
    const current = () => this.jobs(original.region, original.accountId)[original.id];
    const active = () => !this.closing && !this.publishing.has(original.id) && current() && !terminal(current()) && current().status !== 'CANCELLING' && this.host.state(original.region, original.accountId).collections[original.collectionId]?.status === 'ACTIVE';
    try {
      let job = current(); if (!job) return;
      if (job.status === 'CANCELLING') { await this.publish(job, value => { if (value.status === 'CANCELLING') { value.status = 'CANCELLED'; value.state = 'STOPPED'; delete value.activeAlerts; delete value.retryAt; } }); return; }
      if (!active() || !this.source) return;
      const path = this.location(job); if (job.storageReady) { await access(path.file); await access(path.key); }
      work = new ServerlessIngestionStore(path.file, path.key);
      if (!job.storageReady) { if (!work.progress().objects) { const objects = await this.source.list(this.readSource(job), refreshPrincipalIdentity(this.store, this.clock, job.identity)); if (objects.length > 1000) invalid('Source listing exceeds the local limit of 1000 objects'); work.listing(objects.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))); } await this.publish(job, value => { value.storageReady = true; if (value.status !== 'CANCELLING') { value.status = 'ACTIVE'; value.state = 'SCANNING'; } }); }
      if (!active()) return;
      let progress = work.progress();
      if (!progress.objects || progress.objects.length > 1000) invalid('Source listing exceeds the local limit of 1000 objects');
      await this.publish(job, value => { value.statistics.s3 = { objectsDiscovered: progress.objects!.length, objectsIngested: progress.objectsIngested, objectsFailed: progress.objectsFailed }; });
      if (progress.cursor >= progress.objects!.length) { await this.publish(job, value => { if (value.status !== 'CANCELLING') { value.status = 'COMPLETED'; value.state = 'INGESTION_COMPLETE'; delete value.activeAlerts; delete value.retryAt; value.attempts = 0; } }); return; }
      const object = progress.objects![progress.cursor];
      if (!work.admitted()) {
        let documents: Record<string, any>[] = [], failure: string | undefined;
        try { documents = parseServerlessObject(await this.source.read(this.readSource(job), object, refreshPrincipalIdentity(this.store, this.clock, job.identity)), object.key); }
        catch (error) { if (error instanceof AwsError && [400, 404, 409].includes(error.status)) failure = 'Source object is malformed, unsupported, changed, missing or exceeds local limits'; else throw error; }
        if (!active()) return; work.admit(documents, failure);
      }
      await this.publish(job, value => { if (value.status !== 'CANCELLING') value.state = 'INGESTION_IN_PROGRESS'; });
      for (let n = 0; n < 20 && active(); n++) {
        const row = work.next(); if (!row) break;
        job = current(); const collection = this.host.collection(job.region, job.collectionId, job.accountId), principal = refreshPrincipalIdentity(this.store, this.clock, job.identity), id = digest([this.readSource(job).bucket, object.key, row.position]);
        let failure = row.failure; stage = 'DESTINATION';
        if (!failure) try { await this.host.write(collection, principal, job.indexName, id, row.document!); } catch (error) { if (error instanceof SearchError && error.status === 400) failure = 'The target index rejected this document'; else throw error; }
        if (failure) await this.host.write(collection, principal, job.failureIndexName, id, { ingestionSource: { s3_uri: `s3://${this.readSource(job).bucket}/${object.key}`, s3_bucket: this.readSource(job).bucket }, record: row.position, error: failure });
        work.acknowledge(row.position, Boolean(failure));
      }
      if (active() && !work.next()) work.finishObject();
      progress = work.progress(); await this.publish(job, value => { delete value.retryAt; value.attempts = 0; delete value.activeAlerts; value.statistics.s3 = { objectsDiscovered: progress.objects!.length, objectsIngested: progress.objectsIngested, objectsFailed: progress.objectsFailed }; if (progress.cursor >= progress.objects!.length && value.status !== 'CANCELLING') { value.status = 'COMPLETED'; value.state = 'INGESTION_COMPLETE'; delete value.activeAlerts; delete value.retryAt; value.attempts = 0; } });
    } catch (error) {
      const status = error instanceof AwsError || error instanceof SearchError ? error.status : 500;
      const code = status === 403 ? `${stage}_ACCESS_DENIED` : status === 404 ? `${stage}_RESOURCE_NOT_FOUND` : 'INTERNAL_SERVER_ERROR';
      await this.publish(original, job => {
        if (job.status === 'CANCELLING') return;
        if ((status === 429 || status >= 500) && (job.attempts ?? 0) < 10) { job.attempts = (job.attempts ?? 0) + 1; job.retryAt = this.clock.now() + Math.min(60000, 1000 * 2 ** Math.min(6, job.attempts - 1)); job.activeAlerts = [{ code: 'INTERNAL_SERVER_ERROR', message: 'Ingestion is waiting for source/destination capacity or storage recovery' }]; return; }
        job.status = job.status === 'CREATING' ? 'CREATE_FAILED' : 'FAILED'; job.state = 'FAILED'; delete job.activeAlerts; job.failureReasons = [{ code, message: status === 403 ? 'Execution identity or source/destination policy denied ingestion' : 'Source data, destination or encrypted work storage could not be processed; inspect source limits and resource availability' }];
      }).catch(() => undefined);
    } finally { work?.close(); }
  }
}
