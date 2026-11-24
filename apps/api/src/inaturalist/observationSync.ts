// Reads the connected user's own observations from iNaturalist, politely: one request a second
// (iNaturalist asks for about 60 a minute), backing off on 429 and 5xx, and resumable by id.
import { politeFetch, wait, type NetDeps } from "./client.js";
import { parseObservation, type RemoteObservation } from "./matching.js";

export type { NetDeps };
const INAT_API = "https://api.inaturalist.org/v1";
export const PAGE_SIZE = 200;
const GAP_MS = 1000;

/** A GET that waits and retries while iNaturalist is busy, honouring Retry-After. */
export const politeGet = (url: string, headers: Record<string, string>, deps: NetDeps = {}) =>
  politeFetch(url, { headers }, deps);

/** Every observation of the user with an id above `idAbove` (and changed since `updatedSince`),
 *  oldest id first, one page at a time to `onPage`. Returns how many were read. */
export async function fetchObservationPages(
  opts: {
    inatUserId: string;
    jwt: string | null;
    idAbove: number;
    updatedSince: string | null;
    /** Extra filters, e.g. taxon_id and d1/d2 for the check before sending. */
    extra?: Record<string, string>;
    onPage: (page: RemoteObservation[], progress: { read: number; total: number }) => Promise<void>;
  },
  deps: NetDeps = {},
): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => wait(ms, deps.signal));
  let idAbove = opts.idAbove;
  let read = 0;
  let total: number | null = null;
  for (;;) {
    const params = new URLSearchParams({
      user_id: opts.inatUserId,
      order_by: "id",
      order: "asc",
      per_page: String(PAGE_SIZE),
      id_above: String(idAbove),
      ...(opts.updatedSince ? { updated_since: opts.updatedSince } : {}),
      ...opts.extra,
    });
    // The owner's token adds what only they may see, such as an obscured observation's true point.
    const res = await politeGet(
      `${INAT_API}/observations?${params.toString()}`,
      opts.jwt ? { Authorization: opts.jwt } : {},
      deps,
    );
    if (!res.ok) throw new Error(`iNaturalist observation list failed: ${res.status}`);
    const data = (await res.json()) as { total_results?: number; results?: unknown[] };
    const results = data.results ?? [];
    total ??= data.total_results ?? results.length;
    const page = results.map(parseObservation).filter((o): o is RemoteObservation => o !== null);
    read += page.length;
    await opts.onPage(page, { read, total: Math.max(total, read) });
    if (results.length < PAGE_SIZE || page.length === 0) return read;
    idAbove = Number(page[page.length - 1].id);
    await sleep(GAP_MS);
  }
}

/** Ids of the user's observations deleted on iNaturalist since then (needs the owner's token). */
export async function fetchDeletedObservationIds(jwt: string, since: string, deps: NetDeps = {}): Promise<string[]> {
  const res = await politeGet(
    `${INAT_API}/observations/deleted?${new URLSearchParams({ since: since.slice(0, 10) })}`,
    { Authorization: jwt },
    deps,
  );
  if (!res.ok) throw new Error(`iNaturalist deleted list failed: ${res.status}`);
  const data = (await res.json()) as { results?: unknown[] };
  return (data.results ?? []).filter((id) => typeof id === "number").map(String);
}

/** A small preview of an observation photo (the "large" size, 1,024 px), as bytes. */
export async function fetchPreview(url: string, deps: NetDeps = {}): Promise<Buffer> {
  const res = await politeGet(url, {}, deps);
  if (!res.ok) throw new Error(`iNaturalist photo download failed: ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error("iNaturalist sent something that isn't a photo");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new Error("iNaturalist photo preview too large");
  return bytes;
}
