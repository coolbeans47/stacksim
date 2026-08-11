import { createHash, randomUUID } from "node:crypto";

export const DISCARD = Symbol("StepFunctions.Discard");

export interface AslContext {
  Execution: { Id: string; Input: unknown; Name: string; RoleArn: string; StartTime: string };
  State: { EnteredTime: string; Name: string; RetryCount: number };
  StateMachine: { Id: string; Name: string };
  Map?: { Item: { Index: number; Value: unknown; Key?: string | number; Source?: string } };
  Task?: { Token: string };
}

function tokens(path: string): Array<string | number> {
  if (path === "$" || path === "$$") return [];
  if (!path.startsWith("$")) throw new Error(`Invalid JSONPath '${path}'`);
  const result: Array<string | number> = [];
  const expression = path.replace(/^\$\$?/, "");
  const pattern = /(?:\.([A-Za-z0-9_-]+)|\[['"]((?:\\.|[^'"])*)['"]\]|\[(\d+)\])/g;
  let cursor = 0;
  for (const match of expression.matchAll(pattern)) {
    if (match.index !== cursor) throw new Error(`Unsupported JSONPath '${path}'`);
    result.push(match[1] ?? (match[2] !== undefined ? match[2].replace(/\\(['"\\])/g, "$1") : Number(match[3])));
    cursor = match.index + match[0].length;
  }
  if (cursor !== expression.length) throw new Error(`Unsupported JSONPath '${path}'`);
  return result;
}

export function isReferencePath(path: unknown): path is string {
  if (typeof path !== "string" || !/^\$\$?/.test(path)) return false;
  try { tokens(path); return true; } catch { return false; }
}

export function getPath(input: unknown, path: string, context?: AslContext): unknown {
  if (path === "$") return input;
  if (path === "$$") return context;
  let value: any = path.startsWith("$$") ? context : input;
  for (const token of tokens(path)) {
    if (value === null || value === undefined || typeof value !== "object" || !(token in value)) throw new Error(`JSONPath '${path}' could not be found`);
    value = value[token as any];
  }
  return value;
}

export function setPath(input: unknown, path: string | null | undefined, value: unknown): unknown {
  if (path === null) return input;
  if (path === undefined || path === "$") return value;
  if (!isReferencePath(path) || path.startsWith("$$")) throw new Error(`ResultPath '${path}' must be a reference path`);
  const result: any = structuredClone(input);
  const pathTokens = tokens(path);
  if (!pathTokens.length) return value;
  let parent = result;
  for (let index = 0; index < pathTokens.length - 1; index++) {
    const key = pathTokens[index]; const next = pathTokens[index + 1];
    if (parent === null || typeof parent !== "object") throw new Error(`ResultPath '${path}' cannot be applied`);
    if (parent[key as any] === undefined) parent[key as any] = typeof next === "number" ? [] : {};
    parent = parent[key as any];
  }
  parent[pathTokens.at(-1) as any] = value;
  return result;
}

function splitArguments(value: string): string[] {
  const output: string[] = []; let quote = ""; let depth = 0; let start = 0; let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) { output.push(value.slice(start, index).trim()); start = index + 1; }
  }
  output.push(value.slice(start).trim());
  return output.filter(argument => argument.length > 0);
}

function intrinsicArgument(value: string, input: unknown, context: AslContext): unknown {
  if (value.startsWith("States.")) return evaluateIntrinsic(value, input, context);
  if (value.startsWith("$")) return getPath(input, value, context);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  if (value.startsWith('"')) return JSON.parse(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  throw new Error(`Invalid intrinsic argument '${value}'`);
}

export function evaluateIntrinsic(expression: string, input: unknown, context: AslContext): unknown {
  const match = expression.match(/^States\.([A-Za-z]+)\((.*)\)$/s);
  if (!match) throw new Error(`Invalid intrinsic expression '${expression}'`);
  const args = splitArguments(match[2]).map(argument => intrinsicArgument(argument, input, context));
  switch (match[1]) {
    case "Format": {
      const [format, ...values] = args; let index = 0;
      if (typeof format !== "string") throw new Error("States.Format requires a string");
      return format.replace(/\{\}/g, () => String(values[index++]));
    }
    case "StringToJson": return JSON.parse(String(args[0]));
    case "JsonToString": return JSON.stringify(args[0]);
    case "Array": return args;
    case "ArrayPartition": { const size = Number(args[1]); if (!Array.isArray(args[0]) || !Number.isInteger(size) || size <= 0) throw new Error("Invalid States.ArrayPartition arguments"); const result = []; for (let i = 0; i < args[0].length; i += size) result.push(args[0].slice(i, i + size)); return result; }
    case "ArrayContains": return Array.isArray(args[0]) && args[0].some(item => JSON.stringify(item) === JSON.stringify(args[1]));
    case "ArrayRange": { const [start, end, step = 1] = args.map(Number); if (!Number.isInteger(step) || step === 0) throw new Error("Invalid States.ArrayRange step"); const result = []; for (let value = start; step > 0 ? value <= end : value >= end; value += step) result.push(value); return result; }
    case "ArrayGetItem": { if (!Array.isArray(args[0])) throw new Error("States.ArrayGetItem requires an array"); return args[0][Number(args[1])]; }
    case "ArrayLength": { if (!Array.isArray(args[0])) throw new Error("States.ArrayLength requires an array"); return args[0].length; }
    case "ArrayUnique": { if (!Array.isArray(args[0])) throw new Error("States.ArrayUnique requires an array"); const seen = new Set<string>(); return args[0].filter(item => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; }); }
    case "Base64Encode": return Buffer.from(String(args[0])).toString("base64");
    case "Base64Decode": return Buffer.from(String(args[0]), "base64").toString("utf8");
    case "Hash": return createHash(String(args[1]).toLowerCase().replace("-", "")).update(String(args[0])).digest("hex");
    case "JsonMerge": return args[2] === false ? { ...(args[0] as object), ...(args[1] as object) } : (() => { throw new Error("States.JsonMerge supports shallow mode only"); })();
    case "MathAdd": return Number(args[0]) + Number(args[1]);
    case "MathRandom": { const [start, end] = args.map(Number); return Math.floor(Math.random() * (end - start)) + start; }
    case "StringSplit": return String(args[0]).split(new RegExp(`[${String(args[1]).replace(/[\\\]\-^]/g, "\\$&")}]`));
    case "UUID": return randomUUID();
    default: throw new Error(`Unsupported intrinsic States.${match[1]}`);
  }
}

export function payloadTemplate(template: unknown, input: unknown, context: AslContext): unknown {
  if (Array.isArray(template)) return template.map(item => payloadTemplate(item, input, context));
  if (!template || typeof template !== "object") return template;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (!key.endsWith(".$")) output[key] = payloadTemplate(value, input, context);
    else {
      if (typeof value !== "string") throw new Error(`${key} must contain a path or intrinsic expression`);
      output[key.slice(0, -2)] = value.startsWith("States.") ? evaluateIntrinsic(value, input, context) : getPath(input, value, context);
    }
  }
  return output;
}

export function stateInput(state: any, input: unknown, context: AslContext): unknown {
  const selected = state.InputPath === null ? {} : state.InputPath === undefined ? input : getPath(input, state.InputPath, context);
  return state.Parameters === undefined ? selected : payloadTemplate(state.Parameters, selected, context);
}

export function stateOutput(state: any, originalInput: unknown, result: unknown, context: AslContext): unknown {
  const selected = state.ResultSelector === undefined ? result : payloadTemplate(state.ResultSelector, result, context);
  const combined = setPath(originalInput, state.ResultPath, selected);
  return state.OutputPath === null ? {} : state.OutputPath === undefined ? combined : getPath(combined, state.OutputPath, context);
}

function wildcard(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(value);
}

export function matchesChoice(rule: any, input: unknown, context: AslContext): boolean {
  if (Array.isArray(rule.And)) return rule.And.every((item: any) => matchesChoice(item, input, context));
  if (Array.isArray(rule.Or)) return rule.Or.some((item: any) => matchesChoice(item, input, context));
  if (rule.Not) return !matchesChoice(rule.Not, input, context);
  let actual: unknown;
  try { actual = getPath(input, rule.Variable, context); }
  catch { return rule.IsPresent === false; }
  if (rule.IsPresent !== undefined) return rule.IsPresent;
  if (rule.IsNull !== undefined) return (actual === null) === rule.IsNull;
  if (rule.IsString !== undefined) return (typeof actual === "string") === rule.IsString;
  if (rule.IsNumeric !== undefined) return (typeof actual === "number") === rule.IsNumeric;
  if (rule.IsBoolean !== undefined) return (typeof actual === "boolean") === rule.IsBoolean;
  if (rule.IsTimestamp !== undefined) return (typeof actual === "string" && Number.isFinite(Date.parse(actual))) === rule.IsTimestamp;
  const entry = Object.entries(rule).find(([key]) => !["Variable", "Next", "Comment"].includes(key));
  if (!entry) return false;
  const [operator, expectedValue] = entry; const expected = operator.endsWith("Path") ? getPath(input, String(expectedValue), context) : expectedValue;
  const op = operator.replace(/Path$/, "");
  if (op === "StringMatches") return typeof actual === "string" && wildcard(String(expected), actual);
  if (op === "StringEqualsIgnoreCase") return typeof actual === "string" && typeof expected === "string" && actual.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US");
  let left: any = actual; let right: any = expected;
  if (op.startsWith("Numeric") && (typeof left !== "number" || typeof right !== "number")) return false;
  if (op.startsWith("String") && (typeof left !== "string" || typeof right !== "string")) return false;
  if (op.startsWith("Boolean") && (typeof left !== "boolean" || typeof right !== "boolean")) return false;
  if (op.startsWith("Timestamp")) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    left = Date.parse(left); right = Date.parse(right); if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  }
  if (op.endsWith("Equals") || op === "BooleanEquals") return left === right;
  if (op.endsWith("LessThan")) return left < right;
  if (op.endsWith("LessThanEquals")) return left <= right;
  if (op.endsWith("GreaterThan")) return left > right;
  if (op.endsWith("GreaterThanEquals")) return left >= right;
  return false;
}
