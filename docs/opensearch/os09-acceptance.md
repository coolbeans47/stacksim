# OS-09 producer integrations

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

AppSync managed-domain data sources, signed Lambda clients and provisioned
CloudWatch Logs transformer chains now execute. One-time S3 scan sources also execute;
DynamoDB CDC with optional initial PITR/S3 export and eight Serverless S3 job/stream APIs also execute. Broader producer/source profiles remain open. OS-09 is not complete.

`AMAZON_OPENSEARCH_SERVICE` with `openSearchServiceConfig` binds an existing
managed HTTPS endpoint in the GraphQL API account/Region. Create/update checks
the endpoint and service role. Invocations assume fresh credentials with
`appsync.amazonaws.com` and the API's source ARN/account. Ordinary IAM PassRole
controls configuration; domain HTTP IAM/resource policies and FGAC control each
request. The adapter uses the authoritative domain engine with normal admission
and authorization; it makes no arbitrary network requests and never exposes
credentials in data-source records.

VTL UNIT resolvers and function stages accept the `2017-02-28` request shape:
operation, absolute resource path and optional JSON headers/queryString/body.
GET, POST, PUT, HEAD and DELETE are supported. Only an application/json content
type can be supplied; authentication/host headers cannot be overridden. Body
and response limits are 1 MiB. Responses use the existing VTL evaluator with
`ctx.result` or `ctx.error`. Unsupported engine operations return real errors.
Endpoints remain generation-bound; deletion cannot silently retarget a source.

CloudFormation supports `AWS::AppSync::DataSource.OpenSearchServiceConfig`
through the same service path. The AppSync console offers OpenSearch source
create/edit/detail/delete and its ordinary role picker. Serverless, legacy
AMAZON_ELASTICSEARCH, arbitrary endpoints/headers, NDJSON bulk bodies and
APPSYNC_JS remain unsupported.

Two official SDK/CloudFormation tests cover mutation/read-through into the
actual search store, UNIT/function stages, PassRole, source-conditioned trust,
IAM and domain-policy denies, independent FGAC and FLS, restart, deleted
endpoints, stack create/update/cleanup and invalid account/Region endpoints.
The four relevant existing DynamoDB/pipeline tests pass. Desktop/mobile source
journeys cover errors, creation, editing and deletion. TypeScript checks pass.
Native/AWS reference runs, exhaustive failure cases and Linux/Windows execution
remain unverified. No full regression suite was run.

Reference: [AWS AppSync OpenSearch mapping templates](https://docs.aws.amazon.com/appsync/latest/devguide/resolver-mapping-template-reference-elasticsearch.html).

## Lambda and CloudWatch Logs

The [CDK producer example](../../examples/opensearch-producers/README.md) bundles
the official OpenSearch client with esbuild and deploys real Lambda roles, code,
source log group/subscription and SQS failure queue. Functions discover this
domain with their current execution credentials, verify TLS using the public
local CA and sign ordinary HTTPS requests. No host credentials, private keys or
simulator state are read by function code. Product operations target products;
Logs operations target dated logs indexes. Standard IAM, domain policies and
FGAC continue to apply. No Docker dependency is introduced.

The Logs transformer decodes DATA_MESSAGE envelopes, ignores CONTROL_MESSAGE,
and writes timestamp, message and source metadata with stable document IDs. It
chunks requests to 500 records / 5 MiB and rejects malformed or oversized input.
Both HTTP failures and per-item bulk errors fail the invocation. Existing Logs
checkpoints and the Lambda async queue own retry/restart semantics. Successful
replays upsert the same IDs; exactly-once delivery is not claimed. The CDK example
sends exhausted failures to a real SQS dead-letter queue.

Three focused tests cover official clients, IAM denial after a warm invocation,
independent FGAC/FLS, verified TLS, endpoint discovery, restart and deletion,
actual Logs delivery/permission checks, duplicate IDs, denied-delivery recovery
across restart, unmodified CDK resource deployment/cleanup and a bulk-item error
reaching the SQS queue. Two browser journeys create the permitted subscription
and find the delivered log in the search console at 1440/390 pixels; screenshots
were inspected. TypeScript checks pass. This covers the provisioned Lambda
workflow only: general Logs OpenSearch integrations/destination APIs, cross-account
and VPC routing remain separate requirements.

References: [Logs streaming setup](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_OpenSearch_Stream.html),
[request signing](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-signing-service-requests.html).

## S3 one-time scan source

OSIS now accepts a bounded S3 source using one same-account/Region bucket, one
literal included prefix and up to 20 excluded suffixes. NDJSON objects use strict
UTF-8 with optional gzip. Acknowledgments must be enabled; source deletion is
rejected. Optional UTC start/end or relative ranges select a fixed listing.
Bucket-level time values take precedence over corresponding scan-level values;
conflicting range/time combinations reject. Supported relative durations span
1 ms through 366 days; timezone-free timestamps are UTC on every platform.

The source assumes the actual pipeline role. ListBucket includes its prefix
condition; every read rechecks IAM and bucket policy. Versioned objects are pinned
and require GetObjectVersion. Unversioned reads require GetObject and verify
ETag, size and last-modified time against the listing. Missing/changed objects
block the run; archived objects cannot be read before restoration and SSE-C
objects reject. No S3 blob paths or private bucket state are read by ingestion.

A private encrypted checkpoint stores the frozen listing and current object.
All events from an object and its pending checkpoint commit together. The cursor
advances only when every event reaches the search sink or configured S3 DLQ;
DLQ outcomes produce COMPLETED_WITH_FAILURES. Permanent failures without a DLQ
block the scan while retaining failed events. Authorization/transient failures
retry with bounded backoff. Buffer backpressure permits existing records to
drain. Source contents are excluded from scan status/error text.

Process restart resumes the same run and accepted configurations. Explicit
Stop/Start creates a fresh scan, including for an unchanged window; this local
rerun behavior can reprocess files. Source changes start a new run; capacity-only
updates preserve it. Previously buffered events retain their original delivery
configuration. Use document_id for stable rerun upserts. Sink commit before
checkpoint publication can replay a write; delivery remains at least once.

Limits are 1,000 selected objects, 10 MiB stored/expanded per object, 1,000 events
per object, 1 MiB/event and a 2 MiB encrypted checkpoint counted within the 64 MiB
buffer. Oversized objects or objects that cannot fit an empty buffer block rather
than retry forever. Empty objects advance without fabricated records. One object
is admitted at a time; actual delivery capacity remains the OSIS worker budget.

S3 pipelines expose no HTTP intake in SDK or CloudFormation reads. The console
offers an executable S3 blueprint, errors, measured progress and explicit rerun
controls. ValidatePipeline checks supported syntax and bucket dependencies;
role/bucket access is independently enforced when the worker lists/reads.
CloudFormation creates, updates and removes the source through the same service.

Five focused tests cover configuration/parsing/bounds, encrypted atomic capture
and publication failure, window filters, interrupted reads, real SDK/S3 role and
bucket-policy enforcement, versioned objects, source/sink recovery and restart,
malformed objects, and CloudFormation source/capacity updates and cleanup. Two
forced-termination tests cover admission before sink delivery and sink commit
before checkpoint, including the expected replayed version. Two desktop/mobile
journeys cover S3 blueprint, denied access/recovery, progress and explicit rerun;
the two existing HTTP browser journeys and relevant seven Node HTTP/config/CFN
tests still pass. TypeScript checks pass. Native/AWS and Linux/Windows comparison
remain unverified.

SQS notifications, recurring scans, multiple buckets/prefixes, cross-account
sources, other codecs, source deletion, metadata expressions remain outside the S3 scan profile. DynamoDB CDC is a separate source described below.

References: [AWS S3 source](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/configure-client-s3.html),
[Data Prepper S3 options](https://docs.opensearch.org/latest/data-prepper/pipelines/configuration/sources/s3/).

## DynamoDB stream source

The `dynamodb` source now consumes the owning DynamoDB service's actual stream.
The supported configuration has one same-Region table in the installation
account, `acknowledgments: true`, the pipeline role, and `LATEST` or
`TRIM_HORIZON`. The table needs `NEW_IMAGE` or `NEW_AND_OLD_IMAGES`. Optional initial PITR/S3
export is implemented below with LATEST; TRIM_HORIZON reads retained changes,
not a table snapshot. Source definitions are immutable once selected. A new
source/table generation requires a new pipeline and a resynchronized new index.

Each poll assumes fresh service-role credentials and authorizes DescribeTable,
DescribeStream, GetShardIterator and GetRecords on their actual resources.
DynamoDB resource policies and resource tags apply. The adapter invokes the
owning service and never opens its private stream files. A narrow owner port
captures a durable numeric position instead of persisting an expiring public
iterator. LATEST starts at the first successful worker activation; records
before that capture are intentionally excluded. The stream ARN and shard are
pinned; replacement never silently resets a checkpoint.

One batch (at most 100 records / the owner GetRecords byte limit) is admitted
with its metadata in a single encrypted transaction. A batch's cursor advances
only after all records reach the sink or S3 DLQ. Stop/Start, process restart and
capacity updates preserve the position. Trimmed cursors block with an explicit
resynchronization error. Retryable permissions/storage failures retain work;
permanent mapping/data errors block without a DLQ. Failure objects include the
original source metadata needed to inspect the action, ID and version.

The sink requires `getMetadata("primary_key")`, `getMetadata("opensearch_action")`
and `getMetadata("document_version")`, with `document_version_type: external`.
Only managed domains are supported for this source. INSERT/MODIFY index the new
image; REMOVE deletes the same document and skips value processors. Index names
must be literal or use supported source metadata so deletes select the same
index. Metadata cannot be forged by an item field or modified by processors.
The documented metadata names are primary_key, partition_key, sort_key,
table_name, opensearch_action, document_version, dynamodb_event_name and
dynamodb_timestamp. Unknown expressions fail configuration validation.

The local key profile is string partition/sort keys without `|`, joined with
`|`, with a 512-byte ID maximum. Other key types/ambiguous IDs fail before batch
admission. Nested map/list/set/null/boolean/string/binary values are converted;
binary values remain base64 strings. Numbers are limited to finite JSON values
with at most 15 significant digits and safe integer magnitude; precision loss
or underflow is rejected. Local versions use the table's monotonic stream
sequence, bounded by Number.MAX_SAFE_INTEGER, rather than Data Prepper's native
timestamp/tie-breaker encoding. Use a dedicated index for this source. External
version conflicts acknowledge an already applied or superseded source event;
unrelated 409 errors do not. Delivery remains at least once.

The embedded engine now accepts internal compare-and-set versions and
external/external_gte on document index/delete and bulk index/delete. It rejects
explicit versions on create/update and mixed sequence/version conditions.
Versions range from 0 (external) or 1 (internal) through 9,007,199,254,740,991;
full signed-64-bit versions are unavailable. Delete tombstones survive restart
and are retained until index deletion under the existing 100,000-record limit;
this differs from native timed gc_deletes. Snapshot restore accepts version zero
for live documents, but snapshots do not carry tombstones or ingestion cursors.

Four focused source tests cover conversion/strict configuration, encrypted
admission and checkpoint publication failures, real SDK source and sink denial,
resource-policy recovery, update/delete, restart, stop/start, retention expiry,
and CloudFormation create/capacity update/delete with a real S3 DLQ. Two forced
process-kill tests cover before/after a delete commit; recovery preserves the
external tombstone and rejects stale resurrection. A focused engine test covers
version CAS, bulk partial failure, safe integer limits and snapshot version zero.
Two browser journeys at 1440/390px cover blueprint, permission recovery, live
writes, delete while stopped and checkpoint resume; both were visually checked.

References: [AWS DynamoDB integration](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/configure-client-ddb.html),
[Data Prepper DynamoDB source](https://docs.opensearch.org/latest/data-prepper/pipelines/configuration/sources/dynamo-db/),
[OpenSearch external versions](https://docs.opensearch.org/latest/api-reference/document-apis/index-document/),
[delete versions](https://docs.opensearch.org/latest/api-reference/document-apis/delete-document/).

## Serverless one-time ingestion jobs

CreateIngestionJob, GetIngestionJob, ListIngestionJobs and CancelIngestionJob now
execute against the pinned AWS JSON model and installed official SDK. The
current AWS guide documents the caller-identity job contract separately from
role-based continuous streams. These four operations add bounded implementations;
the four stream operations remain open.

Jobs require an active NextGen SEARCH or VECTORSEARCH collection, a same-account
and same-Region S3 bucket, and a literal optional prefix. The worker uses the
original authenticated caller identity, revalidated on every source read and
destination batch. No credential secret is stored in the job. IAM user/key
revocation, original principal replacement, STS expiry and role replacement fail
closed; this bounded delegation cannot outlive the original credentials.
Collection IAM APIAccessAll, data access policies and the existing local public
network policy are independently enforced. S3 role/user policies, bucket explicit
denies, pinned version permissions, SSE-C restrictions and archive state remain
owned by S3. Source data never bypasses either service's authorization boundary.

A durable creation intent precedes acknowledgment. The work store encrypts the
frozen object listing and admitted records with a separate generation-owned key.
One object is captured at a time; at most 20 records per worker tick are delivered,
with at most four concurrent workers. A record's acknowledgment commits only
after the document or failure document is durable. A process kill in that gap
replays the same bucket/key/record-derived ID. Partial delivery is at least once,
not exactly once. File mutation between listing and admission becomes an object
failure. Job retries do not rescan. Only one active job may use a given target or
failure index, preventing competing local reloads.

Supported objects are .json (object or array), .jsonl and .ndjson, optionally .gz.
UTF-8 parsing is strict; objects are bounded to 10 MiB stored/expanded, 1,000
records, and 1 MiB per record. Listings permit 1,000 objects and 2 MiB metadata.
Up to 20 jobs may be active installation-wide; 100 job records are retained per
account/Region until collection deletion. This is a local history bound, not an
AWS quota. Unsupported formats and malformed/mapping-rejected records write an
actual failure-index document with source metadata, ordinal and a stable error.
The default failure index is `<target>-ingestion-failures`. It must differ from
the target and must be writable. Failure records omit source document contents;
source objects remain available in S3. Object success/failure counters derive
from committed progress, and a job can complete with object failures.

Temporary capacity/storage failures retry up to ten times with 1–60 second
backoff and activeAlerts; authorization failures become terminal failures.
Cancel publishes CANCELLING before acknowledgment, then stops pending work and
publishes CANCELLED. An in-flight document can finish. Already indexed documents
remain. Cancel never reports rollback. Cancellation also survives restart.
Collection deletion waits for in-flight work and removes owned encrypted work,
keys and job metadata. Job tags use the existing tag APIs. Idempotency compares
request content; pagination uses the existing collection-scoped HMAC cursor.

The console exposes collection → Ingestion jobs, creation, pagination, progress,
source/failure details and cancellation. Desktop/mobile browser journeys were
visually checked. Two focused Node tests cover strict parsing, encrypted partial
acknowledgment/publication failure, official SDK timestamps/idempotency/tags/
pagination, real S3/index failures, restart, cancellation, live IAM denial and
revoked execution keys. Two forced-kill tests cover before/after document commit,
including expected replay versions. Relevant existing Serverless and S3-source
tests pass; one deterministic-clock setup wait now advances until the source
worker is scheduled. Linux/Windows/AWS execution remains unverified.

No PDF/Word extraction, image understanding, semantic enrichment, model inference,
cross-account source or Classic/time-series target is claimed by the job profile.
Continuous streams are implemented separately below.
Reference: [AWS Serverless S3 ingestion and caller permissions](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-intelligent-ingestion-s3.html).

## Serverless continuous S3 ingestion streams

Create/Get/List/DeleteIngestionStream now execute a separate Serverless stream
worker. This is a bounded NextGen SEARCH/VECTORSEARCH profile, not an OSIS alias.
The source is one existing same-account, same-Region standard SQS queue, with an
optional allowlist of up to five existing S3 buckets. Per-bucket initialScan
ENABLED captures existing objects before queue processing. Omitting buckets
accepts same-account source buckets that the role can read. S3 notification
configuration remains owned by S3; the API does not silently create queues or
change notifications. Direct ObjectCreated Put/Post/Copy/CompleteMultipartUpload
notifications and S3 TestEvent are supported; SNS envelopes and other event types
are rejected into the failure index. The queue must be dedicated to the stream.

The caller needs iam:PassRole to aoss.amazonaws.com. Execution assumes that
service principal with the actual stream ARN and account in the trust context.
Service sessions may be reused, but every assumption rechecks current trust,
role identity and credential validity. S3 reads and each queue operation enforce
current IAM and bucket/queue resource policies. Target and failure writes enforce
current collection network, IAM APIAccessAll and data policies. The role needs
sqs:GetQueueUrl, GetQueueAttributes, ReceiveMessage and DeleteMessage. Pending
source/target/trust errors appear in activeAlerts and retry with 1–60 second
backoff; repairing policy resumes admitted work. Long-lived polling does not
create a new STS credential per record or empty receive.

A separate AES-256-GCM SQLite work store captures an initial listing or a whole
notification batch, the receipt, admitted object records, durable per-record
acks, statistics and the last 1,000 completed message IDs. Messages are deleted
only after every object record reaches its target or failure index. Completion
is durable before DeleteMessage. A crash after deletion can safely clear the
checkpoint; an expired receipt leaves the completed-ID record so redelivery is
acknowledged without replaying the documents. This is bounded at-least-once
handling, not exactly-once delivery or an infinite deduplication history. The
receive lease is 300 seconds; the stream does not need ChangeMessageVisibility.
A batch may finish after lease expiry; another queue consumer is unsupported.

Current-object metadata must match a notification's ETag/size and, when supplied,
version. Stale notifications never load a historical S3 version over current
data. Changed/missing/unsupported objects and malformed notifications produce
real failure-index records with stable explanations, not raw source/notification
contents. Record IDs derive from bucket/key/ordinal. Source removal and shrinking
an overwritten array do not delete obsolete indexed ordinals; use a dedicated
index and rebuild when removal synchronization is required. Source sequencing is
not a distributed ordering guarantee. Job/stream index overlap and multiple
streams consuming the same queue are rejected.

Bounds: 20 active streams installation-wide, 100 retained stream records per
account/Region, four fairly rotated workers, 20 records per tick, 1,000 initial
objects, 100 records per notification, 1 MiB notification, 2 MiB checkpoint,
10 MiB stored/expanded object, 1,000 records/object, 1 MiB/record. JSON object/array,
NDJSON/JSONL and optional gzip reuse the job parser (gzip is a local extension to
the AWS guide's uncompressed-only profile). Stream deletion durably enters
DELETING, stops pending delivery, removes its encrypted work/key, then reports
DELETED. In-flight commits can finish. Documents, buckets and queues remain;
unacknowledged messages become visible again. Collection deletion waits for
workers and removes all owned stream state. Tags, idempotency and scoped HMAC
pagination use normal AOSS authorization. Pagination binds membership and names;
progress updates between pages do not invalidate the cursor.

Console: collection → Ingestion streams supports list/create, queue/role/bucket
pickers, individual backfill choices, current progress/alerts and confirmed
stream deletion. Existing jobs link to streams. Focused tests exercise actual
S3 notification delivery, IAM PassRole, trust changes with cached credentials,
queue explicit deny, destination deny/recovery, expired receipt/restart,
malformed input, encrypted checkpoints, idempotency, tags, pagination, fairness,
and collection deletion. Forced process termination before/after sink commit
and after queue deletion verifies recovery. No AWS/native comparison or
Linux/Windows run is claimed.

Two desktop/mobile browser journeys passed and were visually reviewed at 1440px and 390px, including role-trust alerts, repair, real new-object delivery and confirmed deletion. Type checking and relevant existing Serverless/job/role tests pass. The manifest now records 137 focused Node tests and 47 browser journeys cumulatively; no full regression run was performed.

## DynamoDB initial PITR export and CDC handoff

A DynamoDB table source may now include `export: {s3_bucket, s3_prefix}` alongside
`stream: {start_position: LATEST}`. The snapshot blueprint provides this form.
PITR and NEW_IMAGE/NEW_AND_OLD_IMAGES must already be enabled. The destination
bucket must exist in the installation account and pipeline Region; customer KMS,
local file destinations, alternate export codecs and export-only sources are
outside this ingestion profile. Stream-only TRIM_HORIZON remains unchanged.

Before submission, the source durably pins its stream/shard/cursor, export time,
idempotency token and baseline version. It invokes the owning DynamoDB service's
real ExportTableToPointInTime, followed by DescribeExport, then reads the S3
manifest and compressed DynamoDB JSON object. No table-state shortcut populates
the search index. Role permissions include DescribeContinuousBackups,
ExportTableToPointInTime, DescribeExport and S3 GetObject/PutObject in addition to
existing stream/sink permissions. PutObject is checked on each exact output key
before export intent publication. DynamoDB owns the accepted async export and
its S3 writes; the bucket policy must separately allow dynamodb.amazonaws.com
with the source table ARN/account, as required by StackSim's existing transfer
port. That service policy is checked by S3 at each write. Role read permissions
and DynamoDB/target policies apply again during ingestion. Export objects/jobs
remain after pipeline deletion, owned by S3 and DynamoDB respectively.

The source accepts the local single-file FULL_EXPORT/DYNAMODB_JSON format, with
at most 1,000 items and 10 MiB compressed/expanded content. Summary/file manifests
are checksum-verified and matched to the described export/table/bucket/count;
the data checksum and record count must match. A SHA-256 digest of the complete
artifacts is pinned with the first admitted batch. Later mutation blocks rather
than mixing snapshots. Manifest paths cannot redirect outside the export's own
prefix. Up to 100 records enter each encrypted batch; each is acknowledged only
after delivery or S3 DLQ. The snapshot offset advances atomically with the final
ack and never advances the CDC cursor. All snapshot records must finish before
CDC reads from the pinned pre-export position. Changes concurrent with the
export are therefore replayed in sequence, including deletes.

Snapshot document versions equal the sequence immediately before the pinned CDC
cursor, including zero when streams were enabled after the initial table data
was written. Later CDC sequence versions are greater; replays cannot overwrite
newer documents or resurrect a deleted document. This local sequence convention
is intentionally distinct from the native timestamp-based version encoding.
Use a dedicated empty target index. Stop/Start, capacity updates and process
restart retain the export identity, digest, offset and CDC position. A crash
after export submission but before saving its ARN reuses the durable token; the
8-hour admission/idempotency window is enforced. Trimmed CDC retention, failed
export jobs and invalid/mutated artifacts block and require explicit resync;
policy and temporary service failures retry. The 24-hour DynamoDB retention
window still applies while snapshot delivery is pending.

Evidence: two focused tests verify artifact integrity/mutation, config bounds,
real S3 output, role destination denial before export admission, denied reads,
concurrent modifications/removals, version-zero records, mid-snapshot restart,
CDC replay and no re-export on Stop/Start. Three forced-kill tests cover accepted
export intent before ARN publication and before/after snapshot sink commit. Two
console journeys at 1440px/390px exercise snapshot blueprint validation, access
repair, measured export completion and subsequent CDC/delete. Screens were
visually reviewed. Existing DynamoDB S3-transfer/import-export, CDC/recovery and
HTTP ingestion tests pass. No full regression, AWS/native comparison or remote
Linux/Windows execution was performed.

References: [AWS DynamoDB pipeline source and snapshot configuration](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/configure-client-ddb.html),
[Data Prepper DynamoDB source](https://docs.opensearch.org/latest/data-prepper/pipelines/configuration/sources/dynamo-db/).
