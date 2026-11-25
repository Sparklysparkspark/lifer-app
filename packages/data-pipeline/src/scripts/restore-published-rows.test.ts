import { describe, expect, it } from "vitest";
import { untarFile } from "./restore-published-rows.js";

// A minimal ustar entry: a 512-byte header (name, octal size) and the content padded to 512.
function entry(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(body.length.toString(8).padStart(11, "0"), 124);
  const content = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  content.write(body);
  return Buffer.concat([header, content]);
}

describe("untarFile", () => {
  it("finds one file among others and refuses a missing one", () => {
    const tar = Buffer.concat([
      entry("photos.json", "x".repeat(700)),
      entry("manifest.json", '{"a":1}'),
      Buffer.alloc(1024),
    ]);
    expect(untarFile(tar, "manifest.json")).toBe('{"a":1}');
    expect(() => untarFile(tar, "nope.json")).toThrow();
  });
});
