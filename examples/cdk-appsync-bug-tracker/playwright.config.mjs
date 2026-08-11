import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, ".runtime", "deployment.json"), "utf8"));

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.e2e.mjs",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: manifest.websiteUrl,
    trace: "retain-on-failure",
  },
});
