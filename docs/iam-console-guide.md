# StackSim IAM console guide

This guide explains every panel in the StackSim IAM console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS Identity and Access Management behavior.

StackSim models users, groups, roles, policies, access keys, STS AssumeRole sessions, and a shared policy evaluator locally. Where local behavior differs from AWS (for example console passwords, MFA, or the full AWS managed-policy catalog), those boundaries are called out explicitly.

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

The IAM service in StackSim has a left navigation bar with these areas:

| Area | Purpose |
|------|---------|
| **Dashboard** | Account summary counts and quick orientation |
| **User groups** | Share policies across member users |
| **Users** | Long-lived identities and access keys |
| **Roles** | Assumable identities for services and SDK sessions |
| **Policies** | Reusable permission documents |
| **Authorization decisions** | Local diagnostic history (simulator tooling) |

Fresh installations include a default user `admin` with the seeded `AdministratorAccess` managed policy. Authentication mode (`enforce`, `off`, etc.) is shown on the dashboard.

---

## Dashboard

### What it is

The **Dashboard** shows four summary cards — **Users**, **User groups**, **Roles**, and **Policies** — with counts and links to each list. An info banner describes local authorization and the current authentication mode.

### Why use it

In AWS, the IAM home page orients you toward identity resources and security posture before you attach policies or create roles.

### How it works in StackSim

Counts reflect the local account. Users, groups, and role sessions use the same policy evaluator. Explicit **Deny** statements take precedence over **Allow**.

### Common AWS use cases

- Confirm CDK or CloudFormation created expected roles after deploy.
- Navigate to **Users** to rotate access keys.
- Check policy count before attaching a new customer-managed policy.

---

## Users

### Users (list)

#### What it is

The **Users** panel lists IAM users with user name, ARN, and created date. **Create user** opens a modal with a user name field. A filter box searches the list.

#### Why use it

IAM users represent people, scripts, or tools that need long-lived access keys. Separate users isolate credentials and authorization lifecycle.

#### How it works in StackSim

User lifecycle, paths, tags through the IAM API, managed and inline policies, group membership, up to two access keys, SigV4 authentication, and local authorization are active.

Console passwords, login profiles, MFA, signing certificates, SSH keys, and service-specific credentials are unavailable.

#### Common AWS use cases

- `ci-deploy` — automation user for pipelines.
- `developer-alice` — individual developer with scoped policies.
- `admin` — default StackSim administrator (replace keys after first login in production-like setups).

#### Example

Create user `notes-deployer` for a CDK pipeline that uses access keys instead of assumed roles.

---

### Create user (modal)

#### What it is

Single field: **User name** (pattern `[A-Za-z0-9_+=,.@-]+`). Submit creates the user and navigates to the user detail page.

#### Why use it

Minimal user creation when policies and keys are configured on the detail page afterward.

#### How it works in StackSim

Creates the user through the local IAM API. Attach policies and create access keys from the detail view.

---

## User detail

### Permissions

#### What it is

The **Permissions** card lists managed policies attached directly to the user, with **Detach** links. **Add permissions** opens a modal to attach another managed policy. A separate **Groups** card links to group memberships (read-only on this page).

#### Why use it

Direct attachments grant permissions without group membership. Effective permissions also include group policies and inline policies (managed through the IAM API).

#### How it works in StackSim

Managed-policy attachments, inline user policies through the IAM API, group policies, action and resource wildcards, supported conditions, explicit denies, and exact path-qualified resource evaluation are enforced locally.

This console panel manages **direct managed-policy attachments only**.

#### Common AWS use cases

- Attach `ReadOnlyAccess` for auditors.
- Attach a customer-managed policy shared with a role.

#### Example

Attach `AmazonDynamoDBFullAccess` (service-managed) for a migration script user — prefer scoped customer-managed policies in production.

---

### Security credentials

#### What it is

The **Security credentials** panel lists access keys (ID, status, created date, and last-used time/service/Region) with **Deactivate/Activate** and **Delete** actions. Keys without a valid signed request show **Never**. **Create access key** generates a new key pair.

After creation, a modal displays **Access key ID** and **Secret access key** once with a warning to save before closing.

#### Why use it

Access keys sign SDK, CLI, CDK, and application requests. Rotate keys periodically and deactivate compromised credentials immediately.

#### How it works in StackSim

Two-key quota, one-time secret display, active/inactive state, deletion, SigV4 validation, durable monotonic last-used tracking, last-owner binding, restart persistence, and encrypted private credential storage are active. Invalid signatures never update usage.

Secrets cannot be retrieved again. These keys do not create an AWS console password.

#### Common AWS use cases

- Generate keys for local `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
- Deactivate old key after rotating to a new one.

#### Example

```text
Access key ID:     AKIA...
Secret access key: (shown once — store in a password manager)
Status:            Active
```

---

### Delete user

#### What it is

**Delete** on the user detail page requires confirmation. The message reminds you to remove keys, group memberships, and policies first.

#### Why use it

Remove identities that no longer need access.

#### How it works in StackSim

Deletion fails while dependencies remain attached. The default `admin` user can be managed like any other user once created.

---

## User groups

### User groups (list)

#### What it is

The **User groups** panel lists groups with name, ARN, and member count. **Create group** opens a name modal. Filter searches group names.

#### Why use it

Groups let teams share the same permission policies without attaching each policy to every user individually.

#### How it works in StackSim

Group lifecycle, paths and tags through the API, memberships, managed and inline policies, deletion conflicts, and group-policy contribution to user authorization are active.

This console currently manages group creation and membership; policy administration is available through the compatible IAM API.

#### Common AWS use cases

- `Developers` — shared read/write access to dev resources.
- `Auditors` — read-only policies attached once.

---

### Group detail — Members

#### What it is

The **Members** table lists users in the group with **Remove** actions. **Add member** selects from users not already in the group. **Delete** removes the group (after members and policies are cleared).

#### Why use it

Membership changes take effect on the next authorization evaluation — users gain or lose group policy contributions immediately.

#### How it works in StackSim

Membership add, remove, list, persistence, deletion safeguards, and immediate participation in local policy evaluation are active.

Groups cannot contain other groups, roles, or federated identities.

#### Example

Add `notes-deployer` to `Developers` so the user inherits shared DynamoDB and S3 policies attached to the group.

---

## Roles

### Roles (list)

#### What it is

The **Roles** panel lists roles with name, path, trusted entities (trust policy snippet), and created date. Two creation paths:

- **Create role** — modal with trusted entity type, name, description, and custom trust policy JSON.
- **Create service role** (guided wizard) — step-by-step service role builder with resource pickers.

#### Why use it

Roles are identities that trusted services or principals assume for temporary credentials. Lambda execution roles, EventBridge target roles, and cross-account assumption all start here.

#### How it works in StackSim

Role lifecycle, paths, descriptions, tags, trust policies, managed and inline permissions, service-role guidance, `iam:PassRole`, STS AssumeRole sessions, session policies and tags, expiration, and supported service assumption are enforced locally.

Service-linked roles and instance profiles are unavailable.

#### Common AWS use cases

- Lambda execution role — `lambda.amazonaws.com` trust.
- EventBridge Scheduler role — invoke Lambda or send to SQS.
- Developer AssumeRole — same-account root or IAM user in trust policy.

---

### Create role (modal)

#### What it is

Step 1 fields:

- **Trusted entity type** — service Lambda, local account, or custom trust policy.
- **Role name**, **Description**.
- **Custom trust policy JSON** — editable; preset for Lambda when service is selected.

Local account trust uses `arn:aws:iam::{accountId}:root` as principal.

#### Why use it

Trust policy defines **who** can assume the role; permission policies define **what** the session can do.

#### How it works in StackSim

Creates the role via IAM API. Attach permission policies on the role detail page afterward.

#### Example (Lambda trust policy)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

---

### Create service role (guided wizard)

#### What it is

A four-step wizard:

1. **Use case** — choose template:
   - Lambda execution role
   - EventBridge Scheduler execution role
   - Step Functions execution role
   - AppSync service role
   - API Gateway CloudWatch Logs role
   - EventBridge rule target role
   - Custom guided service role
2. **Permissions** — resource pickers (ARN combobox) and optional capabilities per template.
3. **Role details** — name (auto-suggested), description, tags JSON.
4. **Review** — summary plus generated trust and permission JSON before create.

The wizard creates the role, optionally creates a `{roleName}-guided-policy` customer-managed policy, and attaches managed policies (for example `AWSLambdaBasicExecutionRole` for Lambda).

#### Why use it

Service roles follow repetitive patterns — trust for a service principal plus scoped resource permissions. The wizard avoids hand-editing JSON for common StackSim integrations.

#### How it works in StackSim

ARN comboboxes suggest existing local resources (Lambda functions, SQS queues, DynamoDB tables, etc.). Failed creation rolls back role, attachments, and generated policies.

Wildcard `Resource: "*"` is explained when required (for example API Gateway CloudWatch Logs actions).

#### Example

EventBridge Scheduler → SQS target:

```text
Use case:     EventBridge Scheduler execution role
Target kind:  SQS queue
Target ARN:   arn:aws:sqs:eu-west-1:000000000000:orders-queue
Role name:    orders-queue-schedule-role
```

---

## Role detail

Role detail pages use tabs: **Permissions**, **Trust relationships**, **Tags**, and **Access advisor**.

### Permissions tab

#### What it is

**Permissions policies** table lists attached managed policies with type (service-managed or customer managed), links to policy detail, and **Detach**. **Add permissions** attaches another policy.

**Related Lambda functions** lists functions using this execution role (local relationship data, not an IAM API field).

**Assume this role with SDK v3** shows an STS `AssumeRoleCommand` code snippet.

#### Why use it

Verify the role has required permissions before debugging `AccessDenied` errors in Lambda or other services.

#### How it works in StackSim

Managed-policy attach/detach in console. Inline role policies via IAM API. Session-policy intersection and permissions boundaries enforced by evaluator.

---

### Trust relationships tab

#### What it is

Read-only display of the role **Trust policy** JSON.

#### Why use it

Confirm which services or accounts can call `sts:AssumeRole` on this role.

#### How it works in StackSim

Trust policy updates after creation are available through IAM APIs and supported CloudFormation roles — the console view is read-only.

Supported: AWS and service principals, conditions, external ID context, session duration, `iam:PassRole` checks.

---

### Tags tab

#### What it is

Read-only table of role tags (key/value), or empty state when none exist.

#### Why use it

Tags support organization and IAM condition keys (`aws:ResourceTag/...`).

#### How it works in StackSim

Tags set at role creation or through IAM API appear here. Console tag editing on roles is not implemented on this tab.

---

### Access advisor tab

#### What it is

Empty state: service last-accessed information is not available locally.

#### Why use it

In AWS, access advisor helps right-size policies by showing unused services.

#### How it works in StackSim

Reference-only placeholder — no simulated last-accessed data.

---

## Policies

### Policies (list)

#### What it is

The **Policies** table lists policy name, type (service-managed or customer managed), path, and default version ID. **Create policy** opens the policy editor modal.

#### Why use it

Managed policies are reusable permission documents attachable to multiple users, groups, or roles.

#### How it works in StackSim

Seeded service-managed policies, customer-managed lifecycle, visual and JSON creation, validation, versions, default versions, tags, attachments, deletion conflicts, and evaluator integration are active.

The complete AWS managed-policy catalog, policy generation, Access Analyzer, and Organizations policy types are unavailable.

---

### Create policy (modal)

#### What it is

Fields: **Policy name**, **Description**, and a tabbed editor:

- **Visual** — edit the first statement: Effect, Statement ID, Actions (one per line), Resources (one per line or `*`).
- **JSON** — full policy document editor.

Additional statements in JSON are preserved when editing the first statement visually. `NotAction` and `NotResource` require the JSON tab.

**Validate** runs the same read-only policy compiler used by IAM mutation APIs. The status and deterministic permission summary cover effect, service/actions, resources, and conditions; wildcard warnings are called out before creation. Editing either mode invalidates the previous result.

#### Why use it

Visual mode lowers the barrier for simple allow lists; JSON mode supports complex conditions and multiple statements.

#### How it works in StackSim

Version `2012-10-17` documents with shared statement/operator validation, wildcard warnings, explicit-deny precedence, and supported condition operators. Validation describes the submitted document and does not simulate a user or role's effective permissions.

#### Example

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query"
    ],
    "Resource": "arn:aws:dynamodb:eu-west-1:000000000000:table/Notes"
  }]
}
```

---

## Policy detail

Policy detail pages use tabs: **Permissions**, **Entities attached**, **Policy versions**, and **Tags**.

### Permissions tab

#### What it is

Displays the **Permission policy** JSON for the default version.

#### Why use it

Review exact allow/deny statements before attaching to a production role.

#### How it works in StackSim

Shows default version document. Service-managed policies are read-only for deletion.

---

### Entities attached tab

#### What it is

Lists roles (linked) that have this policy attached, or empty state if unattached.

#### Why use it

Understand blast radius before deleting or narrowing a shared policy.

#### How it works in StackSim

Reflects role attachments from local IAM state. User and group attachments may appear through API queries; this tab focuses on linked roles in the console.

---

### Policy versions tab

#### What it is

Table of version IDs, whether each is default, and created date.

#### Why use it

Policy versioning supports rollback and audit in AWS.

#### How it works in StackSim

Version history is stored locally. Console does not offer set-default-version UI — use IAM API if needed.

---

### Tags tab

#### What it is

Read-only tag table for the policy.

#### Why use it

Tag policies for cost allocation and IAM conditions.

#### How it works in StackSim

Tags from creation or API appear here.

---

### Delete policy

Customer-managed policies show **Delete** on the detail page. Service-managed policies cannot be deleted.

---

## Authorization decisions

### What it is

**Authorization decisions** lists local diagnostic history: time, decision (`allowed` / denied), principal ARN, action, resource, and reason. Not part of the AWS IAM console — StackSim tooling.

### Why use it

Debug explicit and implicit denies without exposing credential material. Understand why `enforce` mode rejected a request.

### How it works in StackSim

Populated when authentication mode is `enforce` and signed SDK requests are made. Empty until requests occur.

### Common AWS use cases

- Trace `AccessDenied` after attaching a new deny statement.
- Confirm a scoped resource ARN matches the request resource.

---

## Effective permissions model

StackSim evaluates policies in a simplified AWS-compatible model:

```text
Request
  → Authenticate principal (user access key or assumed role session)
  → Collect identity policies (user/role direct + group + inline via API)
  → Collect resource policies where applicable
  → Explicit Deny wins over Allow
  → Default deny if no Allow matches
```

| Source | Console management | Contributes to authorization |
|--------|-------------------|------------------------------|
| User managed policy attach | Yes | Yes |
| User inline policy | IAM API | Yes |
| Group managed/inline | IAM API | Yes (via membership) |
| Role managed policy attach | Yes | Yes (when assumed) |
| Role inline policy | IAM API | Yes |
| Resource policy (S3, SNS, etc.) | Service consoles | Yes, per service rules |
| Session policy | STS API | Yes (intersection) |

---

## Default administrator

Fresh StackSim installations include:

| Item | Value |
|------|-------|
| User name | `admin` |
| Default access key ID | `admin` |
| Default secret access key | `password` |
| Attached policy | `AdministratorAccess` (service-managed) |

The default user is powerful because of a normal identity-policy allow, not a fabricated root bypass. Explicit deny statements still apply. Replace default keys for non-loopback deployments.

Recovery-root mode (`STACKSIM_BOOTSTRAP_ROOT` legacy) is separate from the default user — see [Reference](./reference.md) for environment variables.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| IAM users — console password / MFA | Unavailable |
| IAM users — login profile | Unavailable |
| Access keys per user | Maximum 2 |
| Secret access key retrieval | One-time display only |
| Service-linked roles | Unavailable |
| EC2 instance profiles | Unavailable |
| Full AWS managed policy catalog | Seeded subset only |
| IAM Access Analyzer | Unavailable |
| Access advisor (last accessed) | Unavailable |
| Trust policy console edit | Read-only; use API/CloudFormation |
| Group policy attach in console | IAM API only |
| Inline policy editor in console | IAM API only |
| Organizations SCPs | Unavailable |
| Cross-account roles | Trust policy supported; test with local ARNs |
| Authorization decisions page | Local simulator diagnostics only |
| Auth mode `off` | Requests may bypass enforcement — see dashboard banner |
| Default credentials | `admin` / `password` — rotate for shared environments |

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — CDK tutorials using IAM roles and policies
- [Reference](./reference.md) — authentication modes and environment variables
- [AWS CLI cookbook](./aws-cli-cookbook.md) — IAM and STS CLI examples
- [Parameter Store console guide](./parameter-store-console-guide.md) — configuration parameters and IAM tag conditions
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — secret access policies
- [EventBridge console guide](./eventbridge-console-guide.md) — Scheduler and rule execution roles
- [API Gateway console guide](./apigateway-console-guide.md) — execution roles and Cognito authorizers
- [Cognito console guide](./cognito-console-guide.md) — user pools (separate from IAM users)
- [Lambda](./reference.md) — functions assume IAM execution roles
- [S3 console guide](./s3-console-guide.md) — bucket policies interact with IAM identity policies
- [DynamoDB console guide](./dynamodb-console-guide.md) — table access controlled by IAM policies
- [SQS console guide](./sqs-console-guide.md) — queue policies and Lambda execution roles
- [SES console guide](./ses-console-guide.md) — send permissions and identity authorization policies
- [SNS console guide](./sns-console-guide.md) — topic policies and delivery feedback roles
- [Lambda console guide](./lambda-console-guide.md) — execution roles and function resource policies
- [CloudFormation console guide](./cloudformation-console-guide.md) — deployment and stack execution roles
- [Step Functions console guide](./step-functions-console-guide.md) — state machine execution roles
