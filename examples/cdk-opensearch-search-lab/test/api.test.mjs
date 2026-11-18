import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler, productInput, searchInput } from "../lambda/api.mjs";

test("rejects malformed search inputs before opening an OpenSearch connection", async () => {
  const handler = createHandler(() =>
    assert.fail("Invalid input must not reach OpenSearch."),
  );
  for (const query of [
    { sort: "script" },
    { page: "0" },
    { page: "1001" },
    { page: "1.2" },
    { maxPrice: "-1" },
    { maxPrice: "Infinity" },
    { maxPrice: "1.234" },
    { inStock: "yes" },
    { category: "unknown" },
    { q: "x".repeat(201) },
    { script: "something" },
  ]) {
    assert.equal(
      (
        await handler({
          httpMethod: "GET",
          resource: "/search",
          queryStringParameters: query,
        })
      ).statusCode,
      400,
      JSON.stringify(query),
    );
  }
  assert.equal(
    (
      await handler({
        httpMethod: "PUT",
        resource: "/products/{id}",
        pathParameters: { id: "../other-index" },
        body: "{}",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await handler({
        httpMethod: "POST",
        resource: "/products",
        body: "{broken",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await handler({ httpMethod: "GET", resource: "/unsupported" })).statusCode,
    404,
  );
});

test("product validation rejects accidental coercion and keeps documents bounded", () => {
  const valid = {
    title: "  Travel camera  ",
    description: "A small camera.",
    category: "Cameras",
    price: 199.99,
    rating: 4.5,
    inStock: true,
  };
  assert.equal(productInput(valid).title, "Travel camera");
  for (const patch of [
    { price: "19" },
    { price: -1 },
    { price: 1.234 },
    { rating: 6 },
    { inStock: "true" },
    { title: "   " },
    { description: "a".repeat(601) },
    { id: "override" },
  ])
    assert.throws(() => productInput({ ...valid, ...patch }));
});

test("combined search preserves category facets and stable paginated sorting", () => {
  const request = searchInput({
    q: "wireless",
    category: "Audio",
    inStock: "true",
    maxPrice: "100",
    sort: "price-asc",
    page: "2",
  });
  assert.equal(request.from, 6);
  assert.deepEqual(request.post_filter, { term: { category: "Audio" } });
  assert.deepEqual(request.sort, [{ price: "asc" }, { id: "asc" }]);
  assert.equal(request.query.bool.filter.length, 2);
  assert.equal(request.aggs.categories.terms.field, "category");
});

test("seed tolerates existing samples but surfaces actual bulk failures", async () => {
  let fail = false,
    closed = 0;
  const handler = createHandler(async () => ({
    indices: {
      create: async () => {
        throw {
          meta: {
            body: { error: { type: "resource_already_exists_exception" } },
          },
        };
      },
    },
    bulk: async ({ body, refresh, index }) => {
      assert.equal(index, "catalog");
      assert.equal(refresh, true);
      assert.ok(
        body.filter((_, i) => i % 2 === 0).every((action) => action.create),
        "Only create actions; never replace edited samples.",
      );
      return {
        body: {
          items: [
            { create: { status: 201 } },
            { create: { status: fail ? 400 : 409 } },
          ],
        },
      };
    },
    close: async () => {
      closed++;
    },
  }));
  assert.deepEqual(
    JSON.parse((await handler({ httpMethod: "POST", resource: "/seed" })).body),
    { created: 1, skipped: 1 },
  );
  fail = true;
  assert.equal(
    (await handler({ httpMethod: "POST", resource: "/seed" })).statusCode,
    502,
  );
  assert.equal(closed, 2);
});
