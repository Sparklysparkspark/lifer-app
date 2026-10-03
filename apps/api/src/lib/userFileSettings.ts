import { pool } from "../db.js";

export interface UserFileSettings {
  organizeByYear: boolean;
  organizeByLocation: boolean;
  namingStyles: string[];
}

// The per-user settings that decide where an original is filed and how its folder is named.
export async function getUserFileSettings(userId: string): Promise<UserFileSettings> {
  const res = await pool.query<{
    organize_originals_by_year: boolean;
    organize_originals_by_location: boolean;
    species_naming_styles: string[] | null;
  }>(`SELECT organize_originals_by_year, organize_originals_by_location, species_naming_styles FROM users WHERE id = $1`, [userId]);
  const row = res.rows[0];
  return {
    organizeByYear: row?.organize_originals_by_year ?? false,
    organizeByLocation: row?.organize_originals_by_location ?? false,
    namingStyles: row?.species_naming_styles ?? [],
  };
}
