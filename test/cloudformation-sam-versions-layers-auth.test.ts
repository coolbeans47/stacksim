import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APIGatewayClient, GetApiKeyCommand } from "@aws-sdk/client-api-gateway";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import { AdminConfirmSignUpCommand, CognitoIdentityProviderClient, InitiateAuthCommand, SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { GetAliasCommand, GetProvisionedConcurrencyConfigCommand, InvokeCommand, LambdaClient, ListLayerVersionsCommand, ListVersionsByFunctionCommand } from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createEventRuleProvider } from "../src/cloudformation/providers/eventbridge-resources.js";
import { ServerlessTransformError, expandServerlessTransform } from "../src/cloudformation/sam/index.js";
import { parseCloudFormationYaml } from "../src/cloudformation/yaml.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// sam-transform-design.md SAM-04 acceptance: a Cognito-authorized API, an
// AutoPublishAlias code change, and a layer consumed by a function.

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const bucket = "sam04-artifacts";
const capabilities = ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"] as const;

interface Fixture {
  simulator: StackSim;
  cloudformation: CloudFormationClient;
  s3: S3Client;
  lambda: LambdaClient;
  cognito: CognitoIdentityProviderClient;
  apigateway: APIGatewayClient;
}

async function withSimulator(prefix: string, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let fixture: Fixture | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    fixture = {
      simulator,
      cloudformation: new CloudFormationClient(options),
      s3: new S3Client({ ...options, forcePathStyle: true }),
      lambda: new LambdaClient(options),
      cognito: new CognitoIdentityProviderClient(options),
      apigateway: new APIGatewayClient(options),
    };
    await fixture.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await run(fixture);
  } finally {
    for (const client of fixture ? [fixture.cloudformation, fixture.s3, fixture.lambda, fixture.cognito, fixture.apigateway] : []) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** Create or update a SAM stack and wait for it, as `aws cloudformation deploy` does. */
async function deploy(fixture: Fixture, stackName: string, template: string): Promise<void> {
  const exists = await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: stackName })).then(() => true, () => false);
  if (exists) {
    await fixture.cloudformation.send(new UpdateStackCommand({ StackName: stackName, TemplateBody: template, Capabilities: [...capabilities] }));
    assert.equal((await waitUntilStackUpdateComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName })).state, "SUCCESS");
  } else {
    await fixture.cloudformation.send(new CreateStackCommand({ StackName: stackName, TemplateBody: template, Capabilities: [...capabilities] }));
    assert.equal((await waitUntilStackCreateComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName })).state, "SUCCESS");
  }
}

async function upload(fixture: Fixture, key: string, files: Array<{ name: string; content: string }>): Promise<string> {
  await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createZip(files) }));
  return `s3://${bucket}/${key}`;
}

async function physicalId(fixture: Fixture, stackName: string, logicalId: string): Promise<string> {
  return (await fixture.cloudformation.send(new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: logicalId }))).StackResourceDetail!.PhysicalResourceId!;
}

async function processed(fixture: Fixture, stackName: string): Promise<{ Resources: Record<string, any> }> {
  return JSON.parse(String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Processed" }))).TemplateBody));
}

async function invokeText(fixture: Fixture, functionName: string, qualifier?: string): Promise<string> {
  const response = await fixture.lambda.send(new InvokeCommand({ FunctionName: functionName, ...(qualifier ? { Qualifier: qualifier } : {}) }));
  assert.equal(response.FunctionError, undefined, Buffer.from(response.Payload ?? []).toString());
  return JSON.parse(Buffer.from(response.Payload!).toString());
}

/** Call the host-based local execute-api endpoint `{apiId}.execute-api.localhost:{invokePort}`. */
function call(fixture: Fixture, apiId: string, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const port = fixture.simulator.invokePort;
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host: `${apiId}.execute-api.localhost:${port}`, ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("a Cognito-authorized SAM API rejects requests without a token, accepts a User Pool token, and serves its CORS preflight and API key method", async () => {
  await withSimulator("stacksim-sam04-cognito-", async fixture => {
    const code = await upload(fixture, "api.zip", [{ name: "index.mjs", content: "export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ path: event.path, user: event.requestContext.authorizer?.claims?.['cognito:username'] ?? null }) });\n" }]);
    const template = `Transform: AWS::Serverless-2016-10-31
Resources:
  UserPool:
    Type: AWS::Cognito::UserPool
  UserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      UserPoolId: !Ref UserPool
      ExplicitAuthFlows: [ALLOW_USER_PASSWORD_AUTH, ALLOW_REFRESH_TOKEN_AUTH]
  MyApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: Prod
      Cors: "'*'"
      Auth:
        DefaultAuthorizer: CognitoAuthorizer
        AddDefaultAuthorizerToCorsPreflight: false
        Authorizers:
          CognitoAuthorizer:
            UserPoolArn: !GetAtt UserPool.Arn
        UsagePlan:
          CreateUsagePlan: PER_API
  HelloFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ${code}
      Handler: index.handler
      Runtime: nodejs22.x
      Events:
        Hello:
          Type: Api
          Properties:
            RestApiId: !Ref MyApi
            Path: /hello
            Method: get
        Keyed:
          Type: Api
          Properties:
            RestApiId: !Ref MyApi
            Path: /keyed
            Method: get
            Auth:
              Authorizer: NONE
              ApiKeyRequired: true
Outputs:
  UserPoolId:
    Value: !Ref UserPool
  ClientId:
    Value: !Ref UserPoolClient
  KeyId:
    Value: !Ref MyApi.ApiKey
`;
    await deploy(fixture, "cognito-api", template);
    const resources = (await processed(fixture, "cognito-api")).Resources;
    assert.deepEqual(Object.keys(resources).filter(id => /^MyApi/.test(id)).map(id => id.replace(/Deployment[0-9a-f]{10}$/, "DeploymentHASH")).sort(), [
      "MyApi", "MyApiApiKey", "MyApiDeploymentHASH", "MyApiProdStage", "MyApiUsagePlan", "MyApiUsagePlanKey",
    ]);
    assert.equal(resources.MyApi.Properties.Body.securityDefinitions.CognitoAuthorizer["x-amazon-apigateway-authtype"], "cognito_user_pools");

    const apiId = await physicalId(fixture, "cognito-api", "MyApi");
    const stack = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: "cognito-api" }))).Stacks![0];
    const output = (key: string) => stack.Outputs!.find(item => item.OutputKey === key)!.OutputValue!;

    const anonymous = await call(fixture, apiId, "GET", "/Prod/hello");
    assert.equal(anonymous.status, 401);
    assert.deepEqual(JSON.parse(anonymous.body), { message: "Unauthorized" });
    assert.equal((await call(fixture, apiId, "GET", "/Prod/hello", { authorization: "not-a-token" })).status, 401);

    const password = "Passw0rd!Passw0rd";
    await fixture.cognito.send(new SignUpCommand({ ClientId: output("ClientId"), Username: "alice", Password: password }));
    await fixture.cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: output("UserPoolId"), Username: "alice" }));
    const tokens = (await fixture.cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: output("ClientId"), AuthParameters: { USERNAME: "alice", PASSWORD: password } }))).AuthenticationResult!;
    const authorized = await call(fixture, apiId, "GET", "/Prod/hello", { authorization: tokens.IdToken! });
    assert.equal(authorized.status, 200, authorized.body);
    assert.deepEqual(JSON.parse(authorized.body), { path: "/hello", user: "alice" });

    // The generated OPTIONS mock answers the preflight without a token.
    const preflight = await call(fixture, apiId, "OPTIONS", "/Prod/hello");
    assert.equal(preflight.status, 200);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.equal(preflight.headers["access-control-allow-methods"], "GET,OPTIONS");

    // Authorizer NONE opts out of the default authorizer; ApiKeyRequired needs the usage plan's key.
    assert.equal((await call(fixture, apiId, "GET", "/Prod/keyed")).status, 403);
    const key = await fixture.apigateway.send(new GetApiKeyCommand({ apiKey: output("KeyId"), includeValue: true }));
    const keyed = await call(fixture, apiId, "GET", "/Prod/keyed", { "x-api-key": key.value! });
    assert.equal(keyed.status, 200, keyed.body);
    assert.deepEqual(JSON.parse(keyed.body), { path: "/keyed", user: null });
  });
});

test("an AutoPublishAlias code change publishes a new version, moves the alias, and retains the old version", async () => {
  await withSimulator("stacksim-sam04-alias-", async fixture => {
    const template = (codeUri: string) => `Transform: AWS::Serverless-2016-10-31
Resources:
  VersionedFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ${codeUri}
      Handler: index.handler
      Runtime: nodejs22.x
      AutoPublishAlias: live
      VersionDescription: published by SAM
      ProvisionedConcurrencyConfig:
        ProvisionedConcurrentExecutions: 1
Outputs:
  AliasArn:
    Value: !Ref VersionedFunction.Alias
  VersionArn:
    Value: !Ref VersionedFunction.Version
`;
    const source = (text: string) => [{ name: "index.mjs", content: `export const handler = async () => ${JSON.stringify(text)};\n` }];
    await deploy(fixture, "alias", template(await upload(fixture, "v1.zip", source("first"))));
    const functionName = await physicalId(fixture, "alias", "VersionedFunction");
    const first = (await processed(fixture, "alias")).Resources;
    const firstVersionId = Object.keys(first).find(id => id.startsWith("VersionedFunctionVersion"))!;
    assert.equal(first[firstVersionId].DeletionPolicy, "Retain");
    assert.deepEqual(first.VersionedFunctionAliaslive.Properties.FunctionVersion, { "Fn::GetAtt": [firstVersionId, "Version"] });
    assert.equal((await fixture.lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: "live" }))).FunctionVersion, "1");
    assert.equal(await invokeText(fixture, functionName, "live"), "first");
    assert.equal((await fixture.lambda.send(new GetProvisionedConcurrencyConfigCommand({ FunctionName: functionName, Qualifier: "live" }))).RequestedProvisionedConcurrentExecutions, 1);
    const outputs = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: "alias" }))).Stacks![0].Outputs!;
    assert.equal(outputs.find(item => item.OutputKey === "AliasArn")!.OutputValue, `arn:aws:lambda:${region}:000000000000:function:${functionName}:live`);
    assert.equal(outputs.find(item => item.OutputKey === "VersionArn")!.OutputValue, `arn:aws:lambda:${region}:000000000000:function:${functionName}:1`);

    // A code change hashes to a new version logical ID: CloudFormation publishes version 2 and moves the alias.
    await deploy(fixture, "alias", template(await upload(fixture, "v2.zip", source("second"))));
    const second = (await processed(fixture, "alias")).Resources;
    const secondVersionId = Object.keys(second).find(id => id.startsWith("VersionedFunctionVersion"))!;
    assert.notEqual(secondVersionId, firstVersionId);
    assert.equal((await fixture.lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: "live" }))).FunctionVersion, "2");
    assert.equal(await invokeText(fixture, functionName, "live"), "second");

    // The old version left the template but its DeletionPolicy Retain kept it.
    const versions = (await fixture.lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionName }))).Versions!;
    assert.deepEqual(versions.map(version => version.Version), ["$LATEST", "1", "2"]);
    assert.deepEqual(versions.filter(version => version.Version !== "$LATEST").map(version => version.Description), ["published by SAM", "published by SAM"]);
    assert.equal(await invokeText(fixture, functionName, "1"), "first");
  });
});

test("an AWS::Serverless::LayerVersion is consumed by a function, and a new layer version keeps the old one", async () => {
  await withSimulator("stacksim-sam04-layer-", async fixture => {
    const layer = (greeting: string) => [{ name: "nodejs/node_modules/greeting/index.js", content: `exports.greet = (name) => ${JSON.stringify(greeting)} + ", " + name;\n` }];
    const code = await upload(fixture, "fn.zip", [{ name: "index.js", content: "const { greet } = require('greeting');\nexports.handler = async () => greet('layer');\n" }]);
    const template = (contentUri: string) => `Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Layers:
      - !Ref GreetingLayer
Resources:
  GreetingLayer:
    Type: AWS::Serverless::LayerVersion
    Properties:
      LayerName: greeting
      ContentUri: ${contentUri}
      CompatibleRuntimes: [nodejs22.x]
  GreeterFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ${code}
      Handler: index.handler
      Runtime: nodejs22.x
`;
    await deploy(fixture, "layer", template(await upload(fixture, "layer-v1.zip", layer("hello"))));
    const resources = (await processed(fixture, "layer")).Resources;
    const layerId = Object.keys(resources).find(id => /^GreetingLayer[0-9a-f]{10}$/.test(id))!;
    assert.equal(resources[layerId].DeletionPolicy, "Retain");
    assert.deepEqual(resources.GreeterFunction.Properties.Layers, [{ Ref: layerId }]);
    const functionName = await physicalId(fixture, "layer", "GreeterFunction");
    assert.equal(await invokeText(fixture, functionName), "hello, layer");

    await deploy(fixture, "layer", template(await upload(fixture, "layer-v2.zip", layer("bonjour"))));
    assert.equal(await invokeText(fixture, functionName), "bonjour, layer");
    const versions = (await fixture.lambda.send(new ListLayerVersionsCommand({ LayerName: "greeting" }))).LayerVersions!.map(version => version.Version).sort();
    assert.deepEqual(versions, [1, 2], "the retained first layer version still exists");
  });
});

function transformError(template: string): ServerlessTransformError {
  try {
    expandServerlessTransform(parseCloudFormationYaml(template) as Record<string, unknown>, { region, partition: "aws", accountId: "123456789012" });
  } catch (error) {
    assert.ok(error instanceof ServerlessTransformError, String(error));
    return error;
  }
  assert.fail("expected a transform error");
}

test("AutoPublishAlias companions report SAM's errors when the alias is missing", () => {
  const fn = (extra: string) => `Transform: AWS::Serverless-2016-10-31
Resources:
  MinimalFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: s3://bucket/key
      Handler: index.handler
      Runtime: nodejs22.x
${extra}`;
  assert.equal(transformError(fn("      ProvisionedConcurrencyConfig:\n        ProvisionedConcurrentExecutions: 1\n")).causes.join(" "),
    "Resource with id [MinimalFunction] is invalid. To set ProvisionedConcurrencyConfig AutoPublishALias must be defined on the function");
  assert.equal(transformError(fn("      VersionDeletionPolicy: Delete\n")).causes.join(" "), "Resource with id [MinimalFunction] is invalid. 'VersionDeletionPolicy' requires 'AutoPublishAlias'.");
  assert.equal(transformError(fn("      AutoPublishAlias: live\n      VersionDeletionPolicy: Forever\n")).causes.join(" "),
    "Resource with id [MinimalFunction] is invalid. Property 'VersionDeletionPolicy' should be a one of the strings: 'Delete' or 'Retain'.");
});

test("AWS::Events::Rule accepts Step Functions targets with the role EventBridge assumes", () => {
  const provider = createEventRuleProvider({} as never);
  const context = { accountId: "000000000000", region, partition: "aws" } as ProviderContext;
  const issues = (target: Record<string, unknown>) => provider.validate({ ScheduleExpression: "rate(1 hour)", Targets: [{ Id: "t", ...target }] }, context).map(issue => `${issue.path}: ${issue.message}`);
  const stateMachine = `arn:aws:states:${region}:000000000000:stateMachine:Trader`;
  assert.deepEqual(issues({ Arn: stateMachine, RoleArn: "arn:aws:iam::000000000000:role/events" }), []);
  assert.deepEqual(issues({ Arn: stateMachine }), ["Properties.Targets.0.RoleArn: A Step Functions target requires the ARN of an IAM role that EventBridge can assume"]);
  assert.deepEqual(issues({ Arn: `arn:aws:lambda:${region}:000000000000:function:f`, RoleArn: "arn:aws:iam::000000000000:role/events" }), ["Properties.Targets.0.RoleArn: RoleArn applies only to Step Functions targets"]);
  // SAM-06: standard queues and topics are targets too; FIFO ones and other families are not.
  assert.deepEqual(issues({ Arn: `arn:aws:sqs:${region}:000000000000:queue` }), []);
  assert.deepEqual(issues({ Arn: `arn:aws:sns:${region}:000000000000:topic` }), []);
  assert.deepEqual(issues({ Arn: `arn:aws:sqs:${region}:000000000000:queue`, RoleArn: "arn:aws:iam::000000000000:role/events" }), ["Properties.Targets.0.RoleArn: RoleArn applies only to Step Functions targets"]);
  assert.deepEqual(issues({ Arn: `arn:aws:sqs:${region}:000000000000:queue.fifo` }), ["Properties.Targets.0.Arn: FIFO queue and topic targets need SqsParameters, which this simulator's AWS::Events::Rule does not support yet"]);
  assert.deepEqual(issues({ Arn: `arn:aws:events:${region}:000000000000:event-bus/other` }), ["Properties.Targets.0.Arn: Rule targets must identify a Lambda function, a Step Functions state machine, a standard SQS queue, or a standard SNS topic in this simulator account and Region; other target families belong to later EventBridge phases"]);
});

test("an HTTP API JWT authorizer, a REST Lambda TOKEN authorizer, and a state machine Api event deploy and enforce as expanded", async () => {
  await withSimulator("stacksim-sam04-authorizers-", async fixture => {
    const app = await upload(fixture, "app.zip", [{ name: "index.mjs", content: "export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ route: event.routeKey ?? event.resource }) });\n" }]);
    const authorizer = await upload(fixture, "authorizer.zip", [{ name: "index.js", content: "exports.handler = async (event) => ({ principalId: 'caller', policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: event.authorizationToken === 'allow' ? 'Allow' : 'Deny', Resource: event.methodArn }] } });\n" }]);
    const template = `Transform: AWS::Serverless-2016-10-31
Resources:
  UserPool:
    Type: AWS::Cognito::UserPool
  UserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      UserPoolId: !Ref UserPool
      ExplicitAuthFlows: [ALLOW_USER_PASSWORD_AUTH, ALLOW_REFRESH_TOKEN_AUTH]
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      Auth:
        DefaultAuthorizer: UserPoolJwt
        Authorizers:
          UserPoolJwt:
            IdentitySource: $request.header.Authorization
            JwtConfiguration:
              issuer: !Sub https://cognito-idp.\${AWS::Region}.amazonaws.com/\${UserPool}
              audience:
                - !Ref UserPoolClient
  RestApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: Prod
      Auth:
        DefaultAuthorizer: TokenAuth
        Authorizers:
          TokenAuth:
            FunctionArn: !GetAtt TokenAuthorizerFunction.Arn
  TokenAuthorizerFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ${authorizer}
      Handler: index.handler
      Runtime: nodejs22.x
  AppFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ${app}
      Handler: index.handler
      Runtime: nodejs22.x
      Events:
        Http:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /me
            Method: GET
        Rest:
          Type: Api
          Properties:
            RestApiId: !Ref RestApi
            Path: /me
            Method: get
  Workflow:
    Type: AWS::Serverless::StateMachine
    Properties:
      Definition:
        StartAt: Done
        States:
          Done:
            Type: Pass
            End: true
      Events:
        Start:
          Type: Api
          Properties:
            RestApiId: !Ref RestApi
            Path: /start
            Method: post
            Auth:
              Authorizer: NONE
Outputs:
  UserPoolId:
    Value: !Ref UserPool
  ClientId:
    Value: !Ref UserPoolClient
`;
    await deploy(fixture, "authorizers", template);
    const resources = (await processed(fixture, "authorizers")).Resources;
    assert.equal(resources.RestApiTokenAuthAuthorizerPermission.Type, "AWS::Lambda::Permission");
    assert.equal(resources.WorkflowStartRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service[0], "apigateway.amazonaws.com");
    const stack = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: "authorizers" }))).Stacks![0];
    const output = (key: string) => stack.Outputs!.find(item => item.OutputKey === key)!.OutputValue!;

    // HTTP API: the JWT authorizer validates User Pool ID tokens for the client audience.
    const httpApiId = await physicalId(fixture, "authorizers", "HttpApi");
    assert.equal((await call(fixture, httpApiId, "GET", "/me")).status, 401);
    const password = "Passw0rd!Passw0rd";
    await fixture.cognito.send(new SignUpCommand({ ClientId: output("ClientId"), Username: "bob", Password: password }));
    await fixture.cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: output("UserPoolId"), Username: "bob" }));
    const tokens = (await fixture.cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: output("ClientId"), AuthParameters: { USERNAME: "bob", PASSWORD: password } }))).AuthenticationResult!;
    const viaJwt = await call(fixture, httpApiId, "GET", "/me", { authorization: `Bearer ${tokens.IdToken!}` });
    assert.equal(viaJwt.status, 200, viaJwt.body);
    assert.deepEqual(JSON.parse(viaJwt.body), { route: "GET /me" });

    // REST API: the TOKEN authorizer's policy decides.
    const restApiId = await physicalId(fixture, "authorizers", "RestApi");
    assert.equal((await call(fixture, restApiId, "GET", "/Prod/me")).status, 401);
    assert.equal((await call(fixture, restApiId, "GET", "/Prod/me", { authorization: "deny" })).status, 403);
    const allowed = await call(fixture, restApiId, "GET", "/Prod/me", { authorization: "allow" });
    assert.equal(allowed.status, 200, allowed.body);

    // The state machine event's StartExecution integration passes the body as the execution input.
    const started = await new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
      const port = fixture.simulator.invokePort;
      const outgoing = request({ host: "127.0.0.1", port, method: "POST", path: "/Prod/start", headers: { host: `${restApiId}.execute-api.localhost:${port}`, "content-type": "application/json" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify({ order: 7 }));
    });
    assert.equal(started.status, 200, started.body);
    const executionArn = JSON.parse(started.body).executionArn as string;
    assert.match(executionArn, /^arn:aws:states:eu-west-1:000000000000:execution:/);
    const sfn = new SFNClient({ endpoint: `http://127.0.0.1:${fixture.simulator.port}`, region, credentials, maxAttempts: 1 });
    try {
      assert.deepEqual(JSON.parse((await sfn.send(new DescribeExecutionCommand({ executionArn }))).input!), { order: 7 });
    } finally { sfn.destroy(); }
  });
});

/** SigV4 headers for a GET to the local execute-api endpoint. */
function signedHeaders(urlValue: string, signer: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }, date: Date): Record<string, string> {
  const url = new URL(urlValue);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update("").digest("hex");
  const values: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...(signer.sessionToken ? { "x-amz-security-token": signer.sessionToken } : {}) };
  const names = Object.keys(values).sort();
  const canonicalRequest = `GET\n${url.pathname}\n\n${names.map(name => `${name}:${values[name]}\n`).join("")}\n${names.join(";")}\n${payloadHash}`;
  const scope = `${shortDate}/${region}/execute-api/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const signature = createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${signer.secretAccessKey}`, shortDate), region), "execute-api"), "aws4_request")).update(stringToSign).digest("hex");
  const headers = Object.fromEntries(Object.entries(values).filter(([name]) => name !== "host"));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${signer.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}

test("an AWS_IAM-authorized SAM API invokes its function with the caller's credentials, as SAM's CALLER_CREDENTIALS integration does", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam04-iam-api-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const options = () => ({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const cloudformation = new CloudFormationClient(options()); const iam = new IAMClient(options()); const sts = new STSClient(options());
    clients.push(cloudformation, iam, sts);
    const template = `Transform: AWS::Serverless-2016-10-31
Resources:
  IamApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: Prod
      Auth:
        DefaultAuthorizer: AWS_IAM
  SecureFunction:
    Type: AWS::Serverless::Function
    Properties:
      InlineCode: "exports.handler = async (event) => ({ statusCode: 200, body: event.requestContext.identity.userArn });"
      Handler: index.handler
      Runtime: nodejs22.x
      Events:
        Get:
          Type: Api
          Properties:
            RestApiId: !Ref IamApi
            Path: /secure
            Method: get
`;
    const expanded = expandServerlessTransform(parseCloudFormationYaml(template) as Record<string, unknown>, { region, partition: "aws", accountId: "000000000000" }) as { Resources: Record<string, any> };
    assert.equal(expanded.Resources.IamApi.Properties.Body.paths["/secure"].get["x-amazon-apigateway-integration"].credentials, "arn:aws:iam::*:user/*");
    await cloudformation.send(new CreateStackCommand({ StackName: "iam-api", TemplateBody: template, Capabilities: [...capabilities] }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: "iam-api" })).state, "SUCCESS");
    const apiId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "iam-api", LogicalResourceId: "IamApi" }))).StackResourceDetail!.PhysicalResourceId!;
    const functionName = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "iam-api", LogicalResourceId: "SecureFunction" }))).StackResourceDetail!.PhysicalResourceId!;
    const url = `http://127.0.0.1:${simulator.invokePort}/${apiId}/Prod/secure`;
    assert.equal((await fetch(url)).status, 403, "an unsigned request is refused");

    // A caller allowed to invoke the API but not the function gets API Gateway's configuration error.
    await iam.send(new CreateRoleCommand({ RoleName: "api-caller", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }) }));
    await iam.send(new PutRolePolicyCommand({ RoleName: "api-caller", PolicyName: "invoke-api", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }] }) }));
    const session = async () => { const assumed = (await sts.send(new AssumeRoleCommand({ RoleArn: "arn:aws:iam::000000000000:role/api-caller", RoleSessionName: "caller" }))).Credentials!; return { accessKeyId: assumed.AccessKeyId!, secretAccessKey: assumed.SecretAccessKey!, sessionToken: assumed.SessionToken! }; };
    const denied = await fetch(url, { headers: signedHeaders(url, await session(), new Date()) });
    assert.equal(denied.status, 500);
    assert.deepEqual(await denied.json(), { message: "Internal server error" });

    // With lambda:InvokeFunction on the function, API Gateway invokes it as the caller.
    await iam.send(new PutRolePolicyCommand({ RoleName: "api-caller", PolicyName: "invoke-function", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: `arn:aws:lambda:${region}:000000000000:function:${functionName}` }] }) }));
    const allowed = await fetch(url, { headers: signedHeaders(url, await session(), new Date()) });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /^arn:aws:sts::000000000000:assumed-role\/api-caller\/caller$/);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
