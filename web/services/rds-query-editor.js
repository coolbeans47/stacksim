import { consoleMutation, rds, request } from "../api-client.js";
import { emptyState, escapeHtml, pageHeader } from "../components.js";
import { setDirty } from "../state.js";

const transitionStatuses = new Set(["creating", "deleting", "modifying", "rebooting", "stopping", "starting"]);

const elements = (root, name) => [...(root?.getElementsByTagName?.(name) ?? [])];
const first = (root, name) => elements(root, name)[0]?.textContent ?? "";

function parseInstances(xml) {
  const container = elements(xml, "DBInstances")[0] ?? xml;
  return elements(container, "DBInstance").map(node => ({
    identifier: first(node, "DBInstanceIdentifier"),
    status: first(node, "DBInstanceStatus"),
    engine: first(node, "Engine"),
    engineVersion: first(node, "EngineVersion"),
    databaseName: first(node, "DBName") || null,
  }));
}

function statusMarkup(status) {
  const normalized = String(status || "unknown").toLowerCase();
  const css = transitionStatuses.has(normalized) ? "pending" : normalized === "stopped" ? "inactive" : normalized === "available" ? "" : "error";
  return `<span class="status ${css}">${escapeHtml(normalized)}</span>`;
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${Number(count).toLocaleString()} ${count === 1 ? singular : pluralValue}`;
}

function formatCell(value) {
  if (value === null) return '<span class="rds-null">NULL</span>';
  if (value === undefined) return '<span class="muted">-</span>';
  let text;
  if (typeof value === "object") {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  } else {
    text = String(value);
  }
  return `<span class="rds-query-value">${escapeHtml(text)}</span>`;
}

function resultColumnMetadata(output, columns) {
  const supplied = Array.isArray(output?.columnMetadata) ? output.columnMetadata : [];
  return columns.map((name, index) => {
    const value = supplied[index] ?? {};
    return {
      name,
      type: String(value.type || "unknown").toLowerCase(),
      length: Number.isFinite(Number(value.length)) ? Math.max(0, Number(value.length)) : null,
      decimals: Number.isFinite(Number(value.decimals)) ? Math.max(0, Number(value.decimals)) : null,
      numeric: Boolean(value.numeric),
    };
  });
}

function resultColumnTypeLabel(column) {
  const names = {
    int24: "mediumint",
    long: "int",
    longlong: "bigint",
    newdecimal: "decimal",
    var_string: "varchar",
  };
  const type = names[column.type] ?? column.type;
  if (type === "unknown") return "";
  if (type === "decimal" && column.decimals !== null) return `${type} · ${column.decimals} dp`;
  return type;
}

function resultColumnLayout(columns, rows) {
  const textType = /(?:char|string|text|blob|json|enum|set)/;
  const temporalType = /(?:date|time|year)/;
  const preferred = columns.map((column, index) => {
    const headerWidth = Math.max(column.name.length, resultColumnTypeLabel(column).length);
    const sampleWidth = Math.max(0, ...rows.slice(0, 40).map(row => String(Array.isArray(row) ? row[index] ?? "" : row?.[column.name] ?? "").length));
    if (column.numeric) return Math.min(18, Math.max(9, headerWidth + 2, sampleWidth + 1));
    if (temporalType.test(column.type)) return Math.min(25, Math.max(18, headerWidth + 2, sampleWidth + 1));
    if (textType.test(column.type)) {
      const metadataWidth = column.length === null ? 0 : Math.ceil(column.length / 4);
      return Math.min(38, Math.max(10, headerWidth + 2, sampleWidth + 1, Math.min(metadataWidth, 34)));
    }
    return Math.min(30, Math.max(10, headerWidth + 2, sampleWidth + 1));
  });
  const total = preferred.reduce((sum, value) => sum + value, 0) || 1;
  return {
    minWidth: Math.max(720, total * 8 + columns.length * 24),
    widths: preferred.map(value => `${((value / total) * 100).toFixed(2)}%`),
  };
}

function objectTypeLabel(type) {
  const normalized = String(type || "object").toLowerCase();
  if (normalized === "table") return "Tables";
  if (normalized === "view") return "Views";
  if (normalized === "index") return "Indexes";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} objects`;
}

function columnMarkup(column) {
  const badges = [
    column.primaryKey ? '<span class="rds-column-badge primary">PK</span>' : "",
    column.nullable === false ? '<span class="rds-column-badge">NOT NULL</span>' : "",
  ].join("");
  const defaultValue = column.defaultValue === undefined || column.defaultValue === null
    ? ""
    : `<span class="rds-column-default" title="Default value">default ${escapeHtml(String(column.defaultValue))}</span>`;
  return `<div class="rds-column-row"><span class="rds-column-name mono">${escapeHtml(column.name)}</span><span class="rds-column-type">${escapeHtml(column.type || "unknown")}</span><span class="rds-column-meta">${badges}${defaultValue}</span></div>`;
}

function objectMarkup(object) {
  const columns = Array.isArray(object.columns) ? object.columns : [];
  const search = [object.name, object.type, ...columns.flatMap(column => [column.name, column.type])].join(" ").toLowerCase();
  const kind = String(object.type || "object").slice(0, 1).toUpperCase();
  return `<div class="rds-object-item" data-rds-object-entry data-object-search="${escapeHtml(search)}"><div class="rds-object-title"><details class="rds-object-details"><summary><span class="rds-object-kind">${escapeHtml(kind)}</span><span class="rds-object-name mono">${escapeHtml(object.name)}</span><span class="muted small">${plural(columns.length, "column")}</span></summary><div class="rds-column-list">${columns.length ? columns.map(columnMarkup).join("") : '<div class="muted small rds-column-empty">No columns reported</div>'}</div></details><button class="button link rds-object-preview" type="button" data-preview-rds-object="${escapeHtml(object.name)}" title="Open this object in the query editor">Open</button></div></div>`;
}

function objectsMarkup(objects, selectedDatabase) {
  if (!selectedDatabase) return emptyState("DB", "No database selected", "Choose a database to browse its tables, views, and columns.");
  if (!objects.length) return emptyState("DB", "No database objects", `No tables or views were found in ${selectedDatabase}.`);
  const groups = new Map();
  for (const object of objects) {
    const type = String(object.type || "object").toLowerCase();
    groups.set(type, [...(groups.get(type) ?? []), object]);
  }
  const preferred = ["table", "view", "index"];
  const orderedTypes = [...preferred.filter(type => groups.has(type)), ...[...groups.keys()].filter(type => !preferred.includes(type)).sort()];
  return `${orderedTypes.map(type => {
    const values = groups.get(type).sort((left, right) => String(left.name).localeCompare(String(right.name)));
    return `<details class="rds-object-group" data-rds-object-group open><summary><span>${escapeHtml(objectTypeLabel(type))}</span><span class="rds-object-count">${values.length}</span></summary><div class="rds-object-items">${values.map(objectMarkup).join("")}</div></details>`;
  }).join("")}<div class="rds-object-filter-empty muted" data-rds-object-filter-empty hidden>No database objects match this filter.</div>`;
}

function databaseOptions(databases, selectedDatabase) {
  const values = [...new Set((databases ?? []).map(String))].sort((left, right) => left.localeCompare(right));
  return `${values.length ? "" : '<option value="">No database selected</option>'}${values.map(database => `<option value="${escapeHtml(database)}" ${database === selectedDatabase ? "selected" : ""}>${escapeHtml(database)}</option>`).join("")}`;
}

function readyResultsMarkup() {
  return `<div class="card-header"><h2>Results</h2><div class="rds-query-status"><span class="pill">Ready</span><span class="muted">Run a query to see results.</span></div></div>${emptyState("SQL", "No query run", "Run the selected SQL or the full editor to populate the results grid.")}`;
}

function runningResultsMarkup() {
  return '<div class="card-header"><h2>Results</h2><div class="rds-query-status"><span class="pill">Running</span><span class="muted">Executing SQL...</span></div></div><div class="loading" role="status"><span></span>Running query...</div>';
}

function errorResultsMarkup(error) {
  const code = error?.code ?? "Query failed";
  const message = error instanceof Error ? error.message : String(error);
  return `<div class="card-header"><h2>Results</h2><div class="rds-query-status"><span class="pill alarm">Failed</span><span class="muted">The query was not completed.</span></div></div><div class="card-body"><div class="alert error" role="alert"><strong>${escapeHtml(code)}</strong><br>${escapeHtml(message)}</div></div>`;
}

function completedResultsMarkup(output) {
  const columns = Array.isArray(output?.columns) ? output.columns.map(String) : [];
  const rows = Array.isArray(output?.rows) ? output.rows : [];
  const columnMetadata = resultColumnMetadata(output, columns);
  const rowCount = Number.isFinite(Number(output?.rowCount)) ? Number(output.rowCount) : rows.length;
  const elapsed = Number.isFinite(Number(output?.elapsedMs)) ? `${Math.max(0, Number(output.elapsedMs)).toLocaleString()} ms` : "";
  const statusText = [plural(rowCount, "row"), elapsed].filter(Boolean).join(" · ");
  const truncated = Boolean(output?.truncated);
  let body;
  if (columns.length) {
    const layout = resultColumnLayout(columnMetadata, rows);
    const colgroup = `<colgroup>${layout.widths.map(width => `<col style="width:${width}">`).join("")}</colgroup>`;
    body = `${truncated ? `<div class="alert warning rds-result-warning"><strong>Result limit reached</strong><br>Showing the first ${Number(rows.length).toLocaleString()} rows. Refine the query to inspect a smaller result set.</div>` : ""}<div class="table-wrap rds-results-wrap"><table class="rds-results-table" style="min-width:${layout.minWidth}px" aria-label="Query results">${colgroup}<thead><tr>${columnMetadata.map(column => `<th scope="col" class="${column.numeric ? "rds-result-numeric" : ""}"><span class="rds-result-column-name mono">${escapeHtml(column.name)}</span>${resultColumnTypeLabel(column) ? `<span class="rds-result-column-type">${escapeHtml(resultColumnTypeLabel(column))}</span>` : ""}</th>`).join("")}</tr></thead><tbody>${rows.map(row => {
      const values = Array.isArray(row) ? row : columns.map(column => row?.[column]);
      return `<tr>${columnMetadata.map((column, index) => `<td class="${column.numeric ? "rds-result-numeric" : ""}">${formatCell(values[index])}</td>`).join("")}</tr>`;
    }).join("")}</tbody></table></div>`;
  } else {
    const affectedRows = Number.isFinite(Number(output?.affectedRows)) ? Number(output.affectedRows) : 0;
    const insertId = output?.insertId === undefined || output?.insertId === null || Number(output.insertId) === 0 ? "" : ` Last insert ID: ${escapeHtml(String(output.insertId))}.`;
    body = emptyState("OK", "Query completed", `${plural(affectedRows, "row")} affected.${insertId}`);
  }
  return `<div class="card-header"><h2>Results <span class="muted">(${rowCount.toLocaleString()})</span></h2><div class="rds-query-status"><span class="pill ok">Succeeded</span><span class="muted">${escapeHtml(statusText)}</span></div></div>${body}`;
}

function unavailablePage(context) {
  context.setChrome("rds", ["RDS", "Query editor"]);
  context.main.innerHTML = `<div class="page-width rds-query-page">${pageHeader("Query editor", "Explore database objects and run SQL against a local DB instance.", '<a class="button" href="#/rds/databases">View databases</a>')}<section class="card">${emptyState("R", "No database available", "Create a local DB instance before opening the query editor.", '<a class="button primary" href="#/rds/databases">Create database</a>')}</section></div>`;
}

export async function rdsQueryEditor(context, requestedIdentifier) {
  const described = await rds("DescribeDBInstances", requestedIdentifier ? { DBInstanceIdentifier: requestedIdentifier } : {});
  const instances = parseInstances(described.xml);
  const instance = requestedIdentifier
    ? instances.find(candidate => candidate.identifier === requestedIdentifier)
    : instances[0];
  if (!instance) {
    if (requestedIdentifier) throw new Error(`DB instance ${requestedIdentifier} was not found`);
    unavailablePage(context);
    return;
  }

  const canQuery = instance.status === "available";
  const endpoint = `/_stacksim/api/rds/query-editor/${encodeURIComponent(instance.identifier)}`;
  const state = {
    selectedDatabase: instance.databaseName,
    databases: instance.databaseName ? [instance.databaseName] : [],
    objects: [],
    editorTouched: false,
    running: false,
    loadingObjects: false,
    activeObject: null,
  };

  context.setChrome("rds", ["RDS", "Query editor", instance.identifier]);
  const availability = canQuery ? "" : `<div class="alert info"><strong>Query execution is unavailable</strong><br>The DB instance is ${escapeHtml(instance.status)}. Start it and wait for the available status before refreshing objects or running SQL.</div>`;
  context.main.innerHTML = `<div class="page-width rds-query-page">
    ${pageHeader("Query editor", `Explore database objects and run SQL against ${escapeHtml(instance.identifier)}.`, `<a class="button" href="#/rds/databases/${encodeURIComponent(instance.identifier)}/connectivity">View database</a>`)}
    <div class="rds-query-connection"><span>${statusMarkup(instance.status)}</span><span class="mono">${escapeHtml(instance.identifier)}</span><span>${escapeHtml(`${instance.engine} ${instance.engineVersion}`.trim())}</span></div>
    ${availability}
    <div class="rds-query-workspace">
      <div class="rds-query-workbench">
        <aside class="card rds-query-explorer">
          <div class="card-header"><div><h2>Database objects</h2><p class="muted small">Browse tables, views, and columns.</p></div><button class="button refresh" type="button" data-action="refresh-rds-objects" aria-label="Refresh database objects" ${canQuery ? "" : "disabled"}>&#8635;</button></div>
          <div class="rds-explorer-database field"><label for="rds-query-database">Database</label><select id="rds-query-database" ${canQuery ? "" : "disabled"}>${databaseOptions(state.databases, state.selectedDatabase)}</select></div>
          <div class="toolbar"><label class="filter"><span>&#8981;</span><input type="search" data-rds-object-filter placeholder="Filter tables or columns" ${canQuery ? "" : "disabled"}></label></div>
          <div class="rds-object-tree" data-rds-object-tree>${canQuery ? '<div class="loading" role="status"><span></span>Loading database objects...</div>' : emptyState("DB", "Database unavailable", "Start the DB instance to browse its objects.")}</div>
        </aside>
        <section class="card rds-query-editor-card">
          <div class="rds-editor-tabbar"><div class="rds-editor-tab" aria-current="page"><span class="rds-editor-tab-icon">SQL</span><span data-rds-editor-tab-label>Query 1</span></div><div class="actions"><button class="button" type="button" data-action="clear-rds-query">Clear</button><button class="button primary" type="button" data-action="run-rds-query" ${canQuery ? "" : "disabled"}>Run query</button></div></div>
          <div class="card-header"><div><h2>SQL query</h2><p class="muted small">Run selected text, or the full editor when nothing is selected.</p></div><div class="rds-query-engine"><span class="muted small">Connection</span><strong>${escapeHtml(instance.identifier)}</strong></div></div>
          <div class="rds-editor-surface"><label class="sr-only" for="rds-sql-editor">SQL</label><textarea id="rds-sql-editor" class="code-editor rds-sql-editor" spellcheck="false" ${canQuery ? "" : "aria-disabled=\"true\""}>SELECT 1 AS ready;</textarea></div>
          <div class="rds-editor-footer"><span class="muted small">Credentials remain on the signed local connection.</span><span class="muted small"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> to run</span></div>
        </section>
      </div>
      <section class="card rds-query-results" data-rds-query-results>${readyResultsMarkup()}</section>
    </div>
  </div>`;

  const root = context.main;
  const objectTree = root.querySelector("[data-rds-object-tree]");
  const objectFilter = root.querySelector("[data-rds-object-filter]");
  const databaseSelect = root.querySelector("#rds-query-database");
  const editor = root.querySelector("#rds-sql-editor");
  const results = root.querySelector("[data-rds-query-results]");
  const runButton = root.querySelector('[data-action="run-rds-query"]');
  const refreshButton = root.querySelector('[data-action="refresh-rds-objects"]');
  const editorTabLabel = root.querySelector("[data-rds-editor-tab-label]");

  function bindObjectActions() {
    objectTree.querySelectorAll("[data-preview-rds-object]").forEach(button => button.addEventListener("click", () => {
      const objectName = button.getAttribute("data-preview-rds-object");
      editor.value = `SELECT * FROM ${quoteIdentifier(objectName)} LIMIT 100;`;
      state.activeObject = objectName;
      editorTabLabel.textContent = objectName;
      objectTree.querySelectorAll("[data-rds-object-entry]").forEach(entry => entry.classList.toggle("is-selected", entry.contains(button)));
      state.editorTouched = true;
      setDirty(true, "page");
      editor.focus();
    }));
  }

  function applyObjectFilter() {
    const value = objectFilter.value.trim().toLowerCase();
    const entries = [...objectTree.querySelectorAll("[data-rds-object-entry]")];
    for (const entry of entries) entry.hidden = Boolean(value) && !entry.dataset.objectSearch.includes(value);
    const groups = [...objectTree.querySelectorAll("[data-rds-object-group]")];
    for (const group of groups) {
      const visible = [...group.querySelectorAll("[data-rds-object-entry]")].some(entry => !entry.hidden);
      group.hidden = Boolean(value) && !visible;
      if (value && visible) group.open = true;
    }
    const empty = objectTree.querySelector("[data-rds-object-filter-empty]");
    if (empty) empty.hidden = !value || entries.some(entry => !entry.hidden);
  }

  function renderObjects() {
    objectTree.innerHTML = objectsMarkup(state.objects, state.selectedDatabase);
    bindObjectActions();
    applyObjectFilter();
  }

  function renderDatabaseSelect() {
    databaseSelect.innerHTML = databaseOptions(state.databases, state.selectedDatabase);
    databaseSelect.value = state.selectedDatabase ?? "";
  }

  async function loadObjects(database = state.selectedDatabase, chooseDefaultQuery = false) {
    if (!canQuery || state.loadingObjects) return;
    state.loadingObjects = true;
    refreshButton.disabled = true;
    databaseSelect.disabled = true;
    objectTree.innerHTML = '<div class="loading" role="status"><span></span>Loading database objects...</div>';
    try {
      const query = database ? `?database=${encodeURIComponent(database)}` : "";
      const output = await request(`${endpoint}/objects${query}`, { service: "rds" });
      state.databases = Array.isArray(output.databases) ? output.databases.map(String) : [];
      state.selectedDatabase = output.selectedDatabase === undefined || output.selectedDatabase === null ? null : String(output.selectedDatabase);
      state.objects = Array.isArray(output.objects) ? output.objects : [];
      if (state.activeObject && !state.objects.some(object => object.name === state.activeObject)) {
        state.activeObject = null;
        editorTabLabel.textContent = "Query 1";
      }
      renderDatabaseSelect();
      renderObjects();
      if (chooseDefaultQuery && !state.editorTouched) {
        const firstObject = state.objects.find(object => ["table", "view"].includes(String(object.type).toLowerCase()));
        if (firstObject) {
          editor.value = `SELECT * FROM ${quoteIdentifier(firstObject.name)} LIMIT 100;`;
          state.activeObject = firstObject.name;
          editorTabLabel.textContent = firstObject.name;
          const selectedButton = [...objectTree.querySelectorAll("[data-preview-rds-object]")].find(button => button.getAttribute("data-preview-rds-object") === firstObject.name);
          selectedButton?.closest("[data-rds-object-entry]")?.classList.add("is-selected");
        }
      }
    } catch (error) {
      objectTree.innerHTML = `<div class="card-body"><div class="alert error" role="alert"><strong>Unable to load database objects</strong><br>${escapeHtml(error instanceof Error ? error.message : String(error))}</div></div>`;
    } finally {
      state.loadingObjects = false;
      refreshButton.disabled = false;
      databaseSelect.disabled = false;
    }
  }

  async function runQuery() {
    if (!canQuery || state.running) return;
    const selected = editor.selectionStart !== editor.selectionEnd ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : "";
    const sql = (selected.trim() ? selected : editor.value).trim();
    if (!sql) {
      results.innerHTML = errorResultsMarkup(Object.assign(new Error("Enter a SQL query to run."), { code: "EmptyQuery" }));
      editor.focus();
      return;
    }
    state.running = true;
    runButton.disabled = true;
    results.innerHTML = runningResultsMarkup();
    try {
      const output = await consoleMutation(`${endpoint}/query`, "POST", { database: state.selectedDatabase, sql });
      results.innerHTML = completedResultsMarkup(output);
      setDirty(false, "page");
      if (/^\s*(?:CREATE|ALTER|DROP)\s+(?:TABLE|VIEW|DATABASE|INDEX)\b/i.test(sql)) await loadObjects(state.selectedDatabase);
    } catch (error) {
      results.innerHTML = errorResultsMarkup(error);
    } finally {
      state.running = false;
      if (runButton.isConnected) runButton.disabled = false;
    }
  }

  editor.addEventListener("input", () => { state.editorTouched = true; });
  editor.addEventListener("keydown", event => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    void runQuery();
  });
  runButton.addEventListener("click", () => void runQuery());
  root.querySelector('[data-action="clear-rds-query"]').addEventListener("click", () => {
    editor.value = "";
    state.activeObject = null;
    editorTabLabel.textContent = "Query 1";
    objectTree.querySelectorAll("[data-rds-object-entry]").forEach(entry => entry.classList.remove("is-selected"));
    state.editorTouched = true;
    setDirty(true, "page");
    editor.focus();
  });
  refreshButton.addEventListener("click", () => void loadObjects(state.selectedDatabase));
  databaseSelect.addEventListener("change", () => {
    state.selectedDatabase = databaseSelect.value || null;
    void loadObjects(state.selectedDatabase);
  });
  objectFilter.addEventListener("input", applyObjectFilter);

  if (canQuery) await loadObjects(state.selectedDatabase, true);
}
