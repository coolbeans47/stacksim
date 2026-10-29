import { dynamo } from "../api-client.js";
import { emptyState, escapeHtml, pageHeader } from "../components.js";
import { setDirty } from "../state.js";

// The Explore items page and the Create/Edit/Duplicate item pages follow the current AWS DynamoDB console.
// Every read and write uses a documented DynamoDB operation (Scan, Query, GetItem, PutItem, UpdateItem, DeleteItem),
// so the service stays authoritative for validation; the page only assembles requests.

let controlId = 0;
const nextId = prefix => `${prefix}-${++controlId}`;
// Explorer settings and paging per table, kept for the browser session so that returning from an item page,
// deleting items, or editing a cell re-runs the same request instead of resetting the page.
const explorerStates = new Map();

const ATTRIBUTE_TYPES = [["S", "String"], ["N", "Number"], ["B", "Binary"], ["BOOL", "Boolean"], ["NULL", "Null"], ["SS", "String set"], ["NS", "Number set"], ["BS", "Binary set"], ["L", "List"], ["M", "Map"]];
const TYPE_LABELS = Object.fromEntries(ATTRIBUTE_TYPES);
const FILTER_TYPES = ATTRIBUTE_TYPES.slice(0, 5);
const SET_TYPES = new Set(["SS", "NS", "BS"]);
const FILTER_CONDITIONS = [["=", "Equal to"], ["<>", "Not equal to"], ["<=", "Less than or equal to"], ["<", "Less than"], [">=", "Greater than or equal to"], [">", "Greater than"], ["BETWEEN", "Between"], ["exists", "Exists"], ["not_exists", "Not exists"], ["contains", "Contains"], ["not_contains", "Not contains"], ["begins_with", "Begins with"]];
const SORT_CONDITIONS = [["=", "Equal to"], ["<=", "Less than or equal to"], ["<", "Less than"], [">=", "Greater than or equal to"], [">", "Greater than"], ["BETWEEN", "Between"], ["begins_with", "Begins with"]];
const NO_VALUE_CONDITIONS = new Set(["exists", "not_exists"]);
const INLINE_EDIT_TYPES = new Set(["S", "N", "B", "BOOL"]);
const AUTOPREVIEW_KEY = "stacksim-dynamodb-autopreview";

const optionList = (entries, selected) => entries.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
// Boolean and Null filters only compare or test existence; begins_with needs a String or Binary operand.
const conditionsForType = type => type === "BOOL" || type === "NULL" ? FILTER_CONDITIONS.filter(([value]) => ["=", "<>", "exists", "not_exists"].includes(value)) : type === "N" ? FILTER_CONDITIONS.filter(([value]) => value !== "begins_with") : FILTER_CONDITIONS;
const tableIndexes = table => [
  ...(table.LocalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "LSI" })),
  ...(table.GlobalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "GSI" })),
];
const itemsHash = tableName => `#/dynamodb/tables/${encodeURIComponent(tableName)}/items`;
const itemPageHash = (tableName, mode, key) => `${itemsHash(tableName)}/${mode}${key ? `/${encodeKey(key)}` : ""}`;

export async function enhancedDynamoItemsView(table) {
  const indexes = tableIndexes(table);
  return `<section class="card" id="item-query-card"><div class="card-header"><div><h2>Scan or query items</h2></div></div><div class="card-body">`
    + `<div class="item-operation" role="radiogroup" aria-label="Scan or query"><label><input type="radio" name="item-operation" value="scan" checked> Scan</label><label><input type="radio" name="item-operation" value="query"> Query</label></div>`
    + `<div class="field-row item-primary-controls"><div class="field"><label for="item-index">Select a table or index</label><select id="item-index"><option value="">Table – ${escapeHtml(table.TableName)}</option>${indexes.map(index => `<option value="${escapeHtml(index.IndexName)}">Index – ${escapeHtml(index.IndexName)}</option>`).join("")}</select></div>`
    + `<div class="field"><label for="item-projection-mode">Select attribute projection</label><select id="item-projection-mode"><option value="all">All attributes</option><option value="projected">Only projected attributes</option><option value="specific">Specific attributes</option></select></div>`
    + `<div class="field" id="item-projection-field" hidden><label for="item-projection">Attribute names</label><input id="item-projection" placeholder="For example: title, status"><span class="hint">Separate top-level attribute names with commas.</span></div></div>`
    + `<div id="item-query-controls" hidden><div class="field-row item-key-controls"><div class="field"><label for="query-key" id="query-key-label">Partition key</label><input id="query-key" placeholder="Enter partition key value"><span class="hint" id="query-key-hint"></span></div>`
    + `<div class="field" id="item-sort-controls"><label for="query-sort-value">Sort key</label><div class="item-sort-inputs"><select id="query-sort-operator" aria-label="Sort key condition">${optionList(SORT_CONDITIONS, "=")}</select><input id="query-sort-value" placeholder="Enter sort key value"><input id="query-sort-value-2" aria-label="Second sort key value" placeholder="Enter upper sort key value" hidden></div><span class="hint" id="query-sort-hint"></span></div></div>`
    + `<label class="checkbox-label item-descending"><input type="checkbox" id="item-descending"> Sort descending</label></div>`
    + `<details class="item-query-options" id="item-filters" open><summary>Filters</summary><div class="compact-card-body"><div id="item-filter-rows"></div><button type="button" class="button" id="add-item-filter">Add filter</button></div></details>`
    + `<details class="item-query-options" id="item-local-settings"><summary>Additional settings (local)</summary><div class="compact-card-body"><p class="muted small">The AWS Explore items page has no controls for these request options. StackSim keeps them for learning; each one maps to a documented Scan or Query parameter.</p>`
    + `<div class="field-row item-local-controls"><div class="field"><label for="item-limit">Page size (Limit)</label><select id="item-limit"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></div><div class="field"><label for="item-results-view">Results view</label><select id="item-results-view"><option value="table">Table</option><option value="plain">Plain JSON</option><option value="dynamodb">DynamoDB JSON</option></select></div></div>`
    + `<div class="item-local-checks"><label class="checkbox-label"><input type="checkbox" id="item-consistent"> Strongly consistent read (ConsistentRead)</label><label class="checkbox-label"><input type="checkbox" id="item-count-only"> Count only (Select COUNT)</label><label class="checkbox-label"><input type="checkbox" id="item-autopreview"> Run a scan when this page opens</label></div>`
    + `<div class="field-row" id="item-segment-controls"><div class="field"><label for="item-segment">Parallel scan segment</label><input id="item-segment" type="number" min="0" placeholder="Optional"></div><div class="field"><label for="item-total-segments">Total scan segments</label><input id="item-total-segments" type="number" min="1" max="1000000" placeholder="Required with segment"></div></div>`
    + `<div class="field"><label for="item-filter-expression">Raw filter expression</label><input id="item-filter-expression" class="mono" placeholder="contains(#title, :needle) OR attribute_exists(#active)"><span class="hint">Combined with the filters above using AND. Filters run after DynamoDB reads each page.</span></div>`
    + `<div class="field-row"><div class="field"><label for="item-expression-names">Expression attribute names (JSON)</label><textarea id="item-expression-names" class="code-editor" placeholder='{"#title":"title"}'>{}</textarea></div><div class="field"><label for="item-expression-values">Expression attribute values (DynamoDB JSON)</label><textarea id="item-expression-values" class="code-editor" placeholder='{":needle":{"S":"guide"}}'>{}</textarea></div></div></div></details>`
    + `<div class="actions"><button class="button primary" id="run-items">Run</button><button class="button" id="reset-items">Reset</button></div></div></section>`
    + `<section class="card" id="items-result-card"><div class="card-header"><div><h2>Items returned <span class="muted" id="items-returned-count"></span></h2></div><div class="actions">${itemActionsMenu()}<a class="button primary" href="${itemPageHash(table.TableName, "create")}" data-action="create-item">Create item</a></div></div><div id="item-result-summary"></div><div id="items-table">${emptyState("◇", "No request has run", "Choose Scan or Query, then choose Run.")}</div></section>`;
}

const itemActionsMenu = () => `<details class="actions-menu" id="item-actions"><summary class="button" aria-haspopup="menu">Actions ▾</summary><div class="menu" role="menu"><button type="button" role="menuitem" data-item-menu="edit" disabled>Edit item</button><button type="button" role="menuitem" data-item-menu="duplicate" disabled>Duplicate item</button><button type="button" role="menuitem" data-item-menu="query" disabled>Query for selected item</button><button type="button" role="menuitem" data-item-menu="csv" disabled>Export to CSV</button><button type="button" role="menuitem" class="danger" data-item-menu="delete" disabled>Delete items</button></div></details>`;

function filterRowMarkup({ name = "", condition = "=", type = "S", value = "", value2 = "", bool = "true" } = {}) {
  const id = nextId("item-filter");
  const conditions = conditionsForType(type);
  const selected = conditions.some(([option]) => option === condition) ? condition : "=";
  return `<div class="item-filter-row" data-filter-row><div class="field"><label for="${id}-name">Attribute name</label><input id="${id}-name" data-filter-name value="${escapeHtml(name)}" placeholder="Enter attribute name"></div>`
    + `<div class="field"><label for="${id}-condition">Condition</label><select id="${id}-condition" data-filter-condition>${optionList(conditions, selected)}</select></div>`
    + `<div class="field"><label for="${id}-type">Type</label><select id="${id}-type" data-filter-type>${optionList(FILTER_TYPES, type)}</select></div>`
    + `<div class="field" data-filter-value-field><label for="${id}-value">Value</label><input id="${id}-value" data-filter-value value="${escapeHtml(value)}" placeholder="Enter attribute value"><select data-filter-bool aria-label="Value" hidden><option value="true" ${bool === "true" ? "selected" : ""}>True</option><option value="false" ${bool === "false" ? "selected" : ""}>False</option></select><input data-filter-value-2 aria-label="Second value" value="${escapeHtml(value2)}" placeholder="Enter upper value" hidden><span class="muted small item-filter-no-value" data-filter-no-value hidden>No value needed</span></div>`
    + `<div class="item-filter-remove"><button type="button" class="button" data-remove-filter>Remove</button></div></div>`;
}

function syncFilterRow(row) {
  const type = row.querySelector("[data-filter-type]").value;
  const condition = row.querySelector("[data-filter-condition]").value;
  const noValue = NO_VALUE_CONDITIONS.has(condition) || type === "NULL";
  row.querySelector("[data-filter-value]").hidden = noValue || type === "BOOL";
  row.querySelector("[data-filter-bool]").hidden = noValue || type !== "BOOL";
  row.querySelector("[data-filter-value-2]").hidden = noValue || type === "BOOL" || condition !== "BETWEEN";
  row.querySelector("[data-filter-no-value]").hidden = !noValue;
}

export function bindEnhancedDynamoItems(context, table) {
  const { showError, showModal, toast } = context;
  const $ = selector => document.querySelector(selector);
  const indexes = tableIndexes(table);
  const tableKeyNames = new Set(table.KeySchema.map(key => key.AttributeName));
  const hashName = table.KeySchema.find(key => key.KeyType === "HASH").AttributeName;
  const state = { result: undefined, items: [], columns: [], page: 0, tokens: [undefined], running: false, selected: new Set(), operation: "scan", countOnly: false, hasRun: false };
  const root = $("#items-result-card");
  const filterRoot = $("#item-filter-rows");
  const indexSelect = $("#item-index");
  const projectionMode = $("#item-projection-mode");
  const autopreview = $("#item-autopreview");
  let storedAutopreview = null;
  try { storedAutopreview = localStorage.getItem(AUTOPREVIEW_KEY); } catch { storedAutopreview = null; }
  autopreview.checked = storedAutopreview !== "false";

  const operationValue = () => document.querySelector('input[name="item-operation"]:checked')?.value ?? "scan";
  const setOperation = value => { document.querySelectorAll('input[name="item-operation"]').forEach(radio => { radio.checked = radio.value === value; }); };
  const selectedIndex = () => indexes.find(index => index.IndexName === indexSelect.value);
  const selectedSchema = () => selectedIndex()?.KeySchema ?? table.KeySchema;
  const resetPaging = () => { state.tokens = [undefined]; state.page = 0; };
  const parseObject = (id, label) => {
    const value = JSON.parse($(id).value.trim() || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return value;
  };
  const addName = (names, attribute, prefix) => {
    const existing = Object.entries(names).find(([, name]) => name === attribute);
    if (existing) return existing[0];
    let token = `#${prefix}`; let suffix = 0;
    while (Object.prototype.hasOwnProperty.call(names, token)) token = `#${prefix}${++suffix}`;
    names[token] = attribute;
    return token;
  };
  const addValue = (values, value, prefix) => {
    let token = `:${prefix}`; let suffix = 0;
    while (Object.prototype.hasOwnProperty.call(values, token)) token = `:${prefix}${++suffix}`;
    values[token] = value;
    return token;
  };

  const updateControls = () => {
    const query = operationValue() === "query";
    $("#item-query-controls").hidden = !query;
    $("#item-segment-controls").hidden = query;
    const schema = selectedSchema();
    const hash = schema.find(key => key.KeyType === "HASH");
    const sort = schema.find(key => key.KeyType === "RANGE");
    $("#query-key-hint").textContent = hash ? `${hash.AttributeName} · ${TYPE_LABELS[attributeType(table, hash.AttributeName)]}` : "";
    $("#item-sort-controls").hidden = !sort;
    $("#query-sort-hint").textContent = sort ? `${sort.AttributeName} · ${TYPE_LABELS[attributeType(table, sort.AttributeName)]}` : "";
    $("#query-sort-value-2").hidden = $("#query-sort-operator").value !== "BETWEEN";
    const index = selectedIndex();
    const consistent = $("#item-consistent");
    consistent.disabled = index?.kind === "GSI";
    if (consistent.disabled) consistent.checked = false;
    const projectedOption = projectionMode.querySelector('option[value="projected"]');
    projectedOption.disabled = !index;
    if (!index && projectionMode.value === "projected") projectionMode.value = "all";
    $("#item-projection-field").hidden = projectionMode.value !== "specific";
  };

  const bindFilterRow = row => {
    const typeSelect = row.querySelector("[data-filter-type]");
    const conditionSelect = row.querySelector("[data-filter-condition]");
    typeSelect.addEventListener("change", () => {
      const conditions = conditionsForType(typeSelect.value);
      const current = conditionSelect.value;
      conditionSelect.innerHTML = optionList(conditions, conditions.some(([value]) => value === current) ? current : "=");
      syncFilterRow(row);
    });
    conditionSelect.addEventListener("change", () => syncFilterRow(row));
    row.querySelectorAll("input, select").forEach(control => control.addEventListener(control.matches("select") ? "change" : "input", invalidatePaging));
    row.querySelector("[data-remove-filter]").addEventListener("click", () => { row.remove(); invalidatePaging(); });
    syncFilterRow(row);
  };
  const addFilterRow = (values = {}) => {
    filterRoot.insertAdjacentHTML("beforeend", filterRowMarkup(values));
    const row = filterRoot.lastElementChild;
    bindFilterRow(row);
    return row;
  };
  const filterValue = (type, row, selector) => type === "BOOL" ? { BOOL: row.querySelector("[data-filter-bool]").value === "true" } : type === "NULL" ? { NULL: true } : { [type]: row.querySelector(selector).value };
  const filterExpressions = (names, values) => {
    const expressions = [];
    filterRoot.querySelectorAll("[data-filter-row]").forEach((row, index) => {
      const name = row.querySelector("[data-filter-name]").value;
      const condition = row.querySelector("[data-filter-condition]").value;
      const type = row.querySelector("[data-filter-type]").value;
      if (!name) {
        if (row.querySelector("[data-filter-value]").value) throw new Error(`Enter an attribute name for filter ${index + 1}`);
        return;
      }
      const token = addName(names, name, `f${index}`);
      if (condition === "exists") { expressions.push(`attribute_exists(${token})`); return; }
      if (condition === "not_exists") { expressions.push(`attribute_not_exists(${token})`); return; }
      if (!["BOOL", "NULL"].includes(type) && row.querySelector("[data-filter-value]").value === "") throw new Error(`Enter a value for the ${name} filter`);
      const valueToken = addValue(values, filterValue(type, row, "[data-filter-value]"), `f${index}`);
      if (condition === "BETWEEN") {
        if (row.querySelector("[data-filter-value-2]").value === "") throw new Error(`Enter the upper value for the ${name} filter`);
        expressions.push(`${token} BETWEEN ${valueToken} AND ${addValue(values, filterValue(type, row, "[data-filter-value-2]"), `f${index}u`)}`);
      } else if (condition === "contains") expressions.push(`contains(${token}, ${valueToken})`);
      else if (condition === "not_contains") expressions.push(`NOT contains(${token}, ${valueToken})`);
      else if (condition === "begins_with") expressions.push(`begins_with(${token}, ${valueToken})`);
      else expressions.push(`${token} ${condition} ${valueToken}`);
    });
    return expressions;
  };

  const requestInput = pageIndex => {
    const names = parseObject("#item-expression-names", "Expression attribute names");
    const values = parseObject("#item-expression-values", "Expression attribute values");
    const input = { TableName: table.TableName, Limit: Number($("#item-limit").value), ReturnConsumedCapacity: "TOTAL" };
    const index = selectedIndex();
    if (index) input.IndexName = index.IndexName;
    if (state.tokens[pageIndex]) input.ExclusiveStartKey = state.tokens[pageIndex];
    if ($("#item-consistent").checked) input.ConsistentRead = true;
    const countOnly = $("#item-count-only").checked;
    if (countOnly) input.Select = "COUNT";

    if (operationValue() === "query") {
      const schema = selectedSchema();
      const hash = schema.find(key => key.KeyType === "HASH");
      const sort = schema.find(key => key.KeyType === "RANGE");
      const keyValue = $("#query-key").value;
      if (!keyValue) throw new Error("Enter a partition key value");
      const keyConditions = [`${addName(names, hash.AttributeName, "pk")} = ${addValue(values, typedValue(attributeType(table, hash.AttributeName), keyValue), "pk")}`];
      const operator = $("#query-sort-operator").value;
      const sortRaw = $("#query-sort-value").value;
      if (sort && (sortRaw !== "" || operator === "BETWEEN")) {
        if (sortRaw === "") throw new Error("Enter a sort key value");
        const sortType = attributeType(table, sort.AttributeName);
        const sortName = addName(names, sort.AttributeName, "sk");
        const sortValue = addValue(values, typedValue(sortType, sortRaw), "sk");
        if (operator === "BETWEEN") {
          const upper = $("#query-sort-value-2").value;
          if (upper === "") throw new Error("Enter the upper sort key value");
          keyConditions.push(`${sortName} BETWEEN ${sortValue} AND ${addValue(values, typedValue(sortType, upper), "skUpper")}`);
        } else if (operator === "begins_with") keyConditions.push(`begins_with(${sortName}, ${sortValue})`);
        else keyConditions.push(`${sortName} ${operator} ${sortValue}`);
      }
      input.KeyConditionExpression = keyConditions.join(" AND ");
      input.ScanIndexForward = !$("#item-descending").checked;
    } else {
      const segment = $("#item-segment").value;
      const total = $("#item-total-segments").value;
      if (segment || total) {
        if (segment === "" || total === "") throw new Error("Parallel scan requires both segment and total segments");
        input.Segment = Number(segment); input.TotalSegments = Number(total);
      }
    }

    const expressions = filterExpressions(names, values);
    const rawFilter = $("#item-filter-expression").value.trim();
    if (rawFilter) expressions.push(`(${rawFilter})`);
    if (expressions.length) input.FilterExpression = expressions.join(" AND ");

    const mode = projectionMode.value;
    if (mode !== "all" && countOnly) throw new Error("Count only cannot be combined with an attribute projection");
    if (mode === "projected") input.Select = "ALL_PROJECTED_ATTRIBUTES";
    if (mode === "specific") {
      const projection = $("#item-projection").value.split(",").map(value => value.trim()).filter(Boolean);
      if (!projection.length) throw new Error("Enter at least one attribute name to project");
      input.ProjectionExpression = projection.map((attribute, position) => addName(names, attribute, `p${position}`)).join(", ");
    }
    if (Object.keys(names).length) input.ExpressionAttributeNames = names;
    if (Object.keys(values).length) input.ExpressionAttributeValues = values;
    return input;
  };

  const keyColumnNames = () => {
    const names = [];
    for (const key of [...table.KeySchema, ...(selectedIndex()?.KeySchema ?? [])]) if (!names.includes(key.AttributeName)) names.push(key.AttributeName);
    return names;
  };
  const columnsFor = items => {
    const keys = keyColumnNames().filter(name => items.some(item => name in item));
    const rest = [];
    for (const item of items) for (const name of Object.keys(item)) if (!keys.includes(name) && !rest.includes(name)) rest.push(name);
    return [...keys, ...rest];
  };
  const hasBaseKey = item => table.KeySchema.every(key => item[key.AttributeName]);
  const selectedItems = () => [...state.selected].sort((left, right) => left - right).map(index => state.items[index]).filter(Boolean);

  const cellMarkup = (item, name, index, column) => {
    const value = item[name];
    if (!value) return "<td></td>";
    if (column === 0 && hasBaseKey(item)) return `<td><a href="${itemPageHash(table.TableName, "edit", itemKey(table, item))}" data-item-edit-link>${escapeHtml(displayValue(value))}</a></td>`;
    const inline = hasBaseKey(item) && !tableKeyNames.has(name) && INLINE_EDIT_TYPES.has(typeOf(value));
    return `<td><span class="item-cell"><span>${escapeHtml(displayValue(value))}</span>${inline ? `<button type="button" class="item-cell-edit" data-inline-edit="${index}" data-attribute="${escapeHtml(name)}" aria-label="Edit ${escapeHtml(name)} of item ${index + 1}" title="Edit">✎</button>` : ""}</span></td>`;
  };
  const itemsTable = items => `<div class="table-wrap"><table class="items-data-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" id="items-select-all" aria-label="Select all items"></th>${state.columns.map(name => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${items.map((item, index) => `<tr><td class="checkbox-cell"><input type="checkbox" data-item-select="${index}" aria-label="Select item ${index + 1}"></td>${state.columns.map((name, column) => cellMarkup(item, name, index, column)).join("")}</tr>`).join("")}</tbody></table></div>`;

  const syncSelection = () => {
    const count = state.selected.size;
    const single = count === 1 && hasBaseKey(selectedItems()[0]);
    root.querySelectorAll("[data-item-menu]").forEach(button => {
      const action = button.dataset.itemMenu;
      button.disabled = action === "csv" ? !state.items.length : action === "delete" ? count === 0 : !single;
    });
    const all = root.querySelector("#items-select-all");
    if (all) { all.checked = count > 0 && count === state.items.length; all.indeterminate = count > 0 && count < state.items.length; }
  };

  const renderResults = () => {
    const result = state.result;
    if (!result) return;
    const items = result.Items ?? [];
    state.items = items; state.selected.clear(); state.columns = columnsFor(items);
    const countOnly = state.countOnly;
    $("#items-returned-count").textContent = `(${countOnly ? result.Count ?? 0 : items.length})`;
    const capacity = result.ConsumedCapacity?.CapacityUnits ?? 0;
    $("#item-result-summary").innerHTML = `<div class="alert success card-inset item-run-summary" role="status"><strong>Completed.</strong> Read capacity units consumed: ${escapeHtml(formatCapacity(capacity))}</div>`;
    const warning = state.operation === "scan" ? `<div class="alert warning card-inset"><strong>Scan reads every evaluated item</strong><br>This page evaluated ${Number(result.ScannedCount ?? 0).toLocaleString()} items to return ${Number(result.Count ?? 0).toLocaleString()}. Use Query with a partition key whenever the access pattern allows it; filters reduce returned items, not read work.</div>` : "";
    const view = $("#item-results-view").value;
    let body;
    if (countOnly) body = emptyState("#", `${result.Count ?? 0} matching items`, `${result.ScannedCount ?? 0} items were evaluated on this page.`);
    else if (!items.length) body = emptyState("◇", "No items returned", "Change the key condition or filters, or create an item.");
    else if (view === "dynamodb") body = `<pre class="code-box item-json-results">${escapeHtml(JSON.stringify(items, null, 2))}</pre>`;
    else if (view === "plain") body = `<pre class="code-box item-json-results">${escapeHtml(JSON.stringify(items.map(plainItem), null, 2))}</pre>`;
    else body = itemsTable(items);
    root.querySelector("#items-table").innerHTML = `${warning}${body}<div class="card-body item-pagination"><span class="muted" id="items-page-label">Page ${state.page + 1}</span><div class="actions"><button class="button" id="items-previous" ${state.page === 0 ? "disabled" : ""}>Previous</button><button class="button" id="items-next" ${result.LastEvaluatedKey ? "" : "disabled"}>Next</button></div></div>`;
    $("#items-previous").addEventListener("click", () => runPage(state.page - 1));
    $("#items-next").addEventListener("click", () => { state.tokens[state.page + 1] = result.LastEvaluatedKey; runPage(state.page + 1); });
    root.querySelectorAll("[data-item-select]").forEach(box => box.addEventListener("change", () => {
      const index = Number(box.dataset.itemSelect);
      if (box.checked) state.selected.add(index); else state.selected.delete(index);
      syncSelection();
    }));
    root.querySelector("#items-select-all")?.addEventListener("change", event => {
      const checked = event.target.checked;
      root.querySelectorAll("[data-item-select]").forEach(box => { box.checked = checked; });
      state.selected = new Set(checked ? state.items.map((_, index) => index) : []);
      syncSelection();
    });
    root.querySelectorAll("[data-item-edit-link]").forEach(link => link.addEventListener("click", saveExplorerState));
    root.querySelectorAll("[data-inline-edit]").forEach(button => button.addEventListener("click", () => inlineEdit(Number(button.dataset.inlineEdit), button.dataset.attribute)));
    syncSelection();
  };

  const runPage = async (pageIndex = 0) => {
    if (state.running || pageIndex < 0) return;
    state.running = true; $("#run-items").disabled = true;
    root.querySelector("#items-table").innerHTML = '<div class="loading" role="status"><span></span>Reading a bounded page…</div>';
    try {
      const input = requestInput(pageIndex);
      const operation = operationValue();
      const result = await dynamo(operation === "query" ? "Query" : "Scan", input);
      if (!root.isConnected) return;
      state.operation = operation; state.countOnly = input.Select === "COUNT"; state.result = result; state.page = pageIndex; state.hasRun = true;
      renderResults();
      saveExplorerState();
    } catch (error) {
      if (!root.isConnected) return;
      showError(error);
      state.items = []; state.selected.clear(); syncSelection();
      $("#items-returned-count").textContent = "";
      $("#item-result-summary").innerHTML = "";
      root.querySelector("#items-table").innerHTML = `<div class="alert error card-inset" role="alert"><strong>${escapeHtml(error.code ?? "Request error")}</strong><br>${escapeHtml(error.message)}</div>`;
    } finally {
      state.running = false;
      if (root.isConnected) $("#run-items").disabled = false;
    }
  };

  const inlineEdit = (index, name) => {
    const item = state.items[index]; const value = item?.[name];
    if (!value) return;
    const type = typeOf(value); const id = nextId("item-inline-edit");
    const control = type === "BOOL"
      ? `<select id="${id}" name="value"><option value="true" ${value.BOOL ? "selected" : ""}>True</option><option value="false" ${value.BOOL ? "" : "selected"}>False</option></select>`
      : `<input id="${id}" name="value" value="${escapeHtml(String(value[type]))}" ${type === "N" ? 'inputmode="decimal"' : ""}>`;
    showModal(`Edit ${TYPE_LABELS[type]}`, `<div class="field"><label for="${id}">${escapeHtml(name)}</label>${control}<span class="hint">Saves with UpdateItem (SET) on the base-table item.</span></div>`, "Save", async data => {
      const raw = String(data.get("value") ?? "");
      await dynamo("UpdateItem", {
        TableName: table.TableName, Key: itemKey(table, item),
        UpdateExpression: "SET #attribute = :value", ConditionExpression: "attribute_exists(#partitionKey)",
        ExpressionAttributeNames: { "#attribute": name, "#partitionKey": hashName },
        ExpressionAttributeValues: { ":value": type === "BOOL" ? { BOOL: raw === "true" } : { [type]: raw } },
      });
      toast("Item updated");
      void runPage(state.page);
    }, false, { refreshAfterSubmit: false });
  };

  const deleteSelected = () => {
    const items = selectedItems();
    if (!items.length) return;
    if (!items.every(hasBaseKey)) { showError(new Error("The selected projection does not include every table key attribute. Choose All attributes and run the request again.")); return; }
    const keys = items.map(item => itemKey(table, item));
    const many = keys.length > 1;
    showModal(many ? "Delete items" : "Delete item", `<p>Are you sure you want to delete ${many ? `these ${keys.length} items` : "this item"}? You can't undo this action.</p><ul class="item-delete-list">${keys.slice(0, 10).map(key => `<li class="mono">${escapeHtml(keyLabel(key))}</li>`).join("")}${keys.length > 10 ? `<li>…and ${keys.length - 10} more</li>` : ""}</ul>`, "Delete", async () => {
      const failures = [];
      for (const key of keys) {
        try { await dynamo("DeleteItem", { TableName: table.TableName, Key: key }); }
        catch (error) { failures.push(error); }
      }
      const deleted = keys.length - failures.length;
      if (deleted) toast(deleted === 1 ? "Item deleted" : `${deleted} items deleted`);
      if (failures.length) showError(new Error(`${failures.length} of ${keys.length} items could not be deleted: ${failures[0].message}`));
      void runPage(state.page);
    }, false, { danger: true, refreshAfterSubmit: false });
  };

  const queryForSelected = () => {
    const item = selectedItems()[0];
    if (!item) return;
    const hash = table.KeySchema.find(key => key.KeyType === "HASH");
    const sort = table.KeySchema.find(key => key.KeyType === "RANGE");
    setOperation("query"); indexSelect.value = "";
    $("#query-key").value = scalarText(item[hash.AttributeName]);
    $("#query-sort-operator").value = "=";
    $("#query-sort-value").value = sort ? scalarText(item[sort.AttributeName]) : "";
    $("#query-sort-value-2").value = "";
    updateControls(); resetPaging(); void runPage(0);
  };

  const downloadCsv = () => {
    const items = state.selected.size ? selectedItems() : state.items;
    const cell = text => /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    const lines = [state.columns.map(cell).join(","), ...items.map(item => state.columns.map(name => cell(displayValue(item[name]))).join(","))];
    const url = URL.createObjectURL(new Blob([`${lines.join("\r\n")}\r\n`], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${table.TableName}-items.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  root.querySelectorAll("[data-item-menu]").forEach(button => button.addEventListener("click", () => {
    $("#item-actions").open = false;
    const action = button.dataset.itemMenu;
    if (action === "delete") { deleteSelected(); return; }
    if (action === "csv") { downloadCsv(); return; }
    if (action === "query") { queryForSelected(); return; }
    const item = selectedItems()[0];
    if (!item) return;
    saveExplorerState();
    location.hash = itemPageHash(table.TableName, action, itemKey(table, item));
  }));

  function snapshot() {
    return {
      operation: operationValue(), index: indexSelect.value, projectionMode: projectionMode.value, projection: $("#item-projection").value,
      queryKey: $("#query-key").value, sortOperator: $("#query-sort-operator").value, sortValue: $("#query-sort-value").value, sortValue2: $("#query-sort-value-2").value, descending: $("#item-descending").checked,
      filters: [...filterRoot.querySelectorAll("[data-filter-row]")].map(row => ({ name: row.querySelector("[data-filter-name]").value, condition: row.querySelector("[data-filter-condition]").value, type: row.querySelector("[data-filter-type]").value, value: row.querySelector("[data-filter-value]").value, value2: row.querySelector("[data-filter-value-2]").value, bool: row.querySelector("[data-filter-bool]").value })),
      limit: $("#item-limit").value, resultsView: $("#item-results-view").value, consistent: $("#item-consistent").checked, countOnly: $("#item-count-only").checked,
      segment: $("#item-segment").value, total: $("#item-total-segments").value, rawFilter: $("#item-filter-expression").value, names: $("#item-expression-names").value, values: $("#item-expression-values").value,
      tokens: state.tokens.slice(), page: state.page, hasRun: state.hasRun,
    };
  }
  function saveExplorerState() { explorerStates.set(table.TableName, snapshot()); }
  const restore = saved => {
    setOperation(saved.operation);
    indexSelect.value = indexes.some(index => index.IndexName === saved.index) ? saved.index : "";
    projectionMode.value = saved.projectionMode; $("#item-projection").value = saved.projection;
    $("#query-key").value = saved.queryKey; $("#query-sort-operator").value = saved.sortOperator; $("#query-sort-value").value = saved.sortValue; $("#query-sort-value-2").value = saved.sortValue2; $("#item-descending").checked = saved.descending;
    filterRoot.innerHTML = ""; (saved.filters.length ? saved.filters : [{}]).forEach(addFilterRow);
    $("#item-limit").value = saved.limit; $("#item-results-view").value = saved.resultsView; $("#item-consistent").checked = saved.consistent; $("#item-count-only").checked = saved.countOnly;
    $("#item-segment").value = saved.segment; $("#item-total-segments").value = saved.total; $("#item-filter-expression").value = saved.rawFilter; $("#item-expression-names").value = saved.names; $("#item-expression-values").value = saved.values;
    state.tokens = saved.tokens.slice(); state.page = saved.page;
    updateControls();
  };

  function invalidatePaging() {
    resetPaging();
    root.querySelector("#items-previous")?.setAttribute("disabled", "");
    root.querySelector("#items-next")?.setAttribute("disabled", "");
    if (state.result) {
      const label = root.querySelector("#items-page-label");
      if (label) label.textContent = "Request settings changed. Run again before paging.";
    }
  }

  document.querySelectorAll('input[name="item-operation"]').forEach(radio => radio.addEventListener("change", () => { invalidatePaging(); updateControls(); }));
  indexSelect.addEventListener("change", () => { invalidatePaging(); updateControls(); });
  projectionMode.addEventListener("change", () => { invalidatePaging(); updateControls(); });
  $("#query-sort-operator").addEventListener("change", updateControls);
  $("#item-results-view").addEventListener("change", renderResults);
  document.querySelectorAll("#query-key,#query-sort-operator,#query-sort-value,#query-sort-value-2,#item-projection,#item-limit,#item-filter-expression,#item-expression-names,#item-expression-values,#item-consistent,#item-descending,#item-count-only,#item-segment,#item-total-segments").forEach(control => {
    control.addEventListener(control.matches("input[type=checkbox],select") ? "change" : "input", invalidatePaging);
  });
  $("#add-item-filter").addEventListener("click", () => { addFilterRow().querySelector("[data-filter-name]").focus(); invalidatePaging(); });
  $("#run-items").addEventListener("click", () => { resetPaging(); void runPage(0); });
  $("#reset-items").addEventListener("click", () => {
    explorerStates.delete(table.TableName);
    for (const id of ["#query-key", "#query-sort-value", "#query-sort-value-2", "#item-projection", "#item-filter-expression", "#item-segment", "#item-total-segments"]) $(id).value = "";
    setOperation("scan"); indexSelect.value = ""; projectionMode.value = "all"; $("#query-sort-operator").value = "=";
    $("#item-limit").value = "25"; $("#item-results-view").value = "table"; $("#item-expression-names").value = "{}"; $("#item-expression-values").value = "{}";
    for (const id of ["#item-consistent", "#item-descending", "#item-count-only"]) $(id).checked = false;
    filterRoot.innerHTML = ""; addFilterRow();
    state.result = undefined; state.items = []; state.columns = []; state.selected.clear(); state.hasRun = false; resetPaging(); updateControls(); syncSelection();
    $("#items-returned-count").textContent = "";
    $("#item-result-summary").innerHTML = "";
    root.querySelector("#items-table").innerHTML = emptyState("◇", "No request has run", "Choose Scan or Query, then choose Run.");
  });
  root.querySelectorAll('[data-action="create-item"]').forEach(link => link.addEventListener("click", saveExplorerState));
  autopreview.addEventListener("change", () => {
    try { localStorage.setItem(AUTOPREVIEW_KEY, String(autopreview.checked)); } catch { /* storage unavailable */ }
    if (autopreview.checked && !state.hasRun) { resetPaging(); void runPage(0); }
  });

  const saved = explorerStates.get(table.TableName);
  if (saved) {
    restore(saved);
    if (saved.hasRun) void runPage(saved.page);
  } else {
    addFilterRow(); updateControls();
    if (autopreview.checked) void runPage(0);
  }
}

export async function dynamoItemEditorPage(context, tableName, mode, encodedKey) {
  const { main, setChrome, showError, toast } = context;
  const titles = { create: "Create item", edit: "Edit item", duplicate: "Duplicate item" };
  setChrome("dynamodb", ["DynamoDB", "Tables", tableName, titles[mode]]);
  const backHash = itemsHash(tableName);
  const table = (await dynamo("DescribeTable", { TableName: tableName })).Table;
  const keyNames = table.KeySchema.map(key => key.AttributeName);
  const hashName = table.KeySchema.find(key => key.KeyType === "HASH").AttributeName;
  let source = {};
  let originalKey;
  if (mode !== "create") {
    let key;
    try { key = decodeKey(encodedKey ?? ""); } catch { key = undefined; }
    const result = key ? await dynamo("GetItem", { TableName: tableName, Key: key, ConsistentRead: true }) : {};
    if (!result.Item) {
      main.innerHTML = `<div class="page-width">${pageHeader(titles[mode], escapeHtml(tableName))}<section class="card">${emptyState("◇", "Item not found", "The item no longer exists or the link is not valid. Return to Explore items and run the request again.", `<a class="button" href="${backHash}">Back to Explore items</a>`)}</section></div>`;
      return;
    }
    source = result.Item;
    originalKey = itemKey(table, source);
  }
  const keyRole = name => table.KeySchema.find(key => key.AttributeName === name)?.KeyType === "HASH" ? "Partition key" : "Sort key";
  const initial = mode === "create" ? Object.fromEntries(keyNames.map(name => [name, emptyAttribute(attributeType(table, name))])) : structuredClone(source);
  const description = mode === "edit"
    ? "Change attribute values, add attributes, or remove them. Primary key values can't be changed; use Duplicate item to create an item with a new key."
    : mode === "duplicate"
      ? "The new item starts as a copy of the selected item, including its key values. Change the key values, then create the item."
      : "Enter the primary key values, then add any other attributes.";
  main.innerHTML = `<div class="page-width">${pageHeader(titles[mode], escapeHtml(description))}<form id="item-editor-form" novalidate><section class="card"><div class="card-header"><div><h2>Attributes</h2><p class="muted small">Table: <span class="mono">${escapeHtml(tableName)}</span></p></div>`
    + `<div class="item-editor-switcher"><div class="segmented-control" role="group" aria-label="Editor view"><button type="button" class="active" data-item-editor-view="form" aria-pressed="true">Form</button><button type="button" data-item-editor-view="json" aria-pressed="false">JSON view</button></div><label class="checkbox-label item-json-format" hidden><input type="checkbox" id="item-view-dynamodb-json" checked> View DynamoDB JSON</label></div></div>`
    + `<div class="card-body"><div class="alert error" id="item-editor-error" role="alert" hidden></div>`
    + `<div id="item-form-editor"><div class="attr-header" aria-hidden="true"><span>Attribute name</span><span>Value</span><span>Type</span><span></span></div><div id="attribute-rows"></div><div class="item-editor-add">${addAttributeMenu("top", "Add new attribute")}</div></div>`
    + `<div class="field" id="item-json-editor" hidden><label for="item-json-text">DynamoDB JSON</label><textarea id="item-json-text" class="code-editor item-json-editor" spellcheck="false"></textarea></div>`
    + `<div class="field" id="item-plain-editor" hidden><label for="item-plain-text">Plain JSON</label><textarea id="item-plain-text" class="code-editor item-json-editor" spellcheck="false"></textarea><span class="hint">Number, binary, and set types already in the item are preserved. Use DynamoDB JSON to change an attribute's type.</span></div></div></section>`
    + `<div class="actions page-actions"><a class="button" href="${backHash}">Cancel</a><button class="button primary" type="submit" id="item-editor-submit">${mode === "edit" ? "Save and close" : "Create item"}</button></div></form></div>`;

  const $ = selector => document.querySelector(selector);
  const form = $("#item-editor-form");
  const rowsRoot = $("#attribute-rows");
  const errorRoot = $("#item-editor-error");
  const markDirty = () => setDirty(true, "page");
  const renderForm = item => {
    const ordered = [...keyNames.map(name => [name, item[name] ?? emptyAttribute(attributeType(table, name))]), ...Object.entries(item).filter(([name]) => !keyNames.includes(name))];
    rowsRoot.innerHTML = ordered.map(([name, value]) => attributeNode(name, value, keyNames.includes(name) ? { keyRole: keyRole(name), valueReadonly: mode === "edit" } : {})).join("");
  };
  const readForm = () => {
    const item = {};
    for (const node of rowsRoot.querySelectorAll(":scope > .attr-node")) {
      const name = node.querySelector(":scope > .attr-row [data-attribute-name]").value;
      if (!name) throw new Error("Enter a name for every attribute");
      if (Object.prototype.hasOwnProperty.call(item, name)) throw new Error(`The item has more than one attribute named ${name}`);
      item[name] = readNode(node, name);
    }
    return item;
  };
  let hints = attributeTypeHints(initial);
  let activeMode = "form";
  const readMode = current => {
    if (current === "json") {
      const parsed = JSON.parse($("#item-json-text").value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DynamoDB JSON must be an object of attribute values");
      return parsed;
    }
    if (current === "plain") {
      const parsed = JSON.parse($("#item-plain-text").value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Plain JSON must be an object");
      return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, toAttribute(value, pathPart("", name), hints)]));
    }
    return readForm();
  };
  const writeMode = (next, item) => {
    if (next === "json") $("#item-json-text").value = JSON.stringify(item, null, 2);
    else if (next === "plain") $("#item-plain-text").value = JSON.stringify(plainItem(item), null, 2);
    else renderForm(item);
  };
  const showEditorError = error => {
    errorRoot.hidden = false;
    errorRoot.innerHTML = `<strong>${escapeHtml(error.code ?? "Error")}</strong><br>${escapeHtml(error.message)}`;
  };
  const formButton = form.querySelector('[data-item-editor-view="form"]');
  const jsonButton = form.querySelector('[data-item-editor-view="json"]');
  const jsonFormat = form.querySelector(".item-json-format");
  const dynamodbJson = $("#item-view-dynamodb-json");
  const switchMode = next => {
    if (next === activeMode) return;
    let item;
    try { item = readMode(activeMode); } catch (error) { showEditorError(error); syncSwitcher(); return; }
    errorRoot.hidden = true;
    hints = attributeTypeHints(item);
    writeMode(next, item);
    activeMode = next;
    $("#item-form-editor").hidden = next !== "form";
    $("#item-json-editor").hidden = next !== "json";
    $("#item-plain-editor").hidden = next !== "plain";
    syncSwitcher();
  };
  function syncSwitcher() {
    const formMode = activeMode === "form";
    formButton.classList.toggle("active", formMode); jsonButton.classList.toggle("active", !formMode);
    formButton.setAttribute("aria-pressed", String(formMode)); jsonButton.setAttribute("aria-pressed", String(!formMode));
    jsonFormat.hidden = formMode;
    dynamodbJson.checked = activeMode !== "plain";
  }
  formButton.addEventListener("click", () => switchMode("form"));
  jsonButton.addEventListener("click", () => switchMode(dynamodbJson.checked ? "json" : "plain"));
  dynamodbJson.addEventListener("change", () => switchMode(dynamodbJson.checked ? "json" : "plain"));

  form.addEventListener("click", event => {
    const addType = event.target.closest("[data-add-type]");
    if (addType) {
      const menu = addType.closest(".item-add-menu"); menu.open = false;
      const scope = menu.dataset.addScope;
      const parent = scope === "top" ? undefined : menu.closest(".attr-node");
      const container = parent ? parent.querySelector(":scope > [data-children]") : rowsRoot;
      const options = scope === "list" ? { listIndex: container.children.length } : {};
      container.insertAdjacentHTML("beforeend", attributeNode("", emptyAttribute(addType.dataset.addType), options));
      if (parent) { parent.classList.remove("collapsed"); syncToggle(parent); refreshSummary(parent); }
      const added = container.lastElementChild;
      (added.querySelector("[data-attribute-name]") ?? added.querySelector("[data-attribute-value], [data-set-value]"))?.focus();
      markDirty();
      return;
    }
    const remove = event.target.closest("[data-remove-attribute]");
    if (remove) {
      const node = remove.closest(".attr-node"); const container = node.parentElement; const parent = container.closest(".attr-node");
      node.remove();
      if (parent?.dataset.attrType === "L") container.querySelectorAll(":scope > .attr-node > .attr-row [data-list-index]").forEach((label, index) => { label.textContent = String(index); });
      if (parent) refreshSummary(parent);
      markDirty();
      return;
    }
    const toggle = event.target.closest("[data-toggle-node]");
    if (toggle) { const node = toggle.closest(".attr-node"); node.classList.toggle("collapsed"); syncToggle(node); return; }
    const addSetValue = event.target.closest("[data-add-set-value]");
    if (addSetValue) { addSetValue.insertAdjacentHTML("beforebegin", setValueRow("")); addSetValue.previousElementSibling.querySelector("input").focus(); markDirty(); return; }
    const removeSetValue = event.target.closest("[data-remove-set-value]");
    if (removeSetValue) { removeSetValue.closest(".attr-set-value").remove(); markDirty(); }
  });
  form.addEventListener("input", event => {
    markDirty();
    if (event.target.matches("[data-attribute-name]")) {
      const toggle = event.target.closest(".attr-name")?.querySelector("[data-toggle-node]");
      if (toggle) { toggle.dataset.nodeLabel = event.target.value || "new attribute"; syncToggle(toggle.closest(".attr-node")); }
    }
  });
  form.addEventListener("change", event => { if (event.target !== dynamodbJson) markDirty(); });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = $("#item-editor-submit");
    submit.disabled = true; errorRoot.hidden = true;
    try {
      const item = readMode(activeMode);
      if (originalKey && mode === "edit" && !sameItemKey(table, item, originalKey)) throw new Error("Primary key values can't be changed while editing. Use Duplicate item to create an item with a new key.");
      const put = { TableName: tableName, Item: item };
      if (mode !== "edit") { put.ConditionExpression = "attribute_not_exists(#primaryKey)"; put.ExpressionAttributeNames = { "#primaryKey": hashName }; }
      try { await dynamo("PutItem", put); }
      catch (error) {
        if (mode !== "edit" && error.code === "ConditionalCheckFailedException") { error.message = `An item with this primary key already exists. ${error.message}`; }
        throw error;
      }
      setDirty(false, "page");
      toast(mode === "edit" ? "Item updated" : "Item created");
      location.hash = backHash;
    } catch (error) {
      showEditorError(error); showError(error);
      submit.disabled = false;
    }
  });

  renderForm(initial);
  rowsRoot.querySelector("[data-key-attribute] [data-attribute-value]:not([readonly])")?.focus();
}

function addAttributeMenu(scope, label) {
  return `<details class="actions-menu item-add-menu" data-add-scope="${scope}"><summary class="button" aria-haspopup="menu">${escapeHtml(label)} ▾</summary><div class="menu" role="menu">${ATTRIBUTE_TYPES.map(([type, typeLabel]) => `<button type="button" role="menuitem" data-add-type="${type}">${typeLabel}</button>`).join("")}</div></details>`;
}

function setValueRow(value) {
  return `<div class="attr-set-value"><input data-set-value aria-label="Set value" value="${escapeHtml(value)}"><button type="button" class="button link" data-remove-set-value aria-label="Remove set value">Remove</button></div>`;
}

function countLabel(type, count) {
  return type === "M" ? `${count} ${count === 1 ? "attribute" : "attributes"}` : `${count} ${count === 1 ? "element" : "elements"}`;
}
function nestedSummary(type, raw) { return countLabel(type, type === "M" ? Object.keys(raw).length : raw.length); }

function refreshSummary(node) {
  const summary = node.querySelector(":scope > .attr-row [data-nested-summary]");
  if (summary) summary.textContent = countLabel(node.dataset.attrType, node.querySelectorAll(":scope > [data-children] > .attr-node").length);
}

function syncToggle(node) {
  const toggle = node.querySelector(":scope > .attr-row [data-toggle-node]");
  if (!toggle) return;
  const collapsed = node.classList.contains("collapsed");
  toggle.textContent = collapsed ? "▸" : "▾";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${toggle.dataset.nodeLabel}`);
}

function attributeNode(name, value, { keyRole, valueReadonly = false, listIndex } = {}) {
  const [type, raw] = Object.entries(value ?? { S: "" })[0];
  const nested = type === "M" || type === "L";
  const label = listIndex !== undefined ? `element ${listIndex}` : name || "new attribute";
  const valueLabel = keyRole ? `${name} value` : listIndex !== undefined ? `Element ${listIndex} value` : "Attribute value";
  const nameControl = listIndex !== undefined
    ? `<span class="attr-list-index mono" data-list-index>${listIndex}</span>`
    : `<input data-attribute-name aria-label="Attribute name" value="${escapeHtml(name)}" placeholder="Enter attribute name" ${keyRole ? "readonly" : ""}>`;
  let valueControl;
  if (type === "BOOL") valueControl = `<select data-attribute-value aria-label="${escapeHtml(valueLabel)}"><option value="true" ${raw ? "selected" : ""}>True</option><option value="false" ${raw ? "" : "selected"}>False</option></select>`;
  else if (type === "NULL") valueControl = '<span class="muted" data-null-value>Null</span>';
  else if (SET_TYPES.has(type)) valueControl = `<div class="attr-set" data-set-values>${(raw.length ? raw : [""]).map(setValueRow).join("")}<button type="button" class="button link" data-add-set-value>Add value</button></div>`;
  else if (nested) valueControl = `<span class="muted small" data-nested-summary>${nestedSummary(type, raw)}</span>`;
  else valueControl = `<input data-attribute-value aria-label="${escapeHtml(valueLabel)}" value="${escapeHtml(String(raw ?? ""))}" ${type === "N" ? 'inputmode="decimal"' : ""} ${type === "B" ? 'placeholder="Base64-encoded value"' : ""} ${valueReadonly ? "readonly" : ""}>`;
  const toggle = nested ? `<button type="button" class="attr-toggle" data-toggle-node data-node-label="${escapeHtml(label)}" aria-expanded="true" aria-label="Collapse ${escapeHtml(label)}">▾</button>` : '<span class="attr-toggle-spacer" aria-hidden="true"></span>';
  const children = type === "M" ? Object.entries(raw).map(([childName, child]) => attributeNode(childName, child)).join("") : type === "L" ? raw.map((child, index) => attributeNode("", child, { listIndex: index })).join("") : "";
  return `<div class="attr-node" data-attr-type="${type}" ${keyRole ? "data-key-attribute" : ""}><div class="attr-row"><div class="attr-name">${toggle}${nameControl}</div><div class="attr-value">${valueControl}</div><div class="attr-type"><span>${TYPE_LABELS[type] ?? escapeHtml(type)}</span>${keyRole ? `<span class="type-tag">${keyRole}</span>` : ""}</div><div class="attr-remove">${keyRole ? "" : '<button type="button" class="button link" data-remove-attribute>Remove</button>'}</div></div>`
    + (nested ? `<div class="attr-children" data-children>${children}</div><div class="attr-add-child">${addAttributeMenu(type === "M" ? "map" : "list", type === "M" ? "Add attribute to map" : "Add element to list")}</div>` : "")
    + "</div>";
}

function readNode(node, path) {
  const type = node.dataset.attrType;
  const row = node.querySelector(":scope > .attr-row");
  if (type === "BOOL") return { BOOL: row.querySelector("[data-attribute-value]").value === "true" };
  if (type === "NULL") return { NULL: true };
  if (SET_TYPES.has(type)) return { [type]: [...row.querySelectorAll("[data-set-value]")].map(input => input.value) };
  const children = [...node.querySelectorAll(":scope > [data-children] > .attr-node")];
  if (type === "M") {
    const entries = {};
    for (const child of children) {
      const name = child.querySelector(":scope > .attr-row [data-attribute-name]").value;
      if (!name) throw new Error(`Enter a name for every attribute in map ${path}`);
      if (Object.prototype.hasOwnProperty.call(entries, name)) throw new Error(`Map ${path} has more than one attribute named ${name}`);
      entries[name] = readNode(child, `${path}.${name}`);
    }
    return { M: entries };
  }
  if (type === "L") return { L: children.map((child, index) => readNode(child, `${path}[${index}]`)) };
  return { [type]: row.querySelector("[data-attribute-value]").value };
}

function emptyAttribute(type) {
  if (type === "BOOL") return { BOOL: false };
  if (type === "NULL") return { NULL: true };
  if (SET_TYPES.has(type)) return { [type]: [] };
  if (type === "M") return { M: {} };
  if (type === "L") return { L: [] };
  return { [type]: "" };
}

function encodeKey(key) {
  const bytes = new TextEncoder().encode(JSON.stringify(key));
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeKey(text) {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "===".slice((base64.length + 3) % 4));
  const key = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
  if (!key || typeof key !== "object" || Array.isArray(key)) throw new Error("Invalid item key");
  return key;
}
function typeOf(value) { return Object.keys(value ?? {})[0]; }
function scalarText(value) { const type = typeOf(value); return type ? String(value[type]) : ""; }
function keyLabel(key) { return Object.entries(key).map(([name, value]) => `${name}: ${displayValue(value)}`).join(", "); }
function formatCapacity(value) { const number = Number(value); return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : "0"; }
function displayValue(value) {
  if (!value) return "";
  const [type, raw] = Object.entries(value)[0];
  if (type === "BOOL") return raw ? "true" : "false";
  if (type === "NULL") return "null";
  if (["S", "N", "B"].includes(type)) return String(raw);
  if (SET_TYPES.has(type)) return JSON.stringify(raw);
  return JSON.stringify(plainAttribute(value));
}
function pathPart(parent, value) { return `${parent}/${String(value).replaceAll("~", "~0").replaceAll("/", "~1")}`; }
function attributeTypeHints(item) {
  const hints = {};
  const visit = (value, path) => {
    const [type, raw] = Object.entries(value ?? {})[0] ?? [];
    if (["N", "B", "SS", "NS", "BS"].includes(type)) hints[path] = type;
    if (type === "M") for (const [name, child] of Object.entries(raw)) visit(child, pathPart(path, name));
    if (type === "L") raw.forEach((child, index) => visit(child, pathPart(path, index)));
  };
  for (const [name, value] of Object.entries(item)) visit(value, pathPart("", name));
  return hints;
}
function toAttribute(value, path = "", hints = {}) {
  const hinted = hints[path];
  if (hinted === "N") return { N: String(value) };
  if (hinted === "B") return { B: String(value) };
  if (SET_TYPES.has(hinted)) { if (!Array.isArray(value)) throw new Error(`${path || "Value"} must remain an array to preserve its ${hinted} type`); return { [hinted]: value.map(String) }; }
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map((child, index) => toAttribute(child, pathPart(path, index), hints)) };
  if (value && typeof value === "object") return { M: Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toAttribute(child, pathPart(path, name), hints)])) };
  throw new Error("Plain JSON contains an unsupported value");
}
function itemKey(table, item) { return Object.fromEntries(table.KeySchema.map(key => [key.AttributeName, item[key.AttributeName]])); }
function attributeType(table, name) { return table.AttributeDefinitions.find(attribute => attribute.AttributeName === name)?.AttributeType ?? "S"; }
function typedValue(type, value) { return type === "N" ? { N: String(value) } : type === "B" ? { B: String(value) } : { S: String(value) }; }
function plainItem(item) { return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, plainAttribute(value)])); }
function plainAttribute(value) {
  if (!value) return null; if ("S" in value) return value.S; if ("N" in value) { const digits = value.N.replace(/[^0-9]/g, "").replace(/^0+/, "").length; return digits <= 15 ? Number(value.N) : value.N; } if ("B" in value) return value.B; if ("BOOL" in value) return value.BOOL; if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(plainAttribute); if ("M" in value) return Object.fromEntries(Object.entries(value.M).map(([name, child]) => [name, plainAttribute(child)]));
  for (const type of ["SS", "NS", "BS"]) if (type in value) return type === "NS" ? value[type].map(number => number.replace(/[^0-9]/g, "").replace(/^0+/, "").length <= 15 ? Number(number) : number) : value[type]; return value;
}
function canonicalNumber(value) { const match = String(value).toLowerCase().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/); if (!match) return String(value); const negative = match[1] === "-"; const fraction = match[3] ?? ""; let digits = `${match[2] || "0"}${fraction}`.replace(/^0+/, "") || "0"; let exponent = Number(match[4] ?? 0) - fraction.length; while (digits.length > 1 && digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; } return `${negative && digits !== "0" ? "-" : ""}${digits}e${exponent}`; }
function sameItemKey(table, item, original) { return table.KeySchema.every(key => { const left = item[key.AttributeName]; const right = original[key.AttributeName]; if (!left || !right) return false; const leftType = Object.keys(left)[0]; const rightType = Object.keys(right)[0]; if (leftType !== rightType) return false; return leftType === "N" ? canonicalNumber(left.N) === canonicalNumber(right.N) : JSON.stringify(left) === JSON.stringify(right); }); }
