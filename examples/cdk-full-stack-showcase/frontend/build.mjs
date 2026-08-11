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

function localUrl(value) {
  const candidate = String(value || "http://127.0.0.1:4567/aurora-demo/prod").trim();
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("STACKSIM_API_BASE_URL must be an HTTP(S) URL without embedded credentials");
  }
  return candidate.replace(/\/+$/, "");
}

function demoCredential(name, value, fallback) {
  const candidate = String(value || fallback).trim();
  if (!candidate || candidate.length > 256 || /[\r\n]/.test(candidate)) {
    throw new Error(`${name} must be a non-empty single-line demo value no longer than 256 characters`);
  }
  return candidate;
}

const apiBaseUrl = localUrl(process.env.STACKSIM_API_BASE_URL);
const demoApiKey = demoCredential("AURORA_DEMO_API_KEY", process.env.AURORA_DEMO_API_KEY, "AuroraAtlasLocalKey2026");
const demoToken = demoCredential("AURORA_DEMO_TOKEN", process.env.AURORA_DEMO_TOKEN, "aurora-demo");

await rm(outdir, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

const sourceCss = await readFile(join(source, "styles.css"), "utf8");
const processedCss = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(sourceCss, {
  from: join(source, "styles.css"),
  to: join(assets, "app.css"),
});
const minifiedCss = await transform(processedCss.css, {
  charset: "utf8",
  legalComments: "none",
  loader: "css",
  minify: true,
  target: "es2020",
});
await writeFile(join(assets, "app.css"), minifiedCss.code, "utf8");

await build({
  absWorkingDir: root,
  bundle: true,
  charset: "utf8",
  define: {
    __AURORA_DEMO_API_KEY__: JSON.stringify(demoApiKey),
    __AURORA_DEMO_TOKEN__: JSON.stringify(demoToken),
    __STACKSIM_API_BASE_URL__: JSON.stringify(apiBaseUrl),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  entryNames: "assets/app",
  entryPoints: [join(source, "main.jsx")],
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

await writeFile(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#050812" />
    <meta name="description" content="Aurora Atlas — an interactive full-stack observatory powered by stacksim." />
    <title>Aurora Atlas · stacksim</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23050812'/%3E%3Ccircle cx='32' cy='32' r='7' fill='%237cf6c8'/%3E%3Cpath d='M10,32C20,17,44,17,54,32C44,47,20,47,10,32Z' fill='none' stroke='%2368d9ff' stroke-width='4'/%3E%3C/svg%3E" />
    <link rel="stylesheet" href="./assets/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to observatory</a>
    <div id="root"></div>
    <script type="module" src="./assets/app.js"></script>
  </body>
</html>
`, "utf8");

await writeFile(join(outdir, "build.txt"), "aurora-atlas-showcase-v1\n", "utf8");
