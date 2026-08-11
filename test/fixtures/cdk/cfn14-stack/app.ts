import { App, CfnOutput, CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime, Version } from "aws-cdk-lib/aws-lambda";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId, Provider } from "aws-cdk-lib/custom-resources";
import { join } from "node:path";

const app = new App();
const release = process.env.CDK_CFN14_TEST_RELEASE === "v2" ? "v2" : "v1";
const stack = new Stack(app, "Cfn14Stack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: "Pinned stacksim CFN-14 generated custom-resource compatibility stack",
});

const targetRole = new Role(stack, "TargetRole", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
const target = new LambdaFunction(stack, "TargetFunction", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromAsset(join(import.meta.dirname, `target-${release}`)),
  role: targetRole,
  timeout: Duration.seconds(5),
});
const targetVersion = new Version(stack, "TargetVersion", { lambda: target, description: `CFN-14 ${release}` });
targetVersion.applyRemovalPolicy(RemovalPolicy.DESTROY);

const onEventRole = new Role(stack, "OnEventRole", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
const onEvent = new LambdaFunction(stack, "OnEvent", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  role: onEventRole,
  timeout: Duration.seconds(10),
  code: Code.fromInline(`
exports.handler = async event => {
  console.log("CFN14_NESTED_CALLBACK_REDACTION", event.ResponseURL, new URL(event.ResponseURL).pathname.split("/").pop());
  return ({
  PhysicalResourceId: event.PhysicalResourceId || "cfn14-sync-provider",
  Data: {
    Message: event.RequestType + ":" + event.ResourceProperties.Value,
    Endpoint: process.env.AWS_ENDPOINT_URL,
    LambdaEndpoint: process.env.AWS_ENDPOINT_URL_LAMBDA,
    Credentials: Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_SESSION_TOKEN)
  }
  });
};`),
});

const provider = new Provider(stack, "SyncProvider", { onEventHandler: onEvent });
const syncProbe = new CustomResource(stack, "SyncProbe", {
  serviceToken: provider.serviceToken,
  properties: { Value: release },
});

const getQualifiedFunction = {
  service: "Lambda",
  action: "getFunction",
  parameters: { FunctionName: target.functionName, Qualifier: targetVersion.version },
  physicalResourceId: PhysicalResourceId.of("cfn14-aws-custom-resource"),
};
const awsProbe = new AwsCustomResource(stack, "AwsProbe", {
  onCreate: getQualifiedFunction,
  onUpdate: getQualifiedFunction,
  onDelete: {
    service: "Lambda",
    action: "getFunction",
    parameters: { FunctionName: target.functionName },
  },
  policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [target.functionArn, targetVersion.functionArn] }),
  installLatestAwsSdk: false,
});

onEventRole.addToPolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], resources: ["*"] }));

new CfnOutput(stack, "TargetFunctionArn", { value: target.functionArn });
new CfnOutput(stack, "TargetVersionNumber", { value: targetVersion.version });
new CfnOutput(stack, "SyncPhysicalId", { value: syncProbe.ref });
new CfnOutput(stack, "SyncMessage", { value: syncProbe.getAttString("Message") });
new CfnOutput(stack, "SyncEndpoint", { value: syncProbe.getAttString("Endpoint") });
new CfnOutput(stack, "SyncLambdaEndpoint", { value: syncProbe.getAttString("LambdaEndpoint") });
new CfnOutput(stack, "SyncCredentials", { value: syncProbe.getAttString("Credentials") });
new CfnOutput(stack, "AwsFunctionArn", { value: awsProbe.getResponseField("Configuration.FunctionArn") });
