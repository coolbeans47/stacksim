import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SetUserMFAPreferenceCommand,
  SetUserPoolMfaConfigCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateConfigurationSetCommand,
  CreateEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function clients(simulator: StackSim): {
  cognito: CognitoIdentityProviderClient;
  ses: SESv2Client;
} {
  const options = { endpoint: endpoint(simulator), region, credentials };
  return {
    cognito: new CognitoIdentityProviderClient(options),
    ses: new SESv2Client(options),
  };
}

async function inboxMessages(simulator: StackSim, recipient: string): Promise<Array<{
  messageId: string;
  operation: string;
}>> {
  const response = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(recipient)}&status=all&pageSize=100`,
  );
  assert.equal(response.status, 200);
  return (await response.json() as {
    messages: Array<{ messageId: string; operation: string }>;
  }).messages;
}

async function inboxDetail(simulator: StackSim, messageId: string): Promise<{
  source: string;
  replyTo: string[];
  configurationSetName?: string;
  textBody?: string;
}> {
  const response = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox/${encodeURIComponent(messageId)}`,
  );
  assert.equal(response.status, 200);
  return (await response.json() as {
    message: {
      source: string;
      replyTo: string[];
      configurationSetName?: string;
      textBody?: string;
    };
  }).message;
}

async function verifyIdentity(
  simulator: StackSim,
  ses: SESv2Client,
  identity: string,
): Promise<void> {
  await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: identity }));
  const verification = (await inboxMessages(simulator, identity))
    .find(message => message.operation === "VerifyEmailIdentity");
  assert(verification);
  const detail = await inboxDetail(simulator, verification.messageId);
  const link = detail.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
  assert(link);
  const callback = await fetch(link, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const location = callback.headers.get("location");
  assert(location);
  assert.equal((await fetch(new URL(location, endpoint(simulator)))).status, 200);
}

function code(detail: { textBody?: string }): string {
  const match = /\b(\d{6})\b/.exec(detail.textBody ?? "");
  assert(match);
  return match[1];
}

test("DEVELOPER email uses the configured verified SES identity, reply-to, configuration set, and recovery path", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-developer-email-"));
  const sender = "cognito-sender@example.com";
  const recipient = "developer-user@example.com";
  const replyTo = "support@example.com";
  const configurationSet = "cognito_delivery";
  const sourceArn = `arn:aws:ses:${region}:${accountId}:identity/${sender}`;
  const clock = new TestClock(Date.parse("2026-07-24T10:00:00Z"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    accountId,
    authMode: "off",
    clock,
  });
  let active = clients(simulator);
  try {
    await simulator.start();
    active.cognito.destroy();
    active.ses.destroy();
    active = clients(simulator);

    await assert.rejects(
      active.cognito.send(new CreateUserPoolCommand({
        PoolName: "cross-region-developer",
        EmailConfiguration: {
          EmailSendingAccount: "DEVELOPER",
          SourceArn: `arn:aws:ses:us-east-1:${accountId}:identity/${sender}`,
        },
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );

    await verifyIdentity(simulator, active.ses, sender);
    await active.ses.send(new CreateConfigurationSetCommand({
      ConfigurationSetName: configurationSet,
    }));
    const pool = await active.cognito.send(new CreateUserPoolCommand({
      PoolName: "developer-email-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: sourceArn,
        From: `Product team <${sender}>`,
        ReplyToEmailAddress: replyTo,
        ConfigurationSet: configurationSet,
      },
    }));
    const poolId = pool.UserPool!.Id!;
    assert.deepEqual(
      (await active.cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId })))
        .UserPool?.EmailConfiguration,
      {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: sourceArn,
        From: `Product team <${sender}>`,
        ReplyToEmailAddress: replyTo,
        ConfigurationSet: configurationSet,
      },
    );
    const app = await active.cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "developer-email-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    const signup = await active.cognito.send(new SignUpCommand({
      ClientId: clientId,
      Username: recipient,
      Password: password,
    }));
    assert.equal(signup.UserConfirmed, false);
    const messages = await inboxMessages(simulator, recipient);
    assert.equal(messages.length, 1);
    const delivered = await inboxDetail(simulator, messages[0].messageId);
    assert.equal(delivered.source, sender);
    assert.deepEqual(delivered.replyTo, [replyTo]);
    assert.equal(delivered.configurationSetName, configurationSet);
    await active.cognito.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: recipient,
      ConfirmationCode: code(delivered),
    }));

    const recoverySender = "recovery-sender@example.com";
    const recoveryRecipient = "recovery-user@example.com";
    const recoveryArn = `arn:aws:ses:${region}:${accountId}:identity/${recoverySender}`;
    const recoveryPool = await active.cognito.send(new CreateUserPoolCommand({
      PoolName: "developer-recovery-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: recoveryArn,
      },
    }));
    const recoveryApp = await active.cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: recoveryPool.UserPool!.Id!,
      ClientName: "recovery-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    await assert.rejects(
      active.cognito.send(new SignUpCommand({
        ClientId: recoveryApp.UserPoolClient!.ClientId!,
        Username: recoveryRecipient,
        Password: password,
      })),
      (error: any) => error?.name === "CodeDeliveryFailureException",
    );
    assert.equal((await inboxMessages(simulator, recoveryRecipient)).length, 0);
    const recoveryIntent = Object.values(simulator.store.regionState(region).cognito.deliveryIntents)
      .find(intent => intent.poolId === recoveryPool.UserPool!.Id!);
    assert.equal(recoveryIntent?.status, "PENDING_DELIVERY");
    clock.advance(8 * 24 * 60 * 60 * 1_000);

    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId,
      authMode: "off",
      clock,
    });
    await simulator.start();
    active = clients(simulator);
    assert.equal(
      simulator.store.regionState(region).cognito.deliveryIntents[recoveryIntent!.id]?.status,
      "PENDING_DELIVERY",
      "unresolved delivery is never pruned by the terminal-intent retention pass",
    );
    assert.equal((await inboxMessages(simulator, recoveryRecipient)).length, 0);
    await verifyIdentity(simulator, active.ses, recoverySender);

    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId,
      authMode: "off",
      clock,
    });
    await simulator.start();
    active = clients(simulator);
    assert.equal(
      (await inboxMessages(simulator, recoveryRecipient)).length,
      1,
      "startup recovery retries the authenticated pending Cognito delivery after SES identity repair",
    );
  } finally {
    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-03 administrator invitations replay exactly, erase envelopes, replace credentials, suppress, and expire", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-admin-invite-recovery-"));
  const sender = "invite-sender@example.com";
  const sourceArn = `arn:aws:ses:${region}:${accountId}:identity/${sender}`;
  const clock = new TestClock(Date.parse("2026-07-25T12:00:00Z"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    accountId,
    authMode: "off",
    clock,
  });
  let active = clients(simulator);
  try {
    await simulator.start();
    active.cognito.destroy();
    active.ses.destroy();
    active = clients(simulator);
    const pool = await active.cognito.send(new CreateUserPoolCommand({
      PoolName: "administrator-invitations",
      UsernameAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: sourceArn,
      },
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
        InviteMessageTemplate: {
          EmailSubject: "Administrator invitation",
          EmailMessage: "Your username is {username} and temporary password is {####}.",
        },
      },
    }));
    const poolId = pool.UserPool!.Id!;
    const app = await active.cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "administrator-invitation-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    const callerEmail = "caller-invite@example.com";
    const callerPassword = "Caller-temporary-1!";
    await assert.rejects(
      active.cognito.send(new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: callerEmail,
        TemporaryPassword: callerPassword,
        UserAttributes: [{ Name: "email", Value: callerEmail }],
      })),
      (error: any) => error?.name === "CodeDeliveryFailureException",
    );
    const pending = Object.values(simulator.store.regionState(region).cognito.deliveryIntents)
      .find(intent => intent.purpose === "ADMIN_INVITATION" && intent.message.destination === callerEmail);
    assert.equal(pending?.status, "PENDING_DELIVERY");
    assert(pending?.credential.recoverableSecret);
    assert.equal(JSON.stringify(simulator.store.regionState(region).cognito).includes(callerPassword), false);
    assert.equal((await inboxMessages(simulator, callerEmail)).length, 0);

    await verifyIdentity(simulator, active.ses, sender);
    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId,
      authMode: "off",
      clock,
    });
    await simulator.start();
    active = clients(simulator);
    const replayed = await inboxMessages(simulator, callerEmail);
    assert.equal(replayed.length, 1);
    assert.match((await inboxDetail(simulator, replayed[0].messageId)).textBody ?? "", new RegExp(callerPassword));
    assert.equal(
      simulator.store.regionState(region).cognito.deliveryIntents[pending!.id]
        .credential.recoverableSecret,
      undefined,
    );

    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId,
      authMode: "off",
      clock,
    });
    await simulator.start();
    active = clients(simulator);
    assert.equal((await inboxMessages(simulator, callerEmail)).length, 1);

    const replacement = "Replacement-temporary-2!";
    await active.cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: callerEmail,
      TemporaryPassword: replacement,
      MessageAction: "RESEND",
      UserAttributes: [{ Name: "email", Value: callerEmail }],
    }));
    const callerMessages = await inboxMessages(simulator, callerEmail);
    assert.equal(callerMessages.length, 2);
    const replacementDelivery = (await Promise.all(
      callerMessages.map(message => inboxDetail(simulator, message.messageId)),
    )).find(message => message.textBody?.includes(replacement));
    assert(replacementDelivery);
    await assert.rejects(
      active.cognito.send(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: callerEmail, PASSWORD: callerPassword },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    assert.equal((await active.cognito.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: callerEmail, PASSWORD: replacement },
    }))).ChallengeName, "NEW_PASSWORD_REQUIRED");
    assert.equal(JSON.stringify(simulator.store.regionState(region).cognito).includes(replacement), false);

    const generatedEmail = "generated-invite@example.com";
    await active.cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: generatedEmail,
      UserAttributes: [{ Name: "email", Value: generatedEmail }],
    }));
    const generatedMessages = await inboxMessages(simulator, generatedEmail);
    assert.equal(generatedMessages.length, 1);
    const generatedBody = (await inboxDetail(simulator, generatedMessages[0].messageId)).textBody ?? "";
    const generatedPassword = /temporary password is ([^.]+)\./.exec(generatedBody)?.[1];
    assert(generatedPassword);
    const generatedIntent = Object.values(simulator.store.regionState(region).cognito.deliveryIntents)
      .find(intent => intent.purpose === "ADMIN_INVITATION" && intent.message.destination === generatedEmail);
    assert.equal(generatedIntent?.credential.recoverableSecret, undefined);

    const suppressedEmail = "suppressed-invite@example.com";
    await active.cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: suppressedEmail,
      TemporaryPassword: "Suppressed-temporary-3!",
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: suppressedEmail }],
    }));
    assert.equal((await inboxMessages(simulator, suppressedEmail)).length, 0);
    assert.equal(
      Object.values(simulator.store.regionState(region).cognito.deliveryIntents)
        .some(intent => intent.message.destination === suppressedEmail),
      false,
    );

    clock.advance(7 * 24 * 60 * 60 * 1_000);
    await assert.rejects(
      active.cognito.send(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: generatedEmail, PASSWORD: generatedPassword },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
  } finally {
    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-03 email MFA enforces delivery eligibility, recovery exclusion, purpose binding, expiry, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-email-mfa-"));
  const sender = "mfa-sender@example.com";
  const recipient = "email-mfa-user@example.com";
  const sourceArn = `arn:aws:ses:${region}:${accountId}:identity/${sender}`;
  const clock = new TestClock(Date.parse("2026-07-25T10:00:00Z"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    accountId,
    authMode: "off",
    clock,
  });
  let active = clients(simulator);
  try {
    await simulator.start();
    active.cognito.destroy();
    active.ses.destroy();
    active = clients(simulator);
    await verifyIdentity(simulator, active.ses, sender);

    const ineligible = await active.cognito.send(new CreateUserPoolCommand({
      PoolName: "default-email-mfa",
      UsernameAttributes: ["email"],
    }));
    await assert.rejects(
      active.cognito.send(new SetUserPoolMfaConfigCommand({
        UserPoolId: ineligible.UserPool!.Id!,
        MfaConfiguration: "OPTIONAL",
        EmailMfaConfiguration: {
          Subject: "Sign-in code",
          Message: "Your sign-in code is {####}.",
        },
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );

    const pool = await active.cognito.send(new CreateUserPoolCommand({
      PoolName: "eligible-email-mfa",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      UserPoolTier: "ESSENTIALS",
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: sourceArn,
      },
    }));
    const poolId = pool.UserPool!.Id!;
    const app = await active.cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "email-mfa-client",
      AuthSessionValidity: 3,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await active.cognito.send(new SignUpCommand({
      ClientId: clientId,
      Username: recipient,
      Password: password,
    }));
    const confirmationMessage = (await inboxMessages(simulator, recipient)).at(-1);
    assert(confirmationMessage);
    await active.cognito.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: recipient,
      ConfirmationCode: code(await inboxDetail(simulator, confirmationMessage.messageId)),
    }));
    const firstAuthentication = await active.cognito.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: recipient, PASSWORD: password },
    }));
    await active.cognito.send(new SetUserPoolMfaConfigCommand({
      UserPoolId: poolId,
      MfaConfiguration: "OPTIONAL",
      EmailMfaConfiguration: {
        Subject: "Sign-in code",
        Message: "Your sign-in code is {####}.",
      },
    }));
    await active.cognito.send(new SetUserMFAPreferenceCommand({
      AccessToken: firstAuthentication.AuthenticationResult!.AccessToken!,
      EmailMfaSettings: { Enabled: true, PreferredMfa: true },
    }));
    await assert.rejects(
      active.cognito.send(new ForgotPasswordCommand({
        ClientId: clientId,
        Username: recipient,
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );

    const challenged = await active.cognito.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: recipient, PASSWORD: password },
    }));
    assert.equal(challenged.ChallengeName, "EMAIL_OTP");
    const mfaDelivery = (await Promise.all(
      (await inboxMessages(simulator, recipient))
        .map(message => inboxDetail(simulator, message.messageId)),
    )).find(message => message.textBody?.includes("sign-in code"));
    assert(mfaDelivery);
    const mfaCode = code(mfaDelivery);

    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId,
      authMode: "off",
      clock,
    });
    await simulator.start();
    active = clients(simulator);
    await assert.rejects(
      active.cognito.send(new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: challenged.Session,
        ChallengeResponses: {
          USERNAME: recipient,
          SOFTWARE_TOKEN_MFA_CODE: mfaCode,
        },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await assert.rejects(
      active.cognito.send(new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "EMAIL_OTP",
        Session: challenged.Session,
        ChallengeResponses: { USERNAME: recipient, EMAIL_OTP_CODE: "000000" },
      })),
      (error: any) => error?.name === "CodeMismatchException",
    );
    const completed = await active.cognito.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "EMAIL_OTP",
      Session: challenged.Session,
      ChallengeResponses: { USERNAME: recipient, EMAIL_OTP_CODE: mfaCode },
    }));
    assert(completed.AuthenticationResult?.AccessToken);

    const expiring = await active.cognito.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: recipient, PASSWORD: password },
    }));
    assert.equal(expiring.ChallengeName, "EMAIL_OTP");
    const expiringDelivery = (await Promise.all(
      (await inboxMessages(simulator, recipient))
        .map(message => inboxDetail(simulator, message.messageId)),
    )).find(message => message.textBody?.includes("sign-in code"));
    assert(expiringDelivery);
    const expiringCode = code(expiringDelivery);
    clock.advance(3 * 60_000);
    await assert.rejects(
      active.cognito.send(new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "EMAIL_OTP",
        Session: expiring.Session,
        ChallengeResponses: { USERNAME: recipient, EMAIL_OTP_CODE: expiringCode },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
  } finally {
    active.cognito.destroy();
    active.ses.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
