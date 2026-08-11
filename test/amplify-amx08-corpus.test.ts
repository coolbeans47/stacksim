import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { APPSYNC_REALTIME_LIMITS } from "../src/appsync.js";
import { canonicalTextSha256 } from "./support/frozen-text.js";

const evidence = resolve("test/fixtures/amplify-gen2-data/evidence");
const sha = canonicalTextSha256;

test("AMX-08 freezes the generated realtime corpus without changing AMX-01 or AMX-04 through AMX-07", async () => {
  const manifest = JSON.parse(await readFile(resolve(evidence, "amx08-realtime-manifest.json"), "utf8"));
  for (const [name, digest] of Object.entries(manifest.protectedEvidence)) {
    assert.equal(sha(await readFile(resolve(evidence, name))), digest, `${name} changed after AMX-08`);
  }
  assert.deepEqual(manifest.schema.subscriptionFields.map((field: any) => [field.name, field.mutationLinks, field.authorizationDirectives]), [
    ["onCreateTodo", ["createTodo"], ["aws_api_key", "aws_iam"]],
    ["onDeleteTodo", ["deleteTodo"], ["aws_api_key", "aws_iam"]],
    ["onUpdateTodo", ["updateTodo"], ["aws_api_key", "aws_iam"]],
  ]);
  assert.deepEqual(manifest.protocol.clientMessages, ["connection_init", "start", "stop"]);
  assert.deepEqual(manifest.protocol.serverMessages, ["connection_ack", "connection_error", "start_ack", "data", "ka", "complete", "error"]);
  assert.deepEqual(manifest.limits, {
    connectionsPerRegion: APPSYNC_REALTIME_LIMITS.connectionsPerRegion,
    connectionsPerApi: APPSYNC_REALTIME_LIMITS.connectionsPerApi,
    registrationsPerConnection: APPSYNC_REALTIME_LIMITS.registrationsPerConnection,
    registrationsPerApi: APPSYNC_REALTIME_LIMITS.registrationsPerApi,
    incomingMessageBytes: APPSYNC_REALTIME_LIMITS.incomingMessageBytes,
    outgoingMessageBytes: APPSYNC_REALTIME_LIMITS.outgoingMessageBytes,
    authorizationHeaderBytes: APPSYNC_REALTIME_LIMITS.authorizationHeaderBytes,
    queryBytes: APPSYNC_REALTIME_LIMITS.queryBytes,
    variablesBytes: APPSYNC_REALTIME_LIMITS.variablesBytes,
    documentDepth: APPSYNC_REALTIME_LIMITS.documentDepth,
    documentFields: APPSYNC_REALTIME_LIMITS.documentFields,
    registrationQueueMessages: APPSYNC_REALTIME_LIMITS.registrationQueueMessages,
    registrationQueueBytes: APPSYNC_REALTIME_LIMITS.registrationQueueBytes,
    connectionQueueMessages: APPSYNC_REALTIME_LIMITS.connectionQueueMessages,
    connectionQueueBytes: APPSYNC_REALTIME_LIMITS.connectionQueueBytes,
    fanoutPerMutation: APPSYNC_REALTIME_LIMITS.fanoutPerMutation,
    initializationMs: APPSYNC_REALTIME_LIMITS.initializationMs,
    keepAliveMs: APPSYNC_REALTIME_LIMITS.keepAliveMs,
    idleMs: APPSYNC_REALTIME_LIMITS.idleMs,
    lifetimeMs: APPSYNC_REALTIME_LIMITS.lifetimeMs,
    overflow: manifest.limits.overflow,
  });
  assert.deepEqual(manifest.failureInjection, ["registration-admission", "mutation-completion", "queueing", "socket-send"]);
  assert.ok(manifest.negativeSurface.includes("enhanced subscription filters"));
  assert.ok(manifest.negativeSurface.includes("AppSync Events"));
  assert.ok(manifest.negativeSurface.includes("AMX-09 deployment/output generation"));
});
