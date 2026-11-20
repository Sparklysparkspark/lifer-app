// The desktop API's request gate (registered in index.ts in SINGLE_USER_MODE only). Desktop mode
// has no sign-in, so a request gets past it only with a loopback Host header (DNS-rebinding
// guard), without forwarded headers (nothing legitimate proxies to it) and, for every /api route
// that isn't public, with the desktop app's own credential (localCredential.ts). Other programs
// on the computer get a 401. One exception: an API key may reach a route whose static scope is a
// plugin, MCP or companion scope, and requireScope then checks the key.
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasForwardedHeaders } from "@lifer/core/lib/requestGuard.js";
import { isAllowedLocalHost } from "./hostCheck.js";
import { hasLocalCredential, localCredentialConfig, type LocalCredentialConfig } from "./localCredential.js";
import { isPublicApiRoute, publicRouteKey } from "./publicRoutes.js";
import { routeCatalog } from "../lib/schema.js";

/** Scopes a separately installed app's key may use against the desktop API. Only routes guarded by
 *  requireScope with one of these accept a key here; everything else stays credential only. */
export const PLUGIN_SCOPES: ReadonlySet<string> = new Set([
  "userdata.read",
  "userdata.write",
  "imports.write",
  "opendata.read",
  "host.preference",
]);

/** Scopes the MCP server (packages/mcp) uses: reading the library and managing albums, nothing that
 *  imports, edits photos or shares. Keys stay limited to what their owner ticked on the API keys page. */
export const MCP_SCOPES: ReadonlySet<string> = new Set([
  "gallery.read",
  "species.read",
  "stats.read",
  "trips.read",
  "album.read",
  "album.write",
  "collection.read",
]);

/** Scopes a paired phone's key carries. The phone's requests arrive with the key and no desktop
 *  credential, so the key itself is what gets checked, on routes that name one of these. */
export const COMPANION_SCOPES: ReadonlySet<string> = new Set(["companion"]);

// Keys come from local programs, never web pages, so any Origin header disqualifies the request.
function isPluginKeyRequest(request: FastifyRequest, route: string): boolean {
  if (typeof request.headers["x-api-key"] !== "string" || request.headers.origin !== undefined) return false;
  // A route's own HEAD (tus resumes with one) before the GET that answers HEAD otherwise.
  const entry =
    routeCatalog.get(`${request.method} ${route}`) ?? routeCatalog.get(publicRouteKey(request.method, route));
  return (
    entry?.auth === "scope" &&
    entry.scope !== undefined &&
    (PLUGIN_SCOPES.has(entry.scope) ||
      MCP_SCOPES.has(entry.scope) ||
      [entry.scope, ...entry.alsoAccepts].some((s) => COMPANION_SCOPES.has(s)))
  );
}

export function desktopRequestGate(port: number, config: () => LocalCredentialConfig = localCredentialConfig) {
  return async function desktopGate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isAllowedLocalHost(request.headers.host, port)) {
      return reply.code(403).send({ error: "Forbidden host" });
    }
    if (hasForwardedHeaders(request.headers)) {
      return reply.code(403).send({ error: "Forwarded requests aren't accepted in desktop mode" });
    }
    // onRequest runs after routing, so this is the matched route's pattern (undefined for a 404).
    const route = request.routeOptions.url;
    if (
      route?.startsWith("/api/") &&
      !isPublicApiRoute(request.method, route) &&
      !hasLocalCredential(request, config()) &&
      !isPluginKeyRequest(request, route)
    ) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
  };
}
