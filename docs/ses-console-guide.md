# StackSim SES console guide

This guide explains every panel in the StackSim SES console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon SES behavior.

StackSim models verified identities, templated sends, configuration sets, suppression, contact lists, and a local Inbox for captured mail. Messages are never handed to external SMTP servers. Where local behavior differs from AWS (for example DNS, DKIM signing, or remote delivery), those boundaries are called out explicitly.

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

The SES service in StackSim has a left navigation bar with:

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Account dashboard** | `#/ses` | Regional sending status and quotas |
| **Verified identities** | `#/ses/identities` | Sender verification |
| **Configuration sets** | `#/ses/configuration-sets` | Sending controls and event destinations |
| **Email templates** | `#/ses/templates` | Reusable message content |
| **Send test email** | `#/ses/send-test` | Manual send via SES v2 |
| **Inbox** | `#/ses/inbox` | Local captured mail |
| **Suppression list** | `#/ses/suppression` | Bounce and complaint suppression |
| **Contact lists** | `#/ses/contact-lists` | Subscription preferences |
| **Custom verification** | `#/ses/custom-verification-templates` | Identity verification email layout |
| **Sending statistics** | `#/ses/statistics` | Last 24-hour local metrics |

Identity detail: `#/ses/identities/{name}`. Template detail: `#/ses/templates/{name}`. Configuration set detail: `#/ses/configuration-sets/{name}`. Inbox message: `#/ses/inbox/{messageId}`.

The console uses official SES v1 Query and SES v2 REST-JSON APIs, plus a private Inbox API (`/_stacksim/api/ses/inbox`).

---

## Account dashboard

### Regional account summary

#### What it is

Info banner: successful sends are captured into the local Inbox — never delivered to remote mail servers.

Summary cards:

| Card | Content |
|------|---------|
| **Account status** | Sending enabled or paused; sandbox vs production profile |
| **Verified identities** | Count verified for sending |
| **Captured messages** | Total Inbox rows for this account and Region |
| **Templates** | Stored template count |
| **Configuration sets** | Configuration set count |
| **Sending quota** | 24-hour recipient limit and recipients per second |

Actions: **Pause sending** / **Resume sending**, **Use sandbox profile** / **Use production profile** (requires typing `SANDBOX` or `PRODUCTION` to confirm).

**Development boundaries** table: transport APIs, external SMTP disabled, inbound email not accepted, DKIM/DNS descriptors only, Inbox is a private console API.

#### Why use it

Gate all regional sending during tests and switch between sandbox recipient restrictions and production limits without redeploying identities.

#### How it works in StackSim

Regional sending state, sandbox and production enforcement, configured quotas, IAM checks, durable audit state, and immediate effects on supported send APIs are active. Production profile does not create real deliverability or reputation behavior.

Sandbox mode accepts only verified recipients or mailbox-simulator addresses with effective limits of 200 recipients per 24 hours and 1 recipient per second. Production restores configured limits and accepts unverified recipients; a verified sender identity is still required.

#### Common AWS use cases

- Pause sending while debugging a runaway mail loop.
- Test sandbox recipient verification before switching to production profile.
- Confirm quota headers match application expectations.

#### Example

Pause sending → fix template rendering bug → resume → send test email → verify Inbox capture.

---

## Verified identities

### Identity catalog

#### What it is

Table of identities with name, type (email address or domain), verification status, and sending status. **Create identity** and **Refresh** in the header. Filter box searches names and statuses.

Info banner: email identities receive verification mail in the local Inbox; domain DNS is never queried; pending domains can be verified for local use from the detail page.

#### Why use it

SES requires verified senders before applications may use an address or domain in the From field.

#### How it works in StackSim

Email identities receive signed verification messages in the local Inbox. Domain identities expose deterministic descriptors and can be explicitly verified for local use. Sending enforcement, tags, default configuration sets, MAIL FROM state, identity policies, and supported CloudFormation resources are active. No public DNS lookup or DKIM signing.

#### Common AWS use cases

- `noreply@example.com` — transactional sender for an application.
- `example.com` — domain identity for multiple addresses under the domain.
- Tag identities by environment or application.

---

### Create identity (modal)

#### What it is

| Field | Purpose |
|-------|---------|
| **Email address or domain** | Identity to verify |
| **Tags (JSON object)** | Optional labels |

Email addresses trigger a verification message in the Inbox. Domains remain pending until explicitly verified locally.

#### Why use it

Seed sender identities before wiring application code to `SendEmail` or `SendTemplatedEmail`.

#### Example

```text
Identity: sender@example.test
Tags:     {"Application":"billing"}
```

---

### Identity detail

Route: `#/ses/identities/{name}`.

#### What it is

**Identity details** — verification status, type, sending enabled, default configuration set, ARN, Region.

**Default configuration set** — dropdown and **Save association** to inherit sending controls for this sender.

**MAIL FROM and feedback** — MAIL FROM domain, MX failure behavior, MAIL FROM status, feedback forwarding. **Edit MAIL FROM** modal.

**Sending authorization policies** — named JSON policies with **Add or update policy** and **Delete**.

**DKIM descriptors** — token table (descriptor only; no DNS publication or signing).

**Tags** table.

Actions: **Resend verification email** (pending email identities), **Verify for local use** (pending domains — requires typing domain name), **Delete**.

Pending email banner: check the local Inbox; verification link expires after 24 hours and is single-use.

Pending domain banner: DKIM values are descriptors; local verify marks ownership only in this account and Region.

#### Why use it

Configure sender-specific defaults, delegated sending permissions, and bounce envelope settings.

#### How it works in StackSim

Association, removal, persistence, dependency validation, and inheritance during supported sends are active for configuration sets. MAIL FROM domains, validation, failure behavior, status, and feedback settings persist as control state only — no DNS or MX contact. Named identity-policy create, update, list, delete, validation, and explicit-deny evaluation are active.

#### Common AWS use cases

- Associate `transactional` configuration set with `noreply@example.com`.
- Authorization policy allowing another account to send through this identity.
- Custom MAIL FROM domain `mail.example.com` for bounce handling (control plane only locally).

#### Example authorization policy

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "111122223333"},
    "Action": "ses:SendEmail",
    "Resource": "arn:aws:ses:eu-west-1:000000000000:identity/noreply@example.com"
  }]
}
```

---

## Send test email

Route: `#/ses/send-test`. Optional query `?template={name}` pre-selects a template.

### Message addresses

#### What it is

| Field | Purpose |
|-------|---------|
| **From email address** | Verified email identity |
| **To** | Primary recipients (comma, semicolon, or newline separated) |
| **Cc** | Visible copy recipients |
| **Bcc** | Envelope-only copy recipients |
| **Reply-To** | Reply destination headers |

#### Why use it

Exercise the official SES v2 `SendEmail` route and inspect the committed result in the Inbox without external delivery.

#### How it works in StackSim

Verified sender enforcement, To/Cc/Bcc and Reply-To parsing, syntax and recipient limits, sandbox restrictions, quota accounting, deduplication rules, and durable local capture are active. No recipient is contacted externally.

---

### Content

#### What it is

| Field | Purpose |
|-------|---------|
| **Content type** | Simple email or stored template |
| **Configuration set** | Optional sending controls |
| **Subject / Text / HTML** | Simple mode bodies |
| **Stored template / Template data** | Template mode name and JSON substitution object |

**Send test email** calls `sesV2 outbound-emails` and navigates to the Inbox message on success.

Info banner: successful response means SES accepted the message into the durable local mailbox — not remote delivery.

#### Why use it

Validate templates, configuration sets, and address parsing before integrating application code.

#### How it works in StackSim

Simple and stored-template sends, UTF-8 content, JSON substitution, render failures, configuration-set enforcement, and durable Inbox capture are active. This form does not expose raw MIME, attachments, bulk personalization, or every API field.

#### Example (simple)

```text
From:    sender@example.test
To:      alice@example.test
Subject: Hello from StackSim
Text:    This message was captured locally.
```

#### Example (template)

```text
Template:      welcome-email
Template data: {"name":"Alice","product":"StackSim"}
```

---

## Inbox

Route: `#/ses/inbox`. Query parameters: `recipient`, `status` (`all`, `unread`, `trash`), `originService` (for example `cognito-idp`).

### Mailbox messages

#### What it is

Filter form:

| Field | Purpose |
|-------|---------|
| **Exact envelope recipient** | Filter with datalist suggestions |
| **Mailbox view** | Inbox, Unread, or Trash |

Table columns: status, subject (with preview), from, envelope recipients, captured time, outcome (render status · disposition), actions (read/unread, trash/restore/purge).

Pagination with Previous/Next. **Purge all Trash** when viewing trash.

Info banner: every row is one logical SES-accepted message. **Captured** never means delivered. Cognito filter shows confirmation messages only.

#### Why use it

Inspect rendered content, verification links, and diagnostic outcomes without an external mail provider.

#### How it works in StackSim

Durable regional capture, recipient suggestions and exact filtering, pagination, read state, Trash, restore, permanent purge, template and configuration links, raw downloads, and accepted suppression or rendering-failure rows are active. It is not an SES API mailbox and accepts no inbound internet email.

#### Common AWS use cases

- Read Cognito verification or password-reset emails during auth testing.
- Filter by `alice@example.test` to see all mail addressed to a test user.
- Trash spammy test messages; purge when cleaning up.

---

### Message detail

Route: `#/ses/inbox/{messageId}`.

#### What it is

Alert with render status and disposition (Captured, Suppressed, or rendering failure details).

**Message details** — From, Reply-To, return path, To/Cc/Bcc, envelope recipients, accepted time, API family and operation.

**Send context** — template, configuration set, message tags (when present).

**Headers** table (when captured).

**Content** — Text and HTML tabs; sanitized HTML in sandboxed iframe; download normalized or original raw `.eml`.

**Attachments** — download per attachment.

Actions: mark read/unread, trash, restore, purge. Opening an unread message marks it read automatically.

#### Why use it

Deep inspection of a single captured send — headers, bodies, attachments, and rendering diagnostics.

#### How it works in StackSim

HTML is sanitized (scripts removed, external links labeled, images replaced with alt text). Raw downloads use the private Inbox API. Rendering failures show no fabricated body.

#### Example workflow

Send test email → open Inbox row → click verification link in HTML tab → confirm identity verified.

---

## Email templates

Route: `#/ses/templates`.

### Template catalog

#### What it is

Table of template names with created date and **Send test** shortcut. **Create template** opens the editor modal.

#### Why use it

Store reusable subject, text, and HTML with placeholders for personalized sends.

#### How it works in StackSim

Shared Classic and v2 template catalog, creation, retrieval, update, deletion, tags, pagination, validation, test rendering, templated sends, bulk API personalization, and supported CloudFormation resources are active.

---

### Create / edit template (modal)

| Field | Purpose |
|-------|---------|
| **Template name** | Immutable identifier (create only) |
| **Subject** | Template subject line |
| **Text body** | Plain-text portion |
| **HTML body** | HTML portion |
| **Tags** | JSON object (create only) |

Placeholders use SES template syntax (for example `{{name}}`).

---

### Template detail

Route: `#/ses/templates/{name}`.

#### What it is

**Template content** — subject, text, and HTML previews. **Edit** and **Delete**.

**Test render** — JSON template data and **Render template** button; shows rendered MIME without sending.

**Tags** table.

**Send test email** link with template pre-selected.

#### Why use it

Validate substitutions before application sends; edit content without redeploying code.

#### How it works in StackSim

Official `TestRenderTemplate` behavior, JSON validation, placeholder substitution, deterministic MIME rendering, and modeled rendering errors are active. Rendering does not consume sending quota or create an Inbox row.

#### Example template data

```json
{"name": "Alice", "orderId": "ORD-12345", "total": "49.99"}
```

---

## Configuration sets

Route: `#/ses/configuration-sets`.

### Configuration set catalog

#### What it is

Table with name, sending state, and capabilities note ("Local capture controls only"). **Create configuration set** modal.

Info banner: sending state is active; reputation, dedicated pools, TLS, VDM, and archiving are not success-shaped placeholders.

#### Why use it

Group sends under a named control for sending state, suppression options, and measurable event destinations.

#### How it works in StackSim

Classic/v2 lifecycle, tags, immediate sending-state enforcement, identity inheritance, suppression options, supported CloudWatch and EventBridge destinations, tracking descriptors, and CloudFormation resources are active. Reputation dashboards, dedicated IP pools, TLS policy, archiving, and VDM are unavailable.

---

### Create configuration set (modal)

| Field | Purpose |
|-------|---------|
| **Configuration set name** | Identifier |
| **Enable sending** | Initial sending state |
| **Tags** | JSON object |

---

### Configuration set detail

Route: `#/ses/configuration-sets/{name}`.

#### What it is

**Configuration** — name, sending state, event destination count, tracking domain, suppressed reasons, dedicated pools/VDM note.

Actions: **Suppression options**, **Add event destination**, **Pause sending** / **Enable sending**, **Delete**.

**Event destinations** table — name, destination type (CloudWatch or EventBridge default bus), matching events, enabled state, **Delete**.

Info banner: measurable local events only — SEND, REJECT, rendering-failure, and explicit local-link outcomes. Remote delivery, ISP, open, and complaint events are never invented.

**Tags** table.

#### Suppression options (modal)

Checkboxes for **Bounce** and **Complaint** reasons to suppress at send time through this configuration set.

#### Add event destination (modal)

| Field | Purpose |
|-------|---------|
| **Name** | Destination identifier |
| **Destination** | EventBridge default bus or CloudWatch metrics |
| **Matching events** | Comma-separated (default `SEND,REJECT,RENDERING_FAILURE`) |
| **CloudWatch dimension name** | For metric destinations |

#### Why use it

Pause a class of mail independently of account-wide sending; route measurable outcomes to CloudWatch or EventBridge for automation.

#### How it works in StackSim

CloudWatch metric destinations and the default EventBridge bus support SEND, REJECT, rendering-failure, and bounded local-link outcomes with lifecycle and IAM enforcement. Named buses, SNS, Firehose, Pinpoint, and fabricated delivery events are unavailable.

#### Example

```text
Name:              transactional
Sending:           Enabled
Suppressed:        BOUNCE, COMPLAINT
Event destination: cloudwatch-metrics → SEND, REJECT
```

---

## Suppression list

Route: `#/ses/suppression`.

### Suppressed destinations

#### What it is

Table of email addresses with reason (Bounce or Complaint), last updated, and **Remove**. **Add email address** modal.

Info banner: SES returns a message ID and retains inspectable content, but marks the mailbox row **Suppressed** instead of **Captured**. No remote bounce or complaint is fabricated.

#### Why use it

Test how applications and configuration-set options handle known bad recipients.

#### How it works in StackSim

Add, inspect, filter, paginate, and remove operations, BOUNCE and COMPLAINT reasons, send-time enforcement, retained diagnostic content, metrics, IAM, and restart persistence are active.

#### Example

Add `bad@example.test` with reason **Bounce** → send test email → Inbox shows Suppressed disposition.

---

## Contact lists

Route: `#/ses/contact-lists`.

### Contact list catalog

#### What it is

Table of list names and last updated. **Create contact list** modal with name, description, and topics JSON array.

#### Why use it

Model subscription topics and per-contact opt-in/opt-out for list-management sends.

#### How it works in StackSim

Contact-list lifecycle, descriptions, topic definitions and validation, tags through the API, pagination, dependencies, local unsubscribe state and signed links, IAM, and restart persistence are active. Campaign orchestration and external list providers are unavailable.

---

### Contact list detail

Route: `#/ses/contact-lists/{name}`.

#### What it is

**Topics** — topic name, display name, default subscription status.

**Contacts** — email address, unsubscribe-all flag, topic preferences, **Delete**.

**Add contact** modal: email, topic preferences JSON array, unsubscribe-all checkbox.

**Delete list** removes the list and its contacts.

#### Why use it

Test personalized consent decisions before sending list-management email through the API.

#### Example topics JSON

```json
[
  {"TopicName": "news", "DisplayName": "Product news", "DefaultSubscriptionStatus": "OPT_IN"},
  {"TopicName": "offers", "DisplayName": "Special offers", "DefaultSubscriptionStatus": "OPT_OUT"}
]
```

---

## Custom verification templates

Route: `#/ses/custom-verification-templates`.

### Verification templates

#### What it is

Table of template name, From address, subject, and **Delete**. **Create template** modal:

| Field | Purpose |
|-------|---------|
| **Name** | Template identifier |
| **Verified From address** | Must be a verified identity |
| **Subject** | Verification email subject |
| **HTML content** | Must include `{{verificationURL}}` placeholder |
| **Success URL** | Localhost redirect after successful verification |
| **Failure URL** | Localhost redirect after failed verification |

#### Why use it

Customize verification email branding while retaining signed local verification links.

#### How it works in StackSim

Classic/v2 lifecycle, validation, verified-From enforcement, signed local verification links, bounded localhost redirect handling, tags through the API, IAM, and restart persistence are active. Messages are captured locally; the callback cannot become an open redirect.

#### Example HTML

```html
<p>Please verify your email:</p>
<a href="{{verificationURL}}">Verify email address</a>
```

---

## Sending statistics

Route: `#/ses/statistics`.

### Last 24-hour metrics

#### What it is

Cards for **Send**, **Captured locally** (DELIVERY metric), **Suppressed / rejected**, and **Rendering failures** — committed outcomes from the last 24 hours. **Refresh** reloads.

Info banner: Delivery means captured in the simulator Inbox. No remote mailbox, ISP, open, or complaint outcome is inferred.

#### Why use it

Quick sanity check after a test session — compare sends vs captures vs rejections.

#### How it works in StackSim

Metrics come from `sesV2 metrics/batch` using only locally measured SES outcomes.

---

## Cognito and other integrations

| Service | Integration |
|---------|-------------|
| **Cognito** | User-pool emails captured in Inbox; filter with `?originService=cognito-idp` |
| **EventBridge** | Configuration-set event destinations to default bus |
| **CloudWatch** | Configuration-set metric destinations; account-level metrics via API |
| **IAM** | Send APIs require appropriate identity policies |

When testing Cognito sign-up or password reset, open **Inbox** (optionally with the Cognito filter) instead of checking external mail.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| External SMTP | Disabled |
| Remote delivery | Never attempted |
| Inbound internet email | Not accepted |
| Inbox | Private console API; not an SES API |
| DNS / DKIM | Descriptors only; no lookup or signing |
| Domain verification | Local-only "Verify for local use" action |
| Email verification links | Signed localhost URLs; 24-hour expiry; single use |
| Sandbox profile | 200 recipients/day, 1/sec; verified recipients only |
| Production profile | Configured quota; unverified recipients allowed |
| Attachments | Captured when sent via compatible API routes |
| Raw MIME download | Available from Inbox message detail |
| Dedicated IP pools | Unavailable |
| Reputation dashboards | Unavailable |
| Bounce/complaint SNS topics | Unavailable — use suppression list locally |
| Virtual Deliverability Manager | Unavailable |

---

## Related StackSim docs

- [Cognito console guide](./cognito-console-guide.md) — user-pool email flows captured in the Inbox
- [IAM console guide](./iam-console-guide.md) — `ses:SendEmail` and identity authorization policies
- [EventBridge console guide](./eventbridge-console-guide.md) — configuration-set event destinations
- [Parameter Store console guide](./parameter-store-console-guide.md) — application configuration separate from mail
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — credentials for apps sending mail
- [API Gateway console guide](./apigateway-console-guide.md) — HTTP APIs that trigger email sends
- [SQS console guide](./sqs-console-guide.md) — async queues vs email delivery
- [SNS console guide](./sns-console-guide.md) — pub/sub vs email notification paths
- [Lambda console guide](./lambda-console-guide.md) — send mail from functions via SES API
- [Developer guide](./developer-guide.md) — application email patterns
- [Reference](./reference.md) — SES API summary
- [AWS CLI cookbook](./aws-cli-cookbook.md) — SES CLI examples
