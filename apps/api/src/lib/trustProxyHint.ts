// TRUST_PROXY trusts no proxy unless it's set (packages/core/src/config.ts). Behind a reverse
// proxy that leaves every visitor looking like the proxy, which makes the per-address login limit
// shared by everyone. Logs that once, the first time a forwarded request arrives with it unset.
import type { FastifyBaseLogger, FastifyRequest } from "fastify";

export function trustProxyHint(log: FastifyBaseLogger, trustProxyEnv: string | undefined) {
  let warned = !!trustProxyEnv?.trim();
  return async function hint(request: FastifyRequest): Promise<void> {
    if (warned || request.headers["x-forwarded-for"] === undefined) return;
    warned = true;
    log.warn(
      `[startup] Requests arrive through a reverse proxy (from ${request.socket.remoteAddress}), but TRUST_PROXY isn't set, ` +
        "so Lifer sees every visitor as the proxy and the login limit is shared by all of them. " +
        "Set TRUST_PROXY to the proxy's address (see the docs, Reverse proxy and HTTPS).",
    );
  };
}
