import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "lifer-hdr-"));
process.env.APP_DATA_DIR = dir;
const { hdrRender, HDR_SIDE } = await import("./fullRender.js");
type GainMapSharp = import("./fullRender.js").GainMapSharp;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("hdrRender", () => {
  it("keeps an Ultra HDR JPEG's gain map at display size, without the original's metadata", async () => {
    const source = path.join(dir, "hdr.jpg");
    await (sharp({ create: { width: HDR_SIDE + 200, height: 400, channels: 3, background: "#888" } }) as GainMapSharp)
      .withGainMap()
      .withExif({ IFD0: { Artist: "Someone" } })
      .jpeg()
      .toFile(source);
    const before = await sharp(source).metadata();
    expect(before.gainMap).toBeTruthy();
    expect(before.exif?.toString("latin1")).toContain("Someone");

    const made = await hdrRender("p1", source);
    const meta = await sharp(made!).metadata();
    expect(meta.gainMap).toBeTruthy();
    expect(meta.width).toBe(HDR_SIDE);
    expect(meta.exif?.toString("latin1") ?? "").not.toContain("Someone");
  });

  it("makes nothing for a plain JPEG", async () => {
    const source = path.join(dir, "plain.jpg");
    await sharp({ create: { width: 64, height: 48, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(source);
    expect(await hdrRender("p2", source)).toBeNull();
  });
});
