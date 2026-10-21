import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStackResourcesCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AdminCreateUserCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  UpdateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function withSimulator(run: (endpoint: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cognito-recovery-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off" });
  try { await simulator.start(); await run(`http://127.0.0.1:${simulator.port}`); } finally { await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); }
}

async function confirmedUser(client: CognitoIdentityProviderClient, poolId: string, username: string, attributes: Array<{ Name: string; Value: string }>): Promise<void> {
  await client.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: "SUPPRESS", TemporaryPassword: "Temporary-password-1!", UserAttributes: attributes }));
  await client.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: "Permanent-password-1!", Permanent: true }));
}

test("AccountRecoverySetting accepts the documented mechanisms and picks the highest-priority destination the user qualifies for", async () => {
  await withSimulator(async endpoint => {
    const client = new CognitoIdentityProviderClient({ endpoint, region, credentials });
    try {
      // The CDK default (AccountRecovery.PHONE_WITHOUT_MFA_AND_EMAIL): phone first, email second.
      const pool = await client.send(new CreateUserPoolCommand({ PoolName: "recovery", AutoVerifiedAttributes: ["email"], AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 2 }, { Name: "verified_phone_number", Priority: 1 }] } }));
      const poolId = pool.UserPool!.Id!;
      assert.deepEqual((await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }))).UserPool?.AccountRecoverySetting?.RecoveryMechanisms, [{ Name: "verified_phone_number", Priority: 1 }, { Name: "verified_email", Priority: 2 }]);
      const app = await client.send(new CreateUserPoolClientCommand({ UserPoolId: poolId, ClientName: "web" }));
      const clientId = app.UserPoolClient!.ClientId!;

      // A user with only a verified email falls through to the email mechanism.
      await confirmedUser(client, poolId, "email-only", [{ Name: "email", Value: "email-only@example.test" }, { Name: "email_verified", Value: "true" }]);
      const reset = await client.send(new ForgotPasswordCommand({ ClientId: clientId, Username: "email-only" }));
      assert.equal(reset.CodeDeliveryDetails?.DeliveryMedium, "EMAIL");

      // A verified phone is the user's real destination; StackSim has no SMS channel, so it fails explicitly instead of switching to email.
      await confirmedUser(client, poolId, "with-phone", [{ Name: "email", Value: "with-phone@example.test" }, { Name: "email_verified", Value: "true" }, { Name: "phone_number", Value: "+15555550100" }, { Name: "phone_number_verified", Value: "true" }]);
      await assert.rejects(client.send(new ForgotPasswordCommand({ ClientId: clientId, Username: "with-phone" })), (error: any) => error.name === "CodeDeliveryFailureException" && /cannot deliver SMS/.test(error.message));

      // No verified destination at all.
      await confirmedUser(client, poolId, "unverified", [{ Name: "email", Value: "unverified@example.test" }]);
      await assert.rejects(client.send(new ForgotPasswordCommand({ ClientId: clientId, Username: "unverified" })), (error: any) => error.name === "InvalidParameterException" && /no registered\/verified email or phone_number/.test(error.message));

      // admin_only disables self-service recovery but administrator resets still deliver.
      await client.send(new UpdateUserPoolCommand({ UserPoolId: poolId, AutoVerifiedAttributes: ["email"], AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }] } }));
      await assert.rejects(client.send(new ForgotPasswordCommand({ ClientId: clientId, Username: "email-only" })), (error: any) => error.name === "InvalidParameterException" && /admin_only/.test(error.message));
      await client.send(new AdminResetUserPasswordCommand({ UserPoolId: poolId, Username: "email-only" }));

      // Invalid shapes are rejected without mutation.
      for (const mechanisms of [
        [{ Name: "admin_only", Priority: 1 }, { Name: "verified_email", Priority: 2 }],
        [{ Name: "verified_email", Priority: 1 }, { Name: "verified_phone_number", Priority: 1 }],
        [{ Name: "verified_email", Priority: 1 }, { Name: "verified_email", Priority: 2 }],
        [{ Name: "verified_email", Priority: 3 }],
        [{ Name: "sms", Priority: 1 }],
        [],
      ]) {
        await assert.rejects(client.send(new UpdateUserPoolCommand({ UserPoolId: poolId, AccountRecoverySetting: { RecoveryMechanisms: mechanisms as any } })), (error: any) => error.name === "InvalidParameterException", JSON.stringify(mechanisms));
      }
      assert.deepEqual((await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }))).UserPool?.AccountRecoverySetting?.RecoveryMechanisms, [{ Name: "admin_only", Priority: 1 }]);
    } finally { client.destroy(); }
  });
});

test("an app client created without ExplicitAuthFlows gets the AWS default flows", async () => {
  await withSimulator(async endpoint => {
    const client = new CognitoIdentityProviderClient({ endpoint, region, credentials });
    try {
      const poolId = (await client.send(new CreateUserPoolCommand({ PoolName: "defaults" }))).UserPool!.Id!;
      const created = await client.send(new CreateUserPoolClientCommand({ UserPoolId: poolId, ClientName: "defaults" }));
      const described = await client.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: created.UserPoolClient!.ClientId! }));
      assert.deepEqual([...(described.UserPoolClient?.ExplicitAuthFlows ?? [])].sort(), ["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]);
      await confirmedUser(client, poolId, "user", []);
      // USER_PASSWORD_AUTH is not among the defaults, as in AWS.
      await assert.rejects(client.send(new InitiateAuthCommand({ ClientId: created.UserPoolClient!.ClientId!, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "user", PASSWORD: "Permanent-password-1!" } })), (error: any) => error.name === "InvalidParameterException");
      await assert.rejects(client.send(new CreateUserPoolClientCommand({ UserPoolId: poolId, ClientName: "empty", ExplicitAuthFlows: [] })), (error: any) => error.name === "InvalidParameterException");
    } finally { client.destroy(); }
  });
});

test("CloudFormation deploys the user pool and client a default CDK UserPool with addClient() synthesizes", async () => {
  await withSimulator(async endpoint => {
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials });
    const cognito = new CognitoIdentityProviderClient({ endpoint, region, credentials });
    try {
      // Shape synthesized by aws-cdk-lib `new cognito.UserPool(this, "Pool")` plus `pool.addClient("Client")`.
      const template = {
        Resources: {
          Pool: { Type: "AWS::Cognito::UserPool", Properties: { AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_phone_number", Priority: 1 }, { Name: "verified_email", Priority: 2 }] }, AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, EmailVerificationMessage: "The verification code to your new account is {####}", EmailVerificationSubject: "Verify your new account", SmsVerificationMessage: "The verification code to your new account is {####}", VerificationMessageTemplate: { DefaultEmailOption: "CONFIRM_WITH_CODE", EmailMessage: "The verification code to your new account is {####}", EmailSubject: "Verify your new account", SmsMessage: "The verification code to your new account is {####}" } }, UpdateReplacePolicy: "Retain", DeletionPolicy: "Retain" },
          PoolClient: { Type: "AWS::Cognito::UserPoolClient", Properties: { UserPoolId: { Ref: "Pool" }, AllowedOAuthFlows: ["implicit", "code"], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthScopes: ["profile", "phone", "email", "openid", "aws.cognito.signin.user.admin"], CallbackURLs: ["https://example.com"], SupportedIdentityProviders: ["COGNITO"] } },
        },
        Outputs: { PoolId: { Value: { Ref: "Pool" } }, ClientId: { Value: { Ref: "PoolClient" } } },
      };
      await cloudformation.send(new CreateStackCommand({ StackName: "cdk-default-pool", TemplateBody: JSON.stringify(template) }));
      let stack: any;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "cdk-default-pool" }))).Stacks?.[0];
        if (!stack?.StackStatus?.endsWith("_IN_PROGRESS")) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const resources = await cloudformation.send(new DescribeStackResourcesCommand({ StackName: "cdk-default-pool" }));
      assert.equal(stack?.StackStatus, "CREATE_COMPLETE", `${stack?.StackStatusReason} ${JSON.stringify(resources.StackResources?.map(resource => [resource.LogicalResourceId, resource.ResourceStatusReason]))}`);
      const outputs = Object.fromEntries((stack.Outputs ?? []).map((output: any) => [output.OutputKey, output.OutputValue]));
      const client = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: outputs.PoolId, ClientId: outputs.ClientId }));
      assert.deepEqual([...(client.UserPoolClient?.ExplicitAuthFlows ?? [])].sort(), ["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]);
      assert.deepEqual((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: outputs.PoolId }))).UserPool?.AccountRecoverySetting?.RecoveryMechanisms, [{ Name: "verified_phone_number", Priority: 1 }, { Name: "verified_email", Priority: 2 }]);
    } finally { cloudformation.destroy(); cognito.destroy(); }
  });
});
