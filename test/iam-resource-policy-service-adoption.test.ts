import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateEmailIdentityCommand, CreateEmailIdentityPolicyCommand, SESv2Client, UpdateEmailIdentityPolicyCommand } from "@aws-sdk/client-sesv2";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { StackSim } from "../src/server.js";

test("IAMGAP-16 SES adoption uses the shared role-versus-exact-session matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap16-ses-")); const region = "eu-west-1"; const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; const iam = new IAMClient({ endpoint, region, credentials }); const sts = new STSClient({ endpoint, region, credentials }); const ses = new SESv2Client({ endpoint, region, credentials }); clients.push(iam, sts, ses);
    const roleArn = "arn:aws:iam::000000000000:role/ses-resource-reader"; await iam.send(new CreateRoleCommand({ RoleName: "ses-resource-reader", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }) }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "limited", Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }) })); const accessKeyId = assumed.Credentials!.AccessKeyId!; const session = simulator.store.ensureAccount().iam.sessions[accessKeyId];
    const principal: PrincipalContext = { principalType: "roleSession", accessKeyId, principalArn: session.principalArn, principalId: session.principalId, accountId: "000000000000", roleArn: session.roleArn, sessionArn: session.principalArn, issuedAt: session.issuedAt };
    const email = "matrix@example.test"; const resource = `arn:aws:ses:${region}:000000000000:identity/${email}`; await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: email }));
    const document = (named: string, effect: "Allow" | "Deny" = "Allow") => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: effect, Principal: { AWS: named }, Action: "ses:SendEmail", Resource: resource }] });
    await ses.send(new CreateEmailIdentityPolicyCommand({ EmailIdentity: email, PolicyName: "matrix", Policy: document(roleArn) }));
    const target = { action: "ses:SendEmail", resource, operation: "SendEmail", input: {}, context: { "aws:PrincipalArn": roleArn, "aws:PrincipalAccount": "000000000000", "aws:RequestedRegion": region, "aws:CurrentTime": new Date().toISOString() } };
    assert.equal((await (simulator as any).evaluateAndRecordAuthorization(principal, target, "role-grant")).decision, "implicitDeny");
    await ses.send(new UpdateEmailIdentityPolicyCommand({ EmailIdentity: email, PolicyName: "matrix", Policy: document(session.principalArn) }));
    assert.equal((await (simulator as any).evaluateAndRecordAuthorization(principal, target, "session-grant")).decision, "allowed");
    await ses.send(new UpdateEmailIdentityPolicyCommand({ EmailIdentity: email, PolicyName: "matrix", Policy: document(session.principalArn, "Deny") }));
    assert.equal((await (simulator as any).evaluateAndRecordAuthorization(principal, target, "explicit-deny")).decision, "explicitDeny");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
