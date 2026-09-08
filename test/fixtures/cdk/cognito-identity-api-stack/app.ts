import { App, CfnOutput, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const stack = new Stack(app, "CognitoIdentityApiStack", {
  env: { account, region },
  description: "Pinned StackSim CID-01 Cognito Identity L1 fixture",
});

const userPool = new cognito.UserPool(stack, "Users", {
  userPoolName: "cid01-users",
  signInAliases: { email: true },
  selfSignUpEnabled: true,
  autoVerify: { email: true },
  accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
});
const client = userPool.addClient("Web", {
  userPoolClientName: "cid01-web",
  generateSecret: false,
  authFlows: { userPassword: true, userSrp: true },
  preventUserExistenceErrors: true,
});

const identityPool = new cognito.CfnIdentityPool(stack, "Identities", {
  allowUnauthenticatedIdentities: false,
  identityPoolName: "cid01_identities",
  cognitoIdentityProviders: [{
    clientId: client.userPoolClientId,
    providerName: userPool.userPoolProviderName,
    serverSideTokenCheck: false,
  }],
});

const authenticatedRole = new iam.Role(stack, "Authenticated", {
  assumedBy: new iam.FederatedPrincipal(
    "cognito-identity.amazonaws.com",
    {
      StringEquals: { "cognito-identity.amazonaws.com:aud": identityPool.ref },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
    },
    "sts:AssumeRoleWithWebIdentity",
  ),
});

const api = new apigateway.RestApi(stack, "Api", {
  restApiName: "cid01-api",
  cloudWatchRole: false,
});
api.root.addMethod("GET", new apigateway.MockIntegration({
  integrationResponses: [{ statusCode: "200", responseTemplates: { "application/json": '{"ok":true}' } }],
  requestTemplates: { "application/json": '{"statusCode":200}' },
}), {
  authorizationType: apigateway.AuthorizationType.IAM,
  methodResponses: [{ statusCode: "200" }],
});
authenticatedRole.addToPolicy(new iam.PolicyStatement({
  actions: ["execute-api:Invoke"],
  resources: [api.arnForExecuteApi()],
}));

new cognito.CfnIdentityPoolRoleAttachment(stack, "Roles", {
  identityPoolId: identityPool.ref,
  roles: { authenticated: authenticatedRole.roleArn },
});

new CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
new CfnOutput(stack, "UserPoolClientId", { value: client.userPoolClientId });
new CfnOutput(stack, "IdentityPoolId", { value: identityPool.ref });
new CfnOutput(stack, "AuthenticatedRoleArn", { value: authenticatedRole.roleArn });
new CfnOutput(stack, "ApiId", { value: api.restApiId });
new CfnOutput(stack, "ApiUrl", { value: api.url });
