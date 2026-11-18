import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { expressCreate } = await import(pathToFileURL(join(process.cwd(), "web/services/opensearch-serverless-express.js")).href);

test("Express Create resumes partial setup, detects policy collisions and preserves shared groups", async () => {
  const records = new Map<string, any>(), calls: string[] = []; let interrupted = true;
  const api = async (action: string, input: any): Promise<any> => {
    calls.push(action);
    if (action === "BatchGetCollectionGroup") return { collectionGroupDetails: records.has("group") ? [records.get("group")] : [] };
    if (action === "ListCollections") return { collectionSummaries: [] };
    if (action === "CreateCollectionGroup") { records.set("group", { ...input, id: "group", arn: "arn:local" }); return { createCollectionGroupDetail: records.get("group") }; }
    const key = `${input.type}:${input.name}`;
    if (action.startsWith("Get")) { if (!records.has(key)) throw Object.assign(new Error("missing"), { code: "ResourceNotFoundException" }); return { [action.includes("Access") ? "accessPolicyDetail" : "securityPolicyDetail"]: records.get(key) }; }
    if (action === "CreateAccessPolicy" && interrupted) { interrupted = false; throw new Error("network interrupted"); }
    if (action.endsWith("Policy")) { records.set(key, { ...input, policy: JSON.parse(input.policy) }); return {}; }
    if (action === "CreateCollection") return { createCollectionDetail: { id: "collection", ...input } };
    throw new Error(`Unexpected ${action}`);
  };
  const input = { name: "sample", type: "SEARCH", principal: "arn:aws:iam::000000000000:user/test", description: "", tags: [] };
  await assert.rejects(expressCreate(api, input, "stable"), /interrupted/);
  assert.equal(records.get('group').standbyReplicas, 'DISABLED');
  assert.equal(records.size, 3); const snapshot = structuredClone(records);
  const created = await expressCreate(api, input, "stable"); assert.equal(created.createCollectionDetail.collectionGroupName, "nextgen-sample"); assert.equal(created.createCollectionDetail.clientToken, "stable-collection");
  assert.equal(calls.filter(action => action === "CreateCollectionGroup").length, 1); assert.equal(calls.filter(action => action === "CreateSecurityPolicy").length, 2); assert.equal(calls.some(action => action.startsWith("Delete") || action.startsWith("Update")), false);
  for (const [key, value] of snapshot) assert.deepEqual(records.get(key), value);
  await assert.rejects(expressCreate(api, { ...input, principal: "arn:aws:iam::000000000000:user/other" }, "stable"), /differs/);
  records.get("group").generation = "CLASSIC";
  await assert.rejects(expressCreate(api, input, "stable"), /NextGen/);
});
