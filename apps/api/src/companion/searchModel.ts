// What a paired phone needs to search its photos offline with the hub's own picture search: the
// CLIP text encoder the hub embeds queries with (served as the hub holds it, int8 ONNX, so a query
// lands where the hub's would), its tokenizer, and each photo's stored image vector. The phone
// ranks with the same code as the hub (packages/shared searchRank.ts). Every route takes the
// "sync" scope or a device key ("companion").
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { TEXT_MODEL, TEXT_MODEL_VERSION } from "@lifer/core/species/textEmbedding.js";
import { float32ToFloat16Bits } from "@lifer/core/species/galleryEmbeddingsFormat.js";
import { requireScope } from "../auth/session.js";
import { statFile } from "../lib/cachedFile.js";
import { Nullable, Open, replies, withSchemas } from "../lib/schema.js";
import { sendRangeableFile } from "../photos/routes.js";
import { commitHorizon, isoStamp } from "../sync/changes.js";

const scope = requireScope("sync", ["companion"]);

/** CLIP ViT-L/14 projects text and images into the same 768 numbers. */
export const VECTOR_DIMENSION = 768;
const CONTEXT_LENGTH = 77;

// Route name (letters, digits, - and _ only: the desktop listener's :id) to the file in the model folder.
const MODEL_FILES = {
  encoder: { file: "onnx/text_model_quantized.onnx", type: "application/octet-stream" },
  tokenizer: { file: "tokenizer.json", type: "application/json" },
  "tokenizer-config": { file: "tokenizer_config.json", type: "application/json" },
  config: { file: "config.json", type: "application/json" },
} as const;
type ModelFile = keyof typeof MODEL_FILES;

const modelPath = (name: ModelFile) =>
  path.join(TEXT_MODEL.cacheDir, TEXT_MODEL.modelId, TEXT_MODEL.revision, MODEL_FILES[name].file);

// A file's hash is worked out once per size and modified time: the encoder is 125 MB.
const hashes = new Map<string, Promise<string>>();
function sha256Of(file: string, key: string): Promise<string> {
  let h = hashes.get(key);
  if (!h) {
    h = new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(file)
        .on("data", (c) => hash.update(c))
        .on("error", reject)
        .on("end", () => resolve(hash.digest("hex")));
    });
    h.catch(() => hashes.delete(key));
    hashes.set(key, h);
  }
  return h;
}

const ManifestFile = Open({
  name: Type.String(),
  size: Type.Integer(),
  sha256: Type.String(),
  url: Type.String({ description: "Path to fetch it from; supports Range" }),
});
const Manifest = Open({
  available: Type.Boolean({ description: "False until the text model is downloaded on the hub" }),
  textModelVersion: Type.String({ description: "Changes when the hub's text encoder (or how it runs) changes" }),
  imageModelVersion: Type.String({ description: "Changes when the hub recomputes every photo vector" }),
  dimension: Type.Integer(),
  normalization: Type.String(),
  precision: Type.String(),
  contextLength: Type.Integer(),
  output: Type.String(),
  files: Type.Array(ManifestFile),
});

const Cursor = Type.Object({ since: Type.String({ format: "date-time" }), after: Type.String({ format: "uuid" }) });
const VectorPage = Open({
  imageModelVersion: Type.String(),
  dimension: Type.Integer(),
  items: Type.Array(
    Open({
      id: Type.String({ format: "uuid", description: "The capture's id, as in /sync/changes" }),
      updatedAt: Type.String({ format: "date-time" }),
      vector: Type.String({ description: "Base64 of dimension little-endian float16 numbers, unit length" }),
    }),
  ),
  removed: Type.Array(
    Open({
      id: Type.String({ format: "uuid" }),
      at: Type.String({ format: "date-time" }),
    }),
    { description: "Captures to drop the vector of: deleted, hidden or trashed" },
  ),
  last: Nullable(Cursor),
  next: Nullable(Cursor),
});

const FramePage = Open({
  imageModelVersion: Type.String({ description: "The model the background vectors are from" }),
  items: Type.Array(
    Open({
      id: Type.String({ format: "uuid", description: "The capture's id, as in /sync/changes" }),
      updatedAt: Type.String({ format: "date-time" }),
      box: Nullable(
        Type.Array(Type.Number(), {
          description: "The detector's best animal box [x1, y1, x2, y2], fractions of the upright photo",
        }),
      ),
      boxUnsure: Type.Boolean(),
      aspect: Type.Number({ description: "Upright width / height" }),
      light: Open({
        luma: Type.Number(),
        warmth: Type.Number(),
        highlights: Type.Number(),
        shadows: Type.Number(),
        saturation: Type.Number(),
      }),
      takenAtZoned: Nullable(
        Type.Boolean({ description: "False: the file gave no time zone, so the sun can't be placed from the time" }),
      ),
      background: Nullable(
        Type.String({ description: "With background=1: base64 float16 background vector, unit length" }),
      ),
    }),
  ),
  removed: Type.Array(Open({ id: Type.String({ format: "uuid" }), at: Type.String({ format: "date-time" }) })),
  last: Nullable(Cursor),
  next: Nullable(Cursor),
});

/** A unit vector as little-endian float16, base64. */
export function encodeVector(v: ArrayLike<number>): string {
  const buf = Buffer.alloc(v.length * 2);
  for (let i = 0; i < v.length; i++) buf.writeUInt16LE(float32ToFloat16Bits(v[i]), i * 2);
  return buf.toString("base64");
}

export async function searchModelRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/companion/v1/model/text", { preValidation: scope, schema: { response: replies(Manifest) } }, async () => {
    const files = [];
    for (const name of Object.keys(MODEL_FILES) as ModelFile[]) {
      const st = await statFile(modelPath(name));
      if (!st) break;
      files.push({
        name,
        size: st.size,
        sha256: await sha256Of(modelPath(name), `${name}:${st.size}:${st.mtimeMs}`),
        url: `/api/companion/v1/model/text/${name}`,
      });
    }
    return {
      available: files.length === Object.keys(MODEL_FILES).length,
      textModelVersion: TEXT_MODEL_VERSION,
      imageModelVersion: EMBEDDING_MODEL_VERSION,
      dimension: VECTOR_DIMENSION,
      normalization: "l2",
      precision: "int8",
      contextLength: CONTEXT_LENGTH,
      output: "text_embeds",
      files,
    };
  });

  // The file as the hub holds it, with an ETag, Last-Modified and Range so a big download resumes.
  app.get(
    "/companion/v1/model/text/:id",
    { preValidation: scope, schema: { params: Type.Object({ id: Type.String({ pattern: "^[a-z-]{1,32}$" }) }) } },
    async (request, reply) => {
      const entry = (MODEL_FILES as Record<string, (typeof MODEL_FILES)[ModelFile] | undefined>)[request.params.id];
      const file = entry && modelPath(request.params.id as ModelFile);
      const st = file ? await statFile(file) : null;
      if (!entry || !file || !st) return reply.code(404).send({ error: "That model file isn't on this computer" });
      reply.header("X-Content-SHA256", await sha256Of(file, `${request.params.id}:${st.size}:${st.mtimeMs}`));
      return sendRangeableFile(request, reply, file, st, entry.type);
    },
  );

  // Photo vectors in the order they changed, paged by (changed, capture id) like /sync/changes. A
  // capture reappears when its vector or the capture itself changes, so one that was hidden and is
  // shown again gets its vector back. Nothing for a deleted, hidden or other user's capture.
  app.get(
    "/companion/v1/model/vectors",
    {
      preValidation: scope,
      schema: {
        querystring: Type.Object(
          {
            since: Type.Optional(Type.String({ format: "date-time" })),
            after: Type.Optional(Type.String({ format: "uuid" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
          },
          { additionalProperties: false },
        ),
        response: replies(VectorPage),
      },
    },
    async (request) => {
      const {
        since = "1970-01-01T00:00:00Z",
        after = "00000000-0000-0000-0000-000000000000",
        limit = 200,
      } = request.query;
      const horizon = await commitHorizon(pool);
      const changed = "GREATEST(c.updated_at, e.computed_at)";
      const res = await pool.query(
        `SELECT u.id, ${isoStamp("u.at")} AS at, u.kind, e.embedding
         FROM (
           (SELECT ${changed} AS at, c.id, CASE WHEN c.deleted_at IS NULL AND c.hidden_at IS NULL THEN 'item' ELSE 'removed' END AS kind
            FROM captures_all c JOIN capture_embeddings e ON e.capture_id = c.id AND e.model_version = $6
            WHERE c.user_id = $1 AND (${changed}, c.id) > ($2::timestamptz, $3::uuid) AND ${changed} < $5::timestamptz
            ORDER BY 1, 2 LIMIT $4)
           UNION ALL
           (SELECT t.deleted_at, t.ref::uuid, 'removed' FROM sync_tombstones t
            WHERE t.user_id = $1 AND t.kind = 'capture' AND (t.deleted_at, t.ref::uuid) > ($2::timestamptz, $3::uuid)
              AND t.deleted_at < $5::timestamptz
            ORDER BY 1, 2 LIMIT $4)
           ORDER BY 1, 2 LIMIT $4
         ) u
         LEFT JOIN capture_embeddings e ON u.kind = 'item' AND e.capture_id = u.id
         ORDER BY u.at, u.id`,
        [request.user!.id, since, after, limit, horizon, EMBEDDING_MODEL_VERSION],
      );
      const end = res.rows.at(-1);
      const last = end ? { since: end.at as string, after: end.id as string } : null;
      return {
        imageModelVersion: EMBEDDING_MODEL_VERSION,
        dimension: VECTOR_DIMENSION,
        items: res.rows
          .filter((r) => r.kind === "item" && r.embedding)
          .map((r) => ({ id: r.id, updatedAt: r.at, vector: encodeVector(r.embedding) })),
        removed: res.rows.filter((r) => r.kind === "removed").map((r) => ({ id: r.id, at: r.at })),
        last,
        next: res.rows.length === limit ? last : null,
      };
    },
  );

  // What search reads per photo besides its vector: the subject box, shape and light, whether its
  // time had a zone, and optionally the background vector. Paged like the vectors; a capture
  // reappears when its frame, background or the capture itself changes.
  app.get(
    "/companion/v1/model/frames",
    {
      preValidation: scope,
      schema: {
        querystring: Type.Object(
          {
            since: Type.Optional(Type.String({ format: "date-time" })),
            after: Type.Optional(Type.String({ format: "uuid" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
            background: Type.Optional(
              Type.Enum(["0", "1"], { description: "1 to include background vectors (about 1.5 KB each)" }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(FramePage),
      },
    },
    async (request) => {
      const {
        since = "1970-01-01T00:00:00Z",
        after = "00000000-0000-0000-0000-000000000000",
        limit = 200,
        background = "0",
      } = request.query;
      const horizon = await commitHorizon(pool);
      const changed = "GREATEST(c.updated_at, f.computed_at, b.computed_at)";
      const res = await pool.query(
        `SELECT u.id, ${isoStamp("u.at")} AS at, u.kind, f.box, f.box_unsure, f.aspect, f.light, c.taken_at_zoned,
                ${background === "1" ? "b.embedding" : "NULL::real[]"} AS background
         FROM (
           (SELECT ${changed} AS at, c.id, CASE WHEN c.deleted_at IS NULL AND c.hidden_at IS NULL THEN 'item' ELSE 'removed' END AS kind
            FROM captures_all c JOIN capture_frames f ON f.capture_id = c.id AND f.photo_id = c.current_photo_id
            LEFT JOIN capture_background_embeddings b
              ON b.capture_id = c.id AND b.photo_id = f.photo_id AND b.model_version = $6
            WHERE c.user_id = $1 AND (${changed}, c.id) > ($2::timestamptz, $3::uuid) AND ${changed} < $5::timestamptz
            ORDER BY 1, 2 LIMIT $4)
           UNION ALL
           (SELECT t.deleted_at, t.ref::uuid, 'removed' FROM sync_tombstones t
            WHERE t.user_id = $1 AND t.kind = 'capture' AND (t.deleted_at, t.ref::uuid) > ($2::timestamptz, $3::uuid)
              AND t.deleted_at < $5::timestamptz
            ORDER BY 1, 2 LIMIT $4)
           ORDER BY 1, 2 LIMIT $4
         ) u
         LEFT JOIN captures_all c ON u.kind = 'item' AND c.id = u.id
         LEFT JOIN capture_frames f ON u.kind = 'item' AND f.capture_id = u.id AND f.photo_id = c.current_photo_id
         LEFT JOIN capture_background_embeddings b
           ON u.kind = 'item' AND b.capture_id = u.id AND b.photo_id = f.photo_id AND b.model_version = $6
         ORDER BY u.at, u.id`,
        [request.user!.id, since, after, limit, horizon, EMBEDDING_MODEL_VERSION],
      );
      const end = res.rows.at(-1);
      const last = end ? { since: end.at as string, after: end.id as string } : null;
      return {
        imageModelVersion: EMBEDDING_MODEL_VERSION,
        items: res.rows
          .filter((r) => r.kind === "item" && r.aspect != null)
          .map((r) => ({
            id: r.id,
            updatedAt: r.at,
            box: r.box,
            boxUnsure: r.box_unsure,
            aspect: r.aspect,
            light: r.light,
            takenAtZoned: r.taken_at_zoned,
            background: r.background ? encodeVector(r.background) : null,
          })),
        removed: res.rows.filter((r) => r.kind === "removed").map((r) => ({ id: r.id, at: r.at })),
        last,
        next: res.rows.length === limit ? last : null,
      };
    },
  );
}
