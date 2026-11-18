# Embedded collection groups, generations and retention

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

Implemented on 2026-11-17 inside StackSim, without Docker. This adds eleven
AOSS operation subsets to the OS-06 foundation (36 AOSS operations total), two
CloudFormation providers, and generation-aware console creation. It does not
close the complete OpenSearch design or the external evidence gates.

## Executable behavior

Collection groups have account/Region-scoped identity, ARN, generation, immutable
standby setting, tags, capacity limits and durable membership. Their five modeled
operations implement CRUD, batch-get and signed pagination. Membership is set by
`CreateCollection.collectionGroupName`; there is no invented generation member
on that request. IAM `AddCollectionToCollectionGroup` is evaluated on the group's
ARN. Nonempty groups cannot be deleted. This local profile admits one collection
type per group; that restriction is explicit rather than a claim about every AWS
backend combination. The default API group generation is Classic; the console
explicitly selects NextGen by default.

Classic names allow 3–32 lowercase letters/digits/hyphens; NextGen uses the frozen
model's 3–64 characters including underscores. The frozen lifecycle resource
identifier shape still excludes collection underscores, so the effective-policy
API rejects those resource identifiers; JSON policy matching supports them. This
model discrepancy is recorded rather than silently changing the pinned model.

SEARCH, TIMESERIES (the API default), and VECTORSEARCH now open encrypted stores.
SEARCH and TIMESERIES refresh at 10 seconds. Classic vectors refresh at 60 seconds;
NextGen vectors at 10 seconds. Time-series and Classic vectors require generated
IDs; unsupported explicit-ID/create/update bulk items fail individually while
valid items commit. NextGen vectors accept custom IDs and updates. Search and
time-series collections reject k-NN indexes. Vector search remains the existing
bounded exact float-vector interpreter, not ANN, compressed vectors or GPU work.

Six lifecycle operations implement create/update/delete/list, batch-get and
batch effective policies. Policy revisions reject stale updates. Exact duplicate
resource patterns across policies conflict. The most specific matching literal
pattern wins; `NoMinIndexRetention:true` means indefinite retention. Supported
minimum ages are integer 24 hours–3650 days. Equal-specificity distinct matching
patterns use policy-name order locally; broader AWS precedence evidence remains
open.

Ingestion timestamps are committed with documents in encrypted storage. A
60-second worker and pre-request sweep remove expired rows without deleting newer
rows; missing policies retain data. Expiry uses ingestion age, not user-provided
event timestamps, and invalidates cached result contexts. Restart reopens the
same timestamps. Deletion is never earlier than the minimum age. StackSim does
not emulate AWS's additional best-effort expiry lag, physical storage tiers, or
secure erasure of historical encrypted journal records.

Capacity settings allocate real admission slots: four concurrent requests per
OCU, capped at 32 per group/request class, additionally bounded by each engine's
request limit. Groups are independent of the ungrouped account pool. Classic
minimums start at 1; NextGen permits 0. Supported tiers are 1 (Classic), 2, 4, 8,
and multiples of 16 through 1696. Separate read/write allocations grow as requests
arrive and return to minimum after ten idle minutes. A zero allocation wakes
immediately. Engine memory is still resident: this is admission scaling, not
cloud worker provisioning, cloud cold-start latency, or zero process memory.

## Deployment and console

`AWS::OpenSearchServerless::CollectionGroup` and `LifecyclePolicy` use the frozen
regional registry schemas. Group `Ref` is its ID; `Id` and `Arn` attributes are
available. Policy `Ref` is its name. Collection now supports group membership,
all three types, deletion protection, and resource-owned `EncryptionConfig`.
Providers enforce resource ownership, authorization, replacement/dependency
ordering, mutable changes, and Retain ownership release. Bootstrap policy
revision 25 includes these lifecycle permissions.

The console offers NextGen Express Create and Standard Create, Classic Standard
Create, group list/create/edit/delete, and lifecycle policy CRUD. Express Create
composes modeled operations, uses persisted idempotency tokens, and saves a
non-secret form draft in session storage. Existing shared groups are preserved.
Existing policies are reused only when their complete document matches; different
policies stop the workflow rather than being overwritten. Partial failure never
triggers cleanup of shared resources. Application/identity workspace creation is
not presented as implemented.

## Verification

- `test/opensearch-serverless-lifecycle.test.ts`: policy precedence and validation;
  admission exhaustion/isolation/idle/wake; official SDK/client encryption,
  generation writes/refresh/vector search; expiry boundary and restart; policy
  versions/stats; group membership and per-resource IAM conditions.
- `test/opensearch-serverless-cloudformation.test.ts`: groups, collection
  dependencies, retention policy, mutable updates, replacement and cleanup.
- `test/opensearch-serverless-express.test.ts`: interrupted setup, retry,
  conflicting policy documents, and shared-group preservation.
- `test/browser/opensearch-serverless.spec.ts`: authenticated Classic and NextGen
  workflows at 1440 and 390 pixels, including interrupted Express setup/reload,
  group capacity changes, lifecycle editor, signed query and screenshots.

All ran locally on Node 22.13.0/macOS. Relevant existing Serverless, engine,
security, vector, and bootstrap tests also passed. The repository-wide regression
suite was not run. Linux/Windows matrix execution, AWS reference captures, and
broader interruption/rollback cases remain open. This brings recorded cumulative
evidence to 53 OpenSearch Node tests and 11 browser journeys.

## References and remaining boundaries

Generation behavior follows the current English [creation guide](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-create.html)
and [vector guide](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-vector-search.html).
The vector guide specifically documents NextGen custom IDs/10-second refresh;
the general operation table is narrower. Time-series updates remain explicitly
unavailable in the bounded profile because the overview and operation matrix
conflict on that detail. Policy and capacity behavior is based on the
[lifecycle guide](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-lifecycle.html),
[group limits](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/collection-groups-capacity-limits.html),
[scale-to-zero guide](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-scale-to-zero.html),
and [IAM action reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_opensearchserverless.html).

Warm storage/warm-after, accelerated/compressed/derived-source vector behavior,
remote model inference, application workspaces, customer KMS, private networking,
and broader service integrations remain individually open. The embedded runtime
choice does not turn these missing behaviors into completed phases.
