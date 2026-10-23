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
| **Dashboard** | Account summary and quick links |
| **Tables** | Create, list, select, and act on tables (Actions menu: view details, explore items, update settings, create backup, export to S3, delete) |
| **Explore items** | Pick a table and open its Scan/Query item explorer |
| **PartiQL editor** | SQL-compatible reads and writes |
| **Backups** | Account-level on-demand backup list |
| **Exports to S3** | Account-level export jobs and stream guidance |
| **Imports from S3** | Create tables from DynamoDB JSON in S3 (or opted-in local files) |
| **Global tables** | Multi-Region replica overview |
| **Contributor insights** | Hot-key and throttle monitoring |
| **Transaction builder (local)** | Compose and run `TransactWriteItems`; a StackSim learning tool with no AWS console equivalent |

Opening a table shows the same tabs as the AWS console, in the same order: **Overview**, **Indexes**, **Monitor**, **Global tables**, **Backups**, **Exports and streams**, **Additional settings**, **Permissions**, and **Tags**. Read/write capacity and auto scaling live under **Additional settings**, Contributor Insights lives under **Monitor**, and **Explore table items** is a button on the table page (and the **Explore items** navigation entry), not a tab.

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
- **Table settings** — **Default settings** (on-demand, DynamoDB Standard, no indexes, DynamoDB-owned encryption, deletion protection off) or **Customize settings**
- Under **Customize settings**: **Table class**, **Read/write capacity settings** (on-demand with an optional maximum table throughput, or provisioned with per-side auto scaling on/off, min/max/target or fixed units), **Secondary indexes** (global or local, with attribute projections), **Encryption at rest** (owned by DynamoDB, AWS managed key, or a customer managed key), **Deletion protection**, **Warm throughput**, an optional **Resource-based policy**, and **Tags**

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

Read-only summary laid out like the AWS console: **General information** (partition key, sort key, capacity mode, table status), **Items summary** (item count, table size, average item size, with an **Explore table items** button), and **Additional info** (ARN, table ID, creation date, table class, read/write capacity, warm throughput, deletion protection, encryption, TTL, DynamoDB stream, point-in-time recovery, and global-table status, each linking to the tab that manages it).

#### Why use it

Quick health check after deploys — confirm the table is `ACTIVE`, keys match your design, and item count is reasonable.

---

### Explore table items

Open it with **Explore table items** on a table page, or choose **Explore items** in the navigation and pick a table. The page has two panels, **Scan or query items** and **Items returned**, as in the AWS console.

#### Scan or query items

##### What it is

- **Scan** or **Query**, chosen with the switch at the top of the panel.
- **Select a table or index** — the base table or one of its local or global secondary indexes.
- **Select attribute projection** — **All attributes**, **Only projected attributes** (indexes only; sends `Select: ALL_PROJECTED_ATTRIBUTES`), or **Specific attributes** (sends a `ProjectionExpression` for the names you list).
- **Partition key** and **Sort key** (Query) — the sort key takes a condition (Equal to, Less than or equal to, Less than, Greater than or equal to, Greater than, Between, Begins with) and is optional; **Sort descending** reverses the order.
- **Filters** — expanded by default. Each row has **Attribute name**, **Condition**, **Type**, and **Value**; **Add filter** adds a row and rows combine with AND. Conditions: Equal to, Not equal to, Less than or equal to, Less than, Greater than or equal to, Greater than, Between, Exists, Not exists, Contains, Not contains, Begins with. Types: String, Number, Binary, Boolean (True/False), and Null (no value box). Boolean and Null offer only Equal to, Not equal to, Exists, and Not exists; Number omits Begins with.
- **Run** and **Reset**.
- **Additional settings (local)** — options the AWS page does not show, each mapped to a documented parameter: page size (`Limit`), results view (table, plain JSON, DynamoDB JSON), strongly consistent read, count only (`Select: COUNT`), a switch that runs a scan when the page opens, parallel scan segments, and a raw filter expression with its own names and values.

##### Why use it

**Query** is the primary access pattern in DynamoDB — it reads one partition efficiently. **Scan** reads every partition and should be used sparingly in production (migrations, admin tools, small tables).

Filters apply after data is read, so they still consume capacity for scanned items even when filtered out. The Scan warning under the results shows how many items were evaluated to return the page.

##### How it works in StackSim

Every request is a real `Scan` or `Query` with `ReturnConsumedCapacity: TOTAL`; the service validates it and its errors appear in place of the results. The query settings, filters, and page are kept for the browser session, so returning from an item page, editing a cell, or deleting items re-runs the same request instead of resetting the page.

#### Items returned

##### What it is

- The heading shows the item count, and a green summary reads **Completed. Read capacity units consumed: N**.
- Columns list the table's partition and sort keys first (then the index keys), followed by the other attributes. Values show without type badges.
- The first key value links to **Edit item**. A pencil button on a String, Number, Binary, or Boolean cell opens **Edit String** (or Number, Binary, Boolean) and saves that one attribute.
- Checkboxes select items (the header box selects the page). **Actions**: **Edit item** and **Duplicate item** (one item), **Query for selected item** (one item; switches to Query on its key), **Export to CSV** (the selected items, or the whole page when nothing is selected), and **Delete items** (one or more; confirmed with a **Delete** button).
- **Create item** opens the Create item page. **Previous** and **Next** page through results.

##### How it works in StackSim

Edit, duplicate, and delete always use the base-table key, so they work from index results too; when a projection drops a key attribute, the item actions stay disabled. Inline edits use `UpdateItem` with `SET` and a condition that the item still exists; deletes send one `DeleteItem` per selected item.

#### Create item, Edit item, and Duplicate item

##### What it is

Full pages, as in AWS, with a **Form** / **JSON view** switch (**View DynamoDB JSON** toggles typed and plain JSON).

- The form lists **Attribute name**, **Value**, and **Type**, with the key attributes first and marked Partition key or Sort key.
- **Add new attribute** offers String, Number, Binary, Boolean, Null, String set, Number set, Binary set, List, and Map.
- Boolean values use a True/False selector; Null has no value box; each set member has its own box (**Add value**), so members can contain commas.
- Map and List attributes expand into nested rows with **Add attribute to map** or **Add element to list**, and collapse with the arrow beside the name.
- **Create item** (create and duplicate) or **Save and close** (edit) writes the item; **Cancel** returns to the results.

##### How it works in StackSim

Create and duplicate send `PutItem` with `attribute_not_exists` on the partition key, so an existing key is reported instead of overwritten. Edit sends `PutItem` with the unchanged key; key values are read-only while editing, so use **Duplicate item** to give an item a new key. **Duplicate item** starts with every attribute of the source item, including its key values, ready to change.

##### Common AWS use cases

- Query `PK = USER#123` and `SK begins_with ORDER#` in a single-table design.
- Scan a dev table to inspect seed data, then filter on a Boolean flag such as `active = True`.
- Create test items, including nested maps and lists, before wiring an application.
- Select several stale test items and delete them in one action.

##### Example

Query the `Orders` table:

- Partition key: `C-1001` (`customerId`)
- Sort key: Between `2026-01-01` and `2026-12-31` (`orderDate`)
- Filter: `status` · Not equal to · String · `CANCELLED`

Returns the customer's 2026 orders that are not cancelled without scanning other customers' partitions; the filter still reads the cancelled orders, which the capacity summary reflects.

---

### Indexes

#### Secondary indexes

##### What it is

The tab has two tables, as in AWS:

- **Global secondary indexes** — Name, Status (Active, Creating, Updating, Deleting, Backfilling), Partition key, Sort key, Read capacity, Write capacity, Attribute projections (All, Keys only, or Include with the listed attributes), Size, and Item count. Select an index and choose **Delete**, then type **confirm**.
- **Local secondary indexes** — Name, Partition key, Sort key, Attribute projections, Size, and Item count.

**Create index** opens the **Create global secondary index** page: Partition key and Sort key with data types, an Index name suggested from the keys (`pk-sk-index`), Attribute projections (All, Only keys, Include with projected attributes), and, for provisioned tables, read and write capacity units.

##### Why use it

The table primary key supports one access pattern. Secondary indexes add alternate keys so applications can query by other attributes — for example lookup by `email` when the primary key is `userId`.

| Type | Partition key | When created | Use case |
|------|---------------|--------------|----------|
| **GSI** | Any top-level String, Number, or Binary attribute | Anytime | Most alternate access patterns |
| **LSI** | Same as table | Only at table creation | Alternate sort key on same partition |

**Projection** controls copied attributes: `ALL`, `KEYS_ONLY`, or `INCLUDE` specific attributes.

##### How it works in StackSim

Creation sends `UpdateTable` with `GlobalSecondaryIndexUpdates: Create` and the key attribute definitions (never an empty list). Size and item count are exact and current locally; AWS updates them about every six hours. LSIs can only be created with the table. The AWS developer guide does not document the Indexes tab columns or the delete confirmation, so those follow the 2026-10-22 console review.

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

One graph per CloudWatch metric, with time-range chips (1h, 3h, 12h, 1d, 3d, 1w) and a **Table or index** selector:

- Read usage and Write usage (average units per second, with provisioned capacity on provisioned tables)
- Read and Write throttled events
- Throttled requests, by operation
- Get and query latency, and put, update, and delete latency (average milliseconds, by operation)
- Returned item count (Query and Scan)
- Conditional check failed requests, System errors (by operation), User errors (account and Region), and Time to Live deleted items

Index scope shows the four capacity and throttle graphs for that GSI. Below the graphs, **Alarms** lists CloudWatch alarms on this table's metrics, and Contributor Insights follows.

Consumed read/write capacity uses execution accounting, including item size, read consistency, evaluated rows before filters, index work and transaction factors. Table series include LSIs; GSIs have separate series. Native and PartiQL batch/transaction work contributes once per outer request across all affected tables. Metrics use the local JSON-byte capacity model, not AWS billing; publication is best effort and cannot turn a committed write into a reported failure.

##### Why use it

In AWS, metrics reveal hot partitions, throttling, error spikes, and capacity headroom. Alarms on `UserErrors`, `SystemErrors`, and `ThrottledRequests` drive operational response.

##### How it works in StackSim

Metrics publish to local CloudWatch with the AWS dimensions from the DynamoDB metrics reference: `SuccessfulRequestLatency` and `ReturnedItemCount` by `TableName` and `Operation` (a request spanning several tables keeps one `Operation`-only latency sample), `ConditionalCheckFailedRequests` by `TableName`, `SystemErrors` and `ThrottledRequests` by `TableName` and `Operation`, `UserErrors` without dimensions, and `ReadThrottleEvents`/`WriteThrottleEvents` by table or GSI when `STACKSIM_DDB_ENFORCE_CAPACITY=true` rejects a request. Throttled requests are not counted as user errors. Graphs describe local activity only. The AWS guide documents only Contributor Insights on this tab; the graph set follows the 2026-10-22 console review.

##### Common AWS use cases

- Alarm when `ConsumedWriteCapacityUnits` exceeds provisioned capacity.
- Compare table vs GSI read patterns before adding capacity.
- Diagnose sudden `ThrottledRequests` after a traffic spike.

---

### Additional settings — Read/write capacity and auto scaling

These two cards sit at the top of the **Additional settings** tab, as in the AWS console. The **Edit** dialog shows only the fields for the selected capacity mode: provisioned read/write capacity units, or an optional maximum table throughput for on-demand.

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

Target-tracking descriptors, configured separately for reads and writes: auto scaling on or off, minimum/maximum capacity units, and target utilization percentage.

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

**Edit** opens a dialog with **Enable delete protection**, the wording in the AWS developer guide. While it is on, `DeleteTable` is rejected and the console's Delete action is unavailable.

#### Encryption

##### What it is

Encryption type: service-owned key (SSE) or KMS key reference.

##### Why use it

In AWS, all DynamoDB data is encrypted at rest. Customer-managed KMS keys add access control and audit trails for regulated workloads.

##### How it works in StackSim

**Manage encryption** offers the three AWS key types: **Owned by Amazon DynamoDB** (the default), **AWS managed key** (alias `aws/dynamodb`), and **Stored in your account, and owned and managed by you** (a customer managed key, entered as a key ID, ARN, or alias). **Save** sends `UpdateTable` with `SSESpecification`. The card and Overview show the key management type. No KMS service runs locally, so KMS selections are stored as configuration and shown as dependency blocked, never as active encryption.

#### Time to Live (TTL)

##### What it is

Automatically deletes items when a designated **Number** attribute contains an expired Unix timestamp (seconds).

##### Why use it

TTL removes session records, cache entries, temporary tokens, and time-bound data without application delete logic or write capacity for each expiration.

In AWS, expired items are deleted within a few days of their expiration time (the API reference still says "typically within two days"); expired items may still appear in reads until deleted.

##### How it works in StackSim

**Turn on** opens **Turn on Time to Live (TTL)** with the TTL attribute name and an optional **Preview**: choose a simulated date and time and **Run preview** to see how many items (of the first 100 evaluated) would be expired then. The preview is an ordinary bounded `Scan`. **Turn off** stops expiration. To use another attribute, turn TTL off and on again with the new name, as DynamoDB requires; DynamoDB also allows one TTL change per hour per table. Expired items are deleted by a configurable short local sweep instead of within days.

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

**Edit** opens **Edit point-in-time recovery settings**: **Turn on point-in-time recovery** and a **Backup recovery period** of any whole number of days from 1 to 35; clearing the checkbox turns PITR off and resets the restore history. **Restore** asks for a new table name and a restore point (**Latest**, **Earliest**, or a specific date and time), then the shared restore options: Same Region (cross-Region restores are not available locally), all or no secondary indexes, and the encryption key type. Restores use the Standard table class. Restore points are available through the latest completed local second.

##### Common AWS use cases

- Enable PITR on all production tables.
- Restore to five minutes before a bad batch job ran.
- Complement on-demand backups with continuous protection.

#### Backups

##### What it is

Immutable snapshots at a moment in time. Create, inspect, restore (to a new table), or delete backups.

##### Why use it

Named recovery points before schema changes, major releases, or compliance checkpoints. Restore always creates a new table; source and backup remain unchanged.

##### How it works in StackSim

The list shows user and system backups with Backup name, Status, Backup type (User, System, AWS Backup), Table name, Creation time, Expiration date, and Size. **Restore** uses the same options as a PITR restore and **Restore table**. **Delete** asks you to type **delete**, as in AWS; AWS Backup backups can't be deleted from the console. Snapshots are stored locally and restore through the normal table creation lifecycle.

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

In AWS the view type cannot be edited in place: turn the stream off, then on again with the new view type, which creates a new stream ARN. The previous ARN stays readable for 24 hours and is still shown as the latest stream while the stream is off.

##### How it works in StackSim

**Turn on** opens **Turn on DynamoDB stream** with the AWS view types (**Key attributes only**, **New image**, **Old image**, **New and old images**) and **Turn on stream**. There is no in-place view-type change: turn the stream off, then on with another view type, which creates a new stream ARN. One deterministic local shard preserves successful single-item, batch, transaction, PartiQL, and TTL mutations; iterators expire after 15 minutes and records default to 24-hour retention.

##### Common AWS use cases

- Lambda trigger on `NEW_AND_OLD_IMAGES` to sync Elasticsearch.
- `KEYS_ONLY` stream for lightweight fan-out when full item payload is fetched separately.
- TTL deletions appear as stream records when enabled.

##### Example

Enable stream with `NEW_AND_OLD_IMAGES` on `Orders`. A Lambda consumer receives the old and new item when an order status changes from `PENDING` to `SHIPPED`.

---

#### Amazon Kinesis data stream details

##### What it is

Configuration to copy DynamoDB changes to a Kinesis data stream with millisecond or microsecond timestamp precision.

##### Why use it

In AWS, Kinesis offers longer retention and additional consumers (analytics, multiple Lambda functions, custom consumers) beyond native DynamoDB streams.

##### How it works in StackSim

**Turn on** stores one same-account, same-Region destination ARN with the record timestamp precision (Microsecond, the console default, or Millisecond); **Change precision** and **Turn off** manage it. No Kinesis service runs locally, so the stream ARN is typed rather than chosen from a list and no records are delivered.

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

#### Exports to S3 (table)

##### What it is

Export a consistent table snapshot to a local S3 bucket (or an opted-in `file://` path) in DynamoDB JSON Lines format. Requires PITR enabled.

##### Why use it

In AWS, exports to S3 do not consume table read capacity — useful for analytics, ML pipelines, and archival without impacting production traffic.

##### How it works in StackSim

**Export to S3** opens the export page with this table selected; see Exports to S3 below. The list shows the export ID, source table, status (In progress, Completed, Failed), export type, export time, item count, and destination.

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

**Manage tags** edits tags as Key and Value rows with **Add new tag** and **Remove**, counting the remaining tags out of 50. Duplicate or empty keys are rejected before any request; changes are sent as `UntagResource` and `TagResource`. The AWS developer guide places table tags in a Tags section of Additional settings; StackSim keeps the separate Tags tab chosen in DDB-16A.

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

- **Tables** panel — each table has an actions menu that writes a statement into the editor: **Scan table**, **Query table** (with `partitionKeyValue` and `sortKeyValue` placeholders, as the AWS guide shows), **Insert item**, **Update item**, and **Delete item**. Only Query table is named in the AWS developer guide; the other labels follow the 2026-10-22 console review.
- **Single statement** — `ExecuteStatement`, with **Download results to CSV** when a statement returns items.
- **Batch statements (local)** — `BatchExecuteStatement`; **Transaction statements (local)** — `ExecuteTransaction`. The AWS editor runs one statement at a time, so these modes, the **Key query builder (local)**, and the **Access path (local estimate)** note are StackSim learning aids.

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

### Exports to S3 (account)

The export job list (export ID, source table, status, export type, export time, items, destination) plus links to per-table stream and Kinesis configuration. **Export to S3** opens a page with the documented fields: Source table, **Destination S3 bucket** (`s3://bucket-name/prefix`), **S3 bucket owner** (This AWS account or A different AWS account with its ID), **Export type** (Full export; Incremental export is shown but not available locally), **Export time** (Current time or a point in time within the PITR window), and **Exported file format** (DynamoDB JSON; Amazon Ion not available locally). An absolute `file://` URL with an export prefix uses the opted-in local files extension.

---

### Imports

#### Imports

##### What it is

Create a **new** table from DynamoDB JSON data. **Import from S3** opens a page with **Source S3 URL** (`s3://bucket-name/prefix`), **S3 bucket owner**, **Import file compression** (No compression, GZIP; ZSTD not available locally), **Import file format** (DynamoDB JSON; Amazon Ion and CSV not available locally), and the destination table: name, partition and sort keys, and on-demand or provisioned capacity. AWS spreads these over three wizard steps; StackSim shows them on one page.

##### Why use it

In AWS, import from S3 creates tables without consuming write capacity — fast bulk loads from exported data or migrated datasets.

##### How it works in StackSim

Local S3 bucket sources (and opted-in `file://` paths), DynamoDB JSON, GZIP, job status, bounded progress, failure codes, and asynchronous table creation are active. Import pins current object generations at admission and resumes from checkpoints after restart. CSV, Ion, and ZSTD remain unavailable.

##### Common AWS use cases

- Clone exported production snapshot into a dev environment (with redaction).
- Migrate from another database via batch export → import pipeline.

##### Example

Import from `s3://stacksim-dynamodb-transfer/exports/AWSDynamoDB/1234567890123-id/data` into new table `OrdersRestored` with keys matching the export.

---

### Contributor insights (account)

Regional list of all tables and GSIs with contributor insights enabled. Same configuration options as the per-table tab.

---

### Backups (account)

Account-wide list of user and system backups (Backup type and Expiration date columns) with create, inspect, restore, and delete actions; delete asks you to type **delete**. Links to per-table PITR on each table's **Backups** tab.

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
| Local S3 import/export | DynamoDB JSON/GZIP via S3 transfer port; `file://` needs `STACKSIM_ALLOW_LOCAL_FILES=true` |
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
