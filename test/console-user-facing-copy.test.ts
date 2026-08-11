import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const requirementId = /\b(?:SFN|FND|DUG|APS|APPSYNC|AMX|CFN|LAM|DDB|APIG|CWLI|CW|S3|SQS|SNS|SES|EVB|COG|RDS|PSS|SSM)-[A-Z0-9]+\b/g;

test("user-facing console source does not expose internal design requirement IDs", async () => {
  const root = join(process.cwd(), "web");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const findings: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:html|js)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(requirementId)) findings.push(`${relative(root, path)}: ${match[0]}`);
  }
  assert.deepEqual(findings, []);
});
