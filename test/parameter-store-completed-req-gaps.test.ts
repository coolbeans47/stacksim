import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  DeleteParameterCommand,
  DescribeParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string, terminal: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    clock.advance(1_000);
    await new Promise(resolve => setTimeout(resolve, 10));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      if (stack?.StackStatus === terminal) return;
      if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus?.includes("ROLLBACK_COMPLETE")) assert.fail(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
    } catch (error: any) {
      if (terminal === "DELETE_COMPLETE" && error.name === "ValidationError") return;
      throw error;
    }
  }
  assert.fail(`stack ${name} did not reach ${terminal}`);
}

test("reviewed PSS-01 gaps enforce one slash identity, root paths, Type on create, ARN metadata, and default-key filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss-gaps-core-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });

    await assert.rejects(client.send(new PutParameterCommand({ Name: "/review/missing-type", Value: "no-row" })), (error: any) => error.name === "ValidationException");
    assert.equal((await client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Values: ["/review/missing-type"] }] }))).Parameters?.length, 0);

    await client.send(new PutParameterCommand({ Name: "root-entry", Type: "String", Value: "one" }));
    await assert.rejects(client.send(new PutParameterCommand({ Name: "/root-entry", Type: "String", Value: "duplicate" })), (error: any) => error.name === "ParameterAlreadyExists");
    const overwritten = await client.send(new PutParameterCommand({ Name: "/root-entry", Value: "two", Overwrite: true }));
    assert.equal(overwritten.Version, 2);
    const aliased = await client.send(new GetParameterCommand({ Name: "/root-entry" }));
    assert.equal(aliased.Parameter?.Name, "root-entry");
    assert.equal(aliased.Parameter?.Value, "two");

    await client.send(new PutParameterCommand({ Name: "/nested/value", Type: "String", Value: "nested" }));
    await client.send(new PutParameterCommand({ Name: "/secure/value", Type: "SecureString", Value: "safe-marker" }));
    const directRoot = await client.send(new GetParametersByPathCommand({ Path: "/", Recursive: false }));
    assert.deepEqual(directRoot.Parameters?.map(parameter => parameter.Name), ["root-entry"]);
    const recursiveRoot = await client.send(new GetParametersByPathCommand({ Path: "/", Recursive: true, MaxResults: 10 }));
    assert.deepEqual(recursiveRoot.Parameters?.map(parameter => parameter.Name), ["/nested/value", "/secure/value", "root-entry"]);
    const trailingSlash = await client.send(new GetParametersByPathCommand({ Path: "/secure/", Recursive: true }));
    assert.deepEqual(trailingSlash.Parameters?.map(parameter => parameter.Name), ["/secure/value"]);
    await assert.rejects(client.send(new GetParametersByPathCommand({ Path: "/secure//", Recursive: true })), (error: any) => error.name === "ValidationException");

    const defaultKey = await client.send(new GetParametersByPathCommand({
      Path: "/secure",
      Recursive: true,
      ParameterFilters: [{ Key: "KeyId", Option: "Equals", Values: ["alias/aws/ssm"] }],
    }));
    assert.deepEqual(defaultKey.Parameters?.map(parameter => parameter.Name), ["/secure/value"]);
    const otherKey = await client.send(new GetParametersByPathCommand({
      Path: "/secure",
      Recursive: true,
      ParameterFilters: [{ Key: "KeyId", Option: "Equals", Values: ["alias/customer"] }],
    }));
    assert.equal(otherKey.Parameters?.length, 0);

    const described = await client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Values: ["root-entry"] }] }));
    assert.match(described.Parameters?.[0]?.ARN ?? "", /:parameter\/root-entry$/);
    assert.equal(described.Parameters?.length, 1);

    await client.send(new DeleteParameterCommand({ Name: "/root-entry" }));
    await assert.rejects(client.send(new GetParameterCommand({ Name: "root-entry" })), (error: any) => error.name === "ParameterNotFound");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed PSSGAP-04 DescribeParameters supports completed AWS filters and modeled filter errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss-gaps-filters-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new PutParameterCommand({ Name: "/filters/app/direct", Type: "String", Value: "direct", Tags: [{ Key: "environment", Value: "prod" }] }));
    await client.send(new PutParameterCommand({ Name: "/filters/app/nested/secret", Type: "SecureString", Value: "secret", Tags: [{ Key: "environment", Value: "production" }] }));
    await client.send(new PutParameterCommand({ Name: "/filters/other/list", Type: "StringList", Value: "one,two", Tags: [{ Key: "environment", Value: "dev" }] }));

    const names = async (ParameterFilters: any[]) => (await client!.send(new DescribeParametersCommand({ ParameterFilters }))).Parameters?.map(parameter => parameter.Name);
    assert.deepEqual(await names([{ Key: "tag:environment", Option: "Equals", Values: ["prod"] }]), ["/filters/app/direct"]);
    assert.deepEqual(await names([{ Key: "tag:environment", Option: "BeginsWith", Values: ["prod"] }]), ["/filters/app/direct", "/filters/app/nested/secret"]);
    assert.deepEqual(await names([{ Key: "Name", Option: "Contains", Values: ["nested"] }]), ["/filters/app/nested/secret"]);
    assert.deepEqual(await names([{ Key: "Type", Option: "BeginsWith", Values: ["Secure"] }]), ["/filters/app/nested/secret"]);
    assert.deepEqual(await names(Array.from({ length: 11 }, () => ({ Key: "Name", Option: "BeginsWith", Values: ["/filters/"] }))), ["/filters/app/direct", "/filters/app/nested/secret", "/filters/other/list"]);
    assert.deepEqual(await names([{ Key: "Path", Option: "OneLevel", Values: ["/filters/app"] }]), ["/filters/app/direct"]);
    assert.deepEqual(await names([{ Key: "Path", Option: "Recursive", Values: ["/filters/app/"] }]), ["/filters/app/direct", "/filters/app/nested/secret"]);

    const defaultKey = await client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "KeyId", Option: "Equals", Values: ["alias/aws/ssm"] }] }));
    assert.deepEqual(defaultKey.Parameters?.map(parameter => parameter.Name), ["/filters/app/nested/secret"]);

    for (const Key of ["Label", "TagKey", "TagValue", "PolicyType", "tag:"]) {
      await assert.rejects(client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key, Values: ["value"] }] })), (error: any) => error.name === "InvalidFilterKey");
    }
    await assert.rejects(client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Type", Option: "Contains", Values: ["String"] }] })), (error: any) => error.name === "InvalidFilterOption");
    await assert.rejects(client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Path", Option: "Equals", Values: ["/filters"] }] })), (error: any) => error.name === "InvalidFilterOption");
    await assert.rejects(client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Type", Values: [] }] })), (error: any) => error.name === "InvalidFilterValue");
    await assert.rejects(client.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Path", Option: "Recursive", Values: ["filters"] }] })), (error: any) => error.name === "InvalidFilterValue");
    await assert.rejects(client.send(new DescribeParametersCommand({ Shared: true })), (error: any) => error.name === "ValidationException" && /not supported/i.test(error.message));
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed PSS-05 change events include type and optional description without values", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss-gaps-events-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  const events: any[] = [];
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    (simulator.eventbridge as any).publishServiceEvent = async (input: any) => { events.push(structuredClone(input)); return { EventId: crypto.randomUUID() }; };
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const marker = `event-value-${crypto.randomUUID()}`;
    await client.send(new PutParameterCommand({ Name: "/review/event", Type: "String", Value: marker, Description: "reviewed description" }));
    for (let attempt = 0; attempt < 100 && !events.length; attempt++) { clock.advance(0); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(events[0]?.detail?.type, "String");
    assert.equal(events[0]?.detail?.description, "reviewed description");
    assert.equal(JSON.stringify(events).includes(marker), false);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed PSS-04 Retain releases Parameter Store CloudFormation ownership", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss-gaps-retain-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let cloudformation: CloudFormationClient | undefined;
  let ssm: SSMClient | undefined;
  try {
    await simulator.start();
    const configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now(), maxAttempts: 1 };
    cloudformation = new CloudFormationClient(configuration);
    ssm = new SSMClient(configuration);
    const body = JSON.stringify({ Resources: { Parameter: { Type: "AWS::SSM::Parameter", DeletionPolicy: "Retain", Properties: { Name: "/review/retained", Type: "String", Value: "from-stack" } } } });
    await cloudformation.send(new CreateStackCommand({ StackName: "pss-gap-retain", TemplateBody: body }));
    await waitForStack(cloudformation, clock, "pss-gap-retain", "CREATE_COMPLETE");
    await cloudformation.send(new DeleteStackCommand({ StackName: "pss-gap-retain" }));
    await waitForStack(cloudformation, clock, "pss-gap-retain", "DELETE_COMPLETE");
    assert.equal((await ssm.send(new GetParameterCommand({ Name: "/review/retained" }))).Parameter?.Value, "from-stack");
    assert.equal(simulator.ssm.localMetadata().find(parameter => parameter.name === "/review/retained")?.cloudFormationOwner, undefined);
    await ssm.send(new PutParameterCommand({ Name: "/review/retained", Value: "updated-while-unmanaged", Overwrite: true }));
    assert.equal((await ssm.send(new GetParameterCommand({ Name: "/review/retained" }))).Parameter?.Value, "updated-while-unmanaged");

    cloudformation.destroy();
    ssm.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
    await simulator.start();
    const restartedConfiguration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now(), maxAttempts: 1 };
    cloudformation = new CloudFormationClient(restartedConfiguration);
    ssm = new SSMClient(restartedConfiguration);
    const claimedBody = JSON.stringify({ Resources: { Parameter: { Type: "AWS::SSM::Parameter", Properties: { Name: "/review/retained", Type: "String", Value: "claimed-by-new-stack" } } } });
    await cloudformation.send(new CreateStackCommand({ StackName: "pss-gap-retain-claim", TemplateBody: claimedBody }));
    await waitForStack(cloudformation, clock, "pss-gap-retain-claim", "CREATE_COMPLETE");
    assert.equal((await ssm.send(new GetParameterCommand({ Name: "/review/retained" }))).Parameter?.Value, "claimed-by-new-stack");
    await assert.rejects(ssm.send(new PutParameterCommand({ Name: "/review/retained", Value: "outside", Overwrite: true })), /CloudFormation/);
    await cloudformation.send(new DeleteStackCommand({ StackName: "pss-gap-retain-claim" }));
    await waitForStack(cloudformation, clock, "pss-gap-retain-claim", "DELETE_COMPLETE");
    await assert.rejects(ssm.send(new GetParameterCommand({ Name: "/review/retained" })), (error: any) => error.name === "ParameterNotFound");
  } finally {
    cloudformation?.destroy();
    ssm?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed PSS-04 dynamic references reject a recreated parameter generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss-gaps-generation-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let client: SSMClient | undefined;
  try {
    await simulator.start();
    client = new SSMClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1, systemClockOffset: clock.now() - Date.now() });
    await client.send(new PutParameterCommand({ Name: "/review/source", Type: "String", Value: "first" }));
    const operationId = crypto.randomUUID();
    const principal = { principalType: "user", accessKeyId: "admin", principalArn: "arn:aws:iam::000000000000:user/admin", principalId: "admin", accountId: "000000000000", userName: "admin", userId: "admin", principalTags: {} };
    const properties = { Name: "/review/target", Type: "String", Value: "{{resolve:ssm:/review/source:1}}" };
    const first = await (simulator.cloudformation as any).resolveDynamicReferenceProperties("AWS::SSM::Parameter", properties, principal, operationId);
    assert.equal(first.Value, "first");
    const pinPath = join(root, "data", "cloudformation", "000000000000", region, "artifacts", "operations", `${operationId}.dynamic-reference-pins.json`);
    const pins = JSON.parse(await readFile(pinPath, "utf8"));
    assert.equal(typeof pins.references["{{resolve:ssm:/review/source:1}}"].generationId, "string");

    await client.send(new DeleteParameterCommand({ Name: "/review/source" }));
    clock.advance(31_000);
    await client.send(new PutParameterCommand({ Name: "/review/source", Type: "String", Value: "second" }));
    await assert.rejects(
      (simulator.cloudformation as any).resolveDynamicReferenceProperties("AWS::SSM::Parameter", properties, principal, operationId),
      /different parameter generation/i,
    );
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed PSS-04 typed SSM parameters keep generation pins across executor restart", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss-gaps-typed-generation-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
  let cloudformation: CloudFormationClient | undefined;
  let ssm: SSMClient | undefined;
  try {
    await simulator.start();
    let configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(configuration);
    ssm = new SSMClient(configuration);
    await ssm.send(new PutParameterCommand({ Name: "/review/typed-source", Type: "String", Value: "first-generation" }));
    let paused = false;
    simulator.cloudformation.setCheckpointInterceptorForTest(observation => {
      if (observation.checkpoint !== "executor-lease-acquired" || paused) return false;
      paused = true;
      return true;
    });
    const body = JSON.stringify({
      Parameters: { Source: { Type: "AWS::SSM::Parameter::Value<String>", Default: "/review/typed-source" } },
      Resources: { Target: { Type: "AWS::SSM::Parameter", Properties: { Name: "/review/typed-target", Type: "String", Value: { Ref: "Source" } } } },
    });
    await cloudformation.send(new CreateStackCommand({ StackName: "pss-gap-typed-generation", TemplateBody: body }));
    for (let attempt = 0; attempt < 100 && !paused; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(paused, true);
    const stackState = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => stack.stackName === "pss-gap-typed-generation")!;
    const operationId = stackState.activeOperation!.operationId;
    const pinPath = join(root, "data", "cloudformation", "000000000000", region, "artifacts", "operations", `${operationId}.typed-ssm-pins.json`);
    const pins = JSON.parse(await readFile(pinPath, "utf8"));
    assert.equal(typeof pins.parameters[0].generationId, "string");

    await ssm.send(new DeleteParameterCommand({ Name: "/review/typed-source" }));
    clock.advance(31_000);
    await ssm.send(new PutParameterCommand({ Name: "/review/typed-source", Type: "String", Value: "second-generation" }));
    cloudformation.destroy();
    ssm.destroy();
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false, clock });
    await simulator.start();
    configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(configuration);
    ssm = new SSMClient(configuration);
    let terminal: any;
    for (let attempt = 0; attempt < 500; attempt++) {
      clock.advance(1_000);
      await new Promise(resolve => setTimeout(resolve, 10));
      terminal = (await cloudformation.send(new DescribeStacksCommand({ StackName: "pss-gap-typed-generation" }))).Stacks?.[0];
      if (terminal?.StackStatus === "ROLLBACK_COMPLETE") break;
    }
    assert.equal(terminal?.StackStatus, "ROLLBACK_COMPLETE");
    assert.match(terminal?.StackStatusReason ?? "", /different parameter generation/i);
    await assert.rejects(ssm.send(new GetParameterCommand({ Name: "/review/typed-target" })), (error: any) => error.name === "ParameterNotFound");
  } finally {
    cloudformation?.destroy();
    ssm?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
