import { AwsError } from "../errors.js";
import type { AttributeValue, Item, TableState } from "../types.js";
import { addNumbers, attributeType, clone, compareAttributeValues, equalAttributeValues, validateAttributeValue } from "./values.js";

type Path = Array<string | number>;
type TokenType = "name" | "value" | "number" | "keyword" | "symbol" | "eof";
interface Token { type: TokenType; value: string; position: number }

const KEYWORDS = new Set(["AND", "OR", "NOT", "BETWEEN", "IN", "SET", "REMOVE", "ADD", "DELETE"]);
const RESERVED = new Set(("ABORT ABSOLUTE ACTION ADD ALL ALTER ANALYZE AND ANY AS ASC ATTRIBUTE AUTHORIZATION AVG BACKUP BASE BATCH BEGIN BETWEEN BINARY BOTH BY CASE CAST CHECK CLUSTER COMMENT COMMIT CONDITION CONNECT CONSISTENT CONSTRAINT COUNT CREATE CROSS CURRENT DATABASE DATE DAY DECIMAL DELETE DESC DESCRIBE DISTINCT DROP ELSE END ESCAPE EXISTS EXPLAIN FALSE FILTER FIRST FOR FROM FULL FUNCTION GLOBAL GRANT GROUP HASH HAVING IN INDEX INNER INSERT INTERSECT INTO IS ITEM ITEMS JOIN KEY KEYS LAST LEFT LEVEL LIKE LIMIT LOCAL MAP MODIFY MULTI NAME NAMES NATIONAL NATURAL NO NONE NOT NULL NUMBER NUMERIC OF OFFLINE ON ONLY OPEN OR ORDER OUTER OVER PARTITION PATH PRECISION PRIMARY PROJECTION PUT RANGE READ REAL REBUILD RECORD RECURSIVE REMOVE RENAME REPLACE RESOURCE RESTORE RETURN ROLE ROLLBACK ROW RULE SAVE SCAN SCHEMA SELECT SESSION SET SIZE SOME START STATUS STREAM STRING SUM TABLE TAG THEN THROUGH TIME TIMESTAMP TO TRANSACTION TRUE TYPE UNION UNIQUE UPDATE USER USING VALUE VALUES VIEW WHEN WHERE WITH WRITE YEAR").split(" "));

export type ValueExpression =
  | { kind: "path"; path: Path }
  | { kind: "value"; name: string }
  | { kind: "function"; name: string; args: ValueExpression[] }
  | { kind: "arithmetic"; operator: "+" | "-"; left: ValueExpression; right: ValueExpression };

export type ConditionExpression =
  | { kind: "and" | "or"; left: ConditionExpression; right: ConditionExpression }
  | { kind: "not"; value: ConditionExpression }
  | { kind: "compare"; operator: string; left: ValueExpression; right: ValueExpression }
  | { kind: "between"; value: ValueExpression; lower: ValueExpression; upper: ValueExpression }
  | { kind: "in"; value: ValueExpression; options: ValueExpression[] }
  | { kind: "predicate"; value: ValueExpression };

export interface ExpressionContext {
  names?: Record<string, string>;
  values?: Record<string, AttributeValue>;
}

export function conditionPaths(expression: ConditionExpression | undefined): Path[] {
  const paths: Path[] = [];
  const value = (node: ValueExpression): void => {
    if (node.kind === "path") { paths.push([...node.path]); return; }
    if (node.kind === "function") { node.args.forEach(value); return; }
    if (node.kind === "arithmetic") { value(node.left); value(node.right); }
  };
  const condition = (node: ConditionExpression): void => {
    if (node.kind === "and" || node.kind === "or") { condition(node.left); condition(node.right); return; }
    if (node.kind === "not") { condition(node.value); return; }
    if (node.kind === "compare") { value(node.left); value(node.right); return; }
    if (node.kind === "between") { value(node.value); value(node.lower); value(node.upper); return; }
    if (node.kind === "in") { value(node.value); node.options.forEach(value); return; }
    if (node.kind === "predicate") value(node.value);
  };
  if (expression) condition(expression);
  return paths;
}

function syntax(message: string, token?: Token): never {
  throw new AwsError("ValidationException", `Invalid expression${token ? ` at character ${token.position}` : ""}: ${message}`);
}

function tokenize(source: string): Token[] {
  if (Buffer.byteLength(source) > 4096) throw new AwsError("ValidationException", "Expression size has exceeded the maximum allowed size");
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index++; continue; }
    const position = index;
    const placeholder = source.slice(index).match(/^([#:][A-Za-z0-9_]+)/);
    if (placeholder) { tokens.push({ type: placeholder[1][0] === "#" ? "name" : "value", value: placeholder[1], position }); index += placeholder[1].length; continue; }
    const word = source.slice(index).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (word) { const upper = word[1].toUpperCase(); tokens.push({ type: KEYWORDS.has(upper) ? "keyword" : "name", value: KEYWORDS.has(upper) ? upper : word[1], position }); index += word[1].length; continue; }
    const number = source.slice(index).match(/^(\d+)/);
    if (number) { tokens.push({ type: "number", value: number[1], position }); index += number[1].length; continue; }
    const operator = source.slice(index).match(/^(<>|<=|>=|=|<|>|[()[\].,+-])/);
    if (operator) { tokens.push({ type: "symbol", value: operator[1], position }); index += operator[1].length; continue; }
    syntax(`Unexpected character ${source[index]}`, { type: "symbol", value: source[index], position });
  }
  tokens.push({ type: "eof", value: "", position: source.length });
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[], private readonly names: Record<string, string>) {}
  peek(offset = 0): Token { return this.tokens[this.index + offset] ?? this.tokens.at(-1)!; }
  take(value?: string): Token { const token = this.peek(); if (value !== undefined && token.value.toUpperCase() !== value.toUpperCase()) syntax(`Expected ${value}, found ${token.value || "end of expression"}`, token); this.index++; return token; }
  accept(value: string): boolean { if (this.peek().value.toUpperCase() !== value.toUpperCase()) return false; this.index++; return true; }
  done(): boolean { return this.peek().type === "eof"; }

  condition(): ConditionExpression { return this.or(); }
  private or(): ConditionExpression { let left = this.and(); while (this.accept("OR")) left = { kind: "or", left, right: this.and() }; return left; }
  private and(): ConditionExpression { let left = this.not(); while (this.accept("AND")) left = { kind: "and", left, right: this.not() }; return left; }
  private not(): ConditionExpression { if (this.accept("NOT")) return { kind: "not", value: this.not() }; return this.conditionPrimary(); }
  private conditionPrimary(): ConditionExpression {
    if (this.accept("(")) { const value = this.condition(); this.take(")"); return value; }
    const left = this.valueExpression();
    if (this.accept("BETWEEN")) { const lower = this.valueExpression(); this.take("AND"); return { kind: "between", value: left, lower, upper: this.valueExpression() }; }
    if (this.accept("IN")) {
      this.take("("); const options: ValueExpression[] = [];
      do { options.push(this.valueExpression()); } while (this.accept(","));
      this.take(")"); if (!options.length || options.length > 100) syntax("IN requires between 1 and 100 operands", this.peek());
      return { kind: "in", value: left, options };
    }
    if (["=", "<>", "<", "<=", ">", ">="].includes(this.peek().value)) { const operator = this.take().value; return { kind: "compare", operator, left, right: this.valueExpression() }; }
    if (left.kind === "function") return { kind: "predicate", value: left };
    syntax("Expected comparison operator", this.peek());
  }

  valueExpression(): ValueExpression {
    let left = this.term();
    if (this.peek().value === "+" || this.peek().value === "-") { const operator = this.take().value as "+" | "-"; left = { kind: "arithmetic", operator, left, right: this.term() }; }
    return left;
  }

  private term(): ValueExpression {
    const token = this.peek();
    if (token.type === "value") { this.take(); return { kind: "value", name: token.value }; }
    if (token.type !== "name") syntax("Expected attribute path, value placeholder, or function", token);
    if (this.peek(1).value === "(") {
      const name = this.take().value.toLowerCase(); this.take("("); const args: ValueExpression[] = [];
      if (!this.accept(")")) { do { args.push(this.valueExpression()); } while (this.accept(",")); this.take(")"); }
      return { kind: "function", name, args };
    }
    return { kind: "path", path: this.path() };
  }

  path(): Path {
    const first = this.take();
    if (first.type !== "name") syntax("Expected attribute name", first);
    const path: Path = [this.resolveName(first)];
    while (true) {
      if (this.accept(".")) { const token = this.take(); if (token.type !== "name") syntax("Expected map member name", token); path.push(this.resolveName(token)); continue; }
      if (this.accept("[")) { const token = this.take(); if (token.type !== "number") syntax("Expected list index", token); path.push(Number(token.value)); this.take("]"); continue; }
      break;
    }
    if (path.length > 32) syntax("Document path has too many dereferences", first);
    return path;
  }

  private resolveName(token: Token): string {
    if (token.value.startsWith("#")) {
      const resolved = this.names[token.value];
      if (resolved === undefined) throw new AwsError("ValidationException", `ExpressionAttributeNames contains no mapping for ${token.value}`);
      return resolved;
    }
    if (RESERVED.has(token.value.toUpperCase())) throw new AwsError("ValidationException", `Attribute name is a reserved keyword; reserved keyword: ${token.value}`);
    return token.value;
  }
}

function parser(source: string, context: ExpressionContext): Parser { return new Parser(tokenize(source), context.names ?? {}); }

const MAX_SUBSTITUTION_TOKEN_BYTES = 255;
const MAX_SUBSTITUTION_MAP_BYTES = 2 * 1024 * 1024;
const MAX_EXPRESSION_OPERATORS = 300;

function attributeValueWireBytes(value: AttributeValue): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Enforce AWS substitution-token identifier and aggregate map size limits for ExpressionAttributeNames/Values. */
export function validateExpressionSubstitutions(names?: Record<string, string>, values?: Record<string, AttributeValue>): void {
  let total = 0;
  for (const [token, name] of Object.entries(names ?? {})) {
    if (Buffer.byteLength(token) > MAX_SUBSTITUTION_TOKEN_BYTES) throw new AwsError("ValidationException", `ExpressionAttributeNames key exceeds the maximum length of ${MAX_SUBSTITUTION_TOKEN_BYTES} bytes`);
    total += Buffer.byteLength(token) + Buffer.byteLength(name);
  }
  for (const [token, value] of Object.entries(values ?? {})) {
    if (Buffer.byteLength(token) > MAX_SUBSTITUTION_TOKEN_BYTES) throw new AwsError("ValidationException", `ExpressionAttributeValues key exceeds the maximum length of ${MAX_SUBSTITUTION_TOKEN_BYTES} bytes`);
    total += Buffer.byteLength(token) + attributeValueWireBytes(value);
  }
  if (total > MAX_SUBSTITUTION_MAP_BYTES) throw new AwsError("ValidationException", "Expression attribute names and values together exceed the maximum allowed size");
}

function countValueOperators(node: ValueExpression): number {
  if (node.kind === "function") return 1 + node.args.reduce((sum, argument) => sum + countValueOperators(argument), 0);
  if (node.kind === "arithmetic") return 1 + countValueOperators(node.left) + countValueOperators(node.right);
  return 0;
}

export function countConditionOperators(expression: ConditionExpression | undefined): number {
  if (!expression) return 0;
  if (expression.kind === "and" || expression.kind === "or") return 1 + countConditionOperators(expression.left) + countConditionOperators(expression.right);
  if (expression.kind === "not") return 1 + countConditionOperators(expression.value);
  if (expression.kind === "compare") return 1 + countValueOperators(expression.left) + countValueOperators(expression.right);
  if (expression.kind === "between") return 1 + countValueOperators(expression.value) + countValueOperators(expression.lower) + countValueOperators(expression.upper);
  if (expression.kind === "in") return 1 + countValueOperators(expression.value) + expression.options.reduce((sum, option) => sum + countValueOperators(option), 0);
  if (expression.kind === "predicate") return countValueOperators(expression.value);
  return 0;
}

function enforceOperatorLimit(count: number): void {
  if (count > MAX_EXPRESSION_OPERATORS) throw new AwsError("ValidationException", `Expression contains more than the maximum of ${MAX_EXPRESSION_OPERATORS} operators or functions`);
}

export function parseConditionExpression(source: string | undefined, context: ExpressionContext = {}): ConditionExpression | undefined {
  validateExpressionSubstitutions(context.names, context.values);
  if (!source) return undefined;
  const result = parser(source, context); const expression = result.condition();
  if (!result.done()) syntax(`Unexpected token ${result.peek().value}`, result.peek());
  enforceOperatorLimit(countConditionOperators(expression));
  return expression;
}

export function parseProjectionExpression(source: string | undefined, context: ExpressionContext = {}): Path[] {
  validateExpressionSubstitutions(context.names, context.values);
  if (!source) return [];
  const result = parser(source, context); const paths: Path[] = [];
  do { paths.push(result.path()); } while (result.accept(","));
  if (!result.done()) syntax(`Unexpected token ${result.peek().value}`, result.peek());
  return paths;
}

export function getPath(item: Item, path: Path): AttributeValue | undefined {
  let current: any = item;
  for (let index = 0; index < path.length; index++) {
    const part = path[index];
    if (index === 0) current = current[part as string];
    else if (typeof part === "number") current = current && "L" in current ? current.L[part] : undefined;
    else current = current && "M" in current ? current.M[part] : undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

function setPath(item: Item, path: Path, value: AttributeValue): void {
  if (path.length === 1) { item[path[0] as string] = clone(value); return; }
  let current: any = item[path[0] as string];
  if (!current) throw new AwsError("ValidationException", "The document path provided in the update expression is invalid for update");
  for (let index = 1; index < path.length - 1; index++) {
    const part = path[index]; current = typeof part === "number" && "L" in current ? current.L[part] : typeof part === "string" && "M" in current ? current.M[part] : undefined;
    if (!current) throw new AwsError("ValidationException", "The document path provided in the update expression is invalid for update");
  }
  const final = path.at(-1)!;
  if (typeof final === "number" && "L" in current) {
    if (final > current.L.length) throw new AwsError("ValidationException", "The document path provided in the update expression is invalid for update");
    if (final === current.L.length) current.L.push(clone(value)); else current.L[final] = clone(value);
  } else if (typeof final === "string" && "M" in current) current.M[final] = clone(value);
  else throw new AwsError("ValidationException", "The document path provided in the update expression is invalid for update");
}

function removePath(item: Item, path: Path): void {
  if (path.length === 1) { delete item[path[0] as string]; return; }
  let current: any = item[path[0] as string];
  for (let index = 1; index < path.length - 1; index++) {
    const part = path[index]; current = typeof part === "number" && current && "L" in current ? current.L[part] : typeof part === "string" && current && "M" in current ? current.M[part] : undefined;
    if (!current) return;
  }
  const final = path.at(-1)!;
  if (typeof final === "number" && current && "L" in current) current.L.splice(final, 1);
  else if (typeof final === "string" && current && "M" in current) delete current.M[final];
}

type RuntimeValue = AttributeValue | number | undefined;
function runtimeAttribute(value: RuntimeValue): AttributeValue | undefined { return typeof value === "number" ? { N: String(value) } : value; }

function evaluateValue(expression: ValueExpression, item: Item, context: ExpressionContext): RuntimeValue {
  if (expression.kind === "path") return getPath(item, expression.path);
  if (expression.kind === "value") {
    const value = context.values?.[expression.name];
    if (value === undefined) throw new AwsError("ValidationException", `ExpressionAttributeValues contains no mapping for ${expression.name}`);
    validateAttributeValue(value, expression.name); return value;
  }
  if (expression.kind === "arithmetic") {
    const left = runtimeAttribute(evaluateValue(expression.left, item, context)); const right = runtimeAttribute(evaluateValue(expression.right, item, context));
    if (!left || !right || attributeType(left) !== "N" || attributeType(right) !== "N") throw new AwsError("ValidationException", "Incorrect operand type for arithmetic update");
    return { N: addNumbers((left as any).N, (right as any).N, expression.operator === "-") };
  }
  const args = expression.args.map(argument => evaluateValue(argument, item, context));
  if (expression.name === "size") {
    const value = runtimeAttribute(args[0]); if (!value) throw new AwsError("ValidationException", "The provided expression refers to an attribute that does not exist in the item");
    const type = attributeType(value); const content = (value as any)[type];
    if (["S", "B"].includes(type)) return type === "B" ? Buffer.from(content, "base64").length : Buffer.byteLength(content);
    if (["L", "M", "SS", "NS", "BS"].includes(type)) return Array.isArray(content) ? content.length : Object.keys(content).length;
    throw new AwsError("ValidationException", "Incorrect operand type for operator or function; operator or function: size");
  }
  if (expression.name === "if_not_exists") return args[0] ?? args[1];
  if (expression.name === "list_append") {
    const left = runtimeAttribute(args[0]); const right = runtimeAttribute(args[1]);
    if (!left || !right || attributeType(left) !== "L" || attributeType(right) !== "L") throw new AwsError("ValidationException", "Incorrect operand type for operator or function; operator or function: list_append");
    return { L: [...clone((left as any).L), ...clone((right as any).L)] };
  }
  return undefined;
}

function compare(left: RuntimeValue, operator: string, right: RuntimeValue): boolean {
  const a = runtimeAttribute(left); const b = runtimeAttribute(right); const result = compareAttributeValues(a, b);
  if (operator === "=") return equalAttributeValues(a, b);
  if (operator === "<>") return !equalAttributeValues(a, b);
  if (result === undefined) return false;
  return operator === "<" ? result < 0 : operator === "<=" ? result <= 0 : operator === ">" ? result > 0 : result >= 0;
}

function predicate(expression: ValueExpression & { kind: "function" }, item: Item, context: ExpressionContext): boolean {
  const name = expression.name; const firstExpression = expression.args[0]; const first = firstExpression ? evaluateValue(firstExpression, item, context) : undefined;
  if (name === "attribute_exists") return first !== undefined;
  if (name === "attribute_not_exists") return first === undefined;
  if (name === "attribute_type") { const second = runtimeAttribute(evaluateValue(expression.args[1], item, context)); const value = runtimeAttribute(first); return Boolean(value && second && "S" in second && attributeType(value) === second.S); }
  if (name === "begins_with") {
    const value = runtimeAttribute(first); const prefix = runtimeAttribute(evaluateValue(expression.args[1], item, context));
    if (!value || !prefix || attributeType(value) !== attributeType(prefix) || !["S", "B"].includes(attributeType(value))) return false;
    if (attributeType(value) === "B") {
      const bytes = Buffer.from((value as any).B, "base64"); const needle = Buffer.from((prefix as any).B, "base64");
      return bytes.length >= needle.length && bytes.subarray(0, needle.length).equals(needle);
    }
    return (value as any).S.startsWith((prefix as any).S);
  }
  if (name === "contains") {
    const value = runtimeAttribute(first); const operand = runtimeAttribute(evaluateValue(expression.args[1], item, context)); if (!value || !operand) return false;
    const type = attributeType(value); const content = (value as any)[type];
    if (type === "S" && "S" in operand) return content.includes(operand.S);
    if (type === "L") return content.some((entry: AttributeValue) => equalAttributeValues(entry, operand));
    if (["SS", "NS", "BS"].includes(type)) { const scalarType = type[0]; return attributeType(operand) === scalarType && content.some((entry: string) => scalarType === "N" ? compareAttributeValues({ N: entry }, operand) === 0 : entry === (operand as any)[scalarType]); }
    return false;
  }
  throw new AwsError("ValidationException", `Invalid function name; function: ${name}`);
}

export function evaluateCondition(expression: ConditionExpression | undefined, item: Item, context: ExpressionContext = {}): boolean {
  if (!expression) return true;
  if (expression.kind === "and") return evaluateCondition(expression.left, item, context) && evaluateCondition(expression.right, item, context);
  if (expression.kind === "or") return evaluateCondition(expression.left, item, context) || evaluateCondition(expression.right, item, context);
  if (expression.kind === "not") return !evaluateCondition(expression.value, item, context);
  if (expression.kind === "compare") return compare(evaluateValue(expression.left, item, context), expression.operator, evaluateValue(expression.right, item, context));
  if (expression.kind === "between") { const value = evaluateValue(expression.value, item, context); return compare(value, ">=", evaluateValue(expression.lower, item, context)) && compare(value, "<=", evaluateValue(expression.upper, item, context)); }
  if (expression.kind === "in") { const value = evaluateValue(expression.value, item, context); return expression.options.some(option => compare(value, "=", evaluateValue(option, item, context))); }
  if (expression.kind !== "predicate") return false;
  return expression.value.kind === "function" ? predicate(expression.value, item, context) : false;
}

export function projectItem(item: Item, source: string | undefined, context: ExpressionContext = {}): Item {
  const paths = parseProjectionExpression(source, context);
  if (!paths.length) return clone(item);
  const output: Item = {};
  for (const path of paths) { const value = getPath(item, path); if (value !== undefined) setProjectionPath(output, path, value); }
  return output;
}

function setProjectionPath(item: Item, path: Path, value: AttributeValue): void {
  if (path.length === 1) { item[path[0] as string] = clone(value); return; }
  const rootName = path[0] as string; item[rootName] ??= typeof path[1] === "number" ? { L: [] } : { M: {} };
  let current: any = item[rootName];
  for (let index = 1; index < path.length - 1; index++) {
    const part = path[index]; const next = path[index + 1];
    if (typeof part === "number") { current.L[part] ??= typeof next === "number" ? { L: [] } : { M: {} }; current = current.L[part]; }
    else { current.M[part] ??= typeof next === "number" ? { L: [] } : { M: {} }; current = current.M[part]; }
  }
  const final = path.at(-1)!; if (typeof final === "number") current.L.push(clone(value)); else current.M[final] = clone(value);
}

interface UpdateOperation { action: "SET" | "REMOVE" | "ADD" | "DELETE"; path: Path; value?: ValueExpression }

function parseUpdate(source: string, context: ExpressionContext): UpdateOperation[] {
  validateExpressionSubstitutions(context.names, context.values);
  const result = parser(source, context); const operations: UpdateOperation[] = []; const sections = new Set<string>();
  while (!result.done()) {
    const action = result.take().value.toUpperCase(); if (!["SET", "REMOVE", "ADD", "DELETE"].includes(action)) syntax("Expected SET, REMOVE, ADD, or DELETE", result.peek());
    if (sections.has(action)) throw new AwsError("ValidationException", `The ${action} section can only be used once in an update expression`); sections.add(action);
    do {
      const path = result.path(); let value: ValueExpression | undefined;
      if (action === "SET") { result.take("="); value = result.valueExpression(); }
      else if (action === "ADD" || action === "DELETE") value = result.valueExpression();
      operations.push({ action: action as UpdateOperation["action"], path, value });
      if (!result.accept(",")) break;
    } while (true);
  }
  if (!operations.length) syntax("UpdateExpression cannot be empty");
  for (let left = 0; left < operations.length; left++) for (let right = left + 1; right < operations.length; right++) {
    const a = JSON.stringify(operations[left].path); const b = JSON.stringify(operations[right].path);
    const prefix = (shorter: Path, longer: Path) => shorter.every((value, index) => value === longer[index]);
    if (a === b || prefix(operations[left].path, operations[right].path) || prefix(operations[right].path, operations[left].path)) throw new AwsError("ValidationException", "Two document paths overlap with each other; must remove or rewrite one of these paths");
  }
  const operators = operations.reduce((sum, operation) => sum + 1 + (operation.value ? countValueOperators(operation.value) : 0), 0);
  enforceOperatorLimit(operators);
  return operations;
}

export function applyUpdateExpression(item: Item, source: string, context: ExpressionContext = {}): { item: Item; oldValues: Item; newValues: Item } {
  const operations = parseUpdate(source, context); const output = clone(item); const oldValues: Item = {}; const newValues: Item = {};
  for (const operation of operations) {
    const old = getPath(output, operation.path); if (old !== undefined) setProjectionPath(oldValues, operation.path, old);
    if (operation.action === "REMOVE") removePath(output, operation.path);
    else {
      const value = runtimeAttribute(evaluateValue(operation.value!, output, context)); if (!value) throw new AwsError("ValidationException", "Update expression evaluated to no value");
      if (operation.action === "SET") setPath(output, operation.path, value);
      else {
        if (operation.path.length !== 1) throw new AwsError("ValidationException", `${operation.action} action supports only top-level attributes`);
        const current = getPath(output, operation.path); const type = attributeType(value);
        if (operation.action === "ADD") {
          if (type === "N") { if (current && attributeType(current) !== "N") throw new AwsError("ValidationException", "An operand in the update expression has an incorrect data type"); setPath(output, operation.path, { N: addNumbers(current && "N" in current ? current.N : "0", (value as any).N) }); }
          else if (["SS", "NS", "BS"].includes(type)) { if (current && attributeType(current) !== type) throw new AwsError("ValidationException", "An operand in the update expression has an incorrect data type"); const values = [...(current ? (current as any)[type] : []), ...(value as any)[type]]; (setPath as any)(output, operation.path, { [type]: [...new Set(values)] }); }
          else throw new AwsError("ValidationException", "ADD action supports only Number and set data types");
        } else {
          if (!["SS", "NS", "BS"].includes(type) || !current || attributeType(current) !== type) throw new AwsError("ValidationException", "DELETE action supports only set data types");
          const remove = (value as any)[type]; const remaining = (current as any)[type].filter((entry: string) => !remove.includes(entry));
          if (remaining.length) (setPath as any)(output, operation.path, { [type]: remaining }); else removePath(output, operation.path);
        }
      }
    }
    const next = getPath(output, operation.path); if (next !== undefined) setProjectionPath(newValues, operation.path, next);
  }
  return { item: output, oldValues, newValues };
}

export function validateKeyCondition(expression: ConditionExpression, table: TableState): void {
  const parts: ConditionExpression[] = [];
  const flatten = (node: ConditionExpression): void => { if (node.kind === "and") { flatten(node.left); flatten(node.right); } else parts.push(node); };
  flatten(expression);
  if (parts.length > 2 || parts.some(part => part.kind === "or" || part.kind === "not" || part.kind === "in")) throw new AwsError("ValidationException", "Conditions can be of length 1 or 2 only");
  const partition = table.keySchema.find(key => key.KeyType === "HASH")!.AttributeName; const sort = table.keySchema.find(key => key.KeyType === "RANGE")?.AttributeName;
  const pathOf = (value: ValueExpression): string | undefined => value.kind === "path" && value.path.length === 1 ? String(value.path[0]) : undefined;
  const partitionPart = parts.find(part => part.kind === "compare" && pathOf(part.left) === partition);
  if (!partitionPart || partitionPart.kind !== "compare" || partitionPart.operator !== "=" || partitionPart.right.kind !== "value") throw new AwsError("ValidationException", "Query condition missed key schema element: partition key equality is required");
  for (const part of parts.filter(value => value !== partitionPart)) {
    const validCompare = part.kind === "compare" && pathOf(part.left) === sort && ["=", "<", "<=", ">", ">="].includes(part.operator);
    const validBetween = part.kind === "between" && pathOf(part.value) === sort;
    const validBegins = part.kind === "predicate" && part.value.kind === "function" && part.value.name === "begins_with" && pathOf(part.value.args[0]) === sort;
    if (!sort || (!validCompare && !validBetween && !validBegins)) throw new AwsError("ValidationException", "Query key condition not supported");
  }
}
