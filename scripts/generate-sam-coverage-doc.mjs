#!/usr/bin/env node
// Regenerates docs/sam-coverage.md from src/cloudformation/sam/coverage.ts.
// Usage: node --import tsx scripts/generate-sam-coverage-doc.mjs
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSamCoverageMarkdown } from "../src/cloudformation/sam/coverage-doc.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await writeFile(join(root, "docs", "sam-coverage.md"), renderSamCoverageMarkdown());
console.log("wrote docs/sam-coverage.md");
