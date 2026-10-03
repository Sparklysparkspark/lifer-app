// eBird "Download My Data" CSV import, which fills the `seen` state. Only a "Scientific Name"
// column is required, since eBird's headers vary between export versions.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";

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

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.post("/imports/ebird-csv", { preHandler: requireAuth }, async (request, reply) => {
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
    const res = await pool.query<{ matched: number; inserted: number }>(
      `WITH hit AS (
         SELECT DISTINCT ON (s.scientific_name) s.id
         FROM species s WHERE s.scientific_name = ANY($2::text[])
       ),
       ins AS (
         INSERT INTO user_species (user_id, species_id, state)
         SELECT $1, hit.id, 'seen' FROM hit
         ON CONFLICT (user_id, species_id) DO NOTHING
         RETURNING 1
       )
       SELECT (SELECT COUNT(*) FROM hit)::int AS matched, (SELECT COUNT(*) FROM ins)::int AS inserted`,
      [userId, scientificNames],
    );
    const matched = res.rows[0]?.matched ?? 0;
    const alreadySeenOrCollected = matched - (res.rows[0]?.inserted ?? 0);
    const unmatched = scientificNames.length - matched;

    return {
      totalRows: rows.length,
      uniqueSpecies: scientificNames.length,
      matched,
      alreadySeenOrCollected,
      unmatched,
    };
  });
}
