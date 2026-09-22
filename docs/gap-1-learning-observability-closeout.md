# Learning gap 1: measurements and IAM explanations

Implemented 2026-09-22. This closeout covers AUD-LAM-03, AUD-XRY-01, AUD-DDB-02 and AUD-IAM-03 only. The original reports and reproduction script in `stacksim-designs/audit-2026-09-22` remain historical evidence; that script asserts the old defects and was not used as a passing post-fix test.

## Findings and observable results

| Finding | Revalidated defect | Implementation | Observable result and regression evidence |
| --- | --- | --- | --- |
| AUD-LAM-03 | REPORT copied configured memory into measured usage in text and JSON. | `src/lambda-memory.ts`, the Node worker/runner result, and `src/lambda.ts` distinguish configuration, measurement and requested limits. The Lambda configuration console explains that distinction. | A function configured for 10,240 MB reports the worker's measured peak, not 10,240. Warm calls reuse the process and its lifetime high-water mark. Abrupt exits and image execution report unavailable. `test/lambda-memory-reporting.test.ts`, `test/lambda-images.test.ts`, `test/lambda-warm-reuse.test.ts`. |
| AUD-XRY-01 | Graph response time was the elapsed observation window; edges reused unrelated parent totals. | `graphForTraces` in `src/xray.ts` accumulates unique completed segment durations, independent observation bounds and child-specific edge statistics. The console uses the same completed count for averages. | Two one-second requests an hour apart produce `TotalResponseTime: 2`, `TotalCount: 2`, and a 3,601-second observation window. Overlap, duplicate updates, partial completion, embedded/independent children and nested edges are covered by `test/xray-duration-aggregation.test.ts`; existing core/protocol tests also pass. |
| AUD-DDB-02 | HTTP telemetry emitted a fixed consumed-capacity value per request. | `src/dynamodb.ts` captures successful canonical capacity charges in an async request scope. Native and PartiQL wrappers merge nested charges and publish only at the outer request. Table/LSI and GSI dimensions follow the existing charging model. | Large eventual and strong reads consume 1.5 and 3 modeled units in the SDK regression. Filtering can return no items while still charging evaluated work. Returned capacity, execution charges and CloudWatch sums agree across indexes, multiple tables, batches and transactions. Omitted/`NONE` reporting still emits metrics; rejected admission emits no consumed units; telemetry failure leaves committed operations successful. `test/dynamodb-capacity-telemetry.test.ts` and the focused existing capacity/read/index/transaction/PartiQL tests. |
| AUD-IAM-03 / DUG-24 | Evaluators retained bare SIDs and history retained only a generic reason, losing contributing policy identity. | `src/iam/provenance.ts`, collection/evaluation/combination, resource/trust adapters, STS session origins, durable decision creation and the existing IAM console retain bounded source metadata. API Gateway and STS enrich their existing request records with resource/trust outcomes. | Duplicate SIDs remain distinguishable by policy/entity/version/revision and statement index. Identity, resource, boundary, session and trust layers survive applicable combinations and restart. AppSync API/type/field decisions use the same metadata. `test/iam-provenance.test.ts`, updated AppSync/STS tests, and `test/browser/iam-provenance.spec.ts` verify SDK/private-route/history and visible allow/deny explanations. |

## Measurement and provenance contracts

**Lambda.** Node ZIP measurement is `process.resourceUsage().maxRSS`, converted from KiB to MiB, retaining the AWS-shaped `MB` field spelling. It is the worker process's lifetime peak resident memory, including initialization and previous warm invocations, excluding child processes. Text identifies that scope; JSON includes `memoryUsage` and `resourceLimits`. A missing, nonpositive or failing measurement is unavailable. A timeout or abrupt exit without a worker result also has no final measurement. JSON omits the numeric usage field when unavailable; text prints `unavailable` with a reason. Image execution currently has no reliable container peak measurement, even though the Docker backend requests actual memory and `/tmp` limits. ZIP memory and scratch configuration remains descriptor-only. **Only the reporting portion of DUG-20 is delivered; full cross-platform memory/scratch enforcement remains open.**

**X-Ray.** Durations are summed per unique trace/segment identity, including overlapping completed requests. Embedded and independently submitted representations are deduplicated, preferring completed data and then the independent document. Children contribute to their own service and parent-to-child edge; a parent's inclusive duration is not reused as an edge's duration. Partial segments establish observation bounds but contribute neither completed count nor invented duration. Faults take precedence over errors, with throttles a subset of errors. The console shows unavailable averages when no completed requests exist. Graph results still describe the selected trace page under the admitted local model, not a global AWS service-map/performance model.

**DynamoDB.** Telemetry reuses the existing model's serialized AttributeValue JSON sizes, consistency and transaction multipliers, evaluated items before filtering, and index charges. Accepted charges remain observable if a later step fails; rejected charge admission is rolled back and contributes no consumed units. Successful-request latency and its sample count remain distinct from capacity. Idempotent cached responses execute no new charge and emit no new consumed capacity, even if the existing response cache returns the original capacity. Publication is best effort, not a durable metrics outbox. This correction does not redesign AWS item-byte billing, transaction admission or capacity enforcement.

**IAM.** Source entries identify managed-policy ARN/version, inline entity ARN/type/policy name and content revision, resource service/attachment ARN/revision, session source, or trust role ARN/revision. Each includes the evaluation layer, zero-based statement index, optional SID, effect and match status. Revisions use native IDs where available or stable SHA-256 document hashes preserving statement order. Selector summaries identify `Action`/`NotAction` and `Resource`/`NotResource`/implicit scope; the decision identifies the evaluated action and resource. No policy bodies, evaluated condition values, credentials, payloads or secret context are added to diagnostic provenance.

Ordering is deterministic. At most 32 entries and 16 KiB per serialized durable decision are retained, including total/matched counts and `provenanceTruncated`. Extremely large diagnostic target fields retain a prefix and identify the affected fields in `diagnosticFieldsTruncated`; the console displays that notice. The existing 1,000-record retention remains. Historical records without sources are marked `provenanceUnavailable`, never reconstructed from generic reasons. Existing internal trust checks return provenance without a new requirement to write durable records. The private signed diagnostics route remains unchanged. Enforce remains the default; authorization decisions and the existing session-policy union/intersection rules are preserved. Organizations/SCP evaluation remains unsupported.

## Focused verification

All tests used fresh temporary simulator directories and removed them after execution. No developer simulator data was used. The historical defect reproduction script was not run. At the user's later request, the full regression suite covered both learning gaps: 936 Node tests passed with one intentional skip; 157 browser tests passed and two failed, then both failures passed on an unchanged focused rerun. The original full run exited with status 1. See the [gap 2 verification record](gap-2-sqs-redrive-closeout.md#verification-executed) for details.

- `npm run build` and the final `npx tsc -p tsconfig.json` completed successfully.
- The following focused Node run passed **60/60 tests** on **Node.js 22.23.2, macOS arm64**. Earlier focused runs also passed on the host Node.js 26.7.0.
- The focused S3 authorization regression also passed **1/1** after final review confirmed that retaining provenance does not carry a resource-policy grant basis into an ACL decision.
- The IAM browser workflow passed **1/1** using Playwright with Chrome on macOS with Node.js 26.7.0. It creates a real signed allow/deny history under default enforce mode, expands the exact source/statement explanations, checks secret exclusion and page errors, and checks visibility at a 390-pixel viewport. The captured expanded explanation was visually inspected.
- `git diff --check` passed.

Main Node selection (the npm-cache Node 22 runtime did not change project dependencies):

```text
npx --yes --package=node@22 node --test --test-reporter=spec --test-concurrency=2 dist/test/lambda-memory-reporting.test.js dist/test/lambda-images.test.js dist/test/lambda-warm-reuse.test.js dist/test/xray-duration-aggregation.test.js dist/test/xray-core.test.js dist/test/xray-protocol.test.js dist/test/dynamodb-capacity-telemetry.test.js dist/test/dynamodb-read-correctness.test.js dist/test/dynamodb-transactions.test.js dist/test/dynamodb-indexes.test.js dist/test/dynamodb-partiql.test.js dist/test/dynamodb-capacity-settings.test.js dist/test/dynamodb-resource-policies.test.js dist/test/iam-provenance.test.js dist/test/iam-condition-evaluator.test.js dist/test/iam-resource-policy-matrix.test.js dist/test/iam-resource-policy-service-adoption.test.js dist/test/iam-authorization-targets.test.js dist/test/iam-default-admin.test.js dist/test/iam-policy-validation-gaps.test.js dist/test/iam-policy-storage.test.js dist/test/auth-sts.test.js dist/test/auth-sts-chaining.test.js dist/test/auth-sts-session-tags.test.js dist/test/appsync-graphql-iam.test.js dist/test/lambda-function-urls.test.js
```

Additional S3 authorization selection:

```text
npx --yes --package=node@22 node --test --test-reporter=spec --test-name-pattern="S3-05 enforces anonymous" dist/test/s3-security.test.js
```

Browser selection:

```text
npx playwright test test/browser/iam-provenance.spec.ts
```

Linux and Windows were not executed in this environment. The changes use portable Node APIs and temporary-path helpers; unsupported runtime memory readings have an explicit unavailable path. Image tests use the existing fake Docker backend, including verification of requested limits and both report formats; real Docker container measurements or OS resource-limit enforcement were not validated. These results establish the local learning contracts above, not complete AWS performance fidelity.

See the [reference](reference.md#learning-measurements-and-permission-explanations), [developer exercises](developer-guide.md), and the [Lambda](lambda-console-guide.md), [X-Ray](xray-console-guide.md), [DynamoDB](dynamodb-console-guide.md) and [IAM](iam-console-guide.md) console guides for the user-facing definitions.
