# OS-11A applications and CloudWatch direct queries

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

This is a bounded implementation record, not completion of OS-11A. Eleven
application operations and `AWS::OpenSearchService::Application` now produce
working local application endpoints and shared SEARCH workspaces. Identity
Center, SAML/Cognito, cross-account source roles, additional direct-query
backends/native query wire and ML capabilities remain open. Five CloudWatchLog
direct-query configuration operations and real Logs SQL/PPL jobs are implemented. Search and application storage run inside StackSim;
no Docker or external Dashboards process is needed.

## Application and authorization contract

The frozen SDK implements Create/Get/Update/Delete/ListApplication,
Attach/Detach/DescribeDataSourceAttachment/ListDataSourceAttachments and
Get/PutDefaultApplicationSetting. Existing AddTags/RemoveTags/ListTags also
accept application ARNs. Control requests sign with `es`; application HTTPS
requests sign with `opensearch` and require
`opensearch:ApplicationAccessAll` on the application ARN. Resource/request tag
conditions apply. The console's local application routes use its signed `es`
session and independently enforce application access.

Application sources are current same-account, same-Region managed domains or
collections. Association checks the caller's DescribeDomain/BatchGetCollection
permission. Each source pins its generation. Every data request preserves the
current caller and checks domain IAM/resource policy plus FGAC/DLS/FLS, or
collection IAM/network/data policies. Opening an application, administering
saved objects, and attaching a source do not grant access to source documents.
Updating an association explicitly to a replacement source uses a new saved
object namespace; an old association alone cannot cross that generation.

AttachDataSource accepts managed domains, automatically associates them and
optionally creates a SEARCH workspace or links an existing workspace. The two
workspace options are mutually exclusive. With both resources active it returns
ATTACHED; otherwise PENDING resolves after activation, fails on source loss or
replacement, or times out after 24 hours. Repeated attachment returns the
existing attachment. Detach removes the source association and workspace links.
Collections use Create/UpdateApplication associations and the authenticated
workspace creation route. Supported network rules can grant the internal
`application.opensearchservice.amazonaws.com` service access without permitting
public collection traffic. This context is supplied by the application owner,
never accepted from a request header or query body.

Dashboard administrator configuration accepts `*` or one IAM role ARN. An unset
configuration grants no administrator privileges. Group values require an
identity provider and reject. Application users can read shared saved objects;
only administrators can create workspaces or modify saved objects. Source
queries always retain the caller's source permissions, including Dev Tools
writes and security configuration operations.

The HTTPS shell at `/app/workspace_initial` signs requests with credentials held
only in page memory; signing out clears them. A signed GET `/` returns the
documented redirect. Presigned `/_login/` browser sessions, cookie sessions,
Identity Center and external identity federation are not implemented. KMS key
and source-role options reject rather than storing inactive integrations.

## Durability and bounds

CREATING/UPDATING/DELETING intents are durable. ACTIVE requires both the encrypted
saved-object engine and the reserved HTTPS listener. Restart resumes intent;
missing keys/storage or occupied endpoints fail closed. Application deletion
drains requests, removes only its own encrypted store/key, and retires its port.
Domains, collections and their documents remain. Endpoint ports occupy
35000–39999, separate from domain, collection and ingestion ranges.

Limits: 20 applications per installation; 20 sources and 20 SEARCH workspaces
per application; 100 saved objects per workspace/source and 1,000 per application;
16 concurrent queries; 10 MiB input and 32 MiB output. Source engine bounds still
apply. The application owns no copy of indexed documents. Shared saved objects
use resource-owned AES-256-GCM storage. Catalog metadata remains ordinary control
state. Idempotency records expire after 24 hours, limited to 1,000 per
account/Region; pagination tokens are HMAC-bound to operation/snapshot and expire
after ten minutes. Metadata changes can invalidate a page token.

The CloudFormation provider enforces ownership, stabilizes the live endpoint,
updates source/admin/tag settings, replaces name changes, and supports Retain.
Ref returns Name; GetAtt exposes Arn, Id and Endpoint. Names use the SDK limit of 3–30 characters; the wider frozen CFN maximum of 40 is not advertised. Bootstrap policy revision
27 adds application control permissions without granting application data access.

## Verification and remaining gates

- `test/opensearch-applications.test.ts`: four official SDK/wire integration
  tests cover lifecycle, tags/default setting, scoped IAM, source IAM and live
  DLS/FLS, shared objects, encryption/restart, private collection service access,
  source generation replacement, pending attachment activation/source loss, pagination, catalog rollback and key loss.
- `test/opensearch-application-cloudformation.test.ts`: real source dependencies,
  in-place update, replacement, retention and rejected adoption of retained state.
- `test/opensearch-application-recovery.test.ts`: five forced process termination
  boundaries—create intent, activation publication, update intent, delete intent
  and cleanup publication. Acknowledged shared objects survive update recovery.
- `test/browser/opensearch-applications.spec.ts`: desktop and 390 px journeys
  create/associate/attach, select default, write/query real documents, share saved
  objects with standalone IAM login, sign out and delete while preserving sources.
- Relevant existing workspace, Serverless and bootstrap checks pass; TypeScript
  validation passes. No full regression suite was run.

AWS/native reference execution and Linux/Windows execution remain unverified.
The frozen models and primary documentation informed the local subset; they do
not establish behavioral parity for unimplemented options or identity sessions.
Other OS-11A direct-query/capability/security-config operations remain unavailable.

References: [application creation](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_CreateApplication.html),
[domain attachment](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_AttachDataSource.html),
[IAM authentication](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/application-auth-iam.html),
[data-source and service network access](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/application-data-sources-and-vpc.html).

## CloudWatch SQL/PPL dependency

The actual CloudWatch Logs StartQuery owner now executes a bounded SQL/PPL AST
over segmented log events, without copying them into an index. SQL names one
log group in FROM; PPL accepts one explicit source (including `[lg:`name`]`)
or one selected group. Both use Standard class groups in the caller account
and Region. Authorization and execution share the source parser; StartQuery
IAM and resource-tag conditions apply to that exact group.

Supported: scalar projections/aliases, comparisons/boolean/null/IN/BETWEEN/LIKE
filters, sorting, limits, grouping and count/sum/avg/min/max. Discovered JSON
dotted names and system fields are literal keys. Timestamps are integer epoch
milliseconds. Missing/null result cells are omitted; conflicting scalar types
fail when used. Joins, subqueries, wildcard/multiple sources, arbitrary
functions and other commands fail explicitly.

The local execution bound is 50,000 scanned events, 64 MiB scanned messages or
discovered rows, 4,096 discovered columns, 128 result columns, 10,000 result
rows, 32 MiB output and 30 seconds per execution. Limits fail instead of
returning partial aggregates. Jobs share the existing 100-query regional
quota, durable scheduling/restart, cancellation, paginated results and seven-day
history. The existing CWLI profile is unchanged.

The Logs Insights console executes, saves, updates and loads all three
languages. Four new official SDK tests cover actual events, aggregation,
pointers, pagination, restart, cancellation, expiry, syntax/class/selector
rejection, IAM/tag restrictions and the scan bound. Two browser journeys at
1440 and 390 pixels pass. The three index SQL/PPL tests, three existing CWLI
service tests and QueryDefinition CloudFormation test also pass. This
dependency does not by itself implement direct-query data-source APIs.

Contracts: [StartQuery](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_StartQuery.html),
[CloudWatch SQL](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_SQL.html),
[CloudWatch PPL](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_PPL.html).

## Direct-query CloudWatchLog sources

Add/Get/List/Update/DeleteDirectQueryDataSource use the frozen REST-JSON SDK
contract and datasource ARN. AddTags/RemoveTags/ListTags also accept these ARNs.
The source role must exist in the same account and trust
`directquery.opensearchservice.amazonaws.com` with the source ARN/account;
Create/Update require PassRole. Sources associate 1–20 active same-account,
same-Region collections and pin their generations. They query actual log
storage; association does not copy events into a collection or grant index
access. Removed/replaced collections block queries until explicitly reconfigured.

The console exposes signed local start/get/cancel routes under
`/_stacksim/api/opensearch/direct-query/{name}/`. These are explicitly local
routes, not a claim about the native StartDirectQuery wire protocol. Start
requires `opensearch:StartDirectQuery`; reading status/results requires both
GetDirectQuery and GetDirectQueryResult; cancellation requires CancelDirectQuery.
The local same-account profile additionally requires either the original creator
(user/role identity including its principal ID) or an explicit source-policy
allow. Custom policies do not bypass IAM denies. Cross-account and non-AWS
principals reject. Blank policy restores creator-only access; omitted policy
on Update preserves the prior policy. Source/resource/request tag conditions
apply to the corresponding IAM checks.

Every operation refreshes source role trust and checks logs:StartQuery against
the exact selected group, with resource account and log-group tags. Queued jobs
recheck before scanning; get/cancel recheck before exposing results or changing
state. Deleting a role, revoking trust/permissions or changing the source policy
takes effect on later calls. Historical results require the log group to remain
available and authorized. IAM resource-policy semantics are deliberately limited
to this documented conjunction of caller IAM and source-policy permissions.

The real Logs job stores the source generation/ARN atomically with query
admission. Query IDs belonging to ordinary Logs calls or another source
generation cannot be adopted. Catalog rollback does not lose committed jobs.
Query result data stays in the Logs owner's existing persistence; there is no
additional result cache or encrypted OpenSearch index. Durable deletion intent
blocks new calls, cancels only owned active jobs, and resumes after restart.
Existing Logs history, log groups, roles and collections remain. Retrying Delete
by name is supported after a cleanup failure.

Bounds: 20 sources per account/Region, 30 concurrent and 1,000 retained queries
per source, seven-day history, ten-row source-list pages with ten-minute signed
snapshot tokens. The SQL/PPL bounds above apply. No background auto-created
roles, materialized/indexed views, dashboards integrations, direct-query
application workspace views, S3/Glue, SecurityLake or Prometheus owner is claimed.
No CloudFormation type exists for this connection in the frozen schema set.

Four SDK/local-wire tests cover configuration/tags/listing/restart, owner and
IAM/access-policy gates, PassRole/current role trust, queued permission
revocation, query ownership, quota, catalog/job-save rollback and source loss.
Three child-process tests terminate at query commit, delete intent and delete
cleanup, then recover actual jobs and preserved sources. Two browser journeys
at 1440/390 pixels connect, run SQL/PPL, show an error, update settings/tags and
delete. These are focused checks; no full regression or AWS reference run was
performed.

Primary contracts: [AddDirectQueryDataSource](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_AddDirectQueryDataSource.html),
[CloudWatch source setup and permissions](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/direct-query-cloudwatch-logs-creating.html),
[query IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_opensearch.html).
