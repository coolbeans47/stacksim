import { AwsError } from "./errors.js";
import { executeLanguage, parseLanguage, type LanguagePlan } from "./opensearch/query-languages.js";
import type { Candidate } from "./opensearch/query.js";

export const LOG_LANGUAGE_MAX_EVENTS = 50_000;
export const LOG_LANGUAGE_MAX_BYTES = 64 * 1024 * 1024;

function invalid(message: string): never { throw new AwsError("InvalidParameterException", message); }
export function logLanguageError(error: unknown): AwsError {
  const message = error instanceof Error ? error.message : String(error);
  return new AwsError("MalformedQueryException", message, 400, { queryCompileError: { message, location: { startCharOffset: 0, endCharOffset: 1 } } });
}

/** The authorization resolver and executor must resolve exactly the same source. */
export function parseLogLanguage(input: any, region: string, accountId: string): LanguagePlan {
  const language = String(input.queryLanguage).toUpperCase();
  if (language !== "SQL" && language !== "PPL") invalid("Expected SQL or PPL");
  if (typeof input.queryString !== "string" || input.queryString.length > 10_000) invalid("queryString must be a string of at most 10000 characters");
  const selectors = [input.logGroupName, input.logGroupNames, input.logGroupIdentifiers].filter(value => value !== undefined);
  if (selectors.length > 1 || language === "SQL" && selectors.length) invalid("SQL selects its log group in FROM; PPL accepts at most one log group selector");
  if (input.logGroupName !== undefined && typeof input.logGroupName !== "string" || input.logGroupNames !== undefined && !Array.isArray(input.logGroupNames) || input.logGroupIdentifiers !== undefined && !Array.isArray(input.logGroupIdentifiers)) invalid("Invalid log group selector type");
  let selected: string | undefined;
  if (selectors.length) {
    const requested = Array.isArray(selectors[0]) ? selectors[0] : [selectors[0]];
    if (requested.length !== 1 || typeof requested[0] !== "string") invalid("The local SQL/PPL profile requires exactly one log group");
    selected = requested[0];
    if (selected!.startsWith("arn:")) {
      const prefix = `arn:aws:logs:${region}:${accountId}:log-group:`;
      if (!selected!.startsWith(prefix)) invalid("SQL/PPL log groups must belong to this account and Region");
      selected = selected!.slice(prefix.length);
    }
    if (!/^[.\-_/#A-Za-z0-9]{1,512}$/.test(selected!)) invalid("Invalid log group name");
  }
  let query = input.queryString.trim();
  if (language === "PPL") {
    // The current Logs selector spelling is equivalent to the simple PPL source.
    query = query.replace(/^(search\s+)?source\s*=\s*\[lg:\s*`([.\-_/#A-Za-z0-9]{1,512})`\s*\]/i, (_: string, search: string, name: string) => `${search ?? ""}source = \`${name}\``);
    if (selected && !/^(?:search\s+)?source\s*=/i.test(query)) query = `source = \`${selected}\` | ${query}`;
  }
  let plan: LanguagePlan;
  try { plan = parseLanguage(language === "SQL" ? "sql" : "ppl", query, "log-group"); } catch (error) { throw logLanguageError(error); }
  if (selected && selected !== plan.source) invalid("The PPL source must match the selected log group");
  return plan;
}

export type LogLanguageFields = Record<string, string | number | boolean | null>;

/** Flat discovery names are literal keys, including JSON dotted paths and @fields. */
export function executeLogLanguage(plan: LanguagePlan, records: LogLanguageFields[], maximum: number, deadline: number) {
  const types = new Map<string, Set<string>>();
  for (const name of ["@message", "@logStream", "@log", "@ptr"]) types.set(name, new Set(["keyword"]));
  for (const name of ["@timestamp", "@ingestionTime"]) types.set(name, new Set(["long"]));
  for (const record of records) for (const [field, value] of Object.entries(record)) {
    const set = types.get(field) ?? new Set<string>();
    if (value !== null) { if (typeof value === "number" && !Number.isFinite(value)) throw logLanguageError(`Field [${field}] contains a non-finite number`); set.add(typeof value === "number" ? "double" : typeof value === "boolean" ? "boolean" : "keyword"); }
    types.set(field, set);
    if (types.size > 4096) throw new Error("SQL/PPL discovery exceeds 4096 fields");
  }
  const properties = Object.fromEntries([...types].map(([name, set]) => [name, { type: !set.size ? "keyword" : [...set].every(type => type === "long" || type === "double") ? "double" : set.size === 1 ? [...set][0] : "incompatible" }]));
  const mappings = { properties };
  const documents: Candidate[] = records.map((fields, index) => ({ _id: String(index), _index: plan.source, _source: fields, _score: 1, _seq_no: index, _primary_term: 1, _version: 1, mappings }));
  const result = executeLanguage(plan, [mappings], () => documents, undefined, deadline, "flat");
  const rows: Array<Array<{ field: string; value: string }>> = []; let bytes = 0;
  for (const values of result.datarows.slice(0, maximum)) {
    const row = values.flatMap((value: any, index: number) => value === null ? [] : [{ field: result.schema[index].name, value: String(value) }]);
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > 32 * 1024 * 1024 - 1024) throw new Error("SQL/PPL Logs response exceeds 32 MiB");
    rows.push(row);
  }
  return { rows, recordsMatched: result.recordsMatched as number };
}
