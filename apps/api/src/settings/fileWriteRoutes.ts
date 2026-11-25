// Settings > Metadata > Where keywords go: sidecar names, in-file writes, linked folders, a dry
// run count for linked folders, and a job that brings existing photos in line after a change.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { requireAuth } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { Flag, Open, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { metadataGoesInFile } from "../uploads/exif.js";
import { linkedSidecarPlans } from "../uploads/fileWriting.js";
import type { FileWriteSettings } from "../uploads/sidecarNames.js";
import { syncCaptureXmpSidecars } from "../uploads/xmpSidecarSync.js";
import { getFileWriteSettings, setFileWriteSettings } from "./fileWriteSettings.js";

const SidecarNamesSchema = Type.Enum(["stem", "full", "both"], {
  description: "RAW sidecar names: IMG_0001.xmp (stem), IMG_0001.CR3.xmp (full), or both",
});
const FileWriteSchema = Type.Object({
  sidecarNames: SidecarNamesSchema,
  insideFiles: Type.Boolean({
    description: "Write keywords inside JPEG, TIFF, PNG, DNG, WebP, HEIC, AVIF and JPEG 2000 files",
  }),
  linkedFolders: Type.Boolean({ description: "Also write sidecars next to files in linked folders" }),
});
const FileWritePatch = Type.Partial(FileWriteSchema, { additionalProperties: false });

const LinkedPreview = Type.Object({
  files: Type.Integer({ description: "Linked files Lifer knows" }),
  create: Type.Integer({ description: "Sidecars Lifer would create" }),
  update: Type.Integer({ description: "Sidecars Lifer made before and would update" }),
  skip: Type.Integer({ description: "Sidecars another app made, left alone" }),
  unavailable: Type.Integer({ description: "Linked files not reachable now (a disconnected drive)" }),
});

interface ApplyCounts {
  written: number;
  failed: number;
}
const APPLY_IDLE: ApplyCounts = { written: 0, failed: 0 };
const ApplyStatus = Open({ ...jobStatusFields(Type.Unknown()), written: Type.Integer(), failed: Type.Integer() });

export const applyFileWriteJob = createJob<ApplyCounts, ApplyCounts>("apply-file-writing", APPLY_IDLE);
let applyJobUserId: string | null = null;

/** True when this file's metadata goes to a sidecar under `s`, so a settings change touches it. */
const writesSidecar = (ref: string, managed: boolean, s: FileWriteSettings) =>
  managed ? !s.insideFiles || !metadataGoesInFile(ref) : s.linkedFolders;

/** Rewrites every photo whose files get a sidecar under the current settings, so a new sidecar
 *  name, sidecars instead of in-file writes, or linked folders cover existing photos too. */
export async function runApplyFileWriting(
  ctx: JobContext<ApplyCounts, ApplyCounts>,
  userId: string,
  counts: ApplyCounts,
): Promise<ApplyCounts> {
  const settings = await getFileWriteSettings(userId);
  const res = await pool.query<{ capture_id: string; refs: string[]; managed: boolean[] }>(
    `SELECT o.capture_id, array_agg(o.ref) AS refs, array_agg(o.managed) AS managed
       FROM originals o JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
      WHERE o.user_id = $1
      GROUP BY o.capture_id ORDER BY o.capture_id`,
    [userId],
  );
  const due = res.rows.filter((r) => r.refs.some((ref, i) => writesSidecar(ref, r.managed[i], settings)));
  ctx.update({ phase: "writing", total: due.length, processed: 0 });
  const limit = createLimiter(4);
  let processed = 0;
  await Promise.all(
    due.map((row) =>
      limit(async () => {
        if (ctx.signal.aborted) return;
        try {
          await syncCaptureXmpSidecars(userId, row.capture_id);
          counts.written++;
        } catch {
          counts.failed++;
        }
        ctx.update({ processed: ++processed });
      }),
    ),
  );
  return { ...counts };
}

/** What turning on linked folders would do, without writing: sidecars made, updated, left alone. */
export async function linkedFolderPreview(userId: string): Promise<{
  files: number;
  create: number;
  update: number;
  skip: number;
  unavailable: number;
}> {
  const settings = { ...(await getFileWriteSettings(userId)), linkedFolders: true };
  const res = await pool.query<{ ref: string }>(
    `SELECT o.ref FROM originals o JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
      WHERE o.user_id = $1 AND o.managed = false`,
    [userId],
  );
  const counts = { files: res.rows.length, create: 0, update: 0, skip: 0, unavailable: 0 };
  const limit = createLimiter(16);
  await Promise.all(
    res.rows.map((r) =>
      limit(async () => {
        const plans = await linkedSidecarPlans(r.ref, settings);
        if (plans.length === 0) counts.unavailable++;
        for (const p of plans) counts[p.plan]++;
      }),
    ),
  );
  return counts;
}

export async function fileWriteRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/settings/file-writing",
    { preValidation: requireAuth, schema: { response: replies(FileWriteSchema) } },
    async (request) => getFileWriteSettings(request.user!.id),
  );

  // Takes effect for the next write; "Update existing photos" brings the rest in line.
  app.put(
    "/settings/file-writing",
    { preValidation: requireAuth, schema: { body: FileWritePatch, response: replies(FileWriteSchema) } },
    async (request) => setFileWriteSettings(request.user!.id, request.body),
  );

  app.get(
    "/settings/file-writing/linked-preview",
    { preValidation: requireAuth, schema: { response: replies(LinkedPreview) } },
    async (request) => linkedFolderPreview(request.user!.id),
  );

  app.post(
    "/settings/file-writing/apply",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ background: Flag("1 to start the job and return at once, for polling") }),
        response: replies(
          Open({
            started: Type.Optional(Type.Boolean()),
            written: Type.Optional(Type.Integer()),
            failed: Type.Optional(Type.Integer()),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (
        !applyFileWriteJob.start((ctx) => runApplyFileWriting(ctx, userId, applyFileWriteJob.status), {
          phase: "preparing",
        })
      )
        return reply.code(409).send({ error: "Photo files are already being updated" });
      applyJobUserId = userId;
      if (request.query.background === "1") return { started: true };
      await applyFileWriteJob.settled();
      const status = applyFileWriteJob.status;
      if (status.error) return reply.code(500).send({ error: status.error });
      return { written: status.written, failed: status.failed };
    },
  );

  app.get(
    "/settings/file-writing/apply/status",
    { preValidation: requireAuth, schema: { response: replies(ApplyStatus) } },
    async (request) =>
      applyJobUserId == null || applyJobUserId === request.user!.id
        ? applyFileWriteJob.status
        : { ...applyFileWriteJob.status, ...APPLY_IDLE, currentItem: null },
  );

  app.post(
    "/settings/file-writing/apply/cancel",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) } },
    async (request) => ({
      cancelled: (applyJobUserId == null || applyJobUserId === request.user!.id) && applyFileWriteJob.cancel(),
    }),
  );
}
