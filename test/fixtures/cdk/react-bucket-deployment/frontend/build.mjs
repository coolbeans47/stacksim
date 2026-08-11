import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, "dist");
const variant = process.env.REACT_FIXTURE_VARIANT ?? "v1";

if (!/^[a-z0-9-]{1,32}$/.test(variant)) {
  throw new Error("REACT_FIXTURE_VARIANT must contain only lowercase letters, digits, and hyphens");
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  charset: "utf8",
  define: { __FIXTURE_VARIANT__: JSON.stringify(variant) },
  entryNames: "assets/app",
  entryPoints: ["src/main.jsx"],
  format: "esm",
  legalComments: "none",
  minify: true,
  outdir,
  platform: "browser",
  sourcemap: false,
  target: ["es2020"],
});

await writeFile(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>stacksim React fixture</title>
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`, "utf8");
await writeFile(join(outdir, "build.txt"), `stacksim-react-${variant}\n`, "utf8");
if (variant === "v1") await writeFile(join(outdir, "obsolete.txt"), "removed-by-prune\n", "utf8");
