// iNaturalist observation sync. Every route answers 501 with a clear message until a client ID
// is configured (env var, or a server admin's own in Settings).
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { cookieSecureFor, requireAuth } from "../auth/session.js";
import { INAT_CLIENT_ID, INAT_REDIRECT_URI, SINGLE_USER_MODE } from "../config.js";
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

// Deliberately coarse so a rough location visibly needs refining rather than passing as accurate.
const DEFAULT_POSITIONAL_ACCURACY_METERS = 50_000;

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
    error: "iNaturalist linking isn't available yet. Register your own app at inaturalist.org/oauth/applications and set it in Settings, or set INAT_CLIENT_ID.",
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

async function regionCentroid(regionId: string): Promise<{ lat: number; lon: number } | null> {
  const res = await pool.query<{ boundary_geojson: { bbox?: [number, number, number, number] } | null }>(
    `SELECT boundary_geojson FROM regions WHERE id = $1`,
    [regionId],
  );
  const bbox = res.rows[0]?.boundary_geojson?.bbox;
  if (!bbox) return null;
  return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
}

interface AccountRow {
  access_token: string;
  inat_username: string;
}

async function requireAccount(userId: string): Promise<AccountRow | null> {
  const res = await pool.query<AccountRow>(`SELECT access_token, inat_username FROM user_inaturalist_accounts WHERE user_id = $1`, [
    userId,
  ]);
  return res.rows[0] ?? null;
}

export async function inaturalistRoutes(app: FastifyInstance): Promise<void> {
  app.get("/inaturalist/status", { preHandler: requireAuth }, async (request) => {
    const [account, { clientId }] = await Promise.all([requireAccount(request.user!.id), resolveInatConfig(request)]);
    return {
      available: clientId !== null,
      connected: account !== null,
      username: account?.inat_username ?? null,
    };
  });

  app.post("/inaturalist/connect", { preHandler: requireAuth }, async (request, reply) => {
    const { clientId, redirectUri } = await resolveInatConfig(request);
    if (!clientId) return notAvailable(reply);
    prunePendingConnects();
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("base64url");
    pendingConnects.set(state, { userId: request.user!.id, verifier, createdAt: Date.now() });
    return { authorizeUrl: buildAuthorizeUrl(clientId, redirectUri, state, challenge) };
  });

  // Not behind requireAuth: the redirect carries no session cookie, so `state` identifies the attempt.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/inaturalist/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      const page = (body: string) => reply.type("text/html").send(`<html><body style="font-family:sans-serif;padding:2rem">${body}</body></html>`);
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
        await pool.query(
          `INSERT INTO user_inaturalist_accounts (user_id, access_token, refresh_token, inat_user_id, inat_username)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET
             access_token = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             inat_user_id = EXCLUDED.inat_user_id,
             inat_username = EXCLUDED.inat_username,
             connected_at = now()`,
          [pending.userId, tokens.access_token, tokens.refresh_token, identity.id, identity.login],
        );
        return page(`<p>Connected as ${escapeHtml(String(identity.login))}. You can close this window and return to Lifer.</p>`);
      } catch (err) {
        return page(`<p>Connecting to iNaturalist failed: ${escapeHtml((err as Error).message ?? "")}</p>`);
      }
    },
  );

  app.post("/inaturalist/disconnect", { preHandler: requireAuth }, async (request) => {
    await pool.query(`DELETE FROM user_inaturalist_accounts WHERE user_id = $1`, [request.user!.id]);
    return { ok: true };
  });

  // Server admin config. GET says whether a client ID is set (it's never sent back) and gives the
  // effective redirect URI to register. PUT sets both; an empty or default redirect URI clears it.
  app.get("/inaturalist/server-config", { preHandler: requireAuth }, async (request) => {
    const { clientId, redirectUri } = await resolveInatConfig(request);
    return { hasClientId: clientId !== null, redirectUri };
  });

  app.put<{ Body: { clientId?: string | null; clearClientId?: boolean; redirectUri?: string | null } }>(
    "/inaturalist/server-config",
    { preHandler: requireAuth },
    async (request) => {
      // A blank or missing client ID keeps the saved one, so saving only the redirect URI can't erase it.
      const clientId = request.body?.clientId?.trim() || null;
      const clearClientId = request.body?.clearClientId === true;
      const redirectUri = customRedirectUri(request.body?.redirectUri);
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

  app.get("/inaturalist/import", { preHandler: requireAuth }, async (request) => {
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
    const captures: ClusterableCapture[] = res.rows.map((r) => ({ id: r.id, speciesId: r.species_id, takenAt: r.taken_at }));
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

  app.post<{ Body: { captureIds: string[]; regionId?: string } }>(
    "/inaturalist/observations",
    { preHandler: requireAuth },
    async (request, reply) => {
      const account = await requireAccount(request.user!.id);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      const { captureIds, regionId } = request.body;
      if (!captureIds?.length) return reply.code(400).send({ error: "captureIds required" });
      if (!Array.isArray(captureIds) || !captureIds.every(isUuid)) return reply.code(404).send({ error: "One or more captures not found" });

      const capturesRes = await pool.query<{
        id: string;
        taken_at: string | null;
        lat: string | null;
        lon: string | null;
        inat_taxon_id: number | null;
        display_path: string | null;
      }>(
        `SELECT c.id, c.taken_at, c.lat, c.lon, s.inat_taxon_id, p.display_path
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

      const withGps = capturesRes.rows.find((r) => r.lat !== null && r.lon !== null);
      const centroid = withGps
        ? { lat: Number(withGps.lat), lon: Number(withGps.lon) }
        : regionId && isUuid(regionId)
          ? await regionCentroid(regionId)
          : null;
      if (!centroid) return reply.code(422).send({ error: "No location available. Pick a region first" });
      const positionalAccuracy = withGps ? 100 : DEFAULT_POSITIONAL_ACCURACY_METERS;

      const observedOn = capturesRes.rows.find((r) => r.taken_at)?.taken_at ?? new Date().toISOString();

      try {
        const jwt = await fetchJwt(account.access_token);
        const observationId = await createObservation(jwt, {
          taxonId,
          observedOn,
          lat: centroid.lat,
          lon: centroid.lon,
          positionalAccuracyMeters: positionalAccuracy,
        });
        for (const capture of capturesRes.rows) {
          if (capture.display_path) await addObservationPhoto(jwt, observationId, capture.display_path);
        }
        for (const capture of capturesRes.rows) {
          await pool.query(
            `INSERT INTO capture_inaturalist_observations
               (capture_id, inat_observation_id, submitted_lat, submitted_lon, submitted_positional_accuracy)
             VALUES ($1, $2, $3, $4, $5)`,
            [capture.id, observationId, centroid.lat, centroid.lon, positionalAccuracy],
          );
        }
        return { observationId, editUrl: `https://www.inaturalist.org/observations/${observationId}/edit` };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  app.get("/inaturalist/pending", { preHandler: requireAuth }, async (request) => {
    return listByStatus(request.user!.id, "pending");
  });

  app.get("/inaturalist/completed", { preHandler: requireAuth }, async (request) => {
    return listByStatus(request.user!.id, "completed");
  });

  app.post<{ Params: { observationId: string } }>(
    "/inaturalist/observations/:observationId/confirm",
    { preHandler: requireAuth },
    async (request, reply) => {
      const account = await requireAccount(request.user!.id);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      const { observationId } = request.params;
      const rowsRes = await pool.query<{ id: string; submitted_lat: string; submitted_lon: string }>(
        `SELECT o.id, o.submitted_lat, o.submitted_lon
         FROM capture_inaturalist_observations o
         JOIN captures c ON c.id = o.capture_id
         WHERE o.inat_observation_id = $1 AND c.user_id = $2 AND o.status = 'pending'`,
        [observationId, request.user!.id],
      );
      if (rowsRes.rows.length === 0) return reply.code(404).send({ error: "Observation not found or already confirmed" });

      try {
        const jwt = await fetchJwt(account.access_token);
        const remote = await fetchObservationLocation(jwt, observationId);
        const submitted = rowsRes.rows[0];
        const stillCoarse =
          remote.lat !== null &&
          remote.lon !== null &&
          Math.abs(remote.lat - Number(submitted.submitted_lat)) < 1e-6 &&
          Math.abs(remote.lon - Number(submitted.submitted_lon)) < 1e-6;
        if (stillCoarse) {
          return { confirmed: false, message: "This still looks like the default location. Finish editing it on iNaturalist, then confirm again." };
        }
        await pool.query(
          `UPDATE capture_inaturalist_observations SET status = 'completed', confirmed_at = now() WHERE inat_observation_id = $1`,
          [observationId],
        );
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
