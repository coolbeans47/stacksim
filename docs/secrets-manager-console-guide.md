# StackSim Secrets Manager console guide

This guide explains every panel in the StackSim Secrets Manager console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Secrets Manager behavior.

StackSim models secret lifecycle, encrypted values, current/previous/custom stages, configured-account identity resource policies, tags, and recovery-window deletion locally. Where local behavior differs from AWS (for example KMS or automatic rotation), those boundaries are called out explicitly.

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

The Secrets Manager service in StackSim has a left navigation bar with:

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Secrets** | `#/secrets-manager/secrets` | List and open secrets |
| **Create secret** | `#/secrets-manager/secrets/create` | Store a new secret |

Opening a secret navigates to `#/secrets-manager/secrets/secret/{name}` with **Overview**, **Secret value**, **Versions**, **Resource permissions**, and **Tags** panels.

The console uses the same Secrets Manager API as the AWS SDK and CLI (`@aws-sdk/client-secrets-manager`). List views never fetch secret values.

---

## Secrets (list)

### Secret catalog

#### What it is

The **Secrets** landing page lists every secret with name, description, version count, and last changed date. Secrets scheduled for deletion show a **Pending deletion** badge. **Store a new secret** opens the creation form. A filter box searches names and descriptions.

An info banner explains the local encryption boundary: installation-local AES-256-GCM, not KMS.

#### Why use it

Secrets Manager centralizes credentials and tokens so applications retrieve them at runtime instead of embedding sensitive material in code, environment files, or Parameter Store plaintext.

#### How it works in StackSim

Same-account, single-Region secret lifecycle, encrypted string and binary values, automatic versions, tags, filtering, pagination, IAM authorization, generated passwords through the API, and recovery-window deletion are active locally.

Batch reads, custom staging labels, configured-account identity resource policies, and the closed `AWS::SecretsManager::Secret`/`ResourcePolicy` providers are active. Customer KMS keys, automatic rotation, replication, rotation schedules/target attachments, and the complete AWS catalog remain unavailable — see local environment notes.

Values are never fetched for this list. CloudFormation-owned secrets and resource policies show a linked **CloudFormation managed** badge.

#### Common AWS use cases

- `prod/database/credentials` — JSON username/password for RDS.
- `api/oauth/client-secret` — third-party API credential.
- `signing/key` — HMAC or JWT signing material.

#### Example

After publishing a newer value, filter for `database` and confirm the secret exists with the expected version count.

---

## Store a new secret

### Secret configuration

#### What it is

The **Store a new secret** page collects:

| Field | Purpose |
|-------|---------|
| **Name** | Stable secret identifier (for example `app/database/credentials`) |
| **Secret value** | Initial plaintext (optional — metadata-only secret if empty) |
| **Description** | Human-readable summary |
| **Tags (JSON object)** | Key-value labels at creation |

**Cancel** returns to the list. **Store secret** calls `CreateSecret` and navigates to the detail page.

#### Why use it

Creating secrets through the console seeds local development credentials before wiring Lambda, ECS, or application code to `GetSecretValue`.

#### How it works in StackSim

This editor creates locally encrypted **SecretString** values or metadata-only secrets with descriptions and initial tags.

`SecretBinary` and `GetRandomPassword` are supported through the compatible SDK, but this form does not enter binary data or generate a password. Explicit KMS keys, replicas, and automatic rotation are unavailable. Resource policies are managed after creation.

When a value is supplied, a client request token accompanies creation for idempotency.

#### Common AWS use cases

- Store JSON database credentials: `{"username":"app","password":"..."}`.
- Create metadata-only secret, then publish value via CI/CD `PutSecretValue`.
- Tag with `{"Environment":"dev","Application":"billing"}`.

#### Example

```text
Name:        local/postgres/credentials
Value:       {"username":"app","password":"local-dev-password","host":"127.0.0.1"}
Description: Postgres credentials for local billing service
Tags:        {"environment":"dev"}
```

---

## Secret detail

### Overview

#### What it is

The **Overview** panel shows ARN, description, created date, and last changed date. Header actions depend on deletion state:

- **Active:** Back, **Edit secret**, **Schedule deletion**
- **Pending deletion:** Back, **Restore secret**, **Delete immediately**

#### Why use it

Operators verify secret metadata and deletion state before debugging application `ResourceNotFoundException` or access denied errors.

#### How it works in StackSim

Metadata updates, scheduled deletion, restoration, immediate permanent deletion, name-reuse safeguards, durable recovery deadlines, and blocking access while deletion is pending are active locally.

CloudFormation-owned secrets show a protected alert and **View owning stack** link. Direct metadata, value, version-stage, tag, policy, recovery, and deletion controls are hidden and the equivalent public API mutations are rejected. A separately owned `AWS::SecretsManager::ResourcePolicy` protects only its policy controls.

There is no snapshot or recovery after immediate deletion or after the recovery window expires.

#### Common AWS use cases

- Confirm ARN matches CloudFormation output or CDK token.
- Schedule deletion when decommissioning an environment.
- Restore after accidental deletion scheduling.

---

### Secret value

#### What it is

The **Secret value** panel shows a masked placeholder until you click **Retrieve secret value**. Optional **Copy** and **Clear** buttons appear after retrieval.

A hint explains that revealed plaintext lives only in page memory and clears after 60 seconds or when you navigate away.

This panel is hidden while deletion is pending.

#### Why use it

Secrets should not appear in list views or page loads by default. Explicit retrieval mirrors AWS console behavior.

#### How it works in StackSim

Installation-local AES-256-GCM protection, explicit current-value reads, string and binary SDK values, authenticated persistence, IAM checks, and value updates are active.

Revealed console plaintext exists only in page memory, clears after 60 seconds or navigation, and is never written to the URL. AWS KMS integration and automatic rotation are unavailable.

**Copy** prompts for confirmation because clipboard export leaves the browser boundary.

#### Common AWS use cases

- Verify JSON credential shape before updating application config.
- One-time read during local integration testing.

---

### Edit secret (modal)

#### What it is

Modal fields: **Description**, **New secret value** (optional). Saving with a new value creates a version via `UpdateSecret`; empty value updates metadata only.

#### Why use it

Rotate credentials or update descriptions without changing the secret name applications already reference.

#### How it works in StackSim

Publishing a new value moves `AWSCURRENT` to the new version and marks the former current version `AWSPREVIOUS`.

---

### Versions

#### What it is

Table of version IDs, staging labels (`AWSCURRENT`, `AWSPREVIOUS`, custom labels, or **Deprecated**), and created dates. **Manage stages** opens an editor for safe stage movement and removal.

#### Why use it

Version history supports rollback troubleshooting — compare which version was current when an application last worked.

#### How it works in StackSim

Exact `AWSCURRENT`/`AWSPREVIOUS` movement, custom stages, explicit rollback, exact version/stage reads, deprecated-version listing, idempotency tokens, retention limits, and encrypted version storage are active. A version can carry at most 20 stages. Moving `AWSCURRENT` records the former current version as the single `AWSPREVIOUS`; it cannot be removed without selecting a replacement current version.

#### Common AWS use cases

- Confirm two versions exist after publishing a new value.
- Use API `GetSecretValue` with `VersionStage=AWSPREVIOUS` to read prior credential during rollback.

---

### Resource permissions

#### What it is

The JSON editor validates and stores a secret resource policy. **Delete policy** removes the current policy. Policy editing never reads the secret value.

#### Why use it

A resource policy can grant an existing user or role in the configured account permission to retrieve or manage one secret, while shared identity-policy explicit denies still win.

#### How it works in StackSim

`ValidateResourcePolicy`, `PutResourcePolicy`, `GetResourcePolicy`, and `DeleteResourcePolicy` use normalized configured-account identity principals. Public/wildcard, foreign-account, federated, unknown identity, and service principals fail before mutation. Public-policy blocking is always enforced by the console. Policy revisions and normalized validation metadata persist atomically across restart.

---

### Tags

#### What it is

Tags displayed as formatted JSON. **Edit tags** opens a JSON object editor (disabled while deletion is pending).

#### Why use it

Tags organize secrets and participate in IAM conditions such as `secretsmanager:ResourceTag/environment`.

#### How it works in StackSim

Creating, listing, adding, replacing, and removing secret tags, persistence, validation, filtering, and supported resource-tag authorization conditions are active locally.

---

### Schedule deletion (modal)

#### What it is

**Recovery window (days)** — 7 to 30. Schedules deletion via `DeleteSecret` with recovery window.

#### Why use it

Recovery window prevents immediate accidental loss and matches AWS deletion workflow.

#### How it works in StackSim

While pending deletion, value access and mutation are blocked until **Restore secret** is invoked.

---

### Delete immediately

#### What it is

**Delete immediately** permanently destroys every version without recovery. Requires confirmation.

#### Why use it

Remove test secrets quickly when recovery window is unnecessary.

#### How it works in StackSim

Uses `ForceDeleteWithoutRecovery`. Cannot be undone.

---

## Secrets Manager vs Parameter Store

| Concern | Secrets Manager | Parameter Store |
|---------|-----------------|-----------------|
| Primary use | Credentials, tokens, structured secrets | Configuration, feature flags, non-secret settings |
| Versioning | Automatic stages (`AWSCURRENT`, `AWSPREVIOUS`) | Numeric versions |
| Rotation | AWS: Lambda rotation (unavailable locally) | N/A |
| Secure storage | Always encrypted | `SecureString` type |
| Console reveal | 60-second auto-clear | Cleared on navigation |

Use Secrets Manager for credentials JSON; use Parameter Store for hierarchical config paths — see [Parameter Store console guide](./parameter-store-console-guide.md).

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Encryption | Installation-local AES-256-GCM; not KMS |
| Customer KMS keys | Unavailable |
| Automatic rotation | Unavailable |
| Resource policies | Configured-account users, roles, account root, and account ID; public/cross-account/federated/service grants rejected |
| Cross-Region replication | Unavailable |
| Batch get secrets | SDK/API supports explicit-ID and filtered paginated modes with item errors |
| Custom staging labels | Active; exact current/previous transitions and 20-stage limit |
| SecretBinary in console | SDK only; not entered through create form |
| GetRandomPassword | SDK only |
| Recovery window | 7–30 days |
| List view values | Never shown |
| Console reveal timeout | 60 seconds |
| Pending deletion | Blocks read and mutation |
| CloudFormation secrets | Separate provider surface |

---

## Related StackSim docs

- [Parameter Store console guide](./parameter-store-console-guide.md) — configuration parameters vs secrets
- [IAM console guide](./iam-console-guide.md) — `secretsmanager:GetSecretValue` policies
- [EventBridge console guide](./eventbridge-console-guide.md) — event-driven apps that fetch secrets at runtime
- [Developer guide](./developer-guide.md) — application secret retrieval patterns
- [Reference](./reference.md) — Secrets Manager API summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — CLI examples for secrets
- [SQS console guide](./sqs-console-guide.md) — workers fetching secrets at runtime
- [SES console guide](./ses-console-guide.md) — credentials for applications sending mail
- [SNS console guide](./sns-console-guide.md) — publish permissions for notification apps
- [Lambda console guide](./lambda-console-guide.md) — `GetSecretValue` in function code
