import assert from "node:assert/strict";
import { test } from "node:test";
import { addObservedObjectTags, buildAuditItem, buildAuditItems } from "../lambda/audit-record.mjs";

test("builds a readable direct object-created audit record", () => {
  const record = {
    eventVersion: "2.3",
    eventSource: "aws:s3",
    awsRegion: "eu-west-1",
    eventTime: "2026-08-04T10:00:00.000Z",
    eventName: "ObjectCreated:Put",
    userIdentity: { principalId: "learner" },
    requestParameters: { sourceIPAddress: "127.0.0.1" },
    responseElements: { "x-amz-request-id": "request-1", "x-amz-id-2": "host-1" },
    s3: {
      s3SchemaVersion: "1.0",
      configurationId: "all-supported-events-to-audit-lambda",
      bucket: { name: "learning-bucket", arn: "arn:aws:s3:::learning-bucket" },
      object: { key: "notes%2Fhello+world.txt", size: 12, eTag: "abc", versionId: "v1", sequencer: "001" },
    },
  };

  const item = buildAuditItem(record, "2026-08-04T10:00:01.000Z", "lambda-1");

  assert.equal(item.bucketName.S, "learning-bucket");
  assert.equal(item.eventKey.S, "2026-08-04T10:00:00.000Z#001#0");
  assert.equal(item.eventName.S, "s3:ObjectCreated:Put");
  assert.equal(item.configurationId.S, "all-supported-events-to-audit-lambda");
  assert.equal(item.objectKey.S, "notes/hello world.txt");
  assert.equal(item.objectSize.N, "12");
  assert.match(item.summary.S, /ObjectCreated:Put/);
  assert.equal(JSON.parse(item.rawRecordJson.S).responseElements["x-amz-request-id"], "request-1");
});

test("keeps unfamiliar direct event fields instead of rejecting them", () => {
  const record = {
    eventTime: "2026-08-04T11:00:00.000Z",
    eventName: "FutureObjectOperation",
    s3: {
      bucket: { name: "learning-bucket" },
      object: { key: "future.txt", sequencer: "002", futureField: { explanation: "preserved" } },
    },
  };

  const item = buildAuditItem(record, "2026-08-04T11:00:01.000Z", "lambda-2");

  assert.equal(item.eventName.S, "s3:FutureObjectOperation");
  assert.deepEqual(JSON.parse(item.rawRecordJson.S).s3.object.futureField, { explanation: "preserved" });
});

test("records the differently shaped S3 test event sent during configuration", () => {
  const event = {
    Service: "Amazon S3",
    Event: "s3:TestEvent",
    Time: "2026-08-04T09:00:00.000Z",
    Bucket: "learning-bucket",
    RequestId: "test-request",
    HostId: "test-host",
  };

  const [item] = buildAuditItems(event, "2026-08-04T09:00:01.000Z", "lambda-test");

  assert.equal(item.bucketName.S, "learning-bucket");
  assert.equal(item.eventName.S, "s3:TestEvent");
  assert.equal(item.requestId.S, "test-request");
});

test("adds object tags observed by the Lambda as a readable DynamoDB map", () => {
  const item = { bucketName: { S: "learning-bucket" } };

  addObservedObjectTags(item, [
    { Key: "Custom1", Value: "Test" },
    { Key: "stage", Value: "learning" },
  ], "2026-08-04T12:00:00.000Z");

  assert.deepEqual(item.objectTags, {
    M: {
      Custom1: { S: "Test" },
      stage: { S: "learning" },
    },
  });
  assert.equal(item.objectTagCount.N, "2");
  assert.equal(item.objectTagsSource.S, "s3:GetObjectTagging");
});
