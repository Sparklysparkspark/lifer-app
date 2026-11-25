// Network shares (SMB, NFS, AFP) holding library files. Lifer remembers which share each mount
// point came from, so when one isn't mounted it can name it and ask the OS to mount it again.
// Only the share's address is kept: passwords stay in the OS keychain, and mounting goes through
// the OS's own tools, which show their own sign-in dialog when they need one.
import { execFile } from "node:child_process";
import { readFile, readdir, access as fsAccess } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";

const execFileAsync = promisify(execFile);

export interface MountEntry {
  /** Where it's mounted: "/Volumes/home", "/mnt/nas", "Z:" or "\\host\share". */
  mountPath: string;
  /** smb://, nfs:// or afp:// address of a network share; null for a local disk. */
  url: string | null;
  /** False for a Windows mapping that's listed but disconnected. */
  mounted: boolean;
}

export type ShareStatus = "connected" | "not_connected" | "not_responding";

type Remembered = Record<string, { url: string }>;

const SETTING_KEY = "network_shares";
const MOUNTS_TTL_MS = 3000;
const ACCESS_TIMEOUT_MS = 3000;
// A share that didn't answer is skipped for a while: each hung check holds one of Node's few fs threads.
const NOT_RESPONDING_HOLD_MS = 30_000;
const CONNECT_TIMEOUT_MS = 120_000;

// No quotes, spaces or backslashes: the URL is handed to osascript, gio or net use.
const SHARE_URL = /^(smb|afp|nfs):\/\/(?:[A-Za-z0-9._~%-]+@)?[A-Za-z0-9._-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+$-]+)+$/;

export function isValidShareUrl(url: string): boolean {
  return SHARE_URL.test(url);
}

// --- Mount table parsers ------------------------------------------------------------------------

// macOS `mount`: "//jstarkey@truenas.local/media on /Volumes/media (smbfs, nodev, mounted by jstarkey)".
export function parseMacMount(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?) on (\/.*?) \(([a-z0-9]+)[,)]/.exec(line.trim());
    if (!m) continue;
    const [, source, mountPath, fsType] = m;
    entries.push({ mountPath, url: shareUrl(source, fsType), mounted: true });
  }
  return entries;
}

// Linux /proc/mounts: "//truenas/home /mnt/home cifs rw,..." with spaces escaped as \040.
export function parseLinuxMounts(procMounts: string): MountEntry[] {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const entries: MountEntry[] = [];
  for (const line of procMounts.split("\n")) {
    const [source, target, fsType] = line.trim().split(/\s+/);
    if (!source || !target || !fsType) continue;
    entries.push({ mountPath: unescape(target), url: shareUrl(unescape(source), fsType), mounted: true });
  }
  return entries;
}

// GNOME's `gio mount` puts a share at /run/user/<uid>/gvfs/smb-share:server=host,share=name.
export function gvfsShareUrl(dirName: string): string | null {
  const m = /^smb-share:(.*)$/.exec(dirName);
  if (!m) return null;
  const fields = Object.fromEntries(m[1].split(",").map((kv) => kv.split("=") as [string, string]));
  if (!fields.server || !fields.share) return null;
  return checked(`smb://${fields.user ? `${fields.user}@` : ""}${fields.server}/${fields.share}`);
}

// Windows `net use`: mapped drives ("OK  Z:  \\truenas\home  Microsoft Windows Network") and
// connections without a letter, which keep working by their \\host\share path.
export function parseWindowsNetUse(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)?\s+([A-Za-z]:)?\s*(\\\\[^\\\s]+\\[^\\\s]+)/.exec(line);
    if (!m) continue;
    const [, status, letter, unc] = m;
    const [host, share] = unc.slice(2).split("\\");
    entries.push({
      mountPath: letter ? letter.toUpperCase() : unc,
      url: checked(`smb://${host}/${share}`),
      mounted: status === "OK",
    });
  }
  return entries;
}

function checked(url: string): string | null {
  return isValidShareUrl(url) ? url : null;
}

function shareUrl(source: string, fsType: string): string | null {
  // "//user:password@host/share" never happens on macOS, but a password is never kept either way.
  const smb = /^\/\/(?:([^@:/]+)(?::[^@/]*)?@)?([^/]+)(\/.+)$/.exec(source);
  if (smb && /^(smbfs|cifs|smb3)$/.test(fsType))
    return checked(`smb://${smb[1] ? `${smb[1]}@` : ""}${smb[2]}${smb[3]}`);
  if (smb && fsType === "afpfs") return checked(`afp://${smb[1] ? `${smb[1]}@` : ""}${smb[2]}${smb[3]}`);
  const nfs = /^([^:/]+):(\/.*)$/.exec(source);
  if (nfs && /^nfs4?$/.test(fsType)) return checked(`nfs://${nfs[1]}${nfs[2]}`);
  return null;
}

/** The same share, whichever account mounted it. */
export function sameShare(a: string, b: string): boolean {
  const bare = (u: string) => u.replace(/^(\w+:\/\/)[^@/]*@/, "$1").toLowerCase();
  return bare(a) === bare(b);
}

const hostOf = (url: string) => /^\w+:\/\/(?:[^@/]*@)?([^/:]+)/.exec(url)?.[1].toLowerCase() ?? "";

// --- Reading the OS mount table -------------------------------------------------------------------

async function run(command: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync(command, args, { timeout: 10_000 })).stdout;
  } catch {
    return null;
  }
}

async function readMountTable(): Promise<MountEntry[]> {
  if (process.platform === "darwin") return parseMacMount((await run("/sbin/mount", [])) ?? "");
  if (process.platform === "win32") return parseWindowsNetUse((await run("net", ["use"])) ?? "");
  const entries = parseLinuxMounts(await readFile("/proc/mounts", "utf8").catch(() => ""));
  const gvfs = `/run/user/${process.getuid?.() ?? 0}/gvfs`;
  for (const name of await readdir(gvfs).catch(() => [] as string[])) {
    const url = gvfsShareUrl(name);
    if (url) entries.push({ mountPath: `${gvfs}/${name}`, url, mounted: true });
  }
  return entries;
}

let remembered: Remembered | null = null;
let mountCache: { at: number; list: Promise<MountEntry[]> } | null = null;

async function loadRemembered(): Promise<Remembered> {
  remembered ??= (await getInstallSetting<Remembered>(pool, SETTING_KEY)) ?? {};
  return remembered;
}

// Every network share seen mounted is remembered by its mount point, so a later "not mounted" can
// name its address. Only shares holding library files are ever offered for connecting.
async function learn(list: MountEntry[]): Promise<void> {
  const known = await loadRemembered();
  const next = { ...known };
  for (const m of list) {
    if (m.url && (!known[m.mountPath] || known[m.mountPath].url !== m.url)) next[m.mountPath] = { url: m.url };
  }
  if (Object.keys(next).length === Object.keys(known).length && Object.keys(next).every((k) => known[k] === next[k]))
    return;
  remembered = next;
  await setInstallSetting(pool, SETTING_KEY, next);
}

/** The OS mount table, shared by every caller for a few seconds; refreshing also learns new shares. */
export function currentMounts(force = false): Promise<MountEntry[]> {
  const now = Date.now();
  if (force || !mountCache || now - mountCache.at > MOUNTS_TTL_MS) {
    const list = readMountTable().then(async (entries) => {
      await learn(entries).catch((err) => log.warn({ err }, "[network-shares] couldn't remember shares"));
      return entries;
    });
    mountCache = { at: now, list };
  }
  return mountCache.list;
}

/** Loads what was learned before and reads the mount table once, so path remapping works from the start. */
export async function initNetworkShares(): Promise<void> {
  await loadRemembered();
  await currentMounts();
  lastMounts = await mountCache!.list;
}

// The last mount table read, for the synchronous remap below.
let lastMounts: MountEntry[] = [];

// --- Paths ----------------------------------------------------------------------------------------

function isUnder(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}\\`);
}

/** The share or drive root a path sits on: a remembered mount point, or /Volumes/<name> on macOS. */
export function shareRootOf(p: string): string | null {
  const keys = Object.keys(remembered ?? {}).filter((k) => isUnder(k, p));
  if (keys.length > 0) return keys.reduce((a, b) => (b.length > a.length ? b : a));
  return /^\/Volumes\/[^/]+/.exec(p)?.[0] ?? null;
}

export const nameOfRoot = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

/**
 * A path on a remembered share that's mounted somewhere else now (macOS picks /Volumes/home-1 when
 * a stale /Volumes/home folder is in the way), moved to where the share is. Synchronous, from the
 * last mount table read; anything unknown comes back unchanged.
 */
export function remapToMountedShare(p: string): string {
  if (!remembered || Object.keys(remembered).length === 0) return p;
  void currentMounts().then((list) => (lastMounts = list));
  const root = shareRootOf(p);
  const url = root ? remembered[root]?.url : undefined;
  if (!root || !url) return p;
  if (lastMounts.some((m) => m.mountPath === root && m.mounted && m.url && sameShare(m.url, url))) return p;
  const moved = lastMounts.find((m) => m.mounted && m.url && sameShare(m.url, url));
  return moved ? moved.mountPath + p.slice(root.length) : p;
}

const notRespondingUntil = new Map<string, number>();
// One probe of a share's root at a time, however many files are checked on it at once.
const rootProbes = new Map<string, Promise<"ok" | "missing" | "not_responding">>();

function timedAccess(
  p: string,
  access: (p: string) => Promise<unknown>,
  timeoutMs: number,
): Promise<"ok" | "missing" | "not_responding"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"not_responding">((resolve) => {
    timer = setTimeout(() => resolve("not_responding"), timeoutMs);
  });
  return Promise.race([
    access(p).then(
      () => "ok" as const,
      () => "missing" as const,
    ),
    timedOut,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Whether a file is there, without ever waiting long: a dead SMB connection can leave a stat
 * hanging for minutes, so a check that takes too long answers "not_responding". The share's root
 * is probed first, once for every concurrent caller, so a dead share ties up one of Node's few fs
 * threads instead of one per file.
 */
export async function checkFile(
  p: string,
  access: (p: string) => Promise<unknown> = fsAccess,
  timeoutMs = ACCESS_TIMEOUT_MS,
): Promise<"ok" | "missing" | "not_responding"> {
  const root = shareRootOf(p);
  if (root && root !== p) {
    if ((notRespondingUntil.get(root) ?? 0) > Date.now()) return "not_responding";
    let probe = rootProbes.get(root);
    if (!probe) {
      probe = timedAccess(root, access, timeoutMs).finally(() => rootProbes.delete(root));
      rootProbes.set(root, probe);
    }
    const rootState = await probe;
    if (rootState === "not_responding") {
      notRespondingUntil.set(root, Date.now() + NOT_RESPONDING_HOLD_MS);
      return "not_responding";
    }
    if (rootState === "missing") return "missing";
  }
  const state = await timedAccess(p, access, timeoutMs);
  if (root === p && state === "not_responding") notRespondingUntil.set(root, Date.now() + NOT_RESPONDING_HOLD_MS);
  return state;
}

export interface UnavailableShare {
  name: string;
  /** Set when Lifer knows the share's address, so it can connect it. */
  sharePath: string | null;
}

/** For a file that couldn't be reached: the share or drive it's on, when that isn't mounted. */
export async function unmountedShareOf(p: string): Promise<UnavailableShare | null> {
  const root = shareRootOf(p);
  if (!root) return null;
  const mounts = await currentMounts();
  const url = remembered?.[root]?.url;
  const mounted =
    process.platform === "win32"
      ? existsSync(`${root}\\`)
      : mounts.some((m) => m.mounted && (m.mountPath === root || (url && m.url && sameShare(m.url, url))));
  if (mounted) return null;
  return { name: nameOfRoot(root), sharePath: url ? root : null };
}

// --- Library locations and connecting ---------------------------------------------------------------

export interface LibraryLocation {
  mountPath: string;
  name: string;
  status: ShareStatus;
  connectable: boolean;
  /** Where the share is mounted now, when that isn't mountPath. */
  mountedAt: string | null;
  /** The server answers (another of its shares is mounted) but this share isn't open. */
  serverConnected: boolean;
}

/** Share and drive roots holding this user's originals: remembered shares, and /Volumes/<name> on macOS. */
async function libraryRoots(userId: string): Promise<string[]> {
  const keys = Object.keys(await loadRemembered());
  const res = await pool.query<{ root: string }>(
    `SELECT DISTINCT substring(ref from '^/Volumes/[^/]+') AS root FROM originals
       WHERE user_id = $1 AND ref LIKE '/Volumes/%'
     UNION
     SELECT k FROM unnest($2::text[]) AS k
       WHERE EXISTS (SELECT 1 FROM originals o WHERE o.user_id = $1
         AND (o.ref = k OR left(o.ref, length(k) + 1) IN (k || '/', k || E'\\\\')))
     EXCEPT
     SELECT last_known_mount_path FROM storage_volumes WHERE user_id = $1 AND kind = 'drive'`,
    [userId, keys],
  );
  return res.rows.map((r) => r.root).filter(Boolean);
}

async function locationStatus(root: string, mounts: MountEntry[]): Promise<LibraryLocation> {
  const url = remembered?.[root]?.url ?? null;
  const here = mounts.find((m) => m.mountPath === root && m.mounted);
  const elsewhere = url ? mounts.find((m) => m.mounted && m.url && sameShare(m.url, url)) : undefined;
  const mountedAt = here ? root : (elsewhere?.mountPath ?? null);
  let status: ShareStatus = "not_connected";
  // net use only lists network drives, so on Windows a local drive is checked by its folder.
  if (mountedAt || process.platform === "win32") {
    const check = await checkFile(mountedAt ?? `${root}\\`);
    status = check === "ok" ? "connected" : check === "not_responding" ? "not_responding" : "not_connected";
  }
  return {
    mountPath: root,
    name: nameOfRoot(root),
    status,
    connectable: url != null,
    mountedAt: mountedAt && mountedAt !== root ? mountedAt : null,
    serverConnected:
      status === "not_connected" &&
      url != null &&
      mounts.some((m) => m.mounted && m.url && hostOf(m.url) === hostOf(url)),
  };
}

export async function libraryLocations(userId: string, force = false): Promise<LibraryLocation[]> {
  const mounts = await currentMounts(force);
  const roots = await libraryRoots(userId);
  return Promise.all(roots.sort().map((root) => locationStatus(root, mounts)));
}

/** The OS command that mounts a share. Never a shell: every argument goes to the program as is. */
export function connectCommand(
  url: string,
  mountPath: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (!isValidShareUrl(url)) throw new Error("Not a share address Lifer can connect");
  if (platform === "darwin") return { command: "/usr/bin/osascript", args: ["-e", `mount volume "${url}"`] };
  if (platform === "win32") {
    const unc = `\\\\${url.replace(/^\w+:\/\/(?:[^@/]*@)?/, "").replace(/\//g, "\\")}`;
    return { command: "net", args: /^[A-Z]:$/.test(mountPath) ? ["use", mountPath, unc] : ["use", unc] };
  }
  return { command: "gio", args: ["mount", url] };
}

/**
 * Asks the OS to mount a share holding this user's library. Only a remembered share for one of the
 * user's library locations is accepted, never an address from the request.
 */
export async function connectShare(userId: string, mountPath: string): Promise<LibraryLocation | null> {
  const url = (await loadRemembered())[mountPath]?.url;
  if (!url || !(await libraryRoots(userId)).includes(mountPath)) return null;
  const { command, args } = connectCommand(url, mountPath);
  try {
    // Waits while the OS asks for a password; the request is the only thing waiting.
    await execFileAsync(command, args, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    log.info({ err, mountPath }, "[network-shares] connecting a share failed");
  }
  notRespondingUntil.delete(mountPath);
  const mounts = await currentMounts(true);
  lastMounts = mounts;
  return locationStatus(mountPath, mounts);
}
