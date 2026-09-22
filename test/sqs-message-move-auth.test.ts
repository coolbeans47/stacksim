import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { SQSClient, StartMessageMoveTaskCommand, ListMessageMoveTasksCommand, CancelMessageMoveTaskCommand } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";
import { authorizationTarget } from "../src/auth/target.js";
const region = "eu-west-1", account = "000000000000";
const policy = (Statement: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement });

test("move IAM targets use SourceArn or authenticated persisted task source through both protocol families", async () => {
  const arn = `arn:aws:sqs:${region}:${account}:dead`;
  const handle = Buffer.from(JSON.stringify({ taskId: "id", sourceArn: arn })).toString("base64url");
  for (const protocol of ["json", "query"]) for (const operation of ["StartMessageMoveTask", "ListMessageMoveTasks", "CancelMessageMoveTask"]) {
    const input: Record<string, string> = operation === "CancelMessageMoveTask" ? { TaskHandle: handle } : { SourceArn: arn };
    const url = new URL("http://localhost/");
    const req = { method: "POST", headers: protocol === "json" ? { "x-amz-target": `AmazonSQS.${operation}`, "content-type": "application/x-amz-json-1.0" } : { "content-type": "application/x-www-form-urlencoded" }, socket: {}, [Symbol.for("stacksim.request-body")]: Buffer.from(protocol === "json" ? JSON.stringify(input) : new URLSearchParams({ Action: operation, ...input } as Record<string, string>).toString()) } as any;
    const target = await authorizationTarget(req, url, "sqs", region, account, { principalArn: `arn:aws:iam::${account}:root`, accountId: account } as any, 0);
    assert.equal(target.resource, arn); assert.equal(target.action, `sqs:${operation}`);
  }
});

test("enforce-mode requires each source and destination permission, rechecks policy changes, and persists no credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-move-auth-")); const clock = new TestClock(Date.now());
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true, clock });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await sim.start(); const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const iam = new IAMClient(options), sts = new STSClient(options); clients.push(iam, sts);
    const dead = await sim.sqs.CreateQueue({ QueueName: "dead" }), destination = await sim.sqs.CreateQueue({ QueueName: "target" });
    const deadArn = sim.sqs.resolveQueueUrl(dead.QueueUrl).queueArn, targetArn = sim.sqs.resolveQueueUrl(destination.QueueUrl).queueArn;
    await sim.sqs.CreateQueue({ QueueName: "source", Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadArn, maxReceiveCount: 1 }) } });
    const role = await iam.send(new CreateRoleCommand({ RoleName: "redriver", AssumeRolePolicyDocument: policy([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }]) }));
    const set = async (actions: string[], send = true) => iam.send(new PutRolePolicyCommand({ RoleName: "redriver", PolicyName: "redrive", PolicyDocument: policy([{ Effect: "Allow", Action: actions.map(a => `sqs:${a}`), Resource: deadArn }, ...(send ? [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: targetArn }] : [])]) }));
    const all = ["StartMessageMoveTask", "ListMessageMoveTasks", "CancelMessageMoveTask", "ReceiveMessage", "DeleteMessage", "GetQueueAttributes"];
    await set(all); const creds = (await sts.send(new AssumeRoleCommand({ RoleArn: role.Role!.Arn, RoleSessionName: "recovery" }))).Credentials!;
    const sqs = new SQSClient({ ...options, credentials: { accessKeyId: creds.AccessKeyId!, secretAccessKey: creds.SecretAccessKey!, sessionToken: creds.SessionToken! } }); clients.push(sqs);
    const start = () => sqs.send(new StartMessageMoveTaskCommand({ SourceArn: deadArn, DestinationArn: targetArn, MaxNumberOfMessagesPerSecond: 1 }));
    for (const missing of ["StartMessageMoveTask", "ReceiveMessage", "DeleteMessage", "GetQueueAttributes"]) { await set(all.filter(a => a !== missing)); await assert.rejects(start(), { name: "AccessDeniedException" }); }
    await set(all, false); await assert.rejects(start(), { name: "AccessDeniedException" });
    await set(all); for (let i = 0; i < 3; i++) await sim.sqs.SendMessage({ QueueUrl: dead.QueueUrl, MessageBody: "private-payload" });
    const started = await start(); await sim.sqs.runMessageMoveTasks();
    assert.equal((await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: deadArn }))).Results?.[0].ApproximateNumberOfMessagesMoved, 1);
    await set(all.filter(a => a !== "GetQueueAttributes")); await assert.rejects(sqs.send(new ListMessageMoveTasksCommand({ SourceArn: deadArn })), { name: "AccessDeniedException" });
    await assert.rejects(sqs.send(new CancelMessageMoveTaskCommand({ TaskHandle: started.TaskHandle! })), { name: "AccessDeniedException" });
    await set(all, false); clock.advance(1000); await sim.sqs.runMessageMoveTasks();
    await set(all); const failed = (await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: deadArn }))).Results![0]; assert.equal(failed.Status, "FAILED"); assert.equal(failed.ApproximateNumberOfMessagesMoved, 1); assert.match(failed.FailureReason!, /AccessDenied/);
    const retry = await start(); const cancelled = await sqs.send(new CancelMessageMoveTaskCommand({ TaskHandle: retry.TaskHandle! })); assert.equal(cancelled.ApproximateNumberOfMessagesMoved, 0); await sim.sqs.runMessageMoveTasks();
    assert.equal((await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: deadArn }))).Results?.[0].Status, "CANCELLED");
    await start();
    await sim.sqs.SetQueueAttributes({ QueueUrl: destination.QueueUrl, Attributes: { Policy: policy([{ Effect: "Deny", Principal: "*", Action: "sqs:SendMessage", Resource: targetArn }]) } });
    await sim.sqs.runMessageMoveTasks();
    const policyFailure = (await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: deadArn }))).Results![0];
    assert.equal(policyFailure.Status, "FAILED"); assert.equal(policyFailure.ApproximateNumberOfMessagesMoved, 0); assert.match(policyFailure.FailureReason!, /AccessDenied/);
    const stored = await (sim.sqs as any).storage.readQueue(deadArn); const taskText = JSON.stringify(stored.moveTasks);
    for (const secret of [creds.AccessKeyId!, creds.SecretAccessKey!, creds.SessionToken!, "private-payload"]) assert.ok(!taskText.includes(secret));
    assert.ok(sim.store.ensureAccount().iam.authorizationDecisions.some(d => d.action === "sqs:SendMessage" && d.resource === targetArn && d.decision !== "allowed"));
  } finally { clients.forEach(c => c.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
