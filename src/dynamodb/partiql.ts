import { AwsError } from "../errors.js";
import type { AttributeValue, Item } from "../types.js";
import { addNumbers, attributeType, clone, equalAttributeValues, validateAttributeValue } from "./values.js";
import { getPath } from "./expressions.js";

type Path = Array<string | number>;
type TokenKind = "word" | "identifier" | "string" | "number" | "parameter" | "symbol" | "eof";
interface Token { kind: TokenKind; value: string; position: number }

export type PartiqlValueNode =
  | { kind: "path"; path: Path }
  | { kind: "value"; value: AttributeValue }
  | { kind: "function"; name: string; args: PartiqlValueNode[] }
  | { kind: "arithmetic"; operator: "+" | "-"; left: PartiqlValueNode; right: PartiqlValueNode };

export interface PartiqlProjection {
  expression: PartiqlValueNode;
  outputName: string;
}

type ConditionNode =
  | { kind: "and"; left: ConditionNode; right: ConditionNode }
  | { kind: "or"; left: ConditionNode; right: ConditionNode }
  | { kind: "not"; value: ConditionNode }
  | { kind: "compare"; operator: string; left: PartiqlValueNode; right: PartiqlValueNode }
  | { kind: "between"; value: PartiqlValueNode; lower: PartiqlValueNode; upper: PartiqlValueNode }
  | { kind: "in"; value: PartiqlValueNode; options: PartiqlValueNode[] }
  | { kind: "predicate"; value: PartiqlValueNode };

interface ParsedBase { kind: "select" | "insert" | "update" | "delete" | "exists"; tableName: string }
interface ParsedSelect extends ParsedBase { kind: "select"; indexName?: string; projection?: PartiqlValueNode[]; condition?: ConditionNode; order?: Array<{ path: Path; descending: boolean }> }
interface ParsedInsert extends ParsedBase { kind: "insert"; item: Item }
interface ParsedUpdate extends ParsedBase { kind: "update"; operations: Array<{ action: "SET" | "REMOVE"; path: Path; value?: PartiqlValueNode }>; condition: ConditionNode; returnValues?: "ALL_OLD" | "UPDATED_OLD" | "ALL_NEW" | "UPDATED_NEW" }
interface ParsedDelete extends ParsedBase { kind: "delete"; condition: ConditionNode; returnValues?: "ALL_OLD" }
interface ParsedExists extends ParsedBase { kind: "exists"; condition: ConditionNode }
type ParsedStatement = ParsedSelect | ParsedInsert | ParsedUpdate | ParsedDelete | ParsedExists;

export interface PartiqlPlan {
  kind: ParsedStatement["kind"];
  tableName: string;
  indexName?: string;
  item?: Item;
  projection?: PartiqlProjection[];
  projectionExpression?: string;
  conditionExpression?: string;
  updateExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, AttributeValue>;
  keyEqualities: Record<string, AttributeValue>;
  keyAlternatives: Record<string, AttributeValue[]>;
  conditionIsEqualityOnly: boolean;
  inPredicates: Array<{ path: Path; optionCount: number }>;
  keyPredicates: Array<
    | { kind: "compare"; path: Path; operator: "=" | "<" | "<=" | ">" | ">="; value: AttributeValue }
    | { kind: "between"; path: Path; lower: AttributeValue; upper: AttributeValue }
    | { kind: "begins_with"; path: Path; value: AttributeValue }
  >;
  order?: Array<{ path: Path; descending: boolean }>;
  topLevelAttributes: string[];
  returnValues?: "ALL_OLD" | "UPDATED_OLD" | "ALL_NEW" | "UPDATED_NEW";
}

export type PartiqlAccessKind = "exact-get" | "query" | "partition-in" | "scan";

function invalid(message: string, token?: Token): never {
  const location = token ? ` at character ${token.position}` : "";
  throw new AwsError("ValidationException", `Statement wasn't well formed${location}: ${message}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []; let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index++; continue; }
    const position = index; const rest = source.slice(index);
    if (source[index] === "'") {
      index++; let value = ""; let closed = false;
      while (index < source.length) { if (source[index] === "'" && source[index + 1] === "'") { value += "'"; index += 2; continue; } if (source[index] === "'") { index++; closed = true; break; } value += source[index++]; }
      if (!closed) invalid("Unterminated string literal", { kind: "string", value, position }); tokens.push({ kind: "string", value, position }); continue;
    }
    if (source[index] === '"') {
      index++; let value = ""; let closed = false;
      while (index < source.length) { if (source[index] === '"' && source[index + 1] === '"') { value += '"'; index += 2; continue; } if (source[index] === '"') { index++; closed = true; break; } value += source[index++]; }
      if (!closed) invalid("Unterminated quoted identifier", { kind: "identifier", value, position }); tokens.push({ kind: "identifier", value, position }); continue;
    }
    const number = rest.match(/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/); if (number) { tokens.push({ kind: "number", value: number[0], position }); index += number[0].length; continue; }
    const word = rest.match(/^[A-Za-z_][A-Za-z0-9_$]*/); if (word) { tokens.push({ kind: "word", value: word[0], position }); index += word[0].length; continue; }
    if (source[index] === "?") { tokens.push({ kind: "parameter", value: "?", position }); index++; continue; }
    const operator = rest.match(/^(<<|>>|<=|>=|<>|!=|[{}[\](),.:;*+=<>-])/); if (operator) { tokens.push({ kind: "symbol", value: operator[0], position }); index += operator[0].length; continue; }
    invalid(`Unexpected character ${source[index]}`, { kind: "symbol", value: source[index], position });
  }
  tokens.push({ kind: "eof", value: "", position: source.length }); return tokens;
}

class Parser {
  private index = 0; private parameterIndex = 0;
  constructor(private readonly tokens: Token[], private readonly parameters: AttributeValue[]) {}
  peek(offset = 0): Token { return this.tokens[this.index + offset] ?? this.tokens.at(-1)!; }
  take(): Token { return this.tokens[this.index++] ?? this.tokens.at(-1)!; }
  symbol(value: string): boolean { if (this.peek().kind !== "symbol" || this.peek().value !== value) return false; this.index++; return true; }
  expectSymbol(value: string): void { if (!this.symbol(value)) invalid(`Expected ${value}`, this.peek()); }
  keyword(value: string): boolean { if (this.peek().kind !== "word" || this.peek().value.toUpperCase() !== value) return false; this.index++; return true; }
  expectKeyword(value: string): void { if (!this.keyword(value)) invalid(`Expected ${value}`, this.peek()); }
  atKeyword(...values: string[]): boolean { return this.peek().kind === "word" && values.includes(this.peek().value.toUpperCase()); }
  identifier(allowString = false): string { const token = this.take(); if (!new Set<TokenKind>(allowString ? ["word", "identifier", "string"] : ["word", "identifier"]).has(token.kind)) invalid("Expected identifier", token); if (!token.value) invalid("Identifier cannot be empty", token); return token.value; }

  parse(): ParsedStatement {
    let output: ParsedStatement;
    if (this.keyword("SELECT")) output = this.select();
    else if (this.keyword("INSERT")) output = this.insert();
    else if (this.keyword("UPDATE")) output = this.update();
    else if (this.keyword("DELETE")) output = this.delete();
    else if (this.keyword("EXISTS")) output = this.exists();
    else invalid("Only SELECT, INSERT, UPDATE, DELETE, and transactional EXISTS statements are supported", this.peek());
    if (this.peek().kind !== "eof") invalid(`Unexpected token ${this.peek().value}`, this.peek());
    if (this.parameterIndex !== this.parameters.length) invalid(`Expected ${this.parameterIndex} parameters but received ${this.parameters.length}`);
    return output;
  }

  private select(): ParsedSelect {
    let projection: PartiqlValueNode[] | undefined;
    if (!this.symbol("*")) { projection = []; do { projection.push(this.projectionExpression()); } while (this.symbol(",")); }
    this.expectKeyword("FROM"); const tableName = this.identifier(); let indexName: string | undefined; if (this.symbol(".")) indexName = this.identifier();
    let condition: ConditionNode | undefined; let order: ParsedSelect["order"];
    if (this.keyword("WHERE")) condition = this.condition();
    if (this.keyword("ORDER")) { this.expectKeyword("BY"); order = []; do { const path = this.path(); const descending = this.keyword("DESC"); if (!descending) this.keyword("ASC"); order.push({ path, descending }); } while (this.symbol(",")); }
    return { kind: "select", tableName, ...(indexName ? { indexName } : {}), ...(projection ? { projection } : {}), ...(condition ? { condition } : {}), ...(order?.length ? { order } : {}) };
  }

  private projectionExpression(): PartiqlValueNode {
    const expression = this.valueExpression();
    const containsPath = (node: PartiqlValueNode): boolean => node.kind === "path" || node.kind === "function" && node.args.some(containsPath) || node.kind === "arithmetic" && (containsPath(node.left) || containsPath(node.right));
    if (expression.kind === "value" || !containsPath(expression)) invalid("SELECT projections must reference an attribute or document path", this.peek());
    if (expression.kind === "function" && !["size", "attribute_type", "begins_with", "contains"].includes(expression.name)) invalid(`Function ${expression.name} is not valid in a SELECT projection`, this.peek());
    return expression;
  }

  private exists(): ParsedExists {
    this.expectSymbol("("); this.expectKeyword("SELECT"); const selected = this.select(); this.expectSymbol(")");
    if (selected.indexName || selected.projection || selected.order || !selected.condition) invalid("EXISTS requires SELECT * from a table with a WHERE clause", this.peek());
    return { kind: "exists", tableName: selected.tableName, condition: selected.condition };
  }

  private insert(): ParsedInsert {
    this.expectKeyword("INTO"); const tableName = this.identifier(); this.expectKeyword("VALUE"); const value = this.literal();
    if (!("M" in value)) invalid("INSERT VALUE must be a tuple/map", this.peek()); return { kind: "insert", tableName, item: value.M };
  }

  private update(): ParsedUpdate {
    const tableName = this.identifier(); const operations: ParsedUpdate["operations"] = [];
    while (!this.atKeyword("WHERE")) {
      const action = this.keyword("SET") ? "SET" : this.keyword("REMOVE") ? "REMOVE" : invalid("Expected SET, REMOVE, or WHERE", this.peek());
      do { const path = this.path(); if (action === "SET") { this.expectSymbol("="); operations.push({ action, path, value: this.valueExpression() }); } else operations.push({ action, path }); } while (this.symbol(","));
    }
    if (!operations.length) invalid("UPDATE requires at least one SET or REMOVE operation", this.peek()); this.expectKeyword("WHERE"); const condition = this.condition(); let returnValues: ParsedUpdate["returnValues"];
    if (this.keyword("RETURNING")) returnValues = this.returning(false) as ParsedUpdate["returnValues"];
    return { kind: "update", tableName, operations, condition, ...(returnValues ? { returnValues } : {}) };
  }

  private delete(): ParsedDelete {
    this.expectKeyword("FROM"); const tableName = this.identifier(); this.expectKeyword("WHERE"); const condition = this.condition(); let returnValues: "ALL_OLD" | undefined;
    if (this.keyword("RETURNING")) returnValues = this.returning(true) as "ALL_OLD";
    return { kind: "delete", tableName, condition, ...(returnValues ? { returnValues } : {}) };
  }

  private returning(deleteOnly: boolean): string {
    const scope = this.keyword("ALL") ? "ALL" : this.keyword("MODIFIED") ? "UPDATED" : invalid("Expected ALL or MODIFIED after RETURNING", this.peek());
    const timing = this.keyword("OLD") ? "OLD" : this.keyword("NEW") ? "NEW" : invalid("Expected OLD or NEW after RETURNING", this.peek()); this.expectSymbol("*");
    if (deleteOnly && (scope !== "ALL" || timing !== "OLD")) invalid("DELETE supports only RETURNING ALL OLD *", this.peek()); return `${scope}_${timing}`;
  }

  private condition(): ConditionNode { return this.or(); }
  private or(): ConditionNode { let left = this.and(); while (this.keyword("OR")) left = { kind: "or", left, right: this.and() }; return left; }
  private and(): ConditionNode { let left = this.not(); while (this.keyword("AND")) left = { kind: "and", left, right: this.not() }; return left; }
  private not(): ConditionNode { if (this.keyword("NOT")) return { kind: "not", value: this.not() }; return this.conditionPrimary(); }
  private conditionPrimary(): ConditionNode {
    if (this.symbol("(")) { const value = this.condition(); this.expectSymbol(")"); return value; }
    const left = this.valueExpression();
    if (this.keyword("BETWEEN")) { const lower = this.valueExpression(); this.expectKeyword("AND"); return { kind: "between", value: left, lower, upper: this.valueExpression() }; }
    if (this.keyword("IN")) { const open = this.symbol("[") ? "]" : this.symbol("(") ? ")" : invalid("Expected [ after IN", this.peek()); const options: PartiqlValueNode[] = []; if (!this.symbol(open)) { do { options.push(this.valueExpression()); } while (this.symbol(",")); this.expectSymbol(open); } if (!options.length || options.length > 100) invalid("IN requires between 1 and 100 values", this.peek()); return { kind: "in", value: left, options }; }
    if (this.keyword("IS")) {
      const negate = this.keyword("NOT"); const token = this.take(); if (token.kind !== "word" && token.kind !== "identifier") invalid("Expected a PartiQL type after IS", token);
      const type = token.value.toUpperCase(); let predicate: ConditionNode;
      if (type === "MISSING") {
        if (left.kind !== "path") invalid("IS MISSING requires an attribute path", token);
        predicate = { kind: "predicate", value: { kind: "function", name: "attribute_not_exists", args: [left] } };
      } else {
        const types: Record<string, string> = { NULL: "NULL", BOOL: "BOOL", BOOLEAN: "BOOL", STRING: "S", S: "S", NUMBER: "N", DECIMAL: "N", INTEGER: "N", FLOAT: "N", N: "N", BINARY: "B", BLOB: "B", B: "B", LIST: "L", ARRAY: "L", L: "L", MAP: "M", STRUCT: "M", TUPLE: "M", M: "M", STRING_SET: "SS", SS: "SS", NUMBER_SET: "NS", NS: "NS", BINARY_SET: "BS", BS: "BS" };
        const dynamoType = types[type]; if (!dynamoType) invalid(`Unsupported PartiQL type ${token.value}`, token);
        const typed: ConditionNode = { kind: "predicate", value: { kind: "function", name: "attribute_type", args: [left, { kind: "value", value: { S: dynamoType } }] } };
        if (type === "NULL") { if (left.kind !== "path") invalid("IS NULL requires an attribute path", token); predicate = typed; }
        else predicate = typed;
      }
      return negate ? { kind: "not", value: predicate } : predicate;
    }
    const operator = this.peek().kind === "symbol" && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(this.peek().value) ? this.take().value : undefined;
    if (operator) return { kind: "compare", operator: operator === "!=" ? "<>" : operator, left, right: this.valueExpression() };
    if (left.kind === "function") return { kind: "predicate", value: left }; invalid("Expected a comparison or predicate", this.peek());
  }

  private valueExpression(): PartiqlValueNode {
    let left = this.term();
    while (this.peek().kind === "symbol" && ["+", "-"].includes(this.peek().value)) { const operator = this.take().value as "+" | "-"; left = { kind: "arithmetic", operator, left, right: this.term() }; }
    return left;
  }

  private term(): PartiqlValueNode {
    if (this.symbol("(")) { const value = this.valueExpression(); this.expectSymbol(")"); return value; }
    if (this.peek().kind === "parameter" || this.peek().kind === "string" || this.peek().kind === "number" || this.peek().value === "-" || this.peek().value === "[" || this.peek().value === "{" || this.peek().value === "<<" || this.atKeyword("TRUE", "FALSE", "NULL")) return { kind: "value", value: this.literal() };
    if ((this.peek().kind === "word" || this.peek().kind === "identifier") && this.peek(1).value === "(") {
      const name = this.identifier().toLowerCase(); this.expectSymbol("("); const args: PartiqlValueNode[] = []; if (!this.symbol(")")) { do { args.push(this.valueExpression()); } while (this.symbol(",")); this.expectSymbol(")"); }
      if (!new Set(["attribute_type", "begins_with", "contains", "list_append", "set_add", "set_delete", "size"]).has(name)) invalid(`Unsupported function ${name}`, this.peek());
      const arity: Record<string, number> = { attribute_exists: 1, attribute_not_exists: 1, attribute_type: 2, begins_with: 2, contains: 2, list_append: 2, set_add: 2, set_delete: 2, size: 1 };
      if (args.length !== arity[name]) invalid(`${name} expects exactly ${arity[name]} argument${arity[name] === 1 ? "" : "s"}`, this.peek());
      if (["attribute_exists", "attribute_not_exists", "attribute_type", "begins_with", "contains", "size"].includes(name) && args[0]?.kind !== "path") invalid(`${name} requires an attribute or document path as its first argument`, this.peek());
      if (name === "attribute_type") { const type = args[1]?.kind === "value" && "S" in args[1].value ? args[1].value.S : undefined; if (!type || !new Set(["S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"]).has(type)) invalid("attribute_type requires a valid DynamoDB type string", this.peek()); }
      return { kind: "function", name, args };
    }
    return { kind: "path", path: this.path() };
  }

  private path(): Path {
    const path: Path = [this.identifier()];
    while (true) { if (this.symbol(".")) path.push(this.identifier()); else if (this.symbol("[")) { const token = this.take(); if (token.kind !== "number" || !/^\d+$/.test(token.value)) invalid("List index must be a non-negative integer", token); path.push(Number(token.value)); this.expectSymbol("]"); } else break; }
    if (path.length > 32) invalid("Document path has too many dereferences", this.peek()); return path;
  }

  private literal(): AttributeValue {
    if (this.peek().kind === "parameter") { const token = this.take(); const value = this.parameters[this.parameterIndex++]; if (value === undefined) invalid("Not enough parameter values", token); validateAttributeValue(value, `Parameters[${this.parameterIndex - 1}]`); return clone(value); }
    if (this.peek().kind === "string") return { S: this.take().value };
    let negative = false; if (this.symbol("-")) negative = true;
    if (this.peek().kind === "number") { const value: AttributeValue = { N: `${negative ? "-" : ""}${this.take().value}` }; validateAttributeValue(value); return value; }
    if (negative) invalid("Expected a number after -", this.peek());
    if (this.keyword("TRUE")) return { BOOL: true }; if (this.keyword("FALSE")) return { BOOL: false }; if (this.keyword("NULL")) return { NULL: true };
    if (this.symbol("[")) { const values: AttributeValue[] = []; if (!this.symbol("]")) { do { values.push(this.literal()); } while (this.symbol(",")); this.expectSymbol("]"); } const output: AttributeValue = { L: values }; validateAttributeValue(output); return output; }
    if (this.symbol("{")) { const values: Item = {}; if (!this.symbol("}")) { do { const name = this.identifier(true); this.expectSymbol(":"); if (Object.hasOwn(values, name)) invalid(`Duplicate tuple field ${name}`, this.peek()); values[name] = this.literal(); } while (this.symbol(",")); this.expectSymbol("}"); } const output: AttributeValue = { M: values }; validateAttributeValue(output); return output; }
    if (this.symbol("<<")) { const values: AttributeValue[] = []; if (!this.symbol(">>")) { do { values.push(this.literal()); } while (this.symbol(",")); this.expectSymbol(">>"); } if (!values.length) invalid("Sets cannot be empty", this.peek()); const type = attributeType(values[0]); if (!new Set(["S", "N", "B"]).has(type) || values.some(value => attributeType(value) !== type)) invalid("Set members must use one scalar type", this.peek()); const contents = values.map(value => (value as any)[type]); const output = { [`${type}S`]: contents } as unknown as AttributeValue; validateAttributeValue(output); return output; }
    invalid("Expected a literal value or parameter", this.peek());
  }
}

class ExpressionBuilder {
  readonly names: Record<string, string> = {}; readonly values: Record<string, AttributeValue> = {}; private nameIndex = 0; private valueIndex = 0;
  path(path: Path): string { return path.map((part, index) => typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${this.name(part)}`).join(""); }
  name(value: string): string { const existing = Object.entries(this.names).find(([, name]) => name === value)?.[0]; if (existing) return existing; const key = `#p${this.nameIndex++}`; this.names[key] = value; return key; }
  value(value: AttributeValue): string { const key = `:p${this.valueIndex++}`; this.values[key] = clone(value); return key; }
  node(node: PartiqlValueNode): string {
    if (node.kind === "path") return this.path(node.path); if (node.kind === "value") return this.value(node.value);
    if (node.kind === "arithmetic") return `${this.node(node.left)} ${node.operator} ${this.node(node.right)}`;
    if (["set_add", "set_delete"].includes(node.name)) invalid(`${node.name} is valid only as the complete right side of SET`); return `${node.name}(${node.args.map(arg => this.node(arg)).join(", ")})`;
  }
  condition(node: ConditionNode): string {
    if (node.kind === "and") return `(${this.condition(node.left)}) AND (${this.condition(node.right)})`;
    if (node.kind === "or") return `(${this.condition(node.left)}) OR (${this.condition(node.right)})`;
    if (node.kind === "not") return `NOT (${this.condition(node.value)})`;
    if (node.kind === "compare") return `${this.node(node.left)} ${node.operator} ${this.node(node.right)}`;
    if (node.kind === "between") return `${this.node(node.value)} BETWEEN ${this.node(node.lower)} AND ${this.node(node.upper)}`;
    if (node.kind === "in") return `${this.node(node.value)} IN (${node.options.map(value => this.node(value)).join(", ")})`;
    return this.node(node.value);
  }
}

function equalityAlternatives(node: ConditionNode | undefined): Record<string, AttributeValue[]> {
  if (!node || node.kind === "not") return {};
  if (node.kind === "compare" && node.operator === "=") {
    const path = node.left.kind === "path" && node.left.path.length === 1 ? node.left : node.right.kind === "path" && node.right.path.length === 1 ? node.right : undefined;
    const value = node.left.kind === "value" ? node.left : node.right.kind === "value" ? node.right : undefined;
    return path && value ? { [String(path.path[0])]: [clone(value.value)] } : {};
  }
  if (node.kind === "in" && node.value.kind === "path" && node.value.path.length === 1 && node.options.every(option => option.kind === "value")) {
    return { [String(node.value.path[0])]: node.options.map(option => clone((option as { kind: "value"; value: AttributeValue }).value)) };
  }
  if (node.kind !== "and" && node.kind !== "or") return {};
  const left = equalityAlternatives(node.left); const right = equalityAlternatives(node.right); const output: Record<string, AttributeValue[]> = {};
  const unique = (values: AttributeValue[]) => values.filter((value, index) => values.findIndex(candidate => equalAttributeValues(candidate, value)) === index).map(clone);
  if (node.kind === "or") {
    for (const name of Object.keys(left)) if (right[name]) output[name] = unique([...left[name], ...right[name]]);
    return output;
  }
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!left[name]) output[name] = unique(right[name]);
    else if (!right[name]) output[name] = unique(left[name]);
    else {
      const overlap = left[name].filter(value => right[name].some(candidate => equalAttributeValues(candidate, value)));
      if (overlap.length) output[name] = unique(overlap);
    }
  }
  return output;
}

function conditionIsEqualityOnly(node: ConditionNode | undefined): boolean {
  if (!node) return false; if (node.kind === "and") return conditionIsEqualityOnly(node.left) && conditionIsEqualityOnly(node.right);
  if (node.kind !== "compare" || node.operator !== "=") return false;
  return (node.left.kind === "path" && node.left.path.length === 1 && node.right.kind === "value") || (node.right.kind === "path" && node.right.path.length === 1 && node.left.kind === "value");
}

function inPredicates(node: ConditionNode | undefined): Array<{ path: Path; optionCount: number }> {
  const output: Array<{ path: Path; optionCount: number }> = [];
  const visit = (condition: ConditionNode): void => {
    if (condition.kind === "and" || condition.kind === "or") { visit(condition.left); visit(condition.right); return; }
    if (condition.kind === "not") { visit(condition.value); return; }
    if (condition.kind === "in" && condition.value.kind === "path") output.push({ path: [...condition.value.path], optionCount: condition.options.length });
  };
  if (node) visit(node); return output;
}

function keyPredicates(node: ConditionNode | undefined): PartiqlPlan["keyPredicates"] {
  const output: PartiqlPlan["keyPredicates"] = [];
  const reversed: Record<string, "=" | "<" | "<=" | ">" | ">="> = { "=": "=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
  const visit = (condition: ConditionNode): void => {
    if (condition.kind === "and") { visit(condition.left); visit(condition.right); return; }
    if (condition.kind === "or" || condition.kind === "not") return;
    if (condition.kind === "compare" && Object.hasOwn(reversed, condition.operator)) {
      if (condition.left.kind === "path" && condition.right.kind === "value") output.push({ kind: "compare", path: [...condition.left.path], operator: condition.operator as "=" | "<" | "<=" | ">" | ">=", value: clone(condition.right.value) });
      else if (condition.right.kind === "path" && condition.left.kind === "value") output.push({ kind: "compare", path: [...condition.right.path], operator: reversed[condition.operator], value: clone(condition.left.value) });
      return;
    }
    if (condition.kind === "between" && condition.value.kind === "path" && condition.lower.kind === "value" && condition.upper.kind === "value") {
      output.push({ kind: "between", path: [...condition.value.path], lower: clone(condition.lower.value), upper: clone(condition.upper.value) }); return;
    }
    if (condition.kind === "predicate" && condition.value.kind === "function" && condition.value.name === "begins_with" && condition.value.args[0]?.kind === "path" && condition.value.args[1]?.kind === "value") {
      output.push({ kind: "begins_with", path: [...condition.value.args[0].path], value: clone(condition.value.args[1].value) });
    }
  };
  if (node) visit(node); return output;
}

function valuePaths(node: PartiqlValueNode): Path[] {
  if (node.kind === "path") return [[...node.path]];
  if (node.kind === "function") return node.args.flatMap(valuePaths);
  if (node.kind === "arithmetic") return [...valuePaths(node.left), ...valuePaths(node.right)];
  return [];
}

function conditionPaths(node: ConditionNode | undefined): Path[] {
  if (!node) return [];
  if (node.kind === "and" || node.kind === "or") return [...conditionPaths(node.left), ...conditionPaths(node.right)];
  if (node.kind === "not") return conditionPaths(node.value);
  if (node.kind === "compare") return [...valuePaths(node.left), ...valuePaths(node.right)];
  if (node.kind === "between") return [...valuePaths(node.value), ...valuePaths(node.lower), ...valuePaths(node.upper)];
  if (node.kind === "in") return [...valuePaths(node.value), ...node.options.flatMap(valuePaths)];
  return valuePaths(node.value);
}

function expressionValue(node: PartiqlValueNode, item: Item): AttributeValue | undefined {
  if (node.kind === "path") return getPath(item, node.path);
  if (node.kind === "value") return clone(node.value);
  if (node.kind === "arithmetic") {
    const left = expressionValue(node.left, item); const right = expressionValue(node.right, item);
    if (!left || !right) return undefined;
    if (attributeType(left) !== "N" || attributeType(right) !== "N") throw new AwsError("ValidationException", "Incorrect operand type for PartiQL arithmetic expression");
    return { N: addNumbers((left as { N: string }).N, (right as { N: string }).N, node.operator === "-") };
  }
  const args = node.args.map(argument => expressionValue(argument, item));
  if (node.name === "size") {
    const value = args[0]; if (!value) return undefined; const type = attributeType(value); const content = (value as any)[type];
    if (type === "S") return { N: String(Buffer.byteLength(content)) };
    if (type === "B") return { N: String(Buffer.from(content, "base64").length) };
    if (["L", "SS", "NS", "BS"].includes(type)) return { N: String(content.length) };
    if (type === "M") return { N: String(Object.keys(content).length) };
    throw new AwsError("ValidationException", "Incorrect operand type for operator or function; operator or function: size");
  }
  if (node.name === "attribute_type") {
    const value = args[0]; const expected = args[1];
    if (!expected || attributeType(expected) !== "S") throw new AwsError("ValidationException", "attribute_type requires a DynamoDB type string");
    return { BOOL: Boolean(value && attributeType(value) === (expected as { S: string }).S) };
  }
  if (node.name === "attribute_exists") return { BOOL: args[0] !== undefined };
  if (node.name === "attribute_not_exists") return { BOOL: args[0] === undefined };
  if (node.name === "begins_with") {
    const [value, prefix] = args; if (!value || !prefix) return { BOOL: false }; const type = attributeType(value);
    if (type !== attributeType(prefix) || !["S", "B"].includes(type)) throw new AwsError("ValidationException", "Incorrect operand type for operator or function; operator or function: begins_with");
    if (type === "B") return { BOOL: Buffer.from((value as any).B, "base64").subarray(0, Buffer.from((prefix as any).B, "base64").length).equals(Buffer.from((prefix as any).B, "base64")) };
    return { BOOL: (value as any).S.startsWith((prefix as any).S) };
  }
  if (node.name === "contains") {
    const [value, operand] = args; if (!value || !operand) return { BOOL: false }; const type = attributeType(value); const content = (value as any)[type];
    if (type === "S" && attributeType(operand) === "S") return { BOOL: content.includes((operand as any).S) };
    if (type === "L") return { BOOL: content.some((entry: AttributeValue) => equalAttributeValues(entry, operand)) };
    if (["SS", "NS", "BS"].includes(type) && attributeType(operand) === type[0]) return { BOOL: content.some((entry: string) => equalAttributeValues({ [type[0]]: entry } as unknown as AttributeValue, operand)) };
    throw new AwsError("ValidationException", "Incorrect operand type for operator or function; operator or function: contains");
  }
  throw new AwsError("ValidationException", `Function ${node.name} is not valid in a SELECT projection`);
}

function setProjectedPath(item: Item, path: Path, value: AttributeValue): void {
  if (path.length === 1) { item[String(path[0])] = clone(value); return; }
  const root = String(path[0]); item[root] ??= typeof path[1] === "number" ? { L: [] } : { M: {} }; let current: any = item[root];
  for (let index = 1; index < path.length - 1; index++) { const part = path[index]; const next = path[index + 1]; if (typeof part === "number") { current.L[part] ??= typeof next === "number" ? { L: [] } : { M: {} }; current = current.L[part]; } else { current.M[part] ??= typeof next === "number" ? { L: [] } : { M: {} }; current = current.M[part]; } }
  const final = path.at(-1)!; if (typeof final === "number") current.L.push(clone(value)); else current.M[final] = clone(value);
}

export function projectPartiqlItem(item: Item, plan: PartiqlPlan): Item {
  if (!plan.projection) return clone(item);
  const output: Item = {};
  for (const entry of plan.projection) {
    const value = expressionValue(entry.expression, item); if (value === undefined) continue;
    if (entry.expression.kind === "path") setProjectedPath(output, entry.expression.path, value); else output[entry.outputName] = clone(value);
  }
  return output;
}

export function classifyPartiqlAccess(plan: PartiqlPlan, keySchema: Array<{ AttributeName: string; KeyType: string }>, tableKeySchema = keySchema): PartiqlAccessKind {
  if (plan.kind !== "select") return "scan";
  const partition = keySchema.find(key => key.KeyType === "HASH")?.AttributeName;
  if (!partition) return "scan";
  if (!plan.indexName && tableKeySchema.every(key => plan.keyEqualities[key.AttributeName])) return "exact-get";
  const alternatives = plan.keyAlternatives[partition] ?? [];
  if (alternatives.length > 1) return "partition-in";
  if (alternatives.length === 1) return "query";
  return "scan";
}

export function parsePartiql(statement: unknown, parameters: unknown): PartiqlPlan {
  if (typeof statement !== "string" || statement.length < 1 || statement.length > 8192) throw new AwsError("ValidationException", "Statement must contain between 1 and 8192 characters");
  if (parameters !== undefined && (!Array.isArray(parameters) || !parameters.length)) throw new AwsError("ValidationException", "Parameters must contain at least one AttributeValue when provided");
  const parsed = new Parser(tokenize(statement), (parameters ?? []) as AttributeValue[]).parse(); const builder = new ExpressionBuilder();
  if (parsed.kind === "insert") return { kind: parsed.kind, tableName: parsed.tableName, item: clone(parsed.item), keyEqualities: {}, keyAlternatives: {}, conditionIsEqualityOnly: false, inPredicates: [], keyPredicates: [], topLevelAttributes: Object.keys(parsed.item).sort() };
  const conditionExpression = parsed.condition ? builder.condition(parsed.condition) : undefined; const alternatives = equalityAlternatives(parsed.condition); const equalities = Object.fromEntries(Object.entries(alternatives).filter(([, values]) => values.length === 1).map(([name, values]) => [name, clone(values[0])]));
  let projectionExpression: string | undefined; let projection: PartiqlProjection[] | undefined;
  if (parsed.kind === "select" && parsed.projection) {
    projection = parsed.projection.map((expression, index) => ({ expression: clone(expression), outputName: expression.kind === "path" ? String(expression.path[0]) : `_${index + 1}` }));
    if (parsed.projection.every(expression => expression.kind === "path")) projectionExpression = parsed.projection.map(expression => builder.path((expression as { kind: "path"; path: Path }).path)).join(", ");
  }
  let updateExpression: string | undefined;
  if (parsed.kind === "update") {
    const groups: Record<"SET" | "REMOVE" | "ADD" | "DELETE", string[]> = { SET: [], REMOVE: [], ADD: [], DELETE: [] };
    for (const operation of parsed.operations) {
      const path = builder.path(operation.path); if (operation.action === "REMOVE") { groups.REMOVE.push(path); continue; }
      const value = operation.value!;
      if (value.kind === "function" && ["set_add", "set_delete"].includes(value.name)) {
        if (value.args.length !== 2 || value.args[0].kind !== "path" || JSON.stringify(value.args[0].path) !== JSON.stringify(operation.path) || value.args[1].kind !== "value") invalid(`${value.name} must receive the target path and one value`);
        groups[value.name === "set_add" ? "ADD" : "DELETE"].push(`${path} ${builder.node(value.args[1])}`);
      } else groups.SET.push(`${path} = ${builder.node(value)}`);
    }
    updateExpression = (["SET", "REMOVE", "ADD", "DELETE"] as const).filter(action => groups[action].length).map(action => `${action} ${groups[action].join(", ")}`).join(" ");
  }
  return {
    kind: parsed.kind, tableName: parsed.tableName, ...(parsed.kind === "select" && parsed.indexName ? { indexName: parsed.indexName } : {}), ...(projection ? { projection } : {}), ...(projectionExpression ? { projectionExpression } : {}), ...(conditionExpression ? { conditionExpression } : {}), ...(updateExpression ? { updateExpression } : {}), ...(Object.keys(builder.names).length ? { expressionAttributeNames: builder.names } : {}), ...(Object.keys(builder.values).length ? { expressionAttributeValues: builder.values } : {}), keyEqualities: equalities, keyAlternatives: alternatives, conditionIsEqualityOnly: conditionIsEqualityOnly(parsed.condition), inPredicates: inPredicates(parsed.condition), keyPredicates: keyPredicates(parsed.condition), ...(parsed.kind === "select" && parsed.order ? { order: parsed.order } : {}), topLevelAttributes: [...new Set([...(parsed.kind === "select" ? parsed.projection?.flatMap(valuePaths) ?? [] : []), ...conditionPaths(parsed.condition), ...(parsed.kind === "update" ? parsed.operations.flatMap(operation => [operation.path, ...(operation.value ? valuePaths(operation.value) : [])]) : [])].filter(path => path.length).map(path => String(path[0])))].sort(), ...("returnValues" in parsed && parsed.returnValues ? { returnValues: parsed.returnValues } : {}),
  };
}
