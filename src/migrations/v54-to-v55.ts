import { createHash } from "node:crypto";
import type { S3AccessControlListState, SimState } from "../types.js";

function ownerId(accountId: string): string {
  // This migration must reproduce the legacy persisted S3 owner ID exactly.
  return createHash("sha256").update(`stacksim-s3-owner:${accountId}`).digest("hex");
}

function privateAcl(accountId: string): S3AccessControlListState {
  const id = ownerId(accountId);
  return {
    ownerId: id,
    ownerDisplayName: "Local AWS account",
    grants: [{ grantee: { type: "CanonicalUser", id, displayName: "Local AWS account" }, permission: "FULL_CONTROL" }],
  };
}

/** S3-05 adds durable ownership, ACL, Requester Pays, and ABAC defaults; account BPA remains absent until configured. */
export function migrateV54ToV55(input: SimState): SimState {
  const state = structuredClone(input);
  for (const [accountId, account] of Object.entries(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const bucket of Object.values(region.s3Buckets ?? {})) {
        bucket.objectOwnership ??= "BucketOwnerEnforced";
        bucket.acl ??= privateAcl(bucket.ownerAccountId ?? accountId);
        bucket.requestPayment ??= "BucketOwner";
        bucket.abacStatus ??= "Disabled";
      }
    }
  }
  state.schemaVersion = 55;
  return state;
}
