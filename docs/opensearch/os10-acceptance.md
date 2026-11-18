# OS-10 advanced embedded search

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

Exact float-vector search and managed index APIs were delivered earlier. This
increment adds executable ingest/search pipelines, hybrid search, bounded SQL/PPL
index state management and dictionary packages/custom analyzers. Broader reference/fault evidence remains open; OS-10 is not
complete.

## Dictionary packages and custom analyzers

Twelve modern package APIs and their nine legacy counterparts share one catalog:
create/update/delete/describe, history, single/batch association/dissociation,
domain/package listings and sharing scope. TXT-DICTIONARY imports read actual S3
objects under caller GetObject and bucket-policy authorization. Imports require
the same account and Region and enforce archived-object readiness and SSE-C
restrictions. Package administration uses the ordinary es control permissions;
association operations use the domain resource and its tags. Domain resource
policies and FGAC do not grant control-plane package permissions.

Immutable dictionary copies use the existing AES-256-GCM material store, bound
to account, Region, package generation and version. The control catalog contains
opaque material IDs, not dictionary text. Import, association and deletion
intents persist before acknowledgement. Restart resumes their workers. A failed
association restores the previous engine binding and preserves its active version;
retrying association installs the available version. Partial deletion remains
retryable, including after some encrypted versions are already removed. A failed
import can be deleted and recreated; automatic import retries are unavailable.

Importing a version does not change existing associations. Reassociation applies
the latest available version. Index-time and non-updateable search dictionaries
remain pinned to each index's creation-time package version. Synonym search
filters with updateable true refresh on association. In-use indexes prevent
dissociation. Dictionary versions are loaded before endpoint activation, after
maintenance and after encryption migration. Snapshot exports include package
version references without copying dictionary contents; restore requires those
versions on the target domain. Templates can retain references after dissociation
and then fail future index creation until their package is restored.

Custom analyzers combine standard/whitespace/keyword tokenizers with lowercase,
stop and single-term synonym filters. Stop words and synonyms may be inline or
reference an associated analyzers/PackageID; paths never access the filesystem.
Synonym rules support directional mappings, equivalent alternatives and expand.
Rules match the tokens at that filter's stage, so their case must agree with
preceding lowercase processing. Token offsets, position gaps and alternatives
participate in full-text and phrase queries. Index default/default_search and
field/query overrides execute; _analyze returns actual tokens. Analysis settings
are immutable. Default/index filters cannot be updateable. Multiword graphs,
character filters, language/stemmer/native plugins and scripts reject. Explicit
custom analyzer overrides in DLS and relational/aggregation filters are outside
this profile; mapped analyzers still apply to secured candidates.

Bounds: 100 packages/account/Region, 20 retained versions/package, 20 packages per
domain, 64 KiB/UTF-8 dictionary and 1,000 non-comment entries. Sharing allows 100
account IDs or GLOBAL when vending was enabled at creation; revocation blocks new
associations but retains existing copies. Pagination is authenticated, scoped,
stale-sensitive and expires after ten minutes. Each index allows 32 analyzers,
32 filters, 16 filters/analyzer, 64 KiB configuration and 1 MiB compiled analysis.
Rules allow 32 alternatives/term and 256-character terms. Analysis requests are
bounded to 1 MiB input, 65,536 tokens and 4 MiB token text; phrase execution has a
shared ten-million-comparison budget. These are embedded semantics, not native
tokenization/scoring parity. Executable, license/configuration, customer KMS and
Serverless packages are unavailable.

Three analyzer and six package tests pass, including official modern/legacy SDKs,
real S3 permissions and archived objects, actual query changes, pinned/live versions,
encryption, restart, maintenance, snapshots, rollback, sharing and limits. Three
additional forced-process-termination tests verify acknowledged import intent,
association installation and partial deletion recovery. Two passing browser
journeys at 1440/390 pixels cover S3 selection, validation, import, sharing, versions,
real search effects, in-use dissociation denial and deletion. Screenshots were
inspected. AWS/native comparison and Linux/Windows execution remain unverified.

References: [custom packages](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/custom-packages.html),
[package creation](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_CreatePackage.html),
[sharing scope](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_UpdatePackageScope.html),
[IAM resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_es.html),
[search analyzers](https://docs.opensearch.org/latest/analyzers/search-analyzers/).

## Index state management

Managed domains implement policy create/get/list/update/delete and index
add/remove/change_policy/retry/explain under `/_plugins/_ism`. Updates require
the current `if_seq_no` and `if_primary_term`. Definitions and attached revisions
live in the same durable, optionally encrypted transaction store as documents.
An attached revision stays pinned until change_policy is requested, including
when its saved definition is edited or deleted. Changes are queued for the next
execution interval and may select a starting state or filter current states.
Remove stops future actions without reversing earlier effects. Explain reports
the actual attached revision, state/action, completion, failure and retries.

The scheduler performs one action or transition per index every five seconds,
resumes durable checkpoints after restart and pauses during node maintenance.
Actions execute in order. Supported actions are read_only, read_write, delete
and rollover. Write blocks affect index/create/update/delete-document and bulk
items, including no-op updates. Reads and index administration remain available.
Delete removes documents, aliases and the managed-index checkpoint atomically.
Rollover requires a numeric index suffix, a configured rollover_alias and an
explicit write-index alias. It creates the incremented, zero-padded index and
moves that write alias in one transaction. It copies mappings/settings, resets
the successor write block and applies matching ISM templates; other aliases
remain with the original index. A conflicting successor or authorization failure
rolls back both index creation and the alias change.

Transition conditions support min_index_age, min_rollover_age, min_doc_count
and min_size. All supplied conditions must match; transitions are tried in
definition order. Empty conditions always match. Rollover supports the first,
third and fourth conditions. Counts and size use current committed live sources,
including unrefreshed documents; size is UTF-8 JSON source bytes, not Lucene
segment bytes. Index creation age is persisted for new indexes. An older index
without creation metadata uses attachment time. Restored indexes start at restore
time; snapshots deliberately exclude ISM policies/jobs and execution identities.
Retry configuration supports constant, linear or exponential delays with at most
10 retries. Timeouts persist as failed jobs. Explicit retry can resume an action
or enter another state. Action effects and their checkpoint commit together;
failure records retain the attempted policy revision without advancing its action.

ISM templates attach to newly created indexes using highest priority; equal
priority matches from different policies reject creation atomically. Existing
indexes require explicit attachment. Template jobs run as the policy editor;
explicit attachments/changes/retries use their caller. Stored identities contain
no credentials. The scheduler resolves current FGAC roles, internal-user backend
roles and master status before actions, including target permissions at rollover.
Deleted users, revoked grants and enabling FGAC on formerly unrestricted jobs
produce visible failures. Entry points also use the normal domain/IAM gates.
Background delegated work does not replay IAM signatures or impersonate master.
Cluster actions use `cluster:admin/opendistro/ism/<route>/<method>`; index status
and management use `indices:admin/opensearch/ism/get` and `/managedindex`, plus
the actual settings/delete/alias/create permissions. The local
index_management_full_access action group grants ISM API permissions only;
index action grants are still required.

Limits: 100 policies/domain, 64 KiB/policy, 32 states, 128 total actions and
transitions, 10 templates/policy, 20 patterns/template and the existing 100-index
bound. Cron, notifications, force_merge, allocation/replicas, native storage
tiers, shrink, close/open, rollups, snapshots as ISM actions, arbitrary scripts,
bulk policy creation, validation endpoints and Serverless ISM reject. This is a
bounded embedded lifecycle interpreter; native scheduling/timing is not claimed.

Four focused tests cover lifecycle/versioning, read-only single/bulk effects,
encrypted restart, rollover rollback, priority conflicts, retries/timeouts,
revocation/deleted users and the official client's signed ISM methods with the
actual service scheduler. Related engine, security, snapshot and Serverless tests
pass. The console provides a revision-aware policy editor and attach/change/
retry/remove/explain workflows. Two passing browser journeys at 1440/390 pixels
exercise validation, versioned edits, action effects, change/failure/retry,
removal and deletion; desktop/mobile screenshots were inspected. External engine comparison and Linux/Windows
execution remain unverified.

References: [ISM API](https://docs.opensearch.org/2.19/im-plugin/ism/api/),
[ISM policies](https://docs.opensearch.org/2.19/im-plugin/ism/policies/).

## Ingest pipelines

Managed-domain endpoints implement saved pipeline PUT/GET/DELETE, listing and
inline/saved simulation. The official OpenSearch client is exercised. Definitions
live in the domain engine transaction store, use encrypted persistence when
enabled and are included in optional snapshot global state. Index/bulk writes
run a request pipeline or `index.default_pipeline`, then `index.final_pipeline`.
`pipeline=_none` skips the default only. Bulk items can select their own pipeline;
failed items preserve earlier successful items. Dropped documents return a noop.
Rejected documents cannot change source, mappings or sequence/version state.

Fifteen processors execute: set, remove, rename, append, convert, JSON, lowercase,
uppercase, trim, split, join, gsub, drop, fail and nested pipeline. Configuration
validation rejects unknown processors/options before saving. Field templates
support scalar substitution and `_ingest.timestamp`; field paths cannot mutate
metadata or prototype properties. Regex operations use RE2. Processor and
pipeline failure handlers and `ignore_failure` are supported. Resource-limit
errors cannot be swallowed by these handlers. Simulation has no indexing effect
and reports per-document/per-processor results.

FGAC uses the cluster ingest permissions, including `cluster_manage_pipelines`.
Executing writes still needs ordinary index permissions and does not grant
pipeline administration. Versioned updates support `if_version`. The console
creates versioned definitions and uses that precondition when editing them.

Bounds: 100 definitions/domain, 256 KiB/definition, 64 processor steps/document,
eight nested pipelines, 1 MiB transformed documents, 1,000 simulated documents
and 32 MiB simulation output. Scripts, conditions, advanced Mustache, metadata
mutation/index rerouting, external enrichment, native processor metrics,
Serverless ingest pipelines, multi-name deletion and updates on indexes with
configured pipelines are unavailable. Missing referenced pipelines fail writes;
removing a definition does not silently clear index settings.

Three focused tests cover client CRUD/simulation, actual transformation, bulk
partial failure, default/final ordering, dropping, failed-write rollback, version
conflicts, encrypted restart, snapshot restore, RE2, nested pipeline limits and
FGAC. Existing engine, snapshot and Serverless tests pass. Two browser journeys
at 1440/390 pixels exercise invalid definitions, simulation, create/edit/apply,
transformed SDK writes and deletion. No full regression suite was run. External
native comparison, exhaustive processor cases and Linux/Windows execution remain
unverified.

References: [ingest APIs](https://docs.opensearch.org/latest/api-reference/ingest-apis/index/),
[applying pipelines](https://docs.opensearch.org/latest/ingest-pipelines/index/),
[simulation](https://docs.opensearch.org/latest/ingest-pipelines/simulate-ingest/).

## SQL and PPL

Managed endpoints execute GET/POST `/_plugins/_sql` and `/_plugins/_ppl` with
JDBC-shaped schema, rows, total, size and status. A bounded tokenizer/AST and
typed scalar interpreter read the same refresh-visible documents as search;
query text never executes as SQLite SQL or caller code. Index aliases/patterns
resolve through ordinary index authorization. DLS/FLS applies before filters,
grouping, sorting and projection. Hidden fields cannot be queried or inferred
through the relational schema. Disabling explicit body index names disables
these global endpoints. Serverless rejects them.

SQL supports SELECT fields/aliases/star, WHERE, GROUP BY, ORDER BY, LIMIT/OFFSET
and COUNT/SUM/AVG/MIN/MAX. PPL supports source, where, fields, stats, sort and
head. Filters include comparisons, AND/OR/NOT, IN, BETWEEN, LIKE and IS NULL.
NULL comparisons use three-valued logic. LIKE uses percent/underscore wildcards;
strings compare case-sensitively as complete values. Numeric coercion follows
saved mappings; cross-type comparison coercion is unavailable. SUM/AVG/MIN/MAX
accept numeric fields; COUNT ignores null field values. Unordered results and
equal sort keys retain local index/document order; missing sort values are last.
PPL sort defaults to 1,000 rows; sort 0 keeps all rows up to the response bound.
The optional request filter runs the existing DSL over secured candidates.

SQL fetch_size returns principal-bound immutable cursor pages. Cursors share
the existing 20-context/64 MiB pool with PIT/scroll, expire after five minutes,
can be explicitly closed, disappear on restart and reject after FGAC revisions.
Fresh IAM/domain policies and index permissions still apply on every page.
The pinned official client's cursor request type is incomplete; its runtime
request works and is exercised with a localized TypeScript assertion.

Explain returns a labeled StackSim execution plan without scanning documents.
This is an embedded plan, not a native optimizer trace. It validates source
permissions and relational field references. CSV/raw/JSON formats, joins,
subqueries, unions, writes/DDL, prepared parameters, scripts, arbitrary
functions, dates/objects/vectors, incompatible field types and multivalued
fields reject. Additional SQL/PPL syntax remains outside this profile.

Limits: 32 KiB query, 2,048 tokens, 32 PPL commands, 128 result columns, 4,096
mapped fields across selected indexes, 10,000 result rows/groups, 64 MiB logical
intermediate data, 32 MiB output, ten million LIKE comparisons and the ordinary
30-second request deadline. These are logical execution budgets, not a hard
Node heap quota. Results over the default 10,000-row window are truncated with
their full matching total; pagination cannot extend that window.

Three focused tests cover a hand-calculated corpus, refresh visibility, aliases,
aggregates, nulls, projection, filtering, sorting, cursor snapshots/ownership/
expiry/closure/exhaustion, DLS/FLS, unsupported syntax and resource bounds,
official SQL/PPL clients, domain policy denial and encrypted restart. Existing
engine/security tests pass (eight focused tests together). Two browser journeys
at 1440/390 pixels cover errors, actual rows, plans, pagination/closure, PPL and
empty results; screenshots were inspected. TypeScript checks pass. No full
regression suite, native comparison or Linux/Windows execution was performed.

References: [2.19 SQL/PPL API](https://docs.opensearch.org/2.19/search-plugins/sql/sql-ppl-api/),
[2.19 response formats](https://docs.opensearch.org/2.19/search-plugins/sql/response-formats/).

## Hybrid search and search pipelines

Managed PUT/GET/DELETE `/_search/pipeline/{id}` and listing persist definitions in
the domain transaction store. Encrypted domains protect them; optional snapshot
global state now includes search pipelines alongside ingest pipelines. Pipeline
administration requires cluster search-pipeline privileges, while execution
requires ordinary index search privileges. The local cluster_manage_pipelines
group covers both pipeline families. Snapshot export/restore checks their
corresponding cluster get/put privileges. Missing pipelines fail requests.

Definitions support one normalization-processor, with min_max or l2
normalization and weighted arithmetic/geometric/harmonic means. Weights must
match 1–5 hybrid subqueries and sum to one. min_max assigns 1 to equal scores
and 0.001 to normalized minima; zero-norm l2 uses 0.001. Missing subquery scores
are zero. Arithmetic means include those zeros; geometric/harmonic means omit
nonpositive scores and renormalize the contributing weights. These choices
follow the referenced 2.19 source formulas, with JavaScript numeric precision.
The lexical scores and exact-vector candidates remain the documented embedded
approximations, not native BM25 or ANN.

Requests select a saved pipeline by URL/body, an inline body definition or
index.search.default_pipeline. _none bypasses/removes a default; null clears
the index setting. A multi-index request with conflicting defaults must choose
explicitly. A normalization-only pipeline leaves ordinary searches unchanged.
Hybrid queries require a pipeline, are top-level only and use 1–5 existing DSL
clauses, including exact k-NN. Index authorization and DLS/FLS run before
candidate selection and normalization. A hidden vector cannot be queried.

Each local index has one logical shard. Each subquery collects its best size
or pagination_depth candidates per index; vector candidates additionally obey
k. Normalization uses the collected pool across selected indexes. from > 0
requires explicit pagination_depth, bounded by max_result_window and 10,000.
Keeping depth stable keeps rankings stable across pages for unchanged data.
Counts/aggregations use the complete authorized matching union, including each
vector clause's top-k set. post_filter filters results without renormalizing.
Ties use local index/document identity. Only descending score ordering is
supported for hybrid queries; PIT/scroll/search_after, field sorts, rescore,
collapse, score explanations, neural inference, normalization bounds and other
pipeline processors remain unavailable. Serverless rejects this surface.

Bounds: 100 definitions/domain, 64 KiB/definition, five subqueries, existing
document/output limits and the request deadline. Definition version is stored
metadata; conditional pipeline updates are unavailable. The console provides
create/edit/delete, inline test queries and default-index settings. Deletion
warns that dependent searches will fail and requires confirmation.

Three focused tests cover hand-calculated normalization/combination scores,
lexical/vector queries, pagination depth, counts/aggregations, post-filters,
defaults/inline/_none, malformed definitions, DLS/FLS, encrypted restart,
snapshot restore, official-client CRUD/search/msearch and partial errors.
Relevant engine/security/vector/snapshot/SQL/Serverless tests pass. Two browser
journeys at 1440/390 pixels cover invalid definitions, unsaved testing, actual
ranked results, create/edit/default settings/deletion and recovery from a
deleted default. Screenshots were inspected and TypeScript checks pass.
Native comparison and Linux/Windows execution remain open.

References: [normalization processor](https://docs.opensearch.org/2.19/search-plugins/search-pipelines/normalization-processor/),
[pipeline selection](https://docs.opensearch.org/2.19/search-plugins/search-pipelines/using-search-pipeline/),
[hybrid pagination](https://docs.opensearch.org/2.19/vector-search/ai-search/hybrid-search/pagination/),
[2.19 normalization source](https://github.com/opensearch-project/neural-search/tree/2.19/src/main/java/org/opensearch/neuralsearch/processor/normalization),
[2.19 combination source](https://github.com/opensearch-project/neural-search/tree/2.19/src/main/java/org/opensearch/neuralsearch/processor/combination).
