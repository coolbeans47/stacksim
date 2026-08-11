# StackSim S3 console guide

This guide explains every panel in the StackSim S3 console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon S3 behavior.

StackSim models S3 object storage, authorization, lifecycle, notifications, and website hosting locally. Where local behavior differs from AWS (for example KMS, Glacier infrastructure, billing, or public internet hosting), those boundaries are called out explicitly.

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

The S3 service in StackSim has a left navigation bar with these top-level areas:

| Area | Purpose |
|------|---------|
| **Overview** | Account summary and quick links |
| **General purpose buckets** | Create, select, empty, and delete buckets |

Opening a bucket shows five tabs: **Objects**, **Properties**, **Permissions**, **Metrics**, and **Management**. Clicking an object name opens a dedicated object page with **Properties**, **Permissions**, and **Versions** tabs.

---

## Overview

### What it is

The **Overview** page summarizes how many general purpose buckets exist in the local account and links to the bucket list. A **Data protection** card notes read-after-write consistency, checksums, multipart uploads, versioning, and encrypted object storage.

### Why use it

In AWS, the S3 console landing page orients you toward buckets, storage classes, and security posture. It is the starting point before creating a bucket or reviewing account-level settings.

### How it works in StackSim

Bucket counts reflect the local installation. Object bytes are encrypted in a private blob store separate from control-plane state.

### Common AWS use cases

- Confirm buckets exist before running a deployment script.
- Navigate to bucket management after onboarding a new developer.

---

## General purpose buckets

### Buckets

#### What it is

The **Buckets** panel lists every bucket in the account with name, Region, creation date, and ARN. You can create a bucket, filter the list, select one bucket for **Empty** or **Delete**, and open a bucket by clicking its name.

Creating a bucket requires a globally unique name (within StackSim) and uses the current Region.

#### Why use it

A bucket is the top-level namespace for S3 objects. In AWS, bucket names are globally unique across all accounts, and the bucket Region determines data residency, latency, and which other services can integrate without cross-Region calls.

#### How it works in StackSim

Bucket creation, listing, regional endpoints, emptying, and deletion are active and persist locally. Names are unique within this StackSim installation rather than across all AWS accounts worldwide.

#### Common AWS use cases

- `my-app-assets-prod` for user uploads and static files.
- `logs-central-eu-west-1` for application and access logs.
- Separate buckets per environment (`dev`, `staging`, `prod`) for blast-radius isolation.

#### Example

Create bucket `learning-assets` in your configured Region, then upload `docs/guide.pdf` with key `guides/getting-started.pdf`.

---

## Bucket tabs

### Objects

#### What it is

The **Objects** panel shows the contents of a bucket prefix. Folders are prefix groupings; object names are links to the object detail page. Toolbar actions include **Upload**, **Create folder**, **Show versions**, and bulk **Delete selected**. Row actions offer **Preview**, **Copy**, and **Download**.

Files larger than 5 MiB use restart-safe multipart upload with one retry per part.

#### Why use it

S3 stores data as objects identified by keys. Slash-separated keys (`images/logo.png`) give a folder-like experience, but the namespace is flat. The Objects view is where operators and developers upload, organize, and inspect content.

In AWS, this is the primary interface for manual uploads, troubleshooting missing files, and verifying deployment artifacts.

#### How it works in StackSim

Object bytes, metadata, checksums, multipart uploads, versions, and delete markers are active. Console-created folders are zero-byte marker objects, matching the familiar S3 console convention.

#### Common AWS use cases

- Upload build artifacts (`releases/v2.4.0/app.zip`).
- Create prefix `incoming/` for partner file drops watched by Lambda notifications.
- Download an object to verify content after a pipeline run.

#### Example

Upload `report.csv` to prefix `analytics/2026/` so the full key becomes `analytics/2026/report.csv`. A lifecycle rule can later transition `analytics/` to a cheaper storage class.

---

### Properties

The **Properties** tab groups bucket-level configuration panels.

---

#### Bucket Versioning

##### What it is

Controls whether S3 keeps a history of every object version. States: **Not enabled**, **Enabled**, or **Suspended**. Buttons enable or suspend versioning.

##### Why use it

Versioning protects against accidental overwrites and deletions. When enabled, deleting an object creates a **delete marker** instead of removing data immediately; you can restore a previous version. Versioning is also required for Object Lock and many compliance workflows.

Once enabled in AWS, a bucket cannot return to a fully unversioned state — only suspended.

##### How it works in StackSim

Version IDs, delete markers, listing, restoration, and suspended-versioning behavior are active. Existing objects remain unversioned until they are written again.

##### Common AWS use cases

- Enable on production data buckets before allowing broad write access.
- Suspend temporarily during a controlled migration (versions are retained).
- Pair with lifecycle rules to expire noncurrent versions after 90 days.

##### Example

Enable versioning on `customer-documents`, then accidentally overwrite `contracts/acme.pdf`. Open **Show versions**, find the prior version, and **Restore** it.

---

#### Static website hosting

##### What it is

Configures the bucket to serve objects as a static website. Fields include **Index document** (for example `index.html`) and optional **Error document** (for example `error.html`). When enabled, StackSim exposes a local **Bucket website endpoint**.

##### Why use it

S3 static website hosting is a simple way to serve HTML, CSS, JavaScript, and assets without running a web server. In AWS, teams often front the website endpoint with CloudFront for HTTPS, caching, and custom domains.

Public visitors still need permission to read objects (bucket policy or CloudFront origin access).

##### How it works in StackSim

Website configuration, index and error resolution, redirects, and policy-based public access are active on a local endpoint. StackSim does not provide AWS DNS names, TLS certificates, CloudFront, or internet hosting.

##### Common AWS use cases

- Host a single-page application from `index.html`.
- Publish documentation sites synced from CI.
- Use error document `404.html` for client-side routing fallback.

##### Example

Enable hosting with index `index.html`, upload `index.html` and assets under `static/`, then open the bucket website endpoint. Add a bucket policy allowing `s3:GetObject` for public reads when testing locally.

---

#### Data governance

##### What it is

Groups protection and classification settings:

- **Default encryption** — SSE-S3 (`AES256`) or KMS descriptor settings.
- **Object Lock** — WORM retention defaults for compliance buckets.
- **Bucket tags** — key=value labels for organization and ABAC policies.

##### Why use it

Default encryption ensures every new object is encrypted at rest without clients setting headers. Object Lock prevents deletion or overwrite for a retention period — required for SEC 17a-4 and similar regimes. Bucket tags drive cost allocation and attribute-based IAM policies.

##### How it works in StackSim

SSE-S3 storage protection, tags, Object Lock retention, and legal enforcement are active. KMS and dual-layer KMS settings are stored as dependency descriptors; KMS-backed writes remain unavailable because StackSim does not provide KMS.

##### Common AWS use cases

- SSE-KMS with a specific CMK for regulated healthcare data (in AWS).
- Object Lock in **COMPLIANCE** mode for audit logs that must not be deleted early.
- Tag `Environment=prod` and `CostCenter=platform` for billing reports.

##### Example

Enable Object Lock with default **GOVERNANCE** retention of 30 days on `audit-logs`. New objects inherit retention; individual objects can still receive longer retention or legal holds.

---

#### Event notifications

##### What it is

Direct **Lambda** or **SQS** destinations triggered by S3 events. Each configuration has an ID, destination ARN, one or more event types, and optional prefix/suffix filters.

Supported events include object created/removed, restore, tagging, ACL changes, lifecycle transitions, and StackSim annotation events.

##### Why use it

Event notifications decouple storage from processing. When a file lands in S3, Lambda can virus-scan, transform, or index it; SQS can buffer events for workers. This is the classic pattern for upload pipelines without polling.

In AWS, destination resource policies must allow `s3.amazonaws.com` from the bucket account.

##### How it works in StackSim

Durable, at-least-once delivery to local Lambda functions and same-Region SQS queues is active, including destination-policy validation and retry diagnostics. SNS destinations are not available.

##### Common AWS use cases

- `s3:ObjectCreated:*` on prefix `uploads/` → Lambda generates thumbnails.
- `s3:ObjectRemoved:*` → SQS queue notifies a catalog service.
- Suffix filter `.json` → process only structured uploads.

##### Example

Configuration `images-created`:

- Events: `s3:ObjectCreated:Put`, `s3:ObjectCreated:CompleteMultipartUpload`
- Prefix: `images/`
- Destination: Lambda `arn:aws:lambda:eu-west-1:123456789012:function:resize-image`

---

#### Amazon EventBridge

##### What it is

A bucket-wide toggle to publish **all supported S3 events** to the default EventBridge event bus. Filtering happens in EventBridge rules, not in the S3 notification prefix/suffix fields.

##### Why use it

When multiple consumers need the same events, or routing logic is complex, EventBridge avoids maintaining many overlapping S3 notification configurations. Rules can match event detail, route to Lambda, Step Functions, SQS, and other targets.

##### How it works in StackSim

Bucket-wide publishing, default-bus rule matching, retry handling, and supported local rule targets are active. Events stay inside this StackSim installation.

##### Common AWS use cases

- One rule sends `Object Created` events to a Lambda audit function.
- Another rule forwards only keys matching a pattern to a cross-account bus (in AWS).
- Replace several prefix-specific S3 notifications with one EventBridge rule using JSON pattern matching.

##### Example

Enable EventBridge on `data-lake-raw`, then create an EventBridge rule matching `detail-type: Object Created` and target a Lambda that registers new datasets.

---

### Permissions

The **Permissions** tab controls who can access bucket contents and how public exposure is prevented.

---

#### Block public access (bucket settings)

##### What it is

Four independent switches (also configurable at account level):

| Setting | Effect |
|---------|--------|
| **BlockPublicAcls** | Reject ACLs that grant public access |
| **IgnorePublicAcls** | Ignore existing public ACLs |
| **BlockPublicPolicy** | Reject bucket policies that grant public access |
| **RestrictPublicBuckets** | Restrict access to buckets with public policies |

The console shows bucket, account, and **effective** values (most restrictive wins).

##### Why use it

Misconfigured public buckets caused many high-profile data leaks. Block Public Access is AWS's account- and bucket-level safety net that blocks new public grants even when a policy or ACL would otherwise allow them.

##### How it works in StackSim

The four bucket controls, account-level controls, policy validation, and authorization effects are active. They protect the local S3 API; StackSim does not expose buckets directly to the public internet.

##### Common AWS use cases

- Enable all four settings on every bucket by default at account level.
- Allow a carefully scoped public read on one bucket while account Block Public Access stays on (requires deliberate policy design).
- Audit effective settings before opening a bucket to the internet via CloudFront.

---

#### Bucket policy

##### What it is

A resource-based IAM JSON policy attached to the bucket. Grants or denies actions such as `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket` for specified principals and resources, often with conditions.

##### Why use it

Bucket policies enable cross-account access, service integrations (CloudFront OAC, Lambda, other accounts), and scoped public reads (`Principal: "*"` with `IpAddress` or `StringEquals` conditions).

Explicit **Deny** always overrides **Allow**.

##### How it works in StackSim

Policy storage, validation, explicit denies, principals, resources, and supported IAM condition evaluation are active. Findings shown in the console are simulator guidance, not IAM Access Analyzer results.

##### Common AWS use cases

- Allow CloudFront to `s3:GetObject` on `arn:aws:s3:::assets/*`.
- Grant partner account `123456789012` read access to `shared/*`.
- Deny unencrypted uploads with `s3:x-amz-server-side-encryption`.

##### Example

Public read for static website objects:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-website-bucket/*"
    }
  ]
}
```

Combine with Block Public Access settings carefully — `BlockPublicPolicy` and `RestrictPublicBuckets` may block this unless configured intentionally.

---

#### Object Ownership

##### What it is

Controls whether ACLs apply and who owns uploaded objects:

- **BucketOwnerEnforced** — ACLs disabled; bucket owner owns all objects (recommended).
- **BucketOwnerPreferred** — uploader can set ACLs but bucket owner takes ownership of new uploads with ACL `bucket-owner-full-control`.
- **ObjectWriter** — uploader owns objects; ACLs apply.

##### Why use it

AWS recommends **BucketOwnerEnforced** for new buckets. ACLs are legacy; IAM and bucket policies are easier to audit. Object Ownership fixes cross-account upload ownership issues where objects were owned by the writer account.

##### How it works in StackSim

All three ownership modes, ACL enablement, ownership headers, and authorization consequences are active.

##### Common AWS use cases

- Set **BucketOwnerEnforced** on all application buckets.
- Use **ObjectWriter** only when testing legacy ACL-based applications.

---

#### Access control list (ACL)

##### What it is

Legacy grant list for the bucket itself (not individual objects on this panel). Canned ACLs include `private`, `public-read`, `public-read-write`, `authenticated-read`, and `log-delivery-write`.

Editing is disabled when **BucketOwnerEnforced** is selected.

##### Why use it

Before IAM and bucket policies were ubiquitous, ACLs controlled access. Some AWS services (legacy log delivery) still reference ACL grants. Modern designs avoid ACLs.

##### How it works in StackSim

Canned ACLs, grant evaluation, ownership controls, and Block Public Access interactions are active.

##### Common AWS use cases

- Reproduce a legacy application that sets `public-read` on buckets (then migrate to bucket policies).
- `log-delivery-write` for older S3 server access log delivery patterns.

---

#### Requester Pays

##### What it is

When set to **Requester**, the caller must include `x-amz-request-payer: requester` and is considered responsible for request and data transfer charges instead of the bucket owner.

##### Why use it

Large public datasets (open data, scientific archives) use Requester Pays so the bucket owner is not billed for every download. Access still requires appropriate IAM or bucket policy permission.

##### How it works in StackSim

The request-payer header and authorization context are enforced locally. StackSim does not calculate charges or create billing records.

##### Common AWS use cases

- Open geospatial datasets where consumers pay egress.
- Shared research buckets with controlled IAM access and payer shift.

---

#### Attribute-based access control (ABAC)

##### What it is

When **Enabled**, bucket tags are exposed as resource tags to IAM policies. Policies can authorize access using conditions like `aws:ResourceTag/Environment` instead of listing every bucket ARN.

##### Why use it

ABAC scales permission management in organizations with many buckets. A single IAM policy can allow access to buckets tagged `Project=Analytics` for principals tagged `Team=Data`.

##### How it works in StackSim

Bucket tags participate in supported local IAM condition operators during authorization.

##### Common AWS use cases

- Grant developers access to buckets tagged `Environment=dev` only.
- Require matching principal and resource tags for cross-team access.

##### Example

Bucket tag: `Sensitivity=Confidential`  
IAM condition: `"StringEquals": { "aws:ResourceTag/Sensitivity": "${aws:PrincipalTag/Clearance}" }`

---

### Metrics

#### What it is

The **Metrics** tab shows:

- **Pending notifications** — count and age of undelivered event notifications.
- **CloudWatch metrics** — link to request count, bytes, errors, latency, and notification success/failure (BucketName and FilterId dimensions).
- **Recent delivery diagnostics** — notification delivery outcomes without payloads.

#### Why use it

In AWS, S3 metrics in CloudWatch help detect traffic spikes, 4xx/5xx errors, and notification delivery failures. Pending notification counts indicate destinations that are down or misconfigured.

#### How it works in StackSim

Metrics are emitted to local CloudWatch after S3 requests and notification attempts.

#### Common AWS use cases

- Alarm on `4xxErrors` spike after a policy change.
- Investigate Lambda notification failures from delivery diagnostics.
- Correlate upload bursts with `AllRequests` metrics.

---

### Management

The **Management** tab combines lifecycle configuration and operational cleanup.

---

#### Lifecycle rules

##### What it is

XML-defined rules that automatically transition objects to other storage classes, expire objects or delete markers, expire noncurrent versions, and abort incomplete multipart uploads. Rules support prefix, tag, size, and AND filters.

##### Why use it

Lifecycle management reduces cost and enforces retention without custom jobs. In AWS, transitions move data to Infrequent Access, Glacier, or Deep Archive; expiration deletes objects on a schedule.

##### How it works in StackSim

Rule scheduling, filters, transitions, expiration, noncurrent versions, and multipart cleanup are active. Archive access restrictions are modeled; physical blobs remain in the local encrypted store.

##### Common AWS use cases

- Transition `logs/` to Glacier after 30 days; expire after 365 days.
- Abort incomplete multipart uploads after 7 days (cost control).
- Expire noncurrent versions 90 days after becoming noncurrent.

##### Example

```xml
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>archive-old-reports</ID>
    <Filter><Prefix>reports/</Prefix></Filter>
    <Status>Enabled</Status>
    <Transition><Days>30</Days><StorageClass>GLACIER</StorageClass></Transition>
    <Expiration><Days>400</Days></Expiration>
  </Rule>
</LifecycleConfiguration>
```

---

#### Incomplete multipart uploads

##### What it is

Lists in-progress multipart uploads with upload ID, age, part count, and uploaded bytes. **Abort** cancels an incomplete upload.

##### Why use it

Failed or abandoned multipart uploads accumulate storage charges in AWS for uploaded parts. Operators abort stale uploads or rely on lifecycle rules to clean them automatically.

##### How it works in StackSim

Multipart state is tracked locally; abort removes incomplete parts.

##### Common AWS use cases

- Abort uploads older than 24 hours after a client crash.
- Empty a bucket before deletion (multipart uploads block deletion if not cleared).

---

## Object detail pages

Click an object name to open its detail page. Tabs: **Properties**, **Permissions**, and **Versions**. An optional version ID in the URL selects a specific version.

---

### Object overview

#### What it is

Read-only summary: key, version ID, owner, last modified, size, ETag, content type, storage class, S3 URI, ARN, and local object URL. Expandable **Presigned URL guidance** shows SDK signing examples.

#### Why use it

Operators verify they opened the correct object and copy identifiers for scripts, tickets, and IAM policies. Presigned URLs grant time-limited access without making the bucket public.

#### Common AWS use cases

- Confirm `Content-Type` before serving through CloudFront.
- Copy ARN into an IAM policy `Resource`.
- Generate a 15-minute presigned GET URL for a secure download link.

---

### Server-side encryption

#### What it is

Read-only encryption metadata for the selected version: algorithm (typically `AES256` for SSE-S3), optional SSE-C customer algorithm, or KMS key descriptor if present.

#### Why use it

Auditors and security teams verify objects are encrypted at rest. Clients may also set encryption headers on upload; default bucket encryption applies when they do not.

#### How it works in StackSim

SSE-S3 protects object bytes in the local blob store. KMS descriptors may appear in metadata but KMS writes are blocked without a KMS dependency.

---

### Checksums

#### What it is

When present, shows checksum algorithm, value, and type (`FULL_OBJECT` or composite) from `x-amz-checksum-*` headers.

#### Why use it

AWS SDKs and CLI support additional checksum algorithms (CRC32, SHA256, and others) for end-to-end integrity validation beyond ETag.

#### Common AWS use cases

- Verify large uploads were not corrupted in transit.
- Require `ChecksumSHA256` in application upload pipelines.

---

### Metadata

#### What it is

System metadata (content type, encoding, cache control, and similar) and user metadata (`x-amz-meta-*` key/value pairs) stored with the object.

#### Why use it

User metadata attaches lightweight application context without changing object bytes — for example `x-amz-meta-uploaded-by`, `x-amz-meta-tenant-id`. System metadata influences browser caching and content handling.

#### Common AWS use cases

- Set `Cache-Control: max-age=31536000` on static assets.
- Store `x-amz-meta-document-type=invoice` for downstream classification.

---

### Tags (object)

#### What it is

Up to ten key-value tags on the object version, editable inline. Tags are separate from user metadata and participate in lifecycle filters and IAM conditions.

#### Why use it

Object tags classify individual files for automation — expire `Temporary=true` objects after seven days, or restrict access by tag in bucket policies.

#### How it works in StackSim

Version-specific tag reads, writes, deletion, lifecycle filters, notifications, and supported authorization checks are active.

#### Common AWS use cases

- Tag `PII=true` for objects requiring restricted access.
- Lifecycle filter on tag `Retention=90d`.
- Event notification prefix/suffix plus tag-based processing in Lambda.

##### Example

Tags on `uploads/acme/contract.pdf`:

| Key | Value |
|-----|-------|
| `Customer` | `acme` |
| `DocType` | `contract` |

---

### Object Lock retention

#### What it is

Per-version retention mode (**GOVERNANCE** or **COMPLIANCE**) and **Retain until** date. Shown when Object Lock is enabled on the bucket.

- **GOVERNANCE** — privileged users with `s3:BypassGovernanceRetention` can shorten retention.
- **COMPLIANCE** — retention cannot be shortened by anyone, including the root user.

#### Why use it

Regulatory frameworks require WORM storage. Retention prevents deletion until the date passes, independent of bucket policies.

#### How it works in StackSim

Retention dates, modes, bypass permission checks, and protected mutations are enforced locally.

#### Common AWS use cases

- SEC-compliant trade record retention for seven years (Compliance mode).
- Short governance retention on audit logs with admin override for mistakes.

---

### Legal hold

#### What it is

On/Off switch placing an indefinite hold on the object version until explicitly removed. Unlike retention, there is no expiry date.

#### Why use it

Legal and compliance teams place holds during litigation or investigations. Objects under hold cannot be deleted even if lifecycle rules would otherwise expire them.

#### How it works in StackSim

Per-version legal-hold state and deletion protection are enforced.

#### Common AWS use cases

- Hold all objects related to a customer dispute.
- Release hold after legal clearance.

---

### Annotations

#### What it is

**StackSim extension** — named UTF-8 payloads attached to an object version (review notes, extracted JSON, workflow state). Not part of the standard AWS S3 API.

#### Why use it

Local workflows can store structured sidecar data next to an object without a separate database table — useful in simulators and tests.

#### How it works in StackSim

Version-scoped annotation CRUD, checksums, ETags, listing, and Object Lock protection are active.

#### Common AWS use cases (local)

- Attach OCR results to a scanned PDF object in a tutorial pipeline.
- Store human review approval metadata during a compliance exercise.

---

### Archive restore

#### What it is

For objects in **GLACIER** or **DEEP_ARCHIVE** storage class: restore status, optional temporary availability window, and a form to request or extend restore with tier (Standard, Expedited, Bulk) and days available.

#### Why use it

Archive storage classes in AWS are cheap because objects are not immediately readable. Restore retrieves a temporary copy; tier controls speed and cost.

#### How it works in StackSim

Archive access restrictions, restore state, and expiry are modeled. No bytes move to external Glacier infrastructure and retrieval delays are not reproduced.

#### Common AWS use cases

- Restore a yearly archive backup for one-day verification.
- Use Expedited tier for urgent recovery (higher cost in AWS).

---

### Object permissions tab

#### Object owner and Object access control list (ACL)

Shows owner canonical ID and grant table. When ACLs are enabled (ownership is not **BucketOwnerEnforced**), edit canned object ACLs with confirmation for public grants.

**Why use it:** Object ACLs grant read/write to specific AWS accounts or groups. Legacy cross-account sharing used object ACLs; modern designs use bucket policies and IAM.

**Effective access note:** IAM identity policies, bucket policy, Block Public Access, session policy, permissions boundaries, and explicit denies all participate — not just the ACL shown on this tab.

---

### Versions tab (object)

#### What it is

Version history for a single key: version IDs, delete markers, latest flag, sizes, storage classes, checksums, and actions (**Properties**, **Permissions**, **Download version**, **Restore this version**, **Delete permanently**).

#### Why use it

When versioning is enabled, this is the recovery interface for one object without scanning the entire bucket version list (**Show versions** on the bucket Objects tab lists all keys).

#### Common AWS use cases

- Permanently delete a specific old version to reduce storage after confirming backup.
- Restore yesterday's version after a bad deploy overwrote `config.json`.

---

## Bucket-wide version list

**Show versions** on the Objects tab lists every version and delete marker in the bucket across all keys. Use it for bulk auditing; use the object **Versions** tab for focused key history.

---

## Operations reference

| Action | Where | Notes |
|--------|-------|-------|
| **Upload** | Objects | Multipart for large files |
| **Copy** | Object row or detail | Rename workflow: copy, verify, delete source |
| **Empty bucket** | Bucket list | Deletes all versions and aborts multipart uploads |
| **Delete bucket** | Bucket list or Properties | Bucket must be empty |
| **Create folder** | Objects | Zero-byte key ending in `/` |

---

## Quick reference: access control layers

S3 effective access in AWS (and StackSim) combines multiple layers:

```text
Request
  → Block Public Access (account + bucket)
  → Bucket policy
  → IAM identity policy
  → Object ACL (if ownership allows ACLs)
  → Session policy / permissions boundary
  → Explicit Deny wins
```

Prefer **BucketOwnerEnforced**, **Block Public Access on**, IAM roles for applications, and bucket policies for cross-account and service access.

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — CDK tutorials using S3 buckets
- [IAM console guide](./iam-console-guide.md) — bucket access policies and roles
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — credentials for apps reading from S3
- [EventBridge console guide](./eventbridge-console-guide.md) — S3 event notifications via custom events
- [API Gateway console guide](./apigateway-console-guide.md) — companion service console reference
- [Cognito console guide](./cognito-console-guide.md) — user pools and authentication
- [Parameter Store console guide](./parameter-store-console-guide.md) — configuration and SecureString secrets
- [DynamoDB console guide](./dynamodb-console-guide.md) — NoSQL tables and items
- [AWS CLI cookbook](./aws-cli-cookbook.md) — CLI examples for S3 operations
- [SQS console guide](./sqs-console-guide.md) — bucket notifications to queues
- [SNS console guide](./sns-console-guide.md) — fan-out subscriptions to queues
- [CloudFormation console guide](./cloudformation-console-guide.md) — CDK asset buckets and stack resources
- [Lambda console guide](./lambda-console-guide.md) — functions triggered by bucket notifications
