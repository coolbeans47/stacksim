import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateGroupCommand, CreatePolicyCommand, CreateRoleCommand, CreateUserCommand, GetGroupPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, GetRolePolicyCommand, GetUserPolicyCommand, IAMClient, PutGroupPolicyCommand, PutRolePolicyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { canonicalPolicyDocument } from "../src/iam/policy-storage.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; const region = "eu-west-1";
const semantic = { Statement: [{ Resource: "arn:aws:s3:::b/two", Action: "s3:GetObject", Effect: "Allow" as const }, { Effect: "Deny" as const, Resource: ["arn:aws:s3:::b/one"], Action: ["s3:DeleteObject"] }], Version: "2012-10-17" };
const equivalent = { Version: "2012-10-17", Statement: [{ Action: "s3:DeleteObject", Resource: "arn:aws:s3:::b/one", Effect: "Deny" as const }, { Action: ["s3:GetObject"], Effect: "Allow" as const, Resource: ["arn:aws:s3:::b/two"] }] };
const decoded = (value: string | undefined) => JSON.parse(decodeURIComponent(value!));

test("IAMGAP-23 preserves semantic policy documents and migrates deterministic canonical forms", async () => {
  assert.equal(canonicalPolicyDocument(semantic), canonicalPolicyDocument(equivalent)); assert.notDeepEqual(semantic, equivalent);
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap23-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); let iam: IAMClient | undefined; let sts: STSClient | undefined;
  try {
    await simulator.start(); let endpoint = `http://127.0.0.1:${simulator.port}`; iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 }); sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    const trust = { Statement: { Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole", Effect: "Allow" as const }, Version: "2012-10-17" };
    const arn = (await iam.send(new CreatePolicyCommand({ PolicyName: "Semantic", PolicyDocument: JSON.stringify(semantic) }))).Policy!.Arn!;
    await iam.send(new CreateRoleCommand({ RoleName: "SemanticRole", AssumeRolePolicyDocument: JSON.stringify(trust) })); await iam.send(new PutRolePolicyCommand({ RoleName: "SemanticRole", PolicyName: "inline", PolicyDocument: JSON.stringify(semantic) }));
    await iam.send(new CreateUserCommand({ UserName: "semantic-user" })); await iam.send(new PutUserPolicyCommand({ UserName: "semantic-user", PolicyName: "inline", PolicyDocument: JSON.stringify(semantic) }));
    await iam.send(new CreateGroupCommand({ GroupName: "semantic-group" })); await iam.send(new PutGroupPolicyCommand({ GroupName: "semantic-group", PolicyName: "inline", PolicyDocument: JSON.stringify(semantic) }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: "arn:aws:iam::000000000000:role/SemanticRole", RoleSessionName: "semantic", Policy: JSON.stringify(semantic) })); const sessionKey = assumed.Credentials!.AccessKeyId!;
    assert.deepEqual(decoded((await iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: "v1" }))).PolicyVersion?.Document), semantic);
    assert.deepEqual(simulator.store.ensureAccount().iam.sessions[sessionKey].sessionPolicy, semantic); assert.equal(simulator.store.ensureAccount().iam.sessions[sessionKey].sessionPolicyCanonical, canonicalPolicyDocument(semantic));
    iam.destroy(); sts.destroy(); iam = undefined; sts = undefined; await simulator.stop();

    const stateFile = join(root, "state.json"); const legacy = JSON.parse(await readFile(stateFile, "utf8")); const account = legacy.accounts["000000000000"].iam; delete account.policies[arn].versions.v1.canonicalDocument; delete account.roles.SemanticRole.assumeRolePolicyCanonical; delete account.roles.SemanticRole.inlinePolicyCanonicalDocuments; delete account.users["semantic-user"].inlinePolicyCanonicalDocuments; delete account.groups["semantic-group"].inlinePolicyCanonicalDocuments; delete account.sessions[sessionKey].sessionPolicyCanonical; await writeFile(stateFile, JSON.stringify(legacy));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`; iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    assert.deepEqual(decoded((await iam.send(new GetRoleCommand({ RoleName: "SemanticRole" }))).Role?.AssumeRolePolicyDocument), trust);
    assert.deepEqual(decoded((await iam.send(new GetRolePolicyCommand({ RoleName: "SemanticRole", PolicyName: "inline" }))).PolicyDocument), semantic);
    assert.deepEqual(decoded((await iam.send(new GetUserPolicyCommand({ UserName: "semantic-user", PolicyName: "inline" }))).PolicyDocument), semantic);
    assert.deepEqual(decoded((await iam.send(new GetGroupPolicyCommand({ GroupName: "semantic-group", PolicyName: "inline" }))).PolicyDocument), semantic);
    const migrated = simulator.store.ensureAccount().iam; assert.equal(migrated.policies[arn].versions.v1.canonicalDocument, canonicalPolicyDocument(semantic)); assert.equal(migrated.roles.SemanticRole.inlinePolicyCanonicalDocuments?.inline, canonicalPolicyDocument(semantic)); assert.equal(migrated.sessions[sessionKey].sessionPolicyCanonical, canonicalPolicyDocument(semantic));
  } finally { iam?.destroy(); sts?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
