// A photo's burst and scene (scenes.ts), and which grid photos are in a burst. Only the photos taken
// around the ones asked about are read, through the (user_id, taken_at) index, then grouped in memory.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { captureVectors, CLIP_SPACE } from "@lifer/core/species/embeddings.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { galleryItemForDevice, sensitiveForKey, withoutSensitivePlace } from "../companion/privacy.js";
import { NOT_A_LINKED_VERSION } from "../captures/hidden.js";
import { Uuid, replies, withSchemas } from "../lib/schema.js";
import { GalleryItem } from "./responses.js";
import { GALLERY_ITEM_COLUMNS, GALLERY_ITEM_FRAME_JOINS, toGalleryItem, type GalleryRow } from "./routes.js";
import { BURST_JOIN, SCENE_GAP_MS, groupBursts, sceneOf, type SceneFrame } from "./scenes.js";

// The first window each side of a photo; it grows while the scene reaches its edge.
const SCENE_REACH_MS = 10 * 60_000;
// Frames read each side of the photo at most; a scene running past them is marked truncated.
const SIDE_MAX = 1000;
const MAX_ROUNDS = 6;
// The window around each grid photo for its burst; it grows while a burst reaches its edge.
const BURST_REACH_MS = 60_000;
// shortcut: a grid page whose windows hold more than this many frames gets no badges past it; page it if that bites.
const BURST_LOAD_MAX = 20_000;

interface FrameRow {
  id: string;
  t: number;
  camera_model: string | null;
  lens: string | null;
  lat: number | null;
  lon: number | null;
  computed_at: string | null;
}

// Still photos only: a video or recording is never a frame, and a linked version isn't another
// frame of its photo. A RAW and its JPEG are one capture, so one frame.
const frameSql = (cond: string, order: string, limit: string) => `
  SELECT c.id, (extract(epoch FROM c.taken_at) * 1000)::float8 AS t, c.camera_model, c.lens,
         c.lat::float8 AS lat, c.lon::float8 AS lon, ce.computed_at::text AS computed_at
    FROM captures c
    JOIN photos p ON p.id = c.current_photo_id AND p.kind = 'image'
    LEFT JOIN ${CLIP_SPACE.captureTable} ce ON ce.capture_id = c.id AND ce.model_version = $2
   WHERE c.user_id = $1 AND ${NOT_A_LINKED_VERSION} AND ${cond}
   ORDER BY ${order}
   LIMIT ${limit}`;

const toFrame = (r: FrameRow): SceneFrame => ({
  id: r.id,
  at: Math.round(Number(r.t) * 1000) / 1000,
  body: r.camera_model,
  lens: r.lens,
  lat: r.lat,
  lon: r.lon,
});

const vectorsOf = (rows: FrameRow[]) =>
  captureVectors(
    pool,
    CLIP_SPACE.captureTable,
    CLIP_SPACE.modelVersion,
    rows.map((r) => ({ capture_id: r.id, computed_at: r.computed_at })),
  );

const iso = (ms: number) => new Date(ms).toISOString();

/** The scene around one photo, or null when it isn't one of the user's dated still photos. */
async function sceneAround(userId: string, captureId: string) {
  const target = await pool.query<{ t: number }>(
    `SELECT (extract(epoch FROM c.taken_at) * 1000)::float8 AS t
       FROM captures c JOIN photos p ON p.id = c.current_photo_id AND p.kind = 'image'
      WHERE c.id = $1 AND c.user_id = $2 AND c.taken_at IS NOT NULL`,
    [captureId, userId],
  );
  if (!target.rows[0]) return null;
  const at = Number(target.rows[0].t);
  let [reachBefore, reachAfter] = [SCENE_REACH_MS, SCENE_REACH_MS];
  for (let round = 0; ; round++) {
    const side = (before: boolean) =>
      pool.query<FrameRow>(
        frameSql(
          before ? "c.taken_at <= $3 AND c.taken_at >= $4" : "c.taken_at > $3 AND c.taken_at <= $4",
          before ? "c.taken_at DESC, c.id DESC" : "c.taken_at, c.id",
          "$5",
        ),
        [userId, CLIP_SPACE.modelVersion, iso(at), iso(before ? at - reachBefore : at + reachAfter), SIDE_MAX],
      );
    const [before, after] = await Promise.all([side(true), side(false)]);
    const rows = [...before.rows, ...after.rows];
    const frames = rows.map(toFrame);
    const answer = sceneOf(captureId, frames, await vectorsOf(rows));
    if (!answer) return null;
    const [fullBefore, fullAfter] = [before.rows.length === SIDE_MAX, after.rows.length === SIDE_MAX];
    // Frames past the window within a scene gap could still belong.
    const openBefore = answer.span[0] - (at - reachBefore) <= SCENE_GAP_MS;
    const openAfter = at + reachAfter - answer.span[1] <= SCENE_GAP_MS;
    const growBefore = openBefore && !fullBefore;
    const growAfter = openAfter && !fullAfter;
    if ((!growBefore && !growAfter) || round === MAX_ROUNDS) {
      const cut = (openBefore && fullBefore) || (openAfter && fullAfter) || round === MAX_ROUNDS;
      return { ...answer, truncated: answer.truncated || cut };
    }
    if (growBefore) reachBefore *= 4;
    if (growAfter) reachAfter *= 4;
  }
}

/** For the given photos, the bursts of more than one frame they are in: the burst's first frame,
 *  its size, and which of the given photos it holds. */
async function burstsAmong(userId: string, captureIds: string[]) {
  const res = await pool.query<{ id: string; t: number }>(
    `SELECT c.id, (extract(epoch FROM c.taken_at) * 1000)::float8 AS t
       FROM captures c JOIN photos p ON p.id = c.current_photo_id AND p.kind = 'image'
      WHERE c.user_id = $1 AND c.id = ANY($2::uuid[]) AND c.taken_at IS NOT NULL`,
    [userId, captureIds],
  );
  const wanted = new Map(res.rows.map((r) => [r.id, Number(r.t)]));
  if (wanted.size === 0) return [];
  let ranges = merge([...wanted.values()].map((t) => [t - BURST_REACH_MS, t + BURST_REACH_MS]));
  for (let round = 0; ; round++) {
    const rows = (
      await pool.query<FrameRow>(
        frameSql(
          "EXISTS (SELECT 1 FROM unnest($3::timestamptz[], $4::timestamptz[]) r(lo, hi) WHERE c.taken_at BETWEEN r.lo AND r.hi)",
          "c.taken_at, c.id",
          String(BURST_LOAD_MAX),
        ),
        [userId, CLIP_SPACE.modelVersion, ranges.map((r) => iso(r[0])), ranges.map((r) => iso(r[1]))],
      )
    ).rows;
    const frames = rows.map(toFrame);
    const atOf = new Map(frames.map((f) => [f.id, f.at]));
    const bursts = groupBursts(frames, await vectorsOf(rows)).filter((b) => b.some((id) => wanted.has(id)));
    // A burst within joining reach of its window's edge may run on past it.
    let grew = false;
    if (rows.length < BURST_LOAD_MAX && round < MAX_ROUNDS) {
      ranges = merge(
        ranges.map(([lo, hi]) => {
          const inside = bursts.filter((b) => atOf.get(b[0])! >= lo && atOf.get(b[0])! <= hi);
          const first = Math.min(...inside.map((b) => atOf.get(b[0])!));
          const last = Math.max(...inside.map((b) => atOf.get(b[b.length - 1])!));
          const reach = BURST_REACH_MS * 4 ** (round + 1);
          const next: [number, number] = [
            first - lo <= BURST_JOIN.withinMs ? lo - reach : lo,
            hi - last <= BURST_JOIN.withinMs ? hi + reach : hi,
          ];
          if (next[0] !== lo || next[1] !== hi) grew = true;
          return next;
        }),
      );
    }
    if (!grew)
      return bursts
        .filter((b) => b.length > 1)
        .map((b) => ({ burstId: b[0], count: b.length, captureIds: b.filter((id) => wanted.has(id)) }));
  }
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const SceneReply = Type.Object({
  burst: Type.Array(Uuid(), { description: "The photo's burst: its frames' capture ids in time order" }),
  scene: Type.Array(
    Type.Object({
      burstId: Uuid({ description: "The burst's first frame" }),
      frames: Type.Array(GalleryItem),
    }),
    { description: "The scene's bursts in time order; the photo alone when it has no neighbours" },
  ),
  position: Type.Object({
    burst: Type.Integer({ description: "The photo's burst in scene" }),
    frame: Type.Integer({ description: "The photo in its burst" }),
  }),
  truncated: Type.Boolean({ description: "The scene had more frames than the 300 nearest the photo given here" }),
});

export async function sceneRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/captures/:id/scene",
    {
      // Not a phone route: a paired phone's key does not reach it.
      preValidation: requireScope("gallery.read"),
      schema: { params: Type.Object({ id: Uuid() }), response: replies(SceneReply) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const id = request.params.id;
      const found = await sceneAround(userId, id);
      const bursts = found?.bursts ?? [[id]];
      const rows = await pool.query<GalleryRow>(
        `SELECT ${GALLERY_ITEM_COLUMNS} FROM captures c ${GALLERY_ITEM_FRAME_JOINS}
          WHERE c.user_id = $1 AND c.id = ANY($2::uuid[])`,
        [userId, bursts.flat()],
      );
      if (!rows.rows.some((r) => r.capture_id === id)) return reply.code(404).send({ error: "Photo not found" });
      const sensitive = await sensitiveForKey(request, rows.rows);
      const items = new Map(
        rows.rows.map((r) => {
          const item = toGalleryItem(r, null);
          return [
            r.capture_id,
            sensitive && request.deviceKey
              ? galleryItemForDevice(item, sensitive)
              : withoutSensitivePlace(item, sensitive),
          ];
        }),
      );
      const scene = bursts.map((b) => ({
        burstId: b[0],
        frames: b.flatMap((cid) => items.get(cid) ?? []),
      }));
      const position = found ? { burst: found.burst, frame: found.frame } : { burst: 0, frame: 0 };
      return { burst: bursts[position.burst], scene, position, truncated: found?.truncated ?? false };
    },
  );

  // The Gallery grid's burst badges: which of a page's photos are in a burst, and its size.
  app.post(
    "/gallery/bursts",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ captureIds: Type.Array(Uuid(), { maxItems: 500 }) }, { additionalProperties: false }),
        response: replies(
          Type.Object({
            bursts: Type.Array(Type.Object({ burstId: Uuid(), count: Type.Integer(), captureIds: Type.Array(Uuid()) })),
          }),
        ),
      },
    },
    async (request) => ({ bursts: await burstsAmong(request.user!.id, request.body.captureIds) }),
  );
}
