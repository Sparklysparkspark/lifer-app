import type { Db } from "./db";

export async function getMeta<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export const setMeta = (db: Db, key: string, value: unknown): Promise<void> =>
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
    key,
    JSON.stringify(value),
  ]);

export const deleteMeta = (db: Db, key: string): Promise<void> => db.run("DELETE FROM meta WHERE key = ?", [key]);
