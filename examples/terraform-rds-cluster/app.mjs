import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  BatchExecuteStatementCommand, BeginTransactionCommand, CommitTransactionCommand,
  ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";

// Run in the directory containing the applied Terraform fixture.
const outputs = JSON.parse(execFileSync("terraform", ["output", "-json"], { encoding: "utf8" }));
const target = { database: outputs.database.value, resourceArn: outputs.cluster_arn.value, secretArn: outputs.secret_arn.value };
const client = new RDSDataClient({ region: target.resourceArn.split(":")[3], endpoint: outputs.sdk_endpoint.value });
const run = randomUUID();
const runParam = { name: "run", value: { stringValue: run } };
const noteParams = note => [runParam, { name: "note", value: { stringValue: note } }];
const insert = "INSERT INTO app_notes (run_id, note) VALUES (:run, :note)";
const execute = (sql, parameters = [], transactionId) =>
  client.send(new ExecuteStatementCommand({ ...target, sql, parameters, transactionId }));

async function writeTransaction(note, FinishTransaction) {
  const { transactionId } = await client.send(new BeginTransactionCommand(target));
  try {
    await execute(insert, noteParams(note), transactionId);
    await client.send(new FinishTransaction({ ...target, transactionId }));
  } catch (error) {
    await client.send(new RollbackTransactionCommand({ ...target, transactionId })).catch(() => {});
    throw error;
  }
}

try {
  await execute("CREATE TABLE IF NOT EXISTS app_notes (id INT AUTO_INCREMENT PRIMARY KEY, run_id VARCHAR(36) NOT NULL, note VARCHAR(128) NOT NULL)");
  await client.send(new BatchExecuteStatementCommand({
    ...target, sql: insert, parameterSets: [noteParams("draft"), noteParams("discard")],
  }));
  await execute("UPDATE app_notes SET note = :next WHERE run_id = :run AND note = :note",
    [...noteParams("draft"), { name: "next", value: { stringValue: "published" } }]);
  await execute("DELETE FROM app_notes WHERE run_id = :run AND note = :note", noteParams("discard"));
  await writeTransaction("committed", CommitTransactionCommand);
  await writeTransaction("rolled back", RollbackTransactionCommand);
  const result = await execute("SELECT note FROM app_notes WHERE run_id = :run ORDER BY id", [runParam]);
  assert.deepEqual(result.records?.map(row => row[0].stringValue), ["published", "committed"]);
  console.log(JSON.stringify({ run, notes: result.records.map(row => row[0].stringValue) }));
} finally { client.destroy(); }
