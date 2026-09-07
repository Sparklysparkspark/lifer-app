import { randomBytes, createHash } from "node:crypto";

// A recognizable prefix (same idea as GitHub/Stripe tokens) — makes a leaked key easy to grep
// for and to recognize at a glance in a log or a config file.
const KEY_PREFIX = "lifer_";

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

// Plain SHA-256, not argon2: the raw token already has 256 bits of real entropy (unlike a
// human-chosen password), so it's immune to offline brute-force regardless of hash speed, and
// this gets checked on every single API request — argon2's deliberate slowness would be a real,
// pointless latency cost here. Same reasoning GitHub/Stripe/Immich use for their own API tokens.
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
