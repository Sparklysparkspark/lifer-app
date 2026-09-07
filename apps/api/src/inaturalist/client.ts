// Thin iNaturalist API v1 client for the observation-sync feature (see
// ~/.claude/plans/inaturalist-sync.md). Deliberately separate from species/lazyEnrich.ts's own
// iNaturalist calls: those are unauthenticated, read-only taxon/photo lookups running at bulk-
// import scale (hence that file's careful per-host pacing/retry machinery); everything here is
// authenticated, one-user-at-a-time, interactive-speed (a person clicking "Create Observation"
// once), so it doesn't need that same backoff apparatus — a plain fetch with error surfacing is
// the right amount of complexity for how this is actually used.
import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";

const INAT_API = "https://api.inaturalist.org/v1";
const INAT_SITE = "https://www.inaturalist.org";
const USER_AGENT = "lifer-app/0.1 (personal project; observation sync)";

export interface Pkce {
  verifier: string;
  challenge: string;
}

// Authorization Code + PKCE (RFC 7636) — no client_secret involved anywhere in this file. See
// config.ts's INAT_CLIENT_ID comment for why: Lifer is self-hostable/open-source-shaped, so a
// secret embedded in it wouldn't actually be secret.
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// redirectUri is passed in rather than imported from config.ts directly — a server-mode
// deployment can override it from Settings (its own registered app's real domain), which a
// static import couldn't reflect without a restart. See inaturalist/routes.ts's own
// resolveInatConfig for how the effective value gets picked.
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${INAT_SITE}/oauth/authorize?${params.toString()}`;
}

export interface InatTokenResponse {
  access_token: string;
  refresh_token: string | null;
}

export async function exchangeCodeForToken(clientId: string, redirectUri: string, code: string, verifier: string): Promise<InatTokenResponse> {
  const res = await fetch(`${INAT_SITE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`iNaturalist token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  return { access_token: data.access_token, refresh_token: data.refresh_token ?? null };
}

// The v1 API's authenticated endpoints want a JWT, not the raw OAuth access token directly —
// exchanged fresh per use rather than cached, since how long either token lasts is unconfirmed
// (see the plan doc's note on this); a 401 anywhere below should be treated by the caller as
// "reconnect the account," not retried blindly.
export async function fetchJwt(accessToken: string): Promise<string> {
  const res = await fetch(`${INAT_SITE}/users/api_token`, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`iNaturalist JWT exchange failed: ${res.status}`);
  const data = (await res.json()) as { api_token: string };
  return data.api_token;
}

export async function fetchInatIdentity(jwt: string): Promise<{ id: string; login: string }> {
  const res = await fetch(`${INAT_API}/users/me`, {
    headers: { Authorization: jwt, "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`iNaturalist identity lookup failed: ${res.status}`);
  const data = (await res.json()) as { results: Array<{ id: number; login: string }> };
  const me = data.results[0];
  if (!me) throw new Error("iNaturalist identity lookup returned no user");
  return { id: String(me.id), login: me.login };
}

export interface DraftObservation {
  taxonId: number;
  observedOn: string;
  lat: number;
  lon: number;
  positionalAccuracyMeters: number;
}

export async function createObservation(jwt: string, draft: DraftObservation): Promise<string> {
  const res = await fetch(`${INAT_API}/observations`, {
    method: "POST",
    headers: { Authorization: jwt, "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      observation: {
        taxon_id: draft.taxonId,
        observed_on_string: draft.observedOn,
        latitude: draft.lat,
        longitude: draft.lon,
        positional_accuracy: draft.positionalAccuracyMeters,
      },
    }),
  });
  if (!res.ok) throw new Error(`iNaturalist observation creation failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: number };
  return String(data.id);
}

export async function addObservationPhoto(jwt: string, observationId: string, displayPath: string): Promise<void> {
  const bytes = await readFile(displayPath);
  const form = new FormData();
  form.append("observation_photo[observation_id]", observationId);
  form.append("file", new Blob([bytes]), "photo.webp");
  const res = await fetch(`${INAT_API}/observation_photos`, {
    method: "POST",
    headers: { Authorization: jwt, "User-Agent": USER_AGENT },
    body: form,
  });
  if (!res.ok) throw new Error(`iNaturalist observation photo upload failed: ${res.status} ${await res.text()}`);
}

export interface RemoteObservationLocation {
  lat: number | null;
  lon: number | null;
  positionalAccuracyMeters: number | null;
}

export async function fetchObservationLocation(jwt: string, observationId: string): Promise<RemoteObservationLocation> {
  const res = await fetch(`${INAT_API}/observations/${observationId}`, {
    headers: { Authorization: jwt, "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`iNaturalist observation lookup failed: ${res.status}`);
  const data = (await res.json()) as {
    results: Array<{ latitude?: string | null; longitude?: string | null; positional_accuracy?: number | null }>;
  };
  const obs = data.results[0];
  if (!obs) throw new Error("iNaturalist observation lookup returned no result");
  return {
    lat: obs.latitude != null ? Number(obs.latitude) : null,
    lon: obs.longitude != null ? Number(obs.longitude) : null,
    positionalAccuracyMeters: obs.positional_accuracy ?? null,
  };
}
