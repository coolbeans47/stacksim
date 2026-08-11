import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/capture",
  testMatch: "cloudformation-console.capture.spec.js",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 300_000,
  outputDir: "./.stacksim/playwright-capture-results",
  use: {
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
});
