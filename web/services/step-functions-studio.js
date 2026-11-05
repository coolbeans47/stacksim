// Workflow Studio: Design, Code and Config modes around one States Language
// document. Design edits and the JSON in Code mode round-trip through the same
// hidden-in-plain-sight textarea, so nothing a visual edit does not understand
// is lost.
import { associateFormLabels, escapeHtml } from "../components.js";
import { setDirty } from "../state.js";
import { bindFlowControls, flowGraphHtml, flowToolbarHtml } from "./step-functions-graph.js";
import {
  STUDIO_ACTIONS,
  STUDIO_FLOW_TYPES,
  addStudioState,
  parseStateMachineDefinition,
  removeStudioState,
  renameStudioState,
  setStudioStartAt,
  stateNameProblem,
  updateStudioState,
} from "./step-functions-model.js";

const pretty = value => JSON.stringify(value, null, 2);
const history = new WeakMap();
const TERMINAL_TYPES = ["Succeed", "Fail", "Choice"];
const ERROR_HANDLING_TYPES = ["Task", "Parallel", "Map"];

function definitionTextarea(root) {
  return root.querySelector('[name="definition"]');
}

function showStudioError(root, message = "") {
  const region = root.querySelector("[data-studio-error]");
  if (!region) return;
  region.textContent = message;
  region.hidden = !message;
}

function readDefinition(root) {
  const parsed = parseStateMachineDefinition(definitionTextarea(root).value);
  if (!parsed) throw new Error("The definition must be valid States Language JSON with StartAt and States.");
  return parsed;
}

function updateHistoryButtons(root) {
  const stacks = history.get(root);
  const undo = root.querySelector("[data-studio-undo]");
  const redo = root.querySelector("[data-studio-redo]");
  if (undo) undo.disabled = !stacks?.undo.length;
  if (redo) redo.disabled = !stacks?.redo.length;
}

function writeDefinition(root, definition, { markDirty = true, record = true } = {}) {
  const textarea = definitionTextarea(root);
  const text = pretty(definition);
  if (text === textarea.value) return;
  if (record) {
    const stacks = history.get(root) ?? { undo: [], redo: [] };
    stacks.undo.push(textarea.value);
    if (stacks.undo.length > 100) stacks.undo.shift();
    stacks.redo = [];
    history.set(root, stacks);
  }
  textarea.value = text;
  if (markDirty) {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    setDirty(true);
  }
  updateHistoryButtons(root);
}

function currentMode(root) {
  return root.querySelector("[data-studio-tab][aria-selected='true']")?.dataset.studioTab ?? "design";
}

// ---------------------------------------------------------------------------
// Inspector

function field(label, control, hint = "") {
  return `<div class="field"><label>${escapeHtml(label)}</label>${control}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</div>`;
}

const jsonArea = (attribute, value) => `<textarea ${attribute} class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(value))}</textarea>`;
const pathInput = (attribute, value, placeholder = "$") => `<input ${attribute} class="mono" value="${escapeHtml(value === null ? "null" : value ?? "")}" placeholder="${escapeHtml(placeholder)}" spellcheck="false">`;

function inspectorHtml(definition, selectedName, activeTab, showDefinition) {
  if (!selectedName || !definition.States?.[selectedName]) {
    return '<div class="empty compact"><h3>Select a state</h3><p>Choose a state on the canvas, or add one from the states browser, to edit its properties.</p></div>';
  }
  const state = definition.States[selectedName];
  const others = Object.keys(definition.States).filter(name => name !== selectedName);
  const options = (selected, emptyLabel) => `${emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>` : ""}${others.map(name => `<option value="${escapeHtml(name)}" ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;

  let configuration = field("State name", `<input data-studio-name value="${escapeHtml(selectedName)}" maxlength="80">`) + field("Type", `<input value="${escapeHtml(state.Type)}" readonly>`) + field("Comment", `<input data-studio-comment value="${escapeHtml(state.Comment ?? "")}" maxlength="256">`);
  if (state.Type === "Task") {
    configuration += field("Resource", `<input data-studio-resource class="mono" value="${escapeHtml(state.Resource ?? "")}" spellcheck="false">`, "Lambda function ARNs, optimized integrations, nested workflows, and Activity ARNs are supported.") + field("API Parameters (JSON)", jsonArea("data-studio-parameters", state.Parameters ?? {}));
  } else if (state.Type === "Pass") {
    configuration += field("Result (JSON)", jsonArea("data-studio-result", state.Result ?? {}));
  } else if (state.Type === "Wait") {
    const alternate = [["SecondsPath", state.SecondsPath], ["Timestamp", state.Timestamp], ["TimestampPath", state.TimestampPath]].find(([, value]) => value !== undefined);
    configuration += alternate
      ? field("Wait timing", `<input class="mono" value="${escapeHtml(`${alternate[0]} · ${alternate[1]}`)}" readonly>`, "This timing mode is preserved by Design edits. Switch to Code to change it.")
      : field("Seconds", `<input data-studio-seconds type="number" min="0" step="1" value="${escapeHtml(state.Seconds ?? 0)}">`);
  } else if (state.Type === "Fail") {
    configuration += field("Error", `<input data-studio-error-name value="${escapeHtml(state.Error ?? "")}">`) + field("Cause", `<input data-studio-cause value="${escapeHtml(state.Cause ?? "")}">`);
  } else if (state.Type === "Choice") {
    configuration += field("Choices (JSON)", jsonArea("data-studio-choices", state.Choices ?? [])) + field("Default", `<select data-studio-default>${options(state.Default, "No default")}</select>`);
  } else if (state.Type === "Parallel") {
    configuration += field("Branches (JSON)", jsonArea("data-studio-branches", state.Branches ?? []), "Each branch needs StartAt and States.");
  } else if (state.Type === "Map") {
    configuration += field("ItemsPath", pathInput("data-studio-items-path", state.ItemsPath ?? "$")) + field("ItemProcessor (JSON)", jsonArea("data-studio-item-processor", state.ItemProcessor ?? state.Iterator ?? {})) + field("MaxConcurrency", `<input data-studio-max-concurrency type="number" min="0" max="40" step="1" value="${escapeHtml(state.MaxConcurrency ?? "")}" placeholder="0 (no limit)">`);
  }
  if (!TERMINAL_TYPES.includes(state.Type)) configuration += field("Next state", `<select data-studio-next>${options(state.Next, "End")}</select>`, "Choose End to terminate after this state.");
  configuration += `<div class="sfn-studio-inspector-actions"><button class="button" type="button" data-studio-set-start ${selectedName === definition.StartAt ? "disabled" : ""}>Set as StartAt</button><button class="button danger" type="button" data-studio-delete-state>Delete state</button><button class="button" type="button" disabled title="Test state — Not available in StackSim">Test state</button></div>`;

  const none = text => `<p class="muted">${escapeHtml(text)}</p>`;
  let input = "";
  if (state.Type !== "Fail") input += field("InputPath", pathInput("data-studio-input-path", state.InputPath), "Selects part of the state input. Leave empty for the whole input ($); enter null to discard it.");
  if (["Pass", "Parallel"].includes(state.Type)) input += field("Parameters (JSON)", jsonArea("data-studio-parameters", state.Parameters ?? {}), "Builds the input passed to the state. Leave {} to pass the input unchanged.");
  if (state.Type === "Map") input += field("ItemSelector (JSON)", jsonArea("data-studio-item-selector", state.ItemSelector ?? {}), "Builds the input of each iteration. Leave {} to pass each item unchanged.");
  if (!input) input = none("A Fail state takes no input settings.");

  let output = "";
  if (ERROR_HANDLING_TYPES.includes(state.Type)) output += field("ResultSelector (JSON)", jsonArea("data-studio-result-selector", state.ResultSelector ?? {}), "Reshapes the result before ResultPath is applied. Leave {} to keep the result.");
  if (["Pass", "Task", "Parallel", "Map"].includes(state.Type)) output += field("ResultPath", pathInput("data-studio-result-path", state.ResultPath), "Where the result is placed in the state input. Leave empty to replace the input ($); enter null to discard the result.");
  if (state.Type !== "Fail") output += field("OutputPath", pathInput("data-studio-output-path", state.OutputPath), "Selects part of the state output. Leave empty for the whole output ($).");
  if (!output) output = none("A Fail state produces no output.");

  let errors = "";
  if (ERROR_HANDLING_TYPES.includes(state.Type)) errors += field("Retry (JSON)", jsonArea("data-studio-retry", state.Retry ?? []), "Retriers: ErrorEquals, IntervalSeconds, MaxAttempts, BackoffRate, MaxDelaySeconds, JitterStrategy.") + field("Catch (JSON)", jsonArea("data-studio-catch", state.Catch ?? []), "Catchers: ErrorEquals, Next (fallback state), ResultPath.");
  if (state.Type === "Task") errors += field("TimeoutSeconds", `<input data-studio-timeout type="number" min="1" step="1" value="${escapeHtml(state.TimeoutSeconds ?? "")}">`) + field("HeartbeatSeconds", `<input data-studio-heartbeat type="number" min="1" step="1" value="${escapeHtml(state.HeartbeatSeconds ?? "")}">`);
  if (!errors) errors = none("Retry, Catch and timeouts apply to Task, Parallel and Map states.");

  const tabs = [["configuration", "Configuration", configuration], ["input", "Input", input], ["output", "Output", output], ["errors", "Error handling", errors]];
  const active = tabs.some(([key]) => key === activeTab) ? activeTab : "configuration";
  return `<div class="sfn-studio-inspector-body"><div class="sfn-studio-inspector-title"><div><h3>${escapeHtml(selectedName)}</h3><p class="muted">${escapeHtml(state.Type === "Succeed" ? "Success" : state.Type)} state</p></div><label class="sfn-studio-toggle"><input type="checkbox" data-studio-definition-toggle ${showDefinition ? "checked" : ""}> Definition</label></div><div class="tabs sfn-studio-inspector-tabs" role="tablist" aria-label="State settings">${tabs.map(([key, label]) => `<button type="button" class="tab ${key === active ? "active" : ""}" role="tab" aria-selected="${key === active}" data-inspector-tab="${key}">${label}</button>`).join("")}</div>${tabs.map(([key, , body]) => `<div role="tabpanel" data-inspector-panel="${key}" ${key === active ? "" : "hidden"}>${body}</div>`).join("")}<div data-studio-state-definition ${showDefinition ? "" : "hidden"}><h4>Definition</h4><pre class="code-box">${escapeHtml(pretty(state))}</pre></div></div>`;
}

function parseJsonField(value, label, fallback) {
  if (!String(value ?? "").trim()) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} must be valid JSON.`); }
}

const isEmptyObject = value => value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length;

function applyInspector(root) {
  const definition = readDefinition(root);
  const selected = root.dataset.studioSelected;
  if (!selected || !definition.States?.[selected]) return definition;
  const control = selector => root.querySelector(`[data-studio-inspector] ${selector}`);
  const edited = selector => control(selector)?.dataset.studioEdited === "true";
  const state = definition.States[selected];
  const patch = {};
  const remove = [];
  const set = (key, value) => { if (value === undefined) remove.push(key); else patch[key] = value; };
  const text = (selector, key, { trim = true } = {}) => { if (edited(selector)) { const value = trim ? control(selector).value.trim() : control(selector).value; set(key, value || undefined); } };
  const path = (selector, key) => { if (edited(selector)) { const value = control(selector).value.trim(); set(key, value === "" ? undefined : value === "null" ? null : value); } };
  const json = (selector, key, label, fallback, keepEmpty = false) => {
    if (!edited(selector)) return;
    const value = parseJsonField(control(selector).value, label, fallback);
    set(key, !keepEmpty && (isEmptyObject(value) || (Array.isArray(value) && !value.length)) ? undefined : value);
  };
  const number = (selector, key) => { if (edited(selector)) { const raw = control(selector).value.trim(); set(key, raw === "" ? undefined : Number(raw)); } };

  text("[data-studio-comment]", "Comment");
  if (state.Type === "Task") {
    if (edited("[data-studio-resource]")) patch.Resource = control("[data-studio-resource]").value.trim();
    json("[data-studio-parameters]", "Parameters", "Parameters", {}, true);
    number("[data-studio-timeout]", "TimeoutSeconds");
    number("[data-studio-heartbeat]", "HeartbeatSeconds");
  } else if (state.Type === "Pass") {
    json("[data-studio-result]", "Result", "Result", {}, true);
    json("[data-studio-parameters]", "Parameters", "Parameters", {});
  } else if (state.Type === "Wait") {
    if (edited("[data-studio-seconds]")) { patch.Seconds = Number(control("[data-studio-seconds]").value || 0); remove.push("SecondsPath", "Timestamp", "TimestampPath"); }
  } else if (state.Type === "Fail") {
    text("[data-studio-error-name]", "Error");
    text("[data-studio-cause]", "Cause", { trim: false });
  } else if (state.Type === "Choice") {
    json("[data-studio-choices]", "Choices", "Choices", [], true);
    if (edited("[data-studio-default]")) set("Default", control("[data-studio-default]").value || undefined);
  } else if (state.Type === "Parallel") {
    json("[data-studio-branches]", "Branches", "Branches", [], true);
    json("[data-studio-parameters]", "Parameters", "Parameters", {});
  } else if (state.Type === "Map") {
    if (edited("[data-studio-items-path]")) patch.ItemsPath = control("[data-studio-items-path]").value.trim() || "$";
    if (edited("[data-studio-item-processor]")) { patch.ItemProcessor = parseJsonField(control("[data-studio-item-processor]").value, "ItemProcessor", {}); remove.push("Iterator"); }
    json("[data-studio-item-selector]", "ItemSelector", "ItemSelector", {});
    number("[data-studio-max-concurrency]", "MaxConcurrency");
  }
  path("[data-studio-input-path]", "InputPath");
  path("[data-studio-result-path]", "ResultPath");
  path("[data-studio-output-path]", "OutputPath");
  json("[data-studio-result-selector]", "ResultSelector", "ResultSelector", {});
  json("[data-studio-retry]", "Retry", "Retry", []);
  json("[data-studio-catch]", "Catch", "Catch", []);
  if (!TERMINAL_TYPES.includes(state.Type) && edited("[data-studio-next]")) {
    const nextValue = control("[data-studio-next]").value;
    if (nextValue) { patch.Next = nextValue; remove.push("End"); }
    else { patch.End = true; remove.push("Next"); }
  }
  let next = updateStudioState(definition, selected, patch);
  for (const key of remove) if (!(key in patch)) delete next.States[selected][key];
  if (edited("[data-studio-name]")) {
    const name = control("[data-studio-name]").value.trim() || selected;
    if (name !== selected) {
      next = renameStudioState(next, selected, name);
      root.dataset.studioSelected = name;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Rendering

function canvasHtml(root, definition, selected) {
  return flowGraphHtml(definition, { mode: "design", selectedName: selected, zoom: root.dataset.studioZoom, label: "Workflow canvas", emptyMessage: "Add a state from the states browser to begin the workflow." });
}

function bindCanvas(root) {
  root.querySelectorAll("[data-studio-canvas] [data-studio-select]").forEach(button => button.addEventListener("click", () => {
    try {
      writeDefinition(root, applyInspector(root));
      root.dataset.studioSelected = button.dataset.studioSelect;
      showStudioError(root);
      renderStudio(root);
    } catch (error) {
      showStudioError(root, error instanceof Error ? error.message : String(error));
    }
  }));
}

function refreshCanvas(root) {
  root.querySelector("[data-studio-canvas]").innerHTML = canvasHtml(root, readDefinition(root), root.dataset.studioSelected);
  bindCanvas(root);
}

function bindInspector(root) {
  const inspector = root.querySelector("[data-studio-inspector]");
  inspector.querySelectorAll("input:not([type=checkbox]), select, textarea").forEach(control => {
    control.addEventListener("change", () => {
      control.dataset.studioEdited = "true";
      if (control.hasAttribute("data-studio-name") || control.hasAttribute("data-studio-next") || control.hasAttribute("data-studio-default")) commitStudio(root);
      else syncInspectorQuietly(root);
    });
  });
  inspector.querySelectorAll("[data-inspector-tab]").forEach(tab => tab.addEventListener("click", () => {
    root.dataset.studioInspectorTab = tab.dataset.inspectorTab;
    inspector.querySelectorAll("[data-inspector-tab]").forEach(item => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
    inspector.querySelectorAll("[data-inspector-panel]").forEach(panel => { panel.hidden = panel.dataset.inspectorPanel !== tab.dataset.inspectorTab; });
  }));
  inspector.querySelector("[data-studio-definition-toggle]")?.addEventListener("change", event => {
    root.dataset.studioShowDefinition = String(event.target.checked);
    inspector.querySelector("[data-studio-state-definition]").hidden = !event.target.checked;
  });
  inspector.querySelector("[data-studio-set-start]")?.addEventListener("click", () => {
    const selected = root.dataset.studioSelected;
    commitStudio(root, definition => setStudioStartAt(definition, selected));
  });
  inspector.querySelector("[data-studio-delete-state]")?.addEventListener("click", () => {
    const selected = root.dataset.studioSelected;
    commitStudio(root, definition => {
      const next = removeStudioState(definition, selected);
      root.dataset.studioSelected = next.StartAt;
      return next;
    });
  });
}

function renderStudio(root) {
  const definition = readDefinition(root);
  let selected = root.dataset.studioSelected;
  if (!selected || !definition.States?.[selected]) selected = definition.StartAt && definition.States?.[definition.StartAt] ? definition.StartAt : Object.keys(definition.States ?? {})[0] ?? "";
  root.dataset.studioSelected = selected;
  root.querySelector("[data-studio-canvas]").innerHTML = canvasHtml(root, definition, selected);
  root.querySelector("[data-studio-inspector]").innerHTML = inspectorHtml(definition, selected, root.dataset.studioInspectorTab, root.dataset.studioShowDefinition === "true");
  associateFormLabels(root);
  bindCanvas(root);
  bindInspector(root);
  updateHistoryButtons(root);
}

function commitStudio(root, mutator) {
  try {
    const current = applyInspector(root);
    const next = mutator ? mutator(current) : current;
    const definition = typeof next === "object" && next && "definition" in next ? next.definition : next;
    if (typeof next === "object" && next && "definition" in next && next.name) root.dataset.studioSelected = next.name;
    writeDefinition(root, definition);
    showStudioError(root);
    renderStudio(root);
  } catch (error) {
    showStudioError(root, error instanceof Error ? error.message : String(error));
  }
}

function syncInspectorQuietly(root) {
  try {
    writeDefinition(root, applyInspector(root));
    showStudioError(root);
    refreshCanvas(root);
    const state = readDefinition(root).States?.[root.dataset.studioSelected];
    const preview = root.querySelector("[data-studio-state-definition] pre");
    if (state && preview) preview.textContent = pretty(state);
  } catch (error) {
    showStudioError(root, error instanceof Error ? error.message : String(error));
  }
}

function renderCodeGraph(root) {
  const host = root.querySelector("[data-studio-code-graph]");
  if (!host) return;
  const parsed = parseStateMachineDefinition(definitionTextarea(root).value);
  host.innerHTML = parsed ? flowGraphHtml(parsed, { mode: "definition", zoom: root.dataset.studioZoom, label: "Graph visualization" }) : '<div class="sfn-data-state absent">The graph is shown when the definition is valid JSON with StartAt and States.</div>';
}

function activateStudioTab(root, mode, focus = false) {
  const current = currentMode(root);
  if (current === mode) return true;
  try {
    if (current === "design") writeDefinition(root, applyInspector(root));
    if (mode === "design") { readDefinition(root); renderStudio(root); }
    if (mode === "code") renderCodeGraph(root);
    showStudioError(root);
  } catch (error) {
    showStudioError(root, error instanceof Error ? error.message : String(error));
    return false;
  }
  root.querySelectorAll("[data-studio-tab]").forEach(tab => {
    const active = tab.dataset.studioTab === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll("[data-studio-panel]").forEach(panel => { panel.hidden = panel.dataset.studioPanel !== mode; });
  if (focus) root.querySelector(`[data-studio-tab="${mode}"]`)?.focus();
  return true;
}

// ---------------------------------------------------------------------------
// Markup

function paletteHtml() {
  const item = (entry, attributes) => `<button type="button" class="sfn-studio-palette-item type-${entry.type ? entry.type.toLowerCase() : "task"}" ${attributes} data-palette-search="${escapeHtml(`${entry.label} ${entry.group ?? ""} ${entry.hint}`.toLowerCase())}" aria-label="Add ${escapeHtml(entry.label)} state"><span class="sfn-studio-glyph" aria-hidden="true">${entry.glyph}</span><span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.hint)}</small></span></button>`;
  let group = "";
  const actions = STUDIO_ACTIONS.map(action => {
    const heading = action.group !== group ? `<h4 class="sfn-studio-palette-group" data-palette-group>${escapeHtml(action.group)}</h4>` : "";
    group = action.group;
    return `${heading}${item(action, `data-studio-add="Task" data-studio-action="${action.id}"`)}`;
  }).join("");
  const flow = STUDIO_FLOW_TYPES.map(type => item(type, `data-studio-add="${type.type}"`)).join("");
  return `<div class="sfn-studio-palette-header"><h3>States browser</h3><label class="filter"><span aria-hidden="true">⌕</span><input data-palette-filter placeholder="Search" aria-label="Search states"></label><div class="tabs sfn-studio-palette-tabs" role="tablist" aria-label="States browser"><button type="button" class="tab active" role="tab" aria-selected="true" data-palette-tab="actions">Actions</button><button type="button" class="tab" role="tab" aria-selected="false" data-palette-tab="flow">Flow</button><button type="button" class="tab" role="tab" aria-selected="false" aria-disabled="true" disabled title="Patterns are not available in StackSim">Patterns</button></div></div><div class="sfn-studio-palette-list" data-palette-panel="actions">${actions}</div><div class="sfn-studio-palette-list" data-palette-panel="flow" hidden>${flow}</div><p class="sfn-studio-tip muted">Click a state to add it after the selected state. Switch to Code anytime for advanced fields; Design edits round-trip to the same States Language document.</p>`;
}

/**
 * Workflow Studio markup. configHtml fills Config mode; actionsHtml fills the
 * right side of the mode bar (Validate, Cancel, Create or Save).
 */
export function workflowStudioMarkup({ definitionJson, configHtml = "", actionsHtml = "" }) {
  const tab = (mode, label, active) => `<button type="button" class="tab ${active ? "active" : ""}" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-studio-tab="${mode}" aria-controls="sfn-studio-${mode}-panel" id="sfn-studio-${mode}-tab">${label}</button>`;
  const toolbar = flowToolbarHtml({ extra: '<button class="button" type="button" data-studio-undo aria-label="Undo" title="Undo" disabled>Undo</button><button class="button" type="button" data-studio-redo aria-label="Redo" title="Redo" disabled>Redo</button>' });
  return `<div class="sfn-studio" data-sfn-studio><div class="sfn-studio-bar"><div class="tabs sfn-studio-modes" role="tablist" aria-label="Workflow Studio mode">${tab("design", "Design", true)}${tab("code", "Code", false)}${tab("config", "Config", false)}</div><div class="sfn-studio-bar-actions"><details class="actions-menu"><summary class="button" aria-haspopup="menu">Actions ▾</summary><div class="menu" role="menu"><button type="button" role="menuitem" data-studio-export>Export definition</button><button type="button" role="menuitem" data-studio-import>Import definition</button><button type="button" role="menuitem" disabled title="Not available in StackSim">Export graph</button></div></details>${actionsHtml}</div></div><div class="alert error" role="alert" data-studio-error hidden></div><section id="sfn-studio-design-panel" class="sfn-studio-visual" role="tabpanel" aria-labelledby="sfn-studio-design-tab" data-studio-panel="design"><div class="sfn-studio-layout"><aside class="sfn-studio-palette" aria-label="States browser">${paletteHtml()}</aside><div class="sfn-studio-canvas-wrap sfn-flow-host">${toolbar}<div class="sfn-studio-canvas" data-studio-canvas></div></div><aside class="sfn-studio-inspector" data-studio-inspector aria-live="polite" aria-label="State inspector"></aside></div></section><section id="sfn-studio-code-panel" role="tabpanel" aria-labelledby="sfn-studio-code-tab" data-studio-panel="code" hidden><div class="sfn-studio-code"><div class="field"><label>Definition (States Language JSON)</label><textarea name="definition" class="code-editor sfn-editor" spellcheck="false" data-dirty-track>${escapeHtml(definitionJson)}</textarea><span class="hint">Design and Code modes share one definition. ASL fields that Design mode does not edit stay editable here and are preserved.</span></div><div class="sfn-studio-code-graph sfn-flow-host"><h3>Graph visualization</h3><div data-studio-code-graph></div></div></div></section><section id="sfn-studio-config-panel" role="tabpanel" aria-labelledby="sfn-studio-config-tab" data-studio-panel="config" hidden>${configHtml}</section><input type="file" accept=".json,application/json" data-studio-import-file hidden></div>`;
}

export function syncStudioBeforeSubmit(root) {
  const studio = root.querySelector("[data-sfn-studio]") ?? root;
  if (!studio.querySelector("[data-studio-tab]")) return;
  if (currentMode(studio) === "design") writeDefinition(studio, applyInspector(studio), { markDirty: false });
}

/** Switches Workflow Studio to a mode; returns false when the current mode has an error that blocks leaving it. */
export function showStudioMode(root, mode) {
  const studio = root.querySelector("[data-sfn-studio]") ?? root;
  return activateStudioTab(studio, mode);
}

export function bindWorkflowStudio(root, { exportName = () => "state-machine" } = {}) {
  const studio = root.querySelector("[data-sfn-studio]") ?? root;
  const textarea = definitionTextarea(studio);
  const parsed = parseStateMachineDefinition(textarea.value);
  studio.dataset.studioSelected = parsed?.StartAt ?? Object.keys(parsed?.States ?? {})[0] ?? "";
  history.set(studio, { undo: [], redo: [] });
  try {
    renderStudio(studio);
    showStudioError(studio);
  } catch (error) {
    activateStudioTab(studio, "code");
    showStudioError(studio, error instanceof Error ? error.message : String(error));
  }

  studio.querySelectorAll("[data-studio-add]").forEach(button => button.addEventListener("click", () => {
    const action = STUDIO_ACTIONS.find(item => item.id === button.dataset.studioAction);
    commitStudio(studio, definition => addStudioState(definition, button.dataset.studioAdd, { afterName: studio.dataset.studioSelected, ...(action ? { preferredName: action.name, state: action.state() } : {}) }));
  }));
  studio.querySelectorAll("[data-palette-tab]").forEach(tab => tab.addEventListener("click", () => {
    studio.querySelectorAll("[data-palette-tab]").forEach(item => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
    studio.querySelectorAll("[data-palette-panel]").forEach(panel => { panel.hidden = panel.dataset.palettePanel !== tab.dataset.paletteTab; });
  }));
  studio.querySelector("[data-palette-filter]")?.addEventListener("input", event => {
    const query = event.target.value.trim().toLowerCase();
    studio.querySelectorAll("[data-palette-search]").forEach(item => { item.hidden = Boolean(query) && !item.dataset.paletteSearch.includes(query); });
    studio.querySelectorAll("[data-palette-group]").forEach(heading => { heading.hidden = Boolean(query); });
  });

  const tabs = [...studio.querySelectorAll("[data-studio-tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateStudioTab(studio, tab.dataset.studioTab));
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs.at(-1);
      if (!next) return;
      event.preventDefault();
      activateStudioTab(studio, next.dataset.studioTab, true);
    });
  });

  let previewTimer;
  textarea.addEventListener("input", () => {
    if (currentMode(studio) !== "code") return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => renderCodeGraph(studio), 250);
  });
  textarea.addEventListener("change", () => {
    if (currentMode(studio) === "code") renderCodeGraph(studio);
  });

  const restore = (from, to) => {
    const stacks = history.get(studio);
    if (!stacks?.[from].length) return;
    try { if (currentMode(studio) === "design") writeDefinition(studio, applyInspector(studio)); } catch { /* An invalid inspector edit is dropped by undo. */ }
    stacks[to].push(textarea.value);
    textarea.value = stacks[from].pop();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    setDirty(true);
    showStudioError(studio);
    try { renderStudio(studio); } catch (error) { showStudioError(studio, error instanceof Error ? error.message : String(error)); }
  };
  studio.querySelector("[data-studio-undo]")?.addEventListener("click", () => restore("undo", "redo"));
  studio.querySelector("[data-studio-redo]")?.addEventListener("click", () => restore("redo", "undo"));
  bindFlowControls(studio, { onZoom: zoom => { studio.dataset.studioZoom = String(zoom); } });

  const closeMenu = element => element.closest("details")?.removeAttribute("open");
  studio.querySelector("[data-studio-export]")?.addEventListener("click", event => {
    closeMenu(event.currentTarget);
    try { syncStudioBeforeSubmit(studio); } catch (error) { showStudioError(studio, error instanceof Error ? error.message : String(error)); return; }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([textarea.value], { type: "application/json" }));
    link.download = `${exportName() || "state-machine"}.asl.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  const fileInput = studio.querySelector("[data-studio-import-file]");
  studio.querySelector("[data-studio-import]")?.addEventListener("click", event => { closeMenu(event.currentTarget); fileInput?.click(); });
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const text = await file.text();
    const imported = parseStateMachineDefinition(text);
    if (!imported) { showStudioError(studio, "The imported file is not States Language JSON with StartAt and States."); return; }
    studio.dataset.studioSelected = "";
    writeDefinition(studio, imported);
    showStudioError(studio);
    if (currentMode(studio) === "design") renderStudio(studio);
    else renderCodeGraph(studio);
  });
}

export { stateNameProblem };
