// Choosing a named place for photos on their way to iNaturalist: inline in the sighting window,
// or as one step before a send (the selection bar, a card, the Gallery). Choosing files the photos
// under the place through the shared location flow (camera GPS kept, far photos asked, Undo in
// the toast); the send then takes the place's point, accuracy and privacy.
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../lib/format";
import { sentPrivacyLine, usePlaceFiling, type ChosenPlace } from "../hooks/usePlaceFiling";
import {
  PlaceStepContext,
  type LooksLike,
  type PlaceStepFn,
  type PlaceStepRequest,
  type PlaceStepResult,
} from "../hooks/usePlaceStep";
import Button from "./Button";
import FormMessage from "./FormMessage";
import Modal from "./Modal";
import PlacePicker, { type FoundPlace, type PickedPlace } from "./PlacePicker";
import { AddSpotModal } from "./SavedSpots";

/** The recognised place offer, then the picker. A place found online, a region or "New place from
 *  the map" opens the new-place dialog, prefilled, and the new place is what's chosen. */
export function PlaceChooser({
  near,
  looksLike,
  onChoose,
  onRegion,
  autoFocus,
}: {
  near: { lat: number; lon: number } | null;
  looksLike: LooksLike | null;
  onChoose: (place: ChosenPlace) => void;
  /** Given, a region sets just the region instead of starting a new place there. */
  onRegion?: (region: PickedPlace) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<{ name: string; locality: string | null; at: typeof near } | null>(null);
  // The open list leads with the same offer; its space is kept so the field doesn't jump under the list.
  const [listing, setListing] = useState(false);

  function pick(p: FoundPlace) {
    if (p.kind === "spot")
      return onChoose({ id: p.id, name: p.name, locality: p.locality, geoprivacy: p.geoprivacy ?? null });
    if (p.kind === "region" && onRegion) return onRegion(p);
    setAdding({ name: p.name, locality: p.kind === "online" ? p.region : null, at: { lat: p.lat, lon: p.lon } });
  }

  return (
    <div className="space-y-2">
      {looksLike && (
        <div
          aria-hidden={listing}
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-callout ${listing ? "invisible" : ""}`}
        >
          <p className="min-w-0 flex-1 basis-48 break-words text-ink">
            {t("sendPlace.looksLike", { name: looksLike.name })}
          </p>
          <Button variant="secondary" size="sm" onClick={() => onChoose(looksLike)}>
            {t("sendPlace.useIt")}
          </Button>
        </div>
      )}
      <PlacePicker
        placeholder={t("placePicker.placeholder")}
        near={near}
        onPick={pick}
        onNewPlace={(name) => setAdding({ name: name ?? "", locality: null, at: near })}
        onOpenChange={setListing}
        autoFocus={autoFocus && !looksLike}
      />
      {adding && (
        <AddSpotModal
          initialPoint={adding.at}
          initialName={adding.name}
          initialLocality={adding.locality}
          onClose={() => setAdding(null)}
          onAdded={(spot) =>
            onChoose({ id: spot.id, name: spot.name, locality: spot.locality, geoprivacy: spot.geoprivacy })
          }
        />
      )}
    </div>
  );
}

function PlaceStepModal({ request, onDone }: { request: PlaceStepRequest; onDone: (result: PlaceStepResult) => void }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<ChosenPlace | null>(null);
  const filing = usePlaceFiling(() => onDone("placed"));
  const count = request.captureIds.length;
  const n = { count, formatted: formatNumber(count) };
  const privacy = request.send ? sentPrivacyLine(t, chosen?.geoprivacy) : null;
  return (
    <Modal
      open
      onClose={() => onDone(null)}
      title={request.offerWithout ? t("sendPlace.titleWithout", n) : t("sendPlace.title", n)}
      footer={
        <>
          <Button variant="secondary" onClick={() => onDone(null)}>
            {t("common.cancel")}
          </Button>
          {request.offerWithout && (
            <Button variant="secondary" disabled={filing.busy} onClick={() => onDone(WITHOUT)}>
              {t("sendPlace.sendWithout")}
            </Button>
          )}
          <Button
            disabled={!chosen || !!filing.farNode}
            loading={filing.busy && !filing.farNode}
            onClick={() => chosen && void filing.file(chosen, request.captureIds)}
          >
            {request.send ? t("sendPlace.send") : t("sendPlace.setPlace")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-callout">
        <PlaceChooser
          near={request.near}
          looksLike={chosen ? null : request.looksLike}
          onChoose={setChosen}
          autoFocus
        />
        {chosen && (
          <div aria-live="polite">
            <p className="break-words font-medium text-ink">{chosen.name}</p>
            {chosen.locality && <p className="break-words text-footnote text-muted">{chosen.locality}</p>}
            {privacy && <p className="text-footnote text-muted">{privacy}</p>}
          </div>
        )}
        {filing.farNode}
        <FormMessage error={filing.error} />
      </div>
    </Modal>
  );
}

let nextId = 0;
const WITHOUT: PlaceStepResult = "without";

/** Hosts the one place step, for usePlaceStep anywhere in the app (the Gallery's send too). */
export function PlaceStepProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{
    id: number;
    request: PlaceStepRequest;
    resolve: (r: PlaceStepResult) => void;
  } | null>(null);
  const ask = useCallback<PlaceStepFn>(
    (request) =>
      new Promise((resolve) =>
        setCurrent((prev) => {
          // A second request replaces the first, which counts as cancelled.
          prev?.resolve(null);
          return { id: ++nextId, request, resolve };
        }),
      ),
    [],
  );
  return (
    <PlaceStepContext.Provider value={ask}>
      {children}
      {current && (
        <PlaceStepModal
          key={current.id}
          request={current.request}
          onDone={(result) => {
            current.resolve(result);
            setCurrent((c) => (c?.id === current.id ? null : c));
          }}
        />
      )}
    </PlaceStepContext.Provider>
  );
}
