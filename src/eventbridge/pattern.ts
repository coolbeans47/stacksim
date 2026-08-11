import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

export type EventPattern = Record<string, unknown>;

const RAW_NUMBER = Symbol("EventBridgeRawNumber");
interface RawNumber { [RAW_NUMBER]: true; raw: string; value: number }

function isRawNumber(value: unknown): value is RawNumber { return Boolean(value && typeof value === "object" && (value as RawNumber)[RAW_NUMBER]); }
function isNumber(value: unknown): value is number | RawNumber { return typeof value === "number" || isRawNumber(value); }
function numberValue(value: number | RawNumber): number { return isRawNumber(value) ? value.value : value; }
function numberLexeme(value: number | RawNumber): string { return isRawNumber(value) ? value.raw : JSON.stringify(value); }

export function isEventJsonNumber(value: unknown): boolean { return isRawNumber(value); }

/** Serialize a parsed event without normalizing its JSON number tokens. */
export function stringifyEventJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown, inArray = false): string | undefined => {
    if (isRawNumber(item)) return item.raw;
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : "null";
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") return inArray ? "null" : undefined;
    if (typeof item === "bigint") throw new TypeError("BigInt values cannot be serialized as JSON");
    if (typeof item !== "object") return undefined;
    if (ancestors.has(item)) throw new TypeError("Converting circular structure to JSON");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(value => encode(value, true) ?? "null").join(",")}]`;
      const fields: string[] = [];
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        const encoded = encode(child);
        if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${fields.join(",")}}`;
    } finally { ancestors.delete(item); }
  };
  const encoded = encode(value);
  if (encoded === undefined) throw new TypeError("Event payload is not JSON serializable");
  return encoded;
}

function parseLosslessJson(input: string): unknown {
  const sentinel = `__stacksim_eventbridge_number_${randomUUID()}__`; let transformed = ""; let inString = false; let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (inString) {
      transformed += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; transformed += character; continue; }
    if (character === "-" || /\d/.test(character)) {
      const match = input.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) { transformed += `{${JSON.stringify(sentinel)}:${JSON.stringify(match[0])}}`; index += match[0].length - 1; continue; }
    }
    transformed += character;
  }
  const revive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 1 && entries[0][0] === sentinel && typeof entries[0][1] === "string") return { [RAW_NUMBER]: true, raw: entries[0][1], value: Number(entries[0][1]) } satisfies RawNumber;
      return Object.fromEntries(entries.map(([key, item]) => [key, revive(item)]));
    }
    return value;
  };
  return revive(JSON.parse(transformed));
}

export function parseEventJson(eventJson: string): unknown {
  const event = parseLosslessJson(eventJson);
  const visit = (value: unknown): void => {
    if (isRawNumber(value)) {
      if (!Number.isFinite(value.value)) throw new TypeError("Event numbers must be finite");
      if (/^-?\d+$/.test(value.raw)) { const integer = BigInt(value.raw); if (integer < -9_223_372_036_854_775_808n || integer > 9_223_372_036_854_775_807n) throw new TypeError("Event integers must be within the signed 64-bit range"); }
      return;
    }
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(event); return event;
}

export class EventPatternValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventPatternValidationError";
  }
}

const MAX_DEPTH = 100;
const MAX_OR_COMBINATIONS = 1_000;
const NUMERIC_LIMIT = 5_000_000_000;
const OPERATOR_NAMES = new Set([
  "anything-but",
  "cidr",
  "equals-ignore-case",
  "exists",
  "numeric",
  "prefix",
  "suffix",
  "wildcard",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isRawNumber(value);
}

function fail(path: string, message: string): never {
  throw new EventPatternValidationError(`${message} at ${path}`);
}

function ownEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value);
}

function validateCaseInsensitiveAffix(value: unknown, path: string): void {
  if (typeof value === "string") return;
  if (!isObject(value)) fail(path, "expected a string or equals-ignore-case expression");
  const entries = ownEntries(value);
  if (entries.length !== 1 || entries[0][0] !== "equals-ignore-case" || typeof entries[0][1] !== "string") {
    fail(path, "expected an equals-ignore-case expression containing one string");
  }
}

function wildcardRegex(value: unknown, path: string): RegExp {
  if (typeof value !== "string") fail(path, "wildcard must be a string");
  let source = "^";
  let previousWildcard = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped !== "*" && escaped !== "\\") fail(path, "wildcard backslash may only escape '*' or '\\'");
      source += escaped === "*" ? "\\*" : "\\\\";
      index += 1;
      previousWildcard = false;
    } else if (character === "*") {
      if (previousWildcard) fail(path, "consecutive wildcard characters are not supported");
      source += "[\\s\\S]*";
      previousWildcard = true;
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      previousWildcard = false;
    }
  }
  return new RegExp(`${source}$`);
}

function parseIpv4(value: string): bigint | undefined {
  if (isIP(value) !== 4) return undefined;
  let result = 0n;
  for (const part of value.split(".")) result = (result << 8n) | BigInt(Number(part));
  return result;
}

function ipv6Groups(value: string): number[] | undefined {
  if (isIP(value) !== 6) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const expand = (side: string): number[] | undefined => {
    if (!side) return [];
    const result: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (ipv4 === undefined) return undefined;
        result.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
        result.push(Number.parseInt(part, 16));
      }
    }
    return result;
  };
  const left = expand(halves[0]);
  const right = expand(halves[1] ?? "");
  if (!left || !right) return undefined;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return undefined;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function parseIp(value: string): { bits: number; value: bigint } | undefined {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== undefined) return { bits: 32, value: ipv4 };
  const groups = ipv6Groups(value);
  if (!groups) return undefined;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(group);
  return { bits: 128, value: result };
}

function parseCidr(value: unknown, path: string): { bits: number; prefix: number; network: bigint } {
  if (typeof value !== "string") fail(path, "cidr must be a string");
  const pieces = value.split("/");
  const address = parseIp(pieces[0]);
  if (pieces.length !== 2 || !address || !/^\d+$/.test(pieces[1])) fail(path, "cidr must be a valid IPv4 or IPv6 network");
  const prefix = Number(pieces[1]);
  if (prefix < 0 || prefix > address.bits) fail(path, `cidr prefix must be between 0 and ${address.bits}`);
  const shift = BigInt(address.bits - prefix);
  return { bits: address.bits, prefix, network: (address.value >> shift) << shift };
}

function validateAnythingBut(value: unknown, path: string): void {
  if (typeof value === "string" || (isNumber(value) && Number.isFinite(numberValue(value)))) return;
  if (Array.isArray(value)) {
    if (value.length === 0) fail(path, "anything-but list must not be empty");
    let valueType: "string" | "number" | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item !== "string" && !(isNumber(item) && Number.isFinite(numberValue(item)))) {
        fail(`${path}[${index}]`, "anything-but list values must be strings or finite numbers");
      }
      const itemType = isNumber(item) ? "number" : "string"; if (valueType !== undefined && itemType !== valueType) fail(path, "anything-but list values must all have the same JSON type");
      valueType = itemType;
    }
    return;
  }
  if (!isObject(value)) fail(path, "anything-but must contain a string, number, list, or comparison expression");
  const entries = ownEntries(value);
  if (entries.length !== 1 || !["prefix", "suffix", "equals-ignore-case", "wildcard"].includes(entries[0][0])) {
    fail(path, "anything-but comparison must contain exactly one supported string operator");
  }
  const [operator, operand] = entries[0];
  if (operator === "prefix" || operator === "suffix") validateCaseInsensitiveAffix(operand, `${path}.${operator}`);
  else if (operator === "wildcard") wildcardRegex(operand, `${path}.wildcard`);
  else if (typeof operand !== "string") fail(`${path}.equals-ignore-case`, "equals-ignore-case must be a string");
}

function validateNumeric(value: unknown, path: string): void {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 4)) {
    fail(path, "numeric must contain one or two operator/value pairs");
  }
  for (let index = 0; index < value.length; index += 2) {
    const operator = value[index];
    const operand = value[index + 1];
    if (!["=", ">", ">=", "<", "<="].includes(operator as string)) fail(`${path}[${index}]`, "unsupported numeric operator");
    if (!isNumber(operand) || !Number.isFinite(numberValue(operand)) || Math.abs(numberValue(operand)) > NUMERIC_LIMIT) {
      fail(`${path}[${index + 1}]`, `numeric operand must be finite and between -${NUMERIC_LIMIT} and ${NUMERIC_LIMIT}`);
    }
    const raw = numberLexeme(operand as number | RawNumber).replace(/^-/, ""); const [coefficient, exponentText = "0"] = raw.toLowerCase().split("e"); const exponent = Number(exponentText); const [whole, fraction = ""] = coefficient.split("."); const significant = `${whole}${fraction}`.replace(/^0+/, "").length || 1; const fractionalDigits = Math.max(0, fraction.length - exponent);
    if (significant > 15 || fractionalDigits > 6) fail(`${path}[${index + 1}]`, "numeric operand supports at most 15 significant digits and six fractional digits");
  }
}

function validateMatcher(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (isNumber(value)) {
    if (!Number.isFinite(numberValue(value))) fail(path, "exact numeric values must be finite");
    return;
  }
  if (!isObject(value)) fail(path, "match values must be JSON primitives or comparison expressions");
  const entries = ownEntries(value);
  if (entries.length !== 1 || !OPERATOR_NAMES.has(entries[0][0])) {
    fail(path, "comparison expressions must contain exactly one supported operator");
  }
  const [operator, operand] = entries[0];
  switch (operator) {
    case "anything-but": validateAnythingBut(operand, `${path}.anything-but`); break;
    case "cidr": parseCidr(operand, `${path}.cidr`); break;
    case "equals-ignore-case":
      if (typeof operand !== "string") fail(`${path}.equals-ignore-case`, "equals-ignore-case must be a string");
      break;
    case "exists":
      if (typeof operand !== "boolean") fail(`${path}.exists`, "exists must be true or false");
      break;
    case "numeric": validateNumeric(operand, `${path}.numeric`); break;
    case "prefix": validateCaseInsensitiveAffix(operand, `${path}.prefix`); break;
    case "suffix": validateCaseInsensitiveAffix(operand, `${path}.suffix`); break;
    case "wildcard": wildcardRegex(operand, `${path}.wildcard`); break;
  }
}

function validateObject(value: Record<string, unknown>, path: string, depth: number, active: WeakSet<object>): number {
  if (depth > MAX_DEPTH) fail(path, `event pattern nesting exceeds ${MAX_DEPTH} levels`);
  if (active.has(value)) fail(path, "event pattern must not contain a cycle");
  active.add(value);
  let combinations = 1;
  for (const [key, field] of ownEntries(value)) {
    const fieldPath = key === "$or" ? `${path}.$or` : `${path}.${key}`;
    if (key === "$or") {
      if (!Array.isArray(field) || field.length === 0) fail(fieldPath, "$or must contain one or more object alternatives");
      let alternatives = 0;
      for (let index = 0; index < field.length; index += 1) {
        const branch = field[index];
        if (!isObject(branch)) fail(`${fieldPath}[${index}]`, "$or alternatives must be objects");
        alternatives += validateObject(branch, `${fieldPath}[${index}]`, depth + 1, active);
        if (alternatives > MAX_OR_COMBINATIONS) fail(fieldPath, `$or creates more than ${MAX_OR_COMBINATIONS} combinations`);
      }
      combinations *= alternatives;
    } else if (Array.isArray(field)) {
      if (field.length === 0) fail(fieldPath, "match arrays must not be empty");
      for (let index = 0; index < field.length; index += 1) validateMatcher(field[index], `${fieldPath}[${index}]`);
    } else if (isObject(field)) {
      combinations *= validateObject(field, fieldPath, depth + 1, active);
    } else {
      fail(fieldPath, "event pattern fields must contain an object or an array of match values");
    }
    if (combinations > MAX_OR_COMBINATIONS) fail(path, `$or creates more than ${MAX_OR_COMBINATIONS} combinations`);
  }
  active.delete(value);
  return combinations;
}

export function validateEventPattern(pattern: unknown): asserts pattern is EventPattern {
  if (!isObject(pattern)) fail("$", "event pattern must be a JSON object");
  validateObject(pattern, "$", 0, new WeakSet());
}

export function parseEventPattern(patternJson: string): EventPattern {
  let pattern: unknown;
  try {
    pattern = parseLosslessJson(patternJson);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new EventPatternValidationError(`Event pattern is not valid JSON: ${detail}`);
  }
  validateEventPattern(pattern);
  return pattern;
}

interface FieldLookup {
  present: boolean;
  values: unknown[];
}

function traversePath(object: Record<string, unknown>, parts: string[]): unknown | typeof MISSING {
  let current: unknown = object;
  for (const part of parts) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = current[part];
  }
  return current;
}

const MISSING = Symbol("missing");

function lookupField(event: Record<string, unknown>, key: string): FieldLookup {
  const values: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(event, key)) values.push(event[key]);
  if (key.includes(".")) {
    const nested = traversePath(event, key.split("."));
    if (nested !== MISSING && !values.includes(nested)) values.push(nested);
  }
  const prefix = `${key}.`;
  const dottedChildren = ownEntries(event).filter(([eventKey]) => eventKey.startsWith(prefix));
  if (dottedChildren.length > 0) {
    const synthetic = Object.fromEntries(dottedChildren.map(([eventKey, value]) => [eventKey.slice(prefix.length), value]));
    values.push(synthetic);
  }
  return { present: values.length > 0, values };
}

function caseInsensitiveAffix(value: unknown): { value: string; ignoreCase: boolean } {
  if (typeof value === "string") return { value, ignoreCase: false };
  return { value: (value as Record<string, string>)["equals-ignore-case"], ignoreCase: true };
}

function matchWildcard(pattern: unknown, candidate: unknown): boolean {
  return typeof candidate === "string" && wildcardRegex(pattern, "$.wildcard").test(candidate);
}

function exactMatch(pattern: unknown, candidate: unknown): boolean {
  if (isNumber(pattern) && isNumber(candidate)) return numberLexeme(pattern) === numberLexeme(candidate);
  return pattern === candidate && (pattern === null || ["string", "number", "boolean"].includes(typeof pattern));
}

function matchAnythingBut(blocked: unknown, candidate: unknown): boolean {
  if (Array.isArray(blocked)) {
    const candidateType = isNumber(candidate) ? "number" : typeof candidate; const sameType = blocked.some(value => (isNumber(value) ? "number" : typeof value) === candidateType);
    return sameType && !blocked.some(value => exactMatch(value, candidate));
  }
  if (isObject(blocked)) {
    if (typeof candidate !== "string") return false;
    const [operator, operand] = ownEntries(blocked)[0];
    return !matchStringOperator(operator, operand, candidate);
  }
  return (isNumber(blocked) ? "number" : typeof blocked) === (isNumber(candidate) ? "number" : typeof candidate) && !exactMatch(blocked, candidate);
}

function matchNumeric(comparisons: unknown, candidate: unknown): boolean {
  if (!isNumber(candidate) || !Number.isFinite(numberValue(candidate))) return false;
  const actual = numberValue(candidate);
  const values = comparisons as unknown[];
  for (let index = 0; index < values.length; index += 2) {
    const operator = values[index];
    const operand = numberValue(values[index + 1] as number | RawNumber);
    if (operator === "=" && actual !== operand) return false;
    if (operator === ">" && actual <= operand) return false;
    if (operator === ">=" && actual < operand) return false;
    if (operator === "<" && actual >= operand) return false;
    if (operator === "<=" && actual > operand) return false;
  }
  return true;
}

function matchCidr(networkValue: unknown, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const network = parseCidr(networkValue, "$.cidr");
  const address = parseIp(candidate);
  if (!address || address.bits !== network.bits) return false;
  const shift = BigInt(address.bits - network.prefix);
  return ((address.value >> shift) << shift) === network.network;
}

function matchStringOperator(operator: string, operand: unknown, candidate: string): boolean {
  if (operator === "equals-ignore-case") return candidate.toLowerCase() === (operand as string).toLowerCase();
  if (operator === "wildcard") return matchWildcard(operand, candidate);
  const affix = caseInsensitiveAffix(operand);
  const actual = affix.ignoreCase ? candidate.toLowerCase() : candidate;
  const expected = affix.ignoreCase ? affix.value.toLowerCase() : affix.value;
  return operator === "prefix" ? actual.startsWith(expected) : actual.endsWith(expected);
}

function matchMatcher(matcher: unknown, candidate: unknown): boolean {
  if (!isObject(matcher)) return exactMatch(matcher, candidate);
  const [operator, operand] = ownEntries(matcher)[0];
  switch (operator) {
    case "anything-but": return matchAnythingBut(operand, candidate);
    case "cidr": return matchCidr(operand, candidate);
    case "equals-ignore-case":
    case "prefix":
    case "suffix":
    case "wildcard": return typeof candidate === "string" && matchStringOperator(operator, operand, candidate);
    case "numeric": return matchNumeric(operand, candidate);
    case "exists": return operand === true;
    default: return false;
  }
}

function matchLeaf(matchers: unknown[], lookup: FieldLookup): boolean {
  for (const matcher of matchers) {
    if (isObject(matcher) && Object.prototype.hasOwnProperty.call(matcher, "exists")) {
      const hasLeaf = lookup.present && lookup.values.some(value => {
        if (Array.isArray(value)) return value.length === 0 || value.some(item => !isObject(item));
        return !isObject(value);
      });
      if ((matcher.exists === true && hasLeaf) || (matcher.exists === false && !lookup.present)) return true;
      continue;
    }
    if (!lookup.present) continue;
    for (const value of lookup.values) {
      const candidates = Array.isArray(value) ? value : [value];
      if (candidates.some(candidate => matchMatcher(matcher, candidate))) return true;
    }
  }
  return false;
}

function matchNested(pattern: EventPattern, values: unknown[]): boolean {
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (isObject(candidate) && matchObject(pattern, candidate)) return true;
    }
  }
  return false;
}

function matchObject(pattern: EventPattern, event: Record<string, unknown>): boolean {
  for (const [key, field] of ownEntries(pattern)) {
    if (key === "$or") {
      if (!(field as EventPattern[]).some(branch => matchObject(branch, event))) return false;
      continue;
    }
    const lookup = lookupField(event, key);
    if (Array.isArray(field)) {
      if (!matchLeaf(field, lookup)) return false;
    } else if (!lookup.present || !matchNested(field as EventPattern, lookup.values)) {
      return false;
    }
  }
  return true;
}

export function matchesEventPattern(pattern: unknown, event: unknown): boolean {
  validateEventPattern(pattern);
  return isObject(event) && matchObject(pattern, event);
}

export function testEventPattern(patternJson: string, eventJson: string): boolean {
  const pattern = parseEventPattern(patternJson);
  let event: unknown;
  try {
    event = parseEventJson(eventJson);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`Event is not valid JSON: ${detail}`);
  }
  if (!isObject(event)) throw new TypeError("Event must be a JSON object");
  return matchObject(pattern, event);
}
