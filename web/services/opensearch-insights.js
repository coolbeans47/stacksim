import { escapeHtml as esc, pageHeader } from "../components.js";
import { setDirty } from "../state.js";

export async function renderInsights(domain, context, { api, show, chrome, live }) {
  const Entity = { Type: "DomainName", Value: domain.DomainName };
  chrome(["Domains", domain.DomainName, "Insights"]);
  show(`${pageHeader("Domain insights", domain.DomainName, `<a class="button" href="#/opensearch/domains/${encodeURIComponent(domain.DomainName)}">Back to domain</a>`)}
    <p>Insights record problems observed when this page or the insights API is read. They cover local capacity, endpoint/storage failures, log delivery, backups and the latest failed operational changes. Recovery resolves the observation. AWS fleet predictions are unavailable.</p>
    <div class="alert error" role="alert" id="insight-error" hidden tabindex="-1"></div>
    <section class="card"><div class="card-header"><h2>Observed insights</h2><button class="button" data-refresh>Refresh insights</button></div><div class="toolbar"><label for="insight-range">Time range</label><select id="insight-range"><option value="0">All retained history</option><option value="86400000">Last day</option><option value="604800000">Last week</option></select><label for="insight-sort">Sort</label><select id="insight-sort"><option value="DESC">Newest first</option><option value="ASC">Oldest first</option></select></div><div class="card-body" id="insight-list" aria-live="polite">Loading insights…</div><div class="toolbar"><button class="button" id="insight-previous" disabled>Previous insights</button><span role="status" id="insight-page">Page 1</span><button class="button" id="insight-next" disabled>Next insights</button></div></section>
    <section class="card" id="insight-details" hidden><div class="card-header"><h2>Insight details</h2></div><div class="card-body"><div id="insight-fields"></div><form id="insight-feedback"><div class="field"><label for="insight-thumbs">Was this insight useful?</label><select id="insight-thumbs" name="thumbs"><option value="Up">Yes</option><option value="Down">No</option></select></div><div class="field"><label for="insight-comment">Feedback</label><textarea id="insight-comment" name="text" rows="3" maxlength="1000"></textarea></div><p class="hint">Feedback is saved with this insight. It does not dismiss an active problem.</p><button class="button primary" type="submit">Save feedback</button><p role="status" id="insight-feedback-status"></p></form></div></section>`);
  if (!live()) return;
  const main = context.main; let index = 0, tokens = [undefined], next, selected, requestId = 0, detailId = 0, range;
  const error = value => { if (live()) { const box = main.querySelector("#insight-error"); box.textContent = value.message; box.hidden = false; box.focus(); } };
  const details = async (id, name) => {
    const version = ++detailId; main.querySelector("#insight-error").hidden = true;
    try {
      const result = await api("/opensearch/insight-details", "POST", { Entity, InsightId: id, ShowHtmlContent: false }); if (!live() || version !== detailId) return;
      selected = id; main.querySelector("#insight-details").hidden = false;
      main.querySelector("#insight-fields").innerHTML = `<h3>${esc(name)}</h3><dl class="key-value">${result.Fields.map(field => `<dt>${esc(field.Name)}</dt><dd>${field.Type === "metric" ? `<pre class="code-box">${esc(field.Value)}</pre>` : esc(field.Value)}</dd>`).join("")}</dl>`;
      main.querySelector("#insight-feedback-status").textContent = "";
      const previous = result.Fields.find(field => field.Name === "Feedback"); let saved; try { saved = previous && JSON.parse(previous.Value); } catch { /* Plain display still retains the server value. */ }
      main.querySelector("#insight-thumbs").value = saved?.thumbs ?? "Up"; main.querySelector("#insight-comment").value = saved?.text ?? "";
      main.querySelector("#insight-details").scrollIntoView({ block: "start" });
    } catch (value) { if (version === detailId) error(value); }
  };
  const list = async (target = 0) => {
    const version = ++requestId, previous = main.querySelector("#insight-previous"), following = main.querySelector("#insight-next"); previous.disabled = following.disabled = true; main.querySelector("#insight-error").hidden = true;
    if (target === 0) { tokens = [undefined]; const duration = Number(main.querySelector("#insight-range").value); range = duration ? { From: Date.now() - duration, To: Date.now() } : undefined; }
    try {
      const result = await api("/opensearch/insights", "POST", { Entity, SortOrder: main.querySelector("#insight-sort").value, MaxResults: 20, ...(tokens[target] ? { NextToken: tokens[target] } : {}), ...(range ? { TimeRange: range } : {}) }); if (!live() || version !== requestId) return;
      index = target; next = result.NextToken; if (next) tokens[index + 1] = next;
      main.querySelector("#insight-list").innerHTML = result.Insights.length ? `<div class="table-wrap"><table><thead><tr><th>Insight</th><th>Priority</th><th>Status</th><th>Observed</th><th>Details</th></tr></thead><tbody>${result.Insights.map(item => `<tr><td>${esc(item.DisplayName)}</td><td>${esc(item.Priority)}</td><td>${esc(item.Status)}</td><td>${esc(new Date(item.CreationTime * 1000).toLocaleString())}</td><td><button class="button" data-insight="${esc(item.InsightId)}">View insight</button></td></tr>`).join("")}</tbody></table></div>` : '<p>No retained insights in this time range.</p>';
      for (const button of main.querySelectorAll("[data-insight]")) button.onclick = () => details(button.dataset.insight, result.Insights.find(item => item.InsightId === button.dataset.insight).DisplayName);
      main.querySelector("#insight-page").textContent = `Page ${index + 1}`;
    } catch (value) { if (version === requestId) error(value); }
    finally { if (live() && version === requestId) { previous.disabled = index === 0; following.disabled = !next; } }
  };
  main.querySelector("[data-refresh]").onclick = () => list(); main.querySelector("#insight-range").onchange = () => list(); main.querySelector("#insight-sort").onchange = () => list(); main.querySelector("#insight-previous").onclick = () => list(index - 1); main.querySelector("#insight-next").onclick = () => list(index + 1);
  const form = main.querySelector("#insight-feedback"); form.oninput = () => setDirty(true); form.onsubmit = async event => { event.preventDefault(); if (!selected) return; const button = form.querySelector("button"); button.disabled = true;
    try { await api("/opensearch/insight-feedback", "POST", { Entity, InsightId: selected, Thumbs: form.elements.thumbs.value, FeedbackText: form.elements.text.value }); if (live()) { setDirty(false); main.querySelector("#insight-feedback-status").textContent = "Feedback saved."; } } catch (value) { error(value); } finally { if (live()) button.disabled = false; }
  };
  await list();
}
