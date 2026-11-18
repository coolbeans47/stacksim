import { AwsError } from '../../errors.js';

export interface S3ScanConfig {
  bucket: string; prefix: string; excludeSuffix: string[]; region: string; roleArn: string;
  startTime?: number; endTime?: number; rangeMs?: number;
  codec: 'ndjson'; compression: 'none' | 'gzip';
}
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
function object(value: any, keys: string[], name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(`Unsupported or invalid ${name}`);
  return value;
}
function timestamp(value: any): number | undefined {
  if (value === undefined) return;
  // Missing timezone is UTC, never the machine's local timezone.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/.test(value)) invalid('S3 scan times require an ISO UTC timestamp');
  const date = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  if (!Number.isFinite(date) || date < 0 || new Date(date).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid('Invalid S3 scan timestamp');
  return date;
}
function duration(value: any): number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string') invalid('S3 scan range must be a duration');
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/.exec(value), simple = /^(\d+(?:\.\d{1,3})?)(ms|s)$/.exec(value);
  const milliseconds = iso ? (Number(iso[1] ?? 0) * 86400 + Number(iso[2] ?? 0) * 3600 + Number(iso[3] ?? 0) * 60 + Number(iso[4] ?? 0)) * 1000 : simple ? Number(simple[1]) * (simple[2] === 's' ? 1000 : 1) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 366 * 86400000) invalid('S3 scan range must be a positive duration of at most 366 days');
  return milliseconds;
}
export function parseS3Scan(value: any, roleArn: string, region: string): S3ScanConfig {
  const source = object(value, ['aws', 'scan', 'codec', 'compression', 'acknowledgments', 'delete_s3_objects_on_read'], 'S3 source');
  const aws = object(source.aws, ['region', 'sts_role_arn'], 'S3 source AWS options');
  if (aws.region !== region || aws.sts_role_arn !== undefined && aws.sts_role_arn !== roleArn) invalid('S3 source must use the pipeline role and Region');
  if (source.acknowledgments !== true) invalid('S3 scans require acknowledgments: true');
  if (source.delete_s3_objects_on_read !== undefined && source.delete_s3_objects_on_read !== false) invalid('Deleting source objects is not supported');
  const codec = object(source.codec, ['ndjson'], 'S3 codec'); object(codec.ndjson ?? (Object.hasOwn(codec, 'ndjson') ? {} : undefined), [], 'NDJSON codec');
  const compression = source.compression ?? 'none'; if (!['none', 'gzip'].includes(compression)) invalid('S3 compression must be none or gzip');
  const scan = object(source.scan, ['start_time', 'end_time', 'range', 'buckets'], 'S3 scan');
  if (!Array.isArray(scan.buckets) || scan.buckets.length !== 1) invalid('An embedded S3 scan requires exactly one bucket');
  const bucket = object(object(scan.buckets[0], ['bucket'], 'scan bucket').bucket, ['name', 'filter', 'start_time', 'end_time', 'range'], 'scan bucket options');
  if (typeof bucket.name !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.name)) invalid('Invalid S3 source bucket');
  const filter = bucket.filter === undefined ? {} : object(bucket.filter, ['include_prefix', 'exclude_suffix'], 'S3 key filter');
  const prefixes = filter.include_prefix ?? [''], suffixes = filter.exclude_suffix ?? [];
  if (!Array.isArray(prefixes) || prefixes.length !== 1 || typeof prefixes[0] !== 'string' || Buffer.byteLength(prefixes[0]) > 1024) invalid('S3 scans support one literal include_prefix');
  if (!Array.isArray(suffixes) || suffixes.length > 20 || suffixes.some(value => typeof value !== 'string' || !value.length || value.length > 128)) invalid('S3 scans support at most 20 literal exclude_suffix values');
  const startTime = timestamp(bucket.start_time ?? scan.start_time), endTime = timestamp(bucket.end_time ?? scan.end_time), rangeMs = duration(bucket.range ?? scan.range);
  if (rangeMs !== undefined && (startTime !== undefined || endTime !== undefined) || startTime !== undefined && endTime !== undefined && startTime >= endTime) invalid('S3 scan time window is conflicting or reversed');
  return { bucket: bucket.name, prefix: prefixes[0], excludeSuffix: suffixes, region, roleArn, codec: 'ndjson', compression, ...(startTime === undefined ? {} : { startTime }), ...(endTime === undefined ? {} : { endTime }), ...(rangeMs === undefined ? {} : { rangeMs }) };
}
