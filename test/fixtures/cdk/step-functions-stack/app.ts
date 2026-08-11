import { App, CfnOutput, Stack, Tags } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { DefinitionBody, StateMachine, TaskInput } from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";

const release = process.env.CDK_SFN_TEST_RELEASE === "v2" ? "v2" : "v1";
const app = new App();
const stack = new Stack(app, "StepFunctionsStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: "Pinned StackSim Step Functions CDK compatibility stack",
});
Tags.of(stack).add("fixture", "step-functions");

const worker = new LambdaFunction(stack, "Worker", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromInline(`exports.handler = async event => ({ release: "${release}", event });`),
});

const invoke = new LambdaInvoke(stack, "Invoke worker", {
  lambdaFunction: worker,
  payload: TaskInput.fromObject({
    "number.$": "$.number",
    release,
  }),
});

const stateMachine = new StateMachine(stack, "Workflow", {
  definitionBody: DefinitionBody.fromChainable(invoke),
});

new CfnOutput(stack, "StateMachineArn", { value: stateMachine.stateMachineArn });
new CfnOutput(stack, "StateMachineName", { value: stateMachine.stateMachineName });
new CfnOutput(stack, "WorkerFunctionName", { value: worker.functionName });
