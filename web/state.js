const savedRegion = localStorage.getItem("stacksim-region") || "eu-west-1";
const CREDENTIALS_KEY = "stacksim-console-credentials";

function loadCredentials() {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(CREDENTIALS_KEY) || "null");
    if (!saved || typeof saved !== "object" || !saved.active?.accessKeyId || !saved.active?.secretAccessKey) return null;
    if (saved.source?.accessKeyId === saved.active.accessKeyId) saved.active = saved.source;
    return saved;
  } catch {
    sessionStorage.removeItem(CREDENTIALS_KEY);
    return null;
  }
}

export const session = {
  summary: null,
  environment: null,
  selectedResource: null,
  collapsedApiResources: new Set(),
  region: savedRegion,
  authMode: null,
  credentials: loadCredentials(),
  dirty: false,
  pageDirty: false,
  modalDirty: false,
};

export function setRegion(region) {
  session.region = region;
  session.summary = null;
  localStorage.setItem("stacksim-region", region);
}

export function setCredentials(credentials) {
  if (credentials && credentials.source?.accessKeyId === credentials.active?.accessKeyId) credentials.active = credentials.source;
  session.credentials = credentials;
  if (typeof sessionStorage !== "undefined") {
    if (credentials) sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
    else sessionStorage.removeItem(CREDENTIALS_KEY);
  }
  window.dispatchEvent(new CustomEvent("stacksim-auth-change"));
}

export function clearCredentials() {
  setCredentials(null);
  session.summary = null;
  session.environment = null;
}

export function activeCredentials() {
  const saved = session.credentials;
  if (!saved) return null;
  if (saved.active?.expiration && Date.parse(saved.active.expiration) <= Date.now()) {
    if (saved.source && (!saved.source.expiration || Date.parse(saved.source.expiration) > Date.now())) {
      setCredentials({ source: saved.source, active: saved.source });
      return saved.source;
    }
    clearCredentials();
    return null;
  }
  return saved.active;
}

export function setDirty(value, scope = "page") {
  const dirty = Boolean(value);
  if (scope === "all") {
    session.pageDirty = dirty;
    session.modalDirty = dirty;
  } else if (scope === "modal") {
    session.modalDirty = dirty;
  } else {
    session.pageDirty = dirty;
  }
  session.dirty = session.pageDirty || session.modalDirty;
}
