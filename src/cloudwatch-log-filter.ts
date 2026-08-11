export interface LogFilterMatch {
  matched: boolean;
  extractedValues: Record<string, string>;
}

export class LogFilterSyntaxError extends Error {}

function valueAt(root: unknown, path: string): unknown {
  let value: any = root;
  for (const part of path.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
    const array = part.match(/^([^\[]+)\[(\d+)]$/);
    if (array) value = value?.[array[1]]?.[Number(array[2])];
    else value = value?.[part];
  }
  return value;
}

function wildcard(value: string): RegExp {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function literal(raw: string): unknown {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) { try { return JSON.parse(value); } catch { throw new LogFilterSyntaxError("Invalid quoted filter value"); } }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

function compare(actual: unknown, operator: string, expectedRaw: string): boolean {
  const regex = expectedRaw.match(/^%([\s\S]*)%$/);
  if (regex) { try { const found = new RegExp(regex[1]).test(String(actual ?? "")); return operator === "!=" ? !found : found; } catch { throw new LogFilterSyntaxError("Invalid regular expression in filter pattern"); } }
  const expected = literal(expectedRaw); let equal: boolean;
  if (typeof expected === "string" && expected.includes("*")) equal = wildcard(expected).test(String(actual ?? ""));
  else equal = actual === expected || String(actual) === String(expected);
  if (operator === "=") return equal;
  if (operator === "!=") return !equal;
  const left = Number(actual); const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return operator === ">" ? left > right : operator === ">=" ? left >= right : operator === "<" ? left < right : left <= right;
}

function jsonMatch(message: string, body: string): LogFilterMatch {
  let value: unknown; try { value = JSON.parse(message); } catch { return { matched: false, extractedValues: {} }; }
  const clauses = body.split(/\s*(&&|\|\|)\s*/).filter(Boolean); if (!clauses.length) throw new LogFilterSyntaxError("JSON filter pattern is empty");
  const extractedValues: Record<string, string> = {}; let aggregate: boolean | undefined; let connector = "&&";
  for (const token of clauses) {
    if (token === "&&" || token === "||") { connector = token; continue; }
    const clause = token.trim().replace(/^\(|\)$/g, "").trim();
    const exists = clause.match(/^(\$\.[A-Za-z0-9_.\-[\]]+)\s+(NOT\s+EXISTS|IS\s+NULL)$/i);
    const comparison = clause.match(/^(\$\.[A-Za-z0-9_.\-[\]]+)\s*(=|!=|>=|<=|>|<)\s*(.+)$/);
    if (!exists && !comparison) throw new LogFilterSyntaxError(`Unsupported JSON filter clause: ${clause}`);
    const path = (exists ?? comparison)![1]; const actual = valueAt(value, path); if (actual !== undefined) extractedValues[path] = String(actual);
    const result = exists ? (exists[2].toUpperCase() === "IS NULL" ? actual === null : actual === undefined) : compare(actual, comparison![2], comparison![3]);
    aggregate = aggregate === undefined ? result : connector === "&&" ? aggregate && result : aggregate || result;
  }
  return { matched: Boolean(aggregate), extractedValues };
}

function words(message: string): string[] { return message.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*]|\S+/g)?.map(value => value.replace(/^(?:"|')|(?:"|')$/g, "")) ?? []; }

function delimitedMatch(message: string, body: string): LogFilterMatch {
  const descriptors = body.split(",").map(value => value.trim()); if (!descriptors.length || descriptors.some(value => !value)) throw new LogFilterSyntaxError("Space-delimited filter fields are invalid");
  const values = words(message); const extractedValues: Record<string, string> = {}; let index = 0;
  for (const descriptor of descriptors) {
    if (descriptor === "...") { index = Math.max(index, values.length - (descriptors.length - descriptors.indexOf(descriptor) - 1)); continue; }
    const condition = descriptor.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|>=|<=|>|<)\s*(.+)$/); const name = condition?.[1] ?? descriptor;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new LogFilterSyntaxError(`Invalid field name ${name}`);
    const actual = values[index++]; if (actual === undefined) return { matched: false, extractedValues: {} }; extractedValues[`$${name}`] = actual;
    if (condition && !compare(actual, condition[2], condition[3])) return { matched: false, extractedValues };
  }
  return { matched: true, extractedValues };
}

function termMatch(message: string, pattern: string): LogFilterMatch {
  const terms = pattern.match(/-?\??"(?:[^"\\]|\\.)*"|-?\??%[^%]*%|-?\??\S+/g) ?? []; if (!terms.length) return { matched: true, extractedValues: {} };
  for (const term of terms) {
    const negative = term.startsWith("-"); const optional = term.startsWith("?") || term.startsWith("-?"); const raw = term.replace(/^-?\?/, "").replace(/^"|"$/g, ""); let found: boolean;
    const regex = raw.match(/^%([\s\S]*)%$/); if (regex) { try { found = new RegExp(regex[1]).test(message); } catch { throw new LogFilterSyntaxError("Invalid regular expression in filter pattern"); } } else found = message.includes(raw);
    if (!optional && (negative ? found : !found)) return { matched: false, extractedValues: {} };
  }
  return { matched: true, extractedValues: {} };
}

export function regexCount(pattern: string): number { return pattern.match(/%[^%]*%/g)?.length ?? 0; }

export function validateLogFilterPattern(pattern: unknown): string {
  if (typeof pattern !== "string" || pattern.length > 1024) throw new LogFilterSyntaxError("Filter pattern must be a string of at most 1024 characters");
  if (regexCount(pattern) > 2) throw new LogFilterSyntaxError("A filter pattern can contain no more than two regular expressions");
  matchLogFilterPattern("{}", pattern);
  return pattern;
}

export function matchLogFilterPattern(message: string, pattern: string | undefined): LogFilterMatch {
  if (!pattern?.trim()) return { matched: true, extractedValues: {} };
  const trimmed = pattern.trim();
  if (trimmed.startsWith("{") || trimmed.endsWith("}")) {
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new LogFilterSyntaxError("JSON filter pattern braces are unbalanced");
    return jsonMatch(message, trimmed.slice(1, -1).trim());
  }
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) {
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new LogFilterSyntaxError("Space-delimited filter pattern brackets are unbalanced");
    return delimitedMatch(message, trimmed.slice(1, -1).trim());
  }
  return termMatch(message, trimmed);
}

export function resolveExtractedValue(selector: string, extractedValues: Record<string, string>, message: string): string | undefined {
  if (extractedValues[selector] !== undefined) return extractedValues[selector];
  if (selector.startsWith("$.")) { try { const value = valueAt(JSON.parse(message), selector); return value === undefined || value === null ? value === null ? "null" : undefined : String(value); } catch { return undefined; } }
  if (selector.startsWith("$") && extractedValues[selector]) return extractedValues[selector];
  return selector;
}
