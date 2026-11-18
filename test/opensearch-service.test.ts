import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { OpenSearchClient, CreateDomainCommand, DescribeDomainCommand, DescribeDomainConfigCommand, ListDomainNamesCommand, ListTagsCommand, AddTagsCommand, RemoveTagsCommand, DeleteDomainCommand, UpdateDomainConfigCommand, ListVersionsCommand, CreateIndexCommand, GetIndexCommand, UpdateIndexCommand, DeleteIndexCommand } from "@aws-sdk/client-opensearch";
import { IAMClient, CreateUserCommand, CreateAccessKeyCommand, PutUserPolicyCommand, DeleteUserPolicyCommand } from "@aws-sdk/client-iam";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
async function active(client: OpenSearchClient, name: string) {
  for (let i = 0; i < 100; i++) { const domain = (await client.send(new DescribeDomainCommand({ DomainName: name }))).DomainStatus!; if (domain.Endpoint) return domain; await delay(20); }
  throw new Error("Domain did not become ready");
}

test("official AWS and OpenSearch clients provision, query, authorize, persist and delete an embedded domain", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-opensearch-sdk-"));
  let sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let search: Client | undefined; let client: OpenSearchClient | undefined; let metrics: CloudWatchClient | undefined;
  try {
    await sim.start(); client = new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    assert.deepEqual((await client.send(new ListVersionsCommand({}))).Versions, ["OpenSearch_2.19"]);
    await assert.rejects(client.send(new CreateDomainCommand({ DomainName: "bad-domain", AdvancedSecurityOptions: { Enabled: true } })), { name: "ValidationException" });
    assert.equal((await client.send(new ListDomainNamesCommand({}))).DomainNames?.length, 0);
    const created = await client.send(new CreateDomainCommand({ DomainName: "product-search", TagList: [{ Key: "app", Value: "products" }] }));
    assert.equal(created.DomainStatus?.Processing, true); assert.equal(created.DomainStatus?.Endpoint, undefined);
    const domain = await active(client, "product-search"); const endpoint = domain.Endpoint!;
    const save = sim.store.save.bind(sim.store);
    const revision = sim.opensearch.domain(region, "product-search").revision;
    sim.store.save = async () => { throw new Error("Injected persistence failure"); };
    try {
      await assert.rejects(sim.opensearch.execute("UpdateDomainConfig", { DomainName: "product-search", AdvancedOptions: { "rest.action.multi.allow_explicit_index": "false" } }, region), /Injected persistence failure/);
      await assert.rejects(sim.opensearch.execute("DeleteDomain", { DomainName: "product-search" }, region), /Injected persistence failure/);
    } finally { sim.store.save = save; }
    assert.equal(sim.opensearch.domain(region, "product-search").state, "active");
    assert.equal(sim.opensearch.domain(region, "product-search").revision, revision);
    assert.equal(sim.opensearch.domain(region, "product-search").config.AdvancedOptions["rest.action.multi.allow_explicit_index"], "true");
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://${endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    await client.send(new CreateIndexCommand({ DomainName: "product-search", IndexName: "managed", IndexSchema: { mappings: { properties: { title: { type: "text" } } } } }));
    assert.equal((await search.indices.exists({ index: "managed" })).body, true);
    await client.send(new UpdateIndexCommand({ DomainName: "product-search", IndexName: "managed", IndexSchema: { mappings: { properties: { category: { type: "keyword" } } } } }));
    assert.equal(((await client.send(new GetIndexCommand({ DomainName: "product-search", IndexName: "managed" }))).IndexSchema as any)?.mappings?.properties?.category?.type, "keyword");
    await client.send(new DeleteIndexCommand({ DomainName: "product-search", IndexName: "managed" }));
    await search.indices.create({ index: "products", body: { mappings: { properties: { title: { type: "text" }, price: { type: "double" } } } } });
    await search.index({ index: "products", id: "1", body: { title: "Red shoes", price: 25 }, refresh: true });
    assert.equal(((await search.search({ index: "products", body: { query: { match: { title: "shoes" } } } })).body as any).hits.total.value, 1);
    metrics = new CloudWatchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    const metric = { Namespace: "AWS/ES", Dimensions: [{ Name: "ClientId", Value: "000000000000" }, { Name: "DomainName", Value: "product-search" }], StartTime: new Date(Date.now() - 120000), EndTime: new Date(Date.now() + 60000), Period: 60 };
    const requests = await metrics.send(new GetMetricStatisticsCommand({ ...metric, MetricName: "OpenSearchRequests", Statistics: ["Sum"] }));
    assert.ok(requests.Datapoints!.reduce((sum, point) => sum + point.Sum!, 0) >= 3);
    const searchable = await metrics.send(new GetMetricStatisticsCommand({ ...metric, MetricName: "SearchableDocuments", Statistics: ["Maximum"] }));
    assert.equal(searchable.Datapoints!.at(-1)!.Maximum, 1);
    await client.send(new AddTagsCommand({ ARN: domain.ARN!, TagList: [{ Key: "owner", Value: "test" }] }));
    assert.equal((await client.send(new ListTagsCommand({ ARN: domain.ARN! }))).TagList?.length, 2);
    await client.send(new RemoveTagsCommand({ ARN: domain.ARN!, TagKeys: ["owner"] }));
    const deny = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "es:ESHttpGet", Resource: `${domain.ARN}/*` }] });
    await client.send(new UpdateDomainConfigCommand({ DomainName: "product-search", AccessPolicies: deny, DryRun: true }));
    assert.equal((await client.send(new DescribeDomainConfigCommand({ DomainName: "product-search" }))).DomainConfig?.AccessPolicies?.Options, "");
    await client.send(new UpdateDomainConfigCommand({ DomainName: "product-search", AccessPolicies: deny }));
    await assert.rejects(search.get({ index: "products", id: "1" }), (error: any) => error.statusCode === 403);
    await client.send(new UpdateDomainConfigCommand({ DomainName: "product-search", AccessPolicies: "" }));
    await search.close(); search = undefined; client.destroy();
    await sim.stop();
    const state = await readFile(join(root, "state.json"), "utf8"); assert.ok(!state.includes("Red shoes"));
    sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
    await sim.start(); client = new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    assert.equal((await active(client, "product-search")).Endpoint, endpoint);
    search = new Client({ node: `https://${endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    assert.equal((await search.get({ index: "products", id: "1" })).body._source.title, "Red shoes");
    await search.close(); search = undefined;
    await client.send(new DeleteDomainCommand({ DomainName: "product-search" }));
    for (let i = 0; i < 100 && (await client.send(new ListDomainNamesCommand({}))).DomainNames?.length; i++) await delay(20);
    assert.deepEqual((await client.send(new ListDomainNamesCommand({}))).DomainNames, []);
    await client.send(new CreateDomainCommand({ DomainName: "product-search" }));
    assert.notEqual((await active(client, "product-search")).Endpoint, endpoint);
  } catch (error: any) { if (error.meta?.body) error.message += `: ${JSON.stringify(error.meta.body)}`; throw error; } finally { await search?.close(); client?.destroy(); metrics?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("least privilege, revocation, Region separation and management errors do not mutate resources", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-security-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let client: OpenSearchClient | undefined, other: OpenSearchClient | undefined, iam: IAMClient | undefined, restricted: OpenSearchClient | undefined, search: Client | undefined, reader: Client | undefined;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    client = new OpenSearchClient(config); other = new OpenSearchClient({ ...config, region: "us-east-1" }); iam = new IAMClient(config);
    await client.send(new CreateDomainCommand({ DomainName: "same-name" })); await other.send(new CreateDomainCommand({ DomainName: "same-name" }));
    const a = await active(client, "same-name"), b = await active(other, "same-name"); assert.notEqual(a.Endpoint, b.Endpoint);
    await assert.rejects(client.send(new ListTagsCommand({ ARN: b.ARN! })), (error: any) => error.name === "ResourceNotFoundException" && error.$metadata.httpStatusCode === 409);
    await iam.send(new CreateUserCommand({ UserName: "search-reader" }));
    const accessKey = (await iam.send(new CreateAccessKeyCommand({ UserName: "search-reader" }))).AccessKey!;
    const readerCredentials = { accessKeyId: accessKey.AccessKeyId!, secretAccessKey: accessKey.SecretAccessKey! };
    await iam.send(new PutUserPolicyCommand({ UserName: "search-reader", PolicyName: "read-one-index", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:ESHttpGet", Resource: `${a.ARN}/products/*` }] }) }));
    restricted = new OpenSearchClient({ ...config, credentials: readerCredentials });
    await assert.rejects(restricted.send(new DeleteDomainCommand({ DomainName: "same-name" })), { name: "AccessDeniedException" });
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://${a.Endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    reader = new Client({ node: `https://${a.Endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => readerCredentials }) });
    await search.index({ index: "products", id: "1", body: { title: "private product" }, refresh: true });
    assert.equal((await reader.get({ index: "products", id: "1" })).body.found, true);
    await assert.rejects(reader.index({ index: "products", id: "2", body: { title: "unauthorized" } }), (error: any) => error.statusCode === 403);
    await iam.send(new DeleteUserPolicyCommand({ UserName: "search-reader", PolicyName: "read-one-index" }));
    await assert.rejects(reader.get({ index: "products", id: "1" }), (error: any) => error.statusCode === 403);
    await reader.close(); reader = new Client({ node: `https://${a.Endpoint}`, ssl: { ca } });
    await assert.rejects(reader.get({ index: "products", id: "1" }), (error: any) => error.statusCode === 403);
    await client.send(new UpdateDomainConfigCommand({ DomainName: "same-name", AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "es:ESHttpGet", Resource: `${a.ARN}/products/*`, Condition: { IpAddress: { "aws:SourceIp": "127.0.0.1/32" } } }] }) }));
    assert.equal((await reader.get({ index: "products", id: "1" })).body.found, true);
    await reader.close(); reader = new Client({ node: `https://${b.Endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region: "us-east-1", service: "es", getCredentials: async () => credentials }) });
    await assert.rejects(reader.get({ index: "products", id: "1" }), (error: any) => error.statusCode === 404);
  } finally { await search?.close(); await reader?.close(); client?.destroy(); other?.destroy(); restricted?.destroy(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
