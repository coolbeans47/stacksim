import type { Connection, FieldPacket, ResultSetHeader } from "mysql2/promise";
import { AwsError } from "../errors.js";
import { dataApiStatement } from "./mysql-profile.js";

export type DataInput = Record<string, unknown>;
type BindValue = string | boolean | number | Buffer | null;
type ResultField = { isNull: true } | { stringValue: string } | { longValue: number } | { doubleValue: number } | { booleanValue: boolean } | { blobValue: string };
const MiB = 1024 * 1024;

export function object(value: unknown): value is DataInput {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function invalid(message: string): never { throw new AwsError("BadRequestException", message); }
function unsupported(message: string): never { throw new AwsError("UnsupportedResultException", message); }
export function sqlError(error?: unknown): AwsError {
  const code = (error as { errno?: number })?.errno;
  return new AwsError("DatabaseErrorException", Number.isInteger(code) ? `The database rejected the SQL statement (MySQL ${code})` : "The database could not execute the SQL statement");
}

function bindValue(parameter: DataInput): BindValue {
  const field = parameter.value;
  if (!object(field) || Object.keys(field).length !== 1) invalid("Each parameter must contain exactly one field value");
  const [key, value] = Object.entries(field)[0];
  if (parameter.typeHint !== undefined) {
    if (typeof parameter.typeHint !== "string" || !["DATE", "TIME", "TIMESTAMP", "DECIMAL", "JSON", "UUID"].includes(parameter.typeHint)) invalid("The parameter type hint is unsupported");
    if (key !== "isNull") {
      if (key !== "stringValue" || typeof value !== "string") invalid("A type hint requires a string parameter");
      const formats: Record<string, RegExp> = {
        DATE: /^\d{4}-\d{2}-\d{2}$/, TIME: /^\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/,
        TIMESTAMP: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/,
        DECIMAL: /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/, UUID: /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i,
      };
      if (formats[parameter.typeHint] && !formats[parameter.typeHint].test(value)) invalid("The parameter does not match its type hint");
      if (parameter.typeHint === "JSON") try { JSON.parse(value); } catch { invalid("The JSON parameter is invalid"); }
    }
  }
  if (key === "isNull" && value === true) return null;
  if (key === "booleanValue" && typeof value === "boolean") return value;
  if (key === "stringValue" && typeof value === "string") return value;
  if (key === "longValue" && typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (key === "doubleValue" && typeof value === "number" && Number.isFinite(value)) return value;
  if (key === "blobValue" && typeof value === "string") {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") === value) return bytes;
  }
  invalid("Unsupported or invalid SQL parameter value");
}

function bindings(names: string[], parameters: unknown): BindValue[] {
  if (!Array.isArray(parameters)) invalid("SQL parameters must be an array");
  const values = new Map<string, BindValue>();
  for (const parameter of parameters) {
    if (!object(parameter) || typeof parameter.name !== "string" || values.has(parameter.name)) invalid("SQL parameters require unique names");
    values.set(parameter.name, bindValue(parameter));
  }
  if (values.size !== new Set(names).size || names.some(name => !values.has(name))) invalid("SQL parameter names must match the statement");
  return names.map(name => values.get(name)!);
}

export function prepareStatement(input: DataInput, batch: boolean) {
  if (typeof input.sql !== "string" || !input.sql.trim() || input.sql.length > 65_536) invalid("SQL must contain between 1 and 65536 characters");
  let statement: ReturnType<typeof dataApiStatement>;
  try { statement = dataApiStatement(input.sql); } catch { throw sqlError(); }
  const { command, names, sql } = statement;
  if (batch && !["INSERT", "UPDATE", "DELETE"].includes(command)) invalid("Batch execution requires one DML statement");
  if (!["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "SHOW", "DESCRIBE", "DESC"].includes(command)) invalid("The statement is outside the Data API SQL profile");
  if (input.transactionId !== undefined && ["CREATE", "ALTER", "DROP"].includes(command)) invalid("Run DDL outside a Data API transaction");
  const options = input.resultSetOptions === undefined ? {} : input.resultSetOptions;
  if (!object(options) || (options.longReturnType !== undefined && !["LONG", "STRING"].includes(String(options.longReturnType))) ||
      (options.decimalReturnType !== undefined && !["STRING", "DOUBLE_OR_LONG"].includes(String(options.decimalReturnType)))) invalid("The result set options are invalid");
  if (input.formatRecordsAs !== undefined && !["JSON", "NONE"].includes(String(input.formatRecordsAs))) invalid("formatRecordsAs must be NONE or JSON");
  if (input.includeResultMetadata !== undefined && typeof input.includeResultMetadata !== "boolean") invalid("includeResultMetadata must be boolean");
  if (input.continueAfterTimeout !== undefined && typeof input.continueAfterTimeout !== "boolean") invalid("continueAfterTimeout must be boolean");
  const groups = batch ? input.parameterSets : [input.parameters ?? []];
  if (!Array.isArray(groups) || !groups.length) invalid("Batch execution requires at least one parameter set");
  return { sql, values: groups.map(group => bindings(names, group)), options, json: input.formatRecordsAs === "JSON", metadata: input.includeResultMetadata === true };
}

type Prepared = ReturnType<typeof prepareStatement>;
const columnTypes: Record<number, [number, string]> = {
  1: [16, "BOOLEAN"], 2: [5, "SMALLINT"], 3: [4, "INTEGER"], 4: [7, "FLOAT"], 5: [8, "DOUBLE"],
  8: [-5, "BIGINT"], 9: [4, "MEDIUMINT"], 246: [3, "DECIMAL"], 252: [-4, "BLOB"], 253: [12, "VARCHAR"], 254: [1, "CHAR"],
};
function resultField(value: unknown, field: FieldPacket, options: DataInput): ResultField {
  if (value === null) return { isNull: true };
  if (Buffer.isBuffer(value)) return { blobValue: value.toString("base64") };
  const type = field.columnType ?? field.type;
  if (type === 1) return { booleanValue: Boolean(Number(value)) };
  if (type === 246 && options.decimalReturnType !== "DOUBLE_OR_LONG") return { stringValue: String(value) };
  if ([1, 2, 3, 8, 9].includes(type ?? -1)) {
    if (options.longReturnType === "STRING") return { stringValue: String(value) };
    if (!Number.isSafeInteger(Number(value))) unsupported("The integer result requires longReturnType STRING");
    return { longValue: Number(value) };
  }
  if (type === 4 || type === 5 || type === 246) {
    const number = Number(value);
    if (!Number.isFinite(number)) unsupported("The numeric result is outside the supported range");
    return type === 246 && Number.isSafeInteger(number) ? { longValue: number } : { doubleValue: number };
  }
  if (typeof value === "string") return { stringValue: value };
  unsupported("The SQL result contains an unsupported data type");
}

function formatRows(rows: unknown[][], fields: FieldPacket[], prepared: Prepared) {
  let totalBytes = 0;
  const records = rows.map(row => {
    let bytes = 0;
    for (const value of row) bytes += Buffer.isBuffer(value) ? value.length : typeof value === "string" ? Buffer.byteLength(value) : 8;
    if (bytes > 64 * 1024) unsupported("A database row exceeds the 64 KiB Data API limit");
    totalBytes += bytes;
    if (!prepared.json && totalBytes > MiB) unsupported("The query result exceeds 1 MiB");
    return row.map((value, index) => resultField(value, fields[index], prepared.options));
  });
  if (prepared.json) {
    if (new Set(fields.map(field => field.name)).size !== fields.length) invalid("JSON results require distinct column labels");
    const formattedRecords = JSON.stringify(records.map(row => Object.fromEntries(row.map((value, index) =>
      [fields[index].name, "isNull" in value ? null : Object.values(value)[0]]))));
    if (Buffer.byteLength(formattedRecords) > 10 * MiB) unsupported("The JSON query result exceeds 10 MiB");
    return { formattedRecords };
  }
  const columnMetadata = prepared.metadata ? fields.map(field => {
    const [type, typeName] = columnTypes[field.columnType ?? field.type ?? 253] ?? [12, "VARCHAR"];
    return { name: field.orgName || field.name, label: field.name, tableName: field.orgTable || field.table || "", type, typeName };
  }) : undefined;
  return { records, columnMetadata, numberOfRecordsUpdated: 0 };
}

export async function runStatement(connection: Connection, prepared: Prepared, batch: boolean) {
  const updateResults: Array<{ generatedFields: ResultField[] }> = [];
  for (const values of prepared.values) {
    let result, fields;
    try { [result, fields] = await connection.execute({ sql: prepared.sql, rowsAsArray: true }, values); }
    catch (error) { throw sqlError(error); }
    if (Array.isArray(result)) return formatRows(result as unknown as unknown[][], fields, prepared);
    const { insertId, affectedRows } = result as ResultSetHeader;
    const generatedFields: ResultField[] = insertId ? [{ longValue: insertId }] : [];
    if (!batch) return { numberOfRecordsUpdated: affectedRows, generatedFields };
    updateResults.push({ generatedFields });
  }
  if (Buffer.byteLength(JSON.stringify(updateResults)) > MiB) unsupported("The batch response exceeds 1 MiB");
  return { updateResults };
}
