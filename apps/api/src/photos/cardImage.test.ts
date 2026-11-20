import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "lifer-card-"));
process.env.APP_DATA_DIR = dir;
const { cardImage } = await import("./routes.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cardImage", () => {
  it("cuts the crop's square at the asked size, and a new crop replaces the old file", async () => {
    const display = path.join(dir, "display.webp");
    // Left half red, right half blue, 400 x 200.
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#00f" } })
      .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: "#f00" } }, left: 0, top: 0 }])
      .webp({ lossless: true })
      .toFile(display);

    // x, y and size are percentages of the photo's width: the right half's square.
    const first = await cardImage("p1", display, 50, 0, 50, 160);
    expect(first).toBeTruthy();
    const meta = await sharp(first!).metadata();
    expect([meta.width, meta.height]).toEqual([160, 160]);
    const { dominant } = await sharp(first!).stats();
    expect(dominant.b).toBeGreaterThan(200);

    // Two card sizes of one crop live side by side.
    await cardImage("p1", display, 50, 0, 50, 320);
    expect(readdirSync(path.join(dir, "card")).filter((f) => f.startsWith("p1_"))).toHaveLength(2);

    await cardImage("p1", display, 0, 0, 50, 160);
    expect(readdirSync(path.join(dir, "card")).filter((f) => f.startsWith("p1_"))).toHaveLength(1);
  });
});
