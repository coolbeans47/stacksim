export interface ConditionOperator {
  base: string;
  forAll: boolean;
  forAny: boolean;
  ifExists: boolean;
  negated: boolean;
}

const BASE_OPERATORS = new Set([
  "StringEquals", "StringNotEquals", "StringEqualsIgnoreCase", "StringNotEqualsIgnoreCase", "StringLike", "StringNotLike",
  "ArnEquals", "ArnLike", "ArnNotEquals", "ArnNotLike",
  "NumericEquals", "NumericNotEquals", "NumericLessThan", "NumericLessThanEquals", "NumericGreaterThan", "NumericGreaterThanEquals",
  "DateEquals", "DateNotEquals", "DateLessThan", "DateLessThanEquals", "DateGreaterThan", "DateGreaterThanEquals",
  "Bool", "BinaryEquals", "IpAddress", "NotIpAddress", "Null",
]);

const NEGATED_OPERATORS = new Set([
  "StringNotEquals", "StringNotEqualsIgnoreCase", "StringNotLike",
  "ArnNotEquals", "ArnNotLike", "NumericNotEquals", "DateNotEquals", "NotIpAddress",
]);

export function parseConditionOperator(raw: string): ConditionOperator | undefined {
  let operator = raw;
  const forAll = operator.startsWith("ForAllValues:");
  const forAny = operator.startsWith("ForAnyValue:");
  if (forAll || forAny) operator = operator.slice(operator.indexOf(":") + 1);
  const ifExists = operator.endsWith("IfExists");
  if (ifExists) operator = operator.slice(0, -"IfExists".length);
  if (!BASE_OPERATORS.has(operator) || (operator === "Null" && (forAll || forAny || ifExists))) return undefined;
  return { base: operator, forAll, forAny, ifExists, negated: NEGATED_OPERATORS.has(operator) };
}
