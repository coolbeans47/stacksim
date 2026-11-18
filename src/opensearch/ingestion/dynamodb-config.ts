import { AwsError } from '../../errors.js';

export interface DynamoSourceConfig { tableArn: string; table: string; account: string; region: string; roleArn: string; startPosition: 'LATEST' | 'TRIM_HORIZON'; export?: { bucket: string; prefix: string } }
export const DYNAMO_METADATA = ['primary_key', 'partition_key', 'sort_key', 'table_name', 'opensearch_action', 'document_version', 'dynamodb_event_name', 'dynamodb_timestamp'] as const;
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
function object(value: any, keys: string[], label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(`Unsupported ${label} configuration`);
  return value;
}
export function parseDynamoSource(value: any, roleArn: string, region: string): DynamoSourceConfig {
  const source = object(value, ['tables', 'aws', 'acknowledgments'], 'DynamoDB source');
  if (source.acknowledgments !== true) invalid('DynamoDB source requires acknowledgments: true');
  if (!Array.isArray(source.tables) || source.tables.length !== 1) invalid('DynamoDB source supports exactly one table');
  const table = object(source.tables[0], ['table_arn', 'stream', 'export'], 'DynamoDB table');
  const match = /^arn:aws(?:-[a-z]+)?:dynamodb:([^:]+):(\d{12}):table\/([A-Za-z0-9_.-]{3,255})$/.exec(table.table_arn);
  if (!match || match[1] !== region) return invalid('DynamoDB table must use the pipeline Region');
  const stream = object(table.stream, ['start_position'], 'DynamoDB stream');
  if (!['LATEST', 'TRIM_HORIZON'].includes(stream.start_position)) invalid('DynamoDB stream start_position must be LATEST or TRIM_HORIZON');
  const aws = object(source.aws, ['region', 'sts_role_arn'], 'DynamoDB aws');
  if (aws.region !== region || aws.sts_role_arn !== undefined && aws.sts_role_arn !== roleArn) invalid('DynamoDB source must use the pipeline Region and role');
  let snapshot: DynamoSourceConfig['export'];
  if (table.export !== undefined) {
    const options = object(table.export, ['s3_bucket', 's3_prefix'], 'DynamoDB export');
    if (typeof options.s3_bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.s3_bucket) || options.s3_prefix !== undefined && (typeof options.s3_prefix !== 'string' || Buffer.byteLength(options.s3_prefix) > 512)) invalid('DynamoDB exports require a bucket name and an optional literal prefix of at most 512 bytes');
    if (stream.start_position !== 'LATEST') invalid('DynamoDB initial export requires stream start_position LATEST');
    snapshot = { bucket: options.s3_bucket, prefix: options.s3_prefix ?? '' };
  }
  return { tableArn: table.table_arn, table: match[3], account: match[2], region, roleArn, startPosition: stream.start_position, ...(snapshot ? { export: snapshot } : {}) };
}
