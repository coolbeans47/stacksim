import { randomUUID } from "node:crypto";
import type { AttributeValue, Item } from "../types.js";

const TEMPLATE_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const MAX_STEPS = 100_000;
const MAX_LOOP_ITEMS = 10_000;
const MAX_LOGS = 100;
const SAFE_FUNCTIONS = new WeakSet<Function>();

type Token = { kind: string; value: string };

export interface AppSyncVtlContext {
  arguments: Record<string, unknown>;
  source: unknown;
  result?: unknown;
  error?: { message: string; type?: string; data?: unknown } | null;
  identity: unknown;
  stash: Record<string, unknown>;
  prev?: { result: unknown };
  request?: { headers?: Record<string, string> };
  info?: Record<string, unknown>;
  authType?: string;
  /** Request-private pagination scope. Deliberately omitted from the VTL $ctx object. */
  authorizationScope?: string;
}

export interface AppSyncVtlErrorShape {
  message: string;
  errorType?: string;
  data?: unknown;
  errorInfo?: unknown;
}

export interface AppSyncVtlEvaluation {
  value: unknown;
  returned: boolean;
  stash: Record<string, unknown>;
  appendedErrors: AppSyncVtlErrorShape[];
  logs: string[];
  subscriptionFilter?: unknown;
}

export class AppSyncVtlError extends Error {
  constructor(
    message: string,
    readonly errorType = "MappingTemplate",
    readonly data?: unknown,
    readonly errorInfo?: unknown,
  ) {
    super(message);
  }
}

class ReturnSignal {
  constructor(readonly value: unknown) {}
}

function safe<T extends (...args: any[]) => any>(fn: T): T {
  SAFE_FUNCTIONS.add(fn);
  return fn;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contextAuthType(context: Record<string, unknown>): string | null {
  if (typeof context.authType === "string") return context.authType;
  const identity = context.identity;
  if (isRecord(identity) && typeof identity.authenticationType === "string") return identity.authenticationType;
  if (isRecord(identity) && (identity.accountId !== undefined || identity.cognitoIdentityPoolId !== undefined)) return "IAM Authorization";
  if (isRecord(identity) && identity.sub !== undefined) return "User Pool Authorization";
  return null;
}

export function toDynamoDB(value: unknown): AttributeValue {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new AppSyncVtlError("A JavaScript number outside the safe DynamoDB boundary cannot be converted.");
    }
    return { N: String(value) };
  }
  if (Array.isArray(value)) return { L: value.map(toDynamoDB) };
  if (isRecord(value)) return { M: toDynamoDBMap(value) };
  throw new AppSyncVtlError("The value cannot be converted to a DynamoDB attribute.");
}

export function toDynamoDBMap(value: Record<string, unknown>): Item {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toDynamoDB(item)]));
}

export function fromDynamoDB(value: AttributeValue): unknown {
  if ("S" in value) return value.S;
  if ("N" in value) {
    const number = Number(value.N);
    if (!Number.isFinite(number)) throw new AppSyncVtlError("A DynamoDB number cannot be represented as JSON.");
    if (/^[+-]?\d+$/.test(value.N) && !Number.isSafeInteger(number)) return value.N;
    return number;
  }
  if ("B" in value) return value.B;
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(fromDynamoDB);
  if ("M" in value) return fromDynamoDBMap(value.M);
  if ("SS" in value) return [...value.SS];
  if ("NS" in value) return value.NS.map(item => {
    const number = Number(item);
    return Number.isSafeInteger(number) || !Number.isInteger(number) ? number : item;
  });
  if ("BS" in value) return [...value.BS];
  throw new AppSyncVtlError("The DynamoDB attribute has an unsupported type.");
}

export function fromDynamoDBMap(value: Item): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromDynamoDB(item)]));
}

function lex(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    const operator = ["&&", "||", "==", "!=", ">=", "<="].find(candidate => expression.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: "operator", value: operator });
      index += operator.length;
      continue;
    }
    if ("()[]{}.,:+-*/%!<>".includes(character)) {
      tokens.push({ kind: character, value: character });
      index++;
      continue;
    }
    if (character === "'" || character === "\"") {
      const quote = character;
      let value = "";
      index++;
      while (index < expression.length && expression[index] !== quote) {
        if (expression[index] !== "\\") {
          value += expression[index++];
          continue;
        }
        index++;
        const escaped = expression[index++];
        value += escaped === "n" ? "\n"
          : escaped === "r" ? "\r"
            : escaped === "t" ? "\t"
              : escaped === "b" ? "\b"
                : escaped === "f" ? "\f"
                  : escaped;
      }
      if (expression[index++] !== quote) throw new AppSyncVtlError("Unterminated VTL string.");
      tokens.push({ kind: quote === "\"" ? "interpolated" : "literal", value });
      continue;
    }
    const number = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    const variable = expression.slice(index).match(/^\$!?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/);
    if (variable) {
      tokens.push({ kind: "variable", value: variable[1] });
      index += variable[0].length;
      continue;
    }
    const word = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (word) {
      tokens.push({ kind: "word", value: word[0] });
      index += word[0].length;
      continue;
    }
    throw new AppSyncVtlError(`Unsupported VTL expression near '${expression.slice(index, index + 24)}'.`);
  }
  return tokens;
}

function property(value: unknown, key: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && key === "length") return value.length;
  if (typeof value === "string" && key === "length") return value.length;
  if (typeof key !== "string" && typeof key !== "number") return null;
  if (typeof value !== "object" && typeof value !== "string") return null;
  if (["__proto__", "prototype", "constructor"].includes(String(key))) {
    throw new AppSyncVtlError("Host prototype access is not available in AppSync VTL.");
  }
  return Object.hasOwn(Object(value), key) ? (value as any)[key] : null;
}

function invokeMethod(receiver: unknown, method: string, args: unknown[]): unknown {
  if (["__proto__", "prototype", "constructor"].includes(method)) {
    throw new AppSyncVtlError("Host prototype access is not available in AppSync VTL.");
  }
  if (method === "get") return property(receiver, args[0] as any);
  if (method === "size" || method === "length") {
    if (Array.isArray(receiver) || typeof receiver === "string") return receiver.length;
    return isRecord(receiver) ? Object.keys(receiver).length : 0;
  }
  if (method === "isEmpty") return Array.isArray(receiver) || typeof receiver === "string"
    ? receiver.length === 0
    : isRecord(receiver) ? Object.keys(receiver).length === 0 : true;
  if (method === "contains" || method === "containsValue") {
    if (Array.isArray(receiver) || typeof receiver === "string") return receiver.includes(args[0] as never);
    return isRecord(receiver) && Object.values(receiver).some(value => Object.is(value, args[0]));
  }
  if (method === "containsKey") return isRecord(receiver) && Object.hasOwn(receiver, String(args[0]));
  if (method === "hasNext") return isRecord(receiver) && receiver.hasNext === true;
  if (method === "keySet") return isRecord(receiver) ? Object.keys(receiver) : [];
  if (method === "values") return isRecord(receiver) ? Object.values(receiver) : [];
  if (method === "entrySet") return isRecord(receiver)
    ? Object.entries(receiver).map(([key, value]) => ({ key, value }))
    : [];
  if (method === "put") {
    if (!isRecord(receiver) || typeof args[0] !== "string") throw new AppSyncVtlError("put requires a map and string key.");
    const previous = receiver[args[0]];
    receiver[args[0]] = clone(args[1]);
    return previous ?? null;
  }
  if (method === "putAll") {
    if (!isRecord(receiver) || !isRecord(args[0])) throw new AppSyncVtlError("putAll requires two maps.");
    Object.assign(receiver, clone(args[0]));
    return null;
  }
  if (method === "remove") {
    if (Array.isArray(receiver)) {
      const index = typeof args[0] === "number" ? args[0] : receiver.indexOf(args[0]);
      return index >= 0 ? receiver.splice(index, 1)[0] : null;
    }
    if (!isRecord(receiver)) throw new AppSyncVtlError("remove requires a map or list.");
    const key = String(args[0]);
    const previous = receiver[key];
    delete receiver[key];
    return previous ?? null;
  }
  if (method === "add") {
    if (!Array.isArray(receiver)) throw new AppSyncVtlError("add requires a list.");
    receiver.push(clone(args[0]));
    return true;
  }
  if (method === "addAll") {
    if (!Array.isArray(receiver) || !Array.isArray(args[0])) throw new AppSyncVtlError("addAll requires two lists.");
    receiver.push(...clone(args[0]));
    return true;
  }
  if (method === "equals") return JSON.stringify(receiver) === JSON.stringify(args[0]);
  if (typeof receiver === "string") {
    if (method === "startsWith") return receiver.startsWith(String(args[0]));
    if (method === "endsWith") return receiver.endsWith(String(args[0]));
    if (method === "substring") return receiver.slice(Number(args[0]), args[1] === undefined ? undefined : Number(args[1]));
    if (method === "toLowerCase") return receiver.toLowerCase();
    if (method === "toUpperCase") return receiver.toUpperCase();
    if (method === "trim") return receiver.trim();
    if (method === "replace") return receiver.split(String(args[0])).join(String(args[1]));
    if (method === "replaceAll") {
      try { return receiver.replace(new RegExp(String(args[0]), "g"), String(args[1])); }
      catch { throw new AppSyncVtlError("replaceAll requires a valid regular expression."); }
    }
    if (method === "split") return receiver.split(String(args[0]));
  }
  const callable = property(receiver, method);
  if (typeof callable === "function" && SAFE_FUNCTIONS.has(callable)) return callable(...args);
  throw new AppSyncVtlError(`Unsupported VTL method ${method}.`);
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly scope: Record<string, unknown>,
    private readonly step: () => void,
  ) {}

  complete(): unknown {
    const value = this.parse();
    if (this.peek()) throw new AppSyncVtlError(`Unexpected VTL expression token ${this.peek()!.value}.`);
    return value;
  }

  private parse(minimum = 0): unknown {
    this.step();
    let left = this.prefix();
    const precedence: Record<string, number> = {
      "||": 1, "&&": 2, "==": 3, "!=": 3,
      ">": 4, "<": 4, ">=": 4, "<=": 4,
      "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
    };
    while (this.peek() && (precedence[this.peek()!.value] ?? 0) > minimum) {
      const operator = this.take().value;
      const right = this.parse(precedence[operator]);
      left = operator === "||" ? Boolean(left) || Boolean(right)
        : operator === "&&" ? Boolean(left) && Boolean(right)
          : operator === "==" ? left === right
            : operator === "!=" ? left !== right
              : operator === ">" ? (left as any) > (right as any)
                : operator === "<" ? (left as any) < (right as any)
                  : operator === ">=" ? (left as any) >= (right as any)
                    : operator === "<=" ? (left as any) <= (right as any)
                      : operator === "+" ? (left as any) + (right as any)
                        : operator === "-" ? Number(left) - Number(right)
                          : operator === "*" ? Number(left) * Number(right)
                            : operator === "/" ? Number(left) / Number(right)
                              : Number(left) % Number(right);
    }
    return left;
  }

  private prefix(): unknown {
    const token = this.take();
    let value: unknown;
    if (token.value === "!") return !this.prefix();
    if (token.value === "-") return -Number(this.prefix());
    if (token.kind === "(") {
      value = this.parse();
      this.expect(")");
    } else if (token.kind === "[") {
      const values: unknown[] = [];
      if (this.peek()?.kind !== "]") {
        do {
          values.push(this.parse());
          if (this.peek()?.kind !== ",") break;
          this.take();
        } while (true);
      }
      this.expect("]");
      value = values;
    } else if (token.kind === "{") {
      const values: Record<string, unknown> = {};
      if (this.peek()?.kind !== "}") {
        do {
          const key = this.take();
          if (!["literal", "interpolated", "word"].includes(key.kind)) throw new AppSyncVtlError("A VTL map key must be a string.");
          this.expect(":");
          values[key.kind === "interpolated" ? this.interpolate(key.value) : key.value] = this.parse();
          if (this.peek()?.kind !== ",") break;
          this.take();
        } while (true);
      }
      this.expect("}");
      value = values;
    } else if (token.kind === "literal") value = token.value;
    else if (token.kind === "interpolated") value = this.interpolate(token.value);
    else if (token.kind === "number") value = Number(token.value);
    else if (token.kind === "word") {
      value = token.value === "true" ? true
        : token.value === "false" ? false
          : token.value === "null" ? null
            : property(this.scope, token.value);
    } else if (token.kind === "variable") value = property(this.scope, token.value);
    else throw new AppSyncVtlError(`Invalid VTL expression token ${token.value}.`);

    while (this.peek() && [".", "[", "("].includes(this.peek()!.kind)) {
      if (this.peek()!.kind === "[") {
        this.take();
        const key = this.parse();
        this.expect("]");
        value = property(value, key as any);
        continue;
      }
      if (this.peek()!.kind === "(") {
        const args = this.arguments();
        if (typeof value !== "function" || !SAFE_FUNCTIONS.has(value)) {
          throw new AppSyncVtlError("The VTL value is not an AppSync utility function.");
        }
        value = value(...args);
        continue;
      }
      this.take();
      const member = this.take();
      if (!["word", "variable"].includes(member.kind)) throw new AppSyncVtlError("Expected a VTL property name.");
      if (this.peek()?.kind === "(") value = invokeMethod(value, member.value, this.arguments());
      else value = property(value, member.value);
    }
    return value;
  }

  private arguments(): unknown[] {
    this.expect("(");
    const args: unknown[] = [];
    if (this.peek()?.kind !== ")") {
      do {
        args.push(this.parse());
        if (this.peek()?.kind !== ",") break;
        this.take();
      } while (true);
    }
    this.expect(")");
    return args;
  }

  private interpolate(text: string): string {
    let output = "";
    let index = 0;
    while (index < text.length) {
      const next = text.indexOf("$", index);
      if (next < 0) return output + text.slice(index);
      output += text.slice(index, next);
      const reference = scanReference(text, next);
      const value = this.evaluateReference(reference.expression);
      if (value !== null && value !== undefined) output += typeof value === "object" ? JSON.stringify(value) : String(value);
      else if (!reference.quiet) output += text.slice(next, reference.end);
      index = reference.end;
    }
    return output;
  }

  private evaluateReference(expression: string): unknown {
    return new ExpressionParser(lex(expression), this.scope, this.step).complete();
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private take(): Token {
    const token = this.tokens[this.index++];
    if (!token) throw new AppSyncVtlError("Unexpected end of VTL expression.");
    return token;
  }

  private expect(kind: string): void {
    if (this.take().kind !== kind) throw new AppSyncVtlError(`Expected ${kind} in VTL expression.`);
  }
}

function balanced(text: string, open: number, left = "(", right = ")"): { content: string; end: number } {
  let depth = 0;
  let quote = "";
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === left) depth++;
    else if (character === right && --depth === 0) {
      return { content: text.slice(open + 1, index), end: index + 1 };
    }
  }
  throw new AppSyncVtlError("Unbalanced VTL expression.");
}

function scanReference(text: string, start: number): { expression: string; end: number; quiet: boolean } {
  let index = start + 1;
  let quiet = false;
  if (text[index] === "!") {
    quiet = true;
    index++;
  }
  if (text[index] === "{") {
    const part = balanced(text, index, "{", "}");
    return { expression: `$${part.content}`, end: part.end, quiet };
  }
  const root = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!root) throw new AppSyncVtlError("Invalid VTL reference.");
  index += root[0].length;
  while (index < text.length) {
    if (text[index] === ".") {
      const member = text.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!member) break;
      index += member[0].length + 1;
      if (text[index] === "(") index = balanced(text, index).end;
      continue;
    }
    if (text[index] === "[") {
      index = balanced(text, index, "[", "]").end;
      continue;
    }
    if (text[index] === "(") {
      index = balanced(text, index).end;
      continue;
    }
    break;
  }
  return {
    expression: `$${text.slice(start + 1 + (quiet ? 1 : 0), index)}`,
    end: index,
    quiet,
  };
}

interface Branch {
  condition?: string;
  body: string;
}

function findBlock(text: string, start: number): { branches: Branch[]; end: number } {
  let depth = 1;
  let cursor = start;
  let branchStart = start;
  let nextCondition: string | undefined;
  const branches: Branch[] = [];
  while (cursor < text.length) {
    const pattern = /#(if|foreach|end|elseif|else)\b/g;
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (!match) break;
    const directive = match[1];
    if (directive === "if" || directive === "foreach") depth++;
    else if (directive === "end") {
      depth--;
      if (depth === 0) {
        branches.push({ ...(nextCondition === undefined ? {} : { condition: nextCondition }), body: text.slice(branchStart, match.index) });
        return { branches, end: pattern.lastIndex };
      }
    } else if (depth === 1 && (directive === "elseif" || directive === "else")) {
      branches.push({ ...(nextCondition === undefined ? {} : { condition: nextCondition }), body: text.slice(branchStart, match.index) });
      if (directive === "elseif") {
        const open = text.indexOf("(", pattern.lastIndex);
        const part = balanced(text, open);
        nextCondition = part.content;
        branchStart = part.end;
        cursor = part.end;
        continue;
      }
      nextCondition = undefined;
      branchStart = pattern.lastIndex;
    }
    cursor = pattern.lastIndex;
  }
  throw new AppSyncVtlError("A VTL block is missing #end.");
}

function assign(scope: Record<string, unknown>, expression: string, value: unknown): void {
  const match = expression.trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/);
  if (!match) throw new AppSyncVtlError("Invalid #set assignment target.");
  if (!match[2]) {
    scope[match[1]] = clone(value);
    return;
  }
  const parts: Array<string | number> = [];
  let suffix = match[2];
  while (suffix) {
    const dot = suffix.match(/^\.([A-Za-z_][A-Za-z0-9_]*)/);
    if (dot) {
      parts.push(dot[1]);
      suffix = suffix.slice(dot[0].length);
      continue;
    }
    const bracket = suffix.match(/^\[(?:"([^"]+)"|'([^']+)'|(\d+))\]/);
    if (bracket) {
      parts.push(bracket[1] ?? bracket[2] ?? Number(bracket[3]));
      suffix = suffix.slice(bracket[0].length);
      continue;
    }
    throw new AppSyncVtlError("Unsupported #set assignment path.");
  }
  if (match[1] === "ctx" || match[1] === "context") {
    if (parts[0] !== "stash") throw new AppSyncVtlError("Only $ctx.stash can be assigned.");
  }
  let target = property(scope, match[1]) as any;
  for (const key of parts.slice(0, -1)) {
    target = property(target, key) as any;
    if (!target || typeof target !== "object") throw new AppSyncVtlError("The #set assignment target is not a map or list.");
  }
  if (!target || typeof target !== "object") throw new AppSyncVtlError("The #set assignment target is not a map or list.");
  const key = parts.at(-1)!;
  if (["__proto__", "prototype", "constructor"].includes(String(key))) {
    throw new AppSyncVtlError("Host prototype access is not available in AppSync VTL.");
  }
  target[key] = clone(value);
}

function conditionExpression(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AppSyncVtlError("A DynamoDB condition expression must be a map.");
  const names: Record<string, string> = {};
  const values: Item = {};
  let sequence = 0;
  const field = (name: string, condition: unknown): string => {
    const nameToken = `#n${sequence}`;
    const valueToken = `:v${sequence}`;
    sequence++;
    names[nameToken] = name;
    if (!isRecord(condition)) {
      values[valueToken] = toDynamoDB(condition);
      return `${nameToken} = ${valueToken}`;
    }
    const operations: string[] = [];
    for (const [operator, operand] of Object.entries(condition)) {
      if (operator === "attributeExists") {
        operations.push(`${operand ? "attribute_exists" : "attribute_not_exists"}(${nameToken})`);
        continue;
      }
      const token = operations.length ? `:v${sequence++}` : valueToken;
      const symbol = ({ eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" } as Record<string, string>)[operator];
      if (symbol) {
        values[token] = toDynamoDB(operand);
        operations.push(`${nameToken} ${symbol} ${token}`);
      } else if (operator === "beginsWith") {
        values[token] = toDynamoDB(operand);
        operations.push(`begins_with(${nameToken}, ${token})`);
      } else if (operator === "contains") {
        values[token] = toDynamoDB(operand);
        operations.push(`contains(${nameToken}, ${token})`);
      } else if (operator === "notContains") {
        values[token] = toDynamoDB(operand);
        operations.push(`NOT contains(${nameToken}, ${token})`);
      } else if (operator === "attributeType") {
        const types: Record<string, string> = {
          binary: "B", binarySet: "BS", bool: "BOOL", list: "L", map: "M",
          number: "N", numberSet: "NS", string: "S", stringSet: "SS", _null: "NULL",
        };
        if (typeof operand !== "string" || !types[operand]) {
          throw new AppSyncVtlError("Unsupported DynamoDB attribute type.");
        }
        values[token] = toDynamoDB(types[operand]);
        operations.push(`attribute_type(${nameToken}, ${token})`);
      } else if (operator === "size" && isRecord(operand)) {
        const sizeOperations: string[] = [];
        for (const [sizeOperator, sizeOperand] of Object.entries(operand)) {
          const sizeToken = sizeOperations.length || operations.length ? `:v${sequence++}` : token;
          const sizeSymbol = ({ eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" } as Record<string, string>)[sizeOperator];
          if (sizeSymbol) {
            values[sizeToken] = toDynamoDB(sizeOperand);
            sizeOperations.push(`size(${nameToken}) ${sizeSymbol} ${sizeToken}`);
          } else if (sizeOperator === "between" && Array.isArray(sizeOperand) && sizeOperand.length === 2) {
            const upper = `:v${sequence++}`;
            values[sizeToken] = toDynamoDB(sizeOperand[0]);
            values[upper] = toDynamoDB(sizeOperand[1]);
            sizeOperations.push(`size(${nameToken}) BETWEEN ${sizeToken} AND ${upper}`);
          } else throw new AppSyncVtlError(`Unsupported DynamoDB size operator ${sizeOperator}.`);
        }
        operations.push(...sizeOperations);
      }
      else if (operator === "between" && Array.isArray(operand) && operand.length === 2) {
        const upper = `:v${sequence++}`;
        values[token] = toDynamoDB(operand[0]);
        values[upper] = toDynamoDB(operand[1]);
        operations.push(`${nameToken} BETWEEN ${token} AND ${upper}`);
      } else throw new AppSyncVtlError(`Unsupported DynamoDB condition operator ${operator}.`);
    }
    return operations.length > 1 ? `(${operations.join(" AND ")})` : operations[0] ?? "";
  };
  const compile = (node: unknown): string => {
    if (!isRecord(node)) throw new AppSyncVtlError("A DynamoDB condition node must be a map.");
    const clauses: string[] = [];
    for (const [name, condition] of Object.entries(node)) {
      if ((name === "and" || name === "or") && Array.isArray(condition)) {
        const children = condition.map(compile).filter(Boolean);
        if (children.length) clauses.push(`(${children.join(name === "and" ? " AND " : " OR ")})`);
      } else if (name === "not") clauses.push(`NOT (${compile(condition)})`);
      else clauses.push(field(name, condition));
    }
    return clauses.filter(Boolean).join(" AND ");
  };
  return {
    expression: compile(value),
    expressionNames: names,
    expressionValues: values,
  };
}

class Runtime {
  private steps = 0;
  readonly appendedErrors: AppSyncVtlErrorShape[] = [];
  readonly logs: string[] = [];
  subscriptionFilter?: unknown;
  readonly scope: Record<string, unknown>;

  constructor(
    context: AppSyncVtlContext,
    private readonly now: number,
  ) {
    const normalized = {
      arguments: clone(context.arguments),
      args: clone(context.arguments),
      source: clone(context.source),
      result: clone(context.result),
      error: clone(context.error ?? null),
      identity: clone(context.identity),
      stash: context.stash,
      prev: clone(context.prev ?? { result: null }),
      request: clone(context.request ?? { headers: {} }),
      info: clone(context.info ?? {}),
      authType: context.authType ?? null,
    };
    const util = this.utilities();
    const extensions = {
      setSubscriptionFilter: safe((value: unknown) => {
        this.subscriptionFilter = clone(value);
        return "";
      }),
    };
    this.scope = { ctx: normalized, context: normalized, util, extensions };
  }

  evaluateExpression(expression: string): unknown {
    return new ExpressionParser(lex(expression.trim()), this.scope, () => this.step()).complete();
  }

  render(text: string): string {
    let output = "";
    let index = 0;
    while (index < text.length) {
      this.step();
      const directive = text.slice(index).match(/#(set|if|foreach|return)\b/);
      const reference = text.slice(index).match(/\$!?\{?[A-Za-z_]/);
      const directiveAt = directive ? index + directive.index! : Number.POSITIVE_INFINITY;
      const referenceAt = reference ? index + reference.index! : Number.POSITIVE_INFINITY;
      const next = Math.min(directiveAt, referenceAt);
      if (!Number.isFinite(next)) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, next);
      if (next === directiveAt) {
        const kind = directive![1];
        const open = text.indexOf("(", directiveAt);
        if (open < 0) throw new AppSyncVtlError(`#${kind} requires parentheses.`);
        const part = balanced(text, open);
        if (kind === "set") {
          const assignment = part.content.match(/^\s*(\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:"[^"]+"|'[^']+'|\d+)\])*)\s*=\s*([\s\S]+)$/);
          if (!assignment) throw new AppSyncVtlError("Invalid #set directive.");
          assign(this.scope, assignment[1], this.evaluateExpression(assignment[2]));
          index = part.end;
          continue;
        }
        if (kind === "return") throw new ReturnSignal(this.evaluateExpression(part.content));
        const block = findBlock(text, part.end);
        if (kind === "if") {
          const choices: Branch[] = [
            { condition: part.content, body: block.branches[0].body },
            ...block.branches.slice(1),
          ];
          const selected = choices.find(branch => branch.condition === undefined || Boolean(this.evaluateExpression(branch.condition)));
          if (selected) output += this.render(selected.body);
        } else {
          const loop = part.content.match(/^\s*\$([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/);
          if (!loop) throw new AppSyncVtlError("Invalid #foreach directive.");
          const value = this.evaluateExpression(loop[2]);
          const values = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
          if (values.length > MAX_LOOP_ITEMS) throw new AppSyncVtlError("The VTL loop exceeds the local item limit.");
          const previous = this.scope[loop[1]];
          const previousForeach = this.scope.foreach;
          for (let item = 0; item < values.length; item++) {
            this.scope[loop[1]] = clone(values[item]);
            this.scope.foreach = { index: item, count: item + 1, hasNext: item + 1 < values.length };
            this.scope.velocityCount = item + 1;
            output += this.render(block.branches[0].body);
          }
          if (previous === undefined) delete this.scope[loop[1]];
          else this.scope[loop[1]] = previous;
          if (previousForeach === undefined) delete this.scope.foreach;
          else this.scope.foreach = previousForeach;
          delete this.scope.velocityCount;
        }
        index = block.end;
        continue;
      }
      const scanned = scanReference(text, referenceAt);
      const value = this.evaluateExpression(scanned.expression);
      if (value !== null && value !== undefined) {
        output += typeof value === "object" ? JSON.stringify(value) : String(value);
      } else if (!scanned.quiet) {
        output += text.slice(referenceAt, scanned.end);
      }
      index = scanned.end;
      if (Buffer.byteLength(output, "utf8") > OUTPUT_LIMIT) {
        throw new AppSyncVtlError("Mapping-template output exceeds the 256 KiB local limit.");
      }
    }
    return output;
  }

  private step(): void {
    this.steps++;
    if (this.steps > MAX_STEPS) throw new AppSyncVtlError("The VTL instruction limit was exceeded.");
  }

  private utilities(): Record<string, unknown> {
    const addError = (message: unknown, errorType?: unknown, data?: unknown, errorInfo?: unknown) => {
      const error = {
        message: String(message),
        ...(errorType === undefined ? {} : { errorType: String(errorType) }),
        ...(data === undefined ? {} : { data: clone(data) }),
        ...(errorInfo === undefined ? {} : { errorInfo: clone(errorInfo) }),
      };
      this.appendedErrors.push(error);
      return "";
    };
    const log = (level: string, values: unknown[]) => {
      if (this.logs.length < MAX_LOGS) {
        this.logs.push(`${level} ${values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ")}`.slice(0, 4096));
      }
      return "";
    };
    const dynamodb = {
      toDynamoDB: safe((value: unknown) => toDynamoDB(value)),
      toDynamoDBJson: safe((value: unknown) => JSON.stringify(toDynamoDB(value))),
      toMapValues: safe((value: unknown) => {
        if (!isRecord(value)) throw new AppSyncVtlError("toMapValues requires a map.");
        return toDynamoDBMap(value);
      }),
      toMapValuesJson: safe((value: unknown) => {
        if (!isRecord(value)) throw new AppSyncVtlError("toMapValuesJson requires a map.");
        return JSON.stringify(toDynamoDBMap(value));
      }),
      toString: safe((value: unknown) => ({ S: String(value) })),
      toStringJson: safe((value: unknown) => JSON.stringify({ S: String(value) })),
      toNumber: safe((value: unknown) => {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new AppSyncVtlError("toNumber requires a finite number.");
        return { N: String(value) };
      }),
      toNumberJson: safe((value: unknown) => {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new AppSyncVtlError("toNumberJson requires a finite number.");
        return JSON.stringify({ N: String(value) });
      }),
      toBoolean: safe((value: unknown) => ({ BOOL: Boolean(value) })),
      toBooleanJson: safe((value: unknown) => JSON.stringify({ BOOL: Boolean(value) })),
      toNull: safe(() => ({ NULL: true })),
      toNullJson: safe(() => JSON.stringify({ NULL: true })),
      toStringSet: safe((value: unknown) => {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new AppSyncVtlError("toStringSet requires a string list.");
        return { SS: [...new Set(value)] };
      }),
      toStringSetJson: safe((value: unknown) => {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new AppSyncVtlError("toStringSetJson requires a string list.");
        return JSON.stringify({ SS: [...new Set(value)] });
      }),
      toNumberSet: safe((value: unknown) => {
        if (!Array.isArray(value) || value.some(item => !Number.isFinite(Number(item)))) throw new AppSyncVtlError("toNumberSet requires a number list.");
        return { NS: [...new Set(value.map(String))] };
      }),
      toNumberSetJson: safe((value: unknown) => {
        if (!Array.isArray(value) || value.some(item => !Number.isFinite(Number(item)))) throw new AppSyncVtlError("toNumberSetJson requires a number list.");
        return JSON.stringify({ NS: [...new Set(value.map(String))] });
      }),
    };
    const transform = {
      toDynamoDBConditionExpression: safe((value: unknown) => JSON.stringify(conditionExpression(value))),
      toDynamoDBFilterExpression: safe((value: unknown) => JSON.stringify(conditionExpression(value))),
      toSubscriptionFilter: safe((value: unknown) => clone(value)),
    };
    const list = {
      copyAndRetainAll: safe((source: unknown, values: unknown) => {
        if (!Array.isArray(source) || !Array.isArray(values)) throw new AppSyncVtlError("copyAndRetainAll requires lists.");
        return source.filter(item => values.some(candidate => Object.is(candidate, item)));
      }),
      copyAndRemoveAll: safe((source: unknown, values: unknown) => {
        if (!Array.isArray(source) || !Array.isArray(values)) throw new AppSyncVtlError("copyAndRemoveAll requires lists.");
        return source.filter(item => !values.some(candidate => Object.is(candidate, item)));
      }),
    };
    const map = {
      copyAndRetainAllKeys: safe((source: unknown, keys: unknown) => {
        if (!isRecord(source) || !Array.isArray(keys)) throw new AppSyncVtlError("copyAndRetainAllKeys requires a map and key list.");
        return Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));
      }),
      copyAndRemoveAllKeys: safe((source: unknown, keys: unknown) => {
        if (!isRecord(source) || !Array.isArray(keys)) throw new AppSyncVtlError("copyAndRemoveAllKeys requires a map and key list.");
        return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
      }),
    };
    return {
      toJson: safe((value: unknown) => JSON.stringify(value === undefined ? null : value)),
      parseJson: safe((value: unknown) => JSON.parse(String(value))),
      defaultIfNull: safe((value: unknown, fallback: unknown) => value === null || value === undefined ? fallback : value),
      defaultIfNullOrBlank: safe((value: unknown, fallback: unknown) => value === null || value === undefined || String(value).trim() === "" ? fallback : value),
      isNull: safe((value: unknown) => value === null || value === undefined),
      isNullOrEmpty: safe((value: unknown) => value === null || value === undefined
        || (typeof value === "string" || Array.isArray(value) ? value.length === 0 : isRecord(value) ? Object.keys(value).length === 0 : false)),
      isNullOrBlank: safe((value: unknown) => value === null || value === undefined || String(value).trim().length === 0),
      typeOf: safe((value: unknown) => value === null ? "Null" : Array.isArray(value) ? "List" : isRecord(value) ? "Map" : typeof value),
      escapeJavaScript: safe((value: unknown) => JSON.stringify(String(value)).slice(1, -1).replace(/'/g, "\\'")),
      base64Encode: safe((value: unknown) => Buffer.from(String(value), "utf8").toString("base64")),
      base64Decode: safe((value: unknown) => Buffer.from(String(value), "base64").toString("utf8")),
      urlEncode: safe((value: unknown) => encodeURIComponent(String(value))),
      urlDecode: safe((value: unknown) => decodeURIComponent(String(value))),
      autoId: safe(() => randomUUID()),
      autoUlid: safe(() => randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()),
      autoKsuid: safe(() => randomUUID().replace(/-/g, "").slice(0, 27)),
      authType: safe(() => contextAuthType(this.scope.ctx as Record<string, unknown>)),
      validate: safe((condition: unknown, message: unknown, errorType?: unknown, data?: unknown) => {
        if (!condition) throw new AppSyncVtlError(String(message), errorType === undefined ? "CustomTemplateException" : String(errorType), clone(data));
        return "";
      }),
      error: safe((message: unknown, errorType?: unknown, data?: unknown, errorInfo?: unknown) => {
        throw new AppSyncVtlError(String(message), errorType === undefined ? "CustomTemplateException" : String(errorType), clone(data), clone(errorInfo));
      }),
      unauthorized: safe(() => {
        throw new AppSyncVtlError("You are not authorized to make this call.", "Unauthorized");
      }),
      appendError: safe(addError),
      qr: safe((_value: unknown) => ""),
      quiet: safe((_value: unknown) => ""),
      time: {
        nowISO8601: safe(() => new Date(this.now).toISOString()),
        nowEpochSeconds: safe(() => Math.floor(this.now / 1000)),
        nowEpochMilliSeconds: safe(() => this.now),
      },
      log: {
        info: safe((...values: unknown[]) => log("INFO", values)),
        error: safe((...values: unknown[]) => log("ERROR", values)),
        debug: safe((...values: unknown[]) => log("DEBUG", values)),
      },
      dynamodb,
      transform,
      list,
      map,
    };
  }
}

function cleanTemplate(template: string): string {
  if (Buffer.byteLength(template, "utf8") > TEMPLATE_LIMIT) {
    throw new AppSyncVtlError("Mapping template exceeds the 64 KiB local limit.");
  }
  if (/#(macro|parse|include|evaluate|define|stop|break)\b/.test(template)) {
    throw new AppSyncVtlError("The mapping template uses an unsupported VTL directive.");
  }
  return template
    .replace(/#\*[\s\S]*?\*#/g, "")
    .replace(/##[^\n]*(?=\n|$)/g, "");
}

function assertUniqueJsonKeys(text: string): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const string = (): string => {
    const start = index;
    if (text[index++] !== "\"") throw new Error();
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index++] === "\"") return JSON.parse(text.slice(start, index));
    }
    throw new Error();
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") {
      index++;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index++;
        return;
      }
      while (index < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new AppSyncVtlError(`The mapping template produced duplicate JSON key ${key}.`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") throw new Error();
        value();
        whitespace();
        if (text[index] === "}") {
          index++;
          return;
        }
        if (text[index++] !== ",") throw new Error();
      }
      throw new Error();
    }
    if (text[index] === "[") {
      index++;
      whitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        if (text[index] === "]") {
          index++;
          return;
        }
        if (text[index++] !== ",") throw new Error();
      }
      throw new Error();
    }
    if (text[index] === "\"") {
      string();
      return;
    }
    const primitive = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!primitive) throw new Error();
    index += primitive[0].length;
  };
  try {
    value();
    whitespace();
    if (index !== text.length) throw new Error();
  } catch (error) {
    if (error instanceof AppSyncVtlError) throw error;
    // JSON.parse below owns the canonical syntax error.
  }
}

export function evaluateAppSyncVtl(
  template: string,
  context: AppSyncVtlContext,
  now = Date.now(),
): AppSyncVtlEvaluation {
  const runtime = new Runtime(context, now);
  let rendered: string;
  try {
    rendered = runtime.render(cleanTemplate(template));
  } catch (error) {
    if (error instanceof ReturnSignal) {
      let returned = error.value;
      if (typeof returned === "string") {
        const candidate = returned.trim();
        if (/^(?:[\[{\"]|true$|false$|null$|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$)/.test(candidate)) {
          try { returned = JSON.parse(candidate); }
          catch { throw new AppSyncVtlError("The mapping template must produce exactly one strict JSON document."); }
        }
      }
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(returned);
      } catch {
        // The common strict-output error below owns this failure.
      }
      if (encoded === undefined) {
        throw new AppSyncVtlError("The mapping template must produce exactly one strict JSON document.");
      }
      if (Buffer.byteLength(encoded, "utf8") > OUTPUT_LIMIT) {
        throw new AppSyncVtlError("Mapping-template output exceeds the 256 KiB local limit.");
      }
      return {
        value: JSON.parse(encoded),
        returned: true,
        stash: context.stash,
        appendedErrors: runtime.appendedErrors,
        logs: runtime.logs,
        ...(runtime.subscriptionFilter === undefined ? {} : { subscriptionFilter: runtime.subscriptionFilter }),
      };
    }
    throw error;
  }
  if (Buffer.byteLength(rendered, "utf8") > OUTPUT_LIMIT) {
    throw new AppSyncVtlError("Mapping-template output exceeds the 256 KiB local limit.");
  }
  let value: unknown;
  assertUniqueJsonKeys(rendered);
  try {
    value = JSON.parse(rendered);
  } catch {
    throw new AppSyncVtlError("The mapping template must produce exactly one strict JSON document.");
  }
  return {
    value,
    returned: false,
    stash: context.stash,
    appendedErrors: runtime.appendedErrors,
    logs: runtime.logs,
    ...(runtime.subscriptionFilter === undefined ? {} : { subscriptionFilter: runtime.subscriptionFilter }),
  };
}

export function validateAppSyncVtl(template: string): void {
  cleanTemplate(template);
  // Parse and evaluate against a deliberately populated context so invalid
  // directives, references, utility calls, and non-JSON output fail at control time.
  evaluateAppSyncVtl(template, {
    arguments: { id: "validation", input: { id: "validation", value: "value" }, limit: 1, nextToken: null },
    source: { id: "source" },
    result: { id: "result", items: [], nextToken: null },
    error: null,
    identity: null,
    stash: { conditions: [], hasAuth: true, first: true, metadata: {}, connectionAttributes: [], adminRoles: [] },
    prev: { result: null },
    request: { headers: {} },
    info: { fieldName: "field", parentTypeName: "Query", variables: {} },
    authType: "API Key Authorization",
  }, 0);
}
