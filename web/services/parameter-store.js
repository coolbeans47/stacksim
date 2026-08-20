import { rest, ssm } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { setDirty } from "../state.js";
import { decorateParameterStorePanelHelp } from "./parameter-store-help.js";

export const metadata = {
  key: "systems-manager",
  name: "Systems Manager",
  icon: "P",
  cls: "ssm",
  links: [["Parameter Store", "#/systems-manager/parameter-store"], ["Create parameter", "#/systems-manager/parameter-store/create"]],
  search: ["systems manager", "ssm", "parameter", "parameter store", "securestring", "configuration"],
};

let context;
const detailsHref = name => `#/systems-manager/parameter-store/parameter/${encodeURIComponent(name)}`;
const tierSizeGuidance = "Value limits use UTF-8 bytes: Standard 4 KiB (4,096 bytes); Advanced 8 KiB (8,192 bytes). Upgrading from Standard to Advanced is irreversible; Advanced parameters cannot be downgraded.";
const cloudFormationStackName = owner => String(owner ?? "").match(/:stack\/([^/]+)\//)?.[1];
const cloudFormationOwnerMarkup = owner => {
  const stackName = cloudFormationStackName(owner);
  return stackName ? ` <a class="badge" href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/resources">CloudFormation managed</a>` : "";
};
const tagsFromJson = value => Object.entries(JSON.parse(String(value || "{}"))).map(([Key, Value]) => ({ Key, Value: String(Value) }));

async function allParameters() {
  const values = [];
  let NextToken;
  do {
    const result = await ssm("DescribeParameters", { MaxResults: 50, ...(NextToken ? { NextToken } : {}) });
    values.push(...(result.Parameters ?? []));
    NextToken = result.NextToken;
  } while (NextToken);
  const ownership = await rest("/_stacksim/api/ssm/parameters");
  const owners = new Map((ownership.parameters ?? []).map(parameter => [parameter.name, parameter]));
  return values.map(parameter => ({ ...parameter, Owner: owners.get(parameter.Name)?.owner, CloudFormationOwner: owners.get(parameter.Name)?.cloudFormationOwner }));
}

async function parameterHistory(name) {
  const values = [];
  let NextToken;
  do {
    const revealToken = NextToken;
    const result = await ssm("GetParameterHistory", { Name: name, WithDecryption: false, MaxResults: 1, ...(NextToken ? { NextToken } : {}) });
    for (const entry of result.Parameters ?? []) {
      entry.Value = "";
      values.push({ ...entry, RevealToken: revealToken });
    }
    NextToken = result.NextToken;
  } while (NextToken);
  return values;
}

async function listPage() {
  context.setChrome("systems-manager", ["Systems Manager", "Parameter Store"]);
  const parameters = await allParameters();
  const rows = parameters.map(parameter => `<tr data-search-row="${escapeHtml(`${parameter.Name} ${parameter.Type} ${parameter.Description ?? ""}`.toLowerCase())}"><td><a href="${detailsHref(parameter.Name)}">${escapeHtml(parameter.Name)}</a>${parameter.Owner === "stacksim:cdk-bootstrap" ? ' <span class="badge">Simulator managed</span>' : cloudFormationOwnerMarkup(parameter.CloudFormationOwner)}</td><td>${escapeHtml(parameter.Type)}</td><td>${escapeHtml(parameter.Tier ?? "Standard")}</td><td>${parameter.Version}</td><td>${formatDate(parameter.LastModifiedDate)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader("Parameter Store", "Store application configuration by name or hierarchy. Values are omitted from this list.", '<a class="button primary" href="#/systems-manager/parameter-store/create">Create parameter</a>')}<div class="alert info"><strong>Local encryption boundary</strong><br>SecureString uses installation-local AES-256-GCM protection, not KMS. Explicit KMS key identifiers are unavailable.</div><div class="card"><div class="card-header"><h2>Parameters</h2></div><div class="toolbar"><div class="filter"><span>⌕</span><input data-filter-table placeholder="Find parameters" aria-label="Find parameters"></div><button class="button refresh" data-action="refresh" aria-label="Refresh">↻</button></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Tier</th><th>Version</th><th>Last modified</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("P", "No parameters", "Create a String, StringList, or SecureString parameter.", '<a class="button primary" href="#/systems-manager/parameter-store/create">Create parameter</a>')}</div></div>`;
  context.bindTableFilter(context.main);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

async function createPage() {
  context.setChrome("systems-manager", ["Systems Manager", "Parameter Store", "Create parameter"]);
  context.main.innerHTML = `<div class="page-width">${pageHeader("Create parameter", "Create one Standard- or Advanced-tier parameter in the selected account and Region.")}<div class="card"><div class="card-header"><h2>Parameter configuration</h2></div><div class="card-body"><form id="parameter-create"><div class="field"><label>Name</label><input name="name" required placeholder="/app/dev/database/host"></div><div class="field-row"><div class="field"><label>Type</label><select name="type"><option>String</option><option>StringList</option><option>SecureString</option></select></div><div class="field"><label>Tier</label><select name="tier"><option>Standard</option><option>Advanced</option></select></div><div class="field"><label>Data type</label><input value="text" disabled></div></div><div class="alert info parameter-tier-guidance"><strong>Tier size and upgrade boundary</strong><br>${tierSizeGuidance}</div><div class="field"><label>Value</label><textarea name="value" required autocomplete="off"></textarea><span class="hint">Secure values remain in memory only until the signed PutParameter request completes.</span></div><div class="field"><label>Description</label><textarea name="description"></textarea></div><div class="field"><label>Allowed pattern</label><input name="allowedPattern" placeholder="Optional regular expression"></div><div class="field"><label>Policies (JSON array)</label><textarea name="policies">[]</textarea><span class="hint">Advanced parameters support Expiration, ExpirationNotification, and NoChangeNotification policies. The next persisted due instant runs on the simulator clock; overdue work is recovered on startup.</span></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><div class="actions"><a class="button" href="#/systems-manager/parameter-store">Cancel</a><button class="button primary" type="submit">Create parameter</button></div></form></div></div></div>`;
  document.querySelector("#parameter-create").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name"));
    const value = String(data.get("value"));
    try {
      await ssm("PutParameter", {
        Name: name,
        Type: String(data.get("type")),
        Tier: String(data.get("tier")),
        Value: value,
        Description: String(data.get("description") || "") || undefined,
        AllowedPattern: String(data.get("allowedPattern") || "") || undefined,
        Policies: String(data.get("policies") || "[]"),
        Tags: tagsFromJson(data.get("tags")),
      });
      form.querySelector('[name="value"]').value = "";
      setDirty(false, "all");
      context.toast("Parameter created");
      location.hash = detailsHref(name);
    } catch (error) { context.showError(error); }
  });
}

async function detailPage(name) {
  const described = (await ssm("DescribeParameters", { ParameterFilters: [{ Key: "Name", Option: "Equals", Values: [name] }] })).Parameters?.[0];
  if (!described) throw new Error(`Parameter ${name} does not exist`);
  const [tagResult, ownership] = await Promise.all([
    ssm("ListTagsForResource", { ResourceType: "Parameter", ResourceId: name }),
    rest("/_stacksim/api/ssm/parameters"),
  ]);
  const tagObject = Object.fromEntries((tagResult.TagList ?? []).map(tag => [tag.Key, tag.Value]));
  const owner = ownership.parameters?.find(parameter => parameter.name === name);
  const protectedResource = owner?.owner === "stacksim:cdk-bootstrap" || Boolean(owner?.cloudFormationOwner);
  const stackName = cloudFormationStackName(owner?.cloudFormationOwner);
  const localPolicies = owner?.policies ?? [];
  const parameterArn = described.ARN ?? owner?.arn;
  const eventPattern = {
    source: ["aws.ssm"],
    "detail-type": ["Parameter Store Change", "Parameter Store Policy Action"],
    ...(parameterArn ? { resources: [parameterArn] } : {}),
  };
  const policyRows = (described.Policies ?? []).map((policy, index) => {
    const local = localPolicies[index] ?? localPolicies.find(candidate => candidate.type === policy.PolicyType);
    return `<tr><td>${escapeHtml(policy.PolicyType)}</td><td>${escapeHtml(local?.status ?? policy.PolicyStatus ?? "PENDING")}</td><td>${formatDate(local?.dueAt)}</td><td><pre class="code-box">${escapeHtml(policy.PolicyText)}</pre></td></tr>`;
  }).join("");
  context.setChrome("systems-manager", ["Systems Manager", "Parameter Store", name]);
  context.main.innerHTML = `<div class="page-width">${pageHeader(name, protectedResource ? (stackName ? "This parameter is managed by CloudFormation." : "This parameter is simulator-managed for the reduced CDK bootstrap.") : "Parameter details and explicit value access.", `<a class="button" href="#/systems-manager/parameter-store">Back</a>${stackName ? `<a class="button" href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/resources">View owning stack</a>` : ""}${protectedResource ? "" : '<button class="button" data-action="edit">Edit value</button><button class="button danger" data-action="delete">Delete</button>'}`)}${protectedResource ? '<div class="alert info"><strong>Protected resource</strong><br>Public overwrite, label/tag mutation, and deletion are disabled.</div>' : ""}<div class="card"><div class="card-header"><h2>Overview</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Type</dt><dd>${escapeHtml(described.Type)}</dd><dt>Tier</dt><dd>${escapeHtml(described.Tier)}</dd></dl><dl class="key-value"><dt>Version</dt><dd>${described.Version}</dd><dt>Data type</dt><dd>${escapeHtml(described.DataType)}</dd></dl><dl class="key-value"><dt>Last modified</dt><dd>${formatDate(described.LastModifiedDate)}</dd><dt>Description</dt><dd>${escapeHtml(described.Description || "–")}</dd></dl></div></div><div class="card"><div class="card-header"><h2>Value</h2><button class="button" data-action="reveal">${described.Type === "SecureString" ? "Decrypt and reveal" : "Reveal value"}</button></div><div class="card-body"><div id="parameter-value" class="code-box" aria-live="polite">••••••••</div><p class="hint">The console fetches a value only after this explicit action and clears it when you leave or refresh the page.</p></div></div><div class="card"><div class="card-header"><h2>Policies</h2><a href="#/eventbridge/event-buses/default/rules">View policy event rules</a></div><div class="card-body"><div class="alert info parameter-policy-timing"><strong>Deterministic local policy scan timing</strong><br>The policy scan schedules the next persisted due instant on the simulator clock. Overdue work runs once on startup, and completed occurrences are not repeated after restart.</div>${policyRows ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Status</th><th>Due</th><th>Policy</th></tr></thead><tbody>${policyRows}</tbody></table></div>` : '<p class="muted">No parameter policies are configured.</p>'}</div></div><div class="card parameter-eventbridge-events"><div class="card-header"><h2>EventBridge events</h2><span class="status">Active</span></div><div class="card-body"><p>Parameter changes and policy actions publish value-free service events to the default event bus.</p><dl class="key-value"><dt>Source</dt><dd class="mono">aws.ssm</dd><dt>Detail types</dt><dd>Parameter Store Change<br>Parameter Store Policy Action</dd><dt>Event bus</dt><dd><a href="#/eventbridge/event-buses/default/rules">default</a></dd></dl><div class="field"><span class="field-label">Redacted rule event pattern</span><pre class="code-box">${escapeHtml(JSON.stringify(eventPattern, null, 2))}</pre></div><div class="actions"><a href="#/eventbridge/event-buses/default/rules">View rules on the default event bus</a><a href="#/eventbridge/event-buses/default/monitoring">View payload-redacted monitoring</a></div><p class="muted">These fixed console links and this rule pattern contain no parameter value, SecureString plaintext, ciphertext, or event payload. Event details contain only documented safe metadata.</p></div></div><div class="card"><div class="card-header"><h2>History and labels</h2><button class="button" data-action="history">Inspect history</button></div><div class="card-body" id="parameter-history"><p class="muted">History is fetched only after this explicit action. Version values remain masked until separately revealed.</p></div></div><div class="card"><div class="card-header"><h2>Tags</h2>${protectedResource ? "" : '<button class="button" data-action="tags">Edit tags</button>'}</div><div class="card-body"><pre class="code-box">${escapeHtml(JSON.stringify(tagObject, null, 2))}</pre></div></div></div>`;
  let historyMetadata = [];
  let historyClearTimer;
  const clearHistoryValue = () => {
    clearTimeout(historyClearTimer);
    const target = document.querySelector("#parameter-history-value");
    if (target) target.textContent = "••••••••";
  };
  const leave = () => { clearHistoryValue(); window.removeEventListener("hashchange", leave); };
  window.addEventListener("hashchange", leave, { once: true });
  document.querySelector('[data-action="history"]').addEventListener("click", async () => {
    try {
      const history = await parameterHistory(name);
      historyMetadata = history.map(entry => ({ Version: entry.Version, Labels: entry.Labels ?? [], LastModifiedDate: entry.LastModifiedDate, RevealToken: entry.RevealToken }));
      const rows = historyMetadata.map(entry => `<tr><td>${entry.Version}</td><td>${entry.Labels.map(label => `<span class="badge">${escapeHtml(label)}</span>`).join(" ") || "–"}</td><td>${formatDate(entry.LastModifiedDate)}</td><td><button class="button" data-history-reveal="${entry.Version}">Reveal</button>${protectedResource ? "" : ` <button class="button" data-history-labels="${entry.Version}">Manage labels</button>`}</td></tr>`).join("");
      const target = document.querySelector("#parameter-history");
      target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Version</th><th>Labels</th><th>Modified</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div><div id="parameter-history-value" class="code-box" aria-live="polite">••••••••</div><p class="hint">A historical value is retrieved through GetParameterHistory only after Reveal and clears after 60 seconds or navigation.</p>`;
      target.querySelectorAll("[data-history-reveal]").forEach(button => button.addEventListener("click", async () => {
        clearHistoryValue();
        const version = Number(button.dataset.historyReveal);
        try {
          const metadata = historyMetadata.find(entry => entry.Version === version);
          const revealedHistory = await ssm("GetParameterHistory", { Name: name, WithDecryption: described.Type === "SecureString", MaxResults: 1, ...(metadata?.RevealToken ? { NextToken: metadata.RevealToken } : {}) });
          const selected = revealedHistory.Parameters?.[0];
          const valueTarget = document.querySelector("#parameter-history-value");
          if (valueTarget) valueTarget.textContent = selected?.Value ?? "";
          for (const entry of revealedHistory.Parameters ?? []) entry.Value = "";
          historyClearTimer = setTimeout(clearHistoryValue, 60_000);
        } catch (error) { clearHistoryValue(); context.showError(error); }
      }));
      target.querySelectorAll("[data-history-labels]").forEach(button => button.addEventListener("click", () => {
        const version = Number(button.dataset.historyLabels);
        const current = historyMetadata.find(entry => entry.Version === version)?.Labels ?? [];
        context.showModal("Manage parameter labels", `<div class="field"><label>Labels (comma separated)</label><input name="labels" value="${escapeHtml(current.join(", "))}"><span class="hint">Adding an existing label moves it atomically from its previous version.</span></div>`, "Save labels", async data => {
          const desired = [...new Set(String(data.get("labels") ?? "").split(",").map(label => label.trim()).filter(Boolean))];
          const removed = current.filter(label => !desired.includes(label));
          const added = desired.filter(label => !current.includes(label));
          if (removed.length) await ssm("UnlabelParameterVersion", { Name: name, ParameterVersion: version, Labels: removed });
          if (added.length) await ssm("LabelParameterVersion", { Name: name, ParameterVersion: version, Labels: added });
          context.toast("Parameter labels updated");
        });
      }));
    } catch (error) { context.showError(error); }
  });
  document.querySelector('[data-action="reveal"]').addEventListener("click", async event => {
    const button = event.currentTarget;
    try {
      const result = await ssm("GetParameter", { Name: name, WithDecryption: described.Type === "SecureString" });
      const target = document.querySelector("#parameter-value");
      if (target) target.textContent = result.Parameter?.Value ?? "";
      if (button?.isConnected) button.textContent = "Refresh revealed value";
    } catch (error) {
      context.showError(error);
    }
  });
  const policiesJson = JSON.stringify((described.Policies ?? []).map(policy => JSON.parse(policy.PolicyText)), null, 2);
  document.querySelector('[data-action="edit"]')?.addEventListener("click", () => context.showModal("Edit parameter value", `<div class="field"><label>New value</label><textarea name="value" required autocomplete="off"></textarea></div><div class="field"><label>Tier</label><select name="tier"><option${described.Tier === "Advanced" ? " disabled" : ""}>Standard</option><option${described.Tier === "Advanced" ? " selected" : ""}>Advanced</option></select></div><div class="alert info parameter-tier-guidance"><strong>Tier size and upgrade boundary</strong><br>${tierSizeGuidance}</div><div class="field"><label>Description</label><textarea name="description">${escapeHtml(described.Description ?? "")}</textarea></div><div class="field"><label>Allowed pattern</label><input name="allowedPattern" value="${escapeHtml(described.AllowedPattern ?? "")}"></div><div class="field"><label>Policies (JSON array)</label><textarea name="policies">${escapeHtml(policiesJson)}</textarea><span class="hint">Policy due times use the simulator clock and persist across restart.</span></div>`, "Save new version", async data => {
    const value = String(data.get("value"));
    await ssm("PutParameter", { Name: name, Type: described.Type, Tier: String(data.get("tier")), Policies: String(data.get("policies") || "[]"), Value: value, Overwrite: true, Description: String(data.get("description") || ""), AllowedPattern: String(data.get("allowedPattern") || "") || undefined });
    context.toast("Parameter updated");
  }));
  document.querySelector('[data-action="tags"]')?.addEventListener("click", () => context.showModal("Edit tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(tagObject, null, 2))}</textarea></div>`, "Save tags", async data => {
    const next = Object.fromEntries(tagsFromJson(data.get("tags")).map(tag => [tag.Key, tag.Value]));
    const removed = Object.keys(tagObject).filter(key => !Object.hasOwn(next, key));
    if (removed.length) await ssm("RemoveTagsFromResource", { ResourceType: "Parameter", ResourceId: name, TagKeys: removed });
    const additions = Object.entries(next).filter(([key, value]) => tagObject[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (additions.length) await ssm("AddTagsToResource", { ResourceType: "Parameter", ResourceId: name, Tags: additions });
    context.toast("Tags updated");
  }));
  document.querySelector('[data-action="delete"]')?.addEventListener("click", () => context.confirmDeletion(name, "Deletion starts a 30-second same-name recreation delay.", async () => {
    await ssm("DeleteParameter", { Name: name });
    context.toast("Parameter deleted");
    location.hash = "#/systems-manager/parameter-store";
  }));
}

export async function routeParameterStore(parts, nextContext) {
  context = nextContext;
  const render = async pending => {
    const result = await pending;
    decorateParameterStorePanelHelp(context.main);
    return result;
  };
  if (parts.length === 2 && parts[0] === "systems-manager" && parts[1] === "parameter-store") return render(listPage());
  if (parts.length === 3 && parts[2] === "create") return render(createPage());
  if (parts.length === 4 && parts[2] === "parameter") return render(detailPage(parts[3]));
  return context.notFound(parts);
}
