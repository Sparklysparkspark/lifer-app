import type { SessionUser } from "./auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}
