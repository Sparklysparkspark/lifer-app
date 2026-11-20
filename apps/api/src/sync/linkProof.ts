// Proof that a server is the one a desktop app linked to. The instance id on /health is public, so
// on its own it would let any server that copies it collect the app's key. At link time the
// server gives the app a secret only it can recompute from the key's id (an HMAC under a key kept
// in install_settings), and later answers a nonce the app sends with the HMAC of that nonce under
// the secret. The app sends its key only to an address that proves it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getInstallSetting } from "../lib/installSettings.js";

type Db = Pick<Pool | PoolClient, "query">;
const SERVER_KEY = "link_proof_key";

async function serverKey(db: Db): Promise<string> {
  const existing = await getInstallSetting<string>(db as Pool, SERVER_KEY);
  if (existing) return existing;
  // Two first links at once keep whichever key landed first.
  await db.query(
    `INSERT INTO install_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO NOTHING`,
    [SERVER_KEY, JSON.stringify(randomBytes(32).toString("hex"))],
  );
  return (await getInstallSetting<string>(db as Pool, SERVER_KEY))!;
}

const hmac = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex");

/** The secret for one link (one key id), handed to the app once, when its key is made. */
export async function linkSecret(db: Db, keyId: string): Promise<string> {
  return hmac(await serverKey(db), `link:${keyId}`);
}

/** What the server answers to a nonce for a link. */
export const linkProof = (secret: string, nonce: string) => hmac(secret, `proof:${nonce}`);

/** Whether a proof is right, in constant time. */
export function proofMatches(secret: string, nonce: string, proof: string): boolean {
  const a = Buffer.from(linkProof(secret, nonce));
  const b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}
