import { dynamo, metrics } from "../api-client.js";
import { escapeHtml, metricChart, pageHeader } from "../components.js";
import { setDirty } from "../state.js";

let indexRowId = 0;

export async function enhancedDynamoCreateTable(context) {
  const { main, setChrome, showError, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "Tables", "Create table"]);
  main.innerHTML = `<div class="page-width create-table-page"><form id="create-table-form">${pageHeader("Create table", "Create a DynamoDB table with a primary key and optional indexes.")}<div id="create-table-error" class="alert error" role="alert" tabindex="-1" hidden></div><section class="card"><div class="card-header"><div><h2>Table details</h2><p class="muted small">DynamoDB is a schemaless database that requires only a table name and a primary key when you create the table.</p></div></div><div class="card-body"><div class="field"><label for="create-table-name">Table name</label><span class="field-description">This will be used to identify your table.</span><input id="create-table-name" name="name" required pattern="[A-Za-z0-9_.-]{3,255}" placeholder="Music"><span class="hint">Between 3 and 255 characters, containing only letters, numbers, underscores (_), hyphens (-), and periods (.).</span></div><hr class="form-divider"><div class="create-key-section"><h3>Partition key</h3><p class="muted small">The partition key is part of the table's primary key. It is used to retrieve items and distribute data for scalability and availability.</p><div class="field-row create-key-fields"><div class="field"><label for="create-partition-key">Partition key</label><input id="create-partition-key" name="partition" required maxlength="255" placeholder="Artist"><span class="hint">1 to 255 characters and case sensitive.</span></div><div class="field"><label for="create-partition-type">Data type</label><select id="create-partition-type" name="partitionType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div></div><div class="create-key-section"><h3>Sort key <span class="muted small">– optional</span></h3><p class="muted small">Use a sort key as the second part of the primary key to sort or search items that share the same partition key.</p><div class="field-row create-key-fields"><div class="field"><label for="create-sort-key">Sort key</label><input id="create-sort-key" name="sort" maxlength="255" placeholder="SongTitle"><span class="hint">1 to 255 characters and case sensitive.</span></div><div class="field"><label for="create-sort-type">Data type</label><select id="create-sort-type" name="sortType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div></div></div></section><section class="card"><div class="card-header"><div><h2>Table settings</h2><p class="muted small">Choose defaults for the fastest setup, or the local provisioned-capacity descriptor.</p></div></div><div class="card-body"><fieldset class="setting-options"><legend class="sr-only">Table settings</legend><label class="setting-option"><input type="radio" name="billing" value="PAY_PER_REQUEST" checked><span><strong>Default settings</strong><small>The fastest way to create your table. Uses on-demand capacity with no local charges.</small></span></label><label class="setting-option"><input type="radio" name="billing" value="PROVISIONED"><span><strong>Customize settings</strong><small>Uses the local provisioned descriptor with 5 read and 5 write capacity units.</small></span></label></fieldset></div></section><section class="card"><div class="card-header"><div><h2>Secondary indexes <span class="muted small">– optional</span></h2><p class="muted small">Add global or local secondary indexes with explicit key types and projections.</p></div><button class="button" type="button" id="add-create-index">Add index</button></div><div class="card-body" id="create-index-rows"><p class="muted" id="no-create-indexes">No secondary indexes configured.</p></div></section><div class="create-page-actions"><a class="button" href="#/dynamodb/tables">Cancel</a><button class="button primary" id="submit-create-table" type="submit">Create table</button></div></form></div>`;

  const form = document.querySelector("#create-table-form");
  form.elements.name.pattern = "[A-Za-z0-9_.\\-]{3,255}";
  const errorRoot = document.querySelector("#create-table-error");
  const indexRoot = document.querySelector("#create-index-rows");
  const markDirty = () => setDirty(true, "page");
  form.querySelectorAll("input, textarea, select").forEach(control => {
    control.addEventListener("input", markDirty);
    control.addEventListener("change", markDirty);
  });
  document.querySelector("#add-create-index").addEventListener("click", () => {
    document.querySelector("#no-create-indexes")?.remove();
    indexRoot.insertAdjacentHTML("beforeend", indexRowMarkup());
    bindIndexRows(indexRoot, () => String(document.querySelector('input[name="partition"]')?.value ?? ""), () => String(document.querySelector('select[name="partitionType"]')?.value ?? "S"), markDirty);
    markDirty();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = document.querySelector("#submit-create-table");
    submit.disabled = true;
    errorRoot.hidden = true;
    try {
      const request = createTableRequest(new FormData(form), indexRoot);
      await dynamo("CreateTable", request);
      setDirty(false, "page");
      toast("Table created successfully");
      location.hash = `#/dynamodb/tables/${encodeURIComponent(request.TableName)}/overview`;
    } catch (error) {
      markDirty();
      submit.disabled = false;
      const message = error instanceof Error ? error.message : String(error);
      errorRoot.innerHTML = `<strong>Table couldn't be created</strong><br>${escapeHtml(message)}`;
      errorRoot.hidden = false;
      errorRoot.focus({ preventScroll: true });
      showError(error);
    }
  });
}

function createTableRequest(data, indexRoot) {
  const definitions = [];
  const addDefinition = (AttributeName, AttributeType) => {
    if (!AttributeName) return;
    const existing = definitions.find(definition => definition.AttributeName === AttributeName);
    if (existing && existing.AttributeType !== AttributeType) throw new Error(`Attribute ${AttributeName} has conflicting key types`);
    if (!existing) definitions.push({ AttributeName, AttributeType });
  };
  const partition = String(data.get("partition")); const partitionType = String(data.get("partitionType")); const sort = String(data.get("sort") ?? ""); const sortType = String(data.get("sortType"));
  addDefinition(partition, partitionType); if (sort) addDefinition(sort, sortType);
  const keySchema = [{ AttributeName: partition, KeyType: "HASH" }]; if (sort) keySchema.push({ AttributeName: sort, KeyType: "RANGE" });
  const globals = []; const locals = []; const names = new Set();
  for (const row of indexRoot.querySelectorAll(".secondary-index-row")) {
    const value = selector => String(row.querySelector(selector).value ?? "").trim();
    const name = value("[data-index-name]"); const kind = value("[data-index-kind]"); const indexPartition = kind === "LSI" ? partition : value("[data-index-partition]"); const indexPartitionType = kind === "LSI" ? partitionType : value("[data-index-partition-type]"); const indexSort = value("[data-index-sort]"); const indexSortType = value("[data-index-sort-type]"); const projectionType = value("[data-index-projection]"); const nonKeys = value("[data-index-nonkeys]").split(",").map(item => item.trim()).filter(Boolean);
    if (!name) throw new Error("Every secondary index needs a name"); if (names.has(name)) throw new Error(`Duplicate secondary index name: ${name}`); names.add(name);
    if (!indexPartition) throw new Error(`Index ${name} needs a partition key`); if (kind === "LSI" && (!sort || !indexSort)) throw new Error(`Local secondary index ${name} requires table and index sort keys`); if (kind === "GSI" && !value("[data-index-partition]")) throw new Error(`Global secondary index ${name} needs a partition key`);
    if (projectionType === "INCLUDE" && !nonKeys.length) throw new Error(`INCLUDE projection for ${name} needs at least one non-key attribute`); if (projectionType !== "INCLUDE" && nonKeys.length) throw new Error(`Non-key attributes are valid only for INCLUDE projection (${name})`);
    addDefinition(indexPartition, indexPartitionType); if (indexSort) addDefinition(indexSort, indexSortType);
    const index = { IndexName: name, KeySchema: [{ AttributeName: indexPartition, KeyType: "HASH" }, ...(indexSort ? [{ AttributeName: indexSort, KeyType: "RANGE" }] : [])], Projection: { ProjectionType: projectionType, ...(projectionType === "INCLUDE" ? { NonKeyAttributes: nonKeys } : {}) } };
    if (kind === "LSI") locals.push(index); else { if (data.get("billing") === "PROVISIONED") index.ProvisionedThroughput = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }; globals.push(index); }
  }
  const request = { TableName: String(data.get("name")), BillingMode: String(data.get("billing")), AttributeDefinitions: definitions, KeySchema: keySchema, ...(globals.length ? { GlobalSecondaryIndexes: globals } : {}), ...(locals.length ? { LocalSecondaryIndexes: locals } : {}) };
  if (request.BillingMode === "PROVISIONED") request.ProvisionedThroughput = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };
  return request;
}

export function bindEnhancedIndexes(context, table) {
  const { confirmDeletion, route, showModal, toast } = context;
  document.querySelector('[data-action="create-index"]')?.addEventListener("click", () => {
    showModal("Create global secondary index", `<div class="field"><label>Index name</label><input name="name" required pattern="[A-Za-z0-9_.-]{3,255}"></div><div class="field-row"><div class="field"><label>Partition key name</label><input name="partition" required></div><div class="field"><label>Partition key type</label><select name="partitionType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field-row"><div class="field"><label>Sort key name <span class="muted small">– optional</span></label><input name="sort"></div><div class="field"><label>Sort key type</label><select name="sortType"><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field"><label>Projection</label><select name="projection"><option value="ALL">All attributes</option><option value="KEYS_ONLY">Keys only</option><option value="INCLUDE">Include selected attributes</option></select></div><div class="field"><label>Non-key attributes</label><input name="nonKeys" placeholder="title, status, updatedAt"><span class="hint">Comma-separated and required only for INCLUDE.</span></div>`, "Create index", async data => {
      const partition = String(data.get("partition")); const partitionType = String(data.get("partitionType")); const sort = String(data.get("sort") ?? ""); const sortType = String(data.get("sortType")); const projectionType = String(data.get("projection")); const nonKeys = String(data.get("nonKeys") ?? "").split(",").map(value => value.trim()).filter(Boolean);
      if (projectionType === "INCLUDE" && !nonKeys.length) throw new Error("INCLUDE projection needs at least one non-key attribute"); if (projectionType !== "INCLUDE" && nonKeys.length) throw new Error("Non-key attributes are valid only for INCLUDE projection");
      const definitions = []; const addDefinition = (name, type) => { const existing = table.AttributeDefinitions.find(definition => definition.AttributeName === name); if (existing && existing.AttributeType !== type) throw new Error(`Attribute ${name} already has type ${existing.AttributeType}`); if (!existing && !definitions.some(definition => definition.AttributeName === name)) definitions.push({ AttributeName: name, AttributeType: type }); };
      addDefinition(partition, partitionType); if (sort) addDefinition(sort, sortType);
      const index = { IndexName: String(data.get("name")), KeySchema: [{ AttributeName: partition, KeyType: "HASH" }, ...(sort ? [{ AttributeName: sort, KeyType: "RANGE" }] : [])], Projection: { ProjectionType: projectionType, ...(projectionType === "INCLUDE" ? { NonKeyAttributes: nonKeys } : {}) }, ...(table.BillingModeSummary?.BillingMode === "PROVISIONED" ? { ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } } : {}) };
      await dynamo("UpdateTable", { TableName: table.TableName, AttributeDefinitions: definitions, GlobalSecondaryIndexUpdates: [{ Create: index }] }); toast("Index creation started"); await route();
    });
  });
  document.querySelectorAll("[data-delete-index]").forEach(button => button.addEventListener("click", () => confirmDeletion(button.dataset.deleteIndex, `Delete index ${button.dataset.deleteIndex}?`, async () => { await dynamo("UpdateTable", { TableName: table.TableName, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: button.dataset.deleteIndex } }] }); toast("Index deletion started"); await route(); })));
}

function indexRowMarkup() {
  const id = `create-secondary-index-${++indexRowId}`;
  return `<section class="secondary-index-row" data-index-row><div class="card-header"><h4>Secondary index</h4><button class="button link danger" type="button" data-remove-index>Remove</button></div><div class="card-body compact-card-body"><div class="field-row"><div class="field"><label for="${id}-name">Index name</label><input id="${id}-name" data-index-name required></div><div class="field"><label for="${id}-kind">Index type</label><select id="${id}-kind" data-index-kind><option value="GSI">Global secondary index</option><option value="LSI">Local secondary index</option></select></div></div><div class="field-row"><div class="field"><label for="${id}-partition">Partition key name</label><input id="${id}-partition" data-index-partition required></div><div class="field"><label for="${id}-partition-type">Partition key type</label><select id="${id}-partition-type" data-index-partition-type><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field-row"><div class="field"><label for="${id}-sort">Sort key name <span class="muted small">– optional for GSI</span></label><input id="${id}-sort" data-index-sort></div><div class="field"><label for="${id}-sort-type">Sort key type</label><select id="${id}-sort-type" data-index-sort-type><option value="S">String</option><option value="N">Number</option><option value="B">Binary</option></select></div></div><div class="field-row"><div class="field"><label for="${id}-projection">Projection</label><select id="${id}-projection" data-index-projection><option value="ALL">All attributes</option><option value="KEYS_ONLY">Keys only</option><option value="INCLUDE">Include selected attributes</option></select></div><div class="field"><label for="${id}-nonkeys">Non-key attributes</label><input id="${id}-nonkeys" data-index-nonkeys placeholder="title, status" disabled></div></div></div></section>`;
}

function bindIndexRows(root, tablePartition, tablePartitionType, onChange = () => setDirty(true, "modal")) {
  const syncLocalKeys = () => root.querySelectorAll("[data-index-row]").forEach(row => { if (row.querySelector("[data-index-kind]").value !== "LSI") return; row.querySelector("[data-index-partition]").value = tablePartition(); row.querySelector("[data-index-partition-type]").value = tablePartitionType(); });
  if (!root.dataset.tableKeyWatch) { root.dataset.tableKeyWatch = "true"; document.querySelector('input[name="partition"]')?.addEventListener("input", syncLocalKeys); document.querySelector('select[name="partitionType"]')?.addEventListener("change", syncLocalKeys); }
  root.querySelectorAll("[data-index-row]").forEach(row => {
    if (row.dataset.bound) return; row.dataset.bound = "true";
    const kind = row.querySelector("[data-index-kind]"); const partition = row.querySelector("[data-index-partition]"); const partitionType = row.querySelector("[data-index-partition-type]"); const projection = row.querySelector("[data-index-projection]"); const nonKeys = row.querySelector("[data-index-nonkeys]");
    const updateKind = () => { const local = kind.value === "LSI"; if (local) { partition.value = tablePartition(); partitionType.value = tablePartitionType(); } partition.readOnly = local; partitionType.disabled = local; };
    row.querySelectorAll("input, select").forEach(control => { control.addEventListener("input", onChange); control.addEventListener("change", onChange); });
    kind.addEventListener("change", updateKind); projection.addEventListener("change", () => { nonKeys.disabled = projection.value !== "INCLUDE"; if (nonKeys.disabled) nonKeys.value = ""; }); row.querySelector("[data-remove-index]").addEventListener("click", () => { row.remove(); onChange(); }); updateKind();
  });
}

const monitorMetrics = [
  ["ConsumedReadCapacityUnits", "Consumed read capacity"], ["ConsumedWriteCapacityUnits", "Consumed write capacity"], ["ProvisionedReadCapacityUnits", "Provisioned read capacity"], ["ProvisionedWriteCapacityUnits", "Provisioned write capacity"],
];

export async function enhancedDynamoMonitorView(table) {
  return `<section class="card"><div class="card-header"><div><h2>Table metrics</h2><p class="muted small">Choose metrics, scope, time, period, and statistic.</p></div><div class="actions"><button class="button" id="refresh-dynamodb-monitor">Refresh</button><a class="button" href="#/cloudwatch/metrics">View all metrics</a><a class="button" href="#/cloudwatch/alarms">Create or manage alarms</a></div></div><div class="card-body"><div class="metric-controls dynamodb-metric-controls"><div class="field"><label>Resource scope</label><select id="dynamodb-monitor-scope"><option value="">Table – ${escapeHtml(table.TableName)}</option>${(table.GlobalSecondaryIndexes ?? []).map(index => `<option value="${escapeHtml(index.IndexName)}">GSI – ${escapeHtml(index.IndexName)}</option>`).join("")}</select></div><div class="field"><label>Time range</label><select id="dynamodb-monitor-range"><option value="1">Last hour</option><option value="3">Last 3 hours</option><option value="12">Last 12 hours</option><option value="24">Last day</option><option value="72">Last 3 days</option><option value="168">Last week</option></select></div><div class="field"><label>Period</label><select id="dynamodb-monitor-period"><option value="60">1 minute</option><option value="300">5 minutes</option><option value="900">15 minutes</option><option value="3600">1 hour</option></select></div><div class="field"><label>Statistic</label><select id="dynamodb-monitor-stat"><option>Sum</option><option>Average</option><option>Minimum</option><option>Maximum</option><option>SampleCount</option></select></div></div><fieldset class="monitor-metric-picker"><legend>Metrics</legend>${monitorMetrics.map(([name, label], index) => `<label class="checkbox-label"><input type="checkbox" value="${name}" data-dynamodb-monitor-metric ${index < 2 ? "checked" : ""}> ${label}</label>`).join("")}</fieldset><div id="dynamodb-monitor-chart"><div class="loading" role="status"><span></span>Loading metrics…</div></div></div></section>`;
}

export function bindEnhancedMonitor(context, table) {
  const chart = document.querySelector("#dynamodb-monitor-chart"); if (!chart) return;
  let generation = 0;
  const refresh = async () => {
    const current = ++generation; const selected = [...document.querySelectorAll("[data-dynamodb-monitor-metric]:checked")].map(input => input.value);
    if (!selected.length) { chart.innerHTML = '<div class="alert warning"><strong>Choose at least one metric</strong><br>Select a metric to render the chart.</div>'; return; }
    chart.innerHTML = '<div class="loading" role="status"><span></span>Loading metrics…</div>';
    const end = new Date(); const start = new Date(end.getTime() - Number(document.querySelector("#dynamodb-monitor-range").value) * 3_600_000); const scope = document.querySelector("#dynamodb-monitor-scope").value; const dimensions = [{ Name: "TableName", Value: table.TableName }, ...(scope ? [{ Name: "GlobalSecondaryIndexName", Value: scope }] : [])];
    try {
      const result = await metrics("GetMetricData", { StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampAscending", MetricDataQueries: selected.map((MetricName, index) => ({ Id: `metric${index}`, Label: monitorMetrics.find(metric => metric[0] === MetricName)?.[1] ?? MetricName, MetricStat: { Metric: { Namespace: "AWS/DynamoDB", MetricName, Dimensions: dimensions }, Period: Number(document.querySelector("#dynamodb-monitor-period").value), Stat: document.querySelector("#dynamodb-monitor-stat").value } })) });
      if (current !== generation) return; const series = (result.MetricDataResults ?? []).map(item => ({ ...item, timestamps: item.Timestamps, values: item.Values, label: item.Label })); chart.innerHTML = metricChart(series, `${scope ? `${scope} index` : table.TableName} DynamoDB metrics`);
    } catch (error) { if (current === generation) { chart.innerHTML = `<div class="alert error"><strong>${escapeHtml(error.code ?? "Metrics error")}</strong><br>${escapeHtml(error.message)}</div>`; context.showError(error); } }
  };
  document.querySelector("#refresh-dynamodb-monitor").addEventListener("click", refresh);
  document.querySelectorAll("#dynamodb-monitor-scope,#dynamodb-monitor-range,#dynamodb-monitor-period,#dynamodb-monitor-stat,[data-dynamodb-monitor-metric]").forEach(control => control.addEventListener("change", refresh));
  void refresh();
}
