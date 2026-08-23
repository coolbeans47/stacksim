export type AttributeValue =
  | { S: string }
  | { N: string }
  | { B: string }
  | { BOOL: boolean }
  | { NULL: boolean }
  | { L: AttributeValue[] }
  | { M: Item }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] };

export type Item = Record<string, AttributeValue>;

export interface DynamoProvisionedThroughputState {
  ReadCapacityUnits: number;
  WriteCapacityUnits: number;
  lastIncreaseAt?: number;
  lastDecreaseAt?: number;
  decreasesToday?: number;
  decreaseDay?: string;
}

export interface DynamoOnDemandThroughputState {
  MaxReadRequestUnits?: number;
  MaxWriteRequestUnits?: number;
}

export interface DynamoWarmThroughputState {
  ReadUnitsPerSecond: number;
  WriteUnitsPerSecond: number;
  status: "CREATING" | "UPDATING" | "ACTIVE";
  lastUpdatedAt: number;
}

export interface DynamoAutoScalingSettingState {
  autoScalingDisabled: boolean;
  autoScalingRoleArn?: string;
  maximumUnits: number;
  minimumUnits: number;
  scalingPolicy?: {
    policyName?: string;
    disableScaleIn: boolean;
    scaleInCooldown: number;
    scaleOutCooldown: number;
    targetValue: number;
  };
}

export interface DynamoAutoScalingState {
  provisionedWrite?: DynamoAutoScalingSettingState;
  globalSecondaryIndexes?: Record<string, { provisionedWrite?: DynamoAutoScalingSettingState }>;
  replicas?: Record<string, {
    provisionedRead?: DynamoAutoScalingSettingState;
    globalSecondaryIndexes?: Record<string, { provisionedRead?: DynamoAutoScalingSettingState }>;
  }>;
  lastUpdatedAt?: number;
}

export interface DynamoPointInTimeRecoveryState {
  status: "ENABLED" | "DISABLED";
  recoveryPeriodInDays: number;
  enabledAt?: number;
  earliestRestorableAt?: number;
  sequence: number;
}

export interface DynamoBackupState {
  backupArn: string;
  backupName: string;
  backupType: "USER";
  backupStatus: "CREATING" | "AVAILABLE";
  createdAt: number;
  sizeBytes: number;
  sourceTableArn: string;
  sourceTableId: string;
  sourceTableName: string;
  snapshotHash: string;
}

export type DynamoTransferDestinationKind = "s3" | "file";

export type DynamoExportStage =
  | "ADMITTED"
  | "SNAPSHOT"
  | "DATA_OBJECTS"
  | "MANIFEST"
  | "COMPLETED"
  | "FAILED";

export type DynamoImportStage =
  | "ADMITTED"
  | "MANIFEST"
  | "TABLE"
  | "POPULATE"
  | "VALIDATE"
  | "PROMOTE"
  | "COMPLETED"
  | "FAILED";

export interface DynamoPinnedS3ObjectState {
  bucket: string;
  key: string;
  generation: string;
  versionId: string;
  etag: string;
  size: number;
  storageClass: string;
  checksumMd5?: string;
  manifestItemCount?: number;
  completed?: boolean;
}

export interface DynamoExportState {
  exportArn: string;
  exportStatus: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  startTime: number;
  endTime?: number;
  exportManifest: string;
  tableArn: string;
  tableId: string;
  exportTime: number;
  clientToken: string;
  requestHash: string;
  s3Bucket: string;
  s3BucketOwner?: string;
  s3Prefix?: string;
  s3SseAlgorithm: "AES256";
  exportFormat: "DYNAMODB_JSON";
  billedSizeBytes: number;
  itemCount: number;
  exportType: "FULL_EXPORT";
  failureCode?: string;
  failureMessage?: string;
  /** DUG-12 durable transfer metadata. Absent on pre-migration jobs. */
  destinationKind?: DynamoTransferDestinationKind;
  stage?: DynamoExportStage;
  keyPrefix?: string;
  dataKey?: string;
  manifestFilesKey?: string;
  dataObject?: DynamoPinnedS3ObjectState;
  /** Opaque identifier for the private streaming export snapshot. */
  snapshotId?: string;
  snapshotMd5?: string;
}

export interface DynamoImportState {
  importArn: string;
  importStatus: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  tableArn: string;
  tableId: string;
  clientToken: string;
  requestHash: string;
  s3BucketSource: { S3Bucket: string; S3BucketOwner?: string; S3KeyPrefix?: string };
  inputFormat: "DYNAMODB_JSON";
  inputCompressionType: "NONE" | "GZIP";
  tableCreationParameters: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  processedSizeBytes: number;
  processedItemCount: number;
  importedItemCount: number;
  errorCount: number;
  failureCode?: string;
  failureMessage?: string;
  /** DUG-12 durable transfer metadata. Absent on pre-migration jobs. */
  destinationKind?: DynamoTransferDestinationKind;
  stage?: DynamoImportStage;
  pinnedObjects?: DynamoPinnedS3ObjectState[];
}

export type DynamoContributorInsightsMode = "ACCESSED_AND_THROTTLED_KEYS" | "THROTTLED_KEYS";

export interface DynamoContributorInsightsState {
  status: "ENABLING" | "ENABLED" | "DISABLING" | "DISABLED" | "FAILED";
  mode: DynamoContributorInsightsMode;
  lastUpdatedAt: number;
  ruleCreatedAt: number;
}

export interface DynamoKinesisStreamingDestinationState {
  streamArn: string;
  status: "ENABLING" | "ACTIVE" | "DISABLING" | "DISABLED" | "ENABLE_FAILED" | "UPDATING";
  precision: "MILLISECOND" | "MICROSECOND";
  lastUpdatedAt: number;
  statusDescription?: string;
}

export type DynamoStreamViewType = "KEYS_ONLY" | "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES";

export interface DynamoStreamDescriptorState {
  streamArn: string;
  streamLabel: string;
  tableName: string;
  tableArn: string;
  keySchema: Array<{ AttributeName: string; KeyType: "HASH" | "RANGE" }>;
  streamViewType: DynamoStreamViewType;
  streamStatus: "ENABLING" | "ENABLED" | "DISABLING" | "DISABLED";
  createdAt: number;
  disabledAt?: number;
  shardId: string;
  startingSequenceNumber: string;
  lastSequenceNumber?: string;
  endingSequenceNumber?: string;
  trimmedThroughSequence?: string;
  legacyRecords?: DynamoStreamRecordState[];
}

export interface DynamoResourcePolicyState {
  resourceArn: string;
  policy: string;
  revisionId: string;
  updatedAt: number;
}

export interface DynamoGlobalTableItemVersionState {
  updatedAt: number;
  regionName: string;
  sourceSequence: number;
  deleted?: boolean;
}

export interface DynamoGlobalTableReplicaState {
  version: "2017.11.29" | "2019.11.21";
  createdAt: number;
  status: "CREATING" | "UPDATING" | "ACTIVE";
  replicaRegions: string[];
  changeSequence: number;
  sourceSequence: number;
  itemVersions: Record<string, DynamoGlobalTableItemVersionState>;
  lastReplicationError?: string;
}

export interface DynamoGlobalTableChangeState {
  ordinal: number;
  tableName: string;
  sourceRegion: string;
  sourceSequence: number;
  updatedAt: number;
  key: string;
  item?: Item;
}

export interface DynamoIndexState {
  indexName: string;
  keySchema: Array<{ AttributeName: string; KeyType: "HASH" | "RANGE" }>;
  projection: { ProjectionType: "KEYS_ONLY" | "INCLUDE" | "ALL"; NonKeyAttributes?: string[] };
  provisionedThroughput?: DynamoProvisionedThroughputState;
  onDemandThroughput?: DynamoOnDemandThroughputState;
  warmThroughput?: DynamoWarmThroughputState;
  indexStatus?: "CREATING" | "UPDATING" | "DELETING" | "ACTIVE";
  backfilling?: boolean;
}

export interface TableState {
  name: string;
  arn: string;
  id: string;
  status: string;
  createdAt: number;
  keySchema: Array<{ AttributeName: string; KeyType: "HASH" | "RANGE" }>;
  attributeDefinitions: Array<{ AttributeName: string; AttributeType: string }>;
  billingMode: string;
  provisionedThroughput?: DynamoProvisionedThroughputState;
  onDemandThroughput?: DynamoOnDemandThroughputState;
  warmThroughput?: DynamoWarmThroughputState;
  billingModeLastUpdatedAt?: number;
  tableClass: "STANDARD" | "STANDARD_INFREQUENT_ACCESS";
  tableClassLastUpdatedAt?: number;
  deletionProtectionEnabled: boolean;
  tags: Record<string, string>;
  sse: { sseType: "AES256" | "KMS"; status: "ENABLED" | "UPDATING"; kmsMasterKeyId?: string; lastUpdatedAt?: number };
  autoScaling?: DynamoAutoScalingState;
  pointInTimeRecovery: DynamoPointInTimeRecoveryState;
  restoreSummary?: { restoreDateTime: number; sourceBackupArn?: string; sourceTableArn?: string; restoreInProgress: boolean };
  localSecondaryIndexes?: DynamoIndexState[];
  globalSecondaryIndexes?: DynamoIndexState[];
  timeToLive: {
    attributeName?: string;
    status: "ENABLING" | "DISABLING" | "ENABLED" | "DISABLED";
    lastUpdatedAt?: number;
  };
  streamSpecification?: { StreamEnabled: boolean; StreamViewType?: DynamoStreamViewType };
  latestStreamArn?: string;
  streamSequence?: number;
  globalTable?: DynamoGlobalTableReplicaState;
  contributorInsights: Record<string, DynamoContributorInsightsState>;
  kinesisStreamingDestinations: Record<string, DynamoKinesisStreamingDestinationState>;
  items: Record<string, Item>;
}

export interface DynamoStreamRecordState {
  eventID: string;
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  eventVersion: "1.1";
  eventSource: "aws:dynamodb";
  awsRegion: string;
  eventSourceARN: string;
  dynamodb: {
    ApproximateCreationDateTime: number;
    Keys: Item;
    OldImage?: Item;
    NewImage?: Item;
    SequenceNumber: string;
    SizeBytes: number;
    StreamViewType: DynamoStreamViewType;
  };
  userIdentity?: { type: "Service"; principalId: "dynamodb.amazonaws.com" };
}

export type LambdaArchitecture = "x86_64" | "arm64";
export type LambdaPackageType = "Zip" | "Image";
export type LambdaTracingMode = "Active" | "PassThrough";
export type LambdaRuntimeUpdateMode = "Auto" | "FunctionUpdate" | "Manual";
export type LambdaRecursiveLoop = "Allow" | "Terminate";

export interface LambdaLoggingConfigState {
  logFormat: "JSON" | "Text";
  applicationLogLevel?: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
  systemLogLevel?: "DEBUG" | "INFO" | "WARN";
  logGroup: string;
}

export interface LambdaFileSystemConfigState {
  arn: string;
  localMountPath: string;
}

export interface LambdaVpcConfigState {
  subnetIds: string[];
  securityGroupIds: string[];
  ipv6AllowedForDualStack: boolean;
}

export interface LambdaRuntimeManagementConfigState {
  updateRuntimeOn: LambdaRuntimeUpdateMode;
  runtimeVersionArn?: string;
}

export interface LambdaImageConfigState {
  entryPoint?: string[];
  command?: string[];
  workingDirectory?: string;
}

export interface LambdaManagedInstancesCapacityProviderConfigState {
  capacityProviderArn: string;
  executionEnvironmentMemoryGiBPerVCpu?: number;
  perExecutionEnvironmentMaxConcurrency?: number;
}

export interface LambdaFunctionScalingConfigState {
  qualifier: string;
  minExecutionEnvironments?: number;
  maxExecutionEnvironments?: number;
}

export interface LambdaDurableConfigState {
  executionTimeout: number;
  retentionPeriodInDays: number;
  kmsKeyArn?: string;
}

export interface LambdaDurableErrorState {
  ErrorMessage?: string;
  ErrorType?: string;
  ErrorData?: string;
  StackTrace?: string[];
}

export interface LambdaDurableOperationState {
  id: string;
  parentId?: string;
  name?: string;
  type: "EXECUTION" | "CONTEXT" | "STEP" | "WAIT" | "CALLBACK" | "CHAINED_INVOKE";
  subType?: string;
  startTimestamp: number;
  endTimestamp?: number;
  status: "STARTED" | "PENDING" | "READY" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "STOPPED";
  sequence: number;
  executionDetails?: { inputPayload?: string };
  contextDetails?: { replayChildren?: boolean; result?: string; error?: LambdaDurableErrorState };
  stepDetails?: { attempt?: number; nextAttemptTimestamp?: number; result?: string; error?: LambdaDurableErrorState };
  waitDetails?: { scheduledEndTimestamp?: number; duration?: number };
  callbackDetails?: { callbackId?: string; result?: string; error?: LambdaDurableErrorState; timeoutAt?: number; heartbeatTimeoutSeconds?: number; heartbeatDeadline?: number };
  chainedInvokeDetails?: { result?: string; error?: LambdaDurableErrorState; functionName?: string; tenantId?: string };
}

export interface LambdaDurableHistoryEventState {
  eventId: number;
  eventType: string;
  eventTimestamp: number;
  id?: string;
  parentId?: string;
  name?: string;
  subType?: string;
  details?: Record<string, unknown>;
}

export interface LambdaCapacityProviderState {
  capacityProviderName: string;
  capacityProviderArn: string;
  state: "Pending" | "Active" | "Failed" | "Deleting";
  vpcConfig: { subnetIds: string[]; securityGroupIds: string[] };
  permissionsConfig: { capacityProviderOperatorRoleArn: string };
  instanceRequirements?: {
    architectures?: LambdaArchitecture[];
    allowedInstanceTypes?: string[];
    excludedInstanceTypes?: string[];
  };
  capacityProviderScalingConfig?: {
    maxVCpuCount?: number;
    scalingMode?: "Auto" | "Manual";
    scalingPolicies?: Array<{
      predefinedMetricType: "LambdaCapacityProviderAverageCPUUtilization";
      targetValue: number;
    }>;
  };
  kmsKeyArn?: string;
  tags: Record<string, string>;
  propagateTags?: { mode?: "None" | "Explicit"; explicitTags?: Record<string, string> };
  telemetryConfig?: { loggingConfig?: { systemLogLevel?: "DEBUG" | "INFO" | "WARN"; logGroup?: string } };
  lastModified: string;
}

export interface LambdaExecutableConfigurationState {
  packageType: LambdaPackageType;
  imageConfig?: LambdaImageConfigState;
  imageUri?: string;
  resolvedImageUri?: string;
  imageExecutionUri?: string;
  imageSource?: "oci" | "docker";
  architectures: LambdaArchitecture[];
  ephemeralStorageSize: number;
  loggingConfig: LambdaLoggingConfigState;
  tracingMode: LambdaTracingMode;
  deadLetterTargetArn?: string;
  fileSystemConfigs: LambdaFileSystemConfigState[];
  vpcConfig: LambdaVpcConfigState;
  kmsKeyArn?: string;
  runtimeManagementConfig: LambdaRuntimeManagementConfigState;
  environmentError?: { errorCode: string; message: string };
  capacityProviderConfig?: LambdaManagedInstancesCapacityProviderConfigState;
  durableConfig?: LambdaDurableConfigState;
}

export interface LambdaState extends LambdaExecutableConfigurationState {
  functionName: string;
  functionArn: string;
  runtime: string;
  role: string;
  handler: string;
  timeout: number;
  memorySize: number;
  description: string;
  environment: Record<string, string>;
  codeSha256: string;
  codeSize: number;
  codeUnzippedSize?: number;
  codeDir: string;
  layers?: LambdaLayerReferenceState[];
  version: number;
  revisionId?: string;
  tags?: Record<string, string>;
  versions?: Record<string, LambdaVersionState>;
  aliases?: Record<string, LambdaAliasState>;
  policies?: Record<string, LambdaResourcePolicyState>;
  eventInvokeConfigs?: Record<string, LambdaEventInvokeConfigState>;
  reservedConcurrentExecutions?: number;
  provisionedConcurrencyConfigs?: Record<string, LambdaProvisionedConcurrencyConfigState>;
  functionUrlConfigs?: Record<string, LambdaFunctionUrlConfigState>;
  functionScalingConfigs?: Record<string, LambdaFunctionScalingConfigState>;
  codeSigningConfigArn?: string;
  recursiveLoop: LambdaRecursiveLoop;
  lastModified: string;
  state?: "Pending" | "Active" | "Failed" | "Inactive";
  stateReason?: string;
  /** Simulator-only, payload-free diagnostic for the most recent platform log delivery failure. */
  lastLogDeliveryError?: { time: number; code: string; message: string };
  lastUpdateStatus?: "InProgress" | "Successful" | "Failed";
  lastUpdateStatusReason?: string;
}

export interface LambdaProvisionedConcurrencyConfigState {
  qualifier: string;
  requestedProvisionedConcurrentExecutions: number;
  allocatedProvisionedConcurrentExecutions: number;
  status: "IN_PROGRESS" | "READY" | "FAILED";
  statusReason?: string;
  lastModified: string;
}

export interface LambdaFunctionUrlCorsState {
  allowCredentials?: boolean;
  allowHeaders?: string[];
  allowMethods?: string[];
  allowOrigins?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
}

export interface LambdaFunctionUrlConfigState {
  urlId: string;
  qualifier?: string;
  authType: "NONE" | "AWS_IAM";
  cors?: LambdaFunctionUrlCorsState;
  invokeMode: "BUFFERED" | "RESPONSE_STREAM";
  creationTime: string;
  lastModifiedTime: string;
}

export interface LambdaEventInvokeConfigState {
  qualifier?: string;
  maximumEventAgeInSeconds?: number;
  maximumRetryAttempts?: number;
  destinationConfig?: {
    onSuccess?: string;
    onFailure?: string;
  };
  lastModified: number;
}

export interface LambdaAsyncInvocationState {
  eventId: string;
  functionName: string;
  qualifier?: string;
  payloadBase64: string;
  enqueuedAt: number;
  nextAttemptAt: number;
  attempts: number;
  status: "QUEUED" | "LEASED";
  leaseId?: string;
  leaseUntil?: number;
  lastAttemptAt?: number;
  lastError?: string;
  lineage?: string[];
}

export interface LambdaDurableExecutionState {
  durableExecutionArn: string;
  durableExecutionName: string;
  invocationId: string;
  functionName: string;
  functionArn: string;
  requestedQualifier: string;
  executedVersion: string;
  executable: LambdaVersionState;
  invocationType: "RequestResponse" | "Event";
  inputPayload: string;
  inputHash: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "STOPPED";
  startTimestamp: number;
  endTimestamp?: number;
  result?: string;
  error?: LambdaDurableErrorState;
  traceHeader?: string;
  durableConfig: LambdaDurableConfigState;
  checkpointToken: string;
  operations: LambdaDurableOperationState[];
  history: LambdaDurableHistoryEventState[];
  nextEventId: number;
  nextOperationSequence: number;
  updatedOperationIds: string[];
  clientTokens: Record<string, { requestHash: string; expiresAt: number; response: unknown }>;
  interruptedAttempts?: number;
  lineage?: string[];
  deadLetterDelivery?: {
    targetArn: string;
    status: "PENDING" | "DELIVERED" | "UNSUPPORTED";
    attempts: number;
    nextAttemptAt: number;
    lastAttemptAt?: number;
    deliveredAt?: number;
    lastError?: string;
  };
}

export interface LambdaEventSourceBatchState {
  sequenceNumbers: string[];
  throughSequenceNumber: string;
  attempts: number;
  nextAttemptAt: number;
  firstAttemptAt: number;
  tumbling?: { start: number; end: number; state: Record<string, unknown>; isFinalInvokeForWindow: boolean };
}

export interface LambdaTumblingWindowState {
  start: number;
  end: number;
  state: Record<string, unknown>;
  nextSequenceNumber: string;
  throughSequenceNumber?: string;
}

export interface LambdaEventSourceMappingState {
  uuid: string;
  eventSourceMappingArn: string;
  sourceType?: "dynamodb" | "sqs";
  eventSourceArn: string;
  functionName: string;
  functionQualifier?: string;
  functionArn: string;
  enabled: boolean;
  state: "Creating" | "Enabled" | "Disabled" | "Updating" | "Deleting";
  stateTransitionReason: string;
  batchSize: number;
  maximumBatchingWindowInSeconds: number;
  parallelizationFactor: number;
  startingPosition: "TRIM_HORIZON" | "LATEST";
  maximumRecordAgeInSeconds: number;
  maximumRetryAttempts: number;
  bisectBatchOnFunctionError: boolean;
  tumblingWindowInSeconds: number;
  functionResponseTypes: Array<"ReportBatchItemFailures">;
  filterCriteria?: { Filters: Array<{ Pattern: string }> };
  destinationOnFailure?: string;
  tags: Record<string, string>;
  createdAt: number;
  lastModified: number;
  lastProcessingResult: string;
  scalingMaximumConcurrency?: number;
  nextSequenceNumber: string;
  batchWindowStartedAt?: number;
  pendingBatch?: LambdaEventSourceBatchState;
  tumblingWindowState?: LambdaTumblingWindowState;
}

export interface LambdaVersionState extends LambdaExecutableConfigurationState {
  version: string;
  functionArn: string;
  runtime: string;
  role: string;
  handler: string;
  timeout: number;
  memorySize: number;
  description: string;
  environment: Record<string, string>;
  codeSha256: string;
  codeSize: number;
  codeUnzippedSize?: number;
  codeDir: string;
  layers?: LambdaLayerReferenceState[];
  lastModified: string;
  revisionId: string;
  /** Private service-authoritative idempotency marker used by CloudFormation providers. */
  cloudFormationOperationToken?: string;
}

export interface LambdaAliasState {
  name: string;
  functionVersion: string;
  description?: string;
  revisionId: string;
  additionalVersionWeights: Record<string, number>;
}

export interface LambdaResourcePolicyState {
  revisionId: string;
  statements: Array<{
    Sid: string;
    Effect: "Allow";
    Principal: string | Record<string, string>;
    Action: string;
    Resource: string;
    Condition?: Record<string, Record<string, string>>;
  }>;
}

export interface LambdaLayerReferenceState {
  arn: string;
  codeSize: number;
  uncompressedCodeSize: number;
  codeDir: string;
  compatibleRuntimes: string[];
  compatibleArchitectures: Array<"x86_64" | "arm64">;
}

export interface LambdaLayerPolicyState {
  revisionId: string;
  statements: Array<{
    Sid: string;
    Effect: "Allow";
    Principal: string | { AWS: string };
    Action: "lambda:GetLayerVersion";
    Resource: string;
    Condition?: { StringEquals: { "aws:PrincipalOrgID": string } };
  }>;
}

export interface LambdaLayerVersionState extends LambdaLayerReferenceState {
  version: number;
  layerArn: string;
  description: string;
  createdDate: string;
  licenseInfo?: string;
  codeSha256: string;
  /** Internal durable ownership marker used by the CloudFormation provider. */
  cloudFormationOwner?: string;
  /** Internal create token used to adopt a publish after a lost response. */
  cloudFormationOperationToken?: string;
  policy?: LambdaLayerPolicyState;
  deleted?: boolean;
}

export interface LambdaLayerState {
  layerName: string;
  layerArn: string;
  nextVersion: number;
  versions: Record<string, LambdaLayerVersionState>;
}

export interface LambdaCodeSigningConfigState {
  codeSigningConfigId: string;
  codeSigningConfigArn: string;
  allowedPublishers: string[];
  untrustedArtifactOnDeployment: "Enforce" | "Warn";
  description: string;
  lastModified: string;
  tags: Record<string, string>;
}

export interface ApiMethodState {
  authorizationType: string;
  authorizerId?: string;
  authorizationScopes?: string[];
  apiKeyRequired: boolean;
  requestParameters?: Record<string, boolean>;
  requestModels?: Record<string, string>;
  requestValidatorId?: string;
  operationName?: string;
  responses?: Record<string, ApiMethodResponseState>;
}

export interface ApiModelState {
  id: string;
  name: string;
  description?: string;
  schema: string;
  contentType: string;
}

export interface ApiRequestValidatorState {
  id: string;
  name?: string;
  validateRequestBody: boolean;
  validateRequestParameters: boolean;
}

export interface ApiMethodResponseState {
  statusCode: string;
  responseParameters?: Record<string, boolean>;
  responseModels?: Record<string, string>;
}

export interface ApiIntegrationState {
  type: string;
  integrationHttpMethod: string;
  uri?: string;
  connectionType?: "INTERNET" | "VPC_LINK";
  connectionId?: string;
  credentials?: string;
  requestParameters?: Record<string, string>;
  requestTemplates?: Record<string, string>;
  passthroughBehavior?: string;
  contentHandling?: string;
  timeoutInMillis?: number;
  cacheNamespace?: string;
  cacheKeyParameters?: string[];
  tlsConfig?: { insecureSkipVerification?: boolean };
  responses?: Record<string, ApiIntegrationResponseState>;
}

export interface ApiIntegrationResponseState {
  statusCode: string;
  selectionPattern?: string;
  responseParameters?: Record<string, string>;
  responseTemplates?: Record<string, string>;
  contentHandling?: string;
}

export interface ApiResource {
  id: string;
  parentId?: string;
  pathPart?: string;
  path: string;
  methods: Record<string, ApiMethodState>;
  integrations: Record<string, ApiIntegrationState>;
}

export interface ApiAuthorizerState {
  id: string;
  name: string;
  type: "TOKEN" | "REQUEST" | "COGNITO_USER_POOLS";
  authorizerUri?: string;
  authorizerCredentials?: string;
  identitySource?: string;
  identityValidationExpression?: string;
  authorizerResultTtlInSeconds: number;
  providerARNs?: string[];
}

export interface ApiGatewayResponseState {
  responseType: string;
  statusCode?: string;
  responseParameters: Record<string, string>;
  responseTemplates: Record<string, string>;
}

export interface ApiMethodSettingState {
  metricsEnabled?: boolean;
  loggingLevel?: "OFF" | "ERROR" | "INFO";
  dataTraceEnabled?: boolean;
  throttlingBurstLimit?: number;
  throttlingRateLimit?: number;
  cachingEnabled?: boolean;
  cacheTtlInSeconds?: number;
  cacheDataEncrypted?: boolean;
  requireAuthorizationForCacheControl?: boolean;
  unauthorizedCacheControlHeaderStrategy?: "FAIL_WITH_403" | "SUCCEED_WITH_RESPONSE_HEADER" | "SUCCEED_WITHOUT_RESPONSE_HEADER";
}

export interface ApiCanarySettingsState {
  percentTraffic?: number;
  deploymentId?: string;
  stageVariableOverrides?: Record<string, string>;
  useStageCache?: boolean;
}

export interface ApiStageState {
  stageName: string;
  deploymentId: string;
  description?: string;
  createdDate?: number;
  lastUpdatedDate?: number;
  variables?: Record<string, string>;
  methodSettings?: Record<string, ApiMethodSettingState>;
  tracingEnabled?: boolean;
  accessLogSettings?: { destinationArn?: string; format?: string };
  cacheClusterEnabled?: boolean;
  cacheClusterSize?: string;
  canarySettings?: ApiCanarySettingsState;
  documentationVersion?: string;
  clientCertificateId?: string;
  tags?: Record<string, string>;
}

export interface ApiGatewayAccountState { cloudwatchRoleArn?: string }

export interface ApiGatewayVpcLinkState {
  id: string;
  name: string;
  description?: string;
  targetArns: string[];
  status: "AVAILABLE" | "PENDING" | "DELETING" | "FAILED";
  statusMessage?: string;
  tags: Record<string, string>;
  createdDate: number;
}

export interface ApiGatewayClientCertificateState {
  clientCertificateId: string;
  description?: string;
  pemEncodedCertificate: string;
  createdDate: number;
  expirationDate: number;
  tags: Record<string, string>;
}

export interface ApiDocumentationPartLocationState {
  type: "API" | "AUTHORIZER" | "MODEL" | "RESOURCE" | "METHOD" | "PATH_PARAMETER" | "QUERY_PARAMETER" | "REQUEST_HEADER" | "REQUEST_BODY" | "RESPONSE" | "RESPONSE_HEADER" | "RESPONSE_BODY";
  path?: string;
  method?: string;
  statusCode?: string;
  name?: string;
}

export interface ApiDocumentationPartState {
  id: string;
  location: ApiDocumentationPartLocationState;
  properties: string;
  cloudFormationOwner?: string;
  cloudFormationOperationToken?: string;
}

export interface ApiDocumentationVersionState {
  version: string;
  createdDate: number;
  description?: string;
  parts: Record<string, ApiDocumentationPartState>;
  cloudFormationOwner?: string;
  cloudFormationOperationToken?: string;
}

export interface ApiGatewayCachedResponseState {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface ApiGatewayResponseCacheEnvelopeState {
  version: 1;
  algorithm: "AES-256-GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

interface ApiGatewayResponseCacheEntryMetadataState {
  expiresAt: number;
  deploymentId: string;
  method: string;
  namespace: string;
}

export type ApiGatewayResponseCacheEntryState = ApiGatewayResponseCacheEntryMetadataState & (
  | { encrypted: false; response: ApiGatewayCachedResponseState }
  | { encrypted: true; envelope: ApiGatewayResponseCacheEnvelopeState }
);

export interface ApiGatewayStageCacheState {
  entries: Record<string, ApiGatewayResponseCacheEntryState>;
}

export interface ApiGatewayBasePathMappingState {
  basePath: string;
  restApiId: string;
  stage: string;
  cloudFormationOwner?: string;
  cloudFormationOperationToken?: string;
}

export interface ApiGatewayDomainNameState {
  domainName: string;
  domainNameId?: string;
  domainNameArn: string;
  certificateName?: string;
  certificateArn?: string;
  certificateUploadDate?: number;
  regionalCertificateName?: string;
  regionalCertificateArn?: string;
  regionalDomainName?: string;
  regionalHostedZoneId?: string;
  distributionDomainName?: string;
  distributionHostedZoneId?: string;
  endpointConfiguration: {
    types: Array<"EDGE" | "REGIONAL" | "PRIVATE">;
    ipAddressType?: "ipv4" | "dualstack";
    vpcEndpointIds?: string[];
  };
  domainNameStatus: "AVAILABLE";
  securityPolicy: string;
  endpointAccessMode?: "BASIC" | "STRICT";
  mutualTlsAuthentication?: { truststoreUri?: string; truststoreVersion?: string; truststoreWarnings?: string[] };
  ownershipVerificationCertificateArn?: string;
  managementPolicy?: string;
  policy?: string;
  routingMode: "BASE_PATH_MAPPING_ONLY" | "ROUTING_RULE_ONLY" | "ROUTING_RULE_THEN_BASE_PATH_MAPPING";
  tags: Record<string, string>;
  basePathMappings: Record<string, ApiGatewayBasePathMappingState>;
  createdDate: number;
  lastUpdatedDate: number;
}

export interface ApiGatewayDomainNameAccessAssociationState {
  domainNameAccessAssociationArn: string;
  domainNameArn: string;
  accessAssociationSourceType: "VPCE";
  accessAssociationSource: string;
  tags: Record<string, string>;
  createdDate: number;
}

export interface HttpApiCorsState {
  allowCredentials?: boolean;
  allowHeaders?: string[];
  allowMethods?: string[];
  allowOrigins?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
}

export interface HttpApiIntegrationState {
  integrationId: string;
  description?: string;
  integrationType: "AWS_PROXY" | "HTTP_PROXY";
  integrationSubtype?: string;
  integrationMethod?: string;
  integrationUri?: string;
  credentialsArn?: string;
  connectionType: "INTERNET";
  requestParameters: Record<string, string>;
  responseParameters: Record<string, Record<string, string>>;
  timeoutInMillis: number;
  payloadFormatVersion: "1.0" | "2.0";
  tlsConfig?: { serverNameToVerify?: string };
  apiGatewayManaged: boolean;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface HttpApiRouteState {
  routeId: string;
  routeKey: string;
  authorizationType: "NONE" | "AWS_IAM" | "CUSTOM" | "JWT";
  authorizerId?: string;
  authorizationScopes: string[];
  target?: string;
  operationName?: string;
  apiGatewayManaged: boolean;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface HttpApiAuthorizerState {
  authorizerId: string;
  name: string;
  authorizerType: "REQUEST" | "JWT";
  authorizerUri?: string;
  authorizerCredentialsArn?: string;
  identitySource: string[];
  authorizerPayloadFormatVersion?: "1.0" | "2.0";
  authorizerResultTtlInSeconds: number;
  enableSimpleResponses?: boolean;
  jwtConfiguration?: { audience: string[]; issuer: string };
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface HttpApiModelState {
  modelId: string;
  name: string;
  description?: string;
  schema: string;
  contentType?: string;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface HttpApiDeploymentSnapshotState {
  routes: Record<string, HttpApiRouteState>;
  integrations: Record<string, HttpApiIntegrationState>;
  authorizers: Record<string, HttpApiAuthorizerState>;
  models: Record<string, HttpApiModelState>;
  corsConfiguration?: HttpApiCorsState;
}

export interface HttpApiDeploymentState {
  deploymentId: string;
  description?: string;
  createdDate: number;
  deploymentStatus: "SUCCEEDED";
  autoDeployed: boolean;
  snapshot: HttpApiDeploymentSnapshotState;
  contentHash: string;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface HttpApiRouteSettingsState {
  detailedMetricsEnabled?: boolean;
  throttlingBurstLimit?: number;
  throttlingRateLimit?: number;
}

export interface HttpApiStageState {
  stageName: string;
  description?: string;
  deploymentId?: string;
  defaultRouteSettings: HttpApiRouteSettingsState;
  routeSettings: Record<string, HttpApiRouteSettingsState>;
  stageVariables: Record<string, string>;
  accessLogSettings?: { destinationArn: string; format: string };
  autoDeploy: boolean;
  lastDeploymentStatusMessage?: string;
  createdDate: number;
  lastUpdatedDate: number;
  tags: Record<string, string>;
  apiGatewayManaged: boolean;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface HttpApiState {
  apiId: string;
  name: string;
  description?: string;
  version?: string;
  protocolType: "HTTP";
  ipAddressType: "ipv4" | "dualstack";
  routeSelectionExpression: "${request.method} ${request.path}";
  apiEndpoint: string;
  apiGatewayManaged: boolean;
  createdDate: number;
  tags: Record<string, string>;
  corsConfiguration?: HttpApiCorsState;
  disableExecuteApiEndpoint: boolean;
  integrations: Record<string, HttpApiIntegrationState>;
  routes: Record<string, HttpApiRouteState>;
  authorizers: Record<string, HttpApiAuthorizerState>;
  deployments: Record<string, HttpApiDeploymentState>;
  stages: Record<string, HttpApiStageState>;
  models: Record<string, HttpApiModelState>;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketIntegrationResponseState {
  integrationResponseId: string;
  integrationResponseKey: string;
  contentHandlingStrategy?: "CONVERT_TO_BINARY" | "CONVERT_TO_TEXT";
  responseParameters: Record<string, string>;
  responseTemplates: Record<string, string>;
  templateSelectionExpression?: string;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketIntegrationState {
  integrationId: string;
  description?: string;
  integrationType: "AWS_PROXY" | "AWS" | "HTTP_PROXY" | "HTTP" | "MOCK";
  integrationMethod?: string;
  integrationUri?: string;
  credentialsArn?: string;
  connectionType: "INTERNET";
  contentHandlingStrategy?: "CONVERT_TO_BINARY" | "CONVERT_TO_TEXT";
  passthroughBehavior?: "WHEN_NO_MATCH" | "NEVER" | "WHEN_NO_TEMPLATES";
  requestParameters: Record<string, string>;
  requestTemplates: Record<string, string>;
  templateSelectionExpression?: string;
  timeoutInMillis: number;
  tlsConfig?: { serverNameToVerify?: string };
  integrationResponseSelectionExpression?: string;
  apiGatewayManaged: boolean;
  integrationResponses: Record<string, WebSocketIntegrationResponseState>;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketRouteResponseState {
  routeResponseId: string;
  routeResponseKey: "$default";
  modelSelectionExpression?: string;
  responseModels: Record<string, string>;
  responseParameters: Record<string, { required: boolean }>;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketRouteState {
  routeId: string;
  routeKey: string;
  authorizationType: "NONE" | "AWS_IAM" | "CUSTOM";
  authorizerId?: string;
  authorizationScopes: string[];
  apiKeyRequired: boolean;
  modelSelectionExpression?: string;
  operationName?: string;
  requestModels: Record<string, string>;
  requestParameters: Record<string, { required: boolean }>;
  routeResponseSelectionExpression?: string;
  target?: string;
  apiGatewayManaged: boolean;
  routeResponses: Record<string, WebSocketRouteResponseState>;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketAuthorizerState {
  authorizerId: string;
  name: string;
  authorizerType: "REQUEST";
  authorizerUri: string;
  authorizerCredentialsArn?: string;
  identitySource: string[];
  authorizerResultTtlInSeconds: number;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketModelState {
  modelId: string;
  name: string;
  description?: string;
  schema: string;
  contentType?: string;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketDeploymentSnapshotState {
  routes: Record<string, WebSocketRouteState>;
  integrations: Record<string, WebSocketIntegrationState>;
  authorizers: Record<string, WebSocketAuthorizerState>;
  models: Record<string, WebSocketModelState>;
}

export interface WebSocketDeploymentState {
  deploymentId: string;
  description?: string;
  createdDate: number;
  deploymentStatus: "SUCCEEDED";
  autoDeployed: boolean;
  snapshot: WebSocketDeploymentSnapshotState;
  contentHash: string;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface WebSocketApiState {
  apiId: string;
  name: string;
  description?: string;
  version?: string;
  protocolType: "WEBSOCKET";
  ipAddressType: "ipv4" | "dualstack";
  routeSelectionExpression: string;
  apiEndpoint: string;
  apiGatewayManaged: boolean;
  createdDate: number;
  tags: Record<string, string>;
  disableExecuteApiEndpoint: boolean;
  integrations: Record<string, WebSocketIntegrationState>;
  routes: Record<string, WebSocketRouteState>;
  authorizers: Record<string, WebSocketAuthorizerState>;
  deployments: Record<string, WebSocketDeploymentState>;
  stages: Record<string, HttpApiStageState>;
  models: Record<string, WebSocketModelState>;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface ApiGatewayV2ApiMappingState {
  apiMappingId: string;
  apiMappingKey?: string;
  apiId: string;
  stage: string;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface ApiGatewayV2DomainNameState {
  domainName: string;
  domainNameArn: string;
  domainNameConfigurations: Array<{
    endpointType: "REGIONAL";
    ipAddressType: "ipv4" | "dualstack";
    certificateName?: string;
    certificateArn: string;
    ownershipVerificationCertificateArn?: string;
    apiGatewayDomainName: string;
    hostedZoneId: string;
    certificateUploadDate?: number;
    securityPolicy: string;
    domainNameStatus: "AVAILABLE";
  }>;
  apiMappingSelectionExpression: "$request.basepath";
  mutualTlsAuthentication?: { truststoreUri?: string; truststoreVersion?: string; truststoreWarnings?: string[] };
  routingMode: "API_MAPPING_ONLY" | "ROUTING_RULE_ONLY" | "ROUTING_RULE_THEN_API_MAPPING";
  tags: Record<string, string>;
  apiMappings: Record<string, ApiGatewayV2ApiMappingState>;
  createdDate: number;
  lastUpdatedDate: number;
  /** Internal-only marker for replay-safe CloudFormation creates. */
  cloudFormationOperationToken?: string;
}

export interface ApiGatewayApiKeyState {
  id: string;
  value: string;
  name?: string;
  customerId?: string;
  description?: string;
  enabled: boolean;
  createdDate: number;
  lastUpdatedDate: number;
  stageKeys: string[];
  tags: Record<string, string>;
}

export interface ApiGatewayThrottleSettingsState {
  burstLimit?: number;
  rateLimit?: number;
}

export interface ApiGatewayUsagePlanStageState {
  apiId: string;
  stage: string;
  throttle?: Record<string, ApiGatewayThrottleSettingsState>;
}

export interface ApiGatewayUsagePlanState {
  id: string;
  name: string;
  description?: string;
  apiStages: ApiGatewayUsagePlanStageState[];
  throttle?: ApiGatewayThrottleSettingsState;
  quota?: { limit: number; offset?: number; period: "DAY" | "WEEK" | "MONTH" };
  productCode?: string;
  tags: Record<string, string>;
  keyIds: string[];
  createdDate: number;
  initialQuotaPeriodStart?: string;
  usage: Record<string, Record<string, number>>;
  quotaExtensions: Record<string, Record<string, number>>;
}

export interface RestApiState {
  id: string;
  name: string;
  description?: string;
  tags?: Record<string, string>;
  version?: string;
  createdDate: number;
  rootResourceId: string;
  resources: Record<string, ApiResource>;
  deployments: Record<string, { id: string; createdDate: number; description?: string; snapshot?: ApiDeploymentSnapshot; contentHash?: string; cloudFormationOperationToken?: string }>;
  stages: Record<string, ApiStageState>;
  policy?: PolicyDocument;
  authorizers?: Record<string, ApiAuthorizerState>;
  models?: Record<string, ApiModelState>;
  requestValidators?: Record<string, ApiRequestValidatorState>;
  documentationParts?: Record<string, ApiDocumentationPartState>;
  documentationVersions?: Record<string, ApiDocumentationVersionState>;
  binaryMediaTypes?: string[];
  minimumCompressionSize?: number;
  gatewayResponses?: Record<string, ApiGatewayResponseState>;
  apiKeySource?: "HEADER" | "AUTHORIZER";
}

export interface ApiDeploymentSnapshot {
  rootResourceId: string;
  resources: Record<string, ApiResource>;
  authorizers?: Record<string, ApiAuthorizerState>;
  models?: Record<string, ApiModelState>;
  requestValidators?: Record<string, ApiRequestValidatorState>;
  policy?: PolicyDocument;
  binaryMediaTypes?: string[];
  minimumCompressionSize?: number;
  gatewayResponses?: Record<string, ApiGatewayResponseState>;
  apiKeySource?: "HEADER" | "AUTHORIZER";
  schemaProfileVersion?: number;
}

export interface LogEventState {
  timestamp: number;
  ingestionTime: number;
  message: string;
  eventId: string;
  order: number;
  deliveryLineage?: string[];
}

export interface LogStreamState {
  logStreamName: string;
  arn: string;
  creationTime: number;
  firstEventTimestamp?: number;
  lastEventTimestamp?: number;
  lastIngestionTime?: number;
  storedBytes: number;
  sequence: number;
}

export interface LogGroupState {
  logGroupName: string;
  arn: string;
  creationTime: number;
  logGroupClass?: "STANDARD" | "INFREQUENT_ACCESS";
  retentionInDays?: number;
  storedBytes: number;
  tags: Record<string, string>;
  streams: Record<string, LogStreamState>;
  metricFilters: Record<string, LogMetricFilterState>;
  subscriptionFilters: Record<string, LogSubscriptionFilterState>;
}

export interface LogMetricTransformationState {
  defaultValue?: number;
  dimensions?: Record<string, string>;
  metricName: string;
  metricNamespace: string;
  metricValue: string;
  unit?: string;
}

export interface LogMetricFilterState {
  filterName: string;
  filterPattern: string;
  logGroupName: string;
  metricTransformations: [LogMetricTransformationState];
  creationTime: number;
  emitSystemFieldDimensions?: string[];
  fieldSelectionCriteria?: string;
}

export interface LogSubscriptionFilterState {
  filterName: string;
  filterPattern: string;
  logGroupName: string;
  destinationArn: string;
  distribution?: "Random" | "ByLogStream";
  creationTime: number;
  emitSystemFields?: string[];
  fieldSelectionCriteria?: string;
  checkpoints: Record<string, number>;
  deliveryAttempts: Record<string, number>;
}

export interface LogDestinationState {
  destinationName: string;
  targetArn: string;
  roleArn: string;
  arn: string;
  creationTime: number;
  accessPolicy?: string;
  tags: Record<string, string>;
}

export interface LogResourcePolicyState {
  policyName: string;
  policyDocument: string;
  policyScope: "ACCOUNT" | "RESOURCE";
  lastUpdatedTime: number;
  resourceArn?: string;
  revisionId?: string;
}

export interface LogExportTaskState {
  taskId: string;
  taskName?: string;
  logGroupName: string;
  logStreamNamePrefix?: string;
  from: number;
  to: number;
  destination: string;
  destinationPrefix: string;
  status: "CANCELLED" | "COMPLETED" | "FAILED" | "PENDING" | "PENDING_CANCEL" | "RUNNING";
  statusMessage: string;
  creationTime: number;
  completionTime?: number;
  outputFiles?: string[];
}

export interface LogQueryParameterState {
  name: string;
  defaultValue?: string;
  description?: string;
}

export interface LogQueryDefinitionState {
  queryDefinitionId: string;
  name: string;
  queryString: string;
  queryLanguage: "CWLI" | "SQL" | "PPL";
  lastModified: number;
  logGroupNames?: string[];
  parameters?: LogQueryParameterState[];
  clientToken?: string;
  clientTokenHash?: string;
}

export interface IamRoleState {
  roleName: string;
  roleId: string;
  arn: string;
  path: string;
  createDate: number;
  description?: string;
  maxSessionDuration: number;
  assumeRolePolicyDocument: PolicyDocument;
  assumeRolePolicyCanonical?: string;
  tags: Record<string, string>;
  attachedPolicyArns: string[];
  inlinePolicies: Record<string, PolicyDocument>;
  inlinePolicyCanonicalDocuments?: Record<string, string>;
  permissionsBoundaryArn?: string;
}

export interface IamUserState {
  userName: string;
  userId: string;
  arn: string;
  path: string;
  createDate: number;
  tags: Record<string, string>;
  attachedPolicyArns: string[];
  inlinePolicies: Record<string, PolicyDocument>;
  inlinePolicyCanonicalDocuments?: Record<string, string>;
  permissionsBoundaryArn?: string;
}

export interface IamGroupState {
  groupName: string;
  groupId: string;
  arn: string;
  path: string;
  createDate: number;
  userNames: string[];
  attachedPolicyArns: string[];
  inlinePolicies: Record<string, PolicyDocument>;
  inlinePolicyCanonicalDocuments?: Record<string, string>;
}

export interface IamAccessKeyState {
  accessKeyId: string;
  userName: string;
  status: "Active" | "Inactive";
  createDate: number;
  origin: "configured" | "generated";
  credentialId: string;
  lastUsed?: { date: number; serviceName: string; region: string };
}

export interface IamPolicyVersionState { versionId: string; document: PolicyDocument; canonicalDocument?: string; createDate: number; isDefaultVersion: boolean }
export interface IamPolicyState {
  policyName: string;
  policyId: string;
  arn: string;
  path: string;
  description?: string;
  createDate: number;
  updateDate: number;
  tags: Record<string, string>;
  versions: Record<string, IamPolicyVersionState>;
  defaultVersionId: string;
  awsManaged: boolean;
}

export interface PolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Principal?: string | string[] | Record<string, string | string[]>;
  NotPrincipal?: string | string[] | Record<string, string | string[]>;
  Condition?: Record<string, Record<string, unknown>>;
}
export interface PolicyDocument { Version?: string; Id?: string; Statement: PolicyStatement | PolicyStatement[] }

export interface LocalCredentialState {
  accessKeyId: string;
  credentialId?: string;
  /** Schema-57 migration input only; scrubbed after vault migration. */
  secretAccessKey?: string;
  /** Schema-57 migration input only; scrubbed after vault migration. */
  sessionToken?: string;
  principalArn: string;
  principalId: string;
  roleArn: string;
  roleName: string;
  sessionName: string;
  issuedAt?: number;
  expiration: number;
  sourceIdentity?: string;
  sessionPolicy?: PolicyDocument;
  sessionPolicyCanonical?: string;
  sessionTags: Record<string, string>;
  /** Present on normalized/new sessions; optional only for legacy in-memory fixtures. */
  transitiveTagKeys?: string[];
  lambdaLineage?: string[];
}

export interface AuthorizationDecisionState { time: number; requestId: string; principalArn: string; action: string; resource: string; decision: "allowed" | "implicitDeny" | "explicitDeny"; reason: string }
export interface IamState {
  users: Record<string, IamUserState>;
  groups: Record<string, IamGroupState>;
  accessKeys: Record<string, IamAccessKeyState>;
  roles: Record<string, IamRoleState>;
  policies: Record<string, IamPolicyState>;
  sessions: Record<string, LocalCredentialState>;
  authorizationDecisions: AuthorizationDecisionState[];
}

export type CloudWatchAlarmStateValue = "OK" | "ALARM" | "INSUFFICIENT_DATA";
export type CloudWatchComparisonOperator = "GreaterThanThreshold" | "GreaterThanOrEqualToThreshold" | "LessThanThreshold" | "LessThanOrEqualToThreshold" | "LessThanLowerOrGreaterThanUpperThreshold" | "LessThanLowerThreshold" | "GreaterThanUpperThreshold";

export interface CloudWatchAlarmCommonState {
  alarmName: string;
  alarmArn: string;
  alarmDescription?: string;
  createdAt: number;
  configurationUpdatedTimestamp: number;
  actionsEnabled: boolean;
  okActions: string[];
  alarmActions: string[];
  insufficientDataActions: string[];
  stateValue: CloudWatchAlarmStateValue;
  stateReason: string;
  stateReasonData: string;
  stateUpdatedTimestamp: number;
  stateTransitionedTimestamp: number;
  tags: Record<string, string>;
}

export interface CloudWatchAlarmState extends CloudWatchAlarmCommonState {
  namespace?: string;
  metricName?: string;
  dimensions?: Array<{ Name: string; Value: string }>;
  period?: number;
  unit?: string;
  statistic?: string;
  extendedStatistic?: string;
  metrics?: Array<Record<string, unknown>>;
  evaluationPeriods: number;
  datapointsToAlarm: number;
  threshold?: number;
  thresholdMetricId?: string;
  comparisonOperator: CloudWatchComparisonOperator;
  treatMissingData: "breaching" | "notBreaching" | "ignore" | "missing";
  evaluateLowSampleCountPercentile: "evaluate" | "ignore";
  lastEvaluatedAt?: number;
}

export interface CloudWatchCompositeAlarmState extends CloudWatchAlarmCommonState {
  alarmRule: string;
  children: string[];
  actionsSuppressor?: string;
  actionsSuppressorWaitPeriod?: number;
  actionsSuppressorExtensionPeriod?: number;
  actionsSuppressedBy?: "WaitPeriod" | "ExtensionPeriod" | "Alarm";
  actionsSuppressedReason?: string;
  pendingAction?: {
    state: CloudWatchAlarmStateValue;
    dueAt: number;
    previousValue: CloudWatchAlarmStateValue;
    previousReason: string;
    previousTimestamp: number;
  };
}

export interface CloudWatchLogAlarmContributorState {
  contributorId: string;
  contributorAttributes: Record<string, string>;
  stateValue: CloudWatchAlarmStateValue;
  stateReason: string;
  stateTransitionedTimestamp: number;
  results: Array<{ timestamp: number; value?: number }>;
}

export interface CloudWatchLogAlarmState extends CloudWatchAlarmCommonState {
  scheduledQueryConfiguration: {
    queryString: string;
    logGroupIdentifiers: string[];
    queryArn: string;
    scheduledQueryRoleArn: string;
    scheduleConfiguration: { scheduleExpression: string; startTimeOffset?: number; endTimeOffset?: number };
    aggregationExpression: string;
    tags: Record<string, string>;
  };
  queryResultsToEvaluate: number;
  queryResultsToAlarm: number;
  threshold: number;
  comparisonOperator: "GreaterThanThreshold" | "GreaterThanOrEqualToThreshold" | "LessThanThreshold" | "LessThanOrEqualToThreshold";
  treatMissingData: "breaching" | "notBreaching" | "ignore" | "missing";
  actionLogLineCount: number;
  actionLogLineRoleArn?: string;
  evaluationState?: "PARTIAL_DATA" | "EVALUATION_FAILURE" | "EVALUATION_ERROR";
  lastEvaluatedAt?: number;
  contributors: Record<string, CloudWatchLogAlarmContributorState>;
  latestLogLines: string[];
}

export interface CloudWatchAlarmMuteRuleState {
  name: string;
  alarmMuteRuleArn: string;
  description?: string;
  rule: { schedule: { expression: string; duration: string; durationMs: number; timezone: string } };
  alarmNames: string[];
  tags: Record<string, string>;
  startDate?: number;
  expireDate?: number;
  createdAt: number;
  lastUpdatedTimestamp: number;
}

export type CloudWatchAnyAlarmState = CloudWatchAlarmState | CloudWatchCompositeAlarmState | CloudWatchLogAlarmState;

export interface CloudWatchAlarmHistoryState {
  alarmName: string;
  alarmType: "MetricAlarm" | "CompositeAlarm" | "LogAlarm";
  timestamp: number;
  historyItemType: "ConfigurationUpdate" | "StateUpdate" | "Action" | "AlarmContributorStateUpdate" | "AlarmContributorAction";
  historySummary: string;
  historyData: string;
  alarmContributorId?: string;
  alarmContributorAttributes?: Record<string, string>;
}

export interface CloudWatchEventBridgeOutboxState {
  id: string;
  detailType: "CloudWatch Alarm State Change" | "CloudWatch Alarm Configuration Change";
  source: "aws.cloudwatch";
  resources: string[];
  time: number;
  detail: Record<string, unknown>;
  deliveryLineage?: string[];
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface CloudWatchAnomalyDetectorConfigurationState {
  excludedTimeRanges: Array<{ StartTime: number; EndTime: number }>;
  metricTimezone?: string;
}

export interface CloudWatchAnomalyDetectorState {
  anomalyDetectorId: string;
  detectorType: "SINGLE_METRIC" | "METRIC_MATH";
  identityKey: string;
  singleMetric?: {
    AccountId?: string;
    Namespace: string;
    MetricName: string;
    Dimensions: Array<{ Name: string; Value: string }>;
    Stat: string;
  };
  metricMath?: { MetricDataQueries: Array<Record<string, unknown>> };
  configuration: CloudWatchAnomalyDetectorConfigurationState;
  metricCharacteristics?: { PeriodicSpikes?: boolean };
  stateValue: "PENDING_TRAINING" | "TRAINED_INSUFFICIENT_DATA" | "TRAINED";
  createdAt: number;
  updatedAt: number;
  trainingDueAt: number;
}

export interface CloudWatchMetricStreamFilterState {
  Namespace: string;
  MetricNames?: string[];
}

export interface CloudWatchMetricStreamStatisticsConfigurationState {
  IncludeMetrics: Array<{ Namespace: string; MetricName: string }>;
  AdditionalStatistics: string[];
}

export interface CloudWatchMetricStreamState {
  name: string;
  arn: string;
  includeFilters?: CloudWatchMetricStreamFilterState[];
  excludeFilters?: CloudWatchMetricStreamFilterState[];
  firehoseArn: string;
  roleArn: string;
  outputFormat: "json" | "opentelemetry0.7" | "opentelemetry1.0";
  state: "running" | "stopped";
  statisticsConfigurations: CloudWatchMetricStreamStatisticsConfigurationState[];
  includeLinkedAccountsMetrics: boolean;
  tags: Record<string, string>;
  creationDate: number;
  lastUpdateDate: number;
  destinationType: "local-file" | "dependency-blocked";
  localFilePath?: string;
  deliveredRecords: number;
  lastDeliveryDate?: number;
  lastDeliveryError?: string;
}

export interface CloudWatchInsightRuleCollectionWindowState {
  start: number;
  end?: number;
}

export interface CloudWatchInsightRuleState {
  name: string;
  arn: string;
  definition: string;
  state: "ENABLED" | "DISABLED";
  applyOnTransformedLogs: boolean;
  tags: Record<string, string>;
  managedRule: boolean;
  managedTemplateName?: string;
  managedResourceArn?: string;
  createdAt: number;
  updatedAt: number;
  collectionWindows: CloudWatchInsightRuleCollectionWindowState[];
}

export interface CloudWatchSnsActionOutboxState {
  id: string;
  topicArn: string;
  message: string;
  alarmName: string;
  state: CloudWatchAlarmStateValue;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  deliveryLineage?: string[];
  contributor?: { id: string; attributes: Record<string, string> };
}

export interface CloudWatchLambdaActionOutboxState {
  id: string;
  functionArn: string;
  payloadBase64: string;
  alarmName: string;
  state: CloudWatchAlarmStateValue;
  transitionAt: number;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  deliveryLineage?: string[];
  contributor?: { id: string; attributes: Record<string, string> };
}

export interface CloudWatchState {
  alarms: Record<string, CloudWatchAlarmState>;
  compositeAlarms: Record<string, CloudWatchCompositeAlarmState>;
  logAlarms: Record<string, CloudWatchLogAlarmState>;
  alarmMuteRules: Record<string, CloudWatchAlarmMuteRuleState>;
  anomalyDetectors: Record<string, CloudWatchAnomalyDetectorState>;
  datasetKmsKeyArn?: string;
  metricStreams: Record<string, CloudWatchMetricStreamState>;
  insightRules: Record<string, CloudWatchInsightRuleState>;
  alarmHistory: CloudWatchAlarmHistoryState[];
  eventBridgeOutbox: CloudWatchEventBridgeOutboxState[];
  snsActionOutbox?: CloudWatchSnsActionOutboxState[];
  lambdaActionOutbox?: CloudWatchLambdaActionOutboxState[];
}

export interface CloudWatchDashboardState {
  dashboardName: string;
  dashboardArn: string;
  dashboardBody: string;
  lastModified: number;
  size: number;
  tags: Record<string, string>;
}

export interface S3BucketState {
  name: string;
  arn: string;
  region: string;
  ownerAccountId: string;
  ownerId: string;
  createdAt: number;
  versioning: "unversioned" | "enabled" | "suspended";
  /** Server-side encryption supported by the local S3 backing service. */
  encryption?: "AES256";
  /** Explicit default-encryption descriptor. Payloads always remain protected by the local authenticated blob tier. */
  encryptionConfiguration?: {
    algorithm: "AES256" | "aws:kms" | "aws:kms:dsse";
    kmsKeyId?: string;
    bucketKeyEnabled: boolean;
  };
  /** Object Lock is irreversible once enabled for a general-purpose bucket. */
  objectLockConfiguration?: {
    enabled: true;
    defaultRetention?: { mode: "GOVERNANCE" | "COMPLIANCE"; days?: number; years?: number };
  };
  /** Validated lifecycle XML plus the normalized scheduler model. */
  lifecycleConfiguration?: {
    xml: string;
    rules: Array<{
      id?: string;
      status: "Enabled" | "Disabled";
      prefix: string;
      tags: Record<string, string>;
      objectSizeGreaterThan?: number;
      objectSizeLessThan?: number;
      expirationDays?: number;
      expirationDate?: number;
      expiredObjectDeleteMarker?: boolean;
      transitions: Array<{ days?: number; date?: number; storageClass: string }>;
      noncurrentExpirationDays?: number;
      newerNoncurrentVersions?: number;
      noncurrentTransitions: Array<{ days: number; storageClass: string; newerNoncurrentVersions?: number }>;
      abortIncompleteMultipartUploadDays?: number;
    }>;
  };
  /** Atomically replaced S3 notification configuration. */
  notificationConfiguration?: {
    lambda: Array<{ id: string; arn: string; events: string[]; prefix?: string; suffix?: string }>;
    queue: Array<{ id: string; arn: string; events: string[]; prefix?: string; suffix?: string }>;
    eventBridge: boolean;
  };
  /** Durable bucket tags. Older state files are normalized on read. */
  tags?: Record<string, string>;
  /** Canonical S3 public-access-block state. */
  publicAccessBlock?: {
    blockPublicAcls: boolean;
    ignorePublicAcls: boolean;
    blockPublicPolicy: boolean;
    restrictPublicBuckets: boolean;
  };
  /** Bounded static-website configuration supported by the local endpoint. */
  website?: {
    indexDocument: string;
    errorDocument?: string;
  };
  /** Validated bucket CORS rules. CORS changes response headers, never authorization. */
  corsConfiguration?: Array<{
    allowedHeaders: string[];
    allowedMethods: Array<"GET" | "HEAD">;
    allowedOrigins: string[];
  }>;
  /** Resource policy enforced by S3 and the anonymous website endpoint. */
  policyDocument?: PolicyDocument;
  /** S3 Object Ownership mode. New buckets default to BucketOwnerEnforced. */
  objectOwnership?: "BucketOwnerEnforced" | "BucketOwnerPreferred" | "ObjectWriter";
  /** Presence bits for optional properties projected by the bounded CloudFormation provider. */
  cloudFormationConfiguration?: {
    ownershipControls: boolean;
    publicAccessBlock: boolean;
  };
  /** Bucket ACL, retained even when BucketOwnerEnforced makes ACLs inactive. */
  acl?: S3AccessControlListState;
  /** Requester Pays is an authorization/header model only; no billing is simulated. */
  requestPayment?: "BucketOwner" | "Requester";
  /** Bucket ABAC opt-in used by the shared IAM condition evaluator. */
  abacStatus?: "Enabled" | "Disabled";
  /** Ownership marker for simulator-managed infrastructure outside application stacks. */
  managedBy?: "stacksim-cdk-bootstrap";
  /** Version of the manager contract that last reconciled this bucket. */
  managedRevision?: number;
}

export interface S3AccessControlGrantState {
  grantee: {
    type: "CanonicalUser" | "Group";
    id?: string;
    displayName?: string;
    uri?: string;
  };
  permission: "FULL_CONTROL" | "READ" | "WRITE" | "READ_ACP" | "WRITE_ACP";
}

export interface S3AccessControlListState {
  ownerId: string;
  ownerDisplayName: string;
  grants: S3AccessControlGrantState[];
}

export interface SqsQueueAttributesState {
  DelaySeconds: string;
  MaximumMessageSize: string;
  MessageRetentionPeriod: string;
  ReceiveMessageWaitTimeSeconds: string;
  VisibilityTimeout: string;
  FifoQueue: "true" | "false";
  ContentBasedDeduplication?: "true" | "false";
  DeduplicationScope?: "queue" | "messageGroup";
  FifoThroughputLimit?: "perQueue" | "perMessageGroupId";
  Policy?: string;
  SqsManagedSseEnabled: "true" | "false";
  KmsMasterKeyId?: string;
  KmsDataKeyReusePeriodSeconds?: string;
  RedrivePolicy?: string;
  RedriveAllowPolicy?: string;
}

export interface SqsQueueState {
  queueName: string;
  queueArn: string;
  createdAt: number;
  lastModified: number;
  attributes: SqsQueueAttributesState;
  tags: Record<string, string>;
  purgeAvailableAt?: number;
  /**
   * A forward-completing intent for SetQueueAttributes. Attribute values are
   * persisted with the intent before message metadata is rewritten, allowing
   * startup recovery to idempotently finish an interrupted retention update.
   * `null` is the durable representation of an attribute deletion.
   */
  pendingAttributeUpdate?: {
    attributes: Partial<Record<keyof SqsQueueAttributesState, string | null>>;
    lastModified: number;
  };
}

export interface EventBridgeInputTransformerState {
  inputPathsMap?: Record<string, string>;
  inputTemplate: string;
}

export interface EventBridgeRetryPolicyState {
  maximumEventAgeInSeconds?: number;
  maximumRetryAttempts?: number;
}

export type EventBridgeTargetType = "lambda" | "sqs" | "sns" | "logs" | "apigateway" | "states";

export interface EventBridgeHttpParametersState {
  pathParameterValues?: string[];
  queryStringParameters?: Record<string, string>;
  headerParameters?: Record<string, string>;
}

export interface EventBridgeTargetState {
  id: string;
  arn: string;
  targetType?: EventBridgeTargetType;
  roleArn?: string;
  deadLetterArn?: string;
  sqsParameters?: { messageGroupId: string };
  httpParameters?: EventBridgeHttpParametersState;
  input?: string;
  inputPath?: string;
  inputTransformer?: EventBridgeInputTransformerState;
  retryPolicy?: EventBridgeRetryPolicyState;
}

export interface EventBridgeEventBusState {
  name: string;
  arn: string;
  description?: string;
  createdAt: number;
  lastModified: number;
  tags: Record<string, string>;
}

/** Compatibility name for service code that uses the shorter AWS noun. */
export type EventBridgeBusState = EventBridgeEventBusState;

export interface EventBridgeRuleState {
  name: string;
  arn: string;
  eventBusName: string;
  eventPattern?: string;
  scheduleExpression?: string;
  scheduleCreatedAt?: number;
  scheduleLastCommittedAt?: number;
  scheduleNextAt?: number;
  state: "ENABLED" | "DISABLED" | "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS";
  description?: string;
  roleArn?: string;
  managedBy?: string;
  createdAt: number;
  lastModified: number;
  tags: Record<string, string>;
}

export type CloudFormationStackStatus =
  | "REVIEW_IN_PROGRESS"
  | "CREATE_IN_PROGRESS" | "CREATE_FAILED" | "CREATE_COMPLETE"
  | "ROLLBACK_IN_PROGRESS" | "ROLLBACK_FAILED" | "ROLLBACK_COMPLETE"
  | "DELETE_IN_PROGRESS" | "DELETE_FAILED" | "DELETE_COMPLETE"
  | "UPDATE_IN_PROGRESS" | "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS" | "UPDATE_COMPLETE"
  | "UPDATE_FAILED" | "UPDATE_ROLLBACK_IN_PROGRESS" | "UPDATE_ROLLBACK_FAILED"
  | "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS" | "UPDATE_ROLLBACK_COMPLETE";

export type CloudFormationResourceStatus =
  | "CREATE_IN_PROGRESS" | "CREATE_FAILED" | "CREATE_COMPLETE"
  | "DELETE_IN_PROGRESS" | "DELETE_FAILED" | "DELETE_COMPLETE"
  | "DELETE_SKIPPED"
  | "UPDATE_IN_PROGRESS" | "UPDATE_FAILED" | "UPDATE_COMPLETE"
  | "UPDATE_ROLLBACK_IN_PROGRESS" | "UPDATE_ROLLBACK_FAILED" | "UPDATE_ROLLBACK_COMPLETE";

export interface CloudFormationParameterState {
  parameterKey: string;
  parameterValue?: string;
  resolvedValue?: string;
  usePreviousValue?: boolean;
  noEcho?: boolean;
}

export interface CloudFormationOutputState {
  outputKey: string;
  outputValue: string;
  description?: string;
  exportName?: string;
}

export interface CloudFormationStackResourceState {
  logicalResourceId: string;
  physicalResourceId?: string;
  refValue?: unknown;
  resourceType: string;
  resourceStatus: CloudFormationResourceStatus;
  resourceStatusReason?: string;
  lastUpdatedTimestamp: number;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  deletionPolicy?: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot";
  updateReplacePolicy?: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot";
  dependsOn: string[];
  /** Root deployment generation that most recently reconciled this resource. */
  completedDeploymentGeneration?: number;
}

export interface CloudFormationStackEventState {
  eventId: string;
  stackId: string;
  stackName: string;
  operationId?: string;
  logicalResourceId: string;
  physicalResourceId?: string;
  resourceType: string;
  timestamp: number;
  resourceStatus: CloudFormationStackStatus | CloudFormationResourceStatus;
  resourceStatusReason?: string;
  clientRequestToken?: string;
  resourceProperties?: string;
}

export interface CloudFormationStackOperationState {
  operationId: string;
  kind: "CREATE" | "UPDATE" | "DELETE" | "ROLLBACK" | "ROLLBACK_UPDATE" | "CONTINUE_UPDATE_ROLLBACK";
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  acceptedAt: number;
  startedAt?: number;
  completedAt?: number;
  clientRequestToken?: string;
  orderedLogicalIds: string[];
  completedLogicalIds: string[];
  rollbackLogicalIds: string[];
  retainLogicalIds?: string[];
  /** Delete newly created Retain resources when this operation rolls back. */
  retainExceptOnCreate?: boolean;
  /** Preserve provider mutations in CREATE_FAILED/UPDATE_FAILED for RollbackStack. */
  disableRollback?: boolean;
  /** Original UPDATE operation whose mutation ledger/snapshot an explicit rollback consumes. */
  rollbackSourceOperationId?: string;
  /** Create failure disposition selected by CreateStack/CreateChangeSet. */
  onFailure?: "DELETE" | "DO_NOTHING" | "ROLLBACK";
  /** Retry DELETE_FAILED by orphaning a resource that still cannot be deleted. */
  forceDelete?: boolean;
  resourcesToSkip?: string[];
  desiredTemplateArtifactId?: string;
  previousTemplateArtifactId?: string;
  desiredTemplateDigest?: string;
  desiredProcessedTemplateDigest?: string;
  cancelRequestedAt?: number;
  failureReason?: string;
  /** Durable single-executor lease used to hand an operation across restart. */
  leaseOwner?: string;
  leaseExpiresAt?: number;
  leaseEpoch?: number;
  /** Ancestor operation coordinating this child transition. */
  owningParentOperationId?: string;
}

export interface LogQueryStatisticsState {
  recordsMatched: number;
  recordsScanned: number;
  estimatedRecordsSkipped: number;
  bytesScanned: number;
  estimatedBytesSkipped: number;
  logGroupsScanned: number;
}

export interface LogQueryJobState {
  queryId: string;
  queryString: string;
  queryLanguage: "CWLI";
  logGroupNames: string[];
  startTime: number;
  endTime: number;
  limit: number;
  status: "Scheduled" | "Running" | "Complete" | "Failed" | "Cancelled" | "Timeout";
  createTime: number;
  startedAt?: number;
  completedAt?: number;
  expiresAt: number;
  results: Array<Array<{ field: string; value: string }>>;
  finalResults?: Array<Array<{ field: string; value: string }>>;
  statistics: LogQueryStatisticsState;
  userIdentity?: string;
  failure?: string;
}

export interface CloudFormationStackState {
  stackId: string;
  stackName: string;
  description?: string;
  stackStatus: CloudFormationStackStatus;
  stackStatusReason?: string;
  creationTime: number;
  lastUpdatedTime?: number;
  deletionTime?: number;
  enableTerminationProtection: boolean;
  disableRollback: boolean;
  roleArn?: string;
  notificationArns: string[];
  rollbackConfiguration?: {
    rollbackTriggers: Array<{ arn: string; type: "AWS::CloudWatch::Alarm" | "AWS::CloudWatch::CompositeAlarm" }>;
    monitoringTimeInMinutes?: number;
  };
  capabilities: string[];
  tags: Record<string, string>;
  parameters: CloudFormationParameterState[];
  outputs: CloudFormationOutputState[];
  templateArtifactId?: string;
  /** Legacy schema-v50 inline fields; new writes use the durable artifact store. */
  templateBody?: string;
  processedTemplateBody?: string;
  templateDigest: string;
  processedTemplateDigest?: string;
  resources: Record<string, CloudFormationStackResourceState>;
  events: CloudFormationStackEventState[];
  activeOperation?: CloudFormationStackOperationState;
  lastClientRequestToken?: string;
  parentId?: string;
  rootId?: string;
  /** Logical AWS::CloudFormation::Stack resource in the immediate parent. */
  parentLogicalId?: string;
  /** Former owning relationship retained after a nested stack is detached. */
  formerParentId?: string;
  formerParentLogicalId?: string;
  /** Last accepted AWS::CloudFormation::Stack properties from the parent. */
  nestedStackSource?: Record<string, unknown>;
  /** Root deployment generation that most recently completed successfully. */
  completedDeploymentGeneration?: number;
}

export interface CloudFormationResourceOwnershipState {
  accountId: string;
  region: string;
  rootStackId: string;
  stackId: string;
  parentStackId?: string;
  logicalResourceId: string;
  resourceType: string;
  physicalResourceId: string;
  completedDeploymentGeneration: number;
}

export interface CloudFormationHotswapDriftState {
  driftId: string;
  accountId: string;
  region: string;
  rootStackId: string;
  stackId: string;
  parentStackId?: string;
  logicalResourceId: string;
  resourceType: string;
  physicalResourceId: string;
  completedDeploymentGeneration: number;
  service: "appsync" | "lambda";
  action: string;
  requestPayloadSha256: string;
  priorServiceRevision: string;
  currentServiceRevision: string;
  status: "PENDING" | "INTENTIONAL" | "FAILED";
  startedAt: number;
  completedAt?: number;
  failure?: string;
}

export interface CloudFormationChangeSetState {
  changeSetId: string;
  changeSetName: string;
  stackId: string;
  stackName: string;
  changeSetType: "CREATE" | "UPDATE" | "IMPORT";
  status: "CREATE_PENDING" | "CREATE_IN_PROGRESS" | "CREATE_COMPLETE" | "DELETE_PENDING" | "DELETE_IN_PROGRESS" | "DELETE_COMPLETE" | "DELETE_FAILED" | "FAILED";
  executionStatus: "UNAVAILABLE" | "AVAILABLE" | "EXECUTE_IN_PROGRESS" | "EXECUTE_COMPLETE" | "EXECUTE_FAILED" | "OBSOLETE";
  statusReason?: string;
  creationTime: number;
  lastUpdatedTime: number;
  clientToken?: string;
  inputDigest?: string;
  description?: string;
  templateArtifactId?: string;
  /** Legacy inline fields; new change sets persist templates as durable artifacts. */
  templateBody?: string;
  processedTemplateBody?: string;
  templateDigest: string;
  processedTemplateDigest?: string;
  parameters: CloudFormationParameterState[];
  capabilities: string[];
  roleArn?: string;
  tags: Record<string, string>;
  changes: Array<Record<string, unknown>>;
  notificationArns?: string[];
  rollbackConfiguration?: CloudFormationStackState["rollbackConfiguration"];
  includeNestedStacks?: boolean;
  onStackFailure?: "DELETE" | "DO_NOTHING" | "ROLLBACK";
  executionClientToken?: string;
  executionOperationId?: string;
  parentChangeSetId?: string;
  rootChangeSetId?: string;
}

export interface CloudFormationExportState {
  name: string;
  value: string;
  exportingStackId: string;
  importingStackIds: string[];
}

export interface CloudFormationBootstrapState {
  owner: "stacksim";
  qualifier: string;
  compatibilityVersion: number;
  policyRevision: number;
  bucketName: string;
  roleArns: Record<"deploy" | "filePublishing" | "imagePublishing" | "lookup" | "cloudFormationExecution", string>;
  versionParameterName: string;
  updatedAt: number;
}

export interface CloudFormationRegionState {
  stacks: Record<string, CloudFormationStackState>;
  stackNames: Record<string, string>;
  changeSets: Record<string, CloudFormationChangeSetState>;
  changeSetNames: Record<string, string>;
  exports: Record<string, CloudFormationExportState>;
  clientTokens: Record<string, { operation: string; stackId?: string; changeSetId?: string; operationId?: string; inputDigest: string; createdAt?: number }>;
  bootstrap?: CloudFormationBootstrapState;
  notificationOutbox?: CloudFormationNotificationOutboxState[];
  /** Monotonic root deployment generation allocator. */
  deploymentGeneration?: number;
  /** Reverse ownership catalog. Keys include physical IDs, ARNs and service-specific targets. */
  resourceOwnership?: Record<string, CloudFormationResourceOwnershipState[]>;
  /** Current intentional service drift, keyed by owning stack resource. */
  hotswapDrift?: Record<string, CloudFormationHotswapDriftState>;
  /** Durable bounded operation history used to explain retry and partial-failure boundaries. */
  hotswapOperations?: CloudFormationHotswapDriftState[];
}

export interface CloudFormationNotificationOutboxState {
  id: string;
  topicArn: string;
  stackId: string;
  message: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface SesAccountState {
  /** Local account profile. Production is the default; sandbox is an explicit test profile. */
  accessProfile: "PRODUCTION" | "SANDBOX";
  productionAccessEnabled: boolean;
  sendingEnabled: boolean;
  max24HourSend: number;
  maxSendRate: number;
  details?: {
    mailType: "MARKETING" | "TRANSACTIONAL";
    websiteUrl: string;
    contactLanguage: "EN" | "JA";
    additionalContactEmailAddresses: string[];
    reviewDetails?: { status: string; caseId?: string };
  };
  suppressionReasons?: Array<"BOUNCE" | "COMPLAINT">;
}

export interface SesIdentityState {
  /** Caller-preserved spelling used in SDK and console responses. */
  identity: string;
  /** Canonical key used by regional identity lookup and source resolution. */
  canonicalIdentity: string;
  identityType: "EMAIL_ADDRESS" | "DOMAIN" | "MANAGED_DOMAIN";
  arn: string;
  /** Immutable random identity generation; delete/recreate must allocate a new value. */
  generationId: string;
  verificationStatus: "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE" | "NOT_STARTED";
  verifiedForSendingStatus: boolean;
  activeVerificationIntentId?: string;
  dkimTokens: string[];
  dkimSigningEnabled: boolean;
  dkimSigningAttributesOrigin?: "AWS_SES" | "EXTERNAL";
  dkimCurrentSigningKeyLength?: "RSA_1024_BIT" | "RSA_2048_BIT";
  dkimNextSigningKeyLength?: "RSA_1024_BIT" | "RSA_2048_BIT";
  lastKeyGenerationTimestamp?: number;
  dkimVerificationStatus: "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE" | "NOT_STARTED";
  verificationToken?: string;
  defaultConfigurationSetName?: string;
  mailFromAttributes?: {
    mailFromDomain?: string;
    behaviorOnMxFailure: "USE_DEFAULT_VALUE" | "REJECT_MESSAGE";
    mailFromDomainStatus: "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE";
  };
  feedbackForwardingStatus?: boolean;
  headersInNotificationsEnabled?: boolean;
  notificationTopics?: Partial<Record<"Bounce" | "Complaint" | "Delivery", string>>;
  tags: Record<string, string>;
  policies: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface SesTemplateState {
  name: string;
  arn: string;
  subjectPart: string;
  textPart?: string;
  htmlPart?: string;
  tags: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface SesConfigurationSetState {
  name: string;
  arn: string;
  sendingEnabled: boolean;
  deliveryOptions?: { tlsPolicy?: "REQUIRE" | "OPTIONAL"; sendingPoolName?: string; maxDeliverySeconds?: number };
  reputationOptions?: { reputationMetricsEnabled: boolean; lastFreshStart?: number };
  suppressionOptions?: { suppressedReasons: Array<"BOUNCE" | "COMPLAINT"> };
  trackingOptions?: { customRedirectDomain?: string; httpsPolicy?: "REQUIRE" | "REQUIRE_OPEN_ONLY" | "OPTIONAL" };
  eventDestinations?: Record<string, SesConfigurationSetEventDestinationState>;
  tags: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface SesConfigurationSetEventDestinationState {
  resourceId: string;
  name: string;
  enabled: boolean;
  matchingEventTypes: string[];
  cloudWatchDestination?: {
    dimensionConfigurations: Array<{
      dimensionName: string;
      dimensionValueSource: "MESSAGE_TAG" | "EMAIL_HEADER" | "LINK_TAG";
      defaultDimensionValue: string;
    }>;
  };
  eventBridgeDestination?: { eventBusArn: string };
  createdAt: number;
  updatedAt: number;
}

export interface SesCustomVerificationTemplateState {
  name: string;
  arn: string;
  fromEmailAddress: string;
  templateSubject: string;
  templateContent: string;
  successRedirectionUrl: string;
  failureRedirectionUrl: string;
  tags: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface SesContactListTopicState {
  topicName: string;
  displayName: string;
  description?: string;
  defaultSubscriptionStatus: "OPT_IN" | "OPT_OUT";
}

export interface SesContactState {
  emailAddress: string;
  topicPreferences: Record<string, "OPT_IN" | "OPT_OUT">;
  unsubscribeAll: boolean;
  attributesData?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SesContactListState {
  name: string;
  arn: string;
  description?: string;
  topics: Record<string, SesContactListTopicState>;
  contacts: Record<string, SesContactState>;
  tags: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface SesSuppressedDestinationState {
  emailAddress: string;
  reason: "BOUNCE" | "COMPLAINT";
  lastUpdateTime: number;
  attributes?: { messageId?: string; feedbackId?: string };
}

export interface SesLocalCallbackState {
  callbackId: string;
  purpose: "UNSUBSCRIBE" | "CLICK" | "OPEN";
  nonceDigest: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
  destinationUrl?: string;
  contactListName?: string;
  topicName?: string;
  emailAddress?: string;
  messageId?: string;
}

export interface SesVerificationIntentState {
  intentId: string;
  identity: string;
  identityGeneration: string;
  /** The previously active intent replaced only after this intent is captured. */
  supersedesIntentId?: string;
  messageId: string;
  nonceDigest: string;
  publicBaseUrl: string;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
  customTemplate?: {
    fromEmailAddress: string;
    subject: string;
    content: string;
  };
  issuedAt: number;
  expiresAt: number;
  status: "PENDING_CAPTURE" | "CAPTURED" | "CONSUMED" | "SUPERSEDED" | "CANCELLED" | "EXPIRED";
  terminalAt?: number;
}

export interface SesCallbackResultState {
  status: "SUCCESS" | "ALREADY_VERIFIED" | "EXPIRED" | "INVALID" | "DELETED" | "SUPERSEDED" | "REGION_MISMATCH";
  identity?: string;
  destinationUrl?: string;
  expiresAt: number;
}

export interface SesRegionState {
  /** Incremented by every mutation that can affect send acceptance. */
  controlRevision: number;
  account: SesAccountState;
  identities: Record<string, SesIdentityState>;
  verificationIntents: Record<string, SesVerificationIntentState>;
  callbackResults: Record<string, SesCallbackResultState>;
  templates: Record<string, SesTemplateState>;
  configurationSets: Record<string, SesConfigurationSetState>;
  customVerificationTemplates: Record<string, SesCustomVerificationTemplateState>;
  contactLists: Record<string, SesContactListState>;
  suppressedDestinations: Record<string, SesSuppressedDestinationState>;
  localCallbacks: Record<string, SesLocalCallbackState>;
}

export interface CognitoPasswordPolicyState {
  minimumLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
  temporaryPasswordValidityDays: number;
  passwordHistorySize?: number;
}

export interface CognitoPasswordHashState {
  version: 1;
  algorithm: "scrypt";
  N: 32768;
  r: 8;
  p: 1;
  maxmem: 67108864;
  salt: string;
  digest: string;
}

export type CognitoSecretPurpose =
  | "APP_CLIENT_SECRET"
  | "SIGNING_PRIVATE_KEY"
  | "TOTP_SEED"
  | "SRP_DERIVED_KEY"
  | "IDP_SECRET"
  | "INVITATION_PASSWORD"
  | "DEVICE_PASSWORD_VERIFIER"
  | "DEVICE_SALT";

export interface CognitoSecretEnvelope {
  version: 1;
  keyVersion: 1;
  purpose: CognitoSecretPurpose;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export interface CognitoRecoverableSecretState {
  id: string;
  version: 1;
  envelope: CognitoSecretEnvelope;
}

export interface CognitoPublicSigningJwkState {
  kty: "RSA";
  alg: "RS256";
  use: "sig";
  kid: string;
  n: string;
  e: string;
}

export interface CognitoSigningKeyState {
  kid: string;
  tokenUse: "id" | "access";
  createdAt: number;
  retireAfter?: number;
  publicJwk: CognitoPublicSigningJwkState;
  privateKey: CognitoRecoverableSecretState;
}

export interface CognitoSigningKeyRingState {
  activeKid: string;
  keys: Record<string, CognitoSigningKeyState>;
}

export interface CognitoSigningKeysState {
  id: CognitoSigningKeyRingState;
  access: CognitoSigningKeyRingState;
}

export interface CognitoUserAttributeState {
  value: string;
  verified: boolean;
}

export interface CognitoSchemaAttributeState {
  name: string;
  attributeDataType: "String" | "Number" | "Boolean" | "DateTime";
  developerOnlyAttribute: boolean;
  mutable: boolean;
  required: boolean;
  stringAttributeConstraints?: { minLength?: string; maxLength?: string };
  numberAttributeConstraints?: { minValue?: string; maxValue?: string };
}

export interface CognitoUserMfaState {
  softwareToken?: {
    enabled: boolean;
    preferred: boolean;
    secret?: CognitoRecoverableSecretState;
    verifiedAt?: number;
  };
  email?: {
    enabled: boolean;
    preferred: boolean;
  };
}

export interface CognitoUserState {
  sub: string;
  username: string;
  generationId: string;
  enabled: boolean;
  status: "UNCONFIRMED" | "CONFIRMED" | "RESET_REQUIRED" | "FORCE_CHANGE_PASSWORD" | "EXTERNAL_PROVIDER";
  createdAt: number;
  updatedAt: number;
  attributes: Record<string, CognitoUserAttributeState>;
  password: CognitoPasswordHashState;
  passwordHistory: CognitoPasswordHashState[];
  passwordChangedAt: number;
  srp?: {
    salt: string;
    verifier: string;
  };
  temporaryPasswordExpiresAt?: number;
  activeConfirmationIntentId?: string;
  activePasswordResetIntentId?: string;
  activeAttributeVerificationIntentIds: Record<string, string>;
  groupNames: string[];
  mfa: CognitoUserMfaState;
  preferredMfaSetting?: "SOFTWARE_TOKEN_MFA" | "EMAIL_OTP";
  userMfaSettingList: Array<"SOFTWARE_TOKEN_MFA" | "EMAIL_OTP">;
  devices: Record<string, CognitoDeviceState>;
  pendingDevices?: Record<string, CognitoPendingDeviceState>;
  sessionEpoch: number;
  externalIdentities: CognitoExternalIdentityState[];
}

export interface EventBridgeSchedulerTargetState {
  arn: string;
  roleArn: string;
  input?: string;
  deadLetterArn?: string;
  maximumEventAgeInSeconds: number;
  maximumRetryAttempts: number;
  sqsMessageGroupId?: string;
  eventBridgeParameters?: { detailType: string; source: string };
  universal?: { service: "logs"; action: "putLogEvents" };
}

export interface EventBridgeScheduleDeliveryState {
  scheduledAt: number;
  invocationAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: "QUEUED" | "LEASED";
  leaseId?: string;
  leaseUntil?: number;
  lastError?: string;
}

export interface EventBridgeScheduleOccurrenceState {
  occurrenceId: string;
  eventId: string;
  scheduleArn: string;
  scheduleName: string;
  groupName: string;
  scheduleGeneration: string;
  scheduledAt: number;
  invocationAt: number;
  admittedAt: number;
  payload: string;
  target: EventBridgeSchedulerTargetState;
  flexibleTimeWindow: { mode: "OFF" | "FLEXIBLE"; maximumWindowInMinutes?: number };
  actionAfterCompletion: "NONE" | "DELETE";
  lineage: string[];
  attempts: number;
  nextAttemptAt: number;
  status: "QUEUED" | "LEASED" | "DLQ_QUEUED" | "DLQ_LEASED" | "SUCCEEDED" | "FAILED" | "DLQ_SENT" | "DLQ_FAILED";
  leaseId?: string;
  leaseUntil?: number;
  lastError?: string;
  deadLetterError?: string;
  completedAt?: number;
}

export interface EventBridgeScheduleState {
  name: string;
  arn: string;
  groupName: string;
  generation: string;
  scheduleExpression: string;
  scheduleExpressionTimezone: string;
  startDate?: number;
  endDate?: number;
  description?: string;
  state: "ENABLED" | "DISABLED";
  flexibleTimeWindow: { mode: "OFF" | "FLEXIBLE"; maximumWindowInMinutes?: number };
  target: EventBridgeSchedulerTargetState;
  actionAfterCompletion: "NONE" | "DELETE";
  creationDate: number;
  lastModificationDate: number;
  clientToken?: string;
  clientTokenHash?: string;
  lastCommittedScheduledAt?: number;
  lastCommittedLocalKey?: string;
  nextScheduledAt?: number;
  nextInvocationAt?: number;
  pendingDelivery?: EventBridgeScheduleDeliveryState;
  completedAt?: number;
  lastDeliveryStatus?: "SUCCEEDED" | "FAILED" | "DLQ_SENT" | "DLQ_FAILED";
  lastDeliveryError?: string;
}

export interface EventBridgeScheduleGroupState {
  name: string;
  arn: string;
  state: "ACTIVE" | "DELETING";
  creationDate: number;
  lastModificationDate: number;
  tags: Record<string, string>;
  clientToken?: string;
  clientTokenHash?: string;
}

export interface CognitoExternalIdentityState {
  providerName: string;
  providerType: "OIDC" | "SAML" | "Google" | "Facebook" | "LoginWithAmazon" | "SignInWithApple";
  providerSubject: string;
  providerAttributeName: string;
  linkedAt: number;
}

export interface CognitoRefreshSessionState {
  id: string;
  clientId: string;
  userSub: string;
  userGenerationId: string;
  sessionEpoch: number;
  secretHashUsername: string;
  tokenDigest: string;
  eventId: string;
  originJti: string;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
  lastUsedAt: number;
  status: "ACTIVE" | "REVOKED";
  familyId?: string;
  parentSessionId?: string;
  replacedBySessionId?: string;
  rotationGraceUntil?: number;
  revokedAt?: number;
  revocationReason?: "TOKEN_REVOKE" | "GLOBAL_SIGN_OUT" | "USER_DISABLED" | "USER_DELETED" | "PASSWORD_CHANGED" | "ROTATED" | "REPLAY";
  oauthScopes?: string[];
  oauthNonce?: string;
  deviceKey?: string;
}

export interface CognitoDeliveryIntentState {
  id: string;
  purpose:
    | "SIGN_UP"
    | "RESEND_SIGN_UP"
    | "PASSWORD_RESET"
    | "ATTRIBUTE_VERIFICATION"
    | "ADMIN_INVITATION"
    | "EMAIL_MFA";
  accountId: string;
  region: string;
  poolId: string;
  clientId: string;
  userSub: string;
  userGenerationId: string;
  targetAttribute?: {
    name: "email";
    canonicalValue: string;
  };
  credential: {
    kind: "DERIVED_CODE";
    derivationVersion: 1;
    codeDigest: string;
    recoverableSecret?: CognitoRecoverableSecretState;
  };
  message: {
    deliveryProfile: "COGNITO_DEFAULT" | "DEVELOPER";
    sourceArn?: string;
    source: string;
    configurationSetName?: string;
    destination: string;
    replyTo?: string;
    subjectTemplate: string;
    textTemplate: string;
    templateVersion: "1";
    safeVariables: { username: string; attributeName?: string };
    renderedContentMac: string;
  };
  deliveryKey: string;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
  status: "PENDING_DELIVERY" | "DELIVERED" | "SUPERSEDED" | "CONSUMED" | "EXPIRED" | "CANCELLED";
  statusUpdatedAt?: number;
  sesMessageId: string;
}

export interface CognitoUserPoolConfigurationState {
  policies: { passwordPolicy: CognitoPasswordPolicyState };
  deletionProtection: "ACTIVE" | "INACTIVE";
  autoVerifiedAttributes: "email"[];
  aliasAttributes: "email"[];
  usernameAttributes: "email"[];
  usernameConfiguration: { caseSensitive: boolean };
  schemaAttributes: CognitoSchemaAttributeState[];
  accountRecoverySetting?: {
    recoveryMechanisms: Array<{
      name: "verified_email" | "admin_only";
      priority: number;
    }>;
  };
  emailConfiguration: {
    emailSendingAccount: "COGNITO_DEFAULT" | "DEVELOPER";
    sourceArn?: string;
    from?: string;
    replyToEmailAddress?: string;
    configurationSet?: string;
  };
  verificationMessageTemplate: {
    defaultEmailOption: "CONFIRM_WITH_CODE";
    emailSubject: string;
    emailMessage: string;
    smsMessage?: string;
  };
  adminCreateUserConfig: {
    allowAdminCreateUserOnly: boolean;
    unusedAccountValidityDays?: number;
    inviteMessageTemplate: {
      emailSubject: string;
      emailMessage: string;
    };
  };
  mfaConfiguration: "OFF" | "ON" | "OPTIONAL";
  enabledMfas: Array<"SOFTWARE_TOKEN_MFA" | "EMAIL_OTP">;
  emailMfaConfiguration?: {
    subject: string;
    message: string;
  };
  lambdaConfig: {
    preSignUp?: string;
    customMessage?: string;
    postConfirmation?: string;
    preAuthentication?: string;
    postAuthentication?: string;
    preTokenGeneration?: string;
    preTokenGenerationConfig?: {
      lambdaArn: string;
      lambdaVersion: "V1_0";
    };
  };
  userPoolTier: "ESSENTIALS" | "PLUS";
  deviceConfiguration?: {
    challengeRequiredOnNewDevice: boolean;
    deviceOnlyRememberedOnUserPrompt: boolean;
  };
}

export interface CognitoClientSecretEntryState {
  id: string;
  createdAt: number;
  envelope: CognitoRecoverableSecretState;
}

export interface CognitoAppClientState {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** @deprecated Retained for v76 state; normalized through clientSecrets at runtime. */
  secret?: CognitoRecoverableSecretState;
  clientSecrets?: CognitoClientSecretEntryState[];
  explicitAuthFlows: Array<
    | "ALLOW_USER_PASSWORD_AUTH"
    | "ALLOW_REFRESH_TOKEN_AUTH"
    | "ALLOW_USER_SRP_AUTH"
    | "ALLOW_ADMIN_USER_PASSWORD_AUTH"
  >;
  refreshTokenValidity: number;
  accessTokenValidity: number;
  idTokenValidity: number;
  tokenValidityUnits: {
    refreshToken: "seconds" | "minutes" | "hours" | "days";
    accessToken: "seconds" | "minutes" | "hours" | "days";
    idToken: "seconds" | "minutes" | "hours" | "days";
  };
  readAttributes: string[];
  writeAttributes: string[];
  preventUserExistenceErrors: "LEGACY" | "ENABLED";
  enableTokenRevocation: boolean;
  authSessionValidity: number;
  refreshTokenRotation: {
    feature: "ENABLED" | "DISABLED";
    retryGracePeriodSeconds: number;
  };
  supportedIdentityProviders: string[];
  callbackUrls: string[];
  logoutUrls: string[];
  defaultRedirectUri?: string;
  allowedOAuthFlows: Array<"code" | "implicit" | "client_credentials">;
  allowedOAuthScopes: string[];
  allowedOAuthFlowsUserPoolClient: boolean;
}

export interface CognitoResourceServerScopeState {
  name: string;
  description: string;
}

export interface CognitoResourceServerState {
  identifier: string;
  name: string;
  scopes: CognitoResourceServerScopeState[];
  createdAt: number;
  updatedAt: number;
}

export interface CognitoUserPoolDomainState {
  domain: string;
  managedLoginVersion: 1 | 2;
  createdAt: number;
  updatedAt: number;
}

export interface CognitoManagedLoginBrandingState {
  id: string;
  clientId: string;
  useCognitoProvidedValues: boolean;
  settings?: {
    pageTitle?: string;
    primaryColor?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface CognitoUiCustomizationState {
  clientId: string;
  css?: string;
  cssVersion?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CognitoAuthorizationCodeState {
  digest: string;
  clientId: string;
  userSub: string;
  userGenerationId: string;
  sessionEpoch: number;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  nonce?: string;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
  status: "ACTIVE" | "CONSUMED";
  consumedAt?: number;
}

export interface CognitoBrowserSessionState {
  digest: string;
  csrfDigest: string;
  createdAt: number;
  expiresAt: number;
  status: "ANONYMOUS" | "AUTHENTICATED" | "LOGGED_OUT";
  userSub?: string;
  userGenerationId?: string;
  sessionEpoch?: number;
}

export interface CognitoIdentityProviderState {
  name: string;
  type: "OIDC" | "SAML" | "Google" | "Facebook" | "LoginWithAmazon" | "SignInWithApple";
  providerDetails: Record<string, string>;
  clientSecret?: CognitoRecoverableSecretState;
  samlMetadata?: {
    entityId: string;
    ssoUrl: string;
    certificates: string[];
    certificate?: string;
    raw: string;
  };
  attributeMapping: Record<string, string>;
  idpIdentifiers: string[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface CognitoFederationAuthorizationState {
  clientId: string;
  redirectUri: string;
  responseType: "code" | "token";
  scopes: string[];
  state?: string;
  nonce?: string;
  codeChallenge?: string;
}

export interface CognitoFederationTransactionState {
  digest: string;
  kind: "OIDC" | "SAML";
  providerName: string;
  providerRevision: number;
  authorization: CognitoFederationAuthorizationState;
  nonceDigest?: string;
  requestIdDigest?: string;
  createdAt: number;
  expiresAt: number;
  status: "ACTIVE" | "CONSUMED";
  consumedAt?: number;
}

export interface CognitoGroupState {
  name: string;
  description?: string;
  roleArn?: string;
  precedence?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CognitoChallengeState {
  id: string;
  purpose:
    | "NEW_PASSWORD_REQUIRED"
    | "PASSWORD_VERIFIER"
    | "SELECT_MFA_TYPE"
    | "SOFTWARE_TOKEN_MFA"
    | "MFA_SETUP"
    | "EMAIL_OTP"
    | "DEVICE_SRP_AUTH"
    | "DEVICE_PASSWORD_VERIFIER";
  poolId: string;
  clientId: string;
  userSub: string;
  userGenerationId: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  status: "ACTIVE" | "CONSUMED" | "EXPIRED" | "CANCELLED";
  clientMetadata?: Record<string, string>;
  secretBlock?: string;
  srpA?: string;
  srpB?: string;
  salt?: string;
  verifier?: string;
  srpKey?: CognitoRecoverableSecretState;
  deviceKey?: string;
  deliveryIntentId?: string;
}

export interface CognitoPendingDeviceState {
  key: string;
  groupKey: string;
  clientId: string;
  eventId: string;
  createdAt: number;
  expiresAt: number;
}

export interface CognitoDeviceState {
  key: string;
  groupKey: string;
  name?: string;
  rememberedStatus: "remembered" | "not_remembered";
  createdAt: number;
  lastAuthenticatedAt?: number;
  lastModifiedAt: number;
  clientId?: string;
  /** @deprecated Plaintext COG-07 shape; migrated to passwordVerifier/salt envelopes. */
  secretVerifier?: {
    passwordVerifier: string;
    salt: string;
  };
  passwordVerifier?: CognitoRecoverableSecretState;
  salt?: CognitoRecoverableSecretState;
}

export interface CognitoAuthEventState {
  eventId: string;
  userSub: string;
  createdAt: number;
  eventType: "SignIn" | "PasswordChange" | "PasswordReset" | "Mfa";
  feedbackValue?: "Valid" | "Invalid";
}

export interface CognitoUserPoolState {
  id: string;
  arn: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: "ACTIVE";
  configuration: CognitoUserPoolConfigurationState;
  signingKeys?: CognitoSigningKeysState;
  clients: Record<string, CognitoAppClientState>;
  clientNameIndex: Record<string, string>;
  usersBySub: Record<string, CognitoUserState>;
  usernameIndex: Record<string, string>;
  aliasIndex: Record<string, string>;
  refreshSessions: Record<string, CognitoRefreshSessionState>;
  groups: Record<string, CognitoGroupState>;
  challenges: Record<string, CognitoChallengeState>;
  authEvents: CognitoAuthEventState[];
  tags: Record<string, string>;
  resourceServers: Record<string, CognitoResourceServerState>;
  domain?: CognitoUserPoolDomainState;
  managedLoginBranding: Record<string, CognitoManagedLoginBrandingState>;
  uiCustomizations: Record<string, CognitoUiCustomizationState>;
  authorizationCodes: Record<string, CognitoAuthorizationCodeState>;
  browserSessions: Record<string, CognitoBrowserSessionState>;
  identityProviders: Record<string, CognitoIdentityProviderState>;
  identityProviderIdentifierIndex: Record<string, string>;
  federatedIdentityIndex: Record<string, string>;
  federationTransactions: Record<string, CognitoFederationTransactionState>;
  federationReplayIds: Record<string, number>;
}

export interface CognitoIssuerTombstoneState {
  issuer: string;
  poolId: string;
  deletedAt: number;
  minimumRetainUntil: number;
}

export interface CognitoAuditEventState {
  id: string;
  at: number;
  operation: string;
  outcome: "SUCCESS" | "CLIENT_ERROR" | "SERVER_ERROR";
  poolId?: string;
}

export interface CognitoAdmissionBucketState {
  kind: "SIGN_UP" | "PASSWORD" | "REFRESH";
  poolId: string;
  clientId: string;
  timestamps: number[];
}

export interface CognitoRegionState {
  revision: number;
  pools: Record<string, CognitoUserPoolState>;
  poolNameIndex: Record<string, string>;
  issuerTombstones: Record<string, CognitoIssuerTombstoneState>;
  deliveryIntents: Record<string, CognitoDeliveryIntentState>;
  admissions: Record<string, CognitoAdmissionBucketState>;
  audit: CognitoAuditEventState[];
  domainIndex: Record<string, string>;
}

export interface SnsMessageAttributeState {
  dataType: string;
  stringValue?: string;
  binaryValueBase64?: string;
}

export interface SnsTopicState {
  name: string;
  arn: string;
  generation: string;
  createdAt: number;
  updatedAt: number;
  displayName?: string;
  policy: string;
  signatureVersion: "1" | "2";
  sqsSuccessFeedbackRoleArn?: string;
  sqsSuccessFeedbackSampleRate: number;
  sqsFailureFeedbackRoleArn?: string;
  lambdaSuccessFeedbackRoleArn?: string;
  lambdaSuccessFeedbackSampleRate: number;
  lambdaFailureFeedbackRoleArn?: string;
  cloudFormationOwner?: string;
  policyOwner?: string;
  policyBaseline?: string;
  tags: Record<string, string>;
  subscriptionArns: string[];
}

export interface SnsSubscriptionState {
  arn: string;
  id: string;
  generation: string;
  topicArn: string;
  topicGeneration: string;
  protocol: "sqs" | "lambda";
  endpoint: string;
  ownerAccountId: string;
  createdAt: number;
  filterPolicy?: string;
  filterPolicyScope: "MessageAttributes" | "MessageBody";
  rawMessageDelivery: boolean;
  redrivePolicy?: string;
  filterRevision: number;
  deliveryRevision: number;
  cloudFormationOwner?: string;
  cloudFormationInline?: boolean;
}

export interface SnsRegionState {
  revision: number;
  topics: Record<string, SnsTopicState>;
  subscriptions: Record<string, SnsSubscriptionState>;
}

export interface ParameterVersionState {
  version: number;
  createdAt: number;
  lastModifiedUser: string;
  description?: string;
  allowedPattern?: string;
  storageKind: "PLAIN" | "ENCRYPTED";
  value?: string;
  materialId?: string;
}

export interface ParameterPolicyState {
  type: "Expiration" | "ExpirationNotification" | "NoChangeNotification";
  version: "1.0";
  attributes: Readonly<Record<string, string>>;
  dueAt: number;
  occurrenceId: string;
}

export interface ParameterStoreEventOutboxState {
  id: string;
  detailType: "Parameter Store Change" | "Parameter Store Policy Action";
  parameterName: string;
  parameterArn: string;
  detail: Readonly<Record<string, string>>;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface ParameterState {
  name: string;
  arn: string;
  generationId: string;
  type: "String" | "StringList" | "SecureString";
  dataType: "text";
  tier: "Standard" | "Advanced";
  policies: ParameterPolicyState[];
  description?: string;
  allowedPattern?: string;
  currentVersion: number;
  versions: Record<string, ParameterVersionState>;
  /** One authoritative label-to-version map. A label can never resolve to two versions. */
  labels: Record<string, number>;
  tags: Record<string, string>;
  owner: "application" | "stacksim:cdk-bootstrap";
  /** Private authoritative ownership marker; never returned by SSM APIs. */
  cloudFormationOwner?: string;
  /** A retained CloudFormation resource may be claimed by a later matching provider create. */
  cloudFormationRetained?: boolean;
  createdAt: number;
  lastModifiedAt: number;
  revision: number;
}

export interface ParameterStoreRegionState {
  revision: number;
  parameters: Record<string, ParameterState>;
  tombstones: Record<string, { generationId: string; deletedAt: number; reusableAt: number; cloudFormationOwner?: string }>;
  eventOutbox?: ParameterStoreEventOutboxState[];
  completedPolicyOccurrences?: Record<string, number>;
}

export interface SecretVersionState {
  versionId: string;
  createdAt: number;
  valueKind: "SecretString" | "SecretBinary";
  materialId: string;
  stages: string[];
}

export interface SecretRotationRulesState {
  automaticallyAfterDays?: number;
  duration?: string;
  scheduleExpression: string;
  durationMs: number;
}

export interface SecretRotationOperationState {
  token: string;
  status: "ACTIVE" | "CANCELLING" | "CANCELLED" | "FAILED" | "SUCCEEDED";
  step: "createSecret" | "setSecret" | "testSecret" | "finishSecret";
  completedSteps: Array<"createSecret" | "setSecret" | "testSecret" | "finishSecret">;
  attempts: Partial<Record<"createSecret" | "setSecret" | "testSecret" | "finishSecret", number>>;
  startedAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  scheduled: boolean;
  testOnly: boolean;
  tested: boolean;
  leaseId?: string;
  leaseUntil?: number;
  lastRequestId?: string;
  errorSummary?: string;
}

export interface SecretRotationState {
  enabled: boolean;
  lambdaArn: string;
  rules: SecretRotationRulesState;
  configuredAt: number;
  nextRotationAt?: number;
  lastRotatedAt?: number;
  lastStatus?: "CANCELLED" | "FAILED" | "SUCCEEDED";
  lastErrorSummary?: string;
  /** Private authoritative owner for AWS::SecretsManager::RotationSchedule. */
  cloudFormationOwner?: string;
  cloudFormationRotateImmediatelyOnUpdate?: boolean;
  operation?: SecretRotationOperationState;
}

export interface SecretTargetAttachmentState {
  targetType: "AWS::RDS::DBInstance";
  targetId: string;
  targetArn: string;
  targetGenerationId: string;
  attachedAt: number;
  cloudFormationOwner?: string;
}

export interface SecretState {
  name: string;
  arn: string;
  arnSuffix: string;
  generationId: string;
  description?: string;
  tags: Record<string, string>;
  versions: Record<string, SecretVersionState>;
  createdAt: number;
  lastChangedAt: number;
  lastAccessedAt?: number;
  deletedAt?: number;
  resourcePolicy?: {
    /** Caller-authored JSON returned by GetResourcePolicy. */
    document: string;
    /** Structurally validated canonical form used by the evaluator. */
    normalized: PolicyDocument;
    revision: number;
    updatedAt: number;
    validation: {
      publicPolicy: boolean;
      callerLockout: boolean;
      checkedAt: number;
    };
    /** Private authoritative owner for AWS::SecretsManager::ResourcePolicy. */
    cloudFormationOwner?: string;
  };
  /** Monotonic even across policy deletion, so a restart cannot lose update lineage. */
  policyRevision: number;
  owner: "application";
  /** Private authoritative owner for AWS::SecretsManager::Secret. */
  cloudFormationOwner?: string;
  /** Safe provider metadata; never contains generated or caller-supplied secret material. */
  cloudFormationGeneration?: Readonly<Record<string, unknown>>;
  rotation?: SecretRotationState;
  targetAttachment?: SecretTargetAttachmentState;
  owningService?: "rds.amazonaws.com";
  managedResourceArn?: string;
  revision: number;
}

export interface SecretsManagerRegionState {
  revision: number;
  secrets: Record<string, SecretState>;
  retiredSuffixes: Record<string, string[]>;
}

export interface AppSyncApiKeyState {
  keyId: string;
  materialId: string;
  description?: string;
  expires: number;
  deletes: number;
  createdAt: number;
  updatedAt: number;
}

export interface AppSyncDataSourceState {
  name: string;
  arn: string;
  description?: string;
  type: "NONE" | "AMAZON_DYNAMODB";
  serviceRoleArn?: string;
  dynamodbConfig?: {
    tableName: string;
    awsRegion: string;
  };
  generation: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface AppSyncResolverState {
  typeName: string;
  fieldName: string;
  arn: string;
  generation: string;
  dataSourceName?: string;
  requestMappingTemplate: string;
  responseMappingTemplate: string;
  kind: "UNIT" | "PIPELINE";
  pipelineConfig?: { functions: string[] };
  requestMappingTemplateDigest?: string;
  responseMappingTemplateDigest?: string;
  runtime: "VTL";
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface AppSyncFunctionState {
  functionId: string;
  functionArn: string;
  name: string;
  description?: string;
  dataSourceName: string;
  requestMappingTemplate: string;
  responseMappingTemplate: string;
  requestMappingTemplateDigest: string;
  responseMappingTemplateDigest: string;
  functionVersion: "2018-05-29";
  runtime: "VTL";
  generation: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface AppSyncGraphqlApiState {
  apiId: string;
  generation: string;
  arn: string;
  name: string;
  authenticationType: "API_KEY";
  additionalAuthenticationProviders: Array<{ authenticationType: "AWS_IAM" }>;
  uris: Record<"GRAPHQL" | "REALTIME", string>;
  tags: Record<string, string>;
  xrayEnabled: false;
  visibility: "GLOBAL";
  apiType: "GRAPHQL";
  owner: string;
  ownerContact?: string;
  introspectionConfig: "ENABLED" | "DISABLED";
  queryDepthLimit: number;
  resolverCountLimit: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  schema?: {
    generation: string;
    digest: string;
    definition: string;
    status: "SUCCESS";
    activatedAt: number;
  };
  pendingSchema?: {
    generation: string;
    digest: string;
    definition: string;
    status: "PROCESSING" | "FAILED";
    createdAt: number;
    completedAt?: number;
    details?: string;
  };
  schemaStatus: "NOT_APPLICABLE" | "PROCESSING" | "SUCCESS" | "FAILED";
  schemaStatusDetails?: string;
  apiKeys: Record<string, AppSyncApiKeyState>;
  dataSources: Record<string, AppSyncDataSourceState>;
  functions: Record<string, AppSyncFunctionState>;
  resolvers: Record<string, AppSyncResolverState>;
}

export interface AppSyncRegionState {
  revision: number;
  graphqlApis: Record<string, AppSyncGraphqlApiState>;
}

export interface StepFunctionsStateMachineState {
  stateMachineArn: string;
  name: string;
  generation: string;
  type: "STANDARD";
  status: "ACTIVE";
  definition: string;
  roleArn: string;
  revisionId: string;
  creationDate: number;
  updateDate: number;
  loggingConfiguration: { level: "OFF"; includeExecutionData: false; destinations: [] };
  tracingConfiguration: { enabled: false };
  encryptionConfiguration: { type: "AWS_OWNED_KEY" };
  tags: Record<string, string>;
}

export interface StepFunctionsHistoryEventState {
  timestamp: number;
  type: string;
  id: number;
  previousEventId: number;
  [details: string]: unknown;
}

export interface StepFunctionsTaskJournalState {
  taskId: string;
  schemaVersion?: 1 | 2;
  stateName: string;
  targetArn: string;
  input: string;
  inputDigest?: string;
  service?: "DYNAMODB" | "SQS" | "SNS" | "EVENTBRIDGE" | "LAMBDA";
  operation?: string;
  status: "UNDISPATCHED" | "DISPATCHED" | "ACCEPTED" | "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
  dispatchedAt?: number;
  startedEventRecorded?: boolean;
  acceptedAt?: number;
  completedAt?: number;
  output?: unknown;
  error?: string;
  cause?: string;
}

export interface ServiceIntegrationAttemptState {
  attemptId: string;
  inputDigest: string;
  operation: string;
  targetArn: string;
  executionArn: string;
  stateMachineArn: string;
  roleArn: string;
  sourceArn: string;
  lineage: string[];
  status: "ACCEPTED" | "FAILED";
  acceptedAt: number;
  output?: unknown;
  error?: string;
  cause?: string;
}

export type ServiceIntegrationAttemptMetadataState = Omit<ServiceIntegrationAttemptState, "output"> & { outputDigest: string };

export interface StepFunctionsCallbackTaskState {
  tokenId: string;
  tokenDigest: string;
  kind: "CALLBACK" | "ACTIVITY";
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
  stateName: string;
  taskAttemptId: string;
  createdAt: number;
  input?: unknown;
  heartbeatSeconds?: number;
  heartbeatDeadline?: number;
  timeoutDeadline?: number;
  activityArn?: string;
  workerName?: string;
  leaseUntil?: number;
  scheduledEventRecorded?: boolean;
  startedEventRecorded?: boolean;
  completionEventRecorded?: boolean;
  output?: unknown;
  error?: string;
  cause?: string;
}

export interface StepFunctionsNestedExecutionState {
  executionArn: string;
  pattern: "REQUEST_RESPONSE" | "RUN_JOB" | "WAIT_FOR_TASK_TOKEN";
  timeoutDeadline?: number;
  completionEventRecorded?: boolean;
}

export interface StepFunctionsActivityState {
  activityArn: string;
  name: string;
  generation: string;
  creationDate: number;
  tags: Record<string, string>;
  encryptionConfiguration: { type: "AWS_OWNED_KEY" };
}

export interface StepFunctionsActiveStateState {
  entryId: string;
  name: string;
  input: unknown;
}

export interface StepFunctionsChildState {
  childId: string;
  kind: "PARALLEL" | "MAP";
  slot: number;
  mapItemValue?: unknown;
  definition?: string;
  status: "PLANNED" | "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  currentState: string;
  currentInput: unknown;
  activeState?: StepFunctionsActiveStateState;
  nested?: StepFunctionsNestedState;
  waitingUntil?: number;
  waitingKind?: "WAIT" | "RETRY" | "NESTED";
  retryAttempts: Record<string, number>;
  output?: unknown;
  error?: string;
  cause?: string;
  history: StepFunctionsHistoryEventState[];
}

export interface StepFunctionsNestedState {
  parentState: string;
  kind: "PARALLEL" | "MAP";
  maximumConcurrency: number;
  sharedDefinition?: string;
  children: StepFunctionsChildState[];
  historyCommitted?: true;
}

export interface StepFunctionsExecutionState {
  executionArn: string;
  stateMachineArn: string;
  stateMachineGeneration: string;
  name: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED";
  startDate: number;
  stopDate?: number;
  input: string;
  inputDetails: { included: true };
  output?: string;
  outputDetails?: { included: true };
  error?: string;
  cause?: string;
  definition: string;
  roleArn: string;
  revisionId: string;
  currentState?: string;
  currentInput?: unknown;
  activeState?: StepFunctionsActiveStateState;
  nested?: StepFunctionsNestedState;
  taskJournal?: Record<string, StepFunctionsTaskJournalState>;
  callbackTasks?: Record<string, StepFunctionsCallbackTaskState>;
  nestedExecutions?: Record<string, StepFunctionsNestedExecutionState>;
  waitingUntil?: number;
  waitingKind?: "WAIT" | "RETRY";
  retryAttempts: Record<string, number>;
  history: StepFunctionsHistoryEventState[];
  lineage?: string[];
}

export interface StepFunctionsRegionState {
  revision: number;
  stateMachines: Record<string, StepFunctionsStateMachineState>;
  stateMachineNames: Record<string, string>;
  executions: Record<string, StepFunctionsExecutionState>;
  executionNames: Record<string, string>;
  activities: Record<string, StepFunctionsActivityState>;
  activityNames: Record<string, string>;
}

export interface XRayRegionState {
  /** XRY-01 control-plane marker. High-volume trace documents live in the private SQLite repository. */
  revision: 1;
}

export interface RegionState {
  cloudformation: CloudFormationRegionState;
  parameterStore: ParameterStoreRegionState;
  secretsManager: SecretsManagerRegionState;
  appsync: AppSyncRegionState;
  stepFunctions: StepFunctionsRegionState;
  xray: XRayRegionState;
  ses: SesRegionState;
  cognito: CognitoRegionState;
  sns: SnsRegionState;
  rdsDbInstances: Record<string, RdsDbInstanceState>;
  rdsDbParameterGroups: Record<string, RdsDbParameterGroupState>;
  rdsDbSnapshots: Record<string, RdsDbSnapshotState>;
  s3Buckets: Record<string, S3BucketState>;
  sqsQueues: Record<string, SqsQueueState>;
  sqsQueueDeletionTimes: Record<string, number>;
  eventBuses: Record<string, EventBridgeEventBusState>;
  eventRules: Record<string, EventBridgeRuleState>;
  eventTargets: Record<string, Record<string, EventBridgeTargetState>>;
  eventScheduleGroups: Record<string, EventBridgeScheduleGroupState>;
  eventSchedules: Record<string, EventBridgeScheduleState>;
  eventScheduleOccurrences: Record<string, EventBridgeScheduleOccurrenceState>;
  tables: Record<string, TableState>;
  dynamodbBackups: Record<string, DynamoBackupState>;
  dynamodbExports: Record<string, DynamoExportState>;
  dynamodbImports: Record<string, DynamoImportState>;
  dynamodbStreams: Record<string, DynamoStreamDescriptorState>;
  dynamodbResourcePolicies: Record<string, DynamoResourcePolicyState>;
  dynamodbResourcePolicyMutationTimes: Record<string, number>;
  dynamodbIntegrationAttempts: Record<string, ServiceIntegrationAttemptMetadataState | ServiceIntegrationAttemptState>;
  functions: Record<string, LambdaState>;
  lambdaLayers: Record<string, LambdaLayerState>;
  lambdaCodeSigningConfigs: Record<string, LambdaCodeSigningConfigState>;
  lambdaCapacityProviders: Record<string, LambdaCapacityProviderState>;
  lambdaDurableExecutions: Record<string, LambdaDurableExecutionState>;
  lambdaAsyncInvocations: Record<string, LambdaAsyncInvocationState>;
  lambdaEventSourceMappings: Record<string, LambdaEventSourceMappingState>;
  apis: Record<string, RestApiState>;
  apiGatewayAccount: ApiGatewayAccountState;
  apiGatewayApiKeys: Record<string, ApiGatewayApiKeyState>;
  apiGatewayUsagePlans: Record<string, ApiGatewayUsagePlanState>;
  apiGatewayResponseCaches: Record<string, ApiGatewayStageCacheState>;
  apiGatewayDomainNames: Record<string, ApiGatewayDomainNameState>;
  apiGatewayDomainNameAccessAssociations: Record<string, ApiGatewayDomainNameAccessAssociationState>;
  apiGatewayVpcLinks: Record<string, ApiGatewayVpcLinkState>;
  apiGatewayClientCertificates: Record<string, ApiGatewayClientCertificateState>;
  httpApis: Record<string, HttpApiState>;
  webSocketApis: Record<string, WebSocketApiState>;
  apiGatewayV2DomainNames: Record<string, ApiGatewayV2DomainNameState>;
  logs: Record<string, LogGroupState>;
  logQueryDefinitions: Record<string, LogQueryDefinitionState>;
  logQueryJobs: Record<string, LogQueryJobState>;
  logDestinations: Record<string, LogDestinationState>;
  logResourcePolicies: Record<string, LogResourcePolicyState>;
  logExportTasks: Record<string, LogExportTaskState>;
  cloudwatch: CloudWatchState;
  dynamodbTransactionTokens?: Record<string, { hash: string; expiresAt: number; response: unknown }>;
}

export interface RdsDbInstanceState {
  dbInstanceIdentifier: string;
  dbiResourceId: string;
  dbInstanceArn: string;
  dbInstanceClass: string;
  dbInstanceStatus: "creating" | "available" | "backing-up" | "modifying" | "rebooting" | "stopping" | "stopped" | "starting" | "deleting" | "failed";
  engine: "mysql";
  engineVersion: string;
  allocatedStorage: number;
  storageType: "gp2" | "gp3";
  dbName?: string;
  masterUsername: string;
  port: number;
  backupRetentionPeriod: 0;
  publiclyAccessible: false;
  multiAZ: false;
  deletionProtection: boolean;
  dbParameterGroupName: string;
  parameterApplyStatus: "in-sync" | "pending-reboot";
  /** Values proven to be active in the managed engine. Passwords never belong here. */
  appliedParameters: Record<string, string>;
  pendingModifiedValues?: RdsPendingModifiedValuesState;
  /** True only while a persisted ModifyDBInstance worker is applying deferred descriptor/port values. */
  applyPendingConfiguration?: boolean;
  lifecycleOperation?: "modify" | "reboot" | "stop" | "start";
  /** Snapshot ARN retained only while a restart-safe restore worker owns the new instance. */
  restoreSourceSnapshotArn?: string;
  availabilityZone: string;
  instanceCreateTime: number;
  tags: Record<string, string>;
  providerEngine?: "sqlite" | "mariadb";
  providerVersion?: string;
  statusMessage?: string;
  manageMasterUserPassword?: boolean;
  masterUserSecretArn?: string;
  managedCredentialSaga?: {
    secretArn: string;
    secretGenerationId: string;
    pendingVersionId: string;
    previousVersionId: string;
    credentialGenerationId: string;
    phase: "STAGED" | "TARGET_VERIFIED" | "FINALIZING" | "COMPENSATING";
    targetApplied: boolean;
    targetFingerprint: string;
    updatedAt: number;
  };
}

export interface RdsDbSnapshotState {
  dbSnapshotIdentifier: string;
  dbSnapshotArn: string;
  snapshotResourceId: string;
  dbInstanceIdentifier: string;
  sourceDbiResourceId: string;
  status: "creating" | "copying" | "available" | "deleting" | "failed";
  snapshotType: "manual";
  snapshotCreateTime: number;
  engine: "mysql";
  engineVersion: string;
  allocatedStorage: number;
  storageType: "gp2" | "gp3";
  port: number;
  availabilityZone: string;
  dbName?: string;
  dbParameterGroupName: string;
  appliedParameters: Record<string, string>;
  tags: Record<string, string>;
  restoreAttributes: string[];
  manifestChecksum?: string;
  dataSizeBytes?: number;
  fileCount?: number;
  sourceSnapshotIdentifier?: string;
  sourceSnapshotArn?: string;
  statusMessage?: string;
}

export interface RdsPendingModifiedValuesState {
  allocatedStorage?: number;
  dbInstanceClass?: string;
  storageType?: "gp2" | "gp3";
  port?: number;
  /** Records only that a private pending secret exists; the value is never persisted in control state. */
  masterUserPassword?: true;
}

export interface RdsDbParameterGroupState {
  dbParameterGroupName: string;
  dbParameterGroupFamily: "mysql8.0";
  description: string;
  dbParameterGroupArn: string;
  createdAt: number;
  tags: Record<string, string>;
  parameters: Record<string, { value: string; applyMethod: "immediate" | "pending-reboot"; modifiedAt: number }>;
}

export interface RdsInstanceLease {
  accountId: string;
  region: string;
  dbInstanceIdentifier: string;
  dbiResourceId: string;
  port: number;
}

export interface CloudFrontResourceOwnerState {
  stackId: string;
  logicalId: string;
  createOperationId: string;
}

export interface CloudFrontFunctionRevisionState {
  etag: string;
  code: string;
  runtime: "cloudfront-js-1.0";
  comment: string;
  createdAt: number;
  lastModifiedAt: number;
  version: number;
}

export interface CloudFrontFunctionState {
  name: string;
  arn: string;
  development: CloudFrontFunctionRevisionState;
  live?: CloudFrontFunctionRevisionState;
  tags: Record<string, string>;
  cloudFormationOwner?: CloudFrontResourceOwnerState;
}

export interface CloudFrontOriginAccessControlState {
  id: string;
  arn: string;
  etag: string;
  name: string;
  description: string;
  originType: "s3";
  signingBehavior: "always";
  signingProtocol: "sigv4";
  createdAt: number;
  lastModifiedAt: number;
  cloudFormationOwner?: CloudFrontResourceOwnerState;
}

export interface CloudFrontResponseHeadersPolicyState {
  id: string;
  arn: string;
  etag: string;
  name: string;
  comment: string;
  securityHeadersConfig: Record<string, unknown>;
  createdAt: number;
  lastModifiedAt: number;
  cloudFormationOwner?: CloudFrontResourceOwnerState;
}

export interface CloudFrontDistributionState {
  id: string;
  arn: string;
  domainName: string;
  localViewerPort: number;
  callerReference: string;
  etag: string;
  status: "InProgress" | "Deployed";
  configRevision: number;
  deployedRevision?: number;
  config: Record<string, unknown>;
  deployedConfig?: Record<string, unknown>;
  tags: Record<string, string>;
  createdAt: number;
  lastModifiedAt: number;
  cloudFormationOwner?: CloudFrontResourceOwnerState;
}

export interface CloudFrontInvalidationState {
  id: string;
  distributionId: string;
  callerReference: string;
  paths: string[];
  status: "InProgress" | "Completed";
  createTime: number;
}

export interface CloudFrontAccountState {
  schemaVersion: 1;
  revision: number;
  distributions: Record<string, CloudFrontDistributionState>;
  distributionCallerReferences: Record<string, string>;
  functions: Record<string, CloudFrontFunctionState>;
  originAccessControls: Record<string, CloudFrontOriginAccessControlState>;
  originAccessControlNames: Record<string, string>;
  responseHeadersPolicies: Record<string, CloudFrontResponseHeadersPolicyState>;
  responseHeadersPolicyNames: Record<string, string>;
  invalidations: Record<string, Record<string, CloudFrontInvalidationState>>;
  invalidationCallerReferences: Record<string, Record<string, string>>;
}

export interface AccountState {
  iam: IamState;
  cloudwatchDashboards: Record<string, CloudWatchDashboardState>;
  /** Account-global CloudFront control state. Edge cache bytes remain derived and process-local. */
  cloudfront: CloudFrontAccountState;
  /** Account-level S3 Block Public Access configuration exposed through S3 Control. */
  s3PublicAccessBlock?: {
    blockPublicAcls: boolean;
    ignorePublicAcls: boolean;
    blockPublicPolicy: boolean;
    restrictPublicBuckets: boolean;
  };
  regions: Record<string, RegionState>;
}

export interface SimState {
  schemaVersion: number;
  installation: { id: string; paginationSecret: string; s3EncryptionKey: string; sqsEncryptionKey: string; snsEncryptionKey: string; eventBridgeArchiveEncryptionKey: string; sesSigningSecret: string; s3BucketNames: Record<string, { accountId: string; region: string }>; rds: { instanceLease?: RdsInstanceLease }; defaultAdministrators: Record<string, DefaultAdministratorInitialization> };
  accounts: Record<string, AccountState>;
}

export interface DefaultAdministratorInitialization {
  version: 1;
  initialized: boolean;
  accountId: string;
  originalUserName?: string;
  originalUserId?: string;
  currentUserName?: string;
  configuredAccessKeyId?: string;
  configurationFingerprint?: string;
  deletedConfiguredKeyFingerprint?: string;
  initializedAt?: number;
  firstConsoleLogin: {
    status: "pending" | "presented" | "notApplicable";
    claimId?: string;
    presentedBootId?: string;
    claimedConfiguredAccessKeyId?: string;
    claimedConfiguredCredentialId?: string;
    claimedConfigurationFingerprint?: string;
    presentedAt?: number;
    outcome?: "keptDefault" | "rotationCompleted" | "rotationIncomplete";
    staleReason?: "configuredCredentialRotated";
    outcomeAt?: number;
    replacementAccessKeyId?: string;
  };
}
