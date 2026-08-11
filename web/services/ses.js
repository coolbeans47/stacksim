import { binaryRequest, consoleMutation, request, sesV1, sesV2 } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { session as ui, setDirty } from "../state.js";
import { decorateSesPanelHelp } from "./ses-help.js";

export const metadata = {
  key: "ses",
  name: "SES",
  icon: "@",
  cls: "ses",
  links: [
    ["Account dashboard", "#/ses"],
    ["Verified identities", "#/ses/identities"],
    ["Configuration sets", "#/ses/configuration-sets"],
    ["Email templates", "#/ses/templates"],
    ["Send test email", "#/ses/send-test"],
    ["Inbox", "#/ses/inbox"],
    ["Suppression list", "#/ses/suppression"],
    ["Contact lists", "#/ses/contact-lists"],
    ["Custom verification", "#/ses/custom-verification-templates"],
    ["Sending statistics", "#/ses/statistics"],
  ],
  search: ["ses", "email", "mail", "inbox", "identity", "sender", "template", "configuration set", "capture", "suppression", "contacts"],
};

const pageSize = 50;
let inboxPaging = { key: "", tokens: [undefined], index: 0 };

const encoded = value => encodeURIComponent(String(value));
const values = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const text = value => value === undefined || value === null ? "" : String(value);
const firstDefined = (...candidates) => candidates.find(value => value !== undefined && value !== null);

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function parseTags(value) {
  const object = parseObject(value, "Tags");
  if (Object.values(object).some(item => typeof item !== "string")) throw new Error("Tag values must be strings");
  return Object.entries(object).map(([Key, Value]) => ({ Key, Value }));
}

function splitAddresses(value) {
  return String(value || "").split(/[\n,;]+/).map(item => item.trim()).filter(Boolean);
}

function tagsObject(tags) {
  if (!tags) return {};
  if (!Array.isArray(tags) && typeof tags === "object") return tags;
  return Object.fromEntries(values(tags).filter(tag => tag?.Key !== undefined).map(tag => [String(tag.Key), String(tag.Value ?? "")]));
}

function statusBadge(label, kind = "") {
  const normalized = String(label || "Unknown");
  return `<span class="status-badge ${escapeHtml(kind)}">${escapeHtml(normalized.replaceAll("_", " "))}</span>`;
}

function renderStatusLabel(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "RENDERED") return "Rendered";
  if (normalized === "FAILED") return "Rendering failed";
  return normalized ? normalized.toLowerCase().replaceAll("_", " ").replace(/^\w/, character => character.toUpperCase()) : "Unknown";
}

function dispositionLabel(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "NOT_ATTEMPTED") return "Not attempted";
  return normalized ? normalized.toLowerCase().replaceAll("_", " ").replace(/^\w/, character => character.toUpperCase()) : "Unknown";
}

function verificationStatus(identity) {
  return firstDefined(identity.VerificationStatus, identity.verificationStatus, identity.Status, identity.status,
    firstDefined(identity.VerifiedForSendingStatus, identity.verifiedForSendingStatus) ? "SUCCESS" : "PENDING");
}

function identityType(identity, name = "") {
  return firstDefined(identity.IdentityType, identity.identityType, String(name).includes("@") ? "EMAIL_ADDRESS" : "DOMAIN");
}

function identityArn(name, descriptor = {}) {
  return firstDefined(descriptor.IdentityArn, descriptor.identityArn, descriptor.Arn, descriptor.arn,
    `arn:aws:ses:${ui.region}:${ui.summary?.accountId ?? "000000000000"}:identity/${name}`);
}

function setChrome(context, crumbs) {
  context.setChrome("ses", ["SES", ...crumbs]);
  if (location.hash.startsWith("#/ses/inbox?")) {
    const inbox = document.querySelector('.side-link[href="#/ses/inbox"]');
    inbox?.classList.add("active");
    inbox?.setAttribute("aria-current", "page");
  }
}

function routeLocation() {
  const raw = location.hash.replace(/^#/, "") || "/ses";
  const url = new URL(raw.startsWith("/") ? raw : `/${raw}`, location.origin);
  return {
    parts: url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part)),
    query: url.searchParams,
  };
}

async function listAll(path, resultKey, pageParameter = "PageSize") {
  const collected = [];
  let NextToken;
  do {
    const page = await sesV2(path, { query: { [pageParameter]: 100, ...(NextToken ? { NextToken } : {}) } });
    collected.push(...values(page[resultKey] ?? page[resultKey[0].toLowerCase() + resultKey.slice(1)]));
    NextToken = page.NextToken ?? page.nextToken;
  } while (NextToken);
  return collected;
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

const listIdentities = () => listAll("identities", "EmailIdentities");
const listTemplates = () => listAll("templates", "TemplatesMetadata");
const listConfigurationSets = () => listAll("configuration-sets", "ConfigurationSets");

function identityName(value) {
  return text(firstDefined(value.IdentityName, value.identityName, value.EmailIdentity, value.emailIdentity, value.Name, value.name));
}

function configurationSetName(value) {
  return text(typeof value === "string" ? value : firstDefined(value.ConfigurationSetName, value.configurationSetName, value.Name, value.name));
}

function templateName(value) {
  return text(firstDefined(value.TemplateName, value.templateName, value.Name, value.name));
}

async function dashboard(context) {
  const [account, identities, templates, configurations, inbox] = await Promise.all([
    sesV2("account"),
    listIdentities(),
    listTemplates(),
    listConfigurationSets(),
    request("/_stacksim/api/ses/inbox?pageSize=1").catch(() => ({})),
  ]);
  const sendingEnabled = firstDefined(account.SendingEnabled, account.sendingEnabled, true) !== false;
  const production = firstDefined(account.ProductionAccessEnabled, account.productionAccessEnabled, true) !== false;
  const quota = firstDefined(account.SendQuota, account.sendQuota, {});
  const captured = Number(firstDefined(inbox.total, inbox.Total, inbox.totalMessages, inbox.TotalMessages, inbox.count, ui.summary?.counts?.sesMessages, 0));
  setChrome(context, ["Account dashboard"]);
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("SES", "Develop and test outbound email without sending anything to the external network.", '<a class="button primary" href="#/ses/send-test">Send test email</a>')}
    <div class="alert info"><strong>Local capture only</strong><br>Successful sends are durably accepted into the selected Region's local Inbox. They are never handed to a remote mail server and are not described as delivered.</div>
    <div class="ses-summary-grid">
      <section class="card"><div class="card-header"><h2>Account status</h2></div><div class="card-body"><div class="metric">${sendingEnabled ? "Enabled" : "Paused"}</div><p class="muted">${production ? "Production-access profile" : "Sandbox profile"} · ${escapeHtml(ui.region)}</p><div class="actions"><button class="button ${sendingEnabled ? "danger" : "primary"}" data-action="toggle-ses-sending">${sendingEnabled ? "Pause sending" : "Resume sending"}</button><button class="button" data-action="switch-ses-profile">${production ? "Use sandbox profile" : "Use production profile"}</button></div></div></section>
      <section class="card"><div class="card-header"><h2>Verified identities</h2></div><div class="card-body"><div class="metric">${identities.filter(item => verificationStatus(item) === "SUCCESS").length}</div><p class="muted">${identities.length} configured identity${identities.length === 1 ? "" : "ies"}</p><a href="#/ses/identities">Manage identities</a></div></section>
      <section class="card"><div class="card-header"><h2>Captured messages</h2></div><div class="card-body"><div class="metric">${captured.toLocaleString()}</div><p class="muted">Mailbox rows visible to this account and Region</p><a href="#/ses/inbox">Open local Inbox</a></div></section>
      <section class="card"><div class="card-header"><h2>Templates</h2></div><div class="card-body"><div class="metric">${templates.length}</div><p class="muted">Shared classic/v2 template catalog</p><a href="#/ses/templates">View templates</a></div></section>
      <section class="card"><div class="card-header"><h2>Configuration sets</h2></div><div class="card-body"><div class="metric">${configurations.length}</div><p class="muted">Basic sending-state controls</p><a href="#/ses/configuration-sets">View configuration sets</a></div></section>
      <section class="card"><div class="card-header"><h2>Sending quota</h2></div><div class="card-body"><dl class="key-value"><dt>24-hour recipient limit</dt><dd>${Number(firstDefined(quota.Max24HourSend, quota.max24HourSend, account.Max24HourSend, 50_000)).toLocaleString()}</dd><dt>Recipients per second</dt><dd>${Number(firstDefined(quota.MaxSendRate, quota.maxSendRate, account.MaxSendRate, 14)).toLocaleString()}</dd></dl></div></section>
    </div>
    <section class="card"><div class="card-header"><h2>Development boundaries</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Transport</dt><dd>Official SES v1 Query and SES v2 REST-JSON APIs</dd><dt>External SMTP</dt><dd>Disabled</dd></dl><dl class="key-value"><dt>Inbound email</dt><dd>Not accepted</dd><dt>DKIM/DNS</dt><dd>Descriptors only; no public lookup or signing</dd></dl><dl class="key-value"><dt>Inbox</dt><dd>Private simulator console API</dd><dt>Region</dt><dd>${escapeHtml(ui.region)}</dd></dl></div></section>
  </div>`;
  document.querySelector('[data-action="toggle-ses-sending"]')?.addEventListener("click", async button => {
    const control = button.currentTarget;
    control.disabled = true;
    try {
      await sesV2("account/sending", { method: "PUT", body: { SendingEnabled: !sendingEnabled } });
      context.toast(sendingEnabled ? "SES sending paused" : "SES sending resumed");
      await context.route();
    } catch (error) {
      control.disabled = false;
      context.showError(error);
    }
  });
  document.querySelector('[data-action="switch-ses-profile"]')?.addEventListener("click", () => {
    const targetProfile = production ? "SANDBOX" : "PRODUCTION";
    const effect = targetProfile === "SANDBOX"
      ? "Sandbox mode accepts only verified recipients or mailbox-simulator addresses and applies effective limits of 200 recipients per 24 hours and 1 recipient per second."
      : "Production mode restores the configured sending limits and accepts unverified recipients. A verified sender identity is still required.";
    context.showModal(`Use ${targetProfile.toLowerCase()} profile`, `<div class="alert warning"><strong>This changes regional SES enforcement</strong><br>${effect} The change is recorded in the local control audit.</div>
      <div class="field"><label>Type ${targetProfile} to confirm</label><input name="confirmation" required autocomplete="off"></div>`, "Change profile", async data => {
      if (data.get("confirmation") !== targetProfile) throw new Error(`Enter ${targetProfile} to confirm`);
      await consoleMutation("/_stacksim/api/ses/account/profile", "POST", { profile: targetProfile, confirmation: targetProfile });
      context.toast(`SES account changed to ${targetProfile.toLowerCase()} profile`);
    }, false, { danger: targetProfile === "SANDBOX" });
  });
}

function openCreateIdentity(context) {
  context.showModal("Create identity", `<div class="alert info"><strong>Sender verification is required</strong><br>Email-address identities receive a verification message in the local Inbox. Domain identities remain pending because the simulator performs no public DNS lookup.</div>
    <div class="field"><label>Email address or domain</label><input name="identity" required autocomplete="off" placeholder="sender@example.test"></div>
    <div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>`, "Create identity", async data => {
    const EmailIdentity = String(data.get("identity") || "").trim();
    const result = await sesV2("identities", { method: "POST", body: { EmailIdentity, Tags: parseTags(data.get("tags")) } });
    context.toast(String(EmailIdentity).includes("@") ? "Identity created; verification email captured" : "Domain identity created");
    location.hash = `#/ses/identities/${encoded(EmailIdentity)}`;
    return result;
  }, true, { refreshAfterSubmit: false });
}

async function identitiesPage(context) {
  const identities = await listIdentities();
  setChrome(context, ["Verified identities"]);
  const rows = identities.map(identity => {
    const name = identityName(identity);
    const status = verificationStatus(identity);
    const type = identityType(identity, name);
    const sending = firstDefined(identity.SendingEnabled, identity.sendingEnabled, status === "SUCCESS");
    return `<tr data-search-row="${escapeHtml(`${name} ${status} ${type}`.toLowerCase())}"><td><a href="#/ses/identities/${encoded(name)}"><strong>${escapeHtml(name)}</strong></a></td><td>${escapeHtml(type.replaceAll("_", " "))}</td><td>${statusBadge(status, status === "SUCCESS" ? "success" : "")}</td><td>${statusBadge(sending ? "Sending enabled" : "Sending unavailable", sending ? "success" : "")}</td></tr>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Verified identities", "Verify the email addresses and domains that applications can use as SES senders.", '<button class="button refresh" data-action="refresh" aria-label="Refresh identities" title="Refresh">↻</button><button class="button primary" data-action="create-ses-identity">Create identity</button>')}
    <section class="card"><div class="card-header"><h2>Identities <span class="muted">(${identities.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find an identity"></label></div><div class="table-wrap">${rows ? `<table class="ses-resource-table"><thead><tr><th>Identity</th><th>Type</th><th>Verification status</th><th>Sending status</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("@", "No verified identities", "Create an email address or domain identity before sending application email.", '<button class="button primary" data-action="create-ses-identity">Create identity</button>')}</div></section>
    <div class="alert info"><strong>Local verification behavior</strong><br>Email links point to this simulator. Domain DNS is never queried; a pending domain can be explicitly verified for local use from its detail page.</div>
  </div>`;
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-ses-identity"]').forEach(button => button.addEventListener("click", () => openCreateIdentity(context)));
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

async function identityDetail(context, name) {
  const [identity, configurations] = await Promise.all([
    sesV2(`identities/${encoded(name)}`),
    listConfigurationSets(),
  ]);
  const type = identityType(identity, name);
  const status = verificationStatus(identity);
  const arn = identityArn(name, identity);
  const dkim = firstDefined(identity.DkimAttributes, identity.dkimAttributes, {});
  const dkimTokens = values(firstDefined(dkim.Tokens, dkim.tokens, identity.DkimTokens, identity.dkimTokens));
  const tags = tagsObject(firstDefined(identity.Tags, identity.tags));
  const defaultConfiguration = text(firstDefined(identity.ConfigurationSetName, identity.configurationSetName));
  const mailFrom = identity.MailFromAttributes ?? identity.mailFromAttributes ?? {};
  const policies = identity.Policies ?? identity.policies ?? {};
  const isEmail = type === "EMAIL_ADDRESS" || name.includes("@");
  setChrome(context, ["Verified identities", name]);
  context.main.innerHTML = `<div class="page-width ses-page ses-detail">${pageHeader(name, "SES sender identity.", `${isEmail && status !== "SUCCESS" ? '<button class="button" data-action="resend-verification">Resend verification email</button>' : ""}${!isEmail && status === "PENDING" ? '<button class="button" data-action="verify-domain-local">Verify for local use</button>' : ""}<button class="button danger" data-action="delete-identity">Delete</button>`)}
    ${isEmail && status !== "SUCCESS" ? '<div class="alert info"><strong>Check the local Inbox</strong><br>The verification message is captured locally. Its signed localhost link expires after 24 hours and can be used once.</div>' : ""}
    ${!isEmail && status !== "SUCCESS" ? '<div class="alert info"><strong>DNS verification is intentionally local-only</strong><br>The DKIM values below are deterministic descriptors. “Verify for local use” marks sender ownership only in this account and Region; it does not publish DNS records or cryptographically sign messages.</div>' : ""}
    <section class="card"><div class="card-header"><h2>Identity details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Verification status</dt><dd>${statusBadge(status, status === "SUCCESS" ? "success" : "")}</dd><dt>Identity type</dt><dd>${escapeHtml(type.replaceAll("_", " "))}</dd></dl><dl class="key-value"><dt>Sending enabled</dt><dd>${firstDefined(identity.SendingEnabled, identity.sendingEnabled, status === "SUCCESS") ? "Yes" : "No"}</dd><dt>Default configuration set</dt><dd>${escapeHtml(defaultConfiguration || "None")}</dd></dl><dl class="key-value"><dt>ARN</dt><dd class="mono">${escapeHtml(arn)}</dd><dt>Region</dt><dd>${escapeHtml(ui.region)}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Default configuration set</h2></div><div class="card-body"><form id="ses-identity-configuration"><div class="field-row"><div class="field"><label>Configuration set</label><select name="configurationSet"><option value="">None</option>${configurations.map(item => { const value = configurationSetName(item); return `<option value="${escapeHtml(value)}" ${value === defaultConfiguration ? "selected" : ""}>${escapeHtml(value)}</option>`; }).join("")}</select></div><div class="ses-inline-submit"><button class="button primary" type="submit">Save association</button></div></div></form></div></section>
    <section class="card"><div class="card-header"><h2>MAIL FROM and feedback</h2><button class="button" data-action="edit-mail-from">Edit MAIL FROM</button></div><div class="card-body detail-grid"><dl class="key-value"><dt>MAIL FROM domain</dt><dd>${escapeHtml(mailFrom.MailFromDomain ?? "Default service domain")}</dd><dt>MX failure behavior</dt><dd>${escapeHtml(mailFrom.BehaviorOnMxFailure ?? "USE_DEFAULT_VALUE")}</dd></dl><dl class="key-value"><dt>MAIL FROM status</dt><dd>${escapeHtml(mailFrom.MailFromDomainStatus ?? "PENDING")}</dd><dt>Feedback forwarding</dt><dd>${firstDefined(identity.FeedbackForwardingStatus, true) ? "Enabled" : "Disabled"}</dd></dl></div></section>
    <section class="card"><div class="card-header"><h2>Sending authorization policies <span class="muted">(${Object.keys(policies).length})</span></h2><button class="button" data-action="put-identity-policy">Add or update policy</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Policy</th><th></th></tr></thead><tbody>${Object.entries(policies).map(([policyName, document]) => `<tr><td>${escapeHtml(policyName)}</td><td><code class="small">${escapeHtml(String(document).slice(0, 180))}</code></td><td><button class="button link" data-delete-policy="${escapeHtml(policyName)}">Delete</button></td></tr>`).join("") || '<tr><td colspan="3" class="muted">No sending authorization policies.</td></tr>'}</tbody></table></div></section>
    <section class="card"><div class="card-header"><h2>DKIM descriptors</h2></div><div class="table-wrap">${dkimTokens.length ? `<table><thead><tr><th>Token</th><th>Local meaning</th></tr></thead><tbody>${dkimTokens.map(token => `<tr><td class="mono">${escapeHtml(token)}</td><td>Descriptor only; no DNS publication or cryptographic signing</td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No DKIM tokens", isEmail ? "Email-address identities do not publish DKIM DNS records." : "No local DKIM descriptors are available.")}</div></section>
    <section class="card"><div class="card-header"><h2>Tags <span class="muted">(${Object.keys(tags).length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${Object.entries(tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("") || '<tr><td colspan="2" class="muted">No tags.</td></tr>'}</tbody></table></div></section>
  </div>`;
  document.querySelector('[data-action="resend-verification"]')?.addEventListener("click", async button => {
    const control = button.currentTarget;
    control.disabled = true;
    try {
      await sesV1("VerifyEmailIdentity", { EmailAddress: name });
      context.toast("A new verification email was captured");
      await context.route();
    } catch (error) {
      control.disabled = false;
      context.showError(error);
    }
  });
  document.querySelector('[data-action="verify-domain-local"]')?.addEventListener("click", () => {
    const canonicalDomain = String(name).trim().toLowerCase().replace(/\.$/, "");
    context.showModal("Verify domain for local use", `<div class="alert warning"><strong>This does not prove DNS ownership</strong><br>This local console administration action marks <span class="mono">${escapeHtml(canonicalDomain)}</span> as a verified sender in ${escapeHtml(ui.region)} and records the transition in the local control audit. DKIM remains a descriptor only.</div>
      <div class="field"><label>Type ${escapeHtml(canonicalDomain)} to confirm</label><input name="confirmation" required autocomplete="off"></div>`, "Verify for local use", async data => {
      if (data.get("confirmation") !== canonicalDomain) throw new Error(`Enter ${canonicalDomain} to confirm`);
      await consoleMutation(`/_stacksim/api/ses/identities/${encoded(name)}/verify-local`, "POST", { confirmation: canonicalDomain });
      context.toast("Domain verified for local use");
    }, false, { danger: true });
  });
  document.querySelector('[data-action="delete-identity"]')?.addEventListener("click", () => context.confirmDeletion(name, `Delete SES identity ${name}? Historical captured mail is retained.`, async () => {
    await sesV2(`identities/${encoded(name)}`, { method: "DELETE" });
    context.toast("Identity deleted");
    location.hash = "#/ses/identities";
  }));
  document.querySelector("#ses-identity-configuration")?.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(event.currentTarget);
      const configurationSetName = String(data.get("configurationSet") || "");
      await sesV2(`identities/${encoded(name)}/configuration-set`, { method: "PUT", body: configurationSetName ? { ConfigurationSetName: configurationSetName } : {} });
      context.toast("Default configuration set updated");
      await context.route();
    } catch (error) {
      submit.disabled = false;
      context.showError(error);
    }
  });
  document.querySelector('[data-action="edit-mail-from"]')?.addEventListener("click", () => context.showModal("Edit MAIL FROM", `<div class="field"><label>MAIL FROM domain</label><input name="mailFromDomain" value="${escapeHtml(mailFrom.MailFromDomain ?? "")}" placeholder="mail.example.com"></div><div class="field"><label>MX failure behavior</label><select name="behavior"><option value="USE_DEFAULT_VALUE">Use default domain</option><option value="REJECT_MESSAGE" ${mailFrom.BehaviorOnMxFailure === "REJECT_MESSAGE" ? "selected" : ""}>Reject message</option></select></div>`, "Save", async data => {
    await sesV2(`identities/${encoded(name)}/mail-from`, { method: "PUT", body: { MailFromDomain: String(data.get("mailFromDomain") || ""), BehaviorOnMxFailure: String(data.get("behavior") || "USE_DEFAULT_VALUE") } });
    context.toast("MAIL FROM settings updated");
  }));
  document.querySelector('[data-action="put-identity-policy"]')?.addEventListener("click", () => context.showModal("Sending authorization policy", `<div class="field"><label>Policy name</label><input name="policyName" required pattern="[A-Za-z0-9_-]+"></div><div class="field"><label>Policy document</label><textarea name="policy" class="code-editor">{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"ses:SendEmail","Resource":"${escapeHtml(arn)}"}]}</textarea></div>`, "Save policy", async data => {
    const policyName = String(data.get("policyName") || "");
    await sesV2(`identities/${encoded(name)}/policies/${encoded(policyName)}`, { method: Object.hasOwn(policies, policyName) ? "PUT" : "POST", body: { Policy: String(data.get("policy") || "") } });
    context.toast("Identity policy saved");
  }, true));
  document.querySelectorAll("[data-delete-policy]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deletePolicy, `Delete identity policy ${button.dataset.deletePolicy}?`, async () => {
    await sesV2(`identities/${encoded(name)}/policies/${encoded(button.dataset.deletePolicy)}`, { method: "DELETE" });
    context.toast("Identity policy deleted");
  })));
}

function sendContentMarkup(selectedTemplate = "") {
  return `<div class="field-row"><div class="field"><label>Content type</label><select name="mode"><option value="simple">Simple email</option><option value="template" ${selectedTemplate ? "selected" : ""}>Stored template</option></select></div><div class="field"><label>Configuration set</label><select name="configurationSet" id="ses-send-configuration"><option value="">None</option></select></div></div>
    <section data-ses-send-mode="simple" ${selectedTemplate ? "hidden" : ""}><div class="field"><label>Subject</label><input name="subject" maxlength="998" value="Hello from the local SES simulator"></div><div class="field-row"><div class="field"><label>Text body</label><textarea name="textBody">This message was captured locally.</textarea></div><div class="field"><label>HTML body</label><textarea name="htmlBody"><p>This message was <strong>captured locally</strong>.</p></textarea></div></div></section>
    <section data-ses-send-mode="template" ${selectedTemplate ? "" : "hidden"}><div class="field"><label>Stored template</label><select name="templateName" id="ses-send-template"><option value="">Select a template</option></select></div><div class="field"><label>Template data (JSON object)</label><textarea name="templateData">{}</textarea><span class="hint">The JSON object is sent as the official TemplateData string.</span></div></section>`;
}

async function sendTestPage(context, query) {
  const [identities, templates, configurations] = await Promise.all([listIdentities(), listTemplates(), listConfigurationSets()]);
  const selectedTemplate = query.get("template") ?? "";
  const senders = identities.filter(item => verificationStatus(item) === "SUCCESS" && identityType(item, identityName(item)) === "EMAIL_ADDRESS");
  setChrome(context, ["Send test email"]);
  context.main.innerHTML = `<div class="page-width ses-page ses-send-page">${pageHeader("Send test email", "Use the official SES v2 SendEmail route and inspect the committed result in the local Inbox.")}
    <div class="alert info"><strong>No external delivery</strong><br>A successful response means SES accepted the message into the durable local mailbox. It does not mean a remote recipient received it.</div>
    <form id="ses-send-test">
      <section class="card"><div class="card-header"><h2>Message addresses</h2></div><div class="card-body">
        <div class="field"><label>From email address</label><select name="from" required>${senders.map(item => { const name = identityName(item); return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`; }).join("")}<option value="" ${senders.length ? "" : "selected"}>${senders.length ? "Use another verified identity…" : "No verified email identities"}</option></select></div>
        <div class="field-row"><div class="field"><label>To</label><textarea name="to" required placeholder="alice@example.test"></textarea></div><div class="field"><label>Cc</label><textarea name="cc" placeholder="team@example.test"></textarea></div></div>
        <div class="field-row"><div class="field"><label>Bcc</label><textarea name="bcc" placeholder="audit@example.test"></textarea></div><div class="field"><label>Reply-To</label><textarea name="replyTo" placeholder="support@example.test"></textarea></div></div>
      </div></section>
      <section class="card"><div class="card-header"><h2>Content</h2></div><div class="card-body">${sendContentMarkup(selectedTemplate)}</div></section>
      <div class="ses-form-actions"><a class="button" href="#/ses/inbox">Cancel</a><button class="button primary" type="submit">Send test email</button></div>
    </form>
  </div>`;
  const templateSelect = document.querySelector("#ses-send-template");
  templateSelect.insertAdjacentHTML("beforeend", templates.map(item => { const name = templateName(item); return `<option value="${escapeHtml(name)}" ${name === selectedTemplate ? "selected" : ""}>${escapeHtml(name)}</option>`; }).join(""));
  const configurationSelect = document.querySelector("#ses-send-configuration");
  configurationSelect.insertAdjacentHTML("beforeend", configurations.map(item => { const name = configurationSetName(item); return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`; }).join(""));
  const mode = document.querySelector('[name="mode"]');
  const toggleMode = () => document.querySelectorAll("[data-ses-send-mode]").forEach(section => { section.hidden = section.dataset.sesSendMode !== mode.value; });
  mode.addEventListener("change", toggleMode);
  toggleMode();
  document.querySelector("#ses-send-test").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const ToAddresses = splitAddresses(data.get("to"));
      if (!ToAddresses.length) throw new Error("Enter at least one To recipient");
      const selectedMode = String(data.get("mode"));
      const Content = selectedMode === "template"
        ? { Template: { TemplateName: String(data.get("templateName") || ""), TemplateData: JSON.stringify(parseObject(data.get("templateData"), "Template data")) } }
        : { Simple: {
          Subject: { Data: String(data.get("subject") || ""), Charset: "UTF-8" },
          Body: {
            ...(data.get("textBody") ? { Text: { Data: String(data.get("textBody")), Charset: "UTF-8" } } : {}),
            ...(data.get("htmlBody") ? { Html: { Data: String(data.get("htmlBody")), Charset: "UTF-8" } } : {}),
          },
        } };
      if (selectedMode === "template" && !Content.Template.TemplateName) throw new Error("Select a stored template");
      const configuration = String(data.get("configurationSet") || "");
      const result = await sesV2("outbound-emails", { method: "POST", body: {
        FromEmailAddress: String(data.get("from") || ""),
        Destination: { ToAddresses, CcAddresses: splitAddresses(data.get("cc")), BccAddresses: splitAddresses(data.get("bcc")) },
        ReplyToAddresses: splitAddresses(data.get("replyTo")),
        Content,
        ...(configuration ? { ConfigurationSetName: configuration } : {}),
      } });
      const messageId = result.MessageId ?? result.messageId;
      if (!messageId) throw new Error("SES accepted the request without returning a MessageId");
      setDirty(false, "all");
      context.toast("Message accepted into the local Inbox");
      location.hash = `#/ses/inbox/${encoded(messageId)}`;
    } catch (error) {
      submit.disabled = false;
      context.showError(error);
    }
  });
}

function inboxSummary(message) {
  const messageId = text(firstDefined(message.messageId, message.MessageId, message.id, message.captureId));
  const subject = text(firstDefined(message.subject, message.Subject, "(No subject)"));
  const sender = text(firstDefined(message.source, message.Source, message.sourceAddress, message.SourceAddress, message.from, message.From, "Unknown sender"));
  const recipients = values(firstDefined(message.envelopeRecipients, message.EnvelopeRecipients, message.recipients, message.Recipients))
    .map(recipient => text(typeof recipient === "string" ? recipient : firstDefined(recipient.address, recipient.Address, recipient.emailAddress, recipient.EmailAddress))).filter(Boolean);
  const explicitRead = firstDefined(message.read, message.Read, message.isRead, message.IsRead);
  const unread = firstDefined(message.unread, message.Unread);
  const explicitDeleted = firstDefined(message.deleted, message.Deleted, message.isDeleted, message.IsDeleted);
  return {
    messageId,
    subject,
    sender,
    recipients,
    preview: text(firstDefined(message.preview, message.Preview, message.textPreview, message.TextPreview)),
    acceptedAt: firstDefined(message.acceptedAt, message.AcceptedAt, message.timestamp, message.Timestamp),
    read: explicitRead !== undefined ? explicitRead === true : unread !== undefined ? unread !== true : firstDefined(message.readAt, message.ReadAt) != null,
    deleted: explicitDeleted !== undefined ? explicitDeleted === true : firstDefined(message.deletedAt, message.DeletedAt) != null,
    attachmentCount: Number(firstDefined(message.attachmentCount, message.AttachmentCount, values(message.attachments).length, 0)),
    renderStatus: text(firstDefined(message.renderStatus, message.RenderStatus, "RENDERED")),
    disposition: text(firstDefined(message.disposition, message.Disposition, message.localDisposition, message.LocalDisposition, "CAPTURED")),
    templateName: text(firstDefined(message.templateName, message.TemplateName)),
    configurationSetName: text(firstDefined(message.configurationSetName, message.ConfigurationSetName)),
  };
}

function inboxHash(recipient, status, originService = "") {
  const query = new URLSearchParams();
  if (recipient) query.set("recipient", recipient);
  if (status && status !== "all") query.set("status", status);
  if (originService) query.set("originService", originService);
  return `#/ses/inbox${query.size ? `?${query}` : ""}`;
}

async function inboxPage(context, query) {
  const recipient = String(query.get("recipient") || "").trim();
  const originService = /^[a-z0-9-]{1,64}$/.test(query.get("originService") ?? "")
    ? query.get("originService")
    : "";
  const status = ["all", "unread", "trash"].includes(query.get("status")) ? query.get("status") : "all";
  const pagingKey = `${ui.region}\0${recipient.toLowerCase()}\0${originService}\0${status}`;
  if (inboxPaging.key !== pagingKey) inboxPaging = { key: pagingKey, tokens: [undefined], index: 0 };
  const params = new URLSearchParams({ status, pageSize: String(pageSize) });
  if (recipient) params.set("recipient", recipient);
  if (originService) params.set("originService", originService);
  const token = inboxPaging.tokens[inboxPaging.index];
  if (token) params.set("nextToken", token);
  let page;
  try {
    page = await request(`/_stacksim/api/ses/inbox?${params}`);
  } catch (error) {
    if (error.status === 409 && error.code === "StaleCursor") {
      inboxPaging = { key: pagingKey, tokens: [undefined], index: 0 };
      return inboxPage(context, query);
    }
    throw error;
  }
  const suggestionsResult = await request(`/_stacksim/api/ses/inbox/recipients?${new URLSearchParams({ ...(recipient ? { prefix: recipient } : {}), limit: "20" })}`).catch(() => ({}));
  const suggestions = values(suggestionsResult.recipients ?? suggestionsResult.Recipients ?? suggestionsResult.items);
  const messages = values(page.messages ?? page.Messages ?? page.items ?? page.Items).map(inboxSummary);
  const nextToken = page.nextToken ?? page.NextToken;
  setChrome(context, ["Inbox"]);
  const rows = messages.map(message => `<tr class="${message.read ? "" : "ses-unread-row"}" data-search-row="${escapeHtml(`${message.sender} ${message.subject} ${message.recipients.join(" ")}`.toLowerCase())}">
    <td><span class="ses-unread-label">${message.read ? "Read" : "Unread"}</span></td>
    <td><a href="#/ses/inbox/${encoded(message.messageId)}"><strong>${escapeHtml(message.subject || "(No subject)")}</strong></a><div class="muted small ses-preview">${escapeHtml(message.preview || "No text preview")}</div></td>
    <td>${escapeHtml(message.sender)}</td>
    <td>${escapeHtml(message.recipients.slice(0, 2).join(", ") || "No envelope recipients")}${message.recipients.length > 2 ? ` <span class="muted">+${message.recipients.length - 2}</span>` : ""}</td>
    <td><span class="no-wrap">${formatDate(message.acceptedAt)}</span>${message.attachmentCount ? `<div class="muted small">${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"}</div>` : ""}</td>
    <td><span class="ses-outcome">${escapeHtml(renderStatusLabel(message.renderStatus))} · ${escapeHtml(dispositionLabel(message.disposition))}</span>${message.templateName ? `<div class="muted small">Template: ${escapeHtml(message.templateName)}</div>` : ""}${message.configurationSetName ? `<div class="muted small">Configuration: ${escapeHtml(message.configurationSetName)}</div>` : ""}</td>
    <td><div class="actions"><button class="button link" data-inbox-read="${escapeHtml(message.messageId)}" data-next-read="${message.read ? "false" : "true"}">${message.read ? "Mark unread" : "Mark read"}</button>${message.deleted ? `<button class="button link" data-inbox-restore="${escapeHtml(message.messageId)}">Restore</button><button class="button link danger" data-inbox-purge="${escapeHtml(message.messageId)}">Purge</button>` : `<button class="button link danger" data-inbox-trash="${escapeHtml(message.messageId)}">Trash</button>`}</div></td>
  </tr>`).join("");
  const empty = status === "trash"
    ? emptyState("◇", "Trash is empty", "Messages moved to Trash appear here until they are purged.")
    : recipient
      ? emptyState("⌕", "No mail for this recipient", `No captured message has the envelope recipient ${recipient}.`, '<button class="button" data-action="clear-inbox-filter">Clear recipient filter</button>')
      : emptyState("✉", "No captured mail", "SES-accepted messages will appear here after their mailbox transaction commits.", '<a class="button primary" href="#/ses/send-test">Send test email</a>');
  context.main.innerHTML = `<div class="page-width ses-page ses-inbox-page">${pageHeader(status === "trash" ? "Trash" : "Inbox", "A private, durable mailbox for messages accepted by local SES.", `<button class="button refresh" data-action="refresh-inbox" title="Refresh" aria-label="Refresh Inbox">↻</button>${status === "trash" ? '<button class="button danger" data-action="purge-all-trash">Purge all Trash</button>' : '<a class="button primary" href="#/ses/send-test">Send test email</a>'}`)}
    <div class="alert info"><strong>Captured locally; no external delivery</strong><br>Every row is one logical SES-accepted message, regardless of how many envelope-recipient occurrences it contains. “Captured” never means delivered.${originService === "cognito-idp" ? " This view is filtered to Cognito confirmation messages." : ""}</div>
    <section class="card"><div class="card-header"><h2>Mailbox messages</h2></div><form id="ses-inbox-filter" class="ses-inbox-filter"><div class="field"><label>Exact envelope recipient</label><input name="recipient" value="${escapeHtml(recipient)}" list="ses-recipient-suggestions" placeholder="alice@example.test" autocomplete="off"><datalist id="ses-recipient-suggestions">${suggestions.map(item => { const address = text(typeof item === "string" ? item : firstDefined(item.address, item.Address, item.emailAddress, item.EmailAddress)); const count = firstDefined(item.messageCount, item.MessageCount, item.count, item.Count); return `<option value="${escapeHtml(address)}"${count === undefined ? "" : ` label="${escapeHtml(`${count} message${Number(count) === 1 ? "" : "s"}`)}"`}>`; }).join("")}</datalist></div><div class="field"><label>Mailbox view</label><select name="status"><option value="all" ${status === "all" ? "selected" : ""}>Inbox</option><option value="unread" ${status === "unread" ? "selected" : ""}>Unread</option><option value="trash" ${status === "trash" ? "selected" : ""}>Trash</option></select></div><div class="ses-inline-submit"><button class="button primary" type="submit">Apply filter</button>${recipient ? '<button class="button" type="button" data-action="clear-inbox-filter">Clear</button>' : ""}</div></form>
      <div class="table-wrap">${rows ? `<table class="ses-inbox-table"><thead><tr><th>Status</th><th>Subject</th><th>From</th><th>Envelope recipients</th><th>Captured</th><th>Outcome</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : empty}</div>
      <div class="ses-pagination"><span class="muted">Page ${inboxPaging.index + 1}${messages.length ? ` · ${messages.length} message${messages.length === 1 ? "" : "s"}` : ""}</span><nav class="pagination" aria-label="Inbox pagination"><button class="button" data-inbox-page="previous" ${inboxPaging.index === 0 ? "disabled" : ""}>Previous</button><button class="button" data-inbox-page="next" ${nextToken ? "" : "disabled"}>Next</button></nav></div>
    </section>
  </div>`;
  const reroute = () => context.route();
  document.querySelector("#ses-inbox-filter")?.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    location.hash = inboxHash(String(data.get("recipient") || "").trim(), String(data.get("status") || "all"), originService);
  });
  document.querySelectorAll('[data-action="clear-inbox-filter"]').forEach(button => button.addEventListener("click", () => { location.hash = inboxHash("", status, originService); }));
  document.querySelector('[data-action="refresh-inbox"]')?.addEventListener("click", () => {
    inboxPaging = { key: pagingKey, tokens: [undefined], index: 0 };
    reroute();
  });
  document.querySelector('[data-inbox-page="previous"]')?.addEventListener("click", () => { inboxPaging.index = Math.max(0, inboxPaging.index - 1); reroute(); });
  document.querySelector('[data-inbox-page="next"]')?.addEventListener("click", () => {
    if (!nextToken) return;
    inboxPaging.tokens[inboxPaging.index + 1] = nextToken;
    inboxPaging.index += 1;
    reroute();
  });
  document.querySelectorAll("[data-inbox-read]").forEach(button => button.addEventListener("click", async () => {
    try {
      await consoleMutation(`/_stacksim/api/ses/inbox/${encoded(button.dataset.inboxRead)}`, "PATCH", { read: button.dataset.nextRead === "true" });
      context.toast(button.dataset.nextRead === "true" ? "Message marked read" : "Message marked unread");
      reroute();
    } catch (error) { context.showError(error); }
  }));
  document.querySelectorAll("[data-inbox-trash]").forEach(button => button.addEventListener("click", async () => {
    try {
      await consoleMutation(`/_stacksim/api/ses/inbox/${encoded(button.dataset.inboxTrash)}`, "DELETE");
      context.toast("Message moved to Trash");
      reroute();
    } catch (error) { context.showError(error); }
  }));
  document.querySelectorAll("[data-inbox-restore]").forEach(button => button.addEventListener("click", async () => {
    try {
      await consoleMutation(`/_stacksim/api/ses/inbox/${encoded(button.dataset.inboxRestore)}`, "PATCH", { deleted: false });
      context.toast("Message restored to Inbox");
      reroute();
    } catch (error) { context.showError(error); }
  }));
  document.querySelectorAll("[data-inbox-purge]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.inboxPurge;
    context.confirmDeletion("PURGE", "Permanently purge this message and its captured content? This cannot be undone. Enter PURGE to continue.", async () => {
      await consoleMutation("/_stacksim/api/ses/inbox/purge", "POST", { messageIds: [id] });
      context.toast("Message permanently purged");
    });
  }));
  document.querySelector('[data-action="purge-all-trash"]')?.addEventListener("click", () => context.confirmDeletion("PURGE", "Permanently purge every message currently in Trash? This cannot be undone. Enter PURGE to continue.", async () => {
    await consoleMutation("/_stacksim/api/ses/inbox/purge", "POST", { allTrash: true });
    context.toast("Trash permanently purged");
  }));
}

const droppedElements = new Set(["SCRIPT", "STYLE", "LINK", "META", "BASE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "APPLET", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "OPTION", "VIDEO", "AUDIO", "SOURCE", "TRACK", "CANVAS", "SVG", "MATH", "TEMPLATE"]);
const allowedElements = new Set(["A", "ABBR", "ADDRESS", "B", "BDI", "BDO", "BLOCKQUOTE", "BR", "CAPTION", "CITE", "CODE", "COL", "COLGROUP", "DD", "DEL", "DETAILS", "DFN", "DIV", "DL", "DT", "EM", "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "I", "INS", "KBD", "LI", "MARK", "OL", "P", "PRE", "Q", "S", "SAMP", "SECTION", "SMALL", "SPAN", "STRONG", "SUB", "SUMMARY", "SUP", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TIME", "TR", "U", "UL", "VAR"]);

function loopbackHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const parts = normalized.split(".").map(Number);
  return parts.length === 4 && parts[0] === 127 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
}

function sanitizedEmailDocument(source) {
  const parsed = new DOMParser().parseFromString(String(source || ""), "text/html");
  for (const element of [...parsed.body.querySelectorAll("*")]) {
    if (element.tagName === "IMG") {
      const alternative = element.getAttribute("alt");
      element.replaceWith(parsed.createTextNode(alternative ? `[Image: ${alternative}]` : "[Image removed]"));
      continue;
    }
    if (droppedElements.has(element.tagName)) {
      element.remove();
      continue;
    }
    if (!allowedElements.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const suppliedHref = element.tagName === "A" ? element.getAttribute("href") : undefined;
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (element.tagName !== "A" || !suppliedHref) continue;
    let target;
    try { target = new URL(suppliedHref); }
    catch { continue; }
    if (!["http:", "https:"].includes(target.protocol)) continue;
    element.setAttribute("href", target.href);
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
    element.setAttribute("referrerpolicy", "no-referrer");
    element.setAttribute("title", loopbackHost(target.hostname) ? `Open local link ${target.host}` : `Open external host ${target.host}`);
    element.classList.add(loopbackHost(target.hostname) ? "local-link" : "external-link");
    element.after(parsed.createTextNode(" ↗"));
  }
  const content = parsed.body.innerHTML;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src blob:; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'"><meta name="referrer" content="no-referrer"><style>html{color:#16191f;background:#fff;font:14px/1.55 Arial,sans-serif}body{margin:0;padding:16px;overflow-wrap:anywhere}a{color:#0972d3}pre{white-space:pre-wrap}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #b6bec9;padding:6px;text-align:left}.external-link:after{content:" external";font-size:10px;color:#5f6b7a;text-transform:uppercase}.local-link:after{content:" local";font-size:10px;color:#037f0c;text-transform:uppercase}</style></head><body>${content}</body></html>`;
}

function linkifiedText(source) {
  const value = String(source || "");
  const expression = /https?:\/\/[^\s<>"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let output = ""; let index = 0;
  for (const match of value.matchAll(expression)) {
    output += escapeHtml(value.slice(index, match.index));
    const matched = match[0];
    let candidate = matched;
    let trailing = "";
    if (/^https?:/i.test(candidate)) {
      while (/[.,;:!?]$/.test(candidate)) {
        trailing = candidate.at(-1) + trailing;
        candidate = candidate.slice(0, -1);
      }
      for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        while (candidate.endsWith(closing) && candidate.split(closing).length > candidate.split(opening).length) {
          trailing = closing + trailing;
          candidate = candidate.slice(0, -1);
        }
      }
      let url;
      try { url = new URL(candidate); } catch { url = undefined; }
      output += url && ["http:", "https:"].includes(url.protocol)
        ? `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="${escapeHtml(loopbackHost(url.hostname) ? `Open local link ${url.host}` : `Open external host ${url.host}`)}">${escapeHtml(candidate)}</a>`
        : escapeHtml(candidate);
      output += escapeHtml(trailing);
    } else {
      output += `<a href="mailto:${encoded(candidate)}" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(candidate)}</a>`;
    }
    index = match.index + matched.length;
  }
  return `${output}${escapeHtml(value.slice(index))}`;
}

function detailMessage(value) {
  const message = value.message ?? value.Message ?? value;
  const summary = inboxSummary(message);
  const allRecipients = values(firstDefined(message.recipients, message.Recipients, message.envelopeRecipients, message.EnvelopeRecipients)).map(item => {
    if (typeof item === "string") return { address: item };
    return {
      address: text(firstDefined(item.address, item.Address, item.emailAddress, item.EmailAddress)),
      type: text(firstDefined(item.headerKind, item.HeaderKind, item.type, item.Type, item.headerRole, item.HeaderRole)),
      isEnvelope: firstDefined(item.isEnvelope, item.IsEnvelope),
    };
  }).filter(item => item.address);
  const envelopeInput = firstDefined(message.envelopeRecipients, message.EnvelopeRecipients);
  const envelopeRecipients = envelopeInput === undefined
    ? allRecipients.filter(item => item.isEnvelope === true)
    : values(envelopeInput).map(item => typeof item === "string"
      ? { address: item }
      : {
        address: text(firstDefined(item.address, item.Address, item.emailAddress, item.EmailAddress)),
        type: text(firstDefined(item.headerKind, item.HeaderKind, item.type, item.Type, item.headerRole, item.HeaderRole)),
      }).filter(item => item.address);
  const addressesByHeader = kind => allRecipients.filter(item => item.type.toUpperCase() === kind).map(item => item.address);
  const addressList = (explicit, kind) => explicit === undefined ? addressesByHeader(kind) : values(explicit).map(item => text(typeof item === "string" ? item : firstDefined(item.address, item.Address))).filter(Boolean);
  return {
    ...summary,
    sourceAddress: text(firstDefined(message.source, message.Source, message.sourceAddress, message.SourceAddress, message.from, message.From)),
    returnPath: text(firstDefined(message.returnPath, message.ReturnPath)),
    replyTo: values(firstDefined(message.replyTo, message.ReplyTo, message.replyToAddresses, message.ReplyToAddresses)).map(text),
    to: addressList(firstDefined(message.to, message.To, message.toAddresses, message.ToAddresses), "TO"),
    cc: addressList(firstDefined(message.cc, message.Cc, message.ccAddresses, message.CcAddresses), "CC"),
    bcc: addressList(firstDefined(message.bcc, message.Bcc, message.bccAddresses, message.BccAddresses), "BCC"),
    envelopeRecipients,
    textBody: firstDefined(message.text, message.Text, message.textBody, message.TextBody, message.content?.text, ""),
    htmlBody: firstDefined(message.html, message.Html, message.htmlBody, message.HtmlBody, message.content?.html, ""),
    attachments: values(firstDefined(message.attachments, message.Attachments)),
    tags: firstDefined(message.messageTags, message.MessageTags, message.tags, message.Tags, {}),
    headers: firstDefined(message.headers, message.Headers, {}),
    apiFamily: text(firstDefined(message.apiFamily, message.ApiFamily)),
    operation: text(firstDefined(message.operation, message.Operation)),
    originalRawAvailable: firstDefined(message.originalRawAvailable, message.OriginalRawAvailable, message.hasOriginalRaw, false) === true,
    normalizedRawAvailable: firstDefined(message.normalizedRawAvailable, message.NormalizedRawAvailable, message.hasNormalizedRaw, summary.renderStatus !== "FAILED") !== false,
    outcomeCode: text(firstDefined(message.outcomeCode, message.OutcomeCode)),
    outcomeDetail: (() => {
      const detail = firstDefined(message.outcomeDetail, message.OutcomeDetail, message.renderError, message.RenderError);
      if (detail === undefined || detail === null) return "";
      return typeof detail === "string" ? detail : JSON.stringify(detail);
    })(),
    truncated: firstDefined(message.truncated, message.Truncated, false) === true,
  };
}

function attachmentDescriptor(value, index) {
  return {
    id: text(firstDefined(value.attachmentId, value.AttachmentId, value.id, value.Id, index)),
    name: text(firstDefined(value.fileName, value.FileName, value.filename, value.Name, `attachment-${index + 1}`)),
    contentType: text(firstDefined(value.contentType, value.ContentType, "application/octet-stream")),
    size: Number(firstDefined(value.byteLength, value.ByteLength, value.size, value.Size, value.bytes, value.Bytes, 0)),
    contentDisposition: text(firstDefined(value.contentDisposition, value.ContentDisposition)),
  };
}

function safeDownloadName(value, fallback) {
  const cleaned = String(value || "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 180);
  return cleaned || fallback;
}

function responseFilename(response, fallback) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  let value = encodedMatch?.[1] ?? plainMatch?.[1];
  if (encodedMatch && value) try { value = decodeURIComponent(value); } catch {}
  return safeDownloadName(value, fallback);
}

async function download(path, fallbackName, context) {
  try {
    const response = await binaryRequest(path);
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = responseFilename(response, fallbackName);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  } catch (error) { context.showError(error); }
}

async function inboxDetail(context, messageId) {
  const message = detailMessage(await request(`/_stacksim/api/ses/inbox/${encoded(messageId)}`));
  const attachments = message.attachments.map(attachmentDescriptor);
  const tags = tagsObject(message.tags);
  const headers = values(message.headers).map(header => typeof header === "string"
    ? { name: "", value: header }
    : {
      name: text(firstDefined(header.name, header.Name)),
      value: text(firstDefined(header.value, header.Value)),
    });
  const envelope = message.envelopeRecipients.map(recipient => `${recipient.type ? `${recipient.type}: ` : ""}${recipient.address}`);
  const textAvailable = Boolean(message.textBody);
  const htmlAvailable = Boolean(message.htmlBody);
  const tabs = [
    ...(textAvailable ? ['<button class="tab active" role="tab" aria-selected="true" tabindex="0" data-message-view="text">Text</button>'] : []),
    ...(htmlAvailable ? [`<button class="tab ${textAvailable ? "" : "active"}" role="tab" aria-selected="${textAvailable ? "false" : "true"}" tabindex="${textAvailable ? "-1" : "0"}" data-message-view="html">HTML</button>`] : []),
  ].join("");
  setChrome(context, ["Inbox", message.subject || message.messageId]);
  context.main.innerHTML = `<div class="page-width ses-page ses-message-detail">${pageHeader(message.subject || "(No subject)", `Message ID ${escapeHtml(message.messageId)}`, `<button class="button" data-action="toggle-message-read">${message.read ? "Mark unread" : "Mark read"}</button>${message.deleted ? '<button class="button" data-action="restore-message">Restore</button><button class="button danger" data-action="purge-message">Purge permanently</button>' : '<button class="button danger" data-action="trash-message">Move to Trash</button>'}`)}
    <div class="alert ${message.disposition === "CAPTURED" ? "info" : "warning"}"><strong>${escapeHtml(renderStatusLabel(message.renderStatus))} · ${escapeHtml(dispositionLabel(message.disposition))}</strong><br>${message.renderStatus === "FAILED" ? `Rendering failed after acceptance. No body has been fabricated.${message.outcomeCode ? ` ${escapeHtml(message.outcomeCode)}.` : ""}${message.outcomeDetail ? ` ${escapeHtml(message.outcomeDetail)}` : ""}` : message.disposition === "SUPPRESSED" ? "The rendered message is inspectable, but local disposition was suppressed and no delivery was attempted." : "The message was captured locally. No external delivery was attempted."}</div>
    <section class="card"><div class="card-header"><h2>Message details</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>From</dt><dd>${escapeHtml(message.sourceAddress)}</dd><dt>Reply-To</dt><dd>${escapeHtml(message.replyTo.join(", ") || "None")}</dd><dt>Return path</dt><dd>${escapeHtml(message.returnPath || "Default")}</dd></dl><dl class="key-value"><dt>To</dt><dd>${escapeHtml(message.to.join(", ") || "None")}</dd><dt>Cc</dt><dd>${escapeHtml(message.cc.join(", ") || "None")}</dd><dt>Bcc input</dt><dd>${escapeHtml(message.bcc.join(", ") || "None")}</dd></dl><dl class="key-value"><dt>Envelope recipients</dt><dd>${escapeHtml(envelope.join(", ") || message.recipients.join(", ") || "None")}</dd><dt>Accepted</dt><dd>${formatDate(message.acceptedAt)}</dd><dt>API</dt><dd>${escapeHtml([message.apiFamily, message.operation].filter(Boolean).join(" · ") || "SES")}</dd></dl></div></section>
    ${(message.templateName || message.configurationSetName || Object.keys(tags).length) ? `<section class="card"><div class="card-header"><h2>Send context</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Template</dt><dd>${message.templateName ? `<a href="#/ses/templates/${encoded(message.templateName)}">${escapeHtml(message.templateName)}</a>` : "None"}</dd></dl><dl class="key-value"><dt>Configuration set</dt><dd>${message.configurationSetName ? `<a href="#/ses/configuration-sets/${encoded(message.configurationSetName)}">${escapeHtml(message.configurationSetName)}</a>` : "None"}</dd></dl><dl class="key-value"><dt>Message tags</dt><dd>${escapeHtml(Object.entries(tags).map(([key, value]) => `${key}=${value}`).join(", ") || "None")}</dd></dl></div></section>` : ""}
    ${headers.length ? `<section class="card"><div class="card-header"><h2>Headers <span class="muted">(${headers.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${headers.map(header => `<tr><td class="mono">${escapeHtml(header.name || "(unnamed)")}</td><td>${escapeHtml(header.value)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
    <section class="card"><div class="card-header"><h2>Content</h2><div class="actions">${message.normalizedRawAvailable ? '<button class="button" data-download-raw="normalized">Download normalized raw</button>' : ""}${message.originalRawAvailable ? '<button class="button" data-download-raw="original">Download original raw</button>' : ""}</div></div>
      ${message.renderStatus === "FAILED" ? emptyState("!", "No rendered body", "SES accepted this request but template rendering failed, so no normalized body is available.") : `${tabs ? `<div class="tabs ses-message-tabs" role="tablist">${tabs}</div>` : ""}<div class="ses-message-content">${textAvailable ? `<section role="tabpanel" data-message-panel="text"><div class="ses-text-body">${linkifiedText(message.textBody)}</div></section>` : ""}${htmlAvailable ? `<section role="tabpanel" data-message-panel="html" ${textAvailable ? "hidden" : ""}><iframe class="ses-html-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Sanitized HTML message"></iframe></section>` : ""}${!textAvailable && !htmlAvailable ? emptyState("◇", "No display body", "Raw source may still be available for this message.") : ""}</div>`}
      ${message.truncated ? '<div class="alert info"><strong>Display content truncated</strong><br>Use the raw-source download for the complete captured bytes.</div>' : ""}
    </section>
    <section class="card"><div class="card-header"><h2>Attachments <span class="muted">(${attachments.length})</span></h2></div><div class="table-wrap">${attachments.length ? `<table><thead><tr><th>File name</th><th>Content type</th><th>Size</th><th></th></tr></thead><tbody>${attachments.map(attachment => `<tr><td>${escapeHtml(attachment.name)}</td><td>${escapeHtml(attachment.contentType)}</td><td>${attachment.size.toLocaleString()} bytes</td><td><button class="button" data-download-attachment="${escapeHtml(attachment.id)}" data-attachment-name="${escapeHtml(attachment.name)}">Download</button></td></tr>`).join("")}</tbody></table>` : emptyState("◇", "No attachments", "This message has no captured attachments.")}</div></section>
    <p><a href="#/ses/inbox">← Back to Inbox</a></p>
  </div>`;
  const frame = document.querySelector(".ses-html-frame");
  if (frame) frame.srcdoc = sanitizedEmailDocument(message.htmlBody);
  const selectView = view => {
    document.querySelectorAll("[data-message-view]").forEach(tab => {
      const active = tab.dataset.messageView === view;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-message-panel]").forEach(panel => { panel.hidden = panel.dataset.messagePanel !== view; });
  };
  document.querySelectorAll("[data-message-view]").forEach(tab => tab.addEventListener("click", () => selectView(tab.dataset.messageView)));
  document.querySelector(".ses-message-tabs")?.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll("[data-message-view]")];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    selectView(tabs[next].dataset.messageView);
    tabs[next].focus();
  });
  document.querySelector('[data-action="toggle-message-read"]')?.addEventListener("click", async () => {
    try {
      await consoleMutation(`/_stacksim/api/ses/inbox/${encoded(message.messageId)}`, "PATCH", { read: !message.read });
      context.toast(message.read ? "Message marked unread" : "Message marked read");
      await context.route();
    } catch (error) { context.showError(error); }
  });
  document.querySelector('[data-action="trash-message"]')?.addEventListener("click", async () => {
    try {
      await consoleMutation(`/_stacksim/api/ses/inbox/${encoded(message.messageId)}`, "DELETE");
      context.toast("Message moved to Trash");
      location.hash = "#/ses/inbox?status=trash";
    } catch (error) { context.showError(error); }
  });
  document.querySelector('[data-action="restore-message"]')?.addEventListener("click", async () => {
    try {
      await consoleMutation(`/_stacksim/api/ses/inbox/${encoded(message.messageId)}`, "PATCH", { deleted: false });
      context.toast("Message restored to Inbox");
      await context.route();
    } catch (error) { context.showError(error); }
  });
  document.querySelector('[data-action="purge-message"]')?.addEventListener("click", () => context.confirmDeletion("PURGE", "Permanently purge this message and all of its captured content? Enter PURGE to continue.", async () => {
    await consoleMutation("/_stacksim/api/ses/inbox/purge", "POST", { messageIds: [message.messageId] });
    context.toast("Message permanently purged");
    location.hash = "#/ses/inbox?status=trash";
  }));
  document.querySelectorAll("[data-download-raw]").forEach(button => button.addEventListener("click", () => download(`/_stacksim/api/ses/inbox/${encoded(message.messageId)}/raw?variant=${encoded(button.dataset.downloadRaw)}`, `${message.messageId}.eml`, context)));
  document.querySelectorAll("[data-download-attachment]").forEach(button => button.addEventListener("click", () => download(`/_stacksim/api/ses/inbox/${encoded(message.messageId)}/attachments/${encoded(button.dataset.downloadAttachment)}`, button.dataset.attachmentName || "attachment", context)));
  if (!message.read) {
    consoleMutation(`/_stacksim/api/ses/inbox/${encoded(message.messageId)}`, "PATCH", { read: true }).catch(context.showError);
  }
}

function templateModal(context, existing) {
  const content = existing?.TemplateContent ?? existing?.templateContent ?? {};
  context.showModal(existing ? "Edit email template" : "Create email template", `<div class="field"><label>Template name</label><input name="name" required maxlength="64" ${existing ? "disabled" : ""} value="${escapeHtml(existing ? templateName(existing) : "")}" pattern="[A-Za-z0-9_-]+"></div>
    <div class="field"><label>Subject</label><input name="subject" required value="${escapeHtml(firstDefined(content.Subject, content.subject, ""))}"></div>
    <div class="field-row"><div class="field"><label>Text body</label><textarea name="text">${escapeHtml(firstDefined(content.Text, content.text, ""))}</textarea></div><div class="field"><label>HTML body</label><textarea name="html">${escapeHtml(firstDefined(content.Html, content.html, ""))}</textarea></div></div>
    ${existing ? "" : '<div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>'}`, existing ? "Save changes" : "Create template", async data => {
    const name = existing ? templateName(existing) : String(data.get("name") || "");
    const TemplateContent = { Subject: String(data.get("subject") || ""), Text: String(data.get("text") || ""), Html: String(data.get("html") || "") };
    if (existing) await sesV2(`templates/${encoded(name)}`, { method: "PUT", body: { TemplateContent } });
    else await sesV2("templates", { method: "POST", body: { TemplateName: name, TemplateContent, Tags: parseTags(data.get("tags")) } });
    context.toast(existing ? "Email template updated" : "Email template created");
    location.hash = `#/ses/templates/${encoded(name)}`;
  }, true, { refreshAfterSubmit: false });
}

async function templatesPage(context) {
  const templates = await listTemplates();
  setChrome(context, ["Email templates"]);
  const rows = templates.map(template => {
    const name = templateName(template);
    return `<tr data-search-row="${escapeHtml(name.toLowerCase())}"><td><a href="#/ses/templates/${encoded(name)}"><strong>${escapeHtml(name)}</strong></a></td><td>${formatDate(firstDefined(template.CreatedTimestamp, template.createdTimestamp))}</td><td><a class="button link" href="#/ses/send-test?template=${encoded(name)}">Send test</a></td></tr>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Email templates", "Create reusable subject, text, and HTML content shared by classic SES and SES v2.", '<button class="button refresh" data-action="refresh" aria-label="Refresh templates" title="Refresh">↻</button><button class="button primary" data-action="create-template">Create template</button>')}
    <section class="card"><div class="card-header"><h2>Templates <span class="muted">(${templates.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find a template"></label></div><div class="table-wrap">${rows ? `<table><thead><tr><th>Template name</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("T", "No email templates", "Create a stored template for personalized SES sends.", '<button class="button primary" data-action="create-template">Create template</button>')}</div></section>
  </div>`;
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-template"]').forEach(button => button.addEventListener("click", () => templateModal(context)));
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

async function templateDetail(context, name) {
  const resourceArn = `arn:aws:ses:${ui.region}:${ui.summary?.accountId ?? "000000000000"}:template/${name}`;
  const [template, tagResult] = await Promise.all([
    sesV2(`templates/${encoded(name)}`),
    sesV2("tags", { query: { ResourceArn: resourceArn } }),
  ]);
  template.TemplateName ??= name;
  const content = template.TemplateContent ?? template.templateContent ?? {};
  const tags = tagsObject(tagResult.Tags ?? tagResult.tags);
  setChrome(context, ["Email templates", name]);
  context.main.innerHTML = `<div class="page-width ses-page ses-detail">${pageHeader(name, "Stored SES email template.", `<a class="button" href="#/ses/send-test?template=${encoded(name)}">Send test email</a><button class="button" data-action="edit-template">Edit</button><button class="button danger" data-action="delete-template">Delete</button>`)}
    <section class="card"><div class="card-header"><h2>Template content</h2></div><div class="card-body"><dl class="key-value"><dt>Subject</dt><dd>${escapeHtml(firstDefined(content.Subject, content.subject, ""))}</dd></dl><div class="field-row"><div><h3>Text</h3><pre class="code-box ses-template-preview">${escapeHtml(firstDefined(content.Text, content.text, ""))}</pre></div><div><h3>HTML source</h3><pre class="code-box ses-template-preview">${escapeHtml(firstDefined(content.Html, content.html, ""))}</pre></div></div></div></section>
    <section class="card"><div class="card-header"><h2>Test render</h2></div><div class="card-body"><form id="ses-test-render"><div class="field"><label>Template data (JSON object)</label><textarea name="templateData">{}</textarea></div><button class="button primary" type="submit">Render template</button></form></div><div id="ses-render-result" hidden><div class="card-header"><h3>Rendered MIME</h3></div><pre class="code-box ses-render-output"></pre></div></section>
    <section class="card"><div class="card-header"><h2>Tags <span class="muted">(${Object.keys(tags).length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${Object.entries(tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("") || '<tr><td colspan="2" class="muted">No tags.</td></tr>'}</tbody></table></div></section>
  </div>`;
  document.querySelector('[data-action="edit-template"]')?.addEventListener("click", () => templateModal(context, template));
  document.querySelector('[data-action="delete-template"]')?.addEventListener("click", () => context.confirmDeletion(name, `Delete stored template ${name}? Existing captured messages retain their rendered content.`, async () => {
    await sesV2(`templates/${encoded(name)}`, { method: "DELETE" });
    context.toast("Email template deleted");
    location.hash = "#/ses/templates";
  }));
  document.querySelector("#ses-test-render")?.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(event.currentTarget);
      const result = await sesV2(`templates/${encoded(name)}/render`, { method: "POST", body: { TemplateData: JSON.stringify(parseObject(data.get("templateData"), "Template data")) } });
      const output = document.querySelector("#ses-render-result");
      output.hidden = false;
      output.querySelector("pre").textContent = String(result.RenderedTemplate ?? result.renderedTemplate ?? "");
      submit.disabled = false;
      setDirty(false);
      context.toast("Template rendered");
    } catch (error) {
      submit.disabled = false;
      context.showError(error);
    }
  });
}

function configurationSetModal(context) {
  context.showModal("Create configuration set", `<div class="field"><label>Configuration set name</label><input name="name" required maxlength="64" pattern="[A-Za-z0-9_-]+"></div>
    <div class="field"><label class="checkbox-label"><input type="checkbox" name="sendingEnabled" checked> Enable sending</label></div>
    <div class="field"><label>Tags (JSON object)</label><textarea name="tags">{}</textarea></div>
    <div class="alert info"><strong>Start with basic configuration</strong><br>Supported CloudWatch or EventBridge destinations and suppression options can be added from the detail page. Reputation, dedicated pools, TLS options, VDM, and archiving are unavailable.</div>`, "Create configuration set", async data => {
    const name = String(data.get("name") || "");
    await sesV2("configuration-sets", { method: "POST", body: { ConfigurationSetName: name, SendingOptions: { SendingEnabled: data.get("sendingEnabled") === "on" }, Tags: parseTags(data.get("tags")) } });
    context.toast("Configuration set created");
    location.hash = `#/ses/configuration-sets/${encoded(name)}`;
  }, true, { refreshAfterSubmit: false });
}

async function configurationSetsPage(context) {
  const configurations = await listConfigurationSets();
  const descriptors = await mapWithConcurrency(configurations, 8, async item => {
    const name = configurationSetName(item);
    if (typeof item !== "string" && firstDefined(item.SendingOptions, item.sendingOptions)) return { ...item, ConfigurationSetName: name };
    try { return { ...(await sesV2(`configuration-sets/${encoded(name)}`)), ConfigurationSetName: name }; }
    catch (error) {
      if (error?.status === 404) return { ConfigurationSetName: name, missing: true };
      throw error;
    }
  });
  setChrome(context, ["Configuration sets"]);
  const rows = descriptors.map(configuration => {
    const name = configurationSetName(configuration);
    const enabled = firstDefined(configuration.SendingOptions?.SendingEnabled, configuration.sendingOptions?.sendingEnabled, configuration.SendingEnabled, configuration.sendingEnabled, true) !== false;
    const state = configuration.missing ? "Deleted during refresh" : enabled ? "Sending enabled" : "Sending paused";
    return `<tr data-search-row="${escapeHtml(name.toLowerCase())}"><td><a href="#/ses/configuration-sets/${encoded(name)}"><strong>${escapeHtml(name)}</strong></a></td><td>${statusBadge(state, !configuration.missing && enabled ? "success" : "")}</td><td>Local capture controls only</td></tr>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Configuration sets", "Group sends under a named, immediately enforced sending-state control.", '<button class="button refresh" data-action="refresh" aria-label="Refresh configuration sets" title="Refresh">↻</button><button class="button primary" data-action="create-configuration-set">Create configuration set</button>')}
    <div class="alert info"><strong>Truthful opening slice</strong><br>Configuration-set sending state is active. Event destinations, reputation, tracking, suppression, archive, dedicated-pool, TLS, and VDM settings are not success-shaped placeholders.</div>
    <section class="card"><div class="card-header"><h2>Configuration sets <span class="muted">(${descriptors.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find a configuration set"></label></div><div class="table-wrap">${rows ? `<table><thead><tr><th>Name</th><th>Sending state</th><th>Capabilities</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("C", "No configuration sets", "Create a configuration set to control sending for a group of messages.", '<button class="button primary" data-action="create-configuration-set">Create configuration set</button>')}</div></section>
  </div>`;
  context.bindTableFilter();
  document.querySelectorAll('[data-action="create-configuration-set"]').forEach(button => button.addEventListener("click", () => configurationSetModal(context)));
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

async function configurationSetDetail(context, name) {
  const [configuration, destinationResult] = await Promise.all([
    sesV2(`configuration-sets/${encoded(name)}`),
    sesV2(`configuration-sets/${encoded(name)}/event-destinations`),
  ]);
  const enabled = firstDefined(configuration.SendingOptions?.SendingEnabled, configuration.sendingOptions?.sendingEnabled, configuration.SendingEnabled, configuration.sendingEnabled, true) !== false;
  const tags = tagsObject(configuration.Tags ?? configuration.tags);
  const destinations = values(destinationResult.EventDestinations ?? destinationResult.eventDestinations);
  const suppressedReasons = values(configuration.SuppressionOptions?.SuppressedReasons ?? configuration.suppressionOptions?.suppressedReasons);
  const tracking = configuration.TrackingOptions ?? configuration.trackingOptions;
  setChrome(context, ["Configuration sets", name]);
  context.main.innerHTML = `<div class="page-width ses-page ses-detail">${pageHeader(name, "SES configuration set.", `<button class="button" data-action="configure-suppression">Suppression options</button><button class="button primary" data-action="create-event-destination">Add event destination</button><button class="button ${enabled ? "danger" : "primary"}" data-action="toggle-configuration-sending">${enabled ? "Pause sending" : "Enable sending"}</button><button class="button danger" data-action="delete-configuration-set">Delete</button>`)}
    <section class="card"><div class="card-header"><h2>Configuration</h2></div><div class="card-body detail-grid"><dl class="key-value"><dt>Name</dt><dd>${escapeHtml(name)}</dd><dt>Sending state</dt><dd>${statusBadge(enabled ? "Enabled" : "Paused", enabled ? "success" : "")}</dd></dl><dl class="key-value"><dt>Event destinations</dt><dd>${destinations.length}</dd><dt>Tracking domain</dt><dd>${escapeHtml(tracking?.CustomRedirectDomain ?? "Not configured")}</dd></dl><dl class="key-value"><dt>Suppressed reasons</dt><dd>${escapeHtml(suppressedReasons.join(", ") || "Account defaults")}</dd><dt>Dedicated pools / VDM</dt><dd>Unavailable locally</dd></dl></div></section>
    <div class="alert info"><strong>Measurable local events only</strong><br>CloudWatch and the default EventBridge bus receive SEND, REJECT, rendering-failure, and explicit local-link outcomes. Remote delivery, ISP, open, and complaint events are never invented.</div>
    <section class="card"><div class="card-header"><h2>Event destinations <span class="muted">(${destinations.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Destination</th><th>Events</th><th>State</th><th></th></tr></thead><tbody>${destinations.map(item => `<tr><td>${escapeHtml(item.Name)}</td><td>${item.CloudWatchDestination ? "CloudWatch" : "EventBridge"}</td><td>${escapeHtml(values(item.MatchingEventTypes).join(", "))}</td><td>${item.Enabled ? "Enabled" : "Disabled"}</td><td><button class="button link" data-delete-destination="${escapeHtml(item.Name)}">Delete</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">No event destinations.</td></tr>'}</tbody></table></div></section>
    <section class="card"><div class="card-header"><h2>Tags <span class="muted">(${Object.keys(tags).length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${Object.entries(tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("") || '<tr><td colspan="2" class="muted">No tags.</td></tr>'}</tbody></table></div></section>
  </div>`;
  document.querySelector('[data-action="toggle-configuration-sending"]')?.addEventListener("click", async button => {
    const control = button.currentTarget;
    control.disabled = true;
    try {
      await sesV2(`configuration-sets/${encoded(name)}/sending`, { method: "PUT", body: { SendingEnabled: !enabled } });
      context.toast(enabled ? "Configuration-set sending paused" : "Configuration-set sending enabled");
      await context.route();
    } catch (error) {
      control.disabled = false;
      context.showError(error);
    }
  });
  document.querySelector('[data-action="configure-suppression"]')?.addEventListener("click", () => context.showModal("Configuration-set suppression", `<div class="field"><span class="field-label">Suppress reasons</span><label class="checkbox-label"><input type="checkbox" name="bounce" ${suppressedReasons.includes("BOUNCE") ? "checked" : ""}> Bounce</label><label class="checkbox-label"><input type="checkbox" name="complaint" ${suppressedReasons.includes("COMPLAINT") ? "checked" : ""}> Complaint</label></div>`, "Save", async data => {
    await sesV2(`configuration-sets/${encoded(name)}/suppression-options`, { method: "PUT", body: { SuppressedReasons: [data.get("bounce") === "on" ? "BOUNCE" : "", data.get("complaint") === "on" ? "COMPLAINT" : ""].filter(Boolean) } });
    context.toast("Suppression options updated");
  }));
  document.querySelector('[data-action="create-event-destination"]')?.addEventListener("click", () => context.showModal("Add event destination", `<div class="field-row"><div class="field"><label>Name</label><input name="destinationName" required pattern="[A-Za-z0-9_-]+"></div><div class="field"><label>Destination</label><select name="kind"><option value="eventbridge">EventBridge default bus</option><option value="cloudwatch">CloudWatch metrics</option></select></div></div><div class="field"><label>Matching events</label><input name="events" value="SEND,REJECT,RENDERING_FAILURE"></div><div class="field"><label>CloudWatch dimension name</label><input name="dimension" value="ConfigurationSet"></div>`, "Add", async data => {
    const kind = String(data.get("kind"));
    const EventDestination = { Enabled: true, MatchingEventTypes: String(data.get("events") || "").split(",").map(value => value.trim()).filter(Boolean), ...(kind === "eventbridge" ? { EventBridgeDestination: { EventBusArn: `arn:aws:events:${ui.region}:${ui.summary?.accountId ?? "000000000000"}:event-bus/default` } } : { CloudWatchDestination: { DimensionConfigurations: [{ DimensionName: String(data.get("dimension") || "ConfigurationSet"), DimensionValueSource: "MESSAGE_TAG", DefaultDimensionValue: name }] } }) };
    await sesV2(`configuration-sets/${encoded(name)}/event-destinations`, { method: "POST", body: { EventDestinationName: String(data.get("destinationName")), EventDestination } });
    context.toast("Event destination created");
  }, true));
  document.querySelectorAll("[data-delete-destination]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deleteDestination, `Delete event destination ${button.dataset.deleteDestination}?`, async () => {
    await sesV2(`configuration-sets/${encoded(name)}/event-destinations/${encoded(button.dataset.deleteDestination)}`, { method: "DELETE" });
    context.toast("Event destination deleted");
  })));
  document.querySelector('[data-action="delete-configuration-set"]')?.addEventListener("click", () => context.confirmDeletion(name, `Delete configuration set ${name}? Sends and identities must no longer reference it.`, async () => {
    await sesV2(`configuration-sets/${encoded(name)}`, { method: "DELETE" });
    context.toast("Configuration set deleted");
    location.hash = "#/ses/configuration-sets";
  }));
}

async function suppressionPage(context) {
  const result = await sesV2("suppression/addresses", { query: { PageSize: 1000 } });
  const destinations = values(result.SuppressedDestinationSummaries ?? result.suppressedDestinationSummaries);
  setChrome(context, ["Suppression list"]);
  const rows = destinations.map(item => {
    const address = text(item.EmailAddress ?? item.emailAddress);
    const reason = text(item.Reason ?? item.reason);
    const updated = firstDefined(item.LastUpdateTime, item.lastUpdateTime);
    const normalizedTime = typeof updated === "number" && updated < 10_000_000_000 ? updated * 1000 : updated;
    return `<tr data-search-row="${escapeHtml(`${address} ${reason}`.toLowerCase())}"><td><strong>${escapeHtml(address)}</strong></td><td>${statusBadge(reason, reason === "COMPLAINT" ? "" : "neutral")}</td><td>${formatDate(normalizedTime)}</td><td><button class="button link" data-action="delete-suppressed" data-address="${escapeHtml(address)}">Remove</button></td></tr>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Suppression list", "Prevent locally accepted SES messages from being captured for known bounced or complained recipients.", '<button class="button refresh" data-action="refresh" aria-label="Refresh suppression list">↻</button><button class="button primary" data-action="add-suppressed">Add email address</button>')}
    <div class="alert info"><strong>Local suppression is an accepted outcome</strong><br>SES returns a message ID and retains inspectable rendered content, but marks the mailbox row Suppressed instead of Captured. No remote bounce or complaint is fabricated.</div>
    <section class="card"><div class="card-header"><h2>Suppressed destinations <span class="muted">(${destinations.length})</span></h2></div><div class="toolbar"><label class="filter"><span aria-hidden="true">⌕</span><input data-filter-table placeholder="Find an email address or reason"></label></div><div class="table-wrap">${rows ? `<table><thead><tr><th>Email address</th><th>Reason</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("!", "No suppressed destinations", "Add a destination to test bounce or complaint suppression.")}</div></section>
  </div>`;
  context.bindTableFilter();
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
  document.querySelector('[data-action="add-suppressed"]')?.addEventListener("click", () => context.showModal("Add suppressed destination", `<div class="field"><label>Email address</label><input name="emailAddress" type="email" required></div><div class="field"><label>Reason</label><select name="reason"><option value="BOUNCE">Bounce</option><option value="COMPLAINT">Complaint</option></select></div>`, "Add", async data => {
    await sesV2("suppression/addresses", { method: "PUT", body: { EmailAddress: String(data.get("emailAddress") || ""), Reason: String(data.get("reason") || "BOUNCE") } });
    context.toast("Destination added to the suppression list");
  }));
  document.querySelectorAll('[data-action="delete-suppressed"]').forEach(button => button.addEventListener("click", () => {
    const address = button.dataset.address;
    context.confirmDeletion(address, `Remove ${address} from the SES suppression list?`, async () => {
      await sesV2(`suppression/addresses/${encoded(address)}`, { method: "DELETE" });
      context.toast("Destination removed from the suppression list");
    });
  }));
}

async function contactListsPage(context) {
  const result = await sesV2("contact-lists", { query: { PageSize: 100 } });
  const lists = values(result.ContactLists ?? result.contactLists);
  setChrome(context, ["Contact lists"]);
  const rows = lists.map(item => {
    const name = text(item.ContactListName ?? item.contactListName);
    const updated = firstDefined(item.LastUpdatedTimestamp, item.lastUpdatedTimestamp);
    return `<tr data-search-row="${escapeHtml(name.toLowerCase())}"><td><a href="#/ses/contact-lists/${encoded(name)}"><strong>${escapeHtml(name)}</strong></a></td><td>${formatDate(typeof updated === "number" && updated < 10_000_000_000 ? updated * 1000 : updated)}</td></tr>`;
  }).join("");
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Contact lists", "Model topics, contact preferences, and local unsubscribe state.", '<button class="button primary" data-action="create-contact-list">Create contact list</button>')}
    <section class="card"><div class="card-header"><h2>Contact lists <span class="muted">(${lists.length})</span></h2></div><div class="table-wrap">${rows ? `<table><thead><tr><th>Name</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("@", "No contact lists", "Create a contact list to test subscription preferences.")}</div></section></div>`;
  document.querySelector('[data-action="create-contact-list"]')?.addEventListener("click", () => context.showModal("Create contact list", `<div class="field"><label>Name</label><input name="name" required pattern="[A-Za-z0-9_-]+"></div><div class="field"><label>Description</label><textarea name="description"></textarea></div><div class="field"><label>Topics (JSON array)</label><textarea name="topics">[]</textarea></div>`, "Create", async data => {
    const Topics = JSON.parse(String(data.get("topics") || "[]"));
    await sesV2("contact-lists", { method: "POST", body: { ContactListName: String(data.get("name") || ""), Description: String(data.get("description") || ""), Topics } });
    context.toast("Contact list created");
    location.hash = `#/ses/contact-lists/${encoded(data.get("name"))}`;
  }, true, { refreshAfterSubmit: false }));
}

async function contactListDetail(context, name) {
  const [list, contactsResult] = await Promise.all([
    sesV2(`contact-lists/${encoded(name)}`),
    sesV2(`contact-lists/${encoded(name)}/contacts/list`, { method: "POST", body: { PageSize: 100 } }),
  ]);
  const contacts = values(contactsResult.Contacts ?? contactsResult.contacts);
  const topics = values(list.Topics ?? list.topics);
  setChrome(context, ["Contact lists", name]);
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader(name, "SES contact list and subscription preferences.", '<button class="button primary" data-action="create-contact">Add contact</button><button class="button danger" data-action="delete-contact-list">Delete list</button>')}
    <section class="card"><div class="card-header"><h2>Topics <span class="muted">(${topics.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Topic</th><th>Display name</th><th>Default</th></tr></thead><tbody>${topics.map(topic => `<tr><td>${escapeHtml(topic.TopicName)}</td><td>${escapeHtml(topic.DisplayName)}</td><td>${escapeHtml(topic.DefaultSubscriptionStatus)}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">No topics.</td></tr>'}</tbody></table></div></section>
    <section class="card"><div class="card-header"><h2>Contacts <span class="muted">(${contacts.length})</span></h2></div><div class="table-wrap"><table><thead><tr><th>Email address</th><th>Unsubscribe all</th><th>Preferences</th><th></th></tr></thead><tbody>${contacts.map(contact => `<tr><td>${escapeHtml(contact.EmailAddress)}</td><td>${contact.UnsubscribeAll ? "Yes" : "No"}</td><td>${escapeHtml(values(contact.TopicPreferences).map(item => `${item.TopicName}: ${item.SubscriptionStatus}`).join(", ") || "Defaults")}</td><td><button class="button link" data-delete-contact="${escapeHtml(contact.EmailAddress)}">Delete</button></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No contacts.</td></tr>'}</tbody></table></div></section></div>`;
  document.querySelector('[data-action="create-contact"]')?.addEventListener("click", () => context.showModal("Add contact", `<div class="field"><label>Email address</label><input type="email" name="emailAddress" required></div><div class="field"><label>Topic preferences (JSON array)</label><textarea name="preferences">[]</textarea></div><label class="checkbox-label"><input type="checkbox" name="unsubscribeAll"> Unsubscribe from all topics</label>`, "Add", async data => {
    await sesV2(`contact-lists/${encoded(name)}/contacts`, { method: "POST", body: { EmailAddress: String(data.get("emailAddress") || ""), TopicPreferences: JSON.parse(String(data.get("preferences") || "[]")), UnsubscribeAll: data.get("unsubscribeAll") === "on" } });
    context.toast("Contact added");
  }));
  document.querySelectorAll("[data-delete-contact]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deleteContact, `Delete contact ${button.dataset.deleteContact}?`, async () => {
    await sesV2(`contact-lists/${encoded(name)}/contacts/${encoded(button.dataset.deleteContact)}`, { method: "DELETE" });
    context.toast("Contact deleted");
  })));
  document.querySelector('[data-action="delete-contact-list"]')?.addEventListener("click", () => context.confirmDeletion(name, `Delete contact list ${name} and its contacts?`, async () => {
    await sesV2(`contact-lists/${encoded(name)}`, { method: "DELETE" });
    context.toast("Contact list deleted");
    location.hash = "#/ses/contact-lists";
  }));
}

async function customVerificationTemplatesPage(context) {
  const result = await sesV2("custom-verification-email-templates", { query: { PageSize: 100 } });
  const templates = values(result.CustomVerificationEmailTemplates ?? result.customVerificationEmailTemplates);
  setChrome(context, ["Custom verification"]);
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Custom verification templates", "Customize SES identity-verification messages while retaining signed local verification links.", '<button class="button primary" data-action="create-custom-verification">Create template</button>')}
    <section class="card"><div class="card-header"><h2>Verification templates</h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>From</th><th>Subject</th><th></th></tr></thead><tbody>${templates.map(item => `<tr><td><strong>${escapeHtml(item.TemplateName)}</strong></td><td>${escapeHtml(item.FromEmailAddress)}</td><td>${escapeHtml(item.TemplateSubject)}</td><td><button class="button link" data-delete-custom="${escapeHtml(item.TemplateName)}">Delete</button></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No custom verification templates.</td></tr>'}</tbody></table></div></section></div>`;
  document.querySelector('[data-action="create-custom-verification"]')?.addEventListener("click", () => context.showModal("Create custom verification template", `<div class="field-row"><div class="field"><label>Name</label><input name="name" required pattern="[A-Za-z0-9_-]+"></div><div class="field"><label>Verified From address</label><input name="from" type="email" required></div></div><div class="field"><label>Subject</label><input name="subject" required></div><div class="field"><label>HTML content</label><textarea name="content" required><a href="{{verificationURL}}">Verify email address</a></textarea></div><div class="field-row"><div class="field"><label>Success URL</label><input name="success" type="url" value="http://localhost/success" required></div><div class="field"><label>Failure URL</label><input name="failure" type="url" value="http://localhost/failure" required></div></div>`, "Create", async data => {
    await sesV2("custom-verification-email-templates", { method: "POST", body: { TemplateName: String(data.get("name")), FromEmailAddress: String(data.get("from")), TemplateSubject: String(data.get("subject")), TemplateContent: String(data.get("content")), SuccessRedirectionURL: String(data.get("success")), FailureRedirectionURL: String(data.get("failure")) } });
    context.toast("Custom verification template created");
  }, true));
  document.querySelectorAll("[data-delete-custom]").forEach(button => button.addEventListener("click", () => context.confirmDeletion(button.dataset.deleteCustom, `Delete custom verification template ${button.dataset.deleteCustom}?`, async () => {
    await sesV2(`custom-verification-email-templates/${encoded(button.dataset.deleteCustom)}`, { method: "DELETE" });
    context.toast("Custom verification template deleted");
  })));
}

async function sendingStatisticsPage(context) {
  const end = Date.now();
  const start = end - 24 * 60 * 60 * 1000;
  const metrics = ["SEND", "DELIVERY", "REJECT", "RENDERING_FAILURE"];
  const result = await sesV2("metrics/batch", { method: "POST", body: { Queries: metrics.map(Metric => ({ Id: Metric.toLowerCase(), Metric, StartDate: start / 1000, EndDate: end / 1000 })) } });
  const valuesById = Object.fromEntries(values(result.Results).map(item => [item.Id, values(item.Values).at(-1) ?? 0]));
  setChrome(context, ["Sending statistics"]);
  context.main.innerHTML = `<div class="page-width ses-page">${pageHeader("Sending statistics", "Metrics derived only from committed local SES outcomes during the last 24 hours.", '<button class="button refresh" data-action="refresh">↻</button>')}
    <div class="alert info"><strong>Local measurement boundary</strong><br>Delivery means captured in the simulator Inbox. No remote mailbox, ISP, open, or complaint outcome is inferred.</div>
    <div class="dashboard-grid">${[["Send", "send"], ["Captured locally", "delivery"], ["Suppressed / rejected", "reject"], ["Rendering failures", "rendering_failure"]].map(([label, id]) => `<section class="card service-card"><div class="card-body"><h2>${escapeHtml(label)}</h2><div class="metric">${escapeHtml(String(valuesById[id] ?? 0))}</div><div class="metric-label">committed outcomes</div></div></section>`).join("")}</div>
  </div>`;
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => context.route());
}

export async function routeSes(_parts, context) {
  const { parts, query } = routeLocation();
  if (parts[0] !== "ses") return context.notFound(parts);
  const render = async pending => {
    const result = await pending;
    decorateSesPanelHelp(context.main);
    return result;
  };
  if (parts.length === 1) return render(dashboard(context));
  if (parts[1] === "identities" && parts.length === 2) return render(identitiesPage(context));
  if (parts[1] === "identities" && parts.length === 3) return render(identityDetail(context, parts[2]));
  if (parts[1] === "send-test" && parts.length === 2) return render(sendTestPage(context, query));
  if (parts[1] === "inbox" && parts.length === 2) return render(inboxPage(context, query));
  if (parts[1] === "inbox" && parts.length === 3) return render(inboxDetail(context, parts[2]));
  if (parts[1] === "templates" && parts.length === 2) return render(templatesPage(context));
  if (parts[1] === "templates" && parts.length === 3) return render(templateDetail(context, parts[2]));
  if (parts[1] === "configuration-sets" && parts.length === 2) return render(configurationSetsPage(context));
  if (parts[1] === "configuration-sets" && parts.length === 3) return render(configurationSetDetail(context, parts[2]));
  if (parts[1] === "suppression" && parts.length === 2) return render(suppressionPage(context));
  if (parts[1] === "contact-lists" && parts.length === 2) return render(contactListsPage(context));
  if (parts[1] === "contact-lists" && parts.length === 3) return render(contactListDetail(context, parts[2]));
  if (parts[1] === "custom-verification-templates" && parts.length === 2) return render(customVerificationTemplatesPage(context));
  if (parts[1] === "statistics" && parts.length === 2) return render(sendingStatisticsPage(context));
  return context.notFound(parts);
}
