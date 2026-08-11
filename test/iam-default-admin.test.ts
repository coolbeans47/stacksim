import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddUserToGroupCommand,
  AttachGroupPolicyCommand,
  CreateAccessKeyCommand,
  CreateGroupCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DetachUserPolicyCommand,
  GetGroupCommand,
  GetUserCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListGroupsForUserCommand,
  ListUsersCommand,
  UpdateAccessKeyCommand,
} from "@aws-sdk/client-iam";
import { ListTablesCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";
import { emptyState, CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { cdkBootstrapNames } from "../src/cloudformation/bootstrap.js";

const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };

function clients(simulator: StackSim, credentials = adminCredentials) {
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  return {
    iam: new IAMClient({ endpoint, region, credentials }),
    sts: new STSClient({ endpoint, region, credentials }),
    dynamodb: new DynamoDBClient({ endpoint, region, credentials }),
  };
}

test("fresh defaults create a policy-backed IAM administrator and automatic reduced bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-default-admin-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region });
  try {
    await simulator.start();
    const { iam, sts, dynamodb } = clients(simulator);
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    assert.equal(identity.Arn, "arn:aws:iam::000000000000:user/admin");
    assert.match(identity.UserId ?? "", /^AIDA/);
    assert.deepEqual((await dynamodb.send(new ListTablesCommand({}))).TableNames, []);
    assert.equal((await iam.send(new GetUserCommand({ UserName: "admin" }))).User?.UserName, "admin");
    assert.deepEqual((await iam.send(new ListUsersCommand({}))).Users?.map(user => user.UserName), ["admin"]);
    assert.ok(simulator.store.regionState(region).cloudformation.bootstrap, "the configured Region is bootstrapped without a startup flag");
    const stateText = await readFile(simulator.store.file, "utf8");
    assert.doesNotMatch(stateText, /"password"|"secretAccessKey"|"sessionToken"/);
    iam.destroy(); sts.destroy(); dynamodb.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("users, groups, generated keys, policy detach, key state, and deletion are durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iam-users-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: false });
  try {
    await simulator.start();
    let active = clients(simulator);
    await active.iam.send(new CreateUserCommand({ UserName: "developer", Tags: [{ Key: "team", Value: "platform" }] }));
    await active.iam.send(new CreateGroupCommand({ GroupName: "developers" }));
    await active.iam.send(new AddUserToGroupCommand({ GroupName: "developers", UserName: "developer" }));
    await active.iam.send(new AttachGroupPolicyCommand({ GroupName: "developers", PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }));
    assert.deepEqual((await active.iam.send(new GetGroupCommand({ GroupName: "developers" }))).Users?.map(user => user.UserName), ["developer"]);
    assert.deepEqual((await active.iam.send(new ListGroupsForUserCommand({ UserName: "developer" }))).Groups?.map(group => group.GroupName), ["developers"]);
    const created = (await active.iam.send(new CreateAccessKeyCommand({ UserName: "developer" }))).AccessKey!;
    const generated = { accessKeyId: created.AccessKeyId!, secretAccessKey: created.SecretAccessKey! };
    assert.match(generated.accessKeyId, /^AKIA/);
    assert.equal((await clients(simulator, generated).sts.send(new GetCallerIdentityCommand({}))).Arn, "arn:aws:iam::000000000000:user/developer");
    await active.iam.send(new UpdateAccessKeyCommand({ UserName: "developer", AccessKeyId: generated.accessKeyId, Status: "Inactive" }));
    await assert.rejects(clients(simulator, generated).sts.send(new GetCallerIdentityCommand({})), (error: any) => error.name === "InvalidClientTokenId");
    await active.iam.send(new UpdateAccessKeyCommand({ UserName: "developer", AccessKeyId: generated.accessKeyId, Status: "Active" }));
    await active.iam.send(new DetachUserPolicyCommand({ UserName: "admin", PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }));
    await assert.rejects(active.dynamodb.send(new ListTablesCommand({})), (error: any) => error.name === "AccessDeniedException");
    active.iam.destroy(); active.sts.destroy(); active.dynamodb.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: false });
    await simulator.start();
    const generatedClients = clients(simulator, generated);
    assert.equal((await generatedClients.sts.send(new GetCallerIdentityCommand({}))).Arn, "arn:aws:iam::000000000000:user/developer");
    assert.equal((await generatedClients.iam.send(new ListAccessKeysCommand({ UserName: "developer" }))).AccessKeyMetadata?.length, 1);
    await generatedClients.iam.send(new DeleteAccessKeyCommand({ UserName: "developer", AccessKeyId: generated.accessKeyId }));
    await assert.rejects(generatedClients.sts.send(new GetCallerIdentityCommand({})), (error: any) => error.name === "InvalidClientTokenId");
    generatedClients.iam.destroy(); generatedClients.sts.destroy(); generatedClients.dynamodb.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred seeding, custom initialization, configured-secret rotation, and global key collisions are deterministic", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-default-admin-config-"));
  const configured = { accessKeyId: "local-operator-key", secretAccessKey: "local-operator-secret" };
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: false, seedDefaultAdmin: false });
  try {
    await simulator.start();
    assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.users), []);
    assert.equal(simulator.store.state.installation.defaultAdministrators["000000000000"].initialized, false);
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: false, defaultUserName: "operator", defaultAccessKeyId: configured.accessKeyId, defaultSecretAccessKey: configured.secretAccessKey });
    await simulator.start();
    const initialIdentity = await clients(simulator, configured).sts.send(new GetCallerIdentityCommand({}));
    assert.equal(initialIdentity.Arn, "arn:aws:iam::000000000000:user/operator");
    const stableId = initialIdentity.UserId;
    assert.equal(simulator.store.state.installation.defaultAdministrators["000000000000"].firstConsoleLogin.status, "pending");
    await simulator.stop();

    const collision = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, accountId: "111122223333", cdkBootstrap: false, defaultUserName: "operator", defaultAccessKeyId: configured.accessKeyId, defaultSecretAccessKey: configured.secretAccessKey });
    await assert.rejects(collision.start(), /access key ID local-operator-key already exists/);
    assert.equal(collision.store.state.accounts["111122223333"]?.iam.users.operator, undefined);
    await collision.stop().catch(() => undefined);

    const rotated = { accessKeyId: configured.accessKeyId, secretAccessKey: "rotated-operator-secret" };
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: false, defaultAccessKeyId: rotated.accessKeyId, defaultSecretAccessKey: rotated.secretAccessKey });
    await simulator.start();
    await assert.rejects(clients(simulator, configured).sts.send(new GetCallerIdentityCommand({})), (error: any) => error.name === "SignatureDoesNotMatch");
    const rotatedIdentity = await clients(simulator, rotated).sts.send(new GetCallerIdentityCommand({}));
    assert.equal(rotatedIdentity.UserId, stableId);
    assert.equal(rotatedIdentity.Arn, "arn:aws:iam::000000000000:user/operator");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("schema 57 upgrades seed one administrator, migrate secrets to the vault, and skip fresh-login onboarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-default-admin-migration-"));
  const historical = emptyState("000000000000", region) as any;
  historical.schemaVersion = 57;
  delete historical.installation.defaultAdministrators;
  delete historical.accounts["000000000000"].iam.users;
  delete historical.accounts["000000000000"].iam.groups;
  delete historical.accounts["000000000000"].iam.accessKeys;
  await writeFile(join(root, "state.json"), JSON.stringify(historical));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: false });
  try {
    await simulator.start();
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.users), ["admin"]);
    assert.equal(simulator.store.state.installation.defaultAdministrators["000000000000"].firstConsoleLogin.status, "notApplicable");
    assert.equal((await clients(simulator).sts.send(new GetCallerIdentityCommand({}))).Arn, "arn:aws:iam::000000000000:user/admin");
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), /"password"|"secretAccessKey"|"sessionToken"/);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unowned deterministic CDK name starts in blocked status without adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-default-admin-bootstrap-blocked-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  try {
    await simulator.start();
    const names = cdkBootstrapNames("000000000000", region);
    await simulator.iam.CreateRole({
      RoleName: names.roleNames.deploy,
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] },
    });
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    const environment = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/environment`)).json() as any;
    assert.equal(environment.cdkBootstrap.status, "blocked");
    assert.deepEqual(environment.cdkBootstrap.collisions, [{
      type: "AWS::IAM::Role",
      name: names.roleNames.deploy,
      arn: names.roleArns.deploy,
    }]);
    assert.equal(simulator.store.regionState(region).cloudformation.bootstrap, undefined);
    assert.equal(simulator.store.ensureAccount().iam.roles[names.roleNames.deploy].tags["stacksim:managed-by"], undefined);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
