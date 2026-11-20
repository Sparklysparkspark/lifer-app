// A paired phone is an ordinary api_keys row: its name carries the device name and platform
// ("Sam's iPhone (ios)"), its permissions carry DEVICE_KEY_SCOPES, so no table of its own.
import type { Pool } from "pg";
import { DEVICE_PLATFORMS, type DevicePlatform } from "@lifer/shared";
import { DEVICE_KEY_SCOPES } from "../auth/apiKeyRoutes.js";
import { generateApiKey, hashApiKey } from "../auth/apiKeys.js";

const MAX_NAME = 100;
const NAME_PATTERN = new RegExp(`^(.*) \\((${DEVICE_PLATFORMS.join("|")})\\)$`);

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Makes a key for a phone. The raw token is returned once; only its hash is stored. */
export async function createDeviceKey(
  pool: Pool,
  userId: string,
  name: string,
  platform: DevicePlatform,
): Promise<{ id: string; token: string }> {
  const token = generateApiKey();
  const label = `${name.trim().slice(0, MAX_NAME) || "Phone"} (${platform})`;
  const res = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, label, hashApiKey(token), [...DEVICE_KEY_SCOPES]],
  );
  return { id: res.rows[0].id, token };
}

export async function listDevices(pool: Pool, userId: string): Promise<Device[]> {
  const res = await pool.query(
    `SELECT id, name, last_used_at, created_at FROM api_keys
     WHERE user_id = $1 AND 'companion' = ANY(permissions) ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map((r) => {
    const m = NAME_PATTERN.exec(r.name);
    return {
      id: r.id,
      name: m ? m[1] : r.name,
      platform: m ? (m[2] as DevicePlatform) : null,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    };
  });
}

/** Only a phone's key can be removed here; false when there is none by that id for this user. */
export async function revokeDevice(pool: Pool, userId: string, id: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM api_keys WHERE id = $1 AND user_id = $2 AND 'companion' = ANY(permissions)`,
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}
