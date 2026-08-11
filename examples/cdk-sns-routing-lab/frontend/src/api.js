const API_BASE_URL = __SNS_ROUTING_API_BASE_URL__.replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const runtimeConfig = Object.freeze({
  apiBaseUrl: API_BASE_URL,
  isPlaceholder: API_BASE_URL.includes("sns-routing-placeholder"),
});

export async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { message: raw };
    }
    if (!response.ok) throw new ApiError(payload.error || payload.message || `Request failed with HTTP ${response.status}`, response.status);
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError") throw new ApiError("The tutorial API did not respond in time.");
    throw new ApiError("The tutorial API is unavailable. Confirm the CDK stacks are deployed and stacksim is running.");
  } finally {
    clearTimeout(timer);
  }
}
