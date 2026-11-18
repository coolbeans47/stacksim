import { fail, keys, record, type Json } from "./query.js";

export interface AnalysisToken { token: string; start_offset: number; end_offset: number; type: string; position: number }
export interface DictionaryVersion { version: string; text: string }
export interface CompiledAnalyzer { tokenizer: string; filters: Array<{ kind: "lowercase" } | { kind: "stop"; words: string[]; ignoreCase: boolean } | { kind: "synonym"; rules: Record<string, string[]> }> }
export type CompiledAnalysis = Record<string, CompiledAnalyzer>;
const named = (value: any) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const BUILTINS = new Set(["standard", "simple", "whitespace", "keyword", "stop"]);
function boolean(value: any, fallback: boolean): boolean { if (value === undefined) return fallback; if (typeof value !== "boolean") fail("Analysis options must be boolean"); return value; }
function lines(text: string): string[] {
  if (Buffer.byteLength(text) > 65536 || text.includes("\0")) fail("Analyzer dictionaries require at most 64 KiB of UTF-8 text without NUL characters");
  const result = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (result.length > 1000) fail("Analyzer dictionaries allow at most 1000 entries"); return result;
}
function term(value: string): string { if (!value || value.length > 256 || /[\s,=>]/u.test(value)) fail("Dictionary rules currently require single terms of at most 256 characters"); return value; }

/** Compile data-only filters. No package path is ever treated as a filesystem path. */
export function compileAnalysis(input: Json, dictionary: (id: string, updateable: boolean) => DictionaryVersion | undefined): CompiledAnalysis {
  keys(record(input, "analysis"), ["analyzer", "filter"], "analysis");
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) fail("Analysis configuration is limited to 64 KiB");
  const analyzers = record(input.analyzer ?? {}, "analysis.analyzer"), filters = record(input.filter ?? {}, "analysis.filter");
  if (Object.keys(analyzers).length > 32 || Object.keys(filters).length > 32) fail("Analysis allows at most 32 analyzers and 32 filters per index");
  const compiledFilters = new Map<string, CompiledAnalyzer["filters"][number]>();
  const dictionaryLines = (path: any, updateable = false): string[] => {
    if (typeof path !== "string" || !/^analyzers\/(?:[FG]\d+|pkg-[a-f0-9]+)$/.test(path)) fail("Dictionary paths must reference an associated package as analyzers/<package ID>");
    const value = dictionary(path.slice(10), updateable); if (!value) fail(`Dictionary package [${path.slice(10)}] is not associated with this domain`); return lines(value.text);
  };
  for (const [id, filter] of Object.entries<any>(filters)) {
    if (!named(id) || id === "lowercase") fail("Invalid or reserved analysis filter name"); record(filter, "analysis filter");
    if (filter.type === "stop") {
      keys(filter, ["type", "stopwords", "stopwords_path", "ignore_case"], "stop filter");
      if ((filter.stopwords === undefined) === (filter.stopwords_path === undefined)) fail("Stop filters require exactly one of stopwords or stopwords_path");
      const words = filter.stopwords_path !== undefined ? dictionaryLines(filter.stopwords_path) : filter.stopwords;
      if (!Array.isArray(words) || words.length > 1000 || words.some(word => typeof word !== "string")) fail("Stopwords must be an array of at most 1000 terms");
      const ignoreCase = boolean(filter.ignore_case, false); compiledFilters.set(id, { kind: "stop", words: [...new Set(words.map(word => ignoreCase ? term(word).toLowerCase() : term(word)))], ignoreCase });
    } else if (filter.type === "synonym") {
      keys(filter, ["type", "synonyms", "synonyms_path", "expand", "updateable"], "synonym filter"); boolean(filter.updateable, false);
      if ((filter.synonyms === undefined) === (filter.synonyms_path === undefined)) fail("Synonym filters require exactly one of synonyms or synonyms_path");
      const definitions = filter.synonyms_path !== undefined ? dictionaryLines(filter.synonyms_path, filter.updateable === true) : filter.synonyms;
      if (!Array.isArray(definitions) || definitions.length > 1000 || definitions.some(line => typeof line !== "string")) fail("Synonyms require at most 1000 string rules");
      const rules = new Map<string, Set<string>>(), expand = boolean(filter.expand, true);
      for (const line of definitions) {
        const sides = line.split("=>"); if (sides.length > 2) fail("Malformed synonym rule");
        const parse = (text: string) => { const terms = text.split(",").map(value => term(value.trim())); if (terms.length > 32) fail("A synonym rule allows at most 32 alternatives"); return terms; };
        const left = parse(sides[0]), right = sides.length === 2 ? parse(sides[1]) : expand ? left : [left[0]];
        for (const source of left) { const targets = rules.get(source) ?? new Set<string>(); right.forEach(target => targets.add(target)); if (targets.size > 32) fail("A synonym term allows at most 32 alternatives"); rules.set(source, targets); }
      }
      compiledFilters.set(id, { kind: "synonym", rules: Object.fromEntries([...rules].map(([source, targets]) => [source, [...targets]])) });
    } else fail(`Analysis filter [${filter.type}] is not supported`);
  }
  const result: CompiledAnalysis = Object.create(null);
  for (const [id, analyzer] of Object.entries<any>(analyzers)) {
    if (!named(id) || BUILTINS.has(id)) fail("Invalid or reserved custom analyzer name");
    keys(record(analyzer, "custom analyzer"), ["type", "tokenizer", "filter"], "custom analyzer");
    if (analyzer.type !== "custom" || !["standard", "whitespace", "keyword"].includes(analyzer.tokenizer)) fail("Custom analyzers require a standard, whitespace or keyword tokenizer");
    if (!Array.isArray(analyzer.filter) || analyzer.filter.length > 16 || analyzer.filter.some((id: any) => !named(id))) fail("Custom analyzers require an array of at most 16 filters");
    result[id] = { tokenizer: analyzer.tokenizer, filters: analyzer.filter.map((id: string) => id === "lowercase" ? { kind: "lowercase" } : compiledFilters.get(id) ?? fail(`Analysis filter [${id}] does not exist`)) };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) fail("Compiled analysis exceeds the local 1 MiB bound");
  return result;
}

export function customTokens(text: string, analyzer: CompiledAnalyzer): AnalysisToken[] {
  if (Buffer.byteLength(text) > 1024 * 1024) fail("Analysis input exceeds 1 MiB", "limit_exceeded_exception", 413);
  // Standard's base tokenizer preserves case; lowercase is an explicit filter.
  let tokens: AnalysisToken[] = [];
  if (analyzer.tokenizer === "keyword") tokens.push({ token: text, start_offset: 0, end_offset: text.length, position: 0, type: "word" });
  else for (const match of text.matchAll(analyzer.tokenizer === "standard" ? /[\p{L}\p{N}]+/gu : /\S+/gu)) {
    if (tokens.length >= 65536) fail("Analysis exceeds 65536 tokens", "limit_exceeded_exception", 413);
    tokens.push({ token: match[0], start_offset: match.index, end_offset: match.index + match[0].length, position: tokens.length, type: analyzer.tokenizer === "standard" ? "<ALPHANUM>" : "word" });
  }
  const bounded = () => { if (tokens.length > 65536 || tokens.reduce((total, token) => total + Buffer.byteLength(token.token), 0) > 4 * 1024 * 1024) fail("Analysis exceeds 65536 tokens or 4 MiB of token text", "limit_exceeded_exception", 413); };
  bounded();
  for (const filter of analyzer.filters) {
    if (filter.kind === "lowercase") tokens = tokens.map(token => ({ ...token, token: token.token.toLowerCase() }));
    else if (filter.kind === "stop") { const words = new Set(filter.words); tokens = tokens.filter(token => !words.has(filter.ignoreCase ? token.token.toLowerCase() : token.token)); }
    else {
      const expanded: AnalysisToken[] = []; let bytes = 0;
      for (const token of tokens) {
        const replacements = Object.hasOwn(filter.rules, token.token) ? filter.rules[token.token] : undefined;
        for (const word of replacements ?? [token.token]) {
          if (expanded.length >= 65536 || (bytes += Buffer.byteLength(word)) > 4 * 1024 * 1024) fail("Analysis exceeds 65536 tokens or 4 MiB of token text", "limit_exceeded_exception", 413);
          expanded.push(replacements ? { ...token, token: word, type: "SYNONYM" } : token);
        }
      }
      tokens = expanded;
    }
    bounded();
  }
  return tokens;
}
