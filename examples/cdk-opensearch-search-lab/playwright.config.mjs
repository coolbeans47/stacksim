import { defineConfig } from "@playwright/test";
import { readManifest } from "./scripts/common.mjs";
const manifest = await readManifest();
export default defineConfig({
  testDir: "./test",
  testMatch: "*.e2e.mjs",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: { baseURL: manifest.websiteUrl, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1100 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
