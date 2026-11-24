// A search for a file name ("6F9A8042.CR3", "IMG_1234") finds the photos whose files carry it.
import { pool } from "@lifer/core/db.js";

/** The lowercased query when it looks like a file name or a camera-style stem, else null. A bare
 *  word needs a letter and a digit, so years ("2024") and plain words stay normal searches. */
export function fileNameQuery(q: string): string | null {
  const t = q.trim().toLowerCase();
  if (/^[\w-]+\.[a-z0-9]{2,5}$/.test(t)) return t;
  if (t.length >= 4 && /^[\w-]+$/.test(t) && /[a-z]/.test(t) && /\d/.test(t)) return t;
  return null;
}

/** Ids of the photos (a linked version counts as its group's photo) with a file named `name` or
 *  starting with it, exact names and stems first. */
export async function capturesByFileName(userId: string, name: string): Promise<string[]> {
  const res = await pool.query<{ capture_id: string }>(
    String.raw`WITH f AS (
       SELECT o.capture_id, lower(regexp_replace(o.ref, '^.*[/\\]', '')) AS name
         FROM originals o WHERE o.user_id = $1 AND o.capture_id IS NOT NULL
     )
     SELECT COALESCE(cv.group_capture_id, f.capture_id)::text AS capture_id
       FROM f LEFT JOIN capture_versions cv ON cv.capture_id = f.capture_id AND cv.state = 'linked'
      WHERE starts_with(f.name, $2)
      GROUP BY 1
      ORDER BY bool_or(f.name = $2 OR regexp_replace(f.name, '\.[^.]*$', '') = $2) DESC, min(f.name)`,
    [userId, name],
  );
  return res.rows.map((r) => r.capture_id);
}
