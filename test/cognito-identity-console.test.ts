import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityClient,
  CreateIdentityPoolCommand,
  SetIdentityPoolRolesCommand,
} from "@aws-sdk/client-cognito-identity";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function localJson(endpoint: string, path: string): Promise<any> {
  const response = await fetch(`${endpoint}${path}`, { headers: { "x-stacksim-region": region } });
  if (response.status !== 200) assert.fail(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

test("CID-01 Cognito Identity console serializers stay read-only and omit session material", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-console-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const identity = new CognitoIdentityClient({ endpoint, region, credentials });
    const iam = new IAMClient({ endpoint, region, credentials });
    clients.push(identity, iam);
    const created = await identity.send(new CreateIdentityPoolCommand({
      IdentityPoolName: "console-identities",
      AllowUnauthenticatedIdentities: false,
      IdentityPoolTags: { env: "console" },
    }));
    const poolId = created.IdentityPoolId!;
    await iam.send(new CreateRoleCommand({
      RoleName: "console-identity-auth",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: "cognito-identity.amazonaws.com" },
          Action: "sts:AssumeRoleWithWebIdentity",
        }],
      }),
    }));
    await identity.send(new SetIdentityPoolRolesCommand({
      IdentityPoolId: poolId,
      Roles: { authenticated: `arn:aws:iam::${accountId}:role/console-identity-auth` },
    }));

    const list = await localJson(endpoint, "/_stacksim/api/cognito-identity/identity-pools");
    assert.equal(list.identityPools.length, 1);
    assert.equal(list.identityPools[0].id, poolId);
    assert.equal(list.identityPools[0].name, "console-identities");
    const detail = await localJson(endpoint, `/_stacksim/api/cognito-identity/identity-pools/${encodeURIComponent(poolId)}`);
    assert.equal(detail.identityPool.IdentityPoolId, poolId);
    assert.equal(detail.identityPool.IdentityPoolName, "console-identities");
    assert.match(detail.identityPool.Arn, new RegExp(`identitypool/${poolId}$`));
    assert.ok(detail.identityPool.Roles.authenticated);
    const serialized = JSON.stringify([list, detail]);
    assert.doesNotMatch(serialized, /"SecretKey"|"SessionToken"|"password"|"privateKey"|"IdToken"|"AccessToken"/);
    assert.equal((await fetch(`${endpoint}/_stacksim/api/cognito-identity/identity-pools`, { method: "POST" })).status, 404);

    const summary = await localJson(endpoint, "/_stacksim/api/summary");
    assert.equal(summary.counts.cognitoIdentityPools, 1);
    const environment = await localJson(endpoint, "/_stacksim/api/environment");
    assert.equal(environment.services["cognito-identity"], "available");
    const health = await localJson(endpoint, "/_stacksim/health");
    assert.ok(health.services.includes("cognito-identity"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
