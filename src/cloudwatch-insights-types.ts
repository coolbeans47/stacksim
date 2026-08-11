export const INSIGHTS_MISSING = Symbol("cloudwatch-insights-missing");

export type InsightsPrimitive = string | number | boolean | null;
export type InsightsValue = InsightsPrimitive | InsightsValue[] | { [key: string]: InsightsValue } | typeof INSIGHTS_MISSING;

export interface SourceSpan {
  start: number;
  end: number;
}

export interface InsightsRecord {
  fields: Record<string, Exclude<InsightsValue, typeof INSIGHTS_MISSING>>;
  pointer: string;
  bytes: number;
}

export interface InsightsResult {
  rows: Array<Array<{ field: string; value: string }>>;
  recordsMatched: number;
}

export interface QueryRuntimeContext {
  queryStartTime?: number;
  queryEndTime?: number;
  now?: number;
}

export class InsightsSyntaxError extends Error {
  constructor(message: string, readonly start: number, readonly end = start + 1) {
    super(message);
    this.name = "InsightsSyntaxError";
  }
}

export class InsightsEvaluationError extends Error {
  constructor(message: string, readonly span?: SourceSpan) {
    super(message);
    this.name = "InsightsEvaluationError";
  }
}
