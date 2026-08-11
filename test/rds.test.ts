import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddTagsToResourceCommand,
  CreateDBParameterGroupCommand,
  CreateDBInstanceCommand,
  DeleteDBParameterGroupCommand,
  DeleteDBInstanceCommand,
  DescribeAccountAttributesCommand,
  DescribeDBParameterGroupsCommand,
  DescribeDBParametersCommand,
  DescribeDBEngineVersionsCommand,
  DescribeDBInstancesCommand,
  DescribeEngineDefaultParametersCommand,
  DescribeOrderableDBInstanceOptionsCommand,
  DescribeValidDBInstanceModificationsCommand,
  ListTagsForResourceCommand,
  ModifyDBInstanceCommand,
  ModifyDBParameterGroupCommand,
  RebootDBInstanceCommand,
  RemoveTagsFromResourceCommand,
  ResetDBParameterGroupCommand,
  RDSClient,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
} from "@aws-sdk/client-rds";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { RdsEngineConfig, RdsEngineDiscovery, RdsEngineProvider, RdsEngineRuntime } from "../src/rds/provider.js";
import { EmbeddedSqliteProvider } from "../src/rds/embedded-sqlite.js";
import { authorizationTarget } from "../src/auth/target.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("RDS authorization maps DB ARNs and requires AddTagsToResource for tagged creation", async () => {
  const request = {
    method: "POST",
    url: "/",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "rds-auth-test" },
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
    [Symbol.for("stacksim.request-body")]: Buffer.from("Action=CreateDBInstance&DBInstanceIdentifier=development-db&Tags.Tag.1.Key=team&Tags.Tag.1.Value=database"),
  } as any;
  const target = await authorizationTarget(request, new URL("http://127.0.0.1/"), "rds", "eu-west-1", "000000000000", { principalArn: "arn:aws:iam::000000000000:role/developer", accountId: "000000000000", accessKeyId: "admin" } as any, Date.now());
  assert.equal(target.action, "rds:CreateDBInstance");
  assert.equal(target.resource, "arn:aws:rds:eu-west-1:000000000000:db:development-db");
  assert.deepEqual(target.context["aws:TagKeys"], ["team"]);
  assert.equal(target.context["aws:RequestTag/team"], "database");
  assert.deepEqual(target.additionalTargets?.map(item => [item.action, item.resource]), [["rds:AddTagsToResource", target.resource]]);

  const groupRequest = { ...request, [Symbol.for("stacksim.request-body")]: Buffer.from("Action=CreateDBParameterGroup&DBParameterGroupName=development-safe&Tags.Tag.1.Key=owner&Tags.Tag.1.Value=database") } as any;
  const groupTarget = await authorizationTarget(groupRequest, new URL("http://127.0.0.1/"), "rds", "eu-west-1", "000000000000", { principalArn: "arn:aws:iam::000000000000:role/developer", accountId: "000000000000", accessKeyId: "admin" } as any, Date.now());
  assert.equal(groupTarget.resource, "arn:aws:rds:eu-west-1:000000000000:pg:development-safe"); assert.equal(groupTarget.context["aws:RequestTag/owner"], "database"); assert.equal(groupTarget.additionalTargets?.[0].action, "rds:AddTagsToResource");
  const snapshotRequest = { ...request, [Symbol.for("stacksim.request-body")]: Buffer.from("Action=CreateDBSnapshot&DBInstanceIdentifier=development-db&DBSnapshotIdentifier=before-migration&Tags.Tag.1.Key=stage&Tags.Tag.1.Value=before") } as any;
  const snapshotTarget = await authorizationTarget(snapshotRequest, new URL("http://127.0.0.1/"), "rds", "eu-west-1", "000000000000", { principalArn: "arn:aws:iam::000000000000:role/developer", accountId: "000000000000", accessKeyId: "admin" } as any, Date.now());
  const snapshotArn = "arn:aws:rds:eu-west-1:000000000000:snapshot:before-migration";
  assert.equal(snapshotTarget.resource, target.resource);
  assert.deepEqual(snapshotTarget.additionalTargets?.map(item => [item.action, item.resource]), [["rds:CreateDBSnapshot", snapshotArn], ["rds:AddTagsToResource", snapshotArn]]);
  const removeRequest = { ...request, [Symbol.for("stacksim.request-body")]: Buffer.from(`Action=RemoveTagsFromResource&ResourceName=${encodeURIComponent(target.resource)}&TagKeys.member.1=environment`) } as any;
  const removeTarget = await authorizationTarget(removeRequest, new URL("http://127.0.0.1/"), "rds", "eu-west-1", "000000000000", { principalArn: "arn:aws:iam::000000000000:role/developer", accountId: "000000000000", accessKeyId: "admin" } as any, Date.now());
  assert.equal(removeTarget.resource, target.resource); assert.deepEqual(removeTarget.context["aws:TagKeys"], ["environment"]);
});

class FakeRdsEngineProvider implements RdsEngineProvider {
  ready = true;
  readinessDiagnostic?: (config: RdsEngineConfig) => string;
  discoverCalls = 0;
  initializeCalls = 0;
  startCalls = 0;
  readinessCalls = 0;
  stopCalls = 0;
  rotateCalls = 0;
  parameterCalls: Record<string, string>[] = [];
  reconfigureCalls: Array<[number, number]> = [];
  destroyedResourceDirs: string[] = [];
  lastStarted?: Omit<RdsEngineConfig, "masterPassword">;
  private running?: Omit<RdsEngineConfig, "masterPassword">;
  private masterPassword?: string;

  async discover(): Promise<RdsEngineDiscovery> {
    this.discoverCalls += 1;
    return {
      providerName: "fake-sqlite",
      engineVersion: "3.45.0",
      version: "fake-sqlite 3.45.0",
    };
  }

  async initialize(config: RdsEngineConfig): Promise<void> {
    this.initializeCalls += 1;
    this.masterPassword ??= config.masterPassword;
    await mkdir(config.resourceDir, { recursive: true });
  }

  async start(config: RdsEngineConfig): Promise<RdsEngineRuntime> {
    this.startCalls += 1;
    if (this.masterPassword !== undefined && config.masterPassword !== this.masterPassword) throw new Error("fake master authentication failed");
    this.running = this.withoutPassword(config);
    this.lastStarted = this.running;
    return this.runtime(this.running);
  }

  async readiness(config: RdsEngineConfig): Promise<RdsEngineRuntime> {
    this.readinessCalls += 1;
    if (!this.running || this.running.resourceId !== config.resourceId) throw new Error("fake provider is not running");
    return { ...this.runtime(this.running), ready: this.ready, ...(this.ready ? {} : { diagnostic: this.readinessDiagnostic?.(config) ?? "fake provider is not ready" }) };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = undefined;
  }

  async rotateMasterPassword(config: RdsEngineConfig, nextPassword: string): Promise<void> { assert.equal(config.masterPassword, this.masterPassword); this.masterPassword = nextPassword; this.rotateCalls += 1; }

  async applyParameters(_config: RdsEngineConfig, parameters: Record<string, string>): Promise<void> { this.parameterCalls.push({ ...parameters }); }

  async reconfigure(current: RdsEngineConfig, next: RdsEngineConfig): Promise<void> { this.reconfigureCalls.push([current.port, next.port]); }

  async destroy(config: Pick<RdsEngineConfig, "resourceId" | "resourceDir" | "port">): Promise<void> {
    this.destroyedResourceDirs.push(config.resourceDir);
    this.masterPassword = undefined;
    await rm(config.resourceDir, { recursive: true, force: true });
  }

  private withoutPassword(config: RdsEngineConfig): Omit<RdsEngineConfig, "masterPassword"> {
    const { masterPassword: _masterPassword, ...safe } = config;
    return structuredClone(safe);
  }

  private runtime(config: Omit<RdsEngineConfig, "masterPassword">): RdsEngineRuntime {
    return {
      providerName: "fake-sqlite",
      resourceId: config.resourceId,
      resourceDir: config.resourceDir,
      endpoint: { address: "127.0.0.1", port: config.port },
      engineVersion: "3.45.0",
      ready: true,
    };
  }
}

function rdsClient(simulator: StackSim, region = "eu-west-1"): RDSClient {
  return new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  assert.ok(port >= 1150, `expected an RDS-compatible ephemeral port, got ${port}`);
  return port;
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met before timeout; last value: ${JSON.stringify(last)}`);
}

async function eventuallyMissing(client: RDSClient, identifier: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
    } catch (error: any) {
      if (error?.name === "DBInstanceNotFoundFault") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`DB instance ${identifier} was not removed before timeout`);
}

test("RDS singleton control plane supports named Query XML, restart, discovery, and slot release", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-"));
  const port = await freePort();
  const password = "OnlyInPrivateRdsSecret123";
  let provider = new FakeRdsEngineProvider();
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: provider, authMode: "off"});
  let west: RDSClient | undefined;
  let east: RDSClient | undefined;
  let running = false;

  try {
    await simulator.start(); running = true;
    west = rdsClient(simulator);
    east = rdsClient(simulator, "us-east-1");

    const engines = await west.send(new DescribeDBEngineVersionsCommand({ Engine: "mysql", EngineVersion: "8.0" }));
    assert.equal(engines.DBEngineVersions?.length, 1);
    assert.equal(engines.DBEngineVersions?.[0].DBParameterGroupFamily, "mysql8.0");
    const options = await west.send(new DescribeOrderableDBInstanceOptionsCommand({ Engine: "mysql", EngineVersion: "8.0", DBInstanceClass: "db.t3.micro" }));
    assert.deepEqual(options.OrderableDBInstanceOptions?.map(option => option.StorageType).sort(), ["gp2", "gp3"]);
    assert.deepEqual((await west.send(new DescribeAccountAttributesCommand({}))).AccountQuotas?.map(quota => [quota.AccountQuotaName, quota.Used, quota.Max]), [["DBInstances", 0, 1]]);

    const created = await west.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: "development-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      EngineVersion: "8.0",
      AllocatedStorage: 20,
      StorageType: "gp3",
      DBName: "appdb",
      MasterUsername: "devuser",
      MasterUserPassword: password,
      Port: port,
      BackupRetentionPeriod: 0,
      PubliclyAccessible: false,
      DeletionProtection: false,
      Tags: [{ Key: "environment", Value: "development" }, { Key: "owner", Value: "local" }],
    }));
    assert.equal(created.DBInstance?.DBInstanceStatus, "creating");
    assert.equal(created.DBInstance?.Endpoint?.Address, "127.0.0.1");
    assert.equal(created.DBInstance?.Endpoint?.Port, port);
    assert.deepEqual(created.DBInstance?.TagList, [{ Key: "environment", Value: "development" }, { Key: "owner", Value: "local" }]);

    const available = await eventually(
      () => west!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "development-db" })),
      response => response.DBInstances?.[0]?.DBInstanceStatus === "available",
    );
    assert.equal(available.DBInstances?.length, 1, "the SDK must decode the named DBInstance XML member");
    assert.equal(available.DBInstances?.[0].Endpoint?.Port, port);
    assert.equal(provider.lastStarted?.port, port);
    assert.equal(provider.lastStarted?.databaseName, "appdb");
    assert.ok(provider.discoverCalls >= 1 && provider.initializeCalls >= 1 && provider.readinessCalls >= 1);

    const filtered = await west.send(new DescribeDBInstancesCommand({ Filters: [{ Name: "engine", Values: ["mysql"] }] }));
    assert.equal(filtered.DBInstances?.[0].DBInstanceIdentifier, "development-db", "the SDK named Filter/Value request must parse");
    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "rds" },
      body: new URLSearchParams({ Action: "DescribeDBInstances", Version: "2014-10-31", "Filters.Filter.1.Name": "engine", "Filters.Filter.1.Values.Value.1": "mysql" }),
    });
    const xml = await raw.text();
    assert.equal(raw.status, 200);
    assert.match(xml, /<DBInstances><DBInstance>/);
    assert.match(xml, /<TagList><Tag><Key>environment<\/Key><Value>development<\/Value><\/Tag>/);
    assert.doesNotMatch(xml, /<DBInstances><member>/);

    await assert.rejects(
      west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "development-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "devuser", MasterUserPassword: "AnotherSecret123", Port: await freePort() })),
      (error: any) => error?.name === "DBInstanceAlreadyExistsFault",
    );
    await assert.rejects(
      east.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "other-region-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "devuser", MasterUserPassword: "AnotherSecret123", Port: await freePort() })),
      (error: any) => error?.name === "InstanceQuotaExceededFault",
    );
    assert.equal((await east.send(new DescribeDBInstancesCommand({}))).DBInstances?.length, 0, "descriptors remain regional while the slot is installation-wide");
    assert.deepEqual((await west.send(new DescribeAccountAttributesCommand({}))).AccountQuotas?.map(quota => [quota.Used, quota.Max]), [[1, 1]]);

    const serializedState = await readFile(join(dataDir, "state.json"), "utf8");
    assert.doesNotMatch(serializedState, new RegExp(password));
    assert.doesNotMatch(JSON.stringify(simulator.store.state), new RegExp(password));

    west.destroy(); east.destroy(); west = east = undefined;
    await simulator.stop(); running = false;

    provider = new FakeRdsEngineProvider();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: provider, authMode: "off"});
    await simulator.start(); running = true;
    west = rdsClient(simulator);
    east = rdsClient(simulator, "us-east-1");
    const restarted = await west.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "development-db" }));
    assert.equal(restarted.DBInstances?.[0].DBInstanceStatus, "available");
    assert.equal(restarted.DBInstances?.[0].Endpoint?.Port, port);
    assert.equal(provider.startCalls, 1, "restart must reconcile and start the persisted lease through the injected provider");

    const deleting = await west.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "development-db", SkipFinalSnapshot: true }));
    assert.equal(deleting.DBInstance?.DBInstanceStatus, "deleting");
    await eventuallyMissing(west, "development-db");
    assert.equal(simulator.store.state.installation.rds.instanceLease, undefined);
    assert.equal(provider.destroyedResourceDirs.length, 1);

    const replacementPort = await freePort();
    const replacement = await east.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: "replacement-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      EngineVersion: "8.0",
      MasterUsername: "devuser",
      MasterUserPassword: "ReplacementSecret123",
      Port: replacementPort,
    }));
    assert.equal(replacement.DBInstance?.Endpoint?.Port, replacementPort);
    const replacementAvailable = await eventually(
      () => east!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "replacement-db" })),
      response => response.DBInstances?.[0]?.DBInstanceStatus === "available",
    );
    assert.equal(replacementAvailable.DBInstances?.[0].DBInstanceStatus, "available");
    const replacementLease = simulator.store.state.installation.rds.instanceLease as { region: string } | undefined;
    assert.equal(replacementLease?.region, "us-east-1");
  } finally {
    west?.destroy(); east?.destroy();
    if (running) await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RDS-02 supports daily lifecycle, pending modifications, tags, and safe parameter groups", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds02-")); const provider = new FakeRdsEngineProvider();
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: provider, authMode: "off"}); let client: RDSClient | undefined; const occupied = createServer();
  try {
    await simulator.start(); client = rdsClient(simulator);
    const createdGroup = await client.send(new CreateDBParameterGroupCommand({ DBParameterGroupName: "development-safe", DBParameterGroupFamily: "mysql8.0", Description: "Safe development overrides", Tags: [{ Key: "owner", Value: "database" }] }));
    assert.equal(createdGroup.DBParameterGroup?.DBParameterGroupName, "development-safe");
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceName: createdGroup.DBParameterGroup!.DBParameterGroupArn! }))).TagList, [{ Key: "owner", Value: "database" }]);
    const groups = await client.send(new DescribeDBParameterGroupsCommand({}));
    assert.deepEqual(groups.DBParameterGroups?.map(group => group.DBParameterGroupName), ["default.mysql8.0", "development-safe"]);
    const defaults = await client.send(new DescribeEngineDefaultParametersCommand({ DBParameterGroupFamily: "mysql8.0" }));
    assert.ok((defaults.EngineDefaults?.Parameters?.length ?? 0) >= 5);
    await client.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: "development-safe", Parameters: [
      { ParameterName: "max_connections", ParameterValue: "120", ApplyMethod: "immediate" },
      { ParameterName: "collation_server", ParameterValue: "utf8mb4_general_ci", ApplyMethod: "pending-reboot" },
    ] }));
    const userParameters = await client.send(new DescribeDBParametersCommand({ DBParameterGroupName: "development-safe", Source: "user" }));
    assert.deepEqual(userParameters.Parameters?.map(parameter => [parameter.ParameterName, parameter.ParameterValue, parameter.ApplyMethod]), [
      ["max_connections", "120", "immediate"], ["collation_server", "utf8mb4_general_ci", "pending-reboot"],
    ]);
    await assert.rejects(client.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: "development-safe", Parameters: [{ ParameterName: "plugin_load", ParameterValue: "example.so", ApplyMethod: "pending-reboot" }] })), (error: any) => error.name === "InvalidParameterValue");

    const originalPort = await freePort(); const nextPort = await freePort(); const rotatedPassword = "RotatedPrivateSecret456";
    await client.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "daily-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "OriginalPrivateSecret123", Port: originalPort, DBParameterGroupName: "development-safe", DeletionProtection: true, Tags: [{ Key: "environment", Value: "dev" }] }));
    let described = await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    assert.deepEqual(described.DBInstances?.[0].DBParameterGroups?.map(group => [group.DBParameterGroupName, group.ParameterApplyStatus]), [["development-safe", "in-sync"]]);
    const valid = await client.send(new DescribeValidDBInstanceModificationsCommand({ DBInstanceIdentifier: "daily-db" }));
    assert.deepEqual(valid.ValidDBInstanceModificationsMessage?.Storage?.map(option => option.StorageType), ["gp2", "gp3"]);
    const arn = described.DBInstances![0].DBInstanceArn!;
    await assert.rejects(client.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "daily-db", SkipFinalSnapshot: true })), (error: any) => error.name === "InvalidParameterCombination");
    await client.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: [{ Key: "team", Value: "platform" }] }));
    await client.send(new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: ["environment"] }));
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceName: arn }))).TagList, [{ Key: "team", Value: "platform" }]);

    await client.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: "development-safe", Parameters: [
      { ParameterName: "max_connections", ParameterValue: "150", ApplyMethod: "immediate" },
      { ParameterName: "collation_server", ParameterValue: "utf8mb4_unicode_ci", ApplyMethod: "pending-reboot" },
    ] }));
    assert.deepEqual(provider.parameterCalls.at(-1), { max_connections: "150" });
    described = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" }));
    assert.equal(described.DBInstances?.[0].DBParameterGroups?.[0].ParameterApplyStatus, "pending-reboot");

    await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(nextPort, "127.0.0.1", resolve); });
    const modifying = await client.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: "daily-db", AllocatedStorage: 30, StorageType: "gp2", DBPortNumber: nextPort, MasterUserPassword: rotatedPassword, DeletionProtection: false, ApplyImmediately: false }));
    assert.equal(modifying.DBInstance?.DBInstanceStatus, "modifying"); assert.equal(modifying.DBInstance?.PendingModifiedValues?.Port, nextPort); assert.doesNotMatch(JSON.stringify(modifying), new RegExp(rotatedPassword));
    described = await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    assert.equal(described.DBInstances?.[0].Endpoint?.Port, originalPort); assert.equal(described.DBInstances?.[0].AllocatedStorage, 20); assert.equal(provider.rotateCalls, 1);

    await client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: "daily-db" }));
    described = await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    assert.equal(described.DBInstances?.[0].Endpoint?.Port, originalPort, "a colliding pending port must retain the working listener descriptor");
    assert.equal(described.DBInstances?.[0].PendingModifiedValues?.Port, undefined);
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));

    await client.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: "daily-db", DBPortNumber: nextPort, ApplyImmediately: true }));
    described = await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available" && response.DBInstances?.[0]?.Endpoint?.Port === nextPort);
    assert.equal(described.DBInstances?.[0].AllocatedStorage, 30, "ApplyImmediately applies earlier pending descriptor changes too");
    assert.deepEqual(provider.reconfigureCalls.at(-1), [originalPort, nextPort]);

    await client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: "daily-db" }));
    described = await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    assert.equal(described.DBInstances?.[0].DBParameterGroups?.[0].ParameterApplyStatus, "in-sync");
    assert.equal((await client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: "daily-db" }))).DBInstance?.DBInstanceStatus, "stopping");
    await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "stopped");
    assert.equal((await client.send(new StartDBInstanceCommand({ DBInstanceIdentifier: "daily-db" }))).DBInstance?.DBInstanceStatus, "starting");
    await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");

    await client.send(new ResetDBParameterGroupCommand({ DBParameterGroupName: "development-safe", ResetAllParameters: true }));
    await client.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: "daily-db", DBParameterGroupName: "default.mysql8.0" }));
    await client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: "daily-db" }));
    await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "daily-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    await client.send(new DeleteDBParameterGroupCommand({ DBParameterGroupName: "development-safe" }));
    const serialized = await readFile(join(dataDir, "state.json"), "utf8"); assert.doesNotMatch(serialized, /OriginalPrivateSecret123|RotatedPrivateSecret456/);
    await client.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "daily-db", SkipFinalSnapshot: true })); await eventuallyMissing(client, "daily-db");
  } finally {
    client?.destroy(); if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve())); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("RDS-02 resumes persisted lifecycle and modification transitions after simulator restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds02-recovery-")); const identifier = "recovering-db"; const sqlPort = await freePort(); const movedPort = await freePort();
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: new FakeRdsEngineProvider(), authMode: "off"}); let client: RDSClient | undefined; let running = false;
  const mutate = async (change: (instance: any) => void) => { const path = join(dataDir, "state.json"); const state = JSON.parse(await readFile(path, "utf8")); change(state.accounts["000000000000"].regions["eu-west-1"].rdsDbInstances[identifier]); await writeFile(path, JSON.stringify(state)); };
  const restart = async () => { simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: new FakeRdsEngineProvider(), authMode: "off"}); await simulator.start(); running = true; client = rdsClient(simulator); };
  try {
    await simulator.start(); running = true; client = rdsClient(simulator);
    await client.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: identifier, DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "RecoveryPrivateSecret123", Port: sqlPort })); await eventually(() => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    client.destroy(); client = undefined; await simulator.stop(); running = false;
    await mutate(instance => { instance.dbInstanceStatus = "stopping"; instance.lifecycleOperation = "stop"; }); await restart(); assert.equal(simulator.store.regionState("eu-west-1").rdsDbInstances[identifier].dbInstanceStatus, "stopped");
    client!.destroy(); client = undefined; await simulator.stop(); running = false;
    await mutate(instance => { instance.dbInstanceStatus = "starting"; instance.lifecycleOperation = "start"; }); await restart(); assert.equal(simulator.store.regionState("eu-west-1").rdsDbInstances[identifier].dbInstanceStatus, "available");
    client!.destroy(); client = undefined; await simulator.stop(); running = false;
    await mutate(instance => { instance.dbInstanceStatus = "rebooting"; instance.lifecycleOperation = "reboot"; instance.pendingModifiedValues = { allocatedStorage: 25 }; }); await restart(); assert.equal(simulator.store.regionState("eu-west-1").rdsDbInstances[identifier].allocatedStorage, 25);
    client!.destroy(); client = undefined; await simulator.stop(); running = false;
    await mutate(instance => { instance.dbInstanceStatus = "modifying"; instance.lifecycleOperation = "modify"; instance.applyPendingConfiguration = true; instance.pendingModifiedValues = { port: movedPort }; }); await restart(); const recovered = simulator.store.regionState("eu-west-1").rdsDbInstances[identifier]; assert.equal(recovered.dbInstanceStatus, "available"); assert.equal(recovered.port, movedPort); assert.equal(simulator.store.state.installation.rds.instanceLease?.port, movedPort);
  } finally { client?.destroy(); if (running) await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("RDS rejects invalid and colliding creates, serializes concurrent claims, and records failed readiness safely", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-validation-"));
  const provider = new FakeRdsEngineProvider();
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: provider, authMode: "off"});
  let west: RDSClient | undefined;
  let east: RDSClient | undefined;
  let running = false;
  const occupied = createServer();

  try {
    await simulator.start(); running = true;
    west = rdsClient(simulator);
    east = rdsClient(simulator, "us-east-1");

    const wrongVersion = await fetch(`http://127.0.0.1:${simulator.port}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "rds" },
      body: new URLSearchParams({ Action: "DescribeDBInstances", Version: "2014-01-01" }),
    });
    assert.equal(wrongVersion.status, 400);
    assert.match(await wrongVersion.text(), /<Code>InvalidParameterValue<\/Code>/);

    await assert.rejects(
      west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "public-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "Validation Secret 123", PubliclyAccessible: true })),
      (error: any) => error?.name === "InvalidParameterCombination",
    );
    await assert.rejects(
      west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "unsupported-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "ValidationSecret123", AvailabilityZone: "eu-west-1b" })),
      (error: any) => error?.name === "InvalidParameterCombination",
    );
    await assert.rejects(
      west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "missing-group-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "ValidationSecret123", DBParameterGroupName: "missing-group" })),
      (error: any) => error?.name === "DBParameterGroupNotFoundFault",
    );
    assert.equal(provider.discoverCalls, 0, "validation must run before provider discovery");

    await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(0, "127.0.0.1", resolve); });
    const occupiedAddress = occupied.address();
    const occupiedPort = typeof occupiedAddress === "object" && occupiedAddress ? occupiedAddress.port : 0;
    await assert.rejects(
      west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "port-collision", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "ValidationSecret123", Port: occupiedPort })),
      (error: any) => error?.name === "InsufficientDBInstanceCapacityFault",
    );
    assert.equal(simulator.store.state.installation.rds.instanceLease, undefined, "a port collision must not claim the singleton lease");
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));

    const westPort = await freePort();
    let eastPort = await freePort();
    while (eastPort === westPort) eastPort = await freePort();
    const concurrent = await Promise.allSettled([
      west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "Concurrent-West", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "ConcurrentSecret123", Port: westPort })),
      east.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "Concurrent-East", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "ConcurrentSecret123", Port: eastPort })),
    ]);
    const successes = concurrent.filter((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled");
    const failures = concurrent.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason?.name, "InstanceQuotaExceededFault");
    const ownerRegion = (simulator.store.state.installation.rds.instanceLease as { region: string } | undefined)?.region;
    const owner = ownerRegion === "eu-west-1" ? west : east;
    const originalIdentifier = ownerRegion === "eu-west-1" ? "Concurrent-West" : "Concurrent-East";
    await eventually(
      () => owner!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: originalIdentifier })),
      response => response.DBInstances?.[0]?.DBInstanceStatus === "available",
    );
    const health = await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/health`)).json() as any;
    assert.equal(health.rds.instanceStatus, "available");
    assert.equal(health.rds.ownerRegion, ownerRegion);
    await owner!.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: originalIdentifier, SkipFinalSnapshot: true }));
    await eventuallyMissing(owner!, originalIdentifier.toLowerCase());

    provider.ready = false;
    provider.readinessDiagnostic = config => `provider not ready; password=${config.masterPassword}; path=${config.resourceDir}`;
    const failedPassword = "FailureSecret123";
    await west.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "failed-readiness", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: failedPassword, Port: await freePort() }));
    const failed = await eventually(
      () => west!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "FAILED-READINESS" })),
      response => response.DBInstances?.[0]?.DBInstanceStatus === "failed",
    );
    const diagnostic = failed.DBInstances?.[0]?.StatusInfos?.[0]?.Message ?? "";
    assert.doesNotMatch(diagnostic, new RegExp(failedPassword));
    assert.equal(diagnostic.includes(dataDir), false);
    assert.equal((await (await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/api/environment`)).json() as any).rds.instanceStatus, "failed");
    await west.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "FAILED-READINESS", SkipFinalSnapshot: true }));
    await eventuallyMissing(west, "failed-readiness");
  } finally {
    west?.destroy(); east?.destroy();
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    if (running) await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("embedded RDS deletion is offline and idempotent after initialization failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-failed-provider-"));
  const instancesRoot = join(dataDir, "rds", "instances");
  const resourceId = "db-0123456789abcdef0123456789";
  const resourceDir = join(instancesRoot, resourceId);
  const provider = new EmbeddedSqliteProvider({ instancesRoot });
  try {
    const port = await freePort();
    await mkdir(resourceDir, { recursive: true });
    await writeFile(join(resourceDir, ".stacksim-rds-sqlite.json"), JSON.stringify({ schemaVersion: 1, providerName: "embedded-sqlite", resourceId, port, state: "failed", failureCode: "INITIALIZATION_FAILED" }));
    await provider.destroy({ resourceId, resourceDir, port });
    assert.deepEqual(await readdir(instancesRoot), []);
    const tombstone = join(instancesRoot, `${resourceId}.deleting`);
    await mkdir(tombstone, { recursive: true });
    await writeFile(join(tombstone, ".stacksim-rds-sqlite.json"), JSON.stringify({ schemaVersion: 1, providerName: "embedded-sqlite", resourceId, port, state: "ready" }));
    await provider.destroy({ resourceId, resourceDir, port });
    assert.deepEqual(await readdir(instancesRoot), []);
    await provider.destroy({ resourceId, resourceDir, port });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("embedded RDS leaves legacy data untouched and supports safe delete and recreate", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-provider-upgrade-"));
  const provider = new FakeRdsEngineProvider();
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: provider, authMode: "off"});
  let client: RDSClient | undefined; let running = false;
  try {
    await simulator.start(); running = true; client = rdsClient(simulator);
    await client.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "legacy-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "LegacyCleanupSecret123", Port: await freePort() }));
    const created = await eventually(
      () => client!.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "legacy-db" })),
      response => response.DBInstances?.[0]?.DBInstanceStatus === "available",
    );
    const resourceId = created.DBInstances![0].DbiResourceId!;
    const port = created.DBInstances![0].Endpoint!.Port!;
    client.destroy(); client = undefined; await simulator.stop(); running = false;

    const resourceDir = join(dataDir, "data", "rds", "instances", resourceId);
    await writeFile(join(resourceDir, ".stacksim-rds-mariadb.json"), JSON.stringify({ schemaVersion: 1, providerName: "managed-mariadb", resourceId, port, engineVersion: "11.4.10", state: "ready" }));
    const persisted = simulator.store.regionState("eu-west-1").rdsDbInstances["legacy-db"];
    persisted.providerEngine = "mariadb";
    persisted.dbInstanceStatus = "available";
    await simulator.store.save();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start(); running = true; client = rdsClient(simulator);
    const incompatible = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "legacy-db" }));
    assert.equal(incompatible.DBInstances?.[0].DBInstanceStatus, "failed");
    assert.match(incompatible.DBInstances?.[0].StatusInfos?.[0]?.Message ?? "", /delete and recreate/i);
    await client.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "legacy-db", SkipFinalSnapshot: true }));
    await eventuallyMissing(client, "legacy-db");
    assert.equal(simulator.store.state.installation.rds.instanceLease, undefined);
  } finally {
    client?.destroy(); if (running) await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RDS enforce mode requires tagged-create permission and exposes resource tags to delete authorization", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-iam-"));
  const provider = new FakeRdsEngineProvider();
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsProvider: provider, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  let running = false;

  try {
    await simulator.start(); running = true;
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const iam = new IAMClient({ endpoint, region: "eu-west-1", credentials });
    const sts = new STSClient({ endpoint, region: "eu-west-1", credentials });
    clients.push(iam, sts);
    const roleArn = "arn:aws:iam::000000000000:role/rds-developer";
    await iam.send(new CreateRoleCommand({
      RoleName: "rds-developer",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }),
    }));
    const databaseArn = "arn:aws:rds:eu-west-1:000000000000:db:iam-db";
    const basePolicy = await iam.send(new CreatePolicyCommand({
      PolicyName: "RdsDevelopmentBase",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["rds:DescribeDBInstances", "rds:DescribeAccountAttributes"], Resource: "*" },
        { Effect: "Allow", Action: "rds:CreateDBInstance", Resource: databaseArn, Condition: { StringEquals: { "aws:RequestTag/environment": "development" } } },
        { Effect: "Allow", Action: "rds:DeleteDBInstance", Resource: databaseArn, Condition: { StringEquals: { "aws:ResourceTag/environment": "development" } } },
        { Effect: "Allow", Action: ["rds:ListTagsForResource", "rds:RemoveTagsFromResource"], Resource: databaseArn, Condition: { StringEquals: { "aws:ResourceTag/environment": "development" } } },
      ] }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "rds-developer", PolicyArn: basePolicy.Policy!.Arn! }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "database-work" }));
    const roleCredentials = { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! };
    const rds = new RDSClient({ endpoint, region: "eu-west-1", credentials: roleCredentials, maxAttempts: 1 });
    clients.push(rds);
    const sqlPort = await freePort();
    const create = () => rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "iam-db", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "IamDatabaseSecret123", Port: sqlPort, Tags: [{ Key: "environment", Value: "development" }] }));
    await assert.rejects(create(), (error: any) => String(error?.name).startsWith("AccessDenied"));
    assert.equal(provider.discoverCalls, 0, "authorization must fail before provider work");

    const tagPolicy = await iam.send(new CreatePolicyCommand({
      PolicyName: "RdsDevelopmentTags",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "rds:AddTagsToResource", Resource: databaseArn, Condition: { StringEquals: { "aws:RequestTag/environment": "development" } } }] }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "rds-developer", PolicyArn: tagPolicy.Policy!.Arn! }));
    await create();
    await eventually(() => rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "iam-db" })), response => response.DBInstances?.[0]?.DBInstanceStatus === "available");
    assert.equal((await rds.send(new ListTagsForResourceCommand({ ResourceName: databaseArn }))).TagList?.[0].Value, "development");
    await rds.send(new RemoveTagsFromResourceCommand({ ResourceName: databaseArn, TagKeys: ["environment"] }));
    await assert.rejects(rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "iam-db", SkipFinalSnapshot: true })), (error: any) => String(error?.name).startsWith("AccessDenied"));
    await rds.send(new AddTagsToResourceCommand({ ResourceName: databaseArn, Tags: [{ Key: "environment", Value: "development" }] }));
    await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "iam-db", SkipFinalSnapshot: true }));
    await eventuallyMissing(rds, "iam-db");
    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions;
    assert.ok(decisions.some(decision => decision.action === "rds:AddTagsToResource" && decision.decision === "implicitDeny"));
    assert.ok(decisions.some(decision => decision.action === "rds:DeleteDBInstance" && decision.decision === "allowed"), "the resource-tag condition must authorize deletion");
  } finally {
    clients.forEach(client => client.destroy());
    if (running) await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
