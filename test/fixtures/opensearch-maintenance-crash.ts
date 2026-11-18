import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { OpenSearchClient, StartDomainMaintenanceCommand } from "@aws-sdk/client-opensearch";
import { StackSim } from "../../src/server.js";

const [root, boundary] = process.argv.slice(2), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "maintenance-recovery", EncryptionAtRestOptions: { Enabled: true } }, region);
while (sim.opensearch.domain(region, "maintenance-recovery").state !== "active") await delay(10);
const domain = sim.opensearch.domain(region, "maintenance-recovery"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath), search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
await search.index({ index: "records", id: "one", body: { value: "maintenance-crash-preserved" } });
let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; }), save = sim.store.save.bind(sim.store);
sim.store.save = async () => {
  const job = domain.maintenances?.at(-1);
  if (boundary === "storage-reopened" && job?.state === "COMPLETED") { reached(); await new Promise(() => {}); }
  await save();
  if (boundary === "intent-published" && job?.state === "IN_PROGRESS") { reached(); await new Promise(() => {}); }
};
const control = new OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials });
const result = await control.send(new StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "REBOOT_NODE" }));
await entered; process.send?.({ boundary, id: result.MaintenanceId }); setInterval(() => {}, 1000);
