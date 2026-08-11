import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");
const apiBaseUrl = process.env.STACKSIM_API_BASE_URL || "http://127.0.0.1:4567/orderflow-placeholder/prod";

await mkdir(join(outdir, "assets"), { recursive: true });
await build({
  entryPoints: [join(root, "src", "main.jsx")],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "esm",
  target: ["es2022"],
  outfile: join(outdir, "assets", "app.js"),
  loader: { ".jsx": "jsx" },
  define: {
    __ORDERFLOW_API_BASE_URL__: JSON.stringify(apiBaseUrl),
  },
});
await cp(join(root, "src", "styles.css"), join(outdir, "assets", "app.css"));
await writeFile(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0d1110" />
    <meta name="description" content="Launch orders and inspect every transition in an AWS Step Functions Standard Workflow." />
    <title>OrderFlow Observatory · Step Functions</title>
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to the observatory</a>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`, "utf8");
await writeFile(join(outdir, "build.txt"), "orderflow-observatory-v1\n", "utf8");
