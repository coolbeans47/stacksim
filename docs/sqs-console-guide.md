# StackSim SQS console guide

This guide explains every panel in the StackSim SQS console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon SQS behavior.

StackSim models Standard and FIFO queues, message lifecycle, visibility leases, dead-letter routing, queue policies, SSE-SQS descriptors, Lambda event source mappings, and CloudWatch metrics locally. Where local behavior differs from AWS (for example KMS, distributed throughput, or the S3 extended client), those boundaries are called out explicitly.

---

## How to read this guide

Each section follows the same pattern:

1. **What it is** — the console panel and its main fields.
2. **Why use it** — the problem it solves in AWS.
3. **How it works in StackSim** — what is fully simulated versus reference-only.
4. **Common AWS use cases** — typical production scenarios.
5. **Example** — a concrete configuration when one helps.

---

## Console navigation

The SQS service in StackSim has a left navigation bar with:

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Overview** | `#/sqs` | Regional queue summary |
| **Queues** | `#/sqs/queues` | List and create queues |

Opening a queue navigates to `#/sqs/queues/{name}/...` with **Details**, **Send and receive messages**, **Monitoring**, **Dead-letter queue**, **Access policy**, **Encryption**, **Tags**, and **Lambda triggers** tabs.

The console uses the same SQS API as the AWS SDK and CLI (`@aws-sdk/client-sqs`).

---

## Overview

### Regional dashboard

#### What it is

The **Overview** landing page shows:

| Card | Content |
|------|---------|
| **Queues** | Count of Standard and FIFO queues in the current Region |
| **Available messages** | Sum of messages eligible for receive |
| **In flight** | Sum of messages inside their visibility timeout |

**Create queue** opens the creation modal. **View queues** links to the queue list.

The **Development behavior** card explains that messages, delays, visibility leases, receive counts, FIFO deduplication, and redrive state survive simulator restart. Standard delivery remains at least once.

#### Why use it

A quick health check before drilling into individual queues — useful when testing worker scaling, backlog growth, or DLQ routing.

#### How it works in StackSim

Counts aggregate live queue attributes across the account and Region. Fair scheduling is deterministic and bounded locally; it does not reproduce distributed throughput.

#### Common AWS use cases

- Confirm a deployment created expected queues.
- Spot growing backlogs before consumers catch up.
- Verify messages remain after restarting StackSim during local development.

---

## Queues

### Queue catalog

#### What it is

The **Queues** page lists every queue with name, type (Standard or FIFO), messages available, messages in flight, created date, and queue URL. **Create queue** and **Refresh** are in the header. A filter box searches names and URLs.

#### Why use it

Central inventory for decoupled producers and consumers — the starting point for configuration, testing, and troubleshooting.

#### How it works in StackSim

Standard and FIFO lifecycle, queue attributes, tags, delays, retention, visibility leases, long polling, batches, policies, SSE-SQS, dead-letter queues, durable messages, metrics, and supported CloudFormation resources are active locally.

Production distributed throughput and quotas, customer KMS keys, networking and billing behavior, and the S3 extended client are unavailable.

#### Common AWS use cases

- `orders` — Standard queue for order-processing workers.
- `payments.fifo` — FIFO queue when payment events must stay ordered per customer.
- `notifications-dlq` — dead-letter destination for failed notification jobs.

#### Example

Filter for `dlq` to find dead-letter queues referenced by application queues.

---

### Create queue (modal)

#### What it is

The **Create queue** modal collects:

| Field | Purpose |
|-------|---------|
| **Queue type** | Standard or FIFO |
| **Queue name** | 1–80 characters; FIFO names must end with `.fifo` |
| **Visibility timeout** | Seconds a received message stays hidden (0–43200) |
| **Delivery delay** | Seconds before new messages become visible (0–900) |
| **Message retention** | Seconds to retain unprocessed messages (60–1209600) |
| **Maximum message size** | Largest accepted body in bytes (1024–1048576) |
| **Receive wait time** | Default long-poll duration for consumers (0–20) |
| **Enable SQS-managed SSE** | SSE-SQS descriptor for new writes (default on) |
| **Content-based deduplication** | FIFO only — hash body when deduplication ID omitted |
| **Deduplication scope** | FIFO — queue-wide or per message group |
| **FIFO throughput limit** | Per queue or per message group ID |
| **Tags (JSON object)** | Key-value labels at creation |

#### Why use it

Create queues before wiring producers (Lambda, EventBridge, S3 notifications) or consumers (workers, Lambda triggers).

#### How it works in StackSim

Queue type and the `.fifo` suffix are immutable after creation. SSE-SQS is separate from the simulator's always-private local payload store. New queues default to SSE-SQS enabled.

#### Common AWS use cases

- Standard queue with 30-second visibility for image-resize workers.
- FIFO queue with content-based deduplication for strictly ordered tenant events.
- Tagged queues for IAM resource-tag conditions.

#### Example

```text
Type:                FIFO
Name:                tenant-events.fifo
Visibility timeout:  60
Retention:           345600 (4 days)
Content dedup:       Enabled
Deduplication scope: messageGroup
Tags:                {"Application":"billing","Environment":"dev"}
```

---

## Queue detail

Routes: `#/sqs/queues/{name}/details`, `/messages`, `/monitoring`, `/dead-letter`, `/access-policy`, `/encryption`, `/tags`, `/lambda-triggers`.

Header actions on **Details**: **Purge**, **Edit**, **Delete**.

---

### Details tab

#### What it is

Three summary cards:

**Queue details** — type, ARN, URL, created and last updated timestamps.

**Message state** — available, in flight, and delayed counts.

**Configuration** — visibility timeout, delivery delay, receive wait time, retention, maximum message size.

**FIFO configuration** (FIFO queues) — content-based deduplication, deduplication scope, throughput limit. Queue type and `.fifo` suffix are immutable.

**Fair queue behavior** (Standard queues) — explains optional `MessageGroupId` for deterministic bounded-fair local scheduling.

**Tags** preview with link to the Tags tab.

**Edit** opens a modal to update configuration (FIFO fields included when applicable).

#### Why use it

Verify runtime settings and message backlog before changing workers or redrive policies.

#### How it works in StackSim

Validation, updates, delayed availability, retention expiry, per-receive visibility leases, long polling, maximum-size enforcement, persistence, and compatible SDK reads are active. Standard delivery remains at least once.

#### Example

Increase visibility timeout from 30 to 120 seconds when worker processing time grows.

---

### Send and receive messages tab

#### What it is

Warning banner: receiving increments receive count and hides messages for the visibility timeout.

**Send message** modal:

| Field | Purpose |
|-------|---------|
| **Message body** | Required payload (up to queue maximum size) |
| **Message group ID** | Required for FIFO; optional for Standard fair queue |
| **Message deduplication ID** | Required for FIFO unless content-based dedup enabled |
| **Delivery delay** | Standard only — per-message delay |
| **Message attributes** | JSON object of SQS attribute structures |
| **Trace header** | Optional X-Ray trace header |

**Receive messages** form:

| Field | Purpose |
|-------|---------|
| **Maximum messages** | 1–10 per receive call |
| **Wait time** | Long-poll seconds |
| **Visibility timeout** | Override for this receive |
| **Poll attempts** | Repeat bounded receive when empty |

**Poll for messages** / **Stop** controls. Received messages render as cards with metadata, body, attributes, **Change visibility**, and **Delete**.

#### Why use it

Manual testing of producers and consumers without deploying application code — inspect payloads, retry behavior, and receive counts.

#### How it works in StackSim

Single and batch send, receive and delete, delays, long polling, visibility changes, receipt handles, receive counts, message and system attributes, FIFO metadata, MD5s, durable leases, IAM checks, and restart recovery are active. Receiving mutates queue state. Console inspection truncates very large bodies for display only.

#### Common AWS use cases

- Send a test job JSON before starting a Lambda consumer.
- Poll to verify EventBridge or S3 notifications arrived.
- Change visibility to 0 to retry a poison message immediately.
- Delete after confirming successful processing.

#### Example

```json
{"job":"resize-image","bucket":"uploads","key":"photo.jpg"}
```

With `MessageGroupId: tenant-a` on a Standard queue to exercise fair scheduling.

---

### Monitoring tab

#### What it is

Summary cards for available, in flight, and delayed messages. **Queue activity** charts for the last hour (1-minute periods):

- Available, in flight, delayed, oldest message age
- Messages sent, received, deleted, empty receives, average sent size
- FIFO: groups in flight, deduplicated sends
- Standard: noisy groups, quiet-group messages

**Refresh** reloads data. **View all metrics** links to CloudWatch.

Info note: fields retain AWS approximate names for SDK compatibility despite exact local snapshots.

#### Why use it

Observe queue throughput and backlog trends during load tests or worker tuning.

#### How it works in StackSim

CloudWatch `AWS/SQS` metrics for the queue name are measured locally and charted through the shared metrics API.

#### Common AWS use cases

- Confirm consumers keep up (in-flight stable, available near zero).
- Detect poison messages (oldest message age growing).
- Compare sent vs received rates after deploying a new worker.

---

### Dead-letter queue tab

#### What it is

**Redrive policy** — dead-letter queue ARN, maximum receives. **Configure** selects a compatible queue (same Standard/FIFO type) and sets the receive threshold.

**Redrive allow policy** — permission mode (`allowAll`, `denyAll`, `byQueue`) and allowed source queue ARNs. **Configure** opens the editor.

**Source queues** — lists queues that use this queue as their DLQ.

Info note: poll messages on the messages tab to inspect `ApproximateReceiveCount`.

#### Why use it

Isolate messages that fail repeated processing without blocking the main queue — essential for resilient event-driven systems.

#### How it works in StackSim

Redrive policies, receive counting, compatible queue-type validation, durable cross-queue moves, payload and attribute preservation, FIFO group behavior, Lambda failure paths, metrics, source discovery, and restart recovery are active. `StartMessageMoveTask` and related managed message-move operations remain unavailable.

#### Common AWS use cases

- Route failed Lambda invocations after 5 receives to `orders-dlq`.
- Restrict which queues may redrive into a shared DLQ with `byQueue`.
- Inspect DLQ messages manually before reprocessing.

#### Example

```text
Source queue:     orders
DLQ:              orders-dlq
Maximum receives: 5
```

---

### Access policy tab

#### What it is

Success banner: IAM and resource-policy authorization are active for the queue ARN.

**Resource-based queue policy** — JSON document with **Add statement** generator and **Edit JSON**.

**Effective-access diagnostics** — allow/deny counts, same-account vs cross-account vs service publisher guidance, statement table (Sid, Effect, Principal, Actions, Source ARN, Source account).

Warnings for public principals (`Principal: "*"`) and cross-account trust.

**EventBridge target authorization** — template granting `events.amazonaws.com` `sqs:SendMessage` with rule ARN and source account conditions. Link to EventBridge rules.

**S3 notification authorization** — template for `s3.amazonaws.com` with bucket ARN condition; table of buckets whose notification configuration targets this queue.

#### Why use it

Let EventBridge rules, S3 bucket notifications, or cross-account producers send to the queue while keeping explicit deny precedence.

#### How it works in StackSim

IAM and queue-policy composition, same-account and cross-account evaluation, supported principals, actions and conditions, explicit deny, owner-only administration, `AddPermission` and `RemovePermission`, policy validation, and active service-producer checks are modeled.

#### Common AWS use cases

- Allow EventBridge rule `order-events` to enqueue work.
- Allow S3 bucket `uploads` to notify on `ObjectCreated` events.
- Deny all except a specific service principal with conditions.

#### Example EventBridge statement

```json
{
  "Sid": "AllowEventBridgeRule",
  "Effect": "Allow",
  "Principal": { "Service": "events.amazonaws.com" },
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:eu-west-1:000000000000:orders",
  "Condition": {
    "ArnEquals": { "aws:SourceArn": "arn:aws:events:eu-west-1:000000000000:rule/order-events" },
    "StringEquals": { "aws:SourceAccount": "000000000000" }
  }
}
```

---

### Encryption tab

#### What it is

**SQS-managed SSE** — enabled or disabled for new writes. **Edit encryption** toggles the setting.

**Private local payload storage** — always protected; message bodies are authenticated-encrypted on disk independently of SSE-SQS.

Warning: SSE-KMS (`KmsMasterKeyId`) is syntax-validated but fails with `UnsupportedOperation` until a real KMS service exists.

**Queue encryption attributes** — ARN, `SqsManagedSseEnabled`, KMS fields (reference only), local storage protection note.

#### Why use it

Match production encryption posture and understand how StackSim protects data at rest locally.

#### How it works in StackSim

`SqsManagedSseEnabled` creation, updates, per-message mode metadata, durable reads across setting changes, SDK reporting, and installation-local authenticated payload encryption are active. StackSim never claims an AWS KMS key encrypted local data.

#### Common AWS use cases

- Leave SSE-SQS enabled for parity with default AWS queue creation.
- Disable SSE-SQS descriptor to test applications that handle unmarked encryption metadata.

---

### Tags tab

#### What it is

Tag key-value table. **Manage tags** opens a JSON editor to add, replace, or remove tags (all values must be strings).

#### Why use it

Organize queues and participate in IAM resource-tag conditions.

#### How it works in StackSim

Creating, listing, adding, replacing, and removing queue tags, validation, pagination, persistence, IAM tag conditions, and supported CloudFormation behavior are active.

#### Example

```json
{"Environment": "dev", "Team": "platform", "CostCenter": "engineering"}
```

---

### Lambda triggers tab

#### What it is

Info banner explains FIFO group ordering vs Standard at-least-once worker delivery.

**Event source mappings** table: function name, state, batch size and window, maximum concurrency, partial batch failures, last processing result, **Enable**/**Disable**, **Delete**.

**Add trigger** modal:

| Field | Purpose |
|-------|---------|
| **Lambda function** | Function to invoke |
| **Enable trigger** | Start enabled or disabled |
| **Batch size** | 1–10 (FIFO) or 1–10000 (Standard) |
| **Batching window** | Seconds (0 for FIFO; ≥1 when batch > 10 on Standard) |
| **Maximum concurrency** | Optional cap (2–1000) |
| **Report partial batch item failures** | Retry only failed items |
| **Filter pattern** | Optional JSON filter on message body |

Warning lists required execution-role SQS permissions on the queue ARN.

#### Why use it

Connect serverless consumers that poll the queue, process batches, and delete successful messages automatically.

#### How it works in StackSim

Create, list, enable, disable, and delete mappings, execution-role checks, filtering, batching, concurrency, partial failures, visibility-based retry, DLQ interaction, FIFO group ordering, metrics, and restart recovery are active. Delivery remains at least once.

#### Common AWS use cases

- Lambda processes S3 notification messages from an uploads queue.
- FIFO trigger with batch size 1 preserves strict per-group ordering.
- Partial batch failures when some records in a batch fail validation.

#### Example

```text
Function:             order-processor
Batch size:           10
Batching window:      5 seconds
Partial failures:     Enabled
Maximum concurrency:  50
```

---

## Purge and delete

### Purge queue

Available from **Details**. Requires typing the queue name. Warning: purge cooldown prevents immediate repeat purges.

Removes every visible, delayed, and in-flight message — irreversible.

### Delete queue

Available from **Details**. Removes the queue, its messages, and trigger references.

---

## Supported integrations summary

| Producer / consumer | Integration |
|---------------------|-------------|
| **EventBridge rules** | Target type SQS; queue policy for `events.amazonaws.com` |
| **EventBridge Scheduler** | Target type SQS; execution role |
| **S3 notifications** | Queue configuration on bucket; queue policy for `s3.amazonaws.com` |
| **Lambda** | Event source mapping on queue detail tab |
| **IAM applications** | Identity policies plus optional queue policy |
| **CloudWatch** | `AWS/SQS` metrics on Monitoring tab |

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Standard delivery | At least once — consumers must be idempotent |
| FIFO ordering | Strict per message group; `.fifo` suffix required |
| Fair queue (Standard) | Deterministic bounded-fair scheduling with `MessageGroupId` |
| SSE-KMS | Validated; fails with `UnsupportedOperation` |
| S3 extended client | Unavailable |
| StartMessageMoveTask | Unavailable |
| Distributed throughput | Not reproduced |
| Message persistence | Survives simulator restart |
| Purge cooldown | Enforced locally |
| Cross-Region queues | Single Region only |

---

## Related StackSim docs

- [EventBridge console guide](./eventbridge-console-guide.md) — rules and Scheduler targets for SQS
- [S3 console guide](./s3-console-guide.md) — bucket notifications to SQS queues
- [IAM console guide](./iam-console-guide.md) — queue access policies and Lambda execution roles
- [API Gateway console guide](./apigateway-console-guide.md) — HTTP APIs alongside async workers
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — credentials for workers reading from queues
- [Parameter Store console guide](./parameter-store-console-guide.md) — configuration for queue-driven apps
- [Developer guide](./developer-guide.md) — event-driven application patterns
- [Reference](./reference.md) — SQS API summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — SQS CLI examples
- [SES console guide](./ses-console-guide.md) — email is a separate messaging path from SQS
- [SNS console guide](./sns-console-guide.md) — fan-out pub/sub to SQS and Lambda
- [Lambda console guide](./lambda-console-guide.md) — event source mappings and workers
