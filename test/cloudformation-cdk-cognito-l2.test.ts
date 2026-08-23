import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetPolicyCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const defaultVerificationMessage = "The verification code to your new account is {####}";
const updatedVerificationMessage = "Your updated verification code is {####}";

function synthesize(): Record<string, any> {
  const app = new App();
  const stack = new Stack(app, "CognitoL2Stack", { env: { account: accountId, region } });
  const postConfirmation = new lambda.Function(stack, "PostConfirmation", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async event => event;"),
  });
  const pool = new cognito.UserPool(stack, "UserPool", {
    userPoolName: "cognito-l2-users",
    selfSignUpEnabled: true,
    signInAliases: { email: true },
    autoVerify: { email: true },
    signInCaseSensitive: false,
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    standardAttributes: {
      email: { required: true, mutable: true },
      givenName: { required: true, mutable: true },
      familyName: { required: true, mutable: true },
    },
    customAttributes: {
      company_name: new cognito.StringAttribute({ minLen: 1, maxLen: 160, mutable: false }),
      company_type: new cognito.StringAttribute({ minLen: 6, maxLen: 9, mutable: false }),
      invited_company_id: new cognito.StringAttribute({ minLen: 36, maxLen: 36, mutable: false }),
    },
    passwordPolicy: {
      minLength: 12,
      requireDigits: true,
      requireLowercase: true,
      requireSymbols: true,
      requireUppercase: true,
      tempPasswordValidity: Duration.days(7),
    },
    lambdaTriggers: { postConfirmation },
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const client = pool.addClient("WebClient", {
    userPoolClientName: "cognito-l2-web",
    generateSecret: false,
    authFlows: { userPassword: true, userSrp: true },
    preventUserExistenceErrors: true,
    readAttributes: new cognito.ClientAttributes().withStandardAttributes({
      email: true,
      emailVerified: true,
      givenName: true,
      familyName: true,
    }),
    writeAttributes: new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, givenName: true, familyName: true })
      .withCustomAttributes("company_name", "company_type"),
  });
  new CfnOutput(stack, "UserPoolId", { value: pool.userPoolId });
  new CfnOutput(stack, "UserPoolClientId", { value: client.userPoolClientId });
  new CfnOutput(stack, "PostConfirmationName", { value: postConfirmation.functionName });
  return app.synth().getStackArtifact(stack.artifactId).template;
}

async function waitForStack(
  client: CloudFormationClient,
  clock: TestClock,
  stackName: string,
  terminalStatus: string,
): Promise<any> {
  for (let attempt = 0; attempt < 300; attempt++) {
    clock.advance(500);
    await new Promise(resolve => setTimeout(resolve, 5));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
      if (stack?.StackStatus === terminalStatus) return stack;
      if (stack?.StackStatus?.includes("FAILED") || stack?.StackStatus?.includes("ROLLBACK")) {
        throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
      }
    } catch (error: any) {
      if (terminalStatus === "DELETE_COMPLETE" && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  throw new Error(`Timed out waiting for ${terminalStatus}`);
}

test("repository-pinned CDK UserPool L2 defaults and Cognito trigger permission deploy", async () => {
  const template = synthesize();
  const resources = template.Resources as Record<string, { Type: string; Properties: Record<string, any> }>;
  const synthesizedPool = Object.values(resources).find(resource => resource.Type === "AWS::Cognito::UserPool");
  assert.ok(synthesizedPool);
  assert.equal(synthesizedPool.Properties.SmsVerificationMessage, defaultVerificationMessage);
  assert.equal(synthesizedPool.Properties.VerificationMessageTemplate.SmsMessage, defaultVerificationMessage);
  assert.deepEqual(synthesizedPool.Properties.AutoVerifiedAttributes, ["email"]);
  assert.deepEqual(synthesizedPool.Properties.AccountRecoverySetting, {
    RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }],
  });
  assert.deepEqual(
    synthesizedPool.Properties.Schema
      .filter((attribute: any) => ["email", "given_name", "family_name"].includes(attribute.Name))
      .map((attribute: any) => [attribute.Name, attribute.Required]),
    [["email", true], ["given_name", true], ["family_name", true]],
  );
  assert.deepEqual(
    synthesizedPool.Properties.Schema
      .filter((attribute: any) => ["company_name", "company_type", "invited_company_id"].includes(attribute.Name))
      .map((attribute: any) => [attribute.Name, attribute.Required]),
    [["company_name", undefined], ["company_type", undefined], ["invited_company_id", undefined]],
  );
  const synthesizedClient = Object.values(resources).find(resource => resource.Type === "AWS::Cognito::UserPoolClient");
  assert.ok(synthesizedClient);
  assert.deepEqual(synthesizedClient.Properties.AllowedOAuthFlows, ["implicit", "code"]);
  assert.deepEqual(synthesizedClient.Properties.CallbackURLs, ["https://example.com"]);
  const synthesizedPermission = Object.values(resources).find(resource =>
    resource.Type === "AWS::Lambda::Permission"
    && resource.Properties.Principal === "cognito-idp.amazonaws.com"
  );
  assert.ok(synthesizedPermission);
  assert.equal(synthesizedPermission.Properties.Action, "lambda:InvokeFunction");
  assert.deepEqual(synthesizedPermission.Properties.SourceArn, { "Fn::GetAtt": [
    Object.entries(resources).find(([, resource]) => resource === synthesizedPool)?.[0],
    "Arn",
  ] });

  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-cognito-l2-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    clock,
    authMode: "off",
  });
  let cloudformation: CloudFormationClient | undefined;
  let cognitoClient: CognitoIdentityProviderClient | undefined;
  let lambdaClient: LambdaClient | undefined;
  try {
    await simulator.start();
    const options = {
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      systemClockOffset: clock.now() - Date.now(),
      maxAttempts: 1,
    };
    cloudformation = new CloudFormationClient(options);
    cognitoClient = new CognitoIdentityProviderClient(options);
    lambdaClient = new LambdaClient(options);
    await assert.rejects(cognitoClient.send(new CreateUserPoolCommand({
      PoolName: "cognito-l2-sms-delivery-rejected",
      AutoVerifiedAttributes: ["phone_number"],
    })), /only email/i);
    await cloudformation.send(new CreateStackCommand({
      StackName: "cognito-l2-stack",
      TemplateBody: JSON.stringify(template),
      Capabilities: ["CAPABILITY_IAM"],
    }));
    const created = await waitForStack(cloudformation, clock, "cognito-l2-stack", "CREATE_COMPLETE");
    const outputs = Object.fromEntries(created.Outputs.map((output: any) => [output.OutputKey, output.OutputValue]));
    const described = await cognitoClient.send(new DescribeUserPoolCommand({ UserPoolId: outputs.UserPoolId }));
    assert.equal(described.UserPool?.SmsVerificationMessage, defaultVerificationMessage);
    assert.equal(described.UserPool?.VerificationMessageTemplate?.SmsMessage, defaultVerificationMessage);
    assert.deepEqual(described.UserPool?.AutoVerifiedAttributes, ["email"]);
    const describedSchema = new Map(described.UserPool?.SchemaAttributes?.map(attribute => [attribute.Name, attribute]));
    assert.equal(describedSchema.get("given_name")?.Required, true);
    assert.equal(describedSchema.get("family_name")?.Required, true);
    assert.equal(describedSchema.get("company_name")?.Required, false);
    assert.equal(describedSchema.get("company_type")?.Required, false);
    assert.equal(describedSchema.get("invited_company_id")?.Required, false);
    const describedClient = await cognitoClient.send(new DescribeUserPoolClientCommand({
      UserPoolId: outputs.UserPoolId,
      ClientId: outputs.UserPoolClientId,
    }));
    assert.ok(describedClient.UserPoolClient);
    assert.deepEqual(describedClient.UserPoolClient.CallbackURLs, ["https://example.com"]);
    const triggerPolicy = JSON.parse((await lambdaClient.send(new GetPolicyCommand({
      FunctionName: outputs.PostConfirmationName,
    }))).Policy!);
    assert.ok(triggerPolicy.Statement.some((statement: any) =>
      statement.Action === "lambda:InvokeFunction"
      && statement.Principal === "cognito-idp.amazonaws.com"
      && statement.Condition?.ArnLike?.["AWS:SourceArn"] === described.UserPool?.Arn
    ));

    const updatedTemplate = structuredClone(template);
    const updatedPool = Object.values(updatedTemplate.Resources as Record<string, any>)
      .find((resource: any) => resource.Type === "AWS::Cognito::UserPool") as any;
    updatedPool.Properties.SmsVerificationMessage = updatedVerificationMessage;
    updatedPool.Properties.VerificationMessageTemplate.SmsMessage = updatedVerificationMessage;
    await cloudformation.send(new UpdateStackCommand({
      StackName: "cognito-l2-stack",
      TemplateBody: JSON.stringify(updatedTemplate),
      Capabilities: ["CAPABILITY_IAM"],
    }));
    await waitForStack(cloudformation, clock, "cognito-l2-stack", "UPDATE_COMPLETE");
    const updated = await cognitoClient.send(new DescribeUserPoolCommand({ UserPoolId: outputs.UserPoolId }));
    assert.equal(updated.UserPool?.SmsVerificationMessage, updatedVerificationMessage);
    assert.equal(updated.UserPool?.VerificationMessageTemplate?.SmsMessage, updatedVerificationMessage);

    await cloudformation.send(new DeleteStackCommand({ StackName: "cognito-l2-stack" }));
    await waitForStack(cloudformation, clock, "cognito-l2-stack", "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy();
    cognitoClient?.destroy();
    lambdaClient?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
