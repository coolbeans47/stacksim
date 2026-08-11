import { assumeRole, awsQuery, getCallerIdentity, request, rest } from "./api-client.js";
import { associateFormLabels, emptyState, escapeHtml, loading, pageHeader } from "./components.js";
import { normalizeHash, parseRoute, routeNotFound, shouldGuardNavigation } from "./router.js";
import { clearCredentials, session as ui, setCredentials, setDirty, setRegion } from "./state.js";
import { bindGlobalSearch } from "./search.js";
import { createShell } from "./shell.js";
import { bindTableFilter, createUi, prettyJson } from "./ui.js";
import { bindArnMultiComboboxes, enhanceArnComboboxes } from "./arn-combobox.js";
import { metadata as homeMetadata, routeHome } from "./services/home.js";
import { metadata as lambdaMetadata, routeLambda } from "./services/lambda.js";
import { metadata as dynamodbMetadata, routeDynamoDb } from "./services/dynamodb.js";
import { metadata as apigatewayMetadata, routeApiGateway } from "./services/apigateway.js";
import { metadata as cloudwatchMetadata, routeCloudWatch } from "./services/cloudwatch.js";
import { metadata as iamMetadata, routeIam } from "./services/iam.js";
import { metadata as s3Metadata, routeS3 } from "./services/s3.js";
import { metadata as rdsMetadata, routeRds } from "./services/rds.js";
import { metadata as sqsMetadata, routeSqs } from "./services/sqs.js";
import { metadata as snsMetadata, routeSns } from "./services/sns.js";
import { metadata as eventbridgeMetadata, routeEventBridge } from "./services/eventbridge.js";
import { metadata as cloudformationMetadata, routeCloudFormation } from "./services/cloudformation.js";
import { metadata as sesMetadata, routeSes } from "./services/ses.js";
import { metadata as cognitoMetadata, routeCognito } from "./services/cognito.js";
import { metadata as parameterStoreMetadata, routeParameterStore } from "./services/parameter-store.js";
import { metadata as secretsManagerMetadata, routeSecretsManager } from "./services/secrets-manager.js";
import { metadata as appsyncMetadata, routeAppSync } from "./services/appsync.js";
import { metadata as stepFunctionsMetadata, routeStepFunctions } from "./services/step-functions.js";

const main = document.querySelector("#main");
const sidebar = document.querySelector("#sidebar");
const serviceHeader = document.querySelector("#service-header");
const dialog = document.querySelector("#modal");
const navigationButton = document.querySelector("#navigation-button");
const helpButton = document.querySelector("#help-button");
const helpPanel = document.querySelector("#help-panel");
const serviceMeta = {
  home: homeMetadata,
  lambda: lambdaMetadata,
  dynamodb: dynamodbMetadata,
  apigateway: apigatewayMetadata,
  cloudwatch: cloudwatchMetadata,
  iam: iamMetadata,
  s3: s3Metadata,
  rds: rdsMetadata,
  sqs: sqsMetadata,
  sns: snsMetadata,
  eventbridge: eventbridgeMetadata,
  cloudformation: cloudformationMetadata,
  ses: sesMetadata,
  cognito: cognitoMetadata,
  "systems-manager": parameterStoreMetadata,
  "secrets-manager": secretsManagerMetadata,
  appsync: appsyncMetadata,
  "step-functions": stepFunctionsMetadata,
};
let acceptedHash = normalizeHash(location.hash);
let pendingNavigation = null;

function identityLabel(identity) {
  const arn = identity?.arn ?? "";
  return arn.match(/:assumed-role\/([^/]+)\//)?.[1] ?? (arn.endsWith(":root") ? "root" : arn.split("/").at(-1) || "signed in");
}

function updateIdentityChrome() {
  const active = ui.credentials?.active;
  const button = document.querySelector(".account-button");
  button.textContent = active?.identity ? `${identityLabel(active.identity)} · ${active.identity.account}` : ui.authMode === "off" ? "authentication off" : "Sign in";
  document.documentElement.dataset.assumedRole = active && ui.credentials?.source !== active ? "true" : "false";
}

function friendlySignInError(error) {
  const code = error?.code ?? "";
  if (code === "ConsoleSignInRequired") return "The credential session has expired. Sign in again to continue.";
  if (code === "InvalidClientTokenId" || code === "SignatureDoesNotMatch") {
    return "The access key or session token is unknown, invalid, or expired.";
  }
  if (code === "RequestExpired") return "The credential session or signed request has expired.";
  if (code === "AccessDenied" || code === "AccessDeniedException") return "The identity is valid but does not have permission for this operation.";
  return error instanceof Error ? error.message : "Sign-in failed.";
}

function showSignIn(message = "") {
  setChrome("home", ["Sign in"]);
  sidebar.innerHTML = "";
  main.innerHTML = `<div class="page-width sign-in-page"><div class="card sign-in-card"><div class="sign-in-brand-banner" aria-hidden="true"><img src="/_stacksim/console/assets/stacksim-logo.png" alt=""></div><h1>Sign in to StackSim</h1><p>Use a long-lived IAM access key or an STS session. Credentials stay in this tab's <span class="mono">sessionStorage</span> and are never sent unsigned.</p>${message ? `<div class="alert error" role="alert"><strong>Sign-in failed</strong><br>${escapeHtml(message)}</div>` : ""}<form id="console-sign-in"><div class="field"><label>Access key ID</label><input name="accessKeyId" autocomplete="username" required></div><div class="field"><label>Secret access key</label><input name="secretAccessKey" type="password" autocomplete="current-password" required></div><div class="field"><label>Session token <span class="hint">(optional)</span></label><textarea name="sessionToken" autocomplete="off"></textarea></div><button class="button primary" type="submit">Sign in</button></form><p class="hint">Fresh installations use access key ID <span class="mono">admin</span>, secret access key <span class="mono">password</span>, and no session token for IAM user <span class="mono">admin</span>. This is an access-key sign-in, not a username/password login. Recovery root is a separate temporary repair mode.</p></div></div>`;
  associateFormLabels(main);
  const form = document.querySelector("#console-sign-in");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    const credentials = {
      accessKeyId: String(data.get("accessKeyId") ?? "").trim(),
      secretAccessKey: String(data.get("secretAccessKey") ?? ""),
      ...(String(data.get("sessionToken") ?? "").trim() ? { sessionToken: String(data.get("sessionToken")).trim() } : {}),
    };
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const identity = await getCallerIdentity(credentials);
      const source = { ...credentials, identity };
      setCredentials({ source, active: source });
      updateIdentityChrome();
      await route();
      await maybeOfferDefaultKeyRotation();
    } catch (error) {
      showSignIn(friendlySignInError(error));
    }
  });
  requestAnimationFrame(() => form.querySelector('[name="accessKeyId"]')?.focus());
}

let consoleConfig;
async function maybeOfferDefaultKeyRotation() {
  if (!consoleConfig?.bootId || ui.authMode === "off" || !ui.credentials?.active) return;
  const claim = await rest("/_stacksim/api/console-onboarding/default-access-key/claim", "POST", { bootId: consoleConfig.bootId, claimId: crypto.randomUUID() }).catch(() => null);
  if (!claim?.show) return;
  const warning = claim.weakBuiltInDefault
    ? "The built-in admin/password access key is intentionally convenient and weak. Generate a random IAM access key before exposing this simulator beyond loopback."
    : "This is the first console login for the configured default IAM user. You may optionally replace its configuration-managed key.";
  showModal("Secure the default IAM access key", `<div class="alert warning"><strong>First console login</strong><br>${escapeHtml(warning)}</div><fieldset class="onboarding-choice-list"><legend>Choose how to secure this access key</legend><label class="onboarding-choice"><input type="radio" name="choice" value="generate" checked><span><strong>Generate replacement access key (Recommended)</strong><small>Create an provider-compatible key and deactivate the configured IAM key after validation.</small></span></label><label class="onboarding-choice"><input type="radio" name="choice" value="keep"><span><strong>Keep default credentials</strong><small>Do not show this offer again. You can rotate later under IAM Security credentials.</small></span></label></fieldset>`, "Continue", async data => {
    if (data.get("choice") === "keep") {
      await rest("/_stacksim/api/console-onboarding/default-access-key/outcome", "POST", { outcome: "keptDefault" });
      return;
    }
    const source = ui.credentials.source;
    const created = await awsQuery("iam", "CreateAccessKey", { UserName: source.identity.arn.split("/").at(-1) });
    const generated = { accessKeyId: created.value("AccessKeyId"), secretAccessKey: created.value("SecretAccessKey") };
    await rest("/_stacksim/api/console-onboarding/default-access-key/outcome", "POST", { outcome: "rotationIncomplete", replacementAccessKeyId: generated.accessKeyId }).catch(() => undefined);
    setTimeout(() => showModal("Save the replacement access key", `<div class="alert warning"><strong>Secret shown once</strong><br>Copy or download this pair now. The secret cannot be retrieved again.</div><dl class="key-value"><dt>Access key ID</dt><dd class="mono">${escapeHtml(generated.accessKeyId)}</dd><dt>Secret access key</dt><dd class="mono">${escapeHtml(generated.secretAccessKey)}</dd></dl><label><input type="checkbox" name="saved" value="yes" required> I saved the replacement pair.</label>`, "Validate and switch", async acknowledgement => {
      if (acknowledgement.get("saved") !== "yes") throw new Error("Confirm that you saved the replacement pair.");
      const identity = await getCallerIdentity(generated);
      if (identity.userId !== source.identity.userId) throw new Error("The replacement key resolved to a different IAM user.");
      await awsQuery("iam", "UpdateAccessKey", { UserName: source.identity.arn.split("/").at(-1), AccessKeyId: source.accessKeyId, Status: "Inactive" }, { credentials: generated });
      const next = { ...generated, identity };
      setCredentials({ source: next, active: next });
      generated.secretAccessKey = "";
      await rest("/_stacksim/api/console-onboarding/default-access-key/outcome", "POST", { outcome: "rotationCompleted", replacementAccessKeyId: next.accessKeyId });
      toast("Replacement access key is active; the configured IAM key is inactive.");
    }, false, { refreshAfterSubmit: false }), 0);
  }, false, { refreshAfterSubmit: false });
}

const { setChrome, setHomeServices, closeNavigation } = createShell(serviceMeta, { sidebar, serviceHeader, navigationButton });
const { toast, showError, showModal, confirmDeletion } = createUi({
  dialog,
  content: document.querySelector("#modal-content"),
  toastRegion: document.querySelector("#toast-region"),
  afterSubmit: async () => route(),
});

function closeHelpPanel(restoreFocus = false) {
  const wasOpen = !helpPanel.hidden;
  helpPanel.hidden = true;
  helpButton.setAttribute("aria-expanded", "false");
  if (restoreFocus && wasOpen) {
    const target = mobileViewport.matches ? mobileGlobalButton : helpButton;
    if (target.isConnected) target.focus();
  }
}

function openHelpPanel() {
  closeNavigation();
  helpPanel.hidden = false;
  helpButton.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => helpPanel.querySelector("[data-help-close]")?.focus());
}

function placeholder(service, title) {
  setChrome(service, [serviceMeta[service].name, title]);
  main.innerHTML = `<div class="page-width">${pageHeader(title, "This area is reserved for future service functionality.")}<div class="card">${emptyState("◇", "Not implemented yet", "The navigation and page structure are in place and will grow with the simulator.")}</div></div>`;
}

function notFound(parts) {
  const missing = routeNotFound(parts);
  setChrome("home", [missing.title]);
  main.innerHTML = `<div class="page-width">${pageHeader(missing.title, `The console route ${escapeHtml(missing.path)} does not exist.`)}<div class="card">${emptyState("404", "We couldn't find that page", "Check the address or return to the console home.", '<a class="button primary" href="#/home">Console home</a>')}</div></div>`;
}

const serviceContext = { main, setChrome, setHomeServices, showModal, toast, confirmDeletion, showError, bindTableFilter, route, prettyJson, placeholder, notFound, serviceMeta };

async function route(focus = true) {
  setDirty(false, "all");
  closeHelpPanel();
  if (dialog.open) dialog.close();
  main.innerHTML = loading("Loading");
  try {
    if (ui.authMode !== "off" && !ui.credentials?.active) return showSignIn();
    if (!ui.summary) {
      ui.summary = await rest("/_stacksim/api/summary");
      ui.region = ui.summary.region;
      document.querySelector("#region-button").textContent = ui.summary.region === "eu-west-1" ? "eu-west-1 · Europe (Ireland)" : ui.summary.region;
    }
    const parts = parseRoute();
    if (parts[0] === "home" || parts[0] === "environment") await routeHome(parts, serviceContext);
    else if (parts[0] === "lambda") {
      if (!await routeLambda(parts, serviceContext)) placeholder("lambda", parts[1] ?? "Unknown page");
    } else if (parts[0] === "dynamodb") await routeDynamoDb(parts, serviceContext);
    else if (parts[0] === "apigateway") await routeApiGateway(parts, serviceContext);
    else if (parts[0] === "cloudwatch") await routeCloudWatch(parts, serviceContext);
    else if (parts[0] === "iam") await routeIam(parts, serviceContext);
    else if (parts[0] === "s3") await routeS3(parts, serviceContext);
    else if (parts[0] === "rds") await routeRds(parts, serviceContext);
    else if (parts[0] === "sqs") await routeSqs(parts, serviceContext);
    else if (parts[0] === "sns") await routeSns(parts, serviceContext);
    else if (parts[0] === "eventbridge") await routeEventBridge(parts, serviceContext);
    else if (parts[0] === "cloudformation") await routeCloudFormation(parts, serviceContext);
    else if (parts[0] === "ses") await routeSes(parts, serviceContext);
    else if (parts[0] === "cognito") await routeCognito(parts, serviceContext);
    else if (parts[0] === "systems-manager") await routeParameterStore(parts, serviceContext);
    else if (parts[0] === "secrets-manager") await routeSecretsManager(parts, serviceContext);
    else if (parts[0] === "appsync") await routeAppSync(parts, serviceContext);
    else if (parts[0] === "step-functions") await routeStepFunctions(parts, serviceContext);
    else notFound(parts);
    associateFormLabels(main);
    enhanceArnComboboxes(main);
    bindArnMultiComboboxes(main);
    if (focus) requestAnimationFrame(() => main.focus({ preventScroll: true }));
  } catch (error) {
    if (ui.authMode !== "off" && ["ConsoleSignInRequired", "InvalidClientTokenId", "RequestExpired", "SignatureDoesNotMatch"].includes(error?.code)) {
      clearCredentials();
      return showSignIn(friendlySignInError(error));
    }
    setChrome("home", ["Error"]);
    main.innerHTML = `<div class="page-width">${pageHeader("Unable to load this page", "The local console could not complete this request.")}<div class="alert error" role="alert"><strong>Request failed</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div><button class="button" data-action="retry-route">Try again</button></div>`;
    associateFormLabels(main);
    document.querySelector('[data-action="retry-route"]').addEventListener("click", () => route());
    if (focus) requestAnimationFrame(() => main.focus({ preventScroll: true }));
  }
}

function commitNavigation(target) {
  const normalized = normalizeHash(target);
  pendingNavigation = null;
  setDirty(false, "all");
  if (normalizeHash(location.hash) === normalized) {
    if (acceptedHash !== normalized) {
      acceptedHash = normalized;
      route();
    }
    return;
  }
  location.hash = normalized;
}

function requestNavigation(target) {
  const normalized = normalizeHash(target);
  if (normalized === acceptedHash) return;
  if (!shouldGuardNavigation(ui.dirty, acceptedHash, normalized)) {
    commitNavigation(normalized);
    return;
  }
  pendingNavigation = normalized;
  showModal("Discard unsaved changes?", "<p>You have unsaved changes on this page. Leaving now will discard them.</p>", "Discard changes", async () => {
    const destination = pendingNavigation;
    pendingNavigation = null;
    if (destination) commitNavigation(destination);
  }, false, { danger: true, refreshAfterSubmit: false });
}

bindGlobalSearch(document.querySelector("#global-search"), serviceMeta, toast, requestNavigation);

document.querySelector(".services-button").addEventListener("click", () => showModal("Services", `<div class="service-menu">${Object.values(serviceMeta).filter(service => service.key !== "home").sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })).map(service => `<a href="${service.links.find(link => !link[2])?.[1] ?? "#/home"}" data-service-key="${escapeHtml(service.key)}"><span class="service-icon ${service.cls}" aria-hidden="true">${escapeHtml(service.icon)}</span><strong>${escapeHtml(service.name)}</strong></a>`).join("")}</div>`, "Close", async () => undefined, true, { cancelLabel: "Cancel", refreshAfterSubmit: false }));

document.querySelector("#region-button").addEventListener("click", async () => {
  const environment = await rest("/_stacksim/api/environment");
  showModal("Select a region", `<div class="region-list">${environment.regions.map(region => `<label><input type="radio" name="region" value="${escapeHtml(region)}" ${region === ui.region ? "checked" : ""}><span><strong>${escapeHtml(region)}</strong>${region === "eu-west-1" ? "Europe (Ireland)" : "Local region"}</span></label>`).join("")}</div>`, "Select region", async data => { setRegion(String(data.get("region"))); });
});

document.querySelector(".account-button").addEventListener("click", async () => {
  if (ui.authMode === "off") {
    showModal("Console identity", '<div class="alert warning"><strong>Authentication is disabled</strong><br>STACKSIM_AUTH_MODE=off is an intentional permissive development mode. Role switching is unavailable because requests have no enforced browser identity.</div><p><a href="#/environment">Local environment</a></p>', "Close", async () => undefined, false, { refreshAfterSubmit: false });
    return;
  }
  if (!ui.credentials?.source) return showSignIn();
  const source = ui.credentials.source;
  let roles;
  try {
    roles = (await request("/_stacksim/api/iam/roles", { service: "iam", credentials: source })).roles ?? [];
  } catch (error) {
    showError(error);
    return;
  }
  const assumed = ui.credentials.active !== source;
  showModal("Account and role", `<button class="button danger" type="button" data-console-sign-out>Sign out</button><div class="field"><label>Console identity</label><select name="role"><option value="" ${assumed ? "" : "selected"}>Original credentials · ${escapeHtml(source.identity?.arn ?? source.accessKeyId)}</option>${roles.map(role => `<option value="${escapeHtml(role.arn)}" ${ui.credentials.active?.identity?.arn?.includes(`/assumed-role/${role.roleName}/`) ? "selected" : ""}>${escapeHtml(role.roleName)}</option>`).join("")}</select><span class="hint">Selecting a role calls STS AssumeRole. All later console requests use the returned temporary credentials.</span></div><div class="alert info"><strong>Active principal</strong><br><span class="mono">${escapeHtml(ui.credentials.active?.identity?.arn ?? "")}</span></div><p><a href="#/environment">Local environment</a></p>`, "Switch identity", async data => {
    const roleArn = String(data.get("role") ?? "");
    if (!roleArn) setCredentials({ source, active: source });
    else {
      const active = await assumeRole(roleArn, source);
      setCredentials({ source, active });
    }
    ui.summary = null;
    updateIdentityChrome();
  }, false, { refreshAfterSubmit: true });
  dialog.querySelector("[data-console-sign-out]").onclick = () => {
    clearCredentials();
    showSignIn();
    if (dialog.open) dialog.close();
  };
});

document.querySelector('[title="Local terminal"]').addEventListener("click", () => showModal("Local terminal", '<div class="alert info"><strong>Local environment</strong><br>Use your local terminal with the SDK endpoint shown on the Local environment page.</div>', "Close", async () => undefined, false, { refreshAfterSubmit: false }));
document.querySelector('[title="Notifications"]').addEventListener("click", () => showModal("Notifications", emptyState("♢", "No new notifications", "Service notifications will appear here."), "Close", async () => undefined, false, { refreshAfterSubmit: false }));
helpButton.addEventListener("click", () => {
  if (helpPanel.hidden) openHelpPanel();
  else closeHelpPanel(true);
});
helpPanel.querySelector("[data-help-close]").addEventListener("click", () => closeHelpPanel(true));
helpPanel.addEventListener("click", event => { if (event.target.closest?.('a[href^="#/"]')) closeHelpPanel(); });
document.querySelector('[title="Settings"]').addEventListener("click", () => showModal("Settings", `<div class="field"><label>Theme</label><select name="theme"><option value="light">Light</option><option value="dark" ${document.documentElement.dataset.theme === "dark" ? "selected" : ""}>Dark</option></select></div>`, "Save", async data => { document.documentElement.dataset.theme = data.get("theme"); localStorage.setItem("stacksim-theme", String(data.get("theme"))); }, false, { refreshAfterSubmit: false }));

const globalHeader = document.querySelector(".global-header");
const globalTools = document.querySelector("#global-tools");
const mobileGlobalButton = document.querySelector(".mobile-global-button");
const mobileViewport = window.matchMedia("(max-width: 700px)");
function closeMobileGlobalMenu(restoreFocus = false) {
  globalHeader.classList.remove("mobile-global-open");
  mobileGlobalButton.setAttribute("aria-expanded", "false");
  mobileGlobalButton.setAttribute("aria-label", "Open global tools");
  if (restoreFocus) mobileGlobalButton.focus();
}
function openMobileGlobalMenu() {
  globalHeader.classList.add("mobile-global-open");
  mobileGlobalButton.setAttribute("aria-expanded", "true");
  mobileGlobalButton.setAttribute("aria-label", "Close global tools");
}
mobileGlobalButton.addEventListener("click", () => {
  if (globalHeader.classList.contains("mobile-global-open")) closeMobileGlobalMenu();
  else {
    openMobileGlobalMenu();
    requestAnimationFrame(() => document.querySelector("#global-search").focus());
  }
});
globalTools.addEventListener("click", event => {
  if (event.target.closest?.("button, a[role=option]")) closeMobileGlobalMenu();
});
document.addEventListener("click", event => {
  if (globalHeader.classList.contains("mobile-global-open") && !globalHeader.contains(event.target)) closeMobileGlobalMenu();
  if (sidebar.classList.contains("open") && !sidebar.contains(event.target) && !navigationButton.contains(event.target)) closeNavigation();
  if (!helpPanel.hidden && !helpPanel.contains(event.target) && !helpButton.contains(event.target)) closeHelpPanel();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && globalHeader.classList.contains("mobile-global-open")) {
    event.preventDefault();
    closeMobileGlobalMenu(true);
  } else if (event.key === "Escape" && sidebar.classList.contains("open")) {
    event.preventDefault();
    closeNavigation(true);
  } else if (event.key === "Escape" && !helpPanel.hidden) {
    event.preventDefault();
    closeHelpPanel(true);
  }
});
mobileViewport.addEventListener("change", event => {
  if (!event.matches) {
    closeMobileGlobalMenu();
    closeNavigation();
  }
});

navigationButton.addEventListener("click", () => {
  if (sidebar.classList.contains("open")) {
    closeNavigation(true);
    return;
  }
  closeHelpPanel();
  closeMobileGlobalMenu();
  sidebar.classList.add("open");
  navigationButton.setAttribute("aria-expanded", "true");
  navigationButton.setAttribute("aria-label", "Close navigation");
});

document.addEventListener("keydown", event => {
  if (event.defaultPrevented || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tab = event.target.closest?.('[role="tablist"] [role="tab"]');
  if (!tab || tab.hasAttribute("data-policy-editor-tab")) return;
  const tablist = tab.closest('[role="tablist"]');
  const tabs = [...tablist.querySelectorAll(':scope > [role="tab"]')].filter(candidate => !candidate.disabled && !candidate.hidden);
  const index = tabs.indexOf(tab);
  if (index < 0 || tabs.length < 2) return;
  let next;
  if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
  else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
  else if (event.key === "Home") next = tabs[0];
  else next = tabs.at(-1);
  event.preventDefault();
  tabs.forEach(candidate => { candidate.tabIndex = candidate === next ? 0 : -1; });
  next.focus();
  next.click();
});

document.addEventListener("click", event => {
  const copy = event.target.closest?.("[data-copy]");
  if (copy) navigator.clipboard.writeText(copy.dataset.copy).then(() => toast("Copied to clipboard"), showError);
  const link = event.target.closest?.('a[href^="#/"]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  event.preventDefault();
  const target = link.getAttribute("href");
  const closesMobileNavigation = sidebar.classList.contains("open") && sidebar.contains(link);
  if (closesMobileNavigation) closeNavigation();
  requestNavigation(target);
  if (closesMobileNavigation && normalizeHash(target) === acceptedHash) requestAnimationFrame(() => main.focus({ preventScroll: true }));
});

main.addEventListener("input", event => {
  if (!event.target.closest("dialog") && event.target.matches("textarea, .code-editor, [data-dirty-track]")) setDirty(true);
});
document.addEventListener("keydown", event => { if (event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); if (mobileViewport.matches) openMobileGlobalMenu(); document.querySelector("#global-search").focus(); } });
window.addEventListener("beforeunload", event => {
  if (!ui.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("hashchange", () => {
  const target = normalizeHash(location.hash);
  if (target === acceptedHash) return;
  if (shouldGuardNavigation(ui.dirty, acceptedHash, target)) {
    history.replaceState(history.state, "", acceptedHash);
    requestNavigation(target);
    return;
  }
  acceptedHash = target;
  route();
});
window.addEventListener("stacksim-auth-change", updateIdentityChrome);

document.documentElement.dataset.theme = localStorage.getItem("stacksim-theme") || "light";
if (!location.hash) history.replaceState(history.state, "", acceptedHash);
async function startConsole() {
  try {
    const response = await fetch("/_stacksim/api/console-config", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Console configuration failed (${response.status})`);
    const config = await response.json();
    consoleConfig = config;
    ui.authMode = config.authMode;
    if (!localStorage.getItem("stacksim-region")) ui.region = config.region;
    updateIdentityChrome();
    if (ui.authMode !== "off" && ui.credentials?.active) {
      try {
        const identity = await getCallerIdentity(ui.credentials.active);
        ui.credentials.active.identity = identity;
        if (ui.credentials.active === ui.credentials.source) ui.credentials.source.identity = identity;
        setCredentials(ui.credentials);
      } catch (error) {
        clearCredentials();
        return showSignIn(friendlySignInError(error));
      }
    }
    await route();
    await maybeOfferDefaultKeyRotation();
  } catch (error) {
    main.innerHTML = `<div class="page-width">${pageHeader("Unable to start the console", escapeHtml(error instanceof Error ? error.message : String(error)))}</div>`;
  }
}
startConsole();
