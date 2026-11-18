import { randomUUID } from "node:crypto";
import { categories, catalog, mappings } from "./catalog.mjs";

class InputError extends Error {
  statusCode = 400;
}
function requireInput(condition, message) {
  if (!condition) throw new InputError(message);
}
export function productInput(value) {
  requireInput(
    value && typeof value === "object" && !Array.isArray(value),
    "A product object is required.",
  );
  requireInput(
    Object.keys(value).every((key) =>
      [
        "title",
        "description",
        "category",
        "price",
        "rating",
        "inStock",
      ].includes(key),
    ),
    "Unexpected product field.",
  );
  for (const [field, limit] of [
    ["title", 100],
    ["description", 600],
  ])
    requireInput(
      typeof value[field] === "string" &&
        value[field].trim().length > 0 &&
        value[field].length <= limit,
      `${field} must contain 1–${limit} characters.`,
    );
  requireInput(
    categories.includes(value.category),
    "Choose a supported category.",
  );
  requireInput(
    Number.isFinite(value.price) &&
      value.price >= 0 &&
      value.price <= 10000 &&
      Math.abs(value.price * 100 - Math.round(value.price * 100)) < 1e-8,
    "Price must be between 0 and 10000 with at most two decimal places.",
  );
  requireInput(
    Number.isFinite(value.rating) && value.rating >= 0 && value.rating <= 5,
    "Rating must be between 0 and 5.",
  );
  requireInput(
    typeof value.inStock === "boolean",
    "inStock must be a boolean.",
  );
  return {
    ...value,
    title: value.title.trim(),
    description: value.description.trim(),
  };
}

export function searchInput(parameters = {}) {
  const {
    q = "",
    category = "",
    maxPrice = "",
    inStock = "false",
    sort = "relevance",
    page = "1",
  } = parameters;
  requireInput(
    Object.keys(parameters).every((key) =>
      ["q", "category", "maxPrice", "inStock", "sort", "page"].includes(key),
    ),
    "Unexpected search parameter.",
  );
  requireInput(
    typeof q === "string" && q.length <= 200,
    "Search text is limited to 200 characters.",
  );
  requireInput(
    category === "" || categories.includes(category),
    "Unknown category.",
  );
  requireInput(
    ["true", "false"].includes(inStock),
    "inStock must be true or false.",
  );
  requireInput(
    maxPrice === "" ||
      (/^\d+(\.\d{1,2})?$/.test(maxPrice) && Number(maxPrice) <= 10000),
    "Maximum price must be between 0 and 10000.",
  );
  requireInput(
    ["relevance", "price-asc", "price-desc", "rating"].includes(sort),
    "Unknown sort order.",
  );
  requireInput(
    /^\d+$/.test(page) && Number(page) >= 1 && Number(page) <= 1000,
    "Page must be between 1 and 1000.",
  );
  const filter = [];
  if (inStock === "true") filter.push({ term: { inStock: true } });
  if (maxPrice !== "")
    filter.push({ range: { price: { lte: Number(maxPrice) } } });
  const query = {
    bool: {
      must: [
        q.trim()
          ? {
              multi_match: {
                query: q.trim(),
                fields: ["title^3", "description"],
                type: "best_fields",
              },
            }
          : { match_all: {} },
      ],
      filter,
    },
  };
  const sorts = {
    relevance: { _score: "desc" },
    "price-asc": { price: "asc" },
    "price-desc": { price: "desc" },
    rating: { rating: "desc" },
  };
  return {
    from: (Number(page) - 1) * 6,
    size: 6,
    track_total_hits: true,
    query,
    // Category facets stay useful when a category is selected; text/price/stock still apply.
    ...(category ? { post_filter: { term: { category } } } : {}),
    sort: [sorts[sort], { id: "asc" }],
    aggs: { categories: { terms: { field: "category", size: 4 } } },
  };
}

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};
const reply = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});
function bodyOf(event) {
  requireInput(!event.isBase64Encoded, "Send a JSON request body.");
  requireInput(
    typeof event.body === "string" && Buffer.byteLength(event.body) <= 4096,
    "Send a JSON body of at most 4 KiB.",
  );
  try {
    return JSON.parse(event.body);
  } catch {
    throw new InputError("Request body must be valid JSON.");
  }
}

// Dependency injection keeps request validation testable without a simulator.
export function createHandler(connect, index = "catalog") {
  return async (event) => {
    let client;
    try {
      const method = event.httpMethod;
      const route = event.resource;
      let query, product, id;
      if (method === "GET" && route === "/search")
        query = searchInput(event.queryStringParameters ?? {});
      else if (method === "POST" && route === "/seed") {
        /* no payload required */
      } else if (route === "/products" && method === "POST")
        product = productInput(bodyOf(event));
      else if (
        route === "/products/{id}" &&
        ["PUT", "DELETE"].includes(method)
      ) {
        id = event.pathParameters?.id;
        requireInput(
          typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id),
          "Invalid product ID.",
        );
        if (method === "PUT") product = productInput(bodyOf(event));
      } else return reply(404, { message: "Route not found." });
      client = await connect();
      if (query) {
        const [result, count] = await Promise.all([
          client.search({ index, body: query }),
          client.count({ index }),
        ]);
        return reply(200, {
          index,
          indexedCount: count.body.count,
          request: query,
          response: result.body,
        });
      }
      if (route === "/seed") {
        try {
          await client.indices.create({ index, body: { mappings } });
        } catch (error) {
          if (
            error.meta?.body?.error?.type !==
            "resource_already_exists_exception"
          )
            throw error;
        }
        const result = (
          await client.bulk({
            index,
            refresh: true,
            body: catalog.flatMap((document) => [
              { create: { _id: document.id } },
              document,
            ]),
          })
        ).body;
        const items = result.items.map((item) => item.create);
        const failed = items.filter(
          (item) => item.status !== 409 && item.status >= 300,
        );
        if (failed.length)
          throw new Error(`Could not index ${failed.length} sample products.`);
        return reply(200, {
          created: items.filter((item) => item.status === 201).length,
          skipped: items.filter((item) => item.status === 409).length,
        });
      }
      if (method === "DELETE") {
        await client.delete({ index, id, refresh: true });
        return reply(200, { id, deleted: true });
      }
      if (method === "PUT") {
        // Update must not silently recreate a document deleted by another client.
        await client.update({
          index,
          id,
          refresh: true,
          body: { doc: product },
        });
        return reply(200, { id, ...product });
      }
      id = randomUUID();
      await client.create({
        index,
        id,
        refresh: true,
        body: { id, ...product },
      });
      return reply(201, { id, ...product });
    } catch (error) {
      if (error instanceof InputError)
        return reply(400, { message: error.message });
      if (error.meta?.statusCode === 404)
        return reply(404, {
          message:
            "Product or catalog not found. Load sample data to initialize the catalog.",
        });
      console.error("Search Lab request failed", error);
      return reply(502, {
        message:
          "OpenSearch request failed. Check the SearchApi Lambda logs in StackSim.",
      });
    } finally {
      await client?.close();
    }
  };
}
