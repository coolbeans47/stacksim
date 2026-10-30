import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sdk from "@aws-sdk/client-cognito-identity-provider";
import * as identitySdk from "@aws-sdk/client-cognito-identity";
import { COGNITO_ACTION_INVENTORY, COGNITO_POST_SDK_PIN_OPERATIONS } from "../src/cognito/action-inventory.js";
import { COGNITO_IDENTITY_ACTION_INVENTORY } from "../src/cognito-identity/action-inventory.js";
import { StackSim } from "../src/server.js";

const commands = (module: Record<string, unknown>) => Object.keys(module)
  .filter(name => name.endsWith("Command") && name !== "$Command")
  .map(name => name.slice(0, -"Command".length))
  .sort();

test("the user-pools inventory equals the pinned SDK commands plus the post-pin API actions, and every entry reaches the service", async () => {
  const pinned = commands(sdk);
  assert.equal(pinned.length, 128);
  for (const operation of COGNITO_POST_SDK_PIN_OPERATIONS) {
    assert.equal(pinned.includes(operation), false, `${operation} is in the pinned SDK; move it out of the post-pin list`);
  }
  assert.deepEqual([...COGNITO_ACTION_INVENTORY.keys()].sort(), [...pinned, ...COGNITO_POST_SDK_PIN_OPERATIONS].sort());
  assert.equal(COGNITO_ACTION_INVENTORY.size, 132, "the current API reference lists 132 actions");

  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-inventory-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off", cdkBootstrap: false });
  await simulator.start();
  const call = async (target: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${simulator.port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": target,
        authorization: "AWS4-HMAC-SHA256 Credential=admin/20261030/eu-west-1/cognito-idp/aws4_request, SignedHeaders=host, Signature=0",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { __type?: string; message?: string } };
  };
  try {
    for (const operation of COGNITO_ACTION_INVENTORY.keys()) {
      const result = await call(`AWSCognitoIdentityProviderService.${operation}`, { UserPoolId: "eu-west-1_missing00", ClientId: "missing" });
      assert.notEqual(result.body.__type, "UnknownOperationException", operation);
      assert.doesNotMatch(String(result.body.message), /Unknown service route|COG-\d|CID-\d|later Cognito phase/, operation);
    }
    for (const operation of COGNITO_POST_SDK_PIN_OPERATIONS) {
      const result = await call(`AWSCognitoIdentityProviderService.${operation}`, { UserPoolId: "eu-west-1_missing00", Username: "user", ClientId: "abc", Secret: "x".repeat(24), TermsName: "terms-of-use" });
      assert.equal(result.status, 400, operation);
      assert.equal(result.body.__type, "InvalidParameterException", operation);
      assert.match(String(result.body.message), /not implemented in this simulator/, operation);
    }
    const unknown = await call("AWSCognitoIdentityProviderService.NoSuchOperation");
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.__type, "UnknownOperationException");
  } finally {
    await simulator.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("the identity-pools inventory equals the pinned SDK commands", () => {
  assert.deepEqual([...COGNITO_IDENTITY_ACTION_INVENTORY.keys()].sort(), commands(identitySdk).filter(name => name !== "CognitoIdentityServiceException"));
});
