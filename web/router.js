export function normalizeHash(value = "") {
  const path = String(value).trim().replace(/^#\/?/, "").replace(/^\/+/, "");
  return `#/${path || "home"}`;
}

export function parseRoute(hash = location.hash) {
  return normalizeHash(hash).slice(2).split("/").map(decodeURIComponent);
}

export function shouldGuardNavigation(dirty, currentHash, targetHash) {
  return Boolean(dirty) && normalizeHash(currentHash) !== normalizeHash(targetHash);
}

export function navigate(path, requestNavigation) {
  const target = normalizeHash(path);
  if (requestNavigation) requestNavigation(target);
  else location.hash = target;
}

export function routeNotFound(parts) {
  return { title: "Page not found", path: `/${parts.map(encodeURIComponent).join("/")}` };
}
