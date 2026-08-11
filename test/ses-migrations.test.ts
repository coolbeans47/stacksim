import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";

test("SES migrations add private signing and regional catalogs without disturbing existing state", () => {
  const accountId = "000000000000";
  const region = "eu-west-1";
  const legacy = emptyState(accountId, region);
  legacy.schemaVersion = 50;
  delete (legacy.installation as any).sesSigningSecret;
  delete (legacy.accounts[accountId].regions[region] as any).ses;
  (legacy.accounts[accountId].regions[region] as any).ssmParameters = {
    "/preserved": { name: "/preserved", type: "String", value: "yes", version: 1, lastModifiedDate: 1 },
  } as any;

  const migrated = migrateState(legacy, accountId, region);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.match(migrated.state.installation.sesSigningSecret, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(migrated.state.installation.sesSigningSecret, "base64").byteLength, 32);
  assert.deepEqual(migrated.state.accounts[accountId].regions[region].ses, {
    controlRevision: 0,
    account: {
      accessProfile: "PRODUCTION",
      productionAccessEnabled: true,
      sendingEnabled: true,
      max24HourSend: 50_000,
      maxSendRate: 14,
      suppressionReasons: ["BOUNCE", "COMPLAINT"],
    },
    identities: {},
    verificationIntents: {},
    callbackResults: {},
    templates: {},
    configurationSets: {},
    customVerificationTemplates: {},
    contactLists: {},
    suppressedDestinations: {},
    localCallbacks: {},
  });
  assert.equal((migrated.state.accounts[accountId].regions[region] as any).ssmParameters["/preserved"].value, "yes");

  const idempotent = migrateState(migrated.state, accountId, region);
  assert.equal(idempotent.migrated, false);
  assert.equal(idempotent.state.installation.sesSigningSecret, migrated.state.installation.sesSigningSecret);
});
