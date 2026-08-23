import { rest } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { decorateXRayPanelHelp } from "./xray-help.js";

export const metadata = {
  key: "xray",
  name: "X-Ray",
  icon: "⌁",
  cls: "xray",
  links: [["Traces", "#/xray/traces"], ["Service map", "#/xray/service-map"], ["Repository diagnostics", "#/xray/diagnostics"]],
  search: ["x-ray", "xray", "trace", "tracing", "segment", "subsegment", "service map", "repository diagnostics"],
};

function annotationValue(summary, name) {
  return summary.Annotations?.[name]?.map(entry => entry.AnnotationValue?.StringValue ?? entry.AnnotationValue?.NumberValue ?? entry.AnnotationValue?.BooleanValue).find(value => value !== undefined);
}

function traceStatus(trace) {
  if (trace.HasFault) return ["Fault", "error"];
  if (trace.HasThrottle) return ["Throttled", "warning"];
  if (trace.HasError) return ["Error", "warning"];
  return ["OK", "success"];
}

function duration(value) {
  const milliseconds = Number(value ?? 0) * 1_000;
  return milliseconds < 1 ? `${milliseconds.toFixed(2)} ms` : `${milliseconds.toFixed(milliseconds < 10 ? 2 : milliseconds < 100 ? 1 : 0)} ms`;
}

function traceRows(traces) {
  return traces.map(trace => {
    const [status, cls] = traceStatus(trace);
    const apiId = annotationValue(trace, "aws:api_id");
    const stage = annotationValue(trace, "aws:api_stage");
    const method = annotationValue(trace, "http:method");
    return `<tr data-search-row="${escapeHtml(`${trace.Id} ${apiId ?? ""} ${stage ?? ""} ${method ?? ""} ${status}`.toLowerCase())}"><td><a class="mono" href="#/xray/traces/${encodeURIComponent(trace.Id)}">${escapeHtml(trace.Id)}</a></td><td>${formatDate(new Date(Number(trace.StartTime) * 1_000))}</td><td>${escapeHtml(method ?? "–")}</td><td>${apiId ? `<span class="mono">${escapeHtml(apiId)}</span>${stage ? ` · ${escapeHtml(stage)}` : ""}` : escapeHtml(trace.ServiceIds?.[0]?.Name ?? "–")}</td><td>${duration(trace.Duration)}</td><td><span class="status-badge ${cls}">${status}</span></td></tr>`;
  }).join("");
}

async function tracesPage(context, filter = {}) {
  context.setChrome("xray", ["X-Ray", "Traces"]);
  const result = await rest("/_stacksim/api/xray/traces");
  let traces = result.traces ?? [];
  if (filter.apiId) traces = traces.filter(trace => annotationValue(trace, "aws:api_id") === filter.apiId && (!filter.stage || annotationValue(trace, "aws:api_stage") === filter.stage));
  const filterNote = filter.apiId ? `<div class="alert info"><strong>API Gateway stage filter</strong><br>Showing traces for API <span class="mono">${escapeHtml(filter.apiId)}</span>${filter.stage ? `, stage <span class="mono">${escapeHtml(filter.stage)}</span>` : ""}. <a href="#/xray/traces">Clear filter</a></div>` : "";
  context.main.innerHTML = `<div class="page-width">${pageHeader("Traces", "Inspect retained requests and downstream integration attempts.", '<a class="button" href="#/xray/service-map">Service map</a><button class="button" data-action="refresh">Refresh</button>')}${filterNote}<section class="card" data-xray-panel="traces"><div class="card-header"><div><h2>Retained traces <span class="muted">(${traces.length})</span></h2><p class="muted small">Newest first · current account and Region</p></div></div>${traces.length ? `<div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find trace ID, API, stage, method, or status"></label></div><div class="table-wrap"><table><thead><tr><th>Trace ID</th><th>Started</th><th>Method</th><th>Service / stage</th><th>Duration</th><th>Status</th></tr></thead><tbody>${traceRows(traces)}</tbody></table></div>` : emptyState("⌁", "No traces", filter.apiId ? "Invoke this traced API stage, then refresh." : "Enable tracing on an API Gateway stage or submit a trace segment, then refresh.")}</section></div>`;
  context.bindTableFilter();
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

function segmentSummary(document) {
  const status = document.http?.response?.status;
  const downstream = (document.subsegments ?? []).length;
  const decision = document.aws?.xray?.sampling_rule_name ? `Locally sampled · ${document.aws.xray.sampling_rule_name}` : "Inherited Sampled=1";
  return `<dl class="key-value"><dt>Name</dt><dd>${escapeHtml(document.name ?? "unknown")}</dd><dt>Segment ID</dt><dd class="mono">${escapeHtml(document.id ?? "–")}</dd><dt>Kind</dt><dd>${document.type === "subsegment" ? "Subsegment" : "Segment"}</dd><dt>Sampling decision</dt><dd>${escapeHtml(decision)}</dd><dt>Duration</dt><dd>${document.end_time === undefined ? "In progress" : duration(Number(document.end_time) - Number(document.start_time))}</dd><dt>HTTP status</dt><dd>${status ?? "–"}</dd><dt>Embedded subsegments</dt><dd>${downstream}</dd></dl>`;
}

function timelineRows(segments) {
  const entries = [];
  const visit = (node, depth = 0) => { entries.push({ node, depth }); for (const child of node.subsegments ?? []) visit(child, depth + 1); };
  for (const segment of segments) visit(segment.Document ?? {});
  const origin = Math.min(...entries.map(entry => Number(entry.node.start_time)).filter(Number.isFinite));
  return entries.map(({ node, depth }) => `<tr><td style="padding-left:${12 + depth * 20}px">${depth ? "↳ " : ""}${escapeHtml(node.name ?? "unknown")}</td><td>${Number.isFinite(origin) && Number.isFinite(Number(node.start_time)) ? duration(Number(node.start_time) - origin) : "–"}</td><td>${node.end_time === undefined ? "In progress" : duration(Number(node.end_time) - Number(node.start_time))}</td><td>${node.http?.response?.status ?? "–"}</td><td>${node.fault ? "Fault" : node.error ? node.throttle ? "Throttled" : "Error" : "OK"}</td></tr>`).join("");
}

async function traceDetail(context, traceId) {
  context.setChrome("xray", ["X-Ray", "Traces", traceId]);
  const trace = await rest(`/_stacksim/api/xray/traces/${encodeURIComponent(traceId)}`);
  const segments = trace.Segments ?? [];
  context.main.innerHTML = `<div class="page-width">${pageHeader("Trace detail", trace.Id, '<a class="button" href="#/xray/traces">All traces</a><button class="button" data-action="refresh">Refresh</button>')}<div class="detail-grid"><section class="card"><div class="card-header"><h2>Trace summary</h2></div><div class="card-body"><dl class="key-value"><dt>Trace ID</dt><dd class="mono">${escapeHtml(trace.Id)}</dd><dt>Duration</dt><dd>${duration(trace.Duration)}</dd><dt>Segments</dt><dd>${segments.length}</dd><dt>Limit exceeded</dt><dd>${trace.LimitExceeded ? "Yes" : "No"}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Data safety</h2></div><div class="card-body"><p>Documents below are decrypted for this request, redacted on the server, and escaped before rendering.</p><p class="muted small">Authorization, cookies, passwords, secrets, tokens, credentials, and unusually large values are not displayed verbatim.</p></div></section></div><section class="card"><div class="card-header"><h2>Timeline</h2></div><div class="table-wrap"><table><thead><tr><th>Service / segment</th><th>Start offset</th><th>Duration</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${timelineRows(segments) || '<tr><td colspan="5" class="muted">No timing data.</td></tr>'}</tbody></table></div></section><section class="card" data-xray-panel="trace"><div class="card-header"><h2>Segments <span class="muted">(${segments.length})</span></h2></div><div class="card-body">${segments.map((segment, index) => `<details ${index === 0 ? "open" : ""}><summary><strong>${escapeHtml(segment.Document?.name ?? segment.Id)}</strong> <span class="mono muted">${escapeHtml(segment.Id)}</span></summary><div class="detail-grid" style="margin-top:12px">${segmentSummary(segment.Document ?? {})}<pre class="code-box"><code>${escapeHtml(JSON.stringify(segment.Document, null, 2))}</code></pre></div></details>`).join("") || '<p class="muted">No readable segments remain for this trace.</p>'}</div></section></div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function serviceMap(context) {
  context.setChrome("xray", ["X-Ray", "Service map"]);
  const graph = await rest("/_stacksim/api/xray/service-graph");
  const services = graph.Services ?? [];
  const byReference = new Map(services.map(service => [service.ReferenceId, service]));
  const edges = services.flatMap(service => (service.Edges ?? []).map(edge => ({ source: service.Name, destination: byReference.get(edge.ReferenceId)?.Name ?? `Reference ${edge.ReferenceId}`, count: edge.SummaryStatistics?.TotalCount ?? 0 })));
  context.main.innerHTML = `<div class="page-width">${pageHeader("Service map", "Aggregated services and downstream edges from retained traces.", '<a class="button" href="#/xray/traces">View traces</a><button class="button" data-action="refresh">Refresh</button>')}<section class="card" data-xray-panel="graph"><div class="card-header"><h2>Services <span class="muted">(${services.length})</span></h2></div>${services.length ? `<div class="table-wrap"><table><thead><tr><th>Service</th><th>Type</th><th>Requests</th><th>Errors</th><th>Faults</th><th>Response time</th></tr></thead><tbody>${services.map(service => `<tr><td>${escapeHtml(service.Name)}</td><td>${escapeHtml(service.Type ?? "local")}</td><td>${service.SummaryStatistics?.TotalCount ?? 0}</td><td>${service.SummaryStatistics?.ErrorStatistics?.TotalCount ?? 0}</td><td>${service.SummaryStatistics?.FaultStatistics?.TotalCount ?? 0}</td><td>${duration(service.SummaryStatistics?.TotalResponseTime ?? 0)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("⌁", "No service map data", "Retained traces with readable segments will appear here.")}</section><section class="card"><div class="card-header"><h2>Downstream edges <span class="muted">(${edges.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Source</th><th></th><th>Destination</th><th>Requests</th></tr></thead><tbody>${edges.map(edge => `<tr><td>${escapeHtml(edge.source)}</td><td aria-label="calls">→</td><td>${escapeHtml(edge.destination)}</td><td>${edge.count}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No downstream edges.</td></tr>'}</tbody></table></div></section></div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function diagnostics(context) {
  context.setChrome("xray", ["X-Ray", "Repository diagnostics"]);
  const health = await rest("/_stacksim/api/xray/health");
  const statusClass = health.status === "ready" ? "success" : health.status === "capacity-limited" ? "warning" : "error";
  context.main.innerHTML = `<div class="page-width">${pageHeader("Repository diagnostics", "Health and capacity for the current account and Region.", '<button class="button" data-action="refresh">Refresh</button>')}<section class="card" data-xray-panel="repository"><div class="card-header"><h2>Repository</h2><span class="status-badge ${statusClass}">${escapeHtml(health.status)}</span></div><div class="card-body detail-grid"><dl class="key-value"><dt>Traces</dt><dd>${Number(health.traceCount ?? 0).toLocaleString()}</dd><dt>Segments</dt><dd>${Number(health.segmentCount ?? 0).toLocaleString()}</dd><dt>Rejected documents</dt><dd>${Number(health.rejectedCount ?? 0).toLocaleString()}</dd></dl><dl class="key-value"><dt>Oldest trace</dt><dd>${health.oldestTraceTime ? formatDate(new Date(health.oldestTraceTime * 1_000)) : "–"}</dd><dt>Newest trace</dt><dd>${health.newestTraceTime ? formatDate(new Date(health.newestTraceTime * 1_000)) : "–"}</dd><dt>Last cleanup</dt><dd>${health.lastCleanupAt ? formatDate(new Date(health.lastCleanupAt)) : "–"}</dd></dl></div>${health.errors?.length ? `<div class="alert warning" role="alert"><strong>Recent bounded diagnostics</strong><ul>${health.errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>` : ""}</section><div class="alert info"><strong>Stopped backups are paired.</strong><br>Back up the trace database and installation X-Ray key together while StackSim is stopped. A database without its matching key cannot be decrypted.</div></div>`;
  context.main.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

export async function routeXRay(parts, context) {
  let result;
  if ((parts[1] === undefined || parts[1] === "traces") && parts.length <= 2) result = await tracesPage(context);
  else if (parts[1] === "traces" && parts[2] === "api" && parts[3]) result = await tracesPage(context, { apiId: parts[3], stage: parts[4] });
  else if (parts[1] === "traces" && parts[2] && parts.length === 3) result = await traceDetail(context, parts[2]);
  else if (parts[1] === "service-map" && parts.length === 2) result = await serviceMap(context);
  else if (parts[1] === "diagnostics" && parts.length === 2) result = await diagnostics(context);
  else result = context.notFound(parts);
  decorateXRayPanelHelp(context.main);
  return result;
}
