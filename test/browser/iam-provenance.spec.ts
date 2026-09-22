import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IAMClient, CreateUserCommand, CreateAccessKeyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../../src/server.js";

test("a learner can identify the exact policy and statement behind allow and deny decisions", async ({ page }, testInfo) => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-iam-explanation-browser-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1" });
  let iam: IAMClient | undefined; let db: DynamoDBClient | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); const endpoint = `http://127.0.0.1:${sim.port}`; const config = { endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
    iam = new IAMClient(config);
    const user = await iam.send(new CreateUserCommand({ UserName: "provenance-learner", Path: "/class/" }));
    const document = (Effect: "Allow" | "Deny") => JSON.stringify({ Statement: [{ Sid: "SameSid", Effect, Action: "dynamodb:ListTables", Resource: "*" }] });
    await iam.send(new PutUserPolicyCommand({ UserName: "provenance-learner", PolicyName: "list-tables", PolicyDocument: document("Allow") }));
    const key = (await iam.send(new CreateAccessKeyCommand({ UserName: "provenance-learner" }))).AccessKey!;
    db = new DynamoDBClient({ ...config, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! }, maxAttempts: 1 });
    await db.send(new ListTablesCommand({}));
    await iam.send(new PutUserPolicyCommand({ UserName: "provenance-learner", PolicyName: "class-restriction", PolicyDocument: document("Deny") }));
    await expect(db.send(new ListTablesCommand({}))).rejects.toThrow(/not authorized/);
    await page.goto(`${endpoint}/_stacksim/console/#/iam/decisions`);
    const form = page.locator("#console-sign-in");
    await form.getByLabel("Access key ID").fill("admin"); await form.getByLabel("Secret access key").fill("password"); await form.getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("heading", { name: "Secure the default IAM access key" });
    if (await onboarding.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { await page.locator('input[name="choice"][value="keep"]').check(); await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click(); }
    await page.goto(`${endpoint}/_stacksim/console/#/iam/decisions`);
    const denied = page.locator("tbody.iam-decision").filter({ hasText: user.User!.Arn! }).filter({ hasText: "dynamodb:ListTables" }).filter({ hasText: "explicitDeny" });
    await denied.locator("summary").click();
    await expect(denied).toContainText("class-restriction"); await expect(denied).toContainText("list-tables"); await expect(denied).toContainText("Statement index 0 · SID SameSid"); await expect(denied).toContainText("identity · Deny · Matched"); await expect(denied).toContainText("revision sha256:");
    const allowed = page.locator("tbody.iam-decision").filter({ hasText: user.User!.Arn! }).filter({ hasText: "dynamodb:ListTables" }).filter({ hasText: "allowed" });
    await allowed.locator("summary").click(); await expect(allowed).toContainText("list-tables");
    await denied.screenshot({ path: testInfo.outputPath("iam-policy-explanation.png") });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(denied.locator("summary")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(key.SecretAccessKey!); expect(errors).toEqual([]);
  } finally { await page.close(); iam?.destroy(); db?.destroy(); await sim.stop(); await rm(dataDir, { recursive: true, force: true }); }
});
