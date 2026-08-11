import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListDevicesCommand,
  AdminListUserAuthEventsCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUpdateUserAttributesCommand,
  AddCustomAttributesCommand,
  AssociateSoftwareTokenCommand,
  ConfirmDeviceCommand,
  ConfirmForgotPasswordCommand,
  CreateUserPoolClientCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  CreateUserPoolCommand,
  ListGroupsCommand,
  ListTagsForResourceCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  ListDevicesCommand,
  GetDeviceCommand,
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SetUserPoolMfaConfigCommand,
  UpdateDeviceStatusCommand,
  UpdateUserAttributesCommand,
  UpdateUserPoolClientCommand,
  VerifySoftwareTokenCommand,
  TagResourceCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function totp(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}

test("COG-03 administrator creation, invitation, lifecycle, tags, and groups use official commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-admin-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new CognitoIdentityProviderClient({ endpoint, region, credentials });
    const created = await client.send(new CreateUserPoolCommand({
      PoolName: "admin-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      DeviceConfiguration: {
        ChallengeRequiredOnNewDevice: true,
        DeviceOnlyRememberedOnUserPrompt: true,
      },
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
        InviteMessageTemplate: {
          EmailSubject: "Welcome",
          EmailMessage: "Sign in as {username} with temporary password {####}.",
        },
      },
    }));
    const poolId = created.UserPool!.Id!;
    const poolArn = created.UserPool!.Arn!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "admin-users-web",
      ExplicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    const email = "invited@example.test";

    const invitation = await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      TemporaryPassword: "Temporary-password-1!",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }));
    assert.equal(invitation.User?.UserStatus, "FORCE_CHANGE_PASSWORD");
    assert.equal(invitation.User?.Enabled, true);

    const inbox = await fetch(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(email)}&originService=cognito-idp`,
      { headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    assert.equal(inbox.messages.length, 1);
    const message = await fetch(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(inbox.messages[0].messageId)}`,
      { headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    assert.match(message.message.textBody, /Temporary-password-1!/);

    const firstSignIn = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: "Temporary-password-1!" },
    }));
    assert.equal(firstSignIn.ChallengeName, "NEW_PASSWORD_REQUIRED");
    const completed = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: firstSignIn.Session,
      ChallengeResponses: {
        USERNAME: email,
        NEW_PASSWORD: "Permanent-password-2!",
      },
    }));
    assert(completed.AuthenticationResult?.AccessToken);
    const accessToken = completed.AuthenticationResult!.AccessToken!;

    await client.send(new AddCustomAttributesCommand({
      UserPoolId: poolId,
      CustomAttributes: [{
        Name: "tenant",
        AttributeDataType: "String",
        Mutable: true,
        StringAttributeConstraints: { MinLength: "2", MaxLength: "20" },
      }],
    }));
    await client.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: poolId,
      Username: email,
      UserAttributes: [{ Name: "custom:tenant", Value: "local" }],
    }));
    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientId: clientId,
      ClientName: "admin-users-web",
      ExplicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
      ReadAttributes: ["email"],
      WriteAttributes: ["email"],
    }));
    await assert.rejects(
      client.send(new UpdateUserAttributesCommand({
        AccessToken: accessToken,
        UserAttributes: [{ Name: "custom:tenant", Value: "blocked" }],
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientId: clientId,
      ClientName: "admin-users-web",
      ExplicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
      ReadAttributes: ["email", "custom:tenant"],
      WriteAttributes: ["email", "custom:tenant"],
    }));
    await assert.rejects(
      client.send(new UpdateUserAttributesCommand({
        AccessToken: accessToken,
        UserAttributes: [{ Name: "custom:tenant", Value: "x" }],
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    await client.send(new UpdateUserAttributesCommand({
      AccessToken: accessToken,
      UserAttributes: [{ Name: "custom:tenant", Value: "updated" }],
    }));
    assert.equal(
      (await client.send(new GetUserCommand({ AccessToken: accessToken })))
        .UserAttributes?.find(attribute => attribute.Name === "custom:tenant")?.Value,
      "updated",
    );

    await client.send(new SetUserPoolMfaConfigCommand({
      UserPoolId: poolId,
      MfaConfiguration: "OPTIONAL",
      SoftwareTokenMfaConfiguration: { Enabled: true },
    }));
    const associated = await client.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }));
    assert(associated.SecretCode);
    await client.send(new VerifySoftwareTokenCommand({
      AccessToken: accessToken,
      UserCode: totp(associated.SecretCode!),
      FriendlyDeviceName: "test authenticator",
    }));
    await client.send(new AdminSetUserMFAPreferenceCommand({
      UserPoolId: poolId,
      Username: email,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    }));

    const adminSignIn = await client.send(new AdminInitiateAuthCommand({
      UserPoolId: poolId,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: "Permanent-password-2!" },
    }));
    assert.equal(adminSignIn.ChallengeName, "SOFTWARE_TOKEN_MFA");
    const mfaSignIn = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: adminSignIn.Session,
      ChallengeResponses: {
        USERNAME: email,
        SOFTWARE_TOKEN_MFA_CODE: totp(associated.SecretCode!),
      },
    }));
    assert(mfaSignIn.AuthenticationResult?.AccessToken);

    const deviceMeta = mfaSignIn.AuthenticationResult!.NewDeviceMetadata!;
    assert.ok(deviceMeta.DeviceKey);
    await client.send(new ConfirmDeviceCommand({
      AccessToken: mfaSignIn.AuthenticationResult!.AccessToken!,
      DeviceKey: deviceMeta.DeviceKey!,
      DeviceName: "Browser",
      DeviceSecretVerifierConfig: {
        PasswordVerifier: Buffer.alloc(32, 3).toString("base64"),
        Salt: Buffer.alloc(16, 5).toString("base64"),
      },
    }));
    assert.equal((await client.send(new ListDevicesCommand({
      AccessToken: mfaSignIn.AuthenticationResult!.AccessToken!,
    }))).Devices?.length, 1);
    assert.equal((await client.send(new GetDeviceCommand({
      AccessToken: mfaSignIn.AuthenticationResult!.AccessToken!,
      DeviceKey: deviceMeta.DeviceKey!,
    }))).Device?.DeviceKey, deviceMeta.DeviceKey);
    await client.send(new UpdateDeviceStatusCommand({
      AccessToken: mfaSignIn.AuthenticationResult!.AccessToken!,
      DeviceKey: deviceMeta.DeviceKey!,
      DeviceRememberedStatus: "remembered",
    }));
    assert.equal((await client.send(new AdminListDevicesCommand({
      UserPoolId: poolId,
      Username: email,
    }))).Devices?.length, 1);
    assert((await client.send(new AdminListUserAuthEventsCommand({
      UserPoolId: poolId,
      Username: email,
    }))).AuthEvents?.length);

    const fetched = await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
    assert.equal(fetched.UserStatus, "CONFIRMED");
    assert.equal(fetched.UserAttributes?.find(attribute => attribute.Name === "email_verified")?.Value, "true");
    assert.equal(fetched.UserAttributes?.find(attribute => attribute.Name === "custom:tenant")?.Value, "updated");
    assert.equal((await client.send(new ListUsersCommand({ UserPoolId: poolId }))).Users?.length, 1);

    await client.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: email }));
    assert.equal((await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }))).Enabled, false);
    await client.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: email }));

    await client.send(new TagResourceCommand({ ResourceArn: poolArn, Tags: { environment: "test" } }));
    assert.deepEqual(
      (await client.send(new ListTagsForResourceCommand({ ResourceArn: poolArn }))).Tags,
      { environment: "test" },
    );

    await client.send(new CreateGroupCommand({
      UserPoolId: poolId,
      GroupName: "admins",
      Description: "Administrators",
      Precedence: 1,
      RoleArn: "arn:aws:iam::000000000000:role/admins",
    }));
    await client.send(new CreateGroupCommand({
      UserPoolId: poolId,
      GroupName: "auditors",
      Description: "Auditors",
      Precedence: 2,
      RoleArn: "arn:aws:iam::000000000000:role/auditors",
    }));
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: poolId,
      Username: email,
      GroupName: "admins",
    }));
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: poolId,
      Username: email,
      GroupName: "auditors",
    }));
    const firstGroupPage = await client.send(new ListGroupsCommand({ UserPoolId: poolId, Limit: 1 }));
    assert.equal(firstGroupPage.Groups?.length, 1);
    assert(firstGroupPage.NextToken);
    assert.equal((await client.send(new ListGroupsCommand({
      UserPoolId: poolId,
      Limit: 1,
      NextToken: firstGroupPage.NextToken,
    }))).Groups?.length, 1);
    assert.equal(
      (await client.send(new ListUsersInGroupCommand({ UserPoolId: poolId, GroupName: "admins" }))).Users?.length,
      1,
    );
    const oldIdClaims = JSON.parse(
      Buffer.from(completed.AuthenticationResult!.IdToken!.split(".")[1], "base64url").toString("utf8"),
    );
    assert.equal(oldIdClaims["cognito:groups"], undefined);
    const groupedChallenge = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: "Permanent-password-2!" },
    }));
    const groupedAuthentication = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: groupedChallenge.Session,
      ChallengeResponses: {
        USERNAME: email,
        SOFTWARE_TOKEN_MFA_CODE: totp(associated.SecretCode!),
      },
    }));
    const groupedIdClaims = JSON.parse(
      Buffer.from(
        groupedAuthentication.AuthenticationResult!.IdToken!.split(".")[1],
        "base64url",
      ).toString("utf8"),
    );
    const groupedAccessClaims = JSON.parse(
      Buffer.from(
        groupedAuthentication.AuthenticationResult!.AccessToken!.split(".")[1],
        "base64url",
      ).toString("utf8"),
    );
    assert.deepEqual(groupedIdClaims["cognito:groups"], ["admins", "auditors"]);
    assert.deepEqual(groupedAccessClaims["cognito:groups"], ["admins", "auditors"]);
    assert.equal(groupedIdClaims["cognito:preferred_role"], "arn:aws:iam::000000000000:role/admins");

    await client.send(new AdminResetUserPasswordCommand({ UserPoolId: poolId, Username: email }));
    assert.equal(
      (await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }))).UserStatus,
      "RESET_REQUIRED",
    );
    const resetInbox = await fetch(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(email)}&originService=cognito-idp&status=all&pageSize=100`,
      { headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    let resetCode: string | undefined;
    for (const descriptor of resetInbox.messages) {
      const detail = await fetch(
        `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(descriptor.messageId)}`,
        { headers: { "x-stacksim-region": region } },
      ).then(response => response.json()) as any;
      if (detail.message.subject === "Reset your password") {
        resetCode = /\b(\d{6})\b/.exec(detail.message.textBody)?.[1];
      }
    }
    assert(resetCode);
    await client.send(new ConfirmForgotPasswordCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: resetCode,
      Password: "Recovered-password-3!",
    }));
    assert.equal(
      (await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }))).UserStatus,
      "CONFIRMED",
    );

    const generatedEmail = "generated@example.test";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: generatedEmail,
      UserAttributes: [
        { Name: "email", Value: generatedEmail },
        { Name: "email_verified", Value: "true" },
      ],
    }));
    const generatedUser = Object.values(
      simulator.store.regionState(region).cognito.pools[poolId].usersBySub,
    ).find(user => user.attributes.email?.value === generatedEmail)!;
    const generatedIntent = Object.values(
      simulator.store.regionState(region).cognito.deliveryIntents,
    ).find(intent => intent.userSub === generatedUser.sub && intent.purpose === "ADMIN_INVITATION")!;
    assert.equal(generatedIntent.status, "DELIVERED");
    assert.equal(generatedIntent.credential.recoverableSecret, undefined);

    const suppressedEmail = "suppressed@example.test";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: suppressedEmail,
      TemporaryPassword: "Suppressed-password-4!",
      UserAttributes: [
        { Name: "email", Value: suppressedEmail },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
    }));
    const suppressedInbox = await fetch(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(suppressedEmail)}&originService=cognito-idp`,
      { headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    assert.equal(suppressedInbox.messages.length, 0);
    assert.equal(
      JSON.stringify(simulator.store.regionState(region).cognito).includes("Suppressed-password-4!"),
      false,
    );
    await client.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: generatedEmail }));
    await client.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: suppressedEmail }));

    await client.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: email }));
    assert.equal((await client.send(new ListUsersCommand({ UserPoolId: poolId }))).Users?.length, 0);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
