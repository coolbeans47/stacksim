# StackSim RDS console guide

This guide explains every panel in the StackSim RDS console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon RDS behavior.

StackSim models one installation-wide, loopback-only DB instance backed by durable embedded SQLite and exposed through the fail-closed [`mysql8-orm-v1`](rds-mysql8-development-profile.md) subset, plus parameter groups, tags, a SQL query editor, and immutable manual/final snapshots. The pinned Knex 3.3.0 and Sequelize 6.37.8 fixtures are supported; other ORM/version combinations are outside the tested contract. PITR, automated backups, Aurora/clusters, replicas, Multi-AZ, public networking, and other engines remain unavailable or reference-only.

---

## How to read this guide

Each section follows the same pattern:

1. **What it is** — the console panel and its main fields.
2. **Why use it** — the problem it solves in AWS.
3. **How it works in StackSim** — what is fully simulated versus reference-only.
4. **Common AWS use cases** — typical production scenarios.
5. **Example** — a concrete configuration when one helps.

---

## Console navigation

| Nav item | Route | Purpose |
|----------|-------|---------|
| **Databases** | `#/rds/databases` | List and manage DB instances |
| **Snapshots** | `#/rds/snapshots` | Create, copy, restore, and delete manual snapshots |
| **Query editor** | `#/rds/query-editor` | Run SQL against a local database |
| **Parameter groups** | `#/rds/parameter-groups` | Custom engine parameter sets |

Database detail: `#/rds/databases/{identifier}/connectivity`, `/configuration`, `/tags`. Query editor with instance: `#/rds/query-editor/{identifier}`.

The console uses the RDS Query/XML API (`@aws-sdk/client-rds`).

---

## Databases

### DB instance catalog

#### What it is

Table of DB identifiers with status, engine, class, endpoint, port, and **Open editor** link. **Create database**, **Refresh**, and **Query editor** in the header. Installation quota banner (one instance per installation). Filter box searches identifiers and engines.

#### Why use it

Central inventory for relational data used by applications, Lambda, or stream projections.

#### How it works in StackSim

One installation-wide MySQL-compatible instance; switching Regions may show the slot occupied elsewhere. Official RDS lifecycle calls, private master credentials, tags, safe parameter groups, and supported CloudFormation resources are active.

#### Example

Create `app-db`, open **Query editor**, run `CREATE TABLE orders (id INT PRIMARY KEY);`.

---

### Create database (modal)

| Field | Purpose |
|-------|---------|
| **DB instance identifier** | Stable name |
| **Master username / password** | SQL authentication |
| **Initial database name** | Optional default schema |
| **DB instance class** | Compatibility descriptor (`db.t3.micro`) |
| **Allocated storage** | GiB descriptor |
| **Tags (JSON object)** | Key-value labels |

---

### Database detail

Header actions: **Refresh**, **Query editor**, **Take snapshot**, **Edit**, **Start** / **Stop**, **Reboot**, **Delete**.

Tabs: **Connectivity**, **Configuration**, **Tags**.

#### Connectivity tab

Endpoint, port, loopback-only network note, MySQL client command, Node.js `mysql2` example (copy buttons). Empty state when stopped or not ready.

#### Configuration tab

Engine, class, AZ, initial database, master username, storage descriptors, deletion protection, parameter group link, ARN, resource ID, created date. **Pending modifications** card when changes await reboot.

#### Edit DB instance (modal)

Class, storage, port, optional password rotation, parameter group, deletion protection, apply immediately.

#### Tags tab

Key-value table; **Manage tags** JSON editor.

#### Delete DB instance

The deletion dialog defaults to **Create final snapshot** and requires a final snapshot identifier. The instance is not placed into deleting state until the final snapshot is fully published and validated. **Skip final snapshot** is an explicit destructive choice. CloudFormation standalone DB instances likewise use real Snapshot deletion by default.

#### Local boundaries

Class and storage are compatibility descriptors, not reserved compute. Password values never render after submission. PITR, automated backups, IAM DB auth, and production scaling are unavailable.

---

## Snapshots

Route: `#/rds/snapshots`.

The catalog lists manual and final snapshots with source identity, state, creation time, validated byte/file counts, and the manifest checksum prefix. **Create snapshot** accepts an available or stopped source and optional tags. **Copy** publishes a separate installation-local immutable snapshot. **Delete** removes only the exact ownership-proven snapshot directory.

Snapshot creation briefly drains an active listener. Every logical SQLite database is captured with the provider's consistent backup operation into a new staging directory. Database files and the credential-free ownership manifest are fsynced, SHA-256 checked, and published by directory rename before status becomes `available`. Restart removes incomplete owned staging/deletion work, recovers a completely published transition, and marks corrupt manifests or files `failed` rather than advertising them as usable.

**Restore** is enabled only while the installation-wide DB slot is free. The wizard requires a new DB identifier, loopback port, master username, and password; snapshot data never contains the source credential. A restored instance receives a new resource identity and preserves the snapshotted database files. PITR, scheduled/automated backups, cross-installation sharing, AWS backup storage, and production durability are not simulated.

---

## Query editor

Route: `#/rds/query-editor` or `#/rds/query-editor/{identifier}`.

### Database objects

Tree of databases, tables, views, and columns with filter and **Preview** (generates bounded `SELECT`).

### SQL query

Editor sends selected text (or full buffer) to the chosen database. It supports the published statement matrix and rejects unlisted or SQLite-only constructs before execution — it is not a full MySQL administration surface.

#### Why use it

Inspect schema and test application queries without external SQL clients.

#### How it works in StackSim

The query editor and external clients share the `mysql8-orm-v1` classifier and MySQL-shaped error surface; master password is not exposed to the browser. Object discovery uses supported `SHOW FULL TABLES` and `SHOW FULL COLUMNS`, not a browser-visible SQLite catalog escape.

---

## Parameter groups

### Catalog

Custom and default groups with engine family. **Create parameter group** modal (name, family `mysql8.0`, description, tags).

### Group detail

**Parameters** table — six-parameter safe allowlist with apply method (immediate vs pending-reboot), **Edit**, **Reset**. **Tags** on custom groups only.

#### Example parameter

`max_connections` — adjust local connection limit within validated bounds.

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Engines | `mysql` compatibility descriptor with `mysql8-orm-v1` data plane only |
| SQL/ORM profile | [`mysql8-orm-v1`](rds-mysql8-development-profile.md); Knex 3.3.0 and Sequelize 6.37.8 fixtures |
| Instances per install | One |
| Network | Loopback only |
| Manual/final snapshots | Immutable checksummed local publication, copy, attributes/tags, delete, and free-slot restore with a new credential |
| PITR / automated backups | Unavailable; `BackupRetentionPeriod` remains 0 |
| Multi-AZ / replicas | Unavailable; Multi-AZ must be false |
| Parameter allowlist | Six safe parameters |
| CloudFormation | Supported RDS resources |

---

## Related StackSim docs

- [Lambda console guide](./lambda-console-guide.md) — stream projections into SQL
- [DynamoDB console guide](./dynamodb-console-guide.md) — source tables for projections
- [CloudFormation console guide](./cloudformation-console-guide.md) — RDS stack resources
- [IAM console guide](./iam-console-guide.md) — RDS API authorization
- [SQS console guide](./sqs-console-guide.md) — async workers alongside SQL
- [EventBridge console guide](./eventbridge-console-guide.md) — scheduled jobs reading SQL data
- [Developer guide](./developer-guide.md) — relational data patterns
- [Reference](./reference.md) — RDS API summary
