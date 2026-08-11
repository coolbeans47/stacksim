import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { policyDocumentValidationError, policyValidationReport } from "../src/iam/policy-validation.js";
import { StackSim } from "../src/server.js";

test("IAMGAP-21 local validation produces stable read-only summaries for every editor policy kind", async () => {
  const identity = { Version: "2012-10-17", Statement: [{ Effect: "Allow" as const, Action: ["s3:GetObject", "s3:*"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "eu-west-1" } } }] };
  const report = policyValidationReport(identity, "identity"); assert.equal(report.valid, true); assert.deepEqual(report.warnings, ["Policy contains wildcard actions.", "Policy contains wildcard resources."]); assert.deepEqual(report.summary[0], { effect: "Allow", service: "s3", actions: ["s3:*", "s3:GetObject"], resources: ["*"], conditions: ["StringEquals:aws:RequestedRegion"] });
  const trust = { Version: "2012-10-17", Statement: { Effect: "Allow" as const, Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" } }; assert.equal(policyValidationReport(trust, "trust").valid, true);
  const invalid = { Version: "2012-10-17", Statement: [{ Effect: "Allow" as const, Action: "s3:GetObject", Resource: "*", Condition: { MadeUp: { key: "value" } } }] }; const invalidReport = policyValidationReport(invalid, "session"); assert.deepEqual(invalidReport.errors, [policyDocumentValidationError(invalid, "session")]);

  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap21-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: true });
  try {
    await simulator.start(); const before = JSON.stringify(simulator.store.state); const response = await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/iam/policy-validation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Kind: "identity", PolicyDocument: identity }) }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), report); assert.equal(JSON.stringify(simulator.store.state), before);
    const badKind = await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/iam/policy-validation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Kind: "resource", PolicyDocument: identity }) }); assert.equal(badKind.status, 400);
  } finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
