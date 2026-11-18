import { s3Request } from "../api-client.js";
import { escapeHtml as esc, pageHeader } from "../components.js";
import { session, setDirty } from "../state.js";

const href = id => `#/opensearch/packages${id ? `/${encodeURIComponent(id)}` : ""}`;
const first = (node, name) => node?.getElementsByTagName(name)[0]?.textContent ?? "";
const time = value => value === undefined ? "—" : new Date(value * 1000).toLocaleString();
const sourceFields = `<div class="field"><label for="package-bucket">S3 bucket</label><input id="package-bucket" name="bucket" required list="package-buckets" maxlength="63"><datalist id="package-buckets"></datalist><button class="button" type="button" data-buckets>Find buckets</button></div><div class="field"><label for="package-key">S3 object key</label><input id="package-key" name="key" required list="package-objects" maxlength="1024"><datalist id="package-objects"></datalist><button class="button" type="button" data-objects>Find objects</button><span class="hint" role="status" data-source-status>Import a UTF-8 dictionary from a bucket in this account and Region. Maximum 64 KiB and 1,000 entries.</span></div>`;
const errorBox = '<div class="alert error" role="alert" hidden tabindex="-1"></div>';
const source = form => ({ S3BucketName: form.elements.bucket.value.trim(), S3Key: form.elements.key.value });

function bindForm(form, live, work) {
  const busy = async task => {
    const buttons = [...form.querySelectorAll("button")], disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => button.disabled = true); form.querySelector('[role="alert"]').hidden = true;
    try { await task(); } catch (error) { if (live()) { const box = form.querySelector('[role="alert"]'); box.textContent = error.message; box.hidden = false; box.focus(); } }
    finally { if (live()) buttons.forEach((button, i) => button.disabled = disabled[i]); }
  };
  form.oninput = () => setDirty(true);
  form.onsubmit = event => { event.preventDefault(); void busy(() => work(form)); };
  form.querySelector("[data-buckets]")?.addEventListener("click", () => busy(async () => {
    const result = await s3Request("/"); if (!live()) return;
    const buckets = [...result.xml.getElementsByTagName("Bucket")].filter(node => !first(node, "BucketRegion") || first(node, "BucketRegion") === session.region).map(node => first(node, "Name"));
    form.querySelector("#package-buckets").innerHTML = buckets.map(name => `<option value="${esc(name)}"></option>`).join("");
    form.querySelector("[data-source-status]").textContent = `${buckets.length} buckets available. Select or enter a bucket name.`; form.elements.bucket.focus();
  }));
  form.querySelector("[data-objects]")?.addEventListener("click", () => busy(async () => {
    const bucket = form.elements.bucket.value.trim(); if (!bucket) throw new Error("Enter a bucket first.");
    const result = await s3Request(`/${encodeURIComponent(bucket)}?list-type=2&max-keys=100`); if (!live()) return;
    const objects = [...result.xml.getElementsByTagName("Contents")].filter(node => Number(first(node, "Size")) > 0 && Number(first(node, "Size")) <= 65536).map(node => first(node, "Key"));
    form.querySelector("#package-objects").innerHTML = objects.map(key => `<option value="${esc(key)}"></option>`).join("");
    form.querySelector("[data-source-status]").textContent = `${objects.length} objects within the size limit from the first 100 keys. Select or enter the full key.`; form.elements.key.focus();
  }));
}

export async function renderPackages(parts, context, { api, show, chrome, live, refresh, later }) {
  const id = parts[2], importing = id === "import";
  chrome(["Packages", ...(id ? [importing ? "Import" : id] : [])]);
  if (importing) {
    show(`${pageHeader("Import dictionary package", "Add synonyms or stop words for custom analyzers.", `<a class="button" href="${href()}">Back to packages</a>`)}<form class="card" id="package-import"><div class="card-body">${errorBox}<div class="field"><label for="package-name">Package name</label><input id="package-name" name="name" required pattern="[a-z][a-z0-9-]{2,255}" maxlength="256"></div><div class="field"><label for="package-description">Description</label><input id="package-description" name="description" maxlength="1024"></div>${sourceFields}<div class="field"><label><input name="vending" type="checkbox"> Allow sharing with other accounts</label><span class="hint">Choose this now to manage the allowed accounts after import.</span></div><p>StackSim stores an encrypted copy. Importing a new version does not change domain associations until you apply it.</p><button class="button primary" type="submit">Import package</button></div></form>`);
    if (!live()) return;
    bindForm(context.main.querySelector("#package-import"), live, async form => {
      const result = await api("/packages", "POST", { PackageName: form.elements.name.value, PackageDescription: form.elements.description.value, PackageType: "TXT-DICTIONARY", PackageSource: source(form), PackageVendingOptions: { VendingEnabled: form.elements.vending.checked } });
      if (live()) { setDirty(false); context.toast("Package import started"); location.hash = href(result.PackageDetails.PackageID); }
    }); return;
  }
  const result = await api("/packages/describe", "POST", id ? { Filters: [{ Name: "PackageID", Value: [id] }] } : {}), packages = result.PackageDetailsList ?? [];
  if (!id) {
    show(`${pageHeader("Dictionary packages", "Import and version dictionaries used by managed search domains.", `<a class="button primary" href="${href("import")}">Import package</a><button class="button" data-refresh>Refresh</button>`)}<section class="card"><div class="card-header"><h2>Packages (${packages.length})</h2></div><div class="card-body">${packages.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Available version</th><th>Owner</th></tr></thead><tbody>${packages.map(pkg => `<tr><td><a href="${href(pkg.PackageID)}">${esc(pkg.PackageName)}</a></td><td>${esc(pkg.PackageStatus)}</td><td>${esc(pkg.AvailablePackageVersion ?? "—")}</td><td>${esc(pkg.PackageOwner)}</td></tr>`).join("")}</tbody></table></div>` : '<p>No dictionary packages.</p>'}<div class="actions"><button class="button" data-previous disabled>Previous packages</button><button class="button" data-next ${result.NextToken ? "" : "disabled"}>Next packages</button><span role="status" data-page>Page 1</span></div>${errorBox}<p class="hint">Data-only dictionaries support synonyms and stop words. Executable plugins and license packages are unavailable.</p></div></section>`);
    if (!live()) return; context.main.querySelector("[data-refresh]").onclick = refresh;
    let current = result, index = 0; const tokens = [undefined];
    const page = async direction => {
      const next = context.main.querySelector("[data-next]"), previous = context.main.querySelector("[data-previous]"), box = context.main.querySelector('[role="alert"]'); next.disabled = previous.disabled = true; box.hidden = true;
      try {
        const target = index + direction, token = direction > 0 ? current.NextToken : tokens[target];
        const result = await api("/packages/describe", "POST", token ? { NextToken: token } : {}); if (!live()) return;
        current = result; index = target; tokens[index] = token;
        context.main.querySelector("tbody").innerHTML = (result.PackageDetailsList ?? []).map(pkg => `<tr><td><a href="${href(pkg.PackageID)}">${esc(pkg.PackageName)}</a></td><td>${esc(pkg.PackageStatus)}</td><td>${esc(pkg.AvailablePackageVersion ?? "—")}</td><td>${esc(pkg.PackageOwner)}</td></tr>`).join("");
        context.main.querySelector("[data-page]").textContent = `Page ${index + 1}`;
      } catch (error) { if (live()) { box.textContent = error.message; box.hidden = false; box.focus(); } }
      finally { if (live()) { next.disabled = !current.NextToken; previous.disabled = index === 0; } }
    };
    context.main.querySelector("[data-next]").onclick = () => page(1); context.main.querySelector("[data-previous]").onclick = () => page(-1);
    if (packages.some(pkg => ["COPYING", "DELETING"].includes(pkg.PackageStatus))) later(); return;
  }
  const pkg = packages[0]; if (!pkg) { show(`${pageHeader("Package unavailable", "The package was removed or is no longer shared with this account.", `<a class="button" href="${href()}">Back to packages</a>`)}`); return; }
  const own = pkg.PackageOwner === (session.credentials?.active?.identity?.account ?? session.summary?.accountId), base = `/packages/${encodeURIComponent(id)}`;
  const [history, associations, domains] = await Promise.all([api(`${base}/history`), own ? api(`${base}/domains`) : { DomainPackageDetailsList: [] }, api("/domain")]);
  const rows = associations.DomainPackageDetailsList ?? [];
  show(`${pageHeader(pkg.PackageName, "Dictionary package", `<a class="button" href="${href()}">Back to packages</a><button class="button" data-refresh>Refresh</button>${own ? '<button class="button danger" data-delete>Delete package</button>' : ""}`)}
    <section class="card"><div class="card-header"><h2>Package details</h2><span role="status">${esc(pkg.PackageStatus)}</span></div><div class="card-body">${pkg.ErrorDetails ? `<div class="alert error">${esc(pkg.ErrorDetails.ErrorMessage)}</div>` : ""}<dl class="detail-grid key-value"><div><dt>Package ID</dt><dd class="osis-endpoint mono">${esc(id)}</dd></div><div><dt>Available version</dt><dd>${esc(pkg.AvailablePackageVersion ?? "Pending")}</dd></div><div><dt>Analyzer reference</dt><dd class="osis-endpoint mono">analyzers/${esc(id)}</dd></div><div><dt>Owner</dt><dd>${esc(pkg.PackageOwner)}</dd></div></dl><p>${esc(pkg.PackageDescription ?? "No description")}</p><p>Use the reference as <code>synonyms_path</code> or <code>stopwords_path</code> in index analysis settings. Index analyzers stay pinned to the version present when the index is created. Search filters with <code>updateable: true</code> refresh when you apply a new association.</p><p class="hint">Refresh this page to follow pending operations. Dictionary contents are not displayed.</p></div></section>
    <section class="card"><div class="card-header"><h2>Domain associations</h2></div><div class="card-body">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th>Version</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td><a href="#/opensearch/domains/${encodeURIComponent(row.DomainName)}">${esc(row.DomainName)}</a></td><td>${esc(row.DomainPackageStatus)}${row.ErrorDetails ? `<p class="alert error">${esc(row.ErrorDetails.ErrorMessage)}</p>` : ""}</td><td>${esc(row.PackageVersion)}</td><td><button class="button" data-remove="${esc(row.DomainName)}" ${["ASSOCIATING", "DISSOCIATING"].includes(row.DomainPackageStatus) ? "disabled" : ""}>Dissociate</button></td></tr>`).join("")}</tbody></table></div>` : `<p>${own ? "No associated domains in this account." : "View each domain’s packages to inspect shared associations."}</p>`}<form id="package-associate">${errorBox}<div class="field"><label for="package-domain">Domain</label><select id="package-domain" name="domain" required><option value="">Choose a domain</option>${(domains.DomainNames ?? []).map(domain => `<option value="${esc(domain.DomainName)}">${esc(domain.DomainName)}</option>`).join("")}</select></div><button class="button primary" type="submit" ${pkg.PackageStatus !== "AVAILABLE" ? "disabled" : ""}>Apply available version</button><p class="hint">Applies the available version to a new or existing association. Indexes referencing the package must be removed before dissociation.</p></form></div></section>
    <section class="card"><div class="card-header"><h2>Version history</h2></div><div class="card-body">${history.PackageVersionHistoryList?.length ? `<div class="table-wrap"><table><thead><tr><th>Version</th><th>Imported</th><th>Commit message</th></tr></thead><tbody>${history.PackageVersionHistoryList.map(version => `<tr><td>${esc(version.PackageVersion)}</td><td>${esc(time(version.CreatedAt))}</td><td>${esc(version.CommitMessage ?? "—")}</td></tr>`).join("")}</tbody></table></div>` : '<p>No published versions yet.</p>'}</div></section>
    ${own ? `<form class="card" id="package-update"><div class="card-header"><h2>Import a new version</h2></div><div class="card-body">${errorBox}${sourceFields}<div class="field"><label for="package-commit">Commit message</label><input id="package-commit" name="commit" maxlength="160"></div><button class="button primary" type="submit" ${pkg.PackageStatus !== "AVAILABLE" ? "disabled" : ""}>Import new version</button></div></form>` : ""}
    ${own && pkg.PackageVendingOptions?.VendingEnabled ? `<form class="card" id="package-scope"><div class="card-header"><h2>Sharing</h2></div><div class="card-body">${errorBox}<div class="field"><label for="package-users">Allowed accounts</label><textarea id="package-users" name="users" rows="3" placeholder="One 12-digit account ID per line">${esc((pkg.AllowListedUserList ?? []).join("\n"))}</textarea><span class="hint">Use GLOBAL to share with all accounts. Removing access prevents new associations; existing domain copies remain usable.</span></div><button class="button" type="submit">Save sharing</button></div></form>` : ""}`);
  if (!live()) return;
  context.main.querySelector("[data-refresh]").onclick = refresh;
  bindForm(context.main.querySelector("#package-associate"), live, async form => { await api(`/packages/associate/${encodeURIComponent(id)}/${encodeURIComponent(form.elements.domain.value)}`, "POST", {}); if (live()) { setDirty(false); context.toast("Association started"); refresh(); } });
  for (const button of context.main.querySelectorAll("[data-remove]")) button.onclick = () => context.confirmDeletion(button.dataset.remove, "Remove this package association. Indexes that still use the dictionary prevent removal.", async () => { await api(`/packages/dissociate/${encodeURIComponent(id)}/${encodeURIComponent(button.dataset.remove)}`, "POST", {}); if (live()) { setDirty(false); refresh(); } });
  context.main.querySelector("[data-delete]")?.addEventListener("click", () => context.confirmDeletion(pkg.PackageName, "Permanently delete this package and its retained versions. Remove all domain associations first.", async () => { await api(base, "DELETE"); if (live()) { setDirty(false); location.hash = href(); } }));
  const update = context.main.querySelector("#package-update"); if (update) bindForm(update, live, async form => { await api("/packages/update", "POST", { PackageID: id, PackageSource: source(form), CommitMessage: form.elements.commit.value }); if (live()) { setDirty(false); context.toast("Version import started"); refresh(); } });
  const scope = context.main.querySelector("#package-scope"); if (scope) bindForm(scope, live, async form => { const users = form.elements.users.value.split(/[\s,]+/).filter(Boolean); if (users.length > 100 || users.some(value => !/^(?:\d{12}|GLOBAL)$/.test(value))) throw new Error("Enter at most 100 account IDs (12 digits each) or GLOBAL."); await api("/packages/updateScope", "POST", { PackageID: id, Operation: "OVERRIDE", PackageUserList: users }); if (live()) { setDirty(false); context.toast("Package sharing saved"); } });
}

export async function renderDomainPackages(domain, context, { api, show, chrome, live, refresh }) {
  const name = domain.DomainName, result = await api(`/domain/${encodeURIComponent(name)}/packages`), rows = result.DomainPackageDetailsList ?? [];
  chrome(["Domains", name, "Packages"]);
  show(`${pageHeader("Domain packages", name, `<a class="button" href="#/opensearch/domains/${encodeURIComponent(name)}">Back to domain</a><a class="button primary" href="${href()}">Manage packages</a><button class="button" data-refresh>Refresh</button>`)}<section class="card"><div class="card-body">${rows.length ? rows.map(row => `<article class="os-ingest-row"><div><h2><a href="${href(row.PackageID)}">${esc(row.PackageName)}</a></h2><p>${esc(row.DomainPackageStatus)} · Version ${esc(row.PackageVersion)}</p><p class="osis-endpoint mono">${esc(row.ReferencePath)}</p>${row.ErrorDetails ? `<p class="alert error">${esc(row.ErrorDetails.ErrorMessage)}</p>` : ""}</div><button class="button" data-remove="${esc(row.PackageID)}" ${["ASSOCIATING", "DISSOCIATING"].includes(row.DomainPackageStatus) ? "disabled" : ""}>Dissociate</button></article>`).join("") : '<p>No associated packages.</p>'}</div></section>`);
  if (!live()) return; context.main.querySelector("[data-refresh]").onclick = refresh;
  for (const button of context.main.querySelectorAll("[data-remove]")) button.onclick = () => context.confirmDeletion(rows.find(row => row.PackageID === button.dataset.remove).PackageName, "Remove the domain copy. Indexes referencing the dictionary prevent removal.", async () => { await api(`/packages/dissociate/${encodeURIComponent(button.dataset.remove)}/${encodeURIComponent(name)}`, "POST", {}); if (live()) refresh(); });
}
