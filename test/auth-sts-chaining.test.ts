import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const rootTrust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }] });

function sessionClient(endpoint: string, assumed: AssumeRoleCommandOutput): STSClient {
  return new STSClient({ endpoint, region, maxAttempts: 1, credentials: {
    accessKeyId: assumed.Credentials!.AccessKeyId!,
    secretAccessKey: assumed.Credentials!.SecretAccessKey!,
    sessionToken: assumed.Credentials!.SessionToken!,
  } });
}

test("IAMGAP-02 role ARN trusts and aws:PrincipalArn conditions match role sessions, including role paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap02-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam, sts);

    const exercise = async (suffix: string, path?: string) => {
      const caller = await iam.send(new CreateRoleCommand({ RoleName: `chain-caller-${suffix}`, Path: path, AssumeRolePolicyDocument: rootTrust }));
      const callerArn = caller.Role!.Arn!;
      const targetArn = `arn:aws:iam::${accountId}:role/chain-target-${suffix}`;
      await iam.send(new CreateRoleCommand({
        RoleName: `chain-target-${suffix}`,
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
          Effect: "Allow",
          Principal: { AWS: callerArn },
          Action: "sts:AssumeRole",
          Condition: { StringEquals: { "aws:PrincipalArn": callerArn } },
        }] }),
      }));
      await iam.send(new PutRolePolicyCommand({
        RoleName: `chain-caller-${suffix}`,
        PolicyName: "chain",
        PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: targetArn }] }),
      }));
      const firstHop = await sts.send(new AssumeRoleCommand({ RoleArn: callerArn, RoleSessionName: `first-${suffix}` }));
      const chained = sessionClient(endpoint, firstHop);
      clients.push(chained);
      const secondHop = await chained.send(new AssumeRoleCommand({ RoleArn: targetArn, RoleSessionName: `second-${suffix}` }));
      assert.match(secondHop.AssumedRoleUser!.Arn!, new RegExp(`assumed-role/chain-target-${suffix}/second-${suffix}$`));
      return targetArn;
    };

    const targetArn = await exercise("plain");
    await exercise("path", "/division/team/");

    const unrelated = await iam.send(new CreateRoleCommand({ RoleName: "chain-unrelated", AssumeRolePolicyDocument: rootTrust }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "chain-unrelated",
      PolicyName: "chain",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: targetArn }] }),
    }));
    const unrelatedSession = sessionClient(endpoint, await sts.send(new AssumeRoleCommand({ RoleArn: unrelated.Role!.Arn!, RoleSessionName: "unrelated" })));
    clients.push(unrelatedSession);
    await assert.rejects(
      unrelatedSession.send(new AssumeRoleCommand({ RoleArn: targetArn, RoleSessionName: "must-deny" })),
      (error: any) => error.name.startsWith("AccessDenied"),
    );
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("IAMGAP-03 transitive tags survive restart, chain automatically, and override role tags downstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap03-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    let sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam, sts);
    const firstArn = `arn:aws:iam::${accountId}:role/transitive-first`;
    const secondArn = `arn:aws:iam::${accountId}:role/transitive-second`;
    const thirdArn = `arn:aws:iam::${accountId}:role/transitive-third`;
    const taggedTrust = (principalArn: string, resourceTag = false) => JSON.stringify({ Version: "2012-10-17", Statement: [{
      Effect: "Allow",
      Principal: { AWS: principalArn },
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Condition: { StringEquals: {
        "aws:PrincipalTag/team": "a",
        ...(resourceTag ? { "aws:ResourceTag/team": "target" } : {}),
      } },
    }] });
    await iam.send(new CreateRoleCommand({
      RoleName: "transitive-first",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" },
        { Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:TagSession" },
      ] }),
    }));
    await iam.send(new CreateRoleCommand({ RoleName: "transitive-second", AssumeRolePolicyDocument: taggedTrust(firstArn, true), Tags: [{ Key: "team", Value: "target" }] }));
    await iam.send(new CreateRoleCommand({ RoleName: "transitive-third", AssumeRolePolicyDocument: taggedTrust(secondArn) }));
    for (const [roleName, resourceArn] of [["transitive-first", secondArn], ["transitive-second", thirdArn]] as const) {
      await iam.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: "chain-with-tags",
        PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Resource: resourceArn }] }),
      }));
    }
    const firstHop = await sts.send(new AssumeRoleCommand({
      RoleArn: firstArn,
      RoleSessionName: "transitive-one",
      Tags: [{ Key: "team", Value: "a" }],
      TransitiveTagKeys: ["team"],
    }));
    const firstCredentials = {
      accessKeyId: firstHop.Credentials!.AccessKeyId!,
      secretAccessKey: firstHop.Credentials!.SecretAccessKey!,
      sessionToken: firstHop.Credentials!.SessionToken!,
    };
    clients.forEach(client => client.destroy());
    clients.length = 0;
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    const firstSession = new STSClient({ endpoint, region, credentials: firstCredentials, maxAttempts: 1 });
    clients.push(iam, sts, firstSession);
    assert.deepEqual((simulator.store.ensureAccount().iam.sessions[firstCredentials.accessKeyId] as any).transitiveTagKeys, ["team"]);
    await assert.rejects(
      firstSession.send(new AssumeRoleCommand({ RoleArn: secondArn, RoleSessionName: "collision", Tags: [{ Key: "TEAM", Value: "b" }] })),
      (error: any) => error.name.startsWith("Validation") && /inherited transitive tag/i.test(error.message),
    );
    const secondHop = await firstSession.send(new AssumeRoleCommand({ RoleArn: secondArn, RoleSessionName: "transitive-two" }));
    const secondAccessKey = secondHop.Credentials!.AccessKeyId!;
    assert.deepEqual(simulator.store.ensureAccount().iam.sessions[secondAccessKey].sessionTags, { team: "a" });
    assert.deepEqual((simulator.store.ensureAccount().iam.sessions[secondAccessKey] as any).transitiveTagKeys, ["team"]);
    const secondSession = sessionClient(endpoint, secondHop);
    clients.push(secondSession);
    const thirdHop = await secondSession.send(new AssumeRoleCommand({ RoleArn: thirdArn, RoleSessionName: "transitive-three" }));
    assert.match(thirdHop.AssumedRoleUser!.Arn!, /assumed-role\/transitive-third\/transitive-three$/);

    const missingTrustArn = `arn:aws:iam::${accountId}:role/transitive-missing-trust`;
    await iam.send(new CreateRoleCommand({
      RoleName: "transitive-missing-trust",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { AWS: firstArn }, Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:PrincipalTag/team": "a" } },
      }] }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "transitive-first",
      PolicyName: "missing-trust-check",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Resource: missingTrustArn }] }),
    }));
    await assert.rejects(
      firstSession.send(new AssumeRoleCommand({ RoleArn: missingTrustArn, RoleSessionName: "missing-trust" })),
      (error: any) => error.name.startsWith("AccessDenied") && /does not allow sts:TagSession/.test(error.message),
    );

    const missingCallerArn = `arn:aws:iam::${accountId}:role/transitive-missing-caller`;
    const missingCallerTargetArn = `arn:aws:iam::${accountId}:role/transitive-missing-caller-target`;
    await iam.send(new CreateRoleCommand({
      RoleName: "transitive-missing-caller",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: ["sts:AssumeRole", "sts:TagSession"] },
      ] }),
    }));
    await iam.send(new CreateRoleCommand({ RoleName: "transitive-missing-caller-target", AssumeRolePolicyDocument: taggedTrust(missingCallerArn) }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "transitive-missing-caller",
      PolicyName: "assume-only",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: missingCallerTargetArn }] }),
    }));
    const missingCallerFirst = await sts.send(new AssumeRoleCommand({
      RoleArn: missingCallerArn,
      RoleSessionName: "missing-caller-first",
      Tags: [{ Key: "team", Value: "a" }],
      TransitiveTagKeys: ["team"],
    }));
    const missingCallerSession = sessionClient(endpoint, missingCallerFirst);
    clients.push(missingCallerSession);
    await assert.rejects(
      missingCallerSession.send(new AssumeRoleCommand({ RoleArn: missingCallerTargetArn, RoleSessionName: "missing-caller-second" })),
      (error: any) => error.name.startsWith("AccessDenied") && /sts:TagSession/.test(error.message),
    );
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("IAMGAP-11 source identity requires two-sided permission and is immutable across restart and chaining", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap11-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    let sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam, sts);

    const missingTrustArn = `arn:aws:iam::${accountId}:role/source-missing-trust`;
    await iam.send(new CreateRoleCommand({ RoleName: "source-missing-trust", AssumeRolePolicyDocument: rootTrust }));
    await assert.rejects(
      sts.send(new AssumeRoleCommand({ RoleArn: missingTrustArn, RoleSessionName: "missing-trust", SourceIdentity: "origin" })),
      (error: any) => error.name.startsWith("AccessDenied") && /sts:SetSourceIdentity/.test(error.message),
    );

    const firstArn = `arn:aws:iam::${accountId}:role/source-first`;
    const secondArn = `arn:aws:iam::${accountId}:role/source-second`;
    const thirdArn = `arn:aws:iam::${accountId}:role/source-third`;
    const sourceTrust = (principalArn: string) => JSON.stringify({ Version: "2012-10-17", Statement: [{
      Effect: "Allow",
      Principal: { AWS: principalArn },
      Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      Condition: { StringEquals: { "sts:SourceIdentity": "origin" } },
    }] });
    await iam.send(new CreateRoleCommand({
      RoleName: "source-first",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: ["sts:AssumeRole", "sts:SetSourceIdentity"] }] }),
    }));
    await iam.send(new CreateRoleCommand({ RoleName: "source-second", AssumeRolePolicyDocument: sourceTrust(firstArn) }));
    await iam.send(new CreateRoleCommand({ RoleName: "source-third", AssumeRolePolicyDocument: sourceTrust(secondArn) }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "source-first",
      PolicyName: "source-chain",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole", "sts:SetSourceIdentity"], Resource: secondArn }] }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "source-second",
      PolicyName: "source-chain",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: ["sts:AssumeRole", "sts:SetSourceIdentity"], Resource: thirdArn,
        Condition: { StringEquals: { "aws:SourceIdentity": "origin" } },
      }] }),
    }));
    for (const invalid of ["a", "aws:reserved", "AWS:reserved", "invalid/value"]) {
      await assert.rejects(
        sts.send(new AssumeRoleCommand({ RoleArn: firstArn, RoleSessionName: "invalid-source", SourceIdentity: invalid })),
        (error: any) => error.name.startsWith("Validation"),
      );
    }
    const firstHop = await sts.send(new AssumeRoleCommand({ RoleArn: firstArn, RoleSessionName: "source-one", SourceIdentity: "origin" }));
    const firstCredentials = {
      accessKeyId: firstHop.Credentials!.AccessKeyId!,
      secretAccessKey: firstHop.Credentials!.SecretAccessKey!,
      sessionToken: firstHop.Credentials!.SessionToken!,
    };
    clients.forEach(client => client.destroy());
    clients.length = 0;
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    const firstSession = new STSClient({ endpoint, region, credentials: firstCredentials, maxAttempts: 1 });
    clients.push(iam, sts, firstSession);
    assert.equal(simulator.store.ensureAccount().iam.sessions[firstCredentials.accessKeyId].sourceIdentity, "origin");
    await assert.rejects(
      firstSession.send(new AssumeRoleCommand({ RoleArn: secondArn, RoleSessionName: "source-different", SourceIdentity: "different" })),
      (error: any) => error.name.startsWith("Validation") && /source identity/i.test(error.message),
    );
    const equalHop = await firstSession.send(new AssumeRoleCommand({ RoleArn: secondArn, RoleSessionName: "source-equal", SourceIdentity: "origin" }));
    assert.equal(equalHop.SourceIdentity, "origin");
    const secondHop = await firstSession.send(new AssumeRoleCommand({ RoleArn: secondArn, RoleSessionName: "source-omitted" }));
    assert.equal(secondHop.SourceIdentity, "origin");
    const secondAccessKey = secondHop.Credentials!.AccessKeyId!;
    assert.equal(simulator.store.ensureAccount().iam.sessions[secondAccessKey].sourceIdentity, "origin");
    const secondSession = sessionClient(endpoint, secondHop);
    clients.push(secondSession);
    const thirdHop = await secondSession.send(new AssumeRoleCommand({ RoleArn: thirdArn, RoleSessionName: "source-three" }));
    assert.equal(thirdHop.SourceIdentity, "origin");

    const missingCallerTargetArn = `arn:aws:iam::${accountId}:role/source-missing-caller`;
    await iam.send(new CreateRoleCommand({ RoleName: "source-missing-caller", AssumeRolePolicyDocument: sourceTrust(firstArn) }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "source-first",
      PolicyName: "source-assume-only",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: missingCallerTargetArn }] }),
    }));
    await assert.rejects(
      firstSession.send(new AssumeRoleCommand({ RoleArn: missingCallerTargetArn, RoleSessionName: "source-no-caller-permission" })),
      (error: any) => error.name.startsWith("AccessDenied") && /sts:SetSourceIdentity/.test(error.message),
    );
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
