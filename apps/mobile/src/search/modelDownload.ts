// Downloads the hub's text encoder for offline search. Files come in 2 MB ranges appended to a
// ".part" file, so a dropped connection or a closed app resumes where it stopped; each finished
// file is checked against the hub's SHA-256 before it is used. The files and the network are
// injected (modelFs.ts) so the rules run in plain tests.
import type { DownloadTarget } from "../media/cache";
import type { Db } from "../store/db";
import { deleteMeta, getMeta, setMeta } from "../store/meta";
import { settled } from "../sync/yield";

export const CHUNK_BYTES = 2 * 1024 * 1024;
const KEY = "smart.model";

export interface ManifestFile {
  name: string;
  size: number;
  sha256: string;
  url: string;
}
export interface Manifest {
  available: boolean;
  textModelVersion: string;
  imageModelVersion: string;
  dimension: number;
  files: ManifestFile[];
}

/** What is on the phone: the hub's text model version and the SHA-256 of each file verified so far. */
export interface ModelState {
  textModelVersion: string;
  files: Record<string, string>;
  complete: boolean;
}

export interface ModelFs {
  /** Makes the folder, outside backups. */
  prepare(): Promise<void>;
  size(name: string): Promise<number | null>;
  /** Fetches bytes from..to of the target and appends them to `name` (a from of 0 starts it afresh). Returns the HTTP status. */
  fetchRange(target: DownloadTarget, from: number, to: number, name: string): Promise<number>;
  sha256(name: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Removes the whole folder. */
  clear(): Promise<void>;
}

export interface ModelDeps {
  db: Db;
  fs: ModelFs;
  api: { get<T>(path: string, timeoutMs?: number): Promise<T>; target(path: string): DownloadTarget };
  /** Whether a download may run now (Wi-Fi only on a metered connection says no). */
  allowed: () => Promise<boolean>;
  onProgress?: (done: number, total: number) => void;
  stopped?: () => boolean;
}

export type ModelResult = "ready" | "unavailable" | "waiting" | "stopped";

export const loadModelState = (db: Db): Promise<ModelState | null> => getMeta<ModelState>(db, KEY);

export async function removeModel(db: Db, fs: ModelFs): Promise<void> {
  await fs.clear();
  await deleteMeta(db, KEY);
}

/** Bytes the downloaded model takes on the phone. */
export async function modelBytes(db: Db, fs: ModelFs): Promise<number> {
  const state = await loadModelState(db);
  let total = 0;
  for (const name of Object.keys(state?.files ?? {})) total += (await fs.size(name)) ?? 0;
  return total;
}

/** The hub's file paths come as "/api/...", and the target adds "/api" itself. */
const hubPath = (url: string): string => url.replace(/^\/api(?=\/)/, "");

/** Brings the text encoder up to date with the hub's manifest, downloading only what is missing or changed. */
export async function ensureModel(d: ModelDeps): Promise<ModelResult> {
  const manifest = await d.api.get<Manifest>("/companion/v1/model/text");
  if (!manifest.available || manifest.files.length === 0) return "unavailable";
  const saved = await loadModelState(d.db);
  const state: ModelState = {
    textModelVersion: manifest.textModelVersion,
    files: { ...saved?.files },
    complete: false,
  };
  await d.fs.prepare();

  // Files the manifest no longer lists, or lists with another hash, go; an unchanged one is kept across versions.
  const wanted = new Map(manifest.files.map((f) => [f.name, f]));
  for (const [name, sha] of Object.entries(state.files)) {
    if (wanted.get(name)?.sha256 !== sha || (await d.fs.size(name)) !== wanted.get(name)!.size) {
      delete state.files[name];
      await d.fs.remove(name);
    }
  }
  const todo = manifest.files.filter((f) => !state.files[f.name]);
  if (todo.length === 0) {
    await setMeta(d.db, KEY, { ...state, complete: true });
    return "ready";
  }
  if (!(await d.allowed())) return "waiting";

  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  let done = manifest.files.filter((f) => state.files[f.name]).reduce((n, f) => n + f.size, 0);
  d.onProgress?.(done, total);
  for (const file of todo) {
    const part = `${file.name}.part`;
    let have = (await d.fs.size(part)) ?? 0;
    if (have > file.size) {
      await d.fs.remove(part);
      have = 0;
    }
    done += have;
    while (have < file.size) {
      if (d.stopped?.()) return "stopped";
      if (!(await d.allowed())) return "waiting";
      await settled();
      const to = Math.min(have + CHUNK_BYTES, file.size) - 1;
      const status = await d.fs.fetchRange(d.api.target(hubPath(file.url)), have, to, part);
      if (status !== 206 && !(status === 200 && have === 0)) throw new Error(`model download answered ${status}`);
      const now = (await d.fs.size(part)) ?? 0;
      if (now <= have || now > file.size) {
        await d.fs.remove(part);
        throw new Error("model download did not make sense");
      }
      done += now - have;
      have = now;
      d.onProgress?.(done, total);
    }
    if ((await d.fs.sha256(part)) !== file.sha256) {
      await d.fs.remove(part);
      throw new Error(`${file.name} did not match the hub's checksum`);
    }
    await d.fs.remove(file.name);
    await d.fs.rename(part, file.name);
    state.files[file.name] = file.sha256;
    await setMeta(d.db, KEY, state);
  }
  await setMeta(d.db, KEY, { ...state, complete: true });
  return "ready";
}
