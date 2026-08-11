import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { CreateTableCommand, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CreateFunctionCommand,
  DeleteFunctionEventInvokeConfigCommand,
  GetFunctionEventInvokeConfigCommand,
  InvokeAsyncCommand,
  InvokeCommand,
  LambdaClient,
  ListFunctionEventInvokeConfigsCommand,
  PublishVersionCommand,
  PutFunctionEventInvokeConfigCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionEventInvokeConfigCommand,
} from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous Lambda work");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForWithClock<T>(clock: TestClock, read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  return waitFor(async () => {
    clock.advance(0);
    await new Promise(resolve => setImmediate(resolve));
    return read();
  }, accept, timeoutMs);
}

test("Lambda async invocation persists before 202, retries deterministically, delivers destinations, recovers, and exposes configuration and metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-async-"));
  const clock = new TestClock(Date.parse("2026-07-15T09:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"});
  let lambda: LambdaClient | undefined;
  let dynamodb: DynamoDBClient | undefined;
  let cloudwatch: CloudWatchClient | undefined;

  const connect = () => {
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    lambda = new LambdaClient({ endpoint, region, credentials });
    dynamodb = new DynamoDBClient({ endpoint, region, credentials });
    cloudwatch = new CloudWatchClient({ endpoint, region, credentials });
    return endpoint;
  };
  const disconnect = () => { lambda?.destroy(); dynamodb?.destroy(); cloudwatch?.destroy(); lambda = undefined; dynamodb = undefined; cloudwatch = undefined; };
  const refreshRuntimeEndpoints = async (endpoint: string) => {
    for (const functionName of ["async-source", "async-destination"]) await lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: functionName, Environment: { Variables: { TABLE_NAME: "AsyncRecords", STACKSIM_ENDPOINT: endpoint } } }));
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  const queue = () => Object.values(simulator.store.regionState(region).lambdaAsyncInvocations);
  const destinationRecord = async (eventId: string): Promise<any | undefined> => {
    const item = (await dynamodb!.send(new GetItemCommand({ TableName: "AsyncRecords", Key: { id: { S: `destination#${eventId}` } } }))).Item;
    return item?.record?.S ? JSON.parse(item.record.S) : undefined;
  };
  const attempts = async (counterId: string) => Number((await dynamodb!.send(new GetItemCommand({ TableName: "AsyncRecords", Key: { id: { S: `attempt#${counterId}` } } }))).Item?.attempts?.N ?? "0");
  const metricSum = async (metricName: string) => {
    const result = await cloudwatch!.send(new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: metricName,
      Dimensions: [{ Name: "FunctionName", Value: "async-source" }],
      StartTime: new Date(clock.now() - 10 * 60_000),
      EndTime: new Date(clock.now() + 60_000),
      Period: 60,
      Statistics: ["Sum"],
    }));
    return result.Datapoints?.reduce((sum, point) => sum + (point.Sum ?? 0), 0) ?? 0;
  };

  try {
    await simulator.start();
    let endpoint = connect();
    await dynamodb!.send(new CreateTableCommand({ TableName: "AsyncRecords", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await waitForTableActive(dynamodb!, "AsyncRecords", clock);
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    const role = "arn:aws:iam::000000000000:role/test";
    const source = await lambda!.send(new CreateFunctionCommand({ FunctionName: "async-source", Runtime: "nodejs22.x", Role: role, Handler: "handler.asyncRetryHandler", Timeout: 5, Code: { ZipFile: zip }, Environment: { Variables: { TABLE_NAME: "AsyncRecords", STACKSIM_ENDPOINT: endpoint } } }));
    const destination = await lambda!.send(new CreateFunctionCommand({ FunctionName: "async-destination", Runtime: "nodejs22.x", Role: role, Handler: "handler.asyncDestinationHandler", Timeout: 5, Code: { ZipFile: zip }, Environment: { Variables: { TABLE_NAME: "AsyncRecords", STACKSIM_ENDPOINT: endpoint } } }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const version = await lambda!.send(new PublishVersionCommand({ FunctionName: "async-source" }));

    const configured = await lambda!.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2, DestinationConfig: { OnSuccess: { Destination: destination.FunctionArn! }, OnFailure: { Destination: destination.FunctionArn! } } }));
    assert.equal(configured.MaximumEventAgeInSeconds, 60);
    assert.equal(configured.MaximumRetryAttempts, 2);
    assert.equal(configured.DestinationConfig?.OnSuccess?.Destination, destination.FunctionArn);
    await lambda!.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-source", Qualifier: version.Version, MaximumEventAgeInSeconds: 120, MaximumRetryAttempts: 0 }));
    const firstPage = await lambda!.send(new ListFunctionEventInvokeConfigsCommand({ FunctionName: "async-source", MaxItems: 1 }));
    assert.equal(firstPage.FunctionEventInvokeConfigs?.length, 1);
    assert.ok(firstPage.NextMarker);
    const secondPage = await lambda!.send(new ListFunctionEventInvokeConfigsCommand({ FunctionName: "async-source", MaxItems: 1, Marker: firstPage.NextMarker }));
    assert.equal(secondPage.FunctionEventInvokeConfigs?.[0].FunctionArn, `${source.FunctionArn}:${version.Version}`);
    const updated = await lambda!.send(new UpdateFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumEventAgeInSeconds: 120 }));
    assert.equal(updated.MaximumRetryAttempts, 2, "Update preserves omitted fields");
    assert.equal((await lambda!.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "async-source" }))).MaximumEventAgeInSeconds, 120);
    await assert.rejects(lambda!.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumEventAgeInSeconds: 59 })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(lambda!.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumRetryAttempts: 3 })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(lambda!.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-source", DestinationConfig: { OnFailure: { Destination: "arn:aws:sqs:eu-west-1:000000000000:missing" } } })), (error: any) => error.name === "InvalidParameterValueException" && /does not exist/.test(error.message));
    await assert.rejects(lambda!.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-source", DestinationConfig: { OnFailure: { Destination: "arn:aws:lambda:us-east-1:000000000000:function:async-destination" } } })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "async-source", DeadLetterConfig: { TargetArn: "arn:aws:sqs:eu-west-1:000000000000:missing" } })), (error: any) => error.name === "InvalidParameterValueException" && /does not exist/.test(error.message));
    await lambda!.send(new DeleteFunctionEventInvokeConfigCommand({ FunctionName: "async-source", Qualifier: version.Version }));
    await assert.rejects(lambda!.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "async-source", Qualifier: version.Version })), (error: any) => error.name === "ResourceNotFoundException");
    await lambda!.send(new UpdateFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumEventAgeInSeconds: 120 }));

    const retryAccepted = await lambda!.send(new InvokeCommand({ FunctionName: "async-source", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ counterId: "retry-success", failAttempts: 1 })) }));
    assert.equal(retryAccepted.StatusCode, 202);
    assert.equal(queue().length, 1, "one accepted request creates one durable queue record");
    const retryEventId = queue()[0].eventId;
    const queueSummary = await (await fetch(`${endpoint}/_stacksim/api/lambda/async?functionName=async-source`, { headers: { "x-stacksim-region": region } })).json() as any;
    assert.equal(queueSummary.queued, 1);
    assert.equal(queueSummary.events[0].eventId, retryEventId);
    assert.equal(queueSummary.events[0].payloadBase64, undefined, "local diagnostics do not expose event payloads");
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.ok(persisted.accounts["000000000000"].regions[region].lambdaAsyncInvocations[retryEventId], "the queue record is persisted before the 202 response");
    clock.advance(0);
    await waitForWithClock(clock, () => queue()[0], event => event?.attempts === 1 && event.status === "QUEUED");
    assert.equal(await attempts("retry-success"), 1);
    clock.advance(60_000);
    const retryDestination: any = await waitForWithClock<any>(clock, () => destinationRecord(retryEventId), Boolean);
    await waitForWithClock(clock, () => queue().length, length => length === 0);
    assert.equal(await attempts("retry-success"), 2);
    assert.equal(retryDestination.requestContext.condition, "Success");
    assert.equal(retryDestination.requestContext.approximateInvokeCount, 2);
    assert.equal(retryDestination.responseContext.executedVersion, "$LATEST");
    assert.deepEqual(retryDestination.requestPayload, { counterId: "retry-success", failAttempts: 1 });
    assert.equal(await metricSum("AsyncEventsReceived"), 1);
    assert.equal(await metricSum("AsyncEventsRetried"), 1);
    assert.equal(await metricSum("AsyncEventsSucceeded"), 1);

    await lambda!.send(new UpdateFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumRetryAttempts: 1 }));
    const failureAccepted = await lambda!.send(new InvokeCommand({ FunctionName: "async-source", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ counterId: "retry-failure", failAttempts: 99 })) }));
    assert.equal(failureAccepted.StatusCode, 202);
    const failureEventId = queue()[0].eventId;
    clock.advance(0);
    await waitForWithClock(clock, () => queue()[0], event => event?.attempts === 1 && event.status === "QUEUED");
    clock.advance(60_000);
    const failureDestination: any = await waitForWithClock<any>(clock, () => destinationRecord(failureEventId), Boolean);
    await waitForWithClock(clock, () => queue().length, length => length === 0);
    assert.equal(await attempts("retry-failure"), 2);
    assert.equal(failureDestination.requestContext.condition, "RetriesExhausted");
    assert.equal(failureDestination.requestContext.approximateInvokeCount, 2);
    assert.equal(failureDestination.responseContext.functionError, "Unhandled");
    assert.equal(await metricSum("AsyncEventsDropped"), 1);

    await lambda!.send(new UpdateFunctionEventInvokeConfigCommand({ FunctionName: "async-source", MaximumEventAgeInSeconds: 60 }));
    const ageAccepted = await lambda!.send(new InvokeCommand({ FunctionName: "async-source", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ counterId: "too-old", failAttempts: 0 })) }));
    assert.equal(ageAccepted.StatusCode, 202);
    const ageEventId = queue()[0].eventId;
    disconnect();
    await simulator.stop();
    clock.advance(61_000);
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"});
    await simulator.start();
    endpoint = connect();
    await refreshRuntimeEndpoints(endpoint);
    clock.advance(0);
    const ageDestination: any = await waitForWithClock<any>(clock, () => destinationRecord(ageEventId), Boolean);
    await waitForWithClock(clock, () => queue().length, length => length === 0);
    assert.equal(ageDestination.requestContext.condition, "EventAgeExceeded");
    assert.equal(ageDestination.requestContext.approximateInvokeCount, 0);
    assert.equal(await attempts("too-old"), 0);

    const recoveryAccepted = await lambda!.send(new InvokeCommand({ FunctionName: "async-source", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ counterId: "recovered", failAttempts: 0 })) }));
    assert.equal(recoveryAccepted.StatusCode, 202);
    const recoveryEvent = queue()[0];
    recoveryEvent.status = "LEASED";
    recoveryEvent.leaseId = "interrupted-worker";
    recoveryEvent.leaseUntil = clock.now() + 30_000;
    await simulator.store.save();
    disconnect();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"});
    await simulator.start();
    endpoint = connect();
    await refreshRuntimeEndpoints(endpoint);
    clock.advance(0);
    const recoveredDestination: any = await waitForWithClock<any>(clock, () => destinationRecord(recoveryEvent.eventId), Boolean);
    await waitForWithClock(clock, () => queue().length, length => length === 0);
    assert.equal(recoveredDestination.requestContext.condition, "Success");
    assert.equal(recoveredDestination.requestContext.approximateInvokeCount, 1);
    assert.equal(await attempts("recovered"), 1);

    const deprecated = await lambda!.send(new InvokeAsyncCommand({ FunctionName: "async-source", InvokeArgs: Buffer.from(JSON.stringify({ counterId: "deprecated", failAttempts: 0 })) }));
    assert.equal(deprecated.Status, 202);
    const deprecatedEventId = queue()[0].eventId;
    clock.advance(0);
    await waitForWithClock(clock, () => destinationRecord(deprecatedEventId), Boolean);
    await waitForWithClock(clock, () => queue().length, length => length === 0);
    assert.equal(await attempts("deprecated"), 1);
    const oversized = await fetch(`${endpoint}/2014-11-13/functions/async-source/invoke-async`, { method: "POST", body: Buffer.alloc(256 * 1024 + 1, 32) });
    assert.equal(oversized.status, 413);
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally {
    disconnect();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
