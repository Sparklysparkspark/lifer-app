// Album export: copies an album's photos into a folder the user picks (a photo frame's card, a USB
// stick, another app's inbox). Copies only: the library's own files are never moved or changed.
// One background job per instance, polled via /albums/export/status.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { idleJobStatus, renderTemplate } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { ensureRoom } from "@lifer/core/lib/freeSpace.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { isWithinResolved } from "@lifer/core/lib/pathContainment.js";
import { requireAuth } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { friendlyFsErrorMessage } from "../lib/friendlyFsError.js";
import {
  IdParams,
  Nullable,
  Ok,
  Open,
  jobStatusFields,
  notFoundOnInvalidId,
  replies,
  withSchemas,
} from "../lib/schema.js";
import { resolveOriginalPaths } from "../storageVolumes/resolve.js";
import { stripPreciseLocation } from "../uploads/exif.js";
import { sidecarFor, sidecarNamesOf } from "../uploads/sidecarNames.js";
import { getMetadataTemplate, sensitiveCapturesAmong } from "../settings/metadataSettings.js";
import { captureFacts, templateValues } from "../uploads/templateVars.js";
import { resolveSpeciesFolderName } from "../uploads/speciesFolderName.js";
import { albumItemRows } from "./routes.js";

interface ExportExtra {
  albumId: string | null;
  destination: string | null;
  copied: number;
  /** Already in the folder with the same size, from an earlier export there. */
  skipped: number;
  /** On a drive that isn't connected, or gone from disk. */
  missing: number;
  /** A sensitive species' file left out because its location couldn't be removed. */
  withheld: number;
}

const freshExtra = (): ExportExtra => ({
  albumId: null,
  destination: null,
  copied: 0,
  skipped: 0,
  missing: 0,
  withheld: 0,
});

export const albumExportJob = createJob<null, ExportExtra>("album-export", freshExtra());
// Whose export the shared job is: only they see its folder and counts, or cancel it.
let jobUserId: string | null = null;
const isJobOwner = (userId: string) => jobUserId == null || jobUserId === userId;

const ExportStatus = Open({
  ...jobStatusFields(Type.Null()),
  albumId: Nullable(Type.String()),
  destination: Nullable(Type.String()),
  copied: Type.Integer(),
  skipped: Type.Integer(),
  missing: Type.Integer(),
  withheld: Type.Integer(),
});

export interface ExportOptions {
  destination: string;
  include: { raw: boolean; sidecars: boolean };
  structure: "flat" | "bySpecies";
  /** Copies of sensitive species' photos lose their coordinates and place name. */
  hideSensitiveLocations?: boolean;
}

interface StripPlan {
  placeLabel: string | null;
  caption: string;
}

/** Copies src into dir as `name`, never replacing anything: a file already there with the same
 *  size counts as this one exported before (so a rerun continues), any other gets " (2)", " (3)"... */
export async function copyWithoutOverwrite(
  src: string,
  dir: string,
  name: string,
  size: number,
): Promise<{ target: string; copied: boolean }> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let n = 1; ; n++) {
    const target = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    const existing = await stat(target).catch(() => null);
    if (existing) {
      if (existing.isFile() && existing.size === size) return { target, copied: false };
      continue;
    }
    try {
      // EXCL: a file that appeared since the stat is still never overwritten.
      await copyFile(src, target, constants.COPYFILE_EXCL);
      return { target, copied: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      // Only a partial copy of ours can be there: EXCL refused anything that already existed.
      await unlink(target).catch(() => {});
      throw err;
    }
  }
}

interface PlannedFile {
  source: string;
  dir: string;
  /** Set for a .xmp: it takes the name its image ended up with, so apps still pair them. */
  sidecarOf?: number;
  size: number;
  strip?: StripPlan;
}

/** Copies a sensitive species' file with its precise location removed: stripped as a hidden
 *  scratch copy in the destination first, so the same-size check still spots an earlier export. */
async function copyStripped(file: PlannedFile, name: string, strip: StripPlan) {
  const scratch = path.join(file.dir, `.lifer-export-${randomUUID()}${path.extname(name)}`);
  try {
    await copyFile(file.source, scratch, constants.COPYFILE_EXCL);
    await stripPreciseLocation(scratch, strip);
    return await copyWithoutOverwrite(scratch, file.dir, name, (await stat(scratch)).size);
  } finally {
    await rm(scratch, { force: true });
  }
}

/** What to strip from each sensitive species' photo in this album, by capture. */
async function stripPlans(
  userId: string,
  items: Array<{ capture_id: string; species_id: string; region_id: string | null }>,
): Promise<Map<string, StripPlan>> {
  const sensitive = await sensitiveCapturesAmong(userId, items);
  const plans = new Map<string, StripPlan>();
  if (sensitive.size === 0) return plans;
  const template = await getMetadataTemplate(userId);
  for (const item of items) {
    if (!sensitive.has(item.capture_id) || plans.has(item.capture_id)) continue;
    const facts = await captureFacts(item.capture_id);
    // The caption Lifer would write, without the place, to replace one that names it.
    const caption = facts ? renderTemplate(template.caption, { ...(await templateValues(facts)), place: null }) : "";
    plans.set(item.capture_id, { placeLabel: facts?.locationLabel ?? null, caption });
  }
  return plans;
}

async function runExport(ctx: JobContext<null, ExportExtra>, userId: string, albumId: string, opts: ExportOptions) {
  const job = albumExportJob.status;
  try {
    const items = await albumItemRows(albumId, userId);
    const captureIds = items.map((r) => r.capture_id as string);
    const origRes = await pool.query<{
      capture_id: string;
      kind: string;
      ref: string;
      volume_id: string | null;
      volume_relative_path: string | null;
    }>(
      `SELECT capture_id, kind, ref, volume_id, volume_relative_path FROM originals
        WHERE capture_id = ANY($1::uuid[]) AND user_id = $2 AND ref_type = 'path'`,
      [captureIds, userId],
    );
    const byCapture = new Map<string, typeof origRes.rows>();
    for (const o of origRes.rows) byCapture.set(o.capture_id, [...(byCapture.get(o.capture_id) ?? []), o]);

    const strips = opts.hideSensitiveLocations ? await stripPlans(userId, items) : new Map<string, StripPlan>();
    const folderBySpecies = new Map<string, string>();
    const plan: PlannedFile[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const originals = byCapture.get(item.capture_id) ?? [];
      // The photo's main file is its edited one when there is one, as the gallery picks it.
      const main = originals.find((o) => o.kind === "jpeg") ?? originals.find((o) => o.kind !== "raw") ?? originals[0];
      const wanted = [main, ...(opts.include.raw ? originals.filter((o) => o.kind === "raw") : [])].filter(
        (o): o is NonNullable<typeof o> => o != null,
      );
      if (wanted.length === 0) {
        job.missing++;
        continue;
      }
      let dir = opts.destination;
      if (opts.structure === "bySpecies") {
        let folder = folderBySpecies.get(item.species_id);
        if (folder === undefined) {
          folder = await resolveSpeciesFolderName(userId, item.species_id);
          folderBySpecies.set(item.species_id, folder);
        }
        dir = path.join(opts.destination, folder);
      }
      const resolved = await resolveOriginalPaths(wanted);
      for (const r of resolved) {
        const size =
          r.connected && r.path
            ? await stat(r.path).then(
                (s) => (s.isFile() ? s.size : null),
                () => null,
              )
            : null;
        if (!r.path || size == null) {
          job.missing++;
          continue;
        }
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        const strip = strips.get(item.capture_id);
        plan.push({ source: r.path, dir, size, strip });
        if (!opts.include.sidecars) continue;
        const fileIndex = plan.length - 1;
        // Both names ("IMG_0001.xmp", "IMG_0001.CR3.xmp"), whichever exist.
        for (const sidecar of sidecarNamesOf(r.path, false)) {
          if (seen.has(sidecar)) continue;
          const sidecarSize = await stat(sidecar).then(
            (s) => (s.isFile() ? s.size : null),
            () => null,
          );
          if (sidecarSize == null) continue;
          seen.add(sidecar);
          plan.push({ source: sidecar, dir, size: sidecarSize, sidecarOf: fileIndex, strip });
        }
      }
    }

    await ensureRoom(
      opts.destination,
      plan.reduce((sum, f) => sum + f.size, 0),
    );
    ctx.update({
      phase: "copying",
      processed: 0,
      total: plan.length,
      downloadedBytes: 0,
      totalBytes: plan.reduce((sum, f) => sum + f.size, 0),
    });
    const targets: string[] = [];
    for (const [i, file] of plan.entries()) {
      ctx.throwIfCancelled();
      const name =
        file.sidecarOf !== undefined
          ? path.basename(sidecarFor(targets[file.sidecarOf], file.source, plan[file.sidecarOf].source))
          : path.basename(file.source);
      ctx.update({ currentItem: name });
      await mkdir(file.dir, { recursive: true });
      let outcome: { target: string; copied: boolean };
      try {
        outcome = file.strip
          ? await copyStripped(file, name, file.strip)
          : await copyWithoutOverwrite(file.source, file.dir, name, file.size);
      } catch (err) {
        if (!file.strip) throw err;
        // Never exported with its location: left out instead.
        job.withheld++;
        targets[i] = path.join(file.dir, name);
        ctx.update({ processed: i + 1, downloadedBytes: (job.downloadedBytes ?? 0) + file.size });
        continue;
      }
      const { target, copied } = outcome;
      targets[i] = target;
      if (copied) job.copied++;
      else job.skipped++;
      ctx.update({ processed: i + 1, downloadedBytes: (job.downloadedBytes ?? 0) + file.size });
    }
    return null;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(friendlyFsErrorMessage(err), { cause: err });
  }
}

export async function albumExportRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Session only, like the other routes that write to the filesystem.
  app.post(
    "/albums/:id/export",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Album not found"),
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            destination: Type.String({
              minLength: 1,
              description: "An existing folder; on a server it must be inside an allowed library root",
            }),
            include: Type.Object(
              {
                raw: Type.Boolean({ description: "Also copy each photo's RAW file" }),
                sidecars: Type.Boolean({ description: "Also copy .xmp sidecars next to the files" }),
              },
              { additionalProperties: false },
            ),
            structure: Type.Enum(["flat", "bySpecies"], {
              description: "flat puts every file in the folder; bySpecies makes a subfolder per species",
            }),
            hideSensitiveLocations: Type.Optional(
              Type.Boolean({
                description: "Remove GPS and place names from copies of sensitive species' photos (off by default)",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ started: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (albumExportJob.status.running) return reply.code(409).send({ error: "An export is already running" });
      const owned = await pool.query(`SELECT 1 FROM albums WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      if (owned.rowCount === 0) return reply.code(404).send({ error: "Album not found" });

      const { destination, include, structure, hideSensitiveLocations } = request.body;
      if (!path.isAbsolute(destination))
        return reply.code(400).send({ error: "destination must be an absolute folder path" });
      // A server only writes where Lifer is allowed to (throws a 403); desktop takes any picked folder.
      const dir = assertAllowedPath(destination);
      if (!(await isDirectory(dir))) return reply.code(400).send({ error: "That folder doesn't exist" });
      // Copies inside the library would be found again by a rescan as more photos.
      if (isWithinResolved(ORIGINALS_DIR, dir))
        return reply.code(400).send({ error: "Choose a folder outside your Lifer library" });
      if (
        !(await access(dir, constants.W_OK).then(
          () => true,
          () => false,
        ))
      )
        return reply.code(400).send({ error: "Lifer can't write to that folder" });

      const albumId = request.params.id;
      const started = albumExportJob.start(
        (ctx) => runExport(ctx, userId, albumId, { destination: dir, include, structure, hideSensitiveLocations }),
        {
          albumId,
          destination: dir,
        },
      );
      if (!started) return reply.code(409).send({ error: "An export is already running" });
      jobUserId = userId;
      return { started: true };
    },
  );

  app.get(
    "/albums/export/status",
    { preValidation: requireAuth, schema: { response: replies(ExportStatus) } },
    async (request) => {
      if (isJobOwner(request.user!.id)) return albumExportJob.status;
      // Someone else's export: only that one is running, not where it writes.
      return { ...idleJobStatus<null>(), ...freshExtra(), running: albumExportJob.status.running };
    },
  );

  // Stops between files; the file being copied finishes, so nothing is left half-written.
  app.post(
    "/albums/export/cancel",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id) || !albumExportJob.cancel())
        return reply.code(409).send({ error: "No export is running" });
      return { ok: true };
    },
  );
}
