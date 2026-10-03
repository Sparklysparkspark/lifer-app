// Turns a raw EPERM/EACCES into an actionable message. On macOS it's nearly always the OS's folder
// access consent (TCC) denying access, which is fixed in System Settings, not by reinstalling.
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
    return `That folder${where} doesn't exist or isn't reachable right now. Check it's still connected and try again.`;
  }
  return (err as Error)?.message ?? String(err);
}
