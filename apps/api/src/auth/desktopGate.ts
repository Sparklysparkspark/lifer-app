// The desktop API's request gate (registered in index.ts in SINGLE_USER_MODE only). Desktop mode
// has no sign-in, so a request gets past it only with a loopback Host header (DNS-rebinding
// guard), without forwarded headers (nothing legitimate proxies to it) and, for every /api route
// that isn't public, with the desktop app's own credential (localCredential.ts). Other programs
// on the computer get a 401.
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasForwardedHeaders } from "@lifer/core/lib/requestGuard.js";
import { isAllowedLocalHost } from "./hostCheck.js";
import { hasLocalCredential, localCredentialConfig, type LocalCredentialConfig } from "./localCredential.js";
import { isPublicApiRoute } from "./publicRoutes.js";

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
      !hasLocalCredential(request, config())
    ) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
  };
}
