import { consoleMutation, request } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader, panelHeading, tabs } from "../components.js";

export const metadata = {
  key: "cognito",
  name: "Cognito",
  icon: "C",
  cls: "cognito",
  links: [
    ["User pools", "#/cognito/user-pools"],
    ["Overview", "#/cognito"],
  ],
  search: [
    "cognito", "identity", "user pool", "app client", "users", "sign in", "sign up",
    "authentication", "jwt", "jwks",
  ],
};

const encoded = value => encodeURIComponent(String(value));
const values = value => Array.isArray(value) ? value : value == null ? [] : [value];

const cognitoPanelHelp = {
  userPools: {
    level: "Supported locally",
    description: "A user pool is an application user directory. It stores users, sign-in identifiers, password and MFA rules, groups, app clients, and token settings. Create a pool when an application needs sign-up or administrator-managed users and Cognito-shaped authentication tokens.",
    support: "User-pool creation, users, groups, password and SRP authentication, recovery, MFA, Lambda triggers, signed JWTs, and local JWKS are active and persist locally. Cognito Identity Pools are not available.",
  },
  poolDetails: {
    level: "Supported locally",
    description: "Pool configuration controls directory-wide behavior. Use Configure to choose MFA, connect supported Lambda lifecycle triggers, and manage tags. Deletion protection prevents the pool and all of its users and clients from being removed accidentally.",
    support: "MFA modes, software-token settings, supported Lambda triggers, tags, and deletion protection are active. Trigger functions need a Cognito service-principal resource-policy permission for this pool ARN.",
  },
  users: {
    level: "Supported locally",
    description: "Users are identities stored in this pool. Create an administrator-managed user when staff or an automated provisioning flow should establish the account, optionally issuing a temporary password and invitation instead of using public self-service sign-up.",
    support: "User creation, temporary passwords, confirmation status, email verification, enable or disable, pagination, search, and local SES invitation capture are active. The console never reveals generated temporary passwords or confirmation codes.",
  },
  userDetails: {
    level: "Supported locally",
    description: "User details manage the account lifecycle after creation. You can enable or disable access, set a permanent or temporary password, send a password-reset code, revoke active sessions, or permanently delete the user.",
    support: "Account status, password policy enforcement, reset delivery through the local SES Inbox, token-session revocation, and deletion are active locally. Existing access tokens remain valid until expiry unless the consuming application checks revocation as supported.",
  },
  attributes: {
    level: "Supported locally",
    description: "Attributes store profile data such as email and application-specific custom values. Each pool schema decides the data type, constraints, whether the value is required, and whether administrators may change or remove it after user creation.",
    support: "Schema validation, mutable attribute add, edit and removal, verification flags, required fields, and string or number constraints are active. Immutable attributes can be supplied only when the user is created.",
  },
  groupsAndMfa: {
    level: "Supported locally",
    description: "Group membership adds group and preferred-role claims to newly issued tokens, while a user's MFA preference decides whether an eligible second factor is used at sign-in. Edit these when authorization or authentication requirements differ by user.",
    support: "Membership changes, precedence and role claims, email OTP preferences, software-token MFA APIs, and newly issued token claims are active. Existing tokens are not rewritten after a group change, and SMS MFA is unavailable.",
  },
  groups: {
    level: "Supported locally",
    description: "Groups organize users and add cognito:groups claims to their tokens. Optional precedence chooses the preferred group when several memberships have roles, and an IAM role ARN supplies the cognito:preferred_role claim.",
    support: "Group creation, deletion, membership, precedence, role claims, listing, and search are active. IAM role assumption itself is outside the user-pool service and is not performed by this panel.",
  },
  appClients: {
    level: "Supported locally",
    description: "An app client represents an application that asks the user pool to authenticate users or issue tokens. Configure only the direct authentication flows, token lifetimes, refresh behavior, secrets, callback URLs, and OAuth grants that the application actually needs.",
    support: "Password, administrator-password, SRP and refresh flows, client secrets, token validity, revocation, refresh rotation, local managed-login OAuth, and exact callback validation are active. Secrets are write-only and are never redisplayed by the console.",
  },
  appClientDetails: {
    level: "Supported locally",
    description: "App client details identify the calling application and expose its authentication and token behavior. Edit OAuth settings to select callback and logout URLs, scopes, grant types, and identity providers; deleting a client also invalidates its refresh sessions.",
    support: "Client lifecycle, direct flows, token issuance, OAuth configuration, provider associations, revision-safe updates, and refresh-session revocation are active on local Cognito endpoints.",
  },
  domain: {
    level: "Supported locally",
    description: "A user-pool domain gives managed login and OAuth endpoints a stable base URL. Create one before using browser authorization flows or client-specific branding, and choose managed login version 2 for the current local login experience.",
    support: "Domain uniqueness, managed-login versions, discovery, authorize, token, logout, and local login routes are active. The domain is a local descriptor and does not provision DNS, CloudFront, ACM certificates, public TLS, or an AWS-hosted domain.",
  },
  identityProviders: {
    level: "Partial",
    description: "An external identity provider lets users sign in through another OpenID Connect or SAML system. Provider details establish trust, attribute mappings translate external claims into pool attributes, and identifiers help route users to the correct provider.",
    support: "OIDC discovery, signed SAML metadata and assertions, attribute mapping, client enablement, and connection tests are active. Loopback works by default; public HTTPS providers require STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true, while private, metadata, and link-local targets remain blocked.",
  },
  resourceServers: {
    level: "Supported locally",
    description: "A resource server represents an API protected by this user pool. Its identifier namespaces custom scopes such as api/read, which app clients can request and access tokens can carry for API authorization.",
    support: "Resource-server creation, deletion, scope validation, app-client scope selection, OAuth consent, and access-token scope claims are active locally.",
  },
  branding: {
    level: "Partial",
    description: "Managed-login branding customizes the sign-in page for a particular app client. Use it to give users recognizable application context while retaining the pool's authentication and federation behavior.",
    support: "The local version 2 login page applies a client-specific page title and six-digit primary color. Logos, images, advanced style tokens, and the broader AWS managed-login branding editor are not implemented.",
  },
  customAttributes: {
    level: "Supported locally",
    description: "Custom attributes extend the user schema with application-specific string, number, Boolean, or date-time values. Choose constraints and mutability carefully: the schema definition is permanent, and immutable values can be set only when a user is created.",
    support: "Schema creation, naming and type validation, string and number constraints, creation-time values, mutable updates, and token read or write attribute behavior are active. Custom attribute definitions cannot be removed after creation.",
  },
};

const cognitoPanelHelpTargets = [
  ['.card:has([data-filter-table])', "User pools", "userPools"],
  [".card", "Pool details", "poolDetails"],
  ['.card:has([data-action="create-user"])', "Users", "users"],
  ['.card:has([data-action="toggle-user"])', "User details", "userDetails"],
  ['.card:has([data-action="add-attribute"])', "Attributes", "attributes"],
  ['.card:has([data-action="edit-groups"])', "Groups and MFA", "groupsAndMfa"],
  ['.card:has([data-action="create-group"])', "Groups", "groups"],
  ['.card:has([data-action="create-app-client"])', "App clients", "appClients"],
  ['.card:has([data-action="edit-oauth"])', "App client details", "appClientDetails"],
  ['.card:has([data-action="configure-domain"])', "User-pool domain", "domain"],
  ['.card:has([data-action="create-identity-provider"])', "Social and external providers", "identityProviders"],
  ['.card:has([data-action="create-resource-server"])', "Resource servers", "resourceServers"],
  ['.card:has([data-action="configure-branding"])', "Managed-login branding", "branding"],
  ['.card:has([data-action="add-custom-attribute"])', "Custom attributes", "customAttributes"],
];

function decorateCognitoPanelHelp(root = document) {
  for (const [selector, title, helpKey] of cognitoPanelHelpTargets) {
    const heading = [...root.querySelectorAll(`${selector} > .card-header h2`)].find(candidate => {
      const text = candidate.textContent.trim();
      return text === title || text.startsWith(`${title} (`);
    });
    if (!heading || heading.closest(".panel-title-row")) continue;
    const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
    heading.outerHTML = panelHeading(title, cognitoPanelHelp[helpKey], meta);
  }
}

function badge(value, kind = "") {
  return `<span class="status-badge ${escapeHtml(kind)}">${escapeHtml(String(value).replaceAll("_", " "))}</span>`;
}

function userAttribute(user, name) {
  return values(user.attributes).find(attribute => attribute.name === name);
}

function userAttributeSchema(pool, name) {
  return values(pool.configuration?.attributeSchema).find(attribute => attribute.name === name);
}

function verifiableAttribute(name) {
  return name === "email" || name === "phone_number";
}

function attributeValueField(schema, value = "", options = {}) {
  const name = schema.name;
  const fieldName = options.fieldName || "value";
  const label = options.label || "Value";
  const required = options.required ?? true;
  if (schema.dataType === "Boolean") {
    return `<div class="field"><label>${escapeHtml(label)}</label><select name="${escapeHtml(fieldName)}" ${required ? "required" : ""}>${required ? "" : '<option value="">Not set</option>'}<option value="true" ${value === "true" ? "selected" : ""}>true</option><option value="false" ${value === "false" ? "selected" : ""}>false</option></select></div>`;
  }
  const type = name === "email" ? "email" : name === "phone_number" ? "tel" : schema.dataType === "Number" ? "number" : "text";
  const stringConstraints = schema.stringConstraints || {};
  const numberConstraints = schema.numberConstraints || {};
  const constraints = [
    stringConstraints.minLength == null ? "" : `minlength="${escapeHtml(stringConstraints.minLength)}"`,
    stringConstraints.maxLength == null ? "" : `maxlength="${escapeHtml(stringConstraints.maxLength)}"`,
    numberConstraints.minValue == null ? "" : `min="${escapeHtml(numberConstraints.minValue)}"`,
    numberConstraints.maxValue == null ? "" : `max="${escapeHtml(numberConstraints.maxValue)}"`,
    schema.dataType === "Number" ? 'step="any"' : "",
  ].filter(Boolean).join(" ");
  const hint = schema.dataType === "DateTime" ? '<span class="hint">Enter an ISO 8601 date-time value.</span>' : "";
  return `<div class="field"><label>${escapeHtml(label)}</label><input name="${escapeHtml(fieldName)}" type="${type}" ${required ? "required" : ""} ${constraints} value="${escapeHtml(value)}">${hint}</div>`;
}

function setChrome(context, crumbs) {
  context.setChrome("cognito", ["Cognito", ...crumbs]);
}

function poolTabs(poolId, active) {
  const root = `#/cognito/user-pools/${encoded(poolId)}`;
  return tabs([
    { label: "Overview", href: `${root}/overview`, active: active === "overview" },
    { label: "Users", href: `${root}/users`, active: active === "users" },
    { label: "Groups", href: `${root}/groups`, active: active === "groups" },
    { label: "App clients", href: `${root}/app-clients`, active: active === "app-clients" },
    { label: "Managed login", href: `${root}/managed-login`, active: active === "managed-login" },
    { label: "Sign-in", href: `${root}/sign-in`, active: active === "sign-in" },
    { label: "Self-service sign-up", href: `${root}/self-service-sign-up`, active: active === "self-service-sign-up" },
  ]);
}

async function loadPool(poolId) {
  return (await request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}`)).userPool;
}

function poolPage(context, pool, active, content, actions = "") {
  const label = {
    overview: "Overview",
    users: "Users",
    groups: "Groups",
    "app-clients": "App clients",
    "managed-login": "Managed login",
    "sign-in": "Sign-in",
    "self-service-sign-up": "Self-service sign-up",
  }[active] ?? active;
  setChrome(context, [
    "User pools",
    { label: pool.name, href: `#/cognito/user-pools/${encoded(pool.id)}/overview` },
    label,
  ]);
  context.main.innerHTML = `<div class="page-width cognito-page cognito-detail">${pageHeader(pool.name, pool.id, actions)}
    ${poolTabs(pool.id, active)}
    ${content}
  </div>`;
  decorateCognitoPanelHelp(context.main);
  requestAnimationFrame(() => {
    const navigation = document.querySelector(".cognito-detail > .tabs");
    const selected = navigation?.querySelector(".tab.active");
    if (navigation && selected) {
      navigation.scrollLeft = selected.offsetLeft - (navigation.clientWidth - selected.clientWidth) / 2;
    }
  });
}

function createPoolModal(context) {
  context.showModal("Create user pool", `<div class="alert info"><strong>Local Cognito user pool</strong><br>This form creates an Essentials pool with user administration, password/SRP authentication, groups, and local email confirmation. Advanced MFA and Lambda trigger settings can also be configured through the official SDK.</div>
    <div class="field"><label>Pool name</label><input name="name" required minlength="1" maxlength="128" pattern="[A-Za-z0-9_ +=,.@-]+" placeholder="local-users" autocomplete="off"></div>
    <div class="field-row"><div class="field"><label>Sign-in option</label><select name="signIn"><option value="username">Username</option><option value="email">Email address</option><option value="alias">Username with email alias</option></select></div><div class="field"><label>Minimum password length</label><input name="minimumLength" type="number" min="6" max="99" value="8" required></div></div>
    <div class="field-row"><div class="field"><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="selfSignUp" checked> Enable self-service sign-up</label><label class="checkbox-label"><input type="checkbox" name="autoVerify" checked> Automatically verify email by confirmation code</label><label class="checkbox-label"><input type="checkbox" name="requiredEmail" checked> Require email</label></div></div><div class="field"><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="caseSensitive" checked> Usernames are case sensitive</label><label class="checkbox-label"><input type="checkbox" name="deletionProtection"> Enable deletion protection</label></div></div></div>
    <fieldset class="cognito-fieldset"><legend>Password requirements</legend><div class="cognito-option-grid"><label class="checkbox-label"><input type="checkbox" name="uppercase" checked> Uppercase</label><label class="checkbox-label"><input type="checkbox" name="lowercase" checked> Lowercase</label><label class="checkbox-label"><input type="checkbox" name="numbers" checked> Numbers</label><label class="checkbox-label"><input type="checkbox" name="symbols" checked> Symbols</label></div></fieldset>
    <div class="alert info"><strong>Email delivery</strong><br>The console starts with the Cognito-default local sender. Configure a verified same-Region SES identity through the official API to use the DEVELOPER profile.</div>`, "Create user pool", async data => {
    const signIn = String(data.get("signIn"));
    const input = {
      PoolName: String(data.get("name") || "").trim(),
      Policies: {
        PasswordPolicy: {
          MinimumLength: Number(data.get("minimumLength")),
          RequireUppercase: data.get("uppercase") === "on",
          RequireLowercase: data.get("lowercase") === "on",
          RequireNumbers: data.get("numbers") === "on",
          RequireSymbols: data.get("symbols") === "on",
          TemporaryPasswordValidityDays: 7,
        },
      },
      DeletionProtection: data.get("deletionProtection") === "on" ? "ACTIVE" : "INACTIVE",
      AutoVerifiedAttributes: data.get("autoVerify") === "on" ? ["email"] : [],
      ...(signIn === "email" ? { UsernameAttributes: ["email"] } : {}),
      ...(signIn === "alias" ? { AliasAttributes: ["email"] } : {}),
      UsernameConfiguration: { CaseSensitive: data.get("caseSensitive") === "on" },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: data.get("selfSignUp") !== "on" },
      Schema: [{ Name: "email", Required: data.get("requiredEmail") === "on", Mutable: true }],
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] },
      EmailConfiguration: { EmailSendingAccount: "COGNITO_DEFAULT" },
      VerificationMessageTemplate: {
        DefaultEmailOption: "CONFIRM_WITH_CODE",
        EmailSubject: "Your verification code",
        EmailMessage: "Your verification code is {####}.",
      },
      UserPoolTier: "ESSENTIALS",
    };
    const result = await consoleMutation("/_stacksim/api/cognito/user-pools", "POST", input);
    context.toast("User pool created");
    location.hash = `#/cognito/user-pools/${encoded(result.userPool.id)}/overview`;
  }, true, { refreshAfterSubmit: false });
}

async function landing(context) {
  const { userPools } = await request("/_stacksim/api/cognito/user-pools");
  const users = userPools.reduce((total, pool) => total + Number(pool.userCount), 0);
  const clients = userPools.reduce((total, pool) => total + Number(pool.appClientCount), 0);
  setChrome(context, ["Overview"]);
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("Cognito", "Create local user directories, administer users and groups, confirm users through the SES Inbox, and issue signed Cognito-shaped JWTs.", '<button class="button primary" data-action="create-user-pool">Create user pool</button>')}
    <div class="alert info"><strong>User pools development profile</strong><br>Supports self-service and administrator-created users, recovery, password and SRP authentication, refresh rotation, groups, TOTP/email MFA, Lambda triggers, signed tokens, and local JWKS. Managed login, OAuth endpoints, federation, and Identity Pools are not currently available.</div>
    <div class="cognito-summary-grid">
      <section class="card"><div class="card-header"><h2>User pools</h2></div><div class="card-body"><div class="metric">${userPools.length}</div><p class="muted">Regional user directories</p><a href="#/cognito/user-pools">View user pools</a></div></section>
      <section class="card"><div class="card-header"><h2>Users</h2></div><div class="card-body"><div class="metric">${users}</div><p class="muted">Safe console summaries</p></div></section>
      <section class="card"><div class="card-header"><h2>App clients</h2></div><div class="card-body"><div class="metric">${clients}</div><p class="muted">Password and refresh clients</p></div></section>
    </div>
    <section class="card"><div class="card-header"><h2>Local integration</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Protocol</dt><dd>JSON 1.1</dd><dt>SDK</dt><dd>@aws-sdk/client-cognito-identity-provider</dd></dl><dl class="key-value"><dt>Confirmation delivery</dt><dd>Regional SES Inbox</dd><dt>External email</dt><dd>Never sent</dd></dl><dl class="key-value"><dt>Issuer</dt><dd>provider-compatible per pool</dd><dt>Public keys</dt><dd>Loopback JWKS tooling route</dd></dl></div></section>
  </div>`;
  document.querySelectorAll('[data-action="create-user-pool"]').forEach(button => button.addEventListener("click", () => createPoolModal(context)));
}

async function poolsPage(context) {
  const { userPools } = await request("/_stacksim/api/cognito/user-pools");
  setChrome(context, ["User pools"]);
  const rows = userPools.map(pool => `<tr data-search-row="${escapeHtml(`${pool.name} ${pool.id} ${pool.status}`.toLowerCase())}">
    <td><a href="#/cognito/user-pools/${encoded(pool.id)}/overview"><strong>${escapeHtml(pool.name)}</strong></a><div class="muted small mono">${escapeHtml(pool.id)}</div></td>
    <td>${badge(pool.status, "success")}</td><td>${pool.userCount}</td><td>${pool.appClientCount}</td><td>${formatDate(pool.createdAt)}</td><td>${Object.entries(pool.tags || {}).map(([key, value]) => badge(`${key}=${value}`)).join(" ") || "None"}</td>
  </tr>`).join("");
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("User pools", "Regional directories for application users.", '<button class="button refresh" data-action="refresh" aria-label="Refresh user pools" title="Refresh">↻</button><button class="button primary" data-action="create-user-pool">Create user pool</button>')}
    <section class="card"><div class="card-header"><h2>User pools <span class="muted">(${userPools.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find a user pool"></label></div><div class="table-wrap">${rows ? `<table class="cognito-pool-table"><thead><tr><th>Name</th><th>Status</th><th>Users</th><th>App clients</th><th>Created</th><th>Tags</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("C", "No user pools", "Create a user pool to start a local sign-up and password-login flow.", '<button class="button primary" data-action="create-user-pool">Create user pool</button>')}</div></section>
  </div>`;
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-user-pool"]').forEach(button => button.addEventListener("click", () => createPoolModal(context)));
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

async function overviewPage(context, poolId) {
  const pool = await loadPool(poolId);
  const jwksUrl = new URL(pool.localJwksPath, location.origin).href;
  const email = pool.configuration.email;
  poolPage(context, pool, "overview", `
    <div class="cognito-summary-grid">
      <section class="card"><div class="card-header"><h2>Users</h2></div><div class="card-body"><div class="metric">${pool.userCount}</div><a href="#/cognito/user-pools/${encoded(pool.id)}/users">View users</a></div></section>
      <section class="card"><div class="card-header"><h2>App clients</h2></div><div class="card-body"><div class="metric">${pool.appClientCount}</div><a href="#/cognito/user-pools/${encoded(pool.id)}/app-clients">View app clients</a></div></section>
      <section class="card"><div class="card-header"><h2>Messaging</h2></div><div class="card-body"><strong>${escapeHtml(email.sendingAccount)}</strong><p class="muted">Code-based email confirmation</p><a href="${escapeHtml(pool.inboxPath)}">Open filtered SES Inbox</a></div></section>
    </div>
    <section class="card"><div class="card-header"><h2>Pool details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Pool ID</dt><dd class="mono">${escapeHtml(pool.id)}</dd><dt>Status</dt><dd>${badge(pool.status, "success")}</dd><dt>Tier</dt><dd>${escapeHtml(pool.configuration.tier)}</dd></dl><dl class="key-value"><dt>ARN</dt><dd class="mono">${escapeHtml(pool.arn)}</dd><dt>Created</dt><dd>${formatDate(pool.createdAt)}</dd><dt>Updated</dt><dd>${formatDate(pool.updatedAt)}</dd></dl><dl class="key-value"><dt>Deletion protection</dt><dd>${escapeHtml(pool.configuration.deletionProtection)}</dd><dt>Tags</dt><dd>${escapeHtml(pool.boundaries.tags)}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Token issuer and public keys</h2></div><div class="card-body"><dl class="key-value"><dt>Canonical issuer</dt><dd class="mono cognito-wrap">${escapeHtml(pool.issuer)}</dd><dt>Local JWKS URL</dt><dd><span class="mono cognito-wrap">${escapeHtml(jwksUrl)}</span> <button class="button link" data-copy="${escapeHtml(jwksUrl)}">Copy</button></dd></dl><div class="alert info"><strong>Local verification route</strong><br>Tokens keep the provider-compatible issuer. The loopback JWKS URL is developer tooling and does not change the token issuer or contact public service endpoints.</div></div></section>
    <section class="card"><div class="card-header"><h2>Email confirmation</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Sending account</dt><dd>${escapeHtml(email.sendingAccount)}</dd><dt>Verification</dt><dd>${escapeHtml(email.verificationMethod)}</dd></dl><dl class="key-value"><dt>Subject</dt><dd>${escapeHtml(email.verificationSubject)}</dd><dt>From</dt><dd>${escapeHtml(email.from || "no-reply@verificationemail.com")}</dd></dl></div><div class="card-body"><a class="button" href="${escapeHtml(pool.inboxPath)}">Open Cognito confirmation messages</a></div></section>
  `, `<button class="button" data-action="configure-user-pool">Configure</button> <button class="button danger" data-action="delete-user-pool" ${pool.configuration.deletionProtection === "ACTIVE" ? 'disabled title="Disable deletion protection through the official API first"' : ""}>Delete</button>`);
  document.querySelector('[data-action="configure-user-pool"]')?.addEventListener("click", () => {
    const triggers = pool.configuration.lambdaTriggers || {};
    const tagText = typeof pool.boundaries.tags === "object"
      ? Object.entries(pool.boundaries.tags).map(([key, value]) => `${key}=${value}`).join("\n")
      : "";
    context.showModal("Configure user pool", `<fieldset class="cognito-fieldset"><legend>Multi-factor authentication</legend><div class="field-row"><div class="field"><label>MFA mode</label><select name="mfaMode"><option value="OFF" ${pool.configuration.mfa.mode === "OFF" ? "selected" : ""}>Off</option><option value="OPTIONAL" ${pool.configuration.mfa.mode === "OPTIONAL" ? "selected" : ""}>Optional</option><option value="ON" ${pool.configuration.mfa.mode === "ON" ? "selected" : ""}>Required</option></select></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="softwareMfa" ${pool.configuration.mfa.enabledMethods.includes("SOFTWARE_TOKEN_MFA") ? "checked" : ""}> Enable software-token MFA</label></div></div></fieldset>
      <fieldset class="cognito-fieldset"><legend>Lambda trigger ARNs</legend>${[
        ["PreSignUp", "Pre sign-up", "preSignUp"],
        ["CustomMessage", "Custom message", "customMessage"],
        ["PostConfirmation", "Post confirmation", "postConfirmation"],
        ["PreAuthentication", "Pre authentication", "preAuthentication"],
        ["PostAuthentication", "Post authentication", "postAuthentication"],
        ["PreTokenGeneration", "Pre token generation", "preTokenGeneration"],
      ].map(([name, label, key]) => `<div class="field"><label>${label}</label><input name="${name}" class="mono" value="${escapeHtml(triggers[key] || "")}" placeholder="arn:aws:lambda:region:account:function:name"></div>`).join("")}</fieldset>
      <div class="field"><label>Tags <span class="muted">(one key=value per line)</span></label><textarea name="tags" rows="4">${escapeHtml(tagText)}</textarea></div>
      <div class="alert info"><strong>Lambda permission required</strong><br>Add a function resource-policy permission for cognito-idp.amazonaws.com with this pool ARN as SourceArn. Trigger failures fail closed and never expose passwords or token material.</div>`, "Save configuration", async data => {
      const lambdaConfig = {};
      for (const key of ["PreSignUp", "CustomMessage", "PostConfirmation", "PreAuthentication", "PostAuthentication", "PreTokenGeneration"]) {
        const value = String(data.get(key) || "").trim();
        if (value) lambdaConfig[key] = value;
      }
      const tags = {};
      for (const line of String(data.get("tags") || "").split(/\r?\n/).filter(Boolean)) {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid tag line: ${line}`);
        tags[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}`, "PATCH", {
        mfaMode: String(data.get("mfaMode")),
        softwareTokenMfa: data.get("softwareMfa") === "on",
        lambdaConfig,
        tags,
      });
      context.toast("User pool configuration updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="delete-user-pool"]')?.addEventListener("click", () => context.confirmDeletion(pool.id, `Delete user pool ${pool.name}, its users, clients, refresh sessions, and delivery intents?`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}`, "DELETE", { confirmation: pool.id });
    context.toast("User pool deleted");
    location.hash = "#/cognito/user-pools";
  }));
}

async function usersPage(context, poolId) {
  const [pool, result] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/users`),
  ]);
  const rows = result.users.map(user => {
    const email = userAttribute(user, "email");
    return `<tr data-search-row="${escapeHtml(`${email?.value || ""} ${user.sub} ${user.status}`.toLowerCase())}"><td><a href="#/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}"><strong>${escapeHtml(email?.value || user.username)}</strong></a><div class="muted small mono">${escapeHtml(user.sub)}</div></td><td>${badge(user.status, user.status === "CONFIRMED" ? "success" : "")}</td><td>${user.enabled ? "Enabled" : "Disabled"}</td><td>${email?.verified ? badge("Verified", "success") : badge("Unverified")}</td><td>${formatDate(user.createdAt)}</td></tr>`;
  }).join("");
  poolPage(context, pool, "users", `<div class="alert info"><strong>Administrator user management</strong><br>Create a user with a temporary password and optionally deliver an invitation through the local SES Inbox.</div>
    <section class="card"><div class="card-header"><h2>Users <span class="muted">(${result.users.length})</span></h2><button class="button primary" data-action="create-user">Create user</button></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find a user"></label></div><div class="table-wrap">${rows ? `<table class="cognito-user-table"><thead><tr><th>User</th><th>Status</th><th>Access</th><th>Email</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("U", "No users", "Create an administrator-managed user or let an application call SignUp.", '<button class="button primary" data-action="create-user">Create user</button>')}</div></section>`);
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-user"]').forEach(button => button.addEventListener("click", () => {
    const emailSignIn = pool.configuration.signIn.usernameAttributes.includes("email");
    const creationAttributes = values(pool.configuration.attributeSchema).filter(attribute =>
      attribute.name !== "email" && !attribute.developerOnly
    );
    const creationFields = creationAttributes.map((attribute, index) => {
      const permanence = attribute.mutable
        ? "Can be edited after creation."
        : "Immutable: this value can only be supplied while creating the user.";
      const verification = verifiableAttribute(attribute.name)
        ? `<label class="checkbox-label"><input type="checkbox" name="attribute-verified-${index}"> Mark ${escapeHtml(attribute.name)} as verified</label>`
        : "";
      return `<div class="cognito-create-attribute">${attributeValueField(attribute, "", {
        fieldName: `attribute-${index}`,
        label: `${attribute.name}${attribute.required ? " (required)" : " (optional)"}`,
        required: attribute.required,
      })}<span class="hint">${escapeHtml(`${attribute.dataType}. ${permanence}`)}</span>${verification}</div>`;
    }).join("");
    context.showModal("Create user", `<div class="alert info"><strong>Temporary-password invitation</strong><br>When invitation delivery is enabled, Cognito captures the welcome email in the local SES Inbox. The temporary password is never displayed by this console.</div>
      <div class="field"><label>${emailSignIn ? "Email address" : "Username"}</label><input name="username" required maxlength="128" autocomplete="off" placeholder="${emailSignIn ? "user@example.test" : "user-name"}"></div>
      ${emailSignIn ? "" : '<div class="field"><label>Email address</label><input name="email" type="email" required autocomplete="off" placeholder="user@example.test"></div>'}
      <div class="field"><label>Temporary password <span class="muted">(optional)</span></label><input name="temporaryPassword" type="password" autocomplete="new-password" placeholder="Generate a compliant password"></div>
      <div class="field"><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="emailVerified" checked> Mark email as verified</label><label class="checkbox-label"><input type="checkbox" name="sendInvitation" checked> Send invitation to the SES Inbox</label></div></div>
      ${creationFields ? `<fieldset class="cognito-fieldset"><legend>Pool-defined attributes</legend><div class="alert info"><strong>Creation-time values</strong><br>Immutable custom attributes cannot be added or changed after this user is created.</div>${creationFields}</fieldset>` : ""}`, "Create user", async data => {
      const username = String(data.get("username") || "").trim();
      const email = emailSignIn ? username : String(data.get("email") || "").trim();
      const temporaryPassword = String(data.get("temporaryPassword") || "");
      const userAttributes = [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: data.get("emailVerified") === "on" ? "true" : "false" },
      ];
      creationAttributes.forEach((attribute, index) => {
        const value = String(data.get(`attribute-${index}`) || "");
        if (!value) return;
        userAttributes.push({ Name: attribute.name, Value: value });
        if (verifiableAttribute(attribute.name)) {
          userAttributes.push({
            Name: `${attribute.name}_verified`,
            Value: data.get(`attribute-verified-${index}`) === "on" ? "true" : "false",
          });
        }
      });
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users`, "POST", {
        Username: username,
        UserAttributes: userAttributes,
        ...(temporaryPassword ? { TemporaryPassword: temporaryPassword } : {}),
        ...(data.get("sendInvitation") === "on" ? {} : { MessageAction: "SUPPRESS" }),
        DesiredDeliveryMediums: ["EMAIL"],
      });
      context.toast("User created");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  }));
}

async function groupsPage(context, poolId) {
  const [pool, result] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/groups`),
  ]);
  const rows = result.groups.map(group => `<tr data-search-row="${escapeHtml(`${group.name} ${group.description || ""} ${group.roleArn || ""}`.toLowerCase())}"><td><strong>${escapeHtml(group.name)}</strong></td><td>${escapeHtml(group.description || "—")}</td><td>${group.precedence ?? "—"}</td><td class="mono">${escapeHtml(group.roleArn || "—")}</td><td>${group.memberCount}</td><td><button class="button danger" data-delete-group="${escapeHtml(group.name)}">Delete</button></td></tr>`).join("");
  poolPage(context, pool, "groups", `<section class="card"><div class="card-header"><h2>Groups <span class="muted">(${result.groups.length})</span></h2><button class="button primary" data-action="create-group">Create group</button></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find a group"></label></div><div class="table-wrap">${rows ? `<table><thead><tr><th>Name</th><th>Description</th><th>Precedence</th><th>IAM role</th><th>Members</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("G", "No groups", "Create a group to add group and role claims to newly issued tokens.", '<button class="button primary" data-action="create-group">Create group</button>')}</div></section>
    <div class="alert info"><strong>Token timing</strong><br>Group changes appear in newly issued ID and access tokens; existing tokens are not rewritten.</div>`);
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-group"]').forEach(button => button.addEventListener("click", () => {
    context.showModal("Create group", `<div class="field"><label>Group name</label><input name="name" required maxlength="128" autocomplete="off"></div><div class="field"><label>Description</label><input name="description" maxlength="2048"></div><div class="field-row"><div class="field"><label>Precedence <span class="muted">(optional)</span></label><input name="precedence" type="number" min="0"></div><div class="field"><label>IAM role ARN <span class="muted">(optional)</span></label><input name="roleArn" class="mono"></div></div>`, "Create group", async data => {
      const precedence = String(data.get("precedence") || "");
      const roleArn = String(data.get("roleArn") || "").trim();
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/groups`, "POST", {
        GroupName: String(data.get("name") || "").trim(),
        ...(String(data.get("description") || "") ? { Description: String(data.get("description")) } : {}),
        ...(precedence ? { Precedence: Number(precedence) } : {}),
        ...(roleArn ? { RoleArn: roleArn } : {}),
      });
      context.toast("Group created");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  }));
  document.querySelectorAll("[data-delete-group]").forEach(button => button.addEventListener("click", () => {
    const name = button.dataset.deleteGroup;
    context.confirmDeletion(name, `Delete group ${name}? Memberships will be removed.`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/groups/${encoded(name)}`, "DELETE", { confirmation: name });
      context.toast("Group deleted");
      await context.route();
    });
  }));
}

async function userDetailPage(context, poolId, sub) {
  const [pool, result, groupResult] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/users/${encoded(sub)}`),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/groups`),
  ]);
  const user = result.user;
  const presentNames = new Set(values(user.attributes).map(attribute => attribute.name));
  const addableAttributes = values(pool.configuration.attributeSchema).filter(attribute =>
    !presentNames.has(attribute.name) && attribute.mutable && !attribute.developerOnly
  );
  const attributes = values(user.attributes).map(attribute => {
    const schema = userAttributeSchema(pool, attribute.name);
    const editable = schema?.mutable && !schema.developerOnly;
    const removable = editable && !schema.required;
    const actions = schema
      ? `<div class="actions">${editable ? `<button class="button" data-edit-attribute="${escapeHtml(attribute.name)}">Edit</button>` : '<span class="muted small">Immutable</span>'}${removable ? `<button class="button danger" data-remove-attribute="${escapeHtml(attribute.name)}">Remove</button>` : ""}</div>`
      : '<span class="muted small">Unavailable</span>';
    const verification = verifiableAttribute(attribute.name)
      ? attribute.verified ? badge("Verified", "success") : badge("Unverified")
      : '<span class="muted">—</span>';
    return `<tr><td class="mono">${escapeHtml(attribute.name)}</td><td>${escapeHtml(attribute.value)}</td><td>${verification}</td><td>${actions}</td></tr>`;
  }).join("");
  poolPage(context, pool, "users", `<p><a href="#/cognito/user-pools/${encoded(pool.id)}/users">← Back to users</a></p>
    <section class="card"><div class="card-header"><h2>User details</h2><div><button class="button" data-action="toggle-user">${user.enabled ? "Disable" : "Enable"}</button> <button class="button" data-action="set-password">Set password</button> <button class="button" data-action="reset-password">Reset password</button> <button class="button" data-action="sign-out">Sign out</button> <button class="button danger" data-action="delete-user">Delete</button></div></div><div class="card-body detail-grid"><dl class="key-value"><dt>Status</dt><dd>${badge(user.status, user.status === "CONFIRMED" ? "success" : "")}</dd><dt>Enabled</dt><dd>${user.enabled ? "Yes" : "No"}</dd><dt>Active sessions</dt><dd>${user.sessionCount}</dd></dl><dl class="key-value"><dt>Sub</dt><dd class="mono">${escapeHtml(user.sub)}</dd><dt>Username</dt><dd class="mono">${escapeHtml(user.username)}</dd></dl><dl class="key-value"><dt>Created</dt><dd>${formatDate(user.createdAt)}</dd><dt>Updated</dt><dd>${formatDate(user.updatedAt)}</dd></dl></div></section>
    <section class="card"><div class="card-header"><div><h2>Attributes</h2><p class="muted small">Add and manage pool-defined user attributes through Cognito administrator operations.</p></div><button class="button primary" data-action="add-attribute" ${addableAttributes.length ? "" : 'disabled title="No assignable attributes are available"'}>Add attribute</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Value</th><th>Verification</th><th>Actions</th></tr></thead><tbody>${attributes}</tbody></table></div></section>
    <section class="card"><div class="card-header"><h2>Groups and MFA</h2><div><button class="button" data-action="edit-groups">Edit groups</button> <button class="button" data-action="edit-mfa">Edit email MFA</button></div></div><div class="card-body detail-grid"><dl class="key-value"><dt>Groups</dt><dd>${user.groups.length ? user.groups.map(escapeHtml).join(", ") : "None"}</dd></dl><dl class="key-value"><dt>MFA methods</dt><dd>${user.mfa.enabled.length ? user.mfa.enabled.map(escapeHtml).join(", ") : "None"}</dd><dt>Preferred</dt><dd>${escapeHtml(user.mfa.preferred || "None")}</dd></dl></div></section>`);
  document.querySelector('[data-action="toggle-user"]')?.addEventListener("click", async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", {
      action: user.enabled ? "disable" : "enable",
    });
    context.toast(user.enabled ? "User disabled" : "User enabled");
    await context.route();
  });
  document.querySelector('[data-action="set-password"]')?.addEventListener("click", () => {
    context.showModal("Set user password", `<div class="field"><label>New password</label><input name="password" type="password" required autocomplete="new-password"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="permanent" checked> Set as permanent password</label><span class="hint">Clear this option to require a password change at next sign-in.</span></div>`, "Set password", async data => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", {
        action: "set-password",
        password: String(data.get("password") || ""),
        permanent: data.get("permanent") === "on",
      });
      context.toast("Password updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="reset-password"]')?.addEventListener("click", async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", { action: "reset-password" });
    context.toast("Password reset code sent to the SES Inbox");
    await context.route();
  });
  document.querySelector('[data-action="sign-out"]')?.addEventListener("click", async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", { action: "sign-out" });
    context.toast("User sessions revoked");
    await context.route();
  });
  const updateAttribute = async (name, value, verified) => {
    const mutation = [{ Name: name, Value: value }];
    if (verifiableAttribute(name)) mutation.push({ Name: `${name}_verified`, Value: verified ? "true" : "false" });
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", {
      action: "attributes",
      attributes: mutation,
    });
  };
  document.querySelector('[data-action="add-attribute"]')?.addEventListener("click", () => {
    const options = addableAttributes.map(attribute => `<option value="${escapeHtml(attribute.name)}">${escapeHtml(attribute.name)} · ${escapeHtml(attribute.dataType)}</option>`).join("");
    context.showModal("Add user attribute", `<div class="field"><label>Attribute</label><select name="attribute" id="cognito-add-attribute" required>${options}</select><span class="hint">Only mutable attributes defined by this user pool are available.</span></div><div class="field"><label>Value</label><input name="value" required maxlength="2048"></div><div class="field" data-attribute-verification hidden><label class="checkbox-label"><input type="checkbox" name="verified"> Mark attribute as verified</label><span class="hint">Administrator verification is available only for email and phone number.</span></div>`, "Add attribute", async data => {
      const name = String(data.get("attribute"));
      await updateAttribute(name, String(data.get("value") || "").trim(), data.get("verified") === "on");
      context.toast("Attribute added");
      await context.route();
    }, true, { refreshAfterSubmit: false });
    const selector = document.querySelector("#cognito-add-attribute");
    const verification = document.querySelector("[data-attribute-verification]");
    const syncVerification = () => { if (verification) verification.hidden = !verifiableAttribute(selector?.value); };
    selector?.addEventListener("change", syncVerification);
    syncVerification();
  });
  document.querySelectorAll("[data-edit-attribute]").forEach(button => button.addEventListener("click", () => {
    const name = button.dataset.editAttribute;
    const attribute = userAttribute(user, name);
    const schema = userAttributeSchema(pool, name);
    if (!attribute || !schema?.mutable || schema.developerOnly) return;
    const verification = verifiableAttribute(name)
      ? `<div class="field"><label class="checkbox-label"><input type="checkbox" name="verified" ${attribute.verified ? "checked" : ""}> Mark ${escapeHtml(name)} as verified</label></div>`
      : "";
    context.showModal(`Edit ${name}`, `<div class="alert info"><strong>${escapeHtml(name)}</strong><br>${schema.required ? "Required" : "Optional"} ${escapeHtml(schema.dataType)} attribute.</div>${attributeValueField(schema, attribute.value)}${verification}`, "Save attribute", async data => {
      await updateAttribute(name, String(data.get("value") || "").trim(), data.get("verified") === "on");
      context.toast("Attribute updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  }));
  document.querySelectorAll("[data-remove-attribute]").forEach(button => button.addEventListener("click", () => {
    const name = button.dataset.removeAttribute;
    const schema = userAttributeSchema(pool, name);
    if (!schema?.mutable || schema.required || schema.developerOnly) return;
    context.confirmDeletion(name, `Remove ${name} from this user? The pool schema is unchanged.`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", {
        action: "delete-attributes",
        attributeNames: [name],
      });
      context.toast("Attribute removed");
      await context.route();
    });
  }));
  document.querySelector('[data-action="edit-groups"]')?.addEventListener("click", () => {
    context.showModal("Edit group memberships", `<div class="cognito-checkbox-stack">${groupResult.groups.map(group => `<label class="checkbox-label"><input type="checkbox" name="groups" value="${escapeHtml(group.name)}" ${user.groups.includes(group.name) ? "checked" : ""}> ${escapeHtml(group.name)}</label>`).join("") || '<span class="muted">Create a group first.</span>'}</div>`, "Save memberships", async data => {
      const selected = values(data.getAll("groups")).map(String);
      for (const group of groupResult.groups) {
        const member = selected.includes(group.name);
        if (member !== user.groups.includes(group.name)) {
          await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", { action: "group", group: group.name, member });
        }
      }
      context.toast("Group memberships updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="edit-mfa"]')?.addEventListener("click", () => {
    const enabled = user.mfa.enabled.includes("EMAIL_OTP");
    context.showModal("Edit email MFA", `<div class="alert info">Email MFA requires EMAIL_OTP enabled on an eligible pool and a verified user email.</div><div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" ${enabled ? "checked" : ""}> Enable email OTP</label></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="preferred" ${user.mfa.preferred === "EMAIL_OTP" ? "checked" : ""}> Prefer email OTP</label></div>`, "Save MFA", async data => {
      const emailEnabled = data.get("enabled") === "on";
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", { action: "mfa", emailEnabled, emailPreferred: emailEnabled && data.get("preferred") === "on" });
      context.toast("MFA settings updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="delete-user"]')?.addEventListener("click", () => context.confirmDeletion(user.sub, `Delete user ${user.username}?`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "DELETE", { confirmation: user.sub });
    context.toast("User deleted");
    location.hash = `#/cognito/user-pools/${encoded(pool.id)}/users`;
  }));
}

function createAppClientModal(context, pool) {
  context.showModal("Create app client", `<div class="alert info"><strong>Direct and hosted authentication</strong><br>Enable direct SDK flows and, when needed, exact loopback callback URLs for managed login.</div>
    <div class="field"><label>App client name</label><input name="name" required minlength="1" maxlength="128" pattern="[A-Za-z0-9_ +=,.@-]+" placeholder="local-web" autocomplete="off"></div>
    <fieldset class="cognito-fieldset"><legend>Authentication flows</legend><div class="cognito-option-grid"><label class="checkbox-label"><input type="checkbox" name="passwordFlow" checked> ALLOW_USER_PASSWORD_AUTH</label><label class="checkbox-label"><input type="checkbox" name="adminPasswordFlow"> ALLOW_ADMIN_USER_PASSWORD_AUTH</label><label class="checkbox-label"><input type="checkbox" name="srpFlow"> ALLOW_USER_SRP_AUTH</label><label class="checkbox-label"><input type="checkbox" name="refreshFlow" checked> ALLOW_REFRESH_TOKEN_AUTH</label></div></fieldset>
    <div class="field-row"><div class="field"><label>Access token validity (hours)</label><input name="accessValidity" type="number" min="1" max="24" value="1" required></div><div class="field"><label>ID token validity (hours)</label><input name="idValidity" type="number" min="1" max="24" value="1" required></div></div>
    <div class="field"><label>Refresh token validity (days)</label><input name="refreshValidity" type="number" min="1" max="3650" value="30" required></div>
    <div class="field"><label class="checkbox-label"><input type="checkbox" name="generateSecret"> Generate a client secret</label><span class="hint">The console records only that a secret exists. It never displays or permanently reveals the value.</span></div>
    <div class="field"><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="suppressExistence" checked> Prevent user-existence errors</label><label class="checkbox-label"><input type="checkbox" name="revocation" checked> Enable token revocation</label><label class="checkbox-label"><input type="checkbox" name="rotation"> Enable refresh-token rotation</label></div></div>
    <fieldset class="cognito-fieldset"><legend>Managed login and OAuth</legend><label class="checkbox-label"><input type="checkbox" name="oauthEnabled"> Enable managed-login OAuth</label><div class="field"><label>Callback URLs</label><textarea name="callbackUrls" rows="2" placeholder="http://127.0.0.1:3000/callback"></textarea><span class="hint">One exact HTTP(S) URL per line.</span></div><div class="field"><label>Logout URLs</label><textarea name="logoutUrls" rows="2" placeholder="http://127.0.0.1:3000/signed-out"></textarea></div><div class="field"><label>Allowed scopes</label><input name="oauthScopes" value="openid email profile" placeholder="openid email api/read"></div><div class="cognito-option-grid"><label class="checkbox-label"><input type="checkbox" name="codeFlow" checked> Authorization code + PKCE</label><label class="checkbox-label"><input type="checkbox" name="implicitFlow"> Implicit compatibility grant</label></div></fieldset>`, "Create app client", async data => {
    const flows = [];
    if (data.get("passwordFlow") === "on") flows.push("ALLOW_USER_PASSWORD_AUTH");
    if (data.get("adminPasswordFlow") === "on") flows.push("ALLOW_ADMIN_USER_PASSWORD_AUTH");
    if (data.get("srpFlow") === "on") flows.push("ALLOW_USER_SRP_AUTH");
    if (data.get("refreshFlow") === "on") flows.push("ALLOW_REFRESH_TOKEN_AUTH");
    const rotation = data.get("rotation") === "on";
    if (rotation) {
      const index = flows.indexOf("ALLOW_REFRESH_TOKEN_AUTH");
      if (index >= 0) flows.splice(index, 1);
    }
    const callbackUrls = String(data.get("callbackUrls") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const logoutUrls = String(data.get("logoutUrls") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const oauthEnabled = data.get("oauthEnabled") === "on";
    const oauthFlows = [];
    if (data.get("codeFlow") === "on") oauthFlows.push("code");
    if (data.get("implicitFlow") === "on") oauthFlows.push("implicit");
    const result = await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/app-clients`, "POST", {
      ClientName: String(data.get("name") || "").trim(),
      GenerateSecret: data.get("generateSecret") === "on",
      ExplicitAuthFlows: flows,
      AccessTokenValidity: Number(data.get("accessValidity")),
      IdTokenValidity: Number(data.get("idValidity")),
      RefreshTokenValidity: Number(data.get("refreshValidity")),
      TokenValidityUnits: { AccessToken: "hours", IdToken: "hours", RefreshToken: "days" },
      PreventUserExistenceErrors: data.get("suppressExistence") === "on" ? "ENABLED" : "LEGACY",
      EnableTokenRevocation: data.get("revocation") === "on",
      RefreshTokenRotation: {
        Feature: rotation ? "ENABLED" : "DISABLED",
        RetryGracePeriodSeconds: rotation ? 10 : 0,
      },
      ReadAttributes: ["email"],
      WriteAttributes: ["email"],
      SupportedIdentityProviders: ["COGNITO"],
      CallbackURLs: oauthEnabled ? callbackUrls : [],
      LogoutURLs: oauthEnabled ? logoutUrls : [],
      DefaultRedirectURI: oauthEnabled ? callbackUrls[0] : undefined,
      AllowedOAuthFlowsUserPoolClient: oauthEnabled,
      AllowedOAuthFlows: oauthEnabled ? oauthFlows : [],
      AllowedOAuthScopes: oauthEnabled ? String(data.get("oauthScopes") || "").split(/\s+/).filter(Boolean) : [],
    });
    context.toast("App client created");
    location.hash = `#/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(result.appClient.id)}`;
  }, true, { refreshAfterSubmit: false });
}

async function appClientsPage(context, poolId) {
  const [pool, result] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients`),
  ]);
  const rows = result.appClients.map(client => `<tr data-search-row="${escapeHtml(`${client.name} ${client.id} ${client.enabledAuthFlows.join(" ")}`.toLowerCase())}"><td><a href="#/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.id)}"><strong>${escapeHtml(client.name)}</strong></a><div class="muted small mono">${escapeHtml(client.id)}</div></td><td>${client.enabledAuthFlows.map(flow => badge(flow)).join(" ") || "No direct flow"}</td><td>${client.hasSecret ? "•••••••• (exists)" : "No secret"}</td><td>${formatDate(client.createdAt)}</td></tr>`).join("");
  poolPage(context, pool, "app-clients", `<section class="card"><div class="card-header"><h2>App clients <span class="muted">(${result.appClients.length})</span></h2><button class="button primary" data-action="create-app-client">Create app client</button></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find an app client"></label></div><div class="table-wrap">${rows ? `<table class="cognito-client-table"><thead><tr><th>Name</th><th>Authentication flows</th><th>Client secret</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("A", "No app clients", "Create an app client before an application signs up or authenticates users.", '<button class="button primary" data-action="create-app-client">Create app client</button>')}</div></section>
    <div class="alert info"><strong>OAuth and managed login</strong><br>Create browser or machine clients here, then configure the user-pool domain, resource servers, and branding on the Managed login tab.</div>`);
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-app-client"]').forEach(button => button.addEventListener("click", () => createAppClientModal(context, pool)));
}

async function appClientDetailPage(context, poolId, clientId) {
  const [pool, result, oauth] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients/${encoded(clientId)}`),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/oauth`),
  ]);
  const client = result.appClient;
  const validityRows = Object.entries(client.validity).map(([token, validity]) => `<tr><td>${escapeHtml(token.replace(/([A-Z])/g, " $1").replace(/^\w/, character => character.toUpperCase()))}</td><td>${validity.value} ${escapeHtml(validity.unit)}</td></tr>`).join("");
  poolPage(context, pool, "app-clients", `<p><a href="#/cognito/user-pools/${encoded(pool.id)}/app-clients">← Back to app clients</a></p>
    <section class="card"><div class="card-header"><h2>App client details</h2><div class="actions"><button class="button" data-action="edit-oauth">Edit OAuth settings</button><button class="button danger" data-action="delete-app-client">Delete</button></div></div><div class="card-body detail-grid"><dl class="key-value"><dt>Client name</dt><dd>${escapeHtml(client.name)}</dd><dt>Client ID</dt><dd class="mono">${escapeHtml(client.id)}</dd><dt>Client secret</dt><dd>${client.hasSecret ? "•••••••• (exists; never revealed here)" : "No client secret"}</dd></dl><dl class="key-value"><dt>User-existence errors</dt><dd>${escapeHtml(client.preventUserExistenceErrors)}</dd><dt>Token revocation</dt><dd>${client.enableTokenRevocation ? "Enabled" : "Disabled"}</dd><dt>Created</dt><dd>${formatDate(client.createdAt)}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Authentication flows</h2></div><div class="card-body">${client.enabledAuthFlows.map(flow => badge(flow, "success")).join(" ") || '<span class="muted">No direct authentication flow enabled.</span>'}</div></section>
    <section class="card"><div class="card-header"><h2>Token validity</h2></div><div class="table-wrap"><table><thead><tr><th>Token</th><th>Validity</th></tr></thead><tbody>${validityRows}</tbody></table></div></section>
    <section class="card"><div class="card-header"><h2>Hosted authentication</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>OAuth</dt><dd>${client.allowedOAuthFlowsUserPoolClient ? badge("Enabled", "success") : badge("Disabled")}</dd><dt>OAuth grants</dt><dd>${client.allowedOAuthFlows.map(flow => badge(flow)).join(" ") || "None"}</dd><dt>Providers</dt><dd>${client.supportedIdentityProviders.map(escapeHtml).join(", ") || "None"}</dd></dl><dl class="key-value"><dt>Callback URLs</dt><dd>${client.callbackUrls.map(value => `<div class="mono cognito-wrap">${escapeHtml(value)}</div>`).join("") || "None"}</dd><dt>Logout URLs</dt><dd>${client.logoutUrls.map(value => `<div class="mono cognito-wrap">${escapeHtml(value)}</div>`).join("") || "None"}</dd></dl></div><div class="card-body"><strong>Allowed scopes</strong><p>${client.allowedOAuthScopes.map(scope => badge(scope, "success")).join(" ") || '<span class="muted">None</span>'}</p></div></section>`);
  document.querySelector('[data-action="edit-oauth"]')?.addEventListener("click", () => {
    const identityProviders = oauth.identityProviders || [];
    const providerOptions = ["COGNITO", ...identityProviders.map(provider => provider.name)]
      .map(provider => `<label class="checkbox-label"><input type="checkbox" name="provider:${escapeHtml(provider)}" ${client.supportedIdentityProviders.includes(provider) ? "checked" : ""}> ${escapeHtml(provider)}</label>`)
      .join("");
    context.showModal("Edit OAuth settings", `<label class="checkbox-label"><input type="checkbox" name="enabled" ${client.allowedOAuthFlowsUserPoolClient ? "checked" : ""}> Enable managed-login OAuth</label><div class="field"><label>Callback URLs</label><textarea name="callbackUrls" rows="3">${escapeHtml(client.callbackUrls.join("\n"))}</textarea></div><div class="field"><label>Logout URLs</label><textarea name="logoutUrls" rows="3">${escapeHtml(client.logoutUrls.join("\n"))}</textarea></div><div class="field"><label>Allowed scopes</label><input name="scopes" value="${escapeHtml(client.allowedOAuthScopes.join(" "))}"></div><fieldset class="cognito-fieldset"><legend>Identity providers</legend><div class="cognito-checkbox-stack">${providerOptions}</div></fieldset><div class="cognito-option-grid"><label class="checkbox-label"><input type="checkbox" name="code" ${client.allowedOAuthFlows.includes("code") ? "checked" : ""}> Authorization code + PKCE</label><label class="checkbox-label"><input type="checkbox" name="implicit" ${client.allowedOAuthFlows.includes("implicit") ? "checked" : ""}> Implicit</label><label class="checkbox-label"><input type="checkbox" name="clientCredentials" ${client.allowedOAuthFlows.includes("client_credentials") ? "checked" : ""}> Client credentials</label></div>`, "Save OAuth settings", async data => {
      const callbackUrls = String(data.get("callbackUrls") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const allowedOAuthFlows = ["code", "implicit", "client_credentials"].filter(flow => data.get(flow === "client_credentials" ? "clientCredentials" : flow) === "on");
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.id)}`, "PATCH", {
        callbackUrls,
        logoutUrls: String(data.get("logoutUrls") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        defaultRedirectUri: callbackUrls[0],
        allowedOAuthFlows,
        allowedOAuthScopes: String(data.get("scopes") || "").split(/\s+/).filter(Boolean),
        allowedOAuthFlowsUserPoolClient: data.get("enabled") === "on",
        supportedIdentityProviders: ["COGNITO", ...identityProviders.map(provider => provider.name)]
          .filter(provider => data.get(`provider:${provider}`) === "on"),
      });
      context.toast("OAuth settings saved");
      await appClientDetailPage(context, pool.id, client.id);
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="delete-app-client"]')?.addEventListener("click", () => context.confirmDeletion(client.id, `Delete app client ${client.name} and revoke its refresh sessions?`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.id)}`, "DELETE", { confirmation: client.id });
    context.toast("App client deleted");
    location.hash = `#/cognito/user-pools/${encoded(pool.id)}/app-clients`;
  }));
}

async function managedLoginPage(context, poolId) {
  const [pool, oauth, clients] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/oauth`),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients`),
  ]);
  const discoveryUrl = `${location.origin}${oauth.discoveryPath}`;
  const jwksUrl = `${location.origin}${oauth.jwksPath}`;
  const resourceRows = oauth.resourceServers.map(resource => `<tr><td><strong>${escapeHtml(resource.name)}</strong><div class="mono muted small">${escapeHtml(resource.identifier)}</div></td><td>${resource.scopes.map(scope => badge(scope.fullName, "success")).join(" ") || "None"}</td><td><button class="button danger" data-delete-resource="${escapeHtml(resource.identifier)}">Delete</button></td></tr>`).join("");
  const identityProviders = oauth.identityProviders || [];
  const providerRows = identityProviders.map(provider => `<tr><td><strong>${escapeHtml(provider.name)}</strong><div>${badge(provider.type, "success")}</div></td><td>${provider.idpIdentifiers.map(identifier => badge(identifier)).join(" ") || "None"}</td><td><div>${Object.entries(provider.attributeMapping).map(([target, source]) => `<span class="mono small">${escapeHtml(target)} ← ${escapeHtml(source)}</span>`).join("<br>") || "None"}</div>${provider.certificateFingerprint ? `<div class="mono muted small">SHA-256 ${escapeHtml(provider.certificateFingerprint)}</div>` : ""}</td><td>${provider.enabledClientIds.length}</td><td><div class="actions"><button class="button" data-test-provider="${escapeHtml(provider.name)}">Test</button><button class="button" data-edit-provider="${escapeHtml(provider.name)}">Edit</button><button class="button danger" data-delete-provider="${escapeHtml(provider.name)}">Delete</button></div></td></tr>`).join("");
  poolPage(context, pool, "managed-login", `<section class="card"><div class="card-header"><div><h2>User-pool domain</h2><p class="muted small">Local descriptor only; it does not create DNS, CloudFront, ACM, or public TLS.</p></div><div class="actions"><button class="button" data-action="configure-domain">${oauth.domain ? "Update" : "Create"} domain</button>${oauth.domain ? `<a class="button primary" target="_blank" rel="noopener noreferrer" href="${escapeHtml(oauth.domain.baseUrl)}">Open managed login</a><button class="button danger" data-action="delete-domain">Delete</button>` : ""}</div></div><div class="card-body">${oauth.domain ? `<dl class="key-value"><dt>Domain prefix</dt><dd class="mono">${escapeHtml(oauth.domain.name)}</dd><dt>Managed login version</dt><dd>${oauth.domain.managedLoginVersion}</dd><dt>Local domain base</dt><dd class="mono cognito-wrap">${escapeHtml(oauth.domain.baseUrl)}</dd></dl>` : '<p class="muted">No managed-login domain configured.</p>'}</div></section>
    <section class="card"><div class="card-header"><h2>Issuer and local tooling aliases</h2></div><div class="card-body"><dl class="key-value"><dt>Canonical issuer</dt><dd class="mono cognito-wrap">${escapeHtml(oauth.issuer)}</dd><dt>Discovery URL</dt><dd class="mono cognito-wrap">${escapeHtml(discoveryUrl)}</dd><dt>JWKS URL</dt><dd class="mono cognito-wrap">${escapeHtml(jwksUrl)}</dd></dl><div class="alert info"><strong>Issuer stays provider-compatible</strong><br>Discovery and JWKS use loopback tooling aliases. Managed-login endpoints are distinct and never replace the token issuer.</div></div></section>
    <section class="card"><div class="card-header"><div><h2>Social and external providers <span class="muted">(${identityProviders.length})</span></h2><p class="muted small">OIDC and signed SAML federation. Client secrets are write-only and certificates display fingerprints only.</p></div><button class="button primary" data-action="create-identity-provider">Create provider</button></div><div class="table-wrap">${providerRows ? `<table><thead><tr><th>Provider</th><th>Identifiers</th><th>Mappings and trust</th><th>Enabled clients</th><th>Actions</th></tr></thead><tbody>${providerRows}</tbody></table>` : emptyState("I", "No external providers", "Create a standards-compatible OIDC or SAML provider. Loopback providers work by default; public network access remains startup-controlled.")}</div><div class="alert info"><strong>Network boundary</strong><br>Loopback providers work by default. Private-network providers are blocked. Public providers require STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true and HTTPS. Metadata and link-local targets are always blocked.</div></section>
    <section class="card"><div class="card-header"><div><h2>Resource servers <span class="muted">(${oauth.resourceServers.length})</span></h2><p class="muted small">Custom scopes are emitted as identifier/scope-name.</p></div><button class="button primary" data-action="create-resource-server">Create resource server</button></div><div class="table-wrap">${resourceRows ? `<table><thead><tr><th>Resource server</th><th>Scopes</th><th>Actions</th></tr></thead><tbody>${resourceRows}</tbody></table>` : emptyState("R", "No resource servers", "Create one to issue custom API scopes.")}</div></section>
    <section class="card"><div class="card-header"><h2>Managed-login branding</h2><button class="button" data-action="configure-branding" ${oauth.domain?.managedLoginVersion === 2 ? "" : "disabled"}>Configure branding</button></div><div class="card-body"><p>Only the page title and six-digit primary color are accepted because those are the properties rendered by the local login page.</p>${oauth.branding.map(value => `<p><strong>${escapeHtml(clients.appClients.find(client => client.id === value.clientId)?.name || value.clientId)}</strong> · ${escapeHtml(value.settings?.pageTitle || "Cognito defaults")} · <span class="mono">${escapeHtml(value.settings?.primaryColor || "default color")}</span></p>`).join("") || '<p class="muted">No client-specific branding.</p>'}</div></section>`);
  document.querySelector('[data-action="configure-domain"]')?.addEventListener("click", () => {
    context.showModal(oauth.domain ? "Update user-pool domain" : "Create user-pool domain", `<div class="field"><label>Domain prefix</label><input name="domain" required ${oauth.domain ? "readonly" : ""} value="${escapeHtml(oauth.domain?.name || "")}" pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"></div><div class="field"><label>Managed login version</label><select name="version"><option value="2" ${oauth.domain?.managedLoginVersion !== 1 ? "selected" : ""}>2 · Managed login</option><option value="1" ${oauth.domain?.managedLoginVersion === 1 ? "selected" : ""}>1 · Hosted UI classic</option></select></div>`, oauth.domain ? "Update domain" : "Create domain", async data => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/domain`, "POST", {
        domain: String(data.get("domain") || "").trim(),
        managedLoginVersion: Number(data.get("version")),
      });
      context.toast(oauth.domain ? "Domain updated" : "Domain created");
      await managedLoginPage(context, pool.id);
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="delete-domain"]')?.addEventListener("click", () => context.confirmDeletion(oauth.domain.name, `Delete domain ${oauth.domain.name}?`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/domain`, "DELETE", { confirmation: oauth.domain.name });
    context.toast("Domain deleted");
    await managedLoginPage(context, pool.id);
  }));
  const providerFields = provider => {
    const publicDetails = Object.fromEntries(Object.entries(provider?.providerDetails || {}).filter(([key]) => key !== "client_secret"));
    return `<div class="field-row"><div class="field"><label>Provider name</label><input name="providerName" required maxlength="32" pattern="[A-Za-z0-9._-]+" ${provider ? "readonly" : ""} value="${escapeHtml(provider?.name || "")}"></div><div class="field"><label>Protocol</label><select name="providerType" ${provider ? "disabled" : ""}><option value="OIDC" ${provider?.type !== "SAML" ? "selected" : ""}>OpenID Connect</option><option value="SAML" ${provider?.type === "SAML" ? "selected" : ""}>SAML 2.0</option></select></div></div><div class="field"><label>Provider details (JSON)</label><textarea name="providerDetails" rows="9" required>${escapeHtml(JSON.stringify(publicDetails, null, 2))}</textarea><span class="hint">OIDC: oidc_issuer, client_id, client_secret, authorize_scopes. SAML: MetadataFile or MetadataURL and optional IDPInit.</span></div><div class="field"><label>Attribute mapping (JSON)</label><textarea name="attributeMapping" rows="4" required>${escapeHtml(JSON.stringify(provider?.attributeMapping || { email: "email", email_verified: "email_verified" }, null, 2))}</textarea></div><div class="field"><label>IdP identifiers</label><textarea name="identifiers" rows="2">${escapeHtml((provider?.idpIdentifiers || []).join("\n"))}</textarea><span class="hint">One identifier per line.</span></div>${provider?.type === "OIDC" ? '<div class="alert info">Leave client_secret absent to preserve the existing write-only secret.</div>' : ""}`;
  };
  document.querySelector('[data-action="create-identity-provider"]')?.addEventListener("click", () => {
    context.showModal("Create external identity provider", providerFields(), "Create provider", async data => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/identity-providers`, "POST", {
        ProviderName: String(data.get("providerName") || "").trim(),
        ProviderType: String(data.get("providerType") || ""),
        ProviderDetails: JSON.parse(String(data.get("providerDetails") || "{}")),
        AttributeMapping: JSON.parse(String(data.get("attributeMapping") || "{}")),
        IdpIdentifiers: String(data.get("identifiers") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean),
      });
      context.toast("Identity provider created");
      await managedLoginPage(context, pool.id);
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelectorAll("[data-edit-provider]").forEach(button => button.addEventListener("click", () => {
    const provider = oauth.identityProviders.find(value => value.name === button.dataset.editProvider);
    context.showModal(`Edit ${provider.name}`, providerFields(provider), "Save provider", async data => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/identity-providers/${encoded(provider.name)}`, "PATCH", {
        ProviderDetails: JSON.parse(String(data.get("providerDetails") || "{}")),
        AttributeMapping: JSON.parse(String(data.get("attributeMapping") || "{}")),
        IdpIdentifiers: String(data.get("identifiers") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean),
      });
      context.toast("Identity provider updated");
      await managedLoginPage(context, pool.id);
    }, true, { refreshAfterSubmit: false });
  }));
  document.querySelectorAll("[data-test-provider]").forEach(button => button.addEventListener("click", async () => {
    const providerName = button.dataset.testProvider;
    try {
      const result = await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/identity-providers/${encoded(providerName)}/test`, "POST", {});
      context.toast(`${providerName}: ${result.status}`);
    } catch (error) {
      context.toast(`${providerName}: ${error.message || "connection test failed"}`);
    }
  }));
  document.querySelectorAll("[data-delete-provider]").forEach(button => button.addEventListener("click", () => {
    const providerName = button.dataset.deleteProvider;
    context.confirmDeletion(providerName, `Delete identity provider ${providerName}? Disable it on all app clients and unlink users first.`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/identity-providers/${encoded(providerName)}`, "DELETE", { confirmation: providerName });
      context.toast("Identity provider deleted");
      await managedLoginPage(context, pool.id);
    });
  }));
  document.querySelector('[data-action="create-resource-server"]')?.addEventListener("click", () => {
    context.showModal("Create resource server", `<div class="field"><label>Name</label><input name="name" required maxlength="128"></div><div class="field"><label>Identifier</label><input name="identifier" required maxlength="256" placeholder="https://api.example.test"></div><div class="field"><label>Scopes</label><textarea name="scopes" rows="4" placeholder="read | Read records&#10;write | Write records"></textarea><span class="hint">One scope per line: name | description.</span></div>`, "Create resource server", async data => {
      const scopes = String(data.get("scopes") || "").split(/\r?\n/).map(line => line.split("|").map(value => value.trim())).filter(parts => parts[0]).map(parts => ({ ScopeName: parts[0], ScopeDescription: parts[1] || parts[0] }));
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/resource-servers`, "POST", {
        Identifier: String(data.get("identifier") || "").trim(),
        Name: String(data.get("name") || "").trim(),
        Scopes: scopes,
      });
      context.toast("Resource server created");
      await managedLoginPage(context, pool.id);
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelectorAll("[data-delete-resource]").forEach(button => button.addEventListener("click", () => {
    const identifier = button.dataset.deleteResource;
    context.confirmDeletion(identifier, `Delete resource server ${identifier}?`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/resource-servers/${encoded(identifier)}`, "DELETE", { confirmation: identifier });
      context.toast("Resource server deleted");
      await managedLoginPage(context, pool.id);
    });
  }));
  document.querySelector('[data-action="configure-branding"]')?.addEventListener("click", () => {
    context.showModal("Configure managed-login branding", `<div class="field"><label>App client</label><select name="clientId" required>${clients.appClients.map(client => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)} · ${escapeHtml(client.id)}</option>`).join("")}</select></div><div class="field"><label>Page title</label><input name="pageTitle" required maxlength="80" value="${escapeHtml(pool.name)}"></div><div class="field"><label>Primary color</label><input name="primaryColor" required pattern="#[0-9A-Fa-f]{6}" value="#2563eb"></div>`, "Save branding", async data => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/branding`, "POST", {
        clientId: data.get("clientId"),
        pageTitle: String(data.get("pageTitle") || "").trim(),
        primaryColor: String(data.get("primaryColor") || "").trim(),
      });
      context.toast("Branding saved");
      await managedLoginPage(context, pool.id);
    }, true, { refreshAfterSubmit: false });
  });
}

async function signInPage(context, poolId) {
  const [pool, clientResult] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients`),
  ]);
  const configuration = pool.configuration;
  const mode = configuration.signIn.usernameAttributes.includes("email")
    ? "Email address"
    : configuration.signIn.aliasAttributes.includes("email")
      ? "Username or verified email alias"
      : "Username";
  const flows = [...new Set(clientResult.appClients.flatMap(client => client.enabledAuthFlows))];
  const policy = configuration.passwordPolicy;
  poolPage(context, pool, "sign-in", `<section class="card"><div class="card-header"><h2>Sign-in experience</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Sign-in identifier</dt><dd>${escapeHtml(mode)}</dd><dt>Case sensitive</dt><dd>${configuration.signIn.caseSensitive ? "Yes" : "No"}</dd><dt>Account recovery</dt><dd>Verified email</dd></dl><dl class="key-value"><dt>MFA</dt><dd>${escapeHtml(configuration.mfa.mode)} (${configuration.mfa.enabledMethods.map(escapeHtml).join(", ") || "no methods"})</dd><dt>Passwordless sign-in</dt><dd>Unavailable</dd><dt>SRP</dt><dd>${flows.includes("ALLOW_USER_SRP_AUTH") ? "Enabled by an app client" : "Not enabled"}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Password policy</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Minimum length</dt><dd>${policy.minimumLength}</dd><dt>Uppercase</dt><dd>${policy.requireUppercase ? "Required" : "Not required"}</dd><dt>Lowercase</dt><dd>${policy.requireLowercase ? "Required" : "Not required"}</dd></dl><dl class="key-value"><dt>Numbers</dt><dd>${policy.requireNumbers ? "Required" : "Not required"}</dd><dt>Symbols</dt><dd>${policy.requireSymbols ? "Required" : "Not required"}</dd><dt>Temporary password validity</dt><dd>${policy.temporaryPasswordValidityDays} days</dd><dt>Password history</dt><dd>${policy.passwordHistorySize || 0}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Enabled client flows</h2></div><div class="card-body">${flows.map(flow => badge(flow, "success")).join(" ") || '<span class="muted">No app client currently enables a direct authentication flow.</span>'}</div></section>`);
}

async function selfSignUpPage(context, poolId) {
  const pool = await loadPool(poolId);
  const configuration = pool.configuration;
  const signUp = configuration.selfServiceSignUp;
  const email = configuration.email;
  const customAttributes = values(configuration.attributeSchema).filter(attribute => attribute.name.startsWith("custom:"));
  const customAttributeRows = customAttributes.map(attribute => {
    const constraints = attribute.dataType === "String"
      ? `${attribute.stringConstraints?.minLength ?? "0"}–${attribute.stringConstraints?.maxLength ?? "2,048"} characters`
      : attribute.dataType === "Number"
        ? `${attribute.numberConstraints?.minValue ?? "No minimum"} to ${attribute.numberConstraints?.maxValue ?? "no maximum"}`
        : "Type validation";
    return `<tr><td class="mono">${escapeHtml(attribute.name)}</td><td>${escapeHtml(attribute.dataType)}</td><td>${attribute.mutable ? "Mutable" : badge("Immutable")}</td><td>${escapeHtml(constraints)}</td></tr>`;
  }).join("");
  poolPage(context, pool, "self-service-sign-up", `<section class="card"><div class="card-header"><h2>Self-service sign-up</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Sign-up</dt><dd>${badge(signUp.enabled ? "Enabled" : "Disabled", signUp.enabled ? "success" : "")}</dd><dt>Required attributes</dt><dd>${signUp.requiredAttributes.map(escapeHtml).join(", ") || "None"}</dd><dt>Automatic verification</dt><dd>${signUp.autoVerifiedAttributes.map(escapeHtml).join(", ") || "None"}</dd></dl><dl class="key-value"><dt>Delivery</dt><dd>Email through local SES</dd><dt>Message type</dt><dd>Confirmation code</dd><dt>SMS</dt><dd>Unavailable</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Verification message</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Sending account</dt><dd>${escapeHtml(email.sendingAccount)}</dd><dt>Sender</dt><dd>${escapeHtml(email.from || "no-reply@verificationemail.com")}</dd></dl><dl class="key-value"><dt>Subject</dt><dd>${escapeHtml(email.verificationSubject)}</dd><dt>Delivery capture</dt><dd><a href="${escapeHtml(pool.inboxPath)}">Filtered SES Inbox</a></dd></dl></div><div class="alert info"><strong>Codes stay in email</strong><br>The Cognito console never exposes confirmation codes or their digests. Use the captured message exactly as an application user would.</div></section>
    <section class="card"><div class="card-header"><div><h2>Custom attributes</h2><p class="muted small">Extend the pool schema for application-specific user data.</p></div><button class="button primary" data-action="add-custom-attribute">Add custom attribute</button></div><div class="alert warning"><strong>Permanent schema</strong><br>Custom attribute definitions cannot be removed after they are added. Immutable values can be supplied only while creating a user.</div><div class="table-wrap">${customAttributeRows ? `<table><thead><tr><th>Name</th><th>Type</th><th>Mutability</th><th>Constraints</th></tr></thead><tbody>${customAttributeRows}</tbody></table>` : emptyState("A", "No custom attributes", "Add a schema definition to make an application-specific attribute available to users.")}</div></section>
    <section class="card"><div class="card-header"><h2>Advanced sign-up features</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Lambda triggers</dt><dd>${Object.values(configuration.lambdaTriggers || {}).filter(Boolean).length} configured</dd><dt>Custom attributes</dt><dd>${customAttributes.length}</dd></dl><dl class="key-value"><dt>Terms and branding</dt><dd>Managed login</dd><dt>External identity providers</dt><dd>Configure in Managed login</dd></dl></div></section>`);
  document.querySelector('[data-action="add-custom-attribute"]')?.addEventListener("click", () => {
    context.showModal("Add custom attribute", `<div class="alert warning"><strong>This cannot be undone</strong><br>The schema definition remains part of the user pool after it is added.</div><div class="field-row"><div class="field"><label>Name</label><input name="name" required maxlength="20" pattern="[A-Za-z][A-Za-z0-9_]{0,19}" autocomplete="off" placeholder="department"></div><div class="field"><label>Data type</label><select name="dataType" id="cognito-custom-attribute-type"><option value="String">String</option><option value="Number">Number</option><option value="Boolean">Boolean</option><option value="DateTime">DateTime</option></select></div></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="mutable" checked> Mutable after user creation</label><span class="hint">Clear this only when the value must be fixed at user creation.</span></div><fieldset class="cognito-fieldset" data-string-constraints><legend>String constraints</legend><div class="field-row"><div class="field"><label>Minimum length</label><input name="stringMin" type="number" min="0" max="2048"></div><div class="field"><label>Maximum length</label><input name="stringMax" type="number" min="0" max="2048"></div></div></fieldset><fieldset class="cognito-fieldset" data-number-constraints hidden><legend>Number constraints</legend><div class="field-row"><div class="field"><label>Minimum value</label><input name="numberMin" type="number" step="any"></div><div class="field"><label>Maximum value</label><input name="numberMax" type="number" step="any"></div></div></fieldset>`, "Add custom attribute", async data => {
      const dataType = String(data.get("dataType"));
      const stringMin = String(data.get("stringMin") || "");
      const stringMax = String(data.get("stringMax") || "");
      const numberMin = String(data.get("numberMin") || "");
      const numberMax = String(data.get("numberMax") || "");
      const attribute = {
        Name: String(data.get("name") || "").trim(),
        AttributeDataType: dataType,
        Mutable: data.get("mutable") === "on",
        ...(dataType === "String" && (stringMin || stringMax) ? {
          StringAttributeConstraints: {
            ...(stringMin ? { MinLength: stringMin } : {}),
            ...(stringMax ? { MaxLength: stringMax } : {}),
          },
        } : {}),
        ...(dataType === "Number" && (numberMin || numberMax) ? {
          NumberAttributeConstraints: {
            ...(numberMin ? { MinValue: numberMin } : {}),
            ...(numberMax ? { MaxValue: numberMax } : {}),
          },
        } : {}),
      };
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/custom-attributes`, "POST", {
        CustomAttributes: [attribute],
      });
      context.toast("Custom attribute added");
      await context.route();
    }, true, { refreshAfterSubmit: false });
    const type = document.querySelector("#cognito-custom-attribute-type");
    const stringConstraints = document.querySelector("[data-string-constraints]");
    const numberConstraints = document.querySelector("[data-number-constraints]");
    const syncConstraints = () => {
      if (stringConstraints) stringConstraints.hidden = type?.value !== "String";
      if (numberConstraints) numberConstraints.hidden = type?.value !== "Number";
    };
    type?.addEventListener("change", syncConstraints);
    syncConstraints();
  });
}

export async function routeCognito(parts, context) {
  const withPanelHelp = async render => {
    const result = await render();
    decorateCognitoPanelHelp(context.main);
    return result;
  };
  if (parts[0] !== "cognito") return context.notFound(parts);
  if (parts.length === 1) return withPanelHelp(() => landing(context));
  if (parts[1] === "user-pools" && parts.length === 2) return withPanelHelp(() => poolsPage(context));
  if (parts[1] !== "user-pools" || parts.length < 4) return context.notFound(parts);
  const poolId = parts[2];
  if (parts[3] === "overview" && parts.length === 4) return withPanelHelp(() => overviewPage(context, poolId));
  if (parts[3] === "users" && parts.length === 4) return withPanelHelp(() => usersPage(context, poolId));
  if (parts[3] === "users" && parts.length === 5) return withPanelHelp(() => userDetailPage(context, poolId, parts[4]));
  if (parts[3] === "groups" && parts.length === 4) return withPanelHelp(() => groupsPage(context, poolId));
  if (parts[3] === "app-clients" && parts.length === 4) return withPanelHelp(() => appClientsPage(context, poolId));
  if (parts[3] === "app-clients" && parts.length === 5) return withPanelHelp(() => appClientDetailPage(context, poolId, parts[4]));
  if (parts[3] === "managed-login" && parts.length === 4) return withPanelHelp(() => managedLoginPage(context, poolId));
  if (parts[3] === "sign-in" && parts.length === 4) return withPanelHelp(() => signInPage(context, poolId));
  if (parts[3] === "self-service-sign-up" && parts.length === 4) return withPanelHelp(() => selfSignUpPage(context, poolId));
  return context.notFound(parts);
}
