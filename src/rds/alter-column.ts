import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { alteredTableBody, mysqlProfileError, quoteIdentifier, type AlterColumnPlan } from "./mysql-profile.js";

const integerBits: Record<string, number> = { TINYINT: 8, SMALLINT: 16, MEDIUMINT: 24, INT: 32, INTEGER: 32, BIGINT: 64 };
const textType = /^(?:CHAR|VARCHAR|(?:TINY|MEDIUM|LONG)?TEXT)$/;

function validateConversion(db: DatabaseSync, table: string, column: string, oldType: string, plan: AlterColumnPlan): void {
  const target = plan.type.split("(")[0];
  const source = oldType.toUpperCase().split("(")[0].trim();
  const bits = integerBits[target];
  const text = textType.test(target);
  if (oldType.toUpperCase().replace(/\s/g, "") !== plan.type &&
      !((integerBits[source] || textType.test(source)) && (bits || text))) {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`).get()) return;
    throw mysqlProfileError(1064, "42000", "mysql8-orm-v1 supports type conversions between integer and character columns");
  }
  if (!bits && !text) return;
  const size = /^(?:VAR)?CHAR\((\d+)\)$/.exec(plan.type);
  const maxLength = size ? Number(size[1]) : target === "CHAR" ? 1 : Infinity;
  const magnitude = bits ? 1n << BigInt(bits - (plan.unsigned ? 0 : 1)) : 0n;
  const min = plan.unsigned ? 0n : -magnitude;
  const max = magnitude - 1n;
  const rows = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
  rows.setReadBigInts(true);
  for (const { value } of rows.iterate()) {
    if (bits) {
      if (typeof value !== "bigint" && !(typeof value === "string" && /^[+-]?\d+$/.test(value))) {
        throw mysqlProfileError(1366, "HY000", `Invalid integer for '${plan.name}'`);
      }
      const n = BigInt(value);
      if (n < min || n > max || n > 9223372036854775807n) throw mysqlProfileError(1264, "22003", `Out of range for '${plan.name}'`);
    } else {
      if (typeof value !== "string" && typeof value !== "bigint") throw mysqlProfileError(1366, "HY000", `Invalid text for '${plan.name}'`);
      if (maxLength !== Infinity && Array.from(String(value)).length > maxLength) throw mysqlProfileError(1406, "22001", `Data too long for '${plan.name}'`);
    }
  }
}

export function alterColumn(db: DatabaseSync, plan: AlterColumnPlan): void {
  // SQLite's documented table rebuild requires foreign keys off before entering the transaction.
  // Inside a caller's transaction SQLite ignores that pragma. Never drop a referenced table
  // with enforcement enabled, since DROP could cascade to its children even inside a savepoint.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("SAVEPOINT stacksim_alter_column");
    try {
      rebuildTable(db, plan);
      db.exec("RELEASE stacksim_alter_column");
    } catch (error) {
      db.exec("ROLLBACK TO stacksim_alter_column");
      db.exec("RELEASE stacksim_alter_column");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildTable(db: DatabaseSync, plan: AlterColumnPlan): void {
  const schema = db.prepare(`SELECT name, sql FROM main.sqlite_schema
    WHERE type = 'table' AND name = ? COLLATE NOCASE AND name NOT GLOB 'sqlite_*'`);
  const original = schema.get(plan.table);
  if (!original) throw mysqlProfileError(1146, "42S02", `Table '${plan.table}' doesn't exist`);
  const name = String(original.name);
  const table = quoteIdentifier(name);
  const column = db.prepare("SELECT cid, name, type, pk FROM pragma_table_info(?, 'main') WHERE name = ? COLLATE NOCASE").get(name, plan.oldName);
  if (!column) throw mysqlProfileError(1054, "42S22", `Unknown column '${plan.oldName}'`);
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys && db.prepare(`
    SELECT 1 FROM main.sqlite_schema s, pragma_foreign_key_list(s.name, 'main') fk
    WHERE s.type = 'table' AND fk.[table] = ? COLLATE NOCASE LIMIT 1`).get(name)) {
    throw mysqlProfileError(1064, "42000", "mysql8-orm-v1 requires autocommit to modify a table referenced by a foreign key");
  }
  const oldColumn = quoteIdentifier(String(column.name));
  validateConversion(db, table, oldColumn, String(column.type), plan);
  if (column.pk && db.prepare(`SELECT 1 FROM ${table} WHERE ${oldColumn} IS NULL LIMIT 1`).get()) {
    throw mysqlProfileError(1048, "23000", `Primary key '${plan.oldName}' cannot be null`);
  }
  // Native rename rewrites index expressions and foreign keys, including those on other tables.
  if (plan.name !== column.name) db.prepare(`ALTER TABLE ${table} RENAME COLUMN ${oldColumn} TO ${quoteIdentifier(plan.name)}`).run();
  const body = alteredTableBody(String(schema.get(name)!.sql), Number(column.cid), plan);
  const objects = db.prepare("SELECT sql FROM main.sqlite_schema WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name);
  const temporaryName = "__stacksim_" + randomUUID();
  const temporary = quoteIdentifier(temporaryName);
  db.prepare(`CREATE TABLE ${temporary} ${body}`).run();
  db.prepare(`INSERT INTO ${temporary} SELECT * FROM ${table}`).run();
  // Carry forward even a deleted historical maximum. Keep sequence arithmetic inside SQLite (64 bit).
  if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'sqlite_sequence'").get()) {
    db.prepare(`UPDATE main.sqlite_sequence AS target SET seq = max(target.seq, source.seq)
      FROM main.sqlite_sequence AS source WHERE source.name = ? AND target.name = ?`).run(name, temporaryName);
  }
  db.prepare(`DROP TABLE ${table}`).run();
  db.prepare(`ALTER TABLE ${temporary} RENAME TO ${table}`).run();
  for (const object of objects) db.prepare(String(object.sql)).run();
  if (db.prepare("PRAGMA main.foreign_key_check").get()) throw mysqlProfileError(1452, "23000", "Column change violates a foreign key");
}
