import { dynamo } from "../api-client.js";
import { renderHighlightedCode } from "../code-format.js";
import { emptyState, escapeHtml } from "../components.js";

let attributeRowId = 0;

const attributeTypes = [["S", "String"], ["N", "Number"], ["B", "Binary"], ["BOOL", "Boolean"], ["NULL", "Null"], ["M", "Map (DynamoDB JSON)"], ["L", "List (DynamoDB JSON)"], ["SS", "String set"], ["NS", "Number set"], ["BS", "Binary set"]];

export async function enhancedDynamoItemsView(table) {
  const indexes = [
    ...(table.LocalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "LSI" })),
    ...(table.GlobalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "GSI" })),
  ];
  return `<section class="card"><div class="card-header"><div><h2>Scan or query items</h2><p class="muted small">Use key conditions for targeted reads and filters for result refinement.</p></div></div><div class="card-body"><div class="field-row item-primary-controls"><div class="field"><label>Operation</label><select id="item-operation"><option value="scan">Scan</option><option value="query">Query</option></select></div><div class="field"><label>Table or index</label><select id="item-index"><option value="">Table – ${escapeHtml(table.TableName)}</option>${indexes.map(index => `<option value="${escapeHtml(index.IndexName)}" data-index-kind="${index.kind}">${index.kind} – ${escapeHtml(index.IndexName)}</option>`).join("")}</select></div><div class="field"><label>Page size</label><select id="item-limit"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></div></div><div id="item-query-controls" hidden><div class="field-row"><div class="field"><label id="query-key-label" for="query-key">Partition key value</label><input id="query-key" placeholder="Required for Query"></div><div class="field"><label id="query-key-type-label" for="query-key-type">Partition key type</label><select id="query-key-type" disabled>${attributeTypes.slice(0, 3).map(([type, label]) => `<option value="${type}">${label}</option>`).join("")}</select></div></div><div id="item-sort-controls" hidden><div class="field-row"><div class="field"><label id="query-sort-operator-label" for="query-sort-operator">Sort key condition</label><select id="query-sort-operator"><option value="">Any sort key</option><option value="=">Equals</option><option value="<">Less than</option><option value="<=">Less than or equal</option><option value=">">Greater than</option><option value=">=">Greater than or equal</option><option value="BETWEEN">Between</option><option value="begins_with">Begins with</option></select></div><div class="field"><label id="query-sort-value-label" for="query-sort-value">Sort key value</label><input id="query-sort-value"><input id="query-sort-value-2" aria-label="Second sort key value" placeholder="Upper value for Between" hidden></div></div></div></div><details class="item-query-options"><summary>Filters and additional settings</summary><div class="card-body compact-card-body"><h3>Guided filter</h3><div class="field-row item-filter-controls"><div class="field"><label>Attribute name</label><input id="item-filter-name" placeholder="For example: title"></div><div class="field"><label>Condition</label><select id="item-filter-operator"><option value="contains">Contains</option><option value="=">Equals</option><option value="<>">Not equal</option><option value="<">Less than</option><option value="<=">Less than or equal</option><option value=">">Greater than</option><option value=">=">Greater than or equal</option><option value="BETWEEN">Between</option><option value="begins_with">Begins with</option><option value="attribute_exists">Attribute exists</option><option value="attribute_not_exists">Attribute does not exist</option></select></div><div class="field"><label>Value type</label><select id="item-filter-type">${attributeTypes.slice(0, 3).map(([type, label]) => `<option value="${type}">${label}</option>`).join("")}</select></div><div class="field"><label>Filter value</label><input id="item-filter-value"><input id="item-filter-value-2" aria-label="Second filter value" placeholder="Upper value for Between" hidden></div></div><h3>Raw filter expression</h3><div class="field"><label>Filter expression</label><input id="item-filter-expression" class="mono" placeholder="contains(#title, :needle) AND attribute_exists(#active)"><span class="hint">The guided and raw filters are combined with AND. Filters run after DynamoDB reads each page.</span></div><div class="field-row"><div class="field"><label>Expression attribute names (JSON)</label><textarea id="item-expression-names" class="code-editor" placeholder='{"#title":"title"}'>{}</textarea></div><div class="field"><label>Expression attribute values (DynamoDB JSON)</label><textarea id="item-expression-values" class="code-editor" placeholder='{" :needle":{"S":"guide"}}'>{}</textarea></div></div><div class="field-row"><div class="field"><label>Projection attributes</label><input id="item-projection" placeholder="id, title, status"><span class="hint">Comma-separated top-level attribute names.</span></div><div class="field"><label>Results view</label><select id="item-results-view"><option value="table">Table</option><option value="plain">Plain JSON</option><option value="dynamodb">DynamoDB JSON</option></select></div></div><div class="field-row"><label class="checkbox-label"><input type="checkbox" id="item-consistent"> Strongly consistent read</label><label class="checkbox-label"><input type="checkbox" id="item-descending"> Sort descending (Query)</label><label class="checkbox-label"><input type="checkbox" id="item-count-only"> Count only</label></div><div class="field-row" id="item-segment-controls"><div class="field"><label>Parallel scan segment</label><input id="item-segment" type="number" min="0" placeholder="Optional"></div><div class="field"><label>Total scan segments</label><input id="item-total-segments" type="number" min="1" max="1000000" placeholder="Required with segment"></div></div></div></details><div class="actions"><button class="button primary" id="run-items">Run</button><button class="button" id="reset-items">Reset</button><button class="button" data-action="create-item">Create item</button></div></div></section><section class="card" id="items-result-card"><div class="card-header"><div><h2>Items returned</h2><p class="muted small" id="item-result-summary">No request has run.</p></div></div><div id="items-table">${emptyState("◇", "Ready to explore", "Choose Scan or Query, set a bounded page size, and run the request.")}</div></section>`;
}

export function bindEnhancedDynamoItems(context, table) {
  const { showError, showModal, toast } = context;
  const indexes = [
    ...(table.LocalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "LSI" })),
    ...(table.GlobalSecondaryIndexes ?? []).map(index => ({ ...index, kind: "GSI" })),
  ];
  const state = { result: undefined, items: [], page: 0, tokens: [undefined], running: false, selected: -1 };
  const root = document.querySelector("#items-result-card");
  const queryHeader = document.querySelector("#run-items").closest(".card").querySelector(".card-header");
  const autopreviewLabel = document.createElement("label");
  autopreviewLabel.className = "switch-label item-autopreview";
  autopreviewLabel.innerHTML = `<input type="checkbox" id="item-autopreview" ${localStorage.getItem("stacksim-dynamodb-autopreview") === "false" ? "" : "checked"}><span class="switch-track" aria-hidden="true"></span><span>Autopreview</span>`;
  queryHeader.append(autopreviewLabel);
  const autopreview = autopreviewLabel.querySelector("#item-autopreview");
  const operation = document.querySelector("#item-operation");
  const indexSelect = document.querySelector("#item-index");
  const trailingControls = document.createElement("div"); trailingControls.className = "field-row item-primary-controls item-secondary-controls";
  trailingControls.append(indexSelect.closest(".field"), document.querySelector("#item-limit").closest(".field")); document.querySelector("#item-query-controls").after(trailingControls);

  const selectedIndex = () => indexes.find(index => index.IndexName === indexSelect.value);
  const selectedSchema = () => selectedIndex()?.KeySchema ?? table.KeySchema;
  const resetPaging = () => { state.tokens = [undefined]; state.page = 0; };
  const parseObject = (id, label) => {
    const raw = document.querySelector(id).value.trim() || "{}";
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return value;
  };
  const addName = (names, attribute, prefix) => {
    let token = `#${prefix}`; let suffix = 0;
    while (Object.prototype.hasOwnProperty.call(names, token) && names[token] !== attribute) token = `#${prefix}${++suffix}`;
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
    const query = operation.value === "query";
    document.querySelector("#item-query-controls").hidden = !query;
    document.querySelector("#item-segment-controls").hidden = query;
    document.querySelector("#item-descending").disabled = !query;
    const schema = selectedSchema();
    const hash = schema.find(key => key.KeyType === "HASH");
    const sort = schema.find(key => key.KeyType === "RANGE");
    const hashType = attributeType(table, hash?.AttributeName);
    document.querySelector("#query-key-label").textContent = `Partition key value – ${hash?.AttributeName ?? "unknown"}`;
    document.querySelector("#query-key-type-label").textContent = `Partition key type – ${hash?.AttributeName ?? "unknown"}`;
    document.querySelector("#query-key-type").value = hashType;
    document.querySelector("#item-sort-controls").hidden = !sort;
    document.querySelector("#query-sort-operator-label").textContent = `Sort key condition – ${sort?.AttributeName ?? ""}`;
    document.querySelector("#query-sort-value-label").textContent = `Sort key value – ${sort?.AttributeName ?? ""}`;
    const gsi = selectedIndex()?.kind === "GSI";
    const consistent = document.querySelector("#item-consistent");
    consistent.disabled = gsi;
    if (gsi) consistent.checked = false;
  };

  const updateBetweenInputs = () => {
    document.querySelector("#query-sort-value-2").hidden = document.querySelector("#query-sort-operator").value !== "BETWEEN";
    document.querySelector("#item-filter-value-2").hidden = document.querySelector("#item-filter-operator").value !== "BETWEEN";
    const noValue = ["attribute_exists", "attribute_not_exists"].includes(document.querySelector("#item-filter-operator").value);
    document.querySelector("#item-filter-value").disabled = noValue;
    document.querySelector("#item-filter-type").disabled = noValue;
  };

  const requestInput = pageIndex => {
    const names = parseObject("#item-expression-names", "Expression attribute names");
    const values = parseObject("#item-expression-values", "Expression attribute values");
    const input = {
      TableName: table.TableName,
      Limit: Number(document.querySelector("#item-limit").value),
      ReturnConsumedCapacity: "TOTAL",
    };
    const index = selectedIndex();
    if (index) input.IndexName = index.IndexName;
    if (state.tokens[pageIndex]) input.ExclusiveStartKey = state.tokens[pageIndex];
    if (document.querySelector("#item-consistent").checked) input.ConsistentRead = true;
    if (document.querySelector("#item-count-only").checked) input.Select = "COUNT";

    const expressions = [];
    if (operation.value === "query") {
      const schema = selectedSchema();
      const hash = schema.find(key => key.KeyType === "HASH");
      const sort = schema.find(key => key.KeyType === "RANGE");
      const keyValue = document.querySelector("#query-key").value;
      if (!keyValue) throw new Error("Enter a partition key value");
      const hashName = addName(names, hash.AttributeName, "pk");
      const hashValue = addValue(values, typedValue(attributeType(table, hash.AttributeName), keyValue), "pk");
      const keyConditions = [`${hashName} = ${hashValue}`];
      const operator = document.querySelector("#query-sort-operator").value;
      if (sort && operator) {
        const raw = document.querySelector("#query-sort-value").value;
        if (!raw) throw new Error("Enter a sort key value");
        const sortName = addName(names, sort.AttributeName, "sk");
        const sortValue = addValue(values, typedValue(attributeType(table, sort.AttributeName), raw), "sk");
        if (operator === "BETWEEN") {
          const upper = document.querySelector("#query-sort-value-2").value;
          if (!upper) throw new Error("Enter the upper sort key value");
          const upperValue = addValue(values, typedValue(attributeType(table, sort.AttributeName), upper), "skUpper");
          keyConditions.push(`${sortName} BETWEEN ${sortValue} AND ${upperValue}`);
        } else if (operator === "begins_with") keyConditions.push(`begins_with(${sortName}, ${sortValue})`);
        else keyConditions.push(`${sortName} ${operator} ${sortValue}`);
      }
      input.KeyConditionExpression = keyConditions.join(" AND ");
      input.ScanIndexForward = !document.querySelector("#item-descending").checked;
    } else {
      const segment = document.querySelector("#item-segment").value;
      const total = document.querySelector("#item-total-segments").value;
      if (segment || total) {
        if (segment === "" || total === "") throw new Error("Parallel scan requires both segment and total segments");
        input.Segment = Number(segment); input.TotalSegments = Number(total);
      }
    }

    const guidedName = document.querySelector("#item-filter-name").value.trim();
    if (guidedName) {
      const operator = document.querySelector("#item-filter-operator").value;
      const name = addName(names, guidedName, "filter");
      if (["attribute_exists", "attribute_not_exists"].includes(operator)) expressions.push(`${operator}(${name})`);
      else {
        const raw = document.querySelector("#item-filter-value").value;
        if (!raw) throw new Error("Enter a guided filter value");
        const type = document.querySelector("#item-filter-type").value;
        const value = addValue(values, typedValue(type, raw), "filter");
        if (operator === "BETWEEN") {
          const upper = document.querySelector("#item-filter-value-2").value;
          if (!upper) throw new Error("Enter the upper guided filter value");
          expressions.push(`${name} BETWEEN ${value} AND ${addValue(values, typedValue(type, upper), "filterUpper")}`);
        } else if (["contains", "begins_with"].includes(operator)) expressions.push(`${operator}(${name}, ${value})`);
        else expressions.push(`${name} ${operator} ${value}`);
      }
    }
    const rawFilter = document.querySelector("#item-filter-expression").value.trim();
    if (rawFilter) expressions.push(`(${rawFilter})`);
    if (expressions.length) input.FilterExpression = expressions.join(" AND ");

    const projection = document.querySelector("#item-projection").value.split(",").map(value => value.trim()).filter(Boolean);
    if (projection.length) {
      if (input.Select === "COUNT") throw new Error("Projection attributes cannot be combined with Count only");
      input.ProjectionExpression = projection.map((attribute, index) => addName(names, attribute, `projection${index}`)).join(", ");
    }
    if (Object.keys(names).length) input.ExpressionAttributeNames = names;
    if (Object.keys(values).length) input.ExpressionAttributeValues = values;
    return input;
  };

  const renderResults = () => {
    const result = state.result;
    if (!result) return;
    const items = result.Items ?? [];
    state.items = items; state.selected = -1;
    const view = document.querySelector("#item-results-view").value;
    const capacity = result.ConsumedCapacity?.CapacityUnits;
    const metadata = [`Page ${state.page + 1}`, `${result.Count ?? 0} matched`, `${result.ScannedCount ?? 0} evaluated`, ...(capacity === undefined ? [] : [`${Number(capacity).toLocaleString()} read capacity units`])];
    root.querySelector("#item-result-summary").textContent = metadata.join(" · ");
    const warning = operation.value === "scan" ? '<div class="alert warning card-inset"><strong>Scan reads every evaluated item</strong><br>Use Query with a partition-key equality whenever the access pattern allows it. Filters such as contains reduce returned items, not read work.</div>' : "";
    let body;
    if (document.querySelector("#item-count-only").checked) body = emptyState("#", `${result.Count ?? 0} matching items`, `${result.ScannedCount ?? 0} items were evaluated on this page.`);
    else if (!items.length) body = emptyState("◇", "No items returned", "Change the key condition or filters, or create an item.", '<button class="button primary" data-action="create-item">Create item</button>');
    else if (view === "dynamodb") body = `<pre class="code-box item-json-results">${escapeHtml(JSON.stringify(items, null, 2))}</pre>`;
    else if (view === "plain") body = `<pre class="code-box item-json-results">${escapeHtml(JSON.stringify(items.map(plainItem), null, 2))}</pre>`;
    else body = itemsTable(items);
    root.querySelector("#items-table").innerHTML = `${warning}${items.length && view === "table" ? selectedActions() : ""}${body}<div class="card-body item-pagination"><div class="actions"><button class="button" id="items-previous" ${state.page === 0 ? "disabled" : ""}>Previous</button><button class="button" id="items-next" ${result.LastEvaluatedKey ? "" : "disabled"}>Next</button></div></div>`;
    document.querySelector("#items-previous")?.addEventListener("click", () => runPage(state.page - 1));
    document.querySelector("#items-next")?.addEventListener("click", () => { state.tokens[state.page + 1] = result.LastEvaluatedKey; runPage(state.page + 1); });
    bindResultActions();
  };

  const itemsTable = items => {
    const names = [...new Set(items.flatMap(item => Object.keys(item)))];
    return `<div class="table-wrap"><table class="items-data-table"><thead><tr><th class="checkbox-cell"><span class="sr-only">Select</span></th>${names.map(name => `<th>${escapeHtml(name)}</th>`).join("")}<th>Actions</th></tr></thead><tbody>${items.map((item, index) => `<tr><td><input type="radio" name="selected-item" aria-label="Select item ${index + 1}" value="${index}"></td>${names.map((name, columnIndex) => `<td>${columnIndex === 0 ? `<a href="#" data-item-action="view" data-item-index="${index}">${formatAttribute(item[name])}</a>` : formatAttribute(item[name])}</td>`).join("")}<td class="no-wrap"><button class="button link" data-item-action="view" data-item-index="${index}">View</button><button class="button link" data-item-action="edit" data-item-index="${index}">Edit</button><button class="button link" data-item-action="duplicate" data-item-index="${index}">Duplicate</button><button class="button link" data-item-action="delete" data-item-index="${index}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
  };
  const selectedActions = () => '<div class="toolbar item-selection-toolbar"><span id="item-selection-label" class="muted">No item selected</span><div class="actions"><button class="button" data-selected-action="view" disabled>View</button><button class="button" data-selected-action="edit" disabled>Edit</button><button class="button" data-selected-action="duplicate" disabled>Duplicate</button><button class="button danger" data-selected-action="delete" disabled>Delete</button></div></div>';

  const fullItem = async item => {
    const key = itemKey(table, item);
    if (Object.values(key).some(value => !value)) throw new Error("The selected projection does not contain every base-table key attribute");
    const result = await dynamo("GetItem", { TableName: table.TableName, Key: key, ConsistentRead: true });
    if (!result.Item) throw new Error("The selected item no longer exists");
    return result.Item;
  };
  const performAction = async (action, index) => {
    const item = state.items[index]; if (!item) return;
    try {
      if (action === "view") {
        const hydrated = await fullItem(item);
        showModal("View item", `<div class="tabs item-view-tabs" role="tablist" aria-label="Item JSON format"><button type="button" class="tab active" id="item-view-tab-plain" role="tab" aria-selected="true" aria-controls="item-view-plain" data-item-view-tab="plain">Plain JSON</button><button type="button" class="tab" id="item-view-tab-dynamodb" role="tab" aria-selected="false" aria-controls="item-view-dynamodb" tabindex="-1" data-item-view-tab="dynamodb">DynamoDB JSON</button></div><div id="item-view-plain" role="tabpanel" aria-labelledby="item-view-tab-plain" data-item-view-panel="plain"><pre class="code-box item-view-json"></pre></div><div id="item-view-dynamodb" role="tabpanel" aria-labelledby="item-view-tab-dynamodb" data-item-view-panel="dynamodb" hidden><pre class="code-box item-view-json">${escapeHtml(JSON.stringify(hydrated, null, 2))}</pre></div>`, "Close", async () => undefined, true, { refreshAfterSubmit: false });
        renderHighlightedCode(document.querySelector("#item-view-plain pre"), plainItem(hydrated), "json");
        const tabs = [...document.querySelectorAll("[data-item-view-tab]")];
        const selectTab = selected => {
          tabs.forEach(tab => {
            const active = tab.dataset.itemViewTab === selected;
            tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
          });
          document.querySelectorAll("[data-item-view-panel]").forEach(panel => { panel.hidden = panel.dataset.itemViewPanel !== selected; });
        };
        tabs.forEach((tab, index) => {
          tab.addEventListener("click", () => selectTab(tab.dataset.itemViewTab));
          tab.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const offset = event.key === "ArrowRight" ? 1 : -1;
            const next = tabs[(index + offset + tabs.length) % tabs.length];
            selectTab(next.dataset.itemViewTab); next.focus();
          });
        });
      } else if (action === "edit" || action === "duplicate") {
        const hydrated = await fullItem(item);
        showItemEditor(context, table, action, hydrated, () => runPage(state.page));
      } else if (action === "delete") {
        const key = itemKey(table, item);
        context.confirmDeletion("delete", "Delete this item from the base table?", async () => { await dynamo("DeleteItem", { TableName: table.TableName, Key: key }); toast("Item deleted"); });
      }
    } catch (error) { showError(error); }
  };
  const bindResultActions = () => {
    root.querySelectorAll("[data-item-action]").forEach(control => control.addEventListener("click", event => { event.preventDefault(); performAction(control.dataset.itemAction, Number(control.dataset.itemIndex)); }));
    root.querySelectorAll('input[name="selected-item"]').forEach(radio => radio.addEventListener("change", () => {
      state.selected = Number(radio.value);
      root.querySelector("#item-selection-label").textContent = `Item ${state.selected + 1} selected`;
      root.querySelectorAll("[data-selected-action]").forEach(button => { button.disabled = false; });
    }));
    root.querySelectorAll("[data-selected-action]").forEach(button => button.addEventListener("click", () => performAction(button.dataset.selectedAction, state.selected)));
    root.querySelectorAll('[data-action="create-item"]').forEach(button => button.addEventListener("click", () => showItemEditor(context, table, "create", {}, () => runPage(0))));
  };

  const runPage = async (pageIndex = 0) => {
    if (state.running || pageIndex < 0) return;
    state.running = true; document.querySelector("#run-items").disabled = true;
    root.querySelector("#items-table").innerHTML = '<div class="loading" role="status"><span></span>Reading a bounded page…</div>';
    try {
      const input = requestInput(pageIndex);
      state.result = await dynamo(operation.value === "query" ? "Query" : "Scan", input);
      state.page = pageIndex;
      renderResults();
    } catch (error) { showError(error); root.querySelector("#items-table").innerHTML = `<div class="alert error card-inset"><strong>${escapeHtml(error.code ?? "Request error")}</strong><br>${escapeHtml(error.message)}</div>`; }
    finally { state.running = false; document.querySelector("#run-items").disabled = false; }
  };

  const invalidatePaging = () => {
    resetPaging();
    root.querySelector("#items-previous")?.setAttribute("disabled", ""); root.querySelector("#items-next")?.setAttribute("disabled", "");
    if (state.result) root.querySelector("#item-result-summary").textContent = "Request settings changed. Run again before paging.";
  };

  operation.addEventListener("change", () => { invalidatePaging(); updateControls(); });
  indexSelect.addEventListener("change", () => { invalidatePaging(); updateControls(); });
  document.querySelector("#query-sort-operator").addEventListener("change", updateBetweenInputs);
  document.querySelector("#item-filter-operator").addEventListener("change", updateBetweenInputs);
  document.querySelector("#item-results-view").addEventListener("change", renderResults);
  document.querySelectorAll("#query-key,#query-sort-operator,#query-sort-value,#query-sort-value-2,#item-limit,#item-filter-name,#item-filter-operator,#item-filter-type,#item-filter-value,#item-filter-value-2,#item-filter-expression,#item-expression-names,#item-expression-values,#item-projection,#item-consistent,#item-descending,#item-count-only,#item-segment,#item-total-segments").forEach(control => {
    control.addEventListener(control.matches("input[type=checkbox],select") ? "change" : "input", invalidatePaging);
  });
  document.querySelector("#run-items").addEventListener("click", () => { resetPaging(); runPage(0); });
  document.querySelector("#reset-items").addEventListener("click", () => {
    for (const id of ["#query-key", "#query-sort-value", "#query-sort-value-2", "#item-filter-name", "#item-filter-value", "#item-filter-value-2", "#item-filter-expression", "#item-projection", "#item-segment", "#item-total-segments"]) document.querySelector(id).value = "";
    operation.value = "scan"; indexSelect.value = ""; document.querySelector("#item-limit").value = "25"; document.querySelector("#query-sort-operator").value = ""; document.querySelector("#item-filter-operator").value = "contains"; document.querySelector("#item-filter-type").value = "S"; document.querySelector("#item-results-view").value = "table"; document.querySelector("#item-expression-names").value = "{}"; document.querySelector("#item-expression-values").value = "{}";
    for (const id of ["#item-consistent", "#item-descending", "#item-count-only"]) document.querySelector(id).checked = false;
    state.result = undefined; state.items = []; resetPaging(); updateControls(); updateBetweenInputs();
    root.querySelector("#item-result-summary").textContent = "No request has run.";
    root.querySelector("#items-table").innerHTML = emptyState("◇", "Ready to explore", "Choose Scan or Query, set a bounded page size, and run the request.");
  });
  document.querySelectorAll('[data-action="create-item"]').forEach(button => button.addEventListener("click", () => showItemEditor(context, table, "create", {}, () => runPage(0))));
  autopreview.addEventListener("change", () => {
    localStorage.setItem("stacksim-dynamodb-autopreview", String(autopreview.checked));
    if (autopreview.checked) { resetPaging(); void runPage(0); }
  });
  updateControls(); updateBetweenInputs();
  if (autopreview.checked) void runPage(0);
}

function showItemEditor(context, table, action, source = {}, onCommitted = () => undefined) {
  const { showError, showModal, toast } = context;
  const keyNames = new Set(table.KeySchema.map(key => key.AttributeName));
  const originalKey = action === "edit" ? itemKey(table, source) : undefined;
  const item = structuredClone(source);
  for (const key of table.KeySchema) if (action === "duplicate" || !item[key.AttributeName]) item[key.AttributeName] = typedValue(attributeType(table, key.AttributeName), "");
  const formRows = current => { const ordered = [...table.KeySchema.map(key => [key.AttributeName, current[key.AttributeName] ?? typedValue(attributeType(table, key.AttributeName), "")]), ...Object.entries(current).filter(([name]) => !keyNames.has(name))]; if (action === "create") ordered.push(["", { S: "" }]); return ordered.map(([name, value]) => { const [type, raw] = Object.entries(value)[0]; const keyAttribute = keyNames.has(name); return itemAttributeRow(name, type, keyAttribute, editorAttributeText(type, raw), keyAttribute && action === "edit"); }).join(""); };
  const title = action === "edit" ? "Edit item" : action === "duplicate" ? "Duplicate item" : "Create item";
  const submit = action === "edit" ? "Save changes" : "Create item";
  let hints = attributeTypeHints(item); let activeMode = "form"; let readMode;
  const keyHelp = action === "edit" ? "Primary key names, types, and values are pinned while editing." : "Primary key names and types are pinned. Enter new key values for this item.";
  showModal(title, `<div class="field"><label>Editor view</label><select id="item-editor-mode" name="mode"><option value="form">Form</option><option value="plain">Plain JSON</option><option value="json">DynamoDB JSON</option></select></div><div id="item-form-editor"><div class="alert info">${keyHelp} Switching views keeps the current edits synchronized.</div><div id="attribute-rows">${formRows(item)}</div><button type="button" class="button" id="add-attribute">Add attribute</button></div><div class="field" id="item-plain-editor" hidden><label>Plain JSON</label><textarea name="plainItem" style="min-height:280px">${escapeHtml(JSON.stringify(plainItem(item), null, 2))}</textarea><span class="hint">Existing number, binary, and set types are preserved when switching views. Use DynamoDB JSON to change an attribute's DynamoDB type.</span></div><div class="field" id="item-json-editor" hidden><label>DynamoDB JSON</label><textarea name="item" style="min-height:280px">${escapeHtml(JSON.stringify(item, null, 2))}</textarea></div>`, submit, async () => {
    const next = readMode(activeMode);
    if (originalKey && !sameItemKey(table, next, originalKey)) throw new Error("Primary key values cannot be changed while editing. Duplicate the item to create a new key.");
    const put = { TableName: table.TableName, Item: next };
    if (action !== "edit") { put.ConditionExpression = "attribute_not_exists(#primaryKey)"; put.ExpressionAttributeNames = { "#primaryKey": table.KeySchema.find(key => key.KeyType === "HASH").AttributeName }; }
    await dynamo("PutItem", put);
    toast(action === "edit" ? "Item updated" : "Item created");
    await onCommitted();
  }, true, { refreshAfterSubmit: false });
  const mode = document.querySelector("#item-editor-mode");
  mode.closest(".field").hidden = true;
  const editorSwitcher = document.createElement("div");
  editorSwitcher.className = "item-editor-switcher";
  editorSwitcher.innerHTML = `<div class="segmented-control" role="group" aria-label="Editor view"><button type="button" class="active" data-item-editor-view="form" aria-pressed="true">Form</button><button type="button" data-item-editor-view="json" aria-pressed="false">JSON view</button></div><label class="checkbox-label item-json-format" hidden><input type="checkbox" id="item-view-dynamodb-json" checked> View DynamoDB JSON</label>`;
  mode.closest(".field").before(editorSwitcher);
  const formViewButton = editorSwitcher.querySelector('[data-item-editor-view="form"]');
  const jsonViewButton = editorSwitcher.querySelector('[data-item-editor-view="json"]');
  const jsonFormatLabel = editorSwitcher.querySelector(".item-json-format");
  const dynamodbJson = editorSwitcher.querySelector("#item-view-dynamodb-json");
  const readForm = () => { const next = {}; document.querySelectorAll("#attribute-rows .attribute-row").forEach(row => { const name = row.querySelector("[data-attribute-name]").value; if (name) next[name] = editorAttributeValue(row.querySelector("[data-attribute-type]").value, row.querySelector("[data-attribute-value]").value); }); return next; };
  readMode = currentMode => {
    if (currentMode === "json") return JSON.parse(document.querySelector('[name="item"]').value);
    if (currentMode === "plain") return Object.fromEntries(Object.entries(JSON.parse(document.querySelector('[name="plainItem"]').value)).map(([name, value]) => [name, toAttribute(value, pathPart("", name), hints)]));
    return readForm();
  };
  const writeMode = (nextMode, current) => {
    if (nextMode === "json") document.querySelector('[name="item"]').value = JSON.stringify(current, null, 2);
    else if (nextMode === "plain") document.querySelector('[name="plainItem"]').value = JSON.stringify(plainItem(current), null, 2);
    else { document.querySelector("#attribute-rows").innerHTML = formRows(current); bindAttributeRemove(); }
  };
  mode.addEventListener("change", () => {
    const nextMode = mode.value;
    try { const current = readMode(activeMode); hints = attributeTypeHints(current); writeMode(nextMode, current); activeMode = nextMode; }
    catch (error) { mode.value = activeMode; showError(error); return; }
    document.querySelector("#item-form-editor").hidden = mode.value !== "form";
    document.querySelector("#item-plain-editor").hidden = mode.value !== "plain";
    document.querySelector("#item-json-editor").hidden = mode.value !== "json";
  });
  const updateEditorSwitcher = () => {
    const form = mode.value === "form";
    formViewButton.classList.toggle("active", form);
    jsonViewButton.classList.toggle("active", !form);
    formViewButton.setAttribute("aria-pressed", String(form));
    jsonViewButton.setAttribute("aria-pressed", String(!form));
    jsonFormatLabel.hidden = form;
    dynamodbJson.checked = mode.value !== "plain";
  };
  const selectEditorMode = nextMode => {
    mode.value = nextMode;
    mode.dispatchEvent(new Event("change"));
    updateEditorSwitcher();
  };
  formViewButton.addEventListener("click", () => selectEditorMode("form"));
  jsonViewButton.addEventListener("click", () => selectEditorMode(dynamodbJson.checked ? "json" : "plain"));
  dynamodbJson.addEventListener("change", () => selectEditorMode(dynamodbJson.checked ? "json" : "plain"));
  document.querySelector("#add-attribute").addEventListener("click", () => { document.querySelector("#attribute-rows").insertAdjacentHTML("beforeend", itemAttributeRow("", "S", false, "")); bindAttributeRemove(); });
  bindAttributeRemove();
  formViewButton.focus();
}

function itemAttributeRow(name, type, pinned, value = "", valuePinned = pinned) {
  const rowId = `dynamodb-enhanced-attribute-${++attributeRowId}`;
  return `<div class="attribute-row field-row"><div class="field"><label for="${rowId}-name">Attribute name</label><input id="${rowId}-name" data-attribute-name value="${escapeHtml(name)}" ${pinned ? "readonly" : ""}></div><div class="field"><label for="${rowId}-value">Type and value</label><div class="attribute-value"><select id="${rowId}-type" aria-label="Attribute type" data-attribute-type ${pinned ? "disabled" : ""}>${attributeTypes.map(([option, label]) => `<option value="${option}" ${type === option ? "selected" : ""}>${label}</option>`).join("")}</select><input id="${rowId}-value" data-attribute-value value="${escapeHtml(value)}" required ${valuePinned ? "readonly" : ""}>${pinned ? '<span class="type-tag">KEY</span>' : '<button type="button" class="button link" data-remove-attribute>Remove</button>'}</div></div></div>`;
}

function bindAttributeRemove() { document.querySelectorAll("#attribute-rows [data-remove-attribute]").forEach(button => { button.onclick = () => button.closest(".attribute-row").remove(); }); }
function editorAttributeText(type, value) { if (["M", "L"].includes(type)) return JSON.stringify(value); if (["SS", "NS", "BS"].includes(type)) return value.join(", "); return String(value ?? ""); }
function editorAttributeValue(type, value) {
  if (type === "BOOL") return { BOOL: value === "true" };
  if (type === "NULL") return { NULL: true };
  if (type === "M") return { M: JSON.parse(value) };
  if (type === "L") return { L: JSON.parse(value) };
  if (["SS", "NS", "BS"].includes(type)) return { [type]: value.split(",").map(item => item.trim()).filter(Boolean) };
  return { [type]: String(value) };
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
  if (["SS", "NS", "BS"].includes(hinted)) { if (!Array.isArray(value)) throw new Error(`${path || "Value"} must remain an array to preserve its ${hinted} type`); return { [hinted]: value.map(String) }; }
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
function formatAttribute(value) {
  if (!value) return '<span class="muted">–</span>';
  const [type, raw] = Object.entries(value)[0];
  return `<span class="json-value"><span class="type-tag">${escapeHtml(type)}</span>${escapeHtml(typeof raw === "object" ? JSON.stringify(raw) : raw)}</span>`;
}
