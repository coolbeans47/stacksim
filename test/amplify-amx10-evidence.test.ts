import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalTextSha256 } from "./support/frozen-text.js";

const evidenceRoot = resolve("test/fixtures/amplify-gen2-data/evidence");

async function json(name: string): Promise<any> {
  return JSON.parse(await readFile(join(evidenceRoot, name), "utf8"));
}

function allTrue(value: any): boolean {
  return value && Object.entries(value).every(([key, item]) => key === "subscriptionErrors" ? item === 0 : typeof item === "object" ? allTrue(item) : item === true);
}

test("AMX-10 frozen evidence preserves prior milestones and proves pinned repeat reconciliation", async () => {
  const manifest = await json("amx10-update-manifest.json");
  for (const [name, digest] of Object.entries({ ...manifest.protectedEvidence, ...manifest.liveEvidence })) {
    assert.equal(canonicalTextSha256(await readFile(join(evidenceRoot, name))), digest, `${name} changed after AMX-10 freeze`);
  }

  const evidence = await json("amx10-repeat.json");
  assert.equal(evidence.result.code, 0);
  assert.equal(evidence.repeatResult.code, 0);
  assert.equal(evidence.repeatEvidence.classification, "pinned harmless reconciliation (the generated API-key expiry is time-relative)");
  assert.equal(evidence.repeatEvidence.physicalIdentityUnchanged, true);
  assert.equal(evidence.repeatEvidence.outputUnchanged, true);
  assert.equal(evidence.repeatEvidence.beforeOutputRedactedDigest, evidence.repeatEvidence.afterOutputRedactedDigest);
  assert.deepEqual(evidence.repeatEvidence.beforeIdentity.serviceCounts, { appsyncApis: 1, tables: 1, functions: 4 });
  assert.deepEqual(evidence.repeatEvidence.afterIdentity.serviceCounts, evidence.repeatEvidence.beforeIdentity.serviceCounts);
  assert.equal(evidence.reuse.descriptorUpdatedAtUnchanged, true);
  assert.equal(evidence.reuse.sharedAssetVersionsUnchanged, true);
  assert.ok(evidence.repeatEvidence.calls.some((call: any) => call.service === "cloudformation" && call.action === "UpdateStack" && call.resultClass === "success"));
});

test("AMX-10 frozen watch evidence proves hotswap/fallback, rejection, isolation, delete, and recreation", async () => {
  const evidence = await json("amx10-watch-edit.json");
  const scalar = evidence.watchEvidence;
  const directInvokes = scalar.calls.filter((call: any) => call.service === "lambda" && call.action === "Invoke");
  assert.equal(directInvokes.length, 2);
  assert.ok(directInvokes.every((call: any) => call.resultClass === "success"));
  assert.ok(scalar.calls.some((call: any) => call.service === "cloudformation" && call.action === "UpdateStack" && call.resultClass === "success"));
  assert.equal(scalar.cloudFormationTemplateDigestUnchanged, true, "direct bucket-deployment calls do not rewrite the root template");
  assert.deepEqual(scalar.drift, {}, "the later full deployment reconciles current drift");
  assert.equal(scalar.operations.length, 2);
  assert.ok(scalar.operations.every((operation: any) => operation.action === "Invoke" && operation.status === "INTENTIONAL" && /^[a-f0-9]{64}$/.test(operation.requestPayloadSha256) && operation.currentServiceRevision !== operation.priorServiceRevision));

  const beforeTables = scalar.beforeGraph.flatMap((stack: any) => stack.resources).filter((resource: any) => resource.type === "Custom::AmplifyDynamoDBTable").map((resource: any) => resource.physicalId);
  const afterTables = scalar.afterGraph.flatMap((stack: any) => stack.resources).filter((resource: any) => resource.type === "Custom::AmplifyDynamoDBTable").map((resource: any) => resource.physicalId);
  assert.deepEqual(afterTables, beforeTables, "supported scalar edits preserve the Todo table physical identity");

  assert.ok(evidence.watchEvidence.apiKeyEdit.calls.some((call: any) => call.service === "cloudformation" && call.action === "UpdateStack" && call.resultClass === "success"));
  assert.equal(evidence.watchEvidence.apiKeyEdit.calls.some((call: any) => call.service === "appsync"), false, "the pinned source corpus emitted no direct AppSync call");

  const unsupported = evidence.watchEvidence.unsupportedEdit;
  assert.equal(unsupported.classification, "synthesis rejection before direct mutation");
  assert.equal(unsupported.diagnosticObserved, true);
  assert.match(unsupported.diagnostic, /unsupportedScalar is not a function/);
  assert.equal(unsupported.calls.some((call: any) => ["appsync", "lambda", "cloudformation"].includes(call.service)), false);
  assert.equal(unsupported.backendUnchanged, true);
  assert.equal(unsupported.outputUnchanged, true);
  assert.equal(allTrue(unsupported.priorOutputClientUse), true);

  assert.equal(evidence.secondIdentifierResult.code, 0);
  assert.equal(evidence.deletion.command, "sandbox delete --identifier amx10a --yes");
  assert.equal(evidence.deletion.cliResult.code, 0);
  assert.equal(evidence.deletion.rootStatus, "DELETE_COMPLETE");
  assert.equal(evidence.deletion.ownedChildStacksRemaining, 0);
  assert.equal(evidence.deletion.bootstrapPreserved, true);
  assert.equal(evidence.deletion.unrelatedStackPreserved, true);
  assert.equal(evidence.deletion.secondIdentifierPreserved, true);
  assert.equal(evidence.deletion.staleOutputRejected, true);
  assert.equal(evidence.deletion.recreation.result.code, 0);
  assert.equal(evidence.deletion.recreation.rootIdentityChanged, true);
  assert.notEqual(evidence.deletion.recreation.oldRootStackId, evidence.deletion.recreation.newRootStackId);
  assert.equal(allTrue(evidence.deletion.recreation.clientUse), true);
  assert.equal(evidence.deletion.recreation.cleanup.code, 0);

  assert.doesNotMatch(JSON.stringify(evidence), /ASIA[0-9A-Z]{16}|X-Amz-Security-Token|"secretAccessKey"|"sessionToken"|"PolicyDocument"/i);
});
