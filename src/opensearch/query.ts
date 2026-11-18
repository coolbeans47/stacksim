export type Json = Record<string, any>;
export class SearchError extends Error {
  constructor(readonly type: string, message: string, readonly status = 400) { super(message); }
}
export function fail(message: string, type = "illegal_argument_exception", status = 400): never { throw new SearchError(type, message, status); }
export function record(value: any, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, "parsing_exception");
  return value;
}
export function keys(value: Json, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} [${key}] is not supported by the embedded search engine`);
}
export function integer(value: any, fallback: number, min = 0, max = 10_000): number {
  if (value === undefined) return fallback;
  if ((typeof value !== "number" && typeof value !== "string") || typeof value === "string" && !/^-?\d+$/.test(value)) fail("Expected an integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`Expected an integer in [${min}, ${max}]`);
  return number;
}
export function wildcard(pattern: string, value: string): boolean {
  if (pattern.length > 1024) fail("Pattern exceeds the local limit");
  // A bounded glob matcher avoids exponential regular-expression backtracking.
  let p = 0, v = 0, star = -1, resume = 0;
  while (v < value.length) {
    if (pattern[p] === "?" || pattern[p] === value[v]) { p++; v++; }
    else if (pattern[p] === "*") { star = p++; resume = v; }
    else if (star >= 0) { p = star + 1; v = ++resume; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
export function values(source: any, field: string, includeNull = false): any[] {
  const parts = field.split(".");
  const walk = (value: any, at: number): any[] => {
    if (Array.isArray(value)) return value.flatMap(item => walk(item, at));
    if (value === undefined || value === null && !includeNull) return [];
    if (at === parts.length) return [value];
    return walk(value && typeof value === "object" && Object.hasOwn(value, parts[at]) ? value[parts[at]] : undefined, at + 1);
  };
  return walk(source, 0);
}
export function fieldMapping(mappings: Json, field: string): Json {
  let current = mappings;
  for (const part of field.split(".")) current = current?.properties && Object.hasOwn(current.properties, part) ? current.properties[part] : current?.fields && Object.hasOwn(current.fields, part) ? current.fields[part] : undefined;
  return current ?? {};
}
export function fieldValues(source: Json, field: string, mappings: Json): any[] {
  const mapping = fieldMapping(mappings, field);
  if (!Object.keys(mapping).length) return [];
  let direct = values(source, field, mapping.null_value !== undefined).map(value => value === null ? mapping.null_value : value);
  const at = field.lastIndexOf(".");
  if (!direct.length && at >= 0 && fieldMapping(mappings, field.slice(0, at)).fields?.[field.slice(at + 1)]) direct = values(source, field.slice(0, at), mapping.null_value !== undefined).map(value => value === null ? mapping.null_value : value);
  if (["byte", "short", "integer", "long", "float", "half_float", "double"].includes(mapping.type)) direct = direct.map(Number);
  if (mapping.type === "keyword") direct = direct.map(String);
  if (mapping.type === "keyword" && mapping.ignore_above !== undefined) direct = direct.filter(value => String(value).length <= mapping.ignore_above);
  return direct;
}
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with"]);
export function analyzeTokens(text: string, analyzer = "standard", analysis?: CompiledAnalysis): Array<{ token: string; start_offset: number; end_offset: number; type: string; position: number }> {
  if (analysis && Object.hasOwn(analysis, analyzer)) return customTokens(text, analysis[analyzer]);
  if (!["keyword", "whitespace", "standard", "simple", "stop"].includes(analyzer)) fail(`Analyzer [${analyzer}] is not implemented`);
  if (Buffer.byteLength(text) > 1024 * 1024) fail("Analysis input exceeds 1 MiB", "limit_exceeded_exception", 413);
  if (analyzer === "keyword") return [{ token: text, start_offset: 0, end_offset: text.length, type: "word", position: 0 }];
  const pattern = analyzer === "whitespace" ? /\S+/gu : analyzer === "simple" || analyzer === "stop" ? /\p{L}+/gu : /[\p{L}\p{N}]+/gu;
  const result: Array<{ token: string; start_offset: number; end_offset: number; type: string; position: number }> = []; let position = 0;
  for (const match of text.matchAll(pattern)) {
    if (position >= 65536) fail("Analysis exceeds 65536 tokens", "limit_exceeded_exception", 413);
    const token = analyzer === "whitespace" ? match[0] : match[0].toLowerCase();
    if (analyzer !== "stop" || !STOP_WORDS.has(token)) result.push({ token, start_offset: match.index, end_offset: match.index + match[0].length, type: analyzer === "standard" ? "<ALPHANUM>" : "word", position }); position++;
  }
  return result;
}
export function analyze(text: any, analyzer = "standard", analysis?: CompiledAnalysis): string[] { return analyzeTokens(String(text), analyzer, analysis).map(token => token.token); }
export function indexAnalyzer(mapping: Json, analysis?: CompiledAnalysis): string { return mapping.analyzer ?? (mapping.type === "keyword" ? "keyword" : analysis && Object.hasOwn(analysis, "default") ? "default" : "standard"); }
export interface Candidate { _id: string; _index: string; _source: Json; _score: number; _seq_no: number; _primary_term: number; _version: number; mappings: Json; analysis?: CompiledAnalysis }
type Predicate = (doc: Candidate) => number | null;
const list = (value: any) => value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Deliberately bounded DSL interpreter. Scores are local term counts, not Lucene BM25. */
export function compileQuery(query: any = { match_all: {} }, depth = 0, budget: { clauses: number; analyzerNames?: Set<string>; phraseWork?: number } = { clauses: 0 }): Predicate {
  if (++budget.clauses > 1024) fail("Query exceeds the local 1024 clause limit");
  if (depth > 32) fail("Query is too deeply nested");
  record(query, "query");
  if (Object.keys(query).length !== 1) fail("A query must have exactly one clause", "parsing_exception");
  const [kind, raw] = Object.entries<any>(query)[0];
  const clause = record(raw, kind);
  if (kind === "knn") {
    if (depth) fail("Only top-level knn queries are implemented");
    if (Object.keys(clause).length !== 1) fail("knn requires exactly one vector field");
    const [field, options] = Object.entries<any>(clause)[0];
    keys(record(options, "knn"), ["vector", "k", "filter", "boost"], "knn");
    if (options.k === undefined) fail("knn.k is required");
    integer(options.k, 0, 1, 10000);
    if (!Array.isArray(options.vector) || !options.vector.length || options.vector.length > 4096 || options.vector.some((value: any) => typeof value !== "number" || !Number.isFinite(Math.fround(value)))) fail("knn.vector must contain 1–4096 finite float components");
    if (options.boost !== undefined && (typeof options.boost !== "number" || !Number.isFinite(options.boost) || options.boost < 0)) fail("knn.boost must be finite and nonnegative");
    const vector: number[] = options.vector.map(Math.fround);
    const filter = options.filter ? compileQuery(options.filter, depth + 1, budget) : undefined;
    return doc => {
      const mapping = fieldMapping(doc.mappings, field);
      if (mapping.type !== "knn_vector") fail(`Field [${field}] is not a knn_vector`, "query_shard_exception");
      if (vector.length !== Number(mapping.dimension)) fail(`Query vector dimension must be ${mapping.dimension}`, "query_shard_exception");
      const space = mapping.space_type ?? "l2";
      if (space === "cosinesimil" && vector.every(value => value === 0)) fail("Cosine query vectors cannot have zero magnitude");
      if (filter && filter(doc) === null) return null;
      const stored = fieldValues(doc._source, field, doc.mappings).map(Math.fround);
      if (!stored.length) return null;
      let distance = 0, dot = 0, a = 0, b = 0;
      for (let i = 0; i < vector.length; i++) { const delta = Math.abs(stored[i] - vector[i]); distance = space === "linf" ? Math.max(distance, delta) : distance + (space === "l1" ? delta : delta * delta); dot += stored[i] * vector[i]; a += stored[i] * stored[i]; b += vector[i] * vector[i]; }
      const score = space === "cosinesimil" ? (1 + Math.max(-1, Math.min(1, dot / Math.sqrt(a * b)))) / 2 : space === "innerproduct" ? dot > 0 ? dot + 1 : 1 / (1 - dot) : 1 / (1 + distance);
      return score * (options.boost ?? 1);
    };
  }
  if (clause.boost !== undefined && (typeof clause.boost !== "number" || !Number.isFinite(clause.boost) || clause.boost < 0)) fail("boost must be a finite nonnegative number");
  if (kind === "match_all" || kind === "match_none") { keys(clause, ["boost"], kind); return () => kind === "match_all" ? Number(clause.boost ?? 1) : null; }
  if (kind === "bool") {
    keys(clause, ["must", "filter", "should", "must_not", "minimum_should_match", "boost"], kind);
    const must = list(clause.must).map(q => compileQuery(q, depth + 1, budget));
    const filter = list(clause.filter).map(q => compileQuery(q, depth + 1, budget));
    const should = list(clause.should).map(q => compileQuery(q, depth + 1, budget));
    const not = list(clause.must_not).map(q => compileQuery(q, depth + 1, budget));
    let minimum = clause.minimum_should_match ?? (should.length && !must.length && !filter.length ? 1 : 0);
    if (typeof minimum === "string" && /^\d+%$/.test(minimum)) minimum = Math.floor(should.length * parseInt(minimum) / 100);
    minimum = integer(minimum, 0, 0, should.length);
    return doc => {
      if (not.some(q => q(doc) !== null) || filter.some(q => q(doc) === null)) return null;
      const scores = must.map(q => q(doc)); if (scores.includes(null)) return null;
      const optional = should.map(q => q(doc)).filter((score): score is number => score !== null);
      return optional.length < minimum ? null : ([...scores, ...optional].reduce<number>((sum, score) => sum + (score ?? 0), 0)) * (clause.boost ?? 1);
    };
  }
  if (kind === "constant_score") {
    keys(clause, ["filter", "boost"], kind); if (clause.filter === undefined) fail("constant_score.filter is required"); const inner = compileQuery(clause.filter, depth + 1, budget);
    return doc => inner(doc) === null ? null : Number(clause.boost ?? 1);
  }
  if (kind === "ids") { keys(clause, ["values", "boost"], kind); if (!Array.isArray(clause.values) || clause.values.some((value: any) => typeof value !== "string" && typeof value !== "number")) fail("ids.values must be an array of IDs"); const ids = new Set(clause.values.map(String)); return doc => ids.has(doc._id) ? Number(clause.boost ?? 1) : null; }
  if (kind === "exists") { keys(clause, ["field", "boost"], kind); if (typeof clause.field !== "string") fail("exists.field is required"); return doc => fieldValues(doc._source, clause.field, doc.mappings).length ? 1 : null; }
  if (kind === "nested") {
    keys(clause, ["path", "query", "score_mode", "ignore_unmapped", "boost"], kind);
    if (typeof clause.path !== "string" || !clause.path) fail("nested.path is required");
    if (clause.query === undefined) fail("nested.query is required");
    if (clause.ignore_unmapped !== undefined && typeof clause.ignore_unmapped !== "boolean") fail("ignore_unmapped must be boolean");
    if (clause.score_mode && !["avg", "max", "min", "sum", "none"].includes(clause.score_mode)) fail("Invalid nested score_mode");
    const inner = compileQuery(clause.query, depth + 1, budget);
    return doc => {
      if (fieldMapping(doc.mappings, clause.path).type !== "nested") { if (clause.ignore_unmapped) return null; return fail(`Path [${clause.path}] is not mapped as nested`, "query_shard_exception"); }
      const scores = values(doc._source, clause.path).map(value => {
        let source: any = value; for (const part of clause.path.split(".").reverse()) source = { [part]: source };
        return inner({ ...doc, _source: source });
      }).filter((score): score is number => score !== null);
      if (!scores.length) return null;
      return (clause.score_mode === "none" ? 0 : clause.score_mode === "max" ? Math.max(...scores) : clause.score_mode === "min" ? Math.min(...scores) : scores.reduce((a, b) => a + b, 0) / (clause.score_mode === "sum" ? 1 : scores.length)) * (clause.boost ?? 1);
    };
  }
  if (kind === "multi_match") {
    keys(clause, ["query", "fields", "type", "operator", "minimum_should_match", "boost"], kind);
    if (!Array.isArray(clause.fields) || !clause.fields.length) fail("multi_match.fields is required");
    if (clause.type && !["best_fields", "most_fields", "phrase"].includes(clause.type)) fail("This multi_match type is not implemented");
    const queries = clause.fields.map((field: string) => {
      if (typeof field !== "string") fail("multi_match.fields must contain strings");
      const [name, boost = "1"] = field.split("^"); return compileQuery({ [clause.type === "phrase" ? "match_phrase" : "match"]: { [name]: { query: clause.query, operator: clause.operator ?? "or", boost: Number(boost), ...(clause.minimum_should_match === undefined ? {} : { minimum_should_match: clause.minimum_should_match }) } } }, depth + 1, budget);
    });
    return doc => { const scores = queries.map((q: Predicate) => q(doc)).filter((s: number | null): s is number => s !== null); return scores.length ? (clause.type === "most_fields" ? scores.reduce((a: number, b: number) => a + b, 0) : Math.max(...scores)) * (clause.boost ?? 1) : null; };
  }
  if (!["term", "terms", "range", "match", "match_phrase", "prefix", "wildcard"].includes(kind)) fail(`Query [${kind}] is not implemented`, "query_shard_exception");
  const entries = Object.entries(clause).filter(([key]) => key !== "boost");
  if (entries.length !== 1) fail(`${kind} requires exactly one field`);
  const [field, supplied] = entries[0];
  const options = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied : { [kind === "match" || kind === "match_phrase" ? "query" : "value"]: supplied };
  const allowed = kind === "range" ? ["gt", "gte", "lt", "lte", "boost", "format"] : kind === "match" || kind === "match_phrase" ? ["query", "operator", "minimum_should_match", "analyzer", "boost", "zero_terms_query"] : ["value", "boost", "case_insensitive"];
  if (kind !== "terms") keys(options, allowed, kind);
  if (kind === "terms" && !Array.isArray(supplied)) fail("Terms lookup is not implemented; supply a terms array");
  if (kind === "terms" && supplied.some((value: any) => !["string", "number", "boolean"].includes(typeof value))) fail("terms must contain scalar values");
  if (options.boost !== undefined && (typeof options.boost !== "number" || !Number.isFinite(options.boost) || options.boost < 0)) fail("boost must be a finite nonnegative number");
  if (options.minimum_should_match !== undefined && !/^\d+%?$/.test(String(options.minimum_should_match))) fail("Only integer and percentage minimum_should_match values are implemented");
  if (kind === "range" && options.format) fail("Custom date formats in range queries are not implemented");
  if (kind === "range" && !["gt", "gte", "lt", "lte"].some(key => options[key] !== undefined)) fail("range requires at least one bound");
  if (["term", "prefix", "wildcard"].includes(kind) && options.value === undefined) fail(`${kind}.value is required`);
  if (options.case_insensitive !== undefined && typeof options.case_insensitive !== "boolean") fail("case_insensitive must be boolean");
  if (options.zero_terms_query !== undefined && !["none", "all"].includes(options.zero_terms_query)) fail("zero_terms_query must be none or all");
  if (["term", "prefix", "wildcard"].includes(kind) && !["string", "number", "boolean"].includes(typeof options.value)) fail(`${kind}.value must be a scalar`);
  if (["match", "match_phrase"].includes(kind) && !["string", "number", "boolean"].includes(typeof options.query)) fail(`${kind}.query must be a scalar`);
  if (kind === "range" && ["gt", "gte", "lt", "lte"].some(key => options[key] !== undefined && !["string", "number"].includes(typeof options[key]))) fail("Range bounds must be numbers or strings");
  if (options.operator && !["and", "or"].includes(options.operator)) fail("match.operator must be and or or");
  if (["match", "match_phrase"].includes(kind) && options.query === undefined) fail(`${kind}.query is required`);
  if (options.analyzer && !budget.analyzerNames?.has(options.analyzer)) analyze("", options.analyzer);
  return doc => {
    const mapping = fieldMapping(doc.mappings, field);
    const actual = field === "_id" ? [doc._id] : field === "_index" ? [doc._index] : fieldValues(doc._source, field, doc.mappings);
    let score = 0;
    for (let value of actual) {
      if (kind === "range") {
        const comparable = (item: any) => mapping.type === "date" ? typeof item === "number" ? item : Date.parse(String(item)) : item;
        value = comparable(value);
        if (Object.entries(options).every(([op, limit]) => op === "boost" || op === "gt" && value > comparable(limit) || op === "gte" && value >= comparable(limit) || op === "lt" && value < comparable(limit) || op === "lte" && value <= comparable(limit))) score++;
      } else if (kind === "match" || kind === "match_phrase") {
        const analyzer = options.analyzer ?? mapping.search_analyzer ?? (mapping.type !== "keyword" && doc.analysis && Object.hasOwn(doc.analysis, "default_search") ? "default_search" : indexAnalyzer(mapping, doc.analysis));
        const terms = analyzeTokens(String(options.query), analyzer, doc.analysis), tokens = analyzeTokens(String(value), indexAnalyzer(mapping, doc.analysis), doc.analysis);
        const grouped = new Map<number, string[]>(); for (const term of terms) { const alternatives = grouped.get(term.position) ?? []; alternatives.push(term.token); grouped.set(term.position, alternatives); }
        const groups = [...grouped], words = new Set(tokens.map(token => token.token));
        const count = groups.filter(([, alternatives]) => alternatives.some(term => words.has(term))).length;
        const min = options.operator === "and" ? groups.length : options.minimum_should_match === undefined ? 1 : typeof options.minimum_should_match === "string" && /^\d+%$/.test(options.minimum_should_match) ? Math.floor(groups.length * parseInt(options.minimum_should_match) / 100) : integer(options.minimum_should_match, 1, 0, groups.length);
        if (!groups.length) { if (options.zero_terms_query === "all") score++; }
        else {
          let matched = count >= min;
          if (kind === "match_phrase") {
            const positions = new Map<number, Set<string>>(); for (const token of tokens) { const words = positions.get(token.position) ?? new Set<string>(); words.add(token.token); positions.set(token.position, words); }
            matched = [...positions.keys()].some(start => groups.every(([position, alternatives]) => {
              budget.phraseWork = (budget.phraseWork ?? 0) + alternatives.length; if (budget.phraseWork > 10000000) fail("Phrase evaluation exceeds the local work budget", "limit_exceeded_exception", 429);
              const words = positions.get(start + position - groups[0][0]); return alternatives.some(term => words?.has(term));
            }));
          }
          if (matched) score += Math.max(1, count);
        }
      } else {
        const tokens = mapping.type === "text" ? analyze(value, indexAnalyzer(mapping, doc.analysis), doc.analysis) : [value];
        const expected = kind === "terms" ? supplied : [options.value];
        if (tokens.some(token => expected.some((term: any) => {
          if (["keyword", "text"].includes(mapping.type)) term = String(term);
          else if (["byte", "short", "integer", "long", "float", "half_float", "double"].includes(mapping.type)) term = Number(term);
          else if (mapping.type === "boolean" && ["true", "false"].includes(term)) term = term === "true";
          if (options.case_insensitive) { token = String(token).toLowerCase(); term = String(term).toLowerCase(); }
          return kind === "prefix" ? String(token).startsWith(String(term)) : kind === "wildcard" ? wildcard(String(term), String(token)) : token === term;
        }))) score++;
      }
    }
    return score ? score * Number(options.boost ?? clause.boost ?? 1) : null;
  };
}

export function selectSource(source: Json, selection: any): Json | undefined {
  if (selection === false) return undefined;
  if (selection === undefined || selection === true) return source;
  if (typeof selection !== "string" && !Array.isArray(selection)) keys(record(selection, "_source"), ["includes", "include", "excludes", "exclude"], "_source");
  const include = typeof selection === "string" ? [selection] : Array.isArray(selection) ? selection : list(selection.includes ?? selection.include);
  const exclude = Array.isArray(selection) || typeof selection === "string" ? [] : list(selection.excludes ?? selection.exclude);
  if ([...include, ...exclude].some(value => typeof value !== "string")) fail("Source filters must be strings");
  const walk = (node: any, path: string): any => {
    if (exclude.some((pattern: string) => wildcard(pattern, path))) return undefined;
    if (Array.isArray(node)) {
      const result = node.map(value => walk(value, path)).filter(value => value !== undefined);
      return result.length || !include.length || include.some((pattern: string) => wildcard(pattern, path) || path.startsWith(`${pattern}.`)) ? result : undefined;
    }
    if (node && typeof node === "object") {
      const result = Object.fromEntries(Object.entries(node).flatMap(([key, value]) => { const item = walk(value, path ? `${path}.${key}` : key); return item === undefined ? [] : [[key, item]]; }));
      return Object.keys(result).length ? result : undefined;
    }
    return !include.length || include.some((pattern: string) => wildcard(pattern, path) || path.startsWith(`${pattern}.`)) ? node : undefined;
  };
  return walk(source, "") ?? {};
}
import { customTokens, type CompiledAnalysis } from "./analyzers.js";
