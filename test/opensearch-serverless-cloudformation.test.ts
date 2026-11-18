import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, UpdateStackCommand, DeleteStackCommand } from "@aws-sdk/client-cloudformation";
import { OpenSearchServerlessClient, BatchGetCollectionCommand, GetIndexCommand } from "@aws-sdk/client-opensearchserverless";
import { StackSim } from "../src/server.js";

test("Serverless CloudFormation creates policy dependencies, updates tags/policies and cleans up owned generations", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-cfn-")), region = "eu-west-1";
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let cfn: CloudFormationClient | undefined, aoss: OpenSearchServerlessClient | undefined;
  const template = (description: string, name = "cfn-search", retained = false) => JSON.stringify({ Resources: {
    Encryption: { Type: "AWS::OpenSearchServerless::SecurityPolicy", Properties: { Name: "cfn-encryption", Type: "encryption", Policy: JSON.stringify({ Rules: [{ ResourceType: "collection", Resource: ["collection/cfn-*"] }], AWSOwnedKey: true }) } },
    Network: { Type: "AWS::OpenSearchServerless::SecurityPolicy", Properties: { Name: "cfn-network", Type: "network", Policy: JSON.stringify([{ Rules: [{ ResourceType: "collection", Resource: ["collection/cfn-*"] }], AllowFromPublic: true }]), Description: description } },
    Access: { Type: "AWS::OpenSearchServerless::AccessPolicy", Properties: { Name: "cfn-access", Type: "data", Policy: JSON.stringify([{ Rules: [{ ResourceType: "index", Resource: ["index/cfn-*/*"], Permission: ["aoss:*"] }], Principal: ["arn:aws:iam::000000000000:user/admin"] }]) } },
    Collection: { Type: "AWS::OpenSearchServerless::Collection", DependsOn: ["Encryption", "Network", "Access"], ...(retained ? { DeletionPolicy: "Retain" } : {}), Properties: { Name: name, Description: description, Type: "SEARCH", Tags: [{ Key: "revision", Value: description }] } },
    EndpointIndex: { Type: "AWS::OpenSearchServerless::Index", Properties: { CollectionEndpoint: { "Fn::GetAtt": ["Collection", "CollectionEndpoint"] }, IndexName: "endpoint-index", Mappings: { Properties: { title: { Type: "text" }, ...(description === "second" ? { category: { Type: "keyword" } } : {}) } } } },
    ManagementIndex: { Type: "AWS::OpenSearchServerless::CollectionIndex", Properties: { Id: { Ref: "Collection" }, IndexName: "managed-index", IndexSchema: JSON.stringify({ mappings: { properties: { title: { type: "text" }, ...(description === "second" ? { price: { type: "double" } } : {}) } } }) } },
  }, Outputs: { Id: { Value: { Ref: "Collection" } }, Endpoint: { Value: { "Fn::GetAtt": ["Collection", "CollectionEndpoint"] } }, Arn: { Value: { "Fn::GetAtt": ["Collection", "Arn"] } }, EncryptionName: { Value: { Ref: "Encryption" } }, EndpointIndexRef: { Value: { Ref: "EndpointIndex" } }, ManagementIndexRef: { Value: { Ref: "ManagementIndex" } }, IndexUuid: { Value: { "Fn::GetAtt": ["EndpointIndex", "Uuid"] } } } });
  try {
    await sim.start(); const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    cfn = new CloudFormationClient(options); aoss = new OpenSearchServerlessClient(options);
    const wait = async (status: string) => { for (let i = 0; i < 200; i++) { const stack = (await cfn!.send(new DescribeStacksCommand({ StackName: "serverless-stack" }))).Stacks![0]; if (stack.StackStatus === status) return stack; if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(20); } throw new Error(`Stack did not reach ${status}`); };
    await cfn.send(new CreateStackCommand({ StackName: "serverless-stack", TemplateBody: template("first") }));
    const stack = await wait("CREATE_COMPLETE"), outputs = Object.fromEntries(stack.Outputs!.map(output => [output.OutputKey!, output.OutputValue!]));
    assert.match(outputs.Endpoint, /^https:\/\/127\.0\.0\.1:\d+$/); assert.equal(outputs.EncryptionName, "cfn-encryption");
    assert.equal(outputs.EndpointIndexRef, `endpoint-index|${outputs.Endpoint}`); assert.equal(outputs.ManagementIndexRef, `${outputs.Id}|managed-index`); assert.match(outputs.IndexUuid, /^[a-f0-9-]{36}$/);
    const collection = sim.opensearch.serverless.collection(region, outputs.Id); assert.equal(collection.status, "ACTIVE"); assert.ok(collection.owner); assert.equal(collection.tags["aws:cloudformation:logical-id"], "Collection");
    await cfn.send(new UpdateStackCommand({ StackName: "serverless-stack", TemplateBody: template("second") })); await wait("UPDATE_COMPLETE");
    assert.equal(sim.opensearch.serverless.collection(region, outputs.Id).description, "second"); assert.equal(sim.opensearch.serverless.collection(region, outputs.Id).tags.revision, "second");
    assert.equal(sim.opensearch.serverless.state(region).policies["network:cfn-network"].description, "second");
    assert.equal(((await aoss.send(new GetIndexCommand({ id: outputs.Id, indexName: "managed-index" }))).indexSchema as any).mappings.properties.price.type, "double");
    assert.equal(((await aoss.send(new GetIndexCommand({ id: outputs.Id, indexName: "endpoint-index" }))).indexSchema as any).mappings.properties.category.type, "keyword");
    await cfn.send(new UpdateStackCommand({ StackName: "serverless-stack", TemplateBody: template("replacement", "cfn-replacement", true) }));
    const replacement = await wait("UPDATE_COMPLETE"), nextId = replacement.Outputs!.find(output => output.OutputKey === "Id")!.OutputValue!;
    assert.notEqual(nextId, outputs.Id); assert.equal((await aoss.send(new BatchGetCollectionCommand({ ids: [outputs.Id] }))).collectionDetails?.length, 0);
    await cfn.send(new DeleteStackCommand({ StackName: "serverless-stack" }));
    for (let i = 0; i < 200 && Object.keys(sim.opensearch.serverless.state(region).policies).length; i++) await delay(20);
    assert.deepEqual(Object.keys(sim.opensearch.serverless.state(region).policies), []);
    assert.equal(sim.opensearch.serverless.collection(region, nextId).owner, undefined);
    assert.equal(sim.opensearch.serverless.collection(region, nextId).status, "ACTIVE");
  } finally { cfn?.destroy(); aoss?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("Serverless group and lifecycle CloudFormation resources update, replace and delete with collection dependencies", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-group-cfn-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  let cfn: CloudFormationClient | undefined;
  const template = (revision: number) => JSON.stringify({ Resources: {
    Group: { Type: "AWS::OpenSearchServerless::CollectionGroup", Properties: { Name: revision > 2 ? "next-group" : "logs-group", Generation: "NEXTGEN", StandbyReplicas: "DISABLED", CapacityLimits: { MinSearchCapacityInOCU: revision === 1 ? 0 : 2, MaxSearchCapacityInOCU: 4 }, Tags: [{ Key: "revision", Value: String(revision) }] } },
    Logs: { Type: "AWS::OpenSearchServerless::Collection", DependsOn: "Group", Properties: { Name: revision > 2 ? "next_logs" : "cfn_logs", Type: "TIMESERIES", CollectionGroupName: revision > 2 ? "next-group" : "logs-group", EncryptionConfig: { AWSOwnedKey: true }, DeletionProtection: "DISABLED" } },
    Expiry: { Type: "AWS::OpenSearchServerless::LifecyclePolicy", Properties: { Name: "cfn-expiry", Type: "retention", Policy: JSON.stringify({ Rules: [{ ResourceType: "index", Resource: [revision > 2 ? "index/next_logs/*" : "index/cfn_logs/*"], MinIndexRetention: `${revision}d` }] }) } },
  }, Outputs: { GroupId: { Value: { Ref: "Group" } }, GroupArn: { Value: { "Fn::GetAtt": ["Group", "Arn"] } }, Collection: { Value: { Ref: "Logs" } }, Policy: { Value: { Ref: "Expiry" } } } });
  try {
    await sim.start(); cfn = new CloudFormationClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    const wait = async (status: string) => { for (let i = 0; i < 200; i++) { const stack = (await cfn!.send(new DescribeStacksCommand({ StackName: "group-stack" }))).Stacks![0]; if (stack.StackStatus === status) return Object.fromEntries(stack.Outputs!.map(output => [output.OutputKey!, output.OutputValue!])); if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(20); } throw new Error(`Stack did not reach ${status}`); };
    await cfn.send(new CreateStackCommand({ StackName: "group-stack", TemplateBody: template(1) })); const first = await wait("CREATE_COMPLETE");
    assert.equal(first.Policy, "cfn-expiry"); assert.equal(first.GroupArn, sim.opensearch.serverless.state(region).groups![first.GroupId].arn); assert.equal(sim.opensearch.serverless.collection(region, first.Collection).standbyReplicas, "DISABLED");
    await cfn.send(new UpdateStackCommand({ StackName: "group-stack", TemplateBody: template(2) })); const second = await wait("UPDATE_COMPLETE");
    assert.equal(second.GroupId, first.GroupId); assert.equal(sim.opensearch.serverless.state(region).groups![first.GroupId].capacityLimits.minSearchCapacityInOCU, 2); assert.equal(sim.opensearch.serverless.state(region).groups![first.GroupId].tags.revision, "2"); assert.equal(sim.opensearch.serverless.state(region).policies["retention:cfn-expiry"].policy.Rules[0].MinIndexRetention, "2d");
    await cfn.send(new UpdateStackCommand({ StackName: "group-stack", TemplateBody: template(3) })); const third = await wait("UPDATE_COMPLETE");
    assert.notEqual(third.GroupId, first.GroupId); assert.notEqual(third.Collection, first.Collection); assert.equal(sim.opensearch.serverless.state(region).groups![first.GroupId], undefined);
    await cfn.send(new DeleteStackCommand({ StackName: "group-stack" }));
    for (let i = 0; i < 200 && (Object.keys(sim.opensearch.serverless.state(region).groups ?? {}).length || Object.keys(sim.opensearch.serverless.state(region).policies).length); i++) await delay(20);
    assert.deepEqual(sim.opensearch.serverless.state(region).groups, {}); assert.deepEqual(sim.opensearch.serverless.state(region).collections, {}); assert.deepEqual(sim.opensearch.serverless.state(region).policies, {});
  } finally { cfn?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
