import { StackSim } from "../../src/server.js";
const [root, boundary] = process.argv.slice(2);
const region = "eu-west-1";
const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
await sim.start();
await sim.opensearch.execute("CreateDomain", { DomainName: "migration-domain" }, region);
while (sim.opensearch.domain(region, "migration-domain").state !== "active") await new Promise(resolve => setTimeout(resolve, 5));
const domain = sim.opensearch.domain(region, "migration-domain");
const engine = (sim.opensearch as any).engines.get(domain.generation);
await engine.request("PUT", "/products", Buffer.from('{"settings":{"refresh_interval":"-1"}}'), "writer");
await engine.request("PUT", "/products/_doc/ack", Buffer.from('{"title":"migration-acknowledged-payload"}'), "writer");
const save = sim.store.save.bind(sim.store);
sim.store.save = async () => {
  const change = domain.changes?.at(-1);
  const matched = boundary === "intent" ? change?.state === "PENDING" : boundary === "encrypted-ready" ? change?.encryptedReady && change.state === "PROCESSING" : change?.state === "COMPLETED";
  if (matched) {
    if (boundary !== "publish") await save();
    process.send?.({ boundary });
    await new Promise(() => {});
  }
  return save();
};
await sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, EncryptionAtRestOptions: { Enabled: true } }, region);
setInterval(() => {}, 1000);
