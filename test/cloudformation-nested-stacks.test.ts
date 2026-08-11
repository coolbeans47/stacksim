import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CloudFormationService } from "../src/cloudformation.js";
import { TestClock } from "../src/core/clock.js";
import { S3Service } from "../src/s3.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";
import { waitUntil } from "./support/polling.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const principal: PrincipalContext = { accessKeyId: "admin", principalArn: "arn:aws:iam::000000000000:root", principalId: "000000000000", accountId: "000000000000" };

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<any> {
  return waitUntil(
    async () => (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0],
    stack => stack?.StackStatus === expected,
    { timeoutMessage: stack => `Timed out waiting for ${stackName} to reach ${expected}; current=${stack?.StackStatus} reason=${stack?.StackStatusReason}` },
  );
}

function parentTemplate(templateUrl: string, message: string, deletionPolicy?: "Retain"): string {
  return JSON.stringify({
    Resources: {
      Child: {
        Type: "AWS::CloudFormation::Stack",
        ...(deletionPolicy ? { DeletionPolicy: deletionPolicy, UpdateReplacePolicy: deletionPolicy } : {}),
        Properties: {
          TemplateURL: templateUrl,
          Parameters: { Message: message },
          Tags: [{ Key: "Feature", Value: "nested-stacks" }],
        },
      },
    },
    Outputs: {
      ChildId: { Value: { Ref: "Child" } },
      ChildMessage: { Value: { "Fn::GetAtt": ["Child", "Outputs.Message"] } },
    },
  });
}

test("nested stacks create, expose outputs, update in place, and delete with their root", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-nested-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);

    const grandchildTemplate = JSON.stringify({
      Parameters: { Message: { Type: "String" } },
      Resources: { Metadata: { Type: "AWS::CDK::Metadata" } },
      Outputs: { Message: { Value: { Ref: "Message" } } },
    });
    await s3.send(new CreateBucketCommand({ Bucket: "nested-stack-templates" }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: "nested-stack-templates", VersioningConfiguration: { Status: "Enabled" } }));
    await s3.send(new PutObjectCommand({ Bucket: "nested-stack-templates", Key: "grandchild.json", Body: grandchildTemplate }));
    const childTemplate = JSON.stringify({
      Parameters: { Message: { Type: "String" } },
      Resources: {
        Grandchild: {
          Type: "AWS::CloudFormation::Stack",
          Properties: {
            TemplateURL: "https://nested-stack-templates.s3.eu-west-1.amazonaws.com/grandchild.json",
            Parameters: { Message: { Ref: "Message" } },
          },
        },
      },
      Outputs: { Message: { Value: { "Fn::GetAtt": ["Grandchild", "Outputs.Message"] } } },
    });
    await s3.send(new PutObjectCommand({ Bucket: "nested-stack-templates", Key: "child.json", Body: childTemplate }));
    const templateUrl = "https://nested-stack-templates.s3.eu-west-1.amazonaws.com/child.json";

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "nested-root", TemplateBody: parentTemplate(templateUrl, "one") }));
    await s3.send(new PutObjectCommand({ Bucket: "nested-stack-templates", Key: "child.json", Body: JSON.stringify({ Parameters: { Message: { Type: "String" } }, Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Message: { Value: "mutated-after-admission" } } }) }));
    const rootStack = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const outputs = Object.fromEntries((rootStack.Outputs ?? []).map((output: { OutputKey?: string; OutputValue?: string }) => [output.OutputKey, output.OutputValue]));
    assert.equal(outputs.ChildMessage, "one");
    assert.match(outputs.ChildId, /^arn:aws:cloudformation:eu-west-1:000000000000:stack\/nested-root-Child-/);

    const childId = outputs.ChildId!;
    const child = (await cloudformation.send(new DescribeStacksCommand({ StackName: childId }))).Stacks?.[0];
    assert.equal(child?.ParentId, created.StackId);
    assert.equal(child?.RootId, created.StackId);
    assert.deepEqual(child?.Tags, [{ Key: "Feature", Value: "nested-stacks" }]);
    const resource = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Child" }))).StackResourceDetail;
    assert.equal(resource?.PhysicalResourceId, childId);
    const grandchildId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: childId, LogicalResourceId: "Grandchild" }))).StackResourceDetail?.PhysicalResourceId!;
    const grandchild = (await cloudformation.send(new DescribeStacksCommand({ StackName: grandchildId }))).Stacks?.[0];
    assert.equal(grandchild?.ParentId, childId);
    assert.equal(grandchild?.RootId, created.StackId);

    await s3.send(new PutObjectCommand({ Bucket: "nested-stack-templates", Key: "child.json", Body: childTemplate }));

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: parentTemplate(templateUrl, "two") }));
    const updated = await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    assert.equal(updated.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildMessage")?.OutputValue, "two");
    assert.equal(updated.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildId")?.OutputValue, childId, "nested updates preserve the child stack ID");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: childId }))).Stacks?.[0]?.Outputs?.[0]?.OutputValue, "two");

    await cloudformation.send(new DeleteStackCommand({ StackName: childId }));
    await waitForStatus(cloudformation, childId, "DELETE_COMPLETE");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: grandchildId }))).Stacks?.[0]?.StackStatus, "DELETE_COMPLETE");
    await assert.rejects(
      cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Child" })),
      /does not exist/i,
      "a directly deleted child must not remain success-shaped in its parent",
    );
    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: parentTemplate(templateUrl, "three") }));
    const reconciled = await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    const replacementChildId = reconciled.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildId")?.OutputValue;
    assert.ok(replacementChildId && replacementChildId !== childId, "the next parent update recreates a directly deleted child");
    assert.equal(reconciled.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildMessage")?.OutputValue, "three");

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: replacementChildId }))).Stacks?.[0]?.StackStatus, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("retained nested stacks detach and become independent roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-nested-retain-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    await s3.send(new CreateBucketCommand({ Bucket: "retained-nested-templates" }));
    await s3.send(new PutObjectCommand({ Bucket: "retained-nested-templates", Key: "child.json", Body: JSON.stringify({ Parameters: { Message: { Type: "String" } }, Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Message: { Value: "retained" } } }) }));
    const templateUrl = "https://retained-nested-templates.s3.eu-west-1.amazonaws.com/child.json";
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "retained-root", TemplateBody: parentTemplate(templateUrl, "unused", "Retain") }));
    const rootStack = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const childId = rootStack.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildId")?.OutputValue!;

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
    const retained = (await cloudformation.send(new DescribeStacksCommand({ StackName: childId }))).Stacks?.[0];
    assert.equal(retained?.StackStatus, "CREATE_COMPLETE");
    assert.equal(retained?.ParentId, undefined);
    assert.equal(retained?.RootId, undefined);

    await cloudformation.send(new DeleteStackCommand({ StackName: childId }));
    await waitForStatus(cloudformation, childId, "DELETE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a child update failure rolls the root hierarchy back to the pinned child template", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-nested-rollback-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    await s3.send(new CreateBucketCommand({ Bucket: "rollback-nested-templates" }));
    const goodChild = JSON.stringify({ Parameters: { Message: { Type: "String" } }, Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Message: { Value: { Ref: "Message" } } } });
    await s3.send(new PutObjectCommand({ Bucket: "rollback-nested-templates", Key: "child.json", Body: goodChild }));
    const templateUrl = "https://rollback-nested-templates.s3.eu-west-1.amazonaws.com/child.json";
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "rollback-root", TemplateBody: parentTemplate(templateUrl, "one") }));
    const initial = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const childId = initial.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildId")?.OutputValue!;

    await s3.send(new PutObjectCommand({ Bucket: "rollback-nested-templates", Key: "child.json", Body: JSON.stringify({ Parameters: { Message: { Type: "String" } }, Resources: { Unsupported: { Type: "AWS::EC2::Instance" } } }) }));
    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: parentTemplate(templateUrl, "two") }));
    const rolledBack = await waitForStatus(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    assert.equal(rolledBack.Outputs?.find((output: { OutputKey?: string }) => output.OutputKey === "ChildMessage")?.OutputValue, "one");
    const child = (await cloudformation.send(new DescribeStacksCommand({ StackName: childId }))).Stacks?.[0];
    assert.equal(child?.StackStatus, "CREATE_COMPLETE");
    assert.equal(child?.Outputs?.find(output => output.OutputKey === "Message")?.OutputValue, "one");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("IncludeNestedStacks creates linked child plans that execute only from the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-nested-changeset-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    await s3.send(new CreateBucketCommand({ Bucket: "changeset-nested-templates" }));
    await s3.send(new PutObjectCommand({ Bucket: "changeset-nested-templates", Key: "child.json", Body: JSON.stringify({ Parameters: { Message: { Type: "String" } }, Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Message: { Value: { Ref: "Message" } } } }) }));
    const templateUrl = "https://changeset-nested-templates.s3.eu-west-1.amazonaws.com/child.json";
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "changeset-root", TemplateBody: parentTemplate(templateUrl, "one") }));
    const initial = await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const childId = initial.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "ChildId")?.OutputValue!;

    const planned = await cloudformation.send(new CreateChangeSetCommand({
      StackName: created.StackId,
      ChangeSetName: "nested-update",
      ChangeSetType: "UPDATE",
      IncludeNestedStacks: true,
      TemplateBody: parentTemplate(templateUrl, "two"),
    }));
    const rootPlan = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id, StackName: created.StackId }));
    assert.equal(rootPlan.Status, "CREATE_COMPLETE");
    const linkedId = rootPlan.Changes?.find(change => change.ResourceChange?.LogicalResourceId === "Child")?.ResourceChange?.ChangeSetId;
    assert.ok(linkedId, "root nested resource change should link to its child plan");
    const childPlan = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: linkedId, StackName: childId }));
    assert.equal(childPlan.ParentChangeSetId, planned.Id);
    assert.equal(childPlan.RootChangeSetId, planned.Id);
    assert.equal(childPlan.ExecutionStatus, "UNAVAILABLE");
    await assert.rejects(
      cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: linkedId, StackName: childId })),
      (error: any) => error?.name === "InvalidChangeSetStatusException",
    );

    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id, StackName: created.StackId }));
    const updated = await waitForStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    assert.equal(updated.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "ChildMessage")?.OutputValue, "two");
    const executedChildPlan = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: linkedId, StackName: childId }));
    assert.equal(executedChildPlan.ExecutionStatus, "EXECUTE_COMPLETE");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a parent waiting on a completed child resumes after process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-nested-restart-"));
  const clock = new TestClock(50_000);
  let first: CloudFormationService | undefined;
  let restarted: CloudFormationService | undefined;
  try {
    const firstStore = new StateStore(root, "000000000000", "eu-west-1");
    await firstStore.load();
    const firstS3 = new S3Service(firstStore, "eu-west-1", clock);
    await firstS3.start();
    await firstS3.createBucketInternal({ name: "restart-nested-templates", versioning: "unversioned", encryption: "AES256" });
    await firstS3.putObjectBytesInternal("restart-nested-templates", "child.json", Buffer.from(JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Ready: { Value: "yes" } } })));
    first = new CloudFormationService(firstStore, "eu-west-1", clock, firstS3);
    await first.start();
    const created = await first.CreateStack({ StackName: "restart-root", TemplateBody: JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "https://restart-nested-templates.s3.eu-west-1.amazonaws.com/child.json" } } }, Outputs: { Ready: { Value: { "Fn::GetAtt": ["Child", "Outputs.Ready"] } } } }) }, principal);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = firstStore.regionState("eu-west-1").cloudformation;
      const children = Object.values(state.stacks).filter(stack => stack.parentId === created.StackId);
      if (children[0]?.stackStatus === "CREATE_COMPLETE" && state.stacks[created.StackId].stackStatus === "CREATE_IN_PROGRESS") break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(firstStore.regionState("eu-west-1").cloudformation.stacks[created.StackId].stackStatus, "CREATE_IN_PROGRESS");
    await first.stop();
    first = undefined;

    const restartedStore = new StateStore(root, "000000000000", "eu-west-1");
    await restartedStore.load();
    const restartedS3 = new S3Service(restartedStore, "eu-west-1", clock);
    await restartedS3.start();
    restarted = new CloudFormationService(restartedStore, "eu-west-1", clock, restartedS3);
    await restarted.start();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await restarted.DescribeStacks({ StackName: created.StackId })).Stacks[0].StackStatus === "CREATE_COMPLETE") break;
      if ((restarted as any).resumeTimers.size) clock.advance(25);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const completed = (await restarted.DescribeStacks({ StackName: created.StackId })).Stacks[0];
    assert.equal(completed.StackStatus, "CREATE_COMPLETE");
    assert.equal(completed.Outputs[0].OutputValue, "yes");
    const recoveredState = restartedStore.regionState("eu-west-1").cloudformation;
    const recoveredParent = recoveredState.stacks[created.StackId];
    const recoveredChild = recoveredState.stacks[recoveredParent.resources.Child.physicalResourceId!];
    assert.equal(recoveredChild.parentId, recoveredParent.stackId);
    assert.equal(recoveredChild.rootId, recoveredParent.stackId);
    assert.equal(recoveredChild.parentLogicalId, "Child");
    const admission = await (restarted as any).journal.readJsonArtifact("plans", `${recoveredParent.templateArtifactId}.nested-templates.json`);
    const recoveredChildSource = await (restarted as any).journal.readJsonArtifact("plans", `${recoveredChild.templateArtifactId}.template-source.json`);
    assert.equal(admission.schemaVersion, 2);
    assert.equal(admission.assets[0].childStackId, recoveredChild.stackId);
    assert.equal(admission.assets[0].versionId, recoveredChildSource.versionId);
    assert.equal(admission.assets[0].digest, recoveredChildSource.digest);
  } finally {
    await first?.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
