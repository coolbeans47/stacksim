import type { AuthorizationResult } from "../iam/evaluator.js";

/** DynamoDB's fixed S3 service principal for import/export. */
export const DYNAMODB_S3_SERVICE_PRINCIPAL = "dynamodb.amazonaws.com" as const;

/**
 * Narrow caller identity DynamoDB presents to S3 for authorized transfers.
 * Lineage is the table/export/import ARN chain used for SourceArn conditions.
 */
export interface S3TransferCaller {
  servicePrincipal: typeof DYNAMODB_S3_SERVICE_PRINCIPAL;
  sourceAccount: string;
  /** Primary SourceArn (table ARN for export; import ARN or table ARN for import). */
  sourceArn: string;
  expectedBucketOwner?: string;
}

/** Generation/version pin resolved at admission; later reads must use this identity. */
export interface S3PinnedObject {
  bucket: string;
  key: string;
  versionId: string;
  etag: string;
  size: number;
  storageClass: string;
}

export interface S3TransferWriteOptions {
  contentType?: string;
  contentEncoding?: string;
  metadata?: Record<string, string>;
  /** When true, refuse to overwrite an existing current object. */
  failIfExists?: boolean;
}

export interface S3AdmittedBucket {
  name: string;
  ownerAccountId: string;
  region: string;
}

/**
 * S3-owned transfer port used by DynamoDB import/export.
 * Callers must never touch S3 state files or indexes directly.
 */
export interface S3TransferPort {
  admitBucket(bucket: string, caller: S3TransferCaller): Promise<S3AdmittedBucket>;
  authorize(caller: S3TransferCaller, action: string, resource: string): Promise<AuthorizationResult>;
  requireAuthorized(caller: S3TransferCaller, action: string, resource: string): Promise<void>;
  pinCurrentObject(bucket: string, key: string, caller: S3TransferCaller): Promise<S3PinnedObject>;
  listAndPinPrefix(bucket: string, prefix: string, caller: S3TransferCaller): Promise<S3PinnedObject[]>;
  readPinned(pin: S3PinnedObject, caller: S3TransferCaller, maximumBytes?: number): Promise<Buffer>;
  writeObject(bucket: string, key: string, body: Uint8Array, caller: S3TransferCaller, options?: S3TransferWriteOptions): Promise<S3PinnedObject>;
  currentObjectExists(bucket: string, key: string): Promise<boolean>;
}
