import { dynamo, metrics, rest, s3Request } from "../api-client.js";
import { associateFormLabels, emptyState, escapeHtml, metricChart, pageHeader, panelHeading } from "../components.js";
import { eventSourceMappingForm, eventSourceMappingInput } from "../event-source-mappings.js";
import { session, setDirty } from "../state.js";
import { bindEnhancedDynamoItems, dynamoItemEditorPage, enhancedDynamoItemsView } from "./dynamodb-items.js";
import { enhancedDynamoPartiql } from "./dynamodb-partiql.js";
import { bindEnhancedMonitor, bindIndexesTab, dynamoCreateIndexPage, dynamoIndexesTabView, enhancedDynamoMonitorView } from "./dynamodb-admin.js";
import { enhancedDynamoCreateTable } from "./dynamodb-create.js";

export const metadata = {
  key: "dynamodb",
  name: "DynamoDB",
  icon: "D",
  cls: "db",
  links: [["Dashboard", "#/dynamodb"], ["Tables", "#/dynamodb/tables"], ["Explore items", "#/dynamodb/explore"], ["PartiQL editor", "#/dynamodb/partiql"], ["Backups", "#/dynamodb/backups"], ["Exports to S3", "#/dynamodb/exports"], ["Imports from S3", "#/dynamodb/imports"], ["Global tables", "#/dynamodb/global-tables"], ["Contributor insights", "#/dynamodb/contributor-insights"], ["Transaction builder (local)", "#/dynamodb/transactions"]],
  search: ["dynamodb", "table", "global table", "replica", "multi-region", "transaction", "partiql", "sql", "nosql", "backup", "restore", "point in time recovery", "pitr", "stream", "exports and streams", "export", "import", "file", "contributor insights", "hot key", "access frequency", "throttled key", "lambda trigger", "permissions", "resource policy"],
};

let attributeRowId = 0;

const dynamoPanelHelp = {
  tables: {
    level: "Supported locally",
    description: "A DynamoDB table stores a collection of items. Every item is identified by the table's primary key, while the remaining attributes can vary from item to item. Use this panel to find an existing table or create the namespace and key design for a new workload.",
    support: "Table creation, listing, updates, deletion, key validation, and regional names are active and persist locally. Capacity has no charge and is descriptive unless deterministic capacity enforcement is enabled.",
  },
  tableDetails: {
    level: "Supported locally",
    description: "Table details define the table name and primary key. A partition key identifies the partition and must be present on every item; an optional sort key lets several related items share a partition key while remaining uniquely addressable and ordered.",
    support: "String, number, and binary key types, composite keys, validation, and key-based reads and writes are active. DynamoDB remains schemaless for every non-key attribute.",
  },
  tableSettings: {
    level: "Supported locally",
    description: "Table settings choose how read and write capacity is represented. On-demand mode adapts without capacity planning in AWS, while provisioned mode assigns explicit read and write capacity units that applications can monitor and scale.",
    support: "Both billing-mode descriptors and provisioned values round-trip through the API. No charges are calculated; throttling is active only when STACKSIM_DDB_ENFORCE_CAPACITY=true.",
  },
  secondaryIndexes: {
    level: "Supported locally",
    description: "A secondary index gives the same items another key and access pattern, so an application can query by attributes other than the table's primary key. Projection controls which attributes are copied into the index. Global indexes may use any partition key; local indexes share the table partition key.",
    support: "Global and local index tables with projections, size, item count, and capacity; the Create global secondary index page; maintenance; queries; and global-index deletion are active. Local secondary indexes can be created only with the table, matching DynamoDB's lifecycle rule.",
  },
  transactions: {
    level: "Supported locally",
    description: "A transaction groups ordered condition checks, puts, updates, or deletes into one all-or-nothing request. Use it when related item changes must either all succeed from the same snapshot or leave the database unchanged.",
    support: "TransactWriteItems validation, conditions, cancellation reasons, idempotency tokens, atomic commit, streams, replication, and capacity reporting are active locally.",
  },
  partiql: {
    level: "Supported subset",
    description: "PartiQL is a SQL-compatible language for reading and changing DynamoDB items. Choose a single statement for interactive work, a batch for several similar operations, or a transaction when multiple statements must commit atomically. Parameters keep values separate from statement text.",
    support: "Supported SELECT, INSERT, UPDATE, DELETE, batch, transaction, pagination, and typed-parameter behavior execute against local tables. Unsupported grammar and service features return explicit errors rather than being sent elsewhere.",
  },
  partiqlOperations: {
    level: "Browser-local tool",
    description: "Operations keeps recent PartiQL runs and reusable saved requests. Search it to recover a statement, save a useful operation before experimenting, or export and import a collection for another browser session.",
    support: "History and saved operations live in this browser's local storage and JSON import/export is active. They are console conveniences, not DynamoDB service resources or shared account state.",
  },
  exports: {
    level: "Supported locally",
    description: "A point-in-time export writes a consistent table snapshot without consuming table read capacity. Select a local S3 bucket whose policy allows the DynamoDB service principal.",
    support: "Full exports write DynamoDB JSON/GZIP data, manifests, and checksums through policy-checked local S3. The opted-in file:// extension remains available; incremental exports, Ion, and KMS encryption are unavailable.",
  },
  imports: {
    level: "Supported locally",
    description: "An import creates a new table from DynamoDB-formatted objects in a local S3 bucket. Define the new table's primary key and select an exported manifest root or a raw DynamoDB JSON prefix.",
    support: "Policy-checked, generation-pinned local S3 sources and opted-in file:// sources support DynamoDB JSON with GZIP or no compression. CSV, Ion, and ZSTD are unavailable.",
  },
  contributorInsights: {
    level: "Supported locally",
    description: "Contributor Insights identifies frequently accessed or throttled partition keys. Configure the table and each global secondary index separately, choosing whether to observe all key access or only requests that capacity enforcement throttles.",
    support: "Configuration, durable access and throttle counts, and local CloudWatch metrics are active. Key values can appear in metric dimensions; oversized values are replaced with a SHA-256 digest.",
  },
  backups: {
    level: "Supported locally",
    description: "An on-demand backup is an immutable snapshot of a table at one moment. Create one before a risky change or for a named recovery point; restoring always creates a new table and leaves both the source and backup unchanged.",
    support: "Backup creation, inspection, deletion, and restore of items, keys, indexes, billing, capacity, and encryption descriptors are active. Tags, TTL, streams, auto scaling, and policies must be configured again after restore.",
  },
  items: {
    level: "Supported locally",
    description: "Scan reads items across a table or index, while Query efficiently selects one partition-key value and can narrow a sort-key range. Filters refine items after they are read; projections choose the attributes returned. Use Create item to add schemaless DynamoDB attributes.",
    support: "Scan and Query with key conditions, several AND-combined filters (String, Number, Binary, Boolean, Null), attribute projections, checkbox selection with Edit, Duplicate, Delete, Query for selected item, and Export to CSV, inline cell edits, and the Create/Edit/Duplicate item pages are active. Page size, consistent reads, count only, parallel scans, and raw expressions sit under Additional settings (local).",
  },
  metrics: {
    level: "Supported locally",
    description: "Table metrics help you inspect reads, writes, errors, latency, and throttling over time. Select the table or a global secondary index, a time range, aggregation period, statistic, and the series you want to compare.",
    support: "DynamoDB request metrics are published to the local CloudWatch-compatible store and these controls query that data. The charts describe local activity and do not contact AWS CloudWatch.",
  },
  capacity: {
    level: "Partial",
    description: "Read/write capacity selects on-demand or provisioned operation and, where applicable, maximum request units, explicit capacity units, and warm-throughput descriptors. These values let SDK and infrastructure code exercise the same configuration shapes used in AWS.",
    support: "Configuration, validation, consumed-capacity reporting, and optional deterministic token-bucket throttling are active. There is no billing, distributed fleet, or AWS adaptive-capacity behavior.",
  },
  autoScaling: {
    level: "Configuration only",
    description: "Auto scaling normally adjusts provisioned read or write capacity to keep utilization near a target percentage within minimum and maximum bounds. Configure it for workloads and templates that expect target-tracking settings.",
    support: "Scaling targets and policies are stored and returned, but StackSim does not run Application Auto Scaling or change capacity automatically.",
  },
  tableClass: {
    level: "Configuration only",
    description: "Table class chooses between DynamoDB Standard and Standard-Infrequent Access pricing. In AWS the choice changes the balance between storage cost and request cost, so it is normally based on how often stored data is accessed.",
    support: "The selected class, update lifecycle, and API values persist locally. Local storage behavior and cost do not change because StackSim does not calculate usage charges.",
  },
  deletionProtection: {
    level: "Supported locally",
    description: "Deletion protection prevents accidental removal of the table through the console, SDK, or infrastructure automation. Enable it for important tables; it must be deliberately turned off before DeleteTable can succeed.",
    support: "The setting persists and actively rejects local table deletion until disabled. It does not prevent item changes, backup deletion, or other table configuration updates.",
  },
  encryption: {
    level: "Configuration only",
    description: "Encryption at rest selects the key type DynamoDB would use for stored table data. A service-owned key needs no setup, while a KMS key supports service-managed or customer-managed key references and access controls in AWS.",
    support: "SSE descriptors and KMS key references persist for API compatibility. KMS is unavailable, so KMS selections remain dependency blocked; local state relies on host filesystem permissions rather than AWS KMS encryption.",
  },
  ttl: {
    level: "Supported locally",
    description: "Time to Live automatically removes items whose chosen attribute is a Number containing an expired Unix timestamp in seconds. Use it for sessions, caches, or temporary records that should age out without application delete requests.",
    support: "TTL configuration, validation, background expiry, streams, replication, and metrics are active. StackSim uses a short deterministic sweep interval instead of AWS's typical multi-day deletion window.",
  },
  tags: {
    level: "Supported locally",
    description: "Tags are case-sensitive key-value labels attached to the table rather than its items. Use them for organization, ownership, automation, and tag-aware IAM conditions without changing table data.",
    support: "Tag listing, replacement, limits, and supported resource-tag authorization conditions are active and persist locally. Tags do not create billing reports.",
  },
  pitr: {
    level: "Supported locally",
    description: "Point-in-time recovery continuously journals table changes so you can restore a new table to a chosen second within the retained window. Use it when you need recovery between named on-demand backups.",
    support: "Configurable 1–35 day retention, mutation journaling, latest or specific-time restore, and restart persistence are active. Local restore points are available through the latest completed second rather than AWS's approximate five-minute delay.",
  },
  stream: {
    level: "Supported locally",
    description: "A DynamoDB stream records item changes in order. The view type decides whether each record contains only keys, the new image, the old image, or both. Enable it when Lambda or another stream consumer should react to database changes.",
    support: "A deterministic shard, signed iterators, retention, item and transaction records, TTL records, and checkpoints are active. Changing the view type creates a new local stream descriptor.",
  },
  kinesisDestination: {
    level: "Configuration only",
    description: "A Kinesis data stream destination would continuously copy DynamoDB item changes into a Kinesis stream for longer retention or additional consumers. The timestamp precision controls the creation-time detail placed in destination records.",
    support: "The same-account, same-Region ARN, precision, and lifecycle states persist locally. StackSim has no Kinesis service and does not deliver table records to the configured destination.",
  },
  lambdaTriggers: {
    level: "Supported locally",
    description: "A Lambda trigger is an event source mapping that polls the DynamoDB stream and invokes a function with batches of change records. Create one when application code should react automatically to inserts, updates, deletes, or expired items.",
    support: "Batching, filters, retries, partial failures, bisecting, destinations, durable checkpoints, and pause or resume behavior are active for enabled local DynamoDB streams and Lambda functions.",
  },
  globalReplicas: {
    level: "Supported locally",
    description: "Global table replicas make the table multi-active across Regions, so applications can read and write in more than one Region. Adding a replica backfills current items and then sends later changes through eventual replication.",
    support: "Same-account multi-Region eventual consistency, durable ordered replication, backfill, TTL changes, and deterministic last-writer-wins conflicts are active. MRSC witnesses, multi-account groups, and replica KMS keys are dependency blocked.",
  },
  resourcePolicy: {
    level: "Supported locally",
    description: "A resource-based policy is a JSON document attached to the table that grants or denies actions for principals. It can cover the table and explicit index ARNs, enable supported cross-account access, and combine with identity policies; an explicit deny always wins.",
    support: "Policy validation, revision checks, lockout acknowledgement, principals, resources, actions, conditions, and local authorization are active. Reads are immediately consistent locally and the guidance is not IAM Access Analyzer.",
  },
};

const dynamoPanelHelpTargets = [
  ["Tables", "tables"],
  ["Table details", "tableDetails"],
  ["Table settings", "tableSettings"],
  ["Secondary indexes", "secondaryIndexes"],
  ["Global secondary indexes", "secondaryIndexes"],
  ["Ordered actions", "transactions"],
  ["Operation", "partiql"],
  ["Operations", "partiqlOperations"],
  ["Exports", "exports"],
  ["Point-in-time exports", "exports"],
  ["Exports to S3", "exports"],
  ["Imports", "imports"],
  ["Contributor insights resources", "contributorInsights"],
  ["Contributor insights", "contributorInsights"],
  ["On-demand backups", "backups"],
  ["Backups", "backups"],
  ["Scan or query items", "items"],
  ["Table metrics", "metrics"],
  ["Read/write capacity", "capacity"],
  ["Auto scaling", "autoScaling"],
  ["Table class", "tableClass"],
  ["Deletion protection", "deletionProtection"],
  ["Encryption at rest", "encryption"],
  ["Encryption", "encryption"],
  ["Time to Live (TTL)", "ttl"],
  ["Tags", "tags"],
  ["Point-in-time recovery (PITR)", "pitr"],
  ["DynamoDB stream details", "stream"],
  ["Kinesis data stream destination", "kinesisDestination"],
  ["Amazon Kinesis data stream details", "kinesisDestination"],
  ["Lambda triggers", "lambdaTriggers"],
  ["Global table replicas", "globalReplicas"],
  ["Resource-based policy", "resourcePolicy"],
];

function decorateDynamoPanelHelp(root = document) {
  for (const [title, helpKey] of dynamoPanelHelpTargets) {
    const heading = [...root.querySelectorAll(".card > .card-header h2")].find(candidate => {
      const text = candidate.textContent.trim();
      return text === title || text.startsWith(`${title} (`) || text.startsWith(`${title} ·`) || text.startsWith(`${title} –`);
    });
    if (!heading) continue;
    const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
    heading.outerHTML = panelHeading(title, dynamoPanelHelp[helpKey], meta);
  }
}

async function collectDynamoPages(operation, input, itemField, requestToken, responseToken) {
  const items = []; let token;
  do {
    const page = await dynamo(operation, { ...input, ...(token ? { [requestToken]: token } : {}) });
    items.push(...(page[itemField] ?? [])); token = page[responseToken];
  } while (token);
  return items;
}

async function collectTableNames() {
  return collectDynamoPages("ListTables", { Limit: 100 }, "TableNames", "ExclusiveStartTableName", "LastEvaluatedTableName");
}

export async function routeDynamoDb(parts, context) {
  const withPanelHelp = async render => {
    const result = await render();
    decorateDynamoPanelHelp(context.main);
    return result;
  };
  if (!parts[1] && parts.length === 1) return withPanelHelp(() => dynamoOverview(context));
  if (parts[1] === "transactions" && parts.length === 2) return withPanelHelp(() => dynamoTransactions(context));
  if (parts[1] === "partiql" && parts.length === 2) return withPanelHelp(() => enhancedDynamoPartiql(context));
  if (parts[1] === "global-tables" && parts.length === 2) return withPanelHelp(() => dynamoGlobalTables(context));
  if (parts[1] === "exports" && parts.length === 2) return withPanelHelp(() => dynamoExports(context));
  if (parts[1] === "exports" && parts[2] === "create" && parts.length <= 4) return withPanelHelp(() => dynamoExportPage(context, parts[3] ?? ""));
  if (parts[1] === "imports" && parts[2] === "create" && parts.length === 3) return withPanelHelp(() => dynamoImportPage(context));
  if (parts[1] === "imports" && parts.length === 2) return withPanelHelp(() => dynamoImports(context));
  if (parts[1] === "contributor-insights" && parts.length === 2) return withPanelHelp(() => dynamoContributorInsights(context));
  if (parts[1] === "explore" && parts.length === 2) return withPanelHelp(() => dynamoExplore(context));
  if (parts[1] === "tables" && !parts[2] && parts.length === 2) return withPanelHelp(() => dynamoTables(context));
  if (parts[1] === "tables" && parts[2] === "create" && parts.length === 3) return withPanelHelp(() => enhancedDynamoCreateTable(context));
  if (parts[1] === "tables" && parts[2] && parts[3] === "indexes" && parts[4] === "create" && parts.length === 5) return withPanelHelp(() => dynamoCreateIndexPage(context, parts[2]));
  if (parts[1] === "tables" && parts[2] && parts[3] === "items" && ["create", "edit", "duplicate"].includes(parts[4]) && parts.length <= 6) return withPanelHelp(() => dynamoItemEditorPage(context, parts[2], parts[4], parts[5]));
  if (parts[1] === "tables" && parts[2] && parts.length <= 4 && new Set([undefined, "overview", "items", "indexes", "monitor", "capacity", "settings", "tags", "backups", "streams", "global", "contributors", "permissions"]).has(parts[3])) {
    return withPanelHelp(() => dynamoDetail(context, parts[2], parts[3] ?? "overview"));
  }
  if (parts[1] === "backups" && parts.length === 2) return withPanelHelp(() => dynamoBackups(context));
  return context.notFound(parts);
}

function dynamoPlaceholder(context, title) {
  context.setChrome("dynamodb", [metadata.name, title]);
  context.main.innerHTML = `<div class="page-width">${pageHeader(title, "This area is reserved for future service functionality.")}<div class="card">${emptyState("◇", "Not implemented yet", "The navigation and page structure are in place and will grow with the simulator.")}</div></div>`;
}

async function dynamoOverview(context) {
  const { main, setChrome } = context;
  setChrome("dynamodb", ["DynamoDB", "Overview"]);
  const list = { TableNames: await collectTableNames() };
  main.innerHTML = `<div class="page-width">${pageHeader("DynamoDB", "Managed NoSQL database service for single-digit millisecond performance.", `<a class="button primary" href="#/dynamodb/tables/create">Create table</a>`)}<div class="dashboard-grid"><div class="card"><div class="card-header"><h2>Tables</h2></div><div class="card-body"><div class="metric">${list.TableNames?.length ?? 0}</div><p class="muted">Tables in this region</p><a href="#/dynamodb/tables">View tables</a></div></div><div class="card"><div class="card-header"><h2>Get started</h2></div><div class="card-body"><p>Create a table with a partition key and an optional sort key.</p><a class="button" href="#/dynamodb/tables/create">Create table</a></div></div></div></div>`;
}

async function dynamoTransactions(context) {
  const { main, setChrome, showError, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "Transaction builder"]);
  const example = { ClientRequestToken: crypto.randomUUID(), ReturnConsumedCapacity: "TOTAL", TransactItems: [{ Put: { TableName: "ExampleTable", Item: { id: { S: "example" } }, ConditionExpression: "attribute_not_exists(id)" } }] };
  main.innerHTML = `<div class="page-width">${pageHeader("Transaction builder", "Local learning tool for composing ordered TransactWriteItems actions.")}<div class="alert info"><strong>Local tooling</strong><br>The transaction is evaluated from one snapshot and either every action commits or none do.</div><div class="test-layout"><section class="card"><div class="card-header"><h2>Ordered actions</h2></div><div class="card-body"><div class="field"><label>Transaction request (DynamoDB JSON)</label><textarea id="transaction-request" class="code-editor" style="min-height:420px">${escapeHtml(JSON.stringify(example, null, 2))}</textarea></div><div class="actions"><button class="button" id="preview-transaction">Refresh preview</button><button class="button primary" id="run-transaction">Run transaction</button></div></div></section><section class="card"><div class="card-header"><h2>Request preview and result</h2></div><div class="card-body"><pre class="code-box" id="transaction-result">${escapeHtml(JSON.stringify(example, null, 2))}</pre></div></section></div></div>`;
  const request = document.querySelector("#transaction-request");
  const result = document.querySelector("#transaction-result");
  document.querySelector("#preview-transaction").addEventListener("click", () => {
    try { result.textContent = JSON.stringify(JSON.parse(request.value), null, 2); }
    catch (error) { showError(error); }
  });
  document.querySelector("#run-transaction").addEventListener("click", async () => {
    result.textContent = "Running transaction…";
    try {
      const response = await dynamo("TransactWriteItems", JSON.parse(request.value));
      result.textContent = JSON.stringify({ committed: true, ...response }, null, 2);
      setDirty(false, "page");
      toast("Transaction committed");
    } catch (error) {
      result.textContent = JSON.stringify({ committed: false, cancellation: error.message }, null, 2);
      showError(error);
    }
  });
}

async function dynamoPartiql(context) {
  const { main, setChrome, showError } = context; setChrome("dynamodb", ["DynamoDB", "PartiQL editor"]);
  const tables = (await dynamo("ListTables")).TableNames ?? []; const exampleTable = tables[0] ?? "TableName"; const historyKey = "stacksim:dynamodb:partiql-history"; let history = [];
  try { history = JSON.parse(localStorage.getItem(historyKey) ?? "[]"); if (!Array.isArray(history)) history = []; } catch { history = []; }
  main.innerHTML = `<div class="page-width">${pageHeader("PartiQL editor", "Run SQL-compatible statements against DynamoDB tables and indexes.")}<div class="partiql-layout"><section class="card partiql-editor"><div class="card-header"><div><h2>Statement</h2><p class="muted small">SELECT, INSERT, UPDATE, and DELETE are supported.</p></div><div class="actions"><button class="button" id="clear-partiql">Clear</button><button class="button primary" id="run-partiql">Run</button></div></div><div class="card-body"><div class="field"><label>PartiQL statement</label><textarea id="partiql-statement" class="code-editor" spellcheck="false">SELECT * FROM "${escapeHtml(exampleTable)}"</textarea><span class="hint">Use question marks for values and double quotes for table, index, or reserved attribute names.</span></div><div class="field"><label>Parameters (DynamoDB JSON)</label><textarea id="partiql-parameters" spellcheck="false">[]</textarea><span class="hint">Ordered array of AttributeValue objects, for example [{"S":"tenant-a"},{"N":"42"}].</span></div><div class="partiql-options"><div class="field"><label>Results view</label><select id="partiql-format"><option value="dynamodb">DynamoDB JSON</option><option value="plain">Plain JSON</option></select></div><div class="field"><label>Page size</label><select id="partiql-limit"><option>10</option><option selected>25</option><option>50</option></select></div><label class="checkbox-label"><input type="checkbox" id="partiql-consistent"> Strongly consistent read</label></div></div></section><aside class="card partiql-history"><div class="card-header"><h2>Operation history</h2><button class="button link" id="clear-partiql-history">Clear</button></div><div id="partiql-history-list"></div></aside></div><section class="card" id="partiql-result"><div class="card-header"><h2>Results</h2></div>${emptyState("◇", "No statement run", "Run a statement to view items, write status, pagination, or error details.")}</section></div>`;
  const statement = document.querySelector("#partiql-statement"); const parameters = document.querySelector("#partiql-parameters"); const result = document.querySelector("#partiql-result"); const format = document.querySelector("#partiql-format"); const state = { output: null, error: null, tokens: [undefined], page: 0, running: false };
  const saveHistory = entry => { history = [entry, ...history].slice(0, 20); localStorage.setItem(historyKey, JSON.stringify(history)); renderHistory(); };
  const renderHistory = () => { const root = document.querySelector("#partiql-history-list"); root.innerHTML = history.length ? `<div class="partiql-history-list">${history.map((entry, index) => `<button data-partiql-history="${index}"><span class="status ${entry.ok ? "" : "error"}">${escapeHtml(entry.operation)}</span><strong>${escapeHtml(entry.statement.replace(/\s+/g, " ").slice(0, 74))}</strong><small>${escapeHtml(new Date(entry.at).toLocaleString())} · ${entry.ok ? `${entry.count} item${entry.count === 1 ? "" : "s"}` : entry.error}</small></button>`).join("")}</div>` : emptyState("◇", "No history", "Recent statements from this browser appear here."); root.querySelectorAll("[data-partiql-history]").forEach(button => button.addEventListener("click", () => { const entry = history[Number(button.dataset.partiqlHistory)]; statement.value = entry.statement; parameters.value = entry.parameters; statement.focus(); })); };
  const renderResult = () => {
    if (state.error) { const details = state.error.details ?? { message: state.error.message }; result.innerHTML = `<div class="card-header"><div><h2>Error details</h2><p class="muted small">The statement was not completed.</p></div><span class="status error">Failed</span></div><div class="card-body"><div class="alert error"><strong>${escapeHtml(state.error.code ?? "Statement error")}</strong><br>${escapeHtml(state.error.message)}</div><pre class="code-box">${escapeHtml(JSON.stringify(details, null, 2))}</pre></div>`; return; }
    if (!state.output) return;
    const items = state.output.Items ?? []; const names = [...new Set(items.flatMap(item => Object.keys(item)))]; const plain = format.value === "plain";
    const body = items.length ? `<div class="table-wrap partiql-results-table"><table><thead><tr>${names.map(name => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${items.map(item => `<tr>${names.map(name => `<td>${plain ? `<span class="json-value">${escapeHtml(JSON.stringify(plainAttribute(item[name])))}</span>` : formatAttribute(item[name])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : emptyState("✓", "Statement completed", "The statement returned no items.");
    result.innerHTML = `<div class="card-header"><div><h2>Results <span class="muted">(${items.length})</span></h2><p class="muted small">Page ${state.page + 1} · ${plain ? "Plain JSON" : "DynamoDB JSON"}</p></div><div class="actions"><button class="button" id="partiql-previous" ${state.page === 0 ? "disabled" : ""}>Previous</button><button class="button" id="partiql-next" ${state.output.NextToken ? "" : "disabled"}>Next</button></div></div>${body}`;
    document.querySelector("#partiql-previous")?.addEventListener("click", () => runPage(state.page - 1, true)); document.querySelector("#partiql-next")?.addEventListener("click", () => { state.tokens[state.page + 1] = state.output.NextToken; runPage(state.page + 1, true); });
  };
  const runPage = async (pageIndex = 0, pagination = false) => {
    if (state.running) return; state.running = true; document.querySelector("#run-partiql").disabled = true; result.innerHTML = '<div class="card-header"><h2>Results</h2></div><div class="loading" role="status"><span></span>Running statement…</div>';
    const statementText = statement.value.trim(); const parameterText = parameters.value.trim() || "[]";
    try {
      const parsedParameters = JSON.parse(parameterText); if (!Array.isArray(parsedParameters)) throw new Error("Parameters must be a JSON array");
      const isSelect = /^SELECT\b/i.test(statementText);
      const output = await dynamo("ExecuteStatement", {
        Statement: statementText,
        Parameters: parsedParameters.length ? parsedParameters : undefined,
        ...(isSelect ? { Limit: Number(document.querySelector("#partiql-limit").value) } : {}),
        ...(isSelect && document.querySelector("#partiql-consistent").checked ? { ConsistentRead: true } : {}),
        ...(isSelect && state.tokens[pageIndex] ? { NextToken: state.tokens[pageIndex] } : {}),
      });
      state.output = output; state.error = null; state.page = pageIndex; if (!pagination) { state.tokens = [undefined]; saveHistory({ at: Date.now(), statement: statementText, parameters: parameterText, operation: statementText.split(/\s+/, 1)[0]?.toUpperCase() || "RUN", ok: true, count: output.Items?.length ?? 0 }); }
    } catch (error) { state.output = null; state.error = error; if (!pagination) saveHistory({ at: Date.now(), statement: statementText, parameters: parameterText, operation: statementText.split(/\s+/, 1)[0]?.toUpperCase() || "RUN", ok: false, count: 0, error: error.code ?? "Error" }); showError(error); }
    finally { state.running = false; document.querySelector("#run-partiql").disabled = false; renderResult(); }
  };
  document.querySelector("#run-partiql").addEventListener("click", () => runPage()); document.querySelector("#clear-partiql").addEventListener("click", () => { statement.value = ""; parameters.value = "[]"; statement.focus(); }); format.addEventListener("change", renderResult); document.querySelector("#clear-partiql-history").addEventListener("click", () => { history = []; localStorage.removeItem(historyKey); renderHistory(); });
  renderHistory();
}

function plainAttribute(value) {
  if (!value) return null; if ("S" in value) return value.S; if ("N" in value) return Number(value.N); if ("B" in value) return value.B; if ("BOOL" in value) return value.BOOL; if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(plainAttribute); if ("M" in value) return Object.fromEntries(Object.entries(value.M).map(([name, item]) => [name, plainAttribute(item)]));
  for (const type of ["SS", "NS", "BS"]) if (type in value) return type === "NS" ? value[type].map(Number) : value[type]; return value;
}

function dynamoDate(value) {
  if (value === undefined || value === null) return "–"; const date = new Date(typeof value === "number" ? value * 1000 : value); return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString();
}

function backupRows(backups) {
  if (!backups.length) return emptyState("◇", "No backups", "Create a backup to preserve an immutable table snapshot.");
  const typeLabel = value => ({ USER: "User", SYSTEM: "System", AWS_BACKUP: "AWS Backup" })[value] ?? value ?? "User";
  return `<table><thead><tr><th>Backup name</th><th>Status</th><th>Backup type</th><th>Table name</th><th>Creation time</th><th>Expiration date</th><th>Size</th><th>Actions</th></tr></thead><tbody>${backups.map(backup => `<tr data-backup-type="${escapeHtml(backup.BackupType ?? "USER")}"><td><button class="button link" data-backup-detail="${escapeHtml(encodeURIComponent(backup.BackupArn))}">${escapeHtml(backup.BackupName)}</button></td><td><span class="status ${backup.BackupStatus === "CREATING" ? "pending" : ""}">${escapeHtml(({ AVAILABLE: "Available", CREATING: "Creating", DELETED: "Deleted" })[backup.BackupStatus] ?? backup.BackupStatus)}</span></td><td>${escapeHtml(typeLabel(backup.BackupType))}</td><td><a href="#/dynamodb/tables/${encodeURIComponent(backup.TableName)}/overview">${escapeHtml(backup.TableName)}</a></td><td>${escapeHtml(dynamoDate(backup.BackupCreationDateTime))}</td><td>${escapeHtml(backup.BackupExpiryDateTime ? dynamoDate(backup.BackupExpiryDateTime) : "–")}</td><td>${formatBytes(backup.BackupSizeBytes)}</td><td class="no-wrap"><button class="button link" data-backup-restore="${escapeHtml(encodeURIComponent(backup.BackupArn))}" ${backup.BackupStatus !== "AVAILABLE" ? "disabled" : ""}>Restore</button><button class="button link" data-backup-delete="${escapeHtml(encodeURIComponent(backup.BackupArn))}" ${backup.BackupStatus !== "AVAILABLE" || backup.BackupType === "AWS_BACKUP" ? "disabled" : ""}>Delete</button></td></tr>`).join("")}</tbody></table>`;
}

async function dynamoBackups(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Backups"]); const [backups, TableNames] = await Promise.all([collectDynamoPages("ListBackups", { BackupType: "ALL", Limit: 100 }, "BackupSummaries", "ExclusiveStartBackupArn", "LastEvaluatedBackupArn"), collectTableNames()]); const tables = { TableNames };
  main.innerHTML = `<div class="page-width">${pageHeader("Backups", "Create, inspect, restore, and delete DynamoDB on-demand backups.", `<button class="button refresh" data-action="refresh-backups">↻</button><button class="button primary" data-action="create-backup" ${(tables.TableNames ?? []).length ? "" : "disabled"}>Create backup</button>`)}<div class="alert info"><strong>Point-in-time recovery</strong><br>Enable continuous backups and restore points from a table's <a href="#/dynamodb/tables">Backups tab</a>.</div><section class="card"><div class="card-header"><div><h2>On-demand backups <span class="muted">(${backups.length})</span></h2><p class="muted small">User-created snapshots in this account and Region.</p></div></div><div class="table-wrap">${backupRows(backups)}</div></section></div>`;
  document.querySelector('[data-action="refresh-backups"]')?.addEventListener("click", context.route); bindCreateBackup(context, tables.TableNames ?? []); bindBackupActions(context, backups);
}

function bindCreateBackup(context, tables, selectedTable) {
  const { showModal, toast } = context; document.querySelector('[data-action="create-backup"]')?.addEventListener("click", () => showModal("Create on-demand backup", `<div class="field"><label>Source table</label><select name="table" required>${tables.map(name => `<option value="${escapeHtml(name)}" ${name === selectedTable ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></div><div class="field"><label>Backup name</label><input name="name" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="learning-snapshot"><span class="hint">3–255 letters, numbers, underscores, hyphens, or periods.</span></div><div class="alert info"><strong>Immutable snapshot</strong><br>The backup preserves table data and index definitions at the request time without consuming table capacity.</div>`, "Create backup", async data => { await dynamo("CreateBackup", { TableName: data.get("table"), BackupName: data.get("name") }); toast("Backup creation started"); }));
}

function bindBackupActions(context, backups) {
  const { confirmDeletion, route, showModal, toast } = context; const findBackup = encoded => backups.find(backup => backup.BackupArn === decodeURIComponent(encoded));
  document.querySelectorAll("[data-backup-detail]").forEach(button => button.addEventListener("click", async () => {
    const backup = findBackup(button.dataset.backupDetail); if (!backup) return; const result = await dynamo("DescribeBackup", { BackupArn: backup.BackupArn }); const description = result.BackupDescription ?? {}; const details = description.BackupDetails ?? {}; const source = description.SourceTableDetails ?? {}; const features = description.SourceTableFeatureDetails ?? {};
    showModal("Backup details", `<div class="detail-grid"><dl class="key-value"><dt>Backup name</dt><dd>${escapeHtml(details.BackupName)}</dd><dt>Status</dt><dd><span class="status">${escapeHtml(details.BackupStatus)}</span></dd><dt>Created</dt><dd>${escapeHtml(dynamoDate(details.BackupCreationDateTime))}</dd></dl><dl class="key-value"><dt>Source table</dt><dd>${escapeHtml(source.TableName)}</dd><dt>Items</dt><dd>${source.ItemCount ?? 0}</dd><dt>Table size</dt><dd>${Number(source.TableSizeBytes ?? 0).toLocaleString()} bytes</dd></dl></div><div class="field"><label>Backup ARN</label><textarea class="code-editor" readonly>${escapeHtml(details.BackupArn)}</textarea></div><h3>Included table features</h3><p>${(features.GlobalSecondaryIndexes ?? []).length} global secondary indexes · ${(features.LocalSecondaryIndexes ?? []).length} local secondary indexes · ${escapeHtml(features.SSEDescription?.SSEType ?? "AES256")} encryption descriptor</p><p class="muted">Tags, TTL, streams, auto scaling, alarms, and IAM policies must be configured again on the restored table.</p>`, "Close", async () => {});
  }));
  document.querySelectorAll("[data-backup-restore]").forEach(button => button.addEventListener("click", async () => { const backup = findBackup(button.dataset.backupRestore); if (!backup) return; const described = (await dynamo("DescribeBackup", { BackupArn: backup.BackupArn })).BackupDescription ?? {}; showModal("Restore table from backup", `<div class="field"><label>Backup</label><input value="${escapeHtml(backup.BackupName)}" disabled></div><div class="field"><label>New table name</label><input name="target" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="${escapeHtml(backup.TableName)}-restored"></div>${restoreOptionsMarkup(described.SourceTableFeatureDetails?.SSEDescription)}<p class="muted">Restored tables use the DynamoDB Standard table class and the backup's capacity settings. Tags, TTL, streams, auto scaling, and PITR are not copied.</p>`, "Restore table", async data => { const target = String(data.get("target")); await dynamo("RestoreTableFromBackup", { BackupArn: backup.BackupArn, TargetTableName: target, ...restoreOverrides(data) }); toast("Table restore started"); location.hash = `#/dynamodb/tables/${encodeURIComponent(target)}/overview`; }, true); bindEncryptionOptions(document.querySelector("dialog")); }));
  document.querySelectorAll("[data-backup-delete]").forEach(button => button.addEventListener("click", () => { const backup = findBackup(button.dataset.backupDelete); if (!backup) return; showModal("Delete backup", `<p>Delete the backup <strong>${escapeHtml(backup.BackupName)}</strong>? You can't restore a table from it after it is deleted.</p><div class="field"><label>To confirm deletion, type <strong>delete</strong> in the field.</label><input name="confirmation" autocomplete="off" placeholder="delete" required></div>`, "Delete", async data => { if (String(data.get("confirmation") ?? "").trim() !== "delete") throw new Error("Type delete to confirm"); await dynamo("DeleteBackup", { BackupArn: backup.BackupArn }); toast("Backup deleted"); await route(); }, false, { danger: true, refreshAfterSubmit: false }); }));
}

function formatBytes(value) {
  const bytes = Number(value ?? 0); if (!Number.isFinite(bytes)) return "–";
  if (bytes < 1024) return `${bytes} bytes`; const units = ["KB", "MB", "GB", "TB"]; let size = bytes / 1024; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function capacityModeLabel(table, side) {
  if ((table.BillingModeSummary?.BillingMode ?? "PROVISIONED") === "PAY_PER_REQUEST") return "On-demand";
  const units = side === "read" ? table.ProvisionedThroughput?.ReadCapacityUnits : table.ProvisionedThroughput?.WriteCapacityUnits;
  return `Provisioned (${units ?? 0})`;
}

async function dynamoTables(context) {
  const { bindTableFilter, confirmDeletion, main, route, setChrome, showModal, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "Tables"]);
  const list = { TableNames: await collectTableNames() };
  const descriptions = await Promise.all((list.TableNames ?? []).map(name => dynamo("DescribeTable", { TableName: name }).then(result => result.Table)));
  const indexCount = table => (table.GlobalSecondaryIndexes?.length ?? 0) + (table.LocalSecondaryIndexes?.length ?? 0);
  const menu = `<details class="actions-menu" id="table-actions"><summary class="button" aria-haspopup="menu">Actions ▾</summary><div class="menu" role="menu"><button type="button" role="menuitem" data-table-action="details" disabled>View details</button><button type="button" role="menuitem" data-table-action="items" disabled>Explore items</button><button type="button" role="menuitem" data-table-action="settings" disabled>Update settings</button><button type="button" role="menuitem" data-table-action="backup" disabled>Create backup</button><button type="button" role="menuitem" data-table-action="export" disabled>Export to S3</button><button type="button" role="menuitem" class="danger" data-table-action="delete" disabled>Delete table</button></div></details>`;
  main.innerHTML = `<div class="page-width">${pageHeader("Tables", "View and manage DynamoDB tables.", `<button class="button refresh" data-action="refresh">↻</button>${menu}<a class="button primary" href="#/dynamodb/tables/create">Create table</a>`)}<section class="card"><div class="card-header"><h2>Tables <span class="muted">(${descriptions.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find tables by table name"></label></div><div class="table-wrap">${descriptions.length ? `<table class="selectable-table"><thead><tr><th class="checkbox-cell"><span class="sr-only">Select</span></th><th>Name</th><th>Status</th><th>Partition key</th><th>Sort key</th><th>Indexes</th><th>Deletion protection</th><th>Read capacity mode</th><th>Write capacity mode</th><th>Table size</th><th>Item count</th></tr></thead><tbody>${descriptions.map(table => `<tr data-search-row="${escapeHtml(table.TableName.toLowerCase())}"><td class="checkbox-cell"><input type="radio" name="selected-table" value="${escapeHtml(table.TableName)}" aria-label="Select ${escapeHtml(table.TableName)}"></td><td><a href="#/dynamodb/tables/${encodeURIComponent(table.TableName)}/overview">${escapeHtml(table.TableName)}</a></td><td><span class="status ${table.TableStatus === "ACTIVE" ? "" : "pending"}">${escapeHtml(table.TableStatus === "ACTIVE" ? "Active" : table.TableStatus)}</span></td><td>${escapeHtml(table.KeySchema.find(key => key.KeyType === "HASH")?.AttributeName)} (${attributeType(table, table.KeySchema.find(key => key.KeyType === "HASH")?.AttributeName)})</td><td>${(() => { const sort = table.KeySchema.find(key => key.KeyType === "RANGE"); return sort ? `${escapeHtml(sort.AttributeName)} (${attributeType(table, sort.AttributeName)})` : "–"; })()}</td><td>${indexCount(table)}</td><td>${table.DeletionProtectionEnabled ? "On" : "Off"}</td><td>${capacityModeLabel(table, "read")}</td><td>${capacityModeLabel(table, "write")}</td><td>${formatBytes(table.TableSizeBytes)}</td><td>${Number(table.ItemCount ?? 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : emptyState("D", "No tables", "Create a table to store items.", `<a class="button" href="#/dynamodb/tables/create">Create table</a>`)}</div></section></div>`;
  bindTableFilter();
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", route);
  const actions = document.querySelectorAll("[data-table-action]"); let selected;
  document.querySelectorAll('input[name="selected-table"]').forEach(radio => radio.addEventListener("change", () => { selected = descriptions.find(table => table.TableName === radio.value); actions.forEach(button => { button.disabled = !selected || (button.dataset.tableAction === "delete" && selected.DeletionProtectionEnabled === true); }); }));
  const open = section => { if (selected) location.hash = `#/dynamodb/tables/${encodeURIComponent(selected.TableName)}/${section}`; };
  actions.forEach(button => button.addEventListener("click", () => {
    document.querySelector("#table-actions").open = false; if (!selected) return; const action = button.dataset.tableAction;
    if (action === "details") open("overview"); else if (action === "items") open("items"); else if (action === "settings") open("settings"); else if (action === "export") open("streams");
    else if (action === "backup") showModal("Create backup", `<div class="field"><label>Table</label><input value="${escapeHtml(selected.TableName)}" disabled></div><div class="field"><label>Backup name</label><input name="name" required pattern="[A-Za-z0-9_.-]{3,255}" value="${escapeHtml(`${selected.TableName}-backup`)}"></div>`, "Create backup", async data => { await dynamo("CreateBackup", { TableName: selected.TableName, BackupName: String(data.get("name")) }); toast("Backup creation started"); }, false, { refreshAfterSubmit: false });
    else if (action === "delete") confirmDeletion(selected.TableName, `Delete table ${selected.TableName}? All items will be deleted.`, async () => { await dynamo("DeleteTable", { TableName: selected.TableName }); toast("Table deleted"); });
  }));
}

async function dynamoExplore(context) {
  const { main, setChrome } = context;
  setChrome("dynamodb", ["DynamoDB", "Explore items"]);
  const names = await collectTableNames();
  main.innerHTML = `<div class="page-width">${pageHeader("Explore items", "Scan or query a table, then view, create, edit, duplicate, or delete its items.")}<section class="card"><div class="card-header"><div><h2>Tables</h2><p class="muted small">Choose the table to explore. The Explore items page for that table opens with Scan selected.</p></div></div><div class="card-body">${names.length ? `<div class="field"><label for="explore-table">Table</label><select id="explore-table"><option value="">Choose a table</option>${names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}</select></div>` : emptyState("D", "No tables", "Create a table before exploring items.", `<a class="button" href="#/dynamodb/tables/create">Create table</a>`)}</div></section></div>`;
  document.querySelector("#explore-table")?.addEventListener("change", event => { const name = event.target.value; if (name) location.hash = `#/dynamodb/tables/${encodeURIComponent(name)}/items`; });
}

function bindCreateTable(context) {
  const { showModal, toast } = context;
  document.querySelectorAll('[data-action="create-table"]').forEach(button => button.addEventListener("click", () => showModal("Create table", `<div class="field"><label>Table name</label><input name="name" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="Music"><span class="hint">3–255 characters. Letters, numbers, underscores, hyphens, and periods.</span></div><h3>Partition key</h3><div class="field-row"><div class="field"><label>Key name</label><input name="partition" required placeholder="Artist"></div><div class="field"><label>Key type</label><select name="partitionType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><h3>Sort key <span class="muted small">– optional</span></h3><div class="field-row"><div class="field"><label>Key name</label><input name="sort" placeholder="SongTitle"></div><div class="field"><label>Key type</label><select name="sortType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field"><label>Table settings</label><select name="billing"><option value="PAY_PER_REQUEST">Default settings – On-demand</option><option value="PROVISIONED">Customize settings – Provisioned</option></select></div><h3>Secondary indexes <span class="muted small">– optional</span></h3><p class="muted">Define one index at creation, or add global secondary indexes later.</p><div class="field-row"><div class="field"><label>Index name</label><input name="indexName" placeholder="ByAlbum"></div><div class="field"><label>Index type</label><select name="indexType"><option value="GSI">Global secondary index</option><option value="LSI">Local secondary index</option></select></div></div><div class="field-row"><div class="field"><label>Index partition key</label><input name="indexPartition" placeholder="Album"></div><div class="field"><label>Index sort key</label><input name="indexSort" placeholder="Year"></div></div><div class="field"><label>Projection</label><select name="projection"><option value="ALL">All attributes</option><option value="KEYS_ONLY">Keys only</option></select></div>`, "Create table", async data => {
    const definitions = [{ AttributeName: data.get("partition"), AttributeType: data.get("partitionType") }];
    const schema = [{ AttributeName: data.get("partition"), KeyType: "HASH" }];
    if (data.get("sort")) {
      definitions.push({ AttributeName: data.get("sort"), AttributeType: data.get("sortType") });
      schema.push({ AttributeName: data.get("sort"), KeyType: "RANGE" });
    }
    const request = { TableName: data.get("name"), BillingMode: data.get("billing"), AttributeDefinitions: definitions, KeySchema: schema };
    if (data.get("billing") === "PROVISIONED") request.ProvisionedThroughput = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };
    if (data.get("indexName")) {
      const indexPartition = data.get("indexType") === "LSI" ? data.get("partition") : data.get("indexPartition");
      const indexSchema = [{ AttributeName: indexPartition, KeyType: "HASH" }];
      if (data.get("indexSort")) indexSchema.push({ AttributeName: data.get("indexSort"), KeyType: "RANGE" });
      for (const name of [indexPartition, data.get("indexSort")].filter(Boolean)) if (!definitions.some(definition => definition.AttributeName === name)) definitions.push({ AttributeName: name, AttributeType: "S" });
      const index = { IndexName: data.get("indexName"), KeySchema: indexSchema, Projection: { ProjectionType: data.get("projection") } };
      if (data.get("indexType") === "LSI") request.LocalSecondaryIndexes = [index]; else { if (request.BillingMode === "PROVISIONED") index.ProvisionedThroughput = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }; request.GlobalSecondaryIndexes = [index]; }
    }
    await dynamo("CreateTable", request);
    toast("Table created successfully");
    location.hash = `#/dynamodb/tables/${encodeURIComponent(data.get("name"))}/overview`;
  })));
}

async function dynamoDetail(context, name, section = "overview") {
  const { confirmDeletion, main, setChrome, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "Tables", name]);
  const result = await dynamo("DescribeTable", { TableName: name });
  const table = result.Table;
  if (typeof table.TableClassSummary?.LastUpdateDateTime === "number") table.TableClassSummary.LastUpdateDateTime = new Date(table.TableClassSummary.LastUpdateDateTime * 1000).toISOString();
  // Tab set and order follow the current AWS table page; read/write capacity lives under Additional settings and Contributor Insights under Monitor.
  const tabs = [["overview", "Overview"], ["indexes", "Indexes"], ["monitor", "Monitor"], ["global", "Global tables"], ["backups", "Backups"], ["streams", "Exports and streams"], ["settings", "Additional settings"], ["permissions", "Permissions"], ["tags", "Tags"]];
  const activeTab = section === "capacity" ? "settings" : section === "contributors" ? "monitor" : section;
  const content = section === "items" ? await enhancedDynamoItemsView(table) : section === "indexes" ? dynamoIndexesTabView(table) : section === "monitor" || section === "contributors" ? `${await enhancedDynamoMonitorView(table)}${await dynamoTableContributorInsightsView(table)}` : section === "capacity" || section === "settings" ? await dynamoSettingsView(table) : section === "tags" ? await dynamoTagsView(table) : section === "backups" ? await dynamoTableBackupsView(table) : section === "streams" ? await dynamoStreamsView(table) : section === "global" ? await dynamoGlobalTableView(table) : section === "permissions" ? await dynamoPermissionsView(table) : await dynamoOverviewView(table);
  const headerActions = `<button class="button danger" data-action="delete-table" ${table.DeletionProtectionEnabled ? "disabled title=\"Turn off deletion protection first\"" : ""}>Delete</button>${section === "items" ? `<a class="button" href="#/dynamodb/tables/${encodeURIComponent(name)}/overview">View table details</a>` : `<button class="button" data-action="explore-items">Explore table items</button>`}`;
  main.innerHTML = `<div class="page-width">${pageHeader(name, section === "items" ? `Explore items · <span class="mono">${escapeHtml(table.TableArn)}</span>` : table.TableArn, headerActions)}${section === "items" ? "" : `<div class="tabs">${tabs.map(([id, label]) => `<a class="tab ${activeTab === id ? "active" : ""}" href="#/dynamodb/tables/${encodeURIComponent(name)}/${id}">${label}</a>`).join("")}</div>`}${content}</div>`;
  requestAnimationFrame(() => { const tabs = document.querySelector(".tabs"); const active = tabs?.querySelector(".tab.active"); if (tabs && active) tabs.scrollLeft = active.offsetLeft - (tabs.clientWidth - active.clientWidth) / 2; });
  document.querySelector('[data-action="delete-table"]').addEventListener("click", () => confirmDeletion(name, `Delete table ${name}? All items will be deleted.`, async () => {
    await dynamo("DeleteTable", { TableName: name });
    toast("Table deleted");
    location.hash = "#/dynamodb/tables";
  }));
  document.querySelectorAll('[data-action="explore-items"]').forEach(button => button.addEventListener("click", () => { location.hash = `#/dynamodb/tables/${encodeURIComponent(name)}/items`; }));
  if (section === "items") bindEnhancedDynamoItems(context, table);
  if (section === "indexes") bindIndexesTab(context, table);
  if (section === "monitor" || section === "contributors") { bindEnhancedMonitor(context, table); bindContributorActions(context); }
  if (section === "capacity" || section === "settings") { bindCapacity(context, table); bindTableSettings(context, table); bindTtlSettings(context, table); }
  if (section === "tags") bindTableTags(context, table);
  if (section === "backups") bindTableBackups(context, table);
  if (section === "streams") bindTableStreams(context, table);
  if (section === "global") bindGlobalTable(context, table);
  if (section === "permissions") bindTablePermissions(context, table);
}

function transferStatus(value) { return `<span class="status ${value === "IN_PROGRESS" ? "pending" : value === "FAILED" ? "error" : ""}">${escapeHtml(({ IN_PROGRESS: "In progress", COMPLETED: "Completed", FAILED: "Failed", CANCELLING: "Cancelling", CANCELLED: "Cancelled" })[value] ?? value ?? "–")}</span>`; }

function exportRows(exports) {
  if (!exports.length) return emptyState("◇", "No exports", "Export a PITR-enabled table to an S3 bucket or opted-in local file location.");
  return `<table><thead><tr><th>Export ARN</th><th>Source table</th><th>Status</th><th>Export type</th><th>Export time</th><th>Items</th><th>Destination S3 bucket</th></tr></thead><tbody>${exports.map(job => { const tableName = job.TableArn?.split(":table/").at(-1)?.split("/")[0] ?? ""; return `<tr><td><button class="button link mono" data-export-detail="${escapeHtml(encodeURIComponent(job.ExportArn))}">${escapeHtml(job.ExportArn.split("/export/").at(-1) ?? job.ExportArn)}</button></td><td><a href="#/dynamodb/tables/${encodeURIComponent(tableName)}/streams">${escapeHtml(tableName || "–")}</a></td><td>${transferStatus(job.ExportStatus)}</td><td>${job.ExportType === "INCREMENTAL_EXPORT" ? "Incremental export" : "Full export"}</td><td>${escapeHtml(dynamoDate(job.ExportTime))}</td><td>${Number(job.ItemCount ?? 0).toLocaleString()}</td><td class="mono">${escapeHtml(`${job.S3Bucket ?? ""}${job.S3Prefix ? `/${job.S3Prefix}` : ""}`)}</td></tr>`; }).join("")}</tbody></table>`;
}

async function transferBucketOptions() {
  try {
    const listed = await s3Request("/?max-buckets=100");
    return [...listed.xml.getElementsByTagName("Bucket")].map(node => node.getElementsByTagName("Name")[0]?.textContent).filter(Boolean);
  } catch {
    return [];
  }
}

// "s3://bucket/prefix" or a bare bucket name; an absolute file:// URL is the explicit local-files extension and keeps a separate prefix.
function parseTransferUrl(value, localPrefix = "") {
  const text = String(value ?? "").trim();
  if (text.startsWith("file://")) return { bucket: text, prefix: String(localPrefix ?? "").trim() };
  const match = text.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (match) return { bucket: match[1], prefix: match[2].replace(/\/+$/, "") };
  if (!text || text.includes("/")) throw new Error("Enter an S3 URL such as s3://bucket-name/prefix");
  return { bucket: text, prefix: "" };
}
const ownerFields = () => `<fieldset class="setting-options"><legend>S3 bucket owner</legend><label class="setting-option"><input type="radio" name="owner" value="self" checked><span><strong>This AWS account</strong><small>The bucket belongs to the account you are signed in to.</small></span></label><label class="setting-option"><input type="radio" name="owner" value="other"><span><strong>A different AWS account</strong><small>Enter the 12-digit account ID that owns the bucket.</small></span></label></fieldset><div class="field" data-owner-account hidden><label>Bucket owner account ID</label><input name="ownerAccount" inputmode="numeric" pattern="[0-9]{12}" placeholder="111122223333"></div>`;
const bindOwnerFields = form => { const sync = () => { form.querySelector("[data-owner-account]").hidden = form.elements.owner.value !== "other"; }; form.querySelectorAll('input[name="owner"]').forEach(input => input.addEventListener("change", sync)); sync(); };
const bucketOwner = form => { if (form.elements.owner.value !== "other") return {}; const account = form.elements.ownerAccount.value.trim(); if (!/^\d{12}$/.test(account)) throw new Error("Enter the 12-digit bucket owner account ID"); return { S3BucketOwner: account }; };
const localPrefixField = (name, label) => `<div class="field" data-local-prefix hidden><label>${label}</label><input name="${name}" placeholder="exports/browser"><span class="hint">Local file extension only: the path under the file:// location.</span></div>`;
const bindLocalPrefix = (form, input) => { const sync = () => { form.querySelector("[data-local-prefix]").hidden = !input.value.trim().startsWith("file://"); }; input.addEventListener("input", sync); sync(); };
function transferPageShell(title, description, body, submitLabel, cancelHash) {
  return `<div class="page-width">${pageHeader(title, description)}<form id="transfer-form" class="transfer-form" novalidate><div class="alert error" id="transfer-error" role="alert" hidden></div>${body}<div class="actions page-actions"><a class="button" href="${cancelHash}">Cancel</a><button class="button primary" type="submit" id="transfer-submit">${submitLabel}</button></div></form></div>`;
}
function bindTransferSubmit(context, run) {
  const form = document.querySelector("#transfer-form");
  form.querySelectorAll("input, select").forEach(control => control.addEventListener("input", () => setDirty(true, "page")));
  form.addEventListener("submit", async event => {
    event.preventDefault(); const errorRoot = document.querySelector("#transfer-error"); const submit = document.querySelector("#transfer-submit"); errorRoot.hidden = true; submit.disabled = true;
    try { await run(form); setDirty(false, "page"); }
    catch (error) { errorRoot.hidden = false; errorRoot.innerHTML = `<strong>${escapeHtml(error.code ?? "Error")}</strong><br>${escapeHtml(error.message)}`; context.showError(error); submit.disabled = false; }
  });
}

// UI-16: Export to S3 is a page with the documented fields: source table, destination S3 URL, bucket owner, Full or
// Incremental export, export time (Current time or a point in time), and exported file format.
async function dynamoExportPage(context, selectedTable = "") {
  const { main, setChrome, toast } = context; setChrome("dynamodb", ["DynamoDB", "Exports to S3", "Export to S3"]);
  const [tables, buckets] = await Promise.all([collectTableNames(), transferBucketOptions()]);
  const back = selectedTable ? `#/dynamodb/tables/${encodeURIComponent(selectedTable)}/streams` : "#/dynamodb/exports";
  main.innerHTML = transferPageShell("Export to S3", "Export table data from a point in time within the PITR recovery period. Exports don't consume read capacity.", `<section class="card"><div class="card-header"><h2>Source and destination</h2></div><div class="card-body"><div class="field"><label>Source table</label><select name="table" required>${tables.map(name => `<option value="${escapeHtml(name)}" ${name === selectedTable ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select><span class="hint">Point-in-time recovery must be turned on for the table.</span></div><div class="field"><label>Destination S3 bucket</label><input name="destination" list="dynamodb-transfer-buckets" required placeholder="s3://bucket-name/prefix"><datalist id="dynamodb-transfer-buckets">${buckets.map(name => `<option value="s3://${escapeHtml(name)}"></option>`).join("")}</datalist><span class="hint">Format: s3://bucket-name/prefix. An absolute file:// URL uses the local files extension when it is enabled.</span></div>${localPrefixField("localPrefix", "Export prefix")}${ownerFields()}</div></section>`
    + `<section class="card"><div class="card-header"><h2>Export settings</h2></div><div class="card-body"><fieldset class="setting-options"><legend>Export type</legend><label class="setting-option"><input type="radio" name="exportType" value="FULL_EXPORT" checked><span><strong>Full export</strong><small>Export the whole table as of a point in time.</small></span></label><label class="setting-option disabled"><input type="radio" name="exportType" value="INCREMENTAL_EXPORT" disabled><span><strong>Incremental export</strong><small>Not available locally: StackSim exports full snapshots only.</small></span></label></fieldset><fieldset class="setting-options"><legend>Export time</legend><label class="setting-option"><input type="radio" name="exportTime" value="current" checked><span><strong>Current time</strong><small>The latest restorable time.</small></span></label><label class="setting-option"><input type="radio" name="exportTime" value="point"><span><strong>Point in time</strong><small>Any second in the PITR recovery period.</small></span></label></fieldset><div class="field" data-export-point hidden><label>Date and time</label><input name="pointTime" type="datetime-local" step="1"></div><fieldset class="setting-options"><legend>Exported file format</legend><label class="setting-option"><input type="radio" name="format" value="DYNAMODB_JSON" checked><span><strong>DynamoDB JSON</strong><small>One item per line with DynamoDB type descriptors.</small></span></label><label class="setting-option disabled"><input type="radio" name="format" value="ION" disabled><span><strong>Amazon Ion</strong><small>Not available locally.</small></span></label></fieldset><p class="muted small">Exported objects use the bucket's default encryption (an Amazon S3 key, SSE-S3).</p></div></section>`, "Export", back);
  const form = document.querySelector("#transfer-form");
  bindOwnerFields(form); bindLocalPrefix(form, form.elements.destination);
  form.querySelectorAll('input[name="exportTime"]').forEach(input => input.addEventListener("change", () => { form.querySelector("[data-export-point]").hidden = form.elements.exportTime.value !== "point"; }));
  bindTransferSubmit(context, async () => {
    const { bucket, prefix } = parseTransferUrl(form.elements.destination.value, form.elements.localPrefix.value);
    const table = (await dynamo("DescribeTable", { TableName: form.elements.table.value })).Table;
    const time = form.elements.exportTime.value === "point" ? form.elements.pointTime.value : "";
    if (form.elements.exportTime.value === "point" && !time) throw new Error("Choose the export date and time");
    await dynamo("ExportTableToPointInTime", { TableArn: table.TableArn, S3Bucket: bucket, ...(prefix ? { S3Prefix: prefix } : {}), ...bucketOwner(form), ExportType: "FULL_EXPORT", ExportFormat: "DYNAMODB_JSON", ...(time ? { ExportTime: new Date(time).getTime() / 1000 } : {}) });
    toast("Export started"); await new Promise(resolve => setTimeout(resolve, 80)); location.hash = back;
  });
}

function bindCreateExport(context, tables, selectedTable) {
  document.querySelectorAll('[data-action="create-export"]').forEach(button => button.addEventListener("click", () => { location.hash = selectedTable ? `#/dynamodb/exports/create/${encodeURIComponent(selectedTable)}` : "#/dynamodb/exports/create"; }));
}

function bindExportDetails(context, exports) {
  document.querySelectorAll("[data-export-detail]").forEach(button => button.addEventListener("click", () => { const job = exports.find(item => item.ExportArn === decodeURIComponent(button.dataset.exportDetail)); if (!job) return; context.showModal("Export details", `<div class="detail-grid"><dl class="key-value"><dt>Status</dt><dd>${transferStatus(job.ExportStatus)}</dd><dt>Items</dt><dd>${Number(job.ItemCount ?? 0).toLocaleString()}</dd><dt>Started</dt><dd>${escapeHtml(dynamoDate(job.StartTime))}</dd><dt>Completed</dt><dd>${escapeHtml(dynamoDate(job.EndTime))}</dd></dl><dl class="key-value"><dt>Format</dt><dd>${escapeHtml(job.ExportFormat)}</dd><dt>Type</dt><dd>${escapeHtml(job.ExportType)}</dd><dt>Manifest key</dt><dd class="mono">${escapeHtml(job.ExportManifest ?? "–")}</dd><dt>Destination type</dt><dd>${String(job.S3Bucket ?? "").startsWith("file://") ? "Local file extension" : "S3 bucket"}</dd></dl></div><div class="field"><label>Export ARN</label><textarea class="code-editor" readonly>${escapeHtml(job.ExportArn)}</textarea></div><div class="alert info"><strong>Destination</strong><br>${escapeHtml(`${job.S3Bucket ?? ""}${job.S3Prefix ? `/${job.S3Prefix}` : ""}`)}</div>`, "Close", async () => {}); }));
}

async function dynamoExports(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Exports to S3"]); const [ExportSummaries, TableNames, environment] = await Promise.all([collectDynamoPages("ListExports", { MaxResults: 25 }, "ExportSummaries", "NextToken", "NextToken"), collectTableNames(), rest("/_stacksim/api/environment")]); const tables = { TableNames }; const exports = await Promise.all(ExportSummaries.map(summary => dynamo("DescribeExport", { ExportArn: summary.ExportArn }).then(result => result.ExportDescription)));
  main.innerHTML = `<div class="page-width">${pageHeader("Exports to S3", "Export point-in-time table snapshots to S3-compatible DynamoDB JSON objects.", `<button class="button refresh" data-action="refresh-exports">↻</button><button class="button primary" data-action="create-export" ${(tables.TableNames ?? []).length ? "" : "disabled"}>Export to S3</button>`)}<div class="alert info"><strong>S3 is the primary transfer path</strong><br>Exports use local S3 buckets, service-principal authorization, immutable job checkpoints, and provider-compatible manifests. ${environment.allowLocalFiles ? "The explicit file:// extension is also enabled." : "The file:// extension is disabled."}</div><section class="card"><div class="card-header"><div><h2>Exports <span class="muted">(${exports.length})</span></h2><p class="muted small">Full PITR snapshots in DynamoDB JSON Lines with provider-compatible manifests.</p></div></div><div class="table-wrap">${exportRows(exports)}</div></section><section class="card"><div class="card-header"><div><h2>DynamoDB Streams</h2><p class="muted small">Per-table change capture and Lambda trigger readiness.</p></div><a class="button" href="#/dynamodb/tables">View table streams</a></div><div class="card-body"><p>Open a table's <strong>Exports and streams</strong> tab to enable its stream, choose image capture, and inspect its latest descriptor.</p></div></section><section class="card"><div class="card-header"><div><h2>Kinesis data stream destinations</h2><p class="muted small">Per-table destination settings and timestamp precision.</p></div><a class="button" href="#/dynamodb/tables">Manage table destinations</a></div><div class="card-body"><p>A table can store one same-account, same-Region Kinesis stream ARN. This simulator models the configuration lifecycle only and does not deliver records.</p></div></section></div>`; document.querySelector('[data-action="refresh-exports"]')?.addEventListener("click", context.route); bindCreateExport(context, tables.TableNames ?? []); bindExportDetails(context, exports);
}

function importRows(imports) {
  if (!imports.length) return emptyState("◇", "No imports", "Create a new table from DynamoDB JSON objects in S3 or an opted-in local file location.");
  return `<table><thead><tr><th>Target table</th><th>Status</th><th>Started</th><th>Processed</th><th>Imported</th><th>Source</th><th>Actions</th></tr></thead><tbody>${imports.map(job => `<tr><td><a href="#/dynamodb/tables/${encodeURIComponent(job.TableCreationParameters?.TableName ?? "")}/overview">${escapeHtml(job.TableCreationParameters?.TableName ?? "–")}</a></td><td>${transferStatus(job.ImportStatus)}</td><td>${escapeHtml(dynamoDate(job.StartTime))}</td><td>${Number(job.ProcessedItemCount ?? 0).toLocaleString()}</td><td>${Number(job.ImportedItemCount ?? 0).toLocaleString()}</td><td class="mono">${escapeHtml(`${job.S3BucketSource?.S3Bucket ?? ""}${job.S3BucketSource?.S3KeyPrefix ? `/${job.S3BucketSource.S3KeyPrefix}` : ""}`)}</td><td><button class="button link" data-import-detail="${escapeHtml(encodeURIComponent(job.ImportArn))}">View details</button></td></tr>`).join("")}</tbody></table>`;
}

// UI-16: Import from S3 is a page with the documented source fields (Source S3 URL, S3 bucket owner, Import file
// compression, Import file format) and the destination table settings. AWS spreads them over three wizard steps.
async function dynamoImportPage(context) {
  const { main, setChrome, toast } = context; setChrome("dynamodb", ["DynamoDB", "Imports from S3", "Import from S3"]);
  const buckets = await transferBucketOptions();
  const keyTypes = `<option value="S">String</option><option value="N">Number</option><option value="B">Binary</option>`;
  const choice = (name, value, title, text, checked = false, disabled = false) => `<label class="setting-option ${disabled ? "disabled" : ""}"><input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span><strong>${title}</strong><small>${text}</small></span></label>`;
  main.innerHTML = transferPageShell("Import from S3", "Create a new DynamoDB table from data in S3. The import doesn't consume write capacity.", `<section class="card"><div class="card-header"><h2>Import options</h2></div><div class="card-body"><div class="field"><label>Source S3 URL</label><input name="source" list="dynamodb-transfer-buckets" required placeholder="s3://bucket-name/prefix"><datalist id="dynamodb-transfer-buckets">${buckets.map(name => `<option value="s3://${escapeHtml(name)}"></option>`).join("")}</datalist><span class="hint">An S3 export root or a prefix of DynamoDB JSON objects. An absolute file:// URL uses the local files extension when it is enabled.</span></div>${localPrefixField("localPrefix", "Key prefix")}${ownerFields()}<fieldset class="setting-options"><legend>Import file compression</legend>${choice("compression", "NONE", "No compression", "Plain objects.", true)}${choice("compression", "GZIP", "GZIP", "Objects compressed with GZIP, as DynamoDB exports are.")}${choice("compression", "ZSTD", "ZSTD", "Not available locally.", false, true)}</fieldset><fieldset class="setting-options"><legend>Import file format</legend>${choice("format", "DYNAMODB_JSON", "DynamoDB JSON", "One item per line with DynamoDB type descriptors.", true)}${choice("format", "ION", "Amazon Ion", "Not available locally.", false, true)}${choice("format", "CSV", "CSV", "Not available locally.", false, true)}</fieldset></div></section>`
    + `<section class="card"><div class="card-header"><h2>Destination table – new table</h2></div><div class="card-body"><div class="field"><label>Table name</label><input name="table" required pattern="[A-Za-z0-9_.\\-]{3,255}" placeholder="ImportedRecords"></div><div class="field-row"><div class="field"><label>Partition key</label><input name="partition" required placeholder="Enter the partition key name"></div><div class="field"><label>Partition key type</label><select name="partitionType">${keyTypes}</select></div></div><div class="field-row"><div class="field"><label>Sort key <span class="muted small">– optional</span></label><input name="sort" placeholder="Enter the sort key name"></div><div class="field"><label>Sort key type</label><select name="sortType">${keyTypes}</select></div></div><fieldset class="setting-options"><legend>Read/write capacity settings</legend>${choice("capacity", "PAY_PER_REQUEST", "On-demand", "Pay per request. No capacity planning.", true)}${choice("capacity", "PROVISIONED", "Provisioned", "Specify read and write capacity units.")}</fieldset><div class="field-row" data-import-provisioned hidden><div class="field"><label>Read capacity units</label><input name="read" type="number" min="1" value="5"></div><div class="field"><label>Write capacity units</label><input name="write" type="number" min="1" value="5"></div></div><p class="muted small">Secondary indexes, encryption, and tags can be added after the table is created.</p></div></section>`, "Import", "#/dynamodb/imports");
  const form = document.querySelector("#transfer-form");
  bindOwnerFields(form); bindLocalPrefix(form, form.elements.source);
  form.querySelectorAll('input[name="capacity"]').forEach(input => input.addEventListener("change", () => { form.querySelector("[data-import-provisioned]").hidden = form.elements.capacity.value !== "PROVISIONED"; }));
  bindTransferSubmit(context, async () => {
    const { bucket, prefix } = parseTransferUrl(form.elements.source.value, form.elements.localPrefix.value);
    const partition = form.elements.partition.value.trim(); const sort = form.elements.sort.value.trim();
    if (!form.elements.table.value.trim() || !partition) throw new Error("Enter the table name and partition key");
    const definitions = [{ AttributeName: partition, AttributeType: form.elements.partitionType.value }]; const keys = [{ AttributeName: partition, KeyType: "HASH" }];
    if (sort) { definitions.push({ AttributeName: sort, AttributeType: form.elements.sortType.value }); keys.push({ AttributeName: sort, KeyType: "RANGE" }); }
    const provisioned = form.elements.capacity.value === "PROVISIONED";
    await dynamo("ImportTable", { S3BucketSource: { S3Bucket: bucket, ...(prefix ? { S3KeyPrefix: prefix } : {}), ...bucketOwner(form) }, InputFormat: "DYNAMODB_JSON", InputCompressionType: form.elements.compression.value, TableCreationParameters: { TableName: form.elements.table.value.trim(), AttributeDefinitions: definitions, KeySchema: keys, BillingMode: provisioned ? "PROVISIONED" : "PAY_PER_REQUEST", ...(provisioned ? { ProvisionedThroughput: { ReadCapacityUnits: Number(form.elements.read.value), WriteCapacityUnits: Number(form.elements.write.value) } } : {}) } });
    toast("Import started"); await new Promise(resolve => setTimeout(resolve, 80)); location.hash = "#/dynamodb/imports";
  });
}

function bindCreateImport() {
  document.querySelector('[data-action="create-import"]')?.addEventListener("click", () => { location.hash = "#/dynamodb/imports/create"; });
}

async function dynamoImports(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Imports from S3"]); const [ImportSummaryList, environment] = await Promise.all([collectDynamoPages("ListImports", { PageSize: 25 }, "ImportSummaryList", "NextToken", "NextToken"), rest("/_stacksim/api/environment")]); const imports = await Promise.all(ImportSummaryList.map(summary => dynamo("DescribeImport", { ImportArn: summary.ImportArn }).then(result => result.ImportTableDescription)));
  main.innerHTML = `<div class="page-width">${pageHeader("Imports from S3", "Create new DynamoDB tables from S3-compatible DynamoDB JSON data.", `<button class="button refresh" data-action="refresh-imports">↻</button><button class="button primary" data-action="create-import">Import from S3</button>`)}<div class="alert info"><strong>S3 is the primary transfer path</strong><br>Import admission pins immutable source generations, validates export manifests, and checks bucket policy during reads. ${environment.allowLocalFiles ? "The explicit file:// extension is also enabled." : "The file:// extension is disabled."}</div><section class="card"><div class="card-header"><div><h2>Imports <span class="muted">(${imports.length})</span></h2><p class="muted small">Jobs completed or started in the last 90 days.</p></div></div><div class="table-wrap">${importRows(imports)}</div></section></div>`; document.querySelector('[data-action="refresh-imports"]')?.addEventListener("click", context.route); bindCreateImport(context); document.querySelectorAll("[data-import-detail]").forEach(button => button.addEventListener("click", () => { const job = imports.find(item => item.ImportArn === decodeURIComponent(button.dataset.importDetail)); if (!job) return; context.showModal("Import details", `<div class="detail-grid"><dl class="key-value"><dt>Status</dt><dd>${transferStatus(job.ImportStatus)}</dd><dt>Target table</dt><dd>${escapeHtml(job.TableCreationParameters?.TableName ?? "–")}</dd><dt>Processed items</dt><dd>${Number(job.ProcessedItemCount ?? 0).toLocaleString()}</dd><dt>Imported items</dt><dd>${Number(job.ImportedItemCount ?? 0).toLocaleString()}</dd></dl><dl class="key-value"><dt>Format</dt><dd>${escapeHtml(job.InputFormat)}</dd><dt>Compression</dt><dd>${escapeHtml(job.InputCompressionType)}</dd><dt>Errors</dt><dd>${Number(job.ErrorCount ?? 0)}</dd><dt>Completed</dt><dd>${escapeHtml(dynamoDate(job.EndTime))}</dd></dl></div><div class="field"><label>Import ARN</label><textarea class="code-editor" readonly>${escapeHtml(job.ImportArn)}</textarea></div>`, "Close", async () => {}); }));
}

function contributorModeLabel(value) { return value === "THROTTLED_KEYS" ? "Throttled keys only" : "Accessed and throttled keys"; }

function contributorRows(summaries, regional = false) {
  if (!summaries.length) return emptyState("◇", "No tables or global secondary indexes", "Create a table before configuring contributor insights.", '<a class="button primary" href="#/dynamodb/tables">View tables</a>');
  return `<table><thead><tr><th>Resource</th>${regional ? "<th>Table</th>" : ""}<th>Status</th><th>Mode</th><th>Actions</th></tr></thead><tbody>${summaries.map(summary => { const pending = new Set(["ENABLING", "DISABLING"]).has(summary.ContributorInsightsStatus); const enabled = summary.ContributorInsightsStatus === "ENABLED"; const target = encodeURIComponent(JSON.stringify({ TableName: summary.TableName, ...(summary.IndexName ? { IndexName: summary.IndexName } : {}), ContributorInsightsMode: summary.ContributorInsightsMode })); return `<tr><td><strong>${escapeHtml(summary.IndexName ?? summary.TableName)}</strong><br><span class="muted small">${summary.IndexName ? "Global secondary index" : "Table"}</span></td>${regional ? `<td><a href="#/dynamodb/tables/${encodeURIComponent(summary.TableName)}/contributors">${escapeHtml(summary.TableName)}</a></td>` : ""}<td><span class="status ${pending ? "pending" : enabled ? "" : "inactive"}">${escapeHtml(summary.ContributorInsightsStatus)}</span></td><td>${escapeHtml(contributorModeLabel(summary.ContributorInsightsMode))}</td><td class="no-wrap">${pending ? '<button class="button link" data-action="refresh-contributors">Refresh</button>' : enabled ? `<button class="button link" data-contributor-enable="${escapeHtml(target)}">Change mode</button><button class="button link danger" data-contributor-disable="${escapeHtml(target)}">Turn off</button>` : `<button class="button link" data-contributor-enable="${escapeHtml(target)}">Turn on</button>`}</td></tr>`; }).join("")}</tbody></table>`;
}

async function contributorActivity(tableName) {
  const namespace = "StackSim/DynamoDBContributorInsights"; const listed = await Promise.all(["AccessFrequency", "ThrottleFrequency"].map(MetricName => metrics("ListMetrics", { Namespace: namespace, MetricName, Dimensions: [{ Name: "TableName", Value: tableName }] }).then(result => (result.Metrics ?? []).map(metric => ({ metric, MetricName }))))); const definitions = listed.flat().slice(0, 500); if (!definitions.length) return [];
  const end = new Date(); const start = new Date(end.getTime() - 3_600_000); const queryMap = new Map(); const MetricDataQueries = definitions.map((definition, index) => { const Id = `m${index}`; queryMap.set(Id, definition); return { Id, MetricStat: { Metric: definition.metric, Period: 60, Stat: "Sum" } }; }); const output = await metrics("GetMetricData", { StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampAscending", MetricDataQueries }); const rows = new Map();
  for (const result of output.MetricDataResults ?? []) { const definition = queryMap.get(result.Id); if (!definition) continue; const dimensions = Object.fromEntries((definition.metric.Dimensions ?? []).map(dimension => [dimension.Name, dimension.Value])); const key = `${dimensions.GlobalSecondaryIndexName ?? ""}\0${dimensions.ContributorKey}`; const row = rows.get(key) ?? { IndexName: dimensions.GlobalSecondaryIndexName, ContributorKey: dimensions.ContributorKey, AccessFrequency: 0, ThrottleFrequency: 0 }; row[definition.MetricName] = (result.Values ?? []).reduce((sum, value) => sum + Number(value), 0); rows.set(key, row); }
  return [...rows.values()].sort((left, right) => (right.AccessFrequency + right.ThrottleFrequency) - (left.AccessFrequency + left.ThrottleFrequency) || left.ContributorKey.localeCompare(right.ContributorKey));
}

function contributorActivityRows(rows) {
  if (!rows.length) return emptyState("◇", "No key activity in the last hour", "Generate reads, writes, or throttled requests after turning on contributor insights.");
  return `<table><thead><tr><th>Resource</th><th>Contributor key</th><th>Access events</th><th>Throttle events</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.IndexName ?? "Table")}</td><td class="mono">${escapeHtml(row.ContributorKey)}</td><td>${Number(row.AccessFrequency).toLocaleString()}</td><td>${Number(row.ThrottleFrequency).toLocaleString()}</td></tr>`).join("")}</tbody></table>`;
}

async function dynamoContributorInsights(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Contributor insights"]); const summaries = await collectDynamoPages("ListContributorInsights", { MaxResults: 100 }, "ContributorInsightsSummaries", "NextToken", "NextToken");
  main.innerHTML = `<div class="page-width">${pageHeader("Contributor insights", "Identify frequently accessed and throttled keys for tables and global secondary indexes.", '<button class="button refresh" data-action="refresh-contributors">↻</button>')}<div class="alert info"><strong>Shared CloudWatch telemetry</strong><br>The DynamoDB API configuration and generated rule names use provider-compatible shapes. Durable key activity in <span class="mono">StackSim/DynamoDBContributorInsights</span> also backs the managed DynamoDB templates in <a href="#/cloudwatch/contributor-insights">CloudWatch Contributor Insights</a>.</div><section class="card"><div class="card-header"><div><h2>Contributor insights resources <span class="muted">(${summaries.length})</span></h2><p class="muted small">Each table and global secondary index is configured independently.</p></div></div><div class="table-wrap">${contributorRows(summaries, true)}</div></section></div>`; bindContributorActions(context);
}

async function dynamoTableContributorInsightsView(table) {
  const [summaries, activity] = await Promise.all([collectDynamoPages("ListContributorInsights", { TableName: table.TableName, MaxResults: 100 }, "ContributorInsightsSummaries", "NextToken", "NextToken"), contributorActivity(table.TableName)]);
  return `<section class="card contributor-config-card"><div class="card-header"><div><h2>Contributor insights</h2><p class="muted small">Configure the table and each global secondary index independently.</p></div><button class="button refresh" data-action="refresh-contributors">↻</button></div><div class="table-wrap">${contributorRows(summaries)}</div><div class="card-body"><div class="alert info"><strong>Modes and metrics</strong><br>Accessed and throttled keys mode records successful key access plus throttles. Throttled keys only mode records no data while requests remain healthy. Both publish local custom metrics without affecting table capacity.</div></div></section><section class="card contributor-activity-card"><div class="card-header"><div><h2>Top key activity · last hour</h2><p class="muted small">One count per observed item access or throttle event.</p></div><a class="button" href="#/cloudwatch/metrics">View in CloudWatch</a></div><div class="table-wrap">${contributorActivityRows(activity)}</div></section>`;
}

function bindContributorActions(context) {
  const { route, showModal, toast } = context; const target = value => JSON.parse(decodeURIComponent(value)); const refresh = async () => { await new Promise(resolve => setTimeout(resolve, 80)); await route(); }; document.querySelectorAll('[data-action="refresh-contributors"]').forEach(button => button.addEventListener("click", route));
  document.querySelectorAll("[data-contributor-enable]").forEach(button => button.addEventListener("click", () => { const input = target(button.dataset.contributorEnable); showModal(input.ContributorInsightsMode ? "Configure contributor insights" : "Turn on contributor insights", `<div class="field"><label>Resource</label><input value="${escapeHtml(input.IndexName ? `${input.TableName} / ${input.IndexName}` : input.TableName)}" disabled></div><div class="field"><label>Contributor insights mode</label><select name="mode"><option value="ACCESSED_AND_THROTTLED_KEYS" ${input.ContributorInsightsMode !== "THROTTLED_KEYS" ? "selected" : ""}>Accessed and throttled keys</option><option value="THROTTLED_KEYS" ${input.ContributorInsightsMode === "THROTTLED_KEYS" ? "selected" : ""}>Throttled keys only</option></select><span class="hint">The comprehensive mode records successful reads and writes. The cost-focused mode emits data only when capacity enforcement throttles a request.</span></div><div class="alert info"><strong>Plaintext key dimensions</strong><br>Like hosted Contributor Insights, observed primary key values are visible in monitoring data. Oversized local values are replaced with a SHA-256 digest.</div>`, "Save configuration", async data => { await dynamo("UpdateContributorInsights", { TableName: input.TableName, ...(input.IndexName ? { IndexName: input.IndexName } : {}), ContributorInsightsAction: "ENABLE", ContributorInsightsMode: data.get("mode") }); toast("Contributor insights is turning on"); await refresh(); }); }));
  document.querySelectorAll("[data-contributor-disable]").forEach(button => button.addEventListener("click", () => { const input = target(button.dataset.contributorDisable); showModal("Turn off contributor insights", `<div class="alert error"><strong>New key activity will stop being recorded</strong><br>Existing local CloudWatch metrics remain available under their normal retention policy.</div><p>Turn off contributor insights for <strong>${escapeHtml(input.IndexName ? `${input.TableName} / ${input.IndexName}` : input.TableName)}</strong>?</p><div class="field"><label class="checkbox-label"><input type="checkbox" name="acknowledge" value="yes" required> I acknowledge that monitoring will stop for this resource.</label></div>`, "Turn off", async data => { if (data.get("acknowledge") !== "yes") throw new Error("Acknowledge the monitoring change"); await dynamo("UpdateContributorInsights", { TableName: input.TableName, ...(input.IndexName ? { IndexName: input.IndexName } : {}), ContributorInsightsAction: "DISABLE" }); toast("Contributor insights is turning off"); await refresh(); }, false, { danger: true }); }));
}

async function dynamoGlobalTables(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Global tables"]); const tables = await collectDynamoPages("ListGlobalTables", { RegionName: session.region, Limit: 100 }, "GlobalTables", "ExclusiveStartGlobalTableName", "LastEvaluatedGlobalTableName");
  main.innerHTML = `<div class="page-width">${pageHeader("Global tables", "Multi-active DynamoDB tables replicated across local configured Regions.")}<div class="alert info"><strong>Current same-account model</strong><br>Create and remove replicas from a table's <strong>Global tables</strong> tab. The simulator implements multi-Region eventual consistency (MREC); MRSC witnesses and multi-account groups remain explicit dependency boundaries.</div><section class="card"><div class="card-header"><div><h2>Global tables in ${escapeHtml(session.region)} <span class="muted">(${tables.length})</span></h2><p class="muted small">Tables with a replica in the selected Region.</p></div><button class="button refresh" data-action="refresh-global-tables">↻</button></div><div class="table-wrap">${tables.length ? `<table><thead><tr><th>Global table</th><th>Replica Regions</th><th>Consistency</th><th>Actions</th></tr></thead><tbody>${tables.map(table => `<tr><td><a href="#/dynamodb/tables/${encodeURIComponent(table.GlobalTableName)}/global">${escapeHtml(table.GlobalTableName)}</a></td><td>${(table.ReplicationGroup ?? []).map(replica => `<span class="type-tag">${escapeHtml(replica.RegionName)}</span>`).join(" ")}</td><td>MREC</td><td><a class="button link" href="#/dynamodb/tables/${encodeURIComponent(table.GlobalTableName)}/global">Manage replicas</a></td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No global tables in this Region", "Open a table and add a replica from its Global tables tab.", '<a class="button primary" href="#/dynamodb/tables">View tables</a>')}</div></section></div>`;
  document.querySelector('[data-action="refresh-global-tables"]')?.addEventListener("click", context.route);
}

async function dynamoGlobalTableView(table) {
  const replicas = table.Replicas ?? []; if (!table.GlobalTableVersion || !replicas.length) return `<section class="card global-table-card"><div class="card-header"><div><h2>Global table replicas</h2><p class="muted small">Add a Region to make this table multi-active.</p></div><button class="button primary" data-action="add-replica">Create replica</button></div><div class="card-body">${emptyState("◇", "No replica Regions", "This is a standard single-Region table. Create a replica to backfill its current items and start ordered multi-Region replication.")}<div class="alert info"><strong>Local MREC behavior</strong><br>Successful item, batch, transaction, PartiQL, and TTL changes replicate through an ordered durable change log. Conflicts use deterministic per-item last-writer-wins timestamps.</div><div class="alert info"><strong>Advanced consistency boundary</strong><br>MRSC witnesses, multi-account global tables, and KMS replica keys remain dependency blocked and return explicit validation errors.</div></div></section>`;
  const [global, settings] = await Promise.all([dynamo("DescribeGlobalTable", { GlobalTableName: table.TableName }), dynamo("DescribeGlobalTableSettings", { GlobalTableName: table.TableName })]); const description = global.GlobalTableDescription ?? {}; const settingMap = Object.fromEntries((settings.ReplicaSettings ?? []).map(setting => [setting.RegionName, setting]));
  return `<section class="card global-table-card"><div class="card-header"><div><h2>Global table replicas</h2><p class="muted small">Active-active replicas using local multi-Region eventual consistency.</p></div><button class="button primary" data-action="add-replica">Add replica</button></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Global table status</dt><dd><span class="status ${description.GlobalTableStatus === "ACTIVE" ? "" : "pending"}">${escapeHtml(description.GlobalTableStatus ?? "ACTIVE")}</span></dd><dt>Version</dt><dd class="mono">${escapeHtml(table.GlobalTableVersion)}</dd></dl><dl class="key-value"><dt>Consistency mode</dt><dd>Multi-Region eventual (MREC)</dd><dt>Conflict resolution</dt><dd>Per-item last writer wins</dd></dl><dl class="key-value"><dt>Global table ARN</dt><dd class="mono">${escapeHtml(description.GlobalTableArn ?? "–")}</dd><dt>Replica count</dt><dd>${replicas.length}</dd></dl></div><div class="alert info"><strong>Deterministic local replication</strong><br>Changes are appended to an ordered <span class="mono">0600</span> JSONL log, applied without loops, and survive restart. Equal timestamps use a stable Region tie-breaker.</div></div><div class="table-wrap"><table><thead><tr><th>Region</th><th>Status</th><th>Capacity mode</th><th>Table class</th><th>Actions</th></tr></thead><tbody>${replicas.map(replica => { const setting = settingMap[replica.RegionName] ?? {}; const local = replica.RegionName === session.region; return `<tr><td><strong>${escapeHtml(replica.RegionName)}</strong>${local ? ' <span class="type-tag">CURRENT</span>' : ""}</td><td><span class="status ${replica.ReplicaStatus === "ACTIVE" ? "" : "pending"}">${escapeHtml(replica.ReplicaStatus ?? "ACTIVE")}</span></td><td>${escapeHtml(setting.ReplicaBillingModeSummary?.BillingMode ?? table.BillingModeSummary?.BillingMode ?? "PROVISIONED")}</td><td>${escapeHtml(setting.ReplicaTableClassSummary?.TableClass ?? "STANDARD")}</td><td>${local ? '<span class="muted">Manage from another replica</span>' : `<button class="button link danger" data-remove-replica="${escapeHtml(replica.RegionName)}">Remove</button>`}</td></tr>`; }).join("")}</tbody></table></div></section><section class="card"><div class="card-header"><h2>Replication boundaries</h2></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Writes</dt><dd>Every replica accepts local writes.</dd><dt>Backfill</dt><dd>Existing items copy when a replica is created.</dd></dl><dl class="key-value"><dt>MRSC and witnesses</dt><dd>Dependency blocked</dd><dt>Multi-account groups</dt><dd>Dependency blocked</dd></dl><dl class="key-value"><dt>Replica KMS keys</dt><dd>Dependency blocked until KMS</dd><dt>Replication errors</dt><dd>Reported in replica status</dd></dl></div></div></section>`;
}

function bindGlobalTable(context, table) {
  const { confirmDeletion, route, showModal, toast } = context; const add = () => showModal(table.GlobalTableVersion ? "Add global table replica" : "Create global table replica", `<div class="field"><label>Replica Region</label><input name="region" required pattern="[a-z]{2}(-gov)?-[a-z]+-[0-9]" placeholder="us-east-1"><span class="hint">Enter a Region other than ${escapeHtml(session.region)}. The target table is created and current items are backfilled.</span></div><div class="alert info"><strong>Multi-Region eventual consistency</strong><br>Every replica can accept writes. Conflicting item versions converge using a deterministic last-writer-wins timestamp.</div><div class="alert info"><strong>Local environment</strong><br>This creates another Region namespace in the same simulator account. No external resources or network traffic are created.</div>`, table.GlobalTableVersion ? "Add replica" : "Create replica", async data => { const region = String(data.get("region") ?? ""); if (region === session.region) throw new Error("Choose a different replica Region"); await dynamo("UpdateTable", { TableName: table.TableName, ReplicaUpdates: [{ Create: { RegionName: region } }], MultiRegionConsistency: "EVENTUAL" }); toast("Global table replica creation started"); await new Promise(resolve => setTimeout(resolve, 80)); await route(); });
  document.querySelector('[data-action="add-replica"]')?.addEventListener("click", add);
  document.querySelectorAll("[data-remove-replica]").forEach(button => button.addEventListener("click", () => confirmDeletion(button.dataset.removeReplica, `Remove and delete the ${button.dataset.removeReplica} replica? The remaining table data continues to exist.`, async () => { await dynamo("UpdateTable", { TableName: table.TableName, ReplicaUpdates: [{ Delete: { RegionName: button.dataset.removeReplica } }] }); toast("Replica removal started"); await new Promise(resolve => setTimeout(resolve, 80)); await route(); })));
}

function defaultTablePolicy(table) {
  const accountId = table.TableArn.split(":")[4] ?? "000000000000";
  return { Version: "2012-10-17", Statement: [{ Sid: "AllowAccountRead", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan"], Resource: [table.TableArn, `${table.TableArn}/index/*`] }] };
}

function resourcePolicySignals(document) {
  const statements = Array.isArray(document?.Statement) ? document.Statement : document?.Statement ? [document.Statement] : [];
  const values = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
  const principals = statement => typeof statement.Principal === "object" && statement.Principal !== null ? Object.values(statement.Principal).flatMap(values) : values(statement.Principal);
  const broad = statements.some(statement => principals(statement).includes("*"));
  const managementDeny = statements.some(statement => statement.Effect === "Deny" && values(statement.Action).some(action => /^dynamodb:(?:\*|PutResourcePolicy|DeleteResourcePolicy)$/i.test(action)));
  return { broad, managementDeny };
}

async function dynamoPermissionsView(table) {
  const attached = await rest(`/_stacksim/api/dynamodb/resource-policy?resourceArn=${encodeURIComponent(table.TableArn)}`); const hasPolicy = Boolean(attached.Policy && attached.RevisionId);
  let document = defaultTablePolicy(table); if (attached?.Policy) try { document = JSON.parse(attached.Policy); } catch {}
  const signals = resourcePolicySignals(document); const effective = hasPolicy
    ? signals.managementDeny ? '<div class="alert error"><strong>Policy management can be denied</strong><br>This document contains an explicit deny that can remove future update access. Saving requires the acknowledgement below; the account root can still delete the policy.</div>' : signals.broad ? '<div class="alert error"><strong>Broad principal detected</strong><br>At least one statement applies to every principal. Review actions, resources, and conditions before saving.</div>' : '<div class="alert info"><strong>Identity and resource permissions are combined</strong><br>A same-account resource allow can grant access without an identity allow. Any explicit deny still wins.</div>'
    : '<div class="alert info"><strong>No resource-based policy attached</strong><br>Effective table access currently comes from identity policies. Save the starter document to add a resource grant.</div>';
  return `<div class="test-layout policy-layout"><section class="card policy-editor-card" data-policy-revision="${escapeHtml(attached?.RevisionId ?? "")}"><div class="card-header"><div><h2>Resource-based policy</h2><p class="muted small">JSON policy attached to this table and evaluated for its indexes.</p></div><span class="status ${hasPolicy ? "" : "inactive"}">${hasPolicy ? "Attached" : "Not attached"}</span></div><div class="card-body">${effective}<div class="field"><label for="dynamodb-resource-policy">Policy document</label><textarea id="dynamodb-resource-policy" class="code-editor" spellcheck="false" style="min-height:240px">${escapeHtml(JSON.stringify(document, null, 2))}</textarea><span class="hint"><span id="dynamodb-policy-size">0</span> of 20,480 bytes. Whitespace counts toward the service limit.</span></div><div class="alert info policy-validation" role="status"><strong>Ready to validate</strong><br>Validate locally before saving the policy through PutResourcePolicy.</div><label class="checkbox-label policy-lockout"><input type="checkbox" id="confirm-policy-lockout"> Confirm removal of my future resource-policy update access if this document explicitly denies it.</label><div class="actions policy-actions"><button class="button" type="button" data-action="format-policy">Format JSON</button><button class="button" type="button" data-action="validate-policy">Validate</button>${hasPolicy ? '<button class="button danger" type="button" data-action="delete-policy">Delete policy</button>' : ""}<button class="button primary" type="button" data-action="save-policy">${hasPolicy ? "Save changes" : "Create policy"}</button></div></div></section><aside><section class="card"><div class="card-header"><h2>Policy details</h2></div><div class="card-body"><dl class="key-value"><dt>Revision ID</dt><dd class="mono" data-policy-revision-value>${escapeHtml(attached?.RevisionId ?? "–")}</dd><dt>Resource ARN</dt><dd class="mono">${escapeHtml(table.TableArn)} <button class="button" data-copy="${escapeHtml(table.TableArn)}">Copy</button></dd><dt>Index resource pattern</dt><dd class="mono">${escapeHtml(`${table.TableArn}/index/*`)}</dd></dl><p class="muted small">Use the current revision for conditional saves and deletes. Mutating the same resource policy again within 15 seconds is rejected.</p></div></section><section class="card"><div class="card-header"><h2>Effective access</h2></div><div class="card-body"><dl class="key-value"><dt>Same account</dt><dd>Identity allow or resource allow can grant access.</dd><dt>Cross account</dt><dd>Both identity and resource policies must allow access.</dd><dt>Explicit deny</dt><dd>Always takes precedence across both policy types.</dd><dt>Indexes</dt><dd>Use explicit table index ARNs in this table policy.</dd></dl><div class="alert info"><strong>Deterministic local reads</strong><br>Policy changes are immediately visible to GetResourcePolicy locally; hosted policy reads are eventually consistent.</div></div></section></aside></div>`;
}

function bindTablePermissions(context, table) {
  const { confirmDeletion, route, showError, toast } = context; const editor = document.querySelector("#dynamodb-resource-policy"); const size = document.querySelector("#dynamodb-policy-size"); const validation = document.querySelector(".policy-validation"); const revision = document.querySelector(".policy-editor-card")?.dataset.policyRevision || undefined;
  const updateSize = () => { const bytes = new TextEncoder().encode(editor.value).length; size.textContent = bytes.toLocaleString(); size.closest(".hint").classList.toggle("error-text", bytes > 20 * 1024); return bytes; };
  const validate = () => { const bytes = updateSize(); if (bytes > 20 * 1024) throw new Error("Policy exceeds the 20 KB limit"); let document; try { document = JSON.parse(editor.value); } catch { throw new Error("Policy must contain valid JSON"); } const statements = Array.isArray(document?.Statement) ? document.Statement : document?.Statement ? [document.Statement] : []; if (!statements.length) throw new Error("Policy must contain at least one statement"); if (statements.some(statement => !["Allow", "Deny"].includes(statement?.Effect) || !statement.Principal && !statement.NotPrincipal || !statement.Action && !statement.NotAction || !statement.Resource && !statement.NotResource)) throw new Error("Every statement needs Effect, Principal, Action, and Resource (or their Not variants)"); const signals = resourcePolicySignals(document); validation.className = `alert ${signals.broad || signals.managementDeny ? "error" : "success"} policy-validation`; validation.innerHTML = signals.managementDeny ? "<strong>Valid JSON with a policy-management deny</strong><br>Acknowledge possible removal of your future update access before saving." : signals.broad ? "<strong>Valid JSON with a broad principal</strong><br>Review statements that use Principal * before saving." : "<strong>Policy structure is valid</strong><br>The service will perform full action, ARN, principal, and condition validation when you save."; return document; };
  editor.addEventListener("input", updateSize); updateSize();
  document.querySelector('[data-action="format-policy"]')?.addEventListener("click", () => { try { editor.value = JSON.stringify(JSON.parse(editor.value), null, 2); updateSize(); setDirty(true); } catch (error) { showError(error); } });
  document.querySelector('[data-action="validate-policy"]')?.addEventListener("click", () => { try { validate(); toast("Resource policy is valid"); } catch (error) { validation.className = "alert error policy-validation"; validation.innerHTML = `<strong>Validation failed</strong><br>${escapeHtml(error.message)}`; showError(error); } });
  document.querySelector('[data-action="save-policy"]')?.addEventListener("click", async () => { const button = document.querySelector('[data-action="save-policy"]'); button.disabled = true; try { validate(); await dynamo("PutResourcePolicy", { ResourceArn: table.TableArn, Policy: editor.value, ExpectedRevisionId: revision ?? "NO_POLICY", ConfirmRemoveSelfResourceAccess: document.querySelector("#confirm-policy-lockout").checked }); setDirty(false, "page"); toast(revision ? "Resource policy updated" : "Resource policy created"); await route(); } catch (error) { showError(error); } finally { if (button.isConnected) button.disabled = false; } });
  document.querySelector('[data-action="delete-policy"]')?.addEventListener("click", () => confirmDeletion(table.TableName, `Delete the resource-based policy from ${table.TableName}? Identity policies will continue to apply.`, async () => { await dynamo("DeleteResourcePolicy", { ResourceArn: table.TableArn, ExpectedRevisionId: revision }); setDirty(false, "page"); toast("Resource policy deleted"); }));
}

function streamViewLabel(value) {
  return ({ KEYS_ONLY: "Key attributes only", NEW_IMAGE: "New image", OLD_IMAGE: "Old image", NEW_AND_OLD_IMAGES: "New and old images" })[value] ?? "–";
}

function kinesisPrecisionLabel(value) {
  return value === "MICROSECOND" ? "Microsecond" : value === "MILLISECOND" ? "Millisecond" : "–";
}

function kinesisDestinationCard(destination) {
  const connected = Boolean(destination); const status = destination?.DestinationStatus ?? "DISABLED"; const changing = ["ENABLING", "DISABLING", "UPDATING"].includes(status); const active = status === "ACTIVE";
  const actions = active ? '<button class="button" data-action="edit-kinesis-destination">Change precision</button><button class="button danger" data-action="disable-kinesis-destination">Turn off</button>' : changing ? '<button class="button" disabled>Change in progress</button>' : '<button class="button primary" data-action="enable-kinesis-destination">Turn on</button>';
  return `<section class="card kinesis-destination-card" data-kinesis-destination="${escapeHtml(encodeURIComponent(JSON.stringify(destination ?? null)))}"><div class="card-header"><div><h2>Amazon Kinesis data stream details</h2><p class="muted small">Replicate item changes to one Kinesis data stream in this account and Region.</p></div><div class="actions">${actions}</div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Destination status</dt><dd><span class="status ${changing ? "pending" : active ? "" : "inactive"}">${connected ? escapeHtml(({ ACTIVE: "Active", DISABLED: "Disabled", ENABLING: "Turning on", DISABLING: "Turning off", UPDATING: "Updating", ENABLE_FAILED: "Failed" })[status] ?? status) : "Not connected"}</span></dd><dt>Timestamp precision</dt><dd>${escapeHtml(kinesisPrecisionLabel(destination?.ApproximateCreationDateTimePrecision))}</dd></dl><dl class="key-value"><dt>Kinesis stream ARN</dt><dd class="mono">${escapeHtml(destination?.StreamArn ?? "–")}</dd><dt>Status detail</dt><dd>${escapeHtml(destination?.DestinationStatusDescription ?? "No destination is configured.")}</dd></dl></div><div class="alert info"><strong>Configuration only</strong><br>No Kinesis service is running locally, so table writes do not deliver records. This setting persists for SDK and console learning.</div></div></section>`;
}

async function dynamoStreamsView(table) {
  const enabled = table.StreamSpecification?.StreamEnabled === true; const view = table.StreamSpecification?.StreamViewType; const [ExportSummaries, kinesis, mapped] = await Promise.all([collectDynamoPages("ListExports", { TableArn: table.TableArn, MaxResults: 25 }, "ExportSummaries", "NextToken", "NextToken"), dynamo("DescribeKinesisStreamingDestination", { TableName: table.TableName }), enabled ? rest(`/2015-03-31/event-source-mappings?EventSourceArn=${encodeURIComponent(table.LatestStreamArn)}&MaxItems=100`) : Promise.resolve({ EventSourceMappings: [] })]); const mappings = mapped.EventSourceMappings ?? []; const exports = await Promise.all(ExportSummaries.map(summary => dynamo("DescribeExport", { ExportArn: summary.ExportArn }).then(result => result.ExportDescription))); const exportSection = `<section class="card export-card"><div class="card-header"><div><h2>Exports to S3 <span class="muted">(${exports.length})</span></h2><p class="muted small">Point-in-time table exports in DynamoDB JSON with provider-compatible manifests.</p></div><button class="button primary" data-action="create-export">Export to S3</button></div><div class="table-wrap">${exportRows(exports)}</div><div class="card-body"><div class="alert info"><strong>S3-compatible transfer</strong><br>Exports require PITR and an authorized local S3 bucket. The opted-in file:// extension is also accepted.</div></div></section>`; const destination = kinesis.KinesisDataStreamDestinations?.[0];
  // AWS has no in-place view-type change: turn the stream off, then turn it on with another view type.
  const actions = enabled ? '<button class="button" data-action="disable-stream">Turn off</button>' : '<button class="button primary" data-action="enable-stream">Turn on</button>';
  const triggerRows = mappings.map(mapping => { const target = mapping.FunctionArn?.split(":function:")[1]?.split(":")[0] ?? mapping.FunctionArn; return `<tr><td><a href="#/lambda/functions/${encodeURIComponent(target)}">${escapeHtml(target)}</a></td><td><span class="status ${mapping.State === "Disabled" ? "inactive" : ""}">${escapeHtml(mapping.State)}</span></td><td>${mapping.BatchSize} · ${mapping.MaximumBatchingWindowInSeconds}s</td><td>${escapeHtml(mapping.StartingPosition)}</td><td>${escapeHtml(mapping.LastProcessingResult || "No records processed")}</td><td><a class="button link" href="#/lambda/functions/${encodeURIComponent(target)}">View mapping</a></td></tr>`; }).join("");
  const triggerContent = !enabled ? '<div class="card-body"><p class="muted">Turn on the DynamoDB stream before creating a Lambda trigger.</p></div>' : mappings.length ? `<div class="table-wrap"><table><thead><tr><th>Function</th><th>State</th><th>Batch</th><th>Starting position</th><th>Last result</th><th>Actions</th></tr></thead><tbody>${triggerRows}</tbody></table></div><div class="card-body"><div class="alert info"><strong>Durable Lambda consumption</strong><br>Open the function overview to edit, pause, or delete a mapping and inspect its checkpoint status.</div></div>` : `<div class="table-wrap">${emptyState("↯", "No Lambda triggers", "Create an event source mapping for this enabled stream.")}</div>`;
  return `<section class="card stream-card"><div class="card-header"><div><h2>DynamoDB stream details</h2><p class="muted small">Capture an ordered record whenever an item changes.</p></div><div class="actions">${actions}</div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Stream status</dt><dd><span class="status ${enabled ? "" : "inactive"}">${enabled ? "On" : "Off"}</span></dd><dt>View type</dt><dd>${escapeHtml(streamViewLabel(view))}</dd></dl><dl class="key-value"><dt>Latest stream label</dt><dd class="mono">${escapeHtml(table.LatestStreamLabel ?? "–")}</dd><dt>Latest stream ARN</dt><dd class="mono">${escapeHtml(table.LatestStreamArn ?? "–")}</dd></dl></div><div class="alert info"><strong>Local stream behavior</strong><br>One deterministic shard preserves successful single-item, batch, transaction, PartiQL, and TTL mutations. Signed iterators expire after 15 minutes; records default to 24-hour retention.</div></div></section>${kinesisDestinationCard(destination)}<section class="card trigger-card"><div class="card-header"><div><h2>Lambda triggers <span class="muted">(${mappings.length})</span></h2><p class="muted small">Invoke a function from batches of records in this DynamoDB stream.</p></div><button class="button primary" data-action="create-stream-trigger" ${enabled ? "" : "disabled"}>Create trigger</button></div>${triggerContent}</section>${exportSection}`;
}

function bindTableStreams(context, table) {
  const { showModal, toast } = context; const enabled = table.StreamSpecification?.StreamEnabled === true; const current = table.StreamSpecification?.StreamViewType ?? "NEW_AND_OLD_IMAGES"; const destination = JSON.parse(decodeURIComponent(document.querySelector(".kinesis-destination-card")?.dataset.kinesisDestination ?? encodeURIComponent("null")));
  const viewField = value => `<fieldset class="setting-options"><legend>View type</legend>${[["KEYS_ONLY","Key attributes only","Only the key attributes of the modified item."],["NEW_IMAGE","New image","The entire item, as it appears after it was modified."],["OLD_IMAGE","Old image","The entire item, as it appeared before it was modified."],["NEW_AND_OLD_IMAGES","New and old images","Both the new and the old images of the item."]].map(([option, label, text]) => `<label class="setting-option"><input type="radio" name="view" value="${option}" ${value === option ? "checked" : ""}><span><strong>${label}</strong><small>${text}</small></span></label>`).join("")}</fieldset>`;
  document.querySelector('[data-action="enable-stream"]')?.addEventListener("click", () => showModal("Turn on DynamoDB stream", viewField(current), "Turn on stream", async data => { await dynamo("UpdateTable", { TableName: table.TableName, StreamSpecification: { StreamEnabled: true, StreamViewType: data.get("view") } }); toast("DynamoDB stream is turning on"); }));
  document.querySelector('[data-action="disable-stream"]')?.addEventListener("click", () => showModal("Turn off DynamoDB stream", `<div class="alert error"><strong>New item changes will stop being captured</strong><br>The current descriptor remains readable only through its local retention window.</div><p>Turn off the stream for <strong>${escapeHtml(table.TableName)}</strong>?</p><div class="field"><label class="checkbox-label"><input type="checkbox" name="acknowledge" value="yes" required> I acknowledge that Lambda triggers would stop receiving new records.</label></div>`, "Turn off", async data => { if (data.get("acknowledge") !== "yes") throw new Error("Acknowledge the effect of turning off the stream"); await dynamo("UpdateTable", { TableName: table.TableName, StreamSpecification: { StreamEnabled: false } }); toast("DynamoDB stream is turning off"); }, false, { danger: true }));
  const precisionField = value => `<div class="field"><label>Approximate creation time precision</label><select name="precision"><option value="MICROSECOND" ${value !== "MILLISECOND" ? "selected" : ""}>Microsecond</option><option value="MILLISECOND" ${value === "MILLISECOND" ? "selected" : ""}>Millisecond</option></select><span class="hint">Controls timestamp precision in the stored destination configuration.</span></div>`;
  document.querySelector('[data-action="enable-kinesis-destination"]')?.addEventListener("click", () => showModal("Turn on Amazon Kinesis data stream", `<div class="field"><label>Destination Kinesis data stream ARN</label><input name="streamArn" required placeholder="arn:aws:kinesis:${escapeHtml(session.region)}:000000000000:stream/learning-events"><span class="hint">The stream must use this simulator account and Region.</span></div>${precisionField(destination?.ApproximateCreationDateTimePrecision)}<div class="alert info"><strong>Configuration only</strong><br>The destination is persisted, but no Kinesis service is running and no table records are delivered.</div>`, "Turn on", async data => { await dynamo("EnableKinesisStreamingDestination", { TableName: table.TableName, StreamArn: data.get("streamArn"), EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: data.get("precision") } }); toast("Kinesis destination is being enabled"); await new Promise(resolve => setTimeout(resolve, 80)); }));
  document.querySelector('[data-action="edit-kinesis-destination"]')?.addEventListener("click", () => showModal("Change Kinesis timestamp precision", `<div class="field"><label>Kinesis data stream ARN</label><input value="${escapeHtml(destination?.StreamArn ?? "")}" disabled></div>${precisionField(destination?.ApproximateCreationDateTimePrecision)}<div class="alert info"><strong>Configuration only</strong><br>This changes the stored descriptor. It does not start local record delivery.</div>`, "Save changes", async data => { if (data.get("precision") === destination?.ApproximateCreationDateTimePrecision) throw new Error("Choose a different timestamp precision"); await dynamo("UpdateKinesisStreamingDestination", { TableName: table.TableName, StreamArn: destination.StreamArn, UpdateKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: data.get("precision") } }); toast("Kinesis destination is updating"); await new Promise(resolve => setTimeout(resolve, 80)); }));
  document.querySelector('[data-action="disable-kinesis-destination"]')?.addEventListener("click", () => showModal("Turn off Kinesis data stream destination", `<div class="alert error"><strong>The stored destination becomes inactive</strong><br>No local records are delivered today; this action changes the modeled configuration status.</div><p>Turn off the destination for <strong>${escapeHtml(table.TableName)}</strong>?</p><div class="field"><label class="checkbox-label"><input type="checkbox" name="acknowledge" value="yes" required> I acknowledge that this Kinesis destination will be disabled.</label></div>`, "Turn off", async data => { if (data.get("acknowledge") !== "yes") throw new Error("Acknowledge the effect of turning off the destination"); await dynamo("DisableKinesisStreamingDestination", { TableName: table.TableName, StreamArn: destination.StreamArn }); toast("Kinesis destination is being disabled"); await new Promise(resolve => setTimeout(resolve, 80)); }, false, { danger: true }));
  document.querySelector('[data-action="create-stream-trigger"]')?.addEventListener("click", async () => { const functions = (await rest("/2015-03-31/functions")).Functions ?? []; if (!functions.length) return showModal("Create trigger", '<div class="alert warning"><strong>No Lambda functions</strong><br>Create a function before connecting this stream.</div><p><a href="#/lambda/functions">Open Lambda functions</a></p>', "Close", async () => undefined, false, { refreshAfterSubmit: false }); const targets = functions.map(fn => ({ value: fn.FunctionArn, label: `${fn.FunctionName} · $LATEST` })); showModal("Create Lambda trigger", eventSourceMappingForm({ sources: [{ name: table.TableName, arn: table.LatestStreamArn, view: table.StreamSpecification.StreamViewType }], targets, selectedSourceArn: table.LatestStreamArn }), "Create trigger", async data => { await rest("/2015-03-31/event-source-mappings", "POST", eventSourceMappingInput(data)); toast("Lambda trigger created"); }, true); });
  if (!enabled) document.querySelector('[data-action="create-stream-trigger"]')?.setAttribute("disabled", "");
  bindCreateExport(context, [table.TableName], table.TableName); const encoded = [...document.querySelectorAll("[data-export-detail]")].map(button => decodeURIComponent(button.dataset.exportDetail)); Promise.all(encoded.map(ExportArn => dynamo("DescribeExport", { ExportArn }).then(result => result.ExportDescription))).then(exports => bindExportDetails(context, exports));
}

function dynamoIndexesView(table) {
  const indexes = [...(table.LocalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "Local" })), ...(table.GlobalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "Global" }))];
  return `<section class="card"><div class="card-header"><h2>Secondary indexes</h2><button class="button primary" data-action="create-index">Create index</button></div><div class="table-wrap">${indexes.length ? `<table><thead><tr><th>Index name</th><th>Type</th><th>Partition key</th><th>Sort key</th><th>Projection</th><th>Status</th><th>Actions</th></tr></thead><tbody>${indexes.map(index => `<tr><td>${escapeHtml(index.IndexName)}</td><td>${index.kind}</td><td>${escapeHtml(index.KeySchema.find(key => key.KeyType === "HASH")?.AttributeName)}</td><td>${escapeHtml(index.KeySchema.find(key => key.KeyType === "RANGE")?.AttributeName ?? "–")}</td><td>${escapeHtml(index.Projection.ProjectionType)}</td><td><span class="status">${escapeHtml(index.IndexStatus ?? "ACTIVE")}</span></td><td>${index.kind === "Global" ? `<button class="button link" data-delete-index="${escapeHtml(index.IndexName)}">Delete</button>` : "Created with table"}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No secondary indexes", "Create a global secondary index to query data with another key.")}</div></section>`;
}

async function dynamoCapacityView(table) {
  const mode = table.BillingModeSummary?.BillingMode ?? "PROVISIONED"; const provisioned = table.ProvisionedThroughput ?? {}; const onDemand = table.OnDemandThroughput ?? {}; const warm = table.WarmThroughput; const auto = await dynamo("DescribeTableReplicaAutoScaling", { TableName: table.TableName }); const replica = auto.TableAutoScalingDescription?.Replicas?.find(item => item.RegionName === session.region) ?? auto.TableAutoScalingDescription?.Replicas?.[0];
  const autoRead = replica?.ReplicaProvisionedReadCapacityAutoScalingSettings; const autoWrite = replica?.ReplicaProvisionedWriteCapacityAutoScalingSettings;
  const scalingSummary = (label, setting) => `<dl class="key-value"><dt>${label} auto scaling</dt><dd>${setting && setting.AutoScalingDisabled !== true ? "On" : "Off"}</dd><dt>${label} range</dt><dd>${setting && setting.AutoScalingDisabled !== true ? `${setting.MinimumUnits}–${setting.MaximumUnits}` : "–"}</dd><dt>${label} target utilization</dt><dd>${setting && setting.AutoScalingDisabled !== true ? `${setting.ScalingPolicies?.[0]?.TargetTrackingScalingPolicyConfiguration?.TargetValue ?? "–"}%` : "–"}</dd></dl>`;
  return `<section class="card capacity-card" data-auto-scaling="${escapeHtml(encodeURIComponent(JSON.stringify({ read: autoRead ?? null, write: autoWrite ?? null })))}"><div class="card-header"><div><h2>Read/write capacity</h2><p class="muted small">Capacity mode and throughput settings for the table.</p></div><button class="button primary" data-action="edit-capacity">Edit</button></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Capacity mode</dt><dd>${mode === "PAY_PER_REQUEST" ? "On-demand" : "Provisioned"}</dd><dt>${mode === "PROVISIONED" ? "Read capacity units" : "Maximum read request units"}</dt><dd>${mode === "PROVISIONED" ? provisioned.ReadCapacityUnits ?? 0 : onDemand.MaxReadRequestUnits ?? "Unlimited"}</dd><dt>${mode === "PROVISIONED" ? "Write capacity units" : "Maximum write request units"}</dt><dd>${mode === "PROVISIONED" ? provisioned.WriteCapacityUnits ?? 0 : onDemand.MaxWriteRequestUnits ?? "Unlimited"}</dd></dl><dl class="key-value"><dt>Warm throughput (read)</dt><dd>${warm?.ReadUnitsPerSecond ?? "Service default"} units/second</dd><dt>Warm throughput (write)</dt><dd>${warm?.WriteUnitsPerSecond ?? "Service default"} units/second${warm?.Status ? ` · ${escapeHtml(warm.Status)}` : ""}</dd></dl></div><div class="alert info capacity-local-note"><strong>Local capacity behavior</strong><br>Capacity is descriptive by default. Set <span class="mono">STACKSIM_DDB_ENFORCE_CAPACITY=true</span> to enable deterministic token-bucket throttling for learning.</div></div></section><section class="card auto-scaling-card"><div class="card-header"><div><h2>Auto scaling</h2><p class="muted small">Target-tracking settings for provisioned read and write capacity.</p></div><button class="button" data-action="configure-auto-scaling" ${mode === "PROVISIONED" ? "" : "disabled"}>Edit</button></div><div class="card-body">${mode !== "PROVISIONED" ? `<p class="muted">Auto scaling applies only to provisioned capacity mode.</p>` : `<div class="detail-grid">${scalingSummary("Read", autoRead)}${scalingSummary("Write", autoWrite)}</div>`}<p class="muted small">The simulator stores and returns these settings but does not call Application Auto Scaling.</p></div></section>`;
}

function bindCapacity(context, table) {
  const { showModal, toast } = context; const mode = table.BillingModeSummary?.BillingMode ?? "PROVISIONED"; const provisioned = table.ProvisionedThroughput ?? {}; const onDemand = table.OnDemandThroughput ?? {}; const warm = table.WarmThroughput ?? {};
  const hasMax = onDemand.MaxReadRequestUnits !== undefined || onDemand.MaxWriteRequestUnits !== undefined;
  // The dialog shows only the fields that apply to the selected mode, so switching to on-demand never carries provisioned units over as a throughput cap.
  document.querySelector('[data-action="edit-capacity"]')?.addEventListener("click", () => {
    showModal("Edit read/write capacity", `<fieldset class="setting-options"><legend>Capacity mode</legend><label class="setting-option"><input type="radio" name="mode" value="PAY_PER_REQUEST" ${mode === "PAY_PER_REQUEST" ? "checked" : ""}><span><strong>On-demand</strong><small>Pay per request. No capacity planning.</small></span></label><label class="setting-option"><input type="radio" name="mode" value="PROVISIONED" ${mode === "PROVISIONED" ? "checked" : ""}><span><strong>Provisioned</strong><small>Specify read and write capacity units.</small></span></label></fieldset><div data-capacity-section="PAY_PER_REQUEST"><h3>Maximum table throughput <span class="muted small">– optional</span></h3><label class="checkbox-label"><input type="checkbox" name="onDemandMax" value="yes" ${hasMax ? "checked" : ""}> Set a maximum number of read and write request units per second</label><div class="field-row" data-on-demand-max-fields ${hasMax ? "" : "hidden"}><div class="field"><label>Maximum read request units</label><input name="maxRead" type="number" min="1" value="${onDemand.MaxReadRequestUnits ?? ""}" placeholder="Unlimited"></div><div class="field"><label>Maximum write request units</label><input name="maxWrite" type="number" min="1" value="${onDemand.MaxWriteRequestUnits ?? ""}" placeholder="Unlimited"></div></div></div><div data-capacity-section="PROVISIONED"><div class="field-row"><div class="field"><label>Read capacity units</label><input name="read" type="number" min="1" value="${mode === "PROVISIONED" ? provisioned.ReadCapacityUnits ?? 5 : 5}"></div><div class="field"><label>Write capacity units</label><input name="write" type="number" min="1" value="${mode === "PROVISIONED" ? provisioned.WriteCapacityUnits ?? 5 : 5}"></div></div><p class="muted small">Auto scaling for provisioned capacity is configured in the Auto scaling card.</p></div><h3>Warm throughput <span class="muted small">– optional</span></h3><div class="field-row"><div class="field"><label>Warm read units per second</label><input name="warmRead" type="number" min="1" value="${warm.ReadUnitsPerSecond ?? ""}"></div><div class="field"><label>Warm write units per second</label><input name="warmWrite" type="number" min="1" value="${warm.WriteUnitsPerSecond ?? ""}"></div></div>`, "Save changes", async data => {
      const selected = String(data.get("mode")); const request = { TableName: table.TableName, ...(selected !== mode ? { BillingMode: selected } : {}) };
      if (selected === "PROVISIONED") { const read = Number(data.get("read")); const write = Number(data.get("write")); if (!read || !write) throw new Error("Read and write capacity units are required in provisioned mode"); request.ProvisionedThroughput = { ReadCapacityUnits: read, WriteCapacityUnits: write }; }
      else if (data.get("onDemandMax") === "yes") { const maxRead = Number(data.get("maxRead")); const maxWrite = Number(data.get("maxWrite")); const max = {}; if (maxRead) max.MaxReadRequestUnits = maxRead; else if (onDemand.MaxReadRequestUnits !== undefined) max.MaxReadRequestUnits = -1; if (maxWrite) max.MaxWriteRequestUnits = maxWrite; else if (onDemand.MaxWriteRequestUnits !== undefined) max.MaxWriteRequestUnits = -1; if (Object.keys(max).length) request.OnDemandThroughput = max; }
      else if (hasMax) request.OnDemandThroughput = { MaxReadRequestUnits: -1, MaxWriteRequestUnits: -1 };
      const warmRead = Number(data.get("warmRead")); const warmWrite = Number(data.get("warmWrite")); if (warmRead || warmWrite) { if (!warmRead || !warmWrite) throw new Error("Enter both warm throughput values"); request.WarmThroughput = { ReadUnitsPerSecond: warmRead, WriteUnitsPerSecond: warmWrite }; }
      await dynamo("UpdateTable", request); toast("Capacity settings are updating");
    }, true);
    const dialog = document.querySelector("dialog"); const sync = () => { const current = dialog.querySelector('input[name="mode"]:checked')?.value; dialog.querySelectorAll("[data-capacity-section]").forEach(section => { section.hidden = section.dataset.capacitySection !== current; }); dialog.querySelector("[data-on-demand-max-fields]").hidden = !dialog.querySelector('input[name="onDemandMax"]').checked; };
    dialog.querySelectorAll('input[name="mode"], input[name="onDemandMax"]').forEach(input => input.addEventListener("change", sync)); sync();
  });
  let stored = { read: null, write: null }; try { stored = JSON.parse(decodeURIComponent(document.querySelector(".capacity-card")?.dataset.autoScaling ?? "%7B%7D")); } catch {}
  const scalingFields = (side, label, current) => { const on = Boolean(current) && current.AutoScalingDisabled !== true; const target = current?.ScalingPolicies?.[0]?.TargetTrackingScalingPolicyConfiguration?.TargetValue; return `<h3>${label} capacity</h3><fieldset class="radio-list"><legend class="sr-only">${label} auto scaling</legend><label class="radio-label"><input type="radio" name="${side}Scaling" value="on" ${on ? "checked" : ""}> Auto scaling on</label><label class="radio-label"><input type="radio" name="${side}Scaling" value="off" ${on ? "" : "checked"}> Auto scaling off</label></fieldset><div class="field-row" data-scaling-fields="${side}"><div class="field"><label>${label} minimum capacity units</label><input name="${side}Min" type="number" min="1" value="${current?.MinimumUnits ?? 1}"></div><div class="field"><label>${label} maximum capacity units</label><input name="${side}Max" type="number" min="1" value="${current?.MaximumUnits ?? 10}"></div><div class="field"><label>${label} target utilization (%)</label><input name="${side}Target" type="number" min="20" max="90" value="${target ?? 70}"></div></div>`; };
  document.querySelector('[data-action="configure-auto-scaling"]')?.addEventListener("click", () => {
    showModal("Edit auto scaling", `${scalingFields("read", "Read", stored.read)}${scalingFields("write", "Write", stored.write)}<div class="alert info"><strong>Configuration storage only</strong><br>No Application Auto Scaling service runs locally; the descriptors are persisted through the DynamoDB API for learning and inspection.</div>`, "Save changes", async data => {
      const update = side => { const on = data.get(`${side}Scaling`) === "on"; if (!on) return { AutoScalingDisabled: true }; const min = Number(data.get(`${side}Min`)); const max = Number(data.get(`${side}Max`)); const target = Number(data.get(`${side}Target`)); if (!min || !max || max < min) throw new Error(`${side === "read" ? "Read" : "Write"} capacity range must have a maximum of at least the minimum`); return { MinimumUnits: min, MaximumUnits: max, AutoScalingDisabled: false, ScalingPolicyUpdate: { PolicyName: `${table.TableName}-${side}-target`, TargetTrackingScalingPolicyConfiguration: { TargetValue: target, DisableScaleIn: false, ScaleInCooldown: 0, ScaleOutCooldown: 0 } } }; };
      await dynamo("UpdateTableReplicaAutoScaling", { TableName: table.TableName, ProvisionedWriteCapacityAutoScalingUpdate: update("write"), ReplicaUpdates: [{ RegionName: session.region, ReplicaProvisionedReadCapacityAutoScalingUpdate: update("read") }] }); toast("Auto scaling settings saved");
    }, true);
    const dialog = document.querySelector("dialog"); const sync = () => { for (const side of ["read", "write"]) dialog.querySelector(`[data-scaling-fields="${side}"]`).hidden = dialog.querySelector(`input[name="${side}Scaling"]:checked`)?.value !== "on"; };
    dialog.querySelectorAll('input[name="readScaling"], input[name="writeScaling"]').forEach(input => input.addEventListener("change", sync)); sync();
  });
}

async function dynamoTagsView(table) {
  const tags = (await dynamo("ListTagsOfResource", { ResourceArn: table.TableArn })).Tags ?? [];
  return `<section class="card tags-card" data-table-tags="${escapeHtml(encodeURIComponent(JSON.stringify(Object.fromEntries(tags.map(tag => [tag.Key, tag.Value])))))}"><div class="card-header"><div><h2>Tags <span class="muted">(${tags.length})</span></h2><p class="muted small">Case-sensitive metadata associated with this table.</p></div><button class="button primary" data-action="manage-table-tags">Manage tags</button></div><div class="table-wrap">${tags.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(tag => `<tr><td>${escapeHtml(tag.Key)}</td><td>${escapeHtml(tag.Value)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No tags", "Add tags to organize and identify this table.")}</div></section>`;
}

function bindTableTags(context, table) {
  const { showModal, toast } = context; let current = {}; try { current = JSON.parse(decodeURIComponent(document.querySelector(".tags-card")?.dataset.tableTags ?? "%7B%7D")); } catch {}
  // UI-17: AWS edits tags as Key/Value rows with Add new tag and Remove, not as a JSON document.
  const tagRow = (key = "", value = "") => `<div class="field-row tag-edit-row" data-tag-row><div class="field"><label>Key</label><input data-tag-key value="${escapeHtml(key)}" maxlength="128" placeholder="Enter key"></div><div class="field"><label>Value <span class="muted small">– optional</span></label><input data-tag-value value="${escapeHtml(value)}" maxlength="256" placeholder="Enter value"></div><div class="field-action"><button type="button" class="button" data-remove-tag>Remove</button></div></div>`;
  document.querySelector('[data-action="manage-table-tags"]')?.addEventListener("click", () => {
    showModal("Manage tags", `<p class="muted">A tag is a label that you assign to an AWS resource. Each tag consists of a key and an optional value.</p><div id="table-tag-rows">${Object.entries(current).map(([key, value]) => tagRow(key, value)).join("")}</div><button type="button" class="button" id="add-table-tag">Add new tag</button><p class="hint" id="table-tag-remaining"></p>`, "Save changes", async () => {
      const rows = [...document.querySelectorAll("#table-tag-rows [data-tag-row]")].map(row => ({ Key: row.querySelector("[data-tag-key]").value, Value: row.querySelector("[data-tag-value]").value }));
      const next = {};
      for (const { Key, Value } of rows) { if (!Key) throw new Error("Enter a key for every tag, or remove the empty row"); if (Object.prototype.hasOwnProperty.call(next, Key)) throw new Error(`Tag key ${Key} is used more than once`); next[Key] = Value; }
      const removed = Object.keys(current).filter(key => !(key in next));
      if (removed.length) await dynamo("UntagResource", { ResourceArn: table.TableArn, TagKeys: removed });
      const changed = Object.entries(next).filter(([key, value]) => current[key] !== value).map(([Key, Value]) => ({ Key, Value }));
      if (changed.length) await dynamo("TagResource", { ResourceArn: table.TableArn, Tags: changed });
      toast("Tags updated");
    }, true);
    const rowsRoot = document.querySelector("#table-tag-rows");
    const sync = () => { const count = rowsRoot.querySelectorAll("[data-tag-row]").length; document.querySelector("#table-tag-remaining").textContent = `You can add up to ${Math.max(0, 50 - count)} more tags.`; document.querySelector("#add-table-tag").disabled = count >= 50; };
    rowsRoot.addEventListener("click", event => { const button = event.target.closest("[data-remove-tag]"); if (button) { button.closest("[data-tag-row]").remove(); sync(); } });
    document.querySelector("#add-table-tag").addEventListener("click", () => { rowsRoot.insertAdjacentHTML("beforeend", tagRow()); associateFormLabels(rowsRoot); rowsRoot.lastElementChild.querySelector("[data-tag-key]").focus(); sync(); });
    sync();
  });
}

async function dynamoTableBackupsView(table) {
  const [continuous, backups] = await Promise.all([dynamo("DescribeContinuousBackups", { TableName: table.TableName }), collectDynamoPages("ListBackups", { TableName: table.TableName, BackupType: "ALL", Limit: 100 }, "BackupSummaries", "ExclusiveStartBackupArn", "LastEvaluatedBackupArn")]); const pitr = continuous.ContinuousBackupsDescription?.PointInTimeRecoveryDescription ?? { PointInTimeRecoveryStatus: "DISABLED", RecoveryPeriodInDays: 35 }; const enabled = pitr.PointInTimeRecoveryStatus === "ENABLED";
  return `<section class="card pitr-card" data-pitr="${escapeHtml(encodeURIComponent(JSON.stringify(pitr)))}"><div class="card-header"><div><h2>Point-in-time recovery (PITR)</h2><p class="muted small">Continuous backups let you restore the table to any second in the recovery period.</p></div><div class="actions"><button class="button" data-action="edit-pitr">Edit</button><button class="button primary" data-action="restore-pitr" ${enabled ? "" : "disabled"}>Restore</button></div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Point-in-time recovery</dt><dd><span class="status ${enabled ? "" : "inactive"}">${enabled ? "On" : "Off"}</span></dd><dt>Backup recovery period</dt><dd>${enabled ? `${pitr.RecoveryPeriodInDays ?? 35} day${pitr.RecoveryPeriodInDays === 1 ? "" : "s"}` : "–"}</dd></dl><dl class="key-value"><dt>Earliest restore date</dt><dd>${escapeHtml(dynamoDate(pitr.EarliestRestorableDateTime))}</dd><dt>Latest restore date</dt><dd>${escapeHtml(dynamoDate(pitr.LatestRestorableDateTime))}</dd></dl></div><div class="alert info"><strong>Local recovery timing</strong><br>Restore points are available through the latest completed local second. The hosted service typically reports a latest restorable time about five minutes behind.</div></div></section><section class="card"><div class="card-header"><div><h2>Backups <span class="muted">(${backups.length})</span></h2><p class="muted small">On-demand and system backups of this table.</p></div><button class="button primary" data-action="create-backup">Create backup</button></div><div class="table-wrap">${backupRows(backups)}</div></section>`;
}

// Shared restore options (UI-18): DynamoDB restores always create a new table; secondary indexes and encryption can be overridden.
function restoreOptionsMarkup(sse) {
  return `<h3>Destination AWS Region</h3><fieldset class="setting-options"><legend class="sr-only">Destination AWS Region</legend><label class="setting-option"><input type="radio" name="region" value="same" checked><span><strong>Same Region</strong><small>${escapeHtml(session.region)}</small></span></label><label class="setting-option disabled"><input type="radio" name="region" value="cross" disabled><span><strong>Cross Region</strong><small>Not available locally: StackSim runs one Region.</small></span></label></fieldset><h3>Secondary indexes</h3><fieldset class="setting-options"><legend class="sr-only">Secondary indexes</legend><label class="setting-option"><input type="radio" name="indexes" value="all" checked><span><strong>Restore the entire table</strong><small>Restore the table with all of its secondary indexes.</small></span></label><label class="setting-option"><input type="radio" name="indexes" value="none"><span><strong>Restore the table without secondary indexes</strong><small>Restoring without indexes is faster and costs less.</small></span></label></fieldset><h3>Encryption at rest</h3>${encryptionOptions(sse)}`;
}
function restoreOverrides(data) {
  return { ...(data.get("indexes") === "none" ? { GlobalSecondaryIndexOverride: [], LocalSecondaryIndexOverride: [] } : {}), SSESpecificationOverride: encryptionSpecification(data) };
}

function bindTableBackups(context, table) {
  const { showModal, toast } = context; let pitr = {}; try { pitr = JSON.parse(decodeURIComponent(document.querySelector(".pitr-card")?.dataset.pitr ?? "%7B%7D")); } catch {} const enabled = pitr.PointInTimeRecoveryStatus === "ENABLED";
  bindCreateBackup(context, [table.TableName], table.TableName); const backups = [...document.querySelectorAll("[data-backup-detail]")].map(button => ({ BackupArn: decodeURIComponent(button.dataset.backupDetail), BackupName: button.textContent.trim(), TableName: table.TableName, BackupStatus: button.closest("tr")?.querySelector(".status")?.textContent.trim(), BackupType: button.closest("tr")?.dataset.backupType })); bindBackupActions(context, backups);
  document.querySelector('[data-action="edit-pitr"]')?.addEventListener("click", () => {
    showModal("Edit point-in-time recovery settings", `<div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" ${enabled ? "checked" : ""}> Turn on point-in-time recovery</label></div><div class="field" data-pitr-period><label>Backup recovery period (days)</label><input name="period" type="number" min="1" max="35" step="1" value="${pitr.RecoveryPeriodInDays ?? 35}" required><span class="hint">Choose a value between 1 and 35.</span></div><div class="alert warning" data-pitr-off-warning hidden><strong>Restore history will reset</strong><br>Turning point-in-time recovery off deletes the existing restore points. Turning it on again starts a new recovery period.</div><div class="alert info"><strong>Append-only local journal</strong><br>Successful item, batch, transaction, PartiQL, and TTL mutations are captured while PITR is on.</div>`, "Save changes", async data => {
      const on = data.get("enabled") === "yes";
      if (!on) { if (enabled) await dynamo("UpdateContinuousBackups", { TableName: table.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } }); toast("Point-in-time recovery turned off"); return; }
      const period = Number(data.get("period")); if (!Number.isInteger(period) || period < 1 || period > 35) throw new Error("Enter a backup recovery period between 1 and 35 days");
      await dynamo("UpdateContinuousBackups", { TableName: table.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: period } }); toast(enabled ? "Point-in-time recovery settings saved" : "Point-in-time recovery turned on");
    });
    const dialog = document.querySelector("dialog"); const sync = () => { const on = dialog.querySelector('[name="enabled"]').checked; dialog.querySelector("[data-pitr-period]").hidden = !on; dialog.querySelector('[name="period"]').disabled = !on; dialog.querySelector("[data-pitr-off-warning]").hidden = on || !enabled; };
    dialog.querySelector('[name="enabled"]').addEventListener("change", sync); sync();
  });
  document.querySelector('[data-action="restore-pitr"]')?.addEventListener("click", () => {
    showModal("Restore table to a point in time", `<div class="field"><label>New table name</label><input name="target" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="${escapeHtml(table.TableName)}-restored"></div><h3>Restore date and time</h3><fieldset class="setting-options"><legend class="sr-only">Restore date and time</legend><label class="setting-option"><input type="radio" name="point" value="latest" checked><span><strong>Latest</strong><small>${escapeHtml(dynamoDate(pitr.LatestRestorableDateTime))}</small></span></label><label class="setting-option"><input type="radio" name="point" value="earliest"><span><strong>Earliest</strong><small>${escapeHtml(dynamoDate(pitr.EarliestRestorableDateTime))}</small></span></label><label class="setting-option"><input type="radio" name="point" value="custom"><span><strong>Specify date and time</strong><small>Any second in the recovery period.</small></span></label></fieldset><div class="field" data-restore-time hidden><label>Date and time</label><input name="time" type="datetime-local" step="1"></div>${restoreOptionsMarkup(table.SSEDescription)}<p class="muted">Restores use the DynamoDB Standard table class. Tags, TTL, streams, auto scaling, and PITR are not copied.</p>`, "Restore", async data => {
      const target = String(data.get("target")); const point = data.get("point"); const time = String(data.get("time") ?? "");
      if (point === "custom" && !time) throw new Error("Choose the restore date and time");
      const when = point === "latest" ? { UseLatestRestorableTime: true } : { RestoreDateTime: (point === "earliest" ? Number(pitr.EarliestRestorableDateTime) : new Date(time).getTime() / 1000) };
      await dynamo("RestoreTableToPointInTime", { SourceTableName: table.TableName, TargetTableName: target, ...when, ...restoreOverrides(data) }); toast("Point-in-time restore started"); location.hash = `#/dynamodb/tables/${encodeURIComponent(target)}/overview`;
    }, true);
    const dialog = document.querySelector("dialog"); bindEncryptionOptions(dialog);
    const sync = () => { dialog.querySelector("[data-restore-time]").hidden = dialog.querySelector('input[name="point"]:checked')?.value !== "custom"; };
    dialog.querySelectorAll('input[name="point"]').forEach(input => input.addEventListener("change", sync));
  });
}

async function dynamoSettingsView(table) {
  return `${await dynamoCapacityView(table)}${await dynamoTableSettingsCards(table)}`;
}

// DDB-16C (UI-12, UI-13): Additional settings cards use the AWS key-management labels from the encryption tutorial,
// "Enable delete protection", TTL Turn on/Turn off with an optional preview, and a single PITR settings dialog.
function encryptionKind(sse) {
  if (!sse || sse.SSEType !== "KMS") return "OWNED";
  const key = sse.KMSMasterKeyArn ?? "";
  return !key || /alias\/aws\/dynamodb$/.test(key) ? "AWS_MANAGED" : "CUSTOMER_MANAGED";
}
const encryptionLabels = { OWNED: "Owned by Amazon DynamoDB", AWS_MANAGED: "AWS managed key", CUSTOMER_MANAGED: "Customer managed key" };
function encryptionLabel(sse) { return encryptionLabels[encryptionKind(sse)]; }
function encryptionOptions(sse) {
  const kind = encryptionKind(sse); const key = kind === "CUSTOMER_MANAGED" ? sse.KMSMasterKeyArn ?? "" : "";
  const option = (value, title, text) => `<label class="setting-option"><input type="radio" name="encryption" value="${value}" ${kind === value ? "checked" : ""}><span><strong>${title}</strong><small>${text}</small></span></label>`;
  return `<fieldset class="setting-options"><legend>Encryption key management</legend>${option("OWNED", "Owned by Amazon DynamoDB", "The AWS KMS key is owned and managed by DynamoDB. You are not charged an additional fee for using this key.")}${option("AWS_MANAGED", "AWS managed key", "Key alias: aws/dynamodb. The key is stored in your account and is managed by AWS Key Management Service (AWS KMS).")}${option("CUSTOMER_MANAGED", "Stored in your account, and owned and managed by you", "Customer managed key. The key is stored in your account and is managed by AWS KMS.")}</fieldset><div class="field" data-kms-key-field ${kind === "CUSTOMER_MANAGED" ? "" : "hidden"}><label>AWS KMS key</label><input name="kmsKey" value="${escapeHtml(key)}" placeholder="Key ID, key ARN, alias name, or alias ARN"></div><div class="alert info"><strong>Local encryption boundary</strong><br>No KMS service runs locally. AWS managed and customer managed keys are stored as configuration and reported as dependency blocked, never as active encryption.</div>`;
}
function bindEncryptionOptions(root = document) {
  const sync = () => { const field = root.querySelector("[data-kms-key-field]"); if (field) field.hidden = root.querySelector('input[name="encryption"]:checked')?.value !== "CUSTOMER_MANAGED"; };
  root.querySelectorAll('input[name="encryption"]').forEach(input => input.addEventListener("change", sync)); sync();
}
function encryptionSpecification(data) {
  const kind = String(data.get("encryption") ?? "OWNED");
  if (kind === "OWNED") return { Enabled: false };
  if (kind === "AWS_MANAGED") return { Enabled: true, SSEType: "KMS" };
  const key = String(data.get("kmsKey") ?? "").trim(); if (!key) throw new Error("Enter the AWS KMS key for a customer managed key");
  return { Enabled: true, SSEType: "KMS", KMSMasterKeyId: key };
}

async function dynamoTableSettingsCards(table) {
  const ttl = (await dynamo("DescribeTimeToLive", { TableName: table.TableName })).TimeToLiveDescription ?? { TimeToLiveStatus: "DISABLED" };
  const status = ttl.TimeToLiveStatus ?? "DISABLED"; const enabled = status === "ENABLED"; const disabled = status === "DISABLED"; const pending = !enabled && !disabled;
  const statusLabel = ({ ENABLED: "On", DISABLED: "Off", ENABLING: "Turning on", DISABLING: "Turning off" })[status] ?? status;
  const actions = pending ? '<button class="button" data-action="refresh-ttl">Refresh</button>' : enabled ? '<button class="button" data-action="disable-ttl">Turn off</button>' : '<button class="button primary" data-action="enable-ttl">Turn on</button>';
  const tableClass = table.TableClassSummary?.TableClass ?? "STANDARD"; const protectedTable = table.DeletionProtectionEnabled === true; const sse = table.SSEDescription ?? { SSEType: "AES256", Status: "ENABLED" }; const kmsPending = sse.SSEType === "KMS" && sse.Status !== "ENABLED";
  return `<section class="card"><div class="card-header"><div><h2>Table class</h2><p class="muted small">Choose the storage pricing class for this table.</p></div><button class="button" data-action="edit-table-class">Edit</button></div><div class="card-body detail-grid"><dl class="key-value"><dt>Table class</dt><dd>${tableClass === "STANDARD" ? "DynamoDB Standard" : "DynamoDB Standard-Infrequent Access"}</dd></dl><dl class="key-value"><dt>Last updated</dt><dd>${table.TableClassSummary?.LastUpdateDateTime ? new Date(table.TableClassSummary.LastUpdateDateTime).toLocaleString() : "Created with table"}</dd></dl></div></section>`
    + `<section class="card"><div class="card-header"><div><h2>Deletion protection</h2><p class="muted small">Protects the table from being deleted.</p></div><button class="button" data-action="edit-deletion-protection">Edit</button></div><div class="card-body"><dl class="key-value"><dt>Deletion protection</dt><dd><span class="status ${protectedTable ? "" : "inactive"}">${protectedTable ? "On" : "Off"}</span></dd></dl>${protectedTable ? '<p class="muted">The table can\'t be deleted while deletion protection is on.</p>' : ""}</div></section>`
    + `<section class="card"><div class="card-header"><div><h2>Encryption</h2><p class="muted small">Encryption at rest for the table and its indexes, streams, and backups.</p></div><button class="button" data-action="edit-encryption">Manage encryption</button></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Key management</dt><dd>${escapeHtml(encryptionLabel(sse))}</dd><dt>Status</dt><dd><span class="status ${kmsPending ? "pending" : ""}">${kmsPending ? "Dependency blocked" : escapeHtml(sse.Status === "ENABLED" ? "Enabled" : sse.Status ?? "Enabled")}</span></dd></dl><dl class="key-value"><dt>AWS KMS key ARN</dt><dd class="mono">${escapeHtml(sse.KMSMasterKeyArn ?? "–")}</dd></dl></div>${kmsPending ? '<div class="alert info"><strong>KMS is not available locally</strong><br>The requested key is stored as configuration but is not reported as active encryption.</div>' : ""}</div></section>`
    + `<section class="card ttl-card"><div class="card-header"><div><h2>Time to Live (TTL)</h2><p class="muted small">Automatically delete expired items without consuming write throughput.</p></div><div class="actions">${actions}</div></div><div class="card-body"><div class="detail-grid ttl-details"><dl class="key-value"><dt>TTL status</dt><dd><span class="status ${disabled ? "inactive" : pending ? "pending" : ""}">${escapeHtml(statusLabel)}</span></dd></dl><dl class="key-value"><dt>TTL attribute</dt><dd class="mono">${escapeHtml(ttl.AttributeName ?? "–")}</dd></dl><dl class="key-value"><dt>Expiration format</dt><dd>Number · Unix epoch time in seconds</dd></dl></div><p class="muted ttl-explanation">DynamoDB evaluates the case-sensitive TTL attribute on each item. Items without the attribute, with another data type, or with a future timestamp remain in the table. To use a different attribute, turn TTL off and turn it on again with the new name.</p><div class="alert info ttl-local-note"><strong>Expiration timing</strong><br>In the hosted service, expired items are typically deleted within a few days. This local simulator uses a configurable short sweep interval for deterministic development and tests.</div></div></section>`;
}

function bindTableSettings(context, table) {
  const { showModal, toast } = context; const tableClass = table.TableClassSummary?.TableClass ?? "STANDARD";
  document.querySelector('[data-action="edit-table-class"]')?.addEventListener("click", () => showModal("Edit table class", `<div class="field"><label>Table class</label><select name="tableClass"><option value="STANDARD" ${tableClass === "STANDARD" ? "selected" : ""}>DynamoDB Standard</option><option value="STANDARD_INFREQUENT_ACCESS" ${tableClass === "STANDARD_INFREQUENT_ACCESS" ? "selected" : ""}>DynamoDB Standard-Infrequent Access</option></select><span class="hint">The class is stored for API and console fidelity; local storage has no usage charge.</span></div>`, "Save changes", async data => { await dynamo("UpdateTable", { TableName: table.TableName, TableClass: data.get("tableClass") }); toast("Table class is updating"); }));
  document.querySelector('[data-action="edit-deletion-protection"]')?.addEventListener("click", () => showModal("Edit deletion protection", `<div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" ${table.DeletionProtectionEnabled ? "checked" : ""}> Enable delete protection</label><span class="hint">While deletion protection is on, DeleteTable requests are rejected and the console's Delete action is unavailable.</span></div>`, "Save changes", async data => { const enabled = data.get("enabled") === "yes"; await dynamo("UpdateTable", { TableName: table.TableName, DeletionProtectionEnabled: enabled }); toast(`Deletion protection turned ${enabled ? "on" : "off"}`); }));
  document.querySelector('[data-action="edit-encryption"]')?.addEventListener("click", () => {
    showModal("Manage encryption", encryptionOptions(table.SSEDescription), "Save", async data => { await dynamo("UpdateTable", { TableName: table.TableName, SSESpecification: encryptionSpecification(data) }); toast("Encryption settings are updating"); }, true);
    bindEncryptionOptions(document.querySelector("dialog"));
  });
}

function bindTtlSettings(context, table) {
  const { route, showModal, toast } = context;
  document.querySelector('[data-action="enable-ttl"]')?.addEventListener("click", () => {
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    showModal("Turn on Time to Live (TTL)", `<div class="field"><label>TTL attribute name</label><input name="attributeName" maxlength="255" placeholder="expiresAt" required><span class="hint">The name of the attribute that stores the expiration timestamp. Attribute names are case sensitive; the value must be a Number in Unix epoch time, in seconds.</span></div><h3>Preview <span class="muted small">– optional</span></h3><p class="muted small">Simulate a date and time to see a few items that would be expired then.</p><div class="field-row"><div class="field"><label>Simulated date and time</label><input name="simulated" type="datetime-local" step="1" value="${now}"></div><div class="field ttl-preview-action"><button type="button" class="button" data-action="run-ttl-preview">Run preview</button></div></div><div id="ttl-preview-result" aria-live="polite"></div>`, "Turn on TTL", async data => {
      await dynamo("UpdateTimeToLive", { TableName: table.TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: String(data.get("attributeName") ?? "") } });
      toast("Time to Live is turning on");
    }, true);
    const dialog = document.querySelector("dialog");
    dialog.querySelector('[data-action="run-ttl-preview"]').addEventListener("click", async () => {
      const output = dialog.querySelector("#ttl-preview-result"); const attribute = dialog.querySelector('[name="attributeName"]').value; const simulated = dialog.querySelector('[name="simulated"]').value;
      if (!attribute) { output.innerHTML = '<div class="alert warning">Enter the TTL attribute name first.</div>'; return; }
      const epoch = Math.floor((simulated ? new Date(simulated) : new Date()).getTime() / 1000);
      try {
        // The preview is an ordinary bounded Scan; it does not change the table.
        const result = await dynamo("Scan", { TableName: table.TableName, Limit: 100, FilterExpression: "attribute_type(#ttl, :number) AND #ttl <= :simulated", ExpressionAttributeNames: { "#ttl": attribute }, ExpressionAttributeValues: { ":number": { S: "N" }, ":simulated": { N: String(epoch) } } });
        const keys = (result.Items ?? []).slice(0, 5).map(item => table.KeySchema.map(key => `${key.AttributeName}: ${Object.values(item[key.AttributeName] ?? {})[0] ?? ""}`).join(", "));
        output.innerHTML = `<div class="alert ${result.Count ? "info" : "success"}"><strong>${result.Count ?? 0} of ${result.ScannedCount ?? 0} evaluated items would be expired</strong>${keys.length ? `<ul>${keys.map(key => `<li class="mono">${escapeHtml(key)}</li>`).join("")}</ul>` : "<br>No evaluated item has a Number value at or before the simulated time."}${result.LastEvaluatedKey ? '<br><span class="muted small">Only the first 100 items were evaluated.</span>' : ""}</div>`;
      } catch (error) { output.innerHTML = `<div class="alert error"><strong>${escapeHtml(error.code ?? "Preview failed")}</strong><br>${escapeHtml(error.message)}</div>`; }
    });
  });
  document.querySelector('[data-action="refresh-ttl"]')?.addEventListener("click", route);
  document.querySelector('[data-action="disable-ttl"]')?.addEventListener("click", async () => {
    const ttl = (await dynamo("DescribeTimeToLive", { TableName: table.TableName })).TimeToLiveDescription;
    showModal("Turn off Time to Live (TTL)", `<p>Turn off TTL for <strong>${escapeHtml(table.TableName)}</strong>? Items whose <span class="mono">${escapeHtml(ttl.AttributeName)}</span> value passes will no longer be deleted automatically. DynamoDB allows one TTL change per hour per table.</p>`, "Turn off", async () => {
      await dynamo("UpdateTimeToLive", { TableName: table.TableName, TimeToLiveSpecification: { Enabled: false, AttributeName: ttl.AttributeName } }); toast("Time to Live is turning off");
    }, false, { danger: true });
  });
}

async function dynamoMonitorView(table) {
  const end = new Date(); const start = new Date(end.getTime() - 3_600_000); const request = { StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampAscending", MetricDataQueries: [
    { Id: "reads", Label: "Consumed read capacity", MetricStat: { Metric: { Namespace: "AWS/DynamoDB", MetricName: "ConsumedReadCapacityUnits", Dimensions: [{ Name: "TableName", Value: table.TableName }] }, Period: 60, Stat: "Sum" } },
    { Id: "writes", Label: "Consumed write capacity", MetricStat: { Metric: { Namespace: "AWS/DynamoDB", MetricName: "ConsumedWriteCapacityUnits", Dimensions: [{ Name: "TableName", Value: table.TableName }] }, Period: 60, Stat: "Sum" } },
  ] }; const result = await metrics("GetMetricData", request); const series = (result.MetricDataResults ?? []).map(item => ({ ...item, timestamps: item.Timestamps, values: item.Values, label: item.Label }));
  return `<section class="card"><div class="card-header"><h2>Table metrics</h2><a href="#/cloudwatch/metrics">View all metrics</a></div><div class="card-body"><div class="metric-controls"><div class="field"><label>Time range</label><select><option>Last hour</option></select></div><div class="field"><label>Period</label><select><option>1 minute</option></select></div><div class="field"><label>Statistic</label><select><option>Sum</option></select></div></div>${metricChart(series, `Read and write capacity for ${table.TableName}`)}</div></section>`;
}

function bindIndexes(context, table) {
  const { confirmDeletion, route, showModal, toast } = context;
  document.querySelector('[data-action="create-index"]')?.addEventListener("click", () => showModal("Create global secondary index", `<div class="field"><label>Index name</label><input name="name" required></div><div class="field-row"><div class="field"><label>Partition key</label><input name="partition" required></div><div class="field"><label>Partition key type</label><select name="partitionType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field"><label>Projection</label><select name="projection"><option value="ALL">All attributes</option><option value="KEYS_ONLY">Keys only</option></select></div>`, "Create index", async data => {
    await dynamo("UpdateTable", { TableName: table.TableName, AttributeDefinitions: [{ AttributeName: data.get("partition"), AttributeType: data.get("partitionType") }], GlobalSecondaryIndexUpdates: [{ Create: { IndexName: data.get("name"), KeySchema: [{ AttributeName: data.get("partition"), KeyType: "HASH" }], Projection: { ProjectionType: data.get("projection") }, ...(table.BillingModeSummary?.BillingMode === "PROVISIONED" ? { ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } } : {}) } }] }); toast("Index creation started"); await route();
  }));
  document.querySelectorAll("[data-delete-index]").forEach(button => button.addEventListener("click", () => confirmDeletion(button.dataset.deleteIndex, `Delete index ${button.dataset.deleteIndex}?`, async () => { await dynamo("UpdateTable", { TableName: table.TableName, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: button.dataset.deleteIndex } }] }); toast("Index deletion started"); await route(); })));
}

async function dynamoOverviewView(table) {
  const partition = table.KeySchema.find(key => key.KeyType === "HASH");
  const sort = table.KeySchema.find(key => key.KeyType === "RANGE");
  const [ttlResult, pitrResult] = await Promise.all([dynamo("DescribeTimeToLive", { TableName: table.TableName }).catch(() => ({})), dynamo("DescribeContinuousBackups", { TableName: table.TableName }).catch(() => ({}))]);
  const ttl = ttlResult.TimeToLiveDescription ?? {}; const pitr = pitrResult.ContinuousBackupsDescription?.PointInTimeRecoveryDescription ?? {};
  const mode = table.BillingModeSummary?.BillingMode ?? "PROVISIONED"; const provisioned = table.ProvisionedThroughput ?? {}; const onDemand = table.OnDemandThroughput ?? {}; const warm = table.WarmThroughput ?? {}; const sse = table.SSEDescription ?? { SSEType: "AES256" };
  const itemCount = Number(table.ItemCount ?? 0); const sizeBytes = Number(table.TableSizeBytes ?? 0);
  const statusLabel = value => ({ ACTIVE: "Active", CREATING: "Creating", UPDATING: "Updating", DELETING: "Deleting", ENABLED: "On", DISABLED: "Off", ENABLING: "Turning on", DISABLING: "Turning off" })[value] ?? value ?? "Off";
  const capacitySummary = mode === "PAY_PER_REQUEST" ? `On-demand${onDemand.MaxReadRequestUnits !== undefined || onDemand.MaxWriteRequestUnits !== undefined ? ` (max ${onDemand.MaxReadRequestUnits ?? "∞"} RRU / ${onDemand.MaxWriteRequestUnits ?? "∞"} WRU)` : ""}` : `Provisioned (${provisioned.ReadCapacityUnits ?? 0} RCU / ${provisioned.WriteCapacityUnits ?? 0} WCU)`;
  const link = (section, label) => `<a href="#/dynamodb/tables/${encodeURIComponent(table.TableName)}/${section}">${label}</a>`;
  const creation = table.CreationDateTime ? new Date(typeof table.CreationDateTime === "number" ? table.CreationDateTime * 1000 : table.CreationDateTime) : undefined;
  return `<section class="card"><div class="card-header"><h2>General information</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Partition key</dt><dd>${escapeHtml(partition?.AttributeName)} (${attributeType(table, partition?.AttributeName)})</dd><dt>Sort key</dt><dd>${sort ? `${escapeHtml(sort.AttributeName)} (${attributeType(table, sort.AttributeName)})` : "–"}</dd></dl><dl class="key-value"><dt>Capacity mode</dt><dd>${mode === "PAY_PER_REQUEST" ? "On-demand" : "Provisioned"}</dd><dt>Table status</dt><dd><span class="status ${table.TableStatus === "ACTIVE" ? "" : "pending"}">${escapeHtml(statusLabel(table.TableStatus))}</span></dd></dl></div></section><section class="card"><div class="card-header"><div><h2>Items summary</h2><p class="muted small">Local counts are exact and current; the hosted service updates item count and size approximately every six hours.</p></div><button class="button" data-action="explore-items">Explore table items</button></div><div class="card-body detail-grid"><dl class="key-value"><dt>Item count</dt><dd>${itemCount.toLocaleString()}</dd></dl><dl class="key-value"><dt>Table size</dt><dd>${formatBytes(sizeBytes)}</dd></dl><dl class="key-value"><dt>Average item size</dt><dd>${itemCount ? formatBytes(Math.round(sizeBytes / itemCount)) : "–"}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Additional info</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Amazon Resource Name (ARN)</dt><dd class="mono">${escapeHtml(table.TableArn)}</dd><dt>Table ID</dt><dd class="mono">${escapeHtml(table.TableId ?? "–")}</dd><dt>Creation date</dt><dd>${creation ? escapeHtml(creation.toLocaleString()) : "–"}</dd><dt>Table class</dt><dd>${(table.TableClassSummary?.TableClass ?? "STANDARD") === "STANDARD" ? "DynamoDB Standard" : "DynamoDB Standard-IA"}</dd></dl><dl class="key-value"><dt>Read/write capacity</dt><dd>${capacitySummary} · ${link("settings", "Edit")}</dd><dt>Warm throughput</dt><dd>${warm.ReadUnitsPerSecond ?? 12000} read / ${warm.WriteUnitsPerSecond ?? 4000} write units per second</dd><dt>Deletion protection</dt><dd>${table.DeletionProtectionEnabled ? "On" : "Off"} · ${link("settings", "Edit")}</dd><dt>Encryption</dt><dd>${escapeHtml(encryptionLabel(sse))}${sse.SSEType === "KMS" && sse.Status && sse.Status !== "ENABLED" ? " (dependency blocked)" : ""}</dd></dl><dl class="key-value"><dt>Time to Live (TTL)</dt><dd>${statusLabel(ttl.TimeToLiveStatus)}${ttl.AttributeName ? ` · <span class="mono">${escapeHtml(ttl.AttributeName)}</span>` : ""} · ${link("settings", "Manage")}</dd><dt>DynamoDB stream</dt><dd>${table.StreamSpecification?.StreamEnabled ? `On · ${escapeHtml(streamViewLabel(table.StreamSpecification.StreamViewType))}` : "Off"} · ${link("streams", "Manage")}</dd><dt>Point-in-time recovery (PITR)</dt><dd>${statusLabel(pitr.PointInTimeRecoveryStatus)} · ${link("backups", "Manage")}</dd><dt>Global tables</dt><dd>${table.Replicas?.length ? `${table.Replicas.length} replica${table.Replicas.length === 1 ? "" : "s"}` : "Single Region"} · ${link("global", "Manage")}</dd></dl></div></section>`;
}

async function dynamoItemsView(table) {
  const scan = await dynamo("Scan", { TableName: table.TableName });
  const indexes = [...(table.LocalSecondaryIndexes ?? []), ...(table.GlobalSecondaryIndexes ?? [])];
  return `<div class="card"><div class="card-header"><h2>Scan or query items</h2></div><div class="card-body"><div class="field-row"><div class="field"><label>Operation</label><select id="item-operation"><option value="scan">Scan</option><option value="query">Query</option></select></div><div class="field"><label>Partition key value</label><input id="query-key" placeholder="Required for Query" disabled></div><div class="field"><label>Table or index</label><select id="item-index"><option value="">Table – ${escapeHtml(table.TableName)}</option>${indexes.map(index => `<option value="${escapeHtml(index.IndexName)}">Index – ${escapeHtml(index.IndexName)}</option>`).join("")}</select></div></div><div class="actions"><button class="button primary" id="run-items">Run</button><button class="button" data-action="create-item">Create item</button></div></div></div><div class="card"><div class="card-header"><h2>Items returned <span class="muted" id="item-count">(${scan.Count ?? 0})</span></h2></div><div class="table-wrap" id="items-table">${itemsTable(table, scan.Items ?? [])}</div></div>`;
}

function itemsTable(table, items) {
  const names = [...new Set(items.flatMap(item => Object.keys(item)))];
  if (!items.length) return emptyState("◇", "No items returned", "Create an item or change your scan and query settings.", `<button class="button primary" data-action="create-item">Create item</button>`);
  return `<table><thead><tr><th class="checkbox-cell"><span class="sr-only">Select</span></th>${names.map(name => `<th>${escapeHtml(name)}</th>`).join("")}<th>Actions</th></tr></thead><tbody>${items.map(item => {
    const encodedItem = escapeHtml(encodeURIComponent(JSON.stringify(item)));
    return `<tr><td><input type="radio" name="selected-item" aria-label="Select item" value="${encodedItem}"></td>${names.map(name => `<td>${formatAttribute(item[name])}</td>`).join("")}<td class="no-wrap"><button class="button link" data-edit-item="${encodedItem}">Edit</button><button class="button link" data-duplicate-item="${encodedItem}">Duplicate</button><button class="button link" data-delete-item="${escapeHtml(encodeURIComponent(JSON.stringify(itemKey(table, item))))}">Delete</button></td></tr>`;
  }).join("")}</tbody></table>`;
}

function bindDynamoItems(context, table) {
  const { showError } = context;
  const operation = document.querySelector("#item-operation");
  const key = document.querySelector("#query-key");
  const indexSelect = document.querySelector("#item-index");
  operation.addEventListener("change", () => { key.disabled = operation.value !== "query"; });
  document.querySelector("#run-items").addEventListener("click", async () => {
    try {
      const input = { TableName: table.TableName };
      if (indexSelect.value) input.IndexName = indexSelect.value;
      let result;
      if (operation.value === "query") {
        if (!key.value) throw new Error("Enter a partition key value");
        const selected = [...(table.LocalSecondaryIndexes ?? []), ...(table.GlobalSecondaryIndexes ?? [])].find(index => index.IndexName === indexSelect.value);
        const hash = (selected?.KeySchema ?? table.KeySchema).find(schemaKey => schemaKey.KeyType === "HASH");
        input.KeyConditionExpression = "#pk = :pk";
        input.ExpressionAttributeNames = { "#pk": hash.AttributeName };
        input.ExpressionAttributeValues = { ":pk": typedValue(attributeType(table, hash.AttributeName), key.value) };
        result = await dynamo("Query", input);
      } else {
        result = await dynamo("Scan", input);
      }
      document.querySelector("#items-table").innerHTML = itemsTable(table, result.Items ?? []);
      document.querySelector("#item-count").textContent = `(${result.Count ?? 0})`;
      bindItemActions(context, table);
    } catch (error) {
      showError(error);
    }
  });
  bindItemActions(context, table);
}

function bindItemActions(context, table) {
  const { confirmDeletion, route, toast } = context;
  document.querySelectorAll('[data-action="create-item"]').forEach(button => button.addEventListener("click", () => showItemEditor(context, table, "create")));
  document.querySelectorAll("[data-edit-item]").forEach(button => button.addEventListener("click", () => showItemEditor(context, table, "edit", JSON.parse(decodeURIComponent(button.dataset.editItem)))));
  document.querySelectorAll("[data-duplicate-item]").forEach(button => button.addEventListener("click", () => showItemEditor(context, table, "duplicate", JSON.parse(decodeURIComponent(button.dataset.duplicateItem)))));
  document.querySelectorAll("[data-delete-item]").forEach(button => button.addEventListener("click", () => confirmDeletion("delete", "Delete this item?", async () => {
    await dynamo("DeleteItem", { TableName: table.TableName, Key: JSON.parse(decodeURIComponent(button.dataset.deleteItem)) });
    toast("Item deleted");
    await route();
  })));
}

function showItemEditor(context, table, action, source = {}) {
  const { showModal, toast } = context;
  const keyNames = new Set(table.KeySchema.map(key => key.AttributeName));
  const item = structuredClone(source);
  for (const key of table.KeySchema) if (action === "duplicate" || !item[key.AttributeName]) item[key.AttributeName] = typedValue(attributeType(table, key.AttributeName), "");
  const ordered = [...table.KeySchema.map(key => [key.AttributeName, item[key.AttributeName]]), ...Object.entries(item).filter(([name]) => !keyNames.has(name))];
  if (action === "create") ordered.push(["", { S: "" }]);
  const title = action === "edit" ? "Edit item" : action === "duplicate" ? "Duplicate item" : "Create item";
  const submit = action === "edit" ? "Save changes" : "Create item";
  showModal(title, `<div class="field"><label>Editor view</label><select id="item-editor-mode" name="mode"><option value="form">Form</option><option value="json">DynamoDB JSON</option></select></div><div id="item-form-editor"><div class="alert info">Primary key attributes are pinned. Nested maps, lists, and sets use DynamoDB JSON values.</div><div id="attribute-rows">${ordered.map(([name, value]) => {
    const [type, raw] = Object.entries(value)[0];
    return itemAttributeRow(name, type, keyNames.has(name), editorAttributeText(type, raw));
  }).join("")}</div><button type="button" class="button" id="add-attribute">Add attribute</button></div><div class="field" id="item-json-editor" hidden><label>DynamoDB JSON</label><textarea name="item" style="min-height:280px">${escapeHtml(JSON.stringify(item, null, 2))}</textarea></div>`, submit, async data => {
    let next;
    if (data.get("mode") === "json") {
      next = JSON.parse(String(data.get("item")));
    } else {
      next = {};
      document.querySelectorAll(".attribute-row").forEach(row => {
        const name = row.querySelector("[data-attribute-name]").value;
        if (!name) return;
        next[name] = editorAttributeValue(row.querySelector("[data-attribute-type]").value, row.querySelector("[data-attribute-value]").value);
      });
    }
    await dynamo("PutItem", { TableName: table.TableName, Item: next });
    toast(action === "edit" ? "Item updated" : "Item created");
  });
  const mode = document.querySelector("#item-editor-mode");
  mode.addEventListener("change", () => {
    document.querySelector("#item-form-editor").hidden = mode.value !== "form";
    document.querySelector("#item-json-editor").hidden = mode.value !== "json";
  });
  document.querySelector("#add-attribute").addEventListener("click", () => {
    document.querySelector("#attribute-rows").insertAdjacentHTML("beforeend", itemAttributeRow("", "S", false, ""));
    bindAttributeRemove();
  });
  bindAttributeRemove();
}

function itemAttributeRow(name, type, pinned, value = "") {
  const rowId = `dynamodb-attribute-${++attributeRowId}`;
  return `<div class="attribute-row field-row"><div class="field"><label for="${rowId}-name">Attribute name</label><input id="${rowId}-name" data-attribute-name value="${escapeHtml(name)}" ${pinned ? "readonly" : ""}></div><div class="field"><label for="${rowId}-value">Type and value</label><div class="attribute-value"><select id="${rowId}-type" aria-label="Attribute type" data-attribute-type ${pinned ? "disabled" : ""}>${[["S", "String"], ["N", "Number"], ["B", "Binary"], ["BOOL", "Boolean"], ["NULL", "Null"], ["M", "Map (JSON)"], ["L", "List (JSON)"], ["SS", "String set"], ["NS", "Number set"], ["BS", "Binary set"]].map(([option, label]) => `<option value="${option}" ${type === option ? "selected" : ""}>${label}</option>`).join("")}</select><input id="${rowId}-value" data-attribute-value value="${escapeHtml(value)}" placeholder="${["M", "L"].includes(type) ? "JSON value" : "Value"}" required>${pinned ? '<span class="type-tag">KEY</span>' : '<button type="button" class="button link" data-remove-attribute>Remove</button>'}</div></div></div>`;
}

function bindAttributeRemove() {
  document.querySelectorAll("[data-remove-attribute]").forEach(button => { button.onclick = () => button.closest(".attribute-row").remove(); });
}

function editorAttributeText(type, value) {
  if (["M", "L"].includes(type)) return JSON.stringify(value);
  if (["SS", "NS", "BS"].includes(type)) return value.join(", ");
  return String(value ?? "");
}

function editorAttributeValue(type, value) {
  if (type === "BOOL") return { BOOL: value === "true" };
  if (type === "NULL") return { NULL: true };
  if (type === "M") return { M: JSON.parse(value) };
  if (type === "L") return { L: JSON.parse(value) };
  if (["SS", "NS", "BS"].includes(type)) return { [type]: value.split(",").map(item => item.trim()).filter(Boolean) };
  return { [type]: String(value) };
}

function itemKey(table, item) {
  return Object.fromEntries(table.KeySchema.map(key => [key.AttributeName, item[key.AttributeName]]));
}

function attributeType(table, name) {
  return table.AttributeDefinitions.find(attribute => attribute.AttributeName === name)?.AttributeType ?? "S";
}

function typedValue(type, value) {
  return type === "N" ? { N: String(value) } : type === "B" ? { B: String(value) } : { S: String(value) };
}

function formatAttribute(value) {
  if (!value) return '<span class="muted">–</span>';
  const [type, raw] = Object.entries(value)[0];
  return `<span class="json-value"><span class="type-tag">${escapeHtml(type)}</span>${escapeHtml(typeof raw === "object" ? JSON.stringify(raw) : raw)}</span>`;
}
