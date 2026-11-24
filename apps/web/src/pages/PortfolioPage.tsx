import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { api, apiPath, type ApiResponse } from "../api/client";
import Button from "../components/Button";
import Checkbox from "../components/Checkbox";
import { FolderBrowser } from "../components/FolderPicker";
import FormMessage from "../components/FormMessage";
import JobProgress from "../components/JobProgress";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import SearchInput from "../components/SearchInput";
import SegmentedControl from "../components/SegmentedControl";
import SpeciesPicker from "../components/SpeciesPicker";
import Switch from "../components/Switch";
import TextField from "../components/TextField";
import { Spinner } from "../components/LoadingScreen";
import { useConfirm } from "../hooks/useConfirm";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useJobPoll } from "../hooks/useJobPoll";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { userMessage } from "../lib/userMessage";
import EmptyState from "../components/EmptyState";
import { ignore } from "../lib/ignore";
import { pickFolderNative } from "../lib/pickFolderNative";
import { useSpeciesName } from "../lib/speciesName";

type Spec = ApiResponse<"/portfolio">["spec"];
type ExportStatus = JobStatus<null> & { destination: string | null; copied: number; missing: number };
type Album = { id: string; name: string };
type Chosen = { id: string; commonName: string | null; scientificName: string };

const SAVE_DELAY_MS = 600;
const LAST_FOLDER_KEY = "lifer:portfolioExportFolder";

function lastFolder(): string | undefined {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Builds a static site and public life list from chosen albums, species and the life list: a
// preview at phone and desktop widths, an export folder, and on a server a link anyone can open.
export default function PortfolioPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const speciesName = useSpeciesName();
  const isServer = useDeploymentMode() === "server";
  const [spec, setSpec] = useState<Spec | null>(null);
  const [shared, setShared] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Bumped by Retry to run the first load again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [albumSearch, setAlbumSearch] = useState("");
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [addingSpecies, setAddingSpecies] = useState(false);
  const [preview, setPreview] = useState<{ index: string; lifeList: string | null } | null>(null);
  const [previewPage, setPreviewPage] = useState<"index" | "lifeList">("index");
  const [width, setWidth] = useState<"phone" | "desktop">("phone");
  const [browsing, setBrowsing] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishedHere, setFinishedHere] = useState(false);
  const loaded = useRef(false);
  const job = useJobPoll<ExportStatus>("/portfolio/export/status", { onFinish: () => setFinishedHere(true) });
  const status = job.status;
  const running = !!status?.running;

  useEffect(() => {
    Promise.all([api.get("/portfolio"), api.get("/albums")])
      .then(([saved, list]) => {
        setSpec(saved.spec);
        setShared(saved.shared);
        setAlbums(list.albums.map((a) => ({ id: a.id, name: a.name })));
        // Names for the saved species, a handful at a time.
        void Promise.all(
          saved.spec.speciesIds.slice(0, 200).map((id) =>
            api
              .get(apiPath("/species/{id}", { id }))
              .then((s) => ({ id, commonName: s.commonName ?? null, scientificName: s.scientificName }))
              .catch(() => null),
          ),
        ).then((rows) => setChosen(rows.filter((r): r is Chosen => r !== null)));
      })
      .catch(() => setLoadError(true));
  }, [loadAttempt]);

  // Changes save by themselves, and the preview follows them.
  useEffect(() => {
    if (!spec) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const save = loaded.current ? api.put("/portfolio", spec) : Promise.resolve();
      loaded.current = true;
      save
        .then(() => api.post("/portfolio/preview", spec, { signal: controller.signal }))
        .then(setPreview)
        .catch(ignore("Couldn't save or preview the portfolio"));
    }, SAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [spec]);

  const shownAlbums = useMemo(() => {
    const q = albumSearch.trim().toLowerCase();
    return (albums ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [albums, albumSearch]);

  if (loadError)
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader title={t("portfolio.title")} backLabel={t("nav.settings")} backFallbackTo="/settings" />
        <div className="p-page">
          <EmptyState
            title={t("portfolio.loadFailed")}
            action={{
              label: t("common.retry"),
              onClick: () => {
                setLoadError(false);
                setLoadAttempt((n) => n + 1);
              },
            }}
          />
        </div>
      </div>
    );
  if (!spec) return <Spinner />;

  const current: Spec = spec;
  const update = (patch: Partial<Spec>) => setSpec({ ...current, ...patch });
  const toggleAlbum = (id: string, on: boolean) =>
    update({ albumIds: on ? [...spec.albumIds, id] : spec.albumIds.filter((a) => a !== id) });
  const photoCount = (preview?.index.match(/<figure>/g) ?? []).length;

  async function startExport(destination: string) {
    try {
      localStorage.setItem(LAST_FOLDER_KEY, destination);
    } catch {
      // Storage blocked: the picker just opens at its default next time.
    }
    setBrowsing(false);
    setFinishedHere(false);
    await api.put("/portfolio", current).catch(ignore("Couldn't save the portfolio"));
    await job.start("/portfolio/export", { destination });
  }

  async function chooseFolder() {
    const native = await pickFolderNative(lastFolder());
    if (native === undefined) setBrowsing(true);
    else if (native !== null) await startExport(native);
  }

  async function makeLink() {
    setBusy(true);
    try {
      await api.put("/portfolio", current);
      const { token } = await api.post("/portfolio/share");
      setLink(`${window.location.origin}/api/p/${token}`);
      setShared(true);
    } catch (err) {
      toast.error(errorMessage(err, t("portfolio.share.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function stopSharing() {
    const ok = await confirm({
      title: t("portfolio.share.stopTitle"),
      message: t("portfolio.share.stopMessage"),
      confirmLabel: t("portfolio.share.stop"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.delete("/portfolio/share");
      setShared(false);
      setLink(null);
    } catch (err) {
      toast.error(errorMessage(err, t("portfolio.share.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link ?? "");
      toast.success(t("portfolio.share.copied"));
    } catch {
      toast.error(t("portfolio.share.copyFailed"));
    }
  }

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader title={t("portfolio.title")} backLabel={t("nav.settings")} backFallbackTo="/settings">
        <p className="mt-1 max-w-2xl text-subheadline text-muted">{t("portfolio.description")}</p>
      </PageHeader>
      <main className="space-y-section p-page">
        <div className="grid items-start gap-section lg:grid-cols-2">
          <div className="space-y-section">
            <Panel className="space-y-3">
              <label htmlFor="portfolio-title" className="block text-body text-ink">
                {t("portfolio.name")}
              </label>
              <TextField
                id="portfolio-title"
                value={spec.title}
                maxLength={200}
                placeholder={t("portfolio.namePlaceholder")}
                onChange={(e) => update({ title: e.target.value })}
              />
            </Panel>

            <Panel className="space-y-3">
              <h2 className="text-body text-ink">{t("portfolio.albums.title")}</h2>
              <p className="text-subheadline text-muted">{t("portfolio.albums.help")}</p>
              {albums === null || albums.length === 0 ? (
                <p className="text-callout text-muted">{t("portfolio.albums.none")}</p>
              ) : (
                <>
                  <SearchInput
                    value={albumSearch}
                    onChange={setAlbumSearch}
                    placeholder={t("portfolio.albums.search")}
                    aria-label={t("portfolio.albums.search")}
                  />
                  <div className="max-h-72 space-y-1 overflow-y-auto">
                    {shownAlbums.map((a) => (
                      <Checkbox
                        key={a.id}
                        checked={spec.albumIds.includes(a.id)}
                        onChange={(on) => toggleAlbum(a.id, on)}
                        labelClassName="min-w-0 break-words"
                      >
                        {a.name}
                      </Checkbox>
                    ))}
                    {shownAlbums.length === 0 && (
                      <p className="text-callout text-muted">
                        {t("portfolio.albums.noMatch", { search: albumSearch })}
                      </p>
                    )}
                  </div>
                </>
              )}
            </Panel>

            <Panel className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-body text-ink">{t("portfolio.species.title")}</h2>
                <Button variant="secondary" size="sm" onClick={() => setAddingSpecies(true)}>
                  {t("portfolio.species.add")}
                </Button>
              </div>
              <p className="text-subheadline text-muted">{t("portfolio.species.help")}</p>
              {spec.speciesIds.length > 0 && (
                <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-control border border-line">
                  {spec.speciesIds.map((id) => {
                    const s = chosen.find((c) => c.id === id);
                    return (
                      <li key={id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <span className="min-w-0 break-words text-callout text-ink">
                          {s ? speciesName(s) : t("portfolio.species.unknown")}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => update({ speciesIds: spec.speciesIds.filter((x) => x !== id) })}
                        >
                          {t("portfolio.species.remove")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body text-ink">{t("portfolio.lifeList.title")}</p>
                <p className="text-subheadline text-muted">{t("portfolio.lifeList.help")}</p>
              </div>
              <Switch
                label={t("portfolio.lifeList.title")}
                checked={spec.lifeList}
                onChange={(on) => update({ lifeList: on })}
              />
            </Panel>
          </div>

          <div className="space-y-section">
            <Panel className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-body text-ink">{t("portfolio.preview.title")}</h2>
                <div className="flex flex-wrap gap-2">
                  {spec.lifeList && (
                    <SegmentedControl
                      value={previewPage}
                      onChange={setPreviewPage}
                      options={[
                        { value: "index", label: t("portfolio.preview.photos") },
                        { value: "lifeList", label: t("portfolio.preview.lifeList") },
                      ]}
                    />
                  )}
                  <SegmentedControl
                    value={width}
                    onChange={setWidth}
                    options={[
                      { value: "phone", label: t("portfolio.preview.phone") },
                      { value: "desktop", label: t("portfolio.preview.desktop") },
                    ]}
                  />
                </div>
              </div>
              {preview ? (
                <iframe
                  title={t("portfolio.preview.title")}
                  // The pages carry no script; same-origin only lets their pictures load with the session.
                  sandbox="allow-same-origin"
                  srcDoc={(previewPage === "lifeList" && preview.lifeList) || preview.index}
                  className={`mx-auto h-[32rem] w-full rounded-control border border-line bg-surface ${
                    width === "phone" ? "max-w-sm" : ""
                  }`}
                />
              ) : (
                <Spinner />
              )}
              <p className="text-footnote text-muted">{t("portfolio.preview.note", { count: photoCount })}</p>
            </Panel>

            <Panel className="space-y-3">
              <h2 className="text-body text-ink">{t("portfolio.export.title")}</h2>
              <p className="text-subheadline text-muted">{t("portfolio.export.help")}</p>
              {running ? (
                <JobProgress
                  status={status}
                  phases={{ copying: { label: t("portfolio.export.copying"), progress: "count" } }}
                  detail={t("portfolio.export.progress", { done: status.processed ?? 0, total: status.total ?? 0 })}
                  onCancel={() => job.cancel("/portfolio/export/cancel")}
                  cancelling={job.cancelling}
                />
              ) : (
                <Button onClick={chooseFolder} loading={job.starting}>
                  {t("portfolio.export.action")}
                </Button>
              )}
              {/* A failed run says what went wrong in plain words (disk full, no permission), never the job's own text. */}
              {finishedHere && !running && status && status.error && <FormMessage error={userMessage(status.error)} />}
              {finishedHere && !running && status && !status.error && (
                <p className="text-callout text-ink">
                  {t("portfolio.export.done", { count: status.copied, folder: status.destination ?? "" })}
                </p>
              )}
              <FormMessage error={job.actionError} />
            </Panel>

            {isServer && (
              <Panel className="space-y-3">
                <h2 className="text-body text-ink">{t("portfolio.share.title")}</h2>
                <p className="text-subheadline text-muted">{t("portfolio.share.help")}</p>
                {link && (
                  <div className="space-y-2">
                    <TextField
                      readOnly
                      value={link}
                      aria-label={t("portfolio.share.link")}
                      onFocus={(e) => e.target.select()}
                    />
                    <p className="text-footnote text-muted">{t("portfolio.share.shownOnce")}</p>
                    <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
                      {t("portfolio.share.copy")}
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant={shared ? "secondary" : "primary"} loading={busy} onClick={() => void makeLink()}>
                    {shared ? t("portfolio.share.replace") : t("portfolio.share.create")}
                  </Button>
                  {shared && (
                    <Button variant="secondary" disabled={busy} onClick={() => void stopSharing()}>
                      {t("portfolio.share.stop")}
                    </Button>
                  )}
                </div>
              </Panel>
            )}
          </div>
        </div>
      </main>

      <Modal
        open={addingSpecies}
        onClose={() => setAddingSpecies(false)}
        title={t("portfolio.species.addTitle")}
        footer={
          <Button variant="secondary" onClick={() => setAddingSpecies(false)}>
            {t("common.cancel")}
          </Button>
        }
      >
        <SpeciesPicker
          inline
          autoFocus
          onSelect={(r) => {
            setAddingSpecies(false);
            if (spec.speciesIds.includes(r.id)) return;
            setChosen((prev) => [
              ...prev,
              { id: r.id, commonName: r.common_name ?? null, scientificName: r.scientific_name },
            ]);
            update({ speciesIds: [...spec.speciesIds, r.id] });
          }}
        />
      </Modal>
      <Modal open={browsing} onClose={() => setBrowsing(false)} title={t("portfolio.export.title")}>
        <FolderBrowser
          initialPath={lastFolder()}
          onChoose={(p) => void startExport(p)}
          onCancel={() => setBrowsing(false)}
        />
      </Modal>
    </div>
  );
}
