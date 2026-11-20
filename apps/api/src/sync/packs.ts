// Keeps the offline packs of this desktop install and its linked server in step. Each install
// has its own pack rows and photo files, so a pack is "shared" by being downloaded on both: the
// packs only this computer has are started on the server (its own download from the pack store;
// photos it already has are skipped), and the packs only the server has are reported for the
// shell to offer, since downloading onto this computer is the user's call (disk space).
// shortcut: photos come from the pack store on both sides, not copied over the LAN; add a
// server-to-desktop photo copy if pack store bandwidth turns out to matter.
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { createJob } from "../lib/job.js";
import { linkedServer, serverFetch } from "./serverLink.js";

export interface PackOnServer {
  id: string;
  region?: string;
  seaZone?: string;
  taxon: string | null;
  sizeBytes: number;
  downloaded: boolean;
}

export interface PackDiff {
  /** Downloaded here, not on the server. */
  localOnly: string[];
  /** Downloaded on the server, not here. */
  serverOnly: PackOnServer[];
}

/** Which packs each side lacks. A ".small" install and the full pack count as the same pack. */
export function diffPacks(localIds: string[], server: PackOnServer[]): PackDiff {
  const base = (id: string) => id.replace(/\.small$/, "");
  const localBases = new Set(localIds.map(base));
  const serverBases = new Set(server.filter((p) => p.downloaded).map((p) => base(p.id)));
  return {
    localOnly: localIds.filter((id) => !serverBases.has(base(id))),
    serverOnly: server.filter((p) => p.downloaded && !localBases.has(base(p.id))),
  };
}

export interface PackSyncResult extends PackDiff {
  serverUrl: string;
  /** Packs the server was asked to download this run. */
  pushed: string[];
}

export const packSyncJob = createJob<PackSyncResult>("pack-sync");

async function run(): Promise<PackSyncResult> {
  const server = await linkedServer();
  if (!server) throw new Error("The linked server didn't answer");
  const local = await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs`);
  const res = await serverFetch(server, "/offline-packs/index");
  if (!res.ok) throw new Error(`The server's region list answered ${res.status}`);
  const remote = (await res.json()) as { packs: PackOnServer[] };
  const diff = diffPacks(
    local.rows.map((r) => r.pack_id),
    remote.packs,
  );
  let pushed: string[] = [];
  if (diff.localOnly.length > 0) {
    const started = await serverFetch(server, "/offline-packs/download", {
      method: "POST",
      body: JSON.stringify({ packIds: diff.localOnly }),
    });
    // 409: the server is already downloading something; these go next time.
    if (started.ok) pushed = diff.localOnly;
    else if (started.status !== 409) throw new Error(`The server refused the region download (${started.status})`);
  }
  log.info(`[sync] packs: ${pushed.length} started on the server, ${diff.serverOnly.length} only on the server`);
  return { ...diff, pushed, serverUrl: server.baseUrl };
}

/** Starts a reconcile unless one is running. */
export function startPackSync(): boolean {
  return packSyncJob.start(run);
}
