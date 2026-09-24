// One byte format for the whole app: decimal units (what macOS Finder and most download
// dialogs show), a space before the unit, and one decimal only while the number is small.
// 950 -> "950 B", 47_300_000 -> "47.3 MB", 312_000_000 -> "312 MB", 1_100_000_000 -> "1.1 GB".
const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${UNITS[unit]}`;
}
