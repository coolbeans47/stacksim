import { AwsError } from "./errors.js";
import type { CloudWatchAlarmStateValue } from "./types.js";

type RuleNode =
  | { kind: "constant"; value: boolean }
  | { kind: "state"; state: CloudWatchAlarmStateValue; reference: string }
  | { kind: "not"; value: RuleNode }
  | { kind: "and" | "or"; left: RuleNode; right: RuleNode };

type Token = { kind: "word" | "quoted" | "(" | ")"; value: string };

export interface ParsedAlarmRule {
  children: string[];
  elements: number;
  evaluate(resolve: (reference: string) => CloudWatchAlarmStateValue): boolean;
}

function invalid(message = "AlarmRule is invalid"): never { throw new AwsError("InvalidParameterValue", message); }

function tokens(input: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < input.length;) {
    if (/\s/.test(input[index])) { index++; continue; }
    if (input[index] === "(" || input[index] === ")") { result.push({ kind: input[index] as "(" | ")", value: input[index] }); index++; continue; }
    if (input[index] === '"') {
      const start = index++; let escaped = false;
      while (index < input.length) { const character = input[index++]; if (!escaped && character === '"') break; escaped = !escaped && character === "\\"; if (character !== "\\") escaped = false; }
      if (input[index - 1] !== '"') invalid("AlarmRule contains an unterminated alarm name");
      try { result.push({ kind: "quoted", value: JSON.parse(input.slice(start, index)) }); } catch { invalid("AlarmRule contains an invalid quoted alarm name"); }
      continue;
    }
    const start = index; while (index < input.length && !/[\s()]/.test(input[index])) index++;
    result.push({ kind: "word", value: input.slice(start, index) });
  }
  return result;
}

class Parser {
  private index = 0;
  private elementCount = 0;
  readonly children = new Set<string>();

  constructor(private readonly values: Token[]) {}

  parse(): RuleNode {
    const result = this.or();
    if (this.index !== this.values.length) invalid();
    if (this.children.size > 100) invalid("AlarmRule can reference at most 100 child alarms");
    if (this.elementCount > 500) invalid("AlarmRule can contain at most 500 elements");
    return result;
  }

  get elements(): number { return this.elementCount; }

  private or(): RuleNode {
    let value = this.and();
    while (this.keyword("OR")) value = { kind: "or", left: value, right: this.and() };
    return value;
  }

  private and(): RuleNode {
    let value = this.not();
    while (this.keyword("AND")) value = { kind: "and", left: value, right: this.not() };
    return value;
  }

  private not(): RuleNode {
    if (this.keyword("NOT")) return { kind: "not", value: this.not() };
    return this.primary();
  }

  private primary(): RuleNode {
    const token = this.values[this.index]; if (!token) invalid();
    if (token.kind === "(") { this.index++; this.elementCount++; const value = this.or(); this.expect(")"); this.elementCount++; return value; }
    if (token.kind !== "word") invalid();
    const keyword = token.value.toUpperCase();
    if (keyword === "TRUE" || keyword === "FALSE") { this.index++; this.elementCount++; return { kind: "constant", value: keyword === "TRUE" }; }
    const states: Record<string, CloudWatchAlarmStateValue> = { ALARM: "ALARM", OK: "OK", INSUFFICIENT_DATA: "INSUFFICIENT_DATA" };
    const state = states[keyword]; if (!state) invalid(); this.index++; this.expect("(");
    const reference = this.values[this.index++]; if (!reference || !["word", "quoted"].includes(reference.kind) || !reference.value) invalid("AlarmRule contains an invalid child alarm reference"); this.expect(")");
    this.elementCount++; this.children.add(reference.value); return { kind: "state", state, reference: reference.value };
  }

  private keyword(value: string): boolean { const token = this.values[this.index]; if (token?.kind !== "word" || token.value.toUpperCase() !== value) return false; this.index++; return true; }
  private expect(kind: "(" | ")"): void { if (this.values[this.index]?.kind !== kind) invalid(); this.index++; }
}

function evaluate(node: RuleNode, resolve: (reference: string) => CloudWatchAlarmStateValue): boolean {
  if (node.kind === "constant") return node.value;
  if (node.kind === "state") return resolve(node.reference) === node.state;
  if (node.kind === "not") return !evaluate(node.value, resolve);
  if (node.kind === "and") return evaluate(node.left, resolve) && evaluate(node.right, resolve);
  return evaluate(node.left, resolve) || evaluate(node.right, resolve);
}

export function parseAlarmRule(value: unknown): ParsedAlarmRule {
  const input = String(value ?? ""); if (!input || input.length > 10_240) invalid("AlarmRule must contain between 1 and 10240 characters");
  const parser = new Parser(tokens(input)); const root = parser.parse();
  return { children: [...parser.children], elements: parser.elements, evaluate: resolve => evaluate(root, resolve) };
}
