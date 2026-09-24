import { describe, expect, it } from "vitest";
import { isAllowedLocalHost } from "./hostCheck.js";

describe("isAllowedLocalHost", () => {
  it.each(["localhost:4310", "127.0.0.1:4310", "[::1]:4310", "LOCALHOST:4310"])("allows %s", (host) => {
    expect(isAllowedLocalHost(host, 4310)).toBe(true);
  });

  it.each([undefined, "", "evil.example:4310", "127.0.0.1:4000", "localhost", "127.0.0.1.evil.example:4310"])(
    "rejects %s",
    (host) => {
      expect(isAllowedLocalHost(host, 4310)).toBe(false);
    },
  );

  it("allows a bare hostname only on port 80", () => {
    expect(isAllowedLocalHost("localhost", 80)).toBe(true);
  });
});
