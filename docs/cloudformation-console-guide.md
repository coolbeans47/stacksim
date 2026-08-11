# StackSim CloudFormation console guide

This guide explains every panel in the StackSim CloudFormation console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS CloudFormation behavior.

StackSim models stack lifecycle, nested stacks, supported resource providers, parameters, outputs, exports, change sets, rollback, and CDK deployment locally. StackSets, drift detection, resource import, and unsupported resource types remain unavailable.

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
| **Stacks** | `#/cloudformation/stacks` | Stack catalog |
| **Exports** | `#/cloudformation/exports` | Cross-stack export values |
| **Local CDK setup** | `#/cloudformation/setup` | Endpoint and bootstrap guidance |

Stack detail: `#/cloudformation/stacks/{name}` with tabs for **Overview**, **Resources**, **Outputs**, **Parameters**, **Template**, **Change sets**, **Tags**, **Events**. Change set detail: `.../change-sets/{changeSetName}`.

---

## Stacks

### Stack catalog

Filterable table: name, status, created, updated. Filter by status.

#### How it works in StackSim

Durable lifecycle, nested stacks, supported providers, dependencies, conditions, parameters, outputs, exports, rollback, retention policies, change sets, and CDK deployments are active.

---

### Stack detail — Overview

Stack status, status reason, description, termination protection, disable rollback, role ARN, notification ARNs, capabilities, active operation, parent/child hierarchy.

Header actions: **Refresh**, **Update**, **Enable/disable termination protection**, **Roll back** / **Continue update rollback**, **Delete** / **Retry delete**.

---

### Resources tab

Logical ID, type, status, physical ID, module — links to related consoles when supported.

---

### Outputs tab

Export name, output key, value, description.

---

### Parameters tab

Parameter key, value, resolved value, previous value (on updates).

---

### Template tab

**Original** vs **Processed** template JSON (selector). Editor accepts JSON templates used by supported profile.

---

### Change sets tab

List with **Create change set**. Detail shows **Changes** table (action, logical ID, replacement, details), **Execute**, **Delete**.

Create/update modals: template JSON, parameter overrides JSON, capabilities list, on-failure behavior.

---

### Tags tab

Stack-level tags from last operation.

---

### Events tab

Chronological audit with optional **Operation ID** filter.

---

### Update stack (modal)

Template body JSON, parameter overrides, capabilities — applies immediately (no separate change set required from console).

---

## Exports

Route: `#/cloudformation/exports` and `#/cloudformation/exports/{name}`.

Table of export names, exporting stack, value. Cross-stack `Fn::ImportValue` reference.

---

## Local CDK setup

Route: `#/cloudformation/setup`.

### Environment card

Control endpoint, Region, account, auth mode, reduced bootstrap status.

### Bootstrap details

Owner, compatibility version, qualifier, SSM version parameter, file asset bucket (link to S3), asset count and size.

### Bootstrap roles

Lookup, publishing, deployment, CloudFormation execution roles. Image publishing role present; ECR publication blocked.

### Shell snippets

Copy-ready PowerShell and POSIX `export` blocks for `AWS_ENDPOINT_URL`, credentials, Region, `npx cdk deploy`.

#### Why use it

Point CDK and AWS SDKs at StackSim without running full `cdk bootstrap`.

#### How it works in StackSim

Automatic reduced bootstrap creates file-asset bucket and roles by default (`STACKSIM_CDK_BOOTSTRAP=false` disables). Do not deploy the full AWS bootstrap template locally.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Template format | JSON in console |
| YAML editing | Unavailable in console |
| Drift / import | Unavailable |
| StackSets | Unavailable |
| Supported providers | Documented subset per release |
| Nested stacks | Active |
| DELETE_FAILED | Retry with retain/force options |

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — CDK deploy walkthrough
- [S3 console guide](./s3-console-guide.md) — CDK asset bucket
- [IAM console guide](./iam-console-guide.md) — deployment and execution roles
- [Lambda console guide](./lambda-console-guide.md) — common stack resource
- [DynamoDB console guide](./dynamodb-console-guide.md) — tables created by stacks
- [API Gateway console guide](./apigateway-console-guide.md) — APIs from the same deploy
- [SNS console guide](./sns-console-guide.md) — stack notification topics
- [Reference](./reference.md) — CloudFormation API summary
