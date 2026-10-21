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

export const SAM_RESOURCE_COVERAGE: Readonly<Record<string, ResourceCoverage>> = {
  "AWS::Serverless::Function": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "Architectures", "AssumeRolePolicyDocument", "CodeSigningConfigArn", "CodeUri", "DeadLetterQueue", "Description", "Environment", "EphemeralStorage",
        "Events", "FunctionName", "Handler", "InlineCode", "LoggingConfig", "MemorySize", "PackageType", "PermissionsBoundary", "Policies", "PropagateTags",
        "ReservedConcurrentExecutions", "Role", "RolePath", "Runtime", "Tags", "Timeout", "Tracing",
      ]),
      ...states("SAM-03", ["EventInvokeConfig", "FunctionUrlConfig"]),
      ...states("SAM-04", ["AutoPublishAlias", "AutoPublishAliasAllProperties", "AutoPublishCodeSha256", "Layers", "ProvisionedConcurrencyConfig", "VersionDeletionPolicy", "VersionDescription"]),
      ...states("non-goal", [
        "CapacityProviderConfig", "DeploymentPreference", "DurableConfig", "FileSystemConfigs", "FunctionScalingConfig", "ImageConfig", "ImageUri", "KmsKeyArn",
        "PublishToLatestPublished", "RecursiveLoop", "RuntimeManagementConfig", "SnapStart", "SourceKMSKeyArn", "TenancyConfig", "VpcConfig",
      ]),
    },
    events: {
      Api: {
        event: "implemented",
        properties: { ...states("implemented", ["Method", "Path", "RestApiId", "TimeoutInMillis"]), ...states("SAM-04", ["Auth", "RequestModel", "RequestParameters"]), ResponseTransferMode: "non-goal" },
      },
      HttpApi: {
        event: "implemented",
        properties: { ...states("implemented", ["ApiId", "Method", "Path", "PayloadFormatVersion", "RouteSettings", "TimeoutInMillis"]), Auth: "SAM-04" },
      },
      ...Object.fromEntries(["CloudWatchEvent", "CloudWatchLogs", "DynamoDB", "EventBridgeRule", "S3", "SNS", "SQS", "Schedule"].map(type => [type, { event: "SAM-03" as const }])),
      ...Object.fromEntries(["AlexaSkill", "Cognito", "DocumentDB", "IoTRule", "Kinesis", "MQ", "MSK", "ScheduleV2", "SelfManagedKafka"].map(type => [type, { event: "non-goal" as const }])),
    },
    notes: {
      PackageType: "`Zip` only; `Image` needs ECR and a container image runtime.",
      DeploymentPreference: "Needs a CodeDeploy service.",
      VpcConfig: "StackSim has no VPC model.",
      Role: "A string or intrinsic role ARN; an `Fn::If` that selects the generated role is not supported.",
    },
  },
  "AWS::Serverless::Api": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "AccessLogSetting", "AlwaysDeploy", "BinaryMediaTypes", "CacheClusterEnabled", "CacheClusterSize", "DefinitionBody", "DefinitionUri", "Description",
        "EndpointConfiguration", "GatewayResponses", "MethodSettings", "MinimumCompressionSize", "Name", "OpenApiVersion", "PropagateTags", "StageName", "Tags",
        "TracingEnabled", "Variables",
      ]),
      ...states("SAM-04", ["ApiKeySourceType", "Auth", "Cors", "Models", "Policy"]),
      ...states("non-goal", ["CanarySetting", "DisableExecuteApiEndpoint", "Domain", "EndpointAccessMode", "FailOnWarnings", "MergeDefinitions", "Mode", "SecurityPolicy"]),
    },
    notes: { Domain: "Needs ACM and Route 53 semantics StackSim does not model." },
  },
  "AWS::Serverless::HttpApi": {
    resource: "implemented",
    properties: {
      ...states("implemented", [
        "AccessLogSettings", "CorsConfiguration", "DefaultRouteSettings", "DefinitionBody", "DefinitionUri", "Description", "DisableExecuteApiEndpoint",
        "FailOnWarnings", "Name", "PropagateTags", "RouteSettings", "StageName", "StageVariables", "Tags",
      ]),
      Auth: "SAM-04",
      Domain: "non-goal",
    },
  },
  "AWS::Serverless::SimpleTable": {
    resource: "implemented",
    properties: states("implemented", ["PointInTimeRecoverySpecification", "PrimaryKey", "ProvisionedThroughput", "SSESpecification", "TableName", "Tags"]),
    notes: { SSESpecification: "SSE with the DynamoDB-owned key only; KMS keys need KMS." },
  },
  "AWS::Serverless::LayerVersion": { resource: "SAM-04" },
  "AWS::Serverless::StateMachine": {
    resource: "SAM-04",
    events: {
      ...Object.fromEntries(["Api", "EventBridgeRule", "Schedule"].map(type => [type, { event: "SAM-04" as const }])),
      ...Object.fromEntries(["CloudWatchEvent", "ScheduleV2"].map(type => [type, { event: "non-goal" as const }])),
    },
  },
  "AWS::Serverless::Connector": { resource: "SAM-06" },
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
  Connectors: "SAM-06",
};

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
