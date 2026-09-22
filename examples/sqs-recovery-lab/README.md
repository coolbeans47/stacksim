# Scenario H — break, inspect, fix and redrive a queue worker

This lab deploys a Standard queue, a DLQ, a Lambda consumer with partial batch responses, three scoped IAM roles, an API Gateway producer and a DynamoDB result ledger. It uses ordinary AWS SDK commands. No simulator state edits or private queue shortcuts are needed.

Run from the StackSim repository with Node.js 22.13 or later and dependencies installed. Start a **separate** simulator using a new data directory to keep your normal playground untouched:

```text
npx tsx examples/sqs-recovery-lab/serve.ts
```

The launcher uses `./sqs-recovery-state` (override with `LAB_STATE_DIR`), SDK port 4570 and invoke port 4571. Restart it with the same command.

In another terminal set `AWS_ENDPOINT_URL=http://127.0.0.1:4570`, `AWS_REGION=eu-west-1`, and the simulator's credentials. Shell examples:

```sh
export AWS_ENDPOINT_URL=http://127.0.0.1:4570
export AWS_REGION=eu-west-1
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
```

```powershell
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4570"
$env:AWS_REGION = "eu-west-1"
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
```

The default prefix is `sqs-recovery`. Set `LAB_PREFIX` to use a separate set of lab resources. Keep IAM in its default `enforce` mode. The script deliberately accepts only a loopback endpoint. The provisioning identity needs permission to create the lab resources and pass/assume the scoped roles; default local recovery credentials provide that access.

## 1. Deploy and break

```text
npx tsx examples/sqs-recovery-lab/lab.ts deploy
npx tsx examples/sqs-recovery-lab/lab.ts send
npx tsx examples/sqs-recovery-lab/lab.ts send-api
npx tsx examples/sqs-recovery-lab/lab.ts status
npx tsx examples/sqs-recovery-lab/lab.ts logs
```

`send` publishes `normal-1`, a two-second delayed `delayed-1`, and deliberately failing `poison-1`. `send-api` calls API Gateway's public test-invoke API, which maps a JSON job into SQS `SendMessage` under the producer role. Its response includes the gateway execution trace.

The source visibility timeout is six seconds and its maximum receive count is two. The Lambda returns `batchItemFailures`, so successes are acknowledged while the poison item retries. Run `status` and `logs` again after roughly 15 seconds: expect a DLQ count of one, successful normal jobs and two `RETRY` log entries for `poison-1`. Local counts and times are observations, not AWS throughput predictions.

```text
npx tsx examples/sqs-recovery-lab/lab.ts verify normal-1
npx tsx examples/sqs-recovery-lab/lab.ts verify delayed-1
npx tsx examples/sqs-recovery-lab/lab.ts verify api-1
npx tsx examples/sqs-recovery-lab/lab.ts inspect
```

Inspection uses `ReceiveMessage` with zero visibility: it changes the receive count, keeps the message, and exposes `DeadLetterQueueSourceArn`. The body is valid; the logs explain that consumer v1 rejects its job kind. `verify poison-1` should fail at this checkpoint. The CLI intentionally prints message bodies for this inspection; task history and worker diagnostics contain no bodies or credentials.

## 2. Repair and recover

```text
npx tsx examples/sqs-recovery-lab/lab.ts fix
npx tsx examples/sqs-recovery-lab/lab.ts redrive 1
npx tsx examples/sqs-recovery-lab/lab.ts status
npx tsx examples/sqs-recovery-lab/lab.ts verify poison-1
npx tsx examples/sqs-recovery-lab/lab.ts logs
```

`fix` uploads consumer v2 through `UpdateFunctionCode`. `redrive` assumes the scoped operator role and starts a move task to each message's original source. Repeat status/verify until the task is `COMPLETED` and `poison-1` has a `PROCESSED` ledger entry. A completed move only confirms destination acceptance; the ledger and Lambda log confirm application processing.

The output of `deploy` links to **SQS → the DLQ → Dead-letter queue**. You can perform the same redrive with **Start DLQ redrive**, **Original source queue(s)** and velocity `1`. The console automatically refreshes active tasks, shows approximate progress and lets you cancel. A custom destination must have the same queue type and the caller must have `sqs:SendMessage` there; the lab operator is intentionally scoped to its source queue only.

## 3. Observe cancellation and restart

```text
npx tsx examples/sqs-recovery-lab/lab.ts break
npx tsx examples/sqs-recovery-lab/lab.ts bulk
npx tsx examples/sqs-recovery-lab/lab.ts status
```

`bulk` sends 30 poison jobs. Wait until status reports 30 available DLQ messages, then:

```text
npx tsx examples/sqs-recovery-lab/lab.ts fix
npx tsx examples/sqs-recovery-lab/lab.ts redrive 1
npx tsx examples/sqs-recovery-lab/lab.ts status
npx tsx examples/sqs-recovery-lab/lab.ts cancel
npx tsx examples/sqs-recovery-lab/lab.ts status
```

Expect `CANCELLING`, then `CANCELLED`. Already moved messages stay at the destination and can be processed. Start another redrive to drain the remainder. Alternatively stop the simulator partway through the slow move, restart it with the **same data directory and ports**, and run status again. The durable task resumes with its committed count. Do not run two simulators against the same data directory.

```text
npx tsx examples/sqs-recovery-lab/lab.ts redrive 1
npx tsx examples/sqs-recovery-lab/lab.ts verify bulk-29
```

Repeat `verify` after draining. To observe an ordinary receive lease across restart: run `pause`, `send`, then `lease`. The last command receives without acknowledgement. Restart the simulator, run `status` before expiry if practical, and `resume`; the message becomes eligible again after its six-second visibility deadline. Console inspection and the SDK's `ChangeMessageVisibility` can shorten or extend a lease.

## Delivery guarantees and idempotency

SQS delivery and Lambda processing remain at least once. Redrive assigns a fresh transport message ID and enqueue time; transport IDs are unsuitable as business deduplication keys across redrive. Each job carries a stable `jobId`. The example's conditional DynamoDB write (`attribute_not_exists(jobId)`) models one durable application effect. Sending the sample jobs again after repair produces `ALREADY_PROCESSED` logs and leaves the ledger entry unchanged. Real applications with external side effects need a suitable transaction/idempotency design; this ledger is not a claim of exactly-once application execution.

FIFO redrive is supported by the service tests: entry into a FIFO DLQ replaces the send deduplication ID with the original message ID; redrive retains that transformed ID and group, with a new destination sequence and message ID. New producer messages may interleave with redriven messages. This beginner lab uses Standard queues.

## Reset and cleanup

```text
npx tsx examples/sqs-recovery-lab/lab.ts reset
```

Reset pauses the mapping, requests cancellation of running redrive, purges both queues, clears the application ledger, reinstalls the broken consumer and resumes polling. Wait for active invocations and cancellation to settle before resetting; repeat `status` first if work is still running. SQS permits a purge only once per 60 seconds. Task history and logs are retained for comparison; new task results are shown first. Run `send` to repeat the lesson.

```text
npx tsx examples/sqs-recovery-lab/lab.ts cleanup
```

Cleanup deletes the mapping, function, queues, table, roles, logs and API owned by the selected prefix. After queue deletion, wait 60 seconds before redeploying the same names, or choose a new prefix. Stop the dedicated simulator before deleting its dedicated directory.

The repeatable acceptance test is `npx tsx --test test/sqs-recovery-lab.test.ts`. It uses temporary state, IAM enforcement and an injected scheduler clock.
