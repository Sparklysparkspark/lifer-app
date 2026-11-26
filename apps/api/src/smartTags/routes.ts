// Smart tags (docs/plans/smart-tags.md): how far the suggestion pass has got (ST-2), and the
// decisions (ST-3): suggestions per photo and per term, accept, reject, hide and undo. Nothing here
// writes to a photo file; accepted smart tags reach files only through the file-write switch (ST-6).
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { SMART_TAG_VOCAB } from "@lifer/shared";
import { requireScope } from "../auth/session.js";
import { IdParams, notFoundOnInvalidId, Nullable, replies, Uuid, withSchemas } from "../lib/schema.js";
import { isoStamp } from "../sync/changes.js";
import { SmartTagTermId } from "../sync/library.js";
import {
  applyDecisions,
  PENDING,
  pendingParams,
  recordBatch,
  spellingFor,
  TERMS,
  termView,
  undoBatch,
  type DecisionState,
} from "./decisions.js";
import { smartTagCounts, smartTagJob } from "./suggestionPass.js";

const TermView = Type.Object({
  id: Type.String({ description: "Vocabulary term id, the tag's identity everywhere" }),
  name: Type.String({ description: "Label in the reader's spelling" }),
  path: Type.String({ description: "Facet path in the reader's spelling, like Habitat|Wetland" }),
  facet: Type.String({ description: "Facet root in the reader's spelling" }),
  group: Type.String({ description: "Vocabulary group id" }),
  signal: Type.String({ description: "How it is suggested: computed, scene, clip or manual" }),
});
const Locale = Type.Optional(
  Type.String({ maxLength: 35, description: "The reader's locale, like en-GB, for spelling; else the account's" }),
);
const AsOf = Type.String({
  format: "date-time",
  description: "The server's time when the list was read; pass it back to act on exactly what was shown",
});
const TermParams = Type.Object({ termId: SmartTagTermId });
const DecisionBody = Type.Object(
  {
    termId: SmartTagTermId,
    captureIds: Type.Optional(
      Type.Array(Uuid(), { minItems: 1, maxItems: 10000, description: "These photos; or send allPending" }),
    ),
    allPending: Type.Optional(
      Type.Object(
        {
          asOf: Type.Optional(AsOf),
          except: Type.Optional(Type.Array(Uuid(), { maxItems: 20000, description: "Photos the reviewer deselected" })),
        },
        { additionalProperties: false, description: "Every photo with this term pending, taken on the server" },
      ),
    ),
  },
  { additionalProperties: false },
);
const BatchReply = Type.Object({
  updated: Type.Integer({ description: "Photo and term pairs that changed" }),
  undoToken: Nullable(Uuid({ description: "Undoes this batch once, for an hour; null when nothing changed" })),
});
const Ok = Type.Object({ ok: Type.Boolean() });

const unknownTerm = (reply: FastifyReply) =>
  reply.code(404).send({ error: "That smart tag isn't in the vocabulary", code: "not_found" });

export async function smartTagRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/smart-tags/status",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        response: replies(
          Type.Object({
            running: Type.Boolean({ description: "The suggestion pass is running now" }),
            total: Type.Integer({ description: "Your photos, trashed ones left out" }),
            evaluated: Type.Integer({ description: "Photos evaluated under the current vocabulary and data" }),
            pending: Type.Integer({ description: "Photos waiting for the pass" }),
          }),
        ),
      },
    },
    async (request) => {
      const { total, pending } = await smartTagCounts(request.user!.id);
      return { running: smartTagJob.status.running, total, evaluated: total - pending, pending };
    },
  );

  // The viewer's strip: one photo's pending suggestions, strongest first, and its decisions.
  app.get(
    "/smart-tags/captures/:id",
    {
      preValidation: requireScope("photos.read"),
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        querystring: Type.Object({ locale: Locale }, { additionalProperties: false }),
        response: replies(
          Type.Object({
            suggestions: Type.Array(
              Type.Object({ ...TermView.properties, score: Type.Number(), source: Type.String() }),
            ),
            accepted: Type.Array(TermView),
            rejected: Type.Array(TermView),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const own = await pool.query<{ accepted: Record<string, string>; rejected: string[] }>(
        `SELECT smart_tags_accepted AS accepted, smart_tags_rejected AS rejected FROM captures_all
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [request.params.id, userId],
      );
      if (!own.rows[0]) return reply.code(404).send({ error: "Capture not found", code: "not_found" });
      const spelling = await spellingFor(userId, request.query.locale);
      const res = await pool.query<{ term_id: string; score: number; source: string }>(
        `SELECT s.term_id, s.score, s.source ${PENDING} AND c.id = $5 ORDER BY s.score DESC, s.term_id`,
        [...pendingParams(userId), request.params.id],
      );
      const views = (ids: string[]) => ids.flatMap((id) => (TERMS.has(id) ? [termView(TERMS.get(id)!, spelling)] : []));
      return {
        suggestions: res.rows.map((r) => ({
          ...termView(TERMS.get(r.term_id)!, spelling),
          score: r.score,
          source: r.source,
        })),
        accepted: views(Object.keys(own.rows[0].accepted)),
        rejected: views(own.rows[0].rejected),
      };
    },
  );

  // Review by term: each term with photos waiting, most first, and the terms hidden for every photo.
  app.get(
    "/smart-tags/terms",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        querystring: Type.Object({ locale: Locale }, { additionalProperties: false }),
        response: replies(
          Type.Object({
            asOf: AsOf,
            terms: Type.Array(Type.Object({ ...TermView.properties, pending: Type.Integer() })),
            hidden: Type.Array(TermView),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const spelling = await spellingFor(userId, request.query.locale);
      const asOf = await pool.query<{ t: string }>(`SELECT ${isoStamp("now()")} AS t`);
      const [counts, hidden] = await Promise.all([
        pool.query<{ term_id: string; pending: number }>(
          `SELECT s.term_id, count(*)::int AS pending ${PENDING} GROUP BY s.term_id ORDER BY pending DESC, s.term_id`,
          pendingParams(userId),
        ),
        pool.query<{ term_id: string }>(
          `SELECT term_id FROM smart_tag_hidden_terms WHERE user_id = $1 ORDER BY term_id`,
          [userId],
        ),
      ]);
      return {
        asOf: asOf.rows[0].t,
        terms: counts.rows.map((r) => ({ ...termView(TERMS.get(r.term_id)!, spelling), pending: r.pending })),
        hidden: hidden.rows.flatMap((r) => (TERMS.has(r.term_id) ? [termView(TERMS.get(r.term_id)!, spelling)] : [])),
      };
    },
  );

  // A term's pending photos, strongest first, paged by a cursor so accepting one page never skips
  // photos on the next.
  app.get(
    "/smart-tags/terms/:termId/photos",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        params: TermParams,
        querystring: Type.Object(
          {
            limit: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 500, default: 200, description: "Photos per page" }),
            ),
            after: Type.Optional(
              Type.String({
                maxLength: 80,
                pattern: "^[-+0-9.eE]+:[0-9a-fA-F-]{36}$",
                description: "The previous page's next",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            asOf: AsOf,
            total: Type.Integer({ description: "Photos with this term pending" }),
            items: Type.Array(
              Type.Object({
                captureId: Uuid(),
                photoId: Nullable(Uuid()),
                score: Type.Number(),
                source: Type.String(),
              }),
            ),
            next: Nullable(Type.String({ description: "Pass as after for the next page; null on the last" })),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { termId } = request.params;
      if (!TERMS.has(termId)) return unknownTerm(reply);
      const userId = request.user!.id;
      const limit = request.query.limit ?? 200;
      const cut = request.query.after?.match(/^(.+):(.{36})$/);
      const asOf = await pool.query<{ t: string }>(`SELECT ${isoStamp("now()")} AS t`);
      const [total, page] = await Promise.all([
        pool.query<{ n: number }>(`SELECT count(*)::int AS n ${PENDING} AND s.term_id = $5`, [
          ...pendingParams(userId),
          termId,
        ]),
        pool.query<{ capture_id: string; current_photo_id: string | null; score: number; source: string }>(
          `SELECT s.capture_id, c.current_photo_id, s.score, s.source ${PENDING} AND s.term_id = $5
             AND ($6::real IS NULL OR (s.score, s.capture_id) < ($6::real, $7::uuid))
           ORDER BY s.score DESC, s.capture_id DESC LIMIT $8`,
          [...pendingParams(userId), termId, cut ? Number(cut[1]) : null, cut?.[2] ?? null, limit],
        ),
      ]);
      const last = page.rows.at(-1);
      return {
        asOf: asOf.rows[0].t,
        total: total.rows[0].n,
        items: page.rows.map((r) => ({
          captureId: r.capture_id,
          photoId: r.current_photo_id,
          score: r.score,
          source: r.source,
        })),
        next: last && page.rows.length === limit ? `${last.score}:${last.capture_id}` : null,
      };
    },
  );

  // Accept and reject: some photos, or every photo with the term pending (less the reviewer's
  // deselections). Atomic, idempotent, and one undo step.
  for (const [url, to] of [
    ["/smart-tags/accept", "accepted"],
    ["/smart-tags/reject", "rejected"],
  ] as const) {
    app.post(
      url,
      {
        preValidation: requireScope("photos.write"),
        schema: { body: DecisionBody, response: replies(BatchReply) },
      },
      async (request, reply) => {
        const { termId, captureIds, allPending } = request.body;
        if (!TERMS.has(termId)) return unknownTerm(reply);
        if (!captureIds === !allPending)
          return reply.code(400).send({ error: "Send captureIds or allPending, one of them", code: "invalid_request" });
        const userId = request.user!.id;
        return withTransaction(async (client) => {
          const pairs = captureIds
            ? captureIds.map((captureId) => ({ captureId, termId }))
            : await pendingPairs(client, userId, [termId], allPending!.asOf, allPending!.except);
          const decisions = pairs.map((p) => ({ ...p, to: to as DecisionState }));
          const changes = await applyDecisions(client, userId, decisions, { onlyFromNone: !!allPending });
          return { updated: changes.length, undoToken: await recordBatch(client, userId, changes) };
        });
      },
    );
  }

  // One click for a facet the stored data decides (Time of day, Season, Colour): its computed
  // terms only, since those need no review.
  app.post(
    "/smart-tags/facets/:group/accept",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        params: Type.Object({ group: SmartTagTermId }),
        response: replies(BatchReply),
      },
    },
    async (request, reply) => {
      const { group } = request.params;
      if (!SMART_TAG_VOCAB.groups.some((g) => g.id === group))
        return reply.code(404).send({ error: "That smart tag facet isn't in the vocabulary", code: "not_found" });
      const terms = SMART_TAG_VOCAB.terms.filter((t) => t.group === group && t.signal === "computed").map((t) => t.id);
      if (terms.length === 0)
        return reply.code(400).send({
          error: "Only facets worked out from the photo's data can be accepted all at once",
          code: "not_computed",
        });
      const userId = request.user!.id;
      return withTransaction(async (client) => {
        const pairs = await pendingPairs(client, userId, terms);
        const changes = await applyDecisions(
          client,
          userId,
          pairs.map((p) => ({ ...p, to: "accepted" as const })),
          { onlyFromNone: true },
        );
        return { updated: changes.length, undoToken: await recordBatch(client, userId, changes) };
      });
    },
  );

  app.post(
    "/smart-tags/undo",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object({ token: Uuid() }, { additionalProperties: false }),
        response: replies(
          Type.Object({ restored: Type.Integer({ description: "Pairs put back; 0 if already undone" }) }),
        ),
      },
    },
    async (request, reply) => {
      const restored = await withTransaction((client) => undoBatch(client, request.user!.id, request.body.token));
      if (restored === null)
        return reply.code(410).send({ error: "That can no longer be undone", code: "undo_expired" });
      return { restored };
    },
  );

  // "Never suggest Wetland": hides a term for every photo, and brings it back. Idempotent.
  app.put(
    "/smart-tags/hidden/:termId",
    { preValidation: requireScope("photos.write"), schema: { params: TermParams, response: replies(Ok) } },
    async (request, reply) => {
      if (!TERMS.has(request.params.termId)) return unknownTerm(reply);
      await pool.query(`INSERT INTO smart_tag_hidden_terms (user_id, term_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        request.user!.id,
        request.params.termId,
      ]);
      return { ok: true };
    },
  );
  app.delete(
    "/smart-tags/hidden/:termId",
    { preValidation: requireScope("photos.write"), schema: { params: TermParams, response: replies(Ok) } },
    async (request) => {
      await pool.query(`DELETE FROM smart_tag_hidden_terms WHERE user_id = $1 AND term_id = $2`, [
        request.user!.id,
        request.params.termId,
      ]);
      return { ok: true };
    },
  );
}

/** Pending photo and term pairs for these terms, as the server has them now (or as of `asOf`). */
async function pendingPairs(db: PoolClient, userId: string, termIds: string[], asOf?: string, except: string[] = []) {
  const res = await db.query<{ capture_id: string; term_id: string }>(
    `SELECT s.capture_id, s.term_id ${PENDING} AND s.term_id = ANY($5::text[])
       AND ($6::timestamptz IS NULL OR s.computed_at <= $6::timestamptz) AND s.capture_id <> ALL ($7::uuid[])`,
    [...pendingParams(userId), termIds, asOf ?? null, except],
  );
  return res.rows.map((r) => ({ captureId: r.capture_id, termId: r.term_id }));
}
