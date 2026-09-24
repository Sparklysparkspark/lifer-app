// Per-install key/value settings (migration 103). For state that belongs to the install, not to
// any one account, like which catalog seed version has been applied.
import type { Pool, PoolClient } from "pg";

export async function getInstallSetting<T>(db: Pool | PoolClient, key: string): Promise<T | null> {
  const res = await db.query<{ value: T }>(`SELECT value FROM install_settings WHERE key = $1`, [key]);
  return res.rows[0]?.value ?? null;
}

export async function setInstallSetting(db: Pool | PoolClient, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO install_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
