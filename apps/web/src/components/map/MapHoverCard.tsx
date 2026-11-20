import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import { formatNumber } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import type { GalleryItem } from "../../pages/gallery/types";
import Button from "../Button";
import ProgressiveImg from "../ProgressiveImg";
import { PointCard } from "../Tooltip";
import type { Box } from "../../lib/cardPlacement";
import { slideCaption } from "./gallerySlide";

const SHOWN = 6;

type Samples = { items: GalleryItem[]; total: number };
// One request per place while Lifer runs, however often the pointer comes back to it.
const samples = new Map<string, Promise<Samples>>();

/** The best photos at a place, as the side panel sorts them (rating, then newest). */
export function hoverSamples(query: URLSearchParams): Promise<Samples> {
  const p = new URLSearchParams(query);
  p.set("sort", "ratingHigh");
  p.set("limit", String(SHOWN));
  const key = p.toString();
  let found = samples.get(key);
  if (!found) {
    found = api.get(apiPath("/gallery", {}, p)).then((res) => ({
      items: res.items,
      total: res.total ?? res.items.length,
    }));
    found.catch(() => samples.delete(key));
    samples.set(key, found);
  }
  return found;
}

/** What a map mark holds, beside it: its best photos as buttons that open the viewer, and Show
 *  all for the side panel. The pointer can move into it; it closes once the pointer leaves both. */
export default function MapHoverCard({
  x,
  y,
  avoid,
  title,
  line,
  query,
  photoIds,
  onOpen,
  onShowAll,
  within,
  obstacles,
  onPointerEnter,
  onPointerLeave,
}: {
  x: number;
  y: number;
  /** The mark's radius, which the card keeps clear of. */
  avoid: number;
  title: string;
  line: string;
  /** The Gallery query for the mark's photos; null for a mark with none to show (an area). */
  query: URLSearchParams | null;
  /** Shown at once from the map's own data, until the request answers. */
  photoIds: string[];
  onOpen: (items: GalleryItem[], index: number) => void;
  onShowAll?: () => void;
  /** The map's box and its controls, which the card keeps inside and clear of. */
  within?: Box;
  obstacles?: Box[];
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [loaded, setLoaded] = useState<{ key: string; samples: Samples } | null>(null);
  const key = query?.toString() ?? "";
  useEffect(() => {
    if (!query) return;
    let live = true;
    hoverSamples(query)
      .then((s) => live && setLoaded({ key, samples: s }))
      .catch(() => {});
    return () => {
      live = false;
    };
    // The key stands for the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const found = loaded?.key === key ? loaded.samples : null;
  const more = found && found.total > SHOWN ? found.total - (SHOWN - 1) : 0;
  const shown = found ? found.items.slice(0, more ? SHOWN - 1 : SHOWN) : [];

  return (
    <PointCard
      x={x}
      y={y}
      avoid={avoid}
      label={title}
      within={within}
      obstacles={obstacles}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="space-y-1.5" data-testid="map-hover-preview">
        <p className="break-words font-medium">{title}</p>
        {query && (found ? shown.length > 0 : photoIds.length > 0) && (
          <div className="grid w-60 grid-cols-3 gap-1">
            {found
              ? shown.map((item, i) => (
                  <Button
                    key={item.captureId}
                    variant="ghost"
                    size="sm"
                    aria-label={slideCaption(item, speciesName)}
                    tooltip={{ label: slideCaption(item, speciesName) }}
                    onClick={() => onOpen(found.items, i)}
                    className="aspect-square h-auto! overflow-hidden p-0!"
                  >
                    <ProgressiveImg
                      thumbSrc={`/api/photos/${item.photoId}/thumb`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </Button>
                ))
              : photoIds.map((id) => (
                  <ProgressiveImg
                    key={id}
                    thumbSrc={`/api/photos/${id}/thumb`}
                    alt=""
                    className="aspect-square w-full rounded-control object-cover"
                  />
                ))}
            {more > 0 && onShowAll && (
              <Button variant="secondary" size="sm" onClick={onShowAll} className="aspect-square h-auto!">
                {t("gallery.map.card.more", { count: more, formatted: formatNumber(more) })}
              </Button>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-muted">{line}</p>
          {query && onShowAll && (
            <Button variant="link" size="sm" onClick={onShowAll} className="text-link!">
              {t("gallery.map.card.showAll")}
            </Button>
          )}
        </div>
      </div>
    </PointCard>
  );
}
