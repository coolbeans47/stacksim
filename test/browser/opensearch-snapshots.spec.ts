import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Snapshot repository, backup, restore and deletion at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-snapshot-ui-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let iam: IAMClient | undefined, s3: S3Client | undefined; const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
    iam = new IAMClient(config); s3 = new S3Client({ ...config, forcePathStyle: true });
    await sim.opensearch.execute("CreateDomain", { DomainName: "browser-backups", EncryptionAtRestOptions: { Enabled: true } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-backups").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-backups"), engine = (sim.opensearch as any).engine(domain);
    await engine.request("PUT", "/products/_doc/one", Buffer.from('{"title":"Browser snapshot"}'), "seed");
    const role = (await iam.send(new CreateRoleCommand({ RoleName: "BrowserSnapshots", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "es.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!;
    await iam.send(new PutRolePolicyCommand({ RoleName: "BrowserSnapshots", PolicyName: "storage", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: ["arn:aws:s3:::browser-backups", "arn:aws:s3:::browser-backups/*"] }] }) }));
    await s3.send(new CreateBucketCommand({ Bucket: "browser-backups" }));
    await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/domains/browser-backups`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "Manage snapshots", exact: true }).click(); await expect(page.getByRole("link", { name: "cs-automated-enc", exact: true })).toBeVisible();
    await page.getByLabel("Repository name", { exact: true }).fill("backups"); await page.getByLabel("S3 bucket", { exact: true }).fill("browser-backups"); await page.getByLabel("Snapshot role ARN", { exact: true }).fill(role.Arn!); await page.getByRole("button", { name: "Register and verify", exact: true }).click();
    await expect(page.getByRole("button", { name: "Verify repository", exact: true })).toBeVisible();
    await page.getByLabel("Snapshot name", { exact: true }).fill("browser-snapshot"); await page.getByRole("button", { name: "Create snapshot", exact: true }).click();
    await expect(page.getByLabel("Snapshot to restore", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Restore snapshot", exact: true }).click();
    await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Restore", exact: true }) })).toContainText("SUCCESS");
    expect((await engine.request("GET", "/restored-products/_doc/one", Buffer.alloc(0), "verify")).body._source.title).toBe("Browser snapshot");
    await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`snapshots-${width}.png`), fullPage: true });
    await page.getByRole("heading", { name: "Restore snapshot", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`snapshots-restore-${width}.png`) });
    await page.getByRole("button", { name: "Delete snapshot", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("browser-snapshot"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByText("No snapshots in this repository.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unregister repository", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("backups"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByRole("link", { name: "cs-automated-enc", exact: true })).toBeVisible(); expect(errors).toEqual([]);
  } finally { await page.context().close(); iam?.destroy(); s3?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
