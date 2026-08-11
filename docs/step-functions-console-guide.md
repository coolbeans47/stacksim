# StackSim Step Functions console guide

This guide explains every panel in the StackSim Step Functions console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Step Functions behavior.

StackSim models Standard JSONPath state machines, a local visual definition editor with JSON round-trip, Parallel and Inline Map, retries/catches, common SFN-03 optimized service integrations, callbacks, Activities, nested workflows, durable typed history, and CloudWatch metrics. Full AWS Workflow Studio parity, Express workflows, JSONata, versions, aliases, redrive, Distributed Map, AWS SDK integrations, HTTP tasks, and unlisted optimized integrations remain unavailable.

SFN-03 task attempts have stable correlation across restart. Private worker diagnostics may identify an attempt as undispatched, dispatched, accepted, completed, failed, or ambiguous, but never render request payloads, credentials, or task tokens. Receipt-backed owning services reconcile committed acceptance; EventBridge entry acceptance is atomic with delivery intent, and DynamoDB result payloads stay in its private receipt database. Terminal receipts are reclaimed after the workflow checkpoint is durable. A non-receipted Lambda dispatch, or a timeout after a potentially accepted non-idempotent dispatch, is shown as explicit ambiguity and is not retried automatically.

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

| Nav item | Route | Purpose |
|----------|-------|---------|
| **State machines** | `#/step-functions/state-machines` | Catalog and detail |
| **Executions** | `#/step-functions/executions` | Account-wide execution list |
| **Activities** | `#/step-functions/activities` | Activity catalog and safe worker guidance |
| **Create state machine** | `#/step-functions/state-machines/create` | Creation wizard |

Machine tabs: `#/step-functions/state-machines/{arn}/overview`, `/definition`, `/executions`, `/tags`. Execution detail: `#/step-functions/executions/{arn}`.

---

## State machines

### State machine catalog

Filterable table (name, type, creation date). **Create state machine** link.

#### How it works in StackSim

Standard JSONPath lifecycle, IAM authorization, tags, revisions, durable executions, `AWS/States` metrics, and bounded CloudFormation/CDK path are active.

---

### Create state machine

| Field | Purpose |
|-------|---------|
| **Name** | State machine identifier |
| **Execution role ARN** | IAM role trusted by `states.amazonaws.com` |
| **Definition** | Visual editor (palette, canvas, inspector) or States Language JSON |
| **Tags (JSON object)** | Labels |

**Visual** mode adds Pass, Task, Choice, Wait, Parallel, Map, Succeed, and Fail states from the palette, selects nodes on the canvas, and edits name, transitions, resources, retries, and catches in the inspector. **JSON** mode edits the same document directly; switching tabs round-trips the definition. **Validate** runs definition checks before create. Task resources include direct/optimized Lambda, DynamoDB `getItem`/`putItem`/`updateItem`/`deleteItem`, SQS `sendMessage` and callback, SNS `publish` and callback, EventBridge `putEvents`, nested `startExecution` request-response/`.sync`/callback, and Activity ARNs.

---

### State machine detail

Tabs: **Overview**, **Definition**, **Executions**, **Tags**.

Header: **Start execution**, **Edit definition**, **Delete**.

#### Overview

ARN, type (Standard), creation date, role ARN, revision ID. **Start execution** modal — optional execution name and JSON input.

#### Definition

Read-only graph of states and transitions; link to **Edit definition** for the local visual editor and JSON authoring (same surface as create). Validation diagnostics on save. Related-resource cards link supported Lambda, DynamoDB, SQS, SNS, EventBridge, nested workflow, and Activity tasks without displaying callback tokens.

## Activities

The Activities page lists name, ARN, and creation time and provides create/delete workflows through the same public Step Functions actions as the SDK. Workers use `GetActivityTask`, `SendTaskHeartbeat`, `SendTaskSuccess`, and `SendTaskFailure`; task assignment, heartbeat deadlines, and completion survive restart. For responsive local shutdown and deterministic tests, an empty `GetActivityTask` poll returns after one second rather than AWS's longer bounded poll. The console deliberately shows only lease-safe guidance—worker names and raw task tokens are never rendered. Nested `.sync` uses local durable execution polling, so its execution role needs `states:StartExecution` on the child state machine and `states:DescribeExecution`/`states:StopExecution` on child execution ARNs; it does not create AWS's managed EventBridge polling rule locally.

#### Executions (on machine)

Table of runs for this machine with status, start/end times, links to inspection view.

#### Tags

JSON editor to add, update, or remove keys.

---

## Executions

### Execution catalog

Account-wide list with status filters and links to machine and execution detail.

### Execution inspection

**Execution overview** — status, name, ARN, input, output, error, start/stop times.

**Graph / States / Events** views — active path highlighting, state configuration (retry/catch), searchable typed history with input/output payloads (256 KiB limits).

Actions: **Stop execution** when RUNNING, **Refresh**.

#### Why use it

Debug workflow logic, retries, and parallel branches without production logging.

#### How it works in StackSim

Complete paginated history, nested branch summaries, immutable definition snapshots per execution, 90-day default retention, restart recovery.

#### Example input

```json
{"orderId": "123", "amount": 49.99}
```

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Workflow type | Standard JSONPath only |
| Task integrations | Lambda; DynamoDB item CRUD; SQS send/callback; SNS publish/callback; EventBridge put-events; nested workflows; Activities |
| Callback recovery | Opaque single-use token digests, heartbeat/timeout deadlines, restart-safe resume |
| Express / JSONata | Unavailable |
| Versions / aliases / redrive | Unavailable |
| AWS SDK / HTTP / cross-account tasks | Unavailable and rejected before admission |
| Logging / X-Ray | Unavailable |
| Payload limit | 256 KiB per field |

---

## Related StackSim docs

- [Lambda console guide](./lambda-console-guide.md) — Task state targets
- [IAM console guide](./iam-console-guide.md) — execution roles and `iam:PassRole`
- [EventBridge console guide](./eventbridge-console-guide.md) — Scheduler Step Functions targets
- [CloudWatch console guide](./cloudwatch-console-guide.md) — `AWS/States` metrics
- [CloudFormation console guide](./cloudformation-console-guide.md) — state machine stacks
- [SQS console guide](./sqs-console-guide.md) — workflow handoff to queues
- [DynamoDB console guide](./dynamodb-console-guide.md) — orchestrate table workflows
- [Developer guide](./developer-guide.md) — workflow patterns
