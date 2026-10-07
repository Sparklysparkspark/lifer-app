// Makes the JPEGs the specs import: generated here rather than committed, so the repo holds
// no binary fixture and no third-party photo. The EXIF is what a camera would write.
import sharp from "sharp";

// Midday, so the calendar date reads the same in any time zone the server or browser runs in.
export const PHOTO_TAKEN = { exif: "2024:05:17 12:00:00", shown: "May 17, 2024" };

// `tint` changes the picture itself, so photos made for one spec never match another's by content
// (a trip scan skips a file whose content is already in the library). The defaults make the import
// spec's photo.
export async function makeCameraJpeg(
  filePath: string,
  { taken = PHOTO_TAKEN.exif, tint = 120 }: { taken?: string; tint?: number } = {},
): Promise<void> {
  // A gradient rather than a flat colour, so it has the detail a real photo's thumbnails would.
  const width = 800;
  const height = 600;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = (x * 255) / width;
      pixels[i + 1] = tint;
      pixels[i + 2] = (y * 255) / height;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .withExif({
      IFD0: { Make: "Lifer", Model: "E2E Test Camera" },
      IFD2: { DateTimeOriginal: taken },
    })
    .jpeg({ quality: 85 })
    .toFile(filePath);
}
