import { setTimeout as delay } from "node:timers/promises";
import { StackSim } from "../../src/server.js";
import { TestClock } from "../../src/core/clock.js";

const [root, boundary] = process.argv.slice(2), region = "eu-west-1", clock = new TestClock(Date.now() - 3600000), sim = new StackSim({ dataDir: root, region, clock, port: 0, invokePort: 0, cdkBootstrap: false, authMode: "enforce" });
await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "automatic-recovery", EncryptionAtRestOptions: { Enabled: true } }, region);
const domain = sim.opensearch.domain(region, "automatic-recovery"); while (domain.state !== "active") await delay(10);
await (sim.opensearch as any).engine(domain).request("PUT", "/records/_doc/one", Buffer.from('{"title":"automatic-crash-source"}'), "seed");
let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; }), save = sim.store.save.bind(sim.store);
if (boundary === "before-catalog") sim.store.save = async () => { if (domain.automaticBackups?.items.length) { reached(); await new Promise(() => {}); } await save(); };
else { const materials = (sim.opensearch as any).automaticBackups.materials; materials.commit = async () => { reached(); await new Promise(() => {}); }; }
clock.advance(3600000); await entered; process.send?.({ boundary, name: domain.automaticBackups!.items[0].name }); setInterval(() => {}, 1000);
