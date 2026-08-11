# Real-world Cognito SAML federation guide

This guide connects the Paper Badge learning example to a production
application. It explains what is configured in Cognito, why the authorization
endpoint is public, when Cognito creates a federated user, and how an
application maps that identity to its own users, tenants, permissions, and
onboarding state.

## The short version

For a company such as Contoso, the production flow is:

```text
Contoso employee
    -> application
    -> Cognito /oauth2/authorize
    -> Contoso's SAML identity provider
    -> signed SAML assertion
    -> Cognito /saml2/idpresponse
    -> application callback with an authorization code
    -> Cognito tokens
    -> application API
```

The important boundaries are:

- Contoso authenticates the employee.
- Cognito trusts only assertions signed by Contoso's configured certificate.
- Cognito converts the SAML identity into a Cognito user and Cognito tokens.
- The application validates those tokens and maps the Cognito identity to its
  own user record.
- The application, not Cognito, remains authoritative for tenant membership,
  onboarding, roles, and access to business data.

## How Paper Badge maps to production

| Paper Badge example | Production equivalent |
| --- | --- |
| React demo | The web or mobile application |
| stacksim Cognito user pool | An Amazon Cognito user pool |
| Paper Badge SAML server | Microsoft Entra ID, Okta, Ping, ADFS, or another corporate IdP |
| Pretend employee selector | Password, passkey, MFA, device policy, and enterprise-app assignment |
| Committed demonstration key | A protected and rotated signing key owned by the company |
| `http://localhost:5174/callback` | An HTTPS callback such as `https://app.example.com/auth/callback` |

One artificial feature of the example is that Paper Badge hosts both the demo
application and the fake company identity provider. In production these are
normally separate systems, on separate domains, controlled by different
organizations.

## The three protocol roles

The same component can have different roles at different protocol boundaries:

| Component | Role | Responsibility |
| --- | --- | --- |
| Application | OAuth/OIDC client or relying party | Starts sign-in and consumes Cognito tokens |
| Cognito user pool | SAML service provider | Sends an `AuthnRequest` to the company IdP and validates its response |
| Cognito user pool | OAuth/OIDC authorization server and IdP to the app | Issues authorization codes and Cognito JWTs |
| Company login system | SAML identity provider | Authenticates the employee and signs identity attributes |

The application does not need to parse SAML. SAML stays between the corporate
IdP and Cognito. The application uses OAuth 2.0 and OpenID Connect-shaped
Cognito tokens.

## What is configured for a specific company

Suppose the application is onboarding Contoso. The Cognito user pool gets a
SAML identity-provider configuration dedicated to Contoso:

```text
Provider name:  Contoso
Metadata:       Contoso's SAML metadata URL or uploaded XML
Entity ID:      Contoso's IdP identifier
SSO endpoint:   Contoso's SAML login endpoint
Certificate:    Contoso's public SAML signing certificate
Mappings:       SAML attributes -> Cognito attributes
```

Paper Badge creates the equivalent provider named `LearningSAML` in
`scripts/setup-cognito.mjs`.

### SAML metadata

The IdP metadata document tells Cognito:

- the identity provider's entity ID;
- where to send SAML authentication requests;
- which SAML binding is supported;
- which public certificate verifies signed assertions.

The private signing key always stays with the IdP. Cognito needs only the
public certificate.

In production, metadata might be fetched from:

```text
https://login.contoso.example/saml/metadata
```

Alternatively, an administrator can upload the metadata XML. Uploading is
useful when the metadata endpoint is not publicly reachable. The SSO endpoint
inside the metadata still needs to be reachable by the employees' browsers,
which might mean it is available only on the company network or VPN.

### Attribute mappings

The example maps:

```text
SAML email          -> Cognito email
SAML email_verified -> Cognito email_verified
SAML name           -> Cognito name
```

A production assertion might also include department, employee number, or
groups. Treat these as asserted attributes, not automatically as permission to
access all application resources. Sensitive authorization decisions should be
enforced by the backend using current application membership and policy.

### App-client configuration

The Cognito app client explicitly enables the company's provider:

```text
Supported identity providers: Contoso
OAuth flow:                    Authorization code
Scopes:                        openid email profile
Callback URL:                  https://app.example.com/auth/callback
```

For a browser application, the app client is normally public and has no client
secret. Browser code cannot keep a client secret. Authorization code flow with
PKCE protects the code exchange instead.

### Cognito domain

The user-pool domain hosts endpoints such as:

```text
/oauth2/authorize
/oauth2/token
/saml2/idpresponse
```

AWS can provide a Cognito prefix domain, or the application can use a custom
domain such as `https://auth.example.com`.

### Configuration at the company IdP

Trust must also be configured on Contoso's side. Cognito supplies values such
as:

```text
SAML service-provider entity ID:
urn:amazon:cognito:sp:<user-pool-id>

Assertion consumer service (ACS):
https://auth.example.com/saml2/idpresponse
```

Contoso registers those values as an enterprise application. Contoso can then
limit access to assigned users or groups and decide which attributes appear in
the assertion.

## What happens during sign-in

### 1. The application starts authorization

The application sends the browser to Cognito with parameters similar to:

```text
client_id=<app-client-id>
redirect_uri=https://app.example.com/auth/callback
response_type=code
scope=openid email profile
identity_provider=Contoso
state=<random-value>
nonce=<random-value>
code_challenge=<PKCE-challenge>
code_challenge_method=S256
```

The provider name and client ID are routing identifiers, not passwords. It is
expected that anyone can construct or visit this URL.

### 2. Cognito selects the configured provider

`identity_provider=Contoso` tells Cognito to use the provider configured under
that name. It does not prove that the caller works for Contoso.

Cognito constructs a SAML `AuthnRequest` and redirects the browser to the SSO
endpoint from Contoso's trusted metadata.

### 3. Contoso authenticates the employee

Contoso performs its normal authentication and access checks. These can
include:

- password or passkey authentication;
- MFA;
- managed-device or network requirements;
- account-enabled checks;
- assignment to the enterprise application;
- group or conditional-access policy.

If the user fails those checks, Contoso does not return a successful assertion.

### 4. The IdP signs a SAML assertion

After successful authentication, the IdP signs an assertion containing a
stable subject and selected attributes. For SAML, the stable subject is
commonly conveyed as `NameID`.

The assertion is limited to the intended Cognito service provider, ACS URL,
request, and short validity period.

### 5. Cognito validates the assertion

Cognito checks at least the security properties represented by:

- the signature and configured public certificate;
- issuer and intended service provider;
- audience and recipient;
- destination and assertion-consumer URL;
- `InResponseTo` correlation for SP-initiated sign-in;
- validity timestamps;
- assertion and response replay protections;
- required and mapped attributes.

A fabricated XML assertion with `email=alice@contoso.com` is not sufficient.
The attacker cannot create Contoso's valid signature.

### 6. Cognito creates or finds the federated user

Cognito uses the configured provider and the stable IdP subject to find an
existing linked identity. If it finds none, Cognito performs just-in-time
creation of a federated user in the user pool.

This happens after Cognito accepts the SAML response and before it completes
the OAuth flow. Opening `/oauth2/authorize` does not create a user.

### 7. Cognito returns an authorization code

Cognito redirects only to a callback URL registered on the app client:

```text
https://app.example.com/auth/callback?code=...&state=...
```

The application verifies `state` and exchanges the one-time code using its
original PKCE verifier.

### 8. Cognito issues tokens

The application receives Cognito ID, access, and usually refresh tokens. The
SAML assertion is not the application's session token.

The API validates Cognito's token signature, expected issuer, expiry, token
use, app-client context, and required scopes before trusting any claims.

## Why a public authorization URL does not grant access

An attacker is allowed to start the flow. They still have to pass all of these
boundaries:

1. Authenticate successfully at Contoso.
2. Be assigned to the Contoso enterprise application if assignment is used.
3. Return an assertion signed by Contoso's configured private key.
4. Satisfy Cognito's audience, recipient, correlation, and expiry checks.
5. Use an exact registered application callback URL.
6. Possess the PKCE verifier to redeem an intercepted code.
7. Present a valid Cognito access token to the API.
8. Pass the application's tenant-membership and authorization checks.

The URL, client ID, provider name, and PKCE challenge do not need to be secret.
Authentication comes from the signed SAML result; application access comes
from backend authorization.

## Cognito's federated or shadow user

With Cognito User Pool federation, Cognito creates a user-pool record for the
external identity. It is sometimes called a federated or shadow user.

The responsibilities are split:

```text
Corporate IdP
  owns credentials and authenticates the employee

Cognito federated user
  stores the Cognito sub, mapped profile, and external identity link
  provides a stable subject for Cognito tokens
```

The record normally contains:

- a Cognito-generated `sub`;
- a username associated with the external provider identity;
- an `EXTERNAL_PROVIDER` status;
- mapped mutable attributes such as email and name;
- an external identity link containing the provider and IdP subject;
- creation and modification timestamps.

It does not normally contain a local password. Future sign-ins continue at the
company IdP.

### Exact creation point

```text
Application starts authorization       no Cognito user created
Cognito redirects to company IdP       no Cognito user created
Company authenticates employee         no Cognito user created
Company posts signed assertion          no user until validation succeeds
Cognito accepts assertion               create or link federated user
Cognito returns authorization code      user now exists
Cognito issues tokens                   tokens identify that Cognito user
```

Cognito creates this record automatically. The application does not call
`SignUp` or `AdminCreateUser` for the normal first federated sign-in.

On later sign-ins, Cognito finds the same provider-and-subject link, reuses the
same Cognito `sub`, and can refresh mutable mapped attributes.

### Linking an existing user

If a person already has a Cognito user, an administrator can link the external
identity to that destination user. This avoids creating two application
identities for one person.

Do not automatically link accounts only because their email addresses match.
Email can change and is not a safe proof that two independently authenticated
identities belong to the same person.

### When no User Pool record exists

An IdP does not inherently require a shadow user. Other architectures include:

- an application using the SAML/OIDC provider directly and storing its own
  users;
- direct federation through a Cognito Identity Pool, which creates an identity
  for AWS credentials rather than a User Pool user;
- another authentication broker with its own identity-storage model.

The shadow record is part of the Cognito User Pool federation model, not a
requirement imposed by SAML itself.

## Knowing whether application onboarding is required

Cognito creation and application onboarding are different events:

```text
New to the Cognito user pool != new to this application or tenant
```

The same Cognito user might have used another app client, might be linked to an
older login, or might already belong to one tenant but not another.

Cognito does not normally return a reliable `new_user=true` OAuth value. The
application should determine onboarding from its own database after validating
the Cognito token.

```text
Validated Cognito issuer and sub
    -> application identity lookup
       -> no mapping: create application user with ONBOARDING status
       -> ONBOARDING: resume setup
       -> ACTIVE: continue to the application
```

A Cognito Pre Sign-up trigger can apply admission rules to a first external
provider sign-in, but it runs inside Cognito before user creation and cannot
directly control the application's browser navigation. Keep the application's
onboarding state in the application layer.

## Choosing application user identifiers

The Cognito `sub` is the stable authentication subject within one user pool.
Do not use email or a mutable username as the authentication key.

The complete external identity is:

```text
Cognito issuer + Cognito sub
```

Using the issuer matters when an application has multiple pools, environments,
regions, or OIDC providers.

For a very small single-pool application, using `sub` directly as the user
table primary key can work. A more flexible design uses an application-owned
surrogate ID and a separate identity mapping.

## Recommended database pattern

```sql
CREATE TABLE app_users (
    id UUID PRIMARY KEY,
    display_name TEXT,
    onboarding_status TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL
);

CREATE TABLE user_identities (
    user_id UUID NOT NULL REFERENCES app_users(id),
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    provider TEXT,
    created_at TIMESTAMP NOT NULL,
    UNIQUE (issuer, subject)
);
```

This is commonly called an identity mapping or account-linking table.

Application resources reference the application-owned user ID:

```text
projects.created_by -> app_users.id
comments.author_id  -> app_users.id
memberships.user_id -> app_users.id
```

That separation allows several login identities to resolve to the same
application user and makes identity-provider migration possible without
rewriting every business-data foreign key.

### Efficient lookup

After validating an access token, authentication middleware extracts `iss` and
`sub` and performs an indexed lookup:

```sql
SELECT
    u.id,
    u.onboarding_status
FROM user_identities AS i
JOIN app_users AS u ON u.id = i.user_id
WHERE i.issuer = :issuer
  AND i.subject = :subject;
```

The unique `(issuer, subject)` constraint supplies the index. This is a direct
index lookup followed by a primary-key lookup, not a scan of all users.

The middleware attaches only the server-resolved identity to request context:

```js
request.auth = {
  userId: applicationUser.id,
  issuer: verifiedClaims.iss,
  subject: verifiedClaims.sub,
};
```

Handlers then authorize and query by `request.auth.userId`. They do not accept
an arbitrary user ID from the request body as the authenticated identity.

### Race-safe first login

Two callback requests can race on first sign-in. Create the application user
and identity mapping in a transaction and keep the unique identity constraint.
If an insert loses the race, read the mapping created by the winning request
instead of creating a duplicate user.

### Avoiding a lookup on every request

Common options are:

1. **Backend session:** Resolve the Cognito identity once after the OAuth
   callback and create an HTTP-only application session containing or mapping
   to the internal user ID.
2. **Short-lived cache:** Cache `(issuer, sub) -> app user ID` while keeping the
   database authoritative.
3. **Pre Token Generation claim:** Add an internal application user ID as a
   custom claim. This couples token issuance to application data and creates
   stale-claim and account-linking concerns, so it is not always the simplest
   option.

An indexed database lookup or backend session is a good starting point.

## Multi-tenant authorization

Authentication proves who signed in. It does not prove which customer data the
person may access.

A multi-tenant schema commonly separates the user from membership:

```text
app_users
  id: user-123

tenant_memberships
  tenant_id: contoso
  user_id: user-123
  role: project-manager
  status: active
```

The backend should map the configured SAML provider to the expected tenant and
check current membership. Do not grant tenant access merely because an email
ends in `@contoso.com`.

If all Contoso employees should enter the application, Contoso can assign the
enterprise app broadly. If only selected employees should enter, use IdP-side
assignment plus backend membership checks. Groups or roles asserted through
SAML can help, but the backend must define how those assertions translate into
current application permissions.

## Token and lifecycle considerations

- Validate tokens before using `iss`, `sub`, or other claims.
- Treat `sub` as opaque and do not derive meaning from its format.
- A Cognito user deleted and recreated receives a new `sub`; do not reconnect
  old data automatically based only on matching email.
- Disabling an employee at the company IdP prevents future successful IdP
  authentication, but already issued Cognito JWTs can remain usable until they
  expire. Choose suitable token lifetimes and enforce current application
  membership at the API.
- Application logout, Cognito logout, and corporate IdP logout are related but
  distinct session operations.
- Keep authorization and onboarding in application storage even when selected
  values are copied into token claims for convenience.

## Local URLs versus real AWS

The example uses several local URLs because different actors need different
network endpoints:

| Setting | Purpose |
| --- | --- |
| `STACKSIM_ENDPOINT` | Cognito SDK control-plane calls from the setup script |
| `STACKSIM_COGNITO_PUBLIC_URL` | Browser-visible stacksim managed-login origin |
| `SAML_IDP_METADATA_URL` | Server-side metadata fetch performed during provider setup |
| `SAML_IDP_BASE_URL` | Browser-visible Paper Badge SSO and callback origin |

Loopback identity providers work in stacksim by default. Ordinary private,
metadata-service, link-local, and reserved targets remain blocked. Public HTTPS
providers require stacksim's explicit public-provider network option.

Real AWS does not use these stacksim URL settings. A production deployment
normally configures:

```text
Application:     https://app.example.com
Cognito domain:  https://auth.example.com
Company IdP:     https://login.contoso.example
Callback:        https://app.example.com/auth/callback
```

The Cognito resources are normally created during infrastructure deployment or
customer SSO onboarding with CDK, CloudFormation, Terraform, or an
administrative process. They are not recreated each time the application
starts.

The application still receives non-secret runtime configuration such as the
user-pool ID, app-client ID, Cognito domain, expected issuer, and callback URL.

## Viewing the configuration

### stacksim console

Open:

```text
http://127.0.0.1:4566/_stacksim/console/#/cognito/user-pools
```

Then select `saml-learning-pool` and open **Managed login**. Under **Social and
external providers**, inspect or edit `LearningSAML`.

The console shows the provider type, metadata configuration, attribute
mappings, identifiers, enabled clients, and signing-certificate fingerprint.
It does not show the IdP private key because Cognito never owns that key.

### AWS console

The corresponding AWS location is under the selected Cognito user pool's
**Social and external providers** area. App-client identity providers, OAuth
flow, scopes, and callbacks are configured under the app client's managed-login
settings, and the user-pool domain is configured separately.

## Production checklist

- [ ] Create or select the Cognito user pool.
- [ ] Obtain the company's SAML metadata URL or XML file.
- [ ] Configure a uniquely named SAML provider and exact attribute mappings.
- [ ] Give the company Cognito's service-provider entity ID and ACS URL.
- [ ] Require appropriate enterprise-app user or group assignment.
- [ ] Enable the provider on the intended Cognito app client.
- [ ] Register exact HTTPS callback and logout URLs.
- [ ] Use authorization code flow with PKCE for public clients.
- [ ] Validate Cognito access tokens at the API.
- [ ] Store a unique `(issuer, sub)` identity mapping.
- [ ] Use an application-owned user ID for business-data relationships.
- [ ] Store onboarding and tenant membership in application data.
- [ ] Handle first-login races with a unique constraint and transaction.
- [ ] Define account-linking, offboarding, token-lifetime, and logout policies.
- [ ] Never authorize a tenant solely from an email-domain match.

## Final mental model

```text
Company IdP authenticates a person
        -> signs a short-lived SAML statement
Cognito validates that company's configured trust
        -> creates or finds a federated Cognito user
        -> issues Cognito tokens with a stable sub
Application validates the tokens
        -> maps (issuer, sub) to its internal user ID
        -> checks onboarding, tenant membership, roles, and permissions
```

The public authorization URL starts this process. It grants nothing by itself.
Trust comes from the company IdP's signature and Cognito's validation;
application access comes from the backend's own current authorization data.
