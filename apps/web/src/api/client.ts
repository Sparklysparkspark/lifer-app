import { apiErrorMessage } from "../lib/apiErrors";
import type { paths } from "./schema.gen";

const BASE = "/api";

// `message` is what to show: the translation of `code` in the active language when there is one,
// otherwise the server's English `error` (see lib/apiErrors.ts). `serverMessage` is always the latter.
export class ApiError extends Error {
  status: number;
  code?: string;
  serverMessage: string;
  constructor(status: number, message: string, code?: string) {
    super(code ? apiErrorMessage(code, message) || message : message);
    this.status = status;
    this.code = code;
    this.serverMessage = message;
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
    throw new ApiError(res.status, body.error ?? res.statusText, typeof body.code === "string" ? body.code : undefined);
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

// --- Types from the API's own route schemas (schema.gen.ts, `npm run gen:api-types`) ---

type Method = "get" | "post" | "patch" | "put" | "delete";
type Operation<P extends keyof paths, M extends Method> = Exclude<paths[P][M], undefined>;
type JsonOf<R> = R extends { content: { "application/json": infer B } } ? B : never;
type SuccessOf<Op> = Op extends { responses: infer R }
  ? { [S in keyof R]: S extends 200 | 201 | 202 ? JsonOf<R[S]> : never }[keyof R]
  : never;

/** A route path (as in schema.gen.ts, with `{name}` parameters) whose `M` answer is described. */
export type ApiRoute<M extends Method> = {
  [P in keyof paths]: [SuccessOf<Operation<P, M>>] extends [never] ? never : P;
}[keyof paths];

/** What route `P` answers to `M`, from its response schema. */
export type ApiResponse<P extends keyof paths, M extends Method = "get"> = SuccessOf<Operation<P, M>>;

/** The JSON body route `P` accepts for `M`. */
export type ApiBody<P extends keyof paths, M extends Method> =
  Operation<P, M> extends { requestBody: { content: { "application/json": infer B } } } ? B : undefined;

type ParamsOf<P> = P extends `${string}{${infer Name}}${infer Rest}`
  ? { [K in Name]: string | number } & ParamsOf<Rest>
  : unknown;
type QueryOf<P extends keyof paths> = {
  [M in Method]: Operation<P, M> extends { parameters: { query?: infer Q } } ? Exclude<Q, undefined> : never;
}[Method];
type StaticRoute<M extends Method> = Exclude<ApiRoute<M>, `${string}{${string}`>;

declare const route: unique symbol;
/** A concrete URL for route `P`, built by apiPath, so the client knows which route it calls. */
export type ApiPath<P extends keyof paths> = string & { readonly [route]: P };

/** Fills in a route's `{name}` parameters (and an optional query) and keeps the route for typing:
 *  `api.get(apiPath("/trips/{id}", { id }))` answers what GET /trips/:id's schema describes.
 *  Empty, null and undefined query values are left out, as the API treats them as not given. */
export function apiPath<P extends keyof paths>(
  template: P,
  params: ParamsOf<P>,
  query?: QueryOf<P> | URLSearchParams,
): ApiPath<P> {
  const filled = template.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(String((params as Record<string, string | number>)[name])),
  );
  const search =
    query instanceof URLSearchParams
      ? query
      : new URLSearchParams(
          Object.entries((query ?? {}) as Record<string, unknown>).flatMap(([k, v]) =>
            v === undefined || v === null || v === "" ? [] : [[k, String(v)]],
          ),
        );
  const qs = search.toString();
  return (qs ? `${filled}?${qs}` : filled) as ApiPath<P>;
}

// A literal path of a described route never reaches the untyped form: a body that doesn't match
// the route's schema is an error instead of quietly losing the types.
type Untyped<S extends string, M extends Method> = S extends StaticRoute<M> ? never : S;

// Each method is typed from the route's schemas when it's called with an apiPath() or a literal
// path without parameters, and falls back to the caller's `<T>` for anything else.
interface Api {
  // `signal` lets as-you-type searches cancel a stale request so it can't overwrite newer results.
  get<P extends StaticRoute<"get">>(path: P, options?: RequestInit): Promise<ApiResponse<P>>;
  get<P extends ApiRoute<"get">>(path: ApiPath<P>, options?: RequestInit): Promise<ApiResponse<P>>;
  get<T, S extends string = string>(path: Untyped<S, "get">, options?: RequestInit): Promise<T>;
  post<P extends StaticRoute<"post">>(
    path: P,
    body?: ApiBody<P, "post"> | FormData,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "post">>;
  post<P extends ApiRoute<"post">>(
    path: ApiPath<P>,
    body?: ApiBody<P, "post"> | FormData,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "post">>;
  post<T, S extends string = string>(path: Untyped<S, "post">, body?: unknown, options?: RequestInit): Promise<T>;
  patch<P extends StaticRoute<"patch">>(
    path: P,
    body?: ApiBody<P, "patch">,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "patch">>;
  patch<P extends ApiRoute<"patch">>(
    path: ApiPath<P>,
    body?: ApiBody<P, "patch">,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "patch">>;
  patch<T, S extends string = string>(path: Untyped<S, "patch">, body?: unknown, options?: RequestInit): Promise<T>;
  put<P extends StaticRoute<"put">>(
    path: P,
    body?: ApiBody<P, "put">,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "put">>;
  put<P extends ApiRoute<"put">>(
    path: ApiPath<P>,
    body?: ApiBody<P, "put">,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "put">>;
  put<T, S extends string = string>(path: Untyped<S, "put">, body?: unknown, options?: RequestInit): Promise<T>;
  // Most DELETEs have no body, but bulk actions (e.g. /archive/bulk) send the ids to act on.
  delete<P extends StaticRoute<"delete">>(
    path: P,
    body?: ApiBody<P, "delete">,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "delete">>;
  delete<P extends ApiRoute<"delete">>(
    path: ApiPath<P>,
    body?: ApiBody<P, "delete">,
    options?: RequestInit,
  ): Promise<ApiResponse<P, "delete">>;
  delete<T, S extends string = string>(path: Untyped<S, "delete">, body?: unknown, options?: RequestInit): Promise<T>;
}

// The overloads above are the types; the calls themselves are the same untyped request.
const withBody = (method: string) => (path: string, body?: unknown, options?: RequestInit) =>
  request(path, { ...options, method, body: encodeBody(body) });

export const api = {
  get: (path: string, options?: RequestInit) => request(path, options),
  post: withBody("POST"),
  patch: withBody("PATCH"),
  put: withBody("PUT"),
  delete: withBody("DELETE"),
} as Api;
