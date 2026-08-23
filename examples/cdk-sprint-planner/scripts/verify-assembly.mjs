import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";

const config = await loadConfig();
const out = join(projectRoot, "cdk.out");
const files = (await readdir(out)).filter(name => name.endsWith(".template.json"));
if (files.length !== 3) throw new Error(`Expected three synthesized templates, found ${files.length}`);
const templates = Object.fromEntries(await Promise.all(files.map(async name => [name, JSON.parse(await readFile(join(out, name), "utf8"))])));
const resources = Object.values(templates).flatMap(template => Object.entries(template.Resources ?? {}).map(([logicalId, resource]) => ({ logicalId, ...resource })));
const types = new Set(resources.map(resource => resource.Type));
const allowed = new Set([
  "AWS::ApiGatewayV2::Api", "AWS::ApiGatewayV2::Authorizer", "AWS::ApiGatewayV2::Integration",
  "AWS::ApiGatewayV2::Route", "AWS::ApiGatewayV2::Stage", "AWS::CDK::Metadata",
  "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Dashboard", "AWS::DynamoDB::Table",
  "AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient",
  "AWS::Events::EventBus", "AWS::Events::Rule", "AWS::IAM::Policy", "AWS::IAM::Role",
  "AWS::Lambda::EventInvokeConfig", "AWS::Lambda::EventSourceMapping", "AWS::Lambda::Function",
  "AWS::Lambda::LayerVersion", "AWS::Lambda::Permission", "AWS::Logs::LogGroup",
  "AWS::Logs::MetricFilter", "AWS::Logs::QueryDefinition", "AWS::S3::Bucket", "AWS::S3::BucketPolicy",
  "AWS::SES::ConfigurationSet", "AWS::SES::EmailIdentity", "AWS::SES::Template",
  "AWS::SQS::Queue", "Custom::CDKBucketDeployment",
]);
for (const type of types) if (!allowed.has(type)) throw new Error(`Unsupported synthesized resource type: ${type}`);
const userPool = resources.find(resource => resource.Type === "AWS::Cognito::UserPool");
const appClient = resources.find(resource => resource.Type === "AWS::Cognito::UserPoolClient");
if (!userPool || !appClient) throw new Error("The application stack must own a Cognito user pool and app client");
const smsVerificationMessage = userPool.Properties.SmsVerificationMessage;
if (!smsVerificationMessage || userPool.Properties.VerificationMessageTemplate?.SmsMessage !== smsVerificationMessage) {
  throw new Error("The pinned UserPool L2 SMS compatibility defaults are missing or inconsistent");
}
if (JSON.stringify(userPool.Properties.AutoVerifiedAttributes) !== JSON.stringify(["email"])) {
  throw new Error("The Cognito user pool must keep auto-verification email-only");
}
if (JSON.stringify(userPool.Properties.AccountRecoverySetting?.RecoveryMechanisms) !== JSON.stringify([{ Name: "verified_email", Priority: 1 }])) {
  throw new Error("The Cognito user pool must keep account recovery email-only");
}
if (appClient.Properties.UserPoolId?.Ref !== userPool.logicalId) throw new Error("The Cognito app client does not reference the synthesized user pool");
const authorizers = resources.filter(resource => resource.Type === "AWS::ApiGatewayV2::Authorizer");
const jwt = authorizers.find(resource => resource.Properties.AuthorizerType === "JWT");
if (!jwt || !JSON.stringify(jwt.Properties.JwtConfiguration?.Issuer).includes(userPool.logicalId)) throw new Error("HTTP JWT authorizer does not reference the owned Cognito user pool");
if (jwt.Properties.JwtConfiguration?.Audience?.[0]?.Ref !== appClient.logicalId) throw new Error("HTTP JWT authorizer does not reference the owned Cognito app client");
const httpStage = resources.find(resource => resource.Type === "AWS::ApiGatewayV2::Stage" && resource.Properties.StageName === "$default");
if (!httpStage?.Properties.AutoDeploy || httpStage.Properties.DefaultRouteSettings?.ThrottlingBurstLimit !== 50 || httpStage.Properties.DefaultRouteSettings?.ThrottlingRateLimit !== 25) {
  throw new Error("HTTP $default stage settings drifted");
}
if (httpStage.Properties.RouteSettings?.["POST /invitations/inspect"]?.ThrottlingBurstLimit !== 5) throw new Error("Invitation inspection throttle override is missing");
const webSocketStage = resources.find(resource => resource.Type === "AWS::ApiGatewayV2::Stage" && resource.Properties.StageName === "live");
if (!webSocketStage?.Properties.AutoDeploy || webSocketStage.Properties.DefaultRouteSettings?.ThrottlingBurstLimit !== 20) throw new Error("WebSocket live stage settings drifted");
const inspect = resources.find(resource => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties.RouteKey === "POST /invitations/inspect");
if (inspect?.Properties.AuthorizationType !== "NONE") throw new Error("Invitation inspection must be the only public route");
const otherPublic = resources.filter(resource => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties.AuthorizationType === "NONE" && resource.Properties.RouteKey !== "POST /invitations/inspect" && resource.Properties.RouteKey !== "$disconnect" && resource.Properties.RouteKey !== "$default");
if (otherPublic.length) throw new Error(`Unexpected public application route: ${otherPublic[0].Properties.RouteKey}`);
const eventRule = resources.find(resource => resource.Type === "AWS::Events::Rule");
if (!eventRule || eventRule.Properties.Targets.some(target => !String(target.Arn).includes("Fn::GetAtt") && !target.Arn?.["Fn::GetAtt"])) throw new Error("EventBridge targets must be Lambda functions");
const mappings = resources.filter(resource => resource.Type === "AWS::Lambda::EventSourceMapping");
const stream = mappings.find(resource => resource.Properties.StartingPosition === "TRIM_HORIZON");
if (stream?.Properties.BatchSize !== 1 || stream.Properties.MaximumRetryAttempts !== 3) throw new Error("Outbox stream mapping settings drifted");
const pattern = stream?.Properties.FilterCriteria?.Filters?.[0]?.Pattern;
if (!pattern || JSON.stringify(JSON.parse(pattern)) !== JSON.stringify({ dynamodb: { NewImage: { entityType: { S: ["OUTBOX"] } }, OldImage: [{ exists: false }] } })) throw new Error("Outbox stream filter drifted");
const serialized = JSON.stringify(templates);
for (const term of ["clientSecret", "refreshToken", "confirmationCode", "AWS_SECRET_ACCESS_KEY"]) {
  if (serialized.toLowerCase().includes(term.toLowerCase())) throw new Error(`Secret-like term in assembly: ${term}`);
}
console.log(`Verified ${resources.length} resources across three stacks, including stack-owned Cognito authentication.`);
