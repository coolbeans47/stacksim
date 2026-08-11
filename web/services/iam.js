import { rest } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { openGuidedRoleCreator } from "../iam-guided-role.js";
import { session as ui } from "../state.js";
import { decorateIamPanelHelp } from "./iam-help.js";

export const metadata = { key: "iam", name: "IAM", icon: "◆", cls: "iam", links: [["Dashboard", "#/iam"], ["User groups", "#/iam/groups"], ["Users", "#/iam/users"], ["Roles", "#/iam/roles"], ["Policies", "#/iam/policies"], ["Authorization decisions", "#/iam/decisions"]], search: ["iam", "identity", "user", "group", "role", "policy", "authorization", "permissions"] };

export async function routeIam(parts, context) {
  const render = async pending => { const result = await pending; decorateIamPanelHelp(context.main); return result; };
  if (!parts[1] && parts.length === 1) return render(iamDashboard(context));
  if (parts[1] === "roles" && !parts[2] && parts.length === 2) return render(iamRoles(context));
  if (parts[1] === "roles" && parts[2] && parts.length <= 4 && new Set([undefined, "permissions", "trust", "tags", "access-advisor"]).has(parts[3])) {
    return render(iamRoles(context, parts[2], parts[3]));
  }
  if (parts[1] === "policies" && !parts[2] && parts.length === 2) return render(iamPolicies(context));
  if (parts[1] === "policies" && parts[2] && parts.length <= 4 && new Set([undefined, "permissions", "entities", "versions", "tags"]).has(parts[3])) {
    return render(iamPolicies(context, parts[2], parts[3]));
  }
  if (parts[1] === "decisions" && parts.length === 2) return render(authorizationDecisions(context));
  if (parts[1] === "users" && parts.length <= 3) return render(iamUsers(context, parts[2]));
  if (parts[1] === "groups" && parts.length <= 3) return render(iamGroups(context, parts[2]));
  return context.notFound(parts);
}

function detailNavigation(label, baseHref, items, active) {
  return `<nav class="tabs" aria-label="${escapeHtml(label)}">${items.map(([id, text]) => `<a class="tab ${active === id ? "active" : ""}" href="${baseHref}/${id}" ${active === id ? 'aria-current="page"' : ""}>${escapeHtml(text)}</a>`).join("")}</nav>`;
}

function detailPanel(id, label, content) {
  return `<section id="${escapeHtml(id)}" aria-label="${escapeHtml(label)}">${content}</section>`;
}

function tagsPanel(tags, resourceLabel) {
  const entries = Object.entries(tags ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return `<div class="card">${emptyState("◇", "No tags", `There are no tags associated with this ${resourceLabel}.`)}</div>`;
  return `<div class="card"><div class="card-header"><h2>Tags <span class="muted">(${entries.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${entries.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div></div>`;
}

function dashboardCard(name, label, count, text, href) {
  return `<section class="card service-card iam"><div class="card-header"><h2>${name}</h2><span class="service-icon iam">◆</span></div><div class="card-body"><div>${text}</div><div class="metric">${count}</div><div class="metric-label">${label}</div></div><footer><a href="${href}">View ${label.toLowerCase()} →</a></footer></section>`;
}

async function iamDashboard(context) {
  const { main, setChrome } = context;
  setChrome("iam", ["IAM", "Dashboard"]);
  const [users, groups, roles, policies] = await Promise.all([
    rest("/_stacksim/api/iam/users"),
    rest("/_stacksim/api/iam/groups"),
    rest("/_stacksim/api/iam/roles"),
    rest("/_stacksim/api/iam/policies"),
  ]);
  main.innerHTML = `<div class="page-width">${pageHeader("Identity and Access Management (IAM)", "Securely control access to services and resources in this local account.")}<div class="alert info"><strong>Local authorization</strong><br>Authentication mode is ${escapeHtml(ui.environment?.authMode ?? "enforce")}. Users, groups, and role sessions use the same policy evaluator.</div><div class="dashboard-grid">${dashboardCard("Users", "Users", users.users.length, "Manage long-lived identities and access keys.", "#/iam/users")}${dashboardCard("User groups", "Groups", groups.groups.length, "Share permission policies across users.", "#/iam/groups")}${dashboardCard("Roles", "Roles", roles.roles.length, "Create identities that services and SDK sessions can assume.", "#/iam/roles")}${dashboardCard("Policies", "Policies", policies.policies.length, "Define reusable permissions and attach them to identities.", "#/iam/policies")}</div></div>`;
}

async function iamUsers(context, name) {
  const { bindTableFilter, confirmDeletion, main, route, setChrome, showModal, toast } = context;
  if (!name) {
    setChrome("iam", ["IAM", "Users"]);
    const users = (await rest("/_stacksim/api/iam/users")).users ?? [];
    main.innerHTML = `<div class="page-width">${pageHeader("Users", "IAM users own durable access keys and receive policies directly or through groups.", '<button class="button primary" data-action="create-user">Create user</button>')}<div class="card"><div class="card-header"><h2>Users <span class="muted">(${users.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find users"></label></div><div class="table-wrap">${users.length ? `<table><thead><tr><th>User name</th><th>ARN</th><th>Created</th></tr></thead><tbody>${users.map(user => `<tr data-search-row="${escapeHtml(user.userName.toLowerCase())}"><td><a href="#/iam/users/${encodeURIComponent(user.userName)}">${escapeHtml(user.userName)}</a></td><td class="mono">${escapeHtml(user.arn)}</td><td>${formatDate(user.createDate)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No users", "Create an IAM user to manage long-lived credentials.")}</div></div></div>`;
    bindTableFilter();
    document.querySelector('[data-action="create-user"]').addEventListener("click", () => showModal("Create user", '<div class="field"><label>User name</label><input name="name" required pattern="[A-Za-z0-9_+=,.@-]+"></div>', "Create user", async data => { await rest("/_stacksim/api/iam/users", "POST", { UserName: data.get("name") }); toast("User created"); location.hash = `#/iam/users/${encodeURIComponent(data.get("name"))}`; }));
    return;
  }
  setChrome("iam", ["IAM", "Users", name]);
  const [{ user, groups, accessKeys }, { policies }] = await Promise.all([rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}`), rest("/_stacksim/api/iam/policies")]);
  if (!user) throw new Error(`User ${name} was not found`);
  const attached = policies.filter(policy => user.attachedPolicyArns.includes(policy.arn));
  main.innerHTML = `<div class="page-width">${pageHeader(name, user.arn, '<button class="button danger" data-action="delete-user">Delete</button><button class="button primary" data-action="attach-user-policy">Add permissions</button>')}<div class="dashboard-grid"><section class="card"><div class="card-header"><h2>Permissions</h2></div><div class="card-body">${attached.length ? `<ul>${attached.map(policy => `<li>${escapeHtml(policy.policyName)} <button class="button link" data-detach="${escapeHtml(policy.arn)}">Detach</button></li>`).join("")}</ul>` : '<p class="muted">No directly attached policies.</p>'}</div></section><section class="card"><div class="card-header"><h2>Groups</h2></div><div class="card-body">${groups.length ? `<ul>${groups.map(group => `<li><a href="#/iam/groups/${encodeURIComponent(group.groupName)}">${escapeHtml(group.groupName)}</a></li>`).join("")}</ul>` : '<p class="muted">Not a member of any group.</p>'}</div></section></div><section class="card"><div class="card-header"><div><h2>Security credentials</h2><p class="muted">Secrets are shown only in the creation response.</p></div><button class="button primary" data-action="create-key">Create access key</button></div><div class="table-wrap"><table><thead><tr><th>Access key ID</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>${accessKeys.map(key => `<tr><td class="mono">${escapeHtml(key.accessKeyId)}</td><td>${escapeHtml(key.status)}</td><td>${formatDate(key.createDate)}</td><td><button class="button link" data-key-status="${escapeHtml(key.accessKeyId)}" data-next-status="${key.status === "Active" ? "Inactive" : "Active"}">${key.status === "Active" ? "Deactivate" : "Activate"}</button><button class="button link danger" data-key-delete="${escapeHtml(key.accessKeyId)}">Delete</button></td></tr>`).join("")}</tbody></table></div></section></div>`;
  document.querySelector('[data-action="delete-user"]').addEventListener("click", () => confirmDeletion(name, "Remove keys, group memberships, and policies first.", async () => { await rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}`, "DELETE"); location.hash = "#/iam/users"; }));
  document.querySelector('[data-action="attach-user-policy"]').addEventListener("click", () => showModal("Add permissions", `<div class="field"><label>Policy</label><select name="arn">${policies.filter(policy => !user.attachedPolicyArns.includes(policy.arn)).map(policy => `<option value="${escapeHtml(policy.arn)}">${escapeHtml(policy.policyName)}</option>`).join("")}</select></div>`, "Add permissions", async data => rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}/attach`, "POST", { PolicyArn: data.get("arn") })));
  document.querySelectorAll("[data-detach]").forEach(button => button.addEventListener("click", async () => { await rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}/detach`, "POST", { PolicyArn: button.dataset.detach }); await route(); }));
  document.querySelector('[data-action="create-key"]').addEventListener("click", async () => {
    const created = (await rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}/access-keys`, "POST")).AccessKey;
    showModal("Save access key", `<div class="alert warning"><strong>Secret shown once</strong><br>Save this pair before closing.</div><dl class="key-value"><dt>Access key ID</dt><dd class="mono">${escapeHtml(created.AccessKeyId)}</dd><dt>Secret access key</dt><dd class="mono">${escapeHtml(created.SecretAccessKey)}</dd></dl>`, "I saved it", async () => undefined);
  });
  document.querySelectorAll("[data-key-status]").forEach(button => button.addEventListener("click", async () => { await rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}/access-keys/${encodeURIComponent(button.dataset.keyStatus)}`, "PATCH", { Status: button.dataset.nextStatus }); await route(); }));
  document.querySelectorAll("[data-key-delete]").forEach(button => button.addEventListener("click", () => confirmDeletion(button.dataset.keyDelete, "This key will stop authenticating immediately.", async () => { await rest(`/_stacksim/api/iam/users/${encodeURIComponent(name)}/access-keys/${encodeURIComponent(button.dataset.keyDelete)}`, "DELETE"); })));
}

async function iamGroups(context, name) {
  const { bindTableFilter, confirmDeletion, main, setChrome, showModal } = context;
  if (!name) {
    setChrome("iam", ["IAM", "User groups"]);
    const groups = (await rest("/_stacksim/api/iam/groups")).groups ?? [];
    main.innerHTML = `<div class="page-width">${pageHeader("User groups", "Attach policies once and share them across member users.", '<button class="button primary" data-action="create-group">Create group</button>')}<div class="card"><div class="card-header"><h2>User groups <span class="muted">(${groups.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find groups"></label></div><div class="table-wrap">${groups.length ? `<table><thead><tr><th>Group name</th><th>ARN</th><th>Members</th></tr></thead><tbody>${groups.map(group => `<tr data-search-row="${escapeHtml(group.groupName.toLowerCase())}"><td><a href="#/iam/groups/${encodeURIComponent(group.groupName)}">${escapeHtml(group.groupName)}</a></td><td class="mono">${escapeHtml(group.arn)}</td><td>${group.userNames.length}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No groups", "Create a group to share policies.")}</div></div></div>`;
    bindTableFilter();
    document.querySelector('[data-action="create-group"]').addEventListener("click", () => showModal("Create group", '<div class="field"><label>Group name</label><input name="name" required pattern="[A-Za-z0-9_+=,.@-]+"></div>', "Create group", async data => { await rest("/_stacksim/api/iam/groups", "POST", { GroupName: data.get("name") }); location.hash = `#/iam/groups/${encodeURIComponent(data.get("name"))}`; }));
    return;
  }
  setChrome("iam", ["IAM", "User groups", name]);
  const [{ group, users }, allUsers] = await Promise.all([rest(`/_stacksim/api/iam/groups/${encodeURIComponent(name)}`), rest("/_stacksim/api/iam/users")]);
  if (!group) throw new Error(`Group ${name} was not found`);
  main.innerHTML = `<div class="page-width">${pageHeader(name, group.arn, '<button class="button danger" data-action="delete-group">Delete</button><button class="button primary" data-action="add-member">Add member</button>')}<div class="card"><div class="card-header"><h2>Members</h2></div><div class="table-wrap">${users.length ? `<table><thead><tr><th>User</th><th>Action</th></tr></thead><tbody>${users.map(user => `<tr><td><a href="#/iam/users/${encodeURIComponent(user.userName)}">${escapeHtml(user.userName)}</a></td><td><button class="button link" data-remove-member="${escapeHtml(user.userName)}">Remove</button></td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No members", "Add an IAM user to this group.")}</div></div></div>`;
  document.querySelector('[data-action="delete-group"]').addEventListener("click", () => confirmDeletion(name, "Remove members and policies first.", async () => { await rest(`/_stacksim/api/iam/groups/${encodeURIComponent(name)}`, "DELETE"); location.hash = "#/iam/groups"; }));
  document.querySelector('[data-action="add-member"]').addEventListener("click", () => showModal("Add member", `<div class="field"><label>User</label><select name="user">${allUsers.users.filter(user => !group.userNames.includes(user.userName)).map(user => `<option>${escapeHtml(user.userName)}</option>`).join("")}</select></div>`, "Add member", async data => rest(`/_stacksim/api/iam/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(data.get("user"))}`, "PUT")));
  document.querySelectorAll("[data-remove-member]").forEach(button => button.addEventListener("click", async () => { await rest(`/_stacksim/api/iam/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(button.dataset.removeMember)}`, "DELETE"); location.reload(); }));
}

async function iamRoles(context, name, section) {
  if (name) return iamRoleDetail(context, name, section);

  const { bindTableFilter, main, setChrome, showModal, toast } = context;
  setChrome("iam", ["IAM", "Roles"]);
  const roles = (await rest("/_stacksim/api/iam/roles")).roles ?? [];
  main.innerHTML = `<div class="page-width">${pageHeader("Roles", "Roles are identities with permission policies and a trust policy.", '<button class="button primary" data-action="create-role">Create role</button><button class="button guided-role-launch" type="button" data-action="create-guided-role" aria-label="Create service role" title="Create service role" data-tooltip="Create service role"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10 6h11M10 12h11M10 18h11"></path><path d="M4 6h1V3.5M4 10h2l-2 2h2M4 16h2c0 1-2 1-2 2h2"></path></svg></button>')}<div class="card"><div class="card-header"><h2>Roles <span class="muted">(${roles.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find roles"></label></div><div class="table-wrap">${roles.length ? `<table><thead><tr><th>Role name</th><th>Path</th><th>Trusted entities</th><th>Created</th></tr></thead><tbody>${roles.map(role => `<tr data-search-row="${escapeHtml(role.roleName.toLowerCase())}"><td><a href="#/iam/roles/${encodeURIComponent(role.roleName)}">${escapeHtml(role.roleName)}</a></td><td>${escapeHtml(role.path)}</td><td>${escapeHtml(JSON.stringify(role.assumeRolePolicyDocument.Statement).slice(0,120))}</td><td>${formatDate(role.createDate)}</td></tr>`).join("")}</tbody></table>` : emptyState("◆", "No roles", "Create a role for Lambda or an assumable SDK session.", '<button class="button primary" data-action="create-role">Create role</button>')}</div></div></div>`;
  bindTableFilter();
  document.querySelector('[data-action="create-guided-role"]')?.addEventListener("click", () => openGuidedRoleCreator(context, roles));
  document.querySelectorAll('[data-action="create-role"]').forEach(button => button.addEventListener("click", () => showModal("Create role", `<div class="wizard"><p class="muted">Step 1 of 2 · Select trusted entity and permissions</p><div class="field"><label>Trusted entity type</label><select name="trusted"><option value="lambda">service – Lambda</option><option value="account">Local account</option><option value="custom">Custom trust policy</option></select></div><div class="field"><label>Role name</label><input name="name" required pattern="[A-Za-z0-9_+=,.@-]+"></div><div class="field"><label>Description</label><input name="description"></div><div class="field"><label>Custom trust policy JSON</label><textarea name="trust">${escapeHtml(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, null, 2))}</textarea></div></div>`, "Create role", async data => {
    const trusted = data.get("trusted");
    let trust = JSON.parse(String(data.get("trust")));
    if (trusted === "account") trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ui.summary.accountId}:root` }, Action: "sts:AssumeRole" }] };
    await rest("/_stacksim/api/iam/roles", "POST", { RoleName: data.get("name"), Description: data.get("description"), AssumeRolePolicyDocument: trust });
    toast("Role created");
    location.hash = `#/iam/roles/${encodeURIComponent(data.get("name"))}`;
  })));
}

async function iamRoleDetail(context, name, requestedSection) {
  const { confirmDeletion, main, route, setChrome, showModal, toast } = context;
  setChrome("iam", ["IAM", "Roles", name]);
  const [{ role, relatedFunctions = [] }, { policies }] = await Promise.all([
    rest(`/_stacksim/api/iam/roles/${encodeURIComponent(name)}`),
    rest("/_stacksim/api/iam/policies"),
  ]);
  if (!role) throw new Error(`Role ${name} was not found`);
  const section = new Set(["permissions", "trust", "tags", "access-advisor"]).has(requestedSection) ? requestedSection : "permissions";
  const attached = policies.filter(policy => role.attachedPolicyArns.includes(policy.arn));
  const snippet = `const sts = new STSClient({ region: "${ui.region}" });\nconst response = await sts.send(new AssumeRoleCommand({\n  RoleArn: "${role.arn}",\n  RoleSessionName: "local-learning"\n}));`;
  const panels = {
    permissions: detailPanel("role-permissions", "Permissions", `<div class="card"><div class="card-header"><h2>Permissions policies</h2></div><div class="table-wrap">${attached.length ? `<table><thead><tr><th>Policy name</th><th>Type</th><th>Action</th></tr></thead><tbody>${attached.map(policy => `<tr><td><a href="#/iam/policies/${encodeURIComponent(policy.arn)}">${escapeHtml(policy.policyName)}</a></td><td>${policy.awsManaged ? "service-managed" : "Customer managed"}</td><td><button class="button link" data-detach-policy="${escapeHtml(policy.arn)}">Detach</button></td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No permission policies", "Attach a managed policy or add an inline policy.")}</div></div><div class="card"><div class="card-header"><h2>Related Lambda functions <span class="muted">(${relatedFunctions.length})</span></h2></div><div class="table-wrap">${relatedFunctions.length ? `<table><thead><tr><th>Function</th><th>Region</th><th>Log delivery</th></tr></thead><tbody>${relatedFunctions.map(item => `<tr><td><a href="#/lambda/functions/${encodeURIComponent(item.functionName)}">${escapeHtml(item.functionName)}</a></td><td>${escapeHtml(item.region)}</td><td>${item.lastLogDeliveryError ? `<span class="status error">${escapeHtml(item.lastLogDeliveryError.code)}</span><div class="muted small">${escapeHtml(item.lastLogDeliveryError.message)}</div>` : "No recorded error"}</td></tr>`).join("")}</tbody></table>` : emptyState("λ", "No related functions", "Lambda functions configured with this execution role appear here. This is local relationship data, not an IAM API field.")}</div></div><div class="card"><div class="card-header"><h2>Assume this role with SDK v3</h2></div><div class="card-body"><pre class="code-box">${escapeHtml(snippet)}</pre></div></div>`),
    trust: detailPanel("role-trust", "Trust relationships", `<div class="card"><div class="card-header"><h2>Trust policy</h2></div><div class="card-body"><p class="muted">This policy controls which principals can assume the role.</p><pre class="code-box">${escapeHtml(JSON.stringify(role.assumeRolePolicyDocument, null, 2))}</pre></div></div>`),
    tags: detailPanel("role-tags", "Tags", tagsPanel(role.tags, "role")),
    "access-advisor": detailPanel("role-access-advisor", "Access advisor", `<div class="card">${emptyState("◇", "No access advisor data", "Service last-accessed information is not available in this local simulator.")}</div>`),
  };
  const navigation = detailNavigation("Role details", `#/iam/roles/${encodeURIComponent(name)}`, [["permissions", "Permissions"], ["trust", "Trust relationships"], ["tags", "Tags"], ["access-advisor", "Access advisor"]], section);
  main.innerHTML = `<div class="page-width">${pageHeader(name, role.arn, '<button class="button danger" data-action="delete-role">Delete</button><button class="button primary" data-action="attach-policy">Add permissions</button>')}${navigation}${panels[section]}</div>`;
  document.querySelector('[data-action="delete-role"]').addEventListener("click", () => confirmDeletion(name, `Delete role ${name}? Detach its policies first.`, async () => {
    await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(name)}`, "DELETE");
    toast("Role deleted");
    location.hash = "#/iam/roles";
  }));
  document.querySelector('[data-action="attach-policy"]').addEventListener("click", () => showModal("Add permissions", `<div class="field iam-attach-policy-field"><label>Policy</label><select name="arn">${policies.filter(policy => !role.attachedPolicyArns.includes(policy.arn)).map(policy => `<option value="${escapeHtml(policy.arn)}">${escapeHtml(policy.policyName)} · ${policy.awsManaged ? "service-managed" : "Customer managed"}</option>`).join("")}</select></div>`, "Add permissions", async data => {
    await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(name)}/attach`, "POST", { PolicyArn: data.get("arn") });
    toast("Policy attached");
  }));
  document.querySelectorAll("[data-detach-policy]").forEach(button => button.addEventListener("click", async () => {
    await rest(`/_stacksim/api/iam/roles/${encodeURIComponent(name)}/detach`, "POST", { PolicyArn: button.dataset.detachPolicy });
    toast("Policy detached");
    await route();
  }));
}

function policyEditorMarkup(policyDocument) {
  return `<div class="field"><label>Policy name</label><input name="name" required></div><div class="field"><label>Description</label><input name="description"></div><div class="tabs" role="tablist" aria-label="Policy editor mode"><button type="button" class="tab" id="create-policy-visual-tab" role="tab" aria-selected="false" aria-controls="create-policy-visual-panel" tabindex="-1" data-policy-editor-tab="visual">Visual</button><button type="button" class="tab active" id="create-policy-json-tab" role="tab" aria-selected="true" aria-controls="create-policy-json-panel" tabindex="0" data-policy-editor-tab="json">JSON</button></div><div class="alert error" role="alert" data-policy-editor-error hidden></div><section id="create-policy-visual-panel" role="tabpanel" aria-labelledby="create-policy-visual-tab" data-policy-editor-panel="visual" hidden><p class="muted">Edit the first statement visually. Additional JSON statements are preserved.</p><div class="field-row"><div class="field"><label for="create-policy-effect">Effect</label><select id="create-policy-effect" data-policy-effect><option value="Allow">Allow</option><option value="Deny">Deny</option></select></div><div class="field"><label for="create-policy-sid">Statement ID (optional)</label><input id="create-policy-sid" data-policy-sid></div></div><div class="field"><label for="create-policy-actions">Actions</label><textarea id="create-policy-actions" data-policy-actions placeholder="dynamodb:GetItem&#10;dynamodb:PutItem"></textarea><span class="hint">Enter one action per line or separate actions with commas.</span></div><div class="field"><label for="create-policy-resources">Resources</label><textarea id="create-policy-resources" data-policy-resources placeholder="*"></textarea><span class="hint">Enter one ARN per line, or use *.</span></div></section><section id="create-policy-json-panel" role="tabpanel" aria-labelledby="create-policy-json-tab" data-policy-editor-panel="json"><div class="field"><label for="create-policy-document">Policy document</label><textarea id="create-policy-document" name="document" style="min-height:300px">${escapeHtml(JSON.stringify(policyDocument, null, 2))}</textarea></div><p class="muted">Review the permission summary before creating this customer-managed policy.</p></section>`;
}

function policyEditorError(root, message = "") {
  const error = root.querySelector("[data-policy-editor-error]");
  error.textContent = message;
  error.hidden = !message;
}

function policyValues(value) {
  return (Array.isArray(value) ? value : [value]).filter(item => typeof item === "string" && item).join("\n");
}

function parsePolicyValues(value, label) {
  const values = value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  if (!values.length) throw new Error(`Enter at least one ${label}.`);
  return values.length === 1 ? values[0] : values;
}

function syncJsonToVisual(root) {
  const policyDocument = JSON.parse(root.querySelector('[name="document"]').value);
  const statements = Array.isArray(policyDocument.Statement) ? policyDocument.Statement : [policyDocument.Statement];
  const statement = statements[0];
  if (!statement || typeof statement !== "object") throw new Error("The policy must contain at least one statement.");
  if (statement.NotAction !== undefined || statement.NotResource !== undefined) throw new Error("Use the JSON editor for NotAction or NotResource statements.");
  root.querySelector("[data-policy-effect]").value = statement.Effect === "Deny" ? "Deny" : "Allow";
  root.querySelector("[data-policy-sid]").value = statement.Sid ?? "";
  root.querySelector("[data-policy-actions]").value = policyValues(statement.Action);
  root.querySelector("[data-policy-resources]").value = policyValues(statement.Resource ?? "*");
}

function syncVisualToJson(root) {
  const editor = root.querySelector('[name="document"]');
  const policyDocument = JSON.parse(editor.value);
  const statements = Array.isArray(policyDocument.Statement) ? policyDocument.Statement : [policyDocument.Statement];
  const current = statements[0] && typeof statements[0] === "object" ? statements[0] : {};
  const first = {
    ...current,
    Effect: root.querySelector("[data-policy-effect]").value,
    Action: parsePolicyValues(root.querySelector("[data-policy-actions]").value, "action"),
    Resource: parsePolicyValues(root.querySelector("[data-policy-resources]").value, "resource"),
  };
  const sid = root.querySelector("[data-policy-sid]").value.trim();
  if (sid) first.Sid = sid; else delete first.Sid;
  policyDocument.Statement = [first, ...statements.slice(1)];
  editor.value = JSON.stringify(policyDocument, null, 2);
}

function activatePolicyEditorTab(root, mode, focus = false) {
  try {
    const current = root.querySelector('[data-policy-editor-tab][aria-selected="true"]')?.dataset.policyEditorTab;
    if (current === "json" && mode === "visual") syncJsonToVisual(root);
    if (current === "visual" && mode === "json") syncVisualToJson(root);
    policyEditorError(root);
  } catch (error) {
    policyEditorError(root, error instanceof Error ? error.message : String(error));
    return;
  }
  root.querySelectorAll("[data-policy-editor-tab]").forEach(tab => {
    const active = tab.dataset.policyEditorTab === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll("[data-policy-editor-panel]").forEach(panel => { panel.hidden = panel.dataset.policyEditorPanel !== mode; });
  if (focus) root.querySelector(`[data-policy-editor-tab="${mode}"]`).focus();
}

function bindPolicyEditor(root) {
  const tabs = [...root.querySelectorAll("[data-policy-editor-tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activatePolicyEditorTab(root, tab.dataset.policyEditorTab));
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs.at(-1);
      if (!next) return;
      event.preventDefault();
      activatePolicyEditorTab(root, next.dataset.policyEditorTab, true);
    });
  });
}

async function iamPolicies(context, arn, section) {
  if (arn) return iamPolicyDetail(context, arn, section);

  const { bindTableFilter, main, setChrome, showModal, toast } = context;
  setChrome("iam", ["IAM", "Policies"]);
  const policies = (await rest("/_stacksim/api/iam/policies")).policies ?? [];
  main.innerHTML = `<div class="page-width">${pageHeader("Policies", "Policies define permissions that can be attached to roles.", '<button class="button primary" data-action="create-policy">Create policy</button>')}<div class="card"><div class="card-header"><h2>Policies <span class="muted">(${policies.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find policies"></label></div><div class="table-wrap"><table><thead><tr><th>Policy name</th><th>Type</th><th>Path</th><th>Default version</th></tr></thead><tbody>${policies.map(policy => `<tr data-search-row="${escapeHtml(policy.policyName.toLowerCase())}"><td><a href="#/iam/policies/${encodeURIComponent(policy.arn)}">${escapeHtml(policy.policyName)}</a></td><td>${policy.awsManaged ? "service-managed" : "Customer managed"}</td><td>${escapeHtml(policy.path)}</td><td>${escapeHtml(policy.defaultVersionId)}</td></tr>`).join("")}</tbody></table></div></div></div>`;
  bindTableFilter();
  document.querySelector('[data-action="create-policy"]').addEventListener("click", () => {
    const initialDocument = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem"], Resource: "*" }] };
    showModal("Create policy", policyEditorMarkup(initialDocument), "Create policy", async data => {
      const modal = document.querySelector("#modal");
      if (modal.querySelector('[data-policy-editor-tab="visual"]').getAttribute("aria-selected") === "true") syncVisualToJson(modal);
      const policyDocument = JSON.parse(modal.querySelector('[name="document"]').value);
      const created = await rest("/_stacksim/api/iam/policies", "POST", { PolicyName: data.get("name"), Description: data.get("description"), PolicyDocument: policyDocument });
    toast("Policy created");
    location.hash = `#/iam/policies/${encodeURIComponent(created.Policy.Arn)}`;
    }, true);
    bindPolicyEditor(document.querySelector("#modal"));
  });
}

async function iamPolicyDetail(context, arn, requestedSection) {
  const { confirmDeletion, main, setChrome, toast } = context;
  setChrome("iam", ["IAM", "Policies", arn.split("/").at(-1)]);
  const { policy, entities } = await rest(`/_stacksim/api/iam/policies/${encodeURIComponent(arn)}`);
  if (!policy) throw new Error("Policy was not found");
  const section = new Set(["permissions", "entities", "versions", "tags"]).has(requestedSection) ? requestedSection : "permissions";
  const versions = Object.values(policy.versions).sort((a, b) => b.createDate - a.createDate);
  const panels = {
    permissions: detailPanel("policy-permissions", "Permissions", `<div class="card"><div class="card-header"><h2>Permission policy</h2></div><div class="card-body"><pre class="code-box">${escapeHtml(JSON.stringify(policy.versions[policy.defaultVersionId].document, null, 2))}</pre></div></div>`),
    entities: detailPanel("policy-entities", "Entities attached", `<div class="card"><div class="card-header"><h2>Entities attached</h2></div><div class="card-body">${entities.length ? `<ul>${entities.map(name => `<li><a href="#/iam/roles/${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`).join("")}</ul>` : emptyState("◇", "No attached entities", "This policy is not attached to any roles.")}</div></div>`),
    versions: detailPanel("policy-versions", "Policy versions", `<div class="card"><div class="card-header"><h2>Policy versions</h2></div><div class="table-wrap"><table><thead><tr><th>Version</th><th>Default</th><th>Created</th></tr></thead><tbody>${versions.map(version => `<tr><td>${escapeHtml(version.versionId)}</td><td>${version.isDefaultVersion ? "Yes" : "No"}</td><td>${formatDate(version.createDate)}</td></tr>`).join("")}</tbody></table></div></div>`),
    tags: detailPanel("policy-tags", "Tags", tagsPanel(policy.tags, "policy")),
  };
  const navigation = detailNavigation("Policy details", `#/iam/policies/${encodeURIComponent(arn)}`, [["permissions", "Permissions"], ["entities", "Entities attached"], ["versions", "Policy versions"], ["tags", "Tags"]], section);
  main.innerHTML = `<div class="page-width">${pageHeader(policy.policyName, policy.arn, policy.awsManaged ? "" : '<button class="button danger" data-action="delete-policy">Delete</button>')}${navigation}${panels[section]}</div>`;
  document.querySelector('[data-action="delete-policy"]')?.addEventListener("click", () => confirmDeletion(policy.policyName, `Delete policy ${policy.policyName}?`, async () => {
    await rest(`/_stacksim/api/iam/policies/${encodeURIComponent(arn)}`, "DELETE");
    toast("Policy deleted");
    location.hash = "#/iam/policies";
  }));
}

async function authorizationDecisions(context) {
  const { main, setChrome } = context;
  setChrome("iam", ["IAM", "Authorization decisions"]);
  const decisions = (await rest("/_stacksim/api/iam/decisions")).decisions ?? [];
  main.innerHTML = `<div class="page-width">${pageHeader("Authorization decisions", "Local diagnostic history. This page is not part of the IAM console.")}<div class="alert info"><strong>Local simulator tooling</strong><br>Use these decisions to understand explicit and implicit denies without exposing credential material.</div><div class="card"><div class="table-wrap">${decisions.length ? `<table><thead><tr><th>Time</th><th>Decision</th><th>Principal</th><th>Action</th><th>Resource</th><th>Reason</th></tr></thead><tbody>${decisions.map(item => `<tr><td>${formatDate(item.time)}</td><td><span class="status ${item.decision === "allowed" ? "" : "error"}">${escapeHtml(item.decision)}</span></td><td class="mono">${escapeHtml(item.principalArn)}</td><td>${escapeHtml(item.action)}</td><td class="mono">${escapeHtml(item.resource)}</td><td>${escapeHtml(item.reason)}</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No authorization decisions", "Enable enforce mode and make signed SDK requests to populate this diagnostic history.")}</div></div></div>`;
}

function iamPlaceholder(context, title) {
  context.setChrome("iam", [metadata.name, title]);
  context.main.innerHTML = `<div class="page-width">${pageHeader(title, "This area is reserved for future service functionality.")}<div class="card">${emptyState("◇", "Not implemented yet", "The navigation and page structure are in place and will grow with the simulator.")}</div></div>`;
}
