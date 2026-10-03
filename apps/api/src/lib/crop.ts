// A card or cover crop in percent of the photo: x and y in [0, 100], size in (0, 100].
export function isValidCrop(x: unknown, y: unknown, size: unknown): boolean {
  return (
    typeof x === "number" && x >= 0 && x <= 100 &&
    typeof y === "number" && y >= 0 && y <= 100 &&
    typeof size === "number" && size > 0 && size <= 100
  );
}
