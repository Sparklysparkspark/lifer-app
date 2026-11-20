// A trip import's per-file reason is shown to the user, so it's short and plain, never a
// decoder's or the OS's own text.
const RAW = /errno|ENOENT|EACCES|EPERM|EISDIR|sharp|vips|exiftool|\bat \S+:\d+/i;
const DAMAGED = /vips|corrupt|premature end|unsupported image format|input (file|buffer)|bad seek/i;

export function plainImportError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return "Lifer isn't allowed to open this file";
  if (code === "ENOENT") return "File not found";
  const message = (err as Error | undefined)?.message ?? "";
  if (DAMAGED.test(message)) return "This photo is damaged and can't be read";
  if (message && message.length < 160 && !RAW.test(message)) return message;
  return "Lifer couldn't import this file";
}
