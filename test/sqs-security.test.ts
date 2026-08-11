import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  AddPermissionCommand,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  RemovePermissionCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const policy = (Statement: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement });

test("SQS policy permissions and truthful SSE-SQS attributes survive restart while KMS remains atomic", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-security-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"});
  let sqs: SQSClient | undefined;
  try {
    await simulator.start();
    const connect = () => new SQSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    sqs = connect();
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "secure-events" }))).QueueUrl!;
    const queueArn = `arn:aws:sqs:${region}:${account}:secure-events`;
    let attributes = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }))).Attributes!;
    assert.equal(attributes.SqsManagedSseEnabled, "true");

    const configured = policy([{ Sid: "Service", Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": `arn:aws:events:${region}:${account}:rule/orders` }, StringEquals: { "aws:SourceAccount": account } } }]);
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: configured } }));
    await sqs.send(new AddPermissionCommand({ QueueUrl, Label: "developer_send", AWSAccountIds: ["111122223333"], Actions: ["SendMessage"] }));
    attributes = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["Policy"] }))).Attributes!;
    const statements = JSON.parse(attributes.Policy!).Statement;
    assert.deepEqual(statements.map((item: any) => item.Sid), ["Service", "developer_send"]);
    assert.deepEqual(statements[1].Principal, { AWS: "111122223333" });
    await sqs.send(new RemovePermissionCommand({ QueueUrl, Label: "developer_send" }));
    assert.deepEqual(JSON.parse((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["Policy"] }))).Attributes!.Policy!).Statement.map((item: any) => item.Sid), ["Service"]);

    const queryEndpoint = `http://127.0.0.1:${simulator.port}`;
    const queryAdd = await fetch(queryEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Action: "AddPermission", Version: "2012-11-05", QueueUrl, Label: "query_send", "AWSAccountId.1": "222233334444", "ActionName.1": "SendMessage" }) });
    assert.equal(queryAdd.status, 200);
    assert.match((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["Policy"] }))).Attributes!.Policy!, /query_send/);
    const queryRemove = await fetch(queryEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Action: "RemovePermission", Version: "2012-11-05", QueueUrl, Label: "query_send" }) });
    assert.equal(queryRemove.status, 200);
    assert.doesNotMatch((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["Policy"] }))).Attributes!.Policy!, /query_send/);

    await assert.rejects(sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: policy([{ Effect: "Allow", Principal: "*", Action: "sqs:SendMessage", Resource: `arn:aws:sqs:${region}:${account}:other` }]) } })), (error: any) => error.name === "InvalidParameterValue");
    await assert.rejects(sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { SqsManagedSseEnabled: "false", KmsMasterKeyId: "alias/development" } })), (error: any) => error.name === "UnsupportedOperation");
    assert.equal((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["SqsManagedSseEnabled"] }))).Attributes!.SqsManagedSseEnabled, "true", "a dependency failure is atomic");

    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "before-toggle" }));
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { SqsManagedSseEnabled: "false" } }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "after-toggle" }));
    sqs.destroy(); sqs = undefined; await simulator.stop();
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), /before-toggle|after-toggle/);

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); sqs = connect();
    assert.equal((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["SqsManagedSseEnabled"] }))).Attributes!.SqsManagedSseEnabled, "false");
    const bodies = (await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 2 }))).Messages?.map(message => message.Body).sort();
    assert.deepEqual(bodies, ["after-toggle", "before-toggle"]);
  } finally {
    sqs?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("same-account queue policies authorize role sessions, explicit deny wins, and service source context is mandatory", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-resource-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    const sqs = new SQSClient({ endpoint, region, credentials }); const iam = new IAMClient({ endpoint, region, credentials }); const sts = new STSClient({ endpoint, region, credentials }); clients.push(sqs, iam, sts);
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "resource-authorized" }))).QueueUrl!;
    const queueArn = `arn:aws:sqs:${region}:${account}:resource-authorized`;
    const role = await iam.send(new CreateRoleCommand({ RoleName: "policy-only-producer", AssumeRolePolicyDocument: policy([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }]) }));
    const roleArn = role.Role!.Arn!;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: policy([
      { Sid: "RoleSend", Effect: "Allow", Principal: { AWS: roleArn }, Action: "sqs:SendMessage", Resource: queueArn },
      { Sid: "EventBridge", Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": `arn:aws:events:${region}:${account}:rule/orders` }, StringEquals: { "aws:SourceAccount": account } } },
    ]) } }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "publisher" }));
    const worker = new SQSClient({ endpoint, region, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } }); clients.push(worker);
    assert.ok((await worker.send(new SendMessageCommand({ QueueUrl, MessageBody: "resource allow" }))).MessageId);

    await simulator.sqs.sendAuthorizedMessageToArn(queueArn, { MessageBody: "service allow" }, { kind: "service", principal: "events.amazonaws.com", sourceArn: `arn:aws:events:${region}:${account}:rule/orders`, sourceAccount: account, deliveryLineage: ["one", "two"] });
    await assert.rejects(simulator.sqs.sendAuthorizedMessageToArn(queueArn, { MessageBody: "wrong source" }, { kind: "service", principal: "events.amazonaws.com", sourceArn: `arn:aws:events:${region}:${account}:rule/other`, sourceAccount: account }), (error: any) => error.code === "AccessDeniedException");

    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: policy([
      { Sid: "RoleSend", Effect: "Allow", Principal: { AWS: roleArn }, Action: "sqs:SendMessage", Resource: queueArn },
      { Sid: "DenyRole", Effect: "Deny", Principal: { AWS: roleArn }, Action: "sqs:SendMessage", Resource: queueArn },
    ]) } }));
    await assert.rejects(worker.send(new SendMessageCommand({ QueueUrl, MessageBody: "denied" })), (error: any) => error.name === "AccessDeniedException");
    await assert.rejects(worker.send(new RemovePermissionCommand({ QueueUrl, Label: "RoleSend" })), (error: any) => error.name === "AccessDeniedException", "administrative policy changes still require owner authorization");
  } finally {
    for (const client of clients) client.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("cross-account callers need identity and queue allows while owner-only actions and anonymous calls stay denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-cross-account-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const owner = new SQSClient({ endpoint, region, credentials }); clients.push(owner);
    const QueueUrl = (await owner.send(new CreateQueueCommand({ QueueName: "cross-account-target" }))).QueueUrl!;
    const queueArn = `arn:aws:sqs:${region}:${account}:cross-account-target`;
    const externalAccount = "111122223333";
    const roleName = "ExternalProducer";
    const roleArn = `arn:aws:iam::${externalAccount}:role/${roleName}`;
    const principalArn = `arn:aws:sts::${externalAccount}:assumed-role/${roleName}/developer`;
    const accessKeyId = "ASIAEXTERNALPRODUCER";
    const secretAccessKey = "external-secret";
    const sessionToken = "external-session";
    const externalIam = simulator.store.ensureAccount(externalAccount).iam;
    externalIam.roles[roleName] = {
      roleName, roleId: "AROAEXTERNALPRODUCER", arn: roleArn, path: "/", createDate: Date.now(), maxSessionDuration: 3600,
      assumeRolePolicyDocument: JSON.parse(policy([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${externalAccount}:root` }, Action: "sts:AssumeRole" }])),
      tags: {}, attachedPolicyArns: [], inlinePolicies: { queue: JSON.parse(policy([{ Effect: "Allow", Action: ["sqs:SendMessage", "sqs:SetQueueAttributes"], Resource: queueArn }])) },
    };
    const credentialId = "external-sqs-producer-session";
    await simulator.store.credentialStore!.put({ credentialId, type: "sts-session", accountId: externalAccount, ownerId: "AROAX:developer", accessKeyId }, { secretAccessKey, sessionToken });
    externalIam.sessions[accessKeyId] = { accessKeyId, credentialId, principalArn, principalId: "AROAX:developer", roleArn, roleName, sessionName: "developer", expiration: Date.now() + 60_000, sessionTags: {} };
    await simulator.store.save();
    await owner.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: policy([{ Effect: "Allow", Principal: { AWS: roleArn }, Action: ["sqs:SendMessage", "sqs:SetQueueAttributes"], Resource: queueArn }]) } }));

    const external = new SQSClient({ endpoint, region, credentials: { accessKeyId, secretAccessKey, sessionToken } }); clients.push(external);
    assert.ok((await external.send(new SendMessageCommand({ QueueUrl, MessageBody: "both sides allow" }))).MessageId);
    await assert.rejects(external.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { VisibilityTimeout: "31" } })), (error: any) => error.name === "AccessDeniedException", "queue administration cannot be delegated cross-account");

    externalIam.roles[roleName].inlinePolicies.queue = JSON.parse(policy([{ Effect: "Allow", Action: "sqs:SetQueueAttributes", Resource: queueArn }]));
    await simulator.store.save();
    await assert.rejects(external.send(new SendMessageCommand({ QueueUrl, MessageBody: "resource policy alone is insufficient" })), (error: any) => error.name === "AccessDeniedException");

    const anonymous = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.SendMessage" }, body: JSON.stringify({ QueueUrl, MessageBody: "anonymous" }) });
    assert.equal(anonymous.status, 403);
  } finally {
    for (const client of clients) client.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
