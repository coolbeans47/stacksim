import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { App, Stack, CfnOutput, RemovalPolicy, Tags } from "aws-cdk-lib";
import { Domain, EngineVersion } from "aws-cdk-lib/aws-opensearchservice";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, UpdateStackCommand, DeleteStackCommand } from "@aws-sdk/client-cloudformation";
import { OpenSearchClient, DescribeDomainCommand, DeleteDomainCommand, GetIndexCommand } from "@aws-sdk/client-opensearch";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { Client } from "@opensearch-project/opensearch";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("CloudFormation resolves protected master credentials and waits for encrypted-domain security updates", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-secure-cfn-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let cfn: CloudFormationClient | undefined, ssm: SSMClient | undefined, search: Client | undefined;
  const first = "CloudFormation-master1!", second = "CloudFormation-rotated2!";
  try {
    await sim.start(); const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    cfn = new CloudFormationClient(options); ssm = new SSMClient(options);
    await ssm.send(new PutParameterCommand({ Name: "/search/master", Type: "SecureString", Value: first }));
    const template = (version: number) => JSON.stringify({ Resources: { Domain: { Type: "AWS::OpenSearchService::Domain", Properties: { DomainName: "protected-cfn", EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: true, MasterUserOptions: { MasterUserName: "master", MasterUserPassword: `{{resolve:ssm-secure:/search/master:${version}}}` } }, AccessPolicies: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "es:ESHttp*", Resource: "arn:aws:es:eu-west-1:000000000000:domain/protected-cfn/*" }] } } } } });
    const wait = async (status: string) => { for (let at = 0; at < 200; at++) { const stack = (await cfn!.send(new DescribeStacksCommand({ StackName: "protected-search" }))).Stacks![0]; if (stack.StackStatus === status) return; if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(20); } throw new Error(`Stack did not reach ${status}`); };
    await cfn.send(new CreateStackCommand({ StackName: "protected-search", TemplateBody: template(1) })); await wait("CREATE_COMPLETE");
    const domain = sim.opensearch.domain(region, "protected-cfn"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, auth: { username: "master", password: first } });
    await search.index({ index: "retained", id: "1", body: { message: "encrypted-cfn-payload" }, refresh: true });
    await ssm.send(new PutParameterCommand({ Name: "/search/master", Type: "SecureString", Value: second, Overwrite: true }));
    await cfn.send(new UpdateStackCommand({ StackName: "protected-search", TemplateBody: template(2) })); await wait("UPDATE_COMPLETE");
    assert.equal(domain.changes?.at(-1)?.state, "COMPLETED");
    await assert.rejects(search.get({ index: "retained", id: "1" }), (error: any) => error.statusCode === 401);
    await search.close(); search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, auth: { username: "master", password: second } });
    assert.equal((await search.get({ index: "retained", id: "1" })).body._source.message, "encrypted-cfn-payload");
    const scan = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await scan(path); else { const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }); for (const secret of [first, second, "encrypted-cfn-payload"]) assert.equal(bytes.includes(Buffer.from(secret)), false, `${entry.name} leaks a secret`); } } };
    await scan(root);
    await search.close(); search = undefined;
    await cfn.send(new DeleteStackCommand({ StackName: "protected-search" }));
    for (let at = 0; at < 200 && sim.opensearch.domains(region).length; at++) await delay(20);
    assert.equal(sim.opensearch.domains(region).length, 0);
  } finally { await search?.close(); cfn?.destroy(); ssm?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
for (const legacy of [false, true]) test(legacy ? "legacy CloudFormation domain shares the managed lifecycle and outputs" : "unmodified CDK domain template deploys, updates, exposes endpoints and destroys through CloudFormation", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-cfn-"));
  const app = new App({ outdir: join(root, "cdk.out") });
  const stack = new Stack(app, "SearchStack", { env: { account: "000000000000", region } });
  const domain = new Domain(stack, "Search", { version: EngineVersion.OPENSEARCH_2_19, capacity: { dataNodes: 1, dataNodeInstanceType: "r6gd.large.search" }, ebs: { enabled: false }, encryptionAtRest: { enabled: false }, nodeToNodeEncryption: false, enforceHttps: true, zoneAwareness: { enabled: false }, removalPolicy: RemovalPolicy.DESTROY });
  Tags.of(domain).add("Application", "products"); new CfnOutput(stack, "DomainName", { value: domain.domainName }); new CfnOutput(stack, "Endpoint", { value: domain.domainEndpoint }); new CfnOutput(stack, "DomainArn", { value: domain.domainArn });
  const template = app.synth().getStackArtifact(stack.artifactId).template;
  if (legacy) for (const resource of Object.values<any>(template.Resources)) if (resource.Type === "AWS::OpenSearchService::Domain") {
    resource.Type = "AWS::Elasticsearch::Domain";
    resource.Properties.ElasticsearchVersion = resource.Properties.EngineVersion; delete resource.Properties.EngineVersion;
    resource.Properties.ElasticsearchClusterConfig = resource.Properties.ClusterConfig; delete resource.Properties.ClusterConfig;
  }
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "state"), region, authMode: "enforce", cdkBootstrap: true });
  let cfn: CloudFormationClient | undefined, os: OpenSearchClient | undefined;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    cfn = new CloudFormationClient(config); os = new OpenSearchClient(config);
    const status = async (expected: string) => { for (let i = 0; i < 200; i++) { const value = (await cfn!.send(new DescribeStacksCommand({ StackName: "search-test" }))).Stacks![0]; if (value.StackStatus === expected) return value; if (value.StackStatus?.endsWith("FAILED") || value.StackStatus === "ROLLBACK_COMPLETE") throw new Error(`${value.StackStatus}: ${value.StackStatusReason}`); await delay(50); } throw new Error(`Stack did not reach ${expected}`); };
    await cfn.send(new CreateStackCommand({ StackName: "search-test", TemplateBody: JSON.stringify(template) }));
    const created = await status("CREATE_COMPLETE");
    const outputs = Object.fromEntries(created.Outputs!.map(output => [output.OutputKey!, output.OutputValue!]));
    assert.match(outputs.Endpoint, /^127\.0\.0\.1:\d+$/);
    assert.equal((await os.send(new DescribeDomainCommand({ DomainName: outputs.DomainName }))).DomainStatus?.Endpoint, outputs.Endpoint);
    const loaded = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../examples/opensearch-product-search/search.mjs", import.meta.url.replace("/dist/test/", "/test/")))], { env: { ...process.env, OPENSEARCH_ENDPOINT: `https://${outputs.Endpoint}`, AWS_CA_BUNDLE: sim.opensearch.diagnostics(region).caCertificatePath, AWS_REGION: region, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_SESSION_TOKEN: "" }, timeout: 15000 });
    assert.deepEqual(JSON.parse(loaded.stdout).hits.hits.map((hit: any) => hit._id), ["shoe-red"]);
    const changed = structuredClone(template); const logicalId = Object.keys(changed.Resources).find(key => ["AWS::OpenSearchService::Domain", "AWS::Elasticsearch::Domain"].includes(changed.Resources[key].Type))!;
    changed.Resources[logicalId].Properties.Tags = [{ Key: "Application", Value: "updated" }];
    await cfn.send(new UpdateStackCommand({ StackName: "search-test", TemplateBody: JSON.stringify(changed) }));
    await status("UPDATE_COMPLETE"); assert.equal(sim.opensearch.domain(region, outputs.DomainName).tags.Application, "updated");
    assert.equal(sim.opensearch.domain(region, outputs.DomainName).tags["aws:cloudformation:logical-id"], logicalId);
    const invalid = structuredClone(changed); invalid.Resources[logicalId].Properties.VPCOptions = { SubnetIds: ["subnet-missing"] };
    await assert.rejects(cfn.send(new UpdateStackCommand({ StackName: "search-test", TemplateBody: JSON.stringify(invalid) })), /VPCOptions|unsupported/i);
    const replacement = structuredClone(changed); replacement.Resources[logicalId].Properties.DomainName = "replacement-search";
    if (legacy) replacement.Resources[logicalId].DeletionPolicy = "Retain";
    await cfn.send(new UpdateStackCommand({ StackName: "search-test", TemplateBody: JSON.stringify(replacement) }));
    const replaced = await status("UPDATE_COMPLETE");
    assert.equal(replaced.Outputs!.find(output => output.OutputKey === "DomainName")!.OutputValue, "replacement-search");
    assert.notEqual(replaced.Outputs!.find(output => output.OutputKey === "Endpoint")!.OutputValue, outputs.Endpoint);
    await assert.rejects(os.send(new DescribeDomainCommand({ DomainName: outputs.DomainName })), { name: "ResourceNotFoundException" });
    await assert.rejects(os.send(new GetIndexCommand({ DomainName: "replacement-search", IndexName: "products" })), { name: "ResourceNotFoundException" });
    await cfn.send(new DeleteStackCommand({ StackName: "search-test" }));
    if (legacy) {
      for (let i = 0; i < 200 && sim.opensearch.domain(region, "replacement-search").owner; i++) await delay(50);
      assert.equal(sim.opensearch.domain(region, "replacement-search").owner, undefined);
      assert.equal((await os.send(new DescribeDomainCommand({ DomainName: "replacement-search" }))).DomainStatus!.Created, true);
      await os.send(new DeleteDomainCommand({ DomainName: "replacement-search" }));
    }
    for (let i = 0; i < 200 && sim.opensearch.domains(region).length; i++) await delay(50);
    assert.equal(sim.opensearch.domains(region).length, 0);
  } finally { cfn?.destroy(); os?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
