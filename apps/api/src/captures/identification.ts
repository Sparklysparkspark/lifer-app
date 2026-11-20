// Identifications Lifer filed itself ("suggested") versus ones the user chose ("confirmed").
// A suggestion is only ever a confident match from the photo's own region checklist (core
// suggestedFiling.ts). It counts on the life list, marked, until the user confirms it, and
// nothing here ever changes a confirmed photo.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import type { Pool, PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { readFile } from "node:fs/promises";
import {
  rankSpeciesByEmbeddings,
  suggestionVectorKind,
  suggestSpecies,
  type SpeciesSuggestion,
} from "@lifer/core/species/embeddings.js";
import { sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import { chooseFiling, type FilingDecision } from "@lifer/core/species/suggestedFiling.js";
import { requireScope } from "../auth/session.js";
import { clusterForImport } from "@lifer/shared";
import { Nullable, Open, Uuid, replies, withSchemas } from "../lib/schema.js";
import { regionAt } from "../regions/regionAt.js";
import { prepareWorkingImage, type WorkingImage } from "../uploads/workingImage.js";

type Db = Pool | PoolClient;

/** The species a photo's vector says it is, when that is confident enough to file unasked. */
export async function proposeIdentification(
  userId: string,
  embedding: Float32Array,
  regionId: string | null,
  takenAt: Date | null,
  db: Db = pool,
): Promise<FilingDecision | null> {
  if (!regionId) return null;
  const model = await suggestionVectorKind(db as Pool).catch(() => null);
  if (!model) return null;
  const ranked = await rankSpeciesByEmbeddings(db as Pool, userId, [embedding], regionId, 5, takenAt, model.space);
  return decideFiling(ranked, regionId, db);
}

/** chooseFiling against the region's checklist as the database has it. */
export async function decideFiling(
  ranked: readonly SpeciesSuggestion[],
  regionId: string,
  db: Db = pool,
): Promise<FilingDecision | null> {
  const top = ranked[0];
  if (!top) return null;
  const meta = await db.query<{ taxon_class: string | null; listed: boolean }>(
    `SELECT s.taxon_class,
            EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = $2 AND rs.species_id = s.id) AS listed
     FROM species s WHERE s.id = $1`,
    [top.id, regionId],
  );
  return chooseFiling(ranked, () => meta.rows[0]?.taxon_class ?? null, meta.rows[0]?.listed === true);
}

/** For a photo file the analysis couldn't name from its tags or folder: a suggestion to file it
 *  under, from its GPS region's checklist. Null when it has no GPS, suggestions are off, the model
 *  isn't ready, or no match is confident enough. Never throws: the photo then just stays unfiled. */
export async function proposeIdentificationForFile(
  userId: string,
  filePath: string,
  lat: number | null,
  lon: number | null,
  takenAt: Date | null,
): Promise<(FilingDecision & { regionId: string }) | null> {
  if (lat == null || lon == null) return null;
  let working: WorkingImage | null = null;
  try {
    const enabled = await pool.query<{ species_suggest_enabled: boolean }>(
      `SELECT species_suggest_enabled FROM users WHERE id = $1`,
      [userId],
    );
    if (enabled.rows[0]?.species_suggest_enabled === false) return null;
    const region = await regionAt(lat, lon);
    if (!region) return null;
    const format = await sniffPhotoFormat(filePath);
    if (format) working = await prepareWorkingImage(filePath, format);
    const bytes = await readFile(working?.inferencePath ?? filePath);
    const ranked = await suggestSpecies(pool, userId, bytes, region.id, 5, takenAt, { priority: "background" });
    const decision = await decideFiling(ranked, region.id);
    return decision && { ...decision, regionId: region.id };
  } catch {
    return null;
  } finally {
    await working?.release();
  }
}

/** Files a new decision for photos still waiting as suggestions (a better model, a region set later).
 *  Confirmed photos are never touched. Returns how many changed. */
export async function refileSuggested(
  db: Db,
  userId: string,
  captureId: string,
  decision: FilingDecision,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE captures_all SET species_id = $3, suggestion_percent = $4
     WHERE id = $1 AND user_id = $2 AND identification_state = 'suggested'`,
    [captureId, userId, decision.speciesId, decision.matchPercent],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Marks suggestions as the user's own. Photos already confirmed are left as they are. */
export async function confirmIdentifications(db: Db, userId: string, captureIds: string[]): Promise<number> {
  const res = await db.query(
    `UPDATE captures_all SET identification_state = 'confirmed', suggestion_percent = NULL
     WHERE user_id = $1 AND id = ANY($2) AND identification_state = 'suggested'`,
    [userId, captureIds],
  );
  return res.rowCount ?? 0;
}

const MAX_ENCOUNTERS = 200;
const MAX_CONFIRM = 5000;

interface SuggestedRow {
  id: string;
  species_id: string;
  region_id: string | null;
  taken_at: Date | null;
  current_photo_id: string | null;
  suggestion_percent: number | null;
}

/** Waiting suggestions grouped into encounters: the same species in the same region with no gap of
 *  an hour or more between photos. Most uncertain first, then newest. */
export async function suggestedEncounters(userId: string) {
  const rows = (
    await pool.query<SuggestedRow>(
      `SELECT id, species_id, region_id, taken_at, current_photo_id, suggestion_percent
       FROM captures WHERE user_id = $1 AND identification_state = 'suggested'`,
      [userId],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byRegion = new Map<string, SuggestedRow[]>();
  for (const r of rows) byRegion.set(r.region_id ?? "", [...(byRegion.get(r.region_id ?? "") ?? []), r]);

  const encounters = [...byRegion.entries()].flatMap(([region, group]) =>
    clusterForImport(
      group.map((r) => ({ id: r.id, speciesId: r.species_id, takenAt: r.taken_at?.toISOString() ?? null })),
    ).map((c) => {
      const members = c.captureIds.map((id) => byId.get(id)!);
      return {
        speciesId: c.speciesId,
        regionId: region || null,
        captureIds: c.captureIds,
        count: c.captureIds.length,
        earliestTakenAt: c.earliestTakenAt,
        latestTakenAt: c.latestTakenAt,
        lowestPercent: Math.min(...members.map((m) => m.suggestion_percent ?? 100)),
        coverPhotoId: members.find((m) => m.current_photo_id)?.current_photo_id ?? null,
      };
    }),
  );
  encounters.sort(
    (a, b) => a.lowestPercent - b.lowestPercent || (b.latestTakenAt ?? "").localeCompare(a.latestTakenAt ?? ""),
  );
  const names = await pool.query<{ id: string; scientific_name: string; common_name: string | null }>(
    `SELECT id, scientific_name, common_name FROM species WHERE id = ANY($1)`,
    [[...new Set(encounters.map((e) => e.speciesId))]],
  );
  const nameOf = new Map(names.rows.map((n) => [n.id, n]));
  // Species with no confirmed photo yet: confirming one adds it to the life list.
  const lifers = new Set(
    (
      await pool.query<{ species_id: string }>(
        `SELECT species_id FROM captures WHERE user_id = $1 AND species_id = ANY($2)
         GROUP BY species_id HAVING bool_and(identification_state = 'suggested')`,
        [userId, [...new Set(encounters.map((e) => e.speciesId))]],
      )
    ).rows.map((r) => r.species_id),
  );
  // Possible lifers first; the sort is stable, so least sure stays first within each.
  encounters.sort((a, b) => Number(lifers.has(b.speciesId)) - Number(lifers.has(a.speciesId)));
  const confirmed = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM captures WHERE user_id = $1 AND identification_state = 'confirmed'`,
    [userId],
  );
  return {
    suggestedCount: rows.length,
    confirmedCount: confirmed.rows[0].n,
    encounterCount: encounters.length,
    encounters: encounters.slice(0, MAX_ENCOUNTERS).map((e) => ({
      ...e,
      scientificName: nameOf.get(e.speciesId)?.scientific_name ?? "",
      commonName: nameOf.get(e.speciesId)?.common_name ?? null,
      possibleLifer: lifers.has(e.speciesId),
      captureIds: e.captureIds.slice(0, 500),
      photoIds: e.captureIds.slice(0, 500).map((id) => byId.get(id)?.current_photo_id ?? null),
    })),
  };
}

const Encounter = Open({
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: Nullable(Type.String()),
  regionId: Nullable(Uuid()),
  captureIds: Type.Array(Uuid(), { description: "Up to 500 of the encounter's photos" }),
  photoIds: Type.Array(Nullable(Uuid()), { description: "Each of captureIds' current photo, in the same order" }),
  count: Type.Integer(),
  earliestTakenAt: Nullable(Type.String()),
  latestTakenAt: Nullable(Type.String()),
  lowestPercent: Type.Integer({ description: "The weakest match in the encounter, 0-100" }),
  coverPhotoId: Nullable(Uuid()),
  possibleLifer: Type.Boolean({ description: "No photo of this species is confirmed yet" }),
});

export async function identificationRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/identifications/suggested",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        response: replies(
          Open({
            suggestedCount: Type.Integer({ description: "Photos filed by Lifer and not yet confirmed" }),
            confirmedCount: Type.Integer({ description: "Photos whose species the user chose or confirmed" }),
            encounterCount: Type.Integer(),
            encounters: Type.Array(Encounter, { description: `The first ${MAX_ENCOUNTERS}, least sure first` }),
          }),
        ),
      },
    },
    async (request) => suggestedEncounters(request.user!.id),
  );

  // The sidebar's Review badge: a count only, so it can refresh on every page change.
  app.get(
    "/identifications/suggested/count",
    {
      preValidation: requireScope("photos.read"),
      schema: { response: replies(Open({ count: Type.Integer({ description: "Photos waiting for review" }) })) },
    },
    async (request) => {
      const res = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM captures WHERE user_id = $1 AND identification_state = 'suggested'`,
        [request.user!.id],
      );
      return { count: res.rows[0].n };
    },
  );

  app.post(
    "/identifications/confirm",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_CONFIRM }) },
          { additionalProperties: false },
        ),
        response: replies(Open({ ok: Type.Boolean(), confirmed: Type.Integer() })),
      },
    },
    async (request) => ({
      ok: true,
      confirmed: await confirmIdentifications(pool, request.user!.id, request.body.captureIds),
    }),
  );
}
