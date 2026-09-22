# Learning gap 2 — SQS DLQ recovery closeout

Date: 2026-09-22. Scope: the explicitly authorized message-move part of SQS-05, the console recovery loop and Scenario H. **The whole SQS-05 phase is not marked complete.** Historical SQSGAP-14 and the September audit remain unchanged: absence of later-phase APIs was not a defect in SQS-01–04.

## Revalidation and implementation

The working tree already contained learning-gap-1 changes, including IAM provenance in SQS/server policy evaluation. Those changes were retained. Current SQS still registered only 20 actions, stored DLQ transfer timestamps without original-source ARNs, awaited fallible telemetry after enqueue, and had no task console or recovery lesson. The existing Lambda adapter already supplied retries, visibility, partial acknowledgement and execution-role checks; no new poller implementation was needed.

Official API pages and the installed `@aws-sdk/client-sqs@3.1090.0` declarations were checked before protocol implementation. The [inventory and contract](sqs-action-inventory.md) record the exact 23-action surface, fields, modeled errors, states, limits, FIFO transformations, permissions and deliberate local differences.

| Requirement | Implementation | Focused evidence |
| --- | --- | --- |
| Start/List/Cancel over both protocols, explicit registration | `src/sqs.ts` shared `SQS_ACTIONS`, Query `Result` shape and exact field projections; server Query routing | `test/sqs-message-move.test.ts`: installed SDK export inventory, official command responses and raw Query success/error shapes |
| Operation-specific IAM, source/dependent/destination permissions | `src/auth/target.ts`, server redrive authorizer; SourceArn/handle targets, current IAM/resource/tag policy checks, original session fingerprint | `test/sqs-message-move-auth.test.ts`: both target families; each missing permission; cancellation/list denial; identity permission removal and destination resource-policy deny during work; safe identity persistence |
| Source/destination/type/account/Region/dependency validation | Typed SQS move methods, same-type destination checks, unsupported field/KMS/VPC guards | Validation matrix, malformed/unknown handles, foreign scope, non-DLQ sources, default/custom destinations |
| Correct original source, including shared DLQs | `deadLetterSourceArn` stored on DLQ entry and exposed as `DeadLetterQueueSourceArn`; never inferred from current policy membership | Shared-DLQ test removes a current source relationship and still returns its message correctly; legacy/direct-send default fails explicitly |
| Durable async movement, clocks, bounded state/workers/history | Encrypted queue-owned `moveTasks`, 10 retained records, one regional scheduled worker, persisted next-move time and lease, 100 active tasks/account, 36-hour deadline | Custom velocity boundary, empty completion, quota/concurrent admission, cancellation and shutdown tests under TestClock |
| Recover before/after destination acceptance and source checkpoint | Shared queue storage lock and bounded encrypted move intent; destination transfer marker/FIFO ledger followed by source removal/progress; recovery gates further access | Three fault-injected restart boundaries; distinct new IDs; source removal, destination ledger/sequence and count verified; journal compacted |
| Body/user attributes and FIFO/system transformations | Fresh message ID/order/time/retention/receipts; preserved payload/trace/group and DLQ-transformed FIFO dedup ID; new destination sequence | Standard payload/attribute test and FIFO redrive/producer interleaving and in-flight group-head tests; existing FIFO regressions |
| Concurrent send, receive/visibility, expiry, deletion | Eligibility/cancellation recheck under queue lock; live queue descriptor validation; initial count independent of later arrivals | Concurrent producer, visibility release, delayed/expired messages, arrival order, source/destination deletion and storage-failure tests |
| Cancellation preserves completed transfers | RUNNING → CANCELLING → CANCELLED under storage lock; completed moves retained | Partial cancellation tests, real Lambda exercise and browser workflow |
| Telemetry independent of successful queue results (AUD-SQS-01) | SQS metric publication catches subscriber errors with a rolling 32-entry code/time diagnostic; notification follows commit; storage errors still propagate | Faulty subscriber after send, long-poll wakeup, DLQ transfer and redrive; retained count after restart; existing receipt/purge tests |
| Console destination/velocity/progress/cancel/history | `web/services/sqs.js`, `sqs-help.js`; service-backed forms and active refresh, approximate counts, failure and IAM guidance | `test/browser/sqs-console.spec.ts`: start/list/cancel/custom/optimized/invalid velocity on narrow viewport, plus five retained console workflows |
| Failure → diagnosis → fix → recovery → application verification | [SDK Scenario H lab](../examples/sqs-recovery-lab/README.md), scoped worker/operator/API producer roles, Lambda partial responses, durable conditional result ledger | `test/sqs-recovery-lab.test.ts`: deployment, API send, normal/delayed/poison jobs, retry logs/DLQ, UpdateFunctionCode, redrive, new transport identity, stable-key idempotency, partial cancellation, reset and cleanup |
| Truthful claims and repeatability | README support/example tables, reference section, console guide and inventory | All new simulator harnesses use OS temporary directories; dedicated lab launcher never chooses the developer's default state directory |

## Verification executed

On **macOS arm64**, using **Node.js 26.7.0**:

- TypeScript: `npx tsc --noEmit -p tsconfig.json`.
- 49 focused tests passed across `sqs-message-move`, `sqs-message-move-auth`, `sqs-core`, `sqs-fifo`, `sqs-auth`, `sqs-policy`, `sqs-security`, `sqs-lambda-integration` and `sqs-lambda-failure-boundaries`.
- The full public-SDK Scenario H acceptance test passed separately, as did both API Gateway SQS producer tests (53 distinct focused Node tests in total, including the additional FIFO in-flight group-head regression).
- All 6 SQS Playwright console tests passed in Chrome, including the new narrow-screen redrive workflow. Final browser artifacts were directed to an OS temporary directory.

The 16 new redrive/IAM/learning tests also passed on **Node.js 22.23.2**, on the same macOS host, using `npx -y -p node@22 node --import tsx --test test/sqs-message-move.test.ts test/sqs-message-move-auth.test.ts test/sqs-recovery-lab.test.ts`.

At the user's subsequent explicit request, `npm test` ran the full repository suite on the same macOS/Node.js 26.7.0 host:

- Node: **936 passed, 1 skipped, 0 failed** (937 total; 728 seconds). The skipped Amplify bootstrap test is opt-in because it opens an AWS page in the developer's browser.
- Chrome: **157 passed, 2 failed** (159 total; 4.4 minutes). All six SQS console tests passed. The failures were `console-auth.spec.ts:191` (sign-in did not complete before the role-switch assertion) and `s3-console.spec.ts:50` (one version row rendered where two were expected).
- Both failed browser tests passed on an unchanged focused rerun (**2/2**, 3.8 seconds), using a separate OS temporary artifact directory. These results indicate intermittent failures; the original full run still exited with status 1. No implementation or test changes were made to obtain the rerun pass. Original failure artifacts remain in `.stacksim/playwright-results`.

Linux and Windows were **not executed**; implementation and tests use Node filesystem/path/crypto APIs, the shared clock/scheduler, portable SDK calls and temporary-directory helpers. No platform-specific runtime shell commands were added.

## Remaining boundaries

- Provisioned Lambda pollers and the broader mapping-field/production-mode closure of SQS-05 are not included. This is a message-move closeout, not full phase completion.
- KMS, VPC endpoints, cross-account/Region queue moves, Lambda/SNS-only DLQ sources, EventBridge Pipes, production throughput/quota simulation, billing and S3 extended-client payload conventions remain unavailable.
- Pre-feature DLQ messages and direct sends lack trustworthy original-source metadata; use a custom destination. Source eligibility still requires a current SQS DLQ relationship.
- A task can include new arrivals until it observes an empty live queue. Approximate initial count does not increase to match them. Delayed/in-flight messages wait or expire. Default velocity is a bounded local scheduler policy, not AWS performance emulation.
- History retains ten tasks per source. Diagnostics are bounded and payload-free. Ordinary restart is covered; multiple simulator processes sharing a directory and sudden power-loss durability are not claimed.
- Transfer recovery prevents repeating a committed move solely due to an interrupted checkpoint. SQS/Lambda application delivery remains **at least once**. Verify application outcomes and use a stable application key across redrive.

Start the exercise with `npx tsx examples/sqs-recovery-lab/serve.ts`, then follow the guide's environment setup and `lab.ts deploy`, `send`, `logs`, `inspect`, `fix`, `redrive`, `verify`, `reset` and `cleanup` commands.
