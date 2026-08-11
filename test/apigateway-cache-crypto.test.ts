import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiGatewayCacheCrypto, ApiGatewayCacheSecurityError, type ApiGatewayCacheBinding } from "../src/apigateway-cache-crypto.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";

const binding: ApiGatewayCacheBinding = { accountId: "000000000000", region: "eu-west-1", apiId: "api-1", stageName: "dev", cacheKey: "a".repeat(64), deploymentId: "deployment-1", method: "GET", namespace: "items" };
const response = { status: 200, body: Buffer.from('{"secret":"body-secret-dug-02"}').toString("base64"), headers: { "content-type": "application/json", "x-secret": "header-secret-dug-02" } };

test("API Gateway cache crypto authenticates bindings, copied state, tampering, missing keys, and rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-cache-crypto-")); const otherRoot = await mkdtemp(join(tmpdir(), "stacksim-apig-cache-wrong-")); const missingRoot = await mkdtemp(join(tmpdir(), "stacksim-apig-cache-missing-"));
  try {
    const crypto = new ApiGatewayCacheCrypto(root); await crypto.start(false); const envelope = crypto.encrypt(response, binding); assert.deepEqual(crypto.decrypt(envelope, binding), { response, needsRotation: false }); const serialized = JSON.stringify(envelope); assert.ok(!serialized.includes("body-secret-dug-02")); assert.ok(!serialized.includes(response.body)); assert.ok(!serialized.includes("header-secret-dug-02"));
    assert.throws(() => crypto.decrypt(envelope, { ...binding, cacheKey: "b".repeat(64) }), ApiGatewayCacheSecurityError, "swapped entries and AAD mismatches fail closed"); const tampered = structuredClone(envelope); tampered.authTag = `${tampered.authTag[0] === "A" ? "B" : "A"}${tampered.authTag.slice(1)}`; assert.throws(() => crypto.decrypt(tampered, binding), ApiGatewayCacheSecurityError);
    const oldKeyId = envelope.keyId; const rotatedKeyId = await crypto.rotate(); assert.notEqual(rotatedKeyId, oldKeyId); assert.equal(crypto.decrypt(envelope, binding).needsRotation, true); const rotatedEnvelope = crypto.encrypt(response, binding); assert.equal(rotatedEnvelope.keyId, rotatedKeyId); assert.equal(crypto.decrypt(rotatedEnvelope, binding).needsRotation, false); const keyring = await readFile(crypto.keyringFile, "utf8"); assert.match(keyring, new RegExp(oldKeyId)); assert.match(keyring, new RegExp(rotatedKeyId));
    const wrong = new ApiGatewayCacheCrypto(otherRoot); await wrong.start(false); assert.throws(() => wrong.decrypt(envelope, binding), ApiGatewayCacheSecurityError, "a copied state envelope without its keyring is unusable"); const missing = new ApiGatewayCacheCrypto(missingRoot); await missing.start(true); assert.throws(() => missing.decrypt(envelope, binding), ApiGatewayCacheSecurityError); await assert.rejects(readFile(missing.keyringFile), (error: any) => error.code === "ENOENT", "encrypted-state evidence must prevent silent replacement-key creation");
  } finally { await rm(root, { recursive: true, force: true }); await rm(otherRoot, { recursive: true, force: true }); await rm(missingRoot, { recursive: true, force: true }); }
});

test("schema 73 flushes falsely encrypted legacy cache entries and preserves explicit plaintext entries", () => {
  const state = emptyState("000000000000", "eu-west-1") as any; state.schemaVersion = 72; const caches = state.accounts["000000000000"].regions["eu-west-1"].apiGatewayResponseCaches; caches["api\0dev"] = { entries: { encrypted: { status: 200, body: "c2VjcmV0", headers: { secret: "visible" }, expiresAt: 2, deploymentId: "d", method: "GET", namespace: "n", encrypted: true }, plain: { status: 201, body: "b2s=", headers: { value: "plain" }, expiresAt: 3, deploymentId: "d", method: "GET", namespace: "n", encrypted: false } } };
  const migrated = migrateState(state, "000000000000", "eu-west-1").state as any; assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION); assert.equal(migrated.accounts["000000000000"].regions["eu-west-1"].apiGatewayResponseCaches["api\0dev"].entries.encrypted, undefined); assert.deepEqual(migrated.accounts["000000000000"].regions["eu-west-1"].apiGatewayResponseCaches["api\0dev"].entries.plain, { expiresAt: 3, deploymentId: "d", method: "GET", namespace: "n", encrypted: false, response: { status: 201, body: "b2s=", headers: { value: "plain" } } });
});
