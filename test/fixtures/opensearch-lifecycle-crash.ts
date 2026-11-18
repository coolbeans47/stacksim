import { StackSim } from "../../src/server.js";
const [root, stage] = process.argv.slice(2);
const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false });
await sim.start();
const region = "eu-west-1", save = sim.store.save.bind(sim.store);
let armed = false;
const parked = async () => {
  process.send?.({ stage });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
sim.store.save = async () => {
  const domain = sim.opensearch.domains(region).find(item => item.name === "crash-domain");
  // Capture this save's checkpoint before yielding: activation and deletion can
  // overlap, and the shared domain object may change while save() is pending.
  const state = domain?.state;
  const checkpointArmed = armed;
  if (checkpointArmed && (stage === "activation-publish" && state === "active" || stage === "delete-cleanup" && !domain)) await parked();
  await save();
  if (checkpointArmed && (stage === "create-intent" && state === "creating" || stage === "delete-intent" && state === "deleting")) await parked();
};
armed = stage.startsWith("create") || stage.startsWith("activation");
await sim.opensearch.execute("CreateDomain", { DomainName: "crash-domain" }, region);
while (sim.opensearch.domain(region, "crash-domain").state !== "active") await new Promise(resolve => setTimeout(resolve, 10));
if (stage.startsWith("delete")) {
  armed = true;
  await sim.opensearch.execute("DeleteDomain", { DomainName: "crash-domain" }, region);
}
