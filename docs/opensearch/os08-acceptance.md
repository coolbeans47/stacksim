# OS-08 embedded ingestion implementation

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

The in-process HTTP and one-time S3 ingestion profile now executes all fourteen OS-08 control
operations. It requires neither Docker nor Data Prepper. These are bounded
operation subsets; the full design and its external evidence gates remain open.

## Executable behavior

- A separate `osis` REST-JSON service implements pipeline create/get/list/update,
  delete, start/stop, change progress, validation, blueprint discovery/read and
  tags. The official JavaScript SDK exercises every operation. Lists use scoped,
  authenticated, expiring cursors. Catalog changes invalidate existing cursors.
- Each generation reserves a loopback HTTPS endpoint in ports 45000–47999. Deleted
  leases are retired. Signed input requires `osis:Ingest`; control writes require
  their own IAM permissions, and creation/update requires `iam:PassRole` to
  `osis-pipelines.amazonaws.com`. Service-role sessions honor source account/ARN
  trust conditions. Account and Region catalogs are separate.
- The compiler accepts version 2 YAML/JSON with one HTTP or supported S3 source, at most 32
  supported processors and one OpenSearch sink. `add_entries`, `delete_entries`,
  `rename_keys`, `parse_json`, `convert_type` and `convert_entry_type` execute
  locally. Unknown plugins/options, scripts, unsafe field paths and unsupported
  format expressions fail validation. Only literal strings and `${/field}` sink
  substitutions are accepted. Malformed JSON and conversion failures enter the
  failure path; native Data Prepper tagging behavior is not claimed.
- JSON arrays and NDJSON, with optional gzip, are bounded to 1,000 events per
  batch, 1 MiB per event, and 10 MiB per request/expanded payload. The encrypted
  buffer admits the whole batch durably before acknowledgment. Its 10,000-record
  and 64 MiB bounds include delivery-configuration and retry metadata. Full
  buffers reject input with 429. Pending and failed rows survive reopening.
- Delivery assumes the configured role and applies the destination's existing
  authorization. Managed sinks check discovery, IAM/domain policy and FGAC.
  Serverless sinks independently check discovery, network policy, IAM API access
  and data policy. Only current same-account/same-Region catalog endpoints are
  accepted; pipeline configurations cannot become arbitrary network fetches.
- Each buffered record retains the accepted configuration. Successful items are
  removed individually; unsuccessful items back off from one to sixty seconds.
  Input records keep a stable default document ID where the collection profile
  permits IDs. Time-series and Classic vector sinks use generated IDs. An
  explicitly configured `document_id` must match the sink's capabilities.
- Delivery is **at least once**. A crash after the sink commits and before the
  buffer records success can replay an item. Explicit/generated IDs and versioned
  S3 buckets have their normal consequences; exactly-once delivery is not claimed.
- Permanent failures remain encrypted in the local failure store, or go to an
  S3 DLQ configured in YAML. S3 writes check role and bucket permissions, including
  explicit denies. An unavailable/denied DLQ retains the item for retry. S3
  records contain the original event, error, attempts and admission time. They
  are user-visible objects, not private buffer storage.
- Capacity accepts `1 <= MinUnits <= MaxUnits <= 8`. Local allocation grows with
  backlog (100 pending events/unit) and concurrent input (four requests/unit),
  stays inside those bounds, and drains ten events per allocated unit per tick.
  Maximum admission is 32 concurrent requests. This is a scheduling mapping,
  not a claim about AWS compute throughput or billing.
- Stop closes input and pauses the worker while preserving buffered records.
  Start reopens the same endpoint. Update pauses delivery while activating the
  new configuration; accepted records retain their earlier configuration.
  Delete removes the encrypted buffer/key and retires the endpoint. Failed
  cleanup remains observable and can be retried. Change history keeps 20 entries.
- `AWS::OSIS::Pipeline` uses the shared lifecycle, ownership and caller checks.
  Name changes replace the resource; capacity/configuration/tags update in place.
  Retention releases ownership. `Ref` returns the documented **pipeline name**;
  `PipelineArn` and `IngestEndpointUrls` are live attributes. The registry's ARN
  primary identifier remains the provider's internal physical identifier.
- Console list/create/blueprint/editor/validate/detail/update/start/stop/delete
  and signed test-event submission are available at desktop and mobile widths.
  Diagnostics expose buffer counts, bounded error metadata and real change
  history. CloudWatch `AWS/OSIS` counters record admitted, delivered and failed
  events. Input payloads are not included in diagnostics or metrics.

Persistent buffering is always enabled in this local profile (including when
omitted); explicitly disabling it rejects. Customer KMS keys, VPC endpoints,
resource policies, other source/sink plugins,
expressions and native Data Prepper plugin compatibility remain unavailable.
The default blueprint is clearly named as a StackSim blueprint, not an AWS
catalog replica. Serverless delivery currently uses its public-network local
adapter; AWS PrivateLink provisioning is not emulated by that path.

## Evidence

Focused Node tests: `opensearch-ingestion-config` (2), `opensearch-ingestion-roles`
(1), `opensearch-ingestion` (3), `opensearch-ingestion-cloudformation` (2).
They cover compiler effects, encrypted reopening/key loss/backpressure,
resource-bound role trust, signed input denial, role-revocation recovery,
restart with acknowledged rows, partial failures, denied/recovered S3 DLQ,
Serverless's three gates, metrics, deletion-publication failure/retry, and CFN
create/update/replacement/retention, plus the runnable CDK example with signed
event delivery and search verification. Relevant STS, encryption, bootstrap and
protocol tests also pass. TypeScript checks pass.

Two Chromium journeys exercise blueprint validation, creation, event delivery,
updates, tags, stop/start and deletion at 1440 and 390 pixels. Screenshots were
inspected; form controls use the shared console styles and long endpoints wrap.
No full regression suite was run. Linux/Windows CI is configured but not yet
executed. Forced termination at every pipeline lifecycle/acknowledgment boundary,
full CloudFormation rollback, real AWS captures and complete native semantic
comparisons remain open.

References: [OSIS API](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_osis_CreatePipeline.html),
[IAM action scopes](https://docs.aws.amazon.com/service-authorization/latest/reference/list_osis.html),
[pipeline role](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/pipeline-domain-access.html),
[Serverless destination](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/pipeline-collection-access.html),
[CloudFormation returns](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-osis-pipeline.html),
[HTTP source](https://docs.opensearch.org/latest/data-prepper/pipelines/configuration/sources/http/).

## Pipeline CloudWatch logs

`LogPublishingOptions` now works through create, update, describe, CloudFormation
and the pipeline console. The destination must be an existing `/aws/vendedlogs/`
group in the configured account and pipeline Region. Caller permissions for
`logs:CreateLogDelivery`, `UpdateLogDelivery` and `DeleteLogDelivery` gate the
corresponding transitions. A preconfigured Logs resource policy must allow
`delivery.logs.amazonaws.com` stream creation and writes. Source-account and
Logs-ARN conditions apply, and explicit denies win. No standalone CloudWatch
log-delivery resource or automatic group/policy provisioning is claimed.

Real lifecycle changes and per-item sink/processor failures produce structured
INFO/WARN/ERROR events. They include attempt/status identifiers but omit event
contents and arbitrary exception text. Failed log delivery records a persistent
counter/reason in diagnostics without interrupting buffer processing; failed log
events are dropped rather than replayed. Logging options and failures survive
restart. Disabling logging stops subsequent events.

An additional official SDK test covers caller/resource policy denials, source
conditions, real sink failures, privacy, delivery recovery and restart. Existing
CloudFormation and desktop/mobile journeys now cover enabling/disabling logging
and links to the actual group. CloudWatch delivery infrastructure and exhaustive
failure/reference/platform evidence remain open.

References: [pipeline logging](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/monitoring-pipeline-logs.html),
[vended-log policies](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AWS-logs-infrastructure-CWL.html).

## S3 source extension

The OS-09 [S3 acceptance record](os09-acceptance.md#s3-one-time-scan-source)
describes the executable one-time NDJSON source, real permissions, encrypted
checkpoints, bounds, recovery and console. S3 pipelines have no HTTP intake;
CloudFormation exposes an empty IngestEndpointUrls list for them. The existing
HTTP source, worker, buffer and CloudFormation focused tests continue to pass.
