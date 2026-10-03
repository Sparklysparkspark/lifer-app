const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The API rejects non-GET cookie requests without this header (a simple CSRF guard: a
// cross-site form post can't set custom headers). Exported for the few raw fetch() callers.
export const CLIENT_HEADER = { "x-lifer-client": "1" } as const;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Only claim JSON when there is a body: Fastify rejects an empty body with a JSON content-type.
  const isJsonBody = typeof options.body === "string";
  const headers = new Headers(options.headers);
  headers.set("x-lifer-client", CLIENT_HEADER["x-lifer-client"]);
  if (isJsonBody && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE}${path}`, {
    // BASE is relative, so requests are always same-origin. "include" adds heavy per-request overhead
    // in WKWebView.
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  // 204 and other empty bodies resolve to undefined instead of a JSON parse error.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function encodeBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  return body instanceof FormData ? body : JSON.stringify(body);
}

export const api = {
  // `signal` lets as-you-type searches cancel a stale request so it can't overwrite newer results.
  get: <T>(path: string, options?: RequestInit) => request<T>(path, options),
  post: <T>(path: string, body?: unknown, options?: RequestInit) =>
    request<T>(path, { ...options, method: "POST", body: encodeBody(body) }),
  patch: <T>(path: string, body?: unknown, options?: RequestInit) =>
    request<T>(path, { ...options, method: "PATCH", body: encodeBody(body) }),
  put: <T>(path: string, body?: unknown, options?: RequestInit) => request<T>(path, { ...options, method: "PUT", body: encodeBody(body) }),
  // Most DELETEs have no body, but bulk actions (e.g. /archive/bulk) send the ids to act on.
  delete: <T>(path: string, body?: unknown, options?: RequestInit) =>
    request<T>(path, { ...options, method: "DELETE", body: encodeBody(body) }),
};
