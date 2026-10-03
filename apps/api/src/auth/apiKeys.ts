import { randomBytes, createHash } from "node:crypto";

// A recognizable prefix makes a leaked key easy to spot in a log or config file.
const KEY_PREFIX = "lifer_";

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

// Plain SHA-256, not argon2: a 256-bit random token can't be brute-forced, and argon2's slowness
// would add latency to every API request.
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
