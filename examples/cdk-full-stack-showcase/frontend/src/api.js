const API_BASE_URL = __STACKSIM_API_BASE_URL__.replace(/\/+$/, "");
const DEMO_API_KEY = __AURORA_DEMO_API_KEY__;
const DEMO_TOKEN = __AURORA_DEMO_TOKEN__;

export class ApiError extends Error {
  constructor(message, status = 0, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export const runtimeConfig = Object.freeze({
  apiBaseUrl: API_BASE_URL,
  hasDemoApiKey: Boolean(DEMO_API_KEY),
  hasDemoToken: Boolean(DEMO_TOKEN),
  isPlaceholder: API_BASE_URL.includes("/aurora-demo/"),
});

export async function apiRequest(path, options = {}) {
  const { body, method = "GET", protectedCall = false, signal } = options;
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (protectedCall) {
    headers.Authorization = `Bearer ${DEMO_TOKEN}`;
    headers["x-api-key"] = DEMO_API_KEY;
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("The observatory API is out of range. Check that the showcase stack is deployed and try again.");
  }

  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw };
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `The request failed with status ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return payload ?? {};
}
