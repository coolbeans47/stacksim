import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";

const config = await loadConfig();
const deployment = JSON.parse(await readFile(join(projectRoot, ".runtime", "deployment.json"), "utf8"));
const password = process.env.SPRINT_PLANNER_ADMIN_PASSWORD;
if (!password) throw new Error("Set the ephemeral SPRINT_PLANNER_ADMIN_PASSWORD used by the configured administrator");
const screenshots = join(projectRoot, "screenshots");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function signedInPage(viewport) {
  const context = await browser.newContext({ viewportSize: viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${deployment.websiteUrl}#/login`);
  await page.getByLabel("Email address").fill(config.bootstrapAdmin.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/#\/board/);
  await page.getByRole("heading", { name: /Sprint 08/ }).waitFor();
  await page.getByText("SP-106", { exact: true }).waitFor();
  return { context, page };
}
const desktop = await signedInPage({ width: 1440, height: 900 });
await desktop.page.screenshot({ path: join(screenshots, "board-desktop-1440x900.png"), fullPage: true });
await desktop.page.getByText("SP-103", { exact: true }).click();
await desktop.page.getByRole("dialog").waitFor();
await desktop.page.screenshot({ path: join(screenshots, "ticket-drawer-desktop-1440x900.png"), fullPage: true });
await desktop.context.close();
const mobile = await signedInPage({ width: 390, height: 844 });
await mobile.page.screenshot({ path: join(screenshots, "board-mobile-390x844.png"), fullPage: true });
await mobile.page.getByRole("button", { name: "Team" }).click();
await mobile.page.getByRole("heading", { name: "Team" }).waitFor();
await mobile.page.screenshot({ path: join(screenshots, "team-mobile-390x844.png"), fullPage: true });
await mobile.context.close();
await browser.close();
console.log(`Captured responsive showcase screenshots in ${screenshots}.`);
