import { compileQuery, fail, fieldValues, integer, type Candidate, type Json } from "./query.js";

type Scalar = string | number | boolean | null;
type Type = "text" | "keyword" | "boolean" | "byte" | "short" | "integer" | "long" | "float" | "half_float" | "double";
type Token = { kind: "word" | "identifier" | "string" | "number" | "symbol"; text: string };
type Operand = { field: string } | { value: Scalar };
type Expression = { op: string; left?: Operand; right?: Operand; values?: Operand[]; children?: Expression[] };
type Selection = { field: string; name: string; aggregate?: string };
type Order = { field: string; descending: boolean };
type Stage = { kind: "where"; expression: Expression } | { kind: "project"; fields: Selection[] | "*" } | { kind: "stats"; fields: Selection[]; groups: string[] } | { kind: "sort"; order: Order[]; count?: number } | { kind: "head"; size: number; offset: number };
export interface LanguagePlan { source: string; stages: Stage[] }
interface Column { name: string; type: Type; star: boolean }
interface Row { get(field: string): Scalar }
const numeric = (type: string) => ["byte", "short", "integer", "long", "float", "half_float", "double"].includes(type);
function error(message: string): never { return fail(message, "query_language_exception"); }
function limit(message: string): never { return fail(message, "limit_exceeded_exception", 429); }

// Tokens and an explicit AST are interpreted below. Query text never reaches
// SQLite, eval, a shell, or a caller-supplied function.
function tokenize(input: unknown, language: "sql" | "ppl"): Token[] {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 32768) error("Query must contain 1–32768 bytes");
  const tokens: Token[] = []; let at = 0;
  while (at < input.length) {
    if (/\s/u.test(input[at])) { at++; continue; }
    const quote = input[at];
    if (["'", '"', "`"].includes(quote)) {
      at++; let text = "", closed = false;
      while (at < input.length) { const ch = input[at++]; if (ch === quote) { if (input[at] === quote) { text += quote; at++; } else { closed = true; break; } } else { if (ch === "\\") error("Backslash escapes are unsupported; double the quote character"); text += ch; } }
      if (!closed) error("Unterminated quoted value");
      tokens.push({ kind: quote === "`" || quote === '"' && language === "sql" ? "identifier" : "string", text });
    } else {
      const tail = input.slice(at), number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(tail), word = /^[A-Za-z_@][A-Za-z0-9_@.$*-]*/.exec(tail), symbol = /^(?:<=|>=|!=|<>|[=<>(),|*;+\-])/.exec(tail);
      const match = number ?? word ?? symbol; if (!match) error(`Unexpected character at position ${at}`);
      tokens.push({ kind: number ? "number" : word ? "word" : "symbol", text: match[0] }); at += match[0].length;
    }
    if (tokens.length > 2048) limit("Query exceeds 2048 tokens");
  }
  return tokens;
}

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[], private readonly sourceKind: "index" | "log-group" = "index") {}
  peek(value: string): boolean { const token = this.tokens[this.at]; return !!token && (token.kind === "word" || token.kind === "symbol") && token.text.toUpperCase() === value.toUpperCase(); }
  take(value: string): boolean { if (!this.peek(value)) return false; this.at++; return true; }
  require(value: string): void { if (!this.take(value)) error(`Expected ${value} near token ${this.at + 1}`); }
  identifier(maximum = 255): string { const token = this.tokens[this.at++]; if (!token || !["word", "identifier"].includes(token.kind) || !token.text || token.text.length > maximum) error(`Expected an identifier near token ${this.at}`); return token.text; }
  source(): string {
    if (this.sourceKind === "log-group") { const name = this.identifier(512); if (!/^[.\-_/#A-Za-z0-9]{1,512}$/.test(name)) error("Source must name one log group; quote names containing punctuation"); return name; }
    const name = this.take("*") ? "*" : this.identifier(); if (!/^[a-z0-9][a-z0-9_.*?\-]*$|^\*$/.test(name)) error("Source must be a local index, alias or pattern; quote names containing punctuation"); return name;
  }
  count(): number { const token = this.tokens[this.at++]; if (token?.kind !== "number") error("Expected a row count"); return integer(token.text, 0, 0, 10000); }
  list<T>(read: () => T): T[] { const values = [read()]; while (this.take(",")) { if (values.length >= 128) limit("A query list may contain at most 128 entries"); values.push(read()); } return values; }
  operand(): Operand {
    const token = this.tokens[this.at];
    if (this.take("NULL")) return { value: null };
    if (this.take("TRUE")) return { value: true };
    if (this.take("FALSE")) return { value: false };
    if (token?.kind === "string") { this.at++; return { value: token.text }; }
    if (token?.kind === "number" || this.peek("-") || this.peek("+")) { const negative = this.take("-"); if (!negative) this.take("+"); const number = this.tokens[this.at++]; if (number?.kind !== "number" || !Number.isFinite(Number(number.text))) error("Expected a finite number"); return { value: Number(number.text) * (negative ? -1 : 1) }; }
    return { field: this.identifier() };
  }
  expression(depth = 0, precedence = 0): Expression {
    if (depth > 32) limit("Expression exceeds 32 nested levels");
    let result: Expression;
    if (this.take("NOT")) result = { op: "not", children: [this.expression(depth + 1, 3)] };
    else if (this.take("(")) { result = this.expression(depth + 1); this.require(")"); }
    else {
      const left = this.operand();
      if (this.take("IS")) { const not = this.take("NOT"); this.require("NULL"); result = { op: not ? "notnull" : "null", left }; }
      else {
        const not = this.take("NOT");
        if (this.take("IN")) { this.require("("); const values = this.list(() => this.operand()); this.require(")"); result = { op: "in", left, values }; }
        else if (this.take("BETWEEN")) { const lower = this.operand(); this.require("AND"); const upper = this.operand(); result = { op: "and", children: [{ op: ">=", left, right: lower }, { op: "<=", left, right: upper }] }; }
        else if (this.take("LIKE")) result = { op: "like", left, right: this.operand() };
        else { if (not) error("NOT requires IN, LIKE or BETWEEN"); const op = this.tokens[this.at++]?.text; if (!["=", "!=", "<>", "<", ">", "<=", ">="].includes(op)) error("Expected a comparison operator"); result = { op, left, right: this.operand() }; }
        if (not) result = { op: "not", children: [result] };
      }
    }
    while ((this.peek("AND") ? 2 : this.peek("OR") ? 1 : 0) > precedence) {
      const op = this.take("AND") ? "and" : (this.require("OR"), "or"); result = { op, children: [result, this.expression(depth + 1, op === "and" ? 2 : 1)] };
    }
    return result;
  }
  selection(aggregates: boolean): Selection {
    let field = this.identifier(), aggregate: string | undefined;
    if (this.take("(")) { if (!aggregates || !["count", "sum", "avg", "min", "max"].includes(field.toLowerCase())) error(`Function [${field}] is unsupported`); aggregate = field.toLowerCase(); field = this.take("*") ? "*" : this.peek(")") ? "*" : this.identifier(); if (field === "*" && aggregate !== "count") error("Only COUNT accepts * or no field"); this.require(")"); }
    const name = aggregate ? `${aggregate}(${field === "*" ? "*" : field})` : field;
    return { field, name: this.take("AS") ? this.identifier() : name, ...(aggregate ? { aggregate } : {}) };
  }
  orders(ppl: boolean): Order[] { return this.list(() => { const descending = ppl && this.take("-"); if (ppl && !descending) this.take("+"); const field = this.identifier(); return { field, descending: ppl ? descending : this.take("DESC") ? true : (this.take("ASC"), false) }; }); }
  sql(): LanguagePlan {
    this.require("SELECT"); const fields = this.take("*") ? "*" : this.list(() => this.selection(true)); this.require("FROM"); const source = this.source(), stages: Stage[] = [];
    if (this.take("WHERE")) stages.push({ kind: "where", expression: this.expression() });
    let groups: string[] = []; if (this.take("GROUP")) { this.require("BY"); groups = this.list(() => this.identifier()); }
    const aggregate = fields !== "*" && fields.some(field => field.aggregate);
    if (aggregate || groups.length) {
      if (fields === "*" || fields.some(field => !field.aggregate && !groups.includes(field.field))) error("Every selected field must be aggregated or present in GROUP BY");
      stages.push({ kind: "stats", groups, fields: fields.filter(field => field.aggregate) });
    }
    if (this.take("ORDER")) { this.require("BY"); const order = this.orders(false); if (fields !== "*") for (const item of order) item.field = fields.find(field => !field.aggregate && field.name === item.field)?.field ?? item.field; stages.push({ kind: "sort", order }); }
    stages.push({ kind: "project", fields: fields === "*" ? "*" : fields.map(field => ({ field: field.aggregate ? field.name : field.field, name: field.name })) });
    if (this.take("LIMIT")) { let size = this.count(), offset = 0; if (this.take(",")) { offset = size; size = this.count(); } else if (this.take("OFFSET")) offset = this.count(); if (size + offset > 10000) limit("LIMIT plus OFFSET exceeds 10000"); stages.push({ kind: "head", size, offset }); }
    this.take(";"); this.end(); return { source, stages };
  }
  ppl(): LanguagePlan {
    this.take("SEARCH"); this.require("SOURCE"); this.require("="); const source = this.source(), stages: Stage[] = [];
    while (this.take("|")) {
      if (stages.length >= 32) limit("PPL supports at most 32 commands");
      if (this.take("WHERE")) stages.push({ kind: "where", expression: this.expression() });
      else if (this.take("FIELDS")) { this.take("+"); stages.push({ kind: "project", fields: this.list(() => this.selection(false)) }); }
      else if (this.take("STATS")) { const fields = this.list(() => this.selection(true)); if (fields.some(field => !field.aggregate)) error("STATS requires aggregate functions"); stages.push({ kind: "stats", fields, groups: this.take("BY") ? this.list(() => this.identifier()) : [] }); }
      else if (this.take("SORT")) { const count = this.tokens[this.at]?.kind === "number" ? this.count() : 1000; stages.push({ kind: "sort", order: this.orders(true), count }); }
      else if (this.take("HEAD")) stages.push({ kind: "head", size: this.tokens[this.at]?.kind === "number" ? this.count() : 10, offset: 0 });
      else error(`Unsupported PPL command near token ${this.at + 1}`);
    }
    this.end(); return { source, stages };
  }
  end(): void { if (this.at !== this.tokens.length) error(`Unsupported syntax near token ${this.at + 1}`); }
}

export function parseLanguage(language: "sql" | "ppl", query: unknown, sourceKind: "index" | "log-group" = "index"): LanguagePlan { const parser = new Parser(tokenize(query, language), sourceKind); return language === "sql" ? parser.sql() : parser.ppl(); }

function like(pattern: string, value: string): boolean {
  if (pattern.length > 1024 || value.length > 32768) limit("LIKE exceeds its 1024-character pattern or 32768-character value bound");
  // SQL wildcards are % and _. Match using bounded dynamic programming.
  const points = [...value]; let previous = new Uint8Array(points.length + 1); previous[0] = 1;
  for (const char of pattern) { const next = new Uint8Array(points.length + 1); if (char === "%") next[0] = previous[0]; for (let i = 1; i <= points.length; i++) next[i] = char === "%" ? previous[i] || next[i - 1] : (char === "_" || char === points[i - 1]) ? previous[i - 1] : 0; previous = next; }
  return !!previous[points.length];
}

export function executeLanguage(plan: LanguagePlan, mappings: Json[], documents: () => Candidate[], filter?: Json, deadline = performance.now() + 30000, fieldAccess: "mapped" | "flat" = "mapped"): Json {
  const check = () => { if (performance.now() > deadline) fail("Query exceeded its local deadline", "timeout_exception", 408); };
  let likeWork = 0;
  let columns = new Map<string, Column>(); const types = new Map<string, Set<string>>();
  const walk = (properties: Json, prefix = "", star = true): void => {
    for (const [name, mapping] of Object.entries<any>(properties)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (mapping.properties) walk(mapping.properties, path, star); else { const set = types.get(path) ?? new Set<string>(); set.add(mapping.type); types.set(path, set); columns.set(path, { name: path, type: mapping.type, star }); }
      if (mapping.fields) walk(mapping.fields, path, false);
    }
  };
  mappings.forEach(mapping => walk(mapping.properties ?? {}));
  if (columns.size > 4096) limit("SQL/PPL supports at most 4096 mapped fields across the selected indexes");
  if (fieldAccess === "mapped") { columns.set("_id", { name: "_id", type: "keyword", star: false }); columns.set("_index", { name: "_index", type: "keyword", star: false }); }
  for (const [name, set] of types) if (set.size > 1) { if ([...set].every(numeric)) columns.get(name)!.type = "double"; else if ([...set].every(type => type === "text" || type === "keyword")) columns.get(name)!.type = "text"; else columns.get(name)!.type = "incompatible" as Type; }
  const column = (name: string): Column => { const found = columns.get(name); if (!found) error(`Unknown or inaccessible field [${name}]`); if (!numeric(found.type) && !["text", "keyword", "boolean"].includes(found.type)) error(`SQL/PPL scalar queries do not support field [${name}] of type [${found.type}]`); return found; };
  const selected = (fields: Selection[] | "*"): Selection[] => { const result = fields === "*" ? [...columns.values()].filter(item => item.star).map(item => ({ field: item.name, name: item.name })) : fields; if (result.length > 128) limit("Results support at most 128 columns"); if (new Set(result.map(item => item.name)).size !== result.length) error("Result column names must be unique; use AS aliases"); return result; };
  const resolveOperand = (operand: Operand): { type?: string; get(row: Row): Scalar } => "field" in operand ? { type: column(operand.field).type, get: row => row.get(operand.field) } : { type: operand.value === null ? undefined : typeof operand.value === "number" ? "double" : typeof operand.value === "string" ? "text" : "boolean", get: () => operand.value };
  const category = (type: string) => numeric(type) ? "number" : ["text", "keyword"].includes(type) ? "string" : type;
  const predicate = (expression: Expression, depth = 0): ((row: Row) => boolean | null) => {
    if (depth > 64) limit("Expression exceeds 64 operations of nesting");
    if (expression.children) { const children = expression.children.map(child => predicate(child, depth + 1)); return row => { const a = children[0](row); if (expression.op === "not") return a === null ? null : !a; if (expression.op === "and" && a === false || expression.op === "or" && a === true) return a; const b = children[1](row); return expression.op === "and" ? a === false || b === false ? false : a === null || b === null ? null : true : a === true || b === true ? true : a === null || b === null ? null : false; }; }
    const left = resolveOperand(expression.left!), right = expression.right && resolveOperand(expression.right), values = expression.values?.map(resolveOperand);
    for (const other of [...(right ? [right] : []), ...(values ?? [])]) if (left.type && other.type && category(left.type) !== category(other.type)) error("Comparison operands have incompatible types; implicit casts are unsupported");
    if (expression.op === "like" && [left, right!].some(value => value.type && category(value.type) !== "string")) error("LIKE requires string operands");
    return row => {
      check(); const a = left.get(row);
      if (expression.op === "null" || expression.op === "notnull") return expression.op === "null" ? a === null : a !== null;
      if (a === null) return null;
      if (values) { const options = values.map(value => value.get(row)); return options.includes(a) ? true : options.includes(null) ? null : false; }
      const b = right!.get(row); if (b === null) return null;
      switch (expression.op) { case "=": return a === b; case "!=": case "<>": return a !== b; case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b; case "like": { likeWork += String(a).length * String(b).length; if (likeWork > 10000000) limit("LIKE exceeds the local comparison budget"); return like(String(b), String(a)); } default: return error("Unsupported comparison"); }
    };
  };
  // A relational filter is not a top-level k-NN result set (with its own k).
  const filterQuery = filter === undefined ? undefined : compileQuery(filter, 1);
  let rows: Row[] = documents().filter(doc => { check(); return !filterQuery || filterQuery(doc) !== null; }).map(doc => ({ get(field: string): Scalar { check(); if (fieldAccess === "flat") return Object.hasOwn(doc._source, field) ? doc._source[field] : null; if (field === "_id" || field === "_index") return doc[field]; const values = fieldValues(doc._source, field, doc.mappings); if (values.length > 1 || values.some(value => value !== null && typeof value === "object")) error(`Multivalued/object field [${field}] requires an unsupported flattening operation`); return values[0] ?? null; } }));
  let total = rows.length, recordsMatched = rows.length, aggregated = false;
  for (const stage of plan.stages) {
    check();
    if (stage.kind === "where") { const test = predicate(stage.expression); rows = rows.filter(row => test(row) === true); total = rows.length; if (!aggregated) recordsMatched = rows.length; }
    else if (stage.kind === "project") { const fields = selected(stage.fields), next = new Map(fields.map(item => [item.name, { ...column(item.field), name: item.name, star: true }])); let bytes = 0; rows = rows.map(row => { const values = new Map(fields.map(item => [item.name, row.get(item.field)])); bytes += Buffer.byteLength(JSON.stringify([...values.values()])); if (bytes > 64 * 1024 * 1024) limit("Projected rows exceed the 64 MiB intermediate budget"); return { get: (field: string) => values.get(field) ?? null }; }); columns = next; }
    else if (stage.kind === "head") { rows = rows.slice(stage.offset, stage.offset + stage.size); }
    else if (stage.kind === "sort") {
      stage.order.forEach(item => column(item.field));
      const ordered = rows.map(row => ({ row, values: stage.order.map(item => row.get(item.field)) }));
      ordered.sort((a, b) => { check(); for (let i = 0; i < stage.order.length; i++) { const av = a.values[i], bv = b.values[i]; const comparison = av === bv ? 0 : av === null ? 1 : bv === null ? -1 : (av < bv ? -1 : 1) * (stage.order[i].descending ? -1 : 1); if (comparison) return comparison; } return 0; });
      rows = (stage.count ? ordered.slice(0, stage.count) : ordered).map(value => value.row);
    } else {
      aggregated = true; const groups = stage.groups.map(name => column(name)), fields = selected(stage.fields);
      if (new Set([...groups.map(item => item.name), ...fields.map(item => item.name)]).size !== groups.length + fields.length || groups.length + fields.length > 128) error("Grouping requires at most 128 unique output columns");
      const aggregateColumns = fields.map(item => { const field = item.field === "*" ? undefined : column(item.field); if (item.aggregate !== "count" && (!field || !numeric(field.type))) error(`${item.aggregate} requires a numeric field`); return { name: item.name, type: item.aggregate === "count" ? "long" as Type : "double" as Type, star: true }; });
      type Group = { keys: Scalar[]; count: number[]; value: Array<number | null> };
      const buckets = new Map<string, Group>(); let bucketBytes = 0;
      if (!groups.length) buckets.set("[]", { keys: [], count: fields.map(() => 0), value: fields.map(() => null) });
      for (const row of rows) {
        check(); const values = groups.map(item => row.get(item.name)), key = JSON.stringify(values); let bucket = buckets.get(key);
        if (!bucket) { if (buckets.size >= 10000) limit("Aggregation exceeds 10000 groups"); bucketBytes += Buffer.byteLength(key) + fields.length * 16; if (bucketBytes > 64 * 1024 * 1024) limit("Aggregate state exceeds 64 MiB"); bucket = { keys: values, count: fields.map(() => 0), value: fields.map(() => null) }; buckets.set(key, bucket); }
        fields.forEach((field, i) => { const value = field.field === "*" ? 1 : row.get(field.field); if (value === null) return; bucket!.count[i]++; if (field.aggregate === "count") return; const number = Number(value), previous = bucket!.value[i]; bucket!.value[i] = previous === null ? number : field.aggregate === "min" ? Math.min(previous, number) : field.aggregate === "max" ? Math.max(previous, number) : previous + number; if (!Number.isFinite(bucket!.value[i])) error("Numeric aggregate overflow"); });
      }
      rows = [...buckets.values()].map(bucket => { const values = new Map<string, Scalar>(groups.map((item, i) => [item.name, bucket.keys[i]])); fields.forEach((field, i) => values.set(field.name, field.aggregate === "count" ? bucket.count[i] : field.aggregate === "avg" && bucket.count[i] ? bucket.value[i]! / bucket.count[i] : bucket.value[i])); return { get: (field: string) => values.get(field) ?? null }; });
      columns = new Map([...groups, ...aggregateColumns].map(item => [item.name, { ...item, star: true }])); total = rows.length;
    }
  }
  const resultColumns = selected("*").map(item => column(item.field)), schema = resultColumns.map(({ name, type }) => ({ name, type }));
  let bytes = Buffer.byteLength(JSON.stringify(schema));
  const datarows = rows.slice(0, 10000).map(row => { check(); const values = resultColumns.map(item => row.get(item.name)); bytes += Buffer.byteLength(JSON.stringify(values)) + 1; if (bytes > 32 * 1024 * 1024 - 1024) limit("SQL/PPL response exceeds 32 MiB"); return values; });
  return { schema, datarows, total, size: datarows.length, status: 200, ...(fieldAccess === "flat" ? { recordsMatched } : {}) };
}
