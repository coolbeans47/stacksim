import { compileInsightsRegex, evaluateExpression, expressionName, InsightsExpressionParser, insightsTruthy, isMissing, isStructure, numeric, valueAt, type EvaluationEnvironment, type ExpressionNode } from "./cloudwatch-insights-expression.js";
import { lexInsights, type InsightsToken } from "./cloudwatch-insights-lexer.js";
import { INSIGHTS_MISSING, InsightsSyntaxError, type InsightsRecord, type InsightsResult, type InsightsValue, type QueryRuntimeContext, type SourceSpan } from "./cloudwatch-insights-types.js";

export { INSIGHTS_MISSING, InsightsEvaluationError, InsightsSyntaxError } from "./cloudwatch-insights-types.js";
export type { InsightsPrimitive, InsightsRecord, InsightsResult, InsightsValue, QueryRuntimeContext, SourceSpan } from "./cloudwatch-insights-types.js";
export { evaluateExpression, insightsTruthy, isMissing, numeric, valueAt, type ExpressionNode } from "./cloudwatch-insights-expression.js";
export { lexInsights, type InsightsToken } from "./cloudwatch-insights-lexer.js";

interface Selection extends SourceSpan { expression: ExpressionNode; alias: string }
interface SortField extends Selection { direction: "asc" | "desc" }
interface ExecutableRegex { source: string; lastIndex: number; exec(input: string): RegExpExecArray | null }
interface ParseStage extends SourceSpan { kind: "parse"; expression: ExpressionNode; pattern: ExecutableRegex; aliases: string[]; named: string[]; glob: boolean }
interface FieldsStage extends SourceSpan { kind: "fields" | "display"; selections: Selection[] }
interface FilterStage extends SourceSpan { kind: "filter" | "filterIndex"; expression: ExpressionNode }
interface SortStage extends SourceSpan { kind: "sort"; fields: SortField[] }
interface LimitStage extends SourceSpan { kind: "limit"; limit: number; any: boolean }
interface DedupStage extends SourceSpan { kind: "dedup"; fields: Selection[] }
interface StatsStage extends SourceSpan { kind: "stats"; selections: Selection[]; groups: Selection[]; offset?: number }
export type InsightsStage = ParseStage | FieldsStage | FilterStage | SortStage | LimitStage | DedupStage | StatsStage;
export interface InsightsQueryPlan { language: "CWLI"; source: string; stages: InsightsStage[] }

interface RuntimeRow {
  fields: Record<string, InsightsValue>;
  pointer?: string;
  projection?: string[];
  aggregate?: boolean;
  ordinal: number;
}

const AGGREGATES = new Set(["avg", "count", "count_distinct", "max", "min", "pct", "stddev", "sum", "values", "collect_values", "variance", "topk", "earliest", "latest", "sortsfirst", "sortslast", "rate", "count_over_time", "sum_over_time", "histogram"]);

class QueryParser extends InsightsExpressionParser {
  constructor(private readonly source: string, tokens: InsightsToken[]) { super(tokens); }

  query(): InsightsQueryPlan {
    if (this.current().kind === "eof") throw new InsightsSyntaxError("Query string must not be empty", 0, Math.max(1, this.source.length));
    const stages: InsightsStage[] = []; let afterDedup = false; let statsCount = 0; let visibleFields: Set<string> | undefined;
    while (this.current().kind !== "eof") {
      const command = this.consume();
      if (command.kind !== "identifier" || command.quoted) throw new InsightsSyntaxError("Expected a query command", command.start, command.end);
      const lower = command.text.toLowerCase();
      if (afterDedup && lower !== "limit") throw new InsightsSyntaxError("Only limit can follow dedup", command.start, command.end);
      let stage: InsightsStage;
      if (lower === "fields" || lower === "display") stage = this.fields(lower, command.start);
      else if (lower === "filter") stage = this.filter("filter", command.start);
      else if (lower === "parse") stage = this.parseStage(command.start);
      else if (lower === "sort") stage = this.sort(command.start);
      else if (lower === "limit") stage = this.limit(command.start);
      else if (lower === "dedup") { stage = this.dedup(command.start); afterDedup = true; }
      else if (lower === "stats") { if (stages.some(candidate => candidate.kind === "sort" || candidate.kind === "limit")) throw new InsightsSyntaxError("sort and limit must appear after the last stats command", command.start, command.end); stage = this.stats(command.start); if (++statsCount > 10) throw new InsightsSyntaxError("A Standard log query can contain no more than 10 stats commands", command.start, stage.end); }
      else throw new InsightsSyntaxError(`Unsupported Logs Insights QL command '${command.text}'`, command.start, command.end);
      if (visibleFields) {
        const validate = (expression: ExpressionNode) => { for (const field of referencedFields(expression)) if (field.name !== "*" && ![...visibleFields!].some(name => name.toLowerCase() === field.name.toLowerCase())) throw new InsightsSyntaxError(`Field '${field.name}' is not available after stats`, field.start, field.end); };
        if (stage.kind === "fields" || stage.kind === "display") for (const selection of stage.selections) { validate(selection.expression); visibleFields.add(selection.alias); }
        else if (stage.kind === "filter") validate(stage.expression);
        else if (stage.kind === "parse") { validate(stage.expression); stage.aliases.forEach(alias => visibleFields!.add(alias)); }
        else if (stage.kind === "sort") stage.fields.forEach(field => validate(field.expression));
        else if (stage.kind === "dedup") stage.fields.forEach(field => validate(field.expression));
        else if (stage.kind === "stats") { stage.selections.forEach(selection => validate(selection.expression)); stage.groups.forEach(group => validate(group.expression)); }
      }
      if (stage.kind === "stats") visibleFields = new Set([...stage.groups.map(group => group.alias), ...stage.selections.map(selection => selection.alias)]);
      stages.push(stage);
      if (this.current().kind === "eof") break;
      if (!this.at("|")) throw new InsightsSyntaxError(`Unexpected token '${this.current().text}'`, this.current().start, this.current().end);
      const pipe = this.consume("|");
      if (this.current().kind === "eof" || this.at("|")) throw new InsightsSyntaxError("Empty query command", pipe.end, Math.max(pipe.end + 1, this.current().end));
    }
    return { language: "CWLI", source: this.source, stages };
  }

  private atBoundary(): boolean { return this.current().kind === "eof" || this.at("|"); }
  private identifier(message = "Expected a field alias"): InsightsToken { const token = this.consume(); if (token.kind !== "identifier") throw new InsightsSyntaxError(message, token.start, token.end); return token; }
  private selection(): Selection {
    const expression = this.parse(); let alias = expressionName(expression);
    if (this.at("as")) { this.consume(); alias = String(this.identifier().value); }
    return { expression, alias, start: expression.start, end: this.tokens[this.index - 1].end };
  }
  private selections(): Selection[] {
    const values: Selection[] = [];
    do { values.push(this.selection()); if (!this.at(",")) break; this.consume(","); if (this.atBoundary()) throw new InsightsSyntaxError("Expected an expression after ','", this.current().start, Math.max(this.current().end, this.current().start + 1)); } while (!this.atBoundary());
    return values;
  }
  private fields(kind: "fields" | "display", start: number): FieldsStage {
    if (this.atBoundary()) throw new InsightsSyntaxError(`${kind} expects one or more expressions`, this.current().start, Math.max(this.current().end, this.current().start + 1));
    const selections = this.selections(); return { kind, selections, start, end: selections.at(-1)!.end };
  }
  private filter(kind: "filter" | "filterIndex", start: number): FilterStage {
    if (this.atBoundary()) throw new InsightsSyntaxError(`${kind} expects an expression`, this.current().start, Math.max(this.current().end, this.current().start + 1));
    const expression = this.parse(); return { kind, expression, start, end: expression.end };
  }
  private parseStage(start: number): ParseStage {
    if (this.atBoundary()) throw new InsightsSyntaxError("parse expects a field and a glob or regular expression", this.current().start, Math.max(this.current().end, this.current().start + 1));
    let expression: ExpressionNode = { kind: "field", name: "@message", start: this.current().start, end: this.current().start };
    let patternToken: InsightsToken;
    if (this.current().kind === "regex" || this.current().kind === "string") patternToken = this.consume();
    else { expression = this.parse(); patternToken = this.consume(); if (patternToken.kind !== "regex" && patternToken.kind !== "string") throw new InsightsSyntaxError("parse expects a glob string or regular expression", patternToken.start, patternToken.end); }
    const glob = patternToken.kind === "string"; let pattern: ExecutableRegex; let named: string[] = [];
    if (glob) {
      const compiled = compileGlob(patternToken); if (!compiled.captures) throw new InsightsSyntaxError("A parse glob must contain at least one '*'", patternToken.start, patternToken.end); pattern = compiled.pattern;
    } else {
      const source = String(patternToken.value); named = [...source.matchAll(/\(\?<([A-Za-z_@][A-Za-z0-9_@$-]*)>/g)].map(match => match[1]); pattern = compileInsightsRegex(source, patternToken.flags, patternToken);
    }
    const aliases: string[] = [];
    if (this.at("as")) {
      this.consume(); do { aliases.push(String(this.identifier("Expected a parse output field").value)); if (!this.at(",")) break; this.consume(","); } while (!this.atBoundary());
    } else aliases.push(...named);
    const captures = countCaptures(pattern.source); if (!aliases.length || aliases.length !== captures) throw new InsightsSyntaxError(`parse requires one output field for each of its ${captures} capture groups`, patternToken.start, patternToken.end);
    if (aliases.length > 200) throw new InsightsSyntaxError("parse can create no more than 200 fields", patternToken.start, patternToken.end);
    return { kind: "parse", expression, pattern, aliases, named, glob, start, end: this.tokens[this.index - 1].end };
  }
  private sort(start: number): SortStage {
    if (this.atBoundary()) throw new InsightsSyntaxError("sort expects one or more fields", this.current().start, Math.max(this.current().end, this.current().start + 1));
    const fields: SortField[] = [];
    do {
      const selection = this.selection(); let direction: "asc" | "desc" = "asc";
      if (this.at("asc") || this.at("desc")) direction = this.consume().text.toLowerCase() as "asc" | "desc";
      fields.push({ ...selection, direction, end: this.tokens[this.index - 1].end });
      if (!this.at(",")) break; this.consume(",");
    } while (!this.atBoundary());
    return { kind: "sort", fields, start, end: fields.at(-1)!.end };
  }
  private limit(start: number): LimitStage {
    const any = this.at("any"); if (any) this.consume(); const token = this.consume(); const limit = token.kind === "number" ? Number(token.value) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new InsightsSyntaxError("limit expects an integer from 1 to 100000", token.start, token.end);
    return { kind: "limit", limit, any, start, end: token.end };
  }
  private dedup(start: number): DedupStage {
    if (this.atBoundary()) throw new InsightsSyntaxError("dedup expects one or more fields", this.current().start, Math.max(this.current().end, this.current().start + 1));
    const fields = this.selections(); return { kind: "dedup", fields, start, end: fields.at(-1)!.end };
  }
  private stats(start: number): StatsStage {
    if (this.atBoundary()) throw new InsightsSyntaxError("stats expects one or more aggregate expressions", this.current().start, Math.max(this.current().end, this.current().start + 1));
    const selections: Selection[] = [];
    do { const selection = this.selection(); if (!containsAggregate(selection.expression)) throw new InsightsSyntaxError("A stats output expression must contain an aggregate function", selection.start, selection.end); selections.push(selection); if (!this.at(",")) break; this.consume(","); } while (!this.at("by") && !this.atBoundary());
    const groups: Selection[] = []; if (this.at("by")) { this.consume(); groups.push(...this.selections()); }
    const topk = selections.filter(selection => selection.expression.kind === "call" && selection.expression.name === "topk"); if (topk.length && (selections.length !== 1 || groups.length)) throw new InsightsSyntaxError("topk cannot be combined with other aggregate expressions or by fields", start, (groups.at(-1) ?? selections.at(-1))!.end);
    if (topk.length) { const count = topk[0].expression.kind === "call" && topk[0].expression.arguments[0].kind === "literal" ? numeric(topk[0].expression.arguments[0].value as InsightsValue) : undefined; if (count === undefined || !Number.isInteger(count) || count < 1 || count > 10_000) throw new InsightsSyntaxError("topk k must be an integer from 1 to 10000", topk[0].start, topk[0].end); }
    let offset: number | undefined; let end = (groups.at(-1) ?? selections.at(-1))!.end;
    if (this.at("offset")) { const keyword = this.consume(); const duration = this.consume(); offset = duration.kind === "duration" ? numeric(String(duration.value)) : undefined; if (offset === undefined || offset <= 0 || !groups.some(group => group.expression.kind === "call" && group.expression.name === "bin")) throw new InsightsSyntaxError("offset requires a positive duration after stats by bin(...) ", keyword.start, duration.end); end = duration.end; }
    return { kind: "stats", selections, groups, ...(offset === undefined ? {} : { offset }), start, end };
  }
}

function referencedFields(node: ExpressionNode): Array<Extract<ExpressionNode, { kind: "field" }>> {
  if (node.kind === "field") return [node];
  if (node.kind === "call") return [...(node.name === "bin" ? [{ kind: "field", name: "@timestamp", start: node.start, end: node.end } as const] : []), ...node.arguments.flatMap(referencedFields)];
  if (node.kind === "binary") return [...referencedFields(node.left), ...referencedFields(node.right)];
  if (node.kind === "unary") return referencedFields(node.operand);
  if (node.kind === "access") return referencedFields(node.target);
  if (node.kind === "list") return node.items.flatMap(referencedFields);
  if (node.kind === "map") return node.entries.flatMap(entry => referencedFields(entry.value));
  return [];
}

function compileGlob(token: InsightsToken): { pattern: RegExp; captures: number } {
  const raw = token.text.slice(1, -1); let source = ""; let captures = 0;
  for (let index = 0; index < raw.length; index++) { let character = raw[index]; if (character === "\\" && index + 1 < raw.length) { character = raw[++index]; const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t" }; character = escaped[character] ?? character; source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); } else if (character === "*") { source += "([\\s\\S]*?)"; captures++; } else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  return { pattern: new RegExp(`^${source}$`), captures };
}

function countCaptures(source: string): number {
  let count = 0; let escaped = false; let inClass = false;
  for (let index = 0; index < source.length; index++) { const character = source[index]; if (escaped) { escaped = false; continue; } if (character === "\\") { escaped = true; continue; } if (character === "[") inClass = true; else if (character === "]") inClass = false; else if (!inClass && character === "(" && source[index + 1] !== "?" || (!inClass && source.startsWith("(?<", index) && !/[=!]/.test(source[index + 3] ?? ""))) count++; }
  return count;
}

function containsAggregate(node: ExpressionNode): boolean {
  if (node.kind === "call") return AGGREGATES.has(node.name) || node.arguments.some(containsAggregate);
  if (node.kind === "binary") return containsAggregate(node.left) || containsAggregate(node.right);
  if (node.kind === "unary") return containsAggregate(node.operand);
  if (node.kind === "access") return containsAggregate(node.target) || containsAggregate(node.key);
  if (node.kind === "list") return node.items.some(containsAggregate);
  if (node.kind === "map") return node.entries.some(entry => containsAggregate(entry.value));
  return false;
}

export function parseInsightsQuery(query: string): InsightsQueryPlan { return new QueryParser(query, lexInsights(query)).query(); }
export function validateInsightsQuery(query: string): void { parseInsightsQuery(query); }

function environment(row: RuntimeRow, context?: QueryRuntimeContext): EvaluationEnvironment { return { fields: row.fields, context }; }
function displayValue(field: string, value: InsightsValue): string {
  if (value === null) return "null";
  if (isStructure(value)) return JSON.stringify(value);
  if (typeof value === "number" && (field === "@timestamp" || /^(?:bin|datefloor|dateceil)\(/i.test(field))) return new Date(value).toISOString();
  return String(value);
}

function naturalChunks(value: string): Array<{ numeric: boolean; text: string }> { return value.match(/\d+|\D+/g)?.map(text => ({ numeric: /^\d+$/.test(text), text })) ?? []; }
export function compareInsightsValues(left: InsightsValue, right: InsightsValue): number {
  if (isMissing(left) || left === null) return isMissing(right) || right === null ? 0 : 1;
  if (isMissing(right) || right === null) return -1;
  if (isStructure(left)) return isStructure(right) ? JSON.stringify(left).localeCompare(JSON.stringify(right)) : 1;
  if (isStructure(right)) return -1;
  const a = String(left), b = String(right); const aNumber = /^\d+$/.test(a), bNumber = /^\d+$/.test(b); if (aNumber !== bNumber) return aNumber ? 1 : -1; if (aNumber && bNumber) { const numericOrder = BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0; return numericOrder || (a < b ? -1 : a > b ? 1 : 0); } const ac = naturalChunks(a), bc = naturalChunks(b);
  for (let index = 0; index < Math.max(ac.length, bc.length); index++) {
    const x = ac[index], y = bc[index]; if (!x) return -1; if (!y) return 1;
    if (x.numeric && y.numeric) { if (x.text.length !== y.text.length) return x.text.length - y.text.length; if (x.text !== y.text) return x.text < y.text ? -1 : 1; }
    else if (x.text !== y.text) return x.text < y.text ? -1 : 1;
  }
  return 0;
}

function cloneWithAggregate(node: ExpressionNode, bucket: RuntimeRow[], context?: QueryRuntimeContext): ExpressionNode {
  if (node.kind === "call" && AGGREGATES.has(node.name)) return { kind: "literal", value: aggregate(node, bucket, context), start: node.start, end: node.end };
  if (node.kind === "binary") return { ...node, left: cloneWithAggregate(node.left, bucket, context), right: cloneWithAggregate(node.right, bucket, context) };
  if (node.kind === "unary") return { ...node, operand: cloneWithAggregate(node.operand, bucket, context) };
  if (node.kind === "call") return { ...node, arguments: node.arguments.map(argument => cloneWithAggregate(argument, bucket, context)) };
  if (node.kind === "list") return { ...node, items: node.items.map(item => cloneWithAggregate(item, bucket, context)) };
  if (node.kind === "map") return { ...node, entries: node.entries.map(entry => ({ ...entry, value: cloneWithAggregate(entry.value, bucket, context) })) };
  if (node.kind === "access") return { ...node, target: cloneWithAggregate(node.target, bucket, context), key: cloneWithAggregate(node.key, bucket, context) };
  return node;
}

function aggregate(node: Extract<ExpressionNode, { kind: "call" }>, bucket: RuntimeRow[], context?: QueryRuntimeContext): InsightsValue {
  const argument = node.name === "topk" ? node.arguments[1] : node.arguments[0];
  const evaluated = argument && !(argument.kind === "field" && argument.name === "*") ? bucket.map(row => evaluateExpression(argument, environment(row, context))) : []; if (evaluated.some(isStructure)) throw new InsightsSyntaxError("stats does not support map or list values", node.start, node.end);
  const values = evaluated.filter(value => !isMissing(value) && value !== null);
  const numbers = values.map(numeric).filter((value): value is number => value !== undefined); const name = node.name;
  if (name === "count") return argument && !(argument.kind === "field" && argument.name === "*") ? values.length : bucket.length;
  if (name === "sum" || name === "sum_over_time") return numbers.reduce((sum, value) => sum + value, 0);
  if (name === "avg") return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
  if (name === "min" || name === "max") { const sorted = [...values].sort(compareInsightsValues); return name === "min" ? sorted[0] ?? null : sorted.at(-1) ?? null; }
  if (name === "count_distinct") return new Set(values.map(value => `${typeof value}:${String(value)}`)).size;
  if (name === "values" || name === "collect_values") return [...new Set(values.map(value => String(value)))].sort();
  if (name === "variance" || name === "stddev") { if (!numbers.length) return null; const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length; const variance = numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numbers.length; return name === "stddev" ? Math.sqrt(variance) : variance; }
  if (name === "pct") { const percentile = numeric(node.arguments[1] ? evaluateExpression(node.arguments[1], environment(bucket[0] ?? { fields: {}, ordinal: 0 }, context)) : INSIGHTS_MISSING); if (percentile === undefined || percentile < 0 || percentile > 100 || !numbers.length) return null; const sorted = [...numbers].sort((a, b) => a - b); const position = (sorted.length - 1) * percentile / 100; const lower = Math.floor(position), upper = Math.ceil(position); return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower); }
  if (name === "earliest" || name === "latest") { const ordered = bucket.map((row, index) => ({ row, index, timestamp: numeric(valueAt(row.fields, "@timestamp")) ?? 0 })).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index); const selected = name === "earliest" ? ordered[0] : ordered.at(-1); return selected && argument ? evaluateExpression(argument, environment(selected.row, context)) : INSIGHTS_MISSING; }
  if (name === "sortsfirst" || name === "sortslast") { const sorted = [...values].sort(compareInsightsValues); return name === "sortsfirst" ? sorted[0] ?? INSIGHTS_MISSING : sorted.at(-1) ?? INSIGHTS_MISSING; }
  if (name === "topk") { const count = numeric(evaluateExpression(node.arguments[0], environment(bucket[0] ?? { fields: {}, ordinal: 0 }, context))) ?? 10; const frequencies = new Map<string, { value: InsightsValue; count: number }>(); for (const value of values) { const key = `${typeof value}:${String(value)}`; const item = frequencies.get(key) ?? { value, count: 0 }; item.count++; frequencies.set(key, item); } return [...frequencies.values()].sort((a, b) => b.count - a.count || compareInsightsValues(a.value, b.value)).slice(0, Math.max(1, Math.min(10_000, Math.trunc(count)))).map(item => item.value); }
  if (name === "rate") { const interval = numeric(evaluateExpression(node.arguments[1], environment(bucket[0] ?? { fields: {}, ordinal: 0 }, context))); return interval && numbers.length > 1 ? (numbers.at(-1)! - numbers[0]) / (interval / 1000) : 0; }
  if (name === "count_over_time") return values.length;
  if (name === "histogram") { const count = Math.trunc(numeric(evaluateExpression(node.arguments[1], environment(bucket[0] ?? { fields: {}, ordinal: 0 }, context))) ?? 0); if (!numbers.length || count < 1 || count > 1000) return {}; const minimum = Math.min(...numbers), maximum = Math.max(...numbers), width = maximum === minimum ? 1 : (maximum - minimum) / count; const output: Record<string, InsightsValue> = {}; for (let index = 0; index < count; index++) output[`${minimum + index * width}-${index === count - 1 ? maximum : minimum + (index + 1) * width}`] = 0; for (const value of numbers) { const index = Math.min(count - 1, Math.floor((value - minimum) / width)); const key = Object.keys(output)[index]; output[key] = Number(output[key]) + 1; } return output; }
  return INSIGHTS_MISSING;
}

function statsRows(rows: RuntimeRow[], stage: StatsStage, context?: QueryRuntimeContext): RuntimeRow[] {
  const buckets = new Map<string, { values: InsightsValue[]; rows: RuntimeRow[] }>();
  for (const row of rows) { const values = stage.groups.map(group => { const value = evaluateExpression(group.expression, environment(row, context)); return stage.offset && group.expression.kind === "call" && group.expression.name === "bin" && typeof value === "number" ? value + stage.offset : value; }); rejectStructure("stats", values, stage); const key = JSON.stringify(values.map(value => isMissing(value) ? { missing: true } : value)); const item = buckets.get(key) ?? { values, rows: [] }; item.rows.push(row); buckets.set(key, item); }
  if (!stage.groups.length && !buckets.size) buckets.set("[]", { values: [], rows: [] });
  let ordinal = 0;
  return [...buckets.values()].map(bucket => {
    const fields: Record<string, InsightsValue> = {}; stage.groups.forEach((group, index) => { fields[group.alias] = bucket.values[index]; });
    for (const selection of stage.selections) fields[selection.alias] = evaluateExpression(cloneWithAggregate(selection.expression, bucket.rows, context), { fields, context });
    return { fields, projection: [...stage.groups.map(group => group.alias), ...stage.selections.map(selection => selection.alias)], aggregate: true, ordinal: ordinal++ };
  });
}

function rejectStructure(command: string, values: InsightsValue[], span: SourceSpan): void { if (values.some(isStructure)) throw new InsightsSyntaxError(`${command} does not support map or list values`, span.start, span.end); }

function formatInsightsRows(rows: RuntimeRow[]): InsightsResult["rows"] {
  return rows.map(row => {
    const names = row.projection ?? Object.keys(row.fields);
    const result = names.flatMap(field => {
      const value = valueAt(row.fields, field);
      return isMissing(value) ? [] : [{ field, value: displayValue(field, value) }];
    });
    if (!row.aggregate && row.pointer) result.push({ field: "@ptr", value: row.pointer });
    return result;
  });
}

export function runInsightsQueryOnRows(stages: InsightsStage[], rows: RuntimeRow[], maximum: number, context: QueryRuntimeContext = {}, recordsMatched = rows.length): InsightsResult {
  let matched = recordsMatched; let explicitlySorted = false;
  for (const stage of stages) {
    if (stage.kind === "fields" || stage.kind === "display") {
      for (const row of rows) { for (const selection of stage.selections) row.fields[selection.alias] = evaluateExpression(selection.expression, environment(row, context)); const selected = stage.selections.map(selection => selection.alias); row.projection = stage.kind === "display" ? selected : [...new Set([...(row.projection ?? []), ...selected])]; }
    } else if (stage.kind === "filter" || stage.kind === "filterIndex") {
      rows = rows.filter(row => insightsTruthy(evaluateExpression(stage.expression, environment(row, context)))); matched = rows.length;
    } else if (stage.kind === "parse") {
      for (const row of rows) { const value = evaluateExpression(stage.expression, environment(row, context)); if (isMissing(value) || value === null || isStructure(value)) continue; stage.pattern.lastIndex = 0; const captures = stage.pattern.exec(String(value)); if (!captures) continue; stage.aliases.forEach((alias, index) => { row.fields[alias] = stage.named.length ? captures.groups?.[alias] ?? INSIGHTS_MISSING : captures[index + 1] ?? INSIGHTS_MISSING; }); }
    } else if (stage.kind === "sort") {
      explicitlySorted = true; for (const row of rows) for (const field of stage.fields) rejectStructure("sort", [evaluateExpression(field.expression, environment(row, context))], field); rows.sort((left, right) => { for (const field of stage.fields) { const a = evaluateExpression(field.expression, environment(left, context)); const b = evaluateExpression(field.expression, environment(right, context)); const compared = compareInsightsValues(a, b); if (compared) return field.direction === "desc" ? -compared : compared; } return left.ordinal - right.ordinal; });
    } else if (stage.kind === "limit") rows = rows.slice(0, Math.min(stage.limit, maximum));
    else if (stage.kind === "dedup") {
      if (!explicitlySorted) rows.sort((left, right) => (numeric(valueAt(right.fields, "@timestamp")) ?? 0) - (numeric(valueAt(left.fields, "@timestamp")) ?? 0) || left.ordinal - right.ordinal);
      const seen = new Set<string>(); rows = rows.filter(row => { const values = stage.fields.map(field => evaluateExpression(field.expression, environment(row, context))); rejectStructure("dedup", values, stage); if (values.some(value => isMissing(value) || value === null)) return true; const key = JSON.stringify(values); if (seen.has(key)) return false; seen.add(key); return true; });
    } else if (stage.kind === "stats") { rows = statsRows(rows, stage, context); }
  }
  rows = rows.slice(0, maximum);
  return { recordsMatched: matched, rows: formatInsightsRows(rows) };
}

export function runtimeRowsToInsightsResult(rows: RuntimeRow[], maximum: number, recordsMatched: number): InsightsResult {
  return { recordsMatched, rows: formatInsightsRows(rows.slice(0, maximum)) };
}

export function runInsightsQuery(query: string | InsightsQueryPlan, records: InsightsRecord[], maximum: number, context: QueryRuntimeContext = {}): InsightsResult {
  const plan = typeof query === "string" ? parseInsightsQuery(query) : query;
  const rows: RuntimeRow[] = records.map((record, ordinal) => ({ fields: { ...record.fields }, pointer: record.pointer, ordinal }));
  return runInsightsQueryOnRows(plan.stages, rows, maximum, context, rows.length);
}
