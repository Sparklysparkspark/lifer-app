// Optional detailed maps, one per country (data-pipeline's pipeline/maps.ts): listed from the
// published index, downloaded one at a time in the background only when the user asks, and served
// from /maps/detail/ beside the world map.
import { backoffMemo, fetchPatient, HttpStatusError, retrying } from "../lib/remoteFetch.js";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import { MAP_DETAIL_DIR, MAP_DETAIL_INDEX_URL } from "@lifer/core/config.js";
import { ensureRoom, freeSpace } from "@lifer/core/lib/freeSpace.js";
import { downloadResumable } from "@lifer/core/lib/resumableDownload.js";
import { requireAuth } from "../auth/session.js";
import { createJob } from "../lib/job.js";
import { jobStatusFields, Nullable, Ok, Open, replies, withSchemas } from "../lib/schema.js";
import { parseRemoteJson } from "./schemas.js";

// Also the file name on disk, so it must never carry a path.
const CODE_PATTERN = "^[A-Z0-9-]{2,10}$";
const Code = Type.String({ pattern: CODE_PATTERN });

const MapDetailIndexSchema = Type.Object({
  generatedAt: Type.String(),
  extracts: Type.Array(
    Type.Object({
      code: Code,
      name: Type.String(),
      file: Type.String(),
      sizeBytes: Type.Number(),
      sha256: Type.String(),
    }),
  ),
});
type MapDetailIndex = Static<typeof MapDetailIndexSchema>;

const MapDetailEntry = Open({
  code: Type.String(),
  name: Type.String(),
  sizeBytes: Type.Number(),
  downloaded: Type.Boolean(),
  updateAvailable: Type.Boolean(),
});
const MapDetailStatus = Open({
  ...jobStatusFields(Open({ code: Type.String() })),
  code: Nullable(Type.String({ description: "The country downloading now" })),
  available: Type.Boolean({ description: "Whether any detailed maps are published" }),
  indexError: Nullable(Type.String()),
  extracts: Type.Array(MapDetailEntry),
  freeBytes: Nullable(Type.Number({ description: "Free space where maps are stored; null when unknown" })),
});

interface InstalledMeta {
  name: string;
  sha256: string;
  sizeBytes: number;
}
const filePath = (code: string, ext: string) => path.join(MAP_DETAIL_DIR, `${code}.${ext}`);

/** Country codes with a detailed map on disk, for the map style. */
export function installedMapDetails(): string[] {
  try {
    const codes = readdirSync(MAP_DETAIL_DIR)
      .filter((f) => f.endsWith(".pmtiles"))
      .map((f) => f.slice(0, -8));
    return codes.filter((c) => new RegExp(CODE_PATTERN).test(c)).sort();
  } catch {
    return [];
  }
}

function installedMeta(code: string): InstalledMeta | null {
  try {
    return JSON.parse(readFileSync(filePath(code, "json"), "utf8")) as InstalledMeta;
  } catch {
    return null;
  }
}

// Cached like the pack index; a download asks for a fresh copy. Null when nothing is published.
const INDEX_TTL_MS = 15 * 60_000;
let indexCache: { at: number; index: MapDetailIndex | null } | null = null;
// Failures back off, so the status answers from what's installed instead of waiting each time.
const failures = backoffMemo();
async function fetchMapDetailIndex(fresh = false): Promise<MapDetailIndex | null> {
  if (!fresh && indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.index;
  const failed = fresh ? null : failures.recent();
  if (failed) throw failed;
  // Patient, and a download (fresh) retries: a weak signal is slow, not gone.
  const { res, body } = await retrying(() => fetchPatient(MAP_DETAIL_INDEX_URL, { totalMs: 60_000 }), {
    attempts: fresh ? 3 : 1,
  }).catch((err: unknown) => {
    throw failures.fail(err);
  });
  failures.clear();
  let index: MapDetailIndex | null = null;
  if (res.status !== 404) {
    if (!res.ok) throw failures.fail(new HttpStatusError(res.status, "the detailed map index"));
    index = parseRemoteJson(MapDetailIndexSchema, JSON.parse(body.toString("utf8")), "detailed map index");
  }
  indexCache = { at: Date.now(), index };
  return index;
}

const job = createJob<{ code: string }, { code: string | null }>("map-detail-download", { code: null });

export async function mapDetailRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/offline-packs/maps/status",
    { preValidation: requireAuth, schema: { response: replies(MapDetailStatus) } },
    async () => {
      let index: MapDetailIndex | null = null;
      let indexError: string | null = null;
      try {
        index = await fetchMapDetailIndex();
      } catch (err) {
        indexError = (err as Error).message;
      }
      const installed = new Set(installedMapDetails());
      const listed = (index?.extracts ?? []).map((e) => {
        const meta = installed.has(e.code) ? installedMeta(e.code) : null;
        return {
          code: e.code,
          name: e.name,
          sizeBytes: e.sizeBytes,
          downloaded: installed.has(e.code),
          updateAvailable: meta != null && meta.sha256 !== e.sha256,
        };
      });
      // Kept while a republish drops a country, so it can still be removed.
      const unlisted = [...installed]
        .filter((code) => !listed.some((e) => e.code === code))
        .map((code) => {
          const meta = installedMeta(code);
          return {
            code,
            name: meta?.name ?? code,
            sizeBytes: meta?.sizeBytes ?? 0,
            downloaded: true,
            updateAvailable: false,
          };
        });
      return {
        ...job.status,
        available: index != null && index.extracts.length > 0,
        indexError,
        extracts: [...listed, ...unlisted].sort((a, b) => a.name.localeCompare(b.name)),
        freeBytes: await freeSpace(MAP_DETAIL_DIR),
      };
    },
  );

  app.post(
    "/offline-packs/maps/download",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ code: Code }, { additionalProperties: false }),
        response: replies(Open({ started: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      const { code } = request.body;
      if (job.status.running) return reply.code(409).send({ error: "A detailed map is already downloading" });
      const index = await fetchMapDetailIndex(true);
      const entry = index?.extracts.find((e) => e.code === code);
      if (!entry) return reply.code(404).send({ error: "No detailed map is published for that country" });
      // The file name comes from the fetched index, so it must stay on the index's own host.
      const url = new URL(entry.file, MAP_DETAIL_INDEX_URL);
      if (url.origin !== new URL(MAP_DETAIL_INDEX_URL).origin)
        return reply.code(400).send({ error: "Refusing a detailed map from an untrusted origin" });
      mkdirSync(MAP_DETAIL_DIR, { recursive: true });
      // Throws DiskFullError, answered as 507 with the sizes (index.ts).
      await ensureRoom(MAP_DETAIL_DIR, entry.sizeBytes);
      const started = job.start(
        async (ctx) => {
          // Downloaded to a .part file and renamed when whole, so an update replaces the old map at once.
          await downloadResumable(url.toString(), filePath(code, "pmtiles"), {
            signal: ctx.signal,
            expectedSha256: entry.sha256,
            label: `the detailed map of ${entry.name}`,
            onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
          });
          const meta: InstalledMeta = { name: entry.name, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
          writeFileSync(filePath(code, "json"), JSON.stringify(meta));
          return { code };
        },
        { code, currentItem: entry.name, phase: "downloading", downloadedBytes: 0, totalBytes: entry.sizeBytes },
      );
      if (!started) return reply.code(409).send({ error: "A detailed map is already downloading" });
      return { started: true };
    },
  );

  app.post(
    "/offline-packs/maps/download/cancel",
    { preValidation: requireAuth, schema: { response: replies(Open({ cancelled: Type.Boolean() })) } },
    async () => ({ cancelled: job.cancel() }),
  );

  app.delete(
    "/offline-packs/maps/:code",
    {
      preValidation: requireAuth,
      schema: { params: Type.Object({ code: Code }), response: replies(Ok) },
    },
    async (request) => {
      const { code } = request.params;
      if (job.status.running && job.status.code === code) {
        job.cancel();
        await job.settled();
      }
      for (const ext of ["pmtiles", "pmtiles.part", "json"]) rmSync(filePath(code, ext), { force: true });
      return { ok: true };
    },
  );
}
