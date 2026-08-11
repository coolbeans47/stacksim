import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { CloudFormationCheckpointObservation, CloudFormationService } from "../src/cloudformation.js";
import {
  SES_CFN_LOGICAL_ID_TAG,
  SES_CFN_RESOURCE_OPERATION_ID_TAG,
  SES_CFN_STACK_ID_TAG,
  SES_CFN_SYSTEM_TAG_KEYS,
} from "../src/cloudformation/providers/ses.js";
import { TestClock } from "../src/core/clock.js";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const principal: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function expectedGeneratedName(stackId: string, logicalId: string): string {
  const stack = stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
  const suffix = createHash("sha256").update(`${stackId}\0${logicalId}`).digest("hex").slice(0, 12);
  const base = `${stack}-${logicalId}`.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resource";
  return `${base.slice(0, Math.max(1, 63 - suffix.length))}-${suffix}`;
}

function deadline<T>(promise: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function waitForStatus(service: CloudFormationService, stackId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = (await service.DescribeStacks({ StackName: stackId })).Stacks[0].StackStatus;
    if (status === expected) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${stackId} to reach ${expected}`);
}

test("SES generated-name create survives a restart after a lost response without duplicating or adopting another operation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-restart-"));
  const dataDir = join(root, "data");
  let first: StackSim | undefined;
  let restarted: StackSim | undefined;
  try {
    first = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off"});
    let resolveInterrupted!: (observation: CloudFormationCheckpointObservation) => void;
    const interrupted = new Promise<CloudFormationCheckpointObservation>(resolve => { resolveInterrupted = resolve; });
    first.cloudformation.setCheckpointInterceptorForTest(observation => {
      if (observation.checkpoint !== "provider:GeneratedConfiguration:create:retry-2") return false;
      resolveInterrupted(observation);
      return true;
    });

    const originalExecute = first.ses.execute.bind(first.ses);
    let createAttemptsBeforeRestart = 0;
    let responseWasLost = false;
    (first.ses as any).execute = async (...args: any[]) => {
      if (args[0] === "CreateConfigurationSet") createAttemptsBeforeRestart += 1;
      const result = await (originalExecute as any)(...args);
      if (!responseWasLost && args[0] === "CreateConfigurationSet") {
        responseWasLost = true;
        throw new AwsError("InternalServiceErrorException", "simulated response loss after the durable SES create", 500);
      }
      return result;
    };

    await first.start();
    const logicalId = "GeneratedConfiguration";
    const created = await first.cloudformation.CreateStack({
      StackName: "ses-restart",
      TemplateBody: JSON.stringify({
        Resources: {
          [logicalId]: {
            Type: "AWS::SES::ConfigurationSet",
            Properties: {
              SendingOptions: { SendingEnabled: false },
              Tags: [{ Key: "phase", Value: "SES-03" }],
            },
          },
        },
        Outputs: {
          ConfigurationName: { Value: { Ref: logicalId } },
        },
      }),
    }, principal);
    const observation = await deadline(interrupted, "the post-create lost-response checkpoint");
    assert.equal(observation.stackId, created.StackId);
    assert.equal(observation.operationId, created.OperationId);
    assert.equal(responseWasLost, true);
    assert.equal(createAttemptsBeforeRestart, 1);

    const interruptedStack = first.store.regionState(region).cloudformation.stacks[created.StackId];
    const interruptedResource = interruptedStack.resources[logicalId];
    const physicalId = interruptedResource.physicalResourceId;
    assert.equal(physicalId, expectedGeneratedName(created.StackId, logicalId), "the generated name must derive only from the durable stack identity");
    assert.equal(interruptedResource.resourceStatus, "CREATE_IN_PROGRESS");
    assert.equal(interruptedStack.activeOperation?.operationId, created.OperationId);

    const configurationSets = first.store.regionState(region).ses.configurationSets;
    assert.deepEqual(Object.keys(configurationSets), [physicalId], "the successful SES write must have created exactly one object");
    const interruptedConfiguration = structuredClone(configurationSets[physicalId]);
    const expectedResourceOperationId = createHash("sha256")
      .update(`${created.OperationId}:${logicalId}:create`)
      .digest("hex");
    assert.equal(interruptedConfiguration.tags[SES_CFN_STACK_ID_TAG], created.StackId);
    assert.equal(interruptedConfiguration.tags[SES_CFN_LOGICAL_ID_TAG], logicalId);
    assert.equal(interruptedConfiguration.tags[SES_CFN_RESOURCE_OPERATION_ID_TAG], expectedResourceOperationId);
    const revisionAfterLostResponse = first.store.regionState(region).ses.controlRevision;

    await first.stop();
    first = undefined;

    restarted = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off"});
    const restartedExecute = restarted.ses.execute.bind(restarted.ses);
    let replayedCreates = 0;
    (restarted.ses as any).execute = async (...args: any[]) => {
      if (args[0] === "CreateConfigurationSet") replayedCreates += 1;
      return (restartedExecute as any)(...args);
    };
    await restarted.start();
    await waitForStatus(restarted.cloudformation, created.StackId, "CREATE_COMPLETE");

    const recoveredStack = restarted.store.regionState(region).cloudformation.stacks[created.StackId];
    const recoveredResource = recoveredStack.resources[logicalId];
    const recoveredSets = restarted.store.regionState(region).ses.configurationSets;
    assert.equal(replayedCreates, 1, "restart must replay the same provider create once and receive AlreadyExists");
    assert.deepEqual(Object.keys(recoveredSets), [physicalId], "replay must not allocate a duplicate SES resource");
    assert.deepEqual(recoveredSets[physicalId], interruptedConfiguration, "exact-marker recovery must not rewrite or replace the existing resource");
    assert.equal(restarted.store.regionState(region).ses.controlRevision, revisionAfterLostResponse, "AlreadyExists recovery and authoritative reads must not mutate SES");
    assert.equal(recoveredResource.physicalResourceId, physicalId);
    assert.equal(recoveredResource.refValue, physicalId);
    assert.equal(recoveredResource.resourceStatus, "CREATE_COMPLETE");
    assert.equal(recoveredStack.activeOperation?.operationId, created.OperationId, "restart must resume the original stack operation");
    assert.deepEqual(recoveredStack.outputs, [{
      description: undefined,
      exportName: undefined,
      outputKey: "ConfigurationName",
      outputValue: physicalId,
    }]);
  } finally {
    await first?.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES restart refuses an existing resource whose operation marker does not match the durable create", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-ses-marker-conflict-"));
  const dataDir = join(root, "data");
  const clock = new TestClock(20_000);
  let first: StackSim | undefined;
  let restarted: StackSim | undefined;
  try {
    first = new StackSim({ port: 0, invokePort: 0, dataDir, region, clock, authMode: "off"});
    let resolveIntent!: (observation: CloudFormationCheckpointObservation) => void;
    const intent = new Promise<CloudFormationCheckpointObservation>(resolve => { resolveIntent = resolve; });
    first.cloudformation.setCheckpointInterceptorForTest(observation => {
      if (observation.checkpoint !== "provider:ForeignConfiguration:create:attempt-1") return false;
      resolveIntent(observation);
      return true;
    });
    await first.start();

    const logicalId = "ForeignConfiguration";
    const physicalId = "foreign-configuration";
    const created = await first.cloudformation.CreateStack({
      StackName: "ses-marker-conflict",
      DisableRollback: true,
      TemplateBody: JSON.stringify({
        Resources: {
          [logicalId]: {
            Type: "AWS::SES::ConfigurationSet",
            Properties: { Name: physicalId },
          },
        },
      }),
    }, principal);
    await deadline(intent, "the durable SES create intent");

    const activeOperation = first.store.regionState(region).cloudformation.stacks[created.StackId].activeOperation;
    assert.equal(activeOperation?.operationId, created.OperationId);
    await first.ses.execute("CreateConfigurationSet", {
      ConfigurationSetName: physicalId,
      Tags: [
        { Key: SES_CFN_STACK_ID_TAG, Value: created.StackId },
        { Key: SES_CFN_LOGICAL_ID_TAG, Value: logicalId },
        { Key: SES_CFN_RESOURCE_OPERATION_ID_TAG, Value: "another-resource-operation" },
      ],
    }, "ses-v2", "foreign-create", { cloudFormationSystemTagKeys: SES_CFN_SYSTEM_TAG_KEYS });
    const foreign = structuredClone(first.store.regionState(region).ses.configurationSets[physicalId]);

    await first.stop();
    first = undefined;

    restarted = new StackSim({ port: 0, invokePort: 0, dataDir, region, clock, authMode: "off"});
    await restarted.start();
    clock.advance(1);
    await waitForStatus(restarted.cloudformation, created.StackId, "CREATE_FAILED");

    const failedStack = restarted.store.regionState(region).cloudformation.stacks[created.StackId];
    assert.equal(failedStack.resources[logicalId].resourceStatus, "CREATE_FAILED");
    assert.match(failedStack.resources[logicalId].resourceStatusReason ?? "", /AlreadyExists/);
    assert.equal(failedStack.resources[logicalId].physicalResourceId, undefined, "an unowned provisional ID must be discarded after terminal create refusal");
    assert.deepEqual(failedStack.activeOperation?.completedLogicalIds, [], "the conflicting resource must never be adopted into the completed set");
    assert.deepEqual(restarted.store.regionState(region).ses.configurationSets[physicalId], foreign, "marker mismatch refusal must leave the existing SES resource untouched");
    assert.equal(Object.keys(restarted.store.regionState(region).ses.configurationSets).length, 1);
    await restarted.cloudformation.DeleteStack({ StackName: created.StackId }, principal);
    await waitForStatus(restarted.cloudformation, created.StackId, "DELETE_COMPLETE");
    assert.deepEqual(restarted.store.regionState(region).ses.configurationSets[physicalId], foreign, "deleting a failed stack must not delete its discarded unowned provisional resource");
  } finally {
    await first?.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
