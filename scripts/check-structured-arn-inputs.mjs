import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const servicesDirectory = new URL("../web/services/", import.meta.url);
const inventory = JSON.parse(await readFile(new URL("../docs/designs/structured-arn-input-inventory.json", import.meta.url), "utf8"));
const exclusions = new Set(inventory.exclusions.map(item => `${item.file}:${item.fieldName}`));
const files = (await readdir(servicesDirectory)).filter(name => name.endsWith(".js"));
const unresolved = [];
let single = 0; let multi = 0;

for (const name of files) {
  const relative = `web/services/${name}`;
  const source = await readFile(join(servicesDirectory.pathname, name), "utf8");
  const fields = source.matchAll(/<div class=["']field[^"']*["'][^>]*>\s*<label[^>]*>([^<]*(?:ARN|Arn|arn)[^<]*)<\/label>\s*<(input|select|textarea)\b([^>]*)>/g);
  for (const match of fields) {
    const [, label, tag, attributes] = match;
    if (/\breadonly\b/.test(attributes)) continue;
    const fieldName = attributes.match(/\bname=["']([^"']+)/)?.[1] ?? "";
    if (tag === "textarea") {
      if (/one per line|allowed source queue/i.test(label)) { multi++; continue; }
      if (exclusions.has(`${relative}:${fieldName}`)) continue;
      unresolved.push(`${relative}: textarea ${fieldName || "(unnamed)"} labelled ${label.trim()} needs a multi-value control or an inventory exclusion`);
    } else single++;
  }
}

for (const hook of ["web/app.js", "web/ui.js"]) {
  const source = await readFile(new URL(`../${hook}`, import.meta.url), "utf8");
  if (!source.includes("enhanceArnComboboxes")) unresolved.push(`${hook}: shared ARN enhancement hook is missing`);
}

if (unresolved.length) {
  console.error(unresolved.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Structured ARN inventory OK: ${single} single-value and ${multi} multi-value rendered fields use the shared enhancement path; ${inventory.exclusions.length} documented exclusions.`);
}
