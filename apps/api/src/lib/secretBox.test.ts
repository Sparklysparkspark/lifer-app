import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretBox, SecretUnavailableError } from "./secretBox.js";

describe("SecretBox", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "lifer-secretbox-"));
    dir = path.join(root, "secrets");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("round-trips a value, and never stores the plaintext", () => {
    const box = new SecretBox(dir);
    const stored = box.encrypt("inat-access-123", "ctx");
    expect(stored).toMatch(/^lifer-enc:v1:[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain("inat-access-123");
    expect(box.decrypt(stored, "ctx")).toBe("inat-access-123");
    // A fresh IV each time.
    expect(box.encrypt("inat-access-123", "ctx")).not.toBe(stored);
  });

  it("creates its key on first use, readable by the owner only, and reuses it", () => {
    const stored = new SecretBox(dir).encrypt("x", "ctx");
    const keyFile = path.join(dir, "at-rest-key-v1");
    expect(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    // Another process with the same folder reads the same key.
    expect(new SecretBox(dir).decrypt(stored, "ctx")).toBe("x");
  });

  it("refuses a value bound to another context, an altered value, or a lost key", () => {
    const box = new SecretBox(dir);
    const stored = box.encrypt("secret", "inaturalist-access-token");
    expect(() => box.decrypt(stored, "share-link-token")).toThrow(SecretUnavailableError);
    const altered = stored.slice(0, -2) + (stored.endsWith("A") ? "BB" : "AA");
    expect(() => box.decrypt(altered, "inaturalist-access-token")).toThrow(SecretUnavailableError);

    unlinkSync(path.join(dir, "at-rest-key-v1"));
    expect(() => new SecretBox(dir).decrypt(stored, "inaturalist-access-token")).toThrow(SecretUnavailableError);
    // A new key is made for new values; the old value stays unreadable rather than wrong.
    const box2 = new SecretBox(dir);
    expect(box2.decrypt(box2.encrypt("new", "c"), "c")).toBe("new");
    expect(() => box2.decrypt(stored, "inaturalist-access-token")).toThrow(SecretUnavailableError);
  });

  it("reads plaintext from before encryption and says to re-store it encrypted", () => {
    const box = new SecretBox(dir);
    const legacy = box.open("plain-token", "ctx");
    expect(legacy.plaintext).toBe("plain-token");
    expect(box.decrypt(legacy.rewrapped!, "ctx")).toBe("plain-token");
    const current = box.open(legacy.rewrapped!, "ctx");
    expect(current).toEqual({ plaintext: "plain-token", rewrapped: null });
  });

  it("decrypts a value under an older key version and re-encrypts it under the current one", () => {
    // Stand in for a v0 key from an earlier release.
    const box = new SecretBox(dir);
    box.encrypt("warm-up", "c");
    writeFileSync(path.join(dir, "at-rest-key-v0"), readFileSync(path.join(dir, "at-rest-key-v1")));
    const v0 = box.encrypt("old", "c").replace("lifer-enc:v1:", "lifer-enc:v0:");
    const opened = new SecretBox(dir).open(v0, "c");
    expect(opened.plaintext).toBe("old");
    expect(opened.rewrapped).toMatch(/^lifer-enc:v1:/);
  });
});
