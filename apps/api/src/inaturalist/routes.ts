// iNaturalist observation sync. Every route answers 501 with a clear message until a client ID
// is configured (built in, an env var, or a server admin's own in inat_server_config).
import { placeForSend, regionPlaceName } from "../places/placePrivacy.js";
import { SendHintSchema, sendHints } from "../places/sendHints.js";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { Nullable, Ok, Open, Uuid, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { createJob, type JobContext } from "../lib/job.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { queueRecheck } from "../captures/recheck.js";
import { regionAt } from "../regions/regionAt.js";
import { placeLabel } from "../places/placeLabel.js";
import { cookieSecureFor, hashToken, requireAuth, requireScope } from "../auth/session.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { linkedServer, serverFetch } from "../sync/serverLink.js";
import {
  BUILT_IN_INAT_CLIENT_ID,
  INAT_CLIENT_ID,
  INAT_REDIRECT_URI,
  INAT_RELAY_REDIRECT_URI,
  PORT,
  SESSION_COOKIE_NAME,
  SINGLE_USER_MODE,
} from "@lifer/core/config.js";
import { escapeHtml } from "../lib/httpFile.js";
import { log } from "@lifer/core/lib/log.js";
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchJwt,
  fetchInatIdentity,
  createObservation,
  addObservationPhoto,
  fetchObservationLocation,
  type RemoteObservationLocation,
} from "./client.js";
import { clusterForImport, type ClusterableCapture } from "@lifer/shared";
import { GalleryFilterQuery, rawFilterSql } from "../gallery/routes.js";
import { filesCaptureOf } from "../lib/versionFiles.js";
import { loadInatAccount, saveInatAccount } from "./tokenStore.js";
import { observedOnString, observedOnToTakenAt } from "./dates.js";
import { encodeRelayState, isAllowedReturnOrigin } from "./relayState.js";
import { recordFoundWrites, snapshotFound, unlinkFound } from "./unlink.js";
import { likeness, previewUrl, type Match } from "./matching.js";
import { fetchObservationPages, fetchPreview } from "./observationSync.js";
import { flushLocationUpdates, loadLocationQueue, setLocationEntries, type FlushResult } from "./locationUpdate.js";
import {
  findMatches,
  linkFound,
  loadObservations,
  resetObservationCache,
  storeObservations,
  syncObservations,
} from "./observationMatch.js";

interface ClusterRow {
  id: string;
  species_id: string;
  taken_at: string | null;
  lat: string | null;
  lon: string | null;
  camera_model: string | null;
  lens: string | null;
}

// The place and gear a sighting is split on (clusterForImport); numeric columns arrive as strings.
const clusterFields = (r: ClusterRow) => ({
  lat: r.lat === null ? null : Number(r.lat),
  lon: r.lon === null ? null : Number(r.lon),
  cameraModel: r.camera_model,
  lens: r.lens,
});

// Maps the OAuth redirect back to the user who clicked Connect. One-time, short-lived, in memory.
interface PendingConnect {
  userId: string;
  verifier: string;
  createdAt: number;
  /** Hash of the session that started it: on a server, only that session's browser may finish it. */
  sessionHash: string | null;
}
const pendingConnects = new Map<string, PendingConnect>();
const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000;

function prunePendingConnects(): void {
  const cutoff = Date.now() - PENDING_CONNECT_TTL_MS;
  for (const [state, pending] of pendingConnects) {
    if (pending.createdAt < cutoff) pendingConnects.delete(state);
  }
}

const sessionHashOf = (request: FastifyRequest): string | null => {
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  return token ? hashToken(token) : null;
};

// Addresses the user accepted for the relay hand-back, kept per install.
const TRUSTED_ORIGINS_KEY = "inat_trusted_origins";
const trustedOrigins = async () => (await getInstallSetting<string[]>(pool, TRUSTED_ORIGINS_KEY)) ?? [];

function notAvailable(reply: { code: (n: number) => { send: (b: unknown) => void } }): void {
  reply.code(501).send({
    error:
      "iNaturalist linking isn't available in this version of Lifer. To use your own iNaturalist app, set INAT_CLIENT_ID.",
  });
}

// A saved redirect URI equal to a default counts as unset, so a later INAT_REDIRECT_URI change
// still applies. The loopback pattern is any desktop port's own-app default.
const LOOPBACK_REDIRECT_URI = /^http:\/\/127\.0\.0\.1:\d+\/api\/inaturalist\/callback$/;
export function customRedirectUri(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === INAT_REDIRECT_URI || trimmed === INAT_RELAY_REDIRECT_URI) return null;
  if (LOOPBACK_REDIRECT_URI.test(trimmed)) return null;
  return trimmed;
}

// Where the relay page sends the sign-in back to: the loopback API on desktop, and on a server
// the address this browser opened Lifer at, since iNaturalist's callback arrives there too.
function returnOrigin(request: FastifyRequest): string | null {
  if (SINGLE_USER_MODE) return `http://127.0.0.1:${PORT}`;
  if (!request.host) return null;
  try {
    return new URL(`${cookieSecureFor(request) ? "https" : "http"}://${request.host}`).origin;
  } catch {
    return null;
  }
}

// The deployment-wide override in inat_server_config wins over env, which wins over the built-ins.
async function resolveInatConfig(request: FastifyRequest): Promise<{ clientId: string | null; redirectUri: string }> {
  const res = await pool.query<{ client_id: string | null; redirect_uri: string | null }>(
    `SELECT client_id, redirect_uri FROM inat_server_config WHERE id = true`,
  );
  const row = res.rows[0];
  const clientId = row?.client_id ?? INAT_CLIENT_ID;
  // A self-registered app with no redirect URI set was registered with this install's own callback.
  const origin = returnOrigin(request);
  const ownApp = clientId !== null && clientId !== BUILT_IN_INAT_CLIENT_ID && origin !== null;
  return {
    clientId,
    redirectUri:
      customRedirectUri(row?.redirect_uri) ??
      // The desktop app signs in on its own loopback address and never goes through the relay.
      (SINGLE_USER_MODE
        ? `http://127.0.0.1:${PORT}/api/inaturalist/callback`
        : (INAT_REDIRECT_URI ?? (ownApp ? `${origin}/api/inaturalist/callback` : INAT_RELAY_REDIRECT_URI))),
  };
}

const InatStatus = Open({ available: Type.Boolean(), connected: Type.Boolean(), username: Nullable(Type.String()) });
const ObservationList = Open({
  observations: Type.Array(
    Open({
      observationId: Type.String(),
      speciesId: Uuid(),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      currentPhotoId: Nullable(Uuid()),
      createdAt: Type.String({ format: "date-time" }),
      confirmedAt: Nullable(Type.String({ format: "date-time" })),
      url: Type.String(),
      editUrl: Type.String(),
      photoCount: Type.Integer(),
      /** The earliest photo's time, null when none recorded one. */
      observedAt: Nullable(Type.String({ format: "date-time" })),
      latestAt: Nullable(Type.String({ format: "date-time" })),
      photoIds: Type.Array(Uuid(), { description: "The observation's photos, earliest first, for previews" }),
      sentLocation: Type.Boolean({ description: "The photos' own GPS was sent, not placed on iNaturalist" }),
      dateFromInat: Type.Boolean({ description: "A photo with no date took the one added on iNaturalist" }),
      foundOnInat: Type.Boolean({ description: "Made on iNaturalist by the user and found there, not sent by Lifer" }),
      taxonClass: Nullable(Type.String()),
      placeName: Nullable(Type.String({ description: "Where the photos were taken: place label and region" })),
      inatPhotoId: Nullable(
        Type.String({
          description: "The observation's first photo on iNaturalist, when its cached copy is here, for a preview",
        }),
      ),
      captureIds: Type.Array(Uuid(), { description: "The observation's photos in the library, for Set location" }),
      noLocationOnInat: Type.Boolean({
        description: "Sent without a location and, as far as Lifer knows, still without one on iNaturalist",
      }),
      locationUpdate: Nullable(
        Open({
          state: Type.Union([
            Type.Literal("waiting"),
            Type.Literal("sent"),
            Type.Literal("failed"),
            Type.Literal("conflict"),
          ]),
          at: Type.String({ format: "date-time" }),
          reason: Type.Optional(
            Type.Union([
              Type.Literal("reconnect"),
              Type.Literal("notFound"),
              Type.Literal("refused"),
              Type.Literal("noLocation"),
            ]),
          ),
        }),
      ),
    }),
  ),
});
const ImportList = Open({
  ignoredCount: Type.Integer({ description: "Ignored sightings not on iNaturalist, shown under Ignored" }),
  totalCount: Type.Integer({ description: "Sightings in this list before the RAW filters, for the tab's count" }),
  clusters: Type.Array(
    Open({
      speciesId: Uuid(),
      commonName: Nullable(Type.String()),
      scientificName: Type.String(),
      earliestTakenAt: Nullable(Type.String({ format: "date-time" })),
      latestTakenAt: Nullable(Type.String({ format: "date-time" })),
      matched: Type.Boolean({ description: "The species has an iNaturalist match, so it can be sent" }),
      taxonClass: Nullable(
        Type.String({ description: "The species' group of life, as the Collection's taxon filter" }),
      ),
      placeName: Nullable(Type.String({ description: "Where the photos were taken: place label and region" })),
      ...SendHintSchema,
      captures: Type.Array(
        Open({
          id: Uuid(),
          currentPhotoId: Nullable(Uuid()),
          hasLocation: Type.Boolean(),
          onInat: Type.Boolean({ description: "Looks the same as one of your iNaturalist observations: review it" }),
        }),
      ),
    }),
  ),
});
const SentObservation = Open({
  observationId: Type.String(),
  editUrl: Type.String(),
  needsLocation: Type.Boolean({ description: "No GPS was sent: place it on iNaturalist" }),
  needsDate: Type.Boolean(),
  linkedExisting: Type.Boolean({ description: "Already on iNaturalist: linked to that observation, nothing sent" }),
});

// Best effort: a desktop that isn't linked, or can't reach its server now, simply keeps its own.
async function shareAccountWithLinkedServer(account: object): Promise<void> {
  try {
    const server = await linkedServer();
    if (server) await serverFetch(server, "/inaturalist/account", { method: "PUT", body: JSON.stringify(account) });
  } catch (err) {
    log.warn(`[inaturalist] couldn't pass the sign-in to the linked server: ${(err as Error).message}`);
  }
}

// The tokens are stored encrypted (tokenStore.ts).
const requireAccount = (userId: string) => loadInatAccount(userId);

export async function inaturalistRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/inaturalist/status",
    { preValidation: requireAuth, schema: { response: replies(InatStatus) } },
    async (request) => {
      const [account, { clientId }] = await Promise.all([requireAccount(request.user!.id), resolveInatConfig(request)]);
      return {
        available: clientId !== null,
        connected: account !== null,
        username: account?.inatUsername ?? null,
      };
    },
  );

  app.post("/inaturalist/connect", { preValidation: requireAuth, schema: {} }, async (request, reply) => {
    const { clientId, redirectUri } = await resolveInatConfig(request);
    if (!clientId) return notAvailable(reply);
    prunePendingConnects();
    const { verifier, challenge } = generatePkce();
    let state = randomBytes(16).toString("base64url");
    // A self-registered redirect URI points straight at this install; the relay needs telling where to go.
    if (redirectUri === INAT_RELAY_REDIRECT_URI) {
      const origin = returnOrigin(request);
      if (!origin || !isAllowedReturnOrigin(origin)) {
        return reply.code(400).send({
          error: "iNaturalist sign-in needs Lifer opened over https, or at a local network address.",
        });
      }
      // A first sign-in from this address says where the code will be sent and waits for a yes.
      if (!(await trustedOrigins()).includes(origin)) return { needsTrust: true, address: origin };
      state = encodeRelayState(state, origin);
    }
    pendingConnects.set(state, {
      userId: request.user!.id,
      verifier,
      createdAt: Date.now(),
      sessionHash: SINGLE_USER_MODE ? null : sessionHashOf(request),
    });
    return { authorizeUrl: buildAuthorizeUrl(clientId, redirectUri, state, challenge) };
  });

  // The user said yes to the relay hand-back for this address; remembered, so it's asked once.
  app.post(
    "/inaturalist/trust",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ address: Type.String({ maxLength: 300 }) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { address } = request.body;
      // Only the address this browser opened Lifer at, so a page can't trust one for another.
      if (!isAllowedReturnOrigin(address) || address !== returnOrigin(request))
        return reply.code(400).send({ error: "That isn't the address this window is using" });
      const known = await trustedOrigins();
      if (!known.includes(address)) await setInstallSetting(pool, TRUSTED_ORIGINS_KEY, [...known, address]);
      return { ok: true };
    },
  );

  // A linked desktop hands its iNaturalist sign-in to its server, so uploads work from either.
  // Same trust as the sync key that sends it; a desktop never receives one.
  app.put(
    "/inaturalist/account",
    {
      preValidation: requireScope("sync"),
      schema: {
        body: Type.Object(
          {
            accessToken: Type.String({ minLength: 1, maxLength: 4096 }),
            refreshToken: Nullable(Type.String({ maxLength: 4096 })),
            inatUserId: Type.String({ minLength: 1, maxLength: 64 }),
            inatUsername: Type.String({ minLength: 1, maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      if (SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      await saveInatAccount({ userId: request.user!.id, ...request.body });
      await resetObservationCache(request.user!.id);
      return { ok: true };
    },
  );

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
      // A sign-in started in one browser session can't be finished from another.
      if (pending.sessionHash !== null && pending.sessionHash !== sessionHashOf(request)) {
        return page(`<p>This sign-in was started from a different window. Close this one and click Connect again.</p>`);
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
        await resetObservationCache(pending.userId);
        // The first look for observations already on iNaturalist starts now, in the background.
        lastAutoTry.delete(pending.userId);
        void autoFind(pending.userId, { accessToken: tokens.access_token }).catch(() => {});
        if (SINGLE_USER_MODE) {
          void shareAccountWithLinkedServer({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            inatUserId: identity.id,
            inatUsername: identity.login,
          });
        }
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

  app.get(
    "/inaturalist/import",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          ignored: Type.Optional(
            Type.Union([Type.Literal("true"), Type.Literal("false")], {
              description: "true lists the ignored photos instead, to restore or send them",
            }),
          ),
          // The Gallery's RAW filters; a sighting is listed whole when any of its photos passes.
          includeRaw: GalleryFilterQuery.properties.includeRaw,
          onlyRaw: GalleryFilterQuery.properties.onlyRaw,
          onlyHasRaw: GalleryFilterQuery.properties.onlyHasRaw,
          excludeHasRaw: GalleryFilterQuery.properties.excludeHasRaw,
        }),
        response: replies(ImportList),
      },
    },
    async (request) => {
      const q = request.query;
      const ignored = q.ignored === "true";
      const passes = `(TRUE ${rawFilterSql({
        includeRaw: q.includeRaw !== "0",
        onlyRaw: q.onlyRaw === "1",
        onlyHasRaw: q.onlyHasRaw === "1",
        excludeHasRaw: q.excludeHasRaw === "1",
      })})`;
      // The photo's main original, as the Gallery's filters read it.
      const mainOriginal = `LEFT JOIN LATERAL (SELECT * FROM originals lo WHERE lo.capture_id = ${filesCaptureOf("c")}
         ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1) o ON true`;
      // Whole sightings: one passing photo keeps its sighting, so a send never splits it.
      const keepPassing = <T extends { captureIds: string[] }>(clusters: T[], pass: Set<string>) =>
        clusters.filter((cl) => cl.captureIds.some((id) => pass.has(id)));
      const res = await pool.query<{
        id: string;
        species_id: string;
        scientific_name: string;
        common_name: string | null;
        taken_at: string | null;
        current_photo_id: string | null;
        has_location: boolean;
        matched: boolean;
        taxon_class: string | null;
        location_label: string | null;
        region_name: string | null;
        lat: string | null;
        lon: string | null;
        camera_model: string | null;
        lens: string | null;
        passes: boolean;
      }>(
        `SELECT c.id, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.current_photo_id,
              (c.lat IS NOT NULL AND c.lon IS NOT NULL) AS has_location, (s.inat_taxon_id IS NOT NULL) AS matched,
              s.taxon_class, c.location_label, rg.name AS region_name,
              c.lat, c.lon, c.camera_model, c.lens, ${passes} AS passes
       FROM captures c
       JOIN species s ON s.id = c.species_id
       LEFT JOIN regions rg ON rg.id = c.region_id
       ${mainOriginal}
       WHERE c.user_id = $1 AND (c.inat_ignored_at IS NOT NULL) = $2::boolean
         AND NOT EXISTS (SELECT 1 FROM capture_inaturalist_observations o WHERE o.capture_id = c.id AND o.photo_sent)
         AND ${NOT_RECORDING}
       ORDER BY c.taken_at DESC NULLS LAST`,
        [request.user!.id, ignored],
      );

      const captures: ClusterableCapture[] = res.rows.map((r) => ({
        id: r.id,
        speciesId: r.species_id,
        takenAt: r.taken_at,
        ...clusterFields(r),
      }));
      const all = clusterForImport(captures);
      const clusters = keepPassing(all, new Set(res.rows.filter((r) => r.passes).map((r) => r.id)));
      // Counted as sightings, the way the Ignored view lists them.
      const ignoredCount = ignored
        ? clusters.length
        : await pool
            .query<ClusterRow & { passes: boolean }>(
              `SELECT c.id, c.species_id, c.taken_at, c.lat, c.lon, c.camera_model, c.lens, ${passes} AS passes
                 FROM captures c
                 ${mainOriginal}
                 WHERE c.user_id = $1 AND c.inat_ignored_at IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM capture_inaturalist_observations o WHERE o.capture_id = c.id AND o.photo_sent)
                   AND ${NOT_RECORDING}`,
              [request.user!.id],
            )
            .then(
              ({ rows }) =>
                keepPassing(
                  clusterForImport(
                    rows.map((r) => ({ id: r.id, speciesId: r.species_id, takenAt: r.taken_at, ...clusterFields(r) })),
                  ),
                  new Set(rows.filter((r) => r.passes).map((r) => r.id)),
                ).length,
            );
      const byId = new Map(res.rows.map((r) => [r.id, r]));
      const onInat = new Set(
        (reviewByUser.get(request.user!.id) ?? [])
          .filter((m) => likeness(m.similarity) === "same")
          .map((m) => m.captureId),
      );
      const hints = await sendHints(
        request.user!.id,
        clusters.map((c) => c.captureIds),
      );
      const placeNames = await Promise.all(
        clusters.map((cluster) => {
          const rows = cluster.captureIds.map((id) => byId.get(id)!).filter(Boolean);
          const r =
            rows.find((x) => x.location_label || x.region_name) ?? rows.find((x) => x.lat != null && x.lon != null);
          return placeLabel({
            label: r?.location_label ?? null,
            region: r?.region_name ?? null,
            lat: r?.lat ?? null,
            lon: r?.lon ?? null,
          });
        }),
      );
      return {
        ignoredCount,
        totalCount: all.length,
        clusters: clusters.map((cluster, i) => ({
          ...hints[i],
          speciesId: cluster.speciesId,
          commonName: byId.get(cluster.captureIds[0])?.common_name ?? null,
          scientificName: byId.get(cluster.captureIds[0])?.scientific_name ?? "",
          earliestTakenAt: cluster.earliestTakenAt,
          latestTakenAt: cluster.latestTakenAt,
          matched: byId.get(cluster.captureIds[0])?.matched ?? false,
          taxonClass: byId.get(cluster.captureIds[0])?.taxon_class ?? null,
          placeName: placeNames[i],
          captures: cluster.captureIds.map((id) => ({
            id,
            currentPhotoId: byId.get(id)?.current_photo_id ?? null,
            hasLocation: byId.get(id)?.has_location ?? false,
            onInat: onInat.has(id),
          })),
        })),
      };
    },
  );

  app.post(
    "/inaturalist/observations",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            captureIds: Type.Array(Uuid(), { minItems: 1 }),
            regionId: Type.Optional(Uuid()),
            ignoreExistingGuard: Type.Optional(
              Type.Boolean({
                description: "The user chose Send anyway: skip the check for an observation already there",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(SentObservation),
      },
    },
    async (request, reply) => {
      const account = await requireAccount(request.user!.id);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      const result = await sendObservation(
        request.user!.id,
        account,
        [...new Set(request.body.captureIds)],
        request.body.regionId,
        request.body.ignoreExistingGuard === true,
      );
      return result.ok
        ? result.value
        : reply.code(result.status).send({ error: result.error, ...(result.code ? { code: result.code } : {}) });
    },
  );

  // Photos picked in the app, whatever their species or day: grouped into sightings the way the To
  // send tab groups them (or in the groups given), then sent one observation at a time in the background.
  const SendStatus = Type.Object(
    jobStatusFields(
      Type.Object({
        sent: Type.Integer(),
        linked: Type.Integer({ description: "Sightings already on iNaturalist, linked instead of sent again" }),
        incomplete: Type.Integer({ description: "Sent without a location or date, to finish on iNaturalist" }),
        skipped: Type.Integer({ description: "Already sent, or the species has no iNaturalist match yet" }),
        failed: Type.Integer(),
        maybeOnInat: Type.Array(Type.Array(Uuid()), {
          description: "Sightings held back because they may already be on iNaturalist, to review or send anyway",
        }),
        editUrl: Nullable(Type.String({ description: "The one observation to finish, when exactly one was sent" })),
        error: Nullable(Type.String()),
      }),
    ),
  );
  app.post(
    "/inaturalist/observations/batch",
    {
      preValidation: requireAuth,
      schema: {
        // captureIds are grouped into sightings here; each of `groups` is sent as exactly one observation.
        body: Type.Object(
          {
            captureIds: Type.Optional(Type.Array(Uuid(), { minItems: 1, maxItems: 10000 })),
            groups: Type.Optional(
              Type.Array(Type.Array(Uuid(), { minItems: 1, maxItems: 1000 }), { minItems: 1, maxItems: 10000 }),
            ),
            // Only from the user's own Send anyway, never Send all or anything automatic.
            ignoreExistingGuard: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { captureIds, groups, ignoreExistingGuard } = request.body;
      if (!captureIds === !groups) return reply.code(400).send({ error: "Send either captureIds or groups" });
      const account = await requireAccount(userId);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      if (sendJob.status.running) return reply.code(409).send({ error: "Photos are already being sent" });
      const asked = groups ? groups.map((g) => [...new Set(g)]) : null;
      const ids = [...new Set(captureIds ?? asked!.flat())];
      const started = sendJob.start((ctx) =>
        runSendBatch(ctx, userId, account, ids, asked, ignoreExistingGuard === true),
      );
      if (!started) return reply.code(409).send({ error: "Photos are already being sent" });
      sendOwner = userId;
      return { ok: true };
    },
  );

  app.get(
    "/inaturalist/observations/batch/status",
    { preValidation: requireAuth, schema: { response: replies(SendStatus) } },
    async (request) => {
      // Someone else's run on a shared server shows as idle.
      const mine = sendOwner === null || sendOwner === request.user!.id;
      return mine ? sendJob.status : { ...sendJob.status, running: false, processed: null, total: null, result: null };
    },
  );

  app.post(
    "/inaturalist/observations/batch/cancel",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async (request) => {
      if (sendOwner === request.user!.id) sendJob.cancel();
      return { ok: true };
    },
  );

  // A location set in Lifer for observations sent without one: queued, then sent to iNaturalist in
  // the background. Offline, it waits and the To finish check sends it later.
  const LocationStatus = Type.Object(
    jobStatusFields(
      Type.Object({
        updated: Type.Integer({ description: "Observations whose location iNaturalist now has" }),
        waiting: Type.Integer({ description: "Couldn't reach iNaturalist: sent on a later try" }),
        failed: Type.Integer(),
        conflicts: Type.Integer({ description: "Already placed on iNaturalist: replace or keep is the user's call" }),
        conflictIds: Type.Array(Type.String()),
      }),
    ),
  );
  app.post(
    "/inaturalist/observations/location",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            observationIds: Type.Array(Type.String({ pattern: "^[0-9]+$", maxLength: 20 }), {
              minItems: 1,
              maxItems: 10000,
            }),
            conflict: Type.Optional(
              Type.Union([Type.Literal("replace"), Type.Literal("keep")], {
                description: "For ones iNaturalist already placed: replace that location, or keep it and stop",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Open({ started: Type.Boolean({ description: "False: queued for a later try" }) })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const owned = (
        await pool.query<{ id: string }>(
          `SELECT DISTINCT o.inat_observation_id AS id FROM capture_inaturalist_observations o
           JOIN captures c ON c.id = o.capture_id
           WHERE c.user_id = $1 AND o.inat_observation_id = ANY($2::text[]) AND o.photo_sent`,
          [userId, [...new Set(request.body.observationIds)]],
        )
      ).rows.map((r) => r.id);
      const { conflict } = request.body;
      if (conflict === "keep") {
        await setLocationEntries(userId, Object.fromEntries(owned.map((id) => [id, null])));
        return { started: false };
      }
      const at = new Date().toISOString();
      const replace = conflict === "replace" ? { replace: true } : {};
      await setLocationEntries(
        userId,
        Object.fromEntries(owned.map((id) => [id, { state: "waiting" as const, at, ...replace }])),
      );
      const account = await requireAccount(userId);
      return { started: account ? startLocationJob(userId, account) : false };
    },
  );
  app.get(
    "/inaturalist/observations/location/status",
    { preValidation: requireAuth, schema: { response: replies(LocationStatus) } },
    async (request) => {
      const mine = locationOwner === null || locationOwner === request.user!.id;
      return mine
        ? locationJob.status
        : { ...locationJob.status, running: false, processed: null, total: null, result: null };
    },
  );

  app.get(
    "/inaturalist/pending",
    { preValidation: requireAuth, schema: { response: replies(ObservationList) } },
    async (request) => {
      return listByStatus(request.user!.id, "pending");
    },
  );

  app.get(
    "/inaturalist/completed",
    { preValidation: requireAuth, schema: { response: replies(ObservationList) } },
    async (request) => {
      return listByStatus(request.user!.id, "completed");
    },
  );

  // Checks unfinished observations with iNaturalist and completes the ones the user has finished
  // there. The page calls it on open, on focus and now and then while To finish is showing; each
  // observation is asked about at most once per CHECK_EVERY_MS however often it's called.
  app.post(
    "/inaturalist/pending/check",
    {
      preValidation: requireAuth,
      schema: {
        // Leave out to check every unfinished observation; the selection's ids to check only those.
        body: Type.Optional(
          Type.Object(
            {
              observationIds: Type.Optional(
                Type.Array(Type.String({ pattern: "^[0-9]+$", maxLength: 20 }), { maxItems: 10000 }),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        response: replies(
          Open({
            checked: Type.Integer(),
            completed: Type.Integer(),
            notes: Type.Record(Type.String(), Type.String(), {
              description: "Why an observation isn't finished yet, by observation id",
            }),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const account = await requireAccount(userId);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      // A second window calling at once shares the run already going.
      const running = checksInFlight.get(userId);
      if (running) return running;
      void retryWaitingLocations(userId, account);
      const only = request.body?.observationIds ? new Set(request.body.observationIds) : null;
      const run = checkPending(userId, account, only).finally(() => checksInFlight.delete(userId));
      checksInFlight.set(userId, run);
      return run;
    },
  );

  // Photos the user doesn't want to send for now: left out of To send and Send all until restored,
  // or until sent on purpose (which clears the mark).
  app.post(
    "/inaturalist/ignore",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: 10000 }), ignored: Type.Boolean() },
          { additionalProperties: false },
        ),
        response: replies(Open({ updated: Type.Integer() })),
      },
    },
    async (request) => {
      const res = await pool.query(
        `UPDATE captures_all SET inat_ignored_at = CASE WHEN $3::boolean THEN now() END
         WHERE id = ANY($1::uuid[]) AND user_id = $2 AND (inat_ignored_at IS NULL) = $3::boolean`,
        [[...new Set(request.body.captureIds)], request.user!.id, request.body.ignored],
      );
      return { updated: res.rowCount ?? 0 };
    },
  );

  // Observations the user made on iNaturalist themselves: read, compared with their photos, and
  // linked when the picture clearly matches. Runs by itself after connecting and then daily.
  const FindStatus = Type.Object({
    ...jobStatusFields(
      Type.Object({
        read: Type.Integer({ description: "Observations read from iNaturalist this time" }),
        linked: Type.Integer({ description: "Photos linked to an observation" }),
        review: Type.Integer({ description: "Possible matches waiting for a yes or no" }),
        compared: Type.Boolean({ description: "Pictures were compared (the image model is downloaded)" }),
        linkedCaptureIds: Type.Array(Uuid(), { description: "The photos this check linked, for Undo" }),
      }),
    ),
    auto: Type.Boolean({ description: "Started by Lifer itself, so the page shows no progress for it" }),
  });
  app.post(
    "/inaturalist/existing",
    {
      preValidation: requireAuth,
      schema: {
        // auto: the page opening asks; it runs at most daily (or after a restart), quietly.
        body: Type.Optional(Type.Object({ auto: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const account = await requireAccount(userId);
      if (!account) return reply.code(409).send({ error: "iNaturalist account not connected" });
      if (request.body?.auto) {
        await autoFind(userId, account);
        return { ok: true };
      }
      if (!startFind(userId, account, false))
        return reply.code(409).send({ error: "Another account's check is running. Try again in a minute." });
      return { ok: true };
    },
  );
  app.get(
    "/inaturalist/existing/status",
    { preValidation: requireAuth, schema: { response: replies(FindStatus) } },
    async (request) => {
      const mine = findOwner === null || findOwner === request.user!.id;
      return mine
        ? findJob.status
        : { ...findJob.status, running: false, processed: null, total: null, result: null, auto: true };
    },
  );
  app.post(
    "/inaturalist/existing/cancel",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async (request) => {
      if (findOwner === request.user!.id) findJob.cancel();
      return { ok: true };
    },
  );

  const Evidence = Open({
    taxon: Type.Union([Type.Literal("same"), Type.Literal("finer"), Type.Literal("related")]),
    time: Type.Union([Type.Literal("close"), Type.Literal("sameDay")]),
    size: Nullable(Type.Union([Type.Literal("same"), Type.Literal("different")])),
    place: Nullable(Type.Literal("near")),
  });
  const MatchList = Open({
    running: Type.Boolean({ description: "A check is running; the list fills in when it ends" }),
    matches: Type.Array(
      Open({
        captureId: Uuid(),
        photoId: Nullable(Uuid()),
        speciesId: Uuid(),
        commonName: Nullable(Type.String()),
        scientificName: Type.String(),
        takenAt: Nullable(Type.String({ format: "date-time" })),
        observationId: Type.String(),
        observationUrl: Type.String(),
        /** The observation's first photo, shown through /inaturalist/observations/:id/photos/:photoId. */
        inatPhotoId: Nullable(Type.String()),
        observedOn: Nullable(Type.String()),
        likeness: Nullable(Type.Union([Type.Literal("same"), Type.Literal("probably")])),
        evidence: Evidence,
      }),
    ),
  });
  app.get(
    "/inaturalist/matches",
    { preValidation: requireAuth, schema: { response: replies(MatchList) } },
    async (request) => {
      const userId = request.user!.id;
      // Empty until a check has run since Lifer started; the page asks for one when it opens.
      const known = reviewByUser.get(userId) ?? [];
      return { running: findJob.status.running && findOwner === userId, matches: await describeMatches(userId, known) };
    },
  );
  const Pair = Type.Object(
    { captureId: Uuid(), observationId: Type.String({ pattern: "^[0-9]+$", maxLength: 20 }) },
    { additionalProperties: false },
  );
  app.post(
    "/inaturalist/matches/link",
    { preValidation: requireAuth, schema: { body: Pair, response: replies(Ok) } },
    async (request, reply) => {
      const userId = request.user!.id;
      const { captureId, observationId } = request.body;
      const ok = await pool.query(
        `SELECT 1 FROM captures c, inaturalist_remote_observations r
         WHERE c.id = $1 AND c.user_id = $2 AND r.user_id = $2 AND r.inat_observation_id = $3::bigint`,
        [captureId, userId, observationId],
      );
      if (!ok.rows[0]) return reply.code(404).send({ error: "That photo or observation isn't here any more" });
      const match = reviewByUser
        .get(userId)
        ?.find((m) => m.captureId === captureId && m.observationId === observationId);
      const linked = await linkFound([{ captureId, observationId }]);
      if (linked.length === 0) return reply.code(409).send({ error: "This photo is already on iNaturalist" });
      await finishFound(userId, observationId);
      if (match) rememberLinked(userId, [match]);
      dropFromReview(userId, (m) => m.captureId === captureId);
      return { ok: true };
    },
  );
  app.post(
    "/inaturalist/matches/dismiss",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            captureId: Uuid(),
            observationId: Type.String({ pattern: "^[0-9]+$", maxLength: 20 }),
            undo: Type.Optional(Type.Boolean({ description: "Undo a Not a match: suggest the pair again" })),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { captureId, observationId, undo } = request.body;
      const key = `${captureId}:${observationId}`;
      const dismissed = dismissedByUser.get(userId) ?? new Map<string, Match>();
      dismissedByUser.set(userId, dismissed);
      if (undo) {
        await pool.query(
          `DELETE FROM capture_inaturalist_not_matches n USING captures_all c
           WHERE c.id = n.capture_id AND c.user_id = $3 AND n.capture_id = $1 AND n.inat_observation_id = $2`,
          [captureId, observationId, userId],
        );
        // Back in the list as it was, whatever else changed meanwhile.
        const match = dismissed.get(key);
        dismissed.delete(key);
        const list = reviewByUser.get(userId) ?? [];
        if (match && !list.some((m) => `${m.captureId}:${m.observationId}` === key))
          reviewByUser.set(userId, [...list, match]);
        return { ok: true };
      }
      await pool.query(
        `INSERT INTO capture_inaturalist_not_matches (capture_id, inat_observation_id, kind)
         SELECT id, $2, 'not_match' FROM captures_all WHERE id = $1 AND user_id = $3
         ON CONFLICT (capture_id, inat_observation_id) DO UPDATE SET kind = 'not_match'`,
        [captureId, observationId, userId],
      );
      const match = reviewByUser.get(userId)?.find((m) => `${m.captureId}:${m.observationId}` === key);
      if (match) dismissed.set(key, match);
      dropFromReview(userId, (m) => m.captureId === captureId && m.observationId === observationId);
      return { ok: true };
    },
  );

  // Undoes links to observations found on iNaturalist (never ones Lifer sent): the Undo on a link's
  // toast, or Unlink on a Completed card. Restores only what the link wrote and the user hasn't
  // changed since, and offers the pair for review again.
  app.post(
    "/inaturalist/matches/unlink",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            captureIds: Type.Optional(Type.Array(Uuid(), { minItems: 1, maxItems: 10000 })),
            observationId: Type.Optional(Type.String({ pattern: "^[0-9]+$", maxLength: 20 })),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Open({
            unlinked: Type.Integer(),
            kept: Type.Integer({
              description: "Photos whose location, date, life stage or sex changed since, left as they are",
            }),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { captureIds, observationId } = request.body;
      if (!captureIds && !observationId) return reply.code(400).send({ error: "Say which photos to unlink" });
      const done = await unlinkFound(userId, { captureIds, observationId });
      // Back on the review list: as it was when linked, or worked out again (in the background).
      const known = linkedByUser.get(userId);
      const back = done.flatMap((d) => {
        const m = known?.get(d.captureId);
        known?.delete(d.captureId);
        return m && m.observationId === d.observationId ? [m] : [];
      });
      const list = reviewByUser.get(userId) ?? [];
      reviewByUser.set(userId, [...list.filter((m) => !back.some((b) => b.captureId === m.captureId)), ...back]);
      const missing = done.filter((d) => !back.some((b) => b.captureId === d.captureId));
      if (missing.length > 0)
        void findMatches(userId, {
          captureIds: missing.map((d) => d.captureId),
          observationIds: [...new Set(missing.map((d) => d.observationId))],
        })
          .then(({ review }) => {
            const now = reviewByUser.get(userId) ?? [];
            const keys = new Set(now.map((m) => `${m.captureId}:${m.observationId}`));
            reviewByUser.set(userId, [...now, ...review.filter((m) => !keys.has(`${m.captureId}:${m.observationId}`))]);
          })
          .catch((err) => log.warn(`[inaturalist] couldn't offer unlinked photos again: ${(err as Error).message}`));
      return { unlinked: done.length, kept: done.filter((d) => d.kept.length > 0).length };
    },
  );

  // An observation photo's preview, for the review cards: the app's own pages may only show
  // images from Lifer itself. Only photos of the user's own cached observations.
  app.get(
    "/inaturalist/observations/:observationId/photos/:photoId",
    {
      preValidation: requireAuth,
      schema: {
        params: Type.Object({
          observationId: Type.String({ pattern: "^[0-9]+$", maxLength: 20 }),
          photoId: Type.String({ pattern: "^[0-9]+$", maxLength: 20 }),
        }),
      },
    },
    async (request, reply) => {
      const [obs] = await loadObservations(request.user!.id, [request.params.observationId]);
      const url = previewUrl(obs?.photos.find((p) => p.id === request.params.photoId)?.url ?? null, "medium");
      if (!url) return reply.code(404).send({ error: "Not found" });
      try {
        const bytes = await fetchPreview(url);
        return reply.type("image/jpeg").header("Cache-Control", "private, max-age=86400").send(bytes);
      } catch {
        return reply.code(502).send({ error: "Couldn't load the photo from iNaturalist" });
      }
    },
  );
}

// ---- Existing observations ----

interface FindResult {
  read: number;
  linked: number;
  review: number;
  compared: boolean;
  linkedCaptureIds: string[];
}
const findJob = createJob<FindResult, { auto: boolean }>("inaturalist-find", { auto: false });
let findOwner: string | null = null;
// The latest possible matches per user, until the next check or a restart.
const reviewByUser = new Map<string, Match[]>();
// Not a match answers kept for Undo, until a restart.
const dismissedByUser = new Map<string, Map<string, Match>>();
// Linked matches by capture, so an Unlink puts the card back as it was (until a restart).
const linkedByUser = new Map<string, Map<string, Match>>();
function rememberLinked(userId: string, matches: Match[]): void {
  const map = linkedByUser.get(userId) ?? new Map<string, Match>();
  for (const m of matches) map.set(m.captureId, m);
  linkedByUser.set(userId, map);
}
const lastAutoTry = new Map<string, number>();
const AUTO_EVERY_MS = 24 * 60 * 60_000;

function dropFromReview(userId: string, gone: (m: Match) => boolean): void {
  const list = reviewByUser.get(userId);
  if (list)
    reviewByUser.set(
      userId,
      list.filter((m) => !gone(m)),
    );
}

/** Starts a check, or shows the running one's progress when the user asked. False when another
 *  account's check is running. */
function startFind(userId: string, account: { accessToken: string }, auto: boolean): boolean {
  if (findJob.status.running) {
    if (findOwner !== userId) return false;
    if (!auto) findJob.status.auto = false;
    return true;
  }
  findOwner = userId;
  findJob.start((ctx) => runFind(ctx, userId, account), { auto });
  return true;
}

/** After connecting, then at most daily (or once after a restart, which forgets the possible
 *  matches), while the app is in use. Quiet. */
async function autoFind(userId: string, account: { accessToken: string }): Promise<void> {
  if (Date.now() - (lastAutoTry.get(userId) ?? 0) < 60 * 60_000) return;
  lastAutoTry.set(userId, Date.now());
  const res = await pool.query<{ synced_at: Date | null }>(
    `SELECT observations_synced_at AS synced_at FROM user_inaturalist_accounts WHERE user_id = $1`,
    [userId],
  );
  const synced = res.rows[0]?.synced_at;
  const due = !synced || Date.now() - new Date(synced).getTime() > AUTO_EVERY_MS || !reviewByUser.has(userId);
  if (res.rows[0] && due) startFind(userId, account, true);
}

async function runFind(
  ctx: JobContext<FindResult, { auto: boolean }>,
  userId: string,
  account: { accessToken: string },
): Promise<FindResult> {
  const deps = { signal: ctx.signal };
  ctx.update({ phase: "reading", processed: 0, total: null });
  const read = await syncObservations(
    userId,
    account.accessToken,
    (p) => ctx.update({ phase: p.phase, processed: p.processed, total: p.total }),
    deps,
  );
  ctx.update({ phase: "comparing", processed: 0, total: null });
  const { links, review, compared } = await findMatches(
    userId,
    { onProgress: (p) => ctx.update({ processed: p.processed, total: p.total }) },
    deps,
  );
  ctx.throwIfCancelled();
  for (const id of await linkFound(links)) await finishFound(userId, id);
  rememberLinked(userId, links);
  reviewByUser.set(userId, review);
  return {
    read,
    linked: links.length,
    review: review.length,
    compared,
    linkedCaptureIds: links.map((l) => l.captureId),
  };
}

/** A found observation's place and day go to its photos by the same rules as a sent one. */
async function finishFound(userId: string, observationId: string): Promise<void> {
  const [obs] = await loadObservations(userId, [observationId]);
  if (!obs) return;
  await checkObservation(userId, null, observationId, {
    lat: obs.point?.lat ?? null,
    lon: obs.point?.lon ?? null,
    positionalAccuracyMeters: obs.accuracyM,
    observedOn: obs.observedOn,
  }).catch((err) => log.warn(`[inaturalist] couldn't finish found observation ${observationId}: ${err}`));
}

async function describeMatches(userId: string, list: Match[]) {
  if (list.length === 0) return [];
  const captures = await pool.query<{
    id: string;
    current_photo_id: string | null;
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    taken_at: Date | null;
  }>(
    `SELECT c.id, c.current_photo_id, c.species_id, s.common_name, s.scientific_name, c.taken_at
     FROM captures c JOIN species s ON s.id = c.species_id
     WHERE c.user_id = $1 AND c.id = ANY($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM capture_inaturalist_observations o WHERE o.capture_id = c.id)`,
    [userId, [...new Set(list.map((m) => m.captureId))]],
  );
  const byCapture = new Map(captures.rows.map((r) => [r.id, r]));
  const observations = new Map(
    (await loadObservations(userId, [...new Set(list.map((m) => m.observationId))])).map((o) => [o.id, o]),
  );
  return list.flatMap((m) => {
    const c = byCapture.get(m.captureId);
    const o = observations.get(m.observationId);
    if (!c || !o) return [];
    return [
      {
        captureId: m.captureId,
        photoId: c.current_photo_id,
        speciesId: c.species_id,
        commonName: c.common_name,
        scientificName: c.scientific_name,
        takenAt: c.taken_at ? new Date(c.taken_at).toISOString() : null,
        observationId: m.observationId,
        observationUrl: `https://www.inaturalist.org/observations/${m.observationId}`,
        inatPhotoId: o.photos[0]?.id ?? null,
        observedOn: o.wallClock ?? o.observedOn,
        likeness: likeness(m.similarity),
        evidence: m.evidence,
      },
    ];
  });
}

/** Before a new observation: whether these photos are already on iNaturalist. Asks iNaturalist
 *  for the user's observations of the species around those days (one request) and compares them.
 *  "linked" when they clearly are (and now linked), "unsure" when they may be, null otherwise. */
async function existingObservationFor(
  userId: string,
  account: { accessToken: string },
  captures: Array<{ id: string; taken_at: string | Date | null }>,
  taxonId: number,
): Promise<{ kind: "linked"; observationId: string } | { kind: "unsure" } | null> {
  const days = captures.flatMap((c) => (c.taken_at ? [new Date(c.taken_at).getTime()] : []));
  if (days.length === 0) return null;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  try {
    const acct = await pool.query<{ inat_user_id: string }>(
      `SELECT inat_user_id FROM user_inaturalist_accounts WHERE user_id = $1`,
      [userId],
    );
    if (!acct.rows[0]) return null;
    const jwt = await fetchJwt(account.accessToken);
    const found: string[] = [];
    await fetchObservationPages({
      inatUserId: acct.rows[0].inat_user_id,
      jwt,
      idAbove: 0,
      updatedSince: null,
      // A day either side, for photos whose zone was unknown.
      extra: {
        taxon_id: String(taxonId),
        d1: day(Math.min(...days) - 86_400_000),
        d2: day(Math.max(...days) + 86_400_000),
      },
      onPage: async (page) => {
        await storeObservations(userId, page);
        found.push(...page.map((o) => o.id));
      },
    });
    if (found.length === 0) return null;
    const { links, review } = await findMatches(userId, {
      captureIds: captures.map((c) => c.id),
      observationIds: found,
    });
    if (links.length > 0) {
      for (const id of await linkFound(links)) await finishFound(userId, id);
      rememberLinked(userId, links);
      return { kind: "linked", observationId: links[0].observationId };
    }
    if (review.length === 0) return null;
    const known = reviewByUser.get(userId) ?? [];
    const keys = new Set(known.map((m) => `${m.captureId}:${m.observationId}`));
    reviewByUser.set(userId, [...known, ...review.filter((m) => !keys.has(`${m.captureId}:${m.observationId}`))]);
    return { kind: "unsure" };
  } catch (err) {
    // Offline or iNaturalist busy: sending goes ahead as before.
    log.warn(`[inaturalist] couldn't check for an existing observation: ${(err as Error).message}`);
    return null;
  }
}

const CHECK_EVERY_MS = 30_000;
// Enough to finish a busy session's worth in one call without a long wait; the rest go next time.
const CHECK_BATCH = 20;
const lastChecked = new Map<string, { at: number; note: string | null }>();
const checksInFlight = new Map<
  string,
  Promise<{ checked: number; completed: number; notes: Record<string, string> }>
>();

async function checkPending(userId: string, account: { accessToken: string }, only: Set<string> | null = null) {
  const res = await pool.query<{ inat_observation_id: string }>(
    `SELECT DISTINCT o.inat_observation_id
     FROM capture_inaturalist_observations o
     JOIN captures c ON c.id = o.capture_id
     WHERE c.user_id = $1 AND o.status = 'pending' AND o.photo_sent`,
    [userId],
  );
  const now = Date.now();
  const ids = res.rows.map((r) => r.inat_observation_id);
  const due = ids
    .filter((id) => (!only || only.has(id)) && now - (lastChecked.get(id)?.at ?? 0) >= CHECK_EVERY_MS)
    .sort((x, y) => (lastChecked.get(x)?.at ?? 0) - (lastChecked.get(y)?.at ?? 0))
    .slice(0, CHECK_BATCH);
  let checked = 0;
  let completed = 0;
  if (due.length > 0) {
    const jwt = await fetchJwt(account.accessToken);
    for (const id of due) {
      let note: string | null;
      try {
        note = await checkObservation(userId, jwt, id);
      } catch (err) {
        log.warn(`[inaturalist] couldn't check observation ${id}: ${(err as Error).message}`);
        lastChecked.set(id, { at: Date.now(), note: "Couldn't reach iNaturalist. Lifer will try again." });
        // iNaturalist is likely down or rate limiting: stop rather than ask about every one.
        break;
      }
      checked += 1;
      if (note === null) {
        completed += 1;
        lastChecked.delete(id);
      } else lastChecked.set(id, { at: Date.now(), note });
    }
  }
  const notes: Record<string, string> = {};
  for (const id of ids) {
    const note = lastChecked.get(id)?.note;
    if (note) notes[id] = note;
  }
  return { checked, completed, notes };
}

const NEEDS_LOCATION = "Needs a location on iNaturalist.";
// Only asked about once there is a location: iNaturalist has one.
const NEEDS_DATE = "Needs a date on iNaturalist.";

/** Completes one observation if iNaturalist now has its location and date, copying a placed
 *  location onto photos that had none. Returns why it isn't finished yet, or null once it is. */
async function checkObservation(
  userId: string,
  jwt: string | null,
  observationId: string,
  /** Already read (a found observation, from the cache): no request needed. */
  known?: RemoteObservationLocation,
): Promise<string | null> {
  const rowsRes = await pool.query<{
    capture_id: string;
    submitted_lat: string | null;
    submitted_lon: string | null;
    submitted_positional_accuracy: string | null;
    has_date: boolean;
  }>(
    `SELECT o.capture_id, o.submitted_lat, o.submitted_lon, o.submitted_positional_accuracy,
            (c.taken_at IS NOT NULL) AS has_date
     FROM capture_inaturalist_observations o
     JOIN captures c ON c.id = o.capture_id
     WHERE o.inat_observation_id = $1 AND c.user_id = $2 AND o.status = 'pending'`,
    [observationId, userId],
  );
  if (rowsRes.rows.length === 0) return null;
  const remote = known ?? (await fetchObservationLocation(jwt!, observationId));
  const submitted = rowsRes.rows[0];
  if (remote.lat === null || remote.lon === null) return NEEDS_LOCATION;
  // Observations sent before Lifer stopped guessing carry a region-centre location (sent with a
  // 50 km accuracy); one still sitting there hasn't been placed yet.
  const sentGuess =
    submitted.submitted_positional_accuracy !== null && Number(submitted.submitted_positional_accuracy) >= 50_000;
  const stillGuess =
    sentGuess &&
    Math.abs(remote.lat - Number(submitted.submitted_lat)) < 1e-6 &&
    Math.abs(remote.lon - Number(submitted.submitted_lon)) < 1e-6;
  if (stillGuess) return "Still at the default location. Move the pin on iNaturalist.";
  const remoteTakenAt = observedOnToTakenAt(remote.observedOn);
  if (!remoteTakenAt && !rowsRes.rows.some((r) => r.has_date)) return NEEDS_DATE;

  // A pin that fits inside the photo's region leaves that region alone; a photo with none takes
  // the region the pin falls in.
  const here = await regionAt(remote.lat, remote.lon).catch(() => null);
  const ids = rowsRes.rows.map((r) => r.capture_id);
  const { placed, dated } = await withTransaction(async (client) => {
    // Found links remember what this writes, for Unlink (unlink.ts).
    const before = await snapshotFound(client, observationId, ids);
    // Photos without their own GPS, or with only a region, take the location the user placed on
    // iNaturalist. A camera's or typed pin is never overwritten.
    const updated = await client.query<{ id: string }>(
      `UPDATE captures_all SET lat = $1, lon = $2, location_source = 'inaturalist', location_accuracy_m = $3,
              region_id = COALESCE(region_id, $5::uuid)
       WHERE id = ANY($4) AND lat IS NULL AND lon IS NULL RETURNING id`,
      [
        remote.lat,
        remote.lon,
        remote.positionalAccuracyMeters,
        rowsRes.rows.map((r) => r.capture_id),
        here?.id ?? null,
      ],
    );
    // Photos with no date take the day added on iNaturalist; a recorded or typed date is never replaced.
    const datedRes = remoteTakenAt
      ? await client.query<{ id: string }>(
          `UPDATE captures_all SET taken_at = $1 WHERE id = ANY($2) AND taken_at IS NULL RETURNING id`,
          [remoteTakenAt, rowsRes.rows.map((r) => r.capture_id)],
        )
      : { rows: [] };
    const datedIds = datedRes.rows.map((r) => r.id);
    await client.query(
      `UPDATE capture_inaturalist_observations SET status = 'completed', confirmed_at = now(),
              date_from_inaturalist = (capture_id = ANY($2::uuid[]))
       WHERE inat_observation_id = $1`,
      [observationId, datedIds],
    );
    await recordFoundWrites(client, observationId, before);
    return { placed: updated.rows.map((r) => r.id), dated: datedIds };
  });
  // The pin and date go into the photos' sidecars like typed ones, in the background (exiftool is slow).
  const limit = createLimiter(4);
  const pinned = new Set(placed);
  for (const id of new Set([...placed, ...dated]))
    void limit(() => syncCaptureXmpSidecarsLogged(userId, id, pinned.has(id) ? { replaceGps: true } : undefined));
  if (here && placed.length > 0) queueRecheck(userId, placed);
  return null;
}

interface SendBatchResult {
  sent: number;
  linked: number;
  incomplete: number;
  skipped: number;
  failed: number;
  maybeOnInat: string[][];
  editUrl: string | null;
  error: string | null;
}
const sendJob = createJob<SendBatchResult>("inaturalist-send");
let sendOwner: string | null = null;

const locationJob = createJob<FlushResult>("inaturalist-location");
let locationOwner: string | null = null;

/** Sends the user's waiting locations in the background; true when that's now running for them. */
function startLocationJob(userId: string, account: { accessToken: string }): boolean {
  // Their run already going picks up what was just queued.
  if (locationJob.status.running) return locationOwner === userId;
  const started = locationJob.start((ctx) =>
    flushLocationUpdates(userId, account, {
      deps: { signal: ctx.signal },
      onProgress: (processed, total) => ctx.update({ processed, total }),
    }),
  );
  if (started) locationOwner = userId;
  return started;
}

// Waiting locations are retried with the To finish check, at most this often.
const LOCATION_RETRY_MS = 60_000;
const lastLocationRetry = new Map<string, number>();
async function retryWaitingLocations(userId: string, account: { accessToken: string }): Promise<void> {
  if (Date.now() - (lastLocationRetry.get(userId) ?? 0) < LOCATION_RETRY_MS) return;
  lastLocationRetry.set(userId, Date.now());
  try {
    const queue = await loadLocationQueue(userId);
    if (Object.values(queue).some((e) => e.state === "waiting")) startLocationJob(userId, account);
  } catch (err) {
    log.warn(`[inaturalist] couldn't retry waiting locations: ${(err as Error).message}`);
  }
}

/** Whether a photo can go to iNaturalist now: its species is matched there, and it isn't already
 *  there. `photoSent` is null for a photo never sent, false for one whose send stopped partway (it
 *  is finished on the observation it already has), true once its photo is up. */
// Lifer only sends photos: iNaturalist refuses video, and sound uploads aren't built.
const RECORDING_KINDS = ["video", "audio"];
export const NOT_RECORDING = `NOT EXISTS (SELECT 1 FROM photos rp WHERE rp.id = c.current_photo_id AND rp.kind IN ('video', 'audio'))`;

export function canSend(photoSent: boolean | null, taxonId: number | null, kind: string | null = null): boolean {
  return taxonId !== null && photoSent !== true && !RECORDING_KINDS.includes(kind ?? "");
}

async function runSendBatch(
  ctx: JobContext<SendBatchResult>,
  userId: string,
  account: { accessToken: string },
  captureIds: string[],
  groups: string[][] | null,
  ignoreExistingGuard = false,
): Promise<SendBatchResult> {
  const res = await pool.query<
    ClusterRow & {
      inat_taxon_id: number | null;
      linked: boolean | null;
      kind: string | null;
    }
  >(
    `SELECT c.id, c.species_id, c.taken_at, c.lat, c.lon, c.camera_model, c.lens, s.inat_taxon_id, o.photo_sent AS linked,
            p.kind
     FROM captures c
     JOIN species s ON s.id = c.species_id
     LEFT JOIN photos p ON p.id = c.current_photo_id
     LEFT JOIN capture_inaturalist_observations o ON o.capture_id = c.id
     WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2`,
    [captureIds, userId],
  );
  // A photo already on iNaturalist is skipped. One whose send stopped partway (linked, photo not sent)
  // is sent again: sendObservation finishes that observation instead of making a second.
  // Ignored photos sent on purpose go too: the To send tab's Send all never includes them.
  const sendable = res.rows.filter((r) => canSend(r.linked, r.inat_taxon_id, r.kind));
  const result: SendBatchResult = {
    sent: 0,
    linked: 0,
    incomplete: 0,
    skipped: captureIds.length - sendable.length,
    failed: 0,
    maybeOnInat: [],
    editUrl: null,
    error: null,
  };
  const ok = new Set(sendable.map((r) => r.id));
  const clusters = groups
    ? groups.map((g) => ({ captureIds: g.filter((id) => ok.has(id)) })).filter((g) => g.captureIds.length > 0)
    : clusterForImport(
        sendable.map((r) => ({ id: r.id, speciesId: r.species_id, takenAt: r.taken_at, ...clusterFields(r) })),
      );
  ctx.update({ phase: "observations", processed: 0, total: clusters.length });
  let lastEditUrl: string | null = null;
  for (const [i, cluster] of clusters.entries()) {
    ctx.throwIfCancelled();
    const outcome = await sendObservation(userId, account, cluster.captureIds, undefined, ignoreExistingGuard);
    if (!outcome.ok && outcome.code === "maybe_on_inaturalist") result.maybeOnInat.push(cluster.captureIds);
    else if (outcome.ok && outcome.value.linkedExisting) result.linked += 1;
    else if (outcome.ok) {
      result.sent += 1;
      if (outcome.value.needsLocation || outcome.value.needsDate) {
        result.incomplete += 1;
        lastEditUrl = outcome.value.editUrl;
      }
    } else {
      result.failed += 1;
      result.error ??= outcome.error;
    }
    ctx.update({ processed: i + 1 });
  }
  if (result.sent === 1 && result.incomplete === 1) result.editUrl = lastEditUrl;
  return result;
}

/** Where this capture's JPEG or PNG original is right now, or null (RAW only, or its drive is away). */
async function uploadableOriginalPath(captureId: string): Promise<string | null> {
  const res = await pool.query<{ ref: string; volume_id: string | null; volume_relative_path: string | null }>(
    `SELECT ref, volume_id, volume_relative_path FROM originals WHERE capture_id = $1 AND kind = 'jpeg' LIMIT 1`,
    [captureId],
  );
  if (!res.rows[0]) return null;
  const resolved = await resolveOriginalPath(res.rows[0]).catch(() => null);
  return resolved?.connected ? resolved.path : null;
}

type SendResult =
  | {
      ok: true;
      value: {
        observationId: string;
        editUrl: string;
        needsLocation: boolean;
        needsDate: boolean;
        linkedExisting: boolean;
      };
    }
  | { ok: false; status: 400 | 404 | 409 | 422 | 502; error: string; code?: "maybe_on_inaturalist" };

/** Creates one iNaturalist observation from photos of a single species, or finishes the unfinished
 *  one they already belong to. Only what the photos recorded is sent. */
async function sendObservation(
  userId: string,
  account: { accessToken: string },
  captureIds: string[],
  regionId: string | undefined,
  /** The user chose Send anyway. Nothing is remembered: the next send is checked again. */
  ignoreExistingGuard = false,
): Promise<SendResult> {
  const found = await pool.query<{
    id: string;
    species_id: string;
    taken_at: string | null;
    taken_at_zoned: boolean | null;
    lat: string | null;
    lon: string | null;
    inat_taxon_id: number | null;
    display_path: string | null;
    region_id: string | null;
    location_label: string | null;
    inat_observation_id: string | null;
    photo_sent: boolean | null;
    kind: string | null;
  }>(
    `SELECT c.id, c.species_id, c.taken_at, c.taken_at_zoned, c.lat, c.lon, s.inat_taxon_id, p.display_path, c.region_id,
                c.location_label, o.inat_observation_id, o.photo_sent, p.kind
         FROM captures c
         JOIN species s ON s.id = c.species_id
         LEFT JOIN photos p ON p.id = c.current_photo_id
         LEFT JOIN capture_inaturalist_observations o ON o.capture_id = c.id
         WHERE c.id = ANY($1) AND c.user_id = $2`,
    [captureIds, userId],
  );
  if (found.rows.length !== captureIds.length) {
    return { ok: false, status: 404, error: "One or more captures not found" };
  }
  // A video or sound in the sighting stays behind; its photos go.
  const capturesRes = { rows: found.rows.filter((r) => !RECORDING_KINDS.includes(r.kind ?? "")) };
  if (capturesRes.rows.length === 0) {
    return { ok: false, status: 422, error: "Only photos can be sent to iNaturalist" };
  }
  captureIds = capturesRes.rows.map((r) => r.id);
  if (new Set(capturesRes.rows.map((r) => r.species_id)).size > 1) {
    return { ok: false, status: 400, error: "An observation's photos must all be the same species" };
  }
  // A send that failed partway left its observation linked to these captures: finish that one.
  const unfinished = new Set(
    capturesRes.rows.flatMap((r) => (r.inat_observation_id && !r.photo_sent ? [r.inat_observation_id] : [])),
  );
  if (capturesRes.rows.some((r) => r.photo_sent && !unfinished.has(r.inat_observation_id!))) {
    return { ok: false, status: 409, error: "One or more of these photos is already on iNaturalist" };
  }
  if (unfinished.size > 1) {
    return { ok: false, status: 409, error: "These photos belong to different unfinished observations" };
  }
  const taxonId = capturesRes.rows[0].inat_taxon_id;
  if (!taxonId) return { ok: false, status: 422, error: "This species isn't matched to an iNaturalist taxon yet" };

  // Only what the photos recorded is sent; nothing is guessed. Most cameras have no GPS: then
  // the observation goes without coordinates (Casual on iNaturalist) and the user places it
  // with iNaturalist's map, and the To finish check copies that location back here.
  const withGps = capturesRes.rows.find((r) => r.lat !== null && r.lon !== null);
  const location = withGps ? { lat: Number(withGps.lat), lon: Number(withGps.lon) } : null;
  const dated = capturesRes.rows.find((r) => r.taken_at);
  const observedOn = dated ? observedOnString(dated.taken_at, dated.taken_at_zoned) : null;
  const labelled = capturesRes.rows.find((r) => r.location_label);
  const placeRegionId = regionId ?? capturesRes.rows.find((r) => r.region_id)?.region_id ?? null;
  const regionName = placeRegionId ? await regionPlaceName(placeRegionId) : null;
  const placeGuess =
    labelled?.location_label && regionName
      ? `${labelled.location_label}, ${regionName}`
      : (labelled?.location_label ?? regionName);
  const place = await placeForSend(userId, captureIds, withGps?.id ?? null, placeGuess, regionName);

  // Already on iNaturalist (added there by hand)? Link to it instead of making a second one.
  if (unfinished.size === 0 && !ignoreExistingGuard) {
    const existing = await existingObservationFor(userId, account, capturesRes.rows, taxonId);
    if (existing?.kind === "unsure")
      return {
        ok: false,
        status: 409,
        code: "maybe_on_inaturalist",
        error: "This looks like it may already be on iNaturalist.",
      };
    if (existing?.kind === "linked")
      return {
        ok: true,
        value: {
          observationId: existing.observationId,
          editUrl: `https://www.inaturalist.org/observations/${existing.observationId}/edit`,
          needsLocation: false,
          needsDate: false,
          linkedExisting: true,
        },
      };
  }

  try {
    const jwt = await fetchJwt(account.accessToken);
    const observationId =
      [...unfinished][0] ??
      (await createObservation(jwt, {
        taxonId,
        observedOn,
        location,
        ...place,
      }));
    // Linked before any photo goes up, so a retry after a failed upload reuses this observation.
    for (const capture of capturesRes.rows) {
      if (capture.inat_observation_id) continue;
      await pool.query(
        `INSERT INTO capture_inaturalist_observations
               (capture_id, inat_observation_id, submitted_lat, submitted_lon, submitted_positional_accuracy, photo_sent)
             VALUES ($1, $2, $3, $4, $5, false)`,
        [capture.id, observationId, location?.lat ?? null, location?.lon ?? null, place.positionalAccuracy],
      );
    }
    for (const capture of capturesRes.rows) {
      if (capture.photo_sent) continue;
      if (capture.display_path)
        await addObservationPhoto(jwt, observationId, capture.display_path, await uploadableOriginalPath(capture.id));
      await pool.query(`UPDATE capture_inaturalist_observations SET photo_sent = true WHERE capture_id = $1`, [
        capture.id,
      ]);
    }
    // Sending a photo on purpose takes it out of Ignored.
    await pool.query(
      `UPDATE captures_all SET inat_ignored_at = NULL WHERE id = ANY($1::uuid[]) AND inat_ignored_at IS NOT NULL`,
      [capturesRes.rows.map((r) => r.id)],
    );
    // With a location and a date there's nothing to finish on iNaturalist, and the photos already
    // carry that location, so it's complete as sent.
    if (location && observedOn) {
      await pool.query(
        `UPDATE capture_inaturalist_observations SET status = 'completed', confirmed_at = now()
         WHERE inat_observation_id = $1 AND status = 'pending'`,
        [observationId],
      );
    }
    return {
      ok: true,
      value: {
        observationId,
        editUrl: `https://www.inaturalist.org/observations/${observationId}/edit`,
        // No GPS was sent, so the location still has to be placed on iNaturalist.
        needsLocation: location === null,
        needsDate: observedOn === null,
        linkedExisting: false,
      },
    };
  } catch (err) {
    return { ok: false, status: 502, error: (err as Error).message };
  }
}

async function listByStatus(userId: string, status: "pending" | "completed") {
  const res = await pool.query<{
    inat_observation_id: string;
    species_id: string;
    scientific_name: string;
    common_name: string | null;
    current_photo_id: string | null;
    created_at: string;
    confirmed_at: string | null;
    photo_count: number;
    observed_at: string | null;
    latest_at: string | null;
    sent_location: boolean;
    date_from_inaturalist: boolean;
    found_on_inaturalist: boolean;
    photo_ids: string[] | null;
    taxon_class: string | null;
    location_label: string | null;
    region_name: string | null;
    point: string[] | null;
    inat_photo_id: string | null;
    capture_ids: string[];
  }>(
    // A 50 km accuracy marks the region-centre guess older sends used: not a real location.
    `SELECT latest.*,
       (SELECT r.data->'photos'->0->>'id' FROM inaturalist_remote_observations r
        WHERE r.user_id = $1 AND r.inat_observation_id = latest.inat_observation_id::bigint) AS inat_photo_id,
       (SELECT array_agg(c2.current_photo_id ORDER BY c2.taken_at NULLS LAST, c2.id)
          FILTER (WHERE c2.current_photo_id IS NOT NULL)
        FROM capture_inaturalist_observations o2
        JOIN captures c2 ON c2.id = o2.capture_id
        WHERE o2.inat_observation_id = latest.inat_observation_id) AS photo_ids,
       (SELECT array_agg(o3.capture_id ORDER BY o3.capture_id) FROM capture_inaturalist_observations o3
        WHERE o3.inat_observation_id = latest.inat_observation_id) AS capture_ids
     FROM (
       SELECT DISTINCT ON (o.inat_observation_id)
         o.inat_observation_id, s.id AS species_id, s.scientific_name, s.common_name, c.current_photo_id,
         o.created_at, o.confirmed_at,
         (count(*) OVER w)::int AS photo_count,
         min(c.taken_at) OVER w AS observed_at,
         max(c.taken_at) OVER w AS latest_at,
         -- A found observation's location is the photo's own when it had one before linking.
         bool_or(CASE WHEN o.source = 'inaturalist' THEN c.lat IS NOT NULL AND c.location_source IS NULL
                      ELSE o.submitted_lat IS NOT NULL AND COALESCE(o.submitted_positional_accuracy, 0) < 50000 END) OVER w
           AS sent_location,
         bool_or(o.source = 'inaturalist') OVER w AS found_on_inaturalist,
         bool_or(o.date_from_inaturalist) OVER w AS date_from_inaturalist,
         s.taxon_class,
         max(c.location_label) OVER w AS location_label,
         max(rg.name) OVER w AS region_name,
         -- One photo's own point, for a place when none is named or filed.
         max(CASE WHEN c.lat IS NOT NULL AND c.lon IS NOT NULL THEN ARRAY[c.lat, c.lon] END) OVER w AS point
       FROM capture_inaturalist_observations o
       JOIN captures c ON c.id = o.capture_id
       JOIN species s ON s.id = c.species_id
       LEFT JOIN regions rg ON rg.id = c.region_id
       WHERE c.user_id = $1 AND o.status = $2
         AND NOT EXISTS (
           SELECT 1 FROM capture_inaturalist_observations u
           WHERE u.inat_observation_id = o.inat_observation_id AND NOT u.photo_sent
         )
       WINDOW w AS (PARTITION BY o.inat_observation_id)
       ORDER BY o.inat_observation_id, o.created_at DESC
     ) latest
     ORDER BY COALESCE(latest.confirmed_at, latest.created_at) DESC`,
    [userId, status],
  );
  const queue = await loadLocationQueue(userId);
  const placeNames = await Promise.all(
    res.rows.map((r) =>
      placeLabel({
        label: r.location_label,
        region: r.region_name,
        lat: r.point?.[0] ?? null,
        lon: r.point?.[1] ?? null,
      }),
    ),
  );
  return {
    observations: res.rows.map((r, i) => ({
      observationId: r.inat_observation_id,
      speciesId: r.species_id,
      scientificName: r.scientific_name,
      commonName: r.common_name,
      currentPhotoId: r.current_photo_id,
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
      url: `https://www.inaturalist.org/observations/${r.inat_observation_id}`,
      editUrl: `https://www.inaturalist.org/observations/${r.inat_observation_id}/edit`,
      photoCount: r.photo_count,
      observedAt: r.observed_at,
      latestAt: r.latest_at,
      photoIds: r.photo_ids ?? [],
      sentLocation: r.sent_location,
      dateFromInat: r.date_from_inaturalist,
      foundOnInat: r.found_on_inaturalist,
      taxonClass: r.taxon_class,
      placeName: placeNames[i],
      inatPhotoId: r.inat_photo_id,
      captureIds: r.capture_ids,
      // Completed means iNaturalist had a location then; on To finish, a date note means it has one.
      noLocationOnInat:
        status === "pending" &&
        !r.sent_location &&
        !["sent", "conflict"].includes(queue[r.inat_observation_id]?.state ?? "") &&
        lastChecked.get(r.inat_observation_id)?.note !== NEEDS_DATE,
      locationUpdate: queue[r.inat_observation_id] ?? null,
    })),
  };
}
