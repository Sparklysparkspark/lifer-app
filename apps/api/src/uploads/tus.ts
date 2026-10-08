// POST|PATCH|HEAD|DELETE|OPTIONS /uploads/tus[/:id]: resumable uploads (lib/tusUploads.ts). Each
// request is authenticated like any other upload (session cookie or an x-api-key with
// photos.write; the cross-site guard in index.ts runs first), checked against the upload id's
// owner, then handed to the tus server with the raw request stream untouched.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { requireScope } from "../auth/session.js";
import { withSchemas } from "../lib/schema.js";
import { ensureTusUploadDirs, ownsTusUpload, setTusRequestUser, tusServer } from "../lib/tusUploads.js";

export async function tusUploadRoutes(parent: FastifyInstance): Promise<void> {
  // Own scope: the tus server reads the body itself, so nothing here may parse or buffer it,
  // and Fastify's bodyLimit never applies.
  await withSchemas(parent).register(async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_request, _payload, done) => done(null));
    const routePath = `${app.prefix}/uploads/tus`;

    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.id;
      const id = (request.params as { id?: string }).id;
      // 404 rather than 403, so ids of other users' uploads can't be probed.
      if (id !== undefined && !ownsTusUpload(userId, id)) {
        return reply.code(404).header("Tus-Resumable", "1.0.0").send({ error: "Upload not found" });
      }
      // Before hijacking, so a folder it can't create answers through the app's error handler.
      await ensureTusUploadDirs();
      setTusRequestUser(request.raw, userId);
      reply.hijack();
      try {
        await tusServer(routePath).handle(request.raw, reply.raw);
      } catch (err) {
        request.log.error({ err }, "Resumable upload failed");
        if (!reply.raw.headersSent)
          reply.raw.writeHead(500, { "Content-Type": "text/plain", "Tus-Resumable": "1.0.0" });
        reply.raw.end("Internal server error\n");
      }
    };

    // Only the path is checked here. Headers and the body are the tus server's: it answers a
    // missing Tus-Resumable or a bad Upload-Offset with the protocol's own status codes. Any id
    // string is accepted so an unknown one still gets the tus-style 404 above.
    const auth = { preValidation: requireScope("photos.write") };
    const params = Type.Object({ id: Type.String({ minLength: 1 }) });
    app.post("/uploads/tus", { ...auth, schema: {} }, handler);
    app.options("/uploads/tus", { ...auth, schema: {} }, handler);
    app.patch("/uploads/tus/:id", { ...auth, schema: { params } }, handler);
    app.head("/uploads/tus/:id", { ...auth, schema: { params } }, handler);
    app.delete("/uploads/tus/:id", { ...auth, schema: { params } }, handler);
    app.options("/uploads/tus/:id", { ...auth, schema: { params } }, handler);
  });
}
