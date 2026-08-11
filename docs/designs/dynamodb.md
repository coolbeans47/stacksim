# DynamoDB design notes (DUG-12 excerpt)

## Import/export with local S3

DynamoDB export/import uses an S3-owned transfer port rather than reading or mutating S3 journal/index files from DynamoDB.

### Authorization contract

- Principal: `dynamodb.amazonaws.com`
- Context: `aws:SourceAccount`, `aws:SourceArn` (table ARN for export; import ARN for import)
- Bucket must be same-Region; cross-account requires matching `S3BucketOwner`
- `S3BucketSource` has no version-ID member; admission resolves and pins current generations

### Job durability

1. Persist `IN_PROGRESS` descriptor (`stage=ADMITTED`) before S3/table side effects
2. Checkpoint stages: snapshot → data object (checkpointed) → manifests (export); pin objects → decode/checkpoint items → table → populate → validate → promote (import)
3. Startup resumes from checkpoints; never converts unfinished work to `COMPLETED`
4. Failure codes/messages are modeled on the job description; partial import tables are cleaned when safe; export data-key overwrite conflicts surface as `S3ObjectConflict`

### Codecs

Supported: `DYNAMODB_JSON` with `NONE`/`GZIP` and AWS-style manifests/checksums.  
Rejected: Ion, CSV, ZSTD, incremental export, KMS SSE (DDB-14).
