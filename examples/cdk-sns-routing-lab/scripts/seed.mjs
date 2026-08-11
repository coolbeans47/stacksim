import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = resolve(projectRoot, process.env.SNS_ROUTING_DEPLOYMENT_FILE || ".runtime/deployment.json");

async function main() {
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${deploymentPath}. Run npm run deploy first. ${error.message}`);
  }
  const response = await fetch(`${deployment.apiBaseUrl}/demo/seed`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : {};
  if (!response.ok) throw new Error(`Seed failed with HTTP ${response.status}: ${body.error || raw}`);
  console.log(`[signal-relay] seed complete: ${body.written} published, ${body.total} total`);
}

main().catch((error) => {
  console.error(`[signal-relay] seed failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
