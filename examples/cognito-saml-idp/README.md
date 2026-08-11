# Paper Badge: local Cognito SAML learning IdP

Paper Badge is a deliberately small SAML 2.0 identity provider with a React
interface. It runs on the same machine as stacksim and demonstrates the complete
browser flow:

```text
React demo → Cognito /oauth2/authorize → Paper Badge /saml/sso
  → signed SAML POST → Cognito /saml2/idpresponse
  → React /callback → Cognito tokens
```

The UI lets you choose a pretend employee identity, inspect Cognito's decoded
`AuthnRequest`, send a real RSA-SHA256-signed SAML assertion, and inspect the
claims in the Cognito tokens. The private signing key stays in the local Node
server rather than in browser JavaScript.

This is a learning aid, not a production identity provider. It performs no
password authentication, contains a publicly committed demo signing key, and
accepts only loopback stacksim Cognito assertion-consumer URLs.

For a production-oriented explanation of company SSO, trust configuration,
federated Cognito users, application onboarding, and database identity design,
see [Real-world Cognito federation guide](REAL-WORLD-FEDERATION-GUIDE.md).

## The three roles in this example

This example uses a **Cognito user pool**, not a Cognito identity pool. The
names are similar, but the jobs are different:

- A **user pool** authenticates users and issues ID, access, and refresh tokens.
  This example configures a user pool.
- An **identity pool** exchanges an authenticated identity for temporary AWS
  credentials. Identity pools are not involved in this example.

Three components take part in a sign-in:

| Component | Standards role | What it does here |
| --- | --- | --- |
| React demo | OAuth client / relying application | Starts sign-in and eventually receives Cognito tokens |
| stacksim Cognito user pool | SAML service provider (SP) and OAuth authorization server | Asks Paper Badge to authenticate the user, validates the SAML response, then issues its own tokens |
| Paper Badge | SAML identity provider (IdP) | Represents an organization's login system and signs facts about a pretend employee |

The application does not parse or trust SAML itself. SAML is used between
Paper Badge and Cognito. After Cognito accepts the SAML assertion, the
application completes a normal OAuth 2.0 authorization-code flow with PKCE and
receives Cognito tokens.

## Prerequisites

- Node.js 22.13 or newer.
- The stacksim repository dependencies installed with `npm install`.
- Ports `4566` and `5174` available, or equivalent environment-variable
  overrides.

## Run the example

Use three terminals. The order matters because Cognito reads the IdP metadata
from the running Paper Badge server during setup.

### About `.env.example`

`.env.example` is a checked-in template containing the normal local settings
for this example. The commands below already use the documented defaults, so
creating an `.env` file is optional.

To customize the settings with Bash or zsh, create a local, ignored copy:

```bash
cd examples/cognito-saml-idp
cp .env.example .env
```

Edit `.env`, then load it into **each new terminal** before running a command:

```bash
set -a
source .env
set +a
```

When the terminal is at the repository root, use
`source examples/cognito-saml-idp/.env` instead. Node and npm do not
automatically load this file, and environment variables set in one terminal do
not appear in the other terminals. PowerShell users can set the corresponding
variables with `$env:NAME = "value"` as shown below.

### 1. Start stacksim

From the repository root, pin the browser-visible Cognito origin. This setting
is read only when stacksim starts, so restart stacksim after changing it.

PowerShell:

```powershell
$env:STACKSIM_COGNITO_PUBLIC_URL = "http://localhost:4566"
npm run dev
```

Bash:

```bash
env STACKSIM_COGNITO_PUBLIC_URL=http://localhost:4566 npm run dev
```

Loopback identity providers work by default. Private-network, link-local, and
metadata-service targets remain blocked.

If you loaded `.env` in this terminal, simply run `npm run dev` instead.

### 2. Start Paper Badge

From `examples/cognito-saml-idp`:

```bash
npm install
npm run dev
```

The React app and its local SAML endpoints are now served from
`http://localhost:5174`.

### 3. Configure the Cognito pool

In another terminal in this example directory:

```bash
npm run setup:cognito
```

The idempotent script uses the official Cognito Identity Provider SDK. It
creates or updates:

- user pool `saml-learning-pool`;
- SAML provider `LearningSAML`;
- public OAuth app client `saml-learning-client`;
- local managed-login domain `saml-learning-local`;
- callback URL `http://localhost:5174/callback`;
- SAML mappings for `email`, `email_verified`, and `name`.

It writes the resulting non-secret pool and client identifiers to the ignored
`public/config.json` file. Run the script again after deleting the local
stacksim state or changing the configuration.

Here, “public OAuth app client” means a browser-based client with no client
secret. It does not mean that the local application or user pool is exposed to
the public Internet.

Open `http://localhost:5174` and select **Start SAML sign-in**.

## How setup establishes trust

SAML relies on a trust relationship configured before anyone signs in:

1. Paper Badge starts and publishes a SAML metadata XML document at
   `http://127.0.0.1:5174/saml/metadata`.
2. `npm run setup:cognito` first checks that document is reachable. It then
   creates or reuses the user pool, SAML provider, app client, and local domain
   through the Cognito SDK.
3. When the SAML provider is created or updated, stacksim fetches the metadata.
   The document supplies Paper Badge's entity ID, sign-in endpoint, supported
   binding, and public X.509 signing certificate.
4. Cognito keeps the public certificate so it can verify later assertions.
   Paper Badge keeps the matching private key and uses it to sign assertions.
   Cognito never receives the private key.
5. The setup script writes the resulting non-secret IDs and URLs to
   `public/config.json`, which the React demo reads when it starts a sign-in.

This metadata fetch is why Paper Badge must be running before
`npm run setup:cognito`.

## What happens during sign-in

1. The React demo generates OAuth `state`, `nonce`, and a PKCE verifier and
   challenge, then sends the browser to Cognito's `/oauth2/authorize` endpoint.
2. Cognito sees `identity_provider=LearningSAML`, creates a SAML
   `AuthnRequest`, and redirects the browser to Paper Badge's `/saml/sso`
   endpoint. `RelayState` lets Cognito correlate the browser round trip.
3. Paper Badge decodes and displays the request. In a real IdP this is where
   password, passkey, or corporate single sign-on authentication would happen.
   This learning IdP instead lets you choose a pretend employee.
4. Paper Badge creates a short-lived SAML assertion containing the employee's
   stable subject, email address, verified-email status, and display name. It
   signs the assertion with its demo RSA private key.
5. The browser posts `SAMLResponse` and the unchanged `RelayState` to Cognito's
   assertion consumer service (ACS).
6. Cognito verifies the signature and checks that the response matches the
   request, intended user pool, ACS URL, and validity period. It maps the SAML
   attributes to user-pool attributes.
7. Cognito redirects the browser to `http://localhost:5174/callback` with a
   one-time OAuth authorization code.
8. The demo exchanges that code and the PKCE verifier at Cognito's
   `/oauth2/token` endpoint, then displays the claims from the Cognito ID and
   access tokens.

The SAML assertion is therefore not the application's login token. It is the
signed evidence Cognito accepts before Cognito issues the OAuth tokens used by
the application.

## What Cognito is configured to trust

Paper Badge publishes metadata at:

```text
http://127.0.0.1:5174/saml/metadata
```

The explicit IP is used for stacksim's guarded server-side metadata fetch. The
metadata document itself tells Cognito:

- the IdP entity ID is `urn:stacksim:learning:saml-idp`;
- authentication requests go to `http://localhost:5174/saml/sso`;
- the request uses SAML HTTP-Redirect binding;
- assertions are verified with the included demo X.509 certificate.

Cognito provides the other two important values in each `AuthnRequest`:

```text
Audience / service-provider entity ID:
urn:amazon:cognito:sp:<user-pool-id>

Assertion consumer service (ACS):
http://localhost:4566/_stacksim/cognito-domain/<domain>/saml2/idpresponse
```

Paper Badge copies the request ID into `InResponseTo`, restricts the audience to
the requesting pool, restricts the recipient and destination to the ACS, gives
the assertion a five-minute lifetime, signs the assertion, and returns the
unchanged `RelayState`.

## Configure it manually instead

The setup script is the fastest path, but the same configuration can be entered
in the stacksim Cognito console:

1. Create a user pool with `email` as the username and add mutable `email` and
   `name` attributes.
2. Create a SAML identity provider named `LearningSAML`.
3. Set `MetadataURL` to `http://127.0.0.1:5174/saml/metadata`.
4. Map Cognito `email` to SAML `email`, `email_verified` to
   `email_verified`, and `name` to `name`.
5. Create a public app client with authorization-code OAuth enabled, scopes
   `openid email profile`, and callback URL
   `http://localhost:5174/callback`.
6. Enable `LearningSAML` in that app client's supported identity providers.
7. Create a local user-pool domain.
8. Copy the pool, client, provider, domain, authorize URL, and token URL into a
   new `public/config.json`, using `public/config.example.json` as the shape.

The launch URL must include the client ID, exact callback, `response_type=code`,
scopes, state, nonce, an S256 PKCE challenge, and
`identity_provider=LearningSAML`. The React app constructs that URL for you.

## Configuration overrides

The values in `.env.example` match the built-in defaults and make the local
network roles explicit when you need to customize them.

| Variable | Template value | Used by | Purpose |
| --- | --- | --- | --- |
| `STACKSIM_COGNITO_PUBLIC_URL` | `http://localhost:4566` | stacksim and setup | Browser-visible managed-login origin |
| `STACKSIM_ENDPOINT` | `http://127.0.0.1:4566` | setup | Cognito SDK control-plane endpoint |
| `AWS_REGION` | `eu-west-1` | stacksim and setup | User-pool Region |
| `PORT` | `5174` | Paper Badge | Local HTTP port |
| `SAML_IDP_BASE_URL` | `http://localhost:5174` | Paper Badge and setup | Browser-visible IdP origin and callback base |
| `SAML_IDP_METADATA_URL` | `http://127.0.0.1:5174/saml/metadata` | setup and stacksim | Server-side metadata URL |
| `COGNITO_POOL_NAME` | `saml-learning-pool` | setup | User-pool name |
| `COGNITO_PROVIDER_NAME` | `LearningSAML` | setup | SAML provider name |
| `COGNITO_CLIENT_NAME` | `saml-learning-client` | setup | OAuth app-client name |
| `COGNITO_DOMAIN` | `saml-learning-local` | setup | Local managed-login prefix |

If stacksim authentication enforcement is enabled, also set
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to an authorized local
principal. Without overrides, the setup script uses the stacksim development
administrator defaults `admin` and `password`.

## Project map

- `src/App.jsx` — the React learning flow and PKCE client.
- `server/server.mjs` — local HTTP server, metadata, assertion, and token relay
  endpoints.
- `server/saml.mjs` — AuthnRequest parsing and signed assertion construction.
- `scripts/setup-cognito.mjs` — idempotent Cognito SDK configuration.
- `test/saml.test.mjs` — metadata, request-boundary, and signature tests.

Build and test the standalone example with:

```bash
npm test
npm run build
npm start
```

`npm start` serves the already-built React app from the same port as the SAML
endpoints.

## Troubleshooting

- **`The learning IdP is not reachable`**: start Paper Badge in terminal 2
  before running the setup command.
- **`EADDRINUSE` for port 4566 or 5174**: another process is already listening
  on that port. Stop the older process or change the corresponding settings.
- **The UI says setup is still required**: rerun `npm run setup:cognito` and
  refresh the page. If you changed URLs or resource names, ensure the same
  `.env` values were loaded in the Paper Badge and setup terminals.
