import { escapeHtml as esc, pageHeader } from "../components.js";

export async function renderMaintenance(domain, context, { api, show, chrome, live, refresh, later }) {
  const name = domain.DomainName, encoded = encodeURIComponent(name), prefix = `/opensearch/domain/${encoded}`;
  const [nodes, result] = await Promise.all([api(`${prefix}/nodes`), api(`${prefix}/domainMaintenances`)]);
  const jobs = result.DomainMaintenances ?? [], pending = jobs.some(job => ["PENDING", "IN_PROGRESS"].includes(job.Status));
  chrome(["Domains", name, "Maintenance"]);
  show(`${pageHeader("Domain maintenance", name, `<a class="button" href="#/opensearch/domains/${encoded}">Back to domain</a><button class="button" data-refresh>Refresh</button>`)}
    <div role="alert" class="alert error" id="maintenance-error" hidden tabindex="-1"></div>
    <section class="card"><div class="card-header"><h2>Embedded node</h2></div><div class="card-body">${nodes.DomainNodesStatusList.map(node => `<dl class="detail-grid key-value"><div><dt>Node ID</dt><dd class="osis-endpoint mono">${esc(node.NodeId)}</dd></div><div><dt>Status</dt><dd>${esc(node.NodeStatus)}</dd></div><div><dt>Storage</dt><dd>Local persistent storage</dd></div></dl>`).join("")}<p>Search restart reopens the domain database. Node reboot also rebinds its HTTPS endpoint. Stored documents are preserved; active search contexts expire. New requests are unavailable during the restart.</p><div class="actions"><button class="button" data-maintenance="RESTART_SEARCH_PROCESS" ${domain.Processing || pending ? "disabled" : ""}>Restart search</button><button class="button" data-maintenance="REBOOT_NODE" ${domain.Processing || pending ? "disabled" : ""}>Reboot embedded node</button></div><p class="hint">The embedded workspace has no separate Dashboard process. AWS host reboots and service-software updates are unavailable.</p></div></section>
    <section class="card"><div class="card-header"><h2>Maintenance history</h2></div><div class="card-body">${jobs.length ? `<div class="table-wrap"><table><thead><tr><th>Operation</th><th>Status</th><th>Updated</th><th>Details</th></tr></thead><tbody>${jobs.map(job => `<tr><td>${job.Action === "REBOOT_NODE" ? "Node reboot" : "Search restart"}</td><td>${esc(job.Status)}</td><td>${esc(new Date(job.UpdatedAt * 1000).toLocaleString())}</td><td>${esc(job.StatusMessage)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No maintenance jobs.</p>'}<p class="hint">The latest 100 jobs are retained.</p></div></section>`);
  if (!live()) return;
  context.main.querySelector("[data-refresh]").onclick = refresh;
  context.main.querySelectorAll("[data-maintenance]").forEach(button => button.onclick = async () => {
    const buttons = context.main.querySelectorAll("[data-maintenance]"); buttons.forEach(item => { item.disabled = true; });
    try { await api(`${prefix}/domainMaintenance`, "POST", { Action: button.dataset.maintenance, NodeId: nodes.DomainNodesStatusList[0].NodeId }); if (live()) { context.toast("Maintenance started"); refresh(); } }
    catch (error) { if (live()) { const box = context.main.querySelector("#maintenance-error"); box.hidden = false; box.textContent = error.message; box.focus(); buttons.forEach(item => { item.disabled = false; }); } }
  });
  if (pending) later();
}
