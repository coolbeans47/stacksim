import { AwsError } from "./errors.js";

// API Gateway mapping templates: Apache Velocity 1.7 semantics over an explicit value model.
// Only plain data (string, number, boolean, null, arrays, plain objects) and the modeled host objects ($input, $util, $foreach, Map
// entries) are reachable. Nothing resolves a JS property generically and no JS function value is ever exposed or called.

export interface VtlLimits { maxForeachIterations: number; maxOutputLength: number; maxStringLength: number; maxDepth: number; maxCollectionSize: number; maxSteps: number }
export const VTL_LIMITS: Readonly<VtlLimits> = Object.freeze({ maxForeachIterations: 10_000, maxOutputLength: 10 * 1024 * 1024, maxStringLength: 10 * 1024 * 1024, maxDepth: 64, maxCollectionSize: 100_000, maxSteps: 5_000_000 });
/** `context.responseOverride` ({ header: {} }) and `context.requestOverride` ({ header: {}, querystring: {}, path: {} }) receive template writes in place; missing ones are created on `context`. */
export interface VtlContext { body: string; headers: Record<string, string>; query: Record<string, string>; path: Record<string, string>; context: Record<string, unknown>; stageVariables: Record<string, string>; limits?: Partial<VtlLimits> }
/** A mapping template failed while being evaluated (or could not be parsed at invoke time). API Gateway answers 500 "Internal server error". */
export class VtlTemplateError extends AwsError { constructor(message: string) { super("InternalServerErrorException", message, 500); this.name = "VtlTemplateError"; } }
class VtlParseError extends Error {}

type Seg = { k: "prop"; name: string } | { k: "call"; name: string; args: Expr[] } | { k: "index"; expr: Expr };
interface Ref { root: string; segs: Seg[]; quiet: boolean; src: string }
type Expr = { t: "lit"; v: unknown } | { t: "str"; nodes: Node[] } | { t: "ref"; ref: Ref } | { t: "list"; items: Expr[] } | { t: "range"; from: Expr; to: Expr } | { t: "map"; entries: Array<[Expr, Expr]> } | { t: "bin"; op: string; l: Expr; r: Expr } | { t: "not"; e: Expr } | { t: "neg"; e: Expr };
type Node = { t: "text"; v: string } | { t: "ref"; ref: Ref; esc: number } | { t: "set"; target: Ref; value: Expr } | { t: "if"; branches: Array<{ cond?: Expr; body: Node[] }> } | { t: "foreach"; name: string; iter: Expr; body: Node[] } | { t: "break"; scope?: Ref } | { t: "stop" };
type Term = { kind: "end" | "else" | "elseif" | "eof"; cond?: Expr; at: number };
type Sink = { parts: string[]; length: number; max: number; what: "output" | "string" };

const UNSUPPORTED_DIRECTIVES = new Set(["macro", "define", "parse", "include", "evaluate"]);
const DIRECTIVES = new Set(["set", "if", "elseif", "else", "end", "foreach", "break", "stop", ...UNSUPPORTED_DIRECTIVES]);
const BLOCKED_KEYS = new Set(["constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
const BLOCKED_MEMBERS = new Set(["class", "getClass"]);
const ID = /[a-zA-Z_][a-zA-Z0-9_]*/y; const LHS_ID = /[a-zA-Z_][a-zA-Z0-9_-]*/y;
const OPERATORS: Array<[string[], RegExp | undefined, Record<string, string>]> = [[["||"], /(or)(?![a-zA-Z0-9_])/y, { or: "||" }], [["&&"], /(and)(?![a-zA-Z0-9_])/y, { and: "&&" }], [["==", "!="], /(eq|ne)(?![a-zA-Z0-9_])/y, { eq: "==", ne: "!=" }], [["<=", ">=", "<", ">"], /(le|ge|lt|gt)(?![a-zA-Z0-9_])/y, { le: "<=", ge: ">=", lt: "<", gt: ">" }], [["+", "-"], undefined, {}], [["*", "/", "%"], undefined, {}]];

class Parser {
  private i = 0;
  constructor(private readonly s: string, private readonly limits: VtlLimits, private depth = 0, private readonly origin?: string) {}
  private location(at: number): string { const before = this.s.slice(0, at); return `line ${before.split("\n").length}, column ${at - before.lastIndexOf("\n")}`; }
  private fail(message: string, at = this.i): never { throw new VtlParseError(`Invalid mapping template: ${message} ${this.origin ? `inside the string literal at ${this.origin}` : `at ${this.location(at)}`}`); }
  private enter(): void { if (++this.depth > this.limits.maxDepth) this.fail(`nesting is deeper than ${this.limits.maxDepth} levels`); }
  private match(re: RegExp, at = this.i): string | undefined { re.lastIndex = at; return re.exec(this.s)?.[0]; }
  private refStartAt(at: number): boolean { return this.s[at] === "$" && /^!?\{?[a-zA-Z_]/.test(this.s.slice(at + 1, at + 4)); }
  private directiveAt(at: number): { name: string; end: number; braced: boolean } | undefined { const re = /#(?:\{([a-zA-Z]+)\}|([a-zA-Z][a-zA-Z0-9_]*))/y; re.lastIndex = at; const m = re.exec(this.s); const name = m?.[1] ?? m?.[2]; return m && name && DIRECTIVES.has(name) ? { name, end: re.lastIndex, braced: m[1] !== undefined } : undefined; }
  private gobbleNewline(): void { const m = this.match(/[ \t]*(?:\r\n|\n|\r)/y); if (m) this.i += m.length; }
  private ws(): void { const m = this.match(/\s*/y); if (m) this.i += m.length; }
  private expect(token: string): void { if (!this.s.startsWith(token, this.i)) this.fail(this.i >= this.s.length ? `unexpected end of template, expected '${token}'` : `expected '${token}' but found '${this.s.slice(this.i, this.i + 12)}'`); this.i += token.length; }
  private open(name: string): void { const space = this.match(/[ \t]*/y) ?? ""; if (this.s[this.i + space.length] !== "(") this.fail(`#${name} must be followed by (`); this.i += space.length + 1; }
  private parenExpr(name: string): Expr { this.open(name); const expr = this.parseExpr(); this.ws(); this.expect(")"); return expr; }
  parseTemplate(): Node[] { const { nodes, term } = this.parseNodes(); if (term.kind !== "eof") this.fail(`#${term.kind} without a matching #if or #foreach`, term.at); return nodes; }
  private parseNodes(): { nodes: Node[]; term: Term } {
    const nodes: Node[] = []; let text = ""; const flush = () => { if (text) { nodes.push({ t: "text", v: text }); text = ""; } }; const s = this.s;
    while (this.i < s.length) {
      const special = /[#$\\]/g; special.lastIndex = this.i; const hit = special.exec(s); if (!hit) { text += s.slice(this.i); this.i = s.length; break; } text += s.slice(this.i, hit.index); this.i = hit.index; const c = s[this.i];
      if (c === "\\") { const run = this.match(/\\+/y)!; const j = this.i + run.length; if (this.refStartAt(j)) { flush(); this.i = j; nodes.push({ t: "ref", ref: this.parseRef(false), esc: run.length }); continue; } const escaped = s[j] === "#" ? this.directiveAt(j) : undefined; if (escaped) { text += "\\".repeat(Math.floor(run.length / 2)); if (run.length % 2) { text += s.slice(j, escaped.end); this.i = escaped.end; } else this.i = j; continue; } text += run; this.i = j; continue; }
      if (c === "$") { if (this.refStartAt(this.i)) { flush(); nodes.push({ t: "ref", ref: this.parseRef(false), esc: 0 }); } else { text += "$"; this.i++; } continue; }
      if (s.startsWith("#[[", this.i)) { const end = s.indexOf("]]#", this.i + 3); if (end < 0) this.fail("unclosed #[[ unparsed content ]]#"); text += s.slice(this.i + 3, end); this.i = end + 3; continue; }
      if (s.startsWith("#*", this.i)) { const end = s.indexOf("*#", this.i + 2); if (end < 0) this.fail("unclosed #* block comment *#"); this.i = end + 2; continue; }
      if (s.startsWith("##", this.i)) { const end = s.indexOf("\n", this.i); this.i = end < 0 ? s.length : end + 1; continue; }
      const directive = this.directiveAt(this.i); if (!directive) { text += "#"; this.i++; continue; }
      const at = this.i; const { name } = directive; if (UNSUPPORTED_DIRECTIVES.has(name)) throw new VtlParseError(`The mapping template uses an unsupported VTL directive #${name} (${this.origin ? `inside the string literal at ${this.origin}` : this.location(at)})`);
      if (name === "set") text = text.replace(/[ \t]+$/, ""); flush(); this.i = directive.end;
      if (name === "end" || name === "else") { if (!directive.braced) this.gobbleNewline(); return { nodes, term: { kind: name, at } }; }
      if (name === "elseif") { const cond = this.parenExpr(name); this.gobbleNewline(); return { nodes, term: { kind: "elseif", cond, at } }; }
      if (name === "stop") { if (!directive.braced) this.gobbleNewline(); nodes.push({ t: "stop" }); continue; }
      if (name === "break") { let scope: Ref | undefined; if (s[this.i] === "(") { this.i++; this.ws(); if (!this.refStartAt(this.i)) this.fail("#break expects a scope reference such as $foreach"); scope = this.parseRef(false); this.ws(); this.expect(")"); } if (!directive.braced || scope) this.gobbleNewline(); nodes.push({ t: "break", scope }); continue; }
      if (name === "set") { this.open(name); this.ws(); if (!this.refStartAt(this.i)) this.fail("#set expects a reference on the left-hand side"); const target = this.parseRef(true); if (target.segs.at(-1)?.k === "call") this.fail("#set cannot assign to a method call"); this.ws(); if (s[this.i] !== "=" || s[this.i + 1] === "=") this.fail("#set expects '='"); this.i++; const value = this.parseExpr(); this.ws(); this.expect(")"); this.gobbleNewline(); nodes.push({ t: "set", target, value }); continue; }
      if (name === "foreach") { this.open(name); this.ws(); const variable = this.match(/\$!?\{?[a-zA-Z_][a-zA-Z0-9_]*\}?/y); if (!variable) this.fail("#foreach expects a loop variable such as $item"); this.i += variable.length; this.ws(); if (!this.match(/in(?![a-zA-Z0-9_])/y)) this.fail("#foreach expects 'in'"); this.i += 2; const iter = this.parseExpr(); this.ws(); this.expect(")"); this.gobbleNewline(); this.enter(); const body = this.parseNodes(); this.depth--; if (body.term.kind === "eof") this.fail("#foreach is missing #end", at); if (body.term.kind !== "end") this.fail(`#${body.term.kind} is not allowed directly inside #foreach`, body.term.at); nodes.push({ t: "foreach", name: variable.replace(/[$!{}]/g, ""), iter, body: body.nodes }); continue; }
      const branches: Array<{ cond?: Expr; body: Node[] }> = []; let cond: Expr | undefined = this.parenExpr(name); this.gobbleNewline(); this.enter(); let hasElse = false;
      while (true) { const part = this.parseNodes(); branches.push({ cond, body: part.nodes }); if (part.term.kind === "eof") this.fail("#if is missing #end", at); if (part.term.kind === "end") break; if (hasElse) this.fail(`#${part.term.kind} after #else`, part.term.at); if (part.term.kind === "else") { hasElse = true; cond = undefined; } else cond = part.term.cond; }
      this.depth--; nodes.push({ t: "if", branches });
    }
    flush(); return { nodes, term: { kind: "eof", at: this.i } };
  }
  private parseRef(lhs: boolean): Ref {
    const s = this.s; const start = this.i; this.i++; let quiet = false; if (s[this.i] === "!") { quiet = true; this.i++; } const braced = s[this.i] === "{"; if (braced) this.i++;
    const root = this.match(ID); if (!root) this.fail("invalid reference"); this.i += root.length; const segs: Seg[] = []; this.enter();
    while (true) {
      if (s[this.i] === "." && /[a-zA-Z_]/.test(s[this.i + 1] ?? "")) { this.i++; let name = this.match(lhs ? LHS_ID : ID)!; if (name.includes("-") && s[this.i + name.length] === "(") name = this.match(ID)!; this.i += name.length; if (s[this.i] === "(") segs.push({ k: "call", name, args: this.parseArgs() }); else segs.push({ k: "prop", name }); continue; }
      if (s[this.i] === "[") { this.i++; const expr = this.parseExpr(); this.ws(); this.expect("]"); segs.push({ k: "index", expr }); continue; }
      break;
    }
    this.depth--; if (braced) { if (s[this.i] !== "}") this.fail("expected '}' to close the reference"); this.i++; }
    return { root, segs, quiet, src: s.slice(start, this.i) };
  }
  private parseArgs(): Expr[] { this.expect("("); this.ws(); const args: Expr[] = []; if (this.s[this.i] === ")") { this.i++; return args; } while (true) { args.push(this.parseExpr()); this.ws(); if (this.s[this.i] === ",") { this.i++; continue; } this.expect(")"); return args; } }
  private op(tokens: string[], words?: RegExp): string | undefined { this.ws(); const s = this.s; for (const token of tokens) if (s.startsWith(token, this.i) && !(token.length === 1 && "!<>".includes(token) && s[this.i + 1] === "=")) { this.i += token.length; return token; } const word = words && this.match(words); if (word) { this.i += word.length; return word; } return undefined; }
  parseExpr(): Expr { this.enter(); const expr = this.binary(0); this.depth--; return expr; }
  private binary(level: number): Expr {
    if (level >= OPERATORS.length) return this.unary(); const [tokens, words, aliases] = OPERATORS[level]; let left = this.binary(level + 1);
    while (true) { const save = this.i; const found = this.op(tokens, words); if (!found) { this.i = save; return left; } left = { t: "bin", op: aliases[found] ?? found, l: left, r: this.binary(level + 1) }; }
  }
  private unary(): Expr { const save = this.i; if (this.op(["!"], /(not)(?![a-zA-Z0-9_])/y)) { this.enter(); const e = this.unary(); this.depth--; return { t: "not", e }; } this.i = save; this.ws(); if (this.s[this.i] === "-" && !/\d/.test(this.s[this.i + 1] ?? "")) { this.i++; this.enter(); const e = this.unary(); this.depth--; return { t: "neg", e }; } return this.primary(); }
  private primary(): Expr {
    this.ws(); const s = this.s; const c = s[this.i];
    if (c === "$") { if (!this.refStartAt(this.i)) this.fail("invalid reference"); return { t: "ref", ref: this.parseRef(false) }; }
    if (c === '"' || c === "'") return this.stringLiteral();
    const number = this.match(/-?\d+(?:\.\d+)?/y); if (number) { this.i += number.length; return { t: "lit", v: Number(number) }; }
    if (c === "(") { this.i++; const e = this.parseExpr(); this.ws(); this.expect(")"); return e; }
    if (c === "[") { this.i++; this.ws(); if (s[this.i] === "]") { this.i++; return { t: "list", items: [] }; } const first = this.parseExpr(); this.ws(); if (s.startsWith("..", this.i)) { this.i += 2; const to = this.parseExpr(); this.ws(); this.expect("]"); return { t: "range", from: first, to }; } const items = [first]; while (true) { this.ws(); if (s[this.i] === ",") { this.i++; items.push(this.parseExpr()); continue; } this.expect("]"); return { t: "list", items }; } }
    if (c === "{") { this.i++; this.ws(); const entries: Array<[Expr, Expr]> = []; if (s[this.i] === "}") { this.i++; return { t: "map", entries }; } while (true) { const key = this.parseExpr(); this.ws(); this.expect(":"); entries.push([key, this.parseExpr()]); this.ws(); if (s[this.i] === ",") { this.i++; continue; } this.expect("}"); return { t: "map", entries }; } }
    const word = this.match(/(true|false|null)(?![a-zA-Z0-9_])/y); if (word) { this.i += word.length; return { t: "lit", v: word === "true" ? true : word === "false" ? false : null }; }
    return this.fail(this.i >= s.length ? "unexpected end of expression" : `unexpected '${s.slice(this.i, this.i + 12)}' in expression`);
  }
  private stringLiteral(): Expr {
    // Velocity 1.7: backslashes are not escape characters inside string literals (they only keep \" from ending a double-quoted string); a doubled quote is a literal quote.
    const s = this.s; const quote = s[this.i]; const start = this.i; let j = this.i + 1; let raw = "";
    while (true) { if (j >= s.length) this.fail("unterminated string literal", start); const ch = s[j]; if (ch === "\\" && quote === '"' && j + 1 < s.length) { raw += ch + s[j + 1]; j += 2; continue; } if (ch === quote) { if (s[j + 1] === quote) { raw += quote; j += 2; continue; } break; } raw += ch; j++; }
    this.i = j + 1; const value = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (quote === "'" || !/[$#]/.test(value)) return { t: "lit", v: value };
    return { t: "str", nodes: new Parser(value, this.limits, this.depth + 1, this.origin ?? this.location(start)).parseTemplate() };
  }
}

// ---- value model ----
const jsonLists = new WeakSet<object>();
abstract class Host { abstract readonly typeName: string; abstract get(name: string): unknown; abstract call(name: string, args: unknown[]): unknown }
const fail = (message: string): never => { throw new VtlTemplateError(message); };
const unsupported = (name: string, type: string): never => fail(`Unsupported VTL method ${name}() on ${type}`);
function arity(name: string, args: unknown[], min: number, max = min): void { if (args.length < min || args.length > max) fail(`${name}() expects ${min === max ? min : `${min} to ${max}`} argument(s) but received ${args.length}`); }
class MapEntry extends Host { readonly typeName = "Map.Entry"; constructor(readonly key: string, readonly value: unknown) { super(); } get(name: string): unknown { return name === "key" ? this.key : name === "value" ? this.value : null; } call(name: string, args: unknown[]): unknown { if (name !== "getKey" && name !== "getValue") return unsupported(name, this.typeName); arity(name, args, 0); return name === "getKey" ? this.key : this.value; } }
class LoopScope extends Host {
  readonly typeName = "$foreach"; index = 0; total = 0;
  constructor(readonly parent: LoopScope | null) { super(); }
  get(name: string): unknown { switch (name) { case "index": return this.index; case "count": return this.index + 1; case "hasNext": return this.index + 1 < this.total; case "first": return this.index === 0; case "last": return this.index + 1 === this.total; case "parent": return this.parent; case "topmost": { let top: LoopScope = this; while (top.parent) top = top.parent; return top; } case "depth": { let depth = 1; for (let p = this.parent; p; p = p.parent) depth++; return depth; } default: return null; } }
  call(name: string, args: unknown[]): unknown { const map: Record<string, string> = { getIndex: "index", getCount: "count", hasNext: "hasNext", isFirst: "first", isLast: "last", getParent: "parent", getTopmost: "topmost", getDepth: "depth" }; if (!Object.hasOwn(map, name)) return unsupported(name, this.typeName); arity(name, args, 0); return this.get(map[name]); }
}
function isMap(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function isList(value: unknown): value is unknown[] { return Array.isArray(value); }
function checkKey(key: string): string { if (BLOCKED_KEYS.has(key)) fail(`Access to '${key}' is not allowed in a mapping template`); return key; }
function norm(value: unknown): unknown { if (value === undefined || value === null) return null; const type = typeof value; if (type === "string" || type === "number" || type === "boolean") return value; if (type !== "object") return null; return isList(value) || isMap(value) || value instanceof Host ? value : null; }
function ownValue(object: object, key: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(object, key); return descriptor && "value" in descriptor ? norm(descriptor.value) : null; }
function own(object: object, key: string): unknown { return ownValue(object, checkKey(key)); }
function typeName(value: unknown): string { return value === null ? "null" : typeof value === "string" ? "String" : typeof value === "number" ? (Number.isInteger(value) ? "Integer" : "Double") : typeof value === "boolean" ? "Boolean" : isList(value) ? "List" : isMap(value) ? "Map" : value instanceof Host ? value.typeName : "Object"; }
function tagJson(value: unknown, depth = 0): unknown { if (depth > 512) fail("JSON value is nested too deeply"); if (isList(value)) { jsonLists.add(value); value.forEach(item => tagJson(item, depth + 1)); } else if (isMap(value)) for (const key of Object.keys(value)) tagJson(ownValue(value, key), depth + 1); return value; }
function javaDouble(value: number): string { if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity"; const text = String(value); if (!text.includes("e")) return text; const [mantissa, exponent] = text.split("e"); return `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}E${Number(exponent)}`; }
const RENDER_DEPTH = 256;
function toJsonText(value: unknown, depth = 0): string {
  if (depth > RENDER_DEPTH) fail("A value is nested too deeply to render");
  if (value === null || value === undefined) return "null"; if (typeof value === "string") return JSON.stringify(value); if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"; if (typeof value === "boolean") return String(value);
  if (value instanceof MapEntry) return `{${JSON.stringify(value.key)}:${toJsonText(value.value, depth + 1)}}`; if (isList(value)) return `[${value.map(item => toJsonText(norm(item), depth + 1)).join(",")}]`;
  if (isMap(value)) return `{${Object.keys(value).map(key => `${JSON.stringify(key)}:${toJsonText(ownValue(value, key), depth + 1)}`).join(",")}}`; return "null";
}
/** Java toString(): Maps render as {k=v, k2=v2}; JSON arrays from $input.path/$util.parseJson render as compact JSON; VTL lists render as [a, b]. */
function toJava(value: unknown, depth = 0): string {
  if (depth > RENDER_DEPTH) fail("A value is nested too deeply to render");
  if (value === null || value === undefined) return "null"; if (typeof value === "string") return value; if (typeof value === "number") return Number.isInteger(value) ? String(value) : javaDouble(value); if (typeof value === "boolean") return String(value);
  if (value instanceof MapEntry) return `${value.key}=${toJava(value.value, depth + 1)}`; if (value instanceof Host) return "";
  if (isList(value)) return jsonLists.has(value) ? toJsonText(value, depth) : `[${value.map(item => toJava(norm(item), depth + 1)).join(", ")}]`;
  if (isMap(value)) return `{${Object.keys(value).map(key => `${key}=${toJava(ownValue(value, key), depth + 1)}`).join(", ")}}`; return "";
}
function javaEquals(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > RENDER_DEPTH) fail("A value is nested too deeply to compare"); if (a === null || b === null) return a === b; if (typeof a !== typeof b) return false; if (typeof a !== "object") return a === b;
  if (isList(a)) return isList(b) && a.length === b.length && a.every((item, index) => javaEquals(norm(item), norm(b[index]), depth + 1));
  if (isMap(a)) { if (!isMap(b)) return false; const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && javaEquals(ownValue(a, key), ownValue(b, key), depth + 1)); }
  if (a instanceof MapEntry) return b instanceof MapEntry && a.key === b.key && javaEquals(a.value, b.value, depth + 1); return a === b;
}
// Velocity 1.7 ==: numbers compare numerically, same classes use equals(), different classes compare their toString() values.
function velocityEquals(a: unknown, b: unknown): boolean { if (a === null || b === null) return a === b; if (typeof a === "number" && typeof b === "number") return a === b; if (typeName(a) === typeName(b)) return javaEquals(a, b); return toJava(a) === toJava(b); }
function truthy(value: unknown): boolean { return value !== null && value !== undefined && value !== false; }
function str(name: string, value: unknown): string { if (typeof value !== "string") fail(`${name}() expects a String argument but received ${typeName(value)}`); return value as string; }
function int(name: string, value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value)) fail(`${name}() expects an Integer argument but received ${typeName(value)}`); return value as number; }
function mapKey(value: unknown): string { if (value === null || value === undefined) return "null"; if (typeof value === "object") fail(`Map keys must be strings, numbers or booleans, not ${typeName(value)}`); return checkKey(toJava(value)); }

// ---- Java regular expressions (java.util.regex mapped onto JS RegExp) ----
const regexCache = new Map<string, RegExp>();
const POSIX: Record<string, string> = { Lower: "a-z", Upper: "A-Z", ASCII: "\\x00-\\x7F", Alpha: "a-zA-Z", Digit: "0-9", Alnum: "a-zA-Z0-9", Punct: "!-\\/:-@\\[-`{-~", Graph: "!-~", Print: " -~", Blank: " \\t", Cntrl: "\\x00-\\x1F\\x7F", XDigit: "0-9a-fA-F", Space: " \\t\\n\\x0B\\f\\r" };
function javaRegex(source: string, mode: "global" | "full"): RegExp {
  const cacheKey = `${mode}:${source}`; const cached = regexCache.get(cacheKey); if (cached) { cached.lastIndex = 0; return cached; }
  let flags = ""; let src = source; const inline = /^\(\?([a-zA-Z]+)\)/.exec(src); if (inline) { for (const flag of inline[1]) { if ("ims".includes(flag)) flags += flags.includes(flag) ? "" : flag; else if (flag !== "u" && flag !== "d") fail(`Unsupported regular expression flag (?${flag})`); } src = src.slice(inline[0].length); }
  let out = ""; let inClass = false; let unicode = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { const n = src[i + 1] ?? ""; if (n === "Q") { const end = src.indexOf("\\E", i + 2); out += (end < 0 ? src.slice(i + 2) : src.slice(i + 2, end)).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"); i = end < 0 ? src.length : end + 1; continue; } if (!inClass && n === "A") { out += "^"; i++; continue; } if (!inClass && (n === "z" || n === "Z")) { out += "$"; i++; continue; } if (n === "p" || n === "P") { const name = /^\{(?:Is)?(\w+)\}/.exec(src.slice(i + 2)); if (name && POSIX[name[1]]) { if (n === "P" && inClass) fail("Unsupported regular expression construct \\P{...} inside a character class"); out += inClass ? POSIX[name[1]] : `[${n === "P" ? "^" : ""}${POSIX[name[1]]}]`; i += 1 + name[0].length; continue; } unicode = true; } out += c + n; i++; continue; }
    if (c === "[" && !inClass) inClass = true; else if (c === "]" && inClass) inClass = false; out += c;
  }
  let regex: RegExp; try { regex = new RegExp(mode === "full" ? `^(?:${out})$` : out, `${flags}${mode === "global" ? "g" : ""}${unicode ? "u" : ""}`); } catch { return fail(`Invalid or unsupported regular expression '${source.slice(0, 80)}'`); }
  if (regexCache.size > 256) regexCache.clear(); regexCache.set(cacheKey, regex); return regex;
}
function javaReplacement(replacement: string, match: string, groups: Array<string | undefined>, named?: Record<string, string | undefined>): string {
  let out = "";
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i];
    if (c === "\\") { if (i + 1 >= replacement.length) fail("The replacement string ends with an escape character"); out += replacement[++i]; continue; }
    if (c !== "$") { out += c; continue; }
    if (replacement[i + 1] === "{") { const end = replacement.indexOf("}", i); const name = end < 0 ? "" : replacement.slice(i + 2, end); if (!named || !Object.hasOwn(named, name)) fail(`No group with name {${name}}`); out += named![name] ?? ""; i = end; continue; }
    const first = replacement[i + 1]; if (!first || !/\d/.test(first)) fail("Illegal group reference in the replacement string"); let group = Number(first); i++; while (/\d/.test(replacement[i + 1] ?? "") && group * 10 + Number(replacement[i + 1]) <= groups.length) group = group * 10 + Number(replacement[++i]); if (group > groups.length) fail(`No group ${group}`); out += group === 0 ? match : groups[group - 1] ?? "";
  }
  return out;
}
function javaReplace(s: string, regex: RegExp, replacement: string, all: boolean): string { const pattern = all ? regex : new RegExp(regex.source, regex.flags.replace("g", "")); return s.replace(pattern, (...parts: unknown[]) => { const named = typeof parts.at(-1) === "object" && parts.at(-1) !== null ? parts.pop() as Record<string, string | undefined> : undefined; parts.pop(); parts.pop(); const [match, ...groups] = parts as Array<string | undefined>; return javaReplacement(replacement, match ?? "", groups, named); }); }
function javaSplit(s: string, regex: RegExp, limit: number): string[] {
  const out: string[] = []; let last = 0; let matched = false; regex.lastIndex = 0; let m: RegExpExecArray | null;
  while ((limit <= 0 || out.length < limit - 1) && (m = regex.exec(s))) { if (m[0].length === 0) { if (m.index >= s.length) break; regex.lastIndex++; if (m.index === 0) continue; } matched = true; out.push(s.slice(last, m.index)); last = m.index + m[0].length; }
  if (!matched) return [s]; out.push(s.slice(last)); if (limit === 0) while (out.length && out[out.length - 1] === "") out.pop(); return out;
}

// ---- $util ----
function escapeJavaScript(s: string): string { let out = ""; for (let i = 0; i < s.length; i++) { const code = s.charCodeAt(i); const ch = s[i]; if (code > 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`; else if (code < 32) out += ({ 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" } as Record<number, string>)[code] ?? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`; else out += ch === "'" ? "\\'" : ch === '"' ? '\\"' : ch === "\\" ? "\\\\" : ch === "/" ? "\\/" : ch; } return out; }
function urlEncode(s: string): string { try { return encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()~]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`); } catch { return fail("$util.urlEncode received a malformed string"); } }
function urlDecode(s: string): string { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return fail("$util.urlDecode received a malformed URL-encoded string"); } }
function base64Decode(s: string): string { const compact = s.replace(/[\r\n]/g, ""); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.replace(/=+$/, "").length % 4 === 1) fail("$util.base64Decode received a string that is not valid base64"); return Buffer.from(compact, "base64").toString("utf8"); }
function parseJsonText(text: string, what: string): unknown { let parsed: unknown; try { parsed = JSON.parse(text); } catch { return fail(`${what} is not valid JSON`); } return tagJson(norm(parsed)); }
class UtilHost extends Host {
  readonly typeName = "$util";
  constructor(private readonly guard: (s: string) => string) { super(); }
  get(): unknown { return null; }
  call(name: string, args: unknown[]): unknown {
    const text = () => { arity(name, args, 1); if (args[0] === null) fail(`$util.${name}() received a null argument`); return toJava(args[0]); };
    switch (name) {
      case "escapeJavaScript": arity(name, args, 1); return this.guard(escapeJavaScript(toJava(args[0])));
      case "parseJson": return parseJsonText(text(), "The $util.parseJson argument");
      case "urlEncode": return this.guard(urlEncode(text()));
      case "urlDecode": return urlDecode(text());
      case "base64Encode": return this.guard(Buffer.from(text(), "utf8").toString("base64"));
      case "base64Decode": return base64Decode(text());
      default: return unsupported(name, "$util");
    }
  }
}

// ---- $input ----
const MISSING = Symbol("missing");
function jsonPath(root: unknown, expression: string): unknown {
  let path = expression.trim(); if (!path.startsWith("$")) path = path.startsWith("[") ? `$${path}` : `$.${path}`;
  let nodes: unknown[] = [root]; let definite = true; let i = 1;
  const children = (value: unknown): unknown[] => isList(value) ? value.map(norm) : isMap(value) ? Object.keys(value).map(key => ownValue(value, key)) : [];
  const field = (value: unknown, key: string): unknown => { checkKey(key); return isMap(value) && Object.hasOwn(value, key) ? ownValue(value, key) : MISSING; };
  const deep = (value: unknown, key: string, out: unknown[], depth = 0): void => { if (depth > 512) fail("JSON value is nested too deeply"); if (key === "*") out.push(...children(value)); else { const found = field(value, key); if (found !== MISSING) out.push(found); } for (const child of children(value)) if (child !== null && typeof child === "object") deep(child, key, out, depth + 1); };
  const bad = (): never => fail(`Invalid JSONPath expression '${expression.slice(0, 80)}'`);
  const keep = (node: unknown) => node !== MISSING || definite;
  while (i < path.length) {
    if (path.startsWith("..", i)) { i += 2; definite = false; let key: string; const name = /^(\*|[^.[\]\s]+)/.exec(path.slice(i)); if (name) { key = name[1]; i += name[0].length; } else { const quoted = /^\[\s*(['"])(.*?)\1\s*\]/.exec(path.slice(i)); if (!quoted) return bad(); key = quoted[2]; i += quoted[0].length; } const out: unknown[] = []; for (const node of nodes) deep(node, key, out); nodes = out; continue; }
    if (path[i] === ".") { i++; const name = /^(\*|[^.[\]\s]+)/.exec(path.slice(i)); if (!name) return bad(); i += name[0].length; if (name[1] === "*") { definite = false; nodes = nodes.flatMap(children); } else nodes = nodes.map(node => field(node, name[1])).filter(keep); continue; }
    if (path[i] !== "[") return bad();
    const close = path.indexOf("]", i); if (close < 0) return bad(); const inner = path.slice(i + 1, close).trim(); i = close + 1;
    if (inner.startsWith("?")) fail("JSONPath filter expressions are not supported in StackSim mapping templates");
    if (inner === "*") { definite = false; nodes = nodes.flatMap(children); continue; }
    const names = [...inner.matchAll(/\s*(['"])(.*?)\1\s*(?:,|$)/g)]; if (names.length && names.map(m => m[0]).join("") === inner) { if (names.length > 1) definite = false; nodes = nodes.flatMap(node => names.map(m => field(node, m[2]))).filter(keep); continue; }
    const slice = /^(-?\d*)\s*:\s*(-?\d*)$/.exec(inner); if (slice) { definite = false; nodes = nodes.flatMap(node => { if (!isList(node)) return []; const from = slice[1] === "" ? 0 : Number(slice[1]); const to = slice[2] === "" ? node.length : Number(slice[2]); return node.slice(from < 0 ? Math.max(0, node.length + from) : from, to < 0 ? Math.max(0, node.length + to) : to).map(norm); }); continue; }
    if (!/^-?\d+(\s*,\s*-?\d+)*$/.test(inner)) return bad(); const indexes = inner.split(",").map(Number); if (indexes.length > 1) definite = false;
    nodes = nodes.flatMap(node => indexes.map(index => { if (!isList(node)) return MISSING; const at = index < 0 ? node.length + index : index; return at >= 0 && at < node.length ? norm(node[at]) : MISSING; })).filter(keep);
  }
  if (!definite) { const list = nodes.filter(node => node !== MISSING); jsonLists.add(list); return list; } return nodes.length ? nodes[0] : MISSING;
}
class InputHost extends Host {
  readonly typeName = "$input"; private parsed: unknown = MISSING; private paramMap?: Record<string, Record<string, unknown>>; private readonly body: string;
  // An empty payload is exposed as "{}" (so $input.body and $input.json('$') render {}), matching API Gateway.
  constructor(private readonly source: VtlContext, private readonly guard: (s: string) => string) { super(); this.body = source.body === "" || source.body === undefined || source.body === null ? "{}" : String(source.body); }
  private copy(map: Record<string, string> | undefined): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const key of Object.keys(map ?? {})) if (!BLOCKED_KEYS.has(key)) { const value = ownValue(map!, key); if (value !== null) out[key] = typeof value === "string" ? value : toJava(value); } return out; }
  private params(): Record<string, Record<string, unknown>> { return this.paramMap ??= { header: this.copy(this.source.headers), querystring: this.copy(this.source.query), path: this.copy(this.source.path) }; }
  private document(): unknown { if (this.parsed === MISSING) this.parsed = parseJsonText(this.body, "The payload used by $input.path/$input.json"); return this.parsed; }
  get(name: string): unknown { return name === "body" ? this.body : name === "params" ? this.params() : null; }
  call(name: string, args: unknown[]): unknown {
    // A missing (or null) JSONPath match yields "" from $input.path and the JSON string "" from $input.json, as API Gateway does.
    if (name === "json" || name === "path") { arity(name, args, 1); const value = jsonPath(this.document(), str(name, args[0])); if (name === "path") return value === MISSING || value === null ? "" : value; return this.guard(value === MISSING || value === null ? '""' : toJsonText(value)); }
    if (name === "params") { arity(name, args, 0, 1); if (!args.length) return this.params(); const key = str(name, args[0]); const { path, querystring, header } = this.params(); if (Object.hasOwn(path, key)) return path[key]; if (Object.hasOwn(querystring, key)) return querystring[key]; const headerName = Object.keys(header).find(item => item.toLowerCase() === key.toLowerCase()); return headerName === undefined ? "" : header[headerName]; }
    return unsupported(name, "$input");
  }
}

// ---- interpreter ----
class StopSignal {}
class BreakSignal { constructor(readonly target?: LoopScope) {} }
class Interpreter {
  private readonly scope = new Map<string, unknown>(); private iterations = 0; private steps = 0; private readonly overrideLabels = new Map<object, string>(); private readonly overridden = new Map<object, Set<string>>();
  constructor(source: VtlContext, private readonly limits: VtlLimits) {
    const guard = (s: string) => this.guard(s); const context: Record<string, unknown> = isMap(source.context) ? source.context : {};
    const ensure = (object: Record<string, unknown>, key: string): Record<string, unknown> => { const current = ownValue(object, key); if (isMap(current)) return current; const created: Record<string, unknown> = {}; object[key] = created; return created; };
    const response = ensure(context, "responseOverride"); const request = ensure(context, "requestOverride"); this.overrideLabels.set(response, "responseOverride"); this.overrideLabels.set(ensure(response, "header"), "responseOverride.header"); for (const part of ["header", "querystring", "path"]) this.overrideLabels.set(ensure(request, part), `requestOverride.${part}`);
    const stageVariables: Record<string, unknown> = {}; for (const key of Object.keys(source.stageVariables ?? {})) if (!BLOCKED_KEYS.has(key)) stageVariables[key] = ownValue(source.stageVariables, key);
    this.scope.set("input", new InputHost(source, guard)); this.scope.set("util", new UtilHost(guard)); this.scope.set("context", context); this.scope.set("stageVariables", stageVariables);
  }
  run(nodes: Node[]): string { const parts: string[] = []; try { this.exec(nodes, { parts, length: 0, max: this.limits.maxOutputLength, what: "output" }); } catch (error) { if (!(error instanceof StopSignal || error instanceof BreakSignal)) throw error; } return parts.join(""); }
  private guard(s: string): string { if (s.length > this.limits.maxStringLength) fail(`A mapping template string exceeded the maximum length of ${this.limits.maxStringLength} characters`); return s; }
  private step(): void { if (++this.steps > this.limits.maxSteps) fail(`The mapping template exceeded the maximum of ${this.limits.maxSteps} evaluation steps`); }
  private collection<T extends unknown[] | Record<string, unknown>>(value: T): T { if ((isList(value) ? value.length : Object.keys(value).length) > this.limits.maxCollectionSize) fail(`A mapping template collection exceeded the maximum of ${this.limits.maxCollectionSize} elements`); return value; }
  private emit(sink: Sink, text: string): void { if (!text) return; sink.length += text.length; if (sink.length > sink.max) fail(sink.what === "output" ? `The mapping template output exceeded the maximum of ${sink.max} characters` : `A mapping template string exceeded the maximum length of ${sink.max} characters`); sink.parts.push(text); }
  private exec(nodes: Node[], sink: Sink): void {
    for (const node of nodes) {
      this.step();
      switch (node.t) {
        case "text": this.emit(sink, node.v); break;
        case "ref": { const value = this.ref(node.ref); const slashes = node.esc; if (value === null || value instanceof Host && !(value instanceof MapEntry)) this.emit(sink, "\\".repeat(slashes) + (node.ref.quiet && slashes % 2 === 0 ? "" : node.ref.src)); else this.emit(sink, "\\".repeat(Math.floor(slashes / 2)) + (slashes % 2 ? node.ref.src : toJava(value))); break; }
        case "set": this.assign(node.target, this.eval(node.value)); break;
        case "if": for (const branch of node.branches) if (!branch.cond || truthy(this.eval(branch.cond))) { this.exec(branch.body, sink); break; } break;
        case "foreach": this.foreach(node, sink); break;
        case "break": { const target = node.scope ? this.ref(node.scope) : undefined; throw new BreakSignal(target instanceof LoopScope ? target : undefined); }
        case "stop": throw new StopSignal();
      }
    }
  }
  private foreach(node: Extract<Node, { t: "foreach" }>, sink: Sink): void {
    const source = this.eval(node.iter); const items = isList(source) ? source.map(norm) : isMap(source) ? Object.keys(source).map(key => ownValue(source, key)) : [];
    const saved = [node.name, "foreach", "velocityCount", "velocityHasNext"].map(key => [key, this.scope.has(key), this.scope.get(key)] as const); const parent = this.scope.get("foreach"); const loop = new LoopScope(parent instanceof LoopScope ? parent : null); loop.total = items.length;
    try {
      for (let index = 0; index < items.length; index++) {
        if (++this.iterations > this.limits.maxForeachIterations) fail(`The mapping template exceeded the maximum of ${this.limits.maxForeachIterations} #foreach iterations`);
        loop.index = index; if (items[index] === null) this.scope.delete(node.name); else this.scope.set(node.name, items[index]); this.scope.set("foreach", loop); this.scope.set("velocityCount", index + 1); this.scope.set("velocityHasNext", index + 1 < items.length);
        try { this.exec(node.body, sink); } catch (error) { if (error instanceof BreakSignal && (!error.target || error.target === loop)) break; throw error; }
      }
    } finally { for (const [key, had, value] of saved) if (had) this.scope.set(key, value); else this.scope.delete(key); }
  }
  private assign(target: Ref, value: unknown): void {
    if (value === null || value === undefined) return; // Velocity 1.7: a null right-hand side leaves the left-hand side unchanged.
    const last = target.segs.at(-1); if (!last) { this.scope.set(target.root, value); return; }
    if (last.k === "call") return fail("#set cannot assign to a method call"); if (last.k === "prop" && BLOCKED_MEMBERS.has(last.name)) fail(`Access to '${last.name}' is not allowed in a mapping template`);
    const key = last.k === "prop" ? checkKey(last.name) : this.eval(last.expr); if (typeof key === "string") checkKey(key);
    const object = this.ref(target, target.segs.length - 1); if (object === null) return;
    if (isMap(object)) { const name = mapKey(key); const label = this.overrideLabels.get(object); if (label) { const done = this.overridden.get(object) ?? new Set<string>(); if (done.has(name)) fail(`$context.${label}.${name} can only be overridden once per mapping template`); done.add(name); this.overridden.set(object, done); } object[name] = value; this.collection(object); return; }
    if (isList(object) && last.k === "index") { const index = int("[]", key); const at = index < 0 ? object.length + index : index; if (at < 0 || at >= object.length) fail(`Index ${index} is out of bounds for a list of size ${object.length}`); object[at] = value; return; }
    fail(`Cannot #set ${target.src} because its target is a ${typeName(object)}`);
  }
  private ref(ref: Ref, upto = ref.segs.length): unknown {
    let value = this.scope.has(ref.root) ? norm(this.scope.get(ref.root)) : null;
    for (let index = 0; index < upto; index++) {
      const seg = ref.segs[index]; this.step();
      if (seg.k === "index") { const key = this.eval(seg.expr); if (typeof key === "string") checkKey(key); value = value === null ? null : this.index(value, key); continue; }
      checkKey(seg.name); if (BLOCKED_MEMBERS.has(seg.name)) fail(`Access to '${seg.name}' is not allowed in a mapping template`);
      if (seg.k === "prop") value = value === null ? null : this.property(value, seg.name);
      else value = value === null ? null : norm(this.call(value, seg.name, seg.args.map(arg => this.eval(arg))));
    }
    return value;
  }
  private property(value: unknown, name: string): unknown { if (isMap(value)) return own(value, name); if (value instanceof Host) return norm(value.get(name)); if (name === "empty" && (typeof value === "string" || isList(value))) return value.length === 0; return null; }
  private index(value: unknown, key: unknown): unknown { if (isList(value)) { const index = int("[]", key); const at = index < 0 ? value.length + index : index; if (at < 0 || at >= value.length) fail(`Index ${index} is out of bounds for a list of size ${value.length}`); return norm(value[at]); } if (isMap(value)) return own(value, mapKey(key)); if (value instanceof Host && typeof key === "string") return norm(value.get(key)); return fail(`A ${typeName(value)} cannot be indexed with []`); }
  private call(value: unknown, name: string, args: unknown[]): unknown {
    const plain = !(value instanceof Host) || value instanceof MapEntry;
    if (name === "toString" && plain) { arity(name, args, 0); return this.guard(toJava(value)); }
    if (name === "equals" && plain) { arity(name, args, 1); return javaEquals(value, args[0]); }
    if (typeof value === "string") return this.stringMethod(value, name, args);
    if (isList(value)) return this.listMethod(value, name, args);
    if (isMap(value)) return this.mapMethod(value, name, args);
    if (value instanceof Host) return value.call(name, args);
    if (typeof value === "number" && ["intValue", "longValue", "doubleValue"].includes(name)) { arity(name, args, 0); return name === "doubleValue" ? value : Math.trunc(value); }
    if (typeof value === "boolean" && name === "booleanValue") { arity(name, args, 0); return value; }
    return unsupported(name, typeName(value));
  }
  private stringMethod(s: string, name: string, args: unknown[]): unknown {
    const a = (index: number) => str(name, args[index]); const n = (index: number) => int(name, args[index]);
    switch (name) {
      case "length": arity(name, args, 0); return s.length;
      case "isEmpty": arity(name, args, 0); return s.length === 0;
      case "equalsIgnoreCase": arity(name, args, 1); return typeof args[0] === "string" && (s.toUpperCase() === args[0].toUpperCase() || s.toLowerCase() === args[0].toLowerCase());
      case "contains": arity(name, args, 1); return s.includes(a(0));
      case "startsWith": { arity(name, args, 1, 2); const offset = args.length > 1 ? n(1) : 0; return offset >= 0 && offset <= s.length && s.startsWith(a(0), offset); }
      case "endsWith": arity(name, args, 1); return s.endsWith(a(0));
      case "indexOf": arity(name, args, 1, 2); return s.indexOf(a(0), args.length > 1 ? Math.max(0, n(1)) : 0);
      case "lastIndexOf": arity(name, args, 1, 2); return args.length > 1 ? (n(1) < 0 ? -1 : s.lastIndexOf(a(0), n(1))) : s.lastIndexOf(a(0));
      case "replace": { arity(name, args, 2); const target = a(0); const replacement = a(1); return this.guard(s.replaceAll(target, () => replacement)); }
      case "replaceAll": arity(name, args, 2); return this.guard(javaReplace(s, javaRegex(a(0), "global"), a(1), true));
      case "replaceFirst": arity(name, args, 2); return this.guard(javaReplace(s, javaRegex(a(0), "global"), a(1), false));
      case "matches": arity(name, args, 1); return javaRegex(a(0), "full").test(s);
      case "split": arity(name, args, 1, 2); return this.collection(javaSplit(s, javaRegex(a(0), "global"), args.length > 1 ? n(1) : 0));
      case "substring": { arity(name, args, 1, 2); const begin = n(0); const end = args.length > 1 ? n(1) : s.length; if (begin < 0 || end > s.length || begin > end) fail(`String index out of range: begin ${begin}, end ${end}, length ${s.length}`); return s.slice(begin, end); }
      case "charAt": { arity(name, args, 1); const index = n(0); if (index < 0 || index >= s.length) fail(`String index out of range: ${index}`); return s[index]; }
      case "toLowerCase": arity(name, args, 0); return s.toLowerCase();
      case "toUpperCase": arity(name, args, 0); return s.toUpperCase();
      case "trim": arity(name, args, 0); return s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
      case "concat": arity(name, args, 1); return this.guard(s + a(0));
      case "compareTo": { arity(name, args, 1); const other = a(0); for (let i = 0; i < Math.min(s.length, other.length); i++) if (s.charCodeAt(i) !== other.charCodeAt(i)) return s.charCodeAt(i) - other.charCodeAt(i); return s.length - other.length; }
      default: return unsupported(name, "String");
    }
  }
  private listMethod(list: unknown[], name: string, args: unknown[]): unknown {
    const at = (index: number, size = list.length) => { if (index < 0 || index >= size) fail(`Index ${index} is out of bounds for a list of size ${list.length}`); return index; };
    const find = (from: number, step: number) => { for (let i = from; i >= 0 && i < list.length; i += step) if (javaEquals(norm(list[i]), args[0])) return i; return -1; };
    switch (name) {
      case "get": arity(name, args, 1); return norm(list[at(int(name, args[0]))]);
      case "size": arity(name, args, 0); return list.length;
      case "isEmpty": arity(name, args, 0); return list.length === 0;
      case "contains": arity(name, args, 1); return find(0, 1) >= 0;
      case "indexOf": arity(name, args, 1); return find(0, 1);
      case "lastIndexOf": arity(name, args, 1); return find(list.length - 1, -1);
      case "add": arity(name, args, 1, 2); if (args.length === 1) list.push(args[0]); else list.splice(at(int(name, args[0]), list.length + 1), 0, args[1]); this.collection(list); return args.length === 1 ? true : null;
      case "addAll": arity(name, args, 1); if (!isList(args[0])) fail("addAll() expects a List argument"); list.push(...(args[0] as unknown[])); this.collection(list); return true;
      case "set": { arity(name, args, 2); const index = at(int(name, args[0])); const previous = norm(list[index]); list[index] = args[1]; return previous; }
      case "remove": { arity(name, args, 1); if (typeof args[0] === "number" && Number.isInteger(args[0])) return norm(list.splice(at(args[0]), 1)[0]); const index = find(0, 1); if (index >= 0) list.splice(index, 1); return index >= 0; }
      case "clear": arity(name, args, 0); list.length = 0; return null;
      case "subList": { arity(name, args, 2); const from = int(name, args[0]); const to = int(name, args[1]); if (from < 0 || to > list.length || from > to) fail(`subList(${from}, ${to}) is out of bounds for a list of size ${list.length}`); return list.slice(from, to); }
      default: return unsupported(name, "List");
    }
  }
  private mapMethod(map: Record<string, unknown>, name: string, args: unknown[]): unknown {
    switch (name) {
      case "get": arity(name, args, 1); return own(map, mapKey(args[0]));
      case "getOrDefault": { arity(name, args, 2); const key = mapKey(args[0]); return Object.hasOwn(map, key) ? ownValue(map, key) : args[1]; }
      case "put": { arity(name, args, 2); const key = mapKey(args[0]); const previous = ownValue(map, key); map[key] = args[1]; this.collection(map); return previous; }
      case "putAll": { arity(name, args, 1); const other = args[0]; if (!isMap(other)) return fail("putAll() expects a Map argument"); for (const key of Object.keys(other)) map[checkKey(key)] = ownValue(other, key); this.collection(map); return null; }
      case "containsKey": arity(name, args, 1); return Object.hasOwn(map, mapKey(args[0]));
      case "containsValue": arity(name, args, 1); return Object.keys(map).some(key => javaEquals(ownValue(map, key), args[0]));
      case "remove": { arity(name, args, 1); const key = mapKey(args[0]); const previous = ownValue(map, key); delete map[key]; return previous; }
      case "keySet": arity(name, args, 0); return Object.keys(map);
      case "values": arity(name, args, 0); return Object.keys(map).map(key => ownValue(map, key));
      case "entrySet": arity(name, args, 0); return Object.keys(map).map(key => new MapEntry(key, ownValue(map, key)));
      case "size": arity(name, args, 0); return Object.keys(map).length;
      case "isEmpty": arity(name, args, 0); return Object.keys(map).length === 0;
      case "clear": arity(name, args, 0); for (const key of Object.keys(map)) delete map[key]; return null;
      default: return unsupported(name, "Map");
    }
  }
  private eval(expr: Expr): unknown {
    this.step();
    switch (expr.t) {
      case "lit": return expr.v;
      case "str": { const parts: string[] = []; this.exec(expr.nodes, { parts, length: 0, max: this.limits.maxStringLength, what: "string" }); return parts.join(""); }
      case "ref": return this.ref(expr.ref);
      case "list": return this.collection(expr.items.map(item => this.eval(item)));
      case "map": { const map: Record<string, unknown> = {}; for (const [key, value] of expr.entries) map[mapKey(this.eval(key))] = this.eval(value); return this.collection(map); }
      case "range": { const from = this.eval(expr.from); const to = this.eval(expr.to); if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to)) return null; if (Math.abs(to - from) + 1 > this.limits.maxCollectionSize) fail(`A mapping template range exceeded the maximum of ${this.limits.maxCollectionSize} elements`); const out: number[] = []; const step = from <= to ? 1 : -1; for (let value = from; value !== to + step; value += step) out.push(value); return out; }
      case "not": return !truthy(this.eval(expr.e));
      case "neg": { const value = this.eval(expr.e); return typeof value === "number" ? -value : null; }
      case "bin": {
        if (expr.op === "&&") return truthy(this.eval(expr.l)) && truthy(this.eval(expr.r)); if (expr.op === "||") return truthy(this.eval(expr.l)) || truthy(this.eval(expr.r));
        const l = this.eval(expr.l); const r = this.eval(expr.r);
        if (expr.op === "==") return velocityEquals(l, r); if (expr.op === "!=") return !velocityEquals(l, r);
        if (expr.op === "+" && (typeof l === "string" || typeof r === "string")) { const side = (value: unknown, node: Expr) => value === null ? (node.t === "ref" ? node.ref.src : "null") : toJava(value); return this.guard(side(l, expr.l) + side(r, expr.r)); }
        if (typeof l !== "number" || typeof r !== "number") return ["<", ">", "<=", ">="].includes(expr.op) ? false : null;
        const integers = Number.isInteger(l) && Number.isInteger(r);
        switch (expr.op) { case "<": return l < r; case ">": return l > r; case "<=": return l <= r; case ">=": return l >= r; case "+": return l + r; case "-": return l - r; case "*": return l * r; case "/": return r === 0 ? null : integers ? Math.trunc(l / r) : l / r; case "%": return r === 0 ? null : l % r; }
        return null;
      }
    }
  }
}

function limitsFor(overrides?: Partial<VtlLimits>): VtlLimits { const limits: VtlLimits = { ...VTL_LIMITS }; for (const key of Object.keys(limits) as Array<keyof VtlLimits>) { const value = overrides?.[key]; if (typeof value === "number" && value > 0) limits[key] = value; } return limits; }
/** Renders a mapping template. Any parse or evaluation failure throws VtlTemplateError (API Gateway answers 500 "Internal server error"). */
export function renderVtl(template: string, source: VtlContext): string {
  const limits = limitsFor(source.limits);
  try { return new Interpreter(source, limits).run(new Parser(template, limits).parseTemplate()); }
  catch (error) { if (error instanceof VtlTemplateError) throw error; if (error instanceof VtlParseError) throw new VtlTemplateError(error.message); throw new VtlTemplateError("The mapping template could not be evaluated"); }
}
/** Parse-only admission check (nothing is evaluated): directive syntax, balanced #if/#foreach/#end, expressions and unsupported directives. Throws AwsError BadRequestException. */
export function validateVtl(template: string): void {
  try { new Parser(template, VTL_LIMITS).parseTemplate(); } catch (error) { if (error instanceof VtlParseError) throw new AwsError("BadRequestException", error.message); throw new AwsError("BadRequestException", "Invalid mapping template"); }
}
