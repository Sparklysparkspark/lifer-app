// Folder imports for connected apps (imports.write, desktop only): the same scan a library
// reimport runs, so marks, species keywords and duplicates behave exactly as in Lifer's own import.
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { ORIGINALS_DIR, SINGLE_USER_MODE } from "@lifer/core/config.js";
import { isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { isWithin } from "@lifer/core/lib/pathContainment.js";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { Nullable, replies, withSchemas } from "../lib/schema.js";
import { folderImportProgress, startFolderImport } from "../library/routes.js";
import { tagWithRegisteredVolume } from "../storageVolumes/resolve.js";

const Started = Type.Object({
  id: Type.String(),
  mode: Type.Union([Type.Literal("in-place"), Type.Literal("copy")]),
});
const Progress = Type.Object({
  running: Type.Boolean(),
  processed: Type.Integer(),
  total: Type.Integer(),
  imported: Type.Optional(Type.Integer()),
  alreadyHad: Type.Optional(Type.Integer()),
  skipped: Type.Optional(Type.Integer()),
  needReview: Type.Optional(Type.Integer()),
  error: Type.Optional(Nullable(Type.String())),
  cancelled: Type.Optional(Type.Boolean()),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: "The file's path: the folder as sent, joined with its place inside it" }),
        captureId: Type.String({ format: "uuid" }),
      }),
      {
        description:
          "Once the import has ended: each file Lifer filed or already had, with its photo. Skipped and failed files are left out.",
      },
    ),
  ),
});

const MAX_LOOKUP_NAMES = 500;
const SpeciesLookupBody = Type.Object(
  {
    scientificNames: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      minItems: 1,
      maxItems: MAX_LOOKUP_NAMES,
    }),
  },
  { additionalProperties: false },
);
const SpeciesLookupReply = Type.Object({
  matches: Type.Array(
    Type.Object({
      name: Type.String({ description: "The name as sent" }),
      speciesId: Type.String({ format: "uuid" }),
      scientificName: Type.String({ description: "The species' current scientific name" }),
      match: Type.Union([Type.Literal("exact"), Type.Literal("synonym")]),
    }),
  ),
  unmatched: Type.Array(Type.String(), { description: "Names with no match" }),
});

// The import job is one shared scan, so only the latest run's id has progress to show.
let currentRun = 0;
// The latest run's folder as the app sent it, so `files` paths read back in the app's own terms.
let currentFolder = "";

export async function folderImportRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/imports/v1/folders",
    {
      preValidation: requireScope("imports.write"),
      schema: {
        body: Type.Object(
          {
            path: Type.String({ minLength: 1, description: "Absolute folder path" }),
            mode: Type.Union([Type.Literal("in-place"), Type.Literal("copy")], {
              description:
                "in-place files stay where they are (only inside a library folder or drive); copy files a copy by species",
            }),
          },
          { additionalProperties: false },
        ),
        response: replies(Started, 202),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(400).send({ error: "Folder imports are for the Lifer desktop app." });
      const folder = request.body.path;
      if (!path.isAbsolute(folder)) return reply.code(400).send({ error: "path must be an absolute folder path" });
      const dir = path.resolve(folder);
      if (!(await isDirectory(dir))) return reply.code(400).send({ error: "That folder doesn't exist." });

      const userId = request.user!.id;
      // In place only where Lifer already knows the location, so the files can be found again.
      const known =
        isWithin(path.resolve(ORIGINALS_DIR), dir) || (await tagWithRegisteredVolume(userId, dir)).volumeId !== null;
      const mode = request.body.mode === "in-place" && known ? "in-place" : "copy";
      if (!startFolderImport(userId, dir, mode === "copy", request.apiKeyId ?? null)) {
        return reply.code(409).send({ error: "An import is already running." });
      }
      currentRun++;
      currentFolder = folder;
      return reply.code(202).send({ id: String(currentRun), mode });
    },
  );

  // Ids for uploads, without exposing the catalog: only the id and current name of an exact or
  // superseded-name hit come back, never common names, descriptions or anything else.
  app.post(
    "/imports/v1/species-lookup",
    {
      preValidation: requireScope("imports.write"),
      schema: { body: SpeciesLookupBody, response: replies(SpeciesLookupReply) },
    },
    async (request) => {
      const names = [...new Set(request.body.scientificNames.map((n) => n.trim()).filter(Boolean))];
      const res = await pool.query<{ key: string; id: string; scientific_name: string; kind: "exact" | "synonym" }>(
        `SELECT lower(s.scientific_name) AS key, s.id, s.scientific_name, 'exact' AS kind
           FROM species s WHERE lower(s.scientific_name) = ANY($1)
         UNION ALL
         SELECT lower(syn.synonym_name), s.id, s.scientific_name, 'synonym'
           FROM species_synonyms syn JOIN species s ON s.id = syn.species_id
          WHERE lower(syn.synonym_name) = ANY($1)`,
        [names.map((n) => n.toLowerCase())],
      );
      const matches: { name: string; speciesId: string; scientificName: string; match: "exact" | "synonym" }[] = [];
      const unmatched: string[] = [];
      for (const name of names) {
        const hits = res.rows.filter((r) => r.key === name.toLowerCase());
        // A current name wins over a superseded one.
        const exact = hits.filter((h) => h.kind === "exact");
        const candidates = exact.length > 0 ? exact : hits;
        const ids = new Set(candidates.map((h) => h.id));
        if (ids.size !== 1) unmatched.push(name);
        else
          matches.push({
            name,
            speciesId: candidates[0].id,
            scientificName: candidates[0].scientific_name,
            match: candidates[0].kind,
          });
      }
      return { matches, unmatched };
    },
  );

  app.get(
    "/imports/v1/jobs/:id",
    {
      preValidation: requireScope("imports.write"),
      schema: { params: Type.Object({ id: Type.String() }), response: replies(Progress) },
    },
    async (request, reply) => {
      if (request.params.id !== String(currentRun)) return reply.code(404).send({ error: "No such import." });
      const { filed, ...progress } = { filed: undefined, ...folderImportProgress(request.user!.id) };
      if (!filed) return progress;
      const files = filed.map((f) => ({ path: path.join(currentFolder, f.relativePath), captureId: f.captureId }));
      return { ...progress, files };
    },
  );
}
