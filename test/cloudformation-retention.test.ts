import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFormationService, type CloudFormationRetentionPolicy } from "../src/cloudformation.js";
import { CloudFormationJournal } from "../src/cloudformation/journal.js";
import { TestClock } from "../src/core/clock.js";
import { S3Service } from "../src/s3.js";
import { StateStore } from "../src/state.js";

const accountId = "000000000000";
const region = "eu-west-1";
const principal: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
const retention: CloudFormationRetentionPolicy = {
  historyRetentionMs: 100,
  maxDeletedStacks: 2,
  maxTerminalChangeSets: 2,
  maxTerminalJournalOperations: 2,
  maxStackEvents: 2,
  maxClientTokens: 8,
  maxActiveChangeSetsPerStack: 3,
};

function template(analytics: string, invalidOutput = false): string {
  return JSON.stringify({
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: analytics } } },
    Outputs: { Version: { Value: invalidOutput ? [analytics] : analytics } },
  });
}

async function harness(root: string, clock: TestClock) {
  const store = new StateStore(root, accountId, region); await store.load();
  const s3 = new S3Service(store, region, clock); await s3.start();
  const cloudformation = new CloudFormationService(store, region, clock, s3, undefined, [], undefined, retention);
  await cloudformation.start();
  return { store, cloudformation };
}

async function waitForStack(service: CloudFormationService, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = (await service.DescribeStacks({ StackName: stackName })).Stacks[0].StackStatus;
    if (status === expected) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test("retention preserves failed update rollback roots across clock advance and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-retention-rollback-"));
  const clock = new TestClock(10_000);
  let first: Awaited<ReturnType<typeof harness>> | undefined;
  let restarted: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    first = await harness(root, clock);
    const created = await first.cloudformation.CreateStack({ StackName: "retained-rollback", TemplateBody: template("v1") }, principal);
    await waitForStack(first.cloudformation, created.StackId, "CREATE_COMPLETE");
    await first.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template("v2", true), DisableRollback: true }, principal);
    await waitForStack(first.cloudformation, created.StackId, "UPDATE_FAILED");
    await first.cloudformation.stop();

    const failed = first.store.regionState(region).cloudformation.stacks[created.StackId];
    const sourceOperationId = failed.activeOperation!.operationId;
    const desiredArtifactId = failed.activeOperation!.desiredTemplateArtifactId!;
    const journal = new CloudFormationJournal(root, accountId, region); await journal.start();
    assert.ok(await journal.readJsonArtifact("rollback", `${sourceOperationId}.snapshot.json`));
    assert.ok(await journal.readJsonArtifact("operations", `${sourceOperationId}.mutations.json`));
    assert.ok(await journal.readTemplate(desiredArtifactId, "processed"));

    clock.advance(retention.historyRetentionMs + 1);
    first = undefined;
    restarted = await harness(root, clock);
    assert.equal((await restarted.cloudformation.DescribeStacks({ StackName: created.StackId })).Stacks[0].StackStatus, "UPDATE_FAILED");
    assert.ok(await journal.readJsonArtifact("rollback", `${sourceOperationId}.snapshot.json`), "restart retention must preserve the rollback snapshot");
    assert.ok(await journal.readJsonArtifact("operations", `${sourceOperationId}.mutations.json`), "restart retention must preserve the mutation ledger");

    await restarted.cloudformation.RollbackStack({ StackName: created.StackId }, principal);
    await waitForStack(restarted.cloudformation, created.StackId, "UPDATE_ROLLBACK_COMPLETE");
    await restarted.cloudformation.stop();
    assert.match(String((await restarted.cloudformation.GetTemplate({ StackName: created.StackId })).TemplateBody), /v1/);
    assert.equal(await journal.readJsonArtifact("rollback", `${sourceOperationId}.snapshot.json`), undefined, "completed rollback source should become reclaimable");
    assert.equal(await journal.readTemplate(desiredArtifactId, "processed"), undefined, "failed candidate template should become reclaimable");
  } finally {
    await first?.cloudformation.stop().catch(() => undefined);
    await restarted?.cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("maintenance admission cannot sweep an update candidate before its catalog checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-retention-admission-"));
  const clock = new TestClock(15_000);
  const current = await harness(root, clock);
  try {
    const created = await current.cloudformation.CreateStack({ StackName: "retention-admission", TemplateBody: template("v1") }, principal);
    await waitForStack(current.cloudformation, created.StackId, "CREATE_COMPLETE");

    const journal = (current.cloudformation as any).journal as CloudFormationJournal;
    const replaceJsonArtifact = journal.replaceJsonArtifact.bind(journal);
    let candidateReady!: () => void;
    let releaseCandidate!: () => void;
    const ready = new Promise<void>(resolve => { candidateReady = resolve; });
    const release = new Promise<void>(resolve => { releaseCandidate = resolve; });
    (journal as any).replaceJsonArtifact = async (collection: string, artifactId: string, value: unknown) => {
      await replaceJsonArtifact(collection, artifactId, value);
      if (collection === "plans" && artifactId.endsWith(".stack.json")) { candidateReady(); await release; }
    };

    const updating = current.cloudformation.UpdateStack({ StackName: created.StackId, TemplateBody: template("v2") }, principal);
    await ready;
    await (current.cloudformation as any).maintainPersistenceRetention();
    releaseCandidate();
    await updating;
    await waitForStack(current.cloudformation, created.StackId, "UPDATE_COMPLETE");
    assert.match(String((await current.cloudformation.GetTemplate({ StackName: created.StackId })).TemplateBody), /v2/);
  } finally {
    await current.cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("retention bounds deleted catalogs while preserving live change sets and stack tombstones until expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-retention-catalog-"));
  const clock = new TestClock(20_000);
  let current: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    current = await harness(root, clock);
    const created = await current.cloudformation.CreateStack({ StackName: "catalog-retention", TemplateBody: template("v1"), ClientRequestToken: "create-v1" }, principal);
    await waitForStack(current.cloudformation, created.StackId, "CREATE_COMPLETE");

    const available = await current.cloudformation.CreateChangeSet({ StackName: created.StackId, ChangeSetName: "available", ChangeSetType: "UPDATE", TemplateBody: template("v2"), ClientToken: "available-token" }, principal);
    const failed = await current.cloudformation.CreateChangeSet({ StackName: created.StackId, ChangeSetName: "failed", ChangeSetType: "UPDATE", UsePreviousTemplate: true, ClientToken: "failed-token" }, principal);
    assert.equal((await current.cloudformation.DescribeChangeSet({ ChangeSetName: available.Id })).Status, "CREATE_COMPLETE");
    assert.equal((await current.cloudformation.DescribeChangeSet({ ChangeSetName: failed.Id })).Status, "FAILED");

    const deleted = await current.cloudformation.CreateChangeSet({ StackName: created.StackId, ChangeSetName: "deleted", ChangeSetType: "UPDATE", TemplateBody: template("v3"), ClientToken: "deleted-token" }, principal);
    const deletedArtifactId = current.store.regionState(region).cloudformation.changeSets[deleted.Id].templateArtifactId!;
    const beforeQuotaArtifacts = await (current.cloudformation as any).journal.listArtifacts("change-sets");
    await assert.rejects(
      current.cloudformation.CreateChangeSet({ StackName: created.StackId, ChangeSetName: "over-quota", ChangeSetType: "UPDATE", TemplateBody: template("v4") }, principal),
      (error: any) => error.code === "LimitExceededException",
    );
    assert.deepEqual(await (current.cloudformation as any).journal.listArtifacts("change-sets"), beforeQuotaArtifacts, "quota rejection must occur before artifact admission");
    await current.cloudformation.DeleteChangeSet({ ChangeSetName: deleted.Id });

    await current.cloudformation.stop(); current = undefined;
    clock.advance(retention.historyRetentionMs + 1);
    current = await harness(root, clock);
    const catalog = current.store.regionState(region).cloudformation;
    assert.ok(catalog.changeSets[available.Id], "available change sets remain user-addressable");
    assert.ok(catalog.changeSets[failed.Id], "failed change sets remain until explicitly deleted");
    assert.equal(catalog.changeSets[deleted.Id], undefined, "deleted change-set tombstone expires");
    assert.equal(await (current.cloudformation as any).journal.readJsonArtifact("change-sets", `${deletedArtifactId}.input.json`), undefined);
    assert.match(String((await current.cloudformation.GetTemplate({ ChangeSetName: available.Id, StackName: created.StackId })).TemplateBody), /v2/);

    const oldTemplateArtifactId = catalog.stacks[created.StackId].templateArtifactId!;
    await current.cloudformation.DeleteStack({ StackName: created.StackId, ClientRequestToken: "delete-v1" }, principal);
    await waitForStack(current.cloudformation, created.StackId, "DELETE_COMPLETE");
    assert.match(String((await current.cloudformation.GetTemplate({ StackName: created.StackId })).TemplateBody), /v1/);
    const replacement = await current.cloudformation.CreateStack({ StackName: "catalog-retention", TemplateBody: template("replacement"), ClientRequestToken: "create-v2" }, principal);
    await waitForStack(current.cloudformation, replacement.StackId, "CREATE_COMPLETE");
    const recentEvents = current.store.regionState(region).cloudformation.stacks[replacement.StackId].events.length;
    assert.ok(recentEvents > retention.maxStackEvents, "the current operation's complete event set is protected while recent");

    await current.cloudformation.stop(); current = undefined;
    clock.advance(retention.historyRetentionMs + 1);
    current = await harness(root, clock);
    await assert.rejects(current.cloudformation.DescribeStacks({ StackName: created.StackId }), /does not exist/);
    assert.equal((await current.cloudformation.DescribeStacks({ StackName: replacement.StackId })).Stacks[0].StackStatus, "CREATE_COMPLETE");
    assert.ok(current.store.regionState(region).cloudformation.stacks[replacement.StackId].events.length <= retention.maxStackEvents);
    assert.equal(await (current.cloudformation as any).journal.readTemplate(oldTemplateArtifactId, "processed"), undefined);
    assert.match(String((await current.cloudformation.GetTemplate({ StackName: replacement.StackId })).TemplateBody), /replacement/);
  } finally {
    await current?.cloudformation.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
