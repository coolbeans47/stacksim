import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFrontClient,
  CreateDistributionWithTagsCommand,
  CreateFunctionCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  CreateResponseHeadersPolicyCommand,
  DeleteDistributionCommand,
  DeleteFunctionCommand,
  DeleteOriginAccessControlCommand,
  DeleteResponseHeadersPolicyCommand,
  DescribeFunctionCommand,
  GetCachePolicyCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetFunctionCommand,
  GetInvalidationCommand,
  GetOriginAccessControlConfigCommand,
  GetResponseHeadersPolicyConfigCommand,
  ListDistributionsCommand,
  ListFunctionsCommand,
  ListInvalidationsCommand,
  ListOriginAccessControlsCommand,
  ListResponseHeadersPoliciesCommand,
  ListTagsForResourceCommand,
  PublishFunctionCommand,
  UpdateDistributionCommand,
  waitUntilDistributionDeployed,
  waitUntilInvalidationCompleted,
  type DistributionConfig,
} from "@aws-sdk/client-cloudfront";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID } from "../src/cloudfront/model.js";
import { migrateState } from "../src/migrations/index.js";
import { emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const accountA = "000000000000";
const accountB = "111111111111";
const primaryRegion = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function cloudFront(port: number, region: string): CloudFrontClient { return new CloudFrontClient({ endpoint: `http://127.0.0.1:${port}`, region, credentials, maxAttempts: 1 }); }
function s3(port: number): S3Client { return new S3Client({ endpoint: `http://127.0.0.1:${port}`, region: primaryRegion, credentials, forcePathStyle: true, maxAttempts: 1 }); }
function allowed(items: Array<"GET" | "HEAD" | "OPTIONS">) { return { Quantity: items.length, Items: items, CachedMethods: { Quantity: 2, Items: ["GET" as const, "HEAD" as const] } }; }

function distributionConfig(originDomain: string, oacId: string, functionArn: string, policyId: string): DistributionConfig {
  const originId = "FixtureOrigin";
  return {
    CallerReference: "cloudfront-service-lifecycle", Aliases: { Quantity: 0 }, DefaultRootObject: "index.html",
    Origins: { Quantity: 1, Items: [{ Id: originId, DomainName: originDomain, OriginAccessControlId: oacId, S3OriginConfig: { OriginAccessIdentity: "" } }] },
    OriginGroups: { Quantity: 0 },
    DefaultCacheBehavior: {
      TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: allowed(["GET", "HEAD", "OPTIONS"]), Compress: true,
      FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: functionArn }] }, LambdaFunctionAssociations: { Quantity: 0 },
      CachePolicyId: CACHING_DISABLED_ID, ResponseHeadersPolicyId: policyId, SmoothStreaming: false, FieldLevelEncryptionId: "",
      TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    },
    CacheBehaviors: { Quantity: 2, Items: [
      { PathPattern: "assets/*", TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: allowed(["GET", "HEAD", "OPTIONS"]), Compress: true, FunctionAssociations: { Quantity: 0 }, LambdaFunctionAssociations: { Quantity: 0 }, CachePolicyId: CACHING_OPTIMIZED_ID, ResponseHeadersPolicyId: policyId, SmoothStreaming: false, FieldLevelEncryptionId: "", TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 } },
      { PathPattern: "runtime-config.json", TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: allowed(["GET", "HEAD"]), Compress: true, FunctionAssociations: { Quantity: 0 }, LambdaFunctionAssociations: { Quantity: 0 }, CachePolicyId: CACHING_DISABLED_ID, ResponseHeadersPolicyId: policyId, SmoothStreaming: false, FieldLevelEncryptionId: "", TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 } },
    ] },
    CustomErrorResponses: { Quantity: 0 }, Comment: "", Logging: { Enabled: false, IncludeCookies: false, Bucket: "", Prefix: "" }, PriceClass: "PriceClass_All", Enabled: true,
    ViewerCertificate: { CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1", CertificateSource: "cloudfront" }, Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
    WebACLId: "", HttpVersion: "http2and3", IsIPV6Enabled: true, ContinuousDeploymentPolicyId: "", Staging: false,
  };
}

test("CloudFront v87 migration creates account-global empty state and is idempotent", () => {
  const legacy = emptyState(accountA, primaryRegion) as any; legacy.schemaVersion = 87; delete legacy.accounts[accountA].cloudfront;
  const migrated = migrateState(legacy, accountA, primaryRegion); assert.equal(migrated.migrated, true); assert.deepEqual(migrated.state.accounts[accountA].cloudfront, {
    schemaVersion: 1, revision: 0, distributions: {}, distributionCallerReferences: {}, functions: {}, originAccessControls: {}, originAccessControlNames: {}, responseHeadersPolicies: {}, responseHeadersPolicyNames: {}, invalidations: {}, invalidationCallerReferences: {},
  });
  const repeated = migrateState(migrated.state, accountA, "us-east-1"); assert.equal(repeated.migrated, false); assert.deepEqual(repeated.state.accounts[accountA].cloudfront, migrated.state.accounts[accountA].cloudfront);
});

test("official CloudFront client lifecycle is global across Regions, persistent, account isolated, and replays invalidations", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cloudfront-service-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: primaryRegion, accountId: accountA, authMode: "off", cdkBootstrap: false });
  let client: CloudFrontClient | undefined; let bucketClient: S3Client | undefined;
  let distributionId = ""; let distributionEtag = ""; let functionName = "fixture-rewrite"; let functionEtag = ""; let oacId = ""; let policyId = ""; let invalidationId = "";
  try {
    await simulator.start(); client = cloudFront(simulator.port, primaryRegion); bucketClient = s3(simulator.port);
    await bucketClient.send(new CreateBucketCommand({ Bucket: "fixture-cloudfront-origin", CreateBucketConfiguration: { LocationConstraint: primaryRegion } }));

    const policy = await client.send(new CreateResponseHeadersPolicyCommand({ ResponseHeadersPolicyConfig: {
      Name: "fixture-security", Comment: "opening policy", SecurityHeadersConfig: {
        ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true }, ContentTypeOptions: { Override: true }, FrameOptions: { FrameOption: "DENY", Override: true },
        ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true }, StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true, Preload: true },
      },
    } }));
    policyId = policy.ResponseHeadersPolicy!.Id!; assert.ok(policy.ETag); assert.equal(policy.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Comment, "opening policy");

    const createdFunction = await client.send(new CreateFunctionCommand({ Name: functionName, FunctionCode: Buffer.from("function handler(event){return event.request;}"), FunctionConfig: { Comment: "rewrite", Runtime: "cloudfront-js-1.0" } }));
    functionEtag = createdFunction.ETag!; const functionArn = createdFunction.FunctionSummary!.FunctionMetadata!.FunctionARN!;
    const rawCode = await client.send(new GetFunctionCommand({ Name: functionName, Stage: "DEVELOPMENT" })); assert.equal(Buffer.from(rawCode.FunctionCode!).toString("utf8"), "function handler(event){return event.request;}");
    const published = await client.send(new PublishFunctionCommand({ Name: functionName, IfMatch: functionEtag })); assert.equal(published.FunctionSummary?.FunctionMetadata?.Stage, "LIVE");

    const oac = await client.send(new CreateOriginAccessControlCommand({ OriginAccessControlConfig: { Name: "fixture-oac", Description: "private S3", OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" } }));
    oacId = oac.OriginAccessControl!.Id!; assert.ok(oac.ETag);

    const createdDistribution = await client.send(new CreateDistributionWithTagsCommand({ DistributionConfigWithTags: {
      DistributionConfig: distributionConfig(`fixture-cloudfront-origin.s3.${primaryRegion}.amazonaws.com`, oacId, functionArn, policyId),
      Tags: { Items: [{ Key: "Environment", Value: "test" }] },
    } }));
    distributionId = createdDistribution.Distribution!.Id!; distributionEtag = createdDistribution.ETag!;
    assert.match(createdDistribution.Distribution!.DomainName!, /^d[0-9a-f]+\.cloudfront\.net$/); assert.equal(createdDistribution.Distribution?.Status, "Deployed");
    assert.equal((await waitUntilDistributionDeployed({ client, maxWaitTime: 2, minDelay: 1, maxDelay: 1 }, { Id: distributionId })).state, "SUCCESS");
    assert.deepEqual(simulator.cloudfront.listTags(createdDistribution.Distribution!.ARN!), { Environment: "test" });
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ Resource: createdDistribution.Distribution!.ARN! }))).Tags?.Items, [{ Key: "Environment", Value: "test" }]);
    assert.equal((await client.send(new GetCachePolicyCommand({ Id: CACHING_OPTIMIZED_ID }))).CachePolicy?.CachePolicyConfig?.Name, "Managed-CachingOptimized");

    const invalidation = await client.send(new CreateInvalidationCommand({ DistributionId: distributionId, InvalidationBatch: { CallerReference: "deployment-1", Paths: { Quantity: 1, Items: ["/*"] } } }));
    invalidationId = invalidation.Invalidation!.Id!; assert.equal(invalidation.Invalidation?.Status, "Completed");
    assert.equal((await waitUntilInvalidationCompleted({ client, maxWaitTime: 2, minDelay: 1, maxDelay: 1 }, { DistributionId: distributionId, Id: invalidationId })).state, "SUCCESS");
    assert.equal((await client.send(new ListInvalidationsCommand({ DistributionId: distributionId }))).InvalidationList?.Quantity, 1);

    const revision = simulator.store.ensureAccount(accountA).cloudfront.revision;
    const unknown = await fetch(`http://127.0.0.1:${simulator.port}/2020-05-31/distribution/${distributionId}/unsupported`, { method: "POST", body: "<Unsupported/>", headers: { "content-type": "application/xml" } });
    assert.equal(unknown.status, 404); assert.match(await unknown.text(), /<Code>NoSuchResource<\/Code>/); assert.equal(simulator.store.ensureAccount(accountA).cloudfront.revision, revision);

    client.destroy(); bucketClient.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "us-east-1", accountId: accountA, authMode: "off", cdkBootstrap: false }); await simulator.start(); client = cloudFront(simulator.port, "us-east-1");
    assert.equal((await client.send(new GetDistributionCommand({ Id: distributionId }))).Distribution?.Id, distributionId);
    assert.equal((await client.send(new GetInvalidationCommand({ DistributionId: distributionId, Id: invalidationId }))).Invalidation?.Status, "Completed");
    const replay = await client.send(new CreateInvalidationCommand({ DistributionId: distributionId, InvalidationBatch: { CallerReference: "deployment-1", Paths: { Quantity: 1, Items: ["/*"] } } })); assert.equal(replay.Invalidation?.Id, invalidationId);
    await assert.rejects(client.send(new CreateInvalidationCommand({ DistributionId: distributionId, InvalidationBatch: { CallerReference: "deployment-1", Paths: { Quantity: 1, Items: ["/different"] } } })), (error: any) => error.name === "InvalidationBatchAlreadyExists");
    assert.equal((await client.send(new ListDistributionsCommand({}))).DistributionList?.Quantity, 1); assert.equal((await client.send(new ListFunctionsCommand({ Stage: "LIVE" }))).FunctionList?.Quantity, 1); assert.equal((await client.send(new ListOriginAccessControlsCommand({}))).OriginAccessControlList?.Quantity, 1); assert.equal((await client.send(new ListResponseHeadersPoliciesCommand({ Type: "custom" }))).ResponseHeadersPolicyList?.Quantity, 1);

    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: primaryRegion, accountId: accountB, authMode: "off", cdkBootstrap: false, defaultAccessKeyId: "account-b-admin", defaultSecretAccessKey: "account-b-password" }); await simulator.start(); client = cloudFront(simulator.port, primaryRegion);
    await assert.rejects(client.send(new GetDistributionCommand({ Id: distributionId })), (error: any) => error.name === "NoSuchDistribution"); assert.equal((await client.send(new ListDistributionsCommand({}))).DistributionList?.Quantity, 0);

    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: primaryRegion, accountId: accountA, authMode: "off", cdkBootstrap: false }); await simulator.start(); client = cloudFront(simulator.port, primaryRegion);
    const current = await client.send(new GetDistributionConfigCommand({ Id: distributionId })); distributionEtag = current.ETag!;
    await client.send(new UpdateDistributionCommand({ Id: distributionId, IfMatch: distributionEtag, DistributionConfig: { ...current.DistributionConfig!, Enabled: false } }));
    const disabled = await client.send(new GetDistributionConfigCommand({ Id: distributionId })); await client.send(new DeleteDistributionCommand({ Id: distributionId, IfMatch: disabled.ETag! }));
    const described = await client.send(new DescribeFunctionCommand({ Name: functionName, Stage: "DEVELOPMENT" })); functionEtag = described.ETag!;
    await client.send(new DeleteFunctionCommand({ Name: functionName, IfMatch: functionEtag }));
    const oacConfig = await client.send(new GetOriginAccessControlConfigCommand({ Id: oacId })); await client.send(new DeleteOriginAccessControlCommand({ Id: oacId, IfMatch: oacConfig.ETag! }));
    const policyConfig = await client.send(new GetResponseHeadersPolicyConfigCommand({ Id: policyId })); await client.send(new DeleteResponseHeadersPolicyCommand({ Id: policyId, IfMatch: policyConfig.ETag! }));
  } finally {
    client?.destroy(); bucketClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
