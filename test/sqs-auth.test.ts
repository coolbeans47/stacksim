import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
  TagQueueCommand,
} from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";
import { authorizationTarget } from "../src/auth/target.js";

const region = "eu-west-1";
const account = "000000000000";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };
const document = (Statement: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement });

test("SQS Query GET authorization derives the operation, queue ARN, and tag keys from the URL", async () => {
  const url = new URL(`http://127.0.0.1/${account}/authorized-jobs?Action=UntagQueue&Version=2012-11-05&TagKey.1=environment`);
  const request = {
    method: "GET",
    url: `${url.pathname}${url.search}`,
    headers: { "user-agent": "sqs-query-auth-test" },
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
    [Symbol.for("stacksim.request-body")]: Buffer.alloc(0),
  } as any;
  const target = await authorizationTarget(request, url, "sqs", region, account, { principalArn: `arn:aws:iam::${account}:role/developer`, accountId: account, accessKeyId: "admin" } as any, Date.now());
  assert.equal(target.action, "sqs:UntagQueue");
  assert.equal(target.resource, `arn:aws:sqs:${region}:${account}:authorized-jobs`);
  assert.deepEqual(target.context["aws:TagKeys"], ["environment"]);
});

test("the simulator routes unsigned legacy SQS Query GET requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-query-get-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const query = new URLSearchParams({ Action: "CreateQueue", Version: "2012-11-05", QueueName: "query-get" });
    const response = await fetch(`http://127.0.0.1:${simulator.port}/?${query}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<CreateQueueResult><QueueUrl>[^<]+\/000000000000\/query-get<\/QueueUrl><\/CreateQueueResult>/);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SQS identity authorization maps queue URLs, batch parent actions, and resource tags to exact queue ARNs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const rootSqs = new SQSClient({ endpoint, region, credentials: adminCredentials });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials });
    clients.push(rootSqs, iam, sts);

    const QueueUrl = (await rootSqs.send(new CreateQueueCommand({ QueueName: "authorized-jobs", tags: { environment: "dev" } }))).QueueUrl!;
    const deniedUrl = (await rootSqs.send(new CreateQueueCommand({ QueueName: "other-jobs" }))).QueueUrl!;
    const queueArn = (await rootSqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    const roleName = "sqs-worker";
    const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }]) }));
    const access = await iam.send(new CreatePolicyCommand({ PolicyName: "ScopedSqsWorker", PolicyDocument: document([
      { Effect: "Allow", Action: "sqs:ListQueues", Resource: "*" },
      { Effect: "Allow", Action: ["sqs:GetQueueAttributes", "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource: queueArn, Condition: { StringEquals: { "aws:ResourceTag/environment": "dev" } } },
    ]) }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: access.Policy!.Arn! }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "worker" }));
    const worker = new SQSClient({ endpoint, region, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } });
    clients.push(worker);

    assert((await worker.send(new ListQueuesCommand({ QueueNamePrefix: "authorized" }))).QueueUrls?.includes(QueueUrl));
    assert.equal((await worker.send(new SendMessageBatchCommand({ QueueUrl, Entries: [{ Id: "one", MessageBody: "authorized" }] }))).Successful?.length, 1, "SendMessageBatch authorizes as sqs:SendMessage");
    const received = (await worker.send(new ReceiveMessageCommand({ QueueUrl }))).Messages![0];
    await worker.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received.ReceiptHandle! }));
    await assert.rejects(worker.send(new SendMessageCommand({ QueueUrl: deniedUrl, MessageBody: "wrong queue" })), (error: any) => error.name === "AccessDeniedException");
    await assert.rejects(worker.send(new TagQueueCommand({ QueueUrl, Tags: { environment: "prod" } })), (error: any) => error.name === "AccessDeniedException");

    await rootSqs.send(new TagQueueCommand({ QueueUrl, Tags: { environment: "prod" } }));
    await assert.rejects(worker.send(new SendMessageCommand({ QueueUrl, MessageBody: "tag condition no longer matches" })), (error: any) => error.name === "AccessDeniedException");
    assert(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "sqs:SendMessage" && decision.resource === queueArn && decision.decision === "allowed"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
