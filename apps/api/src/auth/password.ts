// Argon2id is @node-rs/argon2's default algorithm.
import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

// Verified against when there's no real hash (unknown user, share without a password), so the
// response takes as long as a wrong password and can't reveal which case it was.
export const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
