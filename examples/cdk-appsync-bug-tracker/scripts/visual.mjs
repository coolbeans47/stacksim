import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, readManifest } from "./common.mjs";

const manifest = await readManifest();
const browser = await chromium.launch();
const screenshots = join(projectRoot, "screenshots");
const localAppSyncTls = new URL(manifest.graphqlEndpoint).protocol === "https:";
await mkdir(screenshots, { recursive: true });
for (const [name, viewport] of [["board-desktop", { width: 1440, height: 900 }], ["board-mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, ignoreHTTPSErrors: localAppSyncTls });
  await page.goto(manifest.websiteUrl);
  await page.getByRole("heading", { name: "Triage board" }).waitFor();
  await page.locator("[data-testid^=bug-card-]").first().waitFor();
  await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
  await page.close();
}
await browser.close();
console.log(`[bug-tracker] visual captures written to ${screenshots}`);
