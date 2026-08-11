# StackSim SNS console guide

This guide explains every panel in the StackSim SNS console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon SNS behavior.

StackSim models Standard topics, publish and fan-out, SQS and Lambda subscriptions, filter policies, raw SQS delivery, topic policies, installation-local message signatures, managed retry, Standard SQS dead-letter queues, delivery feedback logs, and CloudWatch metrics locally. Where local behavior differs from AWS (for example FIFO topics, HTTP/email/SMS endpoints, or customer KMS keys), those boundaries are called out explicitly.

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

The SNS service in StackSim has a left navigation bar with:

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Overview** | `#/sns` | Regional topic and delivery summary |
| **Topics** | `#/sns/topics` | List and create topics |
| **Subscriptions** | `#/sns/subscriptions` | Account-wide subscription catalog |

Opening a topic navigates to `#/sns/topics/{name}` with **Details** and **Monitoring** tabs.

The console uses the same SNS API as the AWS SDK and CLI (`@aws-sdk/client-sns`, Query API `2010-03-31`).

---

## Overview

### Regional dashboard

#### What it is

The **Overview** landing page shows:

| Card | Content |
|------|---------|
| **Standard topics** | Count of topics in the current Region |
| **SQS and Lambda subscriptions** | Total confirmed subscriptions |
| **Pending deliveries** | Deliveries in `QUEUED` or `LEASED` state |

**Create topic** opens the creation modal.

Info banner lists active integrations: filters, raw SQS delivery, topic policies, signatures, managed retry, Standard SQS dead-letter queues, delivery feedback logs, four CloudFormation providers, and named first-party producer paths. FIFO and HTTP/S, email, SMS, and mobile endpoints remain unavailable.

**Integration health** table:

| Producer | Status |
|----------|--------|
| Lambda async and DynamoDB Streams | Policy-aware publication |
| CloudWatch alarms | Durable action outbox |
| EventBridge targets | Existing retry/DLQ worker |
| CloudFormation notifications | Durable event outbox |
| API Gateway Publish | Dependency blocked |

**Delivery health** — count of terminal failures in retained redacted diagnostics. Message bodies and attributes are never exposed; accepted payloads live in the authenticated-encrypted SNS delivery store.

#### Why use it

Quick regional health check before publishing or troubleshooting fan-out to SQS queues and Lambda functions.

#### How it works in StackSim

Summary counts come from live SNS APIs plus private delivery diagnostics (`/_stacksim/api/sns/deliveries`). A successful `Publish` means SNS durably accepted the message and created delivery intents — not that every subscriber completed delivery.

#### Common AWS use cases

- Confirm topics and subscriptions exist after CDK deploy.
- See pending deliveries during retry backoff.
- Verify which upstream producers are wired locally.

---

## Topics

### Topic catalog

#### What it is

The **Topics** page lists every topic with name, type (Standard), and topic ARN. **Create topic**, **Refresh**, and a filter box are in the header.

#### Why use it

Central inventory for pub/sub channels — the starting point for subscriptions, policies, and test publishes.

#### How it works in StackSim

Standard-topic lifecycle, display names, signatures, tags, topic policies, publishing and batch publishing, durable local acceptance, metrics, and supported CloudFormation resources are active. FIFO topics, customer KMS keys, Firehose, mobile, SMS, email, and HTTP/S delivery are unavailable.

#### Common AWS use cases

- `orders` — fan-out order events to inventory and shipping queues.
- `alarms` — CloudWatch alarm action destination.
- `app-events` — EventBridge rule target for cross-service notifications.

#### Example

Filter for `orders` to open the topic detail page and inspect subscriptions.

---

### Create topic (modal)

#### What it is

| Field | Purpose |
|-------|---------|
| **Topic name** | 1–256 alphanumeric characters, hyphens, underscores |
| **Display name (optional)** | Human-readable name included in SMS/email (reference for future protocols) |
| **Signature version** | `1` (RSA-SHA1) or `2` (RSA-SHA256) for signed delivery envelopes |
| **Tags (JSON object)** | Key-value labels at creation |

Info banner: Standard topics only — FIFO topics are not currently available.

#### Why use it

Create a fan-out channel before wiring publishers (Lambda, EventBridge, CloudWatch) or subscribers (SQS, Lambda).

#### How it works in StackSim

Signature version selects the installation-local RSA certificate used in signed SQS and Lambda envelopes. This is not AWS KMS encryption.

#### Example

```text
Name:              orders
Display name:      Order notifications
Signature version: 2
Tags:              {"Application":"billing","Environment":"dev"}
```

---

## Topic detail

Route: `#/sns/topics/{name}`. Monitoring: `#/sns/topics/{name}/monitoring`.

Header actions: **Configure**, **Create subscription**, **Publish message**, **Delete**.

Tabs: **Details**, **Monitoring**.

---

### Details tab — Topic details

#### What it is

Card showing:

| Field | Content |
|-------|---------|
| **Type** | Standard |
| **Owner** | Account ID |
| **Confirmed subscriptions** | Count from topic attributes |
| **Signature version** | Active version with note: installation-local RSA certificate |

#### Why use it

Verify the stable channel identity applications publish to.

#### How it works in StackSim

Topic policies and IAM checks govern who may publish. Durable `Publish` and `PublishBatch` acceptance, protocol-specific JSON, message attributes, installation-local signatures, feedback sampling, managed retry, redacted logs, and `AWS/SNS` metrics are active. Internal encrypted storage is not AWS KMS encryption.

---

### Details tab — Tags

#### What it is

Tag key-value table with **Manage** link to a JSON editor (add, replace, or remove tags; all values must be strings).

#### Why use it

Organize topics by application, environment, or owner for operations and automation.

#### How it works in StackSim

Creating, listing, adding, replacing, and removing topic tags, validation, pagination, restart persistence, compatible SDK operations, and supported CloudFormation behavior are active.

#### Example

```json
{"Team": "platform", "CostCenter": "engineering"}
```

---

### Details tab — Subscriptions

#### What it is

Table of subscriptions on this topic:

| Column | Content |
|--------|---------|
| **Protocol** | `sqs` or `lambda` |
| **Endpoint** | Queue or function ARN (linked to SQS or Lambda console) |
| **Filter** | Filter scope when a filter policy is set, or `None` |
| **Raw** | Raw SQS delivery flag |
| **Subscription ARN** | Full subscription identifier |
| **Action** | **Configure**, **Unsubscribe** |

**Create subscription** opens the subscription modal. Empty state prompts adding an SQS queue or Lambda function endpoint.

#### Why use it

Connect one topic to multiple consumers without the publisher knowing endpoint details.

#### How it works in StackSim

Confirmed same-account, same-Region SQS and Lambda endpoints, endpoint-policy checks, filtering, raw SQS delivery, managed retry, Standard SQS dead-letter queues, feedback logs, metrics, and durable delivery across restarts are active. HTTP/S, email, SMS, mobile, Firehose, confirmation workflows, and custom delivery policies are unavailable.

Endpoints must already exist. SQS queue policies must trust `sns.amazonaws.com` and the topic ARN.

#### Common AWS use cases

- Fan-out to `inventory-queue` and `shipping-queue` from one `orders` topic.
- Invoke `order-processor` Lambda asynchronously on each publish.
- Filter by message attribute `eventType: order.created` so only matching subscribers receive the message.

---

### Create subscription (modal)

#### What it is

| Field | Purpose |
|-------|---------|
| **Protocol** | SQS or Lambda |
| **Endpoint ARN** | Existing queue or function in this account and Region |
| **Filter policy (JSON, optional)** | Attribute or body filter |
| **Filter scope** | `MessageAttributes` or `MessageBody` |
| **Raw SQS delivery** | Deliver original body to SQS without SNS envelope |
| **Dead-letter queue ARN (optional)** | Standard SQS DLQ for exhausted delivery attempts |

Links to SQS queues and Lambda functions. Hint: configure the endpoint resource policy to trust `sns.amazonaws.com` and this topic ARN.

#### Why use it

Add a consumer to an existing topic with optional filtering and failure routing.

#### How it works in StackSim

Subscriptions are confirmed immediately for SQS and Lambda — no email/HTTP confirmation workflow. Filter evaluation uses the configured scope before delivery formatting. Raw delivery does not change filter evaluation.

#### Example

```text
Protocol:     sqs
Endpoint:     arn:aws:sqs:eu-west-1:000000000000:inventory-queue
Filter scope: MessageAttributes
Filter:       {"eventType":["order.created"]}
Raw delivery: false
DLQ:          arn:aws:sqs:eu-west-1:000000000000:inventory-dlq
```

---

### Configure subscription (modal)

Available from **Configure** on a subscription row.

| Field | Purpose |
|-------|---------|
| **Filter policy** | JSON filter; empty removes |
| **Filter scope** | Message attributes or message body |
| **Raw SQS delivery** | Toggle raw SQS format |
| **Dead-letter queue ARN** | Set or clear DLQ |

#### Why use it

Adjust routing rules without recreating the subscription.

#### Example filter on message body

```json
{"status": ["shipped", "delivered"]}
```

With **Filter scope**: `MessageBody` (message must be valid JSON).

---

### Publish message (modal)

#### What it is

| Field | Purpose |
|-------|---------|
| **Message** | Required body (up to 262144 characters) |
| **Subject (optional)** | Up to 99 characters |
| **Message structure** | Identical payload or protocol-specific JSON |
| **Message group ID (optional)** | Forwarded to Standard SQS fair queues |
| **Message attributes (JSON object)** | SNS attribute structures |

Hint: attributes cannot accompany protocol-specific JSON structure.

#### Why use it

Manual test of fan-out, filters, and delivery without deploying a publisher application.

#### How it works in StackSim

Acceptance returns a `MessageId` when SNS stored the message for asynchronous fan-out. Each matching subscription gets an independent delivery intent. Slow or failing endpoints do not roll back `Publish`.

#### Common AWS use cases

- Publish a test order JSON and verify both SQS queues receive it.
- Publish with attributes to exercise subscription filters.
- Publish with `MessageGroupId` when the SQS subscriber uses fair-queue scheduling.

#### Example

```text
Message:   {"orderId":"123","status":"created"}
Subject:   New order
Attributes: {"eventType":{"DataType":"String","StringValue":"order.created"}}
```

---

### Configure topic (modal)

Available from **Configure** on the topic header.

| Field | Purpose |
|-------|---------|
| **Signature version** | RSA-SHA1 or RSA-SHA256 |
| **Topic policy** | JSON resource-based policy |
| **SQS success feedback role ARN** | Role for successful delivery logs |
| **SQS success sample %** | 0–100 sampling rate |
| **SQS failure feedback role ARN** | Role for failed delivery logs |
| **Lambda success feedback role ARN** | Role for successful Lambda delivery logs |
| **Lambda success sample %** | 0–100 sampling rate |
| **Lambda failure feedback role ARN** | Role for failed Lambda delivery logs |

#### Why use it

Control who may publish or subscribe, which signature version subscribers see, and where delivery-status feedback is logged.

#### How it works in StackSim

Topic policy JSON is validated. IAM and topic-policy composition, same-account evaluation, explicit deny, and service-principal conditions for supported producers are modeled. Delivery feedback logs are permission-gated and redacted — no message bodies.

#### Example topic policy (allow EventBridge publish)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowEventBridgePublish",
    "Effect": "Allow",
    "Principal": {"Service": "events.amazonaws.com"},
    "Action": "sns:Publish",
    "Resource": "arn:aws:sns:eu-west-1:000000000000:orders",
    "Condition": {
      "ArnEquals": {"aws:SourceArn": "arn:aws:events:eu-west-1:000000000000:rule/order-events"},
      "StringEquals": {"aws:SourceAccount": "000000000000"}
    }
  }]
}
```

---

### Payload-safe delivery health

#### What it is

Card on the Details tab showing pending, delivered, and failed counts for this topic's subscriptions. Link to **Monitoring** tab.

Note: only redacted endpoint hashes, status, attempts, and bounded error text are available. Payload content is never returned by diagnostics.

#### Why use it

Troubleshoot fan-out without exposing message bodies in the console.

#### How it works in StackSim

Diagnostics come from the private delivery API. Status values include `QUEUED`, `LEASED`, `DELIVERED`, and `FAILED`.

---

### Delete topic

Requires confirmation. Removes the topic and its subscriptions. Already accepted delivery intents remain durable.

---

## Monitoring tab

### Topic activity

#### What it is

**Topic activity** chart for the last hour (1-minute periods):

- Published (count)
- Publish size (average)
- Delivered (count)
- Failed (count)
- Filtered out (count)

**Refresh** reloads data. **View all metrics** links to CloudWatch.

#### Why use it

Observe publish volume and delivery success during load tests or filter tuning.

#### How it works in StackSim

CloudWatch `AWS/SNS` metrics for the topic name are measured locally through the shared metrics API.

#### Common AWS use cases

- Confirm filtered-out count rises when tightening subscription filters.
- Compare published vs delivered after adding a new subscriber.

---

### Retained delivery diagnostics

#### What it is

Payload-safe table:

| Column | Content |
|--------|---------|
| **Status** | QUEUED, LEASED, DELIVERED, FAILED |
| **Protocol** | sqs or lambda |
| **Endpoint hash** | Redacted endpoint identifier |
| **Attempts** | Delivery attempt count |
| **Error** | Error code and bounded message |

Empty state: publish a message to observe redacted delivery state and SNS metrics.

#### Why use it

Per-delivery troubleshooting when metrics show failures but message content must stay private.

#### How it works in StackSim

Retained diagnostics are redacted and payload-safe. Message bodies remain in the authenticated-encrypted delivery store only.

---

## Subscriptions

Route: `#/sns/subscriptions`.

### Subscription catalog

#### What it is

Account-wide table of confirmed subscriptions: topic name (linked), protocol, endpoint (linked to SQS or Lambda when applicable), subscription ARN. Filter box searches all columns.

#### Why use it

Find which topic owns a queue or function subscription without opening each topic individually.

#### How it works in StackSim

Same subscription model as the topic detail page — confirmed same-account, same-Region SQS and Lambda only. Open the linked topic to create subscriptions or change filter, raw-delivery, and DLQ settings.

#### Example workflow

Filter for `inventory-queue` ARN → open linked topic → **Configure** subscription filter.

---

## Supported integrations summary

### Publishers (to SNS topics)

| Producer | StackSim status |
|----------|-----------------|
| **Application `Publish`** | Active via SDK/CLI/console |
| **Lambda async** | Policy-aware publication |
| **DynamoDB Streams** | Policy-aware publication |
| **CloudWatch alarms** | Durable action outbox |
| **EventBridge rules** | Target with retry/DLQ worker |
| **CloudFormation stacks** | Durable event outbox |
| **API Gateway Publish** | Dependency blocked |

### Subscribers (from SNS topics)

| Protocol | StackSim status |
|----------|-----------------|
| **SQS** | Envelope or raw delivery; optional DLQ |
| **Lambda** | Asynchronous invoke with SNS event shape |
| **HTTP/S** | Unavailable |
| **Email** | Unavailable |
| **SMS** | Unavailable |
| **Mobile push** | Unavailable |
| **Firehose** | Unavailable |

### Related services

| Service | Relationship |
|---------|--------------|
| **SQS** | Subscription endpoint; configure queue policy for `sns.amazonaws.com` |
| **Lambda** | Subscription endpoint; function resource policy or IAM |
| **EventBridge** | Can target SNS topics; SNS can fan out to SQS/Lambda |
| **CloudWatch** | Alarm actions and SNS metrics |
| **IAM** | Identity policies plus topic resource policies |

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Topic types | Standard only; FIFO unavailable |
| Subscription protocols | SQS and Lambda only |
| Confirmation workflow | Not required for SQS/Lambda |
| `Publish` success | Durable acceptance; async fan-out |
| Message signatures | Installation-local RSA certificate |
| KMS encryption | Unavailable |
| Delivery diagnostics | Payload-safe; private API |
| Raw SQS delivery | Available on SQS subscriptions |
| Filter policies | Message attributes or JSON message body |
| Subscription DLQ | Standard SQS queue only |
| Cross-account | Same-account, same-Region endpoints only |
| HTTP/email/SMS/mobile | Unavailable |
| API Gateway Publish | Dependency blocked |
| CloudFormation | Four SNS resource providers supported |
| Persistence | Topics, subscriptions, and deliveries survive restart |

---

## Related StackSim docs

- [SQS console guide](./sqs-console-guide.md) — SNS subscription endpoints and queue policies
- [EventBridge console guide](./eventbridge-console-guide.md) — rules that publish to SNS topics
- [IAM console guide](./iam-console-guide.md) — topic policies and publish/subscribe permissions
- [DynamoDB console guide](./dynamodb-console-guide.md) — stream events published to SNS
- [API Gateway console guide](./apigateway-console-guide.md) — HTTP APIs alongside pub/sub (SNS Publish integration blocked)
- [Parameter Store console guide](./parameter-store-console-guide.md) — topic ARNs in application configuration
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — credentials for publishers and subscribers
- [SES console guide](./ses-console-guide.md) — email is a separate notification path from SNS
- [Developer guide](./developer-guide.md) — event-driven and fan-out patterns
- [Reference](./reference.md) — SNS API summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — SNS CLI examples
- [Lambda console guide](./lambda-console-guide.md) — Lambda subscription endpoints
- [CloudWatch console guide](./cloudwatch-console-guide.md) — SNS metrics and alarm boundaries
