import { App, CfnOutput, Stack } from "aws-cdk-lib";
import { LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "XRayRestStack", { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION } });
const api = new RestApi(stack, "Api", {
  deployOptions: { stageName: "dev", tracingEnabled: process.env.XRY_TRACING !== "false" },
});
const handler = new LambdaFunction(stack, "Handler", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromInline(`exports.handler = async event => {
    if (event.queryStringParameters?.fail === "true") throw new Error("expected fixture failure");
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, traceHeader: process.env._X_AMZN_TRACE_ID }) };
  };`),
});
api.root.addResource("health").addMethod("GET", new LambdaIntegration(handler));
new CfnOutput(stack, "ApiId", { value: api.restApiId });
new CfnOutput(stack, "Stage", { value: api.deploymentStage.stageName });
