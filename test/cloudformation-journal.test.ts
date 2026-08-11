import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationJournal,
  CloudFormationJournalCorruptionError,
  type CloudFormationJournalEntry,
} from "../src/cloudformation/journal.js";

const ACCOUNT_ID = "111122223333";
const REGION = "eu-west-1";

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cloudformation-journal-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CloudFormation journal serializes concurrent appends and restarts in deterministic order", async () => {
  await withTemporaryRoot(async root => {
    const journal = new CloudFormationJournal<{ index: number }>(root, ACCOUNT_ID, REGION);
    const appended = await Promise.all(Array.from({ length: 40 }, (_, index) => journal.append({
      operationId: `operation-${index}`,
      payload: { index },
    })));

    assert.deepEqual(appended.map(entry => entry.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.deepEqual((await journal.readAll()).map(entry => entry.payload.index), Array.from({ length: 40 }, (_, index) => index));
    assert.equal(
      journal.directory,
      join(root, "data", "cloudformation", ACCOUNT_ID, REGION),
    );
    assert.ok((await readFile(journal.journalPath, "utf8")).endsWith("\n"));

    const restarted = new CloudFormationJournal<{ index: number }>(root, ACCOUNT_ID, REGION);
    const restored = await restarted.readAll();
    assert.deepEqual(restored.map(entry => entry.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal((await restarted.append("after-restart", { index: 40 })).sequence, 41);
  });
});

test("CloudFormation journal truncates only a partial trailing JSONL record before later appends", async () => {
  await withTemporaryRoot(async root => {
    const first = new CloudFormationJournal<{ checkpoint: string }>(root, ACCOUNT_ID, REGION);
    await first.append("deploy", { checkpoint: "accepted" });
    await first.append("deploy", { checkpoint: "resource-created" });
    await appendFile(first.journalPath, "{\"version\":1,\"sequence\":3,\"operationId\":\"deploy\"", "utf8");

    const recovered = new CloudFormationJournal<{ checkpoint: string }>(root, ACCOUNT_ID, REGION);
    await recovered.start();
    assert.deepEqual((await recovered.readAll()).map(entry => entry.payload.checkpoint), ["accepted", "resource-created"]);
    const terminal = await recovered.append("deploy", { checkpoint: "complete" }, { terminal: true });
    assert.equal(terminal.sequence, 3);

    const bytes = await readFile(recovered.journalPath, "utf8");
    assert.ok(bytes.endsWith("\n"));
    assert.doesNotMatch(bytes, /\"sequence\":3,\"operationId\":\"deploy\"$/);
    assert.equal(bytes.trimEnd().split("\n").length, 3);
  });
});

test("CloudFormation journal reports newline-terminated corruption instead of hiding it", async () => {
  await withTemporaryRoot(async root => {
    const journal = new CloudFormationJournal(root, ACCOUNT_ID, REGION);
    await mkdir(dirname(journal.journalPath), { recursive: true });
    await writeFile(journal.journalPath, "{\"not\":\"a journal entry\"}\n", "utf8");

    await assert.rejects(
      journal.start(),
      (error: unknown) => error instanceof CloudFormationJournalCorruptionError
        && error.line === 1
        && /schema v1/.test(error.message),
    );
  });
});

test("CloudFormation journal compacts completed operations and preserves every active checkpoint", async () => {
  await withTemporaryRoot(async root => {
    const journal = new CloudFormationJournal<{ checkpoint: string }>(root, ACCOUNT_ID, REGION);
    await journal.append("done", { checkpoint: "accepted" });                    // 1
    await journal.append("active", { checkpoint: "accepted" });                  // 2
    await journal.append("done", { checkpoint: "provider-created" });             // 3
    await journal.append("other-done", { checkpoint: "accepted" });               // 4
    await journal.append("active", { checkpoint: "provider-created" });            // 5
    await journal.append("done", { checkpoint: "complete" }, { terminal: true }); // 6
    await journal.append("other-done", { checkpoint: "failed" }, { terminal: true }); // 7

    assert.deepEqual(await journal.compactTerminalOperations(), {
      recordsBefore: 7,
      recordsAfter: 4,
      recordsRemoved: 3,
      activeOperations: 1,
      terminalOperations: 2,
    });

    const retained = await journal.readAll();
    assert.deepEqual(retained.map(entry => entry.sequence), [2, 5, 6, 7]);
    assert.deepEqual(
      retained.filter(entry => entry.operationId === "active").map(entry => entry.payload.checkpoint),
      ["accepted", "provider-created"],
    );
    assert.deepEqual(
      retained.filter(entry => entry.operationId === "done").map(entry => entry.payload.checkpoint),
      ["complete"],
    );

    const restarted = new CloudFormationJournal<{ checkpoint: string }>(root, ACCOUNT_ID, REGION);
    assert.equal((await restarted.append("new", { checkpoint: "accepted" })).sequence, 8);
  });
});

test("CloudFormation journal bounds terminal operation tails without losing active or protected recovery roots", async () => {
  await withTemporaryRoot(async root => {
    const journal = new CloudFormationJournal<{ checkpoint: string }>(root, ACCOUNT_ID, REGION);
    await journal.append("old-protected", { checkpoint: "started" });
    await journal.append("old-protected", { checkpoint: "failed" }, { terminal: true });
    await journal.append("old-unreferenced", { checkpoint: "complete" }, { terminal: true });
    await journal.append("active", { checkpoint: "accepted" });
    await journal.append("active", { checkpoint: "provider-intent" });
    await journal.append("newest", { checkpoint: "complete" }, { terminal: true });

    const compacted = await journal.compactTerminalOperations({
      retainTerminalOperations: 2,
      preserveOperationIds: ["old-protected"],
    });
    assert.equal(compacted.recordsBefore, 6);
    assert.equal(compacted.recordsAfter, 4);
    assert.deepEqual((await journal.readAll()).map(entry => entry.operationId), [
      "old-protected",
      "active",
      "active",
      "newest",
    ]);

    const restarted = new CloudFormationJournal<{ checkpoint: string }>(root, ACCOUNT_ID, REGION);
    assert.equal((await restarted.append("after-restart", { checkpoint: "accepted" })).sequence, 7);
  });
});

test("CloudFormation journal atomically replaces templates and artifacts", async () => {
  await withTemporaryRoot(async root => {
    const journal = new CloudFormationJournal(root, ACCOUNT_ID, REGION);
    await journal.replaceArtifact("plans", "z-plan.json", "old");
    await journal.replaceArtifact("plans", "z-plan.json", "new");
    await journal.replaceJsonArtifact("plans", "a-plan.json", { operations: ["create"] });
    await journal.replaceTemplate("stack-a-v1", "{\"Resources\":{}}", "processed");

    assert.equal((await journal.readArtifact("plans", "z-plan.json"))?.toString("utf8"), "new");
    assert.deepEqual(await journal.readJsonArtifact("plans", "a-plan.json"), { operations: ["create"] });
    assert.equal(await journal.readTemplate("stack-a-v1", "processed"), "{\"Resources\":{}}");
    assert.deepEqual(await journal.listArtifacts("plans"), ["a-plan.json", "z-plan.json"]);

    assert.equal(await journal.deleteArtifact("plans", "z-plan.json"), true);
    assert.equal(await journal.deleteArtifact("plans", "z-plan.json"), false);
    assert.equal(await journal.deleteArtifacts("plans", ["a-plan.json", "missing.json"]), 1);
    assert.deepEqual(await journal.listArtifacts("plans"), []);

    const planDirectoryEntries = await readdir(dirname(journal.artifactPath("plans", "a-plan.json")));
    assert.equal(planDirectoryEntries.some(name => name.endsWith(".tmp")), false);
  });
});

test("CloudFormation journal rejects identifiers that could escape its regional directory", async () => {
  await withTemporaryRoot(async root => {
    assert.throws(() => new CloudFormationJournal(root, "../../outside", REGION), /accountId/);
    assert.throws(() => new CloudFormationJournal(root, ACCOUNT_ID, "../../outside"), /region/);

    const journal = new CloudFormationJournal(root, ACCOUNT_ID, REGION);
    assert.throws(() => journal.artifactPath("../plans", "safe.json"), /safe path identifier/);
    assert.throws(() => journal.artifactPath("plans", "../outside.json"), /safe path identifier/);
    await assert.rejects(journal.replaceTemplate("..", "{}"), /safe path identifier/);
    assert.equal(await journal.readArtifact("plans", "missing.json"), undefined);
  });
});

test("CloudFormation journal queue remains usable after a rejected record", async () => {
  await withTemporaryRoot(async root => {
    const journal = new CloudFormationJournal<unknown>(root, ACCOUNT_ID, REGION);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await assert.rejects(journal.append("invalid", cyclic), /JSON serializable/);

    const payload = { accepted: true };
    const pending = journal.append("valid", payload);
    payload.accepted = false;
    const valid = await pending;
    assert.equal(valid.sequence, 1);
    assert.deepEqual(valid.payload, { accepted: true });
    assert.deepEqual(
      (await journal.readAll()).map((entry: CloudFormationJournalEntry) => entry.operationId),
      ["valid"],
    );
    await assert.rejects(journal.replaceJsonArtifact("plans", "undefined.json", undefined), /not undefined/);
  });
});
