import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url)),
  out = join(root, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "assets"), { recursive: true });
await build({
  entryPoints: [join(root, "src", "main.jsx")],
  outfile: join(out, "assets", "app.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  minify: true,
  target: "es2022",
  define: {
    __SEARCH_API__: JSON.stringify(process.env.STACKSIM_API_BASE_URL || ""),
  },
});
await cp(join(root, "src", "styles.css"), join(out, "assets", "app.css"));
await writeFile(
  join(out, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f4f5f2"><meta name="description" content="Explore full-text search, filters and document indexing with StackSim's embedded OpenSearch."><title>Fieldwork · OpenSearch Lab</title><link rel="stylesheet" href="./assets/app.css"></head><body><a class="skip-link" href="#main">Skip to search</a><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>`,
);
