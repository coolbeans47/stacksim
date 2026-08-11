# StackSim Parameter Store console guide

This guide explains every panel in the StackSim Parameter Store console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Systems Manager Parameter Store behavior.

StackSim implements the **Parameter Store** portion of Systems Manager only — not Patch Manager, Run Command, Session Manager, or other SSM features. Where local behavior differs from AWS (for example KMS encryption or Advanced tier), those boundaries are called out explicitly.

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

The Parameter Store console lives under **Systems Manager** in the StackSim service list:

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Parameter Store** | `#/systems-manager/parameter-store` | List and open parameters |
| **Create parameter** | `#/systems-manager/parameter-store/create` | Create a new Standard-tier parameter |

Opening a parameter navigates to `#/systems-manager/parameter-store/parameter/{name}` with **Overview**, **Value**, **History and labels**, and **Tags** panels.

The console uses the same SSM API as the AWS SDK and CLI (`@aws-sdk/client-ssm`, `aws ssm ...`). List views never include parameter values.

---

## Parameter Store (list)

### What it is

The **Parameter Store** landing page lists every parameter in the current account and Region with name, type, tier, version number, and last modified time. An info banner explains the local SecureString encryption boundary. **Create parameter** opens the creation form; **Refresh** reloads the list. A filter box searches by name, type, and description.

### Why use it

Parameter Store centralizes configuration so applications read settings at runtime instead of baking environment-specific values into code or container images. The list view confirms deploys created expected names and shows which values are secrets (`SecureString`) versus plain text.

### How it works in StackSim

Standard `String`, `StringList`, and `SecureString` parameters, hierarchical names, descriptions, versions, filtering, pagination, tags, IAM authorization, and same-account single-Region persistence are active locally.

Paginated version history, version labels, Advanced tiers and policies, and the rest of Systems Manager are handled separately: history and labels are active, while Advanced tiers/policies and non-Parameter Store Systems Manager remain unavailable. Values are omitted from this list — open a parameter and use an explicit reveal action to read one.

Parameters owned by the reduced CDK bootstrap show a **Simulator managed** badge. Parameters created by `AWS::SSM::Parameter` show a linked **CloudFormation managed** badge that opens the owning stack's Resources tab.

### Common AWS use cases

- `/my-app/prod/database/host` — connection endpoint per environment.
- `/my-app/prod/features` — comma-separated feature flags (`StringList`).
- `/my-app/prod/api/key` — API credential as `SecureString`.

#### Example

After CDK deploy, filter for `/notes-api/` and confirm `String` parameters for table names and a `SecureString` for signing material appear with incrementing version numbers after updates.

---

## Create parameter

### Parameter configuration

#### What it is

The **Create parameter** page collects:

| Field | Purpose |
|-------|---------|
| **Name** | Hierarchical path such as `/app/dev/database/host` |
| **Type** | `String`, `StringList`, or `SecureString` |
| **Data type** | `text` (only supported data type locally) |
| **Value** | Initial parameter value |
| **Description** | Optional documentation (up to 1024 characters) |
| **Allowed pattern** | Optional regular expression validated on write |
| **Tags (JSON object)** | Key-value labels applied at creation |

**Cancel** returns to the list. **Create parameter** calls `PutParameter` and navigates to the new parameter detail page.

#### Why use it

Creating parameters through the console is the fastest way to seed local configuration before wiring an application or CDK stack. Hierarchical names group related settings (`/app/dev/...`, `/app/prod/...`).

#### How it works in StackSim

This editor creates **Standard-tier** parameters with the **text** data type. Descriptions, allowed patterns, and initial tags are supported.

`SecureString` values use installation-local **AES-256-GCM** protection — not AWS KMS. Omit `KeyId`; explicit customer-managed KMS keys are unavailable. Secure values remain in browser memory only until the signed `PutParameter` request completes.

Tags can only be specified at creation through the API; the create form supplies them in the initial request. After creation, edit tags on the detail page.

Advanced and Intelligent-Tiering parameters, non-text data types, and parameter policies are unavailable.

#### Common AWS use cases

- Non-secret config — database hostname, feature toggle list, queue URL.
- Secret config — database password, OAuth client secret, signing key.
- Tagged resources — `{"Environment":"dev","Application":"billing"}` for IAM condition keys.

#### Example

Local database connection settings:

```text
Name:            /billing/dev/database/host
Type:            String
Value:           127.0.0.1
Description:     Local Postgres host for billing service
Allowed pattern: (leave empty)
Tags:            {"environment":"dev","service":"billing"}
```

Secure credential:

```text
Name:            /billing/dev/database/password
Type:            SecureString
Value:           (your local password)
Description:     Database password — never logged by the console list
```

---

## Parameter detail

### Overview

#### What it is

The **Overview** panel on a parameter detail page shows type, tier, current version, data type, last modified time, and description. The page header includes the parameter name, optional **Simulator managed** subtitle, **Back**, **Edit value**, and **Delete** actions.

Protected parameters display a **Protected resource** alert and hide mutation controls.

#### Why use it

Operators verify metadata before changing values or debugging applications that read the wrong version. Version numbers increase on every successful overwrite.

#### How it works in StackSim

Overview fields come from `DescribeParameters`. CloudFormation-owned parameters show a protected alert and **View owning stack** link; edit, label, tag, and delete controls are hidden, and equivalent public API mutations are rejected.

The CDK bootstrap parameter `/cdk-bootstrap/hnb659fds/version` is simulator-managed: overwrite, tag mutation, and deletion are disabled in the console and API.

---

### Value

#### What it is

The **Value** panel shows a masked placeholder (`••••••••`) until you click **Reveal value** or **Decrypt and reveal** (for `SecureString`). A hint explains that the console fetches values only after explicit action and clears them when you leave or refresh.

**Edit value** (non-protected parameters) opens a modal with new value, description, and allowed pattern. Saving publishes a new numbered version via `PutParameter` with `Overwrite: true`.

#### Why use it

Secrets and configuration should not appear in list views or page loads by default. Explicit reveal mirrors AWS console behavior and reduces accidental exposure in screenshots or shoulder surfing.

#### How it works in StackSim

Explicit reads, SecureString decryption, exact numeric-version reads through the API, overwrite validation, and durable numbered versions are active.

Secure values decrypt only into page memory and are cleared on navigation or refresh. The console never persists revealed values in browser storage.

AWS KMS integration remains unavailable. Exact numeric and labeled reads are available through the API; the **History and labels** panel provides the safe console workflow for older versions.

#### Common AWS use cases

- Confirm the deployed value matches expectations after a pipeline run.
- Rotate a secret by editing value (creates version N+1).
- Validate `StringList` comma-separated entries.

#### Example

Read a SecureString locally:

1. Open `/my-app/dev/api/token`.
2. Click **Decrypt and reveal**.
3. Copy the value for a one-time test.
4. Navigate away — the value is cleared from the page.

Update with allowed pattern:

```text
Allowed pattern: ^[A-Za-z0-9_-]{32,64}$
New value:       (must match pattern or PutParameter fails)
```

---

### Edit parameter value (modal)

#### What it is

Modal fields: **New value**, **Description**, **Allowed pattern**. **Save new version** overwrites the current version.

#### Why use it

Configuration changes without deleting and recreating the parameter name — existing applications keep the same `GetParameter` name while receiving the new value on next read.

#### How it works in StackSim

Parameter type cannot change during overwrite. Each save increments the version (up to 100 retained versions per parameter). Allowed pattern validation runs on the new value.

---

### History and labels

#### What it is

**Inspect history** loads paginated version metadata through `GetParameterHistory`. Values stay masked until **Reveal** is selected for one row. **Manage labels** adds, moves, or removes labels without changing the stored value.

#### Why use it

Labels provide a stable selector such as `:stable` or `:candidate` while new numbered versions are published. History lets an operator inspect the exact version timeline before moving a label or rolling an application back.

#### How it works in StackSim

History is newest-first and paginated. A reveal uses the official history action, decrypts only when explicitly requested, stays in page memory, and clears after 60 seconds or navigation. Labels are case-sensitive, one label points to one version, each version can have at most ten labels, and moving or removing labels is atomic. A label never falls back to the current version. If version 1 is still the oldest retained version and carries a label, publishing version 101 fails until the label is moved or removed.

The simulator-managed bootstrap parameter remains read-only and has no label controls.

---

### Tags

#### What it is

The **Tags** panel displays tags as formatted JSON. **Edit tags** (non-protected parameters) opens a modal with a JSON object editor.

#### Why use it

Tags organize parameters by environment, owner, or cost center. IAM policies can require tags such as `Environment=prod` for `ssm:GetParameter` access.

#### How it works in StackSim

Creating, listing, adding, replacing, and removing parameter tags, persistence, validation, and supported resource-tag authorization conditions are active locally.

Saving tags computes additions and removals and calls `AddTagsToResource` / `RemoveTagsFromResource`. AWS billing allocation, Organizations tag policies, and account-wide governance are outside StackSim.

#### Common AWS use cases

- `Owner=platform-team` for access control.
- `CostCenter=1234` for chargeback reporting in AWS (reference-only locally).

#### Example

```json
{
  "environment": "dev",
  "application": "orders-api",
  "owner": "platform"
}
```

---

### Delete parameter

#### What it is

**Delete** on the detail page prompts for confirmation. The dialog notes that deletion starts a **30-second same-name recreation delay**.

#### Why use it

Remove obsolete configuration and secrets when decommissioning environments or rotating naming conventions.

#### How it works in StackSim

`DeleteParameter` removes the parameter immediately from reads. A tombstone blocks recreating the same name for 30 seconds (unless CloudFormation ownership rules apply). Simulator-managed bootstrap parameters cannot be deleted.

CloudFormation-owned parameters reject public deletion through the API.

---

## Parameter types reference

| Type | Stored as | Typical use | Decryption |
|------|-----------|-------------|------------|
| **String** | Plain text | Hostnames, URLs, single flags | Not applicable |
| **StringList** | Comma-separated text | Feature lists, CIDR allow lists | Not applicable |
| **SecureString** | Encrypted material | Passwords, API keys, tokens | `WithDecryption=true` on read |

`StringList` values are normalized and validated as comma-separated lists on write.

---

## Hierarchical names

Parameter Store supports path-style names for organization and bulk retrieval:

```text
/app/
/app/dev/
/app/dev/database/host
/app/dev/database/port
/app/prod/database/host
```

In AWS and StackSim, `GetParametersByPath` with path `/app/dev/` returns parameters under that prefix. The console list shows all parameters; hierarchy filtering is API-driven.

Naming rules locally:

- Names are canonicalized with a leading `/`.
- Maximum name length is 2048 bytes.
- Use paths to separate environments and applications without separate accounts.

---

## Simulator-managed bootstrap parameter

### What it is

When CDK bootstrap is enabled, StackSim creates `/cdk-bootstrap/hnb659fds/version` as a **String** parameter recording the bootstrap compatibility version. The list marks it **Simulator managed**; the detail page shows **Protected resource**.

### Why use it

The AWS CDK bootstrap stack stores its version in Parameter Store so tooling can detect compatible bootstrap stacks. StackSim mirrors that contract for local CDK workflows.

### How it works in StackSim

Public overwrite, tag mutation, and deletion are disabled. The value is readable through the console reveal action and through `GetParameter` like any other parameter. One authoritative record serves the SDK, CDK CLI, bootstrap manager, and CloudFormation resolver.

---

## API operations (outside the console)

These SSM actions work through the SDK and CLI; the detail console also uses the history and label actions where noted:

| Action | Purpose |
|--------|---------|
| **GetParameter** | Read one parameter; optional `:version` or `:label` suffix |
| **GetParameters** | Batch read up to 10 names |
| **GetParametersByPath** | Hierarchical read with optional recursion and decryption |
| **PutParameter** | Create or overwrite |
| **DeleteParameter** / **DeleteParameters** | Remove one or many |
| **DescribeParameters** | Filter and paginate metadata |
| **GetParameterHistory** | Paginate metadata and explicitly reveal exact historical values |
| **LabelParameterVersion** / **UnlabelParameterVersion** | Add, atomically move, or remove version labels |
| **AddTagsToResource** / **RemoveTagsFromResource** / **ListTagsForResource** | Tag lifecycle |

See [Developer guide](./developer-guide.md), [Reference](./reference.md), and [AWS CLI cookbook](./aws-cli-cookbook.md) for examples.

---

## IAM and ownership

Parameter Store requests evaluate IAM identity policies with SSM actions (`ssm:GetParameter`, `ssm:PutParameter`, etc.) and supported tag conditions. Explicit deny wins.

Additional ownership rules:

- **Simulator-managed** — bootstrap parameter is read-only for public mutation.
- **CloudFormation-owned** — stack resources may block public overwrite or delete.

The console uses the same authorization path as SDK requests when StackSim auth is enabled.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Systems Manager (non–Parameter Store) | Unavailable |
| Parameter tier | Standard only |
| Data type | `text` only |
| SecureString encryption | Installation-local AES-256-GCM; not KMS |
| Explicit `KeyId` / customer KMS | Rejected — omit `KeyId` |
| Advanced tier / parameter policies | Unavailable |
| Parameter history / version labels | Active in the detail console and official APIs; reveals are explicit and ephemeral |
| Max versions retained | 100 per parameter |
| Delete tombstone | 30-second recreation delay for same name |
| List view values | Never shown |
| Console value reveal | Memory only; cleared on leave/refresh |
| CDK bootstrap parameter | Protected; simulator-managed |
| Cross-Region parameters | Same-account single-Region persistence |
| Secrets Manager | Separate service (not this console) |

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — application configuration patterns
- [IAM console guide](./iam-console-guide.md) — identities, roles, and parameter access policies
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — credentials vs configuration parameters
- [EventBridge console guide](./eventbridge-console-guide.md) — scheduled jobs reading parameters
- [Reference](./reference.md) — SSM endpoint and Parameter Store summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — `aws ssm` examples
- [API Gateway console guide](./apigateway-console-guide.md) — APIs that read parameters at runtime
- [Cognito console guide](./cognito-console-guide.md) — auth configuration stored separately from Parameter Store
- [DynamoDB console guide](./dynamodb-console-guide.md) — table names often sourced from parameters
- [S3 console guide](./s3-console-guide.md) — bucket names and paths in hierarchical parameters
- [SQS console guide](./sqs-console-guide.md) — queue URLs and worker configuration in parameters
- [SES console guide](./ses-console-guide.md) — sender and template names in application config
- [SNS console guide](./sns-console-guide.md) — topic ARNs in application configuration
- [Lambda console guide](./lambda-console-guide.md) — environment variables and runtime config
- [CloudFormation console guide](./cloudformation-console-guide.md) — stack parameters
