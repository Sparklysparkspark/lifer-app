// A thin, authenticated iNaturalist API v1 client for observation sync.
import path from "node:path";
import { stat } from "node:fs/promises";
import sharp from "sharp";
import { readCopyWithoutGps } from "../uploads/exif.js";
import { randomBytes, createHash } from "node:crypto";
import { USER_AGENT } from "@lifer/core/lib/http.js";

const INAT_API = "https://api.inaturalist.org/v1";
const INAT_SITE = "https://www.inaturalist.org";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;

/** A refusal from iNaturalist with its HTTP status: 401 means reconnect the account, not retry. */
export class InatHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InatHttpError";
  }
}

export interface NetDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("Cancelled"))), { once: true });
  });

/** A request that waits and retries while iNaturalist is busy (429, 5xx), honouring Retry-After. */
export async function politeFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  deps: NetDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => wait(ms, deps.signal));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, ...init.headers },
        signal: deps.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      lastError = err;
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (res) lastError = new Error(`iNaturalist answered ${res.status}`);
    const after = Number(res?.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("Couldn't reach iNaturalist");
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

// Authorization Code + PKCE (RFC 7636), no client secret: one embedded in open source isn't secret.
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// redirectUri is passed in because a server can override it from Settings (see resolveInatConfig).
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

export async function exchangeCodeForToken(
  clientId: string,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<InatTokenResponse> {
  const res = await fetch(`${INAT_SITE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

// Authenticated v1 endpoints want a JWT, exchanged fresh per use rather than cached. Callers
// should treat a 401 as "reconnect the account", not retry.
export async function fetchJwt(accessToken: string): Promise<string> {
  const res = await fetch(`${INAT_SITE}/users/api_token`, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new InatHttpError(`iNaturalist JWT exchange failed: ${res.status}`, res.status);
  const data = (await res.json()) as { api_token: string };
  return data.api_token;
}

export async function fetchInatIdentity(jwt: string): Promise<{ id: string; login: string }> {
  const res = await fetch(`${INAT_API}/users/me`, {
    headers: { Authorization: jwt, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`iNaturalist identity lookup failed: ${res.status}`);
  const data = (await res.json()) as { results: Array<{ id: number; login: string }> };
  const me = data.results[0];
  if (!me) throw new Error("iNaturalist identity lookup returned no user");
  return { id: String(me.id), login: me.login };
}

/** What Lifer sends: the date and coordinates only when the photos recorded them, never a guess.
 *  Without coordinates the observation stays Casual until the user places it on iNaturalist. */
export interface DraftObservation {
  taxonId: number;
  observedOn: string | null;
  location: { lat: number; lon: number } | null;
  // Free text shown on iNaturalist as the place, from the region the photos are filed under.
  placeGuess: string | null;
  /** From the saved spot the photos are filed under; left out (iNaturalist's open) otherwise. */
  geoprivacy?: string | null;
  /** Metres: a place's radius when the point came from one; left out for camera GPS. */
  positionalAccuracy?: number | null;
}

/** The observation fields iNaturalist receives. Unknown values are left out, not filled in. */
export function observationFields(draft: DraftObservation): Record<string, string | number> {
  const fields: Record<string, string | number> = { taxon_id: draft.taxonId };
  if (draft.observedOn) fields.observed_on_string = draft.observedOn;
  if (draft.location) {
    fields.latitude = draft.location.lat;
    fields.longitude = draft.location.lon;
  }
  if (draft.placeGuess) fields.place_guess = draft.placeGuess;
  if (draft.geoprivacy) fields.geoprivacy = draft.geoprivacy;
  if (draft.location && draft.positionalAccuracy) fields.positional_accuracy = draft.positionalAccuracy;
  return fields;
}

export async function createObservation(jwt: string, draft: DraftObservation): Promise<string> {
  const res = await fetch(`${INAT_API}/observations`, {
    method: "POST",
    headers: { Authorization: jwt, "Content-Type": "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ observation: observationFields(draft) }),
  });
  if (!res.ok) throw new Error(`iNaturalist observation creation failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: number };
  return String(data.id);
}

// iNaturalist takes JPEG, PNG and GIF (not the WebP the library keeps). The original goes up as it
// is, so identifiers and crops get full detail; past this size, or when it can't be read, the
// library's 2560 px copy goes instead.
// shortcut: 20 MB is a guess at what iNaturalist accepts; raise it once its real limit is known.
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const ORIGINAL_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

async function uploadFile(displayPath: string, originalPath: string | null) {
  const type = originalPath ? ORIGINAL_TYPES[path.extname(originalPath).toLowerCase()] : undefined;
  if (originalPath && type) {
    try {
      if ((await stat(originalPath)).size <= MAX_ORIGINAL_BYTES) {
        // The observation carries the location; the picture never carries exact GPS along.
        return { bytes: await readCopyWithoutGps(originalPath), type, name: path.basename(originalPath) };
      }
    } catch {
      // A drive that isn't connected, or an unreadable file: use the library copy.
    }
  }
  return { bytes: await sharp(displayPath).jpeg({ quality: 90 }).toBuffer(), type: "image/jpeg", name: "photo.jpg" };
}

export async function addObservationPhoto(
  jwt: string,
  observationId: string,
  displayPath: string,
  originalPath: string | null = null,
): Promise<void> {
  const file = await uploadFile(displayPath, originalPath);
  const form = new FormData();
  form.append("observation_photo[observation_id]", observationId);
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const res = await fetch(`${INAT_API}/observation_photos`, {
    method: "POST",
    headers: { Authorization: jwt, "User-Agent": USER_AGENT },
    body: form,
    // Photo upload: longer than the plain API calls.
    signal: AbortSignal.timeout(2 * 60_000),
  });
  if (!res.ok) throw new Error(`iNaturalist observation photo upload failed: ${res.status} ${await res.text()}`);
}

export interface RemoteObservationLocation {
  lat: number | null;
  lon: number | null;
  positionalAccuracyMeters: number | null;
  /** The date on the observation, as iNaturalist's YYYY-MM-DD, or null. */
  observedOn: string | null;
}

/** `deps` given: waits out a busy iNaturalist (politeFetch) instead of failing at once. */
export async function fetchObservationLocation(
  jwt: string,
  observationId: string,
  deps?: NetDeps,
): Promise<RemoteObservationLocation> {
  if (!/^\d+$/.test(observationId)) throw new Error("Not an iNaturalist observation id");
  const url = `${INAT_API}/observations/${observationId}`;
  const res = deps
    ? await politeFetch(url, { headers: { Authorization: jwt } }, deps)
    : await fetch(url, {
        headers: { Authorization: jwt, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
  if (!res.ok) throw new InatHttpError(`iNaturalist observation lookup failed: ${res.status}`, res.status);
  const data = (await res.json()) as {
    results: Array<{
      location?: string | null;
      private_location?: string | null;
      geojson?: { coordinates?: [number, number] } | null;
      positional_accuracy?: number | null;
      observed_on?: string | null;
    }>;
  };
  const obs = data.results[0];
  if (!obs) throw new Error("iNaturalist observation lookup returned no result");
  const point = observationPoint(obs);
  return {
    lat: point?.lat ?? null,
    lon: point?.lon ?? null,
    positionalAccuracyMeters: obs.positional_accuracy ?? null,
    observedOn: obs.observed_on ?? null,
  };
}

export interface LocationUpdate {
  lat: number;
  lon: number;
  /** Metres, when the point came from a place's radius. */
  positionalAccuracy: number | null;
  /** From the places the photos are filed under; left out keeps what iNaturalist has. */
  geoprivacy: string | null;
}

/** Moves an existing observation to a point. ignore_photos keeps its photos: an update that
 *  lists none would otherwise remove them. */
export async function updateObservationLocation(
  jwt: string,
  observationId: string,
  update: LocationUpdate,
  deps: NetDeps = {},
): Promise<void> {
  if (!/^\d+$/.test(observationId)) throw new Error("Not an iNaturalist observation id");
  const observation: Record<string, string | number> = { latitude: update.lat, longitude: update.lon };
  if (update.positionalAccuracy) observation.positional_accuracy = update.positionalAccuracy;
  if (update.geoprivacy) observation.geoprivacy = update.geoprivacy;
  const res = await politeFetch(
    `${INAT_API}/observations/${observationId}`,
    {
      method: "PUT",
      headers: { Authorization: jwt, "Content-Type": "application/json" },
      body: JSON.stringify({ ignore_photos: true, observation }),
    },
    deps,
  );
  if (!res.ok) throw new InatHttpError(`iNaturalist observation update failed: ${res.status}`, res.status);
}

/** Where the observation is. The API leaves `latitude` and `longitude` null here; the point is in
 *  `location` ("lat,lon") and `geojson`. The owner's own request also carries `private_location`,
 *  the true point of an obscured observation, which is the one a photo should take. */
export function observationPoint(obs: {
  location?: string | null;
  private_location?: string | null;
  geojson?: { coordinates?: [number, number] } | null;
}): { lat: number; lon: number } | null {
  for (const text of [obs.private_location, obs.location]) {
    const [lat, lon] = (text ?? "").split(",").map(Number);
    if (text && Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  const at = obs.geojson?.coordinates;
  return at && Number.isFinite(at[0]) && Number.isFinite(at[1]) ? { lat: at[1], lon: at[0] } : null;
}
