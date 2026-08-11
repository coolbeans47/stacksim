import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  GetTemplateSummaryCommand,
  UpdateStackCommand,
  ValidateTemplateCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  IAMClient,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFormationService } from "../src/cloudformation.js";
import { cdkBootstrapNames } from "../src/cloudformation/bootstrap.js";
import { SystemClock } from "../src/core/clock.js";
import { S3Service } from "../src/s3.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";

const accountId = "000000000000";
const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };

function metadataTemplate(release: string): string {
  return JSON.stringify({
    Description: `TemplateURL authorization ${release}`,
    Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: release } } },
    Outputs: { Release: { Value: release } },
  });
}

async function waitForStack(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

async function waitForChangeSet(client: CloudFormationClient, id: string): Promise<any> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await client.send(new DescribeChangeSetCommand({ ChangeSetName: id }));
    if (result.Status === "CREATE_COMPLETE" || result.Status === "FAILED") return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for change set ${id}`);
}

test("CloudFormationService does not bypass its provider authorizer for TemplateURL", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfngap01-service-auth-"));
  const clock = new SystemClock();
  const store = new StateStore(root, accountId, region);
  let cloudformation: CloudFormationService | undefined;
  try {
    await store.load();
    const s3 = new S3Service(store, region, clock);
    await s3.start();
    await s3.createBucketInternal({ name: "cfngap01-service-templates", versioning: "unversioned", encryption: "AES256" });
    await s3.putObjectBytesInternal("cfngap01-service-templates", "template.json", Buffer.from(metadataTemplate("service")));
    const principal: PrincipalContext = {
      principalType: "user",
      accessKeyId: "denied",
      principalArn: `arn:aws:iam::${accountId}:user/denied`,
      principalId: "denied",
      accountId,
      userName: "denied",
      userId: "denied",
    };
    cloudformation = new CloudFormationService(store, region, clock, s3, undefined, [], async (actual, targets) => {
      assert.equal(actual.principalArn, principal.principalArn);
      assert.deepEqual(targets, [{ action: "s3:GetObject", resource: "arn:aws:s3:::cfngap01-service-templates/template.json" }]);
      throw new Error("denied by focused TemplateURL authorizer");
    });
    await cloudformation.start();
    await assert.rejects(
      cloudformation.ValidateTemplate({ TemplateURL: "https://cfngap01-service-templates.s3.eu-west-1.amazonaws.com/template.json" }, principal),
      /denied by focused TemplateURL authorizer/,
    );
  } finally {
    await cloudformation?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("top-level TemplateURL reads use the caller or selected CloudFormation execution role", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfngap01-template-url-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const adminOptions = { endpoint, region, credentials: adminCredentials, maxAttempts: 1 };
    const iam = new IAMClient(adminOptions);
    const s3 = new S3Client({ ...adminOptions, forcePathStyle: true });
    clients.push(iam, s3);

    const bootstrap = cdkBootstrapNames(accountId, region);
    const uploaded: Record<string, string> = {};
    for (const release of ["update", "change-set"]) {
      const result = await s3.send(new PutObjectCommand({
        Bucket: bootstrap.bucketName,
        Key: `cfngap01/${release}.json`,
        Body: metadataTemplate(release),
      }));
      assert.ok(result.VersionId);
      uploaded[release] = result.VersionId!;
    }
    const child = await s3.send(new PutObjectCommand({
      Bucket: bootstrap.bucketName,
      Key: "cfngap01/child.json",
      Body: metadataTemplate("nested-child"),
    }));
    assert.ok(child.VersionId);
    const childUrl = `${endpoint}/${bootstrap.bucketName}/cfngap01/child.json?versionId=${encodeURIComponent(child.VersionId!)}`;
    const create = await s3.send(new PutObjectCommand({
      Bucket: bootstrap.bucketName,
      Key: "cfngap01/create.json",
      Body: JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: childUrl } } } }),
    }));
    assert.ok(create.VersionId);
    uploaded.create = create.VersionId!;
    const url = (release: string, versioned = false) => `${endpoint}/${bootstrap.bucketName}/cfngap01/${release}.json${versioned ? `?versionId=${encodeURIComponent(uploaded[release])}` : ""}`;

    const userName = "cfngap01-caller";
    await iam.send(new CreateUserCommand({ UserName: userName }));
    await iam.send(new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: "CloudFormationWithoutS3",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "cloudformation:CreateChangeSet",
              "cloudformation:CreateStack",
              "cloudformation:DescribeChangeSet",
              "cloudformation:DescribeStacks",
              "cloudformation:GetTemplateSummary",
              "cloudformation:UpdateStack",
              "cloudformation:ValidateTemplate",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: "iam:PassRole",
            Resource: bootstrap.roleArns.cloudFormationExecution,
            Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
          },
        ],
      }),
    }));
    const accessKey = (await iam.send(new CreateAccessKeyCommand({ UserName: userName }))).AccessKey!;
    assert.ok(accessKey.AccessKeyId && accessKey.SecretAccessKey);
    const caller = new CloudFormationClient({
      endpoint,
      region,
      credentials: { accessKeyId: accessKey.AccessKeyId!, secretAccessKey: accessKey.SecretAccessKey! },
      maxAttempts: 1,
    });
    clients.push(caller);

    for (const request of [
      () => caller.send(new ValidateTemplateCommand({ TemplateURL: url("create") })),
      () => caller.send(new GetTemplateSummaryCommand({ TemplateURL: url("create", true) })),
      () => caller.send(new CreateStackCommand({ StackName: "cfngap01-denied-create", TemplateURL: url("create") })),
    ]) {
      await assert.rejects(request(), error => /s3:GetObject(?:Version)?|AccessDenied/i.test((error as Error).message));
    }
    assert.equal(simulator.store.regionState(region).cloudformation.stackNames["cfngap01-denied-create"], undefined);

    const created = await caller.send(new CreateStackCommand({
      StackName: "cfngap01-role-create",
      TemplateURL: url("create"),
      RoleARN: bootstrap.roleArns.cloudFormationExecution,
    }));
    await waitForStack(caller, created.StackId!, "CREATE_COMPLETE");

    const updateBase = await caller.send(new CreateStackCommand({
      StackName: "cfngap01-update",
      TemplateBody: metadataTemplate("initial"),
    }));
    await waitForStack(caller, updateBase.StackId!, "CREATE_COMPLETE");

    await assert.rejects(
      caller.send(new UpdateStackCommand({ StackName: updateBase.StackId, TemplateURL: url("update", true) })),
      error => /s3:GetObjectVersion|AccessDenied/i.test((error as Error).message),
    );

    const deniedChangeSet = await caller.send(new CreateChangeSetCommand({
      StackName: updateBase.StackId,
      ChangeSetName: "cfngap01-denied-plan",
      ChangeSetType: "UPDATE",
      TemplateURL: url("change-set", true),
    }));
    const deniedPlan = await waitForChangeSet(caller, deniedChangeSet.Id!);
    assert.equal(deniedPlan.Status, "FAILED");
    assert.match(deniedPlan.StatusReason ?? "", /s3:GetObjectVersion|AccessDenied/i);

    const allowedChangeSet = await caller.send(new CreateChangeSetCommand({
      StackName: updateBase.StackId,
      ChangeSetName: "cfngap01-role-plan",
      ChangeSetType: "UPDATE",
      TemplateURL: url("change-set", true),
      RoleARN: bootstrap.roleArns.cloudFormationExecution,
    }));
    assert.equal((await waitForChangeSet(caller, allowedChangeSet.Id!)).Status, "CREATE_COMPLETE");

    await caller.send(new UpdateStackCommand({
      StackName: updateBase.StackId,
      TemplateURL: url("update", true),
      RoleARN: bootstrap.roleArns.cloudFormationExecution,
    }));
    await waitForStack(caller, updateBase.StackId!, "UPDATE_COMPLETE");

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions;
    const callerArn = `arn:aws:iam::${accountId}:user/${userName}`;
    assert.ok(decisions.some(decision => decision.principalArn === callerArn && decision.action === "s3:GetObject" && decision.decision !== "allowed"));
    assert.ok(decisions.some(decision => decision.principalArn === callerArn && decision.action === "s3:GetObjectVersion" && decision.decision !== "allowed"));
    assert.ok(decisions.some(decision => decision.principalArn.includes(`assumed-role/${bootstrap.roleNames.cloudFormationExecution}/`) && decision.action === "s3:GetObject" && decision.decision === "allowed"));
    assert.ok(decisions.some(decision => decision.principalArn.includes(`assumed-role/${bootstrap.roleNames.cloudFormationExecution}/`) && decision.action === "s3:GetObjectVersion" && decision.decision === "allowed"));
    assert.ok(decisions.some(decision => decision.principalArn.includes(`assumed-role/${bootstrap.roleNames.cloudFormationExecution}/`) && decision.resource.endsWith("/cfngap01/child.json") && decision.action === "s3:GetObjectVersion" && decision.decision === "allowed"));
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
