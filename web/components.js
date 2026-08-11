export const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
let generatedFieldId = 0;

const nextFieldId = () => `stacksim-field-${++generatedFieldId}`;

export function associateFormLabels(root = document) {
  root.querySelectorAll(".filter input").forEach(input => {
    if (!input.hasAttribute("aria-label")) input.setAttribute("aria-label", input.getAttribute("placeholder") || "Filter resources");
  });
  root.querySelectorAll(".field > label").forEach(label => {
    const field = label.closest(".field");
    const controls = [...field.querySelectorAll("input, select, textarea")]
      .filter(control => control.closest(".field") === field && !label.contains(control));
    if (!controls.length) return;

    const first = controls[0];
    if (!first.id) first.id = nextFieldId();
    label.htmlFor = first.id;

    if (controls.length > 1) {
      if (!label.id) label.id = nextFieldId();
      controls.slice(1).forEach(control => {
        if (!control.hasAttribute("aria-label") && !control.hasAttribute("aria-labelledby")) control.setAttribute("aria-labelledby", label.id);
      });
    }
  });
}
export const formatDate = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value)) : "–";
export const loading = label => `<div class="loading" role="status"><span></span>${escapeHtml(label)}</div>`;
export const appLayout = (navigation, breadcrumbs, content) => `<aside class="sidebar">${navigation}</aside><div class="workspace"><div class="service-header">${breadcrumbs}</div><main tabindex="-1">${content}</main></div>`;
export const pageHeader = (title, description, actions = "") => `<div class="page-header"><div class="page-title"><h1>${escapeHtml(title)}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
export const panelHelp = (label, { description, support, level = "" }) => {
  const tooltipId = nextFieldId();
  return `<span class="panel-help"><button type="button" class="panel-help-button" aria-label="About ${escapeHtml(label)}" aria-describedby="${tooltipId}">?</button><span class="panel-help-tooltip" id="${tooltipId}" role="tooltip"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(description)}</span><span class="panel-help-support"><b>StackSim support${level ? ` · ${escapeHtml(level)}` : ""}</b>${escapeHtml(support)}</span></span></span>`;
};
export const panelHeading = (title, help, meta = "", headingTag = "h2") => `<div class="panel-title-row"><${headingTag}>${escapeHtml(title)}${meta ? ` <span class="muted">${escapeHtml(meta)}</span>` : ""}</${headingTag}>${panelHelp(title, help)}</div>`;
export const breadcrumbGroup = (service, items, hash = location.hash) => {
  const route = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const routeLabels = route.map(part => {
    try { return decodeURIComponent(part); }
    catch { return part; }
  });
  const destinations = {
    "lambda:Functions": "#/lambda/functions",
    "dynamodb:Tables": "#/dynamodb/tables",
    "dynamodb:Tools": null,
    "apigateway:APIs": "#/apigateway/apis",
    "cloudwatch:Log groups": "#/cloudwatch/log-groups",
    "iam:Roles": "#/iam/roles",
    "iam:Policies": "#/iam/policies",
  };
  const normalizedItems = service === "cloudwatch"
    ? items.filter((item, index) => !(String(typeof item === "string" ? item : item.label) === "Logs" && String(typeof items[index + 1] === "string" ? items[index + 1] : items[index + 1]?.label) === "Log groups"))
    : [...items];
  if (service === "cloudwatch" && routeLabels[3] === "streams" && routeLabels[4]) {
    const streamName = routeLabels[4];
    const lastLabel = normalizedItems.length ? (typeof normalizedItems.at(-1) === "string" ? normalizedItems.at(-1) : normalizedItems.at(-1).label) : undefined;
    if (lastLabel !== streamName) normalizedItems.push(streamName);
  }
  const crumbs = normalizedItems.map((item, index) => {
    const label = typeof item === "string" ? item : item.label;
    if (index === normalizedItems.length - 1) return `<span aria-current="page">${escapeHtml(label)}</span>`;
    const explicit = typeof item === "object" ? item.href : undefined;
    const destinationKey = `${service}:${label}`;
    if (explicit === undefined && Object.hasOwn(destinations, destinationKey) && destinations[destinationKey] === null) return `<span>${escapeHtml(label)}</span>`;
    const href = explicit ?? destinations[destinationKey] ?? `#/${routeLabels.slice(0, Math.max(1, index + 1)).map(encodeURIComponent).join("/") || service}`;
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
  return `<nav aria-label="Breadcrumbs">${[`<a href="#/home">Local console</a>`, ...crumbs].join('<span class="chevron" aria-hidden="true">›</span>')}</nav>`;
};
export const sideNavigation = (metadata, activeHash, pinnedServices = []) => {
  const activeHref = metadata.links
    .filter(([, href, disabled]) => !disabled && (activeHash === href || activeHash.startsWith(`${href}/`)))
    .map(([, href]) => href)
    .sort((left, right) => right.length - left.length)[0];
  const pinnedLinks = [...pinnedServices]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map(service => `<a class="pinned-service-button" data-pinned-service-key="${escapeHtml(service.key)}" href="${escapeHtml(service.href)}"><span class="service-icon ${escapeHtml(service.cls)}" aria-hidden="true">${escapeHtml(service.icon)}</span><span>${escapeHtml(service.name)}</span></a>`)
    .join("");
  const inlinePinned = metadata.key === "home" && pinnedLinks ? `<div class="pinned-service-list inline">${pinnedLinks}</div>` : "";
  const separatedPinned = metadata.key !== "home" && pinnedLinks ? `<div class="pinned-service-list separated">${pinnedLinks}</div>` : "";
  return `<div class="side-brand"><span class="service-icon ${escapeHtml(metadata.cls)}" aria-hidden="true">${escapeHtml(metadata.icon)}</span><span>${escapeHtml(metadata.name)}</span></div><nav aria-label="${escapeHtml(metadata.name)} navigation"><div class="side-section ${separatedPinned ? "has-pinned-services" : ""}"><div class="side-label">${escapeHtml(metadata.key === "home" ? "Navigation" : metadata.name)}</div>${metadata.links.map(([label, href, disabled]) => disabled ? `<span class="side-link muted" aria-disabled="true" title="Not implemented yet">${escapeHtml(label)}</span>` : `<a class="side-link ${href === activeHref ? "active" : ""}" href="${escapeHtml(href)}" ${href === activeHref ? 'aria-current="page"' : ""}>${escapeHtml(label)}</a>`).join("")}${inlinePinned}</div>${separatedPinned}</nav>`;
};
export const container = (title, content, actions = "") => `<section class="card"><div class="card-header"><h2>${escapeHtml(title)}</h2>${actions}</div>${content}</section>`;
export const emptyState = (icon, title, text, action = "") => `<div class="empty"><div class="empty-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
export const statusIndicator = (label, type = "success") => `<span class="status ${escapeHtml(type)}">${escapeHtml(label)}</span>`;
export const alert = (type, title, content) => `<div class="alert ${escapeHtml(type)}" role="alert"><strong>${escapeHtml(title)}</strong><br>${content}</div>`;
export const flashbar = items => `<section class="flashbar" aria-label="Notifications">${items.map(item => alert(item.type ?? "info", item.title, item.content ?? "")).join("")}</section>`;
export const formField = (label, control, hint = "") => {
  const existingId = control.match(/<(?:input|select|textarea)\b[^>]*\bid=["']([^"']+)["']/i)?.[1];
  const controlId = existingId ?? nextFieldId();
  const labelledControl = existingId ? control : control.replace(/<(input|select|textarea)\b/i, `<$1 id="${controlId}"`);
  return `<div class="field"><label for="${escapeHtml(controlId)}">${escapeHtml(label)}</label>${labelledControl}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</div>`;
};
export const tabs = items => `<div class="tabs" role="tablist">${items.map(item => `<a class="tab ${item.active ? "active" : ""}" href="${escapeHtml(item.href)}" role="tab" aria-selected="${item.active}" tabindex="${item.active ? "0" : "-1"}">${escapeHtml(item.label)}</a>`).join("")}</div>`;
export const keyValuePairs = entries => `<dl class="key-value">${entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join("")}</dl>`;
export const collectionTable = (headings, rows) => `<div class="table-wrap"><table><thead><tr>${headings.map(value => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
export const propertyFilter = placeholder => `<label class="filter"><span>⌕</span><input data-filter-table placeholder="${escapeHtml(placeholder)}"></label>`;
export const pagination = (previousDisabled, nextDisabled) => `<nav class="pagination" aria-label="Pagination"><button class="button" type="button" data-page="previous" aria-label="Previous page" ${previousDisabled ? "disabled" : ""}>‹</button><button class="button" type="button" data-page="next" aria-label="Next page" ${nextDisabled ? "disabled" : ""}>›</button></nav>`;
export const loadingSkeleton = () => `<div class="skeleton" aria-label="Loading"><i></i><i></i><i></i></div>`;
export const chartPlaceholder = label => `<div class="chart-placeholder" role="img" aria-label="${escapeHtml(label)}"><span>${escapeHtml(label)}</span></div>`;
export const metricChart = (series, label = "Metric graph") => {
  const values = series.flatMap(item => item.values ?? []);
  if (!values.length) return `<div class="chart-placeholder" role="img" aria-label="${escapeHtml(label)}"><span>No metric data in this time range</span></div>`;
  const width = 760; const height = 240; const padding = 34; const minimum = Math.min(0, ...values); const maximum = Math.max(...values); const span = maximum - minimum || 1;
  const toMillis = value => typeof value === "number" && Math.abs(value) < 1e12 ? value * 1000 : new Date(value).getTime();
  const allTimes = series.flatMap(item => item.timestamps ?? []).map(toMillis); const first = Math.min(...allTimes); const last = Math.max(...allTimes); const timeSpan = last - first || 1; const colors = ["#0972d3", "#d13212", "#037f0c", "#8a2be2", "#ff9900"];
  const paths = series.map((item, index) => { const points = (item.values ?? []).map((value, point) => { const time = toMillis(item.timestamps?.[point] ?? first); const x = padding + ((time - first) / timeSpan) * (width - padding * 2); const y = height - padding - ((value - minimum) / span) * (height - padding * 2); return { x: x.toFixed(1), y: y.toFixed(1) }; }); const color = colors[index % colors.length]; return `<polyline points="${points.map(point => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="3.5" fill="${color}" vector-effect="non-scaling-stroke"/>`).join("")}`; }).join("");
  const legend = series.map((item, index) => `<span><i style="background:${colors[index % colors.length]}"></i>${escapeHtml(item.label ?? item.id ?? `Series ${index + 1}`)}</span>`).join("");
  return `<div class="metric-chart" role="img" aria-label="${escapeHtml(label)}"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"/><line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}"/><text x="4" y="${padding + 5}">${escapeHtml(maximum.toFixed(2))}</text><text x="4" y="${height - padding}">${escapeHtml(minimum.toFixed(2))}</text>${paths}</svg><div class="metric-legend">${legend}</div></div>`;
};
export const codeEditor = (name, value = "") => `<textarea class="code-editor" name="${escapeHtml(name)}" spellcheck="false">${escapeHtml(value)}</textarea>`;
export const textarea = (name, value = "") => `<textarea name="${escapeHtml(name)}">${escapeHtml(value)}</textarea>`;
export const copyButton = value => `<button class="button" type="button" data-copy="${escapeHtml(value)}">Copy</button>`;
export const select = (name, options) => `<select name="${escapeHtml(name)}">${options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select>`;
export const autosuggest = (name, values) => `<input name="${escapeHtml(name)}" list="${escapeHtml(name)}-values"><datalist id="${escapeHtml(name)}-values">${values.map(value => `<option value="${escapeHtml(value)}">`).join("")}</datalist>`;
export const wizard = (step, total, content) => `<section class="wizard"><p class="muted">Step ${step} of ${total}</p>${content}</section>`;
export const splitPanel = (primary, secondary) => `<div class="split-panel"><div>${primary}</div><aside>${secondary}</aside></div>`;
export const confirmationDialog = (name, message) => { const id = nextFieldId(); return `<p>${escapeHtml(message)}</p><div class="field"><label for="${id}">To confirm deletion, enter <strong>${escapeHtml(name)}</strong></label><input id="${id}" name="confirmation" required pattern="${escapeHtml(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}"></div>`; };
export const modal = (title, body, submitLabel = "Save", options = {}) => `<div class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button type="button" class="modal-close" data-modal-close aria-label="Close">×</button></div><div class="modal-body">${body}</div><div class="modal-footer">${options.footerStart ? `${options.footerStart}<span class="modal-footer-spacer" aria-hidden="true"></span>` : ""}<button type="button" class="button" data-modal-close>${escapeHtml(options.cancelLabel ?? "Cancel")}</button><button class="button ${options.danger ? "danger" : "primary"}" id="modal-submit" value="default">${escapeHtml(submitLabel)}</button></div>`;
