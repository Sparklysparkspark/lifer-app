const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Only set a JSON content-type when there's an actual JSON body — Fastify's JSON parser
  // rejects an empty body outright if the header claims otherwise (hit this for real with
  // DELETE requests, which send no body at all).
  const isJsonBody = typeof options.body === "string";
  const res = await fetch(`${BASE}${path}`, {
    // BASE is always a relative path, so every request here is inherently same-origin
    // regardless of desktop vs. hosted deployment — "include" (send cookies cross-origin too)
    // was never actually needed, just the default-safe choice at the time. WKWebView (the
    // desktop app's renderer) does measurably more internal cookie-jar/ITP-policy work for
    // "include" than "same-origin" — confirmed via [perf] instrumentation showing a ~490ms
    // per-request cost in the packaged app that neither curl nor Node's own fetch reproduced
    // against the identical endpoint, which pointed at the webview's request handling itself
    // rather than the server.
    credentials: "same-origin",
    headers: isJsonBody ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  // body is optional — most DELETEs carry none, but bulk actions (e.g. /archive/bulk) need to
  // send which ids to act on, the same as a POST body would.
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) }),
};
