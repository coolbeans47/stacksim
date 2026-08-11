import { escapeHtml } from "./components.js";
import { dynamo } from "./api-client.js";
import { session } from "./state.js";

export function bindGlobalSearch(input, serviceMeta, toast, requestNavigation = target => { location.hash = target; }) {
  const panel = document.createElement("div");
  panel.className = "global-search-results";
  panel.id = "global-search-results";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-controls", panel.id);
  input.setAttribute("aria-expanded", "false");
  input.closest(".global-search").append(panel);
  let active = -1;
  let resourceResults = [];
  let loadingResources = false;
  let loadedRegion;
  let loadGeneration = 0;

  const matches = rawValue => {
    const value = rawValue.trim().toLowerCase();
    if (!value) return [];
    const services = Object.values(serviceMeta).filter(service => service.key !== "home" && (service.name.toLowerCase().includes(value) || service.search.some(term => term.includes(value) || value.includes(term)))).map(service => ({
      kind: "service",
      name: service.name,
      description: service.search.slice(0, 3).join(" · "),
      icon: service.icon,
      cls: service.cls,
      target: service.links.find(link => !link[2])?.[1] ?? "#/home",
      search: service.search,
    }));
    const operations = [...readOperations("stacksim:dynamodb:partiql-history", "PartiQL history"), ...readOperations("stacksim:dynamodb:partiql-saved", "Saved PartiQL operation")];
    const resources = [...resourceResults, ...operations].filter(resource => resource.search.some(term => term.includes(value) || value.includes(term)));
    return [...resources, ...services].slice(0, 30);
  };
  const close = () => {
    panel.hidden = true;
    panel.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const render = () => {
    const value = input.value.trim().toLowerCase();
    if (!value) return close();
    const results = matches(value);
    panel.innerHTML = results.length ? results.map((entry, index) => `<a id="global-search-option-${index}" role="option" tabindex="-1" aria-selected="${index === active}" class="global-search-result ${index === active ? "active" : ""}" href="${escapeHtml(entry.target)}" data-search-index="${index}"><span class="service-icon ${escapeHtml(entry.cls)}">${escapeHtml(entry.icon)}</span><span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.description)}</small></span>${entry.kind === "resource" ? '<span class="global-search-kind">Resource</span>' : ""}</a>`).join("") : `<div class="global-search-empty" role="status">${loadingResources ? "Searching local resources…" : "No matching local services or resources"}</div>`;
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `global-search-option-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  const loadResources = async (force = false) => {
    if (loadingResources || (!force && loadedRegion === session.region)) return;
    const region = session.region; const generation = ++loadGeneration; loadingResources = true; render();
    try {
      const names = []; let start;
      do {
        const page = await dynamo("ListTables", { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) });
        names.push(...(page.TableNames ?? [])); start = page.LastEvaluatedTableName;
      } while (start);
      const tables = await Promise.all(names.map(async name => {
        const described = await dynamo("DescribeTable", { TableName: name });
        let tags = [];
        try { tags = (await dynamo("ListTagsOfResource", { ResourceArn: described.Table.TableArn })).Tags ?? []; } catch { /* resource discovery remains useful when tags are unauthorized */ }
        return { table: described.Table, tags };
      }));
      const discovered = tables.flatMap(({ table, tags }) => {
        const tagTerms = tags.flatMap(tag => [String(tag.Key).toLowerCase(), String(tag.Value).toLowerCase(), `${tag.Key}:${tag.Value}`.toLowerCase()]);
        const tableEntry = {
          kind: "resource", name: table.TableName, description: `DynamoDB table · ${table.ItemCount ?? 0} items${tags.length ? ` · ${tags.map(tag => `${tag.Key}=${tag.Value}`).join(", ")}` : ""}`,
          icon: "D", cls: "db", target: `#/dynamodb/tables/${encodeURIComponent(table.TableName)}/overview`,
          search: [table.TableName.toLowerCase(), "dynamodb", "table", ...table.KeySchema.map(key => key.AttributeName.toLowerCase()), ...tagTerms],
        };
        const indexEntries = [...(table.LocalSecondaryIndexes ?? []).map(index => ({ index, type: "local" })), ...(table.GlobalSecondaryIndexes ?? []).map(index => ({ index, type: "global" }))].map(({ index, type }) => ({
          kind: "resource", name: index.IndexName, description: `DynamoDB ${type} secondary index · ${table.TableName}`,
          icon: "D", cls: "db", target: `#/dynamodb/tables/${encodeURIComponent(table.TableName)}/indexes`,
          search: [index.IndexName.toLowerCase(), table.TableName.toLowerCase(), "dynamodb", "index", ...index.KeySchema.map(key => key.AttributeName.toLowerCase()), ...tagTerms],
        }));
        return [tableEntry, ...indexEntries];
      });
      if (generation !== loadGeneration || region !== session.region) return;
      resourceResults = discovered; loadedRegion = region;
    } catch {
      if (generation === loadGeneration && region === session.region) resourceResults = [];
    } finally { if (generation === loadGeneration) { const regionChanged = region !== session.region; loadingResources = false; render(); if (regionChanged) void loadResources(true); } }
  };
  input.addEventListener("focus", () => { void loadResources(true); });
  input.addEventListener("input", () => { active = -1; render(); void loadResources(); });
  input.addEventListener("keydown", event => {
    const results = matches(input.value.trim().toLowerCase());
    if (event.key === "Escape") { close(); return; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
      event.preventDefault();
      active = event.key === "ArrowDown" ? (active + 1) % results.length : (active - 1 + results.length) % results.length;
      render();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const match = results[Math.max(active, 0)];
    if (!match) toast("No matching local services or resources", "error");
    else requestNavigation(match.target);
    input.value = "";
    close();
  });
  panel.addEventListener("click", event => {
    const link = event.target.closest?.('a[href^="#/"]');
    if (!link) return;
    event.preventDefault();
    requestNavigation(link.getAttribute("href"));
    input.value = "";
    close();
  });
  document.addEventListener("click", event => { if (!event.target.closest?.(".global-search")) close(); });
}

function readOperations(key, label) {
  try {
    const entries = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(entries)) return [];
    return entries.slice(0, 100).map(entry => {
      const statement = String(entry.statement ?? entry.statements ?? "").replace(/\s+/g, " ").trim();
      const name = String(entry.name ?? (statement.slice(0, 80) || label));
      return {
        kind: "resource", name, description: `${label} · ${String(entry.operation ?? entry.mode ?? "run").toUpperCase()}`,
        icon: "D", cls: "db", target: "#/dynamodb/partiql",
        search: [name.toLowerCase(), statement.toLowerCase(), label.toLowerCase(), "partiql", "dynamodb"],
      };
    });
  } catch { return []; }
}
