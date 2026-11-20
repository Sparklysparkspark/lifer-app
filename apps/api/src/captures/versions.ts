// Photo versions in the viewer and the group review (uploads/versionGrouping.ts groups them).
// Every change is undoable by its opposite route and asks for no confirmation.
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { IdParams, Nullable, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { jobStatusFields } from "../lib/schema.js";
import { galleryFiltersFor, searchGallery } from "../gallery/routes.js";
import {
  DEFAULT_VERSION_FOLDERS,
  linkVersionTx,
  showVersionTx,
  splitVersionTx,
  startVersionGroupingPass,
  versionGroupingJob,
  versionLabel,
  withVersionChanges,
} from "../uploads/versionGrouping.js";

const MAX_BATCH = 500;
const NEARBY_SECONDS = 120;
const NEARBY_LIMIT = 24;
const CANDIDATE_LIMIT = 60;
const SEARCH_MAX = 200;
const LABEL_MAX = 80;
const FOLDER_NAME_MAX = 60;
const FOLDER_NAMES_MAX = 50;

const Role = Nullable(Type.Enum(["original", "edit", "export"]));
const Evidence = Nullable(Type.Enum(["document_id", "time_serial_suffix", "suggested", "manual", "version_folder"]));
const LabelKind = Type.Enum(["original", "edit", "export", "print", "bw", "pano", "enhanced", "hdr"], {
  description: "What the version is, from its file name, folder and role, when the user hasn't named it",
});

const Version = Type.Object({
  captureId: Uuid(),
  photoId: Nullable(Uuid({ description: "This version's own photo, wherever it's shown" })),
  width: Nullable(Type.Integer()),
  height: Nullable(Type.Integer()),
  label: Nullable(Type.String({ description: "The name the user gave this version" })),
  labelKind: LabelKind,
  labelSize: Nullable(Type.String({ description: "A print size from the file name, such as 8x10" })),
  fileName: Type.String(),
  isGroup: Type.Boolean(),
  shown: Type.Boolean(),
});

const VersionFile = Type.Object({
  originalId: Uuid(),
  captureId: Uuid(),
  photoId: Nullable(Uuid({ description: "The capture's own photo, wherever it's shown" })),
  role: Role,
  kind: Type.String(),
  fileName: Type.String(),
  format: Type.String({ description: "The file's extension, upper case" }),
  ref: Type.String(),
  managed: Type.Boolean(),
  fileSize: Type.Number(),
  width: Nullable(Type.Integer()),
  height: Nullable(Type.Integer()),
  isGroup: Type.Boolean({ description: "This file's capture is the one the group is shown as" }),
  shown: Type.Boolean({ description: "This file's capture provides the photo shown" }),
  evidence: Evidence,
});

const LinkCandidate = Type.Object({
  captureId: Uuid(),
  photoId: Nullable(Uuid()),
  takenAt: Nullable(Type.String()),
  fileName: Nullable(Type.String()),
  speciesName: Nullable(Type.String()),
});

const VersionGroup = Type.Object({
  groupCaptureId: Uuid(),
  files: Type.Array(VersionFile, { description: "The shown photo's files first" }),
  versions: Type.Array(Version, {
    description: "One per photo of the group, the original first, in a steady order for a switcher",
  }),
  nearby: Type.Array(LinkCandidate, {
    description: "Photos taken within two minutes, to link to; /versions/candidates searches the rest",
  }),
});

const VersionSuggestion = Type.Object({
  captureId: Uuid(),
  groupCaptureId: Uuid(),
  photoId: Nullable(Uuid()),
  groupPhotoId: Nullable(Uuid()),
  fileName: Nullable(Type.String()),
  groupFileName: Nullable(Type.String()),
  takenAt: Nullable(Type.String()),
});

const CaptureIdsBody = Type.Object(
  { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_BATCH }) },
  { additionalProperties: false },
);

/** The group a capture belongs to: its own id, or its group's when it's a linked version. */
async function groupOf(userId: string, captureId: string): Promise<string | null> {
  const res = await pool.query<{ head: string }>(
    `SELECT COALESCE(cv.group_capture_id, c.id) AS head FROM captures_all c
     LEFT JOIN capture_versions cv ON cv.capture_id = c.id AND cv.state = 'linked'
     WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
    [captureId, userId],
  );
  return res.rows[0]?.head ?? null;
}

/** What the link picker shows of `ids`, in their order. Leaves out `groupId` itself, photos with
 *  versions of their own (linkVersionTx refuses nesting) and anything that isn't a still photo. */
async function describeCandidates(userId: string, groupId: string, ids: string[]) {
  const res = await pool.query<{
    id: string;
    current_photo_id: string | null;
    taken_at: Date | null;
    species: string | null;
    ref: string | null;
  }>(
    `SELECT c.id, c.current_photo_id, c.taken_at, COALESCE(s.common_name, s.scientific_name) AS species,
            (SELECT o.ref FROM originals o WHERE o.capture_id = c.id ORDER BY o.kind = 'raw' LIMIT 1) AS ref
     FROM captures c
     JOIN photos p ON p.id = c.current_photo_id AND COALESCE(p.kind, 'image') = 'image'
     LEFT JOIN species s ON s.id = c.species_id
     WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2 AND c.id <> $3
       AND NOT EXISTS (SELECT 1 FROM capture_versions v WHERE v.group_capture_id = c.id AND v.state = 'linked')
     ORDER BY array_position($1::uuid[], c.id)`,
    [ids, userId, groupId],
  );
  return res.rows.map((r) => ({
    captureId: r.id,
    photoId: r.current_photo_id,
    takenAt: r.taken_at?.toISOString() ?? null,
    fileName: r.ref ? path.basename(r.ref.replace(/\\/g, "/")) : null,
    speciesName: r.species,
  }));
}

export async function captureVersionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/captures/:id/versions",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Capture not found"),
      schema: { params: IdParams, response: replies(VersionGroup) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const groupId = await groupOf(userId, request.params.id);
      if (!groupId) return reply.code(404).send({ error: "Capture not found" });
      const rows = await pool.query<{
        original_id: string;
        capture_id: string;
        current_photo_id: string | null;
        role: "original" | "edit" | "export" | null;
        kind: string;
        ref: string;
        managed: boolean;
        file_size: string;
        evidence: "document_id" | "time_serial_suffix" | "suggested" | "manual" | null;
        displayed: boolean;
        is_group: boolean;
      }>(
        `SELECT o.id AS original_id, m.capture_id, c.current_photo_id, o.role, o.kind, o.ref, o.managed,
                o.file_size, cv.evidence, COALESCE(cv.displayed, false) AS displayed, m.capture_id = $1 AS is_group
         FROM (SELECT $1::uuid AS capture_id
               UNION SELECT capture_id FROM capture_versions WHERE group_capture_id = $1 AND state = 'linked') m
         JOIN captures_all c ON c.id = m.capture_id
         JOIN originals o ON o.capture_id = m.capture_id
         LEFT JOIN capture_versions cv ON cv.capture_id = m.capture_id AND cv.state = 'linked'
         ORDER BY CASE o.role WHEN 'original' THEN 0 WHEN 'edit' THEN 1 ELSE 2 END, o.ref`,
        [groupId],
      );
      // A shown version's photo row sits on the group's capture and the other way round.
      const shownVersion = rows.rows.find((r) => r.displayed)?.capture_id ?? null;
      const groupPhoto = rows.rows.find((r) => r.is_group)?.current_photo_id ?? null;
      const shownPhoto = rows.rows.find((r) => r.displayed)?.current_photo_id ?? null;
      const ownPhoto = (r: (typeof rows.rows)[number]) =>
        r.is_group && shownVersion ? shownPhoto : r.displayed ? groupPhoto : r.current_photo_id;
      const photoIds = [...new Set(rows.rows.map(ownPhoto).filter((id): id is string => id != null))];
      const sizes = new Map(
        (
          await pool.query<{ id: string; width: number | null; height: number | null }>(
            `SELECT id, width, height FROM photos WHERE id = ANY($1::uuid[])`,
            [photoIds],
          )
        ).rows.map((p) => [p.id, p]),
      );
      const shownCapture = shownVersion ?? groupId;
      const mapped = rows.rows.map((r) => {
        const photoId = ownPhoto(r);
        const size = photoId ? sizes.get(photoId) : undefined;
        return {
          originalId: r.original_id,
          captureId: r.capture_id,
          photoId,
          role: r.role,
          kind: r.kind,
          fileName: path.basename(r.ref.replace(/\\/g, "/")),
          format: path.extname(r.ref).slice(1).toUpperCase(),
          ref: r.ref,
          managed: r.managed,
          fileSize: Number(r.file_size),
          width: size?.width ?? null,
          height: size?.height ?? null,
          isGroup: r.is_group,
          shown: r.capture_id === shownCapture,
          evidence: r.is_group ? null : r.evidence,
        };
      });
      // The finished photo is always pinned first, however many exports there are.
      const files = [...mapped].sort((a, b) => Number(b.shown) - Number(a.shown));

      const labels = new Map(
        (
          await pool.query<{ capture_id: string; label: string }>(
            `SELECT capture_id, label FROM capture_version_labels WHERE capture_id = ANY($1::uuid[])`,
            [[...new Set(mapped.map((f) => f.captureId))]],
          )
        ).rows.map((r) => [r.capture_id, r.label]),
      );
      // One per capture, named after its displayable file (the JPEG beside a RAW); the group first.
      const versions = new Map<string, (typeof mapped)[number]>();
      for (const f of [...mapped].sort((a, b) => Number(b.isGroup) - Number(a.isGroup))) {
        const seen = versions.get(f.captureId);
        if (!seen || (seen.kind === "raw" && f.kind !== "raw")) versions.set(f.captureId, f);
      }

      const nearby = await pool.query<{ id: string }>(
        `SELECT c.id FROM captures c, captures_all g
         WHERE g.id = $1 AND c.user_id = $2 AND c.id <> g.id AND g.taken_at IS NOT NULL
           AND c.taken_at BETWEEN g.taken_at - make_interval(secs => $3) AND g.taken_at + make_interval(secs => $3)
           AND NOT EXISTS (SELECT 1 FROM capture_versions v WHERE v.group_capture_id = c.id AND v.state = 'linked')
         ORDER BY abs(extract(epoch FROM c.taken_at - g.taken_at)), c.id
         LIMIT $4`,
        [groupId, userId, NEARBY_SECONDS, NEARBY_LIMIT],
      );
      return {
        groupCaptureId: groupId,
        files,
        versions: [...versions.values()].map((f) => {
          const auto = versionLabel(f.ref, f.role);
          return {
            captureId: f.captureId,
            photoId: f.photoId,
            width: f.width,
            height: f.height,
            label: labels.get(f.captureId) ?? null,
            labelKind: auto.kind,
            labelSize: auto.size,
            fileName: f.fileName,
            isGroup: f.isGroup,
            shown: f.shown,
          };
        }),
        nearby: await describeCandidates(
          userId,
          groupId,
          nearby.rows.map((r) => r.id),
        ),
      };
    },
  );

  // The link picker's search: any photo whose file name matches, then what the Gallery's search
  // finds (species, places, months and years). The time window only shapes the unsearched list.
  app.get(
    "/captures/:id/versions/candidates",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: SEARCH_MAX }) }),
        response: replies(Type.Object({ items: Type.Array(LinkCandidate) })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const groupId = await groupOf(userId, request.params.id);
      if (!groupId) return reply.code(404).send({ error: "Capture not found" });
      const q = request.query.q.trim();
      if (!q) return { items: [] };
      const byName = await pool.query<{ capture_id: string }>(
        `SELECT o.capture_id FROM originals o JOIN captures c ON c.id = o.capture_id
         WHERE o.user_id = $1 AND regexp_replace(o.ref, '^.*[/\\\\]', '') ILIKE $2 ESCAPE '\\'
         GROUP BY o.capture_id ORDER BY max(c.taken_at) DESC NULLS LAST LIMIT $3`,
        [userId, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, CANDIDATE_LIMIT],
      );
      const filters = await galleryFiltersFor({ excludeVideo: "1" }, userId);
      const found = "error" in filters ? null : await searchGallery(userId, q, filters, { quick: true });
      const ids = [
        ...new Set([...byName.rows.map((r) => r.capture_id), ...(found?.items ?? []).map((i) => i.row.capture_id)]),
      ];
      // Over-fetched, since a group or this photo itself drops out.
      const items = await describeCandidates(userId, groupId, ids.slice(0, CANDIDATE_LIMIT * 2));
      return { items: items.slice(0, CANDIDATE_LIMIT) };
    },
  );

  // "Use this as the photo": shows one member's file as the group's photo.
  app.post(
    "/captures/:id/versions/show",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        body: Type.Object({ captureId: Uuid() }, { additionalProperties: false }),
        response: replies(Type.Object({ shownCaptureId: Uuid({ description: "Shown before, for an undo" }) })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const groupId = await groupOf(userId, request.params.id);
      if (!groupId) return reply.code(404).send({ error: "Capture not found" });
      const target = request.body.captureId;
      const member = await pool.query(
        `SELECT 1 FROM capture_versions WHERE capture_id = $1 AND group_capture_id = $2 AND state = 'linked'`,
        [target, groupId],
      );
      if (target !== groupId && !member.rowCount) return reply.code(404).send({ error: "Version not found" });
      const before = await pool.query<{ capture_id: string }>(
        `SELECT capture_id FROM capture_versions WHERE group_capture_id = $1 AND state = 'linked' AND displayed`,
        [groupId],
      );
      await withVersionChanges(userId, (client, after) =>
        showVersionTx(client, groupId, target === groupId ? null : target, after.recrop),
      );
      return { shownCaptureId: before.rows[0]?.capture_id ?? groupId };
    },
  );

  // "Split out": the file goes back to being a photo of its own. Undo: link it again.
  app.post(
    "/captures/:id/versions/split",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Version not found"),
      schema: { params: IdParams, response: replies(Type.Object({ groupCaptureId: Uuid() })) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const groupId = await withVersionChanges(userId, (client, after) =>
        splitVersionTx(client, userId, request.params.id, after),
      );
      if (!groupId) return reply.code(404).send({ error: "Version not found" });
      return { groupCaptureId: groupId };
    },
  );

  // "Link to": files this photo as a version of another. Undo: split it out.
  app.post(
    "/captures/:id/versions/link",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        body: Type.Object({ groupCaptureId: Uuid() }, { additionalProperties: false }),
        response: replies(Type.Object({ groupCaptureId: Uuid() })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const groupId = await groupOf(userId, request.body.groupCaptureId);
      if (!groupId) return reply.code(404).send({ error: "Capture not found" });
      const linked = await withVersionChanges(userId, (client, after) =>
        linkVersionTx(client, userId, request.params.id, groupId, "manual", after),
      );
      if (!linked) {
        return reply.code(409).send({
          error: "This photo can't be linked there. A photo with versions of its own has to split them out first.",
          code: "version_link_refused",
        });
      }
      return { groupCaptureId: groupId };
    },
  );

  // Renames one version ("Print 8x10"); null goes back to the name worked out from the file.
  app.put(
    "/captures/:id/versions/label",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Version not found"),
      schema: {
        params: IdParams,
        body: Type.Object({ label: Nullable(Type.String({ maxLength: LABEL_MAX })) }, { additionalProperties: false }),
        response: replies(Type.Object({ label: Nullable(Type.String()) })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const own = await pool.query(`SELECT 1 FROM captures_all WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [
        request.params.id,
        userId,
      ]);
      if (!own.rowCount) return reply.code(404).send({ error: "Version not found" });
      const label = request.body.label?.trim() || null;
      if (label) {
        await pool.query(
          `INSERT INTO capture_version_labels (capture_id, user_id, label) VALUES ($1, $2, $3)
           ON CONFLICT (capture_id) DO UPDATE SET label = EXCLUDED.label`,
          [request.params.id, userId, label],
        );
      } else {
        await pool.query(`DELETE FROM capture_version_labels WHERE capture_id = $1`, [request.params.id]);
      }
      return { label };
    },
  );

  // How many photos each group holds (itself included), for the stack badge on photo grids.
  // Only groups are listed, so a library of single photos answers with almost nothing.
  app.get(
    "/captures/version-counts",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            counts: Type.Record(Type.String(), Type.Integer(), { description: "Group capture id to version count" }),
          }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{ group_capture_id: string; n: number }>(
        `SELECT group_capture_id, count(*)::int + 1 AS n FROM capture_versions
         WHERE user_id = $1 AND state = 'linked' GROUP BY group_capture_id`,
        [request.user!.id],
      );
      return { counts: Object.fromEntries(res.rows.map((r) => [r.group_capture_id, r.n])) };
    },
  );

  // What the background pass grouped since a moment, for the notice after an import.
  app.get(
    "/captures/version-summary",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          since: Type.Optional(
            Type.String({ maxLength: 40, description: "Only groupings after this moment (ISO 8601)" }),
          ),
        }),
        response: replies(
          Type.Object({
            versions: Type.Integer({ description: "Files grouped behind another photo" }),
            photos: Type.Integer({ description: "Photos they were grouped under" }),
            latest: Nullable(Type.String({ description: "When the newest of them was grouped" })),
          }),
        ),
      },
    },
    async (request, reply) => {
      const since = request.query.since ?? null;
      if (since && Number.isNaN(Date.parse(since))) return reply.code(400).send({ error: "since must be a date" });
      const res = await pool.query<{ versions: number; photos: number; latest: Date | null }>(
        `SELECT count(*)::int AS versions, count(DISTINCT group_capture_id)::int AS photos, date_trunc('milliseconds', max(created_at)) AS latest
         FROM capture_versions
         WHERE user_id = $1 AND state = 'linked' AND evidence <> 'manual'
           AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', created_at) > $2::timestamptz)`,
        [request.user!.id, since],
      );
      const row = res.rows[0];
      return { versions: row?.versions ?? 0, photos: row?.photos ?? 0, latest: row?.latest?.toISOString() ?? null };
    },
  );

  // The folder names whose files are versions of the original beside them (Settings).
  const FolderNames = Type.Object({
    names: Type.Array(Type.String({ minLength: 1, maxLength: FOLDER_NAME_MAX }), { maxItems: FOLDER_NAMES_MAX }),
    defaults: Type.Array(Type.String()),
  });
  app.get(
    "/captures/versions/folders",
    { preValidation: requireAuth, schema: { response: replies(FolderNames) } },
    async (request) => {
      const res = await pool.query<{ names: string[] | null }>(
        `SELECT version_folder_names AS names FROM users WHERE id = $1`,
        [request.user!.id],
      );
      return { names: res.rows[0]?.names ?? DEFAULT_VERSION_FOLDERS, defaults: DEFAULT_VERSION_FOLDERS };
    },
  );
  app.put(
    "/captures/versions/folders",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            names: Nullable(
              Type.Array(Type.String({ maxLength: FOLDER_NAME_MAX }), {
                maxItems: FOLDER_NAMES_MAX,
                description: "Null goes back to the default list",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(FolderNames),
      },
    },
    async (request) => {
      // Trimmed, blank and repeated names (in any case) dropped, order kept.
      const seen = new Set<string>();
      const names = request.body.names?.flatMap((n) => {
        const name = n.trim().replace(/[\\/]/g, "");
        if (!name || seen.has(name.toLowerCase())) return [];
        seen.add(name.toLowerCase());
        return [name];
      });
      await pool.query(`UPDATE users SET version_folder_names = $1 WHERE id = $2`, [names ?? null, request.user!.id]);
      return { names: names ?? DEFAULT_VERSION_FOLDERS, defaults: DEFAULT_VERSION_FOLDERS };
    },
  );

  // "Look for versions in this folder": groups the folder's undecided photos again in the
  // background, with the rules and folder names as they are now.
  const ScanStatus = Type.Object(jobStatusFields(Type.Object({ linked: Type.Integer(), suggested: Type.Integer() })));
  app.get(
    "/captures/versions/scan",
    { preValidation: requireAuth, schema: { response: replies(ScanStatus) } },
    async () => versionGroupingJob.status,
  );
  app.post(
    "/captures/versions/scan",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ folder: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
        response: replies(Type.Object({ started: Type.Boolean() }), 202),
      },
    },
    async (request, reply) => {
      if (!startVersionGroupingPass({ userId: request.user!.id, folder: request.body.folder })) {
        return reply.code(409).send({ error: "Lifer is already looking for versions." });
      }
      return reply.code(202).send({ started: true });
    },
  );

  app.post(
    "/captures/versions/scan/cancel",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) } },
    async () => ({ cancelled: versionGroupingJob.cancel() }),
  );

  // Suggested groups (same shutter press, different names) for the review after an import.
  app.get(
    "/captures/version-suggestions",
    {
      preValidation: requireAuth,
      schema: { response: replies(Type.Object({ suggestions: Type.Array(VersionSuggestion) })) },
    },
    async (request) => {
      const res = await pool.query<{
        capture_id: string;
        group_capture_id: string;
        photo_id: string | null;
        group_photo_id: string | null;
        file_ref: string | null;
        group_ref: string | null;
        taken_at: Date | null;
      }>(
        `SELECT cv.capture_id, cv.group_capture_id, v.current_photo_id AS photo_id, g.current_photo_id AS group_photo_id,
                (SELECT ref FROM originals WHERE capture_id = v.id ORDER BY kind = 'raw' LIMIT 1) AS file_ref,
                (SELECT ref FROM originals WHERE capture_id = g.id ORDER BY kind = 'raw' LIMIT 1) AS group_ref,
                g.taken_at
         FROM capture_versions cv
         JOIN captures v ON v.id = cv.capture_id
         JOIN captures g ON g.id = cv.group_capture_id
         WHERE cv.user_id = $1 AND cv.state = 'suggested'
         ORDER BY g.taken_at DESC NULLS LAST, cv.capture_id
         LIMIT ${MAX_BATCH}`,
        [request.user!.id],
      );
      const name = (ref: string | null) => (ref ? path.basename(ref.replace(/\\/g, "/")) : null);
      return {
        suggestions: res.rows.map((r) => ({
          captureId: r.capture_id,
          groupCaptureId: r.group_capture_id,
          photoId: r.photo_id,
          groupPhotoId: r.group_photo_id,
          fileName: name(r.file_ref),
          groupFileName: name(r.group_ref),
          takenAt: r.taken_at?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post(
    "/captures/version-suggestions/accept",
    {
      preValidation: requireAuth,
      schema: { body: CaptureIdsBody, response: replies(Type.Object({ linked: Type.Array(Uuid()) })) },
    },
    async (request) => {
      const userId = request.user!.id;
      const linked = await withVersionChanges(userId, async (client, after) => {
        const rows = await client.query<{ capture_id: string; group_capture_id: string }>(
          `SELECT capture_id, group_capture_id FROM capture_versions
           WHERE user_id = $1 AND state = 'suggested' AND capture_id = ANY($2::uuid[])`,
          [userId, request.body.captureIds],
        );
        const done: string[] = [];
        for (const r of rows.rows) {
          if (await linkVersionTx(client, userId, r.capture_id, r.group_capture_id, "suggested", after)) {
            done.push(r.capture_id);
          }
        }
        return done;
      });
      return { linked };
    },
  );

  app.post(
    "/captures/version-suggestions/dismiss",
    {
      preValidation: requireAuth,
      schema: { body: CaptureIdsBody, response: replies(Type.Object({ dismissed: Type.Integer() })) },
    },
    async (request) => {
      const res = await pool.query(
        `UPDATE capture_versions SET state = 'dismissed', decided_at = now()
         WHERE user_id = $1 AND state = 'suggested' AND capture_id = ANY($2::uuid[])`,
        [request.user!.id, request.body.captureIds],
      );
      return { dismissed: res.rowCount ?? 0 };
    },
  );

  // Undo of a dismissal: the suggestion comes back.
  app.post(
    "/captures/version-suggestions/restore",
    {
      preValidation: requireAuth,
      schema: { body: CaptureIdsBody, response: replies(Type.Object({ restored: Type.Integer() })) },
    },
    async (request) => {
      const res = await pool.query(
        `UPDATE capture_versions SET state = 'suggested', decided_at = NULL
         WHERE user_id = $1 AND state = 'dismissed' AND evidence IN ('suggested', 'version_folder')
           AND capture_id = ANY($2::uuid[])`,
        [request.user!.id, request.body.captureIds],
      );
      return { restored: res.rowCount ?? 0 };
    },
  );
}
