import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "table-v2");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const expectedDigest = "46c21292641b52550e187bc859513f56ad464f84af694456cf9b3eb7d9933cba";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function digest(value: unknown): { bytes: number; sha256: string } {
  const body = JSON.stringify(canonical(value));
  return { bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
}

test("CFN-18 portable TableV2 fixture matches the frozen provenance resource without network access", { timeout: 180_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "stacksim-cdk-table-v2-"));
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete inherited[key];
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    AWS_ACCESS_KEY_ID: "admin", AWS_SECRET_ACCESS_KEY: "password", AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1", AWS_EC2_METADATA_DISABLED: "true", AWS_MAX_ATTEMPTS: "1",
    CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: "eu-west-1", CDK_DISABLE_CLI_TELEMETRY: "true", CDK_DISABLE_VERSION_CHECK: "true", JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [cdkCli, "--output", output, "synth", "--quiet"], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk))); child.once("error", reject); child.once("close", code => resolveResult({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    assert.equal(result.code, 0, `cdk synth failed\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /STACKSIM_NETWORK_TRIPWIRE/);
    const template = JSON.parse(await readFile(join(output, "TableV2Fixture.template.json"), "utf8"));
    const resources = Object.values(template.Resources).filter((resource: any) => resource.Type === "AWS::DynamoDB::GlobalTable") as any[];
    assert.equal(resources.length, 1);
    const synthesized = { Type: resources[0].Type, Properties: resources[0].Properties };
    const provenance = JSON.parse(await readFile(join(fixture, "provenance-resource.json"), "utf8"));
    assert.deepEqual(synthesized, provenance);
    assert.deepEqual(digest(synthesized), { bytes: 1546, sha256: expectedDigest });
  } finally { await rm(output, { recursive: true, force: true }); }
});
