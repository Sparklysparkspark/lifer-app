// Encryption at rest for the few secrets Lifer must be able to read back: linked iNaturalist
// accounts' access and refresh tokens, and the owner's copy of each share link. AES-256-GCM with
// a key kept outside the database, in APP_DATA_DIR/secrets, so a copy of the database (a dump, a
// backup, a stolen volume) doesn't carry usable secrets.
//
// The key is made on first use: 32 random bytes in secrets/at-rest-key-v1, mode 0600 in a 0700
// folder (POSIX permissions; Windows ignores them and relies on the user profile's ACLs).
// Values look like "lifer-enc:v1:<base64url(iv | tag | ciphertext)>". The version names the key,
// so a new key can be introduced by bumping CURRENT_KEY_VERSION: new values use it, old ones still
// decrypt with their own key file and are re-encrypted as they're read (needsRewrap).
//
// Losing the key file (restoring the database without the app data folder) costs only what it
// protects: iNaturalist has to be linked again, and existing share links keep working but can't
// be shown again (they're found by their hash, not this copy).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_DATA_DIR } from "@lifer/core/config.js";

export const CURRENT_KEY_VERSION = 1;
const PREFIX = "lifer-enc:";
const VALUE_RE = /^lifer-enc:v(\d+):([A-Za-z0-9_-]+)$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A stored value that can't be decrypted: its key file is missing or different, or it was altered. */
export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnavailableError";
  }
}

export class SecretBox {
  private readonly keys = new Map<number, Buffer>();

  constructor(private readonly dir: string) {}

  private keyPath(version: number): string {
    return path.join(this.dir, `at-rest-key-v${version}`);
  }

  private readKey(version: number): Buffer | null {
    try {
      const key = Buffer.from(readFileSync(this.keyPath(version), "utf8").trim(), "base64");
      if (key.length !== 32) throw new SecretUnavailableError(`${this.keyPath(version)} isn't a 256-bit key`);
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private key(version: number, create: boolean): Buffer {
    const cached = this.keys.get(version);
    if (cached) return cached;
    let key = this.readKey(version);
    if (!key && create) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        // Not ours to change (a mounted folder); the file's own mode still applies.
      }
      try {
        // "wx": if two processes race to create it, the loser reads the winner's key.
        writeFileSync(this.keyPath(version), randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      key = this.readKey(version);
    }
    if (!key) throw new SecretUnavailableError(`No key file for v${version} in ${this.dir}`);
    this.keys.set(version, key);
    return key;
  }

  /** Encrypts with the current key. `context` is bound to the value (GCM associated data), so a
   *  value copied into a different column or purpose doesn't decrypt. */
  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key(CURRENT_KEY_VERSION, true), iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
    return `${PREFIX}v${CURRENT_KEY_VERSION}:${packed}`;
  }

  /** The plaintext of an encrypted value. Throws SecretUnavailableError when it can't be read. */
  decrypt(value: string, context: string): string {
    const match = VALUE_RE.exec(value);
    if (!match) throw new SecretUnavailableError("Not an encrypted value");
    const packed = Buffer.from(match[2], "base64url");
    if (packed.length < IV_BYTES + TAG_BYTES) throw new SecretUnavailableError("Encrypted value is truncated");
    const decipher = createDecipheriv("aes-256-gcm", this.key(Number(match[1]), false), packed.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretUnavailableError("Encrypted value doesn't match this server's key");
    }
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  /** True for a plaintext value or one under an older key: store encrypt(plaintext) instead. */
  needsRewrap(value: string): boolean {
    const match = VALUE_RE.exec(value);
    return !match || Number(match[1]) !== CURRENT_KEY_VERSION;
  }

  /** Reads a stored value that may still be plaintext from before encryption (or under an older
   *  key). Returns the plaintext and, when the stored form should be replaced, its new form. */
  open(stored: string, context: string): { plaintext: string; rewrapped: string | null } {
    const plaintext = this.isEncrypted(stored) ? this.decrypt(stored, context) : stored;
    return { plaintext, rewrapped: this.needsRewrap(stored) ? this.encrypt(plaintext, context) : null };
  }
}

/** The server's box: key files in APP_DATA_DIR/secrets. */
export const secretBox = new SecretBox(path.join(APP_DATA_DIR, "secrets"));

/** Contexts, one per kind of stored secret. */
export const SECRET_CONTEXT = {
  inatAccessToken: "inaturalist-access-token",
  inatRefreshToken: "inaturalist-refresh-token",
  shareLinkToken: "share-link-token",
} as const;
