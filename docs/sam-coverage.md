# AWS SAM coverage

<!-- Generated from src/cloudformation/sam/coverage.ts by `node --import tsx scripts/generate-sam-coverage-doc.mjs`. Do not edit by hand. -->

StackSim expands the `AWS::Serverless-2016-10-31` transform itself. Every SAM resource type, property, event type, and Globals key in SAM v1.115.0 is listed here. Anything that is not implemented fails the whole transform with an explicit error naming the phase that will add it, or saying it is not supported; nothing is silently dropped. See [the SAM guide](sam-guide.md) for how to deploy.

## Resource types

| Resource type | Status |
|---|---|
| `AWS::Serverless::Api` | Implemented |
| `AWS::Serverless::Application` | Not supported (non-goal) |
| `AWS::Serverless::CapacityProvider` | Not supported (non-goal) |
| `AWS::Serverless::Connector` | Planned: SAM-06 |
| `AWS::Serverless::Function` | Implemented |
| `AWS::Serverless::GraphQLApi` | Not supported (non-goal) |
| `AWS::Serverless::HttpApi` | Implemented |
| `AWS::Serverless::LayerVersion` | Planned: SAM-04 |
| `AWS::Serverless::MicrovmImage` | Not supported (non-goal) |
| `AWS::Serverless::NetworkConnector` | Not supported (non-goal) |
| `AWS::Serverless::SimpleTable` | Implemented |
| `AWS::Serverless::StateMachine` | Planned: SAM-04 |
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
| `Connectors` | Planned: SAM-06 |

## `AWS::Serverless::Function` properties

| Property | Status | Notes |
|---|---|---|
| `Architectures` | Implemented |  |
| `AssumeRolePolicyDocument` | Implemented |  |
| `AutoPublishAlias` | Planned: SAM-04 |  |
| `AutoPublishAliasAllProperties` | Planned: SAM-04 |  |
| `AutoPublishCodeSha256` | Planned: SAM-04 |  |
| `CapacityProviderConfig` | Not supported (non-goal) |  |
| `CodeSigningConfigArn` | Implemented |  |
| `CodeUri` | Implemented |  |
| `DeadLetterQueue` | Implemented |  |
| `DeploymentPreference` | Not supported (non-goal) | Needs a CodeDeploy service. |
| `Description` | Implemented |  |
| `DurableConfig` | Not supported (non-goal) |  |
| `Environment` | Implemented |  |
| `EphemeralStorage` | Implemented |  |
| `EventInvokeConfig` | Planned: SAM-03 |  |
| `Events` | Implemented |  |
| `FileSystemConfigs` | Not supported (non-goal) |  |
| `FunctionName` | Implemented |  |
| `FunctionScalingConfig` | Not supported (non-goal) |  |
| `FunctionUrlConfig` | Planned: SAM-03 |  |
| `Handler` | Implemented |  |
| `ImageConfig` | Not supported (non-goal) |  |
| `ImageUri` | Not supported (non-goal) |  |
| `InlineCode` | Implemented |  |
| `KmsKeyArn` | Not supported (non-goal) |  |
| `Layers` | Planned: SAM-04 |  |
| `LoggingConfig` | Implemented |  |
| `MemorySize` | Implemented |  |
| `PackageType` | Implemented | `Zip` only; `Image` needs ECR and a container image runtime. |
| `PermissionsBoundary` | Implemented |  |
| `Policies` | Implemented |  |
| `PropagateTags` | Implemented |  |
| `ProvisionedConcurrencyConfig` | Planned: SAM-04 |  |
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
| `VersionDeletionPolicy` | Planned: SAM-04 |  |
| `VersionDescription` | Planned: SAM-04 |  |
| `VpcConfig` | Not supported (non-goal) | StackSim has no VPC model. |

### `AWS::Serverless::Function` event types

| Event type | Status | Properties not yet implemented |
|---|---|---|
| `AlexaSkill` | Not supported (non-goal) |  |
| `Api` | Implemented | `Auth` (Planned: SAM-04), `RequestModel` (Planned: SAM-04), `RequestParameters` (Planned: SAM-04), `ResponseTransferMode` (Not supported (non-goal)) |
| `CloudWatchEvent` | Planned: SAM-03 |  |
| `CloudWatchLogs` | Planned: SAM-03 |  |
| `Cognito` | Not supported (non-goal) |  |
| `DocumentDB` | Not supported (non-goal) |  |
| `DynamoDB` | Planned: SAM-03 |  |
| `EventBridgeRule` | Planned: SAM-03 |  |
| `HttpApi` | Implemented | `Auth` (Planned: SAM-04) |
| `IoTRule` | Not supported (non-goal) |  |
| `Kinesis` | Not supported (non-goal) |  |
| `MQ` | Not supported (non-goal) |  |
| `MSK` | Not supported (non-goal) |  |
| `S3` | Planned: SAM-03 |  |
| `Schedule` | Planned: SAM-03 |  |
| `ScheduleV2` | Not supported (non-goal) |  |
| `SelfManagedKafka` | Not supported (non-goal) |  |
| `SNS` | Planned: SAM-03 |  |
| `SQS` | Planned: SAM-03 |  |

## `AWS::Serverless::Api` properties

| Property | Status | Notes |
|---|---|---|
| `AccessLogSetting` | Implemented |  |
| `AlwaysDeploy` | Implemented |  |
| `ApiKeySourceType` | Planned: SAM-04 |  |
| `Auth` | Planned: SAM-04 |  |
| `BinaryMediaTypes` | Implemented |  |
| `CacheClusterEnabled` | Implemented |  |
| `CacheClusterSize` | Implemented |  |
| `CanarySetting` | Not supported (non-goal) |  |
| `Cors` | Planned: SAM-04 |  |
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
| `Models` | Planned: SAM-04 |  |
| `Name` | Implemented |  |
| `OpenApiVersion` | Implemented |  |
| `Policy` | Planned: SAM-04 |  |
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
| `Auth` | Planned: SAM-04 |  |
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

## Globals

A Globals key has the status of the same property on its resource type.

| Section | Status |
|---|---|
| `Api` | Implemented |
| `CapacityProvider` | Not supported (non-goal) |
| `Function` | Implemented |
| `HttpApi` | Implemented |
| `LayerVersion` | Planned: SAM-04 |
| `MicrovmImage` | Not supported (non-goal) |
| `NetworkConnector` | Not supported (non-goal) |
| `SimpleTable` | Implemented |
| `StateMachine` | Planned: SAM-04 |
| `WebSocketApi` | Not supported (non-goal) |
