import { evaluateExpression, insightsTruthy, isMissing, isStructure, numeric, valueAt, type ExpressionNode } from "./cloudwatch-insights-expression.js";
import {
  compareInsightsValues,
  parseInsightsQuery,
  runInsightsQuery,
  runInsightsQueryOnRows,
  runtimeRowsToInsightsResult,
  type InsightsQueryPlan,
  type InsightsStage,
} from "./cloudwatch-insights.js";
import { INSIGHTS_MISSING, InsightsSyntaxError, type InsightsRecord, type InsightsResult, type InsightsValue, type QueryRuntimeContext, type SourceSpan } from "./cloudwatch-insights-types.js";

export const QUERY_MATCH_BUFFER_LIMIT = 100_000;

const PREFIX_STAGE_KINDS = new Set(["fields", "display", "filter", "parse", "filterIndex"]);
const STREAMABLE_AGGREGATES = new Set(["count", "sum", "sum_over_time", "avg", "min", "max", "count_distinct", "count_over_time"]);

export class QueryResourceLimitError extends Error {
  constructor(message = "The query matched more than 100000 records and cannot be executed within local limits") {
    super(message);
    this.name = "QueryResourceLimitError";
  }
}

export class QueryCancelledError extends Error {
  constructor(message = "The query was cancelled") {
    super(message);
    this.name = "QueryCancelledError";
  }
}

export interface QueryExecutionControl {
  cancelled?: () => boolean;
  deadline?: () => boolean;
}

export interface InsightsExecutionPlan {
  mode: "stream-stats" | "early-limit-any" | "materialize";
  prefix?: InsightsStage[];
  statsIndex?: number;
  suffix?: InsightsStage[];
  earlyLimit?: number;
  prefixPlan?: InsightsQueryPlan;
  collectionPrefix?: InsightsStage[];
  postStages?: InsightsStage[];
}

interface RuntimeRow {
  fields: Record<string, InsightsValue>;
  pointer?: string;
  projection?: string[];
  aggregate?: boolean;
  ordinal: number;
}

interface StatsStage extends SourceSpan {
  kind: "stats";
  selections: Array<{ expression: ExpressionNode; alias: string; start: number; end: number }>;
  groups: Array<{ expression: ExpressionNode; alias: string; start: number; end: number }>;
  offset?: number;
}

interface AggregateStreamState {
  count: number;
  fieldCount: number;
  sum: number;
  numericCount: number;
  min?: InsightsValue;
  max?: InsightsValue;
  distinct?: Set<string>;
  rows: RuntimeRow[];
}

interface StreamingBucket {
  groupValues: InsightsValue[];
  aggregates: Map<string, AggregateStreamState>;
}

function environment(row: RuntimeRow, context?: QueryRuntimeContext) {
  return { fields: row.fields, context };
}

function rejectStructure(command: string, values: InsightsValue[], span: SourceSpan): void {
  if (values.some(isStructure)) throw new InsightsSyntaxError(`${command} does not support map or list values`, span.start, span.end);
}

function aggregateKey(node: ExpressionNode): string {
  return JSON.stringify(node);
}

function requiresRowMaterialization(node: ExpressionNode): boolean {
  if (node.kind === "call") return !STREAMABLE_AGGREGATES.has(node.name);
  if (node.kind === "binary") return requiresRowMaterialization(node.left) || requiresRowMaterialization(node.right);
  if (node.kind === "unary") return requiresRowMaterialization(node.operand);
  if (node.kind === "access") return requiresRowMaterialization(node.target) || requiresRowMaterialization(node.key);
  if (node.kind === "list") return node.items.some(requiresRowMaterialization);
  if (node.kind === "map") return node.entries.some(entry => requiresRowMaterialization(entry.value));
  return false;
}

function isStreamableStatsStage(stage: StatsStage): boolean {
  return stage.selections.every(selection => !requiresRowMaterialization(selection.expression));
}

export function classifyInsightsExecution(plan: InsightsQueryPlan, jobLimit: number): InsightsExecutionPlan {
  const anyIndex = plan.stages.findIndex(stage => stage.kind === "limit" && stage.any);
  if (anyIndex >= 0 && plan.stages.slice(0, anyIndex).every(stage => PREFIX_STAGE_KINDS.has(stage.kind))) {
    const earlyLimit = Math.min(jobLimit, (plan.stages[anyIndex] as { limit: number }).limit);
    return {
      mode: "early-limit-any",
      earlyLimit,
      prefixPlan: { ...plan, stages: plan.stages.slice(0, anyIndex) },
    };
  }

  const statsIndices = plan.stages.map((stage, index) => stage.kind === "stats" ? index : -1).filter(index => index >= 0);
  if (statsIndices.length === 1) {
    const statsIndex = statsIndices[0]!;
    const prefix = plan.stages.slice(0, statsIndex);
    const suffix = plan.stages.slice(statsIndex + 1);
    const statsStage = plan.stages[statsIndex] as StatsStage;
    if (prefix.every(stage => PREFIX_STAGE_KINDS.has(stage.kind)) && suffix.every(stage => stage.kind === "sort" || stage.kind === "limit") && isStreamableStatsStage(statsStage)) {
      return { mode: "stream-stats", prefix, statsIndex, suffix };
    }
  }

  const materialized = splitMaterializePlan(plan);
  return { mode: "materialize", collectionPrefix: materialized.collectionPrefix, postStages: materialized.postStages };
}

function splitMaterializePlan(plan: InsightsQueryPlan): { collectionPrefix: InsightsStage[]; postStages: InsightsStage[] } {
  const splitIndex = plan.stages.findIndex(stage => !PREFIX_STAGE_KINDS.has(stage.kind) || (stage.kind === "limit" && !stage.any));
  if (splitIndex >= 0) return { collectionPrefix: plan.stages.slice(0, splitIndex), postStages: plan.stages.slice(splitIndex) };
  return { collectionPrefix: plan.stages.filter(stage => PREFIX_STAGE_KINDS.has(stage.kind)), postStages: plan.stages.filter(stage => !PREFIX_STAGE_KINDS.has(stage.kind)) };
}

function applyPrefixStages(record: InsightsRecord, prefix: InsightsStage[], context: QueryRuntimeContext, ordinal: number): RuntimeRow | null {
  let row: RuntimeRow = { fields: { ...record.fields }, pointer: record.pointer, ordinal };
  for (const stage of prefix) {
    if (stage.kind === "fields" || stage.kind === "display") {
      for (const selection of stage.selections) row.fields[selection.alias] = evaluateExpression(selection.expression, environment(row, context));
      const selected = stage.selections.map(selection => selection.alias);
      row.projection = stage.kind === "display" ? selected : [...new Set([...(row.projection ?? []), ...selected])];
    } else if (stage.kind === "filter" || stage.kind === "filterIndex") {
      if (!insightsTruthy(evaluateExpression(stage.expression, environment(row, context)))) return null;
    } else if (stage.kind === "parse") {
      const value = evaluateExpression(stage.expression, environment(row, context));
      if (isMissing(value) || value === null || isStructure(value)) continue;
      stage.pattern.lastIndex = 0;
      const captures = stage.pattern.exec(String(value));
      if (!captures) continue;
      stage.aliases.forEach((alias, index) => {
        row.fields[alias] = stage.named.length ? captures.groups?.[alias] ?? INSIGHTS_MISSING : captures[index + 1] ?? INSIGHTS_MISSING;
      });
    }
  }
  return row;
}

function bucketKey(stage: StatsStage, row: RuntimeRow, context: QueryRuntimeContext): { key: string; values: InsightsValue[] } {
  const values = stage.groups.map(group => {
    const value = evaluateExpression(group.expression, environment(row, context));
    return stage.offset && group.expression.kind === "call" && group.expression.name === "bin" && typeof value === "number" ? value + stage.offset : value;
  });
  rejectStructure("stats", values, stage);
  return { key: JSON.stringify(values.map(value => isMissing(value) ? { missing: true } : value)), values };
}

function aggregateStateFor(node: ExpressionNode, bucket: StreamingBucket): AggregateStreamState {
  const key = aggregateKey(node);
  const state = bucket.aggregates.get(key);
  if (state) return state;
  const created = { count: 0, fieldCount: 0, sum: 0, numericCount: 0, rows: [] as RuntimeRow[] };
  bucket.aggregates.set(key, created);
  return created;
}

function updateAggregateState(node: Extract<ExpressionNode, { kind: "call" }>, state: AggregateStreamState, row: RuntimeRow, context: QueryRuntimeContext): void {
  const argument = node.name === "topk" ? node.arguments[1] : node.arguments[0];
  const evaluated = argument && !(argument.kind === "field" && argument.name === "*") ? evaluateExpression(argument, environment(row, context)) : INSIGHTS_MISSING;
  if (isStructure(evaluated)) throw new InsightsSyntaxError("stats does not support map or list values", node.start, node.end);
  state.count++;
  if (!(argument && argument.kind === "field" && argument.name === "*") && !isMissing(evaluated) && evaluated !== null) {
    state.fieldCount++;
    const number = numeric(evaluated);
    if (number !== undefined) {
      state.sum += number;
      state.numericCount++;
      state.min = state.min === undefined ? evaluated : compareInsightsValues(evaluated, state.min) < 0 ? evaluated : state.min;
      state.max = state.max === undefined ? evaluated : compareInsightsValues(evaluated, state.max) > 0 ? evaluated : state.max;
    } else {
      state.min = state.min === undefined ? evaluated : compareInsightsValues(evaluated, state.min) < 0 ? evaluated : state.min;
      state.max = state.max === undefined ? evaluated : compareInsightsValues(evaluated, state.max) > 0 ? evaluated : state.max;
    }
    if (node.name === "count_distinct") {
      const distinct = state.distinct ?? new Set<string>();
      distinct.add(`${typeof evaluated}:${String(evaluated)}`);
      if (distinct.size > QUERY_MATCH_BUFFER_LIMIT) throw new QueryResourceLimitError("The query exceeded the 100000 distinct-value limit");
      state.distinct = distinct;
    }
  }
  if (requiresRowMaterialization(node)) state.rows.push(row);
}

function collectAggregateNodes(node: ExpressionNode, output: Extract<ExpressionNode, { kind: "call" }>[]): void {
  if (node.kind === "call" && STREAMABLE_AGGREGATES.has(node.name)) output.push(node);
  else if (node.kind === "binary") { collectAggregateNodes(node.left, output); collectAggregateNodes(node.right, output); }
  else if (node.kind === "unary") collectAggregateNodes(node.operand, output);
  else if (node.kind === "access") collectAggregateNodes(node.target, output);
  else if (node.kind === "list") node.items.forEach(item => collectAggregateNodes(item, output));
  else if (node.kind === "map") node.entries.forEach(entry => collectAggregateNodes(entry.value, output));
}

function updateStreamingBucket(buckets: Map<string, StreamingBucket>, stage: StatsStage, row: RuntimeRow, context: QueryRuntimeContext): void {
  const { key, values } = bucketKey(stage, row, context);
  const bucket = buckets.get(key) ?? { groupValues: values, aggregates: new Map() };
  buckets.set(key, bucket);
  for (const selection of stage.selections) {
    const nodes: Extract<ExpressionNode, { kind: "call" }>[] = [];
    collectAggregateNodes(selection.expression, nodes);
    for (const node of nodes) updateAggregateState(node, aggregateStateFor(node, bucket), row, context);
  }
}

function finalizeAggregate(node: Extract<ExpressionNode, { kind: "call" }>, state: AggregateStreamState): InsightsValue {
  const argument = node.name === "topk" ? node.arguments[1] : node.arguments[0];
  const name = node.name;
  if (name === "count") return argument && !(argument.kind === "field" && argument.name === "*") ? state.fieldCount : state.count;
  if (name === "sum" || name === "sum_over_time") return state.numericCount ? state.sum : 0;
  if (name === "avg") return state.numericCount ? state.sum / state.numericCount : null;
  if (name === "min") return state.min ?? null;
  if (name === "max") return state.max ?? null;
  if (name === "count_distinct") return state.distinct?.size ?? 0;
  if (name === "count_over_time") return state.fieldCount;
  return INSIGHTS_MISSING;
}

function cloneWithAggregate(node: ExpressionNode, bucket: StreamingBucket, context?: QueryRuntimeContext): ExpressionNode {
  if (node.kind === "call" && STREAMABLE_AGGREGATES.has(node.name)) {
    const state = bucket.aggregates.get(aggregateKey(node));
    return { kind: "literal", value: state ? finalizeAggregate(node, state) : INSIGHTS_MISSING, start: node.start, end: node.end };
  }
  if (node.kind === "binary") return { ...node, left: cloneWithAggregate(node.left, bucket, context), right: cloneWithAggregate(node.right, bucket, context) };
  if (node.kind === "unary") return { ...node, operand: cloneWithAggregate(node.operand, bucket, context) };
  if (node.kind === "call") return { ...node, arguments: node.arguments.map(argument => cloneWithAggregate(argument, bucket, context)) };
  if (node.kind === "list") return { ...node, items: node.items.map(item => cloneWithAggregate(item, bucket, context)) };
  if (node.kind === "map") return { ...node, entries: node.entries.map(entry => ({ ...entry, value: cloneWithAggregate(entry.value, bucket, context) })) };
  if (node.kind === "access") return { ...node, target: cloneWithAggregate(node.target, bucket, context), key: cloneWithAggregate(node.key, bucket, context) };
  return node;
}

function finalizeStreamingBuckets(buckets: Map<string, StreamingBucket>, stage: StatsStage, context: QueryRuntimeContext): RuntimeRow[] {
  if (!stage.groups.length && !buckets.size) buckets.set("[]", { groupValues: [], aggregates: new Map() });
  let ordinal = 0;
  return [...buckets.values()].map(bucket => {
    const fields: Record<string, InsightsValue> = {};
    stage.groups.forEach((group, index) => { fields[group.alias] = bucket.groupValues[index]; });
    for (const selection of stage.selections) fields[selection.alias] = evaluateExpression(cloneWithAggregate(selection.expression, bucket, context), { fields, context });
    return { fields, projection: [...stage.groups.map(group => group.alias), ...stage.selections.map(selection => selection.alias)], aggregate: true, ordinal: ordinal++ };
  });
}

export interface QueryScanStatistics {
  scanned: number;
  scannedBytes: number;
  matched: number;
}

export interface ExecutedInsightsQuery {
  result: InsightsResult;
  statistics: QueryScanStatistics;
}

function checkControl(control?: QueryExecutionControl): void {
  if (control?.cancelled?.()) throw new QueryCancelledError();
  if (control?.deadline?.()) throw new Error("The query exceeded the 60-minute execution deadline");
}

export function ingestInsightsRecord(
  record: InsightsRecord,
  execution: InsightsExecutionPlan,
  plan: InsightsQueryPlan,
  context: QueryRuntimeContext,
  state: {
    records: InsightsRecord[];
    buckets: Map<string, StreamingBucket>;
    matched: number;
    ordinal: number;
    statsStage?: StatsStage;
  },
): boolean {
  if (execution.mode === "stream-stats") {
    const row = applyPrefixStages(record, execution.prefix ?? [], context, state.ordinal++);
    if (!row) return false;
    state.matched++;
    updateStreamingBucket(state.buckets, state.statsStage!, row, context);
    return true;
  }

  if (execution.mode === "early-limit-any") {
    const prefix = execution.prefixPlan!;
    if (runInsightsQueryOnRows(prefix.stages, [{ fields: { ...record.fields }, pointer: record.pointer, ordinal: state.ordinal }], 1, context).rows.length) {
      if (state.records.length >= (execution.earlyLimit ?? QUERY_MATCH_BUFFER_LIMIT)) return false;
      state.records.push(record);
      state.matched++;
      return true;
    }
    return false;
  }

  const prefix = execution.collectionPrefix ?? [];
  if (prefix.length) {
    if (!applyPrefixStages(record, prefix, context, state.ordinal++)) return false;
  } else state.ordinal++;
  if (state.records.length >= QUERY_MATCH_BUFFER_LIMIT) throw new QueryResourceLimitError();
  state.records.push(record);
  state.matched++;
  return true;
}

export function finalizeInsightsExecution(
  execution: InsightsExecutionPlan,
  plan: InsightsQueryPlan,
  maximum: number,
  context: QueryRuntimeContext,
  state: {
    records: InsightsRecord[];
    buckets: Map<string, StreamingBucket>;
    matched: number;
    statsStage?: StatsStage;
  },
  control?: QueryExecutionControl,
): ExecutedInsightsQuery {
  checkControl(control);
  if (execution.mode === "stream-stats") {
    let rows = finalizeStreamingBuckets(state.buckets, state.statsStage!, context);
    if (execution.suffix?.length) {
      const suffixResult = runInsightsQueryOnRows(execution.suffix, rows, maximum, context, state.matched);
      return { result: suffixResult, statistics: { scanned: 0, scannedBytes: 0, matched: state.matched } };
    }
    return { result: runtimeRowsToInsightsResult(rows, maximum, state.matched), statistics: { scanned: 0, scannedBytes: 0, matched: state.matched } };
  }

  if (execution.mode === "early-limit-any") {
    const result = runInsightsQuery(plan, state.records, maximum, context);
    return { result: { ...result, recordsMatched: state.matched }, statistics: { scanned: 0, scannedBytes: 0, matched: state.matched } };
  }

  const result = runInsightsQuery(plan, state.records, maximum, context);
  return { result, statistics: { scanned: 0, scannedBytes: 0, matched: state.matched } };
}
