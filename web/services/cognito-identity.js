import { request } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";

export const metadata = {
  key: "cognito-identity",
  name: "Cognito Identity Pools",
  icon: "C",
  cls: "cognito",
  links: [
    ["Identity pools", "#/cognito-identity/identity-pools"],
    ["Overview", "#/cognito-identity"],
  ],
  search: [
    "cognito identity", "identity pool", "federated identities", "getid", "credentials",
  ],
};

const encoded = value => encodeURIComponent(String(value));
const values = value => Array.isArray(value) ? value : value == null ? [] : [value];

function setChrome(context, crumbs) {
  context.setChrome("cognito-identity", crumbs);
}

export async function routeCognitoIdentity(parts, context) {
  if (parts.length === 1 || parts[1] === "overview") return landing(context);
  if (parts[1] === "identity-pools" && !parts[2]) return poolsPage(context);
  if (parts[1] === "identity-pools" && parts[2]) return detailPage(context, decodeURIComponent(parts[2]));
  context.notFound(parts);
}

async function landing(context) {
  const { identityPools } = await request("/_stacksim/api/cognito-identity/identity-pools");
  const identities = identityPools.reduce((total, pool) => total + Number(pool.identityCount), 0);
  setChrome(context, ["Overview"]);
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("Cognito Identity Pools", "Exchange a User Pool ID token for temporary AWS credentials through enhanced GetId and GetCredentialsForIdentity.")}
    <div class="alert info"><strong>CID-01 enhanced flow</strong><br>Identity Pools are a separate service from User Pools. P0 supports User Pool ID-token login, guest identities when enabled, IAM-authorized control APIs, and two CloudFormation types. Classic flow, role mappings, social IdPs, developer identities, and Amplify default Auth are not available.</div>
    <div class="cognito-summary-grid">
      <section class="card"><div class="card-header"><h2>Identity pools</h2></div><div class="card-body"><div class="metric">${identityPools.length}</div><p class="muted">Regional credential brokers</p><a href="#/cognito-identity/identity-pools">View identity pools</a></div></section>
      <section class="card"><div class="card-header"><h2>Identities</h2></div><div class="card-body"><div class="metric">${identities}</div><p class="muted">Cached Identity IDs</p></div></section>
      <section class="card"><div class="card-header"><h2>User pools</h2></div><div class="card-body"><p class="muted">ID tokens come from a User Pool app client in the same Region.</p><a href="#/cognito/user-pools">Open user pools</a></div></section>
    </div>
    <section class="card"><div class="card-header"><h2>Local integration</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Protocol</dt><dd>JSON 1.1</dd><dt>SDK</dt><dd>@aws-sdk/client-cognito-identity</dd></dl><dl class="key-value"><dt>Signing name</dt><dd>cognito-identity</dd><dt>Public actions</dt><dd>GetId, GetCredentialsForIdentity</dd></dl><dl class="key-value"><dt>Regional SDK alias</dt><dd class="mono">/_stacksim/cognito-identity/&lt;region&gt;/sdk</dd><dt>Credential field</dt><dd class="mono">SecretKey</dd></dl></div></section>
  </div>`;
}

async function poolsPage(context) {
  const { identityPools } = await request("/_stacksim/api/cognito-identity/identity-pools");
  setChrome(context, ["Identity pools"]);
  const rows = identityPools.map(pool => `<tr data-search-row="${escapeHtml(`${pool.name} ${pool.id}`.toLowerCase())}">
    <td><a href="#/cognito-identity/identity-pools/${encoded(pool.id)}"><strong>${escapeHtml(pool.name)}</strong></a><div class="muted small mono">${escapeHtml(pool.id)}</div></td>
    <td>${pool.allowUnauthenticatedIdentities ? "Allowed" : "Disabled"}</td>
    <td>${pool.providerCount}</td>
    <td>${pool.identityCount}</td>
    <td>${formatDate(pool.createdAt)}</td>
  </tr>`).join("");
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("Identity pools", "Regional pools that mint enhanced-flow credentials from User Pool ID tokens.")}
    <section class="card"><div class="card-header"><h2>Identity pools <span class="muted">(${identityPools.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find an identity pool"></label></div><div class="table-wrap">${rows ? `<table class="cognito-pool-table"><thead><tr><th>Name</th><th>Guests</th><th>Providers</th><th>Identities</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("C", "No identity pools", "Create an identity pool with the Cognito Identity SDK, AWS CLI, or CloudFormation. This console is read-only in CID-01.")}</div></section>
  </div>`;
  context.bindTableFilter();
}

async function detailPage(context, poolId) {
  const { identityPool } = await request(`/_stacksim/api/cognito-identity/identity-pools/${encoded(poolId)}`);
  setChrome(context, ["Identity pools", identityPool.IdentityPoolName]);
  const providers = values(identityPool.CognitoIdentityProviders);
  const roles = identityPool.Roles ?? {};
  const tags = Object.entries(identityPool.IdentityPoolTags ?? {});
  context.main.innerHTML = `<div class="page-width cognito-page cognito-detail">${pageHeader(identityPool.IdentityPoolName, identityPool.IdentityPoolId)}
    <section class="card"><div class="card-header"><h2>Pool</h2></div><div class="card-body detail-grid">
      <dl class="key-value"><dt>Identity pool ID</dt><dd class="mono">${escapeHtml(identityPool.IdentityPoolId)}</dd><dt>ARN</dt><dd class="mono">${escapeHtml(identityPool.Arn)}</dd></dl>
      <dl class="key-value"><dt>Unauthenticated identities</dt><dd>${identityPool.AllowUnauthenticatedIdentities ? "Allowed" : "Disabled"}</dd><dt>Classic flow</dt><dd>Disabled</dd></dl>
      <dl class="key-value"><dt>Identities</dt><dd>${identityPool.IdentityCount}</dd><dt>Created</dt><dd>${formatDate(identityPool.CreatedAt)}</dd></dl>
    </div></section>
    <section class="card"><div class="card-header"><h2>User Pool providers</h2></div><div class="card-body">${providers.length ? `<table><thead><tr><th>Provider</th><th>App client</th><th>Server-side token check</th></tr></thead><tbody>${providers.map(provider => `<tr><td class="mono">${escapeHtml(provider.ProviderName)}</td><td class="mono">${escapeHtml(provider.ClientId)}</td><td>${provider.ServerSideTokenCheck ? "Enabled" : "Offline"}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">No User Pool providers are attached.</p>"}</div></section>
    <section class="card"><div class="card-header"><h2>Roles</h2></div><div class="card-body detail-grid">
      <dl class="key-value"><dt>Authenticated</dt><dd class="mono">${escapeHtml(roles.authenticated || "Not attached")}</dd><dt>Unauthenticated</dt><dd class="mono">${escapeHtml(roles.unauthenticated || "Not attached")}</dd></dl>
    </div></section>
    <section class="card"><div class="card-header"><h2>Tags</h2></div><div class="card-body">${tags.length ? tags.map(([key, value]) => `<span class="status-badge">${escapeHtml(`${key}=${value}`)}</span>`).join(" ") : "<p class=\"muted\">No tags.</p>"}</div></section>
  </div>`;
}
