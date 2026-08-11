# Implemented phases

Completion records for StackSim design phases. This file tracks closed rows and the evidence that satisfies their acceptance criteria.

## DUG-12 — Integrate DynamoDB import/export with real local S3

**Status:** completed

**Inherited rules applied:** failing weakness reproduction first; S3-owned transfer port (no DynamoDB direct state-file I/O); schema migration + resume; official DynamoDB/S3 SDK clients; docs/inventory/console/reference updates; focused plus cross-service regressions.

**Closed integration rows:** DDB-INT-001 (export to local S3), DDB-INT-002 (import from local S3), DDB-INT-003 (service-principal authorization + ownership/region/lineage), DDB-INT-004 (checkpointed resume; never blind COMPLETED).

**Not in scope (explicitly deferred):** Ion, CSV, ZSTD, incremental export, KMS export encryption.

**Evidence:**

- `src/s3/transfer-port.ts` and `S3Service.createTransferPort()` — generation/version-pinned streaming reads/writes under `dynamodb.amazonaws.com`
- `src/dynamodb/import-export.ts` + `DynamoDbService` admission-before-side-effect stages
- Schema migration `v85-to-v86` fails legacy unfinished jobs safely; active jobs resume from checkpoints
- Tests: `test/dynamodb-dug12.test.ts`, `test/dynamodb-import-export.test.ts`
- Docs: README, `docs/reference.md`, `docs/dynamodb-console-guide.md`, action inventory

**Preserved extension:** `file://` remains behind `STACKSIM_ALLOW_LOCAL_FILES` and is never used internally to bypass S3 behavior.
