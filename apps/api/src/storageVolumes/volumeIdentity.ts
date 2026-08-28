// Resolves a folder path to a stable, OS-level volume identity — the mount path itself isn't
// stable enough to recognize "this is the same USB drive I registered before" across a
// disconnect/reconnect cycle (a drive can mount at a different name, or a different drive
// letter on Windows, next time it's plugged in). Every platform branch below follows the same
// shape: a way to find which mounted volume a given path belongs to, a way to get that volume's
// own stable identifier, and a way to list every volume currently mounted (for recognizing a
// registered drive that reconnected at a different path/letter than last time).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

export interface MountedVolume {
  mountPath: string;
  platformVolumeId: string;
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// --- macOS -------------------------------------------------------------------------------
function macMountPathFor(absolutePath: string): string {
  // `df -P` (POSIX-standard output format) resolves ANY path — nested arbitrarily deep,
  // anywhere in the filesystem, not just directly under /Volumes — to the real mount point
  // that contains it, without needing to guess based on the path's own shape.
  const output = run("df", ["-P", absolutePath]);
  if (!output) return "/";
  const lines = output.trim().split("\n");
  const columns = lines[lines.length - 1].trim().split(/\s+/);
  return columns[columns.length - 1] || "/";
}

function macVolumeId(mountPath: string): string | null {
  const info = run("diskutil", ["info", mountPath]);
  if (!info) return null;
  const match = info.match(/Volume UUID:\s*([0-9A-Fa-f-]+)/);
  return match ? match[1] : null;
}

function macListMountedVolumes(): MountedVolume[] {
  let names: string[] = [];
  try {
    names = readdirSync("/Volumes");
  } catch {
    // ignore — /Volumes should always exist on macOS, but don't hard-fail if it somehow doesn't
  }
  const roots = ["/", ...names.map((name) => `/Volumes/${name}`)];
  const seen = new Set<string>();
  const volumes: MountedVolume[] = [];
  for (const mountPath of roots) {
    const platformVolumeId = macVolumeId(mountPath);
    if (platformVolumeId && !seen.has(platformVolumeId)) {
      seen.add(platformVolumeId);
      volumes.push({ mountPath, platformVolumeId });
    }
  }
  return volumes;
}

// --- Linux ---------------------------------------------------------------------------------
// `findmnt` (util-linux, present on essentially every distro) resolves an arbitrary path to
// its containing mount point and can report every real mounted filesystem's UUID in one call
// — no path-guessing needed, unlike macOS's /Volumes convention.
function linuxMountPathFor(absolutePath: string): string {
  const output = run("findmnt", ["-no", "TARGET", "--target", absolutePath]);
  return output?.trim() || "/";
}

function linuxVolumeId(mountPath: string): string | null {
  const output = run("findmnt", ["-no", "UUID", "--target", mountPath]);
  const uuid = output?.trim();
  return uuid || null;
}

function linuxListMountedVolumes(): MountedVolume[] {
  // -r (raw, single-column-safe), -n (no header), TARGET+UUID columns; pseudo-filesystems
  // (tmpfs, proc, etc.) report an empty UUID and are filtered out below.
  const output = run("findmnt", ["-rno", "TARGET,UUID"]);
  if (!output) return [];
  const volumes: MountedVolume[] = [];
  for (const line of output.trim().split("\n")) {
    const spaceIndex = line.lastIndexOf(" ");
    if (spaceIndex === -1) continue;
    const mountPath = line.slice(0, spaceIndex).trim();
    const platformVolumeId = line.slice(spaceIndex + 1).trim();
    if (mountPath && platformVolumeId) volumes.push({ mountPath, platformVolumeId });
  }
  return volumes;
}

// --- Windows -------------------------------------------------------------------------------
// No POSIX-style unified mount tree — a drive letter root (e.g. "D:\") IS the volume boundary,
// so resolving a path to "its volume" is just reading off the drive letter, no filesystem call
// needed. PowerShell's `Get-Volume` UniqueId (a stable "\\?\Volume{guid}\" string) is the
// per-volume identifier, same role as macOS's Volume UUID / Linux's filesystem UUID.
function windowsMountPathFor(absolutePath: string): string {
  const match = absolutePath.match(/^([A-Za-z]):[\\/]/);
  return match ? `${match[1].toUpperCase()}:\\` : absolutePath;
}

function windowsDriveLetter(mountPath: string): string | null {
  const match = mountPath.match(/^([A-Za-z]):/);
  return match ? match[1].toUpperCase() : null;
}

function runPowerShell(command: string): string | null {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", command]);
}

function windowsVolumeId(mountPath: string): string | null {
  const driveLetter = windowsDriveLetter(mountPath);
  if (!driveLetter) return null;
  const output = runPowerShell(`(Get-Volume -DriveLetter ${driveLetter}).UniqueId`);
  return output?.trim() || null;
}

interface PowerShellVolume {
  DriveLetter?: string;
  UniqueId?: string;
}

function windowsListMountedVolumes(): MountedVolume[] {
  const output = runPowerShell(
    "Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, UniqueId | ConvertTo-Json -Compress",
  );
  if (!output) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  // PowerShell's ConvertTo-Json emits a bare object (not a 1-element array) when there's only
  // one result — normalize both shapes to an array before iterating.
  const rows: PowerShellVolume[] = Array.isArray(parsed) ? parsed : [parsed as PowerShellVolume];
  return rows
    .filter((r): r is Required<PowerShellVolume> => Boolean(r.DriveLetter && r.UniqueId))
    .map((r) => ({ mountPath: `${r.DriveLetter.toUpperCase()}:\\`, platformVolumeId: r.UniqueId }));
}

// --- Dispatch --------------------------------------------------------------------------------
export function mountPathFor(absolutePath: string): string {
  if (process.platform === "win32") return windowsMountPathFor(absolutePath);
  if (process.platform === "darwin") return macMountPathFor(absolutePath);
  return linuxMountPathFor(absolutePath);
}

export function getVolumeId(mountPath: string): string | null {
  if (process.platform === "win32") return windowsVolumeId(mountPath);
  if (process.platform === "darwin") return macVolumeId(mountPath);
  if (process.platform === "linux") return linuxVolumeId(mountPath);
  return null;
}

export function listMountedVolumes(): MountedVolume[] {
  if (process.platform === "win32") return windowsListMountedVolumes();
  if (process.platform === "darwin") return macListMountedVolumes();
  if (process.platform === "linux") return linuxListMountedVolumes();
  return [];
}

// Used by storageVolumes/routes.ts to reject "registering" the same drive Lifer's own primary
// storage already lives on — comparing volume IDENTITY (not a hardcoded "/" or "C:\" sentinel)
// is what makes this work the same way on every OS, including the case where DATA_DIR itself
// isn't on the conventional boot drive.
export function isSameVolumeAsDataDir(candidateMountPath: string, dataDir: string): boolean {
  const dataDirMountPath = mountPathFor(path.resolve(dataDir));
  const dataDirVolumeId = getVolumeId(dataDirMountPath);
  const candidateVolumeId = getVolumeId(candidateMountPath);
  if (!dataDirVolumeId || !candidateVolumeId) return candidateMountPath === dataDirMountPath;
  return dataDirVolumeId === candidateVolumeId;
}
