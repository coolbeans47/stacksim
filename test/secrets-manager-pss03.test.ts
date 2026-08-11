import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchGetSecretValueCommand,
  CreateSecretCommand,
  DeleteResourcePolicyCommand,
  GetResourcePolicyCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  PutResourcePolicyCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
  ValidateResourcePolicyCommand,
} from "@aws-sdk/client-secrets-manager";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const token = (digit: string) => digit.repeat(32);

test("PSS-03 custom stages, rollback, batch modes, policies, and restart preserve safe invariants", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss03-secrets-"));
  const marker = `pss03-secret-${crypto.randomUUID()}`;
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let secrets: SecretsManagerClient | undefined;
  let iam: IAMClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    secrets = new SecretsManagerClient({ endpoint, region, credentials, maxAttempts: 1 });
    iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    const created = await secrets.send(new CreateSecretCommand({ Name: "pss03/main", SecretString: marker, ClientRequestToken: token("1"), Tags: [{ Key: "slice", Value: "pss03" }] }));
    await secrets.send(new PutSecretValueCommand({ SecretId: created.ARN, SecretString: "candidate", ClientRequestToken: token("2"), VersionStages: ["CANDIDATE"] }));
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, marker);
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "CANDIDATE" }))).SecretString, "candidate");

    await secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "AWSCURRENT", RemoveFromVersionId: token("1"), MoveToVersionId: token("2") }));
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "AWSCURRENT" }))).VersionId, token("2"));
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "AWSPREVIOUS" }))).VersionId, token("1"));
    await secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "AWSCURRENT", RemoveFromVersionId: token("2"), MoveToVersionId: token("1") }));
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, marker);
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "AWSPREVIOUS" }))).VersionId, token("2"));
    const stageSave = simulator.store.save.bind(simulator.store);
    let failStageSave = true;
    (simulator.store as any).save = async () => {
      if (failStageSave) { failStageSave = false; throw new Error("injected PSS-03 stage commit failure"); }
      await stageSave();
    };
    await assert.rejects(secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "AWSCURRENT", RemoveFromVersionId: token("1"), MoveToVersionId: token("2") })));
    (simulator.store as any).save = stageSave;
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "AWSCURRENT" }))).VersionId, token("1"));
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "AWSPREVIOUS" }))).VersionId, token("2"));
    await secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "CANDIDATE", RemoveFromVersionId: token("2") }));
    await assert.rejects(secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "CANDIDATE" })), (error: any) => error.name === "ResourceNotFoundException");

    const twentyStages = Array.from({ length: 20 }, (_, index) => `CUSTOM_${index}`);
    await secrets.send(new PutSecretValueCommand({ SecretId: created.ARN, SecretString: "staged", ClientRequestToken: token("3"), VersionStages: twentyStages }));
    await assert.rejects(secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "CUSTOM_20", MoveToVersionId: token("3") })), (error: any) => error.name === "LimitExceededException");

    await secrets.send(new PutSecretValueCommand({ SecretId: created.ARN, SecretString: "race-target", ClientRequestToken: token("5"), VersionStages: ["SPARE"] }));
    await secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "SPARE", RemoveFromVersionId: token("5") }));
    await secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "RACE", MoveToVersionId: token("1") }));
    const raced = await Promise.allSettled([
      secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "RACE", RemoveFromVersionId: token("1"), MoveToVersionId: token("2") })),
      secrets.send(new UpdateSecretVersionStageCommand({ SecretId: created.ARN, VersionStage: "RACE", RemoveFromVersionId: token("1"), MoveToVersionId: token("5") })),
    ]);
    assert.equal(raced.filter(result => result.status === "fulfilled").length, 1);
    const afterRace = await secrets.send(new ListSecretVersionIdsCommand({ SecretId: created.ARN, IncludeDeprecated: true }));
    assert.equal(afterRace.Versions?.filter(version => version.VersionStages?.includes("RACE")).length, 1);

    await secrets.send(new CreateSecretCommand({ Name: "pss03/other", SecretString: "other", ClientRequestToken: token("4"), Tags: [{ Key: "slice", Value: "pss03" }] }));
    const byId = await secrets.send(new BatchGetSecretValueCommand({ SecretIdList: [created.ARN!, "pss03/missing"] }));
    assert.deepEqual(byId.SecretValues?.map(value => [value.Name, value.SecretString]), [["pss03/main", marker]]);
    assert.deepEqual(byId.Errors?.map(error => [error.SecretId, error.ErrorCode]), [["pss03/missing", "ResourceNotFoundException"]]);
    const pageOne = await secrets.send(new BatchGetSecretValueCommand({ Filters: [{ Key: "tag-key", Values: ["slice"] }], MaxResults: 1 }));
    assert.equal(pageOne.SecretValues?.length, 1);
    assert.ok(pageOne.NextToken);
    const pageTwo = await secrets.send(new BatchGetSecretValueCommand({ Filters: [{ Key: "tag-key", Values: ["slice"] }], MaxResults: 1, NextToken: pageOne.NextToken }));
    assert.equal(pageTwo.SecretValues?.length, 1);
    assert.notEqual(pageOne.SecretValues?.[0]?.Name, pageTwo.SecretValues?.[0]?.Name);

    const role = await iam.send(new CreateRoleCommand({ RoleName: "pss03-reader", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }) }));
    const policy = ` { "Version": "2012-10-17", "Statement": [{ "Sid": "Read", "Effect": "Allow", "Principal": { "AWS": "${role.Role!.Arn}" }, "Action": "secretsmanager:GetSecretValue", "Resource": "${created.ARN}" }] } `;
    const valid = await secrets.send(new ValidateResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policy }));
    assert.equal(valid.PolicyValidationPassed, true);
    await secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policy, BlockPublicPolicy: true }));
    assert.equal((await secrets.send(new GetResourcePolicyCommand({ SecretId: created.ARN }))).ResourcePolicy, policy);

    const policyTwo = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "Describe", Effect: "Allow", Principal: { AWS: role.Role!.Arn }, Action: "secretsmanager:DescribeSecret", Resource: created.ARN }] });
    await Promise.all([
      secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policy, BlockPublicPolicy: true })),
      secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policyTwo, BlockPublicPolicy: true })),
    ]);
    const concurrentPolicy = await secrets.send(new GetResourcePolicyCommand({ SecretId: created.ARN }));
    assert.ok([policy, policyTwo].includes(concurrentPolicy.ResourcePolicy!));
    assert.equal(simulator.secretsmanager.resourcePolicy(created.ARN)?.revision, 3);

    const save = simulator.store.save.bind(simulator.store);
    let failSave = true;
    (simulator.store as any).save = async () => {
      if (failSave) { failSave = false; throw new Error("injected PSS-03 policy commit failure"); }
      await save();
    };
    await assert.rejects(secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policy, BlockPublicPolicy: true })));
    (simulator.store as any).save = save;
    assert.equal((await secrets.send(new GetResourcePolicyCommand({ SecretId: created.ARN }))).ResourcePolicy, concurrentPolicy.ResourcePolicy);
    assert.equal(simulator.secretsmanager.resourcePolicy(created.ARN)?.revision, 3);

    await secrets.send(new DeleteResourcePolicyCommand({ SecretId: created.ARN }));
    assert.equal((await secrets.send(new GetResourcePolicyCommand({ SecretId: created.ARN }))).ResourcePolicy, undefined);
    const accountPolicy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "000000000000" }, Action: "secretsmanager:DescribeSecret", Resource: created.ARN }] });
    await secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: accountPolicy, BlockPublicPolicy: true }));
    const normalizedStatement = simulator.secretsmanager.resourcePolicy(created.ARN)?.normalized.Statement as any[];
    assert.equal(normalizedStatement[0].Principal.AWS, "arn:aws:iam::000000000000:root");
    await secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policy, BlockPublicPolicy: true }));

    const publicPolicy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "secretsmanager:GetSecretValue", Resource: created.ARN }] });
    const publicValidation = await secrets.send(new ValidateResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: publicPolicy }));
    assert.equal(publicValidation.PolicyValidationPassed, false);
    assert.equal(publicValidation.ValidationErrors?.[0]?.CheckName, "PUBLIC_POLICY_CHECK");
    await assert.rejects(secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: publicPolicy, BlockPublicPolicy: true })), (error: any) => error.name === "PublicPolicyException");
    for (const invalidPolicy of [
      JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::111111111111:role/foreign" }, Action: "secretsmanager:GetSecretValue", Resource: created.ARN }] }),
      JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: "arn:aws:iam::000000000000:saml-provider/example" }, Action: "secretsmanager:GetSecretValue", Resource: created.ARN }] }),
      JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "secretsmanager:GetSecretValue", Resource: created.ARN }] }),
      `{"Version":"2012-10-17","Version":"2012-10-17","Statement":[]}`,
    ]) await assert.rejects(secrets.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: invalidPolicy })), (error: any) => error.name === "MalformedPolicyDocumentException");

    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), new RegExp(marker));
    secrets.destroy(); iam.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
    await simulator.start();
    secrets = new SecretsManagerClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, marker);
    assert.equal((await secrets.send(new GetResourcePolicyCommand({ SecretId: created.ARN }))).ResourcePolicy, policy);
    assert.equal(simulator.secretsmanager.resourcePolicy(created.ARN)?.revision, 6);
    const versions = await secrets.send(new ListSecretVersionIdsCommand({ SecretId: created.ARN, IncludeDeprecated: true }));
    assert.equal(versions.Versions?.filter(version => version.VersionStages?.includes("AWSCURRENT")).length, 1);
    assert.equal(versions.Versions?.filter(version => version.VersionStages?.includes("RACE")).length, 1);
  } finally {
    secrets?.destroy();
    iam?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("PSS-03 configured-account resource grants authorize reads while explicit identity deny wins per batch item", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-pss03-policy-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const admin = new SecretsManagerClient(options);
    const iam = new IAMClient(options);
    const sts = new STSClient(options);
    clients.push(admin, iam, sts);
    const marker = `resource-grant-${crypto.randomUUID()}`;
    const created = await admin.send(new CreateSecretCommand({ Name: "pss03/policy-grant", SecretString: marker, ClientRequestToken: token("8"), Tags: [{ Key: "grant", Value: "yes" }] }));
    const role = await iam.send(new CreateRoleCommand({ RoleName: "pss03-resource-reader", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }) }));
    await iam.send(new PutRolePolicyCommand({ RoleName: "pss03-resource-reader", PolicyName: "batch", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["secretsmanager:BatchGetSecretValue", "secretsmanager:ListSecrets"], Resource: "*" }] }) }));
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: role.Role!.Arn }, Action: "secretsmanager:GetSecretValue", Resource: created.ARN, Condition: { StringEquals: { "aws:PrincipalAccount": "000000000000" } } }] });
    await admin.send(new PutResourcePolicyCommand({ SecretId: created.ARN, ResourcePolicy: policy, BlockPublicPolicy: true }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: role.Role!.Arn!, RoleSessionName: "pss03-reader" }));
    const reader = new SecretsManagerClient({ endpoint, region, maxAttempts: 1, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } });
    clients.push(reader);
    assert.equal((await reader.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString, marker);
    assert.equal((await reader.send(new BatchGetSecretValueCommand({ SecretIdList: [created.ARN!] }))).SecretValues?.[0]?.SecretString, marker);
    assert.equal((await reader.send(new BatchGetSecretValueCommand({ Filters: [{ Key: "tag-key", Values: ["grant"] }] }))).SecretValues?.[0]?.SecretString, marker);

    await iam.send(new PutRolePolicyCommand({ RoleName: "pss03-resource-reader", PolicyName: "batch", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["secretsmanager:BatchGetSecretValue", "secretsmanager:ListSecrets"], Resource: "*" },
      { Effect: "Deny", Action: "secretsmanager:GetSecretValue", Resource: created.ARN },
    ] }) }));
    await assert.rejects(reader.send(new GetSecretValueCommand({ SecretId: created.ARN })), (error: any) => error.name === "AccessDeniedException");
    const denied = await reader.send(new BatchGetSecretValueCommand({ SecretIdList: [created.ARN!] }));
    assert.equal(denied.SecretValues?.length, 0);
    assert.equal(denied.Errors?.[0]?.ErrorCode, "AccessDeniedException");
    assert.doesNotMatch(JSON.stringify(denied.Errors), new RegExp(marker));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
