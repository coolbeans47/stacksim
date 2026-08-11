import type { Tokens } from "./auth.js";
import type { RuntimeConfig } from "./types.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: any) {
    super(message);
  }
}

export class ApiClient {
  constructor(private readonly runtime: RuntimeConfig, private readonly tokens: () => Tokens | undefined) {}

  async request<T>(method: string, path: string, body?: unknown, token: "access" | "id" | "none" = "access"): Promise<T> {
    const current = this.tokens();
    const bearer = token === "id" ? current?.idToken : token === "access" ? current?.accessToken : undefined;
    const response = await fetch(`${this.runtime.apiBaseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, value.code ?? "REQUEST_FAILED", value.message ?? "Request failed", value);
    return value as T;
  }
}

export const mutationId = () => crypto.randomUUID();
