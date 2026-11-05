import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateBucketCommand, GetBucketNotificationConfigurationCommand, PutBucketNotificationConfigurationCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("a bucket notification to a queue that does not admit S3 fails destination validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-s3-queue-validation-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const sqs = new SQSClient(options);
    clients.push(s3, sqs);
    await s3.send(new CreateBucketCommand({ Bucket: "notification-validation", CreateBucketConfiguration: { LocationConstraint: region } }));
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "notification-validation" }))).QueueUrl!;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    const configure = (QueueArn: string) => s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: "notification-validation",
      NotificationConfiguration: { QueueConfigurations: [{ Id: "created", QueueArn, Events: ["s3:ObjectCreated:*"] }] },
    }));
    const refused = (error: any) => error.name === "InvalidArgument" && error.message === "Unable to validate the following destination configurations";

    // No queue policy, and a queue that does not exist: both are destination validation failures, as on S3.
    await assert.rejects(configure(queueArn), refused);
    await assert.rejects(configure(`arn:aws:sqs:${region}:000000000000:notification-validation-missing`), refused);
    assert.equal((await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: "notification-validation" }))).QueueConfigurations, undefined);

    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn }] }) } }));
    await configure(queueArn);
    const testEvent = (await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 5 }))).Messages?.[0];
    assert.equal(JSON.parse(testEvent!.Body!).Event, "s3:TestEvent");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
