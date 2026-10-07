// Linked iNaturalist accounts. The access and refresh tokens are stored encrypted with the
// server's at-rest key (lib/secretBox.ts), never as plain text. Rows from before encryption are
// re-stored encrypted at startup (encryptStoredInatTokens) or on first read, whichever is first.
import type { Pool, PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { SECRET_CONTEXT, SecretUnavailableError, secretBox, type SecretBox } from "../lib/secretBox.js";

type Db = Pick<Pool | PoolClient, "query">;

export interface InatAccount {
  accessToken: string;
  inatUsername: string;
}

export async function saveInatAccount(
  account: {
    userId: string;
    accessToken: string;
    refreshToken: string | null;
    inatUserId: string;
    inatUsername: string;
  },
  db: Db = pool,
  box: SecretBox = secretBox,
): Promise<void> {
  await db.query(
    `INSERT INTO user_inaturalist_accounts (user_id, access_token, refresh_token, inat_user_id, inat_username)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       inat_user_id = EXCLUDED.inat_user_id,
       inat_username = EXCLUDED.inat_username,
       connected_at = now()`,
    [
      account.userId,
      box.encrypt(account.accessToken, SECRET_CONTEXT.inatAccessToken),
      account.refreshToken === null ? null : box.encrypt(account.refreshToken, SECRET_CONTEXT.inatRefreshToken),
      account.inatUserId,
      account.inatUsername,
    ],
  );
}

/** The user's linked account, or null when there's none or its tokens can't be decrypted (the key
 *  file was lost): then the account shows as not linked and linking again replaces the row. */
export async function loadInatAccount(
  userId: string,
  db: Db = pool,
  box: SecretBox = secretBox,
): Promise<InatAccount | null> {
  const res = await db.query<{ access_token: string; inat_username: string }>(
    `SELECT access_token, inat_username FROM user_inaturalist_accounts WHERE user_id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  try {
    const { plaintext, rewrapped } = box.open(row.access_token, SECRET_CONTEXT.inatAccessToken);
    if (rewrapped) {
      await db.query(
        `UPDATE user_inaturalist_accounts SET access_token = $2 WHERE user_id = $1 AND access_token = $3`,
        [userId, rewrapped, row.access_token],
      );
    }
    return { accessToken: plaintext, inatUsername: row.inat_username };
  } catch (err) {
    if (!(err instanceof SecretUnavailableError)) throw err;
    log.warn(
      "[inaturalist] The stored iNaturalist sign-in can't be decrypted (its key file is missing); link the account again",
    );
    return null;
  }
}

/** Re-stores any plain-text (or older-key) tokens encrypted. Returns how many rows changed. Rows
 *  whose tokens can't be decrypted are left alone. */
export async function encryptStoredInatTokens(db: Db = pool, box: SecretBox = secretBox): Promise<number> {
  const res = await db.query<{ user_id: string; access_token: string; refresh_token: string | null }>(
    `SELECT user_id, access_token, refresh_token FROM user_inaturalist_accounts`,
  );
  let changed = 0;
  for (const row of res.rows) {
    try {
      const access = box.open(row.access_token, SECRET_CONTEXT.inatAccessToken);
      const refresh = row.refresh_token === null ? null : box.open(row.refresh_token, SECRET_CONTEXT.inatRefreshToken);
      if (!access.rewrapped && !refresh?.rewrapped) continue;
      await db.query(`UPDATE user_inaturalist_accounts SET access_token = $2, refresh_token = $3 WHERE user_id = $1`, [
        row.user_id,
        access.rewrapped ?? row.access_token,
        refresh ? (refresh.rewrapped ?? row.refresh_token) : null,
      ]);
      changed++;
    } catch (err) {
      if (!(err instanceof SecretUnavailableError)) throw err;
    }
  }
  return changed;
}
