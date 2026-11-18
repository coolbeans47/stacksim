import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import * as Iam from "@aws-sdk/client-iam";
import * as S3 from "@aws-sdk/client-s3";
import { StackSim } from "../../src/server.js";
import type { SnapshotObjectPort, SnapshotRepository } from "../../src/opensearch/snapshots.js";
import type { DomainRecord } from "../../src/opensearch/model.js";

const [root, boundary] = process.argv.slice(2), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
await sim.start();
const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials }, iam = new Iam.IAMClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
await sim.opensearch.execute("CreateDomain", { DomainName: "snapshot-recovery", EncryptionAtRestOptions: { Enabled: true } }, region);
while (sim.opensearch.domain(region, "snapshot-recovery").state !== "active") await delay(10);
const domain = sim.opensearch.domain(region, "snapshot-recovery"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath), client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: "SnapshotRecovery", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "es.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!;
await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: "storage", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: ["arn:aws:s3:::snapshot-recovery", "arn:aws:s3:::snapshot-recovery/*"] }] }) }));
await s3.send(new S3.CreateBucketCommand({ Bucket: "snapshot-recovery" }));
await client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings: { bucket: "snapshot-recovery", region, role_arn: role.Arn } as any } });
await client.index({ index: "records", id: "one", body: { value: "durable-snapshot-data" } });
const original = (sim.opensearch as any).snapshotObjects as (domain: DomainRecord, repository: SnapshotRepository) => Promise<SnapshotObjectPort>;
let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
sim.opensearch.configureSnapshots(async (domain, repository) => {
  const port = await original(domain, repository);
  return { ...port, write: async (key, body) => { if (boundary === "object-committed") await port.write(key, body); reached(); await new Promise(() => {}); } };
});
const accepted = await client.snapshot.create({ repository: "backups", snapshot: "durable", wait_for_completion: false });
await entered; process.send?.({ boundary, accepted: accepted.body.accepted }); setInterval(() => {}, 1000);
