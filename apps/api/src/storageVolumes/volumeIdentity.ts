// Resolves a folder to a stable OS volume identity, since a drive can remount under a different
// name or letter. Each platform finds a path's volume, reads its identifier, and lists mounted
// volumes (to spot a registered drive back at a new path).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface MountedVolume {
  mountPath: string;
  platformVolumeId: string;
}

// Async, so the subprocesses (diskutil, df, findmnt, powershell) don't block the event loop for
// every other request.
async function run(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args);
    return stdout;
  } catch {
    return null;
  }
}

// --- macOS -------------------------------------------------------------------------------
async function macMountPathFor(absolutePath: string): Promise<string> {
  // `df -P` resolves any path, however deep, to the mount point that contains it.
  const output = await run("df", ["-P", absolutePath]);
  return output ? parseDfMountPath(output) : "/";
}

// The mount path is everything after the capacity column, so "/Volumes/My Drive" survives
// intact (a plain whitespace split kept only "Drive").
export function parseDfMountPath(output: string): string {
  const lines = output.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const match = last.match(/\s\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/);
  return match?.[1].trim() || "/";
}

async function macVolumeId(mountPath: string): Promise<string | null> {
  const info = await run("diskutil", ["info", mountPath]);
  if (!info) return null;
  const match = info.match(/Volume UUID:\s*([0-9A-Fa-f-]+)/);
  return match ? match[1] : null;
}

async function macListMountedVolumes(): Promise<MountedVolume[]> {
  let names: string[] = [];
  try {
    names = readdirSync("/Volumes");
  } catch {
    // /Volumes should always exist on macOS; don't hard-fail if it doesn't.
  }
  const roots = ["/", ...names.map((name) => `/Volumes/${name}`)];
  // One independent `diskutil info` per root, run concurrently.
  const ids = await Promise.all(roots.map((mountPath) => macVolumeId(mountPath)));
  const seen = new Set<string>();
  const volumes: MountedVolume[] = [];
  roots.forEach((mountPath, i) => {
    const platformVolumeId = ids[i];
    if (platformVolumeId && !seen.has(platformVolumeId)) {
      seen.add(platformVolumeId);
      volumes.push({ mountPath, platformVolumeId });
    }
  });
  return volumes;
}

// --- Linux ---------------------------------------------------------------------------------
// `findmnt` resolves a path to its mount point and lists every mounted filesystem's UUID in one call.
async function linuxMountPathFor(absolutePath: string): Promise<string> {
  const output = await run("findmnt", ["-no", "TARGET", "--target", absolutePath]);
  return output?.trim() || "/";
}

async function linuxVolumeId(mountPath: string): Promise<string | null> {
  const output = await run("findmnt", ["-no", "UUID", "--target", mountPath]);
  const uuid = output?.trim();
  return uuid || null;
}

async function linuxListMountedVolumes(): Promise<MountedVolume[]> {
  // Raw, no header. Pseudo-filesystems (tmpfs, proc) report an empty UUID and are filtered out.
  const output = await run("findmnt", ["-rno", "TARGET,UUID"]);
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
// The drive letter root (e.g. "D:\") is the volume boundary. PowerShell's `Get-Volume` UniqueId
// is the stable per-volume identifier.
function windowsMountPathFor(absolutePath: string): string {
  const match = absolutePath.match(/^([A-Za-z]):[\\/]/);
  return match ? `${match[1].toUpperCase()}:\\` : absolutePath;
}

function windowsDriveLetter(mountPath: string): string | null {
  const match = mountPath.match(/^([A-Za-z]):/);
  return match ? match[1].toUpperCase() : null;
}

async function runPowerShell(command: string): Promise<string | null> {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", command]);
}

async function windowsVolumeId(mountPath: string): Promise<string | null> {
  const driveLetter = windowsDriveLetter(mountPath);
  if (!driveLetter) return null;
  const output = await runPowerShell(`(Get-Volume -DriveLetter ${driveLetter}).UniqueId`);
  return output?.trim() || null;
}

interface PowerShellVolume {
  DriveLetter?: string;
  UniqueId?: string;
}

async function windowsListMountedVolumes(): Promise<MountedVolume[]> {
  const output = await runPowerShell(
    "Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, UniqueId | ConvertTo-Json -Compress",
  );
  if (!output) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  // ConvertTo-Json emits a bare object, not a 1-element array, for a single result.
  const rows: PowerShellVolume[] = Array.isArray(parsed) ? parsed : [parsed as PowerShellVolume];
  return rows
    .filter((r): r is Required<PowerShellVolume> => Boolean(r.DriveLetter && r.UniqueId))
    .map((r) => ({ mountPath: `${r.DriveLetter.toUpperCase()}:\\`, platformVolumeId: r.UniqueId }));
}

// --- Dispatch --------------------------------------------------------------------------------
export async function mountPathFor(absolutePath: string): Promise<string> {
  if (process.platform === "win32") return windowsMountPathFor(absolutePath);
  if (process.platform === "darwin") return macMountPathFor(absolutePath);
  return linuxMountPathFor(absolutePath);
}

export async function getVolumeId(mountPath: string): Promise<string | null> {
  if (process.platform === "win32") return windowsVolumeId(mountPath);
  if (process.platform === "darwin") return macVolumeId(mountPath);
  if (process.platform === "linux") return linuxVolumeId(mountPath);
  return null;
}

export async function listMountedVolumes(): Promise<MountedVolume[]> {
  if (process.platform === "win32") return windowsListMountedVolumes();
  if (process.platform === "darwin") return macListMountedVolumes();
  if (process.platform === "linux") return linuxListMountedVolumes();
  return [];
}

// Rejects registering the drive the main storage is on, by comparing volume identity, which works
// on every OS.
export async function isSameVolumeAsDataDir(candidateMountPath: string, dataDir: string): Promise<boolean> {
  const dataDirMountPath = await mountPathFor(path.resolve(dataDir));
  const [dataDirVolumeId, candidateVolumeId] = await Promise.all([
    getVolumeId(dataDirMountPath),
    getVolumeId(candidateMountPath),
  ]);
  if (!dataDirVolumeId || !candidateVolumeId) return candidateMountPath === dataDirMountPath;
  return dataDirVolumeId === candidateVolumeId;
}
