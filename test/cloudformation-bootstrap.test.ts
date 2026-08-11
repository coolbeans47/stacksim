import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CDK_BOOTSTRAP_COMPATIBILITY_VERSION,
  CDK_BOOTSTRAP_COGNITO_POLICY_NAME,
  CDK_BOOTSTRAP_POLICY_NAME,
  CDK_BOOTSTRAP_POLICY_REVISION,
  CDK_BOOTSTRAP_QUALIFIER,
  CDK_BOOTSTRAP_VERSION_PARAMETER,
  CloudFormationBootstrapManager,
  cdkBootstrapNames,
} from "../src/cloudformation/bootstrap.js";
import { TestClock } from "../src/core/clock.js";
import { IamService } from "../src/iam.js";
import { S3Service } from "../src/s3.js";
import { StateStore } from "../src/state.js";
import type { PolicyDocument } from "../src/types.js";

const ACCOUNT = "123456789012";
const REGION = "eu-west-1";

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new StateStore(root, ACCOUNT, REGION);
  await store.load();
  const clock = new TestClock(1_720_000_000_000);
  const iam = new IamService(store, clock);
  const s3 = new S3Service(store, REGION, clock);
  const manager = new CloudFormationBootstrapManager(store, iam, s3, REGION, clock);
  return { root, store, clock, iam, s3, manager };
}

function statements(policy: PolicyDocument): any[] {
  return Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
}

function actions(policy: PolicyDocument, sid: string): string[] {
  const action = statements(policy).find(statement => statement.Sid === sid)?.Action;
  return (Array.isArray(action) ? action : action === undefined ? [] : [action]).map(String).sort();
}

test("bootstrap manager creates the reduced CDK contract durably and idempotently", async () => {
  const context = await fixture("stacksim-cfn-bootstrap-");
  try {
    const names = cdkBootstrapNames(ACCOUNT, REGION);
    const first = await context.manager.ensure();
    assert.deepEqual(first, {
      owner: "stacksim",
      qualifier: CDK_BOOTSTRAP_QUALIFIER,
      compatibilityVersion: CDK_BOOTSTRAP_COMPATIBILITY_VERSION,
      policyRevision: CDK_BOOTSTRAP_POLICY_REVISION,
      bucketName: names.bucketName,
      roleArns: names.roleArns,
      versionParameterName: CDK_BOOTSTRAP_VERSION_PARAMETER,
      updatedAt: context.clock.now(),
    });
    assert.deepEqual(context.store.regionState(REGION).cloudformation.stacks, {}, "the reduced bootstrap is not a fabricated CDKToolkit stack");

    const bucket = context.store.regionState(REGION).s3Buckets[names.bucketName];
    assert.equal(bucket.versioning, "enabled");
    assert.equal(bucket.managedBy, "stacksim-cdk-bootstrap");
    assert.equal(bucket.managedRevision, CDK_BOOTSTRAP_POLICY_REVISION);

    const managedRoles = Object.values(context.store.ensureAccount().iam.roles).filter(role => role.tags["stacksim:managed-by"] === "cdk-bootstrap");
    assert.equal(managedRoles.length, 5);
    for (const role of managedRoles) {
      assert.equal(role.tags["stacksim:qualifier"], CDK_BOOTSTRAP_QUALIFIER);
      assert.equal(role.tags["stacksim:policy-revision"], String(CDK_BOOTSTRAP_POLICY_REVISION));
      assert.deepEqual(Object.keys(role.inlinePolicies), [CDK_BOOTSTRAP_POLICY_NAME]);
      assert.deepEqual(role.attachedPolicyArns, role.roleName === names.roleNames.cloudFormationExecution
        ? [`arn:aws:iam::${ACCOUNT}:policy/${CDK_BOOTSTRAP_COGNITO_POLICY_NAME}`]
        : []);
      assert.equal(statements(role.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]).some(statement => statement.Effect === "Allow" && (statement.Action === "*" || statement.Action?.includes?.("*"))), false, "bootstrap roles must not receive wildcard administrator permissions");
    }
    for (const roleName of [names.roleNames.deploy, names.roleNames.filePublishing, names.roleNames.imagePublishing, names.roleNames.lookup]) {
      const role = context.store.ensureAccount().iam.roles[roleName];
      const trustActions = Object.fromEntries(statements(role.assumeRolePolicyDocument).map(statement => [statement.Sid, statement.Action]));
      assert.deepEqual(trustActions, { SameAccountAssumeRole: "sts:AssumeRole", SameAccountTagSession: "sts:TagSession" }, `${roleName} must support the tagged role sessions used by standard CDK tooling`);
    }
    const deployment = context.store.ensureAccount().iam.roles[names.roleNames.deploy];
    assert.equal(CDK_BOOTSTRAP_COMPATIBILITY_VERSION, 23, "the reduced contract includes the pinned CLI's rollback permission gate");
    assert.ok(actions(deployment.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME], "DirectCloudFormationDeployment").includes("cloudformation:RollbackStack"));
    assert.ok(actions(deployment.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME], "DirectCloudFormationDeployment").includes("cloudformation:ContinueUpdateRollback"));
    const passRole = statements(deployment.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]).find(statement => statement.Sid === "PassCloudFormationExecutionRole");
    assert.deepEqual(passRole, { Sid: "PassCloudFormationExecutionRole", Effect: "Allow", Action: "iam:PassRole", Resource: names.roleArns.cloudFormationExecution });
    const file = context.store.ensureAccount().iam.roles[names.roleNames.filePublishing];
    assert.ok(statements(file.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]).every(statement => [
      `arn:aws:s3:::${names.bucketName}`,
      `arn:aws:s3:::${names.bucketName}/*`,
    ].includes(statement.Resource)));
    const image = context.store.ensureAccount().iam.roles[names.roleNames.imagePublishing];
    assert.deepEqual(statements(image.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]), [{ Sid: "ImagePublishingUnavailable", Effect: "Deny", Action: "ecr:*", Resource: "*" }]);

    const execution = context.store.ensureAccount().iam.roles[names.roleNames.cloudFormationExecution];
    assert.deepEqual(statements(execution.assumeRolePolicyDocument).map(statement => statement.Action), ["sts:AssumeRole"], "the CloudFormation service role does not need TagSession trust");
    const executionDocument = execution.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME];
    assert.deepEqual(actions(executionDocument, "ManageIamResources"), [
      "iam:AttachRolePolicy", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:CreateRole", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
      "iam:GetPolicy", "iam:GetPolicyVersion", "iam:GetRole", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListEntitiesForPolicy", "iam:ListPolicies", "iam:ListPolicyTags", "iam:ListPolicyVersions",
      "iam:ListRolePolicies", "iam:ListRoles", "iam:PutRolePolicy", "iam:TagPolicy", "iam:TagRole", "iam:UntagPolicy", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole",
    ].sort());
    assert.deepEqual(statements(executionDocument).find(statement => statement.Sid === "PassSupportedServiceRoles"), {
      Sid: "PassSupportedServiceRoles", Effect: "Allow", Action: "iam:PassRole", Resource: `arn:aws:iam::${ACCOUNT}:role/*`,
      Condition: { StringEquals: { "iam:PassedToService": ["apigateway.amazonaws.com", "appsync.amazonaws.com", "cognito-idp.amazonaws.com", "lambda.amazonaws.com", "logs.amazonaws.com", "states.amazonaws.com", "streams.metrics.cloudwatch.amazonaws.com"] } },
    });
    assert.deepEqual(actions(executionDocument, "ManageAppSyncResources"), [
      "appsync:*Function*",
      "appsync:CreateApiKey", "appsync:CreateDataSource", "appsync:CreateGraphqlApi", "appsync:CreateResolver",
      "appsync:DeleteApiKey", "appsync:DeleteDataSource", "appsync:DeleteGraphqlApi", "appsync:DeleteResolver",
      "appsync:GetDataSource", "appsync:GetGraphqlApi", "appsync:GetResolver", "appsync:GetSchemaCreationStatus",
      "appsync:ListApiKeys", "appsync:StartSchemaCreation", "appsync:TagResource", "appsync:UntagResource",
      "appsync:UpdateApiKey", "appsync:UpdateDataSource", "appsync:UpdateGraphqlApi", "appsync:UpdateResolver",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageLambdaResources"), [
      "lambda:AddLayerVersionPermission", "lambda:AddPermission", "lambda:CreateAlias", "lambda:CreateCodeSigningConfig", "lambda:CreateEventSourceMapping", "lambda:CreateFunction", "lambda:CreateFunctionUrlConfig",
      "lambda:DeleteAlias", "lambda:DeleteCodeSigningConfig", "lambda:DeleteEventSourceMapping", "lambda:DeleteFunction", "lambda:DeleteFunctionCodeSigningConfig", "lambda:DeleteFunctionConcurrency", "lambda:DeleteFunctionEventInvokeConfig", "lambda:DeleteFunctionUrlConfig", "lambda:DeleteLayerVersion", "lambda:DeleteProvisionedConcurrencyConfig",
      "lambda:GetAlias", "lambda:GetCodeSigningConfig", "lambda:GetEventSourceMapping", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionEventInvokeConfig", "lambda:GetFunctionUrlConfig", "lambda:GetLayerVersion", "lambda:GetLayerVersionPolicy", "lambda:GetPolicy", "lambda:GetProvisionedConcurrencyConfig", "lambda:InvokeFunction",
      "lambda:ListCodeSigningConfigs", "lambda:ListEventSourceMappings", "lambda:ListTags", "lambda:ListVersionsByFunction", "lambda:PublishLayerVersion", "lambda:PublishVersion", "lambda:PutFunctionCodeSigningConfig", "lambda:PutFunctionConcurrency", "lambda:PutFunctionEventInvokeConfig", "lambda:PutProvisionedConcurrencyConfig", "lambda:RemoveLayerVersionPermission", "lambda:RemovePermission",
      "lambda:TagResource", "lambda:UntagResource", "lambda:UpdateAlias", "lambda:UpdateCodeSigningConfig", "lambda:UpdateEventSourceMapping", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:UpdateFunctionUrlConfig",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageApplicationBuckets"), [
      "s3:CreateBucket", "s3:DeleteBucket", "s3:DeleteBucketPolicy", "s3:DeleteBucketTagging", "s3:DeleteBucketWebsite", "s3:DeletePublicAccessBlock",
      "s3:GetBucketLocation", "s3:GetBucketPolicy", "s3:GetBucketTagging", "s3:GetBucketVersioning", "s3:GetBucketWebsite", "s3:GetEncryptionConfiguration", "s3:GetPublicAccessBlock", "s3:HeadBucket",
      "s3:PutBucketEncryption", "s3:PutBucketPolicy", "s3:PutBucketTagging", "s3:PutBucketVersioning", "s3:PutBucketWebsite", "s3:PutPublicAccessBlock",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageLogGroups"), [
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:DeleteDestination", "logs:DeleteLogGroup", "logs:DeleteLogStream", "logs:DeleteMetricFilter", "logs:DeleteQueryDefinition", "logs:DeleteResourcePolicy", "logs:DeleteRetentionPolicy", "logs:DeleteSubscriptionFilter",
      "logs:DescribeDestinations", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:DescribeMetricFilters", "logs:DescribeQueryDefinitions", "logs:DescribeResourcePolicies", "logs:DescribeSubscriptionFilters", "logs:ListTagsForResource",
      "logs:PutDestination", "logs:PutDestinationPolicy", "logs:PutMetricFilter", "logs:PutQueryDefinition", "logs:PutResourcePolicy", "logs:PutRetentionPolicy", "logs:PutSubscriptionFilter", "logs:TagResource", "logs:UntagResource",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageQueues"), ["sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueues", "sqs:ListQueueTags", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue"].sort());
    assert.deepEqual(actions(executionDocument, "ManageEventBridgeResources"), [
      "events:CreateEventBus", "events:DeleteEventBus", "events:DeleteRule", "events:DescribeEventBus", "events:DescribeRule", "events:ListTagsForResource", "events:ListTargetsByRule", "events:PutRule", "events:PutTargets", "events:RemoveTargets", "events:TagResource", "events:UntagResource",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageCloudWatchResources"), [
      "cloudwatch:DeleteAlarms", "cloudwatch:DeleteAnomalyDetector", "cloudwatch:DeleteDashboards", "cloudwatch:DeleteInsightRules", "cloudwatch:DeleteMetricStream", "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAnomalyDetectors", "cloudwatch:DescribeInsightRules", "cloudwatch:GetDashboard", "cloudwatch:GetMetricStream", "cloudwatch:ListTagsForResource",
      "cloudwatch:PutAnomalyDetector", "cloudwatch:PutCompositeAlarm", "cloudwatch:PutDashboard", "cloudwatch:PutInsightRule", "cloudwatch:PutMetricAlarm", "cloudwatch:PutMetricStream", "cloudwatch:TagResource", "cloudwatch:UntagResource",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageRestApis"), ["apigateway:DELETE", "apigateway:GET", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT"].sort());
    assert.deepEqual(actions(executionDocument, "ManageDynamoDbTables"), [
      "dynamodb:CreateTable", "dynamodb:DeleteResourcePolicy", "dynamodb:DeleteTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeContributorInsights", "dynamodb:DescribeStream", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive",
      "dynamodb:GetResourcePolicy", "dynamodb:ListTagsOfResource", "dynamodb:PutResourcePolicy", "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateContributorInsights", "dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive",
    ].sort());
    assert.deepEqual(actions(executionDocument, "ManageRdsResources"), [
      "rds:AddTagsToResource", "rds:CreateDBInstance", "rds:CreateDBParameterGroup", "rds:DeleteDBInstance", "rds:DeleteDBParameterGroup", "rds:DescribeDBInstances", "rds:DescribeDBParameterGroups", "rds:DescribeDBParameters", "rds:ListTagsForResource", "rds:ModifyDBInstance", "rds:ModifyDBParameterGroup", "rds:RemoveTagsFromResource", "rds:ResetDBParameterGroup",
    ].sort());

    const apiGatewayLogsArn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs";
    const apiGatewayLogs = context.store.ensureAccount().iam.policies[apiGatewayLogsArn];
    assert.equal(apiGatewayLogs.awsManaged, true);
    assert.equal(apiGatewayLogs.path, "/service-role/");
    assert.deepEqual((statements(apiGatewayLogs.versions.v1.document)[0].Action as string[]).sort(), [
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents", "logs:PutLogEvents",
    ].sort());

    const roleIds = Object.fromEntries(managedRoles.map(role => [role.roleName, role.roleId]));
    context.clock.advance(60_000);
    const second = await context.manager.ensure();
    assert.deepEqual(second, first);
    assert.deepEqual(Object.fromEntries(Object.values(context.store.ensureAccount().iam.roles).filter(role => role.tags["stacksim:managed-by"] === "cdk-bootstrap").map(role => [role.roleName, role.roleId])), roleIds);

    const reloaded = new StateStore(context.root, ACCOUNT, REGION);
    await reloaded.load();
    const restarted = new CloudFormationBootstrapManager(reloaded, new IamService(reloaded, context.clock), new S3Service(reloaded, REGION, context.clock), REGION, context.clock);
    assert.deepEqual(await restarted.ensure(), first);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("bootstrap manager repairs interrupted and older simulator-owned resources", async () => {
  const context = await fixture("stacksim-cfn-bootstrap-upgrade-");
  try {
    const names = cdkBootstrapNames(ACCOUNT, REGION);
    await context.manager.ensure();
    const deploy = context.store.ensureAccount().iam.roles[names.roleNames.deploy];
    deploy.tags["stacksim:policy-revision"] = "0";
    deploy.tags["aws-cdk:bootstrap-role"] = "stale";
    deploy.description = "stale";
    deploy.maxSessionDuration = 7200;
    deploy.assumeRolePolicyDocument = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: "sts:AssumeRole" }] };
    deploy.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "cloudformation:DescribeStacks", Resource: "*" }] };
    const removedRoleId = context.store.ensureAccount().iam.roles[names.roleNames.filePublishing].roleId;
    delete context.store.ensureAccount().iam.roles[names.roleNames.filePublishing];
    const bucket = context.store.regionState(REGION).s3Buckets[names.bucketName];
    bucket.managedRevision = 0;
    bucket.versioning = "suspended";
    context.store.regionState(REGION).cloudformation.bootstrap!.policyRevision = 0;
    context.store.regionState(REGION).cloudformation.bootstrap!.compatibilityVersion = 8;
    await context.store.save();

    context.clock.advance(1_000);
    const repaired = await new CloudFormationBootstrapManager(context.store, context.iam, context.s3, REGION, context.clock).ensure();
    assert.equal(repaired.policyRevision, CDK_BOOTSTRAP_POLICY_REVISION);
    assert.equal(repaired.compatibilityVersion, 23, "an older reduced environment must upgrade for standard cdk rollback");
    assert.equal(repaired.updatedAt, context.clock.now());
    assert.equal(bucket.managedRevision, CDK_BOOTSTRAP_POLICY_REVISION);
    assert.equal(bucket.versioning, "enabled");
    assert.equal(deploy.tags["stacksim:policy-revision"], String(CDK_BOOTSTRAP_POLICY_REVISION));
    assert.equal(deploy.tags["aws-cdk:bootstrap-role"], "deploy");
    assert.equal(deploy.maxSessionDuration, 3600);
    assert.notEqual(context.store.ensureAccount().iam.roles[names.roleNames.filePublishing].roleId, removedRoleId);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("bootstrap manager refuses an unowned deterministic role before creating infrastructure", async () => {
  const context = await fixture("stacksim-cfn-bootstrap-unowned-");
  try {
    const names = cdkBootstrapNames(ACCOUNT, REGION);
    await context.iam.CreateRole({
      RoleName: names.roleNames.deploy,
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: "sts:AssumeRole" }] },
    });
    await assert.rejects(context.manager.ensure(), (error: any) => error.code === "InvalidBootstrapState" && /not owned/i.test(error.message) && /reset the local environment/i.test(error.message));
    assert.equal(context.store.regionState(REGION).s3Buckets[names.bucketName], undefined);
    assert.equal(context.store.regionState(REGION).cloudformation.bootstrap, undefined);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("bootstrap manager refuses same-revision trust and policy edits", async () => {
  const context = await fixture("stacksim-cfn-bootstrap-edited-");
  try {
    const names = cdkBootstrapNames(ACCOUNT, REGION);
    await context.manager.ensure();
    const role = context.store.ensureAccount().iam.roles[names.roleNames.deploy];
    const expectedPolicy = structuredClone(role.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]);
    role.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] };
    await assert.rejects(new CloudFormationBootstrapManager(context.store, context.iam, context.s3, REGION, context.clock).ensure(), (error: any) => error.code === "InvalidBootstrapState" && /locally edited/i.test(error.message) && /reset/i.test(error.message));
    assert.equal((role.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME].Statement as any[])[0].Action, "*", "the manager must not silently overwrite a current-revision policy edit");

    role.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = expectedPolicy;
    role.assumeRolePolicyDocument = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" }] };
    await assert.rejects(new CloudFormationBootstrapManager(context.store, context.iam, context.s3, REGION, context.clock).ensure(), (error: any) => error.code === "InvalidBootstrapState" && /locally edited/i.test(error.message) && /reset/i.test(error.message));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
