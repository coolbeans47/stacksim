# stacksim developer guide

This guide is a growing collection of hands-on tutorials for building AWS applications against stacksim with standard AWS tools and libraries.

## Overview

These tutorials use ordinary AWS CDK, SDK, and console workflows against a local stacksim instance. Nothing in the application code is stacksim-specific, so the same project can later be pointed at a real AWS account.

### Tutorial 1 — Build a notes API

You will create a CDK TypeScript project that deploys:

- an API Gateway REST API with `GET /notes` and `POST /notes`;
- a Lambda function that lists and creates notes; and
- a DynamoDB table that stores them.

You will synthesize and deploy the stack, then exercise both methods with the API Gateway console **Test** action. By the end you will have a working public notes API and a repeatable local CDK deploy loop.

### Tutorial 2 — Protect note creation with Cognito

You will extend the Tutorial 1 stack with:

- a Cognito user pool and app client;
- an API Gateway `COGNITO_USER_POOLS` authorizer; and
- Cognito protection on `POST /notes`, while `GET /notes` stays public.

You will register a user, confirm the email through the local SES Inbox, sign in for an ID token, and prove that create requires the token while list does not. This uses the standard Cognito authorizer path already supported by stacksim—no custom Lambda authorizer and no OAuth hosted-UI flow.

Complete Tutorial 1 before starting Tutorial 2. Tutorial 2 assumes the `notes-api` project, environment variables, and running stacksim instance from Tutorial 1.

## Tutorial 1: Build a notes API with CDK, Lambda, and DynamoDB

In this tutorial, you will create and deploy a small REST API that can:

- create a note with `POST /notes`;
- list all notes with `GET /notes`; and
- store the notes in a DynamoDB table.

The application uses an ordinary AWS CDK v2 TypeScript project. It contains no stacksim-specific constructs, wrappers, or modified AWS SDK clients, so the same application can later be deployed to AWS.

### What you will build

```text
stacksim API Gateway console
   |
   | Test method (GET or POST)
   v
API Gateway REST API
   |
   | Lambda proxy integration
   v
Node.js Lambda
   |
   | Scan or PutItem using AWS SDK for JavaScript v3
   v
DynamoDB notes table
```

CDK synthesizes the TypeScript infrastructure into an AWS CloudFormation template. When you deploy, CloudFormation creates the API, function, table, execution role, scoped IAM policy, and the permissions API Gateway needs to invoke Lambda.

### Why the tutorial is designed this way

- **CDK v2 L2 constructs:** these provide useful defaults while still producing ordinary CloudFormation resources.
- **One stack:** AWS recommends starting simply and adding complexity only when requirements justify it. A single stack is an appropriate deployment unit for this small API.
- **Explicit API methods:** only `GET /notes` and `POST /notes` are exposed instead of an unrestricted `ANY /{proxy+}` route.
- **Lambda proxy integration:** API Gateway passes the HTTP request to Lambda and returns the function's structured HTTP response.
- **TypeScript Lambda bundled by CDK:** `NodejsFunction` uses esbuild to transpile and bundle the handler.
- **AWS SDK v3 included in the deployment:** the function does not depend on whichever SDK version happens to be included in a Lambda runtime.
- **Client reuse:** the DynamoDB client is created outside the handler so warm Lambda invocations can reuse it. StackSim's supported Node.js ZIP path preserves that module-level singleton in a bounded execution-environment pool.
- **On-demand DynamoDB:** this avoids capacity planning for a small, unpredictable learning workload.
- **Least-privilege IAM:** the function receives only `dynamodb:Scan` and `dynamodb:PutItem` on its table.
- **Generated physical names:** CDK can create unique table, function, and API names for each stack deployment.

The [AWS CDK best-practices guide](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html), [Lambda TypeScript guide](https://docs.aws.amazon.com/lambda/latest/dg/typescript-handler.html), [Lambda best-practices guide](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html), and [DynamoDB on-demand guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html) explain these choices in more detail.

This chapter uses an API Gateway **REST API** because it follows stacksim's tested CDK L2 construct path and leaves room for later tutorials on REST features such as request validation and API keys. For a new AWS workload that does not need those features, also evaluate an **HTTP API**, which has a smaller feature set and lower price. AWS maintains a current [REST API and HTTP API comparison](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html).

The console's **Test** action uses API Gateway test invocation through the control plane, so it does not require CORS headers on the method. The tutorial intentionally avoids adding a permissive CORS policy that the current client does not need. Add an origin-specific CORS policy when a browser application becomes a real requirement.

### 1. Prerequisites

You need:

- Node.js 22.13 or newer;
- npm;
- a local clone of stacksim;
- a browser for the stacksim console; and
- two terminal windows.

An AWS account is not required when following the stacksim path.

This tutorial uses the CDK versions currently exercised by the stacksim test suite:

| Package       | Version    |
| ------------- | ---------- |
| `aws-cdk` CLI | `2.1132.0` |
| `aws-cdk-lib` | `2.265.0`  |
| `constructs`  | `10.7.1`   |

The versions are pinned in the project for reproducible builds. Upgrade them deliberately and commit the resulting `package-lock.json` changes.

### 2. Start stacksim with CDK support

Use the first terminal for the simulator. From the stacksim repository root, install dependencies and build it if you have not already done so:

```bash
npm install
npm run build
```

Start stacksim.

```bash
npm start
```

Keep this terminal running.

The simulator's web console is available at `http://127.0.0.1:4566/_stacksim/console`.

### 3. Configure the project terminal

Use the second terminal for the CDK project. Set ordinary AWS credentials, Region settings, and the standard global SDK endpoint:

```bash
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=eu-west-1
```

PowerShell:

```powershell
$env:AWS_ACCESS_KEY_ID = "admin"
$env:AWS_SECRET_ACCESS_KEY = "password"
$env:AWS_REGION = "eu-west-1"
$env:AWS_DEFAULT_REGION = "eu-west-1"
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:CDK_DEFAULT_ACCOUNT = "000000000000"
$env:CDK_DEFAULT_REGION = "eu-west-1"
```

The two local endpoints have different jobs:

| Endpoint                | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `http://127.0.0.1:4566` | AWS control-plane and SDK requests, CDK deployments, and the stacksim console |
| `http://127.0.0.1:4567` | Invoking deployed API Gateway APIs                                            |

### 4. Create a CDK TypeScript project

Choose a directory outside the stacksim repository, then create an empty project:

```bash
mkdir notes-api
cd notes-api
npx --package aws-cdk@2.1132.0 cdk init app --language typescript
mkdir lambda
```

`cdk init` must run in an empty directory. It creates the CDK application, stack, TypeScript configuration, tests, and npm metadata. This is the standard AWS workflow described in [Working with the AWS CDK in TypeScript](https://docs.aws.amazon.com/cdk/v2/guide/work-with-cdk-typescript.html).

Install the tested CDK versions, Lambda bundler, Lambda types, and DynamoDB SDK clients:

```bash
npm install --save-exact \
  aws-cdk-lib@2.265.0 \
  constructs@10.7.1 \
  @aws-sdk/client-dynamodb@3.1095.0 \
  @aws-sdk/lib-dynamodb@3.1095.0

npm install --save-dev --save-exact \
  aws-cdk@2.1132.0 \
  esbuild@0.28.1 \
  @types/aws-lambda@8.10.162
```

Use `npx cdk` for the remaining commands. It selects the project-local CLI version recorded in `package.json`.

Your important files will be:

```text
notes-api/
├── bin/
│   └── notes-api.ts
├── lambda/
│   └── notes.ts
├── lib/
│   └── notes-api-stack.ts
├── cdk.json
├── package-lock.json
├── package.json
└── tsconfig.json
```

### 5. Define the infrastructure

Replace `lib/notes-api-stack.ts` with:

```ts
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { join } from "node:path";

export class NotesApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new Table(this, "NotesTable", {
      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },
      billingMode: BillingMode.PAY_PER_REQUEST,

      // This is convenient for a disposable tutorial environment.
      // See "Production hardening" before using this policy in AWS.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const handler = new NodejsFunction(this, "NotesHandler", {
      entry: join(__dirname, "../lambda/notes.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      description: "Reads and writes notes in DynamoDB",
      environment: {
        TABLE_NAME: table.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        bundleAwsSDK: true,
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });

    // Grant only the two DynamoDB operations used by this tutorial.
    table.grant(handler, "dynamodb:Scan", "dynamodb:PutItem");

    const api = new RestApi(this, "NotesApi", {
      restApiName: "notes-api",
      description: "Tutorial notes API",
      deployOptions: {
        stageName: "dev",
      },
    });

    const notes = api.root.addResource("notes");
    notes.addMethod("GET", new LambdaIntegration(handler));
    notes.addMethod("POST", new LambdaIntegration(handler));

    new CfnOutput(this, "ApiId", {
      description: "API Gateway REST API ID",
      value: api.restApiId,
    });
    new CfnOutput(this, "StageName", {
      value: api.deploymentStage.stageName,
    });
    new CfnOutput(this, "AwsApiUrl", {
      description: "Use this URL when the stack is deployed to AWS",
      value: api.url,
    });
    new CfnOutput(this, "TableName", {
      value: table.tableName,
    });
  }
}
```

There are several details worth noticing:

1. The table name is not hard-coded. CDK generates a unique physical name and passes it to Lambda through `TABLE_NAME`.
2. `BillingMode.PAY_PER_REQUEST` selects DynamoDB on-demand capacity.
3. `NodejsFunction` bundles the TypeScript handler and its imported SDK packages with esbuild.
4. The SDK client will automatically receive the Lambda execution-role credentials and the simulator's local endpoint configuration.
5. `table.grant(...)` creates a resource-scoped IAM policy instead of putting credentials in code.
6. The API exposes only the two methods the application implements.
7. Outputs make deployment-generated identifiers available to people and automation without guessing resource names.

### 6. Set the stack environment

Replace `bin/notes-api.ts` with:

```ts
#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { NotesApiStack } from "../lib/notes-api-stack";

const app = new App();

new NotesApiStack(app, "NotesApiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

Environment lookups are kept at the application entry point. The stack itself receives configuration through its properties, which keeps it easier to test and reuse.

### 7. Write the Lambda handler

Create `lambda/notes.ts`:

```ts
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const tableName = process.env.TABLE_NAME;
if (!tableName) {
  throw new Error("TABLE_NAME is not configured.");
}

// Create clients once per Lambda execution environment, not once per request.
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

function json(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

function parseNote(body: string | null): Pick<Note, "title" | "content"> {
  if (!body) {
    throw new RequestError(400, "A JSON request body is required.");
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new RequestError(400, "The request body must be valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "The request body must be a JSON object.");
  }

  const input = value as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";

  if (!title || !content) {
    throw new RequestError(400, "title and content are required strings.");
  }
  if (title.length > 120) {
    throw new RequestError(400, "title must be 120 characters or fewer.");
  }
  if (content.length > 5_000) {
    throw new RequestError(400, "content must be 5,000 characters or fewer.");
  }

  return { title, content };
}

async function listNotes(): Promise<Note[]> {
  const notes: Note[] = [];
  let lastEvaluatedKey: Record<string, NativeAttributeValue> | undefined;

  // Scan responses are paginated. Continue until DynamoDB returns no key.
  do {
    const result = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    notes.push(...((result.Items ?? []) as unknown as Note[]));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return notes.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

async function createNote(body: string | null): Promise<Note> {
  const input = parseNote(body);
  const note: Note = {
    id: randomUUID(),
    title: input.title,
    content: input.content,
    createdAt: new Date().toISOString(),
  };

  await documentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: note,
      ConditionExpression: "attribute_not_exists(id)",
    }),
  );

  return note;
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    if (event.httpMethod === "GET" && event.resource === "/notes") {
      const notes = await listNotes();
      return json(200, {
        count: notes.length,
        notes,
      });
    }

    if (event.httpMethod === "POST" && event.resource === "/notes") {
      const note = await createNote(event.body);
      return json(201, { note });
    }

    return json(404, { message: "Route not found." });
  } catch (error) {
    if (error instanceof RequestError) {
      return json(error.statusCode, { message: error.message });
    }

    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "Request failed",
        requestId: event.requestContext.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return json(500, { message: "Internal server error." });
  }
}
```

The handler uses `DynamoDBDocumentClient`, so application objects can be written directly rather than manually converting every property to DynamoDB's low-level `AttributeValue` format.

For supported Node.js ZIP functions, StackSim makes the module-level reuse guidance executable: one initialized worker processes invocations sequentially and retains module state and its private `/tmp`; concurrent requests use separate workers. Each lease supplies fresh execution-role credentials, request/deadline/context, lineage, trace/correlation, and log metadata. A code or configuration update, crash, timeout, idle expiry, shutdown, or simulator restart creates a cold environment. This does not extend managed-runtime support beyond Node.js ZIP functions; local image invocation does not yet reuse or prewarm containers.

The list operation uses `Scan` because this first tutorial has one small table and no query requirements. A production data model should be designed around known access patterns and normally use `Query` with appropriate partition and sort keys instead of scanning an unbounded table.

API Gateway uses Lambda proxy integration here. The function must therefore return a numeric `statusCode` and a string `body`; otherwise, API Gateway can return `502 Bad Gateway`. See the [Lambda proxy integration response format](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html).

### 8. Build and synthesize

Run the generated TypeScript build:

```bash
npm run build
```

Then synthesize the stack:

```bash
npx cdk synth NotesApiStack
```

Synthesis executes the CDK application locally, bundles the Lambda, and writes the generated CloudFormation template and assets under `cdk.out/`. It does not create cloud resources.

If synthesis fails, fix the type or bundling error before deploying. Do not bypass the build just because the tutorial targets a local simulator.

### 9. Review the deployment

Ask CDK to show the infrastructure changes:

```bash
npx cdk diff NotesApiStack
```

On the first deployment, the diff will show new DynamoDB, Lambda, IAM, and API Gateway resources. On later deployments, inspect the diff for unintended replacements—especially replacements of stateful resources such as the DynamoDB table.

### 10. Deploy

Deploy through the standard CDK CLI:

```bash
npx cdk deploy NotesApiStack \
  --require-approval never \
  --outputs-file cdk-outputs.json
```

`--require-approval never` is suitable for this scripted local tutorial. In a shared or production AWS environment, review security-sensitive changes and use your team's approval process.

At the end of the deployment, `cdk-outputs.json` will look similar to:

```json
{
  "NotesApiStack": {
    "ApiId": "abc123def4",
    "StageName": "dev",
    "AwsApiUrl": "https://abc123def4.execute-api.eu-west-1.amazonaws.com/dev/",
    "TableName": "NotesApiStack-NotesTable..."
  }
}
```

The `AwsApiUrl` output has the normal AWS hostname because it is generated by the standard CDK construct. When targeting stacksim, construct the working local URL from `ApiId` and `StageName`:

```text
http://127.0.0.1:4567/{ApiId}/{StageName}
```

For the example output above, the base URL would be:

```text
http://127.0.0.1:4567/abc123def4/dev
```

Do not use port 4566 to invoke the deployed API. Port 4566 is the control plane; port 4567 is the API Gateway data plane.

### 11. Test with the API Gateway console

Open the stacksim console at `http://127.0.0.1:4566/_stacksim/console`, then open **API Gateway**.

1. Select the deployed `notes-api` REST API. Its ID matches the `ApiId` output from `cdk-outputs.json`.
2. Stay on the **Resources** tab.
3. In the resource tree, select `/notes`.

You should see `GET` and `POST` methods on that resource. Each method opens a method-execution panel where you can inspect the integration and run a test invocation.

Test invocations use the current mutable method configuration through the control plane. They do not call the stage invoke URL on port `4567`. Deployed stages keep their saved snapshot until you redeploy, so keep that distinction in mind if you later change a method without deploying.

#### Create a note

1. Select the `POST` method on `/notes` (either in the resource tree or in the method list).
2. In the method-execution panel, open the **Test** tab.
3. Set **Path with query string** to:

   ```text
   /notes
   ```

4. Leave **Headers (JSON)** as:

   ```json
   {
     "content-type": "application/json"
   }
   ```

5. Replace **Request body** with:

   ```json
   {
     "title": "My first local API",
     "content": "This note travelled through API Gateway and Lambda into DynamoDB."
   }
   ```

6. Select **Test**.

The result panel shows a JSON object with `status`, `body`, `headers`, `log`, and `latency`. You should see `"status": 201` and a `body` string similar to:

```json
{
  "note": {
    "id": "39c76ec4-fc6d-4f70-b63e-91b24a6247df",
    "title": "My first local API",
    "content": "This note travelled through API Gateway and Lambda into DynamoDB.",
    "createdAt": "2026-07-26T12:00:00.000Z"
  }
}
```

The ID and timestamp will be different. The `log` field shows the API Gateway execution trace, including the Lambda request.

#### List notes

1. Close the POST panel if it is still open, then select the `GET` method on `/notes`.
2. Open the **Test** tab.
3. Set **Path with query string** to `/notes`.
4. You can leave **Request body** empty or as `{}` for GET.
5. Select **Test**.

You should see `"status": 200` and a `body` similar to:

```json
{
  "count": 1,
  "notes": [
    {
      "id": "39c76ec4-fc6d-4f70-b63e-91b24a6247df",
      "title": "My first local API",
      "content": "This note travelled through API Gateway and Lambda into DynamoDB.",
      "createdAt": "2026-07-26T12:00:00.000Z"
    }
  ]
}
```

Run the POST test a few more times, then repeat the GET test to see the persisted records.

#### View a note in DynamoDB

The API response proves that Lambda can read the records. You can also inspect the stored items directly in the stacksim DynamoDB console:

1. Open **DynamoDB** in the service navigation, then select **Tables**.
2. Select the generated table whose name matches the `TableName` value in `cdk-outputs.json`. It begins with `NotesApiStack-NotesTable`.
3. Open the **Explore table items** tab.
4. Leave **Operation** set to **Scan** and **Table or index** set to the table, then select **Run**.
5. Find the row whose `title` is `My first local API`, then select **View**.

The **View item** dialog shows the same `id`, `title`, `content`, and `createdAt` attributes returned by the API. **Plain JSON** shows the application-friendly values; **DynamoDB JSON** shows the underlying DynamoDB attribute types. A scan is appropriate for this small tutorial table, but production applications should normally use `Query` or `GetItem` for known access patterns.

#### Check validation

Open the `POST` method **Test** tab again and send an invalid body:

```json
{
  "title": ""
}
```

The function should return `"status": 400` with a body of:

```json
{
  "message": "title and content are required strings."
}
```

### 12. Inspect the application in stacksim

Open `http://127.0.0.1:4566/_stacksim/console`, then inspect:

- **API Gateway** to see the REST API, `dev` stage, resource, and methods;
- **Lambda** to see the deployed function, environment, execution role, and invocations;
- **DynamoDB** to see the generated table and stored notes;
- **IAM** to inspect the generated execution role and table-scoped policy; and
- **CloudWatch** to inspect Lambda logs and service metrics.

This is a useful way to connect the compact CDK source to all the resources it generates.

### 13. Make and deploy a change

Change the Lambda response, validation, or CDK configuration, then repeat the safe deployment loop:

```bash
npm run build
npx cdk synth NotesApiStack
npx cdk diff NotesApiStack
npx cdk deploy NotesApiStack \
  --require-approval never \
  --outputs-file cdk-outputs.json
```

CDK and CloudFormation update the existing stack. Check `cdk diff` carefully if a proposed change replaces the table or another stateful resource.

### 14. Delete the tutorial resources

When finished, remove the stack:

```bash
npx cdk destroy NotesApiStack --force
```

The table uses `RemovalPolicy.DESTROY`, so destroying the stack permanently removes its notes. This is intentional for a disposable learning project.

The simulator-managed CDK bootstrap bucket and roles are installation resources. They are not part of `NotesApiStack` and remain after the stack is destroyed.

### 15. Troubleshooting

#### CDK reports a missing bootstrap version

If the error refers to `/cdk-bootstrap/hnb659fds/version`, check that `STACKSIM_CDK_BOOTSTRAP` is not set to `false`, then restart stacksim:

```bash
unset STACKSIM_CDK_BOOTSTRAP
npm start
```

Do not run `cdk bootstrap` against stacksim.

#### CDK cannot find credentials

Confirm that `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_ENDPOINT_URL` are set in the same terminal where you run `npx cdk`.

#### API Gateway Test fails

Confirm all of the following:

- stacksim is still running;
- the console URL uses `http://127.0.0.1:4566/_stacksim/console`;
- you opened the REST API whose ID matches `ApiId` in `cdk-outputs.json`;
- you selected the `/notes` resource and the matching `GET` or `POST` method; and
- **Path with query string** is `/notes`.

#### API Gateway returns 500

Open the Lambda logs in the stacksim console. Common causes are a missing `TABLE_NAME`, malformed JSON, or an SDK dependency that was excluded from the Lambda bundle.

The stack sets `bundleAwsSDK: true`, so both DynamoDB SDK packages should be present in the deployed asset.

#### API Gateway returns 502

Lambda proxy integrations require the response body to be a string. Confirm that every handler path returns the `APIGatewayProxyResult` structure produced by the `json(...)` helper.

#### TypeScript builds but Lambda bundling fails

Confirm that `esbuild` is installed in the project:

```bash
npm ls esbuild
```

Then run `npm install` again from the directory containing `package-lock.json`.

### 16. Production hardening

This project follows sound structural practices, but it deliberately remains a small, unauthenticated learning API. Before deploying a similar workload for real users:

1. **Protect data.** Change the table to `RemovalPolicy.RETAIN`, enable deletion protection, and configure point-in-time recovery according to your recovery objectives.
2. **Add authentication and authorization.** The tutorial API is public. Add an appropriate authorizer, define caller permissions, and test denial paths.
3. **Design DynamoDB access patterns.** Replace an unbounded `Scan` with key-based `Query` operations and pagination designed around the application's access patterns.
4. **Add idempotency where required.** A retried POST currently creates another note. Accept an idempotency key or use a stable caller-supplied identifier and a conditional write.
5. **Improve validation.** Define and version an API contract, reject unknown or oversized inputs, and consider API Gateway request validation as well as handler validation.
6. **Add observability.** Use structured logs without sensitive data, bounded log retention, metrics, alarms, tracing, and operational dashboards.
7. **Review runtime settings.** Load-test memory, timeout, concurrency, and DynamoDB capacity choices instead of copying tutorial values unchanged.
8. **Separate responsibilities when the API grows.** Multiple functions or constructs can create clearer ownership, narrower permissions, independent scaling, and smaller deployments.
9. **Use deployment stages and CI/CD.** Run type checks, unit tests, CDK assertions, security checks, `cdk diff`, and integration tests before promotion.
10. **Manage cost and quotas.** Add budgets and alarms in AWS and review API Gateway, Lambda, DynamoDB, log, and data-transfer pricing.

To deploy the project to AWS instead of stacksim:

1. unset `AWS_ENDPOINT_URL` and the local test credentials;
2. authenticate with your organization's approved AWS profile or IAM Identity Center flow;
3. set the intended account and Region;
4. run `cdk bootstrap` once for that real AWS account/Region if it is not already bootstrapped;
5. review `cdk diff` and any IAM changes; and
6. deploy, then use the `AwsApiUrl` output.

Real AWS resources can incur charges. Follow your organization's security, tagging, networking, backup, and deployment policies.

### 17. What you learned

You have now:

- initialized a standard CDK v2 TypeScript application;
- modeled DynamoDB, Lambda, IAM, and API Gateway resources in code;
- bundled a TypeScript Lambda with AWS SDK v3 dependencies;
- synthesized, reviewed, and deployed the stack through stacksim;
- created and read records through the API Gateway console Test action;
- inspected the generated resources; and
- updated and destroyed a CloudFormation-managed application.

Keep the `notes-api` project if you are continuing to Tutorial 2. That chapter adds a Cognito user pool and protects `POST /notes` with a standard Cognito authorizer.

This application is also a useful base for later work covering item-specific routes, update and delete operations, automated tests, OAuth scopes, logging and alarms, and CI/CD.

## Tutorial 2: Protect the notes API with Cognito

This tutorial extends the Tutorial 1 notes API so that creating a note requires a Cognito ID token, while listing notes remains public. It uses the standard API Gateway `COGNITO_USER_POOLS` authorizer—the same construct path you would use in AWS.

### What you will build

```text
Sign-up / sign-in (AWS SDK)
   |
   | Cognito ID token
   v
stacksim API Gateway console Test
   |
   | Authorization: Bearer <id-token>
   v
API Gateway REST API
   |  GET /notes  → public
   |  POST /notes → Cognito user-pool authorizer
   v
Node.js Lambda
   |
   v
DynamoDB notes table
```

By the end of this tutorial you will:

- add a Cognito user pool and app client to the CDK stack;
- attach a `CognitoUserPoolsAuthorizer` to `POST /notes`;
- register and confirm a user through the local SES Inbox;
- obtain an ID token with `InitiateAuth`; and
- prove unauthorized create fails while authorized create and public list succeed.

### Why the tutorial is designed this way

- **Standard Cognito authorizer:** API Gateway verifies the JWT itself. You do not write a Lambda authorizer for this path.
- **No method scopes:** an unscoped Cognito-protected method requires an **ID token** (`token_use=id`). Methods with `authorizationScopes` require an **access token** instead; that is a later extension.
- **POST protected, GET public:** this keeps the first auth change small and makes the before/after contrast obvious in the console Test panel.
- **Password auth for learning:** `USER_PASSWORD_AUTH` is enough to mint tokens locally. Managed login and OAuth authorize/token endpoints are available in stacksim, but they add domain, callback, and browser steps this chapter does not need.
- **Claims in Lambda:** after auth succeeds, the function can read verified claims such as `email` from the API Gateway request context.

### 1. Prerequisites

Complete Tutorial 1 first. You need:

- stacksim still running (`npm start` from the stacksim repository);
- the Tutorial 1 environment variables set in your project terminal;
- the `notes-api` CDK project from Tutorial 1; and
- a successful `NotesApiStack` deployment (or redeploy after the changes in this chapter).

### 2. Install the Cognito SDK client

From the `notes-api` directory, install the Cognito Identity Provider client used by the sign-up and sign-in scripts:

```bash
npm install --save-exact @aws-sdk/client-cognito-identity-provider@3.1095.0
```

The CDK Cognito and API Gateway constructs are already available through `aws-cdk-lib`; no extra CDK packages are required.

### 3. Add Cognito and the authorizer to the stack

Replace `lib/notes-api-stack.ts` with:

```ts
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import {
  CfnUserPool,
  CfnUserPoolClient,
  UserPool,
} from "aws-cdk-lib/aws-cognito";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { join } from "node:path";

export class NotesApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new Table(this, "NotesTable", {
      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Use Cognito L1 constructs so the template stays within stacksim's
    // registered UserPool/UserPoolClient property surface. The CDK L2
    // UserPool currently emits SMS verification fields that the local
    // provider rejects.
    const userPool = new CfnUserPool(this, "NotesUserPool", {
      userPoolName: "notes-users",
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
      adminCreateUserConfig: {
        allowAdminCreateUserOnly: false,
      },
      policies: {
        passwordPolicy: {
          minimumLength: 8,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: true,
          requireUppercase: true,
        },
      },
      accountRecoverySetting: {
        recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
      },
      schema: [
        {
          name: "email",
          required: true,
          mutable: true,
        },
      ],
    });
    userPool.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const userPoolClient = new CfnUserPoolClient(this, "NotesAppClient", {
      userPoolId: userPool.ref,
      clientName: "notes-app",
      generateSecret: false,
      explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
      preventUserExistenceErrors: "ENABLED",
    });

    const handler = new NodejsFunction(this, "NotesHandler", {
      entry: join(__dirname, "../lambda/notes.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      description: "Reads and writes notes in DynamoDB",
      environment: {
        TABLE_NAME: table.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        bundleAwsSDK: true,
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });

    table.grant(handler, "dynamodb:Scan", "dynamodb:PutItem");

    const api = new RestApi(this, "NotesApi", {
      restApiName: "notes-api",
      description: "Tutorial notes API",
      deployOptions: {
        stageName: "dev",
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, "NotesAuthorizer", {
      cognitoUserPools: [
        UserPool.fromUserPoolArn(this, "NotesUserPoolRef", userPool.attrArn),
      ],
      authorizerName: "notes-cognito",
    });

    const notes = api.root.addResource("notes");
    notes.addMethod("GET", new LambdaIntegration(handler));
    notes.addMethod("POST", new LambdaIntegration(handler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    new CfnOutput(this, "ApiId", {
      description: "API Gateway REST API ID",
      value: api.restApiId,
    });
    new CfnOutput(this, "StageName", {
      value: api.deploymentStage.stageName,
    });
    new CfnOutput(this, "AwsApiUrl", {
      description: "Use this URL when the stack is deployed to AWS",
      value: api.url,
    });
    new CfnOutput(this, "TableName", {
      value: table.tableName,
    });
    new CfnOutput(this, "UserPoolId", {
      value: userPool.ref,
    });
    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.ref,
    });
  }
}
```

Details worth noticing:

1. The user pool allows email self-sign-up and sends a confirmation code through local SES.
2. The app client sets `ExplicitAuthFlows` explicitly. stacksim requires that field rather than relying on Cognito defaults.
3. `CognitoUserPoolsAuthorizer` still uses the ordinary CDK authorizer construct; the pool is referenced by ARN from the L1 resource.
4. Only `POST /notes` sets `authorizationType: AuthorizationType.COGNITO`. `GET /notes` stays open.
5. No `authorizationScopes` are configured, so callers must present an **ID token**, not an access token.

### 4. Stamp the caller on created notes

Update `lambda/notes.ts` so a successful create records the authenticated email claim.

Change the `Note` interface to:

```ts
interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  createdBy?: string;
}
```

Replace `createNote` with:

```ts
async function createNote(
  body: string | null,
  createdBy?: string,
): Promise<Note> {
  const input = parseNote(body);
  const note: Note = {
    id: randomUUID(),
    title: input.title,
    content: input.content,
    createdAt: new Date().toISOString(),
    ...(createdBy ? { createdBy } : {}),
  };

  await documentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: note,
      ConditionExpression: "attribute_not_exists(id)",
    }),
  );

  return note;
}
```

In the handler, replace the `POST /notes` branch with:

```ts
    if (event.httpMethod === "POST" && event.resource === "/notes") {
      const claims = event.requestContext.authorizer?.claims as
        | Record<string, string>
        | undefined;
      const createdBy =
        typeof claims?.email === "string" ? claims.email : undefined;
      const note = await createNote(event.body, createdBy);
      return json(201, { note });
    }
```

API Gateway places verified Cognito claims under `requestContext.authorizer.claims` for REST Cognito authorizers. The function trusts that map only after the authorizer has accepted the token.

### 5. Add sign-up and sign-in scripts

Create `scripts/sign-up.mjs`:

```js
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { readFileSync } from "node:fs";

const outputs = JSON.parse(readFileSync("cdk-outputs.json", "utf8")).NotesApiStack;
const email = process.env.NOTES_EMAIL ?? "developer@example.com";
const password = process.env.NOTES_PASSWORD ?? "Local-password-1!";

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? "eu-west-1",
});

await cognito.send(
  new SignUpCommand({
    ClientId: outputs.UserPoolClientId,
    Username: email,
    Password: password,
  }),
);

console.log(`Signed up ${email}.`);
console.log(
  "Open SES → Inbox in the stacksim console, open the confirmation message, and copy the 6-digit code.",
);
console.log(
  "Then run one of:",
);
console.log(
  "macOS/Linux: CONFIRMATION_CODE=<code> node scripts/sign-in.mjs",
);
console.log(
  'PowerShell: $env:CONFIRMATION_CODE="<code>"; node scripts/sign-in.mjs',
);
```

Create `scripts/sign-in.mjs`:

```js
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { readFileSync } from "node:fs";

const outputs = JSON.parse(readFileSync("cdk-outputs.json", "utf8")).NotesApiStack;
const email = process.env.NOTES_EMAIL ?? "developer@example.com";
const password = process.env.NOTES_PASSWORD ?? "Local-password-1!";
const confirmationCode = process.env.CONFIRMATION_CODE;

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? "eu-west-1",
});

if (confirmationCode) {
  await cognito.send(
    new ConfirmSignUpCommand({
      ClientId: outputs.UserPoolClientId,
      Username: email,
      ConfirmationCode: confirmationCode,
    }),
  );
  console.log(`Confirmed ${email}.`);
}

const signedIn = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: outputs.UserPoolClientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  }),
);

const idToken = signedIn.AuthenticationResult?.IdToken;
if (!idToken) {
  throw new Error("Sign-in did not return an IdToken.");
}

console.log("IdToken:");
console.log(idToken);
console.log("");
console.log(
  "Paste this token into the API Gateway method Test headers as Authorization: Bearer <token>.",
);
```

These scripts rely on `AWS_ENDPOINT_URL` and the other Tutorial 1 environment variables already set in the project terminal.

### 6. Deploy the update

From `notes-api`:

```bash
npm run build
npx cdk synth NotesApiStack
npx cdk diff NotesApiStack
npx cdk deploy NotesApiStack \
  --require-approval never \
  --outputs-file cdk-outputs.json
```

The diff should show a new Cognito user pool, app client, API Gateway authorizer, and an update to the `POST` method. After deploy, `cdk-outputs.json` includes `UserPoolId` and `UserPoolClientId`.

Because API Gateway stages use immutable deployment snapshots, this CDK deploy creates a new deployment for the `dev` stage so the Cognito configuration is live for both console Test and the invoke URL.

### 7. Register a user and get an ID token

Sign up:

```bash
node scripts/sign-up.mjs
```

Open `http://127.0.0.1:4566/_stacksim/console`, go to **Amazon SES → Inbox**, open the verification message for `developer@example.com`, and copy the 6-digit confirmation code.

Confirm and sign in:

macOS/Linux:

```bash
CONFIRMATION_CODE=123456 node scripts/sign-in.mjs
```

PowerShell:

```powershell
$env:CONFIRMATION_CODE = "123456"
node scripts/sign-in.mjs
```

The PowerShell form can also be entered on one line:

```powershell
$env:CONFIRMATION_CODE="123456"; node scripts/sign-in.mjs
```

Copy the printed `IdToken`. Later sign-ins for the same confirmed user omit `CONFIRMATION_CODE`:

```bash
node scripts/sign-in.mjs
```

### 8. Test with the API Gateway console

Open **API Gateway**, select `notes-api`, and open the `/notes` resource.

#### Unauthorized create

1. Open the `POST` method, then the **Test** tab.
2. Set **Path with query string** to `/notes`.
3. Leave headers without an `Authorization` value, for example:

   ```json
   {
     "content-type": "application/json"
   }
   ```

4. Use any valid note body:

   ```json
   {
     "title": "Should be rejected",
     "content": "No token was supplied."
   }
   ```

5. Select **Test**.

The call should fail authorization before Lambda runs. In the method Test panel this usually appears as an `Unauthorized` error rather than a `201` result body.

#### Authorized create

1. Stay on the `POST` **Test** tab.
2. Set **Headers (JSON)** to:

   ```json
   {
     "content-type": "application/json",
     "Authorization": "Bearer PASTE_ID_TOKEN_HERE"
   }
   ```

3. Set **Request body** to:

   ```json
   {
     "title": "Authenticated note",
     "content": "Created with a Cognito ID token."
   }
   ```

4. Select **Test**.

You should see `"status": 201` and a note that includes `"createdBy": "developer@example.com"`.

#### Public list

1. Open the `GET` method **Test** tab.
2. Set **Path with query string** to `/notes`.
3. Select **Test** without an `Authorization` header.

You should see `"status": 200` and the notes list, including the authenticated note.

#### Wrong token type

If you paste an **access token** into the unscoped `POST` method, authorization should fail. Unscoped Cognito methods require an ID token. Access tokens are used when a method declares `authorizationScopes`.

### 9. Inspect Cognito and the authorizer

In the stacksim console:

- **Cognito** shows the `notes-users` pool, app client, and confirmed user;
- **API Gateway → Authorizers** shows `notes-cognito` with type `COGNITO_USER_POOLS`;
- **API Gateway → Resources → POST /notes** shows Cognito authorization; and
- **Amazon SES → Inbox** retains the confirmation message used during sign-up.

You can also open the authorizer and use its **Test** panel with:

```json
{
  "Authorization": "Bearer PASTE_ID_TOKEN_HERE"
}
```

That authorizer test path validates ID tokens. For method-level checks, prefer the method **Test** tab used above.

### 10. Troubleshooting

#### Deploy fails on Cognito resources

Confirm the app client sets `ExplicitAuthFlows`. stacksim rejects Cognito clients that omit it.

If you switch to the CDK L2 `UserPool` construct and deploy fails on `SmsVerificationMessage` or `VerificationMessageTemplate.SmsMessage`, keep the L1 `CfnUserPool` shape from this tutorial. Those SMS fields are outside the local Cognito CloudFormation property surface today.

#### Sign-up succeeds but no inbox message appears

Confirm stacksim is still running and you opened **Amazon SES → Inbox** for the same local environment. Cognito confirmation mail is captured locally; it is not delivered to a real mailbox.

#### Sign-in returns `NotAuthorizedException`

Confirm the user was confirmed with the correct code, the password matches `NOTES_PASSWORD`, and `UserPoolClientId` came from the latest `cdk-outputs.json`.

#### POST still succeeds without a token

Confirm CDK deployed successfully and you are testing the `POST` method on the API whose ID matches `ApiId`. Redeploy if the method still shows authorization `NONE` in the console.

#### POST fails with a token that looks valid

Confirm you pasted the **IdToken**, not the access token, and that the header is exactly `Authorization` with an optional `Bearer ` prefix. Token expiry also causes unauthorized responses; run `node scripts/sign-in.mjs` again.

### 11. Clean up

When finished with both tutorials:

```bash
npx cdk destroy NotesApiStack --force
```

This removes the API, Lambda, DynamoDB table, Cognito user pool, and app client. Historical SES Inbox messages may remain as local simulator mail.

### 12. What you learned

You have now:

- extended a CDK stack with Cognito user pool and app client resources;
- attached a standard `COGNITO_USER_POOLS` authorizer to a REST method;
- registered, confirmed, and authenticated a user against local Cognito;
- obtained an ID token and used it from the API Gateway Test panel;
- kept a public read path beside a protected write path; and
- read verified Cognito claims inside Lambda.

Natural next steps from here include protecting `GET /notes` as well, adding `authorizationScopes` with access tokens, using managed login / OAuth for browser clients, or mapping Cognito groups into finer-grained authorization decisions.
