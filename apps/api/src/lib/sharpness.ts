// Variance of the Laplacian — a well-known, cheap sharpness proxy: a blurry image has smoothly
// varying pixel values (low-variance edge response), a sharp one has strong, varied edges (high
// variance). Deliberately simple (no ML model) since this only needs to RANK a handful of
// near-duplicate frames from the same burst against each other, not produce an absolute quality
// score — resized down first since sharpness ranking among burst-mates doesn't need full
// resolution, and it keeps this fast enough to run over a whole sequence on demand.
import sharp from "sharp";

const ANALYSIS_WIDTH = 400;

export async function computeSharpness(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer)
    .resize(ANALYSIS_WIDTH, null, { withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  // 3x3 Laplacian kernel (4-connected): center*4 minus its 4 neighbors. Skips the 1px border.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const center = data[idx];
      const up = data[idx - width];
      const down = data[idx + width];
      const left = data[idx - 1];
      const right = data[idx + 1];
      const laplacian = center * 4 - up - down - left - right;
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}
