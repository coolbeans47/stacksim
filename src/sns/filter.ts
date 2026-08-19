import { cidrMatches, validIpOrCidr } from "../core/ip.js";
import { AwsError } from "../errors.js";
import type { SnsMessageAttributeState } from "../types.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const MAX_POLICY_BYTES = 262_144;
const MAX_LEAF_KEYS = 5;
const MAX_COMBINATIONS = 150;
const MAX_WILDCARD_COMPLEXITY = 100;
const MIN_NUMBER = -1_000_000_000;
const MAX_NUMBER = 1_000_000_000;

function invalid(message: string): never {
  throw new AwsError("InvalidParameter", `Invalid parameter: FilterPolicy: ${message}`, 400);
}

class StrictJsonParser {
  private offset = 0;
  constructor(private readonly source: string) {}

  parse(): JsonValue {
    const value = this.value();
    this.space();
    if (this.offset !== this.source.length) invalid(`invalid JSON at byte ${this.offset}.`);
    return value;
  }

  private value(): JsonValue {
    this.space();
    const next = this.source[this.offset];
    if (next === "{") return this.object();
    if (next === "[") return this.array();
    if (next === "\"") return this.string();
    if (next === "t" && this.literal("true")) return true;
    if (next === "f" && this.literal("false")) return false;
    if (next === "n" && this.literal("null")) return null;
    const matched = this.source.slice(this.offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!matched) invalid(`invalid JSON at byte ${this.offset}.`);
    this.offset += matched[0].length;
    const number = Number(matched[0]);
    if (!Number.isFinite(number)) invalid("numbers must be finite.");
    return number;
  }

  private object(): JsonObject {
    this.offset++;
    const output: JsonObject = {};
    const names = new Set<string>();
    this.space();
    if (this.source[this.offset] === "}") { this.offset++; return output; }
    while (true) {
      this.space();
      if (this.source[this.offset] !== "\"") invalid(`object key expected at byte ${this.offset}.`);
      const key = this.string();
      if (names.has(key)) invalid(`duplicate key "${key}".`);
      names.add(key);
      this.space();
      if (this.source[this.offset++] !== ":") invalid(`":" expected at byte ${this.offset - 1}.`);
      output[key] = this.value();
      this.space();
      const separator = this.source[this.offset++];
      if (separator === "}") return output;
      if (separator !== ",") invalid(`"," expected at byte ${this.offset - 1}.`);
    }
  }

  private array(): JsonValue[] {
    this.offset++;
    const output: JsonValue[] = [];
    this.space();
    if (this.source[this.offset] === "]") { this.offset++; return output; }
    while (true) {
      output.push(this.value());
      this.space();
      const separator = this.source[this.offset++];
      if (separator === "]") return output;
      if (separator !== ",") invalid(`"," expected at byte ${this.offset - 1}.`);
    }
  }

  private string(): string {
    const start = this.offset++;
    let escaped = false;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") {
        try { return JSON.parse(this.source.slice(start, this.offset)); }
        catch { invalid(`invalid string at byte ${start}.`); }
      } else if (char.charCodeAt(0) < 0x20) invalid(`control character in string at byte ${this.offset - 1}.`);
    }
    invalid(`unterminated string at byte ${start}.`);
  }

  private literal(value: string): boolean {
    if (!this.source.startsWith(value, this.offset)) return false;
    this.offset += value.length;
    return true;
  }

  private space(): void {
    while (/\s/.test(this.source[this.offset] ?? "")) this.offset++;
  }
}

function object(value: JsonValue): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function primitive(value: JsonValue): value is JsonPrimitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

const OPERATORS = new Set(["anything-but", "prefix", "suffix", "wildcard", "equals-ignore-case", "numeric", "cidr", "exists"]);

function operatorObject(value: JsonValue): value is JsonObject {
  return object(value) && Object.keys(value).length === 1 && OPERATORS.has(Object.keys(value)[0]);
}

function decimals(value: number): number {
  const source = String(value).toLowerCase();
  if (source.includes("e")) {
    const [mantissa, exponentSource] = source.split("e");
    return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponentSource));
  }
  return source.split(".")[1]?.length ?? 0;
}

function validateNumber(value: JsonValue): asserts value is number {
  if (typeof value !== "number" || value < MIN_NUMBER || value > MAX_NUMBER || decimals(value) > 5) {
    invalid("numeric values must be between -1000000000 and 1000000000 with at most five decimal places.");
  }
}

function wildcardPoints(pattern: string): number {
  const count = [...pattern].filter(char => char === "*" || char === "?").length;
  if (count > 3) invalid("a wildcard pattern may contain at most three wildcard characters.");
  return count <= 1 ? count : count * 3;
}

function validateOperator(value: JsonObject): number {
  const [name, operand] = Object.entries(value)[0];
  if (name === "exists") {
    if (typeof operand !== "boolean") invalid("exists must contain a boolean.");
    return 0;
  }
  if (name === "numeric") {
    if (!Array.isArray(operand) || operand.length < 2 || operand.length > 4 || operand.length % 2 !== 0) invalid("numeric must contain one or two operator/value pairs.");
    for (let index = 0; index < operand.length; index += 2) {
      if (!["=", ">", ">=", "<", "<="].includes(String(operand[index]))) invalid("numeric contains an unsupported comparison operator.");
      validateNumber(operand[index + 1]);
    }
    return 0;
  }
  if (name === "anything-but") {
    if (primitive(operand)) return 0;
    if (Array.isArray(operand)) {
      if (!operand.length || operand.some(item => !primitive(item))) invalid("anything-but arrays may contain only scalar values.");
      if (new Set(operand.map(item => item === null ? "null" : typeof item)).size !== 1) invalid("anything-but arrays must contain values of one JSON type.");
      return 0;
    }
    if (!object(operand) || Object.keys(operand).length !== 1 || !["prefix", "suffix", "wildcard", "equals-ignore-case"].includes(Object.keys(operand)[0])) {
      invalid("anything-but contains an unsupported matcher.");
    }
    return 1 + validateOperator(operand);
  }
  if (typeof operand !== "string" || !operand) invalid(`${name} must contain a non-empty string.`);
  if (name === "wildcard") return wildcardPoints(operand);
  if (name === "cidr" && !validIpOrCidr(operand)) invalid("cidr must contain an IP address or CIDR.");
  return 0;
}

interface Complexity {
  leaves: Set<string>;
  combinations: number;
  wildcard: number;
}

function validateObject(policy: JsonObject, scope: "MessageAttributes" | "MessageBody", path: string[], seenOr: boolean): Complexity {
  if (!Object.keys(policy).length) invalid("the policy object may not be empty.");
  let combinations = 1;
  let wildcard = 0;
  const leaves = new Set<string>();
  for (const [key, value] of Object.entries(policy)) {
    if (!key) invalid("field names may not be empty.");
    if (key === "$or") {
      if (seenOr) invalid("$or may not be nested inside another $or branch.");
      if (!Array.isArray(value) || value.length < 2 || value.some(branch => !object(branch))) invalid("$or must contain at least two policy objects.");
      let branchCombinations = 0;
      for (const branch of value as JsonObject[]) {
        const part = validateObject(branch, scope, path, true);
        part.leaves.forEach(item => leaves.add(item));
        branchCombinations += part.combinations;
        wildcard += part.wildcard;
      }
      combinations *= branchCombinations;
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) invalid(`"${[...path, key].join(".")}" must contain at least one matcher.`);
      for (const matcher of value) {
        if (primitive(matcher)) {
          if (typeof matcher === "number") validateNumber(matcher);
        } else if (operatorObject(matcher)) wildcard += validateOperator(matcher);
        else invalid(`"${[...path, key].join(".")}" contains an invalid matcher.`);
      }
      leaves.add([...path, key].join("."));
      combinations *= value.length;
      continue;
    }
    if (scope !== "MessageBody" || !object(value) || operatorObject(value)) invalid(`"${[...path, key].join(".")}" must contain an array of matchers.`);
    const nested = validateObject(value, scope, [...path, key], seenOr);
    nested.leaves.forEach(item => leaves.add(item));
    combinations *= nested.combinations;
    wildcard += nested.wildcard;
  }
  return { leaves, combinations, wildcard };
}

export interface ValidatedFilterPolicy {
  source: string;
  value: JsonObject;
  leafKeys: number;
  combinations: number;
  wildcardComplexity: number;
}

export function validateFilterPolicy(source: unknown, scope: "MessageAttributes" | "MessageBody"): ValidatedFilterPolicy {
  const text = String(source ?? "");
  if (!text || Buffer.byteLength(text) > MAX_POLICY_BYTES) invalid(`policy size must be between 1 and ${MAX_POLICY_BYTES} bytes.`);
  const parsed = new StrictJsonParser(text).parse();
  if (!object(parsed)) invalid("the top-level value must be an object.");
  const complexity = validateObject(parsed, scope, [], false);
  if (complexity.leaves.size > MAX_LEAF_KEYS) invalid(`a policy may contain at most ${MAX_LEAF_KEYS} leaf keys.`);
  if (complexity.combinations > MAX_COMBINATIONS) invalid(`policy combinations may not exceed ${MAX_COMBINATIONS}.`);
  if (complexity.wildcard > MAX_WILDCARD_COMPLEXITY) invalid(`wildcard complexity may not exceed ${MAX_WILDCARD_COMPLEXITY}.`);
  return {
    source: JSON.stringify(parsed),
    value: parsed,
    leafKeys: complexity.leaves.size,
    combinations: complexity.combinations,
    wildcardComplexity: complexity.wildcard,
  };
}

function glob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[\\^$+.[\]{}()|]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function oneOperator(operator: JsonObject, candidate: JsonPrimitive, present: boolean): boolean {
  const [name, operand] = Object.entries(operator)[0];
  if (name === "exists") return operand === present;
  if (!present) return false;
  if (name === "prefix") return typeof candidate === "string" && candidate.startsWith(String(operand));
  if (name === "suffix") return typeof candidate === "string" && candidate.endsWith(String(operand));
  if (name === "wildcard") return typeof candidate === "string" && glob(String(operand), candidate);
  if (name === "equals-ignore-case") return typeof candidate === "string" && candidate.toLocaleLowerCase("en-US") === String(operand).toLocaleLowerCase("en-US");
  if (name === "cidr") return typeof candidate === "string" && cidrMatches(candidate, String(operand));
  if (name === "numeric") {
    if (typeof candidate !== "number" || !Array.isArray(operand)) return false;
    for (let index = 0; index < operand.length; index += 2) {
      const expected = Number(operand[index + 1]);
      const operation = operand[index];
      if (operation === "=" && candidate !== expected) return false;
      if (operation === ">" && !(candidate > expected)) return false;
      if (operation === ">=" && !(candidate >= expected)) return false;
      if (operation === "<" && !(candidate < expected)) return false;
      if (operation === "<=" && !(candidate <= expected)) return false;
    }
    return true;
  }
  if (name === "anything-but") {
    const denied = Array.isArray(operand) ? operand : [operand];
    return denied.every(item => object(item)
      ? !oneOperator(item, candidate, true)
      : typeof candidate === typeof item && candidate !== item);
  }
  return false;
}

function leafMatch(matchers: JsonValue[], candidates: JsonPrimitive[], present: boolean): boolean {
  if (!present) return matchers.some(item => operatorObject(item) && oneOperator(item, null, false));
  return candidates.some(candidate => matchers.some(matcher =>
    primitive(matcher) ? matcher === candidate : operatorObject(matcher) && oneOperator(matcher, candidate, true)));
}

function policyMatch(policy: JsonObject, payload: JsonObject): boolean {
  for (const [key, matchers] of Object.entries(policy)) {
    if (key === "$or") {
      if (!(matchers as JsonObject[]).some(branch => policyMatch(branch, payload))) return false;
      continue;
    }
    const candidate = payload[key];
    if (Array.isArray(matchers)) {
      const candidates = Array.isArray(candidate)
        ? candidate.filter(primitive)
        : primitive(candidate) ? [candidate] : [];
      if (!leafMatch(matchers, candidates, Object.hasOwn(payload, key))) return false;
    } else {
      if (!object(candidate) || !object(matchers) || !policyMatch(matchers, candidate)) return false;
    }
  }
  return true;
}

function attributePayload(attributes: Record<string, SnsMessageAttributeState>): JsonObject {
  const result: JsonObject = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    if (attribute.dataType.split(".", 1)[0] === "Binary") continue;
    if (attribute.dataType === "String.Array") {
      try {
        const values = JSON.parse(attribute.stringValue ?? "");
        if (Array.isArray(values)) result[name] = values.filter(primitive);
      } catch {}
    } else if (attribute.dataType.split(".", 1)[0] === "Number") {
      const value = Number(attribute.stringValue);
      if (Number.isFinite(value)) result[name] = value;
    } else result[name] = attribute.stringValue ?? "";
  }
  return result;
}

export function filterMatches(
  source: string | undefined,
  scope: "MessageAttributes" | "MessageBody",
  attributes: Record<string, SnsMessageAttributeState>,
  message: string,
): boolean {
  return filterMatchResult(source, scope, attributes, message).matches;
}

export function filterMatchResult(
  source: string | undefined,
  scope: "MessageAttributes" | "MessageBody",
  attributes: Record<string, SnsMessageAttributeState>,
  message: string,
): { matches: boolean; invalidMessageBody: boolean } {
  if (!source) return { matches: true, invalidMessageBody: false };
  const policy = validateFilterPolicy(source, scope).value;
  if (scope === "MessageAttributes") return { matches: policyMatch(policy, attributePayload(attributes)), invalidMessageBody: false };
  let body: unknown;
  try { body = JSON.parse(message); } catch { return { matches: false, invalidMessageBody: true }; }
  if (!object(body as JsonValue)) return { matches: false, invalidMessageBody: true };
  return { matches: policyMatch(policy, body as JsonObject), invalidMessageBody: false };
}
