import { EmbeddedSearchEngine } from "../../src/opensearch/engine.js";
const engine = new EmbeddedSearchEngine(process.argv[2], Date.now, process.argv[3] ? { keyFile: process.argv[3] } : undefined);
await engine.request("PUT", "/durable", Buffer.from(JSON.stringify({ settings: { refresh_interval: "-1" }, mappings: { properties: { title: { type: "text" } } }, aliases: { surviving: {} } })), "writer");
await engine.request("PUT", "/durable/_doc/acknowledged", Buffer.from(JSON.stringify({ title: "Acknowledged before a forced process exit" })), "writer");
process.send?.("acknowledged");
setInterval(() => {}, 1000);
