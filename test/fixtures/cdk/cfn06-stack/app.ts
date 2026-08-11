import { App, CfnOutput, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Effect, ManagedPolicy, Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Alias, CfnPermission, Code, Function as LambdaFunction, Runtime, Version } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { join } from "node:path";

const app = new App();
const requestedRelease = process.env.CDK_CFN06_TEST_RELEASE;
const release = requestedRelease === "v2" || requestedRelease === "fail" ? requestedRelease : "v1";
const stack = new Stack(app, "Cfn06Stack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: "Pinned stacksim CFN-06 standard-CDK compatibility stack",
});
Tags.of(stack).add("fixture", "cfn06");

const role = new Role(stack, "WorkloadRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  maxSessionDuration: Duration.hours(release === "fail" ? 3 : release === "v2" ? 2 : 1),
});

const streamPolicy = new ManagedPolicy(stack, "StreamPolicy", {
  description: "Creates Lambda log streams in the CFN-06 fixture",
  roles: [role],
  statements: [new PolicyStatement({
    sid: release === "fail" ? "CreateStreamsFail" : release === "v2" ? "CreateStreamsV2" : "CreateStreamsV1",
    effect: Effect.ALLOW,
    actions: ["logs:CreateLogStream"],
    resources: ["*"],
  })],
});

const eventPolicy = new Policy(stack, "EventPolicy", {
  statements: [new PolicyStatement({
    sid: release === "fail" ? "WriteEventsFail" : release === "v2" ? "WriteEventsV2" : "WriteEventsV1",
    effect: Effect.ALLOW,
    actions: ["logs:PutLogEvents"],
    resources: ["*"],
  })],
});
eventPolicy.attachToRole(role);

const retention = release === "fail" ? RetentionDays.TWO_MONTHS : release === "v2" ? RetentionDays.ONE_MONTH : RetentionDays.ONE_WEEK;
const inlineLogs = new LogGroup(stack, "InlineLogs", {
  logGroupName: "/stacksim/cfn06/inline",
  retention,
  removalPolicy: RemovalPolicy.DESTROY,
});
const bundledLogs = new LogGroup(stack, "BundledLogs", {
  logGroupName: "/stacksim/cfn06/bundled",
  retention,
  removalPolicy: RemovalPolicy.DESTROY,
});

const inlineFunction = new LambdaFunction(stack, "InlineFunction", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromInline(`
exports.handler = async (event) => {
  console.log("cfn06 inline ${release}");
  return { kind: "inline", release: "${release}", event };
};
`),
  role,
  logGroup: inlineLogs,
  environment: { RELEASE: release },
});

const bundledFunction = new NodejsFunction(stack, "BundledFunction", {
  entry: join(import.meta.dirname, "bundled-handler.ts"),
  depsLockFilePath: join(import.meta.dirname, "../../../..", "package-lock.json"),
  runtime: Runtime.NODEJS_22_X,
  handler: "handler",
  role,
  logGroup: bundledLogs,
  environment: { RELEASE: release },
  bundling: {
    minify: false,
    sourceMap: false,
    target: "node22",
    define: { __CFN06_RELEASE_V2__: release === "v1" ? "false" : "true" },
    banner: release === "fail" ? "/* CFN-06 rollback failure asset */" : undefined,
  },
});

const version = new Version(stack, "BundledVersion", {
  lambda: bundledFunction,
  description: `CFN-06 ${release}`,
  removalPolicy: RemovalPolicy.DESTROY,
});
const alias = new Alias(stack, "BundledAlias", {
  aliasName: "live",
  version,
  description: `CFN-06 live ${release}`,
});

bundledFunction.addPermission("EventsInvoke", {
  principal: new ServicePrincipal("events.amazonaws.com"),
  action: "lambda:InvokeFunction",
  sourceArn: stack.formatArn({ service: "events", resource: "rule", resourceName: release === "fail" ? "cfn06-local-fail" : "cfn06-local" }),
});

if (release === "fail") {
  const rollbackFailure = new CfnPermission(stack, "RollbackFailure", {
    action: "lambda:InvokeFunction",
    functionName: "cfn06-missing-function",
    principal: "events.amazonaws.com",
  });
  rollbackFailure.node.addDependency(
    role,
    streamPolicy,
    eventPolicy,
    inlineLogs,
    bundledLogs,
    inlineFunction,
    bundledFunction,
    version,
    alias,
    bundledFunction.node.findChild("EventsInvoke"),
  );
}

new CfnOutput(stack, "InlineFunctionName", { value: inlineFunction.functionName });
new CfnOutput(stack, "BundledFunctionName", { value: bundledFunction.functionName });
new CfnOutput(stack, "BundledAliasArn", { value: alias.functionArn });
new CfnOutput(stack, "BundledVersionNumber", { value: version.version });
new CfnOutput(stack, "WorkloadRoleName", { value: role.roleName });
new CfnOutput(stack, "StreamPolicyArn", { value: streamPolicy.managedPolicyArn });
new CfnOutput(stack, "EventPolicyName", { value: eventPolicy.policyName });
new CfnOutput(stack, "InlineLogGroup", { value: inlineLogs.logGroupName });
new CfnOutput(stack, "BundledLogGroup", { value: bundledLogs.logGroupName });
