import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AwsError } from '../../errors.js';
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
function json(bytes: Buffer): any { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid('Malformed DynamoDB export manifest'); } }
/** Consume only the real DynamoDB-owned single-file FULL_EXPORT profile. */
export async function readDynamoExport(description: any, read: (key: string) => Promise<Buffer>): Promise<{ items: any[]; total: number; digest: string }> {
  if (description.ExportStatus !== 'COMPLETED' || description.ExportFormat !== 'DYNAMODB_JSON' || description.ExportType !== 'FULL_EXPORT' || !Number.isSafeInteger(description.ItemCount) || description.ItemCount < 0 || description.ItemCount > 1000) invalid('Initial exports support at most 1000 items in DynamoDB JSON format');
  const summaryKey = description.ExportManifest;
  if (typeof summaryKey !== 'string' || !summaryKey.endsWith('/manifest-summary.json')) invalid('Invalid export manifest key');
  const prefix = summaryKey.slice(0, -'manifest-summary.json'.length), summaryBytes = await read(summaryKey);
  if (summaryBytes.length > 1024 * 1024) invalid('Export summary exceeds 1 MiB');
  const summaryChecksum = await read(`${prefix}manifest-summary.checksum`);
  if (summaryChecksum.toString('utf8').trim() !== createHash('md5').update(summaryBytes).digest('hex')) invalid('Export summary checksum mismatch');
  const summary = json(summaryBytes);
  if (summary.exportArn !== description.ExportArn || summary.tableArn !== description.TableArn || summary.tableId !== description.TableId || summary.s3Bucket !== description.S3Bucket || summary.itemCount !== description.ItemCount || summary.outputFormat !== 'DYNAMODB_JSON' || summary.manifestFilesS3Key !== `${prefix}manifest-files.json`) invalid('Export summary does not match the source export');
  const filesBytes = await read(summary.manifestFilesS3Key), filesChecksum = await read(`${prefix}manifest-files.checksum`);
  if (filesBytes.length > 1024 * 1024 || filesChecksum.toString('utf8').trim() !== createHash('md5').update(filesBytes).digest('hex')) invalid('Export file manifest checksum mismatch');
  const file = json(filesBytes);
  if (file.dataFileS3Key !== `${prefix}data/data.json.gz` || file.itemCount !== description.ItemCount || typeof file.md5Checksum !== 'string') invalid('Export requires the local single-file snapshot format');
  const compressed = await read(file.dataFileS3Key);
  if (compressed.length > 10 * 1024 * 1024 || createHash('md5').update(compressed).digest('base64') !== file.md5Checksum) invalid('Export data checksum or size mismatch');
  let bytes: Buffer; try { bytes = gunzipSync(compressed, { maxOutputLength: 10 * 1024 * 1024 }); } catch { return invalid('Malformed or oversized DynamoDB export data'); }
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid('Export data is not UTF-8'); }
  const items: any[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = text.indexOf('\n', offset), line = text.slice(offset, end < 0 ? text.length : end).trim(); offset = end < 0 ? text.length : end + 1;
    if (!line) continue;
    if (items.length >= 1000 || Buffer.byteLength(line) > 1024 * 1024) invalid('Export record exceeds local limits');
    const value = json(Buffer.from(line)); if (!value?.Item || typeof value.Item !== 'object' || Array.isArray(value.Item) || Object.keys(value).length !== 1) invalid('Export records require a DynamoDB Item');
    items.push(value.Item);
  }
  if (items.length !== description.ItemCount) invalid('Export item count does not match its manifest');
  return { items, total: items.length, digest: createHash('sha256').update(summaryBytes).update(filesBytes).update(compressed).digest('hex') };
}
