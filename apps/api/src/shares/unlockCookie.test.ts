import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addUnlock, decodeUnlocks, hasUnlock, UNLOCK_TTL_MS } from "./unlockCookie.js";

const key = randomBytes(32);

describe("share unlock cookie", () => {
  it("keeps earlier unlocks when another share is unlocked", () => {
    const first = addUnlock(undefined, "share-a", 0, key).value;
    const second = addUnlock(first, "share-b", 1000, key).value;
    expect(hasUnlock(second, "share-a", 2000, key)).toBe(true);
    expect(hasUnlock(second, "share-b", 2000, key)).toBe(true);
    expect(hasUnlock(second, "share-c", 2000, key)).toBe(false);
  });

  it("expires each unlock on its own", () => {
    const first = addUnlock(undefined, "share-a", 0, key).value;
    const second = addUnlock(first, "share-b", 1000, key);
    expect(hasUnlock(second.value, "share-a", UNLOCK_TTL_MS + 1, key)).toBe(false);
    expect(hasUnlock(second.value, "share-b", UNLOCK_TTL_MS + 1, key)).toBe(true);
    expect(second.expiresAt).toBe(1000 + UNLOCK_TTL_MS);
  });

  it("rejects a tampered or foreign cookie", () => {
    const { value } = addUnlock(undefined, "share-a", 0, key);
    const [payload, sig] = value.split(".");
    const forged = Buffer.from(JSON.stringify([["share-z", Number.MAX_SAFE_INTEGER]])).toString("base64url");
    expect(hasUnlock(`${forged}.${sig}`, "share-z", 0, key)).toBe(false);
    expect(hasUnlock(`${payload}.${sig}`, "share-a", 0, randomBytes(32))).toBe(false);
    expect(decodeUnlocks("garbage", 0, key)).toEqual([]);
  });

  it("caps how many shares one cookie holds", () => {
    let value: string | undefined;
    for (let i = 0; i < 40; i++) value = addUnlock(value, `share-${i}`, i, key).value;
    const entries = decodeUnlocks(value, 100, key);
    expect(entries.length).toBe(25);
    expect(hasUnlock(value, "share-39", 100, key)).toBe(true);
    expect(hasUnlock(value, "share-0", 100, key)).toBe(false);
  });
});
