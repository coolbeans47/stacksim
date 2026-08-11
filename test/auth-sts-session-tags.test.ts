import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const rootPrincipal = { AWS: `arn:aws:iam::${accountId}:root` };

function trust(...statements: Array<Record<string, unknown>>): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function allow(action: string | string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { Effect: "Allow", Principal: rootPrincipal, Action: action, ...extra };
}

test("AssumeRole requires TagSession trust for session and transitive tags without affecting untagged sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sts-session-tags-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam, sts);

    const allowedRoleName = "tag-session-allowed";
    const allowedRoleArn = `arn:aws:iam::${accountId}:role/${allowedRoleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: allowedRoleName,
      AssumeRolePolicyDocument: trust(
        allow("sts:AssumeRole"),
        allow("sts:TagSession", {
          Condition: {
            StringEquals: { "aws:RequestTag/course": "aws" },
            "ForAllValues:StringEquals": { "aws:TagKeys": ["course"], "sts:TransitiveTagKeys": ["course"] },
          },
        }),
      ),
    }));
    const tagged = await sts.send(new AssumeRoleCommand({
      RoleArn: allowedRoleArn,
      RoleSessionName: "tagged-session",
      Tags: [{ Key: "course", Value: "aws" }],
      TransitiveTagKeys: ["course"],
    }));
    const taggedAccessKey = tagged.Credentials?.AccessKeyId;
    assert.ok(taggedAccessKey);
    assert.deepEqual(simulator.store.ensureAccount().iam.sessions[taggedAccessKey].sessionTags, { course: "aws" });

    const missingRoleName = "tag-session-missing";
    const missingRoleArn = `arn:aws:iam::${accountId}:role/${missingRoleName}`;
    await iam.send(new CreateRoleCommand({ RoleName: missingRoleName, AssumeRolePolicyDocument: trust(allow("sts:AssumeRole")) }));
    const untagged = await sts.send(new AssumeRoleCommand({ RoleArn: missingRoleArn, RoleSessionName: "untagged-session" }));
    assert.ok(untagged.Credentials?.AccessKeyId, "roles that allow only AssumeRole must remain compatible for untagged sessions");

    const sessionsBeforeMissingTag = Object.keys(simulator.store.ensureAccount().iam.sessions).length;
    await assert.rejects(
      sts.send(new AssumeRoleCommand({ RoleArn: missingRoleArn, RoleSessionName: "missing-tag-permission", Tags: [{ Key: "course", Value: "aws" }] })),
      (error: any) => error.name.startsWith("AccessDenied") && /does not allow sts:TagSession/.test(error.message),
    );
    await assert.rejects(
      sts.send(new AssumeRoleCommand({ RoleArn: missingRoleArn, RoleSessionName: "missing-transitive-permission", TransitiveTagKeys: ["course"] })),
      (error: any) => error.name.startsWith("AccessDenied") && /does not allow sts:TagSession/.test(error.message),
    );
    assert.equal(Object.keys(simulator.store.ensureAccount().iam.sessions).length, sessionsBeforeMissingTag, "denied tag requests must not mint credentials");

    const deniedRoleName = "tag-session-explicit-deny";
    const deniedRoleArn = `arn:aws:iam::${accountId}:role/${deniedRoleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: deniedRoleName,
      AssumeRolePolicyDocument: trust(
        allow(["sts:AssumeRole", "sts:TagSession"]),
        { Sid: "DenyTaggedSessions", Effect: "Deny", Principal: rootPrincipal, Action: "sts:TagSession" },
      ),
    }));
    const sessionsBeforeExplicitDeny = Object.keys(simulator.store.ensureAccount().iam.sessions).length;
    await assert.rejects(
      sts.send(new AssumeRoleCommand({ RoleArn: deniedRoleArn, RoleSessionName: "explicitly-denied", Tags: [{ Key: "course", Value: "aws" }] })),
      (error: any) => error.name.startsWith("AccessDenied") && /explicitly denies sts:TagSession/.test(error.message),
    );
    assert.equal(Object.keys(simulator.store.ensureAccount().iam.sessions).length, sessionsBeforeExplicitDeny, "an explicit TagSession deny must override an allow and mint no credentials");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
