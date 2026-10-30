import { consoleMutation, request, rest } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader, tabs } from "../components.js";
import { metadata as cognitoMetadata } from "./cognito.js";

const encoded = value => encodeURIComponent(String(value));
const values = value => Array.isArray(value) ? value : value == null ? [] : [value];

/** Runs one official Cognito Identity control operation through the console's action route. */
const act = (operation, input) => consoleMutation(`/_stacksim/api/cognito-identity/actions/${operation}`, "POST", input);

function setChrome(context, crumbs) {
  cognitoMetadata.links.splice(0, cognitoMetadata.links.length,
    ["User pools", "#/cognito/user-pools"],
    ["Identity pools", "#/cognito-identity/identity-pools"],
  );
  context.setChrome("cognito", [{ label: "Cognito", href: "#/cognito/user-pools" }, ...crumbs]);
}

export async function routeCognitoIdentity(parts, context) {
  if (parts.length === 1 || parts[1] === "overview" || (parts[1] === "identity-pools" && !parts[2])) return poolsPage(context);
  if (parts[1] === "identity-pools" && parts[2] === "create" && parts.length === 3) return createPage(context);
  if (parts[1] === "identity-pools" && parts[2]) return detailPage(context, decodeURIComponent(parts[2]), parts[3]);
  context.notFound(parts);
}

const card = (title, body, actions = "") => `<section class="card"><div class="card-header"><h2>${escapeHtml(title)}</h2>${actions ? `<div class="actions">${actions}</div>` : ""}</div>${body}</section>`;
const detail = entries => `<dl class="key-value">${entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join("")}</dl>`;

async function poolsPage(context) {
  const { identityPools } = await request("/_stacksim/api/cognito-identity/identity-pools");
  setChrome(context, ["Identity pools"]);
  const rows = identityPools.map(pool => `<tr data-search-row="${escapeHtml(`${pool.name} ${pool.id}`.toLowerCase())}">
    <td><input type="radio" name="selected-identity-pool" value="${escapeHtml(pool.id)}" aria-label="Select ${escapeHtml(pool.name)}"></td>
    <td><a href="#/cognito-identity/identity-pools/${encoded(pool.id)}"><strong>${escapeHtml(pool.name)}</strong></a></td>
    <td class="mono">${escapeHtml(pool.id)}</td>
    <td>${pool.allowUnauthenticatedIdentities ? "Active" : "Inactive"}</td>
    <td>${pool.identityCount}</td>
    <td>${formatDate(pool.createdAt)}</td>
  </tr>`).join("");
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("Identity pools", "Regional pools that exchange user pool ID tokens for temporary AWS credentials.", '<button class="button danger" data-action="delete-identity-pool" disabled>Delete</button><a class="button primary" href="#/cognito-identity/identity-pools/create">Create identity pool</a>')}
    <div class="alert info"><strong>Enhanced authentication flow</strong><br>Identity pools exchange a user pool ID token for temporary AWS credentials through GetId and GetCredentialsForIdentity, using the authenticated or guest role you attach. Token (preferred role) and rule-based role mappings are supported. The basic (classic) flow, social identity providers, and developer-authenticated identities are not implemented in this simulator.</div>
    <section class="card"><div class="card-header"><h2>Identity pools <span class="muted">(${identityPools.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find identity pools"></label></div><div class="table-wrap">${rows ? `<table class="cognito-pool-table"><thead><tr><th><span class="sr-only">Select</span></th><th>Identity pool name</th><th>Identity pool ID</th><th>Guest access</th><th>Identities</th><th>Created time</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("C", "No identity pools", "Create an identity pool to exchange user pool tokens for temporary AWS credentials.", '<a class="button primary" href="#/cognito-identity/identity-pools/create">Create identity pool</a>')}</div></section>
  </div>`;
  context.bindTableFilter();
  const remove = document.querySelector('[data-action="delete-identity-pool"]');
  document.querySelectorAll('input[name="selected-identity-pool"]').forEach(input => input.addEventListener("change", () => { remove.disabled = false; }));
  remove?.addEventListener("click", () => {
    const id = document.querySelector('input[name="selected-identity-pool"]:checked')?.value;
    const pool = identityPools.find(candidate => candidate.id === id);
    if (!pool) return;
    context.confirmDeletion(pool.name, `Delete identity pool ${pool.name} and its identities?`, async () => {
      await act("DeleteIdentityPool", { IdentityPoolId: pool.id });
      context.toast("Identity pool deleted");
      await context.route();
    });
  });
}

async function roleArns() {
  try {
    return values((await rest("/_stacksim/api/iam/roles")).roles).map(role => role.arn).filter(Boolean);
  } catch {
    return [];
  }
}

async function userPoolClients() {
  try {
    const { userPools } = await request("/_stacksim/api/cognito/user-pools");
    const clients = await Promise.all(userPools.map(async pool => ({
      pool,
      clients: (await request(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/app-clients`)).appClients,
    })));
    return clients.flatMap(({ pool, clients: entries }) => entries.map(client => ({ poolId: pool.id, poolName: pool.name, clientId: client.id, clientName: client.name })));
  } catch {
    return [];
  }
}

function providerName(poolId) {
  return `cognito-idp.${poolId.split("_")[0]}.amazonaws.com/${poolId}`;
}

async function createPage(context) {
  setChrome(context, [{ label: "Identity pools", href: "#/cognito-identity/identity-pools" }, "Create identity pool"]);
  const [roles, clients] = await Promise.all([roleArns(), userPoolClients()]);
  const roleList = `<datalist id="identity-role-arns">${roles.map(arn => `<option value="${escapeHtml(arn)}">`).join("")}</datalist>`;
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("Create identity pool", "Configure trust, permissions, identity providers, and properties, then review and create.")}
    <form id="identity-pool-create">
      ${card("Step 1 · Configure identity pool trust", `<div class="card-body"><fieldset class="cognito-fieldset"><legend>User access</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="authenticated" checked> Authenticated access</label><label class="checkbox-label"><input type="checkbox" name="guest"> Guest access</label></div></fieldset><fieldset class="cognito-fieldset"><legend>Authenticated identity sources</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" checked disabled> Amazon Cognito user pool</label><label class="checkbox-label"><input type="checkbox" disabled> Facebook, Google, Login with Amazon, Sign in with Apple, OpenID Connect, SAML, custom developer provider</label></div><span class="hint">Only user pool identity sources are implemented in this simulator.</span></fieldset></div>`)}
      ${card("Step 2 · Configure permissions", `<div class="card-body"><div class="field"><label>Authenticated role ARN</label><input name="authenticatedRole" class="mono" list="identity-role-arns" placeholder="arn:aws:iam::000000000000:role/authenticated"></div><div class="field" data-guest-role hidden><label>Guest role ARN</label><input name="guestRole" class="mono" list="identity-role-arns" placeholder="arn:aws:iam::000000000000:role/guest"></div>${roleList}<span class="hint">Create roles in IAM with a trust policy for cognito-identity.amazonaws.com, then choose them here.</span></div>`)}
      ${card("Step 3 · Connect identity providers", `<div class="card-body"><div class="field"><label>User pool and app client</label><select name="client"><option value="">None</option>${clients.map(item => `<option value="${escapeHtml(`${item.poolId}|${item.clientId}`)}">${escapeHtml(`${item.poolName} · ${item.clientName} (${item.clientId})`)}</option>`).join("")}</select></div><div class="field"><label>Role settings</label><select name="roleSettings"><option value="default">Use default authenticated role</option><option value="token">Choose role with preferred_role in tokens</option><option value="rules" disabled>Choose role with rules</option></select><span class="hint">Token selection uses the cognito:preferred_role claim from user pool groups and falls back to the authenticated role. Configure rule-based mappings with SetIdentityPoolRoles or CloudFormation.</span></div></div>`)}
      ${card("Step 4 · Configure properties", `<div class="card-body"><div class="field"><label>Identity pool name</label><input name="name" required maxlength="128" pattern="[\\w ]+" placeholder="my_identity_pool"></div><label class="checkbox-label"><input type="checkbox" disabled> Activate basic flow</label><span class="hint">The basic (classic) authentication flow is not implemented in this simulator.</span><div class="field"><label>Tags <span class="muted">(optional, one key=value per line)</span></label><textarea name="tags" rows="3"></textarea></div></div>`)}
      ${card("Step 5 · Review and create", `<div class="card-body"><p class="muted">Creating the pool calls CreateIdentityPool and then SetIdentityPoolRoles.</p><div class="actions"><a class="button" href="#/cognito-identity/identity-pools">Cancel</a><button class="button primary" type="submit">Create identity pool</button></div></div>`)}
    </form>
  </div>`;
  const form = document.querySelector("#identity-pool-create");
  form.elements.guest.addEventListener("change", () => { form.querySelector("[data-guest-role]").hidden = !form.elements.guest.checked; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const tags = {};
      for (const line of String(data.get("tags") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid tag line: ${line}`);
        tags[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      const [poolId, clientId] = String(data.get("client") || "").split("|");
      const created = await act("CreateIdentityPool", {
        IdentityPoolName: String(data.get("name") || "").trim(),
        AllowUnauthenticatedIdentities: data.get("guest") === "on",
        ...(poolId && clientId ? { CognitoIdentityProviders: [{ ProviderName: providerName(poolId), ClientId: clientId, ServerSideTokenCheck: false }] } : {}),
        ...(Object.keys(tags).length ? { IdentityPoolTags: tags } : {}),
      });
      const authenticated = String(data.get("authenticatedRole") || "").trim();
      const guest = String(data.get("guestRole") || "").trim();
      const tokenMapping = data.get("roleSettings") === "token" && poolId && clientId
        ? { RoleMappings: { [`${providerName(poolId)}:${clientId}`]: { Type: "Token", AmbiguousRoleResolution: "AuthenticatedRole" } } }
        : {};
      if (authenticated || guest) {
        await act("SetIdentityPoolRoles", { IdentityPoolId: created.IdentityPoolId, Roles: { ...(authenticated ? { authenticated } : {}), ...(guest ? { unauthenticated: guest } : {}) }, ...tokenMapping });
      }
      context.toast("Identity pool created");
      location.hash = `#/cognito-identity/identity-pools/${encoded(created.IdentityPoolId)}`;
    } catch (error) {
      context.toast(error.message || "The identity pool could not be created");
    }
  });
}

/** UpdateIdentityPool replaces the pool, so edits start from DescribeIdentityPool. */
function updateInput(pool) {
  return {
    IdentityPoolId: pool.IdentityPoolId,
    IdentityPoolName: pool.IdentityPoolName,
    AllowUnauthenticatedIdentities: pool.AllowUnauthenticatedIdentities,
    CognitoIdentityProviders: values(pool.CognitoIdentityProviders),
    ...(pool.IdentityPoolTags && Object.keys(pool.IdentityPoolTags).length ? { IdentityPoolTags: pool.IdentityPoolTags } : {}),
  };
}

async function detailPage(context, poolId, tab = "user-access") {
  const { identityPool } = await request(`/_stacksim/api/cognito-identity/identity-pools/${encoded(poolId)}`);
  setChrome(context, [{ label: "Identity pools", href: "#/cognito-identity/identity-pools" }, identityPool.IdentityPoolName]);
  const providers = values(identityPool.CognitoIdentityProviders);
  const roles = identityPool.Roles ?? {};
  const tags = Object.entries(identityPool.IdentityPoolTags ?? {});
  const root = `#/cognito-identity/identity-pools/${encoded(identityPool.IdentityPoolId)}`;
  const identities = values(identityPool.Identities);
  const userAccess = `${card("Identity providers", `<div class="table-wrap">${providers.length ? `<table><thead><tr><th>Provider</th><th>App client ID</th><th>Server-side token check</th><th>Actions</th></tr></thead><tbody>${providers.map(provider => `<tr><td class="mono">${escapeHtml(provider.ProviderName)}</td><td class="mono">${escapeHtml(provider.ClientId)}</td><td>${provider.ServerSideTokenCheck ? "Enabled" : "Offline"}</td><td><button class="button danger" data-remove-provider="${escapeHtml(`${provider.ProviderName}|${provider.ClientId}`)}">Remove</button></td></tr>`).join("")}</tbody></table>` : emptyState("P", "No identity providers", "Add a user pool app client so its ID tokens can obtain credentials.")}</div>`, '<button class="button" data-action="add-provider">Add identity provider</button>')}
    ${card("Authenticated access", `<div class="card-body">${detail([["Authenticated role", `<span class="mono">${escapeHtml(roles.authenticated || "Not attached")}</span>`]])}</div>`, '<button class="button" data-action="edit-roles">Edit</button>')}
    ${card("Guest access", `<div class="card-body">${detail([["Status", identityPool.AllowUnauthenticatedIdentities ? "Active" : "Inactive"], ["Guest role", `<span class="mono">${escapeHtml(roles.unauthenticated || "Not attached")}</span>`]])}</div>`, `<button class="button" data-action="toggle-guest">${identityPool.AllowUnauthenticatedIdentities ? "Deactivate" : "Activate"}</button>`)}`;
  const browser = card(`Identity browser (${identityPool.IdentityCount})`, `<div class="table-wrap">${identities.length ? `<table><thead><tr><th>Identity ID</th><th>Linked logins</th><th>Access</th><th>Created time</th></tr></thead><tbody>${identities.map(identity => `<tr><td class="mono">${escapeHtml(identity.IdentityId)}</td><td>${escapeHtml(identity.Logins.join(", ") || "None (guest)")}</td><td>${identity.AuthClass === "authenticated" ? "Authenticated" : "Guest"}</td><td>${formatDate(identity.CreationDate)}</td></tr>`).join("")}</tbody></table>` : emptyState("I", "No identities", "Identities appear after an application calls GetId.")}</div>`);
  const properties = `${card("Identity pool properties", `<div class="card-body detail-grid">${detail([["Identity pool name", escapeHtml(identityPool.IdentityPoolName)], ["Identity pool ID", `<span class="mono">${escapeHtml(identityPool.IdentityPoolId)}</span>`], ["ARN", `<span class="mono">${escapeHtml(identityPool.Arn)}</span>`]])}${detail([["Basic authentication", "Inactive"], ["Created time", formatDate(identityPool.CreatedAt)]])}</div>`, '<button class="button" data-action="rename">Edit</button><button class="button danger" data-action="delete">Delete identity pool</button>')}
    ${card("Tags", `<div class="card-body">${tags.length ? `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">No tags.</p>'}</div>`)}`;
  context.main.innerHTML = `<div class="page-width cognito-page cognito-detail">${pageHeader(identityPool.IdentityPoolName, identityPool.IdentityPoolId)}
    ${tabs([
      { label: "User access", href: `${root}/user-access`, active: tab !== "identity-browser" && tab !== "properties" },
      { label: "Identity browser", href: `${root}/identity-browser`, active: tab === "identity-browser" },
      { label: "Properties", href: `${root}/properties`, active: tab === "properties" },
    ])}
    ${tab === "identity-browser" ? browser : tab === "properties" ? properties : userAccess}
  </div>`;
  const describe = async () => act("DescribeIdentityPool", { IdentityPoolId: identityPool.IdentityPoolId });
  const roleList = async () => `<datalist id="identity-role-arns">${(await roleArns()).map(arn => `<option value="${escapeHtml(arn)}">`).join("")}</datalist>`;
  document.querySelector('[data-action="toggle-guest"]')?.addEventListener("click", async () => {
    const input = updateInput(await describe());
    input.AllowUnauthenticatedIdentities = !identityPool.AllowUnauthenticatedIdentities;
    await act("UpdateIdentityPool", input);
    context.toast(`Guest access ${input.AllowUnauthenticatedIdentities ? "activated" : "deactivated"}`);
    await context.route();
  });
  document.querySelector('[data-action="edit-roles"]')?.addEventListener("click", async () => context.showModal("Edit roles", `<div class="field"><label>Authenticated role ARN</label><input name="authenticated" class="mono" list="identity-role-arns" value="${escapeHtml(roles.authenticated || "")}"></div><div class="field"><label>Guest role ARN</label><input name="unauthenticated" class="mono" list="identity-role-arns" value="${escapeHtml(roles.unauthenticated || "")}"></div>${await roleList()}`, "Save changes", async data => {
    const authenticated = String(data.get("authenticated") || "").trim();
    const unauthenticated = String(data.get("unauthenticated") || "").trim();
    await act("SetIdentityPoolRoles", { IdentityPoolId: identityPool.IdentityPoolId, Roles: { ...(authenticated ? { authenticated } : {}), ...(unauthenticated ? { unauthenticated } : {}) } });
    context.toast("Roles updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="add-provider"]')?.addEventListener("click", async () => {
    const clients = await userPoolClients();
    context.showModal("Add identity provider", `<div class="field"><label>User pool and app client</label><select name="client" required>${clients.map(item => `<option value="${escapeHtml(`${item.poolId}|${item.clientId}`)}">${escapeHtml(`${item.poolName} · ${item.clientName} (${item.clientId})`)}</option>`).join("")}</select></div>`, "Add", async data => {
      const [poolIdValue, clientId] = String(data.get("client") || "").split("|");
      const input = updateInput(await describe());
      input.CognitoIdentityProviders = [...input.CognitoIdentityProviders, { ProviderName: providerName(poolIdValue), ClientId: clientId, ServerSideTokenCheck: false }];
      await act("UpdateIdentityPool", input);
      context.toast("Identity provider added");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelectorAll("[data-remove-provider]").forEach(button => button.addEventListener("click", async () => {
    const [name, clientId] = button.dataset.removeProvider.split("|");
    const input = updateInput(await describe());
    input.CognitoIdentityProviders = input.CognitoIdentityProviders.filter(provider => !(provider.ProviderName === name && provider.ClientId === clientId));
    await act("UpdateIdentityPool", input);
    context.toast("Identity provider removed");
    await context.route();
  }));
  document.querySelector('[data-action="rename"]')?.addEventListener("click", () => context.showModal("Edit identity pool name", `<div class="field"><label>Identity pool name</label><input name="name" required maxlength="128" pattern="[\\w ]+" value="${escapeHtml(identityPool.IdentityPoolName)}"></div>`, "Save changes", async data => {
    const input = updateInput(await describe());
    input.IdentityPoolName = String(data.get("name") || "").trim();
    await act("UpdateIdentityPool", input);
    context.toast("Identity pool updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="delete"]')?.addEventListener("click", () => context.confirmDeletion(identityPool.IdentityPoolName, `Delete identity pool ${identityPool.IdentityPoolName} and its identities?`, async () => {
    await act("DeleteIdentityPool", { IdentityPoolId: identityPool.IdentityPoolId });
    context.toast("Identity pool deleted");
    location.hash = "#/cognito-identity/identity-pools";
  }));
}
