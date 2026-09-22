# SQS action inventory and message-move contract

Verified 2026-09-22 against installed `@aws-sdk/client-sqs@3.1090.0` (23 commands), the [AWS action reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_Operations.html), and the [DLQ redrive guide](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html). `SQS_ACTIONS` is the explicit shared routing inventory; the SDK export test rejects drift. Both AWS JSON 1.0 (`AmazonSQS.*`) and Query/XML version `2012-11-05` use the same service operations. `$Command` is the SDK base class, not an action.

| Actions | Implemented inputs and behavior | Boundaries |
| --- | --- | --- |
| CreateQueue, DeleteQueue, GetQueueUrl, ListQueues | QueueName, QueueUrl, owner lookup, prefix, MaxResults/NextToken, create Attributes/tags; lifecycle, immutable type, cooldown | Local account catalog; no remote infrastructure |
| GetQueueAttributes, SetQueueAttributes | AttributeNames/Attributes; delay, visibility, retention, size, receive wait, redrive/allow policies, Policy, FIFO/dedup/throughput attributes, SSE-SQS; derived counts/ARN/timestamps | KmsMasterKeyId and KmsDataKeyReusePeriodSeconds validate but reject unsupported KMS; production FIFO throughput is not simulated |
| TagQueue, UntagQueue, ListQueueTags | QueueUrl, Tags/TagKeys; 50 tags, condition context | No billing behavior |
| SendMessage, SendMessageBatch | Body, DelaySeconds, MessageAttributes, AWSTraceHeader, MessageGroupId, MessageDeduplicationId; MD5s and partial batch results | 1 MiB, ten entries/attributes; list-valued attributes unsupported; FIFO per-message delay rejected |
| ReceiveMessage | QueueUrl, MaxNumberOfMessages, VisibilityTimeout, WaitTimeSeconds, AttributeNames/MessageSystemAttributeNames, MessageAttributeNames, ReceiveRequestAttemptId | Standard at least once; deterministic local fairness; no distributed throughput claims |
| DeleteMessage, DeleteMessageBatch | ReceiptHandle; batch entry Id and handles | Batch IAM uses DeleteMessage |
| ChangeMessageVisibility, ChangeMessageVisibilityBatch | ReceiptHandle, VisibilityTimeout; batch entry Id | Batch IAM uses ChangeMessageVisibility |
| PurgeQueue | QueueUrl; all message states, cooldown | Purge can intentionally remove work while a task is running |
| ListDeadLetterSourceQueues | QueueUrl, MaxResults, NextToken | Current configured relationships; not a substitute for per-message original-source metadata |
| AddPermission, RemovePermission | QueueUrl, Label, AWSAccountIds/Actions | Existing policy quotas and nondelegable actions preserved |
| StartMessageMoveTask | SourceArn required; DestinationArn and MaxNumberOfMessagesPerSecond optional | SQS DLQ sources only; same local account/Region/type |
| ListMessageMoveTasks | SourceArn required; MaxResults optional (default 1, range 1–10) | Ten most recent tasks per source; no pagination token |
| CancelMessageMoveTask | TaskHandle required | Exact retained RUNNING handle only; committed moves remain |

## Frozen message-move wire contract

[Start](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_StartMessageMoveTask.html) returns `TaskHandle`. Omitted/empty DestinationArn means original sources **per message**, including shared DLQs. A custom ARN must identify a different queue of the same type. Explicit velocity is an integer 1–500; omitted velocity uses a backlog-based local ceiling up to 500, with no distributed throughput promise. Empty queues complete asynchronously. No filtering or body transformations are accepted; unknown task inputs fail `UnsupportedOperation`.

[List](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ListMessageMoveTasks.html) returns `Results`; Query/XML uses repeated `Result` elements. Each result contains SourceArn, Status, StartedTimestamp (epoch milliseconds), ApproximateNumberOfMessagesMoved, ApproximateNumberOfMessagesToMove (initial live count). Explicit destination/velocity are returned; omitted optional fields are absent (SDK `undefined`, rather than fabricated values). TaskHandle is returned only while RUNNING. FailureReason appears only for FAILED. Internal leases, identity references and end timestamps are not public fields.

[Cancel](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CancelMessageMoveTask.html) returns ApproximateNumberOfMessagesMoved at cancellation acceptance. The state progresses RUNNING → CANCELLING → CANCELLED. Other terminal states are COMPLETED and FAILED. Starting again creates another task; it does not reopen a cancelled task. One active task per source, 100 per account across local Regions, maximum duration 36 hours; local terminal history retains ten entries without an additional age-based expiry.

## Authorization and modeled errors

All task actions target the source DLQ ARN, including cancellation (decoded routing information plus exact persisted handle validation). Task administration cannot be delegated across accounts. Start and cancel require their task action plus ReceiveMessage, DeleteMessage and GetQueueAttributes on the source; list requires ListMessageMoveTasks and GetQueueAttributes. Start also requires SendMessage on every known destination. The worker rechecks task/source/destination grants, tags, session constraints, boundaries and resource policies before each move. Durable records reference the initiating identity and a one-way session fingerprint, never access keys, secrets or tokens. If its stored IAM session is no longer available, an enforced task fails; cancellation can be performed by another authorized caller.

| Condition | Error or task outcome |
| --- | --- |
| Malformed ARN/handle | InvalidAddress, HTTP 400 |
| Missing queue or retained handle | ResourceNotFoundException, HTTP 400 |
| Invalid numeric field | InvalidParameterValue, HTTP 400; missing required numeric value is MissingParameter |
| Non-DLQ source, different type, same queue, foreign account/Region, already active task, non-running cancellation, unimplemented fields | UnsupportedOperation, HTTP 400 |
| Account task limit | RequestThrottled, HTTP 400 |
| IAM denial | AccessDeniedException, HTTP 403; revocation during a task produces FAILED |
| Direct sends/legacy DLQ messages lacking origin, with no custom destination | FAILED / CouldNotDetermineMessageSource; nothing guessed from current policy relationships |
| KMS attributes or VPC endpoint dependent queue policies | UnsupportedOperation; no success stub or network emulation |
| Storage failure | Actual API storage errors propagate; worker records FAILED when it can checkpoint, otherwise retries reconciliation with a bounded diagnostic |
| Deletion, destination size mismatch, time limit | FAILED with a bounded reason; remaining source messages are not acknowledged |

SigV4 validation follows StackSim's existing auth mode and modeled signing errors. Local HTTP is intentional; this does not reproduce AWS's HTTPS-only transport or production request throttling. Missing provenance is an explicit upgrade boundary for pre-feature messages: select a custom destination. Lambda/SNS-only dead-letter queues are not accepted as sources.

## Movement, concurrency and recovery

Tasks, timestamps, progress, lease and identity references live in encrypted queue-owned journals outside control JSON. A single scheduler worker per Region processes bounded tasks and stops cleanly. Each iteration handles at most one message per active source (100 account-wide maximum), yielding between ticks; custom rates are ceilings, and unused capacity does not accumulate into catch-up bursts. A running task can include new DLQ arrivals until its first empty live snapshot; its moved count can therefore exceed its initial estimate. Delayed/in-flight messages wait for eligibility; expired messages do not move. Purge/consumer deletion can reduce the remaining work. A queue deletion prevents subsequent acceptance into that descriptor; an already committed destination message follows normal destination deletion semantics.

Selection uses oldest eligible DLQ arrival first, with a durable queue arrival counter for ties. FIFO in-flight group heads block followers while independent groups may progress. Source availability and task cancellation are checked again under the storage lock. FIFO group IDs and the deduplication ID transformed on DLQ entry are preserved; destination sequence, transport ID, enqueue time and retention are new. Receive count/receipt/first-receive metadata reset. AWSTraceHeader, bodies and user attributes survive; the DLQ source marker clears at the destination. SSE-SQS metadata follows the destination configuration.

A bounded encrypted cross-queue intent records the new identity, destination FIFO ledger delta, original source identity and task checkpoint. Queue reads/mutations reconcile an incomplete intent before proceeding. Destination acceptance precedes source removal; progress commits with removal. Restart does not resend an already committed move merely because publication of its checkpoint was interrupted. This is internal transfer recovery, **not exactly-once application processing**. No multi-process shared-data-directory or sudden power-loss durability claim is made.

Telemetry subscriber failures are caught at the SQS publication boundary. Consumers are notified after durable send acceptance; failures retain only a rolling 32-entry diagnostic of code/time. Queue storage failures are not swallowed, and failed metrics are not replayed as queue writes.

## Remaining SQS-05 scope

This closes the authorized message-move slice and inventories the 23 installed SQS commands. It does **not** declare the whole SQS-05 phase complete. Provisioned Lambda pollers, further mapping-field closure, production fleets/quotas, KMS, VPC endpoints, billing, S3 extended-client payload conventions and EventBridge Pipes remain outside this work. See the [closeout](gap-2-sqs-redrive-closeout.md) and [repeatable learning exercise](../examples/sqs-recovery-lab/README.md).
