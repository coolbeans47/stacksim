import { rest, secretsManager } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { setDirty } from "../state.js";
import { decorateSecretsManagerPanelHelp } from "./secrets-manager-help.js";

export const metadata = {
  key: "secrets-manager",
  name: "Secrets Manager",
  icon: "S",
  cls: "secrets",
  links: [["Secrets", "#/secrets-manager/secrets"], ["Create secret", "#/secrets-manager/secrets/create"]],
  search: ["secrets manager", "secret", "credentials", "password", "token"],
};

let context;
const detailHref = name => `#/secrets-manager/secrets/secret/${encodeURIComponent(name)}`;
const cloudFormationStackName = owner => String(owner ?? "").match(/:stack\/([^/]+)\//)?.[1];
const cloudFormationOwnerMarkup = owner => {
  const stackName = cloudFormationStackName(owner);
  return stackName ? ` <a class="badge" href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/resources">CloudFormation managed</a>` : "";
};
const tagsFromJson = value => Object.entries(JSON.parse(String(value || "{}"))).map(([Key, Value]) => ({ Key, Value: String(Value) }));

async function allSecrets(includeDeleted = true) {
  const values = [];
  let NextToken;
  do {
    const result = await secretsManager("ListSecrets", { MaxResults: 100, IncludePlannedDeletion: includeDeleted, ...(NextToken ? { NextToken } : {}) });
    values.push(...(result.SecretList ?? []));
    NextToken = result.NextToken;
  } while (NextToken);
  const ownership = await rest("/_stacksim/api/secrets-manager/secrets");
  const owners = new Map((ownership.secrets ?? []).map(secret => [secret.name, secret]));
  return values.map(secret => ({ ...secret, LocalOwnership: owners.get(secret.Name) }));
}
async function listPage() {
  context.setChrome("secrets-manager", ["Secrets Manager", "Secrets"]);
  const secrets = await allSecrets();
  const rows = secrets.map(secret => `<tr data-search-row="${escapeHtml(`${secret.Name} ${secret.Description ?? ""}`.toLowerCase())}"><td><a href="${detailHref(secret.Name)}">${escapeHtml(secret.Name)}</a>${secret.DeletedDate ? ' <span class="badge">Pending deletion</span>' : cloudFormationOwnerMarkup(secret.LocalOwnership?.cloudFormationOwner ?? secret.LocalOwnership?.resourcePolicyCloudFormationOwner)}</td><td>${escapeHtml(secret.Description || "–")}</td><td>${Object.keys(secret.SecretVersionsToStages ?? {}).length}</td><td>${formatDate(secret.LastChangedDate)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width">${pageHeader("Secrets", "Manage encrypted application secrets. Values are never fetched for this list.", '<a class="button primary" href="#/secrets-manager/secrets/create">Store a new secret</a>')}<div class="alert info"><strong>Local encryption boundary</strong><br>Secret values use installation-local AES-256-GCM protection, not KMS. Existing permitted non-VPC Lambda functions can rotate local secrets; hosted rotation, customer KMS, and replication remain unavailable.</div><div class="card"><div class="card-header"><h2>Secret catalog</h2></div><div class="toolbar"><div class="filter"><span>⌕</span><input data-filter-table placeholder="Find secrets" aria-label="Find secrets"></div><button class="button refresh" data-action="refresh" aria-label="Refresh">↻</button></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th>Versions</th><th>Last changed</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("S", "No secrets", "Store a secret string for an application.", '<a class="button primary" href="#/secrets-manager/secrets/create">Store a new secret</a>')}</div></div>`;
  context.bindTableFilter(context.main);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

async function createPage() {
  context.setChrome("secrets-manager", ["Secrets Manager", "Secrets", "Store a new secret"]);
  context.main.innerHTML = `<div class="page-width">${pageHeader("Store a new secret", "Create a locally encrypted secret with an optional initial value.")}<div class="card"><div class="card-header"><h2>Secret configuration</h2></div><div class="card-body"><form id="secret-create"><div class="field"><label>Name</label><input name="name" required placeholder="app/database/credentials"></div><div class="field"><label>Secret value</label><textarea name="value" autocomplete="off"></textarea><span class="hint">Leave empty to create metadata only. Binary secrets are supported by the SDK but are not entered through the console.</span></div><div class="field"><label>Description</label><textarea name="description"></textarea></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div><div class="actions"><a class="button" href="#/secrets-manager/secrets">Cancel</a><button class="button primary" type="submit">Store secret</button></div></form></div></div></div>`;
  document.querySelector("#secret-create").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name"));
    const value = String(data.get("value") ?? "");
    try {
      await secretsManager("CreateSecret", {
        Name: name,
        Description: String(data.get("description") || "") || undefined,
        Tags: tagsFromJson(data.get("tags")),
        ...(value ? { SecretString: value, ClientRequestToken: crypto.randomUUID() } : {}),
      });
      form.querySelector('[name="value"]').value = "";
      setDirty(false, "all");
      context.toast("Secret stored");
      location.hash = detailHref(name);
    } catch (error) { context.showError(error); }
  });
}

function tagObject(tags) {
  return Object.fromEntries((tags ?? []).map(tag => [tag.Key, tag.Value]));
}

async function detailPage(name) {
  const secret = await secretsManager("DescribeSecret", { SecretId: name });
  const [versions, policy, ownership] = await Promise.all([
    secret.DeletedDate ? Promise.resolve({ Versions: [] }) : secretsManager("ListSecretVersionIds", { SecretId: name, IncludeDeprecated: true, MaxResults: 100 }),
    secretsManager("GetResourcePolicy", { SecretId: name }),
    rest("/_stacksim/api/secrets-manager/secrets"),
  ]);
  const tags = tagObject(secret.Tags);
  const pendingDeletion = Boolean(secret.DeletedDate);
  const localOwner = ownership.secrets?.find(candidate => candidate.name === name);
  const cloudFormationOwner = localOwner?.cloudFormationOwner;
  const resourcePolicyCloudFormationOwner = localOwner?.resourcePolicyCloudFormationOwner;
  const rotation = localOwner?.rotation;
  const attachment = localOwner?.targetAttachment;
  const serviceManaged = localOwner?.owningService === "rds.amazonaws.com";
  const protectedResource = Boolean(cloudFormationOwner) || serviceManaged;
  const protectedPolicy = protectedResource || Boolean(resourcePolicyCloudFormationOwner);
  const stackName = cloudFormationStackName(cloudFormationOwner ?? resourcePolicyCloudFormationOwner);
  context.setChrome("secrets-manager", ["Secrets Manager", "Secrets", name]);
  const actions = protectedResource
    ? `<a class="button" href="#/secrets-manager/secrets">Back</a>${stackName ? `<a class="button" href="#/cloudformation/stacks/${encodeURIComponent(stackName)}/resources">View owning stack</a>` : ""}`
    : pendingDeletion
    ? '<a class="button" href="#/secrets-manager/secrets">Back</a><button class="button primary" data-action="restore">Restore secret</button><button class="button danger" data-action="force-delete">Delete immediately</button>'
    : '<a class="button" href="#/secrets-manager/secrets">Back</a><button class="button" data-action="edit">Edit secret</button><button class="button danger" data-action="schedule-delete">Schedule deletion</button>';
  const versionRows = (versions.Versions ?? []).map(version => `<tr><td class="mono">${escapeHtml(version.VersionId)}</td><td>${(version.VersionStages ?? []).map(stage => `<span class="badge">${escapeHtml(stage)}</span>`).join(" ") || "Deprecated"}</td><td>${formatDate(version.CreatedDate)}</td><td>${pendingDeletion || protectedResource ? "–" : `<button class="button" data-stage-version="${escapeHtml(version.VersionId)}">Manage stages</button>`}</td></tr>`).join("");
  const policyText = policy.ResourcePolicy ?? "";
  const rotationButtons = pendingDeletion || rotation?.cloudFormationOwner ? "" : `<button class="button primary" data-action="rotate">${rotation?.enabled ? "Rotate now" : "Configure rotation"}</button>${rotation?.enabled ? '<button class="button" data-action="cancel-rotation">Cancel rotation</button>' : ""}`;
  const targetLink = attachment?.targetType === "AWS::RDS::DBInstance" ? `<a href="#/rds/databases/${encodeURIComponent(attachment.targetId)}">${escapeHtml(attachment.targetId)}</a>` : "–";
  const rotationCard = pendingDeletion ? "" : `<div class="card"><div class="card-header"><h2>Rotation</h2><div class="actions">${rotationButtons}</div></div><div class="card-body detail-grid"><dl class="key-value"><dt>Status</dt><dd>${escapeHtml(rotation?.activeStep ? `Running ${rotation.activeStep}` : rotation?.lastStatus || (rotation?.enabled ? "Scheduled" : "Not configured"))}</dd><dt>Lambda</dt><dd class="mono">${escapeHtml(rotation?.lambdaArn || "–")}</dd><dt>Last rotated</dt><dd>${rotation?.lastRotatedAt ? formatDate(rotation.lastRotatedAt / 1_000) : "–"}</dd><dt>Next rotation</dt><dd>${rotation?.nextRotationAt ? formatDate(rotation.nextRotationAt / 1_000) : "–"}</dd></dl><dl class="key-value"><dt>Target attachment</dt><dd>${targetLink}</dd><dt>Target type</dt><dd>${escapeHtml(attachment?.targetType || "–")}</dd><dt>Last safe error</dt><dd>${escapeHtml(rotation?.lastErrorSummary || "–")}</dd></dl></div><p class="hint">Lambda events contain only the secret ID, step, and client token. Hosted transforms, VPC functions, arbitrary targets, and customer KMS are rejected.</p></div>`;
  context.main.innerHTML = `<div class="page-width">${pageHeader(name, serviceManaged ? "This secret is managed by the bounded local RDS integration." : protectedResource ? "This secret is managed by CloudFormation." : pendingDeletion ? `Scheduled for deletion ${formatDate(secret.DeletedDate)}.` : "Secret metadata and explicit value retrieval.", actions)}${protectedResource ? `<div class="alert info"><strong>Protected resource</strong><br>Direct metadata, value, tag, policy, recovery, and deletion mutations are disabled. ${serviceManaged ? "RDS owns this credential lifecycle." : "Update or delete the owning stack resource."}</div>` : pendingDeletion ? '<div class="alert warning"><strong>Pending deletion</strong><br>Value access and mutation are blocked until this secret is restored.</div>' : ""}<div class="card"><div class="card-header"><h2>Overview</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>ARN</dt><dd class="mono">${escapeHtml(secret.ARN)}</dd><dt>Description</dt><dd>${escapeHtml(secret.Description || "–")}</dd></dl><dl class="key-value"><dt>Created</dt><dd>${formatDate(secret.CreatedDate)}</dd><dt>Last changed</dt><dd>${formatDate(secret.LastChangedDate)}</dd></dl></div></div>${pendingDeletion ? "" : '<div class="card"><div class="card-header"><h2>Secret value</h2><button class="button primary" data-action="retrieve">Retrieve secret value</button></div><div class="card-body"><div id="secret-value" class="code-box" aria-live="polite">••••••••</div><div class="actions"><button class="button" data-action="copy" hidden>Copy</button><button class="button" data-action="clear" hidden>Clear</button></div><p class="hint">Retrieval is explicit. Revealed plaintext is kept only in this page memory and clears after 60 seconds or when you leave.</p></div></div>'}${rotationCard}<div class="card"><div class="card-header"><h2>Versions</h2></div>${versionRows ? `<div class="table-wrap"><table><thead><tr><th>Version ID</th><th>Stages</th><th>Created</th><th>Actions</th></tr></thead><tbody>${versionRows}</tbody></table></div>` : '<div class="card-body"><p class="muted">No readable versions.</p></div>'}</div><div class="card"><div class="card-header"><h2>Resource permissions</h2>${pendingDeletion || protectedPolicy ? "" : '<button class="button" data-action="policy-edit">Edit policy</button>'}${policyText && !pendingDeletion && !protectedPolicy ? '<button class="button danger" data-action="policy-delete">Delete policy</button>' : ""}</div><div class="card-body">${policyText ? `<pre class="code-box">${escapeHtml(policyText)}</pre>` : '<p class="muted">No resource policy. Identity policies still apply.</p>'}<p class="hint">${protectedPolicy ? "This resource policy is managed by CloudFormation. " : ""}Configured-account identity policies remain the ordinary application access path.</p></div></div><div class="card"><div class="card-header"><h2>Tags</h2>${pendingDeletion || protectedResource ? "" : '<button class="button" data-action="tags">Edit tags</button>'}</div><div class="card-body"><pre class="code-box">${escapeHtml(JSON.stringify(tags, null, 2))}</pre></div></div></div>`;

  document.querySelector('[data-action="rotate"]')?.addEventListener("click", () => context.showModal(rotation?.enabled ? "Rotate secret now" : "Configure secret rotation", `<div class="field"><label>Existing Lambda ARN</label><input name="lambdaArn" required value="${escapeHtml(rotation?.lambdaArn || "")}"></div><div class="field"><label>Schedule expression</label><input name="schedule" value="rate(30 days)"></div><div class="field"><label>Window duration</label><input name="duration" value="1h"></div>`, rotation?.enabled ? "Rotate now" : "Configure and rotate", async data => {
    await secretsManager("RotateSecret", { SecretId: name, RotationLambdaARN: String(data.get("lambdaArn")), RotationRules: { ScheduleExpression: String(data.get("schedule")), Duration: String(data.get("duration")) }, ClientRequestToken: crypto.randomUUID() });
    context.toast("Secret rotation admitted");
  }));
  document.querySelector('[data-action="cancel-rotation"]')?.addEventListener("click", async () => { try { await secretsManager("CancelRotateSecret", { SecretId: name }); context.toast("Secret rotation cancelled"); await context.route(); } catch (error) { context.showError(error); } });

  const versionById = new Map((versions.Versions ?? []).map(version => [version.VersionId, version]));
  const stageOwner = stage => (versions.Versions ?? []).find(version => (version.VersionStages ?? []).includes(stage))?.VersionId;
  document.querySelectorAll("[data-stage-version]").forEach(button => button.addEventListener("click", () => {
    const versionId = button.dataset.stageVersion;
    const current = versionById.get(versionId)?.VersionStages ?? [];
    context.showModal("Manage version stages", `<div class="field"><label>Stages (comma separated)</label><input name="stages" value="${escapeHtml(current.join(", "))}"><span class="hint">Moving AWSCURRENT also moves AWSPREVIOUS to the prior current version. A secret must keep exactly one AWSCURRENT.</span></div>`, "Save stages", async data => {
      const desired = [...new Set(String(data.get("stages") ?? "").split(",").map(stage => stage.trim()).filter(Boolean))];
      const additions = desired.filter(stage => !current.includes(stage));
      const removals = current.filter(stage => !desired.includes(stage));
      if (removals.includes("AWSCURRENT") && !additions.includes("AWSCURRENT")) throw new Error("Move AWSCURRENT to another version before removing it here.");
      for (const stage of additions) {
        const owner = stageOwner(stage);
        await secretsManager("UpdateSecretVersionStage", { SecretId: name, VersionStage: stage, MoveToVersionId: versionId, ...(owner && owner !== versionId ? { RemoveFromVersionId: owner } : {}) });
      }
      for (const stage of removals.filter(stage => stage !== "AWSCURRENT" && stageOwner(stage) === versionId)) await secretsManager("UpdateSecretVersionStage", { SecretId: name, VersionStage: stage, RemoveFromVersionId: versionId });
      context.toast("Version stages updated");
    });
  }));
  document.querySelector('[data-action="policy-edit"]')?.addEventListener("click", () => context.showModal("Edit resource policy", `<div class="field"><label>Resource policy JSON</label><textarea name="policy" rows="16">${escapeHtml(policyText || JSON.stringify({ Version: "2012-10-17", Statement: [] }, null, 2))}</textarea><span class="hint">Validation and public-policy blocking run before the policy is committed.</span></div>`, "Validate and save", async data => {
    const next = String(data.get("policy") ?? "");
    const validation = await secretsManager("ValidateResourcePolicy", { SecretId: name, ResourcePolicy: next });
    if (!validation.PolicyValidationPassed) throw new Error((validation.ValidationErrors ?? []).map(error => `${error.CheckName}: ${error.ErrorMessage}`).join("\n") || "The policy did not pass validation.");
    await secretsManager("PutResourcePolicy", { SecretId: name, ResourcePolicy: next, BlockPublicPolicy: true });
    context.toast("Resource policy updated");
  }));
  document.querySelector('[data-action="policy-delete"]')?.addEventListener("click", () => context.confirmDeletion("the resource policy", "This removes resource-based grants; identity policies are unchanged.", async () => {
    await secretsManager("DeleteResourcePolicy", { SecretId: name });
    context.toast("Resource policy deleted");
  }));

  let revealed = "";
  let clearTimer;
  const clearValue = () => {
    revealed = "";
    clearTimeout(clearTimer);
    const target = document.querySelector("#secret-value");
    if (target) target.textContent = "••••••••";
    document.querySelector('[data-action="copy"]')?.setAttribute("hidden", "");
    document.querySelector('[data-action="clear"]')?.setAttribute("hidden", "");
  };
  const leave = () => { clearValue(); window.removeEventListener("hashchange", leave); };
  window.addEventListener("hashchange", leave, { once: true });
  document.querySelector('[data-action="retrieve"]')?.addEventListener("click", async () => {
    clearValue();
    try {
      const result = await secretsManager("GetSecretValue", { SecretId: name });
      revealed = result.SecretString ?? `[binary secret: ${atob(result.SecretBinary ?? "").length} bytes]`;
      const target = document.querySelector("#secret-value");
      if (target) target.textContent = revealed;
      document.querySelector('[data-action="copy"]')?.removeAttribute("hidden");
      document.querySelector('[data-action="clear"]')?.removeAttribute("hidden");
      clearTimer = setTimeout(clearValue, 60_000);
    } catch (error) { clearValue(); context.showError(error); }
  });
  document.querySelector('[data-action="clear"]')?.addEventListener("click", clearValue);
  document.querySelector('[data-action="copy"]')?.addEventListener("click", async () => {
    if (!revealed) return;
    if (!confirm("Copying exports plaintext to the operating-system clipboard. Continue?")) return;
    const copied = revealed;
    await navigator.clipboard.writeText(copied);
    setTimeout(async () => {
      try { if (await navigator.clipboard.readText() === copied) await navigator.clipboard.writeText(""); } catch {}
    }, 30_000);
    context.toast("Secret value copied");
  });
  document.querySelector('[data-action="edit"]')?.addEventListener("click", () => context.showModal("Edit secret", `<div class="field"><label>Description</label><textarea name="description">${escapeHtml(secret.Description ?? "")}</textarea></div><div class="field"><label>New secret value</label><textarea name="value" autocomplete="off"></textarea><span class="hint">Leave empty to update metadata without creating a version.</span></div>`, "Save", async data => {
    const value = String(data.get("value") ?? "");
    await secretsManager("UpdateSecret", { SecretId: name, Description: String(data.get("description") ?? ""), ...(value ? { SecretString: value, ClientRequestToken: crypto.randomUUID() } : {}) });
    context.toast("Secret updated");
  }));
  document.querySelector('[data-action="tags"]')?.addEventListener("click", () => context.showModal("Edit tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags">${escapeHtml(JSON.stringify(tags, null, 2))}</textarea></div>`, "Save tags", async data => {
    const next = Object.fromEntries(tagsFromJson(data.get("tags")).map(tag => [tag.Key, tag.Value]));
    const removed = Object.keys(tags).filter(key => !Object.hasOwn(next, key));
    if (removed.length) await secretsManager("UntagResource", { SecretId: name, TagKeys: removed });
    const additions = Object.entries(next).filter(([key, value]) => tags[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (additions.length) await secretsManager("TagResource", { SecretId: name, Tags: additions });
    context.toast("Tags updated");
  }));
  document.querySelector('[data-action="schedule-delete"]')?.addEventListener("click", () => context.showModal("Schedule secret deletion", `<div class="alert warning">Value access will be blocked until restoration. The secret is permanently removed after the recovery window.</div><div class="field"><label>Recovery window (days)</label><input name="days" type="number" min="7" max="30" value="30"></div>`, "Schedule deletion", async data => {
    await secretsManager("DeleteSecret", { SecretId: name, RecoveryWindowInDays: Number(data.get("days")) });
    context.toast("Secret deletion scheduled");
  }));
  document.querySelector('[data-action="restore"]')?.addEventListener("click", async () => {
    await secretsManager("RestoreSecret", { SecretId: name });
    context.toast("Secret restored");
    await context.route();
  });
  document.querySelector('[data-action="force-delete"]')?.addEventListener("click", () => context.confirmDeletion(`permanently delete ${name}`, "This immediately destroys every version and cannot be undone.", async () => {
    await secretsManager("DeleteSecret", { SecretId: name, ForceDeleteWithoutRecovery: true });
    context.toast("Secret permanently deleted");
    location.hash = "#/secrets-manager/secrets";
  }));
}

export async function routeSecretsManager(parts, nextContext) {
  context = nextContext;
  const render = async pending => {
    const result = await pending;
    decorateSecretsManagerPanelHelp(context.main);
    return result;
  };
  if (parts.length === 2 && parts[0] === "secrets-manager" && parts[1] === "secrets") return render(listPage());
  if (parts.length === 3 && parts[2] === "create") return render(createPage());
  if (parts.length === 4 && parts[2] === "secret") return render(detailPage(parts[3]));
  return context.notFound(parts);
}
