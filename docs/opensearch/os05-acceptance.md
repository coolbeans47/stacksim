# OS-05 monitoring, snapshots and maintenance

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

Measured CloudWatch request counters, document gauges and local domain health
were implemented earlier. This increment adds manual S3 snapshot repositories,
durable asynchronous creation/restoration and console workflows. Embedded restart/rebind maintenance also executes through four control APIs.
Application/slow logs, REST audit logs and monitoring charts are implemented. Hourly automatic backups and observed insights/feedback are implemented. Upgrades remain open. OS-05 is not
declared complete.

## Snapshot behavior

- Managed domain endpoints and the console query adapter accept repository
  registration/read/verification/removal and snapshot create/get/status/delete/
  restore. The official OpenSearch client is exercised. Serverless does not
  expose these managed-only operations.
- Repository registration requires an IAM identity with `iam:PassRole`, even
  when internal-user Basic authentication permits other operations. A role must
  trust `es.amazonaws.com`; source account/domain ARN trust conditions apply.
  Each S3 operation checks the assumed role and bucket policy. Buckets must
  belong to the domain account and Region. SSE-C reads reject; archived objects
  require the ordinary S3 restore process before service reads.
- One writable registration owns each bucket/prefix within the installation.
  Read-only registrations can restore into other domains. Writer registration
  fails closed if another persisted domain's storage cannot be inspected.
  Writable verification lists objects and writes, reads, then deletes a probe.
  Read-only verification checks listing. Unregistering leaves S3 objects intact.
- Snapshot payloads are real JSON/gzip S3 objects under
  `<base_path>/stacksim-snapshots-v1/<snapshot>.json.gz`. The explicit
  `stacksim-search-snapshot-v1` format is portable between embedded domains,
  **not compatible with native Lucene snapshot repositories**. S3 encryption,
  versioning, retention and explicit bucket denies retain their usual effects.
- A synchronous capture includes acknowledged, unrefreshed documents and their
  version, sequence and routing, plus index mappings, settings and aliases.
  Global state includes supported index templates and ingest pipelines. Security credentials,
  role mappings, workspace objects, CFN ownership, repositories and jobs are
  excluded. FGAC requires snapshot cluster privileges and unrestricted access
  to every selected index. The built-in `manage_snapshots` role is available.
- Capture and job intent commit together in the domain database before
  acknowledgment. Staging therefore uses the domain's encrypted persistence
  when enabled. The worker writes the S3 object before committing completion.
  Recovery may repeat the same S3 write; versioned buckets can retain duplicate
  versions. Creation uses immutable captured data, not a later re-read.
- Restore validates all selected indexes and sources, then atomically creates
  new indexes and commits its completion marker. Existing indexes/aliases and
  conflicting write aliases reject. RE2 rename patterns, index selection with
  exclusions, alias inclusion and supported setting overrides are available.
  Restored documents are immediately searchable. Invalid input, quotas, mapping
  errors and conflicts cannot leave a partially restored index set.
- Native shard file statistics are not invented. Status reports one logical
  shard per embedded index, actual job state and elapsed time. The private
  `/_stacksim/snapshots/jobs` endpoint provides bounded restore/create history.
  Both asynchronous and `wait_for_completion=true` requests are supported.
- Limits: 20 repositories/domain, 100 stored snapshots/repository, 96 MiB
  expanded snapshot payload, one job/domain, 32 recent local jobs. Ordinary
  document/index/storage limits also apply. Partial snapshots, native files,
  custom snapshot schedules, arbitrary S3 endpoints, customer KMS configuration,
  snapshot user metadata and multi-name delete/status are unsupported.

## Evidence

### Automatic backups

Managed domains now create hourly portable backups, checked by the service Clock
once per minute. A missed hour produces a current capture at the next available
attempt; it does not manufacture historical recovery points. Capture includes
committed unrefreshed sources, versions, mappings, settings, aliases and optional
global templates/ingest/search pipelines using the same validated portable
format. Security records, private workspaces and execution jobs are excluded.

Immutable compressed copies use a separate AES-256-GCM material store and key,
including when the live domain database is unencrypted. Protected bytes are
durable before the catalog reference is published. Restart keeps referenced
copies and discards unfinished unreferenced material intents. Repository reads
and retention serialize with publication, so listing cannot expose an uncommitted
success. Missing backup keys or referenced files disable backup access and show
a failure without fencing the independent live search database.

The service-owned cs-automated/cs-automated-enc repositories support listing,
verification, snapshot get/status and ordinary atomic restore into new indexes.
They advertise the explicit local type stacksim-automatic, with no invented S3
bucket or role. Repositories from before enabling live-storage encryption remain
visible while they retain snapshots. Manual creation, individual deletion and
unregistration reject. Normal domain/IAM/FGAC gates and unrestricted index restore
grants apply. Dictionary-dependent indexes require the matching package versions.

Retention removes the oldest copies after 14 days, 336 snapshots or 1 GiB of
compressed data per domain, whichever limit is reached first. Expanded captures
remain limited to 96 MiB. These are full portable copies, not incremental native
segments; capacity can shorten the available history. Expiration runs even when
the domain is unavailable. Retired references are saved before physical removal,
and cleanup retries idempotently. Deleting a domain removes its automatic copies;
separately owned S3 snapshots remain intact. Failure/status/next-attempt details
are available in the snapshot console and private job endpoint.

Three focused tests exercise actual capture/restore, signed official clients,
read-only/FGAC gates, encrypted bytes, failed publication rollback, retention,
unavailable-domain retry, restart, deletion and missing-backup-key isolation.
Two forced-termination tests cover before and after catalog publication. Existing
manual S3, maintenance and configuration-recovery tests pass. Four browser journeys
cover automatic and manual snapshot workflows at 1440/390 pixels; automatic
repository/status screenshots were inspected. Native/AWS and remote platform
comparison remain open.

References: [automated snapshot frequency](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-snapshots.html),
[automated repository restore](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-snapshot-restore.html).

### Manual snapshot evidence

Seven focused Node tests cover portable restore/rollback, FGAC, encrypted intent
reopening, official-client S3 integration, read-only cross-domain restore,
PassRole and role/bucket denials, malformed/archive rejection and real process
termination after acknowledgment both before and after the S3 object commit.
The existing engine/security suites also pass. TypeScript checks pass.

Two Chromium journeys at 1440 and 390 pixels cover repository verification,
backup, restore, object deletion and unregister. Screenshots were inspected.
No full regression suite was run. Linux/Windows execution, AWS reference
captures, exhaustive restore crash boundaries and native semantic comparison
remain unverified.

References: [AWS repository registration](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-snapshot-registerdirectory.html),
[AWS snapshot roles](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-snapshots.html),
[OpenSearch snapshot creation](https://docs.opensearch.org/2.19/api-reference/snapshots/create-snapshot/),
[OpenSearch snapshot restore](https://docs.opensearch.org/2.19/api-reference/snapshots/restore-snapshot/).

## Embedded maintenance

`DescribeDomainNodes` reports one local data node using the domain generation as
its stable ID. `StartDomainMaintenance`, `GetDomainMaintenanceStatus` and
`ListDomainMaintenances` implement two actions: `RESTART_SEARCH_PROCESS` reopens
the database, and `REBOOT_NODE` additionally rebinds the same HTTPS port. These
are documented local mappings, not host reboots or separate native processes.
`RESTART_DASHBOARD` rejects because there is no separate Dashboard process.

A durable pending intent precedes acknowledgment. Maintenance closes admission,
drains active requests with a 30-second limit, performs the storage/endpoint work,
and publishes completion. Data remains intact; in-memory search contexts are
invalidated. Health/node status reflects temporary unavailability. Conflicting
configuration changes, maintenance and deletion reject. Failed storage/endpoint
reopening leaves an unavailable domain; publication errors do not become success.
Restart recovers pending/in-progress intents. History keeps 100 jobs with filters
and authenticated, scoped, expiring cursors that reject after history changes.

Four additional Node tests exercise all four official SDK operations, IAM denial,
real engine replacement, PIT invalidation, data/endpoint preservation, admission,
conflicts, filters/cursors, restart history, failed intent publication and forced
termination after intent publication and after storage reopens. Two additional
browser journeys exercise both actions/history at 1440 and 390 pixels. Relevant
configuration/security recovery tests still pass. Exhaustive maintenance fault
coverage, host behavior and external reference/platform evidence remain open.

Reference: [AWS maintenance actions](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_StartDomainMaintenance.html).

## Application and slow-request logs

Managed domains publish application lifecycle/server-error events and search/index
slow-request events into existing CloudWatch Logs groups. Create/update validates
same-account/Region destinations and an `es.amazonaws.com` resource policy with
stream-create and event-write permissions; explicit denies and source conditions
apply at delivery time too. The current Logs adapter supports the configured
StackSim account. It never creates policies or groups implicitly.

Eight dynamic index settings provide warn/info/debug/trace thresholds for search
query and indexing requests. `-1` disables; durations from `0ms` to 24 hours are
supported. Timing measures actual whole embedded requests per touched index;
it does not claim native per-shard or fetch-phase timing. Request bodies, source
fields, query strings and credentials are excluded. Delivery is best effort:
failures persist in domain diagnostics, acknowledged writes remain committed,
and failed log events are not replayed. Recovery clears the diagnostic failure.
Native fetch-phase settings still reject explicitly. REST audit capture is
described below.

Two SDK/CloudFormation tests verify actual delivery, disabled/default thresholds,
privacy, missing/wrong/denied policies, recovery, failed server requests, stack
create/update/cleanup and unsupported settings. Two browser journeys at 1440/390
pixels verify measured charts, time/period controls, log options, errors and index
thresholds. Screenshots were inspected. Metric gaps remain empty; synthetic JVM,
EC2 and EBS observations are not supplied.

## REST audit events

AUDIT_LOGS publishing uses the same actual CloudWatch Logs groups and service
resource policies as other domain logs. It additionally requires FGAC. Capture
is separately configured with GET `/_plugins/_security/api/audit` (or
`/audit/config`), PUT `/audit/config`, and bounded add/replace JSON PATCH at
either path. As with the current other security configuration APIs, only the
security master may administer it. Configuration is encrypted with the domain,
survives restart and is excluded from portable snapshots. Updating it also
invalidates existing security fingerprints/cursors.

Capture is initially disabled. Enabled REST capture records FAILED_LOGIN and
MISSING_PRIVILEGES by default; AUTHENTICATED and GRANTED_PRIVILEGES can be enabled
by removing them from disabled_rest_categories. Successful identity resolution
emits AUTHENTICATED. Successful requests emit GRANTED_PRIVILEGES; denied engine
requests or bulk/msearch items emit MISSING_PRIVILEGES. Bad Basic or anonymous
credentials that reach FGAC emit FAILED_LOGIN with an unauthenticated identity.
IAM/domain-policy and SigV4 failures before FGAC are outside this capture scope.
There is no claim of a transport-layer or compliance audit trail.

The capture wrapper is shared by gateway, local console, AppSync and managed
OSIS sink requests. Events contain category, timestamp, real domain/node/user
identity, REST method/path and optionally up to 20 resolved indexes. Path/user
metadata is bounded to 1,024 characters. No body, query string, headers,
password, source fields or error text is copied into events. Configuration
supports enable_rest, disabled REST categories, user/path glob exclusions and
resolve_indices. Transport/compliance logging, sensitive headers, request-body
capture, per-document/per-item bulk records and other categories reject.
Ignore requests accepts REST path globs, not transport action patterns.

Publishing failures preserve request results, persist diagnostics and clear
after a later successful event; there is no replay. Limits include 32 KiB
configuration, 100 filters/patch operations and 1,024 characters per filter.
PATCH validates the complete result before writing, so a bad later operation
cannot partially change capture settings.

Two focused tests exercise both gates, defaults, credentials/permission failures,
success categories, filtered users/paths, resolved indexes, denied bulk items,
privacy, invalid configuration, atomic PATCH, publishing denial/recovery,
encrypted restart and disabling either gate. The official client's index-scoped
bulk PUT route was also implemented and tested for successful and denied writes.
The CloudFormation logging lifecycle test now covers FGAC audit publishing
through create/update/cleanup. Relevant engine, ingestion, logging and AppSync
tests pass. Two audit browser journeys and the two existing monitoring journeys
pass at 1440/390 pixels; screenshots were inspected. TypeScript checks pass.
Native/AWS comparison and Linux/Windows execution remain unverified.

Reference: [AWS audit logging](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/audit-logs.html).

References: [domain log setup](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/createdomain-configure-slow-logs.html),
[index settings](https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/index-settings/).

## Observed insights

ListInsights, DescribeInsightDetails and InsightFeedback now use persisted local
observations. Reading insights samples actual endpoint/storage failure, automatic
backup failure, enabled log-delivery failures, the latest failed configuration
or maintenance operation, and index/source-storage usage at 80% of the embedded
limits. No background sampling or AWS fleet prediction is claimed. Recovery
resolves the existing record; recurrence creates a new record. Up to 100 records
per domain are retained, pruning resolved history first.

Lists support domain or caller-account scope, creation-time ranges, ordering and
scoped authenticated ten-minute cursors. Domain IAM resources and tags apply;
account-wide lists require account-wide permission. Details are plain text and
measured metric JSON. Latest Up/Down feedback and up to 1,000 characters survive
restart without dismissing an active problem. Invalid requests reject; failed
state publication rolls back. AWS fleet models, HTML and dismissal are unavailable.

Two focused tests cover observations, recurrence/resolution, history bounds,
feedback, pagination, rollback, SDK timestamp round trips, actual engine capacity,
IAM resource/tag restrictions and restart. Two browser journeys at 1440/390 pixels
cover lists, filters, details, feedback and recovery; screenshots were inspected.
TypeScript checks pass. Native/AWS and Linux/Windows execution remain unverified.

References: [ListInsights](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_ListInsights.html),
[Insight model](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_Insight.html).
