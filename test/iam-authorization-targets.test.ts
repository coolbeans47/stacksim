import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddUserToGroupCommand,
  AttachRolePolicyCommand,
  CreateAccessKeyCommand,
  CreateGroupCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DetachRolePolicyCommand,
  GetAccessKeyLastUsedCommand,
  GetGroupCommand,
  GetPolicyCommand,
  GetRoleCommand,
  GetUserCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListGroupsForUserCommand,
  PutRolePolicyCommand,
  RemoveUserFromGroupCommand,
  UpdateAccessKeyCommand,
  UpdateGroupCommand,
  UpdateUserCommand,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { IAM_AUTHORIZATION_RESOURCE_MAP, resolveIamAuthorizationTarget } from "../src/auth/iam-target.js";
import { IamService } from "../src/iam.js";
import { StackSim } from "../src/server.js";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { IamState } from "../src/types.js";

const accountId = "000000000000";
const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };
const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }] });

function policy(statements: any[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function client(simulator: StackSim, credentials = adminCredentials): IAMClient {
  return new IAMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
}

async function assumedClient(simulator: StackSim, iam: IAMClient, roleName: string, statements: any[]): Promise<{ iam: IAMClient; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string } }> {
  await iam.send(new CreateRoleCommand({ RoleName: roleName, Path: "/callers/", AssumeRolePolicyDocument: trust }));
  await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: "scope", PolicyDocument: policy(statements) }));
  const sts = new STSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: adminCredentials });
  const result = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${accountId}:role/callers/${roleName}`, RoleSessionName: "dug01" }));
  sts.destroy();
  const credentials = { accessKeyId: result.Credentials!.AccessKeyId!, secretAccessKey: result.Credentials!.SecretAccessKey!, sessionToken: result.Credentials!.SessionToken! };
  return { iam: client(simulator, credentials), credentials };
}

test("DUG-01 freezes a complete operation-to-resource map and resolves persisted or request-derived IAM ARNs", () => {
  const descriptors = Object.getOwnPropertyDescriptors(IamService.prototype);
  const implemented = Object.keys(descriptors)
    .filter(name => name !== "handle" && descriptors[name].value?.constructor?.name === "AsyncFunction")
    .sort();
  assert.deepEqual(Object.keys(IAM_AUTHORIZATION_RESOURCE_MAP).sort(), implemented);

  const principal = { principalType: "roleSession", principalArn: `arn:aws:sts::${accountId}:assumed-role/caller/session`, principalId: "AROA:session", accountId, accessKeyId: "ASIA" } as PrincipalContext;
  const iam = {
    users: { alice: { userName: "alice", arn: `arn:aws:iam::${accountId}:user/team/alice` } },
    groups: { developers: { groupName: "developers", arn: `arn:aws:iam::${accountId}:group/teams/developers` } },
    roles: { worker: { roleName: "worker", arn: `arn:aws:iam::${accountId}:role/service/worker` } },
    policies: {},
    accessKeys: { AKIAOWNER: { accessKeyId: "AKIAOWNER", userName: "alice" } },
    sessions: {}, authorizationDecisions: [],
  } as unknown as IamState;

  assert.equal(resolveIamAuthorizationTarget("UpdateRole", { RoleName: "worker", Path: "/ignored/" }, accountId, principal, iam).resource, `arn:aws:iam::${accountId}:role/service/worker`);
  assert.equal(resolveIamAuthorizationTarget("CreateRole", { RoleName: "new", Path: "/nested/service/" }, accountId, principal, iam).resource, `arn:aws:iam::${accountId}:role/nested/service/new`);
  assert.equal(resolveIamAuthorizationTarget("AddUserToGroup", { UserName: "alice", GroupName: "developers" }, accountId, principal, iam).resource, `arn:aws:iam::${accountId}:group/teams/developers`);
  assert.equal(resolveIamAuthorizationTarget("GetAccessKeyLastUsed", { AccessKeyId: "AKIAOWNER" }, accountId, principal, iam).resource, `arn:aws:iam::${accountId}:user/team/alice`);
  assert.equal(resolveIamAuthorizationTarget("GetAccessKeyLastUsed", { AccessKeyId: "MISSING" }, accountId, principal, iam).resource, `arn:aws:iam::${accountId}:user/*`);
  assert.equal(resolveIamAuthorizationTarget("GetAccessKeyLastUsed", { AccessKeyId: "MISSING" }, accountId, { ...principal, principalType: "user", userName: "alice" }, iam).resource, `arn:aws:iam::${accountId}:user/*`);
  assert.equal(resolveIamAuthorizationTarget("GetRole", { RoleName: "missing" }, accountId, principal, iam).resource, `arn:aws:iam::${accountId}:role/missing`);
  assert.equal(resolveIamAuthorizationTarget("ListRoles", {}, accountId, principal, iam).resource, "*");
  assert.deepEqual(resolveIamAuthorizationTarget("AttachRolePolicy", { RoleName: "worker", PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess" }, accountId, principal, iam), {
    resource: `arn:aws:iam::${accountId}:role/service/worker`,
    context: { "iam:PolicyARN": "arn:aws:iam::aws:policy/ReadOnlyAccess" },
  });
});

test("DUG-01 official IAM clients authorize nested entities, owning resources, policy context, and explicit denies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug01-targets-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let admin: IAMClient | undefined; let scoped: IAMClient | undefined;
  try {
    await simulator.start(); admin = client(simulator);
    const userArn = `arn:aws:iam::${accountId}:user/team/alice`;
    const groupArn = `arn:aws:iam::${accountId}:group/teams/developers`;
    const roleArn = `arn:aws:iam::${accountId}:role/service/worker`;
    await admin.send(new CreateUserCommand({ UserName: "alice", Path: "/team/" }));
    await admin.send(new CreateGroupCommand({ GroupName: "developers", Path: "/teams/" }));
    await admin.send(new CreateRoleCommand({ RoleName: "worker", Path: "/service/", AssumeRolePolicyDocument: trust }));
    const managed = await admin.send(new CreatePolicyCommand({ PolicyName: "WorkerAccess", Path: "/managed/", PolicyDocument: policy([{ Effect: "Allow", Action: "logs:*", Resource: "*" }]) }));
    const managedArn = managed.Policy!.Arn!;
    const assumed = await assumedClient(simulator, admin, "operator", [
      { Effect: "Allow", Action: "iam:GetUser", Resource: userArn },
      { Effect: "Allow", Action: "iam:GetGroup", Resource: groupArn },
      { Effect: "Allow", Action: "iam:GetRole", Resource: roleArn },
      { Effect: "Allow", Action: "iam:GetPolicy", Resource: managedArn },
      { Effect: "Allow", Action: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"], Resource: roleArn, Condition: { ArnEquals: { "iam:PolicyARN": managedArn } } },
      { Effect: "Allow", Action: ["iam:AddUserToGroup", "iam:RemoveUserFromGroup"], Resource: groupArn },
      { Effect: "Allow", Action: "iam:ListGroupsForUser", Resource: userArn },
      { Effect: "Allow", Action: ["iam:CreateAccessKey", "iam:ListAccessKeys", "iam:UpdateAccessKey", "iam:DeleteAccessKey", "iam:GetAccessKeyLastUsed"], Resource: userArn },
    ]); scoped = assumed.iam;

    assert.equal((await scoped.send(new GetUserCommand({ UserName: "alice" }))).User?.Arn, userArn);
    assert.equal((await scoped.send(new GetGroupCommand({ GroupName: "developers" }))).Group?.Arn, groupArn);
    assert.equal((await scoped.send(new GetRoleCommand({ RoleName: "worker" }))).Role?.Arn, roleArn);
    assert.equal((await scoped.send(new GetPolicyCommand({ PolicyArn: managedArn }))).Policy?.Arn, managedArn);
    await scoped.send(new AttachRolePolicyCommand({ RoleName: "worker", PolicyArn: managedArn }));
    await scoped.send(new DetachRolePolicyCommand({ RoleName: "worker", PolicyArn: managedArn }));
    await scoped.send(new AddUserToGroupCommand({ GroupName: "developers", UserName: "alice" }));
    assert.deepEqual((await scoped.send(new ListGroupsForUserCommand({ UserName: "alice" }))).Groups?.map(group => group.Arn), [groupArn]);
    await scoped.send(new RemoveUserFromGroupCommand({ GroupName: "developers", UserName: "alice" }));

    const accessKey = (await scoped.send(new CreateAccessKeyCommand({ UserName: "alice" }))).AccessKey!;
    assert.equal((await scoped.send(new ListAccessKeysCommand({ UserName: "alice" }))).AccessKeyMetadata?.[0].UserName, "alice");
    await scoped.send(new UpdateAccessKeyCommand({ UserName: "alice", AccessKeyId: accessKey.AccessKeyId!, Status: "Inactive" }));
    assert.equal((await scoped.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: accessKey.AccessKeyId! }))).UserName, "alice");
    await scoped.send(new DeleteAccessKeyCommand({ UserName: "alice", AccessKeyId: accessKey.AccessKeyId! }));

    await admin.send(new PutRolePolicyCommand({ RoleName: "operator", PolicyName: "scope", PolicyDocument: policy([
      { Effect: "Allow", Action: "iam:GetUser", Resource: userArn },
      { Effect: "Deny", Action: "iam:GetUser", Resource: userArn },
    ]) }));
    await assert.rejects(scoped.send(new GetUserCommand({ UserName: "alice" })), (error: any) => error.name.startsWith("AccessDenied"));
    const userDecision = [...simulator.store.ensureAccount().iam.authorizationDecisions].reverse().find(decision => decision.action === "iam:GetUser");
    assert.deepEqual({ resource: userDecision?.resource, decision: userDecision?.decision }, { resource: userArn, decision: "explicitDeny" });

    await admin.send(new PutRolePolicyCommand({ RoleName: "operator", PolicyName: "scope", PolicyDocument: policy([{ Effect: "Allow", Action: "iam:GetUser", Resource: `arn:aws:iam::${accountId}:user/alice` }]) }));
    await assert.rejects(scoped.send(new GetUserCommand({ UserName: "alice" })), (error: any) => error.name.startsWith("AccessDenied"));
  } finally {
    scoped?.destroy(); admin?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-01 create and path-move authorization is durable, preserves error precedence, and policy names are path-independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug01-moves-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let admin: IAMClient | undefined; let scoped: IAMClient | undefined;
  try {
    await simulator.start(); admin = client(simulator);
    const assumed = await assumedClient(simulator, admin, "creator", [
      { Effect: "Allow", Action: "iam:CreateUser", Resource: `arn:aws:iam::${accountId}:user/projects/bob` },
      { Effect: "Allow", Action: "iam:CreateGroup", Resource: `arn:aws:iam::${accountId}:group/projects/builders` },
      { Effect: "Allow", Action: "iam:CreateRole", Resource: `arn:aws:iam::${accountId}:role/projects/job` },
      { Effect: "Allow", Action: "iam:CreatePolicy", Resource: [`arn:aws:iam::${accountId}:policy/projects/ScopedName`, `arn:aws:iam::${accountId}:policy/other/ScopedName`] },
      { Effect: "Allow", Action: "iam:UpdateUser", Resource: `arn:aws:iam::${accountId}:user/projects/bob` },
      { Effect: "Allow", Action: "iam:UpdateGroup", Resource: `arn:aws:iam::${accountId}:group/projects/builders` },
      { Effect: "Allow", Action: "iam:GetUser", Resource: `arn:aws:iam::${accountId}:user/moved/bob` },
      { Effect: "Allow", Action: "iam:GetGroup", Resource: `arn:aws:iam::${accountId}:group/moved/builders` },
      { Effect: "Allow", Action: "iam:GetRole", Resource: `arn:aws:iam::${accountId}:role/missing` },
    ]); scoped = assumed.iam;
    await scoped.send(new CreateUserCommand({ UserName: "bob", Path: "/projects/" }));
    await scoped.send(new CreateGroupCommand({ GroupName: "builders", Path: "/projects/" }));
    await scoped.send(new CreateRoleCommand({ RoleName: "job", Path: "/projects/", AssumeRolePolicyDocument: trust }));
    await scoped.send(new CreatePolicyCommand({ PolicyName: "ScopedName", Path: "/projects/", PolicyDocument: policy([{ Effect: "Allow", Action: "logs:*", Resource: "*" }]) }));
    await assert.rejects(scoped.send(new CreatePolicyCommand({ PolicyName: "ScopedName", Path: "/other/", PolicyDocument: policy([{ Effect: "Allow", Action: "logs:*", Resource: "*" }]) })), (error: any) => error.name === "EntityAlreadyExistsException" || error.name === "EntityAlreadyExists");

    await scoped.send(new UpdateUserCommand({ UserName: "bob", NewPath: "/moved/" }));
    await scoped.send(new UpdateGroupCommand({ GroupName: "builders", NewPath: "/moved/" }));
    assert.equal((await scoped.send(new GetUserCommand({ UserName: "bob" }))).User?.Arn, `arn:aws:iam::${accountId}:user/moved/bob`);
    assert.equal((await scoped.send(new GetGroupCommand({ GroupName: "builders" }))).Group?.Arn, `arn:aws:iam::${accountId}:group/moved/builders`);
    await assert.rejects(scoped.send(new GetRoleCommand({ RoleName: "missing" })), (error: any) => error.name === "NoSuchEntityException" || error.name === "NoSuchEntity");

    await admin.send(new PutRolePolicyCommand({ RoleName: "creator", PolicyName: "scope", PolicyDocument: policy([
      { Effect: "Allow", Action: "iam:GetUser", Resource: `arn:aws:iam::${accountId}:user/moved/bob` },
      { Effect: "Allow", Action: "iam:GetGroup", Resource: `arn:aws:iam::${accountId}:group/moved/builders` },
    ]) }));
    await assert.rejects(scoped.send(new GetRoleCommand({ RoleName: "missing" })), (error: any) => error.name.startsWith("AccessDenied"));

    const credentials = assumed.credentials;
    scoped.destroy(); scoped = undefined; admin.destroy(); admin = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
    await simulator.start(); scoped = client(simulator, credentials);
    assert.equal((await scoped.send(new GetUserCommand({ UserName: "bob" }))).User?.Arn, `arn:aws:iam::${accountId}:user/moved/bob`);
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "iam:GetUser" && decision.resource.endsWith("user/moved/bob") && decision.decision === "allowed"));
  } finally {
    scoped?.destroy(); admin?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
