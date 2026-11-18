const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** Shared by the console's signed session and the resource's HTTPS workspace. */
export async function renderSearchWorkspace({ root, query, live = () => true, dirty = () => {}, toast = () => {}, shared = false, readOnlySaved = false }) {
  let objects = (await query("GET", "/_stacksim/workspace")).objects;
  if (!live()) return;
  let from = 0, total = 0, selected;
  root.innerHTML = `<div class="os-workspace"><div class="alert info">StackSim search workspace · Saved objects are private to your identity. Discover and Dev Tools use your current search permissions.</div><div role="alert" class="alert error" tabindex="-1" hidden></div><div class="os-workspace-grid"><aside class="card"><div class="card-header"><h2>Saved objects</h2></div><div class="card-body"><div class="field"><label for="os-view-title">Data view name</label><input id="os-view-title" maxlength="128" placeholder="Product catalog"></div><div class="field"><label for="os-view-pattern">Index pattern</label><input id="os-view-pattern" maxlength="255" placeholder="products-*"></div><button class="button" id="os-add-view">Create data view</button><div id="os-saved-list"></div></div></aside><div><section class="card"><div class="card-header"><h2>Discover</h2><span id="os-discover-status" role="status"></span></div><form id="os-discover" class="card-body"><div class="field"><label for="os-discover-view">Data view</label><select id="os-discover-view" required></select></div><div class="field"><label for="os-discover-query">Query DSL (JSON)</label><textarea id="os-discover-query" spellcheck="false">{"match_all":{}}</textarea></div><div class="field-row"><div class="field"><label for="os-discover-fields">Source fields (comma separated)</label><input id="os-discover-fields" placeholder="title,price"></div><div class="field"><label for="os-discover-sort">Sort field</label><input id="os-discover-sort" placeholder="price"></div><div class="field"><label for="os-discover-order">Sort order</label><select id="os-discover-order"><option value="asc">Ascending</option><option value="desc">Descending</option></select></div></div><div class="actions"><button class="button primary" type="submit">Search documents</button><button class="button" type="button" id="os-save-search">Save search</button><button class="button" type="button" id="os-field-list">Inspect fields</button></div><div id="os-fields" class="muted"></div></form><div id="os-discover-results" class="card-body"><p>Select a data view and search to inspect documents.</p></div><div class="toolbar"><button class="button" id="os-discover-prev" disabled>Previous page</button><span id="os-discover-page" role="status"></span><button class="button" id="os-discover-next" disabled>Next page</button></div></section><section class="card"><div class="card-header"><h2>Dev Tools</h2><span id="os-dev-status" role="status"></span></div><form id="os-dev-tools" class="card-body"><div class="field-row"><div class="field"><label for="os-dev-method">HTTP method</label><select id="os-dev-method"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>HEAD</option></select></div><div class="field"><label for="os-dev-path">Request path</label><input id="os-dev-path" required value="/_search"></div></div><div class="field"><label for="os-dev-body">Request body (JSON or NDJSON)</label><textarea id="os-dev-body" spellcheck="false"></textarea></div><label class="os-delete-confirm"><input id="os-dev-confirm" type="checkbox"> I understand that DELETE permanently removes data</label><div class="actions"><button class="button primary" type="submit">Run request</button></div></form><pre id="os-dev-response" class="code-box" tabindex="0">Run a request to view the response.</pre></section></div></div></div>`;
  const find = selector => root.querySelector(selector);
  if (shared) find('.alert.info').textContent = 'Application workspace · Saved objects are shared within this workspace and source. Queries use your current source permissions.';
  if (readOnlySaved) { for (const id of ['#os-view-title', '#os-view-pattern', '#os-add-view', '#os-save-search']) find(id).disabled = true; }
  const alert = find('[role="alert"]');
  const error = value => { if (live()) { alert.hidden = false; alert.textContent = value.details?.error?.reason ?? value.message; alert.focus(); } };
  const work = async (button, action) => {
    button.disabled = true; alert.hidden = true;
    try { await action(); } catch (value) { error(value); } finally { if (live()) button.disabled = false; }
  };
  const refreshSaved = () => {
    const value = find("#os-discover-view").value;
    const views = objects.filter(object => object.type === "data-view");
    find("#os-discover-view").innerHTML = views.length ? views.map(view => `<option value="${escape(view.id)}">${escape(view.title)} (${escape(view.pattern)})</option>`).join("") : '<option value="">Create a data view first</option>';
    if (views.some(view => view.id === value)) find("#os-discover-view").value = value;
    find("#os-saved-list").innerHTML = objects.length ? `<ul class="os-saved-objects">${objects.map(object => `<li><button class="button" type="button" data-open="${escape(object.id)}">${escape(object.title)}</button><span class="muted">${object.type === "data-view" ? "Data view" : "Saved search"}</span><button class="button" type="button" data-remove="${escape(object.id)}" aria-label="Delete ${escape(object.title)}">Delete</button></li>`).join("")}</ul>` : '<p class="muted">No saved objects yet.</p>';
    for (const button of root.querySelectorAll("[data-open]")) button.onclick = () => {
      const object = objects.find(value => value.id === button.dataset.open);
      if (object.type === "data-view") find("#os-discover-view").value = object.id;
      else {
        const view = objects.find(value => value.type === "data-view" && value.pattern === object.pattern);
        if (!view) { error(new Error("Create a data view for this saved search's index pattern first.")); return; }
        find("#os-discover-view").value = view.id;
        find("#os-discover-query").value = JSON.stringify(object.query ?? { match_all: {} }, null, 2);
        find("#os-discover-fields").value = (object.fields ?? []).join(",");
        const sort = Object.entries(object.sort?.[0] ?? {});
        find("#os-discover-sort").value = sort[0]?.[0] ?? ""; find("#os-discover-order").value = sort[0]?.[1] ?? "asc";
      }
      from = 0; dirty(false); selected = object;
    };
    for (const button of root.querySelectorAll("[data-remove]")) button.disabled = readOnlySaved;
    for (const button of root.querySelectorAll("[data-remove]")) button.onclick = () => work(button, async () => {
      await query("DELETE", "/_stacksim/workspace", { id: button.dataset.remove }); if (!live()) return;
      objects = objects.filter(object => object.id !== button.dataset.remove); refreshSaved(); toast("Saved object deleted");
    });
  };
  refreshSaved();
  const specification = () => {
    const view = objects.find(object => object.id === find("#os-discover-view").value);
    if (!view) throw new Error("Create and select a data view first.");
    const fields = find("#os-discover-fields").value.split(",").map(field => field.trim()).filter(Boolean);
    const field = find("#os-discover-sort").value.trim();
    return { pattern: view.pattern, query: JSON.parse(find("#os-discover-query").value), fields, ...(field ? { sort: [{ [field]: find("#os-discover-order").value }] } : {}) };
  };
  find("#os-add-view").onclick = event => work(event.currentTarget, async () => {
    const result = await query("PUT", "/_stacksim/workspace", { type: "data-view", title: find("#os-view-title").value, pattern: find("#os-view-pattern").value });
    if (!live()) return; objects.push(result.object); refreshSaved(); find("#os-discover-view").value = result.object.id; dirty(false); toast("Data view created");
  });
  const discover = async () => {
    const spec = specification();
    const body = { query: spec.query, from, size: 25, track_total_hits: true, ...(spec.sort ? { sort: spec.sort } : {}), ...(spec.fields.length ? { _source: spec.fields } : {}) };
    const result = await query("POST", `/${encodeURIComponent(spec.pattern)}/_search`, body);
    if (!live()) return;
    total = result.hits.total.value;
    find("#os-discover-status").textContent = `${total} matching documents`;
    find("#os-discover-results").innerHTML = result.hits.hits.length ? `<div class="table-wrap"><table><thead><tr><th>Index</th><th>Document ID</th><th>Source</th></tr></thead><tbody>${result.hits.hits.map(hit => `<tr><td>${escape(hit._index)}</td><td>${escape(hit._id)}</td><td><pre class="os-source">${escape(JSON.stringify(hit._source, null, 2))}</pre></td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No documents match this query.</p>';
    find("#os-discover-page").textContent = total ? `${from + 1}–${Math.min(from + 25, total)} of ${total}` : "0 documents";
    find("#os-discover-prev").disabled = from === 0; find("#os-discover-next").disabled = from + 25 >= Math.min(total, 10000);
  };
  find("#os-discover").onsubmit = event => { event.preventDefault(); from = 0; void work(event.submitter, discover); };
  find("#os-discover-prev").onclick = async event => { from = Math.max(0, from - 25); await work(event.currentTarget, discover); find("#os-discover-prev").disabled = from === 0; };
  find("#os-discover-next").onclick = async event => { from += 25; await work(event.currentTarget, discover); find("#os-discover-next").disabled = from + 25 >= Math.min(total, 10000); };
  find("#os-save-search").onclick = event => work(event.currentTarget, async () => {
    const title = find("#os-view-title").value || selected?.title || "Saved search";
    const result = await query("PUT", "/_stacksim/workspace", { type: "saved-search", title, ...specification() });
    if (!live()) return; objects.push(result.object); refreshSaved(); dirty(false); toast("Search saved");
  });
  find("#os-field-list").onclick = event => work(event.currentTarget, async () => {
    const { pattern } = specification(); const result = await query("POST", `/${encodeURIComponent(pattern)}/_field_caps`, { fields: ["*"] });
    if (live()) find("#os-fields").textContent = Object.entries(result.fields).map(([field, types]) => `${field}: ${Object.keys(types).join(", ")}`).join(" · ") || "No visible mapped fields";
  });
  find("#os-dev-tools").onsubmit = event => { event.preventDefault(); void work(event.submitter, async () => {
    const method = find("#os-dev-method").value;
    if (method === "DELETE" && !find("#os-dev-confirm").checked) throw new Error("Confirm the destructive operation before sending DELETE.");
    try {
      const result = await query(method, find("#os-dev-path").value, find("#os-dev-body").value || undefined);
      if (!live()) return; find("#os-dev-status").textContent = "Request completed"; find("#os-dev-response").textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      if (live()) { find("#os-dev-status").textContent = "Request failed"; find("#os-dev-response").textContent = JSON.stringify(error.details ?? { message: error.message }, null, 2); }
      throw error;
    }
  }); };
  root.addEventListener("input", () => dirty(true));
}
