import type { FastifyReply, FastifyRequest } from "fastify";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";

// For routes that only make sense on a local single-user install: moving the library folder,
// migrating to a server, deleting the local library, revealing a file in the OS file manager.
// Routes that just take a path go through lib/allowedPaths.ts instead.
// 404 rather than 403 on purpose: the web app's job polling (useJobPoll) stops on a 404.
export function requireDesktopMode(reply: { code: (n: number) => { send: (b: unknown) => void } }): boolean {
  if (!SINGLE_USER_MODE) {
    reply.code(404).send({ error: "Only available in the desktop app", code: "desktop_only" });
    return false;
  }
  return true;
}

/** requireDesktopMode as a preValidation hook (after requireAuth), so a server answers 404 before
 *  it looks at the request's input, the same answer it gave before routes had schemas. */
export async function desktopOnly(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  requireDesktopMode(reply);
}
