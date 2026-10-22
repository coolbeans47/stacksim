import { dynamo, metrics } from "../api-client.js";
import { escapeHtml, metricChart } from "../components.js";


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
