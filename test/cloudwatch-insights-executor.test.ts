import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyInsightsExecution, finalizeInsightsExecution, ingestInsightsRecord } from "../src/cloudwatch-insights-executor.js";
import { parseInsightsQuery } from "../src/cloudwatch-insights.js";

test("CloudWatch Logs Insights executor classifies and streams stats count(*) beyond 100000 records", () => {
  const plan = parseInsightsQuery("stats count(*) as total");
  const execution = classifyInsightsExecution(plan, 10_000);
  assert.equal(execution.mode, "stream-stats");
  const state = { records: [] as any[], buckets: new Map(), matched: 0, ordinal: 0, statsStage: plan.stages[0] as any };
  for (let index = 0; index < 100_001; index++) {
    ingestInsightsRecord({ fields: { "@timestamp": index, "@message": "event" }, pointer: `ptr-${index}`, bytes: 5 }, execution, plan, {}, state);
  }
  const executed = finalizeInsightsExecution(execution, plan, 10_000, {}, state);
  assert.equal(executed.result.rows[0]?.find(field => field.field === "total")?.value, "100001");
  assert.equal(executed.result.recordsMatched, 100_001);
});

test("CloudWatch Logs Insights executor rejects materialized collection beyond 100000 matches", () => {
  const plan = parseInsightsQuery("fields @message | sort @timestamp asc");
  const execution = classifyInsightsExecution(plan, 10_000);
  assert.equal(execution.mode, "materialize");
  const state = { records: [] as any[], buckets: new Map(), matched: 0, ordinal: 0, statsStage: undefined };
  for (let index = 0; index < 100_000; index++) {
    ingestInsightsRecord({ fields: { "@timestamp": index, "@message": "event" }, pointer: `ptr-${index}`, bytes: 5 }, execution, plan, {}, state);
  }
  assert.throws(() => ingestInsightsRecord({ fields: { "@timestamp": 100_000, "@message": "event" }, pointer: "ptr-last", bytes: 5 }, execution, plan, {}, state), /100000/);
});
