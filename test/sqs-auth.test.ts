import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, GetPolicyCommand, GetPolicyVersionCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
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
    const received = (await worker.send(new ReceiveMessageCommand({ QueueUrl, MessageSystemAttributeNames: ["SenderId"] }))).Messages![0];
    assert.equal(received.Attributes?.SenderId, assumed.AssumedRoleUser!.AssumedRoleId, "SenderId is the unique ID of the role session that sent the message");
    await worker.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received.ReceiptHandle! }));
    await assert.rejects(worker.send(new SendMessageCommand({ QueueUrl: deniedUrl, MessageBody: "wrong queue" })), (error: any) => error.name === "AccessDenied");
    await assert.rejects(worker.send(new TagQueueCommand({ QueueUrl, Tags: { environment: "prod" } })), (error: any) => error.name === "AccessDenied");

    await rootSqs.send(new TagQueueCommand({ QueueUrl, Tags: { environment: "prod" } }));
    await assert.rejects(worker.send(new SendMessageCommand({ QueueUrl, MessageBody: "tag condition no longer matches" })), (error: any) => error.name === "AccessDenied");
    assert(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "sqs:SendMessage" && decision.resource === queueArn && decision.decision === "allowed"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AWS managed SQS policies, an account-scoped ListQueues resource and the plain-HTTP hint work under enforcement", async () => {
  const listUrl = new URL("http://127.0.0.1/?Action=ListQueues&Version=2012-11-05");
  const listRequest = { method: "GET", url: `${listUrl.pathname}${listUrl.search}`, headers: {}, socket: { remoteAddress: "127.0.0.1", encrypted: false }, [Symbol.for("stacksim.request-body")]: Buffer.alloc(0) } as any;
  const listTarget = await authorizationTarget(listRequest, listUrl, "sqs", region, account, { principalArn: `arn:aws:iam::${account}:role/developer`, accountId: account, accessKeyId: "admin" } as any, Date.now());
  assert.equal(listTarget.action, "sqs:ListQueues");
  assert.equal(listTarget.resource, `arn:aws:sqs:${region}:${account}:*`);

  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-managed-policies-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const rootSqs = new SQSClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials });
    clients.push(rootSqs, iam, sts);
    const QueueUrl = (await rootSqs.send(new CreateQueueCommand({ QueueName: "managed-policy-jobs" }))).QueueUrl!;
    const queueArn = (await rootSqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;

    const managedDocument = async (name: string) => {
      const policy = (await iam.send(new GetPolicyCommand({ PolicyArn: `arn:aws:iam::aws:policy/${name}` }))).Policy!;
      assert.equal(policy.Path, "/");
      const version = await iam.send(new GetPolicyVersionCommand({ PolicyArn: policy.Arn!, VersionId: policy.DefaultVersionId! }));
      return JSON.parse(decodeURIComponent(version.PolicyVersion!.Document!));
    };
    assert.deepEqual((await managedDocument("AmazonSQSFullAccess")).Statement, [{ Effect: "Allow", Action: ["sqs:*"], Resource: "*" }]);
    assert.deepEqual((await managedDocument("AmazonSQSReadOnlyAccess")).Statement, [{ Effect: "Allow", Action: ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListDeadLetterSourceQueues", "sqs:ListQueues", "sqs:ListMessageMoveTasks", "sqs:ListQueueTags"], Resource: "*" }]);

    const assume = async (roleName: string, attach: (roleName: string) => Promise<void>) => {
      await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }]) }));
      await attach(roleName);
      const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${account}:role/${roleName}`, RoleSessionName: "session" }));
      const client = new SQSClient({ endpoint, region, maxAttempts: 1, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } });
      clients.push(client);
      return client;
    };
    const managed = (name: string) => async (roleName: string) => { await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: `arn:aws:iam::aws:policy/${name}` })); };
    const customer = (statement: unknown) => async (roleName: string) => {
      const created = await iam.send(new CreatePolicyCommand({ PolicyName: `${roleName}-policy`, PolicyDocument: document([statement]) }));
      await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: created.Policy!.Arn! }));
    };
    const denied = (error: any) => /is not authorized to perform/.test(error.message);

    const reader = await assume("sqs-managed-reader", managed("AmazonSQSReadOnlyAccess"));
    assert((await reader.send(new ListQueuesCommand({}))).QueueUrls?.includes(QueueUrl));
    assert.equal((await reader.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes?.QueueArn, queueArn);
    await assert.rejects(reader.send(new SendMessageCommand({ QueueUrl, MessageBody: "read-only" })), denied);

    const writer = await assume("sqs-managed-writer", managed("AmazonSQSFullAccess"));
    assert.ok((await writer.send(new SendMessageCommand({ QueueUrl, MessageBody: "full access" }))).MessageId);

    const lister = await assume("sqs-account-lister", customer({ Effect: "Allow", Action: "sqs:ListQueues", Resource: `arn:aws:sqs:${region}:${account}:*` }));
    assert((await lister.send(new ListQueuesCommand({}))).QueueUrls?.includes(QueueUrl));
    const elsewhere = await assume("sqs-other-region-lister", customer({ Effect: "Allow", Action: "sqs:ListQueues", Resource: `arn:aws:sqs:us-east-1:${account}:*` }));
    await assert.rejects(elsewhere.send(new ListQueuesCommand({})), denied);

    // A queue policy that requires TLS denies the plain-HTTP endpoint; the error names the HTTPS endpoint.
    await rootSqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: document([{ Sid: "RequireTls", Effect: "Deny", Principal: { AWS: "*" }, Action: "sqs:*", Resource: queueArn, Condition: { Bool: { "aws:SecureTransport": "false" } } }]) } }));
    await assert.rejects(rootSqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "over http" })), (error: any) =>
      denied(error) && error.message.includes("The queue policy denies requests that do not use TLS") && error.message.includes(`https://127.0.0.1:${simulator.s3TlsPort}`) && error.message.includes("AWS_ENDPOINT_URL_SQS") && error.message.includes("AWS_CA_BUNDLE="));
    // A Deny that TLS would not lift carries no such hint.
    const plainUrl = (await rootSqs.send(new CreateQueueCommand({ QueueName: "managed-policy-denied" }))).QueueUrl!;
    const plainArn = (await rootSqs.send(new GetQueueAttributesCommand({ QueueUrl: plainUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    await rootSqs.send(new SetQueueAttributesCommand({ QueueUrl: plainUrl, Attributes: { Policy: document([{ Sid: "NoSending", Effect: "Deny", Principal: { AWS: "*" }, Action: "sqs:SendMessage", Resource: plainArn }]) } }));
    await assert.rejects(rootSqs.send(new SendMessageCommand({ QueueUrl: plainUrl, MessageBody: "denied" })), (error: any) => denied(error) && !error.message.includes("TLS"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
