import autoprefixer from "autoprefixer";
import { build, transform } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "src");
const outdir = join(root, "dist");
const assets = join(outdir, "assets");
const require = createRequire(import.meta.url);
const tailwindConfig = require("./tailwind.config.cjs");
let runtime;
try {
  runtime = process.env.SPRINT_PLANNER_RUNTIME
    ? JSON.parse(process.env.SPRINT_PLANNER_RUNTIME)
    : JSON.parse(await readFile(join(root, "..", ".runtime", "frontend-runtime.json"), "utf8"));
} catch {
  runtime = {
    schemaVersion: 1,
    region: "eu-west-1",
    cognitoEndpoint: "http://127.0.0.1:4566",
    userPoolId: "eu-west-1_pending00",
    appClientId: "pendingpublicclient",
    issuer: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_pending00",
    apiBaseUrl: "http://127.0.0.1:4567/pending",
    websocketUrl: "ws://127.0.0.1:4567/pending/live",
  };
}
const exact = ["schemaVersion", "region", "cognitoEndpoint", "userPoolId", "appClientId", "issuer", "apiBaseUrl", "websocketUrl"];
if (!runtime || runtime.schemaVersion !== 1 || Object.keys(runtime).some(key => !exact.includes(key))) {
  throw new Error("Sprint Planner public runtime configuration is invalid");
}
if (Object.keys(runtime).some(key => /secret|password|token|credential/i.test(key))) {
  throw new Error("Secret-like runtime configuration is forbidden");
}
await rm(outdir, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
const css = await readFile(join(source, "styles.css"), "utf8");
const processed = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(css, {
  from: join(source, "styles.css"),
  to: join(assets, "app.css"),
});
const minified = await transform(processed.css, { loader: "css", minify: true, target: "es2020" });
await writeFile(join(assets, "app.css"), minified.code);
await build({
  absWorkingDir: root,
  bundle: true,
  define: {
    __SPRINT_PLANNER_RUNTIME__: JSON.stringify(runtime),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  entryNames: "assets/app",
  entryPoints: [join(source, "main.tsx")],
  format: "esm",
  jsx: "automatic",
  legalComments: "none",
  minify: true,
  outdir,
  platform: "browser",
  sourcemap: false,
  target: ["es2020"],
});
await writeFile(join(outdir, "runtime-config.json"), `${JSON.stringify(runtime, null, 2)}\n`);
await writeFile(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f8f7f4" />
    <meta name="description" content="Sprint Planner — a collaborative team board powered by stacksim." />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://127.0.0.1:* https://127.0.0.1:* http://localhost:* https://localhost:* http://[::1]:* https://[::1]:* ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://[::1]:* wss://[::1]:*; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" />
    <title>Sprint Planner · Northstar Product</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%234f46e5'/%3E%3Cpath d='M18 19h28M18 32h18M18 45h24' stroke='white' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E" />
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to sprint board</a>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`);
await writeFile(join(outdir, "build.txt"), "sprint-planner-v1\n");
