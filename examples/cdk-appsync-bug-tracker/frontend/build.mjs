import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "src");
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(join(outdir, "assets"), { recursive: true });

await build({
  absWorkingDir: root,
  bundle: true,
  charset: "utf8",
  entryPoints: [join(source, "main.jsx")],
  entryNames: "assets/app",
  format: "esm",
  jsx: "automatic",
  legalComments: "none",
  minify: true,
  outdir,
  platform: "browser",
  sourcemap: false,
  target: ["es2020"],
  treeShaking: true,
});

await writeFile(join(outdir, "assets", "app.css"), await readFile(join(source, "styles.css"), "utf8"), "utf8");
await writeFile(join(outdir, "config.json"), `${JSON.stringify({
  configured: false,
  message: "Run npm run deploy to generate local runtime configuration.",
}, null, 2)}\n`, "utf8");
await writeFile(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="theme-color" content="#10131a" />
    <meta name="description" content="Team Bug Triage Board — a StackSim AppSync showcase" />
    <title>Team Bug Triage · StackSim</title>
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to board</a>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`, "utf8");
