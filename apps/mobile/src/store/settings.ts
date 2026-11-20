import type { Db } from "./db";
import { getMeta, setMeta } from "./meta";

import type { AppearancePref } from "../theme/useTheme";

export type { AppearancePref };
export type Mode = "standalone" | "paired";

export interface Settings {
  appearance: AppearancePref;
  /** MR14: downloads of photos wait for Wi-Fi. Lifer data (marks, lists) is tiny and always syncs. */
  wifiOnly: boolean;
  /** Thumbnail cache cap in bytes (default 1 GB). */
  thumbCapBytes: number;
  /** Keep only the Favourites album in the showcase, not every species' cover photo. */
  showcaseFavouritesOnly: boolean;
  /** Which name leads on cards and rows. */
  nameOrder: "common" | "scientific";
  /** Smart search offline: the hub's text encoder and photo vectors kept on the phone. On until the person removes it. */
  smartSearch: boolean;
  /** The trip whose bar above the tab bar the person hid (it returns with the next trip). */
  hiddenTripBar: string | null;
  /** The Albums tab's last segment. */
  albumsSegment: "albums" | "trips";
}

export const GB = 1024 ** 3;
export const THUMB_CAPS = [250 * 1024 ** 2, 500 * 1024 ** 2, GB, 2 * GB, 4 * GB] as const;

export const DEFAULT_SETTINGS: Settings = {
  appearance: "system",
  wifiOnly: true,
  thumbCapBytes: GB,
  showcaseFavouritesOnly: false,
  nameOrder: "common",
  smartSearch: true,
  hiddenTripBar: null,
  albumsSegment: "albums",
};

export async function loadSettings(db: Db): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await getMeta<Partial<Settings>>(db, "settings")) ?? {}) };
}

export const saveSettings = (db: Db, s: Settings): Promise<void> => setMeta(db, "settings", s);

export const loadMode = (db: Db): Promise<Mode | null> => getMeta<Mode>(db, "mode");
export const saveMode = (db: Db, mode: Mode): Promise<void> => setMeta(db, "mode", mode);
