import { signRequest } from "./sigv4.js";
import { renderSearchWorkspace } from "./workspace.js";

const login = document.querySelector("#os-workspace-login"), content = document.querySelector("#os-workspace-content"), signOut = document.querySelector("#os-sign-out");
const region = document.querySelector('meta[name="stacksim-region"]').content;
const kind = document.querySelector("#os-auth-kind");
kind.value = document.querySelector('meta[name="stacksim-internal-users"]').content === "true" ? "basic" : "iam";
const changed = () => { document.querySelector("#os-token-field").hidden = kind.value !== "iam"; };
kind.onchange = changed; changed();
let credentials, generation = 0, dirty = false;
window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
const query = async (method, path, body) => {
  // A browser cannot send a GET request body. JSON reads use the corresponding
  // POST data API; bodyless GET/HEAD retain their ordinary method semantics.
  if ((method === "GET" || method === "HEAD") && body) {
    if (method === "HEAD") throw new Error("HEAD requests cannot carry a body in this workspace.");
    method = "POST";
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\]/.test(path) || new URL(path, location.origin).origin !== location.origin) throw new Error("Use a relative OpenSearch path on this resource.");
  const options = { method, headers: { "content-type": "application/json" }, cache: "no-store", credentials: "omit", redirect: "error", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
  if (!credentials) throw new Error("Sign in to continue.");
  let url = path;
  if (credentials.kind === "basic") {
    const bytes = new TextEncoder().encode(`${credentials.name}:${credentials.secret}`);
    options.headers.authorization = `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))}`;
  } else {
    const signed = await signRequest(path, options, { credentials: { accessKeyId: credentials.name, secretAccessKey: credentials.secret, ...(credentials.token ? { sessionToken: credentials.token } : {}) }, region, service: "es" });
    url = signed.url; Object.assign(options, signed.options);
  }
  const response = await fetch(url, options); const text = await response.text();
  let result; try { result = text ? JSON.parse(text) : {}; } catch { result = text; }
  if (!response.ok) { const error = new Error(result.error?.reason ?? result.message ?? `Request failed (${response.status})`); error.details = result; throw error; }
  return result;
};
login.onsubmit = async event => {
  event.preventDefault(); const current = ++generation, button = event.submitter, alert = login.querySelector('[role="alert"]');
  button.disabled = true; alert.hidden = true;
  credentials = { kind: kind.value, name: document.querySelector("#os-login-name").value, secret: document.querySelector("#os-login-secret").value, token: document.querySelector("#os-login-token").value };
  try {
    await renderSearchWorkspace({ root: content, query, live: () => generation === current, dirty: value => { dirty = value; } });
    if (generation !== current) return;
    login.hidden = true; signOut.hidden = false; login.reset(); changed();
  } catch (error) { credentials = undefined; alert.hidden = false; alert.textContent = error.message; alert.focus(); }
  finally { button.disabled = false; }
};
signOut.onclick = () => { generation++; credentials = undefined; dirty = false; content.replaceChildren(); login.reset(); login.hidden = false; signOut.hidden = true; changed(); };
