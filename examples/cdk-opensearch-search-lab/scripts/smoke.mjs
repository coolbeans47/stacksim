import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import {
  apiRequest,
  localEnvironment,
  readManifest,
  requireSimulator,
  runtimeRoot,
} from "./common.mjs";

await requireSimulator();
const manifest = await readManifest(),
  env = localEnvironment();
const search = new Client({
  node: manifest.searchEndpoint,
  ssl: { ca: await readFile(join(runtimeRoot, "ca.pem")) },
  ...AwsSigv4Signer({
    region: manifest.region,
    service: "es",
    getCredentials: async () => ({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    }),
  }),
});
const token = `smoke${randomUUID().replaceAll("-", "")}`;
let id;
try {
  const website = await fetch(manifest.websiteUrl);
  assert.equal(website.status, 200);
  assert.match(await website.text(), /Fieldwork · OpenSearch Lab/);
  for (const path of ["assets/app.js", "assets/app.css"])
    assert.equal(
      (await fetch(`${manifest.websiteUrl.replace(/\/$/, "")}/${path}`)).status,
      200,
      path,
    );
  const before = await apiRequest(manifest, "/search");
  assert.equal(before.index, "catalog");
  assert.ok(before.response.aggregations.categories.buckets.length > 0);
  const product = {
    title: `${token} travel headphones`,
    description: "Wireless audio for a smoke test.",
    category: "Audio",
    price: 35,
    rating: 4.5,
    inStock: true,
  };
  ({ id } = await apiRequest(manifest, "/products", {
    method: "POST",
    body: JSON.stringify(product),
  }));
  assert.deepEqual(
    (await search.get({ index: "catalog", id })).body._source,
    { id, ...product },
    "API creation reaches the real OpenSearch document endpoint.",
  );
  const found = await apiRequest(
    manifest,
    `/search?q=${token}&category=Audio&maxPrice=50&inStock=true&sort=price-asc`,
  );
  assert.equal(found.response.hits.total.value, 1);
  assert.equal(found.response.hits.hits[0]._id, id);
  assert.equal(found.response.aggregations.categories.buckets[0].key, "Audio");
  await apiRequest(manifest, `/products/${id}`, {
    method: "PUT",
    body: JSON.stringify({ ...product, price: 75, inStock: false }),
  });
  assert.equal(
    (await apiRequest(manifest, `/search?q=${token}&inStock=true`)).response
      .hits.total.value,
    0,
  );
  assert.equal(
    (await apiRequest(manifest, `/search?q=${token}&maxPrice=50`)).response.hits
      .total.value,
    0,
  );
  assert.equal(
    (await search.get({ index: "catalog", id })).body._source.price,
    75,
  );
  await apiRequest(manifest, `/products/${id}`, { method: "DELETE" });
  id = undefined;
  assert.equal(
    (await apiRequest(manifest, `/search?q=${token}`)).response.hits.total
      .value,
    0,
  );
  const invalid = await fetch(`${manifest.apiBaseUrl}/search?sort=unsupported`);
  assert.equal(invalid.status, 400);
  console.log(
    "[search-lab] passed: website assets, real signed OpenSearch document, full-text + filters + facets, update, delete and validation",
  );
} finally {
  if (id) await apiRequest(manifest, `/products/${id}`, { method: "DELETE" });
  await search.close();
}
