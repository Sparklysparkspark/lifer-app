import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import { useLatest } from "../../hooks/useLatest";
import { useReassignCapture } from "../../hooks/usePhotoEdits";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { useApiRoute } from "../../lib/resource";
import { useSpeciesName } from "../../lib/speciesName";
import type { GalleryItem } from "../../pages/gallery/types";
import Lightbox from "../Lightbox";
import { librarySlide } from "../../lib/librarySlide";

const PAGE = 60;
// Photos left ahead of the viewer when it loads the next page.
const AHEAD = 5;

export type MarkPhotos = ReturnType<typeof useMarkPhotos>;

/** The photos at a map mark, best rated first (as the hover card samples them), a page at a time
 *  through /gallery, so a 20,000-photo cluster never loads all at once. */
export function useMarkPhotos(params: URLSearchParams) {
  const firstParams = new URLSearchParams(params);
  firstParams.set("sort", "ratingHigh");
  firstParams.set("limit", String(PAGE));
  const first = useApiRoute(apiPath("/gallery", {}, firstParams));
  // Later pages and edits, kept only while they follow the first page they were made on.
  const [more, setMore] = useState<{ after: object | null; items: GalleryItem[]; cursor: string | null }>({
    after: null,
    items: [],
    cursor: null,
  });
  const extra = first.data && more.after === first.data ? more : null;
  const items = first.data ? (extra ? extra.items : first.data.items) : null;
  const cursor = extra ? extra.cursor : (first.data?.nextCursor ?? null);
  const total = first.data ? (first.data.total ?? first.data.items.length) : null;
  const setItems = (update: (prev: GalleryItem[]) => GalleryItem[], next = cursor) =>
    first.data && setMore({ after: first.data, items: update(items ?? []), cursor: next });
  async function loadMore() {
    if (!cursor) return;
    const p = new URLSearchParams(firstParams);
    p.set("cursor", cursor);
    const res = await api.get(apiPath("/gallery", {}, p));
    setItems((prev) => [...prev, ...res.items], res.nextCursor);
  }
  return { items, total, cursor, error: first.error, reload: first.reload, setItems, loadMore };
}

/** The full-size viewer over a mark's photos: the shared Lightbox with its standard menu, paging
 *  on through the mark as it nears the last loaded photo. `onChanged` refreshes the map. */
export function MarkPhotoViewer({
  photos,
  index,
  onIndexChange,
  onClose,
  onChanged,
}: {
  photos: MarkPhotos;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const { items, cursor, total } = photos;
  const changed = useLatest(() => {
    void photos.reload();
    onChanged?.();
  });
  const reassign = useReassignCapture(() => changed.current());
  const actions = useLatest({
    rate: (captureId: string, rating: number | null) => {
      photos.setItems((prev) => prev.map((it) => (it.captureId === captureId ? { ...it, qualityRating: rating } : it)));
      api
        .patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating })
        .catch((err) => toast.error(errorMessage(err, t("gallery.map.rateFailed"))));
    },
    deleted: (captureId: string) => {
      photos.setItems((prev) => prev.filter((it) => it.captureId !== captureId));
      onChanged?.();
    },
  });
  const slides = useMemo(
    () =>
      (items ?? []).map((i) =>
        librarySlide(i, speciesName(i), {
          rate: (id, rating) => actions.current.rate(id, rating),
          reassign: (id, from, to) => void reassign(id, from, to),
          changed: () => changed.current(),
          deleted: (id) => actions.current.deleted(id),
        }),
      ),
    // reassign is rebuilt each render; it only reads the latest `changed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, speciesName, actions, changed],
  );
  const loading = useRef(false);
  // A step past the last loaded photo, shown once its page is in. After the new slides render, so
  // the viewer doesn't take the longer list for a reshuffle and stay on the photo it had.
  const waiting = useRef<number | null>(null);
  useEffect(() => {
    const to = waiting.current;
    if (to === null || to >= slides.length) return;
    waiting.current = null;
    onIndexChange(to);
  }, [slides.length, onIndexChange]);
  // Loads the next page a few photos ahead.
  function go(to: number) {
    if (cursor && to >= slides.length - AHEAD && !loading.current) {
      loading.current = true;
      photos
        .loadMore()
        .catch((err) => toast.error(errorMessage(err, t("gallery.map.loadFailed"))))
        .finally(() => {
          loading.current = false;
        });
    }
    if (to < slides.length) onIndexChange(to);
    else waiting.current = to;
  }
  // An emptied list (its last photo deleted) still renders, so the Lightbox closes itself.
  if (!items) return null;
  return (
    <Lightbox
      slides={slides}
      index={Math.max(0, Math.min(index, slides.length - 1))}
      onIndexChange={go}
      onClose={onClose}
      total={total ?? undefined}
    />
  );
}

/** A mark's photos full size, opened from the hover card on the photo picked there. */
export default function MapPhotoViewer({
  params,
  start,
  onClose,
  onChanged,
}: {
  params: URLSearchParams;
  start: number;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const photos = useMarkPhotos(params);
  const [index, setIndex] = useState(start);
  return (
    <MarkPhotoViewer photos={photos} index={index} onIndexChange={setIndex} onClose={onClose} onChanged={onChanged} />
  );
}
