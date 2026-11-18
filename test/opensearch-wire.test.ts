import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import { StackSim } from "../src/server.js";

class Sha256 {
  private hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(private readonly secret?: any) { this.hash = secret ? createHmac("sha256", secret) : createHash("sha256"); }
  update(data: any) { this.hash.update(data); }
  async digest() { return this.hash.digest(); }
  reset() { this.hash = this.secret ? createHmac("sha256", this.secret) : createHash("sha256"); }
}
const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("OS-01/02 signed wire protocol: bodies, gzip, HEAD, invalid signatures, shared admission and no rejected writes", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-wire-")); const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  try {
    await sim.start(); const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const call = async (endpoint: string, method: string, path: string, body = Buffer.alloc(0), extra: Record<string, string> = {}, sign: { region?: string; service?: string; tamper?: boolean } = {}) => {
      const url = new URL(path, endpoint);
      const signer = new SignatureV4({ credentials, region: sign.region ?? region, service: sign.service ?? "es", sha256: Sha256 });
      const signed = await signer.sign({ method, protocol: url.protocol, hostname: url.hostname, port: Number(url.port), path: url.pathname, query: Object.fromEntries([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])), headers: { host: url.host, "content-type": "application/json", "content-length": String(body.length), ...extra }, body });
      if (sign.tamper) signed.headers.authorization = signed.headers.authorization.replace(/Signature=./, "Signature=z");
      return new Promise<{ status: number; text: string; headers: any }>((resolve, reject) => {
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers: signed.headers, ca }, res => {
          const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
        });
        req.on("error", reject); req.end(body);
      });
    };
    const cp = `http://127.0.0.1:${sim.port}`;
    const created = await call(cp, "POST", "/2021-01-01/opensearch/domain", Buffer.from('{"DomainName":"wire-domain"}'));
    assert.equal(created.status, 200); assert.ok(created.headers["x-amzn-requestid"]);
    for (let i = 0; i < 100 && sim.opensearch.domain(region, "wire-domain").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "wire-domain"); assert.equal(domain.state, "active"); const endpoint = `https://127.0.0.1:${domain.gatewayPort}`;
    const bulk = gzipSync(Buffer.from('{"index":{"_index":"products","_id":"one"}}\n{"title":"Signed compressed request"}\n'));
    assert.equal((await call(endpoint, "POST", "/_bulk?refresh=true", bulk, { "content-encoding": "gzip", "content-type": "application/x-ndjson" })).status, 200);
    const search = await call(endpoint, "GET", "/products/_search", Buffer.from('{"query":{"match":{"title":"compressed"}}}'));
    assert.equal(search.status, 200); assert.equal(JSON.parse(search.text).hits.total.value, 1);
    const head = await call(endpoint, "HEAD", "/products/_doc/one"); assert.equal(head.status, 200); assert.equal(head.text, "");
    assert.equal((await call(endpoint, "HEAD", "/products/_doc/missing")).status, 404);
    for (const signing of [{ region: "us-east-1" }, { service: "aoss" }, { tamper: true }]) {
      assert.ok((await call(endpoint, "PUT", "/products/_doc/rejected", Buffer.from('{"title":"denied"}'), {}, signing)).status >= 400);
    }
    const malformed = await call(endpoint, "PUT", "/products/_doc/rejected", Buffer.from("bad gzip"), { "content-encoding": "gzip" }); assert.equal(malformed.status, 400);
    const oversized = await call(endpoint, "PUT", "/products/_doc/rejected", gzipSync(Buffer.from(JSON.stringify({ title: "x".repeat(10 * 1024 * 1024) }))), { "content-encoding": "gzip" }); assert.equal(oversized.status, 413);
    assert.equal((await call(endpoint, "GET", "/products/_doc/rejected")).status, 404);
    assert.equal((await call(endpoint, "PUT", "/products/_doc/ambiguous/extra", Buffer.from('{"title":"denied"}'))).status, 400);
    assert.equal((await call(endpoint, "GET", "/products/_doc/ambiguous")).status, 404);
    assert.equal((await call(endpoint, "POST", "/products/_search?size=1&size=2", Buffer.from("{}"))).status, 400);
    const local = (method: string, path: string, body: any = {}) => call(cp, "POST", "/_stacksim/api/opensearch/domains/wire-domain/query", Buffer.from(JSON.stringify({ method, path, body })));
    assert.equal(JSON.parse((await local("POST", "/products/_count")).text).count, 1);
    await call(endpoint, "PUT", "/products/_settings", Buffer.from('{"index":{"refresh_interval":"5s"}}'));
    const inflight = Array.from({ length: 16 }, (_, i) => local("PUT", `/products/_doc/concurrent-${i}?refresh=wait_for`, { title: `concurrent ${i}` }));
    // Observe the actual service admission boundary while writes wait for refresh.
    for (let i = 0; i < 200 && (sim.opensearch as any).requests.get(domain.generation) !== 16; i++) await delay(10);
    assert.equal((sim.opensearch as any).requests.get(domain.generation), 16);
    assert.equal((await call(endpoint, "PUT", "/products/_doc/overflow", Buffer.from('{"title":"rejected"}'))).status, 429);
    assert.equal((await local("PUT", "/products/_doc/overflow", { title: "rejected" })).status, 429);
    const completed = await Promise.all(inflight); assert.ok(completed.every(result => result.status === 201));
    assert.equal((await call(endpoint, "GET", "/products/_doc/overflow")).status, 404);
    assert.equal(JSON.parse((await local("POST", "/products/_count")).text).count, 17);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
