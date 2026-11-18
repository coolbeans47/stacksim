import { request } from "../api-client.js";
import { emptyState, escapeHtml as esc, pageHeader } from "../components.js";
import { session, setDirty } from "../state.js";
import { renderSearchWorkspace } from "./opensearch-workspace.js";
import { routeIngestion } from "./opensearch-ingestion.js";
import { routeServerless } from "./opensearch-serverless.js";
import { renderSnapshots } from "./opensearch-snapshots.js";
import { renderConnections } from "./opensearch-connections.js";
import { renderMaintenance } from "./opensearch-maintenance.js";
import { renderIngestPipelines } from "./opensearch-ingest-pipelines.js";
import { renderQueryLanguages } from "./opensearch-query-languages.js";
import { renderSearchPipelines } from "./opensearch-search-pipelines.js";
import { renderIsm } from "./opensearch-ism.js";
import { renderMonitoring } from "./opensearch-monitoring.js";
import { renderPackages, renderDomainPackages } from "./opensearch-packages.js";
import { renderInsights } from "./opensearch-insights.js";
import { routeApplications } from './opensearch-applications.js';
import { routeDirectQueries } from './opensearch-direct-query.js';

export const metadata = {
  key: "opensearch", name: "Amazon OpenSearch Service", icon: "O", cls: "db",
  search: ["opensearch", "open search", "elasticsearch", "search", "domains", "indexes"],
  links: [["Overview", "#/opensearch"], ["Domains", "#/opensearch/domains"], ["Collections", "#/opensearch/serverless/collections"], ["Ingestion pipelines", "#/opensearch/ingestion/pipelines"], ["Packages", "#/opensearch/packages"], ["Applications", "#/opensearch/applications"], ["Connected data sources", "#/opensearch/direct-query"]],
};
const base = "/2021-01-01";
const href = name => `#/opensearch/domains/${encodeURIComponent(name)}`;
const api = (path, method = "GET", body) => request(`${base}${path}`, { service: "es", method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const capabilities = name => request(name === undefined ? "/_stacksim/api/opensearch/capabilities" : `/_stacksim/api/opensearch/domains/${encodeURIComponent(name)}/capabilities`, { service: "es" });
const query = (name, method, path, body) => request(`/_stacksim/api/opensearch/domains/${encodeURIComponent(name)}/query`, { service: "es", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, path, body }) }).catch(error => { if (typeof error.details?.error?.reason === "string") error.message = error.details.error.reason; throw error; });
const json = value => esc(JSON.stringify(value, null, 2));
const state = domain => domain.Deleted ? "Deleting" : domain.DomainProcessingStatus === "Isolated" ? "Failed" : domain.Processing ? "Processing" : "Active";
let generation = 0;
let poll;

function securityFields(creating, domain) {
  const encrypted = creating || domain.EncryptionAtRestOptions?.Enabled;
  const mode = domain?.AdvancedSecurityOptions?.Enabled ? domain.AdvancedSecurityOptions.InternalUserDatabaseEnabled ? "internal" : "iam" : "off";
  return `<div class="field"><label class="os-delete-confirm"><input type="checkbox" name="encrypted" ${encrypted ? "checked" : ""} ${!creating && domain.EncryptionAtRestOptions?.Enabled ? "disabled" : ""}> Encrypt search storage</label><span class="hint">AES-256-GCM protects persistent search data with a local managed key. This is a local encryption analogue, not AWS KMS.</span></div><div class="field"><label for="os-security-mode">Fine-grained access</label><select name="security" id="os-security-mode" ><option value="off" ${mode === "off" ? "selected" : "disabled"}>Disabled</option><option value="iam" ${mode === "iam" ? "selected" : ""}>IAM master user</option><option value="internal" ${mode === "internal" ? "selected" : ""}>Internal user database</option></select><span class="hint">Requires encrypted storage and HTTPS. Internal users also need a domain access policy that permits unsigned requests.</span></div><div class="field"><label for="os-master-arn">IAM master ARN</label><input id="os-master-arn" name="masterArn" placeholder="arn:aws:iam::000000000000:role/SearchAdmin" autocomplete="off"><span class="hint">For IAM mode. Leave blank when keeping the existing master.</span></div><div class="field-row"><div class="field"><label for="os-master-name">Internal master username</label><input id="os-master-name" name="masterName" autocomplete="off"></div><div class="field"><label for="os-master-password">Internal master password</label><input id="os-master-password" name="masterPassword" type="password" autocomplete="new-password"><span class="hint">8–256 characters with uppercase, lowercase, a number and a symbol. Leave both fields blank to keep the current master.</span></div></div>`;
}
function securityInput(data, creating, domain) {
  const encrypted = data.has("encrypted") || domain?.EncryptionAtRestOptions?.Enabled;
  const oldMode = domain?.AdvancedSecurityOptions?.Enabled ? domain.AdvancedSecurityOptions.InternalUserDatabaseEnabled ? "internal" : "iam" : "off";
  const mode = String(data.get("security") ?? oldMode);
  const result = creating || Boolean(encrypted) !== Boolean(domain?.EncryptionAtRestOptions?.Enabled) ? { EncryptionAtRestOptions: { Enabled: Boolean(encrypted) } } : {};
  if (mode === "off") return result;
  if (!encrypted) throw new Error("Enable encrypted storage before configuring fine-grained access.");
  const arn = String(data.get("masterArn") ?? "").trim(), name = String(data.get("masterName") ?? "").trim(), password = String(data.get("masterPassword") ?? "");
  if (creating || mode !== oldMode || arn || name || password) {
    const master = mode === "iam" ? arn ? { MasterUserARN: arn } : undefined : name && password ? { MasterUserName: name, MasterUserPassword: password } : undefined;
    if (!master) throw new Error(mode === "iam" ? "Enter the IAM master ARN." : "Enter both the internal master username and password.");
    result.NodeToNodeEncryptionOptions = { Enabled: true };
    result.AdvancedSecurityOptions = { Enabled: true, InternalUserDatabaseEnabled: mode === "internal", MasterUserOptions: master };
  }
  return result;
}

export async function routeOpenSearch(parts, context) {
  clearTimeout(poll);
  const current = ++generation;
  const hash = location.hash, region = session.region, identity = session.credentials?.active;
  const live = () => current === generation && hash === location.hash && region === session.region && identity === session.credentials?.active;
  const show = html => { if (live()) context.main.innerHTML = `<div class="page-width opensearch-page">${html}</div>`; };
  const refresh = () => { if (live()) void context.route(false); };
  const later = () => { poll = setTimeout(refresh, 2000); };
  const chrome = titles => { if (live()) context.setChrome("opensearch", ["Amazon OpenSearch Service", ...titles]); };
  const fail = (form, error) => { const box = form.querySelector('[role="alert"]'); box.hidden = false; box.textContent = error.message; box.focus(); };
  const bindDelete = (name, domain) => context.main.querySelector('[data-delete-domain]')?.addEventListener("click", () => context.confirmDeletion(name, "Deleting this domain permanently removes its indexes and documents.", async () => { await api(`/opensearch/domain/${encodeURIComponent(name)}`, "DELETE"); context.toast("Domain deletion started"); location.hash = "#/opensearch/domains"; }));

  if (parts.length === 1) {
    chrome([]);
    const info = await capabilities();
    show(`${pageHeader("Amazon OpenSearch Service", "Create a local search domain, index documents, and query application data.", '<a class="button primary" href="#/opensearch/domains/create">Create domain</a>')}<div class="alert info">Search runs inside StackSim. The embedded compatibility profile supports a bounded query language; scoring and plugins differ from native OpenSearch.</div><div class="dashboard-grid"><section class="card"><div class="card-header"><h2>Managed domains</h2></div><div class="card-body"><p>Persistent indexes, document APIs, full-text queries and aggregations.</p><p><strong>${info.domains.length}</strong> local domains</p><a href="#/opensearch/domains">View domains</a></div></section><section class="card"><div class="card-header"><h2>Serverless</h2></div><div class="card-body"><p>Encrypted search, time-series and vector collections with independent network, IAM and data access policies.</p><a href="#/opensearch/serverless/collections">View collections</a></div></section><section class="card"><div class="card-header"><h2>Ingestion</h2></div><div class="card-body"><p>Signed HTTP events, encrypted buffering, transformations and authorized search delivery.</p><a href="#/opensearch/ingestion/pipelines">View pipelines</a></div></section></div>`);
    return;
  }
  if (parts[1] === "ingestion") return routeIngestion(parts, context, { show, chrome, live, refresh, later });
  if (parts[1] === "serverless") return routeServerless(parts, context, { show, chrome, live, refresh, later });
  if (parts[1] === "packages") return renderPackages(parts, context, { api, show, chrome, live, refresh, later });
  if (parts[1] === 'applications') return routeApplications(parts, context, { api, show, chrome, live, refresh, later });
  if (parts[1] === 'direct-query') return routeDirectQueries(parts, context, { api, show, chrome, live, refresh, later });
  if (parts[1] !== "domains") return context.notFound(parts);
  if (parts.length === 2) {
    chrome(["Domains"]);
    const { DomainNames = [] } = await api("/domain");
    const domains = [];
    for (let at = 0; at < DomainNames.length; at += 5) { const result = await api("/opensearch/domain-info", "POST", { DomainNames: DomainNames.slice(at, at + 5).map(item => item.DomainName) }); domains.push(...result.DomainStatusList); }
    show(`${pageHeader("Domains", "Manage search domains in the selected account and Region.", '<a class="button primary" href="#/opensearch/domains/create">Create domain</a>')}<section class="card"><div class="card-header"><h2>Domains (${domains.length})</h2><button class="button" data-refresh>Refresh</button></div><div class="toolbar"><div class="filter"><input aria-label="Find domains" placeholder="Find domains" id="os-filter"></div><label>Sort <select aria-label="Sort domains" id="os-sort"><option value="name">Name</option><option value="status">Status</option></select></label></div><div id="os-list"></div><div class="toolbar"><button class="button" id="os-prev">Previous</button><span id="os-page" role="status"></span><button class="button" id="os-next">Next</button></div></section>`);
    if (!live()) return;
    let page = 0;
    const render = () => {
      const filter = context.main.querySelector("#os-filter").value.toLowerCase();
      const sort = context.main.querySelector("#os-sort").value;
      const filtered = domains.filter(domain => domain.DomainName.includes(filter)).sort((a, b) => (sort === "name" ? a.DomainName.localeCompare(b.DomainName) : state(a).localeCompare(state(b))) || a.DomainName.localeCompare(b.DomainName));
      const pages = Math.max(1, Math.ceil(filtered.length / 20)); page = Math.min(page, pages - 1);
      context.main.querySelector("#os-list").innerHTML = filtered.length ? `<div class="table-wrap"><table><thead><tr><th>Domain name</th><th>Status</th><th>Engine version</th><th>Endpoint</th></tr></thead><tbody>${filtered.slice(page * 20, page * 20 + 20).map(domain => `<tr><td><a href="${href(domain.DomainName)}">${esc(domain.DomainName)}</a></td><td>${esc(state(domain))}</td><td>${esc(domain.EngineVersion)}</td><td class="mono">${esc(domain.Endpoint ?? "Not yet available")}</td></tr>`).join("")}</tbody></table></div>` : emptyState("O", domains.length ? "No matching domains" : "No domains", domains.length ? "Change or clear the search filter." : "Create a domain to start indexing and searching documents.", domains.length ? "" : '<a class="button primary" href="#/opensearch/domains/create">Create domain</a>');
      context.main.querySelector("#os-page").textContent = `Page ${page + 1} of ${pages}`; context.main.querySelector("#os-prev").disabled = page === 0; context.main.querySelector("#os-next").disabled = page === pages - 1;
    };
    context.main.querySelector("#os-filter").oninput = () => { page = 0; render(); };
    context.main.querySelector("#os-sort").onchange = render;
    context.main.querySelector("#os-prev").onclick = () => { page--; render(); };
    context.main.querySelector("#os-next").onclick = () => { page++; render(); };
    context.main.querySelector("[data-refresh]").onclick = refresh; render();
    // Creation status is refreshed explicitly in the list so filters and page selection remain stable.
    return;
  }
  const creating = parts[2] === "create";
  if (parts[3] && (creating || !['edit', 'workspace', 'local-query', 'snapshots', 'connections', 'maintenance', 'packages', 'insights', 'ingest-pipelines', 'query-languages', 'search-pipelines', 'ism', 'monitoring'].includes(parts[3]))) return context.notFound(parts);
  const name = parts[2];
  const domain = creating ? undefined : (await api(`/opensearch/domain/${encodeURIComponent(name)}`)).DomainStatus;
  if (!live()) return;
  if (!creating && parts[3] === "snapshots") return renderSnapshots(name, parts[4], context, { query: (method, path, body) => query(name, method, path, body), show, chrome, live, refresh, later });
  if (!creating && parts[3] === "connections") return renderConnections(domain, context, { api, query, show, chrome, live, refresh });
  if (!creating && parts[3] === "maintenance") return renderMaintenance(domain, context, { api, show, chrome, live, refresh, later });
  if (!creating && parts[3] === "packages") return renderDomainPackages(domain, context, { api, show, chrome, live, refresh });
  if (!creating && parts[3] === "insights") return renderInsights(domain, context, { api, show, chrome, live });
  if (!creating && parts[3] === "ingest-pipelines") return renderIngestPipelines(domain, context, { query: (method, path, body) => query(name, method, path, body), show, chrome, live, refresh });
  if (!creating && parts[3] === "query-languages") return renderQueryLanguages(domain, context, { query: (method, path, body) => query(name, method, path, body), show, chrome, live });
  if (!creating && parts[3] === "search-pipelines") return renderSearchPipelines(domain, context, { query: (method, path, body) => query(name, method, path, body), show, chrome, live, refresh });
  if (!creating && parts[3] === "ism") return renderIsm(domain, context, { query: (method, path, body) => query(name, method, path, body), show, chrome, live, refresh });
  if (!creating && parts[3] === "monitoring") return renderMonitoring(domain, context, { api, query: (method, path, body) => query(name, method, path, body), capabilities, show, chrome, live });
  if (creating || parts[3] === "edit") {
    chrome(["Domains", creating ? "Create domain" : name, ...(creating ? [] : ["Edit configuration"])]);
    const versions = await api("/opensearch/versions");
    show(`${pageHeader(creating ? "Create domain" : "Edit domain configuration", "Local development configuration")}<form id="os-domain-form"><div role="alert" class="alert error" tabindex="-1" hidden></div><section class="card"><div class="card-header"><h2>Domain configuration</h2></div><div class="card-body"><div class="field"><label for="os-name">Domain name</label><input id="os-name" name="name" required minlength="3" maxlength="28" pattern="[a-z][a-z0-9\-]{2,27}" value="${esc(creating ? "" : name)}" ${creating ? "" : "readonly"}><span class="hint">3–28 lowercase letters, digits or hyphens; start with a letter.</span></div><div class="field-row"><div class="field"><label for="os-engine">Engine compatibility</label><select id="os-engine" name="engine" ${creating ? "" : "disabled"}>${versions.Versions.map(version => `<option>${esc(version)}</option>`).join("")}</select></div><div class="field"><span>Deployment</span><p>Single embedded node</p></div></div><p class="muted">Persistent local storage. EC2 capacity, EBS, replicas, and VPC deployment are unavailable. Search scoring uses local term counts.</p></div></section><section class="card"><div class="card-header"><h2>Network and security</h2></div><div class="card-body"><div class="detail-grid"><div><strong>Endpoint</strong><p>HTTPS on a dedicated loopback port</p></div><div><strong>Minimum TLS</strong><p>TLS 1.2</p></div><div><strong>Authentication</strong><p>AWS Signature Version 4 and IAM</p></div></div>${securityFields(creating, domain)}<div class="field"><label for="os-policy">Access policy (JSON)</label><textarea id="os-policy" name="policy" spellcheck="false" placeholder="Optional domain resource policy">${esc(domain?.AccessPolicies ?? "")}</textarea><span class="hint">An empty policy uses IAM identity permissions. Domain policy explicit denies take precedence.</span></div><div class="field"><label for="os-explicit">Explicit index names in multi-document requests</label><select id="os-explicit" name="explicit"><option value="true" ${domain?.AdvancedOptions?.["rest.action.multi.allow_explicit_index"] !== "false" ? "selected" : ""}>Allow</option><option value="false" ${domain?.AdvancedOptions?.["rest.action.multi.allow_explicit_index"] === "false" ? "selected" : ""}>Reject</option></select><span class="hint">Disable explicit index names when using URL-based policies to limit bulk and multi-search requests.</span></div></div></section>${creating ? '<section class="card"><div class="card-header"><h2>Tags</h2></div><div class="card-body"><div class="field"><label for="os-tags">Tags (JSON object)</label><textarea id="os-tags" name="tags">{}</textarea></div></div></section>' : ""}<div class="actions"><a class="button" href="${creating ? "#/opensearch/domains" : href(name)}">Cancel</a>${creating ? "" : '<button class="button" type="button" id="os-dry-run">Run dry run</button>'}<button class="button primary" type="submit">${creating ? "Create domain" : "Save changes"}</button></div><p id="os-dry-run-result" role="status"></p></form>`);
    if (!live()) return;
    const form = context.main.querySelector("#os-domain-form"); form.addEventListener("input", () => setDirty(true));
    const input = () => { const data = new FormData(form); const policy = String(data.get("policy") ?? "").trim(); if (policy) JSON.parse(policy); const tagObject = creating ? JSON.parse(String(data.get("tags"))) : {}; if (!tagObject || typeof tagObject !== "object" || Array.isArray(tagObject)) throw new Error("Tags must be a JSON object"); return { ...securityInput(data, creating, domain), DomainName: String(data.get("name")), AccessPolicies: policy, AdvancedOptions: { "rest.action.multi.allow_explicit_index": String(data.get("explicit")) }, ...(creating ? { EngineVersion: String(data.get("engine")), TagList: Object.entries(tagObject).map(([Key, Value]) => ({ Key, Value: String(Value) })) } : {}) }; };
    form.querySelector("#os-dry-run")?.addEventListener("click", async event => { event.currentTarget.disabled = true; try { const result = await api(`/opensearch/domain/${encodeURIComponent(name)}/config`, "POST", { ...input(), DryRun: true }); if (live()) form.querySelector("#os-dry-run-result").textContent = result.DryRunResults.Message; } catch (error) { if (live()) fail(form, error); } finally { if (live()) form.querySelector("#os-dry-run").disabled = false; } });
    form.onsubmit = async event => { event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true; try { const body = input(); await api(creating ? "/opensearch/domain" : `/opensearch/domain/${encodeURIComponent(name)}/config`, "POST", body); if (!live()) return; setDirty(false, "all"); context.toast(creating ? "Domain creation started" : "Domain configuration saved"); location.hash = href(body.DomainName); } catch (error) { if (live()) fail(form, error); } finally { button.disabled = false; } }; return;
  }
  if (parts[3] === "workspace") {
    chrome(["Domains", name, "Search workspace"]);
    show(`${pageHeader("Search workspace", `Discover and Dev Tools for ${name}.`, `<a class="button" href="${href(name)}">Back to domain</a>`)}<div id="os-workspace"></div>`);
    if (live()) await renderSearchWorkspace({ root: context.main.querySelector("#os-workspace"), query: (method, path, body) => query(name, method, path, body), live, dirty: value => setDirty(value), toast: context.toast });
    return;
  }
  if (parts[3] === "local-query") {
    chrome(["Domains", name, "Local query tool"]);
    show(`${pageHeader("Local query tool", `Run requests against ${name}. This tool is separate from OpenSearch Dashboards.`, `<a class="button" href="${href(name)}">Back to domain</a>`)}<div class="alert info">Use ordinary OpenSearch paths such as <code>/products/_search</code>. Acknowledge destructive operations before sending a DELETE request.</div><form id="os-query-form"><div role="alert" class="alert error" hidden tabindex="-1"></div><section class="card"><div class="card-body"><div class="field-row"><div class="field"><label for="os-method">HTTP method</label><select id="os-method" name="method"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>HEAD</option></select></div><div class="field"><label for="os-path">Request path</label><input id="os-path" name="path" required value="/_search"></div></div><div class="field"><label for="os-body">Request body (JSON or NDJSON)</label><textarea id="os-body" name="body" spellcheck="false">{"query":{"match_all":{}}}</textarea></div><label class="os-delete-confirm"><input type="checkbox" name="confirm"> I understand that DELETE permanently removes data</label><div class="actions"><button class="button primary" type="submit" ${domain.Endpoint ? "" : "disabled"}>Run request</button><button class="button" type="button" id="os-indexes" ${domain.Endpoint ? "" : "disabled"}>List indexes</button></div></div></section></form><section class="card"><div class="card-header"><h2>Response</h2><span id="os-query-status" role="status"></span></div><pre id="os-query-response" class="code-box" tabindex="0">Run a request to view its response.</pre></section>`);
    if (!live()) return;
    const form = context.main.querySelector("#os-query-form"); form.addEventListener("input", () => setDirty(true));
    const run = async (method, path, body) => { form.querySelector('[role="alert"]').hidden = true; const result = await query(name, method, path, body); if (live()) { context.main.querySelector("#os-query-response").textContent = JSON.stringify(result, null, 2); context.main.querySelector("#os-query-status").textContent = "Request completed"; } };
    form.onsubmit = async event => { event.preventDefault(); const data = new FormData(form); const submit = form.querySelector('[type="submit"]'); submit.disabled = true; try { if (data.get("method") === "DELETE" && !data.get("confirm")) throw new Error("Confirm the destructive operation before sending DELETE."); await run(String(data.get("method")), String(data.get("path")), String(data.get("body"))); } catch (error) { if (live()) { fail(form, error); context.main.querySelector("#os-query-status").textContent = "Request failed"; context.main.querySelector("#os-query-response").textContent = JSON.stringify(error.details ?? { message: error.message }, null, 2); } } finally { if (live()) submit.disabled = false; } };
    form.querySelector("#os-indexes").onclick = async () => { try { await run("GET", "/_cat/indices?format=json"); } catch (error) { if (live()) fail(form, error); } }; return;
  }
  chrome(["Domains", name]);
  const [tagResult, info] = await Promise.all([api(`/tags?arn=${encodeURIComponent(domain.ARN)}`), capabilities(name)]);
  const diagnostic = info.domains.find(item => item.name === name);
  show(`${pageHeader(name, `Managed domain · ${domain.EngineVersion}`, `<button class="button" data-refresh>Refresh</button><a class="button" href="${href(name)}/insights">View insights</a><a class="button" href="${href(name)}/edit">Edit configuration</a><button class="button danger" data-delete-domain ${domain.Processing && !(domain.Deleted && diagnostic?.failure) ? "disabled" : ""}>${domain.Deleted && diagnostic?.failure ? "Retry deletion" : "Delete domain"}</button>`)}${diagnostic?.failure ? `<div class="alert error" role="alert">${esc(diagnostic.failure)}</div>` : ""}<section class="card"><div class="card-header"><h2>Domain status</h2><span role="status">${esc(state(domain))}</span></div><div class="card-body"><dl class="detail-grid key-value"><div><dt>Domain ARN</dt><dd class="mono">${esc(domain.ARN)}</dd></div><div><dt>Engine compatibility</dt><dd>${esc(domain.EngineVersion)}</dd></div><div><dt>Domain endpoint</dt><dd class="mono">${esc(domain.Endpoint ? `https://${domain.Endpoint}` : "Not yet available")}${domain.Endpoint ? ' <button class="button" type="button" data-copy-endpoint>Copy endpoint</button>' : ""}</dd></div></dl>${domain.Endpoint ? `<div class="actions"><a class="button primary" href="${href(name)}/workspace">Open search workspace</a><a class="button" href="${href(name)}/local-query">Open local query tool</a><a class="button" href="${href(name)}/connections">Connections</a><a class="button" href="${href(name)}/snapshots">Manage snapshots</a><a class="button" href="${href(name)}/maintenance">Maintain domain</a><a class="button" href="${href(name)}/ingest-pipelines">Ingest pipelines</a><a class="button" href="${href(name)}/query-languages">SQL and PPL</a><a class="button" href="${href(name)}/search-pipelines">Search pipelines</a><a class="button" href="${href(name)}/ism">Index state management</a><a class="button" href="${href(name)}/packages">Domain packages</a><a class="button" href="${href(name)}/monitoring">Monitoring and logs</a><a class="button" href="https://${esc(domain.Endpoint)}/_stacksim/workspace-ui/" target="_blank" rel="noopener noreferrer">Sign in to resource workspace</a></div><p class="muted">The resource workspace uses the domain HTTPS certificate. Trust the StackSim local CA before opening it.</p>` : `<p role="status">${diagnostic?.failure ? 'The endpoint is unavailable. Resolve the reported failure or delete the domain.' : 'Waiting for persistent storage and the search endpoint.'}</p>`}</div></section><section class="card"><div class="card-header"><h2>Configuration</h2></div><div class="card-body"><dl class="detail-grid key-value"><div><dt>Deployment</dt><dd>One embedded node</dd></div><div><dt>Storage</dt><dd>${domain.EncryptionAtRestOptions?.Enabled ? "Encrypted snapshots and journal (AES-256-GCM)" : "Persistent local filesystem; encryption disabled"}</dd></div><div><dt>Endpoint security</dt><dd>HTTPS · TLS 1.2 or later · SigV4</dd></div></dl><p>Fine-grained access: <strong>${domain.AdvancedSecurityOptions?.Enabled ? domain.AdvancedSecurityOptions.InternalUserDatabaseEnabled ? "Internal users and mapped IAM roles" : "IAM identities and role mappings" : "Disabled"}</strong>.</p><p class="muted">The local workspace runs inside StackSim. Native OpenSearch plugins and the upstream Dashboards distribution are not bundled.</p>${domain.ChangeProgressDetails ? `<p role="status">Configuration change: ${esc(domain.ChangeProgressDetails.ConfigChangeStatus)}</p>${domain.ChangeProgressDetails.ConfigChangeStatus === "Pending" ? '<button class="button" id="os-cancel-change">Cancel pending change</button>' : ""}` : ""}<details><summary>Access policy</summary><pre class="code-box">${esc(domain.AccessPolicies || "No resource policy; IAM identity permissions apply.")}</pre></details></div></section><section class="card"><div class="card-header"><h2>Tags (${tagResult.TagList.length})</h2><button class="button" id="os-edit-tags">Edit tags</button></div><div class="card-body">${tagResult.TagList.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tagResult.TagList.map(tag => `<tr><td>${esc(tag.Key)}</td><td>${esc(tag.Value)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No tags</p>'}</div></section>`);
  if (!live()) return;
  context.main.querySelector("[data-refresh]").onclick = refresh; bindDelete(name, domain);
  context.main.querySelector("[data-copy-endpoint]")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(`https://${domain.Endpoint}`); context.toast("Endpoint copied"); } catch { context.toast("Unable to copy the endpoint. Select the endpoint text to copy it."); } });
  context.main.querySelector("#os-cancel-change")?.addEventListener("click", async () => { try { await api(`/opensearch/domain/${encodeURIComponent(name)}/config/cancel`, "POST", {}); context.toast("Configuration change cancelled"); refresh(); } catch (error) { context.toast(error.message); } });
  context.main.querySelector("#os-edit-tags").onclick = () => context.showModal("Edit domain tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${json(Object.fromEntries(tagResult.TagList.filter(tag => !tag.Key.toLowerCase().startsWith("aws:")).map(tag => [tag.Key, tag.Value])))}</textarea></div>`, "Save tags", async data => { const next = JSON.parse(String(data.get("tags"))); if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Tags must be a JSON object"); const TagList = Object.entries(next).map(([Key, Value]) => ({ Key, Value: String(Value) })); const removed = tagResult.TagList.filter(tag => !tag.Key.toLowerCase().startsWith("aws:") && !Object.hasOwn(next, tag.Key)).map(tag => tag.Key); if (TagList.length) await api("/tags", "POST", { ARN: domain.ARN, TagList }); if (removed.length) await api("/tags-removal", "POST", { ARN: domain.ARN, TagKeys: removed }); context.toast("Domain tags saved"); });
  if (domain.Processing) later();
}
