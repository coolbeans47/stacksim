import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

const { INGESTION_ENDPOINT, OPENSEARCH_ENDPOINT, AWS_CA_BUNDLE } = process.env;
if (!INGESTION_ENDPOINT || !OPENSEARCH_ENDPOINT || !AWS_CA_BUNDLE) throw new Error("Set INGESTION_ENDPOINT and OPENSEARCH_ENDPOINT to the HTTPS stack outputs, and AWS_CA_BUNDLE to the local CA file.");
const ca = await readFile(AWS_CA_BUNDLE), region = process.env.AWS_REGION ?? "eu-west-1";
const getCredentials = async () => ({ accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "password", ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) });
const source = new Client({ node: INGESTION_ENDPOINT, ssl: { ca }, ...AwsSigv4Signer({ region, service: "osis", getCredentials }) });
const search = new Client({ node: OPENSEARCH_ENDPOINT, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials }) });
try {
  await source.transport.request({ method: "POST", path: "/logs/ingest", body: [{ id: "checkout", message: "Checkout completed", status: "200", secret: "removed-by-pipeline" }, { id: "catalog", message: "Catalog loaded", status: "200" }] });
  let delivered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const first = await search.get({ index: "logs", id: "checkout" }), second = await search.get({ index: "logs", id: "catalog" }); delivered = first.body._source.status === 200 && first.body._source.secret === undefined && second.body._source.source === "http-pipeline"; }
    catch (error) { if (error.statusCode !== 404) throw error; }
    if (delivered) break; await delay(1000);
  }
  if (!delivered) throw new Error("Delivery did not complete in 30 seconds. Check pipeline Delivery diagnostics and the role/sink permissions.");
  await search.indices.refresh({ index: "logs" });
  console.log(JSON.stringify((await search.search({ index: "logs", body: { query: { match: { message: "completed" } } } })).body, null, 2));
} finally { await source.close(); await search.close(); }
