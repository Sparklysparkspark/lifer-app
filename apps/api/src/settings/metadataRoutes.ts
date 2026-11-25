// Settings for what Lifer writes into photo files and how it names them: the copyright and caption
// template, the file name template, and which species' locations stay private when sharing.
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import {
  CAPTION_PRESETS,
  FILE_NAME_VARIABLES,
  TEMPLATE_VARIABLES,
  WRITE_RULES,
  keepsOriginalName,
  renderFields,
  renderTemplate,
  unknownTemplateVariables,
  type MetadataFields,
  type MetadataTemplate,
  type TemplateValues,
} from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { requireAuth } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import {
  Flag,
  IdParams,
  Ok,
  Open,
  Uuid,
  jobStatusFields,
  notFoundOnInvalidId,
  replies,
  withSchemas,
} from "../lib/schema.js";
import { templatedWritePlan, writeCaptureMetadata } from "../uploads/exif.js";
import { captureWriteData } from "../uploads/xmpSidecarSync.js";
import { getFileWriteSettings } from "./fileWriteSettings.js";
import { captureFacts, renderFileStem, templateValues } from "../uploads/templateVars.js";
import {
  getFileNameTemplate,
  getMetadataFields,
  getMetadataTemplate,
  getSensitiveSettings,
  isDefaultSensitive,
  listSensitiveSpecies,
  setFileNameTemplate,
  setMetadataFields,
  setMetadataTemplate,
  setSensitiveSettings,
} from "./metadataSettings.js";

const Field = (maxLength: number) => Type.String({ maxLength });
const MetadataTemplateSchema = Type.Object(
  {
    creator: Field(500),
    copyright: Field(500),
    credit: Field(500),
    usageTerms: Field(2000),
    caption: Field(2000),
    replaceExisting: Type.Boolean(),
  },
  { additionalProperties: false },
);

const MetadataSettings = Type.Object({
  template: MetadataTemplateSchema,
  fileNameTemplate: Type.String(),
  sensitiveSpecies: Type.Object({ enabled: Type.Boolean() }),
});

const FieldTemplateSchema = Type.Object(
  { template: Field(2000), rule: Type.Enum([...WRITE_RULES]) },
  { additionalProperties: false },
);
const MetadataFieldsSchema = Type.Object(
  {
    title: FieldTemplateSchema,
    headline: FieldTemplateSchema,
    caption: FieldTemplateSchema,
    keywords: FieldTemplateSchema,
    multiSpecies: Type.Enum(["all", "main"]),
  },
  {
    additionalProperties: false,
    description:
      "Templates for Title, Headline, Caption and extra Keywords (comma separated), each with its write rule: fillEmpty, replace (what Lifer wrote), append, or off",
  },
);

const TemplateValuesSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));

const SensitiveSpeciesList = Type.Object({
  species: Type.Array(
    Type.Object({
      id: Type.String(),
      commonName: Type.Union([Type.String(), Type.Null()]),
      scientificName: Type.String(),
      iucnStatus: Type.Union([Type.String(), Type.Null()]),
      reason: Type.Enum(["iucn", "ebird", "added"]),
      removed: Type.Boolean(),
      areas: Type.Array(Type.String(), {
        description:
          "For a species eBird lists only in some areas, those areas as eBird names them; empty when it is sensitive everywhere",
      }),
    }),
  ),
});

interface ApplyCounts {
  updated: number;
  unchanged: number;
  failed: number;
  /** Photos with a field left as it is because someone edited it after Lifer wrote it. */
  edited: number;
  /** Counted only: nothing was written. */
  dryRun: boolean;
}
const APPLY_IDLE: ApplyCounts = { updated: 0, unchanged: 0, failed: 0, edited: 0, dryRun: false };
const ApplyStatus = Open({
  ...jobStatusFields(Type.Unknown()),
  updated: Type.Integer(),
  unchanged: Type.Integer(),
  failed: Type.Integer(),
  edited: Type.Integer(),
  dryRun: Type.Boolean(),
});

export const applyMetadataJob = createJob<ApplyCounts, ApplyCounts>("apply-metadata-template", APPLY_IDLE);
let applyJobUserId: string | null = null;

/** Writes the user's templates into every managed photo file whose values differ, by each field's
 *  rule, never over a value someone else edited. Files already up to date are only read, so a rerun
 *  after a stop picks up where it left off. A dry run counts without writing. */
export async function runApplyMetadata(
  ctx: JobContext<ApplyCounts, ApplyCounts>,
  userId: string,
  counts: ApplyCounts,
): Promise<ApplyCounts> {
  const saved = { template: await getMetadataTemplate(userId), fields: await getMetadataFields(userId) };
  const fileSettings = await getFileWriteSettings(userId);
  const res = await pool.query<{ capture_id: string }>(
    `SELECT o.capture_id
       FROM originals o JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
      WHERE o.user_id = $1 AND o.managed = true
      GROUP BY o.capture_id ORDER BY o.capture_id`,
    [userId],
  );
  ctx.update({ phase: "writing", total: res.rows.length, processed: 0 });
  const limit = createLimiter(4);
  let processed = 0;
  await Promise.all(
    res.rows.map((row) =>
      limit(async () => {
        if (ctx.signal.aborted) return;
        try {
          const write = await captureWriteData(userId, row.capture_id, {}, saved);
          const files = write?.originals ?? [];
          let differs = false;
          let edited = false;
          for (const o of files) {
            const plan = await templatedWritePlan(o.ref, { ...write!.data, originalId: o.id }, fileSettings);
            differs ||= plan.changes;
            edited ||= plan.edited.length > 0;
          }
          if (differs && !counts.dryRun)
            for (const o of files)
              await writeCaptureMetadata(o.ref, { ...write!.data, originalId: o.id }, fileSettings);
          if (differs) counts.updated++;
          else counts.unchanged++;
          if (edited) counts.edited++;
        } catch {
          counts.failed++;
        }
        ctx.update({ processed: ++processed });
      }),
    ),
  );
  return { ...counts };
}

// A sample photo's values for the preview before there are any photos.
const SAMPLE_VALUES: TemplateValues = {
  species: "Osprey",
  scientific: "Pandion haliaetus",
  group: "Birds",
  place: "Pigeon Lake",
  region: "Alberta",
  country: "Canada",
  date: "2026-05-03",
  year: "2026",
  month: "05",
  trip: "Alberta 2026",
  camera: "Canon EOS R5",
  lens: "RF100-500mm F4.5-7.1 L IS USM",
  rating: "4",
  original: "IMG_4411",
  seq: "0012",
  genus: "Pandion",
  family: "Pandionidae",
  order: "Accipitriformes",
  class: "Aves",
  focal: "500mm",
  aperture: "f/7.1",
  shutter: "1/2000s",
  iso: "800",
  longdate: "3 May 2026",
  names: "Osprey",
  count: "1",
};

/** One of the user's recent photos with the most values filled, or the sample. */
async function exampleValues(
  userId: string,
  multiSpecies?: "all" | "main",
): Promise<{ values: TemplateValues; sample: boolean; captureId: string | null }> {
  const res = await pool.query<{ id: string; ref: string | null }>(
    `SELECT c.id, (SELECT o.ref FROM originals o WHERE o.capture_id = c.id AND o.kind <> 'raw' LIMIT 1) AS ref
       FROM (SELECT * FROM captures WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50) c
      ORDER BY (c.location_label IS NOT NULL)::int + (c.region_id IS NOT NULL)::int + (c.trip_id IS NOT NULL)::int
             + (c.taken_at IS NOT NULL)::int + (c.camera_model IS NOT NULL)::int DESC, c.created_at DESC
      LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  const facts = row ? await captureFacts(row.id) : null;
  if (!row || !facts) return { values: SAMPLE_VALUES, sample: true, captureId: null };
  const original = row.ref ? path.basename(row.ref, path.extname(row.ref)) : null;
  const values = await templateValues({ ...facts, original }, { multiSpecies });
  return { values: { ...values, seq: "0001" }, sample: false, captureId: row.id };
}

/** One photo's template values, for a capture the user owns; null when it isn't theirs. */
async function captureValues(
  userId: string,
  captureId: string,
  multiSpecies: "all" | "main",
): Promise<TemplateValues | null> {
  const res = await pool.query<{ ref: string | null }>(
    `SELECT (SELECT o.ref FROM originals o WHERE o.capture_id = c.id AND o.kind <> 'raw' LIMIT 1) AS ref
       FROM captures c WHERE c.id = $1 AND c.user_id = $2`,
    [captureId, userId],
  );
  if (res.rows.length === 0) return null;
  const facts = await captureFacts(captureId);
  if (!facts) return null;
  const ref = res.rows[0].ref;
  const original = ref ? path.basename(ref, path.extname(ref)) : null;
  return templateValues({ ...facts, original }, { multiSpecies });
}

const FieldsPreview = Type.Object({
  sample: Type.Boolean({ description: "True when the user has no photos and a made-up one is shown" }),
  captureId: Type.Union([Type.String(), Type.Null()]),
  values: TemplateValuesSchema,
  fields: Type.Object({
    title: Type.String(),
    headline: Type.String(),
    caption: Type.String(),
    keywords: Type.Array(Type.String()),
    creator: Type.String(),
    copyright: Type.String(),
    credit: Type.String(),
    usageTerms: Type.String(),
  }),
});

function validateFields(body: MetadataFields): string | null {
  const unknown = [body.title, body.headline, body.caption, body.keywords].flatMap((f) =>
    unknownTemplateVariables(f.template, TEMPLATE_VARIABLES),
  );
  return unknown.length > 0 ? `Unknown variable {${unknown[0]}}` : null;
}

export async function metadataSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/settings/metadata",
    { preValidation: requireAuth, schema: { response: replies(MetadataSettings) } },
    async (request) => {
      const userId = request.user!.id;
      return {
        template: await getMetadataTemplate(userId),
        fileNameTemplate: await getFileNameTemplate(userId),
        sensitiveSpecies: { enabled: (await getSensitiveSettings(userId)).enabled },
      };
    },
  );

  // Applies to photos imported or changed from now on; "Apply to existing photos" does the rest.
  app.put(
    "/settings/metadata-template",
    {
      preValidation: requireAuth,
      schema: { body: MetadataTemplateSchema, response: replies(Type.Object({ template: MetadataTemplateSchema })) },
    },
    async (request, reply) => {
      const body = request.body as MetadataTemplate;
      const unknown = [body.creator, body.copyright, body.credit, body.usageTerms, body.caption].flatMap((t) =>
        unknownTemplateVariables(t, TEMPLATE_VARIABLES),
      );
      if (unknown.length > 0) return reply.code(400).send({ error: `Unknown variable {${unknown[0]}}` });
      return { template: await setMetadataTemplate(request.user!.id, body) };
    },
  );

  // Names new imports; Reorganize renames files already in the library.
  app.put(
    "/settings/file-name-template",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ template: Type.String({ maxLength: 300 }) }, { additionalProperties: false }),
        response: replies(Type.Object({ fileNameTemplate: Type.String() })),
      },
    },
    async (request, reply) => {
      const { template } = request.body;
      const unknown = unknownTemplateVariables(template, FILE_NAME_VARIABLES);
      if (unknown.length > 0) return reply.code(400).send({ error: `Unknown variable {${unknown[0]}}` });
      if (!keepsOriginalName(template) && !/\{[a-z]+\}/.test(template))
        return reply.code(400).send({ error: "Use at least one variable, or every file gets the same name" });
      return { fileNameTemplate: await setFileNameTemplate(request.user!.id, template) };
    },
  );

  // The values of one of the user's photos, for Settings' live caption preview, and the name a
  // file name template would give it.
  app.get(
    "/settings/template-example",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ fileName: Type.Optional(Type.String({ maxLength: 300 })) }),
        response: replies(
          Type.Object({ values: TemplateValuesSchema, fileName: Type.String(), sample: Type.Boolean() }),
        ),
      },
    },
    async (request) => {
      const { values, sample } = await exampleValues(request.user!.id);
      const template = request.query.fileName ?? (await getFileNameTemplate(request.user!.id));
      const stem = renderFileStem(template, values) ?? values.original ?? "IMG_4411";
      return { values: values as Record<string, string | null>, fileName: `${stem}.jpg`, sample };
    },
  );

  // Title, Headline, Caption and extra Keywords templates with their write rules. The caption's
  // template is the same one /settings/metadata-template edits.
  app.get(
    "/settings/metadata-fields",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            fields: MetadataFieldsSchema,
            variables: Type.Array(Type.String()),
            captionPresets: Type.Record(Type.String(), Type.String()),
          }),
        ),
      },
    },
    async (request) => ({
      fields: await getMetadataFields(request.user!.id),
      variables: [...TEMPLATE_VARIABLES],
      captionPresets: { ...CAPTION_PRESETS },
    }),
  );

  // Applies to photos imported or changed from now on; "Apply to existing photos" does the rest.
  app.put(
    "/settings/metadata-fields",
    {
      preValidation: requireAuth,
      schema: { body: MetadataFieldsSchema, response: replies(Type.Object({ fields: MetadataFieldsSchema })) },
    },
    async (request, reply) => {
      const body = request.body as MetadataFields;
      const error = validateFields(body);
      if (error) return reply.code(400).send({ error });
      return { fields: await setMetadataFields(request.user!.id, body) };
    },
  );

  // Every field as it would be written for one photo: the given capture, else one of the user's
  // recent photos, else a sample. Values come too, so a draft template renders the same in the app.
  app.get(
    "/settings/metadata-preview",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          captureId: Type.Optional(Uuid()),
          multiSpecies: Type.Optional(Type.Enum(["all", "main"])),
        }),
        response: replies(FieldsPreview),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const fields = await getMetadataFields(userId);
      const multiSpecies = request.query.multiSpecies ?? fields.multiSpecies;
      let example: { values: TemplateValues; sample: boolean; captureId: string | null };
      if (request.query.captureId) {
        const values = await captureValues(userId, request.query.captureId, multiSpecies);
        if (!values) return reply.code(404).send({ error: "Photo not found" });
        example = { values, sample: false, captureId: request.query.captureId };
      } else example = await exampleValues(userId, multiSpecies);
      const t = await getMetadataTemplate(userId);
      const r = renderFields(fields, example.values);
      return {
        sample: example.sample,
        captureId: example.captureId,
        values: example.values as Record<string, string | null>,
        fields: {
          ...r,
          creator: renderTemplate(t.creator, example.values),
          copyright: renderTemplate(t.copyright, example.values),
          credit: renderTemplate(t.credit, example.values),
          usageTerms: renderTemplate(t.usageTerms, example.values),
        },
      };
    },
  );

  app.put(
    "/settings/sensitive-species",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Type.Object({ enabled: Type.Boolean() })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      await setSensitiveSettings(userId, { ...(await getSensitiveSettings(userId)), enabled: request.body.enabled });
      return { enabled: request.body.enabled };
    },
  );

  app.get(
    "/settings/sensitive-species/list",
    { preValidation: requireAuth, schema: { response: replies(SensitiveSpeciesList) } },
    async (request) => ({ species: await listSensitiveSpecies(request.user!.id) }),
  );

  // Marks one species sensitive (PUT) or ordinary (DELETE), overriding the default list.
  const markSchema = { params: IdParams, response: replies(Ok) };
  const speciesNotFound = notFoundOnInvalidId("Species not found");
  for (const [method, sensitive] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    app[method](
      "/settings/sensitive-species/:id",
      { preValidation: requireAuth, config: speciesNotFound, schema: markSchema },
      async (request, reply) => {
        const userId = request.user!.id;
        const id = request.params.id;
        const exists = await pool.query(`SELECT 1 FROM species WHERE id = $1`, [id]);
        if (exists.rowCount === 0) return reply.code(404).send({ error: "Species not found" });
        const s = await getSensitiveSettings(userId);
        // A default species restored is just un-removed, so it keeps its IUCN or eBird reason.
        const add = sensitive && !(await isDefaultSensitive(id));
        await setSensitiveSettings(userId, {
          enabled: s.enabled,
          added: add ? [...s.added, id] : s.added.filter((x) => x !== id),
          removed: sensitive ? s.removed.filter((x) => x !== id) : [...s.removed, id],
        });
        return { ok: true };
      },
    );
  }

  app.post(
    "/settings/metadata-template/apply",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          background: Flag("1 to start the job and return at once, for polling"),
          dryRun: Flag("1 to count what would change, and what stays as someone edited it, without writing"),
        }),
        response: replies(
          Open({
            started: Type.Optional(Type.Boolean()),
            updated: Type.Optional(Type.Integer()),
            unchanged: Type.Optional(Type.Integer()),
            failed: Type.Optional(Type.Integer()),
            edited: Type.Optional(Type.Integer()),
            dryRun: Type.Optional(Type.Boolean()),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const dryRun = request.query.dryRun === "1";
      if (
        !applyMetadataJob.start((ctx) => runApplyMetadata(ctx, userId, applyMetadataJob.status), {
          phase: "preparing",
          dryRun,
        })
      )
        return reply.code(409).send({ error: "Photo details are already being written" });
      applyJobUserId = userId;
      if (request.query.background === "1") return { started: true };
      await applyMetadataJob.settled();
      const status = applyMetadataJob.status;
      if (status.error) return reply.code(500).send({ error: status.error });
      const { updated, unchanged, failed, edited } = status;
      return { updated, unchanged, failed, edited, dryRun };
    },
  );

  app.get(
    "/settings/metadata-template/apply/status",
    { preValidation: requireAuth, schema: { response: replies(ApplyStatus) } },
    async (request) =>
      applyJobUserId == null || applyJobUserId === request.user!.id
        ? applyMetadataJob.status
        : { ...applyMetadataJob.status, ...APPLY_IDLE, currentItem: null },
  );

  app.post(
    "/settings/metadata-template/apply/cancel",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) } },
    async (request) => ({
      cancelled: (applyJobUserId == null || applyJobUserId === request.user!.id) && applyMetadataJob.cancel(),
    }),
  );
}
