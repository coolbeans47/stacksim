# RDS bounded MySQL 8 development profile

StackSim profile `mysql8-orm-v1` is a fail-closed development subset served over the MySQL protocol and persisted by embedded SQLite. It is designed for the pinned ORM fixtures below and the repository's local examples; it is not full MySQL parity and is not a production database.

## Pinned ORM acceptance corpus

| Fixture | Pinned version | Exercised contract |
|---|---:|---|
| Knex | 3.3.0 | Migration runner and lock table, schema discovery, create/alter/index migrations, generated IDs, CRUD, transaction rollback, reconnect, and simulator restart |
| Sequelize | 6.37.8 | QueryInterface schema migrations, model CRUD, `DESCRIBE`/index introspection, generated IDs, binary values, transaction rollback, reconnect, and simulator restart |

The fixture versions are exact development/test dependencies. A newer ORM release is outside the profile until its emitted SQL is added to the acceptance corpus.

## Statement and semantic matrix

| Surface | Supported in `mysql8-orm-v1` | Explicit boundary |
|---|---|---|
| Session/database | One statement per request; `CREATE DATABASE [IF NOT EXISTS]`, `USE`, `SET NAMES utf8mb4 [COLLATE utf8mb4_bin]`, UTC `time_zone`, `SERIALIZABLE` isolation declaration, enabled `autocommit` and `foreign_key_checks` | Other `SET`, multi-statements, users, grants, administrative and server lifecycle SQL are rejected |
| Transactions | `START TRANSACTION`/`BEGIN`, `COMMIT`, `ROLLBACK`; ORM rollback and migration transactions use one connection | Savepoints, isolation levels other than the declared serializable local behavior, locking options other than the bounded ORM `FOR UPDATE` compatibility form, XA, and distributed concurrency semantics are not supported |
| Table DDL | `CREATE TABLE [IF NOT EXISTS]`, `DROP TABLE [IF EXISTS]`, common column/table primary, unique and foreign keys | Triggers, generated columns, partitions, checks, full-text/spatial features, arbitrary table options, and SQLite `STRICT`/`WITHOUT ROWID` are rejected |
| Column types/defaults | `INT` family, `BIGINT`, `DECIMAL`/`NUMERIC`, float family, `BOOL`/`BOOLEAN`, `CHAR`/`VARCHAR`, text/blob/binary families, `DATE`/`TIME`/`DATETIME`/`TIMESTAMP`, `JSON`; literals, `NULL`, and `CURRENT_TIMESTAMP` defaults | MySQL storage width, unsigned range enforcement, temporal precision/time-zone conversion, JSON validation/operators, enum/set, bit geometry, and implicit coercion parity are not claimed |
| Generated IDs | Integer primary-key `AUTO_INCREMENT`, protocol insert IDs, and connection-local `LAST_INSERT_ID()` | Auto-increment offsets, sequences, non-key or multi-column auto increment are rejected |
| Alter/index | `ALTER TABLE` add/drop/rename column, `MODIFY [COLUMN]` and `CHANGE [COLUMN]` as described below, rename table, add/drop ordinary or unique index; `CREATE [UNIQUE] INDEX`; `DROP INDEX [ON table]` | Constraint alteration, column reordering, multiple alterations per statement, online DDL algorithms/locks, invisible/descending/prefix/full-text/spatial indexes are rejected |
| DML/query | Parameterized and text `INSERT INTO`, `SELECT`, `UPDATE`, `DELETE FROM`; bounded `WITH [RECURSIVE]` queries; joins, predicates, grouping, ordering and limits; `ABS`, `AVG`, `COALESCE`, `COUNT`, `IFNULL`, `LENGTH`, `LOWER`, `MAX`, `MIN`, `NULLIF`, `ROUND`, `SUM`, `UPPER`; repository `ON DUPLICATE KEY UPDATE` and `ORDER BY BINARY` forms | Stored programs, window-query promises, optimizer hints, unlisted functions, SQLite `INSERT OR REPLACE`, `ON CONFLICT`, `RETURNING`, `GLOB`, `==`, `||`, `rowid`, and SQLite functions are rejected |
| Metadata | `SHOW DATABASES`, `SHOW [FULL] TABLES`, `SHOW [FULL] COLUMNS`/`FIELDS`, `SHOW INDEX`/`KEYS`, `DESCRIBE`; read-only bounded `information_schema.SCHEMATA`, `.TABLES`, `.COLUMNS`, and `.STATISTICS` | Other `SHOW`, writable metadata, routines, triggers, events, privileges, engines, process lists, and broader `information_schema` are rejected |
| Identifiers/charset/collation | Backtick identifiers (including escaped backticks), a 64-character profile bound, `utf8mb4`, and SQL `utf8mb4_bin`/`BINARY` behavior | Other SQL collations are rejected because SQLite cannot provide their MySQL equality/order/unique semantics; Unicode normalization and every MySQL identifier case/platform rule are not claimed |
| RDS parameters versus SQL semantics | The profile reads `max_connections`, reports the closed `@@` catalog, and rejects attempts to set server durability or case-insensitive collation semantics through SQL | `innodb_flush_log_at_trx_commit`, `collation_server`, timeout, and packet behavior remain the explicitly open DUG-19 parameter-effect gap; this matrix does not turn their control-plane descriptors into SQL semantic claims |
| Prepared values | MySQL binary-protocol placeholders for null, boolean, number/bigint, date, UTF-8 text, and binary byte sequences | Unsupported parameter objects and values fail before execution |
| Errors/fail-closed edge | Unsupported input is rejected as stable `ER_PARSE_ERROR` number `1064`, SQLSTATE `42000`, with profile name; common duplicate, foreign-key, missing-table/column, and null failures use MySQL-shaped numbers/states | Message text is StackSim-specific and the complete MySQL warning/error catalog is not emulated |

The metadata aliases include the exact ORM-emitted `SHOW FULL COLUMNS` form.

### Changing existing columns

```sql
ALTER TABLE customers MODIFY COLUMN surname VARCHAR(120) NOT NULL;
ALTER TABLE customers CHANGE surname last_name VARCHAR(120) NOT NULL;
```

Each statement supplies the new column definition. Repeat attributes such as `NOT NULL`, `DEFAULT`, and `AUTO_INCREMENT` to retain them. Existing primary keys, unique indexes, foreign keys, and column order are preserved. Use `RENAME COLUMN` for a name-only change.

Empty tables and columns containing only nulls can change to any supported type. For existing non-null values, the profile supports conversions within and between the integer and character/text families. Other types can retain their declared type and arguments while changing their name or attributes. Existing values must fit the target integer range or declared `CHAR`/`VARCHAR` width. Text converted to an integer must contain decimal digits with an optional leading sign. The maximum stored integer is the signed 64-bit SQLite maximum. A failed conversion or constraint check rolls back the entire alteration. Run the alteration in autocommit mode if another table or the table itself has a foreign key referencing it.

The classifier lexes comments, strings, parameters, identifiers, punctuation, and statement structure before opening or preparing a user statement. User SQL never receives direct `PRAGMA`, `ATTACH`, `sqlite_master`, or another SQLite-only catalog escape. StackSim itself reads SQLite's catalog through private provider code to synthesize the bounded MySQL metadata rows.

## Deliberate service boundaries

The standalone instance and Aurora MySQL writer share this SQL profile and compete for one installation-wide database slot. A cluster owns its volume across writer replacement. The Data API exposes a subset of the SQL profile through authenticated prepared statements. Run migrations as individual autocommit statements and use explicit Data API transactions for DML. Manual/final snapshots, snapshot copy and restore belong to standalone instances. [Cluster lifecycle](reference.md#terraform-aurora-clusters) · [Data API operations and limits](rds-data-action-inventory.md)
