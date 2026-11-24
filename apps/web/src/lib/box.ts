// Box math for BoxEditor: a free rectangle over a photo, as fractions of the upright photo.
/** [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];
export type Corner = "nw" | "ne" | "sw" | "se";

/** The smallest box, a share of each side: a far-off bird is only a few percent of the frame. */
export const MIN_BOX = 0.02;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Moves a box by dx, dy, kept whole inside the photo. */
export function moveBox(b: Box, dx: number, dy: number): Box {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const x = Math.min(Math.max(b[0] + dx, 0), 1 - w);
  const y = Math.min(Math.max(b[1] + dy, 0), 1 - h);
  return [x, y, x + w, y + h];
}

/** Drags one corner by dx, dy; the opposite corner stays, and the box keeps its minimum size. */
export function resizeBox(b: Box, corner: Corner, dx: number, dy: number): Box {
  let [x0, y0, x1, y1] = b;
  if (corner[1] === "w") x0 = Math.min(clamp01(x0 + dx), x1 - MIN_BOX);
  else x1 = Math.max(clamp01(x1 + dx), x0 + MIN_BOX);
  if (corner[0] === "n") y0 = Math.min(clamp01(y0 + dy), y1 - MIN_BOX);
  else y1 = Math.max(clamp01(y1 + dy), y0 + MIN_BOX);
  return [x0, y0, x1, y1];
}

/** The box between two points, at least the minimum size and inside the photo. */
export function boxBetween(ax: number, ay: number, bx: number, by: number): Box {
  const x0 = Math.min(clamp01(Math.min(ax, bx)), 1 - MIN_BOX);
  const y0 = Math.min(clamp01(Math.min(ay, by)), 1 - MIN_BOX);
  return [x0, y0, Math.max(clamp01(Math.max(ax, bx)), x0 + MIN_BOX), Math.max(clamp01(Math.max(ay, by)), y0 + MIN_BOX)];
}

export const placeBox = (b: Box) => ({
  left: `${b[0] * 100}%`,
  top: `${b[1] * 100}%`,
  width: `${(b[2] - b[0]) * 100}%`,
  height: `${(b[3] - b[1]) * 100}%`,
});
export const boxArea = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
export const insideBox = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
