import { dynamo } from "../api-client.js";
import { emptyState, escapeHtml } from "../components.js";
import { session, setDirty } from "../state.js";

const historyKey = "stacksim:dynamodb:partiql-history";
const savedKey = "stacksim:dynamodb:partiql-saved";
const parameterTypes = [["S", "String"], ["N", "Number"], ["B", "Binary"], ["BOOL", "Boolean"], ["NULL", "Null"], ["M", "Map"], ["L", "List"], ["SS", "String set"], ["NS", "Number set"], ["BS", "Binary set"]];

function readLocalArray(key) { try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; } }
function writeLocalArray(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }

export async function enhancedDynamoPartiql(context) {
  const { main, setChrome, showError, showModal, toast } = context;
  setChrome("dynamodb", ["DynamoDB", "PartiQL editor"]);
  const tableNames = (await collectTableNames()).sort();
  const tables = await Promise.all(tableNames.map(name => dynamo("DescribeTable", { TableName: name }).then(result => result.Table)));
  const resources = tables.flatMap(table => [
    { table, label: `Table – ${table.TableName}`, index: undefined, kind: "TABLE" },
    ...(table.LocalSecondaryIndexes ?? []).map(index => ({ table, index, label: `LSI – ${table.TableName}.${index.IndexName}`, kind: "LSI" })),
    ...(table.GlobalSecondaryIndexes ?? []).map(index => ({ table, index, label: `GSI – ${table.TableName}.${index.IndexName}`, kind: "GSI" })),
  ]);
  const defaultResource = resources[0];
  let history = readLocalArray(historyKey);
  let saved = readLocalArray(savedKey);

  main.innerHTML = `<div class="page-width">${pageHeaderMarkup()}<div class="partiql-layout"><section class="card partiql-editor"><div class="card-header"><div><h2>Operation</h2><p class="muted small">Run one statement, a homogeneous batch, or an atomic transaction.</p></div><div class="actions"><button class="button" id="partiql-save">Save operation</button><button class="button" id="partiql-code">Generate code</button><button class="button" id="clear-partiql">Clear</button><button class="button primary" id="run-partiql">Run</button></div></div><div class="card-body"><div class="field-row"><div class="field"><label>Execution mode</label><select id="partiql-mode"><option value="single">Single statement</option><option value="batch">Batch statements</option><option value="transaction">Transaction statements</option></select></div><div class="field"><label>Return consumed capacity</label><select id="partiql-capacity"><option value="NONE">None</option><option value="TOTAL" selected>Total</option><option value="INDEXES">Indexes</option></select></div></div><details id="partiql-query-builder" ${resources.length ? "" : "hidden"}><summary>Query table</summary><div class="card-body compact-card-body"><div class="field"><label>Table or index</label><select id="partiql-resource">${resources.map((resource, index) => `<option value="${index}">${escapeHtml(resource.label)}</option>`).join("")}</select></div><div class="field-row"><div class="field"><label id="partiql-builder-pk-label">Partition key value</label><input id="partiql-builder-pk"></div><div class="field"><label id="partiql-builder-pk-type-label">Partition key type</label><select id="partiql-builder-pk-type" disabled>${parameterTypes.slice(0, 3).map(([type, label]) => `<option value="${type}">${label}</option>`).join("")}</select></div></div><div id="partiql-builder-sort" hidden><div class="field-row"><div class="field"><label id="partiql-builder-sort-label">Sort key condition</label><select id="partiql-builder-sort-op"><option value="">Any sort key</option><option value="=">Equals</option><option value="<">Less than</option><option value="<=">Less than or equal</option><option value=">">Greater than</option><option value=">=">Greater than or equal</option><option value="BETWEEN">Between</option><option value="begins_with">Begins with</option></select></div><div class="field"><label>Sort key value</label><input id="partiql-builder-sort-value"><input id="partiql-builder-sort-upper" aria-label="Upper sort key value" placeholder="Upper value for Between" hidden></div></div></div><div class="field"><label>Projection attributes</label><input id="partiql-builder-projection" placeholder="Leave empty for all attributes"></div><button class="button" id="partiql-build-query" type="button">Build efficient query</button></div></details><div id="partiql-single-editor"><div class="field"><label>PartiQL statement</label><textarea id="partiql-statement" class="code-editor" spellcheck="false">${escapeHtml(defaultResource ? `SELECT * FROM ${quoteIdentifier(defaultResource.table.TableName)}` : 'SELECT * FROM "TableName"')}</textarea><span class="hint">contains(path, value) is valid. Double-quote identifiers, use single quotes for literals, and prefer parameters for values.</span></div><div class="alert warning" id="partiql-scan-warning"><strong>Potential full-table scan</strong><br>Add a partition-key equality or use Query table to generate an efficient statement.</div><div class="field"><label>Parameters (DynamoDB JSON)</label><textarea id="partiql-parameters" spellcheck="false">[]</textarea><span class="hint">Ordered AttributeValue array. The typed builder below keeps this JSON synchronized.</span></div><div class="parameter-builder"><div class="toolbar"><strong>Typed parameters</strong><div class="actions"><button class="button" type="button" id="partiql-parse-parameters">Load JSON</button><button class="button" type="button" id="partiql-add-parameter">Add parameter</button></div></div><div id="partiql-parameter-rows"></div></div><div class="partiql-options"><div class="field"><label>Results view</label><select id="partiql-format"><option value="dynamodb">DynamoDB JSON</option><option value="plain">Plain JSON</option><option value="raw">Raw response</option></select></div><div class="field"><label>Page size</label><select id="partiql-limit"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></div><label class="checkbox-label"><input type="checkbox" id="partiql-consistent"> Strongly consistent read</label></div></div><div id="partiql-multi-editor" hidden><div class="field"><label>Statements request (JSON)</label><textarea id="partiql-statements" class="code-editor" style="min-height:320px">${escapeHtml(JSON.stringify([{ Statement: defaultResource ? `SELECT * FROM ${quoteIdentifier(defaultResource.table.TableName)} WHERE ${quoteIdentifier(defaultResource.table.KeySchema.find(key => key.KeyType === "HASH")?.AttributeName ?? "id") }=?` : 'SELECT * FROM "TableName" WHERE "id"=?', Parameters: [{ S: "value" }] }], null, 2))}</textarea><span class="hint">Enter 1–25 batch entries or 1–100 transaction entries. A request cannot mix reads and writes.</span></div></div></div></section><aside class="card partiql-history"><div class="card-header"><h2>Operations</h2><div class="actions"><button class="button link" id="export-partiql-history">Export</button><label class="button link" for="import-partiql-history">Import</label><input id="import-partiql-history" type="file" accept="application/json" hidden></div></div><div class="card-body compact-card-body"><div class="field"><label>Search history and saved operations</label><input id="partiql-history-search" type="search" placeholder="Table, statement, or operation"></div><div class="tabs compact-tabs"><button class="tab active" data-partiql-list="history">History</button><button class="tab" data-partiql-list="saved">Saved</button></div></div><div id="partiql-history-list"></div></aside></div><section class="card" id="partiql-result"><div class="card-header"><h2>Results</h2></div>${emptyState("◇", "No statement run", "Run an operation to view items, capacity, pagination, or error details.")}</section></div>`;

  const multiEditor = document.querySelector("#partiql-multi-editor");
  const initialEntries = JSON.parse(document.querySelector("#partiql-statements").value);
  multiEditor.innerHTML = `<div class="toolbar"><div><strong>Ordered statements</strong><p class="muted small">Each card is one official API statement. Batch requests allow 25; transactions allow 100.</p></div><button class="button" id="partiql-add-statement" type="button">Add statement</button></div><div id="partiql-statement-cards"></div><div class="field" id="partiql-client-token-field" hidden><label>Client request token</label><input id="partiql-client-token" maxlength="36" placeholder="Generated when empty"><span class="hint">Reuse a token to replay the same transaction idempotently for ten minutes.</span></div><details><summary>Official request preview</summary><pre class="code-box" id="partiql-request-preview"></pre></details><div class="field"><label>Statements request (JSON)</label><textarea id="partiql-statements" class="code-editor" style="min-height:180px">${escapeHtml(JSON.stringify(initialEntries, null, 2))}</textarea><span class="hint">Advanced DynamoDB JSON view. Editing this view is applied directly when the request runs.</span></div>`;

  const statement = document.querySelector("#partiql-statement");
  const parameters = document.querySelector("#partiql-parameters");
  const result = document.querySelector("#partiql-result");
  const format = document.querySelector("#partiql-format");
  const mode = document.querySelector("#partiql-mode");
  const state = { output: undefined, error: undefined, tokens: [undefined], page: 0, running: false, list: "history", accessPath: "Scan" };

  const currentPayload = () => mode.value === "single" ? { statement: statement.value.trim(), parameters: parameters.value.trim() || "[]" } : { statements: document.querySelector("#partiql-statements").value.trim() || "[]" };
  function statementCard(entry, index) {
    const select = /^SELECT\b/i.test(entry.Statement ?? ""); const transaction = mode.value === "transaction";
    const restoredParameters = Array.isArray(entry.Parameters) ? entry.Parameters : Array.from({ length: Number(entry.ParameterCount) || 0 }, () => ({ S: "" }));
    return `<article class="card partiql-statement-card" data-partiql-card="${index}"><div class="card-header"><strong>Statement ${index + 1}</strong><div class="actions"><button class="button link" type="button" data-statement-up="${index}" ${index ? "" : "disabled"}>Up</button><button class="button link" type="button" data-statement-down="${index}">Down</button><button class="button link" type="button" data-statement-remove="${index}">Remove</button></div></div><div class="card-body compact-card-body"><div class="field"><label>Statement ${index + 1}</label><textarea class="code-editor" data-card-statement>${escapeHtml(entry.Statement ?? "")}</textarea></div><div class="field"><label>Parameters ${index + 1} (DynamoDB JSON)</label><textarea data-card-parameters>${escapeHtml(JSON.stringify(restoredParameters))}</textarea></div><div class="partiql-options">${!transaction && select ? `<label class="checkbox-label"><input type="checkbox" data-card-consistent ${entry.ConsistentRead ? "checked" : ""}> Strongly consistent read</label>` : ""}${!select ? `<div class="field"><label>Condition failure values</label><select data-card-failure><option value="">None</option><option value="ALL_OLD" ${entry.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? "selected" : ""}>All old attributes</option></select></div>` : ""}</div></div></article>`;
  }
  function readStatementCards() {
    return [...document.querySelectorAll("[data-partiql-card]")].map(card => { const Statement = card.querySelector("[data-card-statement]").value.trim(); const Parameters = JSON.parse(card.querySelector("[data-card-parameters]").value || "[]"); const consistent = card.querySelector("[data-card-consistent]")?.checked; const failure = card.querySelector("[data-card-failure]")?.value; return { Statement, ...(Parameters.length ? { Parameters } : {}), ...(consistent ? { ConsistentRead: true } : {}), ...(failure ? { ReturnValuesOnConditionCheckFailure: failure } : {}) }; });
  }
  function renderStatementCards(entries) {
    const root = document.querySelector("#partiql-statement-cards"); root.innerHTML = entries.map(statementCard).join("");
    root.querySelectorAll("textarea, input, select").forEach(control => control.addEventListener("input", syncStatementCards));
    const move = (index, delta) => { const values = readStatementCards(); const next = index + delta; if (next < 0 || next >= values.length) return; [values[index], values[next]] = [values[next], values[index]]; renderStatementCards(values); syncStatementCards(); };
    root.querySelectorAll("[data-statement-up]").forEach(button => button.addEventListener("click", () => move(Number(button.dataset.statementUp), -1)));
    root.querySelectorAll("[data-statement-down]").forEach(button => button.addEventListener("click", () => move(Number(button.dataset.statementDown), 1)));
    root.querySelectorAll("[data-statement-remove]").forEach(button => button.addEventListener("click", () => { const values = readStatementCards(); values.splice(Number(button.dataset.statementRemove), 1); renderStatementCards(values); syncStatementCards(); }));
    root.querySelectorAll("[data-statement-down]").forEach((button, index) => button.disabled = index === entries.length - 1);
  }
  function syncStatementCards() { try { const entries = readStatementCards(); const value = JSON.stringify(entries, null, 2); document.querySelector("#partiql-statements").value = value; const capacity = document.querySelector("#partiql-capacity").value; const token = document.querySelector("#partiql-client-token").value.trim(); const request = mode.value === "batch" ? { Statements: entries, ReturnConsumedCapacity: capacity } : { TransactStatements: entries, ReturnConsumedCapacity: capacity, ClientRequestToken: token || "<generated UUID>" }; document.querySelector("#partiql-request-preview").textContent = JSON.stringify(request, null, 2); invalidatePaging(); } catch { /* Keep the last valid preview while JSON is being edited. */ } }
  const invalidatePaging = () => {
    const hadPaging = state.page > 0 || state.tokens.length > 1 || Boolean(state.output?.NextToken);
    state.tokens = [undefined]; state.page = 0;
    document.querySelector("#partiql-previous")?.setAttribute("disabled", ""); document.querySelector("#partiql-next")?.setAttribute("disabled", "");
    if (hadPaging) { const summary = result.querySelector(".card-header .muted.small"); if (summary) summary.textContent = "Request settings changed. Run again before paging."; }
  };
  const loadPayload = entry => {
    invalidatePaging();
    mode.value = entry.mode ?? "single"; updateMode();
    if (mode.value === "single") { statement.value = entry.statement ?? ""; parameters.value = entry.parameters ?? JSON.stringify(Array.from({ length: Number(entry.parameterCount) || 0 }, () => ({ S: "" }))); renderParameterRows(JSON.parse(parameters.value || "[]")); statement.focus(); }
    else { document.querySelector("#partiql-statements").value = entry.statements ?? "[]"; try { renderStatementCards(JSON.parse(entry.statements ?? "[]")); syncStatementCards(); } catch { renderStatementCards([]); } document.querySelector("#partiql-statements").focus(); }
    updateScanWarning();
  };
  const safeHistoryEntry = entry => {
    if (entry.mode === "single") { let parameterCount = Number(entry.parameterCount) || 0; try { if (entry.parameters !== undefined) parameterCount = JSON.parse(entry.parameters ?? "[]").length; } catch {} const { parameters: _parameters, ...rest } = entry; return { ...rest, statement: String(entry.statement ?? "").slice(0, 8192), parameterCount }; }
    let statements = "[]"; try { statements = JSON.stringify(JSON.parse(entry.statements ?? "[]").slice(0, 100).map(value => ({ Statement: String(value.Statement ?? "").slice(0, 8192), ParameterCount: Number(value.ParameterCount) || (Array.isArray(value.Parameters) ? value.Parameters.length : 0), ...(value.ConsistentRead ? { ConsistentRead: true } : {}), ...(value.ReturnValuesOnConditionCheckFailure ? { ReturnValuesOnConditionCheckFailure: value.ReturnValuesOnConditionCheckFailure } : {}) }))); } catch {}
    const { statements: _statements, ...rest } = entry; return { ...rest, statements };
  };
  history = history.map(safeHistoryEntry).slice(0, 100); writeLocalArray(historyKey, history);
  const saveHistory = entry => { history = [safeHistoryEntry(entry), ...history].slice(0, 100); writeLocalArray(historyKey, history); renderOperations(); };
  const renderOperations = () => {
    const search = document.querySelector("#partiql-history-search").value.trim().toLowerCase();
    const source = state.list === "saved" ? saved : history;
    const filtered = source.map((entry, index) => ({ entry, index })).filter(({ entry }) => JSON.stringify(entry).toLowerCase().includes(search));
    const root = document.querySelector("#partiql-history-list");
    root.innerHTML = filtered.length ? `<div class="partiql-history-list">${filtered.map(({ entry, index }) => `<div class="partiql-operation-row"><button data-partiql-entry="${index}"><span class="status ${entry.ok === false ? "error" : ""}">${escapeHtml(entry.operation ?? entry.mode?.toUpperCase() ?? "RUN")}</span><strong>${escapeHtml((entry.name ?? entry.statement ?? entry.statements ?? "Operation").replace(/\s+/g, " ").slice(0, 74))}</strong><small>${entry.at ? escapeHtml(new Date(entry.at).toLocaleString()) : "Saved"}${entry.ok === false ? ` · ${escapeHtml(entry.error ?? "Error")}` : entry.count !== undefined ? ` · ${entry.count} item${entry.count === 1 ? "" : "s"}` : ""}</small></button>${state.list === "saved" ? `<button class="button link" data-delete-saved="${index}" aria-label="Delete saved operation ${escapeHtml(entry.name ?? String(index + 1))}">Delete</button>` : ""}</div>`).join("")}</div>` : emptyState("◇", state.list === "saved" ? "No saved operations" : "No history", search ? "No operations match this search." : "Run or save an operation to see it here.");
    root.querySelectorAll("[data-partiql-entry]").forEach(button => button.addEventListener("click", () => loadPayload(source[Number(button.dataset.partiqlEntry)])));
    root.querySelectorAll("[data-delete-saved]").forEach(button => button.addEventListener("click", () => { saved.splice(Number(button.dataset.deleteSaved), 1); writeLocalArray(savedKey, saved); renderOperations(); }));
  };

  function renderParameterRows(values) {
    const root = document.querySelector("#partiql-parameter-rows");
    root.innerHTML = values.length ? values.map((value, index) => parameterRow(value, index)).join("") : '<p class="muted small">No parameters. Add one or load the JSON above.</p>';
    root.querySelectorAll("[data-parameter-type], [data-parameter-value]").forEach(control => control.addEventListener("input", syncParameters));
    root.querySelectorAll("[data-remove-parameter]").forEach(button => button.addEventListener("click", () => { const values = readParameterRows(); values.splice(Number(button.dataset.removeParameter), 1); renderParameterRows(values); parameters.value = JSON.stringify(values); invalidatePaging(); }));
  }
  function readParameterRows() {
    return [...document.querySelectorAll(".partiql-parameter-row")].map(row => parameterValue(row.querySelector("[data-parameter-type]").value, row.querySelector("[data-parameter-value]").value));
  }
  function syncParameters() { try { parameters.value = JSON.stringify(readParameterRows()); invalidatePaging(); } catch { /* leave the last valid JSON while a complex value is being typed */ } }

  const selectedResource = () => resources[Number(document.querySelector("#partiql-resource")?.value ?? 0)];
  const statementResource = text => {
    const identifier = '"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*'; const match = text.match(new RegExp(`\\bFROM\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?`, "i"));
    if (!match) return undefined; const decode = value => value?.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value; const tableName = decode(match[1]); const indexName = decode(match[2]);
    return resources.find(resource => resource.table.TableName === tableName && (resource.index?.IndexName ?? undefined) === indexName);
  };
  const updateBuilder = () => {
    const resource = selectedResource(); if (!resource) return;
    const schema = resource.index?.KeySchema ?? resource.table.KeySchema;
    const hash = schema.find(key => key.KeyType === "HASH"); const sort = schema.find(key => key.KeyType === "RANGE");
    document.querySelector("#partiql-builder-pk-label").textContent = `Partition key value – ${hash.AttributeName}`;
    document.querySelector("#partiql-builder-pk-type-label").textContent = `Partition key type – ${hash.AttributeName}`;
    document.querySelector("#partiql-builder-pk-type").value = attributeType(resource.table, hash.AttributeName);
    document.querySelector("#partiql-builder-sort").hidden = !sort;
    document.querySelector("#partiql-builder-sort-label").textContent = `Sort key condition – ${sort?.AttributeName ?? ""}`;
    document.querySelector("#partiql-consistent").disabled = resource.kind === "GSI";
    if (resource.kind === "GSI") document.querySelector("#partiql-consistent").checked = false;
  };
  const buildQuery = () => {
    const resource = selectedResource(); if (!resource) throw new Error("Create a table before building a query");
    const schema = resource.index?.KeySchema ?? resource.table.KeySchema;
    const hash = schema.find(key => key.KeyType === "HASH"); const sort = schema.find(key => key.KeyType === "RANGE");
    const pk = document.querySelector("#partiql-builder-pk").value;
    if (!pk) throw new Error("Enter a partition key value");
    const projection = document.querySelector("#partiql-builder-projection").value.split(",").map(value => value.trim()).filter(Boolean).map(quoteIdentifier).join(", ") || "*";
    const source = `${quoteIdentifier(resource.table.TableName)}${resource.index ? `.${quoteIdentifier(resource.index.IndexName)}` : ""}`;
    const conditions = [`${quoteIdentifier(hash.AttributeName)}=?`];
    const typed = [typedValue(attributeType(resource.table, hash.AttributeName), pk)];
    const operator = document.querySelector("#partiql-builder-sort-op").value;
    if (sort && operator) {
      const value = document.querySelector("#partiql-builder-sort-value").value; if (!value) throw new Error("Enter a sort key value");
      if (operator === "BETWEEN") { const upper = document.querySelector("#partiql-builder-sort-upper").value; if (!upper) throw new Error("Enter an upper sort key value"); conditions.push(`${quoteIdentifier(sort.AttributeName)} BETWEEN ? AND ?`); typed.push(typedValue(attributeType(resource.table, sort.AttributeName), value), typedValue(attributeType(resource.table, sort.AttributeName), upper)); }
      else if (operator === "begins_with") { conditions.push(`begins_with(${quoteIdentifier(sort.AttributeName)}, ?)`); typed.push(typedValue(attributeType(resource.table, sort.AttributeName), value)); }
      else { conditions.push(`${quoteIdentifier(sort.AttributeName)} ${operator} ?`); typed.push(typedValue(attributeType(resource.table, sort.AttributeName), value)); }
    }
    invalidatePaging(); mode.value = "single"; updateMode(); statement.value = `SELECT ${projection} FROM ${source} WHERE ${conditions.join(" AND ")}`; parameters.value = JSON.stringify(typed); renderParameterRows(typed); updateScanWarning(); statement.focus();
  };

  const inferAccessPath = () => {
    const text = statement.value.trim(); if (!/^SELECT\b/i.test(text)) return "Write";
    const source = statementResource(text); if (!source) return "Scan";
    const schema = source.index?.KeySchema ?? source.table.KeySchema; const hash = schema.find(key => key.KeyType === "HASH")?.AttributeName;
    const escaped = String(hash).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hashReference = `(?:"${escaped}"|\\b${escaped}\\b)`; const targeted = new RegExp(`${hashReference}\\s*(?:=|\\bIN\\s*[\\[(])`, "i").test(text);
    if (!targeted) return "Scan";
    const tableKeys = source.table.KeySchema.map(key => key.AttributeName);
    const fullKey = !source.index && tableKeys.every(name => new RegExp(`(?:"${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b)\\s*=`, "i").test(text));
    return fullKey ? "GetItem" : "Query";
  };
  const updateScanWarning = () => {
    const source = statementResource(statement.value.trim()); const consistent = document.querySelector("#partiql-consistent"); const gsi = source?.kind === "GSI"; consistent.disabled = gsi; if (gsi) consistent.checked = false;
    state.accessPath = mode.value === "single" ? inferAccessPath() : "Batch/transaction";
    const warning = document.querySelector("#partiql-scan-warning"); if (!warning) return;
    warning.hidden = state.accessPath !== "Scan";
    warning.innerHTML = '<strong>Potential full-table scan</strong><br>This SELECT has no recognized partition-key equality. contains and other non-key predicates filter after items are read.';
  };

  const updateMode = () => {
    const single = mode.value === "single";
    document.querySelector("#partiql-single-editor").hidden = !single;
    document.querySelector("#partiql-multi-editor").hidden = single;
    document.querySelector("#partiql-query-builder").hidden = !single || !resources.length;
    document.querySelector("#partiql-code").textContent = single ? "Generate code" : "Generate request code";
    document.querySelector("#partiql-client-token-field").hidden = mode.value !== "transaction";
    if (!single) try { renderStatementCards(JSON.parse(document.querySelector("#partiql-statements").value || "[]")); syncStatementCards(); } catch { /* The raw editor reports malformed JSON when the request runs. */ }
    updateScanWarning();
  };

  const renderResult = () => {
    if (state.error) { const details = state.error.details ?? { message: state.error.message }; result.innerHTML = `<div class="card-header"><div><h2>Error details</h2><p class="muted small">The operation was not completed.</p></div><span class="status error">Failed</span></div><div class="card-body"><div class="alert error"><strong>${escapeHtml(state.error.code ?? "Statement error")}</strong><br>${escapeHtml(state.error.message)}</div><pre class="code-box">${escapeHtml(JSON.stringify(details, null, 2))}</pre></div>`; return; }
    if (!state.output) return;
    const items = state.output.Items ?? state.output.Responses?.flatMap(response => response.Item ? [response.Item] : []) ?? [];
    const plain = format.value === "plain"; const raw = format.value === "raw";
    let body;
    if (raw || mode.value !== "single") body = `<div class="card-body"><pre class="code-box">${escapeHtml(JSON.stringify(state.output, null, 2))}</pre></div>`;
    else if (items.length) { const names = [...new Set(items.flatMap(item => Object.keys(item)))]; body = `<div class="table-wrap partiql-results-table"><table><thead><tr>${names.map(name => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${items.map(item => `<tr>${names.map(name => `<td>${plain ? `<span class="json-value">${escapeHtml(JSON.stringify(plainAttribute(item[name])))}</span>` : formatAttribute(item[name])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; }
    else body = emptyState("✓", "Statement completed", "The statement returned no items.");
    const capacity = state.output.ConsumedCapacity; const units = Array.isArray(capacity) ? capacity.reduce((sum, item) => sum + Number(item.CapacityUnits ?? 0), 0) : capacity?.CapacityUnits;
    const formatLabel = mode.value === "single" ? format.options[format.selectedIndex].text : "Raw response";
    result.innerHTML = `<div class="card-header"><div><h2>Results <span class="muted">(${items.length})</span></h2><p class="muted small">${mode.value === "single" ? `Page ${state.page + 1} · Access path: ${state.accessPath}` : mode.options[mode.selectedIndex].text} · ${escapeHtml(formatLabel)}${units === undefined ? "" : ` · ${Number(units).toLocaleString()} capacity units`}</p></div><div class="actions">${mode.value === "single" ? `<button class="button" id="partiql-previous" ${state.page === 0 ? "disabled" : ""}>Previous</button><button class="button" id="partiql-next" ${state.output.NextToken ? "" : "disabled"}>Next</button>` : ""}</div></div>${body}`;
    document.querySelector("#partiql-previous")?.addEventListener("click", () => runPage(state.page - 1, true));
    document.querySelector("#partiql-next")?.addEventListener("click", () => { state.tokens[state.page + 1] = state.output.NextToken; runPage(state.page + 1, true); });
  };

  const runPage = async (pageIndex = 0, pagination = false) => {
    if (state.running || pageIndex < 0) return; state.running = true; document.querySelector("#run-partiql").disabled = true;
    result.innerHTML = '<div class="card-header"><h2>Results</h2></div><div class="loading" role="status"><span></span>Running operation…</div>';
    const payload = currentPayload();
    try {
      let output; let operation;
      if (mode.value === "single") {
        const parsedParameters = JSON.parse(payload.parameters); if (!Array.isArray(parsedParameters)) throw new Error("Parameters must be a JSON array");
        const isSelect = /^SELECT\b/i.test(payload.statement); operation = payload.statement.split(/\s+/, 1)[0]?.toUpperCase() || "RUN";
        output = await dynamo("ExecuteStatement", { Statement: payload.statement, Parameters: parsedParameters.length ? parsedParameters : undefined, ReturnConsumedCapacity: document.querySelector("#partiql-capacity").value, ...(isSelect ? { Limit: Number(document.querySelector("#partiql-limit").value) } : {}), ...(isSelect && document.querySelector("#partiql-consistent").checked ? { ConsistentRead: true } : {}), ...(isSelect && state.tokens[pageIndex] ? { NextToken: state.tokens[pageIndex] } : {}) });
      } else {
        const entries = JSON.parse(payload.statements); if (!Array.isArray(entries)) throw new Error("Statements request must be a JSON array");
        operation = mode.value === "batch" ? "BATCH" : "TRANSACTION";
        const suppliedToken = document.querySelector("#partiql-client-token").value.trim();
        output = await dynamo(mode.value === "batch" ? "BatchExecuteStatement" : "ExecuteTransaction", { [mode.value === "batch" ? "Statements" : "TransactStatements"]: entries, ReturnConsumedCapacity: document.querySelector("#partiql-capacity").value, ...(mode.value === "transaction" ? { ClientRequestToken: suppliedToken || crypto.randomUUID() } : {}) });
      }
      state.output = output; state.error = undefined; state.page = pageIndex; updateScanWarning(); setDirty(false, "page");
      if (!pagination) { state.tokens = [undefined]; saveHistory({ at: Date.now(), mode: mode.value, ...payload, operation, ok: true, count: output.Items?.length ?? output.Responses?.filter(response => response.Item).length ?? 0 }); }
    } catch (error) { state.output = undefined; state.error = error; if (!pagination) saveHistory({ at: Date.now(), mode: mode.value, ...payload, operation: mode.value === "single" ? payload.statement.split(/\s+/, 1)[0]?.toUpperCase() || "RUN" : mode.value.toUpperCase(), ok: false, count: 0, error: error.code ?? "Error" }); showError(error); }
    finally { state.running = false; document.querySelector("#run-partiql").disabled = false; renderResult(); }
  };

  document.querySelector("#run-partiql").addEventListener("click", () => runPage());
  document.querySelector("#clear-partiql").addEventListener("click", () => { invalidatePaging(); if (mode.value === "single") { statement.value = ""; parameters.value = "[]"; renderParameterRows([]); statement.focus(); } else { document.querySelector("#partiql-statements").value = "[]"; renderStatementCards([]); syncStatementCards(); document.querySelector("#partiql-statements").focus(); } updateScanWarning(); });
  mode.addEventListener("change", () => { invalidatePaging(); updateMode(); }); format.addEventListener("change", renderResult); statement.addEventListener("input", () => { invalidatePaging(); updateScanWarning(); });
  parameters.addEventListener("input", invalidatePaging); document.querySelector("#partiql-statements").addEventListener("input", invalidatePaging); document.querySelector("#partiql-statements").addEventListener("change", () => { try { renderStatementCards(JSON.parse(document.querySelector("#partiql-statements").value || "[]")); syncStatementCards(); } catch { /* Run reports malformed raw JSON. */ } }); document.querySelector("#partiql-limit").addEventListener("change", invalidatePaging); document.querySelector("#partiql-consistent").addEventListener("change", invalidatePaging); document.querySelector("#partiql-capacity").addEventListener("change", () => { invalidatePaging(); if (mode.value !== "single") syncStatementCards(); }); document.querySelector("#partiql-client-token").addEventListener("input", syncStatementCards);
  document.querySelector("#partiql-resource")?.addEventListener("change", updateBuilder);
  document.querySelector("#partiql-add-statement").addEventListener("click", () => { let entries = []; try { entries = readStatementCards(); } catch {} const fallback = defaultResource ? `SELECT * FROM ${quoteIdentifier(defaultResource.table.TableName)} WHERE ${quoteIdentifier(defaultResource.table.KeySchema.find(key => key.KeyType === "HASH")?.AttributeName ?? "id") }=?` : 'SELECT * FROM "TableName" WHERE "id"=?'; entries.push({ Statement: fallback, Parameters: [{ S: "value" }] }); renderStatementCards(entries); syncStatementCards(); });
  document.querySelector("#partiql-builder-sort-op")?.addEventListener("change", event => { document.querySelector("#partiql-builder-sort-upper").hidden = event.target.value !== "BETWEEN"; });
  document.querySelector("#partiql-build-query")?.addEventListener("click", () => { try { buildQuery(); } catch (error) { showError(error); } });
  document.querySelector("#partiql-add-parameter").addEventListener("click", () => { let values; try { values = JSON.parse(parameters.value || "[]"); } catch { values = readParameterRows(); } values.push({ S: "" }); renderParameterRows(values); syncParameters(); });
  document.querySelector("#partiql-parse-parameters").addEventListener("click", () => { try { const values = JSON.parse(parameters.value || "[]"); if (!Array.isArray(values)) throw new Error("Parameters must be a JSON array"); renderParameterRows(values); } catch (error) { showError(error); } });
  document.querySelector("#partiql-save").addEventListener("click", () => showModal("Save PartiQL operation", '<div class="field"><label>Operation name</label><input name="name" required maxlength="100" placeholder="Find active catalog entries"></div>', "Save", async data => { saved = [{ name: String(data.get("name")), mode: mode.value, ...currentPayload() }, ...saved].slice(0, 100); writeLocalArray(savedKey, saved); state.list = "saved"; updateListTabs(); renderOperations(); setDirty(false, "page"); toast("PartiQL operation saved"); }, false, { refreshAfterSubmit: false }));
  document.querySelector("#partiql-code").addEventListener("click", () => { try { const code = generatedCode(mode.value, currentPayload(), document.querySelector("#partiql-capacity").value, { limit: Number(document.querySelector("#partiql-limit").value), consistent: document.querySelector("#partiql-consistent").checked, clientToken: document.querySelector("#partiql-client-token").value.trim() }); showModal("SDK for JavaScript code", `<div class="field"><label>Generated request</label><pre class="code-box" style="max-height:520px">${escapeHtml(code)}</pre><span class="hint">Set the client endpoint to this simulator when running locally.</span></div>`, "Close", async () => undefined, true, { refreshAfterSubmit: false }); } catch (error) { showError(error); } });
  document.querySelector("#partiql-history-search").addEventListener("input", renderOperations);
  document.querySelectorAll("[data-partiql-list]").forEach(button => button.addEventListener("click", () => { state.list = button.dataset.partiqlList; updateListTabs(); renderOperations(); }));
  function updateListTabs() { document.querySelectorAll("[data-partiql-list]").forEach(button => button.classList.toggle("active", button.dataset.partiqlList === state.list)); }
  document.querySelector("#export-partiql-history").addEventListener("click", () => downloadJson("stacksim-partiql-operations.json", { version: 1, history, saved }));
  document.querySelector("#import-partiql-history").addEventListener("change", async event => { try { const file = event.target.files?.[0]; if (!file) return; const imported = JSON.parse(await file.text()); if (!Array.isArray(imported.history) || !Array.isArray(imported.saved)) throw new Error("The imported file is not a PartiQL operations export"); history = imported.history.slice(0, 100).map(safeHistoryEntry); saved = imported.saved.slice(0, 100); writeLocalArray(historyKey, history); writeLocalArray(savedKey, saved); renderOperations(); toast("PartiQL operations imported"); } catch (error) { showError(error); } finally { event.target.value = ""; } });

  renderStatementCards(initialEntries); syncStatementCards(); renderParameterRows([]); updateBuilder(); updateMode(); updateScanWarning(); renderOperations();
}

function pageHeaderMarkup() { return `<div class="page-header"><div class="page-title"><h1>PartiQL editor</h1><p>Build efficient key queries, run SQL-compatible statements, and inspect the access path.</p></div></div>`; }
async function collectTableNames() { const names = []; let start; do { const page = await dynamo("ListTables", { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) }); names.push(...(page.TableNames ?? [])); start = page.LastEvaluatedTableName; } while (start); return names; }
function attributeType(table, name) { return table.AttributeDefinitions.find(attribute => attribute.AttributeName === name)?.AttributeType ?? "S"; }
function typedValue(type, value) { return type === "N" ? { N: String(value) } : type === "B" ? { B: String(value) } : { S: String(value) }; }
function parameterRow(value, index) { const [type, raw] = Object.entries(value ?? { S: "" })[0] ?? ["S", ""]; const text = ["M", "L"].includes(type) ? JSON.stringify(raw) : ["SS", "NS", "BS"].includes(type) ? raw.join(", ") : String(raw ?? ""); return `<div class="partiql-parameter-row field-row"><div class="field"><label>Parameter ${index + 1} type</label><select data-parameter-type>${parameterTypes.map(([option, label]) => `<option value="${option}" ${option === type ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label>Parameter ${index + 1} value</label><div class="attribute-value"><input data-parameter-value value="${escapeHtml(text)}"><button class="button link" type="button" data-remove-parameter="${index}">Remove</button></div></div></div>`; }
function parameterValue(type, value) { if (type === "BOOL") return { BOOL: value === "true" }; if (type === "NULL") return { NULL: true }; if (type === "M" || type === "L") return { [type]: JSON.parse(value) }; if (["SS", "NS", "BS"].includes(type)) return { [type]: value.split(",").map(item => item.trim()).filter(Boolean) }; return { [type]: String(value) }; }
function plainNumber(value) { const digits = value.replace(/[^0-9]/g, "").replace(/^0+/, "").length; return digits <= 15 ? Number(value) : value; }
function plainAttribute(value) { if (!value) return null; if ("S" in value) return value.S; if ("N" in value) return plainNumber(value.N); if ("B" in value) return value.B; if ("BOOL" in value) return value.BOOL; if ("NULL" in value) return null; if ("L" in value) return value.L.map(plainAttribute); if ("M" in value) return Object.fromEntries(Object.entries(value.M).map(([name, child]) => [name, plainAttribute(child)])); for (const type of ["SS", "NS", "BS"]) if (type in value) return type === "NS" ? value[type].map(plainNumber) : value[type]; return value; }
function formatAttribute(value) { if (!value) return '<span class="muted">–</span>'; const [type, raw] = Object.entries(value)[0]; return `<span class="json-value"><span class="type-tag">${escapeHtml(type)}</span>${escapeHtml(typeof raw === "object" ? JSON.stringify(raw) : raw)}</span>`; }
function generatedCode(mode, payload, capacity, options = {}) { const operation = mode === "single" ? "ExecuteStatement" : mode === "batch" ? "BatchExecuteStatement" : "ExecuteTransaction"; const parameters = mode === "single" ? JSON.parse(payload.parameters || "[]") : undefined; const select = mode === "single" && /^SELECT\b/i.test(payload.statement); const statements = mode === "single" ? { Statement: payload.statement, ...(parameters.length ? { Parameters: parameters } : {}), ReturnConsumedCapacity: capacity, ...(select ? { Limit: options.limit } : {}), ...(select && options.consistent ? { ConsistentRead: true } : {}) } : { [mode === "batch" ? "Statements" : "TransactStatements"]: JSON.parse(payload.statements || "[]"), ReturnConsumedCapacity: capacity }; let request = JSON.stringify(statements, null, 2); if (mode === "transaction") request = `${request.slice(0, -2)},\n  "ClientRequestToken": ${options.clientToken ? JSON.stringify(options.clientToken) : "crypto.randomUUID()"}\n}`; return `import { DynamoDBClient, ${operation}Command } from "@aws-sdk/client-dynamodb";\n\nconst client = new DynamoDBClient({ region: "${session.region}" });\nconst response = await client.send(new ${operation}Command(${request}));\nconsole.log(response);`; }
function downloadJson(name, value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
