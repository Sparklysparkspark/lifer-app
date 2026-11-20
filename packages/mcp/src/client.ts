// A small fetch wrapper over Lifer's public API: the MCP server only ever calls documented routes.
export class LiferApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface LiferClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

/** A client for the API at `baseUrl` (with or without a trailing /api), signing in with an API key. */
export function createClient(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): LiferClient {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/api$/, "") + "/api";

  async function request<T>(method: "GET" | "POST", path: string, query?: Query, body?: unknown): Promise<T> {
    const url = new URL(root + path);
    // A list repeats its parameter (region=a&region=b): any one of the values matches.
    for (const [key, value] of Object.entries(query ?? {}))
      for (const v of Array.isArray(value) ? value : [value])
        if (v !== undefined) url.searchParams.append(key, String(v));
    const res = await fetchImpl(url, {
      method,
      headers: { "x-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const message = (parsed as { error?: string } | null)?.error ?? `Lifer answered ${res.status}`;
      throw new LiferApiError(
        res.status === 401 ? "Lifer refused the API key (check it and its permissions)" : message,
        res.status,
      );
    }
    return parsed as T;
  }

  return {
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, undefined, body ?? {}),
  };
}
