# OS-01 and OS-02 embedded implementation evidence

> Scope revision, 2026-11-17: this is a historical implementation/evidence record. The [developer simulator contract](implementation-plan.md) supersedes its earlier full-phase, AWS-parity and exhaustive-fault completion requirements. Existing behavior is retained; unsupported breadth is not a mandatory backlog.

Updated 2026-11-16. Search runs inside StackSim using Node.js SQLite; no Docker,
Java, external OpenSearch, Dashboards or Data Prepper runtime is required.
This record describes the implemented local profile and its executed checks.
It does **not** declare complete AWS parity or completion of all design phases.

## Changes in this implementation pass

- Configuration and diagnostics resolve resources in the authenticated caller's
  account. Identical domain/index names in different accounts and Regions have
  independent storage, permissions and HTTPS endpoints.
- Activation releases its gateway on failure. A previously initialized resource
  with a missing or corrupt database fails visibly instead of becoming an empty
  healthy domain. An occupied endpoint lease never silently changes address.
- Deletion retains its tombstone when the final control-state save fails. API
  callers and the console can retry cleanup; the old port remains retired.
- SQLite failure preserves the original storage error and rolls back document,
  sequence and dynamic mapping changes. Database handles close even when
  initialization or checkpointing fails.
- Scroll pages preserve source filters, selected fields, sort values and the
  initial hit-count policy. Scroll without a new lifetime does not reset expiry.
  PIT/scroll retain principal/resource isolation, quotas, expiry and cleanup.
- Unsupported/malformed query and aggregation members reject, including on
  empty indexes. Source filtering omits unselected empty arrays. Query clauses
  and intermediate aggregation buckets have explicit local work bounds.
- Both the HTTPS gateway and console query API share the 16-request admission
  limit. Gzip expansion is bounded; malformed compression returns 400 and
  oversized expanded bodies return 413 before any document mutation.
- The console adds endpoint copying, deletion retry, failed endpoint messaging,
  and query failure status while retaining drafts and destructive confirmation.

## Executed coverage

| Requirement | Evidence |
|---|---|
| Managed SDK lifecycle, discovery, tags, validation, TLS and stable endpoints | `test/opensearch-service.test.ts`, `test/opensearch-phase01.test.ts` |
| Official AWS CLI create/describe/list/version/tag/remove-tag/delete and rejected invalid name | `test/opensearch-phase01.test.ts`; AWS CLI **2.36.14** |
| Cross-account/Region isolation, least privilege, temporary STS role credentials and immediate revocation | `test/opensearch-phase01.test.ts`, `test/opensearch-service.test.ts` |
| Activation publication failure, retryable deletion commit failure, missing/corrupt database and occupied port recovery | `test/opensearch-phase01.test.ts` |
| Forced process termination after creation intent, before activation publication, after deletion intent and before final cleanup commit | `test/opensearch-durability.test.ts`, `test/fixtures/opensearch-lifecycle-crash.ts` |
| Acknowledged documents, mappings and aliases survive process termination before refresh | `test/opensearch-durability.test.ts`, `test/fixtures/opensearch-crash-writer.ts` |
| Portable real SQLite `SQLITE_FULL`, rollback and subsequent retry | `test/opensearch-phase02.test.ts`; SQLite page-allocation limit on a temporary database |
| Index/mapping/template/alias operations, CRUD/upserts, refresh, optimistic concurrency, ordered partial bulk | `test/opensearch-engine.test.ts` |
| Declared query/analyzer/aggregation corpus, nested correlation, source/fields/highlights, sort and explanation | `test/opensearch-phase02.test.ts`; exact vectors separately in `test/opensearch-vector.test.ts` |
| Scroll projection/snapshot/expiry, PIT quota/deletion and caller/resource isolation | `test/opensearch-phase02.test.ts`, `test/opensearch-engine.test.ts` |
| GET-with-body, HEAD, signed gzip NDJSON, compressed expansion, signature/service/Region denial, repeated/ambiguous paths and shared request admission | `test/opensearch-wire.test.ts` |
| Migration, model routing and unsupported family rejection | `test/opensearch-protocol.test.ts` |
| Adjacent existing domain consumers remain working | `test/opensearch-legacy.test.ts`, `test/opensearch-cloudformation.test.ts` |
| Create/query/edit/tag/delete and real clipboard at three viewports; rejected forms/query/list reads and deletion retry | Five journeys in `test/browser/opensearch-console.spec.ts` |

The focused OpenSearch Node suites contain **30 passing tests**. They run on
macOS with **Node.js 22.13.0**; the five Chrome browser journeys also pass on that
Node version. TypeScript and browser module syntax checks pass. The full project
regression suite was not run.

Run only the affected suites, for example:

```text
node --import tsx --test --test-concurrency=1 test/opensearch-phase01.test.ts test/opensearch-phase02.test.ts test/opensearch-durability.test.ts test/opensearch-wire.test.ts
npx playwright test test/browser/opensearch-console.spec.ts
npx tsc --noEmit
```

The CLI check uses only explicit loopback endpoints and isolated credential/config
files. On a host without `aws`, it reports an explicit skipped acceptance gate;
`STACKSIM_TEST_AWS_CLI` may point to an installed executable. No AWS resource is
created by these tests.

## Remaining acceptance and compatibility limits

Linux and Windows have not been executed. Authenticated AWS console reference
captures and native engine comparison remain unavailable. The local frozen
semantic corpus is executable evidence for the emulator, not a claim that it was
captured from AWS. Additional faults such as sustained host filesystem failure,
interrupted refresh/checkpoint at every instruction, and every lost-response
interleaving remain outside the exercised matrix. Broader input-member and
wire-behavior reference reconciliation remains open.

The supported version is an emulated `OpenSearch_2.19` profile. It retains
simplified analyzers, term-count scoring, exact cardinality and exact vector
search. It has one shard, no replicas, no FGAC or provider-managed encryption,
and no hard filesystem quota. These are documented boundaries, not native
OpenSearch implementation claims. Later phases remain independently unfinished.

Reference semantics used during this pass: OpenSearch 2.19 [scroll](https://docs.opensearch.org/2.19/api-reference/scroll/)
for snapshot/lifetime behavior, and [document retrieval](https://docs.opensearch.org/2.19/api-reference/document-apis/get-documents/)
for real-time/refresh and source-filtering behavior. See the
[capability catalog](../opensearch-capabilities.json),
[compatibility manifest](../opensearch-compatibility-manifest.json) and
[phase coverage](implementation-plan.md) for the full scope.
