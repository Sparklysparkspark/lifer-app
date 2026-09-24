import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(950)).toBe("950 B");
    expect(formatBytes(47_300_000)).toBe("47.3 MB");
    expect(formatBytes(312_000_000)).toBe("312 MB");
    expect(formatBytes(1_100_000_000)).toBe("1.1 GB");
    expect(formatBytes(2_000_000)).toBe("2 MB");
  });
});
