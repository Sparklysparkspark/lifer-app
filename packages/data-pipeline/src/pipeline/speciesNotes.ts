// Loads the field-guide notes summarised from each species' Wikipedia article (migration 140) into
// species.habitat_notes and species.identification_notes. The notes are written offline: a small
// model summarises each article's sentences into short bullets, each citing the sentences it came
// from, and a checker keeps only bullets those sentences support (no copied sentences, no numbers or
// names the sentences don't state). Species whose article turned out to be about another taxon (a
// synonym redirect, a genus page) are left out before this point and keep their Wikipedia text.
//
// Input: a JSON file of {species id: {"sections": [{"heading", "bullets": [{"text", "sources"}]}],
// "title": article title, "revid": article revision}}. The citations stay with the offline run;
// the app stores the headings and bullet text, the article URL for the credit link, and the revision.
import type { Pool, PoolClient } from "pg";

export type NotesColumn = "habitat_notes" | "identification_notes";

export interface NotesInput {
  sections: { heading: string; bullets: { text: string; sources?: number[] }[] }[];
  title: string | null;
  revid: number | null;
}

export interface StoredNotes {
  sections: { heading: string; bullets: string[] }[];
  source_url: string | null;
  revision_id: number | null;
}

/** At most this many bullets a species; the offline build trims to it, this only guards the load. */
export const MAX_BULLETS = 6;
const MAX_BULLET_CHARS = 300;

export function articleUrlFromTitle(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** The stored shape, or null when nothing usable is left (no headings, no non-empty bullets). */
export function toStoredNotes(input: NotesInput): StoredNotes | null {
  let room = MAX_BULLETS;
  const sections: StoredNotes["sections"] = [];
  for (const section of input.sections ?? []) {
    const heading = section.heading?.trim();
    if (!heading) continue;
    const bullets: string[] = [];
    for (const bullet of section.bullets ?? []) {
      const text = bullet.text?.trim();
      if (!text || text.length > MAX_BULLET_CHARS || room === 0) continue;
      bullets.push(text);
      room--;
    }
    if (bullets.length) sections.push({ heading, bullets });
  }
  if (!sections.length) return null;
  return {
    sections,
    source_url: input.title ? articleUrlFromTitle(input.title) : null,
    revision_id: input.revid ?? null,
  };
}

export interface LoadResult {
  read: number;
  written: number;
  unknownSpecies: number;
  empty: number;
}

/** Writes one column from a notes file, in chunks. Species not in the table are counted, not added. */
export async function loadNotes(
  db: Pool | PoolClient,
  column: NotesColumn,
  notes: Record<string, NotesInput>,
  opts: { chunk?: number; dryRun?: boolean } = {},
): Promise<LoadResult> {
  const chunk = opts.chunk ?? 1000;
  const rows: { id: string; notes: StoredNotes }[] = [];
  let empty = 0;
  for (const [id, input] of Object.entries(notes)) {
    const stored = toStoredNotes(input);
    if (stored) rows.push({ id, notes: stored });
    else empty++;
  }
  let written = 0;
  if (!opts.dryRun) {
    for (let i = 0; i < rows.length; i += chunk) {
      // The column name comes from the NotesColumn union, never from input. Unchanged rows are
      // skipped, so a rerun writes nothing.
      const result = await db.query(
        `UPDATE species s SET ${column} = v.notes
         FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, notes jsonb)
         WHERE s.id = v.id AND s.${column} IS DISTINCT FROM v.notes`,
        [JSON.stringify(rows.slice(i, i + chunk))],
      );
      written += result.rowCount ?? 0;
    }
  }
  const { rows: present } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM species WHERE id = ANY($1::uuid[])",
    [rows.map((r) => r.id)],
  );
  return { read: Object.keys(notes).length, written, unknownSpecies: rows.length - present[0].n, empty };
}
