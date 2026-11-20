import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addObservationPhoto } from "./client.js";

afterEach(() => vi.unstubAllGlobals());

describe("addObservationPhoto", () => {
  it("uploads the library's WebP as a JPEG file part", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inat-upload-"));
    try {
      const file = path.join(dir, "display.webp");
      await sharp({ create: { width: 20, height: 10, channels: 3, background: "#4d6b4a" } })
        .webp()
        .toFile(file);
      let sent: FormData | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: FormData }) => {
          sent = init.body;
          return new Response("{}", { status: 200 });
        }),
      );
      await addObservationPhoto("jwt", "123", file);
      const part = sent?.get("file") as File;
      expect(part.type).toBe("image/jpeg");
      expect(part.name).toBe("photo.jpg");
      const bytes = new Uint8Array(await part.arrayBuffer());
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
      expect(sent?.get("observation_photo[observation_id]")).toBe("123");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads the original at full size with its GPS removed, leaving the file alone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inat-upload-"));
    const exiftool = new ExifTool();
    try {
      const display = path.join(dir, "display.webp");
      const original = path.join(dir, "IMG_0001.jpg");
      await sharp({ create: { width: 40, height: 30, channels: 3, background: "#925639" } })
        .webp()
        .toFile(display);
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "#925639" } })
        .jpeg()
        .toFile(original);
      await exiftool.write(
        original,
        { GPSLatitude: 49.2, GPSLongitude: -123.1, GPSLatitudeRef: "N", GPSLongitudeRef: "W" },
        {
          writeArgs: ["-overwrite_original"],
        },
      );
      let sent: FormData | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: FormData }) => {
          sent = init.body;
          return new Response("{}", { status: 200 });
        }),
      );
      await addObservationPhoto("jwt", "123", display, original);
      const part = sent?.get("file") as File;
      expect(part.name).toBe("IMG_0001.jpg");
      const uploaded = path.join(dir, "uploaded.jpg");
      await writeFile(uploaded, new Uint8Array(await part.arrayBuffer()));
      const tags = await exiftool.read(uploaded);
      expect([tags.ImageWidth, tags.ImageHeight]).toEqual([400, 300]);
      expect(tags.GPSLatitude).toBeUndefined();
      expect((await exiftool.read(original)).GPSLatitude).toBeCloseTo(49.2);
    } finally {
      await exiftool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the library copy when the original is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inat-upload-"));
    try {
      const display = path.join(dir, "display.webp");
      await sharp({ create: { width: 20, height: 10, channels: 3, background: "#4d6b4a" } })
        .webp()
        .toFile(display);
      let sent: FormData | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: FormData }) => {
          sent = init.body;
          return new Response("{}", { status: 200 });
        }),
      );
      await addObservationPhoto("jwt", "123", display, path.join(dir, "gone.jpg"));
      expect((sent?.get("file") as File).name).toBe("photo.jpg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
