// The View menu's species name choice (Main name + Also show), saved per user so an album's
// share page can show names the way its owner does. The browser keeps its own copy for instant
// changes; this one is for shares and for seeding a new browser.
import { Type, type Static } from "typebox";
import { pool } from "@lifer/core/db.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";

const ALSO_ORDER = ["other", "aba", "ebird"] as const;

export const SpeciesNameDisplay = Type.Object(
  {
    main: Type.Enum(["common", "scientific"]),
    also: Type.Array(Type.Enum([...ALSO_ORDER]), {
      uniqueItems: true,
      description: "Shown under the main name in this order; other is whichever of common/scientific isn't main",
    }),
  },
  { additionalProperties: false },
);
export type SpeciesNameDisplay = Static<typeof SpeciesNameDisplay>;

export const DEFAULT_SPECIES_NAME_DISPLAY: SpeciesNameDisplay = { main: "common", also: ["other"] };

// install_settings rather than a users column: one small value per account, no migration needed.
const key = (userId: string) => `species_name_display:${userId}`;

type Also = SpeciesNameDisplay["also"][number];
const isAlso = (v: unknown): v is Also => (ALSO_ORDER as readonly unknown[]).includes(v);

// Reads the current shape or the earlier {first, second} one; anything else is null.
function parse(value: unknown): SpeciesNameDisplay | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const main = o.main ?? o.first;
  if (main !== "common" && main !== "scientific") return null;
  const also = o.also;
  if (Array.isArray(also)) {
    return also.every(isAlso) ? { main, also: ALSO_ORDER.filter((k) => also.includes(k)) } : null;
  }
  if (o.second === "none") return { main, also: [] };
  return isAlso(o.second) ? { main, also: [o.second] } : null;
}

/** The user's saved choice, or null when they never set one (or it no longer parses). */
export async function getSpeciesNameDisplay(userId: string): Promise<SpeciesNameDisplay | null> {
  return parse(await getInstallSetting<unknown>(pool, key(userId)));
}

/** Saves the choice with `also` in display order, and returns what was saved. */
export async function setSpeciesNameDisplay(userId: string, value: SpeciesNameDisplay): Promise<SpeciesNameDisplay> {
  const saved = { main: value.main, also: ALSO_ORDER.filter((k) => value.also.includes(k)) };
  await setInstallSetting(pool, key(userId), saved);
  return saved;
}
