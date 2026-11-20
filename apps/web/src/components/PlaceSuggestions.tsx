import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../api/client";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { formatNumber } from "../lib/format";
import { ignore } from "../lib/ignore";
import Button from "./Button";
import { AddSpotModal, type SavedSpot } from "./SavedSpots";

type Suggestion = ApiResponse<"/places/suggested">["suggestions"][number];
// A fresh pass runs in the background; ask again until it's done.
const RECHECK_MS = 2000;
const PHOTO_ORIGIN = "photo";

/** The place suggestions, kept fresh. `reloadKey` changes when places or photos changed here. */
export function usePlaceSuggestions(reloadKey: unknown = null) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    api
      .get("/places/suggested", { signal: controller.signal })
      .then((res) => {
        // An older API (or a test double) may not answer with a list.
        setSuggestions(Array.isArray(res.suggestions) ? res.suggestions : []);
        if (res.updating) timer = setTimeout(reload, RECHECK_MS);
      })
      .catch(ignore("Couldn't load suggested places"));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [tick, reloadKey, reload]);
  return { suggestions, reload };
}

// "Name this place?": groups of photos the user returned to that no place covers yet. Naming one
// opens the shared Add a saved spot dialog prefilled; filing the photos stays the user's choice
// (the place's "photos near here" offer). Hidden when there are none.
export default function PlaceSuggestions({
  onAdded,
  reloadKey,
}: {
  onAdded: (spot: SavedSpot) => void;
  reloadKey?: unknown;
}) {
  const { suggestions, reload } = usePlaceSuggestions(reloadKey);
  return <PlaceSuggestionList suggestions={suggestions} reload={reload} onAdded={onAdded} />;
}

/** The list itself, for a page that also needs to know whether there are any. */
export function PlaceSuggestionList({
  suggestions,
  reload,
  onAdded,
}: {
  suggestions: Suggestion[];
  reload: () => void;
  onAdded: (spot: SavedSpot) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [naming, setNaming] = useState<Suggestion | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shown = suggestions.filter((s) => !hidden.has(s.cell));
  if (shown.length === 0 && !naming) return null;

  async function dismiss(s: Suggestion) {
    setHidden((h) => new Set(h).add(s.cell));
    try {
      await api.post("/places/suggested/dismiss", { cell: s.cell });
      toast.show(t("placeSuggestions.dismissed"), {
        tone: "success",
        actions: [
          {
            label: t("savedSpots.undo"),
            onClick: () =>
              void api.post("/places/suggested/restore", { cell: s.cell }).then(() => {
                setHidden((h) => new Set([...h].filter((c) => c !== s.cell)));
                reload();
              }),
          },
        ],
      });
    } catch (err) {
      setHidden((h) => new Set([...h].filter((c) => c !== s.cell)));
      toast.error(errorMessage(err, t("placeSuggestions.dismissFailed")));
    }
  }

  return (
    <section aria-labelledby="place-suggestions-title" className="space-y-2">
      <h3 id="place-suggestions-title" className="text-subheadline font-semibold text-ink">
        {t("placeSuggestions.title")}{" "}
        <span className="font-normal tabular-nums text-muted">{formatNumber(shown.length)}</span>
      </h3>
      <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
        {shown.map((s) => (
          <li key={s.cell} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            {/* Wide enough to read; the buttons drop to their own line in a narrow panel. */}
            <div className="min-w-48 flex-1">
              <p className="break-words text-callout text-ink">
                {s.town
                  ? t("placeSuggestions.nearTown", { town: s.town })
                  : (s.locality ?? t("placeSuggestions.unnamed"))}
              </p>
              <p className="text-footnote text-muted">
                {t("placeSuggestions.photosOnDays", {
                  count: s.count,
                  formatted: formatNumber(s.count),
                  days: s.days,
                })}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={() => void dismiss(s)}>
                {t("placeSuggestions.dismiss")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setNaming(s)}>
                {t("placeSuggestions.name")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {naming && (
        <AddSpotModal
          initialPoint={{ lat: naming.lat, lon: naming.lon }}
          initialName={naming.town ? t("placeSuggestions.nearTown", { town: naming.town }) : ""}
          initialRadius={naming.radiusM}
          origin={PHOTO_ORIGIN}
          onClose={() => setNaming(null)}
          onAdded={(spot) => {
            onAdded(spot);
            reload();
          }}
        />
      )}
    </section>
  );
}
