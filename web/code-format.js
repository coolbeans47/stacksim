import hljs from "./vendor/highlightjs/es/core.min.js";
import javascript from "./vendor/highlightjs/es/languages/javascript.min.js";
import json from "./vendor/highlightjs/es/languages/json.min.js";

hljs.registerLanguage("json", json);
hljs.registerLanguage("javascript", javascript);

const THEME_LINK_ID = "stacksim-code-format-theme";
const LANGUAGE_ALIASES = {
  js: "javascript",
  javascript: "javascript",
  json: "json",
};

function normalizeLanguage(language = "json") {
  return LANGUAGE_ALIASES[String(language).toLowerCase()] ?? "javascript";
}

function themeHref() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return `/_stacksim/console/vendor/highlightjs/styles/${dark ? "github-dark" : "github"}.min.css`;
}

function ensureTheme() {
  let link = document.getElementById(THEME_LINK_ID);
  if (!link) {
    link = document.createElement("link");
    link.id = THEME_LINK_ID;
    link.rel = "stylesheet";
    document.head.append(link);
  }
  const href = themeHref();
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}

function parseJsonDeep(value, depth = 0) {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"')) return value;
    try { return parseJsonDeep(JSON.parse(trimmed), depth + 1); }
    catch { return value; }
  }
  if (Array.isArray(value)) return value.map(item => parseJsonDeep(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseJsonDeep(item, depth + 1)]));
  }
  return value;
}

/** Pretty-print a value for JSON or JavaScript display. */
export function formatCode(value, language = "json") {
  const lang = normalizeLanguage(language);
  if (lang === "json") {
    if (typeof value === "string") {
      try { return JSON.stringify(parseJsonDeep(JSON.parse(value)), null, 2); }
      catch {
        try { return JSON.stringify(parseJsonDeep(value), null, 2); }
        catch { return value; }
      }
    }
    try { return JSON.stringify(parseJsonDeep(value), null, 2); }
    catch { return String(value ?? ""); }
  }
  return typeof value === "string" ? value : String(value ?? "");
}

/** Return highlight.js HTML for a pretty-printed value. */
export function highlightCode(value, language = "json") {
  ensureTheme();
  const lang = normalizeLanguage(language);
  const source = formatCode(value, lang);
  return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
}

/** Render highlighted code into an element (typically a <pre>). */
export function renderHighlightedCode(element, value, language = "json") {
  if (!element) return;
  ensureTheme();
  element.classList.add("code-box", "code-highlight", "hljs");
  element.innerHTML = highlightCode(value, language);
}

/** Render plain text into an element without highlighting. */
export function renderPlainCode(element, value) {
  if (!element) return;
  element.classList.add("code-box");
  element.classList.remove("code-highlight", "hljs");
  element.textContent = value == null ? "" : String(value);
}

if (typeof MutationObserver !== "undefined") {
  new MutationObserver(() => {
    if (document.getElementById(THEME_LINK_ID)) ensureTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}
