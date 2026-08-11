/**
 * StackSim's deliberately bounded MySQL 8 SQL profile.
 *
 * This is a lexer-backed classifier and rewriter, not a general MySQL parser.
 * Every statement is assigned to a closed statement family before SQLite sees
 * it. The accepted families are then checked for SQLite-only escape hatches
 * and profile-specific grammar. Unsupported input fails with ER_PARSE_ERROR.
 */

export const MYSQL_PROFILE_VERSION = "mysql8-orm-v1";
export const MYSQL_SERVER_VERSION = "8.0.0-stacksim-orm-v1";

export interface MysqlProfileContext {
  database?: string;
  parameters: Record<string, string>;
  lastInsertId: number;
}

export type MysqlProfilePlan =
  | { kind: "sqlite"; sql: string; returnsRows: boolean; informationSchema: boolean }
  | { kind: "set" }
  | { kind: "createDatabase"; database: string; ifNotExists: boolean }
  | { kind: "useDatabase"; database: string }
  | { kind: "showDatabases" }
  | { kind: "showTables"; full: boolean }
  | { kind: "describe"; table: string }
  | { kind: "showIndex"; table: string };

export interface MysqlProfileError extends Error {
  mysqlCode: number;
  sqlState: string;
}

type TokenKind = "word" | "identifier" | "string" | "number" | "parameter" | "symbol";

interface Token {
  kind: TokenKind;
  raw: string;
  upper: string;
  start: number;
  end: number;
}

const SQLITE_ONLY_WORDS = new Set([
  "ATTACH", "DETACH", "PRAGMA", "VACUUM", "AUTOINCREMENT", "GLOB",
  "DEFERRABLE", "INDEXED", "INITIALLY", "MATCH", "MATERIALIZED", "NOTNULL",
  "ROWID", "STRICT", "WITHOUT", "SQLITE_MASTER", "SQLITE_SCHEMA",
]);
const ADMIN_ROOTS = new Set([
  "ANALYZE", "CALL", "DO", "GRANT", "HANDLER", "INSTALL", "KILL", "LOAD",
  "LOCK", "OPTIMIZE", "REPAIR", "REPLACE", "REVOKE", "SHUTDOWN", "TRUNCATE",
  "UNINSTALL", "UNLOCK",
]);
const COMMON_FUNCTIONS = new Set([
  "ABS", "AVG", "COALESCE", "COUNT",
  "DATABASE", "IFNULL", "LAST_INSERT_ID", "LENGTH", "LOWER", "MAX", "MIN",
  "NULLIF", "ROUND", "SUM", "UPPER", "VERSION",
  "VALUES",
]);
const MYSQL_TYPES = new Set([
  "BIGINT", "BINARY", "BLOB", "BOOL", "BOOLEAN", "CHAR", "DATE", "DATETIME",
  "DECIMAL", "DOUBLE", "FLOAT", "INT", "INTEGER", "JSON", "LONGBLOB", "LONGTEXT",
  "MEDIUMBLOB", "MEDIUMINT", "MEDIUMTEXT", "NUMERIC", "REAL", "SMALLINT", "TEXT",
  "TIME", "TIMESTAMP", "TINYBLOB", "TINYINT", "TINYTEXT", "VARBINARY", "VARCHAR",
]);
const INFORMATION_SCHEMA_TABLES = new Set(["TABLES", "COLUMNS", "STATISTICS", "SCHEMATA"]);

export function compileMysqlStatement(source: string, context: MysqlProfileContext): MysqlProfilePlan {
  const sql = stripOneTerminator(source);
  if (!sql) return { kind: "set" };
  const tokens = lex(sql);
  if (!tokens.length) return { kind: "set" };
  rejectSqliteOnly(tokens);

  const root = tokens[0].upper;
  if (ADMIN_ROOTS.has(root)) unsupported(`${root} is outside the StackSim MySQL 8 development profile`);
  if (root === "SET") return compileSet(tokens);
  if (root === "SHOW") return compileShow(tokens);
  if (root === "USE") {
    if (tokens.length !== 2) unsupported("USE accepts exactly one database name");
    return { kind: "useDatabase", database: identifier(tokens[1]) };
  }
  if (root === "DESCRIBE" || root === "DESC") return compileDescribe(tokens);
  if (root === "START") {
    requireWords(tokens, ["START", "TRANSACTION"]);
    return sqlitePlan("BEGIN", false);
  }
  if (root === "BEGIN") {
    if (tokens.length !== 1 && !(tokens.length === 2 && tokens[1].upper === "WORK")) unsupported("Only BEGIN or BEGIN WORK is supported");
    return sqlitePlan("BEGIN", false);
  }
  if (root === "COMMIT" || root === "ROLLBACK") {
    if (tokens.length !== 1 && !(tokens.length === 2 && tokens[1].upper === "WORK")) unsupported(`${root} options are unsupported`);
    return sqlitePlan(root, false);
  }
  if (root === "CREATE") return compileCreate(sql, tokens, context);
  if (root === "ALTER") return compileAlter(sql, tokens, context);
  if (root === "DROP") return compileDrop(sql, tokens);
  if (root === "SELECT" || root === "WITH") return compileQuery(sql, tokens, context, true);
  if (root === "INSERT" || root === "UPDATE" || root === "DELETE") return compileQuery(sql, tokens, context, false);
  unsupported(`Statement family ${root} is unsupported`);
}

function compileSet(tokens: Token[]): MysqlProfilePlan {
  const words = tokens.map(token => token.upper).join(" ");
  if (/^SET NAMES UTF8MB4(?: COLLATE UTF8MB4_BIN)?$/.test(words)) return { kind: "set" };
  if (/^SET (?:SESSION )?TIME_ZONE = ['"]?\+00:00['"]?$/.test(words)) return { kind: "set" };
  if (words === "SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE") return { kind: "set" };
  if (words === "SET AUTOCOMMIT = 1" || words === "SET SESSION AUTOCOMMIT = 1") return { kind: "set" };
  if (words === "SET FOREIGN_KEY_CHECKS = 1" || words === "SET SESSION FOREIGN_KEY_CHECKS = 1") return { kind: "set" };
  unsupported("This SET form has no equivalent in the StackSim MySQL 8 development profile");
}

function compileShow(tokens: Token[]): MysqlProfilePlan {
  let index = 1;
  if (tokens[index]?.upper === "DATABASES" && index + 1 === tokens.length) return { kind: "showDatabases" };
  let full = false;
  if (tokens[index]?.upper === "FULL") { full = true; index += 1; }
  if (tokens[index]?.upper === "TABLES" && index + 1 === tokens.length) return { kind: "showTables", full };
  if ((tokens[index]?.upper === "COLUMNS" || tokens[index]?.upper === "FIELDS") && tokens[index + 1]?.upper === "FROM" && index + 3 === tokens.length) {
    return { kind: "describe", table: identifier(tokens[index + 2]) };
  }
  if ((tokens[index]?.upper === "INDEX" || tokens[index]?.upper === "INDEXES" || tokens[index]?.upper === "KEYS") && (tokens[index + 1]?.upper === "FROM" || tokens[index + 1]?.upper === "IN") && index + 3 === tokens.length) {
    return { kind: "showIndex", table: identifier(tokens[index + 2]) };
  }
  unsupported("This SHOW form is outside the published metadata profile");
}

function compileDescribe(tokens: Token[]): MysqlProfilePlan {
  if (tokens.length !== 2) unsupported("DESCRIBE accepts exactly one table in this profile");
  return { kind: "describe", table: identifier(tokens[1]) };
}

function compileCreate(sql: string, tokens: Token[], context: MysqlProfileContext): MysqlProfilePlan {
  let index = 1;
  let unique = false;
  if (tokens[index]?.upper === "UNIQUE") { unique = true; index += 1; }
  if (tokens[index]?.upper === "DATABASE") {
    index += 1;
    let ifNotExists = false;
    if (tokens[index]?.upper === "IF") {
      requireWords(tokens.slice(index, index + 3), ["IF", "NOT", "EXISTS"]);
      ifNotExists = true; index += 3;
    }
    if (index + 1 !== tokens.length) unsupported("CREATE DATABASE accepts one database name and optional IF NOT EXISTS");
    return { kind: "createDatabase", database: identifier(tokens[index]), ifNotExists };
  }
  if (tokens[index]?.upper === "INDEX" || tokens[index]?.upper === "KEY") {
    return compileCreateIndex(sql, tokens, index, unique);
  }
  if (unique) unsupported("UNIQUE is valid here only for CREATE UNIQUE INDEX");
  if (tokens[index]?.upper !== "TABLE") unsupported("Only CREATE TABLE and CREATE [UNIQUE] INDEX are supported");
  return sqlitePlan(rewriteCreateTable(sql, tokens, index, context), false);
}

function compileCreateIndex(sql: string, tokens: Token[], index: number, _unique: boolean): MysqlProfilePlan {
  const on = tokens.findIndex((token, tokenIndex) => tokenIndex > index && token.upper === "ON");
  if (on < 0 || on + 2 >= tokens.length) unsupported("CREATE INDEX requires an index name, table, and column list");
  identifier(tokens[index + 1]);
  identifier(tokens[on + 1]);
  requireBalancedParentheses(tokens);
  rejectUnsupportedFunctions(tokens);
  return sqlitePlan(sql, false);
}

function rewriteCreateTable(sql: string, tokens: Token[], tableTokenIndex: number, context: MysqlProfileContext): string {
  let nameIndex = tableTokenIndex + 1;
  if (tokens[nameIndex]?.upper === "IF") {
    requireWords(tokens.slice(nameIndex, nameIndex + 3), ["IF", "NOT", "EXISTS"]);
    nameIndex += 3;
  }
  identifier(tokens[nameIndex]);
  const open = tokens.findIndex((token, index) => index > nameIndex && token.raw === "(");
  if (open < 0) unsupported("CREATE TABLE requires a parenthesized column definition list");
  const close = matchingClose(tokens, open);
  if (close < 0) unsupported("CREATE TABLE has unbalanced parentheses");
  const definitions = splitTokenRanges(tokens, open + 1, close);
  if (!definitions.length) unsupported("CREATE TABLE requires at least one column");

  const parsed = definitions.map(range => parseTableDefinition(sql, tokens.slice(range.start, range.end), context));
  const auto = parsed.filter(value => value.autoIncrement);
  if (auto.length > 1) unsupported("Only one AUTO_INCREMENT column is supported");
  if (auto.length === 1) {
    const primaryDefinitions = parsed.filter(value => value.tablePrimaryColumns);
    if (!auto[0].inlinePrimary) {
      if (primaryDefinitions.length !== 1 || primaryDefinitions[0].tablePrimaryColumns?.length !== 1 || primaryDefinitions[0].tablePrimaryColumns?.[0].toLowerCase() !== auto[0].columnName?.toLowerCase()) {
        unsupported("AUTO_INCREMENT must be the single-column PRIMARY KEY");
      }
      auto[0].sql += " PRIMARY KEY AUTOINCREMENT";
      primaryDefinitions[0].omit = true;
    }
  }
  const body = parsed.filter(value => !value.omit).map(value => value.sql).join(", ");
  validateTableOptions(tokens.slice(close + 1));
  const prefix = sql.slice(0, tokens[open].start).trimEnd();
  return `${prefix} (${body})`;
}

interface ParsedDefinition {
  sql: string;
  columnName?: string;
  autoIncrement?: boolean;
  inlinePrimary?: boolean;
  tablePrimaryColumns?: string[];
  omit?: boolean;
}

function parseTableDefinition(source: string, tokens: Token[], context: MysqlProfileContext): ParsedDefinition {
  if (!tokens.length) unsupported("Empty CREATE TABLE definition");
  let constraintIndex = 0;
  if (tokens[0].upper === "CONSTRAINT") {
    identifier(tokens[1]);
    constraintIndex = 2;
  }
  if (tokens[constraintIndex]?.upper === "PRIMARY") {
    if (tokens[constraintIndex + 1]?.upper !== "KEY") unsupported("Malformed PRIMARY KEY constraint");
    const open = tokens.findIndex((token, index) => index > constraintIndex && token.raw === "(");
    const close = open >= 0 ? matchingClose(tokens, open) : -1;
    if (open < 0 || close !== tokens.length - 1) unsupported("PRIMARY KEY must contain a bounded column list");
    const columns = splitTokenRanges(tokens, open + 1, close).map(range => {
      const part = tokens.slice(range.start, range.end);
      if (part.length !== 1) unsupported("PRIMARY KEY column expressions are unsupported");
      return identifier(part[0]);
    });
    return { sql: source.slice(tokens[0].start, tokens.at(-1)!.end), tablePrimaryColumns: columns };
  }
  if (["UNIQUE", "FOREIGN", "CHECK"].includes(tokens[constraintIndex]?.upper)) {
    if (tokens[constraintIndex].upper === "CHECK") unsupported("CHECK constraints are outside the selected ORM profile");
    requireBalancedParentheses(tokens);
    return { sql: source.slice(tokens[0].start, tokens.at(-1)!.end) };
  }
  const columnName = identifier(tokens[0]);
  const type = tokens[1]?.upper;
  if (!type || !MYSQL_TYPES.has(type)) unsupported(`Column ${columnName} uses an unsupported or missing MySQL type`);
  const autoIndex = tokens.findIndex(token => token.upper === "AUTO_INCREMENT");
  const primaryIndex = tokens.findIndex((token, index) => token.upper === "PRIMARY" && tokens[index + 1]?.upper === "KEY");
  if (autoIndex >= 0 && !new Set(["INT", "INTEGER", "BIGINT", "MEDIUMINT", "SMALLINT", "TINYINT"]).has(type)) unsupported("AUTO_INCREMENT requires an integer column");
  if (autoIndex >= 0 && primaryIndex < 0 && !tokens.some(token => token.upper === "PRIMARY")) {
    // A table-level primary key may add the primary declaration later.
  }
  const edits: Array<{ start: number; end: number; value: string }> = [];
  if (tokens.some(token => token.upper === "UNSIGNED")) {
    for (const token of tokens.filter(token => token.upper === "UNSIGNED")) edits.push({ start: token.start, end: token.end, value: "" });
  }
  if (autoIndex >= 0) {
    const typeEnd = typeArgumentsEnd(tokens, 1);
    edits.push({ start: tokens[1].start, end: tokens[typeEnd].end, value: "INTEGER" });
    edits.push({ start: tokens[autoIndex].start, end: tokens[autoIndex].end, value: "" });
    if (primaryIndex >= 0) edits.push({ start: tokens[primaryIndex + 1].end, end: tokens[primaryIndex + 1].end, value: " AUTOINCREMENT" });
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].upper === "CHARACTER" && tokens[index + 1]?.upper === "SET") {
      if (tokens[index + 2]?.upper !== "UTF8MB4") unsupported("Only CHARACTER SET utf8mb4 is supported");
      edits.push({ start: tokens[index].start, end: tokens[index + 2].end, value: "" });
    }
    if (tokens[index].upper === "COLLATE") {
      if (tokens[index + 1]?.upper !== "UTF8MB4_BIN") unsupported("Only the SQLite-equivalent utf8mb4_bin SQL collation is supported");
      edits.push({ start: tokens[index].start, end: tokens[index + 1].end, value: "COLLATE BINARY" });
    }
    if (tokens[index].upper === "CURRENT_TIMESTAMP" && tokens[index + 1]?.raw === "(") {
      const close = matchingClose(tokens, index + 1);
      if (close < 0 || close > index + 3) unsupported("Unsupported CURRENT_TIMESTAMP precision");
      edits.push({ start: tokens[index].start, end: tokens[close].end, value: "CURRENT_TIMESTAMP" });
    }
  }
  validateColumnTokens(tokens);
  const sql = applyEdits(source, tokens[0].start, tokens.at(-1)!.end, edits).trim().replace(/\s{2,}/g, " ");
  return { sql, columnName, autoIncrement: autoIndex >= 0, inlinePrimary: primaryIndex >= 0 };
}

function validateColumnTokens(tokens: Token[]): void {
  if (tokens.some(token => new Set(["COMMENT", "GENERATED", "STORED", "VIRTUAL", "ZEROFILL"]).has(token.upper))) {
    unsupported("Column comments, generated columns, and ZEROFILL are outside the selected ORM profile");
  }
  if (tokens.some((token, index) => token.upper === "ON" && tokens[index + 1]?.upper === "UPDATE")) {
    unsupported("ON UPDATE column expressions are outside the selected ORM profile");
  }
  const allowed = new Set([
    ...MYSQL_TYPES, "AUTO_INCREMENT", "BINARY", "CHARACTER", "COLLATE", "CURRENT_TIMESTAMP",
    "DEFAULT", "KEY", "NOT", "NULL", "ON", "PRIMARY", "REFERENCES", "SET",
    "FALSE", "TRUE", "UNIQUE", "UNSIGNED", "UPDATE", "UTF8MB4", "UTF8MB4_BIN",
  ]);
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "word" && !allowed.has(token.upper) && tokens[index - 1]?.upper !== "REFERENCES") {
      unsupported(`Column modifier ${token.raw} is unsupported`);
    }
  }
}

function validateTableOptions(tokens: Token[]): void {
  if (!tokens.length) return;
  const words = tokens.map(token => token.upper);
  let index = 0;
  while (index < words.length) {
    if (words[index] === "ENGINE" && tokens[index + 1]?.raw === "=" && words[index + 2] === "INNODB") { index += 3; continue; }
    if (words[index] === "DEFAULT" && words[index + 1] === "CHARSET" && tokens[index + 2]?.raw === "=" && words[index + 3] === "UTF8MB4") { index += 4; continue; }
    if (words[index] === "CHARSET" && tokens[index + 1]?.raw === "=" && words[index + 2] === "UTF8MB4") { index += 3; continue; }
    if (words[index] === "COLLATE" && tokens[index + 1]?.raw === "=" && words[index + 2] === "UTF8MB4_BIN") { index += 3; continue; }
    unsupported(`CREATE TABLE option ${tokens[index].raw} is unsupported`);
  }
}

function compileAlter(sql: string, tokens: Token[], context: MysqlProfileContext): MysqlProfilePlan {
  if (tokens[1]?.upper !== "TABLE") unsupported("Only ALTER TABLE is supported");
  const table = identifier(tokens[2]);
  let index = 3;
  if (tokens[index]?.upper === "ADD" && (tokens[index + 1]?.upper === "INDEX" || tokens[index + 1]?.upper === "KEY" || tokens[index + 1]?.upper === "UNIQUE")) {
    let unique = "";
    index += 1;
    if (tokens[index]?.upper === "UNIQUE") { unique = "UNIQUE "; index += 1; if (tokens[index]?.upper === "INDEX" || tokens[index]?.upper === "KEY") index += 1; }
    else index += 1;
    const indexName = identifier(tokens[index]);
    const columns = sql.slice(tokens[index + 1]?.start ?? sql.length);
    if (!columns.startsWith("(")) unsupported("ALTER TABLE ADD INDEX requires a column list");
    requireBalancedParentheses(tokens.slice(index + 1));
    return sqlitePlan(`CREATE ${unique}INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table)} ${columns}`, false);
  }
  if (tokens[index]?.upper === "DROP" && (tokens[index + 1]?.upper === "INDEX" || tokens[index + 1]?.upper === "KEY")) {
    const name = identifier(tokens[index + 2]);
    if (index + 3 !== tokens.length) unsupported("ALTER TABLE DROP INDEX accepts one index name");
    return sqlitePlan(`DROP INDEX ${quoteIdentifier(name)}`, false);
  }
  if (tokens[index]?.upper === "ADD") {
    if (tokens[index + 1]?.upper === "COLUMN") index += 1;
    const definitionTokens = tokens.slice(index + 1);
    const parsed = parseTableDefinition(sql, definitionTokens, context);
    if (parsed.autoIncrement || parsed.tablePrimaryColumns) unsupported("ALTER TABLE cannot add an AUTO_INCREMENT or PRIMARY KEY in this profile");
    return sqlitePlan(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${parsed.sql}`, false);
  }
  if (tokens[index]?.upper === "DROP" && tokens[index + 1]?.upper === "COLUMN") {
    const column = identifier(tokens[index + 2]);
    if (index + 3 !== tokens.length) unsupported("ALTER TABLE DROP COLUMN accepts one column");
    return sqlitePlan(`ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`, false);
  }
  if (tokens[index]?.upper === "RENAME" && tokens[index + 1]?.upper === "COLUMN" && tokens[index + 3]?.upper === "TO" && index + 5 === tokens.length) {
    return sqlitePlan(`ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(identifier(tokens[index + 2]))} TO ${quoteIdentifier(identifier(tokens[index + 4]))}`, false);
  }
  if (tokens[index]?.upper === "RENAME" && tokens[index + 1]?.upper === "TO" && index + 3 === tokens.length) {
    return sqlitePlan(`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(identifier(tokens[index + 2]))}`, false);
  }
  unsupported("This ALTER TABLE form is outside the selected ORM migration profile");
}

function compileDrop(sql: string, tokens: Token[]): MysqlProfilePlan {
  const family = tokens[1]?.upper;
  if (family === "TABLE") {
    let index = 2;
    if (tokens[index]?.upper === "IF") { requireWords(tokens.slice(index, index + 2), ["IF", "EXISTS"]); index += 2; }
    if (index + 1 !== tokens.length) unsupported("DROP TABLE accepts one table in this profile");
    identifier(tokens[index]);
    return sqlitePlan(sql, false);
  }
  if (family === "INDEX") {
    let index = 2;
    if (tokens[index]?.upper === "IF") { requireWords(tokens.slice(index, index + 2), ["IF", "EXISTS"]); index += 2; }
    identifier(tokens[index]);
    if (tokens[index + 1]?.upper === "ON") {
      identifier(tokens[index + 2]);
      if (index + 3 !== tokens.length) unsupported("DROP INDEX has unsupported options");
      return sqlitePlan(sql.slice(0, tokens[index + 1].start).trimEnd(), false);
    }
    if (index + 1 !== tokens.length) unsupported("DROP INDEX accepts one index name");
    return sqlitePlan(sql, false);
  }
  unsupported("Only DROP TABLE and DROP INDEX are supported");
}

function compileQuery(sql: string, tokens: Token[], context: MysqlProfileContext, returnsRows: boolean): MysqlProfilePlan {
  const root = tokens[0].upper;
  if (root === "INSERT" && tokens[1]?.upper !== "INTO") unsupported("Only INSERT INTO is supported");
  if (root === "UPDATE" && ["OR", "LOW_PRIORITY", "IGNORE"].includes(tokens[1]?.upper)) unsupported("UPDATE modifiers outside the selected profile are unsupported");
  if (root === "DELETE" && tokens[1]?.upper !== "FROM") unsupported("Only DELETE FROM is supported");
  if (tokens.some(token => token.upper === "RETURNING")) unsupported("DML RETURNING is not part of MySQL 8");
  if (tokens.some((token, index) => token.upper === "ON" && tokens[index + 1]?.upper === "CONFLICT")) unsupported("SQLite ON CONFLICT syntax is not part of the selected MySQL profile");
  if (root === "INSERT" && (tokens[1]?.upper === "OR" || tokens[1]?.upper === "REPLACE")) unsupported("SQLite INSERT OR/REPLACE syntax is unsupported");
  if (tokens.some(token => token.raw === "||" || token.raw === "==")) unsupported("SQLite-only operators are unsupported");
  const informationSchema = informationSchemaReferences(tokens);
  rejectUnsupportedFunctions(tokens);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  if (root === "INSERT") edits.push(...rewriteInsertDefaults(tokens));
  let onDuplicateUpdate = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "string" && token.raw.includes("\\")) {
      edits.push({ start: token.start, end: token.end, value: sqlString(decodeMysqlString(token.raw)) });
    }
    if (["DATABASE", "VERSION", "LAST_INSERT_ID"].includes(token.upper) && tokens[index + 1]?.raw === "(" && tokens[index + 2]?.raw === ")") {
      const value = token.upper === "DATABASE" ? (context.database === undefined ? "NULL" : sqlString(context.database))
        : token.upper === "VERSION" ? sqlString(MYSQL_SERVER_VERSION)
          : String(context.lastInsertId);
      edits.push({ start: token.start, end: tokens[index + 2].end, value });
      index += 2;
      continue;
    }
    if (token.raw === "@@") {
      let valueIndex = index + 1;
      if (["GLOBAL", "SESSION"].includes(tokens[valueIndex]?.upper) && tokens[valueIndex + 1]?.raw === ".") valueIndex += 2;
      const variable = tokens[valueIndex]?.raw;
      if (!variable) unsupported("Malformed system variable reference");
      const normalized = variable.toLowerCase();
      const value = context.parameters[normalized] ?? (normalized === "character_set_server" ? "utf8mb4" : undefined);
      if (value === undefined) throw mysqlProfileError(1193, "HY000", `Unknown system variable '${variable}'`);
      edits.push({ start: token.start, end: tokens[valueIndex].end, value: /^-?\d+$/.test(value) ? value : sqlString(value) });
      index = valueIndex;
      continue;
    }
    if (token.upper === "ORDER" && tokens[index + 1]?.upper === "BY" && tokens[index + 2]?.upper === "BINARY") {
      edits.push({ start: tokens[index + 2].start, end: tokens[index + 2].end, value: "" });
      const target = tokens[index + 3];
      if (!target) unsupported("ORDER BY BINARY requires an identifier");
      edits.push({ start: target.end, end: target.end, value: " COLLATE BINARY" });
    }
    if (token.upper === "ON" && tokens[index + 1]?.upper === "DUPLICATE" && tokens[index + 2]?.upper === "KEY" && tokens[index + 3]?.upper === "UPDATE") {
      edits.push({ start: token.start, end: tokens[index + 3].end, value: "ON CONFLICT DO UPDATE SET" });
      onDuplicateUpdate = true;
      index += 3;
    }
    if (onDuplicateUpdate && token.upper === "VALUES" && tokens[index + 1]?.raw === "(" && tokens[index + 3]?.raw === ")") {
      const name = identifier(tokens[index + 2]);
      edits.push({ start: token.start, end: tokens[index + 3].end, value: `excluded.${quoteIdentifier(name)}` });
      index += 3;
    }
    if (token.upper === "COLLATE") {
      if (tokens[index + 1]?.upper !== "UTF8MB4_BIN" && tokens[index + 1]?.upper !== "BINARY") unsupported("Only utf8mb4_bin/BINARY expression collation is supported");
      if (tokens[index + 1]?.upper === "UTF8MB4_BIN") edits.push({ start: tokens[index + 1].start, end: tokens[index + 1].end, value: "BINARY" });
    }
    if (token.upper === "FOR" && tokens[index + 1]?.upper === "UPDATE" && index + 2 === tokens.length) {
      edits.push({ start: token.start, end: tokens[index + 1].end, value: "" });
    }
  }
  return sqlitePlan(applyEdits(sql, 0, sql.length, edits), returnsRows, informationSchema);
}

function rewriteInsertDefaults(tokens: Token[]): Array<{ start: number; end: number; value: string }> {
  const valuesIndex = tokens.findIndex(token => token.upper === "VALUES");
  if (valuesIndex < 0) return [];
  const columnOpen = tokens.findIndex((token, index) => index > 1 && index < valuesIndex && token.raw === "(");
  const columnClose = columnOpen >= 0 ? matchingClose(tokens, columnOpen) : -1;
  const valueOpen = tokens.findIndex((token, index) => index > valuesIndex && token.raw === "(");
  const valueClose = valueOpen >= 0 ? matchingClose(tokens, valueOpen) : -1;
  if (columnOpen < 0 || columnClose < 0 || valueOpen < 0 || valueClose < 0) return [];
  const columns = splitTokenRanges(tokens, columnOpen + 1, columnClose);
  const values = splitTokenRanges(tokens, valueOpen + 1, valueClose);
  if (columns.length !== values.length) unsupported("INSERT column and value counts do not match");
  const edits: Array<{ start: number; end: number; value: string }> = [];
  values.forEach((range, index) => {
    const valueTokens = tokens.slice(range.start, range.end);
    if (!valueTokens.some(token => token.upper === "DEFAULT")) return;
    if (valueTokens.length !== 1 || valueTokens[0].upper !== "DEFAULT" || identifier(tokens[columns[index].start]).toLowerCase() !== "id") {
      unsupported("INSERT DEFAULT is supported only for the selected ORM generated-id column");
    }
    edits.push({ start: valueTokens[0].start, end: valueTokens[0].end, value: "NULL" });
  });
  return edits;
}

function informationSchemaReferences(tokens: Token[]): boolean {
  let found = false;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].upper !== "INFORMATION_SCHEMA" || tokens[index + 1].raw !== ".") continue;
    const table = tokens[index + 2].upper;
    if (!INFORMATION_SCHEMA_TABLES.has(table)) unsupported(`information_schema.${tokens[index + 2].raw} is outside the bounded metadata profile`);
    found = true;
  }
  return found;
}

function rejectUnsupportedFunctions(tokens: Token[]): void {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if ((token.kind !== "word" && token.kind !== "identifier") || tokens[index + 1].raw !== "(") continue;
    if (new Set(["INTO", "ON", "REFERENCES", "TABLE"]).has(tokens[index - 1]?.upper)) continue;
    if (new Set(["AS", "IN", "EXISTS"]).has(token.upper) || new Set(["WITH", "RECURSIVE"]).has(tokens[index - 1]?.upper)) continue;
    if (token.kind === "identifier" || !COMMON_FUNCTIONS.has(token.upper)) unsupported(`Function ${token.raw} is outside the selected MySQL profile`);
  }
}

function rejectSqliteOnly(tokens: Token[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (SQLITE_ONLY_WORDS.has(token.upper)) unsupported(`SQLite-only construct ${token.raw} is not accepted by the MySQL profile`);
    if (token.upper === "ON" && tokens[index + 1]?.upper === "CONFLICT") unsupported("SQLite ON CONFLICT syntax is not accepted by the MySQL profile");
    if (token.upper === "INSERT" && tokens[index + 1]?.upper === "OR") unsupported("SQLite INSERT OR syntax is not accepted by the MySQL profile");
  }
}

function sqlitePlan(sql: string, returnsRows: boolean, informationSchema = false): MysqlProfilePlan {
  return { kind: "sqlite", sql, returnsRows, informationSchema };
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const character = source[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "#" || (character === "-" && source[index + 1] === "-" && /\s/.test(source[index + 2] ?? " "))) {
      const end = source.indexOf("\n", index + 1); index = end < 0 ? source.length : end + 1; continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) unsupported("Unterminated SQL comment");
      index = end + 2; continue;
    }
    if (character === "'" || character === '"') {
      const quote = character; index += 1;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === quote && source[index + 1] === quote) { index += 2; continue; }
        if (source[index] === quote) { index += 1; break; }
        index += 1;
      }
      if (source[index - 1] !== quote) unsupported("Unterminated SQL string");
      const raw = source.slice(start, index); tokens.push({ kind: "string", raw, upper: raw.toUpperCase(), start, end: index }); continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "`" && source[index + 1] === "`") { index += 2; continue; }
        if (source[index] === "`") { index += 1; break; }
        index += 1;
      }
      if (source[index - 1] !== "`") unsupported("Unterminated quoted identifier");
      const raw = source.slice(start, index); tokens.push({ kind: "identifier", raw, upper: unquoteIdentifier(raw).toUpperCase(), start, end: index }); continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      index += 1; while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      const raw = source.slice(start, index); tokens.push({ kind: "word", raw, upper: raw.toUpperCase(), start, end: index }); continue;
    }
    if (/[0-9]/.test(character)) {
      index += 1; while (index < source.length && /[0-9A-Fa-f.xXeE+-]/.test(source[index])) index += 1;
      const raw = source.slice(start, index); tokens.push({ kind: "number", raw, upper: raw.toUpperCase(), start, end: index }); continue;
    }
    if (character === "?") { index += 1; tokens.push({ kind: "parameter", raw: "?", upper: "?", start, end: index }); continue; }
    const pair = source.slice(index, index + 2);
    if (["<=", ">=", "<>", "!=", "||", "&&", "@@", ":=", "=="].includes(pair)) index += 2;
    else if ("(),.;=*+-/%<>!".includes(character)) index += 1;
    else unsupported(`Unsupported SQL token ${character}`);
    const raw = source.slice(start, index);
    if (raw === ";") unsupported("Multiple SQL statements are not accepted");
    tokens.push({ kind: "symbol", raw, upper: raw, start, end: index });
  }
  return tokens;
}

function stripOneTerminator(source: string): string {
  const value = source.trim();
  if (value.includes("\0")) unsupported("SQL cannot contain a null byte");
  return value.endsWith(";") ? value.slice(0, -1).trimEnd() : value;
}

function identifier(token: Token | undefined): string {
  if (!token || (token.kind !== "word" && token.kind !== "identifier")) unsupported("Expected a MySQL identifier");
  const value = token.kind === "identifier" ? unquoteIdentifier(token.raw) : token.raw;
  if (!value || value.length > 64 || value.includes("\0")) unsupported("Identifier is empty or exceeds the 64-character profile bound");
  return value;
}

function unquoteIdentifier(value: string): string { return value.startsWith("`") ? value.slice(1, -1).replace(/``/g, "`") : value; }
function quoteIdentifier(value: string): string { return `\`${value.replace(/`/g, "``")}\``; }
function sqlString(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

function decodeMysqlString(raw: string): string {
  const quote = raw[0]; let result = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (character === quote && raw[index + 1] === quote) { result += quote; index += 1; continue; }
    if (character !== "\\") { result += character; continue; }
    const escaped = raw[++index] ?? "";
    result += ({ "0": "\0", b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a", "\\": "\\", "'": "'", '"': '"' } as Record<string, string>)[escaped] ?? escaped;
  }
  return result;
}

function requireWords(tokens: Token[], words: string[]): void {
  if (tokens.length !== words.length || words.some((word, index) => tokens[index]?.upper !== word)) unsupported(`Expected ${words.join(" ")}`);
}

function requireBalancedParentheses(tokens: Token[]): void {
  let depth = 0;
  for (const token of tokens) { if (token.raw === "(") depth += 1; else if (token.raw === ")") depth -= 1; if (depth < 0) unsupported("Unbalanced parentheses"); }
  if (depth !== 0) unsupported("Unbalanced parentheses");
}

function matchingClose(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].raw === "(") depth += 1;
    else if (tokens[index].raw === ")" && --depth === 0) return index;
  }
  return -1;
}

function splitTokenRanges(tokens: Token[], start: number, end: number): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let rangeStart = start; let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (tokens[index].raw === "(") depth += 1;
    else if (tokens[index].raw === ")") depth -= 1;
    else if (tokens[index].raw === "," && depth === 0) { if (rangeStart === index) unsupported("Empty list element"); result.push({ start: rangeStart, end: index }); rangeStart = index + 1; }
  }
  if (rangeStart < end) result.push({ start: rangeStart, end });
  return result;
}

function typeArgumentsEnd(tokens: Token[], typeIndex: number): number {
  if (tokens[typeIndex + 1]?.raw !== "(") return typeIndex;
  const close = matchingClose(tokens, typeIndex + 1);
  if (close < 0) unsupported("Unbalanced type arguments");
  return close;
}

function applyEdits(source: string, start: number, end: number, edits: Array<{ start: number; end: number; value: string }>): string {
  let result = source.slice(start, end);
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    const relativeStart = edit.start - start; const relativeEnd = edit.end - start;
    result = result.slice(0, relativeStart) + edit.value + result.slice(relativeEnd);
  }
  return result;
}

export function mysqlProfileError(code: number, sqlState: string, message: string): MysqlProfileError {
  return Object.assign(new Error(message), { mysqlCode: code, sqlState });
}

function unsupported(detail: string): never {
  throw mysqlProfileError(1064, "42000", `Unsupported by StackSim ${MYSQL_PROFILE_VERSION}: ${detail}`);
}
