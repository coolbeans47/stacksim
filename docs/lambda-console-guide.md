# StackSim Lambda console guide

This guide explains every panel in the StackSim Lambda console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Lambda behavior.

StackSim models function lifecycle, inline and ZIP code, container images (local source), layers, aliases, versions, provisioned and reserved concurrency, function URLs, asynchronous invocation, DynamoDB event source mappings, durable execution, and resource policies locally. Supported Node.js ZIP functions use bounded warm execution-environment pools. VPC ENIs, EFS mounts, ECR pulls, X-Ray segments, and many trigger types remain configuration-only or unavailable.

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
| **Overview** | `#/lambda` | Regional summary |
| **Functions** | `#/lambda/functions` | Function catalog |
| **Capacity providers** | `#/lambda/capacity-providers` | Managed Instances profiles |
| **Layers** | `#/lambda/layers` | Shared layer versions |

Function tabs: `#/lambda/functions/{name}/overview`, `/test`, `/monitor`, `/configuration`, `/durable-executions`, `/aliases`, `/versions`.

---

## Overview

Cards for function count and **Getting started** with **Create function**.

---

## Functions

### Function catalog

Filterable table: name, description, runtime, last modified. **Create function**, **Refresh**.

### Create function (modal)

| Field | Purpose |
|-------|---------|
| **Package type** | Zip or Container image |
| **Name** | Function identifier |
| **Runtime / Handler** | Zip: nodejs22.x, handler path |
| **Image URI** | Container: local/OCI source |
| **Code** | Inline editor or ZIP upload |
| **Execution role** | IAM role with `lambda.amazonaws.com` trust |
| **Capacity provider** | Optional Managed Instances assignment |
| **Durable execution** | Optional checkpointing toggle |

---

## Function detail

Header: **View logs** (CloudWatch), **Delete**, **Test**.

Tabs: **Code**, **Test**, **Monitor**, **Configuration**, **Durable executions** *(if enabled)*, **Aliases**, **Versions**.

### Code tab

**Function overview** — ARN, runtime, handler, architecture, state, durable flag.

**Code source** *(Zip inline)* — JavaScript editor, **Save**, **Discard**.

**Triggers** — DynamoDB stream event source mappings: batch, window, filter, enable/disable, delete. **Add trigger** opens mapping form.

**S3 bucket notifications** — read-only inventory of buckets targeting this function.

**Code properties** / **Container image** — package metadata, deploy new image.

#### How it works in StackSim

DynamoDB stream triggers are fully supported. S3 notifications are configured from S3 console; other trigger types are not available from this panel.

### Test tab

**Test event** — name (browser localStorage), invocation type (Sync/Async), qualifier and execution name *(durable)*, template (Custom / API Gateway proxy), JSON payload. **Save event**, **Test**.

**Execution result** — status, duration, response, log tail, durable execution link.

### Monitor tab

**Asynchronous invocation queue** — queued/leased events table.

**Function metrics** — invocations, errors, duration, concurrency charts; link to CloudWatch.

**Recent invocation logs** — tail with link to log group.

### Configuration tab

Cards (each with **Edit** where noted):

| Card | Key settings |
|------|----------------|
| General | Description, memory, timeout, role, handler |
| Durable execution | Timeout, retention, KMS ARN *(descriptor)* |
| Capacity provider | Provider assignment, memory/vCPU, scaling |
| Container image | Entry point, command, working directory |
| Runtime settings | Architecture, ephemeral storage, update mode |
| Monitoring | Log group, JSON logs, log levels, X-Ray mode *(stored only)* |
| VPC | Subnets, security groups *(stored only)* |
| File systems | EFS access point *(stored only)* |
| Code signing | Config association *(Warn/Enforce without Signer)* |
| Recursive loop detection | Terminate at depth 16 / Allow |
| Environment encryption | KMS ARN *(stored only)* |
| Function URL | Auth, CORS, invoke mode, qualifier |
| Layers | Up to five layer ARNs, reorder |
| Concurrency | Reserved limit, provisioned configs |
| Async invocation | Retries, age, destinations, DLQ |
| Permissions | Resource policy statements |
| Tags | Key-value labels |
| Environment variables | JSON editor |

### Durable executions tab

Filters and table of execution name, status, times. Detail view: overview, input/result/error, ordered history, **Stop execution**.

### Aliases tab

Create/edit aliases with version weights, provisioned concurrency per alias.

### Versions tab

Publish versions, compare configuration, provisioned concurrency, delete (dependency-aware).

---

## Capacity providers

### List

Control-plane warning: no EC2/ENI/EBS/networking fabricated.

### Detail

Overview, VPC/telemetry descriptors, attached function versions. **Edit**, **Manage tags**, **Delete**.

---

## Layers

### List / create / publish

ZIP upload with compatible runtimes and architectures.

### Version detail

Size, license, **Permissions** resource policy, **Delete**.

#### How it works in StackSim

Layers merge under `/opt` in invocation order during local runs.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Runtimes | Node.js primary; container local executor |
| Triggers | DynamoDB streams; SQS via separate console |
| VPC / EFS | Configuration only |
| X-Ray | Mode stored; no segments |
| Async destinations | Lambda, SQS, EventBridge active; SNS/S3 blocked |
| Function URL | Local HTTP endpoint |
| Warm reuse | Sequential Node ZIP invokes may reuse module state, client singletons, private `/tmp`, and one log stream; concurrent invokes lease separate workers. Code/config changes, crash, timeout, idle expiry, shutdown, and restart cold-start replacements. |
| Provisioned concurrency | `READY` means the requested Node ZIP workers have completed module initialization. Image-function provisioned concurrency is rejected until reusable/prewarmed containers exist. |
| Recursion | Lineage depth 16 when Terminate |
| Capacity providers | Control plane only |

---

## Related StackSim docs

- [IAM console guide](./iam-console-guide.md) — execution roles and resource policies
- [CloudWatch console guide](./cloudwatch-console-guide.md) — logs and metrics
- [DynamoDB console guide](./dynamodb-console-guide.md) — stream triggers
- [S3 console guide](./s3-console-guide.md) — bucket notifications
- [SQS console guide](./sqs-console-guide.md) — event source mappings and async DLQ
- [EventBridge console guide](./eventbridge-console-guide.md) — async destinations
- [API Gateway console guide](./apigateway-console-guide.md) — proxy test events
- [Step Functions console guide](./step-functions-console-guide.md) — Lambda tasks
- [SNS console guide](./sns-console-guide.md) — Lambda subscriptions
- [CloudFormation console guide](./cloudformation-console-guide.md) — function stacks
- [RDS console guide](./rds-console-guide.md) — SQL from Lambda handlers
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — runtime secret retrieval
- [Parameter Store console guide](./parameter-store-console-guide.md) — configuration in environment
- [Developer guide](./developer-guide.md) — serverless patterns
- [Reference](./reference.md) — Lambda API summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — Lambda CLI examples
