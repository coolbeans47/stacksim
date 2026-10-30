# StackSim Cognito console guide

This guide explains every page of the StackSim Cognito console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon Cognito behavior.

StackSim models user pools, users, groups, app clients, choice-based and password sign-in, managed login, OAuth, OIDC and SAML federation, MFA, Lambda triggers, and signed JWTs locally. Identity pools share the Cognito console and exchange user pool ID tokens for temporary AWS credentials. Where local behavior differs from AWS (DNS for custom domains, SMS, passkeys, threat protection), the page says so.

---

## How to read this guide

Each page section says **what it is**, **why you use it**, and **how it works in StackSim**. Pages follow the current AWS console's menu, so a tutorial written for the AWS console should lead you to the same page here.

---

## Console navigation

The left navigation shows **User pools** and **Identity pools**. Opening a user pool replaces the rest of the menu with the pool's grouped menu, as in the AWS console:

| Group | Pages |
|-------|-------|
| — | **Overview** |
| Applications | **App clients** |
| User management | **Users**, **Groups** |
| Authentication | **Authentication methods**, **Sign-in**, **Sign-up**, **Social and external providers**, **Message templates** |
| Security | **Threat protection** |
| Branding | **Domain**, **Managed login** |
| Extensions | **Lambda triggers** |
| — | **Settings** (Feature plans, User pool security) |

The console never shows passwords, temporary passwords, confirmation codes, sessions, refresh tokens, private keys, identity-provider secrets, or client secrets. Not displaying client secrets is a StackSim policy: AWS has **Show client secret**, and `DescribeUserPoolClient` returns the secret to API callers here too.

Every editor calls the official Cognito operation (`UpdateUserPool`, `UpdateUserPoolClient`, `SetUserPoolMfaConfig`, `AdminConfirmSignUp`, …) through the console's private action route. Because `UpdateUserPool` and `UpdateUserPoolClient` reset omitted settings to their defaults, the console reads the current configuration first and sends it back with your change.

---

## User pools

**What it is.** The regional list of user pools with name, ID, created and last-updated time. Select a pool with its radio button to **Delete** it (deletion protection must be inactive); **Create user pool** opens the setup wizard.

**Why use it.** A user pool is the user directory and token issuer for one or more applications.

**How it works in StackSim.** Pools persist in the data directory. Pool names are friendly names and need not be unique, as on AWS.

## Create user pool (Set up resources for your application)

**What it is.** The AWS application-first wizard:

1. **Define your application** — choose an **Application type** (Traditional web application, Single-page application (SPA), Mobile app, Machine-to-machine application) and **Name your application**.
2. **Configure options** — **Options for sign-in identifiers** (Email, Phone number, Username), **Enable self-registration**, and **Required attributes for sign-up**.
3. **Add a return URL** (optional) — where managed login redirects after sign-in.
4. **Create user pool** — then **Set up your application** shows the issuer, client ID, JWKS URL, and an SDK sample; **Go to overview** opens the pool.

**Why use it.** One step gives a working pool and app client for the application you are building.

**How it works in StackSim.** The wizard creates the pool (case-insensitive user names and deletion protection active, like console-created AWS pools; the name is `User pool - <random>` until you rename it) and an app client. Traditional web and machine-to-machine clients get a client secret. User-facing clients enable `ALLOW_USER_AUTH`, SRP, and refresh, and prevent user-existence errors; a return URL adds the authorization-code grant with the OpenID scopes. A machine-to-machine client gets a `default-m2m-resource-server-<random>` resource server with a `read` scope and the client-credentials grant. Phone-number sign-in is disabled because SMS delivery is not implemented in this simulator.

---

## Overview

**What it is.** **User pool information** (name, ID, ARN, token signing key URL, estimated number of users, feature plan, created and updated time, deletion protection) with **Rename**; **Token issuer** (the AWS-shaped issuer and the local JWKS URL, plus a link to the filtered SES Inbox); and **Tags** as key/value rows with **Manage tags**.

**How it works in StackSim.** Tokens keep the issuer `https://cognito-idp.<region>.amazonaws.com/<pool id>`. The JWKS URL is loopback tooling; it never contacts AWS.

---

## App clients

**What it is.** The list of app clients (name, client ID, whether a secret exists, created time) and **Create app client**, which asks for the **Application type**, **App client name**, and an optional **Return URL**.

Opening a client shows **App client information** with **Edit** and **Delete**, then three tabs:

- **Quick setup guide** — issuer, client ID, and discovery URL for an OpenID Connect library.
- **Login pages** — **Managed login pages configuration** with **Edit**: allowed callback and sign-out URLs, identity providers, OAuth 2.0 grant types, OpenID Connect scopes, and custom scopes (checkboxes from your resource servers). **View login page** opens managed login when the pool has a domain.
- **Attribute permissions** — which attributes the client can read and write, with **Edit**.

**Edit** on App client information changes the name, authentication flows (shown with the console's descriptions, for example *Choice-based sign-in* for `ALLOW_USER_AUTH`), authentication-flow session duration, refresh/access/ID token expiration with minutes/hours/days units, token revocation, user-existence errors, and refresh-token rotation with its grace period.

**How it works in StackSim.** All nine `ExplicitAuthFlows` values are accepted, including the legacy names. A client created without attribute lists reads every standard attribute plus `email_verified` and `phone_number_verified` and writes every standard attribute; custom attributes need an explicit list. Authorization-code requests must use PKCE S256 (local policy). Rotation requires `GetTokensFromRefreshToken` and cannot be combined with `ALLOW_REFRESH_TOKEN_AUTH`.

---

## Users

**What it is.** A table with **User name**, **Email address**, **Email verified**, **Confirmation status**, and **Status** (Enabled/Disabled). Search by an attribute — User name, Email, Phone number, Name, Given name, Family name, Preferred user name, User ID (sub), Confirmation status, or Status — with a starts-with match, and page through results with **Previous page**/**Next page**. Select a disabled user to **Delete user**; **Create user** opens the form.

**Create user** has **Invitation message** (Send an email invitation; Don't send an invitation; SMS is shown but unavailable locally), **User name** (when the pool does not sign in with email), **Email address** with **Mark email address as verified**, **Phone number** with **Mark phone number as verified**, **Temporary password** (Generate a password / Set a password), and any pool-defined attributes. Immutable custom attributes can be supplied only here.

**How it works in StackSim.** Search uses `ListUsers` filters, so it accepts the ten searchable attributes AWS documents. Invitations are captured in the SES Inbox; generated temporary passwords are never shown.

### User details

**What it is.** **User information** with an **Actions** menu: Reset password, Set password, Confirm account (for self-registered unconfirmed users), Disable/Enable user access, Sign out of all sessions, and Delete user (available after access is disabled). Every action asks for confirmation. Below are **User attributes** (Add attribute, Edit, Remove, Mark as verified for email and phone), **Group memberships** (Add user to group, Edit MFA preference), and **User event history** (recent sign-in events).

**How it works in StackSim.** Disabling a user revokes refresh sessions; already issued access tokens stay valid until they expire. Reset password delivers a code to the SES Inbox. Email-message MFA can be preferred only after the pool enables it on **Sign-in**.

---

## Groups

**What it is.** Groups with name, description, precedence, IAM role ARN, and created time; select one to **Delete**, or **Create group** (name, description, precedence, and an IAM role chosen from your IAM roles). Opening a group shows **Group information** with **Edit** and **Delete**, and **Group members** with **Add user to group** and **Remove from group**.

**How it works in StackSim.** Groups add `cognito:groups`, `cognito:roles`, and `cognito:preferred_role` to newly issued tokens. Existing tokens are not rewritten.

---

## Authentication methods

**What it is.** **Email** (Send email with Cognito, or Send email with Amazon SES with an SES identity ARN, FROM and REPLY-TO addresses, and configuration set) with **Edit**; **SMS**; **Password policy** (minimum length, requirements, temporary-password expiry, prevent use of previous passwords) with **Edit**; and **Passwordless** (the choice-based sign-in options).

**How it works in StackSim.** Both email options deliver to the local SES Inbox; Amazon SES delivery needs an identity verified in the local SES console in the same account and Region. SMS is not implemented in this simulator. Password history needs the Essentials or Plus plan.

## Sign-in

**What it is.** **Options for user pool sign-in** (identifiers and case sensitivity, fixed at creation); **Options for choice-based sign-in** (Password always; Email message one-time password; SMS and passkeys shown as unavailable) with **Edit**; **Multi-factor authentication** (Require MFA / Optional MFA / No MFA, and the methods Authenticator apps, Email message, SMS message) with **Edit**; **User account recovery** (Email only; Email if available, otherwise SMS; SMS if available, otherwise email; None – users must contact an administrator) with **Edit**.

**How it works in StackSim.** Choice-based sign-in (`USER_AUTH`) supports password, SRP, and email one-time passwords; email MFA and email one-time passwords need the Essentials or Plus plan and Amazon SES email. In an Optional-MFA pool, an authenticator app is enforced only after the user sets it as an MFA preference. Five failed password attempts lock a user out for a second, doubling up to about fifteen minutes.

## Sign-up

**What it is.** **Self-service sign-up** (Enable self-registration) with **Edit**; **Attribute verification and user account confirmation** (Cognito-assisted email verification and *Keep original attribute value active when an update is pending*) with **Edit**; **Required attributes** (fixed at creation); and **Custom attributes** with **Add custom attributes**.

**How it works in StackSim.** Custom attribute definitions are permanent. String and Number match the AWS console; Boolean and DateTime are API types this console also offers as a StackSim extra. Confirmation codes go to the SES Inbox and are never shown.

## Social and external providers

**What it is.** The pool's identity providers (type, identifiers, attribute mapping, number of app clients) with Test, Edit, and Delete, and **Add identity provider** with provider choices. OpenID Connect asks for provider name, client ID, client secret, authorized scopes, issuer URL, and attribute request method; SAML asks for a metadata URL or document and IdP-initiated sign-in. Both map attributes with **User pool attribute** / **Provider attribute** rows.

**How it works in StackSim.** OIDC discovery and signed SAML are fully verified. Loopback providers work by default; public HTTPS providers need `STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true`; private, metadata, and link-local targets are blocked. Facebook, Google, Login with Amazon, and Sign in with Apple are shown but unavailable, because StackSim does not contact public sign-in services. **View signing certificate** is not implemented in this simulator.

## Message templates

**What it is.** **Verification message**, **Invitation message**, and **MFA message** (subject and body) with **Edit**.

**How it works in StackSim.** Messages must contain `{####}`; invitations also contain `{username}`. Link-based verification is not implemented in this simulator.

---

## Threat protection

**What it is.** The enforcement mode and feature plan. **How it works in StackSim.** Threat protection needs the Plus plan and production risk telemetry and is not implemented in this simulator; `AdvancedSecurityMode: OFF` is accepted.

## Domain

**What it is.** **Domain** with an **Actions** menu (Create Cognito domain; Create custom domain, unavailable; Update branding version; Delete Cognito domain), showing the Cognito domain, prefix, and **Branding version** (Managed login or Hosted UI (classic)); **Resource servers** with **Create resource server** (name, identifier, and custom scope rows), Edit, and Delete; and the issuer and local discovery/JWKS tooling URLs.

**How it works in StackSim.** The domain is a loopback URL under `/_stacksim/cognito-domain/<prefix>`; custom domains need DNS, CloudFront, and ACM, which StackSim does not provide. Lite pools offer only the classic hosted UI.

## Managed login

**What it is.** **Styles** (per app client) with **Create a style**, **Open managed login**, and **Terms documents**.

**How it works in StackSim.** A style applies a page title and a six-digit primary color to the local managed login page. The visual branding editor, images, and terms documents are not implemented in this simulator.

---

## Lambda triggers

**What it is.** The configured triggers with trigger type, category, Lambda function, and event version, and **Add Lambda trigger** (trigger type and Lambda function).

**How it works in StackSim.** Pre sign-up, post confirmation, pre and post authentication, pre token generation (event version V1_0), and custom message run real local Lambda functions; add a resource-policy permission for `cognito-idp.amazonaws.com` with the pool ARN as `SourceArn`. Custom-authentication, migrate-user, custom-sender, and inbound-federation triggers are not implemented in this simulator.

## Settings

**What it is.** Two tabs. **Feature plans** shows Lite, Essentials, and Plus with **Change plan**. **User pool security** shows **Deletion protection** with **Activate**/**Deactivate** and **Delete user pool**.

**How it works in StackSim.** Lite pools cannot use managed login, choice-based sign-in, email MFA, or password history. Plus-only threat protection is not implemented.

---

## Identity pools

**What it is.** The identity pools list (name, ID, guest access, identity count, created time) with **Delete** and **Create identity pool**. The create page walks through **Configure identity pool trust** (authenticated and guest access; Amazon Cognito user pool as the identity source), **Configure permissions** (authenticated and guest roles), **Connect identity providers** (user pool and app client), **Configure properties** (name and tags), and **Review and create**. A pool has three tabs: **User access** (identity providers, authenticated role, guest access with Activate/Deactivate), **Identity browser** (identity IDs and linked logins), and **Properties** (name, tags, Delete identity pool).

**How it works in StackSim.** The enhanced flow (`GetId`, `GetCredentialsForIdentity`) issues credentials from user pool ID tokens with the attached roles. **Connect identity providers → Role settings** can choose the role from `cognito:preferred_role` (user pool group roles); rule-based mappings and `Deny` are available through `SetIdentityPoolRoles` and CloudFormation. The basic (classic) flow, social identity providers, and developer-authenticated identities are not implemented in this simulator.

---

## Authentication flows reference

| Flow | Typical client | Use when |
|------|----------------|----------|
| **USER_AUTH** (choice-based, `ALLOW_USER_AUTH`) | Current console default for new app clients | Let the user pick a first factor: password, SRP, or (on pools that send email through Amazon SES and allow it in the sign-in policy) an email one-time code; also signs a user in right after sign-up confirmation with the `Session` that `SignUp` returned |
| **USER_PASSWORD_AUTH** | Web/mobile with backend | Simple username/password against Cognito |
| **ADMIN_USER_PASSWORD_AUTH** | Trusted server | Admin or migration scripts authenticate users |
| **USER_SRP_AUTH** | Mobile | Secure remote password protocol |
| **REFRESH_TOKEN_AUTH** | All long-lived sessions | Obtain new access/ID tokens without re-login |
| **Authorization code + PKCE** | SPA | Browser OAuth without client secret |
| **Client credentials** | Service | Machine-to-machine with scopes |

---

Repeated successful sign-ins are never throttled. As on AWS, five failed password attempts lock the user out for one second, doubling with each further failure up to about fifteen minutes; attempts during the lockout return `Password attempts exceeded`, and a successful sign-in afterwards resets the count.

App clients created without **Attribute read and write permissions** can read every standard attribute (plus `email_verified` and `phone_number_verified`) and write every standard attribute; `DescribeUserPoolClient` then returns no `ReadAttributes`/`WriteAttributes`. Custom attributes need an explicit list.

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
| Cognito Identity Pools | Separate service: enhanced GetId/GetCredentialsForIdentity, User Pool ID tokens, guest identities when enabled, console create/edit/delete, Token and Rules role mappings; the classic flow is unavailable |
| SMS MFA / SMS verification | Unavailable |
| External email delivery | Never sent; use SES Inbox |
| Client secrets | StackSim policy: the console shows only that a secret exists (AWS has Show client secret); `DescribeUserPoolClient` returns it |
| Temporary passwords / codes | Never displayed in console |
| User-pool domain | Loopback Cognito domain; custom domains (DNS, CloudFront, ACM) are unavailable |
| Public IdP federation | Requires `STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true` |
| Private/metadata/link-local IdP targets | Blocked |
| KMS encryption | Not modeled for user pools |
| Advanced branding | Title and primary color only (managed login v2) |
| Token revocation | Supported; existing JWTs valid until expiry unless app checks revocation |
| SES DEVELOPER profile | Authentication methods → Email → Send email with Amazon SES, with a verified local SES identity |

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

## Authenticated application lesson

[Authenticated notes](../examples/amplify-auth-notes/README.md) uses the pinned unmodified Amplify client for sign-up, confirmation, SRP, refresh, and local sign-out. Open the SES Inbox using the console administrator session to read each verification code, then enter it in the app. Keep passwords, tokens, codes, and temporary credentials out of diagnostic screenshots. User Pool tokens establish identity, Identity Pools issue temporary AWS credentials, IAM gates service resources, and generated owner conditions isolate records. See [the closeout](gap-3-authenticated-app-closeout.md) for offline revocation semantics and exact limits.
