// Argon2id is @node-rs/argon2's default algorithm, matching lifer-spec.md §4/§8's requirement.
import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
