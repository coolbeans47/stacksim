/** Scenario H. Every resource and mutation uses ordinary public AWS SDK calls. */
import { pathToFileURL } from "node:url";
import { SQSClient, CreateQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SendMessageCommand, ReceiveMessageCommand, PurgeQueueCommand, DeleteQueueCommand, StartMessageMoveTaskCommand, ListMessageMoveTasksCommand, CancelMessageMoveTaskCommand } from "@aws-sdk/client-sqs";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand, DeleteRoleCommand } from "@aws-sdk/client-iam";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand, CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand, DeleteEventSourceMappingCommand, DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient, type ScanCommandOutput, type AttributeValue, CreateTableCommand, GetItemCommand, ScanCommand, DeleteItemCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { CloudWatchLogsClient, CreateLogGroupCommand, FilterLogEventsCommand, DeleteLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { APIGatewayClient, CreateRestApiCommand, GetRestApisCommand, GetResourcesCommand, PutMethodCommand, PutMethodResponseCommand, PutIntegrationCommand, PutIntegrationResponseCommand, TestInvokeMethodCommand, DeleteRestApiCommand } from "@aws-sdk/client-api-gateway";
import { createZip } from "../../src/core/zip-create.js";

const document = (Statement: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement });
export interface LabOptions { endpoint: string; region?: string; prefix?: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }
export class RecoveryLab {
  readonly prefix: string;
  readonly region: string;
  readonly options;
  readonly sqs; readonly iam; readonly sts; readonly lambda; readonly dynamo; readonly logs; readonly api;
  constructor(input: LabOptions) {
    const url = new URL(input.endpoint);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("This learning exercise requires a loopback StackSim endpoint.");
    this.prefix = input.prefix ?? "sqs-recovery"; this.region = input.region ?? "eu-west-1";
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,35}$/.test(this.prefix)) throw new Error("Use a prefix of 1–36 letters, digits or hyphens, starting with a letter.");
    this.options = { endpoint: input.endpoint, region: this.region, credentials: input.credentials ?? { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    this.sqs = new SQSClient(this.options); this.iam = new IAMClient(this.options); this.sts = new STSClient(this.options); this.lambda = new LambdaClient(this.options); this.dynamo = new DynamoDBClient(this.options); this.logs = new CloudWatchLogsClient(this.options); this.api = new APIGatewayClient(this.options);
  }
  get functionName() { return `${this.prefix}-worker`; }
  get tableName() { return `${this.prefix}-processed`; }
  async queues() {
    const source = (await this.sqs.send(new GetQueueUrlCommand({ QueueName: `${this.prefix}-source` }))).QueueUrl!;
    const dlq = (await this.sqs.send(new GetQueueUrlCommand({ QueueName: `${this.prefix}-dlq` }))).QueueUrl!;
    const sourceArn = (await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: source, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    const dlqArn = (await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    return { source, dlq, sourceArn, dlqArn };
  }
  code(repaired: boolean) {
    return createZip([{ name: "index.cjs", content: `
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const db = new DynamoDBClient({ endpoint: process.env.LAB_ENDPOINT, region: process.env.AWS_REGION });
exports.handler = async function(event) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    try {
      if (!${JSON.stringify(repaired)} && job.kind === "poison") throw new Error("Consumer v1 rejects the new poison job kind");
      try {
        await db.send(new PutItemCommand({ TableName: process.env.LAB_TABLE, Item: { jobId: { S: job.jobId }, status: { S: "PROCESSED" }, transportId: { S: record.messageId } }, ConditionExpression: "attribute_not_exists(jobId)" }));
        console.log(JSON.stringify({ outcome: "PROCESSED", jobId: job.jobId, attempt: record.attributes.ApproximateReceiveCount }));
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        console.log(JSON.stringify({ outcome: "ALREADY_PROCESSED", jobId: job.jobId }));
      }
    } catch (error) {
      console.error(JSON.stringify({ outcome: "RETRY", jobId: job.jobId, attempt: record.attributes.ApproximateReceiveCount, reason: error.message }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
` }]);
  }
  async deploy() {
    const account = (await this.sts.send(new GetCallerIdentityCommand({}))).Account!;
    const dlq = (await this.sqs.send(new CreateQueueCommand({ QueueName: `${this.prefix}-dlq`, Attributes: { MessageRetentionPeriod: "1209600" } }))).QueueUrl!;
    const dlqArn = `arn:aws:sqs:${this.region}:${account}:${this.prefix}-dlq`;
    const source = (await this.sqs.send(new CreateQueueCommand({ QueueName: `${this.prefix}-source`, Attributes: { VisibilityTimeout: "6", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 2 }) } }))).QueueUrl!;
    const sourceArn = `arn:aws:sqs:${this.region}:${account}:${this.prefix}-source`;
    await this.sqs.send(new SetQueueAttributesCommand({ QueueUrl: dlq, Attributes: { RedriveAllowPolicy: JSON.stringify({ redrivePermission: "byQueue", sourceQueueArns: [sourceArn] }) } }));
    await this.dynamo.send(new CreateTableCommand({ TableName: this.tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "jobId", AttributeType: "S" }], KeySchema: [{ AttributeName: "jobId", KeyType: "HASH" }] }));
    await this.logs.send(new CreateLogGroupCommand({ logGroupName: `/aws/lambda/${this.functionName}` }));
    const worker = (await this.iam.send(new CreateRoleCommand({ RoleName: `${this.prefix}-worker-role`, AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]) }))).Role!;
    await this.iam.send(new PutRolePolicyCommand({ RoleName: worker.RoleName, PolicyName: "lab", PolicyDocument: document([
      { Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource: sourceArn },
      { Effect: "Allow", Action: "dynamodb:PutItem", Resource: `arn:aws:dynamodb:${this.region}:${account}:table/${this.tableName}` },
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [`arn:aws:logs:${this.region}:${account}:log-group:/aws/lambda/${this.functionName}`, `arn:aws:logs:${this.region}:${account}:log-group:/aws/lambda/${this.functionName}:*`] },
    ]) }));
    await this.iam.send(new CreateRoleCommand({ RoleName: `${this.prefix}-redrive-role`, AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }]) }));
    await this.iam.send(new PutRolePolicyCommand({ RoleName: `${this.prefix}-redrive-role`, PolicyName: "lab", PolicyDocument: document([
      { Effect: "Allow", Action: ["sqs:StartMessageMoveTask", "sqs:ListMessageMoveTasks", "sqs:CancelMessageMoveTask", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource: dlqArn },
      { Effect: "Allow", Action: "sqs:SendMessage", Resource: sourceArn },
    ]) }));
    await this.lambda.send(new CreateFunctionCommand({ FunctionName: this.functionName, Runtime: "nodejs22.x", Handler: "index.handler", Role: worker.Arn, Timeout: 1, Code: { ZipFile: this.code(false) }, Environment: { Variables: { LAB_ENDPOINT: this.options.endpoint, LAB_TABLE: this.tableName } } }));
    await this.lambda.send(new CreateEventSourceMappingCommand({ FunctionName: this.functionName, EventSourceArn: sourceArn, BatchSize: 10, FunctionResponseTypes: ["ReportBatchItemFailures"] }));
    const producer = (await this.iam.send(new CreateRoleCommand({ RoleName: `${this.prefix}-producer-role`, AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }]) }))).Role!;
    await this.iam.send(new PutRolePolicyCommand({ RoleName: producer.RoleName, PolicyName: "lab", PolicyDocument: document([{ Effect: "Allow", Action: "sqs:SendMessage", Resource: sourceArn }]) }));
    const api = await this.api.send(new CreateRestApiCommand({ name: `${this.prefix}-producer` }));
    const resourceId = (await this.api.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(r => r.path === "/")!.id!;
    const method = { restApiId: api.id!, resourceId, httpMethod: "POST" };
    await this.api.send(new PutMethodCommand({ ...method, authorizationType: "NONE" }));
    await this.api.send(new PutMethodResponseCommand({ ...method, statusCode: "200" }));
    await this.api.send(new PutIntegrationCommand({ ...method, type: "AWS", integrationHttpMethod: "POST", credentials: producer.Arn, uri: `arn:aws:apigateway:${this.region}:sqs:path/${account}/${this.prefix}-source`, requestParameters: { "integration.request.header.Content-Type": "'application/x-www-form-urlencoded'" }, requestTemplates: { "application/json": "Action=SendMessage&MessageBody=$util.urlEncode($input.body)" } }));
    await this.api.send(new PutIntegrationResponseCommand({ ...method, statusCode: "200" }));
    return { source, dlq, functionName: this.functionName, ledger: this.tableName, apiId: api.id, console: `${this.options.endpoint}/_stacksim/console#/sqs/queues/${this.prefix}-dlq/dead-letter` };
  }
  async send(bulk = 0) {
    const { source } = await this.queues();
    const jobs = bulk ? Array.from({ length: bulk }, (_, i) => ({ jobId: `bulk-${i}`, kind: "poison", delay: 0 })) : [{ jobId: "normal-1", kind: "normal", delay: 0 }, { jobId: "delayed-1", kind: "normal", delay: 2 }, { jobId: "poison-1", kind: "poison", delay: 0 }];
    for (const { delay, ...job } of jobs) await this.sqs.send(new SendMessageCommand({ QueueUrl: source, MessageBody: JSON.stringify(job), DelaySeconds: delay }));
    return { sent: jobs.length };
  }
  async sendApi() {
    const api = (await this.api.send(new GetRestApisCommand({ limit: 500 }))).items!.find(a => a.name === `${this.prefix}-producer`)!;
    const resource = (await this.api.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(r => r.path === "/")!;
    return this.api.send(new TestInvokeMethodCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: "api-1", kind: "normal" }) }));
  }
  async fix(repaired = true) { await this.lambda.send(new UpdateFunctionCodeCommand({ FunctionName: this.functionName, ZipFile: this.code(repaired) })); return { consumer: repaired ? "v2 repaired" : "v1 deliberately broken" }; }
  async inspect() {
    const { dlq } = await this.queues();
    return this.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, VisibilityTimeout: 0, MessageAttributeNames: ["All"], MessageSystemAttributeNames: ["All"] }));
  }
  async inspectLease() {
    const { source } = await this.queues();
    await this.enabled(false);
    const result = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: source, VisibilityTimeout: 6, MessageSystemAttributeNames: ["All"] }));
    return { ...result, lesson: "Restart StackSim now, then run resume. The unacknowledged receipt remains in flight until visibility expires." };
  }
  async enabled(Enabled: boolean) {
    const mappings = await this.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: this.functionName }));
    for (const mapping of mappings.EventSourceMappings ?? []) await this.lambda.send(new UpdateEventSourceMappingCommand({ UUID: mapping.UUID!, Enabled }));
  }
  async operator<T>(run: (sqs: SQSClient) => Promise<T>) {
    const account = (await this.sts.send(new GetCallerIdentityCommand({}))).Account;
    const c = (await this.sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${account}:role/${this.prefix}-redrive-role`, RoleSessionName: "recovery-lab" }))).Credentials!;
    const sqs = new SQSClient({ ...this.options, credentials: { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! } });
    try { return await run(sqs); } finally { sqs.destroy(); }
  }
  async redrive(rate = 1) { const { dlqArn } = await this.queues(); return this.operator(sqs => sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn, MaxNumberOfMessagesPerSecond: rate }))); }
  async tasks() { const { dlqArn } = await this.queues(); return this.operator(sqs => sqs.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn, MaxResults: 10 }))); }
  async cancel() {
    const task = (await this.tasks()).Results?.find(t => t.Status === "RUNNING");
    if (!task?.TaskHandle) throw new Error("No RUNNING task to cancel. Run bulk, wait for DLQ arrival, then redrive at 1 message/sec.");
    return this.operator(sqs => sqs.send(new CancelMessageMoveTaskCommand({ TaskHandle: task.TaskHandle! })));
  }
  async status() {
    const { source, dlq } = await this.queues();
    return { source: (await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: source, AttributeNames: ["All"] }))).Attributes, dlq: (await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["All"] }))).Attributes, tasks: (await this.tasks()).Results };
  }
  async logEvents() { return (await this.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${this.functionName}`, limit: 100 }))).events ?? []; }
  async verify(jobId = "poison-1") {
    const result = await this.dynamo.send(new GetItemCommand({ TableName: this.tableName, Key: { jobId: { S: jobId } }, ConsistentRead: true }));
    if (result.Item?.status?.S !== "PROCESSED") throw new Error(`${jobId} has not been successfully processed. Inspect consumer logs, not only task completion.`);
    return result.Item;
  }
  async reset() {
    await this.enabled(false);
    const tasks = await this.tasks(); if (tasks.Results?.some(t => t.Status === "RUNNING")) await this.cancel();
    const { source, dlq } = await this.queues();
    for (const QueueUrl of [source, dlq]) await this.sqs.send(new PurgeQueueCommand({ QueueUrl }));
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do { const page: ScanCommandOutput = await this.dynamo.send(new ScanCommand({ TableName: this.tableName, ExclusiveStartKey })); for (const item of page.Items ?? []) await this.dynamo.send(new DeleteItemCommand({ TableName: this.tableName, Key: { jobId: item.jobId } })); ExclusiveStartKey = page.LastEvaluatedKey; } while (ExclusiveStartKey);
    await this.fix(false); await this.enabled(true); return { reset: this.prefix };
  }
  async cleanup() {
    const absent = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (e: any) { if (!["ResourceNotFoundException", "NoSuchEntity", "QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"].includes(e.name)) throw e; } };
    const mappings = await this.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: this.functionName }));
    for (const m of mappings.EventSourceMappings ?? []) await this.lambda.send(new DeleteEventSourceMappingCommand({ UUID: m.UUID! }));
    await absent(() => this.lambda.send(new DeleteFunctionCommand({ FunctionName: this.functionName })));
    for (const name of ["source", "dlq"]) await absent(async () => { const QueueUrl = (await this.sqs.send(new GetQueueUrlCommand({ QueueName: `${this.prefix}-${name}` }))).QueueUrl!; await this.sqs.send(new DeleteQueueCommand({ QueueUrl })); });
    await absent(() => this.dynamo.send(new DeleteTableCommand({ TableName: this.tableName })));
    for (const role of ["worker", "redrive", "producer"]) { const RoleName = `${this.prefix}-${role}-role`; await absent(() => this.iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName: "lab" }))); await absent(() => this.iam.send(new DeleteRoleCommand({ RoleName }))); }
    await absent(() => this.logs.send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${this.functionName}` })));
    for (const api of (await this.api.send(new GetRestApisCommand({ limit: 500 }))).items ?? []) if (api.name === `${this.prefix}-producer`) await this.api.send(new DeleteRestApiCommand({ restApiId: api.id! }));
    return { deleted: this.prefix };
  }
  close() { for (const client of [this.sqs, this.iam, this.sts, this.lambda, this.dynamo, this.logs, this.api]) client.destroy(); }
}

async function main() {
  const lab = new RecoveryLab({ endpoint: process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4570", region: process.env.AWS_REGION, prefix: process.env.LAB_PREFIX, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "password", ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) } });
  const command = process.argv[2];
  try {
    let result: unknown;
    switch (command) {
      case "deploy": result = await lab.deploy(); break;
      case "send": result = await lab.send(); break;
      case "send-api": result = await lab.sendApi(); break;
      case "bulk": result = await lab.send(30); break;
      case "inspect": result = await lab.inspect(); break;
      case "lease": result = await lab.inspectLease(); break;
      case "pause": await lab.enabled(false); result = "Consumer paused"; break;
      case "resume": await lab.enabled(true); result = "Consumer resumed"; break;
      case "fix": result = await lab.fix(); break;
      case "break": result = await lab.fix(false); break;
      case "status": result = await lab.status(); break;
      case "logs": result = await lab.logEvents(); break;
      case "redrive": result = await lab.redrive(process.argv[3] === undefined ? 1 : Number(process.argv[3])); break;
      case "cancel": result = await lab.cancel(); break;
      case "verify": result = await lab.verify(process.argv[3]); break;
      case "reset": result = await lab.reset(); break;
      case "cleanup": result = await lab.cleanup(); break;
      default: throw new Error("Usage: lab.ts deploy|send|send-api|status|logs|inspect|fix|redrive [1..500]|verify [jobId]|break|bulk|cancel|pause|lease|resume|reset|cleanup");
    }
    console.log(JSON.stringify(result, (key, value) => key === "$metadata" ? undefined : value, 2));
  } finally { lab.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
