export const PINNED_SERVICES_KEY = "stacksim-home-pinned-services";

export function readPinnedServices() {
  try {
    const saved = JSON.parse(localStorage.getItem(PINNED_SERVICES_KEY) ?? "[]");
    const legacyKeys = { "api-gateway": "apigateway", "parameter-store": "systems-manager" };
    return new Set(Array.isArray(saved) ? saved.filter(key => typeof key === "string").map(key => legacyKeys[key] ?? key) : []);
  } catch {
    return new Set();
  }
}

export function writePinnedServices(pinnedServices) {
  localStorage.setItem(PINNED_SERVICES_KEY, JSON.stringify([...pinnedServices].sort()));
}
