import { DEFAULT_FOLDER_LAYOUT, FOLDER_LEVELS, type FolderLevel } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";

export interface UserFileSettings {
  /** The folder layout, outermost level first (packages/shared/src/folderLayout.ts). */
  layout: FolderLevel[];
  namingStyles: string[];
}

const KNOWN_LEVELS = new Set<string>(FOLDER_LEVELS);

// The per-user settings that decide where an original is filed and how its folder is named.
export async function getUserFileSettings(userId: string): Promise<UserFileSettings> {
  const res = await pool.query<{ folder_layout: string[] | null; species_naming_styles: string[] | null }>(
    `SELECT folder_layout, species_naming_styles FROM users WHERE id = $1`,
    [userId],
  );
  const row = res.rows[0];
  return {
    layout: (row?.folder_layout ?? [...DEFAULT_FOLDER_LAYOUT]).filter((l): l is FolderLevel => KNOWN_LEVELS.has(l)),
    namingStyles: row?.species_naming_styles ?? [],
  };
}
