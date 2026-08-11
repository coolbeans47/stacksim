import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateTableCommand,
  DescribeKinesisStreamingDestinationCommand,
  DisableKinesisStreamingDestinationCommand,
  DynamoDBClient,
  EnableKinesisStreamingDestinationCommand,
  PutItemCommand,
  UpdateTableCommand,
  UpdateKinesisStreamingDestinationCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function clientFor(simulator: StackSim): DynamoDBClient { return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 }); }
async function tick(clock: TestClock, milliseconds = 50): Promise<void> { clock.advance(milliseconds); await new Promise<void>(resolve => setImmediate(resolve)); }

test("DynamoDB Kinesis destinations persist configuration lifecycles without fabricating record delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-kinesis-")); const clock = new TestClock(Date.parse("2026-07-16T01:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: DynamoDBClient | undefined; const streamOne = "arn:aws:kinesis:eu-west-1:000000000000:stream/learning-events"; const streamTwo = "arn:aws:kinesis:eu-west-1:000000000000:stream/replacement-events";
  try {
    await simulator.start(); client = clientFor(simulator); const created = await client.send(new CreateTableCommand({ TableName: "KinesisRecords", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); const tableArn = created.TableDescription!.TableArn!; await waitForTableActive(client, "KinesisRecords", clock); assert.deepEqual((await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: tableArn }))).KinesisDataStreamDestinations, []); await client.send(new UpdateTableCommand({ TableName: "KinesisRecords", StreamSpecification: { StreamEnabled: true, StreamViewType: "KEYS_ONLY" } })); assert.deepEqual((await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "KinesisRecords" }))).KinesisDataStreamDestinations, []); await tick(clock);
    await assert.rejects(client.send(new EnableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: "not-an-arn" })), (error: any) => error.name === "ValidationException"); await assert.rejects(client.send(new EnableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: "arn:aws:kinesis:us-east-1:000000000000:stream/wrong-region" })), (error: any) => error.name === "ValidationException" && /same account and Region/.test(error.message)); await assert.rejects(client.send(new EnableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: streamOne, EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "SECOND" as any } })), (error: any) => error.name === "ValidationException");

    const enabling = await client.send(new EnableKinesisStreamingDestinationCommand({ TableName: tableArn, StreamArn: streamOne })); assert.equal(enabling.DestinationStatus, "ENABLING"); assert.equal(enabling.EnableKinesisStreamingConfiguration?.ApproximateCreationDateTimePrecision, "MILLISECOND"); await assert.rejects(client.send(new EnableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: streamTwo })), (error: any) => error.name === "ResourceInUseException"); await tick(clock); let described = await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "KinesisRecords" })); assert.equal(described.TableName, "KinesisRecords"); assert.equal(described.KinesisDataStreamDestinations?.[0].DestinationStatus, "ACTIVE"); assert.match(described.KinesisDataStreamDestinations?.[0].DestinationStatusDescription ?? "", /not implemented.*not delivered/i);
    await client.send(new PutItemCommand({ TableName: "KinesisRecords", Item: { id: { S: "configuration-only" }, value: { S: "no Kinesis record is fabricated" } } })); assert.equal((await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "KinesisRecords" }))).KinesisDataStreamDestinations?.[0].DestinationStatus, "ACTIVE");

    const updating = await client.send(new UpdateKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: streamOne, UpdateKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MICROSECOND" } })); assert.equal(updating.DestinationStatus, "UPDATING"); assert.equal(updating.UpdateKinesisStreamingConfiguration?.ApproximateCreationDateTimePrecision, "MICROSECOND"); client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator); await tick(clock); described = await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "KinesisRecords" })); assert.equal(described.KinesisDataStreamDestinations?.[0].DestinationStatus, "ACTIVE"); assert.equal(described.KinesisDataStreamDestinations?.[0].ApproximateCreationDateTimePrecision, "MICROSECOND");

    await assert.rejects(client.send(new DisableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: streamTwo })), (error: any) => error.name === "ResourceNotFoundException"); const disabling = await client.send(new DisableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: streamOne })); assert.equal(disabling.DestinationStatus, "DISABLING"); client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator); await tick(clock); described = await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "KinesisRecords" })); assert.equal(described.KinesisDataStreamDestinations?.[0].DestinationStatus, "DISABLED");

    await client.send(new EnableKinesisStreamingDestinationCommand({ TableName: "KinesisRecords", StreamArn: streamTwo, EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MICROSECOND" } })); await tick(clock); described = await client.send(new DescribeKinesisStreamingDestinationCommand({ TableName: "KinesisRecords" })); assert.equal(described.KinesisDataStreamDestinations?.length, 1); assert.equal(described.KinesisDataStreamDestinations?.[0].StreamArn, streamTwo); assert.equal(described.KinesisDataStreamDestinations?.[0].DestinationStatus, "ACTIVE"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
