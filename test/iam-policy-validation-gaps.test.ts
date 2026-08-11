import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateGroupCommand, CreatePolicyCommand, CreateRoleCommand, CreateUserCommand, IAMClient, PutGroupPolicyCommand, PutRolePolicyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { evaluateRoleAuthorization } from "../src/iam/evaluator.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const rootPrincipal = { AWS: `arn:aws:iam::${accountId}:root` };
const malformed = (error: any) => error.name.startsWith("MalformedPolicyDocument");

test("IAMGAP-10 and IAMGAP-12 share operator and policy-kind validation across every IAM/STS write path", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap10-12-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam, sts);
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: rootPrincipal, Action: "sts:AssumeRole" }] });
    const role = await iam.send(new CreateRoleCommand({ RoleName: "validation-role", AssumeRolePolicyDocument: trust }));
    await iam.send(new CreateUserCommand({ UserName: "validation-user" }));
    await iam.send(new CreateGroupCommand({ GroupName: "validation-group" }));
    const missingResource = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject" }] });
    const unknownOperator = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*", Condition: { StringEqualz: { "aws:RequestedRegion": region } } }] });
    const invalidBinary = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*", Condition: { BinaryEquals: { "stacksim:binary": "AR==" } } }] });
    const invalidCidr = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*", Condition: { IpAddress: { "aws:SourceIp": "2001:db8::/129" } } }] });
    const notPrincipal = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", NotPrincipal: rootPrincipal, Action: "s3:GetObject", Resource: "*" }] });

    for (const request of [
      () => iam.send(new CreatePolicyCommand({ PolicyName: "MissingManagedResource", PolicyDocument: missingResource })),
      () => iam.send(new PutRolePolicyCommand({ RoleName: "validation-role", PolicyName: "missing", PolicyDocument: missingResource })),
      () => iam.send(new PutUserPolicyCommand({ UserName: "validation-user", PolicyName: "missing", PolicyDocument: missingResource })),
      () => iam.send(new PutGroupPolicyCommand({ GroupName: "validation-group", PolicyName: "missing", PolicyDocument: missingResource })),
      () => iam.send(new PutRolePolicyCommand({ RoleName: "validation-role", PolicyName: "principal", PolicyDocument: notPrincipal })),
      () => iam.send(new CreatePolicyCommand({ PolicyName: "UnknownManagedOperator", PolicyDocument: unknownOperator })),
      () => iam.send(new CreatePolicyCommand({ PolicyName: "InvalidBinary", PolicyDocument: invalidBinary })),
      () => iam.send(new CreatePolicyCommand({ PolicyName: "InvalidCidr", PolicyDocument: invalidCidr })),
      () => iam.send(new PutRolePolicyCommand({ RoleName: "validation-role", PolicyName: "unknown", PolicyDocument: unknownOperator })),
    ]) await assert.rejects(request(), malformed);

    for (const invalidTrust of [
      { Effect: "Allow", NotPrincipal: rootPrincipal, Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: rootPrincipal, Action: "sts:AssumeRole", Resource: "*" },
      { Effect: "Allow", Principal: rootPrincipal, Action: "sts:AssumeRole", Condition: { StringEqualz: { "aws:PrincipalArn": "*" } } },
    ]) await assert.rejects(
      iam.send(new CreateRoleCommand({ RoleName: `invalid-trust-${Math.random().toString(36).slice(2)}`, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [invalidTrust] }) })),
      malformed,
    );

    for (const policy of [missingResource, unknownOperator]) await assert.rejects(
      sts.send(new AssumeRoleCommand({ RoleArn: role.Role!.Arn!, RoleSessionName: "invalid-session-policy", Policy: policy })),
      malformed,
    );

    await iam.send(new CreatePolicyCommand({
      PolicyName: "ValidNotResource",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", NotResource: "arn:aws:s3:::blocked/*" }] }),
    }));
    await iam.send(new CreateRoleCommand({ RoleName: "valid-trust", AssumeRolePolicyDocument: trust }));

    const storedRole = simulator.store.ensureAccount().iam.roles["validation-role"];
    storedRole.inlinePolicies.corrupted = JSON.parse(unknownOperator);
    assert.equal(evaluateRoleAuthorization(simulator.store.ensureAccount().iam, storedRole.arn, "s3:GetObject", "arn:aws:s3:::example/key", { "aws:RequestedRegion": region }).decision, "implicitDeny");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
