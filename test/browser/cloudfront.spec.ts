import { expect, test, type Page } from "@playwright/test";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID } from "../../src/cloudfront/model.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let distributionId: string;

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

function methods(values: string[]) { return { Quantity: values.length, Items: { Method: values }, CachedMethods: { Quantity: 2, Items: { Method: ["GET", "HEAD"] } } }; }

async function signIn(page: Page) {
  const form = page.locator("#console-sign-in");
  await form.getByLabel("Access key ID").fill("admin");
  await form.getByLabel("Secret access key").fill("password");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  const onboarding = page.getByRole("heading", { name: "Secure the default IAM access key" });
  if (await onboarding.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) {
    await page.locator('input[name="choice"][value="keep"]').check();
    await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  }
  await expect(page.getByRole("heading", { name: "Console Home" })).toBeVisible();
}

test.describe("CFR-01 CloudFront console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-cloudfront-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1" });
    await simulator.start(); consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    const s3 = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: "cloudfront-console-origin", CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } })); s3.destroy();
    const policy = await simulator.cloudfront.createResponseHeadersPolicy({ Name: "console-security", Comment: "safe console fixture", SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true }, ContentTypeOptions: { Override: true }, FrameOptions: { FrameOption: "DENY", Override: true }, ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true }, StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true, Preload: true } } });
    const oac = await simulator.cloudfront.createOriginAccessControl({ Name: "console-oac", Description: "private S3", OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
    let fn = await simulator.cloudfront.createFunction("console-rewrite", { Comment: "metadata only", Runtime: "cloudfront-js-1.0" }, "function handler(event){event.request.uri='/index.html';return event.request;}");
    fn = await simulator.cloudfront.publishFunction(fn.name, fn.development.etag);
    const originId = "ConsoleOrigin";
    const behavior = (cachePolicyId: string, pathPattern?: string) => ({ ...(pathPattern ? { PathPattern: pathPattern } : {}), TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: methods(["GET", "HEAD", "OPTIONS"]), Compress: true, FunctionAssociations: { Quantity: pathPattern ? 0 : 1, ...(pathPattern ? {} : { Items: { FunctionAssociation: [{ EventType: "viewer-request", FunctionARN: fn.arn }] } }) }, LambdaFunctionAssociations: { Quantity: 0 }, CachePolicyId: cachePolicyId, ResponseHeadersPolicyId: policy.id, SmoothStreaming: false, FieldLevelEncryptionId: "", TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 } });
    const distribution = await simulator.cloudfront.createDistribution({ CallerReference: "console-distribution", Aliases: { Quantity: 0 }, DefaultRootObject: "index.html", Origins: { Quantity: 1, Items: { Origin: [{ Id: originId, DomainName: "cloudfront-console-origin.s3.eu-west-1.amazonaws.com", OriginAccessControlId: oac.id, S3OriginConfig: { OriginAccessIdentity: "" } }] } }, OriginGroups: { Quantity: 0 }, DefaultCacheBehavior: behavior(CACHING_DISABLED_ID), CacheBehaviors: { Quantity: 2, Items: { CacheBehavior: [behavior(CACHING_OPTIMIZED_ID, "assets/*"), behavior(CACHING_DISABLED_ID, "runtime-config.json")] } }, CustomErrorResponses: { Quantity: 0 }, Comment: "", Logging: { Enabled: false, IncludeCookies: false, Bucket: "", Prefix: "" }, PriceClass: "PriceClass_All", Enabled: true, ViewerCertificate: { CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1", CertificateSource: "cloudfront" }, Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } }, WebACLId: "", HttpVersion: "http2and3", IsIPV6Enabled: true, ContinuousDeploymentPolicyId: "", Staging: false }, { Environment: "test" });
    distributionId = distribution.id;
    await simulator.cloudfront.createInvalidation(distribution.id, ["/*"], "console-invalidation");
  });

  test.afterEach(async () => { await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) test(`renders safe authoritative CloudFront views at ${viewport.width} pixels`, async ({ page }) => {
    const errors = browserErrors(page); const signedServices: string[] = [];
    page.on("request", request => { if (request.url().includes("/_stacksim/api/cloudfront")) signedServices.push(request.headers().authorization ?? ""); });
    await page.setViewportSize(viewport);
    await page.goto(`${consoleUrl}#/home`); await signIn(page);
    const cloudFrontCard = page.locator('[data-service-key="cloudfront"]');
    await expect(cloudFrontCard.locator(".metric")).toHaveText("1");
    await cloudFrontCard.getByRole("link", { name: "View distributions" }).click();
    await expect(page.getByRole("heading", { name: "Distributions", exact: true })).toBeVisible();
    expect(signedServices.some(value => value.includes("/cloudfront/aws4_request"))).toBeTruthy();
    for (const route of ["#/cloudfront/distributions", `#/cloudfront/distributions/${distributionId}`, "#/cloudfront/functions", "#/cloudfront/response-policies", "#/cloudfront/origin-access-controls"]) {
      await page.goto(`${consoleUrl}${route}`); await expect(page.locator("main h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    }
    await page.goto(`${consoleUrl}#/cloudfront/distributions`); await expect(page.getByText(distributionId, { exact: true })).toBeVisible(); await page.getByText(distributionId, { exact: true }).click();
    await expect(page.getByText(/\.cloudfront\.net/).first()).toBeVisible(); await expect(page.getByText(/\.localhost:/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Invalidations/ })).toBeVisible(); await expect(page.locator("main")).not.toContainText("function handler");
    expect(errors).toEqual([]);
  });
});
