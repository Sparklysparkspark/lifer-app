// Settings for what Lifer writes into photo files and how it names them: the copyright and caption
// template, the file name template, and which species' locations stay private when sharing.
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import {
  FILE_NAME_VARIABLES,
  TEMPLATE_VARIABLES,
  keepsOriginalName,
  unknownTemplateVariables,
  type MetadataTemplate,
  type TemplateValues,
} from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { requireAuth } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { Flag, IdParams, Ok, Open, jobStatusFields, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { creditsNeedWriting } from "../uploads/exif.js";
import { captureCredits, syncCaptureXmpSidecars } from "../uploads/xmpSidecarSync.js";
import { captureFacts, renderFileStem, templateValues } from "../uploads/templateVars.js";
import {
  getFileNameTemplate,
  getMetadataTemplate,
  getSensitiveSettings,
  isDefaultSensitive,
  listSensitiveSpecies,
  setFileNameTemplate,
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
}
const APPLY_IDLE: ApplyCounts = { updated: 0, unchanged: 0, failed: 0 };
const ApplyStatus = Open({
  ...jobStatusFields(Type.Unknown()),
  updated: Type.Integer(),
  unchanged: Type.Integer(),
  failed: Type.Integer(),
});

export const applyMetadataJob = createJob<ApplyCounts, ApplyCounts>("apply-metadata-template", APPLY_IDLE);
let applyJobUserId: string | null = null;

/** Writes the user's copyright and caption into every managed photo file whose values differ.
 *  Files already up to date are only read, so a rerun after a stop picks up where it left off. */
export async function runApplyMetadata(
  ctx: JobContext<ApplyCounts, ApplyCounts>,
  userId: string,
  counts: ApplyCounts,
): Promise<ApplyCounts> {
  const template = await getMetadataTemplate(userId);
  const res = await pool.query<{ capture_id: string; refs: string[] }>(
    `SELECT o.capture_id, array_agg(o.ref) AS refs
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
          const credits = await captureCredits(userId, row.capture_id, template);
          let differs = false;
          for (const ref of row.refs) if (credits && (await creditsNeedWriting(ref, credits))) differs = true;
          if (differs) {
            await syncCaptureXmpSidecars(userId, row.capture_id);
            counts.updated++;
          } else counts.unchanged++;
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
};

/** One of the user's recent photos with the most values filled, or the sample. */
async function exampleValues(userId: string): Promise<{ values: TemplateValues; sample: boolean }> {
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
  if (!row || !facts) return { values: SAMPLE_VALUES, sample: true };
  const original = row.ref ? path.basename(row.ref, path.extname(row.ref)) : null;
  return { values: { ...(await templateValues({ ...facts, original })), seq: "0001" }, sample: false };
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
        querystring: Type.Object({ background: Flag("1 to start the job and return at once, for polling") }),
        response: replies(
          Open({
            started: Type.Optional(Type.Boolean()),
            updated: Type.Optional(Type.Integer()),
            unchanged: Type.Optional(Type.Integer()),
            failed: Type.Optional(Type.Integer()),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (
        !applyMetadataJob.start((ctx) => runApplyMetadata(ctx, userId, applyMetadataJob.status), { phase: "preparing" })
      )
        return reply.code(409).send({ error: "Photo details are already being written" });
      applyJobUserId = userId;
      if (request.query.background === "1") return { started: true };
      await applyMetadataJob.settled();
      const status = applyMetadataJob.status;
      if (status.error) return reply.code(500).send({ error: status.error });
      const { updated, unchanged, failed } = status;
      return { updated, unchanged, failed };
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
