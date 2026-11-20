// eBird "Download My Data" CSV import, which fills the `seen` state. Only a "Scientific Name"
// column is required, since eBird's headers vary between export versions.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { Uuid, replies, withSchemas } from "../lib/schema.js";
import { EbirdImportSummary } from "./responses.js";

// Larger than any eBird life list.
const MAX_UNDO_SPECIES = 50_000;

function parseCsv(text: string): Record<string, string>[] {
  // Doesn't handle commas inside quoted fields, which eBird's export doesn't use.
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

export async function importRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Multipart: the CSV is read with request.file(), so there's no JSON body to describe.
  app.post(
    "/imports/ebird-csv",
    { preValidation: requireAuth, schema: { response: replies(EbirdImportSummary) } },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "No CSV file uploaded" });

      const text = (await file.toBuffer()).toString("utf-8");
      const rows = parseCsv(text);
      if (rows.length === 0 || !("Scientific Name" in rows[0])) {
        return reply.code(400).send({ error: 'CSV must have a "Scientific Name" column' });
      }

      const userId = request.user!.id;
      // One species can appear on many checklists: dedupe before hitting the DB.
      const scientificNames = [...new Set(rows.map((r) => r["Scientific Name"]).filter(Boolean))];

      // One statement: match every name, insert the new ones. Never downgrades collected -> seen
      // and never touches an already-seen row (ON CONFLICT DO NOTHING).
      const res = await pool.query<{ matched_names: string[]; added_ids: string[] }>(
        `WITH hit AS (
         SELECT DISTINCT ON (s.scientific_name) s.id, s.scientific_name
         FROM species s WHERE s.scientific_name = ANY($2::text[])
       ),
       ins AS (
         INSERT INTO user_species (user_id, species_id, state)
         SELECT $1, hit.id, 'seen' FROM hit
         ON CONFLICT (user_id, species_id) DO NOTHING
         RETURNING species_id
       )
       SELECT COALESCE((SELECT array_agg(scientific_name) FROM hit), '{}')::text[] AS matched_names,
              COALESCE((SELECT array_agg(species_id) FROM ins), '{}')::text[] AS added_ids`,
        [userId, scientificNames],
      );
      const matchedNames = new Set(res.rows[0]?.matched_names ?? []);
      const addedSpeciesIds = res.rows[0]?.added_ids ?? [];
      const unmatchedNames = scientificNames.filter((n) => !matchedNames.has(n));

      return {
        totalRows: rows.length,
        uniqueSpecies: scientificNames.length,
        matched: matchedNames.size,
        alreadySeenOrCollected: matchedNames.size - addedSpeciesIds.length,
        unmatched: unmatchedNames.length,
        unmatchedNames,
        addedSpeciesIds,
      };
    },
  );

  // Undo takes back the ids an import returned. Only rows still plain `seen` are cleared, so a
  // species photographed since stays collected and a target flag survives.
  app.post(
    "/imports/ebird-csv/undo",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { speciesIds: Type.Array(Uuid(), { maxItems: MAX_UNDO_SPECIES }) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ removed: Type.Integer() })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const ids = request.body.speciesIds;
      const deleted = await pool.query(
        `DELETE FROM user_species
         WHERE user_id = $1 AND species_id = ANY($2::uuid[]) AND state = 'seen' AND NOT is_target`,
        [userId, ids],
      );
      const cleared = await pool.query(
        `UPDATE user_species SET state = NULL
         WHERE user_id = $1 AND species_id = ANY($2::uuid[]) AND state = 'seen'`,
        [userId, ids],
      );
      return { removed: (deleted.rowCount ?? 0) + (cleared.rowCount ?? 0) };
    },
  );
}
