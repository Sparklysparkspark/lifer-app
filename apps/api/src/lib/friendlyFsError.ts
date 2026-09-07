// A raw Node fs error (EPERM/EACCES) reads as a crash, not as "macOS needs you to grant folder
// access" — and on macOS specifically, EPERM here is almost never a real Unix permissions bug:
// it's TCC (the OS's own folder-access consent system for Desktop/Documents/Downloads/removable
// volumes) denying access, either because the user hasn't granted it yet or because it was
// silently denied by an app build that never declared the required Info.plist usage description
// (see apps/desktop/scripts/resign-macos.js's own comment on that gap). Either way, "reinstall
// the app" or "check the disk" are the wrong instructions — the fix is always the same System
// Settings panel.
export function friendlyFsErrorMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const path = (err as NodeJS.ErrnoException | undefined)?.path;
  if (code === "EPERM" || code === "EACCES") {
    const where = path ? ` (${path})` : "";
    return (
      `Lifer doesn't have permission to access this folder${where}. On a Mac, open System Settings → ` +
      `Privacy & Security → Files and Folders, find Lifer, and turn on access to the folder your ` +
      `photo library lives in (Desktop, Documents, Downloads, or an external drive), then try again.`
    );
  }
  if (code === "ENOENT") {
    const where = path ? ` (${path})` : "";
    return `That folder${where} doesn't exist or isn't reachable right now — check it's still connected and try again.`;
  }
  return (err as Error)?.message ?? String(err);
}
