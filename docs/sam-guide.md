# Deploying AWS SAM applications to StackSim

StackSim's CloudFormation expands the `AWS::Serverless-2016-10-31` transform itself, as AWS does server-side. You can deploy SAM templates with the unmodified SAM CLI, the AWS CLI, an SDK, or the console. The supported subset is listed in [SAM coverage](sam-coverage.md). Anything outside it fails the whole deployment with an explicit error, so a template that deploys behaves as written.

For a small application to start from, see [`examples/sam-notes-api`](../examples/sam-notes-api/README.md); the [AWS CLI cookbook](aws-cli-cookbook.md#aws-sam) has the SAM recipes.

For a small application to start from, see [`examples/sam-notes-api`](../examples/sam-notes-api/README.md); the [AWS CLI cookbook](aws-cli-cookbook.md#aws-sam) has the SAM recipes.

## What works

- `AWS::Serverless::Function` with zip packages: `CodeUri` or `InlineCode`, the generated `<Function>Role`, `Policies` (AWS managed policy names, ARNs, inline statements, and the [policy templates](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-policy-templates.html) for services StackSim implements), `Tracing`, `DeadLetterQueue`, and the other properties in the coverage table.
- `Api` events, with the implicit `ServerlessRestApi` (`Prod` stage, plus the `Stage` stage SAM's deployment creates) or an explicit `AWS::Serverless::Api`.
- `HttpApi` events, with the implicit `ServerlessHttpApi` (`$default` stage with auto-deploy) or an explicit `AWS::Serverless::HttpApi`.
- Event sources, each with the resources, permissions, and role policies SAM generates:
  - `SQS` and `DynamoDB` (streams): an `<Function><Event>` event source mapping; the generated role gains `AWSLambdaSQSQueueExecutionRole` or `AWSLambdaDynamoDBExecutionRole`.
  - `SNS`: a subscription and permission, or with `SqsSubscription` a generated (or existing) queue, its queue policy, the subscription, and a mapping.
  - `S3`: a permission, plus a Lambda notification and a `DependsOn` added to the bucket. The bucket must be declared in the same template, as SAM requires.
  - `Schedule`, `EventBridgeRule`, and `CloudWatchEvent`: a rule with an `<Function><Event>LambdaTarget` target and a permission, including `RetryPolicy` and a generated dead-letter queue for `DeadLetterConfig: { Type: SQS }`.
  - `CloudWatchLogs`: a subscription filter and permission.
- `FunctionUrlConfig` (`<Function>Url`, plus the two public permissions for `AuthType: NONE`) and `EventInvokeConfig` (`<Function>EventInvokeConfig`, generating the `OnSuccess`/`OnFailure` queue or topic when only `Type` is given).
- `AutoPublishAlias`: a retained `<Function>Version<hash>` and `<Function>Alias<name>`. The version changes when the code, `Environment`, or `MemorySize` change (every property with `AutoPublishAliasAllProperties`, or `AutoPublishCodeSha256`). Event sources, permissions, API integrations, function URLs, and the event invoke config target the alias. `ProvisionedConcurrencyConfig`, `VersionDescription`, and `VersionDeletionPolicy` apply to it.
- `AWS::Serverless::LayerVersion`: a retained `<Layer><hash>` that changes with the layer's properties, so each change publishes a new layer version. Functions consume layers through `Layers`, including from `Globals`.
- `AWS::Serverless::StateMachine` (STANDARD): an inline `Definition` or a `DefinitionUri`, `DefinitionSubstitutions`, the generated `<StateMachine>Role` with `Policies` (including policy templates), and `Schedule`, `EventBridgeRule`, `CloudWatchEvent`, and `Api` events, each with the role SAM generates for the service to start executions.
- API `Auth`: on REST APIs, Cognito user pool, Lambda TOKEN and REQUEST, and `AWS_IAM` authorizers, `DefaultAuthorizer` with per-route `Authorizer: NONE`, scopes, `ApiKeyRequired` with `UsagePlan` (`PER_API`, `SHARED`, `NONE`), `ResourcePolicy`, and `InvokeRole`; on HTTP APIs, JWT and Lambda REQUEST authorizers, `EnableIamAuthorizer`, `DefaultAuthorizer`, and route `AuthorizationScopes`.
- REST API `Cors` (a string or a map), with the `OPTIONS` mock SAM generates on every path, plus `Models`, `RequestModel`, `RequestParameters`, `ApiKeySourceType`, and `Policy`.
- `AWS::Serverless::SimpleTable`.
- `Globals` for `Function`, `Api`, `HttpApi`, `SimpleTable`, `LayerVersion`, and `StateMachine`.
- SAM references such as `!Ref MyApi.Stage`, `!Ref MyApi.Deployment`, `!Ref MyApi.ApiKey`, `!Ref MyFunction.Alias`, `!Ref MyFunction.Version`, and `!Ref MyFunction.DestinationQueue` or `.DestinationTopic`.

Connectors come in a later phase; a template that uses them fails with a message that names the owning phase. `DeploymentPreference`, custom `Domain`s, `EXPRESS` state machines, state machine aliases, Kinesis, MSK, MQ, DocumentDB, self-managed Kafka, IoT, Alexa, Cognito, and `ScheduleV2` events are not supported.

## Point the SAM CLI at StackSim

Use SAM CLI 1.91 or later; earlier releases bundle a botocore that ignores `AWS_ENDPOINT_URL`.

```bash
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ACCESS_KEY_ID=admin AWS_SECRET_ACCESS_KEY=password AWS_REGION=eu-west-1
```

In PowerShell:

```powershell
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:AWS_ACCESS_KEY_ID = "admin"; $env:AWS_SECRET_ACCESS_KEY = "password"; $env:AWS_REGION = "eu-west-1"
```

## Create the artifact bucket

Until the SAM CLI's managed bucket is supported (SAM-05), give `sam deploy` a bucket you create yourself. The managed bucket uses SSE-KMS and a TLS-only bucket policy that StackSim cannot satisfy yet, so `--resolve-s3` and the `sam deploy --guided` default fail.

```bash
aws s3 mb s3://sam-artifacts
```

## Deploy the Hello World quick start

```bash
sam init --runtime nodejs22.x --dependency-manager npm --app-template hello-world --name sam-app --no-interactive
cd sam-app
sam build
sam deploy --stack-name hello --s3-bucket sam-artifacts --capabilities CAPABILITY_IAM
```

`--capabilities CAPABILITY_IAM` is required because SAM generates an IAM role for the function. Without it, the deployment fails with `Requires capabilities : [CAPABILITY_IAM]`, as on AWS. In `samconfig.toml`, set `resolve_s3 = false` and `s3_bucket = "sam-artifacts"` to avoid typing the flags.

Only Node.js runtimes (`nodejs18.x` through `nodejs24.x`) run locally, so use the Node.js `sam init` templates.

## Call the API

The quick start's `HelloWorldApi` output is the AWS-shaped URL, `https://<api-id>.execute-api.eu-west-1.amazonaws.com/Prod/hello/`. Locally, call the same API ID on StackSim's invoke port:

```bash
curl http://<api-id>.execute-api.localhost:4567/Prod/hello/
curl http://127.0.0.1:4567/<api-id>/Prod/hello/
```

For an HTTP API, the `$default` stage has no stage segment: `http://<api-id>.execute-api.localhost:4567/hello`.

## Event-source quick starts

The Node.js `sqs`, `sns`, `s3`, and `cw-event` quick starts deploy the same way:

```bash
sam init --runtime nodejs22.x --dependency-manager npm --app-template sqs --name sam-app --no-interactive
cd sam-app
sam build
sam deploy --stack-name sqs-app --s3-bucket sam-artifacts --capabilities CAPABILITY_IAM
```

Send a message (or publish to the topic, or put a `.json` object in the bucket), then read the function's output:

```bash
aws sqs send-message --queue-url <queue-url> --message-body hello
aws logs filter-log-events --log-group-name /aws/lambda/<function-name>
```

The `s3` quick start needs `--parameter-overrides AppBucketName=<bucket-name>`. The `cw-event` quick start runs on its hourly cron, on StackSim's clock. Removing an event from the template and redeploying deletes exactly the resources SAM generated for it.

## Step Functions quick start

The Node.js `step-func` quick start deploys a stock-trading state machine, three functions, and a table:

```bash
sam init --runtime nodejs22.x --dependency-manager npm --app-template step-func --name sam-app --no-interactive
cd sam-app
sam build
sam deploy --stack-name step-func-app --s3-bucket sam-artifacts --capabilities CAPABILITY_IAM
```

`sam deploy` uploads `statemachine/stock_trader.asl.json` as it is, and the stack reads it through `DefinitionS3Location`. The template ships its hourly schedule disabled, as on AWS, so nothing runs until you enable the rule:

```bash
aws events enable-rule --name <StockTradingStateMachineHourlyTradingSchedule rule name>
aws stepfunctions list-executions --state-machine-arn <StockTradingStateMachineArn output>
```

The schedule runs on StackSim's clock. Each execution invokes the functions through the role's `LambdaInvokePolicy` and writes the trade through `DynamoDBWritePolicy`.

## Authorizers

A REST API with a Cognito authorizer accepts the user pool's ID token in the `Authorization` header and answers `401` without one. With `DefaultAuthorizer: AWS_IAM`, SAM's integrations use the caller's credentials (`arn:aws:iam::*:user/*`): sign requests with SigV4, and the caller needs `lambda:InvokeFunction` on the function as well as `execute-api:Invoke`. An HTTP API JWT authorizer whose issuer is a StackSim user pool (`https://cognito-idp.<region>.amazonaws.com/<pool-id>`) validates that pool's tokens locally.

## Update and delete

Running `sam deploy` again with no changes prints `No changes to deploy`. A code change updates only the function. `sam delete --stack-name hello` removes everything the stack created, including the generated role.

## Inspect the expansion

```bash
aws cloudformation get-template --stack-name hello --template-stage Processed
```

The **Template** tab in the StackSim console has the same **View processed template** toggle as the AWS console.

## Local differences

- REST API deployment logical IDs (`ServerlessRestApiDeployment<hash>`) change exactly when AWS's would, but the hash itself differs: AWS hashes a Python `repr()` of the API definition, and StackSim hashes its canonical JSON.
- `AlwaysDeploy: true` uses StackSim's clock to force a new deployment on each update, so it is the one input that makes an expansion differ between runs.
- A transform error lists its causes in template order. SAM's own tests sort them by logical ID, so a multi-error message can list the same causes in a different order than the translator's fixtures.
- Unquoted YAML floats such as `2.0` stay text in StackSim's YAML reader, where SAM's Python loader yields a number. API Gateway and Step Functions read either form the same way.
- A state machine's `Logging` and `Tracing` expand exactly as SAM writes them, but StackSim's Step Functions accepts only `Level: OFF` and disabled tracing, so other settings fail when the stack deploys.
