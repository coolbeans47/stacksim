import { escapeHtml } from "./components.js";

let cached;

/** @returns {readonly string[]} */
export function ianaTimeZones() {
  if (!cached) {
    const values = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    cached = Object.freeze(["UTC", ...values.sort((left, right) => left.localeCompare(right))]);
  }
  return cached;
}

export function timezoneSelectOptions(selected = "UTC") {
  const value = String(selected || "UTC");
  const zones = ianaTimeZones();
  const options = zones.includes(value) ? zones : [value, ...zones];
  return options.map(zone => `<option value="${escapeHtml(zone)}"${zone === value ? " selected" : ""}>${escapeHtml(zone)}</option>`).join("");
}
