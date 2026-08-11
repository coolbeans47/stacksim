import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateTableCommand, DeleteItemCommand, DeleteTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  CreateAliasCommand,
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  DeleteAliasCommand,
  DeleteEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  ListTagsCommand,
  PublishVersionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateEventSourceMappingCommand,
} from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

async function progress<T>(clock: TestClock, read: () => T | Promise<T>, accept: (value: T) => boolean, iterations = 160): Promise<T> {
  let last: T | undefined;
  for (let index = 0; index < iterations; index++) {
    clock.advance(250);
    await new Promise(resolve => setTimeout(resolve, 10));
    last = await read(); if (accept(last)) return last;
  }
  throw new Error(`Timed out waiting for DynamoDB stream event source mapping work; last observed value: ${JSON.stringify(last)}`);
}

test("Lambda DynamoDB stream mappings expose CRUD and durable checkpoints, filters, retries, bisection, partial failures, age limits, and deletion state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-stream-")); const clock = new TestClock(Date.parse("2026-07-15T12:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); let lambda: LambdaClient | undefined; let dynamodb: DynamoDBClient | undefined;
  const mappingState = (uuid: string) => simulator.store.regionState(region).lambdaEventSourceMappings[uuid];
  const connect = () => { const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; lambda = new LambdaClient(options); dynamodb = new DynamoDBClient(options); return options.endpoint; };
  const disconnect = () => { lambda?.destroy(); dynamodb?.destroy(); lambda = undefined; dynamodb = undefined; };
  const item = (id: string) => dynamodb!.send(new GetItemCommand({ TableName: "StreamResults", Key: { id: { S: id } } }));
  try {
    await simulator.start(); let endpoint = connect();
    await dynamodb!.send(new CreateTableCommand({ TableName: "StreamResults", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    const source = await dynamodb!.send(new CreateTableCommand({ TableName: "StreamSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } }));
    const secondSource = await dynamodb!.send(new CreateTableCommand({ TableName: "SecondStreamSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" } }));
    for (const tableName of ["StreamResults", "StreamSource", "SecondStreamSource"]) await waitForTableActive(dynamodb!, tableName, clock);
    const sourceArn = source.TableDescription!.LatestStreamArn!; const secondSourceArn = secondSource.TableDescription!.LatestStreamArn!;
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); const role = "arn:aws:iam::000000000000:role/test";
    const fn = await lambda!.send(new CreateFunctionCommand({ FunctionName: "stream-consumer", Runtime: "nodejs22.x", Role: role, Handler: "handler.dynamoStreamHandler", Timeout: 5, Code: { ZipFile: zip }, Environment: { Variables: { TABLE_NAME: "StreamResults", STACKSIM_ENDPOINT: endpoint } } }));
    await new Promise(resolve => setTimeout(resolve, 10)); const version = await lambda!.send(new PublishVersionCommand({ FunctionName: "stream-consumer" })); await lambda!.send(new CreateAliasCommand({ FunctionName: "stream-consumer", Name: "stream-live", FunctionVersion: version.Version! }));

    await assert.rejects(lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: "stream-consumer", EventSourceArn: sourceArn, StartingPosition: "TRIM_HORIZON", BatchSize: 11 })), (error: any) => error.name === "InvalidParameterValueException" && /BatchingWindow/.test(error.message));
    await assert.rejects(lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: "stream-consumer", EventSourceArn: "arn:aws:kinesis:eu-west-1:000000000000:stream/missing", StartingPosition: "TRIM_HORIZON" })), (error: any) => error.name === "InvalidParameterValueException" && /kinesis event sources/.test(error.message));
    await assert.rejects(lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: "stream-consumer", EventSourceArn: sourceArn, StartingPosition: "TRIM_HORIZON", DestinationConfig: { OnFailure: { Destination: "arn:aws:sqs:eu-west-1:000000000000:missing" } } })), (error: any) => error.name === "ResourceNotFoundException" && /does not exist/.test(error.message));
    await assert.rejects(lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: "stream-consumer", EventSourceArn: sourceArn, StartingPosition: "TRIM_HORIZON", SourceAccessConfigurations: [{ Type: "BASIC_AUTH", URI: "secret" }] })), (error: any) => error.name === "InvalidParameterValueException" && /not supported for DynamoDB/.test(error.message));

    const criteria = { Filters: [{ Pattern: JSON.stringify({ dynamodb: { NewImage: { kind: { S: ["keep"] } } } }) }] };
    const created = await lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: "stream-consumer", EventSourceArn: sourceArn, StartingPosition: "TRIM_HORIZON", BatchSize: 2, ParallelizationFactor: 2, MaximumRecordAgeInSeconds: 60, MaximumRetryAttempts: 2, BisectBatchOnFunctionError: true, FunctionResponseTypes: ["ReportBatchItemFailures"], FilterCriteria: criteria, Tags: { owner: "learning" } }));
    const uuid = created.UUID!; assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f-]{27}$/); assert.equal(created.State, "Creating"); assert.equal(created.ParallelizationFactor, 2); assert.equal(created.FilterCriteria?.Filters?.[0].Pattern, criteria.Filters[0].Pattern); assert.match(created.EventSourceMappingArn ?? "", /event-source-mapping:/); clock.advance(0); await new Promise(resolve => setImmediate(resolve)); assert.equal(mappingState(uuid).state, "Enabled");
    await lambda!.send(new TagResourceCommand({ Resource: created.EventSourceMappingArn!, Tags: { environment: "test" } })); await lambda!.send(new UntagResourceCommand({ Resource: created.EventSourceMappingArn!, TagKeys: ["owner"] })); assert.deepEqual((await lambda!.send(new ListTagsCommand({ Resource: created.EventSourceMappingArn! }))).Tags, { environment: "test" });
    const aliasMapping = await lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: "stream-consumer:stream-live", EventSourceArn: secondSourceArn, StartingPosition: "LATEST", Enabled: false, Tags: { purpose: "pagination" } })); assert.equal(aliasMapping.FunctionArn, `${fn.FunctionArn}:stream-live`);
    const pageOne = await lambda!.send(new ListEventSourceMappingsCommand({ MaxItems: 1 })); assert.equal(pageOne.EventSourceMappings?.length, 1); assert.ok(pageOne.NextMarker); assert.equal((await lambda!.send(new ListEventSourceMappingsCommand({ MaxItems: 1, Marker: pageOne.NextMarker }))).EventSourceMappings?.length, 1); assert.equal((await lambda!.send(new ListEventSourceMappingsCommand({ FunctionName: "stream-consumer", EventSourceArn: sourceArn }))).EventSourceMappings?.[0].UUID, uuid);
    const changed = await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, TumblingWindowInSeconds: 1, MaximumBatchingWindowInSeconds: 1 })); assert.equal(changed.TumblingWindowInSeconds, 1); assert.equal(changed.MaximumBatchingWindowInSeconds, 1); await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, TumblingWindowInSeconds: 0, MaximumBatchingWindowInSeconds: 0 }));
    await assert.rejects(fetch(`${endpoint}/2015-03-31/event-source-mappings/${uuid}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ StartingPosition: "LATEST" }) }).then(async response => { if (!response.ok) { const body = await response.json() as any; const error = new Error(body.message) as any; error.name = body.__type; throw error; } }), (error: any) => error.name === "InvalidParameterValueException");

    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "skip" }, kind: { S: "drop" } } }));
    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "keep-one" }, kind: { S: "keep" } } }));
    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "keep-two" }, kind: { S: "keep" } } }));
    await progress(clock, () => mappingState(uuid).lastProcessingResult, result => result === "OK"); const filteredCheckpoint = mappingState(uuid).nextSequenceNumber;
    const processed = (await dynamodb!.send(new ScanCommand({ TableName: "StreamResults" }))).Items ?? []; const streamRecords = processed.filter(entry => entry.id?.S?.startsWith("stream-record#")); assert.equal(streamRecords.length, 2); assert.deepEqual(streamRecords.map(entry => JSON.parse(entry.record!.S!).dynamodb.Keys.id.S).sort(), ["keep-one", "keep-two"]);

    await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: false })); await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "paused" }, kind: { S: "keep" } } })); const pausedSequence = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!; clock.advance(1_000); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(mappingState(uuid).nextSequenceNumber, filteredCheckpoint); assert.equal((await item(`stream-attempt#${pausedSequence}`)).Item, undefined);
    await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: true, BatchSize: 1 })); await progress(clock, () => item(`stream-attempt#${pausedSequence}`), result => Boolean(result.Item)); assert.equal(mappingState(uuid).lastProcessingResult, "OK");

    const batchesBeforeParallel = new Set(((await dynamodb!.send(new ScanCommand({ TableName: "StreamResults" }))).Items ?? []).filter(entry => entry.id?.S?.startsWith("batch#")).map(entry => entry.id!.S!)); await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, BatchSize: 2, ParallelizationFactor: 2, FilterCriteria: { Filters: [] }, FunctionResponseTypes: [] }));
    for (const id of ["parallel-one", "parallel-two", "parallel-three", "parallel-four"]) await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: id } } })); const parallelThrough = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!;
    await progress(clock, () => mappingState(uuid).nextSequenceNumber, checkpoint => BigInt(checkpoint) > BigInt(parallelThrough)); const parallelBatches = ((await dynamodb!.send(new ScanCommand({ TableName: "StreamResults" }))).Items ?? []).filter(entry => entry.id?.S?.startsWith("batch#") && !batchesBeforeParallel.has(entry.id.S)); assert.equal(parallelBatches.length, 2); assert.deepEqual(parallelBatches.map(entry => entry.size?.N).sort(), ["2", "2"], "parallelization factor dispatches two per-shard batches in one durable group");

    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "lifecycle" }, value: { N: "1" } } }));
    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "lifecycle" }, value: { N: "2" } } }));
    await dynamodb!.send(new DeleteItemCommand({ TableName: "StreamSource", Key: { id: { S: "lifecycle" } } }));
    const lifecycleThrough = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!;
    await progress(clock, () => mappingState(uuid).nextSequenceNumber, checkpoint => BigInt(checkpoint) > BigInt(lifecycleThrough));
    const lifecycleRecords = ((await dynamodb!.send(new ScanCommand({ TableName: "StreamResults" }))).Items ?? []).filter(entry => entry.id?.S?.startsWith("stream-record#") && JSON.parse(entry.record!.S!).dynamodb.Keys.id.S === "lifecycle").sort((left, right) => Number(BigInt(left.sequence!.S!) - BigInt(right.sequence!.S!)));
    assert.deepEqual(lifecycleRecords.map(entry => entry.eventName?.S), ["INSERT", "MODIFY", "REMOVE"]);

    await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, BatchSize: 3, BisectBatchOnFunctionError: false, MaximumRetryAttempts: 2, FilterCriteria: { Filters: [] }, FunctionResponseTypes: ["ReportBatchItemFailures"] }));
    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "partial-prefix" } } })); await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "partial-once" }, partialOnce: { BOOL: true } } })); const partialSequence = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!; await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "partial-suffix" } } }));
    await progress(clock, () => mappingState(uuid).lastProcessingResult, result => result === "Partial batch failure"); assert.equal(mappingState(uuid).nextSequenceNumber, partialSequence); assert.equal(mappingState(uuid).pendingBatch?.sequenceNumbers[0], partialSequence); await progress(clock, () => mappingState(uuid).lastProcessingResult, result => result === "OK"); assert.equal(Number((await item(`stream-attempt#${partialSequence}`)).Item?.attempts?.N), 2);

    await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, BatchSize: 4, BisectBatchOnFunctionError: true, MaximumRetryAttempts: 0, FunctionResponseTypes: [] }));
    for (const [id, fail] of [["bisect-good-one", false], ["bisect-bad", true], ["bisect-good-two", false], ["bisect-good-three", false]] as const) await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: id }, ...(fail ? { fail: { BOOL: true } } : {}) } }));
    const bisectThrough = Object.values(simulator.store.regionState(region).dynamodbStreams).find(stream => stream.streamArn === sourceArn)!.lastSequenceNumber!;
    await progress(clock, () => mappingState(uuid), state => !state.pendingBatch && BigInt(state.nextSequenceNumber) > BigInt(bisectThrough), 320); const batches = (await dynamodb!.send(new ScanCommand({ TableName: "StreamResults" }))).Items?.filter(entry => entry.id?.S?.startsWith("batch#")) ?? []; assert.ok(batches.some(entry => entry.size?.N === "4")); assert.ok(batches.some(entry => entry.size?.N === "1"), "a failing batch is bisected down to one record");

    const checkpointBeforeWindow = mappingState(uuid).nextSequenceNumber; const windowStart = new Date(Math.floor(clock.now() / 1000) * 1000).toISOString(); await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, BatchSize: 2, TumblingWindowInSeconds: 1, MaximumRetryAttempts: 2, FunctionResponseTypes: ["ReportBatchItemFailures"] })); await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "window-one" } } })); await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "window-two" } } })); const windowThrough = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!;
    await progress(clock, () => mappingState(uuid).lastProcessingResult, result => result === "Window batch processed"); assert.equal(mappingState(uuid).nextSequenceNumber, checkpointBeforeWindow, "tumbling aggregation does not checkpoint before the final invocation"); assert.deepEqual(mappingState(uuid).tumblingWindowState?.state, { count: 2 }); clock.advance(1_000); await progress(clock, () => mappingState(uuid).nextSequenceNumber, checkpoint => BigInt(checkpoint) > BigInt(windowThrough)); assert.equal((await item(`window#${windowStart}`)).Item?.count?.N, "2"); await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, TumblingWindowInSeconds: 0 }));

    await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: false, BatchSize: 1, BisectBatchOnFunctionError: false, MaximumRecordAgeInSeconds: 60 })); await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "too-old" } } })); const oldSequence = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!; clock.advance(61_000); await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: true })); await progress(clock, () => mappingState(uuid).lastProcessingResult, result => result === "Records expired"); assert.equal((await item(`stream-attempt#${oldSequence}`)).Item, undefined);

    await lambda!.send(new UpdateEventSourceMappingCommand({ UUID: uuid, MaximumRecordAgeInSeconds: -1, MaximumRetryAttempts: 1 }));
    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "restart-failure" }, fail: { BOOL: true } } }));
    const restartSequence = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!;
    await progress(clock, async () => ({ pending: mappingState(uuid).pendingBatch, attempt: await item(`stream-attempt#${restartSequence}`) }), result => result.pending?.attempts === 1 && result.attempt.Item?.attempts?.N === "1");
    const checkpointBeforeRestart = mappingState(uuid).nextSequenceNumber; disconnect(); await simulator.stop(); assert.equal(mappingState(uuid).pendingBatch?.attempts, 1, "shutdown interruption preserves the in-flight batch for replay"); assert.equal(mappingState(uuid).nextSequenceNumber, checkpointBeforeRestart, "shutdown interruption does not advance the checkpoint");
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); await simulator.start(); endpoint = connect(); simulator.store.regionState(region).functions["stream-consumer"].environment.STACKSIM_ENDPOINT = endpoint; await simulator.store.save(); clock.advance(1_000);
    await progress(clock, () => mappingState(uuid), state => !state.pendingBatch && state.lastProcessingResult === "Retry attempts exhausted");
    assert.equal(Number((await item(`stream-attempt#${restartSequence}`)).Item?.attempts?.N), 2);

    const lambdaService = simulator.lambda as any; const prepareRuntime = lambdaService.prepareRuntime.bind(lambdaService); let prepareEntered = false; let releasePrepare: () => void = () => undefined; const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve; });
    await lambdaService.workerPool.retireFunctionVersion("stream-consumer", "$LATEST");
    lambdaService.prepareRuntime = async (...args: any[]) => { const runtime = await prepareRuntime(...args); prepareEntered = true; await prepareGate; return runtime; };
    await dynamodb!.send(new PutItemCommand({ TableName: "StreamSource", Item: { id: { S: "pre-spawn-interruption" } } })); const preSpawnSequence = simulator.store.regionState(region).dynamodbStreams[sourceArn].lastSequenceNumber!;
    await progress(clock, () => prepareEntered, entered => entered); const preSpawnCheckpoint = mappingState(uuid).nextSequenceNumber; disconnect(); const stopping = simulator.stop(); releasePrepare(); await stopping;
    assert.equal(mappingState(uuid).pendingBatch?.attempts, 1, "pre-spawn shutdown interruption preserves the in-flight batch"); assert.equal(mappingState(uuid).nextSequenceNumber, preSpawnCheckpoint, "pre-spawn shutdown interruption does not advance the checkpoint");
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); await simulator.start(); endpoint = connect(); simulator.store.regionState(region).functions["stream-consumer"].environment.STACKSIM_ENDPOINT = endpoint; await simulator.store.save(); clock.advance(1_000);
    await progress(clock, () => mappingState(uuid).nextSequenceNumber, checkpoint => BigInt(checkpoint) > BigInt(preSpawnSequence)); assert.equal(mappingState(uuid).lastProcessingResult, "OK");

    await lambda!.send(new DeleteAliasCommand({ FunctionName: "stream-consumer", Name: "stream-live" })); assert.equal((await lambda!.send(new GetEventSourceMappingCommand({ UUID: aliasMapping.UUID! }))).State, "Disabled"); await dynamodb!.send(new DeleteTableCommand({ TableName: "StreamSource" })); await progress(clock, () => mappingState(uuid).state, state => state === "Disabled"); assert.match(mappingState(uuid).stateTransitionReason, /stream was disabled|no longer exists/); const deleted = await lambda!.send(new DeleteEventSourceMappingCommand({ UUID: uuid })); assert.equal(deleted.State, "Deleting"); await assert.rejects(lambda!.send(new GetEventSourceMappingCommand({ UUID: uuid })), (error: any) => error.name === "ResourceNotFoundException"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda stream mapping creation validates execution-role DynamoDB Streams permissions in enforce mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-stream-role-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; const iam = new IAMClient(options); const lambda = new LambdaClient(options); const dynamodb = new DynamoDBClient(options); clients.push(iam, lambda, dynamodb);
    const source = await dynamodb.send(new CreateTableCommand({ TableName: "PermissionStream", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "KEYS_ONLY" } })); const streamArn = source.TableDescription!.LatestStreamArn!;
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); const role = await iam.send(new CreateRoleCommand({ RoleName: "stream-reader", AssumeRolePolicyDocument: trust })); await iam.send(new AttachRolePolicyCommand({ RoleName: "stream-reader", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" })); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); await lambda.send(new CreateFunctionCommand({ FunctionName: "permission-consumer", Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "handler.echoHandler", Code: { ZipFile: zip } })); await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "permission-consumer", EventSourceArn: streamArn, StartingPosition: "TRIM_HORIZON" })), (error: any) => error.name === "InvalidParameterValueException" && /not authorized to read/.test(error.message));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "stream-reader", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole" })); assert.equal((await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "permission-consumer", EventSourceArn: streamArn, StartingPosition: "TRIM_HORIZON", Enabled: false }))).State, "Creating");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
