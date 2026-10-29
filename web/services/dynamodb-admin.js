import { dynamo, metrics } from "../api-client.js";
import { escapeHtml, metricChart } from "../components.js";
import { setDirty } from "../state.js";


// The Indexes tab lists global and local secondary indexes in separate tables with the AWS columns,
// Create index is a full page, and deleting an index is confirmed by typing "confirm".
const projectionLabel = projection => projection?.ProjectionType === "KEYS_ONLY" ? "Keys only" : projection?.ProjectionType === "INCLUDE" ? `Include: ${(projection.NonKeyAttributes ?? []).join(", ")}` : "All";
const indexStatusLabel = index => index.Backfilling ? "Backfilling" : ({ ACTIVE: "Active", CREATING: "Creating", UPDATING: "Updating", DELETING: "Deleting" })[index.IndexStatus ?? "ACTIVE"] ?? index.IndexStatus;
const keyCell = (table, index, keyType) => { const name = index.KeySchema.find(key => key.KeyType === keyType)?.AttributeName; if (!name) return "–"; const type = table.AttributeDefinitions.find(definition => definition.AttributeName === name)?.AttributeType ?? "S"; return `${escapeHtml(name)} <span class="muted">(${({ S: "String", N: "Number", B: "Binary" })[type] ?? type})</span>`; };
const indexBytes = value => { const bytes = Number(value ?? 0); if (bytes < 1024) return `${bytes} bytes`; const units = ["KB", "MB", "GB"]; let size = bytes / 1024; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`; };
const indexCapacity = (table, index, side) => {
  if ((table.BillingModeSummary?.BillingMode ?? "PROVISIONED") === "PAY_PER_REQUEST") return "On-demand";
  const units = side === "read" ? index.ProvisionedThroughput?.ReadCapacityUnits : index.ProvisionedThroughput?.WriteCapacityUnits;
  return `Provisioned (${units ?? 0})`;
};

export function dynamoIndexesTabView(table) {
  const globals = table.GlobalSecondaryIndexes ?? [];
  const locals = table.LocalSecondaryIndexes ?? [];
  const globalTable = globals.length
    ? `<div class="table-wrap"><table class="selectable-table"><thead><tr><th class="checkbox-cell"><span class="sr-only">Select</span></th><th>Name</th><th>Status</th><th>Partition key</th><th>Sort key</th><th>Read capacity</th><th>Write capacity</th><th>Attribute projections</th><th>Size</th><th>Item count</th></tr></thead><tbody>${globals.map(index => `<tr><td class="checkbox-cell"><input type="radio" name="selected-index" value="${escapeHtml(index.IndexName)}" aria-label="Select ${escapeHtml(index.IndexName)}"></td><td>${escapeHtml(index.IndexName)}</td><td><span class="status ${index.IndexStatus && index.IndexStatus !== "ACTIVE" ? "pending" : ""}">${escapeHtml(indexStatusLabel(index))}</span></td><td>${keyCell(table, index, "HASH")}</td><td>${keyCell(table, index, "RANGE")}</td><td>${indexCapacity(table, index, "read")}</td><td>${indexCapacity(table, index, "write")}</td><td>${escapeHtml(projectionLabel(index.Projection))}</td><td>${indexBytes(index.IndexSizeBytes)}</td><td>${Number(index.ItemCount ?? 0).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="table-wrap">${emptyIndexes("No global indexes", "Create a global secondary index to query the table with another partition key.")}</div>`;
  const localTable = locals.length
    ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Partition key</th><th>Sort key</th><th>Attribute projections</th><th>Size</th><th>Item count</th></tr></thead><tbody>${locals.map(index => `<tr><td>${escapeHtml(index.IndexName)}</td><td>${keyCell(table, index, "HASH")}</td><td>${keyCell(table, index, "RANGE")}</td><td>${escapeHtml(projectionLabel(index.Projection))}</td><td>${indexBytes(index.IndexSizeBytes)}</td><td>${Number(index.ItemCount ?? 0).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="table-wrap">${emptyIndexes("No local indexes", "Local secondary indexes can only be created with the table.")}</div>`;
  return `<section class="card" id="global-indexes-card"><div class="card-header"><div><h2>Global secondary indexes <span class="muted">(${globals.length})</span></h2><p class="muted small">Size and item count are exact and current locally.</p></div><div class="actions"><button class="button" data-action="delete-index" disabled>Delete</button><a class="button primary" href="#/dynamodb/tables/${encodeURIComponent(table.TableName)}/indexes/create">Create index</a></div></div>${globalTable}</section><section class="card" id="local-indexes-card"><div class="card-header"><h2>Local secondary indexes <span class="muted">(${locals.length})</span></h2></div>${localTable}</section>`;
}

function emptyIndexes(title, text) { return `<div class="empty"><div class="empty-icon">◇</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`; }

export function bindIndexesTab(context, table) {
  const { route, showModal, toast } = context;
  const deleteButton = document.querySelector('[data-action="delete-index"]');
  let selected;
  document.querySelectorAll('input[name="selected-index"]').forEach(radio => radio.addEventListener("change", () => { selected = radio.value; const index = (table.GlobalSecondaryIndexes ?? []).find(item => item.IndexName === selected); deleteButton.disabled = !index || (index.IndexStatus ?? "ACTIVE") !== "ACTIVE"; }));
  deleteButton?.addEventListener("click", () => {
    if (!selected) return;
    const name = selected;
    showModal("Delete index", `<p>Delete the global secondary index <strong>${escapeHtml(name)}</strong> from <strong>${escapeHtml(table.TableName)}</strong>? Queries that use this index will fail, and you can't undo this action.</p><div class="field"><label>To confirm deletion, type <strong>confirm</strong> in the field.</label><input name="confirmation" autocomplete="off" placeholder="confirm" required></div>`, "Delete", async data => {
      if (String(data.get("confirmation") ?? "").trim() !== "confirm") throw new Error("Type confirm to delete the index");
      await dynamo("UpdateTable", { TableName: table.TableName, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }] });
      toast(`Deleting index ${name}`); await route();
    }, false, { danger: true, refreshAfterSubmit: false });
  });
}

export async function dynamoCreateIndexPage(context, tableName) {
  const { main, setChrome, showError, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "Tables", tableName, "Create global secondary index"]);
  const table = (await dynamo("DescribeTable", { TableName: tableName })).Table;
  const provisioned = (table.BillingModeSummary?.BillingMode ?? "PROVISIONED") === "PROVISIONED";
  const back = `#/dynamodb/tables/${encodeURIComponent(tableName)}/indexes`;
  const typeOptions = selected => [["S", "String"], ["N", "Number"], ["B", "Binary"]].map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
  main.innerHTML = `<div class="page-width"><div class="page-header"><div class="page-title"><h1>Create global secondary index</h1><p>Add an index to <span class="mono">${escapeHtml(tableName)}</span> so it can be queried with another key.</p></div></div><form id="create-index-form" novalidate><div class="alert error" id="create-index-error" role="alert" hidden></div>`
    + `<section class="card"><div class="card-header"><h2>Index details</h2></div><div class="card-body"><div class="field-row"><div class="field"><label for="index-partition">Partition key</label><input id="index-partition" name="partition" required placeholder="Enter the partition key name"><span class="hint">1 to 255 characters and case sensitive.</span></div><div class="field"><label for="index-partition-type">Data type</label><select id="index-partition-type" name="partitionType">${typeOptions("S")}</select></div></div>`
    + `<div class="field-row"><div class="field"><label for="index-sort">Sort key <span class="muted small">– optional</span></label><input id="index-sort" name="sort" placeholder="Enter the sort key name"></div><div class="field"><label for="index-sort-type">Data type</label><select id="index-sort-type" name="sortType">${typeOptions("S")}</select></div></div>`
    + `<div class="field"><label for="index-name">Index name</label><input id="index-name" name="name" required pattern="[A-Za-z0-9_.\\-]{3,255}"><span class="hint">3 to 255 characters: letters, numbers, underscores, hyphens, and periods.</span></div></div></section>`
    + `<section class="card"><div class="card-header"><h2>Attribute projections</h2></div><div class="card-body"><fieldset class="setting-options"><legend class="sr-only">Attribute projections</legend><label class="setting-option"><input type="radio" name="projection" value="ALL" checked><span><strong>All</strong><small>Project every table attribute into the index.</small></span></label><label class="setting-option"><input type="radio" name="projection" value="KEYS_ONLY"><span><strong>Only keys</strong><small>Project only the index and table key attributes.</small></span></label><label class="setting-option"><input type="radio" name="projection" value="INCLUDE"><span><strong>Include</strong><small>Project the keys plus the attributes you list.</small></span></label></fieldset><div class="field" id="index-include-field" hidden><label for="index-include">Projected attributes</label><input id="index-include" name="include" placeholder="title, status, updatedAt"><span class="hint">Separate attribute names with commas.</span></div></div></section>`
    + (provisioned
      ? `<section class="card"><div class="card-header"><div><h2>Index capacity</h2><p class="muted small">The table uses provisioned capacity, so the index needs its own read and write capacity.</p></div></div><div class="card-body"><div class="field-row"><div class="field"><label for="index-read">Read capacity units</label><input id="index-read" name="read" type="number" min="1" value="${table.ProvisionedThroughput?.ReadCapacityUnits ?? 5}"></div><div class="field"><label for="index-write">Write capacity units</label><input id="index-write" name="write" type="number" min="1" value="${table.ProvisionedThroughput?.WriteCapacityUnits ?? 5}"></div></div></div></section>`
      : `<section class="card"><div class="card-header"><h2>Index capacity</h2></div><div class="card-body"><p class="muted">The table uses on-demand capacity, so the index scales with the table.</p></div></section>`)
    + `<div class="actions page-actions"><a class="button" href="${back}">Cancel</a><button class="button primary" type="submit" id="create-index-submit">Create index</button></div></form></div>`;
  const form = document.querySelector("#create-index-form");
  const nameInput = form.elements.name; let nameEdited = false;
  const suggestName = () => { if (nameEdited) return; const partition = form.elements.partition.value.trim(); const sort = form.elements.sort.value.trim(); nameInput.value = partition ? `${[partition, sort].filter(Boolean).join("-")}-index` : ""; };
  form.elements.partition.addEventListener("input", suggestName); form.elements.sort.addEventListener("input", suggestName);
  nameInput.addEventListener("input", () => { nameEdited = true; });
  form.querySelectorAll('input[name="projection"]').forEach(radio => radio.addEventListener("change", () => { document.querySelector("#index-include-field").hidden = form.elements.projection.value !== "INCLUDE"; }));
  form.querySelectorAll("input, select").forEach(control => control.addEventListener("input", () => setDirty(true, "page")));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const errorRoot = document.querySelector("#create-index-error"); errorRoot.hidden = true;
    const submit = document.querySelector("#create-index-submit"); submit.disabled = true;
    try {
      const partition = form.elements.partition.value.trim(); const sort = form.elements.sort.value.trim();
      if (!partition) throw new Error("Enter a partition key name");
      const projectionType = form.elements.projection.value;
      const include = form.elements.include.value.split(",").map(value => value.trim()).filter(Boolean);
      if (projectionType === "INCLUDE" && !include.length) throw new Error("Enter at least one projected attribute for Include");
      const definitions = [];
      const addDefinition = (name, type) => { const existing = table.AttributeDefinitions.find(definition => definition.AttributeName === name); if (existing && existing.AttributeType !== type) throw new Error(`Attribute ${name} is already defined as ${existing.AttributeType}`); if (!definitions.some(definition => definition.AttributeName === name)) definitions.push({ AttributeName: name, AttributeType: type }); };
      addDefinition(partition, form.elements.partitionType.value); if (sort) addDefinition(sort, form.elements.sortType.value);
      const index = { IndexName: nameInput.value.trim(), KeySchema: [{ AttributeName: partition, KeyType: "HASH" }, ...(sort ? [{ AttributeName: sort, KeyType: "RANGE" }] : [])], Projection: { ProjectionType: projectionType, ...(projectionType === "INCLUDE" ? { NonKeyAttributes: include } : {}) } };
      if (provisioned) index.ProvisionedThroughput = { ReadCapacityUnits: Number(form.elements.read.value), WriteCapacityUnits: Number(form.elements.write.value) };
      // AttributeDefinitions always carries the index key attributes (never an empty list, which AWS rejects).
      await dynamo("UpdateTable", { TableName: tableName, AttributeDefinitions: definitions, GlobalSecondaryIndexUpdates: [{ Create: index }] });
      setDirty(false, "page"); toast(`Creating index ${index.IndexName}`); location.hash = back;
    } catch (error) {
      errorRoot.hidden = false; errorRoot.innerHTML = `<strong>${escapeHtml(error.code ?? "Error")}</strong><br>${escapeHtml(error.message)}`; showError(error); submit.disabled = false;
    }
  });
}

// The Monitor tab shows one graph per CloudWatch metric, like the AWS console, with time-range chips,
// an Alarms section for alarms on this table, and Contributor Insights below. Metric names and dimensions follow
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html.
const monitorRanges = [["1", "1h", 60], ["3", "3h", 60], ["12", "12h", 300], ["24", "1d", 300], ["72", "3d", 900], ["168", "1w", 3600]];
const latencyOperations = ["GetItem", "PutItem", "Query", "Scan", "UpdateItem", "DeleteItem"];

function monitorPanels(table, scope) {
  const base = [{ Name: "TableName", Value: table.TableName }, ...(scope ? [{ Name: "GlobalSecondaryIndexName", Value: scope }] : [])];
  const tableOnly = [{ Name: "TableName", Value: table.TableName }];
  const provisioned = (table.BillingModeSummary?.BillingMode ?? "PROVISIONED") === "PROVISIONED";
  const perSecond = true;
  const panels = [
    { id: "read", title: "Read usage (average units/second)", series: [{ label: "Consumed", metric: "ConsumedReadCapacityUnits", dimensions: base, stat: "Sum", perSecond }, ...(provisioned ? [{ label: "Provisioned", metric: "ProvisionedReadCapacityUnits", dimensions: base, stat: "Average" }] : [])] },
    { id: "write", title: "Write usage (average units/second)", series: [{ label: "Consumed", metric: "ConsumedWriteCapacityUnits", dimensions: base, stat: "Sum", perSecond }, ...(provisioned ? [{ label: "Provisioned", metric: "ProvisionedWriteCapacityUnits", dimensions: base, stat: "Average" }] : [])] },
    { id: "read-throttles", title: "Read throttled events (count)", series: [{ label: "Read throttle events", metric: "ReadThrottleEvents", dimensions: base, stat: "Sum" }] },
    { id: "write-throttles", title: "Write throttled events (count)", series: [{ label: "Write throttle events", metric: "WriteThrottleEvents", dimensions: base, stat: "Sum" }] },
  ];
  if (scope) return panels;
  return [...panels,
    { id: "throttled-requests", title: "Throttled requests (count)", series: ["GetItem", "PutItem", "Query", "Scan"].map(operation => ({ label: operation, metric: "ThrottledRequests", dimensions: [...tableOnly, { Name: "Operation", Value: operation }], stat: "Sum" })) },
    { id: "latency-read", title: "Get and query latency (milliseconds)", series: ["GetItem", "Query", "Scan"].map(operation => ({ label: operation, metric: "SuccessfulRequestLatency", dimensions: [...tableOnly, { Name: "Operation", Value: operation }], stat: "Average" })) },
    { id: "latency-write", title: "Put, update, and delete latency (milliseconds)", series: ["PutItem", "UpdateItem", "DeleteItem"].map(operation => ({ label: operation, metric: "SuccessfulRequestLatency", dimensions: [...tableOnly, { Name: "Operation", Value: operation }], stat: "Average" })) },
    { id: "returned", title: "Returned item count", series: ["Query", "Scan"].map(operation => ({ label: operation, metric: "ReturnedItemCount", dimensions: [...tableOnly, { Name: "Operation", Value: operation }], stat: "Average" })) },
    { id: "conditional", title: "Conditional check failed requests (count)", series: [{ label: "Conditional check failed", metric: "ConditionalCheckFailedRequests", dimensions: tableOnly, stat: "Sum" }] },
    { id: "system-errors", title: "System errors (count)", series: latencyOperations.map(operation => ({ label: operation, metric: "SystemErrors", dimensions: [...tableOnly, { Name: "Operation", Value: operation }], stat: "Sum" })) },
    { id: "user-errors", title: "User errors, account and Region (count)", series: [{ label: "User errors", metric: "UserErrors", dimensions: [], stat: "Sum" }] },
    { id: "ttl", title: "Time to Live deleted items (count)", series: [{ label: "Deleted items", metric: "TimeToLiveDeletedItemCount", dimensions: tableOnly, stat: "Sum" }] },
  ];
}

export async function enhancedDynamoMonitorView(table) {
  return `<section class="card dynamodb-monitor-card"><div class="card-header"><div><h2>Table metrics</h2><p class="muted small">CloudWatch metrics for this table, one graph per metric.</p></div><div class="actions"><button class="button" id="refresh-dynamodb-monitor">Refresh</button><a class="button" href="#/cloudwatch/metrics">View all CloudWatch metrics</a></div></div><div class="card-body"><div class="dynamodb-monitor-toolbar"><div class="segmented-control" role="group" aria-label="Time range">${monitorRanges.map(([hours, label], index) => `<button type="button" data-monitor-range="${hours}" aria-pressed="${index === 0}" class="${index === 0 ? "active" : ""}">${label}</button>`).join("")}</div><div class="field"><label for="dynamodb-monitor-scope">Table or index</label><select id="dynamodb-monitor-scope"><option value="">Table – ${escapeHtml(table.TableName)}</option>${(table.GlobalSecondaryIndexes ?? []).map(index => `<option value="${escapeHtml(index.IndexName)}">Index – ${escapeHtml(index.IndexName)}</option>`).join("")}</select></div></div><div class="dynamodb-monitor-grid" id="dynamodb-monitor-grid"><div class="loading" role="status"><span></span>Loading metrics…</div></div></div></section><section class="card" id="dynamodb-alarms-card"><div class="card-header"><div><h2>Alarms</h2><p class="muted small">CloudWatch alarms on this table's metrics.</p></div><a class="button" href="#/cloudwatch/alarms">Create alarm</a></div><div class="table-wrap" id="dynamodb-alarms"><div class="loading" role="status"><span></span>Loading alarms…</div></div></section>`;
}

export function bindEnhancedMonitor(context, table) {
  const grid = document.querySelector("#dynamodb-monitor-grid"); if (!grid) return;
  let generation = 0; let hours = 1;
  const refresh = async () => {
    const current = ++generation; const scope = document.querySelector("#dynamodb-monitor-scope").value;
    const range = monitorRanges.find(([value]) => Number(value) === hours) ?? monitorRanges[0]; const period = range[2];
    const end = new Date(); const start = new Date(end.getTime() - hours * 3_600_000);
    const panels = monitorPanels(table, scope);
    const queries = panels.flatMap((panel, panelIndex) => panel.series.map((series, seriesIndex) => ({ Id: `p${panelIndex}s${seriesIndex}`, Label: series.label, MetricStat: { Metric: { Namespace: "AWS/DynamoDB", MetricName: series.metric, Dimensions: series.dimensions }, Period: period, Stat: series.stat } })));
    grid.innerHTML = '<div class="loading" role="status"><span></span>Loading metrics…</div>';
    try {
      const result = await metrics("GetMetricData", { StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampAscending", MetricDataQueries: queries });
      if (current !== generation) return;
      const byId = new Map((result.MetricDataResults ?? []).map(item => [item.Id, item]));
      grid.innerHTML = panels.map((panel, panelIndex) => {
        const series = panel.series.map((definition, seriesIndex) => { const data = byId.get(`p${panelIndex}s${seriesIndex}`) ?? {}; return { label: definition.label, timestamps: data.Timestamps ?? [], values: (data.Values ?? []).map(value => definition.perSecond ? value / period : value) }; });
        return `<article class="dynamodb-monitor-panel" data-monitor-panel="${panel.id}"><h3>${escapeHtml(panel.title)}</h3>${metricChart(series, panel.title, { legend: panel.series.length > 1 })}</article>`;
      }).join("");
    } catch (error) { if (current === generation) { grid.innerHTML = `<div class="alert error"><strong>${escapeHtml(error.code ?? "Metrics error")}</strong><br>${escapeHtml(error.message)}</div>`; context.showError(error); } }
  };
  const loadAlarms = async () => {
    const root = document.querySelector("#dynamodb-alarms");
    try {
      const alarms = []; let NextToken;
      do { const page = await metrics("DescribeAlarms", { AlarmTypes: ["MetricAlarm"], MaxRecords: 100, ...(NextToken ? { NextToken } : {}) }); alarms.push(...(page.MetricAlarms ?? [])); NextToken = page.NextToken; } while (NextToken);
      const mine = alarms.filter(alarm => alarm.Namespace === "AWS/DynamoDB" && (alarm.Dimensions ?? []).some(dimension => dimension.Name === "TableName" && dimension.Value === table.TableName));
      root.innerHTML = mine.length ? `<table><thead><tr><th>Name</th><th>State</th><th>Metric</th><th>Conditions</th></tr></thead><tbody>${mine.map(alarm => `<tr><td><a href="#/cloudwatch/alarms/${encodeURIComponent(alarm.AlarmName)}">${escapeHtml(alarm.AlarmName)}</a></td><td><span class="status ${alarm.StateValue === "ALARM" ? "error" : alarm.StateValue === "OK" ? "" : "pending"}">${escapeHtml(({ OK: "OK", ALARM: "In alarm", INSUFFICIENT_DATA: "Insufficient data" })[alarm.StateValue] ?? alarm.StateValue)}</span></td><td class="mono">${escapeHtml(alarm.MetricName)}</td><td>${escapeHtml(`${alarm.Statistic ?? alarm.ExtendedStatistic ?? ""} ${alarm.ComparisonOperator ?? ""} ${alarm.Threshold ?? ""}`)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty"><div class="empty-icon">◇</div><h3>No alarms</h3><p>No CloudWatch alarms use this table's metrics.</p></div>`;
    } catch (error) { root.innerHTML = `<div class="alert error card-inset"><strong>${escapeHtml(error.code ?? "Alarms error")}</strong><br>${escapeHtml(error.message)}</div>`; }
  };
  document.querySelectorAll("[data-monitor-range]").forEach(button => button.addEventListener("click", () => {
    hours = Number(button.dataset.monitorRange);
    document.querySelectorAll("[data-monitor-range]").forEach(other => { const active = other === button; other.classList.toggle("active", active); other.setAttribute("aria-pressed", String(active)); });
    void refresh();
  }));
  document.querySelector("#refresh-dynamodb-monitor").addEventListener("click", () => { void refresh(); void loadAlarms(); });
  document.querySelector("#dynamodb-monitor-scope").addEventListener("change", refresh);
  void refresh(); void loadAlarms();
}
