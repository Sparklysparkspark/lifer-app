import { lazy, Suspense, useState, type FormEvent, type KeyboardEvent } from "react";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useLocationJob, useUndoLocation } from "../hooks/useSavedSpots";
import { useToast } from "../hooks/useToast";
import { formatCoordinates, parseCoordinates } from "../lib/coordinates";
import { errorMessage } from "../lib/errorMessage";
import { formatNumber, formatRelativeTime } from "../lib/format";
import Button from "./Button";
import Checkbox from "./Checkbox";
import FormMessage from "./FormMessage";
import { Spinner } from "./LoadingScreen";
import { ManageList } from "./ManageListPage";
import Modal from "./Modal";
import PlacePicker from "./PlacePicker";
import { placeLine } from "../lib/placeLine";
import Select from "./Select";
import TextField, { TextArea } from "./TextField";

const PointPickerMap = lazy(() => import("./PointPickerMap"));

export type SavedSpot = ApiResponse<"/saved-spots">["spots"][number];
export type Geoprivacy = SavedSpot["geoprivacy"];

const PRIVACY: Geoprivacy[] = ["open", "obscured", "private"];
const PRIVACY_BADGE = {
  open: "savedSpots.privacy.open",
  obscured: "savedSpots.privacy.obscured",
  private: "savedSpots.privacy.private",
} as const;
const PRIVACY_OPTION = {
  open: "savedSpots.privacyOption.open",
  obscured: "savedSpots.privacyOption.obscured",
  private: "savedSpots.privacyOption.private",
} as const;
const LOCALITY_SOURCE = {
  region: "savedSpots.localitySource.region",
  user: "savedSpots.localitySource.user",
  inaturalist: "savedSpots.localitySource.inaturalist",
  gazetteer: "savedSpots.localitySource.gazetteer",
} as const;
/** What counts as inside a place; also sent to iNaturalist as the location's accuracy. */
const RADII = [25, 50, 100, 250, 500, 1000, 2500, 5000];
const DEFAULT_RADIUS = 100;

function useRadiusLabel() {
  const { t } = useTranslation();
  return (m: number) =>
    m < 1000
      ? t("placePicker.metres", { distance: formatNumber(m) })
      : t("placePicker.km", { distance: formatNumber(m / 1000, { maximumFractionDigits: 1 }) });
}

function RadiusSelect({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  const { t } = useTranslation();
  const label = useRadiusLabel();
  // A radius from elsewhere (sync, a suggestion) stays choosable.
  const options = RADII.includes(value) ? RADII : [...RADII, value].sort((a, b) => a - b);
  return (
    <Select
      variant="form"
      label={t("savedSpots.radiusLabel")}
      labelClassName="block space-y-1 text-muted"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {label(m)}
        </option>
      ))}
    </Select>
  );
}

function PrivacySelect({ value, onChange }: { value: Geoprivacy; onChange: (p: Geoprivacy) => void }) {
  const { t } = useTranslation();
  return (
    <Select
      variant="form"
      label={t("savedSpots.privacyLabel")}
      labelClassName="block space-y-1 text-muted"
      value={value}
      onChange={(e) => onChange(e.target.value as Geoprivacy)}
    >
      {PRIVACY.map((p) => (
        <option key={p} value={p}>
          {t(PRIVACY_OPTION[p])}
        </option>
      ))}
    </Select>
  );
}

/** Everything a place holds, edited in its row. Renaming one with photos relabels them too
 *  unless unticked, and Undo puts both back. */
function SpotEditor({
  spot,
  onDone,
  onSaved,
}: {
  spot: SavedSpot;
  onDone: () => void;
  onSaved: (next: SavedSpot, renamedPhotos: { count: number; background: boolean } | null) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(spot.name);
  const [radius, setRadius] = useState(spot.radiusM);
  const [locality, setLocality] = useState(spot.locality ?? "");
  const [notes, setNotes] = useState(spot.notes ?? "");
  const [privacy, setPrivacy] = useState(spot.geoprivacy);
  const [renamePhotos, setRenamePhotos] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renaming = name.trim() !== "" && name.trim() !== spot.name && spot.photoCount > 0;
  const localityChanged = locality.trim() !== (spot.locality ?? "");

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch(apiPath("/saved-spots/{id}", { id: spot.id }), {
        name: name.trim(),
        radiusM: radius,
        geoprivacy: privacy,
        notes: notes.trim() || null,
        ...(localityChanged ? { locality: locality.trim() || null } : {}),
        ...(renaming && renamePhotos ? { renamePhotos: true } : {}),
      });
      onSaved(res, res.relabelled !== undefined ? { count: res.relabelled, background: !!res.background } : null);
      onDone();
    } catch (err) {
      setError(errorMessage(err, t("savedSpots.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (matches(e, "close")) {
      e.stopPropagation();
      onDone();
    }
  };

  return (
    <form
      onSubmit={(e) => void save(e)}
      onKeyDown={onKeyDown}
      aria-label={t("savedSpots.editLabel", { name: spot.name })}
      className="w-full space-y-3 py-2 text-callout"
    >
      <label className="block space-y-1 text-muted">
        <span>{t("savedSpots.nameLabel")}</span>
        <TextField autoFocus value={name} maxLength={500} onChange={(e) => setName(e.target.value)} />
      </label>
      {renaming && (
        <Checkbox checked={renamePhotos} onChange={setRenamePhotos}>
          {t("savedSpots.alsoRename", { count: spot.photoCount, formatted: formatNumber(spot.photoCount) })}
        </Checkbox>
      )}
      <div className="space-y-1 text-muted">
        <label className="block space-y-1">
          <span>{t("savedSpots.localityLabel")}</span>
          <TextField
            value={locality}
            maxLength={300}
            placeholder={t("savedSpots.localityPlaceholder")}
            onChange={(e) => setLocality(e.target.value)}
          />
        </label>
        {spot.localitySource && !localityChanged && (
          <p className="text-footnote">
            {t(LOCALITY_SOURCE[spot.localitySource])}
            {spot.localitySource === "user" && (
              // A cleared locality is worked out again on save.
              <Button variant="link" size="sm" className="ml-2" onClick={() => setLocality("")}>
                {t("savedSpots.workOutAgain")}
              </Button>
            )}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <RadiusSelect value={radius} onChange={setRadius} />
        <PrivacySelect value={privacy} onChange={setPrivacy} />
      </div>
      <div className="space-y-1 text-muted">
        <label className="block space-y-1">
          <span>{t("savedSpots.notesLabel")}</span>
          <TextArea rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <p className="text-footnote">{t("savedSpots.notesHint")}</p>
      </div>
      <FormMessage error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" loading={saving} disabled={!name.trim()}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

// The user's named places on the Places page: edit everything a place holds, file nearby photos
// under one in a single background job (with Undo), or remove it. Removing never changes a photo.
export function SavedSpotsList({
  spots,
  nearby,
  reload,
  label,
}: {
  spots: SavedSpot[];
  nearby: Record<string, number>;
  reload: () => Promise<unknown>;
  label: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useLocationJob(reload);
  const undoLocation = useUndoLocation(reload);

  async function remove(spot: SavedSpot) {
    setError(null);
    try {
      await api.delete(apiPath("/saved-spots/{id}", { id: spot.id }));
      await reload();
    } catch (err) {
      setError(errorMessage(err, t("savedSpots.removeFailed")));
    }
  }

  function saved(before: SavedSpot, next: SavedSpot, renamed: { count: number; background: boolean } | null) {
    void reload();
    if (!renamed) return;
    if (renamed.background) return void job.refresh();
    if (renamed.count === 0) return;
    // Undo puts the photos' labels back and the old name with them, so they stay filed under it.
    const undo = () =>
      void undoLocation().then(() =>
        api.patch(apiPath("/saved-spots/{id}", { id: next.id }), { name: before.name }).then(reload),
      );
    toast.show(t("savedSpots.renamedPhotos", { count: renamed.count, formatted: formatNumber(renamed.count) }), {
      tone: "success",
      actions: [{ label: t("savedSpots.undo"), onClick: undo }],
    });
  }

  return (
    <div className="space-y-2">
      <FormMessage error={error ?? job.actionError} />
      <ManageList
        label={label}
        rows={spots.map((spot) => {
          const near = nearby[spot.id];
          return {
            key: spot.id,
            primary: spot.name,
            secondary: (
              <>
                <span className="block">
                  {spot.locality ?? spot.regionName ?? formatCoordinates(spot.lat, spot.lon)}
                </span>
                {near > 0 && (
                  <span className="block">
                    {t("savedSpots.nearbyNotIn", { count: near, formatted: formatNumber(near) })}
                  </span>
                )}
              </>
            ),
            trailing: (
              <>
                <span className="block">
                  {t("savedSpots.photoCount", { count: spot.photoCount, formatted: formatNumber(spot.photoCount) })}
                </span>
                {spot.geoprivacy !== "open" && <span className="block">{t(PRIVACY_BADGE[spot.geoprivacy])}</span>}
                {spot.lastUsedAt && (
                  <span className="block">
                    {t("savedSpots.lastUsed", { when: formatRelativeTime(spot.lastUsedAt) })}
                  </span>
                )}
              </>
            ),
            menu: [
              { label: t("savedSpots.edit"), onSelect: () => setEditing(spot.id) },
              ...(near
                ? [
                    {
                      label: t("savedSpots.fileNearby", { count: near }),
                      disabled: job.status?.running,
                      onSelect: () => void job.start(`/saved-spots/${spot.id}/apply`, { nearby: true }),
                    },
                  ]
                : []),
              { label: t("savedSpots.remove"), danger: true, onSelect: () => void remove(spot) },
            ],
            editor:
              editing === spot.id ? (
                <SpotEditor
                  spot={spot}
                  onDone={() => setEditing(null)}
                  onSaved={(next, renamed) => saved(spot, next, renamed)}
                />
              ) : undefined,
          };
        })}
      />
    </div>
  );
}

// A new place: a name and a point picked on the map or typed the same way as a photo's coordinates.
export function AddSpotModal({
  onClose,
  onAdded,
  initialPoint = null,
  initialName = "",
  initialLocality = null,
  initialRadius = DEFAULT_RADIUS,
  origin,
}: {
  onClose: () => void;
  onAdded: (spot: SavedSpot) => void;
  initialPoint?: { lat: number; lon: number } | null;
  /** From a place found online: its name and where it is, to save it as the user's own. */
  initialName?: string;
  initialLocality?: string | null;
  /** From a suggested place: the size that covers its photos. */
  initialRadius?: number;
  origin?: "map" | "photo" | "inaturalist";
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName.slice(0, 500));
  const [locality, setLocality] = useState(initialLocality?.slice(0, 300) ?? "");
  // The last town or area picked from the search, to say where the text came from.
  const [picked, setPicked] = useState<{ text: string; online: boolean } | null>(
    initialLocality ? { text: initialLocality.slice(0, 300), online: true } : null,
  );
  const [text, setText] = useState(initialPoint ? formatCoordinates(initialPoint.lat, initialPoint.lon) : "");
  const [privacy, setPrivacy] = useState<Geoprivacy>("open");
  const [radius, setRadius] = useState(initialRadius);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseCoordinates(text);
  const point = parsed.ok ? { lat: parsed.lat, lon: parsed.lon } : null;
  const ready = !!point && name.trim() !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    // A nested form's submit would otherwise also reach a dialog's form underneath.
    e.stopPropagation();
    if (!point) return;
    setSaving(true);
    setError(null);
    try {
      const spot = await api.post("/saved-spots", {
        name: name.trim(),
        lat: point.lat,
        lon: point.lon,
        geoprivacy: privacy,
        radiusM: radius,
        ...(locality.trim() && { locality: locality.trim() }),
        ...(origin && { origin }),
      });
      onAdded(spot);
      onClose();
    } catch (err) {
      setError(errorMessage(err, t("savedSpots.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t("savedSpots.addTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="add-spot-form" disabled={!ready} loading={saving}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="add-spot-form" onSubmit={submit} className="space-y-3 text-callout">
        <TextField
          autoFocus
          aria-label={t("savedSpots.nameLabel")}
          placeholder={t("savedSpots.namePlaceholder")}
          value={name}
          maxLength={500}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="space-y-1 text-muted">
          <label className="block space-y-1">
            <span>{t("savedSpots.localityLabel")}</span>
            {/* A search of towns and areas; free text is fine too. */}
            <PlacePicker
              towns
              value={locality}
              onValueChange={(v) => setLocality(v.slice(0, 300))}
              placeholder={t("savedSpots.localityPlaceholder")}
              aria-label={t("savedSpots.localityLabel")}
              onPick={(p) => {
                const line = placeLine(p).slice(0, 300);
                setLocality(line);
                setPicked({ text: line, online: p.kind === "online" });
                setText(formatCoordinates(p.lat, p.lon));
                if (!name.trim()) setName(p.name.slice(0, 500));
              }}
            />
          </label>
          <p className="text-footnote">
            {!locality.trim()
              ? t("savedSpots.localityAuto")
              : locality === picked?.text
                ? t(picked.online ? "savedSpots.localitySource.online" : "savedSpots.localitySource.townList")
                : t("savedSpots.localitySource.user")}
          </p>
        </div>
        <Suspense fallback={<Spinner />}>
          <PointPickerMap point={point} onPick={(la, lo) => setText(formatCoordinates(la, lo))} />
        </Suspense>
        <TextField
          aria-label={t("coordinates.label")}
          placeholder={t("coordinates.placeholder")}
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!parsed.ok && text.trim() !== ""}
          onChange={(e) => setText(e.target.value)}
        />
        {/* Stacked, so the privacy choice is never cut short. */}
        <RadiusSelect value={radius} onChange={setRadius} />
        <PrivacySelect value={privacy} onChange={setPrivacy} />
        <p className="text-footnote text-muted">{t("savedSpots.privacyHint")}</p>
        <FormMessage error={error} />
      </form>
    </Modal>
  );
}
