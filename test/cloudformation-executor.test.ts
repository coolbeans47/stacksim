import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFormationService } from "../src/cloudformation.js";
import {
  CloudFormationTestProviderRegistry,
  createDefaultCloudFormationProviderRegistry,
  type ProviderContext,
  type ProviderPlan,
  type ProviderReadModel,
  type TestOnlyResourceProvider,
  validateDeclaredProperties,
} from "../src/cloudformation/providers/index.js";
import { SystemClock, TestClock, type Clock } from "../src/core/clock.js";
import { S3Service } from "../src/s3.js";
import { StateStore } from "../src/state.js";

const region = "eu-west-1";
const principal: PrincipalContext = { accessKeyId: "admin", principalArn: "arn:aws:iam::000000000000:root", principalId: "000000000000", accountId: "000000000000" };

interface FakeModel { Name: string; Value?: string }

function fakeProvider() {
  const resources = new Map<string, FakeModel>();
  const ids = new Map<string, string>();
  const calls: string[] = [];
  const delayedNames = new Set<string>();
  const stuckNames = new Set<string>();
  const failedCreates = new Set<string>();
  let failRollbackUpdates = false;
  let counter = 0;
  const schema = {
    typeName: "Test::Lifecycle::Resource",
    unknownProperties: "REJECT" as const,
    properties: {
      Name: { valueType: "string" as const, required: true, updateBehavior: "REPLACEMENT" as const },
      Value: { valueType: "string" as const, updateBehavior: "MUTABLE" as const },
    },
    ref: { supported: true, valueType: "string" as const },
    attributes: { Arn: { valueType: "string" as const } },
    replacement: { defaultOrder: "CREATE_BEFORE_DELETE" as const },
    retention: { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, updateReplacePolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, snapshotSupported: false },
    tags: { behavior: "NONE" as const, propagatesCloudFormationTags: false },
  };
  const model = (physicalId: string, properties: FakeModel): ProviderReadModel<FakeModel> => ({ physicalId, properties: { ...properties }, attributes: { Arn: `arn:test:${physicalId}` } });
  const provider: TestOnlyResourceProvider<FakeModel> = {
    typeName: schema.typeName, providerVersion: 1, visibility: "test-only", schema,
    validate(properties) { return validateDeclaredProperties(properties, schema); },
    canonicalize(properties) { return { ...(properties as FakeModel) }; },
    plan(previous, desired): ProviderPlan<FakeModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired), replacementProperties: [] };
      if (previous.Name !== desired.Name) return { action: "REPLACE", desired, changedProperties: ["Name"], replacementProperties: ["Name"], replacementOrder: desired.Name.startsWith("delete-first") ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE" };
      if (previous.Value !== desired.Value) return { action: "UPDATE", desired, changedProperties: ["Value"], replacementProperties: [] };
      return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired, context) {
      calls.push(`create:${desired.Name}:${context.callbackContext ? "callback" : "initial"}`);
      const physicalId = ids.get(context.idempotencyKey) ?? `${desired.Name}-${++counter}`; ids.set(context.idempotencyKey, physicalId);
      if (stuckNames.has(desired.Name)) { resources.set(physicalId, { ...desired }); return { status: "IN_PROGRESS", callbackAfterMs: 100, checkpoint: { schemaVersion: 1, callbackContext: { ready: false }, physicalId } }; }
      if (delayedNames.has(desired.Name) && !context.callbackContext) return { status: "IN_PROGRESS", callbackAfterMs: 100, checkpoint: { schemaVersion: 1, callbackContext: { ready: true }, physicalId } };
      if (failedCreates.has(desired.Name)) return { status: "FAILED", errorCode: "InjectedFailure", message: `create ${desired.Name} failed` };
      resources.set(physicalId, { ...desired }); return { status: "SUCCESS", physicalId, model: model(physicalId, desired) };
    },
    async read(physicalId) { const found = resources.get(physicalId); return found ? { status: "SUCCESS", physicalId, model: model(physicalId, found) } : { status: "NOT_FOUND", physicalId }; },
    async update(physicalId, _previous, desired, context) {
      calls.push(`update:${desired.Name}:${desired.Value ?? ""}:${context.idempotencyKey}`);
      if (failRollbackUpdates && context.idempotencyKey.includes(":rollback-")) return { status: "FAILED", errorCode: "InjectedRollbackFailure", message: "rollback update failed" };
      if (!resources.has(physicalId)) return { status: "FAILED", errorCode: "NotFound", message: physicalId };
      resources.set(physicalId, { ...desired });
      if (desired.Value === "partial-fail" && !context.idempotencyKey.includes(":rollback-")) return { status: "FAILED", errorCode: "InjectedPartialFailure", message: "update failed after mutation" };
      return { status: "SUCCESS", physicalId, model: model(physicalId, desired) };
    },
    async delete(physicalId, previous, context) { calls.push(`delete:${previous.Name}:${context.idempotencyKey}`); resources.delete(physicalId); return { status: "SUCCESS", physicalId }; },
    ref(value) { return value.physicalId; },
    getAtt(value, attribute) { if (attribute !== "Arn") throw new Error(attribute); return value.attributes.Arn; },
  };
  return { provider, resources, calls, delayedNames, stuckNames, failedCreates, setFailRollbackUpdates(value: boolean) { failRollbackUpdates = value; } };
}

async function harness(root: string, fake: ReturnType<typeof fakeProvider>, clock: Clock = new SystemClock()) {
  const store = new StateStore(root, "000000000000", region); await store.load(); const s3 = new S3Service(store, region, clock); await s3.start(); const cloudformation = new CloudFormationService(store, region, clock, s3); const overlay = new CloudFormationTestProviderRegistry(createDefaultCloudFormationProviderRegistry(), [fake.provider]);
  (cloudformation as any).providers = { get: (typeName: string) => overlay.resolveForTest(typeName), require: (typeName: string) => overlay.requireForTest(typeName) };
  await cloudformation.start(); return { store, cloudformation };
}

function template(resources: Record<string, { Properties: FakeModel; DependsOn?: string; DeletionPolicy?: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot"; UpdateReplacePolicy?: "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot" }>, outputs?: Record<string, unknown>): string {
  return JSON.stringify({ Resources: Object.fromEntries(Object.entries(resources).map(([logicalId, value]) => [logicalId, { Type: "Test::Lifecycle::Resource", ...value }])), ...(outputs ? { Outputs: outputs } : {}) });
}

async function waitForStatus(service: CloudFormationService, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) { const status = (await service.DescribeStacks({ StackName: stackName })).Stacks[0].StackStatus; if (status === expected) return; await new Promise<void>(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${expected}`);
}

test("provider callback checkpoints survive executor restart without repeating the initial mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-executor-")); const fake = fakeProvider(); fake.delayedNames.add("delayed"); const clock = new TestClock(10_000); let first: Awaited<ReturnType<typeof harness>> | undefined; let restarted: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    first = await harness(root, fake, clock); const created = await first.cloudformation.CreateStack({ StackName: "callback-stack", TemplateBody: template({ Resource: { Properties: { Name: "delayed" } } }) }, principal);
    for (let attempt = 0; attempt < 200 && fake.calls.length < 1; attempt += 1) await new Promise<void>(resolve => setTimeout(resolve, 5)); assert.deepEqual(fake.calls, ["create:delayed:initial"]); await first.cloudformation.stop(); const crashedOperation = first.store.regionState(region).cloudformation.stacks[created.StackId].activeOperation!; crashedOperation.leaseOwner = "crashed-executor"; crashedOperation.leaseExpiresAt = clock.now() + 200; await first.store.save(); first = undefined;
    restarted = await harness(root, fake, clock); for (let attempt = 0; attempt < 10; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(fake.calls.length, 1, "restart must honor the persisted executor lease"); clock.advance(100); for (let attempt = 0; attempt < 10; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(fake.calls.length, 1, "an unexpired lease must prevent callback takeover even after provider resumeAfter"); clock.advance(100); await waitForStatus(restarted.cloudformation, created.StackId, "CREATE_COMPLETE"); assert.deepEqual(fake.calls, ["create:delayed:initial", "create:delayed:callback"]); assert.equal(fake.resources.size, 1);
  } finally { await first?.cloudformation.stop().catch(() => undefined); await restarted?.cloudformation.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("create rollback deletes a provisional physical resource that times out while still IN_PROGRESS", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-provisional-create-")); const fake = fakeProvider(); fake.stuckNames.add("stuck-create"); const clock = new TestClock(50_000); const h = await harness(root, fake, clock);
  try {
    const created = await h.cloudformation.CreateStack({ StackName: "provisional-create", TemplateBody: template({ Resource: { Properties: { Name: "stuck-create" } } }) }, principal);
    let inProgress = h.store.regionState(region).cloudformation.stacks[created.StackId].resources.Resource;
    for (let attempt = 0; attempt < 400 && (!inProgress?.physicalResourceId || !(h.cloudformation as any).resumeTimers.size); attempt += 1) { await new Promise<void>(resolve => setTimeout(resolve, 5)); inProgress = h.store.regionState(region).cloudformation.stacks[created.StackId].resources.Resource; }
    assert.ok(inProgress, "the create intent must be present before the provider deadline is advanced");
    assert.match(inProgress.physicalResourceId ?? "", /^stuck-create-/, "the provider checkpoint physical ID must be copied into durable stack state");
    assert.equal(fake.resources.size, 1);
    clock.advance(15 * 60_000 + 1);
    await waitForStatus(h.cloudformation, created.StackId, "ROLLBACK_COMPLETE");
    assert.equal(fake.resources.size, 0, "rollback must delete the physical resource created before stabilization timed out");
    assert.equal(fake.calls.filter(call => call.startsWith("delete:stuck-create:")).length, 1);
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("an update-added resource resumes provider callbacks without requiring a prior snapshot model", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-update-create-callback-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    const created = await h.cloudformation.CreateStack({ StackName: "update-create-callback", TemplateBody: template({ Existing: { Properties: { Name: "existing" } } }) }, principal);
    await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE");
    fake.delayedNames.add("delayed-update-create"); fake.calls.length = 0;
    await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Existing: { Properties: { Name: "existing" } }, Added: { DependsOn: "Existing", Properties: { Name: "delayed-update-create" } } }) }, principal);
    await waitForStatus(h.cloudformation, created.StackId, "UPDATE_COMPLETE");
    assert.deepEqual(fake.calls, ["create:delayed-update-create:initial", "create:delayed-update-create:callback"]);
    assert.deepEqual([...fake.resources.values()].sort((left, right) => left.Name.localeCompare(right.Name)), [{ Name: "delayed-update-create" }, { Name: "existing" }]);
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("replacement ordering is deterministic and update rollback compensates real provider mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-replacement-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    const created = await h.cloudformation.CreateStack({ StackName: "replacement-stack", TemplateBody: template({ Primary: { Properties: { Name: "old", Value: "v1" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE"); fake.calls.length = 0;
    await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Primary: { Properties: { Name: "new", Value: "v2" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_COMPLETE"); assert.match(fake.calls[0], /^create:new:/); assert.match(fake.calls[1], /^delete:old:/);
    fake.calls.length = 0; await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Primary: { Properties: { Name: "delete-first-name", Value: "v3" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_COMPLETE"); assert.match(fake.calls[0], /^delete:new:/); assert.match(fake.calls[1], /^create:delete-first-name:/);
    fake.failedCreates.add("boom"); fake.calls.length = 0; await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Primary: { Properties: { Name: "replacement-before-failure", Value: "v4" } }, Failure: { DependsOn: "Primary", Properties: { Name: "boom" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_COMPLETE"); const models = [...fake.resources.values()]; assert.equal(models.length, 1); assert.deepEqual(models[0], { Name: "delete-first-name", Value: "v3" }); const described = await h.cloudformation.DescribeStackResource({ StackName: created.StackId, LogicalResourceId: "Primary" }); assert.match(described.StackResourceDetail.PhysicalResourceId, /^delete-first-name-/);

    const pair = await h.cloudformation.CreateStack({ StackName: "replacement-pair", TemplateBody: template({ Parent: { Properties: { Name: "old-parent" } }, Child: { DependsOn: "Parent", Properties: { Name: "old-child" } } }) }, principal); await waitForStatus(h.cloudformation, pair.StackId, "CREATE_COMPLETE"); fake.calls.length = 0;
    await h.cloudformation.UpdateStack({ StackName: pair.StackId, TemplateBody: template({ Parent: { Properties: { Name: "new-parent" } }, Child: { DependsOn: "Parent", Properties: { Name: "new-child" } } }) }, principal); await waitForStatus(h.cloudformation, pair.StackId, "UPDATE_COMPLETE");
    assert.deepEqual(fake.calls.map(call => call.split(":").slice(0, 2).join(":")), ["create:new-parent", "create:new-child", "delete:old-child", "delete:old-parent"], "both replacements must cut over before old resources are cleaned up in reverse dependency order");
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("rollback compensates a provider update that mutates before returning failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-partial-update-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    const created = await h.cloudformation.CreateStack({ StackName: "partial-update", TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "v1" } } }) }, principal);
    await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE"); fake.calls.length = 0;
    await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "partial-fail" } } }) }, principal);
    await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_COMPLETE");
    assert.deepEqual([...fake.resources.values()], [{ Name: "primary", Value: "v1" }]);
    assert.equal(fake.calls.filter(call => call.startsWith("update:primary:partial-fail:")).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith("update:primary:v1:")).length, 1, "rollback must compensate the durable in-flight update intent");
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("rollback failure remains truthful and ContinueUpdateRollback can retry or explicitly skip", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-continue-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    const created = await h.cloudformation.CreateStack({ StackName: "continue-stack", TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "v1" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE"); fake.failedCreates.add("boom"); fake.setFailRollbackUpdates(true);
    await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "v2" } }, Failure: { DependsOn: "Primary", Properties: { Name: "boom" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_FAILED"); assert.deepEqual([...fake.resources.values()], [{ Name: "primary", Value: "v2" }]);
    fake.setFailRollbackUpdates(false); await h.cloudformation.ContinueUpdateRollback({ StackName: created.StackId, ClientRequestToken: "continue-one" }); await h.cloudformation.ContinueUpdateRollback({ StackName: created.StackId, ClientRequestToken: "continue-one" }); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_COMPLETE"); assert.deepEqual([...fake.resources.values()], [{ Name: "primary", Value: "v1" }]);

    fake.setFailRollbackUpdates(true); await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "v3" } }, Failure: { DependsOn: "Primary", Properties: { Name: "boom" } } }) }, principal); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_FAILED"); await h.cloudformation.ContinueUpdateRollback({ StackName: created.StackId, ResourcesToSkip: ["Primary"] }); await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_COMPLETE"); assert.deepEqual([...fake.resources.values()], [{ Name: "primary", Value: "v3" }]);
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("DisableRollback preserves a failed update and RollbackStack restores its last stable state with distinct operation IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-explicit-update-rollback-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    const created = await h.cloudformation.CreateStack({ StackName: "explicit-update-rollback", TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "v1" } } }) }, principal);
    assert.equal(typeof created.OperationId, "string");
    await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE");
    fake.failedCreates.add("boom");
    const updated = await h.cloudformation.UpdateStack({ StackName: created.StackId, DisableRollback: true, TemplateBody: template({ Primary: { Properties: { Name: "primary", Value: "v2" } }, Failure: { DependsOn: "Primary", Properties: { Name: "boom" } } }) }, principal);
    assert.equal(typeof updated.OperationId, "string");
    assert.notEqual(updated.OperationId, created.OperationId);
    await waitForStatus(h.cloudformation, created.StackId, "UPDATE_FAILED");
    assert.deepEqual([...fake.resources.values()], [{ Name: "primary", Value: "v2" }]);
    const rolledBack = await h.cloudformation.RollbackStack({ StackName: created.StackId, ClientRequestToken: "explicit-rollback-1" }, principal);
    assert.equal(typeof rolledBack.OperationId, "string");
    assert.notEqual(rolledBack.OperationId, updated.OperationId);
    await waitForStatus(h.cloudformation, created.StackId, "UPDATE_ROLLBACK_COMPLETE");
    assert.deepEqual([...fake.resources.values()], [{ Name: "primary", Value: "v1" }]);
    const events = (await h.cloudformation.DescribeStackEvents({ StackName: created.StackId })).StackEvents;
    assert.ok(events.some((event: any) => event.OperationId === created.OperationId));
    assert.ok(events.some((event: any) => event.OperationId === updated.OperationId));
    assert.ok(events.some((event: any) => event.OperationId === rolledBack.OperationId));
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("RetainExceptOnCreate overrides Retain only for rollback-created resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-retain-except-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    fake.failedCreates.add("boom-one");
    const retained = await h.cloudformation.CreateStack({ StackName: "retained-create", TemplateBody: template({ Kept: { DeletionPolicy: "Retain", Properties: { Name: "kept-one" } }, Failure: { DependsOn: "Kept", Properties: { Name: "boom-one" } } }) }, principal);
    await waitForStatus(h.cloudformation, retained.StackId, "ROLLBACK_COMPLETE");
    assert.ok([...fake.resources.values()].some(value => value.Name === "kept-one"));

    fake.failedCreates.add("boom-two");
    const removed = await h.cloudformation.CreateStack({ StackName: "removed-create", RetainExceptOnCreate: true, TemplateBody: template({ Kept: { DeletionPolicy: "Retain", Properties: { Name: "kept-two" } }, Failure: { DependsOn: "Kept", Properties: { Name: "boom-two" } } }) }, principal);
    await waitForStatus(h.cloudformation, removed.StackId, "ROLLBACK_COMPLETE");
    assert.ok(![...fake.resources.values()].some(value => value.Name === "kept-two"));

    fake.failedCreates.add("boom-three");
    const manual = await h.cloudformation.CreateStack({ StackName: "manual-retain-except", DisableRollback: true, TemplateBody: template({ Kept: { DeletionPolicy: "Retain", Properties: { Name: "kept-three" } }, Failure: { DependsOn: "Kept", Properties: { Name: "boom-three" } } }) }, principal);
    await waitForStatus(h.cloudformation, manual.StackId, "CREATE_FAILED");
    await h.cloudformation.RollbackStack({ StackName: manual.StackId, RetainExceptOnCreate: true }, principal);
    await waitForStatus(h.cloudformation, manual.StackId, "ROLLBACK_COMPLETE");
    assert.ok(![...fake.resources.values()].some(value => value.Name === "kept-three"));
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("DeletionPolicy and UpdateReplacePolicy implement the complete non-snapshot matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-policy-matrix-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    for (const policy of ["Delete", "Retain", "RetainExceptOnCreate"] as const) {
      const suffix = policy.toLowerCase();
      const created = await h.cloudformation.CreateStack({ StackName: `replace-${suffix}`, TemplateBody: template({ Resource: { UpdateReplacePolicy: policy, Properties: { Name: `old-${suffix}` } } }) }, principal);
      await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE");
      await h.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template({ Resource: { UpdateReplacePolicy: policy, Properties: { Name: `new-${suffix}` } } }) }, principal);
      await waitForStatus(h.cloudformation, created.StackId, "UPDATE_COMPLETE");
      assert.ok([...fake.resources.values()].some(value => value.Name === `new-${suffix}`), `${policy} replacement lost its new resource`);
      assert.equal([...fake.resources.values()].some(value => value.Name === `old-${suffix}`), policy !== "Delete", `${policy} handled the replaced physical resource incorrectly`);
    }

    const deleted = await h.cloudformation.CreateStack({
      StackName: "deletion-policy-matrix",
      TemplateBody: template({
        DeleteResource: { DeletionPolicy: "Delete", Properties: { Name: "deletion-delete" } },
        RetainResource: { DeletionPolicy: "Retain", Properties: { Name: "deletion-retain" } },
        RetainExceptResource: { DeletionPolicy: "RetainExceptOnCreate", Properties: { Name: "deletion-retain-except" } },
      }),
    }, principal);
    await waitForStatus(h.cloudformation, deleted.StackId, "CREATE_COMPLETE"); await h.cloudformation.DeleteStack({ StackName: deleted.StackId }, principal); await waitForStatus(h.cloudformation, deleted.StackId, "DELETE_COMPLETE");
    assert.equal([...fake.resources.values()].some(value => value.Name === "deletion-delete"), false);
    assert.equal([...fake.resources.values()].some(value => value.Name === "deletion-retain"), true);
    assert.equal([...fake.resources.values()].some(value => value.Name === "deletion-retain-except"), true);

    const callsBeforeSnapshot = fake.calls.length;
    await assert.rejects(h.cloudformation.CreateStack({ StackName: "snapshot-deletion", TemplateBody: template({ Resource: { DeletionPolicy: "Snapshot", Properties: { Name: "snapshot-deletion" } } }) }, principal), /Snapshot.*not supported|does not support.*Snapshot/i);
    await assert.rejects(h.cloudformation.CreateStack({ StackName: "snapshot-replacement", TemplateBody: template({ Resource: { UpdateReplacePolicy: "Snapshot", Properties: { Name: "snapshot-replacement" } } }) }, principal), /Snapshot.*not supported|does not support.*Snapshot/i);
    assert.equal(fake.calls.length, callsBeforeSnapshot, "Snapshot rejection must happen before a provider mutation");
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("a completed provider-mutating update token replays across executor restart without repeating the mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-completed-token-")); const fake = fakeProvider(); let first: Awaited<ReturnType<typeof harness>> | undefined; let restarted: Awaited<ReturnType<typeof harness>> | undefined;
  const initial = template({ Resource: { Properties: { Name: "token-resource", Value: "v1" } } });
  const updated = template({ Resource: { Properties: { Name: "token-resource", Value: "v2" } } });
  try {
    first = await harness(root, fake); const created = await first.cloudformation.CreateStack({ StackName: "completed-token", TemplateBody: initial, ClientRequestToken: "completed-create-token" }, principal); await waitForStatus(first.cloudformation, created.StackId, "CREATE_COMPLETE");
    const accepted = await first.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: updated, ClientRequestToken: "completed-update-token" }, principal); await waitForStatus(first.cloudformation, created.StackId, "UPDATE_COMPLETE");
    assert.equal(fake.calls.filter(call => call.startsWith("update:token-resource:v2:")).length, 1);
    await first.cloudformation.stop(); first = undefined;
    restarted = await harness(root, fake);
    const replayed = await restarted.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: updated, ClientRequestToken: "completed-update-token" }, principal);
    assert.equal(replayed.OperationId, accepted.OperationId); assert.equal(replayed.StackId, accepted.StackId);
    assert.equal(fake.calls.filter(call => call.startsWith("update:token-resource:v2:")).length, 1, "terminal token replay repeated the completed provider update");
    await assert.rejects(restarted.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: initial, ClientRequestToken: "completed-update-token" }, principal), /different request already uses client token|TokenAlreadyExists/i);
  } finally { await first?.cloudformation.stop().catch(() => undefined); await restarted?.cloudformation.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CreateStack OnFailure DELETE removes the failed stack catalog entry and permits a clean retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-on-failure-delete-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    fake.failedCreates.add("delete-boom");
    await assert.rejects(h.cloudformation.CreateStack({ StackName: "invalid-on-failure", DisableRollback: true, OnFailure: "DELETE", TemplateBody: template({}) }, principal), /cannot both be specified/);
    const failed = await h.cloudformation.CreateStack({ StackName: "delete-on-failure", OnFailure: "DELETE", TemplateBody: template({ First: { Properties: { Name: "delete-first" } }, Failure: { DependsOn: "First", Properties: { Name: "delete-boom" } } }) }, principal);
    await waitForStatus(h.cloudformation, failed.StackId, "DELETE_COMPLETE");
    assert.ok(![...fake.resources.values()].some(value => value.Name === "delete-first"));
    const retried = await h.cloudformation.CreateStack({ StackName: "delete-on-failure", TemplateBody: template({ Healthy: { Properties: { Name: "healthy" } } }) }, principal);
    assert.notEqual(retried.StackId, failed.StackId);
    await waitForStatus(h.cloudformation, retried.StackId, "CREATE_COMPLETE");
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});

test("rollback configuration is validated and delete uses reverse dependency order", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-rollback-config-delete-order-")); const fake = fakeProvider(); const h = await harness(root, fake);
  try {
    await assert.rejects(h.cloudformation.CreateStack({ StackName: "invalid-rollback-trigger", RollbackConfiguration: { RollbackTriggers: [{ Arn: "arn:aws:cloudwatch:eu-west-1:000000000000:alarm:test", Type: "AWS::CloudWatch::Alarm" }] }, TemplateBody: template({}) }, principal), /dependency-blocked until CFN-10/);
    const created = await h.cloudformation.CreateStack({ StackName: "delete-order", RollbackConfiguration: { RollbackTriggers: [], MonitoringTimeInMinutes: 10 }, TemplateBody: template({ Parent: { Properties: { Name: "parent" } }, Child: { DependsOn: "Parent", Properties: { Name: "child" } } }) }, principal);
    await waitForStatus(h.cloudformation, created.StackId, "CREATE_COMPLETE");
    const described = (await h.cloudformation.DescribeStacks({ StackName: created.StackId })).Stacks[0];
    assert.deepEqual(described.RollbackConfiguration, { RollbackTriggers: [], MonitoringTimeInMinutes: 10 });
    await assert.rejects(h.cloudformation.DeleteStack({ StackName: created.StackId, RetainResources: ["Parent"] }, principal), /only when retrying a stack in DELETE_FAILED/);
    fake.calls.length = 0;
    await h.cloudformation.DeleteStack({ StackName: created.StackId }, principal);
    await waitForStatus(h.cloudformation, created.StackId, "DELETE_COMPLETE");
    const deleteCalls = fake.calls.filter(call => call.startsWith("delete:"));
    assert.equal(deleteCalls.length, 2);
    assert.match(deleteCalls[0], /^delete:child:/);
    assert.match(deleteCalls[1], /^delete:parent:/);

    const reordered = await h.cloudformation.CreateStack({ StackName: "updated-delete-order", TemplateBody: template({ Child: { Properties: { Name: "existing-child" } } }) }, principal); await waitForStatus(h.cloudformation, reordered.StackId, "CREATE_COMPLETE");
    await h.cloudformation.UpdateStack({ StackName: reordered.StackId, TemplateBody: template({ Parent: { Properties: { Name: "added-parent" } }, Child: { DependsOn: "Parent", Properties: { Name: "existing-child" } } }) }, principal); await waitForStatus(h.cloudformation, reordered.StackId, "UPDATE_COMPLETE"); fake.calls.length = 0;
    await h.cloudformation.UpdateStack({ StackName: reordered.StackId, TemplateBody: template({}) }, principal); await waitForStatus(h.cloudformation, reordered.StackId, "UPDATE_COMPLETE");
    assert.deepEqual(fake.calls.filter(call => call.startsWith("delete:")).map(call => call.split(":")[1]), ["existing-child", "added-parent"], "update removals must use the persisted prior dependency graph, not resource insertion order");
  } finally { await h.cloudformation.stop(); await rm(root, { recursive: true, force: true }); }
});
