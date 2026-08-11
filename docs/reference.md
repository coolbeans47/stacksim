# StackSim implementation reference

This is the public technical companion to the [main README](../README.md). It describes what StackSim actually implements, how the supported AWS-compatible surfaces behave, how to configure official AWS tools, and where the simulator deliberately differs from AWS. It is intended for application developers, contributors, and anyone deciding whether a local workflow is supported.

Use this document in the following order:

1. Start with **Implemented service surface** to check whether the behavior your application needs is present.
2. Follow **Additional AWS tool configuration** before running the CLI, SDK, or CDK examples.
3. Use the task-oriented examples for AppSync, Parameter Store, Secrets Manager, SNS, Cognito, SES, CDK, and the SDK.
4. Consult **Endpoints and persistence**, **Authentication modes**, and **Commands and configuration** when operating or embedding StackSim.
5. Read **Scope** before relying on an AWS feature that is not named here. Support is defined by documented behavior, not by an AWS namespace or service name alone.

This reference describes the current repository implementation. StackSim is a bounded learning simulator rather than a complete AWS replacement: unsupported operations fail explicitly, and local security, durability, scaling, networking, and service integrations should not be treated as production AWS guarantees.

## Implemented service surface

- AWS CDK and CloudFormation support unmodified CDK v2 deployments through a reduced local bootstrap, file assets, direct and change-set deployments, outputs and exports, updates, rollback, deletion, retention policies, and 105 registered resource providers. Nested stacks use real child stack records, local S3 template assets, parent/root relationships, linked change sets, recursive rollback, restart recovery, and retained-subtree detachment. General `Custom::*` resources use the bounded local ZIP-Lambda callback protocol. Full bootstrap templates, transforms and macros, resource import, StackSets, registry extensions, arbitrary helper ecosystems, and image-asset publication are not implied.

- DynamoDB everyday table/item CRUD, scan/query/batch behavior, exact AttributeValues, nested expressions, projections, conditions, updates, pagination, atomic transactions, deterministic Time to Live expiration, typed DynamoDB-subset PartiQL execution with official request-field pagination, exact-get/query/partition-IN/scan planning and statement-derived IAM context, a singleton/batch/transaction workbench, persistent table/capacity settings, immutable on-demand backups, second-resolution point-in-time recovery, durable Streams polling, table/index/stream resource policies, restart-safe multi-Region global tables, opted-in local DynamoDB JSON import/export, contributor-insights key-frequency metrics, and configuration-only Kinesis streaming destinations.
- Lambda local Node.js ZIP and digest-pinned OCI-image functions with lifecycle state, context, limits, timeouts/errors, execution-role credentials, resource policies, tags, versions, weighted aliases, synchronous log tail, permission-gated CloudWatch Logs output, durable asynchronous invocation, DynamoDB Streams and SQS event source mappings, SQS async/dead-letter/discarded-record destinations, account/reserved/qualified provisioned concurrency, immutable ordered layers, durable public/IAM function URLs, advanced runtime/infrastructure configuration, managed-instance capacity-provider control state, recursive-lineage protection, and durable checkpoint/replay execution. Node ZIP functions use bounded fingerprinted warm-worker pools: module state, SDK clients, private `/tmp`, and an environment's log stream persist across sequential leases, while credentials, request/deadline/context, client context, trace/correlation metadata, and lineage refresh per invocation. Concurrent invokes use different workers; code/config changes, timeout, crash, idle expiry, shutdown, and restart cold-start replacements. Provisioned concurrency reaches `READY` only after its Node ZIP workers initialize; image-function provisioned concurrency fails closed until reusable/prewarmed Docker containers exist.
- API Gateway v1 REST APIs with a mapped request/response pipeline, MOCK/Lambda/DynamoDB/SQS/HTTP and explicitly mapped private integrations, test invocation, immutable deployments, complete stage lifecycle, CORS/binary/compression/gateway responses, IAM/resource policies, Lambda and Cognito user-pool authorizers, Draft 4 request validation, OpenAPI import/export, logs/metrics/canaries/throttling, API-key usage plans, durable response caching, documentation, client certificates, JavaScript SDK generation, account settings, VPC links, and custom domains with longest-match base-path routing and opt-in local HTTPS; plus API Gateway v2 HTTP and WebSocket APIs with route-based Lambda proxy integrations, an SQS send-message service integration, authorization including automatic in-process Cognito issuer/JWKS resolution for HTTP JWT authorizers, stages, observability, domain mappings, persistent WebSocket connections, and signed management operations.
- AWS AppSync uses the unmodified official client to manage regional API-key GraphQL APIs, tags, atomic SDL schema generations, encrypted API keys, `NONE` and DynamoDB data sources, VTL unit/pipeline resolvers, and mapping-template evaluation through the bounded signed REST-JSON action set. API-key and `AWS_IAM` request/field authorization are enforced. Six exact `AWS::AppSync::*` providers deploy this surface through CloudFormation. The frozen Amplify Gen 2 Todo graph adds authoritative CRUD/filter/pagination and create/update/delete subscriptions; Cognito/Lambda/OIDC authorization, JavaScript resolvers, enhanced filters/invalidation, and Events remain unavailable.
- AWS Step Functions uses the unmodified official client and AWS JSON 1.0 for 23 lifecycle, execution, Activity, and task-response actions. It provides strict ASL validation; durable Standard workflow admission; immutable snapshots; JSONPath/intrinsics; retry/catch, Parallel and Inline Map; execution-role Lambda, DynamoDB item, SQS, SNS, EventBridge and nested-workflow integrations; stable attempt identity and owning-service durable acceptance reconciliation; opaque callback tokens and durable Activities; typed history; restart recovery; `AWS/States` metrics/status events; idempotently correlated EventBridge/Scheduler producer admission; and console inspection. Optimized EventBridge puts append execution/state-machine resources and fail the task on a partial response; nested `.sync` uses durable local polling with `states:DescribeExecution` and `states:StopExecution` checks instead of a managed EventBridge polling rule. `AWS::StepFunctions::StateMachine` still deploys only the bounded inline Standard Lambda subset owned by the earlier provider phase. S3 definitions, Activity CloudFormation, Express, JSONata, releases, Distributed Map, AWS SDK/HTTP integrations, cross-account tasks, and KMS remain unsupported.
- CloudWatch Logs groups, streams, events, filtering, pagination, retention, and tags; granular IAM-aware Lambda/API Gateway delivery, cross-service request correlation, direct service-console log links, and related-resource resolution; plus metric filters, durable permission-gated Lambda subscription delivery, destination/resource-policy catalogs, and opted-in local gzip exports.
- CloudWatch custom metrics, statistics, percentiles, metric math, bounded Metrics Insights SQL with grouped multi-series results, default-dataset control state, durable metric-stream lifecycle with opted-in local JSON delivery, custom and managed Contributor Insights rules/reports, retention roll-ups, and automatic Lambda, API Gateway, DynamoDB, and SQS telemetry.
- CloudWatch static and anomaly metric alarms with M-of-N and missing-data evaluation, deterministic expected-value bands, composite alarms with nested state rules and action suppression, and scheduled log alarms with persisted contributors, contributor-scoped history/actions, time-zone-aware alarm mute rules, tags, Lambda/dependency-blocked actions, and unified console workflows.
- CloudWatch account-global dashboards with lossless definitions, metric/log/alarm/explorer/text widgets backed by real data, variables, time and refresh controls, and a responsive editable grid.
- Amazon S3 general-purpose buckets and everyday object I/O through REST-XML, with encrypted content-addressed payloads, listings/waiters, ranges and conditions, current checksum families, presigned requests, atomic copy, multipart uploads, versioning, delete markers, bulk deletion, tags, SSE-C, Object Lock/retention/legal holds, annotations, lifecycle/storage classes/archive restore, durable SQS/Lambda/EventBridge notifications, request/delivery telemetry, and responsive governance/management/metrics workflows; plus a bounded CloudFormation/CDK public React website path with exact public-read policy and index-document hosting.
- Amazon SQS durable Standard, fair, and FIFO queues through AWS JSON 1.0 and Query/XML, with everyday message I/O, FIFO ordering/deduplication/receive replay, delays, visibility, long polling, retention, partial batches, purge, tags, IAM checks, group-aware queue metrics, encrypted payload storage, DLQ/redrive policies, Lambda workers and destinations, API Gateway producers, and responsive queue/message/DLQ/trigger workflows.
- Amazon SNS provides 18 official Query/XML actions, durable encrypted Standard-topic fan-out to SQS and Lambda, filters, raw delivery, policies, managed retries, Standard SQS DLQs, signature versions 1 and 2, delivery metrics and logs, four CloudFormation providers, pinned CDK L1/L2 deployment, and policy-aware Lambda, DynamoDB Streams, CloudWatch alarm, EventBridge, and CloudFormation notification producers.
- Amazon SES v1 Query/XML and SES v2 REST-JSON everyday sending with verified identities, simple/raw/templated MIME, shared stored templates, sending-enabled configuration sets, regional quotas, a durable SQLite mailbox, and a responsive local Inbox. Accepted mail is captured locally before `MessageId` is returned and is never submitted to an external SMTP server.
- Amazon Cognito User Pools provide pool and app-client lifecycle, email self-sign-up and administration, password, administrator and SRP authentication, groups, MFA, Lambda triggers, refresh and revocation, RS256 tokens, resource servers and custom scopes, local user-pool domains, managed login, OAuth grants, external OIDC authorization-code and signed SAML POST federation, attribute mapping and account linking, deployed REST/HTTP API Gateway authorization, eight CloudFormation/CDK resource providers, and responsive pool, user, client, and provider workflows.
- Amazon RDS provides one loopback-only local development instance backed by embedded SQLite, using official Query/XML control-plane calls and the fail-closed [`mysql8-orm-v1`](rds-mysql8-development-profile.md) SQL profile. Exact Knex 3.3.0 and Sequelize 6.37.8 fixtures cover migrations, introspection, CRUD, transactions, reconnect, and restart; other ORM/version compatibility is not implied. It also includes durable SQL files and private credentials, installation-wide quota enforcement, lifecycle/modification workflows, tags, safe parameter groups, and immutable checksummed manual/final snapshots with installation-local copy and free-slot restore under a new credential. PITR and automated backups remain unavailable.
- Amazon EventBridge and Scheduler provide default and custom buses, event-pattern matching, input transforms, Lambda, Standard/fair/FIFO SQS, CloudWatch Logs, deployed API Gateway, and Standard Step Functions targets, target execution roles and resource policies, restart-safe retries and SQS DLQs, Lambda asynchronous destinations, CloudWatch alarm event publication, bounded recursion lineage, `AWS/Events` metrics, redacted diagnostics, legacy rule schedules, and the official Scheduler control surface for `at`, `rate`, and `cron` schedules. Step Functions deliveries checkpoint only after normal durable `StartExecution` admission.
- AWS Systems Manager Parameter Store provides 13 actions through AWS JSON 1.1, Standard/Advanced values, selectors, history, hierarchy reads, tags, exact expiration/notification/no-change policies with safe EventBridge events, IAM, the protected bootstrap parameter, `AWS::SSM::Parameter`, and bounded dynamic references. This is Parameter Store support, not general Systems Manager support.
- AWS Secrets Manager provides 20 actions through AWS JSON 1.1, encrypted values, stages/rollback, batch reads, configured-account identity resource policies, deletion/restoration, IAM, bounded dynamic references, existing permitted non-VPC Lambda rotation with durable four-step checkpoints, bounded local RDS target attachment/managed credentials, and `Secret`, `ResourcePolicy`, `RotationSchedule`, and `SecretTargetAttachment` providers.
- IAM users, groups, access keys, roles, managed/customer/inline policies, policy versions and attachments, SigV4 validation/enforcement, policy evaluation, and authorization diagnostics. IAM operations resolve their frozen primary resource type before evaluation: existing entities use their persisted path-qualified ARN, creates use the normalized requested path, access-key actions use the owning user, membership actions use the group (while `ListGroupsForUser` uses the user), and attach/detach operations use the owning entity with the managed policy ARN in `iam:PolicyARN` context.
- STS `AssumeRole`, `GetCallerIdentity`, and `GetAccessKeyInfo`, including trust policies, session policies/tags, role chaining, expiration, and restart persistence.
- A dependency-free StackSim web console with working pages for every feature above.

## Seed contents

The seed preserves resources with matching names and creates:

- `LearningNotes`, with five sample DynamoDB items;
- `learning-notes-api`, an AppSync GraphQL API over `LearningNotes` with a one-year
  local API key, DynamoDB service role, VTL resolvers, list/filter pagination, and
  get/save/delete operations;
- `notes-api`, a Lambda that reads and writes the table through AWS SDK v3;
- `learning-api`, with a `dev` stage and `/notes` routes;
- `local-lambda` and the scoped `LearningNotesAccess` IAM policy;
- `/stacksim/learning`, a tagged CloudWatch log group with a starter event;
- RDS instance `learning-db`, database `learning_app`, and an issue-tracker
  dataset: `bug_users` (6 rows) and `bug_tickets` (12 rows). The tickets cover
  multiple components, environments, severities, workflow states, reporters,
  assignees, resolved work, and an unassigned backlog item.

The command prints the API Gateway ID, Postman-ready URLs, AppSync GraphQL
endpoint and API key, query-editor link, and the password-free RDS endpoint and
row counts. The RDS seed uses `STACKSIM_RDS_PORT` (default `3307`) and
`STACKSIM_RDS_PASSWORD` (default `LocalLearningSecret123`). It preserves
unrelated rows and refuses to replace another instance occupying the
installation-wide RDS slot. A POST body can be:

```json
{
  "title": "Learning locally",
  "body": "This request went through API Gateway and Lambda into DynamoDB."
}
```

## Additional AWS tool configuration

Set the standard client-side AWS credentials, Region, and global endpoint in the terminal that runs the AWS CLI, CDK, or application. On a fresh installation, access key ID `admin` and secret access key `password` belong to the durable IAM user `admin`; this is not an IAM console-password login. The user receives authority through the normal `AdministratorAccess` policy.

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

Bash:

```bash
export AWS_ACCESS_KEY_ID=admin
export AWS_SECRET_ACCESS_KEY=password
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=eu-west-1
```

Current AWS SDKs and tools use the official [`AWS_ENDPOINT_URL` setting](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html) for all service requests. Service-specific settings such as `AWS_ENDPOINT_URL_DYNAMODB` override the global value. With the environment above, ordinary commands target stacksim without a wrapper:

```bash
aws sts get-caller-identity
aws dynamodb list-tables
aws lambda list-functions
```

## Create and call an AppSync GraphQL API

StackSim uses the official AppSync client for the control plane and the
returned URI for ordinary GraphQL-over-HTTP. With the standard environment
variables above, no wrapper or simulator header is needed:

```ts
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateDataSourceCommand,
  CreateGraphqlApiCommand,
  CreateResolverCommand,
  GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand,
} from "@aws-sdk/client-appsync";

const appsync = new AppSyncClient({ region: process.env.AWS_REGION ?? "eu-west-1" });
const api = (await appsync.send(new CreateGraphqlApiCommand({
  name: "hello-local",
  authenticationType: "API_KEY",
}))).graphqlApi!;

await appsync.send(new StartSchemaCreationCommand({
  apiId: api.apiId,
  definition: Buffer.from("type Query { hello: String }"),
}));
await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }));
await appsync.send(new CreateDataSourceCommand({
  apiId: api.apiId,
  name: "Local",
  type: "NONE",
}));
await appsync.send(new CreateResolverCommand({
  apiId: api.apiId,
  typeName: "Query",
  fieldName: "hello",
  dataSourceName: "Local",
  kind: "UNIT",
  requestMappingTemplate: '{"version":"2018-05-29","payload":"hello from stacksim"}',
  responseMappingTemplate: "$util.toJson($ctx.result)",
}));
const apiKey = (await appsync.send(new CreateApiKeyCommand({
  apiId: api.apiId,
}))).apiKey!.id!;

const response = await fetch(api.uris!.GRAPHQL!, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey },
  body: JSON.stringify({ query: "{ hello __typename }" }),
});
console.log(await response.json());
// { data: { hello: "hello from stacksim", __typename: "Query" } }
```

The current 26-action surface also covers API/tag/key/data-source/resolver
update, discovery, pagination, deletion, and `EvaluateMappingTemplate`.
`AMAZON_DYNAMODB` unit resolvers use a same-account, same-Region table and an
AppSync-trusted service role; creation and update require `iam:PassRole`, and
every invocation re-evaluates the live role and table policies. Pipeline and
JavaScript resolvers, other data sources, multi-auth, realtime, field logging,
The pinned AMX-09 one-model Amplify Gen 2 sandbox is supported narrowly. Start StackSim with `STACKSIM_APPSYNC_LOCAL_TLS=true`; before starting the Node frontend process, set `NODE_EXTRA_CA_CERTS` to `<data-dir>/data/cloudformation/custom-resource-pki/ca.pem`. The unchanged `ampx sandbox --once` then writes `amplify_outputs.json`, and `Amplify.configure(JSON.parse(...))` uses its HTTPS GraphQL URL and client-derived WSS `/realtime` URL directly. Rerun/watch/hotswap workflows, broader generated backends, caches, custom domains, merged APIs, and AppSync Events are not supported.
Direct CloudFormation/CDK support is limited to the five API-key/DynamoDB/VTL
unit resource types demonstrated by
[`examples/cdk-appsync-bug-tracker`](../examples/cdk-appsync-bug-tracker/README.md).

The AppSync console is available from the main navigation. It uses
the same AppSync service interface for API, schema, `NONE`/DynamoDB data-source,
VTL unit-resolver, key, tag, and deletion workflows; official DynamoDB and IAM
interfaces populate same-account, same-Region selectors. The query editor calls
the returned GraphQL endpoint and requires an explicitly selected in-memory API
key. Keys are masked and ephemeral, and bounded diagnostics retain no query,
variables, credentials, templates, authorization headers, or results.
Monitoring reads real permission-gated `AWS/AppSync` CloudWatch metrics and
labels field logs unavailable rather than fabricating telemetry.

## Store application configuration in Parameter Store

Parameter Store accepts the unmodified SSM client. Omit `KeyId` for `SecureString`: StackSim uses its installation-local service-default protection, which is deliberately not AWS KMS.

```ts
import {
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? "eu-west-1" });
await ssm.send(new PutParameterCommand({
  Name: "/my-app/dev/api-url",
  Type: "String",
  Value: "http://127.0.0.1:3000",
  Tags: [{ Key: "environment", Value: "dev" }],
}));
await ssm.send(new PutParameterCommand({
  Name: "/my-app/dev/token",
  Type: "SecureString",
  Value: "local-development-token",
}));

const hierarchy = await ssm.send(new GetParametersByPathCommand({
  Path: "/my-app/dev",
  Recursive: true,
  WithDecryption: false,
}));
const token = await ssm.send(new GetParameterCommand({
  Name: "/my-app/dev/token",
  WithDecryption: true,
}));
console.log(hierarchy.Parameters?.map(parameter => parameter.Name), token.Parameter?.Version);
```

Parameter history and labels are supported, including exact labeled selectors, signed pagination, explicit historical decryption, and atomic label movement/removal. Standard and Advanced `AWS::SSM::Parameter`, exact expiration/notification/no-change policies, typed `Value<String>`, bounded `ssm`/`ssm-secure` references, and safe Parameter Store EventBridge events are supported. Intelligent-Tiering/account defaults, sharing, and customer KMS keys are not supported.

## Store and retrieve an application secret

Secrets Manager accepts the unmodified client. Omit `KmsKeyId`: local installation encryption is deliberately not AWS KMS.

```ts
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "eu-west-1" });
await secrets.send(new CreateSecretCommand({
  Name: "my-app/dev/database",
  SecretString: JSON.stringify({ username: "local-user", password: "local-password" }),
  Tags: [{ Key: "environment", Value: "dev" }],
}));

const current = await secrets.send(new GetSecretValueCommand({ SecretId: "my-app/dev/database" }));
console.log(JSON.parse(current.SecretString!).username);
```

Customer KMS keys, hosted or VPC rotation, arbitrary target services, replication, and cross-account grants are not supported. The implemented local path uses an existing permitted Lambda ARN, one client token across the four documented steps, durable recovery, optional bounded RDS attachment, and the PSS-06 `RotationSchedule`/`SecretTargetAttachment` providers.

## Publish to SQS with Amazon SNS

The SNS example uses the unmodified official SNS and SQS clients. The queue policy must authorize the SNS service principal for the exact topic; `Publish` returns after SNS durably accepts every selected delivery intent, not after a consumer receives it:

```ts
import {
  CreateTopicCommand,
  PublishCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const region = process.env.AWS_REGION ?? "eu-west-1";
const accountId = "000000000000";
const sns = new SNSClient({ region });
const sqs = new SQSClient({ region });

const TopicArn = (await sns.send(new CreateTopicCommand({
  Name: "local-orders",
  Tags: [{ Key: "environment", Value: "local" }],
}))).TopicArn!;
const QueueUrl = (await sqs.send(new CreateQueueCommand({
  QueueName: "local-order-workers",
}))).QueueUrl!;
const QueueArn = (await sqs.send(new GetQueueAttributesCommand({
  QueueUrl,
  AttributeNames: ["QueueArn"],
}))).Attributes!.QueueArn!;

await sqs.send(new SetQueueAttributesCommand({
  QueueUrl,
  Attributes: {
    Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: QueueArn,
        Condition: {
          ArnEquals: { "aws:SourceArn": TopicArn },
          StringEquals: { "aws:SourceAccount": accountId },
        },
      }],
    }),
  },
}));
await sns.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: QueueArn }));
await sns.send(new PublishCommand({
  TopicArn,
  Subject: "Order created",
  Message: JSON.stringify({ orderId: "order-123" }),
  MessageAttributes: { kind: { DataType: "String", StringValue: "created" } },
  MessageGroupId: "tenant-a",
}));

const wrapped = (await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 1 }))).Messages?.[0];
console.log(JSON.parse(wrapped!.Body!));
```

Lambda subscriptions use the same topic call with `Protocol: "lambda"` after the function resource policy grants `lambda:InvokeFunction` to `sns.amazonaws.com` and constrains `AWS:SourceArn` to the topic. Filters, `FilterPolicyScope`, raw SQS delivery, Standard SQS DLQs, topic policies, signature versions 1 and 2, feedback logging, and the four Standard-topic CloudFormation resources are active. FIFO topics, archive/replay, HTTP/S, email, SMS, mobile push, Firehose, KMS, and X-Ray are not supported.

## Sign up and authenticate with Amazon Cognito

This end-to-end example uses the unmodified official client and the standard endpoint environment above. It creates a pool and public app client, reads the confirmation code through the private local SES Inbox, authenticates, independently verifies both JWT signatures and bindings against the pool JWKS, refreshes the session, and calls `GetUser`:

```ts
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  GetTokensFromRefreshTokenCommand,
  GetUserCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

const region = process.env.AWS_REGION ?? "eu-west-1";
const localEndpoint = process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566";
const email = "developer@example.com";
const cognito = new CognitoIdentityProviderClient({ region });

const pool = await cognito.send(new CreateUserPoolCommand({
  PoolName: "local-login",
  UsernameAttributes: ["email"],
  AutoVerifiedAttributes: ["email"],
  Schema: [{ Name: "email", Required: true, Mutable: true }],
}));
const poolId = pool.UserPool!.Id!;
const app = await cognito.send(new CreateUserPoolClientCommand({
  UserPoolId: poolId,
  ClientName: "local-web",
  ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  PreventUserExistenceErrors: "ENABLED",
}));
const clientId = app.UserPoolClient!.ClientId!;

await cognito.send(new SignUpCommand({
  ClientId: clientId,
  Username: email,
  Password: "Local-password-1!",
}));

// Open SES → Inbox in the signed-in stacksim console and copy the code.
// Private Inbox routes contain message data and therefore require SigV4.
const confirmationCode = process.env.LOCAL_CONFIRMATION_CODE;
if (!confirmationCode) throw new Error("Set LOCAL_CONFIRMATION_CODE from the local SES Inbox.");

await cognito.send(new ConfirmSignUpCommand({
  ClientId: clientId,
  Username: email,
  ConfirmationCode: confirmationCode,
}));
const signedIn = (await cognito.send(new InitiateAuthCommand({
  AuthFlow: "USER_PASSWORD_AUTH",
  ClientId: clientId,
  AuthParameters: { USERNAME: email, PASSWORD: "Local-password-1!" },
}))).AuthenticationResult!;

const issuer = `https://cognito-idp.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/${poolId}`;
const jwks = await fetch(
  `${localEndpoint}/_stacksim/cognito-idp/${encodeURIComponent(region)}/${encodeURIComponent(poolId)}/.well-known/jwks.json`,
).then(response => response.json()) as { keys: Array<JsonWebKey & { kid: string }> };
function verifyToken(token: string, use: "id" | "access") {
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
  const key = jwks.keys.find(candidate => candidate.kid === header.kid);
  if (
    header.alg !== "RS256"
    || !key
    || !verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${claimsPart}`, "ascii"),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signaturePart, "base64url"),
    )
    || claims.iss !== issuer
    || claims.token_use !== use
    || (use === "id" ? claims.aud : claims.client_id) !== clientId
    || claims.exp <= Math.floor(Date.now() / 1_000)
  ) {
    throw new Error(`Invalid Cognito ${use} token.`);
  }
  return claims;
}
verifyToken(signedIn.IdToken!, "id");
verifyToken(signedIn.AccessToken!, "access");

const refreshed = (await cognito.send(new GetTokensFromRefreshTokenCommand({
  ClientId: clientId,
  RefreshToken: signedIn.RefreshToken!,
}))).AuthenticationResult!;
console.log(await cognito.send(new GetUserCommand({ AccessToken: refreshed.AccessToken! })));
```

The Inbox and loopback OIDC discovery/JWKS URLs are private development tooling, not Cognito SDK operations. Cognito control actions use SigV4/IAM; public and signed-in actions use their native Cognito proofs. Managed-login routes use `/_stacksim/cognito-domain/<domain>/...` while tokens retain the canonical AWS-shaped issuer. Set `STACKSIM_COGNITO_PUBLIC_URL` (or `SimulatorOptions.cognitoPublicUrl`) to a stable HTTP(S) loopback origin; otherwise the bound `http://localhost:<control-port>` origin is used for that process. Credentials, query/fragment components, non-root paths, wildcards, and non-loopback hosts are rejected. Loopback identity providers work by default, ordinary private-network targets remain blocked, and `STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true` / `cognitoAllowPublicIdentityProviders` permits public HTTPS providers. Redirects, untrusted TLS, metadata/link-local/reserved targets, mixed DNS classes, oversized bodies, and unbounded waits remain blocked.

[`examples/cognito-saml-idp`](../examples/cognito-saml-idp/README.md) is a local React SAML learning identity provider. Its idempotent official-SDK setup script creates a pool, SAML provider, OAuth app client, and managed-login domain; the browser then exposes the decoded AuthnRequest, signs a selectable demo identity, posts the assertion to Cognito, exchanges the resulting authorization code, and displays the Cognito token claims. It uses a committed demonstration key and pretend identities and is explicitly not a production identity provider.

For a REST API, create a `COGNITO_USER_POOLS` authorizer with one or more same-account, same-Region pool ARNs and the bearer header identity source. An unscoped method accepts an ID token; a method with an authorization scope accepts an access token containing any configured scope. For an HTTP API, use the `JWT` authorizer type, the pool's canonical issuer, and one or more app-client IDs as its audience. StackSim resolves authoritative local keys in process, so no `apiGatewayJwtJwks` setting or network discovery is required. Both flows are supported through the direct API Gateway SDK, OpenAPI, console, and the registered CloudFormation/CDK resources.

## Capture email locally with Amazon SES

Use either unmodified official SDK package against the standard endpoint. Create the sender identity first, open its verification message under **Amazon SES → Inbox**, and activate the localhost verification link before sending:

```ts
import { SESv2Client, CreateEmailIdentityCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({ region: "eu-west-1" });
await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: "sender@example.com" }));

const sent = await ses.send(new SendEmailCommand({
  FromEmailAddress: "sender@example.com",
  Destination: { ToAddresses: ["developer@example.com"] },
  Content: {
    Simple: {
      Subject: { Data: "Local receipt" },
      Body: { Text: { Data: "Captured by stacksim." } },
    },
  },
}));
console.log(sent.MessageId);
```

The inbox is private simulator tooling, not an invented SES SDK operation. Successful sends mean **durably captured locally**, not delivered to a remote mail server. SES opens no SMTP, POP3, or IMAP listener; performs no MX lookup or external delivery; and does not claim real DKIM signing, ISP feedback, reputation, or production tracking. Mailbox payloads persist per account and Region in `.stacksim/data/ses/<account>/<region>/mailbox.sqlite`.

SES development defaults are production access enabled, sending enabled, 50,000 recipients per rolling day, 14 recipients per second, 10,000 captured messages, and 1 GiB logical mailbox content per account/Region. Override them with `STACKSIM_SES_MAX_24_HOUR_SEND`, `STACKSIM_SES_MAX_SEND_RATE`, `STACKSIM_SES_MAXIMUM_MAILBOX_MESSAGES`, and `STACKSIM_SES_MAXIMUM_MAILBOX_BYTES`. `STACKSIM_SES_PUBLIC_URL` may set a stable HTTP(S) loopback origin for verification links; without it, links use the bound local control port and a port-0 link is valid only for that simulator session.

The infrastructure-as-code surface registers `AWS::SES::EmailIdentity`, `AWS::SES::ConfigurationSet`, `AWS::SES::Template`, `AWS::SES::ConfigurationSetEventDestination`, `AWS::SES::ContactList`, and `AWS::SES::CustomVerificationEmailTemplate`. They use the same SES state as the official clients and keep retained or historical Inbox messages separate from stack-resource deletion. The pinned [`test/fixtures/cdk/ses-stack`](../test/fixtures/cdk/ses-stack) application covers synthesis, direct create, default change-set update and no-op behavior, enforced `identity.grantSendEmail(...)` sends, network isolation, destroy, and preserved historical Inbox mail. Other `AWS::SES::*` types are not implied.

For a one-off AWS CLI request, pass the endpoint explicitly instead:

```bash
aws dynamodb list-tables --endpoint-url http://127.0.0.1:4566 --region eu-west-1
```

## Deploy with AWS CDK and CloudFormation

The same global environment configures an unmodified standard AWS CDK v2 CLI because CDK uses several service clients during one deployment. The public registry contains exactly 105 resource types:

<details>
<summary>Complete CloudFormation resource-type list</summary>

| Service | Registered resource types |
| --- | --- |
| API Gateway REST | `AWS::ApiGateway::Account`, `ApiKey`, `Authorizer`, `BasePathMapping`, `BasePathMappingV2`, `ClientCertificate`, `Deployment`, `DocumentationPart`, `DocumentationVersion`, `DomainName`, `DomainNameAccessAssociation`, `DomainNameV2`, `GatewayResponse`, `Method`, `Model`, `RequestValidator`, `Resource`, `RestApi`, `Stage`, `UsagePlan`, `UsagePlanKey`, `VpcLink` |
| API Gateway v2 | `AWS::ApiGatewayV2::Api`, `ApiMapping`, `Authorizer`, `Deployment`, `DomainName`, `Integration`, `IntegrationResponse`, `Model`, `Route`, `RouteResponse`, `Stage` |
| AppSync | `AWS::AppSync::ApiKey`, `DataSource`, `GraphQLApi`, `GraphQLSchema`, `Resolver` |
| CDK and CloudFormation | `AWS::CDK::Metadata`, `AWS::CloudFormation::CustomResource`, `AWS::CloudFormation::Stack` |
| CloudWatch | `AWS::CloudWatch::Alarm`, `AnomalyDetector`, `CompositeAlarm`, `Dashboard`, `InsightRule`, `MetricStream` |
| Cognito | `AWS::Cognito::UserPool`, `UserPoolClient`, `UserPoolDomain`, `UserPoolGroup`, `UserPoolIdentityProvider`, `UserPoolResourceServer`, `UserPoolUser`, `UserPoolUserToGroupAttachment` |
| DynamoDB | `AWS::DynamoDB::GlobalTable`, `Table` |
| EventBridge | `AWS::Events::EventBus`, `Rule` |
| IAM | `AWS::IAM::ManagedPolicy`, `Policy`, `Role` |
| Lambda | `AWS::Lambda::Alias`, `CodeSigningConfig`, `EventInvokeConfig`, `EventSourceMapping`, `Function`, `LayerVersion`, `LayerVersionPermission`, `Permission`, `Url`, `Version` |
| CloudWatch Logs | `AWS::Logs::Destination`, `LogGroup`, `LogStream`, `MetricFilter`, `QueryDefinition`, `ResourcePolicy`, `SubscriptionFilter` |
| RDS | `AWS::RDS::DBInstance`, `DBParameterGroup` |
| S3 | `AWS::S3::Bucket`, `BucketPolicy` |
| Secrets Manager | `AWS::SecretsManager::Secret`, `ResourcePolicy`, `RotationSchedule`, `SecretTargetAttachment` |
| SES | `AWS::SES::ConfigurationSet`, `ConfigurationSetEventDestination`, `ContactList`, `CustomVerificationEmailTemplate`, `EmailIdentity`, `Template` |
| SNS | `AWS::SNS::Subscription`, `Topic`, `TopicInlinePolicy`, `TopicPolicy` |
| SQS | `AWS::SQS::Queue`, `QueuePolicy` |
| Systems Manager Parameter Store | `AWS::SSM::Parameter` |
| Step Functions | `AWS::StepFunctions::StateMachine` |
| StackSim CDK helper | `Custom::CDKBucketDeployment` |

</details>

Within the table, an abbreviated type name inherits the namespace of the nearest fully qualified name to its left. For example, `AWS::S3::Bucket`, `BucketPolicy` denotes `AWS::S3::Bucket` and `AWS::S3::BucketPolicy`.

Deployability is determined by the synthesized JSON template and each provider's closed property schema, not by the AWS namespace or CDK construct name. Unsupported properties fail rather than being stored as inert configuration. KMS-backed queues remain unsupported; EventBridge rules accept Lambda targets in the CloudFormation provider; API Gateway v2 response and model types are WebSocket-only; and ordinary RDS L2 constructs still require unavailable networking and secrets resources. General custom-resource protocol support does not make every generated CDK helper compatible: synchronous CDK `Provider` resources and the pinned Lambda `getFunction` `AwsCustomResource` path are covered, while `Custom::CDKBucketDeployment` uses its own closed native schema. Log-retention, S3 auto-delete, trigger, API helper, and other unverified generated helper graphs are not claimed.

## Aurora Atlas Signal Journey example

[`examples/cdk-full-stack-showcase`](../examples/cdk-full-stack-showcase/README.md) is the end-to-end showcase for this provider surface. Its three ordinary CDK stacks exercise exactly 31 resource types and deploy a React observatory whose asynchronous **Signal Journey** is:

```text
DynamoDB stream -> publisher Lambda -> EventBridge bus/rule
  -> relay Lambda -> SQS queue/redrive DLQ -> worker Lambda
  -> DynamoDB journey activity
```

The relay is deliberate: the bounded `AWS::Events::Rule` provider accepts Lambda targets, while direct rule-to-SQS targets are outside its documented schema. Atlas exposes live journey activity, queue depth, retry/quarantine state, and a controlled poison-message demonstration. Its deployment seeds twelve deterministic signals, verifies all twelve through the asynchronous path, and publishes the current frontend into the default persistent `.stacksim` installation so ordinary later `npm start` sessions reopen it. See the [showcase guide](../examples/cdk-full-stack-showcase/SHOWCASE-GUIDE.md) for deployment and interaction steps.

## Signal Relay SNS Routing Lab

[`examples/cdk-sns-routing-lab`](../examples/cdk-sns-routing-lab/README.md) is an SNS-first tutorial deployed through ordinary CDK. Its interactive routing map publishes each incident once to one Standard topic, then exposes the independent decisions made by three filtered Lambda subscriptions and one raw SQS audit subscription. The deterministic seed covers message-attribute filtering, nested message-body filtering, fan-out, Lambda notification envelopes, raw queue delivery, redrive configuration, topic/queue policies, and fifteen successful deliveries from six publications. The included README provides fresh-checkout installation, deployment, exercises, console inspection, cleanup, and troubleshooting instructions.

Custom-resource Lambda assets are trusted local code. The simulator sanitizes inherited host variables, copies only the public callback CA into the invocation directory, and blocks common process/network escape paths for the supported JavaScript helper corpus, but it is not an OS/container sandbox for hostile same-user code. Do not deploy untrusted provider ZIPs.

The tested CDK packages remain `cdk@2.1132.0`, `aws-cdk-lib@2.261.0`, and `constructs@10.7.1`. The ordinary workflow is:

```bash
npx cdk synth
npx cdk diff
npx cdk deploy --require-approval never
npx cdk destroy --force
```

stacksim automatically and idempotently manages its reduced file-asset bootstrap environment in the configured Region; do not run `cdk bootstrap` against it. Set `STACKSIM_CDK_BOOTSTRAP=false` only for unbootstrapped/custom-bootstrap negative tests. Standard AWS SDK/control-plane traffic and CDK asset uploads use `http://127.0.0.1:4566`. Deployed REST APIs use the separate data-plane URL `http://127.0.0.1:4567/{apiId}/{stage}/{path}`.

No bootstrap or root flag is required:

PowerShell:

```powershell
npm start
```

Bash:

```bash
npm start
```

The bootstrap bucket and its five simulator-owned roles persist across restarts and application-stack deletion. The reduced contract advertises bootstrap compatibility version 23 because its deploy role includes the `RollbackStack` and `ContinueUpdateRollback` permissions introduced by that CDK template version; ECR/image assets and the full bootstrap template remain explicitly unsupported. The only bootstrap reset is to stop stacksim and reset its whole data directory. Unreferenced CDK file assets are reclaimed after seven days by default; set `STACKSIM_CDK_ASSET_RETENTION_MS` in the simulator process to a non-negative millisecond value to change that local retention window.

## Example CDK project: Lambda REST API and DynamoDB

Create a normal CDK v2 TypeScript application. If CDK is not already installed in the project, `npx` can obtain it in the usual way:

```bash
mkdir local-api
cd local-api
npx -p aws-cdk@2.1132.0 cdk init app --language typescript
mkdir lambda
```

Use ordinary CDK constructs in `lib/local-api-stack.ts`:

```ts
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { join } from "node:path";

export class LocalApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new Table(this, "Items", {
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const handler = new LambdaFunction(this, "Handler", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(__dirname, "../lambda")),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadWriteData(handler);

    const api = new LambdaRestApi(this, "Api", { handler, proxy: true });
    new CfnOutput(this, "ApiId", { value: api.restApiId });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
```

Put a handler in `lambda/index.js`:

```js
exports.handler = async event => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true, tableName: process.env.TABLE_NAME, path: event.path }),
});
```

Keep the generated `bin/local-api.ts`, but give the stack an explicit local environment if it does not already have one:

```ts
new LocalApiStack(app, "LocalApiStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
```

With the standard AWS/CDK environment variables above set in this project terminal, deploy without any simulator-specific wrapper:

```bash
npx cdk synth LocalApiStack
npx cdk diff LocalApiStack
npx cdk deploy LocalApiStack --require-approval never --outputs-file cdk-outputs.json
```

Read `ApiId` from `cdk-outputs.json`, then invoke the local data plane at `http://127.0.0.1:4567/{ApiId}/prod/anything`. The `ApiUrl` emitted by some high-level CDK constructs is AWS-formatted, so use the local invocation form above while targeting stacksim. Update the constructs or handler and run the same deploy command again; CDK creates and executes a local change set. Remove the stack with:

```bash
npx cdk destroy LocalApiStack --force
```

The checked-in [`test/fixtures/cdk/rest-stack`](../test/fixtures/cdk/rest-stack) application is a complete working example and is exercised by the end-to-end suite. CloudFormation intentionally rejects resource types and properties outside the supported matrices instead of pretending that an undeployed AWS feature succeeded.

## Example CDK project: public React S3 website

The checked-in [`test/fixtures/cdk/react-bucket-deployment`](../test/fixtures/cdk/react-bucket-deployment) fixture is an ordinary TypeScript CDK application pinned to `cdk@2.1132.0`, `aws-cdk-lib@2.261.0`, and `constructs@10.7.1`. Its deterministic local build bundles real React HTML, JavaScript, and CSS into `frontend/dist`; the CDK source contains no stacksim-specific construct:

```ts
import { App, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { join } from "node:path";

const app = new App();
const stack = new Stack(app, "ReactBucketStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const bucket = new s3.Bucket(stack, "FrontendBucket", {
  versioned: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
  publicReadAccess: true,
  websiteIndexDocument: "index.html",
  removalPolicy: RemovalPolicy.RETAIN,
});

new s3deploy.BucketDeployment(stack, "DeployFrontend", {
  sources: [s3deploy.Source.asset(join(import.meta.dirname, "frontend", "dist"))],
  destinationBucket: bucket,
  prune: true,
});

new CfnOutput(stack, "FrontendBucketName", { value: bucket.bucketName });
new CfnOutput(stack, "FrontendWebsiteUrl", { value: bucket.bucketWebsiteUrl });
```

Use the standard `AWS_ENDPOINT_URL`/credential/Region environment from the section above. The reduced bootstrap is automatic. From the repository root, build, synthesize, template-diff, and deploy the fixture through the unmodified default synthesizer:

```powershell
Set-Location test/fixtures/cdk/react-bucket-deployment/frontend
npm run build
Set-Location ..
npx --no-install cdk synth ReactBucketStack
npx --no-install cdk diff ReactBucketStack --method template
npx --no-install cdk deploy ReactBucketStack --require-approval never --outputs-file cdk-outputs.json
```

Read the deployed bytes and metadata through the official S3 CLI, then open the anonymous local website output:

```powershell
$outputs = Get-Content cdk-outputs.json | ConvertFrom-Json
$bucket = $outputs.ReactBucketStack.FrontendBucketName
$website = $outputs.ReactBucketStack.FrontendWebsiteUrl
aws s3api get-object --bucket $bucket --key index.html downloaded-index.html
aws s3api head-object --bucket $bucket --key assets/app.js
Invoke-WebRequest -UseBasicParsing $website
```

`FrontendWebsiteUrl` is a real simulator-backed URL such as `http://127.0.0.1:4566/_stacksim/s3-website/<bucket>/`; it is not a fabricated AWS DNS name. Rebuild with `REACT_FIXTURE_VARIANT=v2` and deploy again to exercise changed bytes and `prune: true`; deploy the same build once more for the no-op path. An optional `CDK_FRONTEND_PREFIX` exercises safe destination-prefix preservation.

```powershell
Set-Location frontend
$env:REACT_FIXTURE_VARIANT = "v2"
npm run build
Set-Location ..
npx --no-install cdk deploy ReactBucketStack --require-approval never
npx --no-install cdk deploy ReactBucketStack --require-approval never
```

Destroy uses the construct's normal lifecycle. The generated bucket-policy resource is deleted, so anonymous website access can stop, while the `RemovalPolicy.RETAIN` application bucket and the deployment helper's default retained objects remain. The separate simulator-managed bootstrap bucket and all referenced assets also survive:

```powershell
npx --no-install cdk destroy ReactBucketStack --force
```

This is deliberately a bounded public application website bucket path backed by a separate private simulator-managed CDK asset bucket. It does not add CloudFront, `autoDeleteObjects`, ACL-based hosting, CORS, lifecycle, replication, notifications, KMS/DSSE, Object Lock, access points, general bucket policies, or the full S3 CloudFormation surface.

## Use AWS SDK v3

With the environment above, current AWS SDK v3 clients need no simulator-specific constructor options:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});
```

For explicit application configuration or an older SDK version that does not read the global endpoint setting, use the real service client with the local endpoint and default IAM administrator credentials:

```ts
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
  region: "eu-west-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "admin", secretAccessKey: "password" },
});

const result = await client.send(new ScanCommand({
  TableName: "LearningNotes",
  FilterExpression: "#done = :done",
  ExpressionAttributeNames: { "#done": "completed" },
  ExpressionAttributeValues: { ":done": { BOOL: false } },
}));
```

The same endpoint works with `S3Client`, `SQSClient`, `RDSClient`, `EventBridgeClient`, `SFNClient`, `DynamoDBStreamsClient`, `LambdaClient`, `CognitoIdentityProviderClient`, `APIGatewayClient`, `ApiGatewayV2Client`, `ApiGatewayManagementApiClient`, `CloudWatchClient`, `CloudWatchLogsClient`, `IAMClient`, and `STSClient`. SDK requests retain normal SigV4 signing; behavior depends on the selected authentication mode.

For S3, use path-style addressing with the local endpoint:

```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "eu-west-1",
  endpoint: "http://127.0.0.1:4566",
  forcePathStyle: true,
  credentials: { accessKeyId: "admin", secretAccessKey: "password" },
});

await s3.send(new PutObjectCommand({ Bucket: "learning-assets", Key: "notes/hello.txt", Body: "hello" }));
const object = await s3.send(new GetObjectCommand({ Bucket: "learning-assets", Key: "notes/hello.txt" }));
console.log(await object.Body?.transformToString());
```

The direct S3 surface includes bucket policies/status, bucket and account Block Public Access, Object Ownership, bucket/object ACLs, Requester Pays, bucket ABAC resource tags, IAM composition, tags, encryption configuration/SSE-C, Object Lock and version governance, annotations, lifecycle/storage classes/archive restore, and durable SQS/Lambda/EventBridge notifications with `AWS/S3` telemetry. KMS/DSSE-KMS identifiers remain explicit dependency descriptors and never label local blobs as KMS-encrypted. Account public-access settings use the unmodified `S3ControlClient` with the same endpoint and `AccountId: "000000000000"`. The CloudFormation/CDK bucket and website surface is deliberately narrower: it supports the documented bucket, policy, public-read, website, and deployment-helper fields, but does not imply support for every S3 CloudFormation property.

For SQS, use the normal regional client and queue URLs returned by `CreateQueue`:

```ts
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const sqs = new SQSClient({
  region: "eu-west-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "admin", secretAccessKey: "password" },
});

// This target is also used by the Lambda configuration example below.
await sqs.send(new CreateQueueCommand({ QueueName: "notes-dead-letter" }));
const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "development-jobs" }));
await sqs.send(new SendMessageCommand({
  QueueUrl,
  MessageBody: JSON.stringify({ job: "rebuild-search-index" }),
  MessageAttributes: { priority: { DataType: "Number", StringValue: "10" } },
}));

const received = await sqs.send(new ReceiveMessageCommand({
  QueueUrl,
  WaitTimeSeconds: 10,
  MessageAttributeNames: ["All"],
}));
const message = received.Messages?.[0];
if (message?.ReceiptHandle) {
  console.log(message.MessageId, message.Body);
  await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
}
```

The SQS surface includes queue lifecycle, attributes, tags, send/receive/delete, visibility changes, ten-entry partial batches, long polling, purge, and restart-safe Standard delivery. It also provides DLQ/redrive behavior, `ListDeadLetterSourceQueues`, SQS-to-Lambda mappings and Lambda destinations, DynamoDB Streams discarded-record targets, API Gateway v1/v2 producers, FIFO ordering and deduplication, deterministic Standard fair queues, resource policies, `AddPermission`/`RemovePermission`, same- and cross-account authorization, condition-scoped service publishers, and truthful SSE-SQS attributes. S3 notifications use the same policy-enforced service path. KMS inputs validate but fail with an explicit dependency error because no KMS service is implemented; message-move tasks are not supported.

For EventBridge, use the normal regional client. The default bus already exists; custom buses, pattern rules, and Lambda targets use ordinary SDK commands:

```ts
import {
  CreateEventBusCommand,
  EventBridgeClient,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
} from "@aws-sdk/client-eventbridge";

const events = new EventBridgeClient({
  region: "eu-west-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "admin", secretAccessKey: "password" },
});

await events.send(new CreateEventBusCommand({ Name: "application" }));
const rule = await events.send(new PutRuleCommand({
  Name: "orders-created",
  EventBusName: "application",
  EventPattern: JSON.stringify({ source: ["com.example.orders"], detail: { state: ["created"] } }),
}));
await events.send(new PutTargetsCommand({
  Rule: "orders-created",
  EventBusName: "application",
  Targets: [{ Id: "handler", Arn: "arn:aws:lambda:eu-west-1:000000000000:function:orders-handler" }],
}));
await events.send(new PutEventsCommand({ Entries: [{
  EventBusName: "application",
  Source: "com.example.orders",
  DetailType: "Order changed",
  Detail: JSON.stringify({ id: "o-123", state: "created" }),
}] }));
```

In `enforce` mode, the caller needs the applicable `events:*` identity permission and the Lambda function separately needs a resource-policy statement for principal `events.amazonaws.com` scoped to `rule.RuleArn`. `PutEvents` uses the current aggregate entry-size budget of less than 1 MiB, and durable target payloads preserve accepted JSON number tokens, including signed 64-bit integers. Ordinary bus routing does not create browseable history: matching target work is durably journaled before acknowledgement, while unmatched events are dropped unless an explicit archive captures them. Syntactically valid entries naming a nonexistent bus are still successful drops.

EVB-04 implements `CreateArchive`, `DescribeArchive`, `ListArchives`, `UpdateArchive`, `DeleteArchive`, `StartReplay`, `DescribeReplay`, `ListReplays`, and `CancelReplay` through the official EventBridge client. An archive is immutable to one source bus and may use the shared event-pattern grammar. Retention `0` is indefinite; positive days expire by event time on deterministic clock reconciliation. `EventCount` and `SizeBytes` include committed, unexpired local records only. Archive capture commits before `PutEvents` acknowledgement and is independent of rule matching, disabled/missing targets, and target delivery success.

Archive payload segments use installation-owned AES-256-GCM and atomic write-new/fsync/rename publication below the private EventBridge data directory. Segments, indexes, state diagnostics, replay leases/checkpoints, cancellation, and 90-day replay history are outside `state.json`. Restart indexes committed orphan segments, removes incomplete temporary files, disables an archive with a bounded diagnostic when a referenced committed segment is corrupt, resumes expired replay leases at least once, and cleans only exact archive-owned files. A supplied customer-managed KMS identifier is syntax-checked and then fails with the explicit unavailable KMS dependency before any create/update mutation.

Replay accepts one event-time range and the source bus plus optional enabled rule ARNs. It snapshots eligible records, processes deterministic event-time/minute order without claiming original ingestion order, adds `replay-name`, routes only through that bus and rule selection, and never captures replayed envelopes in any archive. Checkpoints advance only after target work has been durably admitted, so an interrupted handoff/checkpoint boundary may deliver an event again. Cancellation stops future submissions and does not retract already admitted targets or remove archived data. The console labels counts, ordering, timing, and range-based progress as development-grade local behavior rather than AWS service metrics.

RDS works with the normal `npm install` and `npm start` flow. Its embedded SQLite provider opens the durable local database and serves a bounded MySQL-compatible listener using the installed `mysql2` npm package's protocol support; `mysql2` is not the database engine. There are no RDS database binaries to install, executable-path environment variables to set, or external database service to run.

Database files created by the retired external provider are not converted or overwritten. On upgrade, such an instance is reported as `failed` with delete-and-recreate guidance; `DeleteDBInstance` still applies the retired provider's ownership and quiescence checks so the installation-wide slot can be released safely. A fresh `STACKSIM_DATA_DIR` is also an option when the old development data is no longer needed.

Use `RDSClient` against the control endpoint to create the one permitted `mysql` DB instance. This local development profile requires class `db.t3.micro`, a free port from 1150–65535, and an 8–41 character printable-ASCII password excluding `/`, `@`, and `"`. `DBName` is optional; omitting it creates no hidden database. Deletion protection may be enabled, but it must be disabled with `ModifyDBInstance` before deletion.

```ts
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  RDSClient,
  waitUntilDBInstanceAvailable,
} from "@aws-sdk/client-rds";
import mysql from "mysql2/promise";

const rds = new RDSClient({
  endpoint: "http://127.0.0.1:4566",
  region: "eu-west-1",
  credentials: { accessKeyId: "admin", secretAccessKey: "password" },
});

await rds.send(new CreateDBInstanceCommand({
  DBInstanceIdentifier: "development-db",
  DBInstanceClass: "db.t3.micro",
  Engine: "mysql",
  DBName: "app",
  MasterUsername: "developer",
  MasterUserPassword: "retain-this-local-password",
  Port: 3307,
}));
await waitUntilDBInstanceAvailable({ client: rds, maxWaitTime: 60 }, { DBInstanceIdentifier: "development-db" });

const sql = await mysql.createConnection({
  host: "127.0.0.1",
  port: 3307,
  user: "developer",
  password: "retain-this-local-password",
  database: "app",
});
console.log(await sql.query("SELECT 1 AS ready"));
await sql.end();

await rds.send(new DeleteDBInstanceCommand({
  DBInstanceIdentifier: "development-db",
  SkipFinalSnapshot: true,
}));
```

Retain the current master password: the RDS control plane never returns it. `ModifyDBInstance` can rotate it; the replacement is staged only in the private secret store, verified before promotion, and rolled back on failure. SQL data survives stop/start, reboot, port changes, and simulator restart. A port change preflights the exact target, then either starts successfully there or restores the previous provider configuration, listener, descriptor, and lease port.

The RDS-02 control plane adds 15 Query/XML lifecycle, tagging, and parameter actions: `ModifyDBInstance`, `RebootDBInstance`, `StopDBInstance`, `StartDBInstance`, `DescribeValidDBInstanceModifications`, `AddTagsToResource`, `RemoveTagsFromResource`, `ListTagsForResource`, `CreateDBParameterGroup`, `DescribeDBParameterGroups`, `ModifyDBParameterGroup`, `ResetDBParameterGroup`, `DeleteDBParameterGroup`, `DescribeDBParameters`, and `DescribeEngineDefaultParameters`. The exact described safe-parameter allowlist is `max_connections` (dynamic, `10-1000`), `wait_timeout` (dynamic, `60-28800`), `max_allowed_packet` (dynamic, `1048576-67108864`), `innodb_flush_log_at_trx_commit` (dynamic, `0|1|2`), `collation_server` (static, `utf8mb4_unicode_ci|utf8mb4_general_ci`), and read-only provider-owned `character_set_server=utf8mb4`. These are compatibility controls, not general SQLite pragmas. Only `max_connections` currently has its named engine effect; DUG-19 remains open for timeout, packet, durability, and default-collation effect truthfulness. A dynamic `ApplyMethod=immediate` change deliberately performs a managed local restart, so the listener is briefly unavailable; failure restores the prior configuration and working listener. Static changes remain `pending-reboot`.

The advertised RDS engine version `8.0` is a control-plane compatibility value. The data plane publishes the exact [`mysql8-orm-v1` statement and semantic matrix](rds-mysql8-development-profile.md): common table/index DDL, parameterized DML and queries, transactions, prepared text/binary values, integer `AUTO_INCREMENT`/`LAST_INSERT_ID()`, joins and constraints, selected equivalent character-set/collation forms, `SHOW`/`DESCRIBE`, and bounded read-only `information_schema` metadata. Session setup is a closed set with real or equivalent local meaning; arbitrary `SET` is no longer accepted as a no-op. A lexer-backed classifier assigns every statement to the closed profile and returns stable MySQL-shaped errors before SQLite prepares unsupported syntax. Exact Knex 3.3.0 and Sequelize 6.37.8 fixtures prove migrations, introspection, generated IDs, CRUD, rollback, second migration, reconnect, and simulator restart. SQLite remains the storage engine, so unlisted ORM releases, broader MySQL grammar/types/functions/collations/metadata/administration, and full MySQL semantics are not promised. The master identity is a local authentication boundary rather than a complete MySQL privilege system.

RDS-03 adds `CreateDBSnapshot`, `DescribeDBSnapshots`, `DeleteDBSnapshot`, `CopyDBSnapshot`, `RestoreDBInstanceFromDBSnapshot`, `DescribeDBSnapshotAttributes`, and `ModifyDBSnapshotAttribute`; `RestoreDBInstanceToPointInTime` returns an explicit dependency error. Snapshot capture drains the local listener, uses SQLite's consistent backup operation for every logical database, fsyncs files and a credential-free ownership manifest, validates SHA-256 checksums, and atomically renames a new directory before returning `available`. Copy repeats that publication within the installation. Restore validates the manifest and every file again, requires the singleton slot to be free, and requires a new identifier, loopback port, master username, and password; old credentials are never stored in snapshot data. `MasterUsername` and `MasterUserPassword` are required local Query extensions to `RestoreDBInstanceFromDBSnapshot`; because the official AWS SDK input model does not expose those members, use the console restore wizard or the raw Query/XML route. Final snapshots are supported by `DeleteDBInstance`, and standalone `AWS::RDS::DBInstance` CloudFormation deletion now honors its Snapshot default. Incomplete temporary work, interrupted deleting state, published orphan reachability, and corrupt manifests/files are reconciled on restart; corrupt data is marked `failed`, never left `available`. Manual snapshots are recovery copies, not secure erasure, host-disk encryption, automated backup retention, or PITR.

### Stream DynamoDB changes into RDS

An optional seed demonstrates a complete development data path:

`RdsStreamInventory` → DynamoDB Streams (`NEW_AND_OLD_IMAGES`) → Lambda `rds-stream-projector` → `stream_projection.inventory_projection`

Start the simulator normally. In a second terminal, run:

```bash
npm run seed:rds-stream
```

The command creates or preserves the `rds-stream-db` instance, SQL projection table, DynamoDB table, `rds-stream-projector-role` role, Lambda function, and event-source mapping. It starts that instance first if it is stopped, applies stable insert, modify, and remove fixtures, then polls the local SQL endpoint and verifies that the final projection contains the inserted and updated rows while omitting the removed row. Existing unrelated resources are not deleted; because the local RDS profile permits one installation-wide instance, the command fails clearly if that singleton is already occupied by another database.

The seed uses `STACKSIM_ENDPOINT` and `AWS_REGION`, and accepts `STACKSIM_RDS_STREAM_PORT` (default `3307`) and `STACKSIM_RDS_STREAM_PASSWORD` (default `LocalStreamSecret123`). Choose a different free port if 3307 is already in use. The seed deliberately puts this local master password in the Lambda environment so the example can be self-contained. That is suitable only for this development fixture; do not copy the credential pattern to AWS or production—use a managed secret and appropriate database network and identity controls there.

### Service command examples

The following official SDK v3 commands exercise advanced CloudWatch, DynamoDB, Lambda, and API Gateway behavior. They assume the named resources already exist; replace the example identifiers with values returned by the corresponding create/list commands.

```ts
import { readFile } from "node:fs/promises";
import {
  BatchExecuteStatementCommand,
  CreateBackupCommand,
  DeleteResourcePolicyCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeExportCommand,
  DescribeGlobalTableCommand,
  DescribeImportCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  ExportTableToPointInTimeCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  ListExportsCommand,
  ListGlobalTablesCommand,
  ListContributorInsightsCommand,
  ListImportsCommand,
  ImportTableCommand,
  PutResourcePolicyCommand,
  TagResourceCommand as DynamoTagResourceCommand,
  TransactWriteItemsCommand,
  UpdateTableCommand,
  UpdateContinuousBackupsCommand,
  UpdateContributorInsightsCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
  ListStreamsCommand,
} from "@aws-sdk/client-dynamodb-streams";
import {
  AddLayerVersionPermissionCommand,
  AddPermissionCommand,
  CreateAliasCommand,
  CreateCodeSigningConfigCommand,
  CreateEventSourceMappingCommand,
  CreateFunctionUrlConfigCommand,
  GetAccountSettingsCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionRecursionConfigCommand,
  GetRuntimeManagementConfigCommand,
  InvokeCommand,
  InvokeWithResponseStreamCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  ListLayersCommand,
  ListFunctionUrlConfigsCommand,
  ListProvisionedConcurrencyConfigsCommand,
  PublishLayerVersionCommand,
  PublishVersionCommand,
  PutFunctionConcurrencyCommand,
  PutFunctionCodeSigningConfigCommand,
  PutFunctionEventInvokeConfigCommand,
  PutFunctionRecursionConfigCommand,
  PutProvisionedConcurrencyConfigCommand,
  PutRuntimeManagementConfigCommand,
  TagResourceCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import {
  APIGatewayClient,
  CreateAuthorizerCommand,
  CreateBasePathMappingCommand,
  CreateDomainNameCommand,
  FlushStageAuthorizersCacheCommand,
  PutGatewayResponseCommand,
  TestInvokeMethodCommand,
  UpdateRestApiCommand,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateIntegrationCommand as CreateHttpIntegrationCommand,
  CreateRouteCommand as CreateHttpRouteCommand,
  CreateStageCommand as CreateHttpStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { CloudWatchClient, GetDashboardCommand, GetDatasetCommand, GetInsightRuleReportCommand, GetMetricDataCommand, ListManagedInsightRulesCommand, PutAlarmMuteRuleCommand, PutAnomalyDetectorCommand, PutCompositeAlarmCommand, PutDashboardCommand, PutInsightRuleCommand, PutLogAlarmCommand, PutManagedInsightRulesCommand, PutMetricAlarmCommand, PutMetricDataCommand, PutMetricStreamCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, GetLogRecordCommand, GetQueryResultsCommand, PutQueryDefinitionCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";

const config = {
  region: "eu-west-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "admin", secretAccessKey: "password" },
};

const dynamodb = new DynamoDBClient(config);
await dynamodb.send(new TransactWriteItemsCommand({
  ClientRequestToken: "readme-transaction-1",
  TransactItems: [{
    Put: {
      TableName: "LearningNotes",
      Item: { id: { S: "readme" }, title: { S: "Atomic write" } },
      ConditionExpression: "attribute_not_exists(id)",
    },
  }],
}));
await dynamodb.send(new UpdateTimeToLiveCommand({
  TableName: "LearningNotes",
  TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" },
}));
console.log((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "LearningNotes" }))).TimeToLiveDescription);
const statement = 'SELECT id, title FROM "LearningNotes" WHERE id=?';
console.log((await dynamodb.send(new ExecuteStatementCommand({ Statement: statement, Parameters: [{ S: "readme" }] }))).Items);
console.log((await dynamodb.send(new BatchExecuteStatementCommand({ Statements: [
  { Statement: statement, Parameters: [{ S: "readme" }] },
  { Statement: statement, Parameters: [{ S: "missing" }] },
] }))).Responses);
await dynamodb.send(new ExecuteTransactionCommand({
  ClientRequestToken: "readme-partiql-transaction",
  TransactStatements: [{
    Statement: 'UPDATE "LearningNotes" SET title=? WHERE id=?',
    Parameters: [{ S: "PartiQL transaction" }, { S: "readme" }],
  }],
}));
const tableArn = "arn:aws:dynamodb:eu-west-1:000000000000:table/LearningNotes";
await dynamodb.send(new UpdateTableCommand({
  TableName: "LearningNotes",
  BillingMode: "PAY_PER_REQUEST",
  TableClass: "STANDARD",
  DeletionProtectionEnabled: true,
  OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
  StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
}));
const streams = new DynamoDBStreamsClient(config);
const streamArn = (await streams.send(new ListStreamsCommand({ TableName: "LearningNotes", Limit: 1 }))).Streams![0].StreamArn!;
const shardId = (await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }))).StreamDescription!.Shards![0].ShardId!;
const shardIterator = (await streams.send(new GetShardIteratorCommand({ StreamArn: streamArn, ShardId: shardId, ShardIteratorType: "TRIM_HORIZON" }))).ShardIterator!;
console.log((await streams.send(new GetRecordsCommand({ ShardIterator: shardIterator, Limit: 100 }))).Records);
await dynamodb.send(new UpdateTableCommand({
  TableName: "LearningNotes",
  ReplicaUpdates: [{ Create: { RegionName: "us-east-1" } }],
  MultiRegionConsistency: "EVENTUAL",
}));
console.log((await dynamodb.send(new ListGlobalTablesCommand({ RegionName: "eu-west-1" }))).GlobalTables);
console.log((await dynamodb.send(new DescribeGlobalTableCommand({ GlobalTableName: "LearningNotes" }))).GlobalTableDescription);
await dynamodb.send(new DynamoTagResourceCommand({
  ResourceArn: tableArn,
  Tags: [{ Key: "example", Value: "readme" }],
}));
console.log((await dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }))).Tags);
await dynamodb.send(new UpdateContinuousBackupsCommand({
  TableName: "LearningNotes",
  PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
}));
console.log((await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: "LearningNotes" }))).ContinuousBackupsDescription);
const exported = await dynamodb.send(new ExportTableToPointInTimeCommand({
  TableArn: tableArn,
  S3Bucket: "file:///tmp/stacksim-dynamodb-transfer",
  S3Prefix: "readme",
  ExportFormat: "DYNAMODB_JSON",
}));
console.log(await dynamodb.send(new DescribeExportCommand({ ExportArn: exported.ExportDescription!.ExportArn! })));
console.log((await dynamodb.send(new ListExportsCommand({ TableArn: tableArn }))).ExportSummaries);
const exportId = exported.ExportDescription!.ExportArn!.split("/export/")[1];
const imported = await dynamodb.send(new ImportTableCommand({
  S3BucketSource: { S3Bucket: "file:///tmp/stacksim-dynamodb-transfer", S3KeyPrefix: `readme/AWSDynamoDB/${exportId}/data` },
  InputFormat: "DYNAMODB_JSON",
  InputCompressionType: "GZIP",
  TableCreationParameters: {
    TableName: "LearningNotesImported",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  },
}));
console.log(await dynamodb.send(new DescribeImportCommand({ ImportArn: imported.ImportTableDescription!.ImportArn! })));
console.log((await dynamodb.send(new ListImportsCommand({ TableArn: imported.ImportTableDescription!.TableArn! }))).ImportSummaryList);
await dynamodb.send(new UpdateContributorInsightsCommand({
  TableName: "LearningNotes",
  ContributorInsightsAction: "ENABLE",
  ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS",
}));
console.log(await dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "LearningNotes" })));
console.log((await dynamodb.send(new ListContributorInsightsCommand({ TableName: "LearningNotes" }))).ContributorInsightsSummaries);
await dynamodb.send(new EnableKinesisStreamingDestinationCommand({
  TableName: "LearningNotes",
  StreamArn: "arn:aws:kinesis:eu-west-1:000000000000:stream/learning-events",
  EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MILLISECOND" },
}));
console.log((await dynamodb.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "LearningNotes" }))).KinesisDataStreamDestinations);
console.log((await dynamodb.send(new CreateBackupCommand({ TableName: "LearningNotes", BackupName: "readme-snapshot" }))).BackupDetails);
const policyRevision = (await dynamodb.send(new PutResourcePolicyCommand({
  ResourceArn: tableArn,
  ExpectedRevisionId: "NO_POLICY",
  Policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::000000000000:root" },
      Action: "dynamodb:DescribeTable",
      Resource: tableArn,
    }],
  }),
}))).RevisionId!;
console.log((await dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: tableArn }))).Policy);
await dynamodb.send(new DeleteResourcePolicyCommand({ ResourceArn: tableArn, ExpectedRevisionId: policyRevision }));

const cloudwatch = new CloudWatchClient(config);
await cloudwatch.send(new PutMetricDataCommand({
  Namespace: "Learning/App",
  MetricData: [{
    MetricName: "Requests",
    Dimensions: [{ Name: "Route", Value: "/notes" }],
    Unit: "Count",
    Value: 1,
  }],
}));
const metricData = await cloudwatch.send(new GetMetricDataCommand({
  StartTime: new Date(Date.now() - 60 * 60 * 1000),
  EndTime: new Date(),
  MetricDataQueries: [{
    Id: "requests",
    MetricStat: {
      Metric: { Namespace: "Learning/App", MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/notes" }] },
      Period: 60,
      Stat: "Sum",
    },
  }],
}));
console.log(metricData.MetricDataResults);
const insights = await cloudwatch.send(new GetMetricDataCommand({
  StartTime: new Date(Date.now() - 60 * 60 * 1000),
  EndTime: new Date(),
  MetricDataQueries: [{
    Id: "topRoutes",
    Expression: 'SELECT SUM(Requests) FROM "Learning/App" GROUP BY Route ORDER BY MAX() DESC LIMIT 20',
    Period: 60,
  }],
}));
console.log(insights.MetricDataResults);
console.log(await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" })));
await cloudwatch.send(new PutMetricStreamCommand({
  Name: "learning-app-metrics",
  FirehoseArn: "arn:aws:firehose:eu-west-1:000000000000:deliverystream/learning-app-metrics",
  RoleArn: "arn:aws:iam::000000000000:role/metric-stream-delivery",
  OutputFormat: "opentelemetry1.0",
  IncludeFilters: [{ Namespace: "Learning/App", MetricNames: ["Requests"] }],
  Tags: [{ Key: "environment", Value: "local" }],
}));
await cloudwatch.send(new PutInsightRuleCommand({
  RuleName: "learning-errors-by-service",
  RuleDefinition: JSON.stringify({
    Schema: { Name: "CloudWatchLogRule", Version: 1 },
    LogGroupNames: ["/stacksim/learning"],
    LogFormat: "JSON",
    Contribution: { Keys: ["$.service"], Filters: [{ Match: "$.level", In: ["ERROR", "WARN"] }] },
    AggregateOn: "Count",
  }),
  RuleState: "ENABLED",
  Tags: [{ Key: "environment", Value: "local" }],
}));
console.log(await cloudwatch.send(new GetInsightRuleReportCommand({
  RuleName: "learning-errors-by-service",
  StartTime: new Date(Date.now() - 60 * 60 * 1000),
  EndTime: new Date(),
  Period: 60,
  OrderBy: "Sum",
})));
const managedTemplates = await cloudwatch.send(new ListManagedInsightRulesCommand({ ResourceARN: tableArn }));
const partitionKeyTemplate = managedTemplates.ManagedRules?.find(rule => rule.TemplateName === "DynamoDBContributorInsights-PKC");
if (partitionKeyTemplate) await cloudwatch.send(new PutManagedInsightRulesCommand({
  ManagedRules: [{ TemplateName: partitionKeyTemplate.TemplateName!, ResourceARN: tableArn }],
}));
await cloudwatch.send(new PutMetricAlarmCommand({
  AlarmName: "learning-notes-request-volume",
  Namespace: "Learning/App",
  MetricName: "Requests",
  Dimensions: [{ Name: "Route", Value: "/notes" }],
  Period: 60,
  Statistic: "Sum",
  EvaluationPeriods: 3,
  DatapointsToAlarm: 2,
  Threshold: 10,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "notBreaching",
  Tags: [{ Key: "example", Value: "readme" }],
}));
await cloudwatch.send(new PutAnomalyDetectorCommand({
  SingleMetricAnomalyDetector: {
    Namespace: "Learning/App",
    MetricName: "Requests",
    Dimensions: [{ Name: "Route", Value: "/notes" }],
    Stat: "Sum",
  },
  Configuration: { MetricTimezone: "Europe/London" },
}));
await cloudwatch.send(new PutMetricAlarmCommand({
  AlarmName: "learning-notes-request-anomaly",
  EvaluationPeriods: 3,
  DatapointsToAlarm: 2,
  ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold",
  ThresholdMetricId: "expected",
  TreatMissingData: "missing",
  Metrics: [{
    Id: "requests",
    ReturnData: true,
    MetricStat: {
      Metric: { Namespace: "Learning/App", MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/notes" }] },
      Period: 60,
      Stat: "Sum",
    },
  }, {
    Id: "expected",
    Expression: "ANOMALY_DETECTION_BAND(requests, 2)",
  }],
}));
await cloudwatch.send(new PutCompositeAlarmCommand({
  AlarmName: "learning-notes-service-impact",
  AlarmDescription: "Combine service-impact signals without duplicate actions.",
  AlarmRule: 'ALARM("learning-notes-request-volume")',
  ActionsSuppressor: "learning-notes-maintenance",
  ActionsSuppressorWaitPeriod: 60,
  ActionsSuppressorExtensionPeriod: 60,
}));
await cloudwatch.send(new PutLogAlarmCommand({
  AlarmName: "learning-notes-errors-by-route",
  ScheduledQueryConfiguration: {
    QueryString: "filter level = 'ERROR' | fields @timestamp, @message, route",
    LogGroupIdentifiers: ["/stacksim/learning"],
    ScheduleConfiguration: { ScheduleExpression: "rate(1 minute)", StartTimeOffset: 60, EndTimeOffset: 0 },
    AggregationExpression: "count(*) as errors by route | sort errors desc",
  },
  QueryResultsToEvaluate: 1,
  QueryResultsToAlarm: 1,
  Threshold: 0,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "missing",
}));
await cloudwatch.send(new PutAlarmMuteRuleCommand({
  Name: "learning-notes-maintenance",
  Rule: { Schedule: { Expression: "cron(0 2 * * *)", Duration: "PT30M", Timezone: "Europe/London" } },
  MuteTargets: { AlarmNames: ["learning-notes-errors-by-route"] },
}));
await cloudwatch.send(new PutDashboardCommand({
  DashboardName: "learning-notes",
  DashboardBody: JSON.stringify({
    widgets: [{
      type: "metric",
      x: 0,
      y: 0,
      width: 12,
      height: 6,
      properties: {
        title: "Requests",
        region: "eu-west-1",
        metrics: [["Learning/App", "Requests", "Route", "/notes"]],
        period: 60,
        stat: "Sum",
        view: "timeSeries",
      },
    }],
  }),
}));
console.log((await cloudwatch.send(new GetDashboardCommand({ DashboardName: "learning-notes" }))).DashboardBody);

const logs = new CloudWatchLogsClient(config);
const insight = await logs.send(new StartQueryCommand({
  logGroupNames: ["/aws/lambda/notes-api", "/learning/cw02-access"],
  startTime: Math.floor(Date.now() / 1000) - 3600,
  endTime: Math.floor(Date.now() / 1000),
  queryString: "fields @timestamp, @message, @logStream | filter @message like /error/i | sort @timestamp desc | limit 100",
}));
const insightResult = await logs.send(new GetQueryResultsCommand({ queryId: insight.queryId! }));
const pointer = insightResult.results?.[0]?.find(field => field.field === "@ptr")?.value;
if (pointer) console.log((await logs.send(new GetLogRecordCommand({ logRecordPointer: pointer }))).logRecord);
await logs.send(new PutQueryDefinitionCommand({
  name: "Learning/Recent errors",
  queryString: "fields @timestamp, @message | filter @message like /error/i | sort @timestamp desc",
  logGroupNames: ["/aws/lambda/notes-api"],
}));

const lambda = new LambdaClient(config);
const published = await lambda.send(new PublishVersionCommand({ FunctionName: "notes-api", Description: "README snapshot" }));
await lambda.send(new CreateAliasCommand({ FunctionName: "notes-api", Name: "readme", FunctionVersion: published.Version! }));
await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: "notes-api", ReservedConcurrentExecutions: 2 }));
await lambda.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "notes-api", Qualifier: "readme", ProvisionedConcurrentExecutions: 1 }));
console.log(await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: "notes-api" })));
console.log((await lambda.send(new ListProvisionedConcurrencyConfigsCommand({ FunctionName: "notes-api" }))).ProvisionedConcurrencyConfigs);
console.log((await lambda.send(new GetAccountSettingsCommand({}))).AccountLimit);
await lambda.send(new TagResourceCommand({
  Resource: "arn:aws:lambda:eu-west-1:000000000000:function:notes-api",
  Tags: { example: "readme" },
}));
await lambda.send(new AddPermissionCommand({
  FunctionName: "notes-api",
  StatementId: "readme-api",
  Action: "lambda:InvokeFunction",
  Principal: "apigateway.amazonaws.com",
  SourceArn: "arn:aws:execute-api:eu-west-1:000000000000:API_ID/*/*/*",
}));
await lambda.send(new PutFunctionEventInvokeConfigCommand({
  FunctionName: "notes-api",
  MaximumRetryAttempts: 1,
  MaximumEventAgeInSeconds: 600,
  DestinationConfig: {
    OnSuccess: { Destination: "arn:aws:lambda:eu-west-1:000000000000:function:notes-audit" },
    OnFailure: { Destination: "arn:aws:lambda:eu-west-1:000000000000:function:notes-audit" },
  },
}));
await lambda.send(new InvokeCommand({ FunctionName: "notes-api", InvocationType: "Event", Payload: Buffer.from('{"httpMethod":"GET"}') }));
const mapping = await lambda.send(new CreateEventSourceMappingCommand({
  FunctionName: "notes-api:readme",
  EventSourceArn: streamArn,
  StartingPosition: "TRIM_HORIZON",
  BatchSize: 25,
  MaximumBatchingWindowInSeconds: 2,
  ParallelizationFactor: 2,
  MaximumRetryAttempts: 2,
  BisectBatchOnFunctionError: true,
  FunctionResponseTypes: ["ReportBatchItemFailures"],
  FilterCriteria: { Filters: [{ Pattern: '{"dynamodb":{"NewImage":{"completed":{"BOOL":[false]}}}}' }] },
}));
console.log(mapping.UUID, (await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "notes-api" }))).EventSourceMappings);

const layer = await lambda.send(new PublishLayerVersionCommand({
  LayerName: "notes-dependencies",
  Description: "README layer",
  CompatibleRuntimes: ["nodejs20.x", "nodejs22.x"],
  CompatibleArchitectures: ["x86_64"],
  Content: { ZipFile: await readFile("./layer.zip") },
}));
await lambda.send(new AddLayerVersionPermissionCommand({
  LayerName: "notes-dependencies",
  VersionNumber: layer.Version!,
  StatementId: "readme-account",
  Action: "lambda:GetLayerVersion",
  Principal: "111122223333",
}));
await lambda.send(new UpdateFunctionConfigurationCommand({
  FunctionName: "notes-api",
  Layers: [layer.LayerVersionArn!],
}));
console.log((await lambda.send(new ListLayersCommand({ CompatibleRuntime: "nodejs22.x" }))).Layers);

const signing = await lambda.send(new CreateCodeSigningConfigCommand({
  AllowedPublishers: { SigningProfileVersionArns: ["arn:aws:signer:eu-west-1:000000000000:/signing-profiles/local_release/abc123"] },
  CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Warn" },
  Description: "Local publisher reference",
}));
await lambda.send(new PutFunctionCodeSigningConfigCommand({ FunctionName: "notes-api", CodeSigningConfigArn: signing.CodeSigningConfig!.CodeSigningConfigArn! }));
await lambda.send(new UpdateFunctionConfigurationCommand({
  FunctionName: "notes-api",
  Architectures: ["x86_64"],
  EphemeralStorage: { Size: 1024 },
  LoggingConfig: { LogFormat: "JSON", ApplicationLogLevel: "INFO", SystemLogLevel: "WARN", LogGroup: "/stacksim/lambda/notes-api" },
  TracingConfig: { Mode: "Active" },
  DeadLetterConfig: { TargetArn: "arn:aws:sqs:eu-west-1:000000000000:notes-dead-letter" },
  FileSystemConfigs: [{ Arn: "arn:aws:elasticfilesystem:eu-west-1:000000000000:access-point/fsap-0123456789abcdef0", LocalMountPath: "/mnt/notes" }],
  VpcConfig: { SubnetIds: ["subnet-0123abcd"], SecurityGroupIds: ["sg-0123abcd"], Ipv6AllowedForDualStack: true },
  KMSKeyArn: "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab",
}));
await lambda.send(new PutRuntimeManagementConfigCommand({ FunctionName: "notes-api", Qualifier: "$LATEST", UpdateRuntimeOn: "Manual", RuntimeVersionArn: "arn:aws:lambda:eu-west-1::runtime:nodejs22-local" }));
await lambda.send(new PutFunctionRecursionConfigCommand({ FunctionName: "notes-api", RecursiveLoop: "Terminate" }));
console.log(await lambda.send(new GetRuntimeManagementConfigCommand({ FunctionName: "notes-api", Qualifier: "$LATEST" })));
console.log(await lambda.send(new GetFunctionRecursionConfigCommand({ FunctionName: "notes-api" })));

const functionUrl = await lambda.send(new CreateFunctionUrlConfigCommand({
  FunctionName: "notes-api",
  AuthType: "NONE",
  InvokeMode: "RESPONSE_STREAM",
  Cors: { AllowOrigins: ["http://localhost:3000"], AllowMethods: ["GET", "POST"] },
}));
await lambda.send(new AddPermissionCommand({ FunctionName: "notes-api", StatementId: "readme-url", Action: "lambda:InvokeFunctionUrl", Principal: "*", FunctionUrlAuthType: "NONE" }));
await lambda.send(new AddPermissionCommand({ FunctionName: "notes-api", StatementId: "readme-url-function", Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true }));
console.log(functionUrl.FunctionUrl, (await lambda.send(new ListFunctionUrlConfigsCommand({ FunctionName: "notes-api" }))).FunctionUrlConfigs);
for await (const event of (await lambda.send(new InvokeWithResponseStreamCommand({ FunctionName: "notes-api", Payload: Buffer.from("{}") }))).EventStream!) {
  if (event.PayloadChunk) process.stdout.write(Buffer.from(event.PayloadChunk.Payload ?? []));
}

const apigateway = new APIGatewayClient(config);
await apigateway.send(new TestInvokeMethodCommand({
  restApiId: "API_ID",
  resourceId: "RESOURCE_ID",
  httpMethod: "GET",
  pathWithQueryString: "/notes",
}));
const authorizer = await apigateway.send(new CreateAuthorizerCommand({
  restApiId: "API_ID",
  name: "readme-token",
  type: "TOKEN",
  identitySource: "method.request.header.Authorization",
  authorizerUri: "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:notes-api/invocations",
}));
await apigateway.send(new UpdateRestApiCommand({
  restApiId: "API_ID",
  patchOperations: [
    { op: "add", path: "/binaryMediaTypes/application~1octet-stream" },
    { op: "replace", path: "/minimumCompressionSize", value: "1024" },
    { op: "replace", path: "/policy", value: JSON.stringify({ Version: "2012-10-17", Statement: [] }) },
  ],
}));
await apigateway.send(new PutGatewayResponseCommand({
  restApiId: "API_ID",
  responseType: "MISSING_AUTHENTICATION_TOKEN",
  statusCode: "404",
  responseParameters: { "gatewayresponse.header.Access-Control-Allow-Origin": "'*'" },
  responseTemplates: { "application/json": '{"message":$context.error.messageString}' },
}));
await apigateway.send(new FlushStageAuthorizersCacheCommand({ restApiId: "API_ID", stageName: "dev" }));
await apigateway.send(new CreateDomainNameCommand({
  domainName: "api.notes.test",
  endpointConfiguration: { types: ["REGIONAL"], ipAddressType: "dualstack" },
  regionalCertificateArn: "arn:aws:acm:eu-west-1:000000000000:certificate/11111111-1111-1111-1111-111111111111",
  routingMode: "BASE_PATH_MAPPING_ONLY",
  tags: { environment: "local" },
}));
await apigateway.send(new CreateBasePathMappingCommand({ domainName: "api.notes.test", basePath: "(none)", restApiId: "API_ID", stage: "dev" }));
console.log(authorizer.id);

const httpGateway = new ApiGatewayV2Client(config);
const httpApi = await httpGateway.send(new CreateApiCommand({
  Name: "notes-http-api",
  ProtocolType: "HTTP",
  CorsConfiguration: { AllowOrigins: ["http://localhost:3000"], AllowMethods: ["GET", "POST", "OPTIONS"] },
  Tags: { environment: "local" },
}));
const httpIntegration = await httpGateway.send(new CreateHttpIntegrationCommand({
  ApiId: httpApi.ApiId,
  IntegrationType: "AWS_PROXY",
  IntegrationUri: "arn:aws:lambda:eu-west-1:000000000000:function:notes-api",
  PayloadFormatVersion: "2.0",
}));
await httpGateway.send(new CreateHttpRouteCommand({ ApiId: httpApi.ApiId, RouteKey: "ANY /notes/{proxy+}", Target: `integrations/${httpIntegration.IntegrationId}` }));
await httpGateway.send(new CreateHttpStageCommand({ ApiId: httpApi.ApiId, StageName: "$default", AutoDeploy: true, DefaultRouteSettings: { DetailedMetricsEnabled: true } }));
console.log(httpApi.ApiEndpoint);
```

## Endpoints and persistence

| Purpose | Default |
|---|---|
| SDK and control plane | `http://127.0.0.1:4566` |
| RDS SQL data plane | Returned `127.0.0.1:{requestedPort}` endpoint; default port `3306` |
| S3 path-style endpoint | `http://127.0.0.1:4566/{bucket}/{key}` |
| Bounded public S3 website | `http://127.0.0.1:4566/_stacksim/s3-website/{bucket}/{key}` |
| Web console | `http://127.0.0.1:4566/_stacksim/console` |
| API invocation | `http://127.0.0.1:4567/{apiId}/{stage}/{path}` |
| WebSocket API | `ws://127.0.0.1:4567/{apiId}/{stage}` |
| WebSocket management API | `http://127.0.0.1:4567/{apiId}/{stage}/@connections/{connectionId}` |
| Lambda function URL | `http://127.0.0.1:4567/lambda-url/{durableId}/{path}` |
| Health | `http://127.0.0.1:4566/_stacksim/health` |
| Control-plane state | `.stacksim/state.json` |
| Segmented event data | `.stacksim/data/` |
| RDS SQLite data and private credentials | `.stacksim/data/rds/` |
| Encrypted SQS messages, indexes, and journals | `.stacksim/data/sqs/` |
| EventBridge delivery intents and diagnostics | `.stacksim/data/eventbridge/` |
| Private DynamoDB integration results | `.stacksim/data/dynamodb/{accountId}/{region}/integration-attempts.sqlite` |
| Step Functions execution snapshots and histories | `.stacksim/data/step-functions/{accountId}/{region}/executions.sqlite` |
| SES mailbox content and Inbox state | `.stacksim/data/ses/{accountId}/{region}/mailbox.sqlite` |
| Encrypted S3 data and journals | `.stacksim/s3/` |

The regional Step Functions state-machine and Activity catalogs and their generation/name indexes live in control state. Standard execution inputs, immutable definition/role snapshots, checkpoints, versioned integration-attempt journals, callback-token digests, heartbeat/timeout deadlines, nested links, outputs, and typed histories live in the private transactional SQLite execution store rather than `state.json`. Attempt journals distinguish undispatched, dispatched, owning-service accepted, completed, failed, and genuinely ambiguous work. DynamoDB commits a payload-free receipt descriptor atomically with table state and stores the corresponding result in its mode-0600 SQLite receipt database; SQS receipts commit with the encrypted queue journal; SNS receipts commit with the encrypted delivery snapshot; EventBridge commits each deterministic entry receipt in the same fsynced append as its delivery intents and deduplicates archive capture by deterministic event ID; Lambda completion receipts use the private execution database. Once Step Functions has durably persisted a terminal task journal, it releases the owning receipt; startup finishes release after a crash, so completed receipt retention is bounded by live recovery work rather than execution history retention. Raw callback tokens are reconstructed from opaque token identity plus installation secret, represented by non-secret references inside nested execution checkpoints, materialized only at an encrypted downstream boundary, and redacted from control state, histories, logs, and diagnostics.

Recovery repeats a dispatched DynamoDB/SQS/SNS/EventBridge call only with its original attempt identity, so the owning service either returns the committed receipt or durably accepts it once. Lambda uses the attempt ID as its request ID and records the complete synchronous result before returning to the workflow. Task timeouts after dispatch are non-retryable because the downstream acceptance point may already have been crossed. If the process stops after an arbitrary Lambda side effect but before that receipt exists, StackSim reports a bounded `States.TaskFailed` ambiguity and does not invoke the function again. This is the deliberate duplicate boundary: committed receipt-backed successes are never lost, while work outside an owning idempotency/receipt contract is neither called “exactly once” nor duplicated silently.

Regional CloudFormation stack, change-set, export, client-token catalogs, and reduced CDK bootstrap descriptors live in control state. Durable CloudFormation operation journals and original/processed template artifacts remain outside `state.json` under `.stacksim/data/cloudformation/{accountId}/{region}/`.

The regional RDS DB-parameter-group catalog records the default `mysql8.0` group association, apply status, and applied safe-parameter values. Pending RDS modifications and lifecycle operations remain bounded control state so recovery can resume them after simulator restart.

SQS message bodies are authenticated-encrypted in a private content-addressed blob store under `.stacksim/data/sqs/`; message metadata, delay/retention/visibility deadlines, receipt state, DLQ transfers, and append-only queue journals remain outside `state.json`. Restart rebuilds bounded indexes, preserves delivery state, compacts journals, and reclaims unreachable payloads. This installation-local protection remains separate from the `SqsManagedSseEnabled` descriptor: new queues default it on, existing migrated queues retain a truthful off value, and configuration changes apply to later writes without making false KMS claims. KMS identifiers and reuse periods are validated, then rejected with an explicit dependency error until a real KMS service exists.

EventBridge bus, rule, target, and tag definitions are regional control state. Accepted Lambda, SQS, Logs, API Gateway, and Step Functions delivery intents store final serialized JSON, role/parameter/DLQ snapshots, leases, retry state, and bounded redacted diagnostics in a regional append-only journal under `.stacksim/data/eventbridge/`, so accepted work resumes without numeric-token normalization and re-authorizes changed destination policies at each attempt. A Step Functions target is successful only after normal durable execution admission.

CloudWatch alarm publishers use the default bus with source `aws.cloudwatch`, the `CloudWatch Alarm State Change` and `CloudWatch Alarm Configuration Change` detail types, and the alarm ARN in `resources`. State-change details include `previousState`, current reason data, composite `actionsSuppressedBy`/`actionsSuppressedReason`, and active `muteDetail`; configuration-change details include the operation, current/previous configuration, composite `state.actionsSuppressedBy`, and active `muteDetail`. `muteDetail` contains the mute-rule ARN and exact active window start/end. Delivery lineage follows EventBridge through Lambda, SQS, API Gateway, and service-registry handoffs; repeated resources or 32-hop chains terminate publication instead of recursively republishing.

SQLite database files and the plaintext restart-only master secret, including pending password-rotation material when present, live outside `state.json` under `.stacksim/data/rds/`; passwords are never returned by the RDS control plane or written to control state. Credential-free snapshot manifests and immutable backup files live below the owned RDS snapshot root, with file checksums and atomic directory publication. POSIX permissions are restricted where supported, and Windows applies an owner-only ACL to the RDS root, but local filesystem access remains the protection boundary—keep this directory private. S3 object/version/multipart metadata uses append-only per-bucket journals and restart-safe indexes outside `state.json`; object and part bytes are authenticated-encrypted in the private content-addressed blob store. Startup removes incomplete S3 staging and reclaims only blobs absent from every current bucket index.

Logs Insights execution history is process-local and intentionally clears on restart. Control writes use a temporary file and atomic rename; shutdown closes the embedded RDS listener and SQLite database without deleting its data. WebSocket connections remain process-local and close cleanly on shutdown. Global-table changes, CloudWatch data, PITR changes, metrics, and stream records use account/region-segmented JSONL, while immutable DynamoDB backups, opted-in exports, and opted-in metric-stream JSON files use `0600` files. Existing v80 control state loads directly; v1 through v79 state migrates automatically, and failed migrations leave the source untouched. Metrics default to CloudWatch-equivalent retention tiers; tests or embedded uses can pass the documented service settings plus `rdsProvider` and `rdsStartupTimeoutMs` to `new StackSim(...)`. The default S3 limits remain 5 GiB per object, 1,000,000 visible objects per bucket, 10,000 buckets, and 50 GiB total; accepted S3 and SQS bodies are never silently truncated.

## Authentication modes

Authentication defaults to `enforce`: service requests require valid SigV4 credentials and supported actions are evaluated against IAM policies.

```bash
STACKSIM_AUTH_MODE=off npm start
STACKSIM_AUTH_MODE=validate npm start
STACKSIM_ROOT_RECOVERY=true npm start
```

- `off` is an intentional permissive development mode that accepts unsigned requests.
- `validate` requires valid SigV4 credentials but does not apply IAM policy decisions.
- `enforce` validates SigV4 and evaluates IAM policies for supported control/data actions. API Gateway `AWS_IAM` methods require `execute-api:Invoke`; Lambda `AWS_IAM` function URLs require the Lambda URL/function invocation actions. Lambda create/update requires exact-role `iam:PassRole`, and runtime SDK calls and platform logs use the function's trusted execution-role session. EventBridge evaluates exact `events:*` actions against bus, rule, and target resources, while Lambda delivery separately requires a function resource-policy grant to `events.amazonaws.com`. Scheduler uses its distinct signing service, requires `iam:PassRole` to a role that trusts `scheduler.amazonaws.com`, and authorizes target/DLQ work as that role. `PutRule.RoleArn`, which is for cross-account event-bus targets, is unsupported because cross-account event-bus targets are not modeled. SQS operations combine the caller identity policy with the exact queue resource policy: either can allow same-account access, both must allow cross-account access, explicit denies win, and owner-only administration cannot be delegated. Service publishers always use their named principal plus source ARN/account context rather than a global bypass. S3 maps implemented data/control requests to their documented actions and bucket/object resources, combines identity and bucket/ACL grants with session policies and boundaries, requires dual allows across accounts, and gives explicit denies precedence. Copy evaluates destination `s3:PutObject` and source `s3:GetObject` or `s3:GetObjectVersion` separately.
- `STACKSIM_ROOT_RECOVERY=true` is a temporary break-glass mode: only the complete simulator-side configured pair resolves as account root. It is not needed for console, SDK, or CDK administration and does not create bootstrap resources. Turn it off after repairing IAM or a locking resource policy.

The web console requires sign-in in `enforce` and `validate` modes. Use **Access key ID** `admin`, **Secret access key** `password`, and leave **Session token** empty for the fresh long-lived key associated with IAM user `admin`. The first eligible console login offers, at most once, to generate an `AKIA...` replacement. The secret is shown once; save it, update client-side `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in every CLI, SDK, CDK, and application process, and complete validation so the configured IAM key becomes inactive. Choosing **Keep default credentials** records a terminal outcome. Interrupted/quota cases remain visible under IAM **Security credentials** for manual cleanup. Guided IAM rotation does not rotate the separate recovery pair; change both simulator-side credential values and restart for that.

The console shell, `/_stacksim/health`, and the minimal `/_stacksim/api/console-config` response remain unsigned so a browser can load and discover only the authentication mode and default Region. Cognito JWKS, configured S3 websites, and deployed public data-plane routes retain their modeled public authentication behavior. Every other `/_stacksim/api/*` route requires SigV4 in `validate` and `enforce` modes, and simulator-private mutations also receive an explicit IAM authorization decision in `enforce`.

Private IAM and CloudFormation console adapters use their corresponding service actions and resource ARNs. The multi-operation Cognito user editor uses the local `cognito-idp:AdminMutateUser` action so a narrower standard user-attribute grant cannot authorize password, enablement, group, MFA, or session changes by accident. SES Inbox state uses the local `ses:UpdateLocalMessage`, `ses:DeleteLocalMessage`, and `ses:PurgeLocalInbox` actions. Service-wide wildcards such as `cognito-idp:*` and `ses:*` include these local-only actions.

### Default IAM administrator migration

SNS regional control state, its private content-encryption key, immutable configuration defaults, and owning-service SNS outboxes remain compatible with the durable IAM user, group, and access-key model. A fresh or upgraded installation without credential overrides creates `user/admin`, attaches `AdministratorAccess`, and binds the configuration-managed `admin` key to encrypted credential material. Existing installations receive `firstConsoleLogin=notApplicable`; only a genuinely fresh installation receives the one-time console offer. The compatibility role `role/test` remains a separate Lambda example role.

The no-override client pair is now `admin`/`password`, and `GetCallerIdentity` returns `arn:aws:iam::<account-id>:user/admin`. Applications that selected a historical/custom pair must provide the complete intended simulator-side pair on the first upgraded start. Supplying only one member is an error. Changing either member later is an explicit rotation of the configuration-managed key; normal IAM deactivation, deletion, policy detach, rename, tags, and group membership remain durable and are not reset at startup. `STACKSIM_DEFAULT_USER_NAME` is first-initialization input only.

`STACKSIM_BOOTSTRAP_ROOT` is deprecated for one compatibility period. When neither replacement is supplied, explicit legacy `true` maps to both `STACKSIM_CDK_BOOTSTRAP=true` and `STACKSIM_ROOT_RECOVERY=true`, while explicit legacy `false` maps both to false. New settings win independently and startup reports the deprecated source. All related environment booleans accept only exact `true` or `false`.

Back up or restore a stopped installation as one indivisible set: `state.json`, `data/iam/credentials/`, and `secrets/iam.key`. Mixing those files, omitting the wrapping key, or restoring only state makes encrypted credentials unrecoverable and startup fails safely. Credential secrets and STS tokens are never stored in `state.json`.

## Commands and configuration

```bash
npm run dev              # run TypeScript directly
npm run build            # compile simulator, tests, and examples
npm run package:sample   # create examples/lambda/function.zip
npm run seed             # idempotently seed the core learning environment, including sample RDS tables
npm run seed:rds-stream  # seed and verify DynamoDB Streams -> Lambda -> local RDS
npm test                 # run Node SDK/protocol tests and Chrome console flows
npm run test:browser     # run the isolated console browser suite
```

| Variable | Default | Purpose |
|---|---:|---|
| `STACKSIM_PORT` | `4566` | SDK/control-plane port |
| `STACKSIM_INVOKE_PORT` | `4567` | API Gateway invocation port |
| `STACKSIM_HOST` | `127.0.0.1` | Listen address |
| `AWS_REGION` | `eu-west-1` | Default simulated region |
| `STACKSIM_ENDPOINT` | `http://127.0.0.1:4566` | SDK endpoint used by the seed scripts and passed to seeded Lambda functions |
| `STACKSIM_DATA_DIR` | `.stacksim` | Persistent state root |
| `STACKSIM_ACCOUNT_ID` | `000000000000` | Local account ID |
| `STACKSIM_AUTH_MODE` | `enforce` | `off`, `validate`, or `enforce` |
| `STACKSIM_SEED_DEFAULT_ADMIN` | `true` | Run the one-time default IAM administrator initialization when pending |
| `STACKSIM_DEFAULT_USER_NAME` | `admin` | User name used only by first initialization |
| `STACKSIM_ACCESS_KEY_ID` | `admin` | Simulator-side configuration-managed access key ID; supply with its secret |
| `STACKSIM_SECRET_ACCESS_KEY` | `password` | Simulator-side configuration-managed secret; supply with its access key ID |
| `STACKSIM_CDK_BOOTSTRAP` | `true` | Automatically create/reconcile the reduced bootstrap in the configured Region |
| `STACKSIM_ROOT_RECOVERY` | `false` | Resolve the configured pair as break-glass account root |
| `STACKSIM_ALLOW_INSECURE_RECOVERY_ROOT` | `false` | Acknowledge built-in recovery credentials on a non-loopback listener |
| `STACKSIM_BOOTSTRAP_ROOT` | unset | Deprecated compatibility input translated to both CDK bootstrap and recovery root |
| `STACKSIM_CDK_ASSET_RETENTION_MS` | `604800000` | Retention window for unreferenced CDK file assets; use a non-negative millisecond value |
| `STACKSIM_ALLOW_OUTBOUND_HTTP` | `false` | Enable API Gateway HTTP integrations |
| `STACKSIM_ALLOW_PRIVATE_HTTP` | `false` | Also permit explicitly configured loopback/private HTTP integration targets |
| `STACKSIM_APIGATEWAY_RATE_LIMIT` | `10000` | Regional API Gateway account rate limit |
| `STACKSIM_APIGATEWAY_BURST_LIMIT` | `5000` | Regional API Gateway account burst limit |
| `STACKSIM_APIGATEWAY_TLS_CERTIFICATE_PATH` | unset | PEM certificate for the opt-in HTTPS data listener; requires the private-key path |
| `STACKSIM_APIGATEWAY_TLS_PRIVATE_KEY_PATH` | unset | PEM private key for the opt-in HTTPS data listener; requires the certificate path |
| `STACKSIM_ALLOW_REMOTE_JWT_JWKS` | `false` | Enable bounded HTTPS OIDC/JWKS discovery for HTTP API JWT authorizers not supplied through `apiGatewayJwtJwks` |
| `STACKSIM_ALLOW_PRIVATE_JWT_JWKS` | `false` | Also permit loopback/private HTTP JWT issuers for explicit local tests; link-local targets remain blocked |
| `STACKSIM_APIGATEWAY_WEBSOCKET_IDLE_TIMEOUT_MS` | `600000` | WebSocket idle timeout in milliseconds; production-compatible default is 10 minutes |
| `STACKSIM_APIGATEWAY_WEBSOCKET_LIFETIME_MS` | `7200000` | WebSocket maximum connection lifetime in milliseconds; production-compatible default is two hours |
| `STACKSIM_APIGATEWAY_VPC_LINK_ORIGINS` | unset | JSON object mapping a VPC-link target ARN, ID, or name to an explicit local HTTP(S) origin |
| `STACKSIM_APIGATEWAY_ALLOW_CLIENT_CERTIFICATES` | `false` | Enable local self-signed API Gateway client-certificate generation |
| `STACKSIM_DDB_ENFORCE_CAPACITY` | `false` | Enable deterministic DynamoDB capacity token buckets and throttling |
| `STACKSIM_DDB_STREAM_RETENTION_MS` | `86400000` | DynamoDB Streams record/retired-descriptor retention in milliseconds |
| `STACKSIM_DDB_POLICY_UPDATE_COOLDOWN_MS` | `15000` | Minimum interval between actual resource-policy mutations in milliseconds |
| `STACKSIM_RDS_STARTUP_TIMEOUT_MS` | `30000` | Embedded RDS listener initialization/readiness timeout in milliseconds |
| `STACKSIM_RDS_PORT` | `3307` | Loopback SQL port requested by the main learning seed |
| `STACKSIM_RDS_PASSWORD` | `LocalLearningSecret123` | Development-only master password used by the main learning seed |
| `STACKSIM_RDS_STREAM_PORT` | `3307` | Loopback SQL port requested by the optional stream-to-RDS seed |
| `STACKSIM_RDS_STREAM_PASSWORD` | `LocalStreamSecret123` | Development-only master password injected into the seeded projector Lambda |
| `STACKSIM_S3_MAX_OBJECT_BYTES` | `5368709120` | Maximum accepted S3 object size |
| `STACKSIM_S3_MAX_BUCKET_OBJECTS` | `1000000` | Maximum visible objects per S3 bucket |
| `STACKSIM_S3_MAX_BUCKETS` | `10000` | Maximum buckets owned by the local account |
| `STACKSIM_S3_MAX_TOTAL_BYTES` | `53687091200` | Maximum aggregate S3 object and multipart-part bytes |
| `STACKSIM_S3_NOTIFICATION_MAXIMUM_AGE_MS` | `86400000` | Maximum age of retryable S3 notification deliveries in milliseconds |
| `STACKSIM_SNS_MAXIMUM_TOPICS` | `100000` | Maximum Standard topics per account/Region |
| `STACKSIM_SNS_MAXIMUM_SUBSCRIPTIONS` | `100000` | Maximum SNS subscriptions per account/Region |
| `STACKSIM_SNS_MAXIMUM_DELIVERY_MESSAGES` | `10000` | Maximum retained SNS message records per account/Region |
| `STACKSIM_SNS_DELIVERY_RETENTION_MS` | `86400000` | Retention for terminal/zero-subscription SNS delivery records before pruning |
| `STACKSIM_SFN_MAX_CONCURRENT_EXECUTIONS` | `1000` | Maximum running Step Functions executions per account/Region |
| `STACKSIM_SFN_MAX_MAP_CONCURRENCY` | `40` | Maximum effective concurrency for an Inline Map state |
| `STACKSIM_SFN_EXECUTION_RETENTION_MS` | `7776000000` | Retention for terminal Step Functions execution records in milliseconds |
| `STACKSIM_ALLOW_LOCAL_FILES` | `false` | Enable explicit `file://` DynamoDB import/export and CloudWatch Logs export sources/destinations |
| `STACKSIM_LAMBDA_CONCURRENT_EXECUTIONS` | `1000` | Regional Lambda account concurrency quota |
| `STACKSIM_LAMBDA_UNRESERVED_CONCURRENCY_RESERVE` | `100` | Capacity that reserved/provisioned configuration must leave unclaimed |
| `STACKSIM_LAMBDA_WORKER_IDLE_MS` | `300000` | Idle lifetime of an unprovisioned warm Node ZIP execution environment before retirement |
| `STACKSIM_LAMBDA_ZIP_LIMIT` | `52428800` | Maximum compressed ZIP size accepted for Lambda functions and layers |
| `STACKSIM_LAMBDA_OCI_ROOT` | unset | Absolute path to a local OCI image-layout root used to resolve digest-pinned image functions |
| `STACKSIM_LAMBDA_DOCKER_SOCKET` | unset | Absolute local Docker socket or named-pipe path used to resolve and invoke image functions |

## Scope

Supported commands use official AWS SDK v3 inputs/outputs and AWS wire protocols without a simulator-specific client. Unsupported operations return AWS-style service errors. Support is intentionally service-by-service and operation-by-operation: an implemented service name does not imply its complete AWS API or every associated CloudFormation property.

The implemented surfaces are summarized at the start of this document and described in detail by the examples and operational sections that follow. If a feature is not named here, expect an explicit unsupported-operation or missing-dependency error rather than AWS behavior.

Broadly, StackSim does not provide production availability, scaling, billing, compliance, or security guarantees; the complete AWS service and CloudFormation catalogs; real KMS-backed encryption; AWS Organizations; unrestricted public networking; or arbitrary CDK custom-resource/helper ecosystems. Service-specific exclusions are stated beside the relevant feature. Local encryption protects simulator files at rest within one installation but is not a substitute for AWS-managed keys or production secret management.

## Project layout

- `src/` — runtime implementation; RDS uses built-in SQLite plus `mysql2` protocol support for its bounded MySQL-compatible TCP/SQL listener
- `web/` — dependency-free management console
- `examples/lambda/handler.ts` — Lambda handlers for the learning API and stream-to-RDS projection
- `examples/deploy.ts` — idempotent cross-service seed
- `examples/rds-stream/deploy.ts` — idempotent DynamoDB Streams-to-RDS seed and projection verifier
- `test/` — official SDK, raw protocol, persistence, and end-to-end tests
- `docs/` — public guides and technical reference material
