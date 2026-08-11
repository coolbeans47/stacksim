import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  appSyncFunctionOwnershipKey,
  appSyncResolverOwnershipKey,
  appSyncSchemaOwnershipKey,
  beginHotswapDrift,
  completeHotswapDrift,
  failHotswapDrift,
  hotswapCheckpoint,
  lambdaOwnershipKey,
  publishCompletedDeploymentGeneration,
  removeCompletedDeploymentOwnership,
  setHotswapCheckpointInterceptorForTest,
  uniqueCompletedOwner,
} from "../src/cloudformation/hotswap.js";
import { emptyRegion } from "../src/migrations/v1-to-v2.js";
import type { CloudFormationStackResourceState, CloudFormationStackState } from "../src/types.js";

function resource(logicalResourceId: string, resourceType: string, physicalResourceId: string, properties: Record<string, unknown>, attributes: Record<string, unknown>): CloudFormationStackResourceState {
  return { logicalResourceId, resourceType, physicalResourceId, properties, attributes, dependsOn: [], resourceStatus: "CREATE_COMPLETE", lastUpdatedTimestamp: 1 };
}

function stack(stackId: string, stackName: string, resources: Record<string, CloudFormationStackResourceState>, parent?: { id: string; root: string }): CloudFormationStackState {
  return {
    stackId, stackName, stackStatus: "CREATE_COMPLETE", creationTime: 1, enableTerminationProtection: false, disableRollback: false,
    notificationArns: [], capabilities: [], tags: {}, parameters: [], outputs: [], templateDigest: "0".repeat(64), resources, events: [],
    ...(parent ? { parentId: parent.id, rootId: parent.root, parentLogicalId: "Child" } : {}),
  };
}

test("AMX-10 completed generations publish unique nested ownership and ordinary reconciliation clears drift", () => {
  const region = emptyRegion();
  const rootId = "arn:aws:cloudformation:eu-west-1:000000000000:stack/amplify-amx10a/root";
  const childId = "arn:aws:cloudformation:eu-west-1:000000000000:stack/amplify-data/child";
  const schema = resource("Schema", "AWS::AppSync::GraphQLSchema", "schema:WyJhcGkxIl0", { ApiId: "api1" }, {});
  const fn = resource("Fn", "AWS::AppSync::FunctionConfiguration", "function:WyJhcGkxIiwiZm4xIl0", { ApiId: "api1" }, { FunctionId: "fn1", FunctionArn: "arn:aws:appsync:eu-west-1:000000000000:apis/api1/functions/fn1" });
  const resolver = resource("Resolver", "AWS::AppSync::Resolver", "resolver:WyJhcGkxIiwiUXVlcnkiLCJnZXQiXQ", { ApiId: "api1", TypeName: "Query", FieldName: "get" }, { ResolverArn: "arn:aws:appsync:eu-west-1:000000000000:apis/api1/types/Query/resolvers/get" });
  const lambda = resource("Lambda", "AWS::Lambda::Function", "helper", {}, { Arn: "arn:aws:lambda:eu-west-1:000000000000:function:helper" });
  region.cloudformation.stacks[rootId] = stack(rootId, "amplify-amx10a", { Schema: schema });
  region.cloudformation.stacks[childId] = stack(childId, "amplify-data", { Fn: fn, Resolver: resolver, Lambda: lambda }, { id: rootId, root: rootId });

  assert.equal(publishCompletedDeploymentGeneration(region.cloudformation, "000000000000", "eu-west-1", region.cloudformation.stacks[rootId]), 1);
  assert.equal(uniqueCompletedOwner(region.cloudformation, appSyncSchemaOwnershipKey("api1")).stackId, rootId);
  assert.equal(uniqueCompletedOwner(region.cloudformation, appSyncFunctionOwnershipKey("api1", "fn1")).stackId, childId);
  assert.equal(uniqueCompletedOwner(region.cloudformation, appSyncResolverOwnershipKey("api1", "Query", "get")).logicalResourceId, "Resolver");
  assert.equal(uniqueCompletedOwner(region.cloudformation, lambdaOwnershipKey("helper")).logicalResourceId, "Lambda");
  assert.equal(uniqueCompletedOwner(region.cloudformation, lambdaOwnershipKey("arn:aws:lambda:eu-west-1:000000000000:function:helper")).logicalResourceId, "Lambda");

  const exact = Buffer.from('{"definition":"YWJj","space":"kept"}\n');
  const owner = uniqueCompletedOwner(region.cloudformation, appSyncSchemaOwnershipKey("api1"));
  const drift = beginHotswapDrift(region.cloudformation, owner, "appsync", "StartSchemaCreation", exact, "7:old", 10);
  assert.equal(drift.requestPayloadSha256, createHash("sha256").update(exact).digest("hex"));
  completeHotswapDrift(region.cloudformation, drift, "8:new", 11);
  assert.equal(Object.values(region.cloudformation.hotswapDrift ?? {})[0].status, "INTENTIONAL");

  assert.equal(publishCompletedDeploymentGeneration(region.cloudformation, "000000000000", "eu-west-1", region.cloudformation.stacks[rootId]), 2);
  assert.deepEqual(region.cloudformation.hotswapDrift, {});
  assert.equal(region.cloudformation.stacks[childId].completedDeploymentGeneration, 2);
  assert.equal(region.cloudformation.stacks[childId].resources.Fn.completedDeploymentGeneration, 2);

  removeCompletedDeploymentOwnership(region.cloudformation, rootId);
  assert.throws(() => uniqueCompletedOwner(region.cloudformation, appSyncSchemaOwnershipKey("api1")), /not owned by a completed/);
});

test("AMX-10 rejects ambiguous and stale ownership instead of guessing", () => {
  const region = emptyRegion();
  const rootId = "root";
  region.cloudformation.stacks[rootId] = stack(rootId, "root", { Schema: resource("Schema", "AWS::AppSync::GraphQLSchema", "schema:WyJhcGkxIl0", { ApiId: "api1" }, {}) });
  publishCompletedDeploymentGeneration(region.cloudformation, "000000000000", "eu-west-1", region.cloudformation.stacks[rootId]);
  const key = appSyncSchemaOwnershipKey("api1");
  region.cloudformation.resourceOwnership![key].push(structuredClone(region.cloudformation.resourceOwnership![key][0]));
  assert.throws(() => uniqueCompletedOwner(region.cloudformation, key), /ambiguous/);
  region.cloudformation.resourceOwnership![key].pop();
  region.cloudformation.stacks[rootId].completedDeploymentGeneration = 999;
  assert.throws(() => uniqueCompletedOwner(region.cloudformation, key), /not from the current completed/);
});

test("AMX-10 fault checkpoints distinguish pre-call rejection from post-call partial drift", async () => {
  const region = emptyRegion();
  const rootId = "root";
  region.cloudformation.stacks[rootId] = stack(rootId, "root", { Lambda: resource("Lambda", "AWS::Lambda::Function", "helper", {}, { Arn: "arn:aws:lambda:eu-west-1:000000000000:function:helper" }) });
  publishCompletedDeploymentGeneration(region.cloudformation, "000000000000", "eu-west-1", region.cloudformation.stacks[rootId]);
  const owner = uniqueCompletedOwner(region.cloudformation, lambdaOwnershipKey("helper"));

  const before = beginHotswapDrift(region.cloudformation, owner, "lambda", "Invoke", "before", "r1", 1);
  setHotswapCheckpointInterceptorForTest(region.cloudformation, checkpoint => { if (checkpoint === "before-direct-call") throw new Error("fault-before"); });
  await assert.rejects(hotswapCheckpoint(region.cloudformation, "before-direct-call", before), /fault-before/);
  failHotswapDrift(before, new Error("fault-before"), 2);
  assert.equal(before.status, "FAILED");
  assert.equal(before.currentServiceRevision, "r1", "a pre-call fault cannot create runtime drift");

  const after = beginHotswapDrift(region.cloudformation, owner, "lambda", "Invoke", "after", "r1", 3);
  setHotswapCheckpointInterceptorForTest(region.cloudformation, checkpoint => { if (checkpoint === "after-direct-call") throw new Error("fault-after"); });
  completeHotswapDrift(region.cloudformation, after, "r2", 4);
  await assert.rejects(hotswapCheckpoint(region.cloudformation, "after-direct-call", after), /fault-after/);
  assert.equal(after.status, "INTENTIONAL");
  assert.equal(after.currentServiceRevision, "r2", "a post-call fault retains truthful partial drift");
  assert.equal(Object.values(region.cloudformation.hotswapDrift ?? {})[0].driftId, after.driftId);

  setHotswapCheckpointInterceptorForTest(region.cloudformation);
  publishCompletedDeploymentGeneration(region.cloudformation, "000000000000", "eu-west-1", region.cloudformation.stacks[rootId]);
  assert.deepEqual(region.cloudformation.hotswapDrift, {}, "a later full deployment reconciles recorded drift");
});
