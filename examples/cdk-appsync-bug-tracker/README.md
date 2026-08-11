# Team Bug Triage Board

This example is a complete React and AWS CDK v2 application that demonstrates
StackSim AppSync with a realistic issue-tracking workflow. An unmodified
`cdk deploy` creates the API, schema, API key, DynamoDB data sources, VTL unit
resolvers, tables, IAM role, and S3 website through CloudFormation.

For a guided tour of the application and a step-by-step explanation of what
happens when a bug is created, see the [Team Bug Triage Board guide](GUIDE.md).

The application supports five Kanban states (`BACKLOG`, `TRIAGE`,
`IN_PROGRESS`, `READY`, and `RESOLVED`), filters, assignment, user workload,
bug detail and editing, create/delete, resolve/reopen, drag-and-drop, keyboard
and select-based movement, explicit refresh, optional labelled 15-second
polling, and responsive desktop/390-pixel layouts.

## Security warning

This is intentionally a local, unauthenticated demonstration. The generated
`config.json` exposes an AppSync API key to the browser so the React
application can call GraphQL directly. The deployment script writes the key
only to the ignored `.runtime/deployment.json` and the generated website
object. The application keeps it in page memory and does not put it in source
control, URLs, `localStorage`, or `sessionStorage`.

Do not copy this authentication model into a production application.

## Architecture

```text
React browser
  | POST GraphQL + x-api-key
  v
StackSim AppSync API
  | schema-bound VTL UNIT resolvers
  | assumes appsync.amazonaws.com IAM role
  v
DynamoDB
  |- BugUsers (PK: id)
  `- BugTickets (PK: id)
       |- by-status   (status, updatedAt)
       `- by-assignee (assigneeId, updatedAt)

CDK -> CloudFormation -> five AWS::AppSync::* providers
                    -> IAM / DynamoDB / S3 / deployment providers
```

Every seed and UI data operation goes through the deployed GraphQL endpoint.
The seed never writes directly to DynamoDB. The smoke test additionally reads
the two tables through the official DynamoDB client to prove that AppSync wrote
the authoritative service state.

## Prerequisites

- Node.js 22.13 or newer
- a built, running StackSim; its reduced CDK bootstrap is enabled automatically
- the standard local administrator credentials

Start StackSim from the repository root:

```bash
npm install
npm run build
npm start
```

In another terminal:

PowerShell:

```powershell
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
$env:AWS_REGION = "eu-west-1"
$env:AWS_DEFAULT_REGION = "eu-west-1"
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:STACKSIM_ACCOUNT_ID = "000000000000"
$env:CDK_DEFAULT_ACCOUNT = "000000000000"
$env:CDK_DEFAULT_REGION = "eu-west-1"
```

macOS or Linux:

```bash
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export STACKSIM_ACCOUNT_ID=000000000000
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=eu-west-1
```

## Install, build, deploy, and seed

```bash
cd examples/cdk-appsync-bug-tracker
npm install
npm run build
npm run deploy
```

`npm run deploy` performs this sequence:

1. builds the React bundle with a credential-free placeholder config;
2. synthesizes and audits the CDK assembly;
3. runs an unmodified CDK deployment;
4. writes the ignored `.runtime/deployment.json` from stack outputs;
5. uploads a no-store `config.json` containing the local endpoint and key;
6. seeds through AppSync GraphQL; and
7. runs the deployed smoke test.

The stack remains deployed and the command prints its website URL. Re-run the
seed safely:

```bash
npm run seed
```

Stable IDs (`USR-001` through `USR-006` and `BUG-101` through `BUG-112`) make
the operation an upsert. The command reports created and updated counts,
checks the manifest account, Region, API, endpoint, and both data sources,
then verifies list, status-index, and assignee-index queries.

## Commands

| Command | Purpose |
|---|---|
| `npm run build:frontend` | Bundle the React application |
| `npm run synth` | Run CDK synthesis |
| `npm run verify:assembly` | Pin the accepted resource/property inventory |
| `npm run build` | Frontend build, synthesis, and assembly verification |
| `npm run deploy` | Deploy, configure, seed, and smoke test |
| `npm run seed` | Idempotently upsert demo data through GraphQL |
| `npm run smoke` | Verify GraphQL, indexes, pagination, DynamoDB, and website |
| `npm test` | Run seed distribution/idempotency tests |
| `npm run test:e2e` | Run deployed desktop and 390-pixel browser workflows |
| `npm run test:visual` | Capture desktop and mobile screenshots |
| `npm run destroy` | Delete the deployed stack, including deployed website objects and its bucket |

## Runtime configuration

The checked-in frontend has only:

```json
{
  "configured": false,
  "message": "Run npm run deploy to generate local runtime configuration."
}
```

After deployment, `scripts/deploy.mjs` reads the CloudFormation outputs and
uploads a generated `config.json` to the website bucket. The key is not a
compile-time constant. Fetching the config with `cache: "no-store"` puts it
into React page memory only. The local `.runtime` directory and generated
frontend output are ignored.

If the API key is rotated or expires, run `npm run deploy` again so
CloudFormation updates the key and the deployment script uploads a matching
config.

## GraphQL from curl or Postman

Read values from `.runtime/deployment.json`:

```bash
GRAPHQL_ENDPOINT="$(node -p "require('./.runtime/deployment.json').graphqlEndpoint")"
APPSYNC_API_KEY="$(node -p "require('./.runtime/deployment.json').apiKey")"
```

List bugs:

```bash
curl -sS "$GRAPHQL_ENDPOINT" \
  -H 'content-type: application/json' \
  -H "x-api-key: $APPSYNC_API_KEY" \
  --data '{"query":"query { listBugs(limit: 5) { items { id title status severity assigneeId } nextToken } }"}'
```

Query the status GSI:

```bash
curl -sS "$GRAPHQL_ENDPOINT" \
  -H 'content-type: application/json' \
  -H "x-api-key: $APPSYNC_API_KEY" \
  --data '{"query":"query ByStatus($status: BugStatus!) { bugsByStatus(status: $status, limit: 10) { items { id title updatedAt } nextToken } }","variables":{"status":"TRIAGE"}}'
```

Save a complete bug:

```bash
curl -sS "$GRAPHQL_ENDPOINT" \
  -H 'content-type: application/json' \
  -H "x-api-key: $APPSYNC_API_KEY" \
  --data @- <<'JSON'
{
  "query": "mutation Save($input: BugInput!) { saveBug(input: $input) { id title status } }",
  "variables": {
    "input": {
      "id": "BUG-200",
      "title": "Example Postman mutation",
      "description": "A complete object is saved with DynamoDB PutItem.",
      "status": "BACKLOG",
      "severity": "LOW",
      "component": "Docs",
      "environment": "Local",
      "reporterId": "USR-006",
      "createdAt": "2026-07-29T12:00:00.000Z",
      "updatedAt": "2026-07-29T12:00:00.000Z"
    }
  }
}
JSON
```

Delete it:

```bash
curl -sS "$GRAPHQL_ENDPOINT" \
  -H 'content-type: application/json' \
  -H "x-api-key: $APPSYNC_API_KEY" \
  --data '{"query":"mutation Delete($id: ID!) { deleteBug(id: $id) { id } }","variables":{"id":"BUG-200"}}'
```

Postman uses the same endpoint, JSON body, `Content-Type: application/json`,
and `x-api-key` header.

## Table and index design

`BugUsers` has a string `id` partition key. `BugTickets` has a string `id`
partition key and two `ALL` projection global secondary indexes:

- `by-status`: partition key `status`, sort key `updatedAt`; supports newest
  tickets within one Kanban state.
- `by-assignee`: partition key `assigneeId`, sort key `updatedAt`; supports
  assigned workload and user-specific queries.

The unassigned seed bug omits `assigneeId`, so it is intentionally absent from
the assignee index. Moving and assigning read the current full bug in the
frontend and call `saveBug` with a complete input, avoiding unsupported dynamic
update-template behavior.

## Supported boundary

This example intentionally uses only currently executable StackSim behavior:

- `API_KEY` authorization
- inline SDL
- `AMAZON_DYNAMODB` data sources
- VTL `UNIT` resolvers
- `GetItem`, `PutItem`, `DeleteItem`, `Scan`, and indexed `Query`
- scoped opaque pagination
- standard GraphQL HTTP execution

It does not claim production authentication, subscriptions or realtime,
pipeline resolvers, `APPSYNC_JS`, Cognito, IAM GraphQL authorization, Lambda or
HTTP data sources, logging configuration, X-Ray, caching, conflict detection,
custom domains, merged APIs, AppSync Events, or Amplify generation. The UI
refetches after mutations and has an explicit refresh action. Optional polling
is visibly labelled and is not a subscription.

## Troubleshooting

**Missing `.runtime/deployment.json`**

Run `npm run deploy`. `seed`, `smoke`, browser, and visual tests intentionally
refuse to guess deployment identity.

**Wrong account, Region, or endpoint**

Set the environment variables shown above. The seed compares them with the
manifest and authoritative AppSync data sources and refuses cross-environment
writes.

**Wrong port**

`AWS_ENDPOINT_URL` must point at the StackSim control/website port (default
`4566`). AppSync’s returned GraphQL URL uses that port directly.

**Expired key**

Run `npm run deploy`. The CDK template requests a development expiry just under
the service’s one-year maximum, and the generated browser config is refreshed
after the update.

**Stale stack or frontend**

Run `npm run deploy` again. CDK updates the existing stack, BucketDeployment
publishes the current bundle, and `config.json` is uploaded after outputs are
read. If the stack is irreparably stale, run `npm run destroy` and redeploy.

**Browser shows the configuration error**

The website still contains the placeholder `config.json`. Confirm deployment
reached the post-deploy config upload and that the website bucket in the
manifest still exists.

**Destroy fails because the simulator stopped**

Restart StackSim with the same `STACKSIM_DATA_DIR`, Region, and ports. Stack,
AppSync, key material, tables, seed records, and website state are persistent.
