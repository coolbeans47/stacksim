import { associateFormLabels, confirmationDialog, modal as modalMarkup } from "./components.js";
import { bindArnMultiComboboxes, enhanceArnComboboxes } from "./arn-combobox.js";
import { setDirty } from "./state.js";

const htmlPatternFixes = new Map([
  ["[A-Za-z0-9_.-]{3,255}", "[A-Za-z0-9_.\\-]{3,255}"],
  ["[A-Za-z0-9_+=,.@-]+", "[A-Za-z0-9_+=,.@\\-]+"],
  ["[A-Za-z0-9_-]+", "[A-Za-z0-9_\\-]+"],
  ["[A-Za-z0-9-_]+", "[A-Za-z0-9_\\-]+"],
]);

function normalizeHtmlPatterns(html) {
  return html.replace(/pattern="([^"]+)"/g, (attribute, pattern) => `pattern="${htmlPatternFixes.get(pattern) ?? pattern}"`);
}

export function createUi({ dialog, content, toastRegion, afterSubmit }) {
  function toast(message, type = "success") {
    for (const existing of toastRegion.querySelectorAll(`.toast.${type}`)) {
      if (existing.textContent === message) existing.remove();
    }
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.setAttribute("role", type === "error" ? "alert" : "status");
    element.textContent = message;
    toastRegion.append(element);
    setTimeout(() => element.remove(), 4_500);
  }

  function showError(error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }

  function showModal(title, body, submitLabel, onSubmit, wide = false, options = {}) {
    if (dialog.open) dialog.close();
    const previouslyFocused = document.activeElement;
    dialog.style.width = options.width ?? (wide ? "min(860px, calc(100vw - 40px))" : "");
    content.innerHTML = modalMarkup(title, normalizeHtmlPatterns(body), submitLabel, options);
    associateFormLabels(content);
    enhanceArnComboboxes(content);
    bindArnMultiComboboxes(content);
    const form = dialog.querySelector("form");
    form.onsubmit = async event => {
      event.preventDefault();
      const submit = dialog.querySelector("#modal-submit");
      submit.disabled = true;
      const hashBeforeSubmit = location.hash;
      try {
        // Successful submit callbacks may navigate. Treat that navigation as an
        // explicit commit while links clicked before submission remain guarded.
        setDirty(false, "modal");
        await onSubmit(new FormData(form));
        if (options.closeAfterSubmit === false) {
          submit.disabled = false;
          return;
        }
        dialog.close();
        if (options.refreshAfterSubmit !== false && location.hash === hashBeforeSubmit) await afterSubmit();
        if (!(previouslyFocused instanceof HTMLElement) || !previouslyFocused.isConnected) {
          document.querySelector("main")?.focus({ preventScroll: true });
        }
      } catch (error) {
        setDirty(true, "modal");
        submit.disabled = false;
        showError(error);
      }
    };
    dialog.querySelectorAll("[data-modal-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
    form.querySelectorAll("input, textarea, select").forEach(control => control.addEventListener("input", () => setDirty(true, "modal")));
    dialog.addEventListener("close", () => {
      setDirty(false, "modal");
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    }, { once: true });
    dialog.showModal();
    (dialog.querySelector("input:not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? dialog.querySelector("button:not([disabled])"))?.focus();
  }

  function confirmDeletion(name, message, onConfirm) {
    showModal("Confirm deletion", confirmationDialog(name, message), "Delete", async data => {
      if (data.get("confirmation") !== name) throw new Error(`Enter ${name} to confirm`);
      await onConfirm();
    }, false, { danger: true });
  }

  return { toast, showError, showModal, confirmDeletion };
}

export function bindTableFilter(root = document) {
  const input = root.querySelector("[data-filter-table]");
  if (!input) return;
  input.addEventListener("input", () => root.querySelectorAll("[data-search-row]").forEach(row => {
    row.hidden = !row.dataset.searchRow.includes(input.value.toLowerCase());
  }));
}

export function prettyJson(value) {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}
