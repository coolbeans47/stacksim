/**
 * The single machine-readable SAM coverage table (sam-transform-design.md §5).
 * Every resource type, event type, property, and Globals key in the pinned SAM
 * schema is implemented, owned by a later phase, or a non-goal. A test checks
 * this table against src/cloudformation/sam/generated/schema.ts, and
 * docs/sam-coverage.md is generated from it.
 */

export type SamPhase = "SAM-02" | "SAM-03" | "SAM-04" | "SAM-05" | "SAM-06";
/** "implemented", the later phase that owns it, or "non-goal". */
export type Coverage = "implemented" | Exclude<SamPhase, "SAM-02"> | "non-goal";
export type CoverageTable = Readonly<Record<string, Coverage>>;

export interface EventCoverage {
  readonly event: Coverage;
  /** Per-property coverage; omitted when every property shares the event's coverage. */
  readonly properties?: CoverageTable;
  /** Properties SAM's translator accepts for this event type although its schema does not list them. */
  readonly extraProperties?: CoverageTable;
  /** A short note shown in docs/sam-coverage.md. */
  readonly note?: string;
}

export interface ResourceCoverage {
  readonly resource: Coverage;
  /** Per-property coverage; omitted when every property shares the resource's coverage. */
  readonly properties?: CoverageTable;
  readonly events?: Readonly<Record<string, EventCoverage>>;
  /** Short reasons shown in docs/sam-coverage.md for notable rows. */
  readonly notes?: Readonly<Record<string, string>>;
}

const states = (coverage: Coverage, names: readonly string[]): Record<string, Coverage> => Object.fromEntries(names.map(name => [name, coverage]));

/** Properties SAM's PullEventSource accepts for every pull event; SQS and DynamoDB events take only some of them. */
const PULL_ONLY_PROPERTIES = [
  "BatchSize", "BisectBatchOnFunctionError", "ConsumerGroupId", "DestinationConfig", "Enabled", "FilterCriteria", "FunctionResponseTypes", "KafkaBootstrapServers",
  "KmsKeyArn", "LoggingConfig", "MaximumBatchingWindowInSeconds", "MaximumRecordAgeInSeconds", "MaximumRetryAttempts", "MetricsConfig", "ParallelizationFactor",
  "ProvisionedPollerConfig", "Queues", "ScalingConfig", "SchemaRegistryConfig", "SecretsManagerKmsKeyId", "SourceAccessConfigurations", "StartingPosition",
  "StartingPositionTimestamp", "Topics", "TumblingWindowInSeconds",
];
const SQS_EVENT_PROPERTIES = ["BatchSize", "Enabled", "FilterCriteria", "FunctionResponseTypes", "KmsKeyArn", "MaximumBatchingWindowInSeconds", "MetricsConfig", "ScalingConfig"];
const DYNAMODB_EVENT_PROPERTIES = [
  "BatchSize", "BisectBatchOnFunctionError", "DestinationConfig", "Enabled", "FilterCriteria", "FunctionResponseTypes", "KmsKeyArn", "MaximumBatchingWindowInSeconds",
  "MaximumRecordAgeInSeconds", "MaximumRetryAttempts", "MetricsConfig", "ParallelizationFactor", "StartingPosition", "StartingPositionTimestamp", "TumblingWindowInSeconds",
];

export const SAM_RESOURCE_COVERAGE: Readonly<Record<string, ResourceCoverage>> = {
  "AWS::Serverless::Function": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "Architectures", "AssumeRolePolicyDocument", "AutoPublishAlias", "AutoPublishAliasAllProperties", "AutoPublishCodeSha256", "CodeSigningConfigArn", "CodeUri",
        "DeadLetterQueue", "Description", "Environment", "EphemeralStorage", "EventInvokeConfig", "Events", "FunctionName", "FunctionUrlConfig", "Handler", "InlineCode",
        "Layers", "LoggingConfig", "MemorySize", "PackageType", "PermissionsBoundary", "Policies", "PropagateTags", "ProvisionedConcurrencyConfig",
        "ReservedConcurrentExecutions", "Role", "RolePath", "Runtime", "Tags", "Timeout", "Tracing", "VersionDeletionPolicy", "VersionDescription",
      ]),
      ...states("non-goal", [
        "CapacityProviderConfig", "DeploymentPreference", "DurableConfig", "FileSystemConfigs", "FunctionScalingConfig", "ImageConfig", "ImageUri", "KmsKeyArn",
        "PublishToLatestPublished", "RecursiveLoop", "RuntimeManagementConfig", "SnapStart", "SourceKMSKeyArn", "TenancyConfig", "VpcConfig",
      ]),
    },
    events: {
      Api: {
        event: "implemented",
        properties: { ...states("implemented", ["Auth", "Method", "Path", "RequestModel", "RequestParameters", "RestApiId", "TimeoutInMillis"]), ResponseTransferMode: "non-goal" },
        note: "With `AWS_IAM` auth and no `InvokeRole` (or `CALLER_CREDENTIALS`), API Gateway calls the function with the SigV4 caller's credentials, as on AWS.",
      },
      HttpApi: {
        event: "implemented",
        properties: states("implemented", ["ApiId", "Auth", "Method", "Path", "PayloadFormatVersion", "RouteSettings", "TimeoutInMillis"]),
      },
      CloudWatchEvent: {
        event: "implemented",
        properties: states("implemented", ["Enabled", "EventBusName", "Input", "InputPath", "Pattern", "State"]),
        extraProperties: states("implemented", ["DeadLetterConfig", "InputTransformer", "RetryPolicy", "RuleName", "Target"]),
      },
      CloudWatchLogs: { event: "implemented", properties: states("implemented", ["FilterPattern", "LogGroupName"]) },
      DynamoDB: {
        event: "implemented",
        properties: {
          ...states("implemented", [
            "BatchSize", "BisectBatchOnFunctionError", "DestinationConfig", "Enabled", "FilterCriteria", "FunctionResponseTypes", "MaximumBatchingWindowInSeconds",
            "MaximumRecordAgeInSeconds", "MaximumRetryAttempts", "ParallelizationFactor", "StartingPosition", "Stream", "TumblingWindowInSeconds",
          ]),
          ...states("non-goal", ["KmsKeyArn", "MetricsConfig", "StartingPositionTimestamp"]),
        },
        extraProperties: states("non-goal", PULL_ONLY_PROPERTIES.filter(name => !DYNAMODB_EVENT_PROPERTIES.includes(name))),
        note: "`KmsKeyArn` needs KMS. DynamoDB Streams have no `AT_TIMESTAMP` starting position.",
      },
      EventBridgeRule: {
        event: "implemented",
        properties: states("implemented", ["DeadLetterConfig", "EventBusName", "Input", "InputPath", "InputTransformer", "Pattern", "RetryPolicy", "RuleName", "Target"]),
        extraProperties: states("implemented", ["Enabled", "State"]),
      },
      S3: { event: "implemented", properties: states("implemented", ["Bucket", "Events", "Filter"]), note: "The bucket must be declared in the same template, as SAM requires." },
      SNS: {
        event: "implemented",
        properties: states("implemented", ["FilterPolicy", "FilterPolicyScope", "Region", "SqsSubscription", "Topic"]),
        extraProperties: { RedrivePolicy: "implemented" },
      },
      SQS: {
        event: "implemented",
        properties: {
          ...states("implemented", ["BatchSize", "Enabled", "FilterCriteria", "FunctionResponseTypes", "MaximumBatchingWindowInSeconds", "Queue", "ScalingConfig"]),
          ...states("non-goal", ["KmsKeyArn", "MetricsConfig"]),
        },
        extraProperties: states("non-goal", PULL_ONLY_PROPERTIES.filter(name => !SQS_EVENT_PROPERTIES.includes(name))),
        note: "`KmsKeyArn` needs KMS.",
      },
      Schedule: {
        event: "implemented",
        properties: states("implemented", ["DeadLetterConfig", "Description", "Enabled", "Input", "Name", "RetryPolicy", "Schedule", "State"]),
        extraProperties: { RuleName: "implemented" },
        note: "As in SAM, `RuleName` is accepted and ignored on Schedule events; `Name` names the rule.",
      },
      ...Object.fromEntries(["AlexaSkill", "Cognito", "DocumentDB", "IoTRule", "Kinesis", "MQ", "MSK", "ScheduleV2", "SelfManagedKafka"].map(type => [type, { event: "non-goal" as const }])),
    },
    notes: {
      PackageType: "`Zip` only; `Image` needs ECR and a container image runtime.",
      DeploymentPreference: "Needs a CodeDeploy service.",
      VpcConfig: "StackSim has no VPC model.",
      Role: "A string or intrinsic role ARN; an `Fn::If` that selects the generated role is not supported.",
      EventInvokeConfig: "SQS, SNS, Lambda, and EventBridge destinations; `Type: S3Bucket` is not supported (Lambda S3 async destinations are not available locally).",
    },
  },
  "AWS::Serverless::Api": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "AccessLogSetting", "AlwaysDeploy", "ApiKeySourceType", "Auth", "BinaryMediaTypes", "CacheClusterEnabled", "CacheClusterSize", "Cors", "DefinitionBody",
        "DefinitionUri", "Description", "EndpointConfiguration", "GatewayResponses", "MethodSettings", "MinimumCompressionSize", "Models", "Name", "OpenApiVersion",
        "Policy", "PropagateTags", "StageName", "Tags", "TracingEnabled", "Variables",
      ]),
      ...states("non-goal", ["CanarySetting", "DisableExecuteApiEndpoint", "Domain", "EndpointAccessMode", "FailOnWarnings", "MergeDefinitions", "Mode", "SecurityPolicy"]),
    },
    notes: { Domain: "Needs ACM and Route 53 semantics StackSim does not model." },
  },
  "AWS::Serverless::HttpApi": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "AccessLogSettings", "CorsConfiguration", "DefaultRouteSettings", "DefinitionBody", "DefinitionUri", "Description", "DisableExecuteApiEndpoint",
        "FailOnWarnings", "Name", "PropagateTags", "RouteSettings", "StageName", "StageVariables", "Tags", "Auth",
      ]),
      Domain: "non-goal",
    },
  },
  "AWS::Serverless::SimpleTable": {
    resource: "implemented",
    properties: states("implemented", ["PointInTimeRecoverySpecification", "PrimaryKey", "ProvisionedThroughput", "SSESpecification", "TableName", "Tags"]),
    notes: { SSESpecification: "SSE with the DynamoDB-owned key only; KMS keys need KMS." },
  },
  "AWS::Serverless::LayerVersion": {
    resource: "implemented",
    properties: states("implemented", ["CompatibleArchitectures", "CompatibleRuntimes", "ContentUri", "Description", "LayerName", "LicenseInfo", "PublishLambdaVersion", "RetentionPolicy"]),
  },
  "AWS::Serverless::StateMachine": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "Definition", "DefinitionSubstitutions", "DefinitionUri", "Events", "Logging", "Name", "PermissionsBoundary", "Policies", "PropagateTags", "Role", "RolePath", "Tags",
        "Tracing", "Type",
      ]),
      ...states("non-goal", ["AutoPublishAlias", "DeploymentPreference", "UseAliasAsEventTarget"]),
    },
    events: {
      Api: { event: "implemented", properties: states("implemented", ["Auth", "Method", "Path", "RestApiId", "UnescapeMappingTemplate"]) },
      CloudWatchEvent: {
        event: "implemented",
        properties: states("implemented", ["EventBusName", "Input", "InputPath", "Pattern"]),
        extraProperties: states("implemented", ["DeadLetterConfig", "InputTransformer", "RetryPolicy", "RuleName", "State", "Target"]),
      },
      EventBridgeRule: {
        event: "implemented",
        properties: states("implemented", ["DeadLetterConfig", "EventBusName", "Input", "InputPath", "InputTransformer", "Pattern", "RetryPolicy", "RuleName", "Target"]),
        extraProperties: { State: "implemented" },
      },
      Schedule: {
        event: "implemented",
        properties: states("implemented", ["DeadLetterConfig", "Description", "Enabled", "Input", "Name", "RetryPolicy", "RoleArn", "Schedule", "State", "Target"]),
      },
      ScheduleV2: { event: "non-goal" },
    },
    notes: {
      Type: "`STANDARD` only; `EXPRESS` fails because StackSim's Step Functions runs STANDARD state machines only.",
      Logging: "Expanded exactly. StackSim's Step Functions accepts only `Level: OFF` until execution logging exists, so other levels fail when the stack deploys.",
      Tracing: "Expanded exactly, with SAM's X-Ray policy. StackSim's Step Functions does not trace, so `Enabled: true` fails when the stack deploys.",
      AutoPublishAlias: "Needs Step Functions versions and aliases, which StackSim does not model.",
      DeploymentPreference: "Needs Step Functions versions and aliases, which StackSim does not model.",
      UseAliasAsEventTarget: "Needs Step Functions versions and aliases, which StackSim does not model.",
    },
  },
  "AWS::Serverless::Connector": {
    resource: "implemented",
    properties: states("implemented", ["Destination", "Permissions", "Source"]),
    notes: {
      Source: "Every source/destination pair StackSim can back is implemented; see [Connector pairs](#connector-pairs). The others fail explicitly.",
    },
  },
  ...Object.fromEntries([
    "AWS::Serverless::Application", "AWS::Serverless::CapacityProvider", "AWS::Serverless::GraphQLApi", "AWS::Serverless::MicrovmImage",
    "AWS::Serverless::NetworkConnector", "AWS::Serverless::WebFunction", "AWS::Serverless::WebSocketApi",
  ].map(type => [type, { resource: "non-goal" as const }])),
};

/** Globals sections map to resource types; their keys share the resource property coverage. */
export const SAM_GLOBALS_SECTIONS: Readonly<Record<string, string>> = {
  Api: "AWS::Serverless::Api",
  CapacityProvider: "AWS::Serverless::CapacityProvider",
  Function: "AWS::Serverless::Function",
  HttpApi: "AWS::Serverless::HttpApi",
  LayerVersion: "AWS::Serverless::LayerVersion",
  MicrovmImage: "AWS::Serverless::MicrovmImage",
  NetworkConnector: "AWS::Serverless::NetworkConnector",
  SimpleTable: "AWS::Serverless::SimpleTable",
  StateMachine: "AWS::Serverless::StateMachine",
  WebSocketApi: "AWS::Serverless::WebSocketApi",
};

/** Resource attributes on AWS::Serverless resources. */
export const SAM_RESOURCE_ATTRIBUTE_COVERAGE: CoverageTable = {
  Condition: "implemented",
  DeletionPolicy: "implemented",
  DependsOn: "implemented",
  IgnoreGlobals: "implemented",
  Metadata: "implemented",
  UpdateReplacePolicy: "implemented",
  Connectors: "implemented",
};

export interface ConnectorPairCoverage {
  readonly coverage: Exclude<Coverage, Exclude<SamPhase, "SAM-02">>;
  /** Why StackSim cannot back the pair, or what to know about it locally. */
  readonly note?: string;
}

const NO_EVENT_BUS_TARGETS = "EventBridge in StackSim cannot deliver to an event bus target";
const APPSYNC_DATA_SOURCES = "AppSync in StackSim supports only NONE and AMAZON_DYNAMODB data sources";

/**
 * Every source/destination pair in SAM's connector profiles. A pair is
 * implemented when both services exist locally, its generated policy deploys
 * through StackSim's providers, and the service path that uses it enforces it.
 */
export const SAM_CONNECTOR_PAIR_COVERAGE: Readonly<Record<string, Readonly<Record<string, ConnectorPairCoverage>>>> = {
  "AWS::DynamoDB::Table": {
    "AWS::Lambda::Function": { coverage: "implemented", note: "A managed policy on the function's role; the stream event source mapping checks it." },
  },
  "AWS::Events::Rule": {
    "AWS::SNS::Topic": { coverage: "implemented", note: "A topic policy for `events.amazonaws.com`; EventBridge's delivery checks it." },
    "AWS::Events::EventBus": { coverage: "non-goal", note: NO_EVENT_BUS_TARGETS },
    "AWS::StepFunctions::StateMachine": { coverage: "implemented", note: "A managed policy on the rule target's role; EventBridge's StartExecution checks it." },
    "AWS::Lambda::Function": { coverage: "implemented", note: "A Lambda permission for `events.amazonaws.com`." },
    "AWS::SQS::Queue": { coverage: "implemented", note: "A queue policy for `events.amazonaws.com`; EventBridge's delivery checks it." },
  },
  "AWS::Lambda::Function": {
    "AWS::Lambda::Function": { coverage: "implemented" },
    "AWS::S3::Bucket": { coverage: "implemented" },
    "AWS::DynamoDB::Table": { coverage: "implemented" },
    "AWS::SQS::Queue": { coverage: "implemented" },
    "AWS::SNS::Topic": { coverage: "implemented" },
    "AWS::StepFunctions::StateMachine": { coverage: "implemented" },
    "AWS::Events::EventBus": { coverage: "implemented" },
    "AWS::Location::PlaceIndex": { coverage: "non-goal", note: "StackSim has no Amazon Location Service" },
  },
  "AWS::ApiGatewayV2::Api": {
    "AWS::Lambda::Function": { coverage: "implemented", note: "A Lambda permission for `apigateway.amazonaws.com`." },
  },
  "AWS::ApiGateway::RestApi": {
    "AWS::Lambda::Function": { coverage: "implemented", note: "A Lambda permission for `apigateway.amazonaws.com`." },
  },
  "AWS::SNS::Topic": {
    "AWS::SQS::Queue": { coverage: "implemented", note: "A queue policy for `sns.amazonaws.com`." },
    "AWS::Lambda::Function": { coverage: "implemented", note: "A Lambda permission for `sns.amazonaws.com`." },
  },
  "AWS::SQS::Queue": {
    "AWS::Lambda::Function": { coverage: "implemented", note: "A managed policy on the function's role; the event source mapping checks it." },
  },
  "AWS::S3::Bucket": {
    "AWS::Lambda::Function": { coverage: "implemented", note: "A Lambda permission for `s3.amazonaws.com`." },
  },
  "AWS::StepFunctions::StateMachine": {
    "AWS::Lambda::Function": { coverage: "implemented" },
    "AWS::SNS::Topic": { coverage: "implemented" },
    "AWS::SQS::Queue": { coverage: "implemented" },
    "AWS::S3::Bucket": { coverage: "implemented", note: "The policy is enforced for the role, but StackSim's Step Functions has no S3 task integration." },
    "AWS::DynamoDB::Table": { coverage: "implemented" },
    "AWS::StepFunctions::StateMachine": { coverage: "implemented" },
    "AWS::Events::EventBus": { coverage: "implemented" },
  },
  "AWS::AppSync::DataSource": {
    "AWS::DynamoDB::Table": { coverage: "implemented", note: "A managed policy on the data source's service role; AppSync's DynamoDB resolvers check it." },
    "AWS::Lambda::Function": { coverage: "non-goal", note: APPSYNC_DATA_SOURCES },
    "AWS::Events::EventBus": { coverage: "non-goal", note: APPSYNC_DATA_SOURCES },
  },
  "AWS::AppSync::GraphQLApi": {
    "AWS::Lambda::Function": { coverage: "non-goal", note: "AppSync in StackSim does not invoke Lambda functions, and AWS::Lambda::Permission does not accept the `appsync.amazonaws.com` principal" },
  },
};

/** Why a connector pair fails in StackSim, or undefined when it is implemented. */
export function connectorPairCoverage(source: string, destination: string): string | undefined {
  const pair = SAM_CONNECTOR_PAIR_COVERAGE[source]?.[destination];
  if (pair?.coverage === "implemented") return undefined;
  return `Connector from ${source} to ${destination} is not supported by StackSim${pair?.note ? `: ${pair.note}` : ""}.`;
}

export function resourceCoverage(type: string): Coverage | undefined {
  return SAM_RESOURCE_COVERAGE[type]?.resource;
}

export function propertyCoverage(type: string, property: string): Coverage | undefined {
  const entry = SAM_RESOURCE_COVERAGE[type];
  if (!entry) return undefined;
  return entry.properties ? entry.properties[property] : entry.resource;
}

export function eventCoverage(type: string, eventType: string): EventCoverage | undefined {
  return SAM_RESOURCE_COVERAGE[type]?.events?.[eventType];
}

/** "<subject> is not supported by StackSim (owning phase: SAM-0N)." or the non-goal form. */
export function unsupported(subject: string, coverage: Coverage): string {
  return `${subject} is not supported by StackSim${coverage === "non-goal" || coverage === "implemented" ? "" : ` (owning phase: ${coverage})`}.`;
}
