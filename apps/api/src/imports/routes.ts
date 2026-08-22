// eBird "Download My Data" CSV import -> populates the `seen` state (spec §1/§9 Phase 3).
// Only requires a "Scientific Name" column to exist — eBird's own docs note headers have
// changed across export versions historically, so this is deliberately tolerant rather than
// hard-coding the full column list.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";

function parseCsv(text: string): Record<string, string>[] {
  // eBird's export is a plain, unquoted-field CSV in practice; this doesn't handle
  // embedded commas inside a quoted field, which is an acceptable limitation for a
  // personal import tool but worth knowing if a future export style breaks it.
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
    let matched = 0;
    let alreadySeenOrCollected = 0;
    let unmatched = 0;

    // One species can appear on many checklists — dedupe before hitting the DB.
    const scientificNames = [...new Set(rows.map((r) => r["Scientific Name"]).filter(Boolean))];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const name of scientificNames) {
        const speciesRes = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = $1`, [
          name,
        ]);
        const species = speciesRes.rows[0];
        if (!species) {
          unmatched++;
          continue;
        }
        matched++;
        // Never downgrade collected -> seen, and never touch an already-seen row.
        const res = await client.query(
          `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')
           ON CONFLICT (user_id, species_id) DO NOTHING`,
          [userId, species.id],
        );
        if (res.rowCount === 0) alreadySeenOrCollected++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return {
      totalRows: rows.length,
      uniqueSpecies: scientificNames.length,
      matched,
      alreadySeenOrCollected,
      unmatched,
    };
  });
}
