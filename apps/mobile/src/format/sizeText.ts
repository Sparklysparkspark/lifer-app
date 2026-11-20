import type { TFunction } from "i18next";
import { formatBytes } from "./format";

const UNITS = { B: "units.B", KB: "units.KB", MB: "units.MB", GB: "units.GB" } as const;

/** "1.5 GB" in the app's language. */
export function sizeText(t: TFunction, n: number): string {
  const f = formatBytes(n);
  return `${f.value} ${t(UNITS[f.unit])}`;
}
