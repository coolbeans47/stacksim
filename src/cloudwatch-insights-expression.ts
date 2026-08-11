import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { RE2JS } from "re2js";
import type { InsightsToken } from "./cloudwatch-insights-lexer.js";
import { INSIGHTS_MISSING, InsightsEvaluationError, InsightsSyntaxError, type InsightsValue, type QueryRuntimeContext, type SourceSpan } from "./cloudwatch-insights-types.js";

export type ExpressionNode =
  | ({ kind: "literal"; value: InsightsValue | InsightsRegex } & SourceSpan)
  | ({ kind: "field"; name: string } & SourceSpan)
  | ({ kind: "list"; items: ExpressionNode[] } & SourceSpan)
  | ({ kind: "map"; entries: Array<{ key: string; value: ExpressionNode }> } & SourceSpan)
  | ({ kind: "access"; target: ExpressionNode; key: ExpressionNode } & SourceSpan)
  | ({ kind: "unary"; operator: string; operand: ExpressionNode } & SourceSpan)
  | ({ kind: "binary"; operator: string; left: ExpressionNode; right: ExpressionNode } & SourceSpan)
  | ({ kind: "call"; name: string; arguments: ExpressionNode[] } & SourceSpan);

export interface EvaluationEnvironment {
  fields: Record<string, InsightsValue>;
  context?: QueryRuntimeContext;
}

interface FunctionSignature { min: number; max: number }

export class InsightsRegex {
  readonly source: string; readonly flags: string; lastIndex = 0;
  constructor(source: string, flags: string, private readonly compiled: RE2JS) { this.source = source; this.flags = flags; }
  exec(input: string): RegExpExecArray | null { return this.compiled.exec(input) as RegExpExecArray | null; }
  test(input: string): boolean { return this.compiled.test(input); }
  replaceAll(input: string, replacement: string): string { return this.compiled.matcher(input).replaceAll(replacement); }
}

export const AGGREGATE_FUNCTIONS = new Set(["avg", "count", "count_distinct", "max", "min", "pct", "stddev", "sum", "values", "collect_values", "variance", "topk", "earliest", "latest", "sortsfirst", "sortslast", "rate", "count_over_time", "sum_over_time", "histogram"]);
export const AGGREGATE_FUNCTION_SIGNATURES: Record<string, FunctionSignature> = { avg: { min: 1, max: 1 }, count: { min: 0, max: 1 }, count_distinct: { min: 1, max: 1 }, max: { min: 1, max: 1 }, min: { min: 1, max: 1 }, pct: { min: 2, max: 2 }, stddev: { min: 1, max: 1 }, sum: { min: 1, max: 1 }, values: { min: 1, max: 1 }, collect_values: { min: 1, max: 1 }, variance: { min: 1, max: 1 }, topk: { min: 2, max: 2 }, earliest: { min: 1, max: 1 }, latest: { min: 1, max: 1 }, sortsfirst: { min: 1, max: 1 }, sortslast: { min: 1, max: 1 }, rate: { min: 2, max: 2 }, count_over_time: { min: 1, max: 1 }, sum_over_time: { min: 1, max: 1 }, histogram: { min: 2, max: 2 } };

export const SCALAR_FUNCTION_SIGNATURES: Record<string, FunctionSignature> = {
  abs: { min: 1, max: 1 }, ceil: { min: 1, max: 1 }, floor: { min: 1, max: 1 }, greatest: { min: 2, max: 100 }, least: { min: 2, max: 100 }, log: { min: 1, max: 1 }, round: { min: 1, max: 2 }, sqrt: { min: 1, max: 1 }, haversine: { min: 4, max: 4 },
  tonumber: { min: 1, max: 1 }, toint: { min: 1, max: 1 }, tolong: { min: 1, max: 1 }, todouble: { min: 1, max: 1 },
  bin: { min: 1, max: 1 }, datefloor: { min: 2, max: 2 }, dateceil: { min: 2, max: 2 }, frommillis: { min: 1, max: 1 }, tomillis: { min: 1, max: 1 }, now: { min: 0, max: 0 }, parsedate: { min: 2, max: 3 }, formatdate: { min: 2, max: 3 }, strftime: { min: 2, max: 3 }, querystarttime: { min: 0, max: 0 }, queryendtime: { min: 0, max: 0 }, querytimerange: { min: 0, max: 0 },
  ispresent: { min: 1, max: 1 }, coalesce: { min: 1, max: 100 }, case: { min: 2, max: 21 }, if: { min: 3, max: 3 }, isnumeric: { min: 1, max: 1 }, messagesize: { min: 1, max: 1 },
  isempty: { min: 1, max: 1 }, isblank: { min: 1, max: 1 }, concat: { min: 2, max: 100 }, ltrim: { min: 1, max: 2 }, rtrim: { min: 1, max: 2 }, trim: { min: 1, max: 2 }, strlen: { min: 1, max: 1 }, toupper: { min: 1, max: 1 }, tolower: { min: 1, max: 1 }, substr: { min: 2, max: 3 }, replace: { min: 3, max: 3 }, regexreplace: { min: 3, max: 3 }, strcontains: { min: 2, max: 3 }, startswith: { min: 2, max: 2 }, endswith: { min: 2, max: 2 }, urlencode: { min: 1, max: 1 }, urldecode: { min: 1, max: 1 }, base64encode: { min: 1, max: 1 }, base64decode: { min: 1, max: 1 }, split: { min: 2, max: 2 }, hextoascii: { min: 1, max: 1 }, hextodec: { min: 1, max: 1 }, dectohex: { min: 1, max: 1 }, md5: { min: 1, max: 1 }, sha256: { min: 1, max: 1 },
  isvalidip: { min: 1, max: 1 }, isvalidipv4: { min: 1, max: 1 }, isvalidipv6: { min: 1, max: 1 }, isipinsubnet: { min: 2, max: 2 }, isipv4insubnet: { min: 2, max: 2 }, isipv6insubnet: { min: 2, max: 2 }, ipv4tonumber: { min: 1, max: 1 }, isprivateip: { min: 1, max: 1 }, ispublicip: { min: 1, max: 1 }, isreservedip: { min: 1, max: 1 },
  jsonparse: { min: 1, max: 1 }, jsonstringify: { min: 1, max: 1 }, jsonarraysize: { min: 1, max: 1 }, jsonarraycontains: { min: 2, max: 2 },
};

export class InsightsExpressionParser {
  constructor(readonly tokens: InsightsToken[], public index = 0) {}

  current(): InsightsToken { return this.tokens[this.index]; }
  at(text: string): boolean { return this.current().text.toLowerCase() === text.toLowerCase(); }
  consume(text?: string): InsightsToken {
    const token = this.current();
    if (token.kind === "eof" || (text !== undefined && token.text.toLowerCase() !== text.toLowerCase())) throw new InsightsSyntaxError(text ? `Expected '${text}'` : "Expected expression", token.start, Math.max(token.end, token.start + 1));
    this.index++; return token;
  }

  parse(): ExpressionNode { return this.or(); }

  private or(): ExpressionNode { let node = this.and(); while (this.at("or")) { const operator = this.consume(); node = { kind: "binary", operator: "or", left: node, right: this.and(), start: node.start, end: this.tokens[this.index - 1].end }; } return node; }
  private and(): ExpressionNode { let node = this.not(); while (this.at("and")) { this.consume(); node = { kind: "binary", operator: "and", left: node, right: this.not(), start: node.start, end: this.tokens[this.index - 1].end }; } return node; }
  private not(): ExpressionNode { if (this.at("not") && this.tokens[this.index + 1]?.text.toLowerCase() !== "in" && this.tokens[this.index + 1]?.text.toLowerCase() !== "like") { const token = this.consume(); const operand = this.not(); return { kind: "unary", operator: "not", operand, start: token.start, end: operand.end }; } return this.comparison(); }
  private comparison(): ExpressionNode {
    let node = this.additive();
    const first = this.current().text.toLowerCase(); const second = this.tokens[this.index + 1]?.text.toLowerCase();
    let operator: string | undefined;
    if (first === "not" && (second === "like" || second === "in")) { this.consume(); operator = `not ${this.consume().text.toLowerCase()}`; }
    else if (["=", "==", "!=", ">", ">=", "<", "<=", "=~", "like", "in"].includes(first)) operator = this.consume().text.toLowerCase();
    if (operator) { const right = operator.endsWith("in") ? this.membershipOperand() : this.additive(); node = { kind: "binary", operator, left: node, right, start: node.start, end: right.end }; }
    return node;
  }
  private membershipOperand(): ExpressionNode {
    if (!this.at("(")) return this.additive();
    const start = this.consume().start; const items: ExpressionNode[] = [];
    if (!this.at(")")) do { items.push(this.parse()); if (!this.at(",")) break; this.consume(","); } while (!this.at(")"));
    const end = this.consume(")").end; return { kind: "list", items, start, end };
  }
  private additive(): ExpressionNode { let node = this.multiplicative(); while (this.at("+") || this.at("-")) { const operator = this.consume().text; const right = this.multiplicative(); node = { kind: "binary", operator, left: node, right, start: node.start, end: right.end }; } return node; }
  private multiplicative(): ExpressionNode { let node = this.power(); while (this.at("*") || this.at("/") || this.at("%")) { const operator = this.consume().text; const right = this.power(); node = { kind: "binary", operator, left: node, right, start: node.start, end: right.end }; } return node; }
  private power(): ExpressionNode { let node = this.unary(); if (this.at("^") || this.at("**")) { const operator = this.consume().text; const right = this.power(); node = { kind: "binary", operator, left: node, right, start: node.start, end: right.end }; } return node; }
  private unary(): ExpressionNode { if (this.at("+") || this.at("-")) { const token = this.consume(); const operand = this.unary(); return { kind: "unary", operator: token.text, operand, start: token.start, end: operand.end }; } return this.postfix(); }
  private postfix(): ExpressionNode {
    let node = this.primary();
    while (this.at(".") || this.at("[")) {
      if (this.at(".")) { this.consume(); const key = this.consume(); if (key.kind !== "identifier") throw new InsightsSyntaxError("Expected a field name after '.'", key.start, key.end); const literal: ExpressionNode = { kind: "literal", value: String(key.value), start: key.start, end: key.end }; node = { kind: "access", target: node, key: literal, start: node.start, end: key.end }; }
      else { this.consume("["); const key = this.parse(); const end = this.consume("]").end; node = { kind: "access", target: node, key, start: node.start, end }; }
    }
    return node;
  }
  private primary(): ExpressionNode {
    const token = this.current();
    if (token.kind === "number") { this.index++; return { kind: "literal", value: token.value as number, start: token.start, end: token.end }; }
    if (token.kind === "duration") { this.index++; return { kind: "literal", value: token.value as string, start: token.start, end: token.end }; }
    if (token.kind === "string") { this.index++; return { kind: "literal", value: token.value as string, start: token.start, end: token.end }; }
    if (token.kind === "regex") { this.index++; return { kind: "literal", value: compileInsightsRegex(String(token.value), token.flags, token), start: token.start, end: token.end }; }
    if (this.at("(")) { this.consume(); const node = this.parse(); this.consume(")"); return node; }
    if (this.at("[")) {
      const start = this.consume().start; const items: ExpressionNode[] = [];
      if (!this.at("]")) do { items.push(this.parse()); if (!this.at(",")) break; this.consume(","); } while (!this.at("]"));
      return { kind: "list", items, start, end: this.consume("]").end };
    }
    if (this.at("{")) {
      const start = this.consume().start; const entries: Array<{ key: string; value: ExpressionNode }> = [];
      if (!this.at("}")) do { const key = this.consume(); if (key.kind !== "identifier" && key.kind !== "string") throw new InsightsSyntaxError("Expected a map key", key.start, key.end); this.consume(":"); entries.push({ key: String(key.value), value: this.parse() }); if (!this.at(",")) break; this.consume(","); } while (!this.at("}"));
      return { kind: "map", entries, start, end: this.consume("}").end };
    }
    if (token.kind !== "identifier") throw new InsightsSyntaxError("Expected an expression", token.start, Math.max(token.end, token.start + 1));
    this.index++; const name = String(token.value); const rawLower = name.toLowerCase(); const lower = rawLower === "countdistinct" ? "count_distinct" : rawLower === "collectvalues" ? "collect_values" : rawLower;
    if (lower === "true" || lower === "false" || lower === "null") return { kind: "literal", value: lower === "null" ? null : lower === "true", start: token.start, end: token.end };
    if (this.at("(")) {
      this.consume(); const arguments_: ExpressionNode[] = [];
      if (!this.at(")")) do { if (this.at("*") && lower === "count") { const star = this.consume(); arguments_.push({ kind: "field", name: "*", start: star.start, end: star.end }); } else arguments_.push(this.parse()); if (!this.at(",")) break; this.consume(","); } while (!this.at(")"));
      const end = this.consume(")").end;
      const signature = SCALAR_FUNCTION_SIGNATURES[lower] ?? AGGREGATE_FUNCTION_SIGNATURES[lower];
      if (!signature && !AGGREGATE_FUNCTIONS.has(lower)) throw new InsightsSyntaxError(`Unknown function '${name}'`, token.start, token.end);
      if (signature && (arguments_.length < signature.min || arguments_.length > signature.max)) throw new InsightsSyntaxError(`${name} expects ${signature.min === signature.max ? signature.min : `${signature.min} to ${signature.max}`} arguments`, token.start, end);
      return { kind: "call", name: lower, arguments: arguments_, start: token.start, end };
    }
    return { kind: "field", name, start: token.start, end: token.end };
  }
}

export function compileInsightsRegex(source: string, flags = "", span: SourceSpan = { start: 0, end: source.length }): InsightsRegex {
  if (source.length > 1000) throw new InsightsSyntaxError("Regular expressions must not exceed 1000 characters", span.start, span.end);
  const inline = source.match(/^\(\?([im]+)\)/); if (inline) { flags += inline[1]; source = source.slice(inline[0].length); } flags = [...new Set(flags)].join("");
  if (/[^im]/.test(flags)) throw new InsightsSyntaxError("Only i and m regular-expression flags are supported", span.start, span.end);
  if (/\\[1-9]|\(\?<?[=!]|\(\?>|\(\?\(/.test(source)) throw new InsightsSyntaxError("The regular expression uses syntax that is not RE2-compatible", span.start, span.end);
  try { const re2Flags = (flags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0) | (flags.includes("m") ? RE2JS.MULTILINE : 0); return new InsightsRegex(source, flags, RE2JS.compile(source, re2Flags)); } catch { throw new InsightsSyntaxError("Invalid RE2-compatible regular expression", span.start, span.end); }
}

export function valueAt(fields: Record<string, InsightsValue>, name: string): InsightsValue {
  if (Object.hasOwn(fields, name)) return fields[name];
  const exact = Object.keys(fields).find(key => key.toLowerCase() === name.toLowerCase());
  return exact === undefined ? INSIGHTS_MISSING : fields[exact];
}

export function isMissing(value: unknown): value is typeof INSIGHTS_MISSING { return value === INSIGHTS_MISSING; }
export function isStructure(value: InsightsValue): value is InsightsValue[] | Record<string, InsightsValue> { return !isMissing(value) && value !== null && typeof value === "object"; }
export function numeric(value: InsightsValue): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?(?:ms|s|m|h|d|w|mo|q|y)$/i.test(value)) return periodMillis(value);
  if (typeof value === "string" && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
  return undefined;
}
export function insightsTruthy(value: InsightsValue): boolean { return value === true; }

function equal(left: InsightsValue, right: InsightsValue): boolean {
  if (isMissing(left) || isMissing(right) || left === null || right === null || isStructure(left) || isStructure(right)) return false;
  const a = numeric(left); const b = numeric(right); if (a !== undefined && b !== undefined) return a === b;
  return typeof left === typeof right && left === right;
}

function ordering(left: InsightsValue, right: InsightsValue): number | undefined {
  if (isMissing(left) || isMissing(right) || left === null || right === null || isStructure(left) || isStructure(right)) return undefined;
  const a = numeric(left); const b = numeric(right); if (a !== undefined && b !== undefined) return a - b;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return undefined;
}

function periodMillis(value: InsightsValue): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|q|y)$/i); if (!match) return undefined;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000, q: 7_776_000_000, y: 31_536_000_000 }; const unit = match[2].toLowerCase(); let count = Number(match[1]);
  const caps: Record<string, number> = { ms: 1000, s: 60, m: 60, h: 24 }; if (caps[unit] !== undefined) count = Math.min(count, caps[unit]);
  return count * units[unit];
}

function string(value: InsightsValue): string | undefined { return isMissing(value) || value === null || isStructure(value) ? undefined : String(value); }
function stringOrEmpty(value: InsightsValue): string { return string(value) ?? ""; }
function invalid(): typeof INSIGHTS_MISSING { return INSIGHTS_MISSING; }

function ipv4Number(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined;
  return value.split(".").reduce((sum, part) => sum * 256 + Number(part), 0) >>> 0;
}
function ipv6Number(value: string): bigint | undefined {
  if (isIP(value) !== 6) return undefined;
  const embedded = value.match(/(\d+\.\d+\.\d+\.\d+)$/); if (embedded) { const ipv4 = ipv4Number(embedded[1])!; value = `${value.slice(0, embedded.index)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`; }
  const halves = value.toLowerCase().split("::"); const left = halves[0] ? halves[0].split(":") : []; const right = halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  try { return groups.reduce((sum, part) => (sum << 16n) + BigInt(Number.parseInt(part || "0", 16)), 0n); } catch { return undefined; }
}
function inSubnet(address: string, subnet: string, version?: 4 | 6): boolean {
  const match = subnet.match(/^(.+)\/(\d+)$/); if (!match) return false;
  const actual = isIP(address); if (!actual || actual !== isIP(match[1]) || (version && actual !== version)) return false;
  const prefix = Number(match[2]); if (actual === 4) { if (prefix < 0 || prefix > 32) return false; const a = ipv4Number(address)!; const b = ipv4Number(match[1])!; const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return (a & mask) === (b & mask); }
  if (prefix < 0 || prefix > 128) return false; const a = ipv6Number(address)!; const b = ipv6Number(match[1])!; const shift = BigInt(128 - prefix); return (a >> shift) === (b >> shift);
}

function zoneDateParts(timestamp: number, timezone: string): Record<string, string> | undefined {
  try { return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value])); } catch { return undefined; }
}

function zoneOffset(timestamp: number, timezone: string): number | undefined {
  const parts = zoneDateParts(timestamp, timezone); if (!parts) return undefined; return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(timestamp / 1000) * 1000;
}

function dateFormat(timestamp: number, format = "%Y-%m-%dT%H:%M:%S.%LZ", timezone = "UTC"): string {
  const date = new Date(timestamp); if (!Number.isFinite(date.getTime())) return "";
  const parts = zoneDateParts(timestamp, timezone), offset = zoneOffset(timestamp, timezone); if (!parts || offset === undefined) return ""; const sign = offset < 0 ? "-" : "+", absoluteOffset = Math.abs(offset), offsetText = `${sign}${String(Math.floor(absoluteOffset / 3_600_000)).padStart(2, "0")}${String(Math.floor(absoluteOffset % 3_600_000 / 60_000)).padStart(2, "0")}`;
  const values: Record<string, string> = { "%Y": parts.year, "%m": parts.month, "%d": parts.day, "%H": parts.hour, "%M": parts.minute, "%S": parts.second, "%L": String(date.getUTCMilliseconds()).padStart(3, "0"), "%s": String(Math.floor(timestamp / 1000)), "%z": offsetText, "%Z": timezone };
  if (format.includes("%")) return format.replace(/%[YmdHMSLszZ%]/g, token => token === "%%" ? "%" : values[token] ?? token);
  const colonOffset = `${offsetText.slice(0, 3)}:${offsetText.slice(3)}`; const java: Record<string, string> = { yyyy: values["%Y"], SSS: values["%L"], MM: values["%m"], dd: values["%d"], HH: values["%H"], mm: values["%M"], ss: values["%S"], XXX: offset === 0 ? "Z" : colonOffset, XX: offset === 0 ? "Z" : offsetText, X: offset === 0 ? "Z" : offsetText.slice(0, 3) }; let output = format.replace(/'([^']*)'/g, "$1"); for (const token of ["yyyy", "SSS", "XXX", "MM", "dd", "HH", "mm", "ss", "XX", "X"]) output = output.replaceAll(token, java[token]); return output;
}

function parseFormattedDate(value: string, format: string, timezone = "UTC"): number | undefined {
  const normalized = format.replace(/'([^']*)'/g, "$1"); const tokens = [...normalized.matchAll(/yyyy|SSS|MM|dd|HH|mm|ss|XXX|XX|X/g)]; let source = "^"; let offset = 0; const order: string[] = [];
  for (const token of tokens) { source += normalized.slice(offset, token.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); order.push(token[0]); source += token[0] === "yyyy" ? "(\\d{4})" : token[0] === "SSS" ? "(\\d{1,3})" : token[0].startsWith("X") ? "(Z|[+-]\\d{2}:?\\d{2})" : "(\\d{2})"; offset = token.index! + token[0].length; }
  source += normalized.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"; const match = value.match(new RegExp(source)); if (!match) return undefined; const parts: Record<string, string> = {}; order.forEach((token, index) => { parts[token] = match[index + 1]; }); const zone = parts.XXX ?? parts.XX ?? parts.X; if (zone) { const isoZone = zone === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`; const iso = `${parts.yyyy ?? "1970"}-${parts.MM ?? "01"}-${parts.dd ?? "01"}T${parts.HH ?? "00"}:${parts.mm ?? "00"}:${parts.ss ?? "00"}.${(parts.SSS ?? "0").padEnd(3, "0")}${isoZone}`; const parsed = Date.parse(iso); return Number.isFinite(parsed) ? parsed : undefined; }
  const localAsUtc = Date.UTC(Number(parts.yyyy ?? 1970), Number(parts.MM ?? 1) - 1, Number(parts.dd ?? 1), Number(parts.HH ?? 0), Number(parts.mm ?? 0), Number(parts.ss ?? 0), Number((parts.SSS ?? "0").padEnd(3, "0"))); let offsetMillis = zoneOffset(localAsUtc, timezone); if (offsetMillis === undefined) return undefined; let parsed = localAsUtc - offsetMillis; const adjusted = zoneOffset(parsed, timezone); if (adjusted === undefined) return undefined; parsed = localAsUtc - adjusted; return parsed;
}

function callFunction(name: string, values: InsightsValue[], environment: EvaluationEnvironment): InsightsValue {
  const n = (index: number) => numeric(values[index]); const s = (index: number) => string(values[index]);
  if (name === "ispresent") return !isMissing(values[0]) && values[0] !== null;
  if (name === "coalesce") return values.find(value => !isMissing(value) && value !== null) ?? INSIGHTS_MISSING;
  if (name === "if") return insightsTruthy(values[0]) ? values[1] : values[2];
  if (name === "case") { for (let index = 0; index + 1 < values.length; index += 2) if (insightsTruthy(values[index])) return values[index + 1]; return values.length % 2 ? values.at(-1)! : INSIGHTS_MISSING; }
  if (name === "isnumeric") return numeric(values[0]) !== undefined;
  if (name === "messagesize") { const message = s(0); return message === undefined ? INSIGHTS_MISSING : Buffer.byteLength(message); }
  if (["tonumber", "todouble", "tolong", "toint"].includes(name)) { const value = n(0); return value === undefined ? invalid() : name === "toint" || name === "tolong" ? Math.trunc(value) : value; }
  if (name === "abs") return n(0) === undefined ? invalid() : Math.abs(n(0)!); if (name === "ceil") return n(0) === undefined ? invalid() : Math.ceil(n(0)!); if (name === "floor") return n(0) === undefined ? invalid() : Math.floor(n(0)!); if (name === "sqrt") return n(0) === undefined || n(0)! < 0 ? invalid() : Math.sqrt(n(0)!);
  if (name === "greatest" || name === "least") { const numbers = values.map(numeric); if (numbers.some(value => value === undefined)) return invalid(); return name === "greatest" ? Math.max(...numbers as number[]) : Math.min(...numbers as number[]); }
  if (name === "log") { const value = n(0), base = values.length > 1 ? n(1) : Math.E; return value === undefined || base === undefined || value <= 0 || base <= 0 || base === 1 ? invalid() : Math.log(value) / Math.log(base); }
  if (name === "round") { const value = n(0), places = values.length > 1 ? n(1) : 0; if (value === undefined || places === undefined) return invalid(); const factor = 10 ** Math.trunc(places); return Math.round(value * factor) / factor; }
  if (name === "haversine") { if ([0, 1, 2, 3].some(index => n(index) === undefined)) return invalid(); const rad = (value: number) => value * Math.PI / 180; const dLat = rad(n(2)! - n(0)!); const dLon = rad(n(3)! - n(1)!); const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(n(0)!)) * Math.cos(rad(n(2)!)) * Math.sin(dLon / 2) ** 2; return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }
  if (name === "now") return Math.floor((environment.context?.now ?? Date.now()) / 1000); if (name === "querystarttime") return environment.context?.queryStartTime ?? invalid(); if (name === "queryendtime") return environment.context?.queryEndTime ?? invalid(); if (name === "querytimerange") return environment.context?.queryStartTime === undefined || environment.context.queryEndTime === undefined ? invalid() : environment.context.queryEndTime - environment.context.queryStartTime;
  if (name === "frommillis" || name === "tomillis") return n(0) ?? invalid();
  if (name === "parsedate") { const value = s(0), format = s(1), timezone = values.length > 2 ? s(2) : "UTC"; if (value === undefined || format === undefined || timezone === undefined) return invalid(); return parseFormattedDate(value, format, timezone) ?? invalid(); }
  if (name === "formatdate" || name === "strftime") { const value = n(0), format = s(1), timezone = values.length > 2 ? s(2) : "UTC"; if (value === undefined || format === undefined || timezone === undefined) return invalid(); const result = dateFormat(value, format, timezone); return result || invalid(); }
  if (name === "bin" || name === "datefloor" || name === "dateceil") { const timestamp = name === "bin" ? numeric(valueAt(environment.fields, "@timestamp")) : n(0); const period = periodMillis(values[name === "bin" ? 0 : 1]); if (timestamp === undefined || period === undefined || period <= 0) return invalid(); const floor = Math.floor(timestamp / period) * period; return name === "dateceil" && floor !== timestamp ? floor + period : floor; }
  if (name === "isempty") return isMissing(values[0]) || values[0] === null || s(0) === "" ? 1 : 0; if (name === "isblank") return isMissing(values[0]) || values[0] === null || /^\s*$/.test(s(0) ?? "") ? 1 : 0;
  if (name === "concat") return values.map(stringOrEmpty).join(""); if (name === "strlen") return s(0) === undefined ? invalid() : [...s(0)!].length; if (name === "toupper") return s(0)?.toUpperCase() ?? invalid(); if (name === "tolower") return s(0)?.toLowerCase() ?? invalid();
  if (["trim", "ltrim", "rtrim"].includes(name)) { const value = s(0); if (value === undefined) return invalid(); const characters = values.length > 1 ? s(1) : undefined; const escaped = characters?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "\\s"; const regex = name === "trim" ? new RegExp(`^[${escaped}]+|[${escaped}]+$`, "g") : name === "ltrim" ? new RegExp(`^[${escaped}]+`) : new RegExp(`[${escaped}]+$`); return value.replace(regex, ""); }
  if (name === "substr") { const value = s(0), start = n(1), length = values.length > 2 ? n(2) : undefined; return value === undefined || start === undefined || (values.length > 2 && length === undefined) ? invalid() : value.slice(Math.trunc(start), length === undefined ? undefined : Math.trunc(start + length)); }
  if (name === "replace") { const value = s(0), find = s(1), replacement = s(2); return value === undefined || find === undefined || replacement === undefined ? invalid() : value.split(find).join(replacement); }
  if (name === "regexreplace") { const value = s(0), pattern = s(1), replacement = s(2); if (value === undefined || pattern === undefined || replacement === undefined) return invalid(); return compileInsightsRegex(pattern).replaceAll(value, replacement); }
  if (name === "strcontains") { const source = s(0), search = s(1); if (source === undefined || search === undefined || (values.length > 2 && typeof values[2] !== "boolean")) return invalid(); return (values[2] === true ? source.toLocaleLowerCase().includes(search.toLocaleLowerCase()) : source.includes(search)) ? 1 : 0; } if (name === "startswith") return s(0) === undefined || s(1) === undefined ? invalid() : s(0)!.startsWith(s(1)!) ? 1 : 0; if (name === "endswith") return s(0) === undefined || s(1) === undefined ? invalid() : s(0)!.endsWith(s(1)!) ? 1 : 0;
  if (name === "urlencode") return s(0) === undefined ? invalid() : encodeURIComponent(s(0)!); if (name === "urldecode") { try { return s(0) === undefined ? invalid() : decodeURIComponent(s(0)!.replace(/\+/g, " ")); } catch { return invalid(); } }
  if (name === "base64encode") return s(0) === undefined ? invalid() : Buffer.from(s(0)!, "utf8").toString("base64"); if (name === "base64decode") { const value = s(0); if (value === undefined || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid(); try { return Buffer.from(value, "base64").toString("utf8"); } catch { return invalid(); } }
  if (name === "split") { const value = s(0), separator = s(1); return value === undefined || separator === undefined ? invalid() : value.split(separator); }
  if (name === "hextoascii") { const value = s(0)?.replace(/^0x/i, ""); return value === undefined || !/^(?:[0-9A-Fa-f]{2})*$/.test(value) ? invalid() : Buffer.from(value, "hex").toString("utf8"); } if (name === "hextodec") { const value = s(0)?.replace(/^0x/i, ""); return value === undefined || !/^[0-9A-Fa-f]+$/.test(value) ? invalid() : Number.parseInt(value, 16); } if (name === "dectohex") { const value = n(0); if (value === undefined) return invalid(); const integer = Math.trunc(value); return integer < 0 ? `-0x${Math.abs(integer).toString(16)}` : `0x${integer.toString(16)}`; }
  if (name === "md5" || name === "sha256") return s(0) === undefined ? invalid() : createHash(name).update(s(0)!).digest("hex");
  if (name === "isvalidip") return isIP(s(0) ?? "") !== 0; if (name === "isvalidipv4") return isIP(s(0) ?? "") === 4; if (name === "isvalidipv6") return isIP(s(0) ?? "") === 6;
  if (name === "isipinsubnet" || name === "isipv4insubnet" || name === "isipv6insubnet") return s(0) !== undefined && s(1) !== undefined && inSubnet(s(0)!, s(1)!, name === "isipv4insubnet" ? 4 : name === "isipv6insubnet" ? 6 : undefined);
  if (name === "ipv4tonumber") return s(0) === undefined ? invalid() : ipv4Number(s(0)!) ?? invalid();
  if (name === "isprivateip" || name === "isreservedip" || name === "ispublicip") { const address = s(0); if (!address || !isIP(address)) return false; const privateAddress = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"].some(subnet => inSubnet(address, subnet)); const reserved = privateAddress || ["127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4", "::1/128", "fe80::/10", "ff00::/8"].some(subnet => inSubnet(address, subnet)); return name === "isprivateip" ? privateAddress : name === "isreservedip" ? reserved : !reserved; }
  if (name === "jsonparse") { const value = s(0); if (value === undefined) return invalid(); try { const parsed = JSON.parse(value) as InsightsValue; return isStructure(parsed) ? parsed : invalid(); } catch { return invalid(); } }
  if (name === "jsonstringify") return !isStructure(values[0]) ? invalid() : JSON.stringify(values[0]); if (name === "jsonarraysize" || name === "jsonarraycontains") { let array: InsightsValue[] | undefined; if (Array.isArray(values[0])) array = values[0]; else { const source = s(0); if (source !== undefined) try { const parsed = JSON.parse(source); if (Array.isArray(parsed)) array = parsed; } catch {} } return name === "jsonarraysize" ? array?.length ?? invalid() : array?.some(value => equal(value, values[1])) ?? false; }
  throw new InsightsEvaluationError(`Function '${name}' is not valid in a scalar expression`);
}

export function evaluateExpression(node: ExpressionNode, environment: EvaluationEnvironment): InsightsValue {
  if (node.kind === "literal") return node.value instanceof InsightsRegex ? node.value as any : node.value;
  if (node.kind === "field") return valueAt(environment.fields, node.name);
  if (node.kind === "list") return node.items.map(item => evaluateExpression(item, environment));
  if (node.kind === "map") return Object.fromEntries(node.entries.map(entry => [entry.key, evaluateExpression(entry.value, environment)]));
  if (node.kind === "access") {
    const flattened = flattenedFieldName(node); if (flattened) { const direct = valueAt(environment.fields, flattened); if (!isMissing(direct)) return direct; }
    const target = evaluateExpression(node.target, environment), key = evaluateExpression(node.key, environment); if (isMissing(target) || target === null || isMissing(key) || key === null) return INSIGHTS_MISSING; if (Array.isArray(target)) { const index = numeric(key); return index === undefined ? INSIGHTS_MISSING : target[Math.trunc(index)] ?? INSIGHTS_MISSING; } if (typeof target === "object") return (target as Record<string, InsightsValue>)[String(key)] ?? INSIGHTS_MISSING; return INSIGHTS_MISSING;
  }
  if (node.kind === "unary") { const value = evaluateExpression(node.operand, environment); if (node.operator === "not") return !insightsTruthy(value); const number = numeric(value); return number === undefined ? INSIGHTS_MISSING : node.operator === "-" ? -number : number; }
  if (node.kind === "call") {
    if (node.name === "if") { const condition = evaluateExpression(node.arguments[0], environment); return evaluateExpression(node.arguments[insightsTruthy(condition) ? 1 : 2], environment); }
    if (node.name === "coalesce") { for (const argument of node.arguments) { const value = evaluateExpression(argument, environment); if (!isMissing(value) && value !== null) return value; } return INSIGHTS_MISSING; }
    const values = node.arguments.map(argument => evaluateExpression(argument, environment)); return callFunction(node.name, values, environment);
  }
  if (node.operator === "and") { const left = evaluateExpression(node.left, environment); return insightsTruthy(left) && insightsTruthy(evaluateExpression(node.right, environment)); }
  if (node.operator === "or") { const left = evaluateExpression(node.left, environment); return insightsTruthy(left) || insightsTruthy(evaluateExpression(node.right, environment)); }
  const left = evaluateExpression(node.left, environment); const right = evaluateExpression(node.right, environment);
  if (node.operator === "=" || node.operator === "==") return equal(left, right); if (node.operator === "!=") return isMissing(left) || isMissing(right) || left === null || right === null ? false : !equal(left, right);
  if ([">", ">=", "<", "<="].includes(node.operator)) { const result = ordering(left, right); if (result === undefined) return false; return node.operator === ">" ? result > 0 : node.operator === ">=" ? result >= 0 : node.operator === "<" ? result < 0 : result <= 0; }
  if (["like", "not like", "=~"].includes(node.operator)) { const source = string(left); if (source === undefined || isMissing(right) || right === null) return false; const pattern = right instanceof InsightsRegex ? right : node.operator === "=~" ? compileInsightsRegex(string(right) ?? "") : undefined; const matches = pattern ? (pattern.lastIndex = 0, pattern.test(source)) : source.includes(string(right) ?? ""); return node.operator === "not like" ? !matches : matches; }
  if (node.operator === "in" || node.operator === "not in") { if (isMissing(left) || left === null) return false; const values = Array.isArray(right) ? right : [right]; const included = values.some(value => equal(left, value as InsightsValue)); return node.operator === "not in" ? !included : included; }
  const a = numeric(left), b = numeric(right); if (a === undefined || b === undefined) return INSIGHTS_MISSING;
  if (node.operator === "+") return a + b; if (node.operator === "-") return a - b; if (node.operator === "*") return a * b; if (node.operator === "%") return b === 0 ? INSIGHTS_MISSING : a % b; if (node.operator === "/") return b === 0 ? INSIGHTS_MISSING : a / b; return a ** b;
}

function flattenedFieldName(node: ExpressionNode): string | undefined {
  if (node.kind === "field") return node.name;
  if (node.kind !== "access" || node.key.kind !== "literal" || typeof node.key.value !== "string") return undefined;
  const target = flattenedFieldName(node.target); return target ? `${target}.${node.key.value}` : undefined;
}

export function expressionName(node: ExpressionNode): string {
  if (node.kind === "field") return node.name;
  if (node.kind === "literal") return node.value instanceof InsightsRegex ? `/${node.value.source}/` : typeof node.value === "string" ? node.value : String(node.value);
  if (node.kind === "access" && node.key.kind === "literal" && typeof node.key.value === "string") { const target = expressionName(node.target); return target === "expr" ? target : `${target}.${node.key.value}`; }
  if (node.kind === "call") return `${node.name}(${node.arguments.map(expressionName).join(", ")})`;
  return "expr";
}
