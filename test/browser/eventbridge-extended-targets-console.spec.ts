import { expect, test, type Page } from "@playwright/test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import { CloudWatchLogsClient, CreateLogGroupCommand, PutResourcePolicyCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, GetMetricStatisticsCommand, PutMetricAlarmCommand } from "@aws-sdk/client-cloudwatch";
import { EventBridgeClient, ListTargetsByRuleCommand, PutEventsCommand, PutRuleCommand } from "@aws-sdk/client-eventbridge";
import { AttachRolePolicyCommand, CreateRoleCommand, DeleteRolePolicyCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateFunctionCommand, GetFunctionEventInvokeConfigCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { fillArnCombobox } from "./arn-combobox.js";

const region = "eu-west-1";
const account = "000000000000";
const ruleName = "console-extended-targets";
const ruleArn = `arn:aws:events:${region}:${account}:rule/${ruleName}`;

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let clients: Array<{ destroy(): void }>;

function sdkOptions() {
  return { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400 && !(response.status() === 404 && response.url().endsWith("?website"))) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

function policy(statements: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

test.describe("EVB-02 extended-target console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-extended-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    clients = [];
  });

  test.afterEach(async () => {
    for (const client of clients) client.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("configures and inspects Lambda, SQS, Logs, and API Gateway targets with retries, DLQ, HTTP parameters, and previews", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = browserErrors(page);
    const events = new EventBridgeClient(sdkOptions());
    const sqs = new SQSClient(sdkOptions());
    const logs = new CloudWatchLogsClient(sdkOptions());
    const gateway = new APIGatewayClient(sdkOptions());
    const iam = new IAMClient(sdkOptions());
    const lambda = new LambdaClient(sdkOptions());
    const cloudwatch = new CloudWatchClient(sdkOptions());
    const s3 = new S3Client({ ...sdkOptions(), forcePathStyle: true });
    clients.push(events, sqs, logs, gateway, iam, lambda, cloudwatch, s3);

    await events.send(new PutRuleCommand({ Name: ruleName, EventPattern: JSON.stringify({ source: ["console.extended"] }) }));
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "console-eventbridge-alarm", Namespace: "Console/EVB02", MetricName: "Failures", Statistic: "Sum", Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold" }));
    await s3.send(new CreateBucketCommand({ Bucket: "console-eventbridge-source" }));

    const lambdaRole = await iam.send(new CreateRoleCommand({
      RoleName: "console-extended-lambda-role",
      AssumeRolePolicyDocument: policy([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "console-extended-lambda-role", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "console-extended-function", Runtime: "nodejs22.x", Role: lambdaRole.Role!.Arn!, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "console-extended-function", StatementId: "eventbridge-console-extended", Action: "lambda:InvokeFunction", Principal: "events.amazonaws.com", SourceArn: ruleArn }));

    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "console-extended-orders" }));
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "console-extended-dlq" }));
    const queueArn = `arn:aws:sqs:${region}:${account}:console-extended-orders`;
    const dlqArn = `arn:aws:sqs:${region}:${account}:console-extended-dlq`;
    expect(queue.QueueUrl).toBeTruthy();
    expect(dlq.QueueUrl).toBeTruthy();
    const targetRole = await iam.send(new CreateRoleCommand({
      RoleName: "console-eventbridge-target-role",
      AssumeRolePolicyDocument: policy([{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sts:AssumeRole" }]),
    }));
    const targetRolePolicy = policy([{ Effect: "Allow", Action: "sqs:SendMessage", Resource: queueArn }]);
    await iam.send(new PutRolePolicyCommand({ RoleName: "console-eventbridge-target-role", PolicyName: "send-orders", PolicyDocument: targetRolePolicy }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl!,
      Attributes: {
        Policy: policy([{
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: "sqs:SendMessage",
          Resource: dlqArn,
          Condition: {
            ArnEquals: { "aws:SourceArn": ruleArn },
            StringEquals: { "aws:SourceAccount": account },
          },
        }]),
      },
    }));

    const logGroupName = "/aws/events/console-extended";
    const logGroupArn = `arn:aws:logs:${region}:${account}:log-group:${logGroupName}`;
    await logs.send(new CreateLogGroupCommand({ logGroupName }));
    await logs.send(new PutResourcePolicyCommand({
      policyName: "console-eventbridge-logs",
      resourceArn: logGroupArn,
      policyDocument: policy([{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${logGroupArn}:*`, Condition: { ArnEquals: { "aws:SourceArn": ruleArn } } }]),
    }));

    const api = await gateway.send(new CreateRestApiCommand({
      name: "console-extended-api",
      policy: policy([{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "execute-api:Invoke", Resource: "execute-api:/*", Condition: { ArnEquals: { "aws:SourceArn": ruleArn } } }]),
    }));
    const apiRoot = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;
    const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: apiRoot.id!, pathPart: "orders" }));
    const customer = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: orders.id!, pathPart: "{customer}" }));
    await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", authorizationType: "NONE" }));
    await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", statusCode: "200" }));
    await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", statusCode: "429" }));
    await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": '{"statusCode":200}' } }));
    await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", statusCode: "200" }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    const apiTargetArn = `arn:aws:execute-api:${region}:${account}:${api.id}/dev/POST/orders/*`;

    await page.goto(`${consoleUrl}#/eventbridge/rules/default/${ruleName}/targets`);
    await expect(page.getByRole("heading", { name: "Targets", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add target" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target ID").fill("lambda-target");
    await fillArnCombobox(dialog.getByLabel("Lambda function"), fn.FunctionArn!);
    await dialog.getByRole("button", { name: "Preview target input" }).click();
    await expect(dialog.getByRole("status")).toContainText("Preview ready");
    await dialog.getByRole("button", { name: "Add target" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("link", { name: "console-extended-function", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add target" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target type").selectOption("sqs");
    await dialog.getByLabel("Target ID").fill("queue-target");
    await fillArnCombobox(dialog.getByLabel("Queue ARN", { exact: true }), queueArn);
    await dialog.getByLabel("Message group ID").fill("tenant-a");
    await dialog.getByLabel("Target input").selectOption("transformer");
    await dialog.getByLabel("Input paths map (JSON object)").fill('{"id":"$.detail.id"}');
    await dialog.getByLabel("Input template").fill('{"orderId":<id>}');
    await dialog.getByLabel("Preview sample event").fill('{"detail":{"id":"order-1"}}');
    await fillArnCombobox(dialog.getByLabel("Execution role ARN (optional)"), targetRole.Role!.Arn!);
    await fillArnCombobox(dialog.getByLabel("Dead-letter queue ARN (optional)"), dlqArn);
    await dialog.getByLabel("Maximum event age (seconds)").fill("300");
    await dialog.getByLabel("Maximum retry attempts").fill("4");
    await expect(dialog.getByText("Queue permission required")).toBeVisible();
    await dialog.getByRole("button", { name: "Preview target input" }).click();
    await expect(dialog.getByRole("status")).toContainText("order-1");
    await dialog.getByRole("button", { name: "Add target" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("link", { name: "console-extended-orders", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add target" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target type").selectOption("logs");
    await dialog.getByLabel("Target ID").fill("logs-target");
    await fillArnCombobox(dialog.getByLabel("Log group ARN"), logGroupArn);
    await dialog.getByLabel("Target input").selectOption("transformer");
    await dialog.getByLabel("Input paths map (JSON object)").fill('{"timestamp":"$.detail.timestamp","message":"$.detail.message"}');
    await dialog.getByLabel("Input template").fill('{"timestamp":<timestamp>,"message":<message>}');
    await dialog.getByLabel("Preview sample event").fill('{"detail":{"timestamp":1784548800000,"message":"log order-1"}}');
    await expect(dialog.getByText("Logs resource policy required")).toBeVisible();
    await expect(dialog.getByLabel("Execution role ARN (optional)")).toBeHidden();
    await dialog.getByRole("button", { name: "Preview target input" }).click();
    await expect(dialog.getByRole("status")).toContainText("log order-1");
    await dialog.getByRole("button", { name: "Add target" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("link", { name: logGroupName, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add target" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target type").selectOption("apigateway");
    await dialog.getByLabel("Target ID").fill("api-target");
    await fillArnCombobox(dialog.getByLabel("Deployed API target ARN"), apiTargetArn);
    await dialog.getByLabel("Path parameter values (JSON array)").fill('["$.detail.customer"]');
    await dialog.getByLabel("Query string parameters (JSON object)").fill('{"kind":"$.detail.kind","fixed":"yes"}');
    await dialog.getByLabel("Header parameters (JSON object)").fill('{"X-Order":"$.detail.id"}');
    await dialog.getByLabel("Target input").selectOption("path");
    await dialog.getByLabel("Input path", { exact: true }).fill("$.detail");
    await expect(dialog.getByText("API authorization required")).toBeVisible();
    await dialog.getByRole("button", { name: "Add target" }).click();
    await expect(dialog).not.toBeVisible();

    const targetTable = page.locator(".eventbridge-target-table");
    for (const label of ["Lambda", "SQS", "CloudWatch Logs", "API Gateway"]) await expect(targetTable.getByText(label, { exact: true })).toBeVisible();
    await expect(targetTable).toContainText("Retries 0 · DLQ 0 sent / 0 failed");
    await expect(page.getByRole("link", { name: "console-extended-dlq", exact: true })).toHaveAttribute("href", "#/sqs/queues/console-extended-dlq/messages");
    await expect(page.getByRole("link", { name: api.id!, exact: true })).toHaveAttribute("href", `#/apigateway/apis/${api.id}/policy`);
    await expect(page.getByRole("link", { name: "console-extended-orders", exact: true })).toHaveAttribute("href", "#/sqs/queues/console-extended-orders/access-policy");
    await expect(page.getByRole("link", { name: logGroupName, exact: true })).toHaveAttribute("href", `#/cloudwatch/log-groups/${encodeURIComponent(logGroupName)}/resource-policy`);

    const stored = (await events.send(new ListTargetsByRuleCommand({ Rule: ruleName }))).Targets!;
    expect(stored).toHaveLength(4);
    const queueTarget = stored.find(target => target.Id === "queue-target")!;
    expect(queueTarget.RoleArn).toBe(targetRole.Role!.Arn);
    expect(queueTarget.DeadLetterConfig?.Arn).toBe(dlqArn);
    expect(queueTarget.SqsParameters).toEqual({ MessageGroupId: "tenant-a" });
    expect(queueTarget.RetryPolicy).toEqual({ MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 4 });
    expect(queueTarget.InputTransformer).toEqual({ InputPathsMap: { id: "$.detail.id" }, InputTemplate: '{"orderId":<id>}' });
    expect(stored.find(target => target.Id === "api-target")?.HttpParameters).toEqual({
      PathParameterValues: ["$.detail.customer"],
      QueryStringParameters: { fixed: "yes", kind: "$.detail.kind" },
      HeaderParameters: { "X-Order": "$.detail.id" },
    });

    await page.getByRole("button", { name: "Edit target queue-target" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Execution role ARN (optional)")).toHaveValue(targetRole.Role!.Arn!);
    await expect(dialog.getByLabel("Dead-letter queue ARN (optional)")).toHaveValue(dlqArn);
    await expect(dialog.getByText("Queue permission required")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const eventDetail = (id: string) => JSON.stringify({
      id,
      timestamp: Date.now(),
      message: `log ${id}`,
      customer: "customer-a",
      kind: "console",
    });
    const putConsoleEvent = async (id: string): Promise<string> => {
      const result = await events.send(new PutEventsCommand({
        Entries: [{ Source: "console.extended", DetailType: "Console acceptance", Detail: eventDetail(id) }],
      }));
      return result.Entries?.[0].EventId!;
    };
    const metricSum = async (metricName: string): Promise<number> => {
      const result = await cloudwatch.send(new GetMetricStatisticsCommand({
        Namespace: "AWS/Events",
        MetricName: metricName,
        Dimensions: [{ Name: "RuleName", Value: ruleName }],
        StartTime: new Date(Date.now() - 60_000),
        EndTime: new Date(Date.now() + 60_000),
        Period: 60,
        Statistics: ["Sum"],
      }));
      return result.Datapoints?.reduce((sum, point) => sum + (point.Sum ?? 0), 0) ?? 0;
    };
    const queueRow = targetTable.locator("tbody tr").filter({ hasText: "queue-target" });
    const apiRow = targetTable.locator("tbody tr").filter({ hasText: "api-target" });

    await iam.send(new DeleteRolePolicyCommand({ RoleName: "console-eventbridge-target-role", PolicyName: "send-orders" }));
    const deniedEventId = await putConsoleEvent("permission-denied");
    await expect.poll(() => {
      const diagnostic = simulator.eventbridge.deliveryDiagnostics().diagnostics.find((item: any) => item.eventId === deniedEventId && item.targetId === "queue-target");
      return `${diagnostic?.status ?? "missing"}:${diagnostic?.deadLetterStatus ?? "missing"}`;
    }, { timeout: 10_000 }).toBe("FAILED:SENT");
    await page.getByRole("button", { name: "Refresh targets" }).click();
    await expect(queueRow).toContainText("FAILED");
    await expect(queueRow).toContainText("DLQ 1 sent / 0 failed");
    const deadLetter = (await sqs.send(new ReceiveMessageCommand({
      QueueUrl: dlq.QueueUrl!,
      MessageAttributeNames: ["All"],
    }))).Messages?.[0];
    expect(JSON.parse(deadLetter!.Body!).detail.id).toBe("permission-denied");
    expect(deadLetter?.MessageAttributes?.ERROR_CODE?.StringValue).toBe("NO_PERMISSIONS");
    await expect.poll(() => metricSum("InvocationsSentToDlq"), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await iam.send(new PutRolePolicyCommand({ RoleName: "console-eventbridge-target-role", PolicyName: "send-orders", PolicyDocument: targetRolePolicy }));
    const repairedEventId = await putConsoleEvent("permission-repaired");
    await expect.poll(() => simulator.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.eventId === repairedEventId && item.targetId === "queue-target" && item.status === "SUCCEEDED"), { timeout: 10_000 }).toBe(true);
    await page.getByRole("button", { name: "Refresh targets" }).click();
    await expect(queueRow).toContainText("SUCCEEDED");
    await expect(queueRow).toContainText("DLQ 1 sent / 0 failed");

    await gateway.send(new PutIntegrationCommand({
      restApiId: api.id!,
      resourceId: customer.id!,
      httpMethod: "POST",
      type: "MOCK",
      requestTemplates: { "application/json": '{"statusCode":429}' },
    }));
    await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", statusCode: "429" }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    const retryEventId = await putConsoleEvent("retry-then-repair");
    await expect.poll(() => simulator.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.eventId === retryEventId && item.targetId === "api-target" && item.status === "RETRYING"), { timeout: 10_000 }).toBe(true);
    await gateway.send(new PutIntegrationCommand({
      restApiId: api.id!,
      resourceId: customer.id!,
      httpMethod: "POST",
      type: "MOCK",
      requestTemplates: { "application/json": '{"statusCode":200}' },
    }));
    await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", statusCode: "200" }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    await expect.poll(() => simulator.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.eventId === retryEventId && item.targetId === "api-target" && item.status === "SUCCEEDED"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => metricSum("RetryInvocationAttempts"), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "Refresh targets" }).click();
    await expect(apiRow).toContainText("SUCCEEDED");
    await expect(apiRow).toContainText(/Retries [1-9]\d*/);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("tab", { name: "Monitoring" }).click();
    await expect(page.getByRole("heading", { name: "EventBridge metrics" })).toBeVisible();
    await expect(page.locator("main")).toContainText("InvocationsSentToDlq");
    await expect(page.locator("main")).toContainText("InvocationsFailedToBeSentToDlq");
    await expect(page.locator("main")).toContainText("Target IDs and target counters exist only in bounded simulator diagnostics");
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("queue-target");
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("api-target");
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("FAILED");
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("SUCCEEDED");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${consoleUrl}#/lambda/functions/console-extended-function/configuration`);
    const asyncCard = page.locator(".async-invocation-card");
    await expect(asyncCard).toContainText("EventBridge destinations are active");
    await asyncCard.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    const defaultBusArn = `arn:aws:events:${region}:${account}:event-bus/default`;
    await fillArnCombobox(dialog.getByLabel("Success destination"), defaultBusArn);
    await expect(dialog.getByText("Lambda, SQS, and EventBridge destinations are active")).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(asyncCard.getByRole("link", { name: "default", exact: true })).toHaveAttribute("href", "#/eventbridge/event-buses/default/details");
    expect((await lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "console-extended-function" }))).DestinationConfig?.OnSuccess?.Destination).toBe(defaultBusArn);

    await page.goto(`${consoleUrl}#/sqs/queues/console-extended-orders/access-policy`);
    await expect(page.getByRole("heading", { name: "Access policy", exact: true })).toBeVisible();
    const queuePolicyCard = page.locator(".eventbridge-queue-policy");
    await expect(queuePolicyCard).toContainText("events.amazonaws.com");
    await expect(queuePolicyCard).toContainText("sqs:SendMessage");
    await expect(queuePolicyCard.getByRole("link", { name: "Open EventBridge rules" })).toHaveAttribute("href", "#/eventbridge/rules");
    await page.getByRole("button", { name: "Edit JSON" }).click();
    dialog = page.getByRole("dialog");
    const queuePolicy = policy([{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": ruleArn }, StringEquals: { "aws:SourceAccount": account } } }]);
    await dialog.getByLabel("Policy JSON").fill(queuePolicy);
    await dialog.getByRole("button", { name: "Save policy" }).click();
    await expect(dialog).not.toBeVisible();
    const storedQueuePolicy = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl!, AttributeNames: ["Policy"] }))).Attributes?.Policy;
    expect(JSON.parse(storedQueuePolicy!).Statement[0].Principal.Service).toBe("events.amazonaws.com");

    await page.goto(`${consoleUrl}#/cloudwatch/log-groups/${encodeURIComponent(logGroupName)}/resource-policy`);
    const logPolicyCard = page.locator(".log-resource-policy-card");
    await expect(logPolicyCard.getByRole("heading", { name: "Resource policy", exact: true })).toBeVisible();
    await expect(logPolicyCard.getByLabel("Policy name")).toHaveValue("console-eventbridge-logs");
    await expect(logPolicyCard).toContainText("EventBridge target authorization");
    await expect(logPolicyCard.getByRole("link", { name: "Open EventBridge rules" })).toHaveAttribute("href", "#/eventbridge/rules");

    await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/policy`);
    await expect(page.getByRole("heading", { name: "Resource policy", exact: true })).toBeVisible();
    const apiPolicyCard = page.locator(".eventbridge-api-policy");
    await expect(apiPolicyCard).toContainText("events.amazonaws.com");
    await expect(apiPolicyCard).toContainText("execute-api:Invoke");
    await expect(apiPolicyCard.getByRole("link", { name: "Open EventBridge rules" })).toHaveAttribute("href", "#/eventbridge/rules");

    await page.goto(`${consoleUrl}#/cloudwatch/alarms/console-eventbridge-alarm`);
    const alarmEventsCard = page.locator(".eventbridge-alarm-events");
    await expect(alarmEventsCard.getByRole("heading", { name: "EventBridge events" })).toBeVisible();
    await expect(alarmEventsCard).toContainText("aws.cloudwatch");
    await expect(alarmEventsCard).toContainText("CloudWatch Alarm State Change");
    await expect(alarmEventsCard.getByRole("link", { name: "default", exact: true })).toHaveAttribute("href", "#/eventbridge/event-buses/default/rules");

    await page.goto(`${consoleUrl}#/s3/buckets/console-eventbridge-source/properties`);
    const s3EventsCard = page.locator(".s3-eventbridge-notifications");
    await expect(s3EventsCard.getByRole("heading", { name: "Amazon EventBridge" })).toBeVisible();
    await expect(s3EventsCard.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(s3EventsCard).toContainText("All supported S3 events");
    await expect(s3EventsCard.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
