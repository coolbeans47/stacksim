# Embedded Serverless foundations

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

Implemented on 2026-11-17, following the agreed in-process, no-Docker runtime.
This record covers the SEARCH collection foundation; it does not declare the
whole OS-06/OS-07 design complete. [OS-07 acceptance](os07-acceptance.md) records the later collection types, groups and retention implementation.

## Implemented behavior

The AOSS JSON 1.0 control endpoint uses `OpenSearchServerless.<Operation>`, the
`aoss` SigV4 service, and the frozen model's lower-camel-case input members.
Twenty-five control operations now execute real local behavior: collection
create/update/delete/batch-get/list, data-access and encryption/network policy
CRUD/list, management index CRUD, account capacity, policy statistics and tags.

Collections have separate account/Region catalogs, immutable generations and
stable HTTPS endpoints. Creation first persists its intent and endpoint lease,
then opens encrypted storage before reporting ACTIVE. Startup reopens that same
generation; missing initialized data/key material fails closed. Deletion revokes
the endpoint, removes the generation and key, and retires the port. Recreating
the same name cannot inherit the old endpoint or data.

Every collection uses the AES-256-GCM snapshot/journal implementation described
in [OS-03 acceptance](os03-acceptance.md). A matching encryption policy is required
unless the modeled direct `encryptionConfig.aWSOwnedKey` override is supplied.
`kmsKeyArn: auto` identifies the resource-owned-key compatibility mode; StackSim
does not claim that it contacted AWS KMS. Customer KMS configuration rejects.

The local endpoint requires three independent grants:

1. A matching public **collection** network rule. Dashboard-only rules do not
   open the collection endpoint. Removing or changing the rule affects the next
   request. Private endpoint/service adapters remain unavailable and reject.
2. IAM `aoss:APIAccessAll` on the collection ARN, including explicit-deny handling.
3. A data-access policy granting the signed IAM user or role the actual resolved
   index operation. IAM administration alone does not bypass this policy.

Policy updates use opaque modeled base64 versions; stale updates conflict.
Create/update/delete token results are persisted with their request fingerprint
for 24 hours, bounded to 1,000 records/account/Region. Reusing a token with changed
parameters conflicts. Policy pagination tokens are signed, scoped to the query
and catalog contents, and expire after 15 minutes; stale/tampered tokens reject.

SEARCH data uses the embedded query/aggregation engine with per-index permissions
on individual bulk and multi-search items. It has a separate API allowlist;
managed-only refresh/scroll/security APIs reject. Search visibility advances on
the first request after a 10-second refresh boundary; realtime GET sees the latest
acknowledged document. Callers cannot override the collection refresh interval.
CAT indices omits health/status fields. Policy revisions invalidate private
search contexts through the authority fingerprint.

Account capacity affects actual shared admission: one configured OCU permits
four concurrent local indexing or search requests, capped at 32 in each class.
This is a documented local admission model, not cloud compute provisioning,
cloud autoscaling or billing. The implementation runs in one process and does
not provide cloud standby-replica availability. Collection deletion protection
rejects deletion until explicitly disabled.

CloudFormation registers Collection, AccessPolicy, SecurityPolicy, Index and
CollectionIndex providers.
They share the same live catalog, enforce ownership, wait for readiness/deletion,
support mutable settings/tags, replace immutable identity fields, and preserve
retained collections. Security policy physical identity includes its type;
`Ref` returns the policy name. Bootstrap revision 24 adds a separate bounded
search execution policy to stay within IAM's managed-policy size limit.

The console has collection list/create/detail/edit/tags/delete, a signed local
query tool, separate policy list/create/edit/delete pages, and account-capacity
settings. Querying through the console enforces the same network/IAM/data policy
checks as the resource gateway. Mutation failures preserve the form and surface
the service error; policy updates send the displayed version.

The index providers use the [frozen AWS registry schemas](cloudformation-models.json)
retrieved on 2026-11-17. `Index` identifies a resource by
`IndexName|CollectionEndpoint` and exposes its persisted UUID. `CollectionIndex`
uses the registry primary-identifier order `Id|IndexName`. The latter Ref format
is derived from the registry composite-identifier contract; the public template
page still omits a Ref description. No authenticated AWS deployment comparison
has been performed.

Index ownership commits atomically with index creation in encrypted storage.
Recreating an index externally cannot satisfy an old CloudFormation owner.
Endpoint-based providers resolve only account/Region catalog endpoints and
enforce network/IAM/data policies; they never fetch arbitrary template URLs.
Management index providers require modeled control IAM and `aoss:APIAccessAll`
plus data-policy permissions. Unsupported nested mapping/settings fields fail
preflight. Retention releases ownership while preserving the index and data.

## Focused evidence

- `test/opensearch-serverless.test.ts`: official AWS/OpenSearch clients; the
  three independent access gates; wrong Region, IAM revocation, per-index
  multi-search, encrypted document scan/restart, stable/replaced endpoints,
  refresh visibility, management indexes, tags/capacity, protected deletion,
  policy validation/versioning/idempotency/pagination, catalog-save rollback,
  missing-key startup failure and cleanup.
- `test/opensearch-serverless-cloudformation.test.ts`: dependency ordering,
  outputs, update, replacement, tags, shared policies and retained collection.
- `test/browser/opensearch-serverless.spec.ts`: authenticated policy creation,
  collection creation, signed document write/read, configuration/tags and
  deletion at 1440 and 390 pixels; no horizontal page overflow or browser errors.
- `test/opensearch-serverless-index.test.ts`: no data-policy bypass, immutable
  ownership across outside deletion/recreation, retained indexes, unsupported
  schema validation and unknown endpoint rejection.
- Existing focused managed service, FGAC, CloudFormation and bootstrap tests
  continue passing after the shared engine/bootstrap integration.

Executed locally on macOS with Node 22.13.0. TypeScript passes. The cross-platform
workflow is checked in; Linux/Windows remote execution and AWS reference-console
captures have not been performed.

## Remaining phase work

Collection types, groups and retention are now covered by the OS-07 implementation.
Customer KMS, identity/private network adapters, collection workspaces and broader
external reference/platform evidence remain open. Unsupported options reject.
Native ANN/OCU/HA equivalence, customer KMS and upstream Dashboards are not
claimed. Alias/template APIs are not yet in the Serverless data allowlist.
The exhaustive crash-boundary and reference-response matrices remain open.

Primary references checked for these contracts:
[client collection defaults](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-create-cli.html),
[data permissions](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-data-access.html),
[network policies](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-network.html),
[encryption policies](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-encryption.html),
and [supported data APIs](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-genref.html).
