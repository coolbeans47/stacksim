# StackSim EventBridge console guide

This guide explains every panel in the StackSim EventBridge console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon EventBridge and EventBridge Scheduler behavior.

StackSim routes custom events through event buses and rules to local targets, retains explicitly archived events for selected-rule replay, and runs time-based schedules through EventBridge Scheduler. Where local behavior differs from AWS (for example local archive timing, partner buses, or cross-account routing), those boundaries are called out explicitly.

**Important:** Ordinary EventBridge routing is not an event history browser. Accepted payloads are retained only when an explicit archive captures them; archive details expose counts and state, not arbitrary payload browsing.

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

The EventBridge service in StackSim has a left navigation bar with:

| Nav item | Purpose |
|----------|---------|
| **Overview** (landing) | Summary counts and quick links |
| **Event buses** | Regional routers and custom buses |
| **Rules** | Event-pattern rules across all buses |
| **Schedules** | EventBridge Scheduler (time-driven invocations) |
| **Schedule groups** | Organize schedules and group tags |
| **Sandbox** | Test patterns and publish custom events |

### Event bus detail tabs

`#/eventbridge/event-buses/{name}/...`

| Tab | Purpose |
|-----|---------|
| **Details** | Bus metadata, related rules, dependency cards |
| **Rules** | Rules on this bus |
| **Monitoring** | Delivery diagnostics (payload-redacted) |
| **Tags** | Bus tags |

### Rule detail tabs

`#/eventbridge/rules/{bus}/{rule}/...`

| Tab | Purpose |
|-----|---------|
| **Details** | Rule state, event pattern, target summary |
| **Targets** | Up to five independent targets per rule |
| **Monitoring** | Per-rule delivery visibility |
| **Tags** | Rule tags |

---

## Overview

### What it is

The **Overview** landing page shows summary cards for **Event buses**, **Rules**, **Schedules**, and **Schedule groups** with counts and links. Actions: **Open Sandbox**, **Create schedule**.

### Why use it

Orient yourself toward routing (buses/rules) versus scheduling before creating resources.

### How it works in StackSim

Counts reflect the current Region. Enabled rule count is shown on the Rules card.

---

## Event buses

### Event buses (list)

#### What it is

Lists every bus with name, type (default or custom), rule count, description, and ARN. **Create event bus** opens a modal. Filter and refresh supported.

An info banner distinguishes transient ordinary routing from explicit Archives, and links developers to Sandbox for publishing and pattern tests.

#### Why use it

Custom buses isolate one application's events from the shared `default` bus or other teams' traffic.

#### How it works in StackSim

The **default** bus, custom-bus lifecycle, descriptions, tags, `PutEvents` ingestion, rule matching, and durable target handoff are active locally.

Partner sources, resource policies, cross-account routing, customer-managed KMS, bus DLQs, and execution logging are unavailable. Installation-encrypted local archives and replay are active.

#### Common AWS use cases

- `default` — application and AWS service events.
- `orders-events` — order-domain microservice isolation.

---

### Create event bus (modal)

#### What it is

Fields: **Name**, **Description**, **Tags (JSON object)**.

#### Why use it

Separate event namespaces without creating separate AWS accounts.

#### How it works in StackSim

The regional **default** bus already exists and cannot be deleted. Partner sources, KMS, DLQ, and logging are not available on custom buses locally.

---

## Event bus detail

### Bus details

#### What it is

Shows type, name, ARN, description. **Related rules** card with count and **Create rule**. Dependency cards for **Permissions**, **Encryption**, and **Logging** (marked unavailable — reference-only boundaries).

#### Why use it

Starting point for rules on a specific bus and understanding unsupported AWS bus features locally.

#### How it works in StackSim

Custom bus creation and deletion, undeletable default bus, descriptions, tags, rules, ingestion, and local routing persist. Event payloads are not retained after matching.

---

### Bus rules tab

#### What it is

Table of rules on this bus with links to rule detail. **Create rule** pre-selects this bus.

#### Why use it

Manage all routing logic scoped to one bus.

#### How it works in StackSim

Same as account-wide rules list, filtered to one bus.

---

### Bus monitoring tab

#### What it is

**Delivery configuration** table per rule (state, target count, delivery contract). **Recent delivery attempts** table (payload-redacted): event ID, rule, target, status, attempts, DLQ, errors.

Link to **EventBridge metrics** in CloudWatch.

#### Why use it

Debug delivery failures without reading full event payloads in the console.

#### How it works in StackSim

At most 100 recent terminal/retry summaries retained. Event payloads never returned on this page.

---

### Bus tags tab

#### What it is

Tag table with **Manage tags** modal (JSON object replacement).

#### Why use it

Organize buses for IAM conditions and operational grouping.

#### How it works in StackSim

Tag creation, replacement, removal, validation, listing, and persistence are active.

---

## Rules

### Rules (list)

#### What it is

Account-wide list of event-pattern rules with bus name, state, description, and ARN. **Create rule** opens the rule wizard modal.

Info banner: up to five targets per rule (Lambda, SQS, Logs, API Gateway, Standard Step Functions). Scheduled rules on this surface are legacy/default-bus only — use **Scheduler** for new time-driven work. Workflow delivery succeeds only after durable `StartExecution` admission and uses the configured target role.

#### Why use it

Find rules by name across buses after CDK or Terraform deploy.

#### How it works in StackSim

Event-pattern rules, pattern testing, enabled/disabled state, descriptions, tags, metrics, and durable delivery are active.

The console does not create scheduled-only rules without an event pattern on non-default buses.

---

### Create rule (modal)

#### What it is

Collects:

- **Event bus**, **Rule name**, **Description**, **State**
- **Event pattern (JSON)** and **Sample event (JSON)** with **Test pattern**
- **Legacy schedule expression (optional)** — default bus only, UTC
- **Target (optional)** — full target configuration (see Targets section)
- **Tags (JSON object)**

Creates rule via `PutRule`, optionally adds first target via `PutTargets`.

#### Why use it

One-step rule plus optional target for common event-driven workflows.

#### How it works in StackSim

If target creation fails, the rule is still created and you are redirected to Targets to fix permissions.

Legacy `rate(...)` / `cron(...)` on rules coexists with event patterns on the **default** bus only.

---

## Rule detail

### Rule details tab

#### What it is

Summary cards: **Rule details** (state, bus, description, ARN), **Targets** count, **Tags** count. Full **Event pattern** JSON with **Test pattern**. Warning about target permissions.

If the rule has a legacy schedule expression, an additional **Legacy schedule** card appears with link to Scheduler.

Actions: Refresh, Test pattern, Enable/Disable, Edit, Delete.

#### Why use it

Canonical view of whether a rule is active and what pattern it evaluates.

#### How it works in StackSim

Disabled rules do not match new events. Deleting a rule removes all targets first.

---

### Event pattern

#### What it is

JSON filter over fields such as `source`, `detail-type`, `resources`, and `detail`. Editable in **Edit rule** modal. Testable via **Test pattern** or Sandbox.

#### Why use it

Narrow rules so only intended events invoke targets — reduces cost and accidental triggers.

#### How it works in StackSim

Pattern validation, matching, nested objects, arrays, supported comparison operators, rule evaluation, and sample-event tester run locally. Unsupported syntax is rejected rather than silently matching.

#### Example

```json
{
  "source": ["example.orders"],
  "detail-type": ["Order state changed"],
  "detail": {
    "state": ["created", "shipped"]
  }
}
```

---

### Rule targets tab

#### What it is

Lists up to **five** targets with ID, type, destination link, input summary, retry policy, DLQ, and delivery diagnostics. **Add target** / edit / remove.

Info: independent at-least-once delivery per target.

#### Why use it

Each matching event fan-outs to every configured target independently.

#### How it works in StackSim

Lambda, same-Region Standard SQS, CloudWatch Logs, API Gateway, and same-account/Region Standard Step Functions targets; input transformations; target parameters; execution roles or resource policies; independent durable retries; and Standard SQS DLQs are active. Step Functions target success is recorded only after durable `StartExecution` admission.

Other target types and cross-account delivery are unavailable.

---

### Add / edit target (modal)

#### What it is

Configuration sections:

**Target identity**

- **Target type** — Lambda, SQS, CloudWatch Logs, API Gateway, Step Functions
- **Target ID** — stable identifier (immutable after creation — remove and re-add to change)
- Type-specific ARN or function selector

**Target input**

- **Matched event** — pass full event
- **Constant JSON**
- **JSON path** — for example `$.detail`
- **Input transformer** — paths map plus template; Logs targets require numeric `timestamp` and string `message`

**Transformation preview** — sample event plus preview button

**Authorization and failure handling**

- **Execution role ARN** (optional; not for Logs targets)
- **Dead-letter queue ARN** (Standard SQS)
- **Maximum event age** and **Maximum retry attempts**

Resource-policy guidance templates per target type.

#### Why use it

Different targets need different input shapes and authorization models.

#### How it works in StackSim

- **Lambda** — resource policy or execution role with `lambda:InvokeFunction`
- **SQS** — queue policy or role; optional message group ID for FIFO/fair-queue
- **Logs** — log group resource policy; no target role; creates stream in existing group
- **API Gateway** — resource policy or role; HTTP parameters for path/query/headers

API Gateway 429 and 5xx retry; other 4xx are terminal. Lambda success means async invocation accepted.

#### Example

Lambda target with matched event:

```text
Target type:  Lambda
Function:     order-processor
Input:        Matched event
Max retries:  185
Max age:      86400 seconds
```

---

### Rule monitoring tab

#### What it is

Rule state, configured target count, delivery state metrics, and payload-redacted attempt table (same shape as bus monitoring, scoped to one rule).

#### Why use it

Per-rule troubleshooting after Sandbox `PutEvents` tests.

---

### Rule tags tab

#### What it is

Tags with **Manage tags**. Info note: create-time tags apply at rule creation; this page handles later changes.

---

## Sandbox

### Test event pattern

#### What it is

**Event pattern (JSON)** and **Sample event (JSON)** with **Test pattern** button. Shows match / no-match result.

#### Why use it

Validate pattern design before enabling a rule or publishing events.

#### How it works in StackSim

Uses the same matching engine as active rules. Does not store the sample or invoke targets.

---

### Send events

#### What it is

Publish up to **ten** custom entries per request. Each entry: **Event bus**, **Source**, **Detail type**, **Detail (JSON)**, optional **Resources**.

**Add entry** / **Remove entry**. **Send events** calls `PutEvents` and shows per-entry results with generated event IDs.

#### Why use it

Exercise rules and targets without building a producer application.

#### How it works in StackSim

Ordered per-entry validation and results, enabled-rule evaluation, durable target handoff, metrics, retries, and DLQs are active. Accepted payloads are not retained for browsing. Does not route to remote AWS accounts.

#### Example entry

```text
Event bus:    default
Source:     example.orders
Detail type: Order state changed
Detail:     {"state":"created","orderId":"123"}
```

---

### Delivery visibility

#### What it is

Pointer to rule Monitoring pages and CloudWatch EventBridge metrics.

#### Why use it

Connect publish tests to downstream delivery outcomes.

---

## Schedules

### Schedules (list)

#### What it is

Lists schedules with name, group, state, target ARN, next run, and last delivery status. **Create schedule** opens the Scheduler modal.

Info: Scheduler supports `at(...)`, `rate(...)`, six-field `cron(...)`, IANA time zones, retries, DLQs, and durable checkpoints.

#### Why use it

Recommended surface for time-driven work instead of legacy rule schedules.

#### How it works in StackSim

One-time, rate, and cron expressions; IANA time zones and daylight-saving behavior; start and end dates; flexible windows; durable checkpoints; retries; execution roles; Standard SQS DLQs; and completion deletion are active.

Supported targets: Lambda, SQS, Step Functions, EventBridge buses.

---

### Create / edit schedule (modal)

#### What it is

Fields include:

| Field | Purpose |
|-------|---------|
| **Schedule group** | Group namespace (default available) |
| **Name** | Schedule identifier |
| **Description** | Optional text |
| **Schedule expression** | `at(...)`, `rate(...)`, or `cron(...)` with rate examples picker |
| **Time zone** | IANA zone |
| **State** | Enabled or Disabled |
| **Start / End date** | Optional bounds |
| **Flexible time window** | Off or flexible with max minutes |
| **Target ARN** | Lambda, SQS, state machine, or event bus |
| **Scheduler execution role ARN** | Required; use IAM guided role wizard |
| **Target input** | Optional JSON or text |
| **Maximum event age / retry attempts** | Failure handling |
| **Standard SQS DLQ ARN** | Optional |
| **After one-time completion** | Keep or delete schedule |

#### Why use it

Cron/rate/at scheduling with time zone awareness for local batch jobs, polling, or one-time invocations.

#### How it works in StackSim

Next committed run shown on detail page after save. Execution role must trust `scheduler.amazonaws.com` and permit target invocation.

#### Example

```text
Name:        nightly-cleanup
Expression:  cron(0 2 * * ? *)
Time zone:   Europe/Dublin
Target:      arn:aws:lambda:eu-west-1:000000000000:function:cleanup
Role:        arn:aws:iam::000000000000:role/cleanup-schedule-role
```

---

### Schedule detail

#### What it is

**Schedule details**: group, state, expression, time zone, next invocation, pending delivery, last delivery, last error, target, execution role, flexible window, after-completion action. **Edit** and **Delete**.

#### Why use it

Verify timing and delivery diagnostics for a scheduled job.

#### How it works in StackSim

Full local create, read, update, delete, enablement, next-run calculation, pending and last-delivery diagnostics, execution-role enforcement, retries, and supported target invocation are durable across restarts.

---

## Schedule groups

### Schedule groups (list)

#### What it is

Lists groups with name, state, schedule count, created date. **Create schedule group** modal (name + tags).

#### Why use it

Organize schedules by application or environment.

#### How it works in StackSim

Default group exists. Custom group lifecycle, tags, grouped listing, schedule counts, and cascading asynchronous deletion persist locally. Group tags are not inherited by schedules.

---

### Schedule group detail

#### What it is

**Group details** — state, schedule count, created, tags. **Schedules** table in the group. **Manage tags**. **Delete** (non-default groups; cascades schedules).

#### Why use it

Manage schedules and group-level metadata together.

#### How it works in StackSim

Deleting a group starts asynchronous deletion of contained schedules.

---

## Supported targets summary

### Event-pattern rule targets

| Type | Authorization |
|------|---------------|
| **Lambda** | Function resource policy or execution role |
| **SQS** | Queue policy or execution role |
| **CloudWatch Logs** | Log group resource policy (no role) |
| **API Gateway** | API resource policy or execution role |
| **Step Functions** | Required EventBridge execution role with `states:StartExecution` on the state machine |

### Scheduler targets

| Type | Notes |
|------|-------|
| **Lambda** | Async invoke |
| **SQS** | Standard queue |
| **Step Functions** | Start execution |
| **EventBridge bus** | PutEvents to another bus |

---

## Archives and replays

Use **Archives** to create an archive on exactly one source bus, optionally filter through an event pattern, and choose indefinite (`0`) or finite day retention. The catalog/detail pages show committed unexpired event count, logical bytes, state/reason, pattern, retention, and related bus/replay navigation. The pattern builder tests a sample through the same pattern engine used for capture. Editing changes description, pattern, and retention but never the source bus; deletion is blocked while an active replay holds references.

Use **Replays** (or **Replay** on an archive) to select a time range and optionally specific enabled rules on the source bus. Leave rule selection empty for every enabled matching rule. Detail progress uses the last committed event time within the requested range and is labeled as a simulator indicator, not an AWS metric. Cancellation stops future submissions only. Completed events contain `replay-name`, may be processed again by the chosen targets, remain in the source archive until retention/deletion, and are never re-archived.

Archive segments are installation-key encrypted and restart-safe. Counts, event-time/minute ordering, replay speed, and diagnostics are deliberately development-grade local behavior. Customer-managed KMS is not selectable because that dependency fails closed.

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Event history browsing | No arbitrary browser; explicit archives expose counts/state and replay ranges |
| Partner event sources | Unavailable |
| Event archives / replay | Encrypted local segments, optional pattern and retention, source-bus/selected-rule replay, `replay-name`, restart-safe at least once |
| Cross-account buses/rules | Unavailable |
| Bus resource policies | Unavailable |
| KMS encrypted buses | Unavailable |
| Customer-managed KMS for archives | Unavailable; syntax-checked dependency failure with no mutation |
| Bus execution logging | Unavailable |
| Rule schedule on custom bus | Unavailable (default bus legacy only) |
| Scheduled rules (legacy) | Default bus, UTC, one-minute precision |
| Max targets per rule | 5 |
| Max PutEvents entries (Sandbox) | 10 |
| Delivery diagnostics retention | ~100 recent summaries, payload-redacted |
| Scheduler targets | Lambda, SQS, Step Functions, EventBridge bus |
| Scheduler time zones | IANA with DST behavior |

---

## Related StackSim docs

- [IAM console guide](./iam-console-guide.md) — EventBridge and Scheduler execution roles
- [API Gateway console guide](./apigateway-console-guide.md) — HTTP API rule targets
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — credentials for scheduled or event-driven jobs
- [Parameter Store console guide](./parameter-store-console-guide.md) — non-secret configuration
- [Developer guide](./developer-guide.md) — event-driven application patterns
- [Reference](./reference.md) — EventBridge and Scheduler API summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — EventBridge CLI examples
- [SQS console guide](./sqs-console-guide.md) — rule and Scheduler targets for Standard queues
- [SES console guide](./ses-console-guide.md) — configuration-set event destinations
- [SNS console guide](./sns-console-guide.md) — rule targets that publish to topics
- [Lambda console guide](./lambda-console-guide.md) — rule and Scheduler Lambda targets
- [Step Functions console guide](./step-functions-console-guide.md) — Scheduler state machine targets
- [CloudWatch console guide](./cloudwatch-console-guide.md) — alarm actions and custom events
