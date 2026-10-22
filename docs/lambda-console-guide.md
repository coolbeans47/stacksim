# StackSim Lambda console guide

This guide explains every panel in the StackSim Lambda console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Lambda behavior.

StackSim models function lifecycle, inline and ZIP code, container images (opt-in: a local Docker socket resolves and invokes, an OCI layout only creates and pins; see [the reference](reference.md#container-image-functions)), layers, aliases, versions, provisioned and reserved concurrency, function URLs, asynchronous invocation, DynamoDB event source mappings, durable execution, and resource policies locally. Supported Node.js ZIP functions use bounded warm execution-environment pools. VPC ENIs, EFS mounts, ECR pulls, X-Ray segments, and many trigger types remain configuration-only or unavailable.

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

Table of name, description, package type, runtime, architecture, and last modified. Text search plus **Runtime**, **Architecture**, and **Package type** filters narrow the list in the browser (`ListFunctions` has no filter parameters, so the AWS console filters client-side too). **Create function**, **Refresh**.

### Create function (modal)

| Field | Purpose |
|-------|---------|
| **Package type** | Zip or Container image. With an OCI layout source the notice says the image is **create and pin only**: creation and digest pinning work, invocation fails until `STACKSIM_LAMBDA_DOCKER_SOCKET` provides an executor |
| **Name** | Function identifier |
| **Runtime / Handler** | Zip: Node.js 18/20/22/24, handler path. Python, Java, .NET, Go, Ruby, and custom runtimes are intentionally unsupported for now; `CreateFunction` rejects them |
| **Architecture** | x86_64 or arm64 (`Architectures`); pure JavaScript runs on either locally |
| **Image URI** | Container: an ECR-shaped reference resolved on the local Docker socket (invokable) or OCI layout (create and pin only); the console reports whether the pinned digest is a repository digest or only a local image ID |
| **Code** | **Write code** (ES module code becomes `index.mjs`, CommonJS code becomes `index.js`) or **Upload .zip** |
| **Execution role** | **Create a new role with basic Lambda permissions** (default, like AWS: `<name>-role-<id>` with `AWSLambdaBasicExecutionRole`, created through the public IAM `CreateRole`/`AttachRolePolicy` actions so it appears in the IAM console) or **Use an existing role** that trusts `lambda.amazonaws.com` |
| **Capacity provider** | Optional Managed Instances assignment |
| **Durable execution** | Optional checkpointing toggle. Rejected together with a container image: the container cannot reach the local checkpoint endpoint |
| **Advanced settings** | **Enable function URL** (auth type, invoke mode, optional CORS; `NONE` also adds the two public resource-policy statements) and **Tags** (`CreateFunction.Tags`) |

---

## Function detail

Header: **View logs** (CloudWatch), **Delete**, **Test**.

Tabs: **Code**, **Test**, **Monitor**, **Configuration**, **Durable executions** *(if enabled)*, **Aliases**, **Versions**.

### Code tab

**Function overview** — ARN, runtime, handler, architecture, state, durable flag.

**Code source** *(every Zip function up to 3 MB, as in the AWS console)* — the editor opens the handler's file (`index.mjs`, `index.js`, or `index.cjs` for `index.handler`) read out of the stored deployment package, so functions created from the CLI, CloudFormation, SAM, or a ZIP upload can be edited too. ES module and CommonJS exports are both accepted. Editing shows **Changes not deployed**; **Deploy** repackages the edited file with the rest of the archive and calls `UpdateFunctionCode`; **Discard changes** restores the stored source. **Upload from .zip file** and **Upload from Amazon S3** (`S3Bucket`/`S3Key`/`S3ObjectVersion`) replace the whole package. Packages larger than 3 MB and image functions get the upload actions only.

**Triggers** — one list, as in AWS: DynamoDB stream and SQS event source mappings (batch, window, filter, enable/disable, edit, delete), API Gateway permission statements, S3 bucket notification entries, EventBridge rules that target the function, and SNS subscriptions. **Add trigger** offers API Gateway, S3, EventBridge (event pattern or schedule), SNS, SQS, and DynamoDB. Each service trigger calls that service's public API and adds the matching `lambda:InvokeFunction` statement: S3 → `AddPermission` for `s3.amazonaws.com` scoped to the bucket ARN and account, then `PutBucketNotificationConfiguration`; EventBridge → `PutRule`, `PutTargets`, `AddPermission` for `events.amazonaws.com` scoped to the rule ARN; SNS → `AddPermission` for `sns.amazonaws.com`, then `Subscribe` (protocol `lambda`). Delete removes the notification entry, the rule target, or the subscription; the permission statement stays and can be removed under Configuration → Permissions.

**Code properties** / **Container image** — package metadata (including the handler file the editor looks for), deploy new image.

#### How it works in StackSim

Every trigger type above is active locally: S3 delivers object events asynchronously, EventBridge rules match or fire on schedule, SNS publishes to the subscribed function, and stream/queue mappings poll. CDK's `bucket.addEventNotification(…, new LambdaDestination(fn))` and `S3EventSource` deploy through the native `Custom::S3BucketNotifications` provider and appear in the same list.

### Test tab

**Test event** — **Saved events** (up to ten named events per function in browser localStorage, like the AWS console's private test events), event name, invocation type (Sync/Async), qualifier and execution name *(durable)*, **Event template** (Custom, hello-world, API Gateway REST v1 and HTTP API 2.0, S3 Put, SQS, SNS, DynamoDB Update, EventBridge Scheduled Event, Function URL request — the AWS sample events), JSON payload. **Save event**, **Delete event**, **Test**.

**Execution result** — status, then the summary parsed from the log tail's `REPORT` line: request ID, duration, billed duration, memory size, max memory used, init duration (cold start) and, on a timeout, status and error type; response; log output; durable execution link. Asynchronous tests report **Queued** with the request ID.

In the log tail, **Memory Size** is the configured allocation. **Max Memory Used** is Node ZIP worker lifetime peak RSS, including initialization and earlier warm calls, excluding child processes. It can stay high across warm calls after an allocation is freed. It is not an enforced memory limit. The text REPORT prints it rounded to whole MB like AWS and omits it after a worker exit/timeout or when the host cannot measure; JSON reports omit the numeric usage field and include a status/reason. A cold start adds `Init Duration`; a timeout adds `Status: timeout`. Image peak memory is unavailable separately from Docker's requested memory and scratch limits. ZIP memory and scratch sizes are descriptor-only. General configuration explains this boundary; [the reference](reference.md#learning-measurements-and-permission-explanations) defines the measurement.

### Monitor tab

**Asynchronous invocation queue** — queued/leased events table.

**Function metrics** — the AWS graph set, one graph per metric: **Invocations**, **Duration (ms)** (minimum/average/maximum), **Error count and success rate** (success rate is derived per period as 100 × (1 − errors ÷ invocations)), **Throttles**, **Async delivery failures** (dropped/retried/queued), **Concurrent executions**, and **Provisioned concurrency**. A **1h / 3h / 12h / 1d / 3d** range picker chooses the window (60-, 300-, or 900-second periods); link to CloudWatch.

**Recent invocation logs** — tail with link to log group.

### Configuration tab

Cards (each with **Edit** where noted). Each card loads independently: if one request fails the card shows the error inline and the rest of the tab still renders.

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
| Permissions | Resource policy statements with principal, action, and conditions; **View** shows the statement JSON, **Delete** removes it (`RemovePermission`). **Add permission** takes the action, a service principal, account, IAM ARN, or `*`, source ARN, source account, and principal organization ID |
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
| Runtimes | Node.js 18, 20, 22, and 24 ZIP functions run locally; container images run through the opt-in Docker executor. Python and every other managed or custom runtime are intentionally unsupported for now: `CreateFunction` and `UpdateFunctionConfiguration` reject them (the only python3.13 functions are the never-invoked CDK helper resources CloudFormation creates) |
| Triggers | API Gateway, S3, EventBridge, SNS, SQS, and DynamoDB streams from **Add trigger**, all backed by the local services |
| VPC / EFS | Configuration only |
| X-Ray | Mode stored; no segments |
| Async destinations | Lambda, SQS, SNS, EventBridge, and S3 (OnFailure) active and selectable from the Asynchronous invocation card; the execution role needs the matching send/publish/put permission in enforce mode |
| IAM calls | The console lists and creates execution roles through the public IAM Query API (`ListRoles`, `CreateRole`, `AttachRolePolicy`); the async queue diagnostics under Monitor use the private `/_stacksim/api/lambda/async` route because AWS has no equivalent |
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
