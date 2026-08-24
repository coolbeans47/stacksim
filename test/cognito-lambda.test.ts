import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  ForgotPasswordCommand,
  GetUserAttributeVerificationCodeCommand,
  InitiateAuthCommand,
  ListUsersCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  AddPermissionCommand,
  CreateFunctionCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("COG-03 Cognito Lambda triggers enforce resource permission and safely customize users and tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-lambda-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  let cognito: CognitoIdentityProviderClient | undefined;
  let lambda: LambdaClient | undefined;
  let iam: IAMClient | undefined;
  let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cognito = new CognitoIdentityProviderClient({ endpoint, region, credentials, maxAttempts: 1 });
    lambda = new LambdaClient({ endpoint, region, credentials, maxAttempts: 1 });
    iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    logs = new CloudWatchLogsClient({ endpoint, region, credentials, maxAttempts: 1 });
    const role = await iam.send(new CreateRoleCommand({
      RoleName: "cognito-trigger",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "cognito-trigger",
      PolicyName: "write-trigger-logs",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          Resource: "*",
        }],
      }),
    }));
    const fn = await lambda.send(new CreateFunctionCommand({
      FunctionName: "cognito-trigger",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: role.Role!.Arn!,
      Timeout: 5,
      Code: {
        ZipFile: createZip([{
          name: "index.js",
          content: `
exports.handler = async event => {
  console.log(JSON.stringify(event));
  const metadata = event.request.clientMetadata || {};
  const identity = event.request.userAttributes.email || event.userName;
  if (
    metadata.assertSignupAttributes === "true"
    && ["PreSignUp_SignUp", "PostConfirmation_ConfirmSignUp"].includes(event.triggerSource)
  ) {
    const expected = {
      email: identity,
      given_name: "Ada",
      family_name: "Lovelace",
      "custom:company_name": "Example Terminal",
      "custom:company_type": "TERMINAL",
    };
    for (const [name, value] of Object.entries(expected)) {
      if (event.request.userAttributes[name] !== value) {
        throw new Error("signup attribute " + name + " was not propagated");
      }
    }
    if (
      event.triggerSource === "PostConfirmation_ConfirmSignUp"
      && (!event.request.userAttributes.sub || event.request.userAttributes.email_verified !== "true")
    ) {
      throw new Error("confirmed signup identity attributes were not propagated");
    }
    if (metadata.rejectAfterAttributes === "true") {
      throw new Error("attribute-complete signup rejected");
    }
  }
  if (identity.includes("function-error")) {
    throw new Error("validation denied");
  }
  if (identity.includes("timeout")) {
    await new Promise(() => {});
  }
  if (identity.includes("malformed-output")) {
    return "not-an-event";
  }
  if (event.triggerSource === "PreSignUp_SignUp") {
    if (identity.includes("custom-malformed")) return event;
    if (metadata.manual !== "true") {
      event.response.autoConfirmUser = true;
      event.response.autoVerifyEmail = true;
    }
  }
  if (event.triggerSource === "CustomMessage_SignUp") {
    event.response.emailSubject = "Lambda confirmation";
    event.response.emailMessage = identity.includes("custom-malformed")
      ? "missing the required placeholder"
      : "Confirmation code: {####}.";
  }
  if (event.triggerSource === "PreAuthentication_Authentication" && metadata.denyAuth === "true") {
    throw new Error("authentication denied");
  }
  if (event.triggerSource === "TokenGeneration_Authentication") {
    event.response.claimsOverrideDetails = {
      claimsToAddOrOverride: metadata.malformedToken === "true"
        ? { sub: "forbidden" }
        : { trigger_claim: "present" }
    };
  }
  if (event.triggerSource === "PostAuthentication_Authentication" && metadata.failPost === "true") {
    throw new Error("post authentication denied");
  }
  if (event.triggerSource.includes("Admin") && event.callerContext.clientId !== "CLIENT_ID_NOT_APPLICABLE") {
    throw new Error("admin client identity was invented");
  }
  return event;
};`,
        }]),
      },
    }));
    const functionArn = fn.FunctionArn!;
    const pool = await cognito.send(new CreateUserPoolCommand({
      PoolName: "lambda-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [
        { Name: "email", Required: true, Mutable: true },
        { Name: "given_name", Required: false, Mutable: true },
        { Name: "family_name", Required: false, Mutable: true },
        {
          Name: "company_name",
          AttributeDataType: "String",
          Mutable: false,
          StringAttributeConstraints: { MinLength: "1", MaxLength: "160" },
        },
        {
          Name: "company_type",
          AttributeDataType: "String",
          Mutable: false,
          StringAttributeConstraints: { MinLength: "6", MaxLength: "9" },
        },
      ],
      LambdaConfig: {
        PreSignUp: functionArn,
        CustomMessage: functionArn,
        PostConfirmation: functionArn,
        PreAuthentication: functionArn,
        PostAuthentication: functionArn,
        PreTokenGeneration: functionArn,
      },
    }));
    const poolId = pool.UserPool!.Id!;
    const poolArn = pool.UserPool!.Arn!;
    const app = await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "lambda-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      WriteAttributes: [
        "email",
        "given_name",
        "family_name",
        "custom:company_name",
        "custom:company_type",
      ],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await assert.rejects(
      cognito.send(new SignUpCommand({
        ClientId: clientId,
        Username: "denied@example.test",
        Password: "Valid-password-1!",
      })),
      (error: any) => error?.name === "UnexpectedLambdaException",
    );
    assert.equal((await cognito.send(new ListUsersCommand({ UserPoolId: poolId }))).Users?.length, 0);
    await lambda.send(new AddPermissionCommand({
      FunctionName: "cognito-trigger",
      StatementId: "allow-cognito-pool",
      Action: "lambda:InvokeFunction",
      Principal: "cognito-idp.amazonaws.com",
      SourceArn: poolArn,
      SourceAccount: "000000000000",
    }));
    for (const [username, errorName] of [
      ["function-error@example.test", "UserLambdaValidationException"],
      ["malformed-output@example.test", "InvalidLambdaResponseException"],
      ["timeout@example.test", "UnexpectedLambdaException"],
      ["custom-malformed@example.test", "InvalidLambdaResponseException"],
    ] as const) {
      await assert.rejects(
        cognito.send(new SignUpCommand({
          ClientId: clientId,
          Username: username,
          Password: "Valid-password-1!",
          ClientMetadata: { testCase: username },
        })),
        (error: any) => error?.name === errorName,
      );
    }
    assert.equal(
      (await cognito.send(new ListUsersCommand({ UserPoolId: poolId }))).Users?.length,
      0,
      "failed pre-sign-up/custom-message invocations roll back all user mutation",
    );
    const rejectedAttributeEmail = "attribute-rejected@example.test";
    await assert.rejects(
      cognito.send(new SignUpCommand({
        ClientId: clientId,
        Username: rejectedAttributeEmail,
        Password: "Valid-password-1!",
        UserAttributes: [
          { Name: "email", Value: rejectedAttributeEmail },
          { Name: "given_name", Value: "Ada" },
          { Name: "family_name", Value: "Lovelace" },
          { Name: "custom:company_name", Value: "Example Terminal" },
          { Name: "custom:company_type", Value: "TERMINAL" },
        ],
        ClientMetadata: {
          assertSignupAttributes: "true",
          rejectAfterAttributes: "true",
        },
      })),
      (error: any) => error?.name === "UserLambdaValidationException",
    );
    const rejectedState = simulator.store.regionState(region).cognito;
    assert.deepEqual(rejectedState.pools[poolId].usersBySub, {});
    assert.deepEqual(rejectedState.pools[poolId].usernameIndex, {});
    assert.deepEqual(rejectedState.deliveryIntents, {});
    const signup = await cognito.send(new SignUpCommand({
      ClientId: clientId,
      Username: "triggered@example.test",
      Password: "Valid-password-1!",
    }));
    assert.equal(signup.UserConfirmed, true);

    const manualEmail = "manual-confirm@example.test";
    const manual = await cognito.send(new SignUpCommand({
      ClientId: clientId,
      Username: manualEmail,
      Password: "Valid-password-1!",
      UserAttributes: [
        { Name: "email", Value: manualEmail },
        { Name: "given_name", Value: "Ada" },
        { Name: "family_name", Value: "Lovelace" },
        { Name: "custom:company_name", Value: "Example Terminal" },
        { Name: "custom:company_type", Value: "TERMINAL" },
      ],
      ClientMetadata: { manual: "true", assertSignupAttributes: "true" },
    }));
    assert.equal(manual.UserConfirmed, false);
    const inbox = await signedFetch(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(manualEmail)}&originService=cognito-idp`,
      { service: "ses", region, credentials, headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    assert.equal(inbox.messages.length, 1);
    const detail = await signedFetch(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(inbox.messages[0].messageId)}`,
      { service: "ses", region, credentials, headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    assert.equal(detail.message.subject, "Lambda confirmation");
    const confirmationCode = /\b(\d{6})\b/.exec(detail.message.textBody)?.[1];
    assert(confirmationCode);
    await cognito.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: manualEmail,
      ConfirmationCode: confirmationCode,
      ClientMetadata: { confirmTrace: "confirm-signup", assertSignupAttributes: "true" },
    }));

    const adminEmail = "admin-trigger@example.test";
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: adminEmail,
      TemporaryPassword: "Valid-temporary-1!",
      MessageAction: "SUPPRESS",
      ClientMetadata: { adminTrace: "create" },
      UserAttributes: [
        { Name: "email", Value: adminEmail },
        { Name: "email_verified", Value: "true" },
      ],
    }));
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: adminEmail,
      Password: "Valid-admin-password-2!",
      Permanent: true,
    }));
    await cognito.send(new AdminResetUserPasswordCommand({
      UserPoolId: poolId,
      Username: adminEmail,
      ClientMetadata: { adminTrace: "reset" },
    }));

    const persistedPool = simulator.store.regionState(region).cognito.pools[poolId];
    const baselineSessions = Object.keys(persistedPool.refreshSessions).length;
    const baselineEvents = persistedPool.authEvents.length;
    for (const [metadata, errorName] of [
      [{ denyAuth: "true" }, "UserLambdaValidationException"],
      [{ malformedToken: "true" }, "InvalidLambdaResponseException"],
      [{ failPost: "true" }, "UserLambdaValidationException"],
    ] as const) {
      await assert.rejects(
        cognito.send(new InitiateAuthCommand({
          ClientId: clientId,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: {
            USERNAME: manualEmail,
            PASSWORD: "Valid-password-1!",
          },
          ClientMetadata: metadata,
        })),
        (error: any) => error?.name === errorName,
      );
      assert.equal(Object.keys(persistedPool.refreshSessions).length, baselineSessions);
      assert.equal(persistedPool.authEvents.length, baselineEvents);
    }
    const authentication = await cognito.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: {
        USERNAME: "triggered@example.test",
        PASSWORD: "Valid-password-1!",
      },
      ClientMetadata: { trace: "lambda-test" },
    }));
    const idClaims = JSON.parse(
      Buffer.from(authentication.AuthenticationResult!.IdToken!.split(".")[1], "base64url").toString("utf8"),
    );
    assert.equal(idClaims.trigger_claim, "present");
    await cognito.send(new GetUserAttributeVerificationCodeCommand({
      AccessToken: authentication.AuthenticationResult!.AccessToken!,
      AttributeName: "email",
      ClientMetadata: { verifyTrace: "manual" },
    }));
    await cognito.send(new ForgotPasswordCommand({
      ClientId: clientId,
      Username: manualEmail,
      ClientMetadata: { forgotTrace: "request" },
    }));
    const recoveryInbox = await signedFetch(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(manualEmail)}&originService=cognito-idp&status=all&pageSize=100`,
      { service: "ses", region, credentials, headers: { "x-stacksim-region": region } },
    ).then(response => response.json()) as any;
    let recoveryCode: string | undefined;
    for (const descriptor of recoveryInbox.messages) {
      const recoveryDetail = await signedFetch(
        `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(descriptor.messageId)}`,
        { service: "ses", region, credentials, headers: { "x-stacksim-region": region } },
      ).then(response => response.json()) as any;
      if (recoveryDetail.message.subject === "Reset your password") {
        recoveryCode = /\b(\d{6})\b/.exec(recoveryDetail.message.textBody)?.[1];
      }
    }
    assert(recoveryCode);
    await cognito.send(new ConfirmForgotPasswordCommand({
      ClientId: clientId,
      Username: manualEmail,
      ConfirmationCode: recoveryCode,
      Password: "Recovered-lambda-password-3!",
      ClientMetadata: { confirmForgotTrace: "confirmed" },
    }));

    const triggerLogGroup = Object.keys(simulator.store.regionState(region).logs)
      .find(name => name.endsWith("/cognito-trigger"));
    assert(triggerLogGroup);
    const lambdaLogs = await logs.send(new FilterLogEventsCommand({
      logGroupName: triggerLogGroup,
    }));
    const combinedLogs = (lambdaLogs.events ?? []).map(event => event.message ?? "").join("\n");
    for (const source of [
      "PreSignUp_SignUp",
      "CustomMessage_SignUp",
      "PostConfirmation_ConfirmSignUp",
      "PostConfirmation_ConfirmForgotPassword",
      "PreAuthentication_Authentication",
      "TokenGeneration_Authentication",
      "PostAuthentication_Authentication",
    ]) {
      assert.match(combinedLogs, new RegExp(source));
    }
    assert.match(combinedLogs, /lambda-test/);
    assert.match(combinedLogs, /confirm-signup/);
    assert.match(combinedLogs, /confirmed/);
    assert.match(combinedLogs, /CustomMessage_VerifyUserAttribute/);
    assert.match(combinedLogs, /CLIENT_ID_NOT_APPLICABLE/);
    assert.match(
      combinedLogs,
      /"triggerSource":"PreSignUp_AdminCreateUser"[^\n]*"clientId":"CLIENT_ID_NOT_APPLICABLE"/,
    );
    assert.match(
      combinedLogs,
      /"triggerSource":"CustomMessage_ForgotPassword"[^\n]*"clientId":"CLIENT_ID_NOT_APPLICABLE"/,
    );
    assert.doesNotMatch(combinedLogs, /triggered@example\.test|manual-confirm@example\.test/);
    const metricNames = (await simulator.metrics.ListMetrics({ Namespace: "AWS/Cognito" }))
      .Metrics.map((descriptor: any) => descriptor.MetricName);
    assert(metricNames.includes("TriggerSuccessCount"));
    assert(metricNames.includes("TriggerFailureCount"));
    assert(metricNames.includes("TriggerDuration"));
  } finally {
    cognito?.destroy();
    lambda?.destroy();
    iam?.destroy();
    logs?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
