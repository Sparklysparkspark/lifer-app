import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { api, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import FolderPath from "../../components/FolderPath";
import FormMessage from "../../components/FormMessage";
import Switch from "../../components/Switch";
import MovedPhotosReview from "../../components/MovedPhotosReview";
import {
  MOVED_PHOTOS_CHANGED,
  MOVED_PHOTOS_LOOK_STARTED,
  OPEN_REVIEW,
  useTripFolderActions,
  useUndoRelinks,
  type MovedPhotosStatus,
} from "../../hooks/useMovedPhotos";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { ignore } from "../../lib/ignore";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { SettingRow, SettingsGroup } from "./shared";

type Settings = ApiResponse<"/moved-photos/settings">;
type Batch = ApiResponse<"/moved-photos/batches">["batches"][number];

// Settings > Storage: where Lifer looks for photos the user moved or renamed, a "Look now" button,
// matches to review, and a log of recent relinks with Undo.
export default function MovedPhotosGroup() {
  const { t } = useTranslation();
  const toast = useToast();
  const location = useLocation();
  const undo = useUndoRelinks();
  const tripFolder = useTripFolderActions();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<MovedPhotosStatus | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(
    () => (location.state as Record<string, unknown> | null)?.[OPEN_REVIEW] === true,
  );

  const load = useCallback(() => {
    api.get("/moved-photos/settings").then(setSettings).catch(ignore("Couldn't load moved photo settings"));
    api.get("/moved-photos/status").then(setStatus).catch(ignore("Couldn't load moved photo status"));
    api
      .get("/moved-photos/batches")
      .then((r) => setBatches(r.batches))
      .catch(ignore("Couldn't load moved photos"));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(MOVED_PHOTOS_CHANGED, load);
    return () => window.removeEventListener(MOVED_PHOTOS_CHANGED, load);
  }, [load]);
  // While a look runs, follow it so the button shows it's busy.
  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setTimeout(load, 1000);
    return () => window.clearTimeout(timer);
  }, [status, load]);

  async function change(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      load();
    } catch (err) {
      setError(errorMessage(err, t("movedPhotos.settings.saveFailed")));
    }
  }

  const addPlace = (path: string) => change(() => api.post("/moved-photos/places", { path }));

  async function choose() {
    const native = await pickFolderNative();
    if (native === undefined) setBrowsing(true);
    else if (native !== null) await addPlace(native);
  }

  async function lookNow() {
    setStarting(true);
    try {
      await api.post("/moved-photos/look", { manual: true });
      window.dispatchEvent(new Event(MOVED_PHOTOS_LOOK_STARTED));
      load();
    } catch (err) {
      toast.error(errorMessage(err, t("movedPhotos.failed")));
    } finally {
      setStarting(false);
    }
  }

  if (!settings) return null;
  const running = !!status?.running;
  const reviewCount = status?.reviewCount ?? 0;
  const always = t("movedPhotos.settings.always", { count: settings.tripFolders });
  return (
    <section id="moved-photos">
      <SettingsGroup title={t("movedPhotos.settings.title")}>
        <SettingRow
          label={t("movedPhotos.settings.auto")}
          description={t("movedPhotos.settings.autoDescription")}
          control={
            <Switch
              label={t("movedPhotos.settings.auto")}
              checked={settings.auto}
              onChange={(auto) => void change(() => api.put("/moved-photos/settings", { auto }))}
            />
          }
        />
        <SettingRow
          label={t("movedPhotos.settings.places")}
          description={always}
          control={
            !browsing && (
              <Button size="sm" variant="secondary" onClick={() => void choose()}>
                {t("movedPhotos.settings.add")}
              </Button>
            )
          }
        >
          <FormMessage error={error} />
          {browsing && (
            <FolderBrowser
              onChoose={(p) => {
                setBrowsing(false);
                void addPlace(p);
              }}
              onCancel={() => setBrowsing(false)}
            />
          )}
        </SettingRow>
        {settings.places.map((p) => (
          <SettingRow
            key={p.path}
            label={<FolderPath path={p.path} />}
            description={p.available ? undefined : t("movedPhotos.settings.notFound")}
            control={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void change(() => api.post("/moved-photos/places/remove", { path: p.path }))}
              >
                {t("movedPhotos.settings.remove")}
              </Button>
            }
          />
        ))}
        <SettingRow
          label={t("movedPhotos.settings.look")}
          description={t("movedPhotos.settings.lookDescription")}
          control={
            <Button size="sm" variant="secondary" onClick={() => void lookNow()} loading={starting || running}>
              {t("movedPhotos.settings.lookNow")}
            </Button>
          }
        />
        {reviewCount > 0 && (
          <SettingRow
            label={t("movedPhotos.settings.review")}
            description={t("movedPhotos.settings.reviewCount", { count: reviewCount })}
            control={
              <Button size="sm" variant="secondary" onClick={() => setReviewOpen(true)}>
                {t("movedPhotos.review")}
              </Button>
            }
          />
        )}
        {status?.proposals.map((p) => (
          <SettingRow
            key={p.tripId}
            label={t("movedPhotos.tripFolderMoved", { trip: p.tripName, folder: p.folder })}
            control={
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => void tripFolder.accept(p.tripId)}>
                  {t("movedPhotos.useIt")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void tripFolder.dismiss(p.tripId)}>
                  {t("movedPhotos.notNow")}
                </Button>
              </div>
            }
          />
        ))}
        {batches.length > 0 && (
          <SettingRow label={t("movedPhotos.settings.recent")}>
            <ul className="divide-y divide-line">
              {batches.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-item py-2">
                  <span className="min-w-0 break-words text-callout text-ink">
                    {b.tripName
                      ? t("movedPhotos.settings.batchTrip", {
                          trip: b.tripName,
                          date: formatDate(b.createdAt, "dateTime"),
                        })
                      : t("movedPhotos.settings.batch", {
                          count: b.count,
                          date: formatDate(b.createdAt, "dateTime"),
                        })}
                  </span>
                  {b.undone ? (
                    <span className="shrink-0 text-footnote text-muted">{t("movedPhotos.settings.undoneLabel")}</span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void undo(b.id)}>
                      {t("movedPhotos.undo")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </SettingRow>
        )}
      </SettingsGroup>
      <MovedPhotosReview open={reviewOpen} onClose={() => setReviewOpen(false)} />
    </section>
  );
}
