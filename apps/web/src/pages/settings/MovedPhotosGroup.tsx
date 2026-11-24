import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { api, type ApiResponse } from "../../api/client";
import Button from "../../components/Button";
import { FolderBrowser } from "../../components/FolderPicker";
import FolderList from "../../components/FolderList";
import FormMessage from "../../components/FormMessage";
import MovedFolderSuggestion from "../../components/MovedFolderSuggestion";
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
import { formatDate, formatList } from "../../lib/format";
import { ignore } from "../../lib/ignore";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { SettingRow, SettingsGroup } from "./shared";

type Settings = ApiResponse<"/moved-photos/settings">;
type Batch = ApiResponse<"/moved-photos/batches">["batches"][number];
type Added = ApiResponse<"/moved-photos/places", "post">;
type Notice = { kind: "covered"; by: string } | { kind: "merge"; path: string; contains: string[] };

// Moved trip folders shown before "Show more"; a reorganized drive can move dozens at once.
const PROPOSALS_SHOWN = 3;

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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showFixed, setShowFixed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [allProposals, setAllProposals] = useState(false);
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

  const removePlace = (path: string) => change(() => api.post("/moved-photos/places/remove", { path }));

  // Inside a folder already searched: nothing to add. Holding folders added before: offer to
  // merge them into it, with Undo.
  async function addPlace(path: string, merge = false) {
    setNotice(null);
    let res: Added | null = null;
    await change(async () => {
      res = await api.post("/moved-photos/places", { path, merge });
    });
    const added = res as Added | null;
    if (!added) return;
    if (added.coveredBy) setNotice({ kind: "covered", by: added.coveredBy });
    else if (!added.added) setNotice({ kind: "merge", path: added.path, contains: added.contains });
    else if (added.contains.length > 0)
      toast.show(t("movedPhotos.settings.merged", { count: added.contains.length }), {
        tone: "success",
        actions: [{ label: t("movedPhotos.undo"), onClick: () => void unmerge(added.path, added.contains) }],
      });
  }

  async function unmerge(path: string, contains: string[]) {
    await change(async () => {
      await api.post("/moved-photos/places/remove", { path });
      // One folder that can't come back (a drive since unplugged) mustn't strand the rest.
      const results = await Promise.allSettled(contains.map((p) => api.post("/moved-photos/places", { path: p })));
      const failed = contains.filter((_, i) => results[i].status === "rejected");
      if (failed.length === 0) return;
      const folders = formatList(failed.map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p));
      const restored = contains.length - failed.length;
      toast.error(
        restored > 0
          ? t("movedPhotos.settings.unmergePartlyFailed", { count: restored, folders })
          : t("movedPhotos.settings.unmergeFailed", { folders }),
      );
    });
  }

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
  const missingFolder = status?.result?.missingFolder;
  const fixed = [settings.library, ...settings.trips, ...settings.watched].map((path) => ({ path }));
  const alsoSearched = formatList(
    [
      t("movedPhotos.settings.libraryFolder"),
      settings.trips.length > 0 ? t("movedPhotos.settings.tripFolders", { count: settings.trips.length }) : "",
      settings.watched.length > 0 ? t("movedPhotos.settings.watchedFolders", { count: settings.watched.length }) : "",
    ].filter(Boolean),
  );
  const proposals = status?.proposals ?? [];
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
          label={t("movedPhotos.settings.placesCount", { count: settings.places.length })}
          description={t("movedPhotos.settings.placesHelp")}
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
          {notice?.kind === "covered" && (
            <p role="status" className="break-words text-callout text-ink">
              {t("movedPhotos.settings.coveredBy", { folder: notice.by })}
            </p>
          )}
          {notice?.kind === "merge" && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-item">
              <p className="min-w-0 text-callout text-ink">
                {t("movedPhotos.settings.mergeOffer", { count: notice.contains.length })}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" onClick={() => setNotice(null)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="primary" autoFocus onClick={() => void addPlace(notice.path, true)}>
                  {t("movedPhotos.settings.merge")}
                </Button>
              </div>
            </div>
          )}
          {settings.places.length > 0 && (
            <FolderList
              label={t("movedPhotos.settings.addedList")}
              folders={settings.places}
              onRemove={(p) => void removePlace(p)}
            />
          )}
          <div className="flex items-center justify-between gap-item">
            <p className="min-w-0 text-subheadline text-muted">
              {t("movedPhotos.settings.alsoSearched", { list: alsoSearched })}
            </p>
            <Button size="sm" variant="ghost" aria-expanded={showFixed} onClick={() => setShowFixed((v) => !v)}>
              {showFixed ? t("movedPhotos.settings.hide") : t("movedPhotos.settings.show")}
            </Button>
          </div>
          {showFixed && <FolderList label={t("movedPhotos.settings.fixedList")} folders={fixed} />}
        </SettingRow>
        {missingFolder && <SettingRow label={<MovedFolderSuggestion folder={missingFolder} />} />}
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
        {(allProposals ? proposals : proposals.slice(0, PROPOSALS_SHOWN)).map((p) => (
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
        {!allProposals && proposals.length > PROPOSALS_SHOWN && (
          <SettingRow
            label={
              <Button variant="link" size="sm" onClick={() => setAllProposals(true)}>
                {t("manageList.showMore", { count: proposals.length - PROPOSALS_SHOWN })}
              </Button>
            }
          />
        )}
        {batches.length > 0 && (
          <SettingRow label={t("movedPhotos.settings.recent")}>
            <ul className="max-h-72 divide-y divide-line overflow-y-auto">
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
