# StackSim Cognito console guide

This guide explains every panel in the StackSim Cognito console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon Cognito User Pools behavior.

StackSim models user pools, users, groups, app clients, managed login, OAuth, federation, MFA, Lambda triggers, and signed JWTs locally. Where local behavior differs from AWS (for example DNS for hosted domains, SMS MFA, or Cognito Identity Pools), those boundaries are called out explicitly.

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

The Cognito service in StackSim has a left navigation bar with these top-level areas:

| Area | Purpose |
|------|---------|
| **Overview** | Account summary, integration notes, and quick links |
| **User pools** | Create, list, and open user pools |

Opening a user pool shows tabs: **Overview**, **Users**, **Groups**, **App clients**, **Managed login**, **Sign-in**, and **Self-service sign-up**.

StackSim implements **Cognito User Pools** only. **Cognito Identity Pools** (federated AWS credentials) are not available locally.

---

## Overview

### What it is

The **Overview** page summarizes regional user pools, total users, and app clients. It also lists local integration details: JSON 1.1 protocol, SDK client, SES Inbox delivery, issuer format, and JWKS tooling route.

### Why use it

In AWS, the Cognito landing page orients you toward user pools, getting-started tasks, and documentation before you configure sign-in for an application.

### How it works in StackSim

Counts reflect the local installation. The summary cards link to **User pools**. A **Create user pool** button opens the pool creation modal.

User counts are safe console summaries — no passwords, secrets, or token material appear on this page.

### Common AWS use cases

- Confirm pools exist after CDK or Terraform deploy.
- Navigate to **User pools** to open a specific directory.
- Copy integration notes before wiring an application SDK.

---

## User pools

### User pools (list)

#### What it is

The **User pools** panel lists every pool with name, status, user count, app client count, created date, and tags. You can filter the list, open a pool, refresh, or create a new one.

#### Why use it

Every Cognito-backed application starts with at least one user pool. The list view is where operators find pools by name and verify automation created the expected resources.

#### How it works in StackSim

User-pool creation, listing, updates, deletion, users, groups, password and SRP authentication, recovery, MFA, Lambda triggers, signed JWTs, and local JWKS are active and persist locally.

#### Common AWS use cases

- `production-users` — live application directory.
- `staging-users` — pre-production testing with separate clients.
- `internal-admin` — staff-only pool with administrator-created users.

#### Example

After deploying a CDK stack with `AWS::Cognito::UserPool`, open **User pools** and confirm the pool name, status `Active`, and expected tag keys appear in the list.

---

## Create user pool

### What it is

The **Create user pool** modal collects:

- **Pool name** — directory display name.
- **Sign-in option** — username, email address, or username with email alias.
- **Minimum password length** — 6–99 characters.
- **Self-service sign-up** — allow public registration or restrict to administrators.
- **Automatically verify email** — send confirmation codes for email.
- **Require email** — add `email` as a required schema attribute.
- **Usernames are case sensitive** — match sign-in identifier casing.
- **Deletion protection** — block accidental pool deletion.
- **Password requirements** — uppercase, lowercase, numbers, symbols.

An info note explains that email starts with the Cognito-default local sender; use the official API with a verified SES identity for the DEVELOPER profile.

### Why use it

Pool creation establishes the authentication contract for an application: how users sign in, how passwords are validated, whether users can self-register, and how email verification works.

### How it works in StackSim

The modal creates an **Essentials** tier pool with user administration, password/SRP authentication, groups, and local email confirmation. Advanced MFA and Lambda trigger settings can also be configured later through **Configure** on the pool overview or the official SDK.

Created pools persist locally. Verification codes are captured in the regional **SES Inbox**, never sent externally.

### Common AWS use cases

- B2C web app — email sign-in, self-service sign-up, auto-verify email.
- Internal tool — username sign-in, administrator-only creation.
- Mobile app backend — username with email alias, strict password policy.

### Example

For a notes API tutorial pool:

```text
Pool name:           notes-users
Sign-in option:      Email address
Minimum length:      8
Self-service sign-up: enabled
Auto-verify email:   enabled
Require email:       enabled
Password rules:      uppercase, lowercase, numbers, symbols
```

---

## User pool: Overview tab

### Pool summary cards

#### What it is

Three summary cards show **Users**, **App clients**, and **Messaging** (sending account and verification method), with links to the relevant tabs and SES Inbox.

#### Why use it

Operators quickly see whether a pool has registered users, configured clients, and working email delivery before debugging authentication failures.

#### How it works in StackSim

Counts and messaging settings reflect live local state. **Open filtered SES Inbox** shows Cognito confirmation and invitation messages for this pool.

---

### Pool details

#### What it is

**Pool details** displays pool ID, status, tier, ARN, created/updated timestamps, deletion protection, and tags.

Header actions: **Configure** (MFA, Lambda triggers, tags) and **Delete** (disabled when deletion protection is active).

#### Why use it

The overview is the canonical place to read pool metadata, confirm tier, and manage pool-wide settings that affect every user and client.

#### How it works in StackSim

MFA modes, software-token settings, supported Lambda triggers, tags, and deletion protection are active. Trigger functions need a Cognito service-principal resource-policy permission for this pool ARN.

#### Common AWS use cases

- Attach `PreTokenGeneration` to inject custom claims.
- Enable optional TOTP MFA for privileged accounts.
- Tag pools for cost allocation (`Environment=prod`).

#### Example

Configure MFA as **Optional** with software-token MFA enabled, then set `PreTokenGeneration` to a Lambda ARN that adds `tenantId` to ID tokens.

---

### Configure user pool (modal)

#### What it is

The **Configure user pool** modal edits:

- **MFA mode** — Off, Optional, or Required.
- **Software-token MFA** — enable TOTP second factor.
- **Lambda trigger ARNs** — Pre sign-up, Custom message, Post confirmation, Pre authentication, Post authentication, Pre token generation.
- **Tags** — one `key=value` per line.

#### Why use it

Pool-wide hooks and MFA policy apply to every authentication path — direct SDK flows, managed login, and federated sign-in.

#### How it works in StackSim

Trigger failures fail closed and never expose passwords or token material. Lambda functions must grant `cognito-idp.amazonaws.com` permission with this pool ARN as `SourceArn`.

SMS MFA is unavailable locally; software-token and email OTP are supported.

---

### Token issuer and public keys

#### What it is

Shows the **canonical issuer** (`https://cognito-idp.{region}.amazonaws.com/{poolId}`) and a **local JWKS URL** for token verification during development.

#### Why use it

API Gateway Cognito authorizers, Lambda authorizers, and application middleware verify JWT signatures against the pool issuer and JWKS document.

#### How it works in StackSim

Tokens keep the provider-compatible issuer. The loopback JWKS URL is developer tooling — it does not change the token issuer or contact public AWS endpoints.

#### Common AWS use cases

- Configure API Gateway `COGNITO_USER_POOLS` authorizer with this pool.
- Point local JWT middleware at the loopback JWKS URL during integration tests.

---

### Email confirmation

#### What it is

Displays sending account, verification method, subject, from address, and a link to **Open Cognito confirmation messages** in the SES Inbox.

#### Why use it

Sign-up and password recovery depend on deliverable verification messages. Operators confirm templates and sender configuration when users report missing codes.

#### How it works in StackSim

Email is captured in the regional SES Inbox. External mail is never sent. The console never reveals confirmation codes or their digests.

#### Common AWS use cases

- Self-service sign-up with email confirmation code.
- Administrator invitation with temporary password email.
- Forgot-password flow delivering a reset code.

---

## User pool: Users tab

### Users (list)

#### What it is

The **Users** panel lists users with email/username, status (`CONFIRMED`, `UNCONFIRMED`, etc.), enabled/disabled access, email verification, and created date. **Create user** opens the administrator provisioning modal.

#### Why use it

Administrator-created users support onboarding flows where sign-up is disabled, bulk provisioning, or help-desk account creation.

#### How it works in StackSim

User creation, temporary passwords, confirmation status, email verification, enable/disable, pagination, search, and local SES invitation capture are active. Generated temporary passwords and confirmation codes are never displayed by the console.

#### Common AWS use cases

- HR provisions employees before first login.
- Support creates a test account with a temporary password.
- Admin marks email verified to skip confirmation for trusted addresses.

#### Example

Create user with email `user@example.test`, mark email verified, enable invitation delivery — then open the SES Inbox to read the welcome message and temporary password (as an application user would).

---

### Create user (modal)

#### What it is

Fields include:

- **Email address** or **Username** (depending on pool sign-in configuration).
- **Email address** (when username sign-in is used).
- **Temporary password** (optional — Cognito generates one if omitted).
- **Mark email as verified**.
- **Send invitation to the SES Inbox**.
- **Pool-defined attributes** — required or optional schema fields at creation time.

#### Why use it

`AdminCreateUser` establishes accounts without public sign-up and optionally forces a password change at first sign-in.

#### How it works in StackSim

Immutable custom attributes can only be supplied during creation. Invitation emails appear in the SES Inbox; suppress delivery with **Send invitation** unchecked (maps to `MessageAction: SUPPRESS`).

---

## User pool: User detail

### User details

#### What it is

The **User details** panel shows status, enabled flag, active session count, sub, username, and timestamps. Actions: **Enable/Disable**, **Set password**, **Reset password**, **Sign out**, **Delete**.

#### Why use it

After creation, operators manage account lifecycle: lock compromised accounts, force password rotation, revoke sessions, or remove users.

#### How it works in StackSim

Account status, password policy enforcement, reset delivery through the SES Inbox, token-session revocation, and deletion are active. Existing access tokens remain valid until expiry unless the consuming application checks revocation.

#### Common AWS use cases

- Disable a departed employee immediately.
- Reset password and deliver code via email.
- Revoke refresh sessions after credential leak.

---

### Attributes

#### What it is

A table of user attributes (name, value, verification status) with **Edit**, **Remove**, and **Add attribute** actions for mutable pool-defined fields.

#### Why use it

Profile data drives application behavior, marketing preferences, and authorization decisions derived from token claims.

#### How it works in StackSim

Schema validation, mutable attribute add/edit/remove, verification flags, required fields, and string or number constraints are active. Immutable attributes can be supplied only when the user is created.

Verifiable attributes (`email`, `phone_number`) support administrator verification toggles.

#### Common AWS use cases

- Store `custom:department` for internal routing.
- Update display name after marriage.
- Mark email verified after manual identity check.

---

### Groups and MFA (user level)

#### What it is

Shows current **Groups** membership and **MFA methods** with preferred method. **Edit groups** and **Edit email MFA** open configuration modals.

#### Why use it

Group membership adds `cognito:groups` and `cognito:preferred_role` claims to newly issued tokens. Per-user MFA preference controls whether email OTP is used at sign-in.

#### How it works in StackSim

Membership changes, precedence and role claims, email OTP preferences, software-token MFA APIs, and newly issued token claims are active. Existing tokens are not rewritten after a group change. SMS MFA is unavailable.

#### Common AWS use cases

- Add user to `admins` group for elevated API access.
- Enable email OTP for users without authenticator apps.

---

## User pool: Groups tab

### Groups (list)

#### What it is

The **Groups** panel lists groups with name, description, precedence, IAM role ARN, member count, and delete action. **Create group** opens a modal.

#### Why use it

Groups organize users and inject authorization claims into ID and access tokens without maintaining separate role databases in the application.

#### How it works in StackSim

Group creation, deletion, membership, precedence, role claims, listing, and search are active. IAM role assumption itself is outside the user-pool service and is not performed by this panel.

An info note reminds that group changes appear in newly issued tokens only.

#### Common AWS use cases

- `readers` / `editors` / `admins` for content APIs.
- Precedence `1` on `admins` when a user belongs to multiple groups with roles.
- Role ARN for cross-service access via `cognito:preferred_role`.

#### Example

```text
Group name:    editors
Description:   Can create and update notes
Precedence:    10
IAM role ARN:  arn:aws:iam::123456789012:role/NotesEditor
```

---

### Create group (modal)

#### What it is

Fields: **Group name**, **Description**, **Precedence** (optional), **IAM role ARN** (optional).

#### Why use it

Precedence resolves which group's IAM role becomes `cognito:preferred_role` when a user belongs to multiple groups that define roles.

#### How it works in StackSim

Same as groups list — membership and claims are active; STS role assumption is not simulated here.

---

## User pool: App clients tab

### App clients (list)

#### What it is

Lists app clients with name, enabled authentication flows, whether a client secret exists (never revealed), and created date. **Create app client** opens the creation modal.

#### Why use it

Each application (web, mobile, machine-to-machine) needs its own client with appropriate flows, token lifetimes, and OAuth settings.

#### How it works in StackSim

Password, administrator-password, SRP, and refresh flows; client secrets; token validity; revocation; refresh rotation; managed-login OAuth; and exact callback validation are active. Secrets are write-only and never redisplayed.

#### Common AWS use cases

- SPA — authorization code + PKCE, no client secret.
- Backend service — client credentials or admin password flow with secret.
- Mobile app — SRP + refresh token rotation.

---

### Create app client (modal)

#### What it is

Collects:

- **App client name**
- **Authentication flows** — `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`
- **Token validity** — access (hours), ID (hours), refresh (days)
- **Generate a client secret**
- **Prevent user-existence errors**, **Enable token revocation**, **Enable refresh-token rotation**
- **Managed login and OAuth** — enable OAuth, callback URLs, logout URLs, scopes, authorization code + PKCE, implicit grant

#### Why use it

Principle of least privilege: enable only the flows and grants the application actually uses.

#### How it works in StackSim

Refresh-token rotation replaces `ALLOW_REFRESH_TOKEN_AUTH` when enabled. Callback URLs must match exactly for managed login redirects.

#### Example

Local web app client:

```text
Name:              local-web
Flows:             USER_PASSWORD_AUTH, REFRESH_TOKEN_AUTH
Access/ID validity: 1 hour
Refresh validity:  30 days
OAuth:             enabled
Callback URL:      http://127.0.0.1:3000/callback
Scopes:            openid email profile
Grant:             Authorization code + PKCE
```

---

## User pool: App client detail

### App client details

#### What it is

Shows client name, client ID, secret presence, user-existence error setting, token revocation, created date, enabled authentication flows, token validity table, and hosted authentication (OAuth grants, providers, callback/logout URLs, scopes). Actions: **Edit OAuth settings**, **Delete**.

#### Why use it

The detail page is where you verify a deployed client's configuration matches application expectations before debugging sign-in failures.

#### How it works in StackSim

Client lifecycle, direct flows, token issuance, OAuth configuration, provider associations, revision-safe updates, and refresh-session revocation are active on local Cognito endpoints.

#### Common AWS use cases

- Confirm callback URL matches deployed frontend origin.
- Enable Cognito plus a SAML provider for enterprise SSO.
- Add custom resource-server scopes to allowed OAuth scopes.

---

### Edit OAuth settings (modal)

#### What it is

Edits managed-login OAuth enablement, callback URLs, logout URLs, allowed scopes, identity providers (Cognito plus configured external providers), and grant types (authorization code, implicit, client credentials).

#### Why use it

OAuth settings connect managed login and federated IdPs to a specific application redirect URI and scope contract.

#### How it works in StackSim

Exact callback validation applies. External providers must be created on the **Managed login** tab first, then enabled per client.

---

## User pool: Managed login tab

### User-pool domain

#### What it is

Configures a **domain prefix** and **managed login version** (2 · Managed login or 1 · Hosted UI classic). When configured, shows local domain base URL and **Open managed login** link.

#### Why use it

A stable domain hosts OAuth authorize, token, logout, and discovery endpoints for browser-based sign-in.

#### How it works in StackSim

Domain uniqueness, managed-login versions, discovery, authorize, token, logout, and local login routes are active. The domain is a local descriptor — it does not provision DNS, CloudFront, ACM certificates, public TLS, or an AWS-hosted domain.

#### Common AWS use cases

- `myapp.auth.{region}.amazoncognito.com` equivalent for browser login.
- OAuth 2.0 authorization code flow with PKCE.

#### Example

```text
Domain prefix:          my-local-app
Managed login version:  2
Local base URL:         (shown in console — use for authorize redirects)
```

---

### Issuer and local tooling aliases

#### What it is

Displays canonical issuer, **Discovery URL**, and **JWKS URL** for OAuth/OIDC clients.

#### Why use it

OIDC libraries fetch `.well-known/openid-configuration` and JWKS to validate tokens and build authorize URLs.

#### How it works in StackSim

Discovery and JWKS use loopback tooling aliases. Managed-login endpoints are distinct and never replace the token issuer.

---

### Social and external providers

#### What it is

Lists OIDC and SAML 2.0 identity providers with identifiers, attribute mappings, certificate fingerprints, enabled client count, and **Test**, **Edit**, **Delete** actions. **Create provider** opens a modal.

Create/edit fields: provider name, protocol (OIDC or SAML), provider details JSON, attribute mapping JSON, IdP identifiers.

#### Why use it

Federation lets users sign in with corporate IdP, Google, or other standards-compatible providers while Cognito still issues application tokens.

#### How it works in StackSim

OIDC discovery, signed SAML metadata and assertions, attribute mapping, client enablement, and connection tests are active. Loopback providers work by default. Public HTTPS providers require `STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true`. Private-network, metadata, and link-local targets remain blocked. Client secrets are write-only; certificates display fingerprints only.

#### Common AWS use cases

- Enterprise SAML SSO with attribute mapping `email ← mail`.
- OIDC social login with discovery issuer and client credentials.

#### Example (OIDC provider details)

```json
{
  "oidc_issuer": "http://127.0.0.1:8080",
  "client_id": "local-oidc-client",
  "client_secret": "secret",
  "authorize_scopes": "openid email profile"
}
```

---

### Resource servers

#### What it is

Lists resource servers (API identifiers) and custom scopes such as `https://api.example.test/read`. **Create resource server** accepts name, identifier, and scopes (`name | description` per line).

#### Why use it

Resource servers namespace custom OAuth scopes for API authorization — access tokens carry `scope` claims the API validates.

#### How it works in StackSim

Resource-server creation, deletion, scope validation, app-client scope selection, OAuth consent, and access-token scope claims are active locally.

#### Common AWS use cases

- Protect microservice with scope `api/read`.
- Machine-to-machine client credentials requesting `api/write`.

---

### Managed-login branding

#### What it is

Per app client, set **Page title** and **Primary color** (#RRGGBB) for the local version 2 login page.

#### Why use it

Branding gives users recognizable application context on the hosted sign-in page.

#### How it works in StackSim

The local version 2 login page applies client-specific page title and six-digit primary color. Logos, images, advanced style tokens, and the broader AWS managed-login branding editor are not implemented. Branding requires managed login version 2.

---

## User pool: Sign-in tab

### Sign-in experience

#### What it is

Read-only summary of sign-in identifier mode (email, username, or username with email alias), case sensitivity, account recovery, MFA mode and methods, passwordless availability, and whether SRP is enabled by any app client.

#### Why use it

Operators verify pool-level sign-in policy matches product requirements without opening CloudFormation or SDK responses.

#### How it works in StackSim

Reflects pool configuration set at creation and through **Configure**. Passwordless sign-in is unavailable locally.

---

### Password policy

#### What it is

Displays minimum length, character class requirements, temporary password validity days, and password history size.

#### Why use it

Password policy balances security and usability; operators confirm deployed settings when users report password rejection.

#### How it works in StackSim

Policy is enforced on user creation, password change, and administrator set-password operations.

---

### Enabled client flows

#### What it is

Aggregates authentication flows enabled across all app clients in the pool.

#### Why use it

Quick check that at least one client enables the flow your test script or application uses (for example SRP for mobile).

#### How it works in StackSim

Derived from app client configuration; edit clients on the **App clients** tab to change flows.

---

## User pool: Self-service sign-up tab

### Self-service sign-up

#### What it is

Shows whether public sign-up is enabled, required attributes, automatic verification attributes, delivery method (email via local SES), and SMS availability.

#### Why use it

Self-service sign-up is the default for consumer applications; administrators disable it for invite-only or enterprise pools.

#### How it works in StackSim

Sign-up availability is set at pool creation (`AllowAdminCreateUserOnly`). SMS is unavailable.

---

### Verification message

#### What it is

Displays sending account, sender, subject, and link to the filtered SES Inbox.

#### Why use it

Confirm verification templates before users attempt registration.

#### How it works in StackSim

Codes stay in captured email only — the console never exposes them.

---

### Custom attributes

#### What it is

Lists `custom:` schema definitions (type, mutability, constraints). **Add custom attribute** opens a modal with name, data type (String, Number, Boolean, DateTime), mutability, and type-specific constraints.

#### Why use it

Custom attributes extend the user directory with application-specific profile or authorization data without a separate database.

#### How it works in StackSim

Schema creation, naming and type validation, string and number constraints, creation-time values, mutable updates, and token read/write attribute behavior are active. Custom attribute definitions **cannot be removed** after creation. Immutable values can be set only when a user is created.

#### Common AWS use cases

- `custom:tenantId` — immutable tenant assignment at registration.
- `custom:department` — mutable HR field updatable by administrators.

#### Example

```text
Name:     department
Type:     String
Mutable:  yes
Min/max:  2–20 characters
```

Stored as `custom:department` on users and available in tokens when configured for read/write on app clients.

---

### Advanced sign-up features

#### What it is

Summary of configured Lambda triggers, custom attribute count, managed login for terms/branding, and pointer to external identity providers on **Managed login**.

#### Why use it

Overview of sign-up pipeline extensions before testing registration end-to-end.

#### How it works in StackSim

Lambda triggers execute on supported lifecycle events when ARNs are configured and permitted.

---

## Authentication flows reference

| Flow | Typical client | Use when |
|------|----------------|----------|
| **USER_PASSWORD_AUTH** | Web/mobile with backend | Simple username/password against Cognito |
| **ADMIN_USER_PASSWORD_AUTH** | Trusted server | Admin or migration scripts authenticate users |
| **USER_SRP_AUTH** | Mobile | Secure remote password protocol |
| **REFRESH_TOKEN_AUTH** | All long-lived sessions | Obtain new access/ID tokens without re-login |
| **Authorization code + PKCE** | SPA | Browser OAuth without client secret |
| **Client credentials** | Service | Machine-to-machine with scopes |

---

## Token types reference

| Token | Contains | Verify with |
|-------|----------|-------------|
| **ID token** | User identity claims (`sub`, `email`, groups) | Pool issuer + JWKS; required for unscoped API Gateway Cognito authorizers |
| **Access token** | Scopes, client_id, username | Pool issuer + JWKS; used when methods declare `authorizationScopes` |
| **Refresh token** | Opaque session handle | Cognito token endpoint only; rotate when enabled |

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Cognito Identity Pools | Not available |
| SMS MFA / SMS verification | Unavailable |
| External email delivery | Never sent; use SES Inbox |
| Client secrets | Write-only; console shows existence only |
| Temporary passwords / codes | Never displayed in console |
| User-pool domain | Local descriptor; no DNS/TLS provisioning |
| Public IdP federation | Requires `STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true` |
| Private/metadata/link-local IdP targets | Blocked |
| KMS encryption | Not modeled for user pools |
| Advanced branding | Title and primary color only (managed login v2) |
| Token revocation | Supported; existing JWTs valid until expiry unless app checks revocation |
| SES DEVELOPER profile | Configure verified identity via official API |

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — Tutorial 2: protect an API with Cognito
- [IAM console guide](./iam-console-guide.md) — IAM users vs Cognito users; Lambda roles
- [EventBridge console guide](./eventbridge-console-guide.md) — custom auth events and triggers
- [API Gateway console guide](./apigateway-console-guide.md) — Cognito authorizers and JWT validation
- [Parameter Store console guide](./parameter-store-console-guide.md) — configuration values and SecureString secrets
- [DynamoDB console guide](./dynamodb-console-guide.md) — tables for user-owned application data
- [S3 console guide](./s3-console-guide.md) — object storage for user uploads
- [AWS CLI cookbook](./aws-cli-cookbook.md) — CLI examples for Cognito operations
- [SES console guide](./ses-console-guide.md) — verification and password-reset mail in the Inbox
- [Lambda console guide](./lambda-console-guide.md) — Cognito trigger targets
