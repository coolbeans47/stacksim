import { panelHeading } from "../components.js";

const help = {
  apis: {
    level: "Supported locally",
    description: "A GraphQL API exposes one typed endpoint where clients request exactly the fields they need. Its schema defines the contract, resolvers connect fields to data, and authorization decides which callers may execute operations.",
    support: "API lifecycle, local HTTP and realtime endpoints, API-key and IAM authorization, schema execution, VTL resolvers, metrics, and tags are active. The console creates API-key APIs; Cognito, Lambda, and OIDC authorization are unavailable.",
  },
  apiConfiguration: {
    level: "Partial",
    description: "API configuration establishes the GraphQL service itself. Give it a recognizable name, choose whether schema introspection is available to clients, record an owner contact, and add tags for organization.",
    support: "Creation, naming, introspection control, owner contact, tags, and regional local endpoints persist locally. This editor intentionally creates API-key APIs only; custom domains, merged APIs, AppSync Events, and public AWS infrastructure are not provisioned.",
  },
  apiDetails: {
    level: "Partial",
    description: "API details control service-wide identity and access behavior. Introspection lets tooling discover the active schema, while the authorization mode determines which credentials clients must present before GraphQL execution.",
    support: "Names, owner contact, introspection, API-key authorization, and supported IAM authorization are enforced locally. Cognito user pools, Lambda and OIDC authorizers, WAF, custom domains, merged APIs, and AppSync Events are unavailable.",
  },
  schema: {
    level: "Supported locally",
    description: "The schema is the GraphQL contract: types describe available data, Query and Mutation fields define operations, and Subscription fields describe realtime updates. Resolvers must be attached to executable root fields that need data.",
    support: "SDL storage, syntax and semantic validation, resolver-coordinate checks, authorization directives, introspection, subscriptions, size limits, and preservation of the last valid schema are active locally.",
  },
  dataSources: {
    level: "Partial",
    description: "A data source tells a resolver where its data comes from. Choose NONE for local payload and template logic, or DynamoDB to read and write a same-Region table through an IAM service role.",
    support: "NONE and DynamoDB sources, table discovery, role trust, iam:PassRole checks, fresh assumed credentials, and resolver invocation are active. Lambda, HTTP, OpenSearch, EventBridge, RDS, and Bedrock data sources are unavailable.",
  },
  dataSourceConfiguration: {
    level: "Partial",
    description: "Data-source configuration binds a stable AppSync name to its backend and credentials. For DynamoDB, the table and service role determine both where requests run and what operations the resolver may perform.",
    support: "Descriptions, NONE/DynamoDB selection, table and role updates, permission enforcement, dependency checks, and deletion are active. Credentials are assumed per invocation and are never displayed or stored in this panel.",
  },
  resolvers: {
    level: "Partial",
    description: "A resolver connects one schema field to a data source. Its request mapping template turns GraphQL context into a backend operation, and its response template converts the backend result into the field value returned to the client.",
    support: "Console-managed VTL UNIT resolvers, bounded template validation and execution, NONE payloads, DynamoDB operations, errors, metrics, and CRUD lifecycle are active. APPSYNC_JS, console-managed pipeline functions, caching, and per-resolver metrics configuration are unavailable.",
  },
  resolverExecution: {
    level: "Partial",
    description: "Execution summarizes the resolver attached to this schema coordinate. Edit it to change the data source or the request and response VTL templates that run whenever a client selects this field.",
    support: "VTL UNIT execution, supported NONE and DynamoDB operations, mapping errors, field metrics, safe diagnostics, and updates are active. APPSYNC_JS and configurable pipeline functions are not available in this editor.",
  },
  apiKeys: {
    level: "Supported locally",
    description: "An API key is a time-limited developer credential that authorizes GraphQL requests to this API. Create one for local clients and examples, use short lifetimes, and rotate or delete it when it may have been exposed.",
    support: "Creation, expiry, editing, deletion, masking, explicit reveal and copy, HTTP authorization, and realtime authorization are active. Plaintext remains only in page memory and is not written to URLs, browser storage, history, or diagnostics.",
  },
  operation: {
    level: "Supported locally",
    description: "The operation editor runs a GraphQL query, mutation, or subscription against the active API. Select a key explicitly, edit an example or write an operation, supply JSON variables, and name the operation when the document contains more than one.",
    support: "Bounded HTTP queries and mutations, variables, operation selection, safe result rendering, diagnostics, and process-local WebSocket subscriptions are active. Realtime delivery has no replay or durable outbox, and enhanced subscription filters or invalidation are unavailable.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are key-value labels for organizing an API by environment, owner, project, or another convention. Manage them here when local tooling or people need consistent metadata for finding and grouping APIs.",
    support: "Tag creation, replacement, removal, validation, listing, and persistence are active locally. AWS billing allocation, organization tag policies, and cross-account governance are outside StackSim.",
  },
};

const targets = [
  ['.card:has([data-filter-table])', "APIs", "apis"],
  ['.card:has(#appsync-create-api)', "API configuration", "apiConfiguration"],
  ['.page-width:has([data-edit-api]) .card', "API details", "apiDetails"],
  ['.card:has(#appsync-schema-form)', "Schema definition", "schema"],
  ['.card:has([data-filter-table])', "Data sources", "dataSources"],
  ['.page-width:has([data-edit-data-source]) .card', "Configuration", "dataSourceConfiguration"],
  ['.card:has([data-filter-table])', "Resolvers", "resolvers"],
  ['.page-width:has([data-edit-resolver]) .card', "Execution", "resolverExecution"],
  ['.page-width:has([data-create-key]) .card', "API keys", "apiKeys"],
  ['.card:has([data-run-query])', "Operation", "operation"],
  ['.page-width:has([data-manage-tags]) .card', "Tags", "tags"],
];

export function decorateAppSyncPanelHelp(root = document) {
  for (const [selector, title, helpKey] of targets) {
    for (const heading of root.querySelectorAll(`${selector} > .card-header h2`)) {
      const text = heading.textContent.trim();
      if (text !== title && !text.startsWith(`${title} (`)) continue;
      if (heading.closest(".panel-title-row")) continue;
      const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
      heading.outerHTML = panelHeading(title, help[helpKey], meta);
    }
  }
}
