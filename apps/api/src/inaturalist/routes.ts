// iNaturalist observation sync. Every route answers 501 with a clear message until a client ID
// is configured (env var, or a server admin's own in Settings).
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { cookieSecureFor, requireAuth } from "../auth/session.js";
import { INAT_CLIENT_ID, INAT_REDIRECT_URI, SINGLE_USER_MODE } from "@lifer/core/config.js";
import { escapeHtml } from "../lib/httpFile.js";
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchJwt,
  fetchInatIdentity,
  createObservation,
  addObservationPhoto,
  fetchObservationLocation,
} from "./client.js";
import { clusterForImport, type ClusterableCapture } from "./grouping.js";
import { loadInatAccount, saveInatAccount } from "./tokenStore.js";

// Maps the OAuth redirect back to the user who clicked Connect. One-time, short-lived, in memory.
interface PendingConnect {
  userId: string;
  verifier: string;
  createdAt: number;
}
const pendingConnects = new Map<string, PendingConnect>();
const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000;

function prunePendingConnects(): void {
  const cutoff = Date.now() - PENDING_CONNECT_TTL_MS;
  for (const [state, pending] of pendingConnects) {
    if (pending.createdAt < cutoff) pendingConnects.delete(state);
  }
}

function notAvailable(reply: { code: (n: number) => { send: (b: unknown) => void } }): void {
  reply.code(501).send({
    error:
      "iNaturalist linking isn't available yet. Register your own app at inaturalist.org/oauth/applications and set it in Settings, or set INAT_CLIENT_ID.",
  });
}

// A saved redirect URI equal to a default counts as unset, so a later INAT_REDIRECT_URI change
// still applies. Settings sends the displayed value back on every Save.
const BUILT_IN_REDIRECT_URI = /^http:\/\/127\.0\.0\.1:\d+\/api\/inaturalist\/callback$/;
export function customRedirectUri(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === INAT_REDIRECT_URI || BUILT_IN_REDIRECT_URI.test(trimmed)) return null;
  return trimmed;
}

// A server has no fixed address to default to, so it uses the one this browser opened Lifer at:
// the connect request and iNaturalist's callback both arrive there. Desktop keeps its loopback one.
function defaultRedirectUri(request: FastifyRequest): string {
  if (SINGLE_USER_MODE || process.env.INAT_REDIRECT_URI || !request.host) return INAT_REDIRECT_URI;
  return `${cookieSecureFor(request) ? "https" : "http"}://${request.host}/api/inaturalist/callback`;
}

// The deployment-wide override from Settings wins over the defaults.
async function resolveInatConfig(request: FastifyRequest): Promise<{ clientId: string | null; redirectUri: string }> {
  const res = await pool.query<{ client_id: string | null; redirect_uri: string | null }>(
    `SELECT client_id, redirect_uri FROM inat_server_config WHERE id = true`,
  );
  const row = res.rows[0];
  return {
    clientId: row?.client_id ?? INAT_CLIENT_ID,
    redirectUri: customRedirectUri(row?.redirect_uri) ?? defaultRedirectUri(request),
  };
}

/** A region's name with its parent's ("British Columbia, Canada"), for iNaturalist's place text. */
async function regionPlaceName(regionId: string): Promise<string | null> {
  const res = await pool.query<{ name: string; parent_name: string | null }>(
    `SELECT r.name, p.name AS parent_name FROM regions r LEFT JOIN regions p ON p.id = r.parent_id WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return row.parent_name ? `${row.name}, ${row.parent_name}` : row.name;
}

// The tokens are stored encrypted (tokenStore.ts).
const requireAccount = (userId: string) => loadInatAccount(userId);

export async function inaturalistRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/inaturalist/status", { preValidation: requireAuth, schema: {} }, async (request) => {
    const [account, { clientId }] = await Promise.all([requireAccount(request.user!.id), resolveInatConfig(request)]);
    return {
      available: clientId !== null,
      connected: account !== null,
      username: account?.inatUsername ?? null,
    };
  });

  app.post("/inaturalist/connect", { preValidation: requireAuth, schema: {} }, async (request, reply) => {
    const { clientId, redirectUri } = await resolveInatConfig(request);
    if (!clientId) return notAvailable(reply);
    prunePendingConnects();
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("base64url");
    pendingConnects.set(state, { userId: request.user!.id, verifier, createdAt: Date.now() });
    return { authorizeUrl: buildAuthorizeUrl(clientId, redirectUri, state, challenge) };
  });

  // Not behind requireAuth: the redirect carries no session cookie, so `state` identifies the attempt.
  // iNaturalist adds its own parameters (error_description and the like), so extras are allowed.
  app.get(
    "/inaturalist/callback",
    {
      schema: {
        querystring: Type.Object({
          code: Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const page = (body: string) =>
        reply.type("text/html").send(`<html><body style="font-family:sans-serif;padding:2rem">${body}</body></html>`);
      if (error) return page(`<p>iNaturalist sign-in was cancelled or denied. You can close this window.</p>`);
      if (!code || !state) return reply.code(400).send({ error: "Missing code or state" });
      const pending = pendingConnects.get(state);
      if (pending) pendingConnects.delete(state);
      // The sweep only runs on new connects, so the TTL is enforced here too.
      if (!pending || Date.now() - pending.createdAt > PENDING_CONNECT_TTL_MS) {
        return page(`<p>This sign-in link expired. Close this window and click Connect again.</p>`);
      }
      const { clientId, redirectUri } = await resolveInatConfig(request);
      if (!clientId) return notAvailable(reply);

      try {
        const tokens = await exchangeCodeForToken(clientId, redirectUri, code, pending.verifier);
        const jwt = await fetchJwt(tokens.access_token);
        const identity = await fetchInatIdentity(jwt);
        await saveInatAccount({
          userId: pending.userId,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          inatUserId: identity.id,
          inatUsername: identity.login,
        });
        return page(
          `<p>Connected as ${escapeHtml(String(identity.login))}. You can close this window and return to Lifer.</p>`,
        );
      } catch (err) {
        return page(`<p>Connecting to iNaturalist failed: ${escapeHtml((err as Error).message ?? "")}</p>`);
      }
    },
  );

  app.post(
    "/inaturalist/disconnect",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async (request) => {
      await pool.query(`DELETE FROM user_inaturalist_accounts WHERE user_id = $1`, [request.user!.id]);
      return { ok: true };
    },
  );

  // Server admin config. GET says whether a client ID is set (it's never sent back) and gives the
  // effective redirect URI to register. PUT sets both; an empty or default redirect URI clears it.
  app.get("/inaturalist/server-config", { preValidation: requireAuth, schema: {} }, async (request) => {
    const { clientId, redirectUri } = await resolveInatConfig(request);
    return { hasClientId: clientId !== null, redirectUri };
  });

  app.put(
    "/inaturalist/server-config",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            clientId: Type.Optional(Nullable(Type.String())),
            clearClientId: Type.Optional(Type.Boolean()),
            redirectUri: Type.Optional(Nullable(Type.String())),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      // A blank or missing client ID keeps the saved one, so saving only the redirect URI can't erase it.
      const clientId = request.body.clientId?.trim() || null;
      const clearClientId = request.body.clearClientId === true;
      const redirectUri = customRedirectUri(request.body.redirectUri);
      await pool.query(
        `INSERT INTO inat_server_config (id, client_id, redirect_uri) VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE SET
           client_id = CASE WHEN $3 THEN NULL ELSE COALESCE(EXCLUDED.client_id, inat_server_config.client_id) END,
           redirect_uri = EXCLUDED.redirect_uri`,
        [clientId, redirectUri, clearClientId],
      );
      return { ok: true };
    },
  );

  app.get("/inaturalist/import", { preValidation: requireAuth, schema: {} }, async (request) => {
    const res = await pool.query<{
      id: string;
      species_id: string;
      scientific_name: string;
      common_name: string | null;
      taken_at: string | null;
      current_photo_id: string | null;
    }>(
      `SELECT c.id, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.current_photo_id
       FROM captures c
       JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM capture_inaturalist_observations o WHERE o.capture_id = c.id)
       ORDER BY c.taken_at DESC NULLS LAST`,
      [request.user!.id],
    );
    const captures: ClusterableCapture[] = res.rows.map((r) => ({
      id: r.id,
      speciesId: r.species_id,
      takenAt: r.taken_at,
    }));
    const clusters = clusterForImport(captures);
    const byId = new Map(res.rows.map((r) => [r.id, r]));
    return {
      clusters: clusters.map((cluster) => ({
        speciesId: cluster.speciesId,
        commonName: byId.get(cluster.captureIds[0])?.common_name ?? null,
        scientificName: byId.get(cluster.captureIds[0])?.scientific_name ?? "",
        earliestTakenAt: cluster.earliestTakenAt,
        latestTakenAt: cluster.latestTakenAt,
        captures: cluster.captureIds.map((id) => ({ id, currentPhotoId: byId.get(id)?.current_photo_id ?? null })),
      })),
    };
  });

  app.post(
    "/inaturalist/observations",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1 }), regionId: Type.Optional(Uuid()) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const account = await requireAccount(request.user!.id);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      const { captureIds, regionId } = request.body;

      const capturesRes = await pool.query<{
        id: string;
        taken_at: string | null;
        lat: string | null;
        lon: string | null;
        inat_taxon_id: number | null;
        display_path: string | null;
        region_id: string | null;
        location_label: string | null;
      }>(
        `SELECT c.id, c.taken_at, c.lat, c.lon, s.inat_taxon_id, p.display_path, c.region_id, c.location_label
         FROM captures c
         JOIN species s ON s.id = c.species_id
         LEFT JOIN photos p ON p.id = c.current_photo_id
         WHERE c.id = ANY($1) AND c.user_id = $2`,
        [captureIds, request.user!.id],
      );
      if (capturesRes.rows.length !== captureIds.length) {
        return reply.code(404).send({ error: "One or more captures not found" });
      }
      const taxonId = capturesRes.rows[0].inat_taxon_id;
      if (!taxonId) return reply.code(422).send({ error: "This species isn't matched to an iNaturalist taxon yet" });

      // Only what the photos recorded is sent; nothing is guessed. Most cameras have no GPS: then
      // the observation goes without coordinates (Casual on iNaturalist) and the user places it
      // with iNaturalist's map, and "Confirm complete" copies that location back here.
      const withGps = capturesRes.rows.find((r) => r.lat !== null && r.lon !== null);
      const location = withGps ? { lat: Number(withGps.lat), lon: Number(withGps.lon) } : null;
      const observedOn = capturesRes.rows.find((r) => r.taken_at)?.taken_at ?? null;
      const labelled = capturesRes.rows.find((r) => r.location_label);
      const placeRegionId = regionId ?? capturesRes.rows.find((r) => r.region_id)?.region_id ?? null;
      const regionName = placeRegionId ? await regionPlaceName(placeRegionId) : null;
      const placeGuess =
        labelled?.location_label && regionName
          ? `${labelled.location_label}, ${regionName}`
          : (labelled?.location_label ?? regionName);

      try {
        const jwt = await fetchJwt(account.accessToken);
        const observationId = await createObservation(jwt, { taxonId, observedOn, location, placeGuess });
        for (const capture of capturesRes.rows) {
          if (capture.display_path) await addObservationPhoto(jwt, observationId, capture.display_path);
        }
        for (const capture of capturesRes.rows) {
          await pool.query(
            `INSERT INTO capture_inaturalist_observations
               (capture_id, inat_observation_id, submitted_lat, submitted_lon, submitted_positional_accuracy)
             VALUES ($1, $2, $3, $4, $5)`,
            [capture.id, observationId, location?.lat ?? null, location?.lon ?? null, null],
          );
        }
        return {
          observationId,
          editUrl: `https://www.inaturalist.org/observations/${observationId}/edit`,
          // No GPS was sent, so the location still has to be placed on iNaturalist.
          needsLocation: location === null,
          needsDate: observedOn === null,
        };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  app.get("/inaturalist/pending", { preValidation: requireAuth, schema: {} }, async (request) => {
    return listByStatus(request.user!.id, "pending");
  });

  app.get("/inaturalist/completed", { preValidation: requireAuth, schema: {} }, async (request) => {
    return listByStatus(request.user!.id, "completed");
  });

  app.post(
    "/inaturalist/observations/:observationId/confirm",
    {
      preValidation: requireAuth,
      // iNaturalist observation ids are numbers; anything else can't be one of ours.
      config: notFoundOnInvalidId("Observation not found or already confirmed"),
      schema: { params: Type.Object({ observationId: Type.String({ pattern: "^[0-9]+$" }) }) },
    },
    async (request, reply) => {
      const account = await requireAccount(request.user!.id);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      const { observationId } = request.params;
      const rowsRes = await pool.query<{
        id: string;
        capture_id: string;
        submitted_lat: string | null;
        submitted_lon: string | null;
        submitted_positional_accuracy: string | null;
      }>(
        `SELECT o.id, o.capture_id, o.submitted_lat, o.submitted_lon, o.submitted_positional_accuracy
         FROM capture_inaturalist_observations o
         JOIN captures c ON c.id = o.capture_id
         WHERE o.inat_observation_id = $1 AND c.user_id = $2 AND o.status = 'pending'`,
        [observationId, request.user!.id],
      );
      if (rowsRes.rows.length === 0)
        return reply.code(404).send({ error: "Observation not found or already confirmed" });

      try {
        const jwt = await fetchJwt(account.accessToken);
        const remote = await fetchObservationLocation(jwt, observationId);
        const submitted = rowsRes.rows[0];
        if (remote.lat === null || remote.lon === null) {
          return {
            confirmed: false,
            message: "This observation has no location yet. Place it on iNaturalist, then confirm again.",
          };
        }
        // Observations sent before Lifer stopped guessing carry a region-centre location (sent
        // with a 50 km accuracy); one still sitting there hasn't been placed yet.
        const sentGuess =
          submitted.submitted_positional_accuracy !== null && Number(submitted.submitted_positional_accuracy) >= 50_000;
        const stillGuess =
          sentGuess &&
          Math.abs(remote.lat - Number(submitted.submitted_lat)) < 1e-6 &&
          Math.abs(remote.lon - Number(submitted.submitted_lon)) < 1e-6;
        if (stillGuess) {
          return {
            confirmed: false,
            message:
              "This still looks like the default location. Finish editing it on iNaturalist, then confirm again.",
          };
        }
        await withTransaction(async (client) => {
          // Photos without their own GPS take the location the user placed on iNaturalist. A
          // camera's GPS is never overwritten.
          await client.query(
            `UPDATE captures_all SET lat = $1, lon = $2, location_source = 'inaturalist', location_accuracy_m = $3
             WHERE id = ANY($4) AND lat IS NULL AND lon IS NULL`,
            [remote.lat, remote.lon, remote.positionalAccuracyMeters, rowsRes.rows.map((r) => r.capture_id)],
          );
          await client.query(
            `UPDATE capture_inaturalist_observations SET status = 'completed', confirmed_at = now() WHERE inat_observation_id = $1`,
            [observationId],
          );
        });
        return { confirmed: true };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );
}

async function listByStatus(userId: string, status: "pending" | "completed") {
  const res = await pool.query<{
    inat_observation_id: string;
    scientific_name: string;
    common_name: string | null;
    current_photo_id: string | null;
    created_at: string;
    confirmed_at: string | null;
  }>(
    `SELECT DISTINCT ON (o.inat_observation_id)
       o.inat_observation_id, s.scientific_name, s.common_name, c.current_photo_id, o.created_at, o.confirmed_at
     FROM capture_inaturalist_observations o
     JOIN captures c ON c.id = o.capture_id
     JOIN species s ON s.id = c.species_id
     WHERE c.user_id = $1 AND o.status = $2
     ORDER BY o.inat_observation_id, o.created_at DESC`,
    [userId, status],
  );
  return {
    observations: res.rows.map((r) => ({
      observationId: r.inat_observation_id,
      scientificName: r.scientific_name,
      commonName: r.common_name,
      currentPhotoId: r.current_photo_id,
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
      url: `https://www.inaturalist.org/observations/${r.inat_observation_id}`,
      editUrl: `https://www.inaturalist.org/observations/${r.inat_observation_id}/edit`,
    })),
  };
}
