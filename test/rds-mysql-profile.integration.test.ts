import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateDBInstanceCommand, DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import knexFactory from "knex";
import mysql from "mysql2/promise";
import { DataTypes, Sequelize } from "sequelize";
import { StackSim } from "../src/server.js";
import { MYSQL_PROFILE_VERSION } from "../src/rds/mysql-profile.js";

const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const ORM_FIXTURES = { knex: "3.3.0", sequelize: "6.37.8" } as const;

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address(); const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function available(client: RDSClient, identifier: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === "available") return instance;
    if (instance?.DBInstanceStatus === "failed") assert.fail(instance.StatusInfos?.[0]?.Message ?? "RDS provider failed");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("RDS instance did not become available");
}

function knexConfig(port: number, password: string) {
  return {
    client: "mysql2",
    connection: { host: "127.0.0.1", port, user: "developer", password, database: "orm_profile" },
    pool: { min: 0, max: 2 },
  } as const;
}

function migrationSource(migrations: Array<{ name: string; up(database: any): Promise<void>; down(database: any): Promise<void> }>) {
  return {
    getMigrations: async () => migrations,
    getMigrationName: (migration: (typeof migrations)[number]) => migration.name,
    getMigration: async (migration: (typeof migrations)[number]) => migration,
  };
}

const knexFirst = {
  name: "202608090001_create_knex_accounts.js",
  async up(database: any) {
    await database.schema.createTable("knex_accounts", (table: any) => {
      table.increments("id").primary();
      table.string("name", 120).notNullable().unique();
      table.binary("payload").nullable();
      table.boolean("active").notNullable().defaultTo(true);
    });
  },
  async down(database: any) { await database.schema.dropTableIfExists("knex_accounts"); },
};

const knexSecond = {
  name: "202608090002_add_knex_nickname.js",
  async up(database: any) {
    await database.schema.alterTable("knex_accounts", (table: any) => {
      table.string("nickname", 80).nullable();
      table.index(["nickname"], "idx_knex_accounts_nickname");
    });
  },
  async down(database: any) {
    await database.schema.alterTable("knex_accounts", (table: any) => table.dropColumn("nickname"));
  },
};

test("DUG-10 bounded MySQL profile runs pinned Knex and Sequelize migrations and CRUD across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-dug10-"));
  const sqlPort = await freePort(); const password = "MysqlProfileSecret123"; const identifier = "orm-profile";
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, rdsStartupTimeoutMs: 45_000, authMode: "off" });
  let rds: RDSClient | undefined; let knex: ReturnType<typeof knexFactory> | undefined; let sequelize: Sequelize | undefined;
  try {
    await simulator.start();
    rds = new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: identifier, DBInstanceClass: "db.t3.micro", Engine: "mysql", EngineVersion: "8.0",
      AllocatedStorage: 20, StorageType: "gp3", DBName: "orm_profile", MasterUsername: "developer",
      MasterUserPassword: password, Port: sqlPort, BackupRetentionPeriod: 0, PubliclyAccessible: false,
    }));
    await available(rds, identifier);

    // Knex 3.3.0: real migration runner, discovery, generated IDs, CRUD, rollback, and a second migration.
    knex = knexFactory(knexConfig(sqlPort, password));
    const firstBatch = await knex.migrate.latest({ migrationSource: migrationSource([knexFirst]), tableName: "knex_profile_migrations" });
    assert.deepEqual(firstBatch[1], [knexFirst.name]);
    assert.equal(await knex.schema.hasTable("knex_accounts"), true);
    assert.equal(await knex.schema.hasColumn("knex_accounts", "payload"), true);
    const knexColumns = await knex("knex_accounts").columnInfo();
    assert.equal(knexColumns.id.type, "int");
    const knexIds = await knex("knex_accounts").insert({ name: "alpha's text", payload: Buffer.from([0, 1, 2, 255]), active: true });
    assert.equal(Number(knexIds[0]), 1);
    assert.deepEqual(await knex("knex_accounts").select("id", "name", "payload", "active"), [
      { id: 1, name: "alpha's text", payload: Buffer.from([0, 1, 2, 255]), active: 1 },
    ]);
    await knex("knex_accounts").where({ id: 1 }).update({ name: "alpha updated" });
    await assert.rejects(knex.transaction(async transaction => {
      await transaction("knex_accounts").insert({ name: "rolled back", payload: Buffer.from("no"), active: false });
      throw new Error("fixture rollback");
    }), /fixture rollback/);
    assert.equal(await knex("knex_accounts").where({ name: "rolled back" }).first(), undefined);
    await knex("knex_accounts").insert({ name: "delete me", payload: Buffer.from("bye"), active: false });
    assert.equal(await knex("knex_accounts").where({ name: "delete me" }).delete(), 1);
    const secondBatch = await knex.migrate.latest({ migrationSource: migrationSource([knexFirst, knexSecond]), tableName: "knex_profile_migrations" });
    assert.deepEqual(secondBatch[1], [knexSecond.name]);
    assert.equal(await knex.schema.hasColumn("knex_accounts", "nickname"), true);
    await knex("knex_accounts").where({ id: 1 }).update({ nickname: "A" });
    await knex.destroy(); knex = undefined;
    knex = knexFactory(knexConfig(sqlPort, password));
    assert.equal((await knex("knex_accounts").where({ id: 1 }).first()).nickname, "A");

    // Sequelize 6.37.8: schema migration functions, model CRUD, metadata, rollback, and second migration.
    sequelize = new Sequelize("orm_profile", "developer", password, {
      dialect: "mysql", host: "127.0.0.1", port: sqlPort, logging: false, pool: { min: 0, max: 2 }, timezone: "+00:00",
    });
    await sequelize.authenticate();
    const queryInterface = sequelize.getQueryInterface();
    await sequelize.transaction(async transaction => {
      await queryInterface.createTable("sequelize_widgets", {
        id: { type: DataTypes.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
        title: { type: DataTypes.STRING(120), allowNull: false, unique: true },
        payload: { type: DataTypes.BLOB, allowNull: true },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      }, { transaction });
      await queryInterface.createTable("sequelize_profile_migrations", {
        name: { type: DataTypes.STRING(180), allowNull: false, primaryKey: true },
      }, { transaction });
      await queryInterface.bulkInsert("sequelize_profile_migrations", [{ name: "001-create-widgets" }], { transaction });
    });
    const described = await queryInterface.describeTable("sequelize_widgets");
    assert.equal(described.id.autoIncrement, true);
    const Widget = sequelize.define("ProfileWidget", {
      id: { type: DataTypes.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      title: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      payload: { type: DataTypes.BLOB, allowNull: true },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, { tableName: "sequelize_widgets", timestamps: false });
    const widget = await Widget.create({ title: "schema-first", payload: Buffer.from([9, 8, 7]), enabled: true });
    assert.equal(Number(widget.get("id")), 1);
    assert.deepEqual(Buffer.from(widget.get("payload") as Uint8Array), Buffer.from([9, 8, 7]));
    await widget.update({ title: "schema-first-updated" });
    await assert.rejects(sequelize.transaction(async transaction => {
      await Widget.create({ title: "sequelize rollback", payload: Buffer.from("no") }, { transaction });
      throw new Error("sequelize fixture rollback");
    }), /sequelize fixture rollback/);
    assert.equal(await Widget.count({ where: { title: "sequelize rollback" } }), 0);
    const doomed = await Widget.create({ title: "sequelize delete", payload: Buffer.from("bye") });
    await doomed.destroy();
    await sequelize.transaction(async transaction => {
      await queryInterface.addColumn("sequelize_widgets", "category", { type: DataTypes.STRING(40), allowNull: true }, { transaction });
      await queryInterface.addIndex("sequelize_widgets", ["category"], { name: "idx_sequelize_widgets_category", transaction });
      await queryInterface.bulkInsert("sequelize_profile_migrations", [{ name: "002-add-category" }], { transaction });
    });
    assert.ok((await queryInterface.showIndex("sequelize_widgets") as Array<{ name: string }>).some(index => index.name === "idx_sequelize_widgets_category"));
    await sequelize.close(); sequelize = undefined;
    sequelize = new Sequelize("orm_profile", "developer", password, { dialect: "mysql", host: "127.0.0.1", port: sqlPort, logging: false });
    assert.equal((await sequelize.query("SELECT title FROM sequelize_widgets WHERE id = 1", { type: "SELECT" }) as any)[0].title, "schema-first-updated");

    // Binary protocol values and connection-local generated-ID semantics.
    const prepared = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password, database: "orm_profile" });
    await prepared.execute("CREATE TABLE prepared_values (id INT AUTO_INCREMENT PRIMARY KEY, body VARCHAR(255) NOT NULL, bytes VARBINARY(255) NOT NULL)");
    const [preparedInsert] = await prepared.execute("INSERT INTO prepared_values (body, bytes) VALUES (?, ?)", ["prepared ' text", Buffer.from([0, 250, 255])]);
    assert.equal((preparedInsert as mysql.ResultSetHeader).insertId, 1);
    assert.deepEqual((await prepared.execute("SELECT LAST_INSERT_ID() AS generatedId, body, bytes FROM prepared_values WHERE id = ?", [1]))[0], [
      { generatedId: 1, body: "prepared ' text", bytes: Buffer.from([0, 250, 255]) },
    ]);
    await prepared.end();

    await knex.destroy(); knex = undefined; await sequelize.close(); sequelize = undefined; rds.destroy(); rds = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, rdsStartupTimeoutMs: 45_000, authMode: "off" });
    await simulator.start();
    rds = new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    await available(rds, identifier);
    knex = knexFactory(knexConfig(sqlPort, password));
    assert.deepEqual(await knex("knex_accounts").select("name", "nickname"), [{ name: "alpha updated", nickname: "A" }]);
    await knex.destroy(); knex = undefined;
    sequelize = new Sequelize("orm_profile", "developer", password, { dialect: "mysql", host: "127.0.0.1", port: sqlPort, logging: false });
    assert.equal((await sequelize.query("SELECT COUNT(*) AS count FROM sequelize_profile_migrations", { type: "SELECT" }) as any)[0].count, 2);
    await sequelize.close(); sequelize = undefined;

    // Differential corpus: rejection occurs before mutation and carries stable MySQL number/state.
    const differential = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password, database: "orm_profile" });
    await differential.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await differential.query("SET time_zone = '+00:00'");
    await differential.query("CREATE TABLE `odd``table` (`odd``id` INT PRIMARY KEY, value VARCHAR(20) DEFAULT 'ready' COLLATE utf8mb4_bin)");
    await differential.query("CREATE INDEX `idx_odd_value` ON `odd``table` (value)");
    await differential.query("DROP INDEX `idx_odd_value` ON `odd``table`");
    await differential.query("ALTER TABLE `odd``table` ADD COLUMN note TEXT NULL");
    await differential.query("ALTER TABLE `odd``table` DROP COLUMN note");
    await differential.query("DROP TABLE `odd``table`");
    await differential.execute("CREATE TABLE differential_guard (id INT PRIMARY KEY, value VARCHAR(40) NOT NULL)");
    await differential.execute("INSERT INTO differential_guard (id, value) VALUES (?, ?)", [1, "unchanged"]);
    const rejected = [
      "INSERT OR REPLACE INTO differential_guard (id, value) VALUES (1, 'sqlite replace')",
      "INSERT INTO differential_guard (id, value) VALUES (1, 'sqlite upsert') ON CONFLICT(id) DO UPDATE SET value = 'changed'",
      "INSERT INTO differential_guard (id, value) VALUES (2, 'partial'); DELETE FROM differential_guard WHERE id = 1",
      "UPDATE differential_guard SET value = 'sqlite returning' WHERE id = 1 RETURNING value",
      "SELECT * FROM differential_guard WHERE value GLOB '*'",
      "SELECT sqlite_version()",
      "PRAGMA foreign_keys = OFF",
      "CREATE TABLE sqlite_untyped (value)",
      "CREATE TABLE sqlite_strict (id INT) STRICT",
      "CREATE TABLE sqlite_collation (value TEXT COLLATE NOCASE)",
    ];
    for (const sql of rejected) {
      await assert.rejects(differential.query(sql), (error: any) => error?.errno === 1064 && error?.sqlState === "42000" && /mysql8-orm-v1/.test(error?.sqlMessage));
    }
    assert.deepEqual((await differential.query("SELECT id, value FROM differential_guard"))[0], [{ id: 1, value: "unchanged" }]);
    await assert.rejects(differential.query("INSERT INTO differential_guard (id, value) VALUES (1, 'duplicate')"), (error: any) => error?.errno === 1062 && error?.sqlState === "23000");
    await assert.rejects(differential.query("SELECT * FROM missing_profile_table"), (error: any) => error?.errno === 1146 && error?.sqlState === "42S02");
    const [tables] = await differential.query("SHOW TABLES");
    const names = (tables as Array<Record<string, string>>).map(row => Object.values(row)[0]);
    assert.equal(names.includes("sqlite_untyped"), false);
    assert.equal(names.includes("sqlite_strict"), false);
    assert.equal(names.includes("sqlite_collation"), false);
    await differential.end();

    const matrix = await readFile(join(process.cwd(), "docs", "rds-mysql8-development-profile.md"), "utf8");
    assert.match(matrix, new RegExp(MYSQL_PROFILE_VERSION));
    assert.match(matrix, new RegExp(`Knex\\s+\\|\\s+${ORM_FIXTURES.knex.replaceAll(".", "\\.")}`));
    assert.match(matrix, new RegExp(`Sequelize\\s+\\|\\s+${ORM_FIXTURES.sequelize.replaceAll(".", "\\.")}`));
    for (const namedSurface of ["AUTO_INCREMENT", "LAST_INSERT_ID", "information_schema", "SHOW FULL COLUMNS", "ER_PARSE_ERROR", "SQLite-only"]) {
      assert.match(matrix, new RegExp(namedSurface.replace(/[()]/g, "\\$&"), "i"));
    }
  } finally {
    await knex?.destroy().catch(() => undefined); await sequelize?.close().catch(() => undefined); rds?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
