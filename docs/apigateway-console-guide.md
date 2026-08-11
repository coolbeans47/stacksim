# StackSim API Gateway console guide

This guide explains every panel in the StackSim API Gateway console: what each setting does, why you would use it in real AWS workloads, and how it maps to production API Gateway behavior.

StackSim models the API Gateway control plane and request path locally. Where local behavior differs from AWS (for example DNS, VPC provisioning, or TLS termination), those boundaries are called out explicitly.

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

The API Gateway service in StackSim has a left navigation bar with these top-level areas:

| Area | Purpose |
|------|---------|
| **APIs** | Create and manage REST, HTTP, and WebSocket APIs |
| **API keys** | Issue credentials for usage plans |
| **Usage plans** | Apply throttles and quotas to API keys per stage |
| **Custom domain names** | Map friendly hostnames to REST API stages |
| **VPC links** | Connect REST private integrations to load balancers |
| **Client certificates** | Present a client certificate to private backends |
| **Account settings** | Regional CloudWatch role and account throttling |

---

## APIs

### What it is

The **APIs** page lists every REST, HTTP, and WebSocket API in the current region. From here you can create a new API or open an existing one.

REST APIs are organized as **resources and methods**. HTTP and WebSocket APIs use **routes and integrations**.

### Why use it

In AWS, API Gateway is the front door for HTTP and WebSocket traffic. You choose the API type based on features and cost:

- **REST API** — richest feature set: request validation, API keys, usage plans, caching, VTL mapping, resource policies, and fine-grained stage controls.
- **HTTP API** — lower latency and cost; routes, JWT/Lambda authorizers, and CORS with less configuration overhead.
- **WebSocket API** — persistent bidirectional connections for chat, live dashboards, and push notifications.

### How it works in StackSim

All three API types can be created, configured, deployed, invoked, imported, and exported locally. Edge-optimized and private endpoint types are stored as compatibility metadata; regional invoke URLs are the native local path.

### Common AWS use cases

- **REST API** — enterprise APIs with Cognito or Lambda authorizers, request validation, and stage-based releases (`dev`, `staging`, `prod`).
- **HTTP API** — serverless microservices behind Lambda or public HTTP backends where you want minimal configuration.
- **WebSocket API** — real-time apps where the server pushes updates to connected clients.

### Example

Create a REST API named `orders-api` when you need API keys on partner endpoints and JSON Schema validation on `POST /orders`. Create an HTTP API named `orders-http` when a single Lambda proxy behind `$default` is enough.

---

## REST API panels

Opening a REST API shows tabs across the top. Changes to resources, models, authorizers, and most settings require **Deploy API** before a stage serves the new configuration.

### Resources

#### What it is

The **Resources** panel shows the URL tree (`/`, `/orders`, `/orders/{id}`) and the HTTP methods on each resource. You can create resources, create methods, enable CORS, and open the method execution editor.

Each method appears as a split control: the method name opens configuration; **Monitor** links to CloudWatch metrics.

#### Why use it

REST APIs model HTTP as a resource tree. Each path segment can have its own methods, authorization, validation, and integration. This mirrors how clients call your service (`GET /orders`, `POST /orders/{id}/cancel`).

In AWS, resource design also affects caching keys, IAM policy resources, and OpenAPI export structure.

#### How it works in StackSim

Resource trees, method lifecycle, integrations, mapping, CORS, authorization, test invocation, and deletion are active. A deployed stage uses an immutable snapshot until you redeploy.

#### Common AWS use cases

- Add `{proxy+}` on `/api` to forward all subpaths to one Lambda.
- Add `{id}` path parameters for entity-specific operations.
- Enable CORS on a resource so browser clients can call your API from a web app origin.

#### Example

```
/
└── orders
    ├── GET    → Lambda ListOrders
    ├── POST   → Lambda CreateOrder
    └── {id}
        ├── GET    → Lambda GetOrder
        └── DELETE → Lambda CancelOrder
```

---

### Method execution (Method request, Integration request, Integration response, Method response, Test)

These panels open in a modal when you configure a method.

#### Method request

**Fields:** Authorization, authorizer, authorization scopes, API key required, request validator, required request parameters, request models.

**Why use it:** This is where you declare what the caller must send before API Gateway invokes your backend. Authorization runs first; validation runs next; only then does the integration execute.

**Common AWS use cases:**

- Require `AWS_IAM` so only SigV4-signed callers (other AWS services or IAM users) can invoke the method.
- Attach a Cognito user pool authorizer and scopes so `POST` requires an access token with `orders:write`.
- Mark `x-api-key` as required and attach a usage plan for partner rate limiting.
- Map `application/json` to an `OrderInput` model and a validator that checks the body.

#### Integration request

**Fields:** Integration type, URI, HTTP method, timeout, parameter mappings, cache namespace/key, request mapping templates.

**Why use it:** Transforms the incoming HTTP request into the shape your backend expects. Non-proxy integrations use VTL templates; proxy integrations pass the request through largely unchanged.

**Common AWS use cases:**

- `AWS_PROXY` to Lambda — simplest pattern; Lambda receives an API Gateway proxy event.
- `HTTP` or `HTTP_PROXY` to an on-premises or VPC backend.
- `AWS` integration to DynamoDB or SQS without Lambda in the middle. API Gateway-to-Step Functions remains fail-closed in this profile; EventBridge and Scheduler are the activated workflow producers in SFN-03.
- `MOCK` for health checks or CORS preflight responses.

#### Integration response and Method response

**Why use it:** Map backend responses to HTTP status codes, headers, and bodies returned to the client. Use selection patterns to route error payloads from Lambda to 4xx/5xx responses.

#### Test

**Why use it:** Invoke the current mutable method configuration without going through a deployed stage. In AWS this is the console **Test** action; it helps verify mapping and validation before deployment.

---

### Models

#### What it is

The **Models** tab stores named **JSON Schema Draft 4** documents. Each model has a name, content type (usually `application/json`), description, and schema. Default models `Empty` and `Error` are built in.

You attach models to method **request** and **response** definitions and pair them with a **request validator** to reject malformed bodies at the edge.

#### Why use it

In AWS API Gateway, models serve three related purposes:

1. **Request validation** — API Gateway checks incoming JSON against the schema before calling Lambda or HTTP backends, returning `400 Bad Request` for invalid payloads.
2. **API documentation** — models describe the contract in the exported OpenAPI definition and developer portal.
3. **Mapping templates** — VTL can reference models when generating example payloads or transforming bodies.

Validation at the gateway reduces wasted Lambda invocations, gives clients consistent error shapes, and enforces contracts across teams.

#### How it works in StackSim

Models can be created, edited, stored, exported, and used by supported validation paths. Edits affect test invocations immediately; deployed stages keep their saved schema until redeployed. StackSim does not generate application classes from models.

#### Common AWS use cases

- Validate `POST /users` bodies so missing `email` fails before Lambda runs.
- Document response shapes for SDK generation and partner onboarding.
- Share nested schemas across methods with `$ref` to other API models.

#### Example

Create a model named `CreateOrder`:

```json
{
  "$schema": "http://json-schema.org/draft-04/schema#",
  "title": "CreateOrder",
  "type": "object",
  "required": ["customerId", "items"],
  "properties": {
    "customerId": { "type": "string", "minLength": 1 },
    "items": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["sku", "quantity"],
        "properties": {
          "sku": { "type": "string" },
          "quantity": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "notes": { "type": "string", "maxLength": 500 }
  }
}
```

Then on `POST /orders`:

1. Create a request validator with **Validate request body** enabled.
2. On the method request, set the validator and map `application/json` → `CreateOrder`.

A request missing `items` receives a gateway validation error instead of reaching your Lambda function.

---

### Request validators

#### What it is

Validators are reusable rules that methods reference. Each validator can independently enable:

- **Validate request body** — check JSON against the method's request model.
- **Validate request parameters** — ensure required path, query, and header parameters declared on the method are present.

#### Why use it

Validators let you define validation once and attach it to many methods. In AWS this keeps validation policy consistent and makes OpenAPI exports clearer.

#### How it works in StackSim

Validator lifecycle, parameter checks, model-backed body validation, and deployment snapshots are active. Validation on deployed stages changes only after redeployment.

#### Common AWS use cases

- `ValidateBodyOnly` on all `POST` and `PUT` methods.
- `ValidateParamsOnly` on `GET` methods that require `tenantId` query parameters.
- `ValidateBodyAndParams` on complex create endpoints.

#### Example

Create validator `StrictJsonBody`, enable body validation only, attach it to `POST /orders` with the `CreateOrder` model.

---

### Authorizers

#### What it is

Authorizers decide whether a request may invoke a method **before** the integration runs. REST APIs support:

- **Lambda TOKEN** — authorizer receives the bearer token; returns an IAM policy.
- **Lambda REQUEST** — authorizer receives headers, path, and query; useful for custom identity logic.
- **Cognito user pools** — validates JWT ID or access tokens from a Cognito pool.

Fields include identity source (for example `method.request.header.Authorization`), cache TTL, and provider configuration.

#### Why use it

Authentication and coarse authorization belong at the edge so backends stay simpler. Cognito integration is the standard pattern for user-facing mobile and web apps. Lambda authorizers cover API keys in custom headers, database lookups, and legacy token formats.

Caching authorizer results (up to 3600 seconds) reduces Lambda cost and latency for high-traffic APIs.

#### How it works in StackSim

Lambda TOKEN and REQUEST authorizers, Cognito pool tokens, identity sources, caching, test invocation, and deployed authorization are active. Cognito pools must exist in the same StackSim environment.

#### Common AWS use cases

- Cognito ID token on `GET /profile`; access token with scope `admin:read` on admin routes.
- Lambda TOKEN authorizer reading `Authorization: Bearer ...` and returning `Allow`/`Deny`.
- Disable cache (TTL `0`) when tokens are single-use or highly sensitive.

#### Example

Create authorizer `UserPoolAuth` (Cognito), identity source `method.request.header.Authorization`, TTL `300`. On `POST /notes`, set authorization to Cognito and leave scopes empty so an ID token is required.

---

### Gateway responses

#### What it is

Gateway responses customize errors **generated by API Gateway itself** — not errors from your Lambda or HTTP backend. Examples include `MISSING_AUTHENTICATION_TOKEN`, `ACCESS_DENIED`, `THROTTLED`, and `BAD_REQUEST_BODY`.

You can override status code, response headers, and mapping templates for each type.

#### Why use it

Default gateway errors are generic. Production APIs often return consistent JSON error envelopes (`{ "error": "...", "requestId": "..." }`) even when the backend never ran.

#### How it works in StackSim

Status overrides, parameters, templates, reset-to-default, and deployment snapshots are active for locally generated gateway errors.

#### Common AWS use cases

- Customize `ACCESS_DENIED` to return your company's error schema.
- Add `Access-Control-Allow-Origin` on `DEFAULT_4XX` for browser clients.
- Map `QUOTA_EXCEEDED` to `429` with a support contact message.

#### Example

For `BAD_REQUEST_BODY`, set status `400` and a template:

```json
{
  "message": "Request body failed validation",
  "requestId": "$context.requestId"
}
```

---

### Documentation

#### What it is

Three related areas:

1. **Documentation parts** — descriptions attached to APIs, resources, methods, parameters, responses, models, and authorizers.
2. **Documentation versions** — immutable snapshots of all parts at publish time.
3. **SDK generation** — download a JavaScript client generated from a deployed stage (other languages appear for API compatibility).

#### Why use it

In AWS, documentation versions can be associated with stages and included in OpenAPI exports for partner portals. SDK generation accelerates client development for REST APIs.

#### How it works in StackSim

Part lifecycle, JSON import, version publishing, stage association, and documented OpenAPI export are active. JavaScript SDK archives are generated locally.

#### Common AWS use cases

- Publish version `2026-03-01` when launching a public API.
- Associate documentation version `v1` with the `prod` stage.
- Generate a JavaScript SDK for internal frontend teams.

---

### API settings

#### What it is

**Binary media types and compression** settings:

- **API key source** — read keys from `X-API-Key` header (`HEADER`) or from a Lambda authorizer context value (`AUTHORIZER`).
- **Binary media types** — content types treated as binary (for example `application/octet-stream`, `image/*`).
- **Minimum compression size** — compress responses at or above this size when clients accept `gzip`.

#### Why use it

Binary media types let API Gateway base64-encode file uploads and downloads correctly. Compression reduces egress cost and latency for large JSON payloads.

#### How it works in StackSim

Binary conversion, wildcards, compression thresholds, and deployment behavior are modeled locally.

#### Common AWS use cases

- Add `multipart/form-data` or `application/pdf` for file APIs.
- Set minimum compression size to `1024` so small responses stay uncompressed.
- Switch API key source to `AUTHORIZER` when keys are embedded in signed JWT claims.

---

### Resource policy

#### What it is

An IAM-style JSON policy attached to the REST API. It allows or denies `execute-api:Invoke` based on principal, source VPC endpoint, source IP, or calling service ARN.

StackSim includes an **EventBridge target authorization** template for allowing `events.amazonaws.com` to invoke the API.

#### Why use it

Resource policies complement method-level authorization. Common patterns:

- Allow only a specific EventBridge rule to call an internal webhook resource.
- Restrict a private API to traffic from a VPC endpoint.
- Deny invocation except from known AWS account IDs.

Explicit `Deny` always wins over `Allow`.

#### How it works in StackSim

Policy storage, validation, deny precedence, IAM and supported service-principal evaluation are active. Network-origin conditions that depend on real VPC infrastructure are not fully simulated.

#### Common AWS use cases

- EventBridge → API Gateway target for serverless cron jobs.
- Cross-account access where the API resource policy allows a partner account root.
- Private API locked to `aws:SourceVpce`.

#### Example

Allow EventBridge rule `arn:aws:events:eu-west-1:123456789012:rule/nightly-sync` to `POST` your webhook stage.

---

### Stages

#### What it is

A **stage** is a named, invokable release (`dev`, `test`, `prod`) pointing at an immutable **deployment** snapshot. The **Stages** tab configures runtime behavior per stage.

Sub-panels:

| Sub-panel | Purpose |
|-----------|---------|
| **Deployment** | Active deployment ID, description, documentation version, invoke URL |
| **Logs and tracing** | Execution logs, access logs, data tracing, X-Ray |
| **Metrics** | Detailed per-method CloudWatch metrics |
| **Response cache** | Stage cache cluster, TTL, encryption, method overrides |
| **Throttling** | Stage rate and burst limits |
| **Stage variables** | Key/value strings referenced in mapping expressions |
| **Canary release** | Split traffic between two deployments |
| **Tags** | Resource tags for organization |

#### Why use it

Stages are how AWS separates environments on one API definition. The same `/orders` resource can point to different Lambda aliases via stage variables (`dev` → `$LATEST`, `prod` → `live` alias).

#### How it works in StackSim

Stage lifecycle, deployments, invoke URLs, logs, metrics, throttling, variables, canaries, and cache are active locally.

---

#### Deployment

**Why use it:** Pinning a stage to a deployment ID lets you roll forward and back without renaming URLs. Documentation version association embeds published docs in exports for that stage.

**Common AWS use cases:** Promote deployment `abc123` from `staging` to `prod` after testing.

---

#### Logs and tracing

**Why use it:**

- **Execution logs** — debug mapping, authorizer, and integration behavior (`INFO` or `ERROR`).
- **Access logs** — one line per request with `$context` variables for SIEM and auditing.
- **X-Ray** — trace latency through API Gateway and downstream services.

Requires a regional **CloudWatch logs role** in Account settings.

**Common AWS use cases:** Enable `INFO` execution logging in `dev` only; ship access logs to a dedicated log group for compliance.

---

#### Metrics

**Why use it:** Detailed metrics add `ApiName`, `Stage`, `Resource`, and `Method` dimensions beyond account-level aggregates. Use them to find hot routes and error spikes.

**Common AWS use cases:** Enable detailed metrics on `prod` for endpoints with SLOs; keep them off in low-traffic dev stages to reduce metric cost in AWS.

---

#### Response cache

**Why use it:** Cache eligible `GET` responses at the edge to reduce backend load and latency. Configure TTL, encryption, and optional per-method overrides.

**Common AWS use cases:** Cache `GET /products` for 300 seconds; leave `GET /account/balance` uncached.

**StackSim note:** Encrypted cache uses local authenticated encryption; capacity labels are compatibility settings, not provisioned AWS hardware.

---

#### Throttling

**Why use it:** Token-bucket rate and burst limits protect backends from traffic spikes. Stage limits override the regional account default.

**Common AWS use cases:** Set stage burst to absorb short spikes while keeping sustained rate low; combine with usage plans for per-customer limits.

---

#### Stage variables

**Why use it:** Parameterize integrations without duplicating APIs — commonly Lambda function aliases, HTTP backend hostnames, or feature flags.

**Common AWS use cases:**

- Integration URI `arn:...:function:MyFn:${stageVariables.env}`.
- Canary overrides that send a fraction of traffic to a different backend URL.

#### Example

```json
{
  "lambdaAlias": "live",
  "backendHost": "orders.internal.example"
}
```

Reference in mapping: `https://${stageVariables.backendHost}/v1/orders`.

---

#### Canary release

**Why use it:** Send a percentage of stage traffic to a second deployment before full promotion. Test new code with real requests while limiting blast radius.

**Common AWS use cases:** Route 10% of `prod` traffic to a deployment with a new Lambda version; promote after CloudWatch alarms stay green.

**StackSim note:** Traffic splitting is deterministic for reproducible tests.

---

## HTTP API panels

HTTP APIs use a sidebar grouped into **Develop**, **Deploy**, and **Monitor**.

### Routes

#### What it is

Routes match `METHOD /path`, `ANY /path`, or `$default`. Each route links to an integration and optional authorizer.

#### Why use it

HTTP APIs trade REST's resource tree for simpler route tables and lower cost. `$default` catches unmatched requests — common for Lambda monolith proxies.

#### Common AWS use cases

- `GET /orders`, `POST /orders` on separate routes.
- `$default` → single Lambda handling all paths (similar to `{proxy+}`).

---

### Authorization

#### What it is

**JWT authorizers** (issuer, audience, scopes) and **Lambda REQUEST authorizers**. Attach authorizers to individual routes.

#### Why use it

JWT authorizers integrate cleanly with Cognito, Auth0, and Okta without a custom authorizer Lambda. Lambda authorizers cover non-JWT schemes.

#### Common AWS use cases

- JWT issuer = Cognito pool URL; audience = app client ID.
- Lambda authorizer on `POST /admin/*` routes.

#### Example

JWT issuer: `https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbCdEf123`  
Audience: `4example7clientid`  
Route scopes: `orders:read`

---

### Integrations

#### What it is

**Lambda (AWS_PROXY)** or **HTTP proxy** backends with payload format version, timeout, and optional parameter mapping.

#### Why use it

HTTP APIs optimize for proxy integrations with minimal configuration compared to REST VTL pipelines.

#### Common AWS use cases

- Lambda proxy for CRUD APIs.
- HTTP proxy to an existing monolith during migration.

---

### CORS

#### What it is

API-level CORS configuration: allowed origins, methods, headers, exposed headers, max age, credentials.

#### Why use it

Browsers enforce CORS on cross-origin XHR/fetch. HTTP APIs can answer preflight and inject CORS headers without backend changes.

#### Common AWS use cases

- Single-page app origin `https://app.example.com`.
- Public read API with origin `*`.

---

### Stages (HTTP API)

#### What it is

Stages point to deployments. **Auto-deploy** creates a new deployment on each change (typical for `$default`). Manual stages let you control promotion.

Settings include stage variables, default route throttling, detailed metrics, and access logging.

#### Why use it

Even with auto-deploy, named stages (`dev`, `prod`) provide separate invoke URLs and observability configuration.

---

### Monitor (HTTP API)

Summary cards link to CloudWatch metrics and log groups. Metrics include Count, 4xx, 5xx, Latency, IntegrationLatency, and DataProcessed after invocations.

---

## WebSocket API panels

WebSocket APIs share a similar sidebar: **Routes**, **Integrations**, **Models**, **Authorization**, **Stages**, and **Monitor and test**.

### Route selection expression

Set at API level (for example `$request.body.action`). Incoming JSON messages route by the evaluated key; non-JSON or unmatched messages use `$default`.

**Why use it:** One persistent connection handles many actions (`subscribe`, `sendMessage`, `ping`) without opening a new HTTP request per action.

### Routes

Reserved keys:

- `$connect` — opening handshake (authorization applies here for the whole connection).
- `$disconnect` — cleanup when the client disconnects.
- `$default` — fallback route.
- Custom keys — matched from the route selection expression.

**Two-way routes** return integration output to the client via a route response.

### Integrations

Lambda proxy, custom AWS/HTTP service, HTTP proxy, or MOCK. Request templates shape the integration input from connection context.

### Models

JSON Schemas for message bodies — same rationale as REST models, applied to WebSocket message validation and documentation.

### Authorization

Only **`$connect`** supports Lambda REQUEST or AWS_IAM authorization. Once connected, the identity established at handshake applies to the connection lifetime.

### Monitor and test

Provides a sample browser WebSocket client script, connection URL, and `post-to-connection` CLI example for the API Gateway Management API.

---

## API keys

### What it is

Long-lived identifiers used with **usage plans**. Keys can be generated, imported from CSV, enabled/disabled, rotated, and tagged. The raw value is hidden in list views until revealed.

### Why use it

In AWS, API keys identify *which consumer* is calling when combined with usage plans. They are **not** a substitute for authentication — pair them with IAM, Cognito, or Lambda authorizers when identity matters.

Keys are passed in `x-api-key` (by default) or via authorizer context when API key source is `AUTHORIZER`.

### How it works in StackSim

Creation, import, rotation, usage-plan association, metering, and enforcement are active locally.

### Common AWS use cases

- Issue distinct keys to each SaaS customer for quota tracking.
- Disable a leaked key without deleting usage history.
- Import keys migrated from another system.

---

## Usage plans

### What it is

Usage plans bind **API stages** to **throttle and quota settings**, then associate **API keys** that inherit those limits.

Tabs:

- **Overview** — default throttling, quota, associated stages (with optional method-level throttle overrides), tags.
- **Associated keys** — which keys use this plan.
- **Usage** — daily request counts and remaining quota per key.

### Why use it

Usage plans are AWS's built-in API monetization and fairness mechanism: free tier vs paid tier, trial limits, and burst control per partner.

### Common AWS use cases

- Plan `Free`: 1000 requests/day, 10 req/s.
- Plan `Enterprise`: 10M requests/month, higher burst, per-method override on expensive endpoints.
- Same key in two plans only if their stage associations do not overlap.

#### Example

Plan `Partners`:

- Stages: `orders-api:prod`
- Throttle: 100 req/s, burst 200
- Quota: 500000 / MONTH
- Keys: `partner-a`, `partner-b`

---

## Custom domain names

### What it is

Map a hostname (`api.example.com`) to REST API stages via **API mappings** (base path → API + stage).

Detail panels:

- **Domain configuration** — endpoint type (REGIONAL, EDGE, PRIVATE), security policy, routing mode.
- **Endpoint and certificate** — ACM certificate ARNs, mutual TLS truststore (reference).
- **API mappings** — path routing rules.

### Why use it

Production APIs rarely expose raw `execute-api` URLs. Custom domains provide stable URLs, TLS with ACM, and path-based versioning (`/v1`, `/v2`).

### How it works in StackSim

Domain configuration, mappings, and Host-header routing are active. StackSim does not modify DNS or provision ACM/CloudFront; use generated curl commands with `--resolve` or `Host` headers locally.

### Common AWS use cases

- `api.example.com` → `prod` stage.
- `api.example.com/v1` → legacy API; `api.example.com/v2` → new API.
- Regional domain with ACM certificate in the same region.

---

## VPC links

### What it is

Links a REST API private integration to a Network/Application Load Balancer ARN without exposing the backend publicly.

### Why use it

In AWS, VPC links create ENIs in your VPC so API Gateway can reach internal load balancers. This is the standard pattern for hybrid and private microservices.

### How it works in StackSim

Link lifecycle and integration references are modeled. No VPC or load balancer is created — map the target ARN to a local HTTP origin with `STACKSIM_APIGATEWAY_VPC_LINK_ORIGINS`.

### Common AWS use cases

- Private NLB fronting ECS services.
- Legacy on-premises systems reached through Direct Connect and NLB.

---

## Client certificates

### What it is

API Gateway can present a **client certificate** to your HTTP backend during mutual TLS. StackSim stores public certificate metadata and PEM data.

### Why use it

Backends that require client cert authentication (common in banking and B2B integrations) verify that calls originate from your API Gateway stage.

### How it works in StackSim

Opt-in self-signed generation (`STACKSIM_APIGATEWAY_ALLOW_CLIENT_CERTIFICATES=true`). Private keys are discarded; upstream mTLS is not fabricated.

### Common AWS use cases

- Associate a client certificate with the `prod` stage for integrations to a partner NLB requiring mTLS.

---

## Account settings

### What it is

Regional settings:

- **CloudWatch logs role** — IAM role API Gateway assumes to write execution logs.
- **Account throttling** — default token bucket applied when stage limits are not set.

### Why use it

Without the CloudWatch role, enabling execution logging on any stage fails in AWS. Account throttle sets the regional ceiling (default often 10,000 req/s in AWS accounts).

### How it works in StackSim

The role must exist in local IAM, trust `apigateway.amazonaws.com`, and allow CloudWatch Logs write actions.

### Common AWS use cases

- One-time account setup before enabling stage logs.
- Request limit increases from AWS Support for high-traffic accounts (account throttle documentation reference).

---

## Deploy, import, and export

Available from the REST API header actions:

| Action | Purpose |
|--------|---------|
| **Deploy API** | Snapshot current configuration to a deployment; optionally attach to a new or existing stage |
| **Import API** | Merge or overwrite from OpenAPI 3.x / Swagger 2.0 |
| **Export API** | Download stage snapshot as OpenAPI or Swagger with optional API Gateway extensions |

**Why use it:** Import/export is how teams treat API Gateway as infrastructure-as-code alongside CloudFormation, CDK, and Terraform. Deploy creates the immutable artifact stages reference.

**Common AWS use cases:**

- Import design-first OpenAPI from Apiary or Stoplight.
- Export `prod` stage for client SDK generation in CI.
- Merge a updated OpenAPI fragment without recreating the API.

---

## Quick reference: REST vs HTTP vs WebSocket

| Capability | REST | HTTP | WebSocket |
|------------|------|------|-----------|
| API keys & usage plans | Yes | No | No |
| Request validators & models | Yes | No | Models only |
| VTL mapping templates | Yes | Limited | Yes |
| Stage cache | Yes | No | No |
| Resource policy | Yes | No | No |
| JWT authorizer | Via Cognito | Native JWT | No |
| Bidirectional connections | No | No | Yes |

For a feature-by-feature comparison in AWS, see [HTTP API vs REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html) in the AWS documentation.

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — hands-on CDK tutorials using API Gateway
- [IAM console guide](./iam-console-guide.md) — roles, policies, and authorizers
- [Secrets Manager console guide](./secrets-manager-console-guide.md) — encrypted credentials
- [EventBridge console guide](./eventbridge-console-guide.md) — event-driven API integrations
- [Cognito console guide](./cognito-console-guide.md) — user pools, JWTs, and managed login
- [Parameter Store console guide](./parameter-store-console-guide.md) — runtime configuration and secrets
- [DynamoDB console guide](./dynamodb-console-guide.md) — tables and items for API backends
- [S3 console guide](./s3-console-guide.md) — object storage companion console reference
- [AWS CLI cookbook](./aws-cli-cookbook.md) — CLI examples for API operations
- [Reference](./reference.md) — endpoints and environment variables
- [SQS console guide](./sqs-console-guide.md) — async workers alongside HTTP APIs
- [SES console guide](./ses-console-guide.md) — email sends triggered by API backends
- [SNS console guide](./sns-console-guide.md) — pub/sub alongside HTTP APIs (Publish integration blocked)
- [Lambda console guide](./lambda-console-guide.md) — Lambda integrations and authorizers
- [CloudWatch console guide](./cloudwatch-console-guide.md) — API access logs and metrics
- [CloudFormation console guide](./cloudformation-console-guide.md) — deploy APIs via CDK stacks
- [AppSync console guide](./appsync-console-guide.md) — GraphQL alternative to REST APIs
