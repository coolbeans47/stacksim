import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { semanticCdkAssemblyDigests, sha256 } from "./support/artifact-snapshots.js";

function template(level: number, pretty: boolean): Buffer {
  const analytics = gzipSync(Buffer.from('{"constructs":["stable"]}'), { level }).toString("base64");
  return Buffer.from(JSON.stringify({
    Resources: {
      CDKMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: `v2:deflate64:${analytics}` } },
    },
  }, null, pretty ? 2 : undefined));
}

async function writeAssembly(root: string, level: number, pretty: boolean): Promise<Record<string, string>> {
  const primary = template(level, pretty);
  const sibling = template(level, !pretty);
  await writeFile(join(root, "Primary.template.json"), primary);
  await writeFile(join(root, "Sibling.template.json"), sibling);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    version: "test",
    artifacts: {
      Primary: { type: "aws:cloudformation:stack", properties: { templateFile: "Primary.template.json", stackTemplateAssetObjectUrl: `s3://assets/${sha256(primary)}.json` } },
      Sibling: { type: "aws:cloudformation:stack", properties: { templateFile: "Sibling.template.json", stackTemplateAssetObjectUrl: `s3://assets/${sha256(sibling)}.json` } },
    },
  }, null, pretty ? 2 : undefined));
  return semanticCdkAssemblyDigests(root, ["Primary.template.json"], ["manifest.json"]);
}

test("semantic CDK assembly snapshots ignore compressor and JSON serialization differences in every stack", async () => {
  const first = await mkdtemp(join(tmpdir(), "stacksim-artifact-low-"));
  const second = await mkdtemp(join(tmpdir(), "stacksim-artifact-high-"));
  try {
    const lowCompression = await writeAssembly(first, 1, false);
    const highCompression = await writeAssembly(second, 9, true);
    assert.notEqual(sha256(await readFile(join(first, "Primary.template.json"))), sha256(await readFile(join(second, "Primary.template.json"))), "the regression inputs must have different raw bytes");
    assert.deepEqual(lowCompression, highCompression);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});
