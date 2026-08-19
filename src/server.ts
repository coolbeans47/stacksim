import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createSecureServer, type Server as HttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ApiGatewayService } from "./apigateway.js";
import { ApiGatewayV2Service, type HttpApiJwtJwks } from "./apigateway-v2.js";
import { ApiGatewayWebSocketService } from "./apigateway-websocket.js";
import { CloudWatchLogsService } from "./cloudwatch-logs.js";
import { CloudWatchMetricsService, type MetricRetentionSchedule } from "./cloudwatch-metrics.js";
import { SystemClock, type Clock } from "./core/clock.js";
import { requestId } from "./core/request-id.js";
import { Scheduler } from "./core/scheduler.js";
import { TelemetryBus } from "./core/telemetry.js";
import { DynamoDbService, type DynamoTtlSchedule } from "./dynamodb.js";
import { classifyPartiqlAccess, parsePartiql } from "./dynamodb/partiql.js";
import { LambdaService } from "./lambda.js";
import { IamService } from "./iam.js";
import { StsService } from "./sts.js";
import { S3Service } from "./s3.js";
import { SqsService } from "./sqs.js";
import { StepFunctionsService } from "./step-functions.js";
import { SNS_02_ACTIONS, SnsService } from "./sns.js";
import { SsmService, sendSsmError, ssmParameterArn } from "./ssm.js";
import { SecretsManagerService, sendSecretsManagerError } from "./secrets-manager.js";
import { evaluateSqsQueuePolicy } from "./sqs/policy.js";
import { EventBridgeService } from "./eventbridge.js";
import { EventBridgeSchedulerService } from "./eventbridge-scheduler.js";
import { RdsManager, RdsService } from "./rds.js";
import { CLOUDFORMATION_SUPPORTED_ACTIONS, CloudFormationService } from "./cloudformation.js";
import { CloudFormationBootstrapManager } from "./cloudformation/bootstrap.js";
import { CustomResourceCallbackBroker } from "./cloudformation/custom-resource-callbacks.js";
import {
  CLOUDFORMATION_CUSTOM_RESOURCE_TYPE,
  createApiGatewayRestCfn15CloudFormationProviders,
  createApiGatewayV2CloudFormationProviders,
  createApiGatewayRestCloudFormationProviders,
  createCfn09CloudFormationProviders,
  createCdkBucketDeploymentProvider,
  createCloudWatchMetricStreamProvider,
  createCognitoCloudFormationProviders,
  createDynamoDbGlobalTableProvider,
  createDynamoDbTableProvider,
  createIamCloudFormationProviders,
  createLambdaCfn15Providers,
  createLambdaCompanionProviders,
  createLambdaFunctionProvider,
  createLambdaLayerVersionProvider,
  createLambdaCustomResourceProvider,
  createAmplifyCustomResourceProviders,
  createLogsCfn10Providers,
  createCloudWatchCfn10Providers,
  createLogGroupProvider,
  createRdsCloudFormationProviders,
  createS3BucketPolicyProvider,
  createS3BucketProvider,
  createSsmParameterProvider,
  createSecretsManagerSecretProvider,
  createSecretsManagerResourcePolicyProvider,
  createSecretsManagerRotationScheduleProvider,
  createSecretsManagerSecretTargetAttachmentProvider,
  createSesCloudFormationProviders,
  createSqsQueuePolicyProvider,
  createSnsCloudFormationProviders,
  createStepFunctionsStateMachineProvider,
  createAppSyncCloudFormationProviders,
} from "./cloudformation/providers/index.js";
import { EmbeddedSqliteProvider } from "./rds/embedded-sqlite.js";
import { ManagedMariaDbProvider } from "./rds/managed-mariadb.js";
import type { RdsEngineProvider } from "./rds/provider.js";
import { authenticateSigV4, principalWithoutValidation, type PrincipalContext } from "./auth/sigv4.js";
import { authorizationTarget, executeApiTarget, type AuthorizationTarget } from "./auth/target.js";
import { combineIdentityAndResourceAuthorization, evaluateAuthorization, evaluateResourcePolicy, evaluateRoleAuthorization, evaluateTrust, roleSessionAuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import { AwsError, sendAwsError } from "./errors.js";
import { awsQueryErrorXml, parseAwsQuery } from "./protocols/query-xml.js";
import { sendS3Error } from "./protocols/rest-xml.js";
import { StateStore } from "./state.js";
import { json, readBody, readJson } from "./util.js";
import { SesService } from "./ses.js";
import { SES_V1_PHASE_01_02_ACTIONS, sendSesV1Error } from "./ses/protocol-v1.js";
import { sendSesV2Error } from "./ses/protocol-v2.js";
import { verifyVerificationToken } from "./ses/verification-links.js";
import { CognitoService } from "./cognito.js";
import { cognitoTargetOperation, isCognitoNonIamTarget } from "./cognito/action-inventory.js";
import { sendCognitoError } from "./cognito/protocol.js";
import { CognitoSecrets } from "./cognito/secrets.js";
import { CognitoPasswordHasher } from "./cognito/passwords.js";
import { IamCredentialStore } from "./iam/credentials.js";
import { initializeDefaultAdministrator } from "./iam/default-admin.js";
import { AppSyncService } from "./appsync.js";
import { policyValidationReport } from "./iam/policy-validation.js";

function booleanEnvironment(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be exactly true or false`);
  return value === "true";
}

export interface SimulatorOptions {
  port?: number;
  invokePort?: number;
  host?: string;
  region?: string;
  dataDir?: string;
  accountId?: string;
  clock?: Clock;
  authMode?: "off" | "validate" | "enforce";
  seedDefaultAdmin?: boolean;
  defaultUserName?: string;
  defaultAccessKeyId?: string;
  defaultSecretAccessKey?: string;
  cdkBootstrap?: boolean;
  /** Advertise AppSync GraphQL and realtime URLs on the existing loopback TLS listener. */
  appSyncLocalTls?: boolean;
  rootRecovery?: boolean;
  allowInsecureRecoveryRoot?: boolean;
  /** @deprecated Use cdkBootstrap and rootRecovery. */
  bootstrapRoot?: boolean;
  /** Test-only compatibility gate. Defaults to every production application provider. */
  cloudFormationProviderTypes?: readonly string[];
  random?: () => number;
  metricRetention?: Partial<MetricRetentionSchedule>;
  alarmHistoryRetentionMs?: number;
  dynamoTtlSchedule?: Partial<DynamoTtlSchedule>;
  dynamoEnforceCapacity?: boolean;
  dynamoStreamRetentionMs?: number;
  dynamoPolicyUpdateCooldownMs?: number;
  allowLocalFiles?: boolean;
  lambdaConcurrentExecutions?: number;
  lambdaUnreservedConcurrencyReserve?: number;
  apiGatewayRateLimit?: number;
  apiGatewayBurstLimit?: number;
  apiGatewayTlsCertificatePath?: string;
  apiGatewayTlsPrivateKeyPath?: string;
  apiGatewayJwtJwks?: Record<string, HttpApiJwtJwks>;
  apiGatewayAllowRemoteJwtJwks?: boolean;
  apiGatewayAllowPrivateJwtJwks?: boolean;
  apiGatewayWebSocketIdleTimeoutMs?: number;
  apiGatewayWebSocketLifetimeMs?: number;
  apiGatewayVpcLinkOrigins?: Record<string, string>;
  apiGatewayAllowClientCertificates?: boolean;
  s3MaximumObjectBytes?: number;
  s3MaximumBucketObjects?: number;
  s3MaximumBuckets?: number;
  s3MaximumTotalBytes?: number;
  rdsProvider?: RdsEngineProvider;
  rdsStartupTimeoutMs?: number;
  /** Dedicated trusted loopback HTTPS listener for CFN callbacks and their AWS SDK service calls. */
  cloudFormationCustomResourceCallbackPort?: number;
  sesMax24HourSend?: number;
  sesMaxSendRate?: number;
  sesPublicUrl?: string;
  sesMaximumMailboxMessages?: number;
  sesMaximumMailboxBytes?: number;
  snsMaximumTopics?: number;
  snsMaximumSubscriptions?: number;
  snsMaximumDeliveryMessages?: number;
  snsDeliveryRetentionMs?: number;
  stepFunctionsMaximumConcurrentExecutions?: number;
  stepFunctionsMaximumMapConcurrency?: number;
  stepFunctionsExecutionRetentionMs?: number;
  /** Stable loopback origin used for Cognito managed-login and OIDC tooling routes. */
  cognitoPublicUrl?: string;
  /** Permit Cognito federation calls to public HTTPS identity providers. */
  cognitoAllowPublicIdentityProviders?: boolean;
}

interface RegionalServices {
  cloudformation: CloudFormationService;
  ssm: SsmService;
  secretsmanager: SecretsManagerService;
  lambda: LambdaService;
  dynamodb: DynamoDbService;
  apigateway: ApiGatewayService;
  apigatewayv2: ApiGatewayV2Service;
  apigatewaywebsocket: ApiGatewayWebSocketService;
  logs: CloudWatchLogsService;
  metrics: CloudWatchMetricsService;
  telemetry: TelemetryBus;
  s3: S3Service;
  sqs: SqsService;
  sns: SnsService;
  eventbridge: EventBridgeService;
  eventscheduler: EventBridgeSchedulerService;
  rds: RdsService;
  ses: SesService;
  cognito: CognitoService;
  appsync: AppSyncService;
  stepfunctions: StepFunctionsService;
}

export class StackSim {
  readonly store: StateStore;
  readonly region: string;
  readonly lambda: LambdaService;
  readonly dynamodb: DynamoDbService;
  readonly apigateway: ApiGatewayService;
  readonly apigatewayv2: ApiGatewayV2Service;
  readonly apigatewaywebsocket: ApiGatewayWebSocketService;
  readonly logs: CloudWatchLogsService;
  readonly metrics: CloudWatchMetricsService;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly iam: IamService;
  readonly sts: StsService;
  readonly s3: S3Service;
  readonly sqs: SqsService;
  readonly sns: SnsService;
  readonly eventbridge: EventBridgeService;
  readonly eventscheduler: EventBridgeSchedulerService;
  readonly rds: RdsService;
  readonly cloudformation: CloudFormationService;
  readonly ssm: SsmService;
  readonly secretsmanager: SecretsManagerService;
  readonly ses: SesService;
  readonly cognito: CognitoService;
  readonly appsync: AppSyncService;
  readonly stepfunctions: StepFunctionsService;
  readonly authMode: "off" | "validate" | "enforce";
  readonly seedDefaultAdmin: boolean;
  readonly defaultUserName: string;
  readonly defaultAccessKeyId: string;
  private readonly defaultSecretAccessKey: string;
  readonly cdkBootstrap: boolean;
  readonly appSyncLocalTls: boolean;
  readonly rootRecovery: boolean;
  readonly allowInsecureRecoveryRoot: boolean;
  /** Raw deprecated compatibility input; not an authority decision. */
  readonly bootstrapRoot: boolean;
  private readonly legacyBootstrapRootSupplied: boolean;
  private readonly legacyBootstrapRootSource: "SimulatorOptions" | "environment" | null;
  private readonly legacyBootstrapRootOverriddenBy: string[];
  private readonly bootId = randomUUID();
  readonly random: () => number;
  private readonly metricRetention: Partial<MetricRetentionSchedule>;
  private readonly alarmHistoryRetentionMs?: number;
  private readonly dynamoTtlSchedule: Partial<DynamoTtlSchedule>;
  private readonly dynamoEnforceCapacity: boolean;
  private readonly dynamoStreamRetentionMs?: number;
  private readonly dynamoPolicyUpdateCooldownMs?: number;
  private readonly allowLocalFiles: boolean;
  private readonly cloudFormationProviderTypes?: ReadonlySet<string>;
  private readonly lambdaConcurrentExecutions: number;
  private readonly lambdaUnreservedConcurrencyReserve: number;
  private readonly snsMaximumTopics: number;
  private readonly snsMaximumSubscriptions: number;
  private readonly snsMaximumDeliveryMessages: number;
  private readonly snsDeliveryRetentionMs: number;
  private readonly stepFunctionsLimits: { maximumConcurrentExecutions: number; maximumMapConcurrency: number; executionRetentionMs: number };
  private readonly apiGatewayRateLimit: number;
  private readonly apiGatewayBurstLimit: number;
  private readonly apiGatewayTlsCertificatePath?: string;
  private readonly apiGatewayTlsPrivateKeyPath?: string;
  private readonly apiGatewayJwtJwks: Record<string, HttpApiJwtJwks>;
  private readonly apiGatewayAllowRemoteJwtJwks: boolean;
  private readonly apiGatewayAllowPrivateJwtJwks: boolean;
  private readonly apiGatewayWebSocketIdleTimeoutMs: number;
  private readonly apiGatewayWebSocketLifetimeMs: number;
  private readonly apiGatewayVpcLinkOrigins: Record<string, string>;
  private readonly apiGatewayAllowClientCertificates: boolean;
  private readonly s3Options: ConstructorParameters<typeof S3Service>[3];
  private readonly rdsManager: RdsManager;
  private readonly customResourceCallbacks: CustomResourceCallbackBroker;
  private readonly cognitoSecrets: CognitoSecrets;
  private readonly iamCredentials: IamCredentialStore;
  private readonly cognitoPasswords = new CognitoPasswordHasher();
  private readonly sesOptions: {
    max24HourSend: number;
    maxSendRate: number;
    publicUrl?: string;
    maximumMailboxMessages: number;
    maximumMailboxBytes: number;
  };
  private sesEffectivePublicUrl?: string;
  private readonly cognitoConfiguredPublicUrl?: string;
  private readonly cognitoIdentityProviderNetwork: { allowPublic: boolean };
  private cognitoEffectivePublicUrl?: string;
  private readonly regionalServices = new Map<string, RegionalServices>();
  private readonly regionalStartup = new Map<string, Promise<void>>();
  private readonly cdkBootstrapStatuses = new Map<string, { status: "ready" | "disabled" | "blocked"; persisted: boolean; owned: boolean; collisions: Array<{ type: string; name: string; arn: string }> }>();
  private control?: HttpServer;
  private data?: HttpServer | HttpsServer;
  private customResourceCallbackServer?: HttpsServer;
  private started = false;
  host: string;
  port: number;
  invokePort: number;
  customResourceCallbackPort: number;
  readonly invokeProtocol: "http" | "https";

  constructor(options: SimulatorOptions = {}) {
    this.host = options.host ?? process.env.STACKSIM_HOST ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.STACKSIM_PORT ?? 4566);
    this.invokePort = options.invokePort ?? Number(process.env.STACKSIM_INVOKE_PORT ?? 4567);
    this.customResourceCallbackPort = options.cloudFormationCustomResourceCallbackPort ?? Number(process.env.STACKSIM_CLOUDFORMATION_CUSTOM_RESOURCE_CALLBACK_PORT ?? (options.port === 0 ? 0 : 4568));
    this.region = options.region ?? process.env.AWS_REGION ?? "eu-west-1";
    this.clock = options.clock ?? new SystemClock();
    this.scheduler = new Scheduler(this.clock);
    const authMode = options.authMode ?? process.env.STACKSIM_AUTH_MODE ?? "enforce";
    if (!["off", "validate", "enforce"].includes(authMode)) throw new Error(`Invalid auth mode: ${authMode}. Expected off, validate, or enforce.`);
    this.authMode = authMode as "off" | "validate" | "enforce";
    const legacyOptionSupplied = options.bootstrapRoot !== undefined;
    const legacyEnvironment = legacyOptionSupplied ? undefined : booleanEnvironment("STACKSIM_BOOTSTRAP_ROOT");
    const legacyValue = legacyOptionSupplied ? options.bootstrapRoot : legacyEnvironment;
    this.legacyBootstrapRootSupplied = legacyValue !== undefined;
    this.legacyBootstrapRootSource = legacyOptionSupplied ? "SimulatorOptions" : legacyEnvironment !== undefined ? "environment" : null;
    this.legacyBootstrapRootOverriddenBy = [
      ...(options.cdkBootstrap !== undefined || process.env.STACKSIM_CDK_BOOTSTRAP !== undefined ? ["cdkBootstrap"] : []),
      ...(options.rootRecovery !== undefined || process.env.STACKSIM_ROOT_RECOVERY !== undefined ? ["rootRecovery"] : []),
    ];
    this.bootstrapRoot = legacyValue === true;
    if (legacyValue !== undefined) console.warn("STACKSIM_BOOTSTRAP_ROOT/bootstrapRoot is deprecated; use STACKSIM_CDK_BOOTSTRAP and STACKSIM_ROOT_RECOVERY.");
    this.cdkBootstrap = options.cdkBootstrap ?? booleanEnvironment("STACKSIM_CDK_BOOTSTRAP") ?? legacyValue ?? true;
    this.appSyncLocalTls = options.appSyncLocalTls ?? booleanEnvironment("STACKSIM_APPSYNC_LOCAL_TLS") ?? false;
    this.rootRecovery = options.rootRecovery ?? booleanEnvironment("STACKSIM_ROOT_RECOVERY") ?? legacyValue ?? false;
    this.seedDefaultAdmin = options.seedDefaultAdmin ?? booleanEnvironment("STACKSIM_SEED_DEFAULT_ADMIN") ?? true;
    this.defaultUserName = options.defaultUserName ?? process.env.STACKSIM_DEFAULT_USER_NAME ?? "admin";
    this.allowInsecureRecoveryRoot = options.allowInsecureRecoveryRoot ?? booleanEnvironment("STACKSIM_ALLOW_INSECURE_RECOVERY_ROOT") ?? false;
    const optionPairSupplied = options.defaultAccessKeyId !== undefined || options.defaultSecretAccessKey !== undefined;
    if (optionPairSupplied && (options.defaultAccessKeyId === undefined || options.defaultSecretAccessKey === undefined)) throw new Error("defaultAccessKeyId and defaultSecretAccessKey must be supplied together");
    const environmentPairSupplied = process.env.STACKSIM_ACCESS_KEY_ID !== undefined || process.env.STACKSIM_SECRET_ACCESS_KEY !== undefined;
    if (!optionPairSupplied && environmentPairSupplied && (process.env.STACKSIM_ACCESS_KEY_ID === undefined || process.env.STACKSIM_SECRET_ACCESS_KEY === undefined)) throw new Error("STACKSIM_ACCESS_KEY_ID and STACKSIM_SECRET_ACCESS_KEY must be supplied together");
    this.defaultAccessKeyId = optionPairSupplied ? options.defaultAccessKeyId! : environmentPairSupplied ? process.env.STACKSIM_ACCESS_KEY_ID! : "admin";
    this.defaultSecretAccessKey = optionPairSupplied ? options.defaultSecretAccessKey! : environmentPairSupplied ? process.env.STACKSIM_SECRET_ACCESS_KEY! : "password";
    if (!/^[\w+=,.@-]{1,64}$/.test(this.defaultUserName)) throw new Error("STACKSIM_DEFAULT_USER_NAME is not a valid IAM user name");
    if (!this.defaultAccessKeyId || !this.defaultSecretAccessKey) throw new Error("Configured IAM credentials cannot be empty");
    const loopback = this.host === "localhost" || this.host === "::1" || this.host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(this.host);
    if (this.rootRecovery && !loopback && this.defaultAccessKeyId === "admin" && this.defaultSecretAccessKey === "password" && !this.allowInsecureRecoveryRoot) throw new Error("Recovery root with the built-in admin/password pair cannot listen beyond loopback. Change both simulator-side credentials, disable STACKSIM_ROOT_RECOVERY, or explicitly set STACKSIM_ALLOW_INSECURE_RECOVERY_ROOT=true.");
    this.cloudFormationProviderTypes = options.cloudFormationProviderTypes === undefined ? undefined : new Set(options.cloudFormationProviderTypes);
    this.random = options.random ?? Math.random;
    this.metricRetention = options.metricRetention ?? {};
    this.alarmHistoryRetentionMs = options.alarmHistoryRetentionMs;
    this.dynamoTtlSchedule = options.dynamoTtlSchedule ?? {};
    this.dynamoEnforceCapacity = options.dynamoEnforceCapacity ?? process.env.STACKSIM_DDB_ENFORCE_CAPACITY === "true";
    this.dynamoStreamRetentionMs = options.dynamoStreamRetentionMs ?? (process.env.STACKSIM_DDB_STREAM_RETENTION_MS ? Number(process.env.STACKSIM_DDB_STREAM_RETENTION_MS) : undefined);
    this.dynamoPolicyUpdateCooldownMs = options.dynamoPolicyUpdateCooldownMs ?? (process.env.STACKSIM_DDB_POLICY_UPDATE_COOLDOWN_MS ? Number(process.env.STACKSIM_DDB_POLICY_UPDATE_COOLDOWN_MS) : undefined);
    this.allowLocalFiles = options.allowLocalFiles ?? process.env.STACKSIM_ALLOW_LOCAL_FILES === "true";
    this.lambdaConcurrentExecutions = options.lambdaConcurrentExecutions ?? Number(process.env.STACKSIM_LAMBDA_CONCURRENT_EXECUTIONS ?? 1_000);
    this.lambdaUnreservedConcurrencyReserve = options.lambdaUnreservedConcurrencyReserve ?? Number(process.env.STACKSIM_LAMBDA_UNRESERVED_CONCURRENCY_RESERVE ?? Math.min(100, Math.max(0, this.lambdaConcurrentExecutions - 1)));
    this.snsMaximumTopics = options.snsMaximumTopics ?? Number(process.env.STACKSIM_SNS_MAXIMUM_TOPICS ?? 100_000);
    this.snsMaximumSubscriptions = options.snsMaximumSubscriptions ?? Number(process.env.STACKSIM_SNS_MAXIMUM_SUBSCRIPTIONS ?? 100_000);
    this.snsMaximumDeliveryMessages = options.snsMaximumDeliveryMessages ?? Number(process.env.STACKSIM_SNS_MAXIMUM_DELIVERY_MESSAGES ?? 10_000);
    this.snsDeliveryRetentionMs = options.snsDeliveryRetentionMs ?? Number(process.env.STACKSIM_SNS_DELIVERY_RETENTION_MS ?? 24 * 60 * 60_000);
    this.stepFunctionsLimits = {
      maximumConcurrentExecutions: options.stepFunctionsMaximumConcurrentExecutions ?? Number(process.env.STACKSIM_SFN_MAX_CONCURRENT_EXECUTIONS ?? 1_000),
      maximumMapConcurrency: options.stepFunctionsMaximumMapConcurrency ?? Number(process.env.STACKSIM_SFN_MAX_MAP_CONCURRENCY ?? 40),
      executionRetentionMs: options.stepFunctionsExecutionRetentionMs ?? Number(process.env.STACKSIM_SFN_EXECUTION_RETENTION_MS ?? 90 * 24 * 60 * 60_000),
    };
    this.apiGatewayRateLimit = options.apiGatewayRateLimit ?? Number(process.env.STACKSIM_APIGATEWAY_RATE_LIMIT ?? 10_000);
    this.apiGatewayBurstLimit = options.apiGatewayBurstLimit ?? Number(process.env.STACKSIM_APIGATEWAY_BURST_LIMIT ?? 5_000);
    this.apiGatewayTlsCertificatePath = options.apiGatewayTlsCertificatePath ?? process.env.STACKSIM_APIGATEWAY_TLS_CERTIFICATE_PATH;
    this.apiGatewayTlsPrivateKeyPath = options.apiGatewayTlsPrivateKeyPath ?? process.env.STACKSIM_APIGATEWAY_TLS_PRIVATE_KEY_PATH;
    this.apiGatewayJwtJwks = options.apiGatewayJwtJwks ?? {};
    this.apiGatewayAllowRemoteJwtJwks = options.apiGatewayAllowRemoteJwtJwks ?? process.env.STACKSIM_ALLOW_REMOTE_JWT_JWKS === "true";
    this.apiGatewayAllowPrivateJwtJwks = options.apiGatewayAllowPrivateJwtJwks ?? process.env.STACKSIM_ALLOW_PRIVATE_JWT_JWKS === "true";
    this.apiGatewayWebSocketIdleTimeoutMs = options.apiGatewayWebSocketIdleTimeoutMs ?? Number(process.env.STACKSIM_APIGATEWAY_WEBSOCKET_IDLE_TIMEOUT_MS ?? 10 * 60_000);
    this.apiGatewayWebSocketLifetimeMs = options.apiGatewayWebSocketLifetimeMs ?? Number(process.env.STACKSIM_APIGATEWAY_WEBSOCKET_LIFETIME_MS ?? 2 * 60 * 60_000);
    try { this.apiGatewayVpcLinkOrigins = options.apiGatewayVpcLinkOrigins ?? JSON.parse(process.env.STACKSIM_APIGATEWAY_VPC_LINK_ORIGINS ?? "{}"); } catch { throw new Error("STACKSIM_APIGATEWAY_VPC_LINK_ORIGINS must be a JSON object"); }
    this.apiGatewayAllowClientCertificates = options.apiGatewayAllowClientCertificates ?? process.env.STACKSIM_APIGATEWAY_ALLOW_CLIENT_CERTIFICATES === "true";
    this.s3Options = { maximumObjectBytes: options.s3MaximumObjectBytes, maximumBucketObjects: options.s3MaximumBucketObjects, maximumBuckets: options.s3MaximumBuckets, maximumTotalBytes: options.s3MaximumTotalBytes };
    const sesMax24HourSend = options.sesMax24HourSend ?? Number(process.env.STACKSIM_SES_MAX_24_HOUR_SEND ?? 50_000);
    const sesMaxSendRate = options.sesMaxSendRate ?? Number(process.env.STACKSIM_SES_MAX_SEND_RATE ?? 14);
    const sesMaximumMailboxMessages = options.sesMaximumMailboxMessages ?? Number(process.env.STACKSIM_SES_MAXIMUM_MAILBOX_MESSAGES ?? 10_000);
    const sesMaximumMailboxBytes = options.sesMaximumMailboxBytes ?? Number(process.env.STACKSIM_SES_MAXIMUM_MAILBOX_BYTES ?? 1024 * 1024 * 1024);
    const sesPublicUrl = options.sesPublicUrl ?? process.env.STACKSIM_SES_PUBLIC_URL;
    this.sesOptions = { max24HourSend: sesMax24HourSend, maxSendRate: sesMaxSendRate, maximumMailboxMessages: sesMaximumMailboxMessages, maximumMailboxBytes: sesMaximumMailboxBytes, ...(sesPublicUrl ? { publicUrl: SesService.validatePublicUrl(sesPublicUrl) } : {}) };
    const cognitoPublicUrl = options.cognitoPublicUrl ?? process.env.STACKSIM_COGNITO_PUBLIC_URL;
    this.cognitoConfiguredPublicUrl = cognitoPublicUrl ? CognitoService.validatePublicUrl(cognitoPublicUrl) : undefined;
    this.cognitoIdentityProviderNetwork = {
      allowPublic: options.cognitoAllowPublicIdentityProviders
        ?? process.env.STACKSIM_COGNITO_ALLOW_PUBLIC_IDP === "true",
    };
    if (Boolean(this.apiGatewayTlsCertificatePath) !== Boolean(this.apiGatewayTlsPrivateKeyPath)) throw new Error("API Gateway local TLS requires both certificate and private-key paths");
    this.invokeProtocol = this.apiGatewayTlsCertificatePath ? "https" : "http";
    if (!Number.isInteger(this.lambdaConcurrentExecutions) || this.lambdaConcurrentExecutions < 1) throw new Error("Lambda concurrent executions must be a positive integer");
    if (!Number.isInteger(this.lambdaUnreservedConcurrencyReserve) || this.lambdaUnreservedConcurrencyReserve < 0 || this.lambdaUnreservedConcurrencyReserve >= this.lambdaConcurrentExecutions) throw new Error("Lambda unreserved concurrency reserve must be a non-negative integer below the account concurrency limit");
    if (![this.snsMaximumTopics, this.snsMaximumSubscriptions, this.snsMaximumDeliveryMessages, this.snsDeliveryRetentionMs].every(value => Number.isInteger(value) && value > 0)) throw new Error("SNS topic, subscription, delivery, and retention limits must be positive integers");
    if (![this.stepFunctionsLimits.maximumConcurrentExecutions, this.stepFunctionsLimits.maximumMapConcurrency, this.stepFunctionsLimits.executionRetentionMs].every(value => Number.isInteger(value) && value > 0)) throw new Error("Step Functions execution, Map concurrency, and retention limits must be positive integers");
    if (!Number.isFinite(this.apiGatewayRateLimit) || this.apiGatewayRateLimit <= 0 || !Number.isInteger(this.apiGatewayBurstLimit) || this.apiGatewayBurstLimit <= 0) throw new Error("API Gateway account throttle limits must be positive");
    if (!Number.isFinite(this.apiGatewayWebSocketIdleTimeoutMs) || this.apiGatewayWebSocketIdleTimeoutMs <= 0 || !Number.isFinite(this.apiGatewayWebSocketLifetimeMs) || this.apiGatewayWebSocketLifetimeMs <= 0) throw new Error("API Gateway WebSocket timeouts must be positive");
    if (!Number.isInteger(this.customResourceCallbackPort) || this.customResourceCallbackPort < 0 || this.customResourceCallbackPort > 65_535) throw new Error("CloudFormation custom-resource callback port must be an integer from 0 through 65535");
    if (!this.apiGatewayVpcLinkOrigins || typeof this.apiGatewayVpcLinkOrigins !== "object" || Array.isArray(this.apiGatewayVpcLinkOrigins) || Object.values(this.apiGatewayVpcLinkOrigins).some(value => { try { return !["http:", "https:"].includes(new URL(value).protocol); } catch { return true; } })) throw new Error("API Gateway VPC link origins must map identifiers to HTTP or HTTPS URLs");
    if (!Number.isFinite(sesMax24HourSend) || sesMax24HourSend <= 0 || !Number.isFinite(sesMaxSendRate) || sesMaxSendRate <= 0) throw new Error("SES sending quota and rate must be positive numbers");
    if (!Number.isSafeInteger(sesMaximumMailboxMessages) || sesMaximumMailboxMessages <= 0 || !Number.isSafeInteger(sesMaximumMailboxBytes) || sesMaximumMailboxBytes <= 0) throw new Error("SES mailbox limits must be positive safe integers");
    this.store = new StateStore(options.dataDir, options.accountId ?? process.env.STACKSIM_ACCOUNT_ID, this.region);
    this.iamCredentials = new IamCredentialStore(this.store.root);
    this.store.credentialStore = this.iamCredentials;
    this.store.configuredCredentials = { accessKeyId: this.defaultAccessKeyId, secretAccessKey: this.defaultSecretAccessKey, rootRecovery: this.rootRecovery };
    this.cognitoSecrets = new CognitoSecrets(this.store.root);
    this.customResourceCallbacks = new CustomResourceCallbackBroker(this.store, this.clock);
    const rdsStartupTimeoutMs = options.rdsStartupTimeoutMs ?? (process.env.STACKSIM_RDS_STARTUP_TIMEOUT_MS ? Number(process.env.STACKSIM_RDS_STARTUP_TIMEOUT_MS) : undefined);
    const rdsInstancesRoot = resolve(this.store.root, "data", "rds", "instances");
    const rdsProvider = options.rdsProvider ?? new EmbeddedSqliteProvider({ instancesRoot: rdsInstancesRoot, startupTimeoutMs: rdsStartupTimeoutMs });
    const legacyDestroyProvider = options.rdsProvider ? undefined : new ManagedMariaDbProvider({ instancesRoot: rdsInstancesRoot, startupTimeoutMs: rdsStartupTimeoutMs });
    this.rdsManager = new RdsManager(this.store, rdsProvider, this.clock, { startupTimeoutMs: rdsStartupTimeoutMs, legacyDestroyProvider });
    this.iam = new IamService(this.store, this.clock);
    this.sts = new StsService(this.store, this.clock, this.scheduler);
    const services = this.services(this.region);
    this.lambda = services.lambda;
    this.dynamodb = services.dynamodb;
    this.apigateway = services.apigateway;
    this.apigatewayv2 = services.apigatewayv2;
    this.apigatewaywebsocket = services.apigatewaywebsocket;
    this.logs = services.logs;
    this.metrics = services.metrics;
    this.s3 = services.s3;
    this.sqs = services.sqs;
    this.sns = services.sns;
    this.eventbridge = services.eventbridge;
    this.eventscheduler = services.eventscheduler;
    this.rds = services.rds;
    this.cloudformation = services.cloudformation;
    this.ssm = services.ssm;
    this.secretsmanager = services.secretsmanager;
    this.ses = services.ses;
    this.cognito = services.cognito;
    this.stepfunctions = services.stepfunctions;
    this.appsync = services.appsync;
  }

  async start(): Promise<void> {
    try {
    await this.store.load();
    await this.iamCredentials.start();
    await initializeDefaultAdministrator(this.store, this.iamCredentials, this.clock, {
      seed: this.seedDefaultAdmin,
      userName: this.defaultUserName,
      accessKeyId: this.defaultAccessKeyId,
      secretAccessKey: this.defaultSecretAccessKey,
    });
    const listenerIsLoopback = this.host === "localhost" || this.host === "::1" || this.host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(this.host);
    if (!listenerIsLoopback && this.defaultAccessKeyId === "admin" && this.defaultSecretAccessKey === "password" && this.store.ensureAccount().iam.accessKeys.admin?.status === "Active") {
      console.warn("The built-in admin/password IAM access key is active on a non-loopback listener. Rotate it from the IAM Security credentials page or configure a complete simulator-side pair.");
    }
    await this.cognitoSecrets.start(Object.values(this.store.state.accounts).some(account =>
      Object.values(account.regions).some(regionState =>
        Object.values(regionState.cognito.pools).some(pool =>
          Object.values(pool.clients).some(client => client.secret !== undefined)
          || pool.signingKeys !== undefined,
        ),
      ),
    ));
    await this.rdsManager.start();
    const callbackPki = await this.customResourceCallbacks.initializePki();
    this.customResourceCallbackServer = createSecureServer({ cert: callbackPki.certificate, key: callbackPki.privateKey }, (req, res) => {
      const pathname = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`).pathname;
      if (pathname.startsWith("/_stacksim/cloudformation/custom-resource-response/")) {
        void this.customResourceCallbacks.handle(req, res);
        return;
      }
      if (!this.control) {
        res.statusCode = 503;
        res.end();
        return;
      }
      this.control.emit("request", req, res);
    });
    this.customResourceCallbackServer.on("upgrade", (req, socket, head) => { void this.handleAppSyncRealtimeUpgrade(req, socket as import("node:net").Socket, head); });
    await this.listenLoopback(this.customResourceCallbackServer, this.customResourceCallbackPort);
    this.customResourceCallbackPort = (this.customResourceCallbackServer.address() as any).port;
    this.customResourceCallbacks.setEndpointPort(this.customResourceCallbackPort);
    this.started = true; this.sts.start(); for (const [region, services] of this.regionalServices) await this.startRegionalServices(region, services);
    this.control = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const currentRequestId = requestId();
      res.setHeader("x-amzn-requestid", currentRequestId);
      res.setHeader("x-amz-request-id", currentRequestId);
      const graphqlPath = url.pathname.match(/^\/graphql\/([^/]+)\/([^/]+)$/);
      let graphqlRegion: string | undefined;
      let graphqlApiId: string | undefined;
      if (graphqlPath) {
        try {
          graphqlRegion = decodeURIComponent(graphqlPath[1]);
          graphqlApiId = decodeURIComponent(graphqlPath[2]);
        } catch {
          return json(res, { errors: [{ errorType: "BadRequestException", message: "The GraphQL endpoint path is invalid." }] }, 400);
        }
        if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(graphqlRegion) || !/^[a-f0-9]{26}$/.test(graphqlApiId)) {
          return json(res, { errors: [{ errorType: "BadRequestException", message: "The GraphQL endpoint path is invalid." }] }, 400);
        }
      }
      const region = graphqlRegion ?? this.requestRegion(req, url);
      const services = this.services(region);
      await this.startRegionalServices(region, services);
      if (graphqlApiId) return services.appsync.handleGraphql(req, res, graphqlApiId, url, currentRequestId);
      if (req.method === "GET" && /^\/_stacksim\/cognito-idp\/[^/]+\/[^/]+\/\.well-known\/jwks\.json$/.test(url.pathname)) {
        return this.localCognitoJwks(req, res, url);
      }
      if (req.method === "GET" && /^\/_stacksim\/cognito-idp\/[^/]+\/[^/]+\/\.well-known\/openid-configuration$/.test(url.pathname)) {
        return this.localCognitoDiscovery(req, res, url);
      }
      if (url.pathname.startsWith("/_stacksim/cognito-domain/")) {
        return this.localCognitoOAuth(req, res, url);
      }
      if (url.pathname.startsWith("/_stacksim/s3-website/")) {
        const rawBucket = url.pathname.slice("/_stacksim/s3-website/".length).split("/", 1)[0];
        let bucketName = rawBucket; try { bucketName = decodeURIComponent(rawBucket); } catch { /* S3 returns the modeled invalid URI response. */ }
        const owner = this.store.state.installation.s3BucketNames[bucketName];
        const websiteServices = owner ? this.services(owner.region) : services;
        await this.startRegionalServices(owner?.region ?? region, websiteServices);
        return websiteServices.s3.handleWebsite(req, res, url, currentRequestId);
      }
      if (req.method === "GET" && url.pathname === "/_stacksim/sns/certificate.pem") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/x-pem-file");
        res.setHeader("cache-control", "public, max-age=3600");
        return res.end(services.sns.certificate());
      }
      if (req.method === "GET" && url.pathname === "/_stacksim/appsync/ca.pem") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/x-pem-file");
        res.setHeader("content-disposition", 'attachment; filename="stacksim-appsync-ca.pem"');
        res.setHeader("cache-control", "no-store");
        return res.end(await readFile(this.customResourceCallbacks.caCertificatePath));
      }
      if (req.method === "GET" && url.pathname === "/_stacksim/sns/unsubscribe") {
        const tokens = url.searchParams.getAll("token");
        let completed = false;
        if (tokens.length === 1 && url.searchParams.size === 1) {
          for (const candidate of this.store.listRegions()) {
            const regional = this.services(candidate);
            await this.startRegionalServices(candidate, regional);
            if (await regional.sns.handleUnsubscribeLink(tokens[0])) { completed = true; break; }
          }
        }
        res.statusCode = completed ? 200 : 400;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>SNS unsubscribe</title></head><body><main><h1>${completed ? "Subscription removed" : "Invalid unsubscribe link"}</h1><p>${completed ? "The local SNS subscription was removed." : "This unsubscribe link is invalid, expired, or already used."}</p></main></body></html>`);
      }
      if (req.method === "GET" && url.pathname === "/_stacksim/health") return json(res, { status: "ok", services: ["cloudformation", "lambda", "stepfunctions", "apigateway", "appsync", "dynamodb", "rds", "s3", "sqs", "sns", "ssm", "secretsmanager", "eventbridge", "scheduler", "logs", "cloudwatch", "iam", "sts", "ses", "cognito-idp"], rds: this.rdsManager.metadata(), region, requestId: currentRequestId });
      if (req.method === "GET" && url.pathname === "/_stacksim/api/console-config") return json(res, { authMode: this.authMode, region, bootId: this.bootId });
      if (url.pathname.startsWith("/_stacksim/api/")) {
        try {
          const service = this.localConsoleService(url);
          const principal = this.authMode === "off"
            ? principalWithoutValidation(req, url, this.store, this.clock)
            : await authenticateSigV4(req, url, this.store, this.clock, region, service);
          (req as any).awsPrincipal = principal;
          const target = this.localConsoleMutationTarget(req, url, region, principal);
          if (target && this.authMode === "enforce") await this.authorize(principal, target, currentRequestId);
          if (req.method === "GET" && url.pathname.startsWith("/_stacksim/api/console-onboarding/") && this.authMode === "enforce") {
            await this.authorize(principal, { action: "stacksim:MutateConsoleResource", resource: "*", operation: "DefaultAccessKeyOnboarding", input: {}, context: { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString() } }, currentRequestId);
          }
        } catch (error) {
          const aws = error instanceof AwsError ? error : new AwsError("AccessDeniedException", error instanceof Error ? error.message : String(error), 403);
          return json(res, { message: aws.message, code: aws.code, __type: aws.code }, aws.status);
        }
      }
      if (req.method === "GET" && url.pathname === "/_stacksim/api/summary") return json(res, {
        region,
        accountId: this.store.accountId,
        endpoint: `http://${this.host}:${this.port}`,
        invokeEndpoint: `${this.invokeProtocol}://${this.host}:${this.invokePort}`,
        lambdaImageSource: process.env.STACKSIM_LAMBDA_OCI_ROOT ? "oci" : process.env.STACKSIM_LAMBDA_DOCKER_SOCKET ? "docker" : undefined,
        counts: { stacks: Object.values(this.store.regionState(region).cloudformation.stacks).filter(stack => stack.stackStatus !== "DELETE_COMPLETE").length, stateMachines: Object.keys(this.store.regionState(region).stepFunctions.stateMachines).length, parameters: Object.keys(this.store.regionState(region).parameterStore.parameters).length, secrets: Object.keys(this.store.regionState(region).secretsManager.secrets).length, functions: Object.keys(this.store.regionState(region).functions).length, capacityProviders: Object.keys(this.store.regionState(region).lambdaCapacityProviders).length, durableExecutions: Object.keys(this.store.regionState(region).lambdaDurableExecutions).length, tables: Object.keys(this.store.regionState(region).tables).length, rdsInstances: Object.keys(this.store.regionState(region).rdsDbInstances).length, buckets: Object.keys(this.store.regionState(region).s3Buckets).length, queues: Object.keys(this.store.regionState(region).sqsQueues).length, topics: Object.keys(this.store.regionState(region).sns.topics).length, subscriptions: Object.keys(this.store.regionState(region).sns.subscriptions).length, eventBuses: Object.keys(this.store.regionState(region).eventBuses).length, eventRules: Object.keys(this.store.regionState(region).eventRules).length, apis: Object.keys(this.store.regionState(region).apis).length, httpApis: Object.keys(this.store.regionState(region).httpApis).length, webSocketApis: Object.keys(this.store.regionState(region).webSocketApis).length, customDomains: Object.keys(this.store.regionState(region).apiGatewayDomainNames).length + Object.keys(this.store.regionState(region).apiGatewayV2DomainNames).length, logGroups: Object.keys(this.store.regionState(region).logs).length, users: Object.keys(this.store.ensureAccount().iam.users).length, groups: Object.keys(this.store.ensureAccount().iam.groups).length, roles: Object.keys(this.store.ensureAccount().iam.roles).length, policies: Object.keys(this.store.ensureAccount().iam.policies).length, sesIdentities: Object.keys(this.store.regionState(region).ses.identities).length, sesTemplates: Object.keys(this.store.regionState(region).ses.templates).length, sesConfigurationSets: Object.keys(this.store.regionState(region).ses.configurationSets).length, sesMessages: services.ses.summary().messageCount, cognitoUserPools: services.cognito.summary().poolCount, cognitoAppClients: services.cognito.summary().clientCount },
        rds: this.rdsManager.metadata(),
      });
      if (req.method === "GET" && url.pathname === "/_stacksim/api/environment") {
        const requestPrincipal = (req as any).awsPrincipal as PrincipalContext | undefined;
        const bootstrap = await this.localBootstrapView(region, services);
        return json(res, {
        installationId: this.store.state.installation.id,
        accountId: this.store.accountId,
        region,
        regions: this.store.listRegions(),
        authMode: this.authMode,
        statePath: this.store.file,
        schemaVersion: this.store.state.schemaVersion,
        services: { cloudformation: "available", lambda: "available", apigateway: "available", appsync: "available", dynamodb: "available", rds: "available", s3: "available", sqs: "available", sns: services.sns.admissionStatus(), ssm: "available", secretsmanager: services.secretsmanager.admissionStatus(), eventbridge: "available", scheduler: "available", logs: "available", cloudwatch: "available", iam: "available", sts: "available", ses: services.ses.admissionStatus(), "cognito-idp": "available" },
        rds: this.rdsManager.metadata(),
        requestPrincipalType: requestPrincipal?.principalType ?? null,
        requestPrincipalArn: requestPrincipal && requestPrincipal.principalType !== "anonymous" && requestPrincipal.principalType !== "service" ? requestPrincipal.principalArn : null,
        configuredCredentialMode: this.rootRecovery ? "recoveryRoot" : this.defaultAdministratorView().configuredKeyStatus === "Active" ? "iamUser" : "unavailable",
        defaultPrincipalArn: this.rootRecovery ? `arn:aws:iam::${this.store.accountId}:root` : this.defaultAdministratorView().configuredKeyStatus === "Active" ? this.defaultAdministratorView().arn : null,
        defaultAdministrator: this.defaultAdministratorView(),
        cdkBootstrap: { enabled: this.cdkBootstrap, region: this.region, ...(this.cdkBootstrapStatuses.get(region) ?? { status: bootstrap ? "ready" : "disabled", persisted: Boolean(bootstrap), owned: Boolean(bootstrap), collisions: [] }) },
        recoveryRootEnabled: this.rootRecovery,
        bootstrapRoot: this.bootstrapRoot,
        deprecatedConfiguration: { bootstrapRoot: { supplied: this.legacyBootstrapRootSupplied, value: this.legacyBootstrapRootSupplied ? this.bootstrapRoot : null, source: this.legacyBootstrapRootSource, overriddenBy: this.legacyBootstrapRootOverriddenBy } },
        bootstrap,
        allowLocalFiles: this.allowLocalFiles,
      });
      }
      if (url.pathname.startsWith("/_stacksim/api/console-onboarding/default-access-key/")) return this.localDefaultAccessKeyOnboarding(req, res, url);
      if (req.method === "GET" && url.pathname === "/_stacksim/api/dynamodb/resource-policy") { const resourceArn = url.searchParams.get("resourceArn") ?? ""; const policy = this.store.regionState(region).dynamodbResourcePolicies[resourceArn]; return json(res, policy ? { Policy: policy.policy, RevisionId: policy.revisionId } : {}); }
      if (req.method === "GET" && url.pathname === "/_stacksim/api/ssm/parameters") return json(res, { parameters: services.ssm.localMetadata() });
      if (req.method === "GET" && url.pathname === "/_stacksim/api/appsync/realtime") return json(res, { realtime: services.appsync.realtimeDiagnostics() });
      if (req.method === "GET" && url.pathname === "/_stacksim/api/secrets-manager/secrets") return json(res, { secrets: services.secretsmanager.localMetadata() });
      if (req.method === "GET" && url.pathname === "/_stacksim/api/lambda/async") {
        const functionName = url.searchParams.get("functionName") ?? undefined; const now = this.clock.now(); const events = Object.values(this.store.regionState(region).lambdaAsyncInvocations).filter(event => !functionName || event.functionName === functionName).sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.eventId.localeCompare(right.eventId));
        return json(res, { functionName, queued: events.filter(event => event.status === "QUEUED").length, leased: events.filter(event => event.status === "LEASED").length, retrying: events.filter(event => event.attempts > 0).length, oldestEventAgeMs: events.length ? Math.max(0, now - events[0].enqueuedAt) : 0, events: events.map(event => ({ eventId: event.eventId, functionName: event.functionName, qualifier: event.qualifier, enqueuedAt: event.enqueuedAt, nextAttemptAt: event.nextAttemptAt, attempts: event.attempts, status: event.status, lastAttemptAt: event.lastAttemptAt, lastError: event.lastError })) });
      }
      if (req.method === "GET" && url.pathname === "/_stacksim/api/eventbridge/deliveries") return json(res, services.eventbridge.deliveryDiagnostics());
      if (req.method === "GET" && url.pathname === "/_stacksim/api/eventbridge/schedules") return json(res, services.eventscheduler.diagnostics());
      if (req.method === "GET" && url.pathname === "/_stacksim/api/sns/deliveries") {
        try { return json(res, await services.sns.deliveryDiagnostics()); }
        catch { return json(res, { code: "SnsDeliveryStorageUnavailable", message: "SNS delivery diagnostics are unavailable for this account and Region." }, 503); }
      }
      if (url.pathname.startsWith("/_stacksim/api/cloudformation/")) return this.localCloudFormationApi(req, res, url, services.cloudformation);
      if (url.pathname.startsWith("/_stacksim/api/iam/")) return this.localIamApi(req, res, url);
      if (url.pathname.startsWith("/_stacksim/api/rds/")) return this.localRdsQueryEditorApi(req, res, url, region);
      if (url.pathname.startsWith("/_stacksim/api/cognito/")) return this.localCognitoApi(req, res, url, services.cognito);
      if (url.pathname.startsWith("/_stacksim/api/ses/")) return services.ses.handleLocal(req, res, url, currentRequestId);
      const sesVerifyMatch = url.pathname.match(/^\/_stacksim\/ses\/verify-email\/([^/]+)$/);
      const sesResultMatch = url.pathname.match(/^\/_stacksim\/ses\/verification-result\/([^/]+)$/);
      const sesCallbackMatch = url.pathname.match(/^\/_stacksim\/ses\/callback\/([^/]+)\/(unsubscribe|click)$/);
      if (sesVerifyMatch || sesResultMatch || sesCallbackMatch) {
        let routedRegion: string;
        try { routedRegion = decodeURIComponent((sesVerifyMatch ?? sesResultMatch ?? sesCallbackMatch)![1]); } catch { return json(res, { message: "Invalid Region path" }, 400); }
        if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(routedRegion)) return json(res, { message: "Invalid Region path" }, 400);
        if (sesVerifyMatch) {
          const tokens = url.searchParams.getAll("token");
          const payload = req.method === "GET" && url.searchParams.size === 1 && tokens.length === 1
            ? verifyVerificationToken(this.store.state.installation.sesSigningSecret, tokens[0])
            : undefined;
          if (!payload) {
            res.statusCode = req.method === "GET" ? 400 : 405;
            res.setHeader("cache-control", "no-store");
            res.setHeader("referrer-policy", "no-referrer");
            res.setHeader("x-content-type-options", "nosniff");
            res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>SES verification</title></head><body><main><h1>Email verification</h1><p>The verification link is invalid.</p></main></body></html>");
            return;
          }
        }
        const routedSes = this.services(routedRegion).ses;
        await this.startRegionalServices(routedRegion, this.services(routedRegion));
        if (this.sesEffectivePublicUrl) await routedSes.completePostBind(this.sesEffectivePublicUrl);
        return sesVerifyMatch
          ? routedSes.handleVerificationCallback(req, res, url, currentRequestId)
          : sesResultMatch
            ? routedSes.handleVerificationResult(req, res, url, currentRequestId)
            : routedSes.handleLocalCallback(req, res, url, sesCallbackMatch![2]);
      }
      if (req.method === "GET" && (url.pathname === "/_stacksim/console" || url.pathname.startsWith("/_stacksim/console/"))) return this.serveConsole(res, url.pathname);
      const signingService = this.requestSigningService(req, url); let routedService = url.pathname === "/v20180820/configuration/publicAccessBlock" && req.headers["x-amz-account-id"] ? "s3-control" : signingService ?? this.routeService(req, url); if (routedService === "unknown") routedService = await this.queryProtocolService(req, url);
      let principal: PrincipalContext;
      try {
        principal = routedService === "cognito-idp" && isCognitoNonIamTarget(req.headers["x-amz-target"])
          ? principalWithoutValidation(req, url, this.store, this.clock)
          : await this.authenticateAndAuthorize(req, url, region, routedService, currentRequestId);
        (req as any).awsPrincipal = principal;
      }
      catch (error) { return this.sendAuthorizationError(res, error, routedService, currentRequestId, req); }
      if (routedService === "iam") return this.iam.handle(req, res, currentRequestId, principal);
      if (routedService === "sts") return this.sts.handle(req, res, currentRequestId, principal);
      if (routedService === "cloudformation") return services.cloudformation.handle(req, res, url, currentRequestId, principal);
      if (routedService === "ssm") return services.ssm.handle(req, res);
      if (routedService === "secretsmanager") return services.secretsmanager.handle(req, res);
      if (routedService === "s3") return services.s3.handle(req, res, url, currentRequestId, principal);
      if (routedService === "s3-control") return services.s3.handleControl(req, res, url, currentRequestId, principal);
      if (routedService === "sqs") return services.sqs.handle(req, res, currentRequestId);
      if (routedService === "sns") return services.sns.handle(req, res, currentRequestId, principal);
      if (routedService === "events") return services.eventbridge.handle(req, res);
      if (routedService === "scheduler") return services.eventscheduler.handle(req, res, url);
      if (routedService === "states") return services.stepfunctions.handle(req, res);
      if (routedService === "rds") return services.rds.handle(req, res, currentRequestId);
      if (routedService === "monitoring") return services.metrics.handle(req, res, currentRequestId, principal);
      if (routedService === "ses") return services.ses.handle(req, res, url, currentRequestId, principal);
      if (routedService === "cognito-idp") {
        if (/^\/_stacksim\/cognito-idp\/[a-z]{2}(?:-gov)?-[a-z]+-\d\/sdk\/?$/.test(url.pathname)) {
          req.url = "/";
        }
        return services.cognito.handle(req, res, currentRequestId);
      }
      if (routedService === "appsync") return services.appsync.handleControl(req, res, url);
      if (/^DynamoDB(?:Streams)?_/.test(req.headers["x-amz-target"]?.toString() ?? "")) return services.dynamodb.handle(req, res);
      if (req.headers["x-amz-target"]?.toString().startsWith("Logs_20140328")) return services.logs.handle(req, res);
      if (url.pathname.startsWith("/2014-11-13/functions") || url.pathname.startsWith("/2015-03-31/functions") || url.pathname.startsWith("/2015-03-31/event-source-mappings") || url.pathname.startsWith("/2016-08-19/account-settings") || url.pathname.startsWith("/2017-03-31/tags/") || url.pathname.startsWith("/2017-10-31/functions") || url.pathname.startsWith("/2018-10-31/layers") || url.pathname.startsWith("/2019-09-25/functions") || url.pathname.startsWith("/2019-09-30/functions") || url.pathname.startsWith("/2020-04-22/code-signing-configs") || url.pathname.startsWith("/2020-06-30/functions") || url.pathname.startsWith("/2021-07-20/functions") || url.pathname.startsWith("/2021-10-31/functions") || url.pathname.startsWith("/2021-11-15/functions") || url.pathname.startsWith("/2024-08-31/functions") || url.pathname.startsWith("/2025-11-30/") || url.pathname.startsWith("/2025-12-01/")) return services.lambda.handle(req, res, url.pathname, url, principal);
      if (url.pathname.startsWith("/v2")) return services.apigatewayv2.handle(req, res, url.pathname, url);
      if (url.pathname.startsWith("/restapis") || url.pathname === "/account" || url.pathname.startsWith("/tags/") || url.pathname.startsWith("/apikeys") || url.pathname.startsWith("/usageplans") || url.pathname.startsWith("/domainnames") || url.pathname.startsWith("/domainnameaccessassociations") || url.pathname === "/rejectdomainnameaccessassociations" || url.pathname.startsWith("/vpclinks") || url.pathname.startsWith("/clientcertificates") || url.pathname.startsWith("/sdktypes")) return services.apigateway.handle(req, res, url.pathname, url);
      res.statusCode = 404; return json(res, { message: "Unknown service route" }, 404);
    });
    this.control.on("upgrade", (req, socket, head) => { void this.handleAppSyncRealtimeUpgrade(req, socket as import("node:net").Socket, head); });
    const dataListener = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const currentRequestId = requestId();
      res.setHeader("x-amzn-requestid", currentRequestId);
      res.setHeader("x-amz-request-id", currentRequestId);
      const managementApiId = url.pathname.split("/")[1];
      const managementRegion = this.store.listRegions().find(candidate => Boolean(this.store.regionState(candidate).webSocketApis[managementApiId]));
      if (managementRegion) {
        const webSocket = this.services(managementRegion).apigatewaywebsocket;
        if (webSocket.isManagementPath(url.pathname)) {
          try {
            let principal: PrincipalContext | undefined;
            if (this.authMode !== "off") principal = await authenticateSigV4(req, url, this.store, this.clock, managementRegion, "execute-api");
            else principal = principalWithoutValidation(req, url, this.store, this.clock);
            (req as any).awsPrincipal = principal;
            if (this.authMode === "enforce") {
              const resource = webSocket.managementAuthorizationResource(url.pathname, req.method ?? "GET");
              const context: Record<string, unknown> = { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": managementRegion, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:SourceIp": req.socket.remoteAddress?.replace(/^::ffff:/, ""), "aws:UserAgent": req.headers["user-agent"] ?? "", "aws:SecureTransport": Boolean((req.socket as any).encrypted) };
              const result = await this.evaluateAndRecordAuthorization(principal, { action: "execute-api:ManageConnections", resource, operation: "ManageConnections", input: {}, context }, currentRequestId);
              if (result.decision !== "allowed") throw new AwsError("AccessDeniedException", `User: ${principal.principalArn} is not authorized to perform: execute-api:ManageConnections on resource: ${resource}. ${result.reason}`, 403);
            }
          } catch (error) { return sendAwsError(res, error, "rest"); }
          return webSocket.handleManagement(req, res, url.pathname);
        }
      }
      const functionUrlMatch = url.pathname.match(/^\/lambda-url\/([a-f0-9]{32})(\/.*)?$/);
      if (functionUrlMatch) {
        let found: { region: string; lambda: LambdaService; target: NonNullable<ReturnType<LambdaService["findFunctionUrl"]>> } | undefined;
        for (const candidate of this.store.listRegions()) { const lambda = this.services(candidate).lambda; const target = lambda.findFunctionUrl(functionUrlMatch[1]); if (target) { found = { region: candidate, lambda, target }; break; } }
        if (!found) return json(res, { message: "Function URL not found" }, 404);
        if (found.lambda.isFunctionUrlPreflight(req)) return found.lambda.handleFunctionUrlPreflight(req, res, found.target);
        let principal: PrincipalContext | undefined;
        try {
          if (found.target.config.authType === "AWS_IAM") principal = this.authMode === "off" ? principalWithoutValidation(req, url, this.store, this.clock) : await authenticateSigV4(req, url, this.store, this.clock, found.region, "lambda");
          if (this.authMode === "enforce") await this.authorizeFunctionUrl(req, found.lambda, found.target, principal, currentRequestId, found.region);
        } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("AccessDeniedException", error instanceof Error ? error.message : String(error), 403); return json(res, { message: aws.status === 403 ? "Forbidden" : aws.message }, aws.status); }
        (req as any).awsPrincipal = principal; return found.lambda.invokeFunctionUrl(req, res, url, found.target, functionUrlMatch[2] || "/", currentRequestId, principal);
      }
      let invocationPath = url.pathname; let customDomainRegion: string | undefined; let gatewayVersion: "v1" | "v2" | undefined;
      for (const candidate of this.store.listRegions()) {
        const candidateServices = this.services(candidate); const v1 = candidateServices.apigateway.customDomainInvocation(req.headers.host, url.pathname);
        if (v1.matched) { customDomainRegion = candidate; gatewayVersion = "v1"; invocationPath = v1.pathname ?? `/__stacksim_unmapped__/__stacksim_unmapped__${url.pathname}`; break; }
        const v2 = candidateServices.apigatewayv2.customDomainInvocation(req.headers.host, url.pathname);
        if (v2.matched) { customDomainRegion = candidate; gatewayVersion = "v2"; invocationPath = v2.pathname ?? `/__stacksim_unmapped__/__stacksim_unmapped__${url.pathname}`; break; }
      }
      const apiId = invocationPath.split("/")[1];
      const region = customDomainRegion ?? this.store.listRegions().find(candidate => Boolean(this.store.regionState(candidate).apis[apiId]) || Boolean(this.store.regionState(candidate).httpApis[apiId]) || Boolean(this.store.regionState(candidate).webSocketApis[apiId])) ?? this.requestRegion(req, url);
      const regional = this.services(region); gatewayVersion ??= regional.apigatewayv2.hasApi(apiId) ? "v2" : "v1"; const apiGateway = gatewayVersion === "v2" ? regional.apigatewayv2 : regional.apigateway;
      try {
        const authorizationType = apiGateway.invocationAuthorizationType(invocationPath, req.method ?? "GET");
        const hasSignature = String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256") || url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256";
        if ((authorizationType === "AWS_IAM" || hasSignature) && this.authMode !== "off") {
          const principal = await authenticateSigV4(req, url, this.store, this.clock, region, "execute-api");
          (req as any).awsPrincipal = principal;
          if (authorizationType === "AWS_IAM" && this.authMode === "enforce") { const authorizationPath = gatewayVersion === "v2" ? regional.apigatewayv2.canonicalAuthorizationPath(invocationPath, req.method ?? "GET") : invocationPath; (req as any).awsIdentityAuthorization = await this.evaluateAndRecordAuthorization(principal, executeApiTarget(req, authorizationPath, region, this.store.accountId, principal, this.clock.now()), currentRequestId); }
        }
      } catch (error) { return apiGateway.sendInvocationError(req, res, invocationPath, error, currentRequestId); }
      return apiGateway.invoke(req, res, invocationPath, url);
    };
    this.data = this.apiGatewayTlsCertificatePath && this.apiGatewayTlsPrivateKeyPath ? createSecureServer({ cert: await readFile(this.apiGatewayTlsCertificatePath), key: await readFile(this.apiGatewayTlsPrivateKeyPath) }, dataListener) : createServer(dataListener);
    this.data.on("upgrade", (req, socket, head) => { void this.handleWebSocketUpgrade(req, socket as import("node:net").Socket, head); });
    await Promise.all([this.listen(this.control, this.port), this.listen(this.data, this.invokePort)]);
    this.port = (this.control.address() as any).port; this.invokePort = (this.data.address() as any).port;
    this.sesEffectivePublicUrl = this.sesOptions.publicUrl ?? `http://localhost:${this.port}`;
    this.cognitoEffectivePublicUrl = this.cognitoConfiguredPublicUrl ?? `http://localhost:${this.port}`;
    for (const services of this.regionalServices.values()) {
      await services.ses.completePostBind(this.sesEffectivePublicUrl);
      await services.cognito.completePostBind(this.cognitoEffectivePublicUrl);
    }
    let endpointUpdated = false;
    for (const candidate of this.store.listRegions()) {
      const state = this.store.regionState(candidate);
      endpointUpdated = await this.services(candidate).appsync.refreshEndpoints() || endpointUpdated;
      for (const api of Object.values(state.httpApis)) { const endpoint = `${this.invokeProtocol}://localhost:${this.invokePort}/${api.apiId}`; if (api.apiEndpoint !== endpoint) { api.apiEndpoint = endpoint; endpointUpdated = true; } }
      for (const api of Object.values(state.webSocketApis)) { const endpoint = `${this.invokeProtocol === "https" ? "wss" : "ws"}://localhost:${this.invokePort}/${api.apiId}`; if (api.apiEndpoint !== endpoint) { api.apiEndpoint = endpoint; endpointUpdated = true; } }
    }
    if (endpointUpdated) await this.store.save();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  private services(region: string): RegionalServices {
    let services = this.regionalServices.get(region);
    if (!services) {
      this.store.regionState(region);
      const logs = new CloudWatchLogsService(this.store, region, this.clock, this.scheduler, this.allowLocalFiles);
      const telemetry = new TelemetryBus();
      const metrics = new CloudWatchMetricsService(this.store, region, this.clock, this.scheduler, this.metricRetention, this.alarmHistoryRetentionMs, this.allowLocalFiles);
      telemetry.subscribe(event => metrics.publish(event));
      const sqs = new SqsService(this.store, region, this.clock, telemetry, this.scheduler, () => `http://${this.host}:${this.port}`);
      // A wildcard is a valid public listen address but never a connectable
      // destination. Local Lambda runtimes use the matching loopback family so
      // their standard SDK endpoint remains reachable and inside the CFN-14
      // network boundary while the public servers keep their configured bind.
      const lambdaControlHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host === "::" || this.host === "[::]" ? "[::1]" : this.host;
      const lambda = new LambdaService(this.store, region, logs, this.clock, this.authMode, this.rootRecovery, this.random, telemetry, this.scheduler, this.lambdaConcurrentExecutions, this.lambdaUnreservedConcurrencyReserve, () => `${this.invokeProtocol}://${this.host}:${this.invokePort}`, () => `http://${lambdaControlHost}:${this.port}`);
      const sns = new SnsService(this.store, region, this.clock, this.scheduler, telemetry, sqs, lambda, logs, () => `http://${lambdaControlHost}:${this.port}`, {
        maximumTopics: this.snsMaximumTopics,
        maximumSubscriptions: this.snsMaximumSubscriptions,
        maximumDeliveryMessages: this.snsMaximumDeliveryMessages,
        deliveryRetentionMs: this.snsDeliveryRetentionMs,
      });
      const eventbridge = new EventBridgeService(this.store, region, this.clock, this.scheduler, telemetry, lambda);
      lambda.setSqsService(sqs);
      lambda.setSnsService(sns);
      metrics.setLambdaService(lambda);
      metrics.setSnsPublisher((topicArn, message, alarmArn, deliveryLineage) => sns.publishAuthorized({ TopicArn: topicArn, Message: message }, {
        principal: "cloudwatch.amazonaws.com",
        sourceArn: alarmArn,
        sourceAccount: this.store.accountId,
        lineage: deliveryLineage,
      }).then(() => undefined));
      metrics.setLogService(logs);
      logs.setMetricService(metrics); logs.setLambdaService(lambda);
      const dynamodb = new DynamoDbService(this.store, region, this.clock, telemetry, this.scheduler, this.dynamoTtlSchedule, this.dynamoEnforceCapacity, this.dynamoStreamRetentionMs, this.dynamoPolicyUpdateCooldownMs, this.allowLocalFiles);
      const ses = new SesService(this.store, region, this.clock, this.sesOptions);
      ses.setEventServices(metrics, input => eventbridge.publishServiceEvent(input));
      const cognito = new CognitoService(
        this.store,
        region,
        this.clock,
        this.cognitoSecrets,
        this.cognitoPasswords,
        ses,
        telemetry,
        lambda,
        this.cognitoIdentityProviderNetwork,
      );
      const apigatewaywebsocket = new ApiGatewayWebSocketService(this.store, lambda, () => this.invokePort, region, this.clock, this.authMode, telemetry, logs, this.invokeProtocol, { idleTimeoutMs: this.apiGatewayWebSocketIdleTimeoutMs, lifetimeMs: this.apiGatewayWebSocketLifetimeMs });
      const apigateway = new ApiGatewayService(this.store, lambda, dynamodb, this.invokePort, region, this.clock, this.authMode, telemetry, logs, this.apiGatewayRateLimit, this.apiGatewayBurstLimit, this.invokeProtocol, this.apiGatewayVpcLinkOrigins, this.apiGatewayAllowClientCertificates, sqs, cognito);
      const apigatewayv2 = new ApiGatewayV2Service(this.store, lambda, () => this.invokePort, region, this.clock, this.authMode, telemetry, logs, this.apiGatewayRateLimit, this.apiGatewayBurstLimit, this.invokeProtocol, this.apiGatewayJwtJwks, this.apiGatewayAllowRemoteJwtJwks, this.apiGatewayAllowPrivateJwtJwks, apigatewaywebsocket, sqs, cognito);
      eventbridge.setTargetServices({ sqs, sns, logs, apiGateway: apigateway });
      const eventscheduler = new EventBridgeSchedulerService(this.store, region, this.clock, this.scheduler, lambda, sqs, logs, eventbridge);
      lambda.setEventBridgeService(eventbridge);
      metrics.setEventPublisher(async event => {
        const deliveryLineage = (event.deliveryLineage ?? event.resources.slice(0, 1)).map(String).slice(-32);
        if (deliveryLineage.length >= 32 || new Set(deliveryLineage).size !== deliveryLineage.length) return;
        await eventbridge.publishServiceEvent({ source: event.source, detailType: event.detailType, detail: event.detail, resources: event.resources, time: event.time, eventBusName: "default", deliveryLineage });
      });
      const s3 = new S3Service(this.store, region, this.clock, { ...this.s3Options, websiteBaseUrl: () => `http://${this.host}:${this.port}`, scheduler: this.scheduler, telemetry, lambda, sqs, eventbridge });
      lambda.setS3Service(s3);
      dynamodb.setS3TransferPort(s3.createTransferPort());
      const ssm = new SsmService(this.store, region, this.clock, this.scheduler, input => eventbridge.publishServiceEvent(input));
      const secretsmanager = new SecretsManagerService(this.store, region, this.clock, this.scheduler, this.authMode === "enforce" ? async (principal, action, resource, requestTags, resourceTags) => {
        const context: Record<string, unknown> = { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:TagKeys": Object.keys(requestTags) };
        for (const [key, value] of Object.entries(requestTags)) context[`aws:RequestTag/${key}`] = value;
        for (const [key, value] of Object.entries(resourceTags)) { context[`aws:ResourceTag/${key}`] = value; context[`secretsmanager:ResourceTag/${key}`] = value; }
        await this.authorize(principal, { action, resource, operation: action.split(":")[1], input: {}, context }, requestId());
      } : undefined);
      secretsmanager.setRotationInvoker({
        assertFunction: (lambdaArn, secretArn) => lambda.assertSecretsManagerRotationFunction(lambdaArn, secretArn),
        invoke: async (lambdaArn, event, currentRequestId, lineage) => { await lambda.invokeSecretsManagerRotation(lambdaArn, event, currentRequestId, lineage); },
      });
      secretsmanager.setRdsTargetPort({
        describeTarget: targetId => this.rdsManager.describeSecretTarget(region, targetId),
        applyPending: async (secretArn, token) => {
          const secret = secretsmanager.readSecretCloudFormation(secretArn); const attachment = secret?.targetAttachment;
          if (!secret || !attachment) throw new AwsError("InvalidRequestException", "The rotating secret has no bounded RDS target attachment", 400);
          const pending = await secretsmanager.getSecretForService({ SecretId: secretArn, VersionId: token });
          if (typeof pending.SecretString !== "string") throw new AwsError("InvalidRequestException", "RDS rotation requires a JSON SecretString", 400);
          let parsed: any; try { parsed = JSON.parse(pending.SecretString); } catch { throw new AwsError("InvalidRequestException", "RDS rotation requires a JSON SecretString", 400); }
          if (typeof parsed?.password !== "string") throw new AwsError("InvalidRequestException", "The pending RDS secret requires a password field", 400);
          const previous = Object.values(secret.versions).find(version => version.stages.includes("AWSCURRENT"));
          if (!previous) throw new AwsError("InvalidRequestException", "The RDS secret has no retained current credential", 400);
          await this.rdsManager.applySecretRotation({ region, targetId: attachment.targetId, secretArn, secretGenerationId: secret.generationId, pendingVersionId: token, previousVersionId: previous.versionId, pendingPassword: parsed.password });
        },
        finalize: async (secretArn, token) => { const attachment = secretsmanager.readSecretCloudFormation(secretArn)?.targetAttachment; if (!attachment) throw new AwsError("InvalidRequestException", "The rotating secret has no bounded RDS target attachment", 400); await this.rdsManager.finalizeSecretRotation(region, attachment.targetId, secretArn, token); },
        compensate: async (secretArn, token) => { const attachment = secretsmanager.readSecretCloudFormation(secretArn)?.targetAttachment; if (attachment) await this.rdsManager.compensateSecretRotation(region, attachment.targetId, secretArn, token); },
      });
      this.rdsManager.setManagedSecretsPort(region, {
        create: input => secretsmanager.CreateManagedRdsSecret(input),
        delete: (secretArn, targetArn) => secretsmanager.DeleteManagedRdsSecret(secretArn, targetArn),
      });
      const endpointHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host === "::" || this.host === "[::]" ? "[::1]" : this.host;
      const appsync = new AppSyncService(
        this.store,
        region,
        this.clock,
        () => this.appSyncLocalTls
          ? `https://${endpointHost}:${this.customResourceCallbacks.port()}`
          : `http://${endpointHost}:${this.port}`,
        dynamodb,
        (roleArn, sessionName, servicePrincipal) => this.sts.assumeServiceRole(roleArn, sessionName, servicePrincipal),
        telemetry,
        {
          authenticate: (req, url) => authenticateSigV4(req, url, this.store, this.clock, region, "appsync"),
          authenticateRealtime: (headers, url, body) => {
            const synthetic = Readable.from([body]) as unknown as import("node:http").IncomingMessage;
            (synthetic as any).headers = headers;
            (synthetic as any).method = "POST";
            (synthetic as any).url = `${url.pathname}${url.search}`;
            return authenticateSigV4(synthetic, url, this.store, this.clock, region, "appsync");
          },
          identityValid: principal => {
            if (principal.principalType === "root") {
              const configured = this.store.configuredCredentials;
              return Boolean(configured?.rootRecovery && configured.accessKeyId === principal.accessKeyId);
            }
            const account = this.store.state.accounts[principal.accountId];
            if (!account) return false;
            if (principal.principalType === "user") {
              const key = account.iam.accessKeys[principal.accessKeyId];
              return Boolean(key?.status === "Active" && account.iam.users[key.userName]);
            }
            if (principal.principalType === "roleSession") {
              const session = account.iam.sessions[principal.accessKeyId];
              return Boolean(session && session.expiration > this.clock.now() && account.iam.roles[session.roleName]);
            }
            return false;
          },
          authorize: (principal, resource, context, currentRequestId) => this.evaluateAndRecordAuthorization(principal, {
            action: "appsync:GraphQL",
            resource,
            operation: "GraphQL",
            input: {},
            context,
          }, currentRequestId),
        },
      );
      const stepfunctions = new StepFunctionsService(this.store, region, this.clock, this.scheduler, lambda, telemetry, this.authMode, this.random, this.stepFunctionsLimits, input => eventbridge.publishServiceEvent(input), { caCertificatePath: this.customResourceCallbacks.caCertificatePath, port: () => this.customResourceCallbacks.port() }, { dynamodb, sqs, sns, eventbridge });
      eventbridge.setStepFunctionsService(stepfunctions);
      eventscheduler.setStepFunctionsService(stepfunctions);
      const availableCloudFormationProviders = [
        ...createIamCloudFormationProviders(this.iam, this.clock),
        createS3BucketProvider(s3),
        createSsmParameterProvider(ssm),
        createSecretsManagerSecretProvider(secretsmanager),
        createSecretsManagerResourcePolicyProvider(secretsmanager),
        createSecretsManagerRotationScheduleProvider(secretsmanager),
        createSecretsManagerSecretTargetAttachmentProvider(secretsmanager),
        createS3BucketPolicyProvider(s3),
        createCdkBucketDeploymentProvider(s3, this.store),
        createLambdaFunctionProvider(lambda, s3),
        createLambdaLayerVersionProvider(lambda, s3),
        ...createLambdaCompanionProviders(lambda),
        ...createLambdaCfn15Providers(lambda),
        createLambdaCustomResourceProvider(CLOUDFORMATION_CUSTOM_RESOURCE_TYPE, this.store, lambda, this.customResourceCallbacks),
        ...createAmplifyCustomResourceProviders(this.store, lambda, this.customResourceCallbacks),
        createLogGroupProvider(logs),
        ...createLogsCfn10Providers(logs),
        ...createCloudWatchCfn10Providers(metrics),
        createCloudWatchMetricStreamProvider(metrics),
        ...createCfn09CloudFormationProviders(sqs, eventbridge, lambda),
        createSqsQueuePolicyProvider(sqs),
        ...createApiGatewayRestCloudFormationProviders(apigateway, {
          resolveBodyS3Location: async location => (await s3.readObjectBytes(location.Bucket, location.Key, location.Version)).body,
        }),
        ...createApiGatewayRestCfn15CloudFormationProviders(apigateway),
        ...createApiGatewayV2CloudFormationProviders(apigatewayv2),
        createDynamoDbTableProvider(dynamodb),
        createDynamoDbGlobalTableProvider(dynamodb),
        ...createRdsCloudFormationProviders(this.rdsManager, region),
        ...createSesCloudFormationProviders(ses),
        ...createSnsCloudFormationProviders(sns),
        ...createAppSyncCloudFormationProviders(appsync, async location => {
          let parsed: URL;
          try { parsed = new URL(location); } catch {
            throw new AwsError("InvalidProperty", "AppSync S3 locations must use s3://bucket/key syntax.", 400);
          }
          if (parsed.protocol !== "s3:" || !parsed.hostname || !parsed.pathname.slice(1)) {
            throw new AwsError("InvalidProperty", "AppSync S3 locations must use s3://bucket/key syntax.", 400);
          }
          return (await s3.readObjectBytes(parsed.hostname, decodeURIComponent(parsed.pathname.slice(1)), parsed.searchParams.get("versionId") ?? undefined, 1024 * 1024)).body;
        }),
        ...createCognitoCloudFormationProviders(cognito),
        createStepFunctionsStateMachineProvider(stepfunctions),
      ];
      const cloudFormationProviders = this.cloudFormationProviderTypes === undefined
        ? availableCloudFormationProviders
        : availableCloudFormationProviders.filter(provider => this.cloudFormationProviderTypes!.has(provider.typeName));
      const generalCustomResourcesEnabled = this.cloudFormationProviderTypes === undefined || [...this.cloudFormationProviderTypes].some(typeName => typeName === CLOUDFORMATION_CUSTOM_RESOURCE_TYPE || typeName.startsWith("Custom::") && typeName !== "Custom::CDKBucketDeployment");
      services = { cloudformation: new CloudFormationService(this.store, region, this.clock, s3, (roleArn, sessionName) => this.sts.assumeServiceRole(roleArn, sessionName, "cloudformation.amazonaws.com"), cloudFormationProviders, this.authMode === "enforce" ? async (principal, targets) => {
        const providerRequestId = requestId();
        for (const target of targets) await this.authorize(principal, { action: target.action, resource: target.resource, operation: "CloudFormationProvider", input: {}, context: { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:SecureTransport": true, "aws:CalledVia": ["cloudformation.amazonaws.com"], ...(target.context ?? {}) } }, providerRequestId);
      } : undefined, {}, generalCustomResourcesEnabled ? typeName => createLambdaCustomResourceProvider(typeName, this.store, lambda, this.customResourceCallbacks) : undefined, this.customResourceCallbacks), ssm, secretsmanager, lambda, stepfunctions, eventbridge, eventscheduler, dynamodb, rds: new RdsService(this.rdsManager, region), s3, sqs, sns, apigateway, apigatewayv2, apigatewaywebsocket, logs, metrics, telemetry, ses, cognito, appsync };
      services.cloudformation.setSnsNotificationPublisher((topicArn, message, stackId) => sns.publishAuthorized({ TopicArn: topicArn, Message: message }, {
        principal: "cloudformation.amazonaws.com",
        sourceArn: stackId,
        sourceAccount: this.store.accountId,
        lineage: [stackId],
      }).then(() => undefined));
      services.cloudformation.setBootstrapParameterResolver(name => services!.ssm.resolveCloudFormationParameter(name));
      services.cloudformation.setDynamicReferenceResolver(async reference => {
        if (reference.family === "ssm" || reference.family === "ssm-secure") {
          const selected = `${reference.parameterName}${reference.parameterVersion === undefined ? "" : `:${reference.parameterVersion}`}`;
          const response = await services!.ssm.getParameterForService(selected, reference.family === "ssm-secure");
          const parameter = response.Parameter;
          if (!parameter || reference.family === "ssm" && parameter.Type !== "String" || reference.family === "ssm-secure" && parameter.Type !== "SecureString") throw new AwsError("ValidationError", `${reference.family} dynamic reference selected an incompatible parameter type`, 400);
          return { value: String(parameter.Value), generationId: response.generationId, version: response.version };
        }
        const response = await services!.secretsmanager.getSecretForService({ SecretId: reference.secretId!, ...(reference.versionId ? { VersionId: reference.versionId } : {}), ...(reference.versionStage ? { VersionStage: reference.versionStage } : {}) });
        if (response.SecretBinary !== undefined || typeof response.SecretString !== "string") throw new AwsError("ValidationError", "Secrets Manager dynamic references support SecretString values only", 400);
        if (!reference.jsonKey) return { value: response.SecretString };
        let parsed: unknown;
        try { parsed = JSON.parse(response.SecretString); } catch { throw new AwsError("ValidationError", "The selected SecretString is not valid JSON", 400); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, reference.jsonKey)) throw new AwsError("ValidationError", `The selected SecretString does not contain JSON key ${reference.jsonKey}`, 400);
        const value = (parsed as Record<string, unknown>)[reference.jsonKey];
        if (value === null || !["string", "number", "boolean"].includes(typeof value)) throw new AwsError("ValidationError", `Secret JSON key ${reference.jsonKey} must contain a scalar value`, 400);
        return { value: String(value) };
      });
      this.regionalServices.set(region, services);
      if (this.started) void this.startRegionalServices(region, services).catch(() => undefined);
    }
    return services;
  }

  private startRegionalServices(region: string, services: RegionalServices): Promise<void> {
    const existing = this.regionalStartup.get(region); if (existing) return existing;
    const startup = (async () => {
      services.logs.start(); await services.dynamodb.start(); await services.lambda.start();
      await services.apigateway.start();
      await services.ssm.start();
      await services.secretsmanager.start();
      await services.sns.start();
      await services.ses.start();
      await services.cognito.start();
      await services.appsync.start();
      await services.s3.start();
      // Automatic bootstrap materializes the reduced CDK contract only in the
      // simulator's configured Region. Merely signing a request for a
      // different Region must not silently bootstrap and thereby invent a new
      // CDK deployment environment. A bootstrap already persisted in another
      // Region is still reconciled on restart.
      const persistedBootstrap = Boolean(this.store.regionState(region).cloudformation.bootstrap);
      if ((this.cdkBootstrap && region === this.region) || persistedBootstrap) {
        try {
          await new CloudFormationBootstrapManager(this.store, this.iam, services.s3, region, this.clock, services.ssm).ensure();
          this.cdkBootstrapStatuses.set(region, { status: "ready", persisted: persistedBootstrap, owned: true, collisions: [] });
        } catch (error) {
          const aws = error instanceof AwsError ? error : undefined;
          if (aws && ["InvalidBootstrapState", "BucketAlreadyExists"].includes(aws.code) && /not owned/i.test(aws.message)) {
            const roleName = aws.message.match(/IAM role ([^\s]+)/)?.[1];
            const bucketName = aws.message.match(/CDK bootstrap bucket ([^\s]+)/)?.[1];
            const parameterName = aws.message.match(/CDK bootstrap parameter ([^\s]+)/)?.[1];
            const collision = parameterName
              ? { type: "AWS::SSM::Parameter", name: parameterName, arn: ssmParameterArn(region, this.store.accountId, parameterName) }
              : roleName
              ? { type: "AWS::IAM::Role", name: roleName, arn: `arn:aws:iam::${this.store.accountId}:role/${roleName}` }
              : { type: "AWS::S3::Bucket", name: bucketName ?? "unknown", arn: `arn:aws:s3:::${bucketName ?? "unknown"}` };
            this.cdkBootstrapStatuses.set(region, { status: "blocked", persisted: false, owned: false, collisions: [collision] });
          } else {
            throw error;
          }
        }
      } else {
        this.cdkBootstrapStatuses.set(region, { status: "disabled", persisted: false, owned: false, collisions: [] });
      }
      await Promise.all([services.sqs.start(), services.eventbridge.start(), services.eventscheduler.start(), services.cloudformation.start()]);
      await services.stepfunctions.start();
      if (this.started) services.metrics.start();
      if (this.sesEffectivePublicUrl) {
        await services.ses.completePostBind(this.sesEffectivePublicUrl);
        if (this.cognitoEffectivePublicUrl) await services.cognito.completePostBind(this.cognitoEffectivePublicUrl);
      }
    })();
    this.regionalStartup.set(region, startup);
    void startup.catch(() => { if (this.regionalStartup.get(region) === startup) this.regionalStartup.delete(region); });
    return startup;
  }

  private async handleWebSocketUpgrade(req: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer): Promise<void> {
    let service: ApiGatewayWebSocketService | undefined;
    try {
      const url = new URL(req.url ?? "/", `${this.invokeProtocol}://${req.headers.host ?? "localhost"}`); let invocationPath = url.pathname; let customDomain = false; let region: string | undefined;
      for (const candidate of this.store.listRegions()) {
        const v2 = this.services(candidate).apigatewayv2.customDomainInvocation(req.headers.host, url.pathname);
        if (v2.matched) { customDomain = true; region = candidate; invocationPath = v2.pathname ?? "/__stacksim_unmapped__/__stacksim_unmapped__"; break; }
      }
      const apiId = invocationPath.split("/")[1]; region ??= this.store.listRegions().find(candidate => Boolean(this.store.regionState(candidate).webSocketApis[apiId]));
      if (!region) throw new AwsError("NotFoundException", "Not Found", 404); service = this.services(region).apigatewaywebsocket; if (!service.hasApi(apiId)) throw new AwsError("NotFoundException", "Not Found", 404);
      const authorizationType = service.upgradeAuthorizationType(invocationPath); const hasSignature = String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256") || url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256";
      let principal: PrincipalContext | undefined;
      if ((authorizationType === "AWS_IAM" || hasSignature) && this.authMode !== "off") principal = await authenticateSigV4(req, url, this.store, this.clock, region, "execute-api");
      else if (this.authMode === "off" || hasSignature) principal = principalWithoutValidation(req, url, this.store, this.clock);
      (req as any).awsPrincipal = principal;
      if (authorizationType === "AWS_IAM" && this.authMode === "enforce") {
        if (!principal) throw new AwsError("MissingAuthenticationToken", "Missing Authentication Token", 403); const canonical = service.canonicalConnectPath(invocationPath); const [, resolvedApi, stage, routeKey] = canonical.split("/"); const resource = `arn:aws:execute-api:${region}:${this.store.accountId}:${resolvedApi}/${decodeURIComponent(stage)}/${routeKey}`;
        const context: Record<string, unknown> = { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:SourceIp": req.socket.remoteAddress?.replace(/^::ffff:/, ""), "aws:UserAgent": req.headers["user-agent"] ?? "", "aws:SecureTransport": Boolean((req.socket as any).encrypted) };
        const result = await this.evaluateAndRecordAuthorization(principal, { action: "execute-api:Invoke", resource, operation: "Invoke", input: {}, context }, requestId()); (req as any).awsIdentityAuthorization = result;
        if (result.decision !== "allowed") throw new AwsError("AccessDeniedException", `User: ${principal.principalArn} is not authorized to invoke ${resource}. ${result.reason}`, 403);
      }
      await service.upgrade(req, socket, head, invocationPath, url, customDomain);
    } catch (error) { (service ?? this.apigatewaywebsocket).rejectUpgrade(socket, error); }
  }

  private async handleAppSyncRealtimeUpgrade(req: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const match = url.pathname.match(/^\/graphql\/([^/]+)\/([^/]+)\/realtime$/);
      if (!match) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      const region = decodeURIComponent(match[1]);
      const apiId = decodeURIComponent(match[2]);
      if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || !/^[a-f0-9]{26}$/.test(apiId)) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      const services = this.services(region);
      await this.startRegionalServices(region, services);
      await services.appsync.upgradeRealtime(req, socket, head, apiId, url);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  }

  private requestRegion(req: import("node:http").IncomingMessage, url: URL): string {
    const explicit = req.headers["x-stacksim-region"];
    if (typeof explicit === "string" && /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(explicit)) return explicit;
    const regionalCognitoEndpoint = url.pathname.match(/^\/_stacksim\/cognito-idp\/([^/]+)\/sdk\/?$/);
    if (regionalCognitoEndpoint) {
      try {
        const region = decodeURIComponent(regionalCognitoEndpoint[1]);
        if (/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) return region;
      } catch {
        // Invalid endpoint segments fall through to the ordinary request context.
      }
    }
    const authorization = String(req.headers.authorization ?? "");
    const headerMatch = authorization.match(/Credential=[^,\s]+\/\d{8}\/([^/]+)\/[^/]+\/aws4_request/);
    if (headerMatch) return headerMatch[1];
    const credential = url.searchParams.get("X-Amz-Credential") ?? url.searchParams.get("x-amz-credential");
    const queryMatch = credential?.match(/^[^/]+\/\d{8}\/([^/]+)\/[^/]+\/aws4_request$/);
    return queryMatch?.[1] ?? this.region;
  }

  private requestSigningService(req: import("node:http").IncomingMessage, url: URL): string | undefined {
    const authorization = String(req.headers.authorization ?? ""); const header = authorization.match(/Credential=[^,\s]+\/\d{8}\/[^/]+\/([^/]+)\/aws4_request/); if (header) return header[1];
    const credential = url.searchParams.get("X-Amz-Credential") ?? url.searchParams.get("x-amz-credential"); return credential?.match(/^[^/]+\/\d{8}\/[^/]+\/([^/]+)\/aws4_request$/)?.[1];
  }

  private localConsoleService(url: URL): string {
    if (url.pathname.startsWith("/_stacksim/api/cloudformation/")) return "cloudformation";
    if (url.pathname.startsWith("/_stacksim/api/iam/")) return "iam";
    if (url.pathname.startsWith("/_stacksim/api/rds/")) return "rds";
    if (url.pathname.startsWith("/_stacksim/api/cognito/")) return "cognito-idp";
    if (url.pathname.startsWith("/_stacksim/api/ses/")) return "ses";
    if (url.pathname.startsWith("/_stacksim/api/secrets-manager/")) return "secretsmanager";
    if (url.pathname.startsWith("/_stacksim/api/sns/")) return "sns";
    if (url.pathname.startsWith("/_stacksim/api/dynamodb/")) return "dynamodb";
    if (url.pathname.startsWith("/_stacksim/api/lambda/")) return "lambda";
    if (url.pathname.startsWith("/_stacksim/api/eventbridge/")) return "events";
    return "sts";
  }

  private localConsoleMutationTarget(
    req: import("node:http").IncomingMessage,
    url: URL,
    region: string,
    principal: PrincipalContext,
  ): AuthorizationTarget | undefined {
    const method = req.method ?? "GET";
    const pathname = url.pathname;
    if (pathname === "/_stacksim/api/iam/role-preflight") return undefined;
    const rdsQueryEditorPath = pathname.match(/^\/_stacksim\/api\/rds\/query-editor\/([^/]+)\/(?:objects|query)$/);
    if (rdsQueryEditorPath) {
      let identifier: string;
      try {
        identifier = decodeURIComponent(rdsQueryEditorPath[1]);
        if (encodeURIComponent(identifier) !== rdsQueryEditorPath[1]) return undefined;
      } catch {
        return undefined;
      }
      const instance = this.store.regionState(region).rdsDbInstances[identifier.toLowerCase()];
      const resource = instance?.dbInstanceArn ?? `arn:aws:rds:${region}:${this.store.accountId}:db:${identifier.toLowerCase()}`;
      return {
        action: "rds:ExecuteStatement",
        resource,
        operation: "ExecuteStatement",
        input: { DBInstanceIdentifier: identifier },
        context: {
          "aws:PrincipalArn": principal.principalArn,
          "aws:PrincipalAccount": principal.accountId,
          "aws:RequestedRegion": region,
          "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
          ...Object.fromEntries(Object.entries(instance?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
        },
      };
    }
    if (method === "GET" || method === "HEAD") return undefined;
    let action = "stacksim:MutateConsoleResource";
    let resource = "*";
    let operation = "ConsoleMutation";
    if (pathname === "/_stacksim/api/iam/policy-validation" && method === "POST") return { action: "iam:GetPolicy", resource: "*", operation: "ValidatePolicyDocument", input: {}, context: { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString() } };
    const iamPath = pathname.match(/^\/_stacksim\/api\/iam\/(roles|policies|users|groups)(?:\/([^/]+))?(?:\/(attach|detach|access-keys|members))?/);
    if (iamPath) {
      const kind = iamPath[1]; const name = iamPath[2] ? decodeURIComponent(iamPath[2]) : "*"; const suffix = iamPath[3];
      const entity = kind === "users" ? "User" : kind === "groups" ? "Group" : kind === "roles" ? "Role" : "Policy";
      operation = suffix === "attach" ? `Attach${entity}Policy` : suffix === "detach" ? `Detach${entity}Policy`
        : suffix === "access-keys" ? method === "POST" ? "CreateAccessKey" : method === "PATCH" ? "UpdateAccessKey" : "DeleteAccessKey"
          : suffix === "members" ? method === "PUT" ? "AddUserToGroup" : "RemoveUserFromGroup"
            : method === "POST" ? `Create${entity}` : method === "DELETE" ? `Delete${entity}` : "ConsoleMutation";
      action = `iam:${operation}`;
      resource = kind === "roles" ? `arn:aws:iam::${this.store.accountId}:role/${name}` : kind === "users" ? `arn:aws:iam::${this.store.accountId}:user/${name}` : kind === "groups" ? `arn:aws:iam::${this.store.accountId}:group/${name}` : name === "*" ? "*" : name;
    } else if (pathname.startsWith("/_stacksim/api/cloudformation/")) {
      const path = pathname.slice("/_stacksim/api/cloudformation/".length);
      const stackName = path.match(/^stacks\/([^/]+)/)?.[1];
      resource = stackName ? `arn:aws:cloudformation:${region}:${this.store.accountId}:stack/${decodeURIComponent(stackName)}/*` : "*";
      operation = path.endsWith("/execute") ? "ExecuteChangeSet"
        : path.endsWith("/change-sets") && method === "POST" ? "CreateChangeSet"
          : path.includes("/change-sets/") && method === "DELETE" ? "DeleteChangeSet"
            : path.endsWith("/termination-protection") ? "UpdateTerminationProtection"
              : path.endsWith("/rollback") ? "RollbackStack"
                : path.endsWith("/continue-update-rollback") ? "ContinueUpdateRollback"
                  : method === "PUT" ? "UpdateStack" : method === "DELETE" ? "DeleteStack" : "ConsoleMutation";
      action = `cloudformation:${operation}`;
    } else if (pathname.startsWith("/_stacksim/api/cognito/")) {
      const path = pathname.slice("/_stacksim/api/cognito/".length);
      const poolId = path.match(/^user-pools\/([^/]+)/)?.[1];
      resource = poolId ? `arn:aws:cognito-idp:${region}:${this.store.accountId}:userpool/${decodeURIComponent(poolId)}` : "*";
      operation = path === "user-pools" ? "CreateUserPool"
        : /\/oauth\/resource-servers(?:\/|$)/.test(path) ? method === "POST" ? "CreateResourceServer" : "DeleteResourceServer"
          : /\/oauth\/domain$/.test(path) ? method === "POST" ? "CreateUserPoolDomain" : "DeleteUserPoolDomain"
            : /\/oauth\/branding$/.test(path) ? "UpdateManagedLoginBranding"
              : /\/app-clients(?:\/|$)/.test(path) ? method === "POST" ? "CreateUserPoolClient" : method === "PATCH" ? "UpdateUserPoolClient" : "DeleteUserPoolClient"
          : /\/groups(?:\/|$)/.test(path) ? method === "POST" ? "CreateGroup" : "DeleteGroup"
            : /\/users(?:\/|$)/.test(path) ? method === "POST" ? "AdminCreateUser" : method === "DELETE" ? "AdminDeleteUser" : "AdminMutateUser"
              : method === "DELETE" ? "DeleteUserPool" : "UpdateUserPool";
      action = `cognito-idp:${operation}`;
    } else if (pathname.startsWith("/_stacksim/api/ses/")) {
      operation = pathname.endsWith("/purge") ? "PurgeLocalInbox" : method === "DELETE" ? "DeleteLocalMessage" : "UpdateLocalMessage";
      action = `ses:${operation}`;
      resource = `arn:aws:ses:${region}:${this.store.accountId}:identity/*`;
    }
    return {
      action,
      resource,
      operation,
      input: {},
      context: {
        "aws:PrincipalArn": principal.principalArn,
        "aws:PrincipalAccount": principal.accountId,
        "aws:RequestedRegion": region,
        "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
      },
    };
  }

  private routeService(req: import("node:http").IncomingMessage, url: URL): string {
    const target = String(req.headers["x-amz-target"] ?? ""); const explicit = String(req.headers["x-stacksim-service"] ?? ""); const host = String(req.headers.host ?? "").replace(/:\d+$/, ""); if (explicit === "appsync" || explicit === "iam" || explicit === "sts") return explicit; if (explicit === "states" || target.startsWith("AWSStepFunctions.")) return "states"; if (explicit === "cognito-idp" || cognitoTargetOperation(target)) return "cognito-idp"; if (explicit === "sns") return "sns"; if (explicit === "ses" || url.pathname.startsWith("/v2/email/")) return "ses"; if (explicit === "cloudformation") return "cloudformation"; if (explicit === "ssm" || target.startsWith("AmazonSSM.")) return "ssm"; if (explicit === "secretsmanager" || target.startsWith("secretsmanager.")) return "secretsmanager"; if (explicit === "rds") return "rds"; if (explicit === "events" || target.startsWith("AWSEvents.")) return "events"; if (explicit === "scheduler") return "scheduler"; if (explicit === "sqs" || target.startsWith("AmazonSQS.")) return "sqs"; if (explicit === "s3" || /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(host) || /.+\.(?:localhost|127\.0\.0\.1)$/i.test(host)) return "s3"; if (/^DynamoDB(?:Streams)?_/.test(target)) return "dynamodb"; if (target.startsWith("Logs_20140328")) return "logs"; if (target.startsWith("GraniteServiceVersion20100801.")) return "monitoring"; if (url.pathname.startsWith("/2014-11-13") || url.pathname.startsWith("/2015-03-31") || url.pathname.startsWith("/2016-08-19") || url.pathname.startsWith("/2017-03-31/tags/") || url.pathname.startsWith("/2017-10-31") || url.pathname.startsWith("/2018-10-31") || url.pathname.startsWith("/2019-09-25") || url.pathname.startsWith("/2019-09-30") || url.pathname.startsWith("/2020-04-22") || url.pathname.startsWith("/2020-06-30") || url.pathname.startsWith("/2021-07-20") || url.pathname.startsWith("/2021-10-31") || url.pathname.startsWith("/2021-11-15") || url.pathname.startsWith("/2024-08-31") || url.pathname.startsWith("/2025-11-30") || url.pathname.startsWith("/2025-12-01")) return "lambda"; if (url.pathname.startsWith("/v2") || url.pathname.startsWith("/restapis") || url.pathname === "/account" || url.pathname.startsWith("/tags/") || url.pathname.startsWith("/apikeys") || url.pathname.startsWith("/usageplans") || url.pathname.startsWith("/domainnames") || url.pathname.startsWith("/domainnameaccessassociations") || url.pathname === "/rejectdomainnameaccessassociations" || url.pathname.startsWith("/vpclinks") || url.pathname.startsWith("/clientcertificates") || url.pathname.startsWith("/sdktypes")) return "apigateway"; return "unknown";
  }

  private async queryProtocolService(req: import("node:http").IncomingMessage, url: URL): Promise<string> {
    const action = req.method === "GET"
      ? url.searchParams.get("Action")
      : String(req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")
        ? new URLSearchParams((await readBody(req)).toString("utf8")).get("Action")
        : null;
    if (CLOUDFORMATION_SUPPORTED_ACTIONS.includes(action ?? "")) return "cloudformation";
    const queryInput = req.method === "GET" ? Object.fromEntries(url.searchParams) : parseAwsQuery((await readBody(req)).toString("utf8"));
    if (queryInput.Version === "2010-12-01" && SES_V1_PHASE_01_02_ACTIONS.has(String(queryInput.Action ?? action ?? ""))) return "ses";
    if (queryInput.Version === "2010-03-31" && SNS_02_ACTIONS.has(String(queryInput.Action ?? action ?? ""))) return "sns";
    if (new Set(["CreateQueue", "DeleteQueue", "GetQueueUrl", "ListQueues", "GetQueueAttributes", "SetQueueAttributes", "TagQueue", "UntagQueue", "ListQueueTags", "SendMessage", "ReceiveMessage", "DeleteMessage", "ChangeMessageVisibility", "SendMessageBatch", "DeleteMessageBatch", "ChangeMessageVisibilityBatch", "PurgeQueue", "ListDeadLetterSourceQueues", "AddPermission", "RemovePermission"]).has(action ?? "")) return "sqs";
    if (req.method === "GET") return "unknown";
    if (new Set(["CreateDBInstance", "DescribeDBInstances", "DeleteDBInstance", "ModifyDBInstance", "RebootDBInstance", "StopDBInstance", "StartDBInstance", "DescribeValidDBInstanceModifications", "AddTagsToResource", "RemoveTagsFromResource", "ListTagsForResource", "CreateDBParameterGroup", "DescribeDBParameterGroups", "ModifyDBParameterGroup", "ResetDBParameterGroup", "DeleteDBParameterGroup", "DescribeDBParameters", "DescribeEngineDefaultParameters", "DescribeDBEngineVersions", "DescribeOrderableDBInstanceOptions", "DescribeAccountAttributes"]).has(action ?? "")) return "rds";
    return new Set(["PutMetricData", "ListMetrics", "GetMetricStatistics", "GetMetricData", "GetDataset", "AssociateDatasetKmsKey", "DisassociateDatasetKmsKey", "PutMetricStream", "GetMetricStream", "ListMetricStreams", "DeleteMetricStream", "StartMetricStreams", "StopMetricStreams", "PutInsightRule", "DescribeInsightRules", "DeleteInsightRules", "EnableInsightRules", "DisableInsightRules", "GetInsightRuleReport", "PutManagedInsightRules", "ListManagedInsightRules", "PutAnomalyDetector", "DescribeAnomalyDetectors", "DeleteAnomalyDetector", "PutMetricAlarm", "PutCompositeAlarm", "PutLogAlarm", "DescribeAlarms", "DescribeAlarmsForMetric", "DescribeAlarmContributors", "DeleteAlarms", "SetAlarmState", "EnableAlarmActions", "DisableAlarmActions", "DescribeAlarmHistory", "PutAlarmMuteRule", "GetAlarmMuteRule", "ListAlarmMuteRules", "DeleteAlarmMuteRule", "TagResource", "UntagResource", "ListTagsForResource", "PutDashboard", "GetDashboard", "ListDashboards", "DeleteDashboards", "GetMetricWidgetImage"]).has(action ?? "") ? "monitoring" : "unknown";
  }

  private async authenticateAndAuthorize(req: import("node:http").IncomingMessage, url: URL, region: string, service: string, currentRequestId: string): Promise<PrincipalContext> {
    const unsignedS3 = this.authMode !== "off" && service === "s3" && !req.headers.authorization && !url.searchParams.has("X-Amz-Signature");
    const mustValidateIdentity = this.authMode === "off" && service === "sts"
      && String((parseAwsQuery((await readBody(req)).toString("utf8")) as any).Action ?? "") === "GetCallerIdentity";
    const principal = unsignedS3
      ? { principalType: "anonymous" as const, accessKeyId: "", principalArn: "*", principalId: "anonymous", accountId: "" }
      : this.authMode === "off" && !mustValidateIdentity ? principalWithoutValidation(req, url, this.store, this.clock) : await authenticateSigV4(req, url, this.store, this.clock, region, service === "unknown" ? undefined : service === "s3-control" ? "s3" : service);
    (req as any).awsPrincipal = principal;
    if (service === "s3" && req.method === "OPTIONS") return principal;
    if (this.authMode !== "enforce" && !unsignedS3) return principal;
    const target = await authorizationTarget(req, url, service, region, this.store.accountId, principal, this.clock.now(), service === "iam" ? this.store.ensureAccount().iam : undefined);
    if (service === "s3") {
      await this.services(region).s3.enrichAuthorizationContext(target.resource, target.context);
      for (const additional of target.additionalTargets ?? []) await this.services(region).s3.enrichAuthorizationContext(additional.resource, additional.context);
    }
    if (service === "dynamodb") {
      const enrichResourceTags = (authorization: AuthorizationTarget) => { if (!authorization.resource.startsWith("arn:")) return; const table = Object.values(this.store.regionState(region).tables).find(candidate => authorization.resource === candidate.arn || authorization.resource.startsWith(`${candidate.arn}/index/`) || authorization.resource.startsWith(`${candidate.arn}/stream/`)); for (const [key, value] of Object.entries(table?.tags ?? {})) authorization.context[`aws:ResourceTag/${key}`] = value; };
      enrichResourceTags(target); for (const additional of target.additionalTargets ?? []) enrichResourceTags(additional);
      if (new Set(["ExecuteStatement", "BatchExecuteStatement", "ExecuteTransaction"]).has(target.operation)) {
        const entries = target.operation === "ExecuteStatement" ? [target.input] : target.operation === "BatchExecuteStatement" ? target.input.Statements : target.input.TransactStatements;
        const authorizations = [target, ...(target.additionalTargets ?? [])];
        if (Array.isArray(entries)) for (let index = 0; index < Math.min(entries.length, authorizations.length); index++) {
          const authorization = authorizations[index]; authorization.context = { ...authorization.context };
          try {
            const plan = parsePartiql(entries[index]?.Statement, entries[index]?.Parameters); const table = this.store.regionState(region).tables[plan.tableName]; if (!table) continue;
            const selectedIndex = plan.indexName ? [...(table.localSecondaryIndexes ?? []), ...(table.globalSecondaryIndexes ?? [])].find(candidate => candidate.indexName === plan.indexName) : undefined;
            const schema = selectedIndex?.keySchema ?? table.keySchema; const partition = schema.find(key => key.KeyType === "HASH")?.AttributeName;
            if (plan.kind === "select") {
              authorization.context["dynamodb:FullTableScan"] = classifyPartiqlAccess(plan, schema, table.keySchema) === "scan";
              authorization.context["dynamodb:Select"] = plan.projection ? "SPECIFIC_ATTRIBUTES" : selectedIndex ? "ALL_PROJECTED_ATTRIBUTES" : "ALL_ATTRIBUTES";
            }
            if (partition) {
              const leading = plan.kind === "insert" && plan.item?.[partition] ? [plan.item[partition]] : plan.keyAlternatives[partition] ?? [];
              if (leading.length) authorization.context["dynamodb:LeadingKeys"] = leading.map(value => { const type = Object.keys(value)[0]; return String((value as any)[type]); });
            }
            if (plan.topLevelAttributes.length && (plan.kind !== "select" || plan.projection)) authorization.context["dynamodb:Attributes"] = plan.topLevelAttributes;
          } catch { /* The service parser returns the authoritative syntax error after fail-closed header authorization. */ }
        }
      }
    }
    if (service === "rds" && target.resource.startsWith("arn:")) { const regional = this.store.regionState(region); const resourceTags = Object.values(regional.rdsDbInstances).find(candidate => candidate.dbInstanceArn === target.resource)?.tags ?? Object.values(regional.rdsDbParameterGroups).find(candidate => candidate.dbParameterGroupArn === target.resource)?.tags ?? {}; for (const [key, value] of Object.entries(resourceTags)) target.context[`aws:ResourceTag/${key}`] = value; }
    if (service === "sqs" && target.resource.startsWith("arn:")) { const match = target.resource.match(/^arn:[a-z0-9-]+:sqs:([^:]+):(\d{12}):/i); const queues = match ? this.store.state.accounts[match[2]]?.regions[match[1]]?.sqsQueues : this.store.regionState(region).sqsQueues; const queue = Object.values(queues ?? {}).find(candidate => candidate.queueArn === target.resource); for (const [key, value] of Object.entries(queue?.tags ?? {})) target.context[`aws:ResourceTag/${key}`] = value; }
    if (service === "sns" && target.resource.startsWith("arn:")) {
      const match = target.resource.match(/^arn:[a-z0-9-]+:sns:([^:]+):(\d{12}):([^:]+)(?::[^:]+)?$/i);
      const topics = match ? this.store.state.accounts[match[2]]?.regions[match[1]]?.sns?.topics : this.store.regionState(region).sns.topics;
      const topic = match ? topics?.[match[3]] : undefined;
      for (const [key, value] of Object.entries(topic?.tags ?? {})) target.context[`aws:ResourceTag/${key}`] = value;
    }
    if (service === "ssm") {
      const enrichResourceTags = (authorization: AuthorizationTarget) => {
        if (!authorization.resource.startsWith("arn:")) return;
        const parameter = Object.values(this.store.regionState(region).parameterStore.parameters).find(candidate => candidate.arn === authorization.resource);
        for (const [key, value] of Object.entries(parameter?.tags ?? {})) {
          authorization.context[`aws:ResourceTag/${key}`] = value;
          authorization.context[`ssm:resourceTag/${key}`] = value;
        }
      };
      enrichResourceTags(target);
      for (const additional of target.additionalTargets ?? []) enrichResourceTags(additional);
    }
    if (service === "secretsmanager") {
      const secretsManager = this.services(region).secretsmanager;
      const actualArn = secretsManager.resolveArn(target.input.SecretId);
      if (actualArn) target.resource = actualArn;
      const tags = secretsManager.resourceTags(target.input.SecretId);
      for (const [key, value] of Object.entries(tags)) {
        target.context[`aws:ResourceTag/${key}`] = value;
        target.context[`secretsmanager:ResourceTag/${key}`] = value;
      }
    }
    if (service === "cognito-idp" && target.resource.startsWith("arn:")) {
      const pool = Object.values(this.store.regionState(region).cognito.pools)
        .find(candidate => candidate.arn === target.resource);
      for (const [key, value] of Object.entries(pool?.tags ?? {})) {
        target.context[`aws:ResourceTag/${key}`] = value;
      }
    }
    if (service === "appsync" && target.resource.startsWith("arn:")) {
      const appsync = this.services(region).appsync;
      const apiArn = target.resource.match(/^(arn:[^:]+:appsync:[^:]+:\d{12}:apis\/[^/]+)/)?.[1] ?? target.resource;
      for (const [key, value] of Object.entries(appsync.resourceTags(apiArn))) {
        target.context[`aws:ResourceTag/${key}`] = value;
      }
    }
    if (service === "states" && target.resource.startsWith("arn:")) {
      const machineArn = target.resource.includes(":execution:")
        ? this.store.regionState(region).stepFunctions.executions[target.resource]?.stateMachineArn
        : target.resource;
      const machine = machineArn ? this.store.regionState(region).stepFunctions.stateMachines[machineArn] : undefined;
      for (const [key, value] of Object.entries(machine?.tags ?? {})) target.context[`aws:ResourceTag/${key}`] = value;
    }
    if (service === "ses") {
      const ses = this.services(region).ses;
      if (
        new Set(["ses:SendEmail", "ses:SendRawEmail", "ses:SendTemplatedEmail", "ses:SendBulkEmail", "ses:SendBulkTemplatedEmail"]).has(target.action)
        && target.input.SourceArn === undefined
        && target.input.FromEmailAddressIdentityArn === undefined
      ) {
        const identityArn = ses.authorizationIdentityArn(target.context["ses:FromAddress"]);
        if (identityArn) target.resource = identityArn;
      }
      const enrichResourceTags = (authorization: AuthorizationTarget) => {
        if (!authorization.resource.startsWith("arn:")) return;
        for (const [key, value] of Object.entries(ses.resourceTags(authorization.resource))) authorization.context[`aws:ResourceTag/${key}`] = value;
      };
      enrichResourceTags(target);
      for (const additional of target.additionalTargets ?? []) enrichResourceTags(additional);
    }
    if (service === "events") { const regional = this.store.regionState(region); const persistedRule = Object.values(regional.eventRules).find(candidate => candidate.arn === target.resource); if (target.operation === "PutRule" && persistedRule) target.additionalTargets = target.additionalTargets?.filter(candidate => candidate.action !== "events:TagResource"); const enrich = (authorization: AuthorizationTarget) => { const rule = Object.values(regional.eventRules).find(candidate => candidate.arn === authorization.resource); const tags = Object.values(regional.eventBuses).find(candidate => candidate.arn === authorization.resource)?.tags ?? rule?.tags ?? {}; for (const [key, value] of Object.entries(tags)) authorization.context[`aws:ResourceTag/${key}`] = value; if (rule?.managedBy) authorization.context["events:ManagedBy"] = rule.managedBy; }; enrich(target); for (const additional of target.additionalTargets ?? []) enrich(additional); }
    if (service === "scheduler") { const regional = this.store.regionState(region); const enrich = (authorization: AuthorizationTarget) => { const group = Object.values(regional.eventScheduleGroups).find(candidate => candidate.arn === authorization.resource); for (const [key, value] of Object.entries(group?.tags ?? {})) authorization.context[`aws:ResourceTag/${key}`] = value; }; enrich(target); for (const additional of target.additionalTargets ?? []) enrich(additional); }
    if (service === "sts" && target.operation === "GetCallerIdentity") return principal;
    if (service === "events" && target.operation === "PutEvents" && Array.isArray(target.input.Entries) && target.input.Entries.length) {
      const entryErrors: Array<{ ErrorCode: string; ErrorMessage: string } | undefined> = [];
      for (const [index, entryTarget] of [target, ...(target.additionalTargets ?? [])].entries()) { const result = await this.evaluateAndRecordAuthorization(principal, entryTarget, currentRequestId); if (result.decision !== "allowed") entryErrors[index] = { ErrorCode: "AccessDeniedException", ErrorMessage: `User: ${principal.principalArn} is not authorized to perform: ${entryTarget.action} on resource: ${entryTarget.resource}. ${result.reason}` }; }
      (req as any).awsEventBridgeEntryAuthorizationErrors = entryErrors; return principal;
    }
    await this.authorize(principal, target, currentRequestId);
    for (const additional of target.additionalTargets ?? []) await this.authorize(principal, additional, currentRequestId);
    if (service === "secretsmanager" && target.operation === "BatchGetSecretValue") {
      (req as any).awsSecretsManagerBatchAuthorize = async ({ secret, action, versionStage }: import("./secrets-manager/secret-store.js").BatchValueAuthorization extends (input: infer Input) => any ? Input : never) => {
        const context: Record<string, unknown> = {
          "aws:PrincipalArn": principal.principalArn,
          "aws:PrincipalAccount": principal.accountId,
          "aws:RequestedRegion": region,
          "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
          "aws:TokenIssueTime": principal.issuedAt === undefined ? undefined : new Date(principal.issuedAt).toISOString(),
          "aws:SourceIdentity": principal.sourceIdentity,
          "secretsmanager:VersionStage": versionStage,
        };
        for (const [key, value] of Object.entries(secret.tags)) {
          context[`aws:ResourceTag/${key}`] = value;
          context[`secretsmanager:ResourceTag/${key}`] = value;
        }
        return this.evaluateAndRecordAuthorization(principal, { action, resource: secret.arn, operation: "GetSecretValue", input: { SecretId: secret.arn, VersionStage: versionStage }, context }, currentRequestId);
      };
    }
    if (service === "dynamodb" && target.operation === "CreateTable" && target.input.ResourcePolicy !== undefined) await this.authorize(principal, { ...target, action: "dynamodb:PutResourcePolicy", operation: "PutResourcePolicy" }, currentRequestId);
    return principal;
  }

  private async authorize(principal: PrincipalContext, target: AuthorizationTarget, currentRequestId: string): Promise<void> {
    const result = await this.evaluateAndRecordAuthorization(principal, target, currentRequestId);
    if (result.decision !== "allowed") throw new AwsError("AccessDeniedException", `User: ${principal.principalArn} is not authorized to perform: ${target.action} on resource: ${target.resource}. ${result.reason}`, 403);
  }

  private async authorizeFunctionUrl(req: import("node:http").IncomingMessage, lambda: LambdaService, target: NonNullable<ReturnType<LambdaService["findFunctionUrl"]>>, principal: PrincipalContext | undefined, currentRequestId: string, region: string): Promise<void> {
    const principalArn = principal?.principalArn ?? "*"; const sameAccount = !principal || principal.accountId === this.store.accountId; const context: Record<string, unknown> = { "aws:PrincipalArn": principalArn, "aws:PrincipalAccount": principal?.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString(), "aws:TokenIssueTime": principal?.issuedAt === undefined ? undefined : new Date(principal.issuedAt).toISOString(), "aws:SourceIdentity": principal?.sourceIdentity, "aws:SourceIp": req.socket.remoteAddress?.replace(/^::ffff:/, ""), "aws:UserAgent": req.headers["user-agent"] ?? "", "aws:SecureTransport": Boolean((req.socket as any).encrypted), "lambda:FunctionUrlAuthType": target.config.authType, "lambda:InvokedViaFunctionUrl": true };
    for (const action of ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"] as const) {
      const root = principal?.principalType === "root"; const identity: AuthorizationResult = !principal ? { decision: "implicitDeny", reason: "Anonymous function URL requests have no identity policy", matchedStatements: [] } : root && this.rootRecovery ? { decision: "allowed", reason: "Configured recovery root", matchedStatements: [] } : evaluateAuthorization(this.store.ensureAccount().iam, principal, action, target.functionArn, context); const resource = lambda.functionUrlResourcePolicy(principal ?? principalArn, target, action, context);
      const result = combineIdentityAndResourceAuthorization(identity, resource, !principal ? "service" : sameAccount ? "sameAccount" : "crossAccount");
      const decisions = this.store.ensureAccount().iam.authorizationDecisions; decisions.push({ time: this.clock.now(), requestId: currentRequestId, principalArn, action, resource: target.functionArn, decision: result.decision, reason: result.reason }); if (decisions.length > 1_000) decisions.splice(0, decisions.length - 1_000); if (result.decision !== "allowed") { await this.store.save(); throw new AwsError("AccessDeniedException", `User ${principalArn} is not authorized to perform ${action} on ${target.functionArn}. ${result.reason}`, 403); }
    }
    await this.store.save();
  }

  private async evaluateAndRecordAuthorization(principal: PrincipalContext, target: AuthorizationTarget, currentRequestId: string) {
    const root = principal.principalType === "root";
    const bootstrap = root && principal.accountId === this.store.accountId && this.rootRecovery;
    const callerIam = principal.accountId ? this.store.ensureAccount(principal.accountId).iam : undefined;
    let identity: AuthorizationResult = bootstrap
      ? { decision: "allowed", reason: "Configured recovery root", matchedStatements: [] }
      : callerIam ? evaluateAuthorization(callerIam, principal, target.action, target.resource, target.context) : { decision: "implicitDeny", reason: "Anonymous requests have no identity policy", matchedStatements: [] };
    let result = identity;
    if (target.action.startsWith("s3:") && !target.action.includes("AccountPublicAccessBlock")) {
      const s3 = await this.services(String(target.context["aws:RequestedRegion"])).s3.resourceAuthorization(principal, target.action, target.resource, target.context);
      if (s3) {
        const rootRecovery = principal.principalArn === `arn:aws:iam::${s3.ownerAccountId}:root`
          && new Set(["s3:GetBucketPolicy", "s3:GetBucketPolicyStatus", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy"]).has(target.action);
        if (rootRecovery) identity = { decision: "allowed", reason: "S3 bucket-owner root recovery", matchedStatements: [] };
        result = combineIdentityAndResourceAuthorization(identity, s3.result, principal.principalArn === "*" ? "service" : principal.accountId === s3.ownerAccountId ? "sameAccount" : "crossAccount");
        if (rootRecovery && s3.result.decision === "explicitDeny") result = identity;
      }
    }
    const dynamoPolicy = this.dynamoResourcePolicy(target);
    if (dynamoPolicy && !(bootstrap && target.action === "dynamodb:DeleteResourcePolicy")) {
      const resource = evaluateResourcePolicy(dynamoPolicy.document, principal, target.action, target.resource, target.context);
      result = combineIdentityAndResourceAuthorization(identity, resource, principal.accountId === dynamoPolicy.accountId ? "sameAccount" : "crossAccount");
    }
    const sqsPolicy = this.sqsResourcePolicy(target);
    if (sqsPolicy) {
      const resource = evaluateSqsQueuePolicy(sqsPolicy.document, { type: "AWS", arn: principal.principalArn, accountId: principal.accountId, roleArn: principal.roleArn }, target.action, target.resource, target.context);
      result = combineIdentityAndResourceAuthorization(identity, resource, principal.accountId === sqsPolicy.accountId ? "sameAccount" : "crossAccount");
      const nondelegable = new Set([
        "sqs:AddPermission", "sqs:CancelMessageMoveTask", "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:ListMessageMoveTasks",
        "sqs:ListQueueTags", "sqs:ListQueues", "sqs:RemovePermission", "sqs:SetQueueAttributes", "sqs:StartMessageMoveTask",
        "sqs:TagQueue", "sqs:UntagQueue",
      ]);
      if (principal.accountId !== sqsPolicy.accountId && nondelegable.has(target.action) && result.decision !== "explicitDeny") result = {
        decision: "implicitDeny",
        reason: `${target.action} cannot be delegated across SQS accounts`,
        matchedStatements: result.matchedStatements,
      };
    }
    const snsPolicy = this.snsResourcePolicy(target);
    if (snsPolicy) {
      const resource: AuthorizationResult = snsPolicy.document
        ? evaluateResourcePolicy(snsPolicy.document, principal, target.action, target.resource, target.context)
        : { decision: "implicitDeny", reason: "The topic has no applicable resource policy", matchedStatements: [] };
      result = combineIdentityAndResourceAuthorization(identity, resource, principal.accountId === snsPolicy.accountId ? "sameAccount" : "crossAccount");
      const nondelegable = new Set([
        "sns:AddPermission", "sns:RemovePermission", "sns:SetTopicAttributes", "sns:DeleteTopic",
        "sns:TagResource", "sns:UntagResource", "sns:ListTagsForResource",
      ]);
      if (principal.accountId !== snsPolicy.accountId && nondelegable.has(target.action) && result.decision !== "explicitDeny") result = {
        decision: "implicitDeny",
        reason: `${target.action} cannot be delegated across SNS accounts`,
        matchedStatements: result.matchedStatements,
      };
    }
    if (target.action.startsWith("secretsmanager:") && target.resource.startsWith("arn:")) {
      const region = String(target.context["aws:RequestedRegion"]);
      const attached = this.services(region).secretsmanager.resourcePolicy(target.resource);
      if (attached) {
        const resource = evaluateResourcePolicy(attached.normalized, principal, target.action, target.resource, target.context);
        result = combineIdentityAndResourceAuthorization(identity, resource, principal.accountId === this.store.accountId ? "sameAccount" : "crossAccount");
      }
    }
    if (target.action.startsWith("ses:") && target.resource.startsWith("arn:aws:ses:")) {
      const documents = this.services(String(target.context["aws:RequestedRegion"])).ses.resourcePolicies(target.resource);
      if (documents.length) {
        const evaluations = documents.map(document => evaluateResourcePolicy(document, principal, target.action, target.resource, target.context));
        const resource: AuthorizationResult = evaluations.some(item => item.decision === "explicitDeny")
          ? { decision: "explicitDeny", reason: "An SES identity policy explicitly denies the action", matchedStatements: evaluations.flatMap(item => item.matchedStatements) }
          : evaluations.some(item => item.decision === "allowed")
            ? { decision: "allowed", reason: "An SES identity policy allows the action", matchedStatements: evaluations.flatMap(item => item.matchedStatements), grantBasis: evaluations.filter(item => item.decision === "allowed").sort((a, b) => ({ wildcard: 0, account: 1, role: 2, directUser: 3, directSession: 3 }[b.grantBasis ?? "wildcard"] - { wildcard: 0, account: 1, role: 2, directUser: 3, directSession: 3 }[a.grantBasis ?? "wildcard"]))[0]?.grantBasis }
            : { decision: "implicitDeny", reason: "No SES identity policy allows the action", matchedStatements: evaluations.flatMap(item => item.matchedStatements) };
        result = combineIdentityAndResourceAuthorization(identity, resource, principal.accountId === this.store.accountId ? "sameAccount" : "crossAccount");
      }
    }
    const decisions = (callerIam ?? this.store.ensureAccount(this.store.accountId).iam).authorizationDecisions;
    decisions.push({ time: this.clock.now(), requestId: currentRequestId, principalArn: principal.principalArn, action: target.action, resource: target.resource, decision: result.decision, reason: result.reason });
    if (decisions.length > 1_000) decisions.splice(0, decisions.length - 1_000);
    await this.store.save();
    return result;
  }

  private sqsResourcePolicy(target: AuthorizationTarget): { document?: import("./types.js").PolicyDocument; accountId: string } | undefined {
    if (!target.action.startsWith("sqs:")) return undefined;
    if (target.resource === "*") return { accountId: this.store.accountId };
    const match = target.resource.match(/^arn:[a-z0-9-]+:sqs:([^:]+):(\d{12}):([^:]+)$/i);
    if (!match) return undefined;
    const [, region, accountId, queueName] = match;
    const policy = this.store.state.accounts[accountId]?.regions[region]?.sqsQueues[queueName]?.attributes.Policy;
    if (!policy) return { accountId };
    try { return { document: JSON.parse(policy), accountId }; }
    catch { return { accountId }; }
  }

  private snsResourcePolicy(target: AuthorizationTarget): { document?: import("./types.js").PolicyDocument; accountId: string } | undefined {
    if (!target.action.startsWith("sns:") || target.resource === "*") return undefined;
    const match = target.resource.match(/^arn:[a-z0-9-]+:sns:([^:]+):(\d{12}):([^:]+)(?::[^:]+)?$/i);
    if (!match) return undefined;
    const [, region, accountId, topicName] = match;
    const policy = this.store.state.accounts[accountId]?.regions[region]?.sns?.topics[topicName]?.policy;
    if (!policy) return { accountId };
    try { return { document: JSON.parse(policy), accountId }; }
    catch { return { accountId }; }
  }

  private dynamoResourcePolicy(target: AuthorizationTarget): { document: import("./types.js").PolicyDocument; accountId: string } | undefined {
    if (!target.action.startsWith("dynamodb:") || !target.resource.startsWith("arn:")) return undefined;
    const match = target.resource.match(/^arn:[^:]+:dynamodb:([^:]+):(\d{12}):(table\/[^/]+)(?:\/(index|stream)\/.+)?$/); if (!match) return undefined;
    const [, region, accountId, tableResource, suffix] = match; const regional = this.store.state.accounts[accountId]?.regions[region]; if (!regional) return undefined;
    const attachmentArn = suffix === "stream" ? target.resource : `arn:aws:dynamodb:${region}:${accountId}:${tableResource}`; const policy = regional.dynamodbResourcePolicies?.[attachmentArn]; if (!policy) return undefined;
    try { return { document: JSON.parse(policy.policy), accountId }; } catch { return undefined; }
  }

  private sendAuthorizationError(res: import("node:http").ServerResponse, error: unknown, service: string, currentRequestId: string, req?: import("node:http").IncomingMessage): void {
    const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
    if (service === "s3") { const hostId = createHash("sha256").update(`${this.store.state.installation.id}:${currentRequestId}`).digest("base64"); res.setHeader("x-amz-id-2", hostId); return sendS3Error(res, aws, String(req?.url ?? "/").split("?", 1)[0], currentRequestId, hostId); }
    if (service === "cognito-idp") return sendCognitoError(res, aws);
    if (service === "ses") return String(req?.url ?? "").startsWith("/v2/email/") ? sendSesV2Error(res, aws, currentRequestId) : sendSesV1Error(res, aws, currentRequestId);
    if (service === "sqs") { const jsonProtocol = req?.headers["x-amz-target"]?.toString().startsWith("AmazonSQS.") || String(req?.headers["content-type"] ?? "").includes("amz-json"); if (jsonProtocol) { res.setHeader("x-amzn-query-error", `${aws.code};${aws.status >= 500 ? "Server" : "Sender"}`); return sendAwsError(res, aws, "json", "com.amazonaws.sqs#"); } res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code.replace(/Exception$/, ""), aws.message, currentRequestId)); return; }
    if (service === "ssm") return sendSsmError(res, aws);
    if (service === "secretsmanager") return sendSecretsManagerError(res, aws);
    if (service === "monitoring" && req?.headers["x-amz-target"]?.toString().startsWith("GraniteServiceVersion20100801.")) return sendAwsError(res, aws, "json", "com.amazonaws.cloudwatch#");
    if (service === "cloudformation" || service === "iam" || service === "sts" || service === "monitoring" || service === "rds" || service === "sns") { res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code.replace(/Exception$/, ""), aws.message, currentRequestId)); return; }
    if (service === "dynamodb") return sendAwsError(res, aws);
    if (service === "logs") return sendAwsError(res, aws, "json", "com.amazonaws.cloudwatchlogs#");
    if (service === "events") { res.statusCode = aws.status; res.setHeader("content-type", "application/x-amz-json-1.1"); res.end(JSON.stringify({ __type: `com.amazonaws.eventbridge#${aws.code}`, message: aws.message, ...aws.details })); return; }
    return sendAwsError(res, aws, "rest");
  }

  private async serveConsole(res: import("node:http").ServerResponse, pathname: string): Promise<void> {
    const asset = pathname === "/_stacksim/console" || pathname === "/_stacksim/console/" ? "index.html" : pathname.slice("/_stacksim/console/".length);
    const extension = asset.split(".").at(-1) ?? "";
    const contentTypes: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml", png: "image/png" };
    if (!/^[a-zA-Z0-9_./-]+$/.test(asset) || asset.includes("..") || !contentTypes[extension]) return json(res, { message: "Console asset not found" }, 404);
    try {
      const root = process.cwd();
      const highlightRoot = resolve(root, "node_modules/@highlightjs/cdn-assets");
      const highlightAsset = asset.startsWith("vendor/highlightjs/");
      const file = highlightAsset
        ? resolve(highlightRoot, asset.slice("vendor/highlightjs/".length))
        : resolve(root, "web", asset);
      const relativeHighlightPath = relative(highlightRoot, file);
      if (highlightAsset && (relativeHighlightPath.startsWith("..") || isAbsolute(relativeHighlightPath))) {
        return json(res, { message: "Console asset not found" }, 404);
      }
      const body = await readFile(file);
      res.statusCode = 200; res.setHeader("content-type", contentTypes[extension]); res.setHeader("cache-control", "no-cache"); res.end(body);
    } catch { json(res, { message: "Console assets are missing. Run from the stacksim project directory." }, 500); }
  }

  private async localRdsQueryEditorApi(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
    region: string,
  ): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      const match = url.pathname.match(/^\/_stacksim\/api\/rds\/query-editor\/([^/]+)\/(objects|query)$/);
      if (!match) return json(res, { message: "Unknown local RDS query-editor route." }, 404);
      let identifier: string;
      try {
        identifier = decodeURIComponent(match[1]);
        if (encodeURIComponent(identifier) !== match[1]) throw new Error();
      } catch {
        throw new AwsError("InvalidParameterValue", "The DB instance path segment is invalid.", 400);
      }

      if (match[2] === "objects" && req.method === "GET") {
        const databaseParameters = url.searchParams.getAll("database");
        if (databaseParameters.length > 1 || [...url.searchParams.keys()].some(key => key !== "database")) {
          throw new AwsError("InvalidParameterValue", "Only one database query parameter is allowed.", 400);
        }
        return json(res, await this.rdsManager.queryEditorObjects(region, identifier, databaseParameters[0]));
      }

      if (match[2] === "query" && req.method === "POST") {
        if (url.search) throw new AwsError("InvalidParameterValue", "The query route does not accept URL query parameters.", 400);
        if (req.headers["x-stacksim-console-request"] !== "1") {
          throw new AwsError("InvalidConsoleRequest", "The console mutation header is required.", 403);
        }
        if (typeof req.headers.origin !== "string" || typeof req.headers.host !== "string") {
          throw new AwsError("InvalidConsoleRequest", "A same-origin Origin header is required.", 403);
        }
        let origin: URL;
        let expected: URL;
        try {
          origin = new URL(req.headers.origin);
          expected = new URL(`${(req.socket as any).encrypted ? "https" : "http"}://${req.headers.host}`);
        } catch {
          throw new AwsError("InvalidConsoleRequest", "The Origin or Host header is invalid.", 403);
        }
        const loopback = (hostname: string): boolean =>
          hostname === "localhost"
          || hostname === "::1"
          || hostname === "[::1]"
          || /^127(?:\.\d{1,3}){3}$/.test(hostname);
        if (!loopback(origin.hostname) || !loopback(expected.hostname) || origin.origin !== expected.origin) {
          throw new AwsError("InvalidConsoleRequest", "The request Origin is not the bound loopback console origin.", 403);
        }
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
          throw new AwsError("InvalidConsoleRequest", "Cross-site console mutations are not allowed.", 403);
        }
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw new AwsError("InvalidConsoleRequest", "The request must use application/json.", 415);
        }
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new AwsError("InvalidParameterValue", "The query request body must be a JSON object.", 400);
        }
        const unknownKeys = Object.keys(body).filter(key => key !== "database" && key !== "sql");
        if (unknownKeys.length) throw new AwsError("InvalidParameterValue", `Unknown query request field: ${unknownKeys[0]}`, 400);
        return json(res, await this.rdsManager.queryEditorExecute(region, identifier, (body as any).database, (body as any).sql));
      }

      return json(res, { message: "Unknown local RDS query-editor route." }, 404);
    } catch (error) {
      const aws = error instanceof AwsError
        ? error
        : new AwsError("InternalFailure", "The RDS query-editor request failed.", 500);
      return json(res, { message: aws.message, code: aws.code, __type: aws.code }, aws.status);
    }
  }

  private async localIamApi(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<void> {
    try {
      const path = url.pathname.slice("/_stacksim/api/iam/".length); const iam = this.store.ensureAccount().iam;
      if (path === "policy-validation" && req.method === "POST") {
        const input = await readJson(req); const kind = input.Kind ?? input.kind ?? "identity";
        if (!new Set(["identity", "session", "trust"]).has(kind)) throw new AwsError("InvalidInput", "Policy kind must be identity, session, or trust", 400);
        return json(res, policyValidationReport(input.PolicyDocument ?? input.document, kind));
      }
      if (path === "role-preflight" && req.method === "POST") {
        const input = await readJson(req) as any;
        const servicePrincipal = typeof input.ServicePrincipal === "string" ? input.ServicePrincipal : undefined;
        const passedToService = typeof input.PassedToService === "string" ? input.PassedToService : servicePrincipal;
        const requiredActions = Array.isArray(input.RequiredActions) ? input.RequiredActions.filter((item: any) => item && typeof item.Action === "string") : [];
        const principal = (req as any).awsPrincipal as PrincipalContext;
        const region = String(req.headers["x-stacksim-region"] ?? this.region);
        const context = { "aws:RequestedRegion": region, "aws:CurrentTime": new Date(this.clock.now()).toISOString() };
        const hasConditions = (documents: any[]) => documents.some(document => (Array.isArray(document?.Statement) ? document.Statement : [document?.Statement]).some((statement: any) => statement?.Condition));
        const roles = Object.values(iam.roles).map(role => {
          const trust = servicePrincipal ? evaluateTrust(role.assumeRolePolicyDocument, servicePrincipal, "sts:AssumeRole", context) : { decision: "allowed" as const, reason: "No service-principal constraint", matchedStatements: [] };
          const documents = [...Object.values(role.inlinePolicies), ...role.attachedPolicyArns.map(arn => iam.policies[arn]?.versions[iam.policies[arn]?.defaultVersionId]?.document).filter(Boolean)];
          const permissionResults = requiredActions.map((required: any) => required.Resource
            ? evaluateRoleAuthorization(iam, role.arn, required.Action, String(required.Resource), roleSessionAuthorizationContext(role.arn, region, this.clock.now(), { ...(servicePrincipal ? { "aws:CalledVia": [servicePrincipal] } : {}) }))
            : { decision: "pending" as const, reason: "Choose a target to check this permission", matchedStatements: [] });
          const pass = !passedToService || this.authMode === "off" || (principal?.principalType === "root" && this.rootRecovery)
            ? { decision: "allowed" as const, reason: this.authMode === "off" ? "Authentication is disabled" : "Pass-role is not required or recovery root is active", matchedStatements: [] }
            : evaluateAuthorization(iam, principal, "iam:PassRole", role.arn, { ...context, "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "iam:PassedToService": passedToService });
          const conditionalTrust = trust.decision !== "allowed" && hasConditions([role.assumeRolePolicyDocument]);
          const conditionalPermission = permissionResults.some((result: any) => result.decision === "implicitDeny") && hasConditions(documents);
          const pending = permissionResults.some((result: any) => result.decision === "pending");
          const invalid = (!conditionalTrust && trust.decision !== "allowed") || (!conditionalPermission && permissionResults.some((result: any) => result.decision !== "allowed" && result.decision !== "pending")) || pass.decision !== "allowed";
          const compatibility = invalid ? "invalid" : conditionalTrust || conditionalPermission || pending ? "review" : "valid";
          const compatibilityText = invalid
            ? trust.decision !== "allowed" && !conditionalTrust ? `Does not trust ${servicePrincipal}` : pass.decision !== "allowed" ? "Current identity cannot pass this role" : "Missing required target permission"
            : compatibility === "review" ? conditionalTrust || conditionalPermission ? "Review policy conditions" : `Trusts ${servicePrincipal}; target permission pending`
              : `${servicePrincipal ? `Trusts ${servicePrincipal.replace(".amazonaws.com", "")}` : "Role is available"}${requiredActions.length ? " | required permission allowed" : ""}${passedToService ? " | can be passed" : ""}`;
          return { arn: role.arn, roleName: role.roleName, description: role.description, compatibility, compatibilityText, trust, permissions: permissionResults, passRole: pass };
        });
        return json(res, { roles });
      }
      if (path === "users" && req.method === "GET") return json(res, { users: Object.values(iam.users) });
      if (path === "users" && req.method === "POST") { const input = await readJson(req); return json(res, await this.iam.CreateUser(input), 201); }
      const userMatch = path.match(/^users\/([^/]+)(?:\/(attach|detach|access-keys))?(?:\/([^/]+))?$/);
      if (userMatch) {
        const UserName = decodeURIComponent(userMatch[1]); const action = userMatch[2]; const keyId = userMatch[3] ? decodeURIComponent(userMatch[3]) : undefined;
        if (!action && req.method === "GET") return json(res, { user: iam.users[UserName], groups: Object.values(iam.groups).filter(group => group.userNames.includes(UserName)), accessKeys: Object.values(iam.accessKeys).filter(key => key.userName === UserName) });
        if (!action && req.method === "DELETE") return json(res, await this.iam.DeleteUser({ UserName }));
        if (action === "attach" || action === "detach") { const input = await readJson(req); return json(res, await (action === "attach" ? this.iam.AttachUserPolicy({ UserName, PolicyArn: input.PolicyArn }) : this.iam.DetachUserPolicy({ UserName, PolicyArn: input.PolicyArn }))); }
        if (action === "access-keys" && !keyId && req.method === "POST") { res.setHeader("cache-control", "no-store"); return json(res, await this.iam.CreateAccessKey({ UserName }), 201); }
        if (action === "access-keys" && keyId && req.method === "PATCH") { const input = await readJson(req); return json(res, await this.iam.UpdateAccessKey({ UserName, AccessKeyId: keyId, Status: input.Status })); }
        if (action === "access-keys" && keyId && req.method === "DELETE") return json(res, await this.iam.DeleteAccessKey({ UserName, AccessKeyId: keyId }));
      }
      if (path === "groups" && req.method === "GET") return json(res, { groups: Object.values(iam.groups) });
      if (path === "groups" && req.method === "POST") { const input = await readJson(req); return json(res, await this.iam.CreateGroup(input), 201); }
      const groupMatch = path.match(/^groups\/([^/]+)(?:\/(attach|detach|members))?(?:\/([^/]+))?$/);
      if (groupMatch) {
        const GroupName = decodeURIComponent(groupMatch[1]); const action = groupMatch[2]; const member = groupMatch[3] ? decodeURIComponent(groupMatch[3]) : undefined;
        if (!action && req.method === "GET") return json(res, { group: iam.groups[GroupName], users: iam.groups[GroupName]?.userNames.map(name => iam.users[name]).filter(Boolean) ?? [] });
        if (!action && req.method === "DELETE") return json(res, await this.iam.DeleteGroup({ GroupName }));
        if (action === "attach" || action === "detach") { const input = await readJson(req); return json(res, await (action === "attach" ? this.iam.AttachGroupPolicy({ GroupName, PolicyArn: input.PolicyArn }) : this.iam.DetachGroupPolicy({ GroupName, PolicyArn: input.PolicyArn }))); }
        if (action === "members" && member && req.method === "PUT") return json(res, await this.iam.AddUserToGroup({ GroupName, UserName: member }));
        if (action === "members" && member && req.method === "DELETE") return json(res, await this.iam.RemoveUserFromGroup({ GroupName, UserName: member }));
      }
      if (path === "roles" && req.method === "GET") return json(res, { roles: Object.values(iam.roles) });
      if (path === "roles" && req.method === "POST") { const input = await readJson(req); return json(res, await this.iam.CreateRole(input), 201); }
      const roleMatch = path.match(/^roles\/([^/]+)(?:\/(attach|detach))?$/);
      if (roleMatch) { const RoleName = decodeURIComponent(roleMatch[1]); if (!roleMatch[2] && req.method === "GET") { const role = iam.roles[RoleName]; const relatedFunctions = role ? Object.entries(this.store.ensureAccount().regions).flatMap(([candidateRegion, state]) => Object.values(state.functions).filter(fn => fn.role === role.arn).map(fn => ({ region: candidateRegion, functionName: fn.functionName, functionArn: fn.functionArn, lastLogDeliveryError: fn.lastLogDeliveryError }))) : []; return json(res, { role, relatedFunctions }); } if (!roleMatch[2] && req.method === "DELETE") return json(res, await this.iam.DeleteRole({ RoleName })); const input = await readJson(req); if (roleMatch[2] === "attach") return json(res, await this.iam.AttachRolePolicy({ RoleName, PolicyArn: input.PolicyArn })); if (roleMatch[2] === "detach") return json(res, await this.iam.DetachRolePolicy({ RoleName, PolicyArn: input.PolicyArn })); }
      if (path === "policies" && req.method === "GET") return json(res, { policies: Object.values(iam.policies) });
      if (path === "policies" && req.method === "POST") { const input = await readJson(req); return json(res, await this.iam.CreatePolicy(input), 201); }
      const policyMatch = path.match(/^policies\/(.+)$/); if (policyMatch) { const arn = decodeURIComponent(policyMatch[1]); if (req.method === "GET") return json(res, { policy: iam.policies[arn], entities: Object.values(iam.roles).filter(role => role.attachedPolicyArns.includes(arn)).map(role => role.roleName) }); if (req.method === "DELETE") return json(res, await this.iam.DeletePolicy({ PolicyArn: arn })); }
      if (path === "decisions" && req.method === "GET") return json(res, { decisions: [...iam.authorizationDecisions].reverse() });
      return json(res, { message: "Unknown local IAM console route" }, 404);
    } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); return json(res, { message: aws.message, __type: aws.code }, aws.status); }
  }

  private listen(server: HttpServer | HttpsServer, port: number): Promise<void> {
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, this.host, () => { server.off("error", reject); resolve(); }); });
  }

  private async localCognitoApi(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
    cognito: CognitoService,
  ): Promise<void> {
    const responseHeaders = (): void => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
    };
    try {
      responseHeaders();
      if (url.search) return json(res, { message: "Unknown Cognito console query parameter." }, 400);
      const path = url.pathname.slice("/_stacksim/api/cognito/".length);
      const decode = (value: string): string => {
        try {
          const decoded = decodeURIComponent(value);
          if (encodeURIComponent(decoded) !== value) throw new Error();
          return decoded;
        } catch {
          throw new AwsError("InvalidParameterException", "A Cognito console path segment is invalid.", 400);
        }
      };
      const validateMutation = (): void => {
        if (req.headers["x-stacksim-console-request"] !== "1") {
          throw new AwsError("InvalidConsoleRequest", "The console mutation header is required.", 403);
        }
        if (typeof req.headers.origin !== "string" || typeof req.headers.host !== "string") {
          throw new AwsError("InvalidConsoleRequest", "A same-origin Origin header is required.", 403);
        }
        let origin: URL;
        let expected: URL;
        try {
          origin = new URL(req.headers.origin);
          expected = new URL(`${(req.socket as any).encrypted ? "https" : "http"}://${req.headers.host}`);
        } catch {
          throw new AwsError("InvalidConsoleRequest", "The Origin or Host header is invalid.", 403);
        }
        const loopback = (hostname: string): boolean =>
          hostname === "localhost"
          || hostname === "::1"
          || hostname === "[::1]"
          || /^127(?:\.\d{1,3}){3}$/.test(hostname);
        if (!loopback(origin.hostname) || !loopback(expected.hostname) || origin.origin !== expected.origin) {
          throw new AwsError("InvalidConsoleRequest", "The request Origin is not the bound loopback console origin.", 403);
        }
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
          throw new AwsError("InvalidConsoleRequest", "Cross-site console mutations are not allowed.", 403);
        }
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw new AwsError("InvalidConsoleRequest", "The request must use application/json.", 415);
        }
      };
      if (path === "user-pools") {
        if (req.method === "GET") return json(res, cognito.localUserPools());
        if (req.method === "POST") {
          validateMutation();
          return json(res, await cognito.localCreateUserPool(await readJson(req)), 201);
        }
      }
      const detail = path.match(/^user-pools\/([^/]+)$/);
      if (detail) {
        if (req.method === "GET") return json(res, cognito.localUserPool(decode(detail[1])));
        if (req.method === "PATCH") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new AwsError("InvalidParameterException", "User-pool configuration body is invalid.", 400);
          }
          return json(res, await cognito.localConfigureUserPool(decode(detail[1]), body));
        }
        if (req.method === "DELETE") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body) || (body as any).confirmation !== decode(detail[1]) || Object.keys(body).length !== 1) {
            throw new AwsError("InvalidParameterException", `Enter ${decode(detail[1])} to confirm pool deletion.`, 400);
          }
          return json(res, await cognito.localDeleteUserPool(decode(detail[1])));
        }
      }
      const users = path.match(/^user-pools\/([^/]+)\/users$/);
      if (users) {
        if (req.method === "GET") return json(res, cognito.localUsers(decode(users[1])));
        if (req.method === "POST") {
          validateMutation();
          return json(res, await cognito.localCreateUser(decode(users[1]), await readJson(req)), 201);
        }
      }
      const customAttributes = path.match(/^user-pools\/([^/]+)\/custom-attributes$/);
      if (customAttributes && req.method === "POST") {
        validateMutation();
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new AwsError("InvalidParameterException", "Custom-attribute body is invalid.", 400);
        }
        return json(res, await cognito.localAddCustomAttributes(decode(customAttributes[1]), body), 201);
      }
      const groups = path.match(/^user-pools\/([^/]+)\/groups$/);
      if (groups) {
        if (req.method === "GET") return json(res, cognito.localGroups(decode(groups[1])));
        if (req.method === "POST") {
          validateMutation();
          return json(res, await cognito.localCreateGroup(decode(groups[1]), await readJson(req)), 201);
        }
      }
      const group = path.match(/^user-pools\/([^/]+)\/groups\/([^/]+)$/);
      if (group && req.method === "DELETE") {
        validateMutation();
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || (body as any).confirmation !== decode(group[2]) || Object.keys(body).length !== 1) {
          throw new AwsError("InvalidParameterException", `Enter ${decode(group[2])} to confirm group deletion.`, 400);
        }
        return json(res, await cognito.localDeleteGroup(decode(group[1]), decode(group[2])));
      }
      const user = path.match(/^user-pools\/([^/]+)\/users\/([^/]+)$/);
      if (user) {
        if (req.method === "GET") return json(res, cognito.localUser(decode(user[1]), decode(user[2])));
        if (req.method === "PATCH") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new AwsError("InvalidParameterException", "User update body is invalid.", 400);
          }
          if ((body as any).action === "enable" || (body as any).action === "disable") {
            if (Object.keys(body).length !== 1) {
              throw new AwsError("InvalidParameterException", "User enablement update is invalid.", 400);
            }
            return json(res, await cognito.localSetUserEnabled(
              decode(user[1]),
              decode(user[2]),
              (body as any).action === "enable",
            ));
          }
          if ((body as any).action === "set-password") {
            if (Object.keys(body).some(key => !["action", "password", "permanent"].includes(key))) {
              throw new AwsError("InvalidParameterException", "Password update is invalid.", 400);
            }
            return json(res, await cognito.localSetUserPassword(
              decode(user[1]),
              decode(user[2]),
              (body as any).password,
              (body as any).permanent,
            ));
          }
          if ((body as any).action === "reset-password" && Object.keys(body).length === 1) {
            return json(res, await cognito.localResetUserPassword(decode(user[1]), decode(user[2])));
          }
          if ((body as any).action === "sign-out" && Object.keys(body).length === 1) {
            return json(res, await cognito.localSignOutUser(decode(user[1]), decode(user[2])));
          }
          if ((body as any).action === "attributes" && Object.keys(body).every(key => ["action", "attributes"].includes(key))) {
            return json(res, await cognito.localUpdateUserAttributes(
              decode(user[1]),
              decode(user[2]),
              (body as any).attributes,
            ));
          }
          if ((body as any).action === "delete-attributes" && Object.keys(body).every(key => ["action", "attributeNames"].includes(key))) {
            return json(res, await cognito.localDeleteUserAttributes(
              decode(user[1]),
              decode(user[2]),
              (body as any).attributeNames,
            ));
          }
          if ((body as any).action === "group" && Object.keys(body).every(key => ["action", "group", "member"].includes(key))) {
            return json(res, await cognito.localSetUserGroup(
              decode(user[1]),
              decode(user[2]),
              (body as any).group,
              (body as any).member,
            ));
          }
          if ((body as any).action === "mfa" && Object.keys(body).every(key => ["action", "emailEnabled", "emailPreferred"].includes(key))) {
            return json(res, await cognito.localSetUserMfa(
              decode(user[1]),
              decode(user[2]),
              (body as any).emailEnabled,
              (body as any).emailPreferred,
            ));
          }
          throw new AwsError("InvalidParameterException", "Unknown user update action.", 400);
        }
        if (req.method === "DELETE") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body) || (body as any).confirmation !== decode(user[2]) || Object.keys(body).length !== 1) {
            throw new AwsError("InvalidParameterException", `Enter ${decode(user[2])} to confirm user deletion.`, 400);
          }
          return json(res, await cognito.localDeleteUser(decode(user[1]), decode(user[2])));
        }
      }
      const appClients = path.match(/^user-pools\/([^/]+)\/app-clients$/);
      if (appClients) {
        if (req.method === "GET") return json(res, cognito.localAppClients(decode(appClients[1])));
        if (req.method === "POST") {
          validateMutation();
          return json(res, await cognito.localCreateAppClient(decode(appClients[1]), await readJson(req)), 201);
        }
      }
      const appClient = path.match(/^user-pools\/([^/]+)\/app-clients\/([^/]+)$/);
      if (appClient) {
        if (req.method === "GET") return json(res, cognito.localAppClient(decode(appClient[1]), decode(appClient[2])));
        if (req.method === "PATCH") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new AwsError("InvalidParameterException", "App-client OAuth configuration body is invalid.", 400);
          }
          return json(res, await cognito.localConfigureAppClient(
            decode(appClient[1]),
            decode(appClient[2]),
            body,
          ));
        }
        if (req.method === "DELETE") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body) || (body as any).confirmation !== decode(appClient[2]) || Object.keys(body).length !== 1) {
            throw new AwsError("InvalidParameterException", `Enter ${decode(appClient[2])} to confirm app-client deletion.`, 400);
          }
          return json(res, await cognito.localDeleteAppClient(decode(appClient[1]), decode(appClient[2])));
        }
      }
      const oauth = path.match(/^user-pools\/([^/]+)\/oauth$/);
      if (oauth && req.method === "GET") {
        return json(res, cognito.localOAuthSettings(decode(oauth[1])));
      }
      const oauthProviders = path.match(/^user-pools\/([^/]+)\/oauth\/identity-providers$/);
      if (oauthProviders && req.method === "POST") {
        validateMutation();
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new AwsError("InvalidParameterException", "Identity-provider body is invalid.", 400);
        }
        return json(res, await cognito.CreateIdentityProvider({
          ...(body as Record<string, unknown>),
          UserPoolId: decode(oauthProviders[1]),
        }), 201);
      }
      const oauthProvider = path.match(/^user-pools\/([^/]+)\/oauth\/identity-providers\/([^/]+)$/);
      if (oauthProvider) {
        const poolId = decode(oauthProvider[1]);
        const providerName = decode(oauthProvider[2]);
        if (req.method === "PATCH") {
          validateMutation();
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new AwsError("InvalidParameterException", "Identity-provider update body is invalid.", 400);
          }
          return json(res, await cognito.UpdateIdentityProvider({
            ...(body as Record<string, unknown>),
            UserPoolId: poolId,
            ProviderName: providerName,
          }));
        }
        if (req.method === "DELETE") {
          validateMutation();
          const body = await readJson(req);
          if (
            !body
            || typeof body !== "object"
            || Array.isArray(body)
            || (body as any).confirmation !== providerName
            || Object.keys(body).length !== 1
          ) throw new AwsError("InvalidParameterException", "Enter the provider name to confirm deletion.", 400);
          return json(res, await cognito.DeleteIdentityProvider({
            UserPoolId: poolId,
            ProviderName: providerName,
          }));
        }
      }
      const oauthProviderTest = path.match(/^user-pools\/([^/]+)\/oauth\/identity-providers\/([^/]+)\/test$/);
      if (oauthProviderTest && req.method === "POST") {
        validateMutation();
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
          throw new AwsError("InvalidParameterException", "Connection-test body must be empty.", 400);
        }
        return json(res, await cognito.localTestIdentityProvider(
          decode(oauthProviderTest[1]),
          decode(oauthProviderTest[2]),
        ));
      }
      const oauthDomain = path.match(/^user-pools\/([^/]+)\/oauth\/domain$/);
      if (oauthDomain) {
        const poolId = decode(oauthDomain[1]);
        if (req.method === "POST") {
          validateMutation();
          const body = await readJson(req);
          if (
            !body
            || typeof body !== "object"
            || Array.isArray(body)
            || Object.keys(body).some(key => !["domain", "managedLoginVersion"].includes(key))
          ) throw new AwsError("InvalidParameterException", "Managed-login domain body is invalid.", 400);
          const current = cognito.localOAuthSettings(poolId) as any;
          const operation = current.domain ? "UpdateUserPoolDomain" : "CreateUserPoolDomain";
          return json(res, await (cognito as any)[operation]({
            UserPoolId: poolId,
            Domain: (body as any).domain,
            ManagedLoginVersion: (body as any).managedLoginVersion,
          }), current.domain ? 200 : 201);
        }
        if (req.method === "DELETE") {
          validateMutation();
          const body = await readJson(req);
          const current = cognito.localOAuthSettings(poolId) as any;
          if (
            !current.domain
            || !body
            || typeof body !== "object"
            || Array.isArray(body)
            || (body as any).confirmation !== current.domain.name
            || Object.keys(body).length !== 1
          ) throw new AwsError("InvalidParameterException", "Enter the domain name to confirm deletion.", 400);
          return json(res, await cognito.DeleteUserPoolDomain({
            UserPoolId: poolId,
            Domain: current.domain.name,
          }));
        }
      }
      const oauthResources = path.match(/^user-pools\/([^/]+)\/oauth\/resource-servers$/);
      if (oauthResources && req.method === "POST") {
        validateMutation();
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new AwsError("InvalidParameterException", "Resource-server body is invalid.", 400);
        }
        return json(res, await cognito.CreateResourceServer({
          ...(body as Record<string, unknown>),
          UserPoolId: decode(oauthResources[1]),
        }), 201);
      }
      const oauthResource = path.match(/^user-pools\/([^/]+)\/oauth\/resource-servers\/([^/]+)$/);
      if (oauthResource && req.method === "DELETE") {
        validateMutation();
        const identifier = decode(oauthResource[2]);
        const body = await readJson(req);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || (body as any).confirmation !== identifier
          || Object.keys(body).length !== 1
        ) throw new AwsError("InvalidParameterException", "Enter the resource-server identifier to confirm deletion.", 400);
        return json(res, await cognito.DeleteResourceServer({
          UserPoolId: decode(oauthResource[1]),
          Identifier: identifier,
        }));
      }
      const oauthBranding = path.match(/^user-pools\/([^/]+)\/oauth\/branding$/);
      if (oauthBranding && req.method === "POST") {
        validateMutation();
        const body = await readJson(req);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || Object.keys(body).some(key => !["clientId", "pageTitle", "primaryColor"].includes(key))
        ) throw new AwsError("InvalidParameterException", "Managed-login branding body is invalid.", 400);
        const poolId = decode(oauthBranding[1]);
        const settings = {
          pageTitle: (body as any).pageTitle,
          primaryColor: (body as any).primaryColor,
        };
        const existing = (cognito.localOAuthSettings(poolId) as any).branding
          .find((value: any) => value.clientId === (body as any).clientId);
        return json(res, existing
          ? await cognito.UpdateManagedLoginBranding({
              UserPoolId: poolId,
              ManagedLoginBrandingId: existing.id,
              Settings: settings,
            })
          : await cognito.CreateManagedLoginBranding({
              UserPoolId: poolId,
              ClientId: (body as any).clientId,
              Settings: settings,
            }), existing ? 200 : 201);
      }
      return json(res, { message: "Unknown local Cognito console route." }, 404);
    } catch (error) {
      responseHeaders();
      const aws = error instanceof AwsError
        ? error
        : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      const status = aws.code === "ResourceNotFoundException" ? 404 : aws.status;
      return json(res, { message: aws.message, code: aws.code }, status);
    }
  }

  private async localCognitoJwks(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ): Promise<void> {
    const notFound = (): void => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(JSON.stringify({ message: "Not found" }));
    };
    const match = url.pathname.match(/^\/_stacksim\/cognito-idp\/([^/]+)\/([^/]+)\/\.well-known\/jwks\.json$/);
    if (!match) return notFound();
    let routedRegion: string;
    let poolId: string;
    try {
      routedRegion = decodeURIComponent(match[1]);
      poolId = decodeURIComponent(match[2]);
    } catch {
      return notFound();
    }
    if (
      encodeURIComponent(routedRegion) !== match[1]
      || encodeURIComponent(poolId) !== match[2]
      || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(routedRegion)
      || !new RegExp(`^${routedRegion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[A-Za-z0-9]{9}$`).test(poolId)
    ) {
      return notFound();
    }
    const existingRegion = this.store.state.accounts[this.store.accountId]?.regions[routedRegion];
    if (!existingRegion?.cognito.pools[poolId]) return notFound();
    try {
      const routed = this.services(routedRegion);
      await this.startRegionalServices(routedRegion, routed);
      const jwks = routed.cognito.jwks(poolId);
      if (!jwks) return notFound();
      res.setHeader("etag", jwks.etag);
      res.setHeader("cache-control", "public, max-age=300");
      res.setHeader("x-content-type-options", "nosniff");
      if (req.headers["if-none-match"] === jwks.etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: jwks.keys }));
    } catch {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(JSON.stringify({ message: "Cognito signing keys are unavailable" }));
    }
  }

  private async localDefaultAccessKeyOnboarding(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<void> {
    return this.store.withAccountMutation(this.store.accountId, () => this.localDefaultAccessKeyOnboardingLocked(req, res, url));
  }

  private async localDefaultAccessKeyOnboardingLocked(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<void> {
    res.setHeader("cache-control", "no-store");
    const principal = (req as any).awsPrincipal as PrincipalContext | undefined;
    const initialization = this.store.state.installation.defaultAdministrators[this.store.accountId];
    const marker = initialization?.firstConsoleLogin;
    const iam = this.store.ensureAccount().iam;
    const stableUser = initialization?.originalUserId ? Object.values(iam.users).find(user => user.userId === initialization.originalUserId) : undefined;
    const configuredKey = initialization?.configuredAccessKeyId ? iam.accessKeys[initialization.configuredAccessKeyId] : undefined;
    const sameUser = principal?.principalType === "user" && principal.userId === initialization?.originalUserId;
    const suffix = url.pathname.slice("/_stacksim/api/console-onboarding/default-access-key/".length);
    const publicStatus = () => ({
      status: marker?.status ?? "notApplicable",
      claimId: marker?.claimId ?? null,
      claimGenerationStatus: marker?.staleReason ? "stale" : !configuredKey ? "absent" : configuredKey.status === "Inactive" ? "inactive" : "current",
      configuredKeyStatus: configuredKey?.status ?? "Deleted",
      outcome: marker?.outcome ?? null,
      staleReason: marker?.staleReason ?? null,
      replacementAccessKeyId: marker?.replacementAccessKeyId ?? null,
    });
    try {
      if (!initialization || !marker || !sameUser || !stableUser) throw new AwsError("AccessDeniedException", "This identity is not eligible for default access-key onboarding.", 403);
      if (suffix === "status" && req.method === "GET") return json(res, publicStatus());
      const body = await readJson(req);
      if (suffix === "claim" && req.method === "POST") {
        const retry = marker.status === "presented"
          && marker.claimId === body?.claimId
          && marker.presentedBootId === this.bootId
          && (marker.presentedAt ?? 0) + 5 * 60_000 >= this.clock.now()
          && marker.claimedConfiguredCredentialId === configuredKey?.credentialId
          && marker.claimedConfigurationFingerprint === initialization.configurationFingerprint;
        const eligible = retry || (marker.status === "pending"
          && principal.accessKeyId === configuredKey?.accessKeyId
          && configuredKey.status === "Active"
          && configuredKey.origin === "configured"
          && body?.bootId === this.bootId
          && typeof body?.claimId === "string"
          && /^[0-9a-f-]{16,64}$/i.test(body.claimId));
        if (!eligible) return json(res, { show: false, ...publicStatus() });
        if (!retry) {
          Object.assign(marker, {
            status: "presented",
            claimId: body.claimId,
            presentedBootId: this.bootId,
            claimedConfiguredAccessKeyId: configuredKey!.accessKeyId,
            claimedConfiguredCredentialId: configuredKey!.credentialId,
            claimedConfigurationFingerprint: initialization.configurationFingerprint,
            presentedAt: this.clock.now(),
          });
          await this.store.save();
        }
        return json(res, { show: true, weakBuiltInDefault: this.defaultAccessKeyId === "admin" && this.defaultSecretAccessKey === "password", ...publicStatus() });
      }
      if (suffix === "outcome" && req.method === "POST") {
        if (marker.status !== "presented" || marker.staleReason) throw new AwsError("ConflictException", "The onboarding claim is no longer current.", 409);
        if (body?.outcome === "keptDefault") {
          if (!configuredKey || principal.accessKeyId !== marker.claimedConfiguredAccessKeyId || configuredKey.credentialId !== marker.claimedConfiguredCredentialId || configuredKey.status !== "Active") throw new AwsError("ConflictException", "The claim-time configured key is no longer active.", 409);
          marker.outcome = "keptDefault";
        } else if (body?.outcome === "rotationIncomplete" || body?.outcome === "rotationCompleted") {
          const candidate = typeof body.replacementAccessKeyId === "string" ? iam.accessKeys[body.replacementAccessKeyId] : undefined;
          if (!candidate || candidate.userName !== stableUser.userName || candidate.origin !== "generated") throw new AwsError("ConflictException", "The replacement key is not an active generated key for the initialized user.", 409);
          const signedByClaimedConfiguration = Boolean(configuredKey && principal.accessKeyId === marker.claimedConfiguredAccessKeyId && configuredKey.credentialId === marker.claimedConfiguredCredentialId && configuredKey.status === "Active");
          const signedByCandidate = principal.accessKeyId === candidate.accessKeyId && candidate.status === "Active";
          if (!signedByClaimedConfiguration && !signedByCandidate) throw new AwsError("ConflictException", "The outcome must be signed by the claim-time configured key or the active generated candidate.", 409);
          if (body.outcome === "rotationCompleted" && (principal.accessKeyId !== candidate.accessKeyId || candidate.status !== "Active" || configuredKey?.status === "Active")) throw new AwsError("ConflictException", "Rotation cannot complete until the generated key is active and the configured key is inactive or absent.", 409);
          marker.outcome = body.outcome;
          marker.replacementAccessKeyId = candidate.accessKeyId;
        } else throw new AwsError("ValidationError", "Outcome must be keptDefault, rotationIncomplete, or rotationCompleted.", 400);
        marker.outcomeAt = this.clock.now();
        await this.store.save();
        return json(res, publicStatus());
      }
      return json(res, { message: "Unknown onboarding route" }, 404);
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
      return json(res, { message: aws.message, code: aws.code }, aws.status);
    }
  }

  private async localCognitoDiscovery(
    _req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ): Promise<void> {
    const notFound = (): void => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(JSON.stringify({ message: "Not found" }));
    };
    const match = url.pathname.match(/^\/_stacksim\/cognito-idp\/([^/]+)\/([^/]+)\/\.well-known\/openid-configuration$/);
    if (!match) return notFound();
    let routedRegion: string;
    let poolId: string;
    try {
      routedRegion = decodeURIComponent(match[1]);
      poolId = decodeURIComponent(match[2]);
    } catch {
      return notFound();
    }
    if (
      encodeURIComponent(routedRegion) !== match[1]
      || encodeURIComponent(poolId) !== match[2]
      || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(routedRegion)
      || !new RegExp(`^${routedRegion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[A-Za-z0-9]{9}$`).test(poolId)
    ) return notFound();
    const existingRegion = this.store.state.accounts[this.store.accountId]?.regions[routedRegion];
    if (!existingRegion?.cognito.pools[poolId]) return notFound();
    try {
      const routed = this.services(routedRegion);
      await this.startRegionalServices(routedRegion, routed);
      const document = routed.cognito.discovery(poolId);
      if (!document) return notFound();
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "public, max-age=300");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(JSON.stringify(document));
    } catch {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(JSON.stringify({ message: "Cognito discovery metadata is unavailable" }));
    }
  }

  private async localCognitoOAuth(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ): Promise<void> {
    const match = url.pathname.match(/^\/_stacksim\/cognito-domain\/([^/]+)(?:\/|$)/);
    if (!match) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    let domain: string;
    try {
      domain = decodeURIComponent(match[1]);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (encodeURIComponent(domain) !== match[1]) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const routedRegion = this.store.listRegions().find(candidate => {
      const cognito = this.store.state.accounts[this.store.accountId]?.regions[candidate]?.cognito;
      return Boolean(cognito?.domainIndex[domain]);
    });
    if (!routedRegion) {
      res.statusCode = 404;
      res.setHeader("cache-control", "no-store");
      res.end("Not found");
      return;
    }
    const routed = this.services(routedRegion);
    await this.startRegionalServices(routedRegion, routed);
    return routed.cognito.handleOAuth(req, res, url);
  }

  private listenLoopback(server: HttpsServer, port: number): Promise<void> {
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  }

  async stop(): Promise<void> {
    this.started = false;
    // Mark Lambda invocations interrupted before the callback/control listeners
    // stop accepting connections.  A provider that loses that race remains a
    // replayable CFN callback INTENT instead of becoming a permanent failure.
    for (const services of this.regionalServices.values()) services.lambda.beginShutdown();
    for (const services of this.regionalServices.values()) services.stepfunctions.beginShutdown();
    for (const services of this.regionalServices.values()) services.ses.beginShutdown();
    for (const services of this.regionalServices.values()) services.secretsmanager.stop();
    await Promise.all([...this.regionalServices.values()].map(services => services.cognito.stop()));
    await Promise.all([...this.regionalServices.values()].map(services => services.metrics.stop()));
    await Promise.all([...this.regionalServices.values()].map(services => services.sns.stop()));
    await Promise.all([...this.regionalServices.values()].flatMap(services => [services.sqs.stop(), services.eventbridge.stop(), services.eventscheduler.stop()]));
    this.scheduler.stop();
    const close = (server?: HttpServer | HttpsServer) => server?.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    const drained = Promise.all([close(this.control), close(this.data), close(this.customResourceCallbackServer)]);
    // Terminate Lambda children while listeners drain. A provider can otherwise
    // hold a callback PUT body open, making server.close() wait for the child
    // that was previously stopped only after the drain completed.
    const lambdaStopped = Promise.all([...this.regionalServices.values()].map(services => services.lambda.stop()));
    const webSocketsStopped = Promise.all([...this.regionalServices.values()].map(services => services.apigatewaywebsocket.shutdown()));
    const appSyncSocketsStopped = Promise.all([...this.regionalServices.values()].map(services => services.appsync.shutdownRealtime()));
    await Promise.all([drained, lambdaStopped, webSocketsStopped, appSyncSocketsStopped]);
    await Promise.all([...this.regionalServices.values()].map(services => services.dynamodb.stop()));
    await Promise.all([...this.regionalServices.values()].map(services => services.cloudformation.stop()));
    await Promise.all([...this.regionalServices.values()].map(services => services.stepfunctions.stop()));
    await Promise.all([...this.regionalServices.values()].map(services => services.ses.stop()));
    await this.rdsManager.stop();
    await this.customResourceCallbacks.flush();
    await Promise.all([...this.regionalServices.values()].map(services => services.metrics.flush()));
    await this.store.flush();
  }

  private defaultAdministratorView(): Record<string, any> {
    const initialization = this.store.state.installation.defaultAdministrators[this.store.accountId];
    if (!initialization?.initialized) return {
      seedingEnabled: this.seedDefaultAdmin,
      initializationStatus: "pending",
      userStatus: "notInitialized",
      originalUserName: null, currentUserName: null, userId: null, arn: null,
      policyAttached: false, configuredKeyStatus: "NotInitialized",
      firstConsoleLogin: { status: initialization?.firstConsoleLogin.status ?? "notApplicable", presentedAt: null, outcome: null, staleReason: null, outcomeAt: null, replacementAccessKeyId: null },
    };
    const iam = this.store.ensureAccount().iam;
    const user = Object.values(iam.users).find(candidate => candidate.userId === initialization.originalUserId);
    const key = initialization.configuredAccessKeyId ? iam.accessKeys[initialization.configuredAccessKeyId] : undefined;
    return {
      seedingEnabled: this.seedDefaultAdmin,
      initializationStatus: "complete",
      userStatus: user ? "present" : "deleted",
      originalUserName: initialization.originalUserName ?? null,
      currentUserName: user?.userName ?? initialization.currentUserName ?? null,
      userId: initialization.originalUserId ?? null,
      arn: user?.arn ?? null,
      policyAttached: Boolean(user?.attachedPolicyArns.includes("arn:aws:iam::aws:policy/AdministratorAccess")),
      configuredKeyStatus: !user ? "OwnerDeleted" : key ? key.status : "Deleted",
      firstConsoleLogin: {
        status: initialization.firstConsoleLogin.status,
        presentedAt: initialization.firstConsoleLogin.presentedAt ?? null,
        outcome: initialization.firstConsoleLogin.outcome ?? null,
        staleReason: initialization.firstConsoleLogin.staleReason ?? null,
        outcomeAt: initialization.firstConsoleLogin.outcomeAt ?? null,
        replacementAccessKeyId: initialization.firstConsoleLogin.replacementAccessKeyId ?? null,
      },
    };
  }

  private async localBootstrapView(region: string, services: RegionalServices): Promise<Record<string, unknown> | undefined> {
    const bootstrap = this.store.regionState(region).cloudformation.bootstrap;
    if (!bootstrap) return undefined;
    const bucket = this.store.regionState(region).s3Buckets[bootstrap.bucketName];
    const index = await services.s3.storage.loadBucket(this.store.accountId, region, bootstrap.bucketName);
    const storedVersions = Object.values(index.objects).flatMap(versions => versions).filter(version => !version.deleteMarker);
    const roles = Object.entries(bootstrap.roleArns).map(([key, arn]) => {
      const role = Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === arn);
      return { key, arn, roleName: arn.split("/").at(-1) ?? arn, status: role ? "available" : "missing" };
    });
    const versionParameter = (await services.ssm.GetParameter({ Name: bootstrap.versionParameterName })).Parameter;
    return {
      ...bootstrap,
      status: bucket && roles.every(role => role.status === "available") ? "ready" : "degraded",
      bucketStatus: bucket ? "available" : "missing",
      bucketVersioning: bucket?.versioning,
      versionParameterValue: String(versionParameter.Value),
      roles,
      fileAssets: { count: storedVersions.length, totalBytes: storedVersions.reduce((total, version) => total + version.size, 0) },
      imageAssets: "unsupported-until-ecr",
    };
  }

  private async localCloudFormationApi(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL, cloudformation: CloudFormationService): Promise<void> {
    try {
      const path = url.pathname.slice("/_stacksim/api/cloudformation/".length);
      const principal = (req as any).awsPrincipal as PrincipalContext | undefined
        ?? principalWithoutValidation(req, url, this.store, this.clock);
      if (path === "stacks" && req.method === "GET") return json(res, { stacks: cloudformation.localStacks() });
      const exportMatch = path.match(/^exports(?:\/([^/]+))?$/);
      if (exportMatch && req.method === "GET") {
        const requestedName = exportMatch[1] === undefined ? undefined : decodeURIComponent(exportMatch[1]);
        const exports: any[] = []; let nextToken: string | undefined;
        do {
          const page = await cloudformation.ListExports({ NextToken: nextToken });
          exports.push(...(page.Exports ?? [])); nextToken = page.NextToken;
        } while (nextToken);
        const selected = requestedName === undefined ? exports : exports.filter(value => value.Name === requestedName);
        if (requestedName !== undefined && !selected.length) throw new AwsError("ValidationError", `Export ${requestedName} does not exist`, 400);
        const relationships = await Promise.all(selected.map(async value => {
          const imports: string[] = []; let importToken: string | undefined;
          do {
            const page = await cloudformation.ListImports({ ExportName: value.Name, NextToken: importToken });
            imports.push(...(page.Imports ?? [])); importToken = page.NextToken;
          } while (importToken);
          const exportingStackName = String(value.ExportingStackId ?? "").match(/:stack\/([^/]+)/)?.[1] ?? value.ExportingStackId;
          return { name: value.Name, value: value.Value, exportingStackId: value.ExportingStackId, exportingStackName, imports };
        }));
        return json(res, requestedName === undefined ? { exports: relationships } : { export: relationships[0] });
      }
      const changeSetMatch = path.match(/^stacks\/([^/]+)\/change-sets\/([^/]+)(?:\/(execute))?$/);
      if (changeSetMatch) {
        const stackName = decodeURIComponent(changeSetMatch[1]); const changeSetName = decodeURIComponent(changeSetMatch[2]); const action = changeSetMatch[3];
        if (!action && req.method === "GET") return json(res, { changeSet: await cloudformation.DescribeChangeSet({ StackName: stackName, ChangeSetName: changeSetName, IncludePropertyValues: true }) });
        if (!action && req.method === "DELETE") return json(res, await cloudformation.DeleteChangeSet({ StackName: stackName, ChangeSetName: changeSetName }));
        if (action === "execute" && req.method === "POST") return json(res, await cloudformation.ExecuteChangeSet({ StackName: stackName, ChangeSetName: changeSetName }, principal));
        return json(res, { message: "Unknown local CloudFormation change-set route" }, 404);
      }
      const match = path.match(/^stacks\/([^/]+)(?:\/(events|resources|template|termination-protection|change-sets|rollback|continue-update-rollback))?$/);
      if (!match) return json(res, { message: "Unknown local CloudFormation console route" }, 404);
      const stackName = decodeURIComponent(match[1]); const suffix = match[2];
      if (!suffix && req.method === "GET") return json(res, { stack: cloudformation.localStack(stackName), hierarchy: cloudformation.localHierarchy(stackName) });
      if (!suffix && req.method === "PUT") {
        const input = await readJson(req);
        const parameters = input.parameters && !Array.isArray(input.parameters)
          ? Object.entries(input.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue: String(ParameterValue) }))
          : Array.isArray(input.parameters) ? input.parameters.map((parameter: any) => ({ ParameterKey: parameter.ParameterKey ?? parameter.parameterKey, ...(parameter.UsePreviousValue === true || parameter.usePreviousValue === true ? { UsePreviousValue: true } : { ParameterValue: parameter.ParameterValue ?? parameter.parameterValue }) })) : undefined;
        const result = await cloudformation.UpdateStack({ StackName: stackName, TemplateBody: input.templateBody, Parameters: parameters, Capabilities: input.capabilities, DisableRollback: input.disableRollback === true, RetainExceptOnCreate: input.retainExceptOnCreate === true }, principal);
        return json(res, { stackId: result.StackId, operationId: result.OperationId });
      }
      if (!suffix && req.method === "DELETE") {
        const input = await readJson(req);
        return json(res, await cloudformation.DeleteStack({ StackName: stackName, RetainResources: Array.isArray(input.retainResources) ? input.retainResources : [], DeletionMode: input.deletionMode ?? "STANDARD" }, principal));
      }
      if (suffix === "events" && req.method === "GET") {
        const allEvents = cloudformation.localEvents(stackName);
        const operationId = url.searchParams.get("operationId") ?? undefined;
        const events = operationId === undefined ? allEvents : allEvents.filter(event => event.operationId === operationId);
        const operationIds = [...new Set(allEvents.map(event => event.operationId).filter((value): value is string => Boolean(value)))];
        return json(res, { events, operationId, operationIds });
      }
      if (suffix === "resources" && req.method === "GET") {
        const resources = cloudformation.localResources(stackName);
        const apiIds = new Set(resources.filter(resource => resource.resourceType === "AWS::ApiGateway::RestApi" && resource.resourceStatus !== "DELETE_COMPLETE" && resource.physicalResourceId).map(resource => resource.physicalResourceId!));
        const localApiInvokeLinks = resources.filter(resource => resource.resourceType === "AWS::ApiGateway::Stage" && resource.resourceStatus !== "DELETE_COMPLETE").flatMap(resource => {
          const restApiId = typeof resource.properties.RestApiId === "string" ? resource.properties.RestApiId : undefined;
          const stageName = typeof resource.properties.StageName === "string" ? resource.properties.StageName : undefined;
          if (!restApiId || !stageName || !apiIds.has(restApiId)) return [];
          return [{ logicalResourceId: resource.logicalResourceId, restApiId, stageName, url: `${this.invokeProtocol}://${this.host}:${this.invokePort}/${encodeURIComponent(restApiId)}/${encodeURIComponent(stageName)}` }];
        });
        return json(res, { resources, localApiInvokeLinks });
      }
      if (suffix === "template" && req.method === "GET") {
        const templateStage = url.searchParams.get("templateStage") ?? "Original";
        const result = await cloudformation.GetTemplate({ StackName: stackName, TemplateStage: templateStage });
        return json(res, { templateStage, templateBody: result.TemplateBody });
      }
      if (suffix === "termination-protection" && req.method === "PUT") { const input = await readJson(req); return json(res, await cloudformation.UpdateTerminationProtection({ StackName: stackName, EnableTerminationProtection: input.enabled })); }
      if (suffix === "change-sets" && req.method === "GET") { const result = await cloudformation.ListChangeSets({ StackName: stackName }); return json(res, { changeSets: result.Summaries, nextToken: result.NextToken }); }
      if (suffix === "change-sets" && req.method === "POST") {
        const input = await readJson(req);
        const parameters = input.parameters && !Array.isArray(input.parameters)
          ? Object.entries(input.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue: String(ParameterValue) }))
          : Array.isArray(input.parameters) ? input.parameters.map((parameter: any) => ({ ParameterKey: parameter.ParameterKey ?? parameter.parameterKey, ...(parameter.UsePreviousValue === true || parameter.usePreviousValue === true ? { UsePreviousValue: true } : { ParameterValue: parameter.ParameterValue ?? parameter.parameterValue }) })) : undefined;
        const result = await cloudformation.CreateChangeSet({ StackName: stackName, ChangeSetName: input.changeSetName, ChangeSetType: input.changeSetType, Description: input.description || undefined, TemplateBody: input.templateBody, Parameters: parameters, Capabilities: input.capabilities, OnStackFailure: input.onStackFailure || undefined }, principal);
        return json(res, { changeSetName: input.changeSetName, changeSetId: result.Id, stackId: result.StackId }, 201);
      }
      if (suffix === "rollback" && req.method === "POST") return json(res, await cloudformation.RollbackStack({ StackName: stackName }));
      if (suffix === "continue-update-rollback" && req.method === "POST") { const input = await readJson(req); return json(res, await cloudformation.ContinueUpdateRollback({ StackName: stackName, ResourcesToSkip: Array.isArray(input.resourcesToSkip) ? input.resourcesToSkip : [] })); }
      return json(res, { message: "Unknown local CloudFormation console route" }, 404);
    } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); return json(res, { message: aws.message, __type: aws.code }, aws.status); }
  }
}
