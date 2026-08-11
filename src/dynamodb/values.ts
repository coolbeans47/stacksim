import { AwsError } from "../errors.js";
import type { AttributeValue, Item, TableState } from "../types.js";

const NUMBER = /^[-+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][-+]?\d+)?$/;
const TYPES = new Set(["S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"]);

export function clone<T>(value: T): T { return structuredClone(value); }

export function attributeType(value: AttributeValue): string {
  const keys = Object.keys(value as object);
  if (keys.length !== 1 || !TYPES.has(keys[0])) throw new AwsError("ValidationException", "Supplied AttributeValue has more than one datatype set, or an unsupported datatype");
  return keys[0];
}

function validateNumber(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NUMBER.test(value)) throw new AwsError("ValidationException", `The parameter cannot be converted to a numeric value: ${String(value)}`);
  const unsigned = value.replace(/^[-+]/, ""); const [mantissa, exponentText = "0"] = unsigned.toLowerCase().split("e"); const [whole, fraction = ""] = mantissa.split("."); const digits = `${whole}${fraction}`; const first = digits.search(/[1-9]/);
  if (first < 0) return;
  const significant = digits.slice(first).length; const exponent = Number(exponentText); const adjustedExponent = exponent + whole.length - first - 1;
  if (!Number.isSafeInteger(exponent) || significant > 38 || adjustedExponent > 125 || adjustedExponent < -130) throw new AwsError("ValidationException", "Number overflow. Attempting to store a number with magnitude larger than supported range");
}

export function validateAttributeValue(value: unknown, path = "attribute"): asserts value is AttributeValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("ValidationException", `Invalid AttributeValue at ${path}`);
  const type = attributeType(value as AttributeValue);
  const content = (value as any)[type];
  if (type === "S" && typeof content !== "string") throw new AwsError("ValidationException", `Expected string at ${path}`);
  if (type === "N") validateNumber(content);
  if (type === "B" && typeof content !== "string") throw new AwsError("ValidationException", `Expected base64 binary string at ${path}`);
  if (type === "BOOL" && typeof content !== "boolean") throw new AwsError("ValidationException", `Expected boolean at ${path}`);
  if (type === "NULL" && content !== true) throw new AwsError("ValidationException", `NULL must be true at ${path}`);
  if (type === "L") {
    if (!Array.isArray(content)) throw new AwsError("ValidationException", `Expected list at ${path}`);
    content.forEach((item, index) => validateAttributeValue(item, `${path}[${index}]`));
  }
  if (type === "M") {
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new AwsError("ValidationException", `Expected map at ${path}`);
    for (const [name, item] of Object.entries(content)) { if (!name) throw new AwsError("ValidationException", "Empty attribute names are not supported"); validateAttributeValue(item, `${path}.${name}`); }
  }
  if (["SS", "NS", "BS"].includes(type)) {
    if (!Array.isArray(content) || content.length === 0) throw new AwsError("ValidationException", "An AttributeValue may not contain an empty set");
    if (type === "NS") content.forEach(validateNumber);
    else if (content.some(item => typeof item !== "string")) throw new AwsError("ValidationException", `Expected string values in ${type}`);
    if (new Set(content).size !== content.length) throw new AwsError("ValidationException", "Input collection contains duplicates");
  }
}

export function validateItem(table: TableState, item: unknown, requireCompleteKey = true): asserts item is Item {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new AwsError("ValidationException", "Item must be a map of AttributeValue objects");
  for (const [name, value] of Object.entries(item)) {
    if (!name) throw new AwsError("ValidationException", "Empty attribute names are not supported");
    validateAttributeValue(value, name);
  }
  if (requireCompleteKey) validateKey(table, item as Item, false);
  if (Buffer.byteLength(JSON.stringify(item)) > 400 * 1024) throw new AwsError("ValidationException", "Item size has exceeded the maximum allowed size");
}

export function validateKey(table: TableState, key: Item, exact = true): void {
  if (exact && Object.keys(key).length !== table.keySchema.length) throw new AwsError("ValidationException", "The provided key element does not match the schema");
  for (const schema of table.keySchema) {
    const value = key[schema.AttributeName];
    if (!value) throw new AwsError("ValidationException", `One of the required keys was not given a value: ${schema.AttributeName}`);
    validateAttributeValue(value, schema.AttributeName);
    const expected = table.attributeDefinitions.find(definition => definition.AttributeName === schema.AttributeName)?.AttributeType;
    const actual = attributeType(value);
    if (actual !== expected || !["S", "N", "B"].includes(actual)) throw new AwsError("ValidationException", "The provided key element does not match the schema");
    const content = (value as any)[actual];
    if ((actual === "S" || actual === "B") && content.length === 0) throw new AwsError("ValidationException", "One or more parameter values were invalid: An AttributeValue may not contain an empty string for a key attribute");
  }
}

export function stableItemKey(table: TableState, item: Item): string {
  return JSON.stringify(table.keySchema.map(schema => {
    const value = item[schema.AttributeName];
    if (!value) throw new AwsError("ValidationException", `One of the required keys was not given a value: ${schema.AttributeName}`);
    const type = attributeType(value);
    const content = (value as any)[type];
    if (type === "N") {
      let { coefficient, scale } = decimal(content);
      while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
      if (coefficient === 0n) scale = 0;
      return [type, `${coefficient}:${scale}`];
    }
    if (type === "B") return [type, Buffer.from(content, "base64").toString("base64")];
    return [type, content];
  }));
}

export function normalizeTableItemKeys(table: TableState): boolean {
  if (!Array.isArray(table.keySchema) || !table.keySchema.length) return false;
  const normalized: Record<string, Item> = {};
  for (const item of Object.values(table.items ?? {})) normalized[stableItemKey(table, item)] = item;
  const before = Object.keys(table.items ?? {}).sort(); const after = Object.keys(normalized).sort();
  const changed = before.length !== after.length || before.some((key, index) => key !== after[index]);
  if (changed) table.items = normalized;
  return changed;
}

export function keyFromItem(table: TableState, item: Item): Item {
  return Object.fromEntries(table.keySchema.map(schema => [schema.AttributeName, clone(item[schema.AttributeName])]));
}

interface Decimal { coefficient: bigint; scale: number }
function decimal(value: string): Decimal {
  validateNumber(value);
  let source = value.toLowerCase();
  let sign = 1n;
  if (source.startsWith("-")) { sign = -1n; source = source.slice(1); } else if (source.startsWith("+")) source = source.slice(1);
  const [mantissa, exponentText = "0"] = source.split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  let scale = fraction.length - Number(exponentText);
  let coefficient = BigInt(`${whole || "0"}${fraction}` || "0") * sign;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.coefficient * 10n ** BigInt(scale - a.scale), b.coefficient * 10n ** BigInt(scale - b.scale), scale];
}

export function compareNumbers(a: string, b: string): number {
  const [left, right] = align(decimal(a), decimal(b));
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addNumbers(a: string, b: string, subtract = false): string {
  const [left, originalRight, scale] = align(decimal(a), decimal(b));
  let coefficient = left + (subtract ? -originalRight : originalRight);
  const sign = coefficient < 0n ? "-" : "";
  if (coefficient < 0n) coefficient = -coefficient;
  let digits = coefficient.toString().padStart(scale + 1, "0");
  let output = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  output = output.replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "").replace(/\.$/, "");
  return `${sign}${output}`;
}

export function compareAttributeValues(a: AttributeValue | undefined, b: AttributeValue | undefined): number | undefined {
  if (!a || !b || attributeType(a) !== attributeType(b)) return undefined;
  const type = attributeType(a);
  if (type === "N") return compareNumbers((a as any).N, (b as any).N);
  if (type === "S" || type === "B") {
    const left = type === "B" ? Buffer.from((a as any).B, "base64") : Buffer.from((a as any).S);
    const right = type === "B" ? Buffer.from((b as any).B, "base64") : Buffer.from((b as any).S);
    return Buffer.compare(left, right);
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : undefined;
}

export function equalAttributeValues(a: AttributeValue | undefined, b: AttributeValue | undefined): boolean {
  return compareAttributeValues(a, b) === 0 || JSON.stringify(a) === JSON.stringify(b);
}
