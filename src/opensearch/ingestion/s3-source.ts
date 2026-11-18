import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AwsError } from '../../errors.js';
import type { PrincipalContext } from '../../auth/sigv4.js';
import type { IngestionBuffer } from './buffer.js';
import type { IngestionConfig } from './config.js';
import type { PipelineRecord } from './model.js';
import type { S3ScanConfig } from './s3-config.js';

export interface ScanObject { key: string; versionId?: string; etag: string; size: number; lastModified: number }
export type S3ReadSource = Pick<S3ScanConfig, 'bucket' | 'region' | 'prefix'>;
export interface S3SourcePort {
  validate(config: S3ReadSource, account: string): void;
  list(config: S3ReadSource, principal: PrincipalContext): Promise<ScanObject[]>;
  read(config: S3ReadSource, object: ScanObject, principal: PrincipalContext): Promise<Buffer>;
}
export interface S3ScanState {
  runId: string; startedAt: number; updatedAt: number;
  status: 'LISTING' | 'READING' | 'DELIVERING' | 'RETRYING' | 'BLOCKED' | 'COMPLETED' | 'COMPLETED_WITH_FAILURES';
  objects?: ScanObject[]; cursor: number; accepted: number; delivered: number; deadLettered: number;
  pending?: { tag: string; remaining: number }; nextAttemptAt?: number; attempts?: number; failure?: string;
}
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
export function parseS3Events(bytes: Buffer, config: S3ScanConfig): Record<string, any>[] {
  if (bytes.length > 10 * 1024 * 1024) invalid('S3 source object exceeds 10 MiB');
  if (config.compression === 'gzip') try { bytes = gunzipSync(bytes, { maxOutputLength: 10 * 1024 * 1024 }); } catch { invalid('S3 object has malformed or oversized gzip content'); }
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid('S3 object is not valid UTF-8'); }
  const events: Record<string, any>[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = text.indexOf('\n', offset), line = text.slice(offset, end < 0 ? text.length : end).replace(/\r$/, ''); offset = end < 0 ? text.length : end + 1;
    if (!line.trim()) continue;
    if (events.length >= 1000 || Buffer.byteLength(line) > 1024 * 1024) invalid('S3 objects support at most 1000 events of at most 1 MiB each');
    let event: any; try { event = JSON.parse(line); } catch { return invalid('S3 object contains malformed NDJSON'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) invalid('S3 NDJSON events must be JSON objects');
    events.push(event);
  }
  return events;
}

/** One object is durably admitted as a unit, and its checkpoint advances only
 * after every event reaches the sink or a configured DLQ. A process restart
 * retains the listing and buffered rows; it does not start a second scan. */
export async function pollS3Source(pipeline: PipelineRecord, buffer: IngestionBuffer, port: S3SourcePort, assume: () => Promise<PrincipalContext>, now: () => number, active: () => boolean): Promise<void> {
  const config = pipeline.config, source = config.s3; if (!source || !pipeline.sourceRunId) return;
  let state = buffer.scan();
  if (!state || state.runId !== pipeline.sourceRunId) {
    state = { runId: pipeline.sourceRunId, startedAt: now(), updatedAt: now(), status: 'LISTING', cursor: 0, accepted: 0, delivered: 0, deadLettered: 0 }; buffer.saveScan(state);
  }
  if (state.pending || ['BLOCKED', 'COMPLETED', 'COMPLETED_WITH_FAILURES'].includes(state.status) || (state.nextAttemptAt ?? 0) > now()) return;
  const current = () => active() && pipeline.config === config && pipeline.sourceRunId === state!.runId;
  try {
    const principal = await assume(); if (!current()) return;
    if (!state.objects) {
      const objects = await port.list(source, principal); if (!current()) return;
      const start = source.rangeMs === undefined ? source.startTime : state.startedAt - source.rangeMs, end = source.rangeMs === undefined ? source.endTime : state.startedAt;
      state.objects = objects.filter(item => item.key.startsWith(source.prefix) && !source.excludeSuffix.some(suffix => item.key.endsWith(suffix)) && (start === undefined || item.lastModified >= start) && (end === undefined || item.lastModified <= end)).sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
      if (state.objects.length > 1000) invalid('S3 scan exceeds the local limit of 1000 objects; narrow the prefix or time range');
      state.status = state.objects.length ? 'READING' : 'COMPLETED'; state.updatedAt = now(); delete state.failure; delete state.nextAttemptAt; state.attempts = 0; buffer.saveScan(state);
    }
    if (state.cursor >= state.objects.length) return;
    const object = state.objects[state.cursor];
    const bytes = await port.read(source, object, principal); if (!current()) return;
    const events = parseS3Events(bytes, source), tag = createHash('sha256').update(JSON.stringify([state.runId, object])).digest('hex');
    state.status = 'DELIVERING'; state.updatedAt = now(); state.attempts = 0; delete state.failure; delete state.nextAttemptAt;
    buffer.acceptScan(events, config, now(), state, tag);
  } catch (error) {
    if (!current()) return;
    const status = error instanceof AwsError ? error.status : 500;
    state = buffer.scan()!;
    // Never publish error text from object parsing or storage paths.
    state.failure = status === 403 ? 'S3 source access was denied; check the pipeline role and bucket policy' : status === 404 ? 'A listed source object is no longer available; start a new scan' : status === 400 || status === 409 ? 'The source listing or object is invalid, changed or exceeds the supported limits; start a new scan after correction' : status === 429 ? 'Source admission is waiting for buffer capacity' : 'S3 source storage or delivery is temporarily unavailable';
    state.status = [400, 404, 409].includes(status) ? 'BLOCKED' : 'RETRYING'; state.attempts = (state.attempts ?? 0) + 1; state.updatedAt = now(); state.nextAttemptAt = now() + Math.min(60000, 1000 * 2 ** Math.min(6, state.attempts - 1)); buffer.saveScan(state);
  }
}
