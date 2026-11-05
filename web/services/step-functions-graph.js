// Workflow graph shared by the Workflow Studio canvas, the Definition tab and
// the execution Graph view. A small layered layout (longest-path layers, one
// barycenter ordering pass in each direction, dummy points for edges that skip
// layers) places states top to bottom; Parallel branches and Map item
// processors are laid out recursively inside their state's group box.
import { escapeHtml } from "../components.js";
import { displayLabel, parseStateMachineDefinition, stateResourceLabel } from "./step-functions-model.js";

const SIZE = { nodeW: 200, nodeH: 62, gapX: 30, gapY: 44, pad: 16, header: 62, label: 24, terminalW: 62, terminalH: 28, dummyW: 16, margin: 14, loop: 44 };
const START = "\u0000start";
const END = "\u0000end";
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function itemProcessor(state) {
  const value = state.ItemProcessor ?? state.Iterator;
  return value && typeof value === "object" && value.States && typeof value.States === "object" ? value : null;
}

function childScopes(name, state, path) {
  if (state.Type === "Parallel") {
    return (state.Branches ?? []).map((branch, index) => ({ branch, index })).filter(item => item.branch && typeof item.branch === "object")
      .map(({ branch, index }) => ({ definition: branch, path: `${path}.States.${name}.Branches[${index}]`, label: `${name} · branch ${index + 1}` }));
  }
  if (state.Type === "Map") {
    const processor = itemProcessor(state);
    return processor ? [{ definition: processor, path: `${path}.States.${name}.ItemProcessor`, label: `${name} · item processor` }] : [];
  }
  return [];
}

function ruleLabel(rule, index) {
  if (!rule || typeof rule !== "object") return `Rule ${index + 1}`;
  const operator = Object.keys(rule).find(key => !["Variable", "Next", "Comment"].includes(key));
  if (!operator || ["And", "Or", "Not"].includes(operator) || typeof rule.Variable !== "string") return rule.Comment ? String(rule.Comment) : `Rule ${index + 1}`;
  const symbols = { StringEquals: "==", NumericEquals: "==", BooleanEquals: "==", TimestampEquals: "==", NumericGreaterThan: ">", NumericGreaterThanEquals: ">=", NumericLessThan: "<", NumericLessThanEquals: "<=", StringMatches: "matches" };
  const text = `${rule.Variable} ${symbols[operator] ?? operator} ${typeof rule[operator] === "string" ? `"${rule[operator]}"` : JSON.stringify(rule[operator])}`;
  return text.length > 30 ? `${text.slice(0, 29)}…` : text;
}

function layoutScope(definition, path, depth) {
  const states = definition.States && typeof definition.States === "object" ? definition.States : {};
  const names = Object.keys(states);
  const boxes = new Map();
  for (const name of names) {
    const state = states[name] && typeof states[name] === "object" ? states[name] : {};
    const children = childScopes(name, state, path).map(child => ({ ...child, layout: layoutScope(child.definition, child.path, depth + 1) }));
    let w = SIZE.nodeW;
    let h = SIZE.nodeH;
    if (children.length) {
      const inner = children.reduce((sum, child) => sum + child.layout.width, 0) + SIZE.gapX * (children.length - 1);
      w = Math.max(SIZE.nodeW + 2 * SIZE.pad, inner + 2 * SIZE.pad);
      h = SIZE.header + SIZE.label + Math.max(...children.map(child => child.layout.height)) + SIZE.pad;
    }
    boxes.set(name, { name, state, w, h, children });
  }

  const logical = [];
  const connect = (from, to, label, kind) => {
    if (!to || (to !== END && !boxes.has(to))) return;
    const existing = logical.find(edge => edge.from === from && edge.to === to && edge.kind === kind);
    if (existing) { if (label && !existing.labels.includes(label)) existing.labels.push(label); }
    else logical.push({ from, to, kind, labels: label ? [label] : [] });
  };
  for (const name of names) {
    const state = boxes.get(name).state;
    if (state.Type === "Choice") {
      (Array.isArray(state.Choices) ? state.Choices : []).forEach((rule, index) => connect(name, rule?.Next, ruleLabel(rule, index), "choice"));
      connect(name, state.Default, "Default", "choice");
    } else if (state.Type === "Succeed" || state.Type === "Fail" || state.End) connect(name, END, "", "next");
    else connect(name, state.Next, "", "next");
    for (const rule of Array.isArray(state.Catch) ? state.Catch : []) connect(name, rule?.Next, `Catch ${(rule?.ErrorEquals ?? []).join(", ")}`.trim(), "catch");
  }

  const reachable = new Set();
  const queue = boxes.has(definition.StartAt) ? [definition.StartAt] : [];
  while (queue.length) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const edge of logical) if (edge.from === name && edge.to !== END && !reachable.has(edge.to)) queue.push(edge.to);
  }
  const orphans = names.filter(name => !reachable.has(name));
  const edges = reachable.size ? [{ from: START, to: definition.StartAt, kind: "next", labels: [] }, ...logical.filter(edge => reachable.has(edge.from))] : [];
  const outgoing = id => edges.filter(edge => edge.from === id);

  // Depth-first search marks edges that close a loop; the rest form a DAG.
  const mark = new Map();
  const finished = [];
  const visit = id => {
    mark.set(id, 1);
    for (const edge of outgoing(id)) {
      if (mark.get(edge.to) === 1) edge.back = true;
      else if (!mark.has(edge.to)) visit(edge.to);
    }
    mark.set(id, 2);
    finished.push(id);
  };
  if (reachable.size) visit(START);
  const topological = finished.reverse();
  const layer = new Map([[START, 0]]);
  for (const id of topological) for (const edge of outgoing(id)) if (!edge.back) layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, (layer.get(id) ?? 0) + 1));
  if (layer.has(END)) layer.set(END, Math.max(0, ...[...layer].filter(([id]) => id !== END).map(([, value]) => value)) + 1);

  const node = new Map([[START, { w: SIZE.terminalW, h: SIZE.terminalH }], [END, { w: SIZE.terminalW, h: SIZE.terminalH }]]);
  for (const [name, box] of boxes) node.set(name, box);
  const rows = [];
  const place = (id, index) => (rows[index] ??= []).push(id);
  for (const id of topological) place(id, layer.get(id));
  const segments = [];
  let dummies = 0;
  for (const edge of edges) {
    if (edge.back) continue;
    edge.chain = [edge.from];
    for (let index = layer.get(edge.from) + 1; index < layer.get(edge.to); index++) {
      const id = `\u0000dummy${dummies++}`;
      node.set(id, { w: SIZE.dummyW, h: 0, dummy: true });
      layer.set(id, index);
      place(id, index);
      edge.chain.push(id);
    }
    edge.chain.push(edge.to);
    for (let index = 0; index < edge.chain.length - 1; index++) segments.push([edge.chain[index], edge.chain[index + 1]]);
  }
  for (let index = 0; index < rows.length; index++) rows[index] ??= [];

  const position = new Map();
  const reindex = () => rows.forEach(row => row.forEach((id, index) => position.set(id, index)));
  reindex();
  const sweep = down => {
    const indexes = down ? rows.map((_, index) => index).slice(1) : rows.map((_, index) => index).slice(0, -1).reverse();
    for (const index of indexes) {
      const weight = id => {
        const neighbours = segments.filter(segment => (down ? segment[1] : segment[0]) === id).map(segment => position.get(down ? segment[0] : segment[1]));
        return neighbours.length ? average(neighbours) : position.get(id);
      };
      rows[index] = rows[index].map(id => [id, weight(id)]).sort((left, right) => left[1] - right[1]).map(([id]) => id);
      reindex();
    }
  };
  sweep(true); sweep(false); sweep(true);

  const x = new Map();
  for (const row of rows) {
    const desired = row.map(id => {
      const centres = segments.filter(segment => segment[1] === id).map(segment => x.get(segment[0]) + node.get(segment[0]).w / 2);
      return centres.length ? average(centres) : null;
    });
    let cursor = null;
    const placed = row.map((id, index) => {
      const width = node.get(id).w;
      let left = desired[index] === null ? cursor ?? 0 : desired[index] - width / 2;
      if (cursor !== null && left < cursor) left = cursor;
      cursor = left + width + SIZE.gapX;
      return left;
    });
    const drift = row.map((id, index) => desired[index] === null ? null : desired[index] - (placed[index] + node.get(id).w / 2)).filter(value => value !== null);
    const shift = drift.length ? average(drift) : 0;
    row.forEach((id, index) => x.set(id, placed[index] + shift));
  }
  const minimum = Math.min(0, ...x.values());
  for (const [id, value] of x) x.set(id, value - minimum);
  // A loop edge runs down the side nearer its source; leave room on the left when needed.
  const loopsLeft = edge => x.get(edge.from) + node.get(edge.from).w / 2 < x.get(edge.to) + node.get(edge.to).w / 2;
  const leftMargin = Math.max(0, ...edges.filter(edge => edge.back && loopsLeft(edge)).map(edge => SIZE.loop + 6 - Math.min(x.get(edge.from), x.get(edge.to))));
  if (leftMargin) for (const [id, value] of x) x.set(id, value + leftMargin);

  const top = [];
  const bottom = [];
  let cursorY = 0;
  rows.forEach((row, index) => {
    const height = Math.max(0, ...row.map(id => node.get(id).h));
    top[index] = cursorY;
    bottom[index] = cursorY + height;
    cursorY += height + SIZE.gapY;
  });
  let width = Math.max(0, ...[...x].map(([id, value]) => value + node.get(id).w));
  let height = rows.length ? cursorY - SIZE.gapY : 0;
  const centre = id => x.get(id) + node.get(id).w / 2;
  const nodeTop = id => top[layer.get(id)];

  const paths = [];
  const labels = [];
  const labelStack = new Map();
  for (const edge of edges) {
    const text = edge.labels.join(" / ");
    if (edge.back) {
      const left = loopsLeft(edge);
      const from = { x: x.get(edge.from) + (left ? 0 : node.get(edge.from).w), y: nodeTop(edge.from) + node.get(edge.from).h / 2 };
      const to = { x: x.get(edge.to) + (left ? 0 : node.get(edge.to).w), y: nodeTop(edge.to) + node.get(edge.to).h / 2 };
      const bulge = left ? Math.min(from.x, to.x) - SIZE.loop : Math.max(from.x, to.x) + SIZE.loop;
      width = Math.max(width, bulge + 6);
      paths.push({ d: `M ${from.x} ${from.y} C ${bulge} ${from.y}, ${bulge} ${to.y}, ${to.x} ${to.y}`, kind: edge.kind, back: true });
      labels.push({ x: left ? bulge + 14 : bulge - 14, y: (from.y + to.y) / 2, text: text || "Loop", kind: edge.kind });
      continue;
    }
    const points = [{ x: centre(edge.from), y: nodeTop(edge.from) + node.get(edge.from).h }];
    for (const id of edge.chain.slice(1, -1)) points.push({ x: centre(id), y: top[layer.get(id)], through: bottom[layer.get(id)] });
    points.push({ x: centre(edge.to), y: nodeTop(edge.to) });
    let d = `M ${points[0].x} ${points[0].y}`;
    let from = points[0];
    for (const point of points.slice(1)) {
      const middle = (from.y + point.y) / 2;
      d += ` C ${from.x} ${middle}, ${point.x} ${middle}, ${point.x} ${point.y}`;
      from = point;
      if (point.through !== undefined) { d += ` L ${point.x} ${point.through}`; from = { x: point.x, y: point.through }; }
    }
    paths.push({ d, kind: edge.kind });
    if (text) {
      // Sit the label just above the node (or bend) the edge leads to, stacking when several edges arrive there.
      const key = edge.chain[1];
      const stacked = labelStack.get(key) ?? 0;
      labelStack.set(key, stacked + 1);
      labels.push({ x: points[1].x, y: points[1].y - 13 - stacked * 17, text, kind: edge.kind });
    }
  }

  const items = [];
  const embed = id => {
    const box = boxes.get(id);
    const left = x.get(id);
    const upper = id === undefined ? 0 : box.y ?? nodeTop(id);
    items.push({ kind: "state", name: box.name, state: box.state, scopePath: path, depth, x: left, y: upper, w: box.w, h: box.h, container: box.children.length > 0 });
    const inner = box.children.reduce((sum, child) => sum + child.layout.width, 0) + SIZE.gapX * Math.max(0, box.children.length - 1);
    let childX = left + (box.w - inner) / 2;
    for (const child of box.children) {
      const childY = upper + SIZE.header + SIZE.label;
      items.push({ kind: "scope", text: child.label, x: childX, y: upper + SIZE.header, w: child.layout.width });
      for (const item of child.layout.items) items.push({ ...item, x: item.x + childX, y: item.y + childY });
      for (const item of child.layout.paths) paths.push({ ...item, d: translatePath(item.d, childX, childY) });
      for (const item of child.layout.labels) labels.push({ ...item, x: item.x + childX, y: item.y + childY });
      childX += child.layout.width + SIZE.gapX;
    }
  };
  for (const id of topological) {
    if (id === START || id === END) items.push({ kind: "terminal", text: id === START ? "Start" : "End", x: x.get(id), y: nodeTop(id), w: SIZE.terminalW, h: SIZE.terminalH });
    else embed(id);
  }
  if (orphans.length) {
    let orphanX = 0;
    const headingY = height ? height + SIZE.gapY : 0;
    items.push({ kind: "heading", text: "Unreachable states", x: 0, y: headingY });
    let tallest = 0;
    for (const name of orphans) {
      const box = boxes.get(name);
      box.y = headingY + 30;
      x.set(name, orphanX);
      embed(name);
      orphanX += box.w + SIZE.gapX;
      tallest = Math.max(tallest, box.h);
    }
    width = Math.max(width, orphanX - SIZE.gapX, 190);
    height = headingY + 30 + tallest;
  }
  return { width, height, items, paths, labels };
}

function translatePath(d, dx, dy) {
  let isX = true;
  return d.replace(/-?\d+(?:\.\d+)?/g, value => {
    const moved = Number(value) + (isX ? dx : dy);
    isX = !isX;
    return String(Math.round(moved * 10) / 10);
  });
}

const TYPE_LABELS = { Succeed: "Success" };

function nodeMarkup(item, options) {
  const { mode, selectedName, results } = options;
  const result = results?.get(item.name);
  const status = result?.status;
  const type = String(item.state.Type ?? "State");
  const resource = stateResourceLabel(item.state);
  const retry = Array.isArray(item.state.Retry) ? item.state.Retry.length : 0;
  const catchers = Array.isArray(item.state.Catch) ? item.state.Catch.length : 0;
  const meta = [resource, retry ? `${retry} retr${retry === 1 ? "y" : "ies"}` : "", catchers ? `${catchers} catch` : "", mode === "execution" && status ? displayLabel(status) : ""].filter(Boolean).join(" · ");
  const note = result?.waitingForCallback ? "Waiting for callback" : "";
  const classes = ["sfn-flow-node", `type-${escapeHtml(type.toLowerCase())}`];
  if (status) classes.push(`status-${status.toLowerCase().replaceAll("_", "-")}`);
  if (status === "IN_PROGRESS") classes.push("active");
  if (item.name === selectedName) classes.push("selected");
  if (item.container) classes.push("group-header");
  if (item.name === options.startAt && item.depth === 0) classes.push("start");
  const box = item.container ? { x: item.x + 8, y: item.y + 8, w: item.w - 16, h: SIZE.header - 16 } : item;
  const style = `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;
  const content = `<span class="sfn-flow-type">${escapeHtml(TYPE_LABELS[type] ?? type)} state</span><strong>${escapeHtml(item.name)}</strong>${note ? `<small class="sfn-flow-note">${escapeHtml(note)}</small>` : meta && !item.container ? `<small>${escapeHtml(meta)}</small>` : ""}`;
  const title = escapeHtml([item.name, item.state.Resource, meta].filter(Boolean).join("\n"));
  const group = item.container ? `<div class="sfn-flow-group type-${escapeHtml(type.toLowerCase())}${status ? ` status-${status.toLowerCase().replaceAll("_", "-")}` : ""}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px" aria-hidden="true"></div>` : "";
  if (mode === "execution") return `${group}<button type="button" class="${classes.join(" ")}" style="${style}" title="${title}" data-state-name="${escapeHtml(item.name)}" data-state-scope="${escapeHtml(item.scopePath)}" aria-label="Inspect ${escapeHtml(item.name)} state">${content}</button>`;
  if (mode === "design" && item.depth === 0) return `${group}<button type="button" class="${classes.join(" ")}" style="${style}" title="${title}" data-studio-select="${escapeHtml(item.name)}" aria-label="Edit ${escapeHtml(item.name)} state" aria-pressed="${item.name === selectedName}">${content}</button>`;
  return `${group}<div class="${classes.join(" ")}" style="${style}" title="${title}">${content}</div>`;
}

/**
 * Renders a workflow graph.
 * mode "definition": read-only; "execution": state buttons coloured by result;
 * "design": top-level state buttons that select a state for editing.
 */
export function flowGraphHtml(definition, options = {}) {
  const root = parseStateMachineDefinition(definition);
  if (!root) return '<div class="sfn-data-state absent">The definition could not be parsed for graph display.</div>';
  if (!Object.keys(root.States).length) return `<div class="sfn-data-state absent">${escapeHtml(options.emptyMessage ?? "The definition has no states.")}</div>`;
  const layout = layoutScope(root, "$", 0);
  const settings = { mode: "definition", ...options, startAt: root.StartAt };
  const shift = SIZE.margin;
  const width = Math.ceil(layout.width + shift * 2);
  const height = Math.ceil(layout.height + shift * 2);
  const paths = layout.paths.map(path => `<path class="sfn-flow-edge ${escapeHtml(path.kind)}${path.back ? " back" : ""}" d="${path.d}" marker-end="url(#sfn-flow-arrow-${path.kind === "catch" ? "catch" : "next"})"/>`).join("");
  const body = layout.items.map(item => {
    if (item.kind === "terminal") return `<span class="sfn-flow-terminal ${item.text === "Start" ? "start" : "end"}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px">${item.text}</span>`;
    if (item.kind === "scope") return `<h3 class="sfn-flow-scope" style="left:${item.x}px;top:${item.y}px;width:${item.w}px">${escapeHtml(item.text)}</h3>`;
    if (item.kind === "heading") return `<h4 class="sfn-flow-heading" style="left:${item.x}px;top:${item.y}px">${escapeHtml(item.text)}</h4>`;
    return nodeMarkup(item, settings);
  }).join("");
  const labels = layout.labels.map(label => `<span class="sfn-flow-label ${escapeHtml(label.kind)}" style="left:${label.x}px;top:${label.y}px">${escapeHtml(label.text)}</span>`).join("");
  const zoom = Number(options.zoom) > 0 ? Number(options.zoom) : 1;
  return `<div class="sfn-flow-viewport" data-flow-viewport tabindex="0" aria-label="${escapeHtml(options.label ?? "Workflow graph")}"><div class="sfn-flow" data-flow style="width:${width}px;height:${height}px;zoom:${zoom}"><svg class="sfn-flow-edges" width="${width}" height="${height}" viewBox="${-shift} ${-shift} ${width} ${height}" aria-hidden="true"><defs><marker id="sfn-flow-arrow-next" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="sfn-flow-arrow"/></marker><marker id="sfn-flow-arrow-catch" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="sfn-flow-arrow catch"/></marker></defs>${paths}</svg><div class="sfn-flow-items" style="left:${shift}px;top:${shift}px">${body}${labels}</div></div></div>`;
}

const LEGEND = [["SUCCEEDED", "Succeeded"], ["FAILED", "Failed"], ["CAUGHT_ERROR", "Caught error"], ["IN_PROGRESS", "In progress"], ["CANCELLED", "Cancelled"], ["NOT_STARTED", "Not started"]];

export function flowLegendHtml() {
  return `<ul class="sfn-flow-legend" aria-label="Graph legend">${LEGEND.map(([status, label]) => `<li><i class="status-${status.toLowerCase().replaceAll("_", "-")}" aria-hidden="true"></i>${label}</li>`).join("")}</ul>`;
}

export function flowToolbarHtml({ legend = false, extra = "" } = {}) {
  return `<div class="sfn-flow-toolbar"><div class="sfn-flow-controls" role="group" aria-label="Graph controls"><button class="button" type="button" data-flow-zoom="in" aria-label="Zoom in" title="Zoom in">+</button><button class="button" type="button" data-flow-zoom="out" aria-label="Zoom out" title="Zoom out">−</button><button class="button" type="button" data-flow-zoom="reset" aria-label="Center" title="Center and reset zoom">Center</button><button class="button" type="button" data-flow-fullscreen aria-label="Full screen" title="Full screen">Full screen</button>${extra}</div>${legend ? flowLegendHtml() : ""}</div>`;
}

/** Wires zoom, center and full screen for every graph inside root. onZoom lets a caller keep the zoom across re-renders. */
export function bindFlowControls(root, { onZoom } = {}) {
  const apply = value => {
    const zoom = Math.min(2, Math.max(0.4, Math.round(value * 100) / 100));
    root.querySelectorAll("[data-flow]").forEach(flow => { flow.style.zoom = String(zoom); });
    onZoom?.(zoom);
    return zoom;
  };
  const current = () => Number(root.querySelector("[data-flow]")?.style.zoom || 1) || 1;
  root.querySelectorAll("[data-flow-zoom]").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.flowZoom === "in") apply(current() + 0.2);
    else if (button.dataset.flowZoom === "out") apply(current() - 0.2);
    else {
      apply(1);
      root.querySelectorAll("[data-flow-viewport]").forEach(viewport => { viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2); viewport.scrollTop = 0; });
    }
  }));
  root.querySelectorAll("[data-flow-fullscreen]").forEach(button => button.addEventListener("click", () => {
    const viewport = button.closest(".sfn-flow-host")?.querySelector("[data-flow-viewport]") ?? root.querySelector("[data-flow-viewport]");
    if (!viewport) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else viewport.requestFullscreen?.().catch(() => undefined);
  }));
}

/** Exposed for tests: the computed geometry of a definition. */
export function flowLayout(definition) {
  const root = parseStateMachineDefinition(definition);
  return root ? layoutScope(root, "$", 0) : null;
}
