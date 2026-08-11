import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { DescribeStateMachineCommand, ListTagsForResourceCommand, SFNClient } from "@aws-sdk/client-sfn";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import {
  createStepFunctionsStateMachineProvider,
  type StepFunctionsStateMachineModel,
} from "../src/cloudformation/providers/step-functions-state-machine.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(callbackContext?: Readonly<Record<string, any>>): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/sfn-provider/stack-id`,
    logicalId: "Workflow",
    operationId: "operation-1",
    resourceOperationId: "resource-operation-1",
    idempotencyKey: "stable-sfn-provider-operation",
    deadlineAt: Date.now() + 60_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity },
  };
}

async function settle(
  invoke: (current: ProviderContext) => Promise<any>,
): Promise<any> {
  let result = await invoke(context());
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 20; attempt++) {
    result = await invoke(context(result.checkpoint.callbackContext));
  }
  return result;
}

test("StateMachine provider validates, substitutes, owns, updates, and deletes authoritative workflows", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-sfn-provider-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials };
    const iam = new IAMClient(options); const sfn = new SFNClient(options); clients.push(iam, sfn);
    const roleArn = (await iam.send(new CreateRoleCommand({
      RoleName: "provider-workflow-role",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    }))).Role!.Arn!;
    const provider = createStepFunctionsStateMachineProvider(simulator.stepfunctions);

    const invalid = provider.validate({
      DefinitionS3Location: { Bucket: "unsupported", Key: "definition.json" },
      RoleArn: roleArn,
      StateMachineType: "EXPRESS",
      LoggingConfiguration: { Level: "ALL" },
    }, context());
    assert(invalid.some(issue => issue.path === "Properties.DefinitionS3Location" && issue.code === "UnsupportedProperty"));
    assert(invalid.some(issue => issue.path === "Properties.StateMachineType" && issue.code === "UnsupportedProperty"));
    assert(invalid.some(issue => issue.path === "Properties.LoggingConfiguration" && issue.code === "UnsupportedProperty"));
    assert.equal(Object.keys(simulator.store.regionState(region).stepFunctions.stateMachines).length, 0);

    const initial = provider.canonicalize({
      StateMachineName: "provider-workflow",
      DefinitionString: JSON.stringify({ StartAt: "Done", States: { Done: { Type: "Pass", Result: "${result}", End: true } } }),
      DefinitionSubstitutions: { result: "created" },
      RoleArn: roleArn,
      Tags: [{ Key: "team", Value: "platform" }],
    }, context());
    assert.match(initial.DefinitionString, /created/);
    const created = await settle(current => provider.create(initial, current));
    assert.equal(created.status, "SUCCESS");
    assert.equal(provider.ref(created.model), `arn:aws:states:${region}:${accountId}:stateMachine:provider-workflow`);
    assert.equal(provider.getAtt(created.model, "Name"), "provider-workflow");
    assert.equal(typeof provider.getAtt(created.model, "StateMachineRevisionId"), "string");
    const direct = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: created.physicalId }));
    assert.match(direct.definition!, /created/);
    const directTags = Object.fromEntries((await sfn.send(new ListTagsForResourceCommand({ resourceArn: created.physicalId }))).tags!.map(tag => [tag.key!, tag.value!]));
    assert.equal(directTags.team, "platform");
    assert.equal(directTags["aws:cloudformation:logical-id"], "Workflow");

    const desired = provider.canonicalize({
      StateMachineName: "provider-workflow",
      Definition: { StartAt: "Done", States: { Done: { Type: "Pass", Result: "updated", End: true } } },
      RoleArn: roleArn,
      Tags: [{ Key: "team", Value: "workflows" }],
    }, context());
    assert.equal(provider.plan(initial, desired, context()).action, "UPDATE");
    const updated = await settle(current => provider.update(created.physicalId, initial, desired, current));
    assert.equal(updated.status, "SUCCESS");
    assert.match((await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: created.physicalId }))).definition!, /updated/);
    const updatedTags = Object.fromEntries((await sfn.send(new ListTagsForResourceCommand({ resourceArn: created.physicalId }))).tags!.map(tag => [tag.key!, tag.value!]));
    assert.equal(updatedTags.team, "workflows");

    const renamed: StepFunctionsStateMachineModel = { ...desired, StateMachineName: "provider-workflow-replacement" };
    const replacementPlan = provider.plan(desired, renamed, context());
    assert.equal(replacementPlan.action, "REPLACE");
    assert.deepEqual(replacementPlan.replacementProperties, ["StateMachineName"]);

    assert.equal((await provider.delete(created.physicalId, desired, context())).status, "SUCCESS");
    assert.equal((await provider.read(created.physicalId, context())).status, "NOT_FOUND");
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
