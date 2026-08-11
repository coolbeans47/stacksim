import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateBucketCommand,
  DeleteObjectAnnotationCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
  GetObjectCommand,
  GetObjectAnnotationCommand,
  GetObjectLegalHoldCommand,
  GetObjectRetentionCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectAnnotationsCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  PutObjectAnnotationCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  PutObjectTaggingCommand,
  RestoreObjectCommand,
  S3Client,
  UpdateObjectEncryptionCommand,
} from "@aws-sdk/client-s3";
import { CreateQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve)); };

test("S3-06 through S3-08 govern versions, transition/restore archives, and durably notify SQS", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-s3-06-08-"));
  const clock = new TestClock(Date.parse("2026-07-30T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off" });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const s3 = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials });
  const sqs = new SQSClient({ endpoint, region: "eu-west-1", credentials });
  const lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials });
  const bucket = "s3-governance-lifecycle-events";
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await s3.send(new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: false }] } }));
    assert.equal((await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }))).ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm, "AES256");
    await assert.rejects(s3.send(new PutObjectCommand({ Bucket: bucket, Key: "kms-blocked", Body: "no partial version", ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/local-test" })), (error: any) => error.name === "KMS.NotFoundException");

    const customerKey = Buffer.alloc(32, 7).toString("base64");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "customer", Body: "secret", SSECustomerAlgorithm: "AES256", SSECustomerKey: customerKey }));
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: bucket, Key: "customer" })), (error: any) => error.name === "InvalidRequest");
    assert.equal(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "customer", SSECustomerAlgorithm: "AES256", SSECustomerKey: customerKey }))).Body?.transformToString(), "secret");
    await assert.rejects(s3.send(new UpdateObjectEncryptionCommand({ Bucket: bucket, Key: "customer", ObjectEncryption: { SSEKMS: { KMSKeyArn: `arn:aws:kms:eu-west-1:${simulator.store.accountId}:key/00000000-0000-4000-8000-000000000001` } } })), (error: any) => error.name === "KMS.NotFoundException");
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: bucket, Key: "customer" })), (error: any) => error.name === "InvalidRequest");
    const updatedEncryption = await fetch(`${endpoint}/${bucket}/customer?encryption`, { method: "PUT", headers: { "content-type": "application/xml", "x-stacksim-service": "s3" }, body: `<ObjectEncryption xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><SSE-S3/></ObjectEncryption>` });
    assert.equal(updatedEncryption.status, 200);
    assert.equal(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "customer" }))).Body?.transformToString(), "secret");
    await s3.send(new PutObjectAnnotationCommand({ Bucket: bucket, Key: "customer", AnnotationName: "review", AnnotationPayload: "approved" }));
    assert.equal(await (await s3.send(new GetObjectAnnotationCommand({ Bucket: bucket, Key: "customer", AnnotationName: "review" }))).AnnotationPayload?.transformToString(), "approved");
    assert.deepEqual((await s3.send(new ListObjectAnnotationsCommand({ Bucket: bucket, Key: "customer" }))).Annotations?.map(value => value.AnnotationName), ["review"]);
    await s3.send(new DeleteObjectAnnotationCommand({ Bucket: bucket, Key: "customer", AnnotationName: "review" }));

    const retained = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "retained", Body: "locked" }));
    await s3.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: "retained", VersionId: retained.VersionId, Tagging: { TagSet: [{ Key: "stage", Value: "archive" }] } }));
    assert.deepEqual((await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: "retained", VersionId: retained.VersionId }))).TagSet, [{ Key: "stage", Value: "archive" }]);
    const retainUntil = new Date(clock.now() + 86_400_000);
    await s3.send(new PutObjectRetentionCommand({ Bucket: bucket, Key: "retained", VersionId: retained.VersionId, Retention: { Mode: "GOVERNANCE", RetainUntilDate: retainUntil } }));
    assert.equal((await s3.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: "retained", VersionId: retained.VersionId }))).Retention?.Mode, "GOVERNANCE");
    await s3.send(new PutObjectLegalHoldCommand({ Bucket: bucket, Key: "retained", VersionId: retained.VersionId, LegalHold: { Status: "ON" } }));
    assert.equal((await s3.send(new GetObjectLegalHoldCommand({ Bucket: bucket, Key: "retained", VersionId: retained.VersionId }))).LegalHold?.Status, "ON");

    const queueName = "s3-notifications";
    const queueArn = `arn:aws:sqs:eu-west-1:${simulator.store.accountId}:${queueName}`;
    const queueUrl = (await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": `arn:aws:s3:::${bucket}` }, StringEquals: { "aws:SourceAccount": simulator.store.accountId } } }] }),
      },
    }))).QueueUrl!;
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    const directFunction = await lambda.send(new CreateFunctionCommand({ FunctionName: "s3-direct-notification", Runtime: "nodejs22.x", Role: `arn:aws:iam::${simulator.store.accountId}:role/test`, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "s3-direct-notification", StatementId: "allow-s3", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com", SourceArn: `arn:aws:s3:::${bucket}`, SourceAccount: simulator.store.accountId }));
    await s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: bucket, NotificationConfiguration: { QueueConfigurations: [{ Id: "created", QueueArn: queueArn, Events: ["s3:ObjectCreated:*"], Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "incoming/" }] } } }], LambdaFunctionConfigurations: [{ Id: "direct-lambda", LambdaFunctionArn: directFunction.FunctionArn!, Events: ["s3:ObjectTagging:*"] }], EventBridgeConfiguration: {} } }));
    const notifications = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }));
    assert.equal(notifications.QueueConfigurations?.[0].Id, "created");
    assert.equal(notifications.LambdaFunctionConfigurations?.[0].Id, "direct-lambda");
    assert.equal(notifications.LambdaFunctionConfigurations?.[0].LambdaFunctionArn, directFunction.FunctionArn);
    assert.deepEqual(notifications.LambdaFunctionConfigurations?.[0].Events, ["s3:ObjectTagging:*"]);
    assert.ok(notifications.EventBridgeConfiguration);
    await settle();
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }));

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "incoming/archive.txt", Body: "archive me", Tagging: "stage=archive" }));
    await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: [{ ID: "archive", Status: "Enabled", Filter: { And: { Prefix: "incoming/", Tags: [{ Key: "stage", Value: "archive" }] } }, Transitions: [{ Days: 0, StorageClass: "GLACIER" }] }] } }));
    assert.equal((await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))).Rules?.[0].ID, "archive");
    assert.equal((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "incoming/archive.txt" }))).StorageClass, "GLACIER");
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: bucket, Key: "incoming/archive.txt" })), (error: any) => error.name === "InvalidObjectState");
    await s3.send(new RestoreObjectCommand({ Bucket: bucket, Key: "incoming/archive.txt", RestoreRequest: { Days: 1, GlacierJobParameters: { Tier: "Expedited" } } }));
    clock.advance(100); await settle();
    assert.equal(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "incoming/archive.txt" }))).Body?.transformToString(), "archive me");
    await settle();
    const delivered = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, MessageAttributeNames: ["All"] }));
    const records = delivered.Messages?.flatMap(message => {
      try { return JSON.parse(message.Body ?? "{}").Records ?? []; } catch { return []; }
    }) ?? [];
    assert.ok(records.some((record: any) => record.eventName === "ObjectCreated:Put" && record.s3.object.key === "incoming%2Farchive.txt"));
  } finally {
    s3.destroy(); sqs.destroy(); lambda.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true });
  }
});
