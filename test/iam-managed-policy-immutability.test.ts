import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreatePolicyCommand, DeletePolicyCommand, GetPolicyVersionCommand, IAMClient, TagPolicyCommand, UntagPolicyCommand } from "@aws-sdk/client-iam";
import { createIamState } from "../src/iam/model.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const managedArn = "arn:aws:iam::aws:policy/AdministratorAccess";

test("IAMGAP-04 restores authoritative managed policies and denies every live tag/delete mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap04-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam);
    const customer = await iam.send(new CreatePolicyCommand({
      PolicyName: "AdministratorAccess",
      Path: "/customer/",
      Description: "same name, customer ARN",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }),
      Tags: [{ Key: "owner", Value: "local" }],
    }));
    const customerArn = customer.Policy!.Arn!;
    const customerBefore = structuredClone(simulator.store.ensureAccount().iam.policies[customerArn]);
    const persisted = simulator.store.ensureAccount().iam.policies[managedArn] as any;
    const stableDates = { createDate: persisted.createDate, updateDate: persisted.updateDate, versionCreateDate: persisted.versions.v1.createDate };
    Object.assign(persisted, {
      policyName: "CorruptedAdministratorAccess",
      policyId: "CORRUPTED",
      path: "/corrupted/",
      awsManaged: false,
      defaultVersionId: "v9",
      tags: { mutable: "yes" },
      versions: { v9: { versionId: "v9", createDate: 1, isDefaultVersion: true, document: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }] } } },
    });
    await simulator.store.save();
    iam.destroy();
    clients.length = 0;
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam);
    const restored = simulator.store.ensureAccount().iam.policies[managedArn];
    const authoritative = createIamState(123, "000000000000").policies[managedArn];
    assert.equal(restored.policyName, authoritative.policyName);
    assert.equal(restored.policyId, authoritative.policyId);
    assert.equal(restored.path, authoritative.path);
    assert.equal(restored.awsManaged, true);
    assert.equal(restored.defaultVersionId, "v1");
    assert.deepEqual(restored.versions.v1.document, authoritative.versions.v1.document);
    assert.deepEqual({ createDate: restored.createDate, updateDate: restored.updateDate, versionCreateDate: restored.versions.v1.createDate }, stableDates);
    assert.deepEqual(simulator.store.ensureAccount().iam.policies[customerArn], customerBefore);
    const wireVersion = await iam.send(new GetPolicyVersionCommand({ PolicyArn: managedArn, VersionId: "v1" }));
    assert.deepEqual(JSON.parse(decodeURIComponent(wireVersion.PolicyVersion!.Document!)), authoritative.versions.v1.document);
    for (const request of [
      iam.send(new TagPolicyCommand({ PolicyArn: managedArn, Tags: [{ Key: "x", Value: "y" }] })),
      iam.send(new UntagPolicyCommand({ PolicyArn: managedArn, TagKeys: ["mutable"] })),
      iam.send(new DeletePolicyCommand({ PolicyArn: managedArn })),
    ]) await assert.rejects(request, (error: any) => error.name.startsWith("AccessDenied") && /immutable/.test(error.message));
    assert.deepEqual(restored.tags, {});
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
