import type { Clock } from "../core/clock.js";
import { AwsError } from "../errors.js";
import type { IamService } from "../iam.js";
import type { S3Service } from "../s3.js";
import type { StateStore } from "../state.js";
import type { CloudFormationBootstrapState, PolicyDocument } from "../types.js";
import { COGNITO_CLOUDFORMATION_EXECUTION_ACTIONS } from "./providers/cognito.js";
import {
  SES_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  SES_CLOUDFORMATION_RESOURCE_TYPES,
  SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE,
  SES_CONFIGURATION_SET_TYPE,
  SES_CONTACT_LIST_TYPE,
  SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE,
  SES_EMAIL_IDENTITY_TYPE,
  SES_TEMPLATE_TYPE,
} from "./providers/ses.js";
import {
  SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  SNS_CLOUDFORMATION_RESOURCE_TYPES,
} from "./providers/sns.js";

export const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";
// The reduced compatibility value remains 23. Internal revisions add only
// permissions backed by StackSim's bounded providers; they do not advertise
// the cumulative upstream version 30 template.
export const CDK_BOOTSTRAP_COMPATIBILITY_VERSION = 23;
export const CDK_BOOTSTRAP_POLICY_REVISION = 19;
export const CDK_BOOTSTRAP_VERSION_PARAMETER = `/cdk-bootstrap/${CDK_BOOTSTRAP_QUALIFIER}/version`;
export const CDK_BOOTSTRAP_POLICY_NAME = "stacksim-cdk-bootstrap";
export const CDK_BOOTSTRAP_COGNITO_POLICY_NAME = "stacksim-cdk-bootstrap-cognito";

const MANAGED_BY_TAG = "stacksim:managed-by";
const QUALIFIER_TAG = "stacksim:qualifier";
const REVISION_TAG = "stacksim:policy-revision";
const CDK_ROLE_TAG = "aws-cdk:bootstrap-role";
const MANAGED_BY_VALUE = "cdk-bootstrap";

type BootstrapRoleKey = keyof CloudFormationBootstrapState["roleArns"];

interface RoleSpec {
  key: BootstrapRoleKey;
  name: string;
  arn: string;
  description: string;
  cdkRole: string;
  trust: PolicyDocument;
  policy: PolicyDocument;
  managedPolicyArns?: readonly string[];
}

interface RoleInspection {
  spec: RoleSpec;
  disposition: "create" | "reconcile" | "current";
}

interface ManagedPolicyInspection {
  arn: string;
  disposition: "create" | "reconcile" | "current";
  policy: PolicyDocument;
}

function resetError(message: string): AwsError {
  return new AwsError("InvalidBootstrapState", `${message}. Reset the local environment or choose a fresh data directory`, 409);
}

function list<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Canonical policy comparison: object and set-like array ordering are immaterial. */
function canonical(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map(normalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]));
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function decodePolicy(value: unknown, roleName: string, source: string): PolicyDocument {
  if (value && typeof value === "object") return value as PolicyDocument;
  try {
    return JSON.parse(decodeURIComponent(String(value))) as PolicyDocument;
  } catch {
    throw resetError(`CDK bootstrap role ${roleName} has an unreadable ${source}`);
  }
}

function accountTrust(accountId: string): PolicyDocument {
  const principal = { AWS: `arn:aws:iam::${accountId}:root` };
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "SameAccountAssumeRole", Effect: "Allow", Principal: principal, Action: "sts:AssumeRole" },
      { Sid: "SameAccountTagSession", Effect: "Allow", Principal: principal, Action: "sts:TagSession" },
    ],
  };
}

function serviceTrust(service: string): PolicyDocument {
  return { Version: "2012-10-17", Statement: [{ Sid: "ServiceAssumeRole", Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] };
}

function filePublishingPolicy(bucketName: string): PolicyDocument {
  const bucket = `arn:aws:s3:::${bucketName}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BootstrapBucketMetadata",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:HeadBucket", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:ListBucketVersions"],
        Resource: bucket,
      },
      {
        Sid: "BootstrapFileAssets",
        Effect: "Allow",
        Action: ["s3:AbortMultipartUpload", "s3:CompleteMultipartUpload", "s3:CreateMultipartUpload", "s3:DeleteObject", "s3:GetObject", "s3:GetObjectAttributes", "s3:GetObjectVersion", "s3:HeadObject", "s3:ListMultipartUploadParts", "s3:PutObject", "s3:UploadPart"],
        Resource: `${bucket}/*`,
      },
    ],
  };
}

function deploymentPolicy(bucketName: string, executionRoleArn: string, accountId: string, region: string): PolicyDocument {
  const bucket = `arn:aws:s3:::${bucketName}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DirectCloudFormationDeployment",
        Effect: "Allow",
        Action: [
          "cloudformation:CancelUpdateStack", "cloudformation:ContinueUpdateRollback", "cloudformation:CreateStack", "cloudformation:DeleteStack",
          "cloudformation:CreateChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet",
          "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResource", "cloudformation:DescribeStackResources", "cloudformation:DescribeStacks",
          "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary", "cloudformation:ListChangeSets", "cloudformation:ListExports", "cloudformation:ListImports", "cloudformation:ListStackResources", "cloudformation:ListStacks",
          "cloudformation:RollbackStack", "cloudformation:UpdateStack", "cloudformation:UpdateTerminationProtection", "cloudformation:ValidateTemplate",
        ],
        Resource: "*",
      },
      {
        Sid: "DescribeChangeSetValidationEvents",
        Effect: "Allow",
        Action: "cloudformation:DescribeEvents",
        Resource: `arn:aws:cloudformation:${region}:${accountId}:stack/*/*`,
      },
      {
        Sid: "ReadBootstrapAssets",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:HeadBucket", "s3:ListBucket"],
        Resource: bucket,
      },
      {
        Sid: "ReadBootstrapObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:HeadObject"],
        Resource: `${bucket}/*`,
      },
      {
        Sid: "ReadBootstrapVersion",
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        Resource: `arn:aws:ssm:${region}:${accountId}:parameter${CDK_BOOTSTRAP_VERSION_PARAMETER}`,
      },
      { Sid: "PassCloudFormationExecutionRole", Effect: "Allow", Action: "iam:PassRole", Resource: executionRoleArn },
      { Sid: "CallerIdentity", Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
    ],
  };
}

function lookupPolicy(accountId: string, region: string): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CloudFormationLookup",
        Effect: "Allow",
        Action: ["cloudformation:DescribeStackResource", "cloudformation:DescribeStackResources", "cloudformation:DescribeStacks", "cloudformation:GetTemplate", "cloudformation:ListStackResources", "cloudformation:ListStacks"],
        Resource: "*",
      },
      {
        Sid: "BootstrapVersionLookup",
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        Resource: `arn:aws:ssm:${region}:${accountId}:parameter${CDK_BOOTSTRAP_VERSION_PARAMETER}`,
      },
      { Sid: "CallerIdentity", Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
    ],
  };
}

function sesActions(typeName: typeof SES_CLOUDFORMATION_RESOURCE_TYPES[number]): string[] {
  return [...new Set(Object.values(SES_CLOUDFORMATION_AUTHORIZATION_MATRIX[typeName]).flat())].sort();
}

function snsActions(): string[] {
  return [...new Set((SNS_CLOUDFORMATION_RESOURCE_TYPES as readonly string[])
    .flatMap(typeName => Object.values(SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX[typeName as keyof typeof SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX]).flat()))].sort();
}

function cognitoOnlyExecutionPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [{
      Sid: "ManageCognitoUserPools",
      Effect: "Allow",
      Action: [...COGNITO_CLOUDFORMATION_EXECUTION_ACTIONS],
      Resource: "*",
    }],
  };
}

function cognitoExecutionPolicy(accountId: string, region: string): PolicyDocument {
  const base = cognitoOnlyExecutionPolicy();
  return { ...base, Statement: [
    ...(Array.isArray(base.Statement) ? base.Statement : [base.Statement]),
    ...amx04ExecutionPolicy(accountId, region).Statement as any[],
    {
      Sid: "ManageOpeningCloudFrontResources",
      Effect: "Allow",
      Action: [
        "cloudfront:CreateDistribution", "cloudfront:DeleteDistribution", "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:ListDistributions", "cloudfront:UpdateDistribution",
        "cloudfront:CreateFunction", "cloudfront:DeleteFunction", "cloudfront:DescribeFunction", "cloudfront:GetFunction", "cloudfront:ListFunctions", "cloudfront:PublishFunction", "cloudfront:UpdateFunction",
        "cloudfront:CreateOriginAccessControl", "cloudfront:DeleteOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:GetOriginAccessControlConfig", "cloudfront:ListOriginAccessControls", "cloudfront:UpdateOriginAccessControl",
        "cloudfront:CreateResponseHeadersPolicy", "cloudfront:DeleteResponseHeadersPolicy", "cloudfront:GetResponseHeadersPolicy", "cloudfront:GetResponseHeadersPolicyConfig", "cloudfront:ListResponseHeadersPolicies", "cloudfront:UpdateResponseHeadersPolicy",
        "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation", "cloudfront:ListInvalidations", "cloudfront:GetCachePolicy", "cloudfront:GetCachePolicyConfig", "cloudfront:ListCachePolicies",
        "cloudfront:ListTagsForResource", "cloudfront:TagResource", "cloudfront:UntagResource",
      ],
      Resource: "*",
    },
    {
      Sid: "ManageParameterStoreResources",
      Effect: "Allow",
      Action: ["ssm:AddTagsToResource", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource", "ssm:PutParameter", "ssm:RemoveTagsFromResource"],
      Resource: `arn:aws:ssm:${region}:${accountId}:parameter/*`,
    },
    {
      Sid: "ManageSecretsManagerResources",
      Effect: "Allow",
      Action: ["secretsmanager:CancelRotateSecret", "secretsmanager:CreateSecret", "secretsmanager:DeleteResourcePolicy", "secretsmanager:DeleteSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:GetSecretValue", "secretsmanager:PutResourcePolicy", "secretsmanager:PutSecretValue", "secretsmanager:RotateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:UpdateSecret"],
      Resource: `arn:aws:secretsmanager:${region}:${accountId}:secret:*`,
    },
    {
      Sid: "GenerateSecretsManagerPasswords",
      Effect: "Allow",
      Action: "secretsmanager:GetRandomPassword",
      Resource: "*",
    },
  ] };
}

function executionPolicy(bucketName: string, accountId: string, region: string): PolicyDocument {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadFileAssets",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: `arn:aws:s3:::${bucketName}/*`,
      },
      {
        Sid: "ManageApplicationBuckets",
        Effect: "Allow",
        Action: [
          "s3:CreateBucket", "s3:DeleteBucket", "s3:DeleteBucketPolicy", "s3:DeleteBucketTagging", "s3:DeleteBucketWebsite",
          "s3:*LifecycleConfiguration", "s3:GetBucketLocation", "s3:GetBucketOwnershipControls", "s3:GetBucketPolicy", "s3:GetBucketPublicAccessBlock", "s3:GetBucketTagging", "s3:GetBucketVersioning", "s3:GetBucketWebsite", "s3:GetEncryptionConfiguration", "s3:HeadBucket",
          "s3:PutBucketEncryption", "s3:PutBucketOwnershipControls", "s3:PutBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:PutBucketTagging", "s3:PutBucketVersioning", "s3:PutBucketWebsite",
        ],
        Resource: "arn:aws:s3:::*",
      },
      {
        Sid: "ManageIamResources",
        Effect: "Allow",
        Action: [
          "iam:AttachRolePolicy", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:CreateRole",
          "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
          "iam:GetPolicy", "iam:GetPolicyVersion", "iam:GetRole", "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies", "iam:ListEntitiesForPolicy", "iam:ListPolicies", "iam:ListPolicyTags", "iam:ListPolicyVersions", "iam:ListRolePolicies", "iam:ListRoles",
          "iam:PutRolePolicy", "iam:TagPolicy", "iam:TagRole", "iam:UntagPolicy", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole",
        ],
        Resource: "*",
      },
      {
        Sid: "PassSupportedServiceRoles",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${accountId}:role/*`,
        Condition: { StringEquals: { "iam:PassedToService": ["apigateway.amazonaws.com", "appsync.amazonaws.com", "cognito-idp.amazonaws.com", "lambda.amazonaws.com", "logs.amazonaws.com", "states.amazonaws.com", "streams.metrics.cloudwatch.amazonaws.com"] } },
      },
      {
        Sid: "ManageLambdaResources",
        Effect: "Allow",
        Action: [
          "lambda:AddLayerVersionPermission", "lambda:AddPermission", "lambda:CreateAlias", "lambda:CreateCodeSigningConfig", "lambda:CreateEventSourceMapping", "lambda:CreateFunction", "lambda:CreateFunctionUrlConfig",
          "lambda:DeleteAlias", "lambda:DeleteCodeSigningConfig", "lambda:DeleteEventSourceMapping", "lambda:DeleteFunction", "lambda:DeleteFunctionCodeSigningConfig", "lambda:DeleteFunctionConcurrency", "lambda:DeleteFunctionEventInvokeConfig", "lambda:DeleteFunctionUrlConfig", "lambda:DeleteLayerVersion", "lambda:DeleteProvisionedConcurrencyConfig",
          "lambda:GetAlias", "lambda:GetCodeSigningConfig", "lambda:GetEventSourceMapping", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionEventInvokeConfig", "lambda:GetFunctionUrlConfig", "lambda:GetLayerVersion", "lambda:GetLayerVersionPolicy", "lambda:GetPolicy", "lambda:GetProvisionedConcurrencyConfig", "lambda:InvokeFunction",
          "lambda:ListCodeSigningConfigs", "lambda:ListEventSourceMappings", "lambda:ListTags", "lambda:ListVersionsByFunction", "lambda:PublishLayerVersion", "lambda:PublishVersion", "lambda:PutFunctionCodeSigningConfig", "lambda:PutFunctionConcurrency", "lambda:PutFunctionEventInvokeConfig", "lambda:PutProvisionedConcurrencyConfig", "lambda:RemoveLayerVersionPermission", "lambda:RemovePermission",
          "lambda:TagResource", "lambda:UntagResource", "lambda:UpdateAlias", "lambda:UpdateCodeSigningConfig", "lambda:UpdateEventSourceMapping", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:UpdateFunctionUrlConfig",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageLogGroups",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup", "logs:CreateLogStream",
          "logs:DeleteDestination", "logs:DeleteLogGroup", "logs:DeleteLogStream", "logs:DeleteMetricFilter", "logs:DeleteQueryDefinition", "logs:DeleteResourcePolicy", "logs:DeleteRetentionPolicy", "logs:DeleteSubscriptionFilter",
          "logs:DescribeDestinations", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:DescribeMetricFilters", "logs:DescribeQueryDefinitions", "logs:DescribeResourcePolicies", "logs:DescribeSubscriptionFilters",
          "logs:ListTagsForResource", "logs:PutDestination", "logs:PutDestinationPolicy", "logs:PutMetricFilter", "logs:PutQueryDefinition", "logs:PutResourcePolicy", "logs:PutRetentionPolicy", "logs:PutSubscriptionFilter",
          "logs:TagResource", "logs:UntagResource",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageQueues",
        Effect: "Allow",
        Action: [
          "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueues", "sqs:ListQueueTags", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageEventBridgeResources",
        Effect: "Allow",
        Action: [
          "events:CreateEventBus", "events:DeleteEventBus", "events:DeleteRule", "events:DescribeEventBus", "events:DescribeRule", "events:ListTagsForResource", "events:ListTargetsByRule",
          "events:PutRule", "events:PutTargets", "events:RemoveTargets", "events:TagResource", "events:UntagResource",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageCloudWatchResources",
        Effect: "Allow",
        Action: [
          "cloudwatch:DeleteAlarms", "cloudwatch:DeleteAnomalyDetector", "cloudwatch:DeleteDashboards", "cloudwatch:DeleteInsightRules", "cloudwatch:DeleteMetricStream",
          "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAnomalyDetectors", "cloudwatch:DescribeInsightRules", "cloudwatch:GetDashboard", "cloudwatch:GetMetricStream", "cloudwatch:ListTagsForResource",
          "cloudwatch:PutAnomalyDetector", "cloudwatch:PutCompositeAlarm", "cloudwatch:PutDashboard", "cloudwatch:PutInsightRule", "cloudwatch:PutMetricAlarm", "cloudwatch:PutMetricStream", "cloudwatch:TagResource", "cloudwatch:UntagResource",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageRestApis",
        Effect: "Allow",
        Action: ["apigateway:DELETE", "apigateway:GET", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT"],
        Resource: "*",
      },
      {
        Sid: "ManageDynamoDbTables",
        Effect: "Allow",
        Action: [
          "dynamodb:CreateTable", "dynamodb:DeleteResourcePolicy", "dynamodb:DeleteTable", "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeContributorInsights", "dynamodb:DescribeStream", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive",
          "dynamodb:GetResourcePolicy", "dynamodb:ListTagsOfResource", "dynamodb:PutResourcePolicy", "dynamodb:TagResource", "dynamodb:UntagResource",
          "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateContributorInsights", "dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageAppSyncResources",
        Effect: "Allow",
        Action: [
          "appsync:*Function*",
          "appsync:CreateApiKey", "appsync:CreateDataSource", "appsync:CreateGraphqlApi", "appsync:CreateResolver",
          "appsync:DeleteApiKey", "appsync:DeleteDataSource", "appsync:DeleteGraphqlApi", "appsync:DeleteResolver",
          "appsync:GetDataSource", "appsync:GetGraphqlApi", "appsync:GetResolver", "appsync:GetSchemaCreationStatus",
          "appsync:ListApiKeys", "appsync:StartSchemaCreation", "appsync:TagResource", "appsync:UntagResource",
          "appsync:UpdateApiKey", "appsync:UpdateDataSource", "appsync:UpdateGraphqlApi", "appsync:UpdateResolver",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageStepFunctionsStateMachines",
        Effect: "Allow",
        Action: [
          "states:CreateStateMachine", "states:DeleteStateMachine", "states:DescribeStateMachine",
          "states:ListTagsForResource", "states:TagResource", "states:UntagResource", "states:UpdateStateMachine",
        ],
        Resource: `arn:aws:states:${region}:${accountId}:stateMachine:*`,
      },
      {
        Sid: "ManageRdsResources",
        Effect: "Allow",
        Action: [
          "rds:AddTagsToResource", "rds:CreateDBInstance", "rds:CreateDBParameterGroup", "rds:DeleteDBInstance", "rds:DeleteDBParameterGroup",
          "rds:DescribeDBInstances", "rds:DescribeDBParameterGroups", "rds:DescribeDBParameters", "rds:ListTagsForResource", "rds:ModifyDBInstance", "rds:ModifyDBParameterGroup", "rds:RemoveTagsFromResource", "rds:ResetDBParameterGroup",
        ],
        Resource: "*",
      },
      {
        Sid: "ManageSesEmailIdentities",
        Effect: "Allow",
        Action: sesActions(SES_EMAIL_IDENTITY_TYPE),
        Resource: `arn:aws:ses:${region}:${accountId}:identity/*`,
      },
      {
        Sid: "ManageSesConfigurationSets",
        Effect: "Allow",
        Action: sesActions(SES_CONFIGURATION_SET_TYPE),
        Resource: `arn:aws:ses:${region}:${accountId}:configuration-set/*`,
      },
      {
        Sid: "ManageSesTemplates",
        Effect: "Allow",
        Action: sesActions(SES_TEMPLATE_TYPE),
        Resource: `arn:aws:ses:${region}:${accountId}:template/*`,
      },
      {
        Sid: "ManageSesConfigurationSetEventDestinations",
        Effect: "Allow",
        Action: sesActions(SES_CONFIGURATION_SET_EVENT_DESTINATION_TYPE),
        Resource: `arn:aws:ses:${region}:${accountId}:configuration-set/*`,
      },
      {
        Sid: "ManageSesCustomVerificationTemplates",
        Effect: "Allow",
        Action: sesActions(SES_CUSTOM_VERIFICATION_TEMPLATE_TYPE),
        Resource: `arn:aws:ses:${region}:${accountId}:custom-verification-email-template/*`,
      },
      {
        Sid: "ManageSesContactLists",
        Effect: "Allow",
        Action: sesActions(SES_CONTACT_LIST_TYPE),
        Resource: `arn:aws:ses:${region}:${accountId}:contact-list/*`,
      },
      {
        Sid: "ManageSnsResources",
        Effect: "Allow",
        Action: snsActions(),
        Resource: `arn:aws:sns:${region}:${accountId}:*`,
      },
      {
        Sid: "PassSnsDeliveryFeedbackRoles",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${accountId}:role/*`,
        Condition: { StringEquals: { "iam:PassedToService": "sns.amazonaws.com" } },
      },
    ],
  };
  return policy as PolicyDocument;
}

function amx04ExecutionPolicy(accountId: string, region: string): PolicyDocument {
  const parameterPrefix = `arn:aws:ssm:${region}:${accountId}:parameter/amplify/resource_reference/stacksimamplifygen2datafixture/*-sandbox-*/`;
  return { Version: "2012-10-17", Statement: [
    { Sid: "ManageAmplifyBucketCors", Effect: "Allow", Action: ["s3:DeleteBucketCORS", "s3:GetBucketCORS", "s3:PutBucketCORS"], Resource: "arn:aws:s3:::amplify-stacksimamplifygen2datafixture-*" },
    { Sid: "ManageAmplifyResourceReferenceParameters", Effect: "Allow", Action: ["ssm:AddTagsToResource", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:ListTagsForResource", "ssm:PutParameter", "ssm:RemoveTagsFromResource"], Resource: [
      `${parameterPrefix}AMPLIFY_DATA_GRAPHQL_ENDPOINT`,
      `${parameterPrefix}AMPLIFY_DATA_MODEL_INTROSPECTION_SCHEMA_BUCKET_NAME`,
      `${parameterPrefix}AMPLIFY_DATA_MODEL_INTROSPECTION_SCHEMA_KEY`,
      `${parameterPrefix}AMPLIFY_DATA_DEFAULT_NAME`,
    ] },
  ] };
}

function imagePublishingPolicy(): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "ImagePublishingUnavailable", Effect: "Deny", Action: "ecr:*", Resource: "*" }],
  };
}

export function cdkBootstrapNames(accountId: string, region: string): Pick<CloudFormationBootstrapState, "bucketName" | "roleArns"> & { roleNames: Record<BootstrapRoleKey, string> } {
  const bucketName = `cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${accountId}-${region}`;
  const roleNames: Record<BootstrapRoleKey, string> = {
    deploy: `cdk-${CDK_BOOTSTRAP_QUALIFIER}-deploy-role-${accountId}-${region}`,
    filePublishing: `cdk-${CDK_BOOTSTRAP_QUALIFIER}-file-publishing-role-${accountId}-${region}`,
    imagePublishing: `cdk-${CDK_BOOTSTRAP_QUALIFIER}-image-publishing-role-${accountId}-${region}`,
    lookup: `cdk-${CDK_BOOTSTRAP_QUALIFIER}-lookup-role-${accountId}-${region}`,
    cloudFormationExecution: `cdk-${CDK_BOOTSTRAP_QUALIFIER}-cfn-exec-role-${accountId}-${region}`,
  };
  const roleArns = Object.fromEntries(Object.entries(roleNames).map(([key, name]) => [key, `arn:aws:iam::${accountId}:role/${name}`])) as CloudFormationBootstrapState["roleArns"];
  return { bucketName, roleNames, roleArns };
}

/**
 * Reconciles stacksim's deliberately reduced CDK default-synthesizer contract.
 * It never creates a hidden CDKToolkit stack and never adopts resources that
 * do not carry the simulator's ownership marker.
 */
export class CloudFormationBootstrapManager {
  private running?: Promise<CloudFormationBootstrapState>;

  constructor(
    private readonly store: StateStore,
    private readonly iam: IamService,
    private readonly s3: S3Service,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly parameterStore?: {
      validateBootstrapRecord(bootstrap: CloudFormationBootstrapState): void;
      reconcileBootstrapRecord(bootstrap: CloudFormationBootstrapState): boolean;
    },
  ) {}

  ensure(): Promise<CloudFormationBootstrapState> {
    if (this.running) return this.running;
    const operation = this.reconcile();
    this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = undefined; }).catch(() => undefined);
    return operation;
  }

  private specs(): RoleSpec[] {
    const accountId = this.store.accountId;
    const names = cdkBootstrapNames(accountId, this.region);
    return [
      {
        key: "deploy", name: names.roleNames.deploy, arn: names.roleArns.deploy, cdkRole: "deploy",
        description: "stacksim reduced CDK deployment role", trust: accountTrust(accountId),
        policy: deploymentPolicy(names.bucketName, names.roleArns.cloudFormationExecution, accountId, this.region),
      },
      {
        key: "filePublishing", name: names.roleNames.filePublishing, arn: names.roleArns.filePublishing, cdkRole: "file-publishing",
        description: "stacksim reduced CDK file publishing role", trust: accountTrust(accountId), policy: filePublishingPolicy(names.bucketName),
      },
      {
        key: "imagePublishing", name: names.roleNames.imagePublishing, arn: names.roleArns.imagePublishing, cdkRole: "image-publishing",
        description: "stacksim disabled CDK image publishing role", trust: accountTrust(accountId), policy: imagePublishingPolicy(),
      },
      {
        key: "lookup", name: names.roleNames.lookup, arn: names.roleArns.lookup, cdkRole: "lookup",
        description: "stacksim reduced CDK lookup role", trust: accountTrust(accountId), policy: lookupPolicy(accountId, this.region),
      },
      {
        key: "cloudFormationExecution", name: names.roleNames.cloudFormationExecution, arn: names.roleArns.cloudFormationExecution, cdkRole: "cfn-exec",
        description: "stacksim reduced CloudFormation execution role", trust: serviceTrust("cloudformation.amazonaws.com"), policy: executionPolicy(names.bucketName, accountId, this.region),
        managedPolicyArns: [`arn:aws:iam::${accountId}:policy/${CDK_BOOTSTRAP_COGNITO_POLICY_NAME}`],
      },
    ];
  }

  private expectedTags(spec: RoleSpec, revision: number): Array<{ Key: string; Value: string }> {
    return [
      { Key: MANAGED_BY_TAG, Value: MANAGED_BY_VALUE },
      { Key: QUALIFIER_TAG, Value: CDK_BOOTSTRAP_QUALIFIER },
      { Key: REVISION_TAG, Value: String(revision) },
      { Key: CDK_ROLE_TAG, Value: spec.cdkRole },
    ];
  }

  private validateDescriptor(existing: CloudFormationBootstrapState | undefined, expected: Omit<CloudFormationBootstrapState, "updatedAt">): void {
    if (!existing) return;
    if ((existing as any).owner !== "stacksim") throw resetError("The existing CDK bootstrap descriptor is not owned by stacksim");
    if (existing.qualifier !== CDK_BOOTSTRAP_QUALIFIER) throw resetError(`The existing CDK bootstrap qualifier ${existing.qualifier} is incompatible with ${CDK_BOOTSTRAP_QUALIFIER}`);
    if (!Number.isSafeInteger(existing.policyRevision) || existing.policyRevision < 0) throw resetError("The existing CDK bootstrap descriptor has an invalid policy revision");
    if (existing.policyRevision > CDK_BOOTSTRAP_POLICY_REVISION) throw resetError(`The existing CDK bootstrap policy revision ${existing.policyRevision} is newer than this simulator's revision ${CDK_BOOTSTRAP_POLICY_REVISION}`);
    if (existing.policyRevision === CDK_BOOTSTRAP_POLICY_REVISION) {
      const actual = { ...existing } as any; delete actual.updatedAt;
      if (canonical(actual) !== canonical(expected)) throw resetError("The current CDK bootstrap descriptor was locally edited");
    }
  }

  private async inspectRole(spec: RoleSpec): Promise<RoleInspection> {
    let response: any;
    try { response = await this.iam.GetRole({ RoleName: spec.name }); }
    catch (error) {
      if (error instanceof AwsError && error.code === "NoSuchEntity") return { spec, disposition: "create" };
      throw error;
    }
    const role = response.Role ?? {};
    const tags = Object.fromEntries(list<any>(role.Tags).map(tag => [String(tag.Key), String(tag.Value)]));
    if (tags[MANAGED_BY_TAG] !== MANAGED_BY_VALUE || tags[QUALIFIER_TAG] !== CDK_BOOTSTRAP_QUALIFIER) throw resetError(`IAM role ${spec.name} already exists but is not owned by the stacksim CDK bootstrap manager`);
    const revision = Number(tags[REVISION_TAG] ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) throw resetError(`CDK bootstrap role ${spec.name} has an invalid policy revision tag`);
    if (revision > CDK_BOOTSTRAP_POLICY_REVISION) throw resetError(`CDK bootstrap role ${spec.name} has newer policy revision ${revision}`);

    const inlineNames = list<string>((await this.iam.ListRolePolicies({ RoleName: spec.name })).PolicyNames);
    const attached = list<any>((await this.iam.ListAttachedRolePolicies({ RoleName: spec.name })).AttachedPolicies);
    const expectedAttached = [...(spec.managedPolicyArns ?? [])].sort();
    const attachedArns = attached.map(policy => String(policy.PolicyArn)).sort();
    const unexpectedInline = inlineNames.filter(name => name !== CDK_BOOTSTRAP_POLICY_NAME);
    const unexpectedAttached = attachedArns.filter(arn => !expectedAttached.includes(arn));
    if (unexpectedInline.length || unexpectedAttached.length) throw resetError(`CDK bootstrap role ${spec.name} has policies not owned by the bootstrap manager`);
    let policy: PolicyDocument | undefined;
    if (inlineNames.includes(CDK_BOOTSTRAP_POLICY_NAME)) {
      const result = await this.iam.GetRolePolicy({ RoleName: spec.name, PolicyName: CDK_BOOTSTRAP_POLICY_NAME });
      policy = decodePolicy(result.PolicyDocument, spec.name, "inline policy");
    }
    const trust = decodePolicy(role.AssumeRolePolicyDocument, spec.name, "trust policy");
    const current = revision === CDK_BOOTSTRAP_POLICY_REVISION;
    const exact = role.Arn === spec.arn && role.Path === "/" && role.MaxSessionDuration === 3600 && role.Description === spec.description
      && tags[CDK_ROLE_TAG] === spec.cdkRole && canonical(trust) === canonical(spec.trust) && policy !== undefined && canonical(policy) === canonical(spec.policy)
      && canonical(attachedArns) === canonical(expectedAttached);
    if (current && !exact) throw resetError(`CDK bootstrap role ${spec.name} was locally edited at policy revision ${revision}`);
    return { spec, disposition: current ? "current" : "reconcile" };
  }

  private async applyRole(inspection: RoleInspection): Promise<boolean> {
    const { spec, disposition } = inspection;
    if (disposition === "current") return false;
    if (disposition === "create") {
      await this.iam.CreateRole({
        RoleName: spec.name,
        Path: "/",
        Description: spec.description,
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: spec.trust,
        Tags: this.expectedTags(spec, 0),
      });
    } else {
      await this.iam.UpdateRole({ RoleName: spec.name, Description: spec.description, MaxSessionDuration: 3600 });
      await this.iam.UpdateAssumeRolePolicy({ RoleName: spec.name, PolicyDocument: spec.trust });
      await this.iam.TagRole({ RoleName: spec.name, Tags: this.expectedTags(spec, 0) });
    }
    await this.iam.PutRolePolicy({ RoleName: spec.name, PolicyName: CDK_BOOTSTRAP_POLICY_NAME, PolicyDocument: spec.policy });
    for (const policyArn of spec.managedPolicyArns ?? []) {
      await this.iam.AttachRolePolicy({ RoleName: spec.name, PolicyArn: policyArn });
    }
    await this.iam.TagRole({ RoleName: spec.name, Tags: this.expectedTags(spec, CDK_BOOTSTRAP_POLICY_REVISION) });
    return true;
  }

  private inspectCognitoPolicy(): ManagedPolicyInspection {
    const arn = `arn:aws:iam::${this.store.accountId}:policy/${CDK_BOOTSTRAP_COGNITO_POLICY_NAME}`;
    const expected = cognitoExecutionPolicy(this.store.accountId, this.region);
    const existing = this.store.ensureAccount().iam.policies[arn];
    if (!existing) return { arn, disposition: "create", policy: expected };
    if (existing.awsManaged || existing.tags[MANAGED_BY_TAG] !== MANAGED_BY_VALUE || existing.tags[QUALIFIER_TAG] !== CDK_BOOTSTRAP_QUALIFIER) {
      throw resetError(`IAM policy ${CDK_BOOTSTRAP_COGNITO_POLICY_NAME} already exists but is not owned by the stacksim CDK bootstrap manager`);
    }
    const revision = Number(existing.tags[REVISION_TAG] ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) throw resetError(`IAM policy ${CDK_BOOTSTRAP_COGNITO_POLICY_NAME} has an invalid policy revision tag`);
    if (revision > CDK_BOOTSTRAP_POLICY_REVISION) throw resetError(`IAM policy ${CDK_BOOTSTRAP_COGNITO_POLICY_NAME} has newer policy revision ${revision}`);
    const document = existing.versions[existing.defaultVersionId]?.document;
    const exact = document !== undefined && canonical(document) === canonical(expected);
    const previousExact = document !== undefined && canonical(document) === canonical(cognitoOnlyExecutionPolicy());
    if (revision === CDK_BOOTSTRAP_POLICY_REVISION && !exact && !previousExact) throw resetError(`IAM policy ${CDK_BOOTSTRAP_COGNITO_POLICY_NAME} was locally edited at policy revision ${revision}`);
    return { arn, disposition: revision === CDK_BOOTSTRAP_POLICY_REVISION && exact ? "current" : "reconcile", policy: expected };
  }

  private async applyCognitoPolicy(inspection: ManagedPolicyInspection): Promise<boolean> {
    if (inspection.disposition === "current") return false;
    const tags = [
      { Key: MANAGED_BY_TAG, Value: MANAGED_BY_VALUE },
      { Key: QUALIFIER_TAG, Value: CDK_BOOTSTRAP_QUALIFIER },
      { Key: REVISION_TAG, Value: String(CDK_BOOTSTRAP_POLICY_REVISION) },
    ];
    if (inspection.disposition === "create") {
      await this.iam.CreatePolicy({
        PolicyName: CDK_BOOTSTRAP_COGNITO_POLICY_NAME,
        Description: "stacksim reduced CDK Cognito execution permissions",
        PolicyDocument: inspection.policy,
        Tags: tags,
      });
      return true;
    }
    const existing = this.store.ensureAccount().iam.policies[inspection.arn];
    for (const version of Object.values(existing.versions)) {
      if (!version.isDefaultVersion) await this.iam.DeletePolicyVersion({ PolicyArn: inspection.arn, VersionId: version.versionId });
    }
    await this.iam.CreatePolicyVersion({
      PolicyArn: inspection.arn,
      PolicyDocument: inspection.policy,
      SetAsDefault: true,
    });
    for (const version of Object.values(existing.versions)) {
      if (!version.isDefaultVersion) await this.iam.DeletePolicyVersion({ PolicyArn: inspection.arn, VersionId: version.versionId });
    }
    await this.iam.TagPolicy({ PolicyArn: inspection.arn, Tags: tags });
    return true;
  }

  private async reconcile(): Promise<CloudFormationBootstrapState> {
    const names = cdkBootstrapNames(this.store.accountId, this.region);
    const expected: Omit<CloudFormationBootstrapState, "updatedAt"> = {
      owner: "stacksim",
      qualifier: CDK_BOOTSTRAP_QUALIFIER,
      compatibilityVersion: CDK_BOOTSTRAP_COMPATIBILITY_VERSION,
      policyRevision: CDK_BOOTSTRAP_POLICY_REVISION,
      bucketName: names.bucketName,
      roleArns: names.roleArns,
      versionParameterName: CDK_BOOTSTRAP_VERSION_PARAMETER,
    };
    const regionState = this.store.regionState(this.region);
    this.validateDescriptor(regionState.cloudformation.bootstrap, expected);
    this.parameterStore?.validateBootstrapRecord({ ...expected, updatedAt: regionState.cloudformation.bootstrap?.updatedAt ?? this.clock.now() });

    // Complete all read-only policy and role validation before creating or
    // upgrading infrastructure, so same-name unowned/tampered IAM state fails
    // cleanly.
    const cognitoPolicyInspection = this.inspectCognitoPolicy();
    const inspections: RoleInspection[] = [];
    for (const spec of this.specs()) inspections.push(await this.inspectRole(spec));

    const bucketBefore = regionState.s3Buckets[names.bucketName];
    const bucketChanged = !bucketBefore || bucketBefore.managedRevision !== CDK_BOOTSTRAP_POLICY_REVISION || bucketBefore.versioning !== "enabled";
    await this.s3.ensureManagedBucket(names.bucketName, CDK_BOOTSTRAP_POLICY_REVISION);
    const managedPolicyChanged = await this.applyCognitoPolicy(cognitoPolicyInspection);
    let rolesChanged = false;
    for (const inspection of inspections) rolesChanged = await this.applyRole(inspection) || rolesChanged;

    const previous = regionState.cloudformation.bootstrap;
    const descriptorUnchanged = previous && canonical({ ...previous, updatedAt: undefined }) === canonical({ ...expected, updatedAt: undefined });
    const descriptor: CloudFormationBootstrapState = { ...expected, updatedAt: descriptorUnchanged && !bucketChanged && !managedPolicyChanged && !rolesChanged ? previous.updatedAt : this.clock.now() };
    const parameterChanged = this.parameterStore?.reconcileBootstrapRecord(descriptor) ?? false;
    if (!descriptorUnchanged || bucketChanged || managedPolicyChanged || rolesChanged || parameterChanged) {
      regionState.cloudformation.bootstrap = descriptor;
      await this.store.save();
    }
    return structuredClone(descriptor);
  }
}
