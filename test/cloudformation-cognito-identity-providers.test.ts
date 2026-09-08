import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import {
  COGNITO_IDENTITY_CLOUDFORMATION_AUTHORIZATION_MATRIX,
  COGNITO_IDENTITY_CLOUDFORMATION_RESOURCE_TYPES,
  COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE,
  COGNITO_IDENTITY_POOL_TYPE,
  createCognitoIdentityCloudFormationProviders,
} from "../src/cloudformation/providers/cognito-identity.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { CLOUDFORMATION_RESOURCE_INVENTORY } from "../src/cloudformation/resource-inventory.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cognito-identity-provider-test/stack-id`,
    logicalId,
    operationId: `operation-${logicalId}`,
    resourceOperationId: `resource-${logicalId}`,
    idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

function trust(poolId: string, amr: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: "cognito-identity.amazonaws.com" },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: { "cognito-identity.amazonaws.com:aud": poolId },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": amr },
      },
    }],
  });
}

test("CID-01 CloudFormation providers register Identity Pool and RoleAttachment only", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-cognito-identity-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: join(root, "data"),
    region,
    accountId,
    authMode: "off",
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
    const idp = new CognitoIdentityProviderClient({ endpoint, region, credentials });
    const iam = new IAMClient({ endpoint, region, credentials });
    const cfn = new CloudFormationClient({ endpoint, region, credentials });
    clients.push(idp, iam, cfn);

    const providers = createCognitoIdentityCloudFormationProviders(simulator.cognitoIdentity);
    assert.deepEqual(providers.map(provider => provider.typeName).sort(), [...COGNITO_IDENTITY_CLOUDFORMATION_RESOURCE_TYPES].sort());
    assert.ok(!COGNITO_IDENTITY_CLOUDFORMATION_RESOURCE_TYPES.includes("AWS::Cognito::IdentityPoolPrincipalTag" as any));
    assert.ok((CLOUDFORMATION_RESOURCE_INVENTORY as readonly string[]).includes(COGNITO_IDENTITY_POOL_TYPE));
    assert.ok((CLOUDFORMATION_RESOURCE_INVENTORY as readonly string[]).includes(COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE));
    assert.ok(!(CLOUDFORMATION_RESOURCE_INVENTORY as readonly string[]).includes("AWS::Cognito::IdentityPoolPrincipalTag"));
    assert.deepEqual(
      COGNITO_IDENTITY_CLOUDFORMATION_AUTHORIZATION_MATRIX[COGNITO_IDENTITY_POOL_TYPE].CREATE,
      ["cognito-identity:CreateIdentityPool", "cognito-identity:DescribeIdentityPool", "cognito-identity:ListTagsForResource"],
    );

    const byType = new Map(providers.map(provider => [provider.typeName, provider]));
    const poolProvider = byType.get(COGNITO_IDENTITY_POOL_TYPE)!;
    const attachmentProvider = byType.get(COGNITO_IDENTITY_POOL_ROLE_ATTACHMENT_TYPE)!;

    assert.ok(poolProvider.validate({ DeveloperProviderName: "dev" }, context("Rejected")).some(issue => issue.path.includes("DeveloperProviderName")));
    assert.ok(poolProvider.validate({ AllowClassicFlow: true, AllowUnauthenticatedIdentities: false }, context("Classic")).some(issue => issue.path.includes("AllowClassicFlow")));
    assert.ok(attachmentProvider.validate({
      IdentityPoolId: "eu-west-1:00000000-0000-0000-0000-000000000000",
      RoleMappings: { rules: {} },
    }, context("Mapped")).some(issue => issue.path.includes("RoleMappings")));

    const createdPool = await idp.send(new CreateUserPoolCommand({
      PoolName: "cfn-identity-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
    }));
    const userPoolId = createdPool.UserPool!.Id!;
    const createdClient = await idp.send(new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: "cfn-identity-web",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const clientId = createdClient.UserPoolClient!.ClientId!;
    const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;

    const poolDesired = poolProvider.canonicalize({
      AllowUnauthenticatedIdentities: false,
      IdentityPoolName: "cfn-identity-pool",
      CognitoIdentityProviders: [{
        ProviderName: providerName,
        ClientId: clientId,
        ServerSideTokenCheck: false,
      }],
      IdentityPoolTags: { env: "test" },
    }, context("Pool"));
    const poolCreated = await poolProvider.create(poolDesired, context("Pool"));
    assert.equal(poolCreated.status, "SUCCESS", JSON.stringify(poolCreated));
    if (poolCreated.status !== "SUCCESS") return;
    const poolId = String(poolProvider.ref(poolCreated.model));
    assert.match(poolId, /^eu-west-1:[0-9a-f-]+$/);
    assert.ok(poolId.length <= 55);
    assert.equal(poolProvider.getAtt(poolCreated.model, "Id"), poolId);
    assert.equal(poolProvider.getAtt(poolCreated.model, "Name"), "cfn-identity-pool");
    const described = await simulator.cognitoIdentity.executeCloudFormationControl("DescribeIdentityPool", { IdentityPoolId: poolId });
    assert.equal(described.IdentityPoolName, "cfn-identity-pool");
    const noOp = poolProvider.plan(poolDesired, poolDesired, context("Pool"));
    assert.equal(noOp.action, "NO_OP");

    await iam.send(new CreateRoleCommand({
      RoleName: "cfn-identity-auth",
      AssumeRolePolicyDocument: trust(poolId, "authenticated"),
    }));
    const roleArn = `arn:aws:iam::${accountId}:role/cfn-identity-auth`;
    const attachmentDesired = attachmentProvider.canonicalize({
      IdentityPoolId: poolId,
      Roles: { authenticated: roleArn },
    }, context("Roles"));
    const attachmentCreated = await attachmentProvider.create(attachmentDesired, context("Roles"));
    assert.equal(attachmentCreated.status, "SUCCESS", JSON.stringify(attachmentCreated));
    if (attachmentCreated.status !== "SUCCESS") return;
    assert.equal(attachmentProvider.ref(attachmentCreated.model), poolId);
    assert.equal(attachmentProvider.getAtt(attachmentCreated.model, "Id"), poolId);
    const roles = await simulator.cognitoIdentity.executeCloudFormationControl("GetIdentityPoolRoles", { IdentityPoolId: poolId }) as { Roles?: { authenticated?: string } };
    assert.equal(roles.Roles?.authenticated, roleArn);

    const renamed = poolProvider.canonicalize({
      AllowUnauthenticatedIdentities: false,
      IdentityPoolName: "cfn-identity-renamed",
      CognitoIdentityProviders: [{
        ProviderName: providerName,
        ClientId: clientId,
        ServerSideTokenCheck: false,
      }],
      IdentityPoolTags: { env: "test" },
    }, context("Pool"));
    const updated = await poolProvider.update(poolId, poolDesired, renamed, context("Pool"));
    assert.equal(updated.status, "SUCCESS", JSON.stringify(updated));
    assert.equal((await simulator.cognitoIdentity.executeCloudFormationControl("DescribeIdentityPool", { IdentityPoolId: poolId })).IdentityPoolName, "cfn-identity-renamed");

    const replacement = attachmentProvider.plan(attachmentDesired, attachmentProvider.canonicalize({
      IdentityPoolId: "eu-west-1:11111111-1111-1111-1111-111111111111",
      Roles: { authenticated: roleArn },
    }, context("Roles")), context("Roles"));
    assert.equal(replacement.action, "REPLACE");

    assert.equal((await attachmentProvider.delete(poolId, attachmentDesired, context("Roles"))).status, "SUCCESS");
    assert.equal((await poolProvider.delete(poolId, renamed, context("Pool"))).status, "SUCCESS");
    assert.equal((await poolProvider.read(poolId, context("Pool"))).status, "NOT_FOUND");

    await assert.rejects(
      cfn.send(new CreateStackCommand({
        StackName: "principal-tag",
        TemplateBody: JSON.stringify({
          Resources: {
            Tags: {
              Type: "AWS::Cognito::IdentityPoolPrincipalTag",
              Properties: { IdentityPoolId: "eu-west-1:00000000-0000-0000-0000-000000000000" },
            },
          },
        }),
      })),
      (error: any) => error.name === "ValidationError" && /IdentityPoolPrincipalTag/.test(error.message),
    );
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
