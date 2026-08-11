import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFormationService } from "../src/cloudformation.js";
import { SystemClock, TestClock } from "../src/core/clock.js";
import { S3Service } from "../src/s3.js";
import { StateStore } from "../src/state.js";

const accountId = "000000000000";
const region = "eu-west-1";
const principal: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
const template = JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "recovery" } } } });

async function harness(root: string) {
  const store = new StateStore(root, accountId, region);
  await store.load();
  const clock = new SystemClock();
  const s3 = new S3Service(store, region, clock);
  await s3.start();
  const cloudformation = new CloudFormationService(store, region, clock, s3);
  await cloudformation.start();
  return { store, cloudformation };
}

async function waitForStack(service: CloudFormationService, stackName: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await service.DescribeStacks({ StackName: stackName })).Stacks[0].StackStatus === status) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

test("CREATE_IN_PROGRESS change-set planning resumes from its immutable request after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-change-set-plan-recovery-"));
  let first: Awaited<ReturnType<typeof harness>> | undefined;
  let restarted: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    first = await harness(root);
    (first.cloudformation as any).resumeChangeSetPlanning = async () => { throw new Error("injected process exit after planning acceptance"); };
    await assert.rejects(first.cloudformation.CreateChangeSet({ StackName: "planning-recovery", ChangeSetName: "initial", ChangeSetType: "CREATE", ClientToken: "planning-token", TemplateBody: template }, principal), /injected process exit/);
    const accepted = Object.values(first.store.regionState(region).cloudformation.changeSets)[0];
    assert.equal(accepted.status, "CREATE_IN_PROGRESS");
    assert.equal(accepted.executionStatus, "UNAVAILABLE");
    await first.cloudformation.stop(); first = undefined;

    restarted = await harness(root);
    const recovered = await restarted.cloudformation.DescribeChangeSet({ ChangeSetName: accepted.changeSetId });
    assert.equal(recovered.Status, "CREATE_COMPLETE");
    assert.equal(recovered.ExecutionStatus, "AVAILABLE");
    assert.equal(recovered.Changes[0].ResourceChange.Action, "Add");
    const retry = await restarted.cloudformation.CreateChangeSet({ StackName: "planning-recovery", ChangeSetName: "initial", ChangeSetType: "CREATE", ClientToken: "planning-token", TemplateBody: template }, principal);
    assert.equal(retry.Id, accepted.changeSetId);
  } finally {
    await first?.cloudformation.stop().catch(() => undefined);
    await restarted?.cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an executed change set relinks the accepted stack operation after the catalog-save crash window", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-change-set-execute-recovery-"));
  let first: Awaited<ReturnType<typeof harness>> | undefined;
  let restarted: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    first = await harness(root);
    const planned = await first.cloudformation.CreateChangeSet({ StackName: "execution-recovery", ChangeSetName: "initial", ChangeSetType: "CREATE", TemplateBody: template }, principal);
    assert.equal((await first.cloudformation.DescribeChangeSet({ ChangeSetName: planned.Id })).Status, "CREATE_COMPLETE");

    // Freeze background execution and fail both the link save and its catch
    // save. The state file is then exactly at the boundary where CreateStack
    // is durable but executionOperationId is not.
    (first.cloudformation as any).schedule = () => undefined;
    const durableSave = first.store.save.bind(first.store);
    let saves = 0;
    (first.store as any).save = async () => {
      saves += 1;
      if (saves >= 3) throw new Error("injected process exit before change-set link save");
      await durableSave();
    };
    await assert.rejects(first.cloudformation.ExecuteChangeSet({ ChangeSetName: planned.Id, ClientRequestToken: "execute-recovery-token" }, principal), /injected process exit/);
    // Model a process exit: stop releases in-memory timers, but the injected
    // state-store failure must remain in place so no later shutdown save can
    // persist state from beyond the tested durable boundary.
    await first.cloudformation.stop().catch(() => undefined); first = undefined;

    const persisted = new StateStore(root, accountId, region);
    await persisted.load();
    const stranded = persisted.regionState(region).cloudformation.changeSets[planned.Id];
    assert.equal(stranded.executionStatus, "AVAILABLE");
    assert.equal(stranded.executionClientToken, "execute-recovery-token");
    assert.equal(stranded.executionOperationId, undefined);
    assert.equal(persisted.regionState(region).cloudformation.stacks[planned.StackId].activeOperation?.status, "PENDING");

    // A crashed executor cannot release its durable lease. Restart after the
    // recorded expiry to prove normal lease takeover and change-set relinking.
    const leaseExpiresAt = persisted.regionState(region).cloudformation.stacks[planned.StackId].activeOperation?.leaseExpiresAt ?? Date.now();
    const clock = new TestClock(leaseExpiresAt + 1);
    const s3 = new S3Service(persisted, region, clock); await s3.start();
    const cloudformation = new CloudFormationService(persisted, region, clock, s3); await cloudformation.start();
    restarted = { store: persisted, cloudformation };
    const linked = persisted.regionState(region).cloudformation.changeSets[planned.Id];
    assert.ok(linked.executionOperationId);
    assert.ok(linked.executionStatus === "EXECUTE_IN_PROGRESS" || linked.executionStatus === "EXECUTE_COMPLETE");
    await waitForStack(cloudformation, planned.StackId, "CREATE_COMPLETE");
    assert.equal((await cloudformation.DescribeChangeSet({ ChangeSetName: planned.Id })).ExecutionStatus, "EXECUTE_COMPLETE");
    await cloudformation.ExecuteChangeSet({ ChangeSetName: planned.Id, ClientRequestToken: "execute-recovery-token" }, principal);
    assert.equal((await cloudformation.ListStackResources({ StackName: planned.StackId })).StackResourceSummaries.length, 1);
  } finally {
    await first?.cloudformation.stop().catch(() => undefined);
    await restarted?.cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
