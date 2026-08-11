import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateAccessKeyCommand, CreateUserCommand, GetAccessKeyLastUsedCommand, IAMClient } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { recordAccessKeyLastUsed } from "../src/auth/sigv4.js";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";

const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("IAMGAP-18 durably records only valid, monotonic access-key usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap18-")); const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: true });
  let iam: IAMClient | undefined; const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); let endpoint = `http://127.0.0.1:${simulator.port}`; iam = new IAMClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 }); clients.push(iam);
    await iam.send(new CreateUserCommand({ UserName: "usage" })); const created = (await iam.send(new CreateAccessKeyCommand({ UserName: "usage" }))).AccessKey!;
    const userCredentials = { accessKeyId: created.AccessKeyId!, secretAccessKey: created.SecretAccessKey! };
    const sts = new STSClient({ endpoint, region, credentials: userCredentials, maxAttempts: 1 }); clients.push(sts); await sts.send(new GetCallerIdentityCommand({}));
    const first = await iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: created.AccessKeyId! }));
    assert.equal(first.AccessKeyLastUsed?.LastUsedDate?.getTime(), clock.now()); assert.equal(first.AccessKeyLastUsed?.ServiceName, "sts"); assert.equal(first.AccessKeyLastUsed?.Region, region);
    const invalid = new STSClient({ endpoint, region, credentials: { ...userCredentials, secretAccessKey: "wrong" }, maxAttempts: 1 }); clients.push(invalid); clock.advance(1_000); await assert.rejects(invalid.send(new GetCallerIdentityCommand({})), (error: any) => error.name === "SignatureDoesNotMatch");
    assert.equal((await iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: created.AccessKeyId! }))).AccessKeyLastUsed?.LastUsedDate?.getTime(), first.AccessKeyLastUsed?.LastUsedDate?.getTime());

    const newer = clock.now() + 10_000; await Promise.all([
      recordAccessKeyLastUsed(simulator.store, "000000000000", created.AccessKeyId!, { date: newer, serviceName: "lambda", region: "us-east-1" }),
      recordAccessKeyLastUsed(simulator.store, "000000000000", created.AccessKeyId!, { date: newer - 5_000, serviceName: "s3", region }),
    ]);
    clients.splice(0).forEach(client => client.destroy()); iam = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", cdkBootstrap: true }); await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`; iam = new IAMClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 }); clients.push(iam);
    const durable = await iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: created.AccessKeyId! })); assert.equal(durable.AccessKeyLastUsed?.LastUsedDate?.getTime(), newer); assert.equal(durable.AccessKeyLastUsed?.ServiceName, "lambda"); assert.equal(durable.AccessKeyLastUsed?.Region, "us-east-1");
  } finally { clients.forEach(client => client.destroy()); iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
