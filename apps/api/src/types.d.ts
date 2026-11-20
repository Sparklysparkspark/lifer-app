import type { SessionUser } from "./auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    /** Set when a paired phone's device key (not a session or the desktop credential) made the request. */
    deviceKey?: boolean;
    /** The API key's name when a key (not a session) made the request; a paired app's is its manifest name. */
    apiKeyName?: string;
  }
}
