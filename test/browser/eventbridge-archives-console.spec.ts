import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import { CreateEventBusCommand, DescribeArchiveCommand, EventBridgeClient, PutEventsCommand, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let simulator: StackSim; let dataDir: string; let client: EventBridgeClient; let consoleUrl: string;
const region = "eu-west-1"; const account = "000000000000";

test.describe("EVB-04 archive and replay console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-archives-console-")); simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off" }); await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; consoleUrl = `${endpoint}/_stacksim/console`; client = new EventBridgeClient({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  });
  test.afterEach(async () => { client.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); });

  test("archives matching events, completes and cancels replays, and labels local diagnostics", async ({ page }) => {
    const busArn = `arn:aws:events:${region}:${account}:event-bus/browser-recovery`; const ruleArn = `arn:aws:events:${region}:${account}:rule/browser-recovery/fixed-consumer`; const targetArn = `arn:aws:lambda:${region}:${account}:function:browser-recovery-target`; const received: any[] = [];
    (simulator.lambda as any).enqueueEventBridgeInvocation = async (_arn: string, payload: Buffer) => { received.push(JSON.parse(payload.toString("utf8"))); return "accepted"; };
    await client.send(new CreateEventBusCommand({ Name: "browser-recovery" })); await client.send(new PutRuleCommand({ Name: "fixed-consumer", EventBusName: "browser-recovery", EventPattern: JSON.stringify({ source: ["browser.recovery"] }) })); await client.send(new PutTargetsCommand({ Rule: "fixed-consumer", EventBusName: "browser-recovery", Targets: [{ Id: "target", Arn: targetArn }] }));

    await page.goto(`${consoleUrl}#/eventbridge/archives`); await expect(page.getByRole("heading", { name: "Archives", exact: true })).toBeVisible(); await expect(page.getByText(/development-grade local archive behavior/i)).toBeVisible(); const tester = page.locator("[data-archive-pattern-tester]"); await tester.getByLabel("Event pattern (JSON)").fill('{"source":["browser.recovery"]}'); await tester.getByLabel("Sample event (JSON)").fill('{"version":"0","id":"sample","detail-type":"Recovery","source":"browser.recovery","account":"000000000000","time":"2026-08-08T12:00:00Z","region":"eu-west-1","resources":[],"detail":{}}'); await tester.getByRole("button", { name: "Test pattern" }).click(); await expect(tester.getByRole("status")).toContainText("Pattern matches");
    await page.getByRole("button", { name: "Create archive" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Name").fill("browser-archive"); await dialog.getByLabel("Source event bus").selectOption("browser-recovery"); await dialog.getByLabel("Description").fill("Browser recovery workflow"); await dialog.getByLabel("Event pattern (JSON, optional)").fill('{"source":["browser.recovery"]}'); await dialog.getByLabel("Retention days").fill("0"); await dialog.getByRole("button", { name: "Create archive" }).click(); await expect(page).toHaveURL(/#\/eventbridge\/archives\/browser-archive$/); await expect(page.getByText("Indefinite", { exact: true })).toBeVisible();

    await client.send(new PutEventsCommand({ Entries: [{ EventBusName: "browser-recovery", Source: "browser.recovery", DetailType: "Recovery", Detail: '{"id":1}' }, { EventBusName: "browser-recovery", Source: "browser.other", DetailType: "Ignored", Detail: "{}" }] })); await page.reload(); await expect(page.getByText("committed events ·", { exact: false })).toContainText("committed events"); await expect(page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Truthful local counts" }) }).locator(".metric")).toHaveText("1");
    await page.getByRole("button", { name: "Replay", exact: true }).click(); const replayDialog = page.getByRole("dialog"); await replayDialog.getByLabel("Name").fill("browser-complete"); await replayDialog.getByLabel("fixed-consumer").check(); await replayDialog.getByRole("button", { name: "Start replay" }).click(); await expect(page).toHaveURL(/#\/eventbridge\/replays\/browser-complete$/); await expect(page.getByText(/not an AWS replay metric/i)).toBeVisible();
    await expect.poll(async () => { const replay = (simulator.eventbridge as any).archiveStore.replay("browser-complete"); return replay?.state; }).toBe("COMPLETED"); await page.reload(); await expect(page.getByText("COMPLETED", { exact: true })).toBeVisible(); await expect.poll(() => received.some(event => event["replay-name"] === "browser-complete")).toBe(true); assert.equal((await client.send(new DescribeArchiveCommand({ ArchiveName: "browser-archive" }))).EventCount, 1); assert.equal(received.some(event => event["replay-name"] === "browser-complete"), true); assert.equal(ruleArn.endsWith("fixed-consumer"), true);

    (simulator.eventbridge as any).replayWorkerRunning = true; await page.goto(`${consoleUrl}#/eventbridge/replays`); await page.getByRole("button", { name: "Start replay" }).click(); const cancelDialog = page.getByRole("dialog"); await cancelDialog.getByLabel("Name").fill("browser-cancel"); await cancelDialog.getByRole("button", { name: "Start replay" }).click(); await page.getByRole("button", { name: "Cancel replay" }).click(); (simulator.eventbridge as any).replayWorkerRunning = false; (simulator.eventbridge as any).scheduleNextReplay(); await expect.poll(() => (simulator.eventbridge as any).archiveStore.replay("browser-cancel")?.state).toBe("CANCELLED"); await page.reload(); await expect(page.getByText("CANCELLED", { exact: true })).toBeVisible();
  });
});
