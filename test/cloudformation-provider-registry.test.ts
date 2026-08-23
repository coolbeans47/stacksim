import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import * as productionProviderExports from "../src/cloudformation/providers/index.js";
import {
  CDK_METADATA_TYPE,
  CloudFormationProviderRegistry,
  CloudFormationTestProviderRegistry,
  DuplicateProviderError,
  InvalidProviderDeclarationError,
  ProviderReferenceError,
  UnsupportedResourceProviderError,
  cdkMetadataProvider,
  createDefaultCloudFormationProviderRegistry,
  validateDeclaredProperties,
  type CloudFormationResourceProvider,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderSchema,
  type TestOnlyResourceProvider,
} from "../src/cloudformation/providers/index.js";

const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: "arn:aws:iam::000000000000:root",
  principalId: "000000000000",
  accountId: "000000000000",
};

function context(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    accountId: "000000000000",
    region: "eu-west-1",
    partition: "aws",
    stackId: "arn:aws:cloudformation:eu-west-1:000000000000:stack/example/stack-id",
    logicalId: "Metadata",
    operationId: "operation-1",
    resourceOperationId: "resource-operation-1",
    clientRequestToken: "client-token",
    idempotencyKey: "stable-idempotency-key",
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
    ...overrides,
  };
}

function schema(typeName: string): ProviderSchema {
  return {
    typeName,
    unknownProperties: "REJECT",
    properties: {
      Name: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" },
      Enabled: { valueType: "boolean", updateBehavior: "MUTABLE" },
    },
    ref: { supported: true, valueType: "string" },
    attributes: { Arn: { valueType: "string" } },
    replacement: { defaultOrder: "CREATE_BEFORE_DELETE" },
    retention: {
      deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"],
      updateReplacePolicies: ["Delete", "Retain", "RetainExceptOnCreate"],
      snapshotSupported: false,
    },
    tags: { behavior: "NONE", propagatesCloudFormationTags: false },
  };
}

function provider(typeName: string, visibility: "production"): ProductionResourceProvider<Record<string, unknown>>;
function provider(typeName: string, visibility: "test-only"): TestOnlyResourceProvider<Record<string, unknown>>;
function provider(typeName: string, visibility: "production" | "test-only"): CloudFormationResourceProvider<Record<string, unknown>> {
  const declaration = schema(typeName);
  return {
    typeName,
    providerVersion: 1,
    visibility,
    schema: declaration,
    validate(properties) { return validateDeclaredProperties(properties, declaration); },
    canonicalize(properties) { return { ...(properties as Record<string, unknown>) }; },
    plan(previous, desired) {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired), replacementProperties: [] };
      return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired) {
      return { status: "SUCCESS", physicalId: "physical", model: { physicalId: "physical", properties: desired, attributes: { Arn: "arn:test" } } };
    },
    async read(physicalId) {
      return { status: "SUCCESS", physicalId, model: { physicalId, properties: {}, attributes: { Arn: "arn:test" } } };
    },
    async update(physicalId, _previous, desired) {
      return { status: "SUCCESS", physicalId, model: { physicalId, properties: desired, attributes: { Arn: "arn:test" } } };
    },
    async delete(physicalId) { return { status: "SUCCESS", physicalId }; },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { return model.attributes[attribute]; },
  };
}

test("default production registry exposes only the CDK metadata provider", () => {
  const registry = createDefaultCloudFormationProviderRegistry();
  assert.equal(registry.require(CDK_METADATA_TYPE), cdkMetadataProvider);
  assert.deepEqual(registry.list().map(item => item.typeName), [CDK_METADATA_TYPE]);
  assert.equal(registry.has("Test::Resource"), false);

  assert.throws(
    () => registry.require("AWS::Missing::Resource"),
    (error: unknown) => error instanceof UnsupportedResourceProviderError
      && error.code === "ValidationError"
      && error.typeName === "AWS::Missing::Resource",
  );
});

test("all 102 statically exported production schemas declare the complete retention contract", () => {
  const schemas = Object.values(productionProviderExports).filter((value): value is ProviderSchema => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<ProviderSchema>;
    return typeof candidate.typeName === "string" && candidate.retention !== undefined && candidate.properties !== undefined;
  }).sort((left, right) => left.typeName.localeCompare(right.typeName));
  const expectedTypes = [
    "AWS::ApiGateway::Account", "AWS::ApiGateway::ApiKey", "AWS::ApiGateway::Authorizer", "AWS::ApiGateway::BasePathMapping", "AWS::ApiGateway::BasePathMappingV2",
    "AWS::ApiGateway::ClientCertificate", "AWS::ApiGateway::Deployment", "AWS::ApiGateway::DocumentationPart", "AWS::ApiGateway::DocumentationVersion",
    "AWS::ApiGateway::DomainName", "AWS::ApiGateway::DomainNameAccessAssociation", "AWS::ApiGateway::DomainNameV2", "AWS::ApiGateway::GatewayResponse",
    "AWS::ApiGateway::Method", "AWS::ApiGateway::Model", "AWS::ApiGateway::RequestValidator", "AWS::ApiGateway::Resource", "AWS::ApiGateway::RestApi",
    "AWS::ApiGateway::Stage", "AWS::ApiGateway::UsagePlan", "AWS::ApiGateway::UsagePlanKey", "AWS::ApiGateway::VpcLink",
    "AWS::ApiGatewayV2::Api", "AWS::ApiGatewayV2::ApiMapping", "AWS::ApiGatewayV2::Authorizer", "AWS::ApiGatewayV2::Deployment", "AWS::ApiGatewayV2::DomainName",
    "AWS::ApiGatewayV2::Integration", "AWS::ApiGatewayV2::IntegrationResponse", "AWS::ApiGatewayV2::Model", "AWS::ApiGatewayV2::Route", "AWS::ApiGatewayV2::RouteResponse", "AWS::ApiGatewayV2::Stage",
    "AWS::CDK::Metadata", "AWS::CloudFormation::Stack", "AWS::CloudFront::Distribution", "AWS::CloudFront::Function", "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::ResponseHeadersPolicy", "AWS::CloudWatch::Alarm", "AWS::CloudWatch::AnomalyDetector", "AWS::CloudWatch::CompositeAlarm", "AWS::CloudWatch::Dashboard", "AWS::CloudWatch::InsightRule", "AWS::CloudWatch::MetricStream",
    "AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient", "AWS::Cognito::UserPoolDomain", "AWS::Cognito::UserPoolGroup",
    "AWS::Cognito::UserPoolIdentityProvider", "AWS::Cognito::UserPoolResourceServer", "AWS::Cognito::UserPoolUser", "AWS::Cognito::UserPoolUserToGroupAttachment",
    "AWS::DynamoDB::GlobalTable", "AWS::DynamoDB::Table", "AWS::Events::EventBus", "AWS::Events::Rule", "AWS::IAM::ManagedPolicy", "AWS::IAM::Policy", "AWS::IAM::Role",
    "AWS::Lambda::Alias", "AWS::Lambda::CodeSigningConfig", "AWS::Lambda::EventInvokeConfig", "AWS::Lambda::EventSourceMapping", "AWS::Lambda::Function",
    "AWS::Lambda::LayerVersion", "AWS::Lambda::LayerVersionPermission", "AWS::Lambda::Permission", "AWS::Lambda::Url", "AWS::Lambda::Version",
    "AWS::Logs::Destination", "AWS::Logs::LogGroup", "AWS::Logs::LogStream", "AWS::Logs::MetricFilter", "AWS::Logs::QueryDefinition", "AWS::Logs::ResourcePolicy", "AWS::Logs::SubscriptionFilter",
    "AWS::RDS::DBInstance", "AWS::RDS::DBParameterGroup", "AWS::S3::Bucket", "AWS::S3::BucketPolicy",
    "AWS::SES::ConfigurationSet", "AWS::SES::ConfigurationSetEventDestination", "AWS::SES::ContactList", "AWS::SES::CustomVerificationEmailTemplate", "AWS::SES::EmailIdentity", "AWS::SES::Template",
    "AWS::SNS::Subscription", "AWS::SNS::Topic", "AWS::SNS::TopicInlinePolicy", "AWS::SNS::TopicPolicy",
    "AWS::SQS::Queue", "AWS::SQS::QueuePolicy", "AWS::SecretsManager::ResourcePolicy", "AWS::SecretsManager::RotationSchedule", "AWS::SecretsManager::Secret", "AWS::SecretsManager::SecretTargetAttachment", "AWS::SSM::Parameter", "AWS::StepFunctions::StateMachine", "Custom::AmplifyDynamoDBTable", "Custom::CDKBucketDeployment", "Custom::S3AutoDeleteObjects",
  ].sort((left, right) => left.localeCompare(right));
  assert.deepEqual(schemas.map(item => item.typeName), expectedTypes);
  for (const item of schemas) {
    assert.deepEqual(item.retention.deletionPolicies, item.typeName === "AWS::RDS::DBInstance" ? ["Delete", "Retain", "RetainExceptOnCreate", "Snapshot"] : ["Delete", "Retain", "RetainExceptOnCreate"], `${item.typeName} deletion policy contract drifted`);
    assert.deepEqual(item.retention.updateReplacePolicies, ["Delete", "Retain", "RetainExceptOnCreate"], `${item.typeName} replacement policy contract drifted`);
    assert.equal(item.retention.snapshotSupported, item.typeName === "AWS::RDS::DBInstance", `${item.typeName} snapshot capability drifted`);
  }
});

test("production registration rejects duplicates atomically", () => {
  const alpha = provider("Test::Alpha", "production");
  const beta = provider("Test::Beta", "production");
  const registry = new CloudFormationProviderRegistry([alpha]);

  assert.throws(() => registry.register(alpha), DuplicateProviderError);
  assert.throws(() => registry.registerAll([beta, provider("Test::Beta", "production")]), DuplicateProviderError);
  assert.equal(registry.has("Test::Beta"), false, "a failed batch must not partially register providers");
  assert.deepEqual(registry.list().map(item => item.typeName), ["Test::Alpha"]);
});

test("test-only providers cannot enter or resolve from the public registry", () => {
  const publicRegistry = new CloudFormationProviderRegistry([provider("Test::Public", "production")]);
  const hidden = provider("Test::Hidden", "test-only");

  assert.throws(
    () => (publicRegistry as any).register(hidden),
    (error: unknown) => error instanceof InvalidProviderDeclarationError && /cannot accept a test-only provider/.test(error.message),
  );
  assert.equal(publicRegistry.get("Test::Hidden"), undefined);

  const testRegistry = new CloudFormationTestProviderRegistry(publicRegistry, [hidden]);
  assert.equal(testRegistry.requireForTest("Test::Public").visibility, "production");
  assert.equal(testRegistry.requireForTest("Test::Hidden"), hidden);
  assert.deepEqual(testRegistry.listTestOnly().map(item => item.typeName), ["Test::Hidden"]);
  assert.equal(publicRegistry.get("Test::Hidden"), undefined, "test overlay must not mutate its production registry");

  assert.throws(
    () => testRegistry.registerForTest(provider("Test::Public", "test-only")),
    DuplicateProviderError,
    "test providers cannot shadow a production type",
  );
});

test("registry validates production schema declarations at runtime", () => {
  const invalidVersion = { ...provider("Test::Version", "production"), providerVersion: 0 };
  assert.throws(
    () => new CloudFormationProviderRegistry([invalidVersion as any]),
    (error: unknown) => error instanceof InvalidProviderDeclarationError && /providerVersion/.test(error.message),
  );

  const mismatchedSchema = { ...provider("Test::Mismatch", "production"), schema: schema("Test::Other") };
  assert.throws(
    () => new CloudFormationProviderRegistry([mismatchedSchema as any]),
    (error: unknown) => error instanceof InvalidProviderDeclarationError && /schema.typeName/.test(error.message),
  );

  const base = provider("Test::Snapshot", "production");
  const invalidSnapshot = {
    ...base,
    schema: {
      ...base.schema,
      retention: { ...base.schema.retention, deletionPolicies: ["Delete", "Snapshot"], snapshotSupported: false },
    },
  };
  assert.throws(
    () => new CloudFormationProviderRegistry([invalidSnapshot as any]),
    (error: unknown) => error instanceof InvalidProviderDeclarationError && /snapshotSupported/.test(error.message),
  );
});

test("declared property validation rejects unknown, missing, and wrong-type inputs deterministically", () => {
  const declaration = schema("Test::Validated");
  assert.deepEqual(validateDeclaredProperties({ Name: "example", Enabled: true }, declaration), []);
  assert.deepEqual(validateDeclaredProperties({ Zed: 1, Enabled: "yes" }, declaration), [
    {
      code: "InvalidType",
      path: "Properties.Enabled",
      pathSegments: ["Properties", "Enabled"],
      message: "Test::Validated property Enabled must be boolean",
    },
    {
      code: "UnsupportedProperty",
      path: "Properties.Zed",
      pathSegments: ["Properties", "Zed"],
      message: "Test::Validated does not support property Zed",
    },
    {
      code: "MissingRequiredProperty",
      path: "Properties.Name",
      pathSegments: ["Properties", "Name"],
      message: "Test::Validated requires property Name",
    },
  ]);
  assert.equal(validateDeclaredProperties([], declaration)[0].path, "Properties");
  assert.deepEqual(validateDeclaredProperties([], declaration)[0].pathSegments, ["Properties"]);
});

test("CDK metadata provider validates, canonicalizes, and dry-plans without service mutation", () => {
  const ctx = context();
  assert.deepEqual(cdkMetadataProvider.validate({}, ctx), []);
  assert.deepEqual(cdkMetadataProvider.validate({ Analytics: "v2:deflate64:test" }, ctx), []);
  assert.deepEqual(cdkMetadataProvider.validate({ Analytics: 42, Unknown: true }, ctx).map(issue => issue.code), ["InvalidType", "UnsupportedProperty"]);

  const desired = cdkMetadataProvider.canonicalize({ Analytics: "v2:deflate64:test" }, ctx);
  assert.deepEqual(desired, { Analytics: "v2:deflate64:test" });
  assert.ok(Object.isFrozen(desired));
  assert.deepEqual(cdkMetadataProvider.plan(undefined, desired, ctx), {
    action: "CREATE",
    desired,
    changedProperties: ["Analytics"],
    replacementProperties: [],
  });
  assert.equal(cdkMetadataProvider.plan(desired, desired, ctx).action, "NO_OP");
  assert.deepEqual(cdkMetadataProvider.plan(desired, {}, ctx).changedProperties, ["Analytics"]);
  assert.equal(cdkMetadataProvider.plan(desired, {}, ctx).action, "UPDATE");
  assert.throws(() => cdkMetadataProvider.canonicalize({ Analytics: 42 }, ctx), /must be string/);
});

test("CDK metadata lifecycle is stable and has no fabricated references", async () => {
  const ctx = context();
  const desired = { Analytics: "v2:deflate64:test" };
  const created = await cdkMetadataProvider.create(desired, ctx);
  assert.equal(created.status, "SUCCESS");
  if (created.status !== "SUCCESS") assert.fail("metadata create must complete synchronously");
  assert.equal(created.physicalId, `${ctx.stackId}/${ctx.logicalId}`);
  assert.deepEqual(created.model.properties, desired);
  assert.deepEqual(created.model.attributes, {});

  const retry = await cdkMetadataProvider.create(desired, ctx);
  assert.equal(retry.status, "SUCCESS");
  if (retry.status === "SUCCESS") assert.equal(retry.physicalId, created.physicalId, "retry identity must be deterministic");

  const read = await cdkMetadataProvider.read(created.physicalId, ctx);
  assert.equal(read.status, "SUCCESS");
  assert.equal((await cdkMetadataProvider.read("wrong", ctx)).status, "NOT_FOUND");

  const updated = await cdkMetadataProvider.update(created.physicalId, desired, {}, ctx);
  assert.equal(updated.status, "SUCCESS");
  const failedUpdate = await cdkMetadataProvider.update("wrong", desired, {}, ctx);
  assert.deepEqual(failedUpdate, { status: "FAILED", errorCode: "NotFound", message: "Metadata ownership identity does not match this stack resource" });
  assert.deepEqual(await cdkMetadataProvider.delete(created.physicalId, {}, ctx), { status: "SUCCESS", physicalId: created.physicalId });

  assert.throws(() => cdkMetadataProvider.ref(created.model), ProviderReferenceError);
  assert.throws(() => cdkMetadataProvider.getAtt(created.model, "Arn"), /does not support Fn::GetAtt Arn/);
  assert.equal(cdkMetadataProvider.schema.ref.supported, false);
  assert.deepEqual(cdkMetadataProvider.schema.attributes, {});
  assert.equal(cdkMetadataProvider.schema.retention.snapshotSupported, false);
});
