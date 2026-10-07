import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies the correct password against its own hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword(hash, "correct-horse-battery-staple")).resolves.toBe(true);
  });

  it("rejects a wrong password against a real hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt), both still verifying correctly", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, "same-password")).resolves.toBe(true);
    await expect(verifyPassword(b, "same-password")).resolves.toBe(true);
  });

  it("stores Argon2id hashes", async () => {
    expect(await hashPassword("pw")).toMatch(/^\$argon2id\$/);
  });

  // An unknown user is checked against the dummy hash so the answer takes as long as a wrong
  // password. That only holds while it's a real hash made with the same cost as hashPassword's.
  it("keeps the dummy hash a valid hash with the same cost settings as real ones", async () => {
    const params = (h: string) => h.split("$").slice(1, 4).join("$");
    expect(params(DUMMY_PASSWORD_HASH)).toBe(params(await hashPassword("pw")));
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, "")).resolves.toBe(false);
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, "pw")).resolves.toBe(false);
  });
});
