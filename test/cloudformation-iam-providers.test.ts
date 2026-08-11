import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import {
  IAM_MANAGED_POLICY_TYPE,
  IAM_POLICY_TYPE,
  IAM_ROLE_TYPE,
  CloudFormationProviderRegistry,
  ProviderReferenceError,
  createIamCloudFormationProviders,
  type IamManagedPolicyModel,
  type IamPolicyModel,
  type IamRoleModel,
  type ProductionResourceProvider,
  type ProviderContext,
} from "../src/cloudformation/providers/index.js";
import { TestClock } from "../src/core/clock.js";
import { IamService } from "../src/iam.js";
import { StateStore } from "../src/state.js";

const accountId = "123456789012";
const region = "eu-west-1";
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow" as const, Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
const readPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Allow" as const, Action: "dynamodb:GetItem", Resource: "*" }] };
const queryPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Allow" as const, Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: "*" }] };

function context(logicalId: string, overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/orders-stack/00000000-0000-0000-0000-000000000001`,
    logicalId,
    operationId: "operation-1",
    resourceOperationId: `${logicalId}-operation-1`,
    idempotencyKey: `${logicalId}-stable-key`,
    deadlineAt: 1_800_000_000_000,
    principal: { identity },
    ...overrides,
  };
}

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new StateStore(root, accountId, region); await store.load();
  const clock = new TestClock(1_720_000_000_000); const iam = new IamService(store, clock);
  const providers = createIamCloudFormationProviders(iam, clock);
  const byType = new Map(providers.map(provider => [provider.typeName, provider]));
  return { root, store, clock, iam, providers, role: byType.get(IAM_ROLE_TYPE)! as ProductionResourceProvider<IamRoleModel>, policy: byType.get(IAM_POLICY_TYPE)! as ProductionResourceProvider<IamPolicyModel>, managed: byType.get(IAM_MANAGED_POLICY_TYPE)! as ProductionResourceProvider<IamManagedPolicyModel> };
}

function decoded(value: string): any { return JSON.parse(decodeURIComponent(value)); }

async function createDirectRole(iam: IamService, name: string): Promise<void> {
  await iam.CreateRole({ RoleName: name, AssumeRolePolicyDocument: trust });
}

test("IAM provider factory freezes explicit ordinary-CDK matrices and deterministic plans", async () => {
  const f = await fixture("stacksim-cfn-iam-schema-");
  try {
    assert.deepEqual(f.providers.map(provider => provider.typeName), [IAM_ROLE_TYPE, IAM_POLICY_TYPE, IAM_MANAGED_POLICY_TYPE]);
    assert.deepEqual(new CloudFormationProviderRegistry(f.providers).list().map(provider => provider.typeName), [IAM_MANAGED_POLICY_TYPE, IAM_POLICY_TYPE, IAM_ROLE_TYPE]);
    assert.deepEqual(Object.keys(f.role.schema.properties).sort(), ["AssumeRolePolicyDocument", "Description", "ManagedPolicyArns", "MaxSessionDuration", "Path", "Policies", "RoleName", "Tags"]);
    assert.deepEqual(Object.keys(f.policy.schema.properties).sort(), ["PolicyDocument", "PolicyName", "Roles"]);
    assert.deepEqual(Object.keys(f.managed.schema.properties).sort(), ["Description", "ManagedPolicyName", "Path", "PolicyDocument", "Roles"]);
    assert.equal(f.role.validate({ AssumeRolePolicyDocument: trust, PermissionsBoundary: "arn:aws:iam::aws:policy/AdministratorAccess" }, context("Role"))[0].code, "UnsupportedProperty");
    assert.equal(f.policy.validate({ PolicyName: "inline", PolicyDocument: readPolicy, Roles: ["worker"], Users: ["user"] }, context("Policy"))[0].code, "UnsupportedProperty");
    assert.equal(f.managed.validate({ PolicyDocument: readPolicy, Tags: [] }, context("Managed"))[0].code, "UnsupportedProperty");
    assert.ok(f.policy.validate({ PolicyName: "inline", PolicyDocument: readPolicy, Roles: [] }, context("Policy")).some(issue => issue.path === "Properties.Roles" && issue.code === "InvalidProperty"));
    for (const invalid of ["x".repeat(65), "invalid role name"]) {
      const issues = f.role.validate({ RoleName: invalid, AssumeRolePolicyDocument: trust }, context("ExplicitInvalidRole"));
      assert.ok(issues.some(issue => issue.path === "Properties.RoleName" && /valid IAM name of at most 64 characters/.test(issue.message)));
      assert.throws(() => f.role.canonicalize({ RoleName: invalid, AssumeRolePolicyDocument: trust }, context("ExplicitInvalidRole")), /valid IAM name of at most 64 characters/);
    }

    const first = f.role.canonicalize({ AssumeRolePolicyDocument: trust }, context("GeneratedRole"));
    const second = f.role.canonicalize({ AssumeRolePolicyDocument: trust }, context("GeneratedRole", { operationId: "different-operation" }));
    assert.equal(first.RoleName, second.RoleName);
    assert.match(first.RoleName, /^orders-stack-GeneratedRole-[a-f0-9]{12}$/);
    assert.equal(f.role.plan(undefined, first, context("GeneratedRole")).action, "CREATE");
    const movedPath = { ...first, Path: "/service/" };
    assert.deepEqual(f.role.plan(first, movedPath, context("GeneratedRole")).replacementOrder, "DELETE_BEFORE_CREATE");
    assert.deepEqual(f.role.plan(first, { ...first, RoleName: "renamed-role" }, context("GeneratedRole")).replacementOrder, "CREATE_BEFORE_DELETE");

    const managed = f.managed.canonicalize({ PolicyDocument: readPolicy }, context("GeneratedManaged"));
    assert.equal(managed.ManagedPolicyName, f.managed.canonicalize({ PolicyDocument: readPolicy }, context("GeneratedManaged", { idempotencyKey: "different" })).ManagedPolicyName);
    assert.equal(f.managed.plan(managed, { ...managed, Description: "immutable" }, context("GeneratedManaged")).replacementOrder, "DELETE_BEFORE_CREATE");
    assert.equal(f.managed.plan(managed, { ...managed, ManagedPolicyName: "renamed" }, context("GeneratedManaged")).replacementOrder, "CREATE_BEFORE_DELETE");
    const inline = f.policy.canonicalize({ PolicyName: "orders-inline", PolicyDocument: readPolicy, Roles: ["b", "a"] }, context("Policy"));
    assert.deepEqual(inline.Roles, ["a", "b"]);
    assert.equal(f.policy.plan(inline, { ...inline, PolicyName: "orders-inline-v2" }, context("Policy")).action, "UPDATE");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("AWS::IAM::Role lifecycle uses authoritative IAM resources, updates attachments, and protects conflicts", async () => {
  const f = await fixture("stacksim-cfn-iam-role-"); const ctx = context("WorkerRole");
  try {
    const basicArn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
    const ddbArn = "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole";
    const desired = f.role.canonicalize({ RoleName: "orders-worker", AssumeRolePolicyDocument: trust, Description: "worker", ManagedPolicyArns: [basicArn], Policies: [{ PolicyName: "ReadOrders", PolicyDocument: readPolicy }], Tags: [{ Key: "team", Value: "orders" }] }, ctx);
    const created = await f.role.create(desired, ctx); assert.equal(created.status, "SUCCESS"); if (created.status !== "SUCCESS") assert.fail("role create must succeed");
    assert.equal(created.physicalId, "orders-worker"); assert.equal(f.role.ref(created.model), "orders-worker"); assert.match(String(f.role.getAtt(created.model, "Arn")), /role\/orders-worker$/); assert.match(String(f.role.getAtt(created.model, "RoleId")), /^AROA/); assert.throws(() => f.role.getAtt(created.model, "Id"), ProviderReferenceError);
    const direct = (await f.iam.GetRole({ RoleName: "orders-worker" })).Role; assert.equal(direct.Description, "worker"); assert.equal(Object.fromEntries(direct.Tags.map((tag: any) => [tag.Key, tag.Value])).team, "orders");
    assert.deepEqual((await f.iam.ListAttachedRolePolicies({ RoleName: "orders-worker" })).AttachedPolicies.map((policy: any) => policy.PolicyArn), [basicArn]);
    assert.deepEqual(decoded((await f.iam.GetRolePolicy({ RoleName: "orders-worker", PolicyName: "ReadOrders" })).PolicyDocument), readPolicy);
    assert.equal((await f.role.create(desired, ctx)).status, "SUCCESS", "a stable create retry is idempotent");

    const updated = f.role.canonicalize({ RoleName: "orders-worker", AssumeRolePolicyDocument: trust, Description: "updated", MaxSessionDuration: 7200, ManagedPolicyArns: [ddbArn], Policies: [{ PolicyName: "QueryOrders", PolicyDocument: queryPolicy }], Tags: [{ Key: "environment", Value: "test" }] }, ctx);
    assert.equal(f.role.plan(desired, updated, ctx).action, "UPDATE");
    await f.iam.PutRolePolicy({ RoleName: "orders-worker", PolicyName: "QueryOrders", PolicyDocument: readPolicy });
    const occupiedInline = await f.role.update("orders-worker", desired, updated, ctx); assert.equal(occupiedInline.status, "FAILED"); if (occupiedInline.status === "FAILED") assert.equal(occupiedInline.errorCode, "EntityAlreadyExists");
    await f.iam.DeleteRolePolicy({ RoleName: "orders-worker", PolicyName: "QueryOrders" });
    const result = await f.role.update("orders-worker", desired, updated, ctx); assert.equal(result.status, "SUCCESS");
    assert.equal((await f.role.update("orders-worker", desired, updated, ctx)).status, "SUCCESS", "a repeated composite update must recover after a lost executor checkpoint");
    const after = (await f.iam.GetRole({ RoleName: "orders-worker" })).Role; assert.equal(after.Description, "updated"); assert.equal(after.MaxSessionDuration, 7200); const afterTags = Object.fromEntries(after.Tags.map((tag: any) => [tag.Key, tag.Value])); assert.equal(afterTags.team, undefined); assert.equal(afterTags.environment, "test");
    assert.deepEqual((await f.iam.ListAttachedRolePolicies({ RoleName: "orders-worker" })).AttachedPolicies.map((policy: any) => policy.PolicyArn), [ddbArn]);
    await assert.rejects(f.iam.GetRolePolicy({ RoleName: "orders-worker", PolicyName: "ReadOrders" }), (error: any) => error.code === "NoSuchEntity");
    assert.deepEqual(decoded((await f.iam.GetRolePolicy({ RoleName: "orders-worker", PolicyName: "QueryOrders" })).PolicyDocument), queryPolicy);

    await f.iam.PutRolePolicy({ RoleName: "orders-worker", PolicyName: "QueryOrders", PolicyDocument: readPolicy });
    const refused = await f.role.delete("orders-worker", updated, ctx); assert.equal(refused.status, "FAILED"); if (refused.status === "FAILED") assert.equal(refused.errorCode, "ResourceConflict");
    assert.ok((await f.iam.GetRole({ RoleName: "orders-worker" })).Role);
    await f.iam.PutRolePolicy({ RoleName: "orders-worker", PolicyName: "QueryOrders", PolicyDocument: queryPolicy });
    assert.equal((await f.role.delete("orders-worker", updated, ctx)).status, "SUCCESS"); assert.equal((await f.role.read("orders-worker", ctx)).status, "NOT_FOUND");

    await createDirectRole(f.iam, "occupied-role");
    const occupied = f.role.canonicalize({ RoleName: "occupied-role", AssumeRolePolicyDocument: trust }, context("OccupiedRole"));
    const conflict = await f.role.create(occupied, context("OccupiedRole")); assert.equal(conflict.status, "FAILED"); if (conflict.status === "FAILED") assert.equal(conflict.errorCode, "EntityAlreadyExists");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("AWS::IAM::Policy mutates role inline policies transactionally and returns the policy name", async () => {
  const f = await fixture("stacksim-cfn-iam-inline-"); const ctx = context("OrdersInline");
  try {
    await createDirectRole(f.iam, "inline-a"); await createDirectRole(f.iam, "inline-b");
    const desired = f.policy.canonicalize({ PolicyName: "OrdersInline", PolicyDocument: readPolicy, Roles: ["inline-b", "inline-a"] }, ctx);
    const created = await f.policy.create(desired, ctx); assert.equal(created.status, "SUCCESS"); if (created.status !== "SUCCESS") assert.fail("inline policy create must succeed"); assert.equal(f.policy.ref(created.model), "OrdersInline"); assert.throws(() => f.policy.getAtt(created.model, "Id"), ProviderReferenceError);
    assert.equal((await f.policy.create(desired, ctx)).status, "SUCCESS"); assert.equal((await f.policy.read("OrdersInline", ctx)).status, "SUCCESS");
    assert.deepEqual(decoded((await f.iam.GetRolePolicy({ RoleName: "inline-a", PolicyName: "OrdersInline" })).PolicyDocument), readPolicy);

    const updated = f.policy.canonicalize({ PolicyName: "OrdersInlineV2", PolicyDocument: queryPolicy, Roles: ["inline-b"] }, ctx);
    const result = await f.policy.update("OrdersInline", desired, updated, ctx); assert.equal(result.status, "SUCCESS"); if (result.status === "SUCCESS") assert.equal(result.physicalId, "OrdersInlineV2");
    assert.equal((await f.policy.update("OrdersInline", desired, updated, ctx)).status, "SUCCESS", "put-new/delete-old update must be idempotent after a lost checkpoint");
    await assert.rejects(f.iam.GetRolePolicy({ RoleName: "inline-a", PolicyName: "OrdersInline" }), (error: any) => error.code === "NoSuchEntity");
    await assert.rejects(f.iam.GetRolePolicy({ RoleName: "inline-b", PolicyName: "OrdersInline" }), (error: any) => error.code === "NoSuchEntity");
    assert.deepEqual(decoded((await f.iam.GetRolePolicy({ RoleName: "inline-b", PolicyName: "OrdersInlineV2" })).PolicyDocument), queryPolicy);

    await f.iam.PutRolePolicy({ RoleName: "inline-b", PolicyName: "OrdersInlineV2", PolicyDocument: readPolicy });
    const conflict = await f.policy.delete("OrdersInlineV2", updated, ctx); assert.equal(conflict.status, "FAILED"); if (conflict.status === "FAILED") assert.equal(conflict.errorCode, "ResourceConflict");
    await f.iam.PutRolePolicy({ RoleName: "inline-b", PolicyName: "OrdersInlineV2", PolicyDocument: queryPolicy });
    assert.equal((await f.policy.delete("OrdersInlineV2", updated, ctx)).status, "SUCCESS"); assert.equal((await f.policy.read("OrdersInlineV2", ctx)).status, "NOT_FOUND");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("AWS::IAM::ManagedPolicy versions documents, moves role attachments, exposes backed attributes, and preserves external conflicts", async () => {
  const f = await fixture("stacksim-cfn-iam-managed-"); const ctx = context("OrdersManaged");
  try {
    await createDirectRole(f.iam, "managed-a"); await createDirectRole(f.iam, "managed-b"); await createDirectRole(f.iam, "managed-external");
    const desired = f.managed.canonicalize({ ManagedPolicyName: "OrdersManaged", Description: "orders", PolicyDocument: readPolicy, Roles: ["managed-a"] }, ctx);
    const created = await f.managed.create(desired, ctx); assert.equal(created.status, "SUCCESS"); if (created.status !== "SUCCESS") assert.fail("managed policy create must succeed");
    const arn = `arn:aws:iam::${accountId}:policy/OrdersManaged`; assert.equal(created.physicalId, arn); assert.equal(f.managed.ref(created.model), arn); assert.equal(f.managed.getAtt(created.model, "PolicyArn"), arn); assert.match(String(f.managed.getAtt(created.model, "PolicyId")), /^ANPA/); assert.equal(f.managed.getAtt(created.model, "AttachmentCount"), 1); assert.match(String(f.managed.getAtt(created.model, "CreateDate")), /^\d{4}-/); assert.throws(() => f.managed.getAtt(created.model, "Arn"), ProviderReferenceError);
    assert.equal((await f.managed.create(desired, ctx)).status, "SUCCESS");
    const directTags = Object.fromEntries((await f.iam.ListPolicyTags({ PolicyArn: arn })).Tags.map((tag: any) => [tag.Key, tag.Value])); assert.equal(directTags["aws:cloudformation:stack-id"], ctx.stackId); assert.equal(directTags["aws:cloudformation:operation-id"], undefined);

    const updated = f.managed.canonicalize({ ManagedPolicyName: "OrdersManaged", Description: "orders", PolicyDocument: queryPolicy, Roles: ["managed-b"] }, ctx);
    assert.equal(f.managed.plan(desired, updated, ctx).action, "UPDATE"); const result = await f.managed.update(arn, desired, updated, ctx); assert.equal(result.status, "SUCCESS");
    assert.equal((await f.managed.update(arn, desired, updated, ctx)).status, "SUCCESS", "policy-version and attachment update must be retry-safe");
    const policy = (await f.iam.GetPolicy({ PolicyArn: arn })).Policy; assert.deepEqual(decoded((await f.iam.GetPolicyVersion({ PolicyArn: arn, VersionId: policy.DefaultVersionId })).PolicyVersion.Document), queryPolicy); assert.equal((await f.iam.ListPolicyVersions({ PolicyArn: arn })).Versions.length, 1);
    assert.deepEqual((await f.iam.ListEntitiesForPolicy({ PolicyArn: arn })).PolicyRoles.map((role: any) => role.RoleName), ["managed-b"]);

    await f.iam.AttachRolePolicy({ RoleName: "managed-external", PolicyArn: arn });
    const deleteConflict = await f.managed.delete(arn, updated, ctx); assert.equal(deleteConflict.status, "FAILED"); if (deleteConflict.status === "FAILED") assert.equal(deleteConflict.errorCode, "DeleteConflict");
    assert.ok((await f.iam.GetPolicy({ PolicyArn: arn })).Policy, "an externally attached policy must survive failed deletion");
    await f.iam.DetachRolePolicy({ RoleName: "managed-external", PolicyArn: arn });
    assert.equal((await f.managed.delete(arn, updated, ctx)).status, "SUCCESS"); assert.equal((await f.managed.read(arn, ctx)).status, "NOT_FOUND");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
