import type { CSSProperties } from "react";

// Styles an <img> inside an aspect-square, overflow-hidden box to show a square crop. x, y and
// size are percentages of the photo's width, so it works at any rendered size.
export function cropToImageStyle(x: number | null, y: number | null, size: number | null): CSSProperties {
  if (x == null || y == null || size == null) {
    return { objectFit: "cover", objectPosition: "50% 50%" };
  }
  return {
    position: "absolute",
    width: `${(100 * 100) / size}%`,
    height: "auto",
    left: `${(-100 * x) / size}%`,
    top: `${(-100 * y) / size}%`,
    maxWidth: "none",
  };
}
