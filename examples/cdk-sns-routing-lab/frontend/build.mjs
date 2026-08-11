import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");
const apiBaseUrl = process.env.STACKSIM_API_BASE_URL || "http://127.0.0.1:4567/sns-routing-placeholder/prod";

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
    __SNS_ROUTING_API_BASE_URL__: JSON.stringify(apiBaseUrl),
  },
});
await cp(join(root, "src", "styles.css"), join(outdir, "assets", "app.css"));

try {
  await readFile(join(root, "public", "og.png"));
  await cp(join(root, "public", "og.png"), join(outdir, "og.png"));
} catch {
  // The social preview is optional during the first placeholder build.
}

await writeFile(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#07120f" />
    <meta name="description" content="Learn Amazon SNS by publishing once and watching filtered subscriptions fan out independently." />
    <meta property="og:title" content="Signal Relay — SNS Routing Lab" />
    <meta property="og:description" content="An interactive AWS CDK tutorial for SNS topics, filters, fan-out and delivery." />
    <meta property="og:image" content="./og.png" />
    <title>Signal Relay · SNS Routing Lab</title>
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to the routing lab</a>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`, "utf8");
await writeFile(join(outdir, "build.txt"), "sns-routing-lab-v1\n", "utf8");
