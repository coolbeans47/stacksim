# StackSim DynamoDB console guide

This guide explains every panel in the StackSim DynamoDB console: what each setting does, why you would use it in real AWS workloads, and how it maps to production Amazon DynamoDB behavior.

StackSim models DynamoDB tables, items, indexes, streams, backups, and replication locally. Where local behavior differs from AWS (for example KMS, Application Auto Scaling, Kinesis delivery, or billing), those boundaries are called out explicitly.

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

The DynamoDB service in StackSim has a left navigation bar with these top-level areas:

| Area | Purpose |
|------|---------|
| **Overview** | Account summary and quick links |
| **Tables** | Create, list, and open tables |
| **Global tables** | Multi-Region replica overview |
| **Exports and streams** | Account-level export jobs and stream guidance |
| **Imports** | Create tables from local DynamoDB JSON files |
| **Contributor insights** | Hot-key and throttle monitoring |
| **Transaction builder** | Compose and run `TransactWriteItems` |
| **PartiQL editor** | SQL-compatible reads and writes |
| **Backups** | Account-level on-demand backup list |

Opening a table shows tabs: **Overview**, **Explore table items**, **Indexes**, **Monitor**, **Capacity**, **Additional settings**, **Backups**, **Exports and streams**, **Global tables**, **Contributor insights**, **Permissions**, and **Tags**.

---

## Overview

### What it is

The **Overview** page shows how many tables exist in the current Region and links to create a table or view the table list.

### Why use it

In AWS, the DynamoDB landing page orients you toward active tables and common getting-started tasks before you dive into table design or capacity planning.

### How it works in StackSim

Table counts reflect the local installation. Capacity is not billed locally.

### Common AWS use cases

- Confirm tables exist after a CDK or Terraform deploy.
- Navigate to **Create table** when starting a new application data model.

---

## Tables

### Tables (list)

#### What it is

The **Tables** panel lists every table with name, status, partition key, sort key, and approximate item count. You can filter the list, open a table, or create a new one.

#### Why use it

Every DynamoDB workload starts with at least one table. The list view is where operators find tables by name and verify that infrastructure automation created the expected resources.

#### How it works in StackSim

Table creation, listing, updates, deletion, key validation, and regional names are active and persist locally.

#### Common AWS use cases

- `Users` — partition key `userId`.
- `Orders` — composite key `customerId` + `orderId`.
- Environment-specific tables (`app-dev`, `app-prod`) or single tables with tenant-scoped keys.

---

### Create table

#### What it is

The **Create table** wizard collects:

- **Table name**
- **Partition key** (required) and optional **sort key** — String, Number, or Binary
- **Table settings** — on-demand or provisioned capacity
- Optional **secondary indexes** (GSI or LSI at creation time)

#### Why use it

The primary key design is the most important DynamoDB decision. It determines how data is partitioned, how queries perform, and which access patterns are efficient. Keys cannot be changed after creation without migrating data to a new table.

In AWS, you also choose billing mode up front (on-demand vs provisioned), though it can be changed later.

#### How it works in StackSim

String, number, and binary key types, composite keys, validation, and schemaless non-key attributes are active. Local secondary indexes can only be created with the table, matching AWS.

#### Common AWS use cases

- Single-table design with `PK` + `SK` generic keys for multiple entity types.
- Time-series data with partition key `deviceId` and sort key `timestamp`.
- High-cardinality partition keys to avoid hot partitions.

#### Example

Table `Music` with:

- Partition key: `ArtistId` (String)
- Sort key: `SongTitle` (String)
- Billing mode: On-demand

Items can add any attributes (`Album`, `Year`, `Genre`) without altering the table schema.

---

## Table tabs

### Overview (table)

#### What it is

Read-only summary: table status, ARN, partition and sort keys, item count, table size, and capacity mode.

#### Why use it

Quick health check after deploys — confirm the table is `ACTIVE`, keys match your design, and item count is reasonable.

---

### Explore table items

#### Scan or query items

##### What it is

Interactive item explorer supporting:

- **Scan** — read across the table or index (with optional parallel segments)
- **Query** — efficient read of one partition key value with optional sort-key conditions
- **Filters** — refine results after read (do not reduce consumed capacity in AWS)
- **Projections** — choose returned attributes
- **Consistent read** — strongly consistent reads where supported
- **Create item**, **Edit**, **Duplicate**, **Delete**

##### Why use it

**Query** is the primary access pattern in DynamoDB — it reads one partition efficiently. **Scan** reads every partition and should be used sparingly in production (migrations, admin tools, small tables).

Filters apply after data is read, so they still consume capacity for scanned items even when filtered out.

##### How it works in StackSim

Bounded scan and query pages, key conditions, filters, projections, consistent reads, parallel scans, pagination, and item CRUD are active.

##### Common AWS use cases

- Query `PK = USER#123` and `SK begins_with ORDER#` in a single-table design.
- Scan a dev table to inspect seed data.
- Create test items from the console before wiring an application.

##### Example

Query the `Orders` table:

- Partition key condition: `customerId = "C-1001"`
- Sort key condition: `orderDate BETWEEN "2026-01-01" AND "2026-12-31"`

Returns all orders for that customer in 2026 without scanning other customers' partitions.

---

### Indexes

#### Secondary indexes

##### What it is

Lists **local secondary indexes (LSI)** and **global secondary indexes (GSI)** with key schema, projection type, and status. You can create GSIs and delete GSIs from this panel.

##### Why use it

The table primary key supports one access pattern. Secondary indexes add alternate keys so applications can query by other attributes — for example lookup by `email` when the primary key is `userId`.

| Type | Partition key | When created | Use case |
|------|---------------|--------------|----------|
| **GSI** | Any attribute | Anytime | Most alternate access patterns |
| **LSI** | Same as table | Only at table creation | Alternate sort key on same partition |

**Projection** controls copied attributes: `ALL`, `KEYS_ONLY`, or `INCLUDE` specific attributes.

##### How it works in StackSim

Index creation, projection, queries, and GSI deletion are active. LSIs can only be created with the table.

##### Common AWS use cases

- GSI on `status` + `createdAt` for admin dashboards listing open orders.
- GSI on `GSI1PK` / `GSI1SK` in single-table design patterns.
- LSI when you need strongly consistent reads on an alternate sort key within a partition (rare).

##### Example

Table primary key: `userId` (hash)

GSI `EmailIndex`:

- Partition key: `email`
- Projection: `KEYS_ONLY`

Application looks up users by email without scanning the full table.

---

### Monitor

#### Table metrics

##### What it is

Charts and controls for DynamoDB CloudWatch metrics: consumed capacity, throttled requests, errors, latency, and related series. Scope can be the table or a specific GSI.

##### Why use it

In AWS, metrics reveal hot partitions, throttling, error spikes, and capacity headroom. Alarms on `UserErrors`, `SystemErrors`, and `ThrottledRequests` drive operational response.

##### How it works in StackSim

Metrics publish to local CloudWatch after DynamoDB requests. Charts describe local activity only.

##### Common AWS use cases

- Alarm when `ConsumedWriteCapacityUnits` exceeds provisioned capacity.
- Compare table vs GSI read patterns before adding capacity.
- Diagnose sudden `ThrottledRequests` after a traffic spike.

---

### Capacity

#### Read/write capacity

##### What it is

Configures billing mode and throughput:

- **On-demand (PAY_PER_REQUEST)** — pay per request; optional maximum request units
- **Provisioned** — explicit read and write capacity units (RCU/WCU)
- **Warm throughput** — optional warm-throughput descriptors

##### Why use it

**On-demand** suits unpredictable or spiky workloads without capacity planning. **Provisioned** suits steady traffic where reserved capacity reduces cost. In AWS, auto scaling adjusts provisioned capacity based on utilization.

Throttling occurs when requests exceed available capacity.

##### How it works in StackSim

Configuration and consumed-capacity reporting are active. Set `STACKSIM_DDB_ENFORCE_CAPACITY=true` for deterministic token-bucket throttling. No billing is calculated.

##### Common AWS use cases

- Start new projects on on-demand; switch to provisioned when traffic is predictable.
- Set provisioned RCU/WCU for load tests that should hit throttling boundaries.

#### Auto scaling

##### What it is

Target-tracking descriptors: minimum/maximum capacity units and target utilization percentage for reads and writes.

##### Why use it

In AWS, Application Auto Scaling adjusts provisioned throughput to keep utilization near the target (commonly 70%) while respecting min/max bounds.

##### How it works in StackSim

Settings are stored and returned via the API. Application Auto Scaling does not run locally; capacity is not adjusted automatically.

---

### Additional settings

#### Table class

##### What it is

**DynamoDB Standard** vs **DynamoDB Standard-Infrequent Access (IA)** — a pricing class choice.

##### Why use it

In AWS, Standard-IA reduces storage cost for data accessed less than once per month, with higher per-request cost. Choose based on access frequency.

##### How it works in StackSim

The selected class persists for API fidelity. Local storage behavior and cost do not change.

---

#### Deletion protection

##### What it is

When enabled, `DeleteTable` is rejected until protection is turned off.

##### Why use it

Prevents accidental deletion of production tables through console mistakes, bad scripts, or misconfigured automation.

##### How it works in StackSim

The setting actively rejects local table deletion until disabled.

---

#### Encryption at rest

##### What it is

Encryption type: service-owned key (SSE) or KMS key reference.

##### Why use it

In AWS, all DynamoDB data is encrypted at rest. Customer-managed KMS keys add access control and audit trails for regulated workloads.

##### How it works in StackSim

SSE descriptors and KMS key references persist for compatibility. KMS is unavailable locally; KMS selections remain dependency-blocked.

---

#### Time to Live (TTL)

##### What it is

Automatically deletes items when a designated **Number** attribute contains an expired Unix timestamp (seconds).

##### Why use it

TTL removes session records, cache entries, temporary tokens, and time-bound data without application delete logic or write capacity for each expiration.

In AWS, deletion typically occurs within 48 hours after expiration; expired items may still appear in reads until deleted.

##### How it works in StackSim

TTL configuration, background expiry, streams, replication, and metrics are active. StackSim uses a shorter deterministic sweep interval than AWS.

##### Common AWS use cases

- Session store with `expiresAt` attribute.
- API rate-limit counters that auto-expire.
- Staging data that should disappear after 7 days.

##### Example

Enable TTL on attribute `ttl` (Number). When writing an item:

```json
{
  "sessionId": { "S": "abc-123" },
  "userId": { "S": "user-456" },
  "ttl": { "N": "1735689600" }
}
```

DynamoDB deletes the item after that epoch second passes.

---

### Backups

#### Point-in-time recovery (PITR)

##### What it is

Continuous journaling of table changes for restore to any second within a retention window (1–35 days). Restore creates a **new** table.

##### Why use it

PITR protects against accidental writes, bad deployments, and operator errors between scheduled backups. In AWS, you can restore to any second in the last 35 days (when enabled).

##### How it works in StackSim

Retention configuration, mutation journaling, and restore to latest or specific time are active. Local restore points are available through the latest completed second.

##### Common AWS use cases

- Enable PITR on all production tables.
- Restore to five minutes before a bad batch job ran.
- Complement on-demand backups with continuous protection.

#### On-demand backups

##### What it is

Immutable snapshots at a moment in time. Create, inspect, restore (to a new table), or delete backups.

##### Why use it

Named recovery points before schema changes, major releases, or compliance checkpoints. Restore always creates a new table; source and backup remain unchanged.

##### How it works in StackSim

Backup creation, inspection, deletion, and restore of items, keys, indexes, billing, capacity, and encryption descriptors are active. Tags, TTL, streams, auto scaling, and policies must be reconfigured after restore.

##### Common AWS use cases

- Backup before dropping a GSI.
- Monthly compliance snapshot retained for seven years (with export to S3 in AWS).
- Clone production data to a staging table via restore.

---

### Exports and streams (table tab)

Combines stream configuration, Kinesis destination, Lambda triggers, and table-scoped PITR exports.

#### DynamoDB stream details

##### What it is

Captures ordered change records for each item mutation. **Stream view type** options:

| View type | Record contents |
|-----------|-----------------|
| `KEYS_ONLY` | Key attributes only |
| `NEW_IMAGE` | Item after the change |
| `OLD_IMAGE` | Item before the change |
| `NEW_AND_OLD_IMAGES` | Both images |

##### Why use it

Streams power event-driven architectures: Lambda consumers react to inserts, updates, and deletes; cross-service sync; audit trails; and cache invalidation.

Changing view type in AWS creates a new stream ARN.

##### How it works in StackSim

One deterministic shard, signed iterators, retention, item/transaction/TTL records, and Lambda event source mappings are active.

##### Common AWS use cases

- Lambda trigger on `NEW_AND_OLD_IMAGES` to sync Elasticsearch.
- `KEYS_ONLY` stream for lightweight fan-out when full item payload is fetched separately.
- TTL deletions appear as stream records when enabled.

##### Example

Enable stream with `NEW_AND_OLD_IMAGES` on `Orders`. A Lambda consumer receives the old and new item when an order status changes from `PENDING` to `SHIPPED`.

---

#### Kinesis data stream destination

##### What it is

Configuration to copy DynamoDB changes to a Kinesis data stream with millisecond or microsecond timestamp precision.

##### Why use it

In AWS, Kinesis offers longer retention and additional consumers (analytics, multiple Lambda functions, custom consumers) beyond native DynamoDB streams.

##### How it works in StackSim

ARN, precision, and lifecycle states persist locally. No Kinesis service runs; table records are not delivered.

---

#### Lambda triggers

##### What it is

Event source mappings that poll the DynamoDB stream and invoke Lambda with batches of records. Configurable batch size, starting position, and filtering.

##### Why use it

The standard pattern for reacting to database changes without polling the table — process new orders, update search indexes, send notifications.

##### How it works in StackSim

Batching, filters, retries, partial failures, bisecting, destinations, checkpoints, and pause/resume are active for enabled streams and local Lambda functions.

##### Common AWS use cases

- Process new `INSERT` events only with event filtering.
- Start at `TRIM_HORIZON` for full replay vs `LATEST` for new changes only.

---

#### Point-in-time exports (table)

##### What it is

Export a consistent table snapshot to local `file://` paths in DynamoDB JSON Lines format. Requires PITR enabled.

##### Why use it

In AWS, exports to S3 do not consume table read capacity — useful for analytics, ML pipelines, and archival without impacting production traffic.

##### How it works in StackSim

Full exports to opted-in absolute `file://` locations are active when `STACKSIM_ALLOW_LOCAL_FILES=true`. No S3 request is made. Ion and incremental exports are unavailable.

---

### Global tables (table tab)

#### Global table replicas

##### What it is

Add or remove replica Regions for multi-active replication. Each replica accepts reads and writes; changes replicate with eventual consistency.

##### Why use it

Global tables place data close to users in multiple Regions, support disaster recovery, and enable active-active multi-Region applications.

In AWS, conflict resolution uses last-writer-wins per item based on timestamps.

##### How it works in StackSim

Same-account multi-Region eventual consistency (MREC), backfill, ordered replication, and deterministic last-writer-wins conflicts are active. MRSC witnesses, multi-account groups, and replica KMS keys are dependency-blocked.

##### Common AWS use cases

- US + EU replicas for a global SaaS app.
- Failover by redirecting traffic to a healthy Region.
- Local reads in each Region for latency-sensitive mobile apps.

##### Example

Primary table `Sessions` in `eu-west-1`. Add replica in `us-east-1`. Users in both Regions read and write locally; sessions converge across Regions within seconds.

---

### Contributor insights (table tab)

#### Contributor insights

##### What it is

Per-table and per-GSI configuration to track frequently accessed or throttled partition/sort keys. Modes:

- **Accessed and throttled keys** — record successful access and throttles
- **Throttled keys only** — record data only when capacity enforcement throttles

Includes **Top key activity** for the last hour.

##### Why use it

Hot keys are a common DynamoDB production issue — one popular item or poorly chosen partition key concentrates traffic. Contributor Insights surfaces the keys driving access and throttles.

##### How it works in StackSim

Configuration, durable counts, and CloudWatch metrics in `StackSim/DynamoDBContributorInsights` are active. Oversized key values are replaced with SHA-256 digests in metrics.

##### Common AWS use cases

- Identify a celebrity user's partition receiving disproportionate reads.
- Confirm throttling correlates with specific sort keys before resharding design.
- Enable throttled-keys-only mode in cost-sensitive monitoring.

---

### Permissions

#### Resource-based policy

##### What it is

JSON IAM policy attached to the table (and index ARNs) granting or denying actions for principals. Supports cross-account access when combined with identity policies.

##### Why use it

Resource policies enable cross-account table access without complex role chaining — grant partner account `123456789012` read access to specific indexes.

Explicit **Deny** always wins. Same-account access can come from identity allow **or** resource allow; cross-account requires **both**.

##### How it works in StackSim

Policy validation, revision IDs, lockout acknowledgement, and local authorization are active. Findings are simulator guidance, not IAM Access Analyzer results.

##### Common AWS use cases

- Allow a central analytics account to `Query` a specific GSI.
- Deny `dynamodb:DeleteTable` for all principals except break-glass admin roles.
- Starter policy granting account root read access for learning.

##### Example

Grant read-only access to account `999999999999`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CrossAccountRead",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::999999999999:root" },
      "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"],
      "Resource": [
        "arn:aws:dynamodb:eu-west-1:123456789012:table/SharedData",
        "arn:aws:dynamodb:eu-west-1:123456789012:table/SharedData/index/*"
      ]
    }
  ]
}
```

---

### Tags

#### Tags (table)

##### What it is

Up to 50 case-sensitive key-value tags on the table resource (not on individual items).

##### Why use it

Organize tables by environment, owner, cost center, and application. When **ABAC** is enabled at bucket/table level in AWS, tags participate in IAM condition keys.

##### How it works in StackSim

Tag CRUD and supported `aws:ResourceTag/` authorization conditions are active.

##### Common AWS use cases

- `Environment=production`, `Team=platform`, `CostCenter=eng-123`.
- Automation that starts/stops non-production tables by tag.

---

## Account-level tools

### Transaction builder

#### Ordered actions

##### What it is

Local tool to compose and run `TransactWriteItems` — ordered condition checks, puts, updates, and deletes in one atomic request.

##### Why use it

Transactions guarantee all-or-nothing commits — transfer inventory and create an order in one step, or neither happens. In AWS, up to 100 actions per transaction with constraints on item size and cross-item conditions.

##### How it works in StackSim

Validation, conditions, cancellation reasons, idempotency tokens, atomic commit, streams, replication, and capacity reporting are active.

##### Common AWS use cases

- Debit wallet and credit merchant atomically.
- Conditional update: "create order only if inventory > 0".
- Idempotent writes with `ClientRequestToken`.

##### Example

Transfer credits between two accounts in one transaction — both balance updates succeed or both roll back.

---

### PartiQL editor

#### Operation

##### What it is

Run SQL-like statements against DynamoDB:

- **Single statement** — `ExecuteStatement`
- **Batch statements** — `BatchExecuteStatement`
- **Transaction statements** — `ExecuteTransaction`

Supports parameterized queries with `?` placeholders and DynamoDB JSON parameter types.

#### Operations (browser history)

Saved operations and run history stored in browser local storage — export/import as JSON for reuse.

##### Why use it

PartiQL lets SQL-familiar developers query DynamoDB without learning the full low-level API for ad hoc work. Parameterized statements prevent injection and handle typed values cleanly.

##### How it works in StackSim

Supported SELECT, INSERT, UPDATE, DELETE, batch, transaction, and pagination execute locally. Unsupported grammar returns explicit errors.

##### Common AWS use cases

- `SELECT * FROM "Orders" WHERE "customerId" = ?`
- Batch insert seed data during development.
- Transactional multi-statement updates from the console.

##### Example

```sql
SELECT "orderId", "total"
FROM "Orders"
WHERE "customerId" = ?
```

Parameters: `[{"S": "C-1001"}]`

---

### Global tables (account list)

Regional list of global tables with replica Regions. Manage replicas from each table's **Global tables** tab.

---

### Exports and streams (account)

Account-level export job list plus links to per-table stream and Kinesis configuration.

---

### Imports

#### Imports

##### What it is

Create a **new** table from local DynamoDB JSON Lines files (optionally GZIP-compressed). Specify source path, target table name, and primary key schema.

##### Why use it

In AWS, import from S3 creates tables without consuming write capacity — fast bulk loads from exported data or migrated datasets.

##### How it works in StackSim

Opted-in `file://` sources, DynamoDB JSON, job status, and asynchronous table creation are active when `STACKSIM_ALLOW_LOCAL_FILES=true`. CSV, Ion, and ZSTD are unavailable.

##### Common AWS use cases

- Clone exported production snapshot into a dev environment (with redaction).
- Migrate from another database via batch export → import pipeline.

##### Example

Import from `file:///tmp/exports/AWSDynamoDB/1234567890123-id/data` into new table `OrdersRestored` with keys matching the export.

---

### Contributor insights (account)

Regional list of all tables and GSIs with contributor insights enabled. Same configuration options as the per-table tab.

---

### Backups (account)

Account-wide list of user-created on-demand backups with create, inspect, restore, and delete actions. Links to per-table PITR on each table's **Backups** tab.

---

## Data model quick reference

### Keys and access patterns

```text
Table
  Primary key (required)
    Partition key (HASH)  → determines partition
    Sort key (RANGE)      → optional; orders items within partition
  Non-key attributes    → schemaless; any names and types per item
  GSI / LSI             → alternate query paths
```

### When to use each read operation

| Operation | Cost profile | Use when |
|-----------|--------------|----------|
| **GetItem** | 1 item | Known full primary key |
| **Query** | One partition | Known partition key; optional sort condition |
| **Scan** | Entire table | Rare; small tables; migrations; admin only |
| **BatchGetItem** | Multiple known keys | Fetch many items by key in one request |

---

## Local environment notes

| Feature | StackSim behavior |
|---------|-------------------|
| Capacity billing | Not calculated |
| Throttling | Optional via `STACKSIM_DDB_ENFORCE_CAPACITY=true` |
| KMS encryption | Configuration only; writes blocked |
| Auto scaling | Stored descriptors; no automatic changes |
| Kinesis destination | Configuration only; no delivery |
| File import/export | Requires `STACKSIM_ALLOW_LOCAL_FILES=true` |
| TTL deletion delay | Short deterministic sweep (not AWS 48-hour window) |
| PITR latest point | Latest completed local second |

---

## Related StackSim docs

- [Developer guide](./developer-guide.md) — CDK tutorials using DynamoDB tables
- [IAM console guide](./iam-console-guide.md) — table access policies and roles
- [EventBridge console guide](./eventbridge-console-guide.md) — DynamoDB stream events (via PutEvents)
- [API Gateway console guide](./apigateway-console-guide.md) — REST APIs backed by DynamoDB
- [Cognito console guide](./cognito-console-guide.md) — user pools for protected APIs
- [Parameter Store console guide](./parameter-store-console-guide.md) — app config and secrets by name
- [S3 console guide](./s3-console-guide.md) — object storage (export destination in AWS)
- [AWS CLI cookbook](./aws-cli-cookbook.md) — CLI examples for DynamoDB operations
- [SQS console guide](./sqs-console-guide.md) — decouple stream or API-driven writes with queues
- [SNS console guide](./sns-console-guide.md) — DynamoDB Streams publish to topics
- [Lambda console guide](./lambda-console-guide.md) — stream event source mappings
- [AppSync console guide](./appsync-console-guide.md) — GraphQL data sources backed by tables
- [CloudWatch console guide](./cloudwatch-console-guide.md) — Contributor Insights managed rules
