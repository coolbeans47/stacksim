import { consoleMutation, request, rest } from "../api-client.js";
import { associateFormLabels, emptyState, escapeHtml, formatDate, pageHeader, panelHeading, tabs } from "../components.js";

const SERVICE_LINKS = [
  ["User pools", "#/cognito/user-pools"],
  ["Identity pools", "#/cognito-identity/identity-pools"],
];

export const metadata = {
  key: "cognito",
  name: "Cognito",
  icon: "C",
  cls: "cognito",
  links: [...SERVICE_LINKS],
  search: [
    "cognito", "identity", "identity pool", "federated identities", "user pool", "app client",
    "users", "sign in", "sign up", "authentication", "jwt", "jwks", "getid",
  ],
};

const encoded = value => encodeURIComponent(String(value));
const values = value => Array.isArray(value) ? value : value == null ? [] : [value];
const lines = value => String(value || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean);

/** Runs one official Cognito administrator operation through the console's redacted action route. */
const act = (operation, input) => consoleMutation(`/_stacksim/api/cognito/actions/${operation}`, "POST", input);

const cognitoPanelHelp = {
  userPools: {
    level: "Supported locally",
    description: "A user pool is an application user directory. It stores users, sign-in identifiers, password and MFA rules, groups, app clients, and token settings. Create a pool when an application needs sign-up or administrator-managed users and Cognito-shaped authentication tokens.",
    support: "User-pool creation, users, groups, password, SRP and choice-based authentication, recovery, MFA, Lambda triggers, signed JWTs, and local JWKS are active and persist locally. Temporary AWS credentials are issued by Identity pools.",
  },
  poolDetails: {
    level: "Supported locally",
    description: "The user pool information summarizes the directory: its identifiers, feature plan, size, and the token signing key URL that applications use to verify tokens.",
    support: "Identifiers, the feature plan, user counts, and the local JWKS route are live. Edit the pool's settings from the menu on the left.",
  },
  users: {
    level: "Supported locally",
    description: "Users are identities stored in this pool. Create an administrator-managed user when staff or an automated provisioning flow should establish the account, optionally issuing a temporary password and invitation instead of using public self-service sign-up.",
    support: "User creation, temporary passwords, confirmation, email verification, enable or disable, attribute search, paging, and local SES invitation capture are active. The console never reveals generated temporary passwords or confirmation codes.",
  },
  userDetails: {
    level: "Supported locally",
    description: "User information summarizes the account. The Actions menu resets the password, confirms a self-registered account, enables or disables access, signs the user out of every session, or deletes a disabled user.",
    support: "Account status, password policy enforcement, reset delivery through the local SES Inbox, token-session revocation, and deletion are active locally. Already issued access tokens remain valid until they expire.",
  },
  attributes: {
    level: "Supported locally",
    description: "Attributes store profile data such as email and application-specific custom values. Each pool schema decides the data type, constraints, whether the value is required, and whether administrators may change or remove it after user creation.",
    support: "Schema validation, mutable attribute add, edit and removal, verification flags, required fields, and string or number constraints are active. Immutable attributes can be supplied only when the user is created.",
  },
  groupMemberships: {
    level: "Supported locally",
    description: "Group membership adds group and preferred-role claims to newly issued tokens. A user's MFA preference decides whether an eligible second factor is used at sign-in.",
    support: "Membership changes, precedence and role claims, email OTP and authenticator-app preferences, and newly issued token claims are active. Existing tokens are not rewritten after a group change.",
  },
  groups: {
    level: "Supported locally",
    description: "Groups organize users and add cognito:groups claims to their tokens. Optional precedence chooses the preferred group when several memberships have roles, and an IAM role ARN supplies the cognito:preferred_role claim.",
    support: "Group creation, editing, deletion, membership, precedence, role claims, listing, and search are active. IAM role assumption happens in Identity pools, not in the user pool.",
  },
  appClients: {
    level: "Supported locally",
    description: "An app client represents an application that asks the user pool to authenticate users or issue tokens. Choose the application type, then adjust the sign-in flows, token lifetimes, attribute permissions, and managed login pages the application needs.",
    support: "Choice-based, password, administrator-password, SRP and refresh flows, client secrets, token validity, revocation, refresh rotation, attribute permissions, and local managed-login OAuth are active. StackSim never displays a client secret in the console; DescribeUserPoolClient returns it to API callers.",
  },
  appClientDetails: {
    level: "Supported locally",
    description: "App client information identifies the calling application and its authentication and token behavior. Edit changes every setting; Login pages configure managed login and OAuth; Attribute permissions control what the client can read and write.",
    support: "Client lifecycle, direct flows, token issuance, OAuth configuration, provider associations, attribute permissions, and refresh-session revocation are active on local Cognito endpoints.",
  },
  domain: {
    level: "Supported locally",
    description: "A user-pool domain gives managed login and OAuth endpoints a stable base URL. Create a Cognito domain before using browser authorization flows or client-specific branding.",
    support: "Cognito domain prefixes, branding versions, discovery, authorize, token, logout, and local login routes are active. Custom domains need DNS, CloudFront, and ACM certificates, which StackSim does not provide.",
  },
  identityProviders: {
    level: "Partial",
    description: "An external identity provider lets users sign in through another OpenID Connect or SAML system. Provider details establish trust, attribute mappings translate external claims into pool attributes, and identifiers help route users to the correct provider.",
    support: "OIDC discovery, signed SAML metadata and assertions, attribute mapping, client enablement, and connection tests are active. Loopback works by default; public HTTPS providers require STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true, while private, metadata, and link-local targets remain blocked.",
  },
  resourceServers: {
    level: "Supported locally",
    description: "A resource server represents an API protected by this user pool. Its identifier namespaces custom scopes such as api/read, which app clients can request and access tokens can carry for API authorization.",
    support: "Resource-server creation, editing, deletion, scope validation, app-client scope selection, OAuth consent, and access-token scope claims are active locally.",
  },
  branding: {
    level: "Partial",
    description: "Managed-login styles customize the sign-in page for a particular app client while keeping the pool's authentication and federation behavior.",
    support: "The local managed login page applies a client-specific page title and six-digit primary color. Logos, images, advanced style tokens, and the visual branding editor are not implemented in this simulator.",
  },
  customAttributes: {
    level: "Supported locally",
    description: "Custom attributes extend the user schema with application-specific values. Choose constraints and mutability carefully: the schema definition is permanent, and immutable values can be set only when a user is created.",
    support: "String and Number custom attributes match the AWS console; Boolean and DateTime are API-supported types this console also offers as a StackSim extra. Custom attribute definitions cannot be removed after creation.",
  },
};

const cognitoPanelHelpTargets = [
  ['.card:has([data-filter-table])', "User pools", "userPools"],
  [".card", "User pool information", "poolDetails"],
  ['.card:has([data-action="create-user"])', "Users", "users"],
  [".card", "User information", "userDetails"],
  ['.card:has([data-action="add-attribute"])', "User attributes", "attributes"],
  ['.card:has([data-action="edit-groups"])', "Group memberships", "groupMemberships"],
  ['.card:has([data-action="create-group"])', "Groups", "groups"],
  ['.card:has([data-action="create-app-client"])', "App clients", "appClients"],
  ['.card:has([data-action="edit-app-client"])', "App client information", "appClientDetails"],
  ['.card:has([data-action="configure-domain"])', "Domain", "domain"],
  ['.card:has([data-action="create-identity-provider"])', "Social and external providers", "identityProviders"],
  ['.card:has([data-action="create-resource-server"])', "Resource servers", "resourceServers"],
  ['.card:has([data-action="configure-branding"])', "Styles", "branding"],
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

const FRIENDLY = {
  CONFIRMED: "Confirmed",
  UNCONFIRMED: "Unconfirmed",
  FORCE_CHANGE_PASSWORD: "Force change password",
  RESET_REQUIRED: "Reset required",
  EXTERNAL_PROVIDER: "External provider",
  ESSENTIALS: "Essentials",
  PLUS: "Plus",
  LITE: "Lite",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  OFF: "No MFA",
  OPTIONAL: "Optional MFA",
  ON: "Require MFA",
  COGNITO_DEFAULT: "Send email with Cognito",
  DEVELOPER: "Send email with Amazon SES",
  LEGACY: "Legacy",
  ENABLED: "Enabled",
  SOFTWARE_TOKEN_MFA: "Authenticator apps",
  EMAIL_OTP: "Email message",
};
const friendly = value => FRIENDLY[value] ?? String(value ?? "");

const AUTH_FLOWS = [
  ["ALLOW_USER_AUTH", "Choice-based sign-in"],
  ["ALLOW_USER_SRP_AUTH", "Sign in with secure remote password (SRP)"],
  ["ALLOW_USER_PASSWORD_AUTH", "Sign in with username and password"],
  ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "Sign in with server-side administrative credentials"],
  ["ALLOW_CUSTOM_AUTH", "Sign in with custom authentication flows from Lambda triggers"],
  ["ALLOW_REFRESH_TOKEN_AUTH", "Get new user tokens from existing authenticated sessions"],
];
const flowLabel = flow => AUTH_FLOWS.find(([value]) => value === flow)?.[1] ?? flow;

const STANDARD_ATTRIBUTES = [
  "address", "birthdate", "email", "family_name", "gender", "given_name", "locale", "middle_name", "name",
  "nickname", "phone_number", "picture", "preferred_username", "profile", "updated_at", "website", "zoneinfo",
];

function badge(value, kind = "") {
  return `<span class="status-badge ${escapeHtml(kind)}">${escapeHtml(friendly(value))}</span>`;
}

function actionsMenu(label, items) {
  return `<details class="actions-menu"><summary class="button" aria-haspopup="menu">${escapeHtml(label)} ▾</summary><div class="menu" role="menu">${items.filter(Boolean).map(([action, text, options = {}]) => `<button type="button" role="menuitem" data-menu-action="${escapeHtml(action)}" class="${options.danger ? "danger" : ""}" ${options.disabled ? `disabled title="${escapeHtml(options.disabled)}"` : ""}>${escapeHtml(text)}</button>`).join("")}</div></details>`;
}

function bindMenu(handlers) {
  document.querySelectorAll("[data-menu-action]").forEach(button => button.addEventListener("click", () => {
    button.closest("details")?.removeAttribute("open");
    handlers[button.dataset.menuAction]?.();
  }));
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

function setServiceChrome(context, crumbs) {
  metadata.links.splice(0, metadata.links.length, ...SERVICE_LINKS);
  context.setChrome("cognito", ["Cognito", ...crumbs]);
}

/** The grouped user-pool menu of the current Cognito console, shown in the left navigation inside a pool. */
function poolMenu(pool) {
  const root = `#/cognito/user-pools/${encoded(pool.id)}`;
  return [
    ...SERVICE_LINKS,
    [`User pool: ${pool.name}`, "", "section"],
    ["Overview", `${root}/overview`],
    ["Applications", "", "section"],
    ["App clients", `${root}/app-clients`],
    ["User management", "", "section"],
    ["Users", `${root}/users`],
    ["Groups", `${root}/groups`],
    ["Authentication", "", "section"],
    ["Authentication methods", `${root}/authentication-methods`],
    ["Sign-in", `${root}/sign-in`],
    ["Sign-up", `${root}/sign-up`],
    ["Social and external providers", `${root}/identity-providers`],
    ["Message templates", `${root}/message-templates`],
    ["Security", "", "section"],
    ["Threat protection", `${root}/threat-protection`],
    ["Branding", "", "section"],
    ["Domain", `${root}/domain`],
    ["Managed login", `${root}/managed-login`],
    ["Extensions", "", "section"],
    ["Lambda triggers", `${root}/lambda-triggers`],
    ["Settings", `${root}/settings`],
  ];
}

const PAGE_LABELS = {
  overview: "Overview",
  users: "Users",
  groups: "Groups",
  "app-clients": "App clients",
  "authentication-methods": "Authentication methods",
  "sign-in": "Sign-in",
  "sign-up": "Sign-up",
  "identity-providers": "Social and external providers",
  "message-templates": "Message templates",
  "threat-protection": "Threat protection",
  domain: "Domain",
  "managed-login": "Managed login",
  "lambda-triggers": "Lambda triggers",
  settings: "Settings",
};

async function loadPool(poolId) {
  return (await request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}`)).userPool;
}

async function describePool(poolId) {
  return (await act("DescribeUserPool", { UserPoolId: poolId })).UserPool;
}

/**
 * UpdateUserPool resets every omitted setting to its default, so console editors rebuild the complete request from
 * DescribeUserPool, apply one change, and restore the pool's email MFA message afterwards.
 */
async function updatePool(poolId, mutate) {
  const [pool, mfa] = await Promise.all([
    describePool(poolId),
    act("GetUserPoolMfaConfig", { UserPoolId: poolId }),
  ]);
  const lambdaConfig = Object.fromEntries(Object.entries(pool.LambdaConfig || {}).filter(([, value]) => value !== undefined && value !== null));
  const input = {
    UserPoolId: poolId,
    PoolName: pool.Name,
    Policies: pool.Policies,
    DeletionProtection: pool.DeletionProtection,
    AutoVerifiedAttributes: pool.AutoVerifiedAttributes || [],
    VerificationMessageTemplate: {
      DefaultEmailOption: pool.VerificationMessageTemplate?.DefaultEmailOption || "CONFIRM_WITH_CODE",
      EmailSubject: pool.VerificationMessageTemplate?.EmailSubject,
      EmailMessage: pool.VerificationMessageTemplate?.EmailMessage,
      ...(pool.VerificationMessageTemplate?.SmsMessage ? { SmsMessage: pool.VerificationMessageTemplate.SmsMessage } : {}),
    },
    EmailConfiguration: pool.EmailConfiguration,
    AdminCreateUserConfig: pool.AdminCreateUserConfig,
    ...(pool.AccountRecoverySetting ? { AccountRecoverySetting: pool.AccountRecoverySetting } : {}),
    UserPoolTier: pool.UserPoolTier,
    MfaConfiguration: pool.MfaConfiguration,
    EnabledMfas: pool.EnabledMfas || [],
    LambdaConfig: lambdaConfig,
    ...(pool.UserAttributeUpdateSettings ? { UserAttributeUpdateSettings: pool.UserAttributeUpdateSettings } : {}),
    ...(pool.DeviceConfiguration ? { DeviceConfiguration: pool.DeviceConfiguration } : {}),
    ...(pool.SmsVerificationMessage ? { SmsVerificationMessage: pool.SmsVerificationMessage } : {}),
  };
  await mutate(input, pool);
  await act("UpdateUserPool", input);
  if (mfa.EmailMfaConfiguration && values(input.EnabledMfas).includes("EMAIL_OTP")) {
    await act("SetUserPoolMfaConfig", {
      UserPoolId: poolId,
      MfaConfiguration: input.MfaConfiguration,
      SoftwareTokenMfaConfiguration: { Enabled: values(input.EnabledMfas).includes("SOFTWARE_TOKEN_MFA") },
      EmailMfaConfiguration: mfa.EmailMfaConfiguration,
    });
  }
}

function poolPage(context, pool, active, content, actions = "", { title, crumbs } = {}) {
  metadata.links.splice(0, metadata.links.length, ...poolMenu(pool));
  const label = PAGE_LABELS[active] ?? active;
  context.setChrome("cognito", [
    "Cognito",
    { label: "User pools", href: "#/cognito/user-pools" },
    { label: pool.name, href: `#/cognito/user-pools/${encoded(pool.id)}/overview` },
    ...(crumbs ?? [label]),
  ]);
  context.main.innerHTML = `<div class="page-width cognito-page cognito-detail">${pageHeader(title ?? label, active === "overview" ? escapeHtml(pool.id) : `User pool: ${escapeHtml(pool.name)}`, actions)}
    ${content}
  </div>`;
}

function card(title, body, actions = "", meta = "") {
  return `<section class="card"><div class="card-header"><h2>${escapeHtml(title)}${meta ? ` <span class="muted">${escapeHtml(meta)}</span>` : ""}</h2>${actions ? `<div class="actions">${actions}</div>` : ""}</div>${body}</section>`;
}

function detail(entries) {
  return `<dl class="key-value">${entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

function boundaryNote(title, text) {
  return `<div class="alert info"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(text)}</div>`;
}

/* ---------------------------------------------------------------- user pools list and create wizard */

async function poolsPage(context) {
  const { userPools } = await request("/_stacksim/api/cognito/user-pools");
  setServiceChrome(context, ["User pools"]);
  const rows = userPools.map(pool => `<tr data-search-row="${escapeHtml(`${pool.name} ${pool.id}`.toLowerCase())}">
    <td><input type="radio" name="selected-pool" value="${escapeHtml(pool.id)}" aria-label="Select ${escapeHtml(pool.name)}"></td>
    <td><a href="#/cognito/user-pools/${encoded(pool.id)}/overview"><strong>${escapeHtml(pool.name)}</strong></a></td>
    <td class="mono">${escapeHtml(pool.id)}</td><td>${formatDate(pool.createdAt)}</td><td>${formatDate(pool.updatedAt)}</td>
  </tr>`).join("");
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("User pools", "Regional directories for application users.", '<button class="button" data-action="refresh">Refresh</button><button class="button danger" data-action="delete-user-pool" disabled>Delete</button><a class="button primary" href="#/cognito/user-pools/create" data-action="create-user-pool">Create user pool</a>')}
    <section class="card"><div class="card-header"><h2>User pools <span class="muted">(${userPools.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find user pools by name or ID"></label></div><div class="table-wrap">${rows ? `<table class="cognito-pool-table"><thead><tr><th><span class="sr-only">Select</span></th><th>User pool name</th><th>User pool ID</th><th>Created time</th><th>Last updated time</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("C", "No user pools", "Create a user pool to start a local sign-up and sign-in flow.", '<a class="button primary" href="#/cognito/user-pools/create">Create user pool</a>')}</div></section>
  </div>`;
  context.bindTableFilter();
  const remove = document.querySelector('[data-action="delete-user-pool"]');
  document.querySelectorAll('input[name="selected-pool"]').forEach(input => input.addEventListener("change", () => { remove.disabled = false; }));
  remove?.addEventListener("click", () => {
    const id = document.querySelector('input[name="selected-pool"]:checked')?.value;
    const pool = userPools.find(candidate => candidate.id === id);
    if (!pool) return;
    context.confirmDeletion(pool.id, `Delete user pool ${pool.name}, its users, clients, refresh sessions, and delivery intents? Deletion protection must be inactive.`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}`, "DELETE", { confirmation: pool.id });
      context.toast("User pool deleted");
      await context.route();
    });
  });
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

const APPLICATION_TYPES = [
  ["traditional", "Traditional web application", "Server-rendered applications that keep a client secret on the server."],
  ["spa", "Single-page application (SPA)", "Browser applications that sign users in without a client secret."],
  ["mobile", "Mobile app", "Native applications that sign users in without a client secret."],
  ["m2m", "Machine-to-machine application", "Services that request access tokens with their own client credentials."],
];

function createPoolWizard(context) {
  setServiceChrome(context, [{ label: "User pools", href: "#/cognito/user-pools" }, "Create user pool"]);
  const required = ["email", "name", "given_name", "family_name", "phone_number", "birthdate", "preferred_username"];
  context.main.innerHTML = `<div class="page-width cognito-page">${pageHeader("Set up resources for your application", "Create a user pool and an app client for one application. Every setting can be changed later from the user pool menu.")}
    <form id="cognito-create-pool" class="cognito-wizard">
      <section class="card"><div class="card-header"><h2>Define your application</h2></div><div class="card-body">
        <fieldset class="cognito-fieldset"><legend>Application type</legend>${APPLICATION_TYPES.map(([value, label, hint], index) => `<label class="checkbox-label"><input type="radio" name="applicationType" value="${value}" ${index === 0 ? "checked" : ""}> <span><strong>${escapeHtml(label)}</strong><br><span class="muted small">${escapeHtml(hint)}</span></span></label>`).join("")}</fieldset>
        <div class="field"><label>Name your application</label><input name="applicationName" required maxlength="128" pattern="[A-Za-z0-9_ +=,.@-]+" placeholder="My web app" autocomplete="off"></div>
      </div></section>
      <section class="card" data-user-options><div class="card-header"><h2>Configure options</h2></div><div class="card-body">
        <fieldset class="cognito-fieldset"><legend>Options for sign-in identifiers</legend><div class="cognito-option-grid"><label class="checkbox-label"><input type="checkbox" name="signInEmail" checked> Email</label><label class="checkbox-label"><input type="checkbox" name="signInPhone" disabled> Phone number</label><label class="checkbox-label"><input type="checkbox" name="signInUsername"> Username</label></div><span class="hint">Phone-number sign-in needs SMS delivery through Amazon SNS, which is not implemented in this simulator.</span></fieldset>
        <div class="field"><label class="checkbox-label"><input type="checkbox" name="selfRegistration" checked> Enable self-registration</label></div>
        <fieldset class="cognito-fieldset"><legend>Required attributes for sign-up</legend><div class="cognito-option-grid">${required.map(name => `<label class="checkbox-label"><input type="checkbox" name="required:${name}" ${name === "email" ? "checked" : ""} ${name === "phone_number" ? "disabled" : ""}> ${escapeHtml(name)}</label>`).join("")}</div></fieldset>
      </div></section>
      <section class="card" data-return-url><div class="card-header"><h2>Add a return URL <span class="muted">(optional)</span></h2></div><div class="card-body"><div class="field"><label>Return URL</label><input name="returnUrl" placeholder="http://localhost:3000/callback" autocomplete="off"><span class="hint">Managed login redirects here after sign-in. Use an HTTPS URL or a loopback HTTP URL.</span></div></div></section>
      <div class="actions"><a class="button" href="#/cognito/user-pools">Cancel</a><button class="button primary" type="submit">Create user pool</button></div>
    </form>
  </div>`;
  const form = document.querySelector("#cognito-create-pool");
  const sync = () => {
    const m2m = form.elements.applicationType.value === "m2m";
    form.querySelector("[data-user-options]").hidden = m2m;
    form.querySelector("[data-return-url]").hidden = m2m;
  };
  form.querySelectorAll('input[name="applicationType"]').forEach(input => input.addEventListener("change", sync));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    const type = String(data.get("applicationType"));
    const applicationName = String(data.get("applicationName") || "").trim();
    const emailSignIn = data.get("signInEmail") === "on";
    const usernameSignIn = data.get("signInUsername") === "on";
    const requiredAttributes = required.filter(name => data.get(`required:${name}`) === "on");
    const suffix = Math.random().toString(36).slice(2, 8);
    try {
      if (type !== "m2m" && !emailSignIn && !usernameSignIn) throw new Error("Choose at least one sign-in identifier.");
      const created = await consoleMutation("/_stacksim/api/cognito/user-pools", "POST", {
        PoolName: `User pool - ${suffix}`,
        // The console creates case-insensitive pools with deletion protection active.
        UsernameConfiguration: { CaseSensitive: false },
        DeletionProtection: "ACTIVE",
        ...(emailSignIn && !usernameSignIn ? { UsernameAttributes: ["email"] } : {}),
        ...(emailSignIn && usernameSignIn ? { AliasAttributes: ["email"] } : {}),
        AutoVerifiedAttributes: emailSignIn || requiredAttributes.includes("email") ? ["email"] : [],
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: type === "m2m" || data.get("selfRegistration") !== "on" },
        Schema: requiredAttributes.map(name => ({ Name: name, Required: true, Mutable: true })),
        AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] },
      });
      const poolId = created.userPool.id;
      const secret = type === "traditional" || type === "m2m";
      const returnUrl = String(data.get("returnUrl") || "").trim();
      let scopes = ["openid", "email", "phone", "profile"];
      if (type === "m2m") {
        const identifier = `default-m2m-resource-server-${suffix}`;
        await act("CreateResourceServer", { UserPoolId: poolId, Identifier: identifier, Name: identifier, Scopes: [{ ScopeName: "read", ScopeDescription: "An example scope created by the console" }] });
        scopes = [`${identifier}/read`];
      }
      const client = await act("CreateUserPoolClient", {
        UserPoolId: poolId,
        ClientName: applicationName,
        GenerateSecret: secret,
        ...(type === "m2m"
          ? { ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ["client_credentials"], AllowedOAuthScopes: scopes }
          : {
              ExplicitAuthFlows: ["ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
              PreventUserExistenceErrors: "ENABLED",
              SupportedIdentityProviders: ["COGNITO"],
              ...(returnUrl ? { CallbackURLs: [returnUrl], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ["code"], AllowedOAuthScopes: scopes } : {}),
            }),
      });
      context.toast("User pool and app client created");
      setupPage(context, poolId, client.UserPoolClient.ClientId, type);
    } catch (error) {
      context.toast(error.message || "The user pool could not be created");
    }
  });
}

async function setupPage(context, poolId, clientId, type) {
  const pool = await loadPool(poolId);
  const authority = pool.issuer;
  poolPage(context, pool, "overview", card("Set up your application", `<div class="card-body">
      <p>Your user pool and the app client <span class="mono">${escapeHtml(clientId)}</span> are ready.${type === "m2m" ? " Create a Cognito domain, then request tokens from its /oauth2/token endpoint with the client credentials grant." : " Configure an OpenID Connect client library with these values."}</p>
      ${detail([["Authority (issuer)", `<span class="mono cognito-wrap">${escapeHtml(authority)}</span>`], ["Client ID", `<span class="mono">${escapeHtml(clientId)}</span>`], ["Local JWKS URL", `<span class="mono cognito-wrap">${escapeHtml(new URL(pool.localJwksPath, location.origin).href)}</span>`]])}
      <pre class="code-block">${escapeHtml(type === "m2m"
        ? `curl -X POST <domain>/oauth2/token \\\n  -u ${clientId}:<client secret> \\\n  -d grant_type=client_credentials`
        : `import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";\n\nconst client = new CognitoIdentityProviderClient({ region: "${pool.id.split("_")[0]}", endpoint: "${location.origin}" });\nawait client.send(new InitiateAuthCommand({\n  ClientId: "${clientId}",\n  AuthFlow: "USER_AUTH",\n  AuthParameters: { USERNAME: "user@example.com", PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: "..." },\n}));`)}</pre>
      <a class="button primary" href="#/cognito/user-pools/${encoded(pool.id)}/overview">Go to overview</a></div>`), "", { title: "Set up your application", crumbs: ["Set up your application"] });
}

/* ---------------------------------------------------------------- overview and settings */

async function overviewPage(context, poolId) {
  const pool = await loadPool(poolId);
  const jwksUrl = new URL(pool.localJwksPath, location.origin).href;
  const tags = Object.entries(pool.tags || {});
  poolPage(context, pool, "overview", `
    ${card("User pool information", `<div class="card-body detail-grid">${detail([["User pool name", escapeHtml(pool.name)], ["User pool ID", `<span class="mono">${escapeHtml(pool.id)}</span>`], ["ARN", `<span class="mono cognito-wrap">${escapeHtml(pool.arn)}</span>`]])}${detail([["Token signing key URL", `<span class="mono cognito-wrap">${escapeHtml(jwksUrl)}</span> <button class="button link" data-copy="${escapeHtml(jwksUrl)}">Copy</button>`], ["Estimated number of users", String(pool.userCount)], ["Feature plan", escapeHtml(friendly(pool.configuration.tier))]])}${detail([["Created time", formatDate(pool.createdAt)], ["Last updated time", formatDate(pool.updatedAt)], ["Deletion protection", escapeHtml(friendly(pool.configuration.deletionProtection))]])}</div>`, '<button class="button" data-action="rename-user-pool">Rename</button>')}
    ${card("Token issuer", `<div class="card-body">${detail([["Canonical issuer", `<span class="mono cognito-wrap">${escapeHtml(pool.issuer)}</span>`], ["Local JWKS URL", `<span class="mono cognito-wrap">${escapeHtml(jwksUrl)}</span>`]])}${boundaryNote("Local verification route", "Tokens keep the AWS-shaped issuer. The loopback JWKS URL is developer tooling and does not change the token issuer or contact public endpoints.")}<a href="${escapeHtml(pool.inboxPath)}">Open filtered SES Inbox</a></div>`)}
    ${card("Tags", tags.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${tags.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="card-body"><p class="muted">No tags are associated with this user pool.</p></div>`, '<button class="button" data-action="edit-tags">Manage tags</button>', `(${tags.length})`)}
  `, "", { title: pool.name });
  document.querySelector('[data-action="rename-user-pool"]')?.addEventListener("click", () => context.showModal("Rename user pool", `<div class="field"><label>User pool name</label><input name="name" required maxlength="128" pattern="[A-Za-z0-9_ +=,.@-]+" value="${escapeHtml(pool.name)}"></div>`, "Save changes", async data => {
    await updatePool(pool.id, input => { input.PoolName = String(data.get("name") || "").trim(); });
    context.toast("User pool renamed");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="edit-tags"]')?.addEventListener("click", () => context.showModal("Manage tags", `<div class="field"><label>Tags <span class="muted">(one key=value per line)</span></label><textarea name="tags" rows="6">${escapeHtml(tags.map(([key, value]) => `${key}=${value}`).join("\n"))}</textarea></div>`, "Save changes", async data => {
    const next = {};
    for (const line of lines(data.get("tags"))) {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Invalid tag line: ${line}`);
      next[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    const removed = tags.map(([key]) => key).filter(key => !(key in next));
    if (removed.length) await act("UntagResource", { ResourceArn: pool.arn, TagKeys: removed });
    if (Object.keys(next).length) await act("TagResource", { ResourceArn: pool.arn, Tags: next });
    context.toast("Tags updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
}

async function settingsPage(context, poolId, tab = "feature-plans") {
  const pool = await loadPool(poolId);
  const protectedPool = pool.configuration.deletionProtection === "ACTIVE";
  const root = `#/cognito/user-pools/${encoded(pool.id)}/settings`;
  const plans = [["LITE", "Lite", "Sign-up and sign-in, groups, federation, the classic hosted UI, and Lambda triggers."], ["ESSENTIALS", "Essentials", "Adds managed login, choice-based sign-in, email MFA and one-time passwords, and password history."], ["PLUS", "Plus", "Adds threat protection, which is not implemented in this simulator."]];
  const body = tab === "user-pool-security"
    ? `${card("Deletion protection", `<div class="card-body"><p>${protectedPool ? "Deletion protection is active. Deactivate it before you delete this user pool." : "Deletion protection is inactive. The user pool can be deleted."}</p>${detail([["Deletion protection", badge(pool.configuration.deletionProtection, protectedPool ? "success" : "")]])}</div>`, `<button class="button" data-action="toggle-deletion-protection">${protectedPool ? "Deactivate" : "Activate"}</button>`)}
      ${card("Delete user pool", `<div class="card-body"><p>Deleting a user pool removes its users, groups, app clients, domain, and refresh sessions.</p></div>`, `<button class="button danger" data-action="delete-user-pool" ${protectedPool ? 'disabled title="Deactivate deletion protection first"' : ""}>Delete user pool</button>`)}`
    : card("Feature plans", `<div class="card-body"><p>Current plan: <strong>${escapeHtml(friendly(pool.configuration.tier))}</strong></p><div class="cognito-summary-grid">${plans.map(([value, label, text]) => `<div class="card"><div class="card-body"><strong>${escapeHtml(label)}</strong>${value === pool.configuration.tier ? ` ${badge("Current", "success")}` : ""}<p class="muted small">${escapeHtml(text)}</p></div></div>`).join("")}</div></div>`, '<button class="button" data-action="change-plan">Change plan</button>');
  poolPage(context, pool, "settings", `${tabs([
    { label: "Feature plans", href: `${root}/feature-plans`, active: tab !== "user-pool-security" },
    { label: "User pool security", href: `${root}/user-pool-security`, active: tab === "user-pool-security" },
  ])}${body}`);
  document.querySelector('[data-action="toggle-deletion-protection"]')?.addEventListener("click", () => context.showModal(`${protectedPool ? "Deactivate" : "Activate"} deletion protection`, `<p>${protectedPool ? "The user pool can be deleted after deletion protection is deactivated." : "The user pool cannot be deleted while deletion protection is active."}</p>`, protectedPool ? "Deactivate" : "Activate", async () => {
    await updatePool(pool.id, input => { input.DeletionProtection = protectedPool ? "INACTIVE" : "ACTIVE"; });
    context.toast(`Deletion protection ${protectedPool ? "deactivated" : "activated"}`);
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="delete-user-pool"]')?.addEventListener("click", () => context.confirmDeletion(pool.id, `Delete user pool ${pool.name}, its users, clients, refresh sessions, and delivery intents?`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}`, "DELETE", { confirmation: pool.id });
    context.toast("User pool deleted");
    location.hash = "#/cognito/user-pools";
  }));
  document.querySelector('[data-action="change-plan"]')?.addEventListener("click", () => context.showModal("Change feature plan", `<div class="field"><label>Feature plan</label><select name="tier">${plans.map(([value, label]) => `<option value="${value}" ${value === pool.configuration.tier ? "selected" : ""}>${label}</option>`).join("")}</select><span class="hint">Lite pools cannot use managed login, choice-based sign-in, email MFA, or password history.</span></div>`, "Save changes", async data => {
    await updatePool(pool.id, input => { input.UserPoolTier = String(data.get("tier")); });
    context.toast("Feature plan updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
}

/* ---------------------------------------------------------------- users */

const USER_SEARCH_ATTRIBUTES = [
  ["username", "User name"], ["email", "Email"], ["phone_number", "Phone number"], ["name", "Name"],
  ["given_name", "Given name"], ["family_name", "Family name"], ["preferred_username", "Preferred user name"],
  ["sub", "User ID (sub)"], ["cognito:user_status", "Confirmation status"], ["status", "Status (Enabled/Disabled)"],
];
const userListState = new Map();

async function usersPage(context, poolId) {
  const state = userListState.get(poolId) ?? { attribute: "email", value: "", tokens: [undefined], page: 0 };
  userListState.set(poolId, state);
  const filter = state.value ? `${state.attribute} ^= "${state.value.replaceAll('"', "")}"` : undefined;
  const [pool, listed] = await Promise.all([
    loadPool(poolId),
    act("ListUsers", { UserPoolId: poolId, Limit: 20, ...(filter ? { Filter: filter } : {}), ...(state.tokens[state.page] ? { PaginationToken: state.tokens[state.page] } : {}) }),
  ]);
  if (listed.PaginationToken) state.tokens[state.page + 1] = listed.PaginationToken;
  const rows = values(listed.Users).map(user => {
    const attributes = Object.fromEntries(values(user.Attributes).map(attribute => [attribute.Name, attribute.Value]));
    const name = attributes.email && pool.configuration.signIn.usernameAttributes.includes("email") ? attributes.email : user.Username;
    return `<tr><td><input type="radio" name="selected-user" value="${escapeHtml(attributes.sub)}" data-username="${escapeHtml(user.Username)}" data-enabled="${user.Enabled}" aria-label="Select ${escapeHtml(name)}"></td><td><a href="#/cognito/user-pools/${encoded(pool.id)}/users/${encoded(attributes.sub)}"><strong>${escapeHtml(name)}</strong></a></td><td>${escapeHtml(attributes.email || "—")}</td><td>${attributes.email ? attributes.email_verified === "true" ? "Yes" : "No" : "—"}</td><td>${badge(user.UserStatus, user.UserStatus === "CONFIRMED" ? "success" : "")}</td><td>${user.Enabled ? "Enabled" : "Disabled"}</td></tr>`;
  }).join("");
  poolPage(context, pool, "users", card("Users", `<form class="toolbar" data-user-search><select name="attribute" aria-label="Search attribute">${USER_SEARCH_ATTRIBUTES.map(([value, label]) => `<option value="${value}" ${value === state.attribute ? "selected" : ""}>${label}</option>`).join("")}</select><label class="filter"><span aria-hidden="true">⌕</span><input name="value" value="${escapeHtml(state.value)}" placeholder="Search users by attribute (starts with)"></label><button class="button" type="submit">Search</button></form>
    <div class="table-wrap">${rows ? `<table class="cognito-user-table"><thead><tr><th><span class="sr-only">Select</span></th><th>User name</th><th>Email address</th><th>Email verified</th><th>Confirmation status</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("U", state.value ? "No matching users" : "No users", state.value ? "No user has a value that starts with your search text." : "Create a user or let an application call SignUp.", '<button class="button primary" data-action="create-user">Create user</button>')}</div>
    <nav class="pagination" aria-label="Pagination"><button class="button" type="button" data-page="previous" ${state.page === 0 ? "disabled" : ""}>Previous page</button><span class="muted small">Page ${state.page + 1}</span><button class="button" type="button" data-page="next" ${listed.PaginationToken ? "" : "disabled"}>Next page</button></nav>`, '<button class="button danger" data-action="delete-user" disabled>Delete user</button><button class="button primary" data-action="create-user">Create user</button>', `(${values(listed.Users).length}${listed.PaginationToken ? "+" : ""})`));
  document.querySelector("[data-user-search]")?.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(event.target);
    userListState.set(poolId, { attribute: String(data.get("attribute")), value: String(data.get("value") || "").trim(), tokens: [undefined], page: 0 });
    context.route();
  });
  document.querySelector('[data-page="previous"]')?.addEventListener("click", () => { state.page = Math.max(0, state.page - 1); context.route(); });
  document.querySelector('[data-page="next"]')?.addEventListener("click", () => { state.page += 1; context.route(); });
  const remove = document.querySelector('[data-action="delete-user"]');
  document.querySelectorAll('input[name="selected-user"]').forEach(input => input.addEventListener("change", () => {
    remove.disabled = input.dataset.enabled === "true";
    remove.title = input.dataset.enabled === "true" ? "Disable user access before deleting the user" : "";
  }));
  remove?.addEventListener("click", () => {
    const selected = document.querySelector('input[name="selected-user"]:checked');
    if (!selected) return;
    context.confirmDeletion(selected.dataset.username, `Delete user ${selected.dataset.username}? This cannot be undone.`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(selected.value)}`, "DELETE", { confirmation: selected.value });
      context.toast("User deleted");
      await context.route();
    });
  });
  document.querySelectorAll('[data-action="create-user"]').forEach(button => button.addEventListener("click", () => createUserModal(context, pool)));
}

function createUserModal(context, pool) {
  const emailSignIn = pool.configuration.signIn.usernameAttributes.includes("email");
  const creationAttributes = values(pool.configuration.attributeSchema).filter(attribute =>
    !["email", "phone_number"].includes(attribute.name) && !attribute.developerOnly
  );
  const creationFields = creationAttributes.map((attribute, index) => {
    const permanence = attribute.mutable ? "Can be edited after creation." : "Immutable: this value can only be supplied while creating the user.";
    return `<div class="cognito-create-attribute">${attributeValueField(attribute, "", {
      fieldName: `attribute-${index}`,
      label: `${attribute.name}${attribute.required ? " (required)" : " (optional)"}`,
      required: attribute.required,
    })}<span class="hint">${escapeHtml(`${attribute.dataType}. ${permanence}`)}</span></div>`;
  }).join("");
  context.showModal("Create user", `<fieldset class="cognito-fieldset"><legend>Invitation message</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="radio" name="invitation" value="email" checked> Send an email invitation</label><label class="checkbox-label"><input type="radio" name="invitation" value="sms" disabled> Send an SMS invitation</label><label class="checkbox-label"><input type="radio" name="invitation" value="none"> Don't send an invitation</label></div><span class="hint">Email invitations are captured in the local SES Inbox. SMS needs Amazon SNS delivery, which is not implemented in this simulator.</span></fieldset>
    ${emailSignIn ? "" : '<div class="field"><label>User name</label><input name="username" required maxlength="128" autocomplete="off" placeholder="user-name"></div>'}
    <div class="field"><label>Email address</label><input name="email" type="email" ${emailSignIn ? "required" : ""} autocomplete="off" placeholder="user@example.test"></div><label class="checkbox-label"><input type="checkbox" name="emailVerified" checked> Mark email address as verified</label>
    <div class="field"><label>Phone number <span class="muted">(optional)</span></label><input name="phone" type="tel" autocomplete="off" placeholder="+12065550100"></div><label class="checkbox-label"><input type="checkbox" name="phoneVerified"> Mark phone number as verified</label>
    <fieldset class="cognito-fieldset"><legend>Temporary password</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="radio" name="passwordMode" value="generate" checked> Generate a password</label><label class="checkbox-label"><input type="radio" name="passwordMode" value="set"> Set a password</label></div><div class="field" data-set-password hidden><label>Password</label><input name="temporaryPassword" type="password" autocomplete="new-password"></div><span class="hint">The console never displays a generated temporary password; it is delivered only in the invitation.</span></fieldset>
    ${creationFields ? `<fieldset class="cognito-fieldset"><legend>Pool-defined attributes</legend>${creationFields}</fieldset>` : ""}`, "Create user", async data => {
    const email = String(data.get("email") || "").trim();
    const username = emailSignIn ? email : String(data.get("username") || "").trim();
    const phone = String(data.get("phone") || "").trim();
    const temporaryPassword = data.get("passwordMode") === "set" ? String(data.get("temporaryPassword") || "") : "";
    const userAttributes = [
      ...(email ? [{ Name: "email", Value: email }, { Name: "email_verified", Value: data.get("emailVerified") === "on" ? "true" : "false" }] : []),
      ...(phone ? [{ Name: "phone_number", Value: phone }, { Name: "phone_number_verified", Value: data.get("phoneVerified") === "on" ? "true" : "false" }] : []),
    ];
    creationAttributes.forEach((attribute, index) => {
      const value = String(data.get(`attribute-${index}`) || "");
      if (value) userAttributes.push({ Name: attribute.name, Value: value });
    });
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users`, "POST", {
      Username: username,
      UserAttributes: userAttributes,
      ...(temporaryPassword ? { TemporaryPassword: temporaryPassword } : {}),
      ...(data.get("invitation") === "email" && email ? { DesiredDeliveryMediums: ["EMAIL"] } : { MessageAction: "SUPPRESS" }),
    });
    context.toast("User created");
    await context.route();
  }, true, { refreshAfterSubmit: false });
  const setPassword = document.querySelector("[data-set-password]");
  document.querySelectorAll('input[name="passwordMode"]').forEach(input => input.addEventListener("change", () => {
    if (setPassword) setPassword.hidden = input.value !== "set" || !input.checked;
  }));
}

async function userDetailPage(context, poolId, sub) {
  const [pool, result, groupResult] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/users/${encoded(sub)}`),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/groups`),
  ]);
  const user = result.user;
  const events = await act("AdminListUserAuthEvents", { UserPoolId: poolId, Username: user.username, MaxResults: 10 }).catch(() => ({ AuthEvents: [] }));
  const presentNames = new Set(values(user.attributes).map(attribute => attribute.name));
  const addableAttributes = values(pool.configuration.attributeSchema).filter(attribute =>
    !presentNames.has(attribute.name) && attribute.mutable && !attribute.developerOnly
  );
  const attributes = values(user.attributes).map(attribute => {
    const schema = userAttributeSchema(pool, attribute.name) ?? (STANDARD_ATTRIBUTES.includes(attribute.name) ? { name: attribute.name, dataType: "String", mutable: true, required: false } : undefined);
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
  const eventRows = values(events.AuthEvents).map(event => `<tr><td>${escapeHtml(event.EventType)}</td><td>${escapeHtml(event.EventResponse || "Pass")}</td><td>${formatDate(event.CreationDate)}</td></tr>`).join("");
  const displayName = userAttribute(user, "email")?.value && pool.configuration.signIn.usernameAttributes.includes("email") ? userAttribute(user, "email").value : user.username;
  poolPage(context, pool, "users", `<p><a href="#/cognito/user-pools/${encoded(pool.id)}/users">← Back to users</a></p>
    ${card("User information", `<div class="card-body detail-grid">${detail([["User name", `<span class="mono">${escapeHtml(user.username)}</span>`], ["User ID (sub)", `<span class="mono">${escapeHtml(user.sub)}</span>`], ["Confirmation status", badge(user.status, user.status === "CONFIRMED" ? "success" : "")]])}${detail([["Status", user.enabled ? "Enabled" : "Disabled"], ["Active sessions", String(user.sessionCount)], ["MFA setting", escapeHtml(user.mfa.enabled.map(friendly).join(", ") || "None")]])}${detail([["Created time", formatDate(user.createdAt)], ["Last updated time", formatDate(user.updatedAt)]])}</div>`, `${actionsMenu("Actions", [
      ["reset-password", "Reset password"],
      ["set-password", "Set password"],
      user.status === "UNCONFIRMED" ? ["confirm-user", "Confirm account"] : null,
      [user.enabled ? "disable-user" : "enable-user", user.enabled ? "Disable user access" : "Enable user access"],
      ["sign-out", "Sign out of all sessions"],
      ["delete-user", "Delete user", { danger: true, disabled: user.enabled ? "Disable user access before deleting the user" : "" }],
    ])}`)}
    ${card("User attributes", `<div class="table-wrap">${attributes ? `<table><thead><tr><th>Name</th><th>Value</th><th>Verification</th><th>Actions</th></tr></thead><tbody>${attributes}</tbody></table>` : emptyState("A", "No attributes", "This user has no attributes yet.")}</div>`, `<button class="button primary" data-action="add-attribute" ${addableAttributes.length ? "" : 'disabled title="No assignable attributes are available"'}>Add attribute</button>`)}
    ${card("Group memberships", `<div class="card-body">${user.groups.length ? user.groups.map(group => `<a href="#/cognito/user-pools/${encoded(pool.id)}/groups/${encoded(group)}">${escapeHtml(group)}</a>`).join(", ") : '<span class="muted">This user is not in any group.</span>'}<p class="muted small">MFA methods: ${escapeHtml(user.mfa.enabled.map(friendly).join(", ") || "None")} · Preferred: ${escapeHtml(user.mfa.preferred ? friendly(user.mfa.preferred) : "None")}</p></div>`, '<button class="button" data-action="edit-groups">Add user to group</button><button class="button" data-action="edit-mfa">Edit MFA preference</button>')}
    ${card("User event history", `<div class="table-wrap">${eventRows ? `<table><thead><tr><th>Event type</th><th>Result</th><th>Time</th></tr></thead><tbody>${eventRows}</tbody></table>` : emptyState("E", "No events", "Sign-in events appear here after the user authenticates.")}</div>`)}`, "", { title: displayName, crumbs: [{ label: "Users", href: `#/cognito/user-pools/${encoded(pool.id)}/users` }, displayName] });
  const patch = body => consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "PATCH", body);
  const setEnabled = enable => context.showModal(enable ? "Enable user access" : "Disable user access", `<p>${enable ? "The user can sign in again." : "The user cannot sign in, and every refresh session is revoked. Already issued access tokens stay valid until they expire."}</p>`, enable ? "Enable" : "Disable", async () => {
    await patch({ action: enable ? "enable" : "disable" });
    context.toast(enable ? "User access enabled" : "User access disabled");
    await context.route();
  }, true, { refreshAfterSubmit: false });
  bindMenu({
    "reset-password": () => context.showModal("Reset password", `<p>Cognito sends a password-reset code to the user's verified email address (captured in the local SES Inbox) and the user must choose a new password at the next sign-in.</p>`, "Reset password", async () => {
      await patch({ action: "reset-password" });
      context.toast("Password reset code sent to the SES Inbox");
      await context.route();
    }, true, { refreshAfterSubmit: false }),
    "set-password": () => context.showModal("Set password", `<div class="field"><label>New password</label><input name="password" type="password" required autocomplete="new-password"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="permanent" checked> Set as permanent password</label><span class="hint">Clear this option to require a password change at next sign-in.</span></div>`, "Set password", async data => {
      await patch({ action: "set-password", password: String(data.get("password") || ""), permanent: data.get("permanent") === "on" });
      context.toast("Password updated");
      await context.route();
    }, true, { refreshAfterSubmit: false }),
    "confirm-user": () => context.showModal("Confirm account", `<p>Confirm ${escapeHtml(user.username)} without a confirmation code. The user can sign in with the password chosen at sign-up.</p>`, "Confirm", async () => {
      await act("AdminConfirmSignUp", { UserPoolId: pool.id, Username: user.username });
      context.toast("Account confirmed");
      await context.route();
    }, true, { refreshAfterSubmit: false }),
    "disable-user": () => setEnabled(false),
    "enable-user": () => setEnabled(true),
    "sign-out": () => context.showModal("Sign out of all sessions", "<p>Every refresh token for this user is revoked. Already issued access tokens stay valid until they expire.</p>", "Sign out", async () => {
      await patch({ action: "sign-out" });
      context.toast("User sessions revoked");
      await context.route();
    }, true, { refreshAfterSubmit: false }),
    "delete-user": () => context.confirmDeletion(user.sub, `Delete user ${user.username}?`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/users/${encoded(user.sub)}`, "DELETE", { confirmation: user.sub });
      context.toast("User deleted");
      location.hash = `#/cognito/user-pools/${encoded(pool.id)}/users`;
    }),
  });
  const updateAttribute = async (name, value, verified) => {
    const mutation = [{ Name: name, Value: value }];
    if (verifiableAttribute(name)) mutation.push({ Name: `${name}_verified`, Value: verified ? "true" : "false" });
    await patch({ action: "attributes", attributes: mutation });
  };
  document.querySelector('[data-action="add-attribute"]')?.addEventListener("click", () => {
    const options = addableAttributes.map(attribute => `<option value="${escapeHtml(attribute.name)}">${escapeHtml(attribute.name)} · ${escapeHtml(attribute.dataType)}</option>`).join("");
    context.showModal("Add user attribute", `<div class="field"><label>Attribute</label><select name="attribute" id="cognito-add-attribute" required>${options}</select><span class="hint">Only mutable attributes defined by this user pool are available.</span></div><div class="field"><label>Value</label><input name="value" required maxlength="2048"></div><div class="field" data-attribute-verification hidden><label class="checkbox-label"><input type="checkbox" name="verified"> Mark attribute as verified</label><span class="hint">Administrator verification is available only for email and phone number.</span></div>`, "Add attribute", async data => {
      await updateAttribute(String(data.get("attribute")), String(data.get("value") || "").trim(), data.get("verified") === "on");
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
    const schema = userAttributeSchema(pool, name) ?? { name, dataType: "String", mutable: true, required: false };
    if (!attribute || !schema.mutable || schema.developerOnly) return;
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
    context.confirmDeletion(name, `Remove ${name} from this user? The pool schema is unchanged.`, async () => {
      await patch({ action: "delete-attributes", attributeNames: [name] });
      context.toast("Attribute removed");
      await context.route();
    });
  }));
  document.querySelector('[data-action="edit-groups"]')?.addEventListener("click", () => {
    context.showModal("Edit group memberships", `<div class="cognito-checkbox-stack">${groupResult.groups.map(group => `<label class="checkbox-label"><input type="checkbox" name="groups" value="${escapeHtml(group.name)}" ${user.groups.includes(group.name) ? "checked" : ""}> ${escapeHtml(group.name)}</label>`).join("") || '<span class="muted">Create a group first.</span>'}</div>`, "Save memberships", async data => {
      const selected = values(data.getAll("groups")).map(String);
      for (const group of groupResult.groups) {
        const member = selected.includes(group.name);
        if (member !== user.groups.includes(group.name)) await patch({ action: "group", group: group.name, member });
      }
      context.toast("Group memberships updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="edit-mfa"]')?.addEventListener("click", () => {
    const enabled = user.mfa.enabled.includes("EMAIL_OTP");
    const emailAvailable = pool.configuration.mfa.enabledMethods.includes("EMAIL_OTP");
    context.showModal("Edit MFA preference", `${emailAvailable ? "" : '<div class="alert info">Turn on Email message MFA in Sign-in → Multi-factor authentication first. It needs Amazon SES email delivery (Authentication methods → Email).</div>'}<div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" ${enabled ? "checked" : ""} ${emailAvailable ? "" : "disabled"}> Enable email message MFA</label></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="preferred" ${user.mfa.preferred === "EMAIL_OTP" ? "checked" : ""} ${emailAvailable ? "" : "disabled"}> Make email message the preferred method</label></div><p class="muted small">Authenticator-app MFA is registered by the user with AssociateSoftwareToken and VerifySoftwareToken.</p>`, "Save MFA", async data => {
      const emailEnabled = data.get("enabled") === "on";
      await patch({ action: "mfa", emailEnabled, emailPreferred: emailEnabled && data.get("preferred") === "on" });
      context.toast("MFA preference updated");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
}

/* ---------------------------------------------------------------- groups */

async function roleOptions() {
  try {
    const { roles } = await rest("/_stacksim/api/iam/roles");
    return values(roles).map(role => role.arn).filter(Boolean);
  } catch {
    return [];
  }
}

function groupForm(group, roles) {
  return `<div class="field"><label>Group name</label><input name="name" required maxlength="128" autocomplete="off" value="${escapeHtml(group?.GroupName || "")}" ${group ? "readonly" : ""}></div><div class="field"><label>Description <span class="muted">(optional)</span></label><input name="description" maxlength="2048" value="${escapeHtml(group?.Description || "")}"></div><div class="field-row"><div class="field"><label>Precedence <span class="muted">(optional)</span></label><input name="precedence" type="number" min="0" value="${escapeHtml(group?.Precedence ?? "")}"><span class="hint">Lower values take priority when a user belongs to several groups with roles.</span></div><div class="field"><label>IAM role <span class="muted">(optional)</span></label><input name="roleArn" class="mono" list="cognito-role-options" value="${escapeHtml(group?.RoleArn || "")}" placeholder="arn:aws:iam::000000000000:role/name"><datalist id="cognito-role-options">${roles.map(arn => `<option value="${escapeHtml(arn)}">`).join("")}</datalist></div></div>`;
}

function groupInput(data) {
  const precedence = String(data.get("precedence") || "");
  const roleArn = String(data.get("roleArn") || "").trim();
  const description = String(data.get("description") || "");
  return {
    GroupName: String(data.get("name") || "").trim(),
    ...(description ? { Description: description } : {}),
    ...(precedence ? { Precedence: Number(precedence) } : {}),
    ...(roleArn ? { RoleArn: roleArn } : {}),
  };
}

async function groupsPage(context, poolId) {
  const [pool, result] = await Promise.all([loadPool(poolId), request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/groups`)]);
  const rows = result.groups.map(group => `<tr data-search-row="${escapeHtml(`${group.name} ${group.description || ""} ${group.roleArn || ""}`.toLowerCase())}"><td><input type="radio" name="selected-group" value="${escapeHtml(group.name)}" aria-label="Select ${escapeHtml(group.name)}"></td><td><a href="#/cognito/user-pools/${encoded(pool.id)}/groups/${encoded(group.name)}"><strong>${escapeHtml(group.name)}</strong></a></td><td>${escapeHtml(group.description || "—")}</td><td>${group.precedence ?? "—"}</td><td class="mono">${escapeHtml(group.roleArn || "—")}</td><td>${formatDate(group.createdAt)}</td></tr>`).join("");
  poolPage(context, pool, "groups", card("Groups", `<div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find groups"></label></div><div class="table-wrap">${rows ? `<table><thead><tr><th><span class="sr-only">Select</span></th><th>Group name</th><th>Description</th><th>Precedence</th><th>IAM role ARN</th><th>Created time</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("G", "No groups", "Create a group to add group and role claims to newly issued tokens.", '<button class="button primary" data-action="create-group">Create group</button>')}</div>`, '<button class="button danger" data-action="delete-group" disabled>Delete</button><button class="button primary" data-action="create-group">Create group</button>', `(${result.groups.length})`));
  context.bindTableFilter();
  const roles = await roleOptions();
  document.querySelectorAll('[data-action="create-group"]').forEach(button => button.addEventListener("click", () => context.showModal("Create group", groupForm(undefined, roles), "Create group", async data => {
    await act("CreateGroup", { UserPoolId: pool.id, ...groupInput(data) });
    context.toast("Group created");
    await context.route();
  }, true, { refreshAfterSubmit: false })));
  const remove = document.querySelector('[data-action="delete-group"]');
  document.querySelectorAll('input[name="selected-group"]').forEach(input => input.addEventListener("change", () => { remove.disabled = false; }));
  remove?.addEventListener("click", () => {
    const name = document.querySelector('input[name="selected-group"]:checked')?.value;
    if (!name) return;
    context.confirmDeletion(name, `Delete group ${name}? Memberships will be removed.`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/groups/${encoded(name)}`, "DELETE", { confirmation: name });
      context.toast("Group deleted");
      await context.route();
    });
  });
}

async function groupDetailPage(context, poolId, groupName) {
  const [pool, group, members, users] = await Promise.all([
    loadPool(poolId),
    act("GetGroup", { UserPoolId: poolId, GroupName: groupName }),
    act("ListUsersInGroup", { UserPoolId: poolId, GroupName: groupName, Limit: 60 }),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/users`),
  ]);
  const value = group.Group;
  const memberNames = new Set(values(members.Users).map(user => user.Username));
  const subOf = username => users.users.find(user => user.username === username)?.sub;
  const rows = values(members.Users).map(user => `<tr><td><a href="#/cognito/user-pools/${encoded(pool.id)}/users/${encoded(subOf(user.Username) || "")}">${escapeHtml(user.Username)}</a></td><td>${badge(user.UserStatus, user.UserStatus === "CONFIRMED" ? "success" : "")}</td><td>${user.Enabled ? "Enabled" : "Disabled"}</td><td><button class="button" data-remove-member="${escapeHtml(user.Username)}">Remove from group</button></td></tr>`).join("");
  poolPage(context, pool, "groups", `<p><a href="#/cognito/user-pools/${encoded(pool.id)}/groups">← Back to groups</a></p>
    ${card("Group information", `<div class="card-body detail-grid">${detail([["Group name", escapeHtml(value.GroupName)], ["Description", escapeHtml(value.Description || "—")]])}${detail([["Precedence", escapeHtml(value.Precedence ?? "—")], ["IAM role ARN", `<span class="mono">${escapeHtml(value.RoleArn || "—")}</span>`]])}${detail([["Created time", formatDate(value.CreationDate)], ["Last updated time", formatDate(value.LastModifiedDate)]])}</div>`, '<button class="button" data-action="edit-group">Edit</button><button class="button danger" data-action="delete-group">Delete</button>')}
    ${card("Group members", `<div class="table-wrap">${rows ? `<table><thead><tr><th>User name</th><th>Confirmation status</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("U", "No members", "Add users to this group to give them its claims.")}</div>`, '<button class="button primary" data-action="add-member">Add user to group</button>', `(${memberNames.size})`)}`, "", { title: value.GroupName, crumbs: [{ label: "Groups", href: `#/cognito/user-pools/${encoded(pool.id)}/groups` }, value.GroupName] });
  const roles = await roleOptions();
  document.querySelector('[data-action="edit-group"]')?.addEventListener("click", () => context.showModal(`Edit ${value.GroupName}`, groupForm(value, roles), "Save changes", async data => {
    const input = groupInput(data);
    await act("UpdateGroup", { UserPoolId: pool.id, GroupName: value.GroupName, Description: input.Description ?? "", ...(input.Precedence === undefined ? {} : { Precedence: input.Precedence }), ...(input.RoleArn ? { RoleArn: input.RoleArn } : {}) });
    context.toast("Group updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="delete-group"]')?.addEventListener("click", () => context.confirmDeletion(value.GroupName, `Delete group ${value.GroupName}? Memberships will be removed.`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/groups/${encoded(value.GroupName)}`, "DELETE", { confirmation: value.GroupName });
    context.toast("Group deleted");
    location.hash = `#/cognito/user-pools/${encoded(pool.id)}/groups`;
  }));
  document.querySelector('[data-action="add-member"]')?.addEventListener("click", () => {
    const candidates = users.users.filter(user => !memberNames.has(user.username));
    context.showModal("Add user to group", candidates.length ? `<div class="field"><label>User</label><select name="username">${candidates.map(user => `<option value="${escapeHtml(user.username)}">${escapeHtml(userAttribute(user, "email")?.value || user.username)}</option>`).join("")}</select></div>` : '<p class="muted">Every user is already in this group.</p>', "Add", async data => {
      if (!data.get("username")) return;
      await act("AdminAddUserToGroup", { UserPoolId: pool.id, GroupName: value.GroupName, Username: String(data.get("username")) });
      context.toast("User added to group");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelectorAll("[data-remove-member]").forEach(button => button.addEventListener("click", async () => {
    await act("AdminRemoveUserFromGroup", { UserPoolId: pool.id, GroupName: value.GroupName, Username: button.dataset.removeMember });
    context.toast("User removed from group");
    await context.route();
  }));
}

/* ---------------------------------------------------------------- app clients */

const UNITS = ["minutes", "hours", "days"];

function appClientForm(client, { create = false } = {}) {
  const flows = new Set(client?.ExplicitAuthFlows ?? ["ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
  const units = client?.TokenValidityUnits ?? { AccessToken: "hours", IdToken: "hours", RefreshToken: "days" };
  const validity = (name, label, value, unit) => `<div class="field"><label>${label}</label><div class="field-row"><input name="${name}" type="number" min="1" value="${escapeHtml(value)}" required><select name="${name}Unit">${UNITS.map(candidate => `<option value="${candidate}" ${candidate === unit ? "selected" : ""}>${candidate}</option>`).join("")}</select></div></div>`;
  const rotation = client?.RefreshTokenRotation?.Feature === "ENABLED";
  return `${create ? `<fieldset class="cognito-fieldset"><legend>Application type</legend>${APPLICATION_TYPES.map(([value, label], index) => `<label class="checkbox-label"><input type="radio" name="applicationType" value="${value}" ${index === 1 ? "checked" : ""}> ${escapeHtml(label)}</label>`).join("")}</fieldset>` : ""}
    <div class="field"><label>App client name</label><input name="name" required minlength="1" maxlength="128" pattern="[A-Za-z0-9_ +=,.@-]+" value="${escapeHtml(client?.ClientName || "")}" autocomplete="off"></div>
    ${create ? '<div class="field"><label>Return URL <span class="muted">(optional)</span></label><input name="returnUrl" placeholder="http://localhost:3000/callback"></div>' : ""}
    <fieldset class="cognito-fieldset" ${create ? "data-flows hidden" : ""}><legend>Authentication flows</legend><div class="cognito-checkbox-stack">${AUTH_FLOWS.map(([value, label]) => `<label class="checkbox-label"><input type="checkbox" name="flow:${value}" ${flows.has(value) ? "checked" : ""}> ${escapeHtml(label)} <span class="mono muted small">${value}</span></label>`).join("")}</div></fieldset>
    ${create ? "" : `<fieldset class="cognito-fieldset"><legend>Token expiration</legend>
      <div class="field"><label>Authentication flow session duration (minutes)</label><input name="authSession" type="number" min="3" max="15" value="${escapeHtml(client?.AuthSessionValidity ?? 3)}"></div>
      ${validity("refresh", "Refresh token expiration", client?.RefreshTokenValidity ?? 30, units.RefreshToken)}
      ${validity("access", "Access token expiration", client?.AccessTokenValidity ?? 1, units.AccessToken)}
      ${validity("id", "ID token expiration", client?.IdTokenValidity ?? 1, units.IdToken)}</fieldset>
    <fieldset class="cognito-fieldset"><legend>Advanced security configurations</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="revocation" ${client?.EnableTokenRevocation !== false ? "checked" : ""}> Enable token revocation</label><label class="checkbox-label"><input type="checkbox" name="existence" ${client?.PreventUserExistenceErrors !== "LEGACY" ? "checked" : ""}> Prevent user existence errors</label><label class="checkbox-label"><input type="checkbox" name="rotation" ${rotation ? "checked" : ""}> Enable refresh token rotation</label></div><div class="field"><label>Refresh token rotation grace period (seconds)</label><input name="grace" type="number" min="0" max="60" value="${escapeHtml(client?.RefreshTokenRotation?.RetryGracePeriodSeconds ?? 0)}"><span class="hint">Rotation requires GetTokensFromRefreshToken; Cognito rejects ALLOW_REFRESH_TOKEN_AUTH on a rotating client.</span></div></fieldset>`}`;
}

function flowsFrom(data) {
  return AUTH_FLOWS.map(([value]) => value).filter(value => data.get(`flow:${value}`) === "on");
}

/** UpdateUserPoolClient resets omitted settings, so editors start from the full DescribeUserPoolClient view. */
function clientUpdateInput(client) {
  return {
    UserPoolId: client.UserPoolId,
    ClientId: client.ClientId,
    ClientName: client.ClientName,
    RefreshTokenValidity: client.RefreshTokenValidity,
    AccessTokenValidity: client.AccessTokenValidity,
    IdTokenValidity: client.IdTokenValidity,
    TokenValidityUnits: client.TokenValidityUnits,
    ...(client.ReadAttributes ? { ReadAttributes: client.ReadAttributes } : {}),
    ...(client.WriteAttributes ? { WriteAttributes: client.WriteAttributes } : {}),
    ExplicitAuthFlows: client.ExplicitAuthFlows,
    PreventUserExistenceErrors: client.PreventUserExistenceErrors,
    EnableTokenRevocation: client.EnableTokenRevocation,
    AuthSessionValidity: client.AuthSessionValidity,
    RefreshTokenRotation: client.RefreshTokenRotation,
    SupportedIdentityProviders: client.SupportedIdentityProviders,
    CallbackURLs: client.CallbackURLs,
    LogoutURLs: client.LogoutURLs,
    ...(client.DefaultRedirectURI ? { DefaultRedirectURI: client.DefaultRedirectURI } : {}),
    AllowedOAuthFlows: client.AllowedOAuthFlows,
    AllowedOAuthScopes: client.AllowedOAuthScopes,
    AllowedOAuthFlowsUserPoolClient: client.AllowedOAuthFlowsUserPoolClient,
  };
}

async function describeClient(poolId, clientId) {
  return (await act("DescribeUserPoolClient", { UserPoolId: poolId, ClientId: clientId })).UserPoolClient;
}

function createAppClientModal(context, pool) {
  context.showModal("Create app client", appClientForm(undefined, { create: true }), "Create app client", async data => {
    const type = String(data.get("applicationType"));
    const returnUrl = String(data.get("returnUrl") || "").trim();
    const secret = type === "traditional" || type === "m2m";
    let oauth = {};
    if (type === "m2m") {
      const oauthSettings = await request(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth`);
      const scopes = oauthSettings.resourceServers.flatMap(server => server.scopes.map(scope => scope.fullName));
      if (!scopes.length) throw new Error("Machine-to-machine clients need a custom scope. Create a resource server on the Domain page first.");
      oauth = { AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ["client_credentials"], AllowedOAuthScopes: scopes };
    } else if (returnUrl) {
      oauth = { CallbackURLs: [returnUrl], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ["code"], AllowedOAuthScopes: ["openid", "email", "phone", "profile"], SupportedIdentityProviders: ["COGNITO"] };
    }
    const result = await act("CreateUserPoolClient", {
      UserPoolId: pool.id,
      ClientName: String(data.get("name") || "").trim(),
      GenerateSecret: secret,
      ExplicitAuthFlows: type === "m2m" ? ["ALLOW_REFRESH_TOKEN_AUTH"] : ["ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
      ...oauth,
    });
    context.toast("App client created");
    location.hash = `#/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(result.UserPoolClient.ClientId)}`;
  }, true, { refreshAfterSubmit: false });
}

async function appClientsPage(context, poolId) {
  const [pool, result] = await Promise.all([loadPool(poolId), request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients`)]);
  const rows = result.appClients.map(client => `<tr data-search-row="${escapeHtml(`${client.name} ${client.id}`.toLowerCase())}"><td><a href="#/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.id)}"><strong>${escapeHtml(client.name)}</strong></a></td><td class="mono">${escapeHtml(client.id)}</td><td>${client.hasSecret ? "Has a client secret" : "No client secret"}</td><td>${formatDate(client.createdAt)}</td></tr>`).join("");
  poolPage(context, pool, "app-clients", card("App clients", `<div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find app clients"></label></div><div class="table-wrap">${rows ? `<table class="cognito-client-table"><thead><tr><th>App client name</th><th>Client ID</th><th>Client secret</th><th>Created time</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("A", "No app clients", "Create an app client before an application signs up or authenticates users.", '<button class="button primary" data-action="create-app-client">Create app client</button>')}</div>`, '<button class="button primary" data-action="create-app-client">Create app client</button>', `(${result.appClients.length})`));
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-app-client"]').forEach(button => button.addEventListener("click", () => createAppClientModal(context, pool)));
}

async function appClientDetailPage(context, poolId, clientId, tab = "login-pages") {
  const [pool, local, client, oauth] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients/${encoded(clientId)}`),
    describeClient(poolId, clientId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/oauth`),
  ]);
  const summary = local.appClient;
  const root = `#/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.ClientId)}`;
  const validity = (value, unit) => `${value} ${escapeHtml(unit)}`;
  const info = card("App client information", `<div class="card-body detail-grid">${detail([["App client name", escapeHtml(client.ClientName)], ["Client ID", `<span class="mono">${escapeHtml(client.ClientId)}</span>`], ["Client secret", summary.hasSecret ? "Exists. StackSim never displays client secrets in the console; DescribeUserPoolClient returns it to API callers." : "No client secret"]])}${detail([["Authentication flows", values(client.ExplicitAuthFlows).map(flow => escapeHtml(flowLabel(flow))).join("<br>") || "None"], ["Authentication flow session duration", `${client.AuthSessionValidity} minutes`]])}${detail([["Refresh token expiration", validity(client.RefreshTokenValidity, client.TokenValidityUnits.RefreshToken)], ["Access token expiration", validity(client.AccessTokenValidity, client.TokenValidityUnits.AccessToken)], ["ID token expiration", validity(client.IdTokenValidity, client.TokenValidityUnits.IdToken)], ["Token revocation", client.EnableTokenRevocation ? "Enabled" : "Disabled"], ["Prevent user existence errors", friendly(client.PreventUserExistenceErrors)], ["Refresh token rotation", client.RefreshTokenRotation?.Feature === "ENABLED" ? `Enabled (${client.RefreshTokenRotation.RetryGracePeriodSeconds} s grace)` : "Disabled"]])}</div>`, '<button class="button" data-action="edit-app-client">Edit</button><button class="button danger" data-action="delete-app-client">Delete</button>');
  const customScopes = oauth.resourceServers.flatMap(server => server.scopes.map(scope => scope.fullName));
  const loginPages = card("Managed login pages configuration", `<div class="card-body detail-grid">${detail([["Allowed callback URLs", values(client.CallbackURLs).map(value => `<div class="mono cognito-wrap">${escapeHtml(value)}</div>`).join("") || "None"], ["Allowed sign-out URLs", values(client.LogoutURLs).map(value => `<div class="mono cognito-wrap">${escapeHtml(value)}</div>`).join("") || "None"], ["Identity providers", values(client.SupportedIdentityProviders).map(escapeHtml).join(", ") || "None"]])}${detail([["OAuth 2.0 grant types", values(client.AllowedOAuthFlows).map(flow => escapeHtml({ code: "Authorization code grant", implicit: "Implicit grant", client_credentials: "Client credentials" }[flow] || flow)).join("<br>") || "None"], ["OpenID Connect scopes", values(client.AllowedOAuthScopes).filter(scope => !scope.includes("/")).map(escapeHtml).join(", ") || "None"], ["Custom scopes", values(client.AllowedOAuthScopes).filter(scope => scope.includes("/")).map(escapeHtml).join(", ") || "None"]])}</div>${pool.domain ? `<div class="card-body"><a class="button" target="_blank" rel="noopener noreferrer" href="${escapeHtml(pool.domain.baseUrl)}/login?client_id=${encoded(client.ClientId)}&response_type=code&redirect_uri=${encoded(values(client.CallbackURLs)[0] || "")}">View login page</a></div>` : '<div class="card-body"><p class="muted">Create a domain on the Domain page to open managed login pages.</p></div>'}`, '<button class="button" data-action="edit-oauth">Edit</button>');
  const defaults = client.ReadAttributes === undefined && client.WriteAttributes === undefined;
  const readable = new Set(client.ReadAttributes ?? [...STANDARD_ATTRIBUTES, "email_verified", "phone_number_verified"]);
  const writable = new Set(client.WriteAttributes ?? STANDARD_ATTRIBUTES);
  const custom = values(pool.configuration.attributeSchema).map(attribute => attribute.name).filter(name => name.startsWith("custom:"));
  const permissionNames = [...STANDARD_ATTRIBUTES, "email_verified", "phone_number_verified", ...custom].sort();
  const permissions = card("Attribute permissions", `${defaults ? '<div class="card-body"><p class="muted">This app client uses the default permissions: it can read every standard attribute plus email_verified and phone_number_verified, and write every standard attribute. Custom attributes need an explicit list.</p></div>' : ""}<div class="table-wrap"><table><thead><tr><th>Attribute</th><th>Read</th><th>Write</th></tr></thead><tbody>${permissionNames.map(name => `<tr><td class="mono">${escapeHtml(name)}</td><td>${readable.has(name) ? "Yes" : "No"}</td><td>${name.endsWith("_verified") ? "—" : writable.has(name) ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table></div>`, '<button class="button" data-action="edit-attributes">Edit</button>');
  const quick = card("Quick setup guide", `<div class="card-body"><p>Configure an OpenID Connect library or the AWS SDK with these values.</p>${detail([["Authority (issuer)", `<span class="mono cognito-wrap">${escapeHtml(pool.issuer)}</span>`], ["Client ID", `<span class="mono">${escapeHtml(client.ClientId)}</span>`], ["Discovery URL", `<span class="mono cognito-wrap">${escapeHtml(new URL(pool.localDiscoveryPath, location.origin).href)}</span>`]])}</div>`);
  poolPage(context, pool, "app-clients", `<p><a href="#/cognito/user-pools/${encoded(pool.id)}/app-clients">← Back to app clients</a></p>${info}
    ${tabs([
      { label: "Quick setup guide", href: `${root}/quick-setup-guide`, active: tab === "quick-setup-guide" },
      { label: "Login pages", href: `${root}/login-pages`, active: tab === "login-pages" },
      { label: "Attribute permissions", href: `${root}/attribute-permissions`, active: tab === "attribute-permissions" },
    ])}
    ${tab === "quick-setup-guide" ? quick : tab === "attribute-permissions" ? permissions : loginPages}`, "", { title: `App client: ${client.ClientName}`, crumbs: [{ label: "App clients", href: `#/cognito/user-pools/${encoded(pool.id)}/app-clients` }, client.ClientName] });
  document.querySelector('[data-action="edit-app-client"]')?.addEventListener("click", () => context.showModal("Edit app client information", appClientForm(client), "Save changes", async data => {
    const input = clientUpdateInput(client);
    const rotation = data.get("rotation") === "on";
    Object.assign(input, {
      ClientName: String(data.get("name") || "").trim(),
      ExplicitAuthFlows: flowsFrom(data),
      AuthSessionValidity: Number(data.get("authSession")),
      RefreshTokenValidity: Number(data.get("refresh")),
      AccessTokenValidity: Number(data.get("access")),
      IdTokenValidity: Number(data.get("id")),
      TokenValidityUnits: { RefreshToken: String(data.get("refreshUnit")), AccessToken: String(data.get("accessUnit")), IdToken: String(data.get("idUnit")) },
      EnableTokenRevocation: data.get("revocation") === "on",
      PreventUserExistenceErrors: data.get("existence") === "on" ? "ENABLED" : "LEGACY",
      RefreshTokenRotation: { Feature: rotation ? "ENABLED" : "DISABLED", RetryGracePeriodSeconds: rotation ? Number(data.get("grace") || 0) : 0 },
    });
    await act("UpdateUserPoolClient", input);
    context.toast("App client updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="edit-oauth"]')?.addEventListener("click", () => {
    const providers = ["COGNITO", ...values(oauth.identityProviders).map(provider => provider.name)];
    const scopes = new Set(client.AllowedOAuthScopes);
    context.showModal("Edit managed login pages configuration", `<div class="field"><label>Allowed callback URLs</label><textarea name="callbackUrls" rows="3">${escapeHtml(values(client.CallbackURLs).join("\n"))}</textarea><span class="hint">One exact URL per line.</span></div><div class="field"><label>Allowed sign-out URLs <span class="muted">(optional)</span></label><textarea name="logoutUrls" rows="2">${escapeHtml(values(client.LogoutURLs).join("\n"))}</textarea></div>
      <fieldset class="cognito-fieldset"><legend>Identity providers</legend><div class="cognito-checkbox-stack">${providers.map(provider => `<label class="checkbox-label"><input type="checkbox" name="provider:${escapeHtml(provider)}" ${values(client.SupportedIdentityProviders).includes(provider) ? "checked" : ""}> ${escapeHtml(provider === "COGNITO" ? "Cognito user pool directory" : provider)}</label>`).join("")}</div></fieldset>
      <fieldset class="cognito-fieldset"><legend>OAuth 2.0 grant types</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="code" ${values(client.AllowedOAuthFlows).includes("code") ? "checked" : ""}> Authorization code grant</label><label class="checkbox-label"><input type="checkbox" name="implicit" ${values(client.AllowedOAuthFlows).includes("implicit") ? "checked" : ""}> Implicit grant</label><label class="checkbox-label"><input type="checkbox" name="clientCredentials" ${values(client.AllowedOAuthFlows).includes("client_credentials") ? "checked" : ""}> Client credentials</label></div><span class="hint">Local policy: authorization-code requests must use PKCE S256.</span></fieldset>
      <fieldset class="cognito-fieldset"><legend>OpenID Connect scopes</legend><div class="cognito-option-grid">${["openid", "email", "phone", "profile", "aws.cognito.signin.user.admin"].map(scope => `<label class="checkbox-label"><input type="checkbox" name="scope:${scope}" ${scopes.has(scope) ? "checked" : ""}> ${scope}</label>`).join("")}</div></fieldset>
      <fieldset class="cognito-fieldset"><legend>Custom scopes</legend><div class="cognito-checkbox-stack">${customScopes.map(scope => `<label class="checkbox-label"><input type="checkbox" name="scope:${escapeHtml(scope)}" ${scopes.has(scope) ? "checked" : ""}> ${escapeHtml(scope)}</label>`).join("") || '<span class="muted">Create a resource server on the Domain page to add custom scopes.</span>'}</div></fieldset>`, "Save changes", async data => {
      const callbackUrls = lines(data.get("callbackUrls"));
      const allowedOAuthFlows = ["code", "implicit", "client_credentials"].filter(flow => data.get(flow === "client_credentials" ? "clientCredentials" : flow) === "on");
      const allowedScopes = ["openid", "email", "phone", "profile", "aws.cognito.signin.user.admin", ...customScopes].filter(scope => data.get(`scope:${scope}`) === "on");
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.ClientId)}`, "PATCH", {
        callbackUrls,
        logoutUrls: lines(data.get("logoutUrls")),
        defaultRedirectUri: callbackUrls[0],
        allowedOAuthFlows,
        allowedOAuthScopes: allowedScopes,
        allowedOAuthFlowsUserPoolClient: allowedOAuthFlows.length > 0,
        supportedIdentityProviders: providers.filter(provider => data.get(`provider:${provider}`) === "on"),
      });
      context.toast("Managed login pages configuration saved");
      await context.route();
    }, true, { refreshAfterSubmit: false });
  });
  document.querySelector('[data-action="edit-attributes"]')?.addEventListener("click", () => context.showModal("Edit attribute read and write permissions", `<label class="checkbox-label"><input type="checkbox" name="defaults" ${defaults ? "checked" : ""}> Use the default permissions (every standard attribute)</label><div class="table-wrap"><table><thead><tr><th>Attribute</th><th>Read</th><th>Write</th></tr></thead><tbody>${permissionNames.map(name => `<tr><td class="mono">${escapeHtml(name)}</td><td><input type="checkbox" name="read:${escapeHtml(name)}" aria-label="Read ${escapeHtml(name)}" ${readable.has(name) ? "checked" : ""}></td><td>${name.endsWith("_verified") ? "—" : `<input type="checkbox" name="write:${escapeHtml(name)}" aria-label="Write ${escapeHtml(name)}" ${writable.has(name) ? "checked" : ""}>`}</td></tr>`).join("")}</tbody></table></div>`, "Save changes", async data => {
    const input = clientUpdateInput(client);
    delete input.ReadAttributes;
    delete input.WriteAttributes;
    if (data.get("defaults") !== "on") {
      input.ReadAttributes = permissionNames.filter(name => data.get(`read:${name}`) === "on");
      input.WriteAttributes = permissionNames.filter(name => !name.endsWith("_verified") && data.get(`write:${name}`) === "on");
    }
    await act("UpdateUserPoolClient", input);
    context.toast("Attribute permissions updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="delete-app-client"]')?.addEventListener("click", () => context.confirmDeletion(client.ClientId, `Delete app client ${client.ClientName} and revoke its refresh sessions?`, async () => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/app-clients/${encoded(client.ClientId)}`, "DELETE", { confirmation: client.ClientId });
    context.toast("App client deleted");
    location.hash = `#/cognito/user-pools/${encoded(pool.id)}/app-clients`;
  }));
}

/* ---------------------------------------------------------------- authentication */

async function authenticationMethodsPage(context, poolId) {
  const [pool, described] = await Promise.all([loadPool(poolId), describePool(poolId)]);
  const email = described.EmailConfiguration;
  const policy = described.Policies.PasswordPolicy;
  const firstFactors = values(described.Policies.SignInPolicy?.AllowedFirstAuthFactors);
  poolPage(context, pool, "authentication-methods", `
    ${card("Email", `<div class="card-body detail-grid">${detail([["Email provider", escapeHtml(friendly(email.EmailSendingAccount))], ["FROM email address", escapeHtml(email.From || (email.EmailSendingAccount === "DEVELOPER" ? "SES identity" : "no-reply@verificationemail.com"))]])}${detail([["REPLY-TO email address", escapeHtml(email.ReplyToEmailAddress || "—")], ["Configuration set", escapeHtml(email.ConfigurationSet || "—")], ["SES identity ARN", `<span class="mono cognito-wrap">${escapeHtml(email.SourceArn || "—")}</span>`]])}</div><div class="card-body"><a href="${escapeHtml(pool.inboxPath)}">Open filtered SES Inbox</a></div>`, '<button class="button" data-action="edit-email">Edit</button>')}
    ${card("SMS", `<div class="card-body">${boundaryNote("Not available locally", "SMS messages need Amazon SNS delivery, which is not implemented in this simulator. Phone numbers can be stored as attributes, but codes are never sent by SMS.")}</div>`)}
    ${card("Password policy", `<div class="card-body detail-grid">${detail([["Password minimum length", `${policy.MinimumLength} characters`], ["Password requirements", ["RequireNumbers:Contains at least 1 number", "RequireSymbols:Contains at least 1 special character", "RequireUppercase:Contains at least 1 uppercase letter", "RequireLowercase:Contains at least 1 lowercase letter"].filter(entry => policy[entry.split(":")[0]]).map(entry => escapeHtml(entry.split(":")[1])).join("<br>") || "None"]])}${detail([["Temporary passwords set by administrators expire in", `${policy.TemporaryPasswordValidityDays} days`], ["Prevent use of previous passwords", policy.PasswordHistorySize ? `${policy.PasswordHistorySize} previous passwords` : "Not active"]])}</div>`, '<button class="button" data-action="edit-password-policy">Edit</button>')}
    ${card("Passwordless", `<div class="card-body">${detail([["Choice-based sign-in options", firstFactors.map(factor => escapeHtml({ PASSWORD: "Password", EMAIL_OTP: "Email message one-time password" }[factor] || factor)).join(", ")]])}<p class="muted small">Edit the options on the Sign-in page. Passkeys need a WebAuthn browser ceremony, which is not implemented in this simulator.</p></div>`)}
  `);
  document.querySelector('[data-action="edit-email"]')?.addEventListener("click", () => context.showModal("Edit email configuration", `<fieldset class="cognito-fieldset"><legend>Email provider</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="radio" name="account" value="COGNITO_DEFAULT" ${email.EmailSendingAccount !== "DEVELOPER" ? "checked" : ""}> Send email with Cognito</label><label class="checkbox-label"><input type="radio" name="account" value="DEVELOPER" ${email.EmailSendingAccount === "DEVELOPER" ? "checked" : ""}> Send email with Amazon SES</label></div></fieldset><div class="field"><label>SES identity ARN</label><input name="sourceArn" class="mono" value="${escapeHtml(email.SourceArn || "")}" placeholder="arn:aws:ses:region:account:identity/example.com"><span class="hint">Verify the identity in the local SES console first; it must be in this account and Region.</span></div><div class="field"><label>FROM email address</label><input name="from" value="${escapeHtml(email.From || "")}"></div><div class="field"><label>REPLY-TO email address <span class="muted">(optional)</span></label><input name="replyTo" type="email" value="${escapeHtml(email.ReplyToEmailAddress || "")}"></div><div class="field"><label>Configuration set <span class="muted">(optional)</span></label><input name="configurationSet" value="${escapeHtml(email.ConfigurationSet || "")}"></div>`, "Save changes", async data => {
    const account = String(data.get("account"));
    const optional = name => String(data.get(name) || "").trim();
    await updatePool(pool.id, input => {
      input.EmailConfiguration = account === "DEVELOPER"
        ? { EmailSendingAccount: "DEVELOPER", SourceArn: optional("sourceArn"), ...(optional("from") ? { From: optional("from") } : {}), ...(optional("replyTo") ? { ReplyToEmailAddress: optional("replyTo") } : {}), ...(optional("configurationSet") ? { ConfigurationSet: optional("configurationSet") } : {}) }
        : { EmailSendingAccount: "COGNITO_DEFAULT" };
    });
    context.toast("Email configuration updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="edit-password-policy"]')?.addEventListener("click", () => context.showModal("Edit password policy", `<div class="field"><label>Password minimum length</label><input name="minimumLength" type="number" min="6" max="99" value="${policy.MinimumLength}" required></div><fieldset class="cognito-fieldset"><legend>Password requirements</legend><div class="cognito-checkbox-stack">${[["RequireNumbers", "Contains at least 1 number"], ["RequireSymbols", "Contains at least 1 special character"], ["RequireUppercase", "Contains at least 1 uppercase letter"], ["RequireLowercase", "Contains at least 1 lowercase letter"]].map(([name, label]) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${policy[name] ? "checked" : ""}> ${label}</label>`).join("")}</div></fieldset><div class="field"><label>Temporary passwords set by administrators expire in (days)</label><input name="temporary" type="number" min="1" max="365" value="${policy.TemporaryPasswordValidityDays}" required></div><div class="field"><label>Prevent use of previous passwords (0 to turn off)</label><input name="history" type="number" min="0" max="24" value="${policy.PasswordHistorySize || 0}"><span class="hint">Needs the Essentials or Plus feature plan.</span></div>`, "Save changes", async data => {
    await updatePool(pool.id, input => {
      input.Policies = {
        ...input.Policies,
        PasswordPolicy: {
          MinimumLength: Number(data.get("minimumLength")),
          RequireNumbers: data.get("RequireNumbers") === "on",
          RequireSymbols: data.get("RequireSymbols") === "on",
          RequireUppercase: data.get("RequireUppercase") === "on",
          RequireLowercase: data.get("RequireLowercase") === "on",
          TemporaryPasswordValidityDays: Number(data.get("temporary")),
          PasswordHistorySize: Number(data.get("history") || 0),
        },
      };
    });
    context.toast("Password policy updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
}

const RECOVERY_OPTIONS = [
  ["email", "Email only", [{ Name: "verified_email", Priority: 1 }]],
  ["email-phone", "Email if available, otherwise SMS", [{ Name: "verified_email", Priority: 1 }, { Name: "verified_phone_number", Priority: 2 }]],
  ["phone-email", "SMS if available, otherwise email", [{ Name: "verified_phone_number", Priority: 1 }, { Name: "verified_email", Priority: 2 }]],
  ["admin", "None – users must contact an administrator to reset their passwords", [{ Name: "admin_only", Priority: 1 }]],
];

async function signInPage(context, poolId) {
  const [pool, described] = await Promise.all([loadPool(poolId), describePool(poolId)]);
  const configuration = pool.configuration;
  const identifiers = configuration.signIn.usernameAttributes.includes("email")
    ? "Email"
    : configuration.signIn.aliasAttributes.length
      ? `User name, ${configuration.signIn.aliasAttributes.map(name => name === "email" ? "email" : "preferred user name").join(", ")}`
      : "User name";
  const recovery = values(described.AccountRecoverySetting?.RecoveryMechanisms).sort((left, right) => left.Priority - right.Priority);
  const recoveryKey = RECOVERY_OPTIONS.find(([, , mechanisms]) => JSON.stringify(mechanisms.map(item => item.Name)) === JSON.stringify(recovery.map(item => item.Name)))?.[0] ?? "email";
  const firstFactors = values(described.Policies.SignInPolicy?.AllowedFirstAuthFactors);
  const methods = configuration.mfa.enabledMethods;
  poolPage(context, pool, "sign-in", `
    ${card("Options for user pool sign-in", `<div class="card-body detail-grid">${detail([["Cognito user pool sign-in options", escapeHtml(identifiers)], ["User name case sensitivity", configuration.signIn.caseSensitive ? "Case sensitive" : "Case insensitive"]])}<p class="muted small">Sign-in identifiers and case sensitivity are fixed when the user pool is created.</p></div>`)}
    ${card("Options for choice-based sign-in", `<div class="card-body">${detail([["Available authentication methods", firstFactors.map(factor => escapeHtml({ PASSWORD: "Password", EMAIL_OTP: "Email message one-time password" }[factor] || factor)).join(", ")]])}</div>`, '<button class="button" data-action="edit-first-factors">Edit</button>')}
    ${card("Multi-factor authentication", `<div class="card-body">${detail([["MFA enforcement", escapeHtml(friendly(configuration.mfa.mode))], ["MFA methods", methods.map(method => escapeHtml(friendly(method))).join(", ") || "None"]])}</div>`, '<button class="button" data-action="edit-mfa">Edit</button>')}
    ${card("User account recovery", `<div class="card-body">${detail([["Self-service account recovery", recoveryKey === "admin" ? "Disabled" : "Enabled"], ["Recovery message delivery method", escapeHtml(RECOVERY_OPTIONS.find(([key]) => key === recoveryKey)?.[1] ?? "Email only")]])}</div>`, '<button class="button" data-action="edit-recovery">Edit</button>')}
  `);
  document.querySelector('[data-action="edit-mfa"]')?.addEventListener("click", () => context.showModal("Edit multi-factor authentication", `<fieldset class="cognito-fieldset"><legend>MFA enforcement</legend><div class="cognito-checkbox-stack">${["ON", "OPTIONAL", "OFF"].map(mode => `<label class="checkbox-label"><input type="radio" name="mode" value="${mode}" ${configuration.mfa.mode === mode ? "checked" : ""}> ${escapeHtml(friendly(mode))}</label>`).join("")}</div></fieldset><fieldset class="cognito-fieldset"><legend>MFA methods</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" name="totp" ${methods.includes("SOFTWARE_TOKEN_MFA") ? "checked" : ""}> Authenticator apps</label><label class="checkbox-label"><input type="checkbox" name="email" ${methods.includes("EMAIL_OTP") ? "checked" : ""}> Email message</label><label class="checkbox-label"><input type="checkbox" name="sms" disabled> SMS message</label></div><span class="hint">Email message MFA needs the Essentials or Plus plan and Amazon SES email delivery. SMS needs Amazon SNS, which is not implemented in this simulator.</span></fieldset>`, "Save changes", async data => {
    const email = data.get("email") === "on";
    const mfa = await act("GetUserPoolMfaConfig", { UserPoolId: pool.id });
    await act("SetUserPoolMfaConfig", {
      UserPoolId: pool.id,
      MfaConfiguration: String(data.get("mode")),
      SoftwareTokenMfaConfiguration: { Enabled: data.get("totp") === "on" },
      ...(email ? { EmailMfaConfiguration: mfa.EmailMfaConfiguration ?? { Message: "Your verification code is {####}.", Subject: "Your verification code" } } : {}),
    });
    context.toast("Multi-factor authentication updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="edit-recovery"]')?.addEventListener("click", () => context.showModal("Edit user account recovery", `<fieldset class="cognito-fieldset"><legend>Delivery method for user account recovery messages</legend><div class="cognito-checkbox-stack">${RECOVERY_OPTIONS.map(([key, label]) => `<label class="checkbox-label"><input type="radio" name="recovery" value="${key}" ${key === recoveryKey ? "checked" : ""}> ${escapeHtml(label)}</label>`).join("")}</div><span class="hint">A verified phone number cannot receive a code locally; email is the working channel.</span></fieldset>`, "Save changes", async data => {
    const mechanisms = RECOVERY_OPTIONS.find(([key]) => key === data.get("recovery"))?.[2] ?? RECOVERY_OPTIONS[0][2];
    await updatePool(pool.id, input => { input.AccountRecoverySetting = { RecoveryMechanisms: mechanisms }; });
    context.toast("User account recovery updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="edit-first-factors"]')?.addEventListener("click", () => context.showModal("Edit options for choice-based sign-in", `<div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="checkbox" checked disabled> Password</label><label class="checkbox-label"><input type="checkbox" name="emailOtp" ${firstFactors.includes("EMAIL_OTP") ? "checked" : ""}> Email message one-time password</label><label class="checkbox-label"><input type="checkbox" disabled> SMS message one-time password</label><label class="checkbox-label"><input type="checkbox" disabled> Passkey</label></div><span class="hint">Choice-based sign-in needs ALLOW_USER_AUTH on the app client. Email one-time passwords need Amazon SES email delivery; SMS and passkeys are not implemented in this simulator.</span>`, "Save changes", async data => {
    await updatePool(pool.id, input => {
      input.Policies = { ...input.Policies, SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", ...(data.get("emailOtp") === "on" ? ["EMAIL_OTP"] : [])] } };
    });
    context.toast("Choice-based sign-in options updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
}

async function signUpPage(context, poolId) {
  const [pool, described] = await Promise.all([loadPool(poolId), describePool(poolId)]);
  const configuration = pool.configuration;
  const signUp = configuration.selfServiceSignUp;
  const keepOriginal = values(described.UserAttributeUpdateSettings?.AttributesRequireVerificationBeforeUpdate).includes("email");
  const customAttributes = values(configuration.attributeSchema).filter(attribute => attribute.name.startsWith("custom:"));
  const customAttributeRows = customAttributes.map(attribute => {
    const constraints = attribute.dataType === "String"
      ? `${attribute.stringConstraints?.minLength ?? "0"}–${attribute.stringConstraints?.maxLength ?? "2,048"} characters`
      : attribute.dataType === "Number"
        ? `${attribute.numberConstraints?.minValue ?? "No minimum"} to ${attribute.numberConstraints?.maxValue ?? "no maximum"}`
        : "Type validation";
    return `<tr><td class="mono">${escapeHtml(attribute.name)}</td><td>${escapeHtml(attribute.dataType)}</td><td>${attribute.mutable ? "Mutable" : badge("Immutable")}</td><td>${escapeHtml(constraints)}</td></tr>`;
  }).join("");
  poolPage(context, pool, "sign-up", `
    ${card("Self-service sign-up", `<div class="card-body">${detail([["Self-registration", signUp.enabled ? badge("Enabled", "success") : badge("Disabled")]])}</div>`, '<button class="button" data-action="edit-self-registration">Edit</button>')}
    ${card("Attribute verification and user account confirmation", `<div class="card-body detail-grid">${detail([["Cognito-assisted verification and confirmation", signUp.autoVerifiedAttributes.includes("email") ? "Send email message, verify email address" : "Not active"], ["Verifying attribute changes", keepOriginal ? "Keep original attribute value active when an update is pending" : "Not active"]])}<p class="muted small">Codes are delivered to the local SES Inbox and never shown in the console. <a href="${escapeHtml(pool.inboxPath)}">Filtered SES Inbox</a></p></div>`, '<button class="button" data-action="edit-verification">Edit</button>')}
    ${card("Required attributes", `<div class="card-body"><p>${signUp.requiredAttributes.map(escapeHtml).join(", ") || "None"}</p><p class="muted small">Required attributes are fixed when the user pool is created.</p></div>`)}
    ${card("Custom attributes", `<div class="alert warning"><strong>Permanent schema</strong><br>Custom attribute definitions cannot be removed after they are added. Immutable values can be supplied only while creating a user.</div><div class="table-wrap">${customAttributeRows ? `<table><thead><tr><th>Name</th><th>Type</th><th>Mutability</th><th>Constraints</th></tr></thead><tbody>${customAttributeRows}</tbody></table>` : emptyState("A", "No custom attributes", "Add a schema definition to make an application-specific attribute available to users.")}</div>`, '<button class="button primary" data-action="add-custom-attribute">Add custom attributes</button>', `(${customAttributes.length})`)}
  `);
  document.querySelector('[data-action="edit-self-registration"]')?.addEventListener("click", () => context.showModal("Edit self-service sign-up", `<label class="checkbox-label"><input type="checkbox" name="enabled" ${signUp.enabled ? "checked" : ""}> Enable self-registration</label><span class="hint">When self-registration is off, only administrators can create users.</span>`, "Save changes", async data => {
    await updatePool(pool.id, input => { input.AdminCreateUserConfig = { ...input.AdminCreateUserConfig, AllowAdminCreateUserOnly: data.get("enabled") !== "on" }; });
    context.toast("Self-service sign-up updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="edit-verification"]')?.addEventListener("click", () => context.showModal("Edit attribute verification and user account confirmation", `<label class="checkbox-label"><input type="checkbox" name="assisted" ${signUp.autoVerifiedAttributes.includes("email") ? "checked" : ""}> Allow Cognito to automatically send messages to verify and confirm: send email message, verify email address</label><label class="checkbox-label"><input type="checkbox" name="keepOriginal" ${keepOriginal ? "checked" : ""}> Keep original attribute value active when an update is pending (email address)</label>`, "Save changes", async data => {
    const assisted = data.get("assisted") === "on";
    await updatePool(pool.id, input => {
      input.AutoVerifiedAttributes = assisted ? ["email"] : [];
      if (assisted && data.get("keepOriginal") === "on") input.UserAttributeUpdateSettings = { AttributesRequireVerificationBeforeUpdate: ["email"] };
      else delete input.UserAttributeUpdateSettings;
    });
    context.toast("Attribute verification updated");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelector('[data-action="add-custom-attribute"]')?.addEventListener("click", () => {
    context.showModal("Add custom attribute", `<div class="alert warning"><strong>This cannot be undone</strong><br>The schema definition remains part of the user pool after it is added.</div><div class="field-row"><div class="field"><label>Name</label><input name="name" required maxlength="20" pattern="[A-Za-z][A-Za-z0-9_]{0,19}" autocomplete="off" placeholder="department"></div><div class="field"><label>Type</label><select name="dataType" id="cognito-custom-attribute-type"><option value="String">String</option><option value="Number">Number</option><option value="Boolean">Boolean (API type; StackSim extra)</option><option value="DateTime">DateTime (API type; StackSim extra)</option></select></div></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="mutable" checked> Mutable</label><span class="hint">Clear this only when the value must be fixed at user creation.</span></div><fieldset class="cognito-fieldset" data-string-constraints><legend>String constraints</legend><div class="field-row"><div class="field"><label>Minimum length</label><input name="stringMin" type="number" min="0" max="2048"></div><div class="field"><label>Maximum length</label><input name="stringMax" type="number" min="0" max="2048"></div></div></fieldset><fieldset class="cognito-fieldset" data-number-constraints hidden><legend>Number constraints</legend><div class="field-row"><div class="field"><label>Minimum value</label><input name="numberMin" type="number" step="any"></div><div class="field"><label>Maximum value</label><input name="numberMax" type="number" step="any"></div></div></fieldset>`, "Add custom attribute", async data => {
      const dataType = String(data.get("dataType"));
      const stringMin = String(data.get("stringMin") || "");
      const stringMax = String(data.get("stringMax") || "");
      const numberMin = String(data.get("numberMin") || "");
      const numberMax = String(data.get("numberMax") || "");
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/custom-attributes`, "POST", {
        CustomAttributes: [{
          Name: String(data.get("name") || "").trim(),
          AttributeDataType: dataType,
          Mutable: data.get("mutable") === "on",
          ...(dataType === "String" && (stringMin || stringMax) ? { StringAttributeConstraints: { ...(stringMin ? { MinLength: stringMin } : {}), ...(stringMax ? { MaxLength: stringMax } : {}) } } : {}),
          ...(dataType === "Number" && (numberMin || numberMax) ? { NumberAttributeConstraints: { ...(numberMin ? { MinValue: numberMin } : {}), ...(numberMax ? { MaxValue: numberMax } : {}) } } : {}),
        }],
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

async function messageTemplatesPage(context, poolId) {
  const [pool, described, mfa] = await Promise.all([loadPool(poolId), describePool(poolId), act("GetUserPoolMfaConfig", { UserPoolId: poolId })]);
  const verification = described.VerificationMessageTemplate;
  const invitation = described.AdminCreateUserConfig.InviteMessageTemplate || {};
  const templateCard = (title, subject, message, action) => card(title, `<div class="card-body">${detail([["Subject", escapeHtml(subject || "—")], ["Message", `<span class="cognito-wrap">${escapeHtml(message || "—")}</span>`]])}</div>`, `<button class="button" data-action="${action}">Edit</button>`);
  poolPage(context, pool, "message-templates", `
    ${templateCard("Verification message", verification.EmailSubject, verification.EmailMessage, "edit-verification-template")}
    ${templateCard("Invitation message", invitation.EmailSubject, invitation.EmailMessage, "edit-invitation-template")}
    ${templateCard("MFA message", mfa.EmailMfaConfiguration?.Subject, mfa.EmailMfaConfiguration?.Message, "edit-mfa-template")}
    ${boundaryNote("Placeholders", "Messages must contain {####} for the code; invitations also contain {username}. Link-based verification is not implemented in this simulator.")}
  `);
  const templateModal = (title, subject, message, save) => context.showModal(title, `<div class="field"><label>Email subject</label><input name="subject" required maxlength="140" value="${escapeHtml(subject || "")}"></div><div class="field"><label>Email message</label><textarea name="message" rows="5" required>${escapeHtml(message || "")}</textarea></div>`, "Save changes", async data => {
    await save(String(data.get("subject") || ""), String(data.get("message") || ""));
    context.toast("Message template updated");
    await context.route();
  }, true, { refreshAfterSubmit: false });
  document.querySelector('[data-action="edit-verification-template"]')?.addEventListener("click", () => templateModal("Edit verification message", verification.EmailSubject, verification.EmailMessage, (subject, message) => updatePool(pool.id, input => {
    input.VerificationMessageTemplate = { ...input.VerificationMessageTemplate, EmailSubject: subject, EmailMessage: message };
  })));
  document.querySelector('[data-action="edit-invitation-template"]')?.addEventListener("click", () => templateModal("Edit invitation message", invitation.EmailSubject, invitation.EmailMessage, (subject, message) => updatePool(pool.id, input => {
    input.AdminCreateUserConfig = { ...input.AdminCreateUserConfig, InviteMessageTemplate: { ...invitation, EmailSubject: subject, EmailMessage: message } };
  })));
  document.querySelector('[data-action="edit-mfa-template"]')?.addEventListener("click", () => templateModal("Edit MFA message", mfa.EmailMfaConfiguration?.Subject, mfa.EmailMfaConfiguration?.Message, (subject, message) => act("SetUserPoolMfaConfig", {
    UserPoolId: pool.id,
    MfaConfiguration: mfa.MfaConfiguration,
    SoftwareTokenMfaConfiguration: mfa.SoftwareTokenMfaConfiguration,
    EmailMfaConfiguration: { Subject: subject, Message: message },
  })));
}

/* ---------------------------------------------------------------- social and external providers */

async function identityProvidersPage(context, poolId) {
  const [pool, oauth] = await Promise.all([loadPool(poolId), request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/oauth`)]);
  const identityProviders = oauth.identityProviders || [];
  const providerRows = identityProviders.map(provider => `<tr><td><strong>${escapeHtml(provider.name)}</strong></td><td>${badge(provider.type === "OIDC" ? "OpenID Connect" : provider.type, "success")}</td><td>${provider.idpIdentifiers.map(identifier => badge(identifier)).join(" ") || "None"}</td><td>${Object.entries(provider.attributeMapping).map(([target, source]) => `<span class="mono small">${escapeHtml(target)} ← ${escapeHtml(source)}</span>`).join("<br>") || "None"}${provider.certificateFingerprint ? `<div class="mono muted small">SHA-256 ${escapeHtml(provider.certificateFingerprint)}</div>` : ""}</td><td>${provider.enabledClientIds.length}</td><td><div class="actions"><button class="button" data-test-provider="${escapeHtml(provider.name)}">Test</button><button class="button" data-edit-provider="${escapeHtml(provider.name)}">Edit</button><button class="button danger" data-delete-provider="${escapeHtml(provider.name)}">Delete</button></div></td></tr>`).join("");
  poolPage(context, pool, "identity-providers", `${card("Social and external providers", `<div class="table-wrap">${providerRows ? `<table><thead><tr><th>Provider</th><th>Type</th><th>Identifiers</th><th>Attribute mapping</th><th>App clients</th><th>Actions</th></tr></thead><tbody>${providerRows}</tbody></table>` : emptyState("I", "No external providers", "Add an OpenID Connect or SAML identity provider. Loopback providers work by default; public network access is controlled when StackSim starts.")}</div><div class="alert info"><strong>Network boundary</strong><br>Loopback providers work by default. Private-network providers are blocked. Public providers require STACKSIM_COGNITO_ALLOW_PUBLIC_IDP=true and HTTPS. Metadata and link-local targets are always blocked.</div>`, '<button class="button primary" data-action="create-identity-provider">Add identity provider</button>', `(${identityProviders.length})`)}
    ${card("SAML signing certificate", `<div class="card-body"><p class="muted">Exporting the pool's SAML signing certificate (GetSigningCertificate) is not implemented in this simulator.</p></div>`, '<button class="button" disabled title="Not implemented in this simulator">View signing certificate</button>')}`);
  const mappingRows = mapping => {
    const entries = Object.entries(mapping || { email: "email" });
    return `<fieldset class="cognito-fieldset"><legend>Map attributes between the provider and your user pool</legend><div data-mapping-rows>${[...entries, ["", ""], ["", ""]].map(([target, source], index) => `<div class="field-row"><div class="field"><label>User pool attribute</label><input name="target-${index}" value="${escapeHtml(target)}" list="cognito-attribute-names"></div><div class="field"><label>Provider attribute</label><input name="source-${index}" value="${escapeHtml(source)}"></div></div>`).join("")}</div><datalist id="cognito-attribute-names">${[...STANDARD_ATTRIBUTES, ...values(pool.configuration.attributeSchema).map(attribute => attribute.name)].map(name => `<option value="${escapeHtml(name)}">`).join("")}</datalist></fieldset>`;
  };
  const readMapping = data => {
    const mapping = {};
    for (let index = 0; index < 64; index += 1) {
      const target = String(data.get(`target-${index}`) ?? "").trim();
      const source = String(data.get(`source-${index}`) ?? "").trim();
      if (data.get(`target-${index}`) === null) break;
      if (target && source) mapping[target] = source;
    }
    return mapping;
  };
  const providerForm = (type, provider) => {
    const details = provider?.providerDetails || {};
    const common = `<div class="field"><label>Provider name</label><input name="providerName" required maxlength="32" pattern="[A-Za-z0-9._-]+" ${provider ? "readonly" : ""} value="${escapeHtml(provider?.name || "")}"></div>`;
    const identifiers = `<div class="field"><label>Identifiers <span class="muted">(optional, one per line)</span></label><textarea name="identifiers" rows="2">${escapeHtml(values(provider?.idpIdentifiers).join("\n"))}</textarea></div>`;
    if (type === "SAML") {
      return `${common}<div class="field"><label>Metadata document endpoint URL</label><input name="metadataUrl" value="${escapeHtml(details.MetadataURL || "")}" placeholder="http://localhost:9000/metadata"></div><div class="field"><label>Metadata document <span class="muted">(or paste XML)</span></label><textarea name="metadataFile" rows="4">${escapeHtml(details.MetadataFile || "")}</textarea></div><label class="checkbox-label"><input type="checkbox" name="idpInit" ${details.IDPInit === "true" ? "checked" : ""}> Accept SAML assertions initiated by the identity provider</label>${identifiers}${mappingRows(provider?.attributeMapping)}`;
    }
    return `${common}<div class="field"><label>Client ID</label><input name="clientId" required value="${escapeHtml(details.client_id || "")}"></div><div class="field"><label>Client secret ${provider ? '<span class="muted">(leave blank to keep the current secret)</span>' : ""}</label><input name="clientSecret" type="password" autocomplete="off"></div><div class="field"><label>Authorized scopes</label><input name="scopes" value="${escapeHtml(details.authorize_scopes || "openid email profile")}"></div><div class="field"><label>Issuer URL</label><input name="issuer" required value="${escapeHtml(details.oidc_issuer || "")}" placeholder="http://localhost:9000"></div><div class="field"><label>Attribute request method</label><select name="method"><option value="GET" ${details.attributes_request_method !== "POST" ? "selected" : ""}>GET</option><option value="POST" ${details.attributes_request_method === "POST" ? "selected" : ""}>POST</option></select></div>${identifiers}${mappingRows(provider?.attributeMapping)}`;
  };
  const readDetails = (type, data, provider) => type === "SAML"
    ? { ...(String(data.get("metadataUrl") || "").trim() ? { MetadataURL: String(data.get("metadataUrl")).trim() } : { MetadataFile: String(data.get("metadataFile") || "") }), ...(data.get("idpInit") === "on" ? { IDPInit: "true" } : {}) }
    : {
        client_id: String(data.get("clientId") || "").trim(),
        ...(String(data.get("clientSecret") || "") ? { client_secret: String(data.get("clientSecret")) } : {}),
        authorize_scopes: String(data.get("scopes") || "").trim(),
        oidc_issuer: String(data.get("issuer") || "").trim(),
        attributes_request_method: String(data.get("method") || "GET"),
        ...(provider ? {} : {}),
      };
  document.querySelector('[data-action="create-identity-provider"]')?.addEventListener("click", () => {
    const cards = [["Facebook", "social"], ["Google", "social"], ["Login with Amazon", "social"], ["Sign in with Apple", "social"], ["SAML", "SAML"], ["OpenID Connect (OIDC)", "OIDC"]];
    context.showModal("Add identity provider", `<div class="cognito-option-grid">${cards.map(([label, type], index) => `<label class="checkbox-label"><input type="radio" name="kind" value="${type}" ${index === 5 ? "checked" : ""} ${type === "social" ? "disabled" : ""}> ${escapeHtml(label)}</label>`).join("")}</div><p class="hint">Social providers need their public sign-in services, which StackSim does not contact. Use OpenID Connect against a local or test identity provider instead.</p><div data-provider-form>${providerForm("OIDC")}</div>`, "Add identity provider", async data => {
      const type = String(data.get("kind"));
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/identity-providers`, "POST", {
        ProviderName: String(data.get("providerName") || "").trim(),
        ProviderType: type,
        ProviderDetails: readDetails(type, data),
        AttributeMapping: readMapping(data),
        IdpIdentifiers: lines(data.get("identifiers")),
      });
      context.toast("Identity provider added");
      await context.route();
    }, true, { refreshAfterSubmit: false });
    document.querySelectorAll('input[name="kind"]').forEach(input => input.addEventListener("change", () => {
      const holder = document.querySelector("[data-provider-form]");
      if (!holder || !input.checked) return;
      holder.innerHTML = providerForm(input.value);
      associateFormLabels(holder);
    }));
  });
  document.querySelectorAll("[data-edit-provider]").forEach(button => button.addEventListener("click", () => {
    const provider = identityProviders.find(value => value.name === button.dataset.editProvider);
    context.showModal(`Edit ${provider.name}`, providerForm(provider.type, provider), "Save changes", async data => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/identity-providers/${encoded(provider.name)}`, "PATCH", {
        ProviderDetails: readDetails(provider.type, data, provider),
        AttributeMapping: readMapping(data),
        IdpIdentifiers: lines(data.get("identifiers")),
      });
      context.toast("Identity provider updated");
      await context.route();
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
      await context.route();
    });
  }));
}

/* ---------------------------------------------------------------- branding */

function scopeRows(scopes = []) {
  return `<div data-scope-rows>${[...scopes, { ScopeName: "", ScopeDescription: "" }, { ScopeName: "", ScopeDescription: "" }].map((scope, index) => `<div class="field-row"><div class="field"><label>Scope name</label><input name="scope-name-${index}" value="${escapeHtml(scope.ScopeName || "")}" pattern="[\\x21\\x23-\\x2E\\x30-\\x5B\\x5D-\\x7E]+"></div><div class="field"><label>Description</label><input name="scope-description-${index}" value="${escapeHtml(scope.ScopeDescription || "")}"></div></div>`).join("")}</div>`;
}

function readScopes(data) {
  const scopes = [];
  for (let index = 0; data.get(`scope-name-${index}`) !== null; index += 1) {
    const name = String(data.get(`scope-name-${index}`) || "").trim();
    if (name) scopes.push({ ScopeName: name, ScopeDescription: String(data.get(`scope-description-${index}`) || "").trim() || name });
  }
  return scopes;
}

async function domainPage(context, poolId) {
  const [pool, oauth] = await Promise.all([loadPool(poolId), request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/oauth`)]);
  const resourceRows = oauth.resourceServers.map(resource => `<tr><td><strong>${escapeHtml(resource.name)}</strong></td><td class="mono">${escapeHtml(resource.identifier)}</td><td>${resource.scopes.map(scope => badge(scope.fullName, "success")).join(" ") || "None"}</td><td><div class="actions"><button class="button" data-edit-resource="${escapeHtml(resource.identifier)}">Edit</button><button class="button danger" data-delete-resource="${escapeHtml(resource.identifier)}">Delete</button></div></td></tr>`).join("");
  const domainActions = oauth.domain
    ? actionsMenu("Actions", [["update-domain", "Update branding version"], ["delete-domain", "Delete Cognito domain", { danger: true }]])
    : actionsMenu("Actions", [["create-domain", "Create Cognito domain"], ["custom-domain", "Create custom domain", { disabled: "Custom domains need DNS, CloudFront, and ACM, which StackSim does not provide" }]]);
  poolPage(context, pool, "domain", `
    ${card("Domain", `<div class="card-body">${oauth.domain ? detail([["Cognito domain", `<span class="mono cognito-wrap">${escapeHtml(oauth.domain.baseUrl)}</span>`], ["Domain prefix", `<span class="mono">${escapeHtml(oauth.domain.name)}</span>`], ["Branding version", oauth.domain.managedLoginVersion === 2 ? "Managed login" : "Hosted UI (classic)"]]) : '<p class="muted">No domain is configured. Create a Cognito domain to use managed login and OAuth endpoints.</p>'}<p class="muted small">Local loopback domain; it does not create DNS records, CloudFront, ACM certificates, or public TLS.</p></div>`, `<span data-action="configure-domain" hidden></span>${domainActions}`)}
    ${card("Resource servers", `<div class="table-wrap">${resourceRows ? `<table><thead><tr><th>Resource server name</th><th>Identifier</th><th>Custom scopes</th><th>Actions</th></tr></thead><tbody>${resourceRows}</tbody></table>` : emptyState("R", "No resource servers", "Create a resource server to issue custom API scopes.")}</div>`, '<button class="button primary" data-action="create-resource-server">Create resource server</button>', `(${oauth.resourceServers.length})`)}
    ${card("Issuer and local tooling aliases", `<div class="card-body">${detail([["Canonical issuer", `<span class="mono cognito-wrap">${escapeHtml(oauth.issuer)}</span>`], ["Discovery URL", `<span class="mono cognito-wrap">${escapeHtml(`${location.origin}${oauth.discoveryPath}`)}</span>`], ["JWKS URL", `<span class="mono cognito-wrap">${escapeHtml(`${location.origin}${oauth.jwksPath}`)}</span>`]])}</div>`)}
  `);
  const domainModal = () => context.showModal(oauth.domain ? "Update branding version" : "Create Cognito domain", `<div class="field"><label>Domain prefix</label><input name="domain" required ${oauth.domain ? "readonly" : ""} value="${escapeHtml(oauth.domain?.name || "")}" pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"></div><fieldset class="cognito-fieldset"><legend>Branding version</legend><div class="cognito-checkbox-stack"><label class="checkbox-label"><input type="radio" name="version" value="2" ${oauth.domain?.managedLoginVersion !== 1 ? "checked" : ""}> Managed login</label><label class="checkbox-label"><input type="radio" name="version" value="1" ${oauth.domain?.managedLoginVersion === 1 ? "checked" : ""}> Hosted UI (classic)</label></div><span class="hint">Lite pools offer only the classic hosted UI.</span></fieldset>`, oauth.domain ? "Save changes" : "Create Cognito domain", async data => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/domain`, "POST", { domain: String(data.get("domain") || "").trim(), managedLoginVersion: Number(data.get("version")) });
    context.toast(oauth.domain ? "Branding version updated" : "Cognito domain created");
    await context.route();
  }, true, { refreshAfterSubmit: false });
  bindMenu({
    "create-domain": domainModal,
    "update-domain": domainModal,
    "delete-domain": () => context.confirmDeletion(oauth.domain.name, `Delete domain ${oauth.domain.name}?`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/domain`, "DELETE", { confirmation: oauth.domain.name });
      context.toast("Domain deleted");
      await context.route();
    }),
  });
  const resourceModal = resource => context.showModal(resource ? `Edit ${resource.name}` : "Create resource server", `<div class="field"><label>Resource server name</label><input name="name" required maxlength="256" value="${escapeHtml(resource?.name || "")}"></div><div class="field"><label>Resource server identifier</label><input name="identifier" required maxlength="256" ${resource ? "readonly" : ""} value="${escapeHtml(resource?.identifier || "")}" placeholder="https://api.example.test"></div><fieldset class="cognito-fieldset"><legend>Custom scopes</legend>${scopeRows(values(resource?.scopes).map(scope => ({ ScopeName: scope.name ?? scope.fullName.split("/").pop(), ScopeDescription: scope.description })))}</fieldset>`, resource ? "Save changes" : "Create resource server", async data => {
    const input = { UserPoolId: pool.id, Identifier: String(data.get("identifier") || "").trim(), Name: String(data.get("name") || "").trim(), Scopes: readScopes(data) };
    await act(resource ? "UpdateResourceServer" : "CreateResourceServer", input);
    context.toast(resource ? "Resource server updated" : "Resource server created");
    await context.route();
  }, true, { refreshAfterSubmit: false });
  document.querySelector('[data-action="create-resource-server"]')?.addEventListener("click", () => resourceModal());
  document.querySelectorAll("[data-edit-resource]").forEach(button => button.addEventListener("click", () => resourceModal(oauth.resourceServers.find(resource => resource.identifier === button.dataset.editResource))));
  document.querySelectorAll("[data-delete-resource]").forEach(button => button.addEventListener("click", () => {
    const identifier = button.dataset.deleteResource;
    context.confirmDeletion(identifier, `Delete resource server ${identifier}?`, async () => {
      await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/resource-servers/${encoded(identifier)}`, "DELETE", { confirmation: identifier });
      context.toast("Resource server deleted");
      await context.route();
    });
  }));
}

async function managedLoginPage(context, poolId) {
  const [pool, oauth, clients] = await Promise.all([
    loadPool(poolId),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/oauth`),
    request(`/_stacksim/api/cognito/user-pools/${encoded(poolId)}/app-clients`),
  ]);
  const managed = oauth.domain?.managedLoginVersion === 2;
  poolPage(context, pool, "managed-login", `
    ${card("Styles", `<div class="card-body">${oauth.branding.map(value => `<p><strong>${escapeHtml(clients.appClients.find(client => client.id === value.clientId)?.name || value.clientId)}</strong> · ${escapeHtml(value.settings?.pageTitle || "Cognito defaults")} · <span class="mono">${escapeHtml(value.settings?.primaryColor || "default color")}</span></p>`).join("") || '<p class="muted">No app client has a style yet; managed login uses the default style.</p>'}${managed ? "" : '<p class="muted small">Styles apply to managed login. Choose the Managed login branding version on the Domain page first.</p>'}<p class="muted small">The local page applies a page title and a six-digit primary color; the visual branding editor, logos, and images are not implemented in this simulator.</p></div>${oauth.domain ? `<div class="card-body"><a class="button" target="_blank" rel="noopener noreferrer" href="${escapeHtml(oauth.domain.baseUrl)}">Open managed login</a></div>` : ""}`, `<button class="button primary" data-action="configure-branding" ${managed ? "" : 'disabled title="Choose the Managed login branding version on the Domain page"'}>Create a style</button>`)}
    ${card("Terms documents", `<div class="card-body"><p class="muted">Terms of use and privacy policy documents for managed login are not implemented in this simulator.</p></div>`)}
  `);
  document.querySelector('[data-action="configure-branding"]')?.addEventListener("click", () => context.showModal("Create a style", `<div class="field"><label>App client</label><select name="clientId" required>${clients.appClients.map(client => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)} · ${escapeHtml(client.id)}</option>`).join("")}</select></div><div class="field"><label>Page title</label><input name="pageTitle" required maxlength="80" value="${escapeHtml(pool.name)}"></div><div class="field"><label>Primary color</label><input name="primaryColor" required pattern="#[0-9A-Fa-f]{6}" value="#2563eb"></div>`, "Save style", async data => {
    await consoleMutation(`/_stacksim/api/cognito/user-pools/${encoded(pool.id)}/oauth/branding`, "POST", {
      clientId: data.get("clientId"),
      pageTitle: String(data.get("pageTitle") || "").trim(),
      primaryColor: String(data.get("primaryColor") || "").trim(),
    });
    context.toast("Style saved");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
}

/* ---------------------------------------------------------------- security and extensions */

async function threatProtectionPage(context, poolId) {
  const pool = await loadPool(poolId);
  poolPage(context, pool, "threat-protection", card("Threat protection", `<div class="card-body">${detail([["Enforcement mode", "No enforcement"], ["Feature plan", escapeHtml(friendly(pool.configuration.tier))]])}${boundaryNote("Not implemented in this simulator", "Threat protection (adaptive authentication and compromised-credential detection) needs the Plus feature plan and production risk telemetry. StackSim accepts AdvancedSecurityMode OFF only.")}</div>`));
}

const TRIGGERS = [
  ["Sign-up", "PreSignUp", "Pre sign-up trigger"],
  ["Sign-up", "PostConfirmation", "Post confirmation trigger"],
  ["Authentication", "PreAuthentication", "Pre authentication trigger"],
  ["Authentication", "PostAuthentication", "Post authentication trigger"],
  ["Authentication", "PreTokenGeneration", "Pre token generation trigger"],
  ["Messaging", "CustomMessage", "Custom message trigger"],
];
const UNAVAILABLE_TRIGGERS = ["Define auth challenge", "Create auth challenge", "Verify auth challenge response", "Migrate user", "Custom email sender", "Custom SMS sender", "Inbound federation"];

async function lambdaTriggersPage(context, poolId) {
  const [pool, described] = await Promise.all([loadPool(poolId), describePool(poolId)]);
  const config = described.LambdaConfig || {};
  const rows = TRIGGERS.filter(([, key]) => config[key]).map(([category, key, label]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(category)}</td><td class="mono cognito-wrap">${escapeHtml(config[key])}</td><td>${key === "PreTokenGeneration" ? escapeHtml(config.PreTokenGenerationConfig?.LambdaVersion || "V1_0") : "—"}</td><td><button class="button danger" data-remove-trigger="${key}">Remove</button></td></tr>`).join("");
  poolPage(context, pool, "lambda-triggers", card("Lambda triggers", `<div class="table-wrap">${rows ? `<table><thead><tr><th>Trigger</th><th>Category</th><th>Lambda function</th><th>Event version</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("λ", "No Lambda triggers", "Add a Lambda trigger to customize sign-up, authentication, or messages.")}</div><div class="alert info"><strong>Lambda permission required</strong><br>Add a function resource-policy permission for cognito-idp.amazonaws.com with this pool ARN as SourceArn. Trigger failures fail closed and never expose passwords or token material.<br>${escapeHtml(UNAVAILABLE_TRIGGERS.join(", "))} triggers are not implemented in this simulator.</div>`, '<button class="button primary" data-action="add-trigger">Add Lambda trigger</button>', `(${TRIGGERS.filter(([, key]) => config[key]).length})`));
  const functions = await rest("/2015-03-31/functions").then(result => values(result.Functions)).catch(() => []);
  document.querySelector('[data-action="add-trigger"]')?.addEventListener("click", () => context.showModal("Add Lambda trigger", `<div class="field"><label>Trigger type</label><select name="trigger">${TRIGGERS.map(([category, key, label]) => `<option value="${key}">${escapeHtml(category)} · ${escapeHtml(label)}</option>`).join("")}</select></div><div class="field"><label>Assign Lambda function</label><input name="arn" class="mono" required list="cognito-function-arns" placeholder="arn:aws:lambda:region:account:function:name"><datalist id="cognito-function-arns">${functions.map(fn => `<option value="${escapeHtml(fn.FunctionArn)}">${escapeHtml(fn.FunctionName)}</option>`).join("")}</datalist></div><span class="hint">Pre token generation uses event version V1_0 (ID token customization); V2_0 and V3_0 are not implemented in this simulator.</span>`, "Add Lambda trigger", async data => {
    await updatePool(pool.id, input => {
      const key = String(data.get("trigger"));
      input.LambdaConfig = { ...input.LambdaConfig, [key]: String(data.get("arn") || "").trim() };
      if (key === "PreTokenGeneration") delete input.LambdaConfig.PreTokenGenerationConfig;
    });
    context.toast("Lambda trigger added");
    await context.route();
  }, true, { refreshAfterSubmit: false }));
  document.querySelectorAll("[data-remove-trigger]").forEach(button => button.addEventListener("click", async () => {
    await updatePool(pool.id, input => {
      const key = button.dataset.removeTrigger;
      delete input.LambdaConfig[key];
      if (key === "PreTokenGeneration") delete input.LambdaConfig.PreTokenGenerationConfig;
    });
    context.toast("Lambda trigger removed");
    await context.route();
  }));
}

/* ---------------------------------------------------------------- routing */

export async function routeCognito(parts, context) {
  const withPanelHelp = async render => {
    const result = await render();
    decorateCognitoPanelHelp(context.main);
    return result;
  };
  if (parts[0] !== "cognito") return context.notFound(parts);
  if (parts.length === 1 || parts[1] === "user-pools" && parts.length === 2) return withPanelHelp(() => poolsPage(context));
  if (parts[1] === "user-pools" && parts[2] === "create" && parts.length === 3) return createPoolWizard(context);
  if (parts[1] !== "user-pools" || parts.length < 4) return context.notFound(parts);
  const poolId = parts[2];
  const page = parts[3];
  const pages = {
    overview: () => overviewPage(context, poolId),
    users: () => parts.length === 5 ? userDetailPage(context, poolId, parts[4]) : usersPage(context, poolId),
    groups: () => parts.length === 5 ? groupDetailPage(context, poolId, parts[4]) : groupsPage(context, poolId),
    "app-clients": () => parts.length >= 5 ? appClientDetailPage(context, poolId, parts[4], parts[5]) : appClientsPage(context, poolId),
    "authentication-methods": () => authenticationMethodsPage(context, poolId),
    "sign-in": () => signInPage(context, poolId),
    "sign-up": () => signUpPage(context, poolId),
    // The former tab route keeps working for bookmarks.
    "self-service-sign-up": () => signUpPage(context, poolId),
    "identity-providers": () => identityProvidersPage(context, poolId),
    "message-templates": () => messageTemplatesPage(context, poolId),
    "threat-protection": () => threatProtectionPage(context, poolId),
    domain: () => domainPage(context, poolId),
    "managed-login": () => managedLoginPage(context, poolId),
    "lambda-triggers": () => lambdaTriggersPage(context, poolId),
    settings: () => settingsPage(context, poolId, parts[4]),
  };
  const render = pages[page];
  if (!render || parts.length > 6) return context.notFound(parts);
  return withPanelHelp(render);
}
