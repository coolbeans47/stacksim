import { AwsError } from "./errors.js";

export interface VtlContext { body: string; headers: Record<string, string>; query: Record<string, string>; path: Record<string, string>; context: Record<string, unknown>; stageVariables: Record<string, string> }
type Token = { kind: string; value: string };

function jsonPath(value: any, path: string): any { if (path === "$" || !path) return value; const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+|\[(\d+)\]/g) ?? []; let current = value; for (const raw of parts) { const key = raw.startsWith("[") ? raw.slice(1, -1) : raw; current = current?.[key]; } return current; }
function inputObject(source: VtlContext): any {
  let parsed: any; try { parsed = source.body ? JSON.parse(source.body) : null; } catch { parsed = null; }
  const params: any = (name?: string) => name === undefined ? { header: source.headers, querystring: source.query, path: source.path } : source.path[name] ?? source.query[name] ?? source.headers[name.toLowerCase()];
  params.header = source.headers; params.querystring = source.query; params.path = source.path;
  return { body: source.body, json: (path: string) => JSON.stringify(jsonPath(parsed, path)), path: (path: string) => jsonPath(parsed, path), params };
}
const util = { escapeJavaScript: (value: unknown) => JSON.stringify(String(value)).slice(1, -1).replace(/\'/g, "\\'"), parseJson: (value: string) => JSON.parse(value), base64Encode: (value: unknown) => Buffer.from(String(value)).toString("base64"), base64Decode: (value: string) => Buffer.from(value, "base64").toString("utf8"), urlEncode: (value: unknown) => encodeURIComponent(String(value)), urlDecode: (value: string) => decodeURIComponent(value) };

function lex(expression: string): Token[] {
  const out: Token[] = []; let index = 0;
  while (index < expression.length) {
    const char = expression[index]; if (/\s/.test(char)) { index++; continue; }
    const operator = ["&&", "||", "==", "!=", ">=", "<="].find(item => expression.startsWith(item, index)); if (operator) { out.push({ kind: "op", value: operator }); index += operator.length; continue; }
    if ("()+-*/%!>,<.[]".includes(char)) { out.push({ kind: char, value: char }); index++; continue; }
    if (char === "'" || char === '"') { const quote = char; let value = ""; index++; while (index < expression.length && expression[index] !== quote) { if (expression[index] === "\\") { index++; const escape = expression[index++]; value += escape === "n" ? "\n" : escape === "r" ? "\r" : escape === "t" ? "\t" : escape; } else value += expression[index++]; } if (expression[index++] !== quote) throw new AwsError("BadRequestException", "Unterminated VTL string"); out.push({ kind: "literal", value }); continue; }
    const number = expression.slice(index).match(/^\d+(?:\.\d+)?/); if (number) { out.push({ kind: "number", value: number[0] }); index += number[0].length; continue; }
    const word = expression.slice(index).match(/^\$!?\{?[A-Za-z_][A-Za-z0-9_]*\}?|^[A-Za-z_][A-Za-z0-9_]*/); if (word) { out.push({ kind: word[0].startsWith("$") ? "variable" : "word", value: word[0].replace(/^\$!?\{?|\}$/g, "") }); index += word[0].length; continue; }
    throw new AwsError("BadRequestException", `Unsupported VTL expression near '${expression.slice(index, index + 16)}'`);
  }
  return out;
}

class ExpressionParser {
  private index = 0;
  constructor(private readonly tokens: Token[], private readonly scope: Record<string, any>) {}
  parse(min = 0): any {
    let left = this.prefix(); const precedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, ">": 4, "<": 4, ">=": 4, "<=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
    while (this.peek() && precedence[this.peek()!.value] > min) { const op = this.take().value; const right = this.parse(precedence[op]); left = op === "||" ? left || right : op === "&&" ? left && right : op === "==" ? left == right : op === "!=" ? left != right : op === ">" ? left > right : op === "<" ? left < right : op === ">=" ? left >= right : op === "<=" ? left <= right : op === "+" ? left + right : op === "-" ? left - right : op === "*" ? left * right : op === "/" ? left / right : left % right; }
    return left;
  }
  private prefix(): any {
    const token = this.take(); let value: any;
    if (token.value === "!") return !this.prefix(); if (token.value === "-") return -this.prefix();
    if (token.kind === "(") { value = this.parse(); this.expect(")"); }
    else if (token.kind === "literal") value = token.value; else if (token.kind === "number") value = Number(token.value); else if (token.kind === "word") value = token.value === "true" ? true : token.value === "false" ? false : token.value === "null" ? null : this.scope[token.value]; else if (token.kind === "variable") value = this.scope[token.value]; else throw new AwsError("BadRequestException", `Invalid VTL expression token ${token.value}`);
    while (this.peek() && [".", "[", "("].includes(this.peek()!.kind)) {
      if (this.peek()!.kind === "[") { this.take(); const key = this.parse(); this.expect("]"); value = value?.[key]; continue; }
      if (this.peek()!.kind === "(") { const args = this.arguments(); if (typeof value !== "function") throw new AwsError("BadRequestException", "VTL value is not callable"); value = value(...args); continue; }
      this.take(); const property = this.take(); if (!property || !["word", "variable"].includes(property.kind)) throw new AwsError("BadRequestException", "Expected VTL property name"); const key = property.value;
      if (this.peek()?.kind === "(") { const args = this.arguments(); if (key === "get") value = value?.[args[0]]; else if (key === "size") value = Array.isArray(value) || typeof value === "string" ? value.length : Object.keys(value ?? {}).length; else if (key === "keySet") value = Object.keys(value ?? {}); else if (key === "contains") value = value?.includes?.(args[0]); else { const method = value?.[key]; if (typeof method !== "function") throw new AwsError("BadRequestException", `Unsupported VTL method ${key}`); value = method.apply(value, args); } } else value = value?.[key];
    }
    return value;
  }
  private arguments(): any[] { this.expect("("); const args: any[] = []; if (this.peek()?.kind !== ")") { do { args.push(this.parse()); if (this.peek()?.kind !== ",") break; this.take(); } while (true); } this.expect(")"); return args; }
  private peek(): Token | undefined { return this.tokens[this.index]; } private take(): Token { const token = this.tokens[this.index++]; if (!token) throw new AwsError("BadRequestException", "Unexpected end of VTL expression"); return token; } private expect(kind: string): void { if (this.take().kind !== kind) throw new AwsError("BadRequestException", `Expected ${kind} in VTL expression`); }
}
function evaluate(expression: string, scope: Record<string, any>): any { return new ExpressionParser(lex(expression.trim()), scope).parse(); }
function balanced(text: string, open: number): { content: string; end: number } { let depth = 0; let quote = ""; for (let i = open; i < text.length; i++) { const char = text[i]; if (quote) { if (char === "\\") i++; else if (char === quote) quote = ""; continue; } if (char === "'" || char === '"') { quote = char; continue; } if (char === "(") depth++; else if (char === ")" && --depth === 0) return { content: text.slice(open + 1, i), end: i + 1 }; } throw new AwsError("BadRequestException", "Unbalanced VTL directive"); }
function findBlock(text: string, start: number): { branches: Array<{ condition?: string; body: string }>; end: number } {
  let depth = 1; let cursor = start; let branchStart = start; let condition: string | undefined; const branches: Array<{ condition?: string; body: string }> = [];
  while (cursor < text.length) { const match = /#(if|foreach|end|elseif|else)\b/g; match.lastIndex = cursor; const found = match.exec(text); if (!found) break; const directive = found[1]; if (directive === "if" || directive === "foreach") depth++; else if (directive === "end") { depth--; if (depth === 0) { branches.push({ condition, body: text.slice(branchStart, found.index) }); return { branches, end: match.lastIndex }; } } else if (depth === 1 && (directive === "elseif" || directive === "else")) { branches.push({ condition, body: text.slice(branchStart, found.index) }); if (directive === "elseif") { const part = balanced(text, match.lastIndex + text.slice(match.lastIndex).indexOf("(")); condition = part.content; branchStart = part.end; cursor = part.end; continue; } condition = undefined; branchStart = match.lastIndex; } cursor = match.lastIndex; }
  throw new AwsError("BadRequestException", "VTL block is missing #end");
}
function render(text: string, scope: Record<string, any>): string {
  let output = ""; let index = 0;
  while (index < text.length) {
    const directive = text.slice(index).match(/#(set|if|foreach)\b/); const reference = text.slice(index).match(/\$!?\{?[A-Za-z_]/); const d = directive ? index + directive.index! : Infinity; const r = reference ? index + reference.index! : Infinity; const next = Math.min(d, r); if (!Number.isFinite(next)) { output += text.slice(index); break; } output += text.slice(index, next);
    if (next === d) { const kind = directive![1]; const paren = text.indexOf("(", d); const part = balanced(text, paren); if (kind === "set") { const assignment = part.content.match(/^\s*\$!?\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s*=([\s\S]+)$/); if (!assignment) throw new AwsError("BadRequestException", "Invalid #set directive"); scope[assignment[1]] = evaluate(assignment[2], scope); index = part.end; continue; } const block = findBlock(text, part.end); if (kind === "if") { const choices = [{ condition: part.content, body: block.branches[0].body }, ...block.branches.slice(1)]; const selected = choices.find(branch => branch.condition === undefined || evaluate(branch.condition, scope)); if (selected) output += render(selected.body, { ...scope }); } else { const loop = part.content.match(/^\s*\$([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/); if (!loop) throw new AwsError("BadRequestException", "Invalid #foreach directive"); const values = evaluate(loop[2], scope) ?? []; let i = 0; for (const value of values) output += render(block.branches[0].body, { ...scope, [loop[1]]: value, foreach: { index: i, count: i++ + 1, hasNext: i < values.length } }); } index = block.end; continue; }
    let end = r + 1; let quiet = false; if (text[end] === "!") { quiet = true; end++; } if (text[end] === "{") { const close = text.indexOf("}", end); if (close < 0) throw new AwsError("BadRequestException", "Unclosed VTL reference"); const expression = `$${text.slice(end + 1, close)}`; const value = evaluate(expression, scope); output += value === undefined || value === null ? (quiet ? "" : text.slice(r, close + 1)) : String(value); index = close + 1; continue; }
    let depth = 0; let bracketDepth = 0; let quote = ""; while (end < text.length) { const char = text[end]; if (quote) { if (char === "\\") end += 2; else { if (char === quote) quote = ""; end++; } continue; } if (char === "'" || char === '"') { if (depth === 0 && bracketDepth === 0) break; quote = char; end++; continue; } if (char === "(") depth++; else if (char === ")") depth--; else if (char === "[") bracketDepth++; else if (char === "]") { if (bracketDepth === 0) break; bracketDepth--; end++; continue; } if (depth < 0 || bracketDepth < 0 || (depth === 0 && bracketDepth === 0 && /[\s,}\]:;|]/.test(char))) break; if (depth === 0 && bracketDepth === 0 && char === "#") break; end++; }
    const referenceText = text.slice(r, end); const expression = referenceText.replace(/^\$!/, "$"); const value = evaluate(expression, scope); output += value === undefined || value === null ? (quiet ? "" : referenceText) : typeof value === "object" ? String(value) : String(value); index = end;
  }
  return output;
}

export function renderVtl(template: string, source: VtlContext): string {
  if (/#(macro|parse|include|evaluate|define|stop|break)\b/.test(template)) throw new AwsError("BadRequestException", "The mapping template uses an unsupported VTL directive");
  const scope = { input: inputObject(source), context: source.context, stageVariables: source.stageVariables, util };
  return render(template.replace(/##[^\n]*(?=\n|$)/g, ""), scope);
}
export function validateVtl(template: string): void { renderVtl(template, { body: "{}", headers: {}, query: {}, path: {}, context: {}, stageVariables: {} }); }
