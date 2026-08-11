import assert from "node:assert/strict";
import test from "node:test";
import { bugs, users } from "../seed/demo-data.mjs";
import { seedThroughGraphql } from "../scripts/seed-lib.mjs";

function memoryGraphql() {
  const state = { users: new Map(), bugs: new Map() };
  return {
    state,
    async request(query, variables) {
      if (query.includes("saveUser")) {
        state.users.set(variables.input.id, structuredClone(variables.input));
        return { saveUser: variables.input };
      }
      if (query.includes("saveBug")) {
        state.bugs.set(variables.input.id, structuredClone(variables.input));
        return { saveBug: variables.input };
      }
      const connection = items => {
        const offset = variables.nextToken ? Number(variables.nextToken) : 0;
        const limit = variables.limit ?? 50;
        const page = items.slice(offset, offset + limit);
        return { items: structuredClone(page), nextToken: offset + page.length < items.length ? String(offset + page.length) : null, scannedCount: items.length };
      };
      if (query.includes("listUsers")) return { listUsers: connection([...state.users.values()]) };
      if (query.includes("listBugs")) return { listBugs: connection([...state.bugs.values()]) };
      if (query.includes("bugsByStatus")) return { bugsByStatus: connection([...state.bugs.values()].filter(item => item.status === variables.status)) };
      if (query.includes("bugsByAssignee")) return { bugsByAssignee: connection([...state.bugs.values()].filter(item => item.assigneeId === variables.id)) };
      throw new Error(`Unexpected GraphQL operation: ${query}`);
    },
  };
}

test("demo data has the promised stable distribution", () => {
  assert.equal(users.length, 6);
  assert.deepEqual(users.map(item => item.team).sort(), ["Experience", "Mobile", "Platform", "Product", "Quality", "Reliability"]);
  assert.equal(new Set(users.map(item => item.id)).size, 6);
  assert.equal(bugs.length, 12);
  assert.equal(new Set(bugs.map(item => item.id)).size, 12);
  assert.equal(bugs.filter(item => item.assigneeId).length, 11);
  assert.equal(bugs.filter(item => !item.assigneeId && item.status === "BACKLOG").length, 1);
  assert.equal(bugs.filter(item => item.status === "RESOLVED" && item.resolvedAt).length, 2);
});

test("GraphQL seeding is idempotent and updates stable IDs", async () => {
  const mock = memoryGraphql();
  const first = await seedThroughGraphql(mock.request);
  assert.deepEqual(first.users, { created: 6, updated: 0, total: 6 });
  assert.deepEqual(first.bugs, { created: 12, updated: 0, total: 12 });
  const second = await seedThroughGraphql(mock.request);
  assert.deepEqual(second.users, { created: 0, updated: 6, total: 6 });
  assert.deepEqual(second.bugs, { created: 0, updated: 12, total: 12 });
  assert.equal(mock.state.users.size, 6);
  assert.equal(mock.state.bugs.size, 12);
});
