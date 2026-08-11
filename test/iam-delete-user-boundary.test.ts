import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreatePolicyCommand, CreateUserCommand, DeleteUserCommand, IAMClient } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";

test("IAMGAP-19 requires removal of a stored user permissions boundary before deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap19-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "enforce", cdkBootstrap: true }); let iam: IAMClient | undefined;
  try {
    await simulator.start(); iam = new IAMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    const boundary = (await iam.send(new CreatePolicyCommand({ PolicyName: "UserBoundary", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] }) }))).Policy!.Arn!;
    await iam.send(new CreateUserCommand({ UserName: "bounded", PermissionsBoundary: boundary }));
    await assert.rejects(iam.send(new DeleteUserCommand({ UserName: "bounded" })), (error: any) => error.name.startsWith("DeleteConflict") && /delete the permissions boundary first/i.test(error.message));
    assert.equal(simulator.store.ensureAccount().iam.users.bounded.permissionsBoundaryArn, boundary, "the failed delete never detaches the boundary");
    delete simulator.store.ensureAccount().iam.users.bounded.permissionsBoundaryArn; await simulator.store.save();
    await iam.send(new DeleteUserCommand({ UserName: "bounded" })); assert.equal(simulator.store.ensureAccount().iam.users.bounded, undefined);
  } finally { iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
