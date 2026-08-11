import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand } from "@aws-sdk/client-cloudformation";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function resources(count: number, prefix = "Metadata"): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}`, { Type: "AWS::CDK::Metadata" }]));
}

function outputs(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`Output${index}`, { Value: String(index) }]));
}

test("CFNGAP-06 enforces root and child per-template quotas plus the hierarchy aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfngap06-root-quotas-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    clients.push(cloudformation, s3);

    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "cfngap06-root-resources", TemplateBody: JSON.stringify({ Resources: resources(501) }) })),
      error => /501 resources|at most 500|LimitExceeded/i.test((error as Error).message),
    );
    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "cfngap06-root-outputs", TemplateBody: JSON.stringify({ Resources: {}, Outputs: outputs(201) }) })),
      error => /201 outputs|at most 200|LimitExceeded/i.test((error as Error).message),
    );

    const bucket = "cfngap06-nested-quotas";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const childUrl = (key: string) => `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "oversized.json", Body: JSON.stringify({ Resources: resources(501, "Child") }) }));
    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "cfngap06-child-resources", TemplateBody: JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: childUrl("oversized.json") } } } }) })),
      error => /501 resources|at most 500|LimitExceeded/i.test((error as Error).message),
    );

    for (let index = 0; index < 4; index += 1) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `full-${index}.json`, Body: JSON.stringify({ Resources: resources(500, `Child${index}`) }) }));
    }
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "one.json", Body: JSON.stringify({ Resources: resources(1, "Last") }) }));
    const nested = Object.fromEntries([
      ...Array.from({ length: 4 }, (_, index) => [`Nested${index}`, { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: childUrl(`full-${index}.json`) } }]),
      ["NestedLast", { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: childUrl("one.json") } }],
    ]);
    const aggregateRoot = { Resources: { ...resources(495), ...nested } };
    assert.equal(Object.keys(aggregateRoot.Resources).length, 500);
    await assert.rejects(
      cloudformation.send(new CreateStackCommand({ StackName: "cfngap06-aggregate", TemplateBody: JSON.stringify(aggregateRoot) })),
      error => /2501 resources|at most 2500|LimitExceeded/i.test((error as Error).message),
    );

    const names = simulator.store.regionState(region).cloudformation.stackNames;
    for (const name of ["cfngap06-root-resources", "cfngap06-root-outputs", "cfngap06-child-resources", "cfngap06-aggregate"]) assert.equal(names[name], undefined);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
