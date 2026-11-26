// Smart tag decisions (docs/plans/smart-tags.md, ST-3): accepting, rejecting and hiding terms, and
// undoing a batch. An accepted term becomes an ordinary photo tag at its canonical US path, with a
// marker in smart_tags_accepted; a rejected one goes to smart_tags_rejected (migration 208). Nothing
// here writes to a file: accepted smart tags reach files only through the file-write switch (ST-6).
import type { PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import {
  SMART_TAG_VOCAB,
  smartTagLabel,
  smartTagPath,
  spellingForLocale,
  type SmartTagTerm,
  type Spelling,
} from "@lifer/shared";

export type DecisionState = "none" | "accepted" | "rejected";
export interface Decision {
  captureId: string;
  termId: string;
  to: DecisionState;
}

export const TERMS = new Map(SMART_TAG_VOCAB.terms.map((t) => [t.id, t]));
const ukPath = (t: SmartTagTerm) => smartTagPath(t, "uk");
// Every term's id and its paths in both spellings, as query parameters.
const TERM_PARAMS = [
  SMART_TAG_VOCAB.terms.map((t) => t.id),
  SMART_TAG_VOCAB.terms.map((t) => t.path),
  SMART_TAG_VOCAB.terms.map(ukPath),
];

/** Pending suggestions of user $1, with the vocabulary as $2 to $4: not decided, not hidden, not
 *  already a typed tag in either spelling, on a live photo the user hasn't hidden. */
export const PENDING = `
  FROM capture_smart_suggestions s
  JOIN captures_all c ON c.id = s.capture_id
  JOIN unnest($2::text[], $3::text[], $4::text[]) AS v(term_id, us, uk) ON v.term_id = s.term_id
  WHERE c.user_id = $1 AND c.deleted_at IS NULL AND c.hidden_at IS NULL
    AND NOT (c.smart_tags_accepted ? s.term_id) AND s.term_id <> ALL (c.smart_tags_rejected)
    AND NOT (c.tags && ARRAY[v.us, v.uk])
    AND NOT EXISTS (SELECT 1 FROM smart_tag_hidden_terms h WHERE h.user_id = $1 AND h.term_id = s.term_id)`;
export const pendingParams = (userId: string) => [userId, ...TERM_PARAMS];

/** How a term reads in a spelling. */
export function termView(t: SmartTagTerm, spelling: Spelling) {
  const path = smartTagPath(t, spelling);
  return {
    id: t.id,
    name: smartTagLabel(t, spelling),
    path,
    facet: path.split("|")[0],
    group: t.group,
    signal: t.signal,
  };
}

/** The spelling to show: the locale the client sends, else the account's language, else US. */
export async function spellingFor(userId: string, locale: string | undefined): Promise<Spelling> {
  if (locale) return spellingForLocale(locale);
  const res = await pool.query<{ locale: string | null }>(`SELECT locale FROM users WHERE id = $1`, [userId]);
  return spellingForLocale(res.rows[0]?.locale);
}

interface Row {
  id: string;
  tags: string[];
  accepted: Record<string, string>;
  rejected: string[];
}

const stateOf = (r: Row, termId: string): DecisionState =>
  termId in r.accepted ? "accepted" : r.rejected.includes(termId) ? "rejected" : "none";

/** Moves one term on one photo to `to`. False when nothing changes: already there, or an accept of
 *  a tag the user typed themselves (it stays theirs, so it is never kept out of files). */
function move(r: Row, termId: string, to: DecisionState): boolean {
  const from = stateOf(r, termId);
  const term = TERMS.get(termId);
  if (from === to || (to === "accepted" && (!term || r.tags.includes(term.path) || r.tags.includes(ukPath(term)))))
    return false;
  if (from === "accepted") {
    const path = r.accepted[termId];
    r.tags = r.tags.filter((t) => t !== path);
    delete r.accepted[termId];
  }
  r.rejected = r.rejected.filter((t) => t !== termId);
  if (to === "accepted") {
    r.accepted[termId] = term!.path;
    r.tags = [...r.tags, term!.path];
  } else if (to === "rejected") r.rejected = [...r.rejected, termId];
  return true;
}

const WRITE_CHUNK = 5000;

/**
 * Applies decisions to the user's own live photos in the caller's transaction, rows locked first, and
 * returns what each changed pair was before. `onlyFromNone` skips pairs decided meanwhile (a bulk
 * accept of what is pending must not overturn a reject made a moment ago).
 */
export async function applyDecisions(
  client: PoolClient,
  userId: string,
  decisions: Decision[],
  { onlyFromNone = false } = {},
): Promise<Array<{ captureId: string; termId: string; prev: DecisionState }>> {
  const ids = [...new Set(decisions.map((d) => d.captureId))];
  if (ids.length === 0) return [];
  const res = await client.query<Row>(
    `SELECT id, tags, smart_tags_accepted AS accepted, smart_tags_rejected AS rejected FROM captures_all
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
    [userId, ids],
  );
  const rows = new Map(res.rows.map((r) => [r.id, r]));
  const changed = new Set<Row>();
  const out: Array<{ captureId: string; termId: string; prev: DecisionState }> = [];
  for (const d of decisions) {
    const r = rows.get(d.captureId);
    if (!r) continue;
    const prev = stateOf(r, d.termId);
    if (onlyFromNone && prev !== "none") continue;
    if (!move(r, d.termId, d.to)) continue;
    changed.add(r);
    out.push({ captureId: d.captureId, termId: d.termId, prev });
  }
  const list = [...changed];
  for (let i = 0; i < list.length; i += WRITE_CHUNK) {
    await client.query(
      `UPDATE captures_all c SET tags = v.tags, smart_tags_accepted = v.accepted, smart_tags_rejected = v.rejected
       FROM jsonb_to_recordset($2::jsonb) AS v(id uuid, tags text[], accepted jsonb, rejected text[])
       WHERE c.id = v.id AND c.user_id = $1`,
      [userId, JSON.stringify(list.slice(i, i + WRITE_CHUNK))],
    );
  }
  return out;
}

/** How long an undo token works. One level per batch: a token undoes once. */
export const UNDO_TTL_MINUTES = 60;

/** Records a batch for undo and returns its token; null when the batch changed nothing. */
export async function recordBatch(
  client: PoolClient,
  userId: string,
  changes: Array<{ captureId: string; termId: string; prev: DecisionState }>,
): Promise<string | null> {
  await client.query(`DELETE FROM smart_tag_batches WHERE created_at < now() - interval '1 day'`);
  if (changes.length === 0) return null;
  const res = await client.query<{ id: string }>(
    `INSERT INTO smart_tag_batches (user_id, capture_ids, term_ids, prev) VALUES ($1, $2::uuid[], $3::text[], $4::text[])
     RETURNING id`,
    [userId, changes.map((c) => c.captureId), changes.map((c) => c.termId), changes.map((c) => c.prev)],
  );
  return res.rows[0].id;
}

/** Undoes a batch: each photo and term back to its decision before it. Null when the token is
 *  unknown or expired; 0 when it was already used. */
export async function undoBatch(client: PoolClient, userId: string, token: string): Promise<number | null> {
  const res = await client.query<{ capture_ids: string[]; term_ids: string[]; prev: DecisionState[]; undone: boolean }>(
    `SELECT capture_ids, term_ids, prev, undone_at IS NOT NULL AS undone FROM smart_tag_batches
     WHERE id = $1 AND user_id = $2 AND created_at > now() - make_interval(mins => $3) FOR UPDATE`,
    [token, userId, UNDO_TTL_MINUTES],
  );
  const batch = res.rows[0];
  if (!batch) return null;
  if (batch.undone) return 0;
  await client.query(`UPDATE smart_tag_batches SET undone_at = now() WHERE id = $1`, [token]);
  const restored = await applyDecisions(
    client,
    userId,
    batch.capture_ids.map((captureId, i) => ({ captureId, termId: batch.term_ids[i], to: batch.prev[i] })),
  );
  return restored.length;
}
