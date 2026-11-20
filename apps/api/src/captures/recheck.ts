// A photo's region changed, so suggestions Lifer filed for it are weighed again against that
// region's checklist. Only photos still waiting as suggestions are looked at: a confirmed or
// user-chosen species is never touched (identification.ts).
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { suggestionVectorKind } from "@lifer/core/species/embeddings.js";
import { log } from "@lifer/core/lib/log.js";
import { requireAuth } from "../auth/session.js";
import { Open, replies, withSchemas } from "../lib/schema.js";
import { proposeIdentification, refileSuggested } from "./identification.js";

const BATCH = 200;

interface Pending {
  running: number;
  changed: number;
}
const pending = new Map<string, Pending>();

/** How many of these photos' suggestions now name a different species. */
export async function recheckSuggestions(userId: string, captureIds: string[]): Promise<number> {
  const user = await pool.query<{ species_suggest_enabled: boolean }>(
    `SELECT species_suggest_enabled FROM users WHERE id = $1`,
    [userId],
  );
  if (user.rows[0]?.species_suggest_enabled === false) return 0;
  const model = await suggestionVectorKind(pool).catch(() => null);
  if (!model) return 0;
  let changed = 0;
  for (let i = 0; i < captureIds.length; i += BATCH) {
    const rows = await pool.query<{
      id: string;
      species_id: string;
      region_id: string | null;
      taken_at: Date | null;
      embedding: number[];
    }>(
      `SELECT c.id, c.species_id, c.region_id, c.taken_at, e.embedding
       FROM captures c JOIN ${model.space.captureTable} e ON e.capture_id = c.id AND e.model_version = $3
       WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2 AND c.identification_state = 'suggested'`,
      [captureIds.slice(i, i + BATCH), userId, model.space.modelVersion],
    );
    for (const r of rows.rows) {
      const decision = await proposeIdentification(userId, Float32Array.from(r.embedding), r.region_id, r.taken_at);
      if (decision && decision.speciesId !== r.species_id && (await refileSuggested(pool, userId, r.id, decision)))
        changed++;
    }
  }
  return changed;
}

/** Starts a recheck in the background, one per change however many photos it covers. */
export function queueRecheck(userId: string, captureIds: string[]): void {
  if (captureIds.length === 0) return;
  const state = pending.get(userId) ?? { running: 0, changed: 0 };
  state.running++;
  pending.set(userId, state);
  void recheckSuggestions(userId, captureIds)
    .then((n) => void (state.changed += n))
    .catch((err) => log.warn({ err }, "Re-checking suggestions failed"))
    .finally(() => void state.running--);
}

export async function recheckRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Polled after a location change: once nothing is running, the count of changed suggestions is
  // handed over once and cleared.
  // A POST because reading it hands the count over and clears it.
  app.post(
    "/captures/recheck/poll",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Open({
            running: Type.Boolean(),
            changed: Type.Integer({ description: "Suggestions that changed since the last time this was read idle" }),
          }),
        ),
      },
    },
    async (request) => {
      const state = pending.get(request.user!.id);
      if (!state) return { running: false, changed: 0 };
      if (state.running > 0) return { running: true, changed: 0 };
      pending.delete(request.user!.id);
      return { running: false, changed: state.changed };
    },
  );
}
