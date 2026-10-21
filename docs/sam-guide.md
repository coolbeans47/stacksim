# Deploying AWS SAM applications to StackSim

StackSim's CloudFormation expands the `AWS::Serverless-2016-10-31` transform itself, as AWS does server-side. You can deploy SAM templates with the unmodified SAM CLI, the AWS CLI, an SDK, or the console. The supported subset is listed in [SAM coverage](sam-coverage.md). Anything outside it fails the whole deployment with an explicit error, so a template that deploys behaves as written.

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
- `AWS::Serverless::Connector` and embedded `Connectors` on any resource, for the source and destination pairs StackSim can back (see [Connectors](#connectors)).

`DeploymentPreference`, custom `Domain`s, `EXPRESS` state machines, state machine aliases, Kinesis, MSK, MQ, DocumentDB, self-managed Kafka, IoT, Alexa, Cognito, and `ScheduleV2` events are not supported.

## Point the SAM CLI at StackSim

Use SAM CLI 1.91 or later; earlier releases bundle a botocore that ignores `AWS_ENDPOINT_URL`. Every service uses the main endpoint, except S3, which uses the [HTTPS endpoint](#the-https-s3-endpoint) so that the SAM CLI's managed bucket accepts its uploads. First save the StackSim CA certificate:

```bash
curl -o ~/stacksim-ca.pem http://127.0.0.1:4566/_stacksim/ca.pem
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ENDPOINT_URL_S3=https://127.0.0.1:4569
export AWS_CA_BUNDLE=~/stacksim-ca.pem
export AWS_ACCESS_KEY_ID=admin AWS_SECRET_ACCESS_KEY=password AWS_REGION=eu-west-1
```

In PowerShell:

```powershell
curl.exe -o "$HOME\stacksim-ca.pem" http://127.0.0.1:4566/_stacksim/ca.pem
$env:AWS_ENDPOINT_URL = "http://127.0.0.1:4566"
$env:AWS_ENDPOINT_URL_S3 = "https://127.0.0.1:4569"
$env:AWS_CA_BUNDLE = "$HOME\stacksim-ca.pem"
$env:AWS_ACCESS_KEY_ID = "admin"; $env:AWS_SECRET_ACCESS_KEY = "password"; $env:AWS_REGION = "eu-west-1"
```

`AWS_CA_BUNDLE` makes the SAM CLI (and the AWS CLI) trust StackSim's certificate. Plain-HTTP endpoints ignore it, so it is safe to set for every service. The certificate file is also in the data directory at `<data-dir>/data/cloudformation/custom-resource-pki/ca.pem`.

You can put the same settings in a profile instead. Do not mix the two: an `AWS_ENDPOINT_URL` environment variable overrides a profile's service-specific endpoint, which would send S3 back to plain HTTP.

```ini
[profile stacksim]
region = eu-west-1
endpoint_url = http://127.0.0.1:4566
ca_bundle = /home/me/stacksim-ca.pem
services = stacksim-services

[services stacksim-services]
s3 =
  endpoint_url = https://127.0.0.1:4569
```

## The managed artifact bucket

`sam deploy --guided`, `sam deploy --resolve-s3`, and `resolve_s3 = true` in `samconfig.toml` work unchanged. The first time, the SAM CLI creates the stack `aws-sam-cli-managed-default` from its fixed template. StackSim deploys that template as written:

- a bucket with versioning, a full public-access block, the tag `ManagedStackSource=AwsSamCli`, and default encryption `aws:kms` with the AWS managed key `aws/s3`;
- a bucket policy that allows the Serverless Application Repository to read objects and denies every request that does not use TLS (`aws:SecureTransport` is `false`); and
- the `SourceBucket` output that the SAM CLI reads.

The SAM CLI then uploads your artifacts to that bucket over HTTPS. Because of the TLS-only policy, plain HTTP to the bucket is denied, including from the AWS CLI or an SDK on port 4566. The error names the HTTPS endpoint:

```text
AccessDenied: ... The bucket policy denies requests that do not use TLS (aws:SecureTransport is false over plain HTTP). Send S3 requests to the StackSim HTTPS endpoint https://127.0.0.1:4569 ...
```

If you see that error from `sam deploy`, check that `AWS_ENDPOINT_URL_S3` is set to the HTTPS endpoint, as shown above. Without `AWS_CA_BUNDLE`, the SAM CLI fails with `SSL validation failed ... CERTIFICATE_VERIFY_FAILED`.

You can still use a bucket of your own instead: `aws s3 mb s3://sam-artifacts`, then `sam deploy --s3-bucket sam-artifacts` (or `resolve_s3 = false` and `s3_bucket = "sam-artifacts"` in `samconfig.toml`). That works over plain HTTP, because your bucket has no TLS-only policy.

## Deploy the Hello World quick start

```bash
sam init --runtime nodejs22.x --dependency-manager npm --app-template hello-world --name sam-app --no-interactive
cd sam-app
sam build
sam deploy --guided
```

Answer the prompts: the stack name (`hello`), the Region (`eu-west-1`), `N` to confirm changes, `Y` to allow IAM role creation, `N` to disable rollback, and `y` when it warns that `HelloWorldFunction has no authentication`. Then save the answers to `samconfig.toml`. The SAM CLI prints `Managed S3 bucket: aws-sam-cli-managed-default-samclisourcebucket-...`, and later `sam deploy` runs reuse the saved settings. Without prompts:

```bash
sam deploy --stack-name hello --resolve-s3 --capabilities CAPABILITY_IAM
```

`--capabilities CAPABILITY_IAM` is required because SAM generates an IAM role for the function. Without it, the deployment fails with `Requires capabilities : [CAPABILITY_IAM]`, as on AWS.

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
sam deploy --stack-name sqs-app --resolve-s3 --capabilities CAPABILITY_IAM
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
sam deploy --stack-name step-func-app --resolve-s3 --capabilities CAPABILITY_IAM
```

`sam deploy` uploads `statemachine/stock_trader.asl.json` as it is, and the stack reads it through `DefinitionS3Location`. The template ships its hourly schedule disabled, as on AWS, so nothing runs until you enable the rule:

```bash
aws events enable-rule --name <StockTradingStateMachineHourlyTradingSchedule rule name>
aws stepfunctions list-executions --state-machine-arn <StockTradingStateMachineArn output>
```

The schedule runs on StackSim's clock. Each execution invokes the functions through the role's `LambdaInvokePolicy` and writes the trade through `DynamoDBWritePolicy`.

## Authorizers

A REST API with a Cognito authorizer accepts the user pool's ID token in the `Authorization` header and answers `401` without one. With `DefaultAuthorizer: AWS_IAM`, SAM's integrations use the caller's credentials (`arn:aws:iam::*:user/*`): sign requests with SigV4, and the caller needs `lambda:InvokeFunction` on the function as well as `execute-api:Invoke`. An HTTP API JWT authorizer whose issuer is a StackSim user pool (`https://cognito-idp.<region>.amazonaws.com/<pool-id>`) validates that pool's tokens locally.

## Connectors

A connector grants its source `Read` or `Write` access to its destination. SAM turns it into the policy the pair needs, and StackSim enforces that policy:

- an `AWS::IAM::ManagedPolicy` named `<Connector>Policy`, attached to the role of the resource that acts (usually the source);
- an `AWS::Lambda::Permission` (`<Connector>WriteLambdaPermission`), when a service invokes a function;
- an `AWS::SQS::QueuePolicy` (`<Connector>QueuePolicy`) or `AWS::SNS::TopicPolicy` (`<Connector>TopicPolicy`), when SNS or EventBridge sends to a queue or topic.

With a list of destinations, the names end in `Destination<index>`. An embedded connector `Connectors: { NotesAccess: … }` on `Writer` becomes the connector `WriterNotesAccess`. Every generated resource carries `Metadata.aws:sam:connectors`, plus the connector's `Condition`, `DeletionPolicy`, `UpdateReplacePolicy`, `DependsOn`, and `Metadata`. A `DependsOn` that names the connector itself is rewritten to name what it generated. As in SAM, a queue or stream connector to a function also makes the event source mapping depend on the policy, and a connector between two state machines makes the source depend on it.

These pairs are supported. A reference by `Id` may name the SAM resource (`AWS::Serverless::Function`, `StateMachine`, `Api`, `HttpApi`, or `SimpleTable`) or the CloudFormation resource:

| Source | Destinations |
|---|---|
| Lambda function | Lambda function, S3 bucket, DynamoDB table, SQS queue, SNS topic, state machine, event bus |
| State machine | Lambda function, SNS topic, SQS queue, S3 bucket, DynamoDB table, state machine, event bus |
| EventBridge rule | Lambda function, SQS queue, SNS topic, state machine |
| REST API or HTTP API | Lambda function |
| SNS topic | SQS queue, Lambda function |
| SQS queue, or DynamoDB table (streams) | Lambda function |
| S3 bucket | Lambda function |
| AppSync data source | DynamoDB table |

These pairs fail the transform with an error that names the pair:

- a function to an Amazon Location place index (StackSim has no Location service);
- an EventBridge rule to an event bus (EventBridge in StackSim has no event-bus targets);
- an AppSync data source to a function or an event bus, and an AppSync API to a function (StackSim's AppSync supports only `NONE` and `AMAZON_DYNAMODB` data sources).

[SAM coverage](sam-coverage.md#connector-pairs) has the full table. The [AWS CLI cookbook](aws-cli-cookbook.md#how-to-connect-a-function-to-a-table-with-a-connector) walks through a function-to-table connector.

## Update and delete

Running `sam deploy` again with no changes prints `No changes to deploy`. A code change updates only the function. `sam delete --stack-name hello` removes everything the stack created, including the generated role, and deletes the stack's artifacts from the managed bucket. It leaves `aws-sam-cli-managed-default` and its bucket in place for your other applications, as on AWS. Because the bucket is versioned, the deleted artifacts remain as noncurrent versions.

## Inspect the expansion

```bash
aws cloudformation get-template --stack-name hello --template-stage Processed
```

The **Template** tab in the StackSim console has the same **View processed template** toggle as the AWS console.

## The HTTPS S3 endpoint

StackSim serves the same API as `http://127.0.0.1:4566` over TLS at `https://127.0.0.1:4569` (set the port with `STACKSIM_S3_TLS_PORT`). It listens on loopback only. Requests on it carry `aws:SecureTransport=true`, so bucket policies that require TLS allow them; the same requests on port 4566 carry `false`.

- **Path style:** `https://127.0.0.1:4569/<bucket>/<key>`. botocore (the SAM CLI and the AWS CLI) and the AWS SDKs use path style for an IP endpoint, so this is the setting to use.
- **Virtual-hosted style:** `https://<bucket>.s3.localhost:4569/<key>`, with the endpoint `https://s3.localhost:4569`. This works only if your system resolves `*.s3.localhost` to `127.0.0.1`. Many systems do not, including Windows; add a hosts-file entry per bucket if you need it. AWS CLI 2.36 used path style for this endpoint too, unless the profile sets `s3 = addressing_style = virtual`.

The certificate's names are `localhost`, `s3.localhost`, `*.s3.localhost`, `127.0.0.1`, and `::1`. It is issued by StackSim's installation CA, the same CA that signs the CloudFront local viewers. Download the CA from `http://127.0.0.1:4566/_stacksim/ca.pem`. The certificate and the CA persist in the data directory across restarts.

### Trust the StackSim CA

The SAM CLI and the AWS CLI need only `AWS_CA_BUNDLE` (or `ca_bundle` in the profile). They use their own CA bundle, not the operating system's. Node.js programs need `NODE_EXTRA_CA_CERTS=<path>/stacksim-ca.pem`.

Add the CA to your operating system's trust store only if another tool (a browser, or `curl` without `--cacert`) needs it. The CA's private key is in your StackSim data directory, and the CA is not limited to particular host names. Anyone who can read that directory could issue a certificate your machine would trust for any site. Prefer `AWS_CA_BUNDLE`, and remove the CA from the trust store when you no longer need it.

- **Windows** (current user; confirm the security prompt):

  ```powershell
  Import-Certificate -FilePath "$HOME\stacksim-ca.pem" -CertStoreLocation Cert:\CurrentUser\Root
  ```

  To remove it, delete the `stacksim CloudFormation development CA` certificate from `certmgr.msc` under **Trusted Root Certification Authorities**.
- **macOS** (login keychain):

  ```bash
  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/stacksim-ca.pem
  ```

  To remove it, delete `stacksim CloudFormation development CA` in Keychain Access.
- **Linux** (Debian and Ubuntu):

  ```bash
  sudo cp ~/stacksim-ca.pem /usr/local/share/ca-certificates/stacksim-ca.crt
  sudo update-ca-certificates
  ```

  On Fedora and RHEL, copy the file to `/etc/pki/ca-trust/source/anchors/` and run `sudo update-ca-trust`. To remove it, delete the file and run the same command again (`update-ca-certificates --fresh` on Debian and Ubuntu).

To check the connection, `curl --cacert ~/stacksim-ca.pem https://127.0.0.1:4569/_stacksim/health` returns StackSim's health document (without `--cacert` once the CA is trusted). On Windows, `curl.exe` also needs `--ssl-no-revoke`, because the local CA publishes no revocation list. S3 requests need SigV4 signatures, so use the AWS CLI for those, for example `aws s3 ls s3://<managed-bucket>/` with the settings above.

## Local differences

- REST API deployment logical IDs (`ServerlessRestApiDeployment<hash>`) change exactly when AWS's would, but the hash itself differs: AWS hashes a Python `repr()` of the API definition, and StackSim hashes its canonical JSON.
- `AlwaysDeploy: true` uses StackSim's clock to force a new deployment on each update, so it is the one input that makes an expansion differ between runs.
- A transform error lists its causes in template order. SAM's own tests sort them by logical ID, so a multi-error message can list the same causes in a different order than the translator's fixtures.
- Unquoted YAML floats such as `2.0` stay text in StackSim's YAML reader, where SAM's Python loader yields a number. API Gateway and Step Functions read either form the same way.
- A state machine's `Logging` and `Tracing` expand exactly as SAM writes them, but StackSim's Step Functions accepts only `Level: OFF` and disabled tracing, so other settings fail when the stack deploys.
- StackSim has no KMS service. SSE-KMS works only with the AWS managed key `aws/s3`. StackSim models that key as an encryption descriptor: its key ID is fixed for your installation, account, and Region, objects record and report its ARN (`HeadObject` shows `x-amz-server-side-encryption: aws:kms` and the key ARN), and decryption is implicit for callers in the bucket's account. Callers from other accounts cannot use it, as on AWS. `GetBucketEncryption` returns the configuration as written, as AWS does, so the managed bucket shows `aws:kms` with no key ID; the console shows the key ARN with a local-difference note. Object data is encrypted at rest with StackSim's local installation key either way. Customer managed keys and DSSE-KMS fail with `KMS.NotFoundException`.
- The SAM CLI uploads artifacts with `ServerSideEncryption=AES256` unless you pass `--kms-key-id`, so its objects in the managed bucket use SSE-S3, as on AWS. Objects you put without an encryption header use the bucket default, SSE-KMS.
- The bucket policy's statement for `serverlessrepo.amazonaws.com` is stored and evaluated, but StackSim has no Serverless Application Repository to use it.
- The HTTPS endpoint's certificate is issued by StackSim's own CA, which no system trusts until you configure it.
- StackSim allows one policy resource per queue or topic. Two connectors that each generate a policy for the same queue (for example one from a topic and one from a rule), or a connector next to your own `AWS::SQS::QueuePolicy` or `AWS::SNS::TopicPolicy` for that queue or topic, fail when the stack deploys. On AWS the later policy silently replaces the earlier one. Write one queue or topic policy that covers every source instead.
- `AWS::Events::Rule` accepts Lambda, Step Functions, and standard SQS and SNS targets. FIFO queue and topic targets, which need `SqsParameters`, and other target types fail when the stack deploys.
- A connector from a state machine to an S3 bucket generates and enforces its policy, but StackSim's Step Functions has no S3 task integration to use it.
- When an identity policy denies an SNS call, StackSim's error code is `AccessDenied`; AWS SNS returns `AuthorizationError`.
