import { App, CfnOutput, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { join } from "node:path";

const app = new App();
const release = process.env.CDK_SFN_TEST_RELEASE ?? app.node.tryGetContext("release") ?? "v1";
if (!["v1", "v2", "broken"].includes(release)) throw new Error("release must be v1, v2, or broken");
const stack = new Stack(app, "StepFunctionsLifecycle", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000", region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1" },
  description: "SFN-04: ordinary CDK workflows, assets, Activities, rollback, and retention",
});
Tags.of(stack).add("example", "step-functions-lifecycle");

const table = new Table(stack, "Orders", { partitionKey: { name: "orderId", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST, removalPolicy: RemovalPolicy.DESTROY });
const queue = new Queue(stack, "WorkQueue");
const notifications = new Queue(stack, "Notifications");
const topic = new Topic(stack, "OrderNotifications");
topic.addSubscription(new SqsSubscription(notifications, { rawMessageDelivery: true }));
const bus = new EventBus(stack, "OrderEvents");
const eventLogs = new LogGroup(stack, "EventReceiptLogs", { retention: RetentionDays.ONE_DAY, removalPolicy: RemovalPolicy.DESTROY });
const receipt = new LambdaFunction(stack, "EventReceipt", {
  runtime: Runtime.NODEJS_22_X, handler: "index.handler", logGroup: eventLogs,
  code: Code.fromInline('exports.handler = async event => { console.log("SFN04_EVENT " + JSON.stringify(event)); return { accepted: true }; };'),
});
new Rule(stack, "OrderEventDelivery", { eventBus: bus, eventPattern: { source: ["stacksim.sfn04"] }, targets: [new LambdaTarget(receipt)] });

const put = new tasks.DynamoPutItem(stack, "Record order", {
  table, item: { orderId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt("$.orderId")), release: tasks.DynamoAttributeValue.fromString(release) }, resultPath: sfn.JsonPath.DISCARD,
});
// These APIs consume JSON text. Use CDK's intrinsic rather than an object-valued path.
const jsonInput = sfn.TaskInput.fromText(sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt("$")));
const send = new tasks.SqsSendMessage(stack, "Enqueue order", { queue, messageBody: jsonInput, resultPath: sfn.JsonPath.DISCARD });
const publish = new tasks.SnsPublish(stack, "Notify order", { topic, message: jsonInput, resultPath: sfn.JsonPath.DISCARD });
const event = new tasks.EventBridgePutEvents(stack, "Publish order event", {
  entries: [{ eventBus: bus, source: "stacksim.sfn04", detailType: "Order accepted", detail: jsonInput }], resultPath: sfn.JsonPath.DISCARD,
});
const common = new sfn.StateMachine(stack, "CommonWorkflow", { definitionBody: sfn.DefinitionBody.fromChainable(put.next(send).next(publish).next(event)) });
Tags.of(common).add("release", release);

// DefinitionBody.fromFile uses CDK's ordinary versioned S3 file-asset pipeline.
const asset = new sfn.StateMachine(stack, "AssetWorkflow", {
  definitionBody: sfn.DefinitionBody.fromFile(join(import.meta.dirname, "definition.asl.json")),
  definitionSubstitutions: { Release: release, Greeting: "Hello", Audience: "workflow" },
});
Tags.of(asset).add("release", release);

const activity = new sfn.Activity(stack, "ReviewActivity");
Tags.of(activity).add("release", release);
const review = new sfn.StateMachine(stack, "ReviewWorkflow", {
  definitionBody: sfn.DefinitionBody.fromChainable(new tasks.StepFunctionsInvokeActivity(stack, "Review order", { activity, taskTimeout: sfn.Timeout.duration(Duration.minutes(5)) })),
});

const retained = new sfn.StateMachine(stack, "RetainedWorkflow", { definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(stack, "Retained result", { result: sfn.Result.fromObject({ retained: true }) })) });
retained.applyRemovalPolicy(RemovalPolicy.RETAIN);
retained.role.applyRemovalPolicy(RemovalPolicy.RETAIN);

// The learning script creates this independent Activity before a broken deploy.
// This is an ordinary resource conflict; the preceding definition update must roll back.
if (release === "broken") {
  const conflict = new sfn.Activity(stack, "IntentionalConflict", { activityName: "sfn04-independent-review" });
  conflict.node.addDependency(asset);
}

for (const [key, value] of Object.entries({
  CommonArn: common.stateMachineArn, CommonRoleArn: common.role.roleArn,
  AssetArn: asset.stateMachineArn, ActivityArn: activity.activityArn, ReviewArn: review.stateMachineArn,
  RetainedArn: retained.stateMachineArn, RetainedRoleName: retained.role.roleName,
  TableName: table.tableName, WorkQueueUrl: queue.queueUrl, NotificationsUrl: notifications.queueUrl,
  EventLogGroup: eventLogs.logGroupName,
})) new CfnOutput(stack, key, { value });
