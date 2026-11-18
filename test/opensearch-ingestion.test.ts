import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { request } from "node:https";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as Aoss from "@aws-sdk/client-opensearchserverless";
import * as Osis from "@aws-sdk/client-osis";
import * as Iam from "@aws-sdk/client-iam";
import * as S3 from "@aws-sdk/client-s3";
import * as Metrics from "@aws-sdk/client-cloudwatch";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { SignatureV4 } from "@smithy/signature-v4";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";

class Sha256 {
  private hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(private readonly secret?: any) { this.hash = secret ? createHmac("sha256", secret) : createHash("sha256"); }
  update(data: any) { this.hash.update(data); }
  async digest() { return this.hash.digest(); }
  reset() { this.hash = this.secret ? createHmac("sha256", this.secret) : createHash("sha256"); }
}
const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> { for (let i = 0; i < 200; i++) { const result = await read(); if (check(result)) return result; await delay(10); } throw new Error("Timed out waiting for pipeline state"); }
async function send(endpoint: string, ca: Buffer, events: any, options: { credentials?: typeof credentials; path?: string; service?: string; gzip?: boolean; raw?: string } = {}) {
  const url = new URL(options.path ?? "/logs/ingest", `https://${endpoint}`), body = options.gzip ? gzipSync(Buffer.from(JSON.stringify(events))) : Buffer.from(options.raw ?? JSON.stringify(events));
  const signed = await new SignatureV4({ credentials: options.credentials ?? credentials, service: options.service ?? "osis", region, sha256: Sha256 }).sign({ method: "POST", protocol: url.protocol, hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: { host: url.host, "content-type": "application/json", "content-length": String(body.length), ...(options.gzip ? { "content-encoding": "gzip" } : {}) }, body });
  return new Promise<{ status: number; body: string }>((resolve, reject) => { const req = request(url, { method: "POST", headers: signed.headers, ca }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() })); }); req.on("error", reject); req.end(body); });
}
const pipelineConfig = (host: string, role: string, extra: any = {}) => JSON.stringify({ version: "2", logs: { source: { http: { path: "/logs/ingest", compression: "gzip" } }, processor: [{ convert_type: { key: "status", type: "integer" } }, { add_entries: { entries: [{ key: "source", value: "pipeline" }] } }, { delete_entries: { with_keys: ["secret"] } }], sink: [{ opensearch: { hosts: [host], aws: { region, sts_role_arn: role }, index: "logs", document_id: "${/id}", ...extra } }] } });
async function noPlaintext(directory: string, needle: string): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = join(directory, entry.name); if (entry.isDirectory()) await noPlaintext(file, needle); else assert.equal((await readFile(file).catch(() => Buffer.alloc(0))).includes(Buffer.from(needle)), false, file); } }

test("official ingestion API and signed source persist batches, transform under a role, retry after restart, and manage lifecycle", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-")), clock = new TestClock(Date.now());
  let sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false, clock });
  let control: Osis.OSISClient | undefined, iam: Iam.IAMClient | undefined, search: Client | undefined, metrics: Metrics.CloudWatchClient | undefined;
  try {
    await sim.start(); const sdk = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    control = new Osis.OSISClient(sdk()); iam = new Iam.IAMClient(sdk());
    await sim.opensearch.execute("CreateDomain", { DomainName: "pipeline-sink", EncryptionAtRestOptions: { Enabled: true } }, region);
    const domain = await until(async () => sim.opensearch.domain(region, "pipeline-sink"), domain => domain.state === "active"), host = `https://127.0.0.1:${domain.gatewayPort}`, ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const account = sim.store.accountId, arn = `arn:aws:osis:${region}:${account}:pipeline/event-pipeline`;
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: "Pipeline", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": account }, ArnEquals: { "aws:SourceArn": arn } } }] }) }))).Role!;
    const configuration = pipelineConfig(host, role.Arn!);
    assert.equal((await control.send(new Osis.ValidatePipelineCommand({ PipelineConfigurationBody: configuration }))).isValid, true);
    assert.equal((await control.send(new Osis.ValidatePipelineCommand({ PipelineConfigurationBody: configuration.replace('"convert_type"', '"script"') }))).isValid, false);
    const blueprints = await control.send(new Osis.ListPipelineBlueprintsCommand({}));
    const blueprint = await control.send(new Osis.GetPipelineBlueprintCommand({ BlueprintName: blueprints.Blueprints![0].BlueprintName!, Format: "JSON" })); assert.equal(JSON.parse(blueprint.Blueprint!.PipelineConfigurationBody!).version, "2");
    await assert.rejects(control.send(new Osis.CreatePipelineCommand({ PipelineName: "bad-pipeline", MinUnits: 1, MaxUnits: 9, PipelineConfigurationBody: configuration })), { name: "ValidationException" });
    const created = await control.send(new Osis.CreatePipelineCommand({ PipelineName: "event-pipeline", MinUnits: 1, MaxUnits: 2, PipelineConfigurationBody: configuration, BufferOptions: { PersistentBufferEnabled: true }, Tags: [{ Key: "env", Value: "test" }] })); assert.equal(created.Pipeline?.Status, "CREATING");
    const get = async () => (await control!.send(new Osis.GetPipelineCommand({ PipelineName: "event-pipeline" }))).Pipeline!;
    const pipeline = await until(get, value => value.Status === "ACTIVE"), endpoint = pipeline.IngestEndpointUrls![0];
    assert.ok(pipeline.CreatedAt instanceof Date); assert.equal(pipeline.PipelineRoleArn, role.Arn);
    assert.equal((await send(endpoint, ca, [{}], { service: "es" })).status, 403);
    assert.equal((await send(endpoint, ca, [{}], { path: "/wrong" })).status, 404);
    assert.equal((await send(endpoint, ca, {}, {})).status, 400);
    assert.equal((await send(endpoint, ca, [], { raw: "[broken" })).status, 400);
    await iam.send(new Iam.CreateUserCommand({ UserName: "producer" })); const access = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: "producer" }))).AccessKey!;
    const producer = { accessKeyId: access.AccessKeyId!, secretAccessKey: access.SecretAccessKey! };
    assert.equal((await send(endpoint, ca, [{ id: "denied", status: "200" }], { credentials: producer })).status, 403);
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: "producer", PolicyName: "ingest", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "osis:Ingest", Resource: arn }] }) }));
    const secret = "encrypted-source-only-37623d";
    assert.equal((await send(endpoint, ca, [{ id: "one", status: "200", secret }, { id: "two", status: "201", secret }], { credentials: producer, gzip: true })).status, 200);
    const bufferStats = () => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, "event-pipeline").generation).stats();
    clock.advance(1001); await until(async () => bufferStats(), stats => stats.deliveryFailures === 2); assert.equal(bufferStats().buffered, 2);
    await noPlaintext(root, secret);
    await control.send(new Osis.StopPipelineCommand({ PipelineName: "event-pipeline" })); await until(get, value => value.Status === "STOPPED");
    await assert.rejects(send(endpoint, ca, [{ id: "stopped" }]));
    control.destroy(); iam.destroy(); await sim.stop();
    sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false, clock }); await sim.start();
    control = new Osis.OSISClient(sdk()); iam = new Iam.IAMClient(sdk()); assert.equal((await get()).Status, "STOPPED"); assert.equal(bufferStats().accepted, 2);
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: "Pipeline", PolicyName: "sink", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:DescribeDomain", Resource: domain.arn }, { Effect: "Allow", Action: "es:ESHttpPut", Resource: `${domain.arn}/logs/*` }] }) }));
    await control.send(new Osis.StartPipelineCommand({ PipelineName: "event-pipeline" })); await until(get, value => value.Status === "ACTIVE"); clock.advance(1100);
    await until(async () => { clock.advance(100); return bufferStats(); }, stats => stats.delivered === 2); assert.equal(bufferStats().buffered, 0);
    search = new Client({ node: host, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    assert.deepEqual((await search.get({ index: "logs", id: "one" })).body._source, { id: "one", status: 200, source: "pipeline" });
    await control.send(new Osis.UpdatePipelineCommand({ PipelineName: "event-pipeline", MinUnits: 2, MaxUnits: 3, PipelineConfigurationBody: configuration.replace('"value":"pipeline"', '"value":"updated"') })); await until(get, value => value.Status === "ACTIVE");
    assert.equal((await send(endpoint, ca, [{ id: "three", status: "202" }])).status, 200); clock.advance(1100); await until(async () => bufferStats(), stats => stats.delivered === 3);
    assert.equal((await search.get({ index: "logs", id: "three" })).body._source.source, "updated");
    await control.send(new Osis.TagResourceCommand({ Arn: arn, Tags: [{ Key: "owner", Value: "test" }] })); assert.equal((await control.send(new Osis.ListTagsForResourceCommand({ Arn: arn }))).Tags!.length, 2);
    await control.send(new Osis.UntagResourceCommand({ Arn: arn, TagKeys: ["env"] })); assert.equal((await control.send(new Osis.ListTagsForResourceCommand({ Arn: arn }))).Tags![0].Key, "owner");
    assert.ok((await control.send(new Osis.GetPipelineChangeProgressCommand({ PipelineName: "event-pipeline" }))).ChangeProgressStatuses!.every(change => change.Status === "COMPLETED"));
    metrics = new Metrics.CloudWatchClient(sdk()); const points = await metrics.send(new Metrics.GetMetricStatisticsCommand({ Namespace: "AWS/OSIS", MetricName: "recordsOut.count", Dimensions: [{ Name: "PipelineName", Value: "event-pipeline" }, { Name: "ClientId", Value: account }], StartTime: new Date(clock.now() - 60000), EndTime: new Date(clock.now() + 60000), Period: 60, Statistics: ["Sum"] })); assert.equal(points.Datapoints!.reduce((sum, point) => sum + point.Sum!, 0), 3);
    assert.equal((await control.send(new Osis.ListPipelinesCommand({}))).Pipelines!.length, 1);
    const save = sim.store.save.bind(sim.store); let failDelete = true;
    sim.store.save = async () => { if (failDelete && !sim.opensearch.ingestion.state(region).pipelines["event-pipeline"]) { failDelete = false; throw new Error("Injected pipeline cleanup failure"); } await save(); };
    await control.send(new Osis.DeletePipelineCommand({ PipelineName: "event-pipeline" }));
    await until(get, value => value.Status === "DELETING" && Boolean(value.StatusReason)); sim.store.save = save;
    await control.send(new Osis.DeletePipelineCommand({ PipelineName: "event-pipeline" })); await until(async () => control!.send(new Osis.ListPipelinesCommand({})), value => !value.Pipelines!.length);
    await assert.rejects(send(endpoint, ca, [{ id: "deleted" }]));
    await control.send(new Osis.CreatePipelineCommand({ PipelineName: "event-pipeline", MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: configuration })); assert.notEqual((await until(get, value => value.Status === "ACTIVE")).IngestEndpointUrls![0], endpoint);
  } finally { await search?.close(); control?.destroy(); iam?.destroy(); metrics?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("ingestion isolates partial failures and authorizes durable S3 dead-letter delivery", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-dlq-")), clock = new TestClock(Date.now()), sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false, clock });
  let control: Osis.OSISClient | undefined, iam: Iam.IAMClient | undefined, s3: S3.S3Client | undefined, search: Client | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    control = new Osis.OSISClient(sdk); iam = new Iam.IAMClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
    await sim.opensearch.execute("CreateDomain", { DomainName: "dlq-sink", EncryptionAtRestOptions: { Enabled: true } }, region);
    const domain = await until(async () => sim.opensearch.domain(region, "dlq-sink"), value => value.state === "active"), host = `https://127.0.0.1:${domain.gatewayPort}`, ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: "DlqPipeline", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!;
    const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:DescribeDomain", Resource: domain.arn }, { Effect: "Allow", Action: "es:ESHttpPut", Resource: `${domain.arn}/logs/*` }, { Effect: "Allow", Action: "s3:PutObject", Resource: "arn:aws:s3:::pipeline-dead-letters/failed/*" }] };
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: "DlqPipeline", PolicyName: "delivery", PolicyDocument: JSON.stringify(policy) }));
    await s3.send(new S3.CreateBucketCommand({ Bucket: "pipeline-dead-letters" }));
    await s3.send(new S3.PutBucketPolicyCommand({ Bucket: "pipeline-dead-letters", Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: role.Arn }, Action: "s3:PutObject", Resource: "arn:aws:s3:::pipeline-dead-letters/*" }] }) }));
    const configuration = pipelineConfig(host, role.Arn!, { max_retries: 0, dlq: { s3: { bucket: "pipeline-dead-letters", key_path_prefix: "failed/", region } } });
    await control.send(new Osis.CreatePipelineCommand({ PipelineName: "dlq-pipeline", MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: configuration }));
    const pipeline = await until(async () => (await control!.send(new Osis.GetPipelineCommand({ PipelineName: "dlq-pipeline" }))).Pipeline!, value => value.Status === "ACTIVE");
    assert.equal((await send(pipeline.IngestEndpointUrls![0], ca, [{ id: "good", status: "200" }, { id: "bad", status: "not-an-integer", secret: "failed-event-681c4" }])).status, 200);
    const stats = () => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, "dlq-pipeline").generation).stats();
    clock.advance(1001); await until(async () => stats(), value => value.delivered === 1 && value.deliveryFailures === 1); assert.equal(stats().buffered, 1);
    assert.equal((await s3.send(new S3.ListObjectsV2Command({ Bucket: "pipeline-dead-letters" }))).KeyCount, 0); await noPlaintext(root, "failed-event-681c4");
    await s3.send(new S3.DeleteBucketPolicyCommand({ Bucket: "pipeline-dead-letters" }));
    await until(async () => { clock.advance(100); return stats(); }, value => value.deadLettered === 1); assert.equal(stats().delivered, 1); assert.equal(stats().buffered, 0);
    const objects = (await s3.send(new S3.ListObjectsV2Command({ Bucket: "pipeline-dead-letters" }))).Contents!; assert.equal(objects.length, 1); assert.ok(objects[0].Key!.startsWith("failed/"));
    const object = await s3.send(new S3.GetObjectCommand({ Bucket: "pipeline-dead-letters", Key: objects[0].Key })); const failure = JSON.parse(await object.Body!.transformToString()); assert.equal(failure.event.id, "bad"); assert.match(failure.error, /Numeric conversion/);
    search = new Client({ node: host, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) }); assert.equal((await search.get({ index: "logs", id: "good" })).body._source.status, 200); await assert.rejects(search.get({ index: "logs", id: "bad" }), (error: any) => error.statusCode === 404);
    // Cursor is authenticated and invalidated by catalog changes.
    await control.send(new Osis.CreatePipelineCommand({ PipelineName: "second-pipeline", MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: configuration }));
    const page = await control.send(new Osis.ListPipelinesCommand({ MaxResults: 1 })); assert.equal(page.Pipelines!.length, 1); assert.ok(page.NextToken);
    assert.equal((await control.send(new Osis.ListPipelinesCommand({ MaxResults: 1, NextToken: page.NextToken }))).Pipelines![0].PipelineName, "second-pipeline");
    await assert.rejects(control.send(new Osis.ListPipelinesCommand({ MaxResults: 1, NextToken: page.NextToken! + "x" })), { name: "ValidationException" });
  } finally { await search?.close(); control?.destroy(); iam?.destroy(); s3?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("Serverless ingestion preserves the independent network, API and data policy gates", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-aoss-")), clock = new TestClock(Date.now()), sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false, clock });
  let control: Osis.OSISClient | undefined, aoss: Aoss.OpenSearchServerlessClient | undefined, iam: Iam.IAMClient | undefined, search: Client | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    control = new Osis.OSISClient(sdk); iam = new Iam.IAMClient(sdk); aoss = new Aoss.OpenSearchServerlessClient(sdk);
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: "encryption", type: "encryption", policy: JSON.stringify({ Rules: [{ ResourceType: "collection", Resource: ["collection/ingestion-logs"] }], AWSOwnedKey: true }) }));
    const id = (await aoss.send(new Aoss.CreateCollectionCommand({ name: "ingestion-logs", type: "TIMESERIES" }))).createCollectionDetail!.id!;
    const collection = await until(async () => (await aoss!.send(new Aoss.BatchGetCollectionCommand({ ids: [id] }))).collectionDetails![0], value => value.status === "ACTIVE");
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: "AossPipeline", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!;
    const configuration = JSON.parse(pipelineConfig(collection.collectionEndpoint!, role.Arn!)); configuration.logs.sink[0].opensearch.aws.serverless = true; delete configuration.logs.sink[0].opensearch.document_id;
    await control.send(new Osis.CreatePipelineCommand({ PipelineName: "aoss-pipeline", MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: JSON.stringify(configuration) }));
    const pipeline = await until(async () => (await control!.send(new Osis.GetPipelineCommand({ PipelineName: "aoss-pipeline" }))).Pipeline!, value => value.Status === "ACTIVE"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const stats = () => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, "aoss-pipeline").generation).stats();
    const attempt = async (count: number) => until(async () => { clock.advance(100); return stats(); }, value => value.deliveryFailures >= count);
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: "AossPipeline", PolicyName: "discover", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "aoss:BatchGetCollection", Resource: "*" }] }) }));
    assert.equal((await send(pipeline.IngestEndpointUrls![0], ca, [{ id: "input", status: "200" }])).status, 200); await attempt(1);
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: "network", type: "network", policy: JSON.stringify([{ Rules: [{ ResourceType: "collection", Resource: ["collection/ingestion-logs"] }], AllowFromPublic: true }]) })); await attempt(2);
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: "AossPipeline", PolicyName: "endpoint", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "aoss:APIAccessAll", Resource: collection.arn }] }) })); await attempt(3);
    await aoss.send(new Aoss.CreateAccessPolicyCommand({ name: "access", type: "data", policy: JSON.stringify([{ Rules: [{ ResourceType: "index", Resource: ["index/ingestion-logs/logs"], Permission: ["aoss:CreateIndex", "aoss:WriteDocument", "aoss:ReadDocument", "aoss:DescribeIndex"] }], Principal: [role.Arn, `arn:aws:iam::${sim.store.accountId}:user/admin`] }]) }));
    await until(async () => { clock.advance(100); return stats(); }, value => value.delivered === 1); assert.equal(stats().buffered, 0); clock.advance(10001);
    search = new Client({ node: collection.collectionEndpoint!, ssl: { ca }, ...AwsSigv4Signer({ region, service: "aoss", getCredentials: async () => credentials }) });
    const hits = (await search.search({ index: "logs", body: { query: { match_all: {} } } })).body.hits; assert.equal(typeof hits.total === "number" ? hits.total : hits.total?.value, 1); assert.equal(hits.hits[0]._source.source, "pipeline"); assert.notEqual(hits.hits[0]._id, "input");
  } finally { await search?.close(); control?.destroy(); aoss?.destroy(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
