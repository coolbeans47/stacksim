import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const commonVariant = process.env.CLOUDFRONT_FIXTURE_VARIANT ?? "v1";
const appVariant = process.env.CLOUDFRONT_FIXTURE_APP_VARIANT ?? commonVariant;
const assetVariant = process.env.CLOUDFRONT_FIXTURE_ASSET_VARIANT ?? commonVariant;
for (const [name, value] of Object.entries({ appVariant, assetVariant })) {
  if (!/^[a-z0-9-]{1,32}$/.test(value)) throw new Error(`${name} must contain only lowercase letters, digits, and hyphens`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });
await writeFile(join(dist, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>StackSim CloudFront fixture ${appVariant}</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body><main id="app">CloudFront fixture ${appVariant}</main><script type="module" src="/assets/app.js"></script></body>
</html>
`, "utf8");
await writeFile(join(dist, "runtime-config.json"), `${JSON.stringify({
  stage: "fallback",
  region: "eu-west-2",
  userPoolId: "fallback-pool",
  userPoolClientId: "fallback-client",
  apiBaseUrl: "https://fallback.invalid/v1",
})}\n`, "utf8");
await writeFile(join(dist, "app-build.txt"), `cloudfront-app-${appVariant}\n`, "utf8");
if (appVariant === "v1") await writeFile(join(dist, "obsolete.txt"), "removed-by-app-prune\n", "utf8");

const payload = `export const fixtureVariant = ${JSON.stringify(assetVariant)};\n` +
  `document.documentElement.dataset.fixture = fixtureVariant;\n` +
  `export const compressiblePayload = ${JSON.stringify(`${assetVariant}-`.repeat(900))};\n`;
await writeFile(join(dist, "assets", "app.js"), payload, "utf8");
await writeFile(join(dist, "assets", "app.css"), `:root{color-scheme:dark}body{font-family:system-ui;background:#071a22;color:#eaf6f7}/* ${assetVariant} */\n`, "utf8");
if (assetVariant === "v1") await writeFile(join(dist, "assets", "removed.js"), "export const removedInV2 = true;\n", "utf8");

