import type { FoundPlace } from "../components/PlacePicker";

/** "Prince George, British Columbia, Canada": a town, region or online result as one line. */
export function placeLine(p: FoundPlace): string {
  if (p.kind !== "online" && p.locality && p.kind !== "spot") return p.locality;
  const where = p.kind === "online" ? p.region : p.detail;
  return where ? `${p.name}, ${where}` : p.name;
}
