import { build } from "esbuild";
import { projectRoot } from "./common.mjs";
import { join } from "node:path";
await build({
  entryPoints: [join(projectRoot, "lambda", "index.mjs")],
  outfile: join(projectRoot, "lambda", "dist", "index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
