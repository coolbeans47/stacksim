import { readFile } from "node:fs/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

const endpoint = process.env.OPENSEARCH_ENDPOINT;
const caPath = process.env.AWS_CA_BUNDLE;
if (!endpoint || !caPath) throw new Error("Set OPENSEARCH_ENDPOINT to the HTTPS stack output and AWS_CA_BUNDLE to the local CA file.");
const client = new Client({
  node: endpoint,
  ssl: { ca: await readFile(caPath) },
  ...AwsSigv4Signer({ region: process.env.AWS_REGION ?? "eu-west-1", service: "es", getCredentials: async () => ({ accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "password", ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) }) }),
});
try {
  if (!(await client.indices.exists({ index: "products" })).body) await client.indices.create({ index: "products", body: {
    mappings: { properties: { title: { type: "text" }, category: { type: "keyword" }, price: { type: "double" } } },
  } });
  const products = [{ id: "shoe-red", title: "Red leather shoes", category: "shoes", price: 45 }, { id: "shoe-blue", title: "Blue running shoes", category: "shoes", price: 65 }, { id: "bag-tan", title: "Tan leather bag", category: "bags", price: 80 }];
  const bulk = await client.bulk({ refresh: true, body: products.flatMap(({ id, ...product }) => [{ index: { _index: "products", _id: id } }, product]) });
  if (bulk.body.errors) throw new Error(`Some product writes failed: ${JSON.stringify(bulk.body.items)}`);
  const result = await client.search({ index: "products", body: {
    query: { bool: { must: [{ match: { title: "leather" } }], filter: [{ range: { price: { lte: 60 } } }] } },
    aggs: { categories: { terms: { field: "category" } } },
  } });
  console.log(JSON.stringify(result.body, null, 2));
} finally { await client.close(); }
