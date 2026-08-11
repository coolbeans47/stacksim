# StackSim AppSync console guide

This guide explains every panel in the StackSim AppSync console: what each setting does, why you would use it in real AWS workloads, and how it maps to production AWS AppSync behavior.

StackSim models GraphQL APIs with API-key and IAM authorization, SDL schemas, VTL unit resolvers, NONE and DynamoDB data sources, local HTTP and WebSocket endpoints, and metrics. Cognito, Lambda, HTTP, OpenSearch, and other data sources remain unavailable.

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

| Nav item | Route | Purpose |
|----------|-------|---------|
| **APIs** | `#/appsync/apis` | List GraphQL APIs |
| **Create API** | `#/appsync/apis/create` | New API wizard |

API sections: `#/appsync/apis/{apiId}/overview`, `/schema`, `/queries`, `/api-keys`, `/monitoring`, `/tags`, `/data-sources`, `/resolvers/{type}/{field}`.

---

## APIs

### API catalog

Filterable table of API names with links to detail. **Create API** opens the creation form.

#### How it works in StackSim

API lifecycle, local HTTP and realtime endpoints, API-key and IAM authorization, schema execution, VTL resolvers, metrics, and tags are active. Console creates API-key APIs only.

---

### Create API

| Field | Purpose |
|-------|---------|
| **Name** | API display name |
| **Owner contact** | Optional contact string |
| **Tags (JSON object)** | Labels at creation |

Creates an API-key GraphQL API with regional local endpoints.

---

## API detail

Side navigation: **Overview**, **Schema**, **Queries**, **API keys**, **Monitoring**, **Tags**, **Data sources**, **Resolvers**.

### Overview

API details — name, owner, introspection enabled/disabled, authorization mode (API key / IAM), GraphQL URL, realtime URL, ARN, Region.

**Edit API** — name, owner, introspection toggle.

### Schema definition

SDL editor with **Save schema** and validation feedback. Defines types, Query, Mutation, and Subscription fields.

#### Why use it

GraphQL contract between clients and resolvers.

#### How it works in StackSim

Syntax and semantic validation, resolver-coordinate checks, authorization directives, introspection, subscriptions, and preservation of last valid schema on failure.

### Data sources

List with **Create data source**. Types: **NONE** (local VTL logic) or **DynamoDB** (same-Region table + IAM service role).

Detail page: description, type, table, role; **Edit**, **Delete**.

### Resolvers

Table of type/field coordinates linked to data sources. **Create resolver** or open detail.

Resolver detail: data source, request VTL template, response VTL template. **Edit**, **Delete**.

#### Example request template (DynamoDB GetItem)

```vtl
{
  "version": "2018-05-29",
  "operation": "GetItem",
  "key": { "id": $util.dynamodb.toDynamoDBJson($ctx.args.id) }
}
```

### API keys

Create keys with expiry; masked display with **Reveal** / **Copy**. Edit expiry, delete keys.

### Queries (operation editor)

GraphQL document editor, JSON variables, API key selector, **Run query**. Supports HTTP queries/mutations and process-local WebSocket subscriptions.

### Monitoring

AppSync metrics charts for the API (requests, latency, errors).

### Tags

Key-value table; **Manage tags**.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Authorization | API key, IAM |
| Data sources | NONE, DynamoDB |
| Resolvers | VTL UNIT only |
| APPSYNC_JS / pipeline | Unavailable |
| Cognito / OIDC / Lambda auth | Unavailable |
| Custom domains | Unavailable |
| Realtime | Local WebSocket; no replay outbox |

---

## Related StackSim docs

- [DynamoDB console guide](./dynamodb-console-guide.md) — resolver data sources
- [IAM console guide](./iam-console-guide.md) — service roles and `iam:PassRole`
- [CloudFormation console guide](./cloudformation-console-guide.md) — CDK AppSync resources
- [API Gateway console guide](./apigateway-console-guide.md) — REST vs GraphQL APIs
- [Lambda console guide](./lambda-console-guide.md) — unavailable Lambda resolver path
- [S3 console guide](./s3-console-guide.md) — static site hosting for GraphQL clients
- [CloudWatch console guide](./cloudwatch-console-guide.md) — API metrics
- [Developer guide](./developer-guide.md) — GraphQL application patterns
