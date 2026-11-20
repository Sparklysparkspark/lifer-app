// The next-launch crash sheet: list what's waiting, send it on the user's click, or drop it. In
// server mode the one account is the admin, so its session is enough.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { requireAuth } from "../auth/session.js";
import { Ok, replies, withSchemas } from "../lib/schema.js";
import {
  CRASH_REPORT_URL,
  MAX_NOTE,
  crashReportsEnabled,
  deleteCrashReport,
  listCrashReports,
  normalizeReport,
  saveCrashReport,
  sendCrashReport,
} from "./report.js";

const Report = Type.Object({
  app: Type.Literal("lifer"),
  version: Type.String(),
  os: Type.String(),
  arch: Type.String(),
  kind: Type.String(),
  message: Type.String(),
  stack: Type.String(),
  timestamp: Type.String(),
});
const Ids = Type.Array(Type.String({ pattern: "^\\d{1,16}$" }), { maxItems: 50 });

export async function crashReportRoutes(
  fastify: FastifyInstance,
  opts: { reportUrl?: string; dir?: string } = {},
): Promise<void> {
  const app = withSchemas(fastify);
  const reportUrl = opts.reportUrl ?? CRASH_REPORT_URL;

  app.get(
    "/crash-reports",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(Type.Object({ reports: Type.Array(Type.Object({ id: Type.String(), report: Report })) })),
      },
    },
    async () => ({ reports: listCrashReports(opts.dir) }),
  );

  // Exactly what Send would post, for the Save report button.
  app.get(
    "/crash-reports/download",
    { preValidation: requireAuth, schema: { response: replies(Type.Array(Report)) } },
    async (_request, reply) => {
      reply.header("Content-Disposition", 'attachment; filename="lifer-crash-report.json"');
      return listCrashReports(opts.dir).map((r) => r.report);
    },
  );

  // The web app's error boundary. Redacted and capped like every other report.
  app.post(
    "/crash-reports",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { message: Type.String({ maxLength: 20_000 }), stack: Type.String({ maxLength: 200_000 }) },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      const report = normalizeReport({ kind: "web-error", ...request.body, timestamp: Date.now() });
      if (report) saveCrashReport(report, opts.dir);
      return { ok: true };
    },
  );

  // Sent and deleted one by one, so a failure keeps only the reports that didn't go.
  app.post(
    "/crash-reports/send",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { ids: Ids, note: Type.Optional(Type.String({ maxLength: MAX_NOTE })) },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      if (!crashReportsEnabled()) return reply.code(404).send({ error: "Crash reports are turned off" });
      const wanted = new Set(request.body.ids);
      const results = await Promise.allSettled(
        listCrashReports(opts.dir)
          .filter((r) => wanted.has(r.id))
          .map(async ({ id, report }) => {
            await sendCrashReport(report, request.body.note, reportUrl);
            deleteCrashReport(id, opts.dir);
          }),
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        request.log.warn({ err: (failed[0] as PromiseRejectedResult).reason }, "Couldn't send a crash report");
        return reply.code(502).send({ error: "Couldn't send. Try again later." });
      }
      return { ok: true };
    },
  );

  app.post(
    "/crash-reports/dismiss",
    {
      preValidation: requireAuth,
      schema: { body: Type.Object({ ids: Ids }, { additionalProperties: false }), response: replies(Ok) },
    },
    async (request) => {
      for (const id of request.body.ids) deleteCrashReport(id, opts.dir);
      return { ok: true };
    },
  );
}
