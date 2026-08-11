import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolClientCommand,
  DeleteUserPoolCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  ListUserPoolClientsCommand,
  ListTagsForResourceCommand,
  ListUsersCommand,
  SetUserPoolMfaConfigCommand,
  TagResourceCommand,
  ListUserPoolsCommand,
  UpdateUserPoolClientCommand,
  UpdateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };
const controlActions = [
  "cognito-idp:CreateUserPool",
  "cognito-idp:DescribeUserPool",
  "cognito-idp:ListUserPools",
  "cognito-idp:UpdateUserPool",
  "cognito-idp:DeleteUserPool",
  "cognito-idp:CreateUserPoolClient",
  "cognito-idp:DescribeUserPoolClient",
  "cognito-idp:ListUserPoolClients",
  "cognito-idp:UpdateUserPoolClient",
  "cognito-idp:DeleteUserPoolClient",
] as const;

function policyDocument(statements: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

test("all ten COG-01 control actions enforce global versus pool ARN IAM targeting", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-iam-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const rootCognito = new CognitoIdentityProviderClient({ endpoint, region, credentials: adminCredentials });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials });
    clients.push(rootCognito, iam, sts);

    const allowed = await rootCognito.send(new CreateUserPoolCommand({ PoolName: "iam-allowed" }));
    const other = await rootCognito.send(new CreateUserPoolCommand({ PoolName: "iam-other" }));
    const allowedId = allowed.UserPool!.Id!;
    const otherId = other.UserPool!.Id!;
    const allowedArn = `arn:aws:cognito-idp:${region}:${accountId}:userpool/${allowedId}`;
    const roleName = "cognito-control";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: policyDocument([{
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "sts:AssumeRole",
      }]),
    }));
    const scopedActions = controlActions.filter(action =>
      action !== "cognito-idp:CreateUserPool" && action !== "cognito-idp:ListUserPools");
    const controlPolicy = (denyDelete: boolean): string => policyDocument([
      {
        Effect: "Allow",
        Action: ["cognito-idp:CreateUserPool", "cognito-idp:ListUserPools"],
        Resource: "*",
      },
      { Effect: "Allow", Action: scopedActions, Resource: allowedArn },
      ...(denyDelete ? [{
        Effect: "Deny",
        Action: "cognito-idp:DeleteUserPoolClient",
        Resource: allowedArn,
      }] : []),
    ]);
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "cognito-control",
      PolicyDocument: controlPolicy(true),
    }));
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "cognito-session",
    }));
    const scoped = new CognitoIdentityProviderClient({
      endpoint,
      region,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
    });
    clients.push(scoped);

    const roleCreated = await scoped.send(new CreateUserPoolCommand({ PoolName: "iam-role-created" }));
    assert(roleCreated.UserPool?.Id);
    assert((await scoped.send(new ListUserPoolsCommand({ MaxResults: 60 }))).UserPools?.length);
    assert.equal((await scoped.send(new DescribeUserPoolCommand({ UserPoolId: allowedId }))).UserPool?.Id, allowedId);
    await assert.rejects(
      scoped.send(new DescribeUserPoolCommand({ UserPoolId: otherId })),
      (error: any) => error.name === "AccessDeniedException",
    );
    await scoped.send(new UpdateUserPoolCommand({ UserPoolId: allowedId, PoolName: "iam-allowed-updated" }));

    const createdClient = await scoped.send(new CreateUserPoolClientCommand({
      UserPoolId: allowedId,
      ClientName: "iam-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const clientId = createdClient.UserPoolClient!.ClientId!;
    assert.equal((await scoped.send(new ListUserPoolClientsCommand({
      UserPoolId: allowedId,
      MaxResults: 60,
    }))).UserPoolClients?.length, 1);
    assert.equal((await scoped.send(new DescribeUserPoolClientCommand({
      UserPoolId: allowedId,
      ClientId: clientId,
    }))).UserPoolClient?.ClientId, clientId);
    await scoped.send(new UpdateUserPoolClientCommand({
      UserPoolId: allowedId,
      ClientId: clientId,
      ClientName: "iam-client-updated",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    await assert.rejects(
      scoped.send(new DeleteUserPoolClientCommand({ UserPoolId: allowedId, ClientId: clientId })),
      (error: any) => error.name === "AccessDeniedException",
    );

    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "cognito-control",
      PolicyDocument: controlPolicy(false),
    }));
    await scoped.send(new DeleteUserPoolClientCommand({ UserPoolId: allowedId, ClientId: clientId }));
    await scoped.send(new DeleteUserPoolCommand({ UserPoolId: allowedId }));

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions
      .filter(decision => decision.principalArn.includes("assumed-role/cognito-control/cognito-session"));
    for (const action of controlActions) {
      assert(
        decisions.some(decision => decision.action === action && decision.decision === "allowed"),
        `missing allowed authorization evidence for ${action}`,
      );
    }
    assert(
      decisions.some(decision =>
        decision.action === "cognito-idp:DescribeUserPool"
        && decision.resource.endsWith(`:userpool/${otherId}`)
        && decision.decision !== "allowed"),
      "a pool-scoped action must deny the other pool ARN",
    );
    assert(decisions.some(decision =>
      decision.action === "cognito-idp:DeleteUserPoolClient"
      && decision.resource === allowedArn
      && decision.decision === "explicitDeny"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-03 administrator and tag actions enforce pool ARNs plus request/resource tag conditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-cog03-iam-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const rootCognito = new CognitoIdentityProviderClient({ endpoint, region, credentials: adminCredentials });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials });
    clients.push(rootCognito, iam, sts);
    const allowed = await rootCognito.send(new CreateUserPoolCommand({
      PoolName: "cog03-iam-allowed",
      UsernameAttributes: ["email"],
      UserPoolTags: { environment: "test" },
    }));
    const other = await rootCognito.send(new CreateUserPoolCommand({
      PoolName: "cog03-iam-other",
      UsernameAttributes: ["email"],
      UserPoolTags: { environment: "test" },
    }));
    const allowedId = allowed.UserPool!.Id!;
    const otherId = other.UserPool!.Id!;
    const allowedArn = allowed.UserPool!.Arn!;
    await rootCognito.send(new AdminCreateUserCommand({
      UserPoolId: allowedId,
      Username: "iam-user@example.test",
      TemporaryPassword: "Temporary-password-1!",
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: "iam-user@example.test" }],
    }));
    const roleName = "cognito-cog03";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: policyDocument([{
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "sts:AssumeRole",
      }]),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "cognito-cog03",
      PolicyDocument: policyDocument([
        {
          Effect: "Allow",
          Action: [
            "cognito-idp:AdminGetUser",
            "cognito-idp:ListUsers",
            "cognito-idp:CreateGroup",
            "cognito-idp:SetUserPoolMfaConfig",
            "cognito-idp:ListTagsForResource",
          ],
          Resource: allowedArn,
          Condition: { StringEquals: { "aws:ResourceTag/environment": "test" } },
        },
        {
          Effect: "Allow",
          Action: "cognito-idp:TagResource",
          Resource: allowedArn,
          Condition: {
            StringEquals: { "aws:RequestTag/environment": "test" },
            "ForAllValues:StringEquals": { "aws:TagKeys": ["environment"] },
          },
        },
      ]),
    }));
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "cog03-session",
    }));
    const scoped = new CognitoIdentityProviderClient({
      endpoint,
      region,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
      maxAttempts: 1,
    });
    clients.push(scoped);

    assert.equal((await scoped.send(new AdminGetUserCommand({
      UserPoolId: allowedId,
      Username: "iam-user@example.test",
    }))).UserStatus, "FORCE_CHANGE_PASSWORD");
    assert.equal((await scoped.send(new ListUsersCommand({ UserPoolId: allowedId }))).Users?.length, 1);
    await scoped.send(new CreateGroupCommand({ UserPoolId: allowedId, GroupName: "operators" }));
    await scoped.send(new SetUserPoolMfaConfigCommand({
      UserPoolId: allowedId,
      MfaConfiguration: "OPTIONAL",
      SoftwareTokenMfaConfiguration: { Enabled: true },
    }));
    assert.deepEqual(
      (await scoped.send(new ListTagsForResourceCommand({ ResourceArn: allowedArn }))).Tags,
      { environment: "test" },
    );
    await scoped.send(new TagResourceCommand({
      ResourceArn: allowedArn,
      Tags: { environment: "test" },
    }));
    await assert.rejects(
      scoped.send(new TagResourceCommand({
        ResourceArn: allowedArn,
        Tags: { environment: "production" },
      })),
      (error: any) => error?.name === "AccessDeniedException",
    );
    await assert.rejects(
      scoped.send(new ListUsersCommand({ UserPoolId: otherId })),
      (error: any) => error?.name === "AccessDeniedException",
    );

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions
      .filter(decision => decision.principalArn.includes("assumed-role/cognito-cog03/cog03-session"));
    for (const action of [
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
      "cognito-idp:CreateGroup",
      "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:ListTagsForResource",
      "cognito-idp:TagResource",
    ]) {
      assert(decisions.some(decision =>
        decision.action === action
        && decision.resource === allowedArn
        && decision.decision === "allowed"
      ), `missing COG-03 allow evidence for ${action}`);
    }
    assert(decisions.some(decision =>
      decision.action === "cognito-idp:ListUsers"
      && decision.resource.endsWith(`:userpool/${otherId}`)
      && decision.decision !== "allowed"
    ));
    assert(decisions.some(decision =>
      decision.action === "cognito-idp:TagResource"
      && decision.resource === allowedArn
      && decision.decision !== "allowed"
    ));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
