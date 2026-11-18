import { pipelineName } from "./ingest-pipelines.js";
import { compileQuery, fail, integer, keys, record, wildcard, type Candidate, type Json } from "./query.js";

export function validateSearchPipeline(input: unknown): Json {
  const pipeline = record(input, "search pipeline"); keys(pipeline, ["description", "version", "phase_results_processors"], "search pipeline");
  if (Buffer.byteLength(JSON.stringify(pipeline)) > 65536) fail("Search pipelines must not exceed 64 KiB");
  if (pipeline.description !== undefined && (typeof pipeline.description !== "string" || pipeline.description.length > 4096)) fail("Pipeline description must not exceed 4096 characters");
  if (pipeline.version !== undefined) integer(pipeline.version, 0, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(pipeline.phase_results_processors) || pipeline.phase_results_processors.length !== 1) fail("A search pipeline requires exactly one normalization-processor");
  const processor = record(pipeline.phase_results_processors[0], "search phase processor"); keys(processor, ["normalization-processor"], "search phase processor");
  const config = record(processor["normalization-processor"], "normalization-processor"); keys(config, ["normalization", "combination", "tag", "description", "ignore_failure"], "normalization-processor");
  for (const key of ["tag", "description"]) if (config[key] !== undefined && (typeof config[key] !== "string" || config[key].length > 4096)) fail(`${key} must contain at most 4096 characters`);
  if (config.ignore_failure !== undefined && typeof config.ignore_failure !== "boolean") fail("ignore_failure must be boolean");
  const normalization = record(config.normalization ?? {}, "normalization"); keys(normalization, ["technique"], "normalization");
  if (normalization.technique !== undefined && !["min_max", "l2"].includes(normalization.technique)) fail("Normalization supports min_max and l2");
  const combination = record(config.combination ?? {}, "combination"); keys(combination, ["technique", "parameters"], "combination");
  if (combination.technique !== undefined && !["arithmetic_mean", "geometric_mean", "harmonic_mean"].includes(combination.technique)) fail("Unsupported score combination technique");
  const parameters = record(combination.parameters ?? {}, "combination parameters"); keys(parameters, ["weights"], "combination parameters");
  if (parameters.weights !== undefined && (!Array.isArray(parameters.weights) || !parameters.weights.length || parameters.weights.length > 5 || parameters.weights.some((weight: any) => typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) || Math.abs(parameters.weights.reduce((sum: number, weight: number) => sum + weight, 0) - 1) > 1e-6)) fail("Combination weights require 1–5 numbers in [0,1] whose sum is 1");
  return structuredClone(pipeline);
}

export class SearchPipelines {
  constructor(private readonly get: (id: string) => Json | undefined, private readonly list: () => Array<{ name: string; pipeline: Json }>, private readonly put: (id: string, pipeline: Json) => void, private readonly remove: (id: string) => void) {}
  resolve(input: any): Json | undefined {
    if (input === undefined || input === "_none") return undefined;
    if (typeof input !== "string") return validateSearchPipeline(input);
    return this.get(pipelineName(input)) ?? fail(`Search pipeline [${input}] does not exist`, "resource_not_found_exception", 404);
  }
  request(method: string, name: string | undefined, body: Json): Json {
    if (method === "GET") { const found = this.list().filter(item => name === undefined || wildcard(name, item.name)); if (name !== undefined && !found.length) fail(`Search pipeline [${name}] does not exist`, "resource_not_found_exception", 404); return Object.fromEntries(found.map(item => [item.name, item.pipeline])); }
    if (!name) fail("A search pipeline ID is required"); pipelineName(name);
    if (method === "DELETE") { keys(body, [], "delete search pipeline"); this.resolve(name); this.remove(name); return { acknowledged: true }; }
    if (method !== "PUT") fail("Unsupported search pipeline operation");
    const pipeline = validateSearchPipeline(body);
    if (!this.get(name) && this.list().length >= 100) fail("At most 100 search pipelines are supported", "limit_exceeded_exception", 429);
    this.put(name, pipeline); return { acknowledged: true };
  }
}

/** One local shard per index, exact vector candidates and local lexical scores. */
export function prepareHybrid(input: Json, pipeline: Json | undefined, schemas: Array<{ name: string; settings: Json; mappings: Json }>, size: number, from: number, deadline: number, analyzerNames?: Set<string>): (documents: Candidate[]) => { ranked: Candidate[]; matched: Candidate[] } {
  if (!pipeline) fail("Hybrid queries require a normalization search pipeline");
  keys(record(input, "hybrid"), ["queries", "pagination_depth"], "hybrid");
  if (!Array.isArray(input.queries) || !input.queries.length || input.queries.length > 5) fail("Hybrid queries require 1–5 subqueries");
  const window = Math.min(10000, ...schemas.map(index => Number(index.settings.max_result_window)));
  if (from && input.pagination_depth === undefined) fail("Hybrid pagination with from > 0 requires pagination_depth");
  const depth = input.pagination_depth === undefined ? size : integer(input.pagination_depth, size, 1, window);
  const config = pipeline.phase_results_processors[0]["normalization-processor"], normalization = config.normalization?.technique ?? "min_max", combination = config.combination?.technique ?? "arithmetic_mean";
  const weights: number[] = config.combination?.parameters?.weights ?? input.queries.map(() => 1 / input.queries.length);
  if (weights.length !== input.queries.length) fail("Combination weights must match the number of hybrid subqueries");
  const predicates = input.queries.map((query: Json) => {
    const predicate = compileQuery(query, 0, { clauses: 0, analyzerNames });
    if (query.knn) for (const index of schemas) {
      if (index.settings.knn !== "true") fail("k-NN search requires index.knn=true");
      predicate({ _id: "", _index: index.name, _source: {}, _score: 0, _seq_no: 0, _primary_term: 1, _version: 0, mappings: index.mappings });
    }
    return { predicate, k: query.knn ? Number(Object.values<any>(query.knn)[0].k) : undefined };
  });
  const check = () => { if (performance.now() > deadline) fail("Query exceeded its local deadline", "timeout_exception", 408); };
  const identity = (doc: Candidate) => JSON.stringify([doc._index, doc._id]);
  return documents => {
    const matched = new Map<string, Candidate>(), scores = new Map<string, { doc: Candidate; scores: number[] }>();
    for (const [at, { predicate, k }] of predicates.entries()) {
      const byIndex = new Map<string, Candidate[]>();
      for (const doc of documents) { check(); const score = predicate(doc); if (score === null) continue; if (!Number.isFinite(score) || score < 0) fail("Hybrid scores must be finite and nonnegative"); const values = byIndex.get(doc._index) ?? []; values.push({ ...doc, _score: score }); byIndex.set(doc._index, values); }
      const collected: Candidate[] = [];
      for (const values of byIndex.values()) {
        values.sort((a, b) => { check(); return b._score - a._score || a._id.localeCompare(b._id); });
        const eligible = k === undefined ? values : values.slice(0, k);
        eligible.forEach(doc => matched.set(identity(doc), doc)); collected.push(...eligible.slice(0, depth));
      }
      let low = Infinity, high = -Infinity, norm = 0;
      for (const doc of collected) { check(); low = Math.min(low, doc._score); high = Math.max(high, doc._score); norm = Math.hypot(norm, doc._score); }
      if (!Number.isFinite(norm)) fail("Hybrid normalization overflow");
      for (const doc of collected) {
        check(); const normalized = normalization === "l2" ? norm === 0 ? 0.001 : doc._score / norm : high === low ? 1 : (doc._score - low) / (high - low) || 0.001;
        const id = identity(doc), entry = scores.get(id) ?? { doc, scores: predicates.map(() => 0) }; entry.scores[at] = normalized; scores.set(id, entry);
      }
    }
    const ranked = [...scores.values()].map(({ doc, scores }) => {
      check(); let score = 0, weight = 0;
      scores.forEach((value, i) => { if (combination !== "arithmetic_mean" && value <= 0) return; weight += weights[i]; score += weights[i] * (combination === "geometric_mean" ? Math.log(value) : combination === "harmonic_mean" ? 1 / value : value); });
      const combined = !weight ? 0 : combination === "geometric_mean" ? Math.exp(score / weight) : combination === "harmonic_mean" ? score > 0 ? weight / score : 0 : score / weight;
      return { ...doc, _score: combined };
    });
    return { ranked, matched: [...matched.values()] };
  };
}
