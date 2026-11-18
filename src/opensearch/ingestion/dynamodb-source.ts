import { createHash } from 'node:crypto';
import { AwsError } from '../../errors.js';
import type { PrincipalContext } from '../../auth/sigv4.js';
import type { PipelineRecord } from './model.js';
import type { IngestionBuffer } from './buffer.js';
import type { DynamoSourceConfig } from './dynamodb-config.js';

export interface DynamoCursor { streamArn: string; shardId: string; nextSequence: string; keys: string[] }
export interface DynamoSourcePort {
  validate(config: DynamoSourceConfig, account: string): void;
  open(config: DynamoSourceConfig, principal: PrincipalContext): Promise<DynamoCursor>;
  read(config: DynamoSourceConfig, cursor: DynamoCursor, principal: PrincipalContext): Promise<{ records: any[]; closed: boolean }>;
  startExport?(config: DynamoSourceConfig, token: string, time: number, principal: PrincipalContext): Promise<string>;
  readExport?(config: DynamoSourceConfig, arn: string, offset: number, principal: PrincipalContext): Promise<{ items: any[]; total: number; digest: string } | undefined>;
}
export interface DynamoSourceState {
  runId: string; startedAt: number; updatedAt: number;
  status: 'STARTING' | 'EXPORTING' | 'READING' | 'DELIVERING' | 'RETRYING' | 'BLOCKED' | 'COMPLETED';
  cursor?: DynamoCursor; pending?: { tag: string; remaining: number; nextSequence: string; closed: boolean; exportNextOffset?: number };
  export?: { token: string; time: number; version: number; arn?: string; offset: number; total?: number; completed?: boolean; digest?: string };
  accepted: number; delivered: number; deadLettered: number; attempts?: number; nextAttemptAt?: number; failure?: string;
}
export interface DynamoEvent { source: Record<string, any>; metadata: Record<string, string | number>; sequence: string }
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
function attribute(value: any, depth = 0): any {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || depth > 32) invalid('Invalid DynamoDB attribute');
  const [type, data] = Object.entries<any>(value)[0];
  if (type === 'S' || type === 'B') { if (typeof data !== 'string') invalid('Invalid string or binary attribute'); return data; }
  if (type === 'BOOL' && typeof data === 'boolean') return data;
  if (type === 'NULL' && data === true) return null;
  if (type === 'N') {
    // Refuse precision loss instead of silently rounding DynamoDB's 38-digit numbers.
    if (typeof data !== 'string' || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(data)) invalid('Invalid numeric attribute');
    const result = Number(data), digits = data.replace(/[eE].*$/, '').replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '');
    if (!Number.isFinite(result) || digits.length > 15 || Number.isInteger(result) && !Number.isSafeInteger(result) || result === 0 && /[1-9]/.test(data.split(/[eE]/)[0])) invalid('DynamoDB number exceeds the embedded JSON precision profile');
    return result;
  }
  if (['SS', 'NS', 'BS', 'L'].includes(type) && Array.isArray(data)) return data.map(item => attribute(type === 'L' ? item : { [type[0]]: item }, depth + 1));
  if (type === 'M' && data && typeof data === 'object' && !Array.isArray(data)) return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, attribute(item, depth + 1)]));
  return invalid('Unsupported DynamoDB attribute');
}
export function dynamoEvents(records: any[], cursor: DynamoCursor, table: string): DynamoEvent[] {
  let previous = BigInt(cursor.nextSequence) - 1n;
  return records.map(record => {
    const data = record.dynamodb, sequence = data?.SequenceNumber;
    if (typeof sequence !== 'string' || !/^\d+$/.test(sequence) || BigInt(sequence) <= previous || BigInt(sequence) > BigInt(Number.MAX_SAFE_INTEGER)) invalid('DynamoDB sequence is out of order or exceeds the local version range');
    previous = BigInt(sequence);
    if (!['INSERT', 'MODIFY', 'REMOVE'].includes(record.eventName)) invalid('Unsupported DynamoDB stream event');
    // Match Data Prepper's key convention; reject ambiguous composite keys.
    const keys = cursor.keys.map(key => {
      const value = data.Keys?.[key]; if (!value || !Object.hasOwn(value, 'S') || typeof value.S !== 'string' || value.S.includes('|')) invalid('The local DynamoDB ingestion profile requires string keys without |'); return value.S as string;
    });
    const id = keys.join('|'); if (!id || Buffer.byteLength(id) > 512) invalid('DynamoDB primary key exceeds the 512-byte document ID limit');
    const image = record.eventName === 'REMOVE' ? data.Keys : data.NewImage;
    if (!image || typeof image !== 'object' || Array.isArray(image)) invalid('DynamoDB ingestion requires NEW_IMAGE or NEW_AND_OLD_IMAGES');
    const source = Object.fromEntries(Object.entries(image).map(([key, value]) => [key, attribute(value)]));
    return { source, sequence, metadata: { primary_key: id, partition_key: keys[0], ...(keys.length > 1 ? { sort_key: keys[1] } : {}), table_name: table, opensearch_action: record.eventName === 'REMOVE' ? 'delete' : 'index', document_version: Number(sequence), dynamodb_event_name: record.eventName, dynamodb_timestamp: data.ApproximateCreationDateTime * 1000 } };
  });
}
export async function pollDynamoSource(pipeline: PipelineRecord, buffer: IngestionBuffer, port: DynamoSourcePort, assume: () => Promise<PrincipalContext>, now: () => number, active: () => boolean): Promise<void> {
  const config = pipeline.config, source = config.dynamodb; if (!source || !pipeline.sourceRunId) return;
  let state = buffer.stream();
  if (!state || state.runId !== pipeline.sourceRunId) { state = { runId: pipeline.sourceRunId, startedAt: now(), updatedAt: now(), status: 'STARTING', accepted: 0, delivered: 0, deadLettered: 0 }; buffer.saveStream(state); }
  if (state.pending || ['BLOCKED', 'COMPLETED'].includes(state.status) || (state.nextAttemptAt ?? 0) > now()) return;
  const current = () => active() && pipeline.config === config && pipeline.sourceRunId === state!.runId;
  try {
    const principal = await assume(); if (!current()) return;
    if (!state.cursor) {
      state.cursor = await port.open(source, principal); if (!current()) return;
      if (source.export) { const version = Number(BigInt(state.cursor.nextSequence) - 1n); if (!Number.isSafeInteger(version) || version < 0) invalid('Snapshot version exceeds local bounds'); state.export = { token: createHash('sha256').update(state.runId).digest('hex').slice(0, 32), time: Math.floor(now() / 1000) * 1000, version, offset: 0 }; }
      state.status = source.export ? 'EXPORTING' : 'READING'; buffer.saveStream(state);
    }
    if (source.export && !state.export?.completed) {
      if (!state.export || !port.startExport || !port.readExport) invalid('DynamoDB export integration is unavailable');
      const snapshot = state.export!; state.status = 'EXPORTING';
      if (!snapshot.arn) { snapshot.arn = await port.startExport!(source, snapshot.token, snapshot.time, principal); if (!current()) return; buffer.saveStream(state); }
      const result = await port.readExport!(source, snapshot.arn, snapshot.offset, principal); if (!current()) return;
      if (!result) { state.updatedAt = now(); state.attempts = 0; delete state.failure; delete state.nextAttemptAt; buffer.saveStream(state); return; }
      if (!/^[a-f0-9]{64}$/.test(result.digest) || snapshot.digest && snapshot.digest !== result.digest) invalid('Export artifacts changed after initial admission');
      snapshot.digest = result.digest;
      if (!Number.isSafeInteger(result.total) || result.total < snapshot.offset || result.total > 1000 || result.items.length > 100 || snapshot.offset + result.items.length > result.total) invalid('Invalid export page');
      snapshot.total = result.total;
      if (snapshot.offset === result.total) { snapshot.completed = true; state.status = 'READING'; buffer.saveStream(state); }
      else {
        if (!result.items.length) invalid('Export data ended before its declared item count');
        const records = result.items.map((item, position) => ({ eventName: 'INSERT', dynamodb: { SequenceNumber: String(snapshot.offset + position + 1), ApproximateCreationDateTime: snapshot.time / 1000, Keys: Object.fromEntries(state!.cursor!.keys.map(key => [key, item[key]])), NewImage: item } }));
        const events = dynamoEvents(records, { ...state.cursor, nextSequence: String(snapshot.offset + 1) }, source.table); for (const event of events) event.metadata.document_version = snapshot.version;
        const tag = createHash('sha256').update(JSON.stringify([state.runId, snapshot.arn, snapshot.offset])).digest('hex');
        state.updatedAt = now(); state.attempts = 0; delete state.failure; delete state.nextAttemptAt;
        buffer.acceptStream(events, config, now(), state, tag, false, snapshot.offset + events.length); return;
      }
    }
    const result = await port.read(source, state.cursor, principal); if (!current()) return;
    const events = dynamoEvents(result.records, state.cursor, source.table);
    const tag = createHash('sha256').update(JSON.stringify([state.runId, state.cursor.streamArn, state.cursor.nextSequence])).digest('hex');
    state.updatedAt = now(); state.attempts = 0; delete state.failure; delete state.nextAttemptAt;
    buffer.acceptStream(events, config, now(), state, tag, result.closed);
  } catch (error) {
    if (!current()) return;
    state = buffer.stream()!;
    const code = error instanceof AwsError ? error.code : '', status = error instanceof AwsError ? error.status : 500;
    const terminal = ['TrimmedDataAccessException', 'ResourceNotFoundException', 'ValidationException', 'ConflictException'].includes(code);
    state.status = terminal ? 'BLOCKED' : 'RETRYING';
    state.failure = code === 'TrimmedDataAccessException' ? 'DynamoDB stream retention passed the checkpoint; recreate the pipeline with a new index after resynchronizing source data' : terminal ? 'The source stream changed, disappeared or contains unsupported data; inspect the source and recreate after correction' : status === 403 ? 'DynamoDB source access was denied; check the pipeline role and resource policy' : 'DynamoDB stream read or buffer admission is temporarily unavailable';
    state.attempts = (state.attempts ?? 0) + 1; state.updatedAt = now(); state.nextAttemptAt = now() + Math.min(60000, 1000 * 2 ** Math.min(6, state.attempts - 1)); buffer.saveStream(state);
  }
}
