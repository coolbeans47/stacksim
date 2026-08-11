import assert from "node:assert/strict";

const apiUrl = process.argv[2] ?? process.env.API_URL;
if (!apiUrl) throw new Error("Pass the Terraform api_url output as the first argument or set API_URL.");

const id = `smoke-${Date.now()}`;
const createdResponse = await fetch(apiUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, title: "Created through Terraform" }),
});
const createdBody = await createdResponse.text();
assert.equal(createdResponse.status, 201, createdBody);
const created = JSON.parse(createdBody);
assert.deepEqual(created, { id, title: "Created through Terraform" });

const listedResponse = await fetch(apiUrl);
const listedBody = await listedResponse.text();
assert.equal(listedResponse.status, 200, listedBody);
const listed = JSON.parse(listedBody);
assert.ok(listed.items.some((item) => item.id === id && item.title === created.title));

console.log(JSON.stringify({ apiUrl, created, itemCount: listed.items.length }, null, 2));
