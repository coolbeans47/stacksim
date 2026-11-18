import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IAMClient, CreateRoleCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";

test("pipeline service sessions enforce resource-bound trust and persist in the resource account", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-roles-")), sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "enforce", cdkBootstrap: false });
  let iam: IAMClient | undefined;
  try {
    await sim.start(); iam = new IAMClient({ endpoint: `http://127.0.0.1:${sim.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    const accountId = sim.store.accountId, arn = `arn:aws:osis:eu-west-1:${accountId}:pipeline/logs`, roleArn = `arn:aws:iam::${accountId}:role/Pipeline`;
    await iam.send(new CreateRoleCommand({ RoleName: "Pipeline", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": accountId }, ArnEquals: { "aws:SourceArn": arn } } }] }) }));
    const session = await sim.sts.assumeServiceRoleForResource(roleArn, "pipeline-test", "osis-pipelines.amazonaws.com", { accountId, arn });
    assert.equal(session.roleArn, roleArn); assert.ok(sim.store.state.accounts[accountId].iam.sessions[session.accessKeyId].credentialId);
    await assert.rejects(sim.sts.assumeServiceRoleForResource(roleArn, "wrong-source", "osis-pipelines.amazonaws.com", { accountId, arn: arn + "-other" }), { code: "AccessDenied" });
    await assert.rejects(sim.sts.assumeServiceRoleForResource(roleArn, "wrong-service", "lambda.amazonaws.com", { accountId, arn }), { code: "AccessDenied" });
    const other = "111122223333", role = structuredClone(sim.store.state.accounts[accountId].iam.roles.Pipeline);
    role.arn = `arn:aws:iam::${other}:role/Pipeline`; role.assumeRolePolicyDocument = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": other } } }] };
    sim.store.ensureAccount(other).iam.roles.Pipeline = role;
    const second = await sim.sts.assumeServiceRoleForResource(role.arn, "other-pipeline", "osis-pipelines.amazonaws.com", { accountId: other, arn: `arn:aws:osis:eu-west-1:${other}:pipeline/logs` });
    assert.equal(second.accountId, other); assert.equal(second.sessionArn, `arn:aws:sts::${other}:assumed-role/Pipeline/other-pipeline`); assert.ok(sim.store.state.accounts[other].iam.sessions[second.accessKeyId]); assert.equal(sim.store.state.accounts[accountId].iam.sessions[second.accessKeyId], undefined);
    await assert.rejects(sim.sts.assumeServiceRoleForResource(role.arn, "cross-account", "osis-pipelines.amazonaws.com", { accountId, arn }), { code: "AccessDenied" });
  } finally { iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
