import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cdkCognito from "aws-cdk-lib/aws-cognito";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";

async function fixture(prefix: string, cdkBootstrap = false) {
  const dataDir = await mkdtemp(join(tmpdir(), `stacksim-cognito-review-${prefix}-`));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, clock, authMode: "off", cdkBootstrap });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const options = { endpoint, region, credentials, systemClockOffset: clock.now() - Date.now(), maxAttempts: 1 };
  const cognito = new CognitoIdentityProviderClient(options);
  return {
    dataDir, clock, simulator, endpoint, cognito, options,
    async close() { cognito.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

const rejectsWith = (code: string, message?: RegExp) => (error: any) => {
  assert.equal(error?.name, code, error?.message);
  if (message) assert.match(error.message, message);
  return true;
};

function claims(token: string | undefined): Record<string, any> {
  assert.ok(token);
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

async function inboxCode(endpoint: string, recipient: string): Promise<string> {
  const listed = await fetch(`${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(recipient)}&status=all&pageSize=100`);
  const messages = (await listed.json() as { messages: Array<{ messageId: string }> }).messages;
  assert.ok(messages.length, `a message reached ${recipient}`);
  const detail = await fetch(`${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(messages[0].messageId)}`);
  const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
  const match = /\b(\d{6})\b/.exec(text);
  assert.ok(match, "the captured email carries a six-digit code");
  return match[1];
}

async function confirmedUser(
  cognito: CognitoIdentityProviderClient,
  poolId: string,
  username: string,
  attributes: Array<{ Name: string; Value: string }> = [],
): Promise<void> {
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: username,
    MessageAction: "SUPPRESS",
    UserAttributes: [{ Name: "email", Value: `${username}@example.com` }, { Name: "email_verified", Value: "true" }, ...attributes],
  }));
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: true }));
}

test("COG-08 a default app client reads and writes every standard attribute and DescribeUserPoolClient omits the lists", async () => {
  const { cognito, close } = await fixture("default-client");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "tutorial", AutoVerifiedAttributes: ["email"] }))).UserPool!;
    const app = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "web", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }))).UserPoolClient!;
    assert.equal(app.ReadAttributes, undefined);
    assert.equal(app.WriteAttributes, undefined);
    const described = (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: pool.Id, ClientId: app.ClientId }))).UserPoolClient!;
    assert.equal(described.ReadAttributes, undefined);
    assert.equal(described.WriteAttributes, undefined);

    await cognito.send(new SignUpCommand({
      ClientId: app.ClientId, Username: "learner", Password: password,
      UserAttributes: [{ Name: "email", Value: "learner@example.com" }, { Name: "name", Value: "Learner One" }],
    }));
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: pool.Id, Username: "learner" }));
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: pool.Id, Username: "learner", UserAttributes: [{ Name: "given_name", Value: "Learner" }],
    }));
    const signedIn = await cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "learner", PASSWORD: password },
    }));
    const user = await cognito.send(new GetUserCommand({ AccessToken: signedIn.AuthenticationResult!.AccessToken }));
    const attributes = Object.fromEntries(user.UserAttributes!.map(attribute => [attribute.Name, attribute.Value]));
    assert.equal(attributes.name, "Learner One");
    assert.equal(attributes.given_name, "Learner");
    assert.equal(attributes.email_verified, "false");
    const id = claims(signedIn.AuthenticationResult!.IdToken);
    assert.equal(id.name, "Learner One");
    assert.equal(id.given_name, "Learner");

    const restricted = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "restricted", ReadAttributes: ["email"], WriteAttributes: ["email"],
    }))).UserPoolClient!;
    assert.deepEqual(restricted.ReadAttributes, ["email"]);
    await assert.rejects(cognito.send(new SignUpCommand({
      ClientId: restricted.ClientId, Username: "other", Password: password,
      UserAttributes: [{ Name: "email", Value: "other@example.com" }, { Name: "name", Value: "Other" }],
    })), rejectsWith("NotAuthorizedException"));
  } finally { await close(); }
});

test("COG-08 successful sign-ins are never throttled and five failures lock the user out until the lockout expires", async () => {
  const { cognito, clock, close } = await fixture("lockout");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "lockout" }))).UserPool!;
    const app = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "web", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }))).UserPoolClient!;
    await confirmedUser(cognito, pool.Id!, "repeat");
    const signIn = (secret: string) => cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "repeat", PASSWORD: secret },
    }));
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.ok((await signIn(password)).AuthenticationResult?.AccessToken, `sign-in ${attempt + 1} succeeds`);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(signIn("Wrong-password-1!"), rejectsWith("NotAuthorizedException", /^Incorrect username or password\.$/));
    }
    await assert.rejects(signIn(password), rejectsWith("NotAuthorizedException", /^Password attempts exceeded$/));
    clock.advance(1_100);
    assert.ok((await signIn(password)).AuthenticationResult?.AccessToken, "a correct password after the lockout succeeds");
    await assert.rejects(signIn("Wrong-password-1!"), rejectsWith("NotAuthorizedException", /^Incorrect username or password\.$/));
    assert.ok((await signIn(password)).AuthenticationResult, "the success reset the failure count");
  } finally { await close(); }
});

test("COG-08 every documented ExplicitAuthFlows value, the Lite tier, and the optional Permanent flag are accepted", async () => {
  const { cognito, close } = await fixture("flows");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "flows" }))).UserPool!;
    const modern = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "modern",
      ExplicitAuthFlows: ["ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_USER_PASSWORD_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }))).UserPoolClient!;
    assert.ok(modern.ExplicitAuthFlows?.includes("ALLOW_USER_AUTH"));
    const legacy = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "legacy", ExplicitAuthFlows: ["ADMIN_NO_SRP_AUTH", "USER_PASSWORD_AUTH"],
    }))).UserPoolClient!;
    await confirmedUser(cognito, pool.Id!, "legacy-user");
    assert.ok((await cognito.send(new InitiateAuthCommand({
      ClientId: legacy.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "legacy-user", PASSWORD: password },
    }))).AuthenticationResult, "the legacy USER_PASSWORD_AUTH value enables password sign-in");
    await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool.Id, ClientName: "custom-only", ExplicitAuthFlows: ["CUSTOM_AUTH_FLOW_ONLY"] }));
    await assert.rejects(cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "mixed", ExplicitAuthFlows: ["USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    })), rejectsWith("InvalidParameterException", /legacy/));

    const lite = (await cognito.send(new CreateUserPoolCommand({ PoolName: "lite", UserPoolTier: "LITE" }))).UserPool!;
    assert.equal(lite.UserPoolTier, "LITE");
    await assert.rejects(cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: lite.Id, ClientName: "choice", ExplicitAuthFlows: ["ALLOW_USER_AUTH"],
    })), rejectsWith("FeatureUnavailableInTierException"));

    const policy = (await cognito.send(new CreateUserPoolCommand({
      PoolName: "policy", Policies: { SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD"] } },
    }))).UserPool!;
    assert.deepEqual(policy.Policies?.SignInPolicy?.AllowedFirstAuthFactors, ["PASSWORD"]);
    await assert.rejects(cognito.send(new CreateUserPoolCommand({
      PoolName: "sms", Policies: { SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "SMS_OTP"] } },
    })), (error: any) => {
      assert.equal(error.name, "InvalidParameterException");
      assert.match(error.message, /not implemented in this simulator/);
      assert.doesNotMatch(error.message, /COG-\d/);
      return true;
    });

    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool.Id, Username: "legacy-user", Password: "Another-password-2!" }));
    assert.equal((await cognito.send(new AdminGetUserCommand({ UserPoolId: pool.Id, Username: "legacy-user" }))).UserStatus, "FORCE_CHANGE_PASSWORD");
  } finally { await close(); }
});

test("COG-08 USER_AUTH signs in with PASSWORD, offers SELECT_CHALLENGE, starts PASSWORD_SRP, and accepts the sign-up Session", async () => {
  const { cognito, endpoint, close } = await fixture("user-auth");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({
      PoolName: "choice", UsernameAttributes: ["email"], AutoVerifiedAttributes: ["email"],
    }))).UserPool!;
    const app = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "console-default", ExplicitAuthFlows: ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }))).UserPoolClient!;
    const signedUp = await cognito.send(new SignUpCommand({
      ClientId: app.ClientId, Username: "choice@example.com", Password: password,
      UserAttributes: [{ Name: "email", Value: "choice@example.com" }],
    }));
    assert.equal(typeof signedUp.Session, "string");
    const confirmed = await cognito.send(new ConfirmSignUpCommand({
      ClientId: app.ClientId, Username: "choice@example.com", ConfirmationCode: await inboxCode(endpoint, "choice@example.com"), Session: signedUp.Session,
    }));
    assert.equal(typeof confirmed.Session, "string");
    const immediate = await cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: "choice@example.com" }, Session: confirmed.Session,
    }));
    assert.ok(immediate.AuthenticationResult?.IdToken, "the confirmed sign-up session signs the user in");
    await assert.rejects(cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: "choice@example.com" }, Session: confirmed.Session,
    })), rejectsWith("NotAuthorizedException"), "the session is single-use");

    const direct = await cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_AUTH",
      AuthParameters: { USERNAME: "choice@example.com", PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: password },
    }));
    assert.ok(direct.AuthenticationResult?.AccessToken);

    const select = await cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: "choice@example.com" },
    }));
    assert.equal(select.ChallengeName, "SELECT_CHALLENGE");
    assert.deepEqual(select.AvailableChallenges, ["PASSWORD", "PASSWORD_SRP"]);
    const answered = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: app.ClientId, ChallengeName: "SELECT_CHALLENGE", Session: select.Session,
      ChallengeResponses: { USERNAME: "choice@example.com", ANSWER: "PASSWORD", PASSWORD: password },
    }));
    assert.ok(answered.AuthenticationResult?.RefreshToken);

    const srp = await cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_AUTH",
      AuthParameters: { USERNAME: "choice@example.com", PREFERRED_CHALLENGE: "PASSWORD_SRP", SRP_A: "a".repeat(512) },
    }));
    assert.equal(srp.ChallengeName, "PASSWORD_VERIFIER");
    assert.ok(srp.ChallengeParameters?.SRP_B);

    const passwordOnly = (await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.Id, ClientName: "password-only", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    }))).UserPoolClient!;
    await assert.rejects(cognito.send(new InitiateAuthCommand({
      ClientId: passwordOnly.ClientId, AuthFlow: "USER_AUTH", AuthParameters: { USERNAME: "choice@example.com" },
    })), rejectsWith("InvalidParameterException", /USER_AUTH is not enabled/));
  } finally { await close(); }
});

test("COG-08 a CDK UserPoolClient with authFlows.user and default attributes deploys", async () => {
  const app = new App();
  const stack = new Stack(app, "ChoiceAuthStack", { env: { account: accountId, region } });
  const userPool = new cdkCognito.UserPool(stack, "Pool", { selfSignUpEnabled: true, signInAliases: { email: true }, removalPolicy: RemovalPolicy.DESTROY });
  const client = userPool.addClient("Client", { authFlows: { user: true, userSrp: true } });
  new CfnOutput(stack, "PoolId", { value: userPool.userPoolId });
  new CfnOutput(stack, "ClientId", { value: client.userPoolClientId });
  const template = app.synth().getStackArtifact(stack.artifactId).template;
  const synthesized = Object.values(template.Resources as Record<string, any>).find(resource => resource.Type === "AWS::Cognito::UserPoolClient");
  assert.ok(synthesized.Properties.ExplicitAuthFlows.includes("ALLOW_USER_AUTH"));
  assert.equal(synthesized.Properties.ReadAttributes, undefined);

  const { cognito, clock, options, close } = await fixture("cdk-user-auth", true);
  const cloudformation = new CloudFormationClient(options);
  try {
    await cloudformation.send(new CreateStackCommand({ StackName: "choice-auth", TemplateBody: JSON.stringify(template) }));
    let created: any;
    for (let attempt = 0; attempt < 300 && !created; attempt++) {
      clock.advance(500);
      await new Promise(resolve => setTimeout(resolve, 5));
      const described = (await cloudformation.send(new DescribeStacksCommand({ StackName: "choice-auth" }))).Stacks?.[0];
      if (described?.StackStatus === "CREATE_COMPLETE") created = described;
      else if (/FAILED|ROLLBACK/.test(described?.StackStatus ?? "")) throw new Error(`${described?.StackStatus}: ${described?.StackStatusReason}`);
    }
    assert.ok(created, "the stack reached CREATE_COMPLETE");
    const outputs = Object.fromEntries(created.Outputs.map((output: any) => [output.OutputKey, output.OutputValue]));
    const deployed = (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: outputs.PoolId, ClientId: outputs.ClientId }))).UserPoolClient!;
    assert.ok(deployed.ExplicitAuthFlows?.includes("ALLOW_USER_AUTH"));
    assert.equal(deployed.ReadAttributes, undefined);
    assert.equal(deployed.WriteAttributes, undefined);
    assert.ok((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: outputs.PoolId }))).UserPool);
  } finally { cloudformation.destroy(); await close(); }
});
