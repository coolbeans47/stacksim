# Embedded OpenSearch

StackSim implements a **bounded, Docker-free OpenSearch emulator**. The user
explicitly selected an embedded implementation on 2026-11-16, superseding the
native-container decision in the sibling design repository. No Java, Docker,
OpenSearch binary, or remote AWS service is needed.

The scope is a developer learning and application-testing simulator. Common
client, indexing, search, access-control, persistence, deployment and console
workflows are implemented. Existing advanced features remain available as
bounded optional extensions; further phase expansion is stopped.

Full AWS API coverage, production topology/availability/performance, upgrades,
disaster recovery, saved-object migration jobs, additional identity providers,
VPC infrastructure and native plugin/Dashboards parity are deliberately outside
scope. Unsupported requests fail explicitly. The [developer contract](opensearch/implementation-plan.md)
and [operation accounting](opensearch/parity-report.json) distinguish supported
subsets from exclusions; the 231 upstream operations are not a delivery target.
Applications still support manually created shared data views and saved searches.

## Automatic backups

Managed domains also take hourly automatic backups. Open **Manage snapshots**
and select **cs-automated** or **cs-automated-enc** to view and restore them.
Automatic backup status shows the next attempt, retained size and any failure.
They retain up to 14 days, 336 snapshots or 1 GiB compressed per domain; capacity
can shorten that history. Copies are encrypted separately from live search,
read-only and removed with the domain. Manual S3 repositories remain independent.
Restore creates new indexes and does not restore security settings or private
workspaces. Custom analyzer indexes require their original dictionary versions.

## Dictionary packages

Choose **Packages → Import package**, select or enter an S3 bucket and object,
and import a UTF-8 dictionary. The bucket must belong to the current account and
Region. Your identity needs es:CreatePackage and s3:GetObject; bucket-policy
denies and archived-object restrictions still apply. **Find buckets/objects**
uses your normal S3 listing permissions; manually entered names do not require
listing access. Dictionaries are limited to 64 KiB and 1,000 entries.

On the package page, choose a domain and **Apply available version**. Use its
`analyzers/<PackageID>` reference in index settings, for example:

```json
{
  "settings": {
    "analysis": {
      "analyzer": { "words": { "type": "custom", "tokenizer": "standard", "filter": ["lowercase", "dictionary"] } },
      "filter": { "dictionary": { "type": "synonym", "synonyms_path": "analyzers/<PackageID>", "updateable": true } }
    }
  },
  "mappings": { "properties": { "title": { "type": "text", "search_analyzer": "words" } } }
}
```

Replace `<PackageID>` with the actual ID. A file containing `apple, fruit` lets
queries for fruit match a title containing apple. Rules support single terms;
use lowercase dictionary entries after a lowercase filter. Test tokens with
`POST /index/_analyze` and `{"analyzer":"words","text":"fruit"}`.

**Import new version** copies the current S3 object into encrypted package
storage. It leaves domain associations unchanged. Apply the available version
again to update search filters marked updateable. Index analyzers and other
search filters retain the package versions captured when the index was created;
create a new index to change those bindings. Analysis settings are immutable.

The package page shows versions, association failures and optional account
sharing. Enable sharing at initial import to edit its allowed account list.
Refresh to follow pending operations. **Domain packages** lists installed copies,
including shared packages whose owner revoked new access. Remove all indexes
referencing a package before dissociation, then remove all associations before
deleting it. Executable plugin packages are unavailable. See the
[advanced-search acceptance record](opensearch/os10-acceptance.md) for exact limits.

## Start and connect

Start StackSim normally, then choose **Amazon OpenSearch Service → Domains →
Create domain**. Creation allocates persistent storage and a dedicated HTTPS
gateway. Processing completes only after both are ready. The domain's returned
`Endpoint` is a host and port without a scheme; construct `https://${Endpoint}`.
Endpoint ports are stable across restart and retired after deletion. A port
conflict on restart produces a failed resource instead of silently changing its
address. Missing or corrupt initialized storage also fails visibly. Failed
deletion cleanup remains visible and can be retried from the API or console. Deletion removes the domain's index database.

Use an ordinary `OpenSearchClient` against StackSim's management endpoint and
an ordinary `@opensearch-project/opensearch` client against the domain endpoint.
Use SigV4 service `es`, the domain's Region, local IAM credentials, and the local
CA. The signed console diagnostics API
`GET /_stacksim/api/opensearch/capabilities` returns `caCertificatePath`.
Do not disable certificate verification. Client sniffing must remain disabled.

```js
import { readFile } from "node:fs/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

const search = new Client({
  node: `https://${domain.Endpoint}`,
  ssl: { ca: await readFile(caCertificatePath) },
  ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }),
});
await search.index({ index: "products", id: "shoe-1", refresh: true,
  body: { title: "Red leather shoes", category: "shoes", price: 45 } });
const result = await search.search({ index: "products", body: {
  query: { match: { title: "leather" } },
  aggs: { categories: { terms: { field: "category.keyword" } } },
} });
await search.close();
```

The [product-search example](../examples/opensearch-product-search/README.md)
includes a normal CDK domain and a public-client loader/query.
For a complete React application, [Fieldwork · OpenSearch Lab](../examples/cdk-opensearch-search-lab/README.md)
deploys a product catalog through CDK with a Lambda REST API and S3 website.
It demonstrates full-text search, filters, facets, sorting, pagination, document
editing and inspection of the actual OpenSearch request and response.

The legacy `ElasticsearchServiceClient` uses the same catalog. Creation requires
explicit `ElasticsearchVersion: "OpenSearch_2.19"`; older Elasticsearch engine
versions are unavailable. Legacy describe, configuration, tags, discovery and
deletion translate their modeled fields without creating a duplicate domain.

## Configuration and security

The supported compatibility selection is `OpenSearch_2.19`. Its discovery
descriptor is `r6gd.large.search`, selected because the ordinary CDK construct
permits it without EBS. **No EC2 instance, NVMe performance or hardware capacity
is emulated by this descriptor.** There is one embedded shard and no replicas.
The local configuration uses HTTPS, TLS 1.2 or later, local filesystem storage,
IAM authorization and optional domain resource policies.

Encrypted persistence, IAM/internal fine-grained access, configuration revisions,
verbose/basic dry runs and pending cancellation are implemented. Enable
`EncryptionAtRestOptions.Enabled` to use authenticated encrypted storage; an
existing domain can migrate without losing acknowledged documents. Enabling
FGAC also requires HTTPS and `NodeToNodeEncryptionOptions.Enabled`. The engine
runs in one process and has no inter-node network channel. Master passwords are
stored only as protected salted verifiers. Customer KMS keys, custom TLS
certificates, EBS, VPC deployment, Auto-Tune and log publishing remain unavailable.
See the [OS-03 implementation and evidence](opensearch/os03-acceptance.md).

Management and diagnostics use the authenticated caller's account catalog.
Management actions authorize `es:<Action>` on the domain ARN. Search actions
authorize `es:ESHttpGet`, `es:ESHttpPost`, etc. on the exact domain subresource
path. Explicit denies take precedence and permissions are checked on every
request. Cross-account data access needs both the applicable identity and
domain grants. Unsigned data requests require a domain policy allowing the
anonymous principal. IAM authentication modes retain StackSim's existing
`off`, `validate`, and `enforce` semantics.

URL policies do not inspect every index mentioned in a request body. Set
`AdvancedOptions["rest.action.multi.allow_explicit_index"]` to `"false"` to
reject explicit index references in bulk, multi-search and multi-get bodies.
Fine-grained roles can restrict resolved indexes, documents and fields before query
and aggregation evaluation. Restricted roles are read-only. The local query tool applies the
same HTTP-verb and subresource authorization as the domain gateway.

## Search behavior

Unencrypted domains have an independent SQLite WAL database under
`data/opensearch/<generation>/search.sqlite`. Acknowledged writes commit with
`synchronous=FULL`; document bodies never enter `state.json`. Real-time GET
reads current documents. Search reads a separate refreshed representation.
Automatic refresh occurs at the configured interval, lazily when search is
requested; `_refresh` and `refresh=true` explicitly refresh it. `wait_for`
waits for the configured interval. No background Lucene engine is running.

Implemented surfaces include:

- Index create/get/exists/delete; mappings; the supported index settings;
  atomic alias add/remove; composable index templates without components.
- Document index/create/get/exists/delete, partial updates and upserts,
  optimistic sequence/primary-term checks, `_mget`, and NDJSON bulk with
  ordered per-item results. Bulk is not a transaction across items.
- Search/count/multi-search/validate/explain, basic source and field selection,
  sorting, highlights, `search_after`, identity-scoped PIT and scroll contexts.
- The query operators, aggregations and analyzers listed in the shared
  [capability catalog](opensearch-capabilities.json).
- Index inspection, field capabilities, health, and configuration-plane
  CreateIndex/GetIndex/UpdateIndex/DeleteIndex backed by the same index store.

Search is a bounded interpreter, not Lucene. Scores are matching term counts,
cardinality is exact, supported dates use JavaScript date parsing, and analyzers
are simplified local implementations. Custom analyzers, fuzzy/query-string
syntax, scripts, remote reindex, plugin
installation and semantic enrichment reject. PIT/scroll contexts expire after
at most five minutes and do not survive a process restart. Search contexts are
scoped to the authenticated principal/session and owning resource generation.
Tokenization is limited to 1 MiB of text and 65,536 tokens per analyzed value;
phrase evaluation has a shared 10-million-comparison query budget.
Scroll retains the original field/source projection on every page; omitting a
new `scroll` lifetime leaves its existing expiry unchanged.

Vector fields support `knn_vector`, 1–4096 float components, and `l2`, `l1`,
`linf`, `cosinesimil`, or `innerproduct` spaces. Set `settings.index.knn=true`
and specify the dimension and optional `space_type` in the field mapping.
A top-level `knn` query accepts `vector`, `k`, an optional query `filter`, and
`boost`. Search uses an exact scan with the documented distance scores;
approximate indexes, method tuning, quantization, embedding generation,
nested vectors, and vector queries with PIT/scroll are unavailable.

```json
{
  "size": 5,
  "query": {
    "knn": {
      "embedding": { "vector": [1, 0], "k": 5, "filter": { "term": { "category": "shoes" } } }
    }
  }
}
```

Limits are 20 domains per installation, 100 indexes and 50,000 live documents
per domain, 64 MiB of stored document JSON, 1 MiB per document, 10 MiB per
request, 32 MiB per gateway response, 10,000 hits per result window and 20
search contexts per domain with a combined 64 MiB serialized snapshot budget.
The HTTPS gateway and local query API share a limit of 16 concurrent requests
per domain. Queries allow at most 1,024 clauses; aggregation execution allows
at most 10,000 intermediate work buckets, including nested validation.
These are local admission limits, not AWS quotas.
SQLite file overhead, tombstones and WAL disk usage are additional; a hard
filesystem quota is not implemented. Do not use the emulator as a production
search service.

## Console and deployment

The console includes overview, domain inventory with filtering/sorting/pages,
create/detail/edit forms, basic dry runs, tag editing, typed deletion
confirmation, status polling, and the local query tool. It uses the service
catalog, search, account/Region selector and existing themes and dirty-form
guards. The query editor is not native OpenSearch Dashboards.

`AWS::OpenSearchService::Domain` uses the same lifecycle, generated names,
ownership checks, asynchronous stabilization, tags, retention, replacement by
name, and endpoint/ARN attributes. Unsupported properties fail preflight.
CloudFormation bootstrap revision 24 grants the implemented domain and
Serverless collection/policy lifecycle operations through bounded execution policies. Direct client and CloudFormation resources share state.
`AWS::Elasticsearch::Domain` is also supported with explicit
`ElasticsearchVersion: OpenSearch_2.19`. Reserved CloudFormation ownership tags
are propagated and cannot be edited by ordinary tagging APIs. Replacement
creates a separate empty domain; it does not migrate documents. Retention
keeps the domain live and releases the stack's ownership.

## Monitoring

CloudWatch exposes measured `AWS/ES` metrics with `ClientId` and `DomainName`
dimensions: `OpenSearchRequests`, response-code counters (`2xx` through `5xx`),
`SearchableDocuments`, `DeletedDocuments`, `ClusterStatus.green`, and `Nodes`.
Use `Sum` for counters and `Maximum` or `Average` for gauges. Measurements are
published at activation and on completed resource-gateway/local-query requests;
there is no idle heartbeat. The standard CloudWatch APIs and console read these
metrics. A telemetry-storage failure does not change an acknowledged document
write. No JVM, EC2 CPU, EBS throughput, or AWS fleet measurements are fabricated.

## Verification and remaining evidence

Focused tests cover the embedded engine, official AWS/OpenSearch clients,
IAM denial and revocation, Region isolation, graceful restart and process-kill persistence,
domain endpoint retirement, supported management-index operations, unmodified
CDK template deployment/query/update/replacement/retention/destroy, legacy SDK
and resource compatibility, measured metrics, vector distance/filter behavior,
protocol rejection and migration.
Five browser journeys cover 1440×900, 1280×800 and 390×844 layouts, endpoint
copying, rejected forms/query/list reads and failed-deletion retry.

The focused tests run on Node 22.13.0. AWS CLI 2.36.14, four lifecycle
process-kill boundaries, missing/corrupt storage, occupied ports, actual SQLite
`SQLITE_FULL` rollback/retry and temporary-role revocation are exercised. See
the [OS-01/OS-02 acceptance record](opensearch/os01-os02-acceptance.md).
Linux/Windows execution, exhaustive fault interleavings, authenticated AWS
console captures and native semantic comparison remain unverified. Browser functionality
checks do not establish AWS visual parity. The compatibility manifest and
parity report must not be read as a full-service completion claim.

## Search workspace

Use **Open search workspace** on the domain page for the console's signed
identity. **Sign in to resource workspace** opens the domain's HTTPS workspace,
where you can use IAM or internal-user credentials. Trust the local CA first.
Credentials stay in page memory and are cleared on sign-out.

Create a data view for an index pattern, then use Discover to query, sort, inspect
fields and page through documents. Views and saved searches persist privately
per identity. Dev Tools uses the same domain authorization and requires
confirmation for DELETE requests. This local workspace is not the upstream
OpenSearch Dashboards distribution.

## Serverless collections

Choose **OpenSearch → Collections → Create collection**. NextGen Express Create
is selected by default. It configures a group, encryption/network/data policies
and a collection for the specified IAM user or role. Failed setup retains a form
draft and token for retry, and never overwrites an existing different policy.
Classic and NextGen Standard Create use existing policies/groups.

Use `OpenSearchServerlessClient` against the management endpoint and sign resource
requests with `aoss`, the collection Region and local CA. `collectionEndpoint`
includes `https://`; use it directly. Network permission, IAM `aoss:APIAccessAll`
and data-policy permissions are independent requirements.

Search/time-series and NextGen vector collections refresh every 10 seconds;
Classic vectors use 60 seconds. Realtime GET sees the latest acknowledged write.
Explicit refresh and scroll requests reject. Time-series and Classic vectors
require generated IDs. NextGen vectors allow custom IDs. Only VECTORSEARCH
supports k-NN indexes, using the embedded exact vector implementation.

Collection groups expose independent capacity, generation and membership.
Lifecycle policies remove time-series documents at their minimum ingestion age
(24h–3650d), with most-specific matching rules and an indefinite-retention option.
NextGen zero minimum releases idle admission allocation after ten minutes; it
does not unload the engine's memory or provision cloud workers.

CloudFormation supports Serverless `Collection`, `CollectionGroup`, `AccessPolicy`,
`SecurityPolicy`, `LifecyclePolicy`, endpoint-based `Index`, and management
`CollectionIndex`. See [OS-06](opensearch/os06-acceptance.md) and
[OS-07 acceptance](opensearch/os07-acceptance.md) for local mappings, evidence,
source discrepancies and remaining boundaries.

## HTTP ingestion pipelines

Open **Ingestion pipelines → Create pipeline**. Load the HTTP blueprint or enter
version 2 YAML/JSON, replace its HTTPS sink endpoint, Region and pipeline role,
then validate and create. The role must trust `osis-pipelines.amazonaws.com` and
have the destination's discovery and write permissions. Serverless additionally
requires its network, IAM API access and data policies. Creation is asynchronous;
inspect change progress and any failure reason on the detail page.

Producers sign the dedicated HTTPS endpoint with service `osis` and need
`osis:Ingest` on the pipeline ARN. Trust the local CA shown on the detail page.
**Send test events** uses the current console identity and the same ingestion
permission. The Delivery panel reports acknowledged, delivered, pending, failed
and dead-letter counts; Refresh retrieves the current worker outcome.

Accepted events are encrypted before acknowledgment. Stop/start preserves the
buffer and endpoint. Updates retain the accepted configuration of pending
records. Deletion removes the buffer and retires the endpoint, while documents
already indexed remain in the sink. Permanent failures stay in encrypted local
storage or go to the configured authorized S3 DLQ. At-least-once delivery can
produce duplicates after a crash between sink commit and delivery acknowledgment.

The profile supports one HTTP JSON-array/NDJSON source (optional gzip), field
addition/removal/rename, JSON parsing and scalar conversion, and one local
managed or Serverless sink. Buffering is always persistent, at most 10,000 rows
or 64 MiB; requests contain at most 1,000 events. Capacity is a local scheduling
limit of 1–8 units. VPC/resource policies, customer KMS keys, CloudWatch log
publishing and other plugins remain unsupported.

The [CDK ingestion example](../examples/opensearch-ingestion/README.md) deploys
its role, encrypted sink and S3 DLQ and demonstrates transformed search results.
See [OS-08 acceptance](opensearch/os08-acceptance.md) for exact limits and evidence.

## Manual snapshots

Open a managed domain and choose **Manage snapshots**. Register an existing S3
bucket and a role that trusts `es.amazonaws.com`. The signed-in IAM identity
needs `iam:PassRole`; the role needs S3 list/read/write/delete permissions for
the repository prefix. Verification checks the actual storage path.

Create a snapshot with an index pattern, then restore it into new index names.
The default console rename is `(.+)` → `restored-$1`. Restore aliases only when
they will not conflict with existing write aliases. A read-only registration
on another managed domain can restore from the same repository. Unregistering
keeps backups in S3; deleting a snapshot removes its current S3 object.

Snapshots use StackSim's portable JSON/gzip format and cannot be exchanged with
native Lucene repositories. Security and workspace records are excluded. See
[the snapshot acceptance record](opensearch/os05-acceptance.md) for bounds,
recovery behavior and remaining operational work.

## Domain maintenance

Choose **Maintain domain** to restart search storage or reboot the embedded node.
Both operations preserve indexed data and expire in-memory search contexts. Node
reboot also rebinds the same HTTPS endpoint. New requests are unavailable while
the operation drains requests and reopens storage. The page shows actual node
status and the latest 100 jobs. Dashboard-process and AWS host/service-software
operations remain unavailable in this embedded profile.

### Monitoring and logs

Open a domain's **Monitoring and logs** page for measured documents, requests and
server errors. Select a time range and period, then refresh. Empty periods remain
empty. Configure application/search/index log publishing to existing log groups
with an `es.amazonaws.com` resource policy. Slow logs additionally require an
index threshold; use `0ms` to log every eligible request or `-1` to disable it.
Thresholds measure complete embedded requests. Bodies and query strings are
excluded, and delivery failures appear on the page. Audit publishing and event capture are separate controls described below.

Pipeline configuration includes **Publish pipeline logs** and an existing group
under `/aws/vendedlogs/`. That group requires a `delivery.logs.amazonaws.com`
resource policy; the caller needs the corresponding Create/Update/DeleteLogDelivery
permission. Lifecycle and delivery-error records omit event contents. The detail
page links to the group and reports failed log delivery attempts.

### Saved ingest processors

On a managed domain, open **Ingest pipelines**. Enter a pipeline ID and JSON
processor definition, simulate sample documents, then save. **Apply to an index**
sets default/final pipelines on an existing index or pattern. These settings
transform subsequent index and bulk writes; `_none` clears a setting. The editor
shows unsupported options and version conflicts. Deleting a referenced pipeline
causes future writes to fail until its index setting is changed. See the
[bounded processor profile](opensearch/os10-acceptance.md).

### AppSync producers

In **AppSync → API → Data sources**, choose **OpenSearch**, enter the managed
domain's HTTPS endpoint and select its AppSync service role. The role must trust
`appsync.amazonaws.com` and allow the needed `es:ESHttp*` paths; FGAC mappings
still apply. Configure a VTL UNIT resolver or function stage using the standard
`2017-02-28` operation/path/params request. This writes and reads the same data as
the normal OpenSearch client. See [OS-09 acceptance](opensearch/os09-acceptance.md).

### SQL and PPL queries

Open **SQL and PPL** from a managed domain to run scalar projections, filters,
sorts and grouped numeric aggregates. SQL can page through results and close its
cursor; PPL provides source/where/fields/stats/sort/head commands. The editor
shows real rows, empty results and service errors. **Explain query** displays
the embedded execution plan. Queries use current IAM/domain policies and FGAC,
including document and field restrictions. Query text is not stored in browser
local storage. Cursors expire after five minutes or restart.

```sql
SELECT category, COUNT(*) AS products, SUM(price) AS cost
FROM products
WHERE price >= 10
GROUP BY category
ORDER BY cost DESC
LIMIT 20
```

```text
source=products | where price >= 10 | stats count() AS products,sum(price) AS cost by category | sort -cost | head 20
```

The profile returns at most 10,000 rows and supports numeric/boolean/string
scalars. Dates, multivalued fields, joins, scripts, arbitrary functions and
implicit type conversions reject. Only JDBC JSON responses are available;
Serverless SQL/PPL is unavailable. See the [OS-10 acceptance record](opensearch/os10-acceptance.md)
for exact syntax, resource bounds and tested differences.

### Hybrid search pipelines

Open **Search pipelines** from a managed domain to create or edit a normalization
pipeline. **Test hybrid query** runs the editor definition inline against real
index data without saving it. The index-default form applies a saved pipeline
ID; `_none` removes that default. Deleting a referenced pipeline causes dependent
queries to fail until their default or explicit pipeline is changed.

Hybrid queries combine up to five supported lexical/vector clauses. Pipelines
support min_max/l2 normalization and weighted arithmetic/geometric/harmonic
means. Each index contributes bounded candidates before normalization; use a
stable `pagination_depth` with `from`/`size` for consistent paging. Current
DLS/FLS applies before scoring. Native lexical/ANN scores, neural model
inference, additional processors and Serverless pipelines are unavailable.
See the [OS-10 acceptance record](opensearch/os10-acceptance.md) for exact bounds.

### REST audit logging

In **Monitoring and logs**, enable **Audit logs** and choose a permitted existing
log group. This control requires fine-grained access control. The security master
can then edit **Audit event capture**, setting `enabled` to true and saving it.
Both publishing and capture must be enabled. The default captures failed logins
and missing privileges; remove AUTHENTICATED/GRANTED_PRIVILEGES from
`disabled_rest_categories` to include successful requests. User and REST-path
glob exclusions are supported. Disable either gate to stop delivery.

Audit configuration and events use the real domain/security/Logs service paths.
Bodies, query strings, headers and credentials are excluded. Transport and
compliance capture and per-item bulk logs reject; failures at IAM/domain-policy
or SigV4 gates before FGAC are outside capture. Delivery failure diagnostics
appear with other log options; event delivery is best effort without replay.
See the [OS-05 acceptance record](opensearch/os05-acceptance.md) for details.

### Index state management

Open **Index state management** from a managed domain. Create a JSON policy,
then attach it to a concrete index or pattern. **Explain indexes** shows current
states, completed actions and failures. **Change policy** applies an edited
revision on the next five-second interval; **Retry failed indexes** resumes the
failed action or selects another state. **Remove policy** stops future actions.
Deleting a saved definition does not stop already attached policy revisions.

The editor supports read-only/write-enabled states, rollover and deletion,
age/count/source-size transitions, retries and automatic attachment templates.
Policies can delete stored data. Rollover needs an explicit write alias and the
index setting `plugins.index_state_management.rollover_alias`. Unsupported native
operations fail validation. [The ISM contract](opensearch/os10-acceptance.md#index-state-management)
details authorization, bounds, size/age semantics and restart behavior.

## Domain insights

Choose **View insights** on a managed domain to observe local failures and
capacity warnings. Refreshing records current conditions; cleared conditions
resolve earlier observations. Time range, ordering, paging and details use the
same insights API. Feedback persists with the observation and does not dismiss
an active problem. These are observations of StackSim state when read, with
100 retained records per domain; AWS fleet predictions are unavailable.

## Lambda and Logs producers

The [producer example](../examples/opensearch-producers/README.md) deploys a
product function and a CloudWatch Logs transformer with narrow execution-role
permissions, verified TLS and a real SQS failure queue. In CloudWatch's existing
subscription-filter screen, select the deployed transformer function after
granting Logs permission to invoke it. New events become searchable in
`logs-YYYY.MM.DD`. The example documents bounds, replay behavior, failure handling
and deployment/cleanup. Direct Logs OpenSearch destination APIs remain unavailable.

## S3 scan ingestion

In **OpenSearch → Ingestion pipelines → Create pipeline**, choose **Use S3 scan
blueprint**. Replace the bucket, prefix, sink endpoint, Region and role. The role
needs ListBucket plus GetObject for unversioned objects or GetObjectVersion for
pinned versions, along with the sink's existing discovery/write permissions.
Use newline-delimited JSON objects and a stable `id` field for the blueprint's
document_id setting. No Docker or Data Prepper process is needed.

Validation checks the supported configuration and bucket dependency; runtime
access failures appear in **S3 source scan**. Refresh shows actual listing,
accepted/delivered counts and completion. HTTP test-event controls are absent
for this source. Stop then Start explicitly scans again; restarting StackSim
resumes its current checkpoint. Capacity changes preserve the run.

The current profile supports one bucket/prefix, optional UTC time window or
relative range, NDJSON and none/gzip compression. Each object has a 10 MiB
stored/expanded and 1,000-event limit; each scan selects at most 1,000 objects.
Source objects are not deleted. Failed records use the existing S3 DLQ when
configured; otherwise permanent failures block the scan. Fix malformed/changed
objects and start a new scan. See the [source contract](opensearch/os09-acceptance.md#s3-one-time-scan-source)
for authorization, bounds and replay behavior.

## DynamoDB stream ingestion

Choose **Use DynamoDB stream blueprint** when creating an ingestion pipeline.
Replace the table ARN, domain endpoint, Region and role. Enable NEW_IMAGE or
NEW_AND_OLD_IMAGES on the table. Grant the role DescribeTable on the table;
DescribeStream/GetShardIterator/GetRecords on its stream; DescribeDomain and
ESHttpPut/ESHttpDelete on the sink. Resource policies and FGAC also apply.

The source captures changes rather than loading an existing table snapshot.
LATEST begins at the first successful source activation; TRIM_HORIZON starts at
the oldest retained record. The blueprint uses stable primary-key metadata,
index/delete action metadata and external versions. Keep this source in a
dedicated index. The current profile accepts string partition/sort keys without
`|`, up to 512 bytes combined; unsafe numeric precision is rejected.

**DynamoDB stream source** shows actual accepted/delivered/pending counts and the
pinned stream/checkpoint. Stop/Start resumes this position. A replaced stream or
expired retention blocks with an error; resynchronize into a new index and
pipeline. Failed events go to the configured S3 DLQ, including action/ID/version
metadata, or remain failed in the encrypted buffer. An initial PITR export can
load existing items using the snapshot blueprint. Multiple shards/tables, other
key types and Serverless sinks remain unsupported for this
source. See the [complete source contract](opensearch/os09-acceptance.md).

## Serverless one-time S3 jobs

Open a NextGen search or vector collection and choose **Ingestion jobs → Create
ingestion job**. Enter the S3 bucket name or ARN, optional key prefix and target
index. A separate failure index defaults to `<target>-ingestion-failures`.

Your current identity must be able to list/read S3, use the collection data plane
and create/write both indexes. Network and data access policies still apply.
The job retains your identity reference and fails if its key/session expires or
is revoked. JSON, JSON arrays and NDJSON are supported, optionally gzip; document
extraction and AI enrichment are unavailable. Limits are 1,000 objects, 10 MiB
stored/expanded per object and 1,000 records per object.

Refresh shows real discovered/ingested/failed object counts. Failed records are
identified in the failure index by object URI and record position. Cancel stops
pending work and preserves already indexed documents. Restart resumes the job;
source-derived IDs limit duplicate records when a committed write is replayed.
Deleting the collection removes its job history and encrypted work data. The
four continuous stream APIs remain unavailable.

### Continuous Serverless S3 streams

Open a NextGen search/vector collection and choose **Ingestion streams**. First
configure a dedicated standard SQS queue and S3 ObjectCreated notifications.
Create an IAM role trusting `aoss.amazonaws.com` (scope `aws:SourceArn` to the
collection's `ingestion-stream/*` ARN). Give it SQS GetQueueUrl,
GetQueueAttributes, ReceiveMessage and DeleteMessage, S3 ListBucket/GetObject,
IAM aoss:APIAccessAll and collection data access to both destination and failure
indexes. The creating identity needs iam:PassRole.

Choose the queue, role and target index. Optionally list up to five source buckets
and select which should scan existing objects. Without a bucket list, notifications
may name any same-account/Region bucket the role can read. Refresh the detail
page for object counts and active access/resource alerts; correcting a policy
allows automatic retries. INGESTION_COMPLETE means current work is done; an
ACTIVE stream continues polling. Unsupported/malformed inputs go to the failure
index. Only JSON/JSONL/NDJSON (optional gzip) ObjectCreated ingestion is supported.
Source deletes and removing array entries do not remove documents from the index.

Deleting a stream stops delivery and removes its encrypted checkpoint; indexed
documents, the source bucket and queue remain. Receipt completion is durable
before queue acknowledgment; restart can replay an unacknowledged record with
the same ID. Keep other consumers off the stream's queue. See the [stream
contract](opensearch/os09-acceptance.md#serverless-continuous-s3-ingestion-streams)
for bounds and recovery behavior.

### Load a DynamoDB snapshot before CDC

Choose **Use DynamoDB snapshot blueprint** when creating an ingestion pipeline.
Set the source table, role, managed-domain endpoint and export bucket/prefix.
Enable PITR and new-image streams on the table first. The role needs
DescribeContinuousBackups, ExportTableToPointInTime, DescribeExport and S3
GetObject/PutObject as well as ordinary stream and target permissions. The
bucket's policy must also allow the DynamoDB service principal to write under
the export prefix with the table ARN/account as its source.

The **DynamoDB stream source** card reports the actual export ARN, acknowledged
item count, total and completion. Existing records load first, then changes made
during the export are applied. Stop/Start or restart resumes the same snapshot.
Use a dedicated empty target index; the local profile supports up to 1,000 initial
items and 10 MiB compressed/expanded data. Failed/mutated exports or expired CDC
retention require a new pipeline and resynchronized index. Export artifacts stay
in S3 after the pipeline is deleted. See the [initial export contract](opensearch/os09-acceptance.md#dynamodb-initial-pitr-export-and-cdc-handoff).

## IAM applications and shared workspaces

Applications now support local IAM authentication, managed-domain and collection
associations, shared SEARCH workspaces, data views, saved searches and Dev Tools.
Create an application from **Applications**, choose dashboard administrators (`*`
or one IAM role ARN), associate existing source ARNs, then attach a domain with
a workspace or use **Open workspaces → Create search workspace**. Collections
use the latter flow. Set a default application to expose its shortcut in the list.

Every application user needs `opensearch:ApplicationAccessAll` on its ARN and
independent data permissions on the selected source. An administrator can edit
shared saved objects; that setting grants no source data permissions. Source
queries preserve domain resource policies/FGAC/DLS/FLS and collection network/
IAM/data policies. A collection can allow only the application service using
`SourceServices: ["application.opensearchservice.amazonaws.com"]`; its public
endpoint remains denied unless separately allowed.

The standalone HTTPS link requires the StackSim CA and IAM credentials held only
in page memory. Endpoint requests sign with `opensearch`; control APIs sign with
`es`. Signed GET `/` redirects to `/app/workspace_initial`. Presigned `/_login/`
sessions and identity federation remain unavailable. Deleting an application
removes its saved objects, preserving source domains, collections and documents.
`AWS::OpenSearchService::Application` supports owned updates, replacement and
retention. See [OS-11A acceptance](opensearch/os11a-acceptance.md) for limits,
restart/fault evidence and remaining identity/direct-query/ML scope.

## CloudWatch Logs connected data sources

Open **OpenSearch → Connected data sources → Connect data source**. Choose an
existing role that trusts `directquery.opensearchservice.amazonaws.com`, grants
`logs:StartQuery` on the intended groups, and that you can pass. Associate an
active collection. A blank access policy limits querying to the creator; a
custom policy must allow the caller's direct-query actions, independently of
the caller's IAM permissions.

The detail page runs SQL/PPL over actual Standard-class log storage. For example:

```sql
SELECT level, COUNT(*) AS events FROM `/orders/api` GROUP BY level
```

```text
source = `/orders/api` | where duration >= 100 | fields @timestamp, @message
```

Queries cover the selected time range and support cancellation and result
pages. Limits: one group, 50,000 scanned events, 64 MiB materialized data, 10,000
result rows and 30 seconds. Source roles/policies are checked again when reading
results. Deletion cancels active owned queries and preserves logs, roles and
collections. SecurityLake, Prometheus, S3/Glue, indexed views and the native
direct-query wire API remain unavailable. The same SQL/PPL subset also executes
in **CloudWatch → Logs Insights**, including saved definitions and query history.
See [OS-11A acceptance](opensearch/os11a-acceptance.md) for the detailed contract.

## Cross-cluster connections

Open a managed domain and choose **Connections**. Enter an alias and destination domain, optionally specifying its account and Region. Both domains must already exist with fine-grained security and node-to-node encryption. On the destination domain's Connections page, accept the inbound request. The source page then permits combined queries such as `orders,remote:orders` with a JSON search body.

The destination's access policy must explicitly allow `es:ESCrossClusterGet` on its bare domain ARN. The current caller also needs the relevant IAM permissions and mapped destination index permissions for search plus `indices:admin/shards/search_shards`. Local indexes require local permissions. **Skip unavailable destination** permits partial results only for destination availability failures; the results show successful/skipped cluster counts. Deleting either connection view revokes future remote queries while preserving both domains' documents. Cross-account approval uses the destination owner's credentials and Region. See the [supported profile and recovery evidence](opensearch/os11b-acceptance.md).

The same Connections page includes **Compare domain configuration**. Select a same-account target ARN and metadata categories to read live differences in aliases, templates, pipelines, ISM and security resources. Counts summarize matching, missing and diverged items; expand **Field differences** for details. Password verifier values remain redacted, and large responses explicitly indicate omitted details. Comparison requires IAM permission on both domains and does not require an active connection.
