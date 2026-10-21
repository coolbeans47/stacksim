# AWS SAM coverage

<!-- Generated from src/cloudformation/sam/coverage.ts by `node --import tsx scripts/generate-sam-coverage-doc.mjs`. Do not edit by hand. -->

StackSim expands the `AWS::Serverless-2016-10-31` transform itself. Every SAM resource type, property, event type, and Globals key in SAM v1.115.0 is listed here. Anything that is not implemented fails the whole transform with an explicit error naming the phase that will add it, or saying it is not supported; nothing is silently dropped. See [the SAM guide](sam-guide.md) for how to deploy.

## Resource types

| Resource type | Status |
|---|---|
| `AWS::Serverless::Api` | Implemented |
| `AWS::Serverless::Application` | Not supported (non-goal) |
| `AWS::Serverless::CapacityProvider` | Not supported (non-goal) |
| `AWS::Serverless::Connector` | Implemented |
| `AWS::Serverless::Function` | Implemented |
| `AWS::Serverless::GraphQLApi` | Not supported (non-goal) |
| `AWS::Serverless::HttpApi` | Implemented |
| `AWS::Serverless::LayerVersion` | Implemented |
| `AWS::Serverless::MicrovmImage` | Not supported (non-goal) |
| `AWS::Serverless::NetworkConnector` | Not supported (non-goal) |
| `AWS::Serverless::SimpleTable` | Implemented |
| `AWS::Serverless::StateMachine` | Implemented |
| `AWS::Serverless::WebFunction` | Not supported (non-goal) |
| `AWS::Serverless::WebSocketApi` | Not supported (non-goal) |

## Resource attributes

| Attribute | Status |
|---|---|
| `Condition` | Implemented |
| `DeletionPolicy` | Implemented |
| `DependsOn` | Implemented |
| `IgnoreGlobals` | Implemented |
| `Metadata` | Implemented |
| `UpdateReplacePolicy` | Implemented |
| `Connectors` | Implemented |

## `AWS::Serverless::Function` properties

| Property | Status | Notes |
|---|---|---|
| `Architectures` | Implemented |  |
| `AssumeRolePolicyDocument` | Implemented |  |
| `AutoPublishAlias` | Implemented |  |
| `AutoPublishAliasAllProperties` | Implemented |  |
| `AutoPublishCodeSha256` | Implemented |  |
| `CapacityProviderConfig` | Not supported (non-goal) |  |
| `CodeSigningConfigArn` | Implemented |  |
| `CodeUri` | Implemented |  |
| `DeadLetterQueue` | Implemented |  |
| `DeploymentPreference` | Not supported (non-goal) | Needs a CodeDeploy service. |
| `Description` | Implemented |  |
| `DurableConfig` | Not supported (non-goal) |  |
| `Environment` | Implemented |  |
| `EphemeralStorage` | Implemented |  |
| `EventInvokeConfig` | Implemented | SQS, SNS, Lambda, and EventBridge destinations; `Type: S3Bucket` is not supported (Lambda S3 async destinations are not available locally). |
| `Events` | Implemented |  |
| `FileSystemConfigs` | Not supported (non-goal) |  |
| `FunctionName` | Implemented |  |
| `FunctionScalingConfig` | Not supported (non-goal) |  |
| `FunctionUrlConfig` | Implemented |  |
| `Handler` | Implemented |  |
| `ImageConfig` | Not supported (non-goal) |  |
| `ImageUri` | Not supported (non-goal) |  |
| `InlineCode` | Implemented |  |
| `KmsKeyArn` | Not supported (non-goal) |  |
| `Layers` | Implemented |  |
| `LoggingConfig` | Implemented |  |
| `MemorySize` | Implemented |  |
| `PackageType` | Implemented | `Zip` only; `Image` needs ECR and a container image runtime. |
| `PermissionsBoundary` | Implemented |  |
| `Policies` | Implemented |  |
| `PropagateTags` | Implemented |  |
| `ProvisionedConcurrencyConfig` | Implemented |  |
| `PublishToLatestPublished` | Not supported (non-goal) |  |
| `RecursiveLoop` | Not supported (non-goal) |  |
| `ReservedConcurrentExecutions` | Implemented |  |
| `Role` | Implemented | A string or intrinsic role ARN; an `Fn::If` that selects the generated role is not supported. |
| `RolePath` | Implemented |  |
| `Runtime` | Implemented |  |
| `RuntimeManagementConfig` | Not supported (non-goal) |  |
| `SnapStart` | Not supported (non-goal) |  |
| `SourceKMSKeyArn` | Not supported (non-goal) |  |
| `Tags` | Implemented |  |
| `TenancyConfig` | Not supported (non-goal) |  |
| `Timeout` | Implemented |  |
| `Tracing` | Implemented |  |
| `VersionDeletionPolicy` | Implemented |  |
| `VersionDescription` | Implemented |  |
| `VpcConfig` | Not supported (non-goal) | StackSim has no VPC model. |

### `AWS::Serverless::Function` event types

| Event type | Status | Properties not yet implemented | Notes |
|---|---|---|---|
| `AlexaSkill` | Not supported (non-goal) |  |  |
| `Api` | Implemented | `ResponseTransferMode` (Not supported (non-goal)) | With `AWS_IAM` auth and no `InvokeRole` (or `CALLER_CREDENTIALS`), API Gateway calls the function with the SigV4 caller's credentials, as on AWS. |
| `CloudWatchEvent` | Implemented |  | Also implemented: `DeadLetterConfig`, `InputTransformer`, `RetryPolicy`, `RuleName`, `Target`, which SAM accepts although its schema omits them. |
| `CloudWatchLogs` | Implemented |  |  |
| `Cognito` | Not supported (non-goal) |  |  |
| `DocumentDB` | Not supported (non-goal) |  |  |
| `DynamoDB` | Implemented | `KmsKeyArn` (Not supported (non-goal)), `MetricsConfig` (Not supported (non-goal)), `StartingPositionTimestamp` (Not supported (non-goal)) | SAM's translator also accepts `ConsumerGroupId`, `KafkaBootstrapServers`, `LoggingConfig`, `ProvisionedPollerConfig`, `Queues`, `ScalingConfig`, `SchemaRegistryConfig`, `SecretsManagerKmsKeyId`, `SourceAccessConfigurations`, `Topics`; not supported (non-goal). `KmsKeyArn` needs KMS. DynamoDB Streams have no `AT_TIMESTAMP` starting position. |
| `EventBridgeRule` | Implemented |  | Also implemented: `Enabled`, `State`, which SAM accepts although its schema omits them. |
| `HttpApi` | Implemented |  |  |
| `IoTRule` | Not supported (non-goal) |  |  |
| `Kinesis` | Not supported (non-goal) |  |  |
| `MQ` | Not supported (non-goal) |  |  |
| `MSK` | Not supported (non-goal) |  |  |
| `S3` | Implemented |  | The bucket must be declared in the same template, as SAM requires. |
| `Schedule` | Implemented |  | Also implemented: `RuleName`, which SAM accepts although its schema omits them. As in SAM, `RuleName` is accepted and ignored on Schedule events; `Name` names the rule. |
| `ScheduleV2` | Not supported (non-goal) |  |  |
| `SelfManagedKafka` | Not supported (non-goal) |  |  |
| `SNS` | Implemented |  | Also implemented: `RedrivePolicy`, which SAM accepts although its schema omits them. |
| `SQS` | Implemented | `KmsKeyArn` (Not supported (non-goal)), `MetricsConfig` (Not supported (non-goal)) | SAM's translator also accepts `BisectBatchOnFunctionError`, `ConsumerGroupId`, `DestinationConfig`, `KafkaBootstrapServers`, `LoggingConfig`, `MaximumRecordAgeInSeconds`, `MaximumRetryAttempts`, `ParallelizationFactor`, `ProvisionedPollerConfig`, `Queues`, `SchemaRegistryConfig`, `SecretsManagerKmsKeyId`, `SourceAccessConfigurations`, `StartingPosition`, `StartingPositionTimestamp`, `Topics`, `TumblingWindowInSeconds`; not supported (non-goal). `KmsKeyArn` needs KMS. |

## `AWS::Serverless::Api` properties

| Property | Status | Notes |
|---|---|---|
| `AccessLogSetting` | Implemented |  |
| `AlwaysDeploy` | Implemented |  |
| `ApiKeySourceType` | Implemented |  |
| `Auth` | Implemented |  |
| `BinaryMediaTypes` | Implemented |  |
| `CacheClusterEnabled` | Implemented |  |
| `CacheClusterSize` | Implemented |  |
| `CanarySetting` | Not supported (non-goal) |  |
| `Cors` | Implemented |  |
| `DefinitionBody` | Implemented |  |
| `DefinitionUri` | Implemented |  |
| `Description` | Implemented |  |
| `DisableExecuteApiEndpoint` | Not supported (non-goal) |  |
| `Domain` | Not supported (non-goal) | Needs ACM and Route 53 semantics StackSim does not model. |
| `EndpointAccessMode` | Not supported (non-goal) |  |
| `EndpointConfiguration` | Implemented |  |
| `FailOnWarnings` | Not supported (non-goal) |  |
| `GatewayResponses` | Implemented |  |
| `MergeDefinitions` | Not supported (non-goal) |  |
| `MethodSettings` | Implemented |  |
| `MinimumCompressionSize` | Implemented |  |
| `Mode` | Not supported (non-goal) |  |
| `Models` | Implemented |  |
| `Name` | Implemented |  |
| `OpenApiVersion` | Implemented |  |
| `Policy` | Implemented |  |
| `PropagateTags` | Implemented |  |
| `SecurityPolicy` | Not supported (non-goal) |  |
| `StageName` | Implemented |  |
| `Tags` | Implemented |  |
| `TracingEnabled` | Implemented |  |
| `Variables` | Implemented |  |

## `AWS::Serverless::HttpApi` properties

| Property | Status | Notes |
|---|---|---|
| `AccessLogSettings` | Implemented |  |
| `Auth` | Implemented |  |
| `CorsConfiguration` | Implemented |  |
| `DefaultRouteSettings` | Implemented |  |
| `DefinitionBody` | Implemented |  |
| `DefinitionUri` | Implemented |  |
| `Description` | Implemented |  |
| `DisableExecuteApiEndpoint` | Implemented |  |
| `Domain` | Not supported (non-goal) |  |
| `FailOnWarnings` | Implemented |  |
| `Name` | Implemented |  |
| `PropagateTags` | Implemented |  |
| `RouteSettings` | Implemented |  |
| `StageName` | Implemented |  |
| `StageVariables` | Implemented |  |
| `Tags` | Implemented |  |

## `AWS::Serverless::SimpleTable` properties

| Property | Status | Notes |
|---|---|---|
| `PointInTimeRecoverySpecification` | Implemented |  |
| `PrimaryKey` | Implemented |  |
| `ProvisionedThroughput` | Implemented |  |
| `SSESpecification` | Implemented | SSE with the DynamoDB-owned key only; KMS keys need KMS. |
| `TableName` | Implemented |  |
| `Tags` | Implemented |  |

## `AWS::Serverless::LayerVersion` properties

| Property | Status | Notes |
|---|---|---|
| `CompatibleArchitectures` | Implemented |  |
| `CompatibleRuntimes` | Implemented |  |
| `ContentUri` | Implemented |  |
| `Description` | Implemented |  |
| `LayerName` | Implemented |  |
| `LicenseInfo` | Implemented |  |
| `PublishLambdaVersion` | Implemented |  |
| `RetentionPolicy` | Implemented |  |

## `AWS::Serverless::StateMachine` properties

| Property | Status | Notes |
|---|---|---|
| `AutoPublishAlias` | Not supported (non-goal) | Needs Step Functions versions and aliases, which StackSim does not model. |
| `Definition` | Implemented |  |
| `DefinitionSubstitutions` | Implemented |  |
| `DefinitionUri` | Implemented |  |
| `DeploymentPreference` | Not supported (non-goal) | Needs Step Functions versions and aliases, which StackSim does not model. |
| `Events` | Implemented |  |
| `Logging` | Implemented | Expanded exactly. StackSim's Step Functions accepts only `Level: OFF` until execution logging exists, so other levels fail when the stack deploys. |
| `Name` | Implemented |  |
| `PermissionsBoundary` | Implemented |  |
| `Policies` | Implemented |  |
| `PropagateTags` | Implemented |  |
| `Role` | Implemented |  |
| `RolePath` | Implemented |  |
| `Tags` | Implemented |  |
| `Tracing` | Implemented | Expanded exactly, with SAM's X-Ray policy. StackSim's Step Functions does not trace, so `Enabled: true` fails when the stack deploys. |
| `Type` | Implemented | `STANDARD` only; `EXPRESS` fails because StackSim's Step Functions runs STANDARD state machines only. |
| `UseAliasAsEventTarget` | Not supported (non-goal) | Needs Step Functions versions and aliases, which StackSim does not model. |

### `AWS::Serverless::StateMachine` event types

| Event type | Status | Properties not yet implemented | Notes |
|---|---|---|---|
| `Api` | Implemented |  |  |
| `CloudWatchEvent` | Implemented |  | Also implemented: `DeadLetterConfig`, `InputTransformer`, `RetryPolicy`, `RuleName`, `State`, `Target`, which SAM accepts although its schema omits them. |
| `EventBridgeRule` | Implemented |  | Also implemented: `State`, which SAM accepts although its schema omits them. |
| `Schedule` | Implemented |  |  |
| `ScheduleV2` | Not supported (non-goal) |  |  |

## `AWS::Serverless::Connector` properties

| Property | Status | Notes |
|---|---|---|
| `Destination` | Implemented |  |
| `Permissions` | Implemented |  |
| `Source` | Implemented | Every source/destination pair StackSim can back is implemented; see [Connector pairs](#connector-pairs). The others fail explicitly. |

## Connector pairs

`AWS::Serverless::Connector` and embedded `Connectors` support every source/destination pair in SAM's connector profiles that StackSim can back: both services exist locally, the generated policy deploys, and the service that uses it enforces it. Any other pair fails the transform, naming the pair.

| Source | Destination | Status | Notes |
|---|---|---|---|
| `AWS::DynamoDB::Table` | `AWS::Lambda::Function` | Implemented | A managed policy on the function's role; the stream event source mapping checks it. |
| `AWS::Events::Rule` | `AWS::SNS::Topic` | Implemented | A topic policy for `events.amazonaws.com`; EventBridge's delivery checks it. |
| `AWS::Events::Rule` | `AWS::Events::EventBus` | Not supported (non-goal) | EventBridge in StackSim cannot deliver to an event bus target. |
| `AWS::Events::Rule` | `AWS::StepFunctions::StateMachine` | Implemented | A managed policy on the rule target's role; EventBridge's StartExecution checks it. |
| `AWS::Events::Rule` | `AWS::Lambda::Function` | Implemented | A Lambda permission for `events.amazonaws.com`. |
| `AWS::Events::Rule` | `AWS::SQS::Queue` | Implemented | A queue policy for `events.amazonaws.com`; EventBridge's delivery checks it. |
| `AWS::Lambda::Function` | `AWS::Lambda::Function` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::S3::Bucket` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::DynamoDB::Table` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::SQS::Queue` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::SNS::Topic` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::StepFunctions::StateMachine` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::Events::EventBus` | Implemented |  |
| `AWS::Lambda::Function` | `AWS::Location::PlaceIndex` | Not supported (non-goal) | StackSim has no Amazon Location Service. |
| `AWS::ApiGatewayV2::Api` | `AWS::Lambda::Function` | Implemented | A Lambda permission for `apigateway.amazonaws.com`. |
| `AWS::ApiGateway::RestApi` | `AWS::Lambda::Function` | Implemented | A Lambda permission for `apigateway.amazonaws.com`. |
| `AWS::SNS::Topic` | `AWS::SQS::Queue` | Implemented | A queue policy for `sns.amazonaws.com`. |
| `AWS::SNS::Topic` | `AWS::Lambda::Function` | Implemented | A Lambda permission for `sns.amazonaws.com`. |
| `AWS::SQS::Queue` | `AWS::Lambda::Function` | Implemented | A managed policy on the function's role; the event source mapping checks it. |
| `AWS::S3::Bucket` | `AWS::Lambda::Function` | Implemented | A Lambda permission for `s3.amazonaws.com`. |
| `AWS::StepFunctions::StateMachine` | `AWS::Lambda::Function` | Implemented |  |
| `AWS::StepFunctions::StateMachine` | `AWS::SNS::Topic` | Implemented |  |
| `AWS::StepFunctions::StateMachine` | `AWS::SQS::Queue` | Implemented |  |
| `AWS::StepFunctions::StateMachine` | `AWS::S3::Bucket` | Implemented | The policy is enforced for the role, but StackSim's Step Functions has no S3 task integration. |
| `AWS::StepFunctions::StateMachine` | `AWS::DynamoDB::Table` | Implemented |  |
| `AWS::StepFunctions::StateMachine` | `AWS::StepFunctions::StateMachine` | Implemented |  |
| `AWS::StepFunctions::StateMachine` | `AWS::Events::EventBus` | Implemented |  |
| `AWS::AppSync::DataSource` | `AWS::DynamoDB::Table` | Implemented | A managed policy on the data source's service role; AppSync's DynamoDB resolvers check it. |
| `AWS::AppSync::DataSource` | `AWS::Lambda::Function` | Not supported (non-goal) | AppSync in StackSim supports only NONE and AMAZON_DYNAMODB data sources. |
| `AWS::AppSync::DataSource` | `AWS::Events::EventBus` | Not supported (non-goal) | AppSync in StackSim supports only NONE and AMAZON_DYNAMODB data sources. |
| `AWS::AppSync::GraphQLApi` | `AWS::Lambda::Function` | Not supported (non-goal) | AppSync in StackSim does not invoke Lambda functions, and AWS::Lambda::Permission does not accept the `appsync.amazonaws.com` principal. |

## Globals

A Globals key has the status of the same property on its resource type.

| Section | Status |
|---|---|
| `Api` | Implemented |
| `CapacityProvider` | Not supported (non-goal) |
| `Function` | Implemented |
| `HttpApi` | Implemented |
| `LayerVersion` | Implemented |
| `MicrovmImage` | Not supported (non-goal) |
| `NetworkConnector` | Not supported (non-goal) |
| `SimpleTable` | Implemented |
| `StateMachine` | Implemented |
| `WebSocketApi` | Not supported (non-goal) |
