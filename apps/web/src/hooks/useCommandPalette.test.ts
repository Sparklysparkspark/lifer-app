import { describe, expect, it } from "vitest";
import { isCommandPaletteShortcut } from "./useCommandPalette";

const key = (over: Partial<KeyboardEvent>) => ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("isCommandPaletteShortcut", () => {
  it("is Cmd+K on Mac", () => {
    expect(isCommandPaletteShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isCommandPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false);
  });
  it("is Ctrl+K elsewhere", () => {
    expect(isCommandPaletteShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isCommandPaletteShortcut(key({ metaKey: true }), false)).toBe(false);
  });
  it("ignores plain k and extra modifiers", () => {
    expect(isCommandPaletteShortcut(key({}), true)).toBe(false);
    expect(isCommandPaletteShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isCommandPaletteShortcut(key({ key: "K", metaKey: true }), true)).toBe(true);
  });
});
