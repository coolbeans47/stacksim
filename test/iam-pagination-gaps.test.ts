import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreatePolicyCommand, CreatePolicyVersionCommand, CreateRoleCommand, IAMClient, ListPolicyTagsCommand, ListPolicyVersionsCommand, ListRoleTagsCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] });

test("IAMGAP-13 paginates policy versions and role/policy tags with durable operation-bound markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap13-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let iam: IAMClient | undefined;
  try {
    await simulator.start(); iam = new IAMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const policyArn = (await iam.send(new CreatePolicyCommand({ PolicyName: "Paged", PolicyDocument: identity, Tags: [{ Key: "z", Value: "3" }, { Key: "a", Value: "1" }, { Key: "m", Value: "2" }] }))).Policy!.Arn!;
    await iam.send(new CreatePolicyVersionCommand({ PolicyArn: policyArn, PolicyDocument: identity }));
    await iam.send(new CreatePolicyVersionCommand({ PolicyArn: policyArn, PolicyDocument: identity }));
    await iam.send(new CreateRoleCommand({ RoleName: "PagedRole", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }), Tags: [{ Key: "z", Value: "3" }, { Key: "a", Value: "1" }, { Key: "m", Value: "2" }] }));

    const versions1 = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn, MaxItems: 1 }));
    assert.equal(versions1.Versions?.length, 1); assert.equal(versions1.IsTruncated, true); assert.ok(versions1.Marker);
    const tags1 = await iam.send(new ListPolicyTagsCommand({ PolicyArn: policyArn, MaxItems: 1 }));
    assert.deepEqual(tags1.Tags?.map(tag => tag.Key), ["a"]); assert.ok(tags1.Marker);
    await assert.rejects(iam.send(new ListRoleTagsCommand({ RoleName: "PagedRole", Marker: tags1.Marker, MaxItems: 1 })), (error: any) => error.name.startsWith("InvalidInput"));
    await assert.rejects(iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn, MaxItems: 0 })), (error: any) => error.name.startsWith("InvalidInput"));

    iam.destroy(); iam = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); await simulator.start();
    iam = new IAMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const versionIds: Array<string | undefined> = [versions1.Versions![0].VersionId]; let marker: string | undefined = versions1.Marker;
    while (marker) { const page: any = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn, Marker: marker, MaxItems: 1 })); versionIds.push(page.Versions![0].VersionId); marker = page.Marker; }
    assert.deepEqual(versionIds, ["v3", "v2", "v1"]);
    const roleKeys: string[] = []; marker = undefined;
    do { const page: any = await iam.send(new ListRoleTagsCommand({ RoleName: "PagedRole", Marker: marker, MaxItems: 1 })); roleKeys.push(...(page.Tags ?? []).map((tag: any) => tag.Key)); marker = page.Marker; } while (marker);
    assert.deepEqual(roleKeys, ["a", "m", "z"]);
  } finally { iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
