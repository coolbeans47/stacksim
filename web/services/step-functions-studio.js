import { associateFormLabels, escapeHtml } from "../components.js";
import { setDirty } from "../state.js";
import {
  STUDIO_STATE_TYPES,
  addStudioState,
  parseStateMachineDefinition,
  removeStudioState,
  renameStudioState,
  setStudioStartAt,
  studioFlow,
  updateStudioState,
} from "./step-functions-model.js";

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

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
  const textarea = definitionTextarea(root);
  const parsed = parseStateMachineDefinition(textarea.value);
  if (!parsed) throw new Error("The definition must be valid States Language JSON with StartAt and States.");
  return parsed;
}

function writeDefinition(root, definition, { markDirty = true } = {}) {
  const textarea = definitionTextarea(root);
  textarea.value = pretty(definition);
  if (markDirty) {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    setDirty(true);
  }
}

function stateNames(definition) {
  return Object.keys(definition.States ?? {});
}

function nextOptions(definition, current) {
  return stateNames(definition).filter(name => name !== current);
}

function inspectorHtml(definition, selectedName) {
  if (!selectedName || !definition.States?.[selectedName]) {
    return `<div class="empty compact"><h3>Select a state</h3><p>Choose a canvas node or add a state from the palette to edit its properties.</p></div>`;
  }
  const state = definition.States[selectedName];
  const options = nextOptions(definition, selectedName);
  const optionHtml = (selected, emptyLabel) => `${emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>` : ""}${options.map(name => `<option value="${escapeHtml(name)}" ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const common = `<div class="field"><label>State name</label><input data-studio-name value="${escapeHtml(selectedName)}" pattern="[A-Za-z0-9_]+" maxlength="80"></div><div class="field"><label>Type</label><input value="${escapeHtml(state.Type)}" readonly></div><div class="field"><label>Comment</label><input data-studio-comment value="${escapeHtml(state.Comment ?? "")}" maxlength="256"></div>`;
  let specific = "";
  if (state.Type === "Task") {
    specific = `<div class="field"><label>Resource</label><input data-studio-resource class="mono" value="${escapeHtml(state.Resource ?? "")}" spellcheck="false"><span class="hint">Direct Lambda ARNs, optimized integrations, nested workflows, and Activity ARNs are supported.</span></div><div class="field"><label>Parameters (JSON)</label><textarea data-studio-parameters class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.Parameters ?? {}))}</textarea></div>`;
  } else if (state.Type === "Pass") {
    specific = `<div class="field"><label>Result (JSON)</label><textarea data-studio-result class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.Result ?? {}))}</textarea></div>`;
  } else if (state.Type === "Wait") {
    const alternateTiming = [["SecondsPath", state.SecondsPath], ["Timestamp", state.Timestamp], ["TimestampPath", state.TimestampPath]].find(([, value]) => value !== undefined);
    specific = alternateTiming
      ? `<div class="field"><label>Wait timing</label><input class="mono" value="${escapeHtml(`${alternateTiming[0]} · ${alternateTiming[1]}`)}" readonly><span class="hint">This timing mode is preserved by visual edits. Switch to JSON to change it.</span></div>`
      : `<div class="field"><label>Seconds</label><input data-studio-seconds type="number" min="0" step="1" value="${escapeHtml(state.Seconds ?? 0)}"></div>`;
  } else if (state.Type === "Fail") {
    specific = `<div class="field"><label>Error</label><input data-studio-error-name value="${escapeHtml(state.Error ?? "")}"></div><div class="field"><label>Cause</label><input data-studio-cause value="${escapeHtml(state.Cause ?? "")}"></div>`;
  } else if (state.Type === "Choice") {
    specific = `<div class="field"><label>Choices (JSON)</label><textarea data-studio-choices class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.Choices ?? []))}</textarea></div><div class="field"><label>Default</label><select data-studio-default>${optionHtml(state.Default, "No default")}</select></div>`;
  } else if (state.Type === "Parallel") {
    specific = `<div class="field"><label>Branches (JSON)</label><textarea data-studio-branches class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.Branches ?? []))}</textarea><span class="hint">Each branch needs StartAt and States.</span></div>`;
  } else if (state.Type === "Map") {
    specific = `<div class="field"><label>ItemsPath</label><input data-studio-items-path class="mono" value="${escapeHtml(state.ItemsPath ?? "$")}"></div><div class="field"><label>ItemProcessor (JSON)</label><textarea data-studio-item-processor class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.ItemProcessor ?? state.Iterator ?? {}))}</textarea></div>`;
  }
  const transition = ["Succeed", "Fail", "Choice"].includes(state.Type) ? "" : `<div class="field"><label>Next state</label><select data-studio-next>${optionHtml(state.Next, "End")}</select><span class="hint">Choose End to terminate after this state.</span></div>`;
  const advanced = !["Succeed", "Fail", "Choice"].includes(state.Type) ? `<div class="field"><label>Retry (JSON)</label><textarea data-studio-retry class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.Retry ?? []))}</textarea></div><div class="field"><label>Catch (JSON)</label><textarea data-studio-catch class="code-editor sfn-studio-json" spellcheck="false">${escapeHtml(pretty(state.Catch ?? []))}</textarea></div>` : "";
  return `<div class="sfn-studio-inspector-body"><h3>${escapeHtml(selectedName)}</h3><p class="muted">${escapeHtml(state.Type)} configuration</p>${common}${specific}${transition}${advanced}<div class="sfn-studio-inspector-actions"><button class="button" type="button" data-studio-set-start ${selectedName === definition.StartAt ? "disabled" : ""}>Set as StartAt</button><button class="button danger" type="button" data-studio-delete-state>Delete state</button></div></div>`;
}

function canvasHtml(definition, selectedName) {
  const flow = studioFlow(definition);
  if (!flow.nodes.length) return '<div class="alert error" role="alert">Add a state from the palette to begin the workflow.</div>';
  const nodeMap = new Map(flow.nodes.map(node => [node.name, node]));
  const outgoing = new Map();
  for (const edge of flow.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const renderNode = (name, { compact = false } = {}) => {
    const node = nodeMap.get(name);
    if (!node) return `<div class="sfn-studio-node-missing muted">${escapeHtml(name)}</div>`;
    const selected = name === selectedName ? " selected" : "";
    const start = node.start ? " start" : "";
    const compactClass = compact ? " compact" : "";
    return `<button type="button" class="sfn-studio-node type-${escapeHtml(String(node.type).toLowerCase())}${selected}${start}${compactClass}" data-studio-select="${escapeHtml(name)}" aria-label="Edit ${escapeHtml(name)} state" aria-pressed="${name === selectedName}"><span class="sfn-studio-node-type">${escapeHtml(node.type)}</span><strong>${escapeHtml(name)}</strong>${!compact && node.summary ? `<small class="mono sfn-wrap">${escapeHtml(node.summary)}</small>` : ""}${node.start ? "<small>StartAt</small>" : ""}${node.end ? "<small>End</small>" : ""}</button>`;
  };
  const renderedInFork = new Set();
  const ordered = [];
  const visited = new Set();
  const walk = name => {
    if (!name || visited.has(name) || !nodeMap.has(name)) return;
    visited.add(name);
    ordered.push(name);
    const state = definition.States?.[name];
    const edges = outgoing.get(name) ?? [];
    if (state?.Type === "Choice") {
      const primary = state.Choices?.[0]?.Next ?? state.Default;
      for (const edge of edges) if (edge.to && edge.to !== primary) renderedInFork.add(edge.to);
      if (primary) walk(primary);
      return;
    }
    if (state?.Type === "Parallel") {
      for (const edge of edges.filter(item => item.kind === "parallel-branch")) renderedInFork.add(edge.to);
      const next = edges.find(edge => !edge.label || edge.label === "Next")?.to;
      if (next) walk(next);
      return;
    }
    for (const edge of edges.filter(edge => !edge.kind)) walk(edge.to);
  };
  if (flow.startAt) walk(flow.startAt);
  for (const node of flow.nodes) if (!visited.has(node.name) && !renderedInFork.has(node.name)) ordered.push(node.name);
  const rows = ordered.map(name => {
    const state = definition.States?.[name];
    const edges = outgoing.get(name) ?? [];
    if (state?.Type === "Choice") {
      const decisionEdges = edges.filter(edge => edge.label && edge.label !== "Next");
      return `<div class="sfn-studio-row sfn-studio-decision">${renderNode(name)}<span class="sfn-studio-connector" aria-hidden="true"></span><div class="sfn-studio-fork" style="--sfn-fork-count:${Math.max(decisionEdges.length, 1)}"><div class="sfn-studio-fork-label">Decision branches</div>${decisionEdges.map(edge => `<div class="sfn-studio-fork-arm"><span class="sfn-studio-edge-label">${escapeHtml(edge.label)}</span><span class="sfn-studio-connector short" aria-hidden="true"></span>${renderNode(edge.to, { compact: true })}</div>`).join("")}</div><span class="sfn-studio-connector" aria-hidden="true"></span></div>`;
    }
    if (state?.Type === "Parallel") {
      const branchEdges = edges.filter(edge => edge.kind === "parallel-branch");
      const nextEdge = edges.find(edge => !edge.label || edge.label === "Next");
      const catchEdges = edges.filter(edge => edge.label === "Catch");
      return `<div class="sfn-studio-row sfn-studio-parallel-row">${renderNode(name)}<span class="sfn-studio-connector" aria-hidden="true"></span><div class="sfn-studio-fork parallel" style="--sfn-fork-count:${Math.max(branchEdges.length, 1)}"><div class="sfn-studio-fork-label">Parallel branches</div>${branchEdges.map((edge, index) => {
        const branch = state.Branches?.[index] ?? {};
        const childNames = Object.keys(branch.States ?? {});
        return `<div class="sfn-studio-fork-arm"><span class="sfn-studio-edge-label">${escapeHtml(edge.label)}</span><span class="sfn-studio-connector short" aria-hidden="true"></span><div class="sfn-studio-branch-card"><small class="muted">Starts at ${escapeHtml(branch.StartAt ?? "–")}</small>${childNames.map(child => `<span class="sfn-studio-branch-state">${escapeHtml(child)}</span>`).join("")}</div></div>`;
      }).join("")}</div>${catchEdges.length ? `<span class="sfn-studio-connector short" aria-hidden="true"></span><div class="sfn-studio-branches catch">${catchEdges.map(edge => `<div class="sfn-studio-branch"><span class="sfn-studio-edge-label">Catch</span><span class="sfn-studio-connector short" aria-hidden="true"></span>${renderNode(edge.to, { compact: true })}</div>`).join("")}</div>` : ""}${nextEdge ? `<span class="sfn-studio-connector" aria-hidden="true"></span>` : `<span class="sfn-studio-connector short" aria-hidden="true"></span><div class="sfn-studio-terminal" aria-hidden="true">End</div>`}</div>`;
    }
    const catchEdges = edges.filter(edge => edge.label === "Catch");
    const nextEdge = edges.find(edge => !edge.label || edge.label === "Next");
    return `<div class="sfn-studio-row">${renderNode(name)}${catchEdges.length ? `<span class="sfn-studio-connector short" aria-hidden="true"></span><div class="sfn-studio-branches catch">${catchEdges.map(edge => `<div class="sfn-studio-branch"><span class="sfn-studio-edge-label">Catch</span><span class="sfn-studio-connector short" aria-hidden="true"></span>${renderNode(edge.to, { compact: true })}</div>`).join("")}</div>` : ""}${nextEdge ? `<span class="sfn-studio-connector" aria-hidden="true"></span>` : `<span class="sfn-studio-connector short" aria-hidden="true"></span><div class="sfn-studio-terminal" aria-hidden="true">End</div>`}</div>`;
  }).join("");
  const leftovers = flow.nodes.filter(node => !visited.has(node.name) && !ordered.includes(node.name));
  return `<div class="sfn-studio-flow" role="list">${flow.startAt ? `<div class="sfn-studio-start" aria-hidden="true">Start</div><span class="sfn-studio-connector" aria-hidden="true"></span>` : ""}${rows}${leftovers.length ? `<div class="sfn-studio-orphans"><h4>Other reachable paths</h4><div class="sfn-studio-orphan-list">${leftovers.map(node => renderNode(node.name)).join("")}</div></div>` : ""}${flow.orphans.length ? `<div class="sfn-studio-orphans"><h4>Unreachable states</h4><div class="sfn-studio-orphan-list">${flow.orphans.map(renderNode).join("")}</div></div>` : ""}</div>`;
}

function paletteHtml() {
  return `<div class="sfn-studio-palette-header"><h3>States</h3><p class="muted">Click to add after the selected state</p></div><div class="sfn-studio-palette-list">${STUDIO_STATE_TYPES.map(item => `<button type="button" class="sfn-studio-palette-item type-${item.type.toLowerCase()}" data-studio-add="${item.type}" aria-label="Add ${item.label} state"><span class="sfn-studio-glyph" aria-hidden="true">${item.glyph}</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.hint)}</small></span></button>`).join("")}</div><p class="sfn-studio-tip muted">Tip: switch to JSON anytime for advanced fields. Visual edits round-trip to the same States Language document.</p>`;
}

export function studioEditorMarkup(definitionJson) {
  return `<div class="sfn-studio" data-sfn-studio><div class="tabs" role="tablist" aria-label="Definition editor mode"><button type="button" class="tab active" role="tab" aria-selected="true" tabindex="0" data-studio-tab="visual" aria-controls="sfn-studio-visual-panel" id="sfn-studio-visual-tab">Visual</button><button type="button" class="tab" role="tab" aria-selected="false" tabindex="-1" data-studio-tab="json" aria-controls="sfn-studio-json-panel" id="sfn-studio-json-tab">JSON</button></div><div class="alert error" role="alert" data-studio-error hidden></div><section id="sfn-studio-visual-panel" class="sfn-studio-visual" role="tabpanel" aria-labelledby="sfn-studio-visual-tab" data-studio-panel="visual"><div class="sfn-studio-layout"><aside class="sfn-studio-palette" aria-label="State palette">${paletteHtml()}</aside><div class="sfn-studio-canvas" data-studio-canvas aria-label="Workflow canvas"></div><aside class="sfn-studio-inspector" data-studio-inspector aria-live="polite" aria-label="State inspector"></aside></div></section><section id="sfn-studio-json-panel" role="tabpanel" aria-labelledby="sfn-studio-json-tab" data-studio-panel="json" hidden><div class="field"><label>Definition (States Language JSON)</label><textarea name="definition" class="code-editor sfn-editor" spellcheck="false" data-dirty-track>${escapeHtml(definitionJson)}</textarea><span class="hint">Visual and JSON modes share one definition. Unsupported ASL fields remain editable in JSON and are preserved when possible.</span></div></section></div>`;
}

function parseJsonField(value, label, fallback) {
  if (!String(value ?? "").trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function applyInspector(root) {
  const definition = readDefinition(root);
  const selected = root.dataset.studioSelected;
  if (!selected || !definition.States?.[selected]) return definition;
  const edited = selector => root.querySelector(selector)?.dataset.studioEdited === "true";
  const nameInput = root.querySelector("[data-studio-name]");
  const nextName = edited("[data-studio-name]") ? nameInput?.value.trim() || selected : selected;
  let next = definition;
  const patch = {};
  if (edited("[data-studio-comment]")) {
    const comment = root.querySelector("[data-studio-comment]")?.value.trim();
    patch.Comment = comment || undefined;
  }
  const state = definition.States[selected];
  if (state.Type === "Task") {
    if (edited("[data-studio-resource]")) patch.Resource = root.querySelector("[data-studio-resource]")?.value.trim() ?? "";
    if (edited("[data-studio-parameters]")) patch.Parameters = parseJsonField(root.querySelector("[data-studio-parameters]")?.value, "Parameters", {});
  } else if (state.Type === "Pass") {
    if (edited("[data-studio-result]")) patch.Result = parseJsonField(root.querySelector("[data-studio-result]")?.value, "Result", {});
  } else if (state.Type === "Wait") {
    if (edited("[data-studio-seconds]")) patch.Seconds = Number(root.querySelector("[data-studio-seconds]")?.value ?? 0);
  } else if (state.Type === "Fail") {
    if (edited("[data-studio-error-name]")) patch.Error = root.querySelector("[data-studio-error-name]")?.value.trim() || undefined;
    if (edited("[data-studio-cause]")) patch.Cause = root.querySelector("[data-studio-cause]")?.value || undefined;
  } else if (state.Type === "Choice") {
    if (edited("[data-studio-choices]")) patch.Choices = parseJsonField(root.querySelector("[data-studio-choices]")?.value, "Choices", []);
    if (edited("[data-studio-default]")) patch.Default = root.querySelector("[data-studio-default]")?.value || undefined;
  } else if (state.Type === "Parallel") {
    if (edited("[data-studio-branches]")) patch.Branches = parseJsonField(root.querySelector("[data-studio-branches]")?.value, "Branches", []);
  } else if (state.Type === "Map") {
    if (edited("[data-studio-items-path]")) patch.ItemsPath = root.querySelector("[data-studio-items-path]")?.value.trim() || "$";
    if (edited("[data-studio-item-processor]")) patch.ItemProcessor = parseJsonField(root.querySelector("[data-studio-item-processor]")?.value, "ItemProcessor", {});
  }
  if (!["Succeed", "Fail", "Choice"].includes(state.Type)) {
    if (edited("[data-studio-next]")) {
      const nextValue = root.querySelector("[data-studio-next]")?.value ?? "";
      if (nextValue) { patch.Next = nextValue; patch.End = undefined; }
      else { patch.End = true; patch.Next = undefined; }
    }
    if (edited("[data-studio-retry]")) {
      const retry = parseJsonField(root.querySelector("[data-studio-retry]")?.value, "Retry", []);
      patch.Retry = Array.isArray(retry) && retry.length ? retry : undefined;
    }
    if (edited("[data-studio-catch]")) {
      const catchers = parseJsonField(root.querySelector("[data-studio-catch]")?.value, "Catch", []);
      patch.Catch = Array.isArray(catchers) && catchers.length ? catchers : undefined;
    }
  }
  next = updateStudioState(next, selected, patch);
  const cleaned = next.States[selected];
  if (edited("[data-studio-comment]") && patch.Comment === undefined) delete cleaned.Comment;
  if (edited("[data-studio-retry]") && patch.Retry === undefined) delete cleaned.Retry;
  if (edited("[data-studio-catch]") && patch.Catch === undefined) delete cleaned.Catch;
  if (edited("[data-studio-next]") && patch.Next === undefined) delete cleaned.Next;
  if (edited("[data-studio-default]") && patch.Default === undefined) delete cleaned.Default;
  if (cleaned.Type === "Wait" && edited("[data-studio-seconds]")) {
    delete cleaned.SecondsPath;
    delete cleaned.Timestamp;
    delete cleaned.TimestampPath;
  }
  if (cleaned.Type === "Map" && edited("[data-studio-item-processor]")) delete cleaned.Iterator;
  if (cleaned.Type === "Fail") {
    if (edited("[data-studio-error-name]") && patch.Error === undefined) delete cleaned.Error;
    if (edited("[data-studio-cause]") && patch.Cause === undefined) delete cleaned.Cause;
  }
  if (nextName !== selected) {
    next = renameStudioState(next, selected, nextName);
    root.dataset.studioSelected = nextName;
  }
  return next;
}

function renderStudio(root) {
  const definition = readDefinition(root);
  let selected = root.dataset.studioSelected;
  if (!selected || !definition.States?.[selected]) selected = definition.StartAt ?? Object.keys(definition.States ?? {})[0] ?? "";
  root.dataset.studioSelected = selected;
  root.querySelector("[data-studio-canvas]").innerHTML = canvasHtml(definition, selected);
  root.querySelector("[data-studio-inspector]").innerHTML = inspectorHtml(definition, selected);
  associateFormLabels(root);
}

function commitStudio(root, mutator) {
  try {
    const current = applyInspector(root);
    const next = mutator ? mutator(current) : current;
    const definition = typeof next === "object" && next && "definition" in next ? next.definition : next;
    if (typeof next === "object" && next && "definition" in next && next.name) root.dataset.studioSelected = next.name;
    else if (!definition.States?.[root.dataset.studioSelected ?? ""]) root.dataset.studioSelected = definition.StartAt ?? Object.keys(definition.States ?? {})[0] ?? "";
    writeDefinition(root, definition);
    showStudioError(root);
    renderStudio(root);
    bindInspectorHandlers(root);
  } catch (error) {
    showStudioError(root, error instanceof Error ? error.message : String(error));
  }
}

function refreshCanvas(root) {
  const definition = readDefinition(root);
  const selected = root.dataset.studioSelected;
  root.querySelector("[data-studio-canvas]").innerHTML = canvasHtml(definition, selected);
  root.querySelectorAll("[data-studio-select]").forEach(button => button.addEventListener("click", () => {
    try {
      writeDefinition(root, applyInspector(root));
      root.dataset.studioSelected = button.dataset.studioSelect;
      showStudioError(root);
      renderStudio(root);
      bindInspectorHandlers(root);
    } catch (error) {
      showStudioError(root, error instanceof Error ? error.message : String(error));
    }
  }));
}

function syncInspectorQuietly(root) {
  try {
    const before = root.dataset.studioSelected;
    const definition = applyInspector(root);
    const selected = Object.keys(definition.States ?? {}).includes(before) ? before : definition.StartAt;
    const renamed = root.querySelector("[data-studio-name]")?.value.trim();
    if (renamed && renamed !== before && definition.States?.[renamed]) root.dataset.studioSelected = renamed;
    else if (selected) root.dataset.studioSelected = selected;
    writeDefinition(root, definition);
    showStudioError(root);
    refreshCanvas(root);
  } catch (error) {
    showStudioError(root, error instanceof Error ? error.message : String(error));
  }
}

function bindInspectorHandlers(root) {
  const inspector = root.querySelector("[data-studio-inspector]");
  inspector.querySelectorAll("input, select, textarea").forEach(control => {
    control.addEventListener("change", () => {
      control.dataset.studioEdited = "true";
      if (control.hasAttribute("data-studio-name") || control.hasAttribute("data-studio-next") || control.hasAttribute("data-studio-default")) commitStudio(root);
      else syncInspectorQuietly(root);
    });
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
  refreshCanvas(root);
}

function activateStudioTab(root, mode, focus = false) {
  try {
    const current = root.querySelector("[data-studio-tab][aria-selected='true']")?.dataset.studioTab;
    if (current === "visual" && mode === "json") {
      writeDefinition(root, applyInspector(root));
    }
    if (current === "json" && mode === "visual") {
      readDefinition(root);
      renderStudio(root);
      bindInspectorHandlers(root);
    }
    showStudioError(root);
  } catch (error) {
    showStudioError(root, error instanceof Error ? error.message : String(error));
    return;
  }
  root.querySelectorAll("[data-studio-tab]").forEach(tab => {
    const active = tab.dataset.studioTab === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll("[data-studio-panel]").forEach(panel => { panel.hidden = panel.dataset.studioPanel !== mode; });
  if (focus) root.querySelector(`[data-studio-tab="${mode}"]`)?.focus();
}

export function syncStudioBeforeSubmit(root) {
  const studio = root.querySelector("[data-sfn-studio]") ?? root;
  if (!studio.querySelector("[data-studio-tab]")) return;
  const mode = studio.querySelector("[data-studio-tab][aria-selected='true']")?.dataset.studioTab;
  if (mode === "visual") writeDefinition(studio, applyInspector(studio), { markDirty: false });
}

export function bindStudioEditor(root) {
  const studio = root.querySelector("[data-sfn-studio]") ?? root;
  const parsed = parseStateMachineDefinition(definitionTextarea(studio).value);
  studio.dataset.studioSelected = parsed?.StartAt ?? Object.keys(parsed?.States ?? {})[0] ?? "";
  try {
    renderStudio(studio);
    bindInspectorHandlers(studio);
    showStudioError(studio);
  } catch (error) {
    showStudioError(studio, error instanceof Error ? error.message : String(error));
    activateStudioTab(studio, "json");
  }
  studio.querySelectorAll("[data-studio-add]").forEach(button => button.addEventListener("click", () => {
    commitStudio(studio, definition => addStudioState(definition, button.dataset.studioAdd, { afterName: studio.dataset.studioSelected }));
  }));
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
  definitionTextarea(studio)?.addEventListener("change", () => {
    if (studio.querySelector("[data-studio-tab][aria-selected='true']")?.dataset.studioTab === "visual") {
      try { renderStudio(studio); bindInspectorHandlers(studio); showStudioError(studio); }
      catch (error) { showStudioError(studio, error instanceof Error ? error.message : String(error)); }
    }
  });
}
