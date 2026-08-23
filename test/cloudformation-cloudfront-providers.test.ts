import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFrontService } from "../src/cloudfront.js";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID } from "../src/cloudfront/model.js";
import {
  CLOUDFRONT_CLOUDFORMATION_RESOURCE_TYPES,
  createCloudFrontCloudFormationProviders,
  type CloudFrontDistributionModel,
  type CloudFrontFunctionModel,
  type CloudFrontOriginAccessControlModel,
  type CloudFrontResponseHeadersPolicyModel,
} from "../src/cloudformation/providers/cloudfront.js";
import type { ProductionResourceProvider, ProviderContext } from "../src/cloudformation/providers/contract.js";
import { TestClock } from "../src/core/clock.js";
import { StateStore } from "../src/state.js";

const accountId = "000000000000";
const region = "eu-west-1";
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(logicalId: string, resourceOperationId = `create-${logicalId}`, stack = "cloudfront-provider-test"): ProviderContext {
  return {
    accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/${stack}/stack-id`, logicalId,
    operationId: `operation-${resourceOperationId}`, resourceOperationId, idempotencyKey: `idempotency-${resourceOperationId}`,
    deadlineAt: Date.now() + 60_000, principal: { identity },
  };
}

const policyProperties = {
  ResponseHeadersPolicyConfig: {
    Name: "fixture-security",
    SecurityHeadersConfig: {
      ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: "DENY", Override: true },
      ReferrerPolicy: { Override: true, ReferrerPolicy: "strict-origin-when-cross-origin" },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true, Preload: true },
    },
  },
};

const functionProperties = {
  AutoPublish: true,
  FunctionCode: "function handler(event) { return event.request; }",
  FunctionConfig: { Comment: "SPA rewrite", Runtime: "cloudfront-js-1.0" },
  Name: "fixture-rewrite",
  Tags: [{ Key: "Application", Value: "Fixture" }],
};

const oacProperties = {
  OriginAccessControlConfig: { Name: "fixture-oac", OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" },
};

function distributionProperties(functionArn: string, policyId: string, oacId: string) {
  const originId = "FixtureOrigin";
  return {
    DistributionConfig: {
      CacheBehaviors: [
        { AllowedMethods: ["GET", "HEAD", "OPTIONS"], CachePolicyId: CACHING_OPTIMIZED_ID, Compress: true, PathPattern: "assets/*", ResponseHeadersPolicyId: policyId, TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https" },
        { CachePolicyId: CACHING_DISABLED_ID, Compress: true, PathPattern: "runtime-config.json", ResponseHeadersPolicyId: policyId, TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https" },
      ],
      DefaultCacheBehavior: { AllowedMethods: ["GET", "HEAD", "OPTIONS"], CachePolicyId: CACHING_DISABLED_ID, Compress: true, FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: functionArn }], ResponseHeadersPolicyId: policyId, TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https" },
      DefaultRootObject: "index.html", Enabled: true, HttpVersion: "http2and3", IPV6Enabled: true,
      Origins: [{ DomainName: `fixture-bucket.s3.${region}.amazonaws.com`, Id: originId, OriginAccessControlId: oacId, S3OriginConfig: { OriginAccessIdentity: "" } }],
    },
    Tags: [{ Key: "Application", Value: "Fixture" }],
  };
}

test("CFR-01 CloudFront providers enforce closed shapes and use authoritative lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-cloudfront-"));
  const store = new StateStore(root, accountId, region); await store.load();
  store.state.installation.s3BucketNames["fixture-bucket"] = { accountId, region };
  const clock = new TestClock(Date.parse("2026-08-22T12:00:00.000Z"));
  const service = new CloudFrontService(store, clock, () => { throw new Error("origin is not used by provider lifecycle tests"); });
  try {
    const providers = createCloudFrontCloudFormationProviders(service);
    assert.deepEqual(providers.map(provider => provider.typeName).sort(), [...CLOUDFRONT_CLOUDFORMATION_RESOURCE_TYPES].sort());
    const byType = new Map(providers.map(provider => [provider.typeName, provider]));
    const policy = byType.get("AWS::CloudFront::ResponseHeadersPolicy") as ProductionResourceProvider<CloudFrontResponseHeadersPolicyModel>;
    const fn = byType.get("AWS::CloudFront::Function") as ProductionResourceProvider<CloudFrontFunctionModel>;
    const oac = byType.get("AWS::CloudFront::OriginAccessControl") as ProductionResourceProvider<CloudFrontOriginAccessControlModel>;
    const distribution = byType.get("AWS::CloudFront::Distribution") as ProductionResourceProvider<CloudFrontDistributionModel>;

    assert.equal(fn.validate({ ...functionProperties, FunctionMetadata: {} }, context("Function"))[0].path, "Properties.FunctionMetadata");
    assert.equal(fn.validate({ ...functionProperties, FunctionConfig: { ...functionProperties.FunctionConfig, Runtime: "cloudfront-js-2.0" } }, context("Function"))[0].path, "Properties.FunctionConfig.Runtime");
    assert.ok(oac.validate({ OriginAccessControlConfig: { ...oacProperties.OriginAccessControlConfig, SigningBehavior: "never", Future: true } }, context("Oac")).some(item => item.path === "Properties.OriginAccessControlConfig.Future"));
    assert.ok(policy.validate({ ResponseHeadersPolicyConfig: { ...policyProperties.ResponseHeadersPolicyConfig, SecurityHeadersConfig: { ...policyProperties.ResponseHeadersPolicyConfig.SecurityHeadersConfig, FrameOptions: { FrameOption: "SAMEORIGIN", Override: true } } } }, context("Policy")).some(item => item.path.endsWith("FrameOptions.FrameOption")));

    const policyContext = context("Policy"); const policyModel = policy.canonicalize(policyProperties, policyContext);
    const createdPolicy = await policy.create(policyModel, policyContext); assert.equal(createdPolicy.status, "SUCCESS"); if (createdPolicy.status !== "SUCCESS") return;
    const policyId = String(policy.ref(createdPolicy.model)); assert.equal(policy.getAtt(createdPolicy.model, "Id"), policyId); assert.equal(policy.getAtt(createdPolicy.model, "LastModifiedTime"), "2026-08-22T12:00:00.000Z");

    const functionContext = context("Function"); const functionModel = fn.canonicalize(functionProperties, functionContext);
    const createdFunction = await fn.create(functionModel, functionContext); assert.equal(createdFunction.status, "SUCCESS"); if (createdFunction.status !== "SUCCESS") return;
    const functionArn = String(fn.ref(createdFunction.model)); assert.equal(fn.getAtt(createdFunction.model, "FunctionARN"), functionArn); assert.equal(fn.getAtt(createdFunction.model, "FunctionMetadata.FunctionARN"), functionArn); assert.equal(fn.getAtt(createdFunction.model, "Stage"), "LIVE");

    const oacContext = context("Oac"); const oacModel = oac.canonicalize(oacProperties, oacContext);
    const createdOac = await oac.create(oacModel, oacContext); assert.equal(createdOac.status, "SUCCESS"); if (createdOac.status !== "SUCCESS") return;
    const oacId = String(oac.ref(createdOac.model)); assert.equal(oac.getAtt(createdOac.model, "Id"), oacId);

    const distributionContext = context("Distribution"); const distributionModel = distribution.canonicalize(distributionProperties(functionArn, policyId, oacId), distributionContext);
    assert.ok(distribution.validate({ ...distributionProperties(functionArn, policyId, oacId), DistributionConfig: { ...distributionProperties(functionArn, policyId, oacId).DistributionConfig, Aliases: [] } }, distributionContext).some(item => item.path === "Properties.DistributionConfig.Aliases"));
    const createdDistribution = await distribution.create(distributionModel, distributionContext); assert.equal(createdDistribution.status, "SUCCESS"); if (createdDistribution.status !== "SUCCESS") return;
    const distributionId = String(distribution.ref(createdDistribution.model)); assert.equal(distribution.getAtt(createdDistribution.model, "Id"), distributionId); assert.match(String(distribution.getAtt(createdDistribution.model, "DomainName")), /^d[0-9a-f]+\.cloudfront\.net$/);
    assert.deepEqual(createdDistribution.model.properties, distributionModel);

    // Read/update/delete use the durable stack/logical owner, while lost-create
    // replay additionally requires the original resource operation ID.
    assert.equal((await distribution.read(distributionId, context("Distribution", "read-operation"))).status, "SUCCESS");
    const recoveredPolicy = await policy.create(policyModel, policyContext); assert.equal(recoveredPolicy.status, "SUCCESS"); if (recoveredPolicy.status === "SUCCESS") assert.equal(recoveredPolicy.physicalId, policyId);
    const wrongReplay = await policy.create(policyModel, context("Policy", "different-create-operation")); assert.equal(wrongReplay.status, "FAILED"); if (wrongReplay.status === "FAILED") assert.equal(wrongReplay.errorCode, "ResponseHeadersPolicyAlreadyExists");
    assert.equal((await policy.read(policyId, context("Policy", "read", "other-stack"))).status, "FAILED");

    const beforeNoOp = service.getResponseHeadersPolicy(policyId); clock.advance(1_000);
    const noOpPolicy = await policy.update(policyId, policyModel, policyModel, context("Policy", "update-no-op")); assert.equal(noOpPolicy.status, "SUCCESS");
    assert.equal(service.getResponseHeadersPolicy(policyId).etag, beforeNoOp.etag); assert.equal(service.getResponseHeadersPolicy(policyId).lastModifiedAt, beforeNoOp.lastModifiedAt);
    const changedPolicyModel = policy.canonicalize({ ResponseHeadersPolicyConfig: { ...policyProperties.ResponseHeadersPolicyConfig, SecurityHeadersConfig: { ...policyProperties.ResponseHeadersPolicyConfig.SecurityHeadersConfig, ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'none'", Override: true } } } }, policyContext);
    assert.equal((await policy.update(policyId, policyModel, changedPolicyModel, context("Policy", "update"))).status, "SUCCESS"); assert.notEqual(service.getResponseHeadersPolicy(policyId).etag, beforeNoOp.etag);

    const updatedFunctionModel = fn.canonicalize({ ...functionProperties, FunctionCode: "function handler(event) { event.request.uri = '/index.html'; return event.request; }", Tags: [{ Key: "Application", Value: "Updated" }] }, functionContext);
    assert.equal(fn.plan(functionModel, updatedFunctionModel, functionContext).action, "UPDATE"); assert.equal(fn.plan(functionModel, { ...updatedFunctionModel, Name: "replacement" }, functionContext).action, "REPLACE");
    const updatedFunction = await fn.update(functionModel.Name, functionModel, updatedFunctionModel, context("Function", "update")); assert.equal(updatedFunction.status, "SUCCESS"); if (updatedFunction.status === "SUCCESS") { assert.equal(updatedFunction.model.attributes.Stage, "LIVE"); assert.deepEqual(updatedFunction.model.properties.Tags, [{ Key: "Application", Value: "Updated" }]); }

    const updatedDistributionModel = distribution.canonicalize({ ...distributionProperties(functionArn, policyId, oacId), Tags: [{ Key: "Application", Value: "Updated" }] }, distributionContext);
    assert.equal((await distribution.update(distributionId, distributionModel, updatedDistributionModel, context("Distribution", "update"))).status, "SUCCESS"); assert.deepEqual(service.listTags(service.getDistribution(distributionId).arn), { Application: "Updated" });

    for (const [provider, id, model, logicalId] of [[fn, functionModel.Name, updatedFunctionModel, "Function"], [oac, oacId, oacModel, "Oac"], [policy, policyId, changedPolicyModel, "Policy"]] as const) {
      const deleted = await provider.delete(id, model as never, context(logicalId, `delete-in-use-${logicalId}`)); assert.equal(deleted.status, "FAILED");
    }
    const disabling = await distribution.delete(distributionId, updatedDistributionModel, context("Distribution", "delete")); assert.equal(disabling.status, "IN_PROGRESS");
    const deletedDistribution = await distribution.delete(distributionId, updatedDistributionModel, context("Distribution", "delete")); assert.equal(deletedDistribution.status, "SUCCESS");
    assert.equal((await fn.delete(functionModel.Name, updatedFunctionModel, context("Function", "delete"))).status, "SUCCESS");
    assert.equal((await oac.delete(oacId, oacModel, context("Oac", "delete"))).status, "SUCCESS");
    assert.equal((await policy.delete(policyId, changedPolicyModel, context("Policy", "delete"))).status, "SUCCESS");
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});

test("CFR-01 retained CloudFront resources release private ownership without name adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-cloudfront-retain-")); const store = new StateStore(root, accountId, region); await store.load();
  const service = new CloudFrontService(store, new TestClock(), () => { throw new Error("unused"); });
  try {
    const fn = createCloudFrontCloudFormationProviders(service).find(provider => provider.typeName === "AWS::CloudFront::Function") as ProductionResourceProvider<CloudFrontFunctionModel>;
    const ownerContext = context("RetainedFunction"); const model = fn.canonicalize({ ...functionProperties, Name: "retained-function" }, ownerContext);
    const created = await fn.create(model, ownerContext); assert.equal(created.status, "SUCCESS");
    await fn.retain!(model.Name, model, context("RetainedFunction", "retain"));
    assert.equal((await fn.read(model.Name, context("RetainedFunction", "read"))).status, "FAILED");
    const recreate = await fn.create(model, context("RetainedFunction", "new-create")); assert.equal(recreate.status, "FAILED"); if (recreate.status === "FAILED") assert.equal(recreate.errorCode, "FunctionAlreadyExists");
    assert.equal(service.getFunction(model.Name).cloudFormationOwner, undefined);
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});
