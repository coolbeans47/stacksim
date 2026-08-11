import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateDataSourceCommand,
  CreateGraphqlApiCommand,
  CreateFunctionCommand,
  DeleteGraphqlApiCommand,
  GetGraphqlApiCommand,
  ListGraphqlApisCommand,
  UpdateGraphqlApiCommand,
} from "@aws-sdk/client-appsync";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("APS-P0-002 and APS-P0-004 control actions use exact AppSync IAM targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-iam-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: false,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const admin = new AppSyncClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    clients.push(admin, iam, sts);
    const allowed = (await admin.send(new CreateGraphqlApiCommand({
      name: "allowed",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    const denied = (await admin.send(new CreateGraphqlApiCommand({
      name: "denied",
      authenticationType: "API_KEY",
    }))).graphqlApi!;

    const roleName = "appsync-scoped";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${accountId}:root` },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "appsync-exact-api",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "appsync:ListGraphqlApis", Resource: "*" },
          {
            Effect: "Allow",
            Action: ["appsync:GetGraphqlApi", "appsync:UpdateGraphqlApi"],
            Resource: allowed.arn,
          },
          {
            Effect: "Allow",
            Action: ["appsync:CreateApiKey", "appsync:CreateDataSource"],
            Resource: allowed.arn,
          },
        ],
      }),
    }));
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "appsync-session",
    }));
    const scoped = new AppSyncClient({
      endpoint,
      region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
    });
    clients.push(scoped);

    assert.equal((await scoped.send(new ListGraphqlApisCommand({}))).graphqlApis?.length, 2);
    assert.equal((await scoped.send(new GetGraphqlApiCommand({ apiId: allowed.apiId }))).graphqlApi?.apiId, allowed.apiId);
    await scoped.send(new UpdateGraphqlApiCommand({
      apiId: allowed.apiId,
      name: "allowed-updated",
      authenticationType: "API_KEY",
    }));
    await assert.rejects(
      scoped.send(new GetGraphqlApiCommand({ apiId: denied.apiId })),
      (error: any) => error.name === "AccessDeniedException",
    );
    await assert.rejects(
      scoped.send(new DeleteGraphqlApiCommand({ apiId: allowed.apiId })),
      (error: any) => error.name === "AccessDeniedException",
    );
    await assert.rejects(
      scoped.send(new CreateApiKeyCommand({ apiId: allowed.apiId })),
      (error: any) => error.name === "AccessDeniedException",
    );
    await assert.rejects(
      scoped.send(new CreateDataSourceCommand({
        apiId: allowed.apiId,
        name: "ScopedNone",
        type: "NONE",
      })),
      (error: any) => error.name === "AccessDeniedException",
    );
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "appsync-exact-api",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "appsync:ListGraphqlApis", Resource: "*" },
          {
            Effect: "Allow",
            Action: ["appsync:GetGraphqlApi", "appsync:UpdateGraphqlApi"],
            Resource: allowed.arn,
          },
          {
            Effect: "Allow",
            Action: ["appsync:CreateApiKey", "appsync:CreateDataSource"],
            Resource: "*",
          },
          { Effect: "Allow", Action: "appsync:CreateFunction", Resource: "*" },
        ],
      }),
    }));
    assert.ok((await scoped.send(new CreateApiKeyCommand({
      apiId: allowed.apiId,
    }))).apiKey?.id);
    assert.equal((await scoped.send(new CreateDataSourceCommand({
      apiId: allowed.apiId,
      name: "ScopedNone",
      type: "NONE",
    }))).dataSource?.name, "ScopedNone");
    assert.equal((await scoped.send(new CreateFunctionCommand({
      apiId: allowed.apiId, name: "ScopedFunction", dataSourceName: "ScopedNone", functionVersion: "2018-05-29",
      requestMappingTemplate: '{"version":"2018-05-29","payload":{}}', responseMappingTemplate: "$util.toJson($ctx.result)",
    }))).functionConfiguration?.name, "ScopedFunction");
    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions
      .filter(decision => decision.principalArn.includes("assumed-role/appsync-scoped/appsync-session"));
    assert(decisions.some(decision => decision.action === "appsync:UpdateGraphqlApi"
      && decision.resource === allowed.arn && decision.decision === "allowed"));
    assert(decisions.some(decision => decision.action === "appsync:GetGraphqlApi"
      && decision.resource === denied.arn && decision.decision !== "allowed"));
    assert(decisions.some(decision => decision.action === "appsync:CreateApiKey"
      && decision.resource === "*" && decision.decision === "allowed"));
    assert(decisions.some(decision => decision.action === "appsync:CreateFunction"
      && decision.resource === "*" && decision.decision === "allowed"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
