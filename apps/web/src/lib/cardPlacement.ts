// Where a hover card goes beside a map mark: inside the map with a margin, clear of the mark and,
// where there's room, of the map's own controls. Pure, so the geometry is tested on its own.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type CardSide = "below" | "above" | "right" | "left";

const GAP = 6;

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const inside = (a: Box, b: Box) =>
  a.left >= b.left && a.top >= b.top && a.left + a.width <= b.left + b.width && a.top + a.height <= b.top + b.height;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The card's box and the side of the mark it's on. Tries below, above, right, then left; each
 *  slides along the mark's side to fit. Prefers a spot clear of `obstacles`, then any spot inside
 *  the map, then the window-style fallback below the mark, kept inside the map as far as it goes. */
export function placeCard({
  area,
  mark,
  card,
  obstacles = [],
  margin = 8,
}: {
  /** The map's box on screen. */
  area: Box;
  /** The mark's centre and radius. */
  mark: { x: number; y: number; r: number };
  card: { width: number; height: number };
  /** Controls over the map: the 3D switch, the layers button, the credits. */
  obstacles?: Box[];
  margin?: number;
}): Box & { side: CardSide } {
  const room = {
    left: area.left + margin,
    top: area.top + margin,
    width: area.width - 2 * margin,
    height: area.height - 2 * margin,
  };
  const maxLeft = room.left + room.width - card.width;
  const maxTop = room.top + room.height - card.height;
  const reach = mark.r + GAP;
  const spots: Array<Box & { side: CardSide }> = [
    { side: "below" as CardSide, left: clamp(mark.x - card.width / 2, room.left, maxLeft), top: mark.y + reach },
    {
      side: "above" as CardSide,
      left: clamp(mark.x - card.width / 2, room.left, maxLeft),
      top: mark.y - reach - card.height,
    },
    { side: "right" as CardSide, left: mark.x + reach, top: clamp(mark.y - card.height / 2, room.top, maxTop) },
    {
      side: "left" as CardSide,
      left: mark.x - reach - card.width,
      top: clamp(mark.y - card.height / 2, room.top, maxTop),
    },
  ].map((s) => ({ ...s, width: card.width, height: card.height }));
  const fits = spots.filter((s) => inside(s, room));
  const clear = fits.find((s) => !obstacles.some((o) => overlaps(s, o)));
  const best = clear ?? fits[0];
  if (best) return best;
  // Bigger than the room on every side: below, pinned to the map's top-left corner of the room.
  return {
    ...spots[0],
    left: Math.max(room.left, spots[0].left),
    top: clamp(spots[0].top, room.top, Math.max(room.top, maxTop)),
  };
}
