import { build } from "esbuild";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { projectRoot } from "./config.mjs";

const outputRoot = resolve(projectRoot, ".lambda-build");
if (!outputRoot.startsWith(`${resolve(projectRoot)}${sep}`)) throw new Error("Lambda build output escaped the project");
const entries = {
  api: "lambda/api/index.ts",
  "realtime-authorizer": "lambda/realtime-authorizer/index.ts",
  "realtime-connection": "lambda/realtime-connection/index.ts",
  publisher: "lambda/publisher/index.ts",
  broadcast: "lambda/broadcast/index.ts",
  relay: "lambda/relay/index.ts",
  worker: "lambda/worker/index.ts",
};
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const [name, entry] of Object.entries(entries)) {
  const directory = join(outputRoot, name);
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [join(projectRoot, entry)],
    outfile: join(directory, "index.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: false,
    sourcemap: false,
    logLevel: "warning",
  });
  await writeFile(join(directory, "package.json"), '{"private":true,"type":"commonjs"}\n');
  const info = await stat(join(directory, "index.js"));
  if (!info.isFile() || info.size < 100) throw new Error(`Lambda bundle ${name} is empty`);
}
console.log(`Built ${Object.keys(entries).length} Lambda bundles.`);
