import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as OpenSearch from "@aws-sdk/client-opensearch";
import * as S3 from "@aws-sdk/client-s3";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";

const [root, boundary] = process.argv.slice(2), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials }, control = new OpenSearch.OpenSearchClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
await s3.send(new S3.CreateBucketCommand({ Bucket: "recovery-dictionaries" })); await s3.send(new S3.PutObjectCommand({ Bucket: "recovery-dictionaries", Key: "words", Body: "apple, fruit" }));
await control.send(new OpenSearch.CreateDomainCommand({ DomainName: "package-recovery", EncryptionAtRestOptions: { Enabled: true } }));
const domain = sim.opensearch.domain(region, "package-recovery"); while (domain.state !== "active") await delay(10);
const search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; }), save = sim.store.save.bind(sim.store), catalog = () => sim.store.regionState(region).opensearch.packages!;
if (boundary === "import-intent") sim.store.save = async () => { if (Object.values(catalog()?.records ?? {}).some(pkg => pkg.state === "AVAILABLE")) { reached(); await new Promise(() => {}); } await save(); };
const source = { S3BucketName: "recovery-dictionaries", S3Key: "words" }, created = await control.send(new OpenSearch.CreatePackageCommand({ PackageName: "recovery-words", PackageType: "TXT-DICTIONARY", PackageSource: source })), id = created.PackageDetails!.PackageID!;
if (boundary !== "import-intent") {
  while ((await control.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList![0].PackageStatus !== "AVAILABLE") await delay(10);
  await control.send(new OpenSearch.AssociatePackageCommand({ PackageID: id, DomainName: domain.name })); while ((await control.send(new OpenSearch.ListPackagesForDomainCommand({ DomainName: domain.name }))).DomainPackageDetailsList![0].DomainPackageStatus !== "ACTIVE") await delay(10);
  await search.indices.create({ index: "products", body: { settings: { analysis: { analyzer: { words: { type: "custom", tokenizer: "standard", filter: ["dictionary"] } }, filter: { dictionary: { type: "synonym", synonyms_path: `analyzers/${id}`, updateable: true } } } }, mappings: { properties: { title: { type: "text", search_analyzer: "words" } } } } }); await search.index({ index: "products", id: "one", body: { title: "apple" }, refresh: true });
  await s3.send(new S3.PutObjectCommand({ Bucket: "recovery-dictionaries", Key: "words", Body: "apple, pear" })); await control.send(new OpenSearch.UpdatePackageCommand({ PackageID: id, PackageSource: source })); while ((await control.send(new OpenSearch.DescribePackagesCommand({}))).PackageDetailsList![0].AvailablePackageVersion !== "2") await delay(10);
  if (boundary === "association-install") {
    sim.store.save = async () => { if (catalog().records[id].associations[domain.generation].state === "ACTIVE" && catalog().records[id].associations[domain.generation].activeVersion === "2") { reached(); await new Promise(() => {}); } await save(); };
    await control.send(new OpenSearch.AssociatePackageCommand({ PackageID: id, DomainName: domain.name }));
  } else {
    await search.indices.delete({ index: "products" }); await control.send(new OpenSearch.DissociatePackageCommand({ PackageID: id, DomainName: domain.name })); while ((await control.send(new OpenSearch.ListPackagesForDomainCommand({ DomainName: domain.name }))).DomainPackageDetailsList!.length) await delay(10);
    const materials = (sim.opensearch as any).materials, remove = materials.remove.bind(materials); let removed = 0;
    materials.remove = async (id: string) => { if (++removed === 2) { reached(); await new Promise(() => {}); } await remove(id); };
    await control.send(new OpenSearch.DeletePackageCommand({ PackageID: id }));
  }
}
await entered; process.send?.({ boundary, id }); setInterval(() => {}, 1000);
