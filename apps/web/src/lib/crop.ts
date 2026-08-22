import type { CSSProperties } from "react";

// Renders a square crop rect (x, y, size — all fractions 0-100 of the photo's own width,
// see migration 006) as absolute-positioned <img> styles inside an aspect-square,
// overflow-hidden container. Scale-invariant: works regardless of the container's actual
// rendered pixel size, so the frontend never needs to know the photo's natural dimensions.
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
