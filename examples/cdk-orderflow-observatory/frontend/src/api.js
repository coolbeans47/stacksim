const API_BASE_URL = __ORDERFLOW_API_BASE_URL__.replace(/\/+$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`The API returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body;
}

export const orderflowApi = {
  system: () => request("/system"),
  executions: () => request("/executions"),
  execution: (arn) => request(`/executions/${encodeURIComponent(arn)}`),
  history: (arn) => request(`/executions/${encodeURIComponent(arn)}/history`),
  start: (input) => request("/executions", { method: "POST", body: JSON.stringify(input) }),
  stop: (arn) => request(`/executions/${encodeURIComponent(arn)}/stop`, { method: "POST", body: "{}" }),
};
