import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import { formatCoordinates, parseCoordinates } from "../lib/coordinates";
import { errorMessage } from "../lib/errorMessage";
import { ignore } from "../lib/ignore";
import { useAnnounceSuggestionChanges } from "../hooks/useAnnounceSuggestionChanges";
import { useFileUnderPlace, useUndoLocation } from "../hooks/useSavedSpots";
import { useToast } from "../hooks/useToast";
import Button from "./Button";
import Checkbox from "./Checkbox";
import Modal from "./Modal";
import FarPhotosConfirm from "./FarPhotosConfirm";
import PlacePicker, { type FoundPlace } from "./PlacePicker";
import { AddSpotModal } from "./SavedSpots";
import TextField from "./TextField";
import PlaceNameInput from "./PlaceNameInput";
import RegionBrowser from "./RegionBrowser";
import { Spinner } from "./LoadingScreen";

const PointPickerMap = lazy(() => import("./PointPickerMap"));

const REASON_KEY = {
  empty: "coordinates.reason.empty",
  unreadable: "coordinates.reason.unreadable",
  latRange: "coordinates.reason.latRange",
  lonRange: "coordinates.reason.lonRange",
  hemisphere: "coordinates.reason.hemisphere",
} as const;

// Typed or pasted coordinates for one photo or a selection. No map: the text field takes what
// Google Maps, Apple Maps or a GPS log gives. A region is only offered, never set without asking.
export default function CoordinatesModal({
  captureIds,
  lat,
  lon,
  suggestRegion,
  onSaved,
  onUndone,
  onClose,
  place: current,
  scope,
}: {
  captureIds: string[];
  /** The viewer's "Apply to all photos in this burst" checkbox. */
  scope?: ReactNode;
  /** The photo's current point, when there's one photo and it has one. */
  lat?: number | null;
  lon?: number | null;
  /** None of the photos has a region, so one may be offered from the point. */
  suggestRegion: boolean;
  /** `region` is set when the user also chose the suggested region. */
  onSaved: (point: { lat: number; lon: number } | null, region: { id: string; name: string } | null) => void;
  /** Runs after the saved toast's Undo (the shared location history) to reload the page. Without
   *  it, Undo hands the photo's earlier point back through onSaved (the viewer's own copy). */
  onUndone?: () => void;
  onClose: () => void;
  /** One photo's place name and region, so they can be edited here too. */
  place?: { label: string | null; regionId: string | null };
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const announceSuggestionChanges = useAnnounceSuggestionChanges();
  const hasPoint = lat != null && lon != null;
  const [text, setText] = useState(hasPoint ? formatCoordinates(lat, lon) : "");
  const [saving, setSaving] = useState(false);
  const [spotName, setSpotName] = useState("");
  // The new place's town or area: an online result's, or typed.
  const [spotLocality, setSpotLocality] = useState("");
  const [mapOpen, setMapOpen] = useState(false);
  // The new place dialog, with the name typed in the list (or none).
  const [addingPlace, setAddingPlace] = useState<string | null>(null);
  // A place picked from the list: saving files the photos under it, while the text still shows its centre.
  const [chosen, setChosen] = useState<ChosenPlace | null>(null);
  const afterUndo = onUndone ?? (() => onSaved(hasPoint ? { lat: lat!, lon: lon! } : null, null));
  const filing = useFileUnderPlace(afterUndo);
  const undo = useUndoLocation(afterUndo);
  const parsed = parseCoordinates(text);
  const point = parsed.ok ? parsed : null;
  const pointKey = point ? `${point.lat},${point.lon}` : null;
  const place = chosen && text === formatCoordinates(chosen.lat, chosen.lon) ? chosen : null;
  // Both keyed on the point, so a new point drops the old suggestion and its tick.
  const [found, setFound] = useState<{ key: string; region: { id: string; name: string } | null } | null>(null);
  const region = found && found.key === pointKey ? found.region : null;
  const [regionChosenFor, setRegionChosenFor] = useState<string | null>(null);
  const useRegion = !!pointKey && regionChosenFor === pointKey;
  const [nameOpen, setNameOpen] = useState(false);
  const [label, setLabel] = useState(current?.label ?? "");
  const [placeRegionId, setPlaceRegionId] = useState(current?.regionId ?? null);
  // Sent only when changed, so a save never overwrites the place name by accident.
  const nameChanged =
    !!current && (label.trim() !== (current.label ?? "") || placeRegionId !== (current.regionId ?? null));

  useEffect(() => {
    if (!suggestRegion || !pointKey) return;
    const [qLat, qLon] = pointKey.split(",").map(Number);
    const controller = new AbortController();
    // Debounced, so typing doesn't ask for every keystroke.
    const timer = setTimeout(() => {
      api
        .get(apiPath("/regions/at", {}, { lat: qLat, lon: qLon }), { signal: controller.signal })
        .then((res) => setFound({ key: pointKey, region: res.region }))
        .catch(ignore("Couldn't look up the region at these coordinates"));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pointKey, suggestRegion]);

  function pickPlace(next: ChosenPlace | null, at: { lat: number; lon: number }) {
    setChosen(next);
    filing.dismiss();
    setText(formatCoordinates(at.lat, at.lon));
  }

  function pick(p: FoundPlace) {
    if (p.kind === "online") {
      // Not one of the user's places yet: fills the point and offers it as a new place.
      setSpotName(p.name.slice(0, 500));
      setSpotLocality(p.region?.slice(0, 300) ?? "");
      return pickPlace(null, p);
    }
    pickPlace(p.kind === "spot" ? { ...p, regionName: p.detail } : null, p);
  }

  // The place's rules: a photo's own GPS stays, a photo without a point takes the centre.
  async function fileUnder(spot: ChosenPlace, moveFar?: boolean) {
    setSaving(true);
    try {
      const filed =
        moveFar === undefined ? await filing.file(spot.id, captureIds) : (await filing.confirm(moveFar), true);
      if (!filed) return;
      announceSuggestionChanges();
      const kept = hasPoint && captureIds.length === 1;
      onSaved(
        kept ? { lat: lat!, lon: lon! } : { lat: spot.lat, lon: spot.lon },
        spot.regionId ? { id: spot.regionId, name: spot.regionName ?? "" } : null,
      );
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, t("coordinates.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  /** `keepPoint`: only the place name and region change. */
  async function save(next: { lat: number; lon: number } | null, keepPoint = false) {
    if (next && place) return fileUnder(place);
    setSaving(true);
    try {
      const chosen = next && useRegion && !nameChanged ? region : null;
      const regionId = nameChanged ? placeRegionId : (chosen?.id ?? null);
      // One call, so one Undo puts back the point, the name and the region together.
      await api.post("/captures/coordinates", {
        captureIds,
        lat: keepPoint ? null : (next?.lat ?? null),
        lon: keepPoint ? null : (next?.lon ?? null),
        ...(keepPoint ? { keepPoint: true } : {}),
        ...(nameChanged ? { locationLabel: label.trim() || null } : {}),
        ...(regionId ? { regionId } : {}),
      });
      // A region taken off isn't part of the undo history.
      if (nameChanged && !placeRegionId && current?.regionId)
        await api.post("/captures/location", { captureIds, regionId: null });
      if (regionId) announceSuggestionChanges();
      onSaved(keepPoint ? (hasPoint ? { lat: lat!, lon: lon! } : null) : next, chosen);
      if (next && spotName.trim()) {
        const locality = spotLocality.trim();
        await api
          .post("/saved-spots", {
            name: spotName.trim(),
            lat: next.lat,
            lon: next.lon,
            ...(chosen ? { regionId: chosen.id } : {}),
            ...(locality ? { locality } : {}),
          })
          .catch((err) => toast.error(errorMessage(err, t("savedSpots.saveFailed"))));
      }
      const message = keepPoint
        ? t("coordinates.placeSaved")
        : next
          ? t("coordinates.saved", { count: captureIds.length })
          : t("coordinates.cleared");
      toast.show(message, {
        tone: "success",
        actions: [{ label: t("savedSpots.undo"), onClick: () => void undo() }],
      });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, t("coordinates.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (point) void save(point);
    else if (nameChanged) void save(null, true);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        captureIds.length > 1
          ? t("coordinates.titleMany", { count: captureIds.length })
          : hasPoint
            ? t("coordinates.titleEdit")
            : t("coordinates.titleAdd")
      }
      footerStart={
        hasPoint && (
          <Button variant="secondary" disabled={saving} onClick={() => void save(null)}>
            {t("coordinates.clear")}
          </Button>
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="coordinates-form" disabled={!point && !nameChanged} loading={saving}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="coordinates-form" onSubmit={submit} className="space-y-3 text-callout">
        {scope}
        <PlacePicker
          placeholder={t("coordinates.searchPlaces")}
          near={point ?? (hasPoint ? { lat: lat!, lon: lon! } : null)}
          regionLabel={(p) => t("coordinates.regionCentre", { name: p.name })}
          onPick={pick}
          onNewPlace={(name) => setAddingPlace(name ?? "")}
        />
        {place && <p className="text-footnote text-muted">{t("coordinates.filingUnder", { name: place.name })}</p>}
        {filing.far && place && (
          <FarPhotosConfirm
            far={filing.far}
            busy={saving}
            onFile={(move) => void fileUnder(place, move)}
            onCancel={filing.dismiss}
          />
        )}
        <Button variant="link" size="sm" onClick={() => setMapOpen((open) => !open)} aria-expanded={mapOpen}>
          {mapOpen ? t("coordinates.hideMap") : t("coordinates.pickOnMap")}
        </Button>
        {mapOpen && (
          <Suspense fallback={<Spinner />}>
            <PointPickerMap point={point} onPick={(la, lo) => setText(formatCoordinates(la, lo))} />
          </Suspense>
        )}
        <label htmlFor="coordinates-input" className="block text-muted">
          {t("coordinates.label")}
        </label>
        <TextField
          id="coordinates-input"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("coordinates.placeholder")}
          aria-invalid={!point && text.trim() !== ""}
          aria-describedby="coordinates-status"
          spellCheck={false}
          autoComplete="off"
        />
        <p
          id="coordinates-status"
          aria-live="polite"
          className={`text-footnote ${point || !text.trim() ? "text-muted" : "text-rose-700 dark:text-rose-400"}`}
        >
          {point
            ? t("coordinates.preview", { point: formatCoordinates(point.lat, point.lon) })
            : !parsed.ok && parsed.reason !== "empty"
              ? t(REASON_KEY[parsed.reason])
              : t("coordinates.hint")}
        </p>
        {point && region && !place && (
          <Checkbox checked={useRegion} onChange={(on) => setRegionChosenFor(on ? pointKey : null)}>
            {t("coordinates.alsoSetRegion", { region: region.name })}
          </Checkbox>
        )}
        {point && !place && (
          <TextField
            aria-label={t("coordinates.saveSpotLabel")}
            placeholder={t("coordinates.saveSpotPlaceholder")}
            value={spotName}
            maxLength={500}
            onChange={(e) => setSpotName(e.target.value)}
          />
        )}
        {point && !place && spotName.trim() && (
          <label className="block space-y-1 text-muted">
            <span>{t("savedSpots.localityLabel")}</span>
            <TextField
              value={spotLocality}
              maxLength={300}
              placeholder={t("savedSpots.localityPlaceholder")}
              onChange={(e) => setSpotLocality(e.target.value)}
            />
          </label>
        )}
        {current && !place && (
          <Button variant="link" size="sm" onClick={() => setNameOpen((open) => !open)} aria-expanded={nameOpen}>
            {t("coordinates.editName")}
          </Button>
        )}
        {current && !place && nameOpen && (
          <div className="space-y-3">
            <div>
              <label htmlFor="coordinates-place-name" className="mb-1 block text-muted">
                {t("captureEdit.location.placeName")}
              </label>
              <PlaceNameInput id="coordinates-place-name" value={label} onChange={setLabel} regionId={placeRegionId} />
            </div>
            <div>
              <p className="mb-1 text-muted">{t("captureEdit.location.region")}</p>
              <RegionBrowser
                regionId={placeRegionId}
                onChange={setPlaceRegionId}
                allowAnyRegion
                suggestedRegionIds={[current.regionId]}
              />
            </div>
          </div>
        )}
      </form>
      {addingPlace !== null && (
        <AddSpotModal
          initialPoint={point ?? (hasPoint ? { lat: lat!, lon: lon! } : null)}
          initialName={addingPlace}
          onClose={() => setAddingPlace(null)}
          onAdded={(spot) => pickPlace(spot, spot)}
        />
      )}
    </Modal>
  );
}

interface ChosenPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  regionId: string | null;
  regionName: string | null;
}
