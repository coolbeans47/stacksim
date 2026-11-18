# OpenSearch developer implementation scope

Revised 2026-11-17 at the user's request: **stop pursuing full OpenSearch parity and retain a practical embedded simulator for learning and application testing**. This replaces the earlier instruction to implement every remaining OS phase. Search stays inside StackSim without Docker, Java or an external engine.

## Required scope and status

The core developer workflows are implemented: supported managed lifecycle and SDK/CLI calls, ordinary OpenSearch clients, real document/index/bulk operations, bounded queries and aggregations, account/Region/resource isolation, current access checks, local persistence, CloudFormation/CDK deployment, and usable console/query workspaces. Unsupported inputs and features fail explicitly.

The exact supported subset and limits are in the [capabilities](../opensearch-capabilities.json) and [usage guide](../opensearch-console-guide.md). Required scope is defined in the sibling [developer design](../../../stacksim-designs/opensearch-design.md). Completion means these developer workflows work; it does not mean AWS API, console, production-operation or Lucene parity.

## Retained extensions and excluded work

| Historical scope | Current disposition |
|---|---|
| OS-01–OS-04 lifecycle, search, authorization and deployment | Core developer workflows implemented; existing security and storage behavior retained |
| OS-05 monitoring, snapshots, maintenance and insights | Existing subset retained; engine/service-software upgrade orchestration excluded |
| OS-06–OS-07 Serverless | Existing collections, policies, groups and retention retained; no additional topology/tier requirements |
| OS-08–OS-09 ingestion and producers | Existing HTTP/S3/DynamoDB/Serverless/AppSync/Lambda/Logs subsets retained; more plugins require a requested use case |
| OS-10 advanced search | Existing exact vectors, SQL/PPL, pipelines, ISM and packages retained; no native algorithm or plugin parity requirement |
| OS-11A applications and direct queries | Existing IAM workspaces and CloudWatch Logs queries retained; further identity providers, ML and query backends excluded |
| OS-11B network, replication and migration | Completed DIRECT search and metadata comparison retained; VPC, disaster recovery, clones and migrations excluded |
| OS-11C legacy API | Existing facade retained; no additional legacy engine generations or action coverage required |
| OS-12 parity campaign | Closed as out of scope; maintain accurate supported/unsupported documentation instead |

There is no automatic next phase. Further features require a concrete developer workflow and a separate request. The 231 pinned model operations remain a compatibility inventory, not a delivery target. The report records 153 implemented subsets and 78 deliberately unsupported operations, plus eleven supported and two excluded CloudFormation types.

## Code rollback

Removed the unfinished application saved-object migration service, background workers/retries, export/job persistence and atomic-import helpers, three-operation dispatch, migration console controls/history, and its dedicated tests/fixture. StartMigration, GetMigration and ListMigrations now follow the ordinary explicit unsupported-operation path. They are not a pending implementation task.

Ordinary application workspaces still support manual data views and saved searches. Kept the useful fix that lets their saved views reference literal source index names. Completed security, encrypted storage, data formats and other integrations remain intact; no existing developer state was reset or rewritten.

## Console visibility follow-up

Removed the nonfunctional standby-replica selector and unavailable-feature placeholder page. Existing excluded URLs now use page-not-found. Collection ingestion links/routes are limited to eligible NextGen search/vector collections; Classic/time-series collections do not advertise them. Creation methods, collection-group choices and Express-only principal input follow the chosen generation/setup method. Existing resources and working optional features are retained.

Visibility verification passed: 15 affected browser journeys across managed domains, applications, Serverless collection creation and S3 ingestion; the existing Express Create test; TypeScript and browser-module syntax checks. Tests verify excluded routes, missing replica controls, hidden ingestion links on ineligible collections, and working links on eligible collections. No full regression run.

## Verification for this scope revision

Passed on macOS with Node.js 22.13.0:

- Twelve existing focused Node tests: protocol, embedded engine, private workspace, applications and Application CloudFormation. The protocol test also verifies all three excluded migration APIs reject through the official SDK; the application test saves a literal source index name.
- Two existing application browser journeys at 1440 and 390 pixels.
- TypeScript `--noEmit` check.

No full regression run. Existing Linux/Windows workflow execution and native/AWS comparison remain unverified; this revision does not turn them into passing evidence. Portable code remains required. The SQLite runtime requires Node.js 22.13+.

The `os*-acceptance.md` documents and [compatibility manifest](../opensearch-compatibility-manifest.json) preserve historical implementation evidence. Their older statements about unfinished phases, exhaustive fault matrices or AWS reference gates are superseded by this developer scope. Existing regression tests remain useful; no additional broad fault or parity campaign is required.
