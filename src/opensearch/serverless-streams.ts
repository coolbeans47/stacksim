import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StateStore } from '../state.js';
import type { Clock } from '../core/clock.js';
import type { PrincipalContext } from '../auth/sigv4.js';
import { AwsError } from '../errors.js';
import { SearchError } from './query.js';
import type { ServerlessCollection } from './serverless-model.js';
import { parseServerlessObject, type ServerlessIngestionHost } from './serverless-ingestion.js';
import { ServerlessIngestionStore, type StreamObject, type StreamMessage } from './serverless-ingestion-store.js';
import type { S3SourcePort } from './ingestion/s3-source.js';

export const SERVERLESS_STREAM_ACTIONS = new Set(['CreateIngestionStream', 'GetIngestionStream', 'ListIngestionStreams', 'DeleteIngestionStream']);
export interface ServerlessStream {
  id: string; name: string; arn: string; generation: string; collectionId: string; collectionGeneration: string; accountId: string; region: string;
  indexName: string; failureIndexName: string; roleArn: string;
  source: { s3: { sqsArn: string; buckets?: Array<{ bucket: string; bucketOwnerAccountId?: string; initialScan?: 'ENABLED' | 'DISABLED' }> } };
  status: 'CREATING' | 'ACTIVE' | 'DELETING' | 'DELETED' | 'CREATE_FAILED' | 'DELETE_FAILED';
  state: 'STARTING' | 'SCANNING' | 'INGESTION_IN_PROGRESS' | 'INGESTION_COMPLETE' | 'STOPPED' | 'FAILED';
  statistics: { s3: { objectsDiscovered: number; objectsIngested: number; objectsFailed: number } };
  revision: number; createdAt: number; updatedAt: number; tags: Record<string, string>; storageReady?: boolean;
  failureReasons?: Array<{ code: string; message: string }>; activeAlerts?: Array<{ code: string; message: string }>; retryAt?: number; attempts?: number;
}
export interface ServerlessStreamPorts {
  assume(stream: ServerlessStream): Promise<PrincipalContext>;
  validateQueue(stream: ServerlessStream): void;
  receive(stream: ServerlessStream, principal: PrincipalContext): Promise<(StreamMessage & { body: string }) | undefined>;
  acknowledge(stream: ServerlessStream, message: StreamMessage, principal: PrincipalContext): Promise<void>;
  read(stream: ServerlessStream, object: StreamObject, principal: PrincipalContext): Promise<Buffer>;
}
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const bucketName = (bucket: string) => bucket.replace(/^arn:[^:]+:s3:::/, '');
const terminal = (stream: ServerlessStream) => ['DELETED', 'CREATE_FAILED', 'DELETE_FAILED'].includes(stream.status);

/** Parse only direct S3 notifications. Raw bodies never enter diagnostic output. */
export function parseServerlessNotification(body: string, stream: Pick<ServerlessStream, 'region' | 'accountId' | 'source'>): StreamObject[] {
  if (Buffer.byteLength(body) > 1024 * 1024) invalid('Notification exceeds 1 MiB');
  let value: any; try { value = JSON.parse(body); } catch { return invalid('Malformed S3 notification'); }
  if (value?.Event === 's3:TestEvent' && value.Service === 'Amazon S3') return [];
  if (!Array.isArray(value?.Records) || value.Records.length < 1 || value.Records.length > 100) invalid('Notifications require 1–100 S3 records');
  return value.Records.map((record: any) => {
    const source = record?.s3, object = source?.object, bucket = source?.bucket?.name;
    if (record?.eventSource !== 'aws:s3' || record.awsRegion !== stream.region || !/^ObjectCreated:(Put|Post|Copy|CompleteMultipartUpload)$/.test(record.eventName) || typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || source.bucket.arn !== `arn:aws:s3:::${bucket}` || typeof object?.key !== 'string' || !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.eTag !== 'string' || !/^[a-f0-9]{32}(?:-\d+)?$/i.test(object.eTag.replace(/^"|"$/g, '')) || object.versionId !== undefined && typeof object.versionId !== 'string') invalid('Only same-Region ObjectCreated notifications with object metadata are supported');
    if (stream.source.s3.buckets?.length && !stream.source.s3.buckets.some(item => bucketName(item.bucket) === bucket)) invalid('Notification bucket is outside the stream source');
    let key: string; try { key = decodeURIComponent(object.key.replace(/\+/g, ' ')); } catch { return invalid('Malformed S3 object key'); }
    if (!key || Buffer.byteLength(key) > 1024) invalid('Invalid S3 object key');
    return { bucket, key, etag: object.eTag.replace(/^"|"$/g, ''), size: object.size, lastModified: 0, ...(object.versionId && object.versionId !== 'null' ? { versionId: object.versionId } : {}), notification: true };
  });
}

export class ServerlessStreams {
  private ports?: ServerlessStreamPorts;
  private source?: S3SourcePort;
  private closing = true;
  private timer?: ReturnType<Clock['setTimeout']>;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly publishing = new Set<string>();
  private rotation = 0;
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly host: ServerlessIngestionHost) {}
  configure(source: S3SourcePort, ports: ServerlessStreamPorts): void { this.source = source; this.ports = ports; }
  streams(region: string, account: string): Record<string, ServerlessStream> { return this.host.state(region, account).ingestionStreams ??= {}; }
  private all(): ServerlessStream[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.serverless?.ingestionStreams ?? {}))); }
  private location(stream: ServerlessStream) {
    if (!/^[a-f0-9-]{36}$/.test(stream.collectionGeneration) || !/^[a-f0-9]{32}$/.test(stream.id)) throw new Error('Invalid stream storage identity');
    const directory = join(this.store.root, 'data', 'opensearchserverless-streams', stream.collectionGeneration, stream.id), key = join(this.store.root, 'secrets', 'opensearchserverless-streams', stream.collectionGeneration, `${stream.id}.key`);
    return { directory, file: join(directory, 'work.enc'), key };
  }
  detail(stream: ServerlessStream): Record<string, any> { return { ingestionStreamId: stream.id, ingestionStreamName: stream.name, arn: stream.arn, collectionId: stream.collectionId, indexName: stream.indexName, failureIndexName: stream.failureIndexName, roleArn: stream.roleArn, source: structuredClone(stream.source), status: stream.status, state: stream.state, statistics: structuredClone(stream.statistics), revision: stream.revision, createdAt: stream.createdAt / 1000, updatedAt: stream.updatedAt / 1000, failureReasons: structuredClone(stream.failureReasons ?? []), activeAlerts: structuredClone(stream.activeAlerts ?? []) }; }
  async start(): Promise<void> { this.closing = false; this.schedule(0); }
  async stop(): Promise<void> { this.closing = true; if (this.timer !== undefined) this.clock.clearTimeout(this.timer); this.timer = undefined; await Promise.all(this.workers.values()); }
  private schedule(ms = 1000): void {
    if (this.closing || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined; const streams = this.all().filter(stream => !terminal(stream));
      const start = this.rotation % Math.max(1, streams.length);
      for (let n = 0; n < streams.length && this.workers.size < 4; n++) {
        const offset = (start + n) % streams.length, stream = streams[offset];
        if ((stream.status === 'DELETING' || (stream.retryAt ?? 0) <= this.clock.now()) && !this.publishing.has(stream.id) && !this.workers.has(stream.id)) { const work = this.work(stream).catch(() => undefined).finally(() => this.workers.delete(stream.id)); this.workers.set(stream.id, work); this.rotation = offset + 1; }
      }
      this.schedule();
    }, ms); (this.timer as any)?.unref?.();
  }
  async removeCollection(collection: ServerlessCollection): Promise<void> {
    const streams = Object.values(this.streams(collection.region, collection.accountId)).filter(stream => stream.collectionGeneration === collection.generation);
    await Promise.all(streams.map(stream => this.workers.get(stream.id)));
    for (const stream of streams) { const path = this.location(stream); await rm(path.directory, { recursive: true, force: true }); await rm(path.key, { force: true }); delete this.streams(stream.region, stream.accountId)[stream.id]; }
  }
  private async publish(stream: ServerlessStream, change: (current: ServerlessStream) => void): Promise<void> {
    await this.store.withMutationLock(`aoss:${stream.accountId}:${stream.region}`, async () => {
      const current = this.streams(stream.region, stream.accountId)[stream.id]; if (!current) return;
      const previous = structuredClone(current); change(current); current.updatedAt = this.clock.now(); current.revision++;
      try { await this.store.save(); } catch (error) { for (const key of Object.keys(current)) delete (current as any)[key]; Object.assign(current, previous); throw error; }
    });
  }
  async execute(operation: string, input: any, collection: ServerlessCollection): Promise<Record<string, any>> {
    return this.store.withMutationLock(`aoss:${collection.accountId}:${collection.region}`, async () => {
      const state = this.host.state(collection.region, collection.accountId), streams = this.streams(collection.region, collection.accountId), now = this.clock.now();
      const tokenKey = input.clientToken ? digest(['stream', operation, input.clientToken]) : undefined, { clientToken, ...payload } = input, fingerprint = digest(canonical(payload));
      if (tokenKey && state.tokens[tokenKey]?.expires > now) { if (state.tokens[tokenKey].fingerprint !== fingerprint) invalid('Client token was reused with different parameters'); return structuredClone(state.tokens[tokenKey].response); }
      if (operation === 'ListIngestionStreams') { const page = this.host.page(state, Object.values(streams).filter(stream => stream.collectionId === collection.id && stream.status !== 'DELETED'), input, `ingestion-streams:${collection.id}`); return { ingestionStreamSummaries: page.items.map(stream => { const { ingestionStreamId, ingestionStreamName, arn, indexName, status, createdAt, updatedAt } = this.detail(stream); return { ingestionStreamId, ingestionStreamName, arn, indexName, status, createdAt, updatedAt }; }), ...(page.nextToken ? { nextToken: page.nextToken } : {}) }; }
      let stream = streams[input.ingestionStreamId], created = false;
      if (operation === 'CreateIngestionStream') {
        if (!this.ports || !this.source || this.closing) invalid('Stream source services are unavailable');
        if (!this.host.eligible(collection) || collection.status !== 'ACTIVE') invalid('Ingestion streams require an active NextGen SEARCH or VECTORSEARCH collection');
        const source = input.source?.s3, queue = /^arn:aws:sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(source?.sqsArn ?? ''), role = /^arn:aws:iam::(\d{12}):role\/.+$/.exec(input.roleArn ?? '');
        if (!queue || queue[1] !== collection.region || queue[2] !== collection.accountId || !role || role[1] !== collection.accountId) invalid('Streams require a same-account, same-Region standard SQS queue and same-account IAM role');
        const buckets = source.buckets ?? [];
        if (!Array.isArray(buckets) || buckets.length > 5 || new Set(buckets.map((item: any) => typeof item?.bucket === 'string' ? bucketName(item.bucket) : '')).size !== buckets.length) invalid('Streams support at most five distinct source buckets');
        for (const bucket of buckets) { if (typeof bucket.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName(bucket.bucket)) || bucket.bucketOwnerAccountId !== undefined && bucket.bucketOwnerAccountId !== collection.accountId || bucket.initialScan !== undefined && !['ENABLED', 'DISABLED'].includes(bucket.initialScan)) invalid('Invalid source bucket or initial scan mode'); this.source!.validate({ bucket: bucketName(bucket.bucket), prefix: '', region: collection.region }, collection.accountId); }
        const failureIndex = input.failureIndexName ?? `${input.indexName}-ingestion-failures`;
        for (const index of [input.indexName, failureIndex]) if (typeof index !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(index)) invalid('Invalid target or failure index name');
        if (failureIndex === input.indexName) invalid('The failure index must differ from the target index');
        if (Object.values(streams).some(stream => stream.collectionId === collection.id && stream.name === input.ingestionStreamName && stream.status !== 'DELETED')) throw new AwsError('ConflictException', 'Ingestion stream name already exists', 400);
        if (this.all().some(stream => !terminal(stream) && stream.source.s3.sqsArn === source.sqsArn)) throw new AwsError('ConflictException', 'The SQS queue already has an active ingestion stream', 400);
        const active = [...Object.values(streams).filter(stream => !terminal(stream)), ...Object.values(state.ingestionJobs ?? {}).filter(job => !['COMPLETED', 'CANCELLED', 'FAILED', 'CREATE_FAILED', 'CANCEL_FAILED'].includes(job.status))];
        if (active.some(record => record.collectionId === collection.id && [record.indexName, record.failureIndexName].some(index => [input.indexName, failureIndex].includes(index)))) throw new AwsError('ConflictException', 'Another active ingestion uses a target or failure index', 400);
        if (Object.keys(streams).length >= 100 || this.all().filter(stream => !terminal(stream)).length >= 20) throw new AwsError('ServiceQuotaExceededException', 'Stream history or active-stream limit reached', 400);
        const tags: Record<string, string> = {}; for (const tag of input.tags ?? []) { if (tag.key.toLowerCase().startsWith('aws:') || Object.hasOwn(tags, tag.key)) invalid('Duplicate or reserved stream tags'); Object.defineProperty(tags, tag.key, { value: tag.value, enumerable: true, configurable: true, writable: true }); }
        const id = randomBytes(16).toString('hex');
        stream = { id, name: input.ingestionStreamName, arn: `${collection.arn}/ingestion-stream/${id}`, generation: randomUUID(), collectionId: collection.id, collectionGeneration: collection.generation, accountId: collection.accountId, region: collection.region, roleArn: input.roleArn, indexName: input.indexName, failureIndexName: failureIndex, source: structuredClone(input.source), status: 'CREATING', state: 'STARTING', statistics: { s3: { objectsDiscovered: 0, objectsIngested: 0, objectsFailed: 0 } }, revision: 1, createdAt: now, updatedAt: now, tags };
        this.ports!.validateQueue(stream); streams[id] = stream; created = true;
      } else if (!stream || stream.collectionId !== collection.id) throw new AwsError('ResourceNotFoundException', 'Ingestion stream does not exist in this collection', 400);
      if (operation === 'GetIngestionStream') return { ingestionStreamDetail: this.detail(stream) };
      const previous = structuredClone(stream);
      if (operation === 'DeleteIngestionStream' && stream.status !== 'DELETED') { stream.status = 'DELETING'; stream.updatedAt = now; stream.revision++; }
      const result = operation === 'CreateIngestionStream' ? { ingestionStreamDetail: this.detail(stream) } : { ingestionStreamId: stream.id, collectionId: stream.collectionId, ingestionStreamName: stream.name, status: stream.status };
      const tokens = structuredClone(state.tokens); this.publishing.add(stream.id);
      try { for (const [key, token] of Object.entries(state.tokens)) if (token.expires <= now) delete state.tokens[key]; if (tokenKey) { if (Object.keys(state.tokens).length >= 1000) throw new AwsError('ServiceQuotaExceededException', 'Idempotency capacity reached', 400); state.tokens[tokenKey] = { fingerprint, response: result, expires: now + 86400000 }; } await this.store.save(); }
      catch (error) { if (created) delete streams[stream.id]; else Object.assign(stream, previous); state.tokens = tokens; throw error; }
      finally { this.publishing.delete(stream.id); }
      this.schedule(0); return result;
    });
  }
  private async work(original: ServerlessStream): Promise<void> {
    let work: ServerlessIngestionStore | undefined, stage = 'SOURCE';
    const current = () => this.streams(original.region, original.accountId)[original.id];
    const active = () => !this.closing && !this.publishing.has(original.id) && current() && !terminal(current()) && current().status !== 'DELETING' && this.host.state(original.region, original.accountId).collections[original.collectionId]?.status === 'ACTIVE';
    try {
      let stream = current(); if (!stream) return;
      const path = this.location(stream);
      if (stream.status === 'DELETING') { await rm(path.directory, { recursive: true, force: true }); await rm(path.key, { force: true }); await this.publish(stream, value => { value.status = 'DELETED'; value.state = 'STOPPED'; delete value.activeAlerts; delete value.failureReasons; delete value.retryAt; }); return; }
      if (!active() || !this.ports || !this.source) return;
      const assume = () => this.ports!.assume(current());
      // Revalidate trust even while delivering a previously admitted encrypted batch.
      await assume(); this.ports.validateQueue(stream);
      if (stream.storageReady) { await access(path.file); await access(path.key); }
      work = new ServerlessIngestionStore(path.file, path.key);
      if (!work.progress().stream?.initialized) {
        const objects: StreamObject[] = [];
        for (const bucket of stream.source.s3.buckets ?? []) if (bucket.initialScan === 'ENABLED') { const name = bucketName(bucket.bucket), listed = await this.source.list({ bucket: name, prefix: '', region: stream.region }, await assume()); for (const object of listed) objects.push({ ...object, bucket: name }); if (objects.length > 1000) invalid('Initial scan exceeds 1000 objects'); }
        if (!active()) return; work.streamBatch(objects.sort((a, b) => Buffer.compare(Buffer.from(`${a.bucket}/${a.key}`), Buffer.from(`${b.bucket}/${b.key}`))));
      }
      if (!stream.storageReady) await this.publish(stream, value => { value.storageReady = true; if (value.status !== 'DELETING') { value.status = 'ACTIVE'; value.state = 'SCANNING'; } });
      if (!active()) return;
      let progress = work.progress();
      if (progress.cursor >= (progress.objects?.length ?? 0)) {
        if (progress.stream!.message) {
          work.completeStreamMessage();
          try { await this.ports.acknowledge(stream, progress.stream!.message, await assume()); } catch (error) { if (!(error instanceof AwsError && error.code === 'ReceiptHandleIsInvalid')) throw error; }
          work.clearStreamMessage();
        }
        const message = await this.ports.receive(stream, await assume()); if (!active()) return;
        if (message) {
          if (work.progress().stream!.completed.includes(message.id)) { await this.ports.acknowledge(stream, message, await assume()); return; }
          let objects: StreamObject[];
          try { objects = parseServerlessNotification(message.body, stream); } catch { objects = [{ bucket: '', key: message.id, etag: '', size: 0, lastModified: 0, failure: 'Malformed, unsupported or out-of-scope S3 notification' }]; }
          work.streamBatch(objects, { id: message.id, receipt: message.receipt });
        } else { if (stream.state !== 'INGESTION_COMPLETE' || stream.activeAlerts?.length) await this.publish(stream, value => { if (value.status !== 'DELETING') value.state = 'INGESTION_COMPLETE'; delete value.activeAlerts; delete value.retryAt; value.attempts = 0; }); return; }
      }
      progress = work.progress(); const object = progress.objects?.[progress.cursor] as StreamObject | undefined;
      if (!object || !active()) return;
      if (!work.admitted()) {
        let documents: Record<string, any>[] = [], failure = object.failure;
        if (!failure) try { const bytes = object.notification ? await this.ports.read(stream, object, await assume()) : await this.source.read({ bucket: object.bucket, prefix: '', region: stream.region }, object, await assume()); documents = parseServerlessObject(bytes, object.key); }
        catch (error) { if (error instanceof AwsError && [400, 404, 409].includes(error.status)) failure = 'Source object is malformed, unsupported, stale, missing or exceeds local limits'; else throw error; }
        if (!active()) return; work.admit(documents, failure);
      }
      await this.publish(stream, value => { if (value.status !== 'DELETING') value.state = 'INGESTION_IN_PROGRESS'; });
      for (let n = 0; n < 20 && active(); n++) {
        const row = work.next(); if (!row) break;
        stream = current(); const collection = this.host.collection(stream.region, stream.collectionId, stream.accountId), principal = await assume(), id = digest([object.bucket || stream.source.s3.sqsArn, object.key, row.position]);
        let failure = row.failure; stage = 'DESTINATION';
        if (!failure) try { await this.host.write(collection, principal, stream.indexName, id, row.document!); } catch (error) { if (error instanceof SearchError && error.status === 400) failure = 'The target index rejected this document'; else throw error; }
        if (failure) await this.host.write(collection, principal, stream.failureIndexName, id, { ingestionSource: object.bucket ? { s3_uri: `s3://${object.bucket}/${object.key}`, s3_bucket: object.bucket } : { sqs_arn: stream.source.s3.sqsArn, message_id: object.key }, record: row.position, error: failure });
        work.acknowledge(row.position, Boolean(failure));
      }
      if (active() && !work.next()) work.finishObject();
      progress = work.progress(); await this.publish(stream, value => { delete value.retryAt; value.attempts = 0; delete value.activeAlerts; value.statistics.s3 = { objectsDiscovered: progress.stream!.discovered, objectsIngested: progress.objectsIngested, objectsFailed: progress.objectsFailed }; });
    } catch (error) {
      const status = error instanceof AwsError || error instanceof SearchError ? error.status : 500, code = status === 403 ? `${stage}_ACCESS_DENIED` : status === 404 ? `${stage}_RESOURCE_NOT_FOUND` : 'INTERNAL_SERVER_ERROR';
      await this.publish(original, stream => {
        if (stream.status === 'DELETING') { stream.status = 'DELETE_FAILED'; stream.state = 'FAILED'; stream.failureReasons = [{ code: 'INTERNAL_SERVER_ERROR', message: 'Encrypted stream work storage could not be removed; retry deletion' }]; return; }
        stream.attempts = (stream.attempts ?? 0) + 1; stream.retryAt = this.clock.now() + Math.min(60000, 1000 * 2 ** Math.min(6, stream.attempts - 1));
        stream.activeAlerts = [{ code, message: 'Stream ingestion is waiting for role trust, source/destination permissions, resources or encrypted storage recovery' }];
      }).catch(() => undefined);
    } finally { work?.close(); }
  }
}
