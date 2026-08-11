import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolCommand,
  InvalidParameterException,
  ListUserPoolsCommand,
  paginateListUserPools,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function client(simulator: StackSim, region: string): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region, credentials });
}

test("Cognito control state paginates, isolates Regions, rejects inert features, and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-core-"));
  const options = { port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off" as const };
  let simulator = new StackSim(options);
  let west = client(simulator, "eu-west-1");
  let east = client(simulator, "us-east-1");
  try {
    await simulator.start();
    west.destroy();
    east.destroy();
    west = client(simulator, "eu-west-1");
    east = client(simulator, "us-east-1");

    const names = ["alpha", "bravo", "charlie"];
    const ids: string[] = [];
    for (const PoolName of names) {
      const result = await west.send(new CreateUserPoolCommand({ PoolName }));
      ids.push(result.UserPool!.Id!);
    }

    const page1 = await west.send(new ListUserPoolsCommand({ MaxResults: 2 }));
    assert.deepEqual(page1.UserPools?.map(pool => pool.Name), ["alpha", "bravo"]);
    assert(page1.NextToken);
    const page2 = await west.send(new ListUserPoolsCommand({ MaxResults: 2, NextToken: page1.NextToken }));
    assert.deepEqual(page2.UserPools?.map(pool => pool.Name), ["charlie"]);

    const paginatorNames: string[] = [];
    for await (const page of paginateListUserPools({ client: west, pageSize: 1 }, { MaxResults: 1 })) {
      paginatorNames.push(...(page.UserPools ?? []).map(pool => pool.Name!));
    }
    assert.deepEqual(paginatorNames, names);

    assert.deepEqual((await east.send(new ListUserPoolsCommand({ MaxResults: 60 }))).UserPools, []);
    const eastPool = await east.send(new CreateUserPoolCommand({ PoolName: "alpha" }));
    assert.match(eastPool.UserPool?.Id ?? "", /^us-east-1_/);
    await assert.rejects(
      east.send(new DescribeUserPoolCommand({ UserPoolId: ids[0] })),
      /User pool not found|UserPoolId is invalid/,
    );

    const triggerPool = await west.send(new CreateUserPoolCommand({
      PoolName: "lambda-trigger",
      LambdaConfig: { PreSignUp: "arn:aws:lambda:eu-west-1:000000000000:function:trigger" },
    }));
    assert.equal(
      (await west.send(new DescribeUserPoolCommand({ UserPoolId: triggerPool.UserPool!.Id! })))
        .UserPool?.LambdaConfig?.PreSignUp,
      "arn:aws:lambda:eu-west-1:000000000000:function:trigger",
    );
    assert.equal((await west.send(new ListUserPoolsCommand({ MaxResults: 60 }))).UserPools?.length, 4);

    await assert.rejects(
      west.send(new CreateUserPoolClientCommand({
        UserPoolId: ids[0],
        ClientName: "implicit-unsupported-defaults",
      })),
      (error: unknown) => error instanceof InvalidParameterException && /ExplicitAuthFlows/.test(error.message),
    );
    await assert.rejects(
      west.send(new CreateUserPoolClientCommand({
        UserPoolId: ids[0],
        ClientName: "mutually-exclusive-secret",
        GenerateSecret: true,
        ClientSecret: "CallerSuppliedSecret_12345",
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      })),
      (error: unknown) => error instanceof InvalidParameterException && /mutually exclusive/.test(error.message),
    );

    west.destroy();
    east.destroy();
    await simulator.stop();
    simulator = new StackSim(options);
    await simulator.start();
    west = client(simulator, "eu-west-1");
    east = client(simulator, "us-east-1");
    const afterRestart = await west.send(new DescribeUserPoolCommand({ UserPoolId: ids[1] }));
    assert.equal(afterRestart.UserPool?.Name, "bravo");
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(simulator.store.regionState("eu-west-1").cognito.pools[ids[1]].name, "bravo");
    assert.equal(Object.keys(simulator.store.regionState("us-east-1").cognito.pools).length, 1);
  } finally {
    west.destroy();
    east.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
