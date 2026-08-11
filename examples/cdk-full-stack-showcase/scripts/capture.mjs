import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const deploymentPath = resolve(projectRoot, process.env.AURORA_DEPLOYMENT_FILE || ".runtime/deployment.json");
const screenshotRoot = resolve(projectRoot, process.env.AURORA_SCREENSHOT_DIR || "screenshots");
const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

async function deployment() {
  try {
    return JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${deploymentPath}. Run npm run deploy first. ${error.message}`);
  }
}

async function launchBrowser() {
  const requestedChannel = process.env.PLAYWRIGHT_CHANNEL || "chrome";
  try {
    return await chromium.launch({ channel: requestedChannel, headless: true, args: ["--disable-gpu"] });
  } catch (channelError) {
    if (process.env.PLAYWRIGHT_CHANNEL) throw channelError;
    try {
      return await chromium.launch({ headless: true, args: ["--disable-gpu"] });
    } catch (bundledError) {
      throw new Error(`Unable to launch Chrome or bundled Chromium. Chrome: ${channelError.message}; Chromium: ${bundledError.message}`);
    }
  }
}

async function capture(browser, websiteUrl, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: "dark",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const diagnostics = [];
  page.on("console", message => {
    if (message.type() === "error") {
      const location = message.location();
      const source = location.url
        ? ` (${location.url}${location.lineNumber ? `:${location.lineNumber}` : ""}${location.columnNumber ? `:${location.columnNumber}` : ""})`
        : "";
      diagnostics.push(`console: ${message.text()}${source}`);
    }
  });
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => diagnostics.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText || "unknown"})`));

  try {
    const response = await page.goto(websiteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!response?.ok()) throw new Error(`website navigation returned HTTP ${response?.status() ?? "unknown"}`);
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => {
      const atlas = document.querySelector('.constellation-canvas[aria-label*="visible signals"]');
      const label = atlas?.getAttribute("aria-label") || "";
      return /^[1-9]\d* visible signals/.test(label);
    }, undefined, { timeout: 30_000 });
    await page.addStyleTag({ content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0.001s !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
    ` });
    await page.evaluate(async () => {
      await document.fonts?.ready;
      window.scrollTo(0, 0);
      await new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)));
    });

    const dimensions = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    if (dimensions.viewportWidth !== viewport.width || dimensions.viewportHeight !== viewport.height) {
      throw new Error(`viewport drifted: ${JSON.stringify(dimensions)}`);
    }
    if (dimensions.documentWidth > viewport.width + 1 || dimensions.bodyWidth > viewport.width + 1) {
      throw new Error(`page has horizontal overflow: ${JSON.stringify(dimensions)}`);
    }
    if (diagnostics.length) throw new Error(`browser diagnostics were emitted:\n${diagnostics.join("\n")}`);

    const path = join(screenshotRoot, `${viewport.name}.png`);
    await page.screenshot({ path, type: "png", fullPage: false });
    return path;
  } finally {
    await context.close();
  }
}

async function main() {
  const manifest = await deployment();
  if (typeof manifest.websiteUrl !== "string" || !manifest.websiteUrl) {
    throw new Error("deployment manifest has no websiteUrl");
  }
  await mkdir(screenshotRoot, { recursive: true });
  const browser = await launchBrowser();
  try {
    const captures = [];
    for (const viewport of viewports) captures.push(await capture(browser, manifest.websiteUrl, viewport));
    console.log("[aurora-atlas] browser capture passed without console errors or horizontal overflow");
    for (const path of captures) console.log(`  ${path}`);
    console.log("[aurora-atlas] Attach these PNGs as image artifacts in ChatGPT; do not hand off local file links.");
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`[aurora-atlas] capture failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
