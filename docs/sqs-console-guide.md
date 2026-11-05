# StackSim SQS console guide

This guide explains every page of the StackSim SQS console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon SQS behavior.

The console follows the Amazon SQS console: the same pages, sections, labels, tabs and dialogs, so what you learn here carries over. StackSim adds a few panels that AWS does not have (diagnostics, policy helpers, a regional overview); they are called out as local additions.

StackSim models Standard and FIFO queues, message lifecycle, visibility leases, dead-letter routing and redrive, queue policies, SSE-SQS descriptors, SNS subscriptions, Lambda event source mappings, and CloudWatch metrics locally. Where local behavior differs from AWS (for example KMS, EventBridge Pipes, distributed throughput, or the S3 extended client), those boundaries are called out explicitly.

---

## How to read this guide

Each section follows the same pattern:

1. **What it is** — the console page or panel and its main fields.
2. **Why use it** — the problem it solves in AWS.
3. **How it works in StackSim** — what is fully simulated versus reference-only.
4. **Common AWS use cases** — typical production scenarios.
5. **Example** — a concrete configuration when one helps.

---

## Console navigation

The SQS service in StackSim has a left navigation bar with:

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Overview** | `#/sqs` | Regional queue summary (local addition) |
| **Queues** | `#/sqs/queues` | List, create and act on queues |

**Create queue** opens `#/sqs/queues/create`. Opening a queue navigates to `#/sqs/queues/{name}/...` with these tabs:

| Tab | Route suffix | Notes |
|-----|--------------|-------|
| **Details** | `/details` | Local addition as a tab; AWS shows the Details panel above the tabs |
| **Send and receive messages** | `/messages` | Local addition as a tab; also reachable from the header button, as in AWS |
| **SNS subscriptions** | `/sns-subscriptions` | |
| **Lambda triggers** | `/lambda-triggers` | |
| **EventBridge Pipes** | `/eventbridge-pipes` | Present but unavailable: StackSim does not emulate Pipes |
| **Dead-letter queue** | `/dead-letter` | |
| **Monitoring** | `/monitoring` | |
| **Tagging** | `/tagging` (`/tags` still works) | |
| **Queue policies** | `/queue-policies` (`/access-policy` still works) | Access policy and Redrive allow policy |
| **Encryption** | `/encryption` | |
| **Dead-letter queue redrive tasks** | `/redrive-tasks` | |

`#/sqs/queues/{name}/edit` opens the edit page.

Every queue tab except Send and receive messages shares one header: the queue name and ARN with **Edit**, **Delete**, **Purge**, **Send and receive messages** and **Start DLQ redrive**. **Start DLQ redrive** is enabled only on a queue that another queue uses as its dead-letter queue.

Durations are shown in words everywhere (`30 Seconds`, `4 Days`, `1 Minute 30 Seconds`) and sizes in KiB (`1024 KiB`), with the exact number of seconds or bytes beside them.

The console uses the same SQS API as the AWS SDK and CLI (`@aws-sdk/client-sqs`).

---

## Overview

### Regional dashboard

#### What it is

The **Overview** landing page (a local addition) shows:

| Card | Content |
|------|---------|
| **Queues** | Count of Standard and FIFO queues in the current Region |
| **Available messages** | Sum of messages eligible for receive |
| **In flight** | Sum of messages inside their visibility timeout |

**Create queue** opens the create page. **View queues** links to the queue list.

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

### Queue list

#### What it is

The **Queues** page lists every queue with these columns: **Name**, **Type**, **Created**, **Messages available**, **Messages in flight**, **Encryption**, **Content-based deduplication**, and the queue URL (a local addition). A search box filters by name and URL.

Select a queue with its radio button to use the toolbar:

| Control | Action |
|---------|--------|
| **Edit** | Opens the edit page |
| **Delete** | Opens the **Delete queue** dialog |
| **Send and receive messages** | Opens the Send and receive messages page |
| **Actions → Send and receive messages** | Same page |
| **Actions → Purge** | Opens the **Purge queue** dialog |
| **Actions → Subscribe to Amazon SNS topic** | Opens the subscribe dialog |
| **Actions → Configure Lambda function trigger** | Opens the trigger dialog |
| **Actions → Start DLQ redrive** | Enabled when the selected queue is a dead-letter queue |
| **Create queue** | Opens the create page |

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

Search for `dlq` to find dead-letter queues referenced by application queues.

---

### Create queue

#### What it is

A full page with the sections of the AWS console, in the same order. Every setting except the name has a default.

**Details**

| Field | Purpose |
|-------|---------|
| **Type** | **Standard** or **FIFO**. The type cannot be changed after the queue is created |
| **Name** | Up to 80 characters: letters, digits, hyphens and underscores. A FIFO name must end with `.fifo` |

**Configuration**

| Field | Range | Default |
|-------|-------|---------|
| **Visibility timeout** | 0 seconds to 12 hours, entered as a value and a unit | 30 Seconds |
| **Message retention period** | 1 minute to 14 days | 4 Days |
| **Delivery delay** | 0 seconds to 15 minutes | 0 Seconds |
| **Maximum message size** | 1 KiB to 1024 KiB | 1024 KiB |
| **Receive message wait time** | 0 to 20 seconds; 0 is short polling | 0 Seconds |
| **Content-based deduplication** | FIFO only | Off |
| **Enable high throughput FIFO** | FIFO only; sets the two fields below | Off |
| **Deduplication scope** | FIFO only: Queue or Message group | Queue |
| **FIFO throughput limit** | FIFO only: Per queue or Per message group ID | Per queue |

**Access policy** — choose a method:

- **Basic**: **Define who can send messages to the queue** and **Define who can receive messages from the queue**, each **Only the queue owner** or **Only the specified AWS accounts, IAM users and roles**. The resulting policy is shown in a read-only JSON panel.
- **Advanced**: edit the JSON policy directly. Leave it empty to create the queue without a policy.

The default is the owner-only policy: one statement, `__owner_statement`, that allows the queue's own account every SQS action.

**Redrive allow policy** (optional) — **Disabled** or **Enabled**, then **Allow all**, **By queue** (up to 10 source queue ARNs) or **Deny all**.

**Encryption** — **Server-side encryption** Disabled or Enabled (default). The key type is **Amazon SQS key (SSE-SQS)**. **AWS Key Management Service key (SSE-KMS)** is shown disabled because StackSim does not emulate KMS.

**Dead-letter queue** (optional) — **Disabled** or **Enabled**. Under **Dead-letter queue settings**, **Choose queue** takes the ARN of an existing queue of the same type and **Maximum receives** takes 1 to 1000 (default 10).

**Tags** (optional) — **Key** and **Value** rows with **Add new tag** and **Remove**. **Edit as JSON** (a local addition) shows the same tags as a JSON object.

**Create queue** creates the queue and opens its Details tab. **Cancel** returns to the list.

#### Why use it

Create queues before wiring producers (Lambda, EventBridge, S3 notifications, SNS topics) or consumers (workers, Lambda triggers).

#### How it works in StackSim

The page sends one `CreateQueue` call with the attributes, policy, redrive policy, redrive allow policy and tags you chose. Queue type and the `.fifo` suffix are immutable after creation. SSE-SQS is separate from the simulator's always-private local payload store.

#### Common AWS use cases

- Standard queue with a 30-second visibility timeout for image-resize workers.
- FIFO queue with content-based deduplication for strictly ordered tenant events.
- A work queue created together with its dead-letter queue and a maximum of 5 receives.

#### Example

```text
Type:                       FIFO
Name:                       tenant-events.fifo
Visibility timeout:         1 Minutes
Message retention period:   4 Days
Content-based deduplication: On
Enable high throughput FIFO: On
Dead-letter queue:          Enabled, tenant-events-dlq.fifo, Maximum receives 5
Tags:                       Application = billing, Environment = dev
```

---

### Edit queue

**Edit** (from the list toolbar or the queue header) opens the same page filled with the queue's current settings. The type and name are shown but cannot be changed. **Save** sends only the settings you changed and returns to the Details tab.

A queue that has no access policy opens with the Advanced method and an empty editor; leaving it empty keeps the queue without a policy.

---

## Queue pages

### Details tab

#### What it is

**Details** — Name, Type, ARN, Encryption, URL and Dead-letter queue. **More** expands the remaining values: created and last updated times, maximum message size, message retention period, default visibility timeout, delivery delay, receive message wait time, the three message counts, content-based deduplication and the redrive allow policy.

Local additions on this tab:

- **Message state** — available, in flight, and delayed counts.
- **Configuration** — the five configuration values in words.
- **FIFO configuration** (FIFO queues) — content-based deduplication, high throughput FIFO, deduplication scope, FIFO throughput limit.
- **Fair queue behavior** (Standard queues) — explains optional `MessageGroupId` for deterministic bounded-fair local scheduling.
- **Tags** preview with a link to the Tagging tab.

#### Why use it

Verify runtime settings and message backlog before changing workers or redrive policies.

#### How it works in StackSim

Validation, updates, delayed availability, retention expiry, per-receive visibility leases, long polling, maximum-size enforcement, persistence, and compatible SDK reads are active. Standard delivery remains at least once.

#### Example

Increase the visibility timeout from 30 Seconds to 2 Minutes on the edit page when worker processing time grows.

---

### Send and receive messages

#### What it is

One page with three panels.

**Send message**

| Field | Purpose |
|-------|---------|
| **Message body** | Required payload (up to the queue's maximum message size) |
| **Message group ID** | Required for FIFO. Optional on a Standard queue, where it enables fair-queue scheduling |
| **Message deduplication ID** | FIFO only; optional when the queue uses content-based deduplication |
| **Delivery delay** | Standard only; a value and a unit, starting at the queue's delivery delay |
| **Message attributes** | Rows of name, type (**String**, **Number**, **Binary**), optional custom type and value; **Add new attribute** and **Remove** |
| **Additional local settings** | Message attributes as raw JSON in the `SendMessage` shape, and an X-Ray trace header |

**Send message** sends the message and shows a confirmation with **View details**, which opens **Message details** (message ID, MD5 of the body, MD5 of the attributes, sequence number). **Clear content** empties the form.

**Receive messages**

The panel shows **Messages available**, **Polling duration**, **Maximum message count** and **Polling progress**. **Poll for messages** receives until the polling duration ends or the maximum message count is listed; **Stop polling** cancels it. **Edit poll settings** changes:

| Setting | Purpose |
|---------|---------|
| **Polling duration** | Seconds the console keeps polling (default 30) |
| **Maximum message count** | Polling stops when this many messages are listed (default 10) |
| **Wait time (seconds)** | Local addition: long-poll duration of each `ReceiveMessage` call |
| **Visibility timeout (seconds)** | Local addition: leave blank for the console default, or enter how long received messages stay hidden |
| **Poll attempts** | Local addition: maximum number of `ReceiveMessage` calls in one poll |

**Messages**

A table of the received messages: **ID**, **Sent**, **Size** and **Receive count**. Choose an ID (or select one message and **View details**) to open the message dialog:

- **Body** — the message body.
- **Attributes** — the message attributes as a table and as JSON.
- **Details** — message ID, size, MD5 digests, sender, sent and first-received times, receive count, message group ID, deduplication ID, sequence number, the raw system attributes, and **Change visibility** (a local addition).

Select one or more messages and choose **Delete**; the **Delete Messages** dialog confirms.

#### Why use it

Manual testing of producers and consumers without deploying application code — inspect payloads, retry behavior, and receive counts.

#### How it works in StackSim

Receiving a message always increments its receive count. With the console default visibility, a received message is hidden from other consumers only while it is listed: it becomes visible again when you poll again, when you leave the page, or 30 seconds after polling ends. Polling again therefore retrieves the same messages, as in the AWS console. Enter an explicit visibility timeout to hide received messages for exactly that long instead.

Single and batch send, receive and delete, delays, long polling, visibility changes, receipt handles, receive counts, message and system attributes, FIFO metadata, MD5s, durable leases, IAM checks, and restart recovery are active. The console sends one message at a time. Console inspection truncates very large bodies for display only.

#### Common AWS use cases

- Send a test job JSON before starting a Lambda consumer.
- Poll to verify EventBridge, SNS or S3 notifications arrived.
- Change visibility to 0 to retry a poison message immediately.
- Delete after confirming successful processing.

#### Example

```json
{"job":"resize-image","bucket":"uploads","key":"photo.jpg"}
```

With **Message group ID** `tenant-a` on a Standard queue to exercise fair scheduling, and a message attribute `priority` of type Number with value `10`.

---

### SNS subscriptions tab

#### What it is

Lists the Amazon SNS subscriptions that deliver to this queue: subscription ARN, topic ARN, and whether the queue's access policy lets that topic send messages (a local addition).

**Subscribe to Amazon SNS topic** (also under **Actions** in the queue list) opens a dialog: choose a topic from **Specify an Amazon SNS topic available for this queue**, or choose **Enter Amazon SNS topic ARN** and type one, then **Save**.

#### Why use it

Fan one published event out to several queues, each with its own consumer.

#### How it works in StackSim

**Save** calls SNS `Subscribe` with the `sqs` protocol and the queue ARN, then adds one statement to the queue's access policy that allows `sns.amazonaws.com` to call `sqs:SendMessage` when `aws:SourceArn` is the topic. Existing statements are kept. A queue access policy holds up to 20 statements.

Filter policies, raw message delivery and unsubscribing are managed from the SNS console. SNS FIFO topics are not available in StackSim.

---

### Lambda triggers tab

#### What it is

Info banner explains FIFO group ordering vs Standard at-least-once worker delivery.

**Lambda triggers** table: function name, state, batch size and window, maximum concurrency, partial batch failures, last processing result, **Enable**/**Disable**, **Delete**.

**Configure Lambda function trigger** opens a dialog. AWS asks only for the function; the other fields are local additions that set the mapping in one step:

| Field | Purpose |
|-------|---------|
| **Lambda function** | Choose an existing function or enter its ARN |
| **Enable trigger** | Start enabled or disabled |
| **Batch size** | 1–10 (FIFO) or 1–10000 (Standard) |
| **Batching window** | Seconds (0 for FIFO; ≥1 when batch > 10 on Standard) |
| **Maximum concurrency** | Optional cap (2–1000) |
| **Report partial batch item failures** | Retry only failed items |
| **Filter pattern** | Optional JSON filter on message body |

The dialog lists the permissions the function's execution role needs on the queue: `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes`.

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

### EventBridge Pipes tab

The tab is present so the queue page matches AWS, but StackSim does not emulate EventBridge Pipes. **Connect Amazon SQS queue to pipe** is disabled. Use a Lambda function trigger to process the queue's messages.

---

### Dead-letter queue tab

#### What it is

**Dead-letter queue** — whether a dead-letter queue is enabled, its ARN and **Maximum receives**. **Configure** opens a dialog with the **Disabled** / **Enabled** choice, **Dead-letter queue settings** (**Choose queue**, a queue of the same type) and **Maximum receives**.

**Redrive allow policy** — **Allow all**, **By queue** or **Deny all**, and the allowed source queues. **Configure** opens the editor. The same card is on the Queue policies tab.

Local additions:

- **Source queues** — the queues that use this queue as their dead-letter queue.
- **DLQ redrive** — the latest redrive task, **Start DLQ redrive**, and a link to the redrive tasks tab.
- **Receive-count diagnostics** — a reminder to poll on the Send and receive messages page to inspect `ApproximateReceiveCount`.

#### Why use it

Isolate messages that fail repeated processing without blocking the main queue — essential for resilient event-driven systems.

#### How it works in StackSim

Redrive policies, receive counting, compatible queue-type validation, durable cross-queue moves, payload and attribute preservation, FIFO group behavior, Lambda failure paths, metrics, source discovery, and restart recovery are active.

#### Common AWS use cases

- Route failed Lambda invocations after 5 receives to `orders-dlq`.
- Restrict which queues may use a shared dead-letter queue with **By queue**.
- Inspect dead-lettered messages manually before reprocessing.

#### Example

```text
Source queue:     orders
Dead-letter queue: orders-dlq
Maximum receives: 5
```

---

### Monitoring tab

#### What it is

Summary tiles for available, in flight, and delayed messages (a local addition), then the **SQS metrics** section with one graph per metric:

- Approximate Age Of Oldest Message
- Approximate Number Of Messages Delayed
- Approximate Number Of Messages Not Visible
- Approximate Number Of Messages Visible
- Number Of Empty Receives
- Number Of Messages Deleted
- Number Of Messages Received
- Number Of Messages Sent
- Sent Message Size
- FIFO queues: Approximate Number Of Groups With Inflight Messages, Number Of Deduplicated Sent Messages
- Standard queues: Approximate Number Of Noisy Groups, Approximate Number Of Messages Visible In Quiet Groups

**Time Range** chooses from Last Hour to Last Week. **View all CloudWatch metrics** opens the CloudWatch metrics page.

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

### Tagging tab

#### What it is

Tag key-value table. **Manage tags** opens **Key** and **Value** rows with **Add new tag** and **Remove**; **Edit as JSON** shows the same tags as a JSON object.

#### Why use it

Organize queues and participate in IAM resource-tag conditions.

#### How it works in StackSim

Creating, listing, adding, replacing, and removing queue tags, validation, pagination, persistence, IAM tag conditions, and supported CloudFormation behavior are active. Saving tags the keys you added or changed and untags the keys you removed.

#### Example

```text
Environment = dev
Team        = platform
CostCenter  = engineering
```

---

### Queue policies tab

#### What it is

Success banner: IAM and resource-policy authorization are active for the queue ARN.

**Access policy** — the queue's resource-based policy as JSON.

- **Edit** opens the **Basic** and **Advanced** methods described under Create queue. Basic regenerates the owner, sender and receiver statements and keeps every other statement.
- **Add statement** (local addition) is a statement generator: statement ID, effect, principal, actions, and optional source ARN and source account conditions.
- **Edit JSON** (local addition) opens the Advanced method directly. Leave the editor empty to remove the policy.

**Redrive allow policy** — the same card as on the Dead-letter queue tab, with **Edit**.

Local additions:

- **Effective-access diagnostics** — allow/deny counts, same-account vs cross-account vs service publisher guidance, statement table (Sid, Effect, Principal, Actions, Source ARN, Source account). Warnings for public principals (`Principal: "*"`) and cross-account trust.
- **EventBridge target authorization** — template granting `events.amazonaws.com` `sqs:SendMessage` with rule ARN and source account conditions. Link to EventBridge rules.
- **S3 notification authorization** — template for `s3.amazonaws.com` with bucket ARN condition; table of buckets whose notification configuration targets this queue.

#### Why use it

Let EventBridge rules, S3 bucket notifications, SNS topics, or cross-account producers send to the queue while keeping explicit deny precedence.

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

**Encryption** — **Server-side encryption** Enabled or Disabled and the **Encryption key type**, **Amazon SQS key (SSE-SQS)**. **Edit** opens the same choices as the create page; **AWS Key Management Service key (SSE-KMS)** is shown disabled.

Local additions:

- **Private local payload storage** — always protected; message bodies are authenticated-encrypted on disk independently of SSE-SQS.
- Warning: SSE-KMS (`KmsMasterKeyId`) is syntax-validated but fails with `UnsupportedOperation` because StackSim does not emulate KMS.
- **Queue encryption attributes** — ARN, `SqsManagedSseEnabled`, KMS fields (reference only), local storage protection note.

#### Why use it

Match production encryption posture and understand how StackSim protects data at rest locally.

#### How it works in StackSim

`SqsManagedSseEnabled` creation, updates, per-message mode metadata, durable reads across setting changes, SDK reporting, and installation-local authenticated payload encryption are active. StackSim never claims an AWS KMS key encrypted local data.

#### Common AWS use cases

- Leave SSE-SQS enabled for parity with default AWS queue creation.
- Disable server-side encryption to test applications that handle unmarked encryption metadata.

---

### Dead-letter queue redrive tasks tab

#### What it is

The table of redrive tasks for this queue: started time, status, destination, approximate moved and initial counts, maximum messages per second, failure reason (a local addition), and **Cancel DLQ redrive** on a running task. **Refresh tasks** reloads the table; active tasks refresh on their own.

**Start DLQ redrive** opens the redrive dialog:

| Section | Choices |
|---------|---------|
| **Redrive configuration → Message destination** | **Redrive to source queue(s)**, or **Redrive to custom destination** with the ARN of an existing queue of the same type |
| **Velocity control settings** | **System optimized**, or **Custom max velocity** with a rate of 1 to 500 messages per second |

**Redrive messages** starts the task.

#### Why use it

Return dead-lettered messages to where they can be processed again once the consumer is fixed.

#### How it works in StackSim

`StartMessageMoveTask`, `ListMessageMoveTasks`, and `CancelMessageMoveTask` are available through this tab and both protocol families. Only a queue that another queue uses as its dead-letter queue can be redriven, and one task runs at a time. Up to ten recent tasks are retained, newest first.

---

## Purge and delete

### Purge queue

**Purge** is in the queue header and under **Actions** in the queue list. The **Purge queue** dialog asks you to enter `purge`. Purging removes every visible, delayed, and in-flight message and cannot be undone. A queue cannot be purged again until 60 seconds have passed.

### Delete queue

**Delete** is in the queue header and the queue list toolbar. The **Delete queue** dialog asks you to enter `delete`.

Deleting removes the queue and its messages. It does not remove Lambda triggers that poll the queue: delete those from the Lambda triggers tab or from the function. A queue that other queues use as their dead-letter queue can be deleted; those queues keep their redrive policy, which then points at a queue that no longer exists.

---

## Supported integrations summary

| Producer / consumer | Integration |
|---------------------|-------------|
| **SNS topics** | Subscribe from the SNS subscriptions tab; queue policy statement for `sns.amazonaws.com` is added for you |
| **EventBridge rules** | Target type SQS; queue policy for `events.amazonaws.com` |
| **EventBridge Scheduler** | Target type SQS; execution role |
| **S3 notifications** | Queue configuration on bucket; queue policy for `s3.amazonaws.com` |
| **Lambda** | Event source mapping on the Lambda triggers tab |
| **IAM applications** | Identity policies plus optional queue policy |
| **CloudWatch** | `AWS/SQS` metrics on the Monitoring tab |

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Standard delivery | At least once — consumers must be idempotent |
| FIFO ordering | Strict per message group; `.fifo` suffix required |
| Fair queue (Standard) | Deterministic bounded-fair scheduling with `MessageGroupId` |
| SSE-KMS | Validated; fails with `UnsupportedOperation` |
| EventBridge Pipes | Not emulated; the tab is shown with its action disabled |
| SNS FIFO topics | Not emulated |
| S3 extended client | Unavailable |
| StartMessageMoveTask / ListMessageMoveTasks / CancelMessageMoveTask | Implemented through the redrive tasks tab and both APIs; source or custom destinations, velocity, progress, cancellation and history |
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


## Complete the DLQ recovery loop

Open the queue that holds the failures. **Start DLQ redrive** is in its header and on its **Dead-letter queue** and **Dead-letter queue redrive tasks** tabs; it is enabled because another queue uses this queue as its dead-letter queue. Inspect the messages first on the Send and receive messages page if you need to. Inspection receives messages and raises their receive counts; with the console default they are visible again as soon as you leave that page.

1. Fix the consumer and confirm its permissions and mapping are enabled.
2. Choose **Start DLQ redrive**. Under **Message destination**, **Redrive to source queue(s)** follows each message's stored origin, and **Redrive to custom destination** sends everything to another queue of the same type. A shared dead-letter queue can return messages to multiple source queues. Direct sends and older messages lacking provenance need a custom destination.
3. Under **Velocity control settings**, keep **System optimized** for a local ceiling, or choose **Custom max velocity** and an integer from **1 to 500 messages per second**. Start small while watching consumer logs.
4. Choose **Redrive messages**. The console opens **Dead-letter queue redrive tasks**: status, approximate moved/initial count, destination, requested velocity and any bounded failure reason. Active tasks refresh automatically; **Refresh tasks** also works on terminal history. New messages can arrive during a task, so the moved count can exceed its initial estimate.
5. **Cancel DLQ redrive** requests cancellation; CANCELLING becomes CANCELLED. Already committed messages remain at the destination. Up to ten recent tasks are retained, newest first.
6. Check Lambda logs and the application's result store. **COMPLETED means movement completed**, not that the application processed the messages successfully.

Listing requires ListMessageMoveTasks and GetQueueAttributes. Start/cancel also require their task action, ReceiveMessage and DeleteMessage on the DLQ; starting requires SendMessage on destinations. The service rechecks permissions during execution, so a policy change may stop a task. KMS and VPC endpoint dependent policies are explicit unsupported dependencies. Only SQS-backed DLQs in the same local account and Region are eligible. Errors are rendered in the dialog and the task table without copying message bodies or credentials into task diagnostics.

Follow the [SDK learning exercise](../examples/sqs-recovery-lab/README.md) for the full failure → logs → fix → redrive → successful processing path, cancellation/restart and cleanup. See the [SQS action inventory](sqs-action-inventory.md) for exact field and limit details.
