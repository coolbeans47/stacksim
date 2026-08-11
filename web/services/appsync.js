import { appsync, awsFetch, awsQuery, dynamo, metrics } from "../api-client.js";
import { emptyState, escapeHtml, formatDate, pageHeader } from "../components.js";
import { session, setDirty } from "../state.js";
import { decorateAppSyncPanelHelp } from "./appsync-help.js";

export const metadata = {
  key: "appsync",
  name: "AppSync",
  icon: "A",
  cls: "appsync",
  links: [["APIs", "#/appsync/apis"], ["Create API", "#/appsync/apis/create"]],
  search: ["appsync", "graphql", "schema", "resolver", "vtl", "api key", "iam", "data source", "realtime", "subscription", "websocket"],
};

const GRAPHQL_EDITOR_LIMIT = 256 * 1024;
const RENDERED_RESULT_LIMIT = 256 * 1024;
const schemaDrafts = new Map();
const recentDiagnostics = new Map();
let context;

const encoded = value => encodeURIComponent(value);
const apiRoot = apiId => `#/appsync/apis/${encoded(apiId)}`;
const apiHref = (apiId, section = "overview") => `${apiRoot(apiId)}/${section}`;
const maskedKey = "••••••••••••••••••••••••";

function bounded(value, maximum) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum)}\n… output truncated by the console …` : text;
}

function safeJson(value, maximum = RENDERED_RESULT_LIMIT) {
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = JSON.stringify({ errors: [{ message: "The result could not be rendered safely." }] }, null, 2); }
  return bounded(text, maximum);
}

function encodeDefinition(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function parseObject(value, label) {
  let parsed;
  try { parsed = JSON.parse(String(value || "{}")); }
  catch { throw new Error(`${label} must be valid JSON.`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

function optionalDescription(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

async function collectPages(path, field, query = {}) {
  const values = [];
  let nextToken;
  do {
    const page = await appsync(path, { query: { ...query, maxResults: 25, ...(nextToken ? { nextToken } : {}) } });
    values.push(...(page[field] ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return values;
}

async function listApis() {
  return collectPages("/v1/apis", "graphqlApis", { apiType: "GRAPHQL", owner: "CURRENT_ACCOUNT" });
}

async function getApi(apiId) {
  return (await appsync(`/v1/apis/${encoded(apiId)}`)).graphqlApi;
}

async function schemaStatus(apiId) {
  return appsync(`/v1/apis/${encoded(apiId)}/schemacreation`);
}

function stripInjectedScalars(sdl) {
  return String(sdl).replace(/^\s*scalar\s+(?:AWSDate|AWSTime|AWSDateTime|AWSTimestamp|AWSEmail|AWSJSON|AWSURL|AWSPhone|AWSIPAddress)\s*$/gm, "").replace(/^\s*\n/, "").trim();
}

async function introspection(apiId, format = "SDL") {
  return appsync(`/v1/apis/${encoded(apiId)}/schema`, { query: { format }, responseType: "text" });
}

async function editableSchema(apiId, status) {
  if (status.status === "SUCCESS") {
    const sdl = stripInjectedScalars(await introspection(apiId, "SDL"));
    schemaDrafts.set(apiId, sdl);
    return sdl;
  }
  return schemaDrafts.get(apiId) ?? "";
}

function schemaCoordinates(sdl) {
  const result = [];
  const typePattern = /\btype\s+([_A-Za-z][_0-9A-Za-z]*)[^{]*\{([\s\S]*?)\}/g;
  let typeMatch;
  while ((typeMatch = typePattern.exec(String(sdl)))) {
    const [, typeName, body] = typeMatch;
    const fieldPattern = /^\s*([_A-Za-z][_0-9A-Za-z]*)\s*(?:\([^)]*\))?\s*:/gm;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(body))) result.push({ typeName, fieldName: fieldMatch[1] });
  }
  return result;
}

function detailTabs(apiId, active) {
  const tabs = [
    ["overview", "Overview"],
    ["schema", "Schema"],
    ["queries", "Queries"],
    ["data-sources", "Data sources"],
    ["resolvers", "Resolvers"],
    ["api-keys", "API keys"],
    ["monitoring", "Monitoring"],
    ["tags", "Tags"],
  ];
  return `<div class="tabs appsync-tabs" role="tablist" aria-label="GraphQL API sections">${tabs.map(([key, label]) => `<a class="tab ${key === active ? "active" : ""}" role="tab" aria-selected="${key === active}" tabindex="${key === active ? "0" : "-1"}" href="${apiHref(apiId, key)}">${label}</a>`).join("")}</div>`;
}

function setApiChrome(api, section) {
  context.setChrome("appsync", ["AppSync", { label: "APIs", href: "#/appsync/apis" }, { label: api.name, href: apiHref(api.apiId) }, section]);
}

function unsupportedBoundary() {
  return `<div class="alert info"><strong>Implemented boundary</strong><br>API-key and IAM GraphQL authorization, generated VTL pipelines, NONE/DynamoDB data sources, and the frozen Amplify Todo realtime subscriptions are active. Cognito/Lambda/OIDC authorization, enhanced filters/invalidation, APPSYNC_JS, Lambda/HTTP/EventBridge data sources, caches, domains, merged APIs, AppSync Events, and complete Amplify deployment/output generation remain unavailable.</div>`;
}

function createApiForm() {
  return `<form id="appsync-create-api"><div class="field"><label>API name</label><input name="name" required maxlength="65536" autocomplete="off" placeholder="local-notes"></div><div class="field"><label>Authorization mode</label><select name="authenticationType"><option value="API_KEY">API key</option></select><span class="hint">P0 intentionally exposes only API_KEY. Additional and default authorization modes are unavailable.</span></div><div class="field"><label>Introspection</label><select name="introspectionConfig"><option value="ENABLED">Enabled</option><option value="DISABLED">Disabled</option></select></div><div class="field"><label>Owner contact (optional)</label><input name="ownerContact" maxlength="256"></div><div class="field"><label>Tags (JSON object)</label><textarea name="tags" maxlength="16384">{}</textarea></div><div class="actions"><a class="button" href="#/appsync/apis">Cancel</a><button class="button primary" type="submit">Create API</button></div></form>`;
}

async function createApi(input) {
  return (await appsync("/v1/apis", { method: "POST", body: input })).graphqlApi;
}

function bindCreateApiForm(form) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const api = await createApi({
        name: String(data.get("name")),
        authenticationType: "API_KEY",
        introspectionConfig: String(data.get("introspectionConfig")),
        ownerContact: optionalDescription(data.get("ownerContact")),
        tags: parseObject(data.get("tags"), "Tags"),
      });
      setDirty(false, "all");
      context.toast("GraphQL API created");
      location.hash = apiHref(api.apiId, "overview");
    } catch (error) { context.showError(error); }
  });
}

async function apiListPage() {
  context.setChrome("appsync", ["AppSync", "APIs"]);
  const apis = await listApis();
  const rows = apis.map(api => `<tr data-search-row="${escapeHtml(`${api.name} ${api.apiId} ${api.arn}`.toLowerCase())}"><td><a href="${apiHref(api.apiId, "overview")}">${escapeHtml(api.name)}</a></td><td class="mono">${escapeHtml(api.apiId)}</td><td><span class="status">API key</span></td><td>${escapeHtml(api.introspectionConfig === "DISABLED" ? "Disabled" : "Enabled")}</td><td class="appsync-endpoint">${escapeHtml(api.uris?.GRAPHQL ?? "–")}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width appsync-page">${pageHeader("GraphQL APIs", `API-key GraphQL APIs in ${escapeHtml(session.region)}.`, '<button class="button refresh" data-action="refresh" aria-label="Refresh APIs">↻</button><a class="button primary" href="#/appsync/apis/create">Create API</a>')}${unsupportedBoundary()}<section class="card"><div class="card-header"><h2>APIs <span class="muted">(${apis.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find APIs"></label></div>${rows ? `<div class="table-wrap"><table class="appsync-api-table"><thead><tr><th>Name</th><th>API ID</th><th>Authorization</th><th>Introspection</th><th>GraphQL endpoint</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("A", "No GraphQL APIs", "Create an API-key GraphQL API, add a schema, then connect a VTL unit resolver.", '<a class="button primary" href="#/appsync/apis/create">Create API</a>')}</section></div>`;
  context.bindTableFilter(context.main);
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", context.route);
}

async function apiCreatePage() {
  context.setChrome("appsync", ["AppSync", { label: "APIs", href: "#/appsync/apis" }, "Create API"]);
  context.main.innerHTML = `<div class="page-width appsync-page">${pageHeader("Create GraphQL API", "Create a regional API through the signed AppSync control plane.")}${unsupportedBoundary()}<section class="card"><div class="card-header"><h2>API configuration</h2></div><div class="card-body">${createApiForm()}</div></section></div>`;
  bindCreateApiForm(document.querySelector("#appsync-create-api"));
}

async function overviewPage(api) {
  const [status, dataSources, keys] = await Promise.all([
    schemaStatus(api.apiId),
    collectPages(`/v1/apis/${encoded(api.apiId)}/datasources`, "dataSources"),
    collectPages(`/v1/apis/${encoded(api.apiId)}/apikeys`, "apiKeys"),
  ]);
  setApiChrome(api, "Overview");
  const actions = `<button class="button" data-edit-api>Edit</button><button class="button danger" data-delete-api>Delete</button>`;
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader(api.name, api.arn, actions)}${detailTabs(api.apiId, "overview")}<div class="appsync-summary-grid"><section class="card"><div class="card-header"><h2>API details</h2></div><div class="card-body"><dl class="key-value"><dt>API ID</dt><dd class="mono">${escapeHtml(api.apiId)}</dd><dt>Region</dt><dd>${escapeHtml(session.region)}</dd><dt>Authorization</dt><dd>API key${api.additionalAuthenticationProviders?.some(provider => provider.authenticationType === "AWS_IAM") ? " + IAM" : ""}</dd><dt>Introspection</dt><dd>${escapeHtml(api.introspectionConfig)}</dd><dt>Owner contact</dt><dd>${escapeHtml(api.ownerContact || "–")}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Schema</h2><a href="${apiHref(api.apiId, "schema")}">Open editor</a></div><div class="card-body"><div class="metric">${escapeHtml(status.status)}</div><p class="muted">${escapeHtml(status.details || "Latest schema creation status")}</p></div></section><section class="card"><div class="card-header"><h2>Resources</h2></div><div class="card-body"><dl class="key-value"><dt>Data sources</dt><dd>${dataSources.length}</dd><dt>API keys</dt><dd>${keys.length}</dd></dl><a href="${apiHref(api.apiId, "resolvers")}">View resolvers</a></div></section></div><section class="card"><div class="card-header"><h2>Endpoints</h2></div><div class="card-body"><dl class="key-value"><dt>GraphQL</dt><dd class="mono appsync-wrap">${escapeHtml(api.uris?.GRAPHQL)}</dd><dt>Realtime</dt><dd><span class="status">Available</span><div class="mono appsync-wrap">${escapeHtml(api.uris?.REALTIME)}</div><div class="muted small">Process-local AppSync pure-WebSocket subscriptions; no replay or durable outbox.</div></dd></dl></div></section>${unsupportedBoundary()}</div>`;
  document.querySelector("[data-edit-api]").addEventListener("click", () => context.showModal("Edit API", `<div class="field"><label>API name</label><input name="name" required maxlength="65536" value="${escapeHtml(api.name)}"></div><div class="field"><label>Authorization mode</label><input value="API_KEY" disabled></div><div class="field"><label>Introspection</label><select name="introspectionConfig"><option value="ENABLED" ${api.introspectionConfig !== "DISABLED" ? "selected" : ""}>Enabled</option><option value="DISABLED" ${api.introspectionConfig === "DISABLED" ? "selected" : ""}>Disabled</option></select></div><div class="field"><label>Owner contact (optional)</label><input name="ownerContact" maxlength="256" value="${escapeHtml(api.ownerContact ?? "")}"></div>`, "Save changes", async data => {
    await appsync(`/v1/apis/${encoded(api.apiId)}`, { method: "POST", body: { name: String(data.get("name")), authenticationType: "API_KEY", introspectionConfig: String(data.get("introspectionConfig")), ownerContact: optionalDescription(data.get("ownerContact")) } });
    context.toast("API updated");
  }));
  document.querySelector("[data-delete-api]").addEventListener("click", () => context.confirmDeletion(api.name, `Delete ${api.name} and its schema, resolvers, data sources, and API keys? This immediately disables its GraphQL endpoint.`, async () => {
    await appsync(`/v1/apis/${encoded(api.apiId)}`, { method: "DELETE" });
    schemaDrafts.delete(api.apiId);
    recentDiagnostics.delete(api.apiId);
    context.toast("GraphQL API deleted");
    location.hash = "#/appsync/apis";
  }));
}

function statusMarkup(status) {
  const cls = status.status === "FAILED" ? "error" : status.status === "PROCESSING" ? "pending" : status.status === "SUCCESS" ? "" : "inactive";
  return `<span class="status ${cls}">${escapeHtml(status.status)}</span>${status.details ? `<div class="muted small appsync-wrap">${escapeHtml(status.details)}</div>` : ""}`;
}

async function schemaPage(api) {
  const status = await schemaStatus(api.apiId);
  const sdl = await editableSchema(api.apiId, status);
  setApiChrome(api, "Schema");
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("Schema", `Edit and activate bounded GraphQL SDL for ${escapeHtml(api.name)}.`, '<button class="button" data-introspect>View introspection</button>')}${detailTabs(api.apiId, "schema")}<div class="alert info"><strong>Authoritative validation</strong><br>The local check catches obvious editor mistakes. StartSchemaCreation performs the authoritative syntax, semantic, resolver-coordinate, authorization-directive, subscription, and size validation. A failed generation preserves the previous active schema.</div><section class="card"><div class="card-header"><div><h2>Schema definition</h2><p class="muted small">Maximum 1 MiB UTF-8.</p></div><div data-schema-status aria-live="polite">${statusMarkup(status)}</div></div><div class="card-body"><form id="appsync-schema-form"><div class="field"><label>GraphQL schema</label><textarea name="definition" class="code-editor appsync-schema-editor" maxlength="${1024 * 1024}" spellcheck="false">${escapeHtml(sdl)}</textarea></div><div class="appsync-editor-actions"><button class="button" type="button" data-validate-schema>Validate locally</button><button class="button primary" type="submit">Save schema</button></div><div class="appsync-validation" role="status" aria-live="polite"></div></form></div></section></div>`;
  const form = document.querySelector("#appsync-schema-form");
  const editor = form.elements.definition;
  const validateLocal = () => {
    const text = editor.value.trim();
    let message = "Local check passed. The service remains authoritative.";
    if (!text) message = "Enter a schema definition.";
    else if (!/\btype\s+Query\b/.test(text) && !/\bschema\s*\{/.test(text)) message = "Define a Query root type or an explicit schema block.";
    else {
      let depth = 0;
      for (const character of text) {
        if (character === "{") depth++;
        if (character === "}") depth--;
        if (depth < 0) break;
      }
      if (depth !== 0) message = "The schema has unbalanced braces.";
    }
    form.querySelector(".appsync-validation").textContent = message;
    return message.startsWith("Local check passed");
  };
  form.querySelector("[data-validate-schema]").addEventListener("click", validateLocal);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const definition = editor.value;
    if (!definition.trim()) return form.querySelector(".appsync-validation").textContent = "Enter a schema definition.";
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const started = await appsync(`/v1/apis/${encoded(api.apiId)}/schemacreation`, { method: "POST", body: { definition: encodeDefinition(definition) } });
      document.querySelector("[data-schema-status]").innerHTML = statusMarkup(started);
      const completed = await schemaStatus(api.apiId);
      document.querySelector("[data-schema-status]").innerHTML = statusMarkup(completed);
      if (completed.status === "SUCCESS") {
        schemaDrafts.set(api.apiId, definition);
        setDirty(false, "page");
        context.toast("Schema activated");
      } else {
        form.querySelector(".appsync-validation").textContent = completed.details || "Schema creation failed.";
        context.toast("Schema validation failed", "error");
      }
    } catch (error) { context.showError(error); }
    finally { submit.disabled = false; }
  });
  document.querySelector("[data-introspect]").addEventListener("click", async () => {
    try {
      const [sdlResult, jsonResult] = await Promise.all([introspection(api.apiId, "SDL"), introspection(api.apiId, "JSON")]);
      context.showModal("Active schema introspection", `<div class="tabs" role="tablist" aria-label="Introspection format"><button type="button" class="tab active" role="tab" aria-selected="true" data-introspection-tab="sdl">SDL</button><button type="button" class="tab" role="tab" aria-selected="false" data-introspection-tab="json">JSON</button></div><div class="field"><label>Introspection output</label><textarea class="code-editor" readonly data-introspection-output>${escapeHtml(bounded(sdlResult, RENDERED_RESULT_LIMIT))}</textarea></div>`, "Close", async () => undefined, true, { refreshAfterSubmit: false });
      const modal = document.querySelector("#modal");
      modal.querySelectorAll("[data-introspection-tab]").forEach(button => button.addEventListener("click", () => {
        modal.querySelectorAll("[data-introspection-tab]").forEach(candidate => {
          const active = candidate === button;
          candidate.classList.toggle("active", active);
          candidate.setAttribute("aria-selected", String(active));
        });
        modal.querySelector("[data-introspection-output]").value = bounded(button.dataset.introspectionTab === "json" ? jsonResult : sdlResult, RENDERED_RESULT_LIMIT);
      }));
    } catch (error) { context.showError(error); }
  });
}

async function listRoles() {
  const result = await awsQuery("iam", "ListRoles", { MaxItems: 1000 });
  return [...(result.xml?.getElementsByTagName("member") ?? [])].map(node => {
    const roleName = node.getElementsByTagName("RoleName")[0]?.textContent;
    const arn = node.getElementsByTagName("Arn")[0]?.textContent;
    return roleName && arn ? { roleName, arn } : undefined;
  }).filter(Boolean).filter(role => role.arn.startsWith(`arn:aws:iam::${session.summary?.accountId ?? "000000000000"}:role/`));
}

async function tableNames() {
  const values = [];
  let ExclusiveStartTableName;
  do {
    const page = await dynamo("ListTables", { Limit: 100, ...(ExclusiveStartTableName ? { ExclusiveStartTableName } : {}) });
    values.push(...(page.TableNames ?? []));
    ExclusiveStartTableName = page.LastEvaluatedTableName;
  } while (ExclusiveStartTableName);
  return values;
}

function dataSourceForm(dataSource, tables, roles) {
  const type = dataSource?.type ?? "NONE";
  return `<div class="field"><label>Name</label><input name="name" required pattern="[_A-Za-z][_0-9A-Za-z]*" maxlength="64" value="${escapeHtml(dataSource?.name ?? "")}" ${dataSource ? "disabled" : ""}></div><div class="field"><label>Description</label><input name="description" maxlength="255" value="${escapeHtml(dataSource?.description ?? "")}"></div><div class="field"><label>Type</label><select name="type"><option value="NONE" ${type === "NONE" ? "selected" : ""}>NONE</option><option value="AMAZON_DYNAMODB" ${type === "AMAZON_DYNAMODB" ? "selected" : ""}>DynamoDB</option></select></div><div data-dynamodb-fields ${type === "AMAZON_DYNAMODB" ? "" : "hidden"}><div class="field"><label>DynamoDB table</label><select name="tableName"><option value="">Select a same-Region table</option>${tables.map(name => `<option value="${escapeHtml(name)}" ${dataSource?.dynamodbConfig?.tableName === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select><span class="hint">Only real tables from account ${escapeHtml(session.summary?.accountId ?? "")} in ${escapeHtml(session.region)} are offered.</span></div><div class="field"><label>Service role</label><select name="serviceRoleArn"><option value="">Select a same-account IAM role</option>${roles.map(role => `<option value="${escapeHtml(role.arn)}" ${dataSource?.serviceRoleArn === role.arn ? "selected" : ""}>${escapeHtml(role.roleName)}</option>`).join("")}</select></div><div class="alert warning"><strong>Trust and pass role</strong><br>The role must trust <span class="mono">appsync.amazonaws.com</span>. Your active console identity also needs <span class="mono">iam:PassRole</span> for this role with <span class="mono">iam:PassedToService=appsync.amazonaws.com</span>. AppSync assumes fresh temporary credentials for every resolver invocation; credentials are never shown or stored here.</div></div>`;
}

function bindDataSourceType(root) {
  const type = root.querySelector('[name="type"]');
  const fields = root.querySelector("[data-dynamodb-fields]");
  const update = () => {
    fields.hidden = type.value !== "AMAZON_DYNAMODB";
    fields.querySelectorAll("select").forEach(select => { select.required = !fields.hidden; });
  };
  type.addEventListener("change", update);
  update();
}

function dataSourceInput(data, currentName) {
  const type = String(data.get("type"));
  const result = {
    ...(currentName ? {} : { name: String(data.get("name")) }),
    type,
    description: optionalDescription(data.get("description")),
  };
  if (type === "AMAZON_DYNAMODB") {
    result.serviceRoleArn = String(data.get("serviceRoleArn"));
    result.dynamodbConfig = { tableName: String(data.get("tableName")), awsRegion: session.region };
  }
  return result;
}

async function dataSourcesPage(api) {
  const [dataSources, tables, roles] = await Promise.all([
    collectPages(`/v1/apis/${encoded(api.apiId)}/datasources`, "dataSources"),
    tableNames(),
    listRoles(),
  ]);
  setApiChrome(api, "Data sources");
  const rows = dataSources.map((source, index) => `<tr data-search-row="${escapeHtml(`${source.name} ${source.type} ${source.dynamodbConfig?.tableName ?? ""}`.toLowerCase())}"><td><a href="${apiHref(api.apiId, `data-sources/${encoded(source.name)}`)}">${escapeHtml(source.name)}</a></td><td>${escapeHtml(source.type)}</td><td>${source.dynamodbConfig ? `<a href="#/dynamodb/tables/${encoded(source.dynamodbConfig.tableName)}/overview">${escapeHtml(source.dynamodbConfig.tableName)}</a>` : "–"}</td><td>${source.serviceRoleArn ? `<a href="#/iam/roles/${encoded(source.serviceRoleArn.split("/").at(-1))}/trust">${escapeHtml(source.serviceRoleArn.split("/").at(-1))}</a>` : "–"}</td><td>${escapeHtml(source.description || "–")}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("Data sources", `Authoritative AppSync bindings for ${escapeHtml(api.name)}.`, '<button class="button primary" data-create-data-source>Create data source</button>')}${detailTabs(api.apiId, "data-sources")}<section class="card"><div class="card-header"><h2>Data sources <span class="muted">(${dataSources.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find data sources"></label></div>${rows ? `<div class="table-wrap"><table class="appsync-resource-table"><thead><tr><th>Name</th><th>Type</th><th>Table</th><th>IAM role</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("D", "No data sources", "Create a NONE source for local payloads or bind a real same-Region DynamoDB table.", '<button class="button primary" data-create-data-source>Create data source</button>')}</section>${unsupportedBoundary()}</div>`;
  context.bindTableFilter(context.main);
  document.querySelectorAll("[data-create-data-source]").forEach(button => button.addEventListener("click", () => {
    context.showModal("Create data source", dataSourceForm(undefined, tables, roles), "Create data source", async data => {
      await appsync(`/v1/apis/${encoded(api.apiId)}/datasources`, { method: "POST", body: dataSourceInput(data) });
      context.toast("Data source created");
    }, true);
    bindDataSourceType(document.querySelector("#modal"));
  }));
}

async function dataSourceDetailPage(api, name) {
  const [source, tables, roles] = await Promise.all([
    appsync(`/v1/apis/${encoded(api.apiId)}/datasources/${encoded(name)}`).then(result => result.dataSource),
    tableNames(),
    listRoles(),
  ]);
  setApiChrome(api, "Data source");
  const related = source.type === "AMAZON_DYNAMODB" ? `<section class="card"><div class="card-header"><h2>Related resources</h2></div><div class="card-body appsync-related-grid"><a class="button" href="#/dynamodb/tables/${encoded(source.dynamodbConfig.tableName)}/overview">Open DynamoDB table · ${escapeHtml(source.dynamodbConfig.tableName)}</a><a class="button" href="#/iam/roles/${encoded(source.serviceRoleArn.split("/").at(-1))}/trust">Open IAM role · ${escapeHtml(source.serviceRoleArn.split("/").at(-1))}</a></div></section>` : "";
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader(source.name, source.dataSourceArn, '<a class="button" href="' + apiHref(api.apiId, "data-sources") + '">Back</a><button class="button" data-edit-data-source>Edit</button><button class="button danger" data-delete-data-source>Delete</button>')}${detailTabs(api.apiId, "data-sources")}<section class="card"><div class="card-header"><h2>Configuration</h2></div><div class="card-body"><dl class="key-value"><dt>Type</dt><dd>${escapeHtml(source.type)}</dd><dt>Description</dt><dd>${escapeHtml(source.description || "–")}</dd><dt>Table</dt><dd>${escapeHtml(source.dynamodbConfig?.tableName || "–")}</dd><dt>Region</dt><dd>${escapeHtml(source.dynamodbConfig?.awsRegion || "–")}</dd><dt>Service role</dt><dd class="mono appsync-wrap">${escapeHtml(source.serviceRoleArn || "–")}</dd><dt>Credentials</dt><dd>Never exposed; assumed per invocation</dd></dl></div></section>${related}</div>`;
  document.querySelector("[data-edit-data-source]").addEventListener("click", () => {
    context.showModal("Edit data source", dataSourceForm(source, tables, roles), "Save data source", async data => {
      await appsync(`/v1/apis/${encoded(api.apiId)}/datasources/${encoded(name)}`, { method: "POST", body: dataSourceInput(data, name) });
      context.toast("Data source updated");
    }, true);
    bindDataSourceType(document.querySelector("#modal"));
  });
  document.querySelector("[data-delete-data-source]").addEventListener("click", () => context.confirmDeletion(source.name, `Delete data source ${source.name}? Remove resolver bindings first.`, async () => {
    await appsync(`/v1/apis/${encoded(api.apiId)}/datasources/${encoded(name)}`, { method: "DELETE" });
    context.toast("Data source deleted");
    location.hash = apiHref(api.apiId, "data-sources");
  }));
}

async function resolverCatalog(api, sdl) {
  const types = [...new Set(schemaCoordinates(sdl).map(item => item.typeName))];
  const pages = await Promise.all(types.map(typeName => collectPages(`/v1/apis/${encoded(api.apiId)}/types/${encoded(typeName)}/resolvers`, "resolvers").catch(() => [])));
  return pages.flat();
}

function resolverOperation(resolver) {
  const match = String(resolver.requestMappingTemplate ?? "").match(/["']operation["']\s*:\s*["']([A-Za-z]+)["']/);
  return match?.[1] ?? (resolver.dataSourceType === "NONE" ? "Local payload" : "Mapping-defined");
}

function resolverForm(resolver, coordinates, dataSources) {
  const selected = resolver ? `${resolver.typeName}.${resolver.fieldName}` : "";
  const noneTemplate = '{"version":"2018-05-29","payload":$util.toJson($ctx.arguments)}';
  return `<div class="field"><label>Schema field</label><select name="coordinate" ${resolver ? "disabled" : ""} required><option value="">Select a schema field</option>${coordinates.map(item => { const value = `${item.typeName}.${item.fieldName}`; return `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(value)}</option>`; }).join("")}</select></div><div class="field"><label>Resolver kind</label><input value="UNIT" disabled></div><div class="field"><label>Runtime</label><input value="VTL" disabled></div><div class="field"><label>Data source</label><select name="dataSourceName" required>${dataSources.map(source => `<option value="${escapeHtml(source.name)}" ${resolver?.dataSourceName === source.name ? "selected" : ""}>${escapeHtml(source.name)} · ${escapeHtml(source.type)}</option>`).join("")}</select></div><div class="field"><label>Request mapping template</label><textarea name="requestMappingTemplate" class="code-editor appsync-template-editor" maxlength="${64 * 1024}" spellcheck="false">${escapeHtml(resolver?.requestMappingTemplate ?? noneTemplate)}</textarea></div><div class="field"><label>Response mapping template</label><textarea name="responseMappingTemplate" class="code-editor appsync-template-editor" maxlength="${64 * 1024}" spellcheck="false">${escapeHtml(resolver?.responseMappingTemplate ?? "$util.toJson($ctx.result)")}</textarea></div><div class="alert info"><strong>VTL UNIT only</strong><br>Both templates are validated by the same bounded runtime used for execution. Pipeline configuration, functions, APPSYNC_JS, caching, and metrics configuration are unavailable.</div>`;
}

function resolverInput(data, resolver) {
  const coordinate = resolver ? `${resolver.typeName}.${resolver.fieldName}` : String(data.get("coordinate"));
  const separator = coordinate.indexOf(".");
  if (separator < 1) throw new Error("Select a schema field.");
  return {
    typeName: coordinate.slice(0, separator),
    fieldName: coordinate.slice(separator + 1),
    body: {
      ...(resolver ? {} : { fieldName: coordinate.slice(separator + 1) }),
      kind: "UNIT",
      dataSourceName: String(data.get("dataSourceName")),
      requestMappingTemplate: String(data.get("requestMappingTemplate")),
      responseMappingTemplate: String(data.get("responseMappingTemplate")),
    },
  };
}

async function resolversPage(api) {
  const status = await schemaStatus(api.apiId);
  const sdl = await editableSchema(api.apiId, status);
  const coordinates = schemaCoordinates(sdl);
  const [dataSources, resolvers] = await Promise.all([
    collectPages(`/v1/apis/${encoded(api.apiId)}/datasources`, "dataSources"),
    resolverCatalog(api, sdl),
  ]);
  const sourcesByName = Object.fromEntries(dataSources.map(source => [source.name, source]));
  setApiChrome(api, "Resolvers");
  const rows = resolvers.map(resolver => {
    resolver.dataSourceType = sourcesByName[resolver.dataSourceName]?.type;
    return `<tr data-search-row="${escapeHtml(`${resolver.typeName} ${resolver.fieldName} ${resolver.dataSourceName}`.toLowerCase())}"><td><a href="${apiHref(api.apiId, `resolvers/${encoded(resolver.typeName)}/${encoded(resolver.fieldName)}`)}">${escapeHtml(resolver.typeName)}.${escapeHtml(resolver.fieldName)}</a></td><td>UNIT</td><td>VTL</td><td>${escapeHtml(resolverOperation(resolver))}</td><td>${escapeHtml(resolver.dataSourceName)}</td><td>${escapeHtml(resolver.dataSourceType || "Unknown")}</td></tr>`;
  }).join("");
  const disabled = !coordinates.length || !dataSources.length;
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("Resolvers", `VTL UNIT resolvers bound to the active schema for ${escapeHtml(api.name)}.`, `<button class="button primary" data-create-resolver ${disabled ? "disabled" : ""}>Create resolver</button>`)}${detailTabs(api.apiId, "resolvers")}${disabled ? '<div class="alert warning"><strong>Schema and data source required</strong><br>Activate a schema and create a data source before adding a resolver.</div>' : ""}<section class="card"><div class="card-header"><h2>Resolvers <span class="muted">(${resolvers.length})</span></h2></div><div class="toolbar"><label class="filter"><span>⌕</span><input data-filter-table placeholder="Find resolvers"></label></div>${rows ? `<div class="table-wrap"><table class="appsync-resource-table"><thead><tr><th>Field</th><th>Kind</th><th>Runtime</th><th>Operation</th><th>Data source</th><th>Source type</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("R", "No resolvers", "Create a VTL UNIT resolver for a field in the active schema.", disabled ? "" : '<button class="button primary" data-create-resolver>Create resolver</button>')}</section></div>`;
  context.bindTableFilter(context.main);
  document.querySelectorAll("[data-create-resolver]:not([disabled])").forEach(button => button.addEventListener("click", () => context.showModal("Create resolver", resolverForm(undefined, coordinates, dataSources), "Create resolver", async data => {
    const input = resolverInput(data);
    await appsync(`/v1/apis/${encoded(api.apiId)}/types/${encoded(input.typeName)}/resolvers`, { method: "POST", body: input.body });
    context.toast("Resolver created");
  }, true)));
}

async function resolverDetailPage(api, typeName, fieldName) {
  const [resolver, dataSources] = await Promise.all([
    appsync(`/v1/apis/${encoded(api.apiId)}/types/${encoded(typeName)}/resolvers/${encoded(fieldName)}`).then(result => result.resolver),
    collectPages(`/v1/apis/${encoded(api.apiId)}/datasources`, "dataSources"),
  ]);
  const source = dataSources.find(item => item.name === resolver.dataSourceName);
  resolver.dataSourceType = source?.type;
  setApiChrome(api, "Resolver");
  const sourceLink = source ? apiHref(api.apiId, `data-sources/${encoded(source.name)}`) : apiHref(api.apiId, "data-sources");
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader(`${typeName}.${fieldName}`, resolver.resolverArn, '<a class="button" href="' + apiHref(api.apiId, "resolvers") + '">Back</a><button class="button" data-edit-resolver>Edit</button><button class="button danger" data-delete-resolver>Delete</button>')}${detailTabs(api.apiId, "resolvers")}<div class="appsync-summary-grid"><section class="card"><div class="card-header"><h2>Execution</h2></div><div class="card-body"><dl class="key-value"><dt>Runtime</dt><dd>VTL</dd><dt>Kind</dt><dd>UNIT</dd><dt>Operation</dt><dd>${escapeHtml(resolverOperation(resolver))}</dd><dt>Data source</dt><dd><a href="${sourceLink}">${escapeHtml(resolver.dataSourceName)}</a></dd><dt>Source type</dt><dd>${escapeHtml(source?.type || "Missing")}</dd></dl></div></section><section class="card"><div class="card-header"><h2>Safe diagnostics</h2></div><div class="card-body"><p>Execution metrics use field and API dimensions. Recent browser diagnostics show only time, duration, status, error type, and path.</p><p class="muted">Templates, API keys, authorization headers, credentials, variables, and application results are excluded.</p><a href="${apiHref(api.apiId, "monitoring")}">Open monitoring</a></div></section></div><section class="card"><div class="card-header"><h2>Request mapping template</h2></div><pre class="code-box appsync-template-preview">${escapeHtml(resolver.requestMappingTemplate)}</pre></section><section class="card"><div class="card-header"><h2>Response mapping template</h2></div><pre class="code-box appsync-template-preview">${escapeHtml(resolver.responseMappingTemplate)}</pre></section></div>`;
  document.querySelector("[data-edit-resolver]").addEventListener("click", () => context.showModal("Edit resolver", resolverForm(resolver, [{ typeName, fieldName }], dataSources), "Save resolver", async data => {
    const input = resolverInput(data, resolver);
    await appsync(`/v1/apis/${encoded(api.apiId)}/types/${encoded(typeName)}/resolvers/${encoded(fieldName)}`, { method: "POST", body: input.body });
    context.toast("Resolver updated");
  }, true));
  document.querySelector("[data-delete-resolver]").addEventListener("click", () => context.confirmDeletion(`${typeName}.${fieldName}`, `Delete the resolver for ${typeName}.${fieldName}? The schema field remains but root execution will fail until another resolver is created.`, async () => {
    await appsync(`/v1/apis/${encoded(api.apiId)}/types/${encoded(typeName)}/resolvers/${encoded(fieldName)}`, { method: "DELETE" });
    context.toast("Resolver deleted");
    location.hash = apiHref(api.apiId, "resolvers");
  }));
}

function showCreatedKey(api, key) {
  setTimeout(() => {
    let plaintext = key.id;
    let clearCreatedKey = () => { plaintext = ""; };
    context.showModal("Save the API key", `<div class="alert warning"><strong>Ephemeral credential</strong><br>The key is masked by default and exists only in this dialog memory. It is never placed in a URL, browser storage, history, diagnostics, or copied automatically.</div><div class="field"><label>API key</label><input name="createdKey" type="password" readonly autocomplete="off" value="${escapeHtml(plaintext)}"></div><div class="actions"><button class="button" type="button" data-reveal-created-key>Reveal</button><button class="button" type="button" data-copy-created-key>Copy explicitly</button></div>`, "I saved it", async () => {
      clearCreatedKey();
      setTimeout(() => context.route(), 0);
    }, false, { refreshAfterSubmit: false });
    const modal = document.querySelector("#modal");
    clearCreatedKey = () => {
      plaintext = "";
      const input = modal.querySelector('[name="createdKey"]');
      if (input) input.value = "";
      window.removeEventListener("hashchange", clearCreatedKey);
    };
    window.addEventListener("hashchange", clearCreatedKey, { once: true });
    modal.querySelector("[data-reveal-created-key]").addEventListener("click", event => {
      const input = modal.querySelector('[name="createdKey"]');
      input.type = input.type === "password" ? "text" : "password";
      event.currentTarget.textContent = input.type === "password" ? "Reveal" : "Mask";
    });
    modal.querySelector("[data-copy-created-key]").addEventListener("click", async () => {
      if (!plaintext || !confirm("Copy this API key to the operating-system clipboard?")) return;
      await navigator.clipboard.writeText(plaintext);
      context.toast("API key copied explicitly");
    });
    modal.querySelectorAll("[data-modal-close]").forEach(button => button.addEventListener("click", clearCreatedKey, { once: true }));
    modal.addEventListener("cancel", clearCreatedKey, { once: true });
  }, 0);
}

async function apiKeysPage(api) {
  const keys = await collectPages(`/v1/apis/${encoded(api.apiId)}/apikeys`, "apiKeys");
  setApiChrome(api, "API keys");
  const rows = keys.map((key, index) => `<tr><td>${escapeHtml(key.description || `API key ${index + 1}`)}</td><td><span class="mono" data-key-mask="${index}">${maskedKey}</span></td><td>${formatDate(key.expires)}</td><td>${formatDate(key.deletes)}</td><td class="no-wrap"><button class="button link" data-reveal-key="${index}">Reveal</button><button class="button link" data-edit-key="${index}">Edit</button><button class="button link" data-delete-key="${index}">Delete</button></td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("API keys", `Developer credentials for ${escapeHtml(api.name)}.`, '<button class="button primary" data-create-key>Create API key</button>')}${detailTabs(api.apiId, "api-keys")}<div class="alert warning"><strong>Credential handling</strong><br>Keys are masked by default. Reveal and GraphQL use are explicit, remain in the current page memory, and clear when you leave or refresh. The console never writes a key to the browser address, links, localStorage, sessionStorage, history, ordinary diagnostics, or automatic clipboard state. The provider-modeled update/delete route necessarily carries its key identifier only for that explicit no-store, no-referrer control request.</div><section class="card"><div class="card-header"><h2>API keys <span class="muted">(${keys.length})</span></h2></div>${rows ? `<div class="table-wrap"><table class="appsync-key-table"><thead><tr><th>Description</th><th>Key</th><th>Expires</th><th>Deletes</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("K", "No API keys", "Create a key before executing a GraphQL operation.", '<button class="button primary" data-create-key>Create API key</button>')}</section><p><a href="${apiHref(api.apiId, "queries")}">Open query editor</a> and explicitly select a key there.</p></div>`;
  document.querySelectorAll("[data-create-key]").forEach(button => button.addEventListener("click", () => context.showModal("Create API key", '<div class="field"><label>Description</label><input name="description" maxlength="255" placeholder="Local query editor"></div><div class="field"><label>Lifetime</label><select name="days"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option></select></div>', "Create key", async data => {
    const expires = Math.floor((Date.now() + Number(data.get("days")) * 86_400_000) / 1000);
    const key = (await appsync(`/v1/apis/${encoded(api.apiId)}/apikeys`, { method: "POST", body: { description: optionalDescription(data.get("description")), expires } })).apiKey;
    context.toast("API key created");
    showCreatedKey(api, key);
  }, false, { refreshAfterSubmit: false })));
  document.querySelectorAll("[data-reveal-key]").forEach(button => button.addEventListener("click", () => {
    const index = Number(button.dataset.revealKey);
    const target = document.querySelector(`[data-key-mask="${index}"]`);
    const revealing = target.textContent === maskedKey;
    target.textContent = revealing ? keys[index].id : maskedKey;
    button.textContent = revealing ? "Mask" : "Reveal";
  }));
  document.querySelectorAll("[data-edit-key]").forEach(button => button.addEventListener("click", () => {
    const key = keys[Number(button.dataset.editKey)];
    const days = Math.max(1, Math.ceil((key.expires * 1000 - Date.now()) / 86_400_000));
    context.showModal("Edit API key", `<div class="field"><label>Description</label><input name="description" maxlength="255" value="${escapeHtml(key.description ?? "")}"></div><div class="field"><label>Lifetime from now (days)</label><input name="days" type="number" min="1" max="365" value="${days}" required></div>`, "Save key", async data => {
      await appsync(`/v1/apis/${encoded(api.apiId)}/apikeys/${encoded(key.id)}`, { method: "POST", body: { description: String(data.get("description")), expires: Math.floor((Date.now() + Number(data.get("days")) * 86_400_000) / 1000) } });
      context.toast("API key updated");
    });
  }));
  document.querySelectorAll("[data-delete-key]").forEach(button => button.addEventListener("click", () => {
    const index = Number(button.dataset.deleteKey);
    const key = keys[index];
    const label = key.description || `API key ${index + 1}`;
    context.confirmDeletion(label, "The key will stop authorizing GraphQL requests immediately. Its value is not shown in this confirmation.", async () => {
      await appsync(`/v1/apis/${encoded(api.apiId)}/apikeys/${encoded(key.id)}`, { method: "DELETE" });
      context.toast("API key deleted");
    });
  }));
}

const examples = {
  custom: { label: "Custom", query: "query MyQuery {\n  __typename\n}", operationName: "MyQuery", variables: {} },
  get: { label: "DynamoDB get", query: "query GetItem($id: ID!) {\n  getItem(id: $id) {\n    id\n  }\n}", operationName: "GetItem", variables: { id: "example" } },
  create: { label: "DynamoDB create", query: "mutation CreateItem($input: ItemInput!) {\n  createItem(input: $input) {\n    id\n  }\n}", operationName: "CreateItem", variables: { input: { id: "example" } } },
  update: { label: "DynamoDB update", query: "mutation UpdateItem($id: ID!, $input: ItemInput!) {\n  updateItem(id: $id, input: $input) {\n    id\n  }\n}", operationName: "UpdateItem", variables: { id: "example", input: {} } },
  delete: { label: "DynamoDB delete", query: "mutation DeleteItem($id: ID!) {\n  deleteItem(id: $id) {\n    id\n  }\n}", operationName: "DeleteItem", variables: { id: "example" } },
  query: { label: "DynamoDB query", query: "query QueryItems($partition: String!, $nextToken: String) {\n  queryItems(partition: $partition, nextToken: $nextToken) {\n    items { id }\n    nextToken\n  }\n}", operationName: "QueryItems", variables: { partition: "example", nextToken: null } },
  scan: { label: "DynamoDB scan", query: "query ScanItems($nextToken: String) {\n  scanItems(nextToken: $nextToken) {\n    items { id }\n    nextToken\n  }\n}", operationName: "ScanItems", variables: { nextToken: null } },
  subscription: { label: "Realtime subscription", query: "subscription OnCreateTodo($filter: ModelSubscriptionTodoFilterInput) {\n  onCreateTodo(filter: $filter) {\n    id\n    title\n    updatedAt\n  }\n}", operationName: "OnCreateTodo", variables: { filter: {} } },
};

function addDiagnostic(apiId, item) {
  const current = recentDiagnostics.get(apiId) ?? [];
  current.unshift(item);
  recentDiagnostics.set(apiId, current.slice(0, 20));
}

async function executeGraphql(api, key, payload) {
  const started = performance.now();
  const response = await fetch(api.uris.GRAPHQL, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(payload),
  });
  let result;
  try { result = await response.json(); }
  catch { result = { errors: [{ message: "The GraphQL endpoint returned an unreadable response.", errorType: "MalformedResponse" }] }; }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const errors = (result.errors ?? []).slice(0, 20).map(error => ({
    errorType: String(error.errorType ?? error.extensions?.errorType ?? "GraphQLError").slice(0, 80),
    path: Array.isArray(error.path) ? error.path.slice(0, 20).map(value => String(value).slice(0, 80)) : [],
  }));
  addDiagnostic(api.apiId, { at: Date.now(), durationMs, status: response.ok && !errors.length ? "SUCCEEDED" : "FAILED", statusCode: response.status, errors });
  return { response, result, durationMs };
}

function realtimeAuthorization(api, key) {
  return {
    host: new URL(api.uris.GRAPHQL).host,
    "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    "x-api-key": key,
  };
}

function base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function startRealtimeSubscription(api, key, payload, onData, onComplete) {
  const id = crypto.randomUUID();
  const protocolHeader = base64Url(JSON.stringify(realtimeAuthorization(api, key)));
  const socket = new WebSocket(api.uris.REALTIME, ["graphql-ws", `header-${protocolHeader}`]);
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The realtime subscription acknowledgment timed out.")), 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
    socket.onerror = () => { if (!settled) reject(new Error("The realtime endpoint could not be reached.")); };
    socket.onclose = event => {
      if (!settled) reject(new Error(`The realtime endpoint closed before registration (${event.code}).`));
      onComplete(event.code, event.reason);
    };
    socket.onmessage = event => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.type === "connection_ack") {
        const data = JSON.stringify(payload);
        socket.send(JSON.stringify({ id, type: "start", payload: { data, extensions: { authorization: realtimeAuthorization(api, key) } } }));
      } else if (message.type === "start_ack" && message.id === id) {
        clearTimeout(timeout); settled = true; resolve();
      } else if (message.type === "data" && message.id === id) onData(message.payload);
      else if (message.type === "error" && message.id === id) onData(message.payload ?? { errors: [{ errorType: "RealtimeError", message: "The subscription failed." }] });
      else if (message.type === "complete" && message.id === id) { socket.close(1000, "Subscription stopped"); }
      else if (message.type === "connection_error") { clearTimeout(timeout); reject(new Error("The realtime connection was rejected.")); }
    };
  });
  await ready;
  return {
    stop() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, type: "stop" }));
      setTimeout(() => { if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "Subscription stopped"); }, 250);
    },
  };
}

async function queriesPage(api) {
  const keys = await collectPages(`/v1/apis/${encoded(api.apiId)}/apikeys`, "apiKeys");
  setApiChrome(api, "Queries");
  const initial = examples.custom;
  context.main.innerHTML = `<div class="page-width appsync-detail appsync-query-page">${pageHeader("Queries", `Execute GraphQL over the returned HTTP endpoint for ${escapeHtml(api.name)}.`)}${detailTabs(api.apiId, "queries")}<div class="alert warning"><strong>Explicit ephemeral key selection</strong><br>No key is selected automatically. Selecting a key keeps its plaintext only in this page closure until navigation or refresh. Query text, variables, credentials, and results are not written to browser storage or history.</div><div class="appsync-query-grid"><section class="card"><div class="card-header"><h2>Operation</h2><span class="status inactive" data-selected-key-status>No API key selected</span></div><div class="card-body"><div class="field"><label>API key</label><select data-key-selection><option value="">Choose explicitly</option>${keys.map((key, index) => `<option value="${index}">${escapeHtml(key.description || `API key ${index + 1}`)} · expires ${escapeHtml(formatDate(key.expires))}</option>`).join("")}</select></div><div class="field"><label>Workflow example</label><select data-query-example>${Object.entries(examples).map(([value, item]) => `<option value="${value}">${escapeHtml(item.label)}</option>`).join("")}</select><span class="hint">Examples are editable starting points. The active schema and mapping templates remain authoritative.</span></div><div class="field"><label>GraphQL query</label><textarea data-graphql-query class="code-editor appsync-query-editor" maxlength="${GRAPHQL_EDITOR_LIMIT}" spellcheck="false">${escapeHtml(initial.query)}</textarea></div><div class="field"><label>Operation name (optional)</label><input data-operation-name maxlength="256" value="${escapeHtml(initial.operationName)}"></div><div class="field"><label>Variables (JSON object)</label><textarea data-graphql-variables class="code-editor" maxlength="${GRAPHQL_EDITOR_LIMIT}" spellcheck="false">${escapeHtml(JSON.stringify(initial.variables, null, 2))}</textarea></div><div class="appsync-editor-actions"><button class="button" type="button" data-clear-query>Clear</button><button class="button primary" type="button" data-run-query disabled>Run</button></div></div></section><section class="card"><div class="card-header"><div><h2>Response</h2><p class="muted small" data-query-summary>No operation run.</p></div></div><div class="card-body"><pre class="code-box appsync-query-result" data-query-result aria-live="polite">${escapeHtml(JSON.stringify({ message: "Select an API key and run an operation." }, null, 2))}</pre><p class="hint">Rendering is capped at 256 KiB. Safe GraphQL messages, error types, paths, and extensions are shown; network headers and credentials are not.</p></div></section></div></div>`;
  let selectedKey = "";
  const selection = document.querySelector("[data-key-selection]");
  const run = document.querySelector("[data-run-query]");
  const result = document.querySelector("[data-query-result]");
  let activeSubscription;
  const clearKey = () => { selectedKey = ""; activeSubscription?.stop(); activeSubscription = undefined; };
  window.addEventListener("hashchange", clearKey, { once: true });
  selection.addEventListener("change", () => {
    selectedKey = selection.value === "" ? "" : keys[Number(selection.value)]?.id ?? "";
    run.disabled = !selectedKey;
    const status = document.querySelector("[data-selected-key-status]");
    status.textContent = selectedKey ? "API key selected in memory" : "No API key selected";
    status.classList.toggle("inactive", !selectedKey);
  });
  document.querySelector("[data-query-example]").addEventListener("change", event => {
    const example = examples[event.target.value];
    document.querySelector("[data-graphql-query]").value = example.query;
    document.querySelector("[data-operation-name]").value = example.operationName;
    document.querySelector("[data-graphql-variables]").value = JSON.stringify(example.variables, null, 2);
  });
  document.querySelector("[data-clear-query]").addEventListener("click", () => {
    activeSubscription?.stop(); activeSubscription = undefined; run.textContent = "Run";
    document.querySelector("[data-graphql-query]").value = "";
    document.querySelector("[data-operation-name]").value = "";
    document.querySelector("[data-graphql-variables]").value = "{}";
    result.textContent = JSON.stringify({ message: "Editor cleared." }, null, 2);
  });
  run.addEventListener("click", async () => {
    if (!selectedKey) return context.showError(new Error("Select an API key explicitly."));
    if (activeSubscription) {
      activeSubscription.stop(); activeSubscription = undefined; run.textContent = "Run";
      document.querySelector("[data-query-summary]").textContent = "Subscription stopped; no replay is retained.";
      return;
    }
    const query = document.querySelector("[data-graphql-query]").value;
    const operationName = document.querySelector("[data-operation-name]").value.trim();
    let variables;
    try { variables = parseObject(document.querySelector("[data-graphql-variables]").value, "Variables"); }
    catch (error) { return context.showError(error); }
    if (new TextEncoder().encode(query).length > GRAPHQL_EDITOR_LIMIT || new TextEncoder().encode(JSON.stringify(variables)).length > GRAPHQL_EDITOR_LIMIT) return context.showError(new Error("Query and variables are each limited to 256 KiB."));
    run.disabled = true;
    result.textContent = "Running…";
    try {
      if (/\bsubscription\b/.test(query)) {
        activeSubscription = await startRealtimeSubscription(api, selectedKey, { query, variables, ...(operationName ? { operationName } : {}) }, payload => {
          result.textContent = safeJson(payload);
          const errors = (payload.errors ?? []).slice(0, 20).map(error => ({ errorType: String(error.errorType ?? error.extensions?.errorType ?? "GraphQLError").slice(0, 80), path: Array.isArray(error.path) ? error.path.slice(0, 20).map(String) : [] }));
          addDiagnostic(api.apiId, { at: Date.now(), durationMs: 0, status: errors.length ? "FAILED" : "DELIVERED", statusCode: 101, errors });
          document.querySelector("[data-query-summary]").textContent = errors.length ? `${errors.length} realtime error${errors.length === 1 ? "" : "s"}` : "Realtime event delivered · no payload history retained";
        }, (code, reason) => {
          activeSubscription = undefined; run.textContent = "Run"; run.disabled = !selectedKey;
          document.querySelector("[data-query-summary]").textContent = `Realtime closed (${code})${reason ? ` · ${reason}` : ""}`;
        });
        run.textContent = "Stop";
        result.textContent = safeJson({ message: "Subscription registered. Waiting for a live mutation; missed events are not replayed." });
        document.querySelector("[data-query-summary]").textContent = "Realtime connected";
        addDiagnostic(api.apiId, { at: Date.now(), durationMs: 0, status: "CONNECTED", statusCode: 101, errors: [] });
        return;
      }
      const execution = await executeGraphql(api, selectedKey, { query, variables, ...(operationName ? { operationName } : {}) });
      result.textContent = safeJson(execution.result);
      const errors = execution.result.errors?.length ?? 0;
      document.querySelector("[data-query-summary]").textContent = `${execution.response.status} · ${execution.durationMs} ms · ${errors ? `${errors} GraphQL error${errors === 1 ? "" : "s"}` : "completed"}`;
      setDirty(false, "page");
    } catch (error) {
      result.textContent = safeJson({ errors: [{ message: "The GraphQL endpoint could not be reached.", errorType: "NetworkError" }] });
      addDiagnostic(api.apiId, { at: Date.now(), durationMs: 0, status: "FAILED", statusCode: 0, errors: [{ errorType: "NetworkError", path: [] }] });
      context.showError(error);
    } finally { run.disabled = !selectedKey; }
  });
}

async function monitoringPage(api) {
  const end = new Date();
  const start = new Date(end.getTime() - 3_600_000);
  const metricNames = ["GraphQLRequestCount", "GraphQLErrorCount", "4XXError", "5XXError", "Latency", "ResolverRequestCount", "ResolverErrorCount", "ResolverLatency", "DataSourceLatency", "RealtimeConnectionAdmission", "RealtimeConnectionClose", "RealtimeSubscriptionRegistrationAdmission", "RealtimeSubscriptionRegistrationRejected", "RealtimeSubscriptionStop", "RealtimeMutationCompletion", "RealtimeSubscriptionAuthorizationAdmission", "RealtimeSubscriptionFilterAdmission", "RealtimeSubscriptionFilterRejection", "RealtimeSubscriptionQueueDrop", "RealtimeSocketDelivery", "RealtimeSocketDeliveryFailure"];
  let data = [];
  let realtime = { connections: 0, registrations: 0, signals: [], durability: "process-local-no-replay" };
  try {
    const response = await awsFetch("/_stacksim/api/appsync/realtime", { service: "sts", headers: { "x-stacksim-region": session.region } });
    if (response.ok) realtime = (await response.json()).realtime ?? realtime;
  } catch { /* Private diagnostics are optional and never fabricated. */ }
  try {
    const result = await metrics("GetMetricData", {
      StartTime: start.toISOString(),
      EndTime: end.toISOString(),
      ScanBy: "TimestampAscending",
      MetricDataQueries: metricNames.map((MetricName, index) => ({
        Id: `m${index}`,
        Label: MetricName,
        MetricStat: { Metric: { Namespace: "AWS/AppSync", MetricName, Dimensions: [{ Name: "GraphQLAPIId", Value: api.apiId }] }, Period: 60, Stat: MetricName.includes("Latency") ? "Average" : "Sum" },
      })),
    });
    data = result.MetricDataResults ?? [];
  } catch (error) {
    if (!["AccessDenied", "AccessDeniedException"].includes(error.code)) throw error;
    setApiChrome(api, "Monitoring");
    context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("Monitoring", `Permission-gated AppSync telemetry for ${escapeHtml(api.name)}.`)}${detailTabs(api.apiId, "monitoring")}<div class="alert error" role="alert"><strong>CloudWatch access denied</strong><br>The active console identity cannot read AppSync metrics. No metric or trace data was fabricated.</div></div>`;
    return;
  }
  setApiChrome(api, "Monitoring");
  const summaries = data.map(item => {
    const values = item.Values ?? [];
    const value = item.Label.includes("Latency")
      ? (values.length ? `${(values.reduce((sum, current) => sum + current, 0) / values.length).toFixed(1)} ms` : "No data")
      : values.reduce((sum, current) => sum + current, 0).toLocaleString();
    return `<section class="card"><div class="card-header"><h2>${escapeHtml(item.Label)}</h2></div><div class="card-body"><div class="metric">${escapeHtml(value)}</div><p class="muted">Last 60 minutes · real AppSync samples</p></div></section>`;
  }).join("");
  const diagnostics = recentDiagnostics.get(api.apiId) ?? [];
  const apiRealtime = realtime.byApi?.find(item => item.apiId === api.apiId) ?? { connections: 0, registrations: 0 };
  const realtimeSignals = (realtime.signals ?? []).filter(signal => signal.apiId === api.apiId).slice(-50).reverse();
  const realtimeRows = realtimeSignals.map(signal => `<tr><td>${formatDate(signal.time)}</td><td>${escapeHtml(signal.signal)}</td><td>${escapeHtml(signal.authenticationType ?? "–")}</td><td>${escapeHtml(signal.reason ?? "–")}</td></tr>`).join("");
  const realtimeMarkup = `<section class="card"><div class="card-header"><div><h2>Realtime health</h2><p class="muted small">Private process-local diagnostics · no payload history or replay</p></div><span class="status">${apiRealtime.connections} connection${apiRealtime.connections === 1 ? "" : "s"} · ${apiRealtime.registrations} registration${apiRealtime.registrations === 1 ? "" : "s"}</span></div>${realtimeRows ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Signal</th><th>Authorization</th><th>Reason</th></tr></thead><tbody>${realtimeRows}</tbody></table></div>` : emptyState("◇", "No realtime signals", "Connection, registration, mutation, filter, queue, and socket summaries appear here without documents, variables, payloads, or credentials.")}</section>`;
  const diagnosticRows = diagnostics.map(item => `<tr><td>${formatDate(item.at)}</td><td><span class="status ${item.status === "FAILED" ? "error" : ""}">${escapeHtml(item.status)}</span></td><td>${item.statusCode || "–"}</td><td>${item.durationMs} ms</td><td>${item.errors.length ? item.errors.map(error => `${escapeHtml(error.errorType)}${error.path.length ? ` · ${escapeHtml(error.path.join("."))}` : ""}`).join("<br>") : "–"}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("Monitoring", `Permission-gated AppSync telemetry for ${escapeHtml(api.name)}.`, '<button class="button refresh" data-action="refresh" aria-label="Refresh monitoring">↻</button><a class="button" href="#/cloudwatch/metrics">Open CloudWatch metrics</a>')}${detailTabs(api.apiId, "monitoring")}<div class="appsync-metric-grid">${summaries}</div><section class="card"><div class="card-header"><div><h2>Bounded local diagnostics</h2><p class="muted small">stacksim tooling · current browser page memory · up to 20 executions</p></div></div>${diagnosticRows ? `<div class="table-wrap"><table class="appsync-diagnostic-table"><thead><tr><th>Time</th><th>Status</th><th>HTTP</th><th>Duration</th><th>Error type / path</th></tr></thead><tbody>${diagnosticRows}</tbody></table></div>` : emptyState("◇", "No recent query-editor executions", "Run a query to add a payload-free summary. Queries, variables, keys, headers, templates, credentials, and results are never recorded here.")}</section><section class="card"><div class="card-header"><h2>Field logs</h2><span class="status inactive">Unavailable</span></div><div class="card-body"><p>AppSync field logging is not implemented in this P0 console slice. The console does not invent a log group or traces.</p><p class="muted">X-Ray, unrestricted resolver results, full variables, and authorization headers are not available.</p></div></section></div>`;
  context.main.querySelector(".appsync-metric-grid")?.insertAdjacentHTML("afterend", realtimeMarkup);
  document.querySelector('[data-action="refresh"]').addEventListener("click", context.route);
}

async function tagsPage(api) {
  const tags = (await appsync(`/v1/tags/${encoded(api.arn)}`)).tags ?? {};
  setApiChrome(api, "Tags");
  const rows = Object.entries(tags).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("");
  context.main.innerHTML = `<div class="page-width appsync-detail">${pageHeader("Tags", `Key-value metadata for ${escapeHtml(api.name)}.`, '<button class="button primary" data-manage-tags>Manage tags</button>')}${detailTabs(api.apiId, "tags")}<section class="card"><div class="card-header"><h2>Tags <span class="muted">(${Object.keys(tags).length})</span></h2></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("T", "No tags", "Add up to 50 tags through the AppSync tagging actions.", '<button class="button primary" data-manage-tags>Manage tags</button>')}</section></div>`;
  document.querySelectorAll("[data-manage-tags]").forEach(button => button.addEventListener("click", () => context.showModal("Manage tags", `<div class="field"><label>Tags (JSON object)</label><textarea name="tags" maxlength="16384">${escapeHtml(JSON.stringify(tags, null, 2))}</textarea><span class="hint">Removing a key here untags it. Keys and values must be strings.</span></div>`, "Save tags", async data => {
    const next = parseObject(data.get("tags"), "Tags");
    if (Object.values(next).some(value => typeof value !== "string")) throw new Error("Tag values must be strings.");
    const removed = Object.keys(tags).filter(key => !Object.hasOwn(next, key));
    if (removed.length) await appsync(`/v1/tags/${encoded(api.arn)}`, { method: "DELETE", query: { tagKeys: removed } });
    if (Object.keys(next).length) await appsync(`/v1/tags/${encoded(api.arn)}`, { method: "POST", body: { tags: next } });
    context.toast("Tags updated");
  })));
}

export async function routeAppSync(parts, nextContext) {
  context = nextContext;
  const render = async pending => { const result = await pending; decorateAppSyncPanelHelp(context.main); return result; };
  if (parts.length === 1 || parts.length === 2 && parts[1] === "apis") return render(apiListPage());
  if (parts.length === 3 && parts[1] === "apis" && parts[2] === "create") return render(apiCreatePage());
  if (parts[1] !== "apis" || !parts[2]) return context.notFound(parts);
  const api = await getApi(parts[2]);
  const section = parts[3] ?? "overview";
  if (section === "overview" && parts.length === 4) return render(overviewPage(api));
  if (section === "schema" && parts.length === 4) return render(schemaPage(api));
  if (section === "queries" && parts.length === 4) return render(queriesPage(api));
  if (section === "api-keys" && parts.length === 4) return render(apiKeysPage(api));
  if (section === "monitoring" && parts.length === 4) return render(monitoringPage(api));
  if (section === "tags" && parts.length === 4) return render(tagsPage(api));
  if (section === "data-sources" && parts.length === 4) return render(dataSourcesPage(api));
  if (section === "data-sources" && parts.length === 5) return render(dataSourceDetailPage(api, parts[4]));
  if (section === "resolvers" && parts.length === 4) return render(resolversPage(api));
  if (section === "resolvers" && parts.length === 6) return render(resolverDetailPage(api, parts[4], parts[5]));
  return context.notFound(parts);
}
