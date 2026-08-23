import { expect, test, type Page } from "@playwright/test";
import { PutTraceSegmentsCommand, XRayClient } from "@aws-sdk/client-xray";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

const region = "eu-west-1";
const traceId = "1-66aa0000-000000000000000000000042";
let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let xray: XRayClient;

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

test.describe("XRY-01 console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-xray-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off" });
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    consoleUrl = `${endpoint}/_stacksim/console`;
    xray = new XRayClient({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    await xray.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: [JSON.stringify({
      name: "browser-api", trace_id: traceId, id: "0000000000000042", start_time: 2_000, end_time: 2_000.125,
      origin: "AWS::ApiGateway::Stage", annotations: { "aws:api_id": "browser123", "aws:api_stage": "dev", "http:method": "GET" },
      http: { request: { method: "GET", url: "https://example.invalid/orders", headers: { authorization: "Bearer must-not-render", cookie: "session=must-not-render" } }, response: { status: 200 } },
      subsegments: [{ name: "Lambda", id: "0000000000000043", start_time: 2_000.01, end_time: 2_000.1 }],
    })] }));
  });

  test.afterEach(async () => {
    xray.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) test(`renders trace workflows without overflow at ${viewport.width} pixels`, async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize(viewport);
    for (const route of ["#/xray/traces", `#/xray/traces/${traceId}`, "#/xray/service-map", "#/xray/diagnostics"]) {
      await page.goto(`${consoleUrl}${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    }
    await page.goto(`${consoleUrl}#/xray/traces`);
    await expect(page.getByText(traceId, { exact: true })).toBeVisible();
    await page.getByText(traceId, { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Lambda/ }).first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText("must-not-render");
    expect(errors).toEqual([]);
  });
});
