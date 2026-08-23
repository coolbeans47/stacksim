import { rest } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { decorateCloudFrontPanelHelp } from "./cloudfront-help.js";

export const metadata = {
  key: "cloudfront",
  name: "CloudFront",
  icon: "C",
  cls: "cloudfront",
  links: [
    ["Distributions", "#/cloudfront/distributions"],
    ["Functions", "#/cloudfront/functions"],
    ["Response policies", "#/cloudfront/response-policies"],
    ["Origin access", "#/cloudfront/origin-access-controls"],
  ],
  search: ["cloudfront", "distribution", "cdn", "edge", "cache", "invalidation", "origin access control", "oac", "response headers"],
};

const encoded = encodeURIComponent;
const distributionHref = id => `#/cloudfront/distributions/${encoded(id)}`;

function status(value, enabled = true) {
  const label = enabled === false ? "Disabled" : value ?? "Unknown";
  const cls = enabled === false ? "warning" : value === "Deployed" || value === "Completed" ? "success" : value === "InProgress" ? "pending" : "error";
  return `<span class="status ${cls}" role="status">${escapeHtml(label)}</span>`;
}

function collection(value, key) {
  return Array.isArray(value?.[key]) ? value[key] : [];
}

async function aggregate() {
  return rest("/_stacksim/api/cloudfront");
}

function listenerFor(snapshot, distributionId) {
  return collection(snapshot, "localViewers").find(viewer => viewer.distributionId === distributionId);
}

async function distributionsPage(context) {
  context.setChrome("cloudfront", ["CloudFront", "Distributions"]);
  const snapshot = await aggregate();
  const values = collection(snapshot, "distributions");
  const rows = values.map(distribution => {
    const viewer = listenerFor(snapshot, distribution.id);
    const enabled = distribution.config?.Enabled !== false;
    return `<tr data-search-row="${escapeHtml(`${distribution.id} ${distribution.domainName} ${distribution.status}`.toLowerCase())}"><td><a class="mono" href="${distributionHref(distribution.id)}">${escapeHtml(distribution.id)}</a></td><td class="mono">${escapeHtml(distribution.domainName)}</td><td>${status(distribution.status, enabled)}</td><td>${escapeHtml(distribution.config?.Origins?.Items?.Origin?.DomainName ?? distribution.config?.Origins?.Items?.[0]?.DomainName ?? "Private S3 origin")}</td><td>${viewer?.available ? '<span class="status success">Available</span>' : '<span class="status warning">Degraded</span>'}</td></tr>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader("Distributions", "Account-global CloudFront resources and their separately reported local viewer endpoints.", '<button class="button" type="button" data-refresh>Refresh</button>')}<div class="alert info"><strong>Canonical output stays AWS-shaped.</strong><br>The <span class="mono">*.cloudfront.net</span> domain is resource identity. Open the dedicated <span class="mono">*.localhost</span> URL from distribution detail for local traffic.</div><section class="card" data-cloudfront-panel="distributions"><div class="card-header"><h2>Distributions <span class="muted">(${values.length})</span></h2></div>${rows ? `<div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find distribution ID or domain"></label></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Canonical domain</th><th>Status</th><th>Origin</th><th>Local viewer</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("C", "No distributions", "Deploy the ordinary CFR-01 CloudFront website fixture, then refresh.")}</section></div>`;
  context.bindTableFilter(context.main);
  context.main.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

function cacheDetails(cache = {}) {
  return `<dl class="key-value"><dt>Entries</dt><dd>${Number(cache.entries ?? 0).toLocaleString()}</dd><dt>Bytes</dt><dd>${Number(cache.bytes ?? 0).toLocaleString()}</dd><dt>Hits</dt><dd>${Number(cache.hits ?? 0).toLocaleString()}</dd><dt>Misses</dt><dd>${Number(cache.misses ?? 0).toLocaleString()}</dd><dt>Evictions</dt><dd>${Number(cache.evictions ?? 0).toLocaleString()}</dd><dt>Invalidations</dt><dd>${Number(cache.invalidations ?? 0).toLocaleString()}</dd><dt>Fence generation</dt><dd>${Number(cache.generation ?? 0).toLocaleString()}</dd></dl>`;
}

async function distributionDetail(context, id) {
  context.setChrome("cloudfront", ["CloudFront", "Distributions", id]);
  const result = await rest(`/_stacksim/api/cloudfront/distributions/${encoded(id)}`);
  const distribution = result.distribution;
  const viewer = result.localViewer;
  const invalidations = result.invalidations ?? [];
  const curl = viewer?.localUrl && viewer?.caCertificatePath ? `curl --cacert ${viewer.caCertificatePath} ${viewer.localUrl}` : undefined;
  const invalidationRows = invalidations.map(value => `<tr><td class="mono">${escapeHtml(value.id)}</td><td>${status(value.status)}</td><td>${escapeHtml((value.paths ?? []).join(", "))}</td><td>${formatDate(value.createTime)}</td><td class="mono">${escapeHtml(value.callerReference)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader(distribution.id, "CloudFront distribution detail.", '<a class="button" href="#/cloudfront/distributions">All distributions</a><button class="button" type="button" data-refresh>Refresh</button>')}<div class="detail-grid"><section class="card" data-cloudfront-panel="distributions"><div class="card-header"><h2>Distribution</h2>${status(distribution.status, distribution.config?.Enabled !== false)}</div><div class="card-body"><dl class="key-value"><dt>Canonical domain</dt><dd class="mono">${escapeHtml(distribution.domainName)}</dd><dt>ARN</dt><dd class="mono sfn-wrap">${escapeHtml(distribution.arn)}</dd><dt>ETag</dt><dd class="mono">${escapeHtml(distribution.etag)}</dd><dt>Configuration revision</dt><dd>${escapeHtml(distribution.configRevision)}</dd><dt>Deployed revision</dt><dd>${escapeHtml(distribution.deployedRevision ?? "–")}</dd><dt>Last modified</dt><dd>${formatDate(distribution.lastModifiedAt)}</dd></dl></div></section><section class="card" data-cloudfront-panel="viewer"><div class="card-header"><h2>Local viewer endpoint</h2>${viewer?.available ? '<span class="status success">Available</span>' : '<span class="status warning">Degraded</span>'}</div><div class="card-body"><dl class="key-value"><dt>Local URL</dt><dd class="mono sfn-wrap">${escapeHtml(viewer?.localUrl ?? "Unavailable")}</dd><dt>Port</dt><dd>${escapeHtml(viewer?.port ?? "–")}</dd><dt>CA certificate</dt><dd class="mono sfn-wrap">${escapeHtml(viewer?.caCertificatePath ?? "Unavailable")}</dd></dl>${curl ? `<p class="muted small">Use the installation CA explicitly:</p><pre class="code-box"><code>${escapeHtml(curl)}</code></pre>` : '<div class="alert warning" role="alert"><strong>Viewer endpoint unavailable.</strong><br>Check local TLS material and the persisted listener port; StackSim will not silently change the URL.</div>'}</div></section></div><div class="detail-grid"><section class="card"><div class="card-header"><h2>Cache diagnostics</h2></div><div class="card-body">${cacheDetails(viewer?.cache)}</div></section><section class="card"><div class="card-header"><h2>Deployed behavior</h2></div><div class="card-body"><dl class="key-value"><dt>Default root</dt><dd>${escapeHtml(distribution.config?.DefaultRootObject ?? "–")}</dd><dt>HTTP version descriptor</dt><dd>${escapeHtml(distribution.config?.HttpVersion ?? "–")}</dd><dt>Enabled</dt><dd>${distribution.config?.Enabled === false ? "No" : "Yes"}</dd><dt>IPv6 descriptor</dt><dd>${distribution.config?.IsIPV6Enabled === true || distribution.config?.IPV6Enabled === true ? "Enabled" : "–"}</dd></dl></div></section></div><section class="card" data-cloudfront-panel="invalidations"><div class="card-header"><h2>Invalidations <span class="muted">(${invalidations.length})</span></h2></div>${invalidationRows ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Paths</th><th>Created</th><th>Caller reference</th></tr></thead><tbody>${invalidationRows}</tbody></table></div>` : emptyState("↻", "No invalidations", "BucketDeployment invalidation history will appear here.")}</section></div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

async function functionsPage(context) {
  context.setChrome("cloudfront", ["CloudFront", "Functions"]);
  const values = collection(await aggregate(), "functions");
  const rows = values.map(value => `<tr><td>${escapeHtml(value.name)}</td><td class="mono sfn-wrap">${escapeHtml(value.arn)}</td><td>${escapeHtml(value.development?.runtime ?? "–")}</td><td>${value.live ? '<span class="status success">Published</span>' : '<span class="status warning">Development only</span>'}</td><td>${escapeHtml(value.development?.version ?? "–")} / ${escapeHtml(value.live?.version ?? "–")}</td><td>${formatDate(value.development?.lastModifiedAt)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader("CloudFront Functions", "Safe metadata for DEVELOPMENT and LIVE viewer-request revisions.", '<button class="button" type="button" data-refresh>Refresh</button>')}<section class="card" data-cloudfront-panel="functions"><div class="card-header"><h2>CloudFront Functions <span class="muted">(${values.length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>ARN</th><th>Runtime</th><th>LIVE</th><th>Development / LIVE version</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("ƒ", "No Functions", "Deploy a CFR-01 viewer-request Function.")}</section></div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

async function policiesPage(context) {
  context.setChrome("cloudfront", ["CloudFront", "Response policies"]);
  const values = collection(await aggregate(), "responseHeadersPolicies");
  const rows = values.map(value => `<tr><td>${escapeHtml(value.name)}</td><td class="mono">${escapeHtml(value.id)}</td><td>${escapeHtml(Object.keys(value.securityHeadersConfig ?? {}).join(", ") || "Security headers")}</td><td>${formatDate(value.lastModifiedAt)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader("Response headers policies", "Custom security policies applied after cache or origin response selection.", '<button class="button" type="button" data-refresh>Refresh</button>')}<section class="card" data-cloudfront-panel="policies"><div class="card-header"><h2>Response headers policies <span class="muted">(${values.length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>ID</th><th>Sections</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("H", "No response policies", "Deploy the CFR-01 security response policy.")}</section></div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

async function oacsPage(context) {
  context.setChrome("cloudfront", ["CloudFront", "Origin access"]);
  const values = collection(await aggregate(), "originAccessControls");
  const rows = values.map(value => `<tr><td>${escapeHtml(value.name)}</td><td class="mono">${escapeHtml(value.id)}</td><td>${escapeHtml(value.originType ?? value.config?.OriginAccessControlOriginType ?? "s3")}</td><td>${escapeHtml(value.signingBehavior ?? value.config?.SigningBehavior ?? "always")}</td><td>${escapeHtml(value.signingProtocol ?? value.config?.SigningProtocol ?? "sigv4")}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader("Origin access controls", "CloudFront service-principal access to private simulator-owned S3 origins.", '<button class="button" type="button" data-refresh>Refresh</button>')}<section class="card" data-cloudfront-panel="oacs"><div class="card-header"><h2>Origin access controls <span class="muted">(${values.length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>ID</th><th>Origin type</th><th>Signing behavior</th><th>Protocol</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("O", "No origin access controls", "Deploy a private-S3 CloudFront distribution.")}</section></div>`;
  context.main.querySelector("[data-refresh]")?.addEventListener("click", context.route);
}

export async function routeCloudFront(parts, context) {
  let result;
  if (parts[1] === undefined || parts[1] === "distributions" && parts.length === 2) result = await distributionsPage(context);
  else if (parts[1] === "distributions" && parts[2] && parts.length === 3) result = await distributionDetail(context, parts[2]);
  else if (parts[1] === "functions" && parts.length === 2) result = await functionsPage(context);
  else if (parts[1] === "response-policies" && parts.length === 2) result = await policiesPage(context);
  else if (parts[1] === "origin-access-controls" && parts.length === 2) result = await oacsPage(context);
  else result = context.notFound(parts);
  decorateCloudFrontPanelHelp(context.main);
  return result;
}

