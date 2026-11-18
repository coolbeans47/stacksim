import { signRequest } from './sigv4.js';
import { renderApplicationWorkspace } from './application-workspace.js';
const login = document.querySelector('#os-app-login'), content = document.querySelector('#os-app-content'), signOut = document.querySelector('#os-app-sign-out'), region = document.querySelector('meta[name="stacksim-region"]').content;
let credentials, generation = 0, dirty = false;
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
const call = async (action, input) => {
  if (!credentials) throw new Error('Sign in to continue.');
  const path = `/_stacksim/application/${action}`, options = { method: action === 'context' ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) };
  const signed = await signRequest(path, options, { credentials, region, service: 'opensearch' });
  const response = await fetch(signed.url, { ...signed.options, credentials: 'omit', cache: 'no-store', redirect: 'error' }); const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.reason ?? result.message ?? `Request failed (${response.status})`); error.details = result; throw error; } return result;
};
login.onsubmit = async event => {
  event.preventDefault(); const current = ++generation, button = event.submitter, alert = login.querySelector('[role="alert"]'); button.disabled = true; alert.hidden = true;
  credentials = { accessKeyId: document.querySelector('#os-app-key').value, secretAccessKey: document.querySelector('#os-app-secret').value, ...(document.querySelector('#os-app-token').value ? { sessionToken: document.querySelector('#os-app-token').value } : {}) };
  try { await renderApplicationWorkspace({ root: content, call, live: () => generation === current, dirty: value => { dirty = value; } }); if (generation !== current) return; login.hidden = true; signOut.hidden = false; login.reset(); }
  catch (error) { credentials = undefined; content.replaceChildren(); alert.hidden = false; alert.textContent = error.message; alert.focus(); }
  finally { button.disabled = false; }
};
signOut.onclick = () => { generation++; credentials = undefined; dirty = false; content.replaceChildren(); login.reset(); login.hidden = false; signOut.hidden = true; };
