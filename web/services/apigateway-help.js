import { panelHeading } from "../components.js";

const help = {
  apis: {
    level: "Supported locally",
    description: "An API is the public contract that receives a request and decides where it should go. REST APIs organize endpoints as resources and methods, HTTP APIs use lightweight routes, and WebSocket APIs keep bidirectional client connections open.",
    support: "REST, HTTP, and WebSocket API creation, configuration, deployment, invocation, import, and export are modeled locally. Edge, private-network, DNS, and public TLS behavior is represented only where the console explicitly describes a local boundary.",
  },
  resources: {
    level: "Supported locally",
    description: "A REST resource is a URL path such as /orders. Add methods such as GET or POST to decide how each request is authorized, validated, transformed, and sent to a Lambda function, HTTP service, AWS service, mock response, or private integration. Non-root resources can be deleted, including their child resources and methods.",
    support: "Resource trees, methods, integrations, request and response mappings, validation, CORS, authorization, deployments, deletion, and local invocation are active. A deployed stage uses an immutable snapshot, so redeploy after changing this panel.",
  },
  methods: {
    level: "Supported locally",
    description: "Each segmented pill represents one method on the selected resource. Choose the white method half to configure, test, or delete it; choose the blue Monitor half to open CloudWatch metrics.",
    support: "Method configuration, deletion, and test invocation are active locally. Monitor opens the metrics console, where you can select the relevant API Gateway dimensions and emitted series. Redeploy after deleting a method so stages stop serving it.",
  },
  models: {
    level: "Supported locally",
    description: "A model is a named JSON Schema for a request or response body. Models make an API contract easier to understand and can be paired with a request validator to reject malformed JSON before an integration runs.",
    support: "REST JSON Schema Draft 4 models and WebSocket message models can be created, edited, stored, exported, and used by the supported validation paths. StackSim does not generate application classes from a model.",
  },
  validators: {
    level: "Supported locally",
    description: "A request validator tells a REST method whether API Gateway should check the incoming body, required parameters, or both before calling the integration. Use one to fail bad requests early and keep validation rules consistent across callers.",
    support: "Validator lifecycle, required parameter checks, model-backed body validation, and deployment snapshots are active locally. Validation behavior changes only after the API is redeployed.",
  },
  restAuthorizers: {
    level: "Supported locally",
    description: "An authorizer makes an access decision before a REST method runs. A Lambda authorizer evaluates request identity and returns a policy; a Cognito user-pool authorizer validates a user token and optional scopes.",
    support: "Lambda TOKEN and REQUEST authorizers, local Cognito user-pool tokens, identity sources, caching, tests, and deployed authorization are active. Cognito pools must exist in this StackSim environment, and Lambda invoke permissions still apply.",
  },
  gatewayResponses: {
    level: "Supported locally",
    description: "Gateway responses customize errors produced by API Gateway itself, such as authorization failures, throttling, or an unknown route. Set a status, headers, or body templates when clients need a stable error format even though no backend ran.",
    support: "Response status overrides, parameters, mapping templates, reset behavior, and deployment snapshots are active for locally generated gateway errors.",
  },
  apiSettings: {
    level: "Supported locally",
    description: "Binary media types tell a REST API which Content-Types should be treated as bytes instead of text. Minimum compression size controls when eligible response bodies are compressed to reduce transfer size.",
    support: "Binary payload conversion, wildcard media types, compression thresholds, endpoint settings, validation, and deployment behavior are modeled locally. Regional is the native local endpoint; edge and private endpoint types remain compatibility descriptors.",
  },
  resourcePolicy: {
    level: "Supported locally",
    description: "A resource policy is an IAM-style policy attached to a REST API. Use it to allow or deny callers such as IAM principals or AWS services, often with source ARN and source-account conditions for least-privilege service integrations.",
    support: "Policy storage, validation, explicit deny precedence, IAM and supported service-principal evaluation, and deployment snapshots are active. Network-origin conditions that depend on real VPC infrastructure are not simulated.",
  },
  stages: {
    level: "Supported locally",
    description: "A stage is a named, invokable release of an API, such as dev or prod. It points to a deployment snapshot and is where runtime controls such as logging, metrics, throttling, caching, variables, and canary traffic are configured.",
    support: "REST, HTTP, and WebSocket stages, manual and automatic deployments, invoke URLs, access logs, metrics, throttling, variables, and supported release settings are active locally.",
  },
  deployment: {
    level: "Supported locally",
    description: "Deployment settings choose the immutable REST API snapshot served by this stage. Change the deployment to release a different API configuration, and optionally associate a published documentation version with it.",
    support: "Deployment selection, descriptions, documentation associations, invoke URLs, and authorizer-cache flushing are active locally.",
  },
  logging: {
    level: "Supported locally",
    description: "Logs and tracing control what API Gateway records while handling requests. Execution logs describe gateway processing, access logs provide one formatted record per request, and tracing adds request timing context for investigation.",
    support: "Execution and access logs are written to local CloudWatch Logs when a valid local IAM role and destination are configured. Detailed request data and local X-Ray-shaped tracing settings are supported within the simulator boundary.",
  },
  metrics: {
    level: "Supported locally",
    description: "Detailed metrics add API, stage, resource, and method dimensions to request counts, latency, integration latency, errors, and cache results. Enable them when per-route diagnosis is worth the extra metric series.",
    support: "Standard and detailed API Gateway metrics are emitted to local CloudWatch and can be inspected in the StackSim metrics console.",
  },
  cache: {
    level: "Supported locally",
    description: "A stage cache reuses eligible REST responses so repeated requests can avoid calling the integration. Configure the default GET behavior, time to live, encryption, client invalidation rules, and method-specific overrides carefully to avoid serving stale data.",
    support: "Runtime caching, TTLs, authenticated local encryption, method overrides, invalidation authorization, deployment invalidation, and manual flush are active. Cache capacity labels are compatibility settings rather than provisioned AWS hardware.",
  },
  throttling: {
    level: "Supported locally",
    description: "Throttling uses a token bucket to limit request rate and short bursts. Stage settings override the regional account default and help protect integrations from sudden or sustained traffic.",
    support: "Account, stage, method, route, and usage-plan throttles are enforced by the local request path and return API Gateway-style throttling responses.",
  },
  variables: {
    level: "Supported locally",
    description: "Stage variables are named strings that let one deployed API vary configuration by stage, commonly an integration host, Lambda alias, or environment label. Treat sensitive values as configuration, not as secrets.",
    support: "Variables persist locally, are available to supported mapping expressions and integrations, and can be overridden by REST canaries.",
  },
  canary: {
    level: "Supported locally",
    description: "A canary release sends a chosen percentage of stage traffic to a second deployment before full promotion. Use it to exercise a new snapshot with realistic requests while limiting its exposure.",
    support: "Deterministic traffic splitting, deployment selection, stage-variable overrides, cache choice, and promotion are active locally. Routing is deterministic so tests are repeatable rather than statistically random.",
  },
  routes: {
    level: "Supported locally",
    description: "A route matches an incoming HTTP method and path, such as GET /orders, or uses $default as a fallback. It connects that request to an integration and can require a Lambda or JWT authorizer.",
    support: "HTTP route matching, path parameters, $default, integrations, authorization, deployments, and local invoke endpoints are active.",
  },
  wsRoutes: {
    level: "Supported locally",
    description: "A WebSocket route selects what should handle a connected client's message. $connect and $disconnect cover connection lifecycle events, $default is the fallback, and custom route keys are selected from the configured message expression.",
    support: "Connection lifecycle, route selection, custom and reserved routes, integrations, deployments, live connections, and local management API calls are active.",
  },
  integrations: {
    level: "Supported locally",
    description: "An integration is the backend a route calls after API Gateway accepts a request. Use a Lambda proxy to pass an event to a function, or an HTTP proxy to forward the request to a service endpoint.",
    support: "HTTP API Lambda and HTTP proxy integrations, payload versions, parameter mapping, timeouts, and deployment snapshots are active. Public or private outbound targets still follow StackSim networking opt-ins.",
  },
  wsIntegrations: {
    level: "Supported locally",
    description: "A WebSocket integration handles a connection event or routed message. It can invoke Lambda, call an HTTP or supported AWS service target, transform a request, or return a mock response.",
    support: "Lambda, HTTP, AWS, proxy, and mock integration configuration is modeled; supported targets run locally with request templates, timeouts, deployment snapshots, and connection context.",
  },
  httpAuthorization: {
    level: "Supported locally",
    description: "HTTP API authorizers protect routes before their integrations run. JWT authorizers verify issuer, audience, expiry, and scopes, while Lambda request authorizers make a programmable decision from selected request identity values.",
    support: "JWT and Lambda REQUEST authorizers, local Cognito issuer resolution, scopes, identity sources, caching, simple responses, and route enforcement are active locally.",
  },
  wsAuthorization: {
    level: "Supported locally",
    description: "A WebSocket $connect authorizer is a Lambda REQUEST authorizer that approves or rejects the opening handshake. Use it when every connection must establish identity before it can send or receive messages.",
    support: "$connect authorization, identity sources, result caching, Lambda invocation, and connection rejection are active. Authorizers are not attached independently to later message routes.",
  },
  cors: {
    level: "Supported locally",
    description: "Cross-origin resource sharing controls which browser origins may call this HTTP API. Configure allowed origins, methods, headers, credentials, exposed headers, and preflight cache time to match the browser clients you trust.",
    support: "Preflight responses and CORS headers are generated locally, and configured API Gateway headers replace conflicting integration headers. Browser CORS enforcement remains the browser's responsibility.",
  },
  apiKeys: {
    level: "Supported locally",
    description: "An API key identifies a consumer for REST API usage metering, throttling, and quotas. It is not authentication by itself; pair protected methods with IAM, Cognito, or a Lambda authorizer when caller identity matters.",
    support: "Creation, import, enablement, rotation, value lookup, usage-plan association, metering, tags, and header or query extraction are active locally.",
  },
  keyValue: {
    level: "Supported locally",
    description: "The key value is the credential a caller sends, normally in x-api-key. Reveal it only when copying it to a client, and rotate it if it may have been exposed; rotation keeps the key identity and usage history.",
    support: "Reveal, copy, rotation, immediate request enforcement, and persisted usage history are active. StackSim stores this local development credential and does not integrate with an external secrets manager.",
  },
  usagePlans: {
    level: "Supported locally",
    description: "A usage plan combines deployed REST API stages with rate limits and request quotas, then applies those controls to associated API keys. Use plans to give different consumers predictable capacity or trial limits.",
    support: "Plan lifecycle, stage and key associations, default and method throttles, day/week/month quotas, offsets, usage records, and quota extensions are enforced locally.",
  },
  planThrottling: {
    level: "Supported locally",
    description: "Default throttling sets the sustained request rate and short burst capacity for every key using this plan. Use it as the consumer-level limit, then add method overrides only where an individual route needs different capacity.",
    support: "Usage-plan rate and burst limits, method overrides, token-bucket enforcement, and API Gateway-style throttling responses are active locally.",
  },
  quota: {
    level: "Supported locally",
    description: "A quota limits how many requests each associated key may make during a day, week, or month. The initial offset reduces the first period when access starts partway through a billing or trial cycle.",
    support: "Per-key quota periods, offsets, daily metering, remaining-request calculations, reset boundaries, and manual quota extensions are active locally.",
  },
  planStages: {
    level: "Supported locally",
    description: "API-stage associations decide where this usage plan applies. Add deployed stages and optional method overrides so associated keys inherit the correct limits only on those API releases.",
    support: "Stage associations, overlap validation, default throttles, and per-resource method throttles are active locally.",
  },
  planKeys: {
    level: "Supported locally",
    description: "Associated API keys are the consumers governed by this plan. A key can join more than one plan only when those plans do not cover the same API and stage.",
    support: "Key association, overlap checks, request metering, throttling, quotas, and removal without deleting the key are active locally.",
  },
  dailyUsage: {
    level: "Supported locally",
    description: "Daily usage shows how many metered requests each key made over a chosen date range and how much quota remains in its current period. Quota extensions adjust the remaining allowance without rewriting history.",
    support: "Per-key daily records, date ranges, current-period calculations, pagination-compatible data, and remaining-quota adjustments are active locally.",
  },
  domains: {
    level: "Control plane and local routing",
    description: "A custom domain gives callers a stable host name and maps one or more base paths to deployed REST API stages. Use it to avoid exposing API IDs in URLs and to organize versions such as /v1 and /v2.",
    support: "Domain configuration, mappings, routing precedence, policies, tags, and Host-header invocation are active locally. StackSim does not modify DNS or provision ACM, CloudFront, public certificates, or public TLS.",
  },
  domainEndpoint: {
    level: "Reference only",
    description: "Endpoint and certificate settings describe how a custom domain would terminate TLS and prove ownership in AWS. Certificate ARNs and an optional mutual-TLS truststore belong here when clients need a stable secured hostname.",
    support: "Certificate, ownership-verification, truststore, endpoint-type, and security-policy references are validated and persisted. They do not load certificate material or enable HTTPS; local TLS is a separate process-level opt-in.",
  },
  mappings: {
    level: "Supported locally",
    description: "An API mapping sends requests for a custom-domain base path to a particular REST API stage. More-specific paths win, while an empty mapping acts as the host's default destination.",
    support: "Creation, editing, deletion, multi-level base paths, stage selection, and local Host-header routing are active.",
  },
  vpcLinks: {
    level: "Partial",
    description: "A VPC link lets a REST API private integration refer to a load balancer without exposing that backend publicly. In StackSim it is the control-plane link between a target ARN and an explicitly allowed local HTTP origin.",
    support: "Link lifecycle, tags, integration references, status, and mapped HTTP forwarding are active. No VPC, ENI, load balancer, or private network is created; an explicit origin mapping and networking opt-ins are required.",
  },
  privateTarget: {
    level: "Partial",
    description: "The private integration target is the load-balancer ARN that REST methods reference through this VPC link. StackSim uses that stable ARN to look up the explicitly configured local HTTP origin.",
    support: "Target references, availability status, integration dependencies, and mapped forwarding are active. The target is not discovered from or connected through real VPC infrastructure.",
  },
  clientCertificates: {
    level: "Reference only",
    description: "An API Gateway client certificate is normally presented by a REST stage to a backend for mutual TLS authentication. Generate and associate one when backend ownership should be verified at the integration boundary.",
    support: "Opt-in self-signed public certificate generation, metadata, tags, stage references, and deletion checks are modeled. Private keys are unavailable and StackSim does not claim an upstream mTLS handshake.",
  },
  certificateDetails: {
    level: "Reference only",
    description: "Certificate details identify the API Gateway client certificate and its lifetime. Edit the description to document which private backend or stage association the certificate is intended for.",
    support: "Descriptions, timestamps, public PEM data, tags, stage references, expiry metadata, and guarded deletion persist locally. The private key is intentionally unavailable.",
  },
  documentation: {
    level: "Supported locally",
    description: "Documentation parts attach descriptions to APIs, resources, methods, parameters, responses, models, and authorizers. Publish an immutable version when a coherent documentation snapshot is ready for a stage or OpenAPI export.",
    support: "Part lifecycle, JSON import, version publishing, stage association, snapshots, and documented OpenAPI export are active locally.",
  },
  sdk: {
    level: "Partial",
    description: "SDK generation turns a deployed API stage into client code so an application can call its resources with less handwritten request logic. Select the stage whose deployed contract the client should target.",
    support: "A dependency-free JavaScript client archive is generated locally. Other language identifiers are shown for API compatibility but remain dependency-blocked.",
  },
  cloudWatchRole: {
    level: "Supported locally",
    description: "The API Gateway account role grants the service permission to create and write CloudWatch Logs for REST API stages in this region. Configure it before enabling execution logs on a stage.",
    support: "Local IAM role existence, API Gateway trust, required log permissions, account configuration, and stage log delivery are enforced. No AWS account or external role is modified.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels used to organize and identify API Gateway resources. Add stable names such as environment, owner, or cost-center so resources can be searched and managed consistently.",
    support: "Tag creation, replacement, removal, validation, listing, and local persistence are active. Billing allocation and organization-wide governance are outside StackSim.",
  },
};

const targets = [
  ['.card:has([data-filter-table])', "APIs", "apis"],
  ['.card:has([data-action="create-resource"])', "Resources", "resources"],
  ['.card:has([data-action="create-resource"])', "Methods", "methods", "h3", ".tree-details > h3"],
  ['.card:has([data-action="create-model"])', "Models", "models"],
  ['.card:has([data-action="create-validator"])', "Request validators", "validators"],
  ['.card:has([data-action="create-authorizer"])', "Authorizers", "restAuthorizers"],
  ['.card:has([data-edit-gateway-response])', "Gateway responses", "gatewayResponses"],
  ['.card:has([data-action="save-api-settings"])', "Binary media types and compression", "apiSettings"],
  ['.card:has([data-action="save-api-policy"])', "Resource policy", "resourcePolicy"],
  [".card.stage-shell", "Stages", "stages"],
  ['#stage-deployment', "Deployment", "deployment", "h3"],
  ['#stage-logs', "Logs and tracing", "logging", "h3"],
  ['#stage-metrics', "Metrics", "metrics", "h3"],
  ['#stage-cache', "Response cache", "cache", "h3"],
  ['#stage-throttling', "Throttling", "throttling", "h3"],
  ['#stage-variables', "Stage variables", "variables", "h3"],
  ['#stage-canary', "Canary release", "canary", "h3"],
  ['#stage-tags', "Tags", "tags", "h3"],
  ['.card:has([data-action="create-http-route"])', "Routes", "routes"],
  ['.card:has([data-action="create-http-integration"])', "Integrations", "integrations"],
  ['.card:has([data-action="create-http-authorizer"])', "Authorization", "httpAuthorization"],
  ['.card:has(#http-cors-form)', "Cross-origin resource sharing", "cors"],
  ['.card:has([data-action="create-http-stage"])', "Stages", "stages"],
  ['.card:has([data-action="create-ws-route"])', "Routes", "wsRoutes"],
  ['.card:has([data-action="create-ws-integration"])', "Integrations", "wsIntegrations"],
  ['.card:has([data-action="create-ws-model"])', "Models", "models"],
  ['.card:has([data-action="create-ws-authorizer"])', "$connect authorizers", "wsAuthorization"],
  ['.card:has([data-action="create-ws-stage"])', "Stages", "stages"],
  ['.card:has([data-filter-table])', "API keys", "apiKeys"],
  ['.card:has([data-action="rotate-key"])', "Key value", "keyValue"],
  ['.card:has([data-filter-table])', "Usage plans", "usagePlans"],
  ['.page-width:has([data-action="edit-plan"]) .card', "Default throttling", "planThrottling"],
  ['.page-width:has([data-action="edit-plan"]) .card', "Quota", "quota"],
  ['.card:has([data-action="manage-plan-stages"])', "Associated API stages", "planStages"],
  ['.card:has([data-action="associate-key"])', "Associated API keys", "planKeys"],
  ['.card:has(#usage-date-range)', "Daily usage", "dailyUsage"],
  ['.card:has([data-filter-table])', "Custom domain names", "domains"],
  ['.page-width:has([data-action="edit-domain"]) .card', "Domain configuration", "domains"],
  ['.page-width:has([data-action="edit-domain"]) .card', "Endpoint and certificate", "domainEndpoint"],
  ['.card:has([data-action="create-mapping"])', "API mappings", "mappings"],
  ['.card:has([data-filter-table])', "VPC links", "vpcLinks"],
  ['.page-width:has([data-action="edit-vpc-link"]) .card', "Link configuration", "vpcLinks"],
  ['.page-width:has([data-action="edit-vpc-link"]) .card', "Private integration target", "privateTarget"],
  ['.card:has([data-filter-table])', "Client certificates", "clientCertificates"],
  ['.page-width:has([data-action="edit-certificate"]) .card', "Certificate details", "certificateDetails"],
  ['.page-width:has([data-action="create-documentation-part"]) .card', "Documentation parts", "documentation"],
  ['.card:has([data-action="publish-documentation"])', "Documentation versions", "documentation"],
  ['.card:has([data-generate-sdk])', "SDK generation", "sdk"],
  ['.page-width:has([data-action="edit-account"]) .card', "CloudWatch logs role", "cloudWatchRole"],
  ['.card:has([data-action="edit-domain-tags"])', "Tags", "tags"],
  ['.card:has([data-action="edit-key-tags"])', "Tags", "tags"],
  ['.card:has([data-action="edit-plan-tags"])', "Tags", "tags"],
  ['.card:has([data-action="edit-vpc-tags"])', "Tags", "tags"],
];

export function decorateApiGatewayPanelHelp(root = document) {
  for (const [selector, title, helpKey, headingTag = "h2", headingSelector] of targets) {
    for (const heading of root.querySelectorAll(headingSelector ? `${selector} ${headingSelector}` : `${selector} > .card-header ${headingTag}`)) {
      const text = heading.textContent.trim();
      if (text !== title && !text.startsWith(`${title} (`)) continue;
      if (heading.closest(".panel-title-row")) continue;
      const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
      heading.outerHTML = panelHeading(title, help[helpKey], meta, headingTag);
    }
  }
}
