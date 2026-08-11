import { dynamo, metrics, rest } from "../api-client.js";
import { emptyState, escapeHtml, metricChart, pageHeader, panelHeading } from "../components.js";
import { eventSourceMappingForm, eventSourceMappingInput } from "../event-source-mappings.js";
import { session, setDirty } from "../state.js";
import { bindEnhancedDynamoItems, enhancedDynamoItemsView } from "./dynamodb-items.js";
import { enhancedDynamoPartiql } from "./dynamodb-partiql.js";
import { bindEnhancedIndexes, bindEnhancedMonitor, enhancedDynamoCreateTable, enhancedDynamoMonitorView } from "./dynamodb-admin.js";

export const metadata = {
  key: "dynamodb",
  name: "DynamoDB",
  icon: "D",
  cls: "db",
  links: [["Overview", "#/dynamodb"], ["Tables", "#/dynamodb/tables"], ["Global tables", "#/dynamodb/global-tables"], ["Exports and streams", "#/dynamodb/exports"], ["Imports", "#/dynamodb/imports"], ["Contributor insights", "#/dynamodb/contributor-insights"], ["Transaction builder", "#/dynamodb/transactions"], ["PartiQL editor", "#/dynamodb/partiql"], ["Backups", "#/dynamodb/backups"]],
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
    support: "Index creation, projection, maintenance, queries, and global-index deletion are active. Local secondary indexes can be created only with the table, matching DynamoDB's lifecycle rule.",
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
    level: "StackSim extension",
    description: "A point-in-time export writes a consistent table snapshot without consuming table read capacity. In AWS the destination is S3; this local workflow writes DynamoDB JSON Lines and compatible manifests to an explicitly allowed file location.",
    support: "Full exports from PITR-enabled tables to opted-in absolute file:// locations are active. DynamoDB JSON is supported; incremental exports, Ion, remote S3, and network destinations are unavailable.",
  },
  imports: {
    level: "StackSim extension",
    description: "An import creates a new table from DynamoDB-formatted files. Define the new table's primary key and point at an exported data directory or JSON Lines file; an import never merges into or overwrites an existing table.",
    support: "Opted-in file:// sources, DynamoDB JSON, GZIP or uncompressed data, job status, and asynchronous table creation are active. CSV, Ion, ZSTD, and remote S3 sources are unavailable.",
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
    support: "Bounded scan and query pages, key conditions, filters, projections, consistent reads, parallel scans, pagination, and item create, edit, duplicate, and delete workflows are active.",
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
  ["Ordered actions", "transactions"],
  ["Operation", "partiql"],
  ["Operations", "partiqlOperations"],
  ["Exports", "exports"],
  ["Point-in-time exports", "exports"],
  ["Imports", "imports"],
  ["Contributor insights resources", "contributorInsights"],
  ["Contributor insights", "contributorInsights"],
  ["On-demand backups", "backups"],
  ["Scan or query items", "items"],
  ["Table metrics", "metrics"],
  ["Read/write capacity", "capacity"],
  ["Auto scaling", "autoScaling"],
  ["Table class", "tableClass"],
  ["Deletion protection", "deletionProtection"],
  ["Encryption at rest", "encryption"],
  ["Time to Live (TTL)", "ttl"],
  ["Tags", "tags"],
  ["Point-in-time recovery (PITR)", "pitr"],
  ["DynamoDB stream details", "stream"],
  ["Kinesis data stream destination", "kinesisDestination"],
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
  if (parts[1] === "imports" && parts.length === 2) return withPanelHelp(() => dynamoImports(context));
  if (parts[1] === "contributor-insights" && parts.length === 2) return withPanelHelp(() => dynamoContributorInsights(context));
  if (parts[1] === "tables" && !parts[2] && parts.length === 2) return withPanelHelp(() => dynamoTables(context));
  if (parts[1] === "tables" && parts[2] === "create" && parts.length === 3) return withPanelHelp(() => enhancedDynamoCreateTable(context));
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
  if (!backups.length) return emptyState("◇", "No on-demand backups", "Create a backup to preserve an immutable table snapshot.");
  return `<table><thead><tr><th>Backup name</th><th>Source table</th><th>Status</th><th>Created</th><th>Size</th><th>Actions</th></tr></thead><tbody>${backups.map(backup => `<tr><td><button class="button link" data-backup-detail="${escapeHtml(encodeURIComponent(backup.BackupArn))}">${escapeHtml(backup.BackupName)}</button></td><td><a href="#/dynamodb/tables/${encodeURIComponent(backup.TableName)}/overview">${escapeHtml(backup.TableName)}</a></td><td><span class="status ${backup.BackupStatus === "CREATING" ? "pending" : ""}">${escapeHtml(backup.BackupStatus)}</span></td><td>${escapeHtml(dynamoDate(backup.BackupCreationDateTime))}</td><td>${Number(backup.BackupSizeBytes ?? 0).toLocaleString()} bytes</td><td class="no-wrap"><button class="button link" data-backup-restore="${escapeHtml(encodeURIComponent(backup.BackupArn))}" ${backup.BackupStatus !== "AVAILABLE" ? "disabled" : ""}>Restore</button><button class="button link" data-backup-delete="${escapeHtml(encodeURIComponent(backup.BackupArn))}" ${backup.BackupStatus !== "AVAILABLE" ? "disabled" : ""}>Delete</button></td></tr>`).join("")}</tbody></table>`;
}

async function dynamoBackups(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Backups"]); const [backups, TableNames] = await Promise.all([collectDynamoPages("ListBackups", { BackupType: "USER", Limit: 100 }, "BackupSummaries", "ExclusiveStartBackupArn", "LastEvaluatedBackupArn"), collectTableNames()]); const tables = { TableNames };
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
  document.querySelectorAll("[data-backup-restore]").forEach(button => button.addEventListener("click", () => { const backup = findBackup(button.dataset.backupRestore); if (!backup) return; showModal("Restore table from backup", `<div class="alert info"><strong>New table required</strong><br>The source and backup remain unchanged. Restore creates a separate table through the normal creation lifecycle.</div><div class="field"><label>Backup</label><input value="${escapeHtml(backup.BackupName)}" disabled></div><div class="field"><label>New table name</label><input name="target" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="${escapeHtml(backup.TableName)}-restored"></div><p class="muted">The source billing mode, encryption, indexes, and capacity settings are copied. Tags, TTL, streams, and auto scaling are not copied.</p>`, "Restore table", async data => { const target = String(data.get("target")); await dynamo("RestoreTableFromBackup", { BackupArn: backup.BackupArn, TargetTableName: target }); toast("Table restore started"); location.hash = `#/dynamodb/tables/${encodeURIComponent(target)}/overview`; }); }));
  document.querySelectorAll("[data-backup-delete]").forEach(button => button.addEventListener("click", () => { const backup = findBackup(button.dataset.backupDelete); if (!backup) return; confirmDeletion(backup.BackupName, `Delete backup ${backup.BackupName}? Restores from this snapshot will no longer be possible.`, async () => { await dynamo("DeleteBackup", { BackupArn: backup.BackupArn }); toast("Backup deleted"); await route(); }); }));
}

async function dynamoTables(context) {
  const { bindTableFilter, main, route, setChrome } = context;
  setChrome("dynamodb", ["DynamoDB", "Tables"]);
  const list = { TableNames: await collectTableNames() };
  const descriptions = await Promise.all((list.TableNames ?? []).map(name => dynamo("DescribeTable", { TableName: name }).then(result => result.Table)));
  main.innerHTML = `<div class="page-width">${pageHeader("Tables", "View and manage DynamoDB tables.", `<button class="button refresh" data-action="refresh">↻</button><a class="button primary" href="#/dynamodb/tables/create">Create table</a>`)}<section class="card"><div class="card-header"><h2>Tables <span class="muted">(${descriptions.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find tables"></label></div><div class="table-wrap">${descriptions.length ? `<table><thead><tr><th>Table name</th><th>Status</th><th>Partition key</th><th>Sort key</th><th>Items</th></tr></thead><tbody>${descriptions.map(table => `<tr data-search-row="${escapeHtml(table.TableName.toLowerCase())}"><td><a href="#/dynamodb/tables/${encodeURIComponent(table.TableName)}/overview">${escapeHtml(table.TableName)}</a></td><td><span class="status">${escapeHtml(table.TableStatus)}</span></td><td>${escapeHtml(table.KeySchema.find(key => key.KeyType === "HASH")?.AttributeName)}</td><td>${escapeHtml(table.KeySchema.find(key => key.KeyType === "RANGE")?.AttributeName || "–")}</td><td>${table.ItemCount}</td></tr>`).join("")}</tbody></table>` : emptyState("D", "No tables", "Create a table to store items.", `<a class="button" href="#/dynamodb/tables/create">Create table</a>`)}</div></section></div>`;
  bindTableFilter();
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", route);
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
  const tabs = [["overview", "Overview"], ["items", "Explore table items"], ["indexes", "Indexes"], ["monitor", "Monitor"], ["capacity", "Capacity"], ["settings", "Additional settings"], ["backups", "Backups"], ["streams", "Exports and streams"], ["global", "Global tables"], ["contributors", "Contributor insights"], ["permissions", "Permissions"], ["tags", "Tags"]];
  const content = section === "items" ? await enhancedDynamoItemsView(table) : section === "indexes" ? dynamoIndexesView(table) : section === "monitor" ? await enhancedDynamoMonitorView(table) : section === "capacity" ? await dynamoCapacityView(table) : section === "settings" ? await dynamoSettingsView(table) : section === "tags" ? await dynamoTagsView(table) : section === "backups" ? await dynamoTableBackupsView(table) : section === "streams" ? await dynamoStreamsView(table) : section === "global" ? await dynamoGlobalTableView(table) : section === "contributors" ? await dynamoTableContributorInsightsView(table) : section === "permissions" ? await dynamoPermissionsView(table) : dynamoOverviewView(table);
  main.innerHTML = `<div class="page-width">${pageHeader(name, table.TableArn, `<button class="button danger" data-action="delete-table" ${table.DeletionProtectionEnabled ? "disabled title=\"Disable deletion protection first\"" : ""}>Delete</button><button class="button" data-action="explore-items">Explore table items</button>`)}<div class="tabs">${tabs.map(([id, label]) => `<a class="tab ${section === id ? "active" : ""}" href="#/dynamodb/tables/${encodeURIComponent(name)}/${id}">${label}</a>`).join("")}</div>${content}</div>`;
  requestAnimationFrame(() => { const tabs = document.querySelector(".tabs"); const active = tabs?.querySelector(".tab.active"); if (tabs && active) tabs.scrollLeft = active.offsetLeft - (tabs.clientWidth - active.clientWidth) / 2; });
  document.querySelector('[data-action="delete-table"]').addEventListener("click", () => confirmDeletion(name, `Delete table ${name}? All items will be deleted.`, async () => {
    await dynamo("DeleteTable", { TableName: name });
    toast("Table deleted");
    location.hash = "#/dynamodb/tables";
  }));
  document.querySelector('[data-action="explore-items"]').addEventListener("click", () => { location.hash = `#/dynamodb/tables/${encodeURIComponent(name)}/items`; });
  if (section === "items") bindEnhancedDynamoItems(context, table);
  if (section === "indexes") bindEnhancedIndexes(context, table);
  if (section === "monitor") bindEnhancedMonitor(context, table);
  if (section === "capacity") bindCapacity(context, table);
  if (section === "settings") { bindTableSettings(context, table); bindTtlSettings(context, table); }
  if (section === "tags") bindTableTags(context, table);
  if (section === "backups") bindTableBackups(context, table);
  if (section === "streams") bindTableStreams(context, table);
  if (section === "global") bindGlobalTable(context, table);
  if (section === "contributors") bindContributorActions(context);
  if (section === "permissions") bindTablePermissions(context, table);
}

function transferStatus(value) { return `<span class="status ${value === "IN_PROGRESS" ? "pending" : value === "FAILED" ? "error" : ""}">${escapeHtml(value ?? "–")}</span>`; }

function exportRows(exports) {
  if (!exports.length) return emptyState("◇", "No exports", "Export a PITR-enabled table to a local DynamoDB JSON file set.");
  return `<table><thead><tr><th>Source table</th><th>Status</th><th>Export time</th><th>Items</th><th>Local destination</th><th>Actions</th></tr></thead><tbody>${exports.map(job => { const tableName = job.TableArn?.split(":table/").at(-1)?.split("/")[0] ?? ""; return `<tr><td><a href="#/dynamodb/tables/${encodeURIComponent(tableName)}/streams">${escapeHtml(tableName || "–")}</a></td><td>${transferStatus(job.ExportStatus)}</td><td>${escapeHtml(dynamoDate(job.ExportTime))}</td><td>${Number(job.ItemCount ?? 0).toLocaleString()}</td><td class="mono">${escapeHtml(`${job.S3Bucket ?? ""}${job.S3Prefix ? `/${job.S3Prefix}` : ""}`)}</td><td><button class="button link" data-export-detail="${escapeHtml(encodeURIComponent(job.ExportArn))}">View details</button></td></tr>`; }).join("")}</tbody></table>`;
}

function bindCreateExport(context, tables, selectedTable) {
  const { route, showModal, toast } = context; document.querySelectorAll('[data-action="create-export"]').forEach(button => button.addEventListener("click", () => showModal("Export table to a local file location", `<div class="alert info"><strong>Local simulator extension</strong><br>The hosted service exports to S3. This console accepts only an absolute <span class="mono">file://</span> bucket while <span class="mono">STACKSIM_ALLOW_LOCAL_FILES=true</span>.</div><div class="field"><label>Source table</label><select name="table" required>${tables.map(name => `<option value="${escapeHtml(name)}" ${name === selectedTable ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select><span class="hint">Point-in-time recovery must already be enabled for the table.</span></div><div class="field"><label>Local bucket location</label><input name="bucket" required value="file:///tmp/stacksim-dynamodb-export" pattern="file://.*"><span class="hint">Example: file:///tmp/stacksim-dynamodb-export</span></div><div class="field"><label>Export prefix <span class="muted small">– optional</span></label><input name="prefix" value="exports" placeholder="exports/2026-07-15"></div><div class="field"><label>Export format</label><select disabled><option>DynamoDB JSON</option></select><span class="hint">Ion and incremental exports are explicitly codec/feature blocked locally.</span></div>`, "Export", async data => { const table = (await dynamo("DescribeTable", { TableName: data.get("table") })).Table; await dynamo("ExportTableToPointInTime", { TableArn: table.TableArn, S3Bucket: data.get("bucket"), ...(String(data.get("prefix") ?? "") ? { S3Prefix: String(data.get("prefix")) } : {}), ExportFormat: "DYNAMODB_JSON" }); toast("Table export started"); await new Promise(resolve => setTimeout(resolve, 80)); await route(); })));
}

function bindExportDetails(context, exports) {
  document.querySelectorAll("[data-export-detail]").forEach(button => button.addEventListener("click", () => { const job = exports.find(item => item.ExportArn === decodeURIComponent(button.dataset.exportDetail)); if (!job) return; context.showModal("Export details", `<div class="detail-grid"><dl class="key-value"><dt>Status</dt><dd>${transferStatus(job.ExportStatus)}</dd><dt>Items</dt><dd>${Number(job.ItemCount ?? 0).toLocaleString()}</dd><dt>Started</dt><dd>${escapeHtml(dynamoDate(job.StartTime))}</dd><dt>Completed</dt><dd>${escapeHtml(dynamoDate(job.EndTime))}</dd></dl><dl class="key-value"><dt>Format</dt><dd>${escapeHtml(job.ExportFormat)}</dd><dt>Type</dt><dd>${escapeHtml(job.ExportType)}</dd><dt>Manifest key</dt><dd class="mono">${escapeHtml(job.ExportManifest ?? "–")}</dd><dt>File mode</dt><dd class="mono">0600</dd></dl></div><div class="field"><label>Export ARN</label><textarea class="code-editor" readonly>${escapeHtml(job.ExportArn)}</textarea></div><div class="alert info"><strong>Local destination</strong><br>${escapeHtml(`${job.S3Bucket ?? ""}${job.S3Prefix ? `/${job.S3Prefix}` : ""}`)}</div>`, "Close", async () => {}); }));
}

async function dynamoExports(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Exports and streams"]); const [ExportSummaries, TableNames, environment] = await Promise.all([collectDynamoPages("ListExports", { MaxResults: 25 }, "ExportSummaries", "NextToken", "NextToken"), collectTableNames(), rest("/_stacksim/api/environment")]); const tables = { TableNames }; const exports = await Promise.all(ExportSummaries.map(summary => dynamo("DescribeExport", { ExportArn: summary.ExportArn }).then(result => result.ExportDescription)));
  main.innerHTML = `<div class="page-width">${pageHeader("Exports and streams", "Move point-in-time table snapshots into local DynamoDB JSON files and manage change streams.", `<button class="button refresh" data-action="refresh-exports">↻</button><button class="button primary" data-action="create-export" ${(tables.TableNames ?? []).length && environment.allowLocalFiles ? "" : "disabled"}>Export to local files</button>`)}<div class="alert ${environment.allowLocalFiles ? "info" : "error"}"><strong>Local file extension ${environment.allowLocalFiles ? "enabled" : "disabled"}</strong><br>${environment.allowLocalFiles ? "file:// locations are enabled for this simulator process. No S3 bucket or network request is created." : "Restart with STACKSIM_ALLOW_LOCAL_FILES=true to enable explicitly opted-in file:// import and export locations."}</div><section class="card"><div class="card-header"><div><h2>Exports <span class="muted">(${exports.length})</span></h2><p class="muted small">Full PITR snapshots in DynamoDB JSON Lines with provider-compatible manifests.</p></div></div><div class="table-wrap">${exportRows(exports)}</div></section><section class="card"><div class="card-header"><div><h2>DynamoDB Streams</h2><p class="muted small">Per-table change capture and Lambda trigger readiness.</p></div><a class="button" href="#/dynamodb/tables">View table streams</a></div><div class="card-body"><p>Open a table's <strong>Exports and streams</strong> tab to enable its stream, choose image capture, and inspect its latest descriptor.</p></div></section><section class="card"><div class="card-header"><div><h2>Kinesis data stream destinations</h2><p class="muted small">Per-table destination settings and timestamp precision.</p></div><a class="button" href="#/dynamodb/tables">Manage table destinations</a></div><div class="card-body"><p>A table can store one same-account, same-Region Kinesis stream ARN. This simulator models the configuration lifecycle only and does not deliver records.</p></div></section></div>`; document.querySelector('[data-action="refresh-exports"]')?.addEventListener("click", context.route); bindCreateExport(context, tables.TableNames ?? []); bindExportDetails(context, exports);
}

function importRows(imports) {
  if (!imports.length) return emptyState("◇", "No imports", "Create a new table from local DynamoDB JSON Lines files.");
  return `<table><thead><tr><th>Target table</th><th>Status</th><th>Started</th><th>Processed</th><th>Imported</th><th>Local source</th><th>Actions</th></tr></thead><tbody>${imports.map(job => `<tr><td><a href="#/dynamodb/tables/${encodeURIComponent(job.TableCreationParameters?.TableName ?? "")}/overview">${escapeHtml(job.TableCreationParameters?.TableName ?? "–")}</a></td><td>${transferStatus(job.ImportStatus)}</td><td>${escapeHtml(dynamoDate(job.StartTime))}</td><td>${Number(job.ProcessedItemCount ?? 0).toLocaleString()}</td><td>${Number(job.ImportedItemCount ?? 0).toLocaleString()}</td><td class="mono">${escapeHtml(`${job.S3BucketSource?.S3Bucket ?? ""}${job.S3BucketSource?.S3KeyPrefix ? `/${job.S3BucketSource.S3KeyPrefix}` : ""}`)}</td><td><button class="button link" data-import-detail="${escapeHtml(encodeURIComponent(job.ImportArn))}">View details</button></td></tr>`).join("")}</tbody></table>`;
}

function bindCreateImport(context) {
  const { route, showModal, toast } = context; document.querySelector('[data-action="create-import"]')?.addEventListener("click", () => showModal("Import a table from local files", `<div class="alert info"><strong>Creates a new table</strong><br>The source must contain DynamoDB JSON Lines. Point an exported snapshot at its <span class="mono">AWSDynamoDB/&lt;ExportId&gt;/data</span> directory.</div><div class="field"><label>Local bucket location</label><input name="bucket" required value="file:///tmp/stacksim-dynamodb-export" pattern="file://.*"></div><div class="field"><label>Key prefix or file</label><input name="prefix" required placeholder="exports/AWSDynamoDB/0000000000000-id/data"></div><div class="field"><label>Compression</label><select name="compression"><option value="GZIP">GZIP</option><option value="NONE">None</option></select></div><h3>New table</h3><div class="field"><label>Table name</label><input name="table" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="ImportedRecords"></div><div class="field-row"><div class="field"><label>Partition key</label><input name="partition" required placeholder="id"></div><div class="field"><label>Key type</label><select name="partitionType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field-row"><div class="field"><label>Sort key <span class="muted small">– optional</span></label><input name="sort"></div><div class="field"><label>Sort key type</label><select name="sortType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="alert info"><strong>Current local codecs</strong><br>DynamoDB JSON with GZIP or no compression is supported. Ion, CSV, and ZSTD return explicit modeled errors.</div>`, "Import table", async data => { const definitions = [{ AttributeName: data.get("partition"), AttributeType: data.get("partitionType") }]; const keys = [{ AttributeName: data.get("partition"), KeyType: "HASH" }]; if (data.get("sort")) { definitions.push({ AttributeName: data.get("sort"), AttributeType: data.get("sortType") }); keys.push({ AttributeName: data.get("sort"), KeyType: "RANGE" }); } await dynamo("ImportTable", { S3BucketSource: { S3Bucket: data.get("bucket"), S3KeyPrefix: data.get("prefix") }, InputFormat: "DYNAMODB_JSON", InputCompressionType: data.get("compression"), TableCreationParameters: { TableName: data.get("table"), BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: definitions, KeySchema: keys } }); toast("Table import started"); await new Promise(resolve => setTimeout(resolve, 80)); await route(); }));
}

async function dynamoImports(context) {
  const { main, setChrome } = context; setChrome("dynamodb", ["DynamoDB", "Imports"]); const [ImportSummaryList, environment] = await Promise.all([collectDynamoPages("ListImports", { PageSize: 25 }, "ImportSummaryList", "NextToken", "NextToken"), rest("/_stacksim/api/environment")]); const imports = await Promise.all(ImportSummaryList.map(summary => dynamo("DescribeImport", { ImportArn: summary.ImportArn }).then(result => result.ImportTableDescription)));
  main.innerHTML = `<div class="page-width">${pageHeader("Imports", "Create new DynamoDB tables from local DynamoDB JSON data.", `<button class="button refresh" data-action="refresh-imports">↻</button><button class="button primary" data-action="create-import" ${environment.allowLocalFiles ? "" : "disabled"}>Import from local files</button>`)}<div class="alert ${environment.allowLocalFiles ? "info" : "error"}"><strong>Local simulator behavior</strong><br>${environment.allowLocalFiles ? "The file:// source remains on this machine and is never uploaded. Import jobs use the normal asynchronous table-creation lifecycle." : "Local files are disabled. Restart with STACKSIM_ALLOW_LOCAL_FILES=true to opt in."}</div><section class="card"><div class="card-header"><div><h2>Imports <span class="muted">(${imports.length})</span></h2><p class="muted small">Jobs completed or started in the last 90 days.</p></div></div><div class="table-wrap">${importRows(imports)}</div></section></div>`; document.querySelector('[data-action="refresh-imports"]')?.addEventListener("click", context.route); bindCreateImport(context); document.querySelectorAll("[data-import-detail]").forEach(button => button.addEventListener("click", () => { const job = imports.find(item => item.ImportArn === decodeURIComponent(button.dataset.importDetail)); if (!job) return; context.showModal("Import details", `<div class="detail-grid"><dl class="key-value"><dt>Status</dt><dd>${transferStatus(job.ImportStatus)}</dd><dt>Target table</dt><dd>${escapeHtml(job.TableCreationParameters?.TableName ?? "–")}</dd><dt>Processed items</dt><dd>${Number(job.ProcessedItemCount ?? 0).toLocaleString()}</dd><dt>Imported items</dt><dd>${Number(job.ImportedItemCount ?? 0).toLocaleString()}</dd></dl><dl class="key-value"><dt>Format</dt><dd>${escapeHtml(job.InputFormat)}</dd><dt>Compression</dt><dd>${escapeHtml(job.InputCompressionType)}</dd><dt>Errors</dt><dd>${Number(job.ErrorCount ?? 0)}</dd><dt>Completed</dt><dd>${escapeHtml(dynamoDate(job.EndTime))}</dd></dl></div><div class="field"><label>Import ARN</label><textarea class="code-editor" readonly>${escapeHtml(job.ImportArn)}</textarea></div>`, "Close", async () => {}); }));
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
  return ({ KEYS_ONLY: "Keys only", NEW_IMAGE: "New image", OLD_IMAGE: "Old image", NEW_AND_OLD_IMAGES: "New and old images" })[value] ?? "–";
}

function kinesisPrecisionLabel(value) {
  return value === "MICROSECOND" ? "Microsecond" : value === "MILLISECOND" ? "Millisecond" : "–";
}

function kinesisDestinationCard(destination) {
  const connected = Boolean(destination); const status = destination?.DestinationStatus ?? "DISABLED"; const changing = ["ENABLING", "DISABLING", "UPDATING"].includes(status); const active = status === "ACTIVE";
  const actions = active ? '<button class="button" data-action="edit-kinesis-destination">Change precision</button><button class="button danger" data-action="disable-kinesis-destination">Turn off</button>' : changing ? '<button class="button" disabled>Change in progress</button>' : '<button class="button primary" data-action="enable-kinesis-destination">Connect Kinesis data stream</button>';
  return `<section class="card kinesis-destination-card" data-kinesis-destination="${escapeHtml(encodeURIComponent(JSON.stringify(destination ?? null)))}"><div class="card-header"><div><h2>Kinesis data stream destination</h2><p class="muted small">Store one same-account, same-Region destination for this table.</p></div><div class="actions">${actions}</div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Destination status</dt><dd><span class="status ${changing ? "pending" : active ? "" : "inactive"}">${connected ? escapeHtml(status) : "Not connected"}</span></dd><dt>Timestamp precision</dt><dd>${escapeHtml(kinesisPrecisionLabel(destination?.ApproximateCreationDateTimePrecision))}</dd></dl><dl class="key-value"><dt>Kinesis stream ARN</dt><dd class="mono">${escapeHtml(destination?.StreamArn ?? "–")}</dd><dt>Status detail</dt><dd>${escapeHtml(destination?.DestinationStatusDescription ?? "No destination is configured.")}</dd></dl></div><div class="alert info"><strong>Configuration only</strong><br>No Kinesis service is running locally, so table writes do not deliver records. This setting persists for SDK and console learning.</div></div></section>`;
}

async function dynamoStreamsView(table) {
  const enabled = table.StreamSpecification?.StreamEnabled === true; const view = table.StreamSpecification?.StreamViewType; const [ExportSummaries, kinesis, mapped] = await Promise.all([collectDynamoPages("ListExports", { TableArn: table.TableArn, MaxResults: 25 }, "ExportSummaries", "NextToken", "NextToken"), dynamo("DescribeKinesisStreamingDestination", { TableName: table.TableName }), enabled ? rest(`/2015-03-31/event-source-mappings?EventSourceArn=${encodeURIComponent(table.LatestStreamArn)}&MaxItems=100`) : Promise.resolve({ EventSourceMappings: [] })]); const mappings = mapped.EventSourceMappings ?? []; const exports = await Promise.all(ExportSummaries.map(summary => dynamo("DescribeExport", { ExportArn: summary.ExportArn }).then(result => result.ExportDescription))); const exportSection = `<section class="card export-card"><div class="card-header"><div><h2>Point-in-time exports <span class="muted">(${exports.length})</span></h2><p class="muted small">Full table snapshots in DynamoDB JSON Lines with provider-compatible manifests.</p></div><button class="button primary" data-action="create-export">Export to local files</button></div><div class="table-wrap">${exportRows(exports)}</div><div class="card-body"><div class="alert info"><strong>Local simulator extension</strong><br>Exports require PITR and an opted-in file:// bucket. No S3 request is made.</div></div></section>`; const destination = kinesis.KinesisDataStreamDestinations?.[0];
  const actions = enabled ? '<button class="button" data-action="edit-stream">Manage stream</button><button class="button danger" data-action="disable-stream">Turn off</button>' : '<button class="button primary" data-action="enable-stream">Turn on</button>';
  const triggerRows = mappings.map(mapping => { const target = mapping.FunctionArn?.split(":function:")[1]?.split(":")[0] ?? mapping.FunctionArn; return `<tr><td><a href="#/lambda/functions/${encodeURIComponent(target)}">${escapeHtml(target)}</a></td><td><span class="status ${mapping.State === "Disabled" ? "inactive" : ""}">${escapeHtml(mapping.State)}</span></td><td>${mapping.BatchSize} · ${mapping.MaximumBatchingWindowInSeconds}s</td><td>${escapeHtml(mapping.StartingPosition)}</td><td>${escapeHtml(mapping.LastProcessingResult || "No records processed")}</td><td><a class="button link" href="#/lambda/functions/${encodeURIComponent(target)}">View mapping</a></td></tr>`; }).join("");
  const triggerContent = !enabled ? '<div class="card-body"><p class="muted">Turn on the DynamoDB stream before creating a Lambda trigger.</p></div>' : mappings.length ? `<div class="table-wrap"><table><thead><tr><th>Function</th><th>State</th><th>Batch</th><th>Starting position</th><th>Last result</th><th>Actions</th></tr></thead><tbody>${triggerRows}</tbody></table></div><div class="card-body"><div class="alert info"><strong>Durable Lambda consumption</strong><br>Open the function overview to edit, pause, or delete a mapping and inspect its checkpoint status.</div></div>` : `<div class="table-wrap">${emptyState("↯", "No Lambda triggers", "Create an event source mapping for this enabled stream.")}</div>`;
  return `<section class="card stream-card"><div class="card-header"><div><h2>DynamoDB stream details</h2><p class="muted small">Capture an ordered record whenever an item changes.</p></div><div class="actions">${actions}</div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Stream status</dt><dd><span class="status ${enabled ? "" : "inactive"}">${enabled ? "On" : "Off"}</span></dd><dt>View type</dt><dd>${escapeHtml(streamViewLabel(view))}</dd></dl><dl class="key-value"><dt>Latest stream label</dt><dd class="mono">${escapeHtml(table.LatestStreamLabel ?? "–")}</dd><dt>Latest stream ARN</dt><dd class="mono">${escapeHtml(table.LatestStreamArn ?? "–")}</dd></dl></div><div class="alert info"><strong>Local stream behavior</strong><br>One deterministic shard preserves successful single-item, batch, transaction, PartiQL, and TTL mutations. Signed iterators expire after 15 minutes; records default to 24-hour retention.</div></div></section>${kinesisDestinationCard(destination)}<section class="card trigger-card"><div class="card-header"><div><h2>Lambda triggers <span class="muted">(${mappings.length})</span></h2><p class="muted small">Invoke a function from batches of records in this DynamoDB stream.</p></div><button class="button primary" data-action="create-stream-trigger" ${enabled ? "" : "disabled"}>Create trigger</button></div>${triggerContent}</section>${exportSection}`;
}

function bindTableStreams(context, table) {
  const { showModal, toast } = context; const enabled = table.StreamSpecification?.StreamEnabled === true; const current = table.StreamSpecification?.StreamViewType ?? "NEW_AND_OLD_IMAGES"; const destination = JSON.parse(decodeURIComponent(document.querySelector(".kinesis-destination-card")?.dataset.kinesisDestination ?? encodeURIComponent("null")));
  const viewField = value => `<div class="field"><label>Stream view type</label><select name="view">${[["KEYS_ONLY", "Keys only"], ["NEW_IMAGE", "New image"], ["OLD_IMAGE", "Old image"], ["NEW_AND_OLD_IMAGES", "New and old images"]].map(([option, label]) => `<option value="${option}" ${value === option ? "selected" : ""}>${label}</option>`).join("")}</select><span class="hint">Every record contains the table key. Image options add the item before or after the successful write.</span></div><div class="alert info"><strong>New stream descriptor</strong><br>Changing the view type creates a new stream ARN. The previous descriptor remains readable until local retention expires.</div>`;
  document.querySelector('[data-action="enable-stream"]')?.addEventListener("click", () => showModal("Turn on DynamoDB stream", viewField(current), "Turn on", async data => { await dynamo("UpdateTable", { TableName: table.TableName, StreamSpecification: { StreamEnabled: true, StreamViewType: data.get("view") } }); toast("DynamoDB stream is turning on"); }));
  document.querySelector('[data-action="edit-stream"]')?.addEventListener("click", () => showModal("Manage DynamoDB stream", viewField(current), "Save changes", async data => { if (data.get("view") === current) throw new Error("Choose a different stream view type"); await dynamo("UpdateTable", { TableName: table.TableName, StreamSpecification: { StreamEnabled: true, StreamViewType: data.get("view") } }); toast("A new DynamoDB stream is being enabled"); }));
  document.querySelector('[data-action="disable-stream"]')?.addEventListener("click", () => showModal("Turn off DynamoDB stream", `<div class="alert error"><strong>New item changes will stop being captured</strong><br>The current descriptor remains readable only through its local retention window.</div><p>Turn off the stream for <strong>${escapeHtml(table.TableName)}</strong>?</p><div class="field"><label class="checkbox-label"><input type="checkbox" name="acknowledge" value="yes" required> I acknowledge that Lambda triggers would stop receiving new records.</label></div>`, "Turn off", async data => { if (data.get("acknowledge") !== "yes") throw new Error("Acknowledge the effect of turning off the stream"); await dynamo("UpdateTable", { TableName: table.TableName, StreamSpecification: { StreamEnabled: false } }); toast("DynamoDB stream is turning off"); }, false, { danger: true }));
  const precisionField = value => `<div class="field"><label>Approximate creation time precision</label><select name="precision"><option value="MILLISECOND" ${value !== "MICROSECOND" ? "selected" : ""}>Millisecond (default)</option><option value="MICROSECOND" ${value === "MICROSECOND" ? "selected" : ""}>Microsecond</option></select><span class="hint">Controls timestamp precision in the stored destination configuration.</span></div>`;
  document.querySelector('[data-action="enable-kinesis-destination"]')?.addEventListener("click", () => showModal("Connect Kinesis data stream", `<div class="field"><label>Kinesis data stream ARN</label><input name="streamArn" required placeholder="arn:aws:kinesis:${escapeHtml(session.region)}:000000000000:stream/learning-events"><span class="hint">The stream must use this simulator account and Region.</span></div>${precisionField(destination?.ApproximateCreationDateTimePrecision)}<div class="alert info"><strong>Configuration only</strong><br>The destination is persisted, but no Kinesis service is running and no table records are delivered.</div>`, "Connect stream", async data => { await dynamo("EnableKinesisStreamingDestination", { TableName: table.TableName, StreamArn: data.get("streamArn"), EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: data.get("precision") } }); toast("Kinesis destination is being enabled"); await new Promise(resolve => setTimeout(resolve, 80)); }));
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
  return `<section class="card capacity-card"><div class="card-header"><div><h2>Read/write capacity</h2><p class="muted small">Configure on-demand limits or provisioned capacity units.</p></div><button class="button primary" data-action="edit-capacity">Edit capacity</button></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Capacity mode</dt><dd>${mode === "PAY_PER_REQUEST" ? "On-demand" : "Provisioned"}</dd><dt>Billing mode value</dt><dd class="mono">${escapeHtml(mode)}</dd></dl><dl class="key-value"><dt>${mode === "PROVISIONED" ? "Read capacity units" : "Maximum read request units"}</dt><dd>${mode === "PROVISIONED" ? provisioned.ReadCapacityUnits ?? 0 : onDemand.MaxReadRequestUnits ?? "Unlimited"}</dd><dt>${mode === "PROVISIONED" ? "Write capacity units" : "Maximum write request units"}</dt><dd>${mode === "PROVISIONED" ? provisioned.WriteCapacityUnits ?? 0 : onDemand.MaxWriteRequestUnits ?? "Unlimited"}</dd></dl><dl class="key-value"><dt>Warm read throughput</dt><dd>${warm?.ReadUnitsPerSecond ?? "Service default"}</dd><dt>Warm write throughput</dt><dd>${warm?.WriteUnitsPerSecond ?? "Service default"}${warm?.Status ? ` · ${escapeHtml(warm.Status)}` : ""}</dd></dl></div><div class="alert info capacity-local-note"><strong>Local capacity behavior</strong><br>Capacity is descriptive by default. Set <span class="mono">STACKSIM_DDB_ENFORCE_CAPACITY=true</span> to enable deterministic token-bucket throttling for learning.</div></div></section><section class="card"><div class="card-header"><div><h2>Auto scaling</h2><p class="muted small">Stored target-tracking descriptors for provisioned tables.</p></div><button class="button" data-action="configure-auto-scaling" ${mode === "PROVISIONED" ? "" : "disabled"}>Configure auto scaling</button></div><div class="card-body">${mode !== "PROVISIONED" ? `<p class="muted">Switch to provisioned capacity to configure auto scaling.</p>` : autoRead || autoWrite ? `<div class="detail-grid"><dl class="key-value"><dt>Read range</dt><dd>${autoRead ? `${autoRead.MinimumUnits}–${autoRead.MaximumUnits}` : "Not configured"}</dd><dt>Read target</dt><dd>${autoRead?.ScalingPolicies?.[0]?.TargetTrackingScalingPolicyConfiguration?.TargetValue ?? "–"}%</dd></dl><dl class="key-value"><dt>Write range</dt><dd>${autoWrite ? `${autoWrite.MinimumUnits}–${autoWrite.MaximumUnits}` : "Not configured"}</dd><dt>Write target</dt><dd>${autoWrite?.ScalingPolicies?.[0]?.TargetTrackingScalingPolicyConfiguration?.TargetValue ?? "–"}%</dd></dl></div>` : `<p class="muted">No auto scaling descriptors are configured.</p>`}<p class="muted small">The simulator stores and returns these settings but does not call Application Auto Scaling.</p></div></section>`;
}

function bindCapacity(context, table) {
  const { showModal, toast } = context; const mode = table.BillingModeSummary?.BillingMode ?? "PROVISIONED"; const provisioned = table.ProvisionedThroughput ?? {}; const onDemand = table.OnDemandThroughput ?? {}; const warm = table.WarmThroughput ?? {};
  document.querySelector('[data-action="edit-capacity"]')?.addEventListener("click", () => showModal("Edit read/write capacity", `<div class="field"><label>Capacity mode</label><select name="mode"><option value="PAY_PER_REQUEST" ${mode === "PAY_PER_REQUEST" ? "selected" : ""}>On-demand</option><option value="PROVISIONED" ${mode === "PROVISIONED" ? "selected" : ""}>Provisioned</option></select></div><div class="field-row"><div class="field"><label>Read capacity / maximum</label><input name="read" type="number" min="1" value="${mode === "PROVISIONED" ? provisioned.ReadCapacityUnits ?? 5 : onDemand.MaxReadRequestUnits ?? ""}" placeholder="Unlimited for on-demand"><span class="hint">Required capacity units in provisioned mode; optional maximum in on-demand mode.</span></div><div class="field"><label>Write capacity / maximum</label><input name="write" type="number" min="1" value="${mode === "PROVISIONED" ? provisioned.WriteCapacityUnits ?? 5 : onDemand.MaxWriteRequestUnits ?? ""}" placeholder="Unlimited for on-demand"></div></div><h3>Warm throughput <span class="muted small">– optional</span></h3><div class="field-row"><div class="field"><label>Warm read units per second</label><input name="warmRead" type="number" min="1" value="${warm.ReadUnitsPerSecond ?? ""}"></div><div class="field"><label>Warm write units per second</label><input name="warmWrite" type="number" min="1" value="${warm.WriteUnitsPerSecond ?? ""}"></div></div>`, "Save changes", async data => {
    const selected = String(data.get("mode")); const read = Number(data.get("read")); const write = Number(data.get("write")); const request = { TableName: table.TableName, ...(selected !== mode ? { BillingMode: selected } : {}) };
    if (selected === "PROVISIONED") { if (!read || !write) throw new Error("Read and write capacity are required in provisioned mode"); request.ProvisionedThroughput = { ReadCapacityUnits: read, WriteCapacityUnits: write }; }
    else { const max = {}; const readRaw = String(data.get("read") ?? ""); const writeRaw = String(data.get("write") ?? ""); if (readRaw) max.MaxReadRequestUnits = read; else if (onDemand.MaxReadRequestUnits !== undefined) max.MaxReadRequestUnits = -1; if (writeRaw) max.MaxWriteRequestUnits = write; else if (onDemand.MaxWriteRequestUnits !== undefined) max.MaxWriteRequestUnits = -1; if (Object.keys(max).length) request.OnDemandThroughput = max; }
    const warmRead = Number(data.get("warmRead")); const warmWrite = Number(data.get("warmWrite")); if (warmRead || warmWrite) { if (!warmRead || !warmWrite) throw new Error("Enter both warm throughput values"); request.WarmThroughput = { ReadUnitsPerSecond: warmRead, WriteUnitsPerSecond: warmWrite }; }
    await dynamo("UpdateTable", request); toast("Capacity settings are updating");
  }, true));
  document.querySelector('[data-action="configure-auto-scaling"]')?.addEventListener("click", () => showModal("Configure auto scaling", `<p>Store a local target-tracking descriptor for table reads and writes.</p><div class="field-row"><div class="field"><label>Minimum capacity units</label><input name="minimum" type="number" min="1" value="1" required></div><div class="field"><label>Maximum capacity units</label><input name="maximum" type="number" min="1" value="10" required></div></div><div class="field"><label>Target utilization (%)</label><input name="target" type="number" min="1" max="100" value="70" required></div><div class="alert info"><strong>Configuration storage only</strong><br>No Application Auto Scaling service runs locally; the SDK descriptor is persisted for learning and inspection.</div>`, "Save auto scaling", async data => {
    const setting = { MinimumUnits: Number(data.get("minimum")), MaximumUnits: Number(data.get("maximum")), AutoScalingDisabled: false, ScalingPolicyUpdate: { PolicyName: `${table.TableName}-target`, TargetTrackingScalingPolicyConfiguration: { TargetValue: Number(data.get("target")), DisableScaleIn: false, ScaleInCooldown: 0, ScaleOutCooldown: 0 } } }; await dynamo("UpdateTableReplicaAutoScaling", { TableName: table.TableName, ProvisionedWriteCapacityAutoScalingUpdate: setting, ReplicaUpdates: [{ RegionName: session.region, ReplicaProvisionedReadCapacityAutoScalingUpdate: setting }] }); toast("Auto scaling settings saved");
  }));
}

async function dynamoTagsView(table) {
  const tags = (await dynamo("ListTagsOfResource", { ResourceArn: table.TableArn })).Tags ?? [];
  return `<section class="card tags-card" data-table-tags="${escapeHtml(encodeURIComponent(JSON.stringify(Object.fromEntries(tags.map(tag => [tag.Key, tag.Value])))))}"><div class="card-header"><div><h2>Tags <span class="muted">(${tags.length})</span></h2><p class="muted small">Case-sensitive metadata associated with this table.</p></div><button class="button primary" data-action="manage-table-tags">Manage tags</button></div><div class="table-wrap">${tags.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(tag => `<tr><td>${escapeHtml(tag.Key)}</td><td>${escapeHtml(tag.Value)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No tags", "Add tags to organize and identify this table.")}</div></section>`;
}

function bindTableTags(context, table) {
  const { showModal, toast } = context; let current = {}; try { current = JSON.parse(decodeURIComponent(document.querySelector(".tags-card")?.dataset.tableTags ?? "%7B%7D")); } catch {}
  document.querySelector('[data-action="manage-table-tags"]')?.addEventListener("click", () => showModal("Manage table tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags" class="code-editor">${escapeHtml(JSON.stringify(current, null, 2))}</textarea><span class="hint">Up to 50 case-sensitive key/value pairs. Keys beginning with aws: are reserved.</span></div>`, "Save tags", async data => {
    let next; try { next = JSON.parse(String(data.get("tags") ?? "{}")); } catch { throw new Error("Tags must be valid JSON"); } if (!next || Array.isArray(next) || typeof next !== "object" || Object.values(next).some(value => typeof value !== "string")) throw new Error("Tags must be a JSON object with string values"); const removed = Object.keys(current).filter(key => !(key in next)); if (removed.length) await dynamo("UntagResource", { ResourceArn: table.TableArn, TagKeys: removed }); const changed = Object.entries(next).filter(([key, value]) => current[key] !== value).map(([Key, Value]) => ({ Key, Value })); if (changed.length) await dynamo("TagResource", { ResourceArn: table.TableArn, Tags: changed }); toast("Tags updated");
  }));
}

async function dynamoTableBackupsView(table) {
  const [continuous, backups] = await Promise.all([dynamo("DescribeContinuousBackups", { TableName: table.TableName }), collectDynamoPages("ListBackups", { TableName: table.TableName, BackupType: "USER", Limit: 100 }, "BackupSummaries", "ExclusiveStartBackupArn", "LastEvaluatedBackupArn")]); const pitr = continuous.ContinuousBackupsDescription?.PointInTimeRecoveryDescription ?? { PointInTimeRecoveryStatus: "DISABLED", RecoveryPeriodInDays: 35 }; const enabled = pitr.PointInTimeRecoveryStatus === "ENABLED";
  return `<section class="card pitr-card" data-pitr="${escapeHtml(encodeURIComponent(JSON.stringify(pitr)))}"><div class="card-header"><div><h2>Point-in-time recovery (PITR)</h2><p class="muted small">Continuously journal item changes for second-resolution restore points.</p></div><div class="actions">${enabled ? '<button class="button" data-action="edit-pitr">Edit</button><button class="button danger" data-action="disable-pitr">Turn off</button><button class="button primary" data-action="restore-pitr">Restore</button>' : '<button class="button primary" data-action="enable-pitr">Turn on</button>'}</div></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>PITR status</dt><dd><span class="status ${enabled ? "" : "inactive"}">${enabled ? "On" : "Off"}</span></dd><dt>Recovery period</dt><dd>${pitr.RecoveryPeriodInDays ?? 35} day${pitr.RecoveryPeriodInDays === 1 ? "" : "s"}</dd></dl><dl class="key-value"><dt>Earliest restore point</dt><dd>${escapeHtml(dynamoDate(pitr.EarliestRestorableDateTime))}</dd><dt>Latest restore point</dt><dd>${escapeHtml(dynamoDate(pitr.LatestRestorableDateTime))}</dd></dl></div><div class="alert info"><strong>Local recovery timing</strong><br>Restore points are available through the latest completed local second. The hosted service typically reports a latest restorable time about five minutes behind.</div></div></section><section class="card"><div class="card-header"><div><h2>On-demand backups <span class="muted">(${backups.length})</span></h2><p class="muted small">Immutable snapshots created for this table.</p></div><button class="button primary" data-action="create-backup">Create backup</button></div><div class="table-wrap">${backupRows(backups)}</div></section>`;
}

function bindTableBackups(context, table) {
  const { showModal, toast } = context; let pitr = {}; try { pitr = JSON.parse(decodeURIComponent(document.querySelector(".pitr-card")?.dataset.pitr ?? "%7B%7D")); } catch {} const enabled = pitr.PointInTimeRecoveryStatus === "ENABLED";
  bindCreateBackup(context, [table.TableName], table.TableName); const backups = [...document.querySelectorAll("[data-backup-detail]")].map(button => ({ BackupArn: decodeURIComponent(button.dataset.backupDetail), BackupName: button.textContent.trim(), TableName: table.TableName, BackupStatus: button.closest("tr")?.querySelector(".status")?.textContent.trim() })); bindBackupActions(context, backups);
  const periodForm = value => `<div class="field"><label>Recovery period</label><select name="period">${[1, 7, 14, 21, 35].map(days => `<option value="${days}" ${Number(value) === days ? "selected" : ""}>${days} day${days === 1 ? "" : "s"}</option>`).join("")}</select><span class="hint">DynamoDB supports a retained window from 1 through 35 days.</span></div><div class="alert info"><strong>Append-only local journal</strong><br>Successful item, batch, transaction, PartiQL, and TTL mutations are captured while PITR is on.</div>`;
  document.querySelector('[data-action="enable-pitr"]')?.addEventListener("click", () => showModal("Turn on point-in-time recovery", periodForm(35), "Turn on", async data => { await dynamo("UpdateContinuousBackups", { TableName: table.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: Number(data.get("period")) } }); toast("Point-in-time recovery turned on"); }));
  document.querySelector('[data-action="edit-pitr"]')?.addEventListener("click", () => showModal("Edit point-in-time recovery", periodForm(pitr.RecoveryPeriodInDays), "Save changes", async data => { await dynamo("UpdateContinuousBackups", { TableName: table.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: Number(data.get("period")) } }); toast("Recovery period updated"); }));
  document.querySelector('[data-action="disable-pitr"]')?.addEventListener("click", () => showModal("Turn off point-in-time recovery", `<div class="alert error"><strong>Restore history will reset</strong><br>Turning PITR on again begins a new local recovery window.</div><p>Turn off point-in-time recovery for <strong>${escapeHtml(table.TableName)}</strong>?</p><div class="field"><label class="checkbox-label"><input type="checkbox" name="acknowledge" value="yes" required> I understand earlier restore points will not be available after re-enabling.</label></div>`, "Turn off", async data => { if (data.get("acknowledge") !== "yes") throw new Error("Acknowledge the recovery-history reset"); await dynamo("UpdateContinuousBackups", { TableName: table.TableName, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } }); toast("Point-in-time recovery turned off"); }, false, { danger: true }));
  document.querySelector('[data-action="restore-pitr"]')?.addEventListener("click", () => showModal("Restore table to a point in time", `<div class="alert info"><strong>Restore to a new table</strong><br>The source table and its journal remain unchanged.</div><div class="field"><label>New table name</label><input name="target" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="${escapeHtml(table.TableName)}-point-restore"></div><div class="field"><label>Restore point</label><select name="point"><option value="latest">Latest restorable time</option><option value="custom">Specific date and time</option></select></div><div class="field"><label>Specific date and time <span class="muted small">– required when selected</span></label><input name="time" type="datetime-local" step="1"><span class="hint">Available range: ${escapeHtml(dynamoDate(pitr.EarliestRestorableDateTime))} through ${escapeHtml(dynamoDate(pitr.LatestRestorableDateTime))}.</span></div><p class="muted">Current indexes, billing, capacity, and encryption are copied. Tags, TTL, streams, auto scaling, and PITR are not copied.</p>`, "Restore table", async data => { const target = String(data.get("target")); const latest = data.get("point") === "latest"; const time = String(data.get("time") ?? ""); if (!latest && !time) throw new Error("Choose a specific restore date and time"); await dynamo("RestoreTableToPointInTime", { SourceTableName: table.TableName, TargetTableName: target, ...(latest ? { UseLatestRestorableTime: true } : { RestoreDateTime: new Date(time).getTime() / 1000 }) }); toast("Point-in-time restore started"); location.hash = `#/dynamodb/tables/${encodeURIComponent(target)}/overview`; }));
  if (!enabled) document.querySelector('[data-action="restore-pitr"]')?.setAttribute("disabled", "");
}

async function dynamoSettingsView(table) {
  const ttl = (await dynamo("DescribeTimeToLive", { TableName: table.TableName })).TimeToLiveDescription ?? { TimeToLiveStatus: "DISABLED" };
  const status = ttl.TimeToLiveStatus ?? "DISABLED"; const enabled = status === "ENABLED"; const disabled = status === "DISABLED"; const pending = !enabled && !disabled;
  const statusLabel = ({ ENABLED: "On", DISABLED: "Off", ENABLING: "Turning on", DISABLING: "Turning off" })[status] ?? status;
  const actions = pending
    ? '<button class="button" data-action="refresh-ttl">Refresh</button>'
    : enabled
      ? '<button class="button" data-action="edit-ttl">Edit</button><button class="button danger" data-action="disable-ttl">Turn off</button>'
      : '<button class="button primary" data-action="enable-ttl">Turn on</button>';
  const tableClass = table.TableClassSummary?.TableClass ?? "STANDARD"; const protectedTable = table.DeletionProtectionEnabled === true; const sse = table.SSEDescription ?? { SSEType: "AES256", Status: "ENABLED" }; const kmsPending = sse.SSEType === "KMS" && sse.Status !== "ENABLED";
  return `<section class="card"><div class="card-header"><div><h2>Table class</h2><p class="muted small">Choose the storage pricing class for this table.</p></div><button class="button" data-action="edit-table-class">Edit</button></div><div class="card-body detail-grid"><dl class="key-value"><dt>Table class</dt><dd>${tableClass === "STANDARD" ? "DynamoDB Standard" : "DynamoDB Standard-Infrequent Access"}</dd><dt>API value</dt><dd class="mono">${escapeHtml(tableClass)}</dd></dl><dl class="key-value"><dt>Last updated</dt><dd>${table.TableClassSummary?.LastUpdateDateTime ? new Date(table.TableClassSummary.LastUpdateDateTime).toLocaleString() : "Created with table"}</dd></dl></div></section><section class="card"><div class="card-header"><div><h2>Deletion protection</h2><p class="muted small">Prevent accidental deletion through the API and console.</p></div><button class="button" data-action="edit-deletion-protection">Edit</button></div><div class="card-body"><span class="status ${protectedTable ? "" : "inactive"}">${protectedTable ? "On" : "Off"}</span>${protectedTable ? '<p class="muted">Disable protection before deleting this table.</p>' : ""}</div></section><section class="card"><div class="card-header"><div><h2>Encryption at rest</h2><p class="muted small">All local table state is protected by filesystem permissions.</p></div><button class="button" data-action="edit-encryption">Manage encryption</button></div><div class="card-body"><div class="detail-grid"><dl class="key-value"><dt>Encryption type</dt><dd>${sse.SSEType === "AES256" ? "service-owned key (local AES256 descriptor)" : "KMS key configuration"}</dd><dt>Status</dt><dd><span class="status ${kmsPending ? "pending" : ""}">${kmsPending ? "Dependency blocked" : escapeHtml(sse.Status)}</span></dd></dl><dl class="key-value"><dt>KMS key</dt><dd class="mono">${escapeHtml(sse.KMSMasterKeyArn ?? "–")}</dd></dl></div>${kmsPending ? '<div class="alert info"><strong>KMS is not available locally</strong><br>The requested key is stored as configuration but is not reported as active encryption.</div>' : ""}</div></section><section class="card ttl-card"><div class="card-header"><div><h2>Time to Live (TTL)</h2><p class="muted small">Automatically delete expired items without consuming write throughput.</p></div><div class="actions">${actions}</div></div><div class="card-body"><div class="detail-grid ttl-details"><dl class="key-value"><dt>TTL status</dt><dd><span class="status ${disabled ? "inactive" : pending ? "pending" : ""}">${escapeHtml(statusLabel)}</span></dd></dl><dl class="key-value"><dt>TTL attribute</dt><dd class="mono">${escapeHtml(ttl.AttributeName ?? "–")}</dd></dl><dl class="key-value"><dt>Expiration format</dt><dd>Number · Unix epoch time in seconds</dd></dl></div><p class="muted ttl-explanation">DynamoDB evaluates the case-sensitive TTL attribute on each item. Items without the attribute, with another data type, or with a future timestamp remain in the table.</p><div class="alert info ttl-local-note"><strong>Expiration timing</strong><br>In the hosted service, expired items are typically deleted within a few days. This local simulator uses a configurable short sweep interval for deterministic development and tests.</div></div></section>`;
}

function bindTableSettings(context, table) {
  const { showModal, toast } = context; const tableClass = table.TableClassSummary?.TableClass ?? "STANDARD";
  document.querySelector('[data-action="edit-table-class"]')?.addEventListener("click", () => showModal("Edit table class", `<div class="field"><label>Table class</label><select name="tableClass"><option value="STANDARD" ${tableClass === "STANDARD" ? "selected" : ""}>DynamoDB Standard</option><option value="STANDARD_INFREQUENT_ACCESS" ${tableClass === "STANDARD_INFREQUENT_ACCESS" ? "selected" : ""}>DynamoDB Standard-Infrequent Access</option></select><span class="hint">The class is stored for API and console fidelity; local storage has no usage charge.</span></div>`, "Save changes", async data => { await dynamo("UpdateTable", { TableName: table.TableName, TableClass: data.get("tableClass") }); toast("Table class is updating"); }));
  document.querySelector('[data-action="edit-deletion-protection"]')?.addEventListener("click", () => showModal("Edit deletion protection", `<div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" ${table.DeletionProtectionEnabled ? "checked" : ""}> Enable deletion protection</label><span class="hint">DeleteTable is rejected until protection is turned off.</span></div>`, "Save changes", async data => { const enabled = data.get("enabled") === "yes"; await dynamo("UpdateTable", { TableName: table.TableName, DeletionProtectionEnabled: enabled }); toast(`Deletion protection ${enabled ? "enabled" : "disabled"}`); }));
  document.querySelector('[data-action="edit-encryption"]')?.addEventListener("click", () => showModal("Manage encryption", `<div class="field"><label>Encryption key type</label><select name="type"><option value="AES256" ${table.SSEDescription?.SSEType !== "KMS" ? "selected" : ""}>service-owned key</option><option value="KMS" ${table.SSEDescription?.SSEType === "KMS" ? "selected" : ""}>service-managed or customer managed KMS key</option></select></div><div class="field"><label>KMS key ID, ARN, or alias <span class="muted small">– optional for service-managed key</span></label><input name="kmsKey" value="${escapeHtml(table.SSEDescription?.KMSMasterKeyArn ?? "")}" placeholder="alias/aws/dynamodb"></div><div class="alert info"><strong>Local encryption boundary</strong><br>KMS is not implemented. KMS selections are persisted as dependency-blocked configuration and never reported as active.</div>`, "Save encryption", async data => { const type = data.get("type"); await dynamo("UpdateTable", { TableName: table.TableName, SSESpecification: type === "KMS" ? { Enabled: true, SSEType: "KMS", ...(String(data.get("kmsKey") ?? "") ? { KMSMasterKeyId: String(data.get("kmsKey")) } : {}) } : { Enabled: false } }); toast("Encryption configuration is updating"); }));
}

function bindTtlSettings(context, table) {
  const { route, showModal, toast } = context; const stagedKey = `stacksim:dynamodb:ttl-edit:${table.TableArn}`;
  const turnOn = () => {
    const staged = sessionStorage.getItem(stagedKey) ?? "";
    showModal("Turn on Time to Live (TTL)", `<p>Choose the item attribute that contains each expiration timestamp.</p><div class="field"><label>TTL attribute name</label><input name="attributeName" maxlength="255" value="${escapeHtml(staged)}" placeholder="expiresAt" required><span class="hint">Attribute names are case sensitive. The value must be a Number containing Unix epoch time in seconds.</span></div><div class="alert info"><strong>Before you turn on TTL</strong><br>Expired items remain visible until they are deleted. Missing attributes and values with any other DynamoDB data type are ignored.</div>`, "Turn on", async data => {
      const attributeName = String(data.get("attributeName") ?? "");
      await dynamo("UpdateTimeToLive", { TableName: table.TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: attributeName } });
      sessionStorage.removeItem(stagedKey); toast("Time to Live is turning on");
    });
  };
  document.querySelector('[data-action="enable-ttl"]')?.addEventListener("click", turnOn);
  document.querySelector('[data-action="refresh-ttl"]')?.addEventListener("click", route);
  document.querySelector('[data-action="disable-ttl"]')?.addEventListener("click", async () => {
    const ttl = (await dynamo("DescribeTimeToLive", { TableName: table.TableName })).TimeToLiveDescription;
    showModal("Turn off Time to Live (TTL)", `<div class="alert error"><strong>Expired items can remain in the table</strong><br>Items that expire after TTL is off will not be deleted automatically.</div><p>Turn off TTL for <strong>${escapeHtml(table.TableName)}</strong> using the <span class="mono">${escapeHtml(ttl.AttributeName)}</span> attribute?</p><div class="field"><label class="checkbox-label"><input type="checkbox" name="acknowledge" value="yes" required> I acknowledge that automatic expiration will stop.</label></div>`, "Turn off", async data => {
      if (data.get("acknowledge") !== "yes") throw new Error("Acknowledge the effect of turning off TTL");
      await dynamo("UpdateTimeToLive", { TableName: table.TableName, TimeToLiveSpecification: { Enabled: false, AttributeName: ttl.AttributeName } }); toast("Time to Live is turning off");
    }, false, { danger: true });
  });
  document.querySelector('[data-action="edit-ttl"]')?.addEventListener("click", async () => {
    const ttl = (await dynamo("DescribeTimeToLive", { TableName: table.TableName })).TimeToLiveDescription;
    showModal("Edit Time to Live (TTL)", `<div class="alert info"><strong>Changing the TTL attribute takes two steps</strong><br>DynamoDB requires TTL to be turned off before a different attribute can be enabled.</div><div class="field"><label>Current TTL attribute</label><input value="${escapeHtml(ttl.AttributeName)}" disabled></div><div class="field"><label>New TTL attribute name</label><input name="attributeName" maxlength="255" placeholder="removeAfter" required><span class="hint">The new name is saved in this browser and prefilled when the table is ready to turn TTL on again.</span></div>`, "Turn off and continue", async data => {
      const attributeName = String(data.get("attributeName") ?? ""); if (attributeName === ttl.AttributeName) throw new Error("Enter a different TTL attribute name");
      sessionStorage.setItem(stagedKey, attributeName);
      await dynamo("UpdateTimeToLive", { TableName: table.TableName, TimeToLiveSpecification: { Enabled: false, AttributeName: ttl.AttributeName } }); toast("TTL is turning off. Turn it on with the new attribute when the status is Off.");
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

function dynamoOverviewView(table) {
  const partition = table.KeySchema.find(key => key.KeyType === "HASH");
  const sort = table.KeySchema.find(key => key.KeyType === "RANGE");
  return `<div class="card"><div class="card-header"><h2>General information</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Table status</dt><dd><span class="status">${escapeHtml(table.TableStatus)}</span></dd><dt>Table ARN</dt><dd class="mono">${escapeHtml(table.TableArn)}</dd></dl><dl class="key-value"><dt>Partition key</dt><dd>${escapeHtml(partition?.AttributeName)} (${attributeType(table, partition?.AttributeName)})</dd><dt>Sort key</dt><dd>${sort ? `${escapeHtml(sort.AttributeName)} (${attributeType(table, sort.AttributeName)})` : "–"}</dd></dl><dl class="key-value"><dt>Item count</dt><dd>${table.ItemCount}</dd><dt>Table size</dt><dd>${Number(table.TableSizeBytes).toLocaleString()} bytes</dd></dl></div></div><div class="card"><div class="card-header"><h2>Capacity</h2></div><div class="card-body"><p><strong>Capacity mode:</strong> ${escapeHtml(table.BillingModeSummary?.BillingMode ?? "PROVISIONED")}</p><p class="muted">Capacity consumption is not charged in the local environment.</p></div></div>`;
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
