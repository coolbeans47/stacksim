import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cdkCognito from "aws-cdk-lib/aws-cognito";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AddCustomAttributesCommand,
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  CreateGroupCommand,
  ForgotPasswordCommand,
  GetUserAuthFactorsCommand,
  ListUsersCommand,
  SetUserMFAPreferenceCommand,
  SetUserPoolMfaConfigCommand,
  TagResourceCommand,
  UpdateUserPoolCommand,
  VerifySoftwareTokenCommand,
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

function totp(secret: string, now: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}

async function rawCognito(endpoint: string, operation: string, body: Record<string, unknown>) {
  const response = await fetch(`${endpoint}/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
      authorization: "AWS4-HMAC-SHA256 Credential=admin/20261030/eu-west-1/cognito-idp/aws4_request, SignedHeaders=host, Signature=0",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { __type?: string; message?: string } };
}

test("COG-09 DescribeUserPool lists the standard schema, custom: names, tags, domain, and UnusedAccountValidityDays", async () => {
  const { cognito, close } = await fixture("describe");
  try {
    const created = (await cognito.send(new CreateUserPoolCommand({ PoolName: "describe", UserPoolTags: { team: "learning" } }))).UserPool!;
    assert.deepEqual(created.UserPoolTags, { team: "learning" });
    await cognito.send(new AddCustomAttributesCommand({ UserPoolId: created.Id, CustomAttributes: [{ Name: "tenant", AttributeDataType: "String" }] }));
    const pool = (await cognito.send(new DescribeUserPoolCommand({ UserPoolId: created.Id }))).UserPool!;
    const names = pool.SchemaAttributes!.map(attribute => attribute.Name);
    assert.deepEqual(names.slice(0, 20), [
      "sub", "name", "given_name", "family_name", "middle_name", "nickname", "preferred_username", "profile",
      "picture", "website", "email", "email_verified", "gender", "birthdate", "zoneinfo", "locale", "phone_number",
      "phone_number_verified", "address", "updated_at",
    ]);
    assert.equal(names[20], "custom:tenant");
    const sub = pool.SchemaAttributes!.find(attribute => attribute.Name === "sub")!;
    assert.equal(sub.Mutable, false); assert.equal(sub.Required, true);
    assert.equal(pool.SchemaAttributes!.find(attribute => attribute.Name === "updated_at")!.AttributeDataType, "Number");
    assert.deepEqual(pool.UserPoolTags, { team: "learning" });
    assert.equal(pool.AdminCreateUserConfig?.UnusedAccountValidityDays, 7);
    await cognito.send(new UpdateUserPoolCommand({ UserPoolId: created.Id, UserPoolTags: { stage: "dev" }, UserPoolAddOns: { AdvancedSecurityMode: "OFF" } }));
    assert.deepEqual((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: created.Id }))).UserPool!.UserPoolTags, { team: "learning", stage: "dev" });
    const second = (await cognito.send(new CreateUserPoolCommand({ PoolName: "describe" }))).UserPool!;
    assert.notEqual(second.Id, created.Id, "pool names are not unique");
  } finally { await close(); }
});

test("COG-09 ListUsers filters on the documented attributes, projects AttributesToGet, and keeps pagination tokens across unrelated writes", async () => {
  const { cognito, close } = await fixture("list-users");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "list" }))).UserPool!;
    for (const [username, name] of [["ada", "Ada Lovelace"], ["grace", "Grace Hopper"], ["linus", "Linus T"]]) {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: pool.Id, Username: username, MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: `${username}@example.com` }, { Name: "name", Value: name }, { Name: "given_name", Value: name.split(" ")[0] }],
      }));
    }
    await cognito.send(new AdminDisableUserCommand({ UserPoolId: pool.Id, Username: "linus" }));
    const ada = (await cognito.send(new AdminGetUserCommand({ UserPoolId: pool.Id, Username: "ada" }))).UserAttributes!.find(attribute => attribute.Name === "sub")!.Value!;
    const filter = async (expression: string) => (await cognito.send(new ListUsersCommand({ UserPoolId: pool.Id, Filter: expression }))).Users!.map(user => user.Username);
    assert.deepEqual(await filter(`sub = "${ada}"`), ["ada"]);
    assert.deepEqual(await filter('name = "Grace Hopper"'), ["grace"]);
    assert.deepEqual(await filter('given_name ^= "L"'), ["linus"]);
    assert.deepEqual(await filter('status = "Disabled"'), ["linus"]);
    assert.deepEqual(await filter('status = "Enabled"'), ["ada", "grace"]);
    assert.deepEqual(await filter('cognito:user_status = "force_change_password"'), ["ada", "grace", "linus"]);
    await assert.rejects(cognito.send(new ListUsersCommand({ UserPoolId: pool.Id, Filter: 'custom:tenant = "x"' })), rejectsWith("InvalidParameterException"));
    const projected = (await cognito.send(new ListUsersCommand({ UserPoolId: pool.Id, AttributesToGet: ["email"] }))).Users!;
    assert.deepEqual(projected[0].Attributes!.map(attribute => attribute.Name), ["email"]);
    assert.equal(projected[0].MFAOptions, undefined);

    const first = await cognito.send(new ListUsersCommand({ UserPoolId: pool.Id, Limit: 1 }));
    await cognito.send(new TagResourceCommand({ ResourceArn: pool.Arn, Tags: { unrelated: "write" } }));
    await cognito.send(new CreateUserPoolCommand({ PoolName: "another" }));
    const second = await cognito.send(new ListUsersCommand({ UserPoolId: pool.Id, Limit: 1, PaginationToken: first.PaginationToken }));
    assert.deepEqual(second.Users!.map(user => user.Username), ["grace"]);
  } finally { await close(); }
});

test("COG-09 documented optional members are accepted, unsupported features fail with named simulator boundaries, and the four post-pin actions are modeled", async () => {
  const { cognito, endpoint, close } = await fixture("boundaries");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "alias", AliasAttributes: ["email", "preferred_username"] }))).UserPool!;
    assert.deepEqual(pool.AliasAttributes, ["email", "preferred_username"]);
    const app = (await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool.Id, ClientName: "web", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"] }))).UserPoolClient!;
    await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool.Id, ClientName: "web" }));
    await confirmedUser(cognito, pool.Id!, "alias-user", [{ Name: "preferred_username", Value: "Captain" }]);
    const signedIn = await cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "captain", PASSWORD: password },
      UserContextData: { EncodedData: "opaque" }, AnalyticsMetadata: { AnalyticsEndpointId: "endpoint" },
    }));
    assert.ok(signedIn.AuthenticationResult, "preferred_username signs in, and context members are ignored");
    assert.deepEqual(signedIn.ChallengeParameters, {});
    assert.equal(claims(signedIn.AuthenticationResult!.AccessToken).version, 2);
    const srp = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: pool.Id, ClientId: app.ClientId, AuthFlow: "USER_SRP_AUTH", AuthParameters: { USERNAME: "alias-user", SRP_A: "b".repeat(512) },
    }));
    assert.equal(srp.ChallengeName, "PASSWORD_VERIFIER");
    assert.ok((await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: pool.Id, ClientId: app.ClientId, AuthFlow: "ADMIN_NO_SRP_AUTH", AuthParameters: { USERNAME: "alias-user", PASSWORD: password },
    }))).AuthenticationResult);
    assert.ok((await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: pool.Id, ClientId: app.ClientId, AuthFlow: "REFRESH_TOKEN", AuthParameters: { REFRESH_TOKEN: signedIn.AuthenticationResult!.RefreshToken! },
    }))).AuthenticationResult?.AccessToken, "AdminInitiateAuth refreshes with the REFRESH_TOKEN alias");
    await assert.rejects(cognito.send(new InitiateAuthCommand({
      ClientId: app.ClientId, AuthFlow: "CUSTOM_AUTH", AuthParameters: { USERNAME: "alias-user" },
    })), rejectsWith("InvalidParameterException", /Custom authentication challenges .* not implemented in this simulator/));
    const group = (await cognito.send(new CreateGroupCommand({ UserPoolId: pool.Id, GroupName: "learners" }))).Group!;
    assert.equal(group.UserPoolId, pool.Id);

    const boundary = async (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: any) => {
      assert.equal(error.name, "InvalidParameterException");
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /COG-\d|CID-\d|later Cognito phase/);
      return true;
    });
    await boundary(cognito.send(new CreateUserPoolCommand({ PoolName: "x", UserPoolAddOns: { AdvancedSecurityMode: "ENFORCED" } })), /Threat protection/);
    await boundary(cognito.send(new CreateUserPoolCommand({ PoolName: "x", LambdaConfig: { UserMigration: "arn:aws:lambda:eu-west-1:000000000000:function:migrate" } })), /migrate user/);
    await boundary(cognito.send(new CreateUserPoolCommand({ PoolName: "x", VerificationMessageTemplate: { DefaultEmailOption: "CONFIRM_WITH_LINK" } })), /Link-based email confirmation/);
    await boundary(cognito.send(new CreateUserPoolCommand({ PoolName: "x", AutoVerifiedAttributes: ["phone_number"] })), /Amazon SNS/);
    await boundary(cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool.Id, ClientName: "a", AnalyticsConfiguration: { ApplicationId: "app" } })), /Amazon Pinpoint/);
    await boundary(cognito.send(new SetUserPoolMfaConfigCommand({ UserPoolId: pool.Id, WebAuthnConfiguration: { RelyingPartyId: "localhost" } })), /WebAuthn/);
    for (const [operation, body] of [
      ["GetClientToken", { ClientId: app.ClientId, Secret: "s".repeat(24) }],
      ["AdminDeleteSoftwareToken", { UserPoolId: pool.Id, Username: "alias-user" }],
      ["AdminGetUserAuthFactors", { UserPoolId: pool.Id, Username: "alias-user" }],
      ["DescribeTermsByClient", { UserPoolId: pool.Id, ClientId: app.ClientId, TermsName: "terms-of-use" }],
    ] as const) {
      const result = await rawCognito(endpoint, operation, body);
      assert.equal(result.status, 400, operation);
      assert.equal(result.body.__type, "InvalidParameterException", operation);
      assert.match(String(result.body.message), /not implemented in this simulator/, operation);
    }
    const unknown = await rawCognito(endpoint, "NoSuchOperation", {});
    assert.equal(unknown.body.__type, "UnknownOperationException");
  } finally { await close(); }
});

test("COG-09 TOTP waits for SetUserMFAPreference, extra NEW_PASSWORD_REQUIRED attributes are accepted, and state errors use the AWS text", async () => {
  const { cognito, clock, close } = await fixture("mfa-messages");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "mfa" }))).UserPool!;
    await cognito.send(new SetUserPoolMfaConfigCommand({ UserPoolId: pool.Id, MfaConfiguration: "OPTIONAL", SoftwareTokenMfaConfiguration: { Enabled: true } }));
    const app = (await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool.Id, ClientName: "web", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"] }))).UserPoolClient!;
    await confirmedUser(cognito, pool.Id!, "totp");
    const signIn = () => cognito.send(new InitiateAuthCommand({ ClientId: app.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "totp", PASSWORD: password } }));
    const accessToken = (await signIn()).AuthenticationResult!.AccessToken!;
    const associated = await cognito.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }));
    await assert.rejects(cognito.send(new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: "000000" === totp(associated.SecretCode!, clock.now()) ? "111111" : "000000" })), rejectsWith("EnableSoftwareTokenMFAException", /^Code mismatch$/));
    await cognito.send(new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: totp(associated.SecretCode!, clock.now()) }));
    assert.ok((await signIn()).AuthenticationResult, "a verified token is not enforced before the preference is set");
    const factors = await cognito.send(new GetUserAuthFactorsCommand({ AccessToken: accessToken }));
    assert.equal(factors.Username, "totp");
    await cognito.send(new SetUserMFAPreferenceCommand({ AccessToken: accessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }));
    assert.equal((await signIn()).ChallengeName, "SOFTWARE_TOKEN_MFA");

    await cognito.send(new AdminCreateUserCommand({ UserPoolId: pool.Id, Username: "invited", TemporaryPassword: "Temporary-pass-1!", MessageAction: "SUPPRESS", UserAttributes: [{ Name: "email", Value: "invited@example.com" }] }));
    const challenge = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: pool.Id, ClientId: app.ClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "invited", PASSWORD: "Temporary-pass-1!" } }));
    assert.equal(challenge.ChallengeName, "NEW_PASSWORD_REQUIRED");
    await cognito.send(new AdminRespondToAuthChallengeCommand({
      UserPoolId: pool.Id, ClientId: app.ClientId, ChallengeName: "NEW_PASSWORD_REQUIRED", Session: challenge.Session,
      ChallengeResponses: { USERNAME: "invited", NEW_PASSWORD: password, "userAttributes.name": "Invited Learner" },
    }));
    const invited = await cognito.send(new AdminGetUserCommand({ UserPoolId: pool.Id, Username: "invited" }));
    assert.equal(invited.UserAttributes!.find(attribute => attribute.Name === "name")?.Value, "Invited Learner");

    await cognito.send(new AdminDisableUserCommand({ UserPoolId: pool.Id, Username: "invited" }));
    await assert.rejects(cognito.send(new InitiateAuthCommand({ ClientId: app.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "invited", PASSWORD: password } })), rejectsWith("NotAuthorizedException", /^User is disabled\.$/));
    await cognito.send(new AdminCreateUserCommand({ UserPoolId: pool.Id, Username: "pending", MessageAction: "SUPPRESS", UserAttributes: [{ Name: "email", Value: "pending@example.com" }, { Name: "email_verified", Value: "true" }] }));
    await assert.rejects(cognito.send(new ForgotPasswordCommand({ ClientId: app.ClientId, Username: "pending" })), rejectsWith("NotAuthorizedException", /cannot be reset in the current state/));
    await assert.rejects(cognito.send(new GetUserCommand({ AccessToken: "garbage.token.value" })), rejectsWith("NotAuthorizedException", /^Invalid Access Token$/));
    clock.advance(2 * 60 * 60 * 1_000);
    await assert.rejects(cognito.send(new GetUserCommand({ AccessToken: accessToken })), rejectsWith("NotAuthorizedException", /^Access Token has expired$/));
  } finally { await close(); }
});


test("COG-10 console action routes run allowlisted official operations, require console intent, and redact secrets", async () => {
  const { cognito, endpoint, close } = await fixture("console-actions");
  try {
    const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "console" }))).UserPool!;
    const headers = { "content-type": "application/json", "x-stacksim-console-request": "1", origin: endpoint };
    const call = async (path: string, body: unknown, extra: Record<string, string> = headers) => {
      const response = await fetch(`${endpoint}/_stacksim/api/${path}`, { method: "POST", headers: extra, body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    };
    const created = await call("cognito/actions/CreateUserPoolClient", { UserPoolId: pool.Id, ClientName: "confidential", GenerateSecret: true });
    assert.equal(created.status, 200, created.text);
    assert.doesNotMatch(created.text, /ClientSecret/);
    const clientId = JSON.parse(created.text).UserPoolClient.ClientId;
    const described = await call("cognito/actions/DescribeUserPoolClient", { UserPoolId: pool.Id, ClientId: clientId });
    assert.equal(described.status, 200);
    assert.doesNotMatch(described.text, /ClientSecret/);
    assert.ok((await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: pool.Id, ClientId: clientId }))).UserPoolClient?.ClientSecret, "the official API still returns the secret");
    assert.equal((await call("cognito/actions/InitiateAuth", { ClientId: clientId, AuthFlow: "USER_PASSWORD_AUTH" })).status, 400, "user-auth operations are not console actions");
    assert.equal((await call("cognito/actions/UpdateUserPool", { UserPoolId: pool.Id }, { "content-type": "application/json" })).status, 403, "the console intent header is required");
    const identity = await call("cognito-identity/actions/CreateIdentityPool", { IdentityPoolName: "console_pool", AllowUnauthenticatedIdentities: false });
    assert.equal(identity.status, 200, identity.text);
    assert.equal((await call("cognito-identity/actions/GetCredentialsForIdentity", { IdentityId: "x" })).status, 400);
    const local = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools/${pool.Id}`);
    const view = await local.json() as { userPool: { tags: unknown; boundaries: { tags: unknown } } };
    assert.deepEqual(view.userPool.tags, {});
    assert.deepEqual(view.userPool.boundaries.tags, {}, "tags are always an object, never the string None");
  } finally { await close(); }
});
