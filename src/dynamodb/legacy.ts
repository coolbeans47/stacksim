import { AwsError } from "../errors.js";
import type { AttributeValue } from "../types.js";

/**
 * Translation of the pre-2014 "legacy" DynamoDB request parameters into expression parameters.
 * AWS still honors Expected, AttributeUpdates, AttributesToGet, KeyConditions, QueryFilter, ScanFilter, and
 * ConditionalOperator, and rejects mixing them with expression parameters. Translating them at the request
 * boundary keeps one expression engine while matching the documented behavior of each ComparisonOperator.
 */

export const LEGACY_PARAMETERS = ["Expected", "AttributeUpdates", "AttributesToGet", "KeyConditions", "QueryFilter", "ScanFilter", "ConditionalOperator"] as const;
export const EXPRESSION_PARAMETERS = ["ConditionExpression", "KeyConditionExpression", "FilterExpression", "ProjectionExpression", "UpdateExpression", "ExpressionAttributeNames", "ExpressionAttributeValues"] as const;

const COMPARISON_ARITY: Record<string, number | "any"> = { EQ: 1, NE: 1, LE: 1, LT: 1, GE: 1, GT: 1, NOT_NULL: 0, NULL: 0, CONTAINS: 1, NOT_CONTAINS: 1, BEGINS_WITH: 1, IN: "any", BETWEEN: 2 };

interface Placeholders { names: Record<string, string>; values: Record<string, AttributeValue>; nextName: number; nextValue: number }

function placeholderFor(store: Placeholders, attribute: string): string {
  const existing = Object.entries(store.names).find(([, name]) => name === attribute);
  if (existing) return existing[0];
  const token = `#legacy_n${store.nextName++}`; store.names[token] = attribute; return token;
}

function valueFor(store: Placeholders, value: AttributeValue): string {
  const token = `:legacy_v${store.nextValue++}`; store.values[token] = value; return token;
}

function comparison(store: Placeholders, attribute: string, condition: any, context: string): string {
  if (!condition || typeof condition !== "object") throw new AwsError("ValidationException", `Invalid ${context} for attribute ${attribute}`);
  const operator = String(condition.ComparisonOperator ?? "");
  const arity = COMPARISON_ARITY[operator];
  if (arity === undefined) throw new AwsError("ValidationException", `1 validation error detected: Value '${operator}' at '${context}.${attribute}.comparisonOperator' failed to satisfy constraint: Member must satisfy enum value set: [${Object.keys(COMPARISON_ARITY).join(", ")}]`);
  const list: AttributeValue[] = Array.isArray(condition.AttributeValueList) ? condition.AttributeValueList : [];
  if (arity === "any" ? list.length < 1 : list.length !== arity) throw new AwsError("ValidationException", `One or more parameter values were invalid: Invalid number of argument(s) for the ${operator} ComparisonOperator`);
  const name = placeholderFor(store, attribute); const values = list.map(value => valueFor(store, value));
  switch (operator) {
    case "EQ": return `${name} = ${values[0]}`;
    case "NE": return `${name} <> ${values[0]}`;
    case "LE": return `${name} <= ${values[0]}`;
    case "LT": return `${name} < ${values[0]}`;
    case "GE": return `${name} >= ${values[0]}`;
    case "GT": return `${name} > ${values[0]}`;
    case "NOT_NULL": return `attribute_exists(${name})`;
    case "NULL": return `attribute_not_exists(${name})`;
    case "CONTAINS": return `contains(${name}, ${values[0]})`;
    case "NOT_CONTAINS": return `NOT contains(${name}, ${values[0]})`;
    case "BEGINS_WITH": return `begins_with(${name}, ${values[0]})`;
    case "IN": return `${name} IN (${values.join(", ")})`;
    default: return `${name} BETWEEN ${values[0]} AND ${values[1]}`;
  }
}

function joined(store: Placeholders, map: Record<string, any>, context: string, operator: string): string {
  const entries = Object.entries(map ?? {});
  if (!entries.length) throw new AwsError("ValidationException", `${context} must contain at least one attribute`);
  return entries.map(([attribute, condition]) => comparison(store, attribute, condition, context)).join(` ${operator} `);
}

function expectedClause(store: Placeholders, attribute: string, expected: any): string {
  if (!expected || typeof expected !== "object") throw new AwsError("ValidationException", `Invalid Expected entry for attribute ${attribute}`);
  const hasLegacy = expected.Value !== undefined || expected.Exists !== undefined; const hasOperator = expected.ComparisonOperator !== undefined || expected.AttributeValueList !== undefined;
  if (hasLegacy && hasOperator) throw new AwsError("ValidationException", "One or more parameter values were invalid: Value and Exists cannot be used with ComparisonOperator and AttributeValueList");
  if (hasOperator) return comparison(store, attribute, expected, "Expected");
  const name = placeholderFor(store, attribute);
  if (expected.Exists === false) { if (expected.Value !== undefined) throw new AwsError("ValidationException", "One or more parameter values were invalid: Value cannot be used when Exists is false for Attribute"); return `attribute_not_exists(${name})`; }
  if (expected.Value === undefined) throw new AwsError("ValidationException", "One or more parameter values were invalid: Value must be provided when Exists is true for Attribute");
  return `${name} = ${valueFor(store, expected.Value)}`;
}

/**
 * Rewrite legacy parameters on `input` into expression parameters in place. Throws the AWS mixing error when both
 * styles are present. Returns true when a translation happened.
 */
export function translateLegacyParameters(input: any): boolean {
  if (!input || typeof input !== "object") return false;
  const legacy = LEGACY_PARAMETERS.filter(field => input[field] !== undefined);
  if (!legacy.length) return false;
  const modern = EXPRESSION_PARAMETERS.filter(field => input[field] !== undefined);
  if (modern.length) throw new AwsError("ValidationException", `Can not use both expression and non-expression parameters in the same request: Non-expression parameters: {${legacy.join(", ")}} Expression parameters: {${modern.join(", ")}}`);
  const operator = input.ConditionalOperator === undefined ? "AND" : String(input.ConditionalOperator);
  if (!["AND", "OR"].includes(operator)) throw new AwsError("ValidationException", `1 validation error detected: Value '${operator}' at 'conditionalOperator' failed to satisfy constraint: Member must satisfy enum value set: [AND, OR]`);
  const store: Placeholders = { names: {}, values: {}, nextName: 0, nextValue: 0 };
  if (input.Expected !== undefined) {
    const entries = Object.entries<any>(input.Expected ?? {});
    if (!entries.length) throw new AwsError("ValidationException", "Expected must contain at least one attribute");
    input.ConditionExpression = entries.map(([attribute, expected]) => expectedClause(store, attribute, expected)).join(` ${operator} `);
  }
  if (input.KeyConditions !== undefined) input.KeyConditionExpression = joined(store, input.KeyConditions, "KeyConditions", "AND");
  if (input.QueryFilter !== undefined) input.FilterExpression = joined(store, input.QueryFilter, "QueryFilter", operator);
  if (input.ScanFilter !== undefined) input.FilterExpression = joined(store, input.ScanFilter, "ScanFilter", operator);
  if (input.AttributesToGet !== undefined) {
    const attributes: unknown[] = Array.isArray(input.AttributesToGet) ? input.AttributesToGet : [];
    if (!attributes.length || attributes.some(attribute => typeof attribute !== "string" || !attribute)) throw new AwsError("ValidationException", "AttributesToGet must contain at least one non-empty attribute name");
    input.ProjectionExpression = (attributes as string[]).map(attribute => placeholderFor(store, attribute)).join(", ");
  }
  if (input.AttributeUpdates !== undefined) {
    const sets: string[] = []; const adds: string[] = []; const deletes: string[] = []; const removes: string[] = [];
    for (const [attribute, update] of Object.entries<any>(input.AttributeUpdates ?? {})) {
      const action = String(update?.Action ?? "PUT"); const name = placeholderFor(store, attribute);
      if (!["PUT", "ADD", "DELETE"].includes(action)) throw new AwsError("ValidationException", `1 validation error detected: Value '${action}' at 'attributeUpdates.${attribute}.action' failed to satisfy constraint: Member must satisfy enum value set: [ADD, PUT, DELETE]`);
      if (action === "DELETE" && update?.Value === undefined) { removes.push(name); continue; }
      if (update?.Value === undefined) throw new AwsError("ValidationException", `One or more parameter values were invalid: Only DELETE action is allowed when no attribute value is specified`);
      const value = valueFor(store, update.Value);
      if (action === "PUT") sets.push(`${name} = ${value}`); else if (action === "ADD") adds.push(`${name} ${value}`); else deletes.push(`${name} ${value}`);
    }
    const sections = [sets.length ? `SET ${sets.join(", ")}` : "", adds.length ? `ADD ${adds.join(", ")}` : "", deletes.length ? `DELETE ${deletes.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean);
    if (sections.length) input.UpdateExpression = sections.join(" ");
  }
  if (Object.keys(store.names).length) input.ExpressionAttributeNames = store.names;
  if (Object.keys(store.values).length) input.ExpressionAttributeValues = store.values;
  for (const field of LEGACY_PARAMETERS) delete input[field];
  return true;
}
